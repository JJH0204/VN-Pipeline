// 재사용 컴포넌트: 프리셋 선택, LoRA 편집기, 크기/시드/장수/품질 입력, 태그 도우미,
// 썸네일 그리드, 작업 모니터(실시간 미리보기)
import {
  h, esc, refs, clamp, SIZES, SIZE_LABELS, MODE_LABELS, STATUS_LABELS, KIND_LABELS, sizeWH, sizeLabel,
  randomSeed, thumbUrl, fileUrl, basename, stripExt, toggleTag, hasTag, trackCaret, debounce, qs,
  fmtClock, fmtDuration, fmtRelative, nowSec, detectAlpha, copyText, noPeople, isPixelPath,
} from './util.js';
import { tipNode, toast, openMenu, emptyState, spinner, openModal, helpLink, withBusy } from './ui.js';
import { api } from './api.js';
import {
  store, loraByName, presetLabel, cancelJob, retryJob, characterById, isActive, activeJobs, engineBlockReason,
} from './store.js';
import { etaText, remainingText, jobEtaOpts } from './eta.js';
import { poseMetaChip, jobPose } from './pose.js';
import { TAG_CATEGORIES } from './data/tags.js';
import { openLightbox } from './lightbox.js';

const round2 = (v) => Math.round(Number(v) * 100) / 100;

// ======================= 프리셋 선택 =======================
/**
 * @param {{id?: string, allowDefault?: boolean, defaultLabel?: () => string, resolve?: (v: string) => string, onChange?: Function}} o
 */
export function presetSelect(o = {}) {
  const { id, allowDefault = false, onChange } = o;
  const defaultLabel = o.defaultLabel || (() => `기본 프리셋 사용 (${presetLabel(store.defaultPreset) || '없음'})`);
  const resolve = o.resolve || ((v) => v || store.defaultPreset);
  const select = h('select', { id, class: 'select' });
  const note = h('div', { class: 'field-note preset-note', hidden: true });
  const el = h('div', { class: 'preset-select' }, select, note);
  let value = '';

  function updateNote() {
    const eff = resolve(value);
    const p = store.presets[eff];
    const text = p ? (p.note || '') : (value ? '이 프리셋을 찾을 수 없습니다. 모델·LoRA 탭에서 확인하세요.' : '');
    note.textContent = text;
    note.hidden = !text;
    select.title = p ? `${p.label || eff}${p.note ? '\n' + p.note : ''}` : '';
  }
  function render() {
    select.replaceChildren();
    if (allowDefault) select.append(h('option', { value: '' }, defaultLabel()));
    const names = Object.keys(store.presets);
    for (const n of names) {
      const p = store.presets[n] || {};
      select.append(h('option', { value: n }, `${p.label || n}${n === store.defaultPreset ? '  · 기본' : ''}`));
    }
    if (value && !names.includes(value)) select.append(h('option', { value }, `${value} (없는 프리셋)`));
    if (!allowDefault && !value && names.length) value = store.defaultPreset && names.includes(store.defaultPreset) ? store.defaultPreset : names[0];
    if (!names.length && !allowDefault) select.append(h('option', { value: '' }, store.presetsLoaded ? '프리셋이 없습니다' : '불러오는 중…'));
    select.value = value;
    updateNote();
  }
  select.addEventListener('change', () => {
    value = select.value;
    updateNote();
    if (onChange) onChange(value);
  });
  render();
  return {
    el, select,
    get: () => value,
    set(v) { value = v || ''; render(); },
    effective: () => resolve(value),
    refresh: render,
  };
}

// ======================= 호환성 배지 =======================
const COMPAT = {
  ok: ['✅', '호환', 'ok'],
  warn: ['⚠️', '주의', 'warn'],
  bad: ['❌', '비호환', 'bad'],
  missing: ['❌', '파일 없음', 'bad'],
  unknown: ['?', '확인 불가', 'muted'],
};
export function compatBadge(c, label = '') {
  if (!c) return null;
  const [icon, text, kind] = COMPAT[c.level] || COMPAT.unknown;
  const b = h('span', { class: `badge badge-${kind} compat-badge` }, `${icon} ${label || text}`);
  b.dataset.tooltip = c.reason || text;
  return b;
}

/** 서버의 modelinfo.compatibility와 같은 규칙 (저장 전 체크포인트로 미리 계산할 때) */
export function computeCompat(l, ck, vpred) {
  if (!l) return null;
  if (!ck) return { level: 'warn', reason: '선택한 체크포인트 파일을 찾을 수 없음' };
  const la = l.arch || 'unknown';
  const ca = ck.arch || 'unknown';
  if (la === 'unknown' || ca === 'unknown') return { level: 'warn', reason: '아키텍처를 확인할 수 없음 — 직접 테스트 필요' };
  if (la !== ca) return { level: 'bad', reason: `${la}용 LoRA라 ${ca} 모델에서는 동작하지 않음` };
  const notes = [];
  const lf = l.family;
  const cf = ck.family;
  const anime = ['NoobAI', 'Illustrious'];
  if (lf && cf && lf !== cf && !(anime.includes(lf) && anime.includes(cf))) notes.push(`${lf} 계열로 학습됨 (모델은 ${cf} 계열) — 효과가 약하거나 그림체가 틀어질 수 있음`);
  if (l.prediction === 'v-pred' && !vpred) notes.push('v-pred 모델용으로 학습됨 — eps 모델에서는 색감이 달라질 수 있음');
  return notes.length ? { level: 'warn', reason: notes.join(' / ') } : { level: 'ok', reason: '호환' };
}

// 학습 데이터의 등급·메타 태그는 트리거가 아니므로 후보에서 뺀다
const RATING_TAGS = new Set(['nsfw', 'sfw', 'explicit', 'questionable', 'sensitive', 'general', 'safe']);
export function isRatingTag(t) {
  const s = String(t || '').trim().toLowerCase();
  return RATING_TAGS.has(s) || s.startsWith('rating:') || s.startsWith('rating_');
}

/** [넣기] 메뉴 항목. 메모에 트리거를 등록했으면 그것만, 없으면 자동 추출 후보(등급 태그 제외) */
export function loraTriggers(l) {
  if (!l) return [];
  const meta = l.meta || {};
  const t = (meta.trigger || '').trim();
  if (t) return [{ text: t, hint: '메모에 등록한 트리거', registered: true }];
  const out = [];
  for (const x of l.triggers || []) {
    if (x && !isRatingTag(x) && !out.some((o) => o.text === x)) out.push({ text: x, hint: '학습 태그 — 트리거가 아닐 수 있음' });
  }
  return out;
}

// ======================= LoRA 편집기 =======================
/**
 * @param {{getPreset?: () => string, getCompat?: (lora: object) => object|null, inherited?: () => Array<{name: string, weight: number, source: string}>, onChange?: Function, onTrigger?: (text: string) => void, triggerTarget?: string}} o
 * getCompat: 프리셋 이름 대신 호환성을 직접 계산할 때 (프리셋 편집기에서 저장 전 체크포인트 기준)
 * inherited: 이 목록 밖에서 자동으로 함께 적용되는 LoRA (프리셋 기본 LoRA·캐릭터 LoRA)
 */
