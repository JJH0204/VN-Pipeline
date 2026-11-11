"""모델 라이브러리(체크포인트/LoRA/업스케일러), 프리셋, LoRA 메모, 전역 설정 — 조회와 검증."""
import asyncio
import json
import re

from vnlib import config, modelinfo, pose, tagger

from .common import ApiError, MODEL_INSTALL_ROOT, log, to_bool, to_number, to_text

DEFAULT_SAMPLERS = ["euler", "euler_ancestral", "dpmpp_2m", "dpmpp_2m_sde", "dpmpp_sde", "dpmpp_3m_sde", "ddim", "uni_pc"]
DEFAULT_SCHEDULERS = ["normal", "karras", "exponential", "sgm_uniform", "simple", "beta"]
PRESET_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}$")
DEFAULT_LORA_META = {"trigger": "", "weight": 0.8, "note": ""}

# PUT /api/settings 로 바꿀 수 있는 키와 검증 규칙
SETTING_RULES = {
    "hires_scale": ("하이레즈 배율", float, 1.0, 2.0),
    "hires_steps": ("하이레즈 스텝", int, 4, 60),
    "detail_steps": ("보정 스텝", int, 4, 60),
    "hires_denoise": ("하이레즈 강도", float, 0.05, 1.0),
    "face_denoise": ("얼굴 보정 강도", float, 0.05, 1.0),
    "hand_denoise": ("손 보정 강도", float, 0.05, 1.0),
    "expr_denoise": ("표정 기본 강도", float, 0.05, 1.0),
    "tagger_threshold": ("프롬프트 추출 일반 태그 기준값", float, 0.05, 0.95),
    "tagger_char_threshold": ("프롬프트 추출 캐릭터 태그 기준값", float, 0.3, 0.99),
    "pose_strength": ("포즈 기본 강도", float, 0.1, 2.0),
    "pose_end": ("포즈 적용 구간(끝)", float, 0.1, 1.0),
}

# 원격 접속 설정 (§10.2) — 일반 설정 저장(PUT /api/settings)으로는 바꿀 수 없고 /api/remote(로컬 전용)로만 바꾼다
REMOTE_KEYS = ("remote_enabled", "remote_allowed_logins", "remote_hosts")
REMOTE_MAX_LOGINS = 50
# 정확한 로그인만: name@gmail.com, octocat@github, name@passkey … (와일드카드·공백·목록 구분자 불가)
_LOGIN_PART = r"[^@\s\x00-\x1f\x7f*,;<>\"'()\[\]\\/]+"
_LOGIN_RE = re.compile(_LOGIN_PART + "@" + _LOGIN_PART)


def clean_remote_logins(v):
    """remote_allowed_logins 검증: 문자열 목록, 정확한 로그인만(와일드카드 '*@도메인' 불허), 최소 1개. 대소문자 무시 중복 제거."""
    if not isinstance(v, list):
        raise ApiError(400, "허용할 로그인 목록은 문자열 목록이어야 합니다")
    out, seen = [], set()
    for item in v:
        if not isinstance(item, str):
            raise ApiError(400, "허용할 로그인은 문자열이어야 합니다")
        x = item.strip()
        if not x:
            continue
        if len(x) > 254:
            raise ApiError(400, f"로그인이 너무 깁니다 (최대 254자): {x[:40]}…")
        if "*" in x:
            raise ApiError(400, f"'*' 같은 와일드카드는 쓸 수 없습니다. 정확한 로그인(이메일)을 입력하세요: {x}")
        if not _LOGIN_RE.fullmatch(x):
            raise ApiError(400, f"로그인 형식이 올바르지 않습니다: {x} (예: name@gmail.com — Tailscale에 로그인한 계정)")
        if x.lower() in seen:
            continue
        seen.add(x.lower())
        out.append(x)
    if not out:
        raise ApiError(400, "허용할 로그인을 1개 이상 입력하세요")
    if len(out) > REMOTE_MAX_LOGINS:
        raise ApiError(400, f"허용할 로그인은 최대 {REMOTE_MAX_LOGINS}개까지입니다")
    return out


def _stat(p):
    try:
        st = p.stat()
        return st.st_size, st.st_mtime
    except OSError:
        return None, None


