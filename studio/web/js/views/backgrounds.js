// 배경 탭: 인물 없는 배경 생성 + 결과 갤러리(backgrounds)
import { h, refs, lsGet, lsSet, debounce } from '../util.js';
import { tipIcon, helpLink, toast, guardButton, withBusy } from '../ui.js';
import { store, on, submitJob, engineBlockReason } from '../store.js';
import {
  presetSelect, sizePicker, seedInput, countStepper, qualityToggles, tagHelper, jobMonitor, galleryGrid,
} from '../components.js';
import { etaText } from '../eta.js';
import { isPhone } from '../mobile.js';

const OPTS_KEY = 'vn.bg.opts';
const NAME_RE = /^[0-9A-Za-z가-힣_-]{1,40}$/;

export function createBackgroundsView() {
  let $ = null;
  let preset;
  let size;
  let seed;
  let count;
  let quality;
  let monitor;
  let results;
  let guard;
  let visible = false;
  let stale = false;

  function buildSpec() {
    return {
      mode: 'bg',
      prompt: $.prompt.value.trim(),
      negative: $.negative.value.trim(),
      name: $.name.value.trim() || 'bg',
      preset: preset.get() || null,
      size: size.get(),
      count: count.get(),
      seed: seed.get(),
      ...quality.get(),
      face: false,
      hands: false,
    };
  }
  function persist() {
    lsSet(OPTS_KEY, {
      preset: preset.get(), size: size.get(), count: count.get(), hires: quality.get().hires,
      prompt: $.prompt.value, name: $.name.value, negative: $.negative.value,
    });
  }
  const persistLater = debounce(persist, 400);
  function updateEta() {
    if ($) $.eta.textContent = etaText(buildSpec());
  }
  function validName() {
    const v = $.name.value.trim();
    const ok = !v || NAME_RE.test(v);
    $.name.classList.toggle('invalid', !ok);
    $.nameNote.textContent = ok
      ? `저장 위치: output/backgrounds/${v || 'bg'}_seed<시드>_00001_.png`
      : '영문·숫자·한글·-·_ 만 쓸 수 있습니다. 다른 문자는 _로 바뀌어 저장됩니다.';
    return ok;
  }

  async function submit() {
    if (!$.prompt.value.trim()) {
      toast('배경 설명을 입력하세요. 예: classroom, afternoon, sunlight, window', 'warn');
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
    persist();
    const job = await withBusy($.submit, () => submitJob(buildSpec()));
    // 휴대폰: 폼 아래에 있는 실시간 미리보기로 내려가 진행을 바로 보여 준다
    if (job && isPhone()) $.monitorSlot.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function mount(el) {
    el.innerHTML = `
      <div class="gen-layout">
        <form class="panel gen-form" data-ref="form" novalidate autocomplete="off">
          <div class="panel-head">
            <h2 class="panel-title">배경 만들기</h2>
            <div class="panel-tools">${helpLink('workflow-bg', '? 배경 만들기')}</div>
          </div>
          <p class="panel-sub">인물 없는 비주얼 노벨 배경을 만듭니다. "no humans, scenery"와 배경용 품질 태그가 자동으로 붙고, 인물 관련 태그는 네거티브로 빠집니다.</p>
          <div class="field">
            <div class="field-label"><label for="bg-prompt">배경 설명</label>${tipIcon('bg_prompt')}<span class="field-aside"><kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>Enter</kbd> 생성</span></div>
            <textarea id="bg-prompt" data-ref="prompt" rows="4" spellcheck="false" placeholder="예: classroom, afternoon, sunlight, window, desk, chalkboard"></textarea>
            <div class="prompt-tools">
              <button type="button" class="btn btn-xs btn-ghost" data-ref="helperToggle" aria-expanded="false">＃ 배경·조명 태그</button>
            </div>
            <div class="helper-slot" data-ref="helperSlot" hidden></div>
          </div>
          <div class="grid-2">
            <div class="field">
              <div class="field-label"><label for="bg-name">파일 이름</label>${tipIcon('bg_name')}</div>
              <input type="text" id="bg-name" data-ref="name" placeholder="예: classroom" maxlength="40" spellcheck="false" autocapitalize="off">
              <div class="field-note" data-ref="nameNote"></div>
            </div>
            <div class="field">
              <div class="field-label"><label for="bg-preset">모델 프리셋</label>${tipIcon('preset')}${helpLink('models')}</div>
              <div data-ref="presetSlot"></div>
            </div>
          </div>
          <details class="fold" data-ref="negFold">
            <summary>추가 네거티브</summary>
            <div class="fold-body">
              <div class="field">
                <div class="field-label"><label for="bg-negative">추가 네거티브</label>${tipIcon('negative')}</div>
                <textarea id="bg-negative" data-ref="negative" rows="2" spellcheck="false" placeholder="예: text, signboard"></textarea>
              </div>
            </div>
          </details>
          <div class="field">
            <div class="field-label"><span class="label">크기</span>${tipIcon('size')}</div>
            <div data-ref="sizeSlot"></div>
          </div>
          <div class="grid-2">
            <div class="field">
              <div class="field-label"><label for="bg-count">장수</label>${tipIcon('count')}</div>
              <div data-ref="countSlot"></div>
            </div>
            <div class="field">
              <div class="field-label"><label for="bg-seed">시드</label>${tipIcon('seed')}</div>
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
            <button type="submit" class="btn btn-primary btn-lg" data-ref="submit">배경 생성</button>
          </div>
        </form>
        <div class="gen-side">
          <div data-ref="monitorSlot"></div>
          <section class="panel">
            <div class="panel-head">
              <h3 class="panel-title">배경 결과</h3>
              <div class="panel-tools"><button type="button" class="btn btn-sm btn-ghost" data-ref="refresh">새로고침</button></div>
            </div>
            <div data-ref="resultsSlot"></div>
          </section>
        </div>
      </div>`;
    $ = refs(el);
    const opts = lsGet(OPTS_KEY, {}) || {};

    preset = presetSelect({ id: 'bg-preset', allowDefault: true, onChange: () => { persist(); updateEta(); } });
    preset.set(typeof opts.preset === 'string' ? opts.preset : '');
    $.presetSlot.append(preset.el);
    size = sizePicker({ value: opts.size || 'wide', idPrefix: 'bg-size', onChange: () => { persist(); updateEta(); } });
    $.sizeSlot.append(size.el);
    count = countStepper({ id: 'bg-count', value: opts.count || 1, min: 1, max: 16, onChange: () => { persist(); updateEta(); } });
    $.countSlot.append(count.el);
    seed = seedInput({ id: 'bg-seed', onChange: updateEta });
    $.seedSlot.append(seed.el);
    const noPeople = '배경에는 인물이 없으므로 얼굴·손 보정을 하지 않습니다.';
    quality = qualityToggles({
      value: { hires: opts.hires !== false }, idPrefix: 'bgq',
      disabled: { face: noPeople, hands: noPeople },
      onChange: () => { persist(); updateEta(); },
    });
    $.qualitySlot.append(quality.el);

    $.prompt.value = typeof opts.prompt === 'string' ? opts.prompt : '';
    $.name.value = typeof opts.name === 'string' ? opts.name : '';
    $.negative.value = typeof opts.negative === 'string' ? opts.negative : '';
    if ($.negative.value) $.negFold.open = true;
    validName();

    let helper = null;
    $.helperToggle.addEventListener('click', () => {
      if (!helper) {
        helper = tagHelper({ textarea: $.prompt, categories: ['background', 'lighting', 'effect', 'composition'] });
        $.helperSlot.append(helper.el);
      }
      const open = $.helperSlot.hidden;
      $.helperSlot.hidden = !open;
      $.helperToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      $.helperToggle.classList.toggle('active', open);
    });

    for (const ta of [$.prompt, $.negative]) {
      ta.addEventListener('input', () => { persistLater(); updateEta(); });
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
    // 태그 검색·파일 이름·장수·시드·크기 칸의 Enter가 폼을 제출(=배경 생성)하지 않도록 막는다.
    // 숫자 칸은 'change'에서 값을 확정하므로 대신 change를 보낸다. 생성은 버튼이나 ⌘/Ctrl+Enter로만.
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
      title: '배경 작업',
      filter: (j) => !!j.spec && j.spec.mode === 'bg',
      emptyTitle: '진행 중인 배경 작업이 없습니다',
    });
    $.monitorSlot.append(monitor.el);

    results = galleryGrid({
      params: { folder: 'backgrounds', kind: 'bg' },
      pageSize: 24,
      gridClass: 'thumb-grid-wide',
      infinite: true,
      emptyTitle: '아직 만든 배경이 없습니다',
      emptyText: '왼쪽에서 배경 설명을 입력하고 [배경 생성]을 누르세요.',
    });
    $.resultsSlot.append(results.el);
    results.reload();
    $.refresh.addEventListener('click', () => results.reload());
    updateEta();

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
      if (job.spec && job.spec.mode === 'bg' && job.status === 'done' && (!prev || prev.status !== 'done')) reload();
    });
    on('tick', () => { if (visible) monitor.tick(); });
    on('gallery-changed', reload);
  }

  return {
    id: 'backgrounds',
    title: '배경',
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
