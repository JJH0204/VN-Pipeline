"""시크릿 모드 — 테스트·시연용 작업을 흔적 없이 지우기.

켜 둔 동안 만든 작업은 job["secret"]=True 로 기록하고, 그림은 output/_secret/ 아래에 저장한다(갤러리·캐릭터 탭에는 보임).
시크릿 모드를 끄거나 Studio를 종료하면 그동안의 작업 기록·그림·썸네일·미리보기·ComfyUI 기록을 지운다(휴지통을 거치지 않음).
Studio가 비정상 종료돼 지우지 못했으면 다음 시작 때 지운다. 시크릿 모드는 서버 메모리에만 있어 재시작하면 꺼진 상태로 시작한다.

지우지 않는 것: 캐릭터 설정·프리셋·LoRA 메모·저장한 포즈처럼 시크릿 모드와 상관없이 사람이 직접 저장한 설정.
"""
import asyncio
import os
import shutil
import sqlite3
import time

from .common import OUTPUT_DIR, log

SECRET_DIR = "_secret"   # output/ 아래 폴더 이름 (숨김 폴더가 아니어야 갤러리·파일 제공이 그대로 동작)
WAIT_SECS = 25           # 끌 때 진행 중인 시크릿 작업이 취소되기를 기다리는 시간


def is_secret_path(rel):
    return isinstance(rel, str) and (rel == SECRET_DIR or rel.startswith(SECRET_DIR + "/"))


def secret_prefix(prefix):
    return f"{SECRET_DIR}/{prefix}"


def _secret_files():
    """output/_secret 아래 파일 → [(rel, size)]"""
    root = OUTPUT_DIR / SECRET_DIR
    out = []
    for d, _dirs, files in os.walk(root):
        for f in files:
            p = os.path.join(d, f)
            try:
                size = os.lstat(p).st_size
            except OSError:
                size = 0
            out.append((os.path.relpath(p, OUTPUT_DIR).replace(os.sep, "/"), size))
    return out


