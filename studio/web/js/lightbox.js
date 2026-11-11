// 라이트박스: 큰 이미지 + ←/→ 이동 + Esc 닫기 + 정보 패널과 작업 버튼
import {
  h, refs, clamp, basename, dirname, fileUrl, thumbUrl, fmtBytes, fmtDateTime, parseSeedFromName, copyText,
  detectAlpha, KIND_LABELS, MODE_LABELS, randomSeed, qs, lsGet, lsSet, sizeLabel, jobPoseSize, noPeople, isPixelPath,
} from './util.js';
import { api } from './api.js';
import { pushLayer, toast, confirmDialog, withBusy } from './ui.js';
import { emit, submitJob, engineBlockReason, loadCharacters, characterById, presetLabel, resolvePose } from './store.js';
import { poseInfoBlock, poseNameOf } from './pose.js';
import { isRemote } from './remote.js';
import { isPhone } from './mobile.js';

let state = null;
const infoCache = new Map();

export function closeLightbox() {
  if (state) state.close();
}
export function isLightboxOpen() {
  return !!state;
}

function charFromPath(path) {
  const m = /^([^/]+)\/(concept|sprite|cg)\//.exec(String(path || ''));
  return m ? m[1] : null;
}

/**
 * 다시 만들 spec의 포즈 확인: 파일이 지워졌으면 알리고 포즈를 뺀다 (info.pose.exists 또는 서버 확인).
 * sizeFrom: 실제 적용 포즈(job.pose {size, gen_size?}) — 크기를 비워 둔 spec은 포즈 크기로 생성됐으므로 그 크기를 유지한다
 */
async function dropMissingPose(s, infoPose, sizeFrom = null) {
  const name = poseNameOf(s.pose);
  if (!name) return s;
  const gone = infoPose && infoPose.name === name && infoPose.exists === false ? true : (await resolvePose(name)) === null;
  if (gone) {
    delete s.pose;
    const keep = !s.size && !noPeople(s.mode) ? jobPoseSize(sizeFrom) : null;
    if (keep) s.size = keep;
    toast(`이 이미지에 쓴 포즈(${name})가 삭제되어 포즈 없이 다시 생성합니다${keep ? ` (크기는 원래대로 ${keep[0]}×${keep[1]})` : ''}.`, 'warn', { timeout: 9000 });
  }
  return s;
}

function loraText(l) {
  if (!l) return '';
  if (typeof l === 'string') return l;
  if (Array.isArray(l)) return `${l[0]} (${l[1]})`;
  return l.weight != null ? `${l.name} (${l.weight})` : String(l.name || '');
}

/**
 * @param {Array<object>} items 갤러리 항목 {path, url?, thumb?, name?, ...}
 * @param {number} index
 * @param {{onDelete?: (item: object) => void, loadMore?: () => Promise<object[]>}} opts
 */
