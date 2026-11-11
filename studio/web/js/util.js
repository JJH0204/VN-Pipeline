// 공용 유틸리티: DOM 생성, 이스케이프, 포맷, 저장소, 태그 편집
// (다른 모듈에 의존하지 않음)

export const SIZES = {
  portrait: [832, 1216],
  landscape: [1216, 832],
  wide: [1344, 768],
  tall: [768, 1344],
  square: [1024, 1024],
};
export const SIZE_LABELS = { portrait: '세로', landscape: '가로', wide: '와이드', tall: '톨', square: '정사각' };
export const MODE_LABELS = { prompt: '자유 생성', concept: '캐릭터 시안', sprite: '스프라이트', cg: '이벤트 CG', bg: '배경', pixel: '도트', icon: '아이콘', sheet: '스프라이트 시트' };
export const KIND_LABELS = { concept: '시안', sprite: '스프라이트', cg: 'CG', prompt: '자유 생성', bg: '배경', pixel: '도트', icon: '아이콘', icon_size: '아이콘 (크기별)', sheet: '스프라이트 시트', other: '기타' };
/** 인물이 없는 모드: 포즈·얼굴/손 보정을 쓰지 않는다 */
export const NO_PEOPLE_MODES = ['bg', 'pixel', 'icon', 'sheet'];
export function noPeople(mode) {
  return NO_PEOPLE_MODES.includes(mode);
}
/** 도트 결과(output/pixel/…)인지 — 확대할 때 픽셀이 흐려지지 않게 그린다 */
export function isPixelPath(path) {
  return typeof path === 'string' && /^(_secret\/)?pixel\//.test(path);
}
export const STATUS_LABELS = { queued: '대기 중', running: '생성 중', done: '완료', error: '실패', cancelled: '취소됨' };
export const ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

// ---------- 이스케이프 / DOM ----------
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function esc(v) {
  return v == null ? '' : String(v).replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}

/** 간단한 하이퍼스크립트. 문자열 자식은 항상 텍스트 노드로 들어간다(XSS 안전). */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v; // 신뢰할 수 있는 정적 마크업 전용
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value' && 'value' in el) el.value = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false || c === true) continue;
    el.append(c instanceof Node ? c : String(c));
  }
}

/** root 아래 [data-ref] 요소를 {이름: 요소}로 모은다 */
export function refs(root) {
  const o = {};
  root.querySelectorAll('[data-ref]').forEach((el) => {
    if (!(el.dataset.ref in o)) o[el.dataset.ref] = el;
  });
  return o;
}

export function clear(el) {
  if (el) el.replaceChildren();
  return el;
}

// ---------- 경로 / URL ----------
export function encodePath(p) {
  return String(p || '').split('/').map(encodeURIComponent).join('/');
}
export function fileUrl(path) {
  return '/files/' + encodePath(path);
}
export function thumbUrl(path, w = 384) {
  return `/thumbs/${encodePath(path)}?w=${w}`;
}
export function basename(p) {
  const s = String(p || '');
  return s.slice(s.lastIndexOf('/') + 1);
}
export function dirname(p) {
  const s = String(p || '');
  const i = s.lastIndexOf('/');
  return i < 0 ? '' : s.slice(0, i);
}
export function stripExt(name) {
  return String(name || '').replace(/\.[^./]+$/, '');
}
export function qs(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v == null || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? '?' + s : '';
}

