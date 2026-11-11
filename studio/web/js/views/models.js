// 모델·LoRA 탭: 프리셋 편집, 체크포인트 목록, LoRA 라이브러리, URL 다운로드, 전역 설정
import {
  h, refs, esc, ID_RE, clamp, fmtBytes, stableStringify, deepCopy, stripExt, basename, debounce, appendTags,
  lsGet, lsSet,
} from '../util.js';
import {
  tipIcon, tipNode, helpLink, toast, withBusy, confirmDialog, choiceDialog, openModal, emptyState, spinner, badge,
} from '../ui.js';
import { api } from '../api.js';
import {
  store, on, emit, loadPresets, loadModels, loadSettings, loadCharacters, ckptByName, presetLabel, loadTagger,
} from '../store.js';
import { loraEditor, compatBadge, computeCompat, isRatingTag } from '../components.js';
import { replaceHash } from '../router.js';
import { createRemotePanel } from '../remote.js';

const SUBTABS = [
  ['presets', '프리셋'],
  ['checkpoints', '체크포인트'],
  ['loras', 'LoRA'],
  ['downloads', '다운로드'],
  ['settings', '전역 설정'],
];
const PRESET_TEMPLATES = {
  eps: {
    vpred: false, sampler: 'euler_ancestral', scheduler: 'normal', cfg: 6, steps: 28,
    quality: 'masterpiece, best quality, amazing quality',
    negative: 'bad quality, worst quality, worst detail, sketch, censor, nsfw',
  },
  vpred: {
    vpred: true, sampler: 'euler', scheduler: 'normal', cfg: 5, steps: 30,
    quality: 'masterpiece, best quality, newest, absurdres, highres',
    negative: 'nsfw, worst quality, old, early, low quality, lowres, signature, username, logo, bad hands, mutated hands',
  },
};
const SETTINGS_DEFAULTS = {
  hires_scale: 1.5, hires_steps: 14, hires_denoise: 0.4, detail_steps: 14,
  face_denoise: 0.35, hand_denoise: 0.4, expr_denoise: 0.55, upscaler: 'RealESRGAN_x4plus_anime_6B.pth', autostart_comfy: true,
  tagger_threshold: 0.35, tagger_char_threshold: 0.85,
  pose_model: 'noob_openpose.safetensors', pose_strength: 1, pose_end: 1,
};
// 포즈(ControlNet) 기본값 — 서버가 이 키들을 알려 줄 때만 표시·저장한다
const POSE_FIELDS = [
  { key: 'pose_strength', label: '기본 강도', tip: 'set_pose_strength', min: 0.1, max: 2, step: 0.05 },
  { key: 'pose_end', label: '기본 적용 구간(끝)', tip: 'set_pose_end', min: 0.1, max: 1, step: 0.05 },
];
// 프롬프트 추출(태거) 설정 — 서버가 이 키들을 알려 줄 때만 표시·저장한다
const TAGGER_FIELDS = [
  { key: 'tagger_threshold', label: '일반 태그 기준값', tip: 'set_tagger_threshold', min: 0.05, max: 0.95, step: 0.01 },
  { key: 'tagger_char_threshold', label: '캐릭터 태그 기준값', tip: 'set_tagger_char_threshold', min: 0.3, max: 0.99, step: 0.01 },
];
const SETTING_FIELDS = [
  { key: 'hires_scale', label: '하이레즈 배율', tip: 'set_hires_scale', min: 1, max: 2, step: 0.05, unit: '배' },
  { key: 'hires_steps', label: '하이레즈 스텝', tip: 'set_hires_steps', min: 4, max: 60, step: 1, int: true },
  { key: 'hires_denoise', label: '하이레즈 강도', tip: 'set_hires_denoise', min: 0.05, max: 1, step: 0.01 },
  { key: 'detail_steps', label: '보정 스텝 (얼굴·손·표정)', tip: 'set_detail_steps', min: 4, max: 60, step: 1, int: true },
  { key: 'face_denoise', label: '얼굴 보정 강도', tip: 'set_face_denoise', min: 0.05, max: 1, step: 0.01 },
  { key: 'hand_denoise', label: '손 보정 강도', tip: 'set_hand_denoise', min: 0.05, max: 1, step: 0.01 },
  { key: 'expr_denoise', label: '표정 기본 강도', tip: 'set_expr_denoise', min: 0.05, max: 1, step: 0.01 },
];
const FOLDER_LABELS = { checkpoints: '체크포인트', loras: 'LoRA', upscale_models: '업스케일러' };
const PRESET_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

function slugify(s) {
  let out = String(s || '').toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '');
  out = out.replace(/-{2,}/g, '-').slice(0, 40);
  return out || 'preset';
}
function uniqueName(base) {
  let n = slugify(base);
  if (!store.presets[n]) return n;
  for (let i = 2; i < 100; i++) {
    const c = `${n.slice(0, 36)}-${i}`;
    if (!store.presets[c]) return c;
  }
  return `${n.slice(0, 30)}-${Date.now() % 100000}`;
}

/** 슬라이더 + 숫자 입력 */
function rangeField({ id, min, max, step, value, int = false, onInput }) {
  const range = h('input', { type: 'range', id, min: String(min), max: String(max), step: String(step) });
  const num = h('input', { type: 'number', class: 'num-sm', min: String(min), max: String(max), step: String(step), 'aria-label': '값' });
  const norm = (v) => {
    let n = Number(v);
    if (!isFinite(n)) n = min;
    n = clamp(n, min, max);
    return int ? Math.round(n) : Math.round(n * 100) / 100;
  };
  const set = (v) => {
    const n = norm(v);
    range.value = String(n);
    num.value = String(n);
  };
  range.addEventListener('input', () => {
    num.value = String(norm(range.value));
    if (onInput) onInput();
  });
  num.addEventListener('change', () => {
    set(num.value);
    if (onInput) onInput();
  });
  set(value);
  return { el: h('div', { class: 'range-field' }, range, num), get: () => norm(num.value), set, range, num };
}

function archBadge(arch) {
  if (!arch || arch === 'unknown') return badge('알 수 없음', 'muted', '파일 헤더에서 아키텍처를 확인하지 못했습니다');
  return badge(arch, arch === 'SDXL' ? 'accent' : 'info');
}
function vpredBadge(v) {
  return v ? badge('v-pred', 'warn', 'v-prediction 모델: 프리셋에서 v-pred를 켜야 정상 색감이 나옵니다 (샘플러 euler 권장)')
    : badge('eps', 'muted', '일반(epsilon) 예측 모델');
}

