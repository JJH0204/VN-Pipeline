"""safetensors 헤더만 읽어서 모델/LoRA 정보 추출 (가중치는 읽지 않으므로 빠름).

체크포인트: 아키텍처(SDXL/SD1.5), v-prediction 여부
LoRA     : 아키텍처, 학습 베이스 모델, 예측 방식, 트리거 후보 태그, rank
호환성   : LoRA ↔ 프리셋 체크포인트
"""
import collections
import json
import re
import struct
from pathlib import Path

_cache = {}

# 이름(파일명·학습 베이스 모델명)으로 계열 추정. 앞쪽이 우선.
# wai는 단어 시작에서만(waiIllustrious, waiNSFW…) — kawaii, hawaii 같은 단어 속 'wai'는 무시.
# pony를 Illustrious보다 먼저 봐서 'kawaii_pony' 같은 이름을 Pony로 판정.
_FAMILIES = (
    (re.compile(r"noob"), "NoobAI"),
    (re.compile(r"pony"), "Pony"),
    (re.compile(r"illustrious|(?<![a-z])wai"), "Illustrious"),
    (re.compile(r"animagine"), "Animagine"),
    (re.compile(r"sdxl|sd_xl"), "SDXL"),
    (re.compile(r"v1-5|sd15"), "SD1.5"),
)

# ss_base_model_version(kohya) 접두어 → 구조
_BASE_VERSIONS = (("sdxl", "SDXL"), ("sd_v1", "SD1.5"), ("sd_v2", "SD2"), ("flux", "Flux"), ("sd3", "SD3"))

# 트리거 후보에서 뺄 태그: 구도·배경 같은 일반 태그, 등급(rating) 태그, 품질·연도 같은 메타 태그
_GENERIC_TAGS = {"1girl", "solo", "1boy", "looking at viewer", "simple background", "white background"}
_RATING_TAGS = {"general", "sensitive", "questionable", "explicit", "nsfw", "sfw", "safe"}
_META_TAGS = {"absurdres", "highres", "lowres", "best quality", "high quality", "newest", "recent", "mid", "early", "old"}
_SKIP_TAGS = _GENERIC_TAGS | _RATING_TAGS | _META_TAGS


