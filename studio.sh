#!/bin/zsh
# VN Studio 실행기
#
#   ./studio.sh          Studio 서버(127.0.0.1:8190)를 백그라운드로 실행
#   ./studio.sh --open   서버가 준비되면 앱 창(Chrome 앱 모드, 없으면 기본 브라우저)까지 연다
#                        (VN Studio.app이 쓰는 방식. 이렇게 띄운 서버만 원격 접속(Tailscale)을 받는다 — server.py --app)
#
# - 이미 실행 중이면(/api/ping 또는 /api/status 응답) 새로 띄우지 않는다 (여러 번 실행해도 안전).
# - Finder/"VN Studio.app"(osascript)에서 터미널 없이, 최소 PATH로 실행돼도 동작하도록 절대 경로만 쓴다.
# - 서버 출력과 이 스크립트의 기록은 user/studio.log 에 쌓인다.
# - 종료: scripts/stop_studio.sh

emulate -R zsh
setopt no_unset pipe_fail

export PATH="/usr/bin:/bin:/usr/sbin:/sbin"
export LANG="${LANG:-ko_KR.UTF-8}"

ROOT="${0:A:h}"
PY="$ROOT/ComfyUI/Installs/ComfyUI/standalone-env/bin/python"
SERVER="$ROOT/studio/server.py"
USER_DIR="$ROOT/user"
LOG="$USER_DIR/studio.log"
PIDFILE="$USER_DIR/studio.pid"
LOCK="$USER_DIR/.studio-launch.lock"
HOST="127.0.0.1"
WAIT_SECS=20
LOG_MAX_BYTES=$((5 * 1024 * 1024))

OPEN_UI=0
for arg in "$@"; do
  case "$arg" in
    --open) OPEN_UI=1 ;;
    -h|--help)
      print -r -- "사용법: ${0:t} [--open]"
      print -r -- "  --open   서버가 준비되면 VN Studio 창을 엽니다"
      exit 0 ;;
    *)
      print -u2 -r -- "알 수 없는 옵션: $arg (사용법: ${0:t} [--open])"
      exit 2 ;;
  esac
done

# 포트: 환경변수 VN_STUDIO_PORT > config/settings.json 의 studio_port > 8190
PORT=8190
if [[ -r "$ROOT/config/settings.json" ]]; then
  _settings="$(<"$ROOT/config/settings.json")"
  if [[ "$_settings" =~ '"studio_port"[[:space:]]*:[[:space:]]*([0-9]+)' ]]; then
    PORT="${match[1]}"
  fi
  unset _settings
fi
[[ -n "${VN_STUDIO_PORT:-}" && "${VN_STUDIO_PORT}" == <1024-65535> ]] && PORT="$VN_STUDIO_PORT"
URL="http://$HOST:$PORT"

mkdir -p "$USER_DIR" 2>/dev/null

log() {
  print -r -- "[$(date '+%Y-%m-%d %H:%M:%S')] [studio.sh] $*" >>"$LOG" 2>/dev/null
}

say() {  # 터미널에서 실행했을 때만 화면에도 출력
  log "$*"
  [[ -t 1 ]] && print -r -- "$*"
  return 0
}

# 오류 보고: 로그 + stderr. --open(앱/Finder에서 실행)이면 경고창도 띄운다(5분 뒤 자동으로 닫힘).
fail() {
  local title="$1" msg="$2"
  log "오류: $title — ${msg//$'\n'/ }"
  print -u2 -r -- "오류: $title"
  print -u2 -r -- "$msg"
  if (( OPEN_UI )); then
    local btn
    btn="$(/usr/bin/osascript \
      -e 'on run argv' \
      -e 'set r to display alert (item 1 of argv) message (item 2 of argv) as critical buttons {"로그 열기", "확인"} default button "확인" giving up after 300' \
      -e 'return button returned of r' \
      -e 'end run' "$title" "$msg" 2>/dev/null)"
    [[ "$btn" == "로그 열기" && -f "$LOG" ]] && /usr/bin/open "$LOG"
  fi
  exit 1
}

# 우리 서버가 응답하는지(다른 프로그램이 포트를 쓰는 경우와 구분하려고 응답 내용까지 확인)
# /api/ping 은 ComfyUI를 기다리지 않는 가벼운 확인이다. ping이 없는 이전 버전 서버면 /api/status 로 확인하는데,
# 엔진이 멈춰 있으면 status가 몇 초 걸릴 수 있어 넉넉히 기다린다(Studio가 멀쩡한데 꺼진 것으로 보지 않게).
studio_up() {
  local body
  body="$(/usr/bin/curl -fsS -m 2 "$URL/api/ping" 2>/dev/null)" && [[ "$body" == *'"studio"'* ]] && return 0
  body="$(/usr/bin/curl -fsS -m 6 "$URL/api/status" 2>/dev/null)" || return 1
  [[ "$body" == *'"studio"'* ]]
}

