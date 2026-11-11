// 도트 탭: 픽셀 아트 리소스(캐릭터·아이템·배경) 생성 + 결과 갤러리(pixel)
// 생성 → 실제 도트 크기로 축소 → 팔레트 양자화 → (투명) 1비트 알파. 결과 파일은 실제 픽셀 크기 그대로 저장된다.
import { h, refs, lsGet, lsSet, debounce, sizeWH } from '../util.js';
import { tipIcon, helpLink, toast, guardButton, withBusy } from '../ui.js';
import { on, submitJob, engineBlockReason } from '../store.js';
import { presetSelect, sizePicker, seedInput, countStepper, jobMonitor, galleryGrid } from '../components.js';
import { etaText } from '../eta.js';
import { isPhone } from '../mobile.js';

const OPTS_KEY = 'vn.pixel.opts';
const NAME_RE = /^[0-9A-Za-z가-힣_-]{1,40}$/;
const SUBJECTS = [
  ['character', '캐릭터', 'portrait', '전신 캐릭터 스프라이트 (투명 배경)'],
  ['object', '아이템·오브젝트', 'square', '아이템·소품·타일 하나 (투명 배경)'],
  ['scene', '배경·장면', 'wide', '인물 없는 도트 배경 (불투명)'],
];
const WIDTHS = [32, 48, 64, 96, 128, 192, 256];
const COLORS = [8, 16, 24, 32, 64];
const DITHERS = [
  ['none', '없음 (깔끔)'],
  ['bayer-2', '바이엘 2×2 (잔 격자)'],
  ['bayer-4', '바이엘 4×4 (레트로)'],
  ['floyd-steinberg', '플로이드-스타인버그 (부드러운 점묘)'],
];

/** 단일 선택 버튼 묶음 */
export function segPicker({ items, value, onChange, label }) {
  const el = h('div', { class: 'seg', role: 'group', 'aria-label': label || '' });
  let cur = value;
  const btns = items.map(([v, text, tip]) => {
    const b = h('button', { type: 'button', class: 'seg-btn', 'data-v': String(v) }, text);
    if (tip) b.title = tip;
    b.addEventListener('click', () => {
      if (b.disabled) return;
      set(v);
      if (onChange) onChange(v);
    });
    el.append(b);
    return [v, b];
  });
  function set(v) {
    cur = items.some(([x]) => x === v) ? v : items[0][0];
    for (const [x, b] of btns) {
      b.classList.toggle('active', x === cur);
      b.setAttribute('aria-pressed', x === cur ? 'true' : 'false');
    }
  }
  set(value);
  return { el, get: () => cur, set };
}

/** 스위치 하나 (qualityToggles와 같은 모양) */
export function switchToggle({ id, label, value, onChange }) {
  const input = h('input', { type: 'checkbox', role: 'switch', id });
  input.checked = !!value;
  const el = h('label', { class: 'switch', for: id },
    input,
    h('span', { class: 'switch-track', 'aria-hidden': 'true' }, h('span', { class: 'switch-thumb' })),
    h('span', { class: 'switch-label' }, label));
  input.addEventListener('change', () => { if (onChange) onChange(input.checked); });
  return {
    el,
    get: () => input.checked,
    set: (v) => { input.checked = !!v; },
    disable: (d) => { input.disabled = !!d; el.classList.toggle('is-disabled', !!d); },
  };
}

