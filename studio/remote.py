"""원격 접속 (Tailscale Serve, §10) — 요청 판별(guard 미들웨어용), tailscale CLI 상태 확인, 원격 설정 API.

Studio는 그대로 127.0.0.1:<port>에만 바인드한다. 테일넷 노출은 `tailscale serve --bg --https=443 http://127.0.0.1:<port>`가
맡는다(테일넷 전용, Funnel 금지). Serve가 넘긴 요청은 클라이언트 주소가 127.0.0.1이지만 원래 Host(MagicDNS 이름),
X-Forwarded-For(원격 기기의 100.x IP), Tailscale-User-Login/Name(신원) 헤더를 달고 온다(실측) → 이 표시로 원격 요청을
가려 '원격 허용 켜짐 + 저장된 주소 + 허용된 로그인'일 때만 통과시킨다.

느슨한 경계(앱 세션): 원격 접속은 Mac에서 VN Studio.app(studio.sh --open → server.py --app)으로 띄운 서버에서만 열린다.
- 앱 세션이 아니면(터미널·자동 실행 등) 원격 요청은 모두 403, Serve 설정도 시작할 때 걷어 낸다.
- 앱 세션이면 시작할 때 Serve를 붙이고(원격 허용이 켜져 있을 때만), 서버가 끝날 때 Serve를 뗀다.
→ 테일넷 443 포트는 Mac에서 앱을 연 동안에만 열려 있다. remote_enabled 는 '앱으로 열면 원격도 연다'는 기본값일 뿐이다.
"""
import asyncio
import html
import json
import os
import re
import shutil
import signal
import time
from email.errors import HeaderParseError
from email.header import decode_header, make_header
from urllib.parse import urlsplit

from aiohttp import web

from vnlib import config

from .common import ApiError, json_error, log
from .library import clean_remote_logins

CLI_CANDIDATES = (
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",  # Mac 앱 (PATH에 없음)
    "/usr/local/bin/tailscale",
    "/opt/homebrew/bin/tailscale",
)
ADMIN_DNS_URL = "https://login.tailscale.com/admin/dns"
DOWNLOAD_URL = "https://tailscale.com/download"
STATUS_TIMEOUT = 5      # status --json / serve status --json
SERVE_TIMEOUT = 20      # serve 켜기·끄기
CACHE_TTL = 10          # tailscale 상태 캐시(초)
OUTPUT_LIMIT = 1 << 20  # CLI 출력 보관 한도
SERVE_PORT = 443

LOOPBACK_TARGETS = ("127.0.0.1", "localhost", "::1")
# 하나라도 있으면 원격(Serve 경유) 요청으로 본다. Serve는 Tailscale-* 신원 헤더를 직접 다시 쓰고(클라이언트가 보낸 값은
# 지움) X-Forwarded-For/Host 를 붙인다 → Host 를 127.0.0.1:<port> 로 속여 보내도 로컬로 취급되지 않는다.
REMOTE_MARKERS = ("Tailscale-User-Login", "Tailscale-User-Name", "Tailscale-Funnel-Request",
                  "X-Forwarded-For", "X-Forwarded-Host", "Forwarded")
LOCAL_CLIENT = {"remote": False, "login": None, "name": None, "ip": None}

_REMOTE_CONFIG_MSG = "원격 접속 설정은 Mac에서만 바꿀 수 있습니다 (Mac의 VN Studio › 모델·LoRA › 전역 설정 › 원격 접속)."
_FINDER_MSG = "Mac 화면에 Finder 창을 띄우는 기능이라 원격에서는 쓸 수 없습니다."
# 원격에서 막는 동작 (method, 라우트 경로) → 이유. 라우트 경로는 aiohttp 가 실제로 고른 라우트(resource.canonical)로 비교
LOCAL_ONLY = {
    ("POST", "/api/shutdown"): "원격에서 종료하면 다시 켤 방법이 없습니다. VN Studio 종료는 Mac에서 하세요.",
    ("POST", "/api/open-folder"): "폴더 열기는 " + _FINDER_MSG,
    ("POST", "/api/gallery/reveal"): "Finder에서 보기는 " + _FINDER_MSG + " [다운로드]를 쓰세요.",
    ("PUT", "/api/remote"): _REMOTE_CONFIG_MSG,
    ("POST", "/api/remote/enable"): _REMOTE_CONFIG_MSG,
    ("POST", "/api/remote/disable"): _REMOTE_CONFIG_MSG,
}
HTTPS_OFF_MSG = ("테일넷의 HTTPS 인증서가 꺼져 있습니다. Tailscale 관리 화면(" + ADMIN_DNS_URL + ")의 "
                 "'HTTPS Certificates'에서 [Enable HTTPS]를 누른 뒤 다시 시도하세요. "
                 "(켜면 이 Mac의 테일넷 이름이 공개 인증서 기록(CT 로그)에 남습니다.)")


class Denied(ApiError):
    """guard 가 막은 요청(403). /api/… 는 JSON {"error", "code"}, 그 밖(브라우저 페이지)은 한국어 HTML 안내."""

    def __init__(self, code, message, todo=()):
        super().__init__(403, message, code=code)
        self.code = code
        self.todo = list(todo)


# ====================================================================== 작은 도구
def split_host(host):
    """'name:port' / '[v6]:port' / 'name' → (소문자 이름(끝의 . 제거), 포트 문자열|None)"""
    host = (host or "").strip().lower()
    if host.startswith("["):
        end = host.find("]")
        if end < 0:
            return host, None
        name, rest = host[1:end], host[end + 1:]
        port = rest[1:] if rest.startswith(":") else None
    elif host.count(":") == 1:
        name, port = host.split(":")
    else:
        name, port = host, None
    return name.rstrip("."), (port or None)


