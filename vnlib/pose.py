"""포즈 따라 그리기 (ControlNet OpenPose). CLI(vn.py pose·--pose), 그래프(graphs.py), Studio가 함께 쓴다.

  from vnlib import pose
  im = pose.open_image("output/haru/sprite/haru_base_00003_.png")
  res = pose.detect(im)                                   # DWPose(onnxruntime) → 정규화 키포인트
  meta = pose.save_pose({"source": "image", "origin": "haru_base_00003_.png",
                         "width": res["size"][0], "height": res["size"][1]}, keypoints=res["keypoints"])
  pose.variant_for(meta["name"], "noob_openpose.safetensors")   # → "poses/pose_….png" (LoadImage 입력)

포즈 파일: input/poses/ (ComfyUI 입력 폴더 = VN-Pipeline/input)
  pose_YYYYmmdd_HHMMSS_<4hex>.png        standard 맵 (일반 OpenPose ControlNet용, 얇은 선)
  pose_….thick.png                       thick 맵 (xinsir ControlNet용, 굵은 선)
  pose_….json                            메타 + 키포인트(0~1 정규화)
  pose_….src.jpg                         원본/렌더 미리보기 (선택)

OpenPose 맵은 이 모듈의 draw() 한 곳에서만 그린다(STUDIO_SPEC §9.2). 감지는 comfyui_controlnet_aux의
dw_onnx/{cv_ox_det,cv_ox_pose}.py를 파일 경로에서 직접 불러와 onnxruntime(CPU)으로 돌린다 —
ComfyUI의 DWPreprocessor 노드(OpenCV 대체 경로로 뼈대가 엉뚱하게 그려짐)와 torch를 쓰지 않는다.
numpy·cv2·Pillow·onnxruntime은 함수 안에서 불러온다 → 이 모듈을 import만 하는 곳(graphs, 다른 CLI 명령)은
엔진 Python이 아니어도 동작한다.
"""
import io
import json
import math
import os
import re
import secrets
import struct
import tempfile
import threading
import time
from pathlib import Path

from . import config

INPUT_DIR = config.ROOT / "input"           # ComfyUI --input-directory
POSE_DIR = INPUT_DIR / "poses"
SUBDIR = "poses"                            # LoadImage 입력은 "poses/<파일>"
TRASH_DIR = config.USER_DIR / "trash" / "poses"

MIN_SIDE, MAX_SIDE = 512, 2048
MAX_PIXELS = 50_000_000      # 감지할 원본 이미지 최대 화소
SCORE_MIN = 0.3              # 이 점수 이하인 관절은 없는 것으로 처리 (DWPose와 같음)
BOX_MIN = 0.3                # 사람 상자 점수 기준 (DWPose inference_detector와 같음)
BOX_LAST = 0.02              # 기준을 넘는 상자가 없을 때 마지막으로 써 보는 가장 좋은 상자의 최저 점수
PAD_SCALE = 2.0              # 화면을 꽉 채운 인물은 YOLOX 점수가 매우 낮다 → 이 배율의 흰 캔버스 가운데에 놓고 다시 감지
CROP_TOLERANCE = 0.01        # 한쪽이 이 비율 이하로만 잘리면(8의 배수 맞춤) cropped로 보지 않음
SRC_MAX_SIDE = 1024          # 미리보기(.src.jpg) 긴 변 최대
MAX_PEOPLE = 20
SDXL_AREA = 1024 * 1024      # 감지·생성 기본 크기: 넓이를 이 값(SDXL 1메가픽셀)에 맞춤 (gen_size)

DEFAULT_CONTROLNET = "noob_openpose.safetensors"
# 모델 → 맵 스타일·권장 강도 (§9.10 실측). 표에 없는 모델은 standard / 1.0
CONTROLNETS = {
    "noob_openpose.safetensors": {
        "style": "standard", "strength": 1.0, "label": "NoobAI OpenPose (WAI·NoobAI 권장)"},
    "controlnet-openpose-sdxl-1.0.safetensors": {
        "style": "thick", "strength": 1.2, "label": "xinsir OpenPose (SDXL 범용)"},
}
STYLES = ("standard", "thick")

# DWPose (comfyui_controlnet_aux) — 엔진 쪽에 설치된 것을 그대로 쓴다
AUX_DIR = config.ENGINE_DIR / "ComfyUI" / "custom_nodes" / "comfyui_controlnet_aux"
DW_MODEL_DIR = AUX_DIR / "ckpts" / "yzd-v" / "DWPose"
DW_SRC_DIR = AUX_DIR / "src" / "custom_controlnet_aux" / "dwpose" / "dw_onnx"
DET_MODEL = "yolox_l.onnx"
POSE_MODEL = "dw-ll_ucoco_384.onnx"
POSE_INPUT = (288, 384)

HELP_HINT = "자세한 방법은 도움말 › 포즈 따라 그리기를 보세요."

# ---------------------------------------------------------------------- OpenPose 그리기 규칙 (§9.2)
# 18점: 0 코, 1 목, 2 오른어깨, 3 오른팔꿈치, 4 오른손목, 5 왼어깨, 6 왼팔꿈치, 7 왼손목, 8 오른엉덩이,
#       9 오른무릎, 10 오른발목, 11 왼엉덩이, 12 왼무릎, 13 왼발목, 14 오른눈, 15 왼눈, 16 오른귀, 17 왼귀 (좌우는 인물 기준)
BODY_NAMES = ("코", "목", "오른어깨", "오른팔꿈치", "오른손목", "왼어깨", "왼팔꿈치", "왼손목", "오른엉덩이",
              "오른무릎", "오른발목", "왼엉덩이", "왼무릎", "왼발목", "오른눈", "왼눈", "오른귀", "왼귀")
LIMB_SEQ = ((2, 3), (2, 6), (3, 4), (4, 5), (6, 7), (7, 8), (2, 9), (9, 10), (10, 11), (2, 12), (12, 13), (13, 14),
            (2, 1), (1, 15), (15, 17), (1, 16), (16, 18))   # 1부터 셈
COLORS = ((255, 0, 0), (255, 85, 0), (255, 170, 0), (255, 255, 0), (170, 255, 0), (85, 255, 0), (0, 255, 0),
          (0, 255, 85), (0, 255, 170), (0, 255, 255), (0, 170, 255), (0, 85, 255), (0, 0, 255), (85, 0, 255),
          (170, 0, 255), (255, 0, 255), (255, 0, 170), (255, 0, 85))  # RGB
