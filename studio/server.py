#!/usr/bin/env python3
"""VN Studio 백엔드 서버 (aiohttp, 127.0.0.1 전용).

실행:
  /Volumes/T7/VN-Pipeline/ComfyUI/Installs/ComfyUI/standalone-env/bin/python studio/server.py [--port 8190] [--no-autostart] [--app]

구성:
  server.py      라우트·미들웨어·앱 수명주기
  comfy_link.py  ComfyUI HTTP/웹소켓/프로세스 관리
  jobs.py        작업 큐·진행 추적·sqlite 저장
  gallery.py     output/ 스캔·메타데이터·썸네일
  library.py     모델/프리셋/LoRA 메모/설정
  downloads.py   URL 다운로드
  chars_api.py   캐릭터 CRUD
  tagging.py     프롬프트 추출 (이미지·3D 캡처 → Danbooru 태그)
  poses.py       포즈 따라 그리기 (포즈 라이브러리·감지, ControlNet OpenPose)
  secret.py      시크릿 모드 (끄거나 종료하면 그동안의 작업 기록·그림 삭제)
  remote.py      원격 접속 (Tailscale Serve 경유 요청 판별, tailscale 상태, 원격 설정)
  events.py      SSE 허브
"""
import argparse
import asyncio
import logging
import os
import signal
import sys
import time
from pathlib import Path

# 스크립트로 실행될 때도 패키지(studio.*)로 import 되도록 경로 정리
_HERE = Path(__file__).resolve().parent
if sys.path and Path(sys.path[0] or ".").resolve() == _HERE:
    sys.path.pop(0)
if str(_HERE.parent) not in sys.path:
    sys.path.insert(0, str(_HERE.parent))

from aiohttp import web  # noqa: E402

from studio import chars_api  # noqa: E402
from studio import remote  # noqa: E402
from studio.secret import Secret  # noqa: E402
from studio.comfy_link import ComfyLink  # noqa: E402
from studio.common import (  # noqa: E402
    COMFY_LOG, DATA_DIR, OUTPUT_DIR, ROOT, THUMB_DIR, VERSION, WEB_DIR, ApiError, config, json_error,
    dumps, json_response, log, read_json, safe_path)
from studio.downloads import DownloadManager  # noqa: E402
from studio.events import EventHub, encode_event  # noqa: E402
from studio.gallery import Gallery, file_path_for  # noqa: E402
from studio.jobs import JobManager  # noqa: E402
from studio.library import Library  # noqa: E402
from studio.poses import Poses  # noqa: E402
from studio.tagging import Tagging  # noqa: E402
from vnlib import pose as poselib  # noqa: E402

MUTATING = ("POST", "PUT", "DELETE", "PATCH")
STATIC_TYPES = {
    ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8",
    ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml", ".png": "image/png",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon",
    ".woff2": "font/woff2", ".woff": "font/woff", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8",
}
HTTP_MESSAGES = {
    400: "잘못된 요청입니다", 403: "접근이 거부되었습니다", 404: "요청한 주소를 찾을 수 없습니다",
    405: "허용되지 않는 요청 방식입니다", 413: "요청 본문이 너무 큽니다", 415: "지원하지 않는 형식입니다",
}
OPEN_TARGETS = {
    "output": lambda: OUTPUT_DIR,
    "models_checkpoints": lambda: config.MODEL_ROOTS[0] / "checkpoints",
    "models_loras": lambda: config.MODEL_ROOTS[0] / "loras",
    "models_upscale": lambda: config.MODEL_ROOTS[0] / "upscale_models",
    "models_controlnet": lambda: config.MODEL_ROOTS[0] / "controlnet",
    "poses": lambda: poselib.POSE_DIR,
    "models": lambda: config.MODEL_ROOTS[0],
    "characters": lambda: config.CHAR_DIR,
    "config": lambda: config.CONFIG_DIR,
    "root": lambda: ROOT,
    "trash": lambda: OUTPUT_DIR / ".trash",
    "logs": lambda: config.USER_DIR,
}
PLACEHOLDER = """<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>VN Studio</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",sans-serif;background:#16171d;color:#e7e7ef;
display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:520px;padding:32px;line-height:1.6}
h1{font-size:22px;margin:0 0 12px}code{background:#2a2b35;padding:2px 6px;border-radius:4px}a{color:#9db4ff}</style></head>
<body><main><h1>VN Studio 서버가 실행 중입니다</h1>
<p>화면 파일(<code>studio/web/index.html</code>)을 아직 찾을 수 없습니다. 설치가 끝나면 이 페이지를 새로고침하세요.</p>
<p>서버 상태: <a href="/api/status">/api/status</a></p></main></body></html>"""


