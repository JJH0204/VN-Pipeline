"""작업 명세(JobSpec) → ComfyUI API 그래프 변환.

JobSpec (dict):
  mode        "prompt" | "concept" | "sprite" | "cg" | "bg" | "pixel" | "icon"
  prompt      자유 프롬프트 / cg 장면 / bg 배경 설명 / pixel 대상 설명 / icon 한 줄에 아이콘 하나
              (icon: "파일이름: 설명" 형식이면 앞부분을 파일 이름으로) (concept·sprite에서는 추가 태그)
  negative    추가 네거티브
  character   캐릭터 ID (concept/sprite/cg 필수, prompt는 선택)
  character_data  캐릭터 dict를 직접 넘길 때 (ID 대신)
  preset      모델 프리셋 이름 (없으면 캐릭터 model → settings.default_preset)
  loras       추가 LoRA [{"name", "weight"}]
  size        "portrait" 등 프리셋 이름 또는 [w, h] / {"width", "height"}
  count       장수
  seed        시드 (여러 장이면 +1씩), None이면 랜덤
  hires, face, hands   품질 단계 on/off (기본 True)
  upscale     스프라이트 2배 업스케일
  raw         True면 품질 태그/기본 네거티브 자동 추가 안 함 (prompt 모드)
  name        bg·pixel 파일 이름 / icon 세트(폴더) 이름
  pixel       pixel 모드 옵션 {"subject": "character"|"object"|"scene", "width": 도트 크기(16~512 — 투명이면 대상에 맞춰
              자른 뒤 긴 변, 불투명(배경)이면 가로),
              "colors": 팔레트 색 수(2~256), "dither": "none"|"bayer-2"|"bayer-4"|"floyd-steinberg",
              "transparent": bool(scene은 무시)} — 빈 값은 PIXEL_DEFAULTS
  sheet       sheet(스프라이트 시트) 옵션 {"motions": ["walk", …], "directions": ["down", "left", "right", "up"],
              "frames": 4|6, "mirror": bool(왼쪽 = 오른쪽 좌우 반전, 기본 True), "transparent": bool(기본 True),
              "pixel": {"width": 칸 가로 픽셀, "colors": 색 수} | None} — 캐릭터(character) 또는 prompt(외형) 필요.
              줄 = 동작 × 방향(위 순서), 칸 = 프레임. 같은 줄의 프레임은 한 장으로 함께 그린다(일관성).
  icon        icon 모드 옵션 {"style": "game"|"flat"|"glossy"|"pixel", "transparent": bool(glossy는 무시: 타일 바깥만 투명),
              "tile": "auto"|ICON_TILES 색 이름 (glossy 타일 색, auto = 아이콘마다 돌아가며),
              "sizes": [256, 128, 64] (원본 1024 외에 추가로 저장할 크기, 16~512)} — 빈 값은 ICON_DEFAULTS
  expressions 스프라이트에서 만들 표정 이름 목록 (None이면 전부)
  pose        포즈 따라 그리기 (ControlNet OpenPose): {"name": "pose_….png", "strength"?, "end"?, "model"?}
              (이름 문자열만 줘도 됨. 빈 값은 settings의 pose_strength/pose_end/pose_model — 모델만 바꾸면 그 모델 권장 강도)
              1차 생성(KSampler)에만 적용, 하이레즈·얼굴/손 보정·표정은 원래 conditioning. bg 모드는 무시.
              size가 비어 있으면 포즈 크기로 생성, 다르면 포즈 맵을 가운데 기준으로 잘라 맞춤.

build(job) → {"graph", "titles", "seeds", "preset", "summary", "prefixes", "pose"}
  pose: 실제 적용한 값 {"name", "image", "model", "strength", "end", "size": [w, h](맵), "gen_size": [w, h]} | None
"""
import random
import re
import time

from . import characters as chars
from . import modelinfo
from . import pose as poselib
from . import spritesheet as sheetlib
from .config import SIZES, find_model, load_presets, load_settings, normalize_loras

MODES = ("prompt", "concept", "sprite", "cg", "bg", "pixel", "icon", "sheet")
NO_PEOPLE_MODES = ("bg", "pixel", "icon", "sheet")  # 포즈 지정·얼굴/손 보정을 쓰지 않는 모드 (sheet는 자체 포즈 맵)  # 포즈·얼굴/손 보정을 쓰지 않는 모드

# ---- 도트(픽셀 아트)
DITHERS = ("none", "bayer-2", "bayer-4", "floyd-steinberg")
PIXEL_SUBJECTS = {
    # 생성 크기 기본값, 추가 태그, 추가 네거티브, 투명 배경 기본값
    "character": ("portrait", "full body, standing, chibi, simple background, white background, centered",
                  "multiple views, cropped", True),
    "object": ("square", "no humans, game item, single object, centered, simple background, white background",
               "multiple objects, cropped", True),
    "scene": ("wide", "no humans, scenery, pixel art background, game background", "1girl, 1boy, person", False),
}
PIXEL_POS = "pixel art, retro game, sprite, limited palette, clean pixels, flat color, sharp edges"
PIXEL_NEG = "blurry, gradient, soft shading, anti-aliasing, 3d, realistic, photo, jpeg artifacts, text, watermark, signature"
PIXEL_DEFAULTS = {"subject": "object", "width": 128, "colors": 32, "dither": "none", "transparent": True}
PIXEL_WIDTH = (16, 512)
PIXEL_COLORS = (2, 256)