export function createPixelView() {
  let $ = null;
  let preset;
  let size;
  let seed;
  let count;
  let subject;
  let width;
  let colors;
  let transparent;
  let monitor;
  let results;
  let guard;
  let visible = false;
  let stale = false;
  let sizeTouched = false;

  function buildSpec() {
    const subj = subject.get();
    return {
      mode: 'pixel',
      prompt: $.prompt.value.trim(),
      negative: $.negative.value.trim(),
      name: $.name.value.trim() || 'pixel',
      preset: preset.get() || null,
      size: size.get(),
      count: count.get(),
      seed: seed.get(),
      hires: false,
      face: false,
      hands: false,
      pixel: {
        subject: subj,
        width: width.get(),
        colors: colors.get(),
        dither: $.dither.value,
        transparent: subj !== 'scene' && transparent.get(),
      },
    };
  }
  function persist() {
    lsSet(OPTS_KEY, {
      preset: preset.get(), size: size.get(), count: count.get(), prompt: $.prompt.value, name: $.name.value,
      negative: $.negative.value, subject: subject.get(), width: width.get(), colors: colors.get(),
      dither: $.dither.value, transparent: transparent.get(), sizeTouched,
    });
  }
  const persistLater = debounce(persist, 400);
  function refresh() {
    if (!$) return;
    const spec = buildSpec();
    $.eta.textContent = etaText(spec);
    const [w, h0] = sizeWH(spec.size, 'pixel');
    const scene = spec.pixel.subject === 'scene';
    if (spec.pixel.transparent) {
      // 투명: 대상 테두리에 맞춰 자른 뒤 긴 변 = 도트 크기 (여백에 픽셀을 낭비하지 않음)
      $.widthLabel.textContent = '도트 크기 (대상의 긴 변 픽셀)';
      $.pxNote.textContent = `결과: 대상에 맞춰 자른 뒤 긴 변 ${spec.pixel.width}픽셀 (예: 세로로 긴 캐릭터면 높이 ${spec.pixel.width}), ${spec.pixel.colors}색`;
    } else {
      const pw = Math.min(spec.pixel.width, w);
      const ph = Math.max(1, Math.round((h0 * pw) / w));
      $.widthLabel.textContent = '도트 크기 (가로 픽셀)';
      $.pxNote.textContent = `결과: ${pw}×${ph} 픽셀 (생성 ${w}×${h0}을 ${Math.round(w / pw)}분의 1로 축소), ${spec.pixel.colors}색`;
    }
    transparent.disable(scene);
    $.transNote.textContent = scene ? '배경·장면은 투명 배경을 쓰지 않습니다.' : '배경을 지우고 가장자리를 1비트(완전 투명/완전 불투명)로 자릅니다.';
  }
  function changed() { persist(); refresh(); }
  function validName() {
    const v = $.name.value.trim();
    const ok = !v || NAME_RE.test(v);
    $.name.classList.toggle('invalid', !ok);
    $.nameNote.textContent = ok
      ? `저장 위치: output/pixel/${v || 'pixel'}_<크기>_seed<시드>_00001_.png`
      : '영문·숫자·한글·-·_ 만 쓸 수 있습니다. 다른 문자는 _로 바뀌어 저장됩니다.';
    return ok;
  }

  async function submit() {
    if (!$.prompt.value.trim()) {
      toast('만들 대상을 입력하세요. 예: red potion, glass bottle', 'warn');
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
    if (job && isPhone()) $.monitorSlot.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function mount(el) {
    el.innerHTML = `
      <div class="gen-layout">
        <form class="panel gen-form" data-ref="form" novalidate autocomplete="off">
          <div class="panel-head">
            <h2 class="panel-title">도트 만들기</h2>
            <div class="panel-tools">${helpLink('pixel', '? 도트 만들기')}</div>
          </div>
          <p class="panel-sub">픽셀 아트 리소스를 만듭니다. 그림을 그린 뒤 실제 도트 크기로 줄이고 팔레트 색 수를 제한해, 게임에 바로 쓸 수 있는 <b>실제 픽셀 크기</b> PNG로 저장합니다.</p>
          <div class="field">
            <div class="field-label"><span class="label">대상 종류</span>${tipIcon('pixel_subject')}</div>
            <div data-ref="subjectSlot"></div>
          </div>
          <div class="field">
            <div class="field-label"><label for="px-prompt">만들 대상</label>${tipIcon('pixel_prompt')}<span class="field-aside"><kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>Enter</kbd> 생성</span></div>
            <textarea id="px-prompt" data-ref="prompt" rows="3" spellcheck="false" placeholder="예: red potion, glass bottle, cork"></textarea>
          </div>
          <div class="field">
            <div class="field-label"><span class="label" data-ref="widthLabel">도트 크기</span>${tipIcon('pixel_width')}</div>
            <div data-ref="widthSlot"></div>
            <div class="field-note" data-ref="pxNote"></div>
          </div>
          <div class="grid-2">
            <div class="field">
              <div class="field-label"><span class="label">색 수</span>${tipIcon('pixel_colors')}</div>
              <div data-ref="colorsSlot"></div>
            </div>
            <div class="field">
              <div class="field-label"><label for="px-dither">디더링</label>${tipIcon('pixel_dither')}</div>
              <select id="px-dither" class="select" data-ref="dither">
                ${DITHERS.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="field">
            <div data-ref="transSlot"></div>
            <div class="field-note" data-ref="transNote"></div>
          </div>
          <div class="grid-2">
            <div class="field">
              <div class="field-label"><label for="px-name">파일 이름</label>${tipIcon('pixel_name')}</div>
              <input type="text" id="px-name" data-ref="name" placeholder="예: potion_red" maxlength="40" spellcheck="false" autocapitalize="off">
              <div class="field-note" data-ref="nameNote"></div>
            </div>
            <div class="field">
              <div class="field-label"><label for="px-preset">모델 프리셋</label>${tipIcon('preset')}${helpLink('models')}</div>
              <div data-ref="presetSlot"></div>
            </div>
          </div>
          <details class="fold" data-ref="moreFold">
            <summary>생성 크기 · 추가 네거티브</summary>
            <div class="fold-body">
              <div class="field">
                <div class="field-label"><span class="label">생성 크기</span>${tipIcon('pixel_gen_size')}</div>
                <div data-ref="sizeSlot"></div>
              </div>
              <div class="field">
                <div class="field-label"><label for="px-negative">추가 네거티브</label>${tipIcon('negative')}</div>
                <textarea id="px-negative" data-ref="negative" rows="2" spellcheck="false" placeholder="예: shadow, outline"></textarea>
              </div>
            </div>
          </details>
          <div class="grid-2">
            <div class="field">
              <div class="field-label"><label for="px-count">장수</label>${tipIcon('count')}</div>
              <div data-ref="countSlot"></div>
            </div>
            <div class="field">
              <div class="field-label"><label for="px-seed">시드</label>${tipIcon('seed')}</div>
              <div data-ref="seedSlot"></div>
            </div>
          </div>
          <div class="submit-bar">
            <div class="submit-info">
              <div class="eta" data-ref="eta"></div>
              <div class="guard-reason" data-ref="reason" hidden></div>
            </div>
            <button type="submit" class="btn btn-primary btn-lg" data-ref="submit">도트 생성</button>
          </div>
        </form>
        <div class="gen-side">
          <div data-ref="monitorSlot"></div>
          <section class="panel">
            <div class="panel-head">
              <h3 class="panel-title">도트 결과</h3>
              <div class="panel-tools"><button type="button" class="btn btn-sm btn-ghost" data-ref="refresh">새로고침</button></div>
            </div>
            <div data-ref="resultsSlot"></div>
          </section>
        </div>
      </div>`;
    $ = refs(el);
    const opts = lsGet(OPTS_KEY, {}) || {};
    sizeTouched = !!opts.sizeTouched;

    subject = segPicker({
      label: '대상 종류',
      items: SUBJECTS.map(([v, t, , tip]) => [v, t, tip]),
      value: opts.subject || 'object',
      onChange: (v) => {
        // 생성 크기를 직접 고르지 않았으면 대상에 맞는 기본 크기로 (캐릭터 세로, 아이템 정사각, 배경 와이드)
        if (!sizeTouched) size.set(SUBJECTS.find((s) => s[0] === v)[2]);
        if (v !== 'scene') transparent.set(true);
        changed();
      },
    });
    $.subjectSlot.append(subject.el);
    width = segPicker({ label: '도트 크기', items: WIDTHS.map((w) => [w, `${w}`]), value: Number(opts.width) || 128, onChange: changed });
    $.widthSlot.append(width.el);
    colors = segPicker({ label: '색 수', items: COLORS.map((c) => [c, `${c}색`]), value: Number(opts.colors) || 32, onChange: changed });
    $.colorsSlot.append(colors.el);
    $.dither.value = DITHERS.some(([v]) => v === opts.dither) ? opts.dither : 'none';
    $.dither.addEventListener('change', changed);
    transparent = switchToggle({ id: 'px-trans', label: '투명 배경', value: opts.transparent !== false, onChange: changed });
    $.transSlot.append(transparent.el);

    preset = presetSelect({ id: 'px-preset', allowDefault: true, onChange: changed });
    preset.set(typeof opts.preset === 'string' ? opts.preset : '');
    $.presetSlot.append(preset.el);
    const defSize = SUBJECTS.find((s) => s[0] === subject.get())[2];
    size = sizePicker({
      value: (sizeTouched && opts.size) || defSize, idPrefix: 'px-size',
      onChange: () => { sizeTouched = true; changed(); },
    });
    $.sizeSlot.append(size.el);
    count = countStepper({ id: 'px-count', value: opts.count || 1, min: 1, max: 16, onChange: changed });
    $.countSlot.append(count.el);
    seed = seedInput({ id: 'px-seed', onChange: refresh });
    $.seedSlot.append(seed.el);

    $.prompt.value = typeof opts.prompt === 'string' ? opts.prompt : '';
    $.name.value = typeof opts.name === 'string' ? opts.name : '';
    $.negative.value = typeof opts.negative === 'string' ? opts.negative : '';
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
      title: '도트 작업',
      filter: (j) => !!j.spec && j.spec.mode === 'pixel',
      emptyTitle: '진행 중인 도트 작업이 없습니다',
    });
    $.monitorSlot.append(monitor.el);

    results = galleryGrid({
      params: { folder: 'pixel', kind: 'pixel' },
      pageSize: 36,
      infinite: true,
      emptyTitle: '아직 만든 도트가 없습니다',
      emptyText: '왼쪽에서 대상과 도트 크기를 고르고 [도트 생성]을 누르세요.',
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
      if (job.spec && job.spec.mode === 'pixel' && job.status === 'done' && (!prev || prev.status !== 'done')) reload();
    });
    on('tick', () => { if (visible) monitor.tick(); });
    on('gallery-changed', reload);
  }

  return {
    id: 'pixel',
    title: '도트',
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