def decode_mime(value):
    """Serve 신원 헤더 값 풀기: ASCII 가 아니면 RFC 2047(=?utf-8?q?...?=)로 온다 → 한국어 이름 등 복원."""
    if value is None:
        return None
    value = value.strip()
    if "=?" not in value:
        return value
    try:
        return str(make_header(decode_header(value))).strip()
    except (HeaderParseError, LookupError, UnicodeError, ValueError):
        return value


def _forwarded_ip(headers):
    xff = headers.get("X-Forwarded-For")
    if not xff:
        return None
    parts = [p.strip() for p in xff.split(",") if p.strip()]
    return parts[-1] if parts else None  # Serve 가 붙인 값(가장 가까운 프록시)


def _str_list(v):
    if not isinstance(v, list):
        return []
    return [x.strip() for x in v if isinstance(x, str) and x.strip()]


# ====================================================================== 원격 설정 (settings.json 의 remote_*)
_settings_cache = [None, None]  # [파일 식별값, 정리된 값] — 원격 요청마다 디스크를 읽지 않게


def _settings_key():
    try:
        st = (config.CONFIG_DIR / "settings.json").stat()
    except OSError:
        return None
    return (str(config.CONFIG_DIR), st.st_ino, st.st_mtime_ns, st.st_size)


def remote_settings():
    """{"enabled": bool, "logins": [..], "hosts": [..], "allowed": 소문자 집합, "host_set": 소문자 집합}

    손으로 고친 이상한 값은 '꺼짐/비어 있음'으로 본다(fail closed): remote_enabled 는 JSON true 일 때만 켜짐.
    파일이 바뀌면(mtime·크기·inode) 다시 읽는다.
    """
    key = _settings_key()
    if key is not None and _settings_cache[0] == key:
        return _settings_cache[1]
    s = config.load_settings()
    logins = _str_list(s.get("remote_allowed_logins"))
    hosts = []
    for h in _str_list(s.get("remote_hosts")):
        h = h.lower().rstrip(".")
        if h and h not in hosts:
            hosts.append(h)
    val = {"enabled": s.get("remote_enabled") is True, "logins": logins, "hosts": hosts,
           "allowed": frozenset(x.lower() for x in logins), "host_set": frozenset(hosts)}
    _settings_cache[0], _settings_cache[1] = (key if key is not None else _settings_key()), val
    return val


def invalidate_settings():
    _settings_cache[0] = _settings_cache[1] = None


def _save_remote(**changes):
    """remote_* 저장. 읽기→고치기→쓰기 사이에 await 가 없어 다른 설정 저장과 섞이지 않는다."""
    s = config.load_settings()
    s.update(changes)
    config.save_settings(s)
    invalidate_settings()
    return s


# ====================================================================== 요청 판별 (guard)
def identify(request, port, app_session=True):
    """요청이 로컬인지, 허용된 원격(테일넷) 사용자인지 판별 → request["client"] 값. 막아야 하면 Denied."""
    raw = (request.host or "").strip().lower()
    name, _ = split_host(raw)
    headers = request.headers
    marked = any(h in headers for h in REMOTE_MARKERS)
    if not marked and raw in (f"127.0.0.1:{port}", f"localhost:{port}"):
        return dict(LOCAL_CLIENT)  # 로컬: 기존 규칙 그대로
    rs = remote_settings()
    if not marked and name not in rs["host_set"]:
        # DNS 리바인딩 방지: 모르는 Host
        raise Denied("host", "허용되지 않은 호스트로 접근했습니다. http://127.0.0.1:%d 로 접속하세요." % port,
                     [f"이 Mac에서는 http://127.0.0.1:{port} 로 접속하세요.",
                      "다른 기기에서는 Mac의 VN Studio에서 [원격 접속 켜기]를 누른 뒤 안내된 https://… 주소로 접속하세요."])
    # ---- 여기부터 원격 요청 (Serve 경유 표시가 있거나 저장된 원격 주소로 들어옴)
    if not rs["enabled"]:
        raise Denied("remote_disabled",
                     "원격 접속이 꺼져 있습니다. Mac의 VN Studio › 모델·LoRA › 전역 설정 › 원격 접속에서 켜세요.",
                     ["Mac에서 VN Studio를 엽니다.",
                      "모델·LoRA › 전역 설정 › 원격 접속 (Tailscale)에서 [원격 접속 켜기]를 누릅니다.",
                      "이 페이지를 새로고침합니다."])
    if not app_session:
        raise Denied("remote_no_app",
                     "Mac에서 VN Studio 앱으로 연 Studio만 원격 접속을 받습니다. 지금 Studio는 앱이 아닌 방법(터미널·자동 실행)으로 켜져 있습니다.",
                     ["Mac에서 VN Studio를 종료합니다 (상단 ⋯ 메뉴 › VN Studio 종료, 또는 scripts/stop_studio.sh).",
                      "Mac에서 VN Studio.app을 엽니다.",
                      "이 페이지를 새로고침합니다."])
    if name not in rs["host_set"]:
        where = f"https://{rs['hosts'][0]}/" if rs["hosts"] else "Mac의 원격 접속 설정에 표시된 주소"
        raise Denied("remote_host", f"허용되지 않은 주소(호스트)로 접속했습니다: {name or '(없음)'}. {where} 로 접속하세요.",
                     [f"{where} 로 접속하세요.",
                      "Mac의 테일넷 이름이 바뀌었다면 Mac의 VN Studio에서 [원격 접속 켜기]를 다시 누르세요."])
    login = decode_mime(headers.get("Tailscale-User-Login"))
    if "Tailscale-Funnel-Request" in headers or not login:
        raise Denied("remote_identity", "테일넷 사용자 확인 헤더가 없습니다(Funnel·태그 기기 접속 차단)",
                     ["이 기기에서 Tailscale 앱에 로그인했는지(Mac과 같은 테일넷인지) 확인하세요.",
                      "태그가 붙은 기기나 Funnel(인터넷 공개) 경로로는 접속할 수 없습니다."])
    if login.lower() not in rs["allowed"]:
        raise Denied("remote_login", f"허용되지 않은 사용자입니다: {login}",
                     ["Mac의 VN Studio › 원격 접속 › 허용할 로그인에 이 계정을 추가하세요.",
                      "또는 허용된 계정으로 Tailscale에 로그인한 기기에서 접속하세요."])
    return {"remote": True, "login": login, "name": decode_mime(headers.get("Tailscale-User-Name")) or None,
            "ip": _forwarded_ip(headers)}