def _detach_preset_from_characters(name):
    """삭제된 프리셋을 쓰던 캐릭터의 model 을 ""(= 기본 프리셋 사용)로 되돌린다.

    characters.save() 는 정규화·필수값 검사(외형 비어 있음 등)로 실패할 수 있으므로,
    원본 JSON 에서 model 키만 바꿔 원자적으로 다시 쓴다(다른 필드는 그대로 보존).
    반환: (고친 캐릭터 [{id, name}], 실패 [{id, name, error}])
    """
    cleared, failed = [], []
    try:
        files = sorted(config.CHAR_DIR.glob("*.json"))
    except OSError as e:
        log.warning("캐릭터 폴더를 읽을 수 없어 프리셋 참조를 정리하지 못했습니다: %s", e)
        return cleared, failed
    for path in files:
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue  # 깨진 파일은 어떤 프리셋을 쓰는지 알 수 없음 (캐릭터 목록에 오류로 따로 표시됨)
        if not isinstance(raw, dict) or raw.get("model") != name:
            continue
        cid = raw.get("id") or path.stem  # characters.list_characters() 와 같은 규칙
        who = {"id": cid, "name": str(raw.get("name") or cid)}
        raw["model"] = ""
        try:
            config.write_json(path, raw)
        except OSError as e:
            log.warning("캐릭터 %s 의 모델 프리셋을 되돌리지 못했습니다: %s", cid, e)
            failed.append(dict(who, error=f"캐릭터 파일을 저장할 수 없습니다: {e}"))
            continue
        log.info("프리셋 '%s' 삭제로 캐릭터 %s 의 모델 프리셋을 기본값으로 되돌림", name, cid)
        cleared.append(who)
    return cleared, failed


def scan_models():
    """디스크 스캔 (스레드에서 실행). safetensors 헤더만 읽고 mtime 캐시를 사용하므로 빠르다."""
    presets = config.load_presets()
    meta = config.load_lora_meta()

    ckpt_files = config.list_models("checkpoints")
    ckpt_infos = {}
    checkpoints = []
    for name, path in sorted(ckpt_files.items(), key=lambda x: x[0].lower()):
        size, mtime = _stat(path)
        info = modelinfo.checkpoint_info(path)
        ckpt_infos[name] = info
        item = {"name": name, "path": str(path), "size": size, "mtime": mtime,
                "arch": info.get("arch"), "vpred": bool(info.get("vpred")), "family": info.get("family") or "",
                "presets": [pn for pn, p in presets.items() if p.get("ckpt") == name]}
        if info.get("error"):
            item["error"] = info["error"]
        checkpoints.append(item)

    # 프리셋별 '실제 적용되는' 체크포인트 정보 (vpred 는 프리셋 설정을 따름)
    preset_ckpt = {}
    for pn, p in presets.items():
        info = ckpt_infos.get(p.get("ckpt"))
        if info is None and p.get("ckpt"):
            path = config.find_model("checkpoints", p["ckpt"])
            info = modelinfo.checkpoint_info(path) if path else None
        if info is not None:
            info = dict(info, vpred=bool(p.get("vpred")))
        preset_ckpt[pn] = info

    loras = []
    for name, path in sorted(config.list_models("loras").items(), key=lambda x: x[0].lower()):
        size, mtime = _stat(path)
        info = modelinfo.lora_info(path)
        compat = {}
        for pn, cinfo in preset_ckpt.items():
            if cinfo is None:
                compat[pn] = {"level": "warn", "reason": f"프리셋의 체크포인트 파일({presets[pn].get('ckpt')})을 찾을 수 없음"}
            else:
                level, reason = modelinfo.compatibility(info, cinfo)
                compat[pn] = {"level": level, "reason": reason}
        m = dict(DEFAULT_LORA_META)
        m.update({k: v for k, v in (meta.get(name) or {}).items() if k in DEFAULT_LORA_META})
        item = {"name": name, "path": str(path), "size": size, "mtime": mtime,
                "arch": info.get("arch"), "prediction": info.get("prediction") or "",
                "base_model": info.get("base_model") or "", "family": info.get("family") or "",
                "triggers": info.get("triggers") or [], "rank": info.get("rank"), "title": info.get("title"),
                "meta": m, "compat": compat,
                "presets": [pn for pn, p in presets.items()
                            if any(lo["name"] == name for lo in p.get("loras", []))]}
        if info.get("error"):
            item["error"] = info["error"]
        loras.append(item)

    upscalers = sorted(config.list_models("upscale_models"), key=str.lower)
    # 포즈 따라 그리기용 ControlNet: 설치된 파일 + 모델별 맵 스타일·권장 강도(vnlib.pose.CONTROLNETS)
    controlnets = [{k: c[k] for k in ("name", "path", "size", "style", "strength", "label", "known")}
                   for c in pose.list_controlnets()]
    folders = ("checkpoints", "loras", "upscale_models", "controlnet")
    return {
        "checkpoints": checkpoints,
        "loras": loras,
        "upscalers": upscalers,
        "controlnets": controlnets,
        "model_dirs": {f: [str(d) for d in config.model_dirs(f)] for f in folders},
        "install_dir": {f: str(MODEL_INSTALL_ROOT / f) for f in folders},
    }


