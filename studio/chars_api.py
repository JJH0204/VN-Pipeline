"""캐릭터 CRUD — vnlib.characters 위에 입력 검증과 썸네일 정보를 더한다."""
import json

from vnlib import characters, config

from .common import ApiError, to_number, to_text
from .gallery import character_assets
from .library import Library

RESERVED_IDS = {"template", "new"}
TEXT_FIELDS = {
    "name": ("이름", 200), "count": ("기본 태그", 1000), "appearance": ("외형", 8000),
    "outfit": ("의상", 8000), "style": ("스타일", 4000), "negative": ("추가 네거티브", 8000),
    "concept_pose": ("시안 포즈", 4000), "sprite_pose": ("스프라이트 포즈", 4000), "memo": ("메모", 20000),
}


def _with_assets(c):
    out = dict(c)
    thumb, counts = character_assets(c["id"]) if characters.valid_id(c.get("id", "")) else (None, {})
    out["thumb"] = thumb
    out["counts"] = counts
    return out


def list_all():
    return {"characters": [_with_assets(c) for c in characters.list_characters()]}


def get(cid):
    try:
        return _with_assets(characters.load(cid))
    except characters.CharacterError as e:
        raise ApiError(404 if "찾을 수 없" in str(e) else 400, str(e)) from None
    except (ValueError, OSError) as e:
        raise ApiError(500, f"캐릭터 파일을 읽을 수 없습니다: {e}") from None


def template():
    return json.loads(json.dumps(characters.TEMPLATE))


def clean(body, cid):
    """요청 본문 → 저장할 캐릭터 dict (허용 키만, 형식 검증)"""
    c = {}
    for key, (label, limit) in TEXT_FIELDS.items():
        if key in body:
            c[key] = to_text(body[key], label, limit).strip()
    c["id"] = cid
    if not c.get("name"):
        c["name"] = cid
    seed = body.get("seed")
    c["seed"] = None if seed in (None, "") else to_number(seed, "시드", 0, 2**32 - 1, int)
    model = body.get("model") or ""
    if not isinstance(model, str):
        raise ApiError(400, "모델 프리셋 값이 올바르지 않습니다")
    if model and model not in config.load_presets():
        raise ApiError(400, f"존재하지 않는 모델 프리셋입니다: {model}")
    c["model"] = model
    c["loras"] = Library.clean_loras(body.get("loras"), "캐릭터 LoRA 목록")
    ex = body.get("expressions")
    if ex is not None:
        items = []
        if isinstance(ex, dict):
            items = list(ex.items())
        elif isinstance(ex, list):  # [{"name","prompt","denoise"}] 형식도 허용
            for e in ex:
                if not isinstance(e, dict):
                    raise ApiError(400, "표정 목록 형식이 올바르지 않습니다")
                items.append((e.get("name"), e))
        else:
            raise ApiError(400, "표정 목록 형식이 올바르지 않습니다")
        exprs = {}
        for name, e in items:
            if not isinstance(name, str) or not name.strip():
                raise ApiError(400, "표정 이름을 입력하세요")
            name = name.strip()
            if len(name) > 40:
                raise ApiError(400, f"표정 이름이 너무 깁니다 (40자 이내): {name}")
            if name in exprs:
                raise ApiError(400, f"표정 이름이 중복되었습니다: {name}")
            if isinstance(e, str):
                e = {"prompt": e}
            if not isinstance(e, dict):
                raise ApiError(400, f"표정 '{name}' 형식이 올바르지 않습니다")
            prompt = to_text(e.get("prompt"), f"표정 '{name}' 프롬프트", 4000).strip()
            if not prompt:
                raise ApiError(400, f"표정 '{name}'의 프롬프트를 입력하세요")
            den = e.get("denoise")
            den = 0.55 if den in (None, "") else round(to_number(den, f"표정 '{name}' 강도", 0.05, 1.0), 3)
            exprs[name] = {"prompt": prompt, "denoise": den}
        if not exprs:
            raise ApiError(400, "표정을 1개 이상 등록하세요")
        c["expressions"] = exprs
    if not (c.get("appearance") or "").strip():
        raise ApiError(400, "외형(appearance)은 비워둘 수 없습니다")
    return c


def _save(c):
    try:
        return characters.save(c)
    except characters.CharacterError as e:
        raise ApiError(400, str(e)) from None


def create(body):
    cid = body.get("id")
    if not isinstance(cid, str) or not characters.valid_id(cid):
        raise ApiError(400, "캐릭터 ID는 영문 소문자/숫자/-/_ 만 쓸 수 있고 40자 이내여야 합니다 (첫 글자는 영문/숫자)")
    if cid in RESERVED_IDS:
        raise ApiError(400, f"'{cid}'는 예약된 이름이라 ID로 쓸 수 없습니다")
    if characters.path_for(cid).exists():
        raise ApiError(409, f"이미 같은 ID의 캐릭터가 있습니다: {cid}")
    base = template()
    base.update(body)
    return _with_assets(_save(clean(base, cid)))


def update(cid, body):
    if not characters.valid_id(cid):
        raise ApiError(400, f"잘못된 캐릭터 ID: {cid}")
    if body.get("id") not in (None, cid):
        raise ApiError(400, "주소의 캐릭터 ID와 본문의 id가 다릅니다 (ID는 바꿀 수 없습니다)")
    current = get(cid)  # 없으면 404
    merged = {k: v for k, v in current.items() if k in characters.TEMPLATE}
    merged.update({k: v for k, v in body.items() if k in characters.TEMPLATE})
    return _with_assets(_save(clean(merged, cid)))


def delete(cid):
    try:
        characters.delete(cid)
    except characters.CharacterError as e:
        raise ApiError(404 if "찾을 수 없" in str(e) else 400, str(e)) from None
    return {"ok": True, "id": cid, "message": "캐릭터를 휴지통(user/trash/characters)으로 옮겼습니다"}


def set_seed(cid, body):
    if "seed" not in body:
        raise ApiError(400, "seed 값이 필요합니다")
    c = get(cid)
    seed = body.get("seed")
    c["seed"] = None if seed in (None, "") else to_number(seed, "시드", 0, 2**32 - 1, int)
    saved = _save({k: v for k, v in c.items() if k in characters.TEMPLATE})
    return _with_assets(saved)