export function loraEditor(o = {}) {
  const { getPreset, getCompat, inherited, onChange, onTrigger, triggerTarget = '프롬프트' } = o;
  let items = [];
  const inhNote = h('div', { class: 'field-note lora-inherited', hidden: true });
  const head = h('div', { class: 'lora-head' },
    h('span', {}, '파일'),
    h('span', { class: 'lora-head-weight' }, '강도', tipNode('lora_weight')),
    h('span', {}, '호환', tipNode('lora_compat')),
    h('span', {}, '트리거', tipNode('lora_trigger')),
    h('span', {}));
  const list = h('div', { class: 'lora-rows' });
  const addSel = h('select', { class: 'select lora-add-select', 'aria-label': '추가할 LoRA 선택' });
  const addBtn = h('button', { type: 'button', class: 'btn btn-sm' }, '+ LoRA 추가');
  const hint = h('div', { class: 'field-note', hidden: true });
  const el = h('div', { class: 'lora-editor' }, inhNote, head, list, h('div', { class: 'lora-add' }, addSel, addBtn), hint);

  const changed = () => { if (onChange) onChange(); };
  const preset = () => (getPreset ? getPreset() : '');
  const loraLabel = (name) => {
    const l = loraByName(name);
    return l && l.title ? l.title : stripExt(basename(name));
  };
  const inheritedList = () => {
    if (!inherited) return [];
    try {
      return (inherited() || []).filter((x) => x && x.name);
    } catch {
      return [];
    }
  };
  const inheritedOf = (name) => inheritedList().find((x) => x.name === name) || null;

  function rawCompat(l) {
    if (getCompat) return getCompat(l);
    const p = preset();
    return l.compat && p ? l.compat[p] : null;
  }
  function compatOf(name) {
    const l = loraByName(name);
    if (!l) {
      return store.models ? { level: 'missing', reason: '설치된 LoRA 목록에 없는 파일입니다. 파일 이름을 확인하거나 모델·LoRA 탭에서 추가하세요.' } : null;
    }
    const c = rawCompat(l);
    if (c) return c;
    const p = preset();
    return { level: 'unknown', reason: p ? '이 프리셋과의 호환성 정보가 아직 없습니다. 프리셋을 저장한 뒤 목록을 새로고침하면 표시됩니다.' : '모델 프리셋을 선택하면 호환성을 보여 줍니다.' };
  }

  function renderInherited() {
    const inh = inheritedList();
    inhNote.replaceChildren();
    if (!inh.length) {
      inhNote.hidden = true;
      return;
    }
    const groups = new Map();
    for (const x of inh) {
      const src = x.source || '프리셋';
      if (!groups.has(src)) groups.set(src, []);
      groups.get(src).push(`${loraLabel(x.name)} (${x.weight})`);
    }
    inhNote.append(`자동으로 함께 적용되는 LoRA — ${[...groups].map(([src, names]) => `${src}: ${names.join(', ')}`).join(' · ')}`);
    const dup = items.filter((it) => inh.some((x) => x.name === it.name));
    if (dup.length) {
      inhNote.append(h('div', { class: 'warn-text' },
        `⚠️ ${dup.map((it) => loraLabel(it.name)).join(', ')}은(는) 이미 함께 적용되는 LoRA라 두 번 들어가 강도가 합쳐집니다. 아래 목록에서 빼는 것을 권장합니다.`));
    }
    inhNote.hidden = false;
  }

  function renderRows() {
    list.replaceChildren();
    head.hidden = !items.length;
    renderInherited();
    if (!items.length) {
      list.append(h('div', { class: 'lora-empty' }, '추가한 LoRA가 없습니다.'));
      return;
    }
    items.forEach((it, i) => {
      const l = loraByName(it.name);
      const title = l && l.title ? l.title : stripExt(basename(it.name));
      const note = l && l.meta && l.meta.note ? String(l.meta.note).trim() : '';
      const range = h('input', { type: 'range', min: '0', max: '1.5', step: '0.05', 'aria-label': `${title} 강도` });
      range.value = String(clamp(it.weight, 0, 1.5));
      const num = h('input', { type: 'number', class: 'num-sm', min: '-2', max: '2', step: '0.05', 'aria-label': `${title} 강도 값` });
      num.value = String(it.weight);
      range.addEventListener('input', () => {
        it.weight = round2(range.value);
        num.value = String(it.weight);
        changed();
      });
      num.addEventListener('change', () => {
        let v = Number(num.value);
        if (!isFinite(v) || num.value === '') v = 0.8;
        v = round2(clamp(v, -2, 2));
        it.weight = v;
        num.value = String(v);
        range.value = String(clamp(v, 0, 1.5));
        changed();
      });
      const trig = loraTriggers(l);
      const tbtn = h('button', { type: 'button', class: 'btn btn-xs btn-ghost lora-trig' }, '넣기');
      const twrap = h('span', { class: 'btn-guard' }, tbtn);
      if (!onTrigger) {
        tbtn.disabled = true;
      } else if (!trig.length) {
        tbtn.disabled = true;
        twrap.dataset.tooltip = '등록된 트리거 단어가 없습니다. 이 LoRA는 트리거 없이 강도만으로 동작하거나, 모델·LoRA 탭에서 트리거를 메모해 둘 수 있습니다.';
      } else {
        twrap.dataset.tooltip = trig[0].registered
          ? `트리거 단어를 ${triggerTarget}에 넣습니다: ${trig[0].text}`
          : `등록된 트리거가 없어 학습 태그 후보를 보여 줍니다(트리거가 아닐 수 있음): ${trig.map((t) => t.text).join(' / ')}\n자주 쓰는 트리거는 모델·LoRA 탭에서 메모해 두세요.`;
        tbtn.addEventListener('click', () => {
          if (trig.length === 1 && trig[0].registered) {
            onTrigger(trig[0].text);
            return;
          }
          openMenu(tbtn, trig.map((t) => ({ label: t.text, hint: t.hint, onClick: () => onTrigger(t.text) })), { align: 'right' });
        });
      }
      const rm = h('button', { type: 'button', class: 'icon-btn icon-btn-sm', 'aria-label': `${title} 제거`, 'data-tooltip': '목록에서 제거' }, '×');
      rm.addEventListener('click', () => {
        items.splice(i, 1);
        renderRows();
        renderAdd();
        changed();
      });
      const nameBox = h('div', { class: 'lora-name' },
        h('span', { class: 'lora-title' }, title),
        h('span', { class: `lora-file${note ? ' has-note' : ''}` }, note || it.name));
      nameBox.dataset.tooltip = `${it.name}${note ? `\n${note}` : ''}`;
      list.append(h('div', { class: 'lora-row' },
        nameBox,
        h('div', { class: 'lora-weight' }, range, num),
        h('div', { class: 'lora-compat' }, compatBadge(compatOf(it.name))),
        twrap,
        rm));
    });
  }

  function renderAdd() {
    addSel.replaceChildren();
    const loras = store.models ? store.models.loras : null;
    hint.hidden = true;
    if (!loras) {
      addSel.append(h('option', { value: '' }, store.modelsError ? 'LoRA 목록을 불러오지 못했습니다' : 'LoRA 목록을 불러오는 중…'));
      addSel.disabled = true;
      addBtn.disabled = true;
      return;
    }
    if (!loras.length) {
      addSel.append(h('option', { value: '' }, '설치된 LoRA가 없습니다'));
      addSel.disabled = true;
      addBtn.disabled = true;
      hint.textContent = '모델·LoRA 탭에서 URL로 내려받거나 models/loras 폴더에 .safetensors 파일을 넣은 뒤 새로고침하세요.';
      hint.hidden = false;
      return;
    }
    addSel.disabled = false;
    addBtn.disabled = false;
    addSel.append(h('option', { value: '' }, 'LoRA 선택…'));
    const groups = { ok: [], warn: [], unknown: [], bad: [] };
    for (const l of loras) {
      const c = rawCompat(l);
      (groups[c ? c.level : 'unknown'] || groups.unknown).push(l);
    }
    const inh = inheritedList();
    const labels = { ok: '✅ 호환', warn: '⚠️ 주의 필요', unknown: '호환성 확인 불가', bad: '❌ 비호환' };
    for (const k of ['ok', 'warn', 'unknown', 'bad']) {
      if (!groups[k].length) continue;
      const og = h('optgroup', { label: labels[k] });
      for (const l of groups[k]) {
        const added = items.some((x) => x.name === l.name);
        const from = inh.find((x) => x.name === l.name);
        const arch = l.arch && l.arch !== 'unknown' ? ` · ${l.arch}` : '';
        const tag = added ? ' (추가됨)' : from ? ` (${from.source || '프리셋'}에 포함됨)` : '';
        const note = l.meta && l.meta.note ? String(l.meta.note).trim() : '';
        og.append(h('option', { value: l.name, disabled: added || !!from, title: note || null }, `${l.title || stripExt(basename(l.name))}${arch}${tag}`));
      }
      addSel.append(og);
    }
  }

  function add(name) {
    if (!name || items.some((x) => x.name === name)) return;
    const from = inheritedOf(name);
    if (from) {
      toast(`'${loraLabel(name)}'은(는) ${from.source || '프리셋'}에 이미 들어 있어 자동으로 적용됩니다(강도 ${from.weight}). 여기에 또 넣으면 두 번 적용되어 강도가 합쳐집니다.`, 'warn', { timeout: 9000 });
      return;
    }
    const l = loraByName(name);
    const mw = l && l.meta ? Number(l.meta.weight) : NaN;
    items.push({ name, weight: isFinite(mw) && mw !== 0 ? round2(mw) : 0.8 });
    renderRows();
    renderAdd();
    changed();
    const c = compatOf(name);
    if (c && c.level === 'bad') toast(`이 LoRA는 현재 프리셋과 맞지 않습니다: ${c.reason}`, 'warn');
  }
  addBtn.addEventListener('click', () => add(addSel.value));
  addSel.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      add(addSel.value);
    }
  });

  renderRows();
  renderAdd();
  return {
    el,
    get: () => items.map((x) => ({ name: x.name, weight: round2(x.weight) })),
    set(v) {
      items = (Array.isArray(v) ? v : []).filter((x) => x && x.name).map((x) => ({ name: x.name, weight: round2(isFinite(Number(x.weight)) ? x.weight : 0.8) }));
      renderRows();
      renderAdd();
    },
    refresh() {
      renderRows();
      renderAdd();
    },
  };
}

