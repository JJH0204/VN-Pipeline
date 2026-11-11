// 앱 전역 상태 + 이벤트 버스 + 서버 데이터 로더
import { api } from './api.js';
import { toast } from './ui.js';
import { lsGet, lsSet, jobPoseSize, noPeople } from './util.js';

export const store = {
  status: null, // /api/status
  statusAt: 0,
  presets: {},
  defaultPreset: '',
  presetsLoaded: false,
  settings: null,
  models: null,
  modelsError: '',
  characters: [],
  charactersLoaded: false,
  jobs: new Map(),
  jobsLoaded: false,
  previews: new Map(), // job_id -> t
  downloads: new Map(),
  tips: {},
  tipsLoaded: false,
  helpIndex: null,
  helpError: '',
  tagger: null, // /api/tagger {models, default, loaded, available, error?}
  taggerError: '',
  poses: null, // /api/poses의 poses (최신순) — 처음 필요할 때 loadPoses()
  posesInfo: null, // {dir, detect_available, detect_error?, loaded}
  posesError: '',
  sse: 'connecting', // connecting | open | reconnecting | offline
};

// ---------- 이벤트 버스 ----------
const handlers = new Map();
export function on(evt, fn) {
  if (!handlers.has(evt)) handlers.set(evt, new Set());
  handlers.get(evt).add(fn);
  return () => handlers.get(evt)?.delete(fn);
}
export function emit(evt, ...args) {
  const set = handlers.get(evt);
  if (!set) return;
  for (const fn of [...set]) {
    try {
      fn(...args);
    } catch (e) {
      console.error(`[${evt}] 핸들러 오류`, e);
    }
  }
}

// ---------- 상태 ----------
export function setStatus(s) {
  if (!s || typeof s !== 'object') return;
  store.status = s;
  store.statusAt = Date.now();
  emit('status', s);
}
export async function loadStatus() {
  try {
    setStatus(await api('/api/status', { silent: true, timeout: 8000 }));
    return true;
  } catch {
    return false;
  }
}
export function comfy() {
  return (store.status && store.status.comfy) || {};
}
export function engineReady() {
  return !!comfy().running;
}
// 실시간 연결이 끊긴 채 상태를 이만큼 못 받았으면 마지막 상태(엔진 실행 중 등)를 믿지 않는다
const STATUS_STALE_MS = 15000;
/** 받은 상태가 없거나, 서버 연결이 끊겨 마지막 상태가 오래됐으면 true */
export function statusStale() {
  return !store.status || (store.sse !== 'open' && Date.now() - store.statusAt > STATUS_STALE_MS);
}
/** 생성 버튼을 막아야 하는 이유 (없으면 '') */
export function engineBlockReason() {
  if (!store.status) {
    return store.sse === 'open' || store.sse === 'connecting'
      ? '엔진 상태를 확인하는 중입니다…'
      : 'Studio 서버에 연결되어 있지 않습니다. 서버가 실행 중인지 확인해 주세요.';
  }
  if (statusStale()) return 'Studio 서버에 연결되어 있지 않습니다. 서버가 실행 중인지 확인해 주세요.';
  const c = comfy();
  if (c.running) return '';
  if (c.starting) return '엔진(ComfyUI)이 시작되는 중입니다. 준비되면 자동으로 활성화됩니다.';
  return '엔진(ComfyUI)이 꺼져 있습니다. 상단의 [엔진 시작]을 눌러 주세요.';
}
export function setSse(state) {
  if (store.sse === state) return;
  store.sse = state;
  emit('sse', state);
}

// ---------- 프리셋 / 설정 / 모델 ----------
export async function loadPresets() {
  try {
    const r = await api('/api/presets', { silent: true });
    store.presets = (r && r.presets) || {};
    store.defaultPreset = (r && r.default) || Object.keys(store.presets)[0] || '';
    store.presetsLoaded = true;
    emit('presets');
  } catch (e) {
    console.warn('프리셋 로드 실패', e);
  }
}

export async function loadSettings() {
  try {
    const r = await api('/api/settings', { silent: true });
    store.settings = r && r.settings && typeof r.settings === 'object' ? r.settings : r;
    emit('settings');
  } catch (e) {
    console.warn('설정 로드 실패', e);
  }
}

let modelsInflight = null;
export function loadModels({ silent = true } = {}) {
  if (modelsInflight) return modelsInflight;
  modelsInflight = (async () => {
    try {
      const r = await api('/api/models', { silent, timeout: 180000 });
      store.models = {
        checkpoints: r.checkpoints || [],
        loras: r.loras || [],
        upscalers: r.upscalers || [],
        controlnets: Array.isArray(r.controlnets) ? r.controlnets : [],
        samplers: r.samplers || [],
        schedulers: r.schedulers || [],
        model_dirs: r.model_dirs || {},
        install_dir: r.install_dir || {},
      };
      store.modelsError = '';
    } catch (e) {
      store.modelsError = e && e.message ? e.message : '모델 목록을 불러오지 못했습니다.';
    } finally {
      modelsInflight = null;
      emit('models');
    }
  })();
  return modelsInflight;
}