# ---- 아이콘
ICON_STYLES = {
    # 추가 태그, 추가 네거티브, 투명 배경 기본값
    "game": ("game icon, item icon, rpg item, single object, centered, simple background, white background, "
             "no humans, detailed, vibrant colors, clean outline", "multiple objects, cropped, frame, border", True),
    "flat": ("flat design, vector art, minimalist icon, simple shapes, solid colors, single object, centered, "
             "simple background, white background, no humans, thick outlines",
             "realistic, 3d, gradient, shading, detailed background, multiple objects, cropped", True),
    # 앱 아이콘: 모델은 가운데 심볼만 그리고, 둥근 사각형 타일(그라데이션·광택)은 코드로 그려 합성한다 (icon_tile).
    # 애니 모델은 "rounded square app icon"을 안정적으로 못 그린다 (실측: 사진 같은 봉투, 모서리 테두리 잡음)
    # ("emoji"를 넣으면 모든 심볼에 웃는 얼굴을 그려 넣는다 — 실측)
    # "3d icon"이라고 쓰면 기호(음표 등) 밑에 둥근 사각형 아이콘 받침을 또 그린다 (실측) → "icon"이라는 말을 쓰지 않음
    "glossy": ("3d render, glossy, simple object, single object, centered, simple background, white background, "
               "no humans, soft lighting, vibrant colors, clean render, smooth shading",
               "multiple objects, cropped, frame, border, photo, realistic, scenery, background, "
               "face, eyes, mouth, smiley, emoji, character, pedestal, base, platform, box, stand", True),
    "pixel": ("pixel art, game item icon, single object, centered, simple background, white background, "
              "no humans, limited palette, clean pixels", "blurry, gradient, anti-aliasing, 3d, multiple objects", True),
}
ICON_NEG = "text, letters, words, english text, japanese text, label, watermark, signature, logo, username, person, 1girl, 1boy, hands"
ICON_DEFAULTS = {"style": "game", "transparent": None, "sizes": [256, 128, 64]}  # transparent None = 스타일 기본값
ICON_SIZE = (16, 512)
ICON_PIXEL = {"width": 64, "colors": 24}  # pixel 스타일 아이콘의 도트 크기·색 수
ICON_MAX = 32  # 한 번에 만들 아이콘 줄 수
ICON_TILES = {  # 앱 아이콘 타일 색: (위, 아래) 그라데이션. "auto"면 아이콘마다 이 순서로 돌아가며
    "blue": ("#5AC8FA", "#0A6CFF"), "green": ("#7DE38A", "#22A447"), "orange": ("#FFC46B", "#FF7A1A"),
    "purple": ("#C59CFF", "#7B3FE4"), "red": ("#FF8A80", "#E5243B"), "teal": ("#6EE7D8", "#0FA3A3"),
    "pink": ("#FFA3C8", "#F0478C"), "gray": ("#D7DCE3", "#8A94A6"),
}
TILE_SYMBOL = 0.64  # 심볼이 타일에서 차지하는 비율
TILE_RADIUS = 0.225  # 모서리 반지름 / 크기 (iOS 아이콘과 비슷)


def icon_tile(color, size=1024):
    """둥근 사각형 앱 타일(위→아래 그라데이션 + 위쪽 광택, 바깥 투명) PNG를 input/icon_tiles/에 (없으면) 그리고
    LoadImage 이름을 돌려준다. 4배로 그려 줄여서 모서리를 매끈하게."""
    name = f"{color}_{size}_v1.png"
    path = poselib.INPUT_DIR / "icon_tiles" / name
    if not path.is_file():
        from PIL import Image, ImageDraw
        top, bottom = ICON_TILES[color]
        S = size * 4
        grad = Image.linear_gradient("L").resize((S, S))  # 위 0 → 아래 255
        tile = Image.composite(Image.new("RGB", (S, S), bottom), Image.new("RGB", (S, S), top), grad)
        gloss = Image.new("L", (S, S), 0)
        ImageDraw.Draw(gloss).ellipse((-S * 0.25, -S * 0.62, S * 1.25, S * 0.42), fill=56)
        tile = Image.composite(Image.new("RGB", (S, S), "white"), tile, gloss)
        alpha = Image.new("L", (S, S), 0)
        ImageDraw.Draw(alpha).rounded_rectangle((0, 0, S - 1, S - 1), radius=int(S * TILE_RADIUS), fill=255)
        tile.putalpha(alpha)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp.png")
        tile.resize((size, size), Image.Resampling.LANCZOS).save(tmp)
        tmp.replace(path)
    return f"icon_tiles/{name}"
POSE_STRENGTH = (0.1, 2.0)
POSE_END = (0.1, 1.0)


class JobError(ValueError):
    pass


def rseed():
    return random.randint(0, 2**32 - 1)


def join(*parts):
    return ", ".join(p.strip(" ,\n") for p in parts if p and p.strip(" ,\n"))


def safe_name(s, default="img"):
    s = re.sub(r"[^0-9A-Za-z가-힣_-]+", "_", s or "").strip("_")
    return s[:40] or default


class Graph:
    def __init__(self):
        self.nodes, self.n = {}, 0

    def add(self, cls, _title=None, **inputs):
        self.n += 1
        nid = str(self.n)
        node = {"class_type": cls, "inputs": inputs}
        if _title:
            node["_meta"] = {"title": _title}
        self.nodes[nid] = node
        return nid

    @staticmethod
    def out(nid, idx=0):
        return [nid, idx]

    def titles(self):
        return {k: v.get("_meta", {}).get("title", v["class_type"]) for k, v in self.nodes.items()}