// ======================= 크기 선택 =======================
function shapeStyle(w, hh) {
  const m = Math.max(w, hh);
  return { width: `${Math.round((18 * w) / m)}px`, height: `${Math.round((18 * hh) / m)}px` };
}
export function sizePicker({ value = 'portrait', onChange, idPrefix = 'size' } = {}) {
  let cur = 'portrait';
  let custom = [1024, 1024];
  const group = h('div', { class: 'size-picker', role: 'radiogroup', 'aria-label': '이미지 크기' });
  const btns = {};
  const mk = (key, label, dim, style) => {
    const b = h('button', { type: 'button', class: 'size-opt', role: 'radio', 'aria-checked': 'false' },
      h('span', { class: 'size-shape-box' }, h('span', { class: 'size-shape', style })),
      h('span', { class: 'size-name' }, label),
      h('span', { class: 'size-dim' }, dim));
    b.addEventListener('click', () => select(key, true));
    btns[key] = b;
    group.append(b);
    return b;
  };
  for (const k of Object.keys(SIZES)) {
    const [w, hh] = SIZES[k];
    mk(k, SIZE_LABELS[k], `${w}×${hh}`, shapeStyle(w, hh));
  }
  const customBtn = mk('custom', '사용자 지정', '직접 입력', { width: '14px', height: '14px', borderStyle: 'dashed' });
  const wIn = h('input', { type: 'number', id: `${idPrefix}-w`, class: 'num-md', min: '512', max: '2048', step: '8', inputmode: 'numeric' });
  const hIn = h('input', { type: 'number', id: `${idPrefix}-h`, class: 'num-md', min: '512', max: '2048', step: '8', inputmode: 'numeric' });
  const customRow = h('div', { class: 'size-custom', hidden: true },
    h('label', { for: `${idPrefix}-w` }, '가로'), wIn,
    h('span', { class: 'size-x' }, '×'),
    h('label', { for: `${idPrefix}-h` }, '세로'), hIn,
    h('span', { class: 'field-note' }, '512~2048px, 8의 배수로 맞춥니다. 학습 해상도(약 1MP)에서 멀어질수록 구도가 깨지기 쉽습니다.'));
  const el = h('div', { class: 'size-wrap' }, group, customRow);

  const norm = (v) => clamp(Math.round((Number(v) || 1024) / 8) * 8, 512, 2048);
  function syncCustomDim() {
    customBtn.querySelector('.size-dim').textContent = cur === 'custom' ? `${custom[0]}×${custom[1]}` : '직접 입력';
    const st = shapeStyle(custom[0], custom[1]);
    Object.assign(customBtn.querySelector('.size-shape').style, st);
  }
  function select(key, fire) {
    cur = key;
    for (const [k, b] of Object.entries(btns)) {
      b.classList.toggle('active', k === key);
      b.setAttribute('aria-checked', k === key ? 'true' : 'false');
    }
    customRow.hidden = key !== 'custom';
    wIn.value = String(custom[0]);
    hIn.value = String(custom[1]);
    syncCustomDim();
    if (fire && onChange) onChange();
  }
  const onCustom = () => {
    custom = [norm(wIn.value), norm(hIn.value)];
    wIn.value = String(custom[0]);
    hIn.value = String(custom[1]);
    syncCustomDim();
    if (onChange) onChange();
  };
  wIn.addEventListener('change', onCustom);
  hIn.addEventListener('change', onCustom);

  const api_ = {
    el,
    get: () => (cur === 'custom' ? [custom[0], custom[1]] : cur),
    set(v) {
      if (Array.isArray(v) && v.length >= 2) {
        custom = [norm(v[0]), norm(v[1])];
        select('custom', false);
      } else if (v && typeof v === 'object' && v.width) {
        custom = [norm(v.width), norm(v.height)];
        select('custom', false);
      } else if (typeof v === 'string' && SIZES[v]) {
        select(v, false);
      } else {
        select('portrait', false);
      }
    },
  };
  api_.set(value);
  return api_;
}

// ======================= 시드 =======================
export function seedInput({ id, value = null, onChange, randomHint = '매번 새 시드' } = {}) {
  let mode = 'random';
  const rBtn = h('button', { type: 'button', class: 'seg-btn' }, '랜덤');
  const fBtn = h('button', { type: 'button', class: 'seg-btn' }, '고정');
  const input = h('input', { type: 'number', id, class: 'seed-num', min: '0', max: '4294967295', step: '1', inputmode: 'numeric', placeholder: randomHint });
  const dice = h('button', { type: 'button', class: 'btn btn-icon seed-dice', 'aria-label': '새 랜덤 시드 뽑아서 고정', 'data-tooltip': '새 랜덤 시드를 뽑아 고정합니다' }, '🎲');
  const el = h('div', { class: 'seed-input' }, h('div', { class: 'seg seg-sm', role: 'group', 'aria-label': '시드 방식' }, rBtn, fBtn), input, dice);

  function setMode(m, fire) {
    mode = m;
    rBtn.classList.toggle('active', m === 'random');
    fBtn.classList.toggle('active', m === 'fixed');
    rBtn.setAttribute('aria-pressed', m === 'random' ? 'true' : 'false');
    fBtn.setAttribute('aria-pressed', m === 'fixed' ? 'true' : 'false');
    input.disabled = m === 'random';
    input.placeholder = m === 'random' ? randomHint : '시드 번호 (0~4294967295)';
    if (m === 'fixed' && input.value === '') input.value = String(randomSeed());
    validate();
    if (fire && onChange) onChange();
  }
  function validate() {
    const bad = mode === 'fixed' && parse() == null;
    input.classList.toggle('invalid', bad);
    input.setAttribute('aria-invalid', bad ? 'true' : 'false');
  }
  function parse() {
    const s = String(input.value).trim();
    if (!/^\d{1,10}$/.test(s)) return null;
    const n = Number(s);
    return n <= 4294967295 ? n : null;
  }
  rBtn.addEventListener('click', () => setMode('random', true));
  fBtn.addEventListener('click', () => {
    setMode('fixed', true);
    input.focus();
  });
  dice.addEventListener('click', () => {
    input.value = String(randomSeed());
    setMode('fixed', true);
  });
  input.addEventListener('input', () => {
    validate();
    if (onChange) onChange();
  });

  const ctl = {
    el, input,
    get: () => (mode === 'random' ? null : parse()),
    isValid: () => mode === 'random' || parse() != null,
    set(v) {
      if (v == null || v === '') {
        input.value = '';
        setMode('random', false);
      } else {
        input.value = String(v);
        setMode('fixed', false);
      }
    },
  };
  ctl.set(value);
  return ctl;
}