export function loraByName(name) {
  return (store.models && store.models.loras || []).find((l) => l.name === name) || null;
}
export function ckptByName(name) {
  return (store.models && store.models.checkpoints || []).find((c) => c.name === name) || null;
}
export function presetLabel(name) {
  const p = store.presets[name];
  return p && p.label ? p.label : name;
}

// ---------- 태거 (프롬프트 추출) ----------
let taggerInflight = null;
export function loadTagger() {
  if (taggerInflight) return taggerInflight;
  taggerInflight = (async () => {
    try {
      const r = await api('/api/tagger', { silent: true, timeout: 15000 });
      store.tagger = {
        models: Array.isArray(r.models) ? r.models : [],
        default: r.default || '',
        loaded: r.loaded || null,
        available: r.available !== false,
        error: r.error || '',
      };
      store.taggerError = '';
    } catch (e) {
      store.taggerError = e && e.status === 404
        ? '이 Studio 서버는 아직 프롬프트 추출 기능을 지원하지 않습니다. VN Studio를 다시 시작해 주세요.'
        : (e && e.message) || '태거 정보를 불러오지 못했습니다.';
    } finally {
      taggerInflight = null;
      emit('tagger');
    }
    return store.tagger;
  })();
  return taggerInflight;
}

// ---------- 포즈 (ControlNet OpenPose) ----------
let posesInflight = null;
/** 포즈 라이브러리 목록. 진행 중인 요청이 있으면 그것을 기다린다 */
export function loadPoses() {
  if (posesInflight) return posesInflight;
  posesInflight = (async () => {
    try {
      const r = await api('/api/poses', { silent: true, timeout: 20000 });
      store.poses = Array.isArray(r.poses) ? r.poses : [];
      store.posesInfo = {
        dir: r.dir || '',
        detect_available: r.detect_available !== false,
        detect_error: r.detect_error || '',
        loaded: !!r.loaded,
      };
      store.posesError = '';
    } catch (e) {
      store.posesError = e && e.status === 404
        ? '이 Studio 서버는 아직 포즈 기능을 지원하지 않습니다. VN Studio를 다시 시작해 주세요.'
        : (e && e.message) || '포즈 목록을 불러오지 못했습니다.';
    } finally {
      posesInflight = null;
      emit('poses');
    }
    return store.poses;
  })();
  return posesInflight;
}
export function poseByName(name) {
  return (store.poses || []).find((p) => p.name === name) || null;
}
/** 새로 만든 포즈를 목록 맨 앞에 넣는다(서버 목록을 다시 받기 전에 바로 보이도록) */
export function addPoseLocal(item) {
  if (!item || !item.name) return;
  const list = (store.poses || []).filter((p) => p.name !== item.name);
  store.poses = [item, ...list];
  emit('poses', { added: item.name });
}
export function removePoseLocal(name) {
  if (!store.poses) return;
  store.poses = store.poses.filter((p) => p.name !== name);
  emit('poses', { deleted: name });
}
/** 포즈 파일이 있는지: 항목 | null(없음 = 삭제됨) | undefined(확인 못 함) */
export async function resolvePose(name) {
  if (!name) return null;
  const cached = poseByName(name);
  if (cached) return cached;
  try {
    const r = await api(`/api/poses/${encodeURIComponent(name)}`, { silent: true, timeout: 15000 });
    if (r && r.name) {
      const { keypoints, ...item } = r;
      return item;
    }
    return undefined;
  } catch (e) {
    if (e && (e.status === 404 || e.status === 400)) return null;
    return undefined;
  }
}

// ---------- 캐릭터 ----------
export async function loadCharacters() {
  try {
    const r = await api('/api/characters', { silent: true });
    store.characters = Array.isArray(r) ? r : (r.characters || []);
    store.charactersLoaded = true;
    emit('characters');
  } catch (e) {
    console.warn('캐릭터 로드 실패', e);
  }
}
export function characterById(id) {
  return store.characters.find((c) => c.id === id) || null;
}

// ---------- 작업 ----------
export async function loadJobs() {
  try {
    const r = await api('/api/jobs?limit=150', { silent: true });
    const list = Array.isArray(r) ? r : (r.jobs || []);
    const m = new Map();
    for (const j of list) if (j && j.id) m.set(j.id, j);
    // 진행 중인 작업이 목록 한도 밖이면 유지
    for (const [id, j] of store.jobs) if (!m.has(id) && (j.status === 'queued' || j.status === 'running')) m.set(id, j);
    store.jobs = m;
    store.jobsLoaded = true;
    emit('jobs');
  } catch (e) {
    console.warn('작업 로드 실패', e);
  }
}

export function upsertJob(job) {
  if (!job || !job.id) return;
  const prev = store.jobs.get(job.id) || null;
  store.jobs.set(job.id, job);
  emit('job', job, prev);
}
export function removeJob(id) {
  if (store.jobs.delete(id)) emit('job-removed', id);
}
export function isActive(job) {
  return !!job && (job.status === 'queued' || job.status === 'running');
}
export function activeJobs() {
  return [...store.jobs.values()].filter(isActive).sort((a, b) => (a.created || 0) - (b.created || 0));
}
export function sortedJobs() {
  return [...store.jobs.values()].sort((a, b) => (b.created || 0) - (a.created || 0));
}

