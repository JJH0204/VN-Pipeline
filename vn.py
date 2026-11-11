#!/usr/bin/env python3
"""VN-Pipeline CLI. (GUI는 VN Studio — ./studio.sh 또는 'VN Studio.app')

ComfyUI 서버가 켜져 있어야 합니다(./start.sh 또는 VN Studio가 자동 실행).

  python3 vn.py prompt "1girl, maid, cat ears, smile" --n 4        # 자유 프롬프트
  python3 vn.py prompt                                             # 대화형
  python3 vn.py prompt "waving, park" --char haru                  # 캐릭터 외형 + 자유 프롬프트
  python3 vn.py concept haru --n 8                                 # 캐릭터 시안
  python3 vn.py sprite  haru                                       # 스탠딩 + 표정 차분 + 투명 PNG
  python3 vn.py cg      haru "sitting on bench, park, sunset"
  python3 vn.py bg      "classroom, afternoon, sunlight" --name classroom --n 4
  python3 vn.py pixel   "red potion, glass bottle" --subject object --px 64 --colors 16   # 도트(픽셀 아트)
  python3 vn.py icon    "sword\nhealth potion\ngold coin" --style game --name rpg_items      # 아이콘 세트 (줄마다 1개)
  python3 vn.py sheet   haru --motions walk,attack --frames 4 --cell-px 64   # 게임 스프라이트 시트 (동작 × 4방향)
  python3 vn.py export  haru                                       # UI용 워크플로 JSON 저장
  python3 vn.py tag     참고그림.png                               # 이미지 → 프롬프트(Danbooru 태그) 추출
  python3 vn.py pose detect 참고그림.png                           # 이미지 → 포즈(OpenPose 뼈대) 저장 (input/poses/)
  python3 vn.py prompt "1girl, maid, full body" --pose poses/pose_20261109_120000_ab12.png   # 포즈 따라 그리기
  python3 vn.py pose list                                          # 저장된 포즈 목록

tag·pose detect는 ComfyUI 없이 동작합니다 (태거: models/tagger/, 포즈 감지: DWPose). 옵션: python3 vn.py tag --help
포즈(--pose)는 prompt/concept/sprite/cg에서 1차 생성에만 적용됩니다 (ControlNet OpenPose, SDXL 모델 전용).
캐릭터는 ID(haru) 또는 JSON 경로(characters/sample_heroine.json) 둘 다 가능.
모델 프리셋/LoRA 메모/전역 설정은 config/*.json (VN Studio의 '모델·LoRA' 탭에서 편집 가능).
"""
import argparse
import json
import os
import shlex
import sys
import time
import uuid
from pathlib import Path

from vnlib import characters as chars
from vnlib import comfy
from vnlib import pose as poselib
from vnlib import tagger
from vnlib.config import ENGINE_PYTHON, ROOT, SIZES, ConfigError, find_model, load_presets, load_settings
from vnlib import spritesheet as sheetlib
from vnlib.graphs import DITHERS, ICON_STYLES, ICON_TILES, PIXEL_SUBJECTS, JobError, build

# 트레이스백 없이 "오류: …" 한 줄로 보여 줄 오류 (설정·캐릭터 파일 문제, 작업 설정 오류, ComfyUI 연결 실패, 파일 입출력)
USER_ERRORS = (JobError, RuntimeError, chars.CharacterError, ConfigError, OSError)


def lora_arg(s):
    name, _, w = s.rpartition(":")
    return {"name": name, "weight": float(w)} if name else {"name": s, "weight": 0.8}


def char_ref(ref):
    """ID 또는 파일 경로 → character_data dict"""
    p = Path(ref)
    if p.suffix == ".json" and p.exists():
        return chars.load_path(p)
    return chars.load(ref)