// ======================= 장수 =======================
export function countStepper({ id, value = 1, min = 1, max = 16, unit = '장', onChange } = {}) {
  const input = h('input', { type: 'number', id, class: 'stepper-input', min: String(min), max: String(max), step: '1', inputmode: 'numeric' });
  const minus = h('button', { type: 'button', class: 'stepper-btn', 'aria-label': '하나 줄이기' }, '−');
  const plus = h('button', { type: 'button', class: 'stepper-btn', 'aria-label': '하나 늘리기' }, '+');
  const el = h('div', { class: 'stepper' }, minus, input, h('span', { class: 'stepper-unit' }, unit), plus);
  const get = () => clamp(parseInt(input.value, 10) || min, min, max);
  const set = (v, fire) => {
    input.value = String(clamp(parseInt(v, 10) || min, min, max));
    minus.disabled = get() <= min;
    plus.disabled = get() >= max;
    if (fire && onChange) onChange();
  };
  minus.addEventListener('click', () => set(get() - 1, true));
  plus.addEventListener('click', () => set(get() + 1, true));
  input.addEventListener('change', () => set(input.value, true));
  input.addEventListener('input', () => { if (onChange) onChange(); });
  set(value, false);
  return { el, input, get, set: (v) => set(v, false) };
}

// ======================= 품질 토글 =======================
const QUALITY_DEFS = [
  ['hires', '하이레즈', '1.5배 확대 후 다시 그려 선·눈·옷 주름을 정리합니다 (가장 큰 품질 향상, 가장 오래 걸림)'],
  ['face', '얼굴 보정', '작게 그려진 얼굴을 확대해 다시 그립니다. 얼굴이 이미 크면 자동으로 건너뜁니다'],
  ['hands', '손 보정', '손을 찾아 확대해 다시 그립니다'],
];
/**
 * @param {{value?: object, onChange?: Function, disabled?: Record<string,string>, idPrefix?: string}} o
 */
export function qualityToggles(o = {}) {
  const { onChange, disabled = {}, idPrefix = 'q' } = o;
  const inputs = {};
  const switches = h('div', { class: 'quality-switches' });
  for (const [key, label, desc] of QUALITY_DEFS) {
    const input = h('input', { type: 'checkbox', role: 'switch', id: `${idPrefix}-${key}` });
    inputs[key] = input;
    const lab = h('label', { class: 'switch', for: `${idPrefix}-${key}` },
      input,
      h('span', { class: 'switch-track', 'aria-hidden': 'true' }, h('span', { class: 'switch-thumb' })),
      h('span', { class: 'switch-label' }, label));
    const item = h('div', { class: 'switch-item' }, lab, tipNode(key));
    if (disabled[key]) {
      input.disabled = true;
      item.classList.add('is-disabled');
      item.dataset.tooltip = disabled[key];
    } else {
      lab.title = desc;
    }
    input.addEventListener('change', () => { sync(); if (onChange) onChange(); });
    switches.append(item);
  }
  const fastBtn = h('button', { type: 'button', class: 'btn btn-sm btn-ghost' }, '⚡ 빠른 미리보기');
  const fullBtn = h('button', { type: 'button', class: 'btn btn-sm btn-ghost' }, '✦ 최고 품질');
  const modeNote = h('span', { class: 'quality-mode' });
  const el = h('div', { class: 'quality' }, switches,
    h('div', { class: 'quality-actions' }, fastBtn, tipNode('fast'), fullBtn, modeNote));
  const setAll = (v) => {
    for (const k of Object.keys(inputs)) if (!inputs[k].disabled) inputs[k].checked = v;
    sync();
    if (onChange) onChange();
  };
  fastBtn.addEventListener('click', () => setAll(false));
  fullBtn.addEventListener('click', () => setAll(true));
  fastBtn.title = '하이레즈·얼굴·손 보정을 모두 끕니다. 구도와 분위기만 빠르게 확인할 때 (약 1.5~2분)';
  fullBtn.title = '하이레즈·얼굴·손 보정을 모두 켭니다 (기본값)';

  function sync() {
    const en = Object.keys(inputs).filter((k) => !inputs[k].disabled);
    const on = en.filter((k) => inputs[k].checked).length;
    modeNote.textContent = on === 0 ? '빠른 미리보기 모드' : on === en.length ? '최고 품질' : '사용자 지정';
    modeNote.className = `quality-mode ${on === 0 ? 'is-fast' : on === en.length ? 'is-full' : ''}`;
  }
  const ctl = {
    el,
    get: () => ({
      hires: !!inputs.hires.checked && !inputs.hires.disabled,
      face: !!inputs.face.checked && !inputs.face.disabled,
      hands: !!inputs.hands.checked && !inputs.hands.disabled,
    }),
    set(v) {
      const val = v || {};
      for (const k of Object.keys(inputs)) inputs[k].checked = inputs[k].disabled ? false : val[k] !== false;
      sync();
    },
  };
  ctl.set(o.value || {});
  return ctl;
}

