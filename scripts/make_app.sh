#!/bin/zsh
# "VN Studio.app" 만들기 — 더블클릭하면 터미널 창 없이 studio.sh --open 을 백그라운드로 실행한다.
#
#   scripts/make_app.sh                          앱 생성/갱신 (여러 번 실행해도 안전, 기존 앱은 교체)
#   ICON_SRC=/경로/그림.png scripts/make_app.sh  다른 그림으로 아이콘 만들기
#   ICON_CROP="크기 x y" scripts/make_app.sh     아이콘으로 쓸 정사각 영역(원본 픽셀 기준) 직접 지정
#
# 아이콘: output/haru/concept/haru_wai_seed20261108_00001_.png(있으면) 얼굴 부분을 정사각으로 잘라
#        sips + iconutil 로 .icns 를 만든다. 아이콘 만들기에 실패해도 앱은 기본 아이콘으로 생성된다.

emulate -R zsh
setopt no_unset pipe_fail

export PATH="/usr/bin:/bin:/usr/sbin:/sbin"

ROOT="${0:A:h:h}"
APP_NAME="VN Studio"
APP="$ROOT/$APP_NAME.app"
LAUNCHER="$ROOT/studio.sh"
BUNDLE_ID="com.vnpipeline.studio"
APP_VERSION="1.0"
PY="/Volumes/T7/ComfyUI/Installs/ComfyUI/standalone-env/bin/python"
DEFAULT_ICON_SRC="$ROOT/output/haru/concept/haru_wai_seed20261108_00001_.png"
PB="/usr/libexec/PlistBuddy"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

step() { print -r -- "▸ $*"; }
info() { print -r -- "  $*"; }
warn() { print -u2 -r -- "  경고: $*"; }
die()  { print -u2 -r -- "오류: $*"; exit 1; }

[[ "$(/usr/bin/uname -s)" == Darwin ]] || die "macOS에서만 실행할 수 있습니다."
for tool in /usr/bin/osacompile /usr/bin/sips /usr/bin/iconutil "$PB"; do
  [[ -x "$tool" ]] || die "필요한 도구가 없습니다: $tool"
done
[[ -f "$LAUNCHER" ]] || die "실행 스크립트가 없습니다: $LAUNCHER"
/bin/chmod +x "$LAUNCHER" "$ROOT/scripts/stop_studio.sh" 2>/dev/null

WORK="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/vnstudio-app.XXXXXX")" || die "임시 폴더를 만들 수 없습니다."
trap '/bin/rm -rf "$WORK"' EXIT
BUILD="$WORK/$APP_NAME.app"

# AppleScript 문자열 리터럴로 안전하게 감싸기 (\ 와 " 이스케이프)
as_string() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  print -r -- "\"$s\""
}

# ---------------------------------------------------------------- 1. 애플릿 컴파일
step "애플릿 컴파일"
# property 대신 지역 변수를 쓴다: property는 실행할 때마다 앱 안에 다시 저장되어 서명이 깨진다.
/bin/cat >"$WORK/launcher.applescript" <<EOF
-- VN Studio 실행기 (scripts/make_app.sh가 생성함 — 고치려면 make_app.sh를 수정해 다시 실행하세요)
on run
	set launcherPath to $(as_string "$LAUNCHER")
	try
		do shell script "/bin/test -x " & quoted form of launcherPath
	on error
		display alert "VN Studio를 실행할 수 없습니다" message ("실행 스크립트를 찾을 수 없습니다:" & return & launcherPath & return & return & "외장 SSD(T7)가 연결되어 있는지 확인하세요.") as critical buttons {"확인"} default button "확인"
		return
	end try
	-- 출력을 버리고 백그라운드로 실행해야 앱이 바로 끝난다. 서버 준비와 창 열기, 오류 안내는 studio.sh가 맡는다.
	do shell script quoted form of launcherPath & " --open > /dev/null 2>&1 &"