class Ctx:
    """모델/CLIP/VAE와 디텍터·업스케일러를 한 번만 로드해서 재사용"""

    def __init__(self, g, preset_name, preset, extra_loras, settings):
        self.g, self.name, self.p, self.s = g, preset_name, preset, settings
        ck = g.add("CheckpointLoaderSimple", "모델 로드", ckpt_name=preset["ckpt"])
        m, clip = g.out(ck, 0), g.out(ck, 1)
        merged = {}  # 같은 LoRA가 프리셋·캐릭터·작업에 중복되면 한 번만 (나중 것의 강도 우선)
        for lo in normalize_loras(preset.get("loras")) + normalize_loras(extra_loras):
            merged[lo["name"]] = lo
        for lo in merged.values():
            n = g.add("LoraLoader", f"LoRA {lo['name']}", model=m, clip=clip, lora_name=lo["name"],
                      strength_model=lo["weight"], strength_clip=lo["weight"])
            m, clip = g.out(n, 0), g.out(n, 1)
        if preset.get("vpred"):  # v-prediction 모델 필수 설정
            m = g.out(g.add("ModelSamplingDiscrete", "v-pred 설정", model=m, sampling="v_prediction", zsnr=True))
            m = g.out(g.add("RescaleCFG", "RescaleCFG", model=m, multiplier=0.7))
        self.model, self.clip, self.vae = m, clip, g.out(ck, 2)
        self._cache = {}
        self.pose = None  # resolve_pose() 결과 — 있으면 1차 생성에만 ControlNet 적용

    def pos(self, *parts):
        return join(*parts, self.p.get("quality", ""))

    def neg(self, *parts):
        return join(self.p.get("negative", ""), *parts)

    def _once(self, key, fn):
        if key not in self._cache:
            self._cache[key] = fn()
        return self._cache[key]

    def encode(self, text, title="프롬프트"):
        return self.g.out(self.g.add("CLIPTextEncode", title, clip=self.clip, text=text))

    def detector(self, name):
        return self._once(name, lambda: self.g.out(
            self.g.add("UltralyticsDetectorProvider", "디텍터", model_name=f"bbox/{name}"), 0))

    def upscale_model(self):
        return self._once("um", lambda: self.g.out(
            self.g.add("UpscaleModelLoader", "업스케일러 로드", model_name=self.s["upscaler"])))

    def bg_model(self):
        return self._once("bgm", lambda: self.g.out(
            self.g.add("LoadBackgroundRemovalModel", "배경제거 모델", bg_removal_name="birefnet.safetensors")))

    def pose_image(self, w, h):
        """포즈 맵 이미지 (LoadImage 한 번). 생성 크기와 다르면 가운데 기준으로 잘라 맞춤 (크기별 한 번)"""
        g, ps = self.g, self.pose
        img = self._once("pose_img", lambda: g.out(g.add("LoadImage", "포즈 불러오기", image=ps["image"]), 0))
        if tuple(ps["size"]) == (w, h):
            return img
        return self._once(("pose_fit", w, h), lambda: g.out(g.add(
            "ImageScale", "포즈 크기 맞춤", image=img, upscale_method="lanczos", width=w, height=h, crop="center")))

    def apply_pose(self, p, n, w, h):
        """positive/negative에 ControlNet(포즈) 적용 → (positive, negative). 포즈가 없으면 그대로."""
        if not self.pose:
            return p, n
        g, ps = self.g, self.pose
        cn = self._once("cn", lambda: g.out(g.add("ControlNetLoader", "ControlNet 로드", control_net_name=ps["model"])))
        node = g.add("ControlNetApplyAdvanced", "포즈 적용", positive=p, negative=n, control_net=cn,
                     image=self.pose_image(w, h), strength=float(ps["strength"]), start_percent=0.0,
                     end_percent=float(ps["end"]), vae=self.vae)
        return g.out(node, 0), g.out(node, 1)

    def sample(self, latent, p, n, seed, steps, denoise, sampler=None, title="생성"):
        return self.g.out(self.g.add(
            "KSampler", title, model=self.model, positive=p, negative=n, latent_image=latent, seed=seed,
            steps=steps, cfg=float(self.p["cfg"]), sampler_name=sampler or self.p["sampler"],
            scheduler=self.p.get("scheduler", "normal"), denoise=denoise))

    def hires_size(self, w, h):
        """하이레즈 후 크기 (8의 배수)"""
        sc = float(self.s["hires_scale"])
        return int(w * sc) // 8 * 8, int(h * sc) // 8 * 8

    def render(self, pos, neg, w, h, seed, job, tag=""):
        """1차 생성 → (하이레즈) → (얼굴/손 보정). 반환: image, positive, negative (포즈 없는 원래 conditioning)

        포즈(ControlNet)는 1차 생성에만 — 하이레즈 리파인·보정은 이미 자세가 잡힌 그림을 다듬는 단계라
        포즈가 필요 없고 느려지기만 한다."""
        g, s = self.g, self.s
        p, n = self.encode(pos, "긍정 프롬프트"), self.encode(neg, "부정 프롬프트")
        lat = g.out(g.add("EmptyLatentImage", "빈 캔버스", width=w, height=h, batch_size=1))
        bp, bn = self.apply_pose(p, n, w, h)
        latent = self.sample(lat, bp, bn, seed, int(self.p["steps"]), 1.0, title=f"1차 생성{tag}")
        img = g.out(g.add("VAEDecode", "디코드", samples=latent, vae=self.vae))
        if job.get("hires", True):
            # 애니 업스케일러로 픽셀 확대 → 2차 리파인: 눈/옷 주름/라인 정리, 팔다리·손 오류도 상당수 교정
            up = g.out(g.add("ImageUpscaleWithModel", "업스케일", upscale_model=self.upscale_model(), image=img))
            W, H = self.hires_size(w, h)
            img2 = g.out(g.add("ImageScale", "리사이즈", image=up, upscale_method="lanczos", width=W, height=H, crop="disabled"))
            enc = g.out(g.add("VAEEncode", "인코드", pixels=img2, vae=self.vae))
            latent = self.sample(enc, p, n, seed, int(s["hires_steps"]), float(s["hires_denoise"]),
                                 sampler="euler", title=f"하이레즈 리파인{tag}")
            img = g.out(g.add("VAEDecode", "디코드", samples=latent, vae=self.vae))
        if job.get("face", True):
            img = self.detail(img, p, n, seed, "face_yolov8m.pt", float(s["face_denoise"]), title=f"얼굴 보정{tag}")
        if job.get("hands", True):
            img = self.detail(img, p, n, seed, "hand_yolov8s.pt", float(s["hand_denoise"]), title=f"손 보정{tag}")
        return img, p, n

    def detail(self, image, pos, neg, seed, det, denoise, guide=512, force=False, title="디테일 보정"):
        """감지된 영역(얼굴/손)을 확대해서 다시 그림.
        force=False: 이미 guide 크기보다 크게 그려진 영역은 건너뜀(상반신 얼굴 등 → 시간 절약)
        force=True : 크기와 상관없이 다시 그림(표정 차분용)"""
        fd = self.g.add(
            "FaceDetailer", title, image=image, model=self.model, clip=self.clip, vae=self.vae,
            positive=pos, negative=neg, guide_size=guide, guide_size_for=True, max_size=1024,
            seed=seed, steps=int(self.s["detail_steps"]), cfg=float(self.p["cfg"]), sampler_name="euler",
            scheduler="normal", denoise=denoise, feather=5, noise_mask=True, force_inpaint=force,
            bbox_threshold=0.5, bbox_dilation=10, bbox_crop_factor=3.0, sam_detection_hint="center-1",
            sam_dilation=0, sam_threshold=0.93, sam_bbox_expansion=0, sam_mask_hint_threshold=0.7,
            sam_mask_hint_use_negative="False", drop_size=10, bbox_detector=self.detector(det),
            wildcard="", cycle=1)
        return self.g.out(fd, 0)

    def cut_out(self, image):
        """BiRefNet으로 배경 제거 → RGBA"""
        g = self.g
        m = g.add("RemoveBackground", "배경 제거", bg_removal_model=self.bg_model(), image=image)
        inv = g.add("InvertMask", "마스크 반전", mask=g.out(m))  # JoinImageWithAlpha는 반전 마스크를 받음
        return g.out(g.add("JoinImageWithAlpha", "투명 합성", image=image, alpha=g.out(inv)))

    def fg_mask(self, image):
        """BiRefNet 전경 마스크 (전경=1)"""
        return self.g.out(self.g.add("RemoveBackground", "배경 감지", bg_removal_model=self.bg_model(), image=image))

    def pixelize(self, image, tw, th, colors, dither, transparent, fit=0):
        """도트화: 면적 평균으로 실제 픽셀 크기까지 줄이기 → 팔레트 양자화 → (투명) 1비트 알파.
        ImageQuantize는 RGB만 받으므로 알파는 마스크를 따로 줄여 임계값으로 자른 뒤 마지막에 합친다.
        fit>0 (투명일 때만): 인물·사물 테두리에 맞춰 잘라 낸 뒤 긴 변을 fit 픽셀로 — 빈 여백에 픽셀을 낭비하지 않는다
        (그림 속 대상이 작게 그려져도 결과 도트 크기가 일정). 크기는 실행 때 정해지므로 tw, th는 쓰지 않음."""
        g = self.g
        if transparent and fit:
            mask = self.fg_mask(image)
            rgba = g.out(g.add("JoinImageWithAlpha", "투명 합성", image=image,
                               alpha=g.out(g.add("InvertMask", "마스크 반전", mask=mask))))
            hard = g.out(g.add("ThresholdMask", "영역용 마스크", mask=mask, value=0.5))  # 0이 아닌 픽셀 전부가 영역이 됨
            segs = g.out(g.add("MaskToSEGS", "대상 영역", mask=hard, combined=True, crop_factor=1.04,
                               bbox_fill=False, drop_size=10, contour_fill=False))
            crop = g.out(g.add("SEGSToImageList", "대상에 맞춰 자르기", segs=segs, fallback_image_opt=rgba))
            small = g.out(g.add("ImageScaleToMaxDimension", "도트 크기로 축소", image=crop, upscale_method="area",
                                largest_size=int(fit)))
            sp = g.add("SplitImageWithAlpha", "알파 분리", image=small)
            img = g.out(g.add("ImageQuantize", f"팔레트 {colors}색", image=g.out(sp, 0), colors=int(colors), dither=dither))
            m = g.out(g.add("ThresholdMask", "알파 1비트", mask=g.out(sp, 1), value=0.5))  # 1 = 투명 쪽
            return g.out(g.add("JoinImageWithAlpha", "투명 합성", image=img, alpha=m))
        small = g.out(g.add("ImageScale", "도트 크기로 축소", image=image, upscale_method="area",
                            width=tw, height=th, crop="disabled"))
        img = g.out(g.add("ImageQuantize", f"팔레트 {colors}색", image=small, colors=int(colors), dither=dither))
        if not transparent:
            return img
        m = g.out(g.add("MaskToImage", "마스크→이미지", mask=self.fg_mask(image)))
        m = g.out(g.add("ImageScale", "마스크 축소", image=m, upscale_method="area", width=tw, height=th, crop="disabled"))
        m = g.out(g.add("ImageToMask", "이미지→마스크", image=m, channel="red"))
        m = g.out(g.add("ThresholdMask", "알파 1비트", mask=m, value=0.5))
        inv = g.out(g.add("InvertMask", "마스크 반전", mask=m))
        return g.out(g.add("JoinImageWithAlpha", "투명 합성", image=img, alpha=inv))

    def resize(self, image, w, h, title="크기 조정"):
        return self.g.out(self.g.add("ImageScale", title, image=image, upscale_method="area",
                                     width=w, height=h, crop="disabled"))

    def save(self, image, prefix):
        self.g.add("SaveImage", "저장", images=image, filename_prefix=prefix)


