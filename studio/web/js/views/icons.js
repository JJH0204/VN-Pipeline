// 아이콘 탭: 게임 UI 아이콘 세트 생성 (한 줄에 아이콘 하나, 세트 전체가 같은 시드·스타일) + 결과 갤러리(icons)
import { h, refs, lsGet, lsSet, debounce } from '../util.js';
import { tipIcon, helpLink, toast, guardButton, withBusy } from '../ui.js';
import { on, submitJob, engineBlockReason } from '../store.js';
import { presetSelect, seedInput, countStepper, qualityToggles, jobMonitor, galleryGrid } from '../components.js';
import { etaText } from '../eta.js';
import { isPhone } from '../mobile.js';
import { segPicker, switchToggle } from './pixel.js';

const OPTS_KEY = 'vn.icon.opts';
const NAME_RE = /^[0-9A-Za-z가-힣_-]{1,40}$/;
const MAX_LINES = 32;
// [값, 이름, 설명, 투명 배경 기본값]
const STYLES = [
  ['game', '게임 아이템', 'RPG 아이템·스킬 아이콘처럼 채색된 단일 사물', true],
  ['flat', '플랫', '단순한 도형과 단색의 UI 아이콘', true],
  ['glossy', '앱 아이콘', '둥근 사각형 색 타일 위에 입체 심볼 (타일은 세트 전체가 같은 모양)', true],
  ['pixel', '도트', '64×64 픽셀 아트 아이콘 (24색)', true],
];
const SIZES = [512, 256, 128, 64, 32];
// 앱 아이콘 타일 색 (vnlib/graphs.py ICON_TILES와 같은 이름)
const TILES = [
  ['auto', '자동 (아이콘마다 다른 색)'], ['blue', '파랑'], ['green', '초록'], ['orange', '주황'], ['purple', '보라'],
  ['red', '빨강'], ['teal', '청록'], ['pink', '분홍'], ['gray', '회색'],
];

