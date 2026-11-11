// 포즈 따라 그리기(ControlNet OpenPose) 공용 UI (§9.9)
// 포즈 카드 · [포즈 고르기] 창 · 생성 옵션 컨트롤(강도·적용 구간·ControlNet) · 감지 요청과 오류 안내.
// 생성 탭·캐릭터 탭·프롬프트 추출 탭·작업 목록·라이트박스가 함께 쓴다.
import { h, clamp, lsGet, lsSet, SIZES, SIZE_LABELS, fmtRelative, fmtDateTime, prepareImage, stripExt } from './util.js';
import { toast, openModal, confirmDialog, choiceDialog, tipNode, spinner, emptyState, withBusy } from './ui.js';
import { api } from './api.js';
import {
  store, on, loadPoses, poseByName, addPoseLocal, removePoseLocal, resolvePose, activeJobs,
} from './store.js';

export const DEFAULT_CONTROLNET = 'noob_openpose.safetensors';
export const POSE_SOURCE_LABELS = { '3d': '3D', image: '이미지', upload: '업로드' };
const STRENGTH_RANGE = [0.1, 2.0];
const END_RANGE = [0.1, 1.0];
const round2 = (v) => Math.round(Number(v) * 100) / 100;
const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/bmp,.png,.jpg,.jpeg,.webp,.gif,.bmp';

// ======================= 이름·크기·모델 =======================
export function poseUrl(name, variant = '') {
  return `/poses/${encodeURIComponent(name)}${variant ? `/${variant}` : ''}`;
}
export function poseNameOf(p) {
  if (!p) return '';
  return typeof p === 'string' ? p : String(p.name || '');
}
/** 카드·목록에 보일 이름: 만든 원본(파일/모델 이름)이 있으면 그것, 없으면 파일 이름 */
export function poseTitle(item) {
  if (!item) return '';
  return item.origin ? String(item.origin) : stripExt(item.name || '');
}
export function sizeKeyFor(w, hh) {
  return Object.keys(SIZES).find((k) => SIZES[k][0] === Number(w) && SIZES[k][1] === Number(hh)) || null;
}
export function sizeText(w, hh) {
  const k = sizeKeyFor(w, hh);
  return k ? `${SIZE_LABELS[k]} ${w}×${hh}` : `${w}×${hh}`;
}
/** 이 포즈로 생성할 때 쓰는 기본 크기 [w, h] (서버의 gen_size) */
export function poseGenSize(item) {
  if (!item) return null;
  if (Array.isArray(item.gen_size) && item.gen_size.length === 2) return [Number(item.gen_size[0]), Number(item.gen_size[1])];
  if (item.width && item.height) return [Number(item.width), Number(item.height)];
  return null;
}

/** 설치된 ControlNet 목록. 아직 못 불러왔으면 null */
export function controlnetList() {
  return store.models ? (store.models.controlnets || []) : null;
}
export function controlnetInfo(name) {
  return (controlnetList() || []).find((c) => c.name === name) || null;
}
export function controlnetLabel(name) {
  const c = controlnetInfo(name);
  if (c && c.label) return c.label;
  return stripExt(String(name || '').split('/').pop());
}
export function defaultPoseModel() {
  const s = store.settings || {};
  return typeof s.pose_model === 'string' && s.pose_model ? s.pose_model : DEFAULT_CONTROLNET;
}
export function defaultPoseEnd() {
  const v = Number((store.settings || {}).pose_end);
  return isFinite(v) && v > 0 ? clamp(v, END_RANGE[0], END_RANGE[1]) : 1;
}
/** 모델별 처음 강도: 기본 ControlNet이면 전역 설정의 기본 강도, 다른 모델이면 그 모델의 권장 강도 (서버 규칙과 같음) */
export function recommendedStrength(model) {
  const m = model || defaultPoseModel();
  if (m === defaultPoseModel()) {
    const v = Number((store.settings || {}).pose_strength);
    if (isFinite(v) && v > 0) return clamp(round2(v), STRENGTH_RANGE[0], STRENGTH_RANGE[1]);
  }
  const c = controlnetInfo(m);
  const v = c ? Number(c.strength) : NaN;
  return isFinite(v) && v > 0 ? round2(v) : 1;
}
function controlnetDesc(c) {
  if (!c) return '';
  const style = c.style === 'thick' ? '굵은 선 뼈대 그림을 자동으로 씁니다' : '표준(얇은 선) 뼈대 그림을 씁니다';
  const known = c.known === false ? ' · 알려지지 않은 모델이라 표준 선·강도 1.0으로 씁니다' : '';
  return `${style} · 권장 강도 ${c.strength != null ? c.strength : 1}${known}`;
}

