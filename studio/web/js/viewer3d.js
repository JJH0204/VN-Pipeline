// 3D 모델 뷰어 — 프롬프트 추출 탭 전용 (docs/STUDIO_SPEC.md §8.6 계약)
// three.js r167 + @pixiv/three-vrm 3.5.5 (studio/web/vendor, importmap 이름으로 import).
// 이 모듈은 3D 모드를 처음 열 때 동적 import 된다. 형식별 로더도 필요할 때만 불러온다.
//
//   const viewer = await createViewer(container, { onStatus })
//   const info = await viewer.load(files)          // File[] | FileList
//   viewer.setView('front', 'full'); const blob = await viewer.capture({ size: 1024 })
//
// 좌표 약속: 정규화 후 모델은 바닥 y=0, 가운데 x=z=0, 키 MODEL_H, 앞(얼굴)이 +Z, 모델의 왼손이 +X.
// 각도: left34/right34 = 카메라가 보는 사람 기준 왼쪽/오른쪽으로 45° 돈 위치, side = 왼쪽 90°, back = 180°.
// 계약 밖 추가: viewer.flip() → 앞뒤 180° 바꾸기(새 상태 bool), viewer.flipped, viewer.getState(), viewer.stats(),
//   viewer.info, viewer.canvas, info.frontConfident(뼈로 앞 방향을 확인했는지 — false면 [앞뒤 바꾸기]를 눈에 띄게),
//   info.fileName/fileSize/clipDurations, meta.commercialAllowed(bool|null), reset() → {view, framing}.
// 새 모델을 load하면 팔 내리기·앞뒤 바꾸기·애니메이션은 꺼진 상태로 돌아간다(각도·프레이밍·배경·밝기·뼈대 보기는 유지).
//
// 포즈(§9.8):
//   info.poseAvailable / info.handsAvailable(한 손이라도), info.handsMissing(['왼손'|'오른손'] — 손가락을 못 찾은 손, 그 손만 빼고 저장),
//   info.poseMissing([한국어 관절 이름 또는 이유] — 매핑 실패 시)
//   viewer.capture({ width, height, view, framing })   // 비정사각 캡처(기존 { size }도 그대로 — 정사각)
//   viewer.capturePose({ width, height, view, framing, hands = true })   // 크기 기본 832×1216({ size }면 정사각)
//     → { available, keypoints: {people:[{body:[[x,y]|null ×18], left_hand:[…×21]|null, right_hand}]} | null,
//         render: Blob(PNG, 흰 배경, 같은 카메라), preview: Blob(standard 맵) | null, pose(= preview),
//         missing: [맵에 없는 18점 이름], unmapped: [매핑 실패 이유], hands, width, height, view, framing, custom, faceYaw }
//     좌표는 0~1 정규화(맵 크기 기준, §9.3), 왼쪽/오른쪽은 인물 기준. 매핑 실패 모델은 keypoints/preview = null(렌더만).
//   viewer.setPoseOverlay(on) → 실제로 보이는지(bool). viewer.poseKeypointsNow(), viewer.poseDebug()(문제 확인용)
//   export drawPoseMap(keypoints, w, h, { hands, style: 'standard'|'thick' }) → canvas(§9.2, 미리보기용 — 최종 맵은 서버가 그림)
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const MODEL_EXTS = ['vrm', 'glb', 'gltf', 'fbx', 'pmx', 'pmd', 'obj']; // 같은 폴더에 여러 개면 이 순서로 고름
const WEB_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif']); // 브라우저가 직접 읽는 그림
const UNSUPPORTED_TEX_EXTS = new Set(['dds', 'psd', 'tif', 'tiff', 'exr', 'hdr', 'ktx2', 'ktx']);
const MODEL_H = 1.6; // 정규화한 키(단위 없음, 카메라 거리 계산용)
const FOV = 30; // 세로 화각(도) — 망원 쪽이라 원근 왜곡이 적다
const RES_PREFIX = 'vn3d-res://local/'; // 로더가 만드는 "상대 경로" URL의 표식(실제 요청 안 함)
const FAIL_URL = 'data:,'; // 못 찾은 파일 → 네트워크 요청 없이 바로 실패
const ARM_ANGLE = THREE.MathUtils.degToRad(12); // 팔 내리기: 수직에서 바깥으로 벌리는 각도
const ARM_FORWARD = 0.06; // 팔 내리기: 살짝 앞으로
const BIG_FILE = 200 * 1024 * 1024;
const MANY_TRIS = 2_000_000;
const MEASURE_BUDGET = 150_000; // 경계상자 계산 때 스키닝 정점 표본 수 상한
const TEXTURE_TIMEOUT = 90_000;
const EXTRA_ANIM_FILES = 8; // 같이 고른 다른 FBX에서 애니메이션을 가져올 최대 파일 수
const EXTRA_ANIM_BYTES = 40 * 1024 * 1024; // 애니메이션 전용 FBX는 보통 몇 MB — 큰 파일(다른 캐릭터)은 건너뜀

export const VIEWS = ['front', 'left34', 'right34', 'side', 'back'];
export const FRAMINGS = ['full', 'upper', 'face'];
// 카메라 방위각(도). 0 = 정면(+Z). 음수 = 보는 사람 기준 왼쪽으로 돈 위치.
const VIEW_AZIMUTH = { front: 0, left34: -45, right34: 45, side: -90, back: 180 };

const UP = new THREE.Vector3(0, 1, 0);
const Q_FLIP = new THREE.Quaternion().setFromAxisAngle(UP, Math.PI);
const TEX_KEYS = ['map', 'normalMap', 'bumpMap', 'specularMap', 'emissiveMap', 'alphaMap', 'aoMap', 'lightMap',
  'roughnessMap', 'metalnessMap', 'displacementMap', 'displacemantMap', 'matcap', 'gradientMap', 'envMap',
  'clearcoatMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap', 'sheenColorMap', 'sheenRoughnessMap',
  'transmissionMap', 'thicknessMap', 'specularColorMap', 'specularIntensityMap', 'iridescenceMap',
  'iridescenceThicknessMap', 'anisotropyMap',
  // MToon
  'shadeMultiplyTexture', 'shadingShiftTexture', 'matcapTexture', 'rimMultiplyTexture',
  'outlineWidthMultiplyTexture', 'uvAnimationMaskTexture'];

const LIGHT = { hemi: 1.9, key: 1.6, rim: 0.6 }; // 밝기 1일 때 세기(물리 단위, 톤매핑 없음)

function abortError() {
  const e = new Error('취소됨: 다른 모델을 불러오기 시작했습니다');
  e.name = 'AbortError';
  return e;
}

function safeCall(fn, ...args) {
  try { fn?.(...args); } catch (e) { console.error(e); }
}

const nextFrame = () => new Promise((r) => setTimeout(r, 16));

// ---------------------------------------------------------------- 파일 목록 / 경로 해석
function relPathOf(f) {
  const p = f.webkitRelativePath || f.relativePath || (typeof f.fullPath === 'string' ? f.fullPath : '') || f.name || '';
  return normPath(p);
}
function normPath(p) {
  const out = [];
  for (const seg of String(p).replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}
function extOf(name) {
  const b = String(name).split('/').pop();
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i + 1).toLowerCase() : '';
}
function stemOf(name) {
  const b = String(name).split('/').pop();
  const i = b.lastIndexOf('.');
  return (i > 0 ? b.slice(0, i) : b).toLowerCase();
}
function dirOf(p) {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(0, i) : '';
}
function fmtMB(n) {
  return `${(n / 1048576).toFixed(n >= 100 * 1048576 ? 0 : 1)}MB`;
}

/** 이번 불러오기에 쓰는 파일 색인 + blob URL + 누락 기록 */
class FileContext {
  constructor(files) {
    this.entries = files.map((file) => {
      const path = relPathOf(file);
      return { file, path, lower: path.toLowerCase(), base: path.split('/').pop().toLowerCase(), ext: extOf(path), stem: stemOf(path) };
    });
    this.byPath = new Map(this.entries.map((e) => [e.lower, e]));
    this.byBase = new Map();
    for (const e of this.entries) {
      if (!this.byBase.has(e.base)) this.byBase.set(e.base, []);
      this.byBase.get(e.base).push(e);
    }
    this.urls = new Map(); // File → blob URL
    this.ownUrls = new Set();
    this.foreign = new Set(); // 로더가 만든 blob URL(FBX 내장 텍스처 등) — 다 읽은 뒤 해제
    this.missing = new Map(); // 소문자 이름 → 원래 이름
    this.unsupported = new Map();
    this.substituted = new Map();
    this.modelDir = '';
    this.active = 0;
    this.done = 0;
    this.total = 0;
    this.idleWaiters = [];
    this.onProgress = null;
  }

  urlFor(file) {
    let u = this.urls.get(file);
    if (!u) {
      u = URL.createObjectURL(file);
      this.urls.set(file, u);
      this.ownUrls.add(u);
    }
    return u;
  }

  revokeAll() {
    for (const u of this.urls.values()) URL.revokeObjectURL(u);
    this.urls.clear();
    this.ownUrls.clear();
    this.revokeForeign();
  }

  revokeForeign() {
    for (const u of this.foreign) URL.revokeObjectURL(u);
    this.foreign.clear();
  }

  noteMissing(name) {
    const n = name || '(이름 없음)';
    this.missing.set(n.toLowerCase(), n);
  }

  noteUnsupported(name) {
    this.unsupported.set(name.toLowerCase(), name);
  }

  /** 경로 끝부분이 가장 많이 일치하는 후보 */
  _best(cands, wantSegs) {
    if (!cands?.length) return null;
    if (cands.length === 1) return cands[0];
    const md = this.modelDir.toLowerCase();
    let best = null;
    let bestScore = -1;
    for (const c of cands) {
      const segs = c.lower.split('/');
      let k = 0;
      while (k < segs.length && k < wantSegs.length && segs[segs.length - 1 - k] === wantSegs[wantSegs.length - 1 - k]) k++;
      const score = k * 100 + (md && c.lower.startsWith(md + '/') ? 10 : 0) - segs.length;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return best;
  }

  /**
   * 로더가 요청한 URL을 고른 파일 중 하나로 해석.
   * allow: 이름이 정확히 안 맞을 때 같은 이름(확장자만 다른) 그림으로 대체할 수 있는 확장자 집합
   * → { url, entry, substituted } | { missing: true, name }
   */
  resolve(raw, allow = WEB_IMAGE_EXTS) {
    if (typeof raw !== 'string' || !raw || raw.endsWith('/undefined') || raw === 'undefined') return { missing: true, name: '' };
    if (/^(blob:|data:)/i.test(raw)) return { url: raw };
    let p = raw.startsWith(RES_PREFIX) ? raw.slice(RES_PREFIX.length) : raw.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*\/?/i, '');
    try { p = decodeURIComponent(p); } catch { /* 그대로 */ }
    p = p.replace(/\\/g, '/');
    const name = p.split('/').pop();
    if (!name) return { missing: true, name: '' };
    const lowerSegs = normPath(p).toLowerCase().split('/');
    let entry = this.byPath.get(normPath(p).toLowerCase()) || this._best(this.byBase.get(name.toLowerCase()), lowerSegs);
    let substituted = false;
    const ext = extOf(name);
    // 같은 이름, 다른 확장자 (예: body.psd → body.png, Unity가 바꿔 둔 경우)
    if ((!entry || UNSUPPORTED_TEX_EXTS.has(entry.ext)) && (WEB_IMAGE_EXTS.has(ext) || ext === 'tga' || UNSUPPORTED_TEX_EXTS.has(ext))) {
      const stem = stemOf(name);
      const cands = this.entries.filter((e) => e.stem === stem && allow.has(e.ext));
      const alt = this._best(cands, lowerSegs);
      if (alt) {
        entry = alt;
        substituted = true;
        this.substituted.set(name.toLowerCase(), `${name} → ${alt.path.split('/').pop()}`);
      }
    }
    if (!entry) return { missing: true, name };
    if (UNSUPPORTED_TEX_EXTS.has(entry.ext)) return { missing: true, unsupported: true, name };
    return { url: this.urlFor(entry.file), entry, substituted };
  }

  // LoadingManager에 걸어 둘 URL 변환기
  modify(url) {
    if (typeof url === 'string' && url.startsWith('blob:') && !this.ownUrls.has(url)) this.foreign.add(url);
    const r = this.resolve(url);
    if (r.url) return r.url;
    if (r.unsupported) this.noteUnsupported(r.name);
    else this.noteMissing(r.name);
    return FAIL_URL;
  }

  find(name) {
    const r = this.resolve(RES_PREFIX + (this.modelDir ? this.modelDir + '/' : '') + name, new Set());
    return r.entry || null;
  }

  itemStarted() {
    this.active++;
    this.total++;
  }

  itemEnded() {
    this.active = Math.max(0, this.active - 1);
    this.done++;
    safeCall(this.onProgress, this.done, this.total);
    if (this.active === 0) {
      const w = this.idleWaiters.splice(0);
      w.forEach((fn) => fn(true));
    }
  }

  /** 시작된 텍스처/부속 파일 로딩이 모두 끝날 때까지 (false = 시간 초과) */
  async waitIdle(ms = TEXTURE_TIMEOUT) {
    await nextFrame();
    if (this.active === 0) return true;
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), ms);
      this.idleWaiters.push((v) => { clearTimeout(t); resolve(v); });
    });
  }
}

function makeManager(ctx) {
  const manager = new THREE.LoadingManager();
  const start = manager.itemStart;
  const end = manager.itemEnd;
  manager.itemStart = (url) => { ctx.itemStarted(); start.call(manager, url); };
  manager.itemEnd = (url) => { end.call(manager, url); ctx.itemEnded(); };
  manager.setURLModifier((url) => ctx.modify(url));
  return manager;
}

/** 확장자로 로더를 고르는 FBX/MTL/MMD용 처리기: TGA와 미지원 형식(대체 그림이 있으면 그걸로) */
async function installHandlers(manager, ctx) {
  const { TGALoader } = await import('three/addons/loaders/TGALoader.js');
  const tga = new TGALoader(manager);
  const tex = new THREE.TextureLoader(manager);
  class RoutedLoader extends THREE.Loader {
    constructor(kind) { super(manager); this.kind = kind; }
    load(url, onLoad, onProgress, onError) {
      const full = (this.path && !/^(blob:|data:)/i.test(url) ? this.path : '') + url;
      const allow = new Set([...WEB_IMAGE_EXTS, 'tga']);
      const r = ctx.resolve(full, allow);
      if (!r.url) {
        if (r.unsupported || this.kind === 'unsupported') ctx.noteUnsupported(r.name || url.split(/[\\/]/).pop());
        else ctx.noteMissing(r.name);
        const t = new THREE.Texture();
        if (onError) setTimeout(() => safeCall(onError, new Error('missing')), 0);
        return t;
      }
      const isTga = r.entry ? r.entry.ext === 'tga' : this.kind === 'tga';
      if (isTga) return tga.load(r.url, onLoad, onProgress, onError);
      if (!r.entry && this.kind === 'unsupported') {
        // 내장(blob) 미지원 형식
        ctx.noteUnsupported(url.split(/[\\/]/).pop());
        return new THREE.Texture();
      }
      return tex.load(r.url, onLoad, onProgress, onError);
    }
  }
  manager.addHandler(/\.tga$/i, new RoutedLoader('tga'));
  manager.addHandler(/\.(dds|psd|tiff?|exr|hdr|ktx2?)$/i, new RoutedLoader('unsupported'));
}

function readFile(file, as, onProgress) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onprogress = (e) => { if (e.lengthComputable) safeCall(onProgress, e.loaded / e.total); };
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error(`파일을 읽지 못했습니다: ${file.name}`));
    if (as === 'text') r.readAsText(file);
    else r.readAsArrayBuffer(file);
  });
}

// ---------------------------------------------------------------- 뼈 이름 규칙
function nameTokens(name) {
  let s = String(name || '').replace(/^.*[:|]/, '');
  s = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return s.toLowerCase().split(/[^a-z0-9぀-ヿ㐀-鿿]+/).filter(Boolean);
}
const BAD_ARM = ['fore', 'forearm', 'lower', 'lowerarm', 'twist', 'roll', 'ik', 'hand', 'elbow', 'end', 'pole', 'target',
  'mch', 'org', 'tweak', 'ctrl', 'control', 'socket', 'share', 'parent', 'nub', 'tip', 'helper', 'corrective'];
function sideOf(raw, t) {
  if (raw.includes('左')) return 'left';
  if (raw.includes('右')) return 'right';
  if (t.includes('left') || t.includes('l')) return 'left';
  if (t.includes('right') || t.includes('r')) return 'right';
  return null;
}
function upperArmScore(raw, t) {
  if (/^[左右]腕$/.test(raw)) return 3;
  if (t.some((x) => BAD_ARM.includes(x))) return 0;
  if (t.includes('shldr')) return 3; // Daz: lShldrBend
  if (t.includes('upperarm') || t.includes('uparm') || (t.includes('upper') && t.includes('arm'))) return 3;
  if (t.includes('arm')) return 2; // mixamorig:LeftArm, Arm_L
  return 0;
}
function lowerArmScore(raw, t) {
  if (/^[左右](ひじ|肘)$/.test(raw)) return 3;
  if (t.includes('twist') || t.includes('roll') || t.includes('ik')) return 0;
  if (t.includes('forearm') || t.includes('lowerarm') || t.includes('elbow')) return 3;
  if (t.includes('arm') && (t.includes('fore') || t.includes('lower'))) return 3;
  return 0;
}
function upperLegScore(raw, t) {
  if (/^[左右]足$/.test(raw)) return 3;
  if (t.some((x) => ['twist', 'ik', 'end', 'roll', 'pole', 'target', 'mch', 'org', 'tweak'].includes(x))) return 0;
  if (t.includes('upleg') || t.includes('upperleg') || t.includes('thigh')) return 3;
  if (t.includes('leg') && (t.includes('up') || t.includes('upper'))) return 3;
  return 0;
}
function headScore(raw, t) {
  if (raw === '頭') return 3;
  if (!t.includes('head')) return 0;
  if (t.some((x) => ['top', 'end', 'nub', 'tip', 'eye', 'neck', 'mesh', 'jaw', 'ik', 'target', 'mch', 'org'].includes(x))) return 0;
  return 3;
}
function hipsScore(raw, t) {
  if (raw === '下半身') return 3;
  if (raw === 'センター') return 1;
  if (sideOf(raw, t)) return 0;
  if (t.includes('hips') || t.includes('pelvis')) return 3;
  if (t.includes('hip')) return 2;
  return 0;
}

