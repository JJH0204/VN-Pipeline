// VN Studio 진입점: 라우터, 상단 바, 엔진 제어, 실시간 이벤트(SSE), 알림
import { h, lsGet, lsSet, fmtBytes, fmtDuration, debounce } from './util.js';
import {
  initTooltips, applyTips, toast, confirmDialog, openMenu, withBusy, unsavedDialog,
} from './ui.js';
import { api } from './api.js';
import {
  store, on, setStatus, loadStatus, loadPresets, loadSettings, loadModels, loadCharacters, loadJobs, loadDownloads,
  loadTips, loadHelpIndex, upsertJob, upsertDownload, setSse, activeJobs, comfy, emit, statusStale,
} from './store.js';
import { route, parseHash, replaceHash } from './router.js';
import { openEngineLog, jobTitle, stageText, jobPercent, openJobOutputs, showJobError, itemFromOutput } from './components.js';
import { closeLightbox } from './lightbox.js';
import { initRemote, isRemote, LOCAL_ONLY_HINT } from './remote.js';
import { initSecret, secretState, toggleSecret } from './secret.js';
import { isPhone } from './mobile.js';
import { createGenerateView } from './views/generate.js';
import { createCharactersView } from './views/characters.js';
import { createBackgroundsView } from './views/backgrounds.js';
import { createPixelView } from './views/pixel.js';
import { createIconsView } from './views/icons.js';
import { createSheetView } from './views/sheet.js';
import { createExtractView } from './views/extract.js';
import { createGalleryView } from './views/gallery.js';
import { createJobsView } from './views/jobs.js';
import { createModelsView } from './views/models.js';
import { createHelpView } from './views/help.js';

const $id = (id) => document.getElementById(id);

// ======================= 전역 오류 처리 =======================
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  e.preventDefault();
  if (r && (r.name === 'ApiError' || r.aborted || r.name === 'AbortError')) return;
  console.error(r);
  toast(`예기치 않은 오류가 발생했습니다: ${(r && r.message) || r}`, 'error');
});
let lastScriptError = 0;
window.addEventListener('error', (e) => {
  if (!e || !e.message) return; // 이미지 로드 실패 등은 무시
  console.error(e.error || e.message);
  if (Date.now() - lastScriptError > 10000) {
    lastScriptError = Date.now();
    toast('화면 처리 중 오류가 발생했습니다. 문제가 계속되면 새로고침(⌘R)해 주세요.', 'error');
  }
});

// ======================= 테마 =======================
const THEMES = ['auto', 'dark', 'light'];
const THEME_LABEL = { auto: '테마: 시스템 설정 따름', dark: '테마: 다크', light: '테마: 라이트' };
const THEME_ICON = { auto: '◐', dark: '☾', light: '☀' };
function applyTheme(t) {
  if (!THEMES.includes(t)) t = 'auto';
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  const btn = $id('theme-toggle');
  if (btn) {
    btn.textContent = THEME_ICON[t];
    btn.dataset.tooltip = `${THEME_LABEL[t]} (눌러서 바꾸기)`;
    btn.setAttribute('aria-label', THEME_LABEL[t]);
  }
  lsSet('vn.theme', t);
}

// ======================= 뷰 / 라우터 =======================
const FACTORIES = {
  generate: createGenerateView,
  characters: createCharactersView,
  backgrounds: createBackgroundsView,
  sheet: createSheetView,
  pixel: createPixelView,
  icons: createIconsView,
  extract: createExtractView,
  gallery: createGalleryView,
  jobs: createJobsView,
  models: createModelsView,
  help: createHelpView,
};
const views = new Map();
const mounted = new Set();
const scrollPos = new Map();
let currentView = null;

function getView(id) {
  if (!views.has(id)) views.set(id, FACTORIES[id]());
  return views.get(id);
}

