"""설정 파일 로드/저장. CLI(vn.py)와 GUI(studio)가 같은 파일을 공유한다.

config/presets.json  모델 프리셋 (체크포인트 + 권장 샘플러/CFG/품질 태그 + 기본 LoRA)
config/loras.json    LoRA별 사용자 메모 (트리거 단어, 기본 강도, 설명)
config/settings.json 전역 설정 (기본 프리셋, 하이레즈/보정 강도, 서버 주소 등)

파일이 없으면 기본값으로 자동 생성한다. 형식이 깨진 파일(JSON 문법 오류, 빈 파일, 객체가 아님)은
'<이름>.broken-<날짜시간>'으로 옮겨 보관하고 기본값으로 다시 만든다(RECOVERED에 기록). 표준 라이브러리만 사용.
"""
import json
import logging
import os
import tempfile
import time
from pathlib import Path

try:
    import fcntl
except ImportError:  # pragma: no cover (macOS/Linux에는 항상 있음)
    fcntl = None

log = logging.getLogger("vnlib.config")

ROOT = Path(__file__).resolve().parent.parent
CONFIG_DIR = ROOT / "config"
CHAR_DIR = ROOT / "characters"
OUTPUT_DIR = ROOT / "output"
USER_DIR = ROOT / "user"
ENGINE_DIR = Path("/Volumes/T7/ComfyUI/Installs/ComfyUI")
ENGINE_PYTHON = ENGINE_DIR / "standalone-env" / "bin" / "python"

# 모델 파일 검색 경로. 같은 이름이 여러 곳에 있으면 앞쪽이 우선 — ComfyUI가 실제로 찾는 순서와 같게 유지:
# extra_model_paths.yaml의 vn_pipeline(is_default: true → 맨 앞) → 엔진 기본 models → legacy_shared(뒤에 추가)
# 첫 번째는 새 파일을 설치하는 곳(studio.common.MODEL_INSTALL_ROOT)이기도 하다.
MODEL_ROOTS = [
    ROOT / "models",
    ENGINE_DIR / "ComfyUI" / "models",
    Path("/Volumes/T7/ComfyUI/Shared/models"),
]

DEFAULT_PRESETS = {
    "wai": {
        "label": "WAI-Illustrious v17 (기본 추천)",
        "ckpt": "waiIllustriousSDXL_v170.safetensors",
        "vpred": False,
        "sampler": "euler_ancestral",
        "scheduler": "normal",
        "cfg": 6.0,
        "steps": 28,
        "quality": "masterpiece, best quality, amazing quality",
        "negative": "bad quality, worst quality, worst detail, sketch, censor, nsfw, bad hands, extra fingers, missing fingers",
        "loras": [],
        "note": "깔끔한 애니 캐릭터 그림체. 손·팔다리가 안정적. 품질 태그와 네거티브는 짧게 유지할 것(길면 오히려 흐려짐).",
    },
    "noob": {
        "label": "NoobAI-XL Vpred 1.0",
        "ckpt": "NoobAI-XL-Vpred-v1.0.safetensors",
        "vpred": True,
        "sampler": "euler",
        "scheduler": "normal",
        "cfg": 5.0,
        "steps": 30,
        "quality": "masterpiece, best quality, newest, absurdres, highres, very awa, safe",
        "negative": "nsfw, worst quality, old, early, low quality, lowres, signature, username, logo, bad hands, mutated hands, mammal, anthro, furry, ambiguous form, feral, semi-anthro",
        "loras": [],
        "note": "v-prediction 모델(샘플러는 반드시 euler). 색감이 강하고 태그 이해도가 높지만 그림체 편차가 큼. 상업적 이용 금지 라이선스.",
    },
    "noob-hq": {
        "label": "NoobAI Vpred + 품질 LoRA",
        "ckpt": "NoobAI-XL-Vpred-v1.0.safetensors",
        "vpred": True,
        "sampler": "euler",
        "scheduler": "normal",
        "cfg": 5.0,
        "steps": 30,
        "quality": "masterpiece, very aesthetic, best quality, newest, absurdres, highres, very awa, safe",
        "negative": "nsfw, worst quality, old, early, low quality, lowres, signature, username, logo, bad hands, mutated hands, mammal, anthro, furry, ambiguous form, feral, semi-anthro",
        "loras": [{"name": "noobai_vpred_1_masterpieces_v23.safetensors", "weight": 0.7}],
        "note": "noob + 같은 모델로 학습된 masterpieces LoRA. 테스트상 효과는 작음.",
    },
    "noob-eps": {
        "label": "NoobAI-XL 1.1 (eps)",
        "ckpt": "NoobAI-XL-v1.1.safetensors",
        "vpred": False,
        "sampler": "euler_ancestral",
        "scheduler": "normal",
        "cfg": 5.5,
        "steps": 28,
        "quality": "masterpiece, best quality, newest, absurdres, highres, very awa, safe",
        "negative": "nsfw, worst quality, old, early, low quality, lowres, signature, username, logo, bad hands, mutated hands, mammal, anthro, furry, ambiguous form, feral, semi-anthro",
        "loras": [],
        "note": "NoobAI eps(일반) 버전. vpred보다 다루기 쉽고 Illustrious 계열 LoRA와 잘 맞음. 상업적 이용 금지 라이선스.",
    },
}