# ====================================================================== 앱 상태
class Studio:
    def __init__(self, port, autostart=True, app_session=False):
        self.port = port
        self.autostart = autostart
        settings = config.load_settings()
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        THUMB_DIR.mkdir(parents=True, exist_ok=True)
        self.hub = EventHub()
        self.comfy = ComfyLink(self.hub, settings.get("comfy_url"))
        self.jobs = JobManager(self.hub, self.comfy)
        self.downloads = DownloadManager(self.hub, on_change=self.poke)
        self.gallery = Gallery(self.jobs.store)
        self.library = Library(self.comfy)
        self.tagging = Tagging()
        self.poses = Poses()
        self.remote = remote.Remote(port, app_session)
        self.secret = Secret(self.jobs, self.gallery, self.comfy, on_change=self.poke)
        self.comfy.on_change = self.poke
        self.tasks = []
        self.stop_event = asyncio.Event()
        self._last_sig = None
        self._last_sent = 0.0

    def status(self):
        return {
            "studio": {"version": VERSION, "port": self.port, "pid": os.getpid()},
            "comfy": self.comfy.payload(),
            "downloads": self.downloads.running_count(),
            "jobs": {"active": len(self.jobs.active), "current": self.jobs.running_summary()},
            "remote": self.remote.brief(),
            "secret": self.secret.brief(),  # {enabled, since, purging}  # {enabled, url|null} — 요청별 client 는 /api/status·SSE 핸들러가 붙인다
            # 깨진 설정 파일을 기본값으로 다시 만든 기록 (원본은 .broken-날짜 로 보관)
            "config_warnings": [w.get("message") or f"{w.get('file')} 파일이 손상되어 기본값으로 다시 만들었습니다"
                                for w in config.RECOVERED],
        }

    def poke(self):
        """상태가 바뀌었을 수 있음 → status 이벤트 즉시 점검"""
        try:
            self._maybe_publish_status()
        except Exception:
            log.exception("상태 이벤트 실패")

    def _maybe_publish_status(self, force=False):
        st = self.status()
        c = st["comfy"]
        sig = (c["running"], c["managed"], c["starting"], c["version"], c["queue_running"],
               c["queue_pending"], c["error"], c["ws"], st["downloads"], st["jobs"]["active"],
               st["remote"]["enabled"], st["remote"]["url"], st["secret"]["enabled"], st["secret"]["purging"])
        now = time.time()
        if force or sig != self._last_sig or now - self._last_sent >= 10:
            self._last_sig, self._last_sent = sig, now
            self.hub.publish("status", st)

    async def status_loop(self):
        while True:
            try:
                await self.comfy.refresh()
                await self.jobs.reconcile()
                self._maybe_publish_status()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("상태 점검 실패")
            await self.comfy.wait_wake(2.0)

    async def startup(self):
        await self.comfy.open()
        log.info("실행 방식: %s", "VN Studio 앱 (원격 접속 가능)" if self.remote.app_session
                 else "앱 아님 (원격 접속 받지 않음)")
        self.tasks = [asyncio.create_task(c) for c in
                      (self.comfy.ws_loop(), self.comfy.log_tail_loop(), self._boot(),
                       self.remote.session_start())]  # 앱 세션이면 Serve 붙이기, 아니면 남은 Serve 걷기

    async def _boot(self):
        """서버가 요청을 받기 시작한 뒤에 실행: 작업 복구 → (필요시) ComfyUI 자동 시작 → 상태 감시"""
        try:
            await self.comfy.refresh(stats=True)
            await self.jobs.recover()
        except Exception:
            log.exception("작업 복구 실패")
        try:  # 지난번에 지우지 못한 시크릿 기록 (비정상 종료 등)
            await self.secret.cleanup("지난 실행에서 남은 기록")
        except Exception:
            log.exception("시크릿 기록 정리 실패")
        if self.autostart and config.load_settings().get("autostart_comfy", True):
            try:
                if not self.comfy.running and not await self.comfy.port_open():
                    log.info("ComfyUI가 꺼져 있어 자동으로 시작합니다")
                    await self.comfy.start()
            except Exception:
                log.exception("ComfyUI 자동 시작 실패")
        await self.status_loop()

    async def shutdown(self):
        self.hub.close_all()
        for t in self.tasks:
            t.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        try:  # 시크릿 모드였으면 그동안의 기록 삭제 (DB를 닫기 전에)
            await asyncio.wait_for(self.secret.cleanup("Studio 종료"), 20)
        except Exception:
            log.exception("종료 중 시크릿 기록 삭제 실패 (다음 시작 때 다시 지웁니다)")
        await self.downloads.close()
        await self.tagging.close()
        await self.poses.close()
        await self.remote.session_end()  # 앱 세션이면 Serve 떼기 (테일넷 443 닫기)
        await self.remote.close()
        await self.jobs.close()
        await self.comfy.close()
        try:  # 엔진이 끝나기 직전에 쓴 시크릿 그림까지
            await asyncio.to_thread(self.secret.purge_files)
        except Exception:
            pass