async function handleRoute() {
  // '#main' 같은 페이지 안 앵커(본문으로 건너뛰기 등)는 화면 이동이 아니라 그 요소로 초점만 옮긴다
  const rawHash = location.hash;
  if (currentView && rawHash.length > 1 && !rawHash.startsWith('#/')) {
    let target = null;
    try {
      target = document.getElementById(decodeURIComponent(rawHash.slice(1)));
    } catch {
      target = null;
    }
    if (target) {
      replaceHash(route.lastHash || `#/${currentView.id}`);
      try { target.focus(); } catch { /* 무시 */ }
      return;
    }
  }
  const r = parseHash();
  if (!FACTORIES[r.view]) {
    replaceHash('#/generate');
    r.view = 'generate';
    r.params = [];
  }
  if (currentView && r.view !== currentView.id && typeof currentView.isDirty === 'function' && currentView.isDirty()) {
    const choice = await unsavedDialog(currentView.dirtyLabel || '변경 사항', typeof currentView.save === 'function');
    if (choice === null) {
      replaceHash(route.lastHash || `#/${currentView.id}`);
      return;
    }
    if (choice === 'save') {
      let ok = false;
      try {
        ok = await currentView.save();
      } catch (e) {
        console.error(e);
      }
      if (!ok) {
        replaceHash(route.lastHash || `#/${currentView.id}`);
        return;
      }
    } else if (choice === 'discard') {
      try {
        if (currentView.discard) currentView.discard();
      } catch (e) {
        console.error(e);
      }
    }
  }
  closeLightbox();
  const view = getView(r.view);
  const section = $id(`view-${r.view}`);
  if (!section) return;
  if (!mounted.has(r.view)) {
    mounted.add(r.view);
    try {
      view.mount(section);
    } catch (e) {
      console.error(e);
      section.replaceChildren(h('div', { class: 'panel' }, h('div', { class: 'empty-state' },
        h('div', { class: 'empty-icon' }, '!'),
        h('div', { class: 'empty-title' }, '이 화면을 여는 중 오류가 발생했습니다'),
        h('div', { class: 'empty-text' }, String((e && e.message) || e)))));
    }
  }
  const switching = currentView !== view;
  if (switching && currentView) {
    scrollPos.set(currentView.id, window.scrollY);
    try {
      if (currentView.hide) currentView.hide();
    } catch (e) {
      console.error(e);
    }
    const prev = $id(`view-${currentView.id}`);
    if (prev) prev.hidden = true;
  }
  section.hidden = false;
  currentView = view;
  route.lastHash = location.hash || `#/${r.view}`;
  updateTabs(r.view);
  if (switching) {
    const y = scrollPos.get(r.view) || 0;
    window.scrollTo(0, y);
  }
  try {
    await view.show(r.params, r.query);
  } catch (e) {
    console.error(e);
  }
  route.lastHash = location.hash || route.lastHash;
  const tab = document.querySelector(`.tab[data-view="${r.view}"]`);
  if (tab && route.lastHash.startsWith(`#/${r.view}`)) tab.setAttribute('href', route.lastHash);
  updateTitle();
}

let routeChain = Promise.resolve();
function enqueueRoute() {
  routeChain = routeChain.then(handleRoute).catch((e) => console.error(e));
}

function updateTabs(id) {
  document.querySelectorAll('.tab[data-view]').forEach((t) => {
    const on_ = t.dataset.view === id;
    t.classList.toggle('active', on_);
    if (on_) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
  });
}

function runningJob() {
  return activeJobs().filter((j) => j.status === 'running').sort((a, b) => (b.started || 0) - (a.started || 0))[0] || null;
}

function updateTitle() {
  const base = currentView ? `${currentView.title} — VN Studio` : 'VN Studio';
  const j = runningJob();
  document.title = j ? `${Math.floor(jobPercent(j))}% · ${base}` : base;
}

// ======================= 상단 바 =======================
let startingSince = 0;
function renderEngine() {
  // 서버와 연결이 끊긴 지 오래면 마지막으로 받은 상태(예: 엔진 실행 중)를 보여 주지 않는다
  const s = statusStale() ? null : store.status;
  const c = s ? comfy() : {};
  const badge = $id('engine-badge');
  const dot = $id('engine-dot');
  const text = $id('engine-text');
  let state;
  let label;
  let short; // 휴대폰 상단 바용 짧은 글자 (자세한 내용은 배지를 눌러 툴팁으로)
  let sym;
  if (!s) {
    const off = store.sse === 'offline' || store.sse === 'reconnecting';
    state = off ? 'offline' : 'unknown';
    sym = off ? '×' : '◌';
    label = off ? 'Studio 연결 끊김' : '상태 확인 중…';
    short = off ? '연결 끊김' : '확인 중';
  } else if (c.running) {
    state = 'running';
    sym = '●';
    label = '엔진 실행 중';
    short = '실행 중';
  } else if (c.starting) {
    state = 'starting';
    sym = '◌';
    label = '엔진 시작 중';
    short = '시작 중';
  } else {
    state = 'off';
    sym = '○';
    label = '엔진 꺼짐';
    short = '엔진 꺼짐';
  }
  badge.className = `engine-badge is-${state}`;
  dot.textContent = sym;
  text.textContent = label;
  $id('engine-short').textContent = short;
  const tip = [];
  if (s) {
    tip.push(c.running ? `ComfyUI ${c.version || ''}`.trim() : 'ComfyUI 엔진');
    if (c.url) tip.push(c.url);
    if (c.running || c.starting) tip.push(c.managed ? 'VN Studio가 실행한 엔진' : '외부에서 실행된 엔진');
    if (c.ram_free != null) tip.push(`여유 메모리 ${fmtBytes(c.ram_free)}`);
    if (c.running) tip.push(`엔진 대기열: 실행 ${c.queue_running || 0} · 대기 ${c.queue_pending || 0}`);
    if (!c.running && !c.starting && c.error) tip.push(`마지막 오류: ${c.error}`);
  } else {
    tip.push('Studio 서버에서 상태를 받아오지 못했습니다.');
  }
  badge.dataset.tooltip = tip.join('\n');

  $id('engine-start').hidden = !s || c.running || c.starting;
  $id('engine-stop').hidden = !s || !(c.running || (c.starting && c.managed));
  $id('engine-restart').hidden = !s || !c.running;

  if (c.starting && !startingSince) startingSince = Date.now();
  if (!c.starting) startingSince = 0;
  renderBanner();
}