// ======================= 감지·오류 =======================
/** 서버 오류 → {title, text, help(도움말 앵커), kind} */
export function poseErrorInfo(e, fallbackTitle = '포즈를 만들지 못했습니다') {
  const status = e && e.status;
  const data = (e && e.data) || {};
  const msg = (e && e.message) || '포즈를 만들지 못했습니다.';
  if (status === 503 || data.reason === 'unavailable') {
    return { kind: 'unavailable', title: '포즈 감지를 사용할 수 없습니다', text: msg, help: 'ts-pose-detect' };
  }
  if (status === 422 || data.reason === 'no_person') {
    return {
      kind: 'no_person', title: '사람(인물)을 찾지 못했습니다',
      text: `${msg}${/전신|크게/.test(msg) ? '' : ' 인물이 크게·전신으로 보이는 그림일수록 잘 찾습니다.'}`, help: 'ts-pose-detect',
    };
  }
  if (status === 404 && !data.error) {
    return { kind: 'setup', title: '서버가 아직 포즈 기능을 지원하지 않습니다', text: 'VN Studio를 다시 시작한 뒤 시도해 주세요.', help: 'pose-install' };
  }
  if (status === 413) return { kind: 'error', title: fallbackTitle, text: msg, help: 'pose-image' };
  return { kind: 'error', title: fallbackTitle, text: msg, help: 'ts-pose' };
}
/** 제목과 본문을 한 줄로 (서버 문구가 제목과 같은 말로 시작하면 제목을 반복하지 않는다) */
export function poseErrorLine(i) {
  if (!i) return '';
  const head = String(i.title || '').replace(/[.。]$/, '');
  return head && String(i.text || '').startsWith(head) ? String(i.text) : `${i.title}. ${i.text}`;
}
export function toastPoseError(e, fallbackTitle) {
  if (!e || e.aborted || e.name === 'AbortError') return;
  const i = poseErrorInfo(e, fallbackTitle);
  toast(i.text, i.kind === 'no_person' ? 'warn' : 'error', {
    title: i.title,
    timeout: 12000,
    action: { label: '도움말', onClick: () => { location.hash = `#/help/${i.help}`; } },
  });
}
export function detectBusyText() {
  return store.posesInfo && store.posesInfo.loaded
    ? '포즈를 감지하는 중…'
    : '포즈 감지 모델을 불러오는 중… (처음 한 번은 10초쯤 걸립니다)';
}
const stripItem = (r) => {
  if (!r || typeof r !== 'object') return r;
  const { keypoints, people, cropped, detected, elapsed, cold, path, ...rest } = r;
  return { ...rest, people: people ?? rest.people ?? null, cropped, detected };
};

/**
 * 그림에서 포즈 감지 → input/poses/에 저장된 항목(+ people·cropped·detected·elapsed·cold).
 * file(File/Blob) 또는 path(output/ 기준 갤러리 경로). 실패하면 ApiError를 던진다(토스트는 부른 쪽에서).
 */