// ======================= 프롬프트 도우미 =======================
export function tagHelper({ textarea, categories = null } = {}) {
  const cats = categories ? TAG_CATEGORIES.filter((c) => categories.includes(c.id)) : TAG_CATEGORIES;
  let active = cats[0].id;
  let query = '';
  const tabs = h('div', { class: 'tag-tabs', role: 'tablist', 'aria-label': '태그 분류' });
  const search = h('input', { type: 'search', class: 'tag-search', placeholder: '태그 검색 (한글·영문)', 'aria-label': '태그 검색' });
  const chips = h('div', { class: 'tag-chips' });
  const el = h('div', { class: 'tag-helper' },
    h('div', { class: 'tag-helper-top' }, tabs, search),
    chips,
    h('div', { class: 'tag-helper-foot' }, '누르면 커서 위치에 추가되고, 다시 누르면 빠집니다. 작은 영문 글씨가 실제로 들어가는 Danbooru 태그입니다.'));
  for (const c of cats) {
    const b = h('button', { type: 'button', role: 'tab', class: 'tag-tab' }, c.label);
    b.dataset.cat = c.id;
    b.addEventListener('click', () => {
      active = c.id;
      query = '';
      search.value = '';
      render();
    });
    tabs.append(b);
  }
  function sync() {
    chips.querySelectorAll('.tag-chip').forEach((b) => {
      const on = hasTag(textarea.value, b.dataset.tag);
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  function render() {
    tabs.querySelectorAll('.tag-tab').forEach((b) => {
      const on = !query && b.dataset.cat === active;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    chips.replaceChildren();
    let list;
    if (query) {
      const q = query.toLowerCase();
      list = [];
      for (const c of cats) for (const [t, ko] of c.tags) if (t.includes(q) || ko.includes(query)) list.push([t, ko, c.label]);
    } else {
      list = (cats.find((c) => c.id === active) || cats[0]).tags.map(([t, ko]) => [t, ko, '']);
    }
    if (!list.length) chips.append(h('div', { class: 'tag-empty' }, '일치하는 태그가 없습니다.'));
    for (const [t, ko, cat] of list) {
      const b = h('button', { type: 'button', class: 'chip tag-chip', 'aria-pressed': 'false' },
        h('span', { class: 'chip-ko' }, ko), h('span', { class: 'chip-en' }, t));
      b.dataset.tag = t;
      if (cat) b.title = cat;
      b.addEventListener('click', () => {
        toggleTag(textarea, t);
        sync();
      });
      chips.append(b);
    }
    sync();
  }
  search.addEventListener('input', debounce(() => {
    query = search.value.trim();
    render();
  }, 120));
  // 폼 안에 있으므로 Enter가 생성 버튼을 누르지 않게 막고, 바로 검색만 한다
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    query = search.value.trim();
    render();
  });
  textarea.addEventListener('input', debounce(sync, 150));
  trackCaret(textarea);
  render();
  return { el, sync };
}

// ======================= 썸네일 / 그리드 =======================
export function itemFromOutput(o) {
  if (!o) return null;
  const path = o.path || '';
  return { path, url: o.url || fileUrl(path), thumb: o.thumb || thumbUrl(path), name: basename(path) };
}

export function thumbTile(item, { onOpen, overlay = null, showKind = false, showName = true } = {}) {
  const name = item.name || basename(item.path);
  const img = h('img', { alt: name, loading: 'lazy', decoding: 'async', draggable: 'false' });
  // 도트 결과·도트화한 시트는 썸네일이 칸보다 작을 수 있다 → 최근접 확대로 픽셀 유지
  if (isPixelPath(item.path) || /(^|\/)sheets\/.*_\d{2,3}x\d{2,3}_\d+x\d+_seed/.test(item.path || '')) img.classList.add('pixelated');
  const btn = h('button', { type: 'button', class: 'tile-btn', 'aria-label': `${name} 크게 보기` }, img);
  btn.addEventListener('click', () => { if (onOpen) onOpen(item); });
  const tile = h('div', { class: 'tile', role: 'listitem' }, btn);
  img.addEventListener('load', () => {
    tile.classList.add('loaded');
    detectAlpha(img, item.path, (a) => tile.classList.toggle('checker', a));
  }, { once: true });
  img.addEventListener('error', () => tile.classList.add('broken'), { once: true });
  img.src = item.thumb || thumbUrl(item.path);
  const meta = h('div', { class: 'tile-meta' });
  if (showKind && item.kind) meta.append(h('span', { class: `tile-kind kind-${item.kind}` }, KIND_LABELS[item.kind] || item.kind));
  if (showName) meta.append(h('span', { class: 'tile-name', title: item.path }, name));
  tile.append(meta);
  if (item.secret || /^_secret\//.test(item.path || '')) {  // 시크릿 모드 출력: 끄거나 종료하면 지워짐
    tile.classList.add('is-secret');
    tile.append(h('span', { class: 'tile-secret', title: '시크릿 — 시크릿 모드를 끄거나 Studio를 종료하면 삭제됩니다' }, '시크릿'));
  }
  if (overlay) tile.append(h('div', { class: 'tile-actions' }, overlay));
  return tile;
}

/**
 * /api/gallery 결과 그리드
 * @param {{params?: object, pageSize?: number, emptyTitle?: string, emptyText?: string, emptyActions?: () => Node[], overlayFor?: (item: object) => Node|null, gridClass?: string, showKind?: boolean, infinite?: boolean, onLoaded?: Function, lightboxOpts?: object}} o
 */
export function galleryGrid(o = {}) {
  const { pageSize = 30, emptyTitle = '아직 이미지가 없습니다', emptyText = '', emptyActions, overlayFor, gridClass = '', showKind = false, infinite = false, onLoaded, lightboxOpts = {} } = o;
  const grid = h('div', { class: `thumb-grid ${gridClass}`, role: 'list' });
  const status = h('div', { class: 'grid-status' });
  const more = h('button', { type: 'button', class: 'btn btn-ghost btn-block more-btn', hidden: true }, '더 보기');
  const sentinel = h('div', { class: 'grid-sentinel', 'aria-hidden': 'true' });
  const el = h('div', { class: 'grid-wrap' }, grid, status, more, sentinel);
  let items = [];
  let tiles = new Map();
  let total = 0;
  let offset = 0;
  let loading = false;
  let done = false;
  let errored = false;
  let gen = 0;
  let ctrl = null;
  let autoFill = 0;
  let cur = { ...(o.params || {}) };
  let lastFolders = [];

  function openAt(item) {
    const idx = items.indexOf(item);
    openLightbox(items, idx < 0 ? 0 : idx, {
      ...lightboxOpts,
      onDelete: (it) => removeItem(it),
      loadMore: done ? null : async () => {
        if (done) return [];
        const before = items.length;
        await load(false);
        return items.slice(before);
      },
    });
  }
  function makeTile(it) {
    const tile = thumbTile(it, { onOpen: openAt, overlay: overlayFor ? overlayFor(it) : null, showKind });
    tiles.set(it, tile);
    return tile;
  }
  function removeItem(it) {
    const i = items.indexOf(it);
    if (i >= 0) items.splice(i, 1);
    const t = tiles.get(it);
    if (t) t.remove();
    tiles.delete(it);
    total = Math.max(0, total - 1);
    if (!items.length) showEmpty();
    if (onLoaded) onLoaded({ items, total, folders: lastFolders });
  }
  function showEmpty() {
    status.replaceChildren(emptyState({ icon: '▢', title: emptyTitle, text: emptyText, actions: emptyActions ? emptyActions() : [] }));
  }

  async function load(reset) {
    if (reset) {
      if (ctrl) ctrl.abort();
      gen++;
      items = [];
      tiles = new Map();
      total = 0;
      offset = 0;
      done = false;
      autoFill = 0;
      loading = false;
      grid.replaceChildren();
    }
    if (loading || done) return;
    const myGen = gen;
    loading = true;
    errored = false;
    ctrl = new AbortController();
    status.replaceChildren(spinner(items.length ? '더 불러오는 중…' : '이미지를 불러오는 중…'));
    more.hidden = true;
    try {
      const r = await api('/api/gallery' + qs({ ...cur, limit: pageSize, offset }), { silent: true, signal: ctrl.signal });
      if (myGen !== gen) return;
      const raw = Array.isArray(r.items) ? r.items : [];
      offset += raw.length;
      lastFolders = r.folders || lastFolders;
      let batch = raw;
      if (cur.kind) batch = batch.filter((it) => !it.kind || it.kind === cur.kind);
      if (cur.char) batch = batch.filter((it) => !it.character || it.character === cur.char);
      total = typeof r.total === 'number' ? r.total : items.length + batch.length;
      items.push(...batch);
      const frag = document.createDocumentFragment();
      for (const it of batch) frag.append(makeTile(it));
      grid.append(frag);
      done = raw.length < pageSize || (typeof r.total === 'number' && offset >= r.total);
      status.replaceChildren();
      if (!items.length && done) showEmpty();
      more.hidden = done;
      if (onLoaded) onLoaded({ items, total, folders: lastFolders });
      if (!done && batch.length < Math.min(8, pageSize) && autoFill < 6) {
        autoFill++;
        loading = false;
        await load(false);
      }
    } catch (e) {
      if ((e && e.aborted) || myGen !== gen) return;
      errored = true;
      status.replaceChildren(h('div', { class: 'grid-error' },
        h('span', {}, (e && e.message) || '이미지 목록을 불러오지 못했습니다.'),
        h('button', { type: 'button', class: 'btn btn-sm', onclick: () => load(!items.length) }, '다시 시도')));
    } finally {
      if (myGen === gen) loading = false;
    }
  }
  more.addEventListener('click', () => load(false));

  if (infinite && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((en) => en.isIntersecting) && !loading && !done && !errored && items.length && el.offsetParent !== null) load(false);
    }, { rootMargin: '700px 0px' });
    io.observe(sentinel);
  }

  return {
    el,
    reload: () => load(true),
    setParams(p) {
      cur = { ...(p || {}) };
      return load(true);
    },
    get params() { return { ...cur }; },
    get items() { return items; },
    get total() { return total; },
  };
}