function renderBanner() {
  const s = statusStale() ? null : store.status;
  const c = s ? comfy() : {};
  const banner = $id('engine-banner');
  const text = $id('banner-text');
  const start = $id('banner-start');
  const logBtn = $id('banner-log');
  if (!s) {
    if (store.sse === 'offline' || store.sse === 'reconnecting') {
      banner.hidden = false;
      banner.className = 'banner banner-error';
      text.textContent = 'Studio 서버와 연결이 끊겼습니다. 자동으로 다시 연결하는 중입니다… (계속되면 VN Studio 앱을 다시 실행하세요)';
      start.hidden = true;
      logBtn.hidden = true;
    } else {
      banner.hidden = true;
    }
    return;
  }
  if (c.running) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  logBtn.hidden = false;
  if (c.starting) {
    banner.className = 'banner banner-info';
    const sec = startingSince ? Math.round((Date.now() - startingSince) / 1000) : 0;
    text.textContent = `엔진(ComfyUI)을 시작하는 중입니다… 보통 20~60초 걸립니다.${sec ? ` (${fmtDuration(sec)} 경과)` : ''}`;
    start.hidden = true;
  } else if (c.error) {
    // 시작 실패·시간 초과·비정상 종료 등: 서버가 알려 준 이유를 그대로 보여 준다
    banner.className = 'banner banner-error';
    text.textContent = `엔진이 꺼져 있습니다 · ${c.error}`;
    start.hidden = false;
  } else {
    banner.className = 'banner banner-warn';
    text.textContent = '엔진이 꺼져 있습니다. 이미지를 만들려면 엔진을 시작하세요. 모델·캐릭터 편집과 갤러리는 지금도 사용할 수 있습니다.';
    start.hidden = false;
  }
}

// 엔진 오류(시작 실패 등)가 새로 생기면 한 번 알린다. 첫 상태(새로고침 직후)의 기존 오류는 배너로만 보여 준다.
let seenEngineError;
function engineErrorToast(msg) {
  // 같은 종류·제목·문구는 toast()가 2.5초 안에 한 번만 보여 주므로, SSE와 HTTP 응답이 겹쳐도 중복되지 않는다
  toast(msg, 'error', {
    title: '엔진 오류',
    action: { label: '로그 보기', onClick: openEngineLog },
    timeout: 12000,
  });
}
function checkEngineError() {
  if (!store.status) return;
  const c = comfy();
  const err = !c.running && !c.starting && c.error ? String(c.error) : '';
  if (seenEngineError !== undefined && err && err !== seenEngineError) engineErrorToast(err);
  seenEngineError = err;
}
// 손상된 설정 파일을 서버가 기본값으로 복구한 경우 한 번씩 알린다
const seenConfigWarnings = new Set();
function checkConfigWarnings() {
  const list = (store.status && store.status.config_warnings) || [];
  for (const msg of list) {
    if (seenConfigWarnings.has(msg)) continue;
    seenConfigWarnings.add(msg);
    toast(String(msg), 'warn', { title: '설정 파일 복구됨', timeout: 20000 });
  }
}
/** 엔진 시작/재시작 요청 실패 처리 (api는 silent로 호출) */
function onEngineRequestError(e) {
  if (e && e.aborted) return;
  const msg = (e && e.message) || '엔진을 시작하지 못했습니다.';
  if (e && e.status > 0) {
    engineErrorToast(msg);
    seenEngineError = msg; // 곧 들어올 상태 이벤트에서 같은 오류를 다시 알리지 않도록
  } else {
    toast(msg, 'error');
  }
  loadStatus();
}

