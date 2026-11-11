"""모델/LoRA URL 다운로드 (백그라운드 스트리밍, 진행률, 취소)."""
import asyncio
import collections
import json
import os
import re
import secrets
import shutil
import struct
import time
from urllib.parse import parse_qsl, unquote, urlencode, urlsplit, urlunsplit

import aiohttp

from vnlib import config

from .common import ApiError, MODEL_INSTALL_ROOT, Throttle, log

FOLDERS = ("checkpoints", "loras", "upscale_models")
FOLDER_LABEL = {"checkpoints": "체크포인트", "loras": "LoRA", "upscale_models": "업스케일러"}
EXTS = (".safetensors", ".pth", ".pt", ".ckpt")


def safe_filename(name):
    name = unquote(name or "").replace("\\", "/").rsplit("/", 1)[-1]
    name = re.sub(r"[\x00-\x1f\x7f]", "", name)
    name = re.sub(r'[:*?"<>|]', "_", name).strip().lstrip(".")
    name = re.sub(r"\s+", " ", name)
    if len(name) > 180:
        stem, ext = os.path.splitext(name)
        name = stem[:180 - len(ext)] + ext
    return name


def _with_token(url, token):
    parts = urlsplit(url)
    q = parse_qsl(parts.query, keep_blank_values=True)
    if any(k == "token" for k, _ in q):
        return url
    q.append(("token", token))
    return urlunsplit(parts._replace(query=urlencode(q)))


def _strip_token(url):
    parts = urlsplit(url)
    q = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if k != "token"]
    return urlunsplit(parts._replace(query=urlencode(q)))