// ======================= 작업 표시 헬퍼 =======================
export function statusBadge(status) {
  const b = h('span', { class: `status-badge st-${status || 'queued'}` }, STATUS_LABELS[status] || status || '');
  return b;
}
export function jobTitle(job) {
  return (job && job.summary) || (job && job.spec && MODE_LABELS[job.spec.mode]) || '작업';
}
export function jobPercent(job) {
  if (!job) return 0;
  if (job.status === 'done') return 100;
  const p = Number(job.progress && job.progress.percent);
  return isFinite(p) ? clamp(p, 0, 100) : 0;
}
export function stageText(job) {
  const p = (job && job.progress) || {};
  let s = p.stage || '준비 중 (모델 불러오는 중일 수 있음)';
  if (p.steps) s += ` · ${p.step || 0}/${p.steps} 스텝`;
  return s;
}
export function queueAhead(job) {
  // 백엔드의 queue_position은 1부터 시작(실행 중 작업 포함) → 앞에 있는 작업 수 = position - 1
  if (job && job.status === 'queued' && typeof job.queue_position === 'number' && job.queue_position >= 1) return job.queue_position - 1;
  return activeJobs().filter((j) => j.id !== job.id && (j.status === 'running' || (j.created || 0) < (job.created || 0))).length;
}
export function jobExprCount(job) {
  const spec = (job && job.spec) || {};
  if (spec.mode !== 'sprite') return undefined;
  if (Array.isArray(spec.expressions) && spec.expressions.length) return spec.expressions.length;
  const c = characterById(spec.character);
  return c && c.expressions ? Object.keys(c.expressions).length : undefined;
}
export function fmtSeeds(seeds) {
  if (!Array.isArray(seeds) || !seeds.length) return '';
  return seeds.length > 2 ? `${seeds[0]} 외 ${seeds.length - 1}개` : seeds.join(', ');
}
export function jobMetaChips(job) {
  const spec = (job && job.spec) || {};
  const chips = [];
  const chip = (t, tip = '') => {
    const c = h('span', { class: 'meta-chip' }, t);
    if (tip) c.dataset.tooltip = tip;
    return c;
  };
  if (spec.mode) chips.push(chip(MODE_LABELS[spec.mode] || spec.mode));
  const preset = job.preset || spec.preset;
  if (preset) chips.push(chip(presetLabel(preset), `프리셋: ${preset}`));
  if (spec.mode === 'sheet') {
    const sh = spec.sheet || {};
    const rows = (sh.motions || ['walk']).length * (sh.directions || [1, 2, 3, 4]).length;
    chips.push(chip(`${sh.frames || 4}프레임 × ${rows}줄${sh.pixel ? ` · 도트 ${sh.pixel.width}` : ''}`, '스프라이트 시트 열(프레임) × 줄(동작 × 방향)'));
  } else if (spec.mode === 'pixel' && spec.pixel) {
    chips.push(chip(`도트 ${spec.pixel.width}px · ${spec.pixel.colors || 32}색`));
  } else {
    chips.push(chip(sizeLabel(jobSize(job), spec.mode)));
  }
  if (spec.mode !== 'sprite' && Number(spec.count) > 1) chips.push(chip(`${spec.count}장`));
  if (job.seeds && job.seeds.length) chips.push(chip(`시드 ${fmtSeeds(job.seeds)}`, job.seeds.join(', ')));
  const off = [];
  if (spec.hires === false) off.push('하이레즈');
  if (!noPeople(spec.mode) && spec.face === false) off.push('얼굴');
  if (!noPeople(spec.mode) && spec.hands === false) off.push('손');
  const all = noPeople(spec.mode) ? 1 : 3;
  if (off.length === all) chips.push(chip('⚡ 빠른 모드', '하이레즈·보정 단계를 끈 빠른 미리보기로 생성했습니다'));
  else if (off.length) chips.push(chip(`${off.join('·')} 끔`));
  if (spec.mode === 'sprite' && spec.upscale) chips.push(chip('업스케일'));
  if (Array.isArray(spec.loras) && spec.loras.length) chips.push(chip(`LoRA ${spec.loras.length}`, spec.loras.map((l) => `${l.name} (${l.weight})`).join('\n')));
  if (!noPeople(spec.mode)) {
    const pc = poseMetaChip(job);
    if (pc) chips.push(pc);
  }
  return chips;
}
/** 실제 생성 크기: 요청 크기, 비어 있고 포즈를 썼으면 포즈 크기(job.pose.size) */
export function jobSize(job) {
  const spec = (job && job.spec) || {};
  if (spec.size) return spec.size;
  const p = jobPose(job);
  return p && Array.isArray(p.size) && !noPeople(spec.mode) ? p.size : spec.size;
}

export function openJobOutputs(job, index = 0) {
  const items = (job.outputs || []).map(itemFromOutput).filter(Boolean);
  if (items.length) openLightbox(items, index);
}

export function showJobError(job) {
  const pre = h('pre', { class: 'code-block error-block' }, job.error || '오류 메시지가 없습니다.');
  const body = h('div', {},
    h('p', { class: 'modal-text' }, jobTitle(job)),
    pre,
    h('p', { class: 'modal-detail', html: `자주 생기는 원인과 해결책은 ${helpLink('troubleshooting', '도움말 › 문제 해결')}에 정리되어 있습니다.` }));
  const m = openModal({
    title: '실패 원인', body, size: 'lg',
    actions: [
      { label: '복사', kind: 'ghost', onClick: async () => { if (await copyText(job.error || '')) toast('오류 메시지를 복사했습니다.', 'success'); return false; } },
      { label: '닫기', kind: 'primary', autofocus: true },
    ],
  });
  body.querySelector('.help-link')?.addEventListener('click', () => m.close());
}

// ======================= 작업 모니터 (실시간 미리보기) =======================
/**
 * @param {{filter?: (job: object) => boolean, variant?: 'large'|'compact', title?: string, emptyTitle?: string, emptyText?: string}} o
 */