port_listening() {
  [[ -n "$(/usr/sbin/lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null)" ]]
}

open_ui() {
  local app="" d
  for d in "/Applications/Google Chrome.app" "${HOME:-/var/empty}/Applications/Google Chrome.app"; do
    [[ -d "$d" ]] && { app="$d"; break; }
  done
  if [[ -n "$app" ]]; then
    log "Chrome 앱 창으로 엽니다: $URL"
    /usr/bin/open -na "$app" --args --app="$URL" --window-size=1440,960 && return 0
    log "Chrome 실행 실패 — 기본 브라우저로 엽니다"
  fi
  /usr/bin/open "$URL"
}

# 서버가 응답할 때까지 최대 WAIT_SECS초(실제 시간 기준) 대기. 인자로 PID를 주면 그 프로세스가 죽었는지도 확인.
wait_ready() {
  local pid="${1:-}" deadline=$(( SECONDS + WAIT_SECS ))
  while (( SECONDS < deadline )); do
    studio_up && return 0
    if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
      return 2
    fi
    sleep 0.25
  done
  return 1
}

# 이번 실행에서 로그에 새로 쌓인 부분의 마지막 몇 줄 (인자: 시작 시점의 로그 크기)
log_tail() {
  [[ -f "$LOG" ]] || return 0
  /usr/bin/tail -c +$(( ${1:-0} + 1 )) "$LOG" 2>/dev/null | /usr/bin/tail -n 8 | /usr/bin/cut -c1-200
}

# 포트를 잡고 있는 프로세스 중에 Studio 서버가 있는지 (막 뜨는 중이라 아직 응답이 없는 경우)
listener_is_studio() {
  local p
  for p in ${(f)"$(/usr/sbin/lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null)"}; do
    [[ "$(/bin/ps -o command= -p "$p" 2>/dev/null)" == *python*studio/server.py* ]] && return 0
  done
  return 1
}

rotate_log() {
  [[ -f "$LOG" ]] || return 0
  local size
  size=$(/usr/bin/stat -f %z "$LOG" 2>/dev/null) || return 0
  if (( size > LOG_MAX_BYTES )); then
    /bin/mv -f "$LOG" "$LOG.1" 2>/dev/null
  fi
}

finish() {
  (( OPEN_UI )) && open_ui
  exit 0
}

# ---------------------------------------------------------------- 1. 이미 실행 중?
if studio_up; then
  say "VN Studio가 이미 실행 중입니다: $URL"
  finish
fi

# ---------------------------------------------------------------- 2. 동시 실행 방지 잠금
# 앱을 연달아 더블클릭해도 서버가 하나만 뜨도록 한다. 60초 넘은 잠금은 비정상 종료의 흔적으로 보고 지운다.
lock_age() {
  local m
  m=$(/usr/bin/stat -f %m "$LOCK" 2>/dev/null) || { print 0; return; }
  print $(( $(/bin/date +%s) - m ))
}
got_lock=0
for _try in 1 2; do
  if /bin/mkdir "$LOCK" 2>/dev/null; then
    got_lock=1
    break
  fi
  if (( $(lock_age) > 60 )); then
    log "오래된 실행 잠금을 정리합니다"
    /bin/rm -rf "$LOCK" 2>/dev/null
    continue
  fi
  break
done
if (( ! got_lock )); then
  # 다른 실행기가 지금 서버를 띄우는 중 → 준비만 기다린다
  say "다른 실행 요청이 서버를 시작하는 중입니다. 준비되기를 기다립니다…"
  if wait_ready; then
    say "VN Studio 준비 완료: $URL"
    exit 0   # 창은 먼저 실행한 쪽이 연다 (창이 두 개 뜨지 않게)
  fi
  fail "VN Studio를 시작하지 못했습니다" "서버가 ${WAIT_SECS}초 안에 응답하지 않았습니다.

로그: $LOG"
fi
trap '/bin/rm -rf "$LOCK" 2>/dev/null' EXIT
trap 'exit 130' INT TERM HUP

# 잠금을 얻는 사이 다른 쪽이 띄웠을 수 있으니 한 번 더 확인
if studio_up; then
  say "VN Studio가 이미 실행 중입니다: $URL"
  finish