function findBonesByName(model) {
  const skel = new Set();
  model.traverse((o) => { if (o.isSkinnedMesh && o.skeleton) o.skeleton.bones.forEach((b) => skel.add(b)); });
  const nodes = [];
  model.traverse((o) => {
    if (o === model || o.isMesh || o.isLight || o.isCamera || !o.name) return;
    let depth = 0;
    for (let p = o.parent; p && p !== model; p = p.parent) depth++;
    nodes.push({ o, raw: o.name, t: nameTokens(o.name), depth, skel: skel.has(o) ? 1 : 0 });
  });
  const pick = (list, scoreFn, side) => {
    let best = null;
    let bk = null;
    for (const n of list) {
      const s = scoreFn(n.raw, n.t);
      if (!s) continue;
      if (side !== undefined && sideOf(n.raw, n.t) !== side) continue;
      const k = [s, n.skel, -n.depth];
      if (!bk || k[0] > bk[0] || (k[0] === bk[0] && (k[1] > bk[1] || (k[1] === bk[1] && k[2] > bk[2])))) { best = n.o; bk = k; }
    }
    return best;
  };
  const lowerOf = (upper) => {
    if (!upper) return null;
    const desc = [];
    upper.traverse((o) => {
      if (o === upper || o.isMesh) return;
      let depth = 0;
      for (let p = o.parent; p && p !== upper; p = p.parent) depth++;
      desc.push({ o, raw: o.name || '', t: nameTokens(o.name), depth, skel: skel.has(o) ? 1 : 0 });
    });
    const byName = pick(desc, lowerArmScore);
    if (byName) return byName;
    // 이름으로 못 찾으면 자손이 가장 많은 자식(팔 사슬)
    let best = null;
    let most = -1;
    for (const c of upper.children) {
      if (c.isMesh) continue;
      let n = 0;
      c.traverse(() => { n++; });
      if (n > most) { most = n; best = c; }
    }
    return best;
  };
  const leftUpper = pick(nodes, upperArmScore, 'left');
  const rightUpper = pick(nodes, upperArmScore, 'right');
  return {
    head: pick(nodes, headScore),
    hips: pick(nodes, hipsScore),
    leftUpper,
    rightUpper,
    leftLower: lowerOf(leftUpper),
    rightLower: lowerOf(rightUpper),
    leftLeg: pick(nodes, upperLegScore, 'left'),
    rightLeg: pick(nodes, upperLegScore, 'right'),
  };
}

function findBonesVRM(vrm) {
  const g = (n) => vrm.humanoid?.getRawBoneNode(n) || null;
  return {
    head: g('head'), hips: g('hips'),
    leftUpper: g('leftUpperArm'), rightUpper: g('rightUpperArm'),
    leftLower: g('leftLowerArm'), rightLower: g('rightLowerArm'),
    leftLeg: g('leftUpperLeg'), rightLeg: g('rightUpperLeg'),
  };
}

const wpos = (o) => o.getWorldPosition(new THREE.Vector3());

// ---------------------------------------------------------------- 포즈(OpenPose) — §9.2/§9.3/§9.8
// 18점 순서·선·색은 vnlib.pose.draw와 같다. 오른쪽/왼쪽은 인물 기준.
export const POSE_POINT_NAMES = ['코', '목', '오른어깨', '오른팔꿈치', '오른손목', '왼어깨', '왼팔꿈치', '왼손목',
  '오른엉덩이', '오른무릎', '오른발목', '왼엉덩이', '왼무릎', '왼발목', '오른눈', '왼눈', '오른귀', '왼귀'];
export const POSE_LIMBS = [[2, 3], [2, 6], [3, 4], [4, 5], [6, 7], [7, 8], [2, 9], [9, 10], [10, 11], [2, 12], [12, 13],
  [13, 14], [2, 1], [1, 15], [15, 17], [1, 16], [16, 18]]; // 1부터 셈
export const POSE_COLORS = [[255, 0, 0], [255, 85, 0], [255, 170, 0], [255, 255, 0], [170, 255, 0], [85, 255, 0], [0, 255, 0],
  [0, 255, 85], [0, 255, 170], [0, 255, 255], [0, 170, 255], [0, 85, 255], [0, 0, 255], [85, 0, 255], [170, 0, 255],
  [255, 0, 255], [255, 0, 170], [255, 0, 85]];
export const HAND_EDGES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [0, 9], [9, 10], [10, 11], [11, 12],
  [0, 13], [13, 14], [14, 15], [15, 16], [0, 17], [17, 18], [18, 19], [19, 20]];
const HAND_POINT_COLOR = [0, 0, 255];
const FINGERS = ['thumb', 'index', 'middle', 'ring', 'little']; // 손 21점: 0 손목, 1~4 엄지, 5~8 검지, 9~12 중지, 13~16 약지, 17~20 새끼
const FINGER_RAW = { thumb: ['親指'], index: ['人指', '人差'], middle: ['中指'], ring: ['薬指'], little: ['小指'] };
const FINGER_TOK = { thumb: ['thumb'], index: ['index', 'pointer'], middle: ['middle'], ring: ['ring'], little: ['little', 'pinky', 'pinkie'] };
const BAD_FINGER = ['ik', 'ctrl', 'control', 'target', 'pole', 'mch', 'org', 'tweak', 'helper', 'twist', 'share', 'roll', 'corrective'];
const TIP_EXT = 0.85; // 손가락 끝 뼈가 없을 때 마지막 마디 길이의 몇 배만큼 연장할지
// 몸통 관절(포즈에 꼭 필요) — 이름은 화면 안내용
const POSE_JOINTS = {
  head: '머리', leftUpperArm: '왼어깨(위팔)', leftLowerArm: '왼팔꿈치(아래팔)', leftHand: '왼손목(손)',
  rightUpperArm: '오른어깨(위팔)', rightLowerArm: '오른팔꿈치(아래팔)', rightHand: '오른손목(손)',
  leftUpperLeg: '왼엉덩이(허벅지)', leftLowerLeg: '왼무릎(종아리)', leftFoot: '왼발목(발)',
  rightUpperLeg: '오른엉덩이(허벅지)', rightLowerLeg: '오른무릎(종아리)', rightFoot: '오른발목(발)',
};

function handScore(raw, t) {
  if (/^[左右]手首$/.test(raw)) return 3;
  if (fingerKind(raw, t)) return 0;
  if (t.some((x) => ['twist', 'roll', 'ik', 'end', 'nub', 'tip', 'ctrl', 'control', 'target', 'pole', 'mch', 'org', 'tweak', 'helper', 'socket', 'handle', 'weapon', 'prop', 'attach'].includes(x))) return 0;
  if (t.includes('hand') || t.includes('wrist')) return 3;
  return 0;
}
function lowerLegScore(raw, t) {
  if (/^[左右](ひざ|膝)$/.test(raw)) return 3;
  if (t.some((x) => ['twist', 'ik', 'end', 'roll', 'pole', 'target', 'mch', 'org', 'tweak', 'nub', 'ctrl', 'foot', 'toe'].includes(x))) return 0;
  if (t.includes('calf') || t.includes('shin') || t.includes('knee') || t.includes('lowerleg') || t.includes('loleg')) return 3;
  if (t.includes('leg') && (t.includes('lower') || t.includes('low'))) return 3;
  if (t.includes('leg') && !t.includes('up') && !t.includes('upper')) return 2; // mixamorig:LeftLeg
  return 0;
}
function footScore(raw, t) {
  if (/^[左右]足首$/.test(raw)) return 3;
  if (t.some((x) => ['twist', 'ik', 'end', 'roll', 'pole', 'target', 'mch', 'org', 'tweak', 'nub', 'ctrl', 'toe', 'toes', 'ball', 'heel', 'tip'].includes(x))) return 0;
  if (t.includes('foot') || t.includes('ankle')) return 3;
  return 0;
}
function neckScore(raw, t) {
  if (raw === '首') return 3;
  if (t.some((x) => ['twist', 'end', 'nub', 'ik', 'ctrl', 'target', 'mch', 'org', 'tweak'].includes(x))) return 0;
  return t.some((x) => /^neck\d*$/.test(x)) ? 3 : 0;
}
function eyeScore(raw, t) {
  if (/^[左右]目$/.test(raw)) return 3;
  if (t.some((x) => ['brow', 'eyebrow', 'lid', 'eyelid', 'lash', 'highlight', 'hi', 'end', 'nub', 'target', 'look', 'lookat', 'ctrl', 'control', 'aim', 'mch', 'org'].includes(x))) return 0;
  return t.includes('eye') ? 3 : 0;
}
function headTopScore(raw, t) {
  if (raw === '頭先') return 3;
  return t.includes('head') && (t.includes('top') || t.includes('end') || t.includes('nub')) ? 3 : 0;
}
function fingerKind(raw, t) {
  for (const k of FINGERS) if (FINGER_RAW[k].some((r) => raw.includes(r))) return k;
  for (const x of t) {
    const b = x.replace(/\d+$/, '');
    for (const k of FINGERS) if (FINGER_TOK[k].includes(b)) return k;
  }
  return null;
}
const isEndName = (o) => {
  const raw = o.name || '';
  if (raw.includes('先')) return true;
  return nameTokens(raw).some((x) => ['end', 'nub', 'tip', 'top'].includes(x)) || /end$/i.test(raw);
};
const boneKids = (o) => o.children.filter((c) => !c.isMesh && !c.isLight && !c.isCamera);
const isDesc = (o, anc) => { for (let p = o?.parent; p; p = p.parent) if (p === anc) return true; return false; };

/** 손 아래에서 손가락 하나의 사슬 → { joints: [뼈…], tip: 뼈|null } | null */
function findFingerByName(hand, kind) {
  const cand = [];
  hand.traverse((o) => {
    if (o === hand || o.isMesh || !o.name) return;
    const t = nameTokens(o.name);
    if (fingerKind(o.name, t) !== kind || t.some((x) => BAD_FINGER.includes(x))) return;
    if (kind !== 'thumb' && t.some((x) => x.startsWith('metacarpal') || x === 'meta' || x === 'carpal')) return; // 손바닥 안 뼈(UE5 index_metacarpal_l 등)
    cand.push(o);
  });
  if (!cand.length) return null;
  const depth = (o) => { let d = 0; for (let p = o; p && p !== hand; p = p.parent) d++; return d; };
  const chain = [cand.reduce((a, b) => (depth(b) < depth(a) ? b : a))];
  for (;;) {
    const last = chain[chain.length - 1];
    // FBXLoader는 뼈마다 같은 이름의 자식 뼈를 하나 더 만들기도 한다(Samba 등) → 이름이 같은 자식은 건너뜀
    const next = cand.filter((c) => isDesc(c, last) && c.name !== last.name);
    if (!next.length) break;
    chain.push(next.reduce((a, b) => (depth(b) < depth(a) ? b : a)));
  }
  let tip = null;
  const kidsOf = (o) => boneKids(o).filter((c) => c.name !== o.name);
  // 끝 뼈(…_end, Blender가 붙인 잎 뼈 …_end_end·先_end 등)는 모두 떼고 가장 안쪽 것을 끝점으로
  while (chain.length >= 2 && isEndName(chain[chain.length - 1])) tip = chain.pop();
  const last = chain[chain.length - 1];
  if (chain.length >= 4 && kidsOf(last).every(isEndName)) tip = chain.pop(); // Mixamo식 4번째 = 끝점 뼈(잎 뼈가 붙어 있어도)
  else if (!tip) {
    const kids = kidsOf(last);
    if (kids.length === 1 && !kidsOf(kids[0]).length) tip = kids[0]; // 끝 표시용 잎 뼈(…_end, 先 등)
  }
  const joints = chain.slice(-3);
  return joints.length ? { joints, tip } : null;
}

function findPoseJointsVRM(vrm) {
  const g = (n) => vrm.humanoid?.getRawBoneNode(n) || null;
  const j = { head: g('head'), neck: g('neck'), leftEye: g('leftEye'), rightEye: g('rightEye'), headTop: null, fingers: {} };
  for (const s of ['left', 'right']) {
    for (const part of ['UpperArm', 'LowerArm', 'Hand', 'UpperLeg', 'LowerLeg', 'Foot']) j[s + part] = g(s + part);
    const names = {
      thumb: ['ThumbMetacarpal', 'ThumbProximal', 'ThumbDistal'],
      index: ['IndexProximal', 'IndexIntermediate', 'IndexDistal'],
      middle: ['MiddleProximal', 'MiddleIntermediate', 'MiddleDistal'],
      ring: ['RingProximal', 'RingIntermediate', 'RingDistal'],
      little: ['LittleProximal', 'LittleIntermediate', 'LittleDistal'],
    };
    const f = {};
    for (const k of FINGERS) {
      const joints = names[k].map((n) => g(s + n)).filter(Boolean);
      if (!joints.length) { f[k] = null; continue; }
      const kids = boneKids(joints[joints.length - 1]);
      f[k] = { joints, tip: kids.length === 1 && !boneKids(kids[0]).length ? kids[0] : null };
    }
    j.fingers[s] = f;
  }
  return j;
}

function findPoseJointsByName(model, bones) {
  const skel = new Set();
  model.traverse((o) => { if (o.isSkinnedMesh && o.skeleton) o.skeleton.bones.forEach((b) => skel.add(b)); });
  const descOf = (root) => {
    const out = [];
    if (!root) return out;
    root.traverse((o) => {
      if (o === root || o.isMesh || !o.name) return;
      let depth = 0;
      for (let p = o.parent; p && p !== root; p = p.parent) depth++;
      out.push({ o, raw: o.name, t: nameTokens(o.name), depth, skel: skel.has(o) ? 1 : 0 });
    });
    return out;
  };
  const pickIn = (list, scoreFn, side) => {
    let best = null;
    let bk = null;
    for (const n of list) {
      const s = scoreFn(n.raw, n.t);
      if (!s) continue;
      if (side && sideOf(n.raw, n.t) !== side) continue;
      const k = [s, n.skel, -n.depth];
      if (!bk || k[0] > bk[0] || (k[0] === bk[0] && (k[1] > bk[1] || (k[1] === bk[1] && k[2] > bk[2])))) { best = n.o; bk = k; }
    }
    return best;
  };
  const j = { head: bones.head || null, fingers: {} };
  j.leftUpperArm = bones.leftUpper || null;
  j.rightUpperArm = bones.rightUpper || null;
  j.leftLowerArm = bones.leftLower || null;
  j.rightLowerArm = bones.rightLower || null;
  j.leftUpperLeg = bones.leftLeg || null;
  j.rightUpperLeg = bones.rightLeg || null;
  for (const s of ['left', 'right']) {
    j[s + 'Hand'] = pickIn(descOf(j[s + 'LowerArm']), handScore);
    j[s + 'LowerLeg'] = pickIn(descOf(j[s + 'UpperLeg']), lowerLegScore);
    j[s + 'Foot'] = pickIn(descOf(j[s + 'LowerLeg']), footScore);
    const f = {};
    for (const k of FINGERS) f[k] = j[s + 'Hand'] ? findFingerByName(j[s + 'Hand'], k) : null;
    j.fingers[s] = f;
  }
  j.neck = null;
  for (let p = j.head?.parent; p && p !== model; p = p.parent) {
    if (neckScore(p.name || '', nameTokens(p.name))) { j.neck = p; break; }
  }
  const headDesc = descOf(j.head);
  j.leftEye = pickIn(headDesc, eyeScore, 'left');
  j.rightEye = pickIn(headDesc, eyeScore, 'right');
  j.headTop = pickIn(headDesc, headTopScore);
  return j;
}

/** 머리 뼈가 주로 움직이는 정점(월드, 휴식 자세) — 얼굴 점 추정용. 머리카락 뼈 등 자식 뼈의 정점은 뺀다 */
function collectHeadVerts(model, head, limit = 20000) {
  const out = [];
  if (!head) return out;
  const v = new THREE.Vector3();
  model.traverseVisible((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    const g = o.geometry;
    const pos = g.attributes.position;
    const idx = [];
    if (o.isSkinnedMesh) {
      const si = g.attributes.skinIndex;
      const sw = g.attributes.skinWeight;
      const bones = o.skeleton?.bones;
      if (!si || !sw || !bones) return;
      const hit = bones.map((b) => b === head || (!!b && b.name === head.name));
      if (!hit.some(Boolean)) return;
      for (let i = 0; i < pos.count; i++) {
        let bw = -1;
        let bi = 0;
        for (let k = 0; k < 4; k++) {
          const w = sw.getComponent(i, k);
          if (w > bw) { bw = w; bi = si.getComponent(i, k); }
        }
        if (hit[bi]) idx.push(i);
      }
    } else if (isDesc(o, head)) {
      for (let i = 0; i < pos.count; i++) idx.push(i);
    }
    if (!idx.length) return;
    const step = Math.max(1, Math.ceil(idx.length / limit));
    for (let n = 0; n < idx.length; n += step) {
      o.getVertexPosition(idx[n], v);
      v.applyMatrix4(o.matrixWorld);
      if (Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)) out.push(v.clone());
    }
  });
  return out;
}

