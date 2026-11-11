"""갤러리: output/ 스캔, PNG 메타데이터(ComfyUI 그래프) 해석, 썸네일 캐시, 휴지통 이동."""
import asyncio
import hashlib
import json
import os
import re
import shutil
import struct
import time
import zlib

from PIL import Image, ImageOps

from vnlib import config, graphs
from vnlib import pose as poselib

from .common import ApiError, OUTPUT_DIR, THUMB_DIR, file_url, log, safe_path, thumb_url
from .secret import SECRET_DIR, is_secret_path
from .poses import pose_url

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp"}
CHAR_KINDS = ("concept", "sprite", "cg")
THUMB_SIZES = (96, 128, 192, 256, 320, 384, 512, 640, 768, 1024)
PNG_SIG = b"\x89PNG\r\n\x1a\n"
SEED_RE = re.compile(r"_seed(\d+)")
SAMPLERS = ("KSampler", "KSamplerAdvanced", "SamplerCustom", "SamplerCustomAdvanced")
DETAILERS = ("FaceDetailer", "DetailerForEach", "DetailerForEachDebug")
TRASH = ".trash"


def classify(rel):
    """경로 규칙으로 종류/캐릭터 판정"""
    parts = rel.split("/")
    if parts[0] == SECRET_DIR and len(parts) > 1:  # 시크릿 모드 출력: _secret/<원래 경로>
        parts = parts[1:]
    if parts[0] == "prompt":
        return "prompt", None
    if parts[0] == "backgrounds":
        return "bg", None
    if parts[0] == "pixel":
        return "pixel", None
    if parts[0] == "sheets":
        return "sheet", None
    if parts[0] == "icons":  # icons/<세트>/<이름>.png = 원본, icons/<세트>/<N>px/<이름>.png = 크기별
        return ("icon_size" if len(parts) >= 4 else "icon"), None
    if len(parts) >= 3 and parts[1] in CHAR_KINDS:
        return parts[1], parts[0]
    return "other", None


# ---------------------------------------------------------------------- PNG 읽기
def read_png(path):
    """→ (width, height, {key: text}) — IDAT 은 건너뛰므로 빠름"""
    texts = {}
    w = h = None
    with open(path, "rb") as f:
        if f.read(8) != PNG_SIG:
            return None
        while True:
            hdr = f.read(8)
            if len(hdr) < 8:
                break
            length, ctype = struct.unpack(">I4s", hdr)
            if ctype == b"IHDR":
                data = f.read(length)
                w, h = struct.unpack(">II", data[:8])
                f.seek(4, 1)
            elif ctype in (b"tEXt", b"zTXt", b"iTXt") and length < 64 * 1024 * 1024:
                data = f.read(length)
                f.seek(4, 1)
                try:
                    k, v = _parse_text_chunk(ctype, data)
                    if k:
                        texts[k] = v
                except (ValueError, zlib.error, UnicodeDecodeError):
                    pass
            elif ctype == b"IEND":
                break
            else:
                f.seek(length + 4, 1)
    return w, h, texts


def _parse_text_chunk(ctype, data):
    if ctype == b"tEXt":
        k, _, v = data.partition(b"\0")
        return k.decode("latin-1"), v.decode("latin-1")
    if ctype == b"zTXt":
        k, _, rest = data.partition(b"\0")
        return k.decode("latin-1"), zlib.decompress(rest[1:]).decode("latin-1")
    # iTXt: keyword\0 comp_flag comp_method lang\0 translated\0 text
    k, _, rest = data.partition(b"\0")
    comp_flag = rest[0]
    rest = rest[2:]
    _, _, rest = rest.partition(b"\0")
    _, _, text = rest.partition(b"\0")
    if comp_flag:
        text = zlib.decompress(text)
    return k.decode("latin-1"), text.decode("utf-8")


# ---------------------------------------------------------------------- 그래프 해석
def _link(v):
    if isinstance(v, list) and len(v) == 2 and isinstance(v[0], (str, int)):
        return str(v[0])
    return None


def _ancestors(graph, start):
    """start 에서 위로(입력 방향) BFS. 반환: 방문 순서 리스트(시작 노드 제외)"""
    seen, order, queue = {start}, [], [start]
    while queue:
        nid = queue.pop(0)
        node = graph.get(nid) or {}
        for v in (node.get("inputs") or {}).values():
            src = _link(v)
            if src and src not in seen and src in graph:
                seen.add(src)
                order.append(src)
                queue.append(src)
    return order


