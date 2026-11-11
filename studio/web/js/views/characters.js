// 캐릭터 탭: 목록 + 편집 폼 + 시안/스프라이트/CG 생성 + 결과물
import {
  h, refs, esc, ID_RE, lsGet, lsSet, debounce, stableStringify, deepCopy, parseSeedFromName, appendTags, clamp,
} from '../util.js';
import {
  tipIcon, tipNode, helpLink, toast, guardButton, withBusy, confirmDialog, choiceDialog, unsavedDialog, emptyState, spinner,
} from '../ui.js';
import { api } from '../api.js';
import {
  store, on, emit, submitJob, engineBlockReason, characterById, presetLabel, loadCharacters,
} from '../store.js';
import {
  presetSelect, loraEditor, seedInput, countStepper, qualityToggles, jobMonitor, galleryGrid,
} from '../components.js';
import { etaText } from '../eta.js';
import { replaceHash } from '../router.js';
import { poseControl, sizeText } from '../pose.js';
import { isPhone, onPhoneChange } from '../mobile.js';

const DEFAULT_EXPRESSIONS = {
  neutral: { prompt: 'closed mouth, light smile', denoise: 0.55 },
  smile: { prompt: 'smile, open mouth, happy', denoise: 0.55 },
  blush: { prompt: 'blush, embarrassed, looking away, closed mouth', denoise: 0.6 },
  angry: { prompt: 'angry, pout, v-shaped eyebrows', denoise: 0.6 },
  sad: { prompt: 'sad, frown, teary eyes', denoise: 0.6 },
  surprised: { prompt: 'surprised, open mouth, wide-eyed', denoise: 0.6 },
};
const FALLBACK_TEMPLATE = {
  id: '', name: '', count: '1girl, solo', appearance: '', outfit: '', style: '', negative: '', seed: null, model: '', loras: [],
  concept_pose: 'upper body, looking at viewer, smile, simple background, white background',
  sprite_pose: 'full body, standing, looking at viewer, arms at sides, white background, simple background',
  expressions: DEFAULT_EXPRESSIONS, memo: '',
};
const EXPR_NAME_RE = /^[0-9A-Za-z가-힣_-]{1,40}$/;
const RESULT_KINDS = { concept: '시안', sprite: '스프라이트', cg: 'CG' };
const RESULT_HINTS = {
  concept: '마음에 드는 시안의 [시드 고정]을 누르면 이 캐릭터의 시드로 저장됩니다. 스프라이트는 고정된 시드로 만들어집니다.',
  sprite: '배경이 투명한 PNG입니다. base는 표정 차분의 바탕이 되는 기본 포즈(배경 있음)입니다.',
  cg: '이 캐릭터가 등장하는 이벤트 CG입니다.',
};

function normExpressions(ex) {
  const out = {};
  for (const [name, e] of Object.entries(ex || {})) {
    if (typeof e === 'string') out[name] = { prompt: e, denoise: 0.55 };
    else if (e && typeof e === 'object') out[name] = { prompt: e.prompt || '', denoise: Number(e.denoise) || 0.55 };
  }
  return out;
}

// ---------- 표정 편집기 ----------
function exprEditor({ onChange }) {
  let rows = [];
  const body = h('div', { class: 'expr-rows' });
  const addBtn = h('button', { type: 'button', class: 'btn btn-sm btn-ghost' }, '+ 표정 추가');
  const fillBtn = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', 'data-tooltip': '기본 표정(neutral, smile, blush, angry, sad, surprised) 중 없는 것을 추가합니다' }, '기본 6종 채우기');
  const head = h('div', { class: 'expr-head' },
    h('span', {}, '이름'), h('span', {}, '표정 프롬프트'), h('span', {}, '강도', tipNode('expr_denoise')), h('span', {}));
  const el = h('div', { class: 'expr-editor' }, head, body, h('div', { class: 'expr-foot' }, addBtn, fillBtn));
  const defDenoise = () => {
    const v = store.settings && Number(store.settings.expr_denoise);
    return isFinite(v) && v > 0 ? v : 0.55;
  };

  function rowEl(r) {
    const name = h('input', { type: 'text', class: 'expr-name', placeholder: '예: smile', maxlength: '40', 'aria-label': '표정 이름', spellcheck: 'false', autocapitalize: 'off' });
    name.value = r.name;
    const prompt = h('input', { type: 'text', class: 'expr-prompt', placeholder: '예: smile, open mouth, happy', 'aria-label': '표정 프롬프트', spellcheck: 'false' });
    prompt.value = r.prompt;
    const range = h('input', { type: 'range', min: '0.2', max: '0.9', step: '0.05', 'aria-label': '표정 강도' });
    range.value = String(clamp(r.denoise, 0.2, 0.9));
    const val = h('span', { class: 'range-val' }, Number(r.denoise).toFixed(2));
    const rm = h('button', { type: 'button', class: 'icon-btn icon-btn-sm', 'aria-label': '이 표정 삭제', 'data-tooltip': '이 표정 삭제' }, '×');
    name.addEventListener('input', () => { r.name = name.value.trim(); validateRow(); onChange(); });
    prompt.addEventListener('input', () => { r.prompt = prompt.value; onChange(); });
    range.addEventListener('input', () => {
      r.denoise = Math.round(Number(range.value) * 100) / 100;
      val.textContent = r.denoise.toFixed(2);
      onChange();
    });
    rm.addEventListener('click', () => {
      rows = rows.filter((x) => x !== r);
      render();
      onChange();
    });
    function validateRow() {
      const bad = !EXPR_NAME_RE.test(r.name) || rows.filter((x) => x.name === r.name).length > 1;
      name.classList.toggle('invalid', bad && r.name !== '');
    }
    validateRow();
    return h('div', { class: 'expr-row' }, name, prompt, h('div', { class: 'expr-den' }, range, val), rm);
  }
  function render() {
    body.replaceChildren();
    head.hidden = !rows.length;
    if (!rows.length) body.append(h('div', { class: 'lora-empty' }, '표정이 없습니다. [+ 표정 추가] 또는 [기본 6종 채우기]를 누르세요.'));
    for (const r of rows) body.append(rowEl(r));
  }
  addBtn.addEventListener('click', () => {
    let n = 1;
    while (rows.some((r) => r.name === `expr${n}`)) n++;
    const r = { name: `expr${n}`, prompt: '', denoise: defDenoise() };
    rows.push(r);
    render();
    onChange();
    const inputs = body.querySelectorAll('.expr-name');
    const last = inputs[inputs.length - 1];
    if (last) {
      last.focus();
      last.select();
    }
  });
  fillBtn.addEventListener('click', () => {
    let added = 0;
    for (const [name, e] of Object.entries(DEFAULT_EXPRESSIONS)) {
      if (!rows.some((r) => r.name === name)) {
        rows.push({ name, prompt: e.prompt, denoise: e.denoise });
        added++;
      }
    }
    render();
    onChange();
    toast(added ? `기본 표정 ${added}개를 추가했습니다.` : '기본 표정이 이미 모두 있습니다.', added ? 'success' : 'info');
  });
  render();
  return {
    el,
    set(ex) {
      rows = Object.entries(normExpressions(ex)).map(([name, e]) => ({ name, prompt: e.prompt, denoise: e.denoise }));
      render();
    },
    get() {
      const out = {};
      for (const r of rows) out[r.name] = { prompt: r.prompt.trim(), denoise: r.denoise };
      return out;
    },
    names: () => rows.map((r) => r.name).filter((n) => EXPR_NAME_RE.test(n)),
    validate() {
      if (!rows.length) return '표정을 하나 이상 만들어 주세요.';
      const seen = new Set();
      for (const r of rows) {
        if (!EXPR_NAME_RE.test(r.name)) return `표정 이름 '${r.name}'을(를) 확인하세요. 영문·숫자·한글·-·_ 만 쓸 수 있습니다(파일 이름에 사용).`;
        if (seen.has(r.name)) return `표정 이름 '${r.name}'이(가) 중복됩니다.`;
        seen.add(r.name);
        if (!r.prompt.trim()) return `표정 '${r.name}'의 프롬프트를 입력하세요.`;
      }
      return '';
    },
  };
}

