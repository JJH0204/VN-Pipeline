"""스프라이트 시트용 동작 라이브러리: 동작(걷기·달리기·공격…) × 방향(아래·왼쪽·오른쪽·위) → OpenPose 포즈 맵.

생성 방식 (graphs.py 의 "sheet" 모드):
  한 줄(동작 1개 × 방향 1개)의 프레임들을 가로로 나란히 놓은 포즈 맵을 그려 **한 장으로** 생성한다.
  같은 그림 안에 같은 캐릭터를 여러 번 그리면(reference sheet / multiple views) 프레임끼리 얼굴·옷이 잘 맞는다.
  줄마다 같은 시드·같은 캐릭터 프롬프트를 써서 줄끼리도 최대한 맞춘다.

뼈대 모델: 몸 기준 3D 좌표 (lat: 인물의 왼쪽 +, up: 위 +, fwd: 앞 +), 골반 = 원점.
  각 동작은 시간 t(0~1)마다 관절 각도(도 단위)를 돌려주고, 방향에 맞게 정사영(정면/뒷면/옆)해 화면에 그린다.
  화면에 그린 뒤 가장 낮은 점(발·엉덩이·무릎)을 바닥선에 맞추므로 웅크리기·앉기도 자연스럽게 내려온다.
OpenPose 18점 순서와 좌우 규칙은 pose.BODY_NAMES (좌우는 인물 기준).
"""
import hashlib
import json
import math

from . import pose as poselib

DIRECTIONS = {  # 이름, 프롬프트 태그 — 순서는 RPG 툴 관례(아래·왼쪽·오른쪽·위)
    "down": ("아래 (정면)", "from front, facing viewer, looking at viewer"),
    "left": ("왼쪽", "(from side:1.1), profile, facing left"),
    "right": ("오른쪽", "(from side:1.1), profile, facing right"),
    "up": ("위 (뒷모습)", "(from behind:1.2), back view, facing away, back of head"),
}
# 방향별 추가 네거티브 — 뒷모습 뼈대(얼굴 점 없음)는 정면으로 오해되기 쉽다
DIR_NEG = {
    "down": "from behind, back",
    "left": "from front, looking at viewer",
    "right": "from front, looking at viewer",
    "up": "looking at viewer, face, eyes, from front, facing viewer, turnaround",
}
# graphs.SHEET_TAGS에 "multiple views, character sheet"는 쓰지 않는다 (실측): 웅크리기·누운 프레임 위 빈 공간에
# 다른 인물을 더 그려 넣었다. 포즈 맵이 이미 인물 수·자리를 정하므로 없어도 프레임끼리 잘 맞는다.
TILT = 0.5  # 탑다운 RPG 카메라 기울기: 정면·뒷모습에서 앞으로 나온 발은 화면 아래, 뒤로 간 발은 위로
DIR_ORDER = ("down", "left", "right", "up")

# 이름 → (한국어 이름, 프롬프트 태그, 반복 동작 여부)
MOTIONS = {
    "idle": ("대기", "standing, idle, arms at sides", True),
    "walk": ("걷기", "walking", True),
    "run": ("달리기", "running, motion lines", True),
    "attack": ("공격", "holding sword, swinging sword, attacking, fighting stance", False),
    "pickup": ("줍기", "bending over, picking up, reaching down", False),
    "down": ("쓰러짐", "falling, knocked down, lying on ground, defeated", False),
    "rest": ("휴식", "sitting on ground, resting, relaxed", False),
}
MOTION_NEG = {"rest": "chair, stool, bench, furniture, box"}  # 앉기·무릎 꿇기 자세 밑에 받침을 그려 넣음 (실측)
MOTION_ORDER = ("idle", "walk", "run", "attack", "pickup", "down", "rest")
FRAMES = (4, 6)

# 몸 치수 (키 = 1.0, 골반 기준)
HIP_W, SHOULDER_W = 0.06, 0.11
TORSO = 0.31          # 골반 → 목
THIGH, SHIN = 0.24, 0.23
UPPER, FORE = 0.15, 0.14
GROUND = 0.95         # 칸 안의 바닥선 (세로 비율)
FIG_H = 0.86          # 서 있을 때 키가 칸 높이에서 차지하는 비율

