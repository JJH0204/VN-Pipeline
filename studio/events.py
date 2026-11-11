"""SSE(Server-Sent Events) 브로드캐스트 허브."""
import asyncio

from .common import dumps, log


def encode_event(etype, data):
    # json.dumps 결과에는 줄바꿈이 없으므로 data: 한 줄로 충분
    return f"event: {etype}\ndata: {dumps(data)}\n\n".encode("utf-8")


class Subscriber:
    __slots__ = ("queue",)

    def __init__(self):
        self.queue = asyncio.Queue(maxsize=2000)


class EventHub:
    def __init__(self):
        self.subs = set()

    def subscribe(self):
        s = Subscriber()
        self.subs.add(s)
        return s

    def unsubscribe(self, s):
        self.subs.discard(s)

    def publish(self, etype, data):
        if not self.subs:
            return
        try:
            payload = encode_event(etype, data)
        except Exception:
            log.exception("이벤트 직렬화 실패: %s", etype)
            return
        for s in list(self.subs):
            try:
                s.queue.put_nowait(payload)
            except asyncio.QueueFull:
                # 너무 느린 클라이언트: 연결을 끊는다 (EventSource가 자동 재접속)
                self._close(s)

    def _close(self, s):
        self.subs.discard(s)
        while True:
            try:
                s.queue.get_nowait()
            except asyncio.QueueEmpty:
                break
        s.queue.put_nowait(None)

    def close_all(self):
        for s in list(self.subs):
            self._close(s)