# ====================================================================== 미들웨어
def make_middlewares(port):
    @web.middleware
    async def errors(request, handler):
        try:
            return await handler(request)
        except config.ConfigError as e:
            log.error("설정 파일 오류: %s", e)
            return json_error(500, str(e))
        except ApiError as e:
            if e.status >= 500:
                log.warning("%s %s → %s %s", request.method, request.path, e.status, e.message)
            return json_error(e.status, e.message, **e.extra)
        except web.HTTPException as e:
            if e.status < 400:
                raise
            return json_error(e.status, HTTP_MESSAGES.get(e.status, e.reason or "오류가 발생했습니다"))
        except (asyncio.CancelledError, ConnectionResetError):
            raise
        except Exception as e:
            log.exception("처리 중 예외: %s %s", request.method, request.path)
            return json_error(500, f"서버 내부 오류가 발생했습니다: {e.__class__.__name__}: {e}"[:500])

    @web.middleware
    async def guard(request, handler):
        client = None
        try:
            # 로컬(127.0.0.1/localhost:port)은 기존 규칙 그대로. Tailscale Serve 경유(원격)는 원격 허용·주소·신원·허용 로그인 확인.
            # 모르는 Host 는 거부 (DNS 리바인딩 방지)
            client = remote.identify(request, port, request.app["studio"].remote.app_session)
            if client["remote"]:
                reason = remote.local_only_reason(request)
                if reason:  # 종료·Finder 열기·원격 설정 변경은 Mac에서만
                    raise remote.Denied("local_only", reason)
            # CSRF 방지: 상태를 바꾸는 요청은 같은 출처만 (Origin 이 있을 때)
            if request.method in MUTATING:
                remote.check_origin(request, client, port)
        except remote.Denied as e:
            if e.code != "host":
                log.info("원격 요청 거부(%s): %s %s host=%s login=%s ip=%s", e.code, request.method, request.path,
                         request.host, (client or {}).get("login") or request.headers.get("Tailscale-User-Login"),
                         request.headers.get("X-Forwarded-For"))
            return remote.deny_response(request, e)
        request["client"] = client
        if request.method in MUTATING:
            if client["remote"]:
                log.info("%s %s (원격: %s, %s)", request.method, request.path, client["login"], client["ip"])
            else:
                log.info("%s %s", request.method, request.path)
        return await handler(request)

    return [errors, guard]


