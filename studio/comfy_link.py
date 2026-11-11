"""ComfyUI 연동: HTTP 호출, 상시 웹소켓 접속(자동 재접속), 프로세스 시작/중지, 상태 조회, 로그.

브라우저는 ComfyUI에 직접 접근할 수 없으므로(Origin 검사) 모든 통신은 이 모듈을 거친다.
"""
import asyncio
import json
import os
import re
import signal
import subprocess
import time
import uuid
from urllib.parse import urlparse

import aiohttp

from .common import COMFY_LOG, DATA_DIR, ROOT, START_SH, log

ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]")
PID_FILE = DATA_DIR / "comfy_pid.json"
CLIENT_ID_FILE = DATA_DIR / "client_id"
START_TIMEOUT = 300  # 첫 실행은 커스텀 노드 로딩 때문에 오래 걸릴 수 있음


class ComfyError(Exception):
    """ComfyUI 통신 실패의 기본 클래스"""


class ComfyDown(ComfyError):
    """연결 자체가 안 됨 (꺼져 있음)"""


class ComfyTimeout(ComfyError):
    """응답이 늦음 (바쁘거나 멈춤)"""


def clean_log_line(line):
    """ANSI 색 코드 제거 + '\\r' 진행바는 마지막 상태만 남김"""
    line = ANSI_RE.sub("", line)
    if "\r" in line:
        segs = [s for s in line.split("\r") if s.strip()]
        line = segs[-1] if segs else ""
    return line.rstrip()


def _pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


async def _run(*cmd, timeout=5):
    try:
        p = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE,
                                                 stderr=asyncio.subprocess.DEVNULL)
        out, _ = await asyncio.wait_for(p.communicate(), timeout)
        return out.decode("utf-8", "replace")
    except (OSError, asyncio.TimeoutError):
        return ""


async def _cmdline(pid):
    return (await _run("/bin/ps", "-o", "command=", "-p", str(pid))).strip()


def _started_matches(pid, started, tolerance=60):
    """PID 재사용 방지: 기록된 시작 시각과 실제 프로세스 시작 시각이 tolerance초 이내인지"""
    try:
        started = float(started)
    except (TypeError, ValueError):
        return False
    try:
        et = subprocess.run(["/bin/ps", "-o", "etime=", "-p", str(pid)],
                            capture_output=True, text=True, timeout=3).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return False
    m = re.fullmatch(r"(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)", et)
    if not m:
        return False
    d, h, mi, se = (int(x) if x else 0 for x in m.groups())
    elapsed = ((d * 24 + h) * 60 + mi) * 60 + se
    return abs((time.time() - elapsed) - started) <= tolerance