ZERO = {"torso": 0.0, "thR": 0.0, "thL": 0.0, "knR": 0.0, "knL": 0.0, "arR": 8.0, "arL": 8.0,
        "elR": 10.0, "elL": 10.0, "abR": 6.0, "abL": 6.0, "fall": 0.0, "bob": 0.0, "head": 0.0}


class SheetError(ValueError):
    pass


# ---------------------------------------------------------------------- 동작 (t: 0~1 → 관절 각도)
def _p(**kw):
    d = dict(ZERO)
    d.update(kw)
    return d


def _keys(frames, t):
    """키프레임 [(시간, 각도 dict)] 선형 보간"""
    if t <= frames[0][0]:
        return dict(frames[0][1])
    for (t0, a), (t1, b) in zip(frames, frames[1:]):
        if t <= t1:
            u = (t - t0) / ((t1 - t0) or 1)
            u = u * u * (3 - 2 * u)  # 부드럽게 (smoothstep)
            return {k: a[k] + (b[k] - a[k]) * u for k in a}
    return dict(frames[-1][1])


def _cycle(t, amp_th, amp_kn, amp_ar, el, bob, lean):
    s = math.sin(2 * math.pi * t)
    c = math.cos(2 * math.pi * t)
    return _p(torso=lean, thR=amp_th * s, thL=-amp_th * s,
              knR=8 + amp_kn * max(0.0, c), knL=8 + amp_kn * max(0.0, -c),  # 다리를 앞으로 내미는 동안 무릎이 접힘
              arR=-amp_ar * s, arL=amp_ar * s, elR=el, elL=el, abR=6, abL=6, bob=bob * abs(c))


ATTACK = [  # 칼 휘두르기 (오른손)
    (0.0, _p(torso=0, thR=15, thL=-12, knR=15, knL=10, arR=20, elR=40, arL=10, elL=20)),
    (0.3, _p(torso=-6, thR=18, thL=-15, knR=20, knL=10, arR=-160, elR=30, abR=15, arL=30, elL=40)),
    (0.65, _p(torso=12, thR=30, thL=-22, knR=35, knL=8, arR=75, elR=5, abR=10, arL=-25, elL=30)),
    (1.0, _p(torso=6, thR=24, thL=-18, knR=25, knL=8, arR=45, elR=20, arL=0, elL=25)),
]
PICKUP = [
    (0.0, _p()),
    (0.35, _p(torso=45, thR=40, thL=30, knR=60, knL=50, arR=50, elR=10, arL=30, elL=20)),
    (0.65, _p(torso=55, thR=95, thL=80, knR=130, knL=120, arR=80, elR=5, arL=40, elL=40)),
    (1.0, _p(torso=0, arR=60, elR=90, arL=10, elL=15)),
]
DOWN = [
    (0.0, _p(torso=-15, thR=-5, thL=8, knR=10, knL=15, arR=-20, arL=-25, elR=30, elL=30, abR=25, abL=25, head=-15)),
    (0.35, _p(torso=-25, thR=10, thL=25, knR=30, knL=40, arR=-40, arL=-50, elR=20, elL=20, abR=40, abL=40, fall=40)),
    (0.7, _p(torso=-5, thR=15, thL=5, knR=25, knL=10, arR=-80, arL=-70, elR=10, elL=10, abR=50, abL=45, fall=82)),
    (1.0, _p(torso=0, thR=8, thL=2, knR=12, knL=5, arR=-90, arL=-80, elR=5, elL=5, abR=55, abL=50, fall=90)),
]
REST = [  # 바닥에 앉기: 무릎을 세우고 엉덩이·발이 모두 바닥에 (허벅지는 위로 45°, 정강이는 바닥으로)
    (0.0, _p()),
    (0.35, _p(torso=10, thR=5, thL=5, knR=95, knL=95, arR=15, arL=15, elR=40, elL=40)),  # 무릎 꿇기 (공중에 뜬 웅크림은 의자로 그려짐)
    (0.7, _p(torso=-5, thR=130, thL=125, knR=95, knL=90, arR=-35, arL=-35, elR=10, elL=10, abR=15, abL=15)),
    (1.0, _p(torso=-10, thR=135, thL=130, knR=93, knL=90, arR=-40, arL=-40, elR=5, elL=5, abR=18, abL=18, bob=0.006)),
]