def _slot(v):
    return v[1] if isinstance(v, list) and len(v) == 2 and isinstance(v[1], int) else 0


def _text_of(graph, nid, depth=0, slot=0):
    """CLIPTextEncode 등의 텍스트를 링크를 따라가며 찾는다.

    slot: 링크가 가리키는 출력 번호. positive/negative를 함께 받아 둘 다 내보내는 노드(ControlNetApplyAdvanced 등)는
    출력 1이 negative 이므로 negative 입력을 따라간다."""
    if nid is None or depth > 8 or nid not in graph:
        return None
    inp = graph[nid].get("inputs") or {}
    for key in ("text", "text_g", "value", "string", "prompt"):
        v = inp.get(key)
        if isinstance(v, str):
            return v
        if _link(v):
            t = _text_of(graph, _link(v), depth + 1, _slot(v))
            if t is not None:
                return t
    keys = ("conditioning", "conditioning_1", "conditioning_to", "positive", "base_positive")
    if slot == 1 and _link(inp.get("negative")):
        keys = ("negative",)
    for key in keys:
        if _link(inp.get(key)):
            t = _text_of(graph, _link(inp[key]), depth + 1, _slot(inp[key]))
            if t is not None:
                return t
    return None


def _cond_text(graph, v):
    """샘플러의 positive/negative 입력 값(링크) → 텍스트"""
    return _text_of(graph, _link(v), 0, _slot(v))


def _pose_of(graph, nodes):
    """그래프에서 포즈(ControlNet) 정보: {name, image, model, strength, end} | None"""
    cn = next((n for _, n in sorted(nodes, key=lambda x: _sort_key(x[0]))
               if str(n.get("class_type", "")).startswith("ControlNetApply")), None)
    if cn is None:
        return None
    inp = cn.get("inputs") or {}
    image, src, depth = None, _link(inp.get("image")), 0
    while src and src in graph and depth < 6:  # LoadImage ← (ImageScale 등)
        sinp = graph[src].get("inputs") or {}
        if isinstance(sinp.get("image"), str):
            image = sinp["image"]
            break
        src, depth = _link(sinp.get("image")), depth + 1
    model = None
    ln = _link(inp.get("control_net"))
    if ln and ln in graph:
        model = (graph[ln].get("inputs") or {}).get("control_net_name")
    return {"name": poselib.base_name_of(image), "image": image if isinstance(image, str) else None,
            "model": model if isinstance(model, str) else None, "strength": _num(inp.get("strength")),
            "end": _num(inp.get("end_percent"))}


def _num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def _sort_key(nid):
    return (0, int(nid)) if str(nid).isdigit() else (1, str(nid))