def parse_args(argv=None):
    presets = load_presets()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("mode", choices=["prompt", "concept", "sprite", "cg", "bg", "pixel", "icon", "sheet", "export", "tag", "pose"],
                    help="tag: 이미지에서 프롬프트 추출 (python3 vn.py tag --help) / "
                         "pose: 포즈 만들기·목록 (python3 vn.py pose --help)")
    ap.add_argument("target", nargs="?", default="", help="prompt: 프롬프트 / bg: 배경 설명 / pixel: 대상 설명 / "
                         "icon: 아이콘 목록(줄바꿈 또는 \\n 또는 ; 로 구분) / 그 외: 캐릭터 ID 또는 JSON")
    ap.add_argument("scene", nargs="?", default="", help="cg 장면 프롬프트")
    ap.add_argument("--model", choices=list(presets), help="모델 프리셋")
    ap.add_argument("--lora", dest="loras", action="append", type=lora_arg, default=[], help="파일명:가중치")
    ap.add_argument("--n", type=int, help="장수 (기본: prompt 1, 그 외 4)")
    ap.add_argument("--seed", type=int, help="시드 (여러 장이면 +1씩)")
    ap.add_argument("--size", choices=list(SIZES), help="해상도 프리셋")
    ap.add_argument("--fast", action="store_true", help="하이레즈 생략")
    ap.add_argument("--no-hands", action="store_true", help="손 보정 생략")
    ap.add_argument("--upscale", action="store_true", help="스프라이트 2배 업스케일")
    ap.add_argument("--char", help="prompt 모드에서 캐릭터 외형을 붙일 ID/JSON")
    ap.add_argument("--neg", default="", help="추가 네거티브")
    ap.add_argument("--raw", action="store_true", help="품질 태그/기본 네거티브 자동 추가 안 함")
    ap.add_argument("--name", default=None, help="bg·pixel 파일 이름 / icon 세트(폴더) 이름")
    ap.add_argument("--subject", choices=list(PIXEL_SUBJECTS), help="pixel: 대상 종류 (기본 object)")
    ap.add_argument("--px", type=int, metavar="16~512", help="pixel: 결과 가로 픽셀 수 (기본 128)")
    ap.add_argument("--colors", type=int, metavar="2~256", help="pixel: 팔레트 색 수 (기본 32)")
    ap.add_argument("--dither", choices=list(DITHERS), help="pixel: 디더링 (기본 none)")
    ap.add_argument("--opaque", action="store_true", help="pixel·icon: 투명 배경 대신 배경 유지")
    ap.add_argument("--style", choices=list(ICON_STYLES), help="icon: 스타일 (기본 game)")
    ap.add_argument("--tile", choices=["auto"] + list(ICON_TILES), help="icon --style glossy: 타일 색 (기본 auto)")
    ap.add_argument("--motions", default="walk", help=f"sheet: 동작 (쉼표로 구분: {','.join(sheetlib.MOTION_ORDER)})")
    ap.add_argument("--dirs", default="down,left,right,up", help="sheet: 방향 (쉼표로 구분: down,left,right,up)")
    ap.add_argument("--frames", type=int, choices=list(sheetlib.FRAMES), default=4, help="sheet: 동작당 프레임 수")
    ap.add_argument("--no-mirror", action="store_true", help="sheet: 왼쪽을 오른쪽 반전 대신 따로 생성")
    ap.add_argument("--cell-px", type=int, metavar="16~256", help="sheet: 도트화 (칸 가로 픽셀 수). 생략하면 일반 그림")
    ap.add_argument("--hires", action="store_true", help="sheet: 하이레즈 켜기 (기본 끔)")
    ap.add_argument("--sizes", default=None, metavar="256,128,64",
                    help="icon: 원본(1024) 외에 함께 저장할 크기 (기본 256,128,64, 빈 값이면 원본만)")
    ap.add_argument("--pose", metavar="poses/파일.png",
                    help="포즈 따라 그리기: input/poses/ 의 포즈 (vn.py pose list / pose detect). bg에서는 무시")
    ap.add_argument("--pose-strength", type=_ratio(0.1, 2.0), metavar="0.1~2.0",
                    help="포즈 강도 (기본: 설정값, 모델을 바꾸면 그 모델 권장값)")
    ap.add_argument("--pose-end", type=_ratio(0.1, 1.0), metavar="0.1~1.0", help="포즈 적용 구간 끝 (기본: 설정값)")
    ap.add_argument("--pose-model", metavar="파일", help="ControlNet 파일 (models/controlnet/, 기본: 설정값)")
    a = ap.parse_args(argv)
    if a.n is None:
        a.n = 1 if a.mode in ("prompt", "icon") else 4
    if not a.pose and (a.pose_strength is not None or a.pose_end is not None or a.pose_model):
        ap.error("--pose-strength/--pose-end/--pose-model 은 --pose 와 함께 쓰세요")
    if a.pose_model and not find_model("controlnet", a.pose_model):
        names = [c["name"] for c in poselib.list_controlnets()]
        ap.error(f"ControlNet 파일을 찾을 수 없습니다: {a.pose_model} (설치된 파일: {', '.join(names) or '없음'})")
    return a