function iconLines(text) {
  return String(text || '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

export function createIconsView() {
  let $ = null;
  let preset;
  let seed;
  let count;
  let quality;
  let style;
  let transparent;
  let monitor;
  let results;
  let guard;
  let visible = false;
  let stale = false;
  const sizeBoxes = {};

  function selectedSizes() {
    return SIZES.filter((s) => sizeBoxes[s] && sizeBoxes[s].checked);
  }
  function buildSpec() {
    const st = style.get();
    return {
      mode: 'icon',
      prompt: iconLines($.prompt.value).join('\n'),
      negative: $.negative.value.trim(),
      name: $.name.value.trim() || 'icons',
      preset: preset.get() || null,
      size: 'square',
      count: count.get(),
      seed: seed.get(),
      hires: st === 'pixel' || st === 'glossy' ? false : quality.get().hires,
      face: false,
      hands: false,
      icon: {
        style: st, transparent: transparent.get(), sizes: st === 'pixel' ? [] : selectedSizes(),
        ...(st === 'glossy' ? { tile: $.tile.value } : {}),
      },
    };
  }
  function persist() {
    lsSet(OPTS_KEY, {
      preset: preset.get(), count: count.get(), hires: quality.get().hires, prompt: $.prompt.value,
      name: $.name.value, negative: $.negative.value, style: style.get(), transparent: transparent.get(),
      sizes: selectedSizes(), tile: $.tile.value,
    });
  }
  const persistLater = debounce(persist, 400);
  function refresh() {
    if (!$) return;
    const spec = buildSpec();
    const n = iconLines($.prompt.value).length;
    $.lineNote.textContent = n > MAX_LINES
      ? `아이콘 ${n}개 — 한 번에 ${MAX_LINES}개까지만 만들 수 있습니다.`
      : `아이콘 ${n}개${spec.count > 1 ? ` × 변형 ${spec.count}장 = ${n * spec.count}장` : ''}`;
    $.lineNote.classList.toggle('is-error', n > MAX_LINES);
    $.eta.textContent = n ? etaText(spec) : '';
    const px = spec.icon.style === 'pixel';
    $.sizesField.classList.toggle('is-disabled', px);
    for (const b of Object.values(sizeBoxes)) b.disabled = px;
    $.sizesNote.textContent = px
      ? '도트 아이콘은 64×64 그대로 저장합니다 (줄이면 픽셀이 뭉개짐).'
      : `원본 ${spec.hires ? 1536 : 1024}px과 함께 고른 크기를 icons/${$.name.value.trim() || 'icons'}/<크기>px/ 에 저장합니다.`;
    const app = spec.icon.style === 'glossy';
    $.qualitySlot.classList.toggle('is-disabled', px || app);
    $.tileField.hidden = !app;
    transparent.disable(app);
    $.transNote.textContent = app ? '앱 아이콘은 둥근 사각형 타일 바깥만 투명합니다. 하이레즈는 쓰지 않습니다(심볼을 줄여 넣음).' : '';
  }
  function changed() { persist(); refresh(); }
  function validName() {
    const v = $.name.value.trim();
    const ok = !v || NAME_RE.test(v);
    $.name.classList.toggle('invalid', !ok);
    $.nameNote.textContent = ok
      ? `저장 위치: output/icons/${v || 'icons'}/<아이콘 이름>_seed<시드>_00001_.png`
      : '영문·숫자·한글·-·_ 만 쓸 수 있습니다. 다른 문자는 _로 바뀌어 저장됩니다.';
    return ok;
  }

  async function submit() {
    const n = iconLines($.prompt.value).length;
    if (!n) {
      toast('만들 아이콘을 한 줄에 하나씩 입력하세요. 예: sword / health potion / gold coin', 'warn');
      $.prompt.focus();
      return;
    }
    if (n > MAX_LINES) {
      toast(`아이콘은 한 번에 ${MAX_LINES}개까지 만들 수 있습니다. 나눠서 생성하세요.`, 'warn');
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
    const job = await withBusy($.submit, () => submitJob(buildSpec()));
    if (job && isPhone()) $.monitorSlot.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function mount(el) {
    el.innerHTML = `
      <div class="gen-layout">
        <form class="panel gen-form" data-ref="form" novalidate autocomplete="off">
          <div class="panel-head">
            <h2 class="panel-title">아이콘 만들기</h2>
            <div class="panel-tools">${helpLink('icon', '? 아이콘 만들기')}</div>
          </div>
          <p class="panel-sub">게임 UI용 아이콘 세트를 만듭니다. 한 줄에 아이콘 하나씩 적으면 모두 같은 스타일·시드로 그려 세트의 그림체를 맞추고, 배경을 지운 투명 PNG와 크기별 파일을 함께 저장합니다.</p>
          <div class="field">
            <div class="field-label"><span class="label">스타일</span>${tipIcon('icon_style')}</div>
            <div data-ref="styleSlot"></div>
          </div>
          <div class="field">
            <div class="field-label"><label for="ic-prompt">아이콘 목록</label>${tipIcon('icon_list')}<span class="field-aside"><kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>Enter</kbd> 생성</span></div>
            <textarea id="ic-prompt" data-ref="prompt" rows="6" spellcheck="false" placeholder="한 줄에 하나씩. '파일이름: 설명' 형식도 됩니다.&#10;sword&#10;potion_red: red potion, glass bottle&#10;gold coin&#10;settings: gear"></textarea>
            <div class="field-note" data-ref="lineNote"></div>
          </div>
          <div class="field">
            <div data-ref="transSlot"></div>
            <div class="field-note" data-ref="transNote"></div>
          </div>
          <div class="field" data-ref="tileField" hidden>
            <div class="field-label"><label for="ic-tile">타일 색</label>${tipIcon('icon_tile')}</div>
            <select id="ic-tile" class="select" data-ref="tile">
              ${TILES.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}
            </select>
          </div>
          <div class="field" data-ref="sizesField">
            <div class="field-label"><span class="label">함께 저장할 크기</span>${tipIcon('icon_sizes')}</div>
            <div class="chip-row" data-ref="sizesSlot"></div>
            <div class="field-note" data-ref="sizesNote"></div>
          </div>
          <div class="grid-2">
            <div class="field">
              <div class="field-label"><label for="ic-name">세트 이름 (폴더)</label>${tipIcon('icon_name')}</div>
              <input type="text" id="ic-name" data-ref="name" placeholder="예: rpg_items" maxlength="40" spellcheck="false" autocapitalize="off">
              <div class="field-note" data-ref="nameNote"></div>
            </div>
            <div class="field">
              <div class="field-label"><label for="ic-preset">모델 프리셋</label>${tipIcon('preset')}${helpLink('models')}</div>
              <div data-ref="presetSlot"></div>
            </div>
          </div>
          <details class="fold" data-ref="negFold">
            <summary>추가 네거티브</summary>
            <div class="fold-body">
              <div class="field">
                <div class="field-label"><label for="ic-negative">추가 네거티브</label>${tipIcon('negative')}</div>
                <textarea id="ic-negative" data-ref="negative" rows="2" spellcheck="false" placeholder="예: shadow, frame"></textarea>
              </div>
            </div>
          </details>
          <div class="grid-2">
            <div class="field">
              <div class="field-label"><label for="ic-count">아이콘당 변형</label>${tipIcon('icon_count')}</div>
              <div data-ref="countSlot"></div>
            </div>
            <div class="field">
              <div class="field-label"><label for="ic-seed">시드</label>${tipIcon('seed')}</div>
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
            <button type="submit" class="btn btn-primary btn-lg" data-ref="submit">아이콘 생성</button>
          </div>
        </form>
        <div class="gen-side">
          <div data-ref="monitorSlot"></div>
          <section class="panel">
            <div class="panel-head">
              <h3 class="panel-title">아이콘 결과</h3>
              <div class="panel-tools"><button type="button" class="btn btn-sm btn-ghost" data-ref="refresh">새로고침</button></div>
            </div>
            <div data-ref="resultsSlot"></div>
          </section>
        </div>
      </div>`;
    $ = refs(el);
    const opts = lsGet(OPTS_KEY, {}) || {};

    style = segPicker({
      label: '스타일',
      items: STYLES.map(([v, t, tip]) => [v, t, tip]),
      value: opts.style || 'game',
      onChange: (v) => {
        transparent.set(STYLES.find((s) => s[0] === v)[3]);
        changed();
      },
    });
    $.styleSlot.append(style.el);
    const st0 = STYLES.find((s) => s[0] === style.get());
    transparent = switchToggle({
      id: 'ic-trans', label: '투명 배경 (배경 제거)',
      value: typeof opts.transparent === 'boolean' ? opts.transparent : st0[3], onChange: changed,
    });
    $.transSlot.append(transparent.el);
    $.tile.value = TILES.some(([v]) => v === opts.tile) ? opts.tile : 'auto';
    $.tile.addEventListener('change', changed);
    const savedSizes = Array.isArray(opts.sizes) ? opts.sizes : [256, 128, 64];
    for (const s of SIZES) {
      const id = `ic-size-${s}`;
      const box = h('input', { type: 'checkbox', id });
      box.checked = savedSizes.includes(s);
      box.addEventListener('change', changed);
      sizeBoxes[s] = box;
      $.sizesSlot.append(h('label', { class: 'check-chip', for: id }, box, h('span', {}, `${s}px`)));
    }

    preset = presetSelect({ id: 'ic-preset', allowDefault: true, onChange: changed });
    preset.set(typeof opts.preset === 'string' ? opts.preset : '');
    $.presetSlot.append(preset.el);
    count = countStepper({ id: 'ic-count', value: opts.count || 1, min: 1, max: 8, onChange: changed });
    $.countSlot.append(count.el);
    seed = seedInput({ id: 'ic-seed', onChange: refresh });
    $.seedSlot.append(seed.el);
    const noPeople = '아이콘에는 인물이 없으므로 얼굴·손 보정을 하지 않습니다.';
    quality = qualityToggles({
      value: { hires: opts.hires === true }, idPrefix: 'icq',
      disabled: { face: noPeople, hands: noPeople },
      onChange: changed,
    });
    $.qualitySlot.append(quality.el);

    $.prompt.value = typeof opts.prompt === 'string' ? opts.prompt : '';
    $.name.value = typeof opts.name === 'string' ? opts.name : '';
    $.negative.value = typeof opts.negative === 'string' ? opts.negative : '';
    if ($.negative.value) $.negFold.open = true;
    validName();

    for (const ta of [$.prompt, $.negative]) {
      ta.addEventListener('input', () => { persistLater(); refresh(); });
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          submit();
        }
      });
    }
    $.name.addEventListener('input', () => { validName(); persistLater(); refresh(); });
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
      title: '아이콘 작업',
      filter: (j) => !!j.spec && j.spec.mode === 'icon',
      emptyTitle: '진행 중인 아이콘 작업이 없습니다',
    });
    $.monitorSlot.append(monitor.el);

    results = galleryGrid({
      params: { folder: 'icons', kind: 'icon' },
      pageSize: 36,
      infinite: true,
      emptyTitle: '아직 만든 아이콘이 없습니다',
      emptyText: '왼쪽에 아이콘 목록을 한 줄에 하나씩 적고 [아이콘 생성]을 누르세요.',
    });
    $.resultsSlot.append(results.el);
    results.reload();
    $.refresh.addEventListener('click', () => results.reload());
    refresh();

    const reload = debounce(() => {
      if (visible) results.reload();
      else stale = true;
    }, 700);
    on('status', () => { guard.update(engineBlockReason()); monitor.update(); });
    on('sse', () => { guard.update(engineBlockReason()); monitor.update(); });
    on('presets', () => preset.refresh());
    on('jobs', () => monitor.update());
    on('job-removed', () => monitor.update());
    on('preview', () => monitor.update());
    on('job', (job, prev) => {
      monitor.update();
      if (job.spec && job.spec.mode === 'icon' && job.status === 'done' && (!prev || prev.status !== 'done')) reload();
    });
    on('tick', () => { if (visible) monitor.tick(); });
    on('gallery-changed', reload);
  }

  return {
    id: 'icons',
    title: '아이콘',
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