def parse_graph(graph, rel):
    """ComfyUI API 그래프 + 파일 경로 → 생성 정보"""
    info = {"positive": None, "negative": None, "seed": None, "ckpt": None, "loras": [],
            "steps": None, "cfg": None, "sampler": None, "scheduler": None, "pose": None}
    if not isinstance(graph, dict):
        return info
    graph = {str(k): v for k, v in graph.items() if isinstance(v, dict)}
    # 1) 이 파일을 저장한 SaveImage 노드 찾기 (prefix + _00001_.png)
    name = rel.rsplit("/", 1)[-1]
    save = None
    for nid, n in graph.items():
        pfx = (n.get("inputs") or {}).get("filename_prefix")
        if n.get("class_type", "").startswith("SaveImage") and isinstance(pfx, str):
            if re.fullmatch(re.escape(pfx) + r"_\d+_?\.\w+", rel) or \
               re.fullmatch(re.escape(pfx.rsplit("/", 1)[-1]) + r"_\d+_?\.\w+", name):
                save = nid
                break
    scope = _ancestors(graph, save) if save else sorted(graph, key=_sort_key)
    nodes = [(nid, graph[nid]) for nid in scope]

    # 2) 가장 가까운 샘플러(표정 보정 등)의 프롬프트/시드
    near = next(((nid, n) for nid, n in nodes if n.get("class_type") in SAMPLERS + DETAILERS), None)
    if near:
        inp = near[1].get("inputs") or {}
        info["positive"] = _cond_text(graph, inp.get("positive"))
        info["negative"] = _cond_text(graph, inp.get("negative"))
        info["seed"] = _num(inp.get("seed", inp.get("noise_seed")))
    # 3) 기본 샘플링 설정은 가장 처음(ID가 작은) KSampler 기준
    base = sorted((x for x in nodes if x[1].get("class_type") in SAMPLERS), key=lambda x: _sort_key(x[0]))
    if base:
        inp = base[0][1].get("inputs") or {}
        info["steps"], info["cfg"] = _num(inp.get("steps")), _num(inp.get("cfg"))
        info["sampler"], info["scheduler"] = inp.get("sampler_name"), inp.get("scheduler")
        if info["seed"] is None:
            info["seed"] = _num(inp.get("seed", inp.get("noise_seed")))
        if info["positive"] is None:
            info["positive"] = _cond_text(graph, inp.get("positive"))
            info["negative"] = _cond_text(graph, inp.get("negative"))
    # 4) 제목 기반 보조 탐색
    if info["positive"] is None:
        for nid, n in sorted(graph.items(), key=lambda x: _sort_key(x[0])):
            title = (n.get("_meta") or {}).get("title")
            if title == "긍정 프롬프트" and info["positive"] is None:
                info["positive"] = _text_of(graph, nid)
            elif title == "부정 프롬프트" and info["negative"] is None:
                info["negative"] = _text_of(graph, nid)
    if isinstance(info["seed"], float):
        info["seed"] = int(info["seed"])
    # 5) 모델 / LoRA
    pool = nodes if save else sorted(graph.items(), key=lambda x: _sort_key(x[0]))
    for nid, n in sorted(pool, key=lambda x: _sort_key(x[0])):
        ct, inp = n.get("class_type", ""), n.get("inputs") or {}
        if ct.startswith("CheckpointLoader") and info["ckpt"] is None and isinstance(inp.get("ckpt_name"), str):
            info["ckpt"] = inp["ckpt_name"]
        elif ct == "UNETLoader" and info["ckpt"] is None and isinstance(inp.get("unet_name"), str):
            info["ckpt"] = inp["unet_name"]
        elif ct.startswith("LoraLoader") and isinstance(inp.get("lora_name"), str):
            info["loras"].append({"name": inp["lora_name"], "weight": _num(inp.get("strength_model"))})
    # 6) 포즈 (ControlNet OpenPose)
    info["pose"] = _pose_of(graph, pool)
    return info


def parse_a1111(text):
    info = {}
    pos, _, rest = text.partition("\nNegative prompt:")
    info["positive"] = pos.strip()
    neg, _, params = rest.partition("\nSteps:")
    info["negative"] = neg.strip() or None
    m = re.search(r"Seed: (\d+)", text)
    info["seed"] = int(m.group(1)) if m else None
    m = re.search(r"Model: ([^,\n]+)", text)
    info["ckpt"] = m.group(1).strip() if m else None
    return info


def read_meta(path, rel):
    """이미지 1장의 메타데이터 (크기 + 생성 정보)"""
    meta = {"width": None, "height": None, "positive": None, "negative": None, "seed": None,
            "ckpt": None, "loras": [], "steps": None, "cfg": None, "sampler": None, "scheduler": None, "pose": None}
    try:
        if path.suffix.lower() == ".png":
            r = read_png(path)
            if r:
                meta["width"], meta["height"], texts = r
                if "prompt" in texts:
                    try:
                        meta.update(parse_graph(json.loads(texts["prompt"]), rel))
                    except ValueError:
                        pass
                elif "parameters" in texts:
                    meta.update(parse_a1111(texts["parameters"]))
                return meta
        with Image.open(path) as im:
            meta["width"], meta["height"] = im.size
            p = im.info.get("prompt")
            if isinstance(p, str):
                try:
                    meta.update(parse_graph(json.loads(p), rel))
                except ValueError:
                    pass
    except (OSError, ValueError, struct.error, Image.DecompressionBombError):
        pass
    return meta


# ---------------------------------------------------------------------- 썸네일
def _thumb_key(rel):
    return hashlib.sha1(rel.encode("utf-8")).hexdigest()[:24]


