"""작업(Job) 관리: sqlite 저장소, ComfyUI 제출, 웹소켓 메시지로 진행 추적, 미리보기, 취소/재시도, 복구."""
import asyncio
import collections
import copy
import json
import re
import secrets
import sqlite3
import struct
import time
import uuid

from vnlib import characters, config, graphs
from vnlib import pose as poselib

from .comfy_link import ComfyDown, ComfyError, ComfyTimeout
from .common import ApiError, DB_PATH, Throttle, file_url, log, thumb_url, to_bool, to_number, to_text
from .secret import secret_prefix

TERMINAL = ("done", "error", "cancelled")
ACTIVE = ("queued", "running")
SAMPLER_NODES = ("KSampler", "KSamplerAdvanced", "SamplerCustom", "SamplerCustomAdvanced")
COMFY_OFF_MSG = "ComfyUI가 실행 중이 아닙니다. 상단의 [엔진 시작] 버튼으로 먼저 엔진을 켜세요."
COMFY_STARTING_MSG = "ComfyUI가 아직 시작 중입니다. 상단 상태가 '실행 중'이 되면 다시 시도하세요."


# ====================================================================== 저장소
class JobStore:
    """user/studio/jobs.sqlite3 — jobs(작업 기록) + outputs(이미지 경로 → 작업/시드)"""

    def __init__(self, path=DB_PATH):
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            self.db = self._open(path)
        except sqlite3.DatabaseError:
            broken = path.with_name(f"{path.name}.broken-{time.strftime('%Y%m%d-%H%M%S')}")
            log.error("작업 DB가 손상되어 새로 만듭니다 (기존 파일: %s)", broken.name)
            path.rename(broken)
            self.db = self._open(path)

    @staticmethod
    def _open(path):
        db = sqlite3.connect(str(path), isolation_level=None, timeout=10)
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA synchronous=NORMAL")
        db.executescript("""
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY, created REAL NOT NULL, prompt_id TEXT,
                status TEXT NOT NULL, data TEXT NOT NULL, internal TEXT);
            CREATE INDEX IF NOT EXISTS jobs_created ON jobs(created);
            CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
            CREATE TABLE IF NOT EXISTS outputs (
                path TEXT PRIMARY KEY, job_id TEXT NOT NULL, seed INTEGER, preset TEXT);
            CREATE INDEX IF NOT EXISTS outputs_job ON outputs(job_id);
        """)
        db.execute("SELECT count(*) FROM jobs").fetchone()  # 손상 여부 확인
        return db

    def close(self):
        try:
            self.db.close()
        except sqlite3.Error:
            pass

    def save(self, job, internal=None):
        data = json.dumps(job, ensure_ascii=False)
        if internal is None:
            self.db.execute(
                "INSERT INTO jobs(id, created, prompt_id, status, data) VALUES(?,?,?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET status=excluded.status, data=excluded.data, prompt_id=excluded.prompt_id",
                (job["id"], job["created"], job.get("prompt_id"), job["status"], data))
        else:
            self.db.execute(
                "INSERT OR REPLACE INTO jobs(id, created, prompt_id, status, data, internal) VALUES(?,?,?,?,?,?)",
                (job["id"], job["created"], job.get("prompt_id"), job["status"], data,
                 json.dumps(internal, ensure_ascii=False)))

    def get(self, job_id):
        row = self.db.execute("SELECT data FROM jobs WHERE id=?", (job_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def list(self, limit=50, status=None):
        if status:
            rows = self.db.execute("SELECT data FROM jobs WHERE status=? ORDER BY created DESC LIMIT ?",
                                   (status, limit)).fetchall()
        else:
            rows = self.db.execute("SELECT data FROM jobs ORDER BY created DESC LIMIT ?", (limit,)).fetchall()
        out = []
        for (d,) in rows:
            try:
                out.append(json.loads(d))
            except ValueError:
                pass
        return out

    def active_rows(self):
        rows = self.db.execute("SELECT data, internal FROM jobs WHERE status IN ('queued','running')").fetchall()
        out = []
        for d, i in rows:
            try:
                out.append((json.loads(d), json.loads(i) if i else {}))
            except ValueError:
                pass
        return out

    def delete(self, job_id):
        self.db.execute("DELETE FROM jobs WHERE id=?", (job_id,))
        self.db.execute("DELETE FROM outputs WHERE job_id=?", (job_id,))

    def add_outputs(self, job_id, rows):
        self.db.executemany("INSERT OR REPLACE INTO outputs(path, job_id, seed, preset) VALUES(?,?,?,?)",
                            [(p, job_id, s, pr) for p, s, pr in rows])

    def outputs_for(self, paths):
        """{path: (job_id, seed, preset)}"""
        out = {}
        paths = list(paths)
        for i in range(0, len(paths), 500):
            chunk = paths[i:i + 500]
            q = "SELECT path, job_id, seed, preset FROM outputs WHERE path IN (%s)" % ",".join("?" * len(chunk))
            for p, j, s, pr in self.db.execute(q, chunk):
                out[p] = (j, s, pr)
        return out

    def forget_output(self, path):
        self.db.execute("DELETE FROM outputs WHERE path=?", (path,))

    # ---- 시크릿 모드 (studio/secret.py)
    _SECRET_WHERE = "json_extract(data, '$.secret') = 1"

    def secret_job_ids(self):
        return [r[0] for r in self.db.execute(f"SELECT id FROM jobs WHERE {self._SECRET_WHERE}")]

    def secret_prompt_ids(self):
        return [r[0] for r in self.db.execute(f"SELECT prompt_id FROM jobs WHERE {self._SECRET_WHERE}")]

    def purge_secret(self):
        """시크릿 작업 기록과 그 출력 기록을 지우고, 지운 내용이 DB 파일·WAL에 남지 않게 덮어쓴다. → 지운 작업 수"""
        self.db.execute("PRAGMA secure_delete=ON")
        try:
            ids = self.secret_job_ids()
            self.db.execute("BEGIN")
            self.db.execute(f"DELETE FROM outputs WHERE job_id IN (SELECT id FROM jobs WHERE {self._SECRET_WHERE})"
                            " OR substr(path, 1, 8) = '_secret/'")
            self.db.execute(f"DELETE FROM jobs WHERE {self._SECRET_WHERE}")
            self.db.execute("COMMIT")
            self.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            return len(ids)
        finally:
            self.db.execute("PRAGMA secure_delete=OFF")


# ====================================================================== 진행 상태
def node_weight(node):
    """진행률 가중치: 샘플링 노드는 스텝 수만큼, 나머지는 작게 (실제 소요 시간에 가깝게)"""
    ct = node.get("class_type", "")
    inp = node.get("inputs") or {}

    def num(v, d):
        return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else d

    if ct in SAMPLER_NODES:
        return max(1.0, num(inp.get("steps"), 20))
    if ct == "FaceDetailer":
        return max(1.0, num(inp.get("steps"), 14) * 0.8)
    if ct in ("CheckpointLoaderSimple", "CheckpointLoader"):
        return 4.0
    if ct == "ControlNetLoader":  # 2.5GB — 캐시에 없으면 외장 SSD에서 1분 가까이 걸림 (캐시되면 가중치에서 빠짐)
        return 2.0
    if ct in ("ImageUpscaleWithModel", "RemoveBackground"):
        return 3.0
    if ct in ("VAEDecode", "VAEEncode"):
        return 1.5
    return 0.3


CONTROLNET_SLOWDOWN = 1.4  # ControlNet(포즈)을 받는 샘플러는 스텝당 약 40% 느림 (§9.10 실측 3.4 → 4.9 s/it)


def graph_weights(graph):
    """노드별 진행률 가중치 (포즈 ControlNet이 걸린 1차 생성은 더 무겁게)"""
    w = {nid: node_weight(n) for nid, n in graph.items()}
    for nid, n in graph.items():
        if n.get("class_type") in SAMPLER_NODES:
            src = (n.get("inputs") or {}).get("positive")
            if isinstance(src, list) and src and str(graph.get(str(src[0]), {}).get("class_type", "")).startswith(
                    "ControlNetApply"):
                w[nid] *= CONTROLNET_SLOWDOWN
    return w


class JobState:
    """진행 중 작업의 내부 추적 정보"""

    def __init__(self, job, internal):
        self.job = job
        self.id = job["id"]
        self.titles = internal.get("titles") or {}
        self.weights = internal.get("weights") or {}
        self.save_nodes = internal.get("save_nodes") or {}
        self.prefixes = internal.get("prefixes") or []
        self.cached = set()
        self.done = set()
        self.current = None
        self.step = 0
        self.steps = 0
        self.ws_error = None
        self.ws_interrupted = False
        self.ws_outputs = {}
        self.finalizing = False
        self.missing = 0
        self.cancel_requested = False
        self.submitted = time.time()
        self.resumed = False    # studio 재시작으로 실행 도중부터 추적 (정확한 상태를 아직 못 받음)
        self.estimated = False  # 재개 직후 '이전 노드 완료' 근사를 이미 했는지 (한 번만)

    @property
    def prompt_id(self):
        return self.job.get("prompt_id")

    @property
    def status(self):
        return self.job["status"]

    def internal(self):
        return {"titles": self.titles, "weights": self.weights, "save_nodes": self.save_nodes,
                "prefixes": self.prefixes}

    def update_progress(self, stage=None, allow_drop=False):
        keys = set(self.weights)
        cached = self.cached & keys
        todo = keys - cached
        done = (self.done & keys) - cached
        total_w = sum(self.weights[k] for k in todo) or 1.0
        done_w = sum(self.weights[k] for k in done)
        frac = 0.0
        if self.current in todo and self.current not in done and self.steps:
            frac = min(1.0, self.step / self.steps) * self.weights[self.current]
        p = self.job["progress"]
        if stage is not None:
            p["stage"] = stage
        elif self.current is not None:
            p["stage"] = self.titles.get(self.current, p.get("stage") or "")
        p["step"], p["steps"] = int(self.step), int(self.steps)
        p["done_nodes"], p["total_nodes"] = len(done), len(todo)
        pct = round(min(99.5, (done_w + frac) / total_w * 100.0), 1)
        # 얼굴/손 보정은 감지된 영역마다 스텝이 0부터 다시 시작 → 진행률이 뒤로 가지 않게.
        # (재개 작업의 근사값을 progress_state 의 정확한 값으로 바로잡을 때만 내려갈 수 있음)
        p["percent"] = pct if allow_drop else max(pct, float(p.get("percent") or 0.0))


def _new_progress(total, stage="대기 중"):
    return {"stage": stage, "step": 0, "steps": 0, "done_nodes": 0, "total_nodes": total, "percent": 0.0}


# ====================================================================== 입력 정리
def sanitize_spec(body):
    """클라이언트가 보낸 JobSpec을 허용 키만 남기고 형식 검증"""
    mode = body.get("mode")
    if mode not in graphs.MODES:
        raise ApiError(400, f"알 수 없는 작업 종류입니다: {mode!r} ({'/'.join(graphs.MODES)} 중 하나)")
    spec = {"mode": mode}
    for key, label in (("prompt", "프롬프트"), ("negative", "추가 네거티브"), ("name", "파일 이름")):
        if body.get(key) is not None:
            spec[key] = to_text(body[key], label, 20000).strip()
    cid = body.get("character")
    if cid not in (None, ""):
        if not isinstance(cid, str) or not characters.valid_id(cid):
            raise ApiError(400, f"잘못된 캐릭터 ID입니다: {cid!r}")
        spec["character"] = cid
    preset = body.get("preset")
    if preset not in (None, ""):
        if not isinstance(preset, str):
            raise ApiError(400, "프리셋 이름이 올바르지 않습니다")
        spec["preset"] = preset
    if body.get("loras"):
        if not isinstance(body["loras"], list):
            raise ApiError(400, "LoRA 목록 형식이 올바르지 않습니다")
        try:
            loras = config.normalize_loras(body["loras"])
        except (TypeError, ValueError):
            raise ApiError(400, "LoRA 강도는 숫자여야 합니다") from None
        for lo in loras:
            to_number(lo["weight"], f"LoRA 강도({lo['name']})", -3, 3)
        spec["loras"] = loras
    size = body.get("size")
    if size not in (None, ""):
        if isinstance(size, str):
            spec["size"] = size
        elif isinstance(size, (list, tuple)) and len(size) == 2:
            spec["size"] = [to_number(size[0], "가로 크기", 512, 2048, int), to_number(size[1], "세로 크기", 512, 2048, int)]
        elif isinstance(size, dict):
            spec["size"] = [to_number(size.get("width"), "가로 크기", 512, 2048, int),
                            to_number(size.get("height"), "세로 크기", 512, 2048, int)]
        else:
            raise ApiError(400, "크기 형식이 올바르지 않습니다")
    if body.get("count") not in (None, ""):
        spec["count"] = to_number(body["count"], "장수", 1, 32, int)
    seed = body.get("seed")
    spec["seed"] = None if seed in (None, "") else to_number(seed, "시드", 0, 2**32 - 1, int)
    for key, label in (("hires", "하이레즈"), ("face", "얼굴 보정"), ("hands", "손 보정"),
                       ("upscale", "업스케일"), ("raw", "원본 프롬프트")):
        if key in body and body[key] is not None:
            spec[key] = to_bool(body[key], label)
    ex = body.get("expressions")
    if ex is not None:
        if not isinstance(ex, list) or not all(isinstance(x, str) for x in ex):
            raise ApiError(400, "표정 목록은 이름(문자열) 배열이어야 합니다")
        if not ex:  # vnlib는 빈 목록을 '전부'로 해석하므로 명시적으로 막는다
            raise ApiError(400, "만들 표정을 1개 이상 선택하세요")
        spec["expressions"] = ex
    pose = sanitize_pose(body.get("pose"))
    if pose:
        spec["pose"] = pose
    if mode == "pixel" and body.get("pixel") is not None:
        spec["pixel"] = sanitize_pixel(body["pixel"])
    if mode == "icon" and body.get("icon") is not None:
        spec["icon"] = sanitize_icon(body["icon"])
    if mode == "sheet" and body.get("sheet") is not None:
        spec["sheet"] = sanitize_sheet(body["sheet"])
    return spec


def sanitize_sheet(v):
    """JobSpec.sheet → {motions, directions, frames?, mirror?, transparent?, pixel?} (값 확인은 graphs.resolve_sheet)"""
    if not isinstance(v, dict):
        raise ApiError(400, "스프라이트 시트 설정 형식이 올바르지 않습니다")
    out = {}
    for key, label in (("motions", "동작을"), ("directions", "방향을")):
        x = v.get(key)
        if x is not None:
            if not isinstance(x, list) or not x or len(x) > 16 or not all(isinstance(i, str) and len(i) < 20 for i in x):
                raise ApiError(400, f"{label} 1개 이상 고르세요")
            out[key] = x
    if v.get("frames") not in (None, ""):
        out["frames"] = to_number(v["frames"], "프레임 수", 1, 16, int)
    for key, label in (("mirror", "좌우 반전"), ("transparent", "투명 배경")):
        if v.get(key) is not None:
            out[key] = to_bool(v[key], label)
    px = v.get("pixel")
    if px:
        if not isinstance(px, dict):
            raise ApiError(400, "도트 설정 형식이 올바르지 않습니다")
        out["pixel"] = {"width": to_number(px.get("width") or 64, "칸 가로 픽셀", 16, 256, int),
                        "colors": to_number(px.get("colors") or 32, "팔레트 색 수", *graphs.PIXEL_COLORS, int)}
    return out


def _pick(v, allowed, label):
    if v in (None, ""):
        return None
    if v not in allowed:
        raise ApiError(400, f"{label} 값이 올바르지 않습니다: {v!r} (가능: {', '.join(allowed)})")
    return v


def sanitize_pixel(v):
    """JobSpec.pixel → {subject?, width?, colors?, dither?, transparent?} (빈 값은 graphs 기본값)"""
    if not isinstance(v, dict):
        raise ApiError(400, "도트 설정 형식이 올바르지 않습니다")
    out = {"subject": _pick(v.get("subject"), tuple(graphs.PIXEL_SUBJECTS), "도트 대상"),
           "dither": _pick(v.get("dither"), graphs.DITHERS, "디더링")}
    if v.get("width") not in (None, ""):
        out["width"] = to_number(v["width"], "도트 가로 픽셀", *graphs.PIXEL_WIDTH, int)
    if v.get("colors") not in (None, ""):
        out["colors"] = to_number(v["colors"], "팔레트 색 수", *graphs.PIXEL_COLORS, int)
    if v.get("transparent") is not None:
        out["transparent"] = to_bool(v["transparent"], "투명 배경")
    return {k: x for k, x in out.items() if x is not None}


def sanitize_icon(v):
    """JobSpec.icon → {style?, tile?, transparent?, sizes?}"""
    if not isinstance(v, dict):
        raise ApiError(400, "아이콘 설정 형식이 올바르지 않습니다")
    out = {"style": _pick(v.get("style"), tuple(graphs.ICON_STYLES), "아이콘 스타일"),
           "tile": _pick(v.get("tile"), ("auto",) + tuple(graphs.ICON_TILES), "타일 색")}
    if v.get("transparent") is not None:
        out["transparent"] = to_bool(v["transparent"], "투명 배경")
    sizes = v.get("sizes")
    if sizes is not None:
        if not isinstance(sizes, list) or len(sizes) > 8:
            raise ApiError(400, "아이콘 크기 목록은 최대 8개의 숫자 배열이어야 합니다")
        out["sizes"] = [to_number(x, "아이콘 크기", *graphs.ICON_SIZE, int) for x in sizes]
    return {k: x for k, x in out.items() if x is not None}


CONTROLNET_RE = re.compile(r"^[\w][\w .()+-]*(/[\w][\w .()+-]*)*\.(safetensors|pth|pt|bin|ckpt)$")


def sanitize_pose(v):
    """JobSpec.pose → {"name", "strength"?, "end"?, "model"?} | None (파일 존재는 graphs.build 가 확인)"""
    if v in (None, "", {}):
        return None
    if isinstance(v, str):
        v = {"name": v}
    if not isinstance(v, dict):
        raise ApiError(400, "포즈 설정 형식이 올바르지 않습니다 ({\"name\": \"pose_….png\", \"strength\", \"end\", \"model\"})")
    try:
        out = {"name": poselib.normalize_name(v.get("name"))}
    except poselib.PoseError as e:
        raise ApiError(400, str(e)) from None
    if v.get("strength") not in (None, ""):
        out["strength"] = round(to_number(v["strength"], "포즈 강도", *graphs.POSE_STRENGTH), 3)
    if v.get("end") not in (None, ""):
        out["end"] = round(to_number(v["end"], "포즈 적용 구간(끝)", *graphs.POSE_END), 3)
    model = v.get("model")
    if model not in (None, ""):
        if not isinstance(model, str) or len(model) > 200 or ".." in model or not CONTROLNET_RE.match(model):
            raise ApiError(400, f"ControlNet 파일 이름이 올바르지 않습니다: {model!r}")
        out["model"] = model
    return out


def check_models(graph):
    """제출 전에 모델 파일 존재 확인 → 이해하기 쉬운 한국어 오류"""
    missing = []
    for n in graph.values():
        ct, inp = n.get("class_type"), n.get("inputs") or {}
        if ct == "CheckpointLoaderSimple" and not config.find_model("checkpoints", inp.get("ckpt_name", "")):
            missing.append(f"체크포인트 '{inp.get('ckpt_name')}'")
        elif ct == "LoraLoader" and not config.find_model("loras", inp.get("lora_name", "")):
            missing.append(f"LoRA '{inp.get('lora_name')}'")
        elif ct == "UpscaleModelLoader" and not config.find_model("upscale_models", inp.get("model_name", "")):
            missing.append(f"업스케일러 '{inp.get('model_name')}'")
        elif ct == "ControlNetLoader" and not config.find_model("controlnet", inp.get("control_net_name", "")):
            missing.append(f"ControlNet '{inp.get('control_net_name')}'")
    if missing:
        hint = " — '모델·LoRA' 탭에서 프리셋/LoRA 설정을 확인하세요."
        if any(m.startswith("ControlNet") for m in missing):
            names = [c["name"] for c in poselib.list_controlnets()]
            hint = (" — 포즈(ControlNet) 모델을 models/controlnet/ 에 넣거나 다른 ControlNet을 고르세요 "
                    f"(설치된 파일: {', '.join(names) or '없음'}). 도움말 › 포즈 따라 그리기 참고.")
        raise ApiError(400, "모델 파일을 찾을 수 없습니다: " + ", ".join(dict.fromkeys(missing)) + hint)


def _hint(text):
    t = (text or "").lower()
    if "out of memory" in t or "mps backend out of memory" in t or "insufficient memory" in t:
        return " → 메모리가 부족합니다. 다른 프로그램을 닫거나, 크기·장수를 줄이거나, 하이레즈를 끄고 다시 시도하세요."
    if "not in list" in t or "value_not_in_list" in t:
        return " → 지정한 모델/LoRA 파일을 ComfyUI가 찾지 못했습니다. 파일을 추가했다면 엔진을 재시작하세요."
    if "does not exist" in t and "node" in t:
        return " → 필요한 커스텀 노드가 설치되어 있지 않습니다."
    if ("no such file" in t or "filenotfounderror" in t) and "/poses/" in t.replace("\\", "/"):
        return " → 포즈 파일이 삭제되었거나 옮겨졌습니다. 포즈를 다시 고르거나 포즈 없이 다시 생성하세요."
    return ""


def format_rejection(data, titles):
    """/prompt 400 응답 → 한국어 메시지"""
    parts = []
    if isinstance(data, dict):
        err = data.get("error")
        if isinstance(err, dict):
            msg = err.get("message") or ""
            det = err.get("details") or ""
            if msg and not data.get("node_errors"):
                parts.append(f"{msg} {det}".strip())
        elif isinstance(err, str):
            parts.append(err)
        for nid, ne in (data.get("node_errors") or {}).items():
            title = titles.get(nid) or (ne or {}).get("class_type") or nid
            for e in (ne or {}).get("errors", []):
                det = str(e.get("details") or "")
                if len(det) > 300:
                    det = det[:300] + "…"
                parts.append(f"[{title}] {e.get('message', '')} {det}".strip())
        if not parts and data.get("_text"):
            parts.append(str(data["_text"])[:500])
    text = "; ".join(parts) or "알 수 없는 오류"
    return f"ComfyUI가 작업을 거부했습니다: {text}{_hint(text)}"[:3000]


def format_exec_error(m, titles):
    m = m or {}
    if not m:
        return "알 수 없는 원인으로 작업이 실패했습니다. 'ComfyUI 로그'에서 원인을 확인하세요."
    nid = str(m.get("node_id") or "")
    title = titles.get(nid) or m.get("node_type") or "알 수 없음"
    msg = (m.get("exception_message") or "").strip()
    etype = m.get("exception_type") or ""
    text = f"'{title}' 단계에서 오류가 발생했습니다: {msg or etype or '원인 불명'}"
    if etype and msg:
        text += f" ({etype.split('.')[-1]})"
    return (text + _hint(msg + " " + etype))[:3000]


# ====================================================================== 관리자
class JobManager:
    def __init__(self, hub, comfy, store=None):
        self.hub = hub
        self.comfy = comfy
        self.store = store or JobStore()
        self.active = {}            # job_id → JobState
        self.by_pid = {}            # prompt_id → JobState
        self.current_pid = None     # ComfyUI에서 지금 실행 중인 prompt
        self.previews = collections.OrderedDict()  # job_id → (bytes, content_type, t)
        self.recent = collections.OrderedDict()    # 막 끝난 작업 (스로틀 전송용)
        self.job_throttle = Throttle(0.25, self._send_job)       # job당 최대 4Hz
        self.preview_throttle = Throttle(0.5, self._send_preview)  # 최대 2Hz
        self._tasks = set()
        self.secret = None          # studio/secret.py 의 Secret (켜져 있으면 새 작업을 시크릿으로)
        comfy.on_json = self.on_message
        comfy.on_binary = self.on_binary
        comfy.on_connect = self.on_ws_connect

    # ---------------------------------------------------------------- 조회
    def public(self, job):
        j = dict(job)
        j["has_preview"] = job["id"] in self.previews
        return j

    def get(self, job_id):
        st = self.active.get(job_id)
        if st:
            return self.public(st.job)
        job = self.store.get(job_id)
        if not job:
            raise ApiError(404, "작업을 찾을 수 없습니다")
        return self.public(job)

    def list(self, limit=50, status=None):
        jobs = self.store.list(limit, status)
        out = []
        for j in jobs:
            st = self.active.get(j["id"])
            out.append(self.public(st.job if st else j))
        return out

    def active_jobs(self):
        return [self.public(st.job) for st in self.active.values()]

    def running_summary(self):
        for st in self.active.values():
            if st.status == "running":
                return {"id": st.id, "summary": st.job.get("summary"), **st.job["progress"]}
        return None

    def preview(self, job_id):
        p = self.previews.get(job_id)
        if not p:
            raise ApiError(404, "아직 미리보기가 없습니다")
        return p

    # ---------------------------------------------------------------- 이벤트 전송
    def _send_job(self, job_id):
        st = self.active.get(job_id)
        job = st.job if st else self.recent.get(job_id)
        if job:
            self.hub.publish("job", self.public(job))

    def _send_preview(self, job_id):
        p = self.previews.get(job_id)
        if p:
            self.hub.publish("preview", {"job_id": job_id, "t": p[2]})

    def emit(self, st, force=False):
        self.job_throttle.fire(st.id, force=force)

    def _spawn(self, coro):
        t = asyncio.create_task(coro)
        self._tasks.add(t)
        t.add_done_callback(self._tasks.discard)
        return t

    # ---------------------------------------------------------------- 제출
    async def submit(self, body):
        spec = sanitize_spec(body)
        try:
            built = graphs.build(copy.deepcopy(spec))
        except (graphs.JobError, characters.CharacterError) as e:
            raise ApiError(400, str(e)) from None
        except config.ConfigError as e:
            raise ApiError(500, str(e)) from None
        except (ValueError, TypeError, KeyError) as e:
            raise ApiError(400, f"작업 설정이 올바르지 않습니다: {e}") from None
        graph = built["graph"]
        check_models(graph)
        secret_on = bool(self.secret and self.secret.enabled)
        if secret_on:  # 시크릿 모드: 그림을 output/_secret/ 아래에 저장 (끄거나 종료하면 통째로 지움)
            for n in graph.values():
                if n.get("class_type") == "SaveImage":
                    n["inputs"]["filename_prefix"] = secret_prefix(n["inputs"]["filename_prefix"])
            built["prefixes"] = [secret_prefix(p) for p in built["prefixes"]]

        now = time.time()
        job_id = time.strftime("j_%Y%m%d_%H%M%S_", time.localtime(now)) + secrets.token_hex(2)
        # 같은 설정을 다시 걸어도 저장 노드는 꼭 새로 실행되게 (ComfyUI 캐시가 이전 파일 이름만 돌려주는 것 방지).
        # 선언되지 않은 입력이라 노드에는 전달되지 않고 캐시 키에만 반영된다. 앞단 결과는 그대로 캐시 재사용.
        for n in graph.values():
            if n.get("class_type") == "SaveImage":
                n.setdefault("inputs", {})["studio_job"] = job_id
        prompt_id = str(uuid.uuid4())   # 미리 정해서 넘기면 실행 시작 메시지를 놓치지 않는다
        internal = {
            "titles": built["titles"],
            "weights": graph_weights(graph),
            "save_nodes": {nid: n["inputs"].get("filename_prefix") for nid, n in graph.items()
                           if n.get("class_type") == "SaveImage"},
            "prefixes": built["prefixes"],
        }
        job = {
            "id": job_id, "created": now, "spec": spec, "summary": built["summary"],
            "preset": built["preset"], "seeds": built["seeds"], "prompt_id": prompt_id,
            "status": "queued", "progress": _new_progress(len(graph)), "started": None, "finished": None,
            "outputs": [], "error": None, "has_preview": False, "queue_position": None,
            # 실제 적용한 포즈 {name, image, model, strength, end, size} | None (spec.pose 의 빈 값을 설정값으로 채운 것)
            "pose": built.get("pose"),
        }
        if secret_on:
            job["secret"] = True
        st = JobState(job, internal)
        self.active[job_id] = st
        self.by_pid[prompt_id] = st
        body = {"prompt": graph, "client_id": self.comfy.client_id, "prompt_id": prompt_id,
                "extra_data": {"preview_method": "auto"}}  # 엔진 실행 옵션과 무관하게 실시간 미리보기
        try:
            status, data = await self.comfy.post_json("/prompt", body, timeout=30)
        except ComfyDown:
            self._drop(st)
            raise ApiError(503, COMFY_STARTING_MSG if self.comfy.starting else COMFY_OFF_MSG) from None
        except ComfyTimeout:
            # 응답만 늦었을 뿐 접수됐을 수 있다 → prompt_id를 알고 있으므로 계속 추적한다.
            # (대기열에 없으면 reconcile 이 곧 '기록을 찾을 수 없음' 오류로 정리)
            log.warning("ComfyUI /prompt 응답 지연 — 작업 %s 를 계속 추적합니다", job_id)
            status, data = 200, {"prompt_id": prompt_id}
        if status != 200:
            self._drop(st)
            raise ApiError(400 if status in (400, 422) else 502, format_rejection(data, built["titles"]))
        real = (data or {}).get("prompt_id")
        if real and real != prompt_id:  # 구버전 ComfyUI: 서버가 정한 ID 사용
            self.by_pid.pop(prompt_id, None)
            job["prompt_id"] = real
            self.by_pid[real] = st
        self.store.save(job, st.internal())
        log.info("작업 제출 %s (%s) prompt=%s", job_id, "시크릿" if secret_on else built["summary"], job["prompt_id"])
        self.emit(st, force=True)
        self.comfy.wake()
        return self.public(job)

    def _drop(self, st):
        self.active.pop(st.id, None)
        self.by_pid.pop(st.prompt_id, None)

    # ---------------------------------------------------------------- 종료 처리
    def _finish(self, st, status, error=None, outputs=None):
        if st.status in TERMINAL:
            return
        job = st.job
        job["status"] = status
        job["finished"] = time.time()
        job["error"] = error
        job["queue_position"] = None
        if outputs is not None:
            job["outputs"] = outputs
        p = job["progress"]
        if status == "done":
            p.update(stage="완료", percent=100.0, step=p.get("steps", 0))
            p["done_nodes"] = p.get("total_nodes", 0)
        else:
            p["stage"] = "취소됨" if status == "cancelled" else "오류"
        self._drop(st)
        self.recent[st.id] = job
        while len(self.recent) > 30:
            self.recent.popitem(last=False)
        try:
            self.store.save(job)
        except sqlite3.Error:
            log.exception("작업 저장 실패")
        self.emit(st, force=True)
        self.job_throttle.forget(st.id)
        self.preview_throttle.forget(st.id)
        log.info("작업 종료 %s: %s%s", st.id, status, f" ({error})" if error and not job.get("secret") else "")
        self.comfy.wake()
        if job.get("secret") and self.secret and not self.secret.enabled:
            self.secret.notify_orphan()

    def _collect_outputs(self, st, outputs_by_node):
        """history outputs → [{path,url,thumb}] + DB(outputs 테이블) 기록"""
        job = st.job
        seeds = job.get("seeds") or []
        rows, out = [], []

        def key(nid):
            return (0, int(nid)) if str(nid).isdigit() else (1, str(nid))

        for nid in sorted(outputs_by_node, key=key):
            node_out = outputs_by_node[nid] or {}
            prefix = st.save_nodes.get(str(nid))
            seed = None
            if seeds:
                if prefix in st.prefixes and len(seeds) == len(st.prefixes):
                    seed = seeds[st.prefixes.index(prefix)]
                else:
                    seed = seeds[0]
            for img in node_out.get("images", []) or []:
                if img.get("type") != "output" or not img.get("filename"):
                    continue
                rel = f"{img.get('subfolder', '')}/{img['filename']}".lstrip("/")
                if rel in (o["path"] for o in out):
                    continue
                out.append({"path": rel, "url": file_url(rel), "thumb": thumb_url(rel)})
                rows.append((rel, seed, job.get("preset")))
        if rows:
            try:
                self.store.add_outputs(st.id, rows)
            except sqlite3.Error:
                log.exception("출력 기록 실패")
        return out

    def _apply_history(self, st, hist):
        status = hist.get("status") or {}
        msgs = status.get("messages") or []
        outputs = self._collect_outputs(st, hist.get("outputs") or {})
        interrupted = any(m and m[0] == "execution_interrupted" for m in msgs)
        err = next((m[1] for m in msgs if m and m[0] == "execution_error" and len(m) > 1), None)
        sstr = status.get("status_str")
        if sstr == "success" or (sstr is None and not err and not interrupted and outputs):
            self._finish(st, "done", outputs=outputs)
        elif interrupted or st.cancel_requested:
            self._finish(st, "cancelled", error=None, outputs=outputs)
        else:
            self._finish(st, "error", error=format_exec_error(err or st.ws_error, st.titles), outputs=outputs)

    async def finalize(self, st, hint=None):
        """완료/오류/중단 확정. history가 단일 진실 공급원이고, 없으면 웹소켓에서 받은 정보로 판단."""
        if st.finalizing or st.status in TERMINAL:
            return
        st.finalizing = True
        try:
            hist = None
            attempts = 8 if hint else 2
            for i in range(attempts):
                try:
                    h = await self.comfy.get_json(f"/history/{st.prompt_id}", timeout=15)
                    if isinstance(h, dict) and st.prompt_id in h:
                        hist = h[st.prompt_id]
                        break
                except ComfyError:
                    pass
                if i < attempts - 1:
                    await asyncio.sleep(0.4 * (i + 1))
            if st.status in TERMINAL:
                return
            if hist is not None:
                self._apply_history(st, hist)
            elif hint == "interrupted" or (st.cancel_requested and hint != "success"):
                self._finish(st, "cancelled")
            elif hint == "error":
                self._finish(st, "error", error=format_exec_error(st.ws_error, st.titles),
                             outputs=self._collect_outputs(st, st.ws_outputs))
            elif hint == "success":
                self._finish(st, "done", outputs=self._collect_outputs(st, st.ws_outputs))
            else:
                st.missing += 1
                if st.missing >= 2:
                    self._finish(st, "error", error="ComfyUI에서 작업 기록을 찾을 수 없습니다 (엔진이 재시작되었을 수 있습니다).")
        finally:
            st.finalizing = False

    # ---------------------------------------------------------------- 웹소켓 메시지
    def _state(self, pid):
        return self.by_pid.get(pid or self.current_pid)

    def _mark_running(self, st):
        if st.status == "queued":
            st.job["status"] = "running"
            st.job["started"] = st.job.get("started") or time.time()
            st.job["queue_position"] = None
            st.update_progress(stage="준비 중")
            try:
                self.store.save(st.job)
            except sqlite3.Error:
                log.exception("작업 저장 실패")
            self.emit(st, force=True)
            return True
        return False

    @staticmethod
    def _resume_estimate(st, node):
        """studio 재시작으로 실행 도중부터 추적하는 작업: 처음 본 노드보다 ID가 작은 노드는 끝난 것으로 한 번만 근사.
        (progress_state 를 받으면 정확한 값으로 바뀐다. 새 작업에는 쓰면 안 됨 — ComfyUI 실행 순서는 노드 ID 순이 아님)"""
        if st.resumed and not st.estimated:
            st.estimated = True
            if node.isdigit():
                st.done.update(k for k in st.weights if k.isdigit() and int(k) < int(node))

    def on_message(self, msg):
        t = msg.get("type")
        d = msg.get("data") or {}
        if not isinstance(d, dict):
            return
        if t == "status":
            self.comfy.wake()
            return
        pid = d.get("prompt_id")
        if t == "execution_start":
            self.current_pid = pid
            st = self.by_pid.get(pid)
            if st:
                st.resumed = False  # 처음부터 실행되는 것을 보고 있으므로 근사 불필요
                self._mark_running(st)
        elif t == "execution_cached":
            st = self._state(pid)
            if st:
                st.cached = set(str(n) for n in d.get("nodes") or [])
                self._mark_running(st)
                st.update_progress()
                self.emit(st)
        elif t == "executing":
            node = d.get("node")
            if node is None:
                st = self.by_pid.get(pid or self.current_pid)
                if not pid or self.current_pid == pid:
                    self.current_pid = None
                if st:
                    self._spawn(self.finalize(st, "success"))
                return
            if pid:
                self.current_pid = pid
            st = self._state(pid)
            if not st:
                return
            node = str(node)
            self._mark_running(st)
            if st.current and st.current != node:
                st.done.add(st.current)
            self._resume_estimate(st, node)
            st.current = node
            st.step = st.steps = 0
            st.update_progress()
            self.emit(st)
        elif t == "progress":
            st = self._state(pid)
            if st:
                node = d.get("node")
                if node is not None and str(node) != st.current:
                    if st.current:
                        st.done.add(st.current)
                    self._resume_estimate(st, str(node))
                    st.current = str(node)
                try:
                    st.step, st.steps = int(d.get("value") or 0), int(d.get("max") or 0)
                except (TypeError, ValueError):
                    pass
                st.update_progress()
                self.emit(st)
        elif t == "progress_state":
            # ComfyUI 0.26+: 노드 시작/진행/끝마다 전체 노드 상태를 보내 준다 → 재개 작업의 완료 노드를 정확히 맞춤
            st = self._state(pid)
            nodes = d.get("nodes")
            if st and st.resumed and isinstance(nodes, dict):
                st.resumed = False
                st.done = {str(k) for k, n in nodes.items() if isinstance(n, dict) and n.get("state") == "finished"}
                st.update_progress(allow_drop=True)
                self.emit(st)
        elif t == "executed":
            st = self._state(pid)
            if st:
                node = str(d.get("node"))
                self._resume_estimate(st, node)
                st.done.add(node)
                out = d.get("output") or {}
                if out.get("images"):
                    st.ws_outputs[node] = {"images": out["images"]}
                st.update_progress()
                self.emit(st)
        elif t == "execution_success":
            st = self.by_pid.get(pid)
            if st:
                self._spawn(self.finalize(st, "success"))
        elif t == "execution_error":
            st = self.by_pid.get(pid)
            if st:
                st.ws_error = d
                self._spawn(self.finalize(st, "error"))
        elif t == "execution_interrupted":
            st = self.by_pid.get(pid)
            if st:
                st.ws_interrupted = True
                self._spawn(self.finalize(st, "interrupted"))

    def on_binary(self, data):
        if len(data) < 8:
            return
        etype = struct.unpack(">I", data[:4])[0]
        pid = None
        if etype == 1:      # PREVIEW_IMAGE: [type][image_type][bytes]
            itype = struct.unpack(">I", data[4:8])[0]
            img, ctype = data[8:], ("image/png" if itype == 2 else "image/jpeg")
        elif etype == 4:    # PREVIEW_IMAGE_WITH_METADATA: [type][meta_len][meta json][bytes]
            mlen = struct.unpack(">I", data[4:8])[0]
            try:
                meta = json.loads(data[8:8 + mlen])
            except ValueError:
                meta = {}
            img = data[8 + mlen:]
            ctype = meta.get("image_type") or "image/jpeg"
            pid = meta.get("prompt_id")
        else:
            return
        st = self._state(pid)
        if not st or not img:
            return
        first = st.id not in self.previews
        self.previews[st.id] = (bytes(img), ctype, round(time.time(), 3))
        self.previews.move_to_end(st.id)
        while len(self.previews) > 24:
            self.previews.popitem(last=False)
        self.preview_throttle.fire(st.id)
        if first:
            self.emit(st)

    async def on_ws_connect(self):
        """재접속 시 놓친 완료가 있는지 확인"""
        await asyncio.sleep(0.5)
        await self.comfy.refresh()
        await self.reconcile()

    # ---------------------------------------------------------------- 주기 점검
    async def reconcile(self):
        """/queue 기준으로 상태 보정: 놓친 메시지, 엔진 재시작/종료로 사라진 작업 처리"""
        if not self.active:
            return
        c = self.comfy
        if not c.running:
            if c.down_count >= 3 and not c.starting and not c.stopping:
                for st in list(self.active.values()):
                    self._finish(st, "error", error="ComfyUI 연결이 끊겨 작업이 중단되었습니다 (엔진이 종료되었을 수 있습니다).")
            return
        if time.time() - c.queue_ok_at > 5:
            return
        running, pending = set(c.queue_running_ids), list(c.queue_pending_ids)
        for st in list(self.active.values()):
            pid = st.prompt_id
            if pid in running:
                if self._mark_running(st):
                    self.current_pid = pid
                continue
            if pid in pending:
                pos = pending.index(pid) + 1 + len(running)
                if st.job.get("queue_position") != pos:
                    st.job["queue_position"] = pos
                    ahead = pos - 1
                    st.job["progress"]["stage"] = f"대기 중 · 앞에 {ahead}개 작업" if ahead else "대기 중 · 곧 시작"
                    self.emit(st)
                continue
            if time.time() - st.submitted < 4 or st.finalizing:
                continue
            self._spawn(self.finalize(st))

    def on_comfy_stopping(self):
        """사용자가 엔진을 중지/재시작 → 진행 중 작업은 취소 처리"""
        for st in list(self.active.values()):
            self._finish(st, "cancelled", error="엔진(ComfyUI)이 중지되어 작업이 취소되었습니다.")

    async def recover(self):
        """studio 재시작 시 queued/running 이던 작업 복구"""
        rows = self.store.active_rows()
        if not rows:
            return
        q = None
        try:
            q = await self.comfy.get_json("/queue", timeout=4)
        except ComfyError:
            pass
        running = {it[1] for it in (q or {}).get("queue_running", []) if len(it) > 1}
        pending = {it[1] for it in (q or {}).get("queue_pending", []) if len(it) > 1}
        for job, internal in rows:
            st = JobState(job, internal)
            st.submitted = 0
            pid = st.prompt_id
            st.resumed = pid in running  # 대기열에만 있던 작업은 나중에 처음부터 실행되므로 근사 대상 아님
            if q is not None and pid in running | pending:
                self.active[st.id] = st
                self.by_pid[pid] = st
                if pid in running:
                    self.current_pid = pid
                    self._mark_running(st)
                log.info("작업 추적 재개: %s", st.id)
                continue
            hist = None
            if q is not None and pid:
                try:
                    h = await self.comfy.get_json(f"/history/{pid}", timeout=10)
                    hist = (h or {}).get(pid)
                except ComfyError:
                    pass
            self.active[st.id] = st
            self.by_pid[pid] = st
            if hist:
                self._apply_history(st, hist)
            else:
                self._finish(st, "error", error="서버 재시작으로 추적 불가")

    # ---------------------------------------------------------------- 사용자 동작
    async def cancel(self, job_id):
        st = self.active.get(job_id)
        if not st:
            return self.get(job_id)   # 이미 끝난 작업 → 그대로 반환 (없으면 404)
        st.cancel_requested = True
        pid = st.prompt_id
        try:
            q = await self.comfy.get_json("/queue", timeout=6)
        except ComfyDown:
            self._finish(st, "cancelled")
            return self.public(st.job)
        except ComfyError:
            raise ApiError(504, "ComfyUI 응답이 없어 취소하지 못했습니다. 잠시 후 다시 시도하세요.") from None
        running = [it[1] for it in (q or {}).get("queue_running", []) if len(it) > 1]
        pending = [it[1] for it in (q or {}).get("queue_pending", []) if len(it) > 1]
        try:
            if pid in running:
                await self.comfy.post_json("/interrupt", {"prompt_id": pid})
                st.job["progress"]["stage"] = "취소하는 중…"
                self.emit(st, force=True)
                self._spawn(self._cancel_watchdog(st))
            elif pid in pending:
                await self.comfy.post_json("/queue", {"delete": [pid]})
                self._finish(st, "cancelled")
            else:
                await self.finalize(st)
                if st.status not in TERMINAL:
                    self._finish(st, "cancelled")
        except ComfyError:
            raise ApiError(502, "ComfyUI에 취소 요청을 보내지 못했습니다.") from None
        return self.public(st.job)

    async def _cancel_watchdog(self, st):
        """중단 메시지를 못 받는 경우 대비"""
        await asyncio.sleep(20)
        if st.status not in TERMINAL:
            await self.finalize(st, "interrupted")

    async def retry(self, job_id):
        job = self.active.get(job_id).job if job_id in self.active else self.store.get(job_id)
        if not job:
            raise ApiError(404, "작업을 찾을 수 없습니다")
        return await self.submit(dict(job.get("spec") or {}))

    def delete(self, job_id):
        if job_id in self.active:
            raise ApiError(409, "대기 중이거나 진행 중인 작업은 삭제할 수 없습니다. 먼저 취소하세요.")
        if not self.store.get(job_id):
            raise ApiError(404, "작업을 찾을 수 없습니다")
        self.store.delete(job_id)
        self.previews.pop(job_id, None)
        self.recent.pop(job_id, None)
        return {"ok": True}

    def purge_secret_records(self):
        """시크릿 작업의 DB 기록·메모리(미리보기, 최근 작업) 삭제 → 지운 작업 수"""
        ids = set(self.store.secret_job_ids())
        ids.update(j for j, job in self.recent.items() if job.get("secret"))
        n = self.store.purge_secret()
        for j in ids:
            self.previews.pop(j, None)
            self.recent.pop(j, None)
            self.job_throttle.forget(j)
            self.preview_throttle.forget(j)
        return n

    async def close(self):
        tasks = list(self._tasks)
        for t in tasks:
            t.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self.store.close()