def angles(motion, t):
    if motion == "idle":
        s = math.sin(2 * math.pi * t)
        return _p(bob=0.006 * (1 + s), arR=8 + 3 * s, arL=8 + 3 * s, head=2 * s)
    if motion == "walk":
        return _cycle(t, 30, 40, 26, 15, 0.015, 3)
    if motion == "run":
        return _cycle(t, 42, 85, 50, 85, 0.03, 12)
    table = {"attack": ATTACK, "pickup": PICKUP, "down": DOWN, "rest": REST}.get(motion)
    if table is None:
        raise SheetError(f"알 수 없는 동작입니다: {motion}")
    return _keys(table, t)


def times(motion, n):
    """프레임 n개의 시간값. 반복 동작은 끝 = 처음이므로 [0, 1) 균등, 한 번 동작은 [0, 1] 양 끝 포함."""
    if MOTIONS[motion][2]:
        return [i / n for i in range(n)]
    return [i / (n - 1) for i in range(n)]


# ---------------------------------------------------------------------- 3D 뼈대 → 화면
def _limb(origin, side, ang, bend, ab, l1, l2, knee):
    """팔다리 두 마디. ang: 아래 기준 앞으로(+) 각도, bend: 둘째 마디가 접히는 각도, ab: 바깥으로 벌림.
    knee=True면 다리(정강이가 뒤로 접힘), False면 팔(아래팔이 앞으로 접힘)."""
    a, b, r = math.radians(ang), math.radians(ang + (-bend if knee else bend)), math.radians(ab)
    d1 = (side * math.sin(r), -math.cos(a) * math.cos(r), math.sin(a) * math.cos(r))
    d2 = (side * math.sin(r) * 0.6, -math.cos(b), math.sin(b))
    j1 = tuple(o + l1 * d for o, d in zip(origin, d1))
    j2 = tuple(o + l2 * d for o, d in zip(j1, d2))
    return j1, j2


def skeleton(a):
    """관절 각도 → 18점 3D 좌표 (lat, up, fwd)"""
    tor = math.radians(a["torso"])
    up_v = (0.0, math.cos(tor), math.sin(tor))           # 상체 방향
    neck = tuple(TORSO * v for v in up_v)
    hd = math.radians(a["torso"] + a["head"])
    hu = (0.0, math.cos(hd), math.sin(hd))                # 머리 위 방향
    hf = (0.0, -math.sin(hd), math.cos(hd))               # 얼굴 앞 방향

    def at(base, lat=0.0, up=0.0, fwd=0.0):
        return (base[0] + lat, base[1] + up * hu[1] + fwd * hf[1], base[2] + up * hu[2] + fwd * hf[2])

    sh_r = (-SHOULDER_W, neck[1] - 0.01, neck[2])
    sh_l = (SHOULDER_W, neck[1] - 0.01, neck[2])
    el_r, wr_r = _limb(sh_r, -1, a["arR"], a["elR"], a["abR"], UPPER, FORE, False)
    el_l, wr_l = _limb(sh_l, 1, a["arL"], a["elL"], a["abL"], UPPER, FORE, False)
    hip_r, hip_l = (-HIP_W, 0.0, 0.0), (HIP_W, 0.0, 0.0)
    kn_r, an_r = _limb(hip_r, -1, a["thR"], a["knR"], 2, THIGH, SHIN, True)
    kn_l, an_l = _limb(hip_l, 1, a["thL"], a["knL"], 2, THIGH, SHIN, True)
    nose = at(neck, up=0.10, fwd=0.05)
    eye_r, eye_l = at(neck, -0.025, 0.125, 0.045), at(neck, 0.025, 0.125, 0.045)
    ear_r, ear_l = at(neck, -0.05, 0.11, 0.0), at(neck, 0.05, 0.11, 0.0)
    return [nose, neck, sh_r, el_r, wr_r, sh_l, el_l, wr_l, hip_r, kn_r, an_r, hip_l, kn_l, an_l,
            eye_r, eye_l, ear_r, ear_l]


