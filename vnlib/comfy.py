"""CLI용 동기 ComfyUI 클라이언트 (표준 라이브러리만). GUI 서버는 aiohttp로 별도 구현."""
import json
import sys
import time
import urllib.error
import urllib.request
import uuid


def submit(server, graph, client_id=None):
    body = json.dumps({"prompt": graph, "client_id": client_id or str(uuid.uuid4())}).encode()
    req = urllib.request.Request(f"{server}/prompt", body, {"Content-Type": "application/json"})
    try:
        return json.load(urllib.request.urlopen(req))["prompt_id"]
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"ComfyUI 오류:\n{e.read().decode()}") from None
    except urllib.error.URLError:
        raise RuntimeError("ComfyUI 서버에 연결할 수 없습니다. 먼저 ./start.sh (또는 VN Studio)를 실행하세요.") from None


LOST_MSG = "ComfyUI 연결이 끊어졌습니다 (엔진이 종료되었거나 다시 시작되었을 수 있습니다)."


def _get(url, timeout=10):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.load(r)


def wait(server, pid, quiet=False):
    """완료까지 대기 → 출력 파일 목록 (output/ 기준 상대경로)

    - 연결이 연달아 끊기면(엔진 종료/재시작) RuntimeError
    - 기록(history)에도 큐에도 없는 상태가 이어지면(재시작·큐 비우기로 작업이 사라짐) RuntimeError
    """
    t0 = time.time()
    polls = fails = missing = 0
    while True:
        try:
            h = _get(f"{server}/history/{pid}")
            fails = 0
        except (urllib.error.URLError, OSError, ValueError):
            fails += 1
            if fails >= 3:
                if not quiet:
                    print()
                raise RuntimeError(LOST_MSG) from None
            time.sleep(2)
            continue
        if pid in h:
            st = h[pid].get("status", {})
            if st.get("status_str") == "error":
                msgs = st.get("messages", [])
                errs = [m for m in msgs if m and m[0] == "execution_error"]
                if not quiet:
                    print()
                if not errs and any(m and m[0] == "execution_interrupted" for m in msgs):
                    raise RuntimeError("작업이 중단되었습니다 (ComfyUI에서 취소됨).")
                raise RuntimeError(f"실행 실패: {json.dumps(errs, ensure_ascii=False)[:2000]}")
            files = [f"{i['subfolder']}/{i['filename']}".lstrip("/")
                     for o in h[pid].get("outputs", {}).values() for i in o.get("images", []) if i.get("type") == "output"]
            if not quiet:
                print(f"\r완료 ({time.time() - t0:.0f}s)        ")
            return files
        polls += 1
        if polls % 3 == 0:  # 약 6초마다 큐에 아직 있는지 확인
            try:
                q = _get(f"{server}/queue")
            except (urllib.error.URLError, OSError, ValueError):
                q = None  # 다음 history 요청에서 연결 상태를 판단
            if q is not None:
                ids = {item[1] for key in ("queue_running", "queue_pending")
                       for item in (q.get(key) or []) if isinstance(item, list) and len(item) > 1}
                # 방금 끝나서 큐에서 빠졌을 수 있으니 두 번 연속(약 12초)일 때만 사라진 것으로 본다
                missing = 0 if pid in ids else missing + 1
                if missing >= 2:
                    if not quiet:
                        print()
                    raise RuntimeError("ComfyUI 큐에서 작업이 사라졌습니다 (엔진 재시작 또는 취소). 다시 실행하세요.")
        if not quiet:
            print(f"\r생성 중... {time.time() - t0:.0f}s", end="", flush=True)
            sys.stdout.flush()
        time.sleep(2)