# ====================================================================== 라우트
def setup_routes(app, s: Studio):
    r = app.router

    # ---------------------------------------------------------------- 정적
    async def index(request):
        p = WEB_DIR / "index.html"
        if p.is_file():
            return web.FileResponse(p, headers={"Cache-Control": "no-cache",
                                                "Content-Type": "text/html; charset=utf-8"})
        return web.Response(text=PLACEHOLDER, content_type="text/html", headers={"Cache-Control": "no-cache"})

    async def static(request):
        p = safe_path(WEB_DIR, request.match_info["path"])
        if not p.is_file():
            raise ApiError(404, "파일을 찾을 수 없습니다")
        headers = {"Cache-Control": "no-cache"}
        ct = STATIC_TYPES.get(p.suffix.lower())
        if ct:
            headers["Content-Type"] = ct
        return web.FileResponse(p, headers=headers)

    async def favicon(request):
        for name in ("favicon.ico", "favicon.svg", "favicon.png"):
            p = WEB_DIR / name
            if p.is_file():
                return web.FileResponse(p, headers={"Content-Type": STATIC_TYPES[p.suffix]})
        return web.Response(status=204)

    async def files(request):
        p = file_path_for(request.match_info["path"])
        headers = {"Cache-Control": "no-cache"}
        if request.query.get("download"):
            from urllib.parse import quote
            headers["Content-Disposition"] = f"attachment; filename*=UTF-8''{quote(p.name)}"
        return web.FileResponse(p, headers=headers)

    async def thumbs(request):
        try:
            w = int(request.query.get("w", 384))
        except ValueError:
            w = 384
        p = await s.gallery.thumb(request.match_info["path"], max(32, min(w, 2048)))
        ct = "image/webp" if p.suffix == ".webp" else "image/jpeg"
        return web.FileResponse(p, headers={"Cache-Control": "no-cache", "Content-Type": ct})

    r.add_get("/", index)
    r.add_get("/favicon.ico", favicon)
    r.add_get("/static/{path:.+}", static)
    r.add_get("/files/{path:.+}", files)
    r.add_get("/thumbs/{path:.+}", thumbs)

    # ---------------------------------------------------------------- 상태 / ComfyUI
    async def status(request):
        if time.time() - s.comfy.queue_ok_at > 3:
            try:  # 엔진이 느려도 상태 응답은 빨리 (실행기 확인용)
                await asyncio.wait_for(s.comfy.refresh(), 2.5)
            except asyncio.TimeoutError:
                pass
        st = s.status()
        st["client"] = request["client"]
        if st["remote"]["enabled"]:
            s.remote.kick()  # 접속 주소 캐시가 10초보다 오래됐으면 백그라운드로 다시 확인 (응답은 기다리지 않음)
        return json_response(st)

    async def ping(request):
        """ComfyUI를 기다리지 않는 가벼운 생존 확인 (studio.sh / stop_studio.sh 용)"""
        return json_response({"studio": {"version": VERSION, "port": s.port, "pid": os.getpid()}})

    async def comfy_start(request):
        res = await s.comfy.start()
        s.poke()
        if not res.get("ok"):
            raise ApiError(500, res.get("error") or "ComfyUI를 시작하지 못했습니다")
        return json_response(res)

    async def comfy_stop(request):
        res = await s.comfy.stop(before_kill=s.jobs.on_comfy_stopping)
        s.poke()
        return json_response(res)

    async def comfy_restart(request):
        res = await s.comfy.restart(before_kill=s.jobs.on_comfy_stopping)
        s.poke()
        if not res.get("ok"):
            raise ApiError(500, res.get("error") or "ComfyUI를 다시 시작하지 못했습니다")
        return json_response(res)

    async def comfy_log(request):
        try:
            n = int(request.query.get("lines", 200))
        except ValueError:
            n = 200
        n = max(1, min(n, 3000))
        lines = await asyncio.to_thread(s.comfy.read_log_tail, n)
        return json_response({"lines": lines, "path": str(COMFY_LOG)})

    async def shutdown(request):
        body = await read_json(request, optional=True)
        stop_comfy = body.get("stop_comfy", True)

        async def later():
            await asyncio.sleep(0.3)
            if stop_comfy and s.comfy.managed():
                try:
                    await s.comfy.stop(before_kill=s.jobs.on_comfy_stopping)
                except Exception:
                    log.exception("종료 중 ComfyUI 중지 실패")
            s.stop_event.set()

        asyncio.create_task(later())
        return json_response({"ok": True, "message": "VN Studio를 종료합니다",
                              "stopping_comfy": bool(stop_comfy and s.comfy.managed())})

    r.add_get("/api/status", status)
    r.add_get("/api/ping", ping)
    r.add_post("/api/comfy/start", comfy_start)
    r.add_post("/api/comfy/stop", comfy_stop)
    r.add_post("/api/comfy/restart", comfy_restart)
    r.add_get("/api/comfy/log", comfy_log)
    r.add_post("/api/shutdown", shutdown)

    # ---------------------------------------------------------------- 시크릿 모드
    async def secret_get(request):
        return json_response({**s.secret.brief(), **await s.secret.usage()})

    async def secret_enable(request):
        return json_response(await s.secret.enable())

    async def secret_disable(request):
        return json_response(await s.secret.disable())

    r.add_get("/api/secret", secret_get)
    r.add_post("/api/secret/enable", secret_enable)
    r.add_post("/api/secret/disable", secret_disable)

    # ---------------------------------------------------------------- 모델 / 프리셋 / LoRA / 설정
    async def models(request):
        return json_response(await s.library.models())

    async def presets(request):
        return json_response(s.library.presets())

    async def preset_put(request):
        body = await read_json(request)
        return json_response(await s.library.save_preset(request.match_info["name"], body))

    async def preset_delete(request):
        return json_response(s.library.delete_preset(request.match_info["name"]))

    async def preset_default(request):
        body = await read_json(request)
        res = s.library.set_default(body.get("name"))
        return json_response(res)

    async def lora_meta(request):
        body = await read_json(request)
        return json_response(s.library.save_lora_meta(request.match_info["filename"], body))

    async def settings_get(request):
        return json_response(s.library.settings())

    async def settings_put(request):
        body = await read_json(request)
        return json_response(s.library.save_settings(body))

    async def download_start(request):
        body = await read_json(request)
        item = await s.downloads.start(body)
        return json_response(item)

    async def downloads_list(request):
        return json_response(s.downloads.list())

    async def download_cancel(request):
        return json_response(s.downloads.cancel(request.match_info["id"]))

    # ---------------------------------------------------------------- 원격 접속 (§10.3)
    async def remote_get(request):
        return json_response(await s.remote.payload(request["client"]))

    async def remote_put(request):  # 로컬 전용 (guard 가 원격 요청을 막음)
        body = await read_json(request)
        res = await s.remote.update(body, request["client"])
        s.poke()
        return json_response(res)

    async def remote_enable(request):  # 로컬 전용
        res = await s.remote.enable(request["client"])
        s.poke()
        return json_response(res)

    async def remote_disable(request):  # 로컬 전용
        res = await s.remote.disable(request["client"])
        s.poke()
        return json_response(res)

    r.add_get("/api/remote", remote_get)
    r.add_put("/api/remote", remote_put)
    r.add_post("/api/remote/enable", remote_enable)
    r.add_post("/api/remote/disable", remote_disable)

    r.add_get("/api/models", models)
    r.add_get("/api/presets", presets)
    r.add_post("/api/presets/default", preset_default)
    r.add_put("/api/presets/{name}", preset_put)
    r.add_delete("/api/presets/{name}", preset_delete)
    r.add_put("/api/loras/{filename:.+}/meta", lora_meta)
    r.add_get("/api/settings", settings_get)
    r.add_put("/api/settings", settings_put)
    r.add_post("/api/models/download", download_start)
    r.add_get("/api/downloads", downloads_list)
    r.add_post("/api/downloads/{id}/cancel", download_cancel)

    # ---------------------------------------------------------------- 캐릭터
    async def chars_list(request):
        return json_response(await asyncio.to_thread(chars_api.list_all))

    async def char_template(request):
        return json_response(chars_api.template())

    async def char_get(request):
        return json_response(chars_api.get(request.match_info["id"]))

    async def char_create(request):
        body = await read_json(request)
        return json_response(chars_api.create(body), status=201)

    async def char_update(request):
        body = await read_json(request)
        return json_response(chars_api.update(request.match_info["id"], body))

    async def char_delete(request):
        return json_response(chars_api.delete(request.match_info["id"]))

    async def char_seed(request):
        body = await read_json(request)
        return json_response(chars_api.set_seed(request.match_info["id"], body))

    r.add_get("/api/characters", chars_list)
    r.add_post("/api/characters", char_create)
    r.add_get("/api/characters/template", char_template)
    r.add_get("/api/characters/{id}", char_get)
    r.add_put("/api/characters/{id}", char_update)
    r.add_delete("/api/characters/{id}", char_delete)
    r.add_post("/api/characters/{id}/seed", char_seed)

    # ---------------------------------------------------------------- 작업
    async def job_submit(request):
        body = await read_json(request)
        job = await s.jobs.submit(body)
        s.poke()
        return json_response({"job": job})

    async def jobs_list(request):
        try:
            limit = int(request.query.get("limit", 50))
        except ValueError:
            limit = 50
        status_f = request.query.get("status") or None
        return json_response({"jobs": s.jobs.list(max(1, min(limit, 1000)), status_f)})

    async def job_get(request):
        return json_response(s.jobs.get(request.match_info["id"]))

    async def job_cancel(request):
        return json_response({"job": await s.jobs.cancel(request.match_info["id"])})

    async def job_retry(request):
        job = await s.jobs.retry(request.match_info["id"])
        s.poke()
        return json_response({"job": job})

    async def job_delete(request):
        return json_response(s.jobs.delete(request.match_info["id"]))

    async def job_preview(request):
        data, ctype, t = s.jobs.preview(request.match_info["id"])
        return web.Response(body=data, content_type=ctype, headers={"Cache-Control": "no-store"})

    r.add_post("/api/jobs", job_submit)
    r.add_get("/api/jobs", jobs_list)
    r.add_get("/api/jobs/{id}", job_get)
    r.add_delete("/api/jobs/{id}", job_delete)
    r.add_post("/api/jobs/{id}/cancel", job_cancel)
    r.add_post("/api/jobs/{id}/retry", job_retry)
    r.add_get("/api/jobs/{id}/preview", job_preview)

    # ---------------------------------------------------------------- 갤러리
    async def gallery(request):
        q = request.query

        def num(key, default, lo, hi):
            try:
                return max(lo, min(int(q.get(key, default)), hi))
            except ValueError:
                return default

        res = await s.gallery.query(folder=(q.get("folder") or "").strip("/"), q=q.get("q", ""),
                                    char=q.get("char", ""), kind=q.get("kind", ""),
                                    limit=num("limit", 60, 1, 500), offset=num("offset", 0, 0, 10**9))
        return json_response(res)

    async def gallery_info(request):
        path = request.query.get("path")
        if not path:
            raise ApiError(400, "path 값이 필요합니다")
        return json_response(await s.gallery.info(path, s.jobs))

    async def gallery_delete(request):
        body = await read_json(request)
        res = await asyncio.to_thread(s.gallery.trash, body.get("paths"))
        for rel in res["deleted"]:
            s.jobs.store.forget_output(rel)
        if res["errors"] and not res["deleted"]:
            raise ApiError(400, "삭제하지 못했습니다: " + res["errors"][0]["error"], **res)
        return json_response(res)

    async def gallery_reveal(request):
        body = await read_json(request)
        p = safe_path(OUTPUT_DIR, body.get("path"), resolve=False)
        safe_path(OUTPUT_DIR, body.get("path"))
        await _open(["-R", str(p)])
        return json_response({"ok": True})

    async def open_folder(request):
        body = await read_json(request)
        which = body.get("which")
        if which not in OPEN_TARGETS:
            raise ApiError(400, "열 수 없는 폴더입니다: %s (가능: %s)" % (which, ", ".join(OPEN_TARGETS)))
        d = OPEN_TARGETS[which]()
        d.mkdir(parents=True, exist_ok=True)
        await _open([str(d)])
        return json_response({"ok": True, "path": str(d)})

    r.add_get("/api/gallery", gallery)
    r.add_get("/api/gallery/info", gallery_info)
    r.add_post("/api/gallery/delete", gallery_delete)
    r.add_post("/api/gallery/reveal", gallery_reveal)
    r.add_post("/api/open-folder", open_folder)

    # ---------------------------------------------------------------- 프롬프트 추출 (§8.4)
    async def tagger_info(request):
        return json_response(await s.tagging.info())

    async def interrogate(request):
        # multipart(image 파일, 최대 20MB)는 핸들러가 스트리밍으로 크기를 검사하므로 앱 전체 client_max_size(8MB)와 무관.
        # JSON {path} 는 다른 라우트처럼 read_json(client_max_size) 검사를 그대로 받는다.
        return json_response(await s.tagging.interrogate(request))

    r.add_get("/api/tagger", tagger_info)
    r.add_post("/api/interrogate", interrogate)

    # ---------------------------------------------------------------- 포즈 따라 그리기 (§9.7)
    async def poses_list(request):
        return json_response(await s.poses.list())

    async def pose_get(request):
        return json_response(await s.poses.get(request.match_info["name"]))

    async def pose_create(request):
        # multipart(keypoints+width+height(+src) 또는 pose 그림 파일, 파일당 20MB)는 핸들러가 스트리밍으로 크기를 검사
        return json_response(await s.poses.create(request))

    async def pose_detect(request):
        return json_response(await s.poses.detect(request))

    async def pose_delete(request):
        # 이 포즈를 쓰는 대기 중·진행 중 작업이 있으면 409 (지우면 실행할 때 파일이 없어 실패)
        return json_response(await s.poses.delete(request.match_info["name"],
                                                  [st.job for st in s.jobs.active.values()]))

    async def pose_file(request):
        p = s.poses.file(request.match_info["name"])
        return web.FileResponse(p, headers={"Cache-Control": "no-cache", "Content-Type": "image/png"})

    async def pose_src(request):
        p = s.poses.file(request.match_info["name"], "src")
        return web.FileResponse(p, headers={"Cache-Control": "no-cache", "Content-Type": "image/jpeg"})

    r.add_get("/api/poses", poses_list)
    r.add_post("/api/poses", pose_create)
    r.add_post("/api/poses/detect", pose_detect)
    r.add_get("/api/poses/{name}", pose_get)
    r.add_delete("/api/poses/{name}", pose_delete)
    r.add_get("/poses/{name}", pose_file)
    r.add_get("/poses/{name}/src", pose_src)

    # ---------------------------------------------------------------- SSE
    async def events(request):
        # 방송되는 status 이벤트에는 요청별 client 가 없으므로 이 연결의 client 를 끼워 넣는다 (/api/status 와 같은 모양)
        client = request["client"]
        status_head = b"event: status\ndata: {"
        client_field = b'"client":' + dumps(client).encode("utf-8") + b","

        def for_client(item):
            if item.startswith(status_head) and not item.startswith(status_head + b"}"):
                return status_head + client_field + item[len(status_head):]
            return item

        resp = web.StreamResponse(headers={
            "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no", "Connection": "keep-alive"})
        await resp.prepare(request)
        sub = s.hub.subscribe()  # 스냅샷보다 먼저 구독 → 사이의 이벤트 유실 없음
        try:
            await resp.write(b"retry: 3000\n\n" + encode_event("status", dict(s.status(), client=client)))
            for job in s.jobs.active_jobs():
                await resp.write(encode_event("job", job))
            for d in s.downloads.list():
                if d["status"] == "running":
                    await resp.write(encode_event("download", d))
            loop = asyncio.get_running_loop()
            next_ping = loop.time() + 15
            while True:
                try:
                    item = await asyncio.wait_for(sub.queue.get(), max(0.05, next_ping - loop.time()))
                except asyncio.TimeoutError:
                    item = b""
                if loop.time() >= next_ping:  # 이벤트가 많아도 15초마다 ping
                    await resp.write(b": ping\n\n")
                    next_ping = loop.time() + 15
                if item is None:
                    break
                if item:
                    await resp.write(for_client(item))
        except (ConnectionError, RuntimeError):
            pass  # 브라우저가 연결을 끊음
        finally:
            s.hub.unsubscribe(sub)
        return resp

    r.add_get("/api/events", events)