# 방향별 보이는 얼굴 점 (코 0, 오른눈 14, 왼눈 15, 오른귀 16, 왼귀 17)
HIDDEN = {"down": (), "up": (0, 14, 15), "right": (15, 17), "left": (14, 16)}
# 옆모습(오른쪽을 봄)이면 인물의 오른쪽이 보는 사람 쪽 → 멀리 있는 왼쪽 팔다리는 살짝 뒤로(화면 x는 그대로)


def project(pts, direction):
    """3D → 화면 (x: 오른쪽 +, y: 아래 +), 키 1.0 단위, 골반 기준"""
    out = []
    for lat, up, fwd in pts:
        y = -up
        if direction == "down":    # 보는 사람 쪽(앞)으로 나온 점은 아래로
            x, y = lat, y + TILT * fwd
        elif direction == "up":    # 뒷모습: 앞(화면 안쪽)으로 나간 점은 위로
            x, y = -lat, y - TILT * fwd
        elif direction == "right":
            x = fwd + 0.12 * lat
        else:
            x = -fwd - 0.12 * lat
        out.append([x, y])
    return out


def _screen(motion, direction, t):
    """프레임 하나 → (화면 좌표 18점 [키 1.0 단위], 각도 dict). 쓰러짐 회전까지 적용"""
    a = angles(motion, t)
    pts = project(skeleton(a), direction)
    if a["fall"]:
        # 쓰러짐: 발 사이를 축으로 화면에서 회전 (옆모습은 뒤로, 정면·뒷모습은 화면 왼쪽으로)
        sign = {"right": -1, "left": 1, "down": -1, "up": 1}[direction]
        r = math.radians(a["fall"]) * sign
        cx = (pts[10][0] + pts[13][0]) / 2
        cy = max(pts[10][1], pts[13][1])
        cr, sr = math.cos(r), math.sin(r)
        pts = [[cx + (x - cx) * cr - (y - cy) * sr, cy + (x - cx) * sr + (y - cy) * cr] for x, y in pts]
    return pts, a


def _mid(pts, a):
    if a["fall"]:
        xs = [p[0] for p in pts]
        return (min(xs) + max(xs)) / 2
    return (pts[8][0] + pts[11][0]) / 2


def row_scale(motion, direction, frames):
    """한 줄 전체에 같은 배율: 서 있으면 FIG_H, 누운 프레임처럼 칸보다 넓어지면 모든 프레임을 같이 줄인다
    (프레임마다 배율이 다르면 애니메이션 중에 캐릭터 크기가 바뀜)"""
    scale = FIG_H
    for t in times(motion, frames):
        pts, a = _screen(motion, direction, t)
        m = _mid(pts, a)
        half = max(abs(p[0] - m) for p in pts) + 0.04  # 머리·손 여유
        scale = min(scale, 0.46 * CELL_ASPECT / half)
    return scale


def frame_points(motion, direction, t, scale=FIG_H):
    """프레임 하나 → 칸 기준 정규화 좌표 18점 ([x, y] 0~1 | None) — 칸 비율은 CELL_ASPECT"""
    pts, a = _screen(motion, direction, t)
    low = max(p[1] for p in pts)  # 바닥선 맞추기: 몸에서 가장 낮은 점(발·무릎·엉덩이·손)을 바닥에
    mid = _mid(pts, a)
    out = []
    for i, (x, y) in enumerate(pts):
        if i in HIDDEN[direction]:
            out.append(None)
            continue
        cx = 0.5 + (x - mid) * scale / CELL_ASPECT
        cy = GROUND - (low - y) * scale - a["bob"]
        out.append([round(cx, 5), round(cy, 5)])
    return out