def to_job(a):
    job = {"mode": a.mode, "preset": a.model, "loras": a.loras, "count": a.n, "seed": a.seed,
           "size": a.size, "hires": not a.fast, "hands": not a.no_hands, "upscale": a.upscale,
           "negative": a.neg, "raw": a.raw, "name": a.name}
    if a.mode == "prompt":
        job["prompt"] = a.target
        if a.char:
            job["character_data"] = char_ref(a.char)
    elif a.mode == "bg":
        job["prompt"] = a.target
    elif a.mode == "pixel":
        job["prompt"] = a.target
        job["pixel"] = {"subject": a.subject, "width": a.px, "colors": a.colors, "dither": a.dither,
                        "transparent": False if a.opaque else None}
    elif a.mode == "sheet":
        p = Path(a.target)
        if (p.suffix == ".json" and p.exists()) or (chars.valid_id(a.target) and chars.path_for(a.target).exists()):
            job["character_data"] = char_ref(a.target)
            job["prompt"] = a.scene
        else:
            job["prompt"] = a.target
        job["hires"] = a.hires
        job["count"] = 1
        job["sheet"] = {"motions": [x.strip() for x in a.motions.split(",") if x.strip()],
                        "directions": [x.strip() for x in a.dirs.split(",") if x.strip()],
                        "frames": a.frames, "mirror": not a.no_mirror, "transparent": not a.opaque,
                        "pixel": {"width": a.cell_px, "colors": a.colors or 32} if a.cell_px else None}
    elif a.mode == "icon":
        job["prompt"] = a.target.replace("\\n", "\n").replace(";", "\n")
        sizes = None if a.sizes is None else [int(x) for x in a.sizes.split(",") if x.strip()]
        job["icon"] = {"style": a.style, "sizes": sizes, "transparent": False if a.opaque else None, "tile": a.tile}
    else:
        job["character_data"] = char_ref(a.target)
        job["prompt"] = a.scene
    if getattr(a, "pose", None):
        job["pose"] = {"name": poselib.normalize_name(a.pose), "strength": a.pose_strength, "end": a.pose_end,
                       "model": a.pose_model}
    return job


def run(job):
    server = load_settings()["comfy_url"]
    r = build(job)
    run_id = uuid.uuid4().hex[:8]
    for node in r["graph"].values():  # 같은 설정을 다시 돌려도 저장 노드는 새로 실행 (ComfyUI 캐시 우회)
        if node.get("class_type") == "SaveImage":
            node["inputs"]["cli_run"] = run_id
    print(f"mode={job['mode']} preset={r['preset']} seed={r['seeds']} nodes={len(r['graph'])}")
    if r.get("pose"):
        ps = r["pose"]
        print(f"포즈: {ps['name']} ({ps['image']}) ControlNet={ps['model']} 강도={ps['strength']} 구간 끝={ps['end']}"
              " — 1차 생성만 (약 40% 느려짐)")
    elif job.get("pose"):
        print("포즈: 배경 모드에서는 쓰지 않습니다")
    for f in comfy.wait(server, comfy.submit(server, r["graph"])):
        print("  output/" + f)