_ORIGIN_RE = re.compile(r"(https?)://([a-z0-9.-]+?)\.?(?::(\d{1,5}))?")


def check_origin(request, client, port):
    """CSRF 방지: 상태를 바꾸는 요청의 Origin(있을 때만)이 같은 쪽(로컬/원격 주소)인지"""
    origin = request.headers.get("Origin")
    if origin is None:
        return
    if not client["remote"]:
        ok = origin in (f"http://127.0.0.1:{port}", f"http://localhost:{port}")
    else:  # https://<remote_host>[:포트] 또는 http://<remote_host>[:포트]
        m = _ORIGIN_RE.fullmatch(origin.strip().lower())
        ok = bool(m) and m.group(2) in remote_settings()["host_set"]
    if not ok:
        raise Denied("origin", "허용되지 않은 출처(Origin)의 요청입니다")


def local_only_reason(request):
    """원격에서 막는 동작이면 이유 문자열. aiohttp 가 고른 라우트로 비교하므로 경로 표기를 바꿔도 우회 불가."""
    resource = getattr(request.match_info.route, "resource", None)
    path = getattr(resource, "canonical", None) or request.path
    return LOCAL_ONLY.get((request.method, path))


_TITLES = {
    "host": "허용되지 않은 주소입니다", "remote_host": "허용되지 않은 주소입니다",
    "remote_disabled": "원격 접속이 꺼져 있습니다", "remote_identity": "테일넷 사용자를 확인할 수 없습니다",
    "remote_login": "허용되지 않은 사용자입니다", "remote_no_app": "Mac에서 앱으로 연 Studio가 아닙니다",
    "local_only": "Mac에서만 할 수 있는 동작입니다",
}
_PAGE = """<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark light">
<title>VN Studio — {title}</title>
<style>body{{font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;background:#16171d;
color:#e7e7ef;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;box-sizing:border-box}}
main{{max-width:560px;width:100%;line-height:1.65;font-size:16px}}h1{{font-size:22px;margin:0 0 12px}}
.msg{{background:#24252e;border-radius:10px;padding:12px 14px;margin:0 0 16px;word-break:break-word}}
ol{{padding-left:22px;margin:0 0 16px}}li{{margin:4px 0}}.foot{{color:#8a8b99;font-size:13px;margin-top:24px}}
@media (prefers-color-scheme: light){{body{{background:#f3f4f7;color:#1d1e26}}.msg{{background:#fff}}}}</style></head>
<body><main><h1>{title}</h1><p class="msg">{message}</p>{todo}
<p class="foot">VN Studio · 403 · 이 기기: {who}</p></main></body></html>"""


def deny_response(request, err):
    if request.path.startswith("/api/"):
        return json_error(err.status, err.message, **err.extra)
    todo = ""
    if err.todo:
        todo = "<p>이렇게 해 보세요:</p><ol>" + "".join(f"<li>{html.escape(t)}</li>" for t in err.todo) + "</ol>"
    who = decode_mime(request.headers.get("Tailscale-User-Login")) or _forwarded_ip(request.headers) or "알 수 없음"
    page = _PAGE.format(title=html.escape(_TITLES.get(err.code, "접근이 거부되었습니다")),
                        message=html.escape(err.message), todo=todo, who=html.escape(who))
    return web.Response(status=err.status, text=page, content_type="text/html", charset="utf-8",
                        headers={"Cache-Control": "no-store"})


# ====================================================================== tailscale CLI
def find_cli():
    for p in CLI_CANDIDATES:
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return shutil.which("tailscale")


def _kill_group(p):
    try:
        os.killpg(p.pid, signal.SIGKILL)  # start_new_session → 프로세스 그룹 = 자식 pid (손자 프로세스까지)
    except OSError:
        pass