function renderJobsSummary() {
  const act = activeJobs();
  const run = runningJob();
  const queued = act.filter((j) => j.status === 'queued').length;
  const pill = $id('queue-count');
  pill.hidden = !act.length;
  pill.textContent = `대기열 ${act.length}`;
  pill.dataset.tooltip = `진행 ${run ? 1 : 0} · 대기 ${queued}\n${act.slice(0, 6).map((j) => `• ${jobTitle(j)}`).join('\n')}${act.length > 6 ? '\n…' : ''}`;
  const badge = $id('tab-badge-jobs');
  badge.hidden = !act.length;
  badge.textContent = String(act.length);

  const cur = $id('current-job');
  const gp = $id('global-progress');
  if (run) {
    const pct = jobPercent(run);
    cur.hidden = false;
    $id('current-job-text').textContent = `${(run.progress && run.progress.stage) || '준비 중'} · ${Math.floor(pct)}%`;
    $id('current-job-bar').style.width = `${pct}%`;
    cur.dataset.tooltip = `${jobTitle(run)}\n${stageText(run)}`;
    gp.hidden = false;
    $id('global-progress-bar').style.width = `${pct}%`;
  } else {
    cur.hidden = true;
    gp.hidden = true;
  }
  updateTitle();
}

function renderSse() {
  const el = $id('sse-indicator');
  const map = {
    open: ['is-open', '실시간', '서버와 실시간으로 연결되어 있습니다. 진행 상황이 즉시 반영됩니다.'],
    connecting: ['is-connecting', '연결 중', '서버에 연결하는 중입니다.'],
    reconnecting: ['is-reconnecting', '재연결 중', '실시간 연결이 끊겨 다시 연결하는 중입니다. 그동안은 몇 초 간격으로 상태를 확인합니다.'],
    offline: ['is-offline', '연결 끊김', 'Studio 서버에 연결할 수 없습니다. 서버가 꺼졌을 수 있습니다. 자동으로 계속 다시 시도합니다.'],
  };
  const [cls, label, tip] = map[store.sse] || map.connecting;
  el.className = `sse-indicator ${cls}`;
  $id('sse-text').textContent = label;
  el.dataset.tooltip = tip;
}

function renderDownloadsPill() {
  const n = (store.status && store.status.downloads) || [...store.downloads.values()].filter((d) => d.status === 'running').length;
  const pill = $id('dl-pill');
  pill.hidden = !n;
  pill.textContent = `다운로드 ${n}`;
}

// ======================= 엔진 제어 =======================
let pollTimer = null;
function pollWhileStarting() {
  clearInterval(pollTimer);
  const t0 = Date.now();
  pollTimer = setInterval(async () => {
    await loadStatus();
    const c = comfy();
    if (c.running || (!c.starting && Date.now() - t0 > 8000) || Date.now() - t0 > 180000) clearInterval(pollTimer);
  }, 2500);
}

async function engineStart(btn) {
  await withBusy(btn, async () => {
    let r;
    try {
      r = await api('/api/comfy/start', { method: 'POST', timeout: 20000, silent: true });
    } catch (e) {
      onEngineRequestError(e);
      return;
    }
    if (r && r.running && !r.starting) {
      // 다른 곳에서 이미 켜 둔 엔진을 찾은 경우
      toast(r.message || '엔진이 이미 실행 중입니다.', 'info');
      loadStatus();
      return;
    }
    toast('엔진을 시작합니다. 보통 20~60초 걸립니다. 준비되면 생성 버튼이 활성화됩니다.', 'info');
    if (store.status) setStatus({ ...store.status, comfy: { ...comfy(), starting: true, error: null } });
    pollWhileStarting();
  });
}

async function confirmInterrupt(action) {
  const act = activeJobs();
  if (!act.length) return true;
  return confirmDialog({
    title: `엔진 ${action}`,
    message: `진행 중이거나 대기 중인 작업 ${act.length}개가 있습니다. 엔진을 ${action}하면 이 작업들이 중단됩니다.`,
    detail: '이미 저장된 이미지는 그대로 남습니다.',
    confirmText: `${action}`,
    danger: true,
  });
}