export function createCharactersView() {
  let $ = null;
  let preset;
  let lora;
  let seed;
  let expr;
  let quality;
  let pose;
  let conceptCount;
  let cgCount;
  let monitor;
  let results = null;
  let guards = [];
  let visible = false;
  let currentId = null;
  let isNew = false;
  let original = null;
  let snapshot = '';
  let saved = null;
  let resultKind = lsGet('vn.char.resultKind', 'concept');
  if (!RESULT_KINDS[resultKind]) resultKind = 'concept';
  const unchecked = new Set();
  let lastFocusedText = null;

  // ---------- 폼 ----------
  function formGet() {
    const base = original ? deepCopy(original) : {};
    delete base.thumb;
    delete base.error;
    return {
      ...base,
      id: isNew ? $.id.value.trim() : currentId,
      name: $.name.value.trim(),
      count: $.count.value.trim(),
      appearance: $.appearance.value.trim(),
      outfit: $.outfit.value.trim(),
      style: $.style.value.trim(),
      negative: $.negative.value.trim(),
      seed: seed.get(),
      model: preset.get(),
      loras: lora.get(),
      concept_pose: $.concept_pose.value.trim(),
      sprite_pose: $.sprite_pose.value.trim(),
      expressions: expr.get(),
      memo: $.memo.value.trim(),
    };
  }
  function dirty() {
    if (!$ || (!currentId && !isNew)) return false;
    return stableStringify(formGet()) !== snapshot;
  }
  function updateDirty() {
    if (!$) return;
    const d = dirty();
    $.dirtyBadge.hidden = !d;
    $.revertBtn.hidden = !d;
    $.saveBtn.disabled = !d && !isNew;
    $.editor.classList.toggle('is-dirty', d);
    renderExprChecks();
    updateEtas();
  }

  function loadIntoForm(c, newFlag, { keepResults = false } = {}) {
    // 같은 캐릭터를 다시 불러오는 경우(저장 직후·되돌리기)에는 '만들 표정' 선택을 유지한다
    const sameChar = !newFlag && !isNew && !!c && c.id === currentId;
    isNew = newFlag;
    currentId = newFlag ? null : c.id;
    original = deepCopy(c);
    $.name.value = c.name || '';
    $.id.value = c.id || '';
    $.id.readOnly = !newFlag;
    $.id.classList.toggle('readonly', !newFlag);
    $.idNote.textContent = newFlag
      ? '영문 소문자로 시작, 소문자·숫자·-·_ (40자 이내). 파일·폴더 이름에 쓰이며 저장 후에는 바꿀 수 없습니다.'
      : `characters/${c.id}.json · 결과물 폴더 output/${c.id}/`;
    $.count.value = c.count != null ? c.count : '1girl, solo';
    for (const k of ['appearance', 'outfit', 'style', 'negative', 'concept_pose', 'sprite_pose', 'memo']) $[k].value = c[k] || '';
    seed.set(c.seed != null && c.seed !== '' ? c.seed : null);
    preset.set(c.model || '');
    lora.set(c.loras || []);
    expr.set(c.expressions || {});
    if (!sameChar) {
      unchecked.clear();
    } else {
      const valid = new Set(expr.names());
      for (const n of [...unchecked]) if (!valid.has(n)) unchecked.delete(n);
    }
    snapshot = stableStringify(formGet());
    saved = deepCopy(formGet()); // 표정 순서를 지키기 위해 정렬된 snapshot 대신 원래 순서로 보관
    $.empty.hidden = true;
    $.broken.hidden = true;
    $.editor.hidden = false;
    renderHead();
    renderList();
    updateGuards();
    updateDirty();
    if (!keepResults) loadResults();
    monitor.update();
  }

  function renderHead() {
    const c = currentId ? characterById(currentId) : null;
    $.headName.textContent = isNew ? ($.name.value.trim() || '새 캐릭터') : ($.name.value.trim() || currentId);
    $.headId.textContent = isNew ? '저장하지 않은 새 캐릭터' : `ID: ${currentId}`;
    const initial = ($.name.value.trim() || currentId || '?').slice(0, 1).toUpperCase();
    const key = c && c.thumb ? `img:${c.thumb}` : `txt:${initial}`;
    if ($.headThumb.dataset.key !== key) {
      $.headThumb.dataset.key = key;
      $.headThumb.replaceChildren(c && c.thumb ? h('img', { src: c.thumb, alt: '' }) : h('span', { class: 'char-initial' }, initial));
    }
    $.deleteBtn.textContent = isNew ? '취소' : '삭제';
    $.seedHint.textContent = seed.get() == null
      ? '시드가 비어 있으면 스프라이트를 만들 때마다 체형·포즈가 달라집니다. 시안에서 마음에 드는 이미지의 시드를 고정하세요.'
      : '시드가 고정되어 있어 스프라이트·시안 1장이 같은 체형과 구도로 만들어집니다.';
  }

  // ---------- 목록 ----------
  function renderList() {
    if (!$) return;
    const q = $.search.value.trim().toLowerCase();
    const list = $.list;
    list.replaceChildren();
    if (!store.charactersLoaded) {
      list.append(spinner('캐릭터를 불러오는 중…'));
      return;
    }
    const chars = store.characters.filter((c) => !q || String(c.name || '').toLowerCase().includes(q) || String(c.id).includes(q));
    if (!store.characters.length) {
      list.append(h('div', { class: 'list-empty' }, '아직 캐릭터가 없습니다. [+ 새 캐릭터]로 시작하세요.'));
    } else if (!chars.length) {
      list.append(h('div', { class: 'list-empty' }, '검색 결과가 없습니다.'));
    }
    if (isNew) {
      list.append(h('div', { class: 'char-card active is-new', role: 'listitem' },
        h('span', { class: 'char-thumb' }, h('span', { class: 'char-initial' }, '+')),
        h('span', { class: 'char-meta' }, h('span', { class: 'char-name' }, $.name.value.trim() || '새 캐릭터'), h('span', { class: 'char-id' }, '저장 전'))));
    }
    for (const c of chars) {
      const active = !isNew && c.id === currentId;
      const thumb = h('span', { class: 'char-thumb' });
      if (c.thumb) thumb.append(h('img', { src: c.thumb, alt: '', loading: 'lazy' }));
      else thumb.append(h('span', { class: 'char-initial' }, String(c.name || c.id || '?').slice(0, 1).toUpperCase()));
      const sub = [];
      if (c.error) sub.push(h('span', { class: 'badge badge-bad' }, '파일 오류'));
      else {
        sub.push(h('span', { class: 'char-id' }, c.id));
        if (c.seed != null) sub.push(h('span', { class: 'badge badge-muted', 'data-tooltip': `시드 ${c.seed} 고정` }, '시드 고정'));
      }
      const a = h('a', { class: `char-card${active ? ' active' : ''}${c.error ? ' is-broken' : ''}`, href: `#/characters/${encodeURIComponent(c.id)}`, role: 'listitem', 'aria-current': active ? 'true' : null },
        thumb,
        h('span', { class: 'char-meta' }, h('span', { class: 'char-name' }, c.name || c.id), h('span', { class: 'char-sub' }, sub)));
      list.append(a);
    }
  }

  // ---------- 선택 / 신규 ----------
  async function confirmLeave() {
    if (!dirty()) return true;
    const r = await unsavedDialog('캐릭터 변경 사항');
    if (r === 'save') return save();
    if (r === 'discard') {
      snapshot = stableStringify(formGet());
      return true;
    }
    return false;
  }
  const hashFor = () => (isNew ? '#/characters/new' : currentId ? `#/characters/${encodeURIComponent(currentId)}` : '#/characters');

  let selTok = 0;
  async function select(id) {
    const tok = ++selTok;
    if (!(await confirmLeave())) {
      replaceHash(hashFor());
      return;
    }
    if (tok !== selTok) return;
    const known = characterById(id);
    if (known && known.error) {
      showBroken(known);
      return;
    }
    $.editor.classList.add('is-loading');
    try {
      const r = await api(`/api/characters/${encodeURIComponent(id)}`, { silent: true });
      if (tok !== selTok) return;
      const c = r && (r.character || (r.id ? r : null));
      if (!c) throw new Error('캐릭터 정보를 읽지 못했습니다.');
      loadIntoForm(c, false);
    } catch (e) {
      if (tok !== selTok) return;
      if (known) loadIntoForm(known, false);
      else {
        toast(e && e.message ? e.message : `캐릭터 '${id}'를 찾을 수 없습니다.`, 'error');
        showEmpty();
        replaceHash('#/characters');
      }
    } finally {
      $.editor.classList.remove('is-loading');
    }
  }

  async function startNew(prefill = null) {
    if (!(await confirmLeave())) {
      replaceHash(hashFor());
      if (prefill) toast('새 캐릭터 폼을 열지 않아 추출한 태그를 채우지 않았습니다.', 'info');
      return;
    }
    let t = null;
    try {
      const r = await api('/api/characters/template', { silent: true });
      t = r && (r.template || r);
    } catch {
      t = null;
    }
    if (!t || typeof t !== 'object') t = deepCopy(FALLBACK_TEMPLATE);
    loadIntoForm({ ...deepCopy(t), id: '', name: '' }, true);
    if (prefill) applyPrefill(prefill);
    setTimeout(() => $.name.focus(), 50);
  }

  // 프롬프트 추출 → [새 캐릭터로 만들기]: 템플릿 위에 칸만 채운다(저장 안 된 상태로 둠 → 사용자가 확인 후 저장)
  function applyPrefill(p) {
    if (!$ || !p) return;
    const set = (k, v) => {
      if (typeof v === 'string' && v.trim()) $[k].value = v.trim();
    };
    set('count', p.count);
    set('appearance', p.appearance);
    set('outfit', p.outfit);
    set('memo', p.memo);
    updateDirty();
    renderHead();
    renderList();
    toast('프롬프트 추출 결과로 새 캐릭터 폼을 채웠습니다. 이름·ID를 정하고 외형·의상을 확인한 뒤 [저장]을 누르세요.', 'success', {
      title: p.source ? `프롬프트 추출 · ${p.source}` : '프롬프트 추출', timeout: 10000,
    });
  }

  // 프롬프트 추출 → [기존 캐릭터에 적용]: 외형/의상 칸을 교체(확인은 추출 탭에서 받음). 저장은 사용자가.
  function applyExtract(p) {
    if (!$ || !p) return;
    if (isNew || currentId !== p.id || $.editor.hidden) {
      toast(`캐릭터 '${p.id}'를 열지 못해 추출한 태그를 적용하지 않았습니다.`, 'warn');
      return;
    }
    const prev = { appearance: $.appearance.value, outfit: $.outfit.value };
    const changed = [];
    if (typeof p.appearance === 'string' && p.appearance.trim()) {
      $.appearance.value = p.appearance.trim();
      changed.push('외형');
    }
    if (typeof p.outfit === 'string' && p.outfit.trim()) {
      $.outfit.value = p.outfit.trim();
      changed.push('의상');
    }
    if (!changed.length) return;
    updateDirty();
    renderHead();
    const id = currentId;
    toast(`${changed.join('·')} 칸을 추출한 태그로 바꿨습니다. 아직 저장하지 않았습니다 — 확인한 뒤 [저장]을 누르세요.`, 'success', {
      title: p.source ? `프롬프트 추출 · ${p.source}` : '프롬프트 추출',
      timeout: 12000,
      action: {
        label: '되돌리기',
        onClick: () => {
          if (!$ || isNew || currentId !== id) return;
          $.appearance.value = prev.appearance;
          $.outfit.value = prev.outfit;
          updateDirty();
          renderHead();
          toast('외형·의상을 적용 전으로 되돌렸습니다.', 'info');
        },
      },
    });
  }

  function showEmpty() {
    currentId = null;
    isNew = false;
    original = null;
    snapshot = '';
    $.editor.hidden = true;
    $.broken.hidden = true;
    $.empty.hidden = false;
    renderList();
    monitor.update();
  }

  function showBroken(c) {
    currentId = null;
    isNew = false;
    original = null;
    snapshot = '';
    $.editor.hidden = true;
    $.empty.hidden = true;
    $.broken.hidden = false;
    $.brokenText.textContent = `characters/${c.id}.json 파일을 읽을 수 없습니다: ${c.error}`;
    renderList();
  }

  // ---------- 저장 / 삭제 ----------
  async function save() {
    const c = formGet();
    if (isNew) {
      if (!ID_RE.test(c.id)) {
        toast('ID는 영문 소문자나 숫자로 시작하고, 소문자·숫자·-·_ 만 쓸 수 있습니다 (40자 이내).', 'warn');
        $.id.focus();
        return false;
      }
      if (characterById(c.id)) {
        toast(`ID '${c.id}'는 이미 사용 중입니다. 다른 ID를 입력하세요.`, 'warn');
        $.id.focus();
        return false;
      }
    }
    if (!c.appearance) {
      toast('외형은 비워 둘 수 없습니다. 머리 모양·머리색·눈색·체형처럼 항상 같은 외형 태그를 적어 주세요.', 'warn');
      $.appearance.focus();
      return false;
    }
    if (!seed.isValid()) {
      toast('시드는 0~4294967295 사이의 정수여야 합니다. 비우려면 [랜덤]을 선택하세요.', 'warn');
      seed.input.focus();
      return false;
    }
    const ee = expr.validate();
    if (ee) {
      toast(ee, 'warn');
      return false;
    }
    if (!c.name) c.name = c.id;
    const wasNew = isNew;
    try {
      const r = wasNew
        ? await api('/api/characters', { method: 'POST', body: c })
        : await api(`/api/characters/${encodeURIComponent(c.id)}`, { method: 'PUT', body: c });
      const out = (r && (r.character || (r.id ? r : null))) || c;
      toast(wasNew ? `'${out.name || out.id}' 캐릭터를 만들었습니다.` : `'${out.name || out.id}'을(를) 저장했습니다.`, 'success');
      await loadCharacters();
      loadIntoForm(out, false, { keepResults: !wasNew });
      if (wasNew) replaceHash(`#/characters/${encodeURIComponent(out.id)}`);
      return true;
    } catch {
      return false;
    }
  }

  async function del() {
    if (isNew) {
      snapshot = stableStringify(formGet());
      if (isPhone()) { // 휴대폰: 목록 화면으로 돌아간다
        showEmpty();
        location.hash = '#/characters';
        return;
      }
      const first = store.characters.find((x) => !x.error);
      if (first) location.hash = `#/characters/${encodeURIComponent(first.id)}`;
      else {
        showEmpty();
        replaceHash('#/characters');
      }
      return;
    }
    const name = $.name.value.trim() || currentId;
    const ok = await confirmDialog({
      title: '캐릭터 삭제',
      message: `'${name}' 캐릭터를 삭제할까요?`,
      detail: '캐릭터 파일은 휴지통(user/trash/characters)으로 옮겨져 나중에 복구할 수 있습니다. 이미 생성된 이미지는 그대로 남습니다.',
      confirmText: '삭제',
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/characters/${encodeURIComponent(currentId)}`, { method: 'DELETE' });
    } catch {
      return;
    }
    toast(`'${name}' 캐릭터를 삭제했습니다.`, 'success');
    snapshot = '';
    currentId = null;
    original = null;
    await loadCharacters();
    if (isPhone()) {
      showEmpty();
      location.hash = '#/characters';
      return;
    }
    const first = store.characters.find((x) => !x.error);
    if (first) location.hash = `#/characters/${encodeURIComponent(first.id)}`;
    else {
      showEmpty();
      replaceHash('#/characters');
    }
  }

  function revert() {
    if (!saved) return;
    if (isNew) {
      loadIntoForm({ ...saved }, true);
      return;
    }
    loadIntoForm({ ...(original || {}), ...saved }, false, { keepResults: true });
    toast('마지막으로 저장한 상태로 되돌렸습니다.', 'info');
  }

  // ---------- 생성 ----------
  function blockReason() {
    if (isNew) return '새 캐릭터는 먼저 저장해야 생성할 수 있습니다.';
    return engineBlockReason();
  }
  function updateGuards() {
    const r = blockReason();
    for (const g of guards) g.update(r);
  }
  async function ensureSaved() {
    if (isNew) {
      toast('새 캐릭터는 먼저 저장해야 생성할 수 있습니다.', 'warn');
      return false;
    }
    if (!dirty()) return true;
    const r = await choiceDialog({
      title: '저장 후 생성할까요?',
      message: '저장하지 않은 변경 사항이 있습니다.',
      detail: '생성은 저장된 캐릭터 설정으로 진행됩니다. 지금 저장하고 생성하면 변경 내용이 반영됩니다.',
      choices: [
        { label: '취소', kind: 'ghost', value: null },
        { label: '저장 안 하고 생성', kind: 'ghost', value: 'nosave' },
        { label: '저장 후 생성', kind: 'primary', value: 'save', autofocus: true },
      ],
    });
    if (r === 'save') return save();
    return r === 'nosave';
  }
  function spriteExprs() {
    const names = expr.names();
    const chosen = names.filter((n) => !unchecked.has(n));
    return { names, chosen };
  }
  // 포즈(ControlNet): 시안·스프라이트(기본 포즈만)·CG에 공통. 크기는 비워 두면 서버가 포즈 크기로 만든다
  function withPose(spec) {
    const p = pose ? pose.get() : null;
    if (p) spec.pose = p;
    return spec;
  }
  function conceptSpec() {
    return withPose({ mode: 'concept', character: currentId, count: conceptCount.get(), seed: null, ...quality.get() });
  }
  function spriteSpec() {
    const { names, chosen } = spriteExprs();
    return withPose({
      mode: 'sprite', character: currentId, expressions: chosen.length === names.length ? null : chosen,
      upscale: !!$.upscale.checked, ...quality.get(),
    });
  }
  function cgSpec() {
    return withPose({ mode: 'cg', character: currentId, prompt: $.cgPrompt.value.trim(), count: cgCount.get(), ...quality.get() });
  }
  function updatePoseNotes() {
    if (!$ || !pose) return;
    const ps = pose.size();
    $.cgSize.textContent = ps ? `포즈 크기 ${ps[0]}×${ps[1]}` : '와이드 1344×768';
    pose.setNote(ps
      ? `세 가지 생성 모두 포즈 크기(${sizeText(ps[0], ps[1])})로 만듭니다. 스프라이트는 기본 포즈에만 적용되고 표정 차분은 그 위에 그려집니다.${ps[0] <= ps[1] ? ' CG를 가로로 만들려면 와이드(1344×768) 포즈를 고르세요.' : ''}`
      : '스프라이트는 기본 포즈에만 적용됩니다(표정 차분은 그 위에 그려짐).');
  }
  function updateEtas() {
    if (!$) return;
    const poseSize = pose ? pose.size() : null;
    $.conceptEta.textContent = etaText(conceptSpec(), { poseSize });
    $.spriteEta.textContent = etaText(spriteSpec(), { exprCount: spriteExprs().chosen.length, poseSize });
    $.cgEta.textContent = etaText(cgSpec(), { poseSize });
    const n = conceptCount.get();
    $.conceptNote.textContent = n === 1 && seed.get() != null
      ? `1장이면 캐릭터 시드(${seed.get()})를 사용합니다.`
      : '장마다 새 랜덤 시드를 씁니다. 파일 이름에 시드가 기록됩니다.';
    $.seedWarn.hidden = seed.get() != null;
  }
  function renderExprChecks() {
    if (!$) return;
    const { names } = spriteExprs();
    const box = $.exprChecks;
    box.replaceChildren();
    if (!names.length) {
      box.append(h('div', { class: 'muted small' }, '표정이 없습니다. 왼쪽 폼에서 표정을 추가하세요.'));
      return;
    }
    for (const n of names) {
      const cb = h('input', { type: 'checkbox' });
      cb.checked = !unchecked.has(n);
      cb.addEventListener('change', () => {
        if (cb.checked) unchecked.delete(n);
        else unchecked.add(n);
        updateEtas();
      });
      box.append(h('label', { class: 'chip chip-check' }, cb, h('span', {}, n)));
    }
  }

  async function runGenerate(btn, specFn, validate) {
    if (validate && !validate()) return;
    if (!(await ensureSaved())) return;
    const r = blockReason();
    if (r) {
      toast(r, 'warn');
      return;
    }
    const job = await withBusy(btn, () => submitJob(specFn()));
    // 진행 상황 패널이 오른쪽 열 아래쪽에 가려져 있을 수 있으므로 보이게 스크롤
    if (job && $ && !$.monitorSlot.hidden) {
      try {
        $.monitorSlot.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } catch { /* 무시 */ }
    }
  }

  // ---------- 결과물 ----------
  function loadResults() {
    if (!$) return;
    $.resultTabs.querySelectorAll('[data-kind]').forEach((b) => {
      const on_ = b.dataset.kind === resultKind;
      b.classList.toggle('active', on_);
      b.setAttribute('aria-selected', on_ ? 'true' : 'false');
    });
    $.resultHint.textContent = RESULT_HINTS[resultKind];
    $.resultsSlot.replaceChildren();
    if (!currentId) {
      results = null;
      $.resultsSlot.append(emptyState({ icon: '▢', title: '저장 후 생성하면 결과물이 여기에 표시됩니다' }));
      return;
    }
    const id = currentId;
    const kind = resultKind;
    results = galleryGrid({
      params: { char: id, folder: `${id}/${kind}`, kind },
      pageSize: 24,
      gridClass: kind === 'cg' ? 'thumb-grid-wide' : '',
      emptyTitle: `아직 ${RESULT_KINDS[kind]} 결과가 없습니다`,
      emptyText: kind === 'concept' ? '위의 [시안 생성]으로 시작하세요.' : kind === 'sprite' ? '시드를 고정한 뒤 [스프라이트 생성]을 누르세요.' : '장면 프롬프트를 적고 [CG 생성]을 누르세요.',
      overlayFor: kind === 'concept' ? (it) => seedOverlay(it) : null,
    });
    $.resultsSlot.append(results.el);
    results.reload();
  }
  function seedOverlay(it) {
    const s = it.seed != null ? it.seed : parseSeedFromName(it.name || it.path);
    if (s == null) return null;
    const isCurrent = seed.get() === s;
    const b = h('button', { type: 'button', class: `btn btn-xs tile-action${isCurrent ? ' is-current' : ''}`, 'data-tooltip': isCurrent ? `현재 고정된 시드(${s})입니다` : `시드 ${s}를 이 캐릭터에 고정합니다` }, isCurrent ? '✓ 현재 시드' : '시드 고정');
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      withBusy(b, () => fixSeed(s));
    });
    return b;
  }
  async function fixSeed(s) {
    if (!currentId) return;
    try {
      await api(`/api/characters/${encodeURIComponent(currentId)}/seed`, { method: 'POST', body: { seed: s } });
    } catch {
      return;
    }
    applySeedLocally(currentId, s);
    toast(`시드 ${s}를 고정했습니다. 이제 [스프라이트 생성]을 누르면 이 체형·구도로 만들어집니다.`, 'success');
    emit('character-seed', { id: currentId, seed: s, local: true });
    loadCharacters();
  }
  function applySeedLocally(id, s) {
    if (!$ || id !== currentId || !saved) return;
    seed.set(s);
    saved.seed = s;
    if (original) original.seed = s;
    snapshot = stableStringify({ ...JSON.parse(snapshot), seed: s });
    renderHead();
    updateDirty();
    if (resultKind === 'concept') loadResults();
  }

  // ---------- 마운트 ----------
  function mount(el) {
    el.innerHTML = `
      <div class="char-layout" data-ref="layout">
        <aside class="panel char-list-panel">
          <div class="panel-head">
            <h2 class="panel-title">캐릭터</h2>
            <a class="btn btn-sm btn-primary" href="#/characters/new">+ 새 캐릭터</a>
          </div>
          <input type="search" class="list-search" data-ref="search" placeholder="이름·ID 검색" aria-label="캐릭터 검색">
          <div class="char-list" data-ref="list" role="list"></div>
          <div class="list-foot" data-local-only><button type="button" class="btn btn-xs btn-ghost" data-ref="openFolder">캐릭터 폴더 열기</button></div>
        </aside>
        <div class="char-main">
          <div data-ref="empty" hidden></div>
          <div class="panel" data-ref="broken" hidden>
            <div class="empty-state">
              <div class="empty-icon" aria-hidden="true">!</div>
              <div class="empty-title">캐릭터 파일을 읽을 수 없습니다</div>
              <div class="empty-text" data-ref="brokenText"></div>
              <div class="empty-actions"><button type="button" class="btn btn-sm" data-ref="brokenFolder" data-local-only>캐릭터 폴더 열기</button></div>
            </div>
          </div>
          <div class="char-editor" data-ref="editor" hidden>
            <div class="panel char-head">
              <a class="btn btn-ghost char-back" href="#/characters" aria-label="캐릭터 목록으로">‹ 목록</a>
              <div class="char-head-thumb" data-ref="headThumb"></div>
              <div class="char-head-text">
                <h2 class="char-head-name" data-ref="headName"></h2>
                <div class="char-head-id" data-ref="headId"></div>
              </div>
              <span class="badge badge-warn" data-ref="dirtyBadge" hidden>저장 안 됨</span>
              <div class="char-head-actions">
                <button type="button" class="btn btn-ghost" data-ref="revertBtn" hidden>되돌리기</button>
                <button type="button" class="btn btn-danger-ghost" data-ref="deleteBtn">삭제</button>
                <button type="button" class="btn btn-primary" data-ref="saveBtn">저장</button>
              </div>
            </div>
            <div class="char-body">
              <form class="panel char-form" data-ref="form" novalidate autocomplete="off">
                <div class="panel-head">
                  <h3 class="panel-title">캐릭터 설정</h3>
                  <div class="panel-tools">${helpLink('workflow-character', '? 캐릭터 작업 흐름')}${helpLink('prompt-consistency', '? 일관성 팁')}</div>
                </div>
                <div class="grid-2">
                  <div class="field">
                    <div class="field-label"><label for="cf-name">이름</label>${tipIcon('char_name')}</div>
                    <input type="text" id="cf-name" data-ref="name" placeholder="예: 하루 (메인 히로인)" maxlength="80">
                  </div>
                  <div class="field">
                    <div class="field-label"><label for="cf-id">ID</label>${tipIcon('char_id')}</div>
                    <input type="text" id="cf-id" data-ref="id" placeholder="예: haru" maxlength="40" spellcheck="false" autocapitalize="off">
                    <div class="field-note" data-ref="idNote"></div>
                  </div>
                </div>
                <div class="field">
                  <div class="field-label"><label for="cf-count">기본 태그</label>${tipIcon('char_count')}</div>
                  <input type="text" id="cf-count" data-ref="count" placeholder="1girl, solo" spellcheck="false">
                </div>
                <div class="field">
                  <div class="field-label"><label for="cf-appearance">외형 <span class="req" aria-label="필수">*</span></label>${tipIcon('char_appearance')}</div>
                  <textarea id="cf-appearance" data-ref="appearance" rows="3" spellcheck="false" placeholder="예: long hair, light brown hair, side braid, hair ribbon, amber eyes, slender"></textarea>
                </div>
                <div class="field">
                  <div class="field-label"><label for="cf-outfit">의상</label>${tipIcon('char_outfit')}</div>
                  <textarea id="cf-outfit" data-ref="outfit" rows="2" spellcheck="false" placeholder="예: school uniform, white serafuku, navy sailor collar, red neckerchief, pleated skirt"></textarea>
                </div>
                <div class="grid-2">
                  <div class="field">
                    <div class="field-label"><label for="cf-style">스타일</label>${tipIcon('char_style')}</div>
                    <textarea id="cf-style" data-ref="style" rows="2" spellcheck="false" placeholder="예: soft colors, pastel (비워도 됨)"></textarea>
                  </div>
                  <div class="field">
                    <div class="field-label"><label for="cf-negative">추가 네거티브</label>${tipIcon('char_negative')}</div>
                    <textarea id="cf-negative" data-ref="negative" rows="2" spellcheck="false" placeholder="예: glasses, short hair"></textarea>
                  </div>
                </div>
                <div class="grid-2">
                  <div class="field">
                    <div class="field-label"><label for="cf-seed">시드</label>${tipIcon('char_seed')}</div>
                    <div data-ref="seedSlot"></div>
                    <div class="field-note" data-ref="seedHint"></div>
                  </div>
                  <div class="field">
                    <div class="field-label"><label for="cf-model">모델 프리셋</label>${tipIcon('char_model')}${helpLink('models')}</div>
                    <div data-ref="presetSlot"></div>
                  </div>
                </div>
                <div class="field">
                  <div class="field-label"><span class="label">캐릭터 LoRA</span>${tipIcon('char_loras')}${helpLink('loras')}</div>
                  <div data-ref="loraSlot"></div>
                </div>
                <div class="grid-2">
                  <div class="field">
                    <div class="field-label"><label for="cf-concept_pose">시안 포즈</label>${tipIcon('char_concept_pose')}</div>
                    <textarea id="cf-concept_pose" data-ref="concept_pose" rows="2" spellcheck="false"></textarea>
                  </div>
                  <div class="field">
                    <div class="field-label"><label for="cf-sprite_pose">스프라이트 포즈</label>${tipIcon('char_sprite_pose')}</div>
                    <textarea id="cf-sprite_pose" data-ref="sprite_pose" rows="2" spellcheck="false"></textarea>
                  </div>
                </div>
                <div class="field">
                  <div class="field-label"><span class="label">표정</span>${tipIcon('char_expressions')}${helpLink('sprite-expr')}</div>
                  <div data-ref="exprSlot"></div>
                </div>
                <div class="field">
                  <div class="field-label"><label for="cf-memo">메모</label>${tipIcon('char_memo')}</div>
                  <textarea id="cf-memo" data-ref="memo" rows="3" placeholder="설정, 성격, 참고 사항 등 자유롭게 (생성에는 쓰이지 않음)"></textarea>
                </div>
              </form>
              <div class="char-side">
                <section class="panel action-panel">
                  <div class="panel-head">
                    <h3 class="panel-title">생성하기</h3>
                    <div class="panel-tools">${helpLink('quality', '? 품질 설정')}</div>
                  </div>
                  <div data-ref="qualitySlot"></div>
                  <div class="field pose-group char-pose">
                    <div class="field-label"><span class="label">포즈 (ControlNet)</span>${tipIcon('pose')}${helpLink('pose-character')}</div>
                    <div data-ref="poseSlot"></div>
                  </div>
                  <div class="guard-reason" data-ref="reason" hidden></div>
                  <div class="action-block">
                    <div class="action-title"><span class="step-no">1</span>시안</div>
                    <p class="action-desc">외형만 정해 두고 여러 장을 뽑아, 마음에 드는 얼굴·체형을 고릅니다.</p>
                    <div class="action-row">
                      <div class="field-inline"><label for="cf-concept-count">장수</label>${tipIcon('count')}<div data-ref="conceptCountSlot"></div></div>
                      <button type="button" class="btn btn-primary" data-ref="conceptBtn">시안 생성</button>
                    </div>
                    <div class="field-note" data-ref="conceptNote"></div>
                    <div class="eta" data-ref="conceptEta"></div>
                  </div>
                  <div class="action-block">
                    <div class="action-title"><span class="step-no">2</span>스프라이트 <span class="muted small">표정 차분 · 투명 PNG</span></div>
                    <div class="seed-warn" data-ref="seedWarn" hidden>시드가 고정되어 있지 않습니다. 시안 결과에서 [시드 고정]을 먼저 누르는 것을 권장합니다.</div>
                    <div class="expr-checks-head"><span class="small muted">만들 표정</span>
                      <button type="button" class="link-btn" data-ref="exprAll">모두 선택</button>
                      <button type="button" class="link-btn" data-ref="exprNone">모두 해제</button>
                    </div>
                    <div class="chips expr-checks" data-ref="exprChecks"></div>
                    <div class="action-row">
                      <label class="check"><input type="checkbox" data-ref="upscale"><span>2배 업스케일</span></label>${tipIcon('upscale')}
                      <button type="button" class="btn btn-primary" data-ref="spriteBtn">스프라이트 생성</button>
                    </div>
                    <div class="eta" data-ref="spriteEta"></div>
                  </div>
                  <div class="action-block">
                    <div class="action-title"><span class="step-no">3</span>이벤트 CG <span class="muted small" data-ref="cgSize">와이드 1344×768</span></div>
                    <div class="field">
                      <div class="field-label"><label for="cf-cg">장면 프롬프트</label>${tipIcon('prompt')}</div>
                      <textarea id="cf-cg" data-ref="cgPrompt" rows="2" spellcheck="false" placeholder="예: sitting on bench, park, sunset, smile, holding ice cream"></textarea>
                    </div>
                    <div class="action-row">
                      <div class="field-inline"><label for="cf-cg-count">장수</label><div data-ref="cgCountSlot"></div></div>
                      <button type="button" class="btn btn-primary" data-ref="cgBtn">CG 생성</button>
                    </div>
                    <div class="eta" data-ref="cgEta"></div>
                  </div>
                </section>
                <div data-ref="monitorSlot"></div>
              </div>
            </div>
            <section class="panel char-results">
              <div class="panel-head">
                <h3 class="panel-title">결과물</h3>
                <div class="seg" role="tablist" data-ref="resultTabs" aria-label="결과물 종류">
                  <button type="button" class="seg-btn" role="tab" data-kind="concept">시안</button>
                  <button type="button" class="seg-btn" role="tab" data-kind="sprite">스프라이트</button>
                  <button type="button" class="seg-btn" role="tab" data-kind="cg">CG</button>
                </div>
                <div class="panel-tools"><button type="button" class="btn btn-sm btn-ghost" data-ref="refreshResults">새로고침</button></div>
              </div>
              <p class="panel-sub" data-ref="resultHint"></p>
              <div data-ref="resultsSlot"></div>
            </section>
          </div>
        </div>
      </div>`;
    $ = refs(el);

    $.empty.append(emptyState({
      icon: '☺',
      title: '캐릭터를 선택하거나 새로 만드세요',
      text: '캐릭터에 외형·의상을 정해 두면 시안 → 시드 고정 → 스프라이트(표정 차분) → CG까지 같은 모습으로 만들 수 있습니다.',
      actions: [h('a', { class: 'btn btn-primary', href: '#/characters/new' }, '+ 새 캐릭터'), h('a', { class: 'btn btn-ghost', href: '#/help/workflow' }, '작업 흐름 보기')],
    }));

    const onFormChange = () => {
      updateDirty();
      renderHead();
    };
    seed = seedInput({ id: 'cf-seed', randomHint: '비우면 매번 랜덤', onChange: onFormChange });
    $.seedSlot.append(seed.el);
    preset = presetSelect({
      id: 'cf-model',
      allowDefault: true,
      defaultLabel: () => `기본 프리셋 사용 (${presetLabel(store.defaultPreset) || '불러오는 중'})`,
      onChange: () => { lora.refresh(); onFormChange(); },
    });
    $.presetSlot.append(preset.el);
    lora = loraEditor({
      getPreset: () => preset.effective(),
      // 선택한 프리셋의 기본 LoRA는 캐릭터 LoRA와 별도로 자동 적용된다
      inherited: () => {
        const p = store.presets[preset.effective()];
        return ((p && p.loras) || []).filter((l) => l && l.name).map((l) => ({ name: l.name, weight: l.weight, source: '프리셋' }));
      },
      triggerTarget: '외형(또는 마지막으로 편집한 칸)',
      onTrigger: (t) => {
        const target = lastFocusedText && $.form.contains(lastFocusedText) ? lastFocusedText : $.appearance;
        appendTags(target, t);
        toast(`트리거 '${t}'를 넣었습니다.`, 'success');
      },
      onChange: onFormChange,
    });
    $.loraSlot.append(lora.el);
    expr = exprEditor({ onChange: onFormChange });
    $.exprSlot.append(expr.el);
    quality = qualityToggles({ value: lsGet('vn.char.quality', {}) || {}, idPrefix: 'cq', onChange: () => { lsSet('vn.char.quality', quality.get()); updateEtas(); } });
    $.qualitySlot.append(quality.el);
    pose = poseControl({
      idPrefix: 'cq-pose',
      variant: 'compact',
      onChange: () => {
        lsSet('vn.char.pose', pose.state());
        updatePoseNotes();
        if (conceptCount) updateEtas();
      },
    });
    $.poseSlot.append(pose.el);
    updatePoseNotes();
    conceptCount = countStepper({ id: 'cf-concept-count', value: lsGet('vn.char.conceptCount', 4), min: 1, max: 16, onChange: () => { lsSet('vn.char.conceptCount', conceptCount.get()); updateEtas(); } });
    $.conceptCountSlot.append(conceptCount.el);
    cgCount = countStepper({ id: 'cf-cg-count', value: 1, min: 1, max: 8, onChange: updateEtas });
    $.cgCountSlot.append(cgCount.el);
    const savedPose = lsGet('vn.char.pose', null);
    if (savedPose && savedPose.name) pose.load(savedPose, { reason: 'restore' });

    monitor = jobMonitor({
      variant: 'compact',
      title: '이 캐릭터의 작업',
      filter: (j) => !!currentId && j.spec && j.spec.character === currentId,
      emptyTitle: '진행 중인 작업이 없습니다',
      emptyText: '생성 버튼을 누르면 여기서 진행 상황을 볼 수 있습니다.',
    });
    $.monitorSlot.append(monitor.el);

    guards = [
      guardButton($.conceptBtn, $.reason),
      guardButton($.spriteBtn),
      guardButton($.cgBtn),
    ];

    // 폼 이벤트
    $.form.addEventListener('input', onFormChange);
    $.form.addEventListener('change', onFormChange);
    $.form.addEventListener('submit', (e) => e.preventDefault());
    $.form.addEventListener('focusin', (e) => {
      const t = e.target;
      if (t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && t.type === 'text' && !t.classList.contains('expr-name'))) {
        if (t !== $.name && t !== $.id && t !== $.memo) lastFocusedText = t;
      }
    });
    $.form.addEventListener('keydown', (e) => {
      if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        withBusy($.saveBtn, save);
      }
    });
    $.id.addEventListener('input', () => {
      if (!isNew) return;
      const v = $.id.value;
      const lower = v.toLowerCase().replace(/\s+/g, '-');
      if (lower !== v) $.id.value = lower;
      const ok = !$.id.value || ID_RE.test($.id.value);
      $.id.classList.toggle('invalid', !ok || !!characterById($.id.value));
    });
    $.saveBtn.addEventListener('click', () => withBusy($.saveBtn, save));
    $.deleteBtn.addEventListener('click', () => withBusy($.deleteBtn, del));
    $.revertBtn.addEventListener('click', revert);
    $.search.addEventListener('input', debounce(renderList, 120));
    const openChars = () => api('/api/open-folder', { method: 'POST', body: { which: 'characters' } }).catch(() => {});
    $.openFolder.addEventListener('click', openChars);
    $.brokenFolder.addEventListener('click', openChars);

    // 생성 버튼
    $.conceptBtn.addEventListener('click', () => runGenerate($.conceptBtn, conceptSpec));
    $.spriteBtn.addEventListener('click', () => runGenerate($.spriteBtn, spriteSpec, () => {
      const ee = expr.validate();
      if (ee) {
        toast(ee, 'warn');
        return false;
      }
      if (!spriteExprs().chosen.length) {
        toast('만들 표정을 하나 이상 선택하세요.', 'warn');
        return false;
      }
      return true;
    }));
    $.cgBtn.addEventListener('click', () => runGenerate($.cgBtn, cgSpec, () => {
      if (!$.cgPrompt.value.trim()) {
        toast('CG 장면 프롬프트를 입력하세요. 예: sitting on bench, park, sunset', 'warn');
        $.cgPrompt.focus();
        return false;
      }
      return true;
    }));
    $.cgPrompt.addEventListener('input', updateEtas);
    $.cgPrompt.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        $.cgBtn.click();
      }
    });
    $.upscale.addEventListener('change', updateEtas);
    $.exprAll.addEventListener('click', () => { unchecked.clear(); renderExprChecks(); updateEtas(); });
    $.exprNone.addEventListener('click', () => { for (const n of expr.names()) unchecked.add(n); renderExprChecks(); updateEtas(); });

    $.resultTabs.addEventListener('click', (e) => {
      const b = e.target instanceof Element ? e.target.closest('[data-kind]') : null;
      if (!b || b.dataset.kind === resultKind) return;
      resultKind = b.dataset.kind;
      lsSet('vn.char.resultKind', resultKind);
      loadResults();
    });
    $.refreshResults.addEventListener('click', () => { if (results) results.reload(); });
    on('secret-purged', () => { if (results) results.reload(); }); // 시크릿 그림이 지워짐

    // 스토어 구독
    const reloadResults = debounce(() => { if (results) results.reload(); }, 800);
    on('characters', () => {
      renderList();
      if (currentId || isNew) renderHead();
      if (visible && !currentId && !isNew && $.broken.hidden && !listMode()) autoSelect();
    });
    on('presets', () => { preset.refresh(); lora.refresh(); });
    on('models', () => lora.refresh());
    on('lora-meta', () => lora.refresh());
    // 모델·LoRA 탭에서 프리셋을 지우면 서버가 그 프리셋을 쓰던 캐릭터를 기본 프리셋('')으로 되돌린다.
    // 열려 있는 폼도 같은 상태로 맞춰, 다음 저장 때 없는 프리셋을 다시 보내지 않게 한다.
    on('preset-deleted', (d) => {
      if (!$ || !d || !d.name) return;
      const { name } = d;
      const affected = Array.isArray(d.affected) ? d.affected : [];
      const touched = !isNew && currentId && affected.includes(currentId);
      if (touched) {
        if (original && original.model === name) original.model = '';
        if (saved && saved.model === name) saved.model = '';
        if (snapshot) {
          try {
            const snap = JSON.parse(snapshot);
            if (snap.model === name) {
              snap.model = '';
              snapshot = stableStringify(snap);
            }
          } catch { /* 무시 */ }
        }
      }
      if ((currentId || isNew) && preset.get() === name) {
        preset.set('');
        lora.refresh();
        if (!touched) toast(`편집 중인 캐릭터에서 고른 프리셋 '${name}'이(가) 삭제되어 기본 프리셋으로 바꿨습니다. 저장해야 반영됩니다.`, 'info', { timeout: 9000 });
      }
      if (currentId || isNew) updateDirty();
    });
    on('settings', () => {});
    on('status', () => { updateGuards(); monitor.update(); });
    on('sse', () => { updateGuards(); monitor.update(); });
    on('jobs', () => monitor.update());
    on('job-removed', () => monitor.update());
    on('preview', () => monitor.update());
    on('job', (job, prev) => {
      monitor.update();
      if (job.spec && job.spec.character === currentId && job.status === 'done' && (!prev || prev.status !== 'done')) {
        if (job.spec.mode === resultKind) reloadResults();
      }
    });
    on('tick', () => { if (visible) monitor.tick(); });
    on('character-seed', (d) => { if (d && !d.local) applySeedLocally(d.id, d.seed); });
    on('gallery-changed', reloadResults);

    renderList();
  }

  // ---------- 휴대폰: 목록 → 편집 2단계 ----------
  // #/characters(아이디 없음)는 목록만, #/characters/<id>·new 는 편집만 보여 준다 (mobile.css의 .char-layout.is-list).
  // 목록으로 돌아가도 편집 중인 내용은 그대로 남고, 다른 캐릭터를 고르거나 탭을 옮길 때 저장 여부를 묻는다.
  let listScroll = 0;
  const listMode = () => !!$ && $.layout.classList.contains('is-list');
  function setListMode(on) {
    if (!$ || listMode() === on) return;
    if (!on) listScroll = window.scrollY;
    $.layout.classList.toggle('is-list', on);
    if (isPhone()) window.scrollTo(0, on ? listScroll : 0);
  }
  onPhoneChange((phone) => {
    if (!$ || phone || !listMode()) return;
    // 휴대폰 목록 화면에서 창을 넓히면(가로 회전 등) 데스크톱처럼 목록 + 편집을 함께 보여 준다
    setListMode(false);
    if (!visible) return;
    if (currentId || isNew) replaceHash(hashFor());
    else autoSelect();
  });

  function autoSelect() {
    const first = store.characters.find((c) => !c.error);
    if (first) {
      replaceHash(`#/characters/${encodeURIComponent(first.id)}`);
      select(first.id);
    } else if (store.charactersLoaded) {
      showEmpty();
    }
  }

  // 프롬프트 추출 탭에서 보낸 값 (탭을 연 적이 없어도 받아 두었다가 show()에서 적용)
  let pendingPrefill = null;
  let pendingApply = null;
  on('characters:prefill', (p) => { pendingPrefill = p || null; });
  on('characters:apply', (p) => { pendingApply = p && p.id ? p : null; });

  return {
    id: 'characters',
    title: '캐릭터',
    mount,
    async show(params) {
      visible = true;
      const id = params && params[0];
      if (!id && isPhone()) {
        setListMode(true);
        renderList();
        return;
      }
      setListMode(false);
      if (id === 'new') {
        if (pendingPrefill) {
          const p = pendingPrefill;
          pendingPrefill = null;
          await startNew(p);
          return;
        }
        if (!isNew) await startNew();
        return;
      }
      if (id) {
        if (id !== currentId || isNew) await select(id);
        if (pendingApply) {
          const p = pendingApply;
          pendingApply = null;
          if (p.id === id) applyExtract(p);
        }
        return;
      }
      if (currentId || isNew) {
        replaceHash(hashFor());
        return;
      }
      autoSelect();
    },
    hide() {
      visible = false;
    },
    isDirty: dirty,
    discard() {
      if (!saved) return;
      if (isNew) {
        isNew = false;
        currentId = null;
        original = null;
        saved = null;
        snapshot = '';
        return;
      }
      loadIntoForm({ ...(original || {}), ...saved }, false, { keepResults: true });
    },
    save,
    dirtyLabel: '캐릭터 변경 사항',
  };
}
