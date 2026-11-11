// 프롬프트 추출 탭: 참고 이미지·3D 캐릭터 모델 → Danbooru 태그(태거) → 프롬프트
// 결과는 생성 탭(프롬프트 교체)·새 캐릭터(폼 채우기)·기존 캐릭터(외형/의상 교체)로 보낸다. 저장은 항상 사용자가 직접.
import {
  h, refs, clamp, lsGet, lsSet, basename, stripExt, fileUrl, qs, copyText, detectAlpha, prepareImage, SIZES, SIZE_LABELS,
} from '../util.js';
import {
  tipIcon, tipNode, helpLink, toast, openModal, openMenu, emptyState, spinner, badge, withBusy,
} from '../ui.js';
import { api } from '../api.js';
import { store, on, emit, loadTagger, loadCharacters, loadPoses, addPoseLocal } from '../store.js';
import {
  detectPose, detectSummary, detectBusyText, poseErrorInfo, poseErrorLine, toastPoseError, poseCard, sizeText, poseTitle,
} from '../pose.js';
import { thumbTile } from '../components.js';
import { replaceHash } from '../router.js';
import { TAG_CATEGORIES } from '../data/tags.js';
import { isTouch } from '../mobile.js';

const SOURCE_KEY = 'vn.extract.source';
const D3_KEY = 'vn.extract.3d';

// 표시·프롬프트 순서 (서버 응답의 groups가 있으면 그 순서를 쓴다)
const GROUP_ORDER = ['count', 'character', 'appearance', 'outfit', 'expression', 'pose', 'composition', 'background', 'other', 'meta'];
const GROUP_LABELS = {
  count: '인원', character: '캐릭터', appearance: '외형', outfit: '의상', expression: '표정', pose: '포즈',
  composition: '구도', background: '배경', other: '기타', meta: '제외 권장',
};
const GROUP_NOTES = {
  meta: '3D 렌더·서명·투명 배경·설정화처럼 원본 그림의 특성을 나타내는 태그입니다. 넣으면 결과도 그렇게 나오므로 보통 뺍니다.',
  other: '어느 묶음에도 넣지 못한 태그입니다. 소품·효과 등이 섞여 있으니 필요 없는 것은 끄세요.',
};
const GROUP_NOTES_3D = {
  pose: '3D 모델의 기본 자세(T포즈 등)라서 기본으로 뺐습니다. 원하는 포즈는 생성 탭에서 직접 적으세요.',
  composition: '캡처한 카메라 구도라서 기본으로 뺐습니다.',
  background: '뷰어 배경색이라서 기본으로 뺐습니다.',
};
// 3D 원본: 이 묶음만 기본으로 켠다 (나머지는 칩은 보이되 꺼진 상태)
const D3_ON_GROUPS = new Set(['count', 'character', 'appearance', 'outfit', 'expression', 'other']);
// 3D 원본에서 흔한 기본자세·무표정·배경·구도 태그 → 묶음과 상관없이 기본으로 끔
const D3_OFF_TAGS = new Set([
  't-pose', 'a-pose', 'outstretched arms', 'spread arms', 'simple background', 'white background', 'grey background',
  'gradient background', 'full body', 'standing', 'expressionless',
]);
// 여러 각도를 합칠 때 버리는 '그 각도에서만 나오는' 태그
const ANGLE_ONLY_TAGS = new Set(['from side', 'from behind', 'profile', 'back', 'facing away', 'looking back']);

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;
const IMAGE_TYPE_RE = /^image\/(png|jpeg|pjpeg|webp|gif|bmp|x-ms-bmp)$/i;
// 여러 개면 앞쪽 형식 우선, 같은 형식이면 가장 큰 파일 — viewer3d.js의 주 모델 고르기와 같은 규칙(안내 문구용)
const MODEL_EXTS = ['vrm', 'glb', 'gltf', 'fbx', 'pmx', 'pmd', 'obj'];
// 뷰어로 넘길 파일. psd·tif 등 미지원 텍스처도 넘겨야 뷰어가 '지원하지 않는 텍스처' 경고와 같은 이름 png 대체를 한다
const ASSET_EXT_RE = /\.(glb|gltf|vrm|fbx|obj|mtl|pmx|pmd|bin|png|jpe?g|tga|bmp|webp|gif|dds|psd|tiff?|exr|hdr|ktx2?|spa|sph|vmd)$/i;
const MAX_3D_FILES = 3000;

const RATING_LABELS = { general: '일반', sensitive: '민감', questionable: '주의', explicit: '성인' };
const RATING_KIND = { general: 'ok', sensitive: 'info', questionable: 'warn', explicit: 'bad' };

const VIEWS = [['front', '정면'], ['left34', '왼쪽 3/4'], ['right34', '오른쪽 3/4'], ['side', '옆'], ['back', '뒤']];
const VIEW_LABELS = Object.fromEntries(VIEWS);
const FRAMINGS = [['full', '전신'], ['upper', '상반신'], ['face', '얼굴']];
const BACKGROUNDS = [['#ffffff', '흰색'], ['#808080', '회색']];
// 3D 포즈 맵 크기 (생성할 그림 크기와 같게)
const POSE_SIZES = ['portrait', 'landscape', 'wide', 'square'];
// 화면 밖이면 생성 자세가 틀어지는 몸통 관절 (얼굴 점은 뒷모습·옆모습에서 원래 빠짐)
const FACE_POINT_RE = /코|눈|귀/;

let koMap = null;
function koLabel(tag) {
  if (!koMap) {
    koMap = new Map();
    for (const c of TAG_CATEGORIES) for (const [t, l] of c.tags || []) if (!koMap.has(t)) koMap.set(t, l);
  }
  return koMap.get(tag) || '';
}

/** ComfyUI 프롬프트용: 괄호는 가중치 문법이므로 \( \) 로 바꾼다 (이미 바꾼 것은 그대로) */
export function escapeTag(tag) {
  return String(tag || '').replace(/\\?([()])/g, '\\$1');
}

const extOf = (name) => {
  const m = /\.([^./\\]+)$/.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
};
const isModelFile = (f) => MODEL_EXTS.includes(extOf(f && f.name));
const isImageFile = (f) => !!f && (IMAGE_TYPE_RE.test(f.type || '') || IMAGE_EXT_RE.test(f.name || ''));
const pct = (v) => `${Math.round(clamp(Number(v) || 0, 0, 1) * 100)}%`;

/** 드롭된 항목(폴더 포함)을 File 목록으로. 반드시 drop 이벤트 안에서 동기적으로 호출을 시작해야 한다. */
function filesFromDataTransfer(dt) {
  const items = dt && dt.items ? [...dt.items] : [];
  const entries = items.map((it) => (it.kind === 'file' && typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null));
  const plain = dt && dt.files ? [...dt.files] : [];
  if (!entries.some((e) => e && e.isDirectory)) return Promise.resolve(plain);
  const out = [];
  const readFile = (entry) => new Promise((resolve) => entry.file(resolve, () => resolve(null)));
  const readBatch = (reader) => new Promise((resolve) => reader.readEntries(resolve, () => resolve([])));
  async function walk(entry, prefix) {
    if (!entry || out.length >= MAX_3D_FILES) return;
    if (entry.isFile) {
      if (!ASSET_EXT_RE.test(entry.name)) return;
      const f = await readFile(entry);
      if (!f) return;
      try {
        Object.defineProperty(f, 'webkitRelativePath', { value: prefix + f.name, configurable: true });
      } catch { /* 읽기 전용이면 그대로 */ }
      out.push(f);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await readBatch(reader);
        if (!batch.length) break;
        for (const e of batch) await walk(e, `${prefix}${entry.name}/`);
      }
    }
  }
  return (async () => {
    for (const e of entries) if (e) await walk(e, '');
    return out;
  })();
}

function clipboardImage(cd) {
  if (!cd) return null;
  for (const f of cd.files || []) if (isImageFile(f)) return f;
  for (const it of cd.items || []) {
    if (it.kind === 'file' && /^image\//.test(it.type)) {
      const f = it.getAsFile();
      if (f) return f;
    }
  }
  return null;
}

/** 여러 각도 결과를 태그별 최고 점수로 합친다 */
function mergeResults(list) {
  const best = new Map();
  const rating = {};
  let elapsed = 0;
  for (const r of list) {
    elapsed += Number(r.elapsed) || 0;
    for (const [k, v] of Object.entries(r.rating || {})) rating[k] = Math.max(rating[k] || 0, Number(v) || 0);
    for (const t of r.tags || []) {
      if (!t || !t.tag || ANGLE_ONLY_TAGS.has(t.tag)) continue;
      const prev = best.get(t.tag);
      if (!prev || t.score > prev.score) best.set(t.tag, { ...t });
    }
  }
  const first = list[0] || {};
  return {
    model: first.model, elapsed, size: first.size, source: '3d', rating,
    tags: [...best.values()].sort((a, b) => b.score - a.score),
    groups: first.groups, merged: list.length,
  };
}

function vrmText(key, v) {
  if (v == null || v === '') return '';
  if (typeof v === 'boolean') return v ? '허용' : '불가';
  const s = String(v);
  const maps = {
    commercial: {
      allow: '허용', disallow: '불가', personalnonprofit: '개인·비영리만', personalprofit: '개인의 영리 이용까지', corporation: '법인 이용까지 허용',
    },
    allowedUser: { onlyauthor: '작가 본인만', explicitlylicensedperson: '허락받은 사람만', everyone: '누구나' },
  };
  const m = maps[key];
  return (m && m[s.toLowerCase()]) || s;
}