fi

# ---------------------------------------------------------------- 3. 실행 조건 점검
if [[ ! -x "$PY" ]]; then
  fail "VN Studio를 시작할 수 없습니다" "엔진 Python을 찾을 수 없습니다:
$PY

외장 SSD(T7)가 연결되어 있는지 확인하세요."
fi
if [[ ! -f "$SERVER" ]]; then
  fail "VN Studio를 시작할 수 없습니다" "서버 파일이 없습니다:
$SERVER"
fi
if port_listening; then
  # 응답은 없는데 포트가 열려 있음. Studio 서버가 막 뜨는 중(또는 바쁨)이면 기다리고, 다른 프로그램이면 바로 알린다.
  if listener_is_studio; then
    say "Studio 서버가 이미 시작 중입니다. 응답을 기다립니다…"
    if wait_ready; then
      say "VN Studio 준비 완료: $URL"
      finish
    fi
    fail "VN Studio가 응답하지 않습니다" "Studio 서버가 실행 중이지만 ${WAIT_SECS}초 안에 응답하지 않았습니다.
scripts/stop_studio.sh 로 종료한 뒤 다시 실행해 보세요.

로그: $LOG"
  fi
  owner="$(/usr/sbin/lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | /usr/bin/awk 'NR==2 {print $1 " (PID " $2 ")"}')"
  fail "VN Studio를 시작할 수 없습니다" "포트 $PORT 을(를) 다른 프로그램이 사용 중입니다: ${owner:-알 수 없음}

그 프로그램을 종료한 뒤 다시 시도하세요."
fi

# ---------------------------------------------------------------- 4. 서버 시작
rotate_log
cd "$ROOT" || fail "VN Studio를 시작할 수 없습니다" "프로젝트 폴더로 이동할 수 없습니다: $ROOT"

# 엔진 Python 환경이 사용자 환경의 패키지와 섞이지 않게 한다
unset PYTHONPATH PYTHONHOME PYTHONSTARTUP VIRTUAL_ENV
export PYTHONNOUSERSITE=1 PYTHONUNBUFFERED=1 PYTHONIOENCODING=utf-8

# 앱(--open)으로 띄울 때만 --app: 원격 접속은 Mac에서 앱을 연 세션에서만 열린다 (studio/remote.py 참고)
server_args=(--port "$PORT")
(( OPEN_UI )) && server_args+=(--app)
log "서버 시작: $PY $SERVER ${server_args[*]}"
log_start=$(/usr/bin/stat -f %z "$LOG" 2>/dev/null || print 0)
/usr/bin/nohup "$PY" "$SERVER" "${server_args[@]}" >>"$LOG" 2>&1 </dev/null &
pid=$!
print -r -- "$pid" >"$PIDFILE" 2>/dev/null
disown 2>/dev/null

wait_ready "$pid"
rc=$?
if (( rc == 0 )); then
  say "VN Studio 준비 완료: $URL (PID $pid)"
  # 앱 세션 + 원격 허용이면 서버가 살아 있는 동안 잠자기(유휴) 방지. 서버가 끝나면 caffeinate도 같이 끝난다.
  # (덮개를 닫으면 여전히 잠든다 — 전원 연결 + 외장 모니터가 없으면 열어 둘 것)
  if (( OPEN_UI )) && [[ -r "$ROOT/config/settings.json" && "$(<"$ROOT/config/settings.json")" =~ '"remote_enabled"[[:space:]]*:[[:space:]]*true' ]]; then
    /usr/bin/nohup /usr/bin/caffeinate -i -w "$pid" >/dev/null 2>&1 </dev/null &
    disown 2>/dev/null
    log "원격 접속 켜짐 → 잠자기 방지(caffeinate -i -w $pid)"
  fi
  /bin/rm -rf "$LOCK" 2>/dev/null
  finish
fi

if (( rc == 2 )); then
  /bin/rm -f "$PIDFILE" 2>/dev/null
  fail "VN Studio를 시작하지 못했습니다" "서버가 시작 직후 종료되었습니다. 로그 마지막 부분:

$(log_tail "$log_start")

전체 로그: $LOG"
fi

# 프로세스는 살아 있는데 응답이 없음 (아주 느린 디스크 등) — 서버는 그대로 두고 알린다
fail "VN Studio가 아직 응답하지 않습니다" "서버(PID $pid)는 실행 중이지만 ${WAIT_SECS}초 안에 응답하지 않았습니다.
잠시 뒤 다시 실행하거나 브라우저에서 $URL 을 열어 보세요.

로그: $LOG"