export function jobMonitor(o = {}) {
  const { filter = () => true, variant = 'large', title = '진행 상황', emptyTitle = '진행 중인 작업이 없습니다', emptyText = '' } = o;
  const el = h('section', { class: `panel monitor monitor-${variant} is-empty` });
  el.innerHTML = `
    <div class="panel-head">
      <h3 class="panel-title">${esc(title)}</h3>
      <div class="monitor-queue" data-ref="queueInfo"></div>
    </div>
    <div class="monitor-body">
      <div class="monitor-stage" data-ref="stage">
        <img class="monitor-img" data-ref="img" alt="" hidden>
        <div class="monitor-placeholder" data-ref="placeholder"></div>
        <span class="monitor-tag" data-ref="tag" hidden>실시간 미리보기</span>
      </div>
      <div class="monitor-info" data-ref="info" hidden>
        <div class="monitor-line"><span data-ref="badge"></span><span class="monitor-summary" data-ref="summary"></span></div>
        <div class="meta-chips" data-ref="meta"></div>
        <div class="monitor-stage-name" data-ref="stageName"></div>
        <div class="progress" data-ref="progress"><div class="progress-bar" data-ref="bar"></div></div>
        <div class="monitor-stats"><span data-ref="elapsed"></span><span data-ref="eta"></span><span class="monitor-pct" data-ref="pct"></span></div>
        <div class="monitor-error" data-ref="error" hidden></div>
        <div class="monitor-outputs" data-ref="outputs"></div>
        <div class="monitor-actions" data-ref="actions"></div>
      </div>
    </div>
    <div class="monitor-queue-list" data-ref="qwrap" hidden>
      <div class="monitor-queue-title">대기열</div>
      <ul class="monitor-list" data-ref="list"></ul>
    </div>`;
  const $ = refs(el);
  let shownId = null;
  let pinnedId = null;
  let imgToken = 0;
  let imgKind = null;
  let lastPreviewT = 0;
  let lastOutputsKey = '';
  let lastActionsKey = '';
  let current = null;

  $.img.addEventListener('click', () => {
    if (current && current.outputs && current.outputs.length) openJobOutputs(current, 0);
  });

  function pick(jobs) {
    if (pinnedId) {
      const p = jobs.find((j) => j.id === pinnedId);
      if (p) return p;
      pinnedId = null;
    }
    const running = jobs.filter((j) => j.status === 'running').sort((a, b) => (b.started || 0) - (a.started || 0));
    if (running.length) return running[0];
    const queued = jobs.filter((j) => j.status === 'queued').sort((a, b) => (a.created || 0) - (b.created || 0));
    if (queued.length) return queued[0];
    return jobs.slice().sort((a, b) => (b.finished || b.created || 0) - (a.finished || a.created || 0))[0] || null;
  }

  let lastPh = '';
  function setPlaceholder(kind, job) {
    const ph = $.placeholder;
    const key = `${kind}|${job ? job.id : ''}|${kind === 'queued' && job ? queueAhead(job) : ''}`;
    ph.hidden = false;
    if (key === lastPh && ph.childElementCount) return;
    lastPh = key;
    ph.replaceChildren();
    if (kind === 'empty') {
      ph.append(h('div', { class: 'ph-icon', 'aria-hidden': 'true' }, '✦'), h('div', { class: 'ph-title' }, emptyTitle), emptyText ? h('div', { class: 'ph-text' }, emptyText) : '');
    } else if (kind === 'queued') {
      const n = queueAhead(job);
      ph.append(h('div', { class: 'ph-icon', 'aria-hidden': 'true' }, '⋯'), h('div', { class: 'ph-title' }, n ? `대기 중 · 앞에 ${n}개 작업` : '곧 시작합니다'), h('div', { class: 'ph-text' }, etaText(job.spec || {}, jobEtaOpts(job, { exprCount: jobExprCount(job) }))));
    } else if (kind === 'running') {
      ph.append(h('span', { class: 'spinner spinner-lg', 'aria-hidden': 'true' }), h('div', { class: 'ph-title' }, '첫 미리보기를 기다리는 중…'), h('div', { class: 'ph-text' }, '처음 실행하거나 모델을 바꾸면 모델을 불러오는 데 시간이 더 걸립니다.'));
    } else if (kind === 'error') {
      ph.append(h('div', { class: 'ph-icon ph-error', 'aria-hidden': 'true' }, '!'), h('div', { class: 'ph-title' }, '생성에 실패했습니다'));
    } else if (kind === 'cancelled') {
      ph.append(h('div', { class: 'ph-icon', 'aria-hidden': 'true' }, '×'), h('div', { class: 'ph-title' }, '취소된 작업입니다'));
    } else if (kind === 'missing') {
      ph.append(h('div', { class: 'ph-icon', 'aria-hidden': 'true' }, '?'), h('div', { class: 'ph-title' }, '결과 파일을 찾을 수 없습니다'), h('div', { class: 'ph-text' }, '휴지통으로 옮겼거나 Finder에서 이동한 것 같습니다.'));
    } else if (kind === 'done-empty') {
      ph.append(h('div', { class: 'ph-icon', 'aria-hidden': 'true' }, '✓'), h('div', { class: 'ph-title' }, '완료되었지만 결과 파일 목록이 비어 있습니다'));
    }
  }
  function resetImg() {
    imgToken++;
    imgKind = null;
    $.img.hidden = true;
    $.img.removeAttribute('src');
    $.tag.hidden = true;
    $.stage.classList.remove('checker', 'has-img', 'clickable');
  }
  function showImg(url, kind, path) {
    const tok = ++imgToken;
    const im = new Image();
    im.onload = () => {
      if (tok !== imgToken) return;
      $.img.src = url;
      $.img.hidden = false;
      imgKind = kind;
      $.placeholder.hidden = true;
      $.tag.hidden = kind !== 'preview';
      $.stage.classList.add('has-img');
      $.stage.classList.toggle('clickable', kind === 'output');
      if (kind === 'output' && path) detectAlpha(im, path, (a) => $.stage.classList.toggle('checker', a));
      else $.stage.classList.remove('checker');
    };
    im.onerror = () => {
      // 미리보기는 아직 없을 수 있음 — 다음 이벤트를 기다림. 결과 파일이 없으면 안내
      if (tok !== imgToken || kind !== 'output') return;
      imgKind = 'missing';
      $.img.hidden = true;
      $.stage.classList.remove('has-img', 'clickable', 'checker');
      setPlaceholder('missing', current);
    };
    im.src = url;
  }

  // 대기열 항목은 한 번 만들고 글자만 바꾼다 (진행 이벤트마다 새로 만들면 × 클릭이 씹힘)
  const qrows = new Map(); // job id -> {li, dot, title, sub, cancel}
  const setText = (node, t) => { if (node.textContent !== t) node.textContent = t; };
  function queueRow(id) {
    const dot = h('span', { class: 'dot', 'aria-hidden': 'true' });
    const title = h('span', { class: 'monitor-item-title' });
    const sub = h('span', { class: 'monitor-item-sub' });
    const cancel = h('button', { type: 'button', class: 'icon-btn icon-btn-sm', 'data-tooltip': '이 작업 취소' }, '×');
    cancel.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.detail > 1) return; // 더블클릭의 두 번째 클릭은 무시
      withBusy(cancel, () => cancelJob(id));
    });
    const li = h('li', { class: 'monitor-item', tabindex: '0', role: 'button' }, dot, title, sub, cancel);
    const pin = () => { pinnedId = id; update(); };
    li.addEventListener('click', pin);
    li.addEventListener('keydown', (e) => {
      if (e.target !== li) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pin(); }
    });
    return { li, dot, title, sub, cancel };
  }
  function renderQueue(active, shown) {
    const others = active.filter((j) => !shown || j.id !== shown.id);
    const running = active.filter((j) => j.status === 'running').length;
    const queued = active.filter((j) => j.status === 'queued').length;
    setText($.queueInfo, active.length ? `진행 ${running} · 대기 ${queued}` : '');
    $.qwrap.hidden = !others.length;
    const keep = new Set();
    let prev = null;
    for (const j of others) {
      keep.add(j.id);
      let row = qrows.get(j.id);
      if (!row) {
        row = queueRow(j.id);
        qrows.set(j.id, row);
      }
      const t = jobTitle(j);
      const dotCls = `dot st-${j.status}`;
      if (row.dot.className !== dotCls) row.dot.className = dotCls;
      setText(row.title, t);
      setText(row.sub, j.status === 'running' ? `${Math.floor(jobPercent(j))}%` : `${queueAhead(j) + 1}번째`);
      if (row.li.getAttribute('aria-label') !== `${t} 보기`) {
        row.li.setAttribute('aria-label', `${t} 보기`);
        row.cancel.setAttribute('aria-label', `${t} 취소`);
      }
      const want = prev ? prev.nextSibling : $.list.firstChild;
      if (row.li !== want) $.list.insertBefore(row.li, want);
      prev = row.li;
    }
    for (const [id, row] of qrows) {
      if (keep.has(id)) continue;
      row.li.remove();
      qrows.delete(id);
    }
  }

  function renderActions(job) {
    const block = engineBlockReason();
    const key = `${job.id}|${job.status}|${pinnedId ? 1 : 0}|${(job.outputs || []).length}|${block}`;
    if (key === lastActionsKey) return;
    lastActionsKey = key;
    const a = $.actions;
    a.replaceChildren();
    const btn = (label, kind, fn, tip, needsEngine = false) => {
      const b = h('button', { type: 'button', class: `btn btn-sm ${kind ? 'btn-' + kind : ''}` }, label);
      const wrap = h('span', { class: 'btn-guard' }, b);
      if (needsEngine && block) {
        b.disabled = true;
        wrap.dataset.tooltip = block;
      } else if (tip) {
        wrap.dataset.tooltip = tip;
      }
      // 더블클릭의 두 번째 클릭(같은 자리에 새로 그려진 [취소] 등)은 무시하고, 요청 중에는 다시 누를 수 없게
      b.addEventListener('click', (e) => {
        if (e.detail > 1) return;
        withBusy(b, async () => fn());
      });
      a.append(wrap);
      return b;
    };
    if (isActive(job)) {
      btn('취소', 'ghost', () => cancelJob(job.id), job.status === 'running' ? '현재 단계에서 생성을 중단합니다' : '대기열에서 뺍니다');
    } else if (job.status === 'done') {
      if ((job.outputs || []).length) btn('크게 보기', 'ghost', () => openJobOutputs(job, 0));
      btn('같은 설정으로 다시', 'ghost', () => retryJob(job.id), '같은 설정으로 다시 생성합니다 (랜덤 시드였다면 새 시드)', true);
    } else if (job.status === 'error') {
      btn('실패 원인 보기', 'ghost', () => showJobError(job));
      btn('다시 시도', 'ghost', () => retryJob(job.id), '', true);
    } else if (job.status === 'cancelled') {
      btn('다시 시도', 'ghost', () => retryJob(job.id), '', true);
    }
    if (pinnedId) btn('자동 추적', 'ghost', () => { pinnedId = null; update(); }, '진행 중인 작업을 자동으로 따라갑니다');
    const link = h('a', { class: 'btn btn-sm btn-ghost', href: '#/jobs' }, '작업 목록');
    a.append(link);
  }

  function renderOutputs(job) {
    const outs = job.outputs || [];
    const key = `${job.id}|${outs.map((x) => x.path).join('|')}`;
    if (key === lastOutputsKey) return;
    lastOutputsKey = key;
    $.outputs.replaceChildren();
    if (outs.length < 2 && job.status === 'done') return;
    outs.forEach((out, i) => {
      const it = itemFromOutput(out);
      const img = h('img', { src: it.thumb, alt: it.name, loading: 'lazy', decoding: 'async' });
      const b = h('button', { type: 'button', class: 'out-thumb', 'aria-label': `${it.name} 크게 보기` }, img);
      img.addEventListener('load', () => detectAlpha(img, it.path, (a) => b.classList.toggle('checker', a)), { once: true });
      b.addEventListener('click', () => openJobOutputs(job, i));
      $.outputs.append(b);
    });
  }

  function tick() {
    const job = current;
    if (!job) return;
    const now = nowSec();
    const exprCount = jobExprCount(job);
    if (job.status === 'running') {
      $.elapsed.textContent = job.started ? `경과 ${fmtClock(now - job.started)}` : '';
      $.eta.textContent = remainingText(job, { exprCount });
    } else if (job.status === 'queued') {
      $.elapsed.textContent = job.created ? `대기 ${fmtClock(now - job.created)}` : '';
      $.eta.textContent = etaText(job.spec || {}, jobEtaOpts(job, { exprCount }));
    } else if (job.status === 'done') {
      $.elapsed.textContent = job.started && job.finished ? `소요 ${fmtDuration(job.finished - job.started)}` : '';
      $.eta.textContent = job.finished ? `완료 ${fmtRelative(job.finished)}` : '';
    } else {
      $.elapsed.textContent = '';
      $.eta.textContent = job.finished ? fmtRelative(job.finished) : '';
    }
  }

  function renderJob(job) {
    el.classList.remove('is-empty');
    $.info.hidden = false;
    const spec = job.spec || {};
    const [w, hh] = sizeWH(jobSize(job), spec.mode);
    $.stage.style.aspectRatio = `${w} / ${hh}`;
    $.badge.replaceChildren(statusBadge(job.status));
    $.summary.textContent = jobTitle(job);
    $.meta.replaceChildren(...jobMetaChips(job));
    const running = job.status === 'running';
    const queued = job.status === 'queued';
    const pct = jobPercent(job);
    $.stageName.textContent = running ? stageText(job)
      : queued ? (queueAhead(job) ? `대기 중 · 앞에 ${queueAhead(job)}개 작업` : '곧 시작합니다')
        : job.status === 'done' ? `완료 · ${(job.outputs || []).length}장 저장됨`
          : job.status === 'cancelled' ? '취소됨' : '실패';
    $.progress.hidden = !(running || queued);
    $.progress.classList.toggle('indeterminate', queued || (running && pct <= 0.5));
    $.bar.style.width = `${running ? pct : 0}%`;
    $.pct.textContent = running ? `${Math.floor(pct)}%` : '';
    if (job.status === 'error') {
      const msg = job.error || '알 수 없는 오류';
      $.error.hidden = false;
      $.error.textContent = msg.length > 220 ? msg.slice(0, 220) + '…' : msg;
    } else {
      $.error.hidden = true;
    }
    renderOutputs(job);
    renderActions(job);
    tick();

    // 이미지
    if (running || (job.status !== 'done' && imgKind === 'preview')) {
      const t = store.previews.get(job.id);
      if (t && t !== lastPreviewT) {
        lastPreviewT = t;
        showImg(`/api/jobs/${encodeURIComponent(job.id)}/preview?t=${encodeURIComponent(t)}`, 'preview');
      } else if (running && job.has_preview && !lastPreviewT) {
        lastPreviewT = -1;
        showImg(`/api/jobs/${encodeURIComponent(job.id)}/preview?t=${Date.now()}`, 'preview');
      }
      if (!imgKind) setPlaceholder(running ? 'running' : job.status, job);
    } else if (job.status === 'done') {
      const outs = job.outputs || [];
      if (outs.length) {
        const first = itemFromOutput(outs[0]);
        if ((imgKind !== 'output' && imgKind !== 'missing') || $.img.dataset.path !== first.path) {
          $.img.dataset.path = first.path;
          showImg(first.url, 'output', first.path);
        }
      } else if (!imgKind) {
        setPlaceholder('done-empty', job);
      }
    } else if (queued) {
      if (!imgKind) setPlaceholder('queued', job);
    } else if (!imgKind) {
      setPlaceholder(job.status, job);
    }
  }

  function update() {
    const jobs = [...store.jobs.values()].filter((j) => {
      try {
        return filter(j);
      } catch {
        return false;
      }
    });
    const job = pick(jobs);
    current = job;
    renderQueue(jobs.filter(isActive), job);
    if (!job) {
      shownId = null;
      resetImg();
      el.classList.add('is-empty');
      $.info.hidden = true;
      $.stage.style.aspectRatio = '';
      setPlaceholder('empty');
      return;
    }
    if (job.id !== shownId) {
      shownId = job.id;
      lastPreviewT = 0;
      lastOutputsKey = '';
      lastActionsKey = '';
      delete $.img.dataset.path;
      resetImg();
    }
    renderJob(job);
  }

  update();
  return { el, update, tick };
}