class ComfyLink:
    def __init__(self, hub, url):
        self.hub = hub
        self.url = (url or "http://127.0.0.1:8188").rstrip("/")
        u = urlparse(self.url)
        self.host = u.hostname or "127.0.0.1"
        self.port = u.port or 8188
        self.ws_url = ("wss" if u.scheme == "https" else "ws") + f"://{u.netloc}/ws"
        self.client_id = self._load_client_id()
        self.session = None

        # 상태
        self.running = False
        self.version = None
        self.ram_free = None
        self.queue_running_ids = []
        self.queue_pending_ids = []
        self.queue_ok_at = 0.0       # 마지막으로 /queue 를 성공적으로 읽은 시각
        self.down_count = 0          # 연속 '연결 거부' 횟수
        self.last_stats = 0.0
        self.last_error = None
        self.ws_connected = False

        # 프로세스 관리
        self.proc = None             # studio가 띄운 Popen
        self.adopted_pid = None      # 이전 studio 실행에서 띄운 프로세스(재시작 후 인계)
        self.starting = False
        self.start_deadline = 0.0
        self.stopping = False

        # 콜백 (JobManager가 연결)
        self.on_json = None
        self.on_binary = None
        self.on_connect = None
        self.on_change = None        # 상태가 바뀌면 status 이벤트를 빨리 보내도록

        self._lock = asyncio.Lock()
        self._wake = asyncio.Event()
        self._samplers = None

    # ------------------------------------------------------------------ 기본
    @staticmethod
    def _load_client_id():
        """studio 재시작 후에도 같은 client_id를 써야 진행 중 작업의 진행/미리보기 메시지를 계속 받는다."""
        try:
            cid = CLIENT_ID_FILE.read_text().strip()
            if re.fullmatch(r"[0-9a-f]{32}", cid):
                return cid
        except OSError:
            pass
        cid = uuid.uuid4().hex
        try:
            CLIENT_ID_FILE.parent.mkdir(parents=True, exist_ok=True)
            CLIENT_ID_FILE.write_text(cid)
        except OSError:
            pass
        return cid

    async def open(self):
        self.session = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=None, connect=3, sock_connect=3),
            headers={"User-Agent": "VN-Studio/1.0"})
        self._adopt_previous()

    async def close(self):
        if self.session:
            await self.session.close()

    def wake(self):
        self._wake.set()

    async def wait_wake(self, timeout):
        try:
            await asyncio.wait_for(self._wake.wait(), timeout)
        except asyncio.TimeoutError:
            pass
        self._wake.clear()

    def _changed(self):
        if self.on_change:
            try:
                self.on_change()
            except Exception:
                log.exception("상태 변경 알림 실패")

    # ------------------------------------------------------------------ HTTP
    async def request(self, method, path, body=None, timeout=10):
        """→ (status, json|None). 연결 실패는 ComfyDown, 시간 초과는 ComfyTimeout."""
        try:
            async with self.session.request(
                    method, self.url + path, json=body,
                    timeout=aiohttp.ClientTimeout(total=timeout, connect=3, sock_connect=3)) as r:
                text = await r.text()
                try:
                    data = json.loads(text) if text else None
                except ValueError:
                    data = {"_text": text[:2000]}
                return r.status, data
        except (aiohttp.ClientConnectorError, aiohttp.ServerDisconnectedError, ConnectionRefusedError) as e:
            raise ComfyDown(str(e)) from None
        except asyncio.TimeoutError:
            raise ComfyTimeout("시간 초과") from None
        except aiohttp.ClientError as e:
            raise ComfyDown(str(e)) from None

    async def get_json(self, path, timeout=10):
        status, data = await self.request("GET", path, timeout=timeout)
        if status != 200:
            raise ComfyError(f"ComfyUI 응답 오류 {status}")
        return data

    async def post_json(self, path, body, timeout=15):
        return await self.request("POST", path, body, timeout=timeout)

    # ------------------------------------------------------------------ 상태
    async def refresh(self, stats=False):
        """/queue (+ 가끔 /system_stats) 로 상태 갱신. 실패해도 예외를 던지지 않는다."""
        prev = (self.running, self.starting, self.version)
        self._check_proc()
        try:
            q = await self.get_json("/queue", timeout=4)
            if not self.running:
                self.last_error = None  # 다시 응답하기 시작함 → 이전 오류 메시지는 의미 없음
            self.running = True
            self.down_count = 0
            self.queue_ok_at = time.time()
            self.queue_running_ids = [it[1] for it in (q or {}).get("queue_running", []) if len(it) > 1]
            pend = sorted(((it[0], it[1]) for it in (q or {}).get("queue_pending", []) if len(it) > 1),
                          key=lambda x: x[0])
            self.queue_pending_ids = [p for _, p in pend]
            if self.starting:
                self.starting = False
                self.last_error = None
                log.info("ComfyUI 준비 완료")
            if stats or self.version is None or time.time() - self.last_stats > 10:
                try:
                    s = await self.get_json("/system_stats", timeout=4)
                    sysinfo = (s or {}).get("system", {})
                    self.version = sysinfo.get("comfyui_version") or self.version or "?"
                    self.ram_free = sysinfo.get("ram_free")
                    self.last_stats = time.time()
                except ComfyError:
                    pass
        except ComfyTimeout:
            pass  # 바쁜 상태일 수 있음 → 이전 값 유지
        except ComfyDown:
            self.running = False
            self.down_count += 1
            self.version = None
            self.ram_free = None
            self.queue_running_ids, self.queue_pending_ids = [], []
        except ComfyError:
            pass  # 응답은 했지만 오류 → 이전 값 유지
        if self.starting and time.time() > self.start_deadline:
            self.starting = False
            self.last_error = "ComfyUI 시작 대기 시간이 초과되었습니다. 'ComfyUI 로그'를 확인하세요."
        if prev != (self.running, self.starting, self.version):
            self._changed()

    def managed(self):
        if self.proc is not None and self.proc.poll() is None:
            return True
        return bool(self.adopted_pid and _pid_alive(self.adopted_pid))

    def payload(self):
        return {
            "running": self.running,
            "managed": self.managed(),
            "starting": self.starting,
            "url": self.url,
            "version": self.version if self.running else None,
            "queue_running": len(self.queue_running_ids) if self.running else 0,
            "queue_pending": len(self.queue_pending_ids) if self.running else 0,
            "ram_free": self.ram_free if self.running else None,
            "error": self.last_error,
            "ws": self.ws_connected,
        }

    async def samplers(self):
        """ComfyUI에서 샘플러/스케줄러 목록. 실패 시 None (호출 측이 기본 목록 사용)."""
        if self._samplers:
            return self._samplers
        try:
            info = await self.get_json("/object_info/KSampler", timeout=6)
            req = info["KSampler"]["input"]["required"]

            def opts(v):
                if isinstance(v, list) and v:
                    if isinstance(v[0], list):
                        return [str(x) for x in v[0]]
                    if v[0] == "COMBO" and len(v) > 1 and isinstance(v[1], dict):
                        return [str(x) for x in v[1].get("options", [])]
                return None

            s, sc = opts(req.get("sampler_name")), opts(req.get("scheduler"))
            if s and sc:
                self._samplers = (s, sc)
                return self._samplers
        except (ComfyError, KeyError, TypeError, ValueError):
            pass
        return None

    # ------------------------------------------------------------------ 웹소켓
    async def ws_loop(self):
        """상시 접속. 끊기면 2초 간격으로 재접속."""
        url = f"{self.ws_url}?clientId={self.client_id}"
        while True:
            try:
                async with self.session.ws_connect(
                        url, heartbeat=20, max_msg_size=0,
                        timeout=aiohttp.ClientWSTimeout(ws_close=5)) as ws:
                    self.ws_connected = True
                    log.info("ComfyUI 웹소켓 연결됨")
                    # 메타데이터 포함 미리보기(prompt_id 포함)를 받기 위한 기능 협상 (첫 메시지여야 함)
                    await ws.send_json({"type": "feature_flags", "data": {"supports_preview_metadata": True}})
                    self._changed()
                    self.wake()
                    if self.on_connect:
                        asyncio.create_task(self._safe(self.on_connect()))
                    async for msg in ws:
                        if msg.type == aiohttp.WSMsgType.TEXT:
                            try:
                                data = json.loads(msg.data)
                            except ValueError:
                                continue
                            if isinstance(data, dict) and self.on_json:
                                try:
                                    self.on_json(data)
                                except Exception:
                                    log.exception("웹소켓 메시지 처리 실패: %s", str(msg.data)[:200])
                        elif msg.type == aiohttp.WSMsgType.BINARY:
                            if self.on_binary:
                                try:
                                    self.on_binary(msg.data)
                                except Exception:
                                    log.exception("미리보기 처리 실패")
                        elif msg.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSE,
                                          aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.CLOSING):
                            break
            except asyncio.CancelledError:
                raise
            except (aiohttp.ClientError, OSError, asyncio.TimeoutError):
                pass
            except Exception:
                log.exception("웹소켓 루프 오류")
            if self.ws_connected:
                self.ws_connected = False
                log.info("ComfyUI 웹소켓 연결 끊김")
                self._changed()
                self.wake()
            await asyncio.sleep(2)

    @staticmethod
    async def _safe(coro):
        try:
            await coro
        except Exception:
            log.exception("백그라운드 작업 실패")

    # ------------------------------------------------------------------ 프로세스
    def _adopt_previous(self):
        """이전 studio 가 띄운 ComfyUI 가 아직 살아 있으면 'studio가 관리하는 프로세스'로 인계."""
        try:
            info = json.loads(PID_FILE.read_text())
            pid = int(info["pid"])
        except (OSError, ValueError, KeyError, TypeError):
            return
        if _pid_alive(pid):
            try:
                out = subprocess.run(["/bin/ps", "-o", "command=", "-p", str(pid)],
                                     capture_output=True, text=True, timeout=3).stdout
            except (OSError, subprocess.SubprocessError):
                out = ""
            if "main.py" in out and _started_matches(pid, info.get("started")):
                self.adopted_pid = pid
                log.info("이전에 시작한 ComfyUI(PID %s)를 인계받음", pid)
                return
        self._clear_pid_file()

    def _write_pid_file(self, pid):
        try:
            PID_FILE.parent.mkdir(parents=True, exist_ok=True)
            PID_FILE.write_text(json.dumps({"pid": pid, "started": time.time()}))
        except OSError:
            pass

    @staticmethod
    def _clear_pid_file():
        try:
            PID_FILE.unlink()
        except OSError:
            pass

    def _check_proc(self):
        """studio가 띄운 프로세스가 죽었는지 확인 (좀비 회수 포함)"""
        if self.proc is not None:
            rc = self.proc.poll()
            if rc is not None:
                if self.starting:
                    self.starting = False
                    self.last_error = (f"ComfyUI가 시작 도중 종료되었습니다 (종료 코드 {rc}). "
                                       "'ComfyUI 로그'에서 원인을 확인하세요.")
                elif not self.stopping:
                    self.last_error = f"ComfyUI 프로세스가 종료되었습니다 (종료 코드 {rc})."
                log.warning("ComfyUI 프로세스 종료 (코드 %s)", rc)
                self.proc = None
                self._clear_pid_file()
                self._changed()
        if self.adopted_pid and not _pid_alive(self.adopted_pid):
            self.adopted_pid = None
            self._clear_pid_file()

    async def port_open(self):
        try:
            _, w = await asyncio.wait_for(asyncio.open_connection(self.host, self.port), 1.5)
            w.close()
            try:
                await w.wait_closed()
            except OSError:
                pass
            return True
        except (OSError, asyncio.TimeoutError):
            return False

    async def start(self):
        async with self._lock:
            return await self._start_locked()

    async def _start_locked(self):
        self._check_proc()
        if self.starting:
            return {"ok": True, "starting": True}
        if self.managed() or await self.port_open():
            await self.refresh(stats=True)
            return {"ok": True, "starting": False, "running": True,
                    "message": "ComfyUI가 이미 실행 중입니다"}
        if not START_SH.exists():
            self.last_error = f"실행 스크립트를 찾을 수 없습니다: {START_SH}"
            self._changed()
            return {"ok": False, "starting": False, "error": self.last_error}
        COMFY_LOG.parent.mkdir(parents=True, exist_ok=True)
        env = dict(os.environ, PYTHONUNBUFFERED="1")
        with open(COMFY_LOG, "ab") as logf:
            logf.write(f"\n===== VN Studio: ComfyUI 시작 {time.strftime('%Y-%m-%d %H:%M:%S')} =====\n".encode())
            logf.flush()
            # start_new_session: studio 터미널의 Ctrl+C 가 ComfyUI까지 죽이지 않도록 분리
            self.proc = subprocess.Popen(["/bin/zsh", str(START_SH)], cwd=str(ROOT), env=env,
                                         stdin=subprocess.DEVNULL, stdout=logf, stderr=subprocess.STDOUT,
                                         start_new_session=True)
        self.adopted_pid = None
        self._write_pid_file(self.proc.pid)
        self.starting = True
        self.start_deadline = time.time() + START_TIMEOUT
        self.last_error = None
        log.info("ComfyUI 시작 (PID %s)", self.proc.pid)
        self._changed()
        self.wake()
        return {"ok": True, "starting": True}

    async def _listening_pids(self):
        out = await _run("/usr/sbin/lsof", "-nP", f"-tiTCP:{self.port}", "-sTCP:LISTEN")
        pids = []
        for tok in out.split():
            if tok.isdigit() and int(tok) != os.getpid():
                pids.append(int(tok))
        return pids

    async def stop(self, before_kill=None):
        async with self._lock:
            return await self._stop_locked(before_kill)

    async def _stop_locked(self, before_kill=None):
        self._check_proc()
        targets = []   # (pid, 프로세스그룹 종료 여부)
        if self.proc is not None and self.proc.poll() is None:
            targets.append((self.proc.pid, True))
        elif self.adopted_pid and _pid_alive(self.adopted_pid):
            targets.append((self.adopted_pid, False))
        else:
            for pid in await self._listening_pids():
                if "main.py" in await _cmdline(pid):
                    targets.append((pid, False))
        if not targets:
            self.starting = False
            await self.refresh()
            return {"ok": True, "stopped": False, "message": "실행 중인 ComfyUI가 없습니다"}
        self.stopping = True
        self.starting = False
        self._changed()
        try:
            if before_kill:
                try:
                    before_kill()
                except Exception:
                    log.exception("중지 전 처리 실패")
            for pid, group in targets:
                self._signal(pid, signal.SIGTERM, group)
            if not await self._wait_dead(targets, 20):
                log.warning("ComfyUI가 SIGTERM에 응답하지 않아 강제 종료합니다")
                for pid, group in targets:
                    self._signal(pid, signal.SIGKILL, group)
                await self._wait_dead(targets, 5)
            # 포트가 닫힐 때까지 잠깐 대기 (곧바로 재시작할 때 바인드 실패 방지)
            for _ in range(20):
                if not await self.port_open():
                    break
                await asyncio.sleep(0.25)
        finally:
            if self.proc is not None:
                try:
                    self.proc.wait(timeout=0.5)
                except subprocess.TimeoutExpired:
                    pass
            self.proc = None
            self.adopted_pid = None
            self._clear_pid_file()
            self.stopping = False
            self.last_error = None
        log.info("ComfyUI 중지됨")
        await self.refresh()
        self._changed()
        return {"ok": True, "stopped": True}

    @staticmethod
    def _signal(pid, sig, group):
        try:
            if group:
                os.killpg(pid, sig)
            else:
                os.kill(pid, sig)
        except ProcessLookupError:
            pass
        except PermissionError:
            if group:
                try:
                    os.kill(pid, sig)
                except (ProcessLookupError, PermissionError):
                    pass

    async def _alive(self, pid):
        if self.proc is not None and pid == self.proc.pid:
            return self.proc.poll() is None  # 자식 프로세스는 poll 로 좀비 회수
        if not _pid_alive(pid):
            return False
        stat = (await _run("/bin/ps", "-o", "stat=", "-p", str(pid))).strip()
        return bool(stat) and not stat.startswith("Z")  # 좀비(종료됨, 회수 대기)는 죽은 것으로 본다

    async def _wait_dead(self, targets, timeout):
        end = time.time() + timeout
        while time.time() < end:
            alive = False
            for pid, _ in targets:
                if await self._alive(pid):
                    alive = True
                    break
            if not alive:
                return True
            await asyncio.sleep(0.25)
        return False

    async def restart(self, before_kill=None):
        async with self._lock:
            await self._stop_locked(before_kill)
            return await self._start_locked()

    # ------------------------------------------------------------------ 로그
    @staticmethod
    def read_log_tail(lines=200):
        """user/server.log 의 마지막 N줄 (정리된 텍스트)"""
        try:
            size = COMFY_LOG.stat().st_size
        except OSError:
            return []
        chunk = min(size, max(65536, lines * 600))
        with open(COMFY_LOG, "rb") as f:
            f.seek(size - chunk)
            data = f.read(chunk)
        text = data.decode("utf-8", "replace")
        raw = text.split("\n")
        if size > chunk:
            raw = raw[1:]  # 잘린 첫 줄 버림
        out = [clean_log_line(x) for x in raw]
        while out and not out[-1]:
            out.pop()
        return out[-lines:]

    async def log_tail_loop(self):
        """새 로그 줄을 SSE 'log' 이벤트로 보낸다 (선택 기능)."""
        try:
            offset = COMFY_LOG.stat().st_size
        except OSError:
            offset = 0
        carry = b""
        while True:
            await asyncio.sleep(1.0)
            try:
                size = COMFY_LOG.stat().st_size
            except OSError:
                continue
            if size < offset:  # 파일이 새로 만들어짐
                offset, carry = 0, b""
            if size == offset:
                continue
            if size - offset > 262144:
                offset = size - 262144
                carry = b""
            try:
                with open(COMFY_LOG, "rb") as f:
                    f.seek(offset)
                    data = f.read(size - offset)
            except OSError:
                continue
            offset += len(data)
            data = carry + data
            parts = data.split(b"\n")
            carry = parts.pop()
            if len(carry) > 65536:
                carry = carry[-65536:]
            lines = [clean_log_line(p.decode("utf-8", "replace")) for p in parts]
            lines = [x for x in lines if x]
            if lines and self.hub.subs:
                self.hub.publish("log", {"lines": lines[-200:]})