async function engineStop(btn) {
  if (!(await confirmInterrupt('중지'))) return;
  await withBusy(btn, async () => {
    try {
      await api('/api/comfy/stop', { method: 'POST', timeout: 20000 });
    } catch {
      return;
    }
    toast('엔진을 중지했습니다.', 'info');
    setTimeout(loadStatus, 800);
    setTimeout(loadStatus, 3000);
  });
}

async function engineRestart(btn) {
  if (!(await confirmInterrupt('재시작'))) return;
  await withBusy(btn, async () => {
    let r;
    try {
      r = await api('/api/comfy/restart', { method: 'POST', timeout: 30000, silent: true });
    } catch (e) {
      onEngineRequestError(e);
      return;
    }
    toast('엔진을 다시 시작합니다. 잠시 기다려 주세요.', 'info');
    if (r && r.starting && store.status) {
      setStatus({ ...store.status, comfy: { ...comfy(), running: false, starting: true, error: null } });
    }
    pollWhileStarting();
  });
}

// ======================= 메뉴 / 종료 =======================
let stopped = false;
async function shutdownStudio() {
  if (isRemote()) {
    // 서버도 막지만(403), 원격에서 끄면 다시 켤 방법이 없으므로 묻지도 않는다
    toast('원격에서는 VN Studio를 종료할 수 없습니다. 다시 켤 방법이 없기 때문입니다. 종료는 Mac에서 하세요.', 'warn');
    return;
  }
  const dirty = [...views.values()].some((v) => mounted.has(v.id) && v.isDirty && v.isDirty());
  const c = comfy();
  const ok = await confirmDialog({
    title: 'VN Studio 종료',
    message: dirty ? '저장하지 않은 변경 사항이 있습니다. 그래도 VN Studio를 종료할까요?' : 'VN Studio를 종료할까요?',
    detail: (secretState().enabled ? '시크릿 모드가 켜져 있어 그동안 만든 작업 기록과 그림이 삭제됩니다. ' : '')
      + (c.managed && (c.running || c.starting)
        ? 'Studio가 실행한 엔진(ComfyUI)도 함께 종료되며, 진행 중인 생성은 중단됩니다.'
        : '엔진(ComfyUI)이 외부에서 실행 중이라면 그대로 둡니다.'),
    confirmText: '종료',
    danger: true,
  });
  if (!ok) return;
  try {
    await api('/api/shutdown', { method: 'POST', timeout: 10000 });
  } catch (e) {
    if (!e || e.status !== 0) return;
  }
  stopped = true;
  closeSse();
  document.body.append(h('div', { class: 'shutdown-overlay', role: 'alertdialog', 'aria-label': 'VN Studio 종료됨' },
    h('div', { class: 'shutdown-card' },
      h('div', { class: 'brand-mark big', 'aria-hidden': 'true' }, 'VN'),
      h('h2', {}, 'VN Studio가 종료되었습니다'),
      h('p', {}, '이 창을 닫아도 됩니다. 다시 사용하려면 VN Studio 앱을 실행하세요.'))));
}

