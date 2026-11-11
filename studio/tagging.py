"""프롬프트 추출 (이미지·3D 캡처 → Danbooru 태그). vnlib.tagger 를 비동기로 감싼다.

- 추론은 asyncio.to_thread + 전역 asyncio.Lock (한 번에 하나).
- 마지막 사용 후 IDLE_UNLOAD 초(15분)가 지나면 모델을 내려 메모리(≈1.5GB)를 돌려준다.
- 업로드 파일은 디스크에 저장하지 않는다(메모리에서 처리).
"""
import asyncio
import time

from aiohttp import BodyPartReader

from vnlib import config, tagger

from .common import OUTPUT_DIR, ApiError, log, read_json, safe_path

IDLE_UNLOAD = 15 * 60
MAX_UPLOAD = 20 * 1024 * 1024      # 이미지 파일 최대 20MB
MAX_BODY = MAX_UPLOAD + 1024 * 1024  # multipart 본문 전체 (경계·다른 필드 여유분)
MAX_FIELD = 4096                   # model/source 같은 짧은 필드
SOURCES = ("image", "3d")
CHUNK = 256 * 1024

TOO_LARGE = f"이미지 파일이 너무 큽니다 (최대 {MAX_UPLOAD // (1024 * 1024)}MB). 더 작은 이미지로 다시 시도하세요."
HTTP_STATUS = {"unavailable": 503, "not_found": 400, "image": 400, "error": 500}


def _api_error(e: tagger.TaggerError):
    status = HTTP_STATUS.get(e.kind, 500)
    extra = {"reason": e.kind}
    if status == 503:
        extra["help"] = "extract"  # 도움말 › 프롬프트 추출
    return ApiError(status, str(e), **extra)