// ======================= 엔진 로그 창 =======================
export function openEngineLog() {
  const pre = h('pre', { class: 'log-view', tabindex: '0', 'aria-label': 'ComfyUI 로그' }, '불러오는 중…');
  const auto = h('input', { type: 'checkbox', checked: true });
  const status = h('span', { class: 'muted small' });
  const body = h('div', { class: 'log-wrap' },
    h('div', { class: 'log-toolbar' },
      h('label', { class: 'check' }, auto, h('span', {}, '2초마다 자동 새로고침')),
      status),
    pre,
    h('p', { class: 'modal-detail' }, '엔진이 시작되지 않거나 생성이 실패하면 마지막 부분의 오류 메시지를 확인하세요. 전체 로그는 user/server.log 파일에 있습니다.'));
  let timer = null;
  let busy = false;
  let lastText = '';
  async function refresh() {
    if (busy) return;
    busy = true;
    try {
      const r = await api('/api/comfy/log?lines=400', { silent: true, timeout: 10000 });
      const lines = Array.isArray(r.lines) ? r.lines : [];
      const text = lines.length ? lines.join('\n') : '(로그가 비어 있습니다 — 엔진을 아직 시작하지 않았을 수 있습니다)';
      if (text !== lastText) {
        const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40 || !lastText;
        pre.textContent = text;
        lastText = text;
        if (atBottom) pre.scrollTop = pre.scrollHeight;
      }
      status.textContent = `마지막 갱신 ${new Date().toLocaleTimeString('ko-KR')}`;
    } catch (e) {
      status.textContent = `로그를 불러오지 못했습니다: ${(e && e.message) || e}`;
    } finally {
      busy = false;
    }
  }
  openModal({
    title: '엔진(ComfyUI) 로그',
    body,
    size: 'xl',
    actions: [
      { label: '복사', kind: 'ghost', onClick: async () => { if (await copyText(pre.textContent || '')) toast('로그를 복사했습니다.', 'success'); return false; } },
      { label: '닫기', kind: 'primary' },
    ],
    onClose: () => clearInterval(timer),
  });
  refresh();
  timer = setInterval(() => { if (auto.checked) refresh(); }, 2000);
}
