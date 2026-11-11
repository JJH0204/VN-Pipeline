#!/bin/zsh
# VN Studio 종료
#
#   scripts/stop_studio.sh             Studio(127.0.0.1:8190)와 Studio가 띄운 ComfyUI를 종료
#   scripts/stop_studio.sh --all       따로 실행한 ComfyUI(start.sh 등, 8188)까지 종료
#   scripts/stop_studio.sh --dry-run   무엇을 종료할지 보여 주기만 하고 아무것도 하지 않음
#
# 순서: POST /api/shutdown 으로 정상 종료 요청 → 기다려도 남아 있으면 PID로 SIGTERM → 그래도 남으면 SIGKILL.
# 프로세스는 명령줄을 확인해서(studio/server.py, main.py) 다른 프로그램을 잘못 죽이지 않는다.
# Studio가 띄운 ComfyUI는 Studio의 자식 프로세스이거나, Studio가 죽거나 재시작된 뒤라면
# user/studio/comfy_pid.json 에 기록된 프로세스(시작 시각까지 맞을 때만)로 찾는다.

emulate -R zsh
setopt no_unset pipe_fail

export PATH="/usr/bin:/bin:/usr/sbin:/sbin"

ROOT="${0:A:h:h}"
USER_DIR="$ROOT/user"
LOG="$USER_DIR/studio.log"
PIDFILE="$USER_DIR/studio.pid"
COMFY_PIDFILE="$USER_DIR/studio/comfy_pid.json"   # Studio가 띄운 ComfyUI 기록 (studio/comfy_link.py)
HOST="127.0.0.1"

ALL=0
DRY=0
for arg in "$@"; do
  case "$arg" in
    --all) ALL=1 ;;
    -n|--dry-run) DRY=1 ;;
    -h|--help)
      print -r -- "사용법: ${0:t} [--all] [--dry-run]"
      print -r -- "  --all       Studio가 띄우지 않은 ComfyUI(8188)까지 종료"
      print -r -- "  --dry-run   종료할 대상만 보여 주고 실제로 종료하지 않음"
      exit 0 ;;
    *)
      print -u2 -r -- "알 수 없는 옵션: $arg (사용법: ${0:t} [--all] [--dry-run])"
      exit 2 ;;
  esac
done

# 포트: studio.sh와 같은 규칙 (VN_STUDIO_PORT > settings.studio_port > 8190), ComfyUI는 settings.comfy_url
PORT=8190
COMFY_PORT=8188
if [[ -r "$ROOT/config/settings.json" ]]; then
  _settings="$(<"$ROOT/config/settings.json")"
  [[ "$_settings" =~ '"studio_port"[[:space:]]*:[[:space:]]*([0-9]+)' ]] && PORT="${match[1]}"
  [[ "$_settings" =~ '"comfy_url"[[:space:]]*:[[:space:]]*"[^"]*:([0-9]+)/?"' ]] && COMFY_PORT="${match[1]}"
  unset _settings
fi
[[ -n "${VN_STUDIO_PORT:-}" && "${VN_STUDIO_PORT}" == <1024-65535> ]] && PORT="$VN_STUDIO_PORT"
URL="http://$HOST:$PORT"

log() {
  (( DRY )) && return 0
  [[ -d "$USER_DIR" ]] && print -r -- "[$(date '+%Y-%m-%d %H:%M:%S')] [stop_studio.sh] $*" >>"$LOG" 2>/dev/null
  return 0
}
say() { print -r -- "$*"; log "$*"; }

cmdline()   { /bin/ps -o command= -p "$1" 2>/dev/null; }
alive()     { kill -0 "$1" 2>/dev/null; }
is_studio() { [[ "$(cmdline "$1")" == *python*studio/server.py* ]]; }
is_comfy()  { [[ "$(cmdline "$1")" == *python*main.py* ]]; }
listeners() { /usr/sbin/lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null; }

descendants() {
  local c
  for c in ${(f)"$(/usr/bin/pgrep -P "$1" 2>/dev/null)"}; do
    print -r -- "$c"
    descendants "$c"
  done
}

# Studio가 응답하는지. /api/ping 은 ComfyUI를 기다리지 않는 가벼운 확인이다.
# (ping이 없는 이전 버전 서버면 /api/status 로 확인 — 엔진이 느리면 status는 몇 초 걸릴 수 있어 넉넉히 기다린다)
studio_up() {
  local body
  body="$(/usr/bin/curl -fsS -m 2 "$URL/api/ping" 2>/dev/null)" && [[ "$body" == *'"studio"'* ]] && return 0
  body="$(/usr/bin/curl -fsS -m 6 "$URL/api/status" 2>/dev/null)" || return 1
  [[ "$body" == *'"studio"'* ]]
}