# ---------- 헬퍼 ----------
def resolve_size(size, default):
    if size is None or size == "":
        size = default
    if isinstance(size, str):
        if size not in SIZES:
            raise JobError(f"알 수 없는 크기 프리셋: {size} (가능: {', '.join(SIZES)})")
        return SIZES[size]
    if isinstance(size, dict):
        w, h = size.get("width"), size.get("height")
    else:
        w, h = size
    w, h = int(w) // 8 * 8, int(h) // 8 * 8
    if not (512 <= w <= 2048 and 512 <= h <= 2048):
        raise JobError("가로/세로는 512~2048 사이여야 합니다")
    return w, h


def _num(v, label, lo, hi):
    try:
        if isinstance(v, bool):
            raise ValueError
        x = float(v)
    except (TypeError, ValueError):
        raise JobError(f"{label} 값은 숫자여야 합니다") from None
    if not (lo <= x <= hi):  # NaN도 여기서 걸러짐
        raise JobError(f"{label} 값은 {lo}~{hi} 사이여야 합니다 (입력값: {v})")
    return x


def resolve_pose(job, settings, preset_name=None, preset=None):
    """JobSpec의 pose → {"name", "image"(LoadImage 입력), "model", "strength", "end", "size": (w, h)} | None"""
    spec = job.get("pose")
    if spec in (None, "", {}):
        return None
    if isinstance(spec, str):
        spec = {"name": spec}
    if not isinstance(spec, dict):
        raise JobError("포즈 설정 형식이 올바르지 않습니다")
    try:
        name = poselib.normalize_name(spec.get("name"))
        path = poselib.pose_path(name)
    except poselib.PoseError as e:
        raise JobError(str(e)) from None
    if not path.is_file():
        raise JobError(f"포즈 파일을 찾을 수 없습니다: {name} (포즈 라이브러리에서 삭제되었을 수 있습니다)")
    model = spec.get("model") or settings.get("pose_model") or poselib.DEFAULT_CONTROLNET
    if not isinstance(model, str) or len(model) > 200:
        raise JobError("ControlNet 파일 이름이 올바르지 않습니다")
    if spec.get("strength") in (None, ""):  # 기본 모델이면 설정값, 다른 모델이면 그 모델의 권장 강도
        strength = settings.get("pose_strength", 1.0) if model == settings.get("pose_model") \
            else poselib.recommended_strength(model)
    else:
        strength = spec["strength"]
    end = settings.get("pose_end", 1.0) if spec.get("end") in (None, "") else spec["end"]
    strength = _num(strength, "포즈 강도", *POSE_STRENGTH)
    end = _num(end, "포즈 적용 구간(끝)", *POSE_END)
    if preset is not None:  # ControlNet OpenPose(SDXL)는 SDXL 계열 체크포인트에서만
        ck = find_model("checkpoints", preset.get("ckpt") or "")
        arch = modelinfo.checkpoint_info(ck).get("arch") if ck else None
        if arch not in (None, "SDXL", "unknown"):
            raise JobError(f"포즈(ControlNet OpenPose)는 SDXL 계열 모델에서만 쓸 수 있습니다. "
                           f"프리셋 '{preset_name}'의 체크포인트({preset.get('ckpt')})는 {arch}입니다.")
    image = poselib.variant_for(name, model)
    try:
        size = poselib.png_size(poselib.INPUT_DIR / image)
    except (OSError, poselib.PoseError) as e:
        raise JobError(f"포즈 파일을 읽을 수 없습니다: {name} ({e})") from None
    return {"name": name, "image": image, "model": model, "strength": round(strength, 3), "end": round(end, 3),
            "size": tuple(size)}


def _choice(v, allowed, label, default):
    if v in (None, ""):
        return default
    if v not in allowed:
        raise JobError(f"{label} 값이 올바르지 않습니다: {v!r} (가능: {', '.join(allowed)})")
    return v


def _bool(v, default):
    return default if v is None else bool(v)


def resolve_pixel(job):
    """JobSpec.pixel → {"subject", "width", "colors", "dither", "transparent"} (빈 값은 기본값)"""
    o = job.get("pixel") or {}
    if not isinstance(o, dict):
        raise JobError("도트 설정 형식이 올바르지 않습니다")
    subject = _choice(o.get("subject"), tuple(PIXEL_SUBJECTS), "도트 대상", PIXEL_DEFAULTS["subject"])
    width = o.get("width")
    width = PIXEL_DEFAULTS["width"] if width in (None, "") else int(_num(width, "도트 가로 픽셀", *PIXEL_WIDTH))
    colors = o.get("colors")
    colors = PIXEL_DEFAULTS["colors"] if colors in (None, "") else int(_num(colors, "팔레트 색 수", *PIXEL_COLORS))
    dither = _choice(o.get("dither"), DITHERS, "디더링", PIXEL_DEFAULTS["dither"])
    transparent = subject != "scene" and _bool(o.get("transparent"), PIXEL_SUBJECTS[subject][3])
    return {"subject": subject, "width": width, "colors": colors, "dither": dither, "transparent": transparent}