async def _open(args):
    try:
        p = await asyncio.create_subprocess_exec("/usr/bin/open", *args, stdout=asyncio.subprocess.DEVNULL,
                                                 stderr=asyncio.subprocess.PIPE)
        _, err = await asyncio.wait_for(p.communicate(), 10)
    except (OSError, asyncio.TimeoutError) as e:
        raise ApiError(500, f"Finder를 열지 못했습니다: {e}") from None
    if p.returncode != 0:
        raise ApiError(500, f"Finder를 열지 못했습니다: {err.decode('utf-8', 'replace').strip()}")


# ====================================================================== 앱
def create_app(studio):
    app = web.Application(middlewares=make_middlewares(studio.port), client_max_size=8 * 1024 * 1024)
    app["studio"] = studio
    setup_routes(app, studio)

    async def on_startup(app):
        await studio.startup()

    async def on_shutdown(app):
        studio.hub.close_all()

    async def on_cleanup(app):
        await studio.shutdown()

    app.on_startup.append(on_startup)
    app.on_shutdown.append(on_shutdown)
    app.on_cleanup.append(on_cleanup)
    return app


async def amain(port, autostart, app_session=False):
    studio = Studio(port, autostart, app_session)
    app = create_app(studio)
    runner = web.AppRunner(app, access_log=None, handle_signals=False, shutdown_timeout=3)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", port, reuse_address=True)
    try:
        await site.start()
    except OSError as e:
        log.error("포트 %d 에서 서버를 시작할 수 없습니다 (이미 VN Studio가 실행 중일 수 있음): %s", port, e)
        await runner.cleanup()
        return 2
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, studio.stop_event.set)
        except (NotImplementedError, RuntimeError):
            pass
    log.info("VN Studio 실행 중: http://127.0.0.1:%d  (Ctrl+C 로 종료)", port)
    await studio.stop_event.wait()
    log.info("VN Studio 종료 중…")
    await runner.cleanup()
    log.info("VN Studio 종료됨")
    return 0


def main():
    ap = argparse.ArgumentParser(description="VN Studio 서버 (127.0.0.1 전용)")
    ap.add_argument("--port", type=int, default=None, help="포트 (기본: settings.studio_port 또는 8190)")
    ap.add_argument("--no-autostart", action="store_true", help="ComfyUI 자동 시작 안 함")
    ap.add_argument("--app", action="store_true",
                    help="VN Studio.app으로 실행됨 (이때만 원격 접속을 받고 Tailscale Serve를 붙임 — studio.sh --open 이 붙임)")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s",
                        datefmt="%Y-%m-%d %H:%M:%S")
    logging.getLogger("aiohttp.access").setLevel(logging.WARNING)
    try:
        port = args.port or int(config.load_settings().get("studio_port") or 8190)
    except (TypeError, ValueError):
        port = 8190
    try:
        code = asyncio.run(amain(port, not args.no_autostart, args.app))
    except KeyboardInterrupt:
        code = 0
    except config.ConfigError as e:
        logging.getLogger("studio").error("설정 파일 오류로 시작할 수 없습니다: %s", e)
        code = 1
    sys.exit(code)


if __name__ == "__main__":
    main()
