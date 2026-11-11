#!/bin/zsh
# VN Studio 자동 실행 (원격 접속용)
#
#   scripts/autostart.sh install     로그인할 때와 외장 디스크가 연결될 때 Studio를 자동으로 켠다
#   scripts/autostart.sh uninstall   자동 실행 해제
#   scripts/autostart.sh status      설치 여부
#
# LaunchAgent(~/Library/LaunchAgents/com.vnpipeline.studio.plist)가 studio.sh 를 실행한다.
# studio.sh 는 이미 실행 중이면 아무것도 하지 않으므로 여러 번 불려도 안전하다.
# /Volumes 변화(T7 연결)를 지켜보므로 로그인 뒤에 T7을 꽂아도 켜진다. T7이 없으면 조용히 넘어간다.
# 자동 실행으로 켠 Studio는 앱 세션이 아니라 원격 접속을 받지 않는다(로컬 전용). 원격이 필요하면 VN Studio.app으로 다시 열 것.
# 일부러 끈 Studio(scripts/stop_studio.sh, ⋯ → 종료)는 다음 로그인·디스크 연결 전까지 다시 켜지지 않는다.

emulate -R zsh
setopt no_unset pipe_fail
export PATH="/usr/bin:/bin:/usr/sbin:/sbin"

ROOT="${0:A:h:h}"
LABEL="com.vnpipeline.studio"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(/usr/bin/id -u)"

case "${1:-}" in
  install)
    /bin/mkdir -p "$HOME/Library/LaunchAgents"
    # 디스크가 막 마운트된 직후에는 폴더가 아직 안 보일 수 있어 잠깐 기다린다
    cmd="for i in 1 2 3 4 5 6; do [ -x '$ROOT/studio.sh' ] && exec '$ROOT/studio.sh'; sleep 5; done; exit 0"
    /bin/cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/zsh</string><string>-c</string><string>$cmd</string></array>
  <key>RunAtLoad</key><true/>
  <key>WatchPaths</key><array><string>/Volumes</string></array>
  <key>AbandonProcessGroup</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>/dev/null</string>
</dict>
</plist>
EOF
    /bin/launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null
    /bin/launchctl bootstrap "$DOMAIN" "$PLIST" && print -r -- "자동 실행을 설치했습니다: $PLIST"
    ;;
  uninstall)
    /bin/launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null
    /bin/rm -f "$PLIST"
    print -r -- "자동 실행을 해제했습니다 (실행 중인 Studio는 그대로)."
    ;;
  status)
    if [[ -f "$PLIST" ]]; then print -r -- "설치됨: $PLIST"; else print -r -- "설치 안 됨"; fi
    ;;
  *)
    print -u2 -r -- "사용법: ${0:t} install|uninstall|status"; exit 2 ;;
esac