def _make_thumb(src, w, dest_base):
    with Image.open(src) as im:
        if im.format == "JPEG":
            im.draft("RGB", (w, w * 4))
        im = ImageOps.exif_transpose(im)
        alpha = im.mode in ("RGBA", "LA", "PA") or (im.mode == "P" and "transparency" in im.info)
        if alpha:
            im = im.convert("RGBA")
            if im.getchannel("A").getextrema() == (255, 255):
                alpha = False
        if not alpha:
            im = im.convert("RGB")
        # 도트(픽셀 아트)처럼 썸네일보다 작은 그림은 정수 배 최근접 확대 + 무손실 저장 (흐려지거나 JPEG 얼룩이 생기지 않게)
        k = w // im.width if im.width <= w // 2 else 0
        small = k < 2 and im.width <= min(w, 512)  # 썸네일보다 작지만 2배는 안 되는 그림: 원래 크기 그대로 무손실 (화면에서 최근접 확대)
        if k >= 2:
            im = im.resize((im.width * k, im.height * k), Image.Resampling.NEAREST)
        elif small:
            k = 2  # 아래 무손실 저장 경로를 같이 쓴다
        else:
            im.thumbnail((w, w * 4), Image.Resampling.LANCZOS, reducing_gap=3.0)
        ext = ".webp" if alpha or k >= 2 else ".jpg"
        dest = dest_base.with_name(dest_base.name + ext)
        tmp = dest.with_name(dest.name + f".{os.getpid()}.tmp")
        if k >= 2:
            im.save(tmp, "WEBP", lossless=True, method=4)
        elif alpha:
            im.save(tmp, "WEBP", quality=85, method=4)
        else:
            im.save(tmp, "JPEG", quality=84, optimize=True, progressive=True)
        os.replace(tmp, dest)
    # 같은 이미지의 오래된 썸네일 정리
    key, size = dest_base.name.split("-")[:2]
    for old in THUMB_DIR.glob(f"{key}-{size}-*"):
        if old != dest and not old.name.endswith(".tmp"):
            try:
                old.unlink()
            except OSError:
                pass
    return dest


