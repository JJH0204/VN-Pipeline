// 스프라이트 시트 탭: 캐릭터 1명 → 동작(대기·걷기·달리기·공격·줍기·쓰러짐·휴식) × 4방향 애니메이션 시트
// 줄 하나(동작 × 방향)의 프레임을 OpenPose 포즈 맵으로 나란히 놓고 한 장으로 그려 프레임끼리 캐릭터를 맞춘다.
// 줄들은 같은 시드·캐릭터 프롬프트로 그린 뒤 배경을 지우고(선택: 도트화) 한 장의 격자 시트로 쌓는다.
import { h, refs, lsGet, lsSet, debounce } from '../util.js';
import { tipIcon, helpLink, toast, guardButton, withBusy } from '../ui.js';
import { store, on, submitJob, engineBlockReason, loadCharacters, characterById } from '../store.js';
import { presetSelect, seedInput, qualityToggles, jobMonitor, galleryGrid } from '../components.js';
import { etaText, sheetGens } from '../eta.js';
import { isPhone } from '../mobile.js';
import { segPicker, switchToggle } from './pixel.js';

const OPTS_KEY = 'vn.sheet.opts';
const NAME_RE = /^[0-9A-Za-z가-힣_-]{1,40}$/;
export const SHEET_MOTIONS = [
  ['idle', '대기'], ['walk', '걷기'], ['run', '달리기'], ['attack', '공격'],
  ['pickup', '줍기'], ['down', '쓰러짐'], ['rest', '휴식'],
];
export const SHEET_DIRS = [['down', '↓ 아래 (정면)'], ['left', '← 왼쪽'], ['right', '→ 오른쪽'], ['up', '↑ 위 (뒷모습)']];
const CELL = { 4: [384, 576], 6: [336, 504] };
const PX_WIDTHS = [0, 32, 48, 64, 96, 128];
const MAX_ROWS = 28;