CELL_ASPECT = 2 / 3  # 칸 가로/세로


# ---------------------------------------------------------------------- 크기·맵
def cell_size(frames):
    """프레임 수 → 칸 크기 (가로, 세로) — 한 줄 넓이가 SDXL 1메가픽셀 근처, 8의 배수"""
    w = {4: 384, 6: 336}.get(frames)
    if w is None:
        raise SheetError(f"프레임 수는 {', '.join(map(str, FRAMES))} 중 하나여야 합니다")
    return w, int(w / CELL_ASPECT) // 8 * 8


def row_keypoints(motion, direction, frames):
    if motion not in MOTIONS:
        raise SheetError(f"알 수 없는 동작입니다: {motion}")
    if direction not in DIRECTIONS:
        raise SheetError(f"알 수 없는 방향입니다: {direction}")
    people = []
    scale = row_scale(motion, direction, frames)
    for i, t in enumerate(times(motion, frames)):
        body = [[(i + p[0]) / frames, p[1]] if p else None for p in frame_points(motion, direction, t, scale)]
        people.append({"body": body})
    return {"people": people}


SUBDIR = "spritesheet"  # input/spritesheet/ — LoadImage 입력 "spritesheet/<파일>"


# 프레임마다 따로 그리는 줄 (한 장에 한 사람): 한 장에 나란히 그리면 쓰러짐은 누운 몸들을 한 사람으로 이어 그리고,
# 뒷모습은 프레임 하나를 정면으로 그린다 (실측, 칸 사이 틈·끝 칸 덧대기로도 안 고쳐짐). 대신 생성이 프레임 수만큼 걸린다.
SEPARATE_MOTIONS = ("down",)
SEPARATE_DIRS = ("up",)
FRAME_SIZE = (768, 1152)  # 따로 그릴 때 프레임 하나의 생성 크기 (칸과 같은 2:3, 약 0.9메가픽셀) → 칸 크기로 줄임


def separate(motion, direction):
    return motion in SEPARATE_MOTIONS or direction in SEPARATE_DIRS


def _write_map(kp, W, H, style, name):
    path = poselib.INPUT_DIR / SUBDIR / name
    if not path.is_file():
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_bytes(poselib.encode_png(poselib.draw(kp, W, H, hands=False, style=style)))
        tmp.replace(path)
    return f"{SUBDIR}/{name}"


def frame_map(motion, direction, frames, i, style="standard"):
    """프레임 i 하나만 그린 포즈 맵 (FRAME_SIZE) → (LoadImage 이름, (W, H)). 배율은 줄 전체와 같다."""
    W, H = FRAME_SIZE
    body = row_keypoints(motion, direction, frames)["people"][i]["body"]
    kp = {"people": [{"body": [[p[0] * frames - i, p[1]] if p else None for p in body]}]}
    key = hashlib.sha1(json.dumps([kp, W, H, style], sort_keys=True).encode()).hexdigest()[:12]
    return _write_map(kp, W, H, style, f"{motion}_{direction}_{frames}f_{i + 1}_{style}_{key}.png"), (W, H)


def row_map(motion, direction, frames, style="standard"):
    """한 줄 포즈 맵을 input/spritesheet/에 그려 두고 LoadImage용 이름과 크기를 돌려준다.
    내용(동작·방향·프레임·선 스타일·뼈대 규칙)의 해시로 이름을 지어 같은 맵은 다시 그리지 않는다."""
    cw, ch = cell_size(frames)
    W, H = cw * frames, ch
    kp = row_keypoints(motion, direction, frames)
    key = hashlib.sha1(json.dumps([kp, W, H, style], sort_keys=True).encode()).hexdigest()[:12]
    return _write_map(kp, W, H, style, f"{motion}_{direction}_{frames}f_{style}_{key}.png"), (W, H)