function openAppMenu(anchor) {
  const openFolder = (which) => api('/api/open-folder', { method: 'POST', body: { which } }).catch(() => {});
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  // 원격(휴대폰·다른 PC)에서는 Mac 화면에서 Finder를 여는 폴더 항목을 숨기고, 종료는 이유와 함께 비활성
  const remote = isRemote();
  // 휴대폰: 좁은 상단 바에서 뺀 엔진 시작/중지/재시작·다운로드·테마를 이 메뉴에 둔다 (상단 바 버튼과 같은 조건)
  const phoneItems = [];
  if (isPhone()) {
    if (!$id('engine-start').hidden) phoneItems.push({ label: '엔진 시작', onClick: () => engineStart(null) });
    if (!$id('engine-restart').hidden) phoneItems.push({ label: '엔진 재시작', onClick: () => engineRestart(null) });
    if (!$id('engine-stop').hidden) phoneItems.push({ label: '엔진 중지', danger: true, onClick: () => engineStop(null) });
    if (!$id('dl-pill').hidden) phoneItems.push({ label: $id('dl-pill').textContent || '다운로드', hint: '진행 중', onClick: () => { location.hash = '#/models/downloads'; } });
    if (phoneItems.length) phoneItems.push('-');
  }
  const theme = lsGet('vn.theme', 'auto');
  openMenu(anchor, [
    ...phoneItems,
    { label: '엔진 로그 보기', onClick: openEngineLog },
    '-',
    ...(remote ? [] : [
      { label: '출력 폴더 열기', hint: 'output/', onClick: () => openFolder('output') },
      { label: '캐릭터 폴더 열기', hint: 'characters/', onClick: () => openFolder('characters') },
      { label: '모델 폴더 열기', hint: 'models/checkpoints', onClick: () => openFolder('models_checkpoints') },
      { label: 'LoRA 폴더 열기', hint: 'models/loras', onClick: () => openFolder('models_loras') },
      { label: '설정 폴더 열기', hint: 'config/', onClick: () => openFolder('config') },
      '-',
    ]),
    { label: secretState().enabled ? '시크릿 모드 끄기' : '시크릿 모드 켜기', hint: secretState().enabled ? '그동안의 작업 삭제' : '테스트·시연용', danger: secretState().enabled, onClick: toggleSecret },
    { label: '원격 접속 (Tailscale)', hint: remote ? '접속 정보' : '휴대폰·다른 PC', onClick: () => { location.hash = '#/models/settings/remote'; } },
    {
      label: perm === 'granted' ? '완료 알림: 켜짐' : perm === 'denied' ? '완료 알림: 차단됨' : '완료 알림 켜기',
      hint: perm === 'denied' ? '브라우저 설정에서 허용' : '',
      disabled: perm === 'granted' || perm === 'denied' || perm === 'unsupported',
      onClick: () => {
        try {
          const p = Notification.requestPermission();
          if (p && p.then) p.then((r) => { if (r === 'granted') toast('작업이 끝나면 알림을 보내 드릴게요.', 'success'); }).catch(() => {});
        } catch { /* 무시 */ }
      },
    },
    ...(isPhone() ? [{
      label: `${THEME_ICON[THEMES.includes(theme) ? theme : 'auto']} ${THEME_LABEL[THEMES.includes(theme) ? theme : 'auto']}`,
      hint: '눌러서 바꾸기',
      onClick: () => applyTheme(THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]),
    }] : []),
    { label: '도움말', onClick: () => { location.hash = '#/help'; } },
    '-',
    remote
      ? { label: 'VN Studio 종료', hint: `${LOCAL_ONLY_HINT} · 원격에서 끄면 다시 켤 수 없음`, disabled: true }
      : { label: 'VN Studio 종료', danger: true, onClick: shutdownStudio },
  ], { align: 'right' });
}

// ======================= 알림 =======================
function notify(title, body, icon, tag) {
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (document.visibilityState === 'visible' && document.hasFocus()) return;
    const n = new Notification(title, { body, icon: icon || undefined, tag: tag || undefined });
    n.onclick = () => {
      try { window.focus(); } catch { /* 무시 */ }
      n.close();
    };
  } catch { /* 일부 환경에서는 생성자 사용 불가 */ }
}

function onJobTransition(job, prev) {
  if (!prev || prev.status === job.status) return;
  if (job.status === 'done') {
    const outs = job.outputs || [];
    toast(`${jobTitle(job)} · ${outs.length}장 저장됨`, 'success', {
      title: '생성 완료',
      action: outs.length ? { label: '보기', onClick: () => openJobOutputs(job, 0) } : null,
      timeout: 7000,
    });
    const first = outs[0] ? itemFromOutput(outs[0]) : null;
    notify('VN Studio · 생성 완료', `${jobTitle(job)} (${outs.length}장)`, first && first.thumb, job.id);
  } else if (job.status === 'error') {
    const msg = job.error || '알 수 없는 오류';
    toast(msg.length > 140 ? msg.slice(0, 140) + '…' : msg, 'error', {
      title: `생성 실패 · ${jobTitle(job)}`,
      action: { label: '자세히', onClick: () => showJobError(job) },
    });
    notify('VN Studio · 생성 실패', jobTitle(job), null, job.id);
  }
}

// ======================= SSE =======================
let es = null;
let retry = 0;
let lastMsg = 0;
let reconnectTimer = null;
let everOpened = false;

function closeSse() {
  clearTimeout(reconnectTimer);
  if (es) {
    try { es.close(); } catch { /* 무시 */ }
  }
  es = null;
}

function resync() {
  loadStatus();
  loadJobs();
  loadDownloads();
}