def pixel_size(w, h, px_w):
    """생성 크기 (w, h)를 가로 px_w 픽셀로 줄인 도트 크기 (비율 유지, 최소 1)"""
    px_w = min(px_w, w)
    return px_w, max(1, round(h * px_w / w))


def resolve_icon(job):
    """JobSpec.icon → {"style", "transparent", "sizes"}"""
    o = job.get("icon") or {}
    if not isinstance(o, dict):
        raise JobError("아이콘 설정 형식이 올바르지 않습니다")
    style = _choice(o.get("style"), tuple(ICON_STYLES), "아이콘 스타일", ICON_DEFAULTS["style"])
    transparent = _bool(o.get("transparent"), ICON_STYLES[style][2])
    sizes = o.get("sizes")
    if sizes is None:
        sizes = ICON_DEFAULTS["sizes"]
    if not isinstance(sizes, (list, tuple)) or len(sizes) > 8:
        raise JobError("아이콘 크기 목록은 최대 8개의 숫자여야 합니다")
    sizes = sorted({int(_num(x, "아이콘 크기", *ICON_SIZE)) for x in sizes}, reverse=True)
    tile = _choice(o.get("tile"), ("auto",) + tuple(ICON_TILES), "타일 색", "auto")
    return {"style": style, "transparent": transparent, "sizes": sizes, "tile": tile}


SHEET_TAGS = "same character, full body, simple background, white background"
SHEET_NEG = ("text, grid, frame, border, panel, cropped, out of frame, watermark, signature, "
             "extra person, crowd, overlapping, giant, multiple views, character sheet")
SHEET_MAX_ROWS = 28


def resolve_sheet(job):
    o = job.get("sheet") or {}
    if not isinstance(o, dict):
        raise JobError("스프라이트 시트 설정 형식이 올바르지 않습니다")
    motions = o.get("motions") or ["walk"]
    dirs = o.get("directions") or list(sheetlib.DIR_ORDER)
    if not isinstance(motions, list) or not isinstance(dirs, list):
        raise JobError("동작·방향 목록 형식이 올바르지 않습니다")
    for m in motions:
        if m not in sheetlib.MOTIONS:
            raise JobError(f"알 수 없는 동작입니다: {m!r} (가능: {', '.join(sheetlib.MOTION_ORDER)})")
    for d in dirs:
        if d not in sheetlib.DIRECTIONS:
            raise JobError(f"알 수 없는 방향입니다: {d!r} (가능: {', '.join(sheetlib.DIR_ORDER)})")
    motions = [m for m in sheetlib.MOTION_ORDER if m in motions]   # 줄 순서 고정 (중복 제거)
    dirs = [d for d in sheetlib.DIR_ORDER if d in dirs]
    frames = o.get("frames") or 4
    if frames not in sheetlib.FRAMES:
        raise JobError(f"프레임 수는 {', '.join(map(str, sheetlib.FRAMES))} 중 하나여야 합니다")
    if len(motions) * len(dirs) > SHEET_MAX_ROWS:
        raise JobError(f"한 시트는 {SHEET_MAX_ROWS}줄(동작 × 방향)까지입니다")
    px = o.get("pixel")
    if px:
        if not isinstance(px, dict):
            raise JobError("도트 설정 형식이 올바르지 않습니다")
        px = {"width": int(_num(px.get("width") or 64, "칸 가로 픽셀", 16, 256)),
              "colors": int(_num(px.get("colors") or 32, "팔레트 색 수", *PIXEL_COLORS))}
    return {"motions": motions, "directions": dirs, "frames": frames, "mirror": _bool(o.get("mirror"), True),
            "transparent": _bool(o.get("transparent"), True), "pixel": px or None}


def icon_lines(text):
    """아이콘 목록 텍스트 → [(파일 이름, 설명)]. "이름: 설명"이면 앞부분이 이름, 아니면 설명에서 만든다.
    같은 이름이 겹치면 _2, _3을 붙인다."""
    out, seen = [], {}
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        name, sep, desc = line.partition(":")
        if not sep or not desc.strip() or len(name) > 40 or "," in name:
            name, desc = line, line
        base = safe_name(name.strip(), "icon")
        seen[base] = seen.get(base, 0) + 1
        out.append((base if seen[base] == 1 else f"{base}_{seen[base]}", desc.strip()))
    return out


def icon_on_tile(ctx, image, color, size):
    """심볼 그림 → 배경 지우고 심볼 테두리에 맞춰 잘라 긴 변을 TILE_SYMBOL 크기로 (모델이 크게·작게 그려도 세트가 고르게)
    → 타일 가운데에 합성 → 타일 모양 알파(둥근 모서리 바깥 투명)"""
    g = ctx.g
    tl = ctx._once(("tile", color, size), lambda: g.add("LoadImage", f"타일 {color}", image=icon_tile(color, size)))
    sw = int(size * TILE_SYMBOL) // 8 * 8
    mask = ctx.fg_mask(image)
    hard = g.out(g.add("ThresholdMask", "영역용 마스크", mask=mask, value=0.5))  # Impact는 0이 아닌 픽셀 전부를 영역으로 봄
    segs = g.out(g.add("MaskToSEGS", "심볼 영역", mask=hard, combined=True, crop_factor=1.02,
                       bbox_fill=False, drop_size=10, contour_fill=False))

    def fit(img, pad, title):  # 같은 영역으로 잘라 sw×sw 가운데에 (그림과 마스크를 똑같이)
        crop = g.out(g.add("SEGSToImageList", f"{title} 자르기", segs=segs, fallback_image_opt=img))
        return g.out(g.add("ResizeAndPadImage", f"{title} 크기", image=crop, target_width=sw, target_height=sw,
                           padding_color=pad, interpolation="area"))

    sym = fit(image, "white", "심볼")
    m = fit(g.out(g.add("MaskToImage", "마스크→이미지", mask=mask)), "black", "마스크")
    m = g.out(g.add("ImageToMask", "이미지→마스크", image=m, channel="red"))
    off = (size - sw) // 2
    comp = g.out(g.add("ImageCompositeMasked", "타일에 합성", destination=g.out(tl, 0), source=sym,
                       x=off, y=off, resize_source=False, mask=m))
    return g.out(g.add("JoinImageWithAlpha", "타일 모양 알파", image=comp, alpha=g.out(tl, 1)))  # LoadImage 마스크 = 1 - 알파


