"""포즈 따라 그리기 — 포즈 라이브러리(input/poses/)와 감지 API. vnlib.pose 를 비동기로 감싼다 (STUDIO_SPEC §9.7).

- 감지는 asyncio.to_thread + 전역 asyncio.Lock (한 번에 하나). 마지막 사용 후 IDLE_UNLOAD 초(15분)가 지나면
  감지 모델(≈0.5GB)을 내린다. 맵 그리기(3D 키포인트 저장)는 모델이 필요 없다.
- 업로드 파일은 검증·재인코딩 후 포즈 폴더에만 저장한다 (원본 그대로 디스크에 남기지 않음).
"""
import asyncio
import json
import time
from urllib.parse import quote

from aiohttp import BodyPartReader

from vnlib import pose

from .common import OUTPUT_DIR, ApiError, log, read_json, safe_path, to_bool, to_number

IDLE_UNLOAD = 15 * 60
MAX_UPLOAD = 20 * 1024 * 1024        # 파일 하나 최대 20MB (§8 interrogate와 같음)
MAX_BODY = 2 * MAX_UPLOAD + 2 * 1024 * 1024  # multipart 전체 (src + pose 그림 + 필드)
MAX_KEYPOINTS = 1024 * 1024           # keypoints JSON 문자열
MAX_FIELD = 4096
CHUNK = 256 * 1024
FILE_FIELDS = ("image", "pose", "src")
TEXT_FIELDS = ("keypoints", "width", "height", "origin", "view", "framing", "clip", "hands", "all_people", "source")
SOURCES_KP = ("3d", "image")

TOO_LARGE = f"파일이 너무 큽니다 (최대 {MAX_UPLOAD // (1024 * 1024)}MB). 더 작은 이미지로 다시 시도하세요."
HTTP_STATUS = {"unavailable": 503, "not_found": 404, "image": 400, "invalid": 400, "no_person": 422, "error": 500}


def _api_error(e: pose.PoseError):
    status = HTTP_STATUS.get(e.kind, 500)
    extra = {"reason": e.kind}
    if status == 503:
        extra["help"] = "pose"  # 도움말 › 포즈 따라 그리기
    return ApiError(status, str(e), **extra)


def pose_url(name, variant=""):
    return "/poses/" + quote(name, safe="") + (f"/{variant}" if variant else "")


def public_item(meta, keypoints=False):
    """vnlib 메타 → API 항목"""
    name = meta["name"]
    w, h = meta.get("width"), meta.get("height")
    has_src = meta["has_src"] if "has_src" in meta else _exists(name, "src")
    has_thick = meta["has_thick"] if "has_thick" in meta else _exists(name, "thick")
    item = {
        "name": name, "width": w, "height": h, "source": meta.get("source") or "upload",
        "origin": meta.get("origin") or "", "created": meta.get("created"),
        "url": pose_url(name), "thumb": pose_url(name),
        "src_url": pose_url(name, "src") if has_src else None,
        "people": meta.get("people"), "hands": bool(meta.get("hands")), "has_thick": bool(has_thick),
        "gen_size": list(pose.gen_size(w, h)) if w and h else None,  # 이 포즈로 생성할 때 쓰는 기본 크기
        "size": meta.get("size"),
    }
    for key in ("view", "framing", "clip", "cropped", "detected"):
        if meta.get(key) is not None:
            item[key] = meta[key]
    if keypoints:
        item["keypoints"] = meta.get("keypoints")
    return item


def _exists(name, variant):
    return (pose.POSE_DIR / (pose.stem_of(name) + pose.VARIANT_SUFFIX[variant])).is_file()


def _job_pose_name(job):
    """작업이 쓰는 포즈 이름 (실제 적용값 job.pose → 입력 spec.pose 순) | None"""
    for p in ((job or {}).get("pose"), ((job or {}).get("spec") or {}).get("pose")):
        n = p.get("name") if isinstance(p, dict) else p
        if isinstance(n, str) and n:
            try:
                return pose.normalize_name(n)
            except pose.PoseError:
                return None
    return None


def _name_arg(name):
    try:
        return pose.normalize_name(name)
    except pose.PoseError as e:
        raise ApiError(400, str(e)) from None