async def run_cli(path, args, timeout):
    """CLI 실행 → {"rc", "out", "err", "timed_out"}. 시간 초과면 프로세스 그룹째 끝내고 그때까지의 출력을 돌려준다."""
    try:
        p = await asyncio.create_subprocess_exec(path, *args, stdin=asyncio.subprocess.DEVNULL,
                                                 stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                                                 start_new_session=True)
    except OSError as e:
        return {"rc": None, "out": "", "err": f"실행할 수 없습니다: {e}", "timed_out": False}
    out, err = bytearray(), bytearray()

    async def pump(stream, buf):
        while True:
            chunk = await stream.read(65536)
            if not chunk:
                return
            if len(buf) < OUTPUT_LIMIT:
                buf += chunk[:OUTPUT_LIMIT - len(buf)]

    reader = asyncio.gather(pump(p.stdout, out), pump(p.stderr, err))
    timed_out = False
    try:
        try:
            await asyncio.wait_for(p.wait(), timeout)
        except asyncio.TimeoutError:
            timed_out = p.returncode is None  # 끝났는데 손자 프로세스가 출력 파이프를 쥐고 있던 경우는 시간 초과 아님
            _kill_group(p)
            try:
                await asyncio.wait_for(p.wait(), 3)
            except asyncio.TimeoutError:
                pass
        try:
            await asyncio.wait_for(reader, 1)
        except (asyncio.TimeoutError, OSError, ValueError):
            pass
    except BaseException:  # 취소(서버 종료 등): 남은 프로세스를 정리하고 그대로 올린다
        if p.returncode is None or not reader.done():
            _kill_group(p)
        reader.cancel()
        raise
    return {"rc": p.returncode, "out": out.decode("utf-8", "replace"), "err": err.decode("utf-8", "replace"),
            "timed_out": timed_out}


_ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")


def _summarize(res, limit=600):
    text = "\n".join(x for x in (res.get("out"), res.get("err")) if x and x.strip())
    text = _ANSI_RE.sub("", text).strip()
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    text = " / ".join(lines)
    if res.get("timed_out"):
        text = (text + " / " if text else "") + "(응답 없음 — 시간 초과로 중단)"
    elif not text and res.get("rc") not in (0, None):
        text = f"종료 코드 {res.get('rc')}"
    return text[:limit] + ("…" if len(text) > limit else "")


def _links(res):
    text = (res.get("out") or "") + "\n" + (res.get("err") or "")
    out = []
    for u in re.findall(r"https://[^\s\"'<>]+", text):
        u = u.rstrip(".,;)")
        if u not in out:
            out.append(u)
    return out[:5]


def _cli_ok(res):
    return res.get("rc") == 0 and not res.get("timed_out")


def _json_from(res):
    """CLI 결과 stdout 의 JSON 객체 → (dict|None, 오류 문자열|None)"""
    if res.get("timed_out"):
        return None, "응답이 없습니다 (시간 초과)"
    raw = (res.get("out") or "").strip()
    if raw.startswith("{"):
        try:
            data = json.loads(raw)
            if isinstance(data, dict):
                return data, None
        except ValueError:
            pass
    return None, _summarize(res) or "알 수 없는 오류"


def _empty_tailscale(path):
    return {"installed": bool(path), "path": path, "running": False, "backend_state": None, "version": None,
            "dns_name": None, "short_name": None, "host_name": None, "ips": [], "tailnet": None,
            "magic_dns_suffix": None, "users": [], "self_login": None, "https_enabled": False, "cert_domains": [],
            "admin_url": ADMIN_DNS_URL, "error": None}


def _empty_serve():
    return {"configured": False, "https": False, "port": None, "target": None, "url": None, "background": None,
            "funnel": False, "conflict": None, "entries": [], "raw": None, "error": None}


def parse_status(d, ts):
    """`tailscale status --json` → ts(dict) 채우기"""
    me = d.get("Self") if isinstance(d.get("Self"), dict) else {}
    dns = str(me.get("DNSName") or "").strip().rstrip(".").lower()
    tn = d.get("CurrentTailnet") if isinstance(d.get("CurrentTailnet"), dict) else {}
    cert = d.get("CertDomains")
    ips = d.get("TailscaleIPs") or me.get("TailscaleIPs") or []
    ts.update({
        "backend_state": d.get("BackendState"), "running": d.get("BackendState") == "Running",
        "version": d.get("Version"), "dns_name": dns or None, "short_name": dns.split(".", 1)[0] if dns else None,
        "host_name": me.get("HostName"), "ips": [x for x in ips if isinstance(x, str)] if isinstance(ips, list) else [],
        "tailnet": tn.get("Name"), "magic_dns_suffix": d.get("MagicDNSSuffix") or tn.get("MagicDNSSuffix"),
        "https_enabled": isinstance(cert, list) and any(isinstance(c, str) and c for c in cert),
        "cert_domains": [c for c in cert if isinstance(c, str)] if isinstance(cert, list) else [],
    })
    # 테일넷 사용자 = 이 Mac + 피어 기기의 주인. 우리 기기를 공유받은 손님 기기(ShareeNode)·태그 기기(로그인에 @ 없음)는 제외
    umap = d.get("User") if isinstance(d.get("User"), dict) else {}
    peers = d.get("Peer") if isinstance(d.get("Peer"), dict) else {}
    owners = [me.get("UserID")]
    owners += [p.get("UserID") for p in peers.values() if isinstance(p, dict) and not p.get("ShareeNode")]
    users, seen = [], set()
    for uid in owners:
        u = umap.get(str(uid)) if uid is not None else None
        login = u.get("LoginName") if isinstance(u, dict) else None
        if isinstance(login, str) and "@" in login and login.lower() not in seen:
            seen.add(login.lower())
            users.append({"login": login, "name": u.get("DisplayName") or None})
    ts["users"] = users
    mine = umap.get(str(me.get("UserID"))) if me.get("UserID") is not None else None
    ts["self_login"] = mine.get("LoginName") if isinstance(mine, dict) else None


