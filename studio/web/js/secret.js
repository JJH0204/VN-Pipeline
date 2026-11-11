// 시크릿 모드 — 상단 바 스위치, 켜져 있을 때 띠, 끌 때 삭제 확인.
// 켜 둔 동안 만든 작업·그림은 시크릿 모드를 끄거나 Studio를 종료하면 지워진다(서버: studio/secret.py).
import { api } from './api.js';
import { store, on, emit, removeJob } from './store.js';
import { confirmDialog, toast, withBusy } from './ui.js';

const $ = (id) => document.getElementById(id);

export function secretState() {
  const s = store.status && store.status.secret;
  return s && typeof s === 'object' ? s : { enabled: false, since: null, purging: false };
}

export function isSecretPath(path) {
  return typeof path === 'string' && (path === '_secret' || path.startsWith('_secret/'));
}

function mb(bytes) {
  const n = Number(bytes) || 0;
  return n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`;
}

export async function enableSecret() {
  const ok = await confirmDialog({
    title: '시크릿 모드 켜기',
    message: '지금부터 만드는 작업은 시크릿 모드를 끄거나 VN Studio를 종료하면 모두 삭제됩니다.',
    detail: '테스트·시연용으로 쓰세요. 작업 기록, 생성된 그림, 썸네일이 휴지통을 거치지 않고 지워집니다. '
      + '캐릭터·프리셋·LoRA 메모·저장한 포즈 같은 설정은 지우지 않습니다. 마음에 드는 그림은 끄기 전에 다운로드하세요.',
    confirmText: '시크릿 모드 켜기',
  });
  if (!ok) return;
  const r = await api('/api/secret/enable', { method: 'POST', body: {} });
  if (r) toast('시크릿 모드를 켰습니다. 지금부터 만드는 작업은 끄거나 종료할 때 삭제됩니다.', 'info');
}

export async function disableSecret() {
  let u = null;
  try { u = await api('/api/secret', { silent: true, timeout: 10000 }); } catch { /* 개수 없이 묻기 */ }
  const running = [...store.jobs.values()].filter((j) => j && j.secret && (j.status === 'queued' || j.status === 'running')).length;
  const what = u ? `작업 기록 ${u.jobs}개와 그림 ${u.files}개(${mb(u.bytes)})` : '시크릿 모드에서 만든 작업 기록과 그림';
  const ok = await confirmDialog({
    title: '시크릿 모드 끄기',
    message: `${what}를 삭제합니다. 되돌릴 수 없습니다.`,
    detail: (running ? `진행 중이거나 대기 중인 시크릿 작업 ${running}개는 취소됩니다. ` : '')
      + '남기고 싶은 그림이 있으면 [취소]를 누르고 먼저 다운로드하세요.',
    confirmText: '끄고 삭제',
    danger: true,
  });
  if (!ok) return;
  const r = await api('/api/secret/disable', { method: 'POST', body: {}, timeout: 60000 });
  if (r) {
    const p = r.purged || {};
    toast(`시크릿 모드를 껐습니다. 작업 ${p.jobs || 0}개, 그림 ${p.files || 0}개(${mb(p.bytes)})를 삭제했습니다.`, 'success');
  }
}

let wasOn = null;
function render() {
  const s = secretState();
  // 켜짐 → 꺼짐(삭제 끝): 이 화면에 남은 시크릿 작업을 지우고 지금 화면을 다시 그린다 (다른 기기에서 꺼도 같이)
  if (wasOn && !s.enabled && !s.purging) {
    for (const j of [...store.jobs.values()]) if (j && j.secret) removeJob(j.id);
    emit('secret-purged'); // 갤러리·캐릭터 결과 다시 읽기
  }
  if (!s.purging) wasOn = !!s.enabled;
  document.documentElement.classList.toggle('is-secret', !!s.enabled);
  const btn = $('secret-toggle');
  if (btn) {
    btn.classList.toggle('is-on', !!s.enabled);
    btn.setAttribute('aria-pressed', s.enabled ? 'true' : 'false');
    $('secret-toggle-text').textContent = s.purging ? '삭제 중…' : s.enabled ? '시크릿 켜짐' : '시크릿';
    btn.disabled = !!s.purging;
    btn.dataset.tooltip = s.enabled
      ? '시크릿 모드 켜짐 — 끄거나 Studio를 종료하면 그동안 만든 작업·그림이 삭제됩니다.\n눌러서 끄기'
      : '시크릿 모드: 테스트·시연용. 켜 둔 동안 만든 작업은 끄거나 종료할 때 삭제됩니다.\n눌러서 켜기';
  }
  const banner = $('secret-banner');
  if (banner) banner.hidden = !s.enabled;
}

export function toggleSecret() {
  return secretState().enabled ? disableSecret() : enableSecret();
}

/** app.js 부트에서 한 번 호출 */
export function initSecret() {
  const btn = $('secret-toggle');
  if (btn) btn.addEventListener('click', () => withBusy(btn, toggleSecret));
  const off = $('secret-banner-off');
  if (off) off.addEventListener('click', () => withBusy(off, disableSecret));
  on('status', render);
  render();
}
