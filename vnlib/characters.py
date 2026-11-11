"""캐릭터 스펙(characters/<id>.json) 관리."""
import json
import re
import shutil
import time

from .config import CHAR_DIR, USER_DIR, normalize_loras, write_json

ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}$")

DEFAULT_EXPRESSIONS = {
    "neutral": {"prompt": "closed mouth, light smile", "denoise": 0.55},
    "smile": {"prompt": "smile, open mouth, happy", "denoise": 0.55},
    "blush": {"prompt": "blush, embarrassed, looking away, closed mouth", "denoise": 0.6},
    "angry": {"prompt": "angry, pout, v-shaped eyebrows", "denoise": 0.6},
    "sad": {"prompt": "sad, frown, teary eyes", "denoise": 0.6},
    "surprised": {"prompt": "surprised, open mouth, wide-eyed", "denoise": 0.6},
}

TEMPLATE = {
    "id": "",
    "name": "",
    "count": "1girl, solo",
    "appearance": "",
    "outfit": "",
    "style": "",
    "negative": "",
    "seed": None,
    "model": "",
    "loras": [],
    "concept_pose": "upper body, looking at viewer, smile, simple background, white background",
    "sprite_pose": "full body, standing, looking at viewer, arms at sides, white background, simple background",
    "expressions": DEFAULT_EXPRESSIONS,
    "memo": "",
}


class CharacterError(ValueError):
    pass


def valid_id(cid):
    return bool(cid) and bool(ID_RE.match(cid))


def path_for(cid):
    if not valid_id(cid):
        raise CharacterError(f"잘못된 캐릭터 ID: {cid!r} (영문 소문자/숫자/-/_ 만, 40자 이내)")
    return CHAR_DIR / f"{cid}.json"


def normalize(c):
    """누락 필드 채우기 + 표정을 {name: {prompt, denoise}} 형태로 통일"""
    out = json.loads(json.dumps(TEMPLATE))
    out.update({k: v for k, v in c.items() if v is not None or k == "seed"})
    out["loras"] = normalize_loras(out.get("loras"))
    exprs = {}
    for name, e in (out.get("expressions") or {}).items():
        if isinstance(e, str):
            exprs[name] = {"prompt": e, "denoise": 0.55}
        elif isinstance(e, dict) and e.get("prompt") is not None:
            exprs[name] = {"prompt": e["prompt"], "denoise": float(e.get("denoise", 0.55))}
    out["expressions"] = exprs or {"neutral": {"prompt": "closed mouth, light smile", "denoise": 0.55}}
    if out.get("seed") in ("", None):
        out["seed"] = None
    else:
        out["seed"] = int(out["seed"])
    return out


def list_characters():
    CHAR_DIR.mkdir(exist_ok=True)
    out = []
    for p in sorted(CHAR_DIR.glob("*.json")):
        try:
            c = _read(p)
            c["id"] = c.get("id") or p.stem
            out.append(c)
        except Exception as e:  # 깨진 파일은 건너뛰되 알려줌
            out.append({"id": p.stem, "name": p.stem, "error": str(e)})
    return out


def _read(p):
    """캐릭터 JSON 읽기 + 정규화. 깨진 파일은 파일 이름과 위치를 담은 CharacterError로 알린다."""
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise CharacterError(f"캐릭터 파일을 읽을 수 없습니다: {p.name} ({e.lineno}번째 줄 {e.colno}번째 칸: {e.msg})") from None
    except UnicodeDecodeError:
        raise CharacterError(f"캐릭터 파일을 읽을 수 없습니다: {p.name} (UTF-8 텍스트 파일이 아닙니다)") from None
    if not isinstance(data, dict):
        raise CharacterError(f"캐릭터 파일 형식이 잘못되었습니다: {p.name} (내용이 {{ }} 로 감싼 JSON 객체가 아닙니다)")
    try:
        return normalize(data)
    except (TypeError, ValueError, AttributeError) as e:
        raise CharacterError(f"캐릭터 파일 내용이 잘못되었습니다: {p.name} ({e})") from None


def load(cid):
    p = path_for(cid)
    if not p.exists():
        raise CharacterError(f"캐릭터를 찾을 수 없음: {cid}")
    c = _read(p)
    c["id"] = cid
    return c


def load_path(path):
    """CLI용: 파일 경로로 로드"""
    from pathlib import Path
    p = Path(path)
    c = _read(p)
    c["id"] = c.get("id") or p.stem
    return c


def save(c):
    c = normalize(c)
    if not c.get("appearance", "").strip():
        raise CharacterError("외형(appearance)은 비워둘 수 없습니다")
    write_json(path_for(c["id"]), c)
    return c


def delete(cid):
    """휴지통(user/trash/characters)으로 이동 — 복구 가능"""
    p = path_for(cid)
    if not p.exists():
        raise CharacterError(f"캐릭터를 찾을 수 없음: {cid}")
    trash = USER_DIR / "trash" / "characters"
    trash.mkdir(parents=True, exist_ok=True)
    shutil.move(str(p), str(trash / f"{cid}_{time.strftime('%Y%m%d-%H%M%S')}.json"))