def _handler_target(h):
    if not isinstance(h, dict):
        return str(h)
    if h.get("Proxy"):
        return str(h["Proxy"])
    if h.get("Path"):
        return "file://" + str(h["Path"])
    if "Text" in h:
        return "(텍스트 응답)"
    return json.dumps(h, ensure_ascii=False)[:200]


def is_studio_target(target, port):
    """Serve 프록시 대상이 이 Studio(http://127.0.0.1:<port>)인지"""
    t = str(target or "").strip()
    if not t:
        return False
    if t.isdigit():
        return int(t) == port
    if "://" not in t:
        t = "http://" + t
    try:
        u = urlsplit(t)
        return u.scheme == "http" and (u.hostname or "") in LOOPBACK_TARGETS and u.port == port
    except ValueError:
        return False


def parse_serve(cfg, port):
    """`tailscale serve status --json` → serve(dict). 우리 대상(루트 '/' → 127.0.0.1:<port>)과 443의 다른 설정을 가린다."""
    sv = _empty_serve()
    sv["raw"] = cfg
    entries = []

    def walk(c, background):
        if not isinstance(c, dict):
            return
        tcp = c.get("TCP") if isinstance(c.get("TCP"), dict) else {}
        webcfg = c.get("Web") if isinstance(c.get("Web"), dict) else {}
        funnel = c.get("AllowFunnel") if isinstance(c.get("AllowFunnel"), dict) else {}
        web_ports = set()
        for hostport, wc in webcfg.items():
            host, _, p = str(hostport).rpartition(":")
            try:
                pnum = int(p)
            except ValueError:
                continue
            web_ports.add(pnum)
            th = tcp.get(str(pnum)) if isinstance(tcp.get(str(pnum)), dict) else {}
            scheme = "http" if th.get("HTTP") and not th.get("HTTPS") else "https"
            handlers = wc.get("Handlers") if isinstance(wc, dict) and isinstance(wc.get("Handlers"), dict) else {}
            for mount, h in handlers.items():
                target = _handler_target(h)
                entries.append({"host": host.lower().rstrip("."), "port": pnum, "scheme": scheme, "path": mount,
                                "target": target, "ours": mount == "/" and is_studio_target(target, port),
                                "funnel": bool(funnel.get(hostport)), "background": background})
        for p, th in tcp.items():
            try:
                pnum = int(p)
            except ValueError:
                continue
            if pnum in web_ports or not isinstance(th, dict):
                continue
            if th.get("TCPForward"):
                entries.append({"host": None, "port": pnum, "scheme": "tcp", "path": None,
                                "target": "tcp://" + str(th["TCPForward"]), "ours": False,
                                "funnel": False, "background": background})

    walk(cfg, True)
    if isinstance(cfg.get("Foreground"), dict):  # --bg 없이(터미널에서) 실행 중인 설정
        for c in cfg["Foreground"].values():
            walk(c, False)
    sv["entries"] = entries
    ours = sorted((e for e in entries if e["ours"]),
                  key=lambda e: (e["port"] != SERVE_PORT, e["scheme"] != "https", not e["background"]))
    others443 = [e for e in entries if e["port"] == SERVE_PORT and not e["ours"]]
    if others443:
        sv["conflict"] = "; ".join(f"{e['path'] or '(TCP)'} → {e['target']}" for e in others443)
    if ours:
        e = ours[0]
        default_port = (e["scheme"] == "https" and e["port"] == 443) or (e["scheme"] == "http" and e["port"] == 80)
        sv.update({"configured": True, "https": e["scheme"] == "https", "port": e["port"], "target": e["target"],
                   "background": e["background"], "funnel": any(x["funnel"] for x in ours),
                   "url": f"{e['scheme']}://{e['host']}/" if default_port else f"{e['scheme']}://{e['host']}:{e['port']}/"})
    elif others443:
        sv["target"] = others443[0]["target"]
    return sv