DEFAULT_SETTINGS = {
    "default_preset": "wai",
    "comfy_url": "http://127.0.0.1:8188",
    "studio_port": 8190,
    "autostart_comfy": True,
    "hires_scale": 1.5,     # 하이레즈 배율
    "hires_steps": 14,
    "hires_denoise": 0.4,   # 높을수록 많이 다시 그림(디테일↑, 원본과 차이↑)
    "detail_steps": 14,
    "face_denoise": 0.35,
    "hand_denoise": 0.4,
    "expr_denoise": 0.55,   # 표정 차분 기본 강도
    "upscaler": "RealESRGAN_x4plus_anime_6B.pth",
    "civitai_token": "",    # Civitai 다운로드용 API 토큰 (선택)
    # 프롬프트 추출(이미지·3D → Danbooru 태그, vnlib/tagger.py)
    "tagger_model": "wd-eva02-large-tagger-v3",  # models/tagger/<이름>/
    "tagger_threshold": 0.35,       # 일반 태그 기준값 (낮추면 많이·부정확, 높이면 적게·정확)
    "tagger_char_threshold": 0.85,  # 캐릭터 태그(기존 작품 캐릭터) 기준값
    # 포즈 따라 그리기 (ControlNet OpenPose, vnlib/pose.py) — 1차 생성에만 적용
    "pose_model": "noob_openpose.safetensors",  # models/controlnet/ 의 파일 이름
    "pose_strength": 1.0,   # 0.1~2.0 (xinsir 모델은 1.2 권장)
    "pose_end": 1.0,        # 적용 구간 끝 0.1~1.0 (1.0 = 끝까지)
    # 원격 접속 (Tailscale Serve, studio/remote.py) — 일반 설정 저장(PUT /api/settings)으로는 못 바꿈, /api/remote 전용
    "remote_enabled": False,        # Studio가 테일넷(원격) 요청을 받을지. Tailscale Serve 설정과 둘 다 켜져야 접속됨
    "remote_allowed_logins": [],    # 허용할 테일넷 로그인(대소문자 무시). 비어 있으면 켤 때 테일넷 사용자 전부로 채움
    "remote_hosts": [],             # 원격 접속 주소(자동: MagicDNS 이름 + 짧은 이름). DNS 리바인딩 방지용
}