def interactive(base_argv):
    print("대화형 모드: 프롬프트(Danbooru 태그)를 입력하세요. 빈 줄 또는 Ctrl+D로 종료.")
    print("  옵션도 같이 쓸 수 있음 → 예: cat ears, maid, smile --n 2 --size square --model noob")
    while True:
        try:
            line = input("\nprompt> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return
        if not line:
            return
        text, _, opts = line.partition(" --")
        try:
            a = parse_args(["prompt", text] + base_argv + (shlex.split("--" + opts) if opts else []))
            run(to_job(a))
        except SystemExit:
            continue
        except USER_ERRORS as e:
            print(f"오류: {e}")
        except KeyboardInterrupt:
            print("\n중단했습니다. (ComfyUI에 이미 넣은 작업은 계속 진행될 수 있습니다)")


# ---------------------------------------------------------------------- tag: 이미지 → 프롬프트
def _ratio(lo, hi):
    def conv(s):
        try:
            v = float(s)
        except ValueError:
            raise argparse.ArgumentTypeError(f"숫자를 입력하세요: {s}") from None
        if not lo <= v <= hi:
            raise argparse.ArgumentTypeError(f"{lo}~{hi} 사이 값이어야 합니다: {s}")
        return v
    return conv


def parse_tag_args(argv):
    s = load_settings()
    th = s.get("tagger_threshold", 0.35)
    cth = s.get("tagger_char_threshold", 0.85)
    ap = argparse.ArgumentParser(
        prog="vn.py tag",
        description="이미지에서 Danbooru 태그(프롬프트)를 뽑습니다. ComfyUI는 필요 없습니다.\n"
                    "그룹별 태그(점수)와 최종 프롬프트 한 줄을 출력합니다. 기본으로 '제외 권장' 그룹은 프롬프트에서 뺍니다.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="예: python3 vn.py tag output/haru/sprite/haru_base_00001_.png --threshold 0.5")
    ap.add_argument("images", nargs="+", metavar="이미지", help="이미지 파일 (png/jpg/webp/gif/bmp, 여러 개 가능)")
    ap.add_argument("--threshold", type=_ratio(0.05, 0.95), default=th,
                    help=f"일반 태그 기준값: 낮추면 태그가 많아지고 부정확해짐 (기본 {th})")
    ap.add_argument("--char-threshold", type=_ratio(0.3, 0.99), default=cth,
                    help=f"캐릭터 태그(예: hatsune miku) 기준값 (기본 {cth})")
    ap.add_argument("--model", help="태거 모델 폴더 이름 (models/tagger/<이름>, 기본: 설정값)")
    ap.add_argument("--all", action="store_true", help="'제외 권장' 태그(tachi-e, transparent background, 글자·서명, 선정적 태그 등)도 프롬프트에 넣기")
    a = ap.parse_args(argv)
    if a.model is None:
        a.model = tagger.default_name(s.get("tagger_model"))
    return a


def _reexec_with_engine(what="태거"):
    """numpy/onnxruntime이 없는 Python(예: Homebrew python3)으로 실행했으면 엔진 Python으로 다시 실행"""
    try:
        same = Path(sys.executable).resolve() == ENGINE_PYTHON.resolve()
    except OSError:
        same = False
    if same or os.environ.get("VN_TAG_REEXEC") == "1" or not ENGINE_PYTHON.is_file():
        return
    print(f"({what}에 필요한 라이브러리가 이 Python에 없어 엔진 Python으로 다시 실행합니다: {ENGINE_PYTHON})",
          file=sys.stderr)
    sys.stdout.flush()
    os.environ["VN_TAG_REEXEC"] = "1"
    os.execv(str(ENGINE_PYTHON), [str(ENGINE_PYTHON), str(Path(__file__).resolve())] + sys.argv[1:])


def print_tags(path, res, a, elapsed):
    w, h = res["size"]
    print(f"{path}  ({w}×{h}, 모델 {res['model']}, {elapsed:.1f}초)")
    rating = res["rating"]
    top = max(tagger.RATINGS, key=lambda k: rating.get(k, 0))
    print("  등급: " + ", ".join(f"{k} {rating.get(k, 0) * 100:.0f}%" for k in tagger.RATINGS))
    if top in ("questionable", "explicit"):
        print("  주의: 선정성 등급이 높게 나왔습니다. 생성 기본 네거티브에 nsfw가 있으니 태그를 확인하세요.")
    chosen = []
    for g in tagger.GROUPS:
        items = [t for t in res["tags"] if t["group"] == g
                 and t["score"] >= (a.char_threshold if t["kind"] == "character" else a.threshold)]
        if not items:
            continue
        line = ", ".join(f"{t['tag']} {t['score'] * 100:.0f}%" for t in items)
        note = ""
        if g == "meta" and not a.all:
            note = "  ← 프롬프트에서 뺌 (--all 이면 포함)"
        elif g == "character":
            note = "  ← 기존 캐릭터로 인식됨: 넣으면 그 캐릭터 모습이 강하게 반영됩니다"
        print(f"  [{tagger.GROUP_LABELS[g]}] {line}{note}")
        if g != "meta" or a.all:
            chosen.extend(items)
    print("  프롬프트:")
    print(tagger.to_prompt(chosen) or "(기준값을 넘는 태그가 없습니다 — --threshold 를 낮춰 보세요)")


def tag_main(argv):
    a = parse_tag_args(argv)
    if tagger.runtime_error():
        _reexec_with_engine()
        raise tagger.TaggerError(tagger.runtime_error(), "unavailable")
    if a.model is None:
        raise tagger.TaggerError(tagger.no_model_message(), "unavailable")
    tg = None  # 모델은 처음으로 읽을 수 있는 이미지가 나왔을 때 불러옴 (파일 이름 오타에 수십 초 쓰지 않게)
    failed = 0
    for i, path in enumerate(a.images):
        if i:
            print()
        t1 = time.time()
        try:
            im = tagger.open_image(path)
            try:
                if tg is None:
                    t0 = time.time()
                    tg = tagger.get(a.model)
                    if time.time() - t0 > 1.5:
                        print(f"(태거 모델 불러옴: {time.time() - t0:.1f}초)", file=sys.stderr)
                    t1 += time.time() - t0
                res = tg.predict(im)
            finally:
                im.close()
        except tagger.TaggerError as e:
            if e.kind not in ("image", "error"):
                raise
            print(f"{path}\n  오류: {e}")
            failed += 1
            continue
        except Exception as e:  # 예상 못 한 오류도 이 파일만 실패로 처리하고 다음 파일로
            print(f"{path}\n  오류: 이미지를 처리하지 못했습니다 ({e.__class__.__name__})")
            failed += 1
            continue
        res["model"] = tg.name
        print_tags(path, res, a, time.time() - t1)
    if failed:
        sys.exit(1)


# ---------------------------------------------------------------------- pose: 이미지 → 포즈(OpenPose 맵)
def _size_arg(s):
    if s in SIZES:
        return SIZES[s]
    w, sep, h = s.lower().replace("×", "x").partition("x")
    try:
        w, h = int(w), int(h)
    except ValueError:
        raise argparse.ArgumentTypeError(f"크기는 832x1216 또는 {'/'.join(SIZES)} 형식이어야 합니다: {s}") from None
    if not sep or not (poselib.MIN_SIDE <= w <= poselib.MAX_SIDE and poselib.MIN_SIDE <= h <= poselib.MAX_SIDE):
        raise argparse.ArgumentTypeError(f"가로·세로는 {poselib.MIN_SIDE}~{poselib.MAX_SIDE} 사이여야 합니다: {s}")
    return w, h


def pose_main(argv):
    ap = argparse.ArgumentParser(
        prog="vn.py pose",
        description="포즈 따라 그리기용 포즈(OpenPose 뼈대 그림)를 만들고 관리합니다. ComfyUI는 필요 없습니다.\n"
                    "  detect  이미지에서 사람 자세를 감지해 input/poses/ 에 저장 (전신 그림이 가장 정확)\n"
                    "  list    저장된 포즈 목록",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="예: python3 vn.py pose detect output/haru/sprite/haru_base_00001_.png\n"
               "    python3 vn.py prompt \"1girl, maid, full body\" --pose poses/pose_20261109_120000_ab12.png")
    sub = ap.add_subparsers(dest="cmd", required=True, metavar="detect|list")
    d = sub.add_parser("detect", help="이미지 → 포즈 저장")
    d.add_argument("images", nargs="+", metavar="이미지", help="이미지 파일 (여러 개 가능)")
    d.add_argument("--size", type=_size_arg, metavar="832x1216",
                   help=f"포즈 맵 크기 (WxH 또는 {'/'.join(SIZES)}). 기본: 원본 비율의 SDXL 크기. 비율이 다르면 가운데 기준으로 자름")
    d.add_argument("--all", action="store_true", help="여러 명 모두 (기본: 가장 큰 사람 1명)")
    d.add_argument("--no-hands", action="store_true", help="손가락 뼈대 빼기")
    sub.add_parser("list", help="저장된 포즈 목록")
    a = ap.parse_args(argv)

    if a.cmd == "list":
        poses = poselib.list_poses()
        if not poses:
            print(f"저장된 포즈가 없습니다 ({poselib.POSE_DIR}). python3 vn.py pose detect <이미지> 로 만드세요.")
            return
        for m in poses:
            when = time.strftime("%Y-%m-%d %H:%M", time.localtime(float(m.get("created") or 0)))
            extra = []
            if m.get("people"):
                extra.append(f"{m['people']}명")
            if m.get("hands"):
                extra.append("손")
            if m.get("view"):
                extra.append(m["view"])
            print(f"poses/{m['name']}  {m.get('width')}×{m.get('height')}  {m.get('source')}  {when}  "
                  f"{m.get('origin') or ''} {' '.join(extra)}".rstrip())
        return

    err = poselib.detect_error()
    if err:
        if poselib.runtime_error():
            _reexec_with_engine("포즈 감지")
        raise poselib.PoseError(err, "unavailable")
    W, H = a.size if a.size else (None, None)
    failed = 0
    for i, path in enumerate(a.images):
        if i:
            print()
        try:
            im = poselib.open_image(path)
            try:
                res = poselib.detect(im, W, H, hands=not a.no_hands, all_people=a.all)
                src = poselib.preview_jpeg(im, *res["size"])
            finally:
                im.close()
            meta = poselib.save_pose(
                {"source": "image", "origin": Path(path).name, "width": res["size"][0], "height": res["size"][1],
                 "hands": not a.no_hands, "cropped": res["cropped"], "detected": res["detected"]},
                keypoints=res["keypoints"], src_bytes=src)
        except poselib.PoseError as e:
            if e.kind == "unavailable":
                raise
            print(f"{path}\n  오류: {e}")
            failed += 1
            continue
        w, h = res["size"]
        notes = [f"{res['people']}명"]
        if res["detected"] > res["people"]:
            notes.append(f"감지 {res['detected']}명 중 가장 큰 사람")
        if res["cropped"]:
            notes.append("원본과 비율이 달라 가운데 기준으로 자름")
        if res.get("cold"):
            notes.append(f"모델 불러옴 {res['elapsed']:.1f}초")
        print(f"{path}\n  저장: poses/{meta['name']}  ({w}×{h}, {', '.join(notes)})")
        print(f"  생성: python3 vn.py prompt \"1girl, solo, full body\" --pose poses/{meta['name']}")
    if failed:
        sys.exit(1)


def main():
    try:
        if len(sys.argv) > 1 and sys.argv[1] == "tag":
            return tag_main(sys.argv[2:])
        if len(sys.argv) > 1 and sys.argv[1] == "pose":
            return pose_main(sys.argv[2:])
        a = parse_args()
        if a.mode == "prompt" and not a.target:
            return interactive(sys.argv[2:])
        if a.mode == "export":
            c = char_ref(a.target)
            for mode in ("sprite", "concept"):
                r = build({"mode": mode, "character_data": c, "count": 1, "preset": a.model})
                out = ROOT / "workflows" / f"{c['id']}_{mode}_api.json"
                out.parent.mkdir(exist_ok=True)
                out.write_text(json.dumps(r["graph"], indent=2, ensure_ascii=False))
                print(out)
            return
        run(to_job(a))
    except USER_ERRORS as e:
        sys.exit(f"오류: {e}")
    except KeyboardInterrupt:
        print()
        sys.exit("중단했습니다. (ComfyUI에 이미 넣은 작업은 계속 진행될 수 있습니다)")


if __name__ == "__main__":
    main()