def _warnings(ts, sv, rs, app_session=True):
    w = []
    if not app_session:
        w.append("이 Studio는 VN Studio.app이 아닌 방법(터미널·자동 실행)으로 켜져 있어 원격 접속을 받지 않습니다"
                 "(Tailscale Serve도 붙이지 않음). 원격 접속이 필요하면 Studio를 종료하고 VN Studio.app으로 다시 여세요.")
    if not ts["installed"]:
        w.append(f"Tailscale이 설치되어 있지 않습니다. {DOWNLOAD_URL} 에서 macOS용 Tailscale을 설치하고 로그인하세요.")
    elif not ts["running"]:
        if ts.get("error"):
            w.append(f"Tailscale 상태를 확인하지 못했습니다: {ts['error']} (Tailscale 앱이 실행 중인지 확인하세요)")
        else:
            w.append(f"Tailscale이 연결되어 있지 않습니다(상태: {ts.get('backend_state') or '알 수 없음'}). "
                     "메뉴 막대의 Tailscale 아이콘에서 로그인·연결하세요.")
    elif not ts["https_enabled"]:
        w.append(HTTPS_OFF_MSG)
    if sv.get("error") and ts["running"]:
        w.append(f"Tailscale Serve 설정을 확인하지 못했습니다: {sv['error']}")
    if sv["funnel"]:
        w.append("⚠️ Funnel(인터넷 공개)이 켜져 있어 테일넷 밖에서도 이 주소에 닿을 수 있습니다(Studio는 신원 헤더가 없는 요청을 "
                 "거부합니다). Mac 터미널에서 tailscale funnel --https=443 off 로 끄세요.")
    if sv["conflict"]:
        w.append(f"443 포트(HTTPS)는 이미 다른 대상에 연결되어 있습니다: {sv['conflict']}. "
                 "덮어쓰지 않으니 그 설정을 먼저 정리하세요(터미널: tailscale serve status).")
    if app_session and rs["enabled"] and ts["running"] and not sv["configured"] and not sv.get("error"):
        w.append("Studio는 원격 요청을 받도록 켜져 있지만 Tailscale Serve 설정이 없어 다른 기기에서 접속할 수 없습니다. "
                 "[원격 접속 켜기]를 다시 누르세요.")
    if sv["configured"] and not rs["enabled"]:
        w.append("Tailscale Serve는 Studio를 테일넷에 연결하고 있지만 Studio의 원격 허용이 꺼져 있어 원격 요청은 모두 거부(403)됩니다.")
    if sv["configured"] and sv["background"] is False:
        w.append("Serve가 터미널(포그라운드)에서 실행 중이라 그 터미널을 닫으면 꺼집니다.")
    if rs["enabled"] and ts["dns_name"] and ts["dns_name"] not in rs["host_set"]:
        w.append(f"이 Mac의 테일넷 주소({ts['dns_name']})가 저장된 원격 주소와 다릅니다. [원격 접속 켜기]를 다시 누르세요.")
    if rs["enabled"] and not rs["allowed"]:
        w.append("허용할 로그인이 없어 모든 원격 요청이 거부됩니다. 허용할 로그인을 추가하세요.")
    known = {u["login"].lower() for u in ts["users"]}
    if known:
        unknown = [x for x in rs["logins"] if x.lower() not in known]
        if unknown:
            w.append("테일넷 사용자 목록에 없는 로그인이 허용 목록에 있습니다: " + ", ".join(unknown))
    return w