class Poses:
    def __init__(self, idle_unload=IDLE_UNLOAD):
        self.idle_unload = idle_unload
        self.lock = asyncio.Lock()
        self.last_used = 0.0
        self._timer = None
        self._unload_task = None

    # ------------------------------------------------------------------ 조회
    async def list(self):
        """GET /api/poses"""
        try:
            metas = await asyncio.to_thread(pose.list_poses)
        except pose.PoseError as e:
            raise _api_error(e) from None
        err = await asyncio.to_thread(pose.detect_error)
        res = {"poses": [public_item(m) for m in metas], "dir": str(pose.POSE_DIR),
               "detect_available": err is None, "loaded": pose.loaded()}
        if err:
            res["detect_error"] = err
        return res

    async def get(self, name):
        """GET /api/poses/{name} — 키포인트 포함"""
        n = _name_arg(name)
        try:
            meta = await asyncio.to_thread(pose.load_meta, n)
        except pose.PoseError as e:
            raise _api_error(e) from None
        return public_item(meta, keypoints=True)

    def file(self, name, variant="standard"):
        """GET /poses/{name}(/src) — 경로 탈출·심볼릭 링크 차단. name 은 포즈 이름 또는 '<stem>.thick.png'"""
        if variant == "standard" and isinstance(name, str) and name.endswith(".thick.png"):
            name, variant = name[:-len(".thick.png")] + ".png", "thick"
        n = _name_arg(name)
        fname = pose.stem_of(n) + pose.VARIANT_SUFFIX[variant]
        if not pose.POSE_DIR.is_dir():
            raise ApiError(404, "포즈 파일을 찾을 수 없습니다")
        p = safe_path(pose.POSE_DIR, fname)
        if not p.is_file():
            raise ApiError(404, "포즈 파일을 찾을 수 없습니다")
        return p

    async def delete(self, name, active_jobs=()):
        """DELETE /api/poses/{name} → user/trash/poses/

        active_jobs: 대기 중·진행 중 작업(job dict). ComfyUI는 포즈 파일을 제출 때 한 번 확인하고 실행할 때 다시 읽으므로,
        이 포즈를 쓰는 작업이 남아 있으면 지우지 않는다(409) — 지우면 그 작업들이 '포즈 불러오기' 단계에서 실패한다.
        """
        n = _name_arg(name)
        busy = sum(1 for j in active_jobs if _job_pose_name(j) == n)
        if busy:
            raise ApiError(409, f"대기 중이거나 진행 중인 작업 {busy}개가 이 포즈를 쓰고 있습니다. "
                                "작업이 끝난 뒤(또는 작업을 취소한 뒤) 삭제하세요.", reason="in_use")
        try:
            moved = await asyncio.to_thread(pose.delete_pose, n)
        except pose.PoseError as e:
            raise _api_error(e) from None
        log.info("포즈 삭제(휴지통): %s", n)
        return {"ok": True, "name": n, "moved": moved, "trash": str(pose.TRASH_DIR)}

    # ------------------------------------------------------------------ 요청 해석
    async def _read_multipart(self, request):
        """→ (files {name: (bytes, filename)}, fields {name: str}) — 스트리밍으로 크기 검사"""
        if request.content_length is not None and request.content_length > MAX_BODY:
            raise ApiError(413, TOO_LARGE)
        try:
            reader = await request.multipart()
        except (ValueError, AssertionError, KeyError):
            raise ApiError(400, "업로드 형식(multipart/form-data)이 올바르지 않습니다") from None
        files, fields, total = {}, {}, 0
        try:
            while True:
                part = await reader.next()
                if part is None:
                    break
                if not isinstance(part, BodyPartReader):
                    raise ApiError(400, "업로드 형식(multipart/form-data)이 올바르지 않습니다")
                name = part.name or ""
                if name in FILE_FIELDS and name not in files:
                    limit = MAX_UPLOAD
                elif name == "keypoints":
                    limit = MAX_KEYPOINTS
                else:
                    limit = MAX_FIELD
                buf = bytearray()
                while True:
                    chunk = await part.read_chunk(CHUNK)
                    if not chunk:
                        break
                    buf += chunk
                    total += len(chunk)
                    if len(buf) > limit or total > MAX_BODY:
                        if name in FILE_FIELDS:
                            raise ApiError(413, TOO_LARGE)
                        raise ApiError(413, f"'{name}' 필드가 너무 깁니다")
                if name in FILE_FIELDS and name not in files:
                    files[name] = (bytes(buf), part.filename or name)
                elif name in TEXT_FIELDS:
                    fields[name] = buf.decode("utf-8", "replace").strip()
        except ApiError:
            raise
        except (ValueError, AssertionError, UnicodeError):
            raise ApiError(400, "업로드 형식(multipart/form-data)이 올바르지 않습니다") from None
        return files, fields

    async def _read_body(self, request):
        """multipart 또는 JSON → (files, fields(dict, JSON 값 그대로))"""
        ctype = (request.content_type or "").lower()
        if ctype.startswith("multipart/"):
            return await self._read_multipart(request)
        if ctype.startswith(("image/", "video/", "application/octet-stream")) and request.body_exists:
            raise ApiError(415, "이미지는 multipart/form-data 의 image(또는 pose) 필드로 보내세요")
        if request.content_length is not None and request.content_length > 2 * 1024 * 1024:
            raise ApiError(413, "요청 본문이 너무 큽니다. 이미지는 multipart/form-data 로 보내세요.")
        return {}, await read_json(request)

    @staticmethod
    def _size_args(fields, required):
        w, h = fields.get("width"), fields.get("height")
        if w in (None, "") and h in (None, ""):
            if required:
                raise ApiError(400, "포즈 크기(width, height)가 필요합니다")
            return None, None
        if w in (None, "") or h in (None, ""):
            raise ApiError(400, "포즈 크기는 가로(width)와 세로(height)를 함께 보내세요")
        return (to_number(w, "포즈 가로 크기", pose.MIN_SIDE, pose.MAX_SIDE, int),
                to_number(h, "포즈 세로 크기", pose.MIN_SIDE, pose.MAX_SIDE, int))

    @staticmethod
    def _text(fields, key, limit=200):
        v = fields.get(key)
        if v in (None, ""):
            return None
        if not isinstance(v, str):
            raise ApiError(400, f"{key} 값은 문자열이어야 합니다")
        return v.strip()[:limit] or None

    # ------------------------------------------------------------------ 저장 (3D 키포인트 / 업로드)
    async def create(self, request):
        """POST /api/poses — ① 3D: keypoints(JSON)+width+height(+src 렌더) ② 업로드: pose(OpenPose 그림)"""
        files, fields = await self._read_body(request)
        src = files.get("src")
        if src is not None and not src[0]:
            src = None
        meta = {"origin": self._text(fields, "origin"), "view": self._text(fields, "view", 40),
                "framing": self._text(fields, "framing", 40), "clip": self._text(fields, "clip")}
        if "pose" in files:
            data, filename = files["pose"]
            if not data:
                raise ApiError(400, "빈 파일입니다. 포즈 그림 파일을 다시 선택하세요.")
            meta.update(source="upload", origin=meta["origin"] or filename)
            fn, args = self._save_upload, (meta, data, src[0] if src else None)
        elif fields.get("keypoints") not in (None, ""):
            kp = fields["keypoints"]
            if isinstance(kp, str):
                try:
                    kp = json.loads(kp)
                except ValueError:
                    raise ApiError(400, "keypoints 값이 올바른 JSON이 아닙니다") from None
            W, H = self._size_args(fields, required=True)
            source = self._text(fields, "source", 20) or "3d"
            if source not in SOURCES_KP:
                raise ApiError(400, "source 값은 3d 또는 image 여야 합니다")
            hands = True if fields.get("hands") in (None, "") else to_bool(fields["hands"], "hands")
            meta.update(source=source, width=W, height=H, hands=hands)
            fn, args = pose.save_pose, (meta, kp, None, src[0] if src else None)
        else:
            raise ApiError(400, "keypoints(3D 포즈 키포인트 JSON)와 width·height, 또는 pose(OpenPose 그림 파일) 중 하나를 보내세요")
        try:
            saved = await asyncio.to_thread(fn, *args)
        except pose.PoseError as e:
            raise _api_error(e) from None
        log.info("포즈 저장: %s (%s, %s×%s, %s)", saved["name"], saved["source"], saved["width"], saved["height"],
                 saved.get("origin") or "")
        return public_item(dict(saved, has_thick=saved.get("keypoints") is not None))

    @staticmethod
    def _save_upload(meta, data, src_bytes):
        """이미 그려진 OpenPose 그림: 512~2048 밖이면 비율을 지켜 맞춘 뒤 PNG로 저장"""
        from PIL import Image
        im = pose.read_map_image(data)
        w, h = im.size
        if not (pose.MIN_SIDE <= w <= pose.MAX_SIDE and pose.MIN_SIDE <= h <= pose.MAX_SIDE):
            W, H = pose.fit_size(w, h)
            im = im.resize((W, H), Image.Resampling.LANCZOS)
        return pose.save_pose(dict(meta, width=im.width, height=im.height), map_png=pose.encode_png(im),
                              src_bytes=src_bytes)

    # ------------------------------------------------------------------ 감지
    async def detect(self, request):
        """POST /api/poses/detect — multipart image 또는 JSON {path}(output/ 기준) → 감지 → 저장.
        선택 view·framing·clip·source(image 기본|3d): 3D 렌더에서 감지한 포즈의 메타 (POST /api/poses와 같음)"""
        files, fields = await self._read_body(request)
        if "image" in files:
            data, origin = files["image"]
            if not data:
                raise ApiError(400, "빈 파일입니다. 이미지 파일을 다시 선택하세요.")
            src, rel = data, None
        else:
            rel = fields.get("path")
            if not isinstance(rel, str) or not rel.strip():
                raise ApiError(400, "image 필드(이미지 파일) 또는 path 값(output/ 기준 이미지 경로)이 필요합니다")
            rel = rel.strip()
            p = safe_path(OUTPUT_DIR, rel)
            if not p.is_file():
                raise ApiError(404, "파일을 찾을 수 없습니다")
            src, origin = p, p.name
        W, H = self._size_args(fields, required=False)
        all_people = False if fields.get("all_people") in (None, "") else to_bool(fields["all_people"], "all_people")
        hands = True if fields.get("hands") in (None, "") else to_bool(fields["hands"], "hands")
        origin = self._text(fields, "origin") or origin
        # 3D 모델 렌더에서 감지할 때(뼈대 매핑 실패) 각도·프레이밍·동작을 같이 저장 — POST /api/poses와 같은 필드
        source = self._text(fields, "source", 20) or "image"
        if source not in SOURCES_KP:
            raise ApiError(400, "source 값은 3d 또는 image 여야 합니다")
        extra = {"source": source, "view": self._text(fields, "view", 40), "framing": self._text(fields, "framing", 40),
                 "clip": self._text(fields, "clip")}
        err = await asyncio.to_thread(pose.detect_error)
        if err:
            raise ApiError(503, err, reason="unavailable", help="pose")
        try:
            async with self.lock:
                t0 = time.time()
                cold = not pose.loaded()
                try:
                    saved, res = await asyncio.to_thread(self._detect_run, src, W, H, hands, all_people, origin, extra)
                finally:
                    self._touch()
                elapsed = time.time() - t0
        except pose.PoseError as e:
            if e.kind in ("unavailable", "error"):
                log.warning("포즈 감지 실패 (%s): %s", e.kind, e)
            raise _api_error(e) from None
        log.info("포즈 감지: %s → %s (%d×%d, %d명/감지 %d명%s%s), %.2f초%s", origin, saved["name"], res["size"][0],
                 res["size"][1], res["people"], res["detected"], ", 가운데 자름" if res["cropped"] else "",
                 f", 상자 {res.get('box')}" if res.get("box") not in (None, "detector") else "", elapsed,
                 " (모델 불러옴)" if cold else "")
        item = public_item(dict(saved, has_thick=True))
        item.update(people=res["people"], cropped=res["cropped"], detected=res["detected"],
                    elapsed=round(elapsed, 3), cold=cold)
        if rel is not None:
            item["path"] = rel
        return item

    @staticmethod
    def _detect_run(src, W, H, hands, all_people, origin, extra=None):
        im = pose.open_image(src)  # 못 읽는 이미지는 모델을 불러오기 전에 400
        try:
            res = pose.detect(im, W, H, hands=hands, all_people=all_people)
            preview = pose.preview_jpeg(im, *res["size"])  # 맵과 같은 영역·비율 (겹쳐 보기용)
        finally:
            im.close()
        meta = {"source": "image", **{k: v for k, v in (extra or {}).items() if v}}
        meta.update(origin=origin, width=res["size"][0], height=res["size"][1], hands=hands, cropped=res["cropped"],
                    detected=res["detected"])
        saved = pose.save_pose(meta, keypoints=res["keypoints"], src_bytes=preview)
        return saved, res

    # ------------------------------------------------------------------ 유휴 언로드
    def _touch(self):
        loop = asyncio.get_running_loop()
        self.last_used = loop.time()
        if self._timer is not None:
            self._timer.cancel()
        self._timer = loop.call_later(self.idle_unload, self._idle_fire)

    def _idle_fire(self):
        self._timer = None
        if self._unload_task is None or self._unload_task.done():
            self._unload_task = asyncio.create_task(self._unload_idle())

    async def _unload_idle(self):
        async with self.lock:  # 감지 중이면 끝날 때까지 기다림
            loop = asyncio.get_running_loop()
            if self._timer is not None or loop.time() - self.last_used < self.idle_unload - 1:
                return
            if await asyncio.to_thread(pose.unload):
                log.info("포즈 감지 모델을 %d분 동안 쓰지 않아 메모리에서 내렸습니다", round(self.idle_unload / 60))

    async def close(self):
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None
        if self._unload_task is not None:
            self._unload_task.cancel()
            await asyncio.gather(self._unload_task, return_exceptions=True)
        await asyncio.to_thread(pose.unload)