class Gallery:
    def __init__(self, store):
        self.store = store
        self.meta_cache = {}   # rel → (mtime_ns, size, meta)
        self._thumb_sem = asyncio.Semaphore(3)
        self._inflight = {}

    # ------------------------------------------------------------ 스캔
    @staticmethod
    def scan():
        """output/ 아래 이미지 (숨김/.trash/심볼릭 링크 제외) → [(rel, mtime, size, mtime_ns)]"""
        out = []
        root = OUTPUT_DIR
        stack = [root]
        while stack:
            d = stack.pop()
            try:
                it = os.scandir(d)
            except OSError:
                continue
            with it:
                for e in it:
                    if e.name.startswith("."):
                        continue
                    try:
                        if e.is_symlink():
                            continue
                        if e.is_dir():
                            stack.append(e.path)
                        elif e.is_file() and os.path.splitext(e.name)[1].lower() in IMAGE_EXTS:
                            st = e.stat()
                            rel = os.path.relpath(e.path, root).replace(os.sep, "/")
                            out.append((rel, st.st_mtime, st.st_size, st.st_mtime_ns))
                    except OSError:
                        continue
        out.sort(key=lambda x: (-x[1], x[0]))
        return out

    def meta(self, rel, mtime_ns, size):
        c = self.meta_cache.get(rel)
        if c and c[0] == mtime_ns and c[1] == size:
            return c[2]
        m = read_meta(OUTPUT_DIR / rel, rel)
        self.meta_cache[rel] = (mtime_ns, size, m)
        return m

    def _query(self, folder, q, char, kind, limit, offset):
        files = self.scan()
        folders = sorted({r.rsplit("/", 1)[0] for r, *_ in files if "/" in r})
        sel = []
        ql = (q or "").strip().casefold()
        for rel, mtime, size, mns in files:
            fdir = rel.rsplit("/", 1)[0] if "/" in rel else ""
            if folder and not (fdir == folder or fdir.startswith(folder + "/")):
                continue
            k, ch = classify(rel)
            if char and ch != char:
                continue
            if kind and k != kind:
                continue
            if ql:
                name = rel.rsplit("/", 1)[-1].casefold()
                if ql not in name and ql not in rel.casefold():
                    pos = self.meta(rel, mns, size).get("positive") or ""
                    if ql not in pos.casefold():
                        continue
            sel.append((rel, mtime, size, mns, fdir, k, ch))
        total = len(sel)
        page = sel[offset:offset + limit]
        items = []
        for rel, mtime, size, mns, fdir, k, ch in page:
            m = self.meta(rel, mns, size)
            items.append({"path": rel, "url": file_url(rel), "thumb": thumb_url(rel), "folder": fdir,
                          "name": rel.rsplit("/", 1)[-1], "mtime": mtime, "size": size,
                          "width": m.get("width"), "height": m.get("height"), "job_id": None,
                          "seed": m.get("seed"), "preset": None, "character": ch, "kind": k,
                          "secret": is_secret_path(rel)})
        return items, total, folders

    async def query(self, folder="", q="", char="", kind="", limit=60, offset=0):
        items, total, folders = await asyncio.to_thread(self._query, folder, q, char, kind, limit, offset)
        known = self.store.outputs_for([it["path"] for it in items])
        presets = sorted(config.load_presets(), key=len, reverse=True)
        for it in items:
            rec = known.get(it["path"])
            m = SEED_RE.search(it["name"])
            stem = it["name"][:m.start()] if m else ""
            if rec:
                it["job_id"], seed, it["preset"] = rec
                if seed is not None:
                    it["seed"] = seed
            elif m:
                it["seed"] = int(m.group(1))
            if not it["preset"] and stem:
                it["preset"] = next((p for p in presets if stem == p or stem.endswith("_" + p)), None)
        return {"items": items, "total": total, "folders": folders}

    async def info(self, rel, jobs):
        p = safe_path(OUTPUT_DIR, rel)
        if not p.is_file():
            raise ApiError(404, "파일을 찾을 수 없습니다")
        rel = p.relative_to(OUTPUT_DIR.resolve()).as_posix()
        st = p.stat()
        m = await asyncio.to_thread(self.meta, rel, st.st_mtime_ns, st.st_size)
        rec = self.store.outputs_for([rel]).get(rel)
        job = None
        if rec:
            try:
                job = jobs.get(rec[0])
            except ApiError:
                job = None
        seed = rec[1] if rec and rec[1] is not None else m.get("seed")
        kind, ch = classify(rel)
        pose = self.pose_info(job, m.get("pose"))
        return {"path": rel, "url": file_url(rel), "thumb": thumb_url(rel), "job": job,
                "positive": m.get("positive"), "negative": m.get("negative"), "seed": seed,
                "ckpt": m.get("ckpt"), "loras": m.get("loras") or [],
                "width": m.get("width"), "height": m.get("height"),
                "steps": m.get("steps"), "cfg": m.get("cfg"), "sampler": m.get("sampler"),
                "scheduler": m.get("scheduler"), "preset": (job or {}).get("preset") or (rec[2] if rec else None),
                "kind": kind, "character": ch, "size": st.st_size, "mtime": st.st_mtime, "pose": pose}

    @staticmethod
    def pose_info(job, parsed):
        """사용한 포즈 {name, model, strength, end, exists, url, src_url} | None
        — 작업 기록(실제 적용값) → 작업 spec → PNG 그래프 순으로."""
        p = None
        if job:
            p = job.get("pose") or (job.get("spec") or {}).get("pose")
            if (job.get("spec") or {}).get("mode") in graphs.NO_PEOPLE_MODES:
                p = None  # 배경 모드는 포즈를 쓰지 않음
        if not p and parsed:
            p = parsed
        if not p or not isinstance(p, dict):
            return None
        name = p.get("name")
        out = {"name": name, "model": p.get("model"), "strength": p.get("strength"), "end": p.get("end"),
               "exists": False, "url": None, "src_url": None}
        if isinstance(name, str) and poselib.exists(name):
            n = poselib.normalize_name(name)
            out.update(name=n, exists=True, url=pose_url(n))
            if poselib.pose_path(n, "src").is_file():
                out["src_url"] = pose_url(n, "src")
        return out

    # ------------------------------------------------------------ 썸네일
    async def thumb(self, rel, w):
        src = safe_path(OUTPUT_DIR, rel)
        if not src.is_file() or src.suffix.lower() not in IMAGE_EXTS:
            raise ApiError(404, "이미지를 찾을 수 없습니다")
        w = min(THUMB_SIZES, key=lambda s: abs(s - w))
        st = src.stat()
        rel_key = src.relative_to(OUTPUT_DIR.resolve()).as_posix()
        base = THUMB_DIR / f"{_thumb_key(rel_key)}-{w}-{st.st_mtime_ns}-{st.st_size}"
        for ext in (".jpg", ".webp"):
            cand = base.with_name(base.name + ext)
            if cand.exists():
                return cand
        fut = self._inflight.get(base)
        if fut is None:
            fut = asyncio.get_running_loop().create_future()
            self._inflight[base] = fut
            try:
                async with self._thumb_sem:
                    THUMB_DIR.mkdir(parents=True, exist_ok=True)
                    dest = await asyncio.to_thread(_make_thumb, src, w, base)
                fut.set_result(dest)
            except Exception as e:
                fut.set_exception(e)
                fut.exception()  # '처리 안 된 예외' 경고 방지
            finally:
                self._inflight.pop(base, None)
        try:
            return await asyncio.shield(fut)
        except (OSError, ValueError, Image.DecompressionBombError) as e:
            log.warning("썸네일 생성 실패 %s: %s", rel, e)
            raise ApiError(422, "이미지를 읽을 수 없습니다 (저장 중이거나 손상된 파일)") from None

    @staticmethod
    def purge_thumbs(rel):
        for old in THUMB_DIR.glob(f"{_thumb_key(rel)}-*"):
            try:
                old.unlink()
            except OSError:
                pass

    # ------------------------------------------------------------ 휴지통
    def trash(self, rels):
        if not isinstance(rels, list) or not rels:
            raise ApiError(400, "삭제할 파일 목록(paths)이 비어 있습니다")
        if len(rels) > 1000:
            raise ApiError(400, "한 번에 1000개까지만 삭제할 수 있습니다")
        base = OUTPUT_DIR.resolve()
        trash_root = base / TRASH
        moved, errors = [], []
        for rel in rels:
            try:
                lex = safe_path(OUTPUT_DIR, rel, resolve=False)
                safe_path(OUTPUT_DIR, rel)  # 심볼릭 링크 대상까지 검사
                if not lex.is_file() or lex.suffix.lower() not in IMAGE_EXTS:
                    raise ApiError(404, "이미지 파일이 아닙니다")
                r = lex.relative_to(base).as_posix()
                if is_secret_path(r):  # 시크릿 출력은 휴지통에 남기지 않고 바로 지운다
                    lex.unlink()
                    self.purge_thumbs(r)
                    self.meta_cache.pop(r, None)
                    self.store.forget_output(r)
                    moved.append(r)
                    continue
                dest = trash_root / r
                dest.parent.mkdir(parents=True, exist_ok=True)
                if dest.exists():
                    dest = dest.with_name(f"{dest.stem}.{time.strftime('%Y%m%d-%H%M%S')}{dest.suffix}")
                shutil.move(str(lex), str(dest))
                self.purge_thumbs(r)
                self.meta_cache.pop(r, None)
                moved.append(r)
            except ApiError as e:
                errors.append({"path": rel, "error": e.message})
            except OSError as e:
                errors.append({"path": rel, "error": f"이동 실패: {e.strerror or e}"})
        return {"ok": not errors, "deleted": moved, "errors": errors,
                "trash": str(trash_root)}