/**
 * 관절 매핑을 검사하고 포즈 계산용 리그를 만든다(load 직후 휴식 자세에서 — 모델 앞 +Z, 왼쪽 +X).
 * → { ok, missing:[이름], body:{…뼈}, hands:{left,right}|null, face:{local…}, handsOk }
 */
function buildPoseRig(model, j) {
  const missing = [];
  for (const [k, label] of Object.entries(POSE_JOINTS)) if (!j[k]) missing.push(label);
  const rig = { ok: false, missing, j, hands: { left: null, right: null }, handsOk: false, face: null };
  if (missing.length === Object.keys(POSE_JOINTS).length) missing.splice(0, missing.length, '뼈대(관절)가 없는 모델');
  if (missing.length) return rig;
  const P = {};
  for (const k of Object.keys(POSE_JOINTS)) P[k] = wpos(j[k]);
  const H = MODEL_H;
  const bad = (msg) => { missing.push(msg); return rig; };
  // 서로 다른 뼈 + 사슬(위팔 → 아래팔 → 손, 허벅지 → 종아리 → 발)
  const list = Object.keys(POSE_JOINTS).map((k) => j[k]);
  if (new Set(list).size !== list.length) return bad('관절 뼈가 겹침');
  for (const s of ['left', 'right']) {
    const side = s === 'left' ? '왼' : '오른';
    if (!isDesc(j[s + 'LowerArm'], j[s + 'UpperArm']) || !isDesc(j[s + 'Hand'], j[s + 'LowerArm'])) return bad(`${side}팔 뼈 연결`);
    if (!isDesc(j[s + 'LowerLeg'], j[s + 'UpperLeg']) || !isDesc(j[s + 'Foot'], j[s + 'LowerLeg'])) return bad(`${side}다리 뼈 연결`);
    const a1 = P[s + 'UpperArm'].distanceTo(P[s + 'LowerArm']);
    const a2 = P[s + 'LowerArm'].distanceTo(P[s + 'Hand']);
    const l1 = P[s + 'UpperLeg'].distanceTo(P[s + 'LowerLeg']);
    const l2 = P[s + 'LowerLeg'].distanceTo(P[s + 'Foot']);
    if (Math.min(a1, a2, l1, l2) < 0.01 * H) return bad(`${side}팔·다리 마디 길이`);
    if (a1 / a2 > 2.5 || a2 / a1 > 2.5) return bad(`${side}팔꿈치 위치`);
    if (l1 / l2 > 2.5 || l2 / l1 > 2.5) return bad(`${side}무릎 위치`);
  }
  // 좌우(왼쪽 = +X)와 위아래
  if (P.leftUpperLeg.x <= P.rightUpperLeg.x) return bad('다리 좌우');
  const shoulderY = (P.leftUpperArm.y + P.rightUpperArm.y) / 2;
  const hipY = (P.leftUpperLeg.y + P.rightUpperLeg.y) / 2;
  const ankleY = (P.leftFoot.y + P.rightFoot.y) / 2;
  if (!(P.head.y > hipY && shoulderY > hipY && hipY > ankleY)) return bad('몸 위아래 방향');

  // 손가락
  for (const s of ['left', 'right']) {
    const fs = j.fingers?.[s] || {};
    const wrist = P[s + 'Hand'];
    const out = {};
    let others = 0;
    for (const k of FINGERS) {
      const f = fs[k];
      if (!f || f.joints.length < 2) { out[k] = null; continue; }
      const jp = f.joints.map(wpos);
      const seg = jp[jp.length - 1].distanceTo(jp[jp.length - 2]);
      if (seg < 1e-6 || jp[0].distanceTo(wrist) > 0.25 * H) { out[k] = null; continue; }
      let tip = f.tip;
      if (tip) {
        const d = wpos(tip).distanceTo(jp[jp.length - 1]);
        if (d < 0.25 * seg || d > 3 * seg) tip = null;
      }
      out[k] = { joints: f.joints, tip };
      if (k !== 'thumb') others++;
    }
    rig.hands[s] = out.thumb && others >= 3 ? out : null;
  }
  rig.handsOk = !!(rig.hands.left || rig.hands.right); // 손마다 따로 — 찾은 손만 넣는다(겹쳐 보기와 같게)

  // 얼굴 점: 휴식 자세(앞 +Z, 위 +Y, 왼쪽 +X)에서 월드 위치를 정하고 머리 뼈 기준 좌표로 저장 → 머리를 돌려도 따라간다
  const Hd = P.head;
  const verts = collectHeadVerts(model, j.head);
  let hs = null; // 머리 뼈 ~ 정수리 높이
  if (j.headTop) { const d = wpos(j.headTop).y - Hd.y; if (d > 0.02 * H) hs = d; }
  if (hs == null && verts.length > 30) { let m = -Infinity; for (const p of verts) m = Math.max(m, p.y); if (m - Hd.y > 0.02 * H) hs = m - Hd.y; }
  if (hs == null && j.neck) hs = 2.2 * wpos(j.neck).distanceTo(Hd);
  if (!(hs > 0)) hs = Math.max(0.12 * H, 0.9 * (Hd.y - shoulderY));
  hs = THREE.MathUtils.clamp(hs, 0.04 * H, 0.45 * H);
  const band = (y0, y1) => verts.filter((p) => p.y >= y0 && p.y <= y1);
  // 눈
  let eyeL = null;
  let eyeR = null;
  if (j.leftEye && j.rightEye && j.leftEye !== j.rightEye) {
    let a = wpos(j.leftEye);
    let b = wpos(j.rightEye);
    if (a.x < b.x) [a, b] = [b, a]; // 왼쪽 = +X
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const sep = a.distanceTo(b);
    if (sep > 0.08 * hs && sep < 1.2 * hs && mid.distanceTo(Hd) < 1.5 * hs && mid.y > Hd.y - 0.3 * hs && mid.z > Hd.z - 0.3 * hs) { eyeL = a; eyeR = b; }
  }
  const eyesFromBones = !!eyeL;
  const eyeY0 = eyeL ? (eyeL.y + eyeR.y) / 2 : Hd.y + 0.45 * hs; // 머리 뼈(두개골 아래) ~ 정수리의 약 45%
  const face = band(Hd.y + 0.05 * hs, Hd.y + 0.8 * hs);
  let frontZ = Hd.z + 0.55 * hs;
  if (face.length > 30) { let m = -Infinity; for (const p of face) m = Math.max(m, p.z); frontZ = THREE.MathUtils.clamp(m, Hd.z + 0.25 * hs, Hd.z + 1.0 * hs); }
  // 눈 높이 둘레의 머리 폭(귀 위치)
  const ring = band(eyeY0 - 0.25 * hs, eyeY0 + 0.1 * hs);
  let halfW = null;
  let earZ = null;
  if (ring.length > 30) {
    let mx = 0;
    for (const p of ring) mx = Math.max(mx, Math.abs(p.x - Hd.x));
    const side = ring.filter((p) => Math.abs(p.x - Hd.x) > 0.85 * mx);
    if (mx > 0.05 * hs) { halfW = mx; earZ = side.reduce((a, p) => a + p.z, 0) / Math.max(1, side.length); }
  }
  // 얼굴 앞쪽 절반만의 폭(뒤로 늘어진 머리카락·트윈테일 제외)
  let faceHalfW = null;
  {
    const zc = Hd.z + 0.5 * (frontZ - Hd.z);
    const fr = ring.filter((p) => p.z >= zc);
    if (fr.length > 20) {
      let mx = 0;
      for (const p of fr) mx = Math.max(mx, Math.abs(p.x - Hd.x));
      if (mx > 0.05 * hs) faceHalfW = mx;
    }
  }
  if (!eyeL) {
    // 머리 메시 폭은 머리카락 때문에 부풀 수 있어 상한으로만 쓴다
    const sep = Math.min(0.36 * hs, faceHalfW ? 0.88 * faceHalfW : halfW ? 0.84 * halfW : Infinity);
    const ez = Hd.z + 0.8 * (frontZ - Hd.z);
    eyeL = new THREE.Vector3(Hd.x + sep / 2, eyeY0, ez);
    eyeR = new THREE.Vector3(Hd.x - sep / 2, eyeY0, ez);
  } else {
    // 눈 뼈는 안구 중심(얼굴 안쪽)이라 그림에서 보이는 눈(특히 큰 애니메이션 눈)보다 안쪽·가운데에 있다.
    // 높이는 뼈 그대로, 앞뒤는 얼굴 표면 쪽으로, 간격은 머리 폭 기준으로 넓힌다(뼈 간격의 1~2배) — DWPose가 그림에서 찍는 자리와 맞춤.
    const mid = eyeL.clone().add(eyeR).multiplyScalar(0.5);
    const sepB = eyeL.distanceTo(eyeR);
    const sep = faceHalfW ? THREE.MathUtils.clamp(0.8 * faceHalfW, 1.2 * sepB, 2 * sepB) : 1.5 * sepB;
    const ez = Math.max(mid.z, Hd.z + 0.8 * (frontZ - Hd.z));
    eyeL = new THREE.Vector3(mid.x + sep / 2, mid.y, ez);
    eyeR = new THREE.Vector3(mid.x - sep / 2, mid.y, ez);
  }
  const eyeMid = eyeL.clone().add(eyeR).multiplyScalar(0.5);
  const sep = eyeL.distanceTo(eyeR);
  const nose = new THREE.Vector3(eyeMid.x, eyeMid.y - 0.35 * sep, THREE.MathUtils.clamp(frontZ - 0.15 * sep, eyeMid.z + 0.15 * sep, eyeMid.z + 0.5 * sep));
  const earX = halfW ? THREE.MathUtils.clamp(0.92 * halfW, 0.75 * sep, 1.15 * sep) : 1.05 * sep;
  const ez = earZ != null ? THREE.MathUtils.clamp(earZ, eyeMid.z - 1.0 * sep, eyeMid.z - 0.5 * sep) : eyeMid.z - 0.8 * sep;
  const earY = eyeMid.y - (eyesFromBones ? 0.2 : 0.5) * sep; // 눈 뼈가 있는 모델(VRoid·MMD 등 애니메이션풍)은 귀가 눈 높이에 가깝게 찍힌다(DWPose 실측)
  const earL = new THREE.Vector3(eyeMid.x + earX, earY, ez);
  const earR = new THREE.Vector3(eyeMid.x - earX, earY, ez);
  const loc = (v) => j.head.worldToLocal(v.clone());
  rig.face = {
    nose: loc(nose), leftEye: loc(eyeL), rightEye: loc(eyeR), leftEar: loc(earL), rightEar: loc(earR),
    origin: loc(Hd), F: loc(Hd.clone().add(new THREE.Vector3(0, 0, hs))), U: loc(Hd.clone().add(new THREE.Vector3(0, hs, 0))),
    L: loc(Hd.clone().add(new THREE.Vector3(hs, 0, 0))), eyeBones: eyesFromBones,
    dbg: { hs, halfW, faceHalfW, frontZ: frontZ - Hd.z, sepBones: j.leftEye && j.rightEye ? wpos(j.leftEye).distanceTo(wpos(j.rightEye)) : null, sep },
  };
  rig.ok = true;
  return rig;
}

/** 손가락 하나의 4점(월드) */
function fingerWorld(f, wrist, thumb) {
  const P = f.joints.map(wpos);
  const tip = f.tip ? wpos(f.tip) : null;
  const ext = (a, b, k = TIP_EXT) => b.clone().add(b.clone().sub(a).multiplyScalar(k));
  if (P.length >= 3) {
    const [a, b, c] = P.slice(-3);
    return [a, b, c, tip || ext(b, c)];
  }
  const [a, b] = P;
  if (thumb) return [wrist.clone().lerp(a, 0.5), a, b, tip || ext(a, b)];
  if (tip) return [a, b, b.clone().lerp(tip, 0.5), tip];
  const c = ext(a, b, 0.8);
  return [a, b, c, ext(b, c)];
}

/** 리그의 3D 점(월드)과 얼굴 방향 → 카메라로 투영해 §9.3 형식 키포인트 */
function poseKeypoints(rig, cam, { hands = true } = {}) {
  const j = rig.j;
  const W = (o) => wpos(o);
  cam.updateMatrixWorld(true);
  const viewP = new THREE.Vector3();
  const proj = (v) => {
    if (!v) return null;
    viewP.copy(v).applyMatrix4(cam.matrixWorldInverse);
    if (viewP.z > -1e-6) return null; // 카메라 뒤
    const p = v.clone().project(cam);
    return [(p.x + 1) / 2, (1 - p.y) / 2];
  };
  const on = (q) => (q && q[0] >= 0 && q[0] <= 1 && q[1] >= 0 && q[1] <= 1 ? q : null);
  const r5 = (q) => (q ? [Math.round(q[0] * 1e5) / 1e5, Math.round(q[1] * 1e5) / 1e5] : null);

  // 얼굴 방향으로 보이는 얼굴 점 고르기
  const head = j.head;
  const Hw = W(head);
  const toW = (lp) => head.localToWorld(lp.clone());
  const o = toW(rig.face.origin);
  const F = toW(rig.face.F).sub(o).normalize();
  const U = toW(rig.face.U).sub(o).normalize();
  const L = toW(rig.face.L).sub(o).normalize();
  const toCam = cam.position.clone().sub(Hw);
  toCam.addScaledVector(U, -toCam.dot(U));
  let yaw = 0;
  if (toCam.lengthSq() > 1e-12) yaw = THREE.MathUtils.radToDeg(Math.atan2(toCam.dot(L), toCam.dot(F)));
  const a = Math.abs(yaw);
  const near = yaw >= 0 ? 'left' : 'right'; // 카메라가 인물의 왼쪽에 있으면 왼쪽이 가까운 쪽
  // 정면~3/4(≤65°): 다 보임(DWPose도 3/4에서 먼 쪽 귀를 찍는다) · 옆모습(≤110°): 먼 쪽 눈·귀 생략
  // 뒤 3/4(≤155°): 가까운 귀만 · 뒤(>155°): 두 귀만(코·눈 생략)
  const show = { nose: a <= 110, leftEye: a <= 65 || (a <= 110 && near === 'left'), rightEye: a <= 65 || (a <= 110 && near === 'right'),
    leftEar: a <= 65 || a > 155 || near === 'left', rightEar: a <= 65 || a > 155 || near === 'right' };

  const raw = new Array(18).fill(null);
  raw[0] = show.nose ? proj(toW(rig.face.nose)) : null;
  raw[2] = proj(W(j.rightUpperArm));
  raw[3] = proj(W(j.rightLowerArm));
  raw[4] = proj(W(j.rightHand));
  raw[5] = proj(W(j.leftUpperArm));
  raw[6] = proj(W(j.leftLowerArm));
  raw[7] = proj(W(j.leftHand));
  raw[8] = proj(W(j.rightUpperLeg));
  raw[9] = proj(W(j.rightLowerLeg));
  raw[10] = proj(W(j.rightFoot));
  raw[11] = proj(W(j.leftUpperLeg));
  raw[12] = proj(W(j.leftLowerLeg));
  raw[13] = proj(W(j.leftFoot));
  raw[14] = show.rightEye ? proj(toW(rig.face.rightEye)) : null;
  raw[15] = show.leftEye ? proj(toW(rig.face.leftEye)) : null;
  raw[16] = show.rightEar ? proj(toW(rig.face.rightEar)) : null;
  raw[17] = show.leftEar ? proj(toW(rig.face.leftEar)) : null;
  if (raw[2] && raw[5]) raw[1] = [(raw[2][0] + raw[5][0]) / 2, (raw[2][1] + raw[5][1]) / 2]; // 목 = 두 어깨 중점(OpenPose 정의)
  const body = raw.map((q) => r5(on(q)));

  const hand = (s) => {
    const h = rig.hands[s];
    if (!hands || !h) return null;
    const wrist = W(j[s + 'Hand']);
    const pts = [wrist];
    for (const k of FINGERS) pts.push(...(h[k] ? fingerWorld(h[k], wrist, k === 'thumb') : [null, null, null, null]));
    const out = pts.map((v) => r5(on(proj(v))));
    return out.some(Boolean) ? out : null;
  };
  return {
    keypoints: { people: [{ body, left_hand: hand('left'), right_hand: hand('right') }] },
    yaw,
  };
}

// ---- 포즈 맵 그리기(§9.2) — 서버(vnlib.pose.draw, cv2)와 같은 정수 규칙으로 픽셀을 직접 칠한다(안티에일리어싱 없음)
function pyRound(x) { // Python round(): 반올림 경계(.5)는 짝수 쪽
  const r = Math.round(x);
  return Math.abs(x - Math.trunc(x)) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}