class Secret:
    def __init__(self, jobs, gallery, comfy, hub=None, on_change=None):
        self.jobs = jobs
        self.gallery = gallery
        self.comfy = comfy
        self.hub = hub
        self.on_change = on_change
        self.enabled = False
        self.since = None
        self._lock = asyncio.Lock()
        self._purging = False
        self._orphan_task = None
        jobs.secret = self

    # ------------------------------------------------------------ 상태
    def brief(self):
        return {"enabled": self.enabled, "since": self.since, "purging": self._purging}

    def _changed(self):
        if self.on_change:
            try:
                self.on_change()
            except Exception:
                log.exception("시크릿 상태 알림 실패")

    # DB(sqlite3 연결)는 만든 스레드(이벤트 루프)에서만 쓸 수 있다 → DB 호출은 to_thread 로 보내지 않는다
    def leftovers(self):
        """지울 것이 남아 있는지 (파일 또는 DB 기록)"""
        if (OUTPUT_DIR / SECRET_DIR).exists() or (OUTPUT_DIR / ".trash" / SECRET_DIR).exists():
            return True
        try:
            return bool(self.jobs.store.secret_job_ids())
        except sqlite3.Error:
            log.exception("시크릿 기록 확인 실패")
            return True  # 모르면 지우는 쪽으로

    async def usage(self):
        files = await asyncio.to_thread(_secret_files)
        try:
            n_jobs = len(self.jobs.store.secret_job_ids())
        except sqlite3.Error:
            n_jobs = 0
        return {"files": len(files), "bytes": sum(s for _, s in files), "jobs": n_jobs}

    # ------------------------------------------------------------ 켜기 / 끄기
    async def enable(self):
        async with self._lock:
            if not self.enabled:
                self.enabled, self.since = True, time.time()
                log.info("시크릿 모드 켜짐")
        self._changed()
        return {**self.brief(), **await self.usage()}

    async def disable(self):
        async with self._lock:
            self.enabled, self.since = False, None
            self._changed()
            log.info("시크릿 모드 꺼짐 → 기록 삭제")
            res = await self._purge()
        self._changed()
        return {**self.brief(), "purged": res}

    def notify_orphan(self):
        """시크릿 모드가 꺼진 뒤에 끝난 시크릿 작업(취소 대기 초과 등) → 다시 지우기"""
        if self.enabled or (self._orphan_task and not self._orphan_task.done()):
            return
        self._orphan_task = asyncio.ensure_future(self.cleanup("늦게 끝난 시크릿 작업"))

    async def cleanup(self, why):
        """시작 시·종료 시·늦게 끝난 작업: 남은 시크릿 기록이 있으면 지운다 (모드가 꺼져 있을 때만)"""
        async with self._lock:
            if self.enabled and why != "Studio 종료":
                return None
            self.enabled, self.since = False, None
            if not self.leftovers():
                return None
            log.info("시크릿 기록 정리 (%s)", why)
            res = await self._purge(wait=why != "Studio 종료")
        self._changed()
        return res

    # ------------------------------------------------------------ 지우기
    async def _purge(self, wait=True):
        self._purging = True
        try:
            pids = await self._stop_jobs(wait)
            await self._forget_comfy_history(pids)
            n_jobs = self.jobs.purge_secret_records()
            n_files, n_bytes = await asyncio.to_thread(self.purge_files)
            log.info("시크릿 기록 삭제: 작업 %d개, 파일 %d개 (%.1f MB)", n_jobs, n_files, n_bytes / 1e6)
            return {"jobs": n_jobs, "files": n_files, "bytes": n_bytes}
        finally:
            self._purging = False

    async def _stop_jobs(self, wait):
        """진행·대기 중인 시크릿 작업 취소 → (wait 면) 끝날 때까지 기다림. ComfyUI 기록에서 지울 prompt_id 목록 반환."""
        pids = set()
        try:
            pids.update(p for p in self.jobs.store.secret_prompt_ids() if p)
        except sqlite3.Error:
            pass
        live = [st for st in list(self.jobs.active.values()) if st.job.get("secret")]
        for st in live:
            pids.add(st.prompt_id)
            try:
                await self.jobs.cancel(st.id)
            except Exception as e:
                log.warning("시크릿 작업 %s 취소 실패: %s", st.id, getattr(e, "message", e))
        if wait and live:
            deadline = time.monotonic() + WAIT_SECS
            while time.monotonic() < deadline and any(st.job.get("secret") for st in self.jobs.active.values()):
                await asyncio.sleep(0.5)
        for st in [st for st in list(self.jobs.active.values()) if st.job.get("secret")]:
            self.jobs._drop(st)  # 끝내 응답이 없으면 추적을 멈춘다 (늦게 생긴 파일은 다음 정리 때 지움)
        return [p for p in pids if p]

    async def _forget_comfy_history(self, pids):
        """ComfyUI 메모리의 실행 기록(프롬프트·파일 이름)도 지운다 — 엔진이 켜져 있을 때만, 실패해도 계속"""
        if not pids or not self.comfy.running:
            return
        try:
            await self.comfy.post_json("/history", {"delete": list(pids)}, timeout=10)
        except Exception as e:
            log.warning("ComfyUI 실행 기록 삭제 실패(엔진을 재시작하면 사라집니다): %s", e)

    def purge_files(self):
        files = _secret_files()
        for rel, _ in files:
            self.gallery.purge_thumbs(rel)
            self.gallery.meta_cache.pop(rel, None)
        for d in (OUTPUT_DIR / SECRET_DIR, OUTPUT_DIR / ".trash" / SECRET_DIR):
            if d.exists() and not d.is_symlink():
                shutil.rmtree(d, ignore_errors=True)
        return len(files), sum(s for _, s in files)