export async function detectPose({ file = null, filename = '', path = '', width, height, origin = '', extra = null, signal } = {}) {
  // extra: 3D 렌더에서 감지할 때 함께 저장할 정보 {source:'3d', view, framing, clip}
  const extras = Object.entries(extra || {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  let r;
  if (path) {
    const body = { path: String(path).replace(/^\/+/, '').replace(/^output\//, '') };
    if (width && height) Object.assign(body, { width, height });
    if (origin) body.origin = origin;
    for (const [k, v] of extras) body[k] = String(v);
    r = await api('/api/poses/detect', { method: 'POST', body, silent: true, signal, timeout: 120000 });
  } else {
    let prep;
    try {
      prep = await prepareImage(file);
    } catch (e) {
      throw Object.assign(new Error((e && e.message) || '이미지를 읽을 수 없습니다.'), { status: 400, data: { reason: 'image' } });
    }
    const base = stripExt(filename || (file && file.name) || 'image') || 'image';
    const fd = new FormData();
    fd.append('image', prep.blob, prep.resized ? `${base}.${prep.blob.type === 'image/jpeg' ? 'jpg' : 'png'}` : (filename || (file && file.name) || 'image.png'));
    if (width && height) {
      fd.append('width', String(width));
      fd.append('height', String(height));
    }
    if (origin) fd.append('origin', origin);
    for (const [k, v] of extras) fd.append(k, String(v));
    r = await api('/api/poses/detect', { method: 'POST', body: fd, silent: true, signal, timeout: 120000 });
  }
  if (store.posesInfo) store.posesInfo.loaded = true;
  addPoseLocal(stripItem(r));
  return r;
}

/** 감지 결과 한 줄 요약 (토스트·안내용) */
export function detectSummary(r) {
  if (!r) return '';
  const parts = [`${sizeText(r.width, r.height)}`];
  if (r.people != null) parts.push(`${r.people}명`);
  if (r.detected > (r.people || 0)) parts.push(`감지 ${r.detected}명 중 가장 큰 사람`);
  if (r.hands) parts.push('손 포함');
  if (r.cropped) parts.push('가운데 기준으로 잘림');
  return parts.join(' · ');
}

// ======================= 썸네일·카드 =======================
/**
 * 뼈대 그림 썸네일. 원본 미리보기(src)가 있으면 마우스를 올리거나 토글하면 원본이 보인다.
 * @returns {{el: HTMLElement, setShowSrc: (on: boolean) => void, hasSrc: boolean}}
 */
export function poseThumb(item, { cls = '', alt = '' } = {}) {
  const map = h('img', { class: 'pose-img pose-img-map', alt: alt || `${poseTitle(item)} 뼈대`, loading: 'lazy', decoding: 'async', draggable: 'false' });
  const el = h('div', { class: `pose-thumb ${cls}` }, map);
  const w = Number(item && item.width) || 832;
  const hh = Number(item && item.height) || 1216;
  el.style.setProperty('--pose-ar', `${w} / ${hh}`);
  map.addEventListener('error', () => el.classList.add('is-broken'), { once: true });
  map.addEventListener('load', () => {
    if (map.naturalWidth && map.naturalHeight) el.style.setProperty('--pose-ar', `${map.naturalWidth} / ${map.naturalHeight}`);
    el.classList.add('is-loaded');
  }, { once: true });
  map.src = item.thumb || item.url || poseUrl(item.name);
  let src = null;
  const hasSrc = !!(item && item.src_url);
  if (hasSrc) {
    src = h('img', { class: 'pose-img pose-img-src', alt: `${poseTitle(item)} 원본`, loading: 'lazy', decoding: 'async', draggable: 'false' });
    src.src = item.src_url;
    el.append(src);
    el.classList.add('has-src');
  }
  return {
    el,
    hasSrc,
    setShowSrc(v) { el.classList.toggle('show-src', !!v && hasSrc); },
  };
}

/** 작은 아이콘 크기 썸네일(작업 목록 칩 등). 파일이 지워졌으면 '?'로 */
export function poseMiniThumb(name, url) {
  const img = h('img', { class: 'pose-mini', alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' });
  img.addEventListener('error', () => img.replaceWith(h('span', { class: 'pose-mini is-broken', 'aria-hidden': 'true' }, '?')), { once: true });
  img.src = url || poseUrl(name);
  return img;
}

/**
 * 포즈 카드: 맵 썸네일(원본 hover/토글) + 이름·크기·원본 정보
 * @param {{item?: object, name?: string, status?: 'ok'|'loading'|'missing'|'unknown', compact?: boolean}} o
 */
export function poseCard(o = {}) {
  const { item = null, name = '', status = 'ok', compact = false } = o;
  const el = h('div', { class: `pose-card${compact ? ' is-compact' : ''}` });
  if (status === 'loading' && !item) {
    el.classList.add('is-loading');
    el.append(h('div', { class: 'pose-card-ph' }, h('span', { class: 'spinner', 'aria-hidden': 'true' })),
      h('div', { class: 'pose-card-body' }, h('div', { class: 'pose-card-title' }, '포즈를 확인하는 중…'), h('div', { class: 'pose-card-name' }, name)));
    return el;
  }
  if (status === 'unknown' && !item) {
    // 서버에 확인하지 못함(연결 오류·시간 초과) — 포즈는 그대로 붙여 보낸다 (get()이 포즈를 돌려줌)
    el.append(h('div', { class: 'pose-card-ph', 'aria-hidden': 'true' }, '?'),
      h('div', { class: 'pose-card-body' },
        h('div', { class: 'pose-card-title' }, '포즈를 확인하지 못했습니다'),
        h('div', { class: 'pose-card-name' }, name),
        h('div', { class: 'pose-card-sub muted' }, '서버에 연결하지 못해 파일이 있는지 확인하지 못했습니다. 포즈를 붙인 채로 생성합니다 — 문제가 있으면 [빼기]를 누르세요.')));
    return el;
  }
  if (status === 'missing' || !item) {
    el.classList.add('is-missing');
    el.append(h('div', { class: 'pose-card-ph', 'aria-hidden': 'true' }, '?'),
      h('div', { class: 'pose-card-body' },
        h('div', { class: 'pose-card-title' }, '포즈 파일을 찾을 수 없습니다'),
        h('div', { class: 'pose-card-name' }, name),
        h('div', { class: 'pose-card-sub warn-text' }, '삭제되었거나 옮겨진 것 같습니다. 포즈 없이 생성됩니다 — [빼기]를 누르거나 다른 포즈를 고르세요.')));
    return el;
  }
  const th = poseThumb(item, { cls: 'pose-card-img' });
  const gs = poseGenSize(item);
  const facts = [
    gs ? sizeText(gs[0], gs[1]) : '',
    POSE_SOURCE_LABELS[item.source] || '',
    item.people != null ? `${item.people}명` : '',
    item.hands ? '손 포함' : '',
  ].filter(Boolean).join(' · ');
  const body = h('div', { class: 'pose-card-body' },
    h('div', { class: 'pose-card-title', title: poseTitle(item) }, poseTitle(item)),
    h('div', { class: 'pose-card-sub' }, facts),
    compact ? null : h('div', { class: 'pose-card-name', title: item.name }, item.name));
  if (status === 'unknown') body.append(h('div', { class: 'pose-card-sub muted' }, '파일이 있는지 확인하지 못했습니다(서버 연결 확인).'));
  if (th.hasSrc) {
    const tg = h('button', { type: 'button', class: 'link-btn pose-card-toggle', 'aria-pressed': 'false' }, '원본 보기');
    tg.addEventListener('click', () => {
      const on_ = tg.getAttribute('aria-pressed') !== 'true';
      tg.setAttribute('aria-pressed', on_ ? 'true' : 'false');
      tg.textContent = on_ ? '뼈대 보기' : '원본 보기';
      th.setShowSrc(on_);
    });
    body.append(tg);
    th.el.dataset.tooltip = '마우스를 올리면 포즈를 만든 원본(렌더·그림)이 보입니다';
  }
  el.append(th.el, body);
  return el;
}

// ======================= 포즈 고르기 창 =======================
/**
 * @param {{current?: string, onPick: (item: object, info?: {detected?: boolean, uploaded?: boolean}) => void, title?: string}} o
 */
export function openPosePicker(o = {}) {
  const { current = '', onPick, title = '포즈 고르기' } = o;
  let view = lsGet('vn.pose.pickView', 'map') === 'src' ? 'src' : 'map';
  const seg = h('div', { class: 'seg seg-sm', role: 'group', 'aria-label': '썸네일 종류' });
  const mapBtn = h('button', { type: 'button', class: 'seg-btn' }, '뼈대');
  const srcBtn = h('button', { type: 'button', class: 'seg-btn' }, '원본');
  seg.append(mapBtn, srcBtn);
  const detectBtn = h('button', { type: 'button', class: 'btn btn-sm' }, '이미지에서 감지');
  const detectWrap = h('span', { class: 'btn-guard' }, detectBtn);
  const uploadBtn = h('button', { type: 'button', class: 'btn btn-sm btn-ghost' }, '뼈대 그림 올리기');
  uploadBtn.dataset.tooltip = '다른 프로그램에서 만든 OpenPose 뼈대 그림(검은 배경)을 그대로 라이브러리에 넣습니다';
  const make3d = h('a', { class: 'btn btn-sm btn-ghost', href: '#/extract/3d' }, '3D에서 만들기');
  make3d.dataset.tooltip = '프롬프트 추출 탭의 3D 모델에서 자세를 잡아 포즈로 저장합니다';
  const folderBtn = h('button', { type: 'button', class: 'btn btn-sm btn-ghost' }, '폴더 열기');
  folderBtn.dataset.tooltip = 'input/poses/ 폴더를 Finder에서 엽니다';
  const fileIn = h('input', { type: 'file', accept: IMAGE_ACCEPT, hidden: true });
  const uploadIn = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp', hidden: true });
  const status = h('div', { class: 'pose-pick-status', role: 'status' });
  const grid = h('div', { class: 'pose-grid', role: 'list' });
  const body = h('div', { class: 'pose-pick' },
    h('div', { class: 'pose-pick-bar' },
      h('span', { class: 'pose-pick-label' }, '보기'), seg, tipNode('pose_library'),
      h('span', { class: 'toolbar-spacer' }),
      detectWrap, tipNode('pose_detect'), uploadBtn, make3d, folderBtn),
    h('p', { class: 'field-note' }, '쓸 포즈를 누르세요. 그림을 이 창에 끌어다 놓아도 포즈를 감지합니다. 전신 그림일수록 정확합니다.'),
    status, grid, fileIn, uploadIn);

  let ctl = null;
  let closed = false;
  const pick = (item, info) => {
    if (closed) return;
    if (ctl) ctl.close();
    try { onPick && onPick(item, info); } catch (e) { console.error(e); }
  };

  function setView(v) {
    view = v;
    lsSet('vn.pose.pickView', v);
    for (const [b, k] of [[mapBtn, 'map'], [srcBtn, 'src']]) {
      b.classList.toggle('active', view === k);
      b.setAttribute('aria-pressed', view === k ? 'true' : 'false');
    }
    grid.classList.toggle('show-src', view === 'src');
  }
  mapBtn.addEventListener('click', () => setView('map'));
  srcBtn.addEventListener('click', () => setView('src'));

  function tile(item) {
    const th = poseThumb(item, { cls: 'pose-tile-img' });
    const isCur = item.name === current;
    const btn = h('button', { type: 'button', class: 'pose-tile-btn', 'aria-label': `${poseTitle(item)} 포즈 고르기` }, th.el);
    btn.addEventListener('click', () => pick(item));
    const gs = poseGenSize(item);
    const del = h('button', { type: 'button', class: 'icon-btn icon-btn-sm pose-tile-del', 'aria-label': `${poseTitle(item)} 포즈 삭제`, 'data-tooltip': '삭제 (휴지통으로)' }, '×');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      withBusy(del, () => removePose(item));
    });
    const t = h('div', { class: `pose-tile${isCur ? ' is-current' : ''}`, role: 'listitem' },
      btn,
      h('div', { class: 'pose-tile-meta' },
        h('div', { class: 'pose-tile-title', title: `${poseTitle(item)}\n${item.name}` }, poseTitle(item)),
        h('div', { class: 'pose-tile-sub' },
          [gs ? `${gs[0]}×${gs[1]}` : '', POSE_SOURCE_LABELS[item.source] || '', item.created ? fmtRelative(item.created) : ''].filter(Boolean).join(' · '))),
      del,
      isCur ? h('span', { class: 'pose-tile-cur' }, '사용 중') : null);
    if (item.created) t.title = `만든 시각 ${fmtDateTime(item.created)}`;
    if (!th.hasSrc) t.classList.add('no-src');
    return t;
  }

  function render() {
    grid.replaceChildren();
    const info = store.posesInfo;
    const avail = !info || info.detect_available !== false;
    detectBtn.disabled = !avail;
    if (!avail) detectWrap.dataset.tooltip = `${info.detect_error || '포즈 감지 모델을 찾지 못했습니다.'} (도움말 › 문제 해결 › 포즈 감지 실패)`;
    else delete detectWrap.dataset.tooltip;
    if (store.poses == null) {
      if (store.posesError) {
        grid.append(h('div', { class: 'grid-error' }, h('span', {}, store.posesError),
          h('button', { type: 'button', class: 'btn btn-sm', onclick: () => { store.posesError = ''; loadPoses(); render(); } }, '다시 시도')));
      } else {
        grid.append(spinner('포즈 목록을 불러오는 중…'));
      }
      return;
    }
    if (!store.poses.length) {
      grid.append(emptyState({
        icon: '✋',
        title: '저장된 포즈가 없습니다',
        text: '그림에서 자세를 감지하거나, 프롬프트 추출 탭의 3D 모델에서 자세를 잡아 저장하면 여기에 쌓입니다.',
        actions: [
          h('button', { type: 'button', class: 'btn btn-sm btn-primary', disabled: !avail, onclick: () => fileIn.click() }, '이미지에서 감지'),
          h('a', { class: 'btn btn-sm', href: '#/extract/3d', onclick: () => ctl && ctl.close() }, '3D에서 만들기'),
        ],
      }));
      return;
    }
    const frag = document.createDocumentFragment();
    for (const it of store.poses) frag.append(tile(it));
    grid.append(frag);
  }

  async function removePose(item) {
    // 엔진은 작업을 실행할 때 포즈 파일을 읽는다 → 대기·진행 중인 작업이 쓰는 포즈를 지우면 그 작업이 오류로 끝난다
    const uses = activeJobs().filter((j) => poseNameOf(jobPose(j)) === item.name).length;
    const where = `${item.name} — user/trash/poses/ 폴더로 옮기므로 필요하면 Finder에서 되살릴 수 있습니다.`;
    const ok = uses
      ? (await choiceDialog({
        title: '포즈 삭제',
        message: `'${poseTitle(item)}' 포즈를 대기·진행 중인 작업 ${uses}개가 쓰고 있습니다.`,
        detail: `지금 지우면 아직 포즈를 불러오지 않은 작업은 오류로 끝납니다 — 작업이 끝난 뒤 지우세요. ${where}`,
        choices: [
          { label: '취소', kind: 'primary', value: false, autofocus: true },
          { label: '그래도 삭제', kind: 'danger', value: true },
        ],
      })) === true
      : await confirmDialog({
        title: '포즈 삭제',
        message: `'${poseTitle(item)}' 포즈를 삭제할까요?`,
        detail: `${where} 이 포즈로 만든 작업을 [같은 설정으로 다시] 하면 포즈 없이 진행됩니다.`,
        confirmText: '삭제',
        danger: true,
      });
    if (!ok) return;
    try {
      await api(`/api/poses/${encodeURIComponent(item.name)}${uses ? '?force=1' : ''}`, { method: 'DELETE' });
    } catch (e) {
      if (!(e && e.status === 404)) return;
    }
    removePoseLocal(item.name);
    toast(`포즈 '${poseTitle(item)}'를 휴지통으로 옮겼습니다.`, 'success');
    if (!closed) render();
  }

  function setStatus(node) {
    status.replaceChildren();
    if (node) status.append(node);
  }

  async function runDetect(file) {
    if (!file) return;
    setStatus(h('div', { class: 'loading-row' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', {}, detectBusyText())));
    await withBusy(detectBtn, async () => {
      try {
        const r = await detectPose({ file, origin: file.name && file.name !== 'image.png' ? file.name : '' });
        setStatus(null);
        toast(`포즈를 감지해 저장했습니다 (${detectSummary(r)}).`, 'success', { title: '포즈 감지' });
        pick(stripItem(r), { detected: true });
      } catch (e) {
        if (closed) return;
        const i = poseErrorInfo(e, '포즈를 감지하지 못했습니다');
        setStatus(h('div', { class: 'pose-pick-error' },
          h('span', {}, poseErrorLine(i)),
          h('a', { class: 'help-link', href: `#/help/${i.help}`, onclick: () => ctl && ctl.close() }, '? 도움말')));
        if (i.kind !== 'no_person') toastPoseError(e, '포즈를 감지하지 못했습니다');
      }
    });
  }
  async function runUpload(file) {
    if (!file) return;
    await withBusy(uploadBtn, async () => {
      const fd = new FormData();
      fd.append('pose', file, file.name || 'pose.png');
      fd.append('origin', file.name || '');
      try {
        const r = await api('/api/poses', { method: 'POST', body: fd, silent: true, timeout: 120000 });
        addPoseLocal(r);
        toast(`뼈대 그림을 포즈로 넣었습니다 (${sizeText(r.width, r.height)}).`, 'success');
        pick(r, { uploaded: true });
      } catch (e) {
        toastPoseError(e, '뼈대 그림을 넣지 못했습니다');
      }
    });
  }
  detectBtn.addEventListener('click', () => fileIn.click());
  fileIn.addEventListener('change', () => {
    const f = fileIn.files && fileIn.files[0];
    fileIn.value = '';
    runDetect(f);
  });
  uploadBtn.addEventListener('click', () => uploadIn.click());
  uploadIn.addEventListener('change', () => {
    const f = uploadIn.files && uploadIn.files[0];
    uploadIn.value = '';
    runUpload(f);
  });
  folderBtn.addEventListener('click', () => api('/api/open-folder', { method: 'POST', body: { which: 'poses' } }).catch(() => {}));
  make3d.addEventListener('click', () => { if (ctl) ctl.close(); });
  // 그림을 창에 끌어다 놓으면 감지
  body.addEventListener('dragover', (e) => {
    if (!e.dataTransfer || ![...(e.dataTransfer.types || [])].includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    body.classList.add('is-dragover');
  });
  body.addEventListener('dragleave', (e) => { if (e.target === body) body.classList.remove('is-dragover'); });
  body.addEventListener('drop', (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
    e.preventDefault();
    e.stopPropagation();
    body.classList.remove('is-dragover');
    const f = [...e.dataTransfer.files].find((x) => /^image\//.test(x.type || '') || /\.(png|jpe?g|webp|gif|bmp)$/i.test(x.name || ''));
    if (f) {
      if (detectBtn.disabled) toast(detectWrap.dataset.tooltip || '포즈 감지를 사용할 수 없습니다.', 'warn');
      else runDetect(f);
    } else {
      toast('이미지 파일(PNG·JPG·WEBP)을 놓아 주세요.', 'warn');
    }
  });

  const off = on('poses', () => { if (!closed) render(); });
  setView(view);
  render();
  ctl = openModal({
    title, body, size: 'xl', className: 'pose-pick-modal',
    onClose: () => { closed = true; off(); },
  });
  loadPoses();
  return ctl;
}

// ======================= 생성 옵션 컨트롤 =======================
function sliderField({ id, label, tip, min, max, step, onInput, aside = null }) {
  const range = h('input', { type: 'range', id, min: String(min), max: String(max), step: String(step) });
  const num = h('input', { type: 'number', class: 'num-sm', min: String(min), max: String(max), step: String(step), 'aria-label': `${label} 값` });
  const norm = (v) => {
    let n = Number(v);
    if (!isFinite(n)) n = min;
    return round2(clamp(n, min, max));
  };
  const set = (v) => {
    const n = norm(v);
    range.value = String(n);
    num.value = String(n);
  };
  range.addEventListener('input', () => {
    num.value = String(norm(range.value));
    onInput(norm(range.value));
  });
  num.addEventListener('change', () => {
    set(num.value);
    onInput(norm(num.value));
  });
  const el = h('div', { class: 'field pose-field' },
    h('div', { class: 'field-label' }, h('label', { for: id }, label), tip ? tipNode(tip) : null, aside),
    h('div', { class: 'range-field' }, range, num));
  return { el, set, range, num };
}

/**
 * 생성 탭(full)·캐릭터 탭(compact)의 포즈 묶음.
 * get() → {name, strength, end, model}(full) | {name, strength}(compact) | null(포즈 없음·파일 없음)
 * @param {{idPrefix?: string, variant?: 'full'|'compact', onChange?: (ev: {reason: string, item?: object}) => void, note?: string}} o
 */
export function poseControl(o = {}) {
  const { idPrefix = 'pose', variant = 'full', onChange, note = '' } = o;
  const full = variant === 'full';
  let name = '';
  let item = null;
  let status = 'none'; // none | loading | ok | missing | unknown
  let strength = null; // null = 모델의 처음 값(설정 기본값/권장값)을 따름
  let end = null;
  let model = null;
  let tok = 0;
  let warning = '';

  const cardSlot = h('div', { class: 'pose-card-slot' });
  const pickBtn = h('button', { type: 'button', class: 'btn btn-sm' }, '포즈 고르기');
  const clearBtn = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', hidden: true }, '빼기');
  clearBtn.dataset.tooltip = '포즈를 빼고 프롬프트대로 그립니다';
  const btns = h('div', { class: 'pose-btns' }, pickBtn, tipNode('pose_pick'), clearBtn);
  const empty = h('div', { class: 'pose-empty' },
    h('span', { class: 'pose-empty-icon', 'aria-hidden': 'true' }, '✋'),
    h('span', {}, full
      ? '포즈 없음 — 자세는 프롬프트대로 그립니다. 포즈를 고르면 그 뼈대 그림의 자세를 따라 그립니다.'
      : '포즈 없음 — 고르면 시안·스프라이트·CG가 그 자세를 따라 그립니다.'));
  const sStrength = sliderField({
    id: `${idPrefix}-strength`, label: '강도', tip: 'pose_strength', min: STRENGTH_RANGE[0], max: STRENGTH_RANGE[1], step: 0.05,
    onInput: (v) => { strength = v; fire('strength'); },
  });
  const sEnd = full ? sliderField({
    id: `${idPrefix}-end`, label: '적용 구간(끝)', tip: 'pose_end', min: END_RANGE[0], max: END_RANGE[1], step: 0.05,
    onInput: (v) => { end = v; fire('end'); },
  }) : null;
  const modelSel = full ? h('select', { class: 'select', id: `${idPrefix}-model` }) : null;
  const modelNote = full ? h('div', { class: 'field-note' }) : null;
  const modelField = full ? h('div', { class: 'field pose-field pose-model-field' },
    h('div', { class: 'field-label' }, h('label', { for: `${idPrefix}-model` }, 'ControlNet'), tipNode('pose_model'),
      h('a', { class: 'help-link', href: '#/help/pose-controlnet', title: '도움말에서 자세히 보기' }, '? 차이')),
    modelSel, modelNote) : null;
  const opts = h('div', { class: 'pose-opts', hidden: true },
    sStrength.el, sEnd ? sEnd.el : null, modelField);
  const optsFoot = h('div', { class: 'pose-opts-foot', hidden: true },
    h('span', { class: 'field-note' }, full
      ? '자세를 안 따라오면 강도↑, 그림이 딱딱하거나 뭉개지면 강도↓. 포즈를 붙이면 1차 생성이 약 40% 느려집니다.'
      : '포즈를 붙이면 1차 생성이 약 40% 느려집니다.'),
    h('a', { class: 'help-link', href: '#/help/pose-strength', title: '도움말에서 자세히 보기' }, '? 강도·구간'));
  const noteEl = h('div', { class: 'field-note pose-note', hidden: !note }, note);
  const warnEl = h('div', { class: 'pose-warn', hidden: true });
  const el = h('div', { class: `pose-ctl pose-ctl-${variant}` },
    h('div', { class: 'pose-main' }, cardSlot, btns), opts, optsFoot, noteEl, warnEl);

  const effModel = () => model || defaultPoseModel();
  const effStrength = () => (strength != null ? strength : recommendedStrength(effModel()));
  const effEnd = () => (end != null ? end : defaultPoseEnd());
  const fire = (reason, extra = {}) => {
    renderWarn();
    if (onChange) {
      try { onChange({ reason, ...extra }); } catch (e) { console.error(e); }
    }
  };

  function renderModel() {
    if (!full) return;
    const list = controlnetList();
    modelSel.replaceChildren();
    const cur = effModel();
    if (!list) {
      modelSel.append(h('option', { value: cur }, `${controlnetLabel(cur)} (목록 불러오는 중…)`));
    } else {
      for (const c of list) {
        const opt = h('option', { value: c.name }, `${c.label || stripExt(c.name)}${c.name === defaultPoseModel() ? '  · 기본' : ''}`);
        opt.title = `${c.name}\n${controlnetDesc(c)}`;
        modelSel.append(opt);
      }
      if (!list.some((c) => c.name === cur)) modelSel.append(h('option', { value: cur }, `${controlnetLabel(cur)} (설치 안 됨)`));
    }
    modelSel.value = cur;
    const c = controlnetInfo(cur);
    modelNote.textContent = c ? controlnetDesc(c) : '';
    modelSel.title = c ? `${c.name}\n${controlnetDesc(c)}` : cur;
  }

  function renderWarn() {
    const msgs = [];
    const list = controlnetList();
    if (status !== 'none' && list) {
      if (!list.length) msgs.push(['설치된 ControlNet(OpenPose) 모델이 없어 포즈를 쓸 수 없습니다. models/controlnet/ 폴더에 넣은 뒤 모델·LoRA 탭에서 [목록 새로고침]을 누르세요.', 'ts-controlnet']);
      else if (!list.some((c) => c.name === effModel())) msgs.push([`ControlNet 파일 '${effModel()}'을(를) 찾을 수 없습니다. 다른 ControlNet을 고르세요.`, 'ts-controlnet']);
    }
    if (warning && status !== 'none') msgs.push([warning, 'pose-limits']);
    warnEl.replaceChildren();
    for (const [t, help] of msgs) {
      warnEl.append(h('div', { class: 'pose-warn-row' },
        h('span', { class: 'pose-warn-icon', 'aria-hidden': 'true' }, '!'), h('span', {}, t),
        h('a', { class: 'help-link', href: `#/help/${help}`, title: '도움말에서 자세히 보기' }, '? 해결')));
    }
    warnEl.hidden = !msgs.length;
  }

  function render() {
    cardSlot.replaceChildren(status === 'none' ? empty : poseCard({ item, name, status, compact: !full }));
    clearBtn.hidden = status === 'none';
    pickBtn.textContent = status === 'none' ? '포즈 고르기' : '다른 포즈';
    const show = status === 'ok' || status === 'unknown' || status === 'loading';
    opts.hidden = !show;
    optsFoot.hidden = !show;
    sStrength.set(effStrength());
    if (sEnd) sEnd.set(effEnd());
    renderModel();
    renderWarn();
  }

  function pick(it, reason = 'pick') {
    if (!it || !it.name) return;
    tok++;
    name = it.name;
    item = it;
    status = 'ok';
    render();
    fire(reason, { item });
  }

  /** 이름(또는 {name, strength, end, model})으로 설정 → 파일 확인. reason='pick'이면 확인 후 크기 맞추기 등 */
  async function load(v, { reason = 'restore' } = {}) {
    const n = poseNameOf(v);
    if (v && typeof v === 'object') {
      strength = isFinite(Number(v.strength)) && v.strength !== null && v.strength !== '' ? round2(clamp(Number(v.strength), ...STRENGTH_RANGE)) : null;
      end = isFinite(Number(v.end)) && v.end !== null && v.end !== '' ? round2(clamp(Number(v.end), ...END_RANGE)) : null;
      model = typeof v.model === 'string' && v.model ? v.model : null;
    } else {
      strength = null;
      end = null;
      model = null;
    }
    if (!n) {
      clear(true);
      return 'none';
    }
    const my = ++tok;
    name = n;
    item = poseByName(n);
    status = item ? 'ok' : 'loading';
    render();
    if (item) {
      fire(reason, { item });
      return status;
    }
    const r = await resolvePose(n);
    if (my !== tok) return status;
    if (r) {
      item = r;
      status = 'ok';
    } else {
      item = null;
      status = r === null ? 'missing' : 'unknown';
    }
    render();
    fire(status === 'ok' ? reason : status, { item });
    return status;
  }

  function clear(silent = false) {
    tok++;
    name = '';
    item = null;
    status = 'none';
    render();
    if (!silent) fire('clear');
  }

  pickBtn.addEventListener('click', () => {
    openPosePicker({
      current: name,
      onPick: (it) => pick(it),
    });
  });
  clearBtn.addEventListener('click', () => clear());
  if (modelSel) {
    modelSel.addEventListener('change', () => {
      const prev = effStrength();
      model = modelSel.value || null;
      if (model === defaultPoseModel()) model = null;
      // ControlNet을 바꾸면 그 모델의 권장 강도로 옮긴다
      strength = null;
      render();
      const now = effStrength();
      if (now !== prev) toast(`강도를 '${controlnetLabel(effModel())}'의 권장값 ${now}(으)로 맞췄습니다.`, 'info');
      fire('model');
    });
  }

  on('poses', (d) => {
    if (!name) return;
    if (d && d.deleted === name) {
      // 앱에서 지운 포즈 → 빼고 저장(새로고침해도 '파일 없음'이 남지 않게). 앱 밖에서 지운 경우만 아래처럼 'missing'
      clear();
      toast('사용 중이던 포즈를 지워 포즈 없이 생성합니다.', 'info');
      return;
    }
    const fresh = poseByName(name);
    if (fresh && status !== 'ok') {
      item = fresh;
      status = 'ok';
      render();
      fire('found', { item });
    } else if (fresh) {
      item = fresh;
    } else if (!d && store.poses && status === 'ok') {
      // 새로 받은 목록에 없다 → 목록 요청이 저장보다 먼저 시작됐을 수도 있으니 파일을 직접 확인
      const my = tok;
      const n = name;
      resolvePose(n).then((r) => {
        if (my !== tok || n !== name || r !== null) return;
        item = null;
        status = 'missing';
        render();
        fire('deleted');
      });
    }
  });
  on('settings', () => render());
  // 모델 목록이 늦게 오면 권장 강도(표에 있는 값)도 그때 정해진다 → 슬라이더까지 다시 그린다
  on('models', () => {
    sStrength.set(effStrength());
    renderModel();
    renderWarn();
  });
  render();

  return {
    el,
    get() {
      if (!name || status === 'none' || status === 'missing') return null;
      const out = { name, strength: effStrength() };
      if (full) {
        out.end = effEnd();
        out.model = effModel();
      }
      return out;
    },
    /** 초안 저장용 원래 값 (설정 기본값을 따르는 칸은 null) */
    state: () => (name ? { name, strength, end, model } : null),
    item: () => item,
    status: () => status,
    name: () => name,
    size: () => (status === 'ok' ? poseGenSize(item) : null),
    pick,
    load,
    clear,
    setWarning(t) {
      warning = t || '';
      renderWarn();
    },
    setNote(t) {
      noteEl.textContent = t || '';
      noteEl.hidden = !t;
    },
    refresh: render,
  };
}

// ======================= 작업·라이트박스 표시 =======================
/** 작업 객체의 포즈 정보: 실제 적용값(job.pose) → spec.pose 순 */
export function jobPose(job) {
  if (!job) return null;
  const p = job.pose || (job.spec && job.spec.pose);
  if (!p) return null;
  if (typeof p === 'string') return { name: p };
  return p.name ? p : null;
}

/** 작업 목록·모니터의 메타 칩 */
export function poseMetaChip(job) {
  const p = jobPose(job);
  if (!p) return null;
  const st = p.strength != null ? ` · 강도 ${round2(p.strength)}` : '';
  const c = h('span', { class: 'meta-chip meta-chip-pose' }, poseMiniThumb(p.name), `포즈${st}`);
  const lines = [`포즈: ${p.name}`];
  if (p.model) lines.push(`ControlNet: ${controlnetLabel(p.model)}`);
  if (p.strength != null) lines.push(`강도 ${round2(p.strength)}`);
  if (p.end != null) lines.push(`적용 구간(끝) ${round2(p.end)}`);
  if (Array.isArray(p.size)) lines.push(`크기 ${p.size[0]}×${p.size[1]}`);
  c.dataset.tooltip = lines.join('\n');
  return c;
}

/**
 * 라이트박스 정보 패널의 '포즈' 내용. p = /api/gallery/info의 pose {name, model, strength, end, exists, url, src_url}
 */
export function poseInfoBlock(p) {
  if (!p || !p.name) return null;
  const rows = h('dl', { class: 'kv' });
  const add = (k, v) => { if (v != null && v !== '') rows.append(h('dt', {}, k), h('dd', {}, v)); };
  add('이름', p.name);
  if (p.model) add('ControlNet', controlnetLabel(p.model));
  if (p.strength != null) add('강도', String(round2(p.strength)));
  if (p.end != null) add('적용 구간', `처음 ~ ${Math.round(Number(p.end) * 100)}%`);
  const wrap = h('div', { class: 'lb-pose' });
  if (p.exists === false) {
    wrap.append(h('div', { class: 'lb-pose-missing' }, '포즈 파일이 삭제되었습니다. [같은 설정으로 다시]·[생성 탭에서 편집]은 포즈 없이 진행됩니다.'), rows);
    return wrap;
  }
  const known = poseByName(p.name);
  const th = poseThumb({ ...(known || {}), name: p.name, url: p.url || poseUrl(p.name), thumb: p.url || poseUrl(p.name), src_url: p.src_url || (known && known.src_url) || null }, { cls: 'lb-pose-img' });
  wrap.append(th.el, rows);
  if (th.hasSrc) th.el.dataset.tooltip = '마우스를 올리면 포즈의 원본이 보입니다';
  return wrap;
}