def read_header(path):
    path = Path(path)
    st = path.stat()
    key = (str(path), st.st_mtime, st.st_size)
    if key in _cache:
        return _cache[key]
    if path.suffix.lower() != ".safetensors":
        _cache[key] = None
        return None
    with open(path, "rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        if n > 100_000_000:
            raise ValueError("헤더가 너무 큼 — safetensors 파일이 아닐 수 있음")
        h = json.loads(f.read(n))
    _cache[key] = h
    return h


def _family(text):
    t = (text or "").lower()
    for rx, name in _FAMILIES:
        if rx.search(t):
            return name
    return ""


def checkpoint_info(path):
    info = {"arch": "unknown", "vpred": False, "family": _family(Path(path).name)}
    try:
        h = read_header(path)
    except Exception as e:
        info["error"] = str(e)
        return info
    if h is None:
        return info
    keys = h.keys()
    if any(k.startswith("conditioner.embedders.1") for k in keys):
        info["arch"] = "SDXL"
    elif any(k.startswith("cond_stage_model.") for k in keys):
        info["arch"] = "SD1.5"
    info["vpred"] = "v_pred" in h  # NoobAI 등 vpred 체크포인트는 v_pred/ztsnr 키를 포함
    meta = h.get("__metadata__") or {}
    if meta.get("modelspec.prediction_type") == "v":
        info["vpred"] = True
    return info


def lora_info(path):
    info = {"arch": "unknown", "prediction": "", "base_model": "", "family": "", "triggers": [], "rank": None}
    try:
        h = read_header(path)
    except Exception as e:
        info["error"] = str(e)
        return info
    if h is None:
        return info
    meta = h.get("__metadata__") or {}
    keys = " ".join(k for k in h if k != "__metadata__")
    # 1) 학습 도구가 기록한 베이스 버전이 있으면 그것을 믿는다
    #    (Flux/SD3 LoRA도 텍스트 인코더를 lora_te1_ 로 저장하므로 키만 보면 SDXL로 오인함)
    bmv = str(meta.get("ss_base_model_version") or "").lower()
    arch = next((name for prefix, name in _BASE_VERSIONS if bmv.startswith(prefix)), "")
    # 2) 없으면 가중치 키 이름으로 추정 (Flux/SD3 블록을 SDXL 텍스트 인코더 키보다 먼저 확인)
    if not arch:
        if "double_blocks" in keys or "single_blocks" in keys or "single_transformer_blocks" in keys:
            arch = "Flux"
        elif "joint_blocks" in keys:
            arch = "SD3"
        elif "lora_te1_" in keys or "lora_te2_" in keys or "transformer_blocks_9" in keys or "input_blocks_4_1_transformer_blocks_1" in keys:
            arch = "SDXL"
        elif "lora_te_" in keys or "down_blocks_0_attentions" in keys or "input_blocks_1_1" in keys:
            arch = "SD1.5"
    info["arch"] = arch or "unknown"
    pt = meta.get("modelspec.prediction_type") or ("v" if meta.get("ss_v_parameterization") in ("True", True) else "")
    info["prediction"] = {"v": "v-pred", "epsilon": "eps"}.get(pt, pt)
    info["base_model"] = meta.get("ss_sd_model_name", "")
    info["family"] = _family(info["base_model"]) or _family(Path(path).name)
    if meta.get("ss_network_dim"):
        try:
            info["rank"] = int(float(meta["ss_network_dim"]))
        except ValueError:
            pass
    tf = meta.get("ss_tag_frequency")
    if tf:
        try:
            c = collections.Counter()
            for d in json.loads(tf).values():
                for t, n in d.items():
                    c[str(t).strip()] += n
            # 가장 흔한 태그의 절반 이상 붙은 것만 (학습 이미지에 우연히 많았던 머리색·등급 태그 등은 제외),
            # 등급·품질·메타 태그와 긴 설명문 조각도 제외
            top = c.most_common(1)[0][1] if c else 0
            info["triggers"] = [t for t, n in c.most_common(40)
                                if t and n >= top * 0.5 and t.lower() not in _SKIP_TAGS
                                and not t.lower().startswith(("rating", "year "))
                                and len(t.split()) <= 4][:8]
        except Exception:
            pass
    if meta.get("modelspec.title") and not meta["modelspec.title"].startswith(("Stable Diffusion", "LoRA@")):
        info["title"] = meta["modelspec.title"]
    return info


def compatibility(lora, ckpt):
    """lora/ckpt: 위 함수 결과 dict. → ("ok"|"warn"|"bad", 설명)"""
    if lora.get("arch") == "unknown" or ckpt.get("arch") == "unknown":
        return "warn", "아키텍처를 확인할 수 없음 — 직접 테스트 필요"
    if lora["arch"] != ckpt["arch"]:
        return "bad", f"{lora['arch']}용 LoRA라 {ckpt['arch']} 모델에서는 동작하지 않음"
    notes = []
    lf, cf = lora.get("family"), ckpt.get("family")
    anime = {"NoobAI", "Illustrious"}
    if lf and cf and lf != cf and not (lf in anime and cf in anime):
        notes.append(f"{lf} 계열로 학습됨 (모델은 {cf} 계열) — 효과가 약하거나 그림체가 틀어질 수 있음")
    if lora.get("prediction") == "v-pred" and not ckpt.get("vpred"):
        notes.append("v-pred 모델용으로 학습됨 — eps 모델에서는 색감이 달라질 수 있음")
    if notes:
        return "warn", " / ".join(notes)
    return "ok", "호환"