export function createModelsView() {
  let $ = null;
  let tab = SUBTABS.some(([k]) => k === lsGet('vn.models.tab')) ? lsGet('vn.models.tab') : 'presets';
  let visible = false;
  let selectedPreset = '';
  let editor = null; // {name, el, get, isDirty, refresh}
  let settingsForm = null;
  let remotePanel = null; // 전역 설정 아래 '원격 접속 (Tailscale)' 묶음 (remote.js)
  const loraEdits = new Map(); // name -> {trigger, weight, note}
  let loraQuery = '';
  let tokenSaved = '';
  const dlSamples = new Map(); // id -> {t, received, speed}
  let loraCardSeq = 0;

  // ======================= 서브탭 =======================
  function renderTabs() {
    $.subtabs.querySelectorAll('[data-tab]').forEach((b) => {
      const on_ = b.dataset.tab === tab;
      b.classList.toggle('active', on_);
      b.setAttribute('aria-selected', on_ ? 'true' : 'false');
    });
    for (const [k] of SUBTABS) $[`sec_${k}`].hidden = k !== tab;
  }
  function setTab(k, push = true) {
    if (!SUBTABS.some(([x]) => x === k)) k = 'presets';
    tab = k;
    lsSet('vn.models.tab', k);
    renderTabs();
    if (push) replaceHash(`#/models/${k}`);
    if (k === 'settings' && remotePanel) remotePanel.activate();
  }

  // ======================= 프리셋 =======================
  function renderPresetList() {
    const list = $.presetList;
    list.replaceChildren();
    const names = Object.keys(store.presets);
    if (!store.presetsLoaded) {
      list.append(spinner('프리셋을 불러오는 중…'));
      return;
    }
    if (!names.length) {
      list.append(h('div', { class: 'list-empty' }, '프리셋이 없습니다. [+ 새 프리셋]으로 만드세요.'));
      return;
    }
    for (const n of names) {
      const p = store.presets[n] || {};
      const ck = ckptByName(p.ckpt);
      const missing = store.models && !ck;
      const item = h('button', { type: 'button', class: `preset-item${n === selectedPreset ? ' active' : ''}`, 'aria-current': n === selectedPreset ? 'true' : null },
        h('span', { class: 'preset-item-top' },
          h('span', { class: 'preset-item-label' }, p.label || n),
          n === store.defaultPreset ? badge('기본', 'accent', '새 생성과 캐릭터에 기본으로 쓰이는 프리셋') : null),
        h('span', { class: 'preset-item-sub' }, h('code', {}, n), ' · ', stripExt(p.ckpt || '(체크포인트 없음)')),
        h('span', { class: 'preset-item-badges' },
          p.vpred ? badge('v-pred', 'warn') : badge('eps', 'muted'),
          missing ? badge('파일 없음', 'bad', `체크포인트 파일을 찾을 수 없습니다: ${p.ckpt}`) : null,
          (p.loras || []).length ? badge(`LoRA ${(p.loras || []).length}`, 'muted') : null));
      item.addEventListener('click', () => selectPreset(n));
      list.append(item);
    }
  }

  async function selectPreset(name, { force = false } = {}) {
    if (!force && editor && editor.name !== name && editor.isDirty()) {
      const ok = await confirmDialog({
        title: '저장하지 않은 변경 사항',
        message: `프리셋 '${editor.name}'의 변경 사항을 저장하지 않았습니다.`,
        detail: '다른 프리셋으로 이동하면 변경 내용이 사라집니다.',
        confirmText: '버리고 이동',
        danger: true,
      });
      if (!ok) return;
    }
    selectedPreset = name;
    renderPresetList();
    buildPresetEditor();
  }

  function buildPresetEditor() {
    const host = $.presetEditor;
    host.replaceChildren();
    editor = null;
    const name = selectedPreset;
    const p0 = store.presets[name];
    if (!p0) {
      host.append(emptyState({ icon: '◇', title: '프리셋을 선택하세요', text: '왼쪽 목록에서 프리셋을 고르거나 새로 만드세요.' }));
      return;
    }
    const p = deepCopy(p0);
    const uid = `pe-${name}`;
    const el = h('div', { class: 'preset-form' });
    el.innerHTML = `
      <div class="panel-head preset-head">
        <div class="preset-head-text">
          <h3 class="panel-title" data-ref="title"></h3>
          <div class="muted small">프리셋 ID <code data-ref="code"></code> <span data-ref="defaultBadge"></span></div>
        </div>
        <div class="panel-tools">
          <span class="badge badge-warn" data-ref="dirty" hidden>저장 안 됨</span>
          <button type="button" class="btn btn-sm btn-ghost" data-ref="makeDefault">기본으로 지정</button>
          <button type="button" class="btn btn-sm btn-ghost" data-ref="dup">복제</button>
          <button type="button" class="btn btn-sm btn-danger-ghost" data-ref="del">삭제</button>
          <button type="button" class="btn btn-sm btn-ghost" data-ref="revert" hidden>되돌리기</button>
          <button type="button" class="btn btn-sm btn-primary" data-ref="save">저장</button>
        </div>
      </div>
      <div class="grid-2">
        <div class="field">
          <div class="field-label"><label for="${uid}-label">표시 이름</label>${tipIcon('preset_label')}</div>
          <input type="text" id="${uid}-label" data-ref="label" maxlength="80">
        </div>
        <div class="field">
          <div class="field-label"><label for="${uid}-ckpt">체크포인트</label>${tipIcon('preset_ckpt')}</div>
          <select id="${uid}-ckpt" class="select" data-ref="ckpt"></select>
          <div class="ckpt-badges" data-ref="ckptBadges"></div>
        </div>
      </div>
      <div class="field">
        <div class="switch-item">
          <label class="switch" for="${uid}-vpred">
            <input type="checkbox" role="switch" id="${uid}-vpred" data-ref="vpred">
            <span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
            <span class="switch-label">v-prediction 모델 (v-pred)</span>
          </label>${tipIcon('preset_vpred')}
        </div>
        <div class="suggest" data-ref="vpredSuggest" hidden></div>
      </div>
      <div class="grid-2">
        <div class="field">
          <div class="field-label"><label for="${uid}-sampler">샘플러</label>${tipIcon('preset_sampler')}</div>
          <select id="${uid}-sampler" class="select" data-ref="sampler"></select>
        </div>
        <div class="field">
          <div class="field-label"><label for="${uid}-scheduler">스케줄러</label>${tipIcon('preset_scheduler')}</div>
          <select id="${uid}-scheduler" class="select" data-ref="scheduler"></select>
        </div>
      </div>
      <div class="grid-2">
        <div class="field">
          <div class="field-label"><label for="${uid}-cfg">CFG</label>${tipIcon('preset_cfg')}</div>
          <div data-ref="cfgSlot"></div>
        </div>
        <div class="field">
          <div class="field-label"><label for="${uid}-steps">스텝</label>${tipIcon('preset_steps')}</div>
          <div data-ref="stepsSlot"></div>
        </div>
      </div>
      <div class="field-note" data-ref="recommend"></div>
      <div class="field">
        <div class="field-label"><label for="${uid}-quality">품질 태그</label>${tipIcon('preset_quality')}</div>
        <textarea id="${uid}-quality" data-ref="quality" rows="2" spellcheck="false"></textarea>
      </div>
      <div class="field">
        <div class="field-label"><label for="${uid}-negative">기본 네거티브</label>${tipIcon('preset_negative')}</div>
        <textarea id="${uid}-negative" data-ref="negative" rows="3" spellcheck="false"></textarea>
      </div>
      <div class="field">
        <div class="field-label"><span class="label">기본 LoRA</span>${tipIcon('preset_loras')}${helpLink('loras')}</div>
        <div data-ref="loraSlot"></div>
      </div>
      <div class="field">
        <div class="field-label"><label for="${uid}-note">노트</label>${tipIcon('preset_note')}</div>
        <textarea id="${uid}-note" data-ref="note" rows="2" placeholder="이 프리셋의 특징·주의 사항 (생성 탭의 프리셋 선택 아래에 표시됩니다)"></textarea>
      </div>`;
    const r = refs(el);
    host.append(el);

    const cfg = rangeField({ id: `${uid}-cfg`, min: 1, max: 20, step: 0.5, value: p.cfg ?? 6, onInput: changed });
    r.cfgSlot.append(cfg.el);
    const steps = rangeField({ id: `${uid}-steps`, min: 5, max: 80, step: 1, int: true, value: p.steps ?? 28, onInput: changed });
    r.stepsSlot.append(steps.el);
    const lora = loraEditor({
      getPreset: () => name,
      // 서버의 호환성(l.compat[name])은 저장된 체크포인트 기준이다.
      // 편집 중에 체크포인트나 v-pred를 바꾸면 선택한 값으로 다시 계산해 보여 준다.
      getCompat: (l) => {
        const ck = r.ckpt.value;
        const vp = !!r.vpred.checked;
        if (ck === (p.ckpt || '') && vp === !!p.vpred) return l.compat ? l.compat[name] || null : null;
        if (!store.models) return null;
        const c = computeCompat(l, ckptByName(ck), vp);
        return c ? { ...c, reason: `${c.reason} (저장 전 · 선택한 체크포인트 기준)` } : null;
      },
      triggerTarget: '품질 태그',
      onTrigger: (t) => { appendTags(r.quality, t); changed(); },
      onChange: changed,
    });
    r.loraSlot.append(lora.el);

    function fillSelect(sel, values, cur, labeler) {
      sel.replaceChildren();
      const list = values.slice();
      if (cur && !list.includes(cur)) list.unshift(cur);
      for (const v of list) sel.append(h('option', { value: v }, labeler ? labeler(v) : v));
      sel.value = cur || list[0] || '';
    }
    function fillCkpt(cur) {
      const cks = (store.models && store.models.checkpoints) || [];
      r.ckpt.replaceChildren();
      if (!store.models) r.ckpt.append(h('option', { value: cur || '' }, cur || '불러오는 중…'));
      for (const c of cks) r.ckpt.append(h('option', { value: c.name }, `${stripExt(c.name)} · ${c.arch || '?'}${c.vpred ? ' · v-pred' : ''}`));
      if (cur && !cks.some((c) => c.name === cur) && store.models) r.ckpt.append(h('option', { value: cur }, `${cur} (파일 없음)`));
      r.ckpt.value = cur || '';
    }
    function fillSamplers(curS, curSch) {
      const m = store.models || {};
      fillSelect(r.sampler, m.samplers && m.samplers.length ? m.samplers : ['euler', 'euler_ancestral', 'dpmpp_2m', 'dpmpp_2m_sde', 'dpmpp_sde', 'dpmpp_3m_sde', 'ddim', 'uni_pc'], curS);
      fillSelect(r.scheduler, m.schedulers && m.schedulers.length ? m.schedulers : ['normal', 'karras', 'exponential', 'sgm_uniform', 'simple', 'beta'], curSch);
    }
    function updateCkptInfo() {
      const ck = ckptByName(r.ckpt.value);
      r.ckptBadges.replaceChildren();
      if (ck) {
        r.ckptBadges.append(archBadge(ck.arch), vpredBadge(ck.vpred));
        if (ck.family) r.ckptBadges.append(badge(ck.family, 'muted'));
        if (ck.size) r.ckptBadges.append(h('span', { class: 'muted small' }, fmtBytes(ck.size)));
        if (ck.arch && ck.arch !== 'SDXL' && ck.arch !== 'unknown') r.ckptBadges.append(badge('SDXL 아님', 'warn', '이 파이프라인은 SDXL(Illustrious/NoobAI 계열) 기준으로 조정되어 있습니다. 해상도·디텍터 설정이 맞지 않을 수 있습니다.'));
      } else if (store.models && r.ckpt.value) {
        r.ckptBadges.append(badge('파일 없음', 'bad', '모델 폴더에서 이 파일을 찾을 수 없습니다. 파일 이름을 확인하거나 다른 체크포인트를 선택하세요.'));
      }
      const sug = r.vpredSuggest;
      if (ck && !!ck.vpred !== !!r.vpred.checked) {
        sug.hidden = false;
        sug.replaceChildren(
          h('span', {}, ck.vpred ? '이 체크포인트는 v-pred 모델로 감지되었습니다. v-pred를 켜야 색이 정상으로 나옵니다.' : '이 체크포인트는 일반(eps) 모델로 감지되었습니다. v-pred를 끄는 것을 권장합니다.'),
          h('button', { type: 'button', class: 'btn btn-xs', onclick: () => { r.vpred.checked = !!ck.vpred; changed(); } }, '감지값 적용'));
      } else {
        sug.hidden = true;
      }
      r.recommend.textContent = r.vpred.checked
        ? '권장(v-pred): 샘플러 euler · CFG 4~5.5 · 28~35스텝. euler_ancestral 등은 색이 깨질 수 있습니다.'
        : '권장(eps): 샘플러 euler_ancestral 또는 dpmpp_2m · CFG 5~7 · 25~30스텝. 모델 배포 페이지의 권장값을 우선하세요.';
    }

    function setForm(v) {
      r.title.textContent = v.label || name;
      r.code.textContent = name;
      r.defaultBadge.replaceChildren(name === store.defaultPreset ? badge('기본 프리셋', 'accent') : '');
      r.label.value = v.label || '';
      fillCkpt(v.ckpt || '');
      r.vpred.checked = !!v.vpred;
      fillSamplers(v.sampler || 'euler_ancestral', v.scheduler || 'normal');
      cfg.set(v.cfg ?? 6);
      steps.set(v.steps ?? 28);
      r.quality.value = v.quality || '';
      r.negative.value = v.negative || '';
      lora.set(v.loras || []);
      r.note.value = v.note || '';
      updateCkptInfo();
      syncCompat(false); // lora.set이 이미 지금 체크포인트 기준으로 그렸음
    }
    function get() {
      return {
        ...p,
        label: r.label.value.trim(),
        ckpt: r.ckpt.value,
        vpred: !!r.vpred.checked,
        sampler: r.sampler.value,
        scheduler: r.scheduler.value,
        cfg: cfg.get(),
        steps: steps.get(),
        quality: r.quality.value.trim(),
        negative: r.negative.value.trim(),
        loras: lora.get(),
        note: r.note.value.trim(),
      };
    }
    let snap = '';
    function isDirty() {
      return stableStringify(get()) !== snap;
    }
    // 체크포인트·v-pred가 바뀔 때만 LoRA 호환성 배지를 다시 그린다 (강도 슬라이더를 끄는 중에 다시 그리지 않도록)
    let compatKey = '';
    function syncCompat(rerender = true) {
      const k = `${r.ckpt.value}|${r.vpred.checked ? 1 : 0}`;
      if (k === compatKey) return;
      compatKey = k;
      if (rerender) lora.refresh();
    }
    function changed() {
      if (!snap) return;
      const d = isDirty();
      r.dirty.hidden = !d;
      r.revert.hidden = !d;
      r.save.disabled = !d;
      r.title.textContent = r.label.value.trim() || name;
      updateCkptInfo();
      syncCompat();
    }
    function updateButtons() {
      const isDefault = name === store.defaultPreset;
      const only = Object.keys(store.presets).length <= 1;
      r.makeDefault.disabled = isDefault;
      r.makeDefault.title = isDefault ? '이미 기본 프리셋입니다' : '새 생성·캐릭터에서 기본으로 쓸 프리셋으로 지정합니다';
      r.del.disabled = isDefault || only;
      r.del.title = isDefault ? '기본 프리셋은 삭제할 수 없습니다. 다른 프리셋을 기본으로 지정한 뒤 삭제하세요.' : only ? '마지막 프리셋은 삭제할 수 없습니다.' : '이 프리셋을 삭제합니다';
    }

    setForm(p);
    snap = stableStringify(get());
    changed();
    updateButtons();

    el.addEventListener('input', changed);
    el.addEventListener('change', (e) => {
      if (e.target === r.ckpt) {
        const ck = ckptByName(r.ckpt.value);
        if (ck && !!ck.vpred !== !!r.vpred.checked) toast(ck.vpred ? '선택한 모델은 v-pred로 감지되었습니다. 아래 제안을 확인하세요.' : '선택한 모델은 일반(eps) 모델로 감지되었습니다.', 'info');
      }
      changed();
    });

    async function save() {
      const v = get();
      if (!v.ckpt) {
        toast('체크포인트를 선택하세요.', 'warn');
        r.ckpt.focus();
        return false;
      }
      try {
        const res = await api(`/api/presets/${encodeURIComponent(name)}`, { method: 'PUT', body: v });
        const savedP = (res && res.preset) || v;
        store.presets[name] = savedP;
        Object.assign(p, savedP);
        setForm(savedP);
        snap = stableStringify(get());
        changed();
        toast(`프리셋 '${savedP.label || name}'을(를) 저장했습니다.`, 'success');
        await loadPresets();
        loadModels();
        return true;
      } catch {
        return false;
      }
    }
    r.save.addEventListener('click', () => withBusy(r.save, save));
    r.revert.addEventListener('click', () => {
      setForm(store.presets[name] || p);
      snap = stableStringify(get());
      changed();
    });
    r.makeDefault.addEventListener('click', () => withBusy(r.makeDefault, async () => {
      try {
        await api('/api/presets/default', { method: 'POST', body: { name } });
      } catch {
        return;
      }
      toast(`'${p.label || name}'을(를) 기본 프리셋으로 지정했습니다.`, 'success');
      await loadPresets();
      loadSettings();
    }));
    r.del.addEventListener('click', () => withBusy(r.del, async () => {
      const ok = await confirmDialog({
        title: '프리셋 삭제',
        message: `프리셋 '${p.label || name}'을(를) 삭제할까요?`,
        detail: '이 프리셋을 쓰는 캐릭터는 기본 프리셋으로 생성됩니다. 체크포인트 파일은 삭제되지 않습니다.',
        confirmText: '삭제',
        danger: true,
      });
      if (!ok) return;
      let res;
      try {
        res = await api(`/api/presets/${encodeURIComponent(name)}`, { method: 'DELETE' });
      } catch {
        return;
      }
      // 서버가 이 프리셋을 쓰던 캐릭터를 기본 프리셋으로 되돌리고 그 결과를 알려 준다
      const failed = (res && Array.isArray(res.failed_characters)) ? res.failed_characters : [];
      const msg = (res && res.message) || '프리셋을 삭제했습니다.';
      toast(msg, failed.length ? 'warn' : 'success', { timeout: msg.length > 40 ? 10000 : undefined });
      snap = stableStringify(get());
      selectedPreset = '';
      // 열려 있는 캐릭터 폼이 지워진 프리셋을 다시 저장하지 않도록 먼저 알린다
      emit('preset-deleted', { name, affected: (res && Array.isArray(res.affected_characters)) ? res.affected_characters : [] });
      await loadPresets();
      loadModels();
      loadCharacters();
    }));
    r.dup.addEventListener('click', () => duplicatePreset(name, get()));

    editor = {
      name, el, get, isDirty, save,
      refresh() {
        // 모델 목록이 바뀌면 select/배지만 갱신 (편집 내용 유지)
        const cur = get();
        fillCkpt(cur.ckpt);
        fillSamplers(cur.sampler, cur.scheduler);
        lora.refresh();
        updateCkptInfo();
        updateButtons();
        r.defaultBadge.replaceChildren(name === store.defaultPreset ? badge('기본 프리셋', 'accent') : '');
      },
    };
  }

  function presetNameField(defaultName) {
    const input = h('input', { type: 'text', id: 'np-name', maxlength: '40', spellcheck: 'false', autocapitalize: 'off' });
    input.value = defaultName;
    const note = h('div', { class: 'field-note' }, '영문 소문자·숫자·-·_ (40자 이내). 캐릭터 설정과 CLI(--model)에서 이 이름으로 부릅니다.');
    const validate = () => {
      const v = input.value.trim();
      const bad = !PRESET_NAME_RE.test(v) || !!store.presets[v];
      input.classList.toggle('invalid', bad && v !== '');
      note.textContent = store.presets[v] ? `'${v}'는 이미 있는 프리셋 이름입니다.` : '영문 소문자·숫자·-·_ (40자 이내). 캐릭터 설정과 CLI(--model)에서 이 이름으로 부릅니다.';
      return !bad;
    };
    input.addEventListener('input', () => {
      const lower = input.value.toLowerCase();
      if (lower !== input.value) input.value = lower;
      validate();
    });
    return { input, note, validate };
  }

  function duplicatePreset(name, data) {
    const nf = presetNameField(uniqueName(`${name}-copy`));
    const body = h('div', {},
      h('div', { class: 'field' }, h('div', { class: 'field-label' }, h('label', { for: 'np-name' }, '새 프리셋 이름(ID)')), nf.input, nf.note));
    openModal({
      title: `'${presetLabel(name)}' 복제`,
      body, size: 'sm',
      actions: [
        { label: '취소', kind: 'ghost' },
        {
          label: '복제', kind: 'primary', onClick: async () => {
            if (!nf.validate()) {
              toast('프리셋 이름을 확인하세요.', 'warn');
              return false;
            }
            const nn = nf.input.value.trim();
            const copy = { ...deepCopy(data), label: `${data.label || name} (복사본)` };
            await api(`/api/presets/${encodeURIComponent(nn)}`, { method: 'PUT', body: copy });
            toast(`프리셋 '${nn}'을(를) 만들었습니다.`, 'success');
            await loadPresets();
            loadModels();
            selectPreset(nn, { force: true });
            return true;
          },
        },
      ],
    });
  }

  async function newPresetDialog(ckptName = '') {
    const cks = (store.models && store.models.checkpoints) || [];
    if (!cks.length) {
      toast(store.models ? '설치된 체크포인트가 없습니다. 먼저 모델을 내려받거나 models/checkpoints 폴더에 넣으세요.' : '모델 목록을 불러오는 중입니다. 잠시 후 다시 시도하세요.', 'warn');
      return;
    }
    // 새 프리셋을 만들면 편집기가 새 프리셋으로 바뀌므로, 저장하지 않은 편집 내용이 있으면 먼저 묻는다
    if (editor && editor.isDirty()) {
      const choice = await choiceDialog({
        title: '저장하지 않은 변경 사항',
        message: `프리셋 '${presetLabel(editor.name)}'의 변경 사항을 저장하지 않았습니다.`,
        detail: '새 프리셋을 만들면 편집 화면이 새 프리셋으로 바뀌어 지금 변경 내용이 사라집니다.',
        choices: [
          { label: '취소', kind: 'ghost', value: null },
          { label: '버리고 계속', kind: 'danger', value: 'discard' },
          { label: '저장 후 계속', kind: 'primary', value: 'save', autofocus: true },
        ],
      });
      if (!choice) return;
      if (choice === 'save' && !(await editor.save())) return;
    }
    const sel = h('select', { class: 'select', id: 'np-ckpt' });
    for (const c of cks) sel.append(h('option', { value: c.name }, `${stripExt(c.name)} · ${c.arch || '?'}${c.vpred ? ' · v-pred' : ''}`));
    sel.value = ckptName && cks.some((c) => c.name === ckptName) ? ckptName : cks[0].name;
    const label = h('input', { type: 'text', id: 'np-label', maxlength: '80' });
    const nf = presetNameField('');
    const detect = h('div', { class: 'suggest' });
    let labelTouched = false;
    let nameTouched = false;
    label.addEventListener('input', () => { labelTouched = true; });
    nf.input.addEventListener('input', () => { nameTouched = true; });
    const sync = () => {
      const ck = ckptByName(sel.value);
      if (!labelTouched) label.value = stripExt(basename(sel.value));
      if (!nameTouched) {
        nf.input.value = uniqueName(stripExt(basename(sel.value)));
        nf.validate();
      }
      const t = ck && ck.vpred ? PRESET_TEMPLATES.vpred : PRESET_TEMPLATES.eps;
      detect.replaceChildren(
        h('strong', {}, ck ? `감지: ${ck.arch || '알 수 없음'} · ${ck.vpred ? 'v-pred' : 'eps(일반)'}` : '감지 정보 없음'),
        h('div', { class: 'small' }, `기본값으로 채움: 샘플러 ${t.sampler} · CFG ${t.cfg} · ${t.steps}스텝${t.vpred ? ' · v-pred 켬' : ''}. 만든 뒤 모델 배포 페이지의 권장값에 맞춰 조정하세요.`));
    };
    sel.addEventListener('change', sync);
    sync();
    const body = h('div', { class: 'form-stack' },
      h('div', { class: 'field' }, h('div', { class: 'field-label' }, h('label', { for: 'np-ckpt' }, '체크포인트'), tipNode('preset_ckpt')), sel),
      detect,
      h('div', { class: 'field' }, h('div', { class: 'field-label' }, h('label', { for: 'np-label' }, '표시 이름'), tipNode('preset_label')), label),
      h('div', { class: 'field' }, h('div', { class: 'field-label' }, h('label', { for: 'np-name' }, '프리셋 이름(ID)')), nf.input, nf.note));
    openModal({
      title: '새 프리셋 만들기',
      body,
      actions: [
        { label: '취소', kind: 'ghost' },
        {
          label: '만들기', kind: 'primary', onClick: async () => {
            if (!nf.validate()) {
              toast('프리셋 이름을 확인하세요. 영문 소문자로 시작하고 중복되지 않아야 합니다.', 'warn');
              nf.input.focus();
              return false;
            }
            const ck = ckptByName(sel.value);
            const t = ck && ck.vpred ? PRESET_TEMPLATES.vpred : PRESET_TEMPLATES.eps;
            const nn = nf.input.value.trim();
            const preset = { label: label.value.trim() || stripExt(sel.value), ckpt: sel.value, ...deepCopy(t), loras: [], note: '' };
            await api(`/api/presets/${encodeURIComponent(nn)}`, { method: 'PUT', body: preset });
            toast(`프리셋 '${preset.label}'을(를) 만들었습니다. 값을 확인하고 필요하면 조정하세요.`, 'success');
            await loadPresets();
            loadModels();
            setTab('presets');
            selectPreset(nn, { force: true });
            return true;
          },
        },
      ],
    });
  }

  // ======================= 체크포인트 =======================
  function renderCheckpoints() {
    const box = $.ckptBody;
    box.replaceChildren();
    if (!store.models) {
      box.append(store.modelsError ? h('div', { class: 'grid-error' }, store.modelsError) : spinner('모델 정보를 읽는 중… (처음에는 조금 걸릴 수 있습니다)'));
      return;
    }
    const cks = store.models.checkpoints || [];
    if (!cks.length) {
      box.append(emptyState({ icon: '◇', title: '설치된 체크포인트가 없습니다', text: '[다운로드] 탭에서 URL로 받거나 models/checkpoints 폴더에 .safetensors 파일을 넣고 새로고침하세요.' }));
      return;
    }
    const table = h('table', { class: 'data-table' });
    table.innerHTML = `<thead><tr>
      <th>이름</th><th class="num">크기</th><th>아키텍처 ${tipIcon('ckpt_arch')}</th><th>예측 방식 ${tipIcon('ckpt_vpred')}</th><th>계열</th><th>사용 중인 프리셋</th><th></th>
    </tr></thead>`;
    const tb = h('tbody');
    for (const c of cks) {
      const presets = Array.isArray(c.presets) ? c.presets : Object.keys(store.presets).filter((n) => store.presets[n].ckpt === c.name);
      const pres = h('div', { class: 'chips' }, presets.length
        ? presets.map((n) => {
          const b = h('button', { type: 'button', class: 'chip chip-sm' }, presetLabel(n));
          b.addEventListener('click', () => { setTab('presets'); selectPreset(n); });
          return b;
        })
        : h('span', { class: 'muted small' }, '없음'));
      const act = h('td', { class: 'actions' });
      const mk = h('button', { type: 'button', class: `btn btn-xs ${presets.length ? 'btn-ghost' : ''}` }, presets.length ? '프리셋 추가' : '프리셋 만들기');
      mk.addEventListener('click', () => newPresetDialog(c.name));
      act.append(mk);
      tb.append(h('tr', {},
        h('td', {}, h('div', { class: 'cell-title' }, stripExt(c.name)), h('div', { class: 'cell-sub', title: c.path || '' }, c.name)),
        h('td', { class: 'num' }, fmtBytes(c.size)),
        h('td', {}, archBadge(c.arch)),
        h('td', {}, vpredBadge(c.vpred)),
        h('td', {}, c.family || h('span', { class: 'muted' }, '-')),
        h('td', {}, pres),
        act));
    }
    table.append(tb);
    box.append(h('div', { class: 'table-wrap' }, table));
    const dirs = (store.models.model_dirs && store.models.model_dirs.checkpoints) || [];
    const inst = store.models.install_dir && store.models.install_dir.checkpoints;
    box.append(h('p', { class: 'field-note' },
      inst ? `새 체크포인트는 ${inst} 에 넣으세요. ` : '',
      dirs.length ? `검색하는 폴더: ${dirs.join(' · ')}` : ''));
  }

  // ======================= LoRA =======================
  function loraMeta(l) {
    const m = l.meta || {};
    return { trigger: m.trigger || '', weight: isFinite(Number(m.weight)) ? Number(m.weight) : 0.8, note: m.note || '' };
  }
  function renderLoras() {
    const box = $.loraBody;
    box.replaceChildren();
    if (!store.models) {
      box.append(store.modelsError ? h('div', { class: 'grid-error' }, store.modelsError) : spinner('LoRA 정보를 읽는 중…'));
      return;
    }
    const all = store.models.loras || [];
    if (!all.length) {
      box.append(emptyState({ icon: '◇', title: '설치된 LoRA가 없습니다', text: '[다운로드] 탭에서 URL로 받거나 models/loras 폴더에 .safetensors 파일을 넣고 새로고침하세요.' }));
      return;
    }
    const q = loraQuery.toLowerCase();
    const list = all.filter((l) => !q || [l.name, l.title, l.base_model, (l.meta || {}).note, (l.meta || {}).trigger, ...(l.triggers || [])]
      .some((x) => String(x || '').toLowerCase().includes(q)));
    $.loraCount.textContent = `${list.length} / ${all.length}개`;
    if (!list.length) {
      box.append(h('div', { class: 'list-empty' }, '검색 결과가 없습니다.'));
      return;
    }
    const grid = h('div', { class: 'lora-grid' });
    for (const l of list) grid.append(loraCard(l));
    box.append(grid);
  }

  function loraCard(l) {
    const base = loraMeta(l);
    const cur = loraEdits.get(l.name) || { ...base };
    const id = `lc-${++loraCardSeq}`;
    const card = h('article', { class: 'lora-card' });
    const trig = h('input', { type: 'text', id: `${id}-t`, spellcheck: 'false', placeholder: '예: addmicrodetails' });
    trig.value = cur.trigger;
    const weight = rangeField({ id: `${id}-w`, min: 0, max: 1.5, step: 0.05, value: cur.weight, onInput: () => edit() });
    const note = h('input', { type: 'text', id: `${id}-n`, placeholder: '용도·권장 강도 등 메모' });
    note.value = cur.note;
    const saveBtn = h('button', { type: 'button', class: 'btn btn-xs btn-primary' }, '저장');
    const state = h('span', { class: 'small muted' });

    function edit() {
      const v = { trigger: trig.value.trim(), weight: weight.get(), note: note.value.trim() };
      const dirty = stableStringify(v) !== stableStringify(loraMeta(l));
      if (dirty) loraEdits.set(l.name, v);
      else loraEdits.delete(l.name);
      card.classList.toggle('is-dirty', dirty);
      saveBtn.disabled = !dirty;
      state.textContent = dirty ? '저장 안 됨' : '';
    }
    trig.addEventListener('input', edit);
    note.addEventListener('input', edit);
    saveBtn.addEventListener('click', () => withBusy(saveBtn, async () => {
      const v = { trigger: trig.value.trim(), weight: weight.get(), note: note.value.trim() };
      try {
        await api(`/api/loras/${encodeURIComponent(l.name)}/meta`, { method: 'PUT', body: v });
      } catch {
        return;
      }
      l.meta = { ...(l.meta || {}), ...v };
      loraEdits.delete(l.name);
      edit();
      state.textContent = '저장됨';
      toast(`'${l.title || stripExt(basename(l.name))}' 메모를 저장했습니다.`, 'success');
      // 다른 화면의 LoRA 편집기([넣기] 트리거·메모·기본 강도)를 새 값으로 다시 그린다
      emit('lora-meta', l.name);
    }));

    const compat = h('div', { class: 'chips' });
    const presets = Object.keys(store.presets);
    for (const pn of presets) {
      const c = l.compat && l.compat[pn];
      compat.append(compatBadge(c || { level: 'unknown', reason: '호환성 정보 없음 (목록을 새로고침하세요)' }, presetLabel(pn)) || '');
    }
    const auto = (l.triggers || []).filter((t) => !isRatingTag(t)).slice(0, 8);
    const trigChips = h('div', { class: 'chips' }, auto.length
      ? auto.map((t) => {
        const b = h('button', { type: 'button', class: 'chip chip-sm', 'data-tooltip': '눌러서 트리거 메모에 추가' }, t);
        b.addEventListener('click', () => {
          const parts = trig.value.split(',').map((x) => x.trim()).filter(Boolean);
          if (!parts.includes(t)) parts.push(t);
          trig.value = parts.join(', ');
          edit();
        });
        return b;
      })
      : h('span', { class: 'muted small' }, '자동 추출된 후보 없음'));

    card.append(
      h('div', { class: 'lora-card-head' },
        h('div', { class: 'lora-card-title' }, l.title || stripExt(basename(l.name))),
        h('div', { class: 'lora-card-file', title: l.path || '' }, `${l.name} · ${fmtBytes(l.size)}`)),
      h('div', { class: 'chips' },
        archBadge(l.arch),
        l.prediction ? badge(l.prediction, l.prediction === 'v-pred' ? 'warn' : 'muted', '학습 시 예측 방식') : null,
        l.family ? badge(l.family, 'muted', '학습 베이스 계열') : null,
        l.rank ? badge(`rank ${l.rank}`, 'muted', 'LoRA 차원(rank): 클수록 표현력이 크고 파일도 큼') : null),
      l.base_model ? h('div', { class: 'small muted lora-base' }, `학습 베이스: ${l.base_model}`) : '',
      h('div', { class: 'lora-card-sec' }, h('div', { class: 'sec-label' }, '트리거 후보 (자동 추출)'), trigChips),
      h('div', { class: 'lora-card-meta' },
        h('div', { class: 'field' }, h('div', { class: 'field-label' }, h('label', { for: `${id}-t` }, '트리거'), tipNode('lora_trigger')), trig),
        h('div', { class: 'field' }, h('div', { class: 'field-label' }, h('label', { for: `${id}-w` }, '기본 강도'), tipNode('lora_weight')), weight.el),
        h('div', { class: 'field' }, h('div', { class: 'field-label' }, h('label', { for: `${id}-n` }, '메모')), note),
        h('div', { class: 'lora-card-save' }, state, saveBtn)),
      h('div', { class: 'lora-card-sec' }, h('div', { class: 'sec-label' }, '프리셋별 호환성', tipNode('lora_compat')), compat));
    edit();
    if (!loraEdits.has(l.name)) state.textContent = '';
    return card;
  }

  // ======================= 다운로드 =======================
  // 진행률 이벤트(초당 4회)마다 행을 새로 만들면 [취소] 클릭이 씹히므로,
  // 행은 상태가 바뀔 때만 다시 만들고 진행 막대·글자만 고친다
  const dlRows = new Map(); // id -> {row, bar, fill, info, key}
  const dlKey = (d) => `${d.status}|${d.filename || ''}|${d.folder || ''}|${d.error || ''}`;
  function dlProgress(d) {
    const prev = dlSamples.get(d.id);
    const now = Date.now();
    let speed = prev ? prev.speed : 0;
    if (prev && d.received > prev.received && now > prev.t) {
      const inst = ((d.received - prev.received) * 1000) / (now - prev.t);
      speed = prev.speed ? prev.speed * 0.7 + inst * 0.3 : inst;
    }
    dlSamples.set(d.id, { t: now, received: d.received || 0, speed });
    const pct = d.total ? clamp((d.received / d.total) * 100, 0, 100) : 0;
    const info = [];
    info.push(d.total ? `${fmtBytes(d.received)} / ${fmtBytes(d.total)} (${Math.floor(pct)}%)` : fmtBytes(d.received || 0));
    if (d.status === 'running' && speed > 0) {
      info.push(`${fmtBytes(speed)}/s`);
      if (d.total) info.push(`남은 시간 약 ${Math.max(1, Math.round((d.total - d.received) / speed / 60))}분`);
    }
    return { pct, text: info.join(' · ') };
  }
  function patchDl(e, d) {
    const { pct, text } = dlProgress(d);
    const cls = `progress${d.status === 'running' && !d.total ? ' indeterminate' : ''}`;
    if (e.bar.className !== cls) e.bar.className = cls;
    e.fill.style.width = `${d.status === 'done' ? 100 : pct}%`;
    if (e.info.textContent !== text) e.info.textContent = text;
  }
  function dlRow(d) {
    const running = d.status === 'running';
    const stLabel = { running: '받는 중', done: '완료', error: '실패', cancelled: '취소됨' }[d.status] || d.status;
    const fill = h('div', { class: 'progress-bar' });
    const bar = h('div', { class: 'progress' }, fill);
    const infoEl = h('div', { class: 'dl-info small muted' });
    const act = h('div', { class: 'dl-actions' });
    if (running) {
      const c = h('button', { type: 'button', class: 'btn btn-xs btn-ghost' }, '취소');
      c.addEventListener('click', () => withBusy(c, async () => {
        try {
          await api(`/api/downloads/${encodeURIComponent(d.id)}/cancel`, { method: 'POST' });
          toast('다운로드를 취소했습니다.', 'info');
        } catch { /* 토스트 표시됨 */ }
      }));
      act.append(c);
    }
    const row = h('div', { class: `dl-item st-${d.status}` },
      h('div', { class: 'dl-top' },
        h('span', { class: 'dl-name' }, d.filename || '(파일 이름 확인 중)'),
        badge(FOLDER_LABELS[d.folder] || d.folder || '', 'muted'),
        h('span', { class: `status-badge st-${d.status === 'running' ? 'running' : d.status === 'done' ? 'done' : d.status === 'error' ? 'error' : 'cancelled'}` }, stLabel),
        act),
      bar,
      infoEl,
      d.error ? h('div', { class: 'job-error' }, d.error) : null);
    return { row, bar, fill, info: infoEl, key: dlKey(d) };
  }
  function renderDownloads() {
    const box = $.dlList;
    // 최신순: 서버 목록과 SSE로 새로 들어온 항목이 섞여도 순서가 일정하도록 시작 시각으로 정렬
    const list = [...store.downloads.values()].sort((a, b) => (Number(b.started) || 0) - (Number(a.started) || 0));
    if (!list.length) {
      dlRows.clear();
      box.replaceChildren(h('div', { class: 'list-empty' }, '진행 중이거나 최근에 받은 파일이 없습니다.'));
      return;
    }
    box.querySelectorAll(':scope > .list-empty').forEach((n) => n.remove());
    const keep = new Set();
    let prev = null;
    for (const d of list) {
      keep.add(d.id);
      let e = dlRows.get(d.id);
      if (!e || e.key !== dlKey(d)) {
        const ne = dlRow(d);
        if (e && e.row.parentNode === box) e.row.replaceWith(ne.row);
        e = ne;
        dlRows.set(d.id, e);
      }
      patchDl(e, d);
      const want = prev ? prev.nextSibling : box.firstChild;
      if (e.row !== want) box.insertBefore(e.row, want);
      prev = e.row;
    }
    for (const [id, e] of dlRows) {
      if (keep.has(id)) continue;
      e.row.remove();
      dlRows.delete(id);
    }
  }

  async function startDownload() {
    const url = $.dlUrl.value.trim();
    if (!/^https?:\/\//i.test(url)) {
      toast('http:// 또는 https:// 로 시작하는 다운로드 주소를 입력하세요.', 'warn');
      $.dlUrl.focus();
      return;
    }
    const filename = $.dlName.value.trim();
    if (filename && !/\.(safetensors|pth|pt|ckpt)$/i.test(filename)) {
      toast('파일 이름은 .safetensors / .pth / .pt / .ckpt 중 하나로 끝나야 합니다.', 'warn');
      $.dlName.focus();
      return;
    }
    if (!$.dlFolder.value) {
      toast('저장할 곳을 고르세요. 본체 모델(Checkpoint, 보통 2~7GB)은 체크포인트, LORA·LyCORIS(보통 10~300MB)는 LoRA입니다. 잘못 고르면 LoRA 목록에 나타나지 않습니다.', 'warn', { timeout: 9000 });
      $.dlFolder.focus();
      return;
    }
    if (/civitai\.com/i.test(url) && !tokenSaved) {
      toast('Civitai 일부 파일은 API 토큰이 필요합니다. 실패하면 아래에 토큰을 저장한 뒤 다시 시도하세요.', 'info');
    }
    const body = { url, folder: $.dlFolder.value };
    if (filename) body.filename = filename;
    try {
      // 서버는 원격 서버의 첫 응답(리디렉션 포함)을 받은 뒤에야 답하므로 기본 30초보다 넉넉히 기다린다
      const r = await api('/api/models/download', { method: 'POST', body, timeout: 150000 });
      toast(`다운로드를 시작했습니다: ${(r && r.filename) || '파일'}`, 'success');
      $.dlUrl.value = '';
      $.dlName.value = '';
      if (r && r.id) {
        const d = {
          received: 0, total: 0, status: 'running', error: null,
          ...r,
          filename: r.filename || '', folder: r.folder || body.folder, started: Number(r.started) || Date.now() / 1000,
        };
        if (!store.downloads.has(r.id)) store.downloads.set(r.id, d);
        renderDownloads();
      }
    } catch { /* 토스트 표시됨 */ }
  }

  // ======================= 전역 설정 =======================
  function buildSettings() {
    const box = $.settingsBody;
    box.replaceChildren();
    if (!store.settings) {
      box.append(spinner('설정을 불러오는 중…'));
      settingsForm = null;
      return;
    }
    const s = store.settings;
    const fields = {};
    const grid = h('div', { class: 'settings-grid' });
    const onInput = () => updateSettingsDirty();
    for (const f of SETTING_FIELDS) {
      const id = `set-${f.key}`;
      const rf = rangeField({ id, min: f.min, max: f.max, step: f.step, int: f.int, value: s[f.key] ?? SETTINGS_DEFAULTS[f.key], onInput });
      fields[f.key] = rf;
      grid.append(h('div', { class: 'field' },
        h('div', { class: 'field-label' }, h('label', { for: id }, f.label), tipNode(f.tip), h('span', { class: 'field-aside' }, `기본 ${SETTINGS_DEFAULTS[f.key]}${f.unit || ''}`)),
        rf.el));
    }
    const ups = h('select', { class: 'select', id: 'set-upscaler' });
    const upList = ((store.models && store.models.upscalers) || []).slice();
    if (s.upscaler && !upList.includes(s.upscaler)) upList.unshift(s.upscaler);
    if (!upList.length) upList.push(SETTINGS_DEFAULTS.upscaler);
    for (const u of upList) ups.append(h('option', { value: u }, u));
    ups.value = s.upscaler || upList[0];
    ups.addEventListener('change', onInput);
    grid.append(h('div', { class: 'field' },
      h('div', { class: 'field-label' }, h('label', { for: 'set-upscaler' }, '업스케일러'), tipNode('set_upscaler')),
      ups,
      store.models && store.models.upscalers && store.models.upscalers.length && !store.models.upscalers.includes(ups.value)
        ? h('div', { class: 'field-note warn-text' }, '이 업스케일러 파일을 찾을 수 없습니다. 하이레즈·업스케일이 실패할 수 있습니다.') : null));
    const auto = h('input', { type: 'checkbox', role: 'switch', id: 'set-autostart' });
    auto.checked = s.autostart_comfy !== false;
    auto.addEventListener('change', onInput);
    grid.append(h('div', { class: 'field' },
      h('div', { class: 'switch-item', 'data-tooltip': 'VN Studio를 켤 때 엔진(ComfyUI)이 꺼져 있으면 자동으로 시작합니다.' },
        h('label', { class: 'switch', for: 'set-autostart' }, auto,
          h('span', { class: 'switch-track', 'aria-hidden': 'true' }, h('span', { class: 'switch-thumb' })),
          h('span', { class: 'switch-label' }, 'Studio 시작 시 엔진 자동 시작')))));
    box.append(grid);

    // ---- 프롬프트 추출 묶음 ----
    const hasTagger = TAGGER_FIELDS.some((f) => f.key in s) || 'tagger_model' in s;
    const tfields = {};
    let tsel = null;
    const tgrid = h('div', { class: 'settings-grid' });
    box.append(h('div', { class: 'settings-group' },
      h('div', { class: 'settings-group-head' },
        h('h4', { class: 'settings-group-title' }, '프롬프트 추출'),
        h('span', { class: 'muted small' }, '이미지·3D 모델에서 태그를 뽑는 태거 설정'),
        h('a', { class: 'help-link', href: '#/help/extract', title: '도움말에서 자세히 보기' }, '? 설명')),
      tgrid));
    if (!hasTagger) {
      tgrid.append(h('div', { class: 'field-note' }, '이 Studio 서버는 아직 프롬프트 추출 설정을 지원하지 않습니다. VN Studio를 다시 시작하면 나타납니다.'));
    } else {
      const tg = store.tagger;
      const models = (tg && tg.models) || [];
      tsel = h('select', { class: 'select', id: 'set-tagger_model' });
      const names = models.map((m) => m.name);
      for (const m of models) tsel.append(h('option', { value: m.name }, m.size ? `${m.name} (${fmtBytes(m.size)})` : m.name));
      if (s.tagger_model && !names.includes(s.tagger_model)) tsel.prepend(h('option', { value: s.tagger_model }, `${s.tagger_model} (찾을 수 없음)`));
      if (!tsel.options.length) {
        tsel.append(h('option', { value: '' }, tg ? '(설치된 태거 없음)' : '(불러오는 중…)'));
        tsel.disabled = true;
      }
      tsel.value = s.tagger_model || (tg && tg.default) || (names[0] || '');
      if (tsel.selectedIndex < 0 && tsel.options.length) tsel.selectedIndex = 0;
      tsel.addEventListener('change', onInput);
      let note = null;
      if (!tg && store.taggerError) note = h('div', { class: 'field-note warn-text' }, store.taggerError);
      else if (tg && !models.length) note = h('div', { class: 'field-note warn-text' }, '설치된 태거가 없습니다. models/tagger/<이름>/ 폴더에 model.onnx와 selected_tags.csv를 넣은 뒤 이 화면을 새로고침하세요.');
      else if (tg && tg.available === false) note = h('div', { class: 'field-note warn-text' }, tg.error || '태거를 실행할 수 없습니다(onnxruntime 없음).');
      else if (s.tagger_model && !names.includes(s.tagger_model) && tg) note = h('div', { class: 'field-note warn-text' }, '설정된 태거 폴더를 찾을 수 없습니다. 다른 태거를 고르세요.');
      tgrid.append(h('div', { class: 'field' },
        h('div', { class: 'field-label' }, h('label', { for: 'set-tagger_model' }, '태거 모델'), tipNode('tagger_model')),
        tsel, note));
      for (const f of TAGGER_FIELDS) {
        const id = `set-${f.key}`;
        const rf = rangeField({ id, min: f.min, max: f.max, step: f.step, value: s[f.key] ?? SETTINGS_DEFAULTS[f.key], onInput });
        tfields[f.key] = rf;
        tgrid.append(h('div', { class: 'field' },
          h('div', { class: 'field-label' }, h('label', { for: id }, f.label), tipNode(f.tip), h('span', { class: 'field-aside' }, `기본 ${SETTINGS_DEFAULTS[f.key]}`)),
          rf.el));
      }
      if (!tg && !store.taggerError) loadTagger();
    }

    // ---- 포즈 (ControlNet) 묶음 ----
    const hasPose = POSE_FIELDS.some((f) => f.key in s) || 'pose_model' in s;
    const pfields = {};
    let psel = null;
    let pUpdDesc = () => {};
    const pgrid = h('div', { class: 'settings-grid' });
    const cnFolder = h('button', { type: 'button', class: 'btn btn-xs btn-ghost', 'data-local-only': true }, 'ControlNet 폴더 열기');
    cnFolder.addEventListener('click', () => api('/api/open-folder', { method: 'POST', body: { which: 'models_controlnet' } }).catch(() => {}));
    box.append(h('div', { class: 'settings-group' },
      h('div', { class: 'settings-group-head' },
        h('h4', { class: 'settings-group-title' }, '포즈 (ControlNet)'),
        h('span', { class: 'muted small' }, '생성 탭·캐릭터 탭에서 포즈를 붙일 때 처음 선택되는 값'),
        cnFolder,
        h('a', { class: 'help-link', href: '#/help/pose-controlnet', title: '도움말에서 자세히 보기' }, '? 설명')),
      pgrid));
    if (!hasPose) {
      pgrid.append(h('div', { class: 'field-note' }, '이 Studio 서버는 아직 포즈 설정을 지원하지 않습니다. VN Studio를 다시 시작하면 나타납니다.'));
    } else {
      const cns = store.models ? (store.models.controlnets || []) : null;
      psel = h('select', { class: 'select', id: 'set-pose_model' });
      const names = (cns || []).map((c) => c.name);
      for (const c of cns || []) {
        const opt = h('option', { value: c.name }, `${c.label || c.name}${c.size ? ` (${fmtBytes(c.size)})` : ''}`);
        opt.title = `${c.name}\n${c.style === 'thick' ? '굵은 선' : '표준 선'} 뼈대 그림 · 권장 강도 ${c.strength}`;
        psel.append(opt);
      }
      if (s.pose_model && !names.includes(s.pose_model)) psel.prepend(h('option', { value: s.pose_model }, `${s.pose_model} (찾을 수 없음)`));
      if (!psel.options.length) {
        psel.append(h('option', { value: s.pose_model || '' }, cns ? '(설치된 ControlNet 없음)' : '(불러오는 중…)'));
        psel.disabled = true;
      }
      psel.value = s.pose_model || names[0] || '';
      if (psel.selectedIndex < 0 && psel.options.length) psel.selectedIndex = 0;
      let pnote = null;
      if (cns && !cns.length) {
        pnote = h('div', { class: 'field-note warn-text' }, 'ControlNet(OpenPose) 모델이 없습니다. models/controlnet/ 폴더에 넣은 뒤 [목록 새로고침]을 누르세요. ',
          h('a', { class: 'help-link', href: '#/help/ts-controlnet' }, '? 해결'));
      } else if (cns && s.pose_model && !names.includes(s.pose_model)) {
        pnote = h('div', { class: 'field-note warn-text' }, '설정된 ControlNet 파일을 찾을 수 없습니다. 다른 모델을 고르세요.');
      }
      const descNote = h('div', { class: 'field-note' });
      const updDesc = () => {
        const c = (cns || []).find((x) => x.name === psel.value);
        descNote.textContent = c ? `${c.style === 'thick' ? '굵은 선' : '표준(얇은 선)'} 뼈대 그림을 자동으로 씁니다 · 권장 강도 ${c.strength}` : '';
      };
      updDesc();
      pUpdDesc = updDesc;
      psel.addEventListener('change', () => {
        updDesc();
        const c = (cns || []).find((x) => x.name === psel.value);
        // 기본 ControlNet을 바꾸면 기본 강도도 그 모델의 권장값으로 옮긴다
        if (c && isFinite(Number(c.strength)) && pfields.pose_strength && pfields.pose_strength.get() !== Number(c.strength)) {
          pfields.pose_strength.set(Number(c.strength));
          toast(`기본 강도를 '${c.label || c.name}'의 권장값 ${c.strength}(으)로 맞췄습니다. [저장]을 눌러야 적용됩니다.`, 'info');
        }
        onInput();
      });
      pgrid.append(h('div', { class: 'field' },
        h('div', { class: 'field-label' }, h('label', { for: 'set-pose_model' }, '기본 ControlNet'), tipNode('set_pose_model')),
        psel, descNote, pnote));
      for (const f of POSE_FIELDS) {
        const id = `set-${f.key}`;
        const rf = rangeField({ id, min: f.min, max: f.max, step: f.step, value: s[f.key] ?? SETTINGS_DEFAULTS[f.key], onInput });
        pfields[f.key] = rf;
        pgrid.append(h('div', { class: 'field' },
          h('div', { class: 'field-label' }, h('label', { for: id }, f.label), tipNode(f.tip), h('span', { class: 'field-aside' }, `기본 ${SETTINGS_DEFAULTS[f.key]}`)),
          rf.el));
      }
    }

    const get = () => {
      const out = {};
      for (const f of SETTING_FIELDS) out[f.key] = fields[f.key].get();
      out.upscaler = ups.value;
      out.autostart_comfy = !!auto.checked;
      if (hasTagger) {
        for (const f of TAGGER_FIELDS) out[f.key] = tfields[f.key].get();
        if (tsel && !tsel.disabled && tsel.value) out.tagger_model = tsel.value;
      }
      if (hasPose) {
        for (const f of POSE_FIELDS) out[f.key] = pfields[f.key].get();
        if (psel && !psel.disabled && psel.value) out.pose_model = psel.value;
      }
      return out;
    };
    const set = (v) => {
      for (const f of SETTING_FIELDS) fields[f.key].set(v[f.key] ?? SETTINGS_DEFAULTS[f.key]);
      if (v.upscaler && [...ups.options].some((o) => o.value === v.upscaler)) ups.value = v.upscaler;
      auto.checked = v.autostart_comfy !== false;
      if (hasTagger) {
        for (const f of TAGGER_FIELDS) tfields[f.key].set(v[f.key] ?? SETTINGS_DEFAULTS[f.key]);
        if (tsel && v.tagger_model && [...tsel.options].some((o) => o.value === v.tagger_model)) tsel.value = v.tagger_model;
      }
      if (hasPose) {
        for (const f of POSE_FIELDS) pfields[f.key].set(v[f.key] ?? SETTINGS_DEFAULTS[f.key]);
        if (psel && v.pose_model && [...psel.options].some((o) => o.value === v.pose_model)) {
          psel.value = v.pose_model;
          pUpdDesc();
        }
      }
    };
    settingsForm = { get, set, snap: stableStringify(get()) };
    updateSettingsDirty();
  }
  function settingsDirty() {
    return !!settingsForm && stableStringify(settingsForm.get()) !== settingsForm.snap;
  }
  function updateSettingsDirty() {
    const d = settingsDirty();
    $.setSave.disabled = !d;
    $.setRevert.hidden = !d;
    $.setDirty.hidden = !d;
  }
  async function saveSettings() {
    if (!settingsForm) return true;
    const all = settingsForm.get();
    const saved = store.settings || {};
    // 바뀐 값만 보낸다 (예: 업스케일러 파일이 없어도 다른 값은 저장되도록)
    const body = {};
    for (const [k, v] of Object.entries(all)) if (stableStringify(saved[k]) !== stableStringify(v)) body[k] = v;
    if (!Object.keys(body).length) {
      settingsForm.snap = stableStringify(settingsForm.get());
      updateSettingsDirty();
      return true;
    }
    try {
      const r = await api('/api/settings', { method: 'PUT', body });
      const ns = r && r.settings && typeof r.settings === 'object' ? r.settings : null;
      store.settings = ns || { ...(store.settings || {}), ...body };
      settingsForm.set(store.settings);
      settingsForm.snap = stableStringify(settingsForm.get());
      updateSettingsDirty();
      toast('전역 설정을 저장했습니다. 다음 생성부터 적용됩니다.', 'success');
      return true;
    } catch {
      return false;
    }
  }

  async function saveToken() {
    const v = $.token.value.trim();
    try {
      await api('/api/settings', { method: 'PUT', body: { civitai_token: v } });
    } catch {
      return false;
    }
    tokenSaved = v;
    if (store.settings) store.settings.civitai_token = v;
    updateTokenState();
    toast(v ? 'Civitai 토큰을 저장했습니다.' : 'Civitai 토큰을 지웠습니다.', 'success');
    return true;
  }
  function updateTokenState() {
    const d = $.token.value.trim() !== tokenSaved;
    $.tokenSave.disabled = !d;
    $.tokenState.textContent = d ? '저장 안 됨' : tokenSaved ? '저장됨' : '설정 안 됨';
    $.tokenState.className = `small ${d ? 'warn-text' : 'muted'}`;
  }

  // ======================= 마운트 =======================
  function mount(el) {
    el.innerHTML = `
      <div class="models-view">
        <div class="panel models-top">
          <div class="subtabs" role="tablist" data-ref="subtabs" aria-label="모델·LoRA 메뉴">
            ${SUBTABS.map(([k, label]) => `<button type="button" role="tab" class="subtab" data-tab="${k}">${esc(label)}</button>`).join('')}
          </div>
          <span class="toolbar-spacer"></span>
          <button type="button" class="btn btn-sm btn-ghost" data-ref="openCk" data-local-only>모델 폴더 열기</button>
          <button type="button" class="btn btn-sm btn-ghost" data-ref="openLo" data-local-only>LoRA 폴더 열기</button>
          <button type="button" class="btn btn-sm" data-ref="reload">목록 새로고침</button>
        </div>

        <section data-ref="sec_presets" class="models-section">
          <p class="section-intro">프리셋 = 체크포인트(모델) + 권장 샘플러·CFG·스텝 + 품질 태그 + 기본 LoRA 묶음입니다. 생성할 때 프리셋 이름만 고르면 이 값들이 함께 적용됩니다. ${helpLink('models')}</p>
          <div class="preset-layout">
            <aside class="panel preset-list-panel">
              <div class="panel-head">
                <h3 class="panel-title">프리셋</h3>
                <button type="button" class="btn btn-sm btn-primary" data-ref="newPreset">+ 새 프리셋</button>
              </div>
              <div class="preset-list" data-ref="presetList"></div>
            </aside>
            <div class="panel preset-editor" data-ref="presetEditor"></div>
          </div>
        </section>

        <section data-ref="sec_checkpoints" class="models-section" hidden>
          <p class="section-intro">체크포인트는 그림체와 품질을 결정하는 본체 모델입니다. 파일 헤더만 읽어 아키텍처(SDXL/SD1.5)와 v-pred 여부를 자동으로 감지합니다. ${helpLink('models')}</p>
          <div class="panel" data-ref="ckptBody"></div>
        </section>

        <section data-ref="sec_loras" class="models-section" hidden>
          <p class="section-intro">LoRA는 그림체·캐릭터·의상·디테일을 덧입히는 작은 추가 모델입니다. 트리거·기본 강도를 메모해 두면 생성 화면에서 바로 쓸 수 있습니다. 베이스가 다른 LoRA(예: SD1.5용)는 ❌로 표시됩니다. ${helpLink('loras')}</p>
          <div class="panel lora-toolbar">
            <input type="search" class="list-search" data-ref="loraSearch" placeholder="이름·트리거·메모 검색" aria-label="LoRA 검색">
            <span class="muted small" data-ref="loraCount"></span>
          </div>
          <div data-ref="loraBody"></div>
        </section>

        <section data-ref="sec_downloads" class="models-section" hidden>
          <p class="section-intro">Civitai·HuggingFace 등의 다운로드 주소로 모델을 바로 받아 VN-Pipeline/models 폴더에 저장합니다. 받은 뒤 목록이 자동으로 새로고침됩니다. ${helpLink('models-find', '? 모델 받는 곳')}</p>
          <div class="dl-layout">
            <form class="panel dl-form" data-ref="dlForm" novalidate autocomplete="off">
              <div class="panel-head"><h3 class="panel-title">URL로 다운로드</h3></div>
              <div class="field">
                <div class="field-label"><label for="dl-url">다운로드 주소</label>${tipIcon('download_url')}</div>
                <input type="url" id="dl-url" data-ref="dlUrl" placeholder="https://civitai.com/api/download/models/123456" spellcheck="false">
                <div class="field-note">모델 페이지 주소가 아니라 [Download] 버튼의 링크 주소(우클릭 → 링크 주소 복사)를 넣으세요. HuggingFace는 파일의 resolve 주소를 씁니다.</div>
              </div>
              <div class="grid-2">
                <div class="field">
                  <div class="field-label"><label for="dl-folder">저장할 곳</label>${tipIcon('download_folder')}</div>
                  <select id="dl-folder" class="select" data-ref="dlFolder">
                    <option value="" disabled selected>종류를 고르세요…</option>
                    <option value="checkpoints">체크포인트 (models/checkpoints)</option>
                    <option value="loras">LoRA (models/loras)</option>
                    <option value="upscale_models">업스케일러 (models/upscale_models)</option>
                  </select>
                  <div class="field-note">Civitai 페이지 오른쪽 Details의 Type을 보세요. Checkpoint → 체크포인트(보통 2~7GB), LORA·LyCORIS → LoRA(보통 10~300MB).</div>
                </div>
                <div class="field">
                  <div class="field-label"><label for="dl-name">파일 이름 (선택)</label></div>
                  <input type="text" id="dl-name" data-ref="dlName" placeholder="비우면 자동 (예: myLora_v1.safetensors)" spellcheck="false">
                </div>
              </div>
              <div class="form-actions"><button type="submit" class="btn btn-primary" data-ref="dlStart">다운로드 시작</button></div>
              <hr class="sep">
              <div class="field">
                <div class="field-label"><label for="dl-token">Civitai API 토큰 (선택)</label>${tipIcon('civitai_token')}<span class="field-aside" data-ref="tokenState"></span></div>
                <div class="input-row">
                  <input type="password" id="dl-token" data-ref="token" placeholder="로그인이 필요한 모델을 받을 때만" autocomplete="off" spellcheck="false">
                  <button type="button" class="btn btn-sm btn-ghost" data-ref="tokenShow" aria-pressed="false">보기</button>
                  <button type="button" class="btn btn-sm" data-ref="tokenSave">저장</button>
                </div>
                <div class="field-note">civitai.com → 계정 설정(Account Settings) → API Keys에서 만든 키입니다. 이 Mac의 config/settings.json에만 저장되고 civitai.com 주소에만 붙습니다.</div>
              </div>
            </form>
            <section class="panel">
              <div class="panel-head"><h3 class="panel-title">다운로드 목록</h3></div>
              <div class="dl-list" data-ref="dlList"></div>
            </section>
          </div>
        </section>

        <section data-ref="sec_settings" class="models-section" hidden>
          <p class="section-intro">모든 프리셋에 공통으로 쓰이는 품질 단계 설정입니다. 강도(denoise)는 높을수록 원본에서 많이 바뀝니다(디테일↑, 원본과 차이↑). ${helpLink('quality-settings')}</p>
          <div class="panel">
            <div class="panel-head">
              <h3 class="panel-title">전역 설정</h3>
              <div class="panel-tools">
                <span class="badge badge-warn" data-ref="setDirty" hidden>저장 안 됨</span>
                <button type="button" class="btn btn-sm btn-ghost" data-ref="setDefaults">기본값으로</button>
                <button type="button" class="btn btn-sm btn-ghost" data-ref="setRevert" hidden>되돌리기</button>
                <button type="button" class="btn btn-sm btn-primary" data-ref="setSave">저장</button>
              </div>
            </div>
            <div data-ref="settingsBody"></div>
          </div>
          <div data-ref="remoteSlot"></div>
        </section>
      </div>`;
    $ = refs(el);

    $.subtabs.addEventListener('click', (e) => {
      const b = e.target instanceof Element ? e.target.closest('[data-tab]') : null;
      if (b) setTab(b.dataset.tab);
    });
    $.subtabs.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const i = SUBTABS.findIndex(([k]) => k === tab);
      const n = SUBTABS[(i + (e.key === 'ArrowRight' ? 1 : SUBTABS.length - 1)) % SUBTABS.length][0];
      setTab(n);
      $.subtabs.querySelector(`[data-tab="${n}"]`)?.focus();
    });
    const openFolder = (which) => api('/api/open-folder', { method: 'POST', body: { which } }).catch(() => {});
    $.openCk.addEventListener('click', () => openFolder('models_checkpoints'));
    $.openLo.addEventListener('click', () => openFolder('models_loras'));
    $.reload.addEventListener('click', () => withBusy($.reload, async () => {
      await Promise.all([loadModels({ silent: false }), loadPresets()]);
      if (!store.modelsError) toast('모델 목록을 새로고침했습니다.', 'success');
    }));
    $.newPreset.addEventListener('click', () => newPresetDialog());
    $.loraSearch.addEventListener('input', debounce(() => {
      loraQuery = $.loraSearch.value.trim();
      renderLoras();
    }, 150));

    $.dlForm.addEventListener('submit', (e) => {
      e.preventDefault();
      withBusy($.dlStart, startDownload);
    });
    $.tokenShow.addEventListener('click', () => {
      const show = $.token.type === 'password';
      $.token.type = show ? 'text' : 'password';
      $.tokenShow.textContent = show ? '숨기기' : '보기';
      $.tokenShow.setAttribute('aria-pressed', show ? 'true' : 'false');
    });
    $.token.addEventListener('input', updateTokenState);
    $.tokenSave.addEventListener('click', () => withBusy($.tokenSave, saveToken));
    // 토큰 칸은 다운로드 폼 안에 있으므로 Enter가 [다운로드 시작]을 누르지 않고 토큰을 저장하게 한다
    $.token.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      if (!$.tokenSave.disabled) withBusy($.tokenSave, saveToken);
    });

    $.setSave.addEventListener('click', () => withBusy($.setSave, saveSettings));
    $.setRevert.addEventListener('click', () => {
      if (!settingsForm || !store.settings) return;
      settingsForm.set(store.settings);
      updateSettingsDirty();
    });
    $.setDefaults.addEventListener('click', () => {
      if (!settingsForm) return;
      settingsForm.set({ ...(store.settings || {}), ...SETTINGS_DEFAULTS });
      updateSettingsDirty();
      toast('기본값으로 채웠습니다. [저장]을 눌러야 적용됩니다.', 'info');
    });

    function syncToken() {
      const prevSaved = tokenSaved;
      tokenSaved = (store.settings && store.settings.civitai_token) || '';
      // 사용자가 고치고 있는 중이 아니면 저장된 값으로 맞춘다
      if ($.token.value.trim() === prevSaved) $.token.value = tokenSaved;
      updateTokenState();
    }

    // 초기 렌더
    selectedPreset = store.defaultPreset || Object.keys(store.presets)[0] || '';
    renderTabs();
    renderPresetList();
    buildPresetEditor();
    renderCheckpoints();
    renderLoras();
    renderDownloads();
    buildSettings();
    syncToken();
    if (!store.models) loadModels();
    remotePanel = createRemotePanel();
    $.remoteSlot.replaceWith(remotePanel.el);
    if (tab === 'settings') remotePanel.activate();

    on('presets', () => {
      if (!store.presets[selectedPreset]) {
        selectedPreset = store.defaultPreset || Object.keys(store.presets)[0] || '';
        buildPresetEditor();
      } else if (!editor || editor.name !== selectedPreset) {
        buildPresetEditor();
      } else if (!editor.isDirty()) {
        buildPresetEditor();
      } else {
        editor.refresh();
      }
      renderPresetList();
      renderCheckpoints();
      renderLoras();
    });
    on('models', () => {
      renderPresetList();
      if (editor) editor.refresh();
      else buildPresetEditor();
      renderCheckpoints();
      renderLoras();
      if (!settingsDirty()) buildSettings();
    });
    on('settings', () => {
      if (!settingsDirty()) buildSettings();
      syncToken();
    });
    on('tagger', () => { if (!settingsDirty()) buildSettings(); });
    on('lora-meta', () => { if (editor) editor.refresh(); });
    on('downloads', renderDownloads);
    on('download', () => renderDownloads());
  }

  function anyLoraDirty() {
    return loraEdits.size > 0;
  }

  return {
    id: 'models',
    title: '모델·LoRA',
    mount,
    show(params) {
      visible = true;
      const t = params && params[0];
      if (t && SUBTABS.some(([k]) => k === t)) setTab(t, false);
      else replaceHash(`#/models/${tab}`);
      // '#/models/settings/remote' (⋯ 메뉴·원격 배지): 원격 접속 묶음으로 바로 이동
      if (tab === 'settings' && remotePanel) {
        if (params && params[1] === 'remote') {
          replaceHash('#/models/settings');
          remotePanel.reveal();
        } else {
          remotePanel.activate();
        }
      }
    },
    hide() {
      visible = false;
    },
    isDirty() {
      if (!$) return false;
      return !!(editor && editor.isDirty()) || settingsDirty() || anyLoraDirty() || $.token.value.trim() !== tokenSaved
        || !!(remotePanel && remotePanel.isDirty());
    },
    discard() {
      if (!$) return;
      buildPresetEditor();
      buildSettings();
      loraEdits.clear();
      renderLoras();
      $.token.value = tokenSaved;
      updateTokenState();
      if (remotePanel) remotePanel.discard();
    },
    async save() {
      if (!$) return true;
      if (editor && editor.isDirty() && !(await editor.save())) return false;
      if (settingsDirty() && !(await saveSettings())) return false;
      if ($.token.value.trim() !== tokenSaved && !(await saveToken())) return false;
      if (remotePanel && remotePanel.isDirty() && !(await remotePanel.save())) return false;
      let metaSaved = false;
      for (const [name, v] of [...loraEdits]) {
        try {
          await api(`/api/loras/${encodeURIComponent(name)}/meta`, { method: 'PUT', body: v });
          const l = (store.models && store.models.loras || []).find((x) => x.name === name);
          if (l) l.meta = { ...(l.meta || {}), ...v };
          loraEdits.delete(name);
          metaSaved = true;
        } catch {
          if (metaSaved) emit('lora-meta');
          return false;
        }
      }
      renderLoras();
      if (metaSaved) emit('lora-meta');
      return true;
    },
    dirtyLabel: '모델·LoRA 설정 변경 사항',
  };
}