# ====================================================================== 상태 캐시 + API
class Remote:
    def __init__(self, port, app_session=False):
        self.port = port
        self.app_session = app_session  # VN Studio.app(--app)으로 띄운 서버인지 — 원격 접속·Serve의 전제
        self._info = None        # {"tailscale", "serve", "at"}
        self._info_at = 0.0      # monotonic
        self._info_seq = 0
        self._seq = 0
        self._task = None
        self._op_lock = asyncio.Lock()  # 켜기/끄기/허용 목록 저장이 겹치지 않게

    # 테스트에서 바꿔 끼우는 곳 (CLI 위치·실행)
    def cli_path(self):
        return find_cli()

    async def run(self, args, timeout):
        path = self.cli_path()
        if not path:
            return {"rc": None, "out": "", "err": "Tailscale CLI를 찾을 수 없습니다", "timed_out": False}
        return await run_cli(path, args, timeout)

    # ------------------------------------------------------------ 상태 (10초 캐시)
    def fresh(self):
        return self._info is not None and time.monotonic() - self._info_at < CACHE_TTL

    async def info(self, force=False):
        if not force and self.fresh():
            return self._info
        if not force and self._task is not None and not self._task.done():
            return await asyncio.shield(self._task)
        self._task = asyncio.ensure_future(self._refresh())
        return await asyncio.shield(self._task)

    def kick(self):
        """오래된 캐시면 백그라운드로 새로 읽기 (/api/status 가 기다리지 않게)"""
        if self.fresh() or (self._task is not None and not self._task.done()):
            return
        self._task = asyncio.ensure_future(self._refresh())

    async def close(self):
        if self._task is not None and not self._task.done():
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)

    async def _refresh(self):
        self._seq += 1
        seq = self._seq
        try:
            data = await self._fetch()
        except asyncio.CancelledError:
            raise
        except Exception as e:  # 상태 확인이 실패해도 서버는 계속
            log.exception("Tailscale 상태 확인 실패")
            ts = _empty_tailscale(self.cli_path())
            ts["error"] = f"{e.__class__.__name__}: {e}"[:300]
            data = {"tailscale": ts, "serve": _empty_serve(), "at": time.time()}
        if seq >= self._info_seq:  # 늦게 끝난 이전 확인이 새 결과를 덮지 않게
            self._info, self._info_at, self._info_seq = data, time.monotonic(), seq
        return data

    async def _fetch(self):
        path = self.cli_path()
        ts, sv = _empty_tailscale(path), _empty_serve()
        if not path:
            ts["error"] = "Tailscale이 설치되어 있지 않습니다"
            return {"tailscale": ts, "serve": sv, "at": time.time()}
        st_res, sv_res = await asyncio.gather(self.run(["status", "--json"], STATUS_TIMEOUT),
                                              self.run(["serve", "status", "--json"], STATUS_TIMEOUT))
        st, err = _json_from(st_res)
        if st is None:
            ts["error"] = err
        else:
            parse_status(st, ts)
        cfg, err = _json_from(sv_res)
        if cfg is None:
            sv["error"] = err
        else:
            sv = parse_serve(cfg, self.port)
        return {"tailscale": ts, "serve": sv, "at": time.time()}

    def brief(self):
        """/api/status·SSE status 용 {enabled, url} — CLI를 부르지 않고 캐시만 쓴다"""
        try:
            enabled = remote_settings()["enabled"]
        except (config.ConfigError, OSError):  # 상태 점검 루프가 설정 파일 문제로 멈추지 않게
            enabled = False
        sv = (self._info or {}).get("serve") or {}
        enabled = enabled and self.app_session
        return {"enabled": enabled, "url": sv.get("url") if enabled and sv.get("configured") else None,
                "app_session": self.app_session}

    async def payload(self, client, force=False):
        """GET /api/remote"""
        info = await self.info(force)
        rs = remote_settings()
        ts, sv = dict(info["tailscale"]), dict(info["serve"])
        return {"tailscale": ts, "serve": sv,
                "settings": {"remote_enabled": rs["enabled"], "remote_allowed_logins": list(rs["logins"]),
                             "remote_hosts": list(rs["hosts"])},
                "client": client, "port": self.port, "checked_at": info.get("at"),
                "app_session": self.app_session,
                "warnings": _warnings(ts, sv, rs, self.app_session)}

    # ------------------------------------------------------------ 앱 세션에 묶인 Serve (시작/종료 때 자동)
    async def _serve_off_ours(self, why):
        """443 에 우리(Studio) 대상만 있을 때 Serve 를 뗀다. 다른 설정이 섞여 있으면 건드리지 않는다."""
        info = await self.info(force=True)
        sv = info["serve"]
        if sv.get("error") or sv["conflict"] or not any(e["port"] == SERVE_PORT and e["ours"] for e in sv["entries"]):
            return
        log.info("Tailscale Serve 끄기(%s): serve --https=%d off", why, SERVE_PORT)
        res = await self.run(["serve", f"--https={SERVE_PORT}", "off"], SERVE_TIMEOUT)
        if not _cli_ok(res):
            log.warning("Tailscale Serve를 끄지 못했습니다: %s (원격 요청은 Studio가 거부합니다)", _summarize(res))
        self._info_at = 0.0  # 다음 확인 때 새로 읽기

    async def session_start(self):
        """서버 시작 직후(백그라운드). 앱 세션 + 원격 허용이면 Serve 를 붙이고, 앱 세션이 아니면 남은 Serve 를 걷어 낸다."""
        try:
            async with self._op_lock:
                if not self.app_session:
                    await self._serve_off_ours("앱 세션 아님")
                    return
                if not remote_settings()["enabled"]:
                    return
                info = await self.info(force=True)
                ts, sv = info["tailscale"], info["serve"]
                if not ts["running"] or not ts["https_enabled"] or sv.get("error") or sv["conflict"]:
                    log.warning("앱 세션 시작: Tailscale 준비가 안 되어 Serve를 붙이지 않았습니다 (설정 화면에서 확인)")
                    return
                if sv["configured"] and sv["port"] == SERVE_PORT and sv["https"]:
                    return
                target = f"http://127.0.0.1:{self.port}"
                log.info("앱 세션 시작 → Tailscale Serve 켜기: serve --bg --https=%d %s", SERVE_PORT, target)
                res = await self.run(["serve", "--bg", f"--https={SERVE_PORT}", target], SERVE_TIMEOUT)
                if not _cli_ok(res):
                    log.warning("Tailscale Serve를 켜지 못했습니다: %s", _summarize(res))
                await self.info(force=True)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("앱 세션 시작 처리 실패")

    async def session_end(self):
        """서버 종료 때. 앱 세션이었다면 Serve 를 떼어 테일넷 443 을 닫는다 (원격 허용 설정은 그대로 둠)."""
        if not self.app_session:
            return
        try:
            await asyncio.wait_for(self._serve_off_ours("Studio 종료"), SERVE_TIMEOUT + STATUS_TIMEOUT + 2)
        except Exception as e:
            log.warning("종료 중 Serve 정리 실패: %s", e)

    # ------------------------------------------------------------ 켜기 / 끄기 / 허용 목록 (로컬 전용)
    async def enable(self, client):
        if not self.app_session:
            raise ApiError(409, "원격 접속은 VN Studio.app으로 연 Studio에서만 켤 수 있습니다. 지금 Studio는 터미널·자동 실행 등으로 "
                                "켜져 있습니다. Studio를 종료하고 VN Studio.app으로 다시 연 뒤 누르세요.", code="no_app_session")
        async with self._op_lock:
            info = await self.info(force=True)
            ts, sv = info["tailscale"], info["serve"]
            if not ts["installed"]:
                raise ApiError(409, f"Tailscale이 설치되어 있지 않습니다. {DOWNLOAD_URL} 에서 설치하고 로그인한 뒤 다시 누르세요.",
                               code="tailscale_missing")
            if not ts["running"]:
                detail = ts.get("error") or f"상태: {ts.get('backend_state') or '알 수 없음'}"
                raise ApiError(409, f"Tailscale이 연결되어 있지 않습니다({detail}). 메뉴 막대의 Tailscale 아이콘에서 "
                                    "로그인·연결한 뒤 다시 누르세요.", code="tailscale_stopped")
            if not ts["dns_name"]:
                raise ApiError(409, "이 Mac의 테일넷 이름(MagicDNS)을 확인할 수 없습니다. Tailscale 관리 화면"
                                    f"({ADMIN_DNS_URL})에서 MagicDNS를 켜세요.", code="no_magicdns", admin_url=ADMIN_DNS_URL)
            if not ts["https_enabled"]:
                raise ApiError(409, HTTPS_OFF_MSG, code="https_disabled", admin_url=ADMIN_DNS_URL)
            if sv.get("error"):
                raise ApiError(409, f"Tailscale Serve 설정을 확인하지 못했습니다: {sv['error']}", code="serve_unknown")
            if sv["conflict"]:
                raise ApiError(409, f"443 포트(HTTPS)는 이미 다른 대상에 연결되어 있어 덮어쓰지 않았습니다: {sv['conflict']}. "
                                    "그 설정이 필요 없다면 Mac 터미널에서 tailscale serve --https=443 off 로 지운 뒤 다시 누르세요.",
                               code="serve_conflict", conflict=sv["conflict"])
            rs = remote_settings()
            if not rs["logins"] and not ts["users"]:
                raise ApiError(409, "허용할 테일넷 사용자를 확인할 수 없습니다. Tailscale에 로그인했는지 확인하세요.",
                               code="no_users")
            ours443 = sv["configured"] and sv["port"] == SERVE_PORT and sv["https"]
            output = None
            if not ours443:
                target = f"http://127.0.0.1:{self.port}"
                log.info("Tailscale Serve 켜기: serve --bg --https=%d %s", SERVE_PORT, target)
                res = await self.run(["serve", "--bg", f"--https={SERVE_PORT}", target], SERVE_TIMEOUT)
                output = _summarize(res)
                if not _cli_ok(res):
                    raise ApiError(500, self._serve_failed_message(res, output), code="serve_failed",
                                   output=output, links=_links(res))
                info = await self.info(force=True)
                sv = info["serve"]
                if not (sv["configured"] and sv["port"] == SERVE_PORT):
                    raise ApiError(500, "Tailscale Serve 명령은 끝났지만 설정에서 Studio를 찾을 수 없습니다: " + (output or "출력 없음"),
                                   code="serve_failed", output=output, links=_links(res))
            dns = ts["dns_name"]
            hosts = [h for h in dict.fromkeys([dns, ts["short_name"]]) if h]
            s = config.load_settings()  # 저장 직전에 다시 읽음 (그사이 바뀐 허용 목록 보존)
            changes = {"remote_enabled": True, "remote_hosts": hosts}
            if not _str_list(s.get("remote_allowed_logins")):
                changes["remote_allowed_logins"] = [u["login"] for u in ts["users"]]
            _save_remote(**changes)
            log.info("원격 접속 켜짐: https://%s/ (허용: %s)", dns, ", ".join(remote_settings()["logins"]))
            res = await self.payload(client)
            url = res["serve"].get("url") or f"https://{dns}/"
            res.update(ok=True, output=output, message=f"원격 접속을 켰습니다. 같은 테일넷의 기기에서 {url} 로 접속하세요.")
            return res

    @staticmethod
    def _serve_failed_message(res, output):
        text = ((res.get("out") or "") + (res.get("err") or "")).lower()
        msg = "Tailscale Serve를 켜지 못했습니다"
        if res.get("timed_out"):
            msg += f"({SERVE_TIMEOUT}초 안에 끝나지 않음)"
        msg += ": " + (output or "출력 없음")
        if "gui failed" in text or ("https" in text and "enable" in text):
            msg += " — HTTPS 인증서가 꺼져 있으면 이렇게 실패합니다. 관리 화면(" + ADMIN_DNS_URL + ")에서 켠 뒤 다시 누르세요."
        elif "not enabled" in text or "to enable" in text or "visit" in text:
            msg += " — 테일넷에서 Serve 사용을 허용해야 합니다. 출력의 링크를 열어 허용한 뒤 다시 누르세요."
        return msg

    async def disable(self, client):
        async with self._op_lock:
            _save_remote(remote_enabled=False)  # 먼저 Studio에서 막는다 (Serve 끄기가 실패해도 원격 요청은 403)
            log.info("원격 접속 꺼짐")
            info = await self.info(force=True)
            sv = info["serve"]
            ours443 = [e for e in sv["entries"] if e["port"] == SERVE_PORT and e["ours"]]
            message, extra_warn, output = "원격 접속을 껐습니다.", [], None
            if ours443 and not sv["conflict"]:
                log.info("Tailscale Serve 끄기: serve --https=%d off", SERVE_PORT)
                res = await self.run(["serve", f"--https={SERVE_PORT}", "off"], SERVE_TIMEOUT)
                output = _summarize(res)
                if _cli_ok(res):
                    message += f" Tailscale Serve 설정({SERVE_PORT})도 껐습니다."
                else:
                    extra_warn.append("Studio의 원격 허용은 껐지만(원격 요청은 거부됨) Tailscale Serve 설정을 끄지 못했습니다: "
                                      + (output or "출력 없음"))
                await self.info(force=True)
            elif ours443:
                message += f" {SERVE_PORT} 포트에 다른 Serve 설정도 함께 있어 그대로 두었습니다(원격 요청은 Studio가 거부합니다)."
            elif sv["configured"]:
                message += f" {sv['port']} 포트의 Serve 설정은 Studio가 만든 것이 아니라 그대로 두었습니다(원격 요청은 Studio가 거부합니다)."
            res = await self.payload(client)
            res["warnings"] = extra_warn + res["warnings"]
            res.update(ok=True, output=output, message=message)
            return res

    async def update(self, body, client):
        """PUT /api/remote {remote_allowed_logins: [...]}"""
        if "remote_allowed_logins" not in body:
            raise ApiError(400, "remote_allowed_logins 값이 필요합니다")
        logins = clean_remote_logins(body.get("remote_allowed_logins"))
        async with self._op_lock:
            _save_remote(remote_allowed_logins=logins)
        log.info("원격 접속 허용 로그인 변경: %s", ", ".join(logins))
        res = await self.payload(client)
        res.update(ok=True, message="허용할 로그인을 저장했습니다.",
                   ignored=[k for k in body if k != "remote_allowed_logins"])
        return res