# LoRA 메모 기본값 (사용자가 GUI에서 수정 가능)
DEFAULT_LORA_META = {
    "noobai_vpred_1_masterpieces_v23.safetensors": {
        "trigger": "masterpiece, very aesthetic", "weight": 0.7,
        "note": "NoobAI vpred 전용 품질 LoRA. noob 프리셋과 함께 사용."},
    "AddMicroDetails_Illustrious_v6.safetensors": {
        "trigger": "addmicrodetails", "weight": 0.5,
        "note": "Illustrious 계열(WAI 등)용 디테일 강화 LoRA. 0.3~0.6 권장."},
    "detailed_hands_unhinged.safetensors": {
        "trigger": "", "weight": 0.6,
        "note": "손 묘사 보정 LoRA (NoobAI 1.1 기반 학습)."},
    "badhands.safetensors": {
        "trigger": "badhands", "weight": 0.8,
        "note": "SDXL 기본 모델용 '나쁜 손' 학습 LoRA. 보통 네거티브 쪽에서 쓰는 개념이라 일반 사용 시 효과 불확실."},
    "noobai_ep11_stabilizer_v0.178_fp16.safetensors": {
        "trigger": "", "weight": 0.5, "note": "NoobAI eps 1.1용 안정화 LoRA."},
    "cknb02_stabilizer_v0.304a_fp16.safetensors": {
        "trigger": "", "weight": 0.5, "note": "안정화 LoRA (SDXL)."},
    "add_detail.safetensors": {
        "trigger": "", "weight": 0.5, "note": "SD1.5 전용 — 현재 SDXL 모델들과 호환되지 않음."},
}

SIZES = {
    "portrait": (832, 1216),
    "landscape": (1216, 832),
    "wide": (1344, 768),
    "tall": (768, 1344),
    "square": (1024, 1024),
}


class ConfigError(ValueError):
    """설정 파일(config/*.json)을 읽거나 복구할 수 없음. 메시지는 한국어이고 파일 경로를 포함한다."""


# 깨진 설정 파일을 기본값으로 복구한 기록 (이 프로세스에서 일어난 것). Studio가 화면에 알릴 수 있게 남긴다.
# 항목: {"file": "config/settings.json", "backup": "config/settings.json.broken-…", "error": 원인, "message": 안내문, "time": epoch}
RECOVERED = []


def _rel(path: Path):
    try:
        return path.resolve().relative_to(ROOT).as_posix()
    except (OSError, ValueError):
        return str(path)


def _read(path: Path, default):
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        write_json(path, default)
        return json.loads(json.dumps(default))
    except OSError as e:
        raise ConfigError(f"설정 파일 {_rel(path)} 을(를) 읽을 수 없습니다: {e.strerror or e}") from None
    try:
        data = json.loads(raw.decode("utf-8-sig"))  # 편집기가 붙인 BOM은 허용
    except UnicodeDecodeError:
        problem = "UTF-8 텍스트 파일이 아닙니다"
    except json.JSONDecodeError as e:
        problem = f"{e.lineno}번째 줄 {e.colno}번째 칸: {e.msg}" if raw.strip() else "파일이 비어 있습니다"
    else:
        if isinstance(data, dict):
            return data
        problem = "내용이 { } 로 감싼 JSON 객체가 아닙니다"
    return _recover(path, default, problem)


def _recover(path: Path, default, problem):
    """깨진 설정 파일을 옆에 보관하고 기본값으로 다시 만든다 (사용자 데이터는 지우지 않음)."""
    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = path.with_name(f"{path.name}.broken-{stamp}")
    n = 2
    while backup.exists():
        backup = path.with_name(f"{path.name}.broken-{stamp}-{n}")
        n += 1
    try:
        os.rename(path, backup)
    except FileNotFoundError:
        pass  # 다른 프로세스(CLI/Studio)가 먼저 옮겼음
    except OSError as e:
        raise ConfigError(
            f"설정 파일 {_rel(path)} 의 형식이 잘못되었습니다 ({problem}). "
            f"텍스트 편집기로 고치거나, 이 파일을 지우면 기본값으로 다시 만들어집니다. (보관 실패: {e.strerror or e})") from None
    try:
        write_json(path, default)
    except OSError as e:
        raise ConfigError(f"설정 파일 {_rel(path)} 을(를) 기본값으로 다시 만들지 못했습니다: {e.strerror or e}") from None
    message = (f"설정 파일 {_rel(path)} 의 형식이 잘못되어({problem}) 기본값으로 복구했습니다. "
               f"원래 파일은 {_rel(backup)} 으로 보관했습니다.")
    RECOVERED.append({"file": _rel(path), "backup": _rel(backup), "error": problem,
                      "message": message, "time": time.time()})
    log.warning("%s", message)  # CLI에서는 stderr, Studio에서는 user/studio.log 에 남는다
    return json.loads(json.dumps(default))