end run
EOF
/usr/bin/osacompile -o "$BUILD" "$WORK/launcher.applescript" 2>"$WORK/osacompile.err" \
  || die "osacompile 실패: $(<"$WORK/osacompile.err")"
/usr/bin/osadecompile "$BUILD" 2>/dev/null | /usr/bin/grep -qF -- "$LAUNCHER" \
  || die "컴파일된 애플릿에서 실행 경로를 찾을 수 없습니다: $LAUNCHER"
info "실행 대상: $LAUNCHER --open"

# ---------------------------------------------------------------- 2. Info.plist
step "앱 정보(Info.plist) 설정"
PLIST="$BUILD/Contents/Info.plist"
pb_string() {  # 키가 있으면 바꾸고 없으면 추가
  "$PB" -c "Set :$1 $2" "$PLIST" 2>/dev/null || "$PB" -c "Add :$1 string $2" "$PLIST"
}
pb_string CFBundleIdentifier "$BUNDLE_ID"
pb_string CFBundleName "'$APP_NAME'"
pb_string CFBundleDisplayName "'$APP_NAME'"
pb_string CFBundleShortVersionString "$APP_VERSION"
pb_string CFBundleVersion "$APP_VERSION"
pb_string CFBundleIconFile applet
pb_string LSApplicationCategoryType public.app-category.graphics-design
# 최신 osacompile은 Assets.car 아이콘(CFBundleIconName)을 우선하므로 지워야 applet.icns가 쓰인다
"$PB" -c "Delete :CFBundleIconName" "$PLIST" 2>/dev/null
/bin/rm -f "$BUILD/Contents/Resources/Assets.car"
# 이 애플릿은 사진·연락처·카메라 등에 접근하지 않으므로 osacompile이 넣는 권한 설명은 지운다
for key in NSAppleMusicUsageDescription NSCalendarsUsageDescription NSCameraUsageDescription \
           NSContactsUsageDescription NSHomeKitUsageDescription NSMicrophoneUsageDescription \
           NSPhotoLibraryUsageDescription NSRemindersUsageDescription NSSiriUsageDescription \
           NSSystemAdministrationUsageDescription; do
  "$PB" -c "Delete :$key" "$PLIST" 2>/dev/null
done
/usr/bin/plutil -lint "$PLIST" >/dev/null || die "Info.plist가 올바르지 않습니다."