function connectSse() {
  if (stopped) return;
  closeSse();
  setSse(everOpened ? 'reconnecting' : 'connecting');
  let src;
  try {
    src = new EventSource('/api/events');
  } catch {
    scheduleReconnect();
    return;
  }
  es = src;
  const handle = (type, fn) => {
    src.addEventListener(type, (e) => {
      lastMsg = Date.now();
      let data;
      try {
        data = JSON.parse(e.data);
      } catch {
        return;
      }
      try {
        fn(data);
      } catch (err) {
        console.error(err);
      }
    });
  };
  src.onopen = () => {
    if (es !== src) return;
    lastMsg = Date.now();
    retry = 0;
    const was = everOpened;
    everOpened = true;
    setSse('open');
    if (was) resync();
  };
  src.onmessage = () => { lastMsg = Date.now(); };
  handle('status', setStatus);
  handle('job', upsertJob);
  handle('preview', (d) => {
    if (!d || !d.job_id) return;
    store.previews.set(d.job_id, d.t || Date.now());
    emit('preview', d);
  });
  handle('download', upsertDownload);
  handle('log', (d) => emit('log', d));
  src.onerror = () => {
    if (es !== src || stopped) return;
    if (src.readyState === EventSource.CLOSED) scheduleReconnect();
    else setSse(everOpened ? 'reconnecting' : 'connecting');
  };
}

function scheduleReconnect() {
  closeSse();
  if (stopped) return;
  setSse(retry >= 3 ? 'offline' : 'reconnecting');
  const delay = Math.min(1000 * 2 ** retry, 15000);
  retry++;
  reconnectTimer = setTimeout(connectSse, delay);
}