function hsvRgb(h) { // colorsys.hsv_to_rgb(h, 1, 1) → int(×255)
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const q = 1 - f;
  const c = [[1, f, 0], [q, 1, 0], [0, 1, f], [0, q, 1], [f, 0, 1], [1, 0, q]][i % 6];
  return c.map((x) => Math.trunc(x * 255));
}
function ellipsePoly(cx, cy, a, b, angle) { // cv2.ellipse2Poly(center, (a, b), angle, 0, 360, 1)
  let ang = angle;
  while (ang < 0) ang += 360;
  while (ang > 360) ang -= 360;
  const al = Math.cos((ang * Math.PI) / 180);
  const be = Math.sin((ang * Math.PI) / 180);
  const pts = [];
  for (let i = 0; i <= 360; i++) {
    const t = (i * Math.PI) / 180;
    const x = a * Math.cos(t);
    const y = b * Math.sin(t);
    const px = pyRound(cx + x * al - y * be);
    const py = pyRound(cy + x * be + y * al);
    const l = pts[pts.length - 1];
    if (!l || l[0] !== px || l[1] !== py) pts.push([px, py]);
  }
  return pts;
}
function fillPoly(img, W, H, pts, rgb) {
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const p of pts) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
  y0 = Math.max(0, y0);
  y1 = Math.min(H - 1, y1);
  const n = pts.length;
  for (let y = y0; y <= y1; y++) {
    let xl = Infinity;
    let xr = -Infinity;
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % n];
      if ((p[1] <= y && q[1] >= y) || (q[1] <= y && p[1] >= y)) {
        if (p[1] === q[1]) { xl = Math.min(xl, p[0], q[0]); xr = Math.max(xr, p[0], q[0]); } else {
          const x = p[0] + ((y - p[1]) * (q[0] - p[0])) / (q[1] - p[1]);
          xl = Math.min(xl, x);
          xr = Math.max(xr, x);
        }
      }
    }
    if (xl > xr) continue;
    const a = Math.max(0, Math.ceil(xl - 0.5));
    const b = Math.min(W - 1, Math.floor(xr + 0.5));
    for (let x = a; x <= b; x++) { const o = (y * W + x) * 4; img[o] = rgb[0]; img[o + 1] = rgb[1]; img[o + 2] = rgb[2]; }
  }
}
function fillCircle(img, W, H, cx, cy, r, rgb) {
  for (let dy = -r; dy <= r; dy++) {
    const y = cy + dy;
    if (y < 0 || y >= H) continue;
    const dx = Math.floor(Math.sqrt(Math.max(0, r * r - dy * dy))); // cv2.circle(thickness=-1)과 같은 행 폭
    for (let x = Math.max(0, cx - dx); x <= Math.min(W - 1, cx + dx); x++) { const o = (y * W + x) * 4; img[o] = rgb[0]; img[o + 1] = rgb[1]; img[o + 2] = rgb[2]; }
  }
}
function fillLine(img, W, H, x1, y1, x2, y2, th, rgb) { // cv2.line(thickness=th): 둥근 끝 두꺼운 선
  const r = th / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const L2 = dx * dx + dy * dy;
  const xa = Math.max(0, Math.floor(Math.min(x1, x2) - r));
  const xb = Math.min(W - 1, Math.ceil(Math.max(x1, x2) + r));
  const ya = Math.max(0, Math.floor(Math.min(y1, y2) - r));
  const yb = Math.min(H - 1, Math.ceil(Math.max(y1, y2) + r));
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      const t = L2 > 0 ? THREE.MathUtils.clamp(((x - x1) * dx + (y - y1) * dy) / L2, 0, 1) : 0;
      const ex = x - (x1 + t * dx);
      const ey = y - (y1 + t * dy);
      if (ex * ex + ey * ey <= r * r) { const o = (y * W + x) * 4; img[o] = rgb[0]; img[o + 1] = rgb[1]; img[o + 2] = rgb[2]; }
    }
  }
}

/**
 * §9.2 규칙으로 OpenPose 맵을 그린 canvas (검은 배경). style: 'standard'(기본, 얇은 선) | 'thick'(xinsir).
 * 최종 맵은 서버가 그린다 — 이건 미리보기용(같은 규칙).
 */
export function drawPoseMap(keypoints, width, height, { hands = true, style = 'standard' } = {}) {
  const Wd = Math.max(1, Math.round(width));
  const Ht = Math.max(1, Math.round(height));
  const k = Math.min(Wd, Ht) / 512;
  const md = Math.max(Wd, Ht) / k;
  const stickScale = style === 'thick' && md >= 500 ? Math.min(2 + Math.floor(md / 1000), 7) : 1;
  const stick = Math.trunc(4 * stickScale * k);
  const rad = Math.max(1, pyRound(4 * k));
  const img = new Uint8ClampedArray(Wd * Ht * 4);
  for (let i = 3; i < img.length; i += 4) img[i] = 255;
  for (const person of keypoints?.people || []) {
    const pts = (person.body || []).map((q) => (q ? [q[0] * Wd, q[1] * Ht] : null));
    POSE_LIMBS.forEach(([a, b], i) => {
      const P = pts[a - 1];
      const Q = pts[b - 1];
      if (!P || !Q) return;
      const L = Math.hypot(P[0] - Q[0], P[1] - Q[1]);
      const ang = Math.trunc(THREE.MathUtils.radToDeg(Math.atan2(P[1] - Q[1], P[0] - Q[0])));
      const poly = ellipsePoly(Math.trunc((P[0] + Q[0]) / 2), Math.trunc((P[1] + Q[1]) / 2), Math.trunc(L / 2), stick, ang);
      fillPoly(img, Wd, Ht, poly, POSE_COLORS[i].map((c) => Math.trunc(c * 0.6)));
    });
    pts.forEach((p, i) => { if (p && i < 18) fillCircle(img, Wd, Ht, Math.trunc(p[0]), Math.trunc(p[1]), rad, POSE_COLORS[i]); });
    if (hands) {
      const th = Math.max(1, pyRound(2 * k));
      for (const hk of ['left_hand', 'right_hand']) {
        const hp = (person[hk] || []).map((q) => (q ? [Math.trunc(q[0] * Wd), Math.trunc(q[1] * Ht)] : null));
        if (!hp.length) continue;
        HAND_EDGES.forEach(([a, b], i) => {
          if (hp[a] && hp[b]) fillLine(img, Wd, Ht, hp[a][0], hp[a][1], hp[b][0], hp[b][1], th, hsvRgb(i / HAND_EDGES.length));
        });
        for (const q of hp) if (q) fillCircle(img, Wd, Ht, q[0], q[1], rad, HAND_POINT_COLOR);
      }
    }
  }
  const c = document.createElement('canvas');
  c.width = Wd;
  c.height = Ht;
  c.getContext('2d').putImageData(new ImageData(img, Wd, Ht), 0, 0);
  return c;
}