def _fsync(fd):
    """macOS의 fsync는 디스크 캐시까지 비우지 않으므로 F_FULLFSYNC를 먼저 시도 (외장 SSD를 바로 뽑아도 안전하게)"""
    if fcntl is not None and hasattr(fcntl, "F_FULLFSYNC"):
        try:
            fcntl.fcntl(fd, fcntl.F_FULLFSYNC)
            return
        except OSError:
            pass
    os.fsync(fd)


def write_json(path: Path, data):
    """원자적 저장 (쓰다가 죽거나 전원이 끊겨도 이전 파일 또는 새 파일 중 하나가 온전히 남게)"""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write("\n")
            f.flush()
            _fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    try:  # 이름 바꾸기(디렉터리 항목)도 디스크에 반영
        dfd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    except OSError:
        pass


def normalize_loras(loras):
    """[["a.safetensors", 0.7]] / [("a", 0.7)] / [{"name":..,"weight":..}] → [{"name","weight"}]"""
    out = []
    for item in loras or []:
        if isinstance(item, dict):
            if item.get("name"):
                out.append({"name": item["name"], "weight": float(item.get("weight", 0.8))})
        elif isinstance(item, (list, tuple)) and item:
            out.append({"name": item[0], "weight": float(item[1]) if len(item) > 1 else 0.8})
        elif isinstance(item, str):
            out.append({"name": item, "weight": 0.8})
    return out


def load_presets():
    p = _read(CONFIG_DIR / "presets.json", DEFAULT_PRESETS)
    p = {k: v for k, v in p.items() if isinstance(v, dict)}  # 손으로 고치다 망가진 항목은 무시
    for v in p.values():
        v["loras"] = normalize_loras(v.get("loras"))
        v.setdefault("scheduler", "normal")
        v.setdefault("label", "")
        v.setdefault("note", "")
    return p


def save_presets(presets):
    write_json(CONFIG_DIR / "presets.json", presets)


def load_settings():
    s = json.loads(json.dumps(DEFAULT_SETTINGS))  # 목록 기본값(remote_*)을 호출한 쪽이 고쳐도 기본값은 그대로
    s.update(_read(CONFIG_DIR / "settings.json", DEFAULT_SETTINGS))
    return s


def save_settings(settings):
    write_json(CONFIG_DIR / "settings.json", settings)


def load_lora_meta():
    meta = _read(CONFIG_DIR / "loras.json", DEFAULT_LORA_META)
    return {k: v for k, v in meta.items() if isinstance(v, dict)}


def save_lora_meta(meta):
    write_json(CONFIG_DIR / "loras.json", meta)


def model_dirs(folder):
    """folder: checkpoints | loras | upscale_models ... → 실제 존재하는 디렉터리 목록"""
    return [r / folder for r in MODEL_ROOTS if (r / folder).is_dir()]


def find_model(folder, name):
    for d in model_dirs(folder):
        p = d / name
        if p.exists():
            return p
    return None


def list_models(folder, exts=(".safetensors", ".ckpt", ".pt", ".pth", ".bin")):
    """이름 → 경로 (먼저 찾은 경로 우선, 심볼릭 링크 허용)"""
    found = {}
    for d in model_dirs(folder):
        for p in sorted(d.rglob("*")):
            if p.suffix.lower() in exts and (p.is_file()):
                name = p.relative_to(d).as_posix()
                found.setdefault(name, p)
    return found