/** 작업 제출. 성공 시 Job 반환, 실패 시 null(오류는 토스트로 알림) */
export async function submitJob(spec, { quiet = false } = {}) {
  try {
    const r = await api('/api/jobs', { method: 'POST', body: spec, timeout: 60000 });
    const job = r && (r.job || (r.id ? r : null));
    if (job) upsertJob(job);
    if (!quiet) {
      toast(job && job.summary ? job.summary : '작업을 대기열에 추가했습니다.', 'success', {
        title: '대기열에 추가됨',
        action: { label: '작업 보기', onClick: () => { location.hash = '#/jobs'; } },
      });
    }
    maybeAskNotify();
    return job || null;
  } catch {
    return null;
  }
}

export async function cancelJob(id) {
  try {
    const r = await api(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
    if (r && r.job) upsertJob(r.job);
    else if (r && r.id) upsertJob(r);
    toast('작업 취소를 요청했습니다.', 'info');
    return true;
  } catch {
    return false;
  }
}

export async function retryJob(id) {
  // 쓰인 포즈가 지워졌으면 서버 재시도는 '포즈 파일 없음'으로 실패한다 → 알리고 포즈 없이 다시 넣는다
  const job = store.jobs.get(id);
  const pose = job && job.spec && job.spec.pose;
  const poseName = pose && (typeof pose === 'string' ? pose : pose.name);
  if (poseName && (await resolvePose(poseName)) === null) {
    const spec = { ...job.spec };
    delete spec.pose;
    // 크기를 비워 두면 포즈 크기로 생성됐다 → 포즈를 빼도 그 크기를 유지 (안 그러면 모드 기본 크기로 바뀐다)
    const keep = !spec.size && !noPeople(spec.mode) ? jobPoseSize(job.pose) : null;
    if (keep) spec.size = keep;
    toast(`이 작업에 쓴 포즈(${poseName})가 삭제되어 포즈 없이 다시 생성합니다${keep ? ` (크기는 원래대로 ${keep[0]}×${keep[1]})` : ''}.`, 'warn', { timeout: 9000 });
    return submitJob(spec);
  }
  try {
    const r = await api(`/api/jobs/${encodeURIComponent(id)}/retry`, { method: 'POST', timeout: 60000 });
    const job = r && (r.job || (r.id ? r : null));
    if (job) upsertJob(job);
    toast('같은 설정으로 다시 대기열에 넣었습니다.', 'success');
    return job;
  } catch {
    return null;
  }
}

export async function deleteJobRecord(id) {
  try {
    await api(`/api/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' });
    removeJob(id);
    return true;
  } catch {
    return false;
  }
}

// ---------- 다운로드 ----------
export async function loadDownloads() {
  try {
    const r = await api('/api/downloads', { silent: true });
    const list = Array.isArray(r) ? r : (r.downloads || []);
    store.downloads = new Map(list.filter((d) => d && d.id).map((d) => [d.id, d]));
    emit('downloads');
  } catch (e) {
    console.warn('다운로드 목록 로드 실패', e);
  }
}
export function upsertDownload(d) {
  if (!d || !d.id) return;
  const prev = store.downloads.get(d.id) || null;
  store.downloads.set(d.id, d);
  emit('download', d, prev);
}

// ---------- 도움말 ----------
export async function loadTips() {
  try {
    const res = await fetch('/static/help/tips.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    store.tips = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    store.tipsLoaded = true;
  } catch (e) {
    store.tips = store.tips || {};
    store.tipsLoaded = false;
  }
  emit('tips');
  return store.tipsLoaded;
}

export async function loadHelpIndex() {
  try {
    const res = await fetch('/static/help/index.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const list = Array.isArray(data) ? data : (data && Array.isArray(data.sections) ? data.sections : []);
    store.helpIndex = list.filter((s) => s && s.id && s.file);
    store.helpError = '';
  } catch (e) {
    store.helpIndex = null;
    store.helpError = '도움말 목차(help/index.json)를 불러오지 못했습니다.';
  }
  emit('help-index');
  return store.helpIndex;
}

// ---------- 알림 권한 (한 번만 정중하게) ----------
export function maybeAskNotify() {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'default') return;
  if (lsGet('vn.notifyAsked', false)) return;
  lsSet('vn.notifyAsked', true);
  toast('생성은 몇 분 걸립니다. 다른 창에서 작업하는 동안 완료되면 데스크톱 알림으로 알려 드릴까요?', 'info', {
    title: '완료 알림',
    timeout: 15000,
    action: {
      label: '알림 받기',
      onClick: () => {
        try {
          const p = Notification.requestPermission();
          if (p && typeof p.then === 'function') {
            p.then((r) => {
              if (r === 'granted') toast('작업이 끝나면 알림을 보내 드릴게요.', 'success');
            }).catch(() => {});
          }
        } catch { /* 무시 */ }
      },
    },
  });
}