class DownloadManager:
    def __init__(self, hub, on_change=None):
        self.hub = hub
        self.on_change = on_change
        self.items = collections.OrderedDict()
        self.tasks = {}
        self.session = None
        self.throttle = Throttle(0.25, self._emit)

    def _emit(self, did):
        it = self.items.get(did)
        if it:
            self.hub.publish("download", dict(it))

    def list(self):
        return [dict(it) for it in reversed(self.items.values())]

    def running_count(self):
        return sum(1 for it in self.items.values() if it["status"] == "running")

    def _session(self):
        if self.session is None or self.session.closed:
            self.session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=None, connect=20, sock_connect=20, sock_read=120),
                headers={"User-Agent": "Mozilla/5.0 (Macintosh) VN-Studio/1.0"})
        return self.session

    async def start(self, body):
        url = body.get("url")
        folder = body.get("folder") or "checkpoints"
        if not isinstance(url, str) or not url.strip():
            raise ApiError(400, "다운로드할 주소(URL)를 입력하세요")
        url = url.strip()
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise ApiError(400, "http:// 또는 https:// 로 시작하는 주소만 다운로드할 수 있습니다")
        if folder not in FOLDERS:
            raise ApiError(400, "저장 폴더는 checkpoints / loras / upscale_models 중 하나여야 합니다")
        host = parts.hostname.lower()
        is_civitai = host == "civitai.com" or host.endswith(".civitai.com")
        is_hf = host in ("huggingface.co", "hf.co") or host.endswith(".huggingface.co")
        if (is_civitai or is_hf) and parts.scheme == "http":  # 암호화된 https 로 (토큰이 평문으로 나가지 않게)
            url = urlunsplit(parts._replace(scheme="https"))
            parts = urlsplit(url)
        if is_hf and "/blob/" in parts.path:  # 웹페이지 주소 → 실제 파일 주소
            url = url.replace("/blob/", "/resolve/", 1)
        token = (config.load_settings().get("civitai_token") or "").strip()
        real_url = _with_token(url, token) if (is_civitai and token and parts.scheme == "https") else url

        want = body.get("filename")
        if want not in (None, ""):
            if not isinstance(want, str):
                raise ApiError(400, "파일 이름이 올바르지 않습니다")
            want = safe_filename(want)
            if not want:
                raise ApiError(400, "파일 이름이 올바르지 않습니다")

        dest_dir = MODEL_INSTALL_ROOT / folder
        try:
            resp = await self._session().get(real_url, allow_redirects=True, max_redirects=10)
        except (aiohttp.ClientError, asyncio.TimeoutError, OSError, ValueError) as e:
            raise ApiError(502, f"서버에 연결하지 못했습니다: {e.__class__.__name__} {e}".strip()) from None
        try:
            if resp.status in (401, 403):
                if is_civitai:
                    raise ApiError(400, "Civitai 로그인이 필요한 파일입니다. '모델·LoRA' 탭의 Civitai 토큰(API 키)을 입력한 뒤 다시 시도하세요.")
                raise ApiError(400, f"다운로드 권한이 없습니다 (서버 응답 {resp.status}). 로그인이 필요한 파일일 수 있습니다.")
            if resp.status == 404:
                raise ApiError(400, "파일을 찾을 수 없습니다 (서버 응답 404). 주소를 확인하세요.")
            if resp.status >= 400:
                raise ApiError(400, f"다운로드 실패: 서버 응답 {resp.status}")
            cd_name = None
            try:
                cd_name = resp.content_disposition.filename if resp.content_disposition else None
            except Exception:
                cd_name = None
            name = want or safe_filename(cd_name or "") or safe_filename(resp.url.path) or safe_filename(parts.path)
            ctype = (resp.headers.get("Content-Type") or "").lower()
            if not name.lower().endswith(EXTS):
                if "text/html" in ctype:
                    raise ApiError(400, "파일이 아니라 웹페이지 주소입니다. 모델 페이지의 '다운로드' 버튼에 연결된 주소를 복사해 넣으세요.")
                raise ApiError(400, f"지원하지 않는 파일 형식입니다: {name or '(이름 없음)'} (.safetensors / .pth / .pt / .ckpt 만 가능)")
            dest = dest_dir / name
            # 모든 모델 폴더를 확인 (새 파일이 먼저 검색되는 폴더에 들어가 기존 모델을 조용히 가리는 것 방지)
            existing = config.find_model(folder, name)
            if existing:
                try:  # 대소문자만 다른 이름이면 디스크에 있는 실제 이름으로 보여 준다
                    existing = next((p for p in existing.parent.iterdir()
                                     if p.name.casefold() == name.casefold()), existing)
                except OSError:
                    pass
                raise ApiError(409, f"같은 이름의 {FOLDER_LABEL[folder]} 파일이 이미 있습니다: {existing} "
                                    "— 다른 파일 이름을 지정해서 받으세요")
            if any(it["status"] == "running" and it["folder"] == folder
                   and it["filename"].casefold() == name.casefold() for it in self.items.values()):
                raise ApiError(409, f"같은 파일을 이미 받는 중입니다: {name}")
            total = resp.content_length
            dest_dir.mkdir(parents=True, exist_ok=True)
            if total:
                free = shutil.disk_usage(dest_dir).free
                if free < total + 512 * 1024 * 1024:
                    raise ApiError(507, f"디스크 공간이 부족합니다 (필요 {total / 1e9:.1f}GB, 남은 공간 {free / 1e9:.1f}GB)")
        except BaseException:
            resp.release()
            raise

        did = "d_" + time.strftime("%H%M%S") + "_" + secrets.token_hex(3)
        item = {"id": did, "filename": name, "folder": folder, "folder_label": FOLDER_LABEL[folder],
                "url": _strip_token(url), "received": 0, "total": total, "status": "running",
                "error": None, "started": time.time(), "finished": None, "speed": 0}
        self.items[did] = item
        while len(self.items) > 50:  # 오래된 완료 기록 정리
            old = next((k for k, v in self.items.items() if v["status"] != "running"), None)
            if old is None:
                break
            self.items.pop(old)
        self.tasks[did] = asyncio.create_task(self._run(item, resp, dest))
        self.throttle.fire(did, force=True)
        self._changed()
        log.info("다운로드 시작 %s → %s", item["url"], dest)
        return dict(item)

    def _changed(self):
        if self.on_change:
            try:
                self.on_change()
            except Exception:
                log.exception("상태 알림 실패")

    async def _run(self, item, resp, dest):
        part = dest.with_name(dest.name + ".part")
        t0 = time.time()
        try:
            with open(part, "wb") as f:
                async for chunk in resp.content.iter_chunked(1 << 20):
                    f.write(chunk)  # 1MB 단위 — 디스크 쓰기는 짧다
                    item["received"] += len(chunk)
                    dt = time.time() - t0
                    item["speed"] = int(item["received"] / dt) if dt > 0.5 else 0
                    self.throttle.fire(item["id"])
            if item["total"] and item["received"] < item["total"]:
                raise IOError("연결이 중간에 끊겼습니다")
            if dest.suffix.lower() == ".safetensors":
                await asyncio.to_thread(self._check_safetensors, part)
            if dest.exists() or config.find_model(item["folder"], dest.name):
                raise IOError("받는 동안 같은 이름의 모델 파일이 생겼습니다")
            os.replace(part, dest)
            item["status"] = "done"
            log.info("다운로드 완료 %s", dest)
        except asyncio.CancelledError:
            item["status"] = "cancelled"
            item["error"] = None
        except Exception as e:
            item["status"] = "error"
            msg = str(e) or e.__class__.__name__
            item["error"] = f"다운로드 실패: {msg}"
            log.warning("다운로드 실패 %s: %s", dest.name, msg)
        finally:
            resp.release()
            item["finished"] = time.time()
            if item["status"] != "done":
                try:
                    part.unlink()
                except OSError:
                    pass
            self.tasks.pop(item["id"], None)
            self.throttle.fire(item["id"], force=True)
            self.throttle.forget(item["id"])
            self._changed()

    @staticmethod
    def _check_safetensors(path):
        with open(path, "rb") as f:
            head = f.read(8)
            if len(head) < 8:
                raise IOError("받은 파일이 비어 있습니다")
            n = struct.unpack("<Q", head)[0]
            if n <= 0 or n > 100_000_000:
                raise IOError("받은 파일이 safetensors 형식이 아닙니다 (로그인 페이지 등을 받았을 수 있음)")
            try:
                json.loads(f.read(n))
            except ValueError:
                raise IOError("받은 파일이 safetensors 형식이 아닙니다 (손상되었거나 로그인 페이지일 수 있음)") from None

    def cancel(self, did):
        it = self.items.get(did)
        if not it:
            raise ApiError(404, "다운로드를 찾을 수 없습니다")
        t = self.tasks.get(did)
        if t and not t.done():
            t.cancel()
        return dict(it)

    async def close(self):
        for t in list(self.tasks.values()):
            t.cancel()
        if self.tasks:
            await asyncio.gather(*self.tasks.values(), return_exceptions=True)
        if self.session and not self.session.closed:
            await self.session.close()