class Tagging:
    def __init__(self, idle_unload=IDLE_UNLOAD):
        self.idle_unload = idle_unload
        self.lock = asyncio.Lock()
        self.last_used = 0.0
        self._timer = None
        self._unload_task = None
        self._runtime_error = None
        self._runtime_checked = False

    # ------------------------------------------------------------------ 상태
    async def runtime_error(self):
        if not self._runtime_checked:  # onnxruntime import는 처음 한 번 수백 ms 걸릴 수 있음
            self._runtime_error = await asyncio.to_thread(tagger.runtime_error)
            self._runtime_checked = True
        return self._runtime_error

    async def info(self):
        """GET /api/tagger"""
        settings = config.load_settings()
        models = await asyncio.to_thread(tagger.list_models)
        err = await self.runtime_error()
        names = [m["name"] for m in models]
        configured = settings.get("tagger_model")
        loaded = tagger.loaded()
        res = {
            "models": [{"name": m["name"], "size": m["size"]} for m in models],
            "default": next((n for n in (configured, tagger.DEFAULT_MODEL) if n in names), names[0] if names else None),
            "configured": configured,
            "loaded": loaded[0] if loaded else None,
            "available": err is None,
            "threshold": settings.get("tagger_threshold", 0.35),
            "char_threshold": settings.get("tagger_char_threshold", 0.85),
            "groups": tagger.group_list(),
        }
        if err:
            res["error"] = err
        elif not names:
            res["error"] = tagger.no_model_message()
        return res

    # ------------------------------------------------------------------ 요청 해석
    async def parse_request(self, request):
        """→ (data: bytes|None, path: Path|None, rel: str|None, name: str, model: str|None, source: str)"""
        ctype = (request.content_type or "").lower()
        if ctype.startswith("multipart/"):
            return await self._parse_multipart(request)
        if ctype.startswith(("image/", "video/", "application/octet-stream")) and request.body_exists:
            raise ApiError(415, "이미지는 multipart/form-data 의 image 필드로 보내세요 (또는 JSON {\"path\": …})")
        # JSON {path, model?, source?} — 갤러리(output/) 이미지
        if request.content_length is not None and request.content_length > 1024 * 1024:
            raise ApiError(413, "요청 본문이 너무 큽니다. 이미지는 multipart/form-data 의 image 필드로 보내세요.")
        try:
            body = await read_json(request)
        except ApiError:
            if ctype == "application/x-www-form-urlencoded":
                raise ApiError(400, "이미지 파일은 multipart/form-data 의 image 필드로, 갤러리 이미지는 "
                                    "JSON {\"path\": …} (Content-Type: application/json)로 보내세요") from None
            raise
        rel = body.get("path")
        if not isinstance(rel, str) or not rel.strip():
            raise ApiError(400, "path 값(output/ 기준 이미지 경로)이 필요합니다. 파일을 올리려면 multipart/form-data 의 "
                                "image 필드를 쓰세요.")
        rel = rel.strip()
        p = safe_path(OUTPUT_DIR, rel)
        if not p.is_file():
            raise ApiError(404, "파일을 찾을 수 없습니다")
        return None, p, rel, p.name, self._model_arg(body.get("model")), self._source_arg(body.get("source"))

    async def _parse_multipart(self, request):
        if request.content_length is not None and request.content_length > MAX_BODY:
            raise ApiError(413, TOO_LARGE)
        try:
            reader = await request.multipart()
        except (ValueError, AssertionError, KeyError):
            raise ApiError(400, "업로드 형식(multipart/form-data)이 올바르지 않습니다") from None
        data, filename, fields, total = None, "", {}, 0
        try:
            while True:
                part = await reader.next()
                if part is None:
                    break
                if not isinstance(part, BodyPartReader):  # 중첩 multipart는 받지 않음
                    raise ApiError(400, "업로드 형식(multipart/form-data)이 올바르지 않습니다")
                name = part.name or ""
                limit = MAX_UPLOAD if name == "image" and data is None else MAX_FIELD
                buf = bytearray()
                while True:
                    chunk = await part.read_chunk(CHUNK)
                    if not chunk:
                        break
                    buf += chunk
                    total += len(chunk)
                    if len(buf) > limit or total > MAX_BODY:
                        if name == "image":
                            raise ApiError(413, TOO_LARGE)
                        raise ApiError(413, f"'{name}' 필드가 너무 깁니다")
                if name == "image" and data is None:
                    data, filename = bytes(buf), part.filename or "image"
                elif name in ("model", "source"):
                    fields[name] = buf.decode("utf-8", "replace").strip()
        except ApiError:
            raise
        except (ValueError, AssertionError, UnicodeError):
            raise ApiError(400, "업로드 형식(multipart/form-data)이 올바르지 않습니다") from None
        if data is None:
            raise ApiError(400, "image 필드에 이미지 파일을 넣어 보내세요")
        if not data:
            raise ApiError(400, "빈 파일입니다. 이미지 파일을 다시 선택하세요.")
        return (data, None, None, filename, self._model_arg(fields.get("model") or None),
                self._source_arg(fields.get("source") or None))

    @staticmethod
    def _model_arg(v):
        if v in (None, ""):
            return None
        if not isinstance(v, str) or len(v) > 200:
            raise ApiError(400, "model 값이 올바르지 않습니다")
        return v

    @staticmethod
    def _source_arg(v):
        if v in (None, ""):
            return "image"
        if v not in SOURCES:
            raise ApiError(400, "source 값은 image 또는 3d 여야 합니다")
        return v

    # ------------------------------------------------------------------ 추론
    def _resolve_model(self, requested):
        if requested:
            return requested  # 없으면 tagger.get 이 not_found(400) 로 알려 줌
        name = tagger.default_name(config.load_settings().get("tagger_model"))
        if name is None:
            raise tagger.TaggerError(tagger.no_model_message(), "unavailable")
        return name

    async def interrogate(self, request):
        """POST /api/interrogate"""
        data, path, rel, name, model, source = await self.parse_request(request)
        err = await self.runtime_error()
        if err:
            raise ApiError(503, err, reason="unavailable", help="extract")
        try:
            model = self._resolve_model(model)
            async with self.lock:
                t0 = time.time()
                cold = model not in tagger.loaded()
                try:
                    res = await asyncio.to_thread(self._run, model, data if data is not None else path)
                finally:
                    self._touch()
                elapsed = time.time() - t0
        except tagger.TaggerError as e:
            if e.kind in ("unavailable", "error"):
                log.warning("프롬프트 추출 실패 (%s): %s", e.kind, e)
            raise _api_error(e) from None
        out = {"model": model, "elapsed": round(elapsed, 3), "cold": cold, "size": res["size"], "source": source,
               "name": name, "rating": res["rating"], "tags": res["tags"], "groups": tagger.group_list()}
        if rel is not None:
            out["path"] = rel
        log.info("프롬프트 추출: %s (%s, %d×%d) → 태그 %d개, %.2f초%s", name, source, res["size"][0], res["size"][1],
                 len(res["tags"]), elapsed, " (모델 불러옴)" if cold else "")
        return out

    @staticmethod
    def _run(model, src):
        im = tagger.open_image(src)  # 못 읽는 이미지는 모델(1.26GB)을 불러오기 전에 400
        try:
            return tagger.get(model).predict(im)
        finally:
            im.close()

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
        async with self.lock:  # 추론 중이면 끝날 때까지 기다림
            loop = asyncio.get_running_loop()
            if self._timer is not None or loop.time() - self.last_used < self.idle_unload - 1:
                return  # 그 사이에 다시 쓰였음 (새 타이머가 걸려 있음)
            names = await asyncio.to_thread(tagger.unload_all)
            if names:
                log.info("프롬프트 추출 모델을 %d분 동안 쓰지 않아 메모리에서 내렸습니다: %s",
                         round(self.idle_unload / 60), ", ".join(names))

    async def close(self):
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None
        if self._unload_task is not None:
            self._unload_task.cancel()
            await asyncio.gather(self._unload_task, return_exceptions=True)
        await asyncio.to_thread(tagger.unload_all)