HAND_EDGES = ((0, 1), (1, 2), (2, 3), (3, 4), (0, 5), (5, 6), (6, 7), (7, 8), (0, 9), (9, 10), (10, 11), (11, 12),
              (0, 13), (13, 14), (14, 15), (15, 16), (0, 17), (17, 18), (18, 19), (19, 20))
HAND_POINT = (0, 0, 255)  # RGB 파랑
N_BODY, N_HAND = 18, 21

# 이름 규칙: 앱이 만든 포즈 = pose_YYYYmmdd_HHMMSS_<4hex>.png, 사용자가 폴더에 직접 넣은 PNG도 허용
NAME_RE = re.compile(r"^pose_[0-9_]+_[0-9a-f]{4}\.png$")
USER_NAME_RE = re.compile(r"^[^\W_][\w.\- ]{0,120}\.png$")
VARIANT_SUFFIX = {"standard": ".png", "thick": ".thick.png", "json": ".json", "src": ".src.jpg"}


class PoseError(RuntimeError):
    """포즈 기능 오류. 메시지는 한국어.

    kind: "unavailable"(numpy·cv2·onnxruntime·DWPose 모델 없음 → 503) | "not_found"(포즈 파일 없음 → 404)
          | "image"(이미지를 읽을 수 없음·크기 문제 → 400) | "invalid"(이름·키포인트 형식 오류 → 400)
          | "no_person"(사람을 찾지 못함 → 422) | "error"(그 밖의 실패 → 500)
    """

    def __init__(self, message, kind="error"):
        super().__init__(message)
        self.kind = kind


# ====================================================================== 이름 / 경로
def valid_name(name):
    """포즈 이름(standard 맵 파일명) 형식 검사. 변형 파일(.thick.png)·숨김 파일·경로는 거부."""
    if not isinstance(name, str) or len(name) > 160 or name.endswith(".thick.png") or name.endswith(".src.png"):
        return False
    return bool(NAME_RE.match(name) or USER_NAME_RE.match(name))


def normalize_name(name):
    """'pose_x.png' / 'poses/pose_x.png' / 'input/poses/pose_x.png' / input/poses 안의 절대 경로 → 'pose_x.png'"""
    if not isinstance(name, str) or not name.strip():
        raise PoseError("포즈 이름이 비어 있습니다", "invalid")
    s = name.strip().replace("\\", "/")
    if "/" in s:
        p = Path(s)
        if p.is_absolute():
            try:
                inside = p.resolve().parent == POSE_DIR.resolve()
            except OSError:
                inside = False
            if not inside:
                raise PoseError(f"포즈 파일은 {POSE_DIR} 폴더 안에 있어야 합니다: {name}", "invalid")
            s = p.name
        else:
            parts = [x for x in s.split("/") if x not in ("", ".")]
            if len(parts) < 2 or parts[-2] != SUBDIR or ".." in parts:
                raise PoseError(f"포즈 이름이 올바르지 않습니다: {name} (예: poses/pose_20261109_120000_ab12.png)", "invalid")
            s = parts[-1]
    if not valid_name(s):
        raise PoseError(f"포즈 이름이 올바르지 않습니다: {name}", "invalid")
    return s


def stem_of(name):
    return name[:-4]  # ".png" 제거


def base_name_of(image):
    """LoadImage 입력('poses/pose_x.thick.png') → 포즈 이름('pose_x.png'). 포즈 파일이 아니면 None."""
    if not isinstance(image, str):
        return None
    s = image.replace("\\", "/")
    parts = s.split("/")
    if len(parts) != 2 or parts[0] != SUBDIR:
        return None
    n = parts[1]
    if n.endswith(".thick.png"):
        n = n[:-len(".thick.png")] + ".png"
    return n if valid_name(n) else None


def pose_path(name, variant="standard"):
    """포즈 파일 경로 (존재 여부는 검사하지 않음). variant: standard | thick | json | src"""
    n = normalize_name(name)
    p = POSE_DIR / (stem_of(n) + VARIANT_SUFFIX[variant])
    # 이름 규칙상 '/'·'..'가 없지만, 심볼릭 링크로 폴더 밖을 가리키는 것은 막는다
    try:
        if p.is_symlink() and not p.resolve().is_relative_to(POSE_DIR.resolve()):
            raise PoseError(f"허용되지 않은 포즈 파일입니다: {n}", "invalid")
    except OSError:
        pass
    return p


def style_for(controlnet):
    return (CONTROLNETS.get(controlnet or "") or {}).get("style", "standard")


def recommended_strength(controlnet):
    return float((CONTROLNETS.get(controlnet or "") or {}).get("strength", 1.0))


def variant_for(pose_name, controlnet_name=None):
    """ControlNet 모델 스타일에 맞는 맵 → LoadImage 입력 'poses/<name>.png' | 'poses/<name>.thick.png'
    (thick 파일이 없으면 standard: 업로드한 OpenPose 그림 등)"""
    n = normalize_name(pose_name)
    if style_for(controlnet_name or DEFAULT_CONTROLNET) == "thick" and pose_path(n, "thick").is_file():
        return f"{SUBDIR}/{stem_of(n)}.thick.png"
    return f"{SUBDIR}/{n}"


def list_controlnets():
    """설치된 ControlNet [{name, path, size, style, strength, label, known}] — 표(CONTROLNETS)에 있는 것 먼저"""
    out = []
    for name, path in config.list_models("controlnet").items():
        try:
            size = path.stat().st_size
        except OSError:
            size = None
        info = CONTROLNETS.get(name) or {}
        out.append({"name": name, "path": str(path), "size": size, "style": info.get("style", "standard"),
                    "strength": float(info.get("strength", 1.0)), "label": info.get("label") or name,
                    "known": bool(info)})
    order = list(CONTROLNETS)
    out.sort(key=lambda c: (order.index(c["name"]) if c["name"] in order else len(order), c["name"].lower()))
    return out