def char_pos(ctx, c, extra=""):
    return ctx.pos(c.get("count", "1girl, solo"), c["appearance"], c.get("outfit", ""), extra, c.get("style", ""))


def char_neg(ctx, c, extra=""):
    return ctx.neg(c.get("negative", ""), extra)


def seeds_for(job, n, fallback=None):
    if job.get("seed") not in (None, ""):
        base = int(job["seed"])
        return [(base + i) % 2**32 for i in range(n)]
    if fallback is not None and n == 1:
        return [int(fallback)]
    return [rseed() for _ in range(n)]


def _character(job, required):
    if job.get("character_data"):
        return chars.normalize(job["character_data"])
    cid = job.get("character")
    if not cid:
        if required:
            raise JobError("이 모드는 캐릭터를 선택해야 합니다")
        return None
    return chars.load(cid)


# ---------- 메인 빌드 ----------
def build(job, presets=None, settings=None):
    presets = presets or load_presets()
    settings = settings or load_settings()
    mode = job.get("mode")
    if mode not in MODES:
        raise JobError(f"알 수 없는 모드: {mode}")
    count = max(1, min(int(job.get("count") or 1), 32))
    c = _character(job, required=mode in ("concept", "sprite", "cg"))

    preset_name = job.get("preset") or (c or {}).get("model") or settings["default_preset"]
    if preset_name not in presets:
        raise JobError(f"프리셋을 찾을 수 없음: {preset_name}")
    preset = presets[preset_name]
    extra_loras = normalize_loras((c or {}).get("loras")) + normalize_loras(job.get("loras"))

    pose_cfg = resolve_pose(job, settings, preset_name, preset) if mode not in NO_PEOPLE_MODES else None

    g = Graph()
    ctx = Ctx(g, preset_name, preset, extra_loras, settings)
    ctx.pose = pose_cfg
    text, extra_neg = (job.get("prompt") or "").strip(), (job.get("negative") or "").strip()
    day = time.strftime("%m%d")
    prefixes = []

    def save(img, prefix):
        prefixes.append(prefix)
        ctx.save(img, prefix)

    def size_for(default):
        """크기: 지정값 → (포즈가 있으면) 포즈 맵 크기 → 모드 기본값"""
        if pose_cfg and job.get("size") in (None, ""):
            return poselib.gen_size(*pose_cfg["size"])
        return resolve_size(job.get("size"), default)

    if mode == "prompt":
        if not text:
            raise JobError("프롬프트를 입력하세요")
        w, h = size_for("portrait")
        if c:
            pos, ng = char_pos(ctx, c, text), char_neg(ctx, c, extra_neg)
        elif job.get("raw"):
            pos, ng = text, extra_neg
        else:
            pos, ng = ctx.pos(text), ctx.neg(extra_neg)
        seeds = seeds_for(job, count)
        for i, s in enumerate(seeds):
            img, _, _ = ctx.render(pos, ng, w, h, s, job, tag=f" ({i + 1}/{count})" if count > 1 else "")
            save(img, f"prompt/{day}_{preset_name}_seed{s}")
        summary = text[:60]

    elif mode == "concept":
        w, h = size_for("portrait")
        pose = text or c.get("concept_pose", "upper body, looking at viewer, simple background")
        seeds = seeds_for(job, count, fallback=c.get("seed"))
        for i, s in enumerate(seeds):
            img, _, _ = ctx.render(char_pos(ctx, c, pose), char_neg(ctx, c, extra_neg), w, h, s, job,
                                   tag=f" ({i + 1}/{count})" if count > 1 else "")
            save(img, f"{c['id']}/concept/{c['id']}_{preset_name}_seed{s}")
        summary = f"{c.get('name') or c['id']} 시안 {count}장"

    elif mode == "sprite":
        w, h = size_for("portrait")
        seed = seeds_for(job, 1, fallback=c.get("seed"))[0]
        seeds = [seed]
        pose = c.get("sprite_pose", "full body, standing, looking at viewer, arms at sides, white background, simple background")
        if text:
            pose = join(pose, text)
        base, _, n = ctx.render(char_pos(ctx, c, pose), char_neg(ctx, c, extra_neg), w, h, seed, job, tag=" (기본 포즈)")
        bw, bh = ctx.hires_size(w, h) if job.get("hires", True) else (w, h)  # 기본 포즈 이미지의 실제 크기
        save(base, f"{c['id']}/sprite/{c['id']}_base")
        wanted = job.get("expressions")
        exprs = {k: v for k, v in c["expressions"].items() if not wanted or k in wanted}
        if not exprs:
            raise JobError("만들 표정이 없습니다")
        for name, e in exprs.items():
            p = ctx.encode(char_pos(ctx, c, f"{e['prompt']}, {pose}"), f"표정 프롬프트 {name}")
            face = ctx.detail(base, p, n, seed, "face_yolov8m.pt", float(e.get("denoise", settings["expr_denoise"])),
                              force=True, title=f"표정: {name}")
            if job.get("upscale"):
                # 업스케일 모델의 배율(2x/4x/8x)과 상관없이 결과를 정확히 2배 크기로 맞춘다
                u = g.out(g.add("ImageUpscaleWithModel", "업스케일", upscale_model=ctx.upscale_model(), image=face))
                face = g.out(g.add("ImageScale", "리사이즈", image=u, upscale_method="lanczos",
                                   width=bw * 2, height=bh * 2, crop="disabled"))
            save(ctx.cut_out(face), f"{c['id']}/sprite/{c['id']}_{safe_name(name, 'expr')}")
        summary = f"{c.get('name') or c['id']} 스프라이트 (표정 {len(exprs)}종)"

    elif mode == "cg":
        if not text:
            raise JobError("CG 장면 프롬프트를 입력하세요")
        w, h = size_for("wide")
        seeds = seeds_for(job, count)
        for i, s in enumerate(seeds):
            img, _, _ = ctx.render(char_pos(ctx, c, text), char_neg(ctx, c, extra_neg), w, h, s, job,
                                   tag=f" ({i + 1}/{count})" if count > 1 else "")
            save(img, f"{c['id']}/cg/{c['id']}_seed{s}")
        summary = f"{c.get('name') or c['id']} CG: {text[:40]}"

    elif mode == "pixel":
        if not text:
            raise JobError("만들 대상을 입력하세요. 예: red potion, glass bottle")
        px = resolve_pixel(job)
        sub_size, sub_pos, sub_neg, _ = PIXEL_SUBJECTS[px["subject"]]
        w, h = resolve_size(job.get("size"), sub_size)
        tw, th = pixel_size(w, h, px["width"])
        name = safe_name(job.get("name"), "pixel")
        # 도트로 줄이면 하이레즈·얼굴/손 보정의 디테일은 사라지므로 1차 생성만 한다
        fast = dict(job, hires=False, face=False, hands=False)
        pos = ctx.pos(PIXEL_POS, sub_pos, text)
        ng = ctx.neg(PIXEL_NEG, sub_neg, extra_neg)
        seeds = seeds_for(job, count)
        for i, s in enumerate(seeds):
            img, _, _ = ctx.render(pos, ng, w, h, s, fast, tag=f" ({i + 1}/{count})" if count > 1 else "")
            if px["transparent"]:  # 대상에 맞춰 자르고 긴 변 = 도트 크기
                out = ctx.pixelize(img, tw, th, px["colors"], px["dither"], True, fit=px["width"])
                save(out, f"pixel/{name}_{px['width']}px_seed{s}")
            else:
                out = ctx.pixelize(img, tw, th, px["colors"], px["dither"], False)
                save(out, f"pixel/{name}_{tw}x{th}_seed{s}")
        summary = (f"도트 긴 변 {px['width']}px: " if px["transparent"] else f"도트 {tw}×{th}: ") + text[:44]

    elif mode == "sheet":
        sh = resolve_sheet(job)
        if not c and not text:
            raise JobError("캐릭터를 고르거나 캐릭터 외형을 입력하세요")
        model = settings.get("pose_model") or poselib.DEFAULT_CONTROLNET
        if not find_model("controlnet", model):
            raise JobError(f"스프라이트 시트는 포즈 ControlNet이 필요합니다: {model} (도움말 › 포즈 따라 그리기)")
        ck = find_model("checkpoints", preset.get("ckpt") or "")
        arch = modelinfo.checkpoint_info(ck).get("arch") if ck else None
        if arch not in (None, "SDXL", "unknown"):
            raise JobError(f"스프라이트 시트(ControlNet OpenPose)는 SDXL 계열 모델에서만 쓸 수 있습니다 ({arch})")
        style = poselib.style_for(model)
        strength = float(settings.get("pose_strength", 1.0)) if model == settings.get("pose_model") \
            else poselib.recommended_strength(model)
        end = float(settings.get("pose_end", 1.0))
        frames = sh["frames"]
        cw, ch = sheetlib.cell_size(frames)
        hires = job.get("hires", False)
        sc = float(settings["hires_scale"]) if hires else 1.0
        cw2, ch2 = int(cw * sc) // 8 * 8, int(ch * sc) // 8 * 8   # 최종 칸 크기 (하이레즈면 확대)
        name = safe_name(job.get("name") or (c or {}).get("id"), "sheet")
        seed = seeds_for(job, 1, fallback=(c or {}).get("seed"))[0]
        seeds = [seed]
        cn = g.out(g.add("ControlNetLoader", "ControlNet 로드", control_net_name=model))
        ng = ctx.neg(SHEET_NEG, (c or {}).get("negative", ""), extra_neg)
        n_dir = {d: ctx.encode(join(ng, sheetlib.DIR_NEG[d]), f"부정 프롬프트 {sheetlib.DIRECTIONS[d][0]}")
                 for d in sheetlib.DIR_ORDER}
        mirror = sh["mirror"] and "left" in sh["directions"]
        need = list(sh["directions"])
        if mirror and "right" not in need:
            need.append("right")  # 왼쪽을 반전으로 만들 원본

        def draw(pose_name, W, H, p, n_enc, title):
            """포즈 맵 하나로 1차 생성 → 이미지"""
            pm = g.out(g.add("LoadImage", f"포즈 맵 {title}", image=pose_name), 0)
            ap = g.add("ControlNetApplyAdvanced", "포즈 적용", positive=p, negative=n_enc, control_net=cn, image=pm,
                       strength=strength, start_percent=0.0, end_percent=end, vae=ctx.vae)
            lat = g.out(g.add("EmptyLatentImage", "빈 캔버스", width=W, height=H, batch_size=1))
            latent = ctx.sample(lat, g.out(ap, 0), g.out(ap, 1), seed, int(preset["steps"]), 1.0, title=f"1차 생성 ({title})")
            return g.out(g.add("VAEDecode", "디코드", samples=latent, vae=ctx.vae))

        def gen_row(motion, d):
            mlabel, mtags, _ = sheetlib.MOTIONS[motion]
            tags = join(sheetlib.DIRECTIONS[d][1], SHEET_TAGS, mtags)
            pos = char_pos(ctx, c, join(tags, text)) if c else ctx.pos(text, tags)
            p = ctx.encode(pos, f"프롬프트 {mlabel}·{sheetlib.DIRECTIONS[d][0]}")
            n_enc = n_dir[d] if motion not in sheetlib.MOTION_NEG else ctx.encode(
                join(ng, sheetlib.DIR_NEG[d], sheetlib.MOTION_NEG[motion]), f"부정 프롬프트 {mlabel}")
            tag = f"{mlabel}·{sheetlib.DIRECTIONS[d][0]}"
            if sheetlib.separate(motion, d):
                # 프레임마다 한 장씩 (한 장에 한 사람) → 칸 크기로 줄여 잇기. 이미 칸의 2배로 그리므로 하이레즈 생략
                img = None
                for i in range(frames):
                    name_i, (W, H) = sheetlib.frame_map(motion, d, frames, i, style)
                    cell = ctx.resize(draw(name_i, W, H, p, n_enc, f"{tag} {i + 1}/{frames}"), cw2, ch2, "칸 크기로")
                    img = cell if img is None else g.out(g.add(
                        "ImageStitch", "칸 잇기", image1=img, direction="right", match_image_size=False,
                        spacing_width=0, spacing_color="white", image2=cell))
            else:
                img_name, (W, H) = sheetlib.row_map(motion, d, frames, style)
                img = draw(img_name, W, H, p, n_enc, tag)
                if hires:
                    up = g.out(g.add("ImageUpscaleWithModel", "업스케일", upscale_model=ctx.upscale_model(), image=img))
                    img2 = ctx.resize(up, cw2 * frames, ch2, "리사이즈")
                    enc = g.out(g.add("VAEEncode", "인코드", pixels=img2, vae=ctx.vae))
                    latent = ctx.sample(enc, p, n_enc, seed, int(settings["hires_steps"]), float(settings["hires_denoise"]),
                                        sampler="euler", title=f"하이레즈 리파인 ({tag})")
                    img = g.out(g.add("VAEDecode", "디코드", samples=latent, vae=ctx.vae))
            mask = g.out(g.add("MaskToImage", "마스크→이미지", mask=ctx.fg_mask(img))) if sh["transparent"] else None
            return img, mask

        def mirror_cells(image):
            """한 줄을 좌우 반전 → 프레임 순서가 거꾸로 되므로 칸을 잘라 원래 순서로 다시 잇는다"""
            fl = g.out(g.add("ImageFlip", "좌우 반전", image=image, flip_method="y-axis: horizontally"))
            out = None
            for i in range(frames):
                cell = g.out(g.add("ImageCrop", f"칸 {i + 1}", image=fl, width=cw2, height=ch2,
                                   x=(frames - 1 - i) * cw2, y=0))
                out = cell if out is None else g.out(g.add(
                    "ImageStitch", "칸 잇기", image1=out, direction="right", match_image_size=False,
                    spacing_width=0, spacing_color="white", image2=cell))
            return out

        def stack(acc, row):
            return row if acc is None else g.out(g.add(
                "ImageStitch", "줄 쌓기", image1=acc, direction="down", match_image_size=False,
                spacing_width=0, spacing_color="white", image2=row))

        rows_meta, sheet_img, sheet_mask = [], None, None
        for motion in sh["motions"]:
            made = {d: gen_row(motion, d) for d in need if not (mirror and d == "left")}
            if mirror:
                ri, rm = made["right"]
                made["left"] = (mirror_cells(ri), mirror_cells(rm) if rm is not None else None)
            for d in sh["directions"]:
                img, mask = made[d]
                sheet_img = stack(sheet_img, img)
                if mask is not None:
                    sheet_mask = stack(sheet_mask, mask)
                rows_meta.append(f"{motion}_{d}")
        n_rows = len(rows_meta)
        if sh["pixel"]:
            pw = min(sh["pixel"]["width"], cw2)
            ph = max(1, round(ch2 * pw / cw2))
            out = g.out(g.add("ImageScale", "도트 크기로 축소", image=sheet_img, upscale_method="area",
                              width=pw * frames, height=ph * n_rows, crop="disabled"))
            out = g.out(g.add("ImageQuantize", f"팔레트 {sh['pixel']['colors']}색", image=out,
                              colors=sh["pixel"]["colors"], dither="none"))
            if sheet_mask is not None:
                m = ctx.resize(sheet_mask, pw * frames, ph * n_rows, "마스크 축소")
                m = g.out(g.add("ImageToMask", "이미지→마스크", image=m, channel="red"))
                m = g.out(g.add("ThresholdMask", "알파 1비트", mask=m, value=0.5))
                inv = g.out(g.add("InvertMask", "마스크 반전", mask=m))
                out = g.out(g.add("JoinImageWithAlpha", "투명 합성", image=out, alpha=inv))
            cell_w, cell_h = pw, ph
        else:
            out = sheet_img
            if sheet_mask is not None:
                m = g.out(g.add("ImageToMask", "이미지→마스크", image=sheet_mask, channel="red"))
                inv = g.out(g.add("InvertMask", "마스크 반전", mask=m))
                out = g.out(g.add("JoinImageWithAlpha", "투명 합성", image=out, alpha=inv))
            cell_w, cell_h = cw2, ch2
        # 파일 이름에 칸 크기·열×줄을 넣어 게임 엔진에서 바로 잘라 쓸 수 있게 (줄 순서 = 동작 × 방향)
        save(out, f"sheets/{name}_{cell_w}x{cell_h}_{frames}x{n_rows}_seed{seed}")
        summary = (f"스프라이트 시트 {frames}×{n_rows} (칸 {cell_w}×{cell_h}): "
                   + ", ".join(sheetlib.MOTIONS[m][0] for m in sh["motions"]))

    elif mode == "icon":
        items = icon_lines(text)
        if not items:
            raise JobError("만들 아이콘을 한 줄에 하나씩 입력하세요. 예: sword / health potion / gold coin")
        if len(items) > ICON_MAX:
            raise JobError(f"아이콘은 한 번에 {ICON_MAX}개까지 만들 수 있습니다 (입력: {len(items)}개)")
        ic = resolve_icon(job)
        st_pos, st_neg, _ = ICON_STYLES[ic["style"]]
        w = h = 1024
        folder = safe_name(job.get("name"), "icons")
        icon_job = dict(job, face=False, hands=False)
        if ic["style"] in ("pixel", "glossy"):  # 도트는 줄이고, 앱 아이콘 심볼은 64%로 줄여 넣으므로 하이레즈가 의미 없음
            icon_job["hires"] = False
        per = max(1, min(count, 8))  # 아이콘마다 변형 장수
        # 세트 전체가 같은 시드 목록을 써서 구도·그림체를 맞춘다
        seeds = seeds_for(job, per)
        ng = ctx.neg(ICON_NEG, st_neg, extra_neg)
        for k, (iname, desc) in enumerate(items):
            pos = ctx.pos(st_pos, desc)
            for i, s in enumerate(seeds):
                tag = f" ({iname}" + (f" {i + 1}/{per}" if per > 1 else "") + ")"
                img, _, _ = ctx.render(pos, ng, w, h, s, icon_job, tag=tag)
                if ic["style"] == "pixel":
                    pw = ICON_PIXEL["width"]
                    img = ctx.pixelize(img, pw, pw, ICON_PIXEL["colors"], "none", ic["transparent"])
                    master = 0  # 도트는 줄이면 픽셀이 뭉개지므로 크기별 저장을 하지 않는다
                elif ic["style"] == "glossy":
                    color = ic["tile"] if ic["tile"] != "auto" else list(ICON_TILES)[k % len(ICON_TILES)]
                    img = icon_on_tile(ctx, img, color, w)
                    master = w
                else:
                    if ic["transparent"]:
                        img = ctx.cut_out(img)
                    master = ctx.hires_size(w, h)[0] if icon_job.get("hires", True) else w
                save(img, f"icons/{folder}/{iname}_seed{s}")
                for sz in ic["sizes"]:
                    if sz < master:
                        save(ctx.resize(img, sz, sz, f"{sz}px"), f"icons/{folder}/{sz}px/{iname}_seed{s}")
        summary = f"아이콘 {len(items)}개 ({ic['style']}): " + ", ".join(n for n, _ in items)[:60]

    else:  # bg
        if not text:
            raise JobError("배경 설명을 입력하세요")
        w, h = resolve_size(job.get("size"), "wide")
        name = safe_name(job.get("name"), "bg")
        bg_job = dict(job, face=False, hands=False)
        pos = ctx.pos("no humans, scenery", text, "detailed background, visual novel background")
        ng = ctx.neg("1girl, 1boy, person, character, text, watermark, signature", extra_neg)
        seeds = seeds_for(job, count)
        for i, s in enumerate(seeds):
            img, _, _ = ctx.render(pos, ng, w, h, s, bg_job, tag=f" ({i + 1}/{count})" if count > 1 else "")
            save(img, f"backgrounds/{name}_seed{s}")
        summary = f"배경: {text[:50]}"
        if job.get("pose"):
            summary += " (배경 모드는 포즈를 쓰지 않습니다)"

    # gen_size: size가 비어 있을 때 쓰는 생성 크기(pose.gen_size(맵 크기)) — 프런트가 [같은 설정으로 다시]에서 그대로 씀
    pose_out = (dict(pose_cfg, size=list(pose_cfg["size"]), gen_size=list(poselib.gen_size(*pose_cfg["size"])))
                if pose_cfg else None)
    return {"graph": g.nodes, "titles": g.titles(), "seeds": seeds, "preset": preset_name,
            "summary": summary, "prefixes": prefixes, "pose": pose_out}