# 프로세스가 시작된 지 몇 초 지났는지 (ps etime 형식: [[dd-]hh:]mm:ss)
elapsed_secs() {
  local et d=0 s=0 x
  et="$(/bin/ps -o etime= -p "$1" 2>/dev/null)"
  et="${et//[[:space:]]/}"
  [[ "$et" == [0-9]* ]] || return 1
  if [[ "$et" == *-* ]]; then
    d="${et%%-*}"
    et="${et#*-}"
  fi
  for x in ${(s/:/)et}; do
    s=$(( s * 60 + 10#$x ))
  done
  print -r -- $(( 10#$d * 86400 + s ))
}

# comfy_pid.json 에 기록된 ComfyUI가 아직 그 프로세스인지 (PID 재사용 방지: 기록된 시작 시각과 1분 이내로 맞아야 함)
# 맞으면 PID를 출력한다. 기록 형식: {"pid": 123, "started": 1762540000.12}
recorded_comfy_pid() {
  local info rp started el diff
  [[ -r "$COMFY_PIDFILE" ]] || return 1
  info="$(<"$COMFY_PIDFILE")"
  [[ "$info" =~ '"pid"[[:space:]]*:[[:space:]]*([0-9]+)' ]] || return 1
  rp="${match[1]}"
  alive "$rp" && is_comfy "$rp" || return 1
  if [[ "$info" =~ '"started"[[:space:]]*:[[:space:]]*([0-9]+)' ]]; then
    started="${match[1]}"
    el="$(elapsed_secs "$rp")" || return 1
    diff=$(( $(/bin/date +%s) - el - started ))
    (( diff < 0 )) && diff=$(( -diff ))
    (( diff <= 60 )) || return 1
  else
    # 시작 시각 기록이 없으면 ComfyUI 포트에서 실제로 대기 중인 프로세스일 때만 인정
    [[ -n "$(listeners "$COMFY_PORT" | /usr/bin/grep -x -- "$rp")" ]] || return 1
  fi
  print -r -- "$rp"
}

# 기록된 PID가 이미 끝났으면 기록 파일을 지운다 (살아 있는 프로세스의 기록은 건드리지 않음)
clear_stale_comfy_record() {
  local info
  [[ -r "$COMFY_PIDFILE" ]] || return 0
  info="$(<"$COMFY_PIDFILE")"
  if [[ "$info" =~ '"pid"[[:space:]]*:[[:space:]]*([0-9]+)' ]] && alive "${match[1]}"; then
    return 0
  fi
  /bin/rm -f "$COMFY_PIDFILE" 2>/dev/null
  return 0
}

# 남은 프로세스가 모두 끝날 때까지 최대 $1초 대기. 나머지 인자는 PID 목록.
wait_gone() {
  local secs="$1" i p left
  shift
  for (( i = 0; i < secs * 4; i++ )); do
    left=0
    for p in "$@"; do alive "$p" && left=1; done
    (( left )) || return 0
    sleep 0.25
  done
  return 1
}

# SIGTERM → (grace초) → SIGKILL. 자기 프로세스 그룹의 리더면 그룹 전체에 보낸다(자식 프로세스 정리).
terminate() {
  local what="$1" grace="$2" check="$3" p pgid
  shift 3
  local -a targets=()
  for p in "$@"; do alive "$p" && $check "$p" && targets+=("$p"); done
  (( ${#targets} )) || return 0
  for p in $targets; do
    pgid="$(/bin/ps -o pgid= -p "$p" 2>/dev/null | /usr/bin/tr -d ' ')"
    if [[ -n "$pgid" && "$pgid" == "$p" ]]; then
      kill -TERM -- "-$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null
    else
      kill -TERM "$p" 2>/dev/null
    fi
    say "$what 종료 신호를 보냈습니다 (PID $p)"
  done
  wait_gone "$grace" $targets && return 0
  for p in $targets; do
    if alive "$p" && $check "$p"; then
      kill -KILL "$p" 2>/dev/null
      say "$what 이(가) 응답하지 않아 강제 종료했습니다 (PID $p)"
    fi
  done
  wait_gone 3 $targets
}

# ---------------------------------------------------------------- 1. 대상 찾기
typeset -aU studio_pids comfy_pids
if [[ -r "$PIDFILE" ]]; then
  p="$(<"$PIDFILE")"
  p="${p//[^0-9]/}"
  [[ -n "$p" ]] && alive "$p" && is_studio "$p" && studio_pids+=("$p")
fi
for p in ${(f)"$(listeners "$PORT")"}; do
  is_studio "$p" && studio_pids+=("$p")
done
# Studio가 띄운 ComfyUI = Studio 프로세스의 자손 중 main.py 실행 중인 것 (Studio가 죽으면 관계가 끊기므로 먼저 기록)
for s in $studio_pids; do
  for d in ${(f)"$(descendants "$s")"}; do
    is_comfy "$d" && comfy_pids+=("$d")
  done
done
# Studio가 죽었거나(부모 관계가 끊김) 재시작돼 이전 ComfyUI를 인계받은 경우는 기록 파일로 찾는다
recorded_comfy="$(recorded_comfy_pid)" || recorded_comfy=""
[[ -n "$recorded_comfy" ]] && comfy_pids+=("$recorded_comfy")
external_comfy=()
if (( ALL )); then
  for p in ${(f)"$(listeners "$COMFY_PORT")"}; do
    is_comfy "$p" && (( ! ${comfy_pids[(Ie)$p]} )) && external_comfy+=("$p")
  done
fi

up=0
studio_up && up=1

if (( ! up && ! ${#studio_pids} && ! ${#comfy_pids} && ! ${#external_comfy} )); then
  print -r -- "실행 중인 VN Studio가 없습니다."
  if (( ! ALL )) && [[ -n "$(listeners "$COMFY_PORT")" ]]; then
    print -r -- "(포트 $COMFY_PORT 의 ComfyUI는 Studio가 띄운 것이 아니라서 그대로 둡니다. 함께 끄려면 --all)"
  fi
  if (( ! DRY )); then
    /bin/rm -f "$PIDFILE" 2>/dev/null
    clear_stale_comfy_record
  fi
  exit 0
fi

if (( DRY )); then
  print -r -- "[미리보기] 아무것도 종료하지 않습니다."
  print -r -- "  Studio 응답($URL): $( (( up )) && print 있음 || print 없음 )"
  print -r -- "  Studio 프로세스: ${studio_pids:-없음}"
  print -r -- "  Studio가 띄운 ComfyUI: ${comfy_pids:-없음}"
  [[ -n "$recorded_comfy" ]] && print -r -- "    (PID $recorded_comfy 는 Studio가 기록해 둔 ComfyUI입니다: ${COMFY_PIDFILE#$ROOT/})"
  (( ALL )) && print -r -- "  따로 실행한 ComfyUI(--all): ${external_comfy:-없음}"
  for p in $studio_pids $comfy_pids $external_comfy; do
    print -r -- "    $p: $(cmdline "$p" | /usr/bin/cut -c1-160)"
  done
  exit 0
fi

# ---------------------------------------------------------------- 2. 정상 종료 요청
if (( up )); then
  if /usr/bin/curl -fsS -m 5 -o /dev/null -X POST -H 'Content-Type: application/json' -d '{}' "$URL/api/shutdown" 2>/dev/null; then
    say "VN Studio에 종료를 요청했습니다. 정리될 때까지 기다립니다…"
    # 서버는 자기가 띄운 ComfyUI를 정리한 뒤 나가므로 넉넉히(최대 20초, 실제 시간 기준) 기다린다.
    # Studio PID를 알면 프로세스가 끝났는지만 보고, 모를 때만 응답 여부로 판단한다(멈춘 서버에 매번 묻지 않게).
    deadline=$(( SECONDS + 20 ))
    while (( SECONDS < deadline )); do
      left=0
      if (( ${#studio_pids} )); then
        for p in $studio_pids; do alive "$p" && left=1; done
      else
        studio_up && left=1
      fi
      (( left )) || break
      sleep 0.25
    done
    # Studio가 끝났는데 ComfyUI가 남았다면 잠깐(최대 3초)만 더 기다린 뒤 아래에서 직접 정리
    (( ${#comfy_pids} )) && wait_gone 3 $comfy_pids
  else
    # 요청이 실패했으면 기다려도 소용없으므로 바로 아래에서 프로세스를 정리한다
    say "종료 요청에 응답이 없습니다. 프로세스를 직접 종료합니다."
  fi
fi

# ---------------------------------------------------------------- 3. 남은 프로세스 정리
terminate "VN Studio" 5 is_studio $studio_pids
terminate "ComfyUI(Studio가 실행)" 10 is_comfy $comfy_pids
(( ${#external_comfy} )) && terminate "ComfyUI" 10 is_comfy $external_comfy

/bin/rm -f "$PIDFILE" 2>/dev/null
clear_stale_comfy_record

# ---------------------------------------------------------------- 4. 결과
if studio_up || [[ -n "$(listeners "$PORT")" ]]; then
  print -u2 -r -- "포트 $PORT 이(가) 아직 사용 중입니다. 다른 프로그램일 수 있습니다:"
  /usr/sbin/lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null >&2
  exit 1
fi
say "VN Studio를 종료했습니다."
if (( ! ALL )) && [[ -n "$(listeners "$COMFY_PORT")" ]]; then
  print -r -- "(따로 실행한 ComfyUI는 포트 $COMFY_PORT 에서 계속 실행 중입니다. 함께 끄려면 --all)"
fi
exit 0