# ---------------------------------------------------------------- 3. 아이콘
make_icon() {
  local src="${ICON_SRC:-}" W H side x y
  if [[ -z "$src" ]]; then
    if [[ -f "$DEFAULT_ICON_SRC" ]]; then
      src="$DEFAULT_ICON_SRC"
    else
      local -a cands=( "$ROOT"/output/*/concept/*.png(N.om) )
      src="${cands[1]:-}"
    fi
  fi
  if [[ -z "$src" || ! -f "$src" ]]; then
    warn "아이콘으로 쓸 그림이 없어 기본 아이콘을 씁니다. (시안을 만든 뒤 다시 실행하거나 ICON_SRC로 지정하세요)"
    return 1
  fi
  info "원본: ${src#$ROOT/}"

  W="$(/usr/bin/sips -g pixelWidth "$src" 2>/dev/null | /usr/bin/awk '/pixelWidth/ {print $2}')"
  H="$(/usr/bin/sips -g pixelHeight "$src" 2>/dev/null | /usr/bin/awk '/pixelHeight/ {print $2}')"
  [[ "$W" == <1-> && "$H" == <1-> ]] || { warn "그림 크기를 읽을 수 없습니다: $src"; return 1; }

  if [[ -n "${ICON_CROP:-}" ]]; then
    local -a c=( ${=ICON_CROP} )
    (( ${#c} == 3 )) || { warn "ICON_CROP 형식은 \"크기 x y\" 입니다"; return 1; }
    side=$c[1]; x=$c[2]; y=$c[3]
  elif [[ "$src" == "$DEFAULT_ICON_SRC" ]]; then
    # haru 시안(1248×1824): 얼굴이 왼쪽 위에 있으므로 리본·땋은 머리까지 들어가게 맞춘 영역 (해상도가 달라도 비율 유지)
    side=$(( W * 840 / 1248 )); x=$(( W * 50 / 1248 )); y=$(( H * 30 / 1824 ))
  else
    # 일반 시안: 상단 가운데 (상반신 시안이면 대개 얼굴이 이 안에 들어온다)
    side=$(( (W < H ? W : H) * 67 / 100 )); x=$(( (W - side) / 2 )); y=$(( H * 3 / 100 ))
  fi
  # 그림 밖으로 나가지 않게 보정
  (( side > W )) && side=$W
  (( side > H )) && side=$H
  (( side < 64 )) && { warn "크롭 영역이 너무 작습니다 ($side px)"; return 1; }
  (( x < 0 )) && x=0; (( y < 0 )) && y=0
  (( x + side > W )) && x=$(( W - side ))
  (( y + side > H )) && y=$(( H - side ))
  info "크롭: ${side}×${side} @ (${x}, ${y})"

  /usr/bin/sips -s format png -c "$side" "$side" --cropOffset "$y" "$x" "$src" --out "$WORK/crop.png" >/dev/null 2>&1 \
    || { warn "sips 크롭 실패"; return 1; }
  /usr/bin/sips -z 1024 1024 "$WORK/crop.png" --out "$WORK/square.png" >/dev/null 2>&1 \
    || { warn "sips 리사이즈 실패"; return 1; }

  # macOS 26 이상은 시스템이 아이콘에 둥근 모양을 직접 입히고, 미리 둥글게 만든 예전 방식 아이콘은
  # 회색 판 안에 작게 넣어 버린다 → 정사각형(full-bleed) 그대로 쓴다.
  # 그보다 오래된 macOS에서는 둥근 사각형 + 여백 + 그림자를 직접 그린다(엔진 Python의 Pillow 사용, 없으면 정사각형).
  local master="$WORK/square.png" os_major
  os_major="$(/usr/bin/sw_vers -productVersion 2>/dev/null | /usr/bin/cut -d. -f1)"
  if [[ "$os_major" == <26-> ]]; then
    info "macOS ${os_major}: 정사각형 아이콘 사용 (모양은 시스템이 입힘)"
  elif [[ -x "$PY" ]] && "$PY" -I - "$WORK/square.png" "$WORK/master.png" <<'PYEOF' 2>"$WORK/icon_py.err"
import sys
from PIL import Image, ImageDraw, ImageFilter

src, dst = sys.argv[1], sys.argv[2]
S, BODY, R = 1024, 824, 185          # macOS 아이콘 그리드: 1024 캔버스, 824 본체, 모서리 반경 약 185
OFF = (S - BODY) // 2
K = 4                                 # 4배로 그린 뒤 줄여서 모서리를 매끄럽게

art = Image.open(src).convert("RGBA").resize((BODY, BODY), Image.LANCZOS)
big = Image.new("L", (BODY * K, BODY * K), 0)
ImageDraw.Draw(big).rounded_rectangle((0, 0, BODY * K - 1, BODY * K - 1), radius=R * K, fill=255)
mask = big.resize((BODY, BODY), Image.LANCZOS)

shadow_a = Image.new("L", (S, S), 0)
shadow_a.paste(mask, (OFF, OFF + 10))
shadow_a = shadow_a.filter(ImageFilter.GaussianBlur(12)).point(lambda v: int(v * 0.35))
canvas = Image.new("RGBA", (S, S), (0, 0, 0, 255))
canvas.putalpha(shadow_a)

body = art.copy()
body.putalpha(mask)
canvas.alpha_composite(body, (OFF, OFF))

# 밝은 배경에서도 윤곽이 보이도록 아주 옅은 테두리
line = Image.new("L", (BODY * K, BODY * K), 0)
ImageDraw.Draw(line).rounded_rectangle((0, 0, BODY * K - 1, BODY * K - 1), radius=R * K, outline=255, width=3 * K)
line = line.resize((BODY, BODY), Image.LANCZOS).point(lambda v: int(v * 0.16))
edge = Image.new("RGBA", (BODY, BODY), (0, 0, 0, 255))
edge.putalpha(line)
canvas.alpha_composite(edge, (OFF, OFF))
canvas.save(dst)
PYEOF
  then
    master="$WORK/master.png"
    info "둥근 모서리 아이콘 적용"
  else
    warn "둥근 모서리 처리를 건너뜁니다 (정사각형 아이콘 사용): $(/usr/bin/tail -n 1 "$WORK/icon_py.err" 2>/dev/null)"
  fi

  local iconset="$WORK/applet.iconset" s
  /bin/mkdir -p "$iconset"
  for s in 16 32 128 256 512; do
    /usr/bin/sips -z $s $s "$master" --out "$iconset/icon_${s}x${s}.png" >/dev/null 2>&1 || { warn "sips ${s}px 실패"; return 1; }
    /usr/bin/sips -z $(( s * 2 )) $(( s * 2 )) "$master" --out "$iconset/icon_${s}x${s}@2x.png" >/dev/null 2>&1 || { warn "sips ${s}px@2x 실패"; return 1; }
  done
  /usr/bin/iconutil -c icns "$iconset" -o "$WORK/applet.icns" 2>"$WORK/iconutil.err" \
    || { warn "iconutil 실패: $(<"$WORK/iconutil.err")"; return 1; }
  /bin/cp -f "$WORK/applet.icns" "$BUILD/Contents/Resources/applet.icns" || { warn "아이콘 복사 실패"; return 1; }
  /bin/cp -f "$master" "$WORK/icon_preview.png"
  info "아이콘 생성 완료 ($(( $(/usr/bin/stat -f %z "$WORK/applet.icns") / 1024 )) KB, 16~1024px)"
  return 0
}

step "아이콘 만들기"
ICON_OK=0
make_icon && ICON_OK=1

# ---------------------------------------------------------------- 4. 설치 (기존 앱 교체)
step "앱 설치: $APP"
if [[ -e "$APP" ]]; then
  /bin/rm -rf "$APP" || die "기존 앱을 지울 수 없습니다: $APP"
fi
/usr/bin/ditto "$BUILD" "$APP" || die "앱을 복사할 수 없습니다: $APP"
/usr/bin/xattr -cr "$APP" 2>/dev/null   # 격리(quarantine) 등 서명을 방해하는 확장 속성 제거

# 번들 내용을 바꿨으므로 로컬(ad-hoc) 서명을 다시 한다. 실패해도 이 Mac에서 직접 만든 앱은 실행된다.
if /usr/bin/codesign --force --deep --sign - "$APP" 2>"$WORK/codesign.err" \
   && /usr/bin/codesign --verify --deep --strict "$APP" 2>>"$WORK/codesign.err"; then
  info "로컬 서명 완료"
else
  warn "코드 서명을 확인하지 못했습니다: $(/usr/bin/tail -n 1 "$WORK/codesign.err" 2>/dev/null)"
fi

# Finder·Dock이 새 아이콘을 바로 보도록 갱신
/usr/bin/touch "$APP" "$APP/Contents" "$APP/Contents/Info.plist"
[[ -x "$LSREGISTER" ]] && "$LSREGISTER" -f "$APP" >/dev/null 2>&1

# ---------------------------------------------------------------- 5. 결과
print
print -r -- "완료: $APP"
if (( ICON_OK )); then
  print -r -- "  아이콘: haru 시안에서 생성"
else
  print -r -- "  아이콘: 기본 애플릿 아이콘"
fi
print -r -- "  더블클릭하면 VN Studio가 실행되고 창이 열립니다. Dock에 끌어다 두면 편합니다."
print -r -- "  종료: $ROOT/scripts/stop_studio.sh"
print -r -- "  Finder에 예전 아이콘이 보이면 잠시 기다리거나 Finder를 다시 열어 보세요."