export function openLightbox(items, index = 0, opts = {}) {
  if (!Array.isArray(items) || !items.length) return;
  closeLightbox();
  const root = document.getElementById('lightbox');
  if (!root) return;
  const list = items.filter(Boolean).slice();
  if (!list.length) return;
  let idx = clamp(Number(index) || 0, 0, list.length - 1);
  let loadMore = typeof opts.loadMore === 'function' ? opts.loadMore : null;
  // 휴대폰에서는 정보가 아래에서 올라오는 시트라 이미지를 가리므로 항상 접힌 채로 연다 (데스크톱 설정은 그대로 기억)
  const phone = isPhone();
  let infoOpen = phone ? false : lsGet('vn.lb.info', true) !== false;
  let token = 0;
  let loadingMore = false;
  const prevFocus = document.activeElement;

  root.innerHTML = `
    <div class="lb" role="dialog" aria-modal="true" aria-label="이미지 크게 보기">
      <div class="lb-main">
        <div class="lb-top">
          <span class="lb-counter" data-ref="counter"></span>
          <span class="lb-name" data-ref="name"></span>
          <span class="lb-spacer"></span>
          <button type="button" class="btn btn-sm btn-ghost lb-btn" data-ref="zoom" aria-pressed="false">원본 크기</button>
          <button type="button" class="btn btn-sm btn-ghost lb-btn" data-ref="infoToggle">정보</button>
          <button type="button" class="icon-btn lb-close" data-ref="close" aria-label="닫기 (Esc)">×</button>
        </div>
        <div class="lb-stage" data-ref="stage">
          <img class="lb-img" data-ref="img" alt="" draggable="false">
          <div class="lb-loading" data-ref="loading"><span class="spinner spinner-lg" aria-hidden="true"></span></div>
          <div class="lb-error" data-ref="error" hidden>이미지를 불러오지 못했습니다. 파일이 이동되었거나 삭제되었을 수 있습니다.</div>
        </div>
        <button type="button" class="lb-nav lb-prev" data-ref="prev" aria-label="이전 이미지 (←)">‹</button>
        <button type="button" class="lb-nav lb-next" data-ref="next" aria-label="다음 이미지 (→)">›</button>
        <div class="lb-hint" aria-hidden="true"><span class="lb-hint-keys">← → 이동 · Esc 닫기 · 이미지를 누르면 원본 크기 · I 정보</span><span class="lb-hint-touch">좌우로 밀어서 이동 · 아래로 밀면 닫기 · 이미지를 누르면 원본 크기</span></div>
      </div>
      <aside class="lb-info" data-ref="info" aria-label="이미지 정보"></aside>
    </div>`;
  const $ = refs(root);
  root.hidden = false;
  document.body.classList.add('lb-open');

  // 휴대폰: 정보 패널은 화면 아래의 시트. 접혀 있을 때도 이 손잡이 줄은 보이고, 누르거나 위로 밀면 펼쳐진다 (mobile.css)
  const sheetHead = h('button', { type: 'button', class: 'lb-sheet-head', 'aria-expanded': 'false' },
    h('span', { class: 'lb-sheet-grip', 'aria-hidden': 'true' }),
    h('span', { class: 'lb-sheet-label' }, '정보 · 작업'),
    h('span', { class: 'lb-sheet-chev', 'aria-hidden': 'true' }, '▴'));
  let sheetSwipedAt = 0;
  sheetHead.addEventListener('click', () => {
    if (Date.now() - sheetSwipedAt < 400) return;
    setInfoOpen(!infoOpen);
  });
  let sheetY = null;
  sheetHead.addEventListener('touchstart', (e) => { sheetY = e.touches.length === 1 ? e.touches[0].clientY : null; }, { passive: true });
  sheetHead.addEventListener('touchend', (e) => {
    if (sheetY == null || !e.changedTouches.length) return;
    const dy = e.changedTouches[0].clientY - sheetY;
    sheetY = null;
    if (Math.abs(dy) < 24) return;
    sheetSwipedAt = Date.now();
    setInfoOpen(dy < 0);
  });

  function setInfoOpen(v) {
    infoOpen = v;
    root.querySelector('.lb').classList.toggle('info-hidden', !v);
    $.infoToggle.setAttribute('aria-pressed', v ? 'true' : 'false');
    sheetHead.setAttribute('aria-expanded', v ? 'true' : 'false');
    sheetHead.lastChild.textContent = v ? '▾' : '▴';
    if (!v) $.info.scrollTop = 0;
    if (!isPhone()) lsSet('vn.lb.info', v);
  }
  function setZoom(v) {
    $.stage.classList.toggle('zoomed', v);
    $.zoom.setAttribute('aria-pressed', v ? 'true' : 'false');
    $.zoom.textContent = v ? '화면에 맞춤' : '원본 크기';
    if (v) {
      requestAnimationFrame(() => {
        $.stage.scrollLeft = Math.max(0, ($.stage.scrollWidth - $.stage.clientWidth) / 2);
        $.stage.scrollTop = Math.max(0, ($.stage.scrollHeight - $.stage.clientHeight) / 3);
      });
    }
  }
  setInfoOpen(infoOpen);

  function updateNav() {
    $.counter.textContent = `${idx + 1} / ${list.length}${loadMore ? '+' : ''}`;
    $.prev.disabled = idx <= 0;
    $.next.disabled = idx >= list.length - 1 && !loadMore;
  }

  async function getInfo(item) {
    if (infoCache.has(item.path)) return infoCache.get(item.path);
    try {
      const r = await api('/api/gallery/info' + qs({ path: item.path }), { silent: true });
      infoCache.set(item.path, r);
      if (infoCache.size > 300) infoCache.delete(infoCache.keys().next().value);
      return r;
    } catch (e) {
      return { __error: (e && e.message) || '정보를 불러오지 못했습니다.' };
    }
  }

  function show(i) {
    idx = clamp(i, 0, list.length - 1);
    const item = list[idx];
    const tok = ++token;
    updateNav();
    $.name.textContent = item.name || basename(item.path);
    $.name.title = item.path;
    setZoom(false);
    $.stage.classList.remove('checker');
    $.img.classList.remove('pixelated');
    $.loading.hidden = false;
    $.error.hidden = true;
    $.img.hidden = false;
    $.img.alt = item.name || basename(item.path);
    $.img.src = item.thumb || thumbUrl(item.path);
    const full = item.url || fileUrl(item.path);
    const im = new Image();
    im.onload = () => {
      if (tok !== token) return;
      $.img.src = full;
      $.loading.hidden = true;
      // 작은 그림(도트 등)은 화면에 맞게 최근접 확대 — 브라우저 기본 보간으로 흐려지지 않게
      $.img.classList.toggle('pixelated', isPixelPath(item.path) || im.naturalWidth <= 256);
      detectAlpha(im, item.path, (a) => { if (tok === token) $.stage.classList.toggle('checker', a); });
    };
    im.onerror = () => {
      if (tok !== token) return;
      $.loading.hidden = true;
      $.img.hidden = true;
      $.error.hidden = false;
    };
    im.src = full;
    // 이웃 이미지 미리 받기
    for (const j of [idx + 1, idx - 1]) {
      const n = list[j];
      if (n) new Image().src = n.url || fileUrl(n.path);
    }
    renderInfo(item, null);
    getInfo(item).then((info) => {
      if (tok === token && state) renderInfo(item, info);
    });
  }

  async function next() {
    if (idx < list.length - 1) {
      show(idx + 1);
      return;
    }
    if (!loadMore || loadingMore) return;
    loadingMore = true;
    $.next.disabled = true;
    try {
      const more = await loadMore();
      const fresh = (more || []).filter((x) => x && !list.includes(x));
      if (fresh.length) {
        list.push(...fresh);
        show(idx + 1);
      } else {
        loadMore = null;
        updateNav();
      }
    } catch {
      loadMore = null;
      updateNav();
    } finally {
      loadingMore = false;
    }
  }
  function prev() {
    if (idx > 0) show(idx - 1);
  }

  // ---------- 정보 패널 ----------
  function section(title, ...children) {
    return h('section', { class: 'lb-section' }, title ? h('h3', { class: 'lb-section-title' }, title) : null, ...children);
  }
  function kv(rows) {
    const dl = h('dl', { class: 'kv' });
    for (const [k, v] of rows) {
      if (v == null || v === '') continue;
      dl.append(h('dt', {}, k), h('dd', {}, v));
    }
    return dl;
  }

  function renderInfo(item, info) {
    const box = $.info;
    box.replaceChildren(sheetHead);
    const failed = info && info.__error;
    const inf = info && !failed ? info : null;
    const job = inf && inf.job ? inf.job : null;
    const spec = job && job.spec ? job.spec : null;
    let seed = inf && inf.seed != null ? inf.seed : (item.seed != null ? item.seed : parseSeedFromName(item.name || item.path));
    if (seed == null && job && Array.isArray(job.seeds) && job.seeds.length === 1) seed = job.seeds[0];
    const charId = item.character || (spec && spec.character) || charFromPath(item.path);
    const ch = charId ? characterById(charId) : null;
    const positive = (inf && inf.positive) || '';
    const negative = (inf && inf.negative) || '';
    const width = (inf && inf.width) || item.width;
    const height = (inf && inf.height) || item.height;
    // 작업 결과에서 연 항목(itemFromOutput)에는 용량·날짜·종류가 없으므로 /api/gallery/info 값으로 채운다
    const fileSize = item.size ?? (inf ? inf.size : null);
    const fileMtime = item.mtime ?? (inf ? inf.mtime : null);
    const fileKind = item.kind || (inf && inf.kind) || '';
    // 실제로 쓰인 프리셋: 캐릭터 기본 프리셋으로 만든 경우 spec.preset은 비어 있고 job.preset에만 남는다
    const usedPreset = (job && (job.preset || (spec && spec.preset))) || (inf && inf.preset) || item.preset || '';
    const blockReason = engineBlockReason();
    // 쓴 포즈: /api/gallery/info의 pose(실제 적용값·파일 존재 여부) → 작업 기록의 실제 적용값
    const jobPoseVal = job && job.pose && job.pose.name ? job.pose : null;
    const usedPose = (inf && inf.pose && inf.pose.name ? inf.pose : null) || jobPoseVal;

    // ---- 작업 버튼 ----
    const acts = h('div', { class: 'lb-actions' });
    // 원격(휴대폰·다른 PC)에서는 [Finder에서 보기]가 Mac 화면에서만 열리므로 숨기고, 이 기기로 받는 [다운로드]를 맨 앞에 둔다.
    // 원격 다운로드는 서버가 첨부 파일로 보내게(?download=1) 해서 iPhone 등에서도 저장 창이 뜨게 한다.
    const remote = isRemote();
    const fileHref = item.url || fileUrl(item.path);
    const dl = h('a', {
      class: `btn btn-sm${remote ? ' lb-dl-remote' : ''}`,
      href: remote ? `${fileHref}${fileHref.includes('?') ? '&' : '?'}download=1` : fileHref,
      download: item.name || basename(item.path),
    }, '다운로드');
    if (remote) {
      dl.dataset.tooltip = '이 기기(휴대폰·PC)로 원본 PNG를 받습니다';
      acts.append(dl);
    }
    const addBtn = (label, tip, fn, { kind = '', needsEngine = false, disabledReason = '' } = {}) => {
      const b = h('button', { type: 'button', class: `btn btn-sm ${kind ? 'btn-' + kind : ''}` }, label);
      const wrap = h('span', { class: 'btn-guard' }, b);
      const reason = disabledReason || (needsEngine ? blockReason : '');
      if (reason) {
        b.disabled = true;
        wrap.dataset.tooltip = reason;
      } else if (tip) {
        wrap.dataset.tooltip = tip;
      }
      b.addEventListener('click', () => withBusy(b, fn));
      acts.append(wrap);
      return b;
    };

    if (spec) {
      const isSprite = spec.mode === 'sprite';
      addBtn('같은 설정으로 다시', isSprite
        ? '같은 캐릭터·시드·옵션으로 스프라이트 세트를 다시 만듭니다'
        : '같은 프롬프트·모델·옵션으로 새 시드를 써서 1장 더 만듭니다', async () => {
        const s = { ...spec };
        if (!isSprite) {
          s.count = 1;
          s.seed = randomSeed();
        }
        await submitJob(await dropMissingPose(s, usedPose, jobPoseVal || usedPose));
      }, { kind: 'primary', needsEngine: true });
      const fast = spec.hires === false || (!noPeople(spec.mode) && (spec.face === false || spec.hands === false));
      if (fast) {
        addBtn('고품질로 다시', '같은 시드로 하이레즈·얼굴·손 보정을 모두 켜고 다시 만듭니다', async () => {
          const s = { ...spec, hires: true, face: true, hands: true };
          if (spec.mode !== 'sprite') {
            s.count = 1;
            s.seed = seed != null ? seed : (spec.seed != null ? spec.seed : null);
          }
          await submitJob(await dropMissingPose(s, usedPose, jobPoseVal || usedPose));
        }, { needsEngine: true });
      }
    }
    if (charId && seed != null) {
      addBtn('이 시드로 고정', ch
        ? `캐릭터 '${ch.name || charId}'의 시드를 ${seed}로 저장합니다. 이후 시안(1장)·스프라이트가 이 체형과 구도를 기준으로 만들어집니다`
        : '', async () => {
        await api(`/api/characters/${encodeURIComponent(charId)}/seed`, { method: 'POST', body: { seed } });
        toast(`'${(ch && ch.name) || charId}' 캐릭터의 시드를 ${seed}로 고정했습니다.`, 'success');
        emit('character-seed', { id: charId, seed });
        loadCharacters();
      }, { disabledReason: ch ? '' : `캐릭터 '${charId}'를 찾을 수 없습니다` });
    }
    const hasPrompt = !!(spec || positive);
    if (hasPrompt || !info) {
      addBtn('생성 탭에서 편집', '이 이미지의 프롬프트와 설정을 생성 탭에 불러옵니다', async () => {
        emit('generate:load', { spec, positive, negative, seed, preset: usedPreset, pose: usedPose });
        close();
        location.hash = '#/generate';
      }, { disabledReason: hasPrompt ? '' : '정보를 불러오는 중입니다' });
      addBtn('프롬프트 복사', '긍정 프롬프트 전체를 클립보드에 복사합니다', async () => {
        const text = positive || (spec && spec.prompt) || '';
        if (await copyText(text)) toast('프롬프트를 복사했습니다.', 'success');
        else toast('복사하지 못했습니다. 정보 패널에서 직접 선택해 복사하세요.', 'warn');
      }, { disabledReason: positive || (spec && spec.prompt) ? '' : '정보를 불러오는 중입니다' });
    }
    addBtn('태그 추출', '이 이미지에서 Danbooru 태그를 자동으로 뽑아 프롬프트를 만듭니다 (프롬프트 추출 탭)', async () => {
      close();
      location.hash = '#/extract' + qs({ path: item.path });
    });
    if (!remote) {
      addBtn('Finder에서 보기', '이 파일을 Finder에서 선택해 보여 줍니다', async () => {
        await api('/api/gallery/reveal', { method: 'POST', body: { path: item.path } });
      });
      acts.append(dl);
    }
    addBtn('삭제', '휴지통(output/.trash)으로 옮깁니다', () => removeCurrent(item), { kind: 'danger-ghost' });
    box.append(section('', acts));

    // ---- 생성 정보 ----
    if (!info) {
      box.append(section('생성 정보', h('div', { class: 'loading-row' }, h('span', { class: 'spinner' }), h('span', {}, '정보를 불러오는 중…'))));
    } else if (failed) {
      box.append(section('생성 정보', h('p', { class: 'muted' }, info.__error)));
    } else {
      if (positive || (spec && spec.prompt)) {
        const text = positive || spec.prompt;
        const copyBtn = h('button', { type: 'button', class: 'btn btn-xs btn-ghost' }, '복사');
        copyBtn.addEventListener('click', async () => {
          if (await copyText(text)) toast('프롬프트를 복사했습니다.', 'success');
        });
        box.append(section('프롬프트', h('div', { class: 'lb-prompt' }, text), h('div', { class: 'lb-row-end' }, copyBtn)));
      }
      if (negative) {
        const det = h('details', { class: 'lb-details' }, h('summary', {}, '네거티브 프롬프트'), h('div', { class: 'lb-prompt lb-prompt-neg' }, negative));
        box.append(section('', det));
      }
      const loras = (inf.loras && inf.loras.length ? inf.loras : (spec && spec.loras) || []).map(loraText).filter(Boolean);
      const sampling = [
        inf.sampler ? `${inf.sampler}${inf.scheduler ? ` / ${inf.scheduler}` : ''}` : '',
        inf.steps != null ? `${inf.steps}스텝` : '',
        inf.cfg != null ? `CFG ${inf.cfg}` : '',
      ].filter(Boolean).join(' · ');
      const rows = [
        ['시드', seed != null ? String(seed) : null],
        ['모델', inf.ckpt || null],
        ['프리셋', usedPreset ? presetLabel(usedPreset) : null],
        ['샘플링', sampling || null],
        ['캐릭터', ch ? `${ch.name || charId} (${charId})` : charId],
        ['LoRA', loras.length ? h('div', { class: 'lb-loras' }, loras.map((t) => h('div', {}, t))) : null],
      ];
      if (spec) {
        rows.push(['방식', MODE_LABELS[spec.mode] || spec.mode]);
        const flags = [];
        flags.push(spec.hires === false ? '하이레즈 끔' : '하이레즈');
        if (!noPeople(spec.mode)) {
          flags.push(spec.face === false ? '얼굴 보정 끔' : '얼굴 보정');
          flags.push(spec.hands === false ? '손 보정 끔' : '손 보정');
        }
        rows.push(['품질', flags.join(' · ')]);
        const poseSize = !spec.size && jobPoseVal && Array.isArray(jobPoseVal.size) ? jobPoseVal.size : null;
        rows.push(['요청 크기', poseSize ? `포즈 크기 ${poseSize[0]}×${poseSize[1]}` : sizeLabel(spec.size, spec.mode)]);
      }
      const hasRows = rows.some(([, v]) => v != null && v !== '');
      if (hasRows) box.append(section('생성 정보', kv(rows)));
      const pb = usedPose ? poseInfoBlock(usedPose) : null;
      if (pb) box.append(section('포즈 (ControlNet)', pb));
      if (!positive && !spec) {
        box.append(section(hasRows ? '' : '생성 정보', h('p', { class: 'muted small' }, '이 이미지에는 생성 정보(프롬프트)가 기록되어 있지 않습니다. 외부에서 만들었거나 편집된 파일일 수 있습니다.')));
      }
    }

    // ---- 파일 정보 ----
    box.append(section('파일', kv([
      ['이름', item.name || basename(item.path)],
      ['폴더', `output/${dirname(item.path)}`.replace(/\/$/, '')],
      ['해상도', width && height ? `${width}×${height}` : null],
      ['용량', fileSize ? fmtBytes(fileSize) : null],
      ['날짜', fileMtime ? fmtDateTime(fileMtime) : null],
      ['종류', fileKind ? (KIND_LABELS[fileKind] || fileKind) : null],
    ])));
  }

  async function removeCurrent(item) {
    const ok = await confirmDialog({
      title: '이미지 삭제',
      message: `'${item.name || basename(item.path)}'을(를) 휴지통으로 옮길까요?`,
      detail: isRemote()
        ? 'Mac의 output/.trash 폴더로 이동하므로, 필요하면 Mac의 Finder에서 되살릴 수 있습니다.'
        : 'output/.trash 폴더로 이동하므로, 필요하면 Finder에서 되살릴 수 있습니다.',
      confirmText: '휴지통으로 이동',
      danger: true,
    });
    if (!ok) return;
    await api('/api/gallery/delete', { method: 'POST', body: { paths: [item.path] } });
    toast('휴지통으로 옮겼습니다.', 'success');
    infoCache.delete(item.path);
    try {
      if (opts.onDelete) opts.onDelete(item);
    } catch (e) {
      console.error(e);
    }
    emit('gallery-changed', { deleted: [item.path] });
    const i = list.indexOf(item);
    if (i >= 0) list.splice(i, 1);
    if (!state) return;
    if (!list.length) close();
    else show(Math.min(i < 0 ? idx : i, list.length - 1));
  }

  // ---------- 이벤트 ----------
  $.close.addEventListener('click', () => close());
  $.prev.addEventListener('click', prev);
  $.next.addEventListener('click', () => next());
  $.infoToggle.addEventListener('click', () => setInfoOpen(!infoOpen));
  $.zoom.addEventListener('click', () => setZoom(!$.stage.classList.contains('zoomed')));
  let swipedAt = 0;
  $.img.addEventListener('click', () => {
    if (Date.now() - swipedAt < 400) return;
    setZoom(!$.stage.classList.contains('zoomed'));
  });
  $.stage.addEventListener('click', (e) => {
    if (Date.now() - swipedAt < 400) return;
    if (e.target === $.stage && !$.stage.classList.contains('zoomed')) close();
  });

  // 터치: 좌우로 밀면 이전/다음, 아래로 밀면 닫기 (원본 크기로 확대한 동안에는 스크롤에 양보)
  let sw = null;
  const resetDrag = () => {
    $.img.style.transition = 'transform 0.18s ease, opacity 0.18s ease';
    $.img.style.transform = '';
    $.img.style.opacity = '';
    setTimeout(() => { if ($.img) $.img.style.transition = ''; }, 200);
  };
  $.stage.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || $.stage.classList.contains('zoomed')) {
      if (sw && sw.axis) resetDrag();
      sw = null;
      return;
    }
    const t = e.touches[0];
    sw = { x: t.clientX, y: t.clientY, dx: 0, dy: 0, axis: '' };
  }, { passive: true });
  $.stage.addEventListener('touchmove', (e) => {
    if (!sw) return;
    const t = e.touches[0];
    sw.dx = t.clientX - sw.x;
    sw.dy = t.clientY - sw.y;
    if (!sw.axis && Math.hypot(sw.dx, sw.dy) > 10) sw.axis = Math.abs(sw.dx) > Math.abs(sw.dy) ? 'x' : 'y';
    if (sw.axis === 'x') {
      $.img.style.transform = `translateX(${sw.dx}px)`;
    } else if (sw.axis === 'y' && sw.dy > 0) {
      $.img.style.transform = `translateY(${sw.dy}px)`;
      $.img.style.opacity = String(Math.max(0.35, 1 - sw.dy / 400));
    }
  }, { passive: true });
  $.stage.addEventListener('touchend', () => {
    if (!sw) return;
    const { dx, dy, axis } = sw;
    sw = null;
    if (!axis) return;
    swipedAt = Date.now();
    resetDrag();
    if (axis === 'x' && Math.abs(dx) > 50) {
      if (dx < 0) next();
      else prev();
    } else if (axis === 'y' && dy > 110) {
      close();
    }
  });
  $.stage.addEventListener('touchcancel', () => {
    if (sw && sw.axis) resetDrag();
    sw = null;
  });

  const popLayer = pushLayer({
    onKey: (e) => {
      const t = e.target;
      const typing = t instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if ($.stage.classList.contains('zoomed')) setZoom(false);
        else close();
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        prev();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        next();
      } else if (e.key === 'i' || e.key === 'I' || e.key === 'ㅑ') {
        e.preventDefault();
        setInfoOpen(!infoOpen);
      } else if (e.key === 'Tab') {
        const lb = root.querySelector('.lb');
        const items = [...lb.querySelectorAll('a[href], button:not([disabled]), summary')].filter((x) => x.offsetParent !== null);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && (document.activeElement === first || !lb.contains(document.activeElement))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (document.activeElement === last || !lb.contains(document.activeElement))) {
          e.preventDefault();
          first.focus();
        }
      }
    },
  });

  function close() {
    if (!state) return;
    state = null;
    token++;
    popLayer();
    root.hidden = true;
    root.replaceChildren();
    document.body.classList.remove('lb-open');
    try {
      if (prevFocus && typeof prevFocus.focus === 'function' && document.contains(prevFocus)) prevFocus.focus();
    } catch { /* 무시 */ }
  }

  state = { close };
  show(idx);
  setTimeout(() => $.close && $.close.focus(), 30);
}

// 엔진 상태가 바뀌면 열려 있는 라이트박스의 버튼 상태를 새로 그리도록 외부에서 호출할 수 있게 둔다
export function invalidateLightboxInfo(path) {
  if (path) infoCache.delete(path);
  else infoCache.clear();
}
