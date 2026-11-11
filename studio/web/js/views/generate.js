// 생성 탭: 자유 프롬프트 생성 + 실시간 미리보기 + 최근 결과
import { h, refs, lsGet, lsSet, debounce, appendTags, splitTags, sizeWH, noPeople } from '../util.js';
import { tipIcon, tipNode, helpLink, toast, guardButton, withBusy } from '../ui.js';
import { store, on, submitJob, engineBlockReason, characterById, presetLabel, ckptByName } from '../store.js';
import {
  presetSelect, loraEditor, sizePicker, seedInput, countStepper, qualityToggles, tagHelper, jobMonitor, galleryGrid,
} from '../components.js';
import { etaText } from '../eta.js';
import { poseControl, poseGenSize, sizeKeyFor, sizeText, poseNameOf, poseTitle } from '../pose.js';
import { isPhone } from '../mobile.js';

const OPTS_KEY = 'vn.gen.opts';
const DRAFT_KEY = 'vn.gen.draft';

export function createGenerateView() {
  let $ = null;
  let preset;
  let lora;
  let size;
  let seed;
  let count;
  let quality;
  let pose;
  let monitor;
  let recent;
  let guard;
  let visible = false;
  let recentStale = false;
  let selectedChar = '';

  const currentChar = () => (selectedChar ? characterById(selectedChar) : null);
  const effectivePreset = (v) => v || (currentChar() && currentChar().model) || store.defaultPreset;

  function persist() {
    lsSet(OPTS_KEY, {
      preset: preset.get(),
      size: size.get(),
      quality: quality.get(),
      count: count.get(),
      character: selectedChar,
      pose: pose ? pose.state() : null,
    });
  }
  const saveDraft = debounce(() => {
    lsSet(DRAFT_KEY, { prompt: $.prompt.value, negative: $.negative.value, raw: $.raw.checked });
  }, 400);

  function buildSpec() {
    const spec = {
      mode: 'prompt',
      prompt: $.prompt.value.trim(),
      negative: $.negative.value.trim(),
      character: selectedChar || null,
      preset: preset.get() || null,
      loras: lora.get(),
      size: size.get(),
      count: count.get(),
      seed: seed.get(),
      ...quality.get(),
      // 캐릭터를 고르면 엔진이 품질 태그·기본 네거티브를 항상 붙이므로 raw는 캐릭터가 없을 때만 의미가 있다
      raw: !selectedChar && !!$.raw.checked,
    };
    const p = pose ? pose.get() : null;
    if (p) spec.pose = p;
    return spec;
  }

  function updateEta() {
    if (!$) return;
    $.eta.textContent = etaText(buildSpec(), { poseSize: pose ? pose.size() : null });
    const n = splitTags($.prompt.value).length;
    $.tagCount.textContent = n ? `태그 ${n}개` : '';
  }

  function renderCharacters() {
    const sel = $.character;
    sel.replaceChildren(h('option', { value: '' }, '없음 (프롬프트만 사용)'));
    for (const c of store.characters) {
      if (c.error) continue;
      sel.append(h('option', { value: c.id }, `${c.name || c.id} (${c.id})`));
    }
    if (selectedChar && !characterById(selectedChar) && store.charactersLoaded) selectedChar = '';
    if (selectedChar && !characterById(selectedChar)) sel.append(h('option', { value: selectedChar }, `${selectedChar} (불러오는 중)`));
    sel.value = selectedChar;
    updateCharNote();
  }

  // 프리셋 기본 LoRA와 캐릭터 LoRA는 LoRA 목록 밖에서 자동으로 함께 적용된다 (편집기에 안내·중복 방지)
  function inheritedLoras() {
    const out = [];
    const p = store.presets[preset ? preset.effective() : effectivePreset('')];
    for (const l of (p && p.loras) || []) if (l && l.name) out.push({ name: l.name, weight: l.weight, source: '프리셋' });
    const c = currentChar();
    for (const l of (c && c.loras) || []) if (l && l.name) out.push({ name: l.name, weight: l.weight, source: '캐릭터' });
    return out;
  }

  function updateCharNote() {
    const c = currentChar();
    if (c) {
      $.charNote.textContent = `'${c.name || c.id}'의 기본 태그·외형·의상·스타일이 프롬프트 앞에 자동으로 붙습니다. 프롬프트에는 포즈·표정·장소만 적으면 됩니다.`;
      $.charNote.hidden = false;
    } else {
      $.charNote.hidden = true;
    }
    // 캐릭터 모드에서는 '그대로 사용' 옵션이 적용되지 않으므로 잠그고 이유를 알려 준다 (체크 상태는 기억해 둠)
    const rawLocked = !!selectedChar;
    $.raw.disabled = rawLocked;
    $.rawLabel.classList.toggle('is-disabled', rawLocked);
    $.rawNote.hidden = !rawLocked || !$.raw.checked;
    if (rawLocked) {
      $.rawLabel.dataset.tooltip = '캐릭터를 선택하면 품질 태그·기본 네거티브가 항상 붙습니다. 캐릭터를 \'없음\'으로 바꾸면 쓸 수 있습니다.';
    } else {
      delete $.rawLabel.dataset.tooltip;
    }
    if (preset) preset.refresh();
    if (lora) lora.refresh();
    updatePoseArch();
  }

  // ---------- 포즈 (ControlNet) ----------
  /** 포즈(ControlNet)는 SDXL 체크포인트에서만 동작한다 → 지금 프리셋의 모델이 다르면 미리 알린다 */
  function updatePoseArch() {
    if (!pose || !preset) return;
    const p = store.presets[preset.effective()];
    const ck = p && p.ckpt ? ckptByName(p.ckpt) : null;
    const arch = ck && ck.arch;
    pose.setWarning(arch && arch !== 'SDXL' && arch !== 'unknown'
      ? `지금 프리셋의 모델(${arch})에는 포즈를 쓸 수 없습니다. 포즈(ControlNet)는 SDXL 모델(WAI·NoobAI 등)에서만 동작하니 다른 프리셋을 고르세요.`
      : '');
  }
  /** 생성 크기를 포즈 크기로 맞춘다 → 바뀌었으면 true */
  function fitSize(item) {
    const gs = poseGenSize(item);
    if (!gs) return false;
    const [cw, ch] = sizeWH(size.get());
    if (cw === gs[0] && ch === gs[1]) return false;
    const key = sizeKeyFor(gs[0], gs[1]);
    size.set(key || [gs[0], gs[1]]);
    return true;
  }
  function updateSizeNote() {
    if (!$ || !pose) return;
    const note = $.sizeNote;
    const ps = pose.size();
    note.replaceChildren();
    if (!ps) {
      note.hidden = true;
      return;
    }
    const [w, hh] = sizeWH(size.get());
    note.hidden = false;
    if (w === ps[0] && hh === ps[1]) {
      note.className = 'size-pose-note is-ok';
      note.append(h('span', { class: 'size-pose-text' }, `✓ 포즈 크기(${sizeText(ps[0], ps[1])})와 같습니다. `, tipNode('pose_fit')));
      return;
    }
    note.className = 'size-pose-note is-warn';
    const btn = h('button', { type: 'button', class: 'btn btn-xs' }, '포즈 크기로 맞추기');
    btn.addEventListener('click', () => {
      if (fitSize(pose.item())) toast(`크기를 포즈 크기(${sizeText(ps[0], ps[1])})로 맞췄습니다.`, 'info');
      persist();
      updateEta();
      updateSizeNote();
    });
    note.append(h('span', { class: 'size-pose-icon', 'aria-hidden': 'true' }, '!'),
      h('span', { class: 'size-pose-text' }, `포즈가 가운데 기준으로 잘립니다 — 포즈 ${ps[0]}×${ps[1]}, 생성 ${w}×${hh}. 비율이 많이 다르면 머리나 발이 잘릴 수 있습니다. `, tipNode('pose_fit')),
      btn);
  }
  function onPoseChange(ev) {
    if (ev && ev.reason === 'pick' && ev.item) {
      const before = size.get();
      if (fitSize(ev.item)) {
        const gs = poseGenSize(ev.item);
        toast(`포즈 크기에 맞춰 생성 크기를 '${sizeText(gs[0], gs[1])}'(으)로 바꿨습니다. 크기를 바꾸면 포즈가 가운데 기준으로 잘립니다.`, 'info', {
          action: { label: '되돌리기', onClick: () => { size.set(before); persist(); updateEta(); updateSizeNote(); } },
        });
      }
    }
    updateSizeNote();
    persist();
    updateEta();
  }
  /** 불러온 작업/이미지의 포즈 적용. 파일이 지워졌으면 알리고 포즈 없이. fitIfNoSize: 요청 크기가 비어 있던 작업이면 포즈 크기로 */
  async function loadPoseFrom(specPose, info, { fitIfNoSize = false } = {}) {
    const name = poseNameOf(specPose) || (info && info.name) || '';
    if (!name) {
      pose.clear(true);
      updateSizeNote();
      persist();
      updateEta();
      return;
    }
    const sp = specPose && typeof specPose === 'object' ? specPose : {};
    const pick = (k) => (info && info[k] != null ? info[k] : sp[k]);
    const v = { name, strength: pick('strength'), end: pick('end'), model: pick('model') };
    let st = 'missing';
    if (!(info && info.exists === false)) st = await pose.load(v, { reason: 'loaded' });
    if (st === 'missing') {
      pose.clear(true);
      toast(`이 설정에 쓴 포즈(${name})가 삭제되어 포즈 없이 불러왔습니다.`, 'warn', { timeout: 9000 });
    } else if (st === 'ok' && fitIfNoSize) {
      fitSize(pose.item());
    }
    updateSizeNote();
    persist();
    updateEta();
  }

  async function submit() {
    const text = $.prompt.value.trim();
    if (!text) {
      toast('프롬프트를 입력해 주세요. 예: 1girl, solo, school uniform, smile', 'warn');
      $.prompt.focus();
      return;
    }
    if (!seed.isValid()) {
      toast('시드는 0~4294967295 사이의 정수여야 합니다.', 'warn');
      seed.input.focus();
      return;
    }
    const reason = engineBlockReason();
    if (reason) {
      toast(reason, 'warn');
      return;
    }
    const spec = buildSpec();
    persist();
    const job = await withBusy($.submit, () => submitJob(spec));
    // 휴대폰: 폼 아래에 있는 실시간 미리보기로 내려가 진행을 바로 보여 준다
    if (job && isPhone()) $.monitorSlot.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // 불러올 프리셋: 명시한 프리셋이 있으면 그대로, 없으면 실제로 쓰인 프리셋(used)이
  // 지금의 기본값(캐릭터 기본/전역 기본)과 다를 때만 직접 지정한다 → 같은 체크포인트로 재현
  // (그 사이 삭제된 프리셋이면 지정하지 않고 기본값을 쓴다)
  const pickPreset = (explicit, used) => {
    if (explicit) return explicit;
    if (!used || used === effectivePreset('')) return '';
    return !store.presetsLoaded || store.presets[used] ? used : '';
  };

  // [생성 탭에서 편집]으로 덮어쓰기 전 상태 (토스트의 [되돌리기]용)
  function captureState() {
    return {
      prompt: $.prompt.value,
      negative: $.negative.value,
      raw: $.raw.checked,
      negOpen: $.negFold.open,
      character: selectedChar,
      preset: preset.get(),
      loras: lora.get(),
      size: size.get(),
      count: count.get(),
      seed: seed.get(),
      quality: quality.get(),
      pose: pose.state(),
    };
  }
  function restoreState(st) {
    if (!$ || !st) return;
    $.prompt.value = st.prompt;
    $.negative.value = st.negative;
    $.raw.checked = st.raw;
    selectedChar = st.character;
    renderCharacters();
    preset.set(st.preset);
    lora.set(st.loras);
    size.set(st.size);
    count.set(st.count);
    seed.set(st.seed);
    quality.set(st.quality);
    $.negFold.open = st.negOpen;
    if (st.pose) pose.load(st.pose, { reason: 'restore' });
    else pose.clear(true);
    saveDraft();
    persist();
    updateEta();
    updateSizeNote();
    helperSync();
    toast('불러오기 전의 프롬프트와 설정으로 되돌렸습니다.', 'info');
  }

  function loadFrom(payload) {
    if (!$ || !payload) return;
    const { spec, positive, negative, seed: s, preset: usedPreset } = payload;
    const before = captureState();
    // 지우기 전 내용이 있었을 때만 되돌리기를 제공 (빈 초안이면 되돌릴 것이 없음)
    const undo = before.prompt.trim() || before.negative.trim() || before.loras.length || before.pose
      ? { label: '되돌리기', onClick: () => restoreState(before) }
      : null;
    if (spec && spec.mode === 'prompt') {
      $.prompt.value = spec.prompt || '';
      $.negative.value = spec.negative || '';
      $.raw.checked = !!spec.raw;
      selectedChar = spec.character || '';
      renderCharacters();
      preset.set(pickPreset(spec.preset, usedPreset));
      lora.set(spec.loras || []);
      size.set(spec.size || 'portrait');
      count.set(1);
      seed.set(s != null ? s : spec.seed);
      quality.set(spec);
      toast(undo
        ? '이미지의 설정을 불러왔습니다. 수정한 뒤 [생성]을 누르세요. 이전에 쓰던 프롬프트는 [되돌리기]로 복구할 수 있습니다.'
        : '이미지의 설정을 불러왔습니다. 수정한 뒤 [생성]을 누르세요.', 'success', { action: undo, timeout: undo ? 12000 : undefined });
    } else {
      const text = positive || (spec && spec.prompt) || '';
      $.prompt.value = text;
      $.negative.value = negative || (spec && spec.negative) || '';
      $.raw.checked = !!positive;
      selectedChar = '';
      renderCharacters();
      preset.set(pickPreset(spec && spec.preset, usedPreset));
      lora.set((spec && spec.loras) || []);
      if (spec && spec.size) size.set(spec.size);
      count.set(1);
      seed.set(s != null ? s : null);
      if (spec) quality.set(spec);
      // 캐릭터를 고르지 않고 전체 프롬프트를 쓰므로, 캐릭터에 등록된 LoRA는 자동으로 붙지 않는다
      const src = spec && spec.character ? characterById(spec.character) : null;
      const charLoras = ((src && src.loras) || []).map((l) => l && l.name).filter(Boolean);
      const loraHint = charLoras.length
        ? ` 캐릭터 LoRA(${charLoras.join(', ')})는 포함되지 않으니 필요하면 LoRA에 추가하세요.`
        : '';
      toast(positive
        ? `전체 프롬프트를 그대로 불러왔습니다(자동 품질 태그 끔).${loraHint}`
        : '프롬프트를 불러왔습니다.', 'info', { action: undo, timeout: undo ? 12000 : positive && loraHint ? 10000 : 7000 });
    }
    if (positive || (spec && spec.negative)) $.negFold.open = !!$.negative.value || $.raw.checked;
    // 포즈: 배경 모드가 아니면 같은 포즈를 다시 붙인다(파일이 지워졌으면 알리고 포즈 없이)
    const specPose = spec && !noPeople(spec.mode) ? spec.pose : null;
    const poseInfo = payload.pose && payload.pose.name ? payload.pose : null;
    loadPoseFrom(specPose, poseInfo, { fitIfNoSize: !(spec && spec.size) });
    saveDraft();
    persist();
    updateEta();
    helperSync();
  }
  let helperSync = () => {};

  // 프롬프트 추출 탭의 [이 포즈로 생성…]·[생성 탭으로]: 포즈를 붙이고 크기를 맞춘다. 프롬프트가 같이 오면 교체(되돌리기 제공)
  async function applyPose(payload) {
    if (!$ || !payload || !payload.name) return;
    const before = captureState();
    const cur = pose.state();
    const st = await pose.load({ ...(cur || {}), name: payload.name }, { reason: 'event' });
    if (st === 'missing') {
      toast(`보낸 포즈(${payload.name})를 찾을 수 없습니다. 삭제되었을 수 있습니다.`, 'error');
      updateSizeNote();
      persist();
      return;
    }
    const item = pose.item();
    const sizeChanged = st === 'ok' && fitSize(item);
    const text = String(payload.prompt || '').trim();
    let promptNote = '';
    let rawNote = '';
    if (text) {
      const rawWasOn = $.raw.checked && !$.raw.disabled;
      if ($.raw.checked) $.raw.checked = false;
      $.prompt.value = text;
      saveDraft();
      updateCharNote();
      helperSync();
      promptNote = ' 추출한 프롬프트도 넣었습니다.';
      if (rawWasOn) rawNote = ' 자동 품질 태그·기본 네거티브 끔 설정은 해제했습니다.';
    }
    updateSizeNote();
    persist();
    updateEta();
    const changedPrompt = !!text && before.prompt.trim() && before.prompt !== text;
    const undo = changedPrompt || before.pose || sizeChanged || (text && before.raw)
      ? { label: '되돌리기', onClick: () => restoreState(before) } : null;
    const gs = poseGenSize(item);
    const c = currentChar();
    const charNote = c && text ? ` 지금 캐릭터 '${c.name || c.id}'가 선택되어 있어 그 캐릭터의 외형 태그도 함께 붙습니다.` : '';
    toast(`포즈 '${poseTitle(item) || payload.name}'를 붙였습니다.${sizeChanged && gs ? ` 생성 크기를 포즈 크기(${sizeText(gs[0], gs[1])})로 맞췄습니다.` : ''}${promptNote}${rawNote} 확인한 뒤 [생성]을 누르세요.${undo ? ' 이전 설정은 [되돌리기]로 복구할 수 있습니다.' : ''}${charNote}`, 'success', {
      title: payload.source ? `포즈 따라 그리기 · ${payload.source}` : '포즈 따라 그리기',
      action: undo, timeout: undo || charNote ? 12000 : 7000,
    });
    try {
      $.poseField.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } catch { /* 무시 */ }
  }

  // 프롬프트 추출 탭의 [생성 탭으로 보내기]: 프롬프트만 바꾸고 나머지 설정(캐릭터·프리셋·크기…)은 그대로 둔다
  function applyPrompt(payload) {
    if (!$ || !payload) return;
    const text = String(payload.prompt || '').trim();
    if (!text) return;
    const before = captureState();
    // 추출한 태그 목록에는 품질 태그·네거티브가 없으므로 '자동으로 붙이지 않기'는 끈다
    // (이미지의 [생성 탭에서 편집]으로 켜진 채 접힌 칸 안에 남아 있기 쉬움 — 되돌리기로 복구됨)
    const rawWasOn = $.raw.checked;
    const hadRaw = rawWasOn && !$.raw.disabled;
    if (rawWasOn) $.raw.checked = false;
    const undo = before.prompt.trim() || rawWasOn ? { label: '되돌리기', onClick: () => restoreState(before) } : null;
    $.prompt.value = text;
    saveDraft();
    updateEta();
    updateCharNote();
    helperSync();
    const c = currentChar();
    const charNote = c ? ` 지금 캐릭터 '${c.name || c.id}'가 선택되어 있어 그 캐릭터의 외형 태그도 함께 붙습니다. 겹치면 캐릭터를 '없음'으로 바꾸세요.` : '';
    const rawNote = hadRaw ? ' 자동 품질 태그·기본 네거티브 끔 설정은 해제했습니다.' : '';
    toast(`추출한 프롬프트를 넣었습니다. 확인한 뒤 [생성]을 누르세요.${rawNote}${undo ? ` 이전 ${before.prompt.trim() ? '프롬프트' : '설정'}는 [되돌리기]로 복구할 수 있습니다.` : ''}${charNote}`, 'success', {
      title: payload.source ? `프롬프트 추출 · ${payload.source}` : '프롬프트 추출',
      action: undo, timeout: undo || c ? 12000 : undefined,
    });
  }

  function mount(el) {
    el.innerHTML = `
      <div class="gen-layout">
        <form class="panel gen-form" data-ref="form" novalidate autocomplete="off">
          <div class="panel-head">
            <h2 class="panel-title">이미지 생성</h2>
            <div class="panel-tools">${helpLink('workflow', '? 작업 흐름')}${helpLink('prompt', '? 프롬프트 작성법')}</div>
          </div>
          <div class="field">
            <div class="field-label">
              <label for="gen-prompt">프롬프트</label>${tipIcon('prompt')}
              <span class="field-aside"><kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>Enter</kbd> 생성</span>
            </div>
            <textarea id="gen-prompt" data-ref="prompt" rows="5" spellcheck="false" placeholder="예: 1girl, solo, maid, black hair, twintails, holding tray, cafe, smile"></textarea>
            <div class="prompt-tools">
              <button type="button" class="btn btn-xs btn-ghost" data-ref="helperToggle" aria-expanded="false">＃ 프롬프트 도우미</button>
              <a class="btn btn-xs btn-ghost" href="#/extract" data-tooltip="참고 이미지나 3D 캐릭터 모델에서 태그를 자동으로 뽑아 프롬프트를 만듭니다 (프롬프트 추출 탭)">이미지·3D에서 가져오기</a>
              <button type="button" class="btn btn-xs btn-ghost" data-ref="clearPrompt">지우기</button>
              <span class="prompt-count" data-ref="tagCount"></span>
            </div>
            <div class="helper-slot" data-ref="helperSlot" hidden></div>
          </div>
          <details class="fold" data-ref="negFold">
            <summary>추가 네거티브 · 고급 옵션</summary>
            <div class="fold-body">
              <div class="field">
                <div class="field-label"><label for="gen-negative">추가 네거티브</label>${tipIcon('negative')}</div>
                <textarea id="gen-negative" data-ref="negative" rows="2" spellcheck="false" placeholder="예: hat, glasses — 나오지 않았으면 하는 요소 (프리셋 기본 네거티브 뒤에 덧붙음)"></textarea>
              </div>
              <label class="check" data-ref="rawLabel"><input type="checkbox" data-ref="raw"><span>품질 태그·기본 네거티브를 자동으로 붙이지 않기 (프롬프트를 그대로 사용)</span></label>
              <div class="field-note" data-ref="rawNote" hidden>캐릭터를 선택한 상태에서는 이 옵션이 적용되지 않습니다. 캐릭터 태그와 함께 프리셋의 품질 태그·기본 네거티브가 항상 붙습니다.</div>
            </div>
          </details>
          <div class="grid-2">
            <div class="field">
              <div class="field-label"><label for="gen-character">캐릭터</label>${tipIcon('character')}</div>
              <select id="gen-character" class="select" data-ref="character"></select>
              <div class="field-note" data-ref="charNote" hidden></div>
            </div>
            <div class="field">
              <div class="field-label"><label for="gen-preset">모델 프리셋</label>${tipIcon('preset')}${helpLink('models')}</div>
              <div data-ref="presetSlot"></div>
            </div>
          </div>
          <div class="field">
            <div class="field-label"><span class="label">LoRA</span>${tipIcon('lora')}${helpLink('loras')}</div>
            <div data-ref="loraSlot"></div>
          </div>
          <div class="field pose-group" data-ref="poseField">
            <div class="field-label"><span class="label">포즈 (ControlNet)</span>${tipIcon('pose')}${helpLink('pose')}</div>
            <div data-ref="poseSlot"></div>
          </div>
          <div class="field">
            <div class="field-label"><span class="label">크기</span>${tipIcon('size')}</div>
            <div data-ref="sizeSlot"></div>
            <div class="size-pose-note" data-ref="sizeNote" role="status" hidden></div>
          </div>
          <div class="grid-2">
            <div class="field">
              <div class="field-label"><label for="gen-count">장수</label>${tipIcon('count')}</div>
              <div data-ref="countSlot"></div>
            </div>
            <div class="field">
              <div class="field-label"><label for="gen-seed">시드</label>${tipIcon('seed')}</div>
              <div data-ref="seedSlot"></div>
            </div>
          </div>
          <div class="field">
            <div class="field-label"><span class="label">품질</span>${helpLink('quality')}</div>
            <div data-ref="qualitySlot"></div>
          </div>
          <div class="submit-bar">
            <div class="submit-info">
              <div class="eta" data-ref="eta"></div>
              <div class="guard-reason" data-ref="reason" hidden></div>
            </div>
            <button type="submit" class="btn btn-primary btn-lg" data-ref="submit">생성</button>
          </div>
        </form>
        <div class="gen-side">
          <div data-ref="monitorSlot"></div>
          <section class="panel">
            <div class="panel-head">
              <h3 class="panel-title">최근 결과</h3>
              <a class="link" href="#/gallery">갤러리에서 모두 보기 →</a>
            </div>
            <div data-ref="recentSlot"></div>
          </section>
        </div>
      </div>`;
    $ = refs(el);

    const opts = lsGet(OPTS_KEY, {}) || {};
    const draft = lsGet(DRAFT_KEY, {}) || {};
    selectedChar = typeof opts.character === 'string' ? opts.character : '';

    preset = presetSelect({
      id: 'gen-preset',
      allowDefault: true,
      defaultLabel: () => {
        const c = currentChar();
        if (c && c.model) return `캐릭터 기본값 (${presetLabel(c.model)})`;
        return `기본 프리셋 (${presetLabel(store.defaultPreset) || '불러오는 중'})`;
      },
      resolve: effectivePreset,
      onChange: () => {
        lora.refresh();
        updatePoseArch();
        persist();
        updateEta();
      },
    });
    preset.set(typeof opts.preset === 'string' ? opts.preset : '');
    $.presetSlot.append(preset.el);

    lora = loraEditor({
      getPreset: () => preset.effective(),
      inherited: inheritedLoras,
      triggerTarget: '프롬프트',
      onTrigger: (t) => {
        appendTags($.prompt, t);
        toast(`트리거 '${t}'를 프롬프트에 넣었습니다.`, 'success');
      },
    });
    $.loraSlot.append(lora.el);

    size = sizePicker({ value: opts.size || 'portrait', idPrefix: 'gen-size', onChange: () => { persist(); updateEta(); updateSizeNote(); } });
    $.sizeSlot.append(size.el);
    pose = poseControl({ idPrefix: 'gen-pose', variant: 'full', onChange: onPoseChange });
    $.poseSlot.append(pose.el);
    count = countStepper({ id: 'gen-count', value: opts.count || 1, min: 1, max: 16, onChange: () => { persist(); updateEta(); } });
    $.countSlot.append(count.el);
    seed = seedInput({ id: 'gen-seed', onChange: updateEta });
    $.seedSlot.append(seed.el);
    quality = qualityToggles({ value: opts.quality || {}, idPrefix: 'gen-q', onChange: () => { persist(); updateEta(); } });
    $.qualitySlot.append(quality.el);
    // 지난번에 고른 포즈 (모든 입력을 만든 뒤 — 확인이 끝나면 persist·updateEta가 불린다)
    if (opts.pose && opts.pose.name) pose.load(opts.pose, { reason: 'restore' });
    updatePoseArch();

    $.prompt.value = typeof draft.prompt === 'string' ? draft.prompt : '';
    $.negative.value = typeof draft.negative === 'string' ? draft.negative : '';
    $.raw.checked = !!draft.raw;
    if ($.negative.value || $.raw.checked) $.negFold.open = true;

    let helper = null;
    $.helperToggle.addEventListener('click', () => {
      if (!helper) {
        helper = tagHelper({ textarea: $.prompt });
        helperSync = helper.sync;
        $.helperSlot.append(helper.el);
      }
      const open = $.helperSlot.hidden;
      $.helperSlot.hidden = !open;
      $.helperToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      $.helperToggle.classList.toggle('active', open);
      lsSet('vn.gen.helper', open);
    });
    if (lsGet('vn.gen.helper', false)) $.helperToggle.click();

    $.clearPrompt.addEventListener('click', () => {
      if (!$.prompt.value) return;
      const prev = $.prompt.value;
      $.prompt.value = '';
      $.prompt.dispatchEvent(new Event('input', { bubbles: true }));
      toast('프롬프트를 지웠습니다.', 'info', {
        action: { label: '되돌리기', onClick: () => { $.prompt.value = prev; $.prompt.dispatchEvent(new Event('input', { bubbles: true })); } },
      });
    });

    for (const ta of [$.prompt, $.negative]) {
      ta.addEventListener('input', () => { saveDraft(); updateEta(); });
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          submit();
        }
      });
    }
    $.raw.addEventListener('change', saveDraft);
    $.character.addEventListener('change', () => {
      selectedChar = $.character.value;
      updateCharNote();
      persist();
    });
    $.form.addEventListener('submit', (e) => {
      e.preventDefault();
      submit();
    });
    // 태그 검색·LoRA 강도·장수·시드·크기 칸에서 Enter를 누르면 브라우저가 폼을 제출(=생성)해 버리므로 막는다.
    // 숫자 칸은 'change'에서 값을 확정하므로 대신 change를 보내 준다. 생성은 [생성] 버튼이나 ⌘/Ctrl+Enter로만.
    $.form.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.isComposing) return;
      const t = e.target;
      if (!(t instanceof HTMLInputElement)) return;
      e.preventDefault();
      if (t.type !== 'checkbox' && t.type !== 'radio') t.dispatchEvent(new Event('change', { bubbles: true }));
    });

    guard = guardButton($.submit, $.reason);
    guard.update(engineBlockReason());

    monitor = jobMonitor({
      variant: 'large',
      title: '실시간 미리보기',
      emptyTitle: '진행 중인 작업이 없습니다',
      emptyText: '왼쪽에서 프롬프트를 입력하고 [생성]을 누르면 이곳에 진행 단계와 실시간 미리보기가 나타납니다.',
    });
    $.monitorSlot.append(monitor.el);

    recent = galleryGrid({
      pageSize: 12,
      gridClass: 'thumb-grid-sm',
      emptyTitle: '아직 만든 이미지가 없습니다',
      emptyText: '첫 이미지를 만들면 여기에 최근 결과가 쌓입니다.',
    });
    $.recentSlot.append(recent.el);
    recent.reload();

    renderCharacters();
    updateEta();

    const reloadRecent = debounce(() => {
      if (visible) recent.reload();
      else recentStale = true;
    }, 600);

    on('status', () => { guard.update(engineBlockReason()); monitor.update(); });
    on('sse', () => { guard.update(engineBlockReason()); monitor.update(); });
    on('presets', () => { preset.refresh(); lora.refresh(); updatePoseArch(); updateEta(); });
    on('models', () => { lora.refresh(); updatePoseArch(); });
    on('settings', () => { updateEta(); });
    on('lora-meta', () => lora.refresh());
    on('characters', renderCharacters);
    on('jobs', () => monitor.update());
    on('job-removed', () => monitor.update());
    on('preview', () => monitor.update());
    on('job', (job, prev) => {
      monitor.update();
      if (job.status === 'done' && (!prev || prev.status !== 'done')) reloadRecent();
    });
    on('tick', () => { if (visible) monitor.tick(); });
    on('gallery-changed', reloadRecent);
    if (pendingLoad) {
      const p = pendingLoad;
      pendingLoad = null;
      loadFrom(p);
    }
    if (pendingPrompt) {
      const p = pendingPrompt;
      pendingPrompt = null;
      applyPrompt(p);
    }
    if (pendingPose) {
      const p = pendingPose;
      pendingPose = null;
      applyPose(p);
    }
  }

  // 아직 탭을 연 적이 없어도 라이트박스의 "생성 탭에서 편집"을 받을 수 있게 미리 구독
  let pendingLoad = null;
  on('generate:load', (p) => {
    if ($) loadFrom(p);
    else pendingLoad = p;
  });
  // 프롬프트 추출 탭 → 프롬프트만 교체 (탭을 연 적이 없으면 처음 열 때 적용)
  let pendingPrompt = null;
  on('generate:prompt', (p) => {
    if ($) applyPrompt(p);
    else pendingPrompt = p;
  });
  // 프롬프트 추출 탭 → 포즈(+ 추출한 프롬프트) {name, prompt?, source?} (탭을 연 적이 없으면 처음 열 때 적용)
  let pendingPose = null;
  on('generate:pose', (p) => {
    if (!p || !p.name) return;
    if ($) applyPose(p);
    else pendingPose = p;
  });

  return {
    id: 'generate',
    title: '생성',
    mount,
    show() {
      visible = true;
      if (recentStale) {
        recentStale = false;
        recent.reload();
      }
      monitor.update();
    },
    hide() {
      visible = false;
    },
    isDirty: () => false,
  };
}