# ====================================================================== 크기
def fit_size(w, h):
    """(w, h) → 512~2048 범위의 8의 배수 (비율 최대한 유지)"""
    w, h = float(w), float(h)
    if w <= 0 or h <= 0:
        raise PoseError("이미지 크기가 올바르지 않습니다", "image")
    s = 1.0
    if max(w, h) * s > MAX_SIDE:
        s = MAX_SIDE / max(w, h)
    if min(w, h) * s < MIN_SIDE:
        s = MIN_SIDE / min(w, h)
    return (max(MIN_SIDE, min(MAX_SIDE, int(w * s) // 8 * 8)),
            max(MIN_SIDE, min(MAX_SIDE, int(h * s) // 8 * 8)))


def gen_size(w, h):
    """포즈(또는 원본) 크기 → SDXL로 그리기 알맞은 생성 크기.

    비율이 기본 크기 프리셋(config.SIZES)과 같으면(±1.5%) 그 크기, 아니면 넓이를 약 1024²에 맞춰(줄이거나 키워) fit_size.
    (예: 하이레즈 결과 1248×1824 → 832×1216, SD1.5용 512×768 포즈 그림 → 832×1248.
     SDXL은 1메가픽셀보다 훨씬 크게 1차 생성하면 몸이 겹치고 매우 느려지고, 훨씬 작게 하면 흐리고 형태가 무너진다)
    """
    try:
        w, h = float(w), float(h)
    except (TypeError, ValueError):
        raise PoseError("이미지 크기가 올바르지 않습니다", "image") from None
    if not (w > 0 and h > 0 and math.isfinite(w) and math.isfinite(h)):
        raise PoseError("이미지 크기가 올바르지 않습니다", "image")
    p = _preset_for(w, h)
    if p:
        return p
    W, H = fit_size(w, h)
    if not (SDXL_AREA * 0.85 <= W * H <= SDXL_AREA * 1.1):
        s = math.sqrt(SDXL_AREA / (w * h))
        W, H = fit_size(w * s, h * s)
    # 8의 배수로 맞춘 뒤 다시 확인 → gen_size(gen_size(x)) == gen_size(x) (맵 크기와 생성 크기가 어긋나지 않게)
    return _preset_for(W, H) or (W, H)


def _preset_for(w, h):
    """비율이 기본 크기 프리셋(config.SIZES)과 ±1.5% 안이면 그 크기, 아니면 None"""
    a = w / h
    for pw, ph in config.SIZES.values():
        if abs(a / (pw / ph) - 1) <= 0.015:
            return pw, ph
    return None


def crop_box(ow, oh, W, H):
    """원본(ow×oh)을 W×H 비율로 가운데 기준 자르는 영역 (x0, y0, cw, ch) — ComfyUI common_upscale(crop="center")와 같은 계산"""
    x = y = 0
    old, new = ow / oh, W / H
    if old > new:
        x = round((ow - ow * (new / old)) / 2)
    elif old < new:
        y = round((oh - oh * (old / new)) / 2)
    return x, y, ow - 2 * x, oh - 2 * y


def png_size(path):
    """PNG 헤더(IHDR)에서 (w, h) — Pillow 없이(표준 라이브러리만). PNG가 아니면 Pillow로 시도."""
    with open(path, "rb") as f:
        head = f.read(24)
    if len(head) >= 24 and head[:8] == b"\x89PNG\r\n\x1a\n" and head[12:16] == b"IHDR":
        w, h = struct.unpack(">II", head[16:24])
        return int(w), int(h)
    try:
        from PIL import Image
    except ImportError:
        raise PoseError(f"포즈 파일이 PNG 형식이 아닙니다: {Path(path).name}", "image") from None
    try:
        with Image.open(path) as im:
            return im.size
    except Exception:
        raise PoseError(f"포즈 이미지를 읽을 수 없습니다: {Path(path).name}", "image") from None


# ====================================================================== 런타임 (numpy·cv2·onnxruntime·DWPose)
_runtime = {"checked": False, "error": None}
_runtime_lock = threading.Lock()


def runtime_error():
    """포즈 감지·맵 그리기를 쓸 수 있으면 None, 아니면 한국어 안내문 (라이브러리는 한 번만 검사, 모델 파일은 매번)"""
    with _runtime_lock:
        if not _runtime["checked"]:
            missing = []
            for mod in ("numpy", "cv2", "PIL", "onnxruntime"):
                try:
                    __import__(mod)
                except Exception:  # ImportError 외에 네이티브 라이브러리 로드 실패도 있음
                    missing.append({"PIL": "Pillow", "cv2": "opencv(cv2)"}.get(mod, mod))
            if missing:
                _runtime["error"] = (
                    f"이 Python에는 {', '.join(missing)}이(가) 없어 포즈 기능을 쓸 수 없습니다. "
                    f"엔진 Python({config.ENGINE_PYTHON})으로 실행하세요. {HELP_HINT}")
            _runtime["checked"] = True
        return _runtime["error"]


def draw_error():
    """맵 그리기(draw)에 필요한 라이브러리 오류 (감지 모델 파일은 필요 없음)"""
    return runtime_error()


def detect_error():
    """포즈 감지(detect)를 쓸 수 없는 이유 (라이브러리 + DWPose 모델/코드 파일), 쓸 수 있으면 None"""
    err = runtime_error()
    if err:
        return err
    need = [DW_MODEL_DIR / DET_MODEL, DW_MODEL_DIR / POSE_MODEL, DW_SRC_DIR / "cv_ox_det.py", DW_SRC_DIR / "cv_ox_pose.py"]
    lost = [p for p in need if not p.is_file()]
    if lost:
        return ("포즈 감지 모델(DWPose)을 찾을 수 없습니다: " + ", ".join(p.name for p in lost)
                + f" — ComfyUI의 comfyui_controlnet_aux 확장({AUX_DIR})과 DWPose 모델(yolox_l.onnx, "
                  f"dw-ll_ucoco_384.onnx)이 설치되어 있어야 합니다. {HELP_HINT}")
    return None


def _require(err):
    if err:
        raise PoseError(err, "unavailable")


def _load_module(name, path):
    import importlib.util
    spec = importlib.util.spec_from_file_location(name, str(path))
    if spec is None or spec.loader is None:
        raise PoseError(f"포즈 감지 코드를 불러올 수 없습니다: {path}", "unavailable")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class _Detector:
    """DWPose: YOLOX(사람 상자) + RTMPose 계열(133점). onnxruntime CPU."""

    def __init__(self):
        import onnxruntime as ort
        t0 = time.time()
        try:
            self.det = _load_module("vn_dw_cv_ox_det", DW_SRC_DIR / "cv_ox_det.py")
            self.pose = _load_module("vn_dw_cv_ox_pose", DW_SRC_DIR / "cv_ox_pose.py")
        except PoseError:
            raise
        except Exception as e:
            raise PoseError(f"포즈 감지 코드를 불러오지 못했습니다 ({e.__class__.__name__}: {str(e)[:200]}). {HELP_HINT}",
                            "unavailable") from None
        try:
            opts = ort.SessionOptions()
            opts.log_severity_level = 3
            prov = ["CPUExecutionProvider"]
            self.s_det = ort.InferenceSession(str(DW_MODEL_DIR / DET_MODEL), sess_options=opts, providers=prov)
            self.s_pose = ort.InferenceSession(str(DW_MODEL_DIR / POSE_MODEL), sess_options=opts, providers=prov)
        except Exception as e:
            raise PoseError(f"포즈 감지 모델(DWPose)을 불러오지 못했습니다. 파일이 손상되었을 수 있습니다: "
                            f"{e.__class__.__name__}: {str(e)[:200]}", "unavailable") from None
        self.load_seconds = time.time() - t0


_detector = None
_detector_lock = threading.Lock()


def _get_detector():
    global _detector
    _require(detect_error())
    with _detector_lock:
        if _detector is None:
            _detector = _Detector()
        return _detector


def loaded():
    return _detector is not None


def unload():
    """감지 모델을 메모리에서 내린다 (≈0.5GB). 내린 게 있으면 True"""
    global _detector
    with _detector_lock:
        had = _detector is not None
        _detector = None
    if had:
        import gc
        gc.collect()
    return had


# ====================================================================== 이미지
def open_image(src):
    """경로 또는 bytes → 디코딩까지 끝난 PIL 이미지 (애니메이션은 첫 프레임). 실패 시 PoseError(kind="image")."""
    _require(runtime_error())
    from PIL import Image

    if isinstance(src, (bytes, bytearray, memoryview)):
        fp, label = io.BytesIO(bytes(src)), "업로드한 파일"
    else:
        p = Path(src)
        if not p.is_file():
            raise PoseError(f"파일을 찾을 수 없습니다: {src}", "image")
        fp, label = p, p.name
    bad = f"이미지를 읽을 수 없습니다 ({label}). PNG·JPG·WEBP·GIF·BMP 이미지 파일인지 확인하세요."
    try:
        im = Image.open(fp)
        w, h = im.size
        if w < 1 or h < 1:
            raise PoseError(bad, "image")
        if w * h > MAX_PIXELS:
            im.close()
            raise PoseError(f"이미지가 너무 큽니다 ({w}×{h}, 최대 {MAX_PIXELS // 10_000}만 화소). "
                            "크기를 줄여서 다시 시도하세요.", "image")
        im.load()
        return im
    except PoseError:
        raise
    except Image.DecompressionBombError:
        raise PoseError("이미지가 너무 큽니다 (화소 수 제한 초과). 크기를 줄여서 다시 시도하세요.", "image") from None
    except Exception:  # Pillow 플러그인이 던지는 각종 예외 (손상된 파일)
        raise PoseError(bad, "image") from None


def to_rgb(image, background=(255, 255, 255)):
    """EXIF 회전 보정 → 투명은 배경색에 합성 → RGB"""
    from PIL import Image, ImageOps
    try:
        im = ImageOps.exif_transpose(image)
    except Exception:  # 손상된 EXIF
        im = image
    if im.mode.startswith("I;16") or im.mode in ("I", "F"):  # 16비트·부동소수 흑백 → 8비트
        import numpy as np
        a = np.asarray(im.convert("F") if im.mode != "F" else im, dtype=np.float32)
        if a.size and float(a.max()) > 255:
            a = a * (255.0 / 65535.0)
        im = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "L")
    if im.mode in ("RGBA", "LA", "PA", "RGBa", "La") or "transparency" in im.info:
        im = im.convert("RGBA")
        bg = Image.new("RGBA", im.size, tuple(background) + (255,))
        bg.alpha_composite(im)
        im = bg
    return im.convert("RGB")


def encode_png(arr_or_image):
    from PIL import Image
    im = arr_or_image if isinstance(arr_or_image, Image.Image) else Image.fromarray(arr_or_image, "RGB")
    buf = io.BytesIO()
    im.save(buf, "PNG", compress_level=6)
    return buf.getvalue()


def preview_jpeg(image, W=None, H=None, max_side=SRC_MAX_SIDE):
    """미리보기 JPEG: (W, H)가 있으면 맵과 똑같이 가운데 기준으로 잘라 W:H 비율로(겹쳐 보기용), 긴 변 max_side 이하"""
    from PIL import Image
    im = to_rgb(image)
    if W and H:
        x0, y0, cw, ch = crop_box(im.width, im.height, W, H)
        if (x0, y0) != (0, 0):
            im = im.crop((x0, y0, x0 + cw, y0 + ch))
        tw, th = W, H
    else:
        tw, th = im.size
    s = min(1.0, max_side / max(tw, th))
    tw, th = max(1, round(tw * s)), max(1, round(th * s))
    if (tw, th) != im.size:
        im = im.resize((tw, th), Image.Resampling.LANCZOS, reducing_gap=3.0)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=88, optimize=True)
    return buf.getvalue()


# ====================================================================== 키포인트
def _point(v):
    """[x, y] (0~1) → [x, y] | None. 범위를 조금 벗어난 반올림 오차는 잘라 맞추고, 크게 벗어나면(화면 밖) 생략."""
    if v is None:
        return None
    if not isinstance(v, (list, tuple)) or len(v) < 2:
        raise PoseError("키포인트 형식이 올바르지 않습니다 (점은 [x, y] 또는 null)", "invalid")
    try:
        x, y = float(v[0]), float(v[1])
    except (TypeError, ValueError):
        raise PoseError("키포인트 좌표는 숫자여야 합니다", "invalid") from None
    if not (math.isfinite(x) and math.isfinite(y)):
        raise PoseError("키포인트 좌표가 올바르지 않습니다", "invalid")
    if not (-0.01 <= x <= 1.01 and -0.01 <= y <= 1.01):
        return None
    return [round(min(1.0, max(0.0, x)), 5), round(min(1.0, max(0.0, y)), 5)]


def _points(v, n, what):
    if v is None:
        return None
    if not isinstance(v, (list, tuple)) or len(v) != n:
        raise PoseError(f"{what} 점은 {n}개여야 합니다", "invalid")
    pts = [_point(p) for p in v]
    return pts if any(p is not None for p in pts) else None


def clean_keypoints(kp, hands=True):
    """{people: [{body: 18×([x,y]|null), left_hand: 21×…|null, right_hand: …}]} 검증·정리 (빈 사람은 제거)"""
    if isinstance(kp, (list, tuple)):
        kp = {"people": list(kp)}
    if not isinstance(kp, dict) or not isinstance(kp.get("people"), list):
        raise PoseError("키포인트 형식이 올바르지 않습니다 ({\"people\": [...]} 필요)", "invalid")
    people = kp["people"]
    if len(people) > MAX_PEOPLE:
        raise PoseError(f"사람은 최대 {MAX_PEOPLE}명까지입니다", "invalid")
    out = []
    for person in people:
        if not isinstance(person, dict):
            raise PoseError("키포인트 형식이 올바르지 않습니다 (사람마다 {body, left_hand, right_hand})", "invalid")
        body = _points(person.get("body"), N_BODY, "몸")
        lh = _points(person.get("left_hand"), N_HAND, "왼손") if hands else None
        rh = _points(person.get("right_hand"), N_HAND, "오른손") if hands else None
        if body is None and lh is None and rh is None:
            continue
        out.append({"body": body or [None] * N_BODY, "left_hand": lh, "right_hand": rh})
    return {"people": out}


def has_hands(kp):
    return any(p.get("left_hand") or p.get("right_hand") for p in (kp or {}).get("people", []))


# ====================================================================== 그리기 (§9.2)
def draw(keypoints, W, H, hands=True, style="standard"):
    """정규화 키포인트 → OpenPose 맵 (numpy uint8 [H, W, 3] RGB, 검은 배경).

    style: "standard"(일반 OpenPose ControlNet, 얇은 선) | "thick"(xinsir ControlNet, DWPose scale_stick_for_xinsr_cn)
    """
    _require(draw_error())
    import colorsys

    import cv2
    import numpy as np

    if style not in STYLES:
        raise PoseError(f"알 수 없는 선 스타일입니다: {style}", "invalid")
    W, H = int(W), int(H)
    kp = clean_keypoints(keypoints, hands=hands)
    canvas = np.zeros((H, W, 3), np.uint8)
    k = min(W, H) / 512
    md = max(W, H) / k
    stick_scale = (1 if md < 500 else min(2 + int(md // 1000), 7)) if style == "thick" else 1
    stick = int(4 * stick_scale * k)
    rad = max(1, round(4 * k))
    hand_w = max(1, round(2 * k))
    hand_colors = [tuple(int(round(c * 255)) for c in colorsys.hsv_to_rgb(i / len(HAND_EDGES), 1.0, 1.0))
                   for i in range(len(HAND_EDGES))]
    for person in kp["people"]:
        pts = [(p[0] * W, p[1] * H) if p else None for p in person["body"]]
        for (a, b), c in zip(LIMB_SEQ, COLORS):  # 먼저 모든 선
            P, Q = pts[a - 1], pts[b - 1]
            if P is None or Q is None:
                continue
            mx, my = (P[0] + Q[0]) / 2, (P[1] + Q[1]) / 2
            length = math.hypot(P[0] - Q[0], P[1] - Q[1])
            angle = math.degrees(math.atan2(P[1] - Q[1], P[0] - Q[0]))
            poly = cv2.ellipse2Poly((int(mx), int(my)), (int(length / 2), stick), int(angle), 0, 360, 1)
            cv2.fillConvexPoly(canvas, poly, [int(v * 0.6) for v in c])
        for pt, c in zip(pts, COLORS):  # 그다음 점
            if pt is not None:
                cv2.circle(canvas, (int(pt[0]), int(pt[1])), rad, c, thickness=-1)
        if not hands:
            continue
        for hand in (person.get("left_hand"), person.get("right_hand")):
            if not hand:
                continue
            hp = [(int(p[0] * W), int(p[1] * H)) if p else None for p in hand]
            for i, (a, b) in enumerate(HAND_EDGES):
                if hp[a] is not None and hp[b] is not None:
                    cv2.line(canvas, hp[a], hp[b], hand_colors[i], thickness=hand_w)
            for q in hp:
                if q is not None:
                    cv2.circle(canvas, q, rad, HAND_POINT, thickness=-1)
    return canvas


# ====================================================================== 감지
def _to_openpose(kps, scores):
    """DWPose 133점(COCO-WholeBody) → 134점(OpenPose 18점 순서 + 목 삽입) [n, 134, 3] (x, y, score)"""
    import numpy as np
    k = np.concatenate([kps, scores[..., None]], axis=-1)
    neck = np.mean(k[:, [5, 6]], axis=1)
    neck[:, 2:3] = np.logical_and(k[:, 5, 2:3] > SCORE_MIN, k[:, 6, 2:3] > SCORE_MIN).astype(k.dtype)
    new = np.insert(k, 17, neck, axis=1)
    mm = [17, 6, 8, 10, 7, 9, 12, 14, 16, 13, 15, 2, 1, 4, 3]
    op = [1, 2, 3, 4, 6, 7, 8, 9, 10, 12, 13, 14, 15, 16, 17]
    new[:, op] = new[:, mm]
    return new


def _person_boxes(d, img):
    """YOLOX 사람 상자 → (상자 [n, 4] xyxy 원본 좌표, 점수 [n]), 점수 높은 순.

    DWPose inference_detector와 같은 계산(같은 전처리·NMS 0.45)이지만 0.3 미만 상자도 점수와 함께 돌려준다
    (BOX_LAST 초과만). 점수가 높은 상자는 낮은 상자에 지워지지 않으므로 BOX_MIN으로 거르면 원래 결과와 같다.
    """
    import numpy as np
    m = d.det
    if not all(hasattr(m, f) for f in ("preprocess", "demo_postprocess", "nms")):  # 확장 코드가 바뀐 경우
        b = m.inference_detector(d.s_det, img, detect_classes=[0], dtype=np.float32)
        b = np.zeros((0, 4), np.float32) if b is None else np.asarray(b, np.float32).reshape(-1, 4)
        return b, np.ones(len(b), np.float32)
    size = (640, 640)
    inp, ratio = m.preprocess(img, size)
    out = d.s_det.run(None, {d.s_det.get_inputs()[0].name: inp[None].astype(np.float32)})
    pred = m.demo_postprocess(out[0], size)[0]
    s = pred[:, 4] * pred[:, 5]  # objectness × 사람(class 0)
    keep = s > BOX_LAST
    if not keep.any():
        return np.zeros((0, 4), np.float32), np.zeros(0, np.float32)
    c, s = pred[keep, :4], s[keep]
    xyxy = np.stack([c[:, 0] - c[:, 2] / 2, c[:, 1] - c[:, 3] / 2,
                     c[:, 0] + c[:, 2] / 2, c[:, 1] + c[:, 3] / 2], axis=1) / ratio
    k = m.nms(xyxy, s, 0.45)
    return xyxy[k].astype(np.float32), s[k].astype(np.float32)


def _padded_boxes(d, img):
    """그림을 PAD_SCALE배 흰 캔버스 가운데에 놓고 다시 감지 → 원본 좌표 상자·점수 (원본 밖 부분은 잘라 냄).

    인물이 세로를 거의 꽉 채운 그림(캐릭터 시안 등)은 YOLOX 점수가 0.03 안팎이라 버려지는데, 여백을 주면 0.8 가까이 나온다.
    아주 큰 그림만 긴 변 2048로 먼저 줄인다(캔버스 메모리 절약). 640까지 미리 줄이면 점수가 눈에 띄게 낮아져 그렇게 하지 않는다.
    """
    import cv2
    import numpy as np
    oh, ow = img.shape[:2]
    s = min(1.0, 2048.0 / max(ow, oh))
    small = (cv2.resize(img, (max(1, round(ow * s)), max(1, round(oh * s))), interpolation=cv2.INTER_AREA)
             if s < 1.0 else img)
    h, w = small.shape[:2]
    H, W = round(h * PAD_SCALE), round(w * PAD_SCALE)
    y, x = (H - h) // 2, (W - w) // 2
    canvas = np.full((H, W, 3), 255, np.uint8)
    canvas[y:y + h, x:x + w] = small
    b, sc = _person_boxes(d, canvas)
    if not len(b):
        return b, sc
    b = (b - np.array([x, y, x, y], np.float32)) / s
    b[:, [0, 2]] = b[:, [0, 2]].clip(0, ow)
    b[:, [1, 3]] = b[:, [1, 3]].clip(0, oh)
    ok = ((b[:, 2] - b[:, 0]) >= 0.02 * ow) & ((b[:, 3] - b[:, 1]) >= 0.02 * oh)  # 여백에만 있던 상자 버림
    return b[ok], sc[ok]


def _target_size(ow, oh, width, height):
    if width in (None, "", 0) and height in (None, "", 0):
        return gen_size(ow, oh)
    if width in (None, "", 0) or height in (None, "", 0):
        raise PoseError("포즈 크기는 가로와 세로를 함께 정해야 합니다", "invalid")
    try:
        W, H = int(width), int(height)
    except (TypeError, ValueError):
        raise PoseError("포즈 크기는 정수여야 합니다", "invalid") from None
    if not (MIN_SIDE <= W <= MAX_SIDE and MIN_SIDE <= H <= MAX_SIDE):
        raise PoseError(f"포즈 크기는 가로·세로 {MIN_SIDE}~{MAX_SIDE} 사이여야 합니다 (입력: {W}×{H})", "invalid")
    return W, H


def detect(image, width=None, height=None, hands=True, all_people=False):
    """이미지에서 사람 자세(OpenPose 18점 + 손 21점×2) 감지 → 정규화 키포인트.

    width/height: 맵 크기. 없으면 원본 비율 그대로 gen_size(원본) (SDXL 생성 크기).
    목표 비율이 원본과 다르면 ComfyUI center crop과 같은 방식으로 가운데를 잘라 맞추고 cropped=True
    (한쪽이 CROP_TOLERANCE(1%) 넘게 잘릴 때만 — 8의 배수 맞춤으로 몇 픽셀 잘리는 것은 제외).
    all_people=False면 가장 큰 사람(상자 면적) 1명만.
    사람 상자(점수 0.3 초과)가 없으면: ① 2배 흰 캔버스 가운데에 놓고 다시 감지 ② 가장 좋은 상자(점수 0.02 이상)
    ③ 그림 전체를 상자로 — 순서로 시도하고, 관절이 2개 미만이면 no_person.
    → {"keypoints": {"people": [...]}, "people": n, "size": [W, H], "cropped": bool, "detected": 감지된 사람 수
       (③이면 0), "box": "detector"|"padded"|"weak"|"whole", "elapsed": 초, "cold": 이번에 모델을 불러왔는지}
    """
    import numpy as np

    rgb = to_rgb(image)
    ow, oh = rgb.size
    W, H = _target_size(ow, oh, width, height)
    t0 = time.time()
    cold = not loaded()
    d = _get_detector()
    # YOLOX(사람 상자)는 cv2 BGR로 학습 → BGR, RTMPose(관절)는 RGB로 학습(bgr_to_rgb, 전처리가 채널을 안 바꿈) → RGB.
    # 관절에 BGR을 주면 전신 그림에서 한 손이 통째로 빠지거나 손목이 어긋난다 (comfyui_controlnet_aux도 RGB를 넘김)
    rgb_np = np.ascontiguousarray(np.asarray(rgb))
    img = np.ascontiguousarray(rgb_np[:, :, ::-1])  # BGR
    try:
        raw_b, raw_s = _person_boxes(d, img)
        boxes, how = raw_b[raw_s > BOX_MIN], "detector"
        if not len(boxes):
            pad_b, pad_s = _padded_boxes(d, img)
            boxes, how = pad_b[pad_s > BOX_MIN], "padded"
            if not len(boxes):
                cand_b, cand_s = np.concatenate([raw_b, pad_b]), np.concatenate([raw_s, pad_s])
                if len(cand_s) and float(cand_s.max()) >= BOX_LAST:
                    i = int(np.argmax(cand_s))
                    boxes, how = cand_b[i:i + 1], "weak"
                else:
                    boxes, how = np.array([[0, 0, ow, oh]], np.float32), "whole"
        found = 0 if how == "whole" else len(boxes)
        area = (boxes[:, 2] - boxes[:, 0]) * (boxes[:, 3] - boxes[:, 1])
        order = np.argsort(-area, kind="stable")
        boxes = boxes[order if all_people else order[:1]]
        kps, scores = d.pose.inference_pose(d.s_pose, boxes, rgb_np, POSE_INPUT, dtype=np.float32)
    except MemoryError:
        raise PoseError("포즈 감지 중 메모리가 부족합니다. 더 작은 이미지로 다시 시도하세요.", "image") from None
    except Exception as e:
        raise PoseError(f"포즈 감지 중 오류가 발생했습니다: {e.__class__.__name__}: {str(e)[:300]}") from None
    people = _to_openpose(np.asarray(kps), np.asarray(scores))
    x0, y0, cw, ch = crop_box(ow, oh, W, H)

    def norm(p):
        if not p[2] > SCORE_MIN:
            return None
        x, y = (float(p[0]) - x0) / cw, (float(p[1]) - y0) / ch
        if not (0.0 <= x <= 1.0 and 0.0 <= y <= 1.0):
            return None  # 잘린 영역 밖
        return [round(x, 5), round(y, 5)]

    out = []
    for p in people:
        body = [norm(p[i]) for i in range(N_BODY)]
        lh = [norm(p[i]) for i in range(92, 113)] if hands else None
        rh = [norm(p[i]) for i in range(113, 134)] if hands else None
        lh = lh if lh and any(lh) else None
        rh = rh if rh and any(rh) else None
        if sum(1 for b in body if b) < 2 and not lh and not rh:
            continue  # 관절을 거의 못 찾은 사람(또는 잘린 영역 밖)
        out.append({"body": body, "left_hand": lh, "right_hand": rh})
    if not out:
        if how in ("weak", "whole"):  # 사람 상자를 제대로 못 찾았음
            raise PoseError("사람(인물)을 찾지 못했습니다. 인물이 크게 보이는 그림을 쓰세요 — 전신 그림이 가장 정확합니다.",
                            "no_person")
        raise PoseError("사람은 찾았지만 관절(팔·다리·머리)을 알아볼 수 없습니다. 인물이 더 크게·온전히 보이는 그림을 쓰세요.",
                        "no_person")
    return {"keypoints": {"people": out}, "people": len(out), "size": [W, H],
            "cropped": x0 > CROP_TOLERANCE * ow or y0 > CROP_TOLERANCE * oh, "detected": int(found), "box": how,
            "elapsed": round(time.time() - t0, 3), "cold": cold}


# ====================================================================== 포즈 파일 (라이브러리)
def _write_bytes(path, data):
    """원자적 저장 (임시 파일 → os.replace)"""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix="." + path.name, suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _new_name():
    for _ in range(50):
        n = time.strftime("pose_%Y%m%d_%H%M%S_") + secrets.token_hex(2) + ".png"
        if not any((POSE_DIR / (stem_of(n) + suf)).exists() for suf in VARIANT_SUFFIX.values()):
            return n
    raise PoseError("포즈 파일 이름을 만들지 못했습니다. 잠시 후 다시 시도하세요.")


def _clean_meta_text(v, limit=200):
    if v is None:
        return None
    s = str(v).strip()
    return s[:limit] or None


def read_map_image(map_png):
    """업로드한 OpenPose 그림 bytes → RGB PIL 이미지 (투명은 검은 배경에 합성)"""
    im = open_image(map_png)
    try:
        return to_rgb(im, background=(0, 0, 0))
    finally:
        im.close()


def save_pose(meta, keypoints=None, map_png=None, src_bytes=None):
    """포즈 저장 → 저장된 메타(name 포함).

    keypoints가 있으면 standard·thick 두 맵을 그려 저장(meta의 width·height 크기).
    없으면(source="upload") map_png(이미 그려진 OpenPose 그림)를 PNG로 다시 저장 — 크기 512~2048, 메타 크기와 같아야 함.
    src_bytes: 원본/렌더 미리보기 이미지(PNG/JPEG …) → .src.jpg (긴 변 1024 이하)
    """
    _require(draw_error())
    meta = dict(meta or {})
    files = {}
    if keypoints is not None:
        try:
            W, H = int(meta.get("width")), int(meta.get("height"))
        except (TypeError, ValueError):
            raise PoseError("포즈 크기(width, height)가 필요합니다", "invalid") from None
        if not (MIN_SIDE <= W <= MAX_SIDE and MIN_SIDE <= H <= MAX_SIDE):
            raise PoseError(f"포즈 크기는 가로·세로 {MIN_SIDE}~{MAX_SIDE} 사이여야 합니다 (입력: {W}×{H})", "invalid")
        want_hands = meta.get("hands", True) is not False
        kp = clean_keypoints(keypoints, hands=want_hands)
        if not kp["people"]:
            raise PoseError("뼈대 점이 하나도 없습니다. 모델 전체가 화면에 보이게 각도·프레이밍을 조정하세요.", "no_person")
        files["standard"] = encode_png(draw(kp, W, H, hands=want_hands, style="standard"))
        files["thick"] = encode_png(draw(kp, W, H, hands=want_hands, style="thick"))
        meta["keypoints"] = kp
        meta["people"] = len(kp["people"])
        meta["hands"] = has_hands(kp)
    elif map_png is not None:
        im = read_map_image(map_png)
        W, H = im.size
        if not (MIN_SIDE <= W <= MAX_SIDE and MIN_SIDE <= H <= MAX_SIDE):
            raise PoseError(f"포즈 그림 크기는 가로·세로 {MIN_SIDE}~{MAX_SIDE} 사이여야 합니다 (이 그림: {W}×{H})", "image")
        if meta.get("width") not in (None, ""):
            try:
                want = (int(meta["width"]), int(meta.get("height") or 0))
            except (TypeError, ValueError):
                raise PoseError("포즈 크기(width, height)는 정수여야 합니다", "invalid") from None
            if want != (W, H):
                raise PoseError(f"포즈 그림 크기({W}×{H})가 지정한 크기({want[0]}×{want[1]})와 다릅니다", "image")
        files["standard"] = encode_png(im)
        meta.update(keypoints=None, people=meta.get("people"), hands=False)
        meta["source"] = meta.get("source") or "upload"
    else:
        raise PoseError("키포인트 또는 포즈 그림이 필요합니다", "invalid")
    if src_bytes:
        src = open_image(src_bytes)
        try:
            files["src"] = preview_jpeg(src)
        finally:
            src.close()

    out = {"name": None, "width": W, "height": H, "source": meta.get("source") or "image",
           "origin": _clean_meta_text(meta.get("origin")) or "", "people": meta.get("people"),
           "hands": bool(meta.get("hands")), "created": round(time.time(), 3)}
    for key in ("view", "framing", "clip"):
        v = _clean_meta_text(meta.get(key))
        if v:
            out[key] = v
    for key in ("cropped",):
        if key in meta:
            out[key] = bool(meta[key])
    if isinstance(meta.get("detected"), int):
        out["detected"] = meta["detected"]
    out["keypoints"] = meta.get("keypoints")

    POSE_DIR.mkdir(parents=True, exist_ok=True)
    name = _new_name()
    out["name"] = name
    stem = stem_of(name)
    written = []
    try:
        # standard 맵(.png)을 마지막에 쓴다 — 목록은 .png 기준이므로 반쯤 저장된 포즈가 보이지 않게
        for variant in ("thick", "src"):
            if variant in files:
                p = POSE_DIR / (stem + VARIANT_SUFFIX[variant])
                _write_bytes(p, files[variant])
                written.append(p)
        p = POSE_DIR / (stem + ".json")
        _write_bytes(p, (json.dumps(out, ensure_ascii=False, indent=1) + "\n").encode("utf-8"))
        written.append(p)
        _write_bytes(POSE_DIR / name, files["standard"])
    except OSError as e:
        for p in written:
            try:
                p.unlink()
            except OSError:
                pass
        raise PoseError(f"포즈 파일을 저장하지 못했습니다: {e.strerror or e}") from None
    return out


def _synth_meta(name, path):
    """JSON이 없는 포즈(사용자가 폴더에 직접 넣은 OpenPose PNG)의 메타"""
    try:
        w, h = png_size(path)
    except (OSError, PoseError):
        w = h = None
    try:
        created = path.stat().st_mtime
    except OSError:
        created = 0.0
    return {"name": name, "width": w, "height": h, "source": "upload", "origin": name, "people": None,
            "hands": False, "created": created, "keypoints": None}


META_SOURCES = ("3d", "image", "upload")


def _num(v, cast=float):
    """JSON 값 → 유한한 양수(cast) | None (문자열·bool·NaN 등은 None)"""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    if not math.isfinite(v) or v <= 0:
        return None
    return cast(v)


def _sanitize_meta(meta, name, path):
    """JSON 메타의 값 형식을 맞춘다 — 손으로 고치거나 다른 도구가 쓴 JSON이라도 목록·API가 죽지 않게"""
    for key in ("width", "height"):
        v = _num(meta.get(key), int)
        meta[key] = v
    if not meta["width"] or not meta["height"]:
        try:
            meta["width"], meta["height"] = png_size(path)
        except (OSError, PoseError):
            meta["width"] = meta["height"] = None
    created = _num(meta.get("created"))
    if created is None:
        try:
            created = path.stat().st_mtime
        except OSError:
            created = 0.0
    meta["created"] = created
    people = meta.get("people")
    meta["people"] = people if isinstance(people, int) and not isinstance(people, bool) and people >= 0 else None
    meta["hands"] = meta.get("hands") is True
    for key in ("origin", "view", "framing", "clip"):
        if key in meta and not isinstance(meta[key], str):
            meta.pop(key)
    if "cropped" in meta and not isinstance(meta["cropped"], bool):
        meta.pop("cropped")
    if "detected" in meta and (not isinstance(meta["detected"], int) or isinstance(meta["detected"], bool)):
        meta.pop("detected")
    kp = meta.get("keypoints")
    if kp is not None:
        try:
            meta["keypoints"] = clean_keypoints(kp)
        except PoseError:
            meta["keypoints"] = None
    return meta


def _meta_for(name):
    p = POSE_DIR / name
    jp = POSE_DIR / (stem_of(name) + ".json")
    meta = None
    if jp.is_file():
        try:
            meta = json.loads(jp.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            meta = None
        # 같은 이름의 JSON이라도 우리가 쓴 메타(source 값으로 구분)만 쓴다 — OpenPose 편집기·ControlNet의
        # 'JSON 내려받기'처럼 다른 도구가 PNG 옆에 둔 JSON({people: [...], canvas_width …})은 무시하고 업로드 그림으로 본다.
        # (이름은 비교하지 않음: 사용자가 PNG·JSON을 함께 이름 바꾼 포즈도 키포인트를 유지)
        if not isinstance(meta, dict) or meta.get("source") not in META_SOURCES:
            meta = None
    if meta is None:
        meta = _synth_meta(name, p)
    meta = _sanitize_meta(meta, name, p)
    meta["name"] = name
    try:
        st = p.stat()
        meta["size"] = st.st_size
        meta["mtime"] = st.st_mtime
    except OSError:
        meta["size"], meta["mtime"] = None, None
    meta["has_thick"] = (POSE_DIR / (stem_of(name) + ".thick.png")).is_file()
    meta["has_src"] = (POSE_DIR / (stem_of(name) + ".src.jpg")).is_file()
    return meta


def list_poses():
    """포즈 목록 [meta + {name, size, mtime, has_thick, has_src}] (최신순, 키포인트 포함)"""
    try:
        entries = list(os.scandir(POSE_DIR))
    except FileNotFoundError:
        return []
    except OSError as e:
        raise PoseError(f"포즈 폴더를 읽을 수 없습니다: {e.strerror or e}") from None
    out = []
    for e in entries:
        if not valid_name(e.name):
            continue
        try:
            if not e.is_file() or e.is_symlink():
                continue
        except OSError:
            continue
        out.append(_meta_for(e.name))
    out.sort(key=lambda m: (-(float(m.get("created") or 0)), m["name"]))
    return out


def load_meta(name):
    n = normalize_name(name)
    if not pose_path(n).is_file():
        raise PoseError(f"포즈 파일을 찾을 수 없습니다: {n}", "not_found")
    return _meta_for(n)


def exists(name):
    try:
        return pose_path(name).is_file()
    except PoseError:
        return False


def delete_pose(name):
    """포즈(맵·thick·json·src)를 user/trash/poses/ 로 옮긴다 → 옮긴 파일 이름 목록"""
    n = normalize_name(name)
    if not pose_path(n).is_file():
        raise PoseError(f"포즈 파일을 찾을 수 없습니다: {n}", "not_found")
    TRASH_DIR.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    moved = []
    # .png를 먼저 옮겨 목록에서 바로 사라지게
    for variant in ("standard", "thick", "json", "src"):
        p = pose_path(n, variant)
        if not p.is_file():
            continue
        dest = TRASH_DIR / p.name
        if dest.exists():
            dest = TRASH_DIR / f"{p.name}.{stamp}"
        try:
            os.replace(p, dest)
        except OSError:
            import shutil
            try:
                shutil.move(str(p), str(dest))
            except OSError as e:
                raise PoseError(f"포즈 파일을 휴지통으로 옮기지 못했습니다: {e.strerror or e}") from None
        moved.append(p.name)
    return moved
