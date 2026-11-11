"""VN Studio 공용 유틸: 경로 상수, API 오류, JSON 응답, 안전한 경로 결합, 이벤트 스로틀."""
import asyncio
import json
import logging
import re
import sys
from pathlib import Path
from urllib.parse import quote

from aiohttp import web

STUDIO_DIR = Path(__file__).resolve().parent
ROOT = STUDIO_DIR.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from vnlib import config  # noqa: E402

VERSION = "1.0"
WEB_DIR = STUDIO_DIR / "web"
OUTPUT_DIR = config.OUTPUT_DIR
DATA_DIR = config.USER_DIR / "studio"          # studio 전용 런타임 데이터
THUMB_DIR = DATA_DIR / "thumbs"
DB_PATH = DATA_DIR / "jobs.sqlite3"
COMFY_LOG = config.USER_DIR / "server.log"     # ComfyUI 로그 (start.sh 출력)
START_SH = ROOT / "start.sh"
MODEL_INSTALL_ROOT = config.MODEL_ROOTS[0]     # VN-Pipeline/models

log = logging.getLogger("studio")


class ApiError(Exception):
    """핸들러에서 던지면 {"error": message} JSON + status 로 변환된다."""

    def __init__(self, status, message, **extra):
        super().__init__(message)
        self.status = status
        self.message = message
        self.extra = extra


def dumps(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"), default=str)


def json_response(data, status=200, headers=None):
    return web.json_response(data, status=status, dumps=dumps, headers=headers)


def json_error(status, message, **extra):
    body = {"error": message}
    body.update(extra)
    return json_response(body, status=status)


async def read_json(request, *, optional=False):
    """요청 본문(JSON 객체)을 읽는다. optional=True면 본문이 없을 때 {}."""
    if not request.body_exists:
        if optional:
            return {}
        raise ApiError(400, "요청 본문(JSON)이 비어 있습니다")
    try:
        raw = await request.read()
        data = json.loads(raw.decode("utf-8")) if raw.strip() else {}
    except (UnicodeDecodeError, ValueError):
        raise ApiError(400, "요청 본문이 올바른 JSON 형식이 아닙니다") from None
    if not isinstance(data, dict):
        raise ApiError(400, "요청 본문은 JSON 객체({...})여야 합니다")
    return data


def _split_rel(rel, allow_hidden=False):
    if not isinstance(rel, str) or not rel.strip() or "\x00" in rel:
        raise ApiError(400, "경로가 올바르지 않습니다")
    rel = rel.replace("\\", "/")
    if rel.startswith("/") or re.match(r"^[A-Za-z]:", rel) or rel.startswith("~"):
        raise ApiError(403, "허용되지 않은 경로입니다 (절대 경로)")
    parts = [p for p in rel.split("/") if p not in ("", ".")]
    if not parts or any(p == ".." for p in parts):
        raise ApiError(403, "허용되지 않은 경로입니다 (상위 폴더 접근)")
    if not allow_hidden and any(p.startswith(".") for p in parts):
        raise ApiError(403, "허용되지 않은 경로입니다 (숨김 파일)")
    return parts


def safe_path(base, rel, *, must_exist=True, allow_hidden=False, resolve=True):
    """base 아래의 상대경로 rel 을 안전하게 결합한다.

    '..', 절대경로, 숨김 경로, 그리고 심볼릭 링크로 base 밖을 가리키는 경우를 모두 차단한다.
    resolve=False 면 검사는 동일하게 하되 (심볼릭 링크를 풀지 않은) 원래 경로를 돌려준다.
    """
    parts = _split_rel(rel, allow_hidden)
    base_r = Path(base).resolve()
    lexical = base_r.joinpath(*parts)
    try:
        resolved = lexical.resolve(strict=must_exist)
    except FileNotFoundError:
        raise ApiError(404, "파일을 찾을 수 없습니다") from None
    except (OSError, RuntimeError):
        raise ApiError(400, "경로를 확인할 수 없습니다") from None
    if resolved != base_r and not resolved.is_relative_to(base_r):
        raise ApiError(403, "허용되지 않은 경로입니다 (폴더 밖을 가리킴)")
    return resolved if resolve else lexical


def rel_posix(path, base):
    return Path(path).relative_to(base).as_posix()


def file_url(rel):
    return "/files/" + quote(rel, safe="/")


def thumb_url(rel):
    return "/thumbs/" + quote(rel, safe="/")


def to_bool(v, field="값"):
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)) and v in (0, 1):
        return bool(v)
    if isinstance(v, str) and v.strip().lower() in ("true", "1", "yes", "on", "false", "0", "no", "off", ""):
        return v.strip().lower() in ("true", "1", "yes", "on")
    raise ApiError(400, f"{field} 값은 참/거짓이어야 합니다")


def to_number(v, field, lo, hi, kind=float):
    """숫자 변환 + 범위 검증. 실패 시 한국어 400 오류."""
    try:
        if isinstance(v, bool):
            raise ValueError
        x = float(v)
        if x != x or x in (float("inf"), float("-inf")):
            raise ValueError
        if kind is int:
            if x != int(x):
                raise ValueError
            x = int(x)
    except (TypeError, ValueError):
        raise ApiError(400, f"{field} 값은 {'정수' if kind is int else '숫자'}여야 합니다") from None
    if not (lo <= x <= hi):
        raise ApiError(400, f"{field} 값은 {lo}~{hi} 사이여야 합니다 (입력값: {v})")
    return x


def to_text(v, field, limit=4000, allow_none=True):
    if v is None and allow_none:
        return ""
    if not isinstance(v, str):
        raise ApiError(400, f"{field} 값은 문자열이어야 합니다")
    if len(v) > limit:
        raise ApiError(400, f"{field} 내용이 너무 깁니다 (최대 {limit}자)")
    return v


class Throttle:
    """키별 전송 빈도 제한. 제한 시간 안에 다시 불리면 마지막 상태를 한 번 늦게(trailing) 보낸다.

    send(key) 는 '보낼 시점의 최신 상태'를 직접 읽어서 보내야 한다.
    """

    def __init__(self, interval, send):
        self.interval = interval
        self.send = send
        self._last = {}
        self._pending = {}

    def fire(self, key, force=False):
        loop = asyncio.get_running_loop()
        now = loop.time()
        if force:
            h = self._pending.pop(key, None)
            if h:
                h.cancel()
            self._emit(key, now)
            return
        if key in self._pending:
            return  # 곧 최신 상태가 전송됨
        wait = self._last.get(key, -1e9) + self.interval - now
        if wait <= 0:
            self._emit(key, now)
        else:
            self._pending[key] = loop.call_later(wait, self._trailing, key)

    def forget(self, key):
        h = self._pending.pop(key, None)
        if h:
            h.cancel()
        self._last.pop(key, None)

    def _trailing(self, key):
        self._pending.pop(key, None)
        self._emit(key, asyncio.get_running_loop().time())

    def _emit(self, key, now):
        self._last[key] = now
        try:
            self.send(key)
        except Exception:
            log.exception("이벤트 전송 실패 (%s)", key)