// ======================= 부트 =======================
function boot() {
  applyTheme(lsGet('vn.theme', 'auto'));
  initTooltips(() => store.tips);
  initRemote(); // 원격(Tailscale) 접속이면 상단 바 배지 + html.is-remote
  initSecret(); // 시크릿 모드 스위치·띠

  // ⓘ 아이콘: tips.json에 키가 있을 때만 표시
  const mo = new MutationObserver((muts) => {
    if (!store.tipsLoaded) return;
    for (const m of muts) {
      for (const n of m.addedNodes) if (n.nodeType === 1) applyTips(n, store.tips);
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });
  on('tips', () => applyTips(document.body, store.tips));

  // 상단 바
  $id('theme-toggle').addEventListener('click', () => {
    const cur = lsGet('vn.theme', 'auto');
    applyTheme(THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length]);
  });
  $id('app-menu').addEventListener('click', (e) => openAppMenu(e.currentTarget));
  $id('engine-start').addEventListener('click', (e) => engineStart(e.currentTarget));
  $id('banner-start').addEventListener('click', (e) => engineStart(e.currentTarget));
  $id('engine-stop').addEventListener('click', (e) => engineStop(e.currentTarget));
  $id('engine-restart').addEventListener('click', (e) => engineRestart(e.currentTarget));
  $id('banner-log').addEventListener('click', openEngineLog);
  $id('dl-pill').addEventListener('click', () => { location.hash = '#/models/downloads'; });
  // 본문으로 건너뛰기: 주소(#main)를 바꾸면 라우터가 화면을 바꾸므로 초점만 옮긴다
  document.querySelector('.skip-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    $id('main').focus();
  });

  on('status', () => { renderEngine(); renderDownloadsPill(); checkEngineError(); checkConfigWarnings(); });
  on('sse', () => { renderSse(); renderEngine(); });
  on('jobs', renderJobsSummary);
  on('job', (job, prev) => {
    renderJobsSummary();
    onJobTransition(job, prev);
  });
  on('job-removed', renderJobsSummary);
  on('downloads', renderDownloadsPill);
  on('download', (d, prev) => {
    renderDownloadsPill();
    if (prev && prev.status === d.status) return;
    if (d.status === 'done') {
      toast(`${d.filename || '파일'}을(를) 받았습니다. 모델 목록을 새로고침합니다.`, 'success', {
        title: '다운로드 완료',
        action: { label: '확인하기', onClick: () => { location.hash = d.folder === 'loras' ? '#/models/loras' : '#/models/checkpoints'; } },
      });
      // 체크포인트 폴더에 받았는데 크기가 LoRA 정도라면, 저장할 곳을 잘못 골랐을 가능성을 알려 준다
      const size = Number(d.total) || Number(d.received) || 0;
      if (d.folder === 'checkpoints' && size > 0 && size < 1.5e9) {
        toast(`${d.filename || '받은 파일'}은(는) ${fmtBytes(size)}로 체크포인트(보통 2~7GB)치고 작습니다. LoRA 파일이라면 Finder에서 models/loras 폴더로 옮긴 뒤 모델·LoRA 탭의 [목록 새로고침]을 누르세요.`, 'warn', {
          title: '저장할 곳 확인',
          timeout: 15000,
          // 원격에서는 Mac 화면에 Finder가 열릴 뿐이므로 버튼을 붙이지 않는다
          action: isRemote() ? null : { label: '모델 폴더 열기', onClick: () => { api('/api/open-folder', { method: 'POST', body: { which: 'models_checkpoints' } }).catch(() => {}); } },
        });
      }
      loadModels();
    } else if (d.status === 'error' && prev) {
      toast(d.error || '다운로드에 실패했습니다.', 'error', { title: `다운로드 실패 · ${d.filename || ''}` });
    }
  });

  window.addEventListener('hashchange', enqueueRoute);
  window.addEventListener('beforeunload', (e) => {
    if (stopped) return undefined;
    for (const v of views.values()) {
      try {
        if (mounted.has(v.id) && v.isDirty && v.isDirty()) {
          e.preventDefault();
          e.returnValue = '';
          return '';
        }
      } catch { /* 무시 */ }
    }
    return undefined;
  });
  // 파일을 받는 곳이 없는 자리에 실수로 놓아도 브라우저가 그 파일을 열며 Studio를 떠나지 않도록.
  // window에 달아 두어 받는 곳(프롬프트 추출 탭 등)이 먼저 처리한다 — 이미 처리한 끌기는 건드리지 않는다.
  const dragHasFiles = (e) => !!e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  window.addEventListener('dragover', (e) => {
    if (!dragHasFiles(e) || e.defaultPrevented) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'none';
  });
  window.addEventListener('drop', (e) => {
    if (dragHasFiles(e)) e.preventDefault();
  });

  // 1초 틱 (경과 시간 표시)
  // 서버가 꺼져 마지막 상태가 오래되면(statusStale) 상단 바·배너·생성 버튼을 '연결 끊김'으로 바꾸도록
  // 'sse' 이벤트로 다시 그리게 한다 (각 화면은 'sse'에서 생성 버튼 상태를 다시 계산함)
  let lastStale = statusStale();
  setInterval(() => {
    emit('tick');
    if (startingSince) renderBanner();
    const stale = statusStale();
    if (stale !== lastStale) {
      lastStale = stale;
      emit('sse', store.sse);
    }
  }, 1000);

  // SSE가 끊긴 동안 폴링으로 보완
  let pollN = 0;
  setInterval(() => {
    if (stopped || store.sse === 'open') return;
    pollN++;
    loadStatus().then((ok) => {
      if (ok && store.sse !== 'open') {
        if (pollN % 2 === 0) loadJobs();
      }
    });
  }, 5000);
  // 실시간 연결이 조용히 죽은 경우(상태 이벤트가 10초마다 와야 함) 다시 연결
  setInterval(() => {
    if (!stopped && store.sse === 'open' && Date.now() - lastMsg > 40000) scheduleReconnect();
  }, 5000);

  // 도움말 팁: 다른 작업에서 아직 파일을 쓰는 중일 수 있으므로 몇 번 재시도
  const retryTips = (delays) => {
    if (!delays.length || store.tipsLoaded) return;
    setTimeout(() => {
      if (!store.tipsLoaded) loadTips().then(() => retryTips(delays.slice(1)));
    }, delays[0]);
  };

  renderEngine();
  renderSse();
  renderJobsSummary();
  connectSse();
  loadStatus();
  loadPresets();
  loadSettings();
  loadCharacters();
  loadJobs();
  loadDownloads();
  loadTips().then(() => retryTips([10000, 30000, 90000]));
  loadModels();
  loadHelpIndex();

  // 생성 뷰는 화면(mount)은 처음 열 때 만들지만, 객체는 미리 만들어 둔다.
  // 그래야 다른 탭에서 새로고침한 뒤에도 라이트박스의 [생성 탭에서 편집]('generate:load')을 놓치지 않는다.
  getView('generate');
  // 캐릭터 뷰도 같은 이유로 미리 만든다: 프롬프트 추출의 [새 캐릭터로 만들기]·[기존 캐릭터에 적용]
  // ('characters:prefill' / 'characters:apply')을 캐릭터 탭을 한 번도 열지 않았어도 받을 수 있도록
  getView('characters');

  if (!location.hash || location.hash === '#' || location.hash === '#/') replaceHash('#/generate');
  enqueueRoute();

  // 창이 다시 보이면 최신 상태로
  document.addEventListener('visibilitychange', debounce(() => {
    if (document.visibilityState === 'visible' && !stopped) {
      loadStatus();
      if (store.sse !== 'open') loadJobs();
    }
  }, 300));
}

boot();