// ---------- 포맷 ----------
export function fmtBytes(n) {
  if (n == null || isNaN(n)) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function fmtDuration(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  if (sec < 60) return `${sec}초`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s ? `${m}분 ${s}초` : `${m}분`;
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${hh}시간 ${mm}분` : `${hh}시간`;
}

/** 예상 시간은 과한 정밀도를 피하려고 반올림 */
export function roundEta(sec) {
  sec = Math.max(0, Number(sec) || 0);
  if (sec < 60) return Math.max(5, Math.round(sec / 5) * 5);
  if (sec < 600) return Math.round(sec / 10) * 10;
  return Math.round(sec / 60) * 60;
}

export function fmtClock(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = sec % 60;
  const p = (n) => String(n).padStart(2, '0');
  return hh ? `${hh}:${p(mm)}:${p(ss)}` : `${p(mm)}:${p(ss)}`;
}

export function toMs(ts) {
  const n = Number(ts) || 0;
  return n > 1e12 ? n : n * 1000;
}
export function nowSec() {
  return Date.now() / 1000;
}

export function fmtDateTime(ts) {
  if (!ts) return '-';
  const d = new Date(toMs(ts));
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, now)) return `오늘 ${hm}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return `어제 ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}월 ${d.getDate()}일 ${hm}`;
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 ${hm}`;
}

export function fmtRelative(ts) {
  if (!ts) return '-';
  const diff = (Date.now() - toMs(ts)) / 1000;
  if (diff < 45) return '방금';
  if (diff < 3600) return `${Math.max(1, Math.round(diff / 60))}분 전`;
  if (diff < 86400) return `${Math.round(diff / 3600)}시간 전`;
  return fmtDateTime(ts);
}

export function fmtNumber(n, digits = 2) {
  const v = Number(n);
  if (!isFinite(v)) return '';
  return String(Math.round(v * 10 ** digits) / 10 ** digits);
}

// ---------- 일반 ----------
export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

export function debounce(fn, ms = 250) {
  let t = null;
  const d = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  d.cancel = () => clearTimeout(t);
  return d;
}

export function lsGet(key, def = null) {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return def;
    return JSON.parse(raw);
  } catch {
    return def;
  }
}
export function lsSet(key, val) {
  try {
    if (val === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(val));
  } catch {
    /* 저장소 사용 불가 — 무시 */
  }
}

export function randomSeed() {
  try {
    return crypto.getRandomValues(new Uint32Array(1))[0];
  } catch {
    return Math.floor(Math.random() * 4294967295);
  }
}

export function parseSeedFromName(name) {
  const m = /seed(\d{1,10})/i.exec(String(name || ''));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n <= 4294967295 ? n : null;
}

/** 키 순서와 무관한 직렬화 (변경 감지용) */
export function stableStringify(v) {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined)
    .map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

export function deepCopy(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 아래 대체 방식 시도 */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

// ---------- 크기 ----------
export function defaultSizeKey(mode) {
  if (mode === 'icon') return 'square';
  return mode === 'cg' || mode === 'bg' ? 'wide' : 'portrait';
}
export function sizeWH(size, mode = 'prompt') {
  if (Array.isArray(size) && size.length >= 2) return [Number(size[0]) || 832, Number(size[1]) || 1216];
  if (size && typeof size === 'object' && size.width) return [Number(size.width) || 832, Number(size.height) || 1216];
  if (typeof size === 'string' && SIZES[size]) return SIZES[size];
  return SIZES[defaultSizeKey(mode)];
}
export function sizeLabel(size, mode) {
  if (typeof size === 'string' && SIZES[size]) return `${SIZE_LABELS[size]} ${SIZES[size][0]}×${SIZES[size][1]}`;
  const [w, hh] = sizeWH(size, mode);
  return `${w}×${hh}`;
}
/** 포즈 맵 크기 → 그 포즈로 생성할 때 쓰는 크기 [w, h] (서버 vnlib.pose.gen_size와 같은 계산 — 바꾸면 함께 바꿀 것) */
export function poseGenSizeOf(w, hh) {
  w = Number(w);
  hh = Number(hh);
  if (!(w > 0 && hh > 0 && isFinite(w) && isFinite(hh))) return null;
  const a = w / hh;
  for (const [pw, ph] of Object.values(SIZES)) if (Math.abs(a / (pw / ph) - 1) <= 0.015) return [pw, ph];
  const AREA = 1024 * 1024; // 넓이를 SDXL 1메가픽셀에 맞춘다(줄이거나 키워서)
  if (!(w * hh >= AREA * 0.85 && w * hh <= AREA * 1.1)) {
    const k = Math.sqrt(AREA / (w * hh));
    w *= k;
    hh *= k;
  }
  let s = 1;
  if (Math.max(w, hh) > 2048) s = 2048 / Math.max(w, hh);
  if (Math.min(w, hh) * s < 512) s = 512 / Math.min(w, hh);
  const fit = (v) => clamp(Math.floor((v * s) / 8) * 8, 512, 2048);
  return [fit(w), fit(hh)];
}
/** 작업 기록의 실제 적용 포즈(job.pose {size: 맵 크기, gen_size?}) → 그 작업이 생성에 쓴 크기 [w, h] | null */
export function jobPoseSize(p) {
  if (!p || typeof p !== 'object') return null;
  if (Array.isArray(p.gen_size) && p.gen_size.length === 2) return [Number(p.gen_size[0]), Number(p.gen_size[1])];
  return Array.isArray(p.size) && p.size.length === 2 ? poseGenSizeOf(p.size[0], p.size[1]) : null;
}

// ---------- 프롬프트 태그 편집 ----------
export function normTag(t) {
  let s = String(t || '').trim().toLowerCase();
  s = s.replace(/^[([{]+/, '').replace(/[)\]}]+$/, '');
  s = s.replace(/:\s*-?\d+(\.\d+)?$/, '');
  return s.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

export function splitTags(text) {
  return String(text || '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function hasTag(text, tag) {
  const n = normTag(tag);
  return String(text || '').split(',').some((p) => normTag(p) === n);
}

const touched = new WeakSet();
/** 사용자가 직접 커서를 둔 적이 있는 textarea인지 추적 (없으면 끝에 추가) */
export function trackCaret(ta) {
  if (!ta || ta.dataset.caretTracked) return;
  ta.dataset.caretTracked = '1';
  ta.addEventListener('focus', () => touched.add(ta));
}

export function insertTag(ta, tag) {
  const v = ta.value;
  let pos = touched.has(ta) && typeof ta.selectionStart === 'number' ? ta.selectionStart : v.length;
  if (pos > v.length) pos = v.length;
  let before = v.slice(0, pos);
  let after = v.slice(pos);
  // 커서가 태그 중간이면 그 태그 뒤로 이동
  const tokenRest = (after.match(/^[^,]*/) || [''])[0];
  if (tokenRest.trim() && before.trim() && !/,\s*$/.test(before)) {
    const idx = after.indexOf(',');
    if (idx === -1) {
      before = v;
      after = '';
    } else {
      before = v.slice(0, pos + idx + 1);
      after = v.slice(pos + idx + 1);
    }
  }
  let prefix = before.replace(/[\s,]+$/, '');
  if (prefix) prefix += ', ';
  const rest = after.replace(/^[\s,]+/, '');
  ta.value = prefix + tag + (rest ? ', ' + rest : '');
  const caret = (prefix + tag).length;
  try {
    ta.setSelectionRange(caret, caret);
  } catch {
    /* 무시 */
  }
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

export function removeTag(ta, tag) {
  const n = normTag(tag);
  const parts = ta.value.split(',');
  const kept = parts.filter((p) => normTag(p) !== n);
  ta.value = kept.join(',').replace(/^\s*,\s*/, '').replace(/[\s,]+$/, '').replace(/^\s+/, '');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

/** 있으면 제거, 없으면 삽입. 삽입했으면 true */
export function toggleTag(ta, tag) {
  if (hasTag(ta.value, tag)) {
    removeTag(ta, tag);
    return false;
  }
  insertTag(ta, tag);
  return true;
}

/** 여러 태그(쉼표 문자열)를 중복 없이 추가 */
export function appendTags(ta, text) {
  for (const t of splitTags(text)) {
    if (!hasTag(ta.value, t)) insertTag(ta, t);
  }
}

// ---------- 투명 이미지 감지 (체커보드 배경용) ----------
const alphaCache = new Map();
let alphaCanvas = null;
/** 이미지에 투명 픽셀이 있는지 작은 캔버스로 확인. cb(boolean) */
export function detectAlpha(img, key, cb) {
  const k = key || img.currentSrc || img.src;
  if (alphaCache.has(k)) {
    cb(alphaCache.get(k));
    return;
  }
  if (key && !/\.(png|webp)$/i.test(key)) {
    alphaCache.set(k, false);
    cb(false);
    return;
  }
  try {
    alphaCanvas = alphaCanvas || document.createElement('canvas');
    alphaCanvas.width = 32;
    alphaCanvas.height = 32;
    const ctx = alphaCanvas.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, 32, 32);
    ctx.drawImage(img, 0, 0, 32, 32);
    const d = ctx.getImageData(0, 0, 32, 32).data;
    let a = false;
    for (let i = 3; i < d.length; i += 4) {
      if (d[i] < 250) {
        a = true;
        break;
      }
    }
    if (alphaCache.size > 2000) alphaCache.clear();
    alphaCache.set(k, a);
    cb(a);
  } catch {
    cb(false);
  }
}

// ---------- 업로드 이미지 준비 (프롬프트 추출·포즈 감지 공용) ----------
const MAX_SIDE = 2048;
const MAX_UPLOAD = 20 * 1024 * 1024;

export function toBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('이미지를 변환하지 못했습니다.'))), type, quality);
    } catch (e) {
      reject(e);
    }
  });
}

export function loadImageEl(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('이미지를 읽을 수 없습니다.'));
    };
    img.src = url;
  });
}

/**
 * 업로드 전 준비: 긴 변이 2048px를 넘거나 20MB를 넘으면 브라우저에서 줄인다(PNG, 투명도 유지).
 * 그래도 20MB를 넘으면 흰 배경 JPEG로 (서버도 투명 부분을 흰 배경에 합성하므로 결과는 같음).
 */
export async function prepareImage(file) {
  let src = null;
  try {
    src = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    try {
      src = await loadImageEl(file);
    } catch {
      throw new Error('이미지를 읽을 수 없습니다. 손상되었거나 지원하지 않는 형식일 수 있습니다.');
    }
  }
  const w = src.width || src.naturalWidth || 0;
  const hh = src.height || src.naturalHeight || 0;
  if (!w || !hh) throw new Error('이미지 크기를 알 수 없습니다.');
  const long = Math.max(w, hh);
  if (long <= MAX_SIDE && file.size <= MAX_UPLOAD) {
    if (src.close) src.close();
    return { blob: file, width: w, height: hh, resized: false };
  }
  const scale = Math.min(1, MAX_SIDE / long);
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(hh * scale));
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, cw, ch);
  if (src.close) src.close();
  let blob = await toBlob(canvas, 'image/png');
  if (blob.size > MAX_UPLOAD) {
    const c2 = document.createElement('canvas');
    c2.width = cw;
    c2.height = ch;
    const x2 = c2.getContext('2d');
    x2.fillStyle = '#ffffff';
    x2.fillRect(0, 0, cw, ch);
    x2.drawImage(canvas, 0, 0);
    blob = await toBlob(c2, 'image/jpeg', 0.92);
  }
  return { blob, width: cw, height: ch, resized: true, from: [w, hh] };
}