class Library:
    def __init__(self, comfy):
        self.comfy = comfy

    async def sampler_lists(self):
        got = await self.comfy.samplers()
        if got:
            return list(got[0]), list(got[1]), True
        return list(DEFAULT_SAMPLERS), list(DEFAULT_SCHEDULERS), False

    async def models(self):
        data, (samplers, schedulers, live) = await asyncio.gather(
            asyncio.to_thread(scan_models), self.sampler_lists())
        data["samplers"], data["schedulers"] = samplers, schedulers
        data["samplers_from_engine"] = live
        return data

    # ------------------------------------------------------------ 프리셋
    @staticmethod
    def presets():
        s = config.load_settings()
        return {"presets": config.load_presets(), "default": s.get("default_preset")}

    async def save_preset(self, name, body):
        if not PRESET_RE.match(name or ""):
            raise ApiError(400, "프리셋 이름은 영문 소문자/숫자/-/_ 만 쓸 수 있고 40자 이내여야 합니다 (첫 글자는 영문/숫자)")
        samplers, schedulers, live = await self.sampler_lists()
        p = {}
        p["label"] = to_text(body.get("label"), "표시 이름", 80).strip() or name
        ckpt = body.get("ckpt")
        if not isinstance(ckpt, str) or not ckpt.strip():
            raise ApiError(400, "체크포인트를 선택하세요")
        if not config.find_model("checkpoints", ckpt):
            raise ApiError(400, f"체크포인트 파일을 찾을 수 없습니다: {ckpt}")
        p["ckpt"] = ckpt
        p["vpred"] = to_bool(body.get("vpred", False), "v-pred")
        for key, label, allowed in (("sampler", "샘플러", samplers), ("scheduler", "스케줄러", schedulers)):
            v = body.get(key)
            if not isinstance(v, str) or not v.strip():
                raise ApiError(400, f"{label}를 선택하세요")
            v = v.strip()
            if live and v not in allowed:
                raise ApiError(400, f"알 수 없는 {label}입니다: {v}")
            if not re.fullmatch(r"[A-Za-z0-9_.+-]{1,60}", v):
                raise ApiError(400, f"{label} 이름이 올바르지 않습니다: {v}")
            p[key] = v
        p["cfg"] = round(to_number(body.get("cfg"), "CFG", 1, 20), 2)
        p["steps"] = to_number(body.get("steps"), "스텝 수", 5, 80, int)
        p["quality"] = to_text(body.get("quality"), "품질 태그", 4000).strip()
        p["negative"] = to_text(body.get("negative"), "기본 네거티브", 8000).strip()
        p["loras"] = self.clean_loras(body.get("loras"))
        p["note"] = to_text(body.get("note"), "노트", 4000).strip()
        presets = config.load_presets()
        created = name not in presets
        presets[name] = p
        config.save_presets(presets)
        return {"ok": True, "preset": p, "name": name, "created": created}

    @staticmethod
    def clean_loras(v, field="LoRA 목록"):
        if v in (None, ""):
            return []
        if not isinstance(v, list):
            raise ApiError(400, f"{field} 형식이 올바르지 않습니다")
        try:
            loras = config.normalize_loras(v)
        except (TypeError, ValueError):
            raise ApiError(400, "LoRA 강도는 숫자여야 합니다") from None
        out = []
        for lo in loras:
            if not isinstance(lo["name"], str) or not config.find_model("loras", lo["name"]):
                raise ApiError(400, f"LoRA 파일을 찾을 수 없습니다: {lo['name']}")
            out.append({"name": lo["name"], "weight": round(to_number(lo["weight"], f"LoRA 강도({lo['name']})", -3, 3), 3)})
        return out

    @staticmethod
    def delete_preset(name):
        presets = config.load_presets()
        if name not in presets:
            raise ApiError(404, f"프리셋을 찾을 수 없습니다: {name}")
        if len(presets) <= 1:
            raise ApiError(409, "마지막 남은 프리셋은 삭제할 수 없습니다")
        default = config.load_settings().get("default_preset")
        if default == name:
            raise ApiError(409, "기본 프리셋은 삭제할 수 없습니다. 다른 프리셋을 기본으로 지정한 뒤 삭제하세요.")
        label = presets[name].get("label") or name
        del presets[name]
        config.save_presets(presets)
        cleared, failed = _detach_preset_from_characters(name)

        default_label = (presets.get(default) or {}).get("label") or default
        message = f"프리셋 '{label}'을(를) 삭제했습니다."
        if cleared:
            who = ", ".join(c["name"] for c in cleared)
            target = f"기본 프리셋('{default_label}')" if default_label else "기본 프리셋"
            message += f" 이 프리셋을 쓰던 캐릭터 {len(cleared)}명({who})은 이제 {target}으로 생성됩니다."
        if failed:
            who = ", ".join(c["name"] for c in failed)
            message += f" 캐릭터 파일을 고치지 못했습니다({who}). 캐릭터 탭에서 모델 프리셋을 다시 지정하세요."
        return {"ok": True, "name": name, "default": default, "message": message,
                "affected_characters": [c["id"] for c in cleared],
                "failed_characters": [{"id": c["id"], "error": c["error"]} for c in failed]}

    @staticmethod
    def set_default(name):
        if not isinstance(name, str) or name not in config.load_presets():
            raise ApiError(400, f"프리셋을 찾을 수 없습니다: {name}")
        s = config.load_settings()
        s["default_preset"] = name
        config.save_settings(s)
        return {"ok": True, "default": name}

    # ------------------------------------------------------------ LoRA 메모
    @staticmethod
    def save_lora_meta(filename, body):
        if filename not in config.list_models("loras"):
            raise ApiError(404, f"LoRA 파일을 찾을 수 없습니다: {filename}")
        m = {
            "trigger": to_text(body.get("trigger"), "트리거 단어", 1000).strip(),
            "weight": round(to_number(body.get("weight", 0.8), "기본 강도", -3, 3), 3),
            "note": to_text(body.get("note"), "설명", 4000).strip(),
        }
        meta = config.load_lora_meta()
        meta[filename] = m
        config.save_lora_meta(meta)
        return {"ok": True, "name": filename, "meta": m}

    # ------------------------------------------------------------ 전역 설정
    @staticmethod
    def settings():
        return config.load_settings()

    @staticmethod
    def save_settings(body):
        s = config.load_settings()
        changed, ignored = {}, []
        for key, val in body.items():
            if key in SETTING_RULES:
                label, kind, lo, hi = SETTING_RULES[key]
                v = to_number(val, label, lo, hi, kind)
                changed[key] = round(v, 3) if kind is float else v
            elif key == "autostart_comfy":
                changed[key] = to_bool(val, "엔진 자동 시작")
            elif key == "default_preset":
                if val not in config.load_presets():
                    raise ApiError(400, f"프리셋을 찾을 수 없습니다: {val}")
                changed[key] = val
            elif key == "tagger_model":
                names = [m["name"] for m in tagger.list_models()]
                if not isinstance(val, str) or val not in names:
                    raise ApiError(400, f"태거 모델을 찾을 수 없습니다: {val} "
                                        f"(설치된 모델: {', '.join(names) if names else '없음'})")
                changed[key] = val
            elif key == "pose_model":
                names = [c["name"] for c in pose.list_controlnets()]
                if not isinstance(val, str) or val not in names:
                    raise ApiError(400, f"ControlNet 파일을 찾을 수 없습니다: {val} "
                                        f"(설치된 파일: {', '.join(names) if names else '없음'})")
                changed[key] = val
            elif key == "upscaler":
                if not isinstance(val, str) or val not in config.list_models("upscale_models"):
                    raise ApiError(400, f"업스케일러 파일을 찾을 수 없습니다: {val}")
                changed[key] = val
            elif key == "civitai_token":
                tok = to_text(val, "Civitai 토큰", 300).strip()
                if tok and not re.fullmatch(r"[A-Za-z0-9_\-.]+", tok):
                    raise ApiError(400, "Civitai 토큰 형식이 올바르지 않습니다 (영문/숫자만)")
                changed[key] = tok
            elif key in REMOTE_KEYS:
                if s.get(key) != val:
                    ignored.append(key)  # 원격 접속 설정은 /api/remote 전용 (원격에서 스스로 허용 범위를 넓히지 못하게)
            elif s.get(key) != val:
                ignored.append(key)  # comfy_url, studio_port 등은 GUI에서 바꾸지 않음
        s.update(changed)
        config.save_settings(s)
        return {"ok": True, "settings": s, "ignored": ignored}