/** 화면 겹쳐 보기용(안티에일리어싱 canvas 2D, CSS 픽셀) */
function strokePose(ctx, keypoints, w, h, hands) {
  const k = Math.min(w, h) / 512;
  const rgb = (c, m = 1) => `rgb(${Math.trunc(c[0] * m)},${Math.trunc(c[1] * m)},${Math.trunc(c[2] * m)})`;
  const rad = Math.max(1.5, 4 * k);
  for (const person of keypoints?.people || []) {
    const pts = (person.body || []).map((q) => (q ? [q[0] * w, q[1] * h] : null));
    POSE_LIMBS.forEach(([a, b], i) => {
      const P = pts[a - 1];
      const Q = pts[b - 1];
      if (!P || !Q) return;
      ctx.beginPath();
      ctx.ellipse((P[0] + Q[0]) / 2, (P[1] + Q[1]) / 2, Math.max(0.5, Math.hypot(P[0] - Q[0], P[1] - Q[1]) / 2), Math.max(1, 4 * k),
        Math.atan2(P[1] - Q[1], P[0] - Q[0]), 0, Math.PI * 2);
      ctx.fillStyle = rgb(POSE_COLORS[i], 0.6);
      ctx.fill();
    });
    pts.forEach((p, i) => {
      if (!p || i >= 18) return;
      ctx.beginPath();
      ctx.arc(p[0], p[1], rad, 0, Math.PI * 2);
      ctx.fillStyle = rgb(POSE_COLORS[i]);
      ctx.fill();
    });
    if (!hands) continue;
    for (const hk of ['left_hand', 'right_hand']) {
      const hp = (person[hk] || []).map((q) => (q ? [q[0] * w, q[1] * h] : null));
      if (!hp.length) continue;
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(1, 2 * k);
      HAND_EDGES.forEach(([a, b], i) => {
        if (!hp[a] || !hp[b]) return;
        ctx.beginPath();
        ctx.moveTo(hp[a][0], hp[a][1]);
        ctx.lineTo(hp[b][0], hp[b][1]);
        ctx.strokeStyle = rgb(hsvRgb(i / HAND_EDGES.length));
        ctx.stroke();
      });
      ctx.fillStyle = rgb(HAND_POINT_COLOR);
      for (const q of hp) {
        if (!q) continue;
        ctx.beginPath();
        ctx.arc(q[0], q[1], Math.max(1, 2 * k), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

// ---------------------------------------------------------------- 다른 파일의 애니메이션 옮기기(리타깃)
// 같은 이름의 뼈끼리, "모델 공간에서 휴식 자세 대비 회전량"을 옮긴다(뼈 축 방향이 달라도 맞음).
// 두 리그의 위/왼쪽 방향은 머리-골반, 왼팔-오른팔로 맞추고, 골반 이동은 키 비율로 줄인다.
const boneKey = (n) => String(n || '').replace(/^mixamorig\d*[:_]?/i, '').toLowerCase();

function rigFrame(b, posOf) {
  const q = new THREE.Quaternion();
  if (!b.head || !b.hips) return q;
  const up = posOf(b.head).sub(posOf(b.hips));
  if (up.lengthSq() < 1e-12) return q;
  up.normalize();
  const axes = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map((a) => new THREE.Vector3(...a));
  const upS = axes.reduce((a, c) => (c.dot(up) > a.dot(up) ? c : a));
  const pair = b.leftUpper && b.rightUpper ? [b.leftUpper, b.rightUpper] : b.leftLeg && b.rightLeg ? [b.leftLeg, b.rightLeg] : null;
  if (!pair) return q.setFromUnitVectors(UP, upS);
  const left = posOf(pair[0]).sub(posOf(pair[1]));
  left.addScaledVector(upS, -left.dot(upS));
  if (left.lengthSq() < 1e-12) return q.setFromUnitVectors(UP, upS);
  left.normalize();
  const fwd = new THREE.Vector3().crossVectors(left, upS);
  return q.setFromRotationMatrix(new THREE.Matrix4().makeBasis(left, upS, fwd));
}

function retargetClip(srcRoot, clip, model, tb) {
  srcRoot.updateMatrixWorld(true);
  const srcBones = findBonesByName(srcRoot);
  if (!srcBones.hips) return null;
  const srcByKey = new Map();
  srcRoot.traverse((o) => { if (o !== srcRoot && !o.isMesh && o.name && !srcByKey.has(boneKey(o.name))) srcByKey.set(boneKey(o.name), o); });
  // 대상 노드(부모 먼저) + 짝
  const nodes = [];
  model.traverse((o) => { if (o !== model) nodes.push(o); });
  // 같은 이름 뼈가 여러 개면(FBXLoader가 메시마다 뼈를 겹쳐 만듦) 애니메이션 이름 해석과 같게 첫 번째만
  const pairOf = new Map();
  const seen = new Set();
  for (const o of nodes) {
    if (!o.isBone || seen.has(o.name)) continue;
    seen.add(o.name);
    const s = srcByKey.get(boneKey(o.name));
    if (s) pairOf.set(o, s);
  }
  if (pairOf.size < 8 || !pairOf.has(tb.hips)) return null;
  // 대상 모델 공간(모델 자신 포함) — 휴식 자세 기준
  const inv = new THREE.Matrix4().copy(model.parent ? model.parent.matrixWorld : new THREE.Matrix4()).invert();
  const invQ = new THREE.Quaternion();
  if (model.parent) model.parent.getWorldQuaternion(invQ).invert();
  const tPos = (o) => o.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
  const tQuat = (o) => invQ.clone().multiply(o.getWorldQuaternion(new THREE.Quaternion()));
  const sPos = (o) => o.getWorldPosition(new THREE.Vector3());
  const sQuat = (o) => o.getWorldQuaternion(new THREE.Quaternion());
  const Ft = rigFrame(tb, tPos);
  const Fs = rigFrame(srcBones, sPos);
  const FsInv = Fs.clone().invert();
  const FtInv = Ft.clone().invert();
  const restT = new Map(nodes.map((o) => [o, tQuat(o)]));
  const localRest = new Map(nodes.map((o) => [o, o.quaternion.clone()]));
  const restS = new Map([...pairOf.values()].map((s) => [s, sQuat(s)]));
  const sh = srcBones.head ? sPos(srcBones.head).distanceTo(sPos(srcBones.hips)) : 0;
  const th = tb.head ? tPos(tb.head).distanceTo(tPos(tb.hips)) : 0;
  const k = sh > 1e-9 && th > 1e-9 ? th / sh : 1;
  const sHipsRest = sPos(srcBones.hips);
  const tHipsRest = tPos(tb.hips);
  const hipsParent = tb.hips.parent;
  const hipsParentInv = hipsParent && hipsParent !== model.parent
    ? new THREE.Matrix4().copy(hipsParent.matrixWorld).premultiply(inv).invert()
    : new THREE.Matrix4();

  const mixer = new THREE.AnimationMixer(srcRoot);
  const action = mixer.clipAction(clip);
  action.play();
  const fps = Math.max(5, Math.min(30, 600 / clip.duration));
  const n = Math.max(2, Math.floor(clip.duration * fps) + 1);
  const times = new Float32Array(n);
  const qv = new Map([...pairOf.keys()].map((o) => [o, new Float32Array(n * 4)]));
  const pv = new Float32Array(n * 3);
  const cur = new Map();
  const D = new THREE.Quaternion();
  for (let i = 0; i < n; i++) {
    const t = Math.min(clip.duration, i / fps);
    times[i] = t;
    action.time = t;
    mixer.update(0);
    srcRoot.updateMatrixWorld(true);
    for (const o of nodes) {
      const s = pairOf.get(o);
      const parentQ = o.parent === model ? (restT.get(o).clone().multiply(localRest.get(o).clone().invert())) : (cur.get(o.parent) || restT.get(o.parent) || new THREE.Quaternion());
      let q;
      if (s) {
        // 소스의 모델 공간 회전 변화 → 정규(캐논) 공간 → 대상 공간
        D.copy(sQuat(s)).multiply(restS.get(s).clone().invert());
        D.premultiply(FsInv).multiply(Fs);
        D.premultiply(Ft).multiply(FtInv);
        q = D.clone().multiply(restT.get(o));
        const local = parentQ.clone().invert().multiply(q);
        qv.get(o).set([local.x, local.y, local.z, local.w], i * 4);
      } else {
        q = parentQ.clone().multiply(localRest.get(o));
      }
      cur.set(o, q);
    }
    const d = sPos(srcBones.hips).sub(sHipsRest).applyQuaternion(FsInv).multiplyScalar(k).applyQuaternion(Ft);
    const p = tHipsRest.clone().add(d).applyMatrix4(hipsParentInv);
    pv.set([p.x, p.y, p.z], i * 3);
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(srcRoot);
  const tracks = [];
  for (const [o, v] of qv) tracks.push(new THREE.QuaternionKeyframeTrack(`${o.name}.quaternion`, times, v));
  tracks.push(new THREE.VectorKeyframeTrack(`${tb.hips.name}.position`, times, pv));
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

// ---------------------------------------------------------------- VRM 메타
function vrmMeta(meta) {
  if (!meta) return null;
  if (meta.metaVersion === '1') {
    const commercial = { personalNonProfit: '개인 비영리만', personalProfit: '개인 영리까지 허용', corporation: '법인 포함 허용' };
    const users = { onlyAuthor: '작가 본인만', onlySeparatelyLicensedPerson: '별도로 허락받은 사람만', everyone: '누구나' };
    const modification = { prohibited: '금지', allowModification: '허용(수정본 재배포 금지)', allowModificationRedistribution: '허용' };
    return {
      specVersion: '1',
      title: meta.name || '',
      author: (meta.authors || []).join(', '),
      version: meta.version || '',
      license: meta.licenseUrl ? 'VRM Public License 1.0' : '',
      licenseUrl: meta.licenseUrl || '',
      otherLicenseUrl: meta.otherLicenseUrl || '',
      commercial: commercial[meta.commercialUsage] || meta.commercialUsage || '알 수 없음',
      commercialAllowed: meta.commercialUsage ? meta.commercialUsage !== 'personalNonProfit' : null,
      allowedUser: users[meta.avatarPermission] || meta.avatarPermission || '알 수 없음',
      redistribution: meta.allowRedistribution ? '허용' : '금지',
      modification: modification[meta.modification] || meta.modification || '',
      credit: meta.creditNotation === 'required' ? '표기 필요' : '표기 불필요',
      contact: meta.contactInformation || '',
      reference: (meta.references || []).join(', '),
      copyright: meta.copyrightInformation || '',
    };
  }
  const licenses = {
    Redistribution_Prohibited: '재배포 금지', CC0: 'CC0', CC_BY: 'CC BY', CC_BY_NC: 'CC BY-NC', CC_BY_SA: 'CC BY-SA',
    CC_BY_NC_SA: 'CC BY-NC-SA', CC_BY_ND: 'CC BY-ND', CC_BY_NC_ND: 'CC BY-NC-ND', Other: '기타(별도 문서 확인)',
  };
  const users = { OnlyAuthor: '작가 본인만', ExplicitlyLicensedPerson: '별도로 허락받은 사람만', Everyone: '누구나' };
  return {
    specVersion: '0',
    title: meta.title || '',
    author: meta.author || '',
    version: meta.version || '',
    license: licenses[meta.licenseName] || meta.licenseName || '',
    licenseUrl: '',
    otherLicenseUrl: meta.otherLicenseUrl || meta.otherPermissionUrl || '',
    commercial: meta.commercialUssageName === 'Allow' ? '허용' : meta.commercialUssageName === 'Disallow' ? '금지' : '알 수 없음',
    commercialAllowed: meta.commercialUssageName === 'Allow' ? true : meta.commercialUssageName === 'Disallow' ? false : null,
    allowedUser: users[meta.allowedUserName] || meta.allowedUserName || '알 수 없음',
    redistribution: meta.licenseName === 'Redistribution_Prohibited' ? '금지' : '',
    modification: '',
    credit: '',
    contact: meta.contactInformation || '',
    reference: meta.reference || '',
    copyright: '',
  };
}

// ---------------------------------------------------------------- 오류 메시지 번역
function koreanLoadError(err, format, ctx) {
  const msg = String(err?.message || err || '');
  const missing = [...ctx.missing.values()];
  const missingData = missing.filter((n) => !WEB_IMAGE_EXTS.has(extOf(n)) && extOf(n) !== 'tga');
  if (missingData.length || (/Failed to load buffer|Failed to load/i.test(msg) && missing.length)) {
    return `필요한 파일을 찾지 못했습니다: ${(missingData.length ? missingData : missing).slice(0, 3).join(', ')} — 모델 폴더를 통째로 선택하세요`;
  }
  if (/DRACOLoader/i.test(msg)) return '압축(Draco)된 glTF는 지원하지 않습니다. 압축하지 않은 glb로 다시 내보내세요';
  if (/KTX2|ktx2/i.test(msg)) return '압축 텍스처(KTX2)를 쓰는 glTF는 지원하지 않습니다';
  if (/Meshopt|meshopt/i.test(msg)) return '압축(meshopt)된 glTF는 지원하지 않습니다';
  if (msg.startsWith('FBX 파일이 손상')) return msg;
  if (/FBX version not supported/i.test(msg)) return '이 FBX는 너무 오래된 텍스트(ASCII) 형식이라 열 수 없습니다. 바이너리 FBX(7.x)로 다시 내보내세요';
  if (/Cannot find the version number|Unknown format/i.test(msg)) return '올바른 FBX 파일이 아닙니다';
  if (/Unknown model file extension|MMDParser|Signature/i.test(msg)) return '올바른 PMX/PMD 파일이 아닙니다';
  if (/Unexpected token|JSON|Unsupported asset|Unknown extension/i.test(msg) && (format === 'gltf' || format === 'glb' || format === 'vrm')) {
    return `glTF 파일을 해석하지 못했습니다 (${msg.slice(0, 120)})`;
  }
  if (/memory|allocation|Array buffer/i.test(msg)) return '메모리가 부족해 모델을 열지 못했습니다. 더 작은 모델로 시도하세요';
  return `모델을 불러오지 못했습니다 (${msg.slice(0, 160) || '알 수 없는 오류'})`;
}

// ---------------------------------------------------------------- FBX 6.x(바이너리) → 7.4 변환
// three.js FBXLoader는 FBX 7 이상만 읽는다. Mixamo "FBX for Unity" 등 FBX 6.1 바이너리를
// 메모리에서 7.4 구조(ID 연결, Geometry 분리, Properties70, 배열 속성)로 바꿔 넘긴다. 애니메이션(Takes)은 제외.
const FBX_MAGIC = 'Kaydara FBX Binary  \0';
const FBX6_ARRAYS = new Set(['Vertices', 'PolygonVertexIndex', 'Edges', 'Normals', 'NormalsIndex', 'NormalsW', 'Binormals',
  'BinormalsIndex', 'BinormalsW', 'Tangents', 'TangentsIndex', 'TangentsW', 'UV', 'UVIndex', 'Colors', 'ColorIndex',
  'Materials', 'Smoothing', 'Visibility', 'Indexes', 'Weights', 'Transform', 'TransformLink', 'Matrix', 'TextureId']);
const FBX6_INT_ARRAYS = new Set(['PolygonVertexIndex', 'Edges', 'NormalsIndex', 'BinormalsIndex', 'TangentsIndex', 'UVIndex',
  'ColorIndex', 'Materials', 'Smoothing', 'Visibility', 'Indexes', 'TextureId']);

function fbxBinaryVersion(buf) {
  if (buf.byteLength < 27) return 0;
  const head = new Uint8Array(buf, 0, 21);
  for (let i = 0; i < 21; i++) if (head[i] !== FBX_MAGIC.charCodeAt(i)) return 0;
  return new DataView(buf).getUint32(23, true);
}

function convertFbx6(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  const dec = new TextDecoder('utf-8');
  const enc = new TextEncoder();
  const SIZE = { Y: 2, C: 1, I: 4, F: 4, D: 8, L: 8 };

  function readScalar(t, p) {
    switch (t) {
      case 'Y': return dv.getInt16(p, true);
      case 'C': return u8[p] ? 1 : 0;
      case 'I': return dv.getInt32(p, true);
      case 'F': return dv.getFloat32(p, true);
      case 'D': return dv.getFloat64(p, true);
      default: return Number(dv.getBigInt64(p, true)); // L
    }
  }
  function parseNode(o, limit) {
    const end = dv.getUint32(o, true);
    const n = dv.getUint32(o + 4, true);
    const plen = dv.getUint32(o + 8, true);
    const nl = u8[o + 12];
    if (end === 0) return { node: null, next: o + 13 };
    // 손상된 파일: 끝 위치가 앞으로 가지 않거나 부모 밖이면 같은 곳을 끝없이 돌게 된다 → 바로 멈춘다
    if (end <= o || end > limit || o + 13 + nl + plen > end) throw new Error('FBX 파일이 손상되었습니다(노드 위치 오류) — 원본 파일을 다시 받아 보세요');
    const name = dec.decode(u8.subarray(o + 13, o + 13 + nl));
    let p = o + 13 + nl;
    const pend = p + plen;
    const props = [];
    if (FBX6_ARRAYS.has(name) && (n === 0 || SIZE[String.fromCharCode(u8[p])])) {
      // FBX 6은 배열을 스칼라 속성 n개로 저장한다 → 7의 배열 속성 하나로
      const isInt = FBX6_INT_ARRAYS.has(name);
      const arr = isInt ? new Int32Array(n) : new Float64Array(n);
      for (let i = 0; i < n && p < pend; i++) {
        const t = String.fromCharCode(u8[p]);
        if (!SIZE[t]) throw new Error('FBX 6 해석 실패(배열 형식 혼합)');
        arr[i] = readScalar(t, p + 1);
        p += 1 + SIZE[t];
      }
      props.push({ t: isInt ? 'i' : 'd', arr });
    } else {
      for (let i = 0; i < n; i++) {
        const t = String.fromCharCode(u8[p]);
        p++;
        if (SIZE[t]) { props.push({ t, v: readScalar(t, p) }); p += SIZE[t]; } else if (t === 'S' || t === 'R') {
          const len = dv.getUint32(p, true);
          props.push({ t, bytes: u8.subarray(p + 4, p + 4 + len) });
          p += 4 + len;
        } else if ('fdlib'.includes(t)) {
          const clen = dv.getUint32(p + 8, true);
          props.push({ t, raw: u8.subarray(p, p + 12 + clen) }); // 원래 배열 인코딩 그대로
          p += 12 + clen;
        } else {
          throw new Error(`FBX 6 해석 실패(알 수 없는 속성 형식 ${t})`);
        }
      }
    }
    const children = [];
    let q = pend;
    while (q < end) {
      const r = parseNode(q, end);
      q = r.next;
      if (!r.node) break;
      children.push(r.node);
    }
    return { node: { name, props, children }, next: end };
  }

  // 최상위 노드
  const top = [];
  let o = 27;
  while (o + 13 <= u8.length) {
    const r = parseNode(o, u8.length);
    if (!r.node) break;
    top.push(r.node);
    o = r.next;
  }
  const str = (p) => (p && p.bytes ? dec.decode(p.bytes) : p && p.v !== undefined ? String(p.v) : '');
  const S = (s) => ({ t: 'S', bytes: typeof s === 'string' ? enc.encode(s) : s });
  const L = (v) => ({ t: 'L', v });
  const I = (v) => ({ t: 'I', v });
  const N = (name, props = [], children = []) => ({ name, props, children });
  const find = (list, name) => list.find((x) => x.name === name);
  const objects = find(top, 'Objects');
  const connections = find(top, 'Connections');
  if (!objects || !connections) throw new Error('FBX 6 파일 구조를 읽지 못했습니다');

  const ids = new Map();
  let nextId = 1_000_000;
  const idOf = (key) => {
    if (key === 'Scene\0\x01Model' || key === 'Scene') return 0;
    if (!ids.has(key)) ids.set(key, nextId++);
    return ids.get(key);
  };
  const props70 = (p60) => N('Properties70', [], p60.children.filter((c) => c.name === 'Property' && c.props.length >= 3)
    .map((c) => N('P', [c.props[0], c.props[1], S(''), c.props[2], ...c.props.slice(3)])));
  const conv = (node) => N(node.name, node.props, node.children.map((c) => (c.name === 'Properties60' ? props70(c) : conv(c))));
  const baseName = (key) => key.split('\0\x01')[0];

  const outObjects = [];
  const extraConns = [];
  const geoOf = new Map(); // 모델 키 → Geometry ID
  const skinKeys = new Set();
  let globalSettings = null;
  let hasTakes = false;
  for (const obj of objects.children) {
    const key = str(obj.props[0]);
    const type = str(obj.props[1]);
    if (obj.name === 'GlobalSettings') {
      globalSettings = N('GlobalSettings', [], obj.children.map((c) => (c.name === 'Properties60' ? props70(c) : c)));
      continue;
    }
    if (obj.name === 'Model') {
      const id = idOf(key);
      const mChildren = [];
      const gChildren = [];
      for (const c of obj.children) {
        if (c.name === 'Properties60') mChildren.push(props70(c));
        else if (['Vertices', 'PolygonVertexIndex', 'Edges', 'GeometryVersion', 'Layer'].includes(c.name) || c.name.startsWith('LayerElement')) gChildren.push(conv(c));
        else if (['Version', 'Shading', 'Culling'].includes(c.name)) mChildren.push(c);
      }
      outObjects.push(N('Model', [L(id), S(obj.props[0].bytes), S(type)], mChildren));
      if (gChildren.some((c) => c.name === 'Vertices')) {
        const gk = `${baseName(key)}\0\x01Geometry#${id}`;
        const gid = idOf(gk);
        outObjects.push(N('Geometry', [L(gid), S(`${baseName(key)}\0\x01Geometry`), S('Mesh')], gChildren));
        extraConns.push(N('C', [S('OO'), L(gid), L(id)]));
        geoOf.set(key, gid);
      }
      continue;
    }
    if (obj.name === 'Pose') {
      const ch = obj.children.map((c) => {
        if (c.name !== 'PoseNode') return c.name === 'Properties60' ? props70(c) : c;
        return N('PoseNode', [], c.children.map((pc) => (pc.name === 'Node' ? N('Node', [L(idOf(str(pc.props[0])))]) : pc)));
      });
      outObjects.push(N('Pose', [L(idOf(key)), S(obj.props[0].bytes), S(type)], ch));
      continue;
    }
    if (['Material', 'Texture', 'Video', 'Deformer'].includes(obj.name)) {
      if (obj.name === 'Deformer' && type === 'Skin') skinKeys.add(key);
      outObjects.push(N(obj.name, [L(idOf(key)), S(obj.props[0].bytes), S(type)], conv(obj).children));
    }
  }
  const takes = find(top, 'Takes');
  if (takes) hasTakes = takes.children.some((t) => t.name === 'Take' && t.children.some((c) => c.name === 'Model'));

  const outConns = [...extraConns];
  for (const c of connections.children) {
    if (c.name !== 'Connect' || c.props.length < 3) continue;
    const kind = str(c.props[0]);
    const child = str(c.props[1]);
    const parent = str(c.props[2]);
    if (!ids.has(child) && child !== 'Scene\0\x01Model') continue;
    if (!ids.has(parent) && parent !== 'Scene\0\x01Model') continue;
    let pid = idOf(parent);
    if (skinKeys.has(child) && geoOf.has(parent)) pid = geoOf.get(parent); // FBX 7: Skin은 Geometry에 붙는다
    const props = [S(kind), L(idOf(child)), L(pid)];
    if (c.props.length > 3) props.push(c.props[3]);
    outConns.push(N('C', props));
  }

  const doc = [
    N('FBXHeaderExtension', [], [N('FBXHeaderVersion', [I(1003)]), N('FBXVersion', [I(7400)])]),
    globalSettings || N('GlobalSettings', [], []),
    N('Objects', [], outObjects),
    N('Connections', [], outConns),
  ];

  // ---- 7.4 바이너리로 쓰기 (32비트 오프셋)
  const nameBytes = new Map();
  const nb = (n) => {
    if (!nameBytes.has(n)) nameBytes.set(n, enc.encode(n));
    return nameBytes.get(n);
  };
  const propSize = (p) => {
    if (SIZE[p.t]) return 1 + SIZE[p.t];
    if (p.t === 'S' || p.t === 'R') return 5 + p.bytes.length;
    if (p.raw) return 1 + p.raw.length;
    return 13 + p.arr.length * (p.t === 'i' ? 4 : 8);
  };
  const sizeOf = (node) => {
    let s = 13 + nb(node.name).length;
    for (const p of node.props) s += propSize(p);
    for (const c of node.children) s += sizeOf(c);
    if (node.children.length || !node.props.length) s += 13;
    node._size = s;
    return s;
  };
  let total = 27;
  for (const n of doc) total += sizeOf(n);
  total += 13 + 160;
  if (total % 16 === 0) total += 1;
  const out = new Uint8Array(total);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 21; i++) out[i] = FBX_MAGIC.charCodeAt(i);
  out[21] = 0x1a;
  out[22] = 0;
  odv.setUint32(23, 7400, true);
  let w = 27;
  const writeProp = (p) => {
    out[w++] = p.t.charCodeAt(0);
    switch (p.t) {
      case 'Y': odv.setInt16(w, p.v, true); w += 2; return;
      case 'C': out[w++] = p.v ? 1 : 0; return;
      case 'I': odv.setInt32(w, p.v, true); w += 4; return;
      case 'F': odv.setFloat32(w, p.v, true); w += 4; return;
      case 'D': odv.setFloat64(w, p.v, true); w += 8; return;
      case 'L': odv.setBigInt64(w, BigInt(Math.trunc(p.v)), true); w += 8; return;
      case 'S':
      case 'R': odv.setUint32(w, p.bytes.length, true); out.set(p.bytes, w + 4); w += 4 + p.bytes.length; return;
      default:
        if (p.raw) { out.set(p.raw, w); w += p.raw.length; return; }
        odv.setUint32(w, p.arr.length, true);
        odv.setUint32(w + 4, 0, true);
        odv.setUint32(w + 8, p.arr.length * (p.t === 'i' ? 4 : 8), true);
        w += 12;
        if (p.t === 'i') for (let i = 0; i < p.arr.length; i++, w += 4) odv.setInt32(w, p.arr[i], true);
        else for (let i = 0; i < p.arr.length; i++, w += 8) odv.setFloat64(w, p.arr[i], true);
    }
  };
  const writeNode = (node) => {
    const start = w;
    const nameB = nb(node.name);
    let plen = 0;
    for (const p of node.props) plen += propSize(p);
    odv.setUint32(w, start + node._size, true);
    odv.setUint32(w + 4, node.props.length, true);
    odv.setUint32(w + 8, plen, true);
    out[w + 12] = nameB.length;
    out.set(nameB, w + 13);
    w += 13 + nameB.length;
    for (const p of node.props) writeProp(p);
    for (const c of node.children) writeNode(c);
    if (node.children.length || !node.props.length) w += 13; // 빈 레코드(0으로 채워져 있음)
  };
  for (const n of doc) writeNode(n);
  return { buffer: out.buffer, hasTakes };
}

// ---------------------------------------------------------------- 정리
const SHARED_TEXTURES = new WeakSet(); // 뷰어가 여러 모델에 같이 쓰는 텍스처(환경맵) — 모델 정리 때 지우지 않음

function disposeObject(root) {
  if (!root) return;
  const geos = new Set();
  const mats = new Set();
  const texs = new Set();
  root.traverse((o) => {
    if (o.geometry) geos.add(o.geometry);
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m && mats.add(m));
    if (o.isSkinnedMesh && o.skeleton) o.skeleton.dispose();
  });
  for (const m of mats) {
    for (const k of TEX_KEYS) {
      const t = prop(m, k);
      if (t?.isTexture) texs.add(t);
    }
    if (m.uniforms) {
      for (const u of Object.values(m.uniforms)) {
        const v = u?.value;
        if (v?.isTexture) texs.add(v);
        else if (Array.isArray(v)) v.forEach((x) => x?.isTexture && texs.add(x));
      }
    }
    m.dispose();
  }
  geos.forEach((g) => g.dispose());
  texs.forEach((t) => {
    if (SHARED_TEXTURES.has(t)) return;
    t.dispose();
    const img = t.image;
    if (img && typeof img.close === 'function') { try { img.close(); } catch { /* 무시 */ } }
  });
}

/** 재질 속성 안전하게 읽기 (MMDToonMaterial은 없는 uniform의 getter가 예외를 던진다) */
function prop(m, k) {
  try { return m[k]; } catch { return undefined; }
}

function hasImage(t) {
  const img = t.image;
  if (!img) return false;
  if ('data' in img && !(img instanceof HTMLElement)) return img.data != null;
  if (Array.isArray(img)) return img.length > 0;
  return (img.width || img.videoWidth || 0) > 0;
}

function materialsOf(o) {
  return o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
}

// ================================================================= createViewer
export async function createViewer(container, { onStatus } = {}) {
  if (!container) throw new Error('3D 뷰어를 넣을 자리가 없습니다');
  const status = (phase, progress, message) => safeCall(onStatus, { phase, progress, message });

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
  } catch (e) {
    throw new Error('이 브라우저(또는 그래픽 설정)에서 WebGL을 쓸 수 없어 3D 모델을 표시할 수 없습니다. 브라우저의 하드웨어 가속을 켜고 다시 시도하세요.');
  }
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = false;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const canvas = renderer.domElement;
  canvas.style.cssText = 'display:block;width:100%;height:100%;outline:none;touch-action:none';
  canvas.setAttribute('aria-label', '3D 모델 미리보기 (끌어서 회전, 휠로 확대)');
  container.appendChild(canvas);
  // 뼈대 겹쳐 보기(화면 좌표, 마우스는 아래 3D 화면으로 통과)
  const overlay = document.createElement('canvas');
  overlay.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;display:none';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.className = 'vn3d-pose-overlay';
  container.appendChild(overlay);
  try { if (getComputedStyle(container).position === 'static') container.style.position = 'relative'; } catch { /* 무시 */ }

  const scene = new THREE.Scene();
  const bg = new THREE.Color('#ffffff');
  scene.background = bg;
  const hemi = new THREE.HemisphereLight(0xffffff, 0xa0a0a0, LIGHT.hemi);
  const key = new THREE.DirectionalLight(0xffffff, LIGHT.key);
  const rim = new THREE.DirectionalLight(0xffffff, LIGHT.rim);
  scene.add(hemi, key, key.target, rim, rim.target);

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 200);
  camera.position.set(0, MODEL_H / 2, 4);
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, MODEL_H / 2, 0);
  controls.minDistance = 0.05;
  controls.maxDistance = 40;
  controls.zoomSpeed = 0.9;
  controls.update();

  const root = new THREE.Group(); // 크기·위치 정규화
  root.name = 'vn3d-root';
  const orient = new THREE.Group(); // 방향 보정(+앞뒤 바꾸기)
  orient.name = 'vn3d-orient';
  root.add(orient);
  scene.add(root);

  const S = {
    disposed: false,
    lost: false,
    loadSeq: 0,
    ctx: null,
    model: null,
    vrm: null,
    info: null,
    format: null,
    bones: {},
    arms: null,
    rest: [],
    restBox: null,
    scale: 1,
    baseQuat: new THREE.Quaternion(),
    flipped: false,
    armsDown: false,
    mixer: null,
    clips: [],
    action: null,
    clipTracks: [], // 지금 클립의 {binding, interp} — applyPose가 직접 샘플링
    clipName: null,
    clipTime: 0,
    view: 'front',
    framing: 'full',
    userMoved: false,
    measure: null,
    brightness: 1,
    background: '#ffffff',
    rig: null, // 포즈 리그(buildPoseRig) — 관절 매핑 실패면 rig.ok = false
    overlay: false,
  };

  // 금속(PBR) 재질용 은은한 스튜디오 환경맵 — 환경맵이 없으면 금속이 검게 보인다(비금속 재질에는 쓰지 않아 색 유지)
  let envRT = null;
  function studioEnv() {
    if (envRT) return envRT.texture;
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    const geo = new THREE.SphereGeometry(10, 32, 16);
    const pos = geo.attributes.position;
    const cols = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const c = 0.35 + 0.65 * Math.pow((pos.getY(i) / 10 + 1) / 2, 0.8);
      cols.set([c, c, c], i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    const mat = new THREE.MeshBasicMaterial({ side: THREE.BackSide, vertexColors: true });
    envScene.add(new THREE.Mesh(geo, mat));
    envRT = pmrem.fromScene(envScene, 0.04);
    geo.dispose();
    mat.dispose();
    pmrem.dispose();
    SHARED_TEXTURES.add(envRT.texture);
    return envRT.texture;
  }

  // ---------------------------------------------------------- 렌더링(필요할 때만)
  let raf = 0;
  function aimLights(cam, target) {
    const toCam = cam.position.clone().sub(target);
    toCam.y = 0;
    if (toCam.lengthSq() < 1e-10) toCam.set(0, 0, 1);
    toCam.normalize();
    key.position.copy(target).addScaledVector(toCam, 5).add(new THREE.Vector3(0, 3.2, 0));
    key.target.position.copy(target);
    rim.position.copy(target).addScaledVector(toCam, -5).add(new THREE.Vector3(0, 4, 0));
    rim.target.position.copy(target);
    key.target.updateMatrixWorld();
    rim.target.updateMatrixWorld();
  }
  function renderNow() {
    if (S.disposed || S.lost || renderer.getContext().isContextLost()) return; // 끊김 이벤트가 오기 전 프레임도 건너뜀
    aimLights(camera, controls.target);
    renderer.render(scene, camera);
    drawOverlay();
  }

  let overlayDirty = false;
  function drawOverlay() {
    const on = S.overlay && S.rig?.ok && S.model;
    if (!on) {
      if (overlayDirty) {
        overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height);
        overlayDirty = false;
      }
      overlay.style.display = 'none';
      return;
    }
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (overlay.width !== pw || overlay.height !== ph) { overlay.width = pw; overlay.height = ph; }
    overlay.style.display = 'block';
    const ctx = overlay.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pw, ph);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 0.9;
    try {
      const { keypoints } = poseKeypoints(S.rig, camera, { hands: true });
      strokePose(ctx, keypoints, w, h, true);
    } catch (e) {
      console.warn(e);
    }
    ctx.globalAlpha = 1;
    overlayDirty = true;
  }
  function requestRender() {
    if (raf || S.disposed) return;
    raf = requestAnimationFrame(() => { raf = 0; renderNow(); });
  }
  controls.addEventListener('change', requestRender);
  controls.addEventListener('start', () => { S.userMoved = true; });

  function resize() {
    if (S.disposed) return;
    const w = Math.max(1, Math.floor(container.clientWidth));
    const h = Math.max(1, Math.floor(container.clientHeight));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (S.model && !S.userMoved) placeMainCamera();
    else requestRender();
  }
  const ro = new ResizeObserver(() => resize());
  ro.observe(container);
  resize();

  const onLost = (e) => {
    e.preventDefault();
    S.lost = true;
    status('error', null, '그래픽(WebGL) 연결이 끊어져 3D 화면이 멈췄습니다. 잠시 기다려도 돌아오지 않으면 페이지를 새로고침(⌘R)하세요.');
  };
  const onRestored = () => {
    S.lost = false;
    if (envRT) {
      // 환경맵은 렌더 타깃이라 내용이 사라졌다 — 다시 만든다
      const old = envRT;
      envRT = null;
      const tex = studioEnv();
      S.model?.traverse((o) => {
        for (const m of materialsOf(o)) if (m.envMap === old.texture) { m.envMap = tex; m.needsUpdate = true; }
      });
      old.dispose();
    }
    status('restored', null, '3D 화면이 복구되었습니다');
    requestRender();
  };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);

  // ---------------------------------------------------------- 측정(현재 자세 기준 경계상자 + 머리 영역)
  function visibleMeshes() {
    const out = [];
    if (!S.model) return out;
    S.model.traverseVisible((o) => {
      if (!o.isMesh || !o.geometry?.attributes?.position) return;
      const mats = materialsOf(o);
      if (mats.length && mats.every((m) => m.visible === false || (m.transparent && m.opacity === 0))) return;
      out.push(o);
    });
    return out;
  }

  function computeMeasure() {
    root.updateMatrixWorld(true);
    const box = new THREE.Box3();
    const head = new THREE.Box3();
    const b = S.bones;
    const headNode = b.head || null;
    const headY = headNode ? wpos(headNode).y : null;
    const headSet = new Set();
    if (headNode) headNode.traverse((o) => headSet.add(o));
    const meshes = visibleMeshes();
    let total = 0;
    for (const m of meshes) if (m.isSkinnedMesh || m.morphTargetInfluences?.some((x) => x)) total += m.geometry.attributes.position.count;
    const step = Math.max(1, Math.ceil(total / MEASURE_BUDGET));
    const v = new THREE.Vector3();
    const tmp = new THREE.Box3();
    const headMargin = 0.02 * MODEL_H;
    for (const m of meshes) {
      const g = m.geometry;
      const deformed = m.isSkinnedMesh || m.morphTargetInfluences?.some((x) => x);
      let underHead = false;
      for (let p = m; p; p = p.parent) if (headSet.has(p)) { underHead = true; break; }
      if (!deformed) {
        if (!g.boundingBox) g.computeBoundingBox();
        tmp.copy(g.boundingBox).applyMatrix4(m.matrixWorld);
        if (m.isInstancedMesh) { m.computeBoundingBox?.(); if (m.boundingBox) tmp.copy(m.boundingBox).applyMatrix4(m.matrixWorld); }
        box.union(tmp);
        if (underHead) head.union(tmp);
        continue;
      }
      const pos = g.attributes.position;
      const si = m.isSkinnedMesh ? g.attributes.skinIndex : null;
      const sw = m.isSkinnedMesh ? g.attributes.skinWeight : null;
      const bones = m.isSkinnedMesh ? m.skeleton?.bones : null;
      for (let i = 0; i < pos.count; i += step) {
        m.getVertexPosition(i, v);
        v.applyMatrix4(m.matrixWorld);
        if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) continue;
        box.expandByPoint(v);
        if (headY == null) continue;
        let inHead = underHead;
        if (!inHead && si && sw && bones) {
          let bw = -1;
          let bi = 0;
          for (let k = 0; k < 4; k++) {
            const w = sw.getComponent(i, k);
            if (w > bw) { bw = w; bi = si.getComponent(i, k); }
          }
          inHead = headSet.has(bones[bi]);
        }
        if (inHead && v.y >= headY - headMargin) head.expandByPoint(v);
      }
    }
    const hips = b.hips ? wpos(b.hips) : null;
    // 고관절(허벅지 뼈 머리) 높이 — 상반신 프레이밍에 엉덩이 점이 들어가게(MMD 下半身처럼 골반 뼈가 고관절보다 높은 리그)
    const legTop = S.rig?.ok ? Math.min(wpos(S.rig.j.leftUpperLeg).y, wpos(S.rig.j.rightUpperLeg).y) : null;
    return { box, head, headY, headPos: headNode ? wpos(headNode) : null, hips, legTop };
  }

  function measure() {
    if (!S.measure) S.measure = computeMeasure();
    return S.measure;
  }

  /** 프레이밍 영역: { center, halfV, halfW, depth } 또는 { box } (전신) */
  function frameRegion(framing) {
    const m = measure();
    const box = m.box;
    if (box.isEmpty()) return { box: new THREE.Box3(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, MODEL_H, 0.5)) };
    const size = box.getSize(new THREE.Vector3());
    const H = Math.max(size.y, 1e-6);
    const c = box.getCenter(new THREE.Vector3());
    if (framing === 'full') return { box };
    // 머리 위치·크기 추정
    let headY = m.headY;
    let headTop = box.max.y;
    let hx = c.x;
    let hz = c.z;
    let hh;
    if (headY != null && !m.head.isEmpty() && m.head.max.y > headY) {
      headTop = m.head.max.y;
      const hc = m.head.getCenter(new THREE.Vector3());
      hx = hc.x;
      hz = hc.z;
      hh = headTop - headY;
    } else if (headY != null) {
      hh = THREE.MathUtils.clamp(box.max.y - headY, 0.06 * H, 0.5 * H);
      headTop = headY + hh;
      hx = m.headPos.x;
      hz = m.headPos.z;
    } else {
      hh = 0.14 * H;
      headY = box.max.y - hh;
    }
    hh = THREE.MathUtils.clamp(hh, 0.05 * H, 0.6 * H);
    if (framing === 'face') {
      const y0 = headY - 0.4 * hh;
      const y1 = headTop + 0.15 * hh;
      // 카메라가 머리(또는 뼈 없는 물체) 안으로 들어가지 않게 앞쪽 깊이는 실제 경계상자로
      const depthBox = !m.head.isEmpty() ? m.head : m.headY == null ? box : null;
      return { center: new THREE.Vector3(hx, (y0 + y1) / 2, hz), halfV: (y1 - y0) / 2, halfW: 0.62 * hh, depth: 0.5 * hh, depthBox };
    }
    // 상반신: 머리 꼭대기 ~ 골반(허리 아래)
    const y1 = headTop + 0.1 * hh;
    let y0 = m.hips ? m.hips.y - 0.02 * H : headTop - 0.52 * H;
    if (m.legTop != null && m.legTop < y1) y0 = Math.min(y0, m.legTop - 0.03 * H);
    y0 = Math.min(y0, y1 - 2.2 * hh);
    y0 = Math.max(y0, box.min.y);
    const cx = m.hips ? (hx + m.hips.x) / 2 : hx;
    const cz = m.hips ? (hz + m.hips.z) / 2 : hz;
    return { center: new THREE.Vector3(cx, (y0 + y1) / 2, cz), halfV: (y1 - y0) / 2, halfW: 0.17 * H, depth: 0.12 * H, depthBox: m.headY == null ? box : null };
  }

  /** 카메라를 프리셋(각도·프레이밍)에 맞게 놓는다. → 바라보는 점 */
  function placePreset(cam, view, framing, aspect) {
    const az = THREE.MathUtils.degToRad(VIEW_AZIMUTH[view] ?? 0);
    const dir = new THREE.Vector3(Math.sin(az), 0, Math.cos(az));
    const right = new THREE.Vector3().crossVectors(UP, dir).normalize();
    const tanV = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
    const tanH = tanV * aspect;
    const reg = frameRegion(framing);
    let C;
    let D;
    if (reg.box) {
      const pad = 1.07;
      C = reg.box.getCenter(new THREE.Vector3());
      D = 0;
      const { min, max } = reg.box;
      const p = new THREE.Vector3();
      for (let i = 0; i < 8; i++) {
        p.set(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z).sub(C);
        const zc = p.dot(dir);
        const need = zc + Math.max((Math.abs(p.y) * pad) / tanV, (Math.abs(p.dot(right)) * pad) / tanH);
        D = Math.max(D, need);
      }
    } else {
      C = reg.center;
      let depth = reg.depth;
      if (reg.depthBox && !reg.depthBox.isEmpty()) {
        const { min, max } = reg.depthBox;
        const p = new THREE.Vector3();
        for (let i = 0; i < 8; i++) {
          p.set(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z).sub(C);
          depth = Math.max(depth, p.dot(dir));
        }
      }
      D = depth + Math.max(reg.halfV / tanV, reg.halfW / tanH);
    }
    D = Math.max(D, 0.05);
    cam.position.copy(C).addScaledVector(dir, D);
    cam.up.copy(UP);
    cam.lookAt(C);
    cam.near = Math.max(0.005, Math.min(0.05, D * 0.02));
    cam.far = Math.max(50, D * 20);
    cam.updateProjectionMatrix();
    return C;
  }

  function placeMainCamera() {
    const C = placePreset(camera, S.view, S.framing, camera.aspect);
    controls.target.copy(C);
    controls.update();
    requestRender();
  }

  // ---------------------------------------------------------- 자세(애니메이션 + 팔 내리기)
  function applyRootTransform() {
    const b = S.restBox;
    const s = S.scale;
    const sign = S.flipped ? -1 : 1;
    const cx = (b.min.x + b.max.x) / 2;
    const cz = (b.min.z + b.max.z) / 2;
    orient.quaternion.copy(S.baseQuat);
    if (S.flipped) orient.quaternion.premultiply(Q_FLIP);
    root.scale.setScalar(s);
    root.position.set(-cx * s * sign, -b.min.y * s, -cz * s * sign);
    root.updateMatrixWorld(true);
  }

  function applyArmsDown() {
    const a = S.arms;
    if (!a) return;
    const left = wpos(a.left.upper).sub(wpos(a.right.upper));
    left.y = 0;
    if (left.lengthSq() < 1e-12) return;
    left.normalize();
    const fwd = new THREE.Vector3().crossVectors(left, UP);
    for (const [side, arm] of [['left', a.left], ['right', a.right]]) {
      const P = wpos(arm.upper);
      const d = wpos(arm.lower).sub(P);
      if (d.lengthSq() < 1e-14) continue;
      d.normalize();
      const out = side === 'left' ? left.clone() : left.clone().negate();
      const t = out.multiplyScalar(Math.sin(ARM_ANGLE)).add(new THREE.Vector3(0, -Math.cos(ARM_ANGLE), 0)).addScaledVector(fwd, ARM_FORWARD).normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(d, t);
      const parentQ = arm.upper.parent ? arm.upper.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
      const boneQ = arm.upper.getWorldQuaternion(new THREE.Quaternion());
      arm.upper.quaternion.copy(parentQ.invert().multiply(q.multiply(boneQ)));
      arm.upper.updateMatrixWorld(true);
    }
  }

  function restoreRest() {
    for (const [o, p, q, s] of S.rest) {
      o.position.copy(p);
      o.quaternion.copy(q);
      o.scale.copy(s);
    }
  }

  function applyPose() {
    if (!S.model) return;
    restoreRest();
    if (S.action) {
      const dur = S.action.getClip().duration || 0;
      S.action.time = THREE.MathUtils.clamp(S.clipTime, 0, 1) * dur;
      // mixer.update(0)는 지난번과 값이 달라진 속성만 장면에 쓴다 → restoreRest()로 되돌린 뼈가
      // T자세로 남는다(같은 시각 다시 적용·앞뒤 바꾸기·팔 내리기). 그래서 트랙을 직접 샘플링해 쓴다.
      for (const t of S.clipTracks) t.binding.setValue(t.interp.evaluate(S.action.time), 0);
    }
    root.updateMatrixWorld(true);
    if (S.armsDown) applyArmsDown();
    root.updateMatrixWorld(true);
    if (S.vrm?.nodeConstraintManager) {
      // VRM 1.0 노드 제약(소매·비틀림 보조 뼈)이 바뀐 팔을 따라가게 한다.
      // vrm.update()는 정규화 뼈를 원래 뼈에 덮어써 팔 내리기·동작을 되돌리므로 쓰지 않는다.
      try {
        S.vrm.nodeConstraintManager.update();
      } catch (e) {
        console.warn(e);
      }
      root.updateMatrixWorld(true);
    }
    S.measure = null;
    if (!S.userMoved) placeMainCamera();
    else requestRender();
  }

  // ---------------------------------------------------------- 모델 정리
  function unloadModel() {
    if (S.action) S.action.stop();
    if (S.mixer && S.model) {
      S.mixer.stopAllAction();
      S.mixer.uncacheRoot(S.model);
    }
    if (S.model) {
      orient.remove(S.model);
      disposeObject(S.model);
    }
    S.ctx?.revokeAll();
    Object.assign(S, {
      ctx: null, model: null, vrm: null, info: null, format: null, bones: {}, arms: null, rest: [], restBox: null,
      scale: 1, flipped: false, armsDown: false, mixer: null, clips: [], action: null, clipTracks: [], clipName: null, clipTime: 0, measure: null,
      rig: null,
    });
    S.baseQuat.identity();
    orient.quaternion.identity();
    root.position.set(0, 0, 0);
    root.scale.setScalar(1);
    requestRender();
  }

  // ---------------------------------------------------------- 형식별 불러오기
  async function parseModel(ctx, entry, check) {
    const ext = entry.ext;
    const resBase = RES_PREFIX + (ctx.modelDir ? ctx.modelDir + '/' : '');
    const readProg = (p) => status('read', p * 0.3, `파일 읽는 중… ${Math.round(p * 100)}%`);
    if (ext === 'glb' || ext === 'gltf' || ext === 'vrm') {
      const [{ GLTFLoader }, VRMMod] = await Promise.all([
        import('three/addons/loaders/GLTFLoader.js'),
        import('@pixiv/three-vrm'),
      ]);
      const buf = await readFile(entry.file, 'buffer', readProg);
      check();
      status('parse', 0.35, '모델 해석 중…');
      await nextFrame();
      const manager = makeManager(ctx);
      const loader = new GLTFLoader(manager);
      loader.register((parser) => new VRMMod.VRMLoaderPlugin(parser));
      const gltf = await loader.parseAsync(buf, resBase);
      const vrm = gltf.userData?.vrm || null;
      let model = gltf.scene || gltf.scenes?.[0];
      if (!model) throw new Error('장면(scene)이 없는 glTF입니다');
      if (vrm) {
        VRMMod.VRMUtils.rotateVRM0(vrm); // VRM0은 -Z를 바라봄 → +Z로
        model = vrm.scene;
      }
      // 텍스처를 못 찾은 재질(glTF는 map이 아예 빠짐) → 회색
      const json = gltf.parser?.json;
      model.traverse((o) => {
        for (const mat of materialsOf(o)) {
          const a = gltf.parser?.associations?.get(mat);
          const def = a && a.materials !== undefined ? json?.materials?.[a.materials] : null;
          if (def?.pbrMetallicRoughness?.baseColorTexture && !mat.map && mat.color) {
            mat.color.set(0x9a9a9a);
            mat.needsUpdate = true;
          }
        }
      });
      return { model, vrm, clips: gltf.animations || [], format: vrm ? 'vrm' : ext };
    }
    if (ext === 'fbx') {
      const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
      let buf = await readFile(entry.file, 'buffer', readProg);
      check();
      status('parse', 0.35, '모델 해석 중… (큰 FBX는 몇 초 걸립니다)');
      await nextFrame();
      const ver = fbxBinaryVersion(buf);
      if (ver && ver < 7000) {
        // 오래된 FBX 6.x 바이너리 → 7.4로 변환
        status('parse', 0.4, `오래된 FBX(${(ver / 1000).toFixed(1)}) 변환 중…`);
        await nextFrame();
        const conv = convertFbx6(buf);
        buf = conv.buffer;
        ctx.warnings.push(`오래된 FBX ${(ver / 1000).toFixed(1)} 형식이라 변환해서 열었습니다${conv.hasTakes ? ' (파일 안의 애니메이션은 제외)' : ''}`);
      }
      const manager = makeManager(ctx);
      await installHandlers(manager, ctx);
      const model = new FBXLoader(manager).parse(buf, resBase);
      return { model, vrm: null, clips: model.animations || [], format: 'fbx', manager };
    }
    if (ext === 'obj') {
      const [{ OBJLoader }, { MTLLoader }] = await Promise.all([
        import('three/addons/loaders/OBJLoader.js'),
        import('three/addons/loaders/MTLLoader.js'),
      ]);
      const text = await readFile(entry.file, 'text', readProg);
      check();
      status('parse', 0.35, '모델 해석 중…');
      await nextFrame();
      const manager = makeManager(ctx);
      await installHandlers(manager, ctx);
      const refs = [...text.matchAll(/^[ \t]*mtllib[ \t]+(.+?)[ \t]*$/gm)].map((m) => m[1]);
      let mtlEntries = [];
      for (const r of refs) {
        const e = ctx.find(r);
        if (e) mtlEntries.push(e);
        else ctx.warnings.push(`재질 파일(.mtl)을 찾지 못함: ${r.split(/[\\/]/).pop()}`);
      }
      if (!refs.length) {
        const all = ctx.entries.filter((e) => e.ext === 'mtl');
        const same = all.filter((e) => e.stem === entry.stem);
        mtlEntries = same.length ? same : all.length === 1 ? all : [];
      }
      const loader = new OBJLoader(manager);
      let creator = null;
      if (mtlEntries.length) {
        const texts = [];
        for (const e of mtlEntries) texts.push(await readFile(e.file, 'text'));
        const dir = dirOf(mtlEntries[0].path);
        creator = new MTLLoader(manager).parse(texts.join('\n'), RES_PREFIX + (dir ? dir + '/' : ''));
        creator.preload();
        loader.setMaterials(creator);
      }
      const model = loader.parse(text);
      // MTL에 없는 재질(OBJLoader 기본 흰색) → 회색
      model.traverse((o) => {
        for (const mat of materialsOf(o)) {
          const fromMtl = creator && creator.materialsInfo && mat.name in creator.materialsInfo;
          if (!fromMtl && !mat.map && !mat.vertexColors && mat.color) mat.color.set(0xb4b4b4);
        }
      });
      return { model, vrm: null, clips: [], format: 'obj', manager };
    }
    if (ext === 'pmx' || ext === 'pmd') {
      const { MMDLoader } = await import('three/addons/loaders/MMDLoader.js');
      status('read', 0.1, '파일 읽는 중…');
      const manager = makeManager(ctx);
      await installHandlers(manager, ctx);
      const loader = new MMDLoader(manager);
      loader.setResourcePath(resBase);
      const url = ctx.urlFor(entry.file);
      status('parse', 0.35, '모델 해석 중…');
      const model = await new Promise((resolve, reject) => {
        let settled = false;
        loader.load(url, (m) => { settled = true; resolve(m); }, undefined, (e) => {
          if (!settled) { settled = true; reject(e instanceof Error ? e : new Error(String(e?.message || e))); }
        });
      });
      return { model, vrm: null, clips: [], format: ext, manager };
    }
    throw new Error(`지원하지 않는 형식입니다: .${ext}`);
  }

  /** 같이 고른 다른 FBX(애니메이션 파일, 예: Mixamo)의 동작을 이 모델 뼈에 옮겨 붙인다(retargetClip) */
  async function importExtraClips(ctx, mainEntry, model, bones, check) {
    const others = ctx.entries.filter((e) => e !== mainEntry && e.ext === 'fbx' && e.file.size <= EXTRA_ANIM_BYTES).slice(0, EXTRA_ANIM_FILES);
    if (!others.length || !bones.hips) return [];
    const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
    const out = [];
    for (const e of others) {
      check();
      status('parse', 0.85, `애니메이션 확인 중… ${e.path.split('/').pop()}`);
      await nextFrame();
      let obj;
      try {
        const buf = await readFile(e.file, 'buffer');
        check();
        const v = fbxBinaryVersion(buf);
        if (v && v < 7000) continue; // FBX 6 애니메이션(Takes)은 변환하지 않음
        // 텍스처는 필요 없으므로 아무 파일도 해석하지 않는 관리자
        const m = new THREE.LoadingManager();
        const blobs = [];
        m.setURLModifier((u) => { if (typeof u === 'string' && u.startsWith('blob:')) blobs.push(u); return FAIL_URL; });
        try {
          obj = new FBXLoader(m).parse(buf, RES_PREFIX);
        } finally {
          blobs.forEach((u) => URL.revokeObjectURL(u)); // 내장 텍스처 blob — 쓰지 않으므로 바로 해제
        }
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        continue;
      }
      try {
        const clips = (obj.animations || []).filter((c) => c.duration > 0 && c.tracks.length);
        const stem = e.path.split('/').pop().replace(/\.fbx$/i, '');
        for (const clip of clips) {
          check();
          const baked = retargetClip(obj, clip, model, bones);
          if (baked) {
            baked.name = clips.length > 1 ? `${stem}: ${clip.name}` : stem;
            out.push(baked);
          }
        }
      } finally {
        disposeObject(obj);
      }
    }
    return out;
  }

  // ---------------------------------------------------------- 공개 API
  async function load(fileList) {
    if (S.disposed) throw new Error('3D 뷰어가 이미 닫혔습니다');
    const files = Array.from(fileList || []).filter((f) => f && typeof f.size === 'number' && typeof f.name === 'string');
    const seq = ++S.loadSeq;
    const check = () => { if (seq !== S.loadSeq || S.disposed) throw abortError(); };
    unloadModel();
    S.userMoved = false;
    const ctx = new FileContext(files);
    ctx.warnings = [];
    let loaded = null;
    try {
      if (!files.length) throw new Error('3D 모델 파일을 선택하세요');
      // 주 모델 파일 고르기
      let mainEntry = null;
      for (const ext of MODEL_EXTS) {
        const c = ctx.entries.filter((e) => e.ext === ext);
        if (c.length) {
          mainEntry = c.reduce((a, b) => (b.file.size > a.file.size ? b : a));
          break;
        }
      }
      if (!mainEntry) {
        throw new Error('3D 모델 파일(.glb .gltf .vrm .fbx .obj .pmx .pmd)이 없습니다. 모델 파일을 함께 선택하세요');
      }
      const modelCount = ctx.entries.filter((e) => MODEL_EXTS.includes(e.ext)).length;
      if (modelCount > 1) {
        ctx.warnings.push(`모델 파일이 여러 개라 "${mainEntry.path.split('/').pop()}"를 열었습니다. 다른 모델을 보려면 그 파일만 고르세요`);
      }
      if (mainEntry.file.size > BIG_FILE) {
        ctx.warnings.push(`파일이 큽니다(${fmtMB(mainEntry.file.size)}). 불러오기와 화면이 느릴 수 있습니다`);
        status('read', 0, `큰 파일(${fmtMB(mainEntry.file.size)})이라 시간이 걸립니다…`);
      }
      ctx.modelDir = dirOf(mainEntry.path);
      ctx.onProgress = (done, total) => {
        if (total > 0) status('textures', 0.5 + 0.35 * (done / total), `텍스처 불러오는 중… (${done}/${total})`);
      };
      S.ctx = null;
      status('read', 0, '파일 읽는 중…');
      let parsed;
      try {
        parsed = await parseModel(ctx, mainEntry, check);
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        console.error(e);
        throw new Error(koreanLoadError(e, mainEntry.ext, ctx));
      }
      loaded = parsed.model;
      check();
      status('textures', 0.5, '텍스처 불러오는 중…');
      const idle = await ctx.waitIdle();
      if (idle) ctx.revokeForeign(); // 그림은 이미 읽혀 있음 — 로더가 남긴 blob 메모리 해제
      check();
      if (!idle) ctx.warnings.push('일부 텍스처를 불러오는 데 시간이 너무 오래 걸려 기다리지 않았습니다');

      status('prepare', 0.88, '모델 정리 중…');
      const model = parsed.model;
      // 모델 안의 조명·카메라는 빼고 뷰어 조명만 쓴다
      const drop = [];
      model.traverse((o) => { if (o.isLight || o.isCamera) drop.push(o); });
      drop.forEach((o) => o.parent?.remove(o));

      // 재질 정리: 읽지 못한 텍스처 제거(검게 보이는 것 방지), 주 텍스처가 없으면 회색
      let removed = 0;
      const seenMats = new Set();
      model.traverse((o) => {
        if (o.isSkinnedMesh) o.frustumCulled = false; // 자세를 바꿔도 잘리지 않게
        for (const mat of materialsOf(o)) {
          if (seenMats.has(mat)) continue;
          seenMats.add(mat);
          let changed = false;
          for (const k of TEX_KEYS) {
            const t = prop(mat, k);
            if (t?.isTexture && !t.isRenderTargetTexture && !t.isCompressedTexture && !hasImage(t)) {
              mat[k] = null;
              t.dispose();
              removed++;
              changed = true;
              if (k === 'map') {
                if (mat.color) mat.color.set(0x9a9a9a);
                else if (mat.diffuse?.isColor) mat.diffuse.set(0x9a9a9a);
              }
            }
          }
          if (mat.isMeshStandardMaterial && !mat.envMap && (mat.metalness > 0.2 || mat.metalnessMap)) {
            mat.envMap = studioEnv();
            mat.envMapIntensity = S.brightness;
            changed = true;
          }
          // FBX/OBJ: 텍스처가 있으면 회색 Diffuse 계수(0.8 등)로 어둡게 곱하지 않는다(태거가 색을 그대로 보도록)
          if ((parsed.format === 'fbx' || parsed.format === 'obj') && mat.map && mat.color) {
            const c = mat.color;
            if (Math.abs(c.r - c.g) < 0.02 && Math.abs(c.g - c.b) < 0.02 && c.r > 0.3) { c.setRGB(1, 1, 1); changed = true; }
          }
          if (changed) mat.needsUpdate = true;
        }
      });

      // 뼈 찾기
      const bones = parsed.vrm ? findBonesVRM(parsed.vrm) : findBonesByName(model);
      orient.add(model);
      root.updateMatrixWorld(true);

      // 방향 감지: 머리-골반 = 위, 왼쪽-오른쪽 뼈 = 옆 → 앞(+Z)
      const q = new THREE.Quaternion();
      let frontConfident = false;
      if (bones.head && bones.hips) {
        const up = wpos(bones.head).sub(wpos(bones.hips));
        if (up.lengthSq() > 1e-12) {
          up.normalize();
          const axes = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map((a) => new THREE.Vector3(...a));
          const axis = axes.reduce((a, b) => (b.dot(up) > a.dot(up) ? b : a));
          if (axis.y !== 1 && axis.dot(up) > 0.7) q.setFromUnitVectors(axis, UP);
        }
      }
      const L = bones.leftUpper && bones.rightUpper ? [bones.leftUpper, bones.rightUpper] : bones.leftLeg && bones.rightLeg ? [bones.leftLeg, bones.rightLeg] : null;
      if (L) {
        const left = wpos(L[0]).sub(wpos(L[1])).applyQuaternion(q);
        left.y = 0;
        if (left.lengthSq() > 1e-12) {
          left.normalize();
          const fwd = new THREE.Vector3().crossVectors(left, UP);
          let ang = Math.atan2(fwd.x, fwd.z);
          const snapped = Math.round(ang / (Math.PI / 2)) * (Math.PI / 2);
          if (Math.abs(ang - snapped) < 0.35) ang = snapped;
          q.premultiply(new THREE.Quaternion().setFromAxisAngle(UP, -ang));
          frontConfident = true;
        }
      }
      S.baseQuat.copy(q);
      orient.quaternion.copy(q);
      S.model = model;
      S.vrm = parsed.vrm;
      S.bones = bones;
      S.format = parsed.format;

      // 휴식 자세 저장(애니메이션·팔 내리기 되돌리기용)
      const rest = [];
      model.traverse((o) => rest.push([o, o.position.clone(), o.quaternion.clone(), o.scale.clone()]));
      S.rest = rest;

      // 크기·위치 정규화(단위 자동 보정 — cm FBX, MMD 등 무엇이든 키 MODEL_H로)
      root.position.set(0, 0, 0);
      root.scale.setScalar(1);
      root.updateMatrixWorld(true);
      S.measure = null;
      const rb = computeMeasure().box;
      if (rb.isEmpty() || ![rb.min.x, rb.min.y, rb.max.x, rb.max.y].every(Number.isFinite)) {
        throw new Error('화면에 보일 메시가 없습니다. 애니메이션만 들어 있는 파일일 수 있습니다 — 캐릭터 모델 파일을 고르세요');
      }
      const size = rb.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      let s = MODEL_H / Math.max(size.y, 1e-9);
      if (maxDim * s > 20) s = 20 / maxDim;
      S.restBox = rb;
      S.scale = s;
      applyRootTransform();

      // 포즈 리그(관절 매핑) — 휴식 자세·정규화 직후(앞 +Z, 왼쪽 +X)
      try {
        const pj = parsed.vrm ? findPoseJointsVRM(parsed.vrm) : findPoseJointsByName(model, bones);
        S.rig = buildPoseRig(model, pj);
      } catch (e) {
        console.warn(e);
        S.rig = { ok: false, missing: ['관절 매핑 오류'], handsOk: false };
      }

      // 팔
      const armOk = (u, l) => u && l && wpos(u).distanceToSquared(wpos(l)) > 1e-14;
      S.arms = armOk(bones.leftUpper, bones.leftLower) && armOk(bones.rightUpper, bones.rightLower)
        ? { left: { upper: bones.leftUpper, lower: bones.leftLower }, right: { upper: bones.rightUpper, lower: bones.rightLower } }
        : null;

      // 애니메이션
      let clips = [...parsed.clips];
      if (parsed.format === 'fbx') {
        try {
          const extra = await importExtraClips(ctx, mainEntry, model, bones, check);
          check();
          if (extra.length) ctx.warnings.push(`같이 고른 다른 FBX에서 애니메이션 ${extra.length}개를 가져왔습니다(동작 목록에서 고르세요)`);
          clips = clips.concat(extra);
        } catch (e) {
          if (e?.name === 'AbortError') throw e;
          console.warn(e);
        }
      }
      const used = new Map();
      S.clips = clips.filter((c) => c && c.tracks?.length && c.duration > 0).map((clip) => {
        const base = clip.name || '동작';
        const n = (used.get(base) || 0) + 1;
        used.set(base, n);
        return { name: n > 1 ? `${base} (${n})` : base, clip };
      });
      S.mixer = S.clips.length ? new THREE.AnimationMixer(model) : null;

      // 정보
      let triangles = 0;
      let meshes = 0;
      let hasSkeleton = false;
      model.traverse((o) => {
        if (!o.isMesh || !o.geometry?.attributes?.position) return;
        meshes++;
        if (o.isSkinnedMesh) hasSkeleton = true;
        const g = o.geometry;
        const n = g.index ? g.index.count : g.attributes.position.count;
        triangles += Math.floor(n / 3) * (o.isInstancedMesh ? o.count : 1);
      });
      if (triangles > MANY_TRIS) ctx.warnings.push(`폴리곤이 많습니다(${triangles.toLocaleString('ko-KR')}개). 화면이 느릴 수 있습니다`);
      const warnings = [...ctx.warnings];
      const miss = [...ctx.missing.values()].filter(Boolean);
      for (const n of miss.slice(0, 12)) warnings.push(`텍스처를 찾지 못함: ${n}`);
      if (miss.length > 12) warnings.push(`텍스처를 찾지 못함: 그 밖에 ${miss.length - 12}개`);
      for (const n of ctx.unsupported.values()) warnings.push(`지원하지 않는 텍스처 형식: ${n} (PNG로 바꿔 같은 폴더에 두면 자동으로 씁니다)`);
      for (const n of ctx.substituted.values()) warnings.push(`텍스처 대체: ${n}`);
      if (removed && !miss.length && !ctx.unsupported.size) warnings.push(`일부 텍스처(${removed}개)를 읽지 못해 회색으로 표시합니다`);
      if (miss.length) warnings.push('텍스처 파일이 따로 있다면 [폴더 고르기]로 모델 폴더를 통째로 선택하세요');

      const meta = parsed.vrm ? vrmMeta(parsed.vrm.meta) : null;
      const stem = mainEntry.path.split('/').pop().replace(/\.[^.]+$/, '');
      S.info = {
        format: parsed.format,
        name: (meta && meta.title) || stem,
        fileName: mainEntry.path.split('/').pop(),
        fileSize: mainEntry.file.size,
        triangles,
        meshes,
        hasSkeleton,
        armsAdjustable: !!S.arms,
        poseAvailable: !!S.rig?.ok,
        handsAvailable: !!(S.rig?.ok && S.rig.handsOk),
        handsMissing: S.rig?.ok ? ['left', 'right'].filter((s) => !S.rig.hands?.[s]).map((s) => (s === 'left' ? '왼손' : '오른손')) : [],
        poseMissing: S.rig?.ok ? [] : [...(S.rig?.missing || [])],
        clips: S.clips.map((c) => c.name),
        clipDurations: S.clips.map((c) => c.clip.duration),
        meta,
        frontConfident,
        warnings,
      };
      S.ctx = ctx;
      loaded = null;
      S.measure = null;
      placeMainCamera();
      if (S.lost || renderer.getContext().isContextLost()) {
        throw new Error('그래픽(WebGL) 연결이 끊어져 3D 화면을 그릴 수 없습니다. 몇 초 뒤 다시 불러오고, 그래도 안 되면 페이지를 새로고침(⌘R)하세요');
      }
      status('done', 1, '불러오기 완료');
      return { ...S.info, clips: [...S.info.clips], warnings: [...warnings], poseMissing: [...S.info.poseMissing] };
    } catch (e) {
      // 이 불러오기가 만든 것 정리
      if (seq === S.loadSeq && S.model) unloadModel();
      else if (loaded) { loaded.parent?.remove(loaded); disposeObject(loaded); }
      ctx.revokeAll();
      if (e?.name !== 'AbortError') status('error', null, e?.message || String(e));
      throw e;
    }
  }

  function setView(view, framing) {
    if (view !== undefined && view !== null) {
      if (!VIEWS.includes(view)) console.warn('viewer3d: 알 수 없는 각도', view);
      else S.view = view;
    }
    if (framing !== undefined && framing !== null) {
      if (!FRAMINGS.includes(framing)) console.warn('viewer3d: 알 수 없는 프레이밍', framing);
      else S.framing = framing;
    }
    S.userMoved = false;
    if (S.model) placeMainCamera();
    else requestRender();
  }

  function setBackground(color) {
    try {
      bg.set(color || '#ffffff');
      S.background = color || '#ffffff';
    } catch {
      bg.set('#ffffff');
    }
    requestRender();
  }

  function setBrightness(v) {
    const b = THREE.MathUtils.clamp(Number(v) || 1, 0.3, 2);
    S.brightness = b;
    hemi.intensity = LIGHT.hemi * b;
    key.intensity = LIGHT.key * b;
    rim.intensity = LIGHT.rim * b;
    if (envRT) {
      S.model?.traverse((o) => {
        for (const m of materialsOf(o)) if (m.envMap === envRT.texture) m.envMapIntensity = b;
      });
    }
    requestRender();
  }

  function setArmsDown(on) {
    S.armsDown = !!on && !!S.arms;
    applyPose();
    return S.armsDown;
  }

  function setClip(name) {
    if (!S.model) return;
    if (S.action) {
      S.action.stop();
      S.action = null;
    }
    S.clipName = null;
    S.clipTracks = [];
    if (name != null && name !== '') {
      const c = S.clips.find((x) => x.name === name);
      if (!c) throw new Error(`애니메이션을 찾을 수 없습니다: ${name}`);
      const a = S.mixer.clipAction(c.clip);
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = true;
      a.reset().play();
      S.action = a;
      S.clipName = c.name;
      S.clipTracks = c.clip.tracks.map((track) => ({
        binding: THREE.PropertyBinding.create(S.model, track.name),
        interp: track.createInterpolant(),
      }));
    }
    applyPose();
  }

  function setClipTime(t) {
    S.clipTime = THREE.MathUtils.clamp(Number(t) || 0, 0, 1);
    if (S.action) applyPose();
  }

  function flip() {
    if (!S.model) return S.flipped;
    S.flipped = !S.flipped;
    applyRootTransform();
    applyPose();
    return S.flipped;
  }

  function checkCapture() {
    if (S.disposed) throw new Error('3D 뷰어가 이미 닫혔습니다');
    if (!S.model) throw new Error('먼저 3D 모델을 불러오세요');
    if (S.lost || renderer.getContext().isContextLost()) throw new Error('그래픽(WebGL) 연결이 끊어져 캡처할 수 없습니다. 잠시 후 다시 시도하고, 화면이 돌아오지 않으면 페이지를 새로고침(⌘R)하세요');
  }

  /** 캡처 크기 [w, h]: width/height가 없으면 size(정사각) */
  function captureSize(width, height, size) {
    const maxSize = Math.min(renderer.capabilities.maxTextureSize || 4096, 4096);
    const n = Math.round(Number(size) || 1024);
    const w = THREE.MathUtils.clamp(Math.round(Number(width) || n), 64, maxSize);
    const h = THREE.MathUtils.clamp(Math.round(Number(height) || n), 64, maxSize);
    return [w, h];
  }

  /**
   * 캡처용 카메라(비율 w/h). 각도·프레이밍을 주면 그 프리셋을 이 비율에 맞춰 다시 잡고(잘리지 않게),
   * 안 주면 지금 화면 시점(프리셋 그대로면 이 비율로 다시 맞춤, 사용자가 돌렸으면 그 시점 그대로).
   */
  function captureCamera(w, h, view, framing) {
    const A = w / h;
    const cam = new THREE.PerspectiveCamera(camera.fov, A, camera.near, camera.far);
    let target;
    let v = S.view;
    let f = S.framing;
    let custom = false;
    if (view != null || framing != null) {
      v = VIEWS.includes(view) ? view : S.view;
      f = FRAMINGS.includes(framing) ? framing : S.framing;
      target = placePreset(cam, v, f, A);
    } else if (!S.userMoved) {
      target = placePreset(cam, S.view, S.framing, A);
    } else {
      // 사용자가 돌린 시점 그대로(세로 화각 유지). 화면이 캡처보다 옆으로 넓은데 모델이 캡처 밖으로 나가면
      // 화면에 보이는 폭까지만 화각을 넓힌다.
      custom = true;
      cam.position.copy(camera.position);
      cam.quaternion.copy(camera.quaternion);
      cam.updateMatrixWorld(true);
      const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
      const box = measure().box;
      if (camera.aspect > A && !box.isEmpty()) {
        const inv = cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
        const p = new THREE.Vector3();
        let need = 0;
        for (let i = 0; i < 8; i++) {
          p.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).applyMatrix4(inv);
          need = Math.max(need, p.z < -1e-6 ? (Math.abs(p.x) * 1.03) / -p.z : Infinity);
        }
        const tanW = Math.min(need, tanV * camera.aspect);
        if (tanW > tanV * A) cam.fov = THREE.MathUtils.radToDeg(2 * Math.atan(tanW / A));
      }
      cam.updateProjectionMatrix();
      target = controls.target.clone();
    }
    cam.updateMatrixWorld(true);
    return { cam, target, view: v, framing: f, custom };
  }

  /** 오프스크린 렌더 → canvas(불투명). background를 주면 그 색으로(화면 배경은 그대로) */
  function renderCanvas(cam, target, w, h, background) {
    const rt = new THREE.WebGLRenderTarget(w, h, {
      samples: Math.min(4, renderer.capabilities.maxSamples || 0),
      colorSpace: THREE.SRGBColorSpace,
      depthBuffer: true,
    });
    const px = new Uint8Array(w * h * 4);
    const prev = renderer.getRenderTarget();
    const prevBg = scene.background;
    try {
      if (background) scene.background = new THREE.Color(background);
      aimLights(cam, target);
      renderer.setRenderTarget(rt);
      renderer.clear();
      renderer.render(scene, cam);
      renderer.setRenderTarget(prev);
      renderer.readRenderTargetPixels(rt, 0, 0, w, h, px);
    } finally {
      scene.background = prevBg;
      renderer.setRenderTarget(prev);
      rt.dispose();
      aimLights(camera, controls.target);
      requestRender();
    }
    const img = new ImageData(w, h);
    const row = w * 4;
    for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * row, (h - y) * row), y * row);
    for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
    const c2 = document.createElement('canvas');
    c2.width = w;
    c2.height = h;
    c2.getContext('2d').putImageData(img, 0, 0);
    return c2;
  }

  async function canvasBlob(c) {
    const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/png'));
    c.width = c.height = 0;
    if (!blob) throw new Error('캡처 이미지를 만들지 못했습니다');
    return blob;
  }

  async function capture({ size = 1024, width, height, view, framing } = {}) {
    checkCapture();
    const [w, h] = captureSize(width, height, size);
    const { cam, target } = captureCamera(w, h, view, framing);
    return canvasBlob(renderCanvas(cam, target, w, h));
  }

  async function captureAngles(views, { size = 1024, width, height, framing } = {}) {
    const list = (views && views.length ? views : ['front', 'left34', 'right34']).filter((v) => VIEWS.includes(v));
    const out = [];
    for (const v of list) {
      out.push({ view: v, blob: await capture({ size, width, height, view: v, framing: framing || S.framing }) });
      await nextFrame(); // 화면이 굳지 않게
    }
    return out;
  }

  /**
   * 포즈 캡처(§9.8): 같은 카메라로 흰 배경 렌더 + OpenPose 키포인트(0~1 정규화, §9.3) + standard 맵 미리보기.
   * 관절 매핑이 안 된 모델(info.poseAvailable=false)은 keypoints/preview = null, render만 → 서버 감지로 대체.
   */
  async function capturePose({ width, height, view, framing, hands = true, size } = {}) {
    checkCapture();
    const [w, h] = width || height || size ? captureSize(width, height, size) : [832, 1216]; // 기본 = 세로 832×1216
    const camInfo = captureCamera(w, h, view, framing);
    const renderC = renderCanvas(camInfo.cam, camInfo.target, w, h, '#ffffff');
    const base = { width: w, height: h, view: camInfo.view, framing: camInfo.framing, custom: camInfo.custom };
    if (!S.rig?.ok) {
      const render = await canvasBlob(renderC);
      return { ...base, available: false, keypoints: null, render, preview: null, pose: null, hands: false,
        missing: [...POSE_POINT_NAMES], unmapped: [...(S.rig?.missing || [])] };
    }
    // 키포인트는 렌더 직후 같은 자세·카메라로(중간에 await 없음 → 맵과 렌더가 정확히 겹침)
    const { keypoints, yaw } = poseKeypoints(S.rig, camInfo.cam, { hands: !!hands && S.rig.handsOk });
    const person = keypoints.people[0];
    const mapC = drawPoseMap(keypoints, w, h, { hands: true });
    const render = await canvasBlob(renderC);
    const preview = await canvasBlob(mapC);
    return {
      ...base, available: true, keypoints, render, preview, pose: preview,
      hands: !!(person.left_hand || person.right_hand),
      missing: POSE_POINT_NAMES.filter((_, i) => !person.body[i]),
      unmapped: [], faceYaw: Math.round(yaw),
    };
  }

  /** 화면에 뼈대 겹쳐 보기. → 실제로 보이는지(관절 매핑이 안 된 모델은 false) */
  function setPoseOverlay(on) {
    S.overlay = !!on;
    if (S.overlay) overlayDirty = true;
    requestRender();
    return S.overlay && !!S.rig?.ok;
  }

  /** 지금 화면 시점 기준 키포인트(겹쳐 보기와 같은 값, 디버그·미리보기용) */
  function poseKeypointsNow({ hands = true } = {}) {
    if (!S.rig?.ok) return null;
    root.updateMatrixWorld(true);
    return poseKeypoints(S.rig, camera, { hands: hands && S.rig.handsOk }).keypoints;
  }

  /** 관절 매핑 결과(뼈 이름) — 문제 확인용 */
  function poseDebug() {
    const r = S.rig;
    if (!r) return null;
    const nm = (o) => (o ? o.name || '(이름 없음)' : null);
    const out = { ok: !!r.ok, missing: [...(r.missing || [])], handsOk: !!r.handsOk, joints: {}, fingers: {}, eyeBones: !!r.face?.eyeBones, world: {}, face: r.face?.dbg || null };
    const v3 = (v) => [+v.x.toFixed(4), +v.y.toFixed(4), +v.z.toFixed(4)];
    if (r.j) for (const k of ['head', 'neck', 'headTop', 'leftEye', 'rightEye']) if (r.j[k]) out.world[k] = v3(wpos(r.j[k]));
    if (r.face && r.j?.head) for (const k of ['nose', 'leftEye', 'rightEye', 'leftEar', 'rightEar']) out.world['face_' + k] = v3(r.j.head.localToWorld(r.face[k].clone()));
    if (r.j) {
      for (const k of [...Object.keys(POSE_JOINTS), 'neck', 'leftEye', 'rightEye', 'headTop']) out.joints[k] = nm(r.j[k]);
      for (const s of ['left', 'right']) {
        out.fingers[s] = {};
        for (const k of FINGERS) {
          const f = r.hands?.[s]?.[k] || r.j.fingers?.[s]?.[k];
          out.fingers[s][k] = f ? { joints: f.joints.map(nm), tip: nm(f.tip), used: !!r.hands?.[s]?.[k] } : null;
        }
      }
    }
    return out;
  }

  function reset() {
    S.view = 'front';
    S.framing = 'full';
    S.userMoved = false;
    if (S.model) placeMainCamera();
    return { view: S.view, framing: S.framing };
  }

  function dispose() {
    if (S.disposed) return;
    S.loadSeq++;
    unloadModel();
    S.disposed = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    ro.disconnect();
    controls.dispose();
    canvas.removeEventListener('webglcontextlost', onLost);
    canvas.removeEventListener('webglcontextrestored', onRestored);
    if (envRT) envRT.dispose();
    envRT = null;
    renderer.renderLists.dispose();
    renderer.dispose();
    try { renderer.forceContextLoss(); } catch { /* 무시 */ }
    canvas.remove();
    overlay.remove();
  }

  function getState() {
    return {
      view: S.view, framing: S.framing, flipped: S.flipped, armsDown: S.armsDown, clip: S.clipName, clipTime: S.clipTime,
      background: S.background, brightness: S.brightness, userMoved: S.userMoved, loaded: !!S.model,
      poseOverlay: S.overlay,
    };
  }

  function stats() {
    const m = renderer.info.memory;
    return { geometries: m.geometries, textures: m.textures, programs: renderer.info.programs?.length || 0 };
  }

  setBrightness(1);
  requestRender();

  return {
    load,
    setView,
    setBackground,
    setBrightness,
    setArmsDown,
    setClip,
    setClipTime,
    flip,
    capture,
    captureAngles,
    capturePose,
    setPoseOverlay,
    poseKeypointsNow,
    poseDebug,
    reset,
    dispose,
    getState,
    stats,
    get info() { return S.info; },
    get flipped() { return S.flipped; },
    get canvas() { return canvas; },
  };
}