export function createSheetView() {
  let $ = null;
  let preset;
  let seed;
  let quality;
  let frames;
  let pxWidth;
  let colors;
  let mirror;
  let transparent;
  let monitor;
  let results;
  let guard;
  let visible = false;
  let stale = false;
  let selectedChar = '';
  const motionBoxes = {};
  const dirBoxes = {};

  const checked = (boxes) => Object.keys(boxes).filter((k) => boxes[k].checked);
  function buildSpec() {
    const pw = pxWidth.get();
    return {
      mode: 'sheet',
      character: selectedChar || null,
      prompt: $.prompt.value.trim(),
      negative: $.negative.value.trim(),
      name: $.name.value.trim() || selectedChar || 'sheet',
      preset: preset.get() || null,
      count: 1,
      seed: seed.get(),
      hires: quality.get().hires,
      face: false,
      hands: false,
      sheet: {
        motions: SHEET_MOTIONS.map(([v]) => v).filter((v) => motionBoxes[v].checked),
        directions: SHEET_DIRS.map(([v]) => v).filter((v) => dirBoxes[v].checked),
        frames: frames.get(),
        mirror: mirror.get(),
        transparent: transparent.get(),
        pixel: pw ? { width: pw, colors: colors.get() } : null,
      },
    };
  }
  function persist() {
    lsSet(OPTS_KEY, {
      character: selectedChar, preset: preset.get(), prompt: $.prompt.value, name: $.name.value,
      negative: $.negative.value, hires: quality.get().hires, motions: checked(motionBoxes), dirs: checked(dirBoxes),
      frames: frames.get(), px: pxWidth.get(), colors: colors.get(), mirror: mirror.get(), transparent: transparent.get(),
    });
  }
  const persistLater = debounce(persist, 400);

  function refresh() {
    if (!$) return;
    const spec = buildSpec();
    const sh = spec.sheet;
    const rows = sh.motions.length * sh.directions.length;
    const gens = sheetGens(sh);
    const genRows = gens.rows + gens.frames;
    let [cw, ch] = CELL[sh.frames];
    if (spec.hires) [cw, ch] = [Math.floor(cw * 1.5 / 8) * 8, Math.floor(ch * 1.5 / 8) * 8];
    if (sh.pixel) [cw, ch] = [sh.pixel.width, Math.max(1, Math.round(ch * sh.pixel.width / cw))];
    const bad = !rows || rows > MAX_ROWS;
    $.layoutNote.classList.toggle('is-error', bad);
    $.layoutNote.textContent = !rows
      ? '동작과 방향을 1개 이상 고르세요.'
      : rows > MAX_ROWS
        ? `${rows}줄 — 한 시트는 ${MAX_ROWS}줄까지입니다. 나눠서 만드세요.`
        : `시트: ${sh.frames}열 × ${rows}줄, 칸 ${cw}×${ch}px → 전체 ${cw * sh.frames}×${ch * rows}px · 생성 ${genRows}회`;
    $.eta.textContent = rows && !bad ? etaText(spec) : '';
    colors.el.classList.toggle('is-disabled', !sh.pixel);
    const c = selectedChar ? characterById(selectedChar) : null;
    $.charNote.textContent = c
      ? `캐릭터의 외형·의상·모델·LoRA를 씁니다. 아래 칸은 추가 태그입니다 (예: holding sword, chibi).`
      : '캐릭터 없이 쓰려면 아래 칸에 외형을 적으세요 (예: 1girl, knight, silver armor, long blonde hair).';
    $.prompt.placeholder = c ? '추가 태그 (선택). 예: chibi, holding sword' : '예: 1girl, knight, silver armor, long blonde hair, blue cape';
  }
  function changed() { persist(); refresh(); }
  function validName() {
    const v = $.name.value.trim();
    const ok = !v || NAME_RE.test(v);
    $.name.classList.toggle('invalid', !ok);
    $.nameNote.textContent = ok
      ? `저장 위치: output/sheets/${v || selectedChar || 'sheet'}_<칸 가로>x<칸 세로>_<열>x<줄>_seed<시드>_00001_.png`
      : '영문·숫자·한글·-·_ 만 쓸 수 있습니다. 다른 문자는 _로 바뀌어 저장됩니다.';
    return ok;
  }
  function renderCharacters() {
    const sel = $.character;
    sel.replaceChildren(h('option', { value: '' }, '없음 (외형 직접 입력)'));
    for (const c of store.characters) {
      if (c.error) continue;
      sel.append(h('option', { value: c.id }, `${c.name || c.id} (${c.id})`));
    }
    if (selectedChar && !characterById(selectedChar) && store.charactersLoaded) selectedChar = '';
    sel.value = selectedChar;
    validName();
    refresh();
  }

  async function submit() {
    const spec = buildSpec();
    if (!spec.character && !spec.prompt) {
      toast('캐릭터를 고르거나 캐릭터 외형을 입력하세요.', 'warn');
      $.prompt.focus();
      return;
    }
    const rows = spec.sheet.motions.length * spec.sheet.directions.length;
    if (!rows) {
      toast('동작과 방향을 1개 이상 고르세요.', 'warn');
      return;
    }
    if (rows > MAX_ROWS) {
      toast(`한 시트는 ${MAX_ROWS}줄(동작 × 방향)까지입니다.`, 'warn');
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
    persist();
    const job = await withBusy($.submit, () => submitJob(spec));
    if (job && isPhone()) $.monitorSlot.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function checkRow(slot, items, saved, idPrefix) {
    const boxes = {};
    for (const [v, label] of items) {
      const id = `${idPrefix}-${v}`;
      const box = h('input', { type: 'checkbox', id });
      box.checked = saved.includes(v);
      box.addEventListener('change', changed);
      boxes[v] = box;
      slot.append(h('label', { class: 'check-chip', for: id }, box, h('span', {}, label)));
    }
    return boxes;
  }

  function mount(el) {
    el.innerHTML = `
      <div class="gen-layout">
        <form class="panel gen-form" data-ref="form" novalidate autocomplete="off">
          <div class="panel-head">
            <h2 class="panel-title">스프라이트 시트 만들기</h2>
            <div class="panel-tools">${helpLink('sheet', '? 스프라이트 시트')}</div>
          </div>
          <p class="panel-sub">게임 캐릭터의 걷기·달리기·공격 같은 동작을 4방향 애니메이션 프레임으로 만들어 한 장의 격자 시트(투명 PNG)로 저장합니다. 프레임마다 정해진 포즈(ControlNet)를 따라 그리고, 한 동작의 프레임은 한 장에 함께 그려 캐릭터를 맞춥니다.</p>
          <div class="field">
            <div class="field-label"><label for="sh-character">캐릭터</label>${tipIcon('sheet_character')}</div>
            <select id="sh-character" class="select" data-ref="character"></select>
            <div class="field-note" data-ref="charNote"></div>
          </div>
          <div class="field">
            <div class="field-label"><label for="sh-prompt">외형 / 추가 태그</label>${tipIcon('sheet_prompt')}<span class="field-aside"><kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>Enter</kbd> 생성</span></div>
            <textarea id="sh-prompt" data-ref="prompt" rows="3" spellcheck="false"></textarea>
          </div>
          <div class="field">
            <div class="field-label"><span class="label">동작 (줄)</span>${tipIcon('sheet_motions')}</div>
            <div class="chip-row" data-ref="motionSlot"></div>
          </div>
          <div class="field">
            <div class="field-label"><span class="label">방향</span>${tipIcon('sheet_dirs')}</div>
            <div class="chip-row" data-ref="dirSlot"></div>
            <div data-ref="mirrorSlot"></div>
          </div>
          <div class="grid-2">
            <div class="field">
              <div class="field-label"><span class="label">동작당 프레임</span>${tipIcon('sheet_frames')}</div>
              <div data-ref="framesSlot"></div>
            </div>
            <div class="field">
              <div data-ref="transSlot"></div>
            </div>
          </div>
          <div class="field">
            <div class="field-label"><span class="label">도트화 (칸 가로 픽셀)</span>${tipIcon('sheet_pixel')}</div>
            <div data-ref="pxSlot"></div>
            <div data-ref="colorsSlot" style="margin-top:6px"></div>
            <div class="field-note" data-ref="layoutNote"></div>
          </div>
          <div class="grid-2">
            <div class="field">
              <div class="field-label"><label for="sh-name">파일 이름</label>${tipIcon('sheet_name')}</div>
              <input type="text" id="sh-name" data-ref="name" placeholder="비우면 캐릭터 ID" maxlength="40" spellcheck="false" autocapitalize="off">
              <div class="field-note" data-ref="nameNote"></div>
            </div>
            <div class="field">
              <div class="field-label"><label for="sh-preset">모델 프리셋</label>${tipIcon('preset')}${helpLink('models')}</div>
              <div data-ref="presetSlot"></div>
            </div>
          </div>
          <details class="fold" data-ref="negFold">
            <summary>추가 네거티브</summary>
            <div class="fold-body">
              <div class="field">
                <div class="field-label"><label for="sh-negative">추가 네거티브</label>${tipIcon('negative')}</div>
                <textarea id="sh-negative" data-ref="negative" rows="2" spellcheck="false" placeholder="예: weapon, hat"></textarea>
              </div>
            </div>
          </details>
          <div class="grid-2">
            <div class="field">
              <div class="field-label"><label for="sh-seed">시드</label>${tipIcon('seed')}</div>
              <div data-ref="seedSlot"></div>
            </div>
            <div class="field">
              <div class="field-label"><span class="label">품질</span>${helpLink('quality')}</div>
              <div data-ref="qualitySlot"></div>
            </div>
          </div>
          <div class="submit-bar">
            <div class="submit-info">
              <div class="eta" data-ref="eta"></div>
              <div class="guard-reason" data-ref="reason" hidden></div>
            </div>
            <button type="submit" class="btn btn-primary btn-lg" data-ref="submit">시트 생성</button>
          </div>
        </form>
        <div class="gen-side">
          <div data-ref="monitorSlot"></div>
          <section class="panel">
            <div class="panel-head">
              <h3 class="panel-title">스프라이트 시트 결과</h3>
              <div class="panel-tools"><button type="button" class="btn btn-sm btn-ghost" data-ref="refresh">새로고침</button></div>
            </div>
            <div data-ref="resultsSlot"></div>
          </section>
        </div>
      </div>`;
    $ = refs(el);
    const opts = lsGet(OPTS_KEY, {}) || {};
    selectedChar = typeof opts.character === 'string' ? opts.character : '';

    Object.assign(motionBoxes, checkRow($.motionSlot, SHEET_MOTIONS, Array.isArray(opts.motions) ? opts.motions : ['walk'], 'sh-m'));
    Object.assign(dirBoxes, checkRow($.dirSlot, SHEET_DIRS, Array.isArray(opts.dirs) ? opts.dirs : ['down', 'left', 'right', 'up'], 'sh-d'));
    mirror = switchToggle({ id: 'sh-mirror', label: '왼쪽은 오른쪽을 좌우 반전 (빠르고 일관됨)', value: opts.mirror !== false, onChange: changed });
    $.mirrorSlot.append(mirror.el);
    frames = segPicker({ label: '프레임', items: [[4, '4'], [6, '6']], value: Number(opts.frames) || 4, onChange: changed });
    $.framesSlot.append(frames.el);
    transparent = switchToggle({ id: 'sh-trans', label: '투명 배경', value: opts.transparent !== false, onChange: changed });
    $.transSlot.append(transparent.el);
    pxWidth = segPicker({
      label: '도트화', items: PX_WIDTHS.map((w) => [w, w ? `${w}` : '안 함']),
      value: PX_WIDTHS.includes(Number(opts.px)) ? Number(opts.px) : 0, onChange: changed,
    });
    $.pxSlot.append(pxWidth.el);
    colors = segPicker({ label: '색 수', items: [16, 24, 32, 48, 64].map((c) => [c, `${c}색`]), value: Number(opts.colors) || 32, onChange: changed });
    colors.el.classList.add('seg-sm');
    $.colorsSlot.append(colors.el);

    preset = presetSelect({ id: 'sh-preset', allowDefault: true, onChange: changed });
    preset.set(typeof opts.preset === 'string' ? opts.preset : '');
    $.presetSlot.append(preset.el);
    seed = seedInput({ id: 'sh-seed', onChange: refresh });
    $.seedSlot.append(seed.el);
    const off = '스프라이트 시트는 정해진 포즈를 따르고 크기가 작아 얼굴·손 보정을 하지 않습니다.';
    quality = qualityToggles({ value: { hires: opts.hires === true }, idPrefix: 'shq', disabled: { face: off, hands: off }, onChange: changed });
    $.qualitySlot.append(quality.el);

    $.prompt.value = typeof opts.prompt === 'string' ? opts.prompt : '';
    $.name.value = typeof opts.name === 'string' ? opts.name : '';
    $.negative.value = typeof opts.negative === 'string' ? opts.negative : '';
    if ($.negative.value) $.negFold.open = true;

    $.character.addEventListener('change', () => { selectedChar = $.character.value; validName(); changed(); });
    renderCharacters();
    if (!store.charactersLoaded) loadCharacters();

    for (const ta of [$.prompt, $.negative]) {
      ta.addEventListener('input', () => { persistLater(); refresh(); });
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          submit();
        }
      });
    }
    $.name.addEventListener('input', () => { validName(); persistLater(); });
    $.form.addEventListener('submit', (e) => {
      e.preventDefault();
      submit();
    });
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
      variant: 'compact',
      title: '스프라이트 시트 작업',
      filter: (j) => !!j.spec && j.spec.mode === 'sheet',
      emptyTitle: '진행 중인 스프라이트 시트 작업이 없습니다',
    });
    $.monitorSlot.append(monitor.el);

    results = galleryGrid({
      params: { folder: 'sheets', kind: 'sheet' },
      pageSize: 24,
      gridClass: 'thumb-grid-wide',
      infinite: true,
      emptyTitle: '아직 만든 스프라이트 시트가 없습니다',
      emptyText: '왼쪽에서 캐릭터와 동작을 고르고 [시트 생성]을 누르세요.',
    });
    $.resultsSlot.append(results.el);
    results.reload();
    $.refresh.addEventListener('click', () => results.reload());
    refresh();

    const reload = debounce(() => {
      if (visible) results.reload();
      else stale = true;
    }, 700);
    on('characters', renderCharacters);
    on('status', () => { guard.update(engineBlockReason()); monitor.update(); });
    on('sse', () => { guard.update(engineBlockReason()); monitor.update(); });
    on('presets', () => preset.refresh());
    on('jobs', () => monitor.update());
    on('job-removed', () => monitor.update());
    on('preview', () => monitor.update());
    on('job', (job, prev) => {
      monitor.update();
      if (job.spec && job.spec.mode === 'sheet' && job.status === 'done' && (!prev || prev.status !== 'done')) reload();
    });
    on('tick', () => { if (visible) monitor.tick(); });
    on('gallery-changed', reload);
  }

  return {
    id: 'sheet',
    title: '스프라이트 시트',
    mount,
    show() {
      visible = true;
      if (stale) {
        stale = false;
        results.reload();
      }
      monitor.update();
    },
    hide() {
      visible = false;
    },
    isDirty: () => false,
  };
}