export function createExtractView() {
  let $ = null;
  let visible = false;
  let source = lsGet(SOURCE_KEY, 'image') === '3d' ? '3d' : 'image';

  // ---- 결과 상태 ----
  let result = null; // 서버 응답 + {origin, captures}
  const overrides = new Map(); // tag -> bool (사용자가 칩을 누른 것)
  let genThr = 0.35;
  let charThr = 0.85;
  let thrTouched = false;
  let lastBuilt = '';
  let edited = false;
  let errorState = null; // {title, text, kind}
  let scrollResetPending = false;

  // ---- 작업(요청) 상태 ----
  let taskTok = 0;
  let taskCtrl = null;
  let busy = false;

  // ---- 이미지 원본 ----
  let imageUrl = ''; // 미리보기 object URL (갤러리면 /files/...)
  let lastImage = null; // {file}|{path}

  // ---- 3D ----
  let viewer = null;
  let viewerPromise = null;
  let viewerError = '';
  let info3d = null;
  let loading3d = false;
  let load3dSeq = 0;
  let model3dName = '';
  const d3saved = lsGet(D3_KEY, {}) || {};
  const d3 = {
    view: 'front',
    framing: FRAMINGS.some(([k]) => k === d3saved.framing) ? d3saved.framing : 'full',
    bg: BACKGROUNDS.some(([k]) => k === d3saved.bg) ? d3saved.bg : '#ffffff',
    brightness: clamp(Number(d3saved.brightness) || 1, 0.3, 2),
    arms: false,
    clip: '',
    clipTime: 0,
    flipped: false,
    addSide: !!d3saved.addSide,
    addBack: !!d3saved.addBack,
    poseOverlay: !!d3saved.poseOverlay,
    poseSize: POSE_SIZES.includes(d3saved.poseSize) ? d3saved.poseSize : 'portrait',
  };
  let captureUrls = [];

  // ---- 포즈 (§9.9) ----
  let poseBusy = false;
  let lastPose3d = null; // 3D에서 마지막으로 저장한 포즈 항목
  let imgPose = null; // 이미지 원본에서 감지한 포즈 {item, overlay: bool}
  let imgPoseErr = null; // {title, text, help}
  let imgPoseBusy = false;
  let imgPoseTok = 0;

  const persist3d = () => lsSet(D3_KEY, {
    framing: d3.framing, bg: d3.bg, brightness: d3.brightness, addSide: d3.addSide, addBack: d3.addBack,
    poseOverlay: d3.poseOverlay, poseSize: d3.poseSize,
  });

  // ======================= 기준값 =======================
  function settingsThresholds() {
    const s = store.settings || {};
    const g = Number(s.tagger_threshold);
    const c = Number(s.tagger_char_threshold);
    return {
      gen: isFinite(g) && g > 0 ? clamp(g, 0.05, 0.95) : 0.35,
      char: isFinite(c) && c > 0 ? clamp(c, 0.3, 0.99) : 0.85,
    };
  }
  function resetThresholds() {
    const t = settingsThresholds();
    genThr = t.gen;
    charThr = t.char;
    thrTouched = false;
  }

  // ======================= 태그 판정 =======================
  const isChar = (t) => t.kind === 'character' || t.group === 'character';
  const groupOf = (t) => (isChar(t) ? 'character' : (t.group || 'other'));
  function groupOrder() {
    const fromServer = result && Array.isArray(result.groups) ? result.groups.map((g) => (g && typeof g === 'object' ? g.id : g)).filter(Boolean) : [];
    const order = fromServer.length ? fromServer.slice() : GROUP_ORDER.slice();
    // 응답에 없는 묶음의 태그가 있으면 '제외 권장' 앞에 넣는다
    if (result) {
      for (const t of result.tags || []) {
        const g = groupOf(t);
        if (!order.includes(g)) {
          const mi = order.indexOf('meta');
          if (mi >= 0) order.splice(mi, 0, g);
          else order.push(g);
        }
      }
    }
    return order;
  }
  function groupLabel(id) {
    const fromServer = result && Array.isArray(result.groups) ? result.groups.find((g) => g && g.id === id) : null;
    return (fromServer && fromServer.label) || GROUP_LABELS[id] || id;
  }
  function visibleTags() {
    if (!result) return [];
    return (result.tags || []).filter((t) => t && t.tag && Number(t.score) >= (isChar(t) ? charThr : genThr));
  }
  function defaultOn(t) {
    if (isChar(t)) return false;
    const g = groupOf(t);
    if (result && result.source === '3d') return D3_ON_GROUPS.has(g) && !D3_OFF_TAGS.has(t.tag);
    return g !== 'meta';
  }
  const isOn = (t) => (overrides.has(t.tag) ? overrides.get(t.tag) : defaultOn(t));
  function offReason(t) {
    if (isChar(t)) return '캐릭터 태그는 기본으로 꺼져 있습니다';
    if (!result || result.source !== '3d') return groupOf(t) === 'meta' ? '원본 특성 태그라 기본으로 뺐습니다' : '';
    if (D3_OFF_TAGS.has(t.tag)) return '3D 원본에서 흔한 기본자세·무표정·배경·구도 태그라 기본으로 뺐습니다';
    if (!D3_ON_GROUPS.has(groupOf(t))) return '3D 원본에서는 이 묶음을 기본으로 뺍니다';
    return '';
  }
  function tagsIn(group, { onlyOn = true } = {}) {
    return visibleTags().filter((t) => groupOf(t) === group && (!onlyOn || isOn(t))).sort((a, b) => b.score - a.score);
  }
  const joinTags = (list) => list.map((t) => escapeTag(t.tag)).join(', ');
  function buildPrompt() {
    const out = [];
    for (const g of groupOrder()) for (const t of tagsIn(g)) out.push(escapeTag(t.tag));
    return out.join(', ');
  }

  function originLabel() {
    if (!result || !result.origin) return '';
    return result.origin.name || '';
  }

  // ======================= 요청 =======================
  async function postInterrogate(body, signal) {
    return api('/api/interrogate', { method: 'POST', body, silent: true, signal, timeout: 120000 });
  }
  function busyLabel(defaultText) {
    const tg = store.tagger;
    if (!tg || !tg.loaded) return '태거 모델 불러오는 중… (처음 한 번은 몇 초 걸립니다)';
    return defaultText || '태그를 뽑는 중…';
  }

  /** label: 문구 또는 문구를 만드는 함수(태거 상태를 다시 확인한 뒤 한 번 더 부름). retry: 오류 패널의 [다시 시도] */
  async function runTask(label, fn, retry = null) {
    const tok = ++taskTok;
    const taskSource = source;
    if (taskCtrl) taskCtrl.abort();
    const ctrl = new AbortController();
    taskCtrl = ctrl;
    busy = true;
    errorState = null;
    renderBusy(typeof label === 'function' ? label() : label);
    update3dButtons();
    try {
      // 서버는 15분 동안 안 쓰면 태거를 내린다 → 지금 올라와 있는지 다시 확인(가벼운 GET)해서
      // busyLabel이 '불러오는 중(몇 초)' 안내를 맞게 고르도록 한다
      await loadTagger();
      if (tok !== taskTok) return;
      if (typeof label === 'function') renderBusy(label());
      const res = await fn(ctrl.signal, (msg) => { if (tok === taskTok) renderBusy(msg); });
      if (tok !== taskTok || !res) return;
      setResult(res);
    } catch (e) {
      if (tok !== taskTok || (e && (e.aborted || e.name === 'AbortError'))) return;
      showError(e, { source: taskSource, retry });
    } finally {
      if (tok === taskTok) {
        busy = false;
        taskCtrl = null;
        renderResults();
        update3dButtons();
      }
    }
  }

  function showError(e, { source: src = source, retry = null } = {}) {
    const status = e && e.status;
    const msg = (e && e.message) || '태그를 뽑지 못했습니다.';
    if (status === 503) {
      errorState = { kind: 'setup', title: '태거를 사용할 수 없습니다', text: msg };
    } else if (status === 404 && /주소|찾을 수 없/.test(msg) && !/이미지|파일/.test(msg)) {
      errorState = { kind: 'setup', title: '서버가 아직 프롬프트 추출을 지원하지 않습니다', text: 'VN Studio를 다시 시작한 뒤 시도해 주세요.' };
    } else {
      errorState = { kind: 'error', title: '태그를 뽑지 못했습니다', text: msg, source: src, retry };
      toast(msg, 'error', { title: '프롬프트 추출' });
    }
    result = null;
    loadTagger();
  }

  function setResult(r) {
    for (const u of captureUrls) if (!(r.captures || []).some((c) => c.url === u)) URL.revokeObjectURL(u);
    captureUrls = (r.captures || []).map((c) => c.url).filter(Boolean);
    result = r;
    overrides.clear();
    edited = false;
    errorState = null;
    scrollResetPending = true;
    if (!thrTouched) resetThresholds();
    if (store.tagger && r.model) store.tagger.loaded = r.model;
    renderResults();
    if ($ && result && window.innerWidth <= 900) {
      try { $.results.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch { /* 무시 */ }
    }
  }

  // ======================= 이미지 원본 =======================
  function setPreview(url, name, note = '') {
    if (imageUrl && imageUrl.startsWith('blob:') && imageUrl !== url) URL.revokeObjectURL(imageUrl);
    if (url !== imageUrl) {
      imgPoseTok++;
      imgPose = null;
      imgPoseErr = null;
      imgPoseBusy = false;
    }
    imageUrl = url;
    if (!$) return;
    renderImgPose();
    $.dropPh.hidden = !!url;
    $.previewWrap.hidden = !url;
    $.previewImg.classList.remove('loaded');
    $.previewWrap.classList.remove('checker');
    if (url) {
      $.previewImg.src = url;
      $.previewImg.alt = name || '';
      $.previewName.textContent = name || '';
      $.previewNote.textContent = note;
      $.previewNote.hidden = !note;
    } else {
      $.previewImg.removeAttribute('src');
    }
    $.rerun.hidden = !lastImage;
  }

  async function runImageFile(file, name) {
    if (!isImageFile(file)) {
      toast('지원하지 않는 형식입니다. PNG·JPG·WEBP·GIF·BMP 이미지를 넣어 주세요.', 'warn');
      return;
    }
    setSource('image');
    const label = name || file.name || '이미지';
    lastImage = { file, name: label };
    setPreview(URL.createObjectURL(file), label);
    await runTask(busyLabel, async (signal, progress) => {
      let prep;
      try {
        prep = await prepareImage(file);
      } catch (e) {
        throw Object.assign(new Error((e && e.message) || '이미지를 읽을 수 없습니다.'), { status: 400 });
      }
      if (prep.resized && $) {
        $.previewNote.textContent = `${prep.from[0]}×${prep.from[1]} → ${prep.width}×${prep.height}로 줄여서 보냈습니다 (태거는 448px로 보므로 결과는 같습니다)`;
        $.previewNote.hidden = false;
      }
      progress(busyLabel());
      const fd = new FormData();
      const fname = prep.resized ? `${stripExt(file.name || 'image') || 'image'}.${prep.blob.type === 'image/jpeg' ? 'jpg' : 'png'}` : (file.name || 'image.png');
      fd.append('image', prep.blob, fname);
      fd.append('source', 'image');
      const r = await postInterrogate(fd, signal);
      return { ...r, source: r.source || 'image', origin: { kind: 'image', name: label } };
    }, rerunImage);
  }

  async function runPath(path) {
    const p = String(path || '').replace(/^\/+/, '').replace(/^output\//, '');
    if (!p) return;
    setSource('image');
    lastImage = { path: p, name: basename(p) };
    setPreview(fileUrl(p), basename(p), `output/${p}`);
    await runTask(busyLabel, async (signal) => {
      const r = await postInterrogate({ path: p, source: 'image' }, signal);
      return { ...r, source: r.source || 'image', origin: { kind: 'image', name: basename(p), path: p } };
    }, rerunImage);
  }

  function rerunImage() {
    if (!lastImage) return;
    if (lastImage.path) runPath(lastImage.path);
    else if (lastImage.file) runImageFile(lastImage.file, lastImage.name);
  }

  // ---- 갤러리에서 고르기 ----
  function openGalleryPicker() {
    const PAGE = 48;
    let folder = lsGet('vn.extract.pickFolder', '') || '';
    let q = '';
    let offset = 0;
    let done = false;
    let loading = false;
    let gen = 0;
    const folderSel = h('select', { class: 'select select-sm', 'aria-label': '폴더' }, h('option', { value: '' }, '모든 폴더'));
    const search = h('input', { type: 'search', class: 'ex-pick-search', placeholder: '파일 이름·프롬프트 검색', 'aria-label': '검색' });
    const grid = h('div', { class: 'thumb-grid thumb-grid-sm ex-pick-grid', role: 'list' });
    const status = h('div', { class: 'grid-status' });
    const more = h('button', { type: 'button', class: 'btn btn-ghost btn-block more-btn', hidden: true }, '더 보기');
    const body = h('div', { class: 'ex-pick' },
      h('div', { class: 'ex-pick-bar' }, folderSel, search),
      h('p', { class: 'field-note' }, '태그를 뽑을 이미지를 누르세요.'),
      grid, status, more);
    let ctl = null;
    const pick = (it) => {
      if (ctl) ctl.close();
      runPath(it.path);
    };
    async function load(reset) {
      if (reset) {
        gen++;
        offset = 0;
        done = false;
        loading = false;
        grid.replaceChildren();
      }
      if (loading || done) return;
      const my = gen;
      loading = true;
      status.replaceChildren(spinner('이미지를 불러오는 중…'));
      more.hidden = true;
      try {
        const r = await api('/api/gallery' + qs({ folder, q, limit: PAGE, offset }), { silent: true });
        if (my !== gen) return;
        const items = Array.isArray(r.items) ? r.items : [];
        offset += items.length;
        done = items.length < PAGE || (typeof r.total === 'number' && offset >= r.total);
        if (folderSel.options.length <= 1 && Array.isArray(r.folders)) {
          const list = r.folders.slice();
          if (folder && !list.includes(folder)) list.unshift(folder);
          for (const d of list) folderSel.append(h('option', { value: d }, `output/${d}`));
          folderSel.value = folder;
        }
        const frag = document.createDocumentFragment();
        for (const it of items) frag.append(thumbTile(it, { onOpen: pick }));
        grid.append(frag);
        status.replaceChildren();
        if (!grid.children.length) status.append(emptyState({ icon: '▢', title: '이미지가 없습니다', text: folder || q ? '다른 폴더나 검색어를 써 보세요.' : '먼저 생성 탭에서 이미지를 만들어 보세요.' }));
        more.hidden = done;
      } catch (e) {
        if (my !== gen) return;
        status.replaceChildren(h('div', { class: 'grid-error' }, h('span', {}, (e && e.message) || '이미지 목록을 불러오지 못했습니다.'),
          h('button', { type: 'button', class: 'btn btn-sm', onclick: () => { loading = false; load(!grid.children.length); } }, '다시 시도')));
      } finally {
        if (my === gen) loading = false;
      }
    }
    folderSel.addEventListener('change', () => {
      folder = folderSel.value;
      lsSet('vn.extract.pickFolder', folder);
      load(true);
    });
    let st = null;
    search.addEventListener('input', () => {
      clearTimeout(st);
      st = setTimeout(() => {
        q = search.value.trim();
        load(true);
      }, 300);
    });
    more.addEventListener('click', () => load(false));
    ctl = openModal({ title: '갤러리에서 고르기', body, size: 'xl', className: 'ex-pick-modal' });
    load(true);
  }

  // ======================= 3D 원본 =======================
  function viewerCall(name, ...args) {
    if (!viewer || typeof viewer[name] !== 'function') return undefined;
    try {
      return viewer[name](...args);
    } catch (e) {
      console.error(e);
      toast(`3D 뷰어 오류: ${(e && e.message) || e}`, 'error');
      return undefined;
    }
  }
  // '앞뒤 바꾸기'는 뷰어 구현에 따라 이름이 다를 수 있어 있는 것을 찾아 쓴다
  function flipFn() {
    if (!viewer) return null;
    if (typeof viewer.setFlipped === 'function') return () => viewer.setFlipped(d3.flipped);
    if (typeof viewer.setFlip === 'function') return () => viewer.setFlip(d3.flipped);
    if (typeof viewer.flip === 'function') return () => viewer.flip();
    if (typeof viewer.toggleFlip === 'function') return () => viewer.toggleFlip();
    return null;
  }

  function onStatus(s) {
    if (!$ || !s) return;
    const phase = s.phase || '';
    // 취소된 앞 불러오기가 늦게 보내는 진행 상황(텍스처 n/m 등)이 다 불러온 모델의 상태 줄을 덮지 않도록
    if (!loading3d && /^(loading|read|parse|textures|prepare)$/.test(phase)) return;
    const msg = s.message || '';
    let p = Number(s.progress);
    if (!isFinite(p)) p = NaN;
    else if (p > 1) p /= 100;
    const done = phase === 'done' || phase === 'ready' || phase === 'loaded' || phase === 'restored';
    const err = phase === 'error';
    $.status3d.hidden = !msg && (done || !phase);
    $.status3dText.textContent = msg || (done ? '' : '불러오는 중…');
    $.status3d.classList.toggle('is-error', err);
    $.status3d.classList.toggle('is-warn', phase === 'warn' || phase === 'warning');
    $.status3dBar.parentElement.classList.toggle('indeterminate', !isFinite(p) && !done && !err);
    $.status3dBar.parentElement.hidden = done || err || phase === 'warn' || phase === 'warning';
    $.status3dBar.style.width = isFinite(p) ? `${Math.round(clamp(p, 0, 1) * 100)}%` : '35%';
    if (done && !msg) $.status3d.hidden = true;
  }

  function render3dPlaceholder() {
    if (!$) return;
    const ph = $.viewerPh;
    ph.replaceChildren();
    if (viewerError) {
      ph.hidden = false;
      ph.classList.add('is-error');
      ph.append(emptyState({
        icon: '!',
        title: '3D 뷰어를 불러오지 못했습니다',
        text: `${viewerError} — 새로고침(⌘R)한 뒤 다시 시도해 보세요. 계속되면 [이미지] 모드로 캐릭터 그림을 넣어 추출할 수 있습니다.`,
        actions: [
          h('button', { type: 'button', class: 'btn btn-sm', onclick: () => { viewerError = ''; ensureViewer().catch(() => {}); } }, '다시 시도'),
          h('a', { class: 'btn btn-sm btn-ghost', href: '#/help/extract-3d' }, '도움말'),
        ],
      }));
      return;
    }
    ph.classList.remove('is-error');
    if (!viewer) {
      ph.hidden = false;
      ph.append(spinner('3D 뷰어를 준비하는 중…'));
      return;
    }
    if (!info3d && !loading3d) {
      ph.hidden = false;
      ph.append(h('div', { class: 'ex-drop-ph' },
        h('div', { class: 'ex-drop-icon', 'aria-hidden': 'true' }, '⬡'),
        h('div', { class: 'ex-drop-title' }, '3D 모델 파일이나 폴더를 끌어다 놓으세요'),
        h('div', { class: 'ex-drop-text' }, '또는 위의 [파일 고르기]·[폴더 고르기]. 텍스처가 따로 있는 FBX·OBJ·PMX는 폴더째 고르면 함께 읽습니다.'),
        h('div', { class: 'ex-drop-formats' }, '.vrm  .glb  .gltf  .fbx  .obj(+.mtl)  .pmx  .pmd')));
      return;
    }
    ph.hidden = true;
  }

  async function ensureViewer() {
    if (viewer) return viewer;
    if (!viewerPromise) {
      viewerError = '';
      render3dPlaceholder();
      viewerPromise = (async () => {
        let mod;
        try {
          mod = await import('../viewer3d.js');
        } catch (e) {
          console.error(e);
          throw new Error(`3D 뷰어 모듈을 읽지 못했습니다 (${(e && e.message) || e})`);
        }
        if (!mod || typeof mod.createViewer !== 'function') throw new Error('3D 뷰어 모듈(viewer3d.js)의 형식이 올바르지 않습니다.');
        const v = await mod.createViewer($.viewerBox, { onStatus });
        if (!v) throw new Error('3D 뷰어를 만들지 못했습니다.');
        return v;
      })();
    }
    try {
      viewer = await viewerPromise;
    } catch (e) {
      viewerPromise = null;
      viewerError = (e && e.message) || String(e);
      render3dPlaceholder();
      update3dButtons();
      throw e;
    }
    try {
      viewer.setBackground(d3.bg);
      viewer.setBrightness(d3.brightness);
      if (typeof viewer.setPoseOverlay === 'function') viewer.setPoseOverlay(d3.poseOverlay);
    } catch (e) {
      console.error(e);
    }
    render3dPlaceholder();
    render3dToolbar();
    update3dButtons();
    return viewer;
  }

  async function load3d(list) {
    let files = [...(list || [])].filter((f) => f && f.name && !f.name.startsWith('.'));
    if (files.length > MAX_3D_FILES) files = files.filter((f) => ASSET_EXT_RE.test(f.name)).slice(0, MAX_3D_FILES);
    const models = files.filter(isModelFile);
    if (!models.length) {
      const imgs = files.filter(isImageFile);
      if (imgs.length === 1 && files.length === 1) {
        runImageFile(imgs[0]);
        return;
      }
      toast('3D 모델 파일(.vrm .glb .gltf .fbx .obj .pmx .pmd)을 찾지 못했습니다. 모델 파일을 함께 골라 주세요.', 'warn');
      return;
    }
    // 주 모델은 뷰어가 고른다(다른 FBX의 동작을 애니메이션으로 가져오려면 모델 파일을 모두 넘겨야 함).
    // 여기서는 같은 규칙으로 이름만 미리 알아 둔다(안내 문구용).
    const rank = (f) => MODEL_EXTS.indexOf(extOf(f.name));
    const main = models.reduce((a, b) => (rank(b) < rank(a) || (rank(b) === rank(a) && b.size > a.size) ? b : a));
    const pass = files.filter((f) => ASSET_EXT_RE.test(f.name));
    if (models.length > 1) {
      const extraFbx = extOf(main.name) === 'fbx' ? models.filter((f) => f !== main && extOf(f.name) === 'fbx').length : 0;
      toast(extraFbx
        ? `모델 파일이 ${models.length}개 있어 가장 큰 FBX인 '${main.name}'을(를) 캐릭터로 엽니다. 함께 고른 다른 FBX 파일(40MB 이하)의 동작은 [애니메이션] 목록에 추가됩니다. 다른 모델을 보려면 그 파일만 따로 고르세요.`
        : `모델 파일이 ${models.length}개 있어 '${main.name}'을(를) 엽니다. 다른 모델을 보려면 그 파일만 따로 고르세요.`,
      'info', { timeout: 9000 });
    }
    setSource('3d');
    let v;
    try {
      v = await ensureViewer();
    } catch {
      return;
    }
    const my = ++load3dSeq; // 불러오는 중에 다른 모델을 고르면 앞의 불러오기 결과·오류는 버린다
    loading3d = true;
    info3d = null;
    render3dPlaceholder();
    render3dInfo();
    render3dToolbar();
    update3dButtons();
    onStatus({ phase: 'loading', message: `'${main.name}' 불러오는 중…` });
    try {
      const inf = await v.load(pass);
      if (my !== load3dSeq) return;
      info3d = inf || {};
      model3dName = info3d.name || stripExt(main.name);
      d3.view = 'front';
      d3.arms = false;
      d3.clip = '';
      d3.clipTime = 0;
      d3.flipped = false;
      lastPose3d = null; // 앞 모델에서 저장한 포즈 안내는 지운다
      viewerCall('setBackground', d3.bg);
      viewerCall('setBrightness', d3.brightness);
      viewerCall('setView', d3.view, d3.framing);
      onStatus({ phase: 'done' });
      if (errorState && errorState.kind === 'error') { // 이전 원본·모델의 추출 오류는 새 모델과 상관없다
        errorState = null;
        renderResults();
      }
      const warns = (info3d.warnings || []).length;
      toast(`'${model3dName}'을(를) 불러왔습니다.${warns ? ` 경고 ${warns}개가 있습니다(아래 정보 줄 참고).` : ''} 각도를 맞춘 뒤 [이 각도로 추출]이나 [여러 각도로 추출]을 누르세요.`, warns ? 'warn' : 'success', { timeout: 7000 });
    } catch (e) {
      // 다른 모델을 불러오기 시작해 취소된 것은 오류가 아니다 (뒤의 불러오기가 상태를 맡는다)
      if (my === load3dSeq) {
        info3d = null;
        if (e && e.name === 'AbortError') {
          onStatus({ phase: 'done' });
        } else {
          console.error(e);
          const msg = (e && e.message) || '3D 모델을 불러오지 못했습니다.';
          onStatus({ phase: 'error', message: msg });
          toast(msg, 'error', { title: '3D 모델 불러오기 실패' });
        }
      }
    } finally {
      if (my === load3dSeq) {
        loading3d = false;
        render3dPlaceholder();
        render3dInfo();
        render3dToolbar();
        update3dButtons();
      }
    }
  }

  function render3dInfo() {
    if (!$) return;
    const box = $.info3d;
    box.replaceChildren();
    if (!info3d) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const i = info3d;
    const parts = [];
    if (i.format) parts.push(badge(String(i.format).toUpperCase(), 'accent'));
    parts.push(h('span', { class: 'ex-info-name' }, model3dName || i.name || ''));
    if (i.triangles != null) parts.push(h('span', {}, `삼각형 ${Number(i.triangles).toLocaleString('ko-KR')}개`));
    if (i.meshes != null) parts.push(h('span', {}, `메시 ${i.meshes}개`));
    parts.push(h('span', {}, i.hasSkeleton ? '뼈대 있음' : '뼈대 없음'));
    if (i.clips && i.clips.length) parts.push(h('span', {}, `애니메이션 ${i.clips.length}개`));
    box.append(h('div', { class: 'ex-info-line' }, parts));
    if (i.frontConfident === false) {
      box.append(h('div', { class: 'field-note' }, '모델의 앞 방향을 확실히 알 수 없습니다. [정면]에서 뒷모습이 보이면 [앞뒤 바꾸기]를 누르세요.'));
    }
    const warns = Array.isArray(i.warnings) ? i.warnings.filter(Boolean) : [];
    if (warns.length) {
      const shown = warns.slice(0, 4);
      const det = h('div', { class: 'ex-info-warn' },
        h('span', { class: 'ex-warn-icon', 'aria-hidden': 'true' }, '!'),
        h('div', {}, shown.map((w) => h('div', {}, String(w))),
          warns.length > shown.length ? h('details', {}, h('summary', {}, `외 ${warns.length - shown.length}개 더 보기`),
            warns.slice(shown.length).map((w) => h('div', {}, String(w)))) : null,
          /텍스처를 찾지 못함|지원하지 않는 텍스처|텍스처.*읽지 못해/.test(warns.join(' ')) ? h('div', { class: 'muted small' }, '텍스처가 없으면 색이 회색으로 보여 머리·눈 색 태그가 틀릴 수 있습니다. 모델이 든 폴더를 [폴더 고르기]로 통째로 골라 보세요.') : null));
      box.append(det);
    }
    const m = i.meta;
    if (m && typeof m === 'object') {
      const rows = [
        ['제목', m.title || m.name],
        ['작가', m.author || (Array.isArray(m.authors) ? m.authors.join(', ') : '')],
        ['버전', m.version],
        ['라이선스', m.license],
        ['라이선스 주소', m.licenseUrl],
        ['추가 조건', m.otherLicenseUrl],
        ['상업 이용', vrmText('commercial', m.commercial)],
        ['아바타 이용', vrmText('allowedUser', m.allowedUser)],
        ['재배포', m.redistribution],
        ['수정', m.modification],
        ['크레딧 표기', m.credit],
        ['저작권', m.copyright],
        ['연락처', m.contact],
        ['참고', m.reference],
      ].filter(([, v]) => v != null && v !== '');
      const dl = h('dl', { class: 'kv ex-meta-kv' });
      for (const [k, v] of rows) dl.append(h('dt', {}, k), h('dd', {}, String(v)));
      const brief = [
        m.author ? `작가 ${m.author}` : '',
        m.license ? `라이선스 ${m.license}` : '',
        m.commercial ? `상업 이용 ${vrmText('commercial', m.commercial)}` : '',
      ].filter(Boolean).join(' · ');
      box.append(h('div', { class: 'ex-meta' },
        h('details', { class: 'ex-meta-det' },
          h('summary', { class: 'ex-meta-title' }, `모델 정보 (VRM 메타)${brief ? ` — ${brief}` : ''}`),
          rows.length ? dl : h('div', { class: 'muted small' }, '메타 정보가 비어 있습니다.')),
        m.commercialAllowed === false ? h('div', { class: 'ex-meta-bad' }, '이 모델은 상업 이용이 허용되지 않습니다. 판매·유료 배포할 게임에는 이 모델을 바탕으로 만든 그림을 쓰지 마세요.') : null,
        h('div', { class: 'ex-meta-note' }, '모델 이용 약관을 확인하세요. 추출한 태그로 만든 그림에도 이 모델의 디자인이 반영되므로, 배포·상업 이용 전에 작가가 정한 조건을 지켜야 합니다.')));
    }
  }

  // 버튼은 처음 한 번만 만들고 이후에는 눌림 상태만 바꾼다 (다시 만들면 키보드 초점이 사라짐)
  function segButtons(box, list, cur, onPick, { label } = {}) {
    if (box.childElementCount !== list.length) {
      box.replaceChildren();
      for (const [k, text] of list) {
        const b = h('button', { type: 'button', class: 'seg-btn', 'data-k': k }, text);
        b.addEventListener('click', () => onPick(k));
        box.append(b);
      }
      if (label) box.setAttribute('aria-label', label);
    }
    for (const b of box.children) {
      const on_ = b.dataset.k === cur;
      b.classList.toggle('active', on_);
      b.setAttribute('aria-pressed', on_ ? 'true' : 'false');
    }
  }

  function render3dToolbar() {
    if (!$) return;
    const ready = !!viewer && !!info3d && !loading3d;
    $.toolbar3d.classList.toggle('is-disabled', !ready);
    segButtons($.viewSeg, VIEWS, d3.view, (k) => {
      d3.view = k;
      viewerCall('setView', d3.view, d3.framing);
      render3dToolbar();
    }, { label: '각도' });
    segButtons($.framingSeg, FRAMINGS, d3.framing, (k) => {
      d3.framing = k;
      persist3d();
      viewerCall('setView', d3.view, d3.framing);
      render3dToolbar();
    }, { label: '프레이밍' });
    segButtons($.bgSeg, BACKGROUNDS, d3.bg, (k) => {
      d3.bg = k;
      persist3d();
      viewerCall('setBackground', d3.bg);
      render3dToolbar();
    }, { label: '배경' });
    $.flipWrap.hidden = !flipFn();
    $.flipBtn.setAttribute('aria-pressed', d3.flipped ? 'true' : 'false');
    $.flipBtn.classList.toggle('active', d3.flipped);
    $.brightness.value = String(d3.brightness);
    $.brightnessVal.textContent = `${Math.round(d3.brightness * 100)}%`;
    $.armsWrap.hidden = !(info3d && info3d.armsAdjustable);
    $.armsBtn.setAttribute('aria-pressed', d3.arms ? 'true' : 'false');
    $.armsBtn.classList.toggle('active', d3.arms);
    $.armsBtn.textContent = d3.arms ? '팔 내림 ✓' : '팔 내리기';
    const clips = (info3d && Array.isArray(info3d.clips) ? info3d.clips : []).filter(Boolean);
    $.clipWrap.hidden = !clips.length;
    if (clips.length) {
      const sel = $.clipSel;
      const key = clips.join('\n');
      if (sel.dataset.key !== key) {
        sel.dataset.key = key;
        sel.replaceChildren(h('option', { value: '' }, '애니메이션 없음 (기본 자세)'));
        for (const c of clips) sel.append(h('option', { value: c }, String(c)));
      }
      sel.value = d3.clip;
      $.clipTime.disabled = !d3.clip;
      $.clipTime.value = String(d3.clipTime);
    }
    $.addSide.checked = d3.addSide;
    $.addBack.checked = d3.addBack;
    for (const el of $.toolbar3d.querySelectorAll('button:not(.tip-i), input, select')) el.disabled = !ready || (el === $.clipTime && !d3.clip);
    renderPose3d();
  }

  function update3dButtons() {
    if (!$) return;
    const ready = !!viewer && !!info3d && !loading3d;
    $.captureOne.disabled = !ready || busy;
    $.captureMulti.disabled = !ready || busy;
    const reason = !viewer ? (viewerError ? '3D 뷰어를 불러오지 못했습니다' : '3D 뷰어를 준비하는 중입니다')
      : loading3d ? '모델을 불러오는 중입니다'
        : !info3d ? '먼저 3D 모델을 불러오세요'
          : busy ? '추출하는 중입니다' : '';
    for (const w of [$.captureOneWrap, $.captureMultiWrap]) {
      if (reason) w.dataset.tooltip = reason;
      else delete w.dataset.tooltip;
    }
    renderPose3d();
  }

  // ======================= 3D → 포즈 =======================
  const poseAvailable3d = () => !!info3d && info3d.poseAvailable !== false;
  function renderPose3d() {
    if (!$) return;
    const ready = !!viewer && !!info3d && !loading3d;
    const reason = !viewer ? (viewerError ? '3D 뷰어를 불러오지 못했습니다' : '3D 뷰어를 준비하는 중입니다')
      : loading3d ? '모델을 불러오는 중입니다'
        : !info3d ? '먼저 3D 모델을 불러오세요'
          : poseBusy ? '포즈를 만드는 중입니다' : '';
    const avail = poseAvailable3d();
    $.poseSaveBtn.disabled = !ready || poseBusy;
    $.poseSendBtn.disabled = !ready || poseBusy;
    $.poseOverlayBtn.disabled = !ready;
    $.poseSizeSel.disabled = !ready || poseBusy;
    $.poseSizeSel.value = d3.poseSize;
    const viaDetect = ready && !avail;
    const tipSave = viaDetect ? '관절을 찾지 못한 모델이라 화면 렌더 이미지에서 자세를 감지해 저장합니다' : '지금 화면의 자세·각도를 포즈로 저장합니다';
    const tipSend = viaDetect ? '렌더 이미지에서 자세를 감지해 저장한 뒤 생성 탭으로 보냅니다' : '포즈를 저장한 뒤 생성 탭으로 보냅니다 (추출한 프롬프트가 있으면 함께)';
    $.poseSaveWrap.dataset.tooltip = reason || tipSave;
    $.poseSendWrap.dataset.tooltip = reason || tipSend;
    if (reason) $.poseOverlayWrap.dataset.tooltip = reason;
    else if (!avail) $.poseOverlayWrap.dataset.tooltip = '이 모델은 관절을 찾지 못해 뼈대를 겹쳐 볼 수 없습니다 (켜 두면 다음 모델에서 보입니다)';
    else delete $.poseOverlayWrap.dataset.tooltip;
    $.poseViaDetect.hidden = !viaDetect;
    const on_ = d3.poseOverlay;
    $.poseOverlayBtn.setAttribute('aria-pressed', on_ ? 'true' : 'false');
    $.poseOverlayBtn.classList.toggle('active', on_);
    $.poseOverlayBtn.textContent = on_ ? '뼈대 보기 ✓' : '뼈대 보기';
    // 안내: 관절 매핑 실패 / 손가락 없음 / 상반신에서 T자 팔이 잘림
    const notes = [];
    if (ready && !avail) {
      const miss = Array.isArray(info3d.poseMissing) ? info3d.poseMissing.filter(Boolean) : [];
      notes.push(['warn', `이 모델은 관절(뼈)을 자동으로 찾지 못했습니다${miss.length ? ` — ${miss.slice(0, 8).join(', ')}${miss.length > 8 ? ` 외 ${miss.length - 8}개` : ''}` : ''}. 뼈대 겹쳐 보기는 할 수 없고, [포즈 저장]·[이 포즈로 생성…]은 화면을 렌더한 그림에서 자세를 감지하는 방식으로 동작합니다(처음 한 번은 10초쯤).`, 'pose-3d-detect']);
    } else if (ready && info3d.handsAvailable === false) {
      notes.push(['info', '손가락 뼈를 찾지 못해 손 뼈대는 빼고 저장합니다(팔·다리·몸 방향은 그대로).', 'ts-pose-hands']);
    }
    if (ready && d3.framing === 'upper' && info3d.armsAdjustable && !d3.arms) {
      notes.push(['warn', '상반신 프레이밍에서는 옆으로 벌린 팔(T자 자세)이 화면 밖으로 잘립니다. [팔 내리기]를 누르거나 전신으로 바꾸세요.', 'pose-3d-controls']);
    }
    $.poseNotice.replaceChildren();
    for (const [kind, text, help] of notes) {
      $.poseNotice.append(h('div', { class: `ex-pose-note is-${kind}` },
        h('span', { class: 'ex-warn-icon', 'aria-hidden': 'true' }, kind === 'warn' ? '!' : 'i'),
        h('span', {}, text),
        h('a', { class: 'help-link', href: `#/help/${help}`, title: '도움말에서 자세히 보기' }, '? 설명')));
    }
    $.poseNotice.hidden = !notes.length;
    renderPoseLast();
  }

  function renderPoseLast() {
    if (!$) return;
    const box = $.poseLast;
    box.replaceChildren();
    if (!lastPose3d) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const go = h('button', { type: 'button', class: 'btn btn-sm' }, '생성 탭으로');
    go.addEventListener('click', () => sendPoseToGenerate(lastPose3d, { withPrompt: false }));
    const framing = lastPose3d.framing || '';
    // 일부러 고른 프레이밍에서 빠지는 관절은 알리지 않는다 (상반신 → 무릎·발목)
    const skip = framing === 'upper' ? /무릎|발목/ : framing === 'face' ? /무릎|발목|엉덩이|팔꿈치|손목/ : null;
    const miss = (lastPose3d.__missing || []).filter((n) => !FACE_POINT_RE.test(n) && !(skip && skip.test(n)));
    const tips = [];
    if (framing !== 'full') tips.push('전신 프레이밍');
    const arms = lastPose3d.__arms != null ? lastPose3d.__arms : d3.arms;
    if (!arms && info3d && info3d.armsAdjustable && miss.some((n) => /팔꿈치|손목/.test(n))) tips.push('[팔 내리기]');
    const hint = tips.length === 2 ? ' — 전신 프레이밍이나 [팔 내리기]를 써 보세요.'
      : tips.length ? ` — ${tips[0]}${tips[0] === '[팔 내리기]' ? '를' : '을'} 써 보세요.`
        : ' — 각도를 바꾸거나 [시점 초기화]를 눌러 보세요.';
    box.append(poseCard({ item: lastPose3d, compact: true }),
      h('div', { class: 'ex-pose-last-side' },
        h('div', { class: 'small muted' }, '마지막으로 저장한 포즈'),
        miss.length ? h('div', { class: 'field-note warn-text' }, `화면 밖이라 빠진 관절: ${miss.join(', ')}${hint}`) : null,
        go));
  }

  /** 지금 3D 모델에서 추출한 프롬프트(있을 때만) */
  function promptFor3d() {
    if (!result || result.source !== '3d' || !ui) return '';
    if (!result.origin || result.origin.name !== (model3dName || '3D 모델')) return '';
    return ui.ta.value.trim();
  }

  function sendPoseToGenerate(item, { withPrompt = true, source = '' } = {}) {
    if (!item || !item.name) return;
    const payload = { name: item.name, source: source || poseTitle(item) };
    const prompt = withPrompt ? promptFor3d() : '';
    if (prompt) payload.prompt = prompt;
    emit('generate:pose', payload);
    location.hash = '#/generate';
  }

  async function savePose3d(send) {
    if (!viewer || !info3d || loading3d || poseBusy) return;
    const [w, hh] = SIZES[d3.poseSize] || SIZES.portrait;
    const name = model3dName || '3D 모델';
    const btn = send ? $.poseSendBtn : $.poseSaveBtn;
    poseBusy = true;
    btn.classList.add('is-busy');
    renderPose3d();
    try {
      const cap = await viewer.capturePose({ width: w, height: hh, hands: true });
      if (!cap) throw new Error('화면을 캡처하지 못했습니다.');
      let item;
      if (cap.available && cap.keypoints) {
        const person = (cap.keypoints.people || [])[0];
        const pts = person && Array.isArray(person.body) ? person.body.filter(Boolean).length : 0;
        if (pts < 2) {
          throw Object.assign(new Error('화면 안에 보이는 관절이 거의 없습니다. 전신 프레이밍으로 바꾸거나 [시점 초기화]를 눌러 보세요.'), { status: 400, data: { reason: 'invalid' } });
        }
        const fd = new FormData();
        fd.append('keypoints', JSON.stringify(cap.keypoints));
        fd.append('width', String(cap.width));
        fd.append('height', String(cap.height));
        if (cap.render) fd.append('src', cap.render, `${stripExt(name).replace(/[^\w가-힣-]+/g, '_') || 'model'}_pose.png`);
        fd.append('origin', name);
        fd.append('view', cap.custom ? 'custom' : String(cap.view || d3.view));
        fd.append('framing', String(cap.framing || d3.framing));
        if (d3.clip) fd.append('clip', `${d3.clip} (${Math.round(d3.clipTime * 100)}%)`);
        fd.append('hands', cap.hands ? 'true' : 'false');
        fd.append('source', '3d');
        item = await api('/api/poses', { method: 'POST', body: fd, silent: true, timeout: 120000 });
        addPoseLocal(item);
        item = { ...item, __missing: cap.missing || [], __arms: d3.arms };
      } else {
        // 관절 매핑 실패 → 같은 카메라로 렌더한 그림에서 감지
        $.poseStatus.hidden = false;
        $.poseStatus.textContent = detectBusyText();
        const r = await detectPose({ file: cap.render, filename: `${stripExt(name).replace(/[^\w가-힣-]+/g, '_') || 'model'}_render.png`, width: cap.width, height: cap.height, origin: name,
          extra: { source: '3d', view: cap.view || d3.view, framing: cap.framing || d3.framing, clip: d3.clip ? `${d3.clip} (${Math.round(d3.clipTime * 100)}%)` : '' } });
        item = r;
      }
      lastPose3d = item;
      if (send) {
        sendPoseToGenerate(item, { withPrompt: true, source: name });
      } else {
        toast(`포즈를 저장했습니다 (${sizeText(item.width, item.height)}${item.hands ? ' · 손 포함' : ''}). 생성 탭에서 [포즈 고르기]로도 쓸 수 있습니다.`, 'success', {
          title: '포즈 저장',
          timeout: 10000,
          action: { label: '생성 탭으로', onClick: () => sendPoseToGenerate(item, { withPrompt: false, source: name }) },
        });
      }
    } catch (e) {
      if (e && e.status == null && !(e.name === 'ApiError')) console.error(e);
      toastPoseError(e, '포즈를 저장하지 못했습니다');
    } finally {
      poseBusy = false;
      btn.classList.remove('is-busy');
      if ($) $.poseStatus.hidden = true;
      renderPose3d();
    }
  }

  // ======================= 이미지 → 포즈 감지 =======================
  function renderImgPose() {
    if (!$) return;
    const btn = $.poseDetectBtn;
    const info = store.posesInfo;
    const unavailable = info && info.detect_available === false;
    btn.disabled = !lastImage || imgPoseBusy || !!unavailable || !imageUrl;
    $.poseDetectWrap.dataset.tooltip = !lastImage || !imageUrl ? '먼저 이미지를 넣으세요'
      : unavailable ? `${info.detect_error || '포즈 감지 모델을 찾지 못했습니다.'}`
        : imgPoseBusy ? '감지하는 중입니다' : '이 그림 속 인물의 자세를 감지해 포즈로 저장합니다 (엔진 불필요)';
    btn.classList.toggle('is-busy', imgPoseBusy);
    const box = $.poseImgResult;
    box.replaceChildren();
    if (imgPoseBusy) {
      box.append(h('div', { class: 'loading-row' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', {}, detectBusyText())));
    } else if (imgPoseErr) {
      box.append(h('div', { class: 'ex-pose-note is-warn' },
        h('span', { class: 'ex-warn-icon', 'aria-hidden': 'true' }, '!'),
        h('span', {}, poseErrorLine(imgPoseErr)),
        h('a', { class: 'help-link', href: `#/help/${imgPoseErr.help}`, title: '도움말에서 자세히 보기' }, '? 해결')));
    } else if (imgPose) {
      const it = imgPose.item;
      const ov = h('button', { type: 'button', class: `btn btn-sm${imgPose.overlay ? ' active' : ''}`, 'aria-pressed': imgPose.overlay ? 'true' : 'false' }, imgPose.overlay ? '뼈대 겹쳐 보기 ✓' : '뼈대 겹쳐 보기');
      ov.addEventListener('click', () => {
        imgPose.overlay = !imgPose.overlay;
        renderImgPose();
      });
      const go = h('button', { type: 'button', class: 'btn btn-sm btn-primary' }, '생성 탭으로');
      go.addEventListener('click', () => {
        emit('generate:pose', { name: it.name, source: poseTitle(it) });
        location.hash = '#/generate';
      });
      const notes = [];
      if (it.cropped) notes.push('그림 비율이 생성 크기와 달라 가운데 기준으로 잘라 맞췄습니다.');
      if (it.detected > (it.people || 0)) notes.push(`${it.detected}명을 찾았고 가장 큰 사람 1명만 썼습니다.`);
      box.append(h('div', { class: 'ex-pose-res' },
        poseCard({ item: it, compact: true }),
        h('div', { class: 'ex-pose-res-side' },
          h('div', { class: 'ex-pose-res-title' }, '포즈를 저장했습니다'),
          h('div', { class: 'small muted' }, detectSummary(it)),
          notes.length ? h('div', { class: 'field-note' }, notes.join(' ')) : null,
          h('div', { class: 'ex-pose-res-btns' }, ov, tipNode('pose_overlay'), go, tipNode('pose_send')))));
    }
    box.hidden = !box.childElementCount;
    updateImgOverlay();
  }

  /** 감지한 맵을 미리보기 위에 겹친다 (가운데 기준으로 잘렸으면 그 영역에 맞춰) */
  function updateImgOverlay() {
    if (!$) return;
    const ov = $.poseOverlayImg;
    const show = !!(imgPose && imgPose.overlay && imageUrl);
    if (!show) {
      ov.hidden = true;
      return;
    }
    const it = imgPose.item;
    if (ov.dataset.name !== it.name) {
      // 뼈대 그림의 검은 배경을 투명하게 바꿔 그린다 (흰 배경 그림 위에서도 선이 보이게)
      ov.dataset.name = it.name;
      const im = new Image();
      im.onload = () => {
        if (ov.dataset.name !== it.name) return;
        ov.width = im.naturalWidth;
        ov.height = im.naturalHeight;
        const ctx = ov.getContext('2d', { willReadFrequently: true });
        ctx.clearRect(0, 0, ov.width, ov.height);
        ctx.drawImage(im, 0, 0);
        try {
          const d = ctx.getImageData(0, 0, ov.width, ov.height);
          const a = d.data;
          for (let i = 0; i < a.length; i += 4) {
            const m = Math.max(a[i], a[i + 1], a[i + 2]);
            a[i + 3] = m < 24 ? 0 : 255;
          }
          ctx.putImageData(d, 0, 0);
        } catch { /* 그대로 (화면 혼합으로 보임) */ }
      };
      im.src = it.url;
    }
    const ow = $.previewImg.naturalWidth || it.width;
    const oh = $.previewImg.naturalHeight || it.height;
    const W = Number(it.width) || ow;
    const H = Number(it.height) || oh;
    const sc = Math.max(W / ow, H / oh);
    const rw = W / sc;
    const rh = H / sc;
    Object.assign(ov.style, {
      left: `${((ow - rw) / 2 / ow) * 100}%`,
      top: `${((oh - rh) / 2 / oh) * 100}%`,
      width: `${(rw / ow) * 100}%`,
      height: `${(rh / oh) * 100}%`,
    });
    ov.hidden = false;
  }

  async function detectImagePose() {
    if (!lastImage || imgPoseBusy) return;
    const tok = ++imgPoseTok;
    imgPoseBusy = true;
    imgPoseErr = null;
    renderImgPose();
    try {
      const r = lastImage.path
        ? await detectPose({ path: lastImage.path, origin: lastImage.name })
        : await detectPose({ file: lastImage.file, filename: lastImage.file && lastImage.file.name, origin: lastImage.name });
      if (tok !== imgPoseTok) return;
      imgPose = { item: r, overlay: true };
      toast(`포즈를 감지해 저장했습니다 (${detectSummary(r)}).`, 'success', {
        title: '포즈 감지',
        timeout: 10000,
        action: { label: '생성 탭으로', onClick: () => { emit('generate:pose', { name: r.name, source: poseTitle(r) }); location.hash = '#/generate'; } },
      });
    } catch (e) {
      if (tok !== imgPoseTok || (e && (e.aborted || e.name === 'AbortError'))) return;
      imgPoseErr = poseErrorInfo(e, '포즈를 감지하지 못했습니다');
      if (imgPoseErr.kind !== 'no_person') toastPoseError(e, '포즈를 감지하지 못했습니다');
    } finally {
      if (tok === imgPoseTok) {
        imgPoseBusy = false;
        renderImgPose();
      }
    }
  }

  function multiViews() {
    const v = ['front', 'left34', 'right34'];
    if (d3.addSide) v.push('side');
    if (d3.addBack) v.push('back');
    return v;
  }

  function capture3d(multi) {
    if (!viewer || !info3d) return;
    const name = model3dName || '3D 모델';
    const views = multi ? multiViews() : null;
    runTask(multi ? `${views.length}개 각도를 캡처하는 중…` : '현재 화면을 캡처하는 중…', async (signal, progress) => {
      let shots;
      if (multi) {
        const r = await viewer.captureAngles(views, { size: 1024, framing: d3.framing });
        shots = (r || []).filter((s) => s && s.blob).map((s) => ({ view: s.view, label: VIEW_LABELS[s.view] || s.view, blob: s.blob }));
      } else {
        const blob = await viewer.capture({ size: 1024 });
        shots = blob ? [{ view: 'current', label: '현재 시점', blob }] : [];
      }
      if (!shots.length) throw new Error('화면을 캡처하지 못했습니다.');
      if (signal.aborted) return null;
      const results = [];
      for (let i = 0; i < shots.length; i++) {
        progress(shots.length > 1 ? `${busyLabel(`태그를 뽑는 중… (${i + 1}/${shots.length}: ${shots[i].label})`)}` : busyLabel());
        const fd = new FormData();
        fd.append('image', shots[i].blob, `${stripExt(name).replace(/[^\w가-힣-]+/g, '_') || 'model'}_${shots[i].view}.png`);
        fd.append('source', '3d');
        const r = await postInterrogate(fd, signal);
        if (store.tagger && r && r.model) store.tagger.loaded = r.model; // 다음 각도부터는 '불러오는 중' 안내가 필요 없다
        results.push(r);
      }
      const base = results.length > 1 ? mergeResults(results) : { ...results[0], source: '3d' };
      return {
        ...base,
        source: '3d',
        origin: { kind: '3d', name, views: shots.map((s) => s.label) },
        captures: shots.map((s) => ({ label: s.label, url: URL.createObjectURL(s.blob) })),
      };
    }, () => capture3d(multi));
  }

  // ======================= 원본 전환 =======================
  function setSource(s) {
    const next = s === '3d' ? '3d' : 'image';
    const changed = next !== source;
    source = next;
    lsSet(SOURCE_KEY, source);
    if (!$) return;
    // 다른 원본에서 난 추출 오류는 이 원본과 상관없으므로 지운다 (설치 안내 같은 'setup' 오류는 그대로)
    if (changed && errorState && errorState.kind === 'error' && errorState.source !== source) {
      errorState = null;
      renderResults();
    }
    $.srcSeg.querySelectorAll('[data-src]').forEach((b) => {
      const on_ = b.dataset.src === source;
      b.classList.toggle('active', on_);
      b.setAttribute('aria-pressed', on_ ? 'true' : 'false');
    });
    $.imagePane.hidden = source !== 'image';
    $.d3Pane.hidden = source !== '3d';
    if (source === '3d' && visible) ensureViewer().catch(() => {});
  }

  // ======================= 결과 렌더 =======================
  function renderBusy(text) {
    if (!$) return;
    $.results.replaceChildren(h('div', { class: 'ex-busy', role: 'status' },
      h('span', { class: 'spinner spinner-lg', 'aria-hidden': 'true' }),
      h('div', { class: 'ex-busy-text' }, text || '태그를 뽑는 중…'),
      h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: cancelTask }, '취소')));
  }
  function cancelTask() {
    taskTok++;
    if (taskCtrl) taskCtrl.abort();
    taskCtrl = null;
    busy = false;
    renderResults();
    update3dButtons();
  }

  function setupNotice() {
    const tg = store.tagger;
    if (store.taggerError) return { title: '프롬프트 추출을 사용할 수 없습니다', text: store.taggerError };
    if (!tg) return null;
    if (tg.available === false) return { title: '태거를 실행할 수 없습니다', text: tg.error || '엔진 Python에서 onnxruntime을 찾지 못했습니다.' };
    if (!tg.models.length) return { title: '설치된 태거 모델이 없습니다', text: tg.error || 'models/tagger/<이름>/ 폴더에 model.onnx와 selected_tags.csv가 있어야 합니다.' };
    return null;
  }

  function renderResults() {
    if (!$) return;
    const box = $.results;
    if (busy) return;
    // 같은 결과를 다시 그릴 때(기준값 기본으로·취소·설정 변경) 직접 고친 프롬프트는 그대로 둔다.
    // 새 결과는 setResult()가 edited=false로 바꾼 뒤 그리므로 칩 기준으로 새로 채워진다.
    const keep = edited && ui ? ui.ta.value : null;
    box.replaceChildren();
    if (errorState) {
      // [다시 시도]는 실패한 작업이 지금 고른 원본의 것일 때만 (이미지 오류를 3D 화면에서 다시 시도하지 않도록)
      const { retry } = errorState;
      const canRetry = errorState.kind === 'error' && typeof retry === 'function' && errorState.source === source
        && (source === '3d' ? !!info3d : !!lastImage);
      box.append(emptyState({
        icon: '!',
        title: errorState.title,
        text: errorState.text,
        actions: [
          canRetry ? h('button', { type: 'button', class: 'btn btn-sm', onclick: () => retry() }, '다시 시도') : null,
          h('a', { class: 'btn btn-sm btn-ghost', href: errorState.kind === 'setup' ? '#/help/extract-tagger' : '#/help/extract' }, '도움말 보기'),
        ].filter(Boolean),
      }));
      return;
    }
    if (!result) {
      const n = setupNotice();
      if (n) {
        box.append(emptyState({
          icon: '!', title: n.title, text: n.text,
          actions: [h('a', { class: 'btn btn-sm', href: '#/help/extract-tagger' }, '설치 방법 보기'), h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => { store.taggerError = ''; loadTagger(); } }, '다시 확인')],
        }));
        return;
      }
      box.append(emptyState({
        icon: '⌗',
        title: '원본을 고르면 태그가 여기에 나타납니다',
        text: '왼쪽에 이미지를 넣거나 3D 모델을 불러와 추출하세요. 태그마다 확률이 함께 나오고, 기준값과 칩으로 넣을 태그를 고른 뒤 생성 탭이나 캐릭터로 보낼 수 있습니다.',
      }));
      return;
    }
    const r = result;
    if (scrollResetPending) {
      scrollResetPending = false;
      if (box.parentElement) box.parentElement.scrollTop = 0;
    }

    // ---- 머리: 원본·모델·시간·등급 ----
    const ratingEntries = Object.entries(r.rating || {}).filter(([, v]) => isFinite(Number(v)));
    ratingEntries.sort((a, b) => b[1] - a[1]);
    const top = ratingEntries[0] ? ratingEntries[0][0] : '';
    const meta = [];
    if (r.model) meta.push(r.model);
    if (r.elapsed != null) meta.push(`${Number(r.elapsed).toFixed(1)}초`);
    if (Array.isArray(r.size) && r.size.length === 2) meta.push(`${r.size[0]}×${r.size[1]}`);
    if (r.merged > 1) meta.push(`${r.merged}개 각도 합침`);
    const ratingTip = ratingEntries.map(([k, v]) => `${RATING_LABELS[k] || k}: ${pct(v)}`).join('\n');
    box.append(h('div', { class: 'ex-res-head' },
      h('div', { class: 'ex-res-title' },
        h('h3', { class: 'panel-title' }, '추출 결과'),
        top ? badge(`등급: ${RATING_LABELS[top] || top}`, RATING_KIND[top] || 'muted', `태거가 판단한 그림 등급\n${ratingTip}`) : null),
      h('div', { class: 'ex-res-meta' },
        h('span', { class: 'ex-res-origin' }, `${r.origin && r.origin.kind === '3d' ? '3D' : '원본'}: ${originLabel() || '-'}`),
        meta.length ? h('span', { class: 'muted' }, meta.join(' · ')) : null)));
    if (top === 'questionable' || top === 'explicit') {
      box.append(h('div', { class: 'ex-warn-box', role: 'note' },
        h('span', { class: 'ex-warn-icon', 'aria-hidden': 'true' }, '!'),
        h('span', {}, '이 원본은 노출이 있는 그림으로 판단되었습니다. 생성 기본 네거티브에 nsfw가 있으니, 결과가 이상하면 아래 태그를 확인하고 필요 없는 태그를 끄세요.')));
    }

    // ---- 캡처 썸네일 (3D) ----
    if (r.captures && r.captures.length) {
      box.append(h('div', { class: 'ex-captures', 'aria-label': '태깅한 캡처' },
        r.captures.map((c) => h('figure', { class: 'ex-capture' },
          h('img', { src: c.url, alt: `${c.label} 캡처`, loading: 'lazy' }),
          h('figcaption', {}, c.label)))));
    }

    // ---- 기준값 ----
    const totalGen = (r.tags || []).filter((t) => !isChar(t)).length;
    const totalChar = (r.tags || []).filter(isChar).length;
    const thrBox = h('div', { class: 'ex-thr' });
    const mkThr = (id, label, tip, min, max, get, set, total) => {
      const range = h('input', { type: 'range', id, min: String(min), max: String(max), step: '0.01' });
      range.value = String(get());
      const val = h('span', { class: 'range-val ex-thr-val' }, pct(get()));
      const count = h('span', { class: 'field-aside' });
      const updCount = () => {
        const shown = (r.tags || []).filter((t) => (id === 'ex-thr-char' ? isChar(t) : !isChar(t)) && t.score >= get()).length;
        count.textContent = total ? `${shown}/${total}개 표시` : '태그 없음';
      };
      updCount();
      range.addEventListener('input', () => {
        set(Math.round(Number(range.value) * 100) / 100);
        thrTouched = true;
        val.textContent = pct(get());
        updCount();
        renderTagArea();
        syncPrompt();
        if (ui) ui.thrReset.hidden = false;
      });
      return h('div', { class: 'field ex-thr-field' },
        h('div', { class: 'field-label' }, h('label', { for: id }, label), tipNode(tip), count),
        h('div', { class: 'range-field ex-range' }, range, val));
    };
    thrBox.append(
      mkThr('ex-thr-gen', '일반 태그 기준값', 'extract_threshold', 0.05, 0.95, () => genThr, (v) => { genThr = v; }, totalGen),
      mkThr('ex-thr-char', '캐릭터 태그 기준값', 'extract_char_threshold', 0.3, 0.99, () => charThr, (v) => { charThr = v; }, totalChar));
    const thrReset = h('button', { type: 'button', class: 'link-btn ex-thr-reset', hidden: !thrTouched }, '기준값 기본으로');
    thrReset.addEventListener('click', () => {
      resetThresholds();
      renderResults();
      if (edited) toast('프롬프트를 직접 고친 상태라 칸은 그대로 두었습니다. 칩대로 바꾸려면 [다시 만들기]를 누르세요.', 'info');
    });
    box.append(h('div', { class: 'ex-thr-wrap' }, thrBox,
      h('div', { class: 'ex-thr-foot' },
        h('span', { class: 'field-note' }, '낮추면 태그가 많아지지만 틀린 것도 섞이고, 높이면 확실한 것만 남습니다. 서버에 다시 묻지 않고 바로 걸러집니다.'),
        thrReset)));

    // ---- 태그 영역 ----
    const tagArea = h('div', { class: 'ex-tags', 'data-ref': 'tagArea' });
    box.append(h('div', { class: 'ex-tags-head' },
      h('span', { class: 'label' }, '태그'), tipNode('extract_groups'),
      h('span', { class: 'field-aside' }, '칩을 눌러 넣기/빼기 · 진할수록 확률이 높음')), tagArea);

    // ---- 최종 프롬프트 ----
    const ta = h('textarea', { id: 'ex-prompt', rows: '5', spellcheck: 'false', class: 'ex-prompt' });
    const editedBadge = h('span', { class: 'badge badge-warn', hidden: true, 'data-tooltip': '직접 고친 내용이 있어 칩을 바꿔도 이 칸은 자동으로 바뀌지 않습니다. [다시 만들기]를 누르면 칩 기준으로 새로 만듭니다.' }, '직접 수정됨');
    const rebuild = h('button', { type: 'button', class: 'btn btn-xs btn-ghost', hidden: true }, '다시 만들기');
    const count = h('span', { class: 'prompt-count' });
    box.append(h('div', { class: 'field ex-prompt-field' },
      h('div', { class: 'field-label' }, h('label', { for: 'ex-prompt' }, '최종 프롬프트'), tipNode('extract_prompt'), editedBadge,
        h('span', { class: 'field-aside' }, '괄호는 \\( \\)로 바꿔 넣습니다')),
      ta,
      h('div', { class: 'prompt-tools' }, rebuild, count)));

    // ---- 버튼 ----
    const copyBtn = h('button', { type: 'button', class: 'btn btn-sm' }, '복사');
    const genBtn = h('button', { type: 'button', class: 'btn btn-sm btn-primary' }, '생성 탭으로 보내기');
    const newBtn = h('button', { type: 'button', class: 'btn btn-sm' }, '새 캐릭터로 만들기');
    const applyBtn = h('button', { type: 'button', class: 'btn btn-sm', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, '기존 캐릭터에 적용…');
    box.append(h('div', { class: 'ex-actions' },
      h('span', { class: 'ex-act' }, copyBtn),
      h('span', { class: 'ex-act' }, genBtn, tipNode('extract_to_generate')),
      h('span', { class: 'ex-act' }, newBtn, tipNode('extract_new_character')),
      h('span', { class: 'ex-act' }, applyBtn, tipNode('extract_apply_character'))));

    // 참조 보관 (칩 토글 시 부분 갱신용)
    ui = { tagArea, ta, editedBadge, rebuild, count, thrReset };

    ta.addEventListener('input', () => {
      edited = ta.value !== lastBuilt;
      updateEdited();
    });
    rebuild.addEventListener('click', () => {
      const prev = ta.value;
      edited = false;
      syncPrompt(true);
      toast('칩 기준으로 프롬프트를 다시 만들었습니다.', 'info', {
        action: { label: '되돌리기', onClick: () => { ta.value = prev; edited = prev !== lastBuilt; updateEdited(); } },
      });
    });
    copyBtn.addEventListener('click', async () => {
      const text = ta.value.trim();
      if (!text) {
        toast('복사할 프롬프트가 없습니다. 칩을 하나 이상 켜세요.', 'warn');
        return;
      }
      if (await copyText(text)) toast('프롬프트를 복사했습니다.', 'success');
      else toast('복사하지 못했습니다. 칸을 선택해 직접 복사하세요.', 'warn');
    });
    genBtn.addEventListener('click', sendToGenerate);
    newBtn.addEventListener('click', makeNewCharacter);
    applyBtn.addEventListener('click', () => applyToCharacter(applyBtn));

    renderTagArea();
    if (keep != null) {
      ta.value = keep;
      lastBuilt = buildPrompt();
      edited = keep !== lastBuilt;
      updateEdited();
    } else {
      syncPrompt(true);
    }
  }
  let ui = null;

  function updateEdited() {
    if (!ui) return;
    ui.editedBadge.hidden = !edited;
    ui.rebuild.hidden = !edited;
    const n = ui.ta.value.split(',').map((s) => s.trim()).filter(Boolean).length;
    ui.count.textContent = n ? `태그 ${n}개` : '켜진 태그 없음';
  }
  function syncPrompt(force = false) {
    if (!ui) return;
    lastBuilt = buildPrompt();
    if (!edited || force) {
      ui.ta.value = lastBuilt;
      edited = false;
    }
    updateEdited();
  }

  function chipEl(t) {
    const on_ = isOn(t);
    const ko = koLabel(t.tag);
    const thr = isChar(t) ? charThr : genThr;
    const conf = clamp((t.score - thr) / Math.max(0.01, 1 - thr), 0, 1);
    const b = h('button', {
      type: 'button',
      class: `chip chip-sm ex-chip${on_ ? ' active' : ''}`,
      'aria-pressed': on_ ? 'true' : 'false',
    }, h('span', { class: 'ex-chip-tag' }, t.tag), h('span', { class: 'ex-chip-score' }, pct(t.score)));
    b.style.setProperty('--conf', conf.toFixed(2));
    const reason = offReason(t);
    const tip = [ko ? `${ko}` : '', `확률 ${pct(t.score)}`, on_ ? '포함됨 · 누르면 뺍니다' : `빠짐 · 누르면 넣습니다${reason ? `\n(${reason})` : ''}`].filter(Boolean).join('\n');
    b.dataset.tooltip = tip;
    b.addEventListener('click', () => {
      overrides.set(t.tag, !isOn(t));
      const nb = chipEl(t);
      b.replaceWith(nb);
      nb.focus();
      updateGroupCounts();
      syncPrompt();
      if (edited) toast('프롬프트를 직접 고친 상태라 칸은 그대로 두었습니다. 칩대로 바꾸려면 [다시 만들기]를 누르세요.', 'info');
    });
    return b;
  }

  function groupSet(id, value) {
    for (const t of tagsIn(id, { onlyOn: false })) overrides.set(t.tag, value);
    const hadFocus = !!ui && ui.tagArea.contains(document.activeElement);
    renderTagArea();
    // 태그 영역을 새로 그려 사라진 초점을 같은 묶음의 같은 버튼으로 돌려놓는다
    if (hadFocus) ui.tagArea.querySelector(`[data-group="${CSS.escape(id)}"] [data-act="${value ? 'on' : 'off'}"]`)?.focus();
    syncPrompt();
    if (edited) toast('프롬프트를 직접 고친 상태라 칸은 그대로 두었습니다. 칩대로 바꾸려면 [다시 만들기]를 누르세요.', 'info');
  }

  function updateGroupCounts() {
    if (!ui) return;
    ui.tagArea.querySelectorAll('[data-group]').forEach((el) => {
      const id = el.dataset.group;
      const all = tagsIn(id, { onlyOn: false });
      const n = all.filter(isOn).length;
      const c = el.querySelector('.ex-group-count');
      if (c) c.textContent = `${n}/${all.length}`;
    });
  }

  function renderTagArea() {
    if (!ui) return;
    const area = ui.tagArea;
    area.replaceChildren();
    const vis = visibleTags();
    if (!vis.length) {
      area.append(h('div', { class: 'list-empty' }, '기준값 이상인 태그가 없습니다. 위의 기준값을 낮춰 보세요.'));
      return;
    }
    const is3d = result && result.source === '3d';
    // 캐릭터 태그: 별도 줄
    const chars = tagsIn('character', { onlyOn: false });
    if (chars.length) {
      area.append(h('div', { class: 'ex-charrow', 'data-group': 'character' },
        h('div', { class: 'ex-group-head' },
          h('span', { class: 'ex-group-label' }, '캐릭터로 인식됨'),
          h('span', { class: 'ex-group-count' }, ''),
          h('span', { class: 'ex-group-note' }, '기존 캐릭터로 인식됨 — 넣으면 그 캐릭터 모습이 강하게 반영됩니다')),
        h('div', { class: 'chips ex-chips' }, chars.map(chipEl))));
    }
    for (const id of groupOrder()) {
      if (id === 'character') continue;
      const list = tagsIn(id, { onlyOn: false });
      if (!list.length) continue;
      const note = (is3d && GROUP_NOTES_3D[id]) || GROUP_NOTES[id] || '';
      const allOn = h('button', { type: 'button', class: 'link-btn', 'data-act': 'on' }, '모두 켜기');
      const allOff = h('button', { type: 'button', class: 'link-btn', 'data-act': 'off' }, '모두 끄기');
      allOn.addEventListener('click', () => groupSet(id, true));
      allOff.addEventListener('click', () => groupSet(id, false));
      area.append(h('div', { class: `ex-group${id === 'meta' ? ' is-meta' : ''}`, 'data-group': id },
        h('div', { class: 'ex-group-head' },
          h('span', { class: 'ex-group-label' }, groupLabel(id)),
          h('span', { class: 'ex-group-count' }, ''),
          allOn, allOff,
          note ? h('span', { class: 'ex-group-note' }, note) : null),
        h('div', { class: 'chips ex-chips' }, list.map(chipEl))));
    }
    updateGroupCounts();
  }

  // ======================= 보내기 =======================
  function sendToGenerate() {
    if (!ui) return;
    const text = ui.ta.value.trim();
    if (!text) {
      toast('보낼 프롬프트가 없습니다. 칩을 하나 이상 켜세요.', 'warn');
      return;
    }
    emit('generate:prompt', { prompt: text, source: originLabel() });
    location.hash = '#/generate';
  }

  function charFields() {
    const charOn = tagsIn('character');
    const charAll = tagsIn('character', { onlyOn: false });
    const count = joinTags(tagsIn('count')) || '1girl, solo';
    const appearance = [joinTags(charOn), joinTags(tagsIn('appearance'))].filter(Boolean).join(', ');
    const outfit = joinTags(tagsIn('outfit'));
    const memoLines = [`프롬프트 추출에서 가져옴 (원본: ${originLabel() || '알 수 없음'})`];
    if (charAll.length) memoLines.push(`인식된 캐릭터 태그: ${charAll.map((t) => `${t.tag} (${pct(t.score)})`).join(', ')}`);
    return { count, appearance, outfit, memo: memoLines.join('\n') };
  }

  function makeNewCharacter() {
    if (!result) return;
    const f = charFields();
    if (!f.appearance && !f.outfit) {
      toast('켜진 외형·의상 태그가 없습니다. 칩을 켜거나 기준값을 낮춰 보세요. 폼은 그대로 열어 둡니다.', 'warn');
    }
    emit('characters:prefill', { ...f, source: originLabel() });
    location.hash = '#/characters/new';
  }

  function compareRow(label, cur, next) {
    return h('div', { class: 'ex-cmp-row' },
      h('div', { class: 'ex-cmp-label' }, label),
      h('div', { class: 'ex-cmp-col' }, h('div', { class: 'ex-cmp-cap' }, '지금'), h('div', { class: 'ex-cmp-text' }, cur || '(비어 있음)')),
      h('div', { class: 'ex-cmp-col is-new' }, h('div', { class: 'ex-cmp-cap' }, '바꿀 값'), h('div', { class: 'ex-cmp-text' }, next || '(추출된 태그 없음 — 그대로 둠)')));
  }

  function confirmApply(c, f) {
    return new Promise((resolve) => {
      const body = h('div', { class: 'ex-cmp' },
        h('p', { class: 'modal-text' }, `'${c.name || c.id}'의 외형·의상 칸을 추출한 태그로 바꿀까요?`),
        compareRow('외형', c.appearance || '', f.appearance),
        compareRow('의상', c.outfit || '', f.outfit),
        h('p', { class: 'modal-detail' }, '캐릭터 편집 화면이 열리고 칸만 바뀝니다. 아직 저장되지 않으니, 확인한 뒤 직접 [저장]을 누르세요. 마음에 들지 않으면 [되돌리기]로 원래대로 돌릴 수 있습니다.'));
      openModal({
        title: '기존 캐릭터에 적용',
        body,
        size: 'lg',
        actions: [
          { label: '취소', kind: 'ghost', value: false },
          { label: '바꾸기', kind: 'primary', value: true, autofocus: true },
        ],
        onClose: (v) => resolve(v === true),
      });
    });
  }

  async function applyToCharacter(anchor) {
    if (!result) return;
    if (!store.charactersLoaded) await loadCharacters();
    const list = store.characters.filter((c) => c && !c.error);
    if (!list.length) {
      toast('아직 캐릭터가 없습니다. [새 캐릭터로 만들기]를 써 보세요.', 'info');
      return;
    }
    const f = charFields();
    if (!f.appearance && !f.outfit) {
      toast('켜진 외형·의상 태그가 없어 적용할 것이 없습니다. 칩을 켜거나 기준값을 낮춰 보세요.', 'warn');
      return;
    }
    openMenu(anchor, list.map((c) => ({
      label: c.name || c.id,
      hint: c.id,
      onClick: async () => {
        if (!(await confirmApply(c, f))) return;
        emit('characters:apply', { id: c.id, appearance: f.appearance, outfit: f.outfit, source: originLabel() });
        location.hash = `#/characters/${encodeURIComponent(c.id)}`;
      },
    })));
  }

  // ======================= 마운트 =======================
  function mount(el) {
    el.innerHTML = `
      <div class="ex-layout">
        <section class="panel ex-source" aria-label="원본">
          <div class="panel-head">
            <h2 class="panel-title">원본</h2>
            <div class="seg" data-ref="srcSeg" role="group" aria-label="원본 종류">
              <button type="button" class="seg-btn" data-src="image">이미지</button>
              <button type="button" class="seg-btn" data-src="3d">3D 모델</button>
            </div>${tipIcon('extract_source')}
            <div class="panel-tools">${helpLink('extract', '? 프롬프트 추출')}</div>
          </div>

          <div data-ref="imagePane">
            <div class="ex-drop" data-ref="dropzone" role="button" tabindex="0" aria-label="이미지 고르기 (끌어다 놓기·클릭·붙여넣기)">
              <div class="ex-drop-ph" data-ref="dropPh">
                <div class="ex-drop-icon" aria-hidden="true">⇪</div>
                <div class="ex-drop-title">이미지를 끌어다 놓거나 눌러서 고르세요</div>
                <div class="ex-drop-text"><kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>V</kbd>로 붙여넣기도 됩니다 · 캐릭터가 크게 보이는 그림일수록 정확합니다</div>
                <div class="ex-drop-formats">PNG · JPG · WEBP · GIF(첫 장면) · BMP</div>
              </div>
              <div class="ex-preview" data-ref="previewWrap" hidden>
                <div class="ex-preview-stack">
                  <img class="ex-preview-img" data-ref="previewImg" alt="" draggable="false">
                  <canvas class="ex-pose-overlay" data-ref="poseOverlayImg" aria-label="감지한 뼈대" hidden></canvas>
                </div>
              </div>
              <div class="ex-drag-hint" aria-hidden="true">여기에 놓으세요</div>
            </div>
            <div class="ex-preview-meta">
              <span class="ex-preview-name" data-ref="previewName"></span>
              <span class="field-note" data-ref="previewNote" hidden></span>
            </div>
            <div class="ex-src-actions">
              <button type="button" class="btn btn-sm" data-ref="pickFile">파일 고르기</button>
              <button type="button" class="btn btn-sm" data-ref="pickGallery">갤러리에서 고르기</button>
              <button type="button" class="btn btn-sm btn-ghost" data-ref="rerun" hidden>다시 추출</button>
              ${tipIcon('extract_image')}
            </div>
            <div class="ex-pose-img">
              <div class="ex-pose-img-row">
                <span class="btn-guard" data-ref="poseDetectWrap"><button type="button" class="btn btn-sm" data-ref="poseDetectBtn">이 그림에서 포즈 감지</button></span>${tipIcon('pose_detect')}
                <span class="field-note">팔다리 자세를 뼈대 그림으로 저장해 생성할 때 따라 그리게 합니다 ${helpLink('pose-image', '? 포즈 감지')}</span>
              </div>
              <div class="ex-pose-img-result" data-ref="poseImgResult" hidden></div>
            </div>
            <input type="file" data-ref="fileInput" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,.png,.jpg,.jpeg,.webp,.gif,.bmp" hidden>
          </div>

          <div data-ref="d3Pane" hidden>
            <div class="ex-mobile-note" role="note"><span class="ex-warn-icon" aria-hidden="true">!</span><span>휴대폰에서는 3D 모델 보기가 무거울 수 있습니다. 큰 모델은 불러오는 데 오래 걸리거나 브라우저가 멈출 수 있으니 가능하면 PC에서 쓰세요. 이미지에서 추출은 휴대폰에서도 가볍게 됩니다.</span></div>
            <div class="ex-src-actions">
              <button type="button" class="btn btn-sm" data-ref="pick3dFiles">파일 고르기</button>
              <button type="button" class="btn btn-sm" data-ref="pick3dDir">폴더 고르기</button>
              ${tipIcon('extract_3d_files')}
              <span class="field-note ex-formats">.vrm .glb .gltf .fbx .obj .pmx .pmd · 텍스처 png/jpg/tga/bmp/webp</span>
            </div>
            <input type="file" data-ref="file3dInput" multiple hidden accept=".glb,.gltf,.vrm,.fbx,.obj,.mtl,.pmx,.pmd,.bin,.png,.jpg,.jpeg,.tga,.bmp,.webp,.gif,.dds,.psd,.tif,.tiff,.exr,.hdr,.ktx,.ktx2,.spa,.sph,.vmd">
            <input type="file" data-ref="dir3dInput" multiple webkitdirectory hidden>
            <div class="ex-viewer-wrap" data-ref="viewerWrap">
              <div class="ex-viewer" data-ref="viewerBox"></div>
              <div class="ex-viewer-ph" data-ref="viewerPh"></div>
              <div class="ex-drag-hint" aria-hidden="true">여기에 놓으세요 (파일 여러 개·폴더 가능)</div>
            </div>
            <div class="ex-status3d" data-ref="status3d" role="status" hidden>
              <span data-ref="status3dText"></span>
              <span class="progress"><span class="progress-bar" data-ref="status3dBar"></span></span>
            </div>
            <!-- 도구 막대를 뷰어 바로 아래에 둔다 (모델 정보·VRM 메타는 그 아래) — 낮은 화면에서도 각도를 바꾸며 결과를 볼 수 있게 -->
            <div class="ex-toolbar3d" data-ref="toolbar3d">
              <div class="ex-tool-row">
                <span class="ex-tool-label">각도${tipIcon('extract_view')}</span>
                <div class="seg seg-sm" data-ref="viewSeg" role="group"></div>
                <span data-ref="flipWrap" hidden><button type="button" class="btn btn-xs btn-ghost" data-ref="flipBtn" aria-pressed="false">앞뒤 바꾸기</button>${tipIcon('extract_flip')}</span>
              </div>
              <div class="ex-tool-row">
                <span class="ex-tool-label">프레이밍${tipIcon('extract_framing')}</span>
                <div class="seg seg-sm" data-ref="framingSeg" role="group"></div>
                <span class="ex-tool-label">배경${tipIcon('extract_bg')}</span>
                <div class="seg seg-sm" data-ref="bgSeg" role="group"></div>
              </div>
              <div class="ex-tool-row">
                <label class="ex-tool-label" for="ex-brightness">밝기${tipIcon('extract_brightness')}</label>
                <input type="range" id="ex-brightness" class="ex-tool-range" data-ref="brightness" min="0.3" max="2" step="0.05">
                <span class="range-val" data-ref="brightnessVal"></span>
                <span data-ref="armsWrap" hidden><button type="button" class="btn btn-xs" data-ref="armsBtn" aria-pressed="false">팔 내리기</button>${tipIcon('extract_arms')}</span>
                <button type="button" class="btn btn-xs btn-ghost" data-ref="resetView">시점 초기화</button>
              </div>
              <div class="ex-tool-row" data-ref="clipWrap" hidden>
                <label class="ex-tool-label" for="ex-clip">애니메이션${tipIcon('extract_clip')}</label>
                <select id="ex-clip" class="select select-sm" data-ref="clipSel"></select>
                <input type="range" class="ex-tool-range" data-ref="clipTime" min="0" max="1" step="0.01" aria-label="애니메이션 시간">
              </div>
              <div class="field-note"><span class="ex-hint-mouse">마우스로 끌면 회전, 휠로 확대·축소합니다.</span><span class="ex-hint-touch">한 손가락으로 끌면 회전, 두 손가락으로 벌리거나 오므리면 확대·축소합니다.</span></div>
            </div>
            <div class="ex-info3d" data-ref="info3d" hidden></div>
            <div class="ex-capture-bar">
              <span class="btn-guard" data-ref="captureOneWrap"><button type="button" class="btn btn-primary" data-ref="captureOne">이 각도로 추출</button></span>${tipIcon('extract_capture')}
              <span class="btn-guard" data-ref="captureMultiWrap"><button type="button" class="btn" data-ref="captureMulti">여러 각도로 추출</button></span>${tipIcon('extract_multi')}
              <span class="ex-multi-opts">
                <span class="muted small">정면·좌우 3/4 +</span>
                <label class="check"><input type="checkbox" data-ref="addSide"><span>옆</span></label>
                <label class="check"><input type="checkbox" data-ref="addBack"><span>뒤</span></label>
              </span>
            </div>
            <div class="ex-pose3d" data-ref="pose3d">
              <div class="ex-pose3d-head">
                <span class="ex-pose3d-title">포즈 따라 그리기</span>${tipIcon('pose')}
                <span class="field-aside">지금 자세를 뼈대 그림으로 저장해 생성 때 따라 그리게 합니다</span>
                ${helpLink('pose-3d', '? 3D 포즈')}
              </div>
              <div class="ex-pose3d-row">
                <span class="btn-guard" data-ref="poseOverlayWrap"><button type="button" class="btn btn-sm" data-ref="poseOverlayBtn" aria-pressed="false">뼈대 보기</button></span>${tipIcon('pose_overlay')}
                <label class="ex-tool-label" for="ex-pose-size">포즈 크기${tipIcon('pose_size')}</label>
                <select id="ex-pose-size" class="select select-sm" data-ref="poseSizeSel"></select>
              </div>
              <div class="ex-pose3d-row">
                <span class="btn-guard" data-ref="poseSaveWrap"><button type="button" class="btn" data-ref="poseSaveBtn">포즈 저장</button></span>${tipIcon('pose_save')}
                <span class="btn-guard" data-ref="poseSendWrap"><button type="button" class="btn btn-primary" data-ref="poseSendBtn">이 포즈로 생성…</button></span>${tipIcon('pose_send')}
                <span class="badge badge-info" data-ref="poseViaDetect" hidden data-tooltip="관절을 찾지 못한 모델이라 렌더 이미지에서 자세를 감지합니다">렌더에서 감지</span>
                <span class="small muted" data-ref="poseStatus" hidden></span>
              </div>
              <div class="ex-pose-notices" data-ref="poseNotice" hidden></div>
              <div class="field-note ex-pose-hint">자세 잡기: [애니메이션] 클립과 시간 슬라이더로 원하는 동작에서 멈추고, T자 자세면 [팔 내리기]를 누르세요. 각도(정면·3/4·옆)와 프레이밍(전신·상반신)은 지금 화면 그대로 저장되며, 마우스로 돌린 시점도 그대로 씁니다. [뼈대 보기]로 점이 관절 위에 있는지 확인하세요.</div>
              <div class="ex-pose-last" data-ref="poseLast" hidden></div>
            </div>
          </div>
        </section>

        <section class="panel ex-result-panel" aria-label="추출 결과">
          <div data-ref="results"></div>
        </section>
      </div>`;
    $ = refs(el);

    // 원본 전환
    $.srcSeg.addEventListener('click', (e) => {
      const b = e.target instanceof Element ? e.target.closest('[data-src]') : null;
      if (b) setSource(b.dataset.src);
    });

    // ---- 이미지 ----
    $.pickFile.addEventListener('click', () => $.fileInput.click());
    $.dropzone.addEventListener('click', () => $.fileInput.click());
    $.dropzone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        $.fileInput.click();
      }
    });
    // 휴대폰·태블릿: 사진 보관함·카메라를 고를 수 있게 이미지 전체를 받는다 (iPhone 사진은 JPEG로 바뀌어 들어옴)
    if (isTouch()) $.fileInput.accept = 'image/*';
    $.fileInput.addEventListener('change', () => {
      const f = $.fileInput.files && $.fileInput.files[0];
      $.fileInput.value = '';
      if (f) runImageFile(f);
    });
    $.pickGallery.addEventListener('click', openGalleryPicker);
    $.rerun.addEventListener('click', rerunImage);
    $.previewImg.addEventListener('load', () => {
      $.previewImg.classList.add('loaded');
      detectAlpha($.previewImg, null, (a) => $.previewWrap.classList.toggle('checker', a));
    });
    $.previewImg.addEventListener('error', () => {
      if (imageUrl) $.previewNote.textContent = '미리보기를 표시하지 못했습니다.';
      $.previewNote.hidden = !imageUrl;
    });

    // ---- 3D ----
    $.pick3dFiles.addEventListener('click', () => $.file3dInput.click());
    $.pick3dDir.addEventListener('click', () => $.dir3dInput.click());
    for (const inp of [$.file3dInput, $.dir3dInput]) {
      inp.addEventListener('change', () => {
        const files = [...(inp.files || [])];
        inp.value = '';
        if (files.length) load3d(files);
      });
    }
    $.flipBtn.addEventListener('click', () => {
      const fn = flipFn();
      if (!fn) return;
      d3.flipped = !d3.flipped;
      try {
        fn();
      } catch (e) {
        console.error(e);
      }
      if (viewer && typeof viewer.flipped === 'boolean') d3.flipped = viewer.flipped;
      render3dToolbar();
    });
    $.brightness.addEventListener('input', () => {
      d3.brightness = clamp(Number($.brightness.value) || 1, 0.3, 2);
      $.brightnessVal.textContent = `${Math.round(d3.brightness * 100)}%`;
      viewerCall('setBrightness', d3.brightness);
    });
    $.brightness.addEventListener('change', persist3d);
    $.armsBtn.addEventListener('click', () => {
      d3.arms = !d3.arms;
      const r = viewerCall('setArmsDown', d3.arms);
      if (typeof r === 'boolean') d3.arms = r;
      render3dToolbar();
    });
    $.resetView.addEventListener('click', () => {
      const r = viewerCall('reset');
      d3.view = (r && r.view) || 'front';
      if (r && r.framing) {
        d3.framing = r.framing;
        persist3d();
      } else {
        viewerCall('setView', d3.view, d3.framing);
      }
      render3dToolbar();
    });
    $.clipSel.addEventListener('change', () => {
      d3.clip = $.clipSel.value;
      d3.clipTime = 0;
      viewerCall('setClip', d3.clip || null);
      if (d3.clip) viewerCall('setClipTime', 0);
      render3dToolbar();
    });
    $.clipTime.addEventListener('input', () => {
      d3.clipTime = clamp(Number($.clipTime.value) || 0, 0, 1);
      viewerCall('setClipTime', d3.clipTime);
    });
    $.addSide.addEventListener('change', () => { d3.addSide = $.addSide.checked; persist3d(); });
    $.addBack.addEventListener('change', () => { d3.addBack = $.addBack.checked; persist3d(); });
    $.captureOne.addEventListener('click', () => capture3d(false));
    $.captureMulti.addEventListener('click', () => capture3d(true));

    // ---- 포즈 (3D) ----
    for (const k of POSE_SIZES) $.poseSizeSel.append(h('option', { value: k }, `${SIZE_LABELS[k]} ${SIZES[k][0]}×${SIZES[k][1]}`));
    $.poseSizeSel.value = d3.poseSize;
    $.poseSizeSel.addEventListener('change', () => {
      d3.poseSize = POSE_SIZES.includes($.poseSizeSel.value) ? $.poseSizeSel.value : 'portrait';
      persist3d();
    });
    $.poseOverlayBtn.addEventListener('click', () => {
      d3.poseOverlay = !d3.poseOverlay;
      persist3d();
      const shown = viewerCall('setPoseOverlay', d3.poseOverlay);
      if (d3.poseOverlay && shown === false && info3d) {
        toast('이 모델은 관절(뼈)을 자동으로 찾지 못해 뼈대를 겹쳐 볼 수 없습니다. 포즈는 렌더 이미지에서 감지해 저장할 수 있습니다.', 'info', { timeout: 8000 });
      }
      renderPose3d();
    });
    $.poseSaveBtn.addEventListener('click', () => savePose3d(false));
    $.poseSendBtn.addEventListener('click', () => savePose3d(true));

    // ---- 포즈 (이미지) ----
    $.poseDetectBtn.addEventListener('click', detectImagePose);
    $.previewImg.addEventListener('load', updateImgOverlay);
    on('poses', (d) => {
      // 감지한 포즈가 (고르기 창 등에서) 삭제되면 결과 표시를 지운다
      if (d && d.deleted) {
        if (imgPose && imgPose.item.name === d.deleted) {
          imgPose = null;
          renderImgPose();
        }
        if (lastPose3d && lastPose3d.name === d.deleted) {
          lastPose3d = null;
          renderPoseLast();
        }
      }
      if (!d) renderImgPose();
    });

    // ---- 끌어다 놓기: 탭 전체에서 받는다 (실수로 놓아도 브라우저가 파일을 열지 않도록) ----
    let dragDepth = 0;
    const zone = () => (source === '3d' ? $.viewerWrap : $.dropzone);
    const hasFiles = (e) => !!e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
    el.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth++;
      zone().classList.add('is-dragover');
    });
    el.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    el.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) {
        $.dropzone.classList.remove('is-dragover');
        $.viewerWrap.classList.remove('is-dragover');
      }
    });
    el.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return; // 글자 끌어다 놓기(프롬프트 칸 등)는 그대로 둔다
      e.preventDefault();
      handleDrop(e);
    });
    // 탭 밖(상단 바·탭 줄·여백)에 놓아도 이 탭이 보이는 동안은 같은 방식으로 받는다
    document.addEventListener('dragover', (e) => {
      if (!visible || !hasFiles(e) || el.contains(e.target)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    document.addEventListener('drop', (e) => {
      if (!visible || !hasFiles(e) || el.contains(e.target)) return;
      e.preventDefault();
      handleDrop(e);
    });
    function handleDrop(e) {
      dragDepth = 0;
      $.dropzone.classList.remove('is-dragover');
      $.viewerWrap.classList.remove('is-dragover');
      const pending = filesFromDataTransfer(e.dataTransfer); // 동기적으로 시작해야 폴더를 읽을 수 있음
      pending.then((files) => {
        if (!files.length) return;
        if (files.some(isModelFile) || source === '3d') {
          load3d(files);
          return;
        }
        const img = files.find(isImageFile);
        if (img) runImageFile(img);
        else toast('이미지(PNG·JPG·WEBP·GIF·BMP)나 3D 모델 파일을 놓아 주세요.', 'warn');
      }).catch((err) => {
        console.error(err);
        toast('놓은 파일을 읽지 못했습니다.', 'error');
      });
    }

    // ---- 붙여넣기 (이 탭이 보일 때만) ----
    document.addEventListener('paste', (e) => {
      if (!visible || !$) return;
      const f = clipboardImage(e.clipboardData);
      if (!f) return;
      const t = e.target;
      // 프롬프트 칸에 글자를 붙여넣는 경우 등은 그대로 둔다 (이미지가 있을 때만 가로챔)
      if (t instanceof HTMLElement && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT') && e.clipboardData.getData('text')) return;
      e.preventDefault();
      runImageFile(f, f.name && f.name !== 'image.png' ? f.name : '붙여넣은 이미지');
    });

    on('settings', () => {
      if (!thrTouched && result && !busy) {
        resetThresholds();
        renderResults();
      } else if (!thrTouched) {
        resetThresholds();
      }
    });
    on('tagger', () => {
      if (!result && !busy && !errorState) renderResults();
    });

    resetThresholds();
    setSource(source);
    setPreview('', '');
    render3dPlaceholder();
    render3dInfo();
    render3dToolbar();
    update3dButtons();
    renderResults();
    renderImgPose();
    loadTagger();
    loadPoses();
  }

  return {
    id: 'extract',
    title: '프롬프트 추출',
    mount,
    async show(params, query) {
      visible = true;
      const path = query && typeof query.get === 'function' ? query.get('path') : null;
      const mode = params && params[0];
      if (mode === '3d' || mode === 'image') {
        setSource(mode);
        replaceHash('#/extract');
      }
      if (path) {
        // 주소에서 지워 두어야 탭을 다시 눌렀을 때 같은 이미지를 또 추출하지 않는다
        replaceHash('#/extract');
        runPath(path);
        return;
      }
      if (source === '3d') ensureViewer().catch(() => {});
      if (!store.tagger || store.taggerError) loadTagger();
    },
    hide() {
      visible = false;
    },
    isDirty: () => false,
  };
}