# ---------------------------------------------------------------------- 캐릭터 썸네일
def character_assets(cid):
    """캐릭터 대표 이미지(가장 최근 sprite base → concept → cg)와 종류별 장수 (시크릿 출력 _secret/<id>/… 포함)"""
    newest = {}
    counts = {}
    for kind in CHAR_KINDS:
        best = None
        n = 0
        for pre in ("", SECRET_DIR + "/"):
            try:
                with os.scandir(OUTPUT_DIR / f"{pre}{cid}" / kind) as it:
                    for e in it:
                        if e.name.startswith(".") or os.path.splitext(e.name)[1].lower() not in IMAGE_EXTS:
                            continue
                        try:
                            if not e.is_file(follow_symlinks=False):
                                continue
                            mt = e.stat().st_mtime
                        except OSError:
                            continue
                        n += 1
                        if kind == "sprite" and "_base_" not in e.name:
                            continue
                        if best is None or mt > best[0]:
                            best = (mt, f"{pre}{cid}/{kind}/{e.name}")
            except OSError:
                pass
        counts[kind] = n
        if best:
            newest[kind] = best[1]
    for kind in ("sprite", "concept", "cg"):  # 우선순위: 스프라이트 기본 포즈 → 시안 → CG
        if kind in newest:
            return thumb_url(newest[kind]), counts
    return None, counts


def file_path_for(rel):
    """/files/ 용: output 아래 파일 (숨김/경로 탈출 차단)"""
    p = safe_path(OUTPUT_DIR, rel)
    if not p.is_file():
        raise ApiError(404, "파일을 찾을 수 없습니다")
    return p

