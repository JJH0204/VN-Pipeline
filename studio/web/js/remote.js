// 원격 접속(Tailscale): 원격 여부 판별, 상단 바 '원격' 배지, 모델·LoRA › 전역 설정의 '원격 접속 (Tailscale)' 묶음
// 서버 계약: docs/STUDIO_SPEC.md §10.3 (GET/PUT /api/remote, POST /api/remote/enable|disable, /api/status의 client·remote)
// 서버가 아직 이 기능을 모르면(404) 패널은 안내만 보여 주고, 원격 여부는 접속한 주소로 추정한다.
import { h, copyText } from './util.js';
import { api } from './api.js';
import { toast, confirmDialog, withBusy, tipNode, spinner } from './ui.js';
import { store, on, loadStatus } from './store.js';

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const ADMIN_DNS_URL = 'https://login.tailscale.com/admin/dns';
const DOWNLOAD_URL = 'https://tailscale.com/download';
const QR_MODULE = '/static/vendor/qrcode/qrcode.mjs';
// 정확한 로그인만(와일드카드 없음). 깃허브 로그인(이름@github)처럼 점이 없는 도메인도 있으므로 형식 검사는 느슨하게, 최종 검사는 서버가 한다
const LOGIN_RE = /^[^\s@*]+@[^\s@*]+$/;
const SVG_NS = 'http://www.w3.org/2000/svg';

/** 원격일 때 메뉴 등에서 로컬 전용 항목 옆에 붙이는 짧은 이유 */
export const LOCAL_ONLY_HINT = 'Mac에서만';

// ======================= 원격 여부 =======================
let knownClient = null;

/**
 * 이 브라우저의 접속 정보 {remote, login, name, ip} | null.
 * /api/status 응답에만 있고 실시간(SSE) 상태 이벤트에는 없을 수 있으므로 마지막으로 받은 값을 기억한다.
 */
export function clientInfo() {
  const c = store.status && store.status.client;
  if (c && typeof c === 'object') knownClient = c;
  return knownClient;
}

/** 이 화면을 원격(Tailscale Serve 경유)으로 보고 있는지. 서버가 알려 주지 않으면 접속 주소로 추정한다 */
export function isRemote() {
  const c = clientInfo();
  if (c && typeof c.remote === 'boolean') return c.remote;
  let host = '';
  try {
    host = String(location.hostname || '').toLowerCase();
  } catch {
    host = '';
  }
  return !!host && !LOCAL_HOSTNAMES.has(host);
}

function cleanName(name) {
  const s = String(name || '').trim();
  // 서버가 RFC 2047(=?utf-8?q?…?=)을 풀지 못한 경우에는 쓰지 않는다
  return s && !/^=\?/.test(s) ? s : '';
}

/** 배지 등에 쓰는 짧은 이름: 표시 이름 → 로그인의 @ 앞부분 */
export function clientName(c = clientInfo()) {
  if (!c) return '';
  return cleanName(c.name) || (c.login ? String(c.login).split('@')[0] : '');
}

// ======================= 상단 바 배지 =======================
function renderBadge(remote) {
  const el = document.getElementById('remote-badge');
  if (!el) return;
  el.hidden = !remote;
  if (!remote) return;
  const c = clientInfo() || {};
  const name = clientName(c);
  const text = document.getElementById('remote-badge-text');
  if (text) text.textContent = name ? `원격 · ${name}` : '원격';
  const tip = ['원격으로 접속 중입니다 (Tailscale)'];
  if (c.login) tip.push(`테일넷 로그인: ${c.login}`);
  if (c.ip) tip.push(`이 기기 IP: ${c.ip}`);
  tip.push('생성은 Mac이 합니다. 폴더 열기·Finder에서 보기·Studio 종료는 Mac에서만 할 수 있습니다.');
  tip.push('눌러서 원격 접속 정보 보기');
  el.dataset.tooltip = tip.join('\n');
  el.setAttribute('aria-label', `원격 접속 중${name ? ` · ${name}` : ''} — 원격 접속 정보 보기`);
}

/** app.js 부트에서 한 번 호출: 상태가 바뀔 때마다 html.is-remote 클래스와 배지를 맞춘다 */
export function initRemote() {
  let last = null;
  const apply = () => {
    const remote = isRemote();
    if (remote !== last) {
      last = remote;
      document.documentElement.classList.toggle('is-remote', remote);
    }
    renderBadge(remote);
  };
  on('status', apply);
  apply();
}

// ======================= QR 코드 =======================
let qrLib = null;
function loadQrLib() {
  if (!qrLib) {
    qrLib = import(QR_MODULE).then((m) => {
      const f = m.default || m.qrcode;
      if (typeof f !== 'function') throw new Error('QR 코드 모듈을 읽지 못했습니다.');
      return f;
    }).catch((e) => {
      qrLib = null;
      throw e;
    });
  }
  return qrLib;
}

/** 글자를 QR 코드 SVG 요소로 (항상 흰 바탕에 검은 점 — 카메라가 읽기 쉽게, 테마와 무관) */
export async function qrSvg(text, { margin = 4 } = {}) {
  const qrcode = await loadQrLib();
  const q = qrcode(0, 'M');
  q.addData(String(text));
  q.make();
  const n = q.getModuleCount();
  const size = n + margin * 2;
  let d = '';
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!q.isDark(r, c)) {
        c++;
        continue;
      }
      let len = 1;
      while (c + len < n && q.isDark(r, c + len)) len++;
      d += `M${c + margin},${r + margin}h${len}v1h-${len}z`;
      c += len;
    }
  }
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('aria-hidden', 'true');
  const bg = document.createElementNS(SVG_NS, 'rect');
  bg.setAttribute('width', String(size));
  bg.setAttribute('height', String(size));
  bg.setAttribute('fill', '#ffffff');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#000000');
  svg.append(bg, path);
  return svg;
}

// ======================= 응답 정리 =======================
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const strList = (v) => (Array.isArray(v) ? v.map((x) => String(x == null ? '' : x).trim()).filter(Boolean) : []);

function normalize(r) {
  const d = obj(r);
  const ts = obj(d.tailscale);
  const serve = obj(d.serve);
  const st = obj(d.settings);
  const dns = String(ts.dns_name || '').replace(/\.$/, '');
  return {
    tailscale: {
      installed: ts.installed,
      path: ts.path || '',
      version: ts.version || '',
      running: ts.running,
      backend_state: ts.backend_state || '',
      dns_name: dns,
      short_name: ts.short_name || (dns ? dns.split('.')[0] : ''),
      ips: strList(ts.ips),
      tailnet: ts.tailnet || '',
      users: (Array.isArray(ts.users) ? ts.users : []).map(obj).filter((u) => u.login).map((u) => ({ login: String(u.login), name: cleanName(u.name) })),
      https_enabled: ts.https_enabled,
      error: ts.error || '',
    },
    serve: {
      configured: serve.configured,
      https: serve.https,
      target: serve.target || '',
      url: serve.url || '',
      raw: serve.raw,
      error: serve.error || '',
    },
    settings: {
      remote_enabled: !!st.remote_enabled,
      remote_allowed_logins: strList(st.remote_allowed_logins),
      remote_hosts: strList(st.remote_hosts),
    },
    client: d.client && typeof d.client === 'object' ? d.client : null,
    appSession: d.app_session !== false, // 이전 서버(필드 없음)는 앱 세션으로 본다
    warnings: strList(d.warnings),
  };
}

/** enable/disable 응답·오류에 실려 온 Tailscale 실행 결과 글자 */
function cliOutput(d) {
  const o = obj(d);
  const parts = [];
  for (const k of ['output', 'cli_output', 'stdout', 'stderr', 'detail']) {
    const v = o[k];
    if (typeof v === 'string' && v.trim() && !parts.includes(v.trim())) parts.push(v.trim());
  }
  return parts.join('\n');
}

/** 오류에 실려 온 링크(예: 테일넷에서 Serve를 허용하는 관리 화면 주소) — https 주소만 */
function cliLinks(d) {
  const o = obj(d);
  const list = strList(o.links);
  if (typeof o.admin_url === 'string') list.push(o.admin_url);
  return [...new Set(list.filter((u) => /^https:\/\//.test(u)))];
}

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x.toLowerCase() === String(b[i]).toLowerCase());

// ======================= 모델·LoRA › 전역 설정의 '원격 접속 (Tailscale)' 패널 =======================
/**
 * @returns {{el: HTMLElement, activate: Function, reveal: Function, isDirty: Function, save: Function, discard: Function}}
 */
export function createRemotePanel() {
  let data = null; // normalize(GET /api/remote)
  let error = null; // {status, message}
  let loadedAt = 0;
  let inflight = null;
  let result = null; // {kind: 'ok'|'error', message, output} — 마지막 켜기/끄기 결과
  let draft = null; // 편집 중인 허용 로그인 목록 (null = 편집 안 함)
  let addValue = '';
  let lastStatusEnabled;
  let qrToken = 0;

  const stateBadge = h('span', { class: 'badge badge-muted' }, '확인 중');
  const refreshBtn = h('button', { type: 'button', class: 'btn btn-sm btn-ghost' }, '다시 확인');
  const body = h('div', { class: 'rm-body' });
  const el = h('section', { class: 'panel remote-panel', id: 'remote-panel', 'aria-labelledby': 'remote-panel-title' },
    h('div', { class: 'panel-head' },
      h('h3', { class: 'panel-title', id: 'remote-panel-title' }, '원격 접속 (Tailscale)'),
      tipNode('remote_status'),
      stateBadge,
      h('div', { class: 'panel-tools' },
        refreshBtn,
        h('a', { class: 'help-link', href: '#/help/remote', title: '도움말에서 자세히 보기' }, '? 설명'))),
    h('p', { class: 'panel-sub' },
      '같은 Tailscale 계정(테일넷)에 로그인한 휴대폰·다른 PC의 브라우저에서 이 Studio를 열어 생성까지 할 수 있습니다. ',
      '인터넷에는 공개되지 않고, 이미지는 계속 이 Mac이 만듭니다.'),
    body);

  refreshBtn.addEventListener('click', () => withBusy(refreshBtn, () => load()));

  const panelVisible = () => el.isConnected && el.offsetParent !== null;
  const isLocal = () => {
    const c = data && data.client;
    if (c && typeof c.remote === 'boolean') return !c.remote;
    return !isRemote();
  };

  function load() {
    if (inflight) return inflight;
    inflight = (async () => {
      if (!data) render();
      try {
        const r = await api('/api/remote', { silent: true, timeout: 20000 });
        data = normalize(r);
        error = null;
        loadedAt = Date.now();
      } catch (e) {
        if (e && e.aborted) return;
        error = { status: e ? e.status : 0, message: (e && e.message) || '원격 접속 상태를 불러오지 못했습니다.' };
        loadedAt = Date.now();
        if (error.status === 404) data = null;
      } finally {
        inflight = null;
      }
      render();
    })();
    return inflight;
  }

  // ---------- 상태 판정 ----------
  function derive() {
    const ts = data.tailscale;
    const serve = data.serve;
    const st = data.settings;
    const stateTxt = String(ts.backend_state || '');
    // running: 연결됨 / notRunning: 확실히 연결 안 됨 / 둘 다 false: 알 수 없음(서버가 알려 주지 않음)
    const running = ts.running === true || (ts.running !== false && stateTxt === 'Running');
    const notRunning = !running && (ts.running === false || !!stateTxt);
    const serveOk = serve.configured === true;
    const otherServe = !serveOk && !!serve.target;
    const url = serve.url || (store.status && store.status.remote && store.status.remote.url) || (ts.dns_name ? `https://${ts.dns_name}/` : '');
    const appSession = data.appSession;
    const active = serveOk && st.remote_enabled && appSession;
    let blocker = '';
    if (!appSession) blocker = 'VN Studio.app으로 연 Studio에서만 켤 수 있습니다. Studio를 종료하고 앱으로 다시 여세요.';
    else if (ts.installed === false) blocker = 'Tailscale이 설치되어 있지 않습니다.';
    else if (notRunning) blocker = 'Tailscale이 연결되어 있지 않습니다.';
    else if (ts.https_enabled === false) blocker = '먼저 Tailscale 관리 화면에서 HTTPS 인증서를 켜세요 (위의 단계).';
    else if (otherServe) blocker = '이 Mac의 443 포트에 다른 Serve 설정이 있습니다.';
    return { ts, serve, st, running, notRunning, serveOk, otherServe, url, active, blocker, stateTxt, appSession };
  }

  function renderStateBadge() {
    if (!data) {
      if (error) {
        stateBadge.className = `badge ${error.status === 404 ? 'badge-muted' : 'badge-bad'}`;
        stateBadge.textContent = error.status === 404 ? '사용 불가' : '오류';
      } else {
        stateBadge.className = 'badge badge-muted';
        stateBadge.textContent = '확인 중';
      }
      return;
    }
    const v = derive();
    if (v.active && v.running) {
      stateBadge.className = 'badge badge-ok';
      stateBadge.textContent = '켜짐';
    } else if (v.st.remote_enabled || v.serveOk) {
      stateBadge.className = 'badge badge-warn';
      stateBadge.textContent = '확인 필요';
    } else {
      stateBadge.className = 'badge badge-muted';
      stateBadge.textContent = '꺼짐';
    }
  }

  // ---------- 그리기 ----------
  function notice(kind, ...children) {
    return h('div', { class: `rm-notice is-${kind}`, role: kind === 'error' ? 'alert' : 'status' },
      h('span', { class: 'rm-notice-icon', 'aria-hidden': 'true' }, kind === 'info' ? 'i' : '!'),
      h('div', { class: 'rm-notice-body' }, ...children));
  }

  const ICONS = { ok: '✅', warn: '⚠️', bad: '❌', off: '○', unknown: '…' };
  function checkRow({ state, label, tip, value, fix }) {
    return h('li', { class: `rm-check is-${state}` },
      h('span', { class: 'rm-check-icon', 'aria-hidden': 'true' }, ICONS[state] || '…'),
      h('span', { class: 'rm-check-label' }, label, tip ? tipNode(tip) : null),
      h('span', { class: 'rm-check-value' }, value),
      fix ? h('div', { class: 'rm-check-fix' }, fix) : null);
  }

  function render() {
    renderStateBadge();
    const focusedAdd = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.rmAdd === '1';
    body.replaceChildren();
    if (!data) {
      if (!error) {
        body.append(spinner('Tailscale 상태를 확인하는 중…'));
      } else if (error.status === 404) {
        body.append(notice('info',
          h('strong', {}, '이 Studio 서버는 아직 원격 접속 기능을 지원하지 않습니다.'),
          h('div', {}, 'VN Studio를 다시 시작하면 여기에 Tailscale 상태와 [원격 접속 켜기]가 표시됩니다.')));
      } else {
        const retry = h('button', { type: 'button', class: 'btn btn-sm' }, '다시 시도');
        retry.addEventListener('click', () => withBusy(retry, () => load()));
        body.append(notice('error', h('div', {}, error.message), h('div', { class: 'rm-notice-actions' }, retry)));
      }
      return;
    }

    const v = derive();
    const local = isLocal();
    if (error) {
      body.append(notice('warn', `최신 상태를 불러오지 못해 이전에 확인한 정보를 보여 주고 있습니다. (${error.message})`));
    }
    if (!local) {
      const c = data.client || clientInfo() || {};
      const who = [clientName(c), c.login && clientName(c) !== c.login ? `(${c.login})` : '', c.ip ? `· 이 기기 IP ${c.ip}` : ''].filter(Boolean).join(' ');
      body.append(notice('info',
        h('strong', {}, '지금 원격으로 접속해 있습니다.'),
        h('div', {}, '여기서는 상태만 볼 수 있습니다. 원격 접속 켜기·끄기와 허용 목록 변경은 Mac의 VN Studio에서 하세요.'),
        who ? h('div', { class: 'muted small' }, `접속한 사용자: ${who}`) : null));
    }
    // 아래 점검 줄이 이미 해결 방법까지 보여 주는 경고(설치·연결·HTTPS)는 위에 한 번 더 띄우지 않는다
    const covered = [];
    if (v.ts.installed === false) covered.push('Tailscale이 설치되어 있지 않습니다');
    if (v.notRunning) covered.push('Tailscale이 연결되어 있지 않습니다', 'Tailscale 상태를 확인하지 못했습니다');
    if (v.ts.https_enabled === false) covered.push('테일넷의 HTTPS 인증서가 꺼져');
    for (const w of data.warnings) if (!covered.some((c) => w.startsWith(c))) body.append(notice('warn', w));

    const left = h('div', { class: 'rm-main' });
    const right = h('div', { class: 'rm-side' });
    body.append(h('div', { class: 'rm-layout' }, left, right));

    // ---- 상태 점검 ----
    const ts = v.ts;
    const checks = h('ul', { class: 'rm-checks', 'aria-label': '원격 접속 준비 상태' });
    // 1. 설치
    if (ts.installed === false) {
      checks.append(checkRow({
        state: 'bad', label: 'Tailscale 설치', value: '설치되어 있지 않습니다',
        fix: h('span', {}, 'Mac에 Tailscale 앱을 설치하고 로그인하세요. 휴대폰·다른 PC에도 같은 계정으로 설치해야 합니다. ',
          h('a', { href: DOWNLOAD_URL, target: '_blank', rel: 'noopener noreferrer' }, 'tailscale.com/download')),
      }));
    } else {
      checks.append(checkRow({
        state: ts.installed === true ? 'ok' : 'unknown', label: 'Tailscale 설치',
        value: h('span', {}, ts.installed === true ? '설치됨' : '확인할 수 없음',
          ts.version ? h('span', { class: 'muted' }, ` · ${ts.version}`) : null,
          ts.path ? h('span', { class: 'muted rm-path' }, ` · ${ts.path}`) : null),
      }));
    }
    // 2. 연결
    if (ts.installed !== false) {
      if (v.running) {
        const bits = [ts.short_name || ts.dns_name, ts.ips[0] ? `(${ts.ips[0]})` : '', ts.tailnet ? `· 테일넷 ${ts.tailnet}` : ''].filter(Boolean).join(' ');
        checks.append(checkRow({ state: 'ok', label: 'Tailscale 연결', value: `연결됨${bits ? ` · ${bits}` : ''}` }));
      } else if (!v.notRunning) {
        checks.append(checkRow({ state: 'unknown', label: 'Tailscale 연결', value: `확인할 수 없음${ts.error ? ` · ${ts.error}` : ''}` }));
      } else {
        const why = { NeedsLogin: '로그인이 필요합니다', Stopped: '꺼져 있습니다', NeedsMachineAuth: '관리자 승인이 필요합니다', Starting: '연결하는 중입니다', NoState: '시작되지 않았습니다' }[v.stateTxt];
        checks.append(checkRow({
          state: 'warn', label: 'Tailscale 연결',
          value: `연결 안 됨${why ? ` · ${why}` : v.stateTxt ? ` (${v.stateTxt})` : ''}${ts.error ? ` · ${ts.error}` : ''}`,
          fix: '메뉴 막대의 Tailscale 아이콘을 눌러 로그인하거나 연결(Connect)한 뒤 [다시 확인]을 누르세요.',
        }));
      }
    }
    // 3. HTTPS 인증서
    if (ts.https_enabled === true) {
      checks.append(checkRow({ state: 'ok', label: 'HTTPS 인증서', tip: 'remote_https', value: '켜짐' }));
    } else if (ts.https_enabled === false) {
      checks.append(checkRow({
        state: 'warn', label: 'HTTPS 인증서', tip: 'remote_https', value: '꺼져 있습니다 (테일넷 관리 화면에서 한 번만 켜면 됩니다)',
        fix: h('div', {},
          h('a', { class: 'btn btn-sm btn-primary rm-admin-btn', href: ADMIN_DNS_URL, target: '_blank', rel: 'noopener noreferrer' }, 'Tailscale 관리 화면 열기 ↗'),
          h('ol', {},
            h('li', {}, '버튼을 눌러 Tailscale 관리 화면의 DNS 페이지를 엽니다 (이 테일넷 계정으로 로그인).'),
            h('li', {}, '페이지 아래쪽 HTTPS Certificates에서 [Enable HTTPS]를 누르고 확인합니다. (MagicDNS도 켜져 있어야 합니다)'),
            h('li', {}, '이 화면으로 돌아와 [다시 확인]을 누릅니다. 반영까지 1~2분 걸릴 수 있습니다.')),
          h('div', { class: 'muted small' }, `인증서를 발급하면 기기 이름(${ts.dns_name || 'my-mac.….ts.net'})이 공개 인증서 기록(CT 로그)에 남습니다. 이름이 기록될 뿐, 인터넷에서 접속할 수 있게 되는 것은 아닙니다.`)),
      }));
    } else {
      checks.append(checkRow({ state: 'unknown', label: 'HTTPS 인증서', tip: 'remote_https', value: v.running ? '확인할 수 없음' : 'Tailscale이 연결되면 확인합니다' }));
    }
    // 4. Serve
    if (v.serveOk) {
      checks.append(checkRow({
        state: 'ok', label: 'Tailscale Serve',
        value: h('span', {}, '설정됨', v.serve.target ? h('span', { class: 'muted' }, ` · ${v.serve.url || 'https'} → ${v.serve.target}`) : null),
      }));
    } else if (v.otherServe) {
      checks.append(checkRow({
        state: 'warn', label: 'Tailscale Serve', value: `443 포트에 다른 설정이 있습니다 → ${v.serve.target}`,
        fix: '다른 프로그램이 쓰는 Serve 설정을 덮어쓰지 않도록 켜기를 막았습니다. 그 설정이 필요 없으면 터미널에서 지운 뒤 [다시 확인]을 누르세요. (도움말 참고)',
      }));
    } else {
      checks.append(checkRow({
        state: v.st.remote_enabled ? 'warn' : 'off', label: 'Tailscale Serve',
        value: `설정 안 됨${v.serve.error ? ` · ${v.serve.error}` : ''}`,
        fix: local ? '[원격 접속 켜기]를 누르면 자동으로 설정됩니다.' : null,
      }));
    }
    // 5. 실행 방식 (앱 세션일 때만 원격 접속)
    checks.append(checkRow({
      state: v.appSession ? 'ok' : 'warn', label: '실행 방식',
      value: v.appSession ? 'VN Studio 앱으로 실행 — 앱이 켜져 있는 동안만 원격 접속이 열립니다'
        : '앱이 아닌 방법(터미널·자동 실행)으로 실행 — 원격 접속을 받지 않습니다',
      fix: v.appSession ? null : 'Studio를 종료(⋯ › VN Studio 종료)한 뒤 Mac에서 VN Studio.app으로 다시 여세요.',
    }));
    // 6. Studio 원격 허용
    checks.append(checkRow({
      state: v.st.remote_enabled ? (v.serveOk ? 'ok' : 'warn') : 'off',
      label: 'Studio 원격 허용',
      value: v.st.remote_enabled
        ? (v.serveOk ? '켜짐 — 허용된 로그인만 접속할 수 있습니다' : '켜짐 (Serve가 없어 아직 접속할 수 없습니다)')
        : '꺼짐',
    }));
    left.append(checks);

    // ---- 켜기 / 끄기 (Mac에서만) ----
    if (local) {
      const acts = h('div', { class: 'rm-actions' });
      const reason = h('span', { class: 'rm-reason' });
      if (!v.active) {
        const onBtn = h('button', { type: 'button', class: 'btn btn-primary' }, v.st.remote_enabled || v.serveOk ? '원격 접속 다시 켜기' : '원격 접속 켜기');
        const wrap = h('span', { class: 'btn-guard' }, onBtn);
        if (v.blocker) {
          onBtn.disabled = true;
          wrap.dataset.tooltip = v.blocker;
          reason.textContent = v.blocker;
        }
        onBtn.addEventListener('click', () => withBusy(onBtn, enable));
        acts.append(wrap);
      }
      if (v.st.remote_enabled || v.serveOk) {
        const offBtn = h('button', { type: 'button', class: `btn ${v.active ? 'btn-danger-ghost' : 'btn-ghost'}` }, '원격 접속 끄기');
        offBtn.addEventListener('click', () => withBusy(offBtn, disable));
        acts.append(offBtn);
      }
      acts.append(tipNode('remote_toggle'), reason);
      left.append(acts);
    }
    if (result) {
      left.append(h('div', { class: `rm-result is-${result.kind}`, role: 'status' },
        h('div', { class: 'rm-result-msg' }, result.message),
        result.links && result.links.length ? h('div', { class: 'rm-result-links' }, result.links.map((u) => h('a', { href: u, target: '_blank', rel: 'noopener noreferrer' }, `${u} ↗`))) : null,
        result.output ? h('details', { class: 'rm-result-out' }, h('summary', {}, 'Tailscale 실행 결과'), h('pre', {}, result.output)) : null));
    }

    // ---- 허용 로그인 ----
    left.append(renderLogins(v, local));

    // ---- 접속 주소 + QR ----
    right.append(renderAddress(v));

    body.append(h('p', { class: 'rm-foot' },
      'Studio는 이 Mac 안(127.0.0.1)에서만 열려 있고, Tailscale Serve가 같은 테일넷의 기기에게만 HTTPS로 전달합니다. ',
      '인터넷 공개(Funnel)는 쓰지 않습니다. Mac이 잠자기에 들어가거나 T7이 빠져 있거나 Studio가 꺼져 있으면 접속되지 않습니다.'));

    if (focusedAdd) {
      const inp = body.querySelector('[data-rm-add="1"]');
      if (inp) {
        try { inp.focus(); } catch { /* 무시 */ }
      }
    }
  }

  function renderAddress(v) {
    const box = h('div', { class: 'rm-addr' });
    box.append(h('div', { class: 'field-label' }, h('span', { class: 'label' }, '접속 주소'), tipNode('remote_url'),
      v.active ? h('span', { class: 'badge badge-ok' }, '사용 가능') : h('span', { class: 'badge badge-muted' }, '켜면 사용 가능')));
    if (!v.url) {
      box.append(h('p', { class: 'field-note' }, 'Tailscale이 연결되면 이 Mac의 접속 주소(https://<기기 이름>.<테일넷>.ts.net/)가 여기에 표시됩니다.'));
      return box;
    }
    const urlEl = h('code', { class: 'rm-url' }, v.url);
    const copyBtn = h('button', { type: 'button', class: 'btn btn-sm' }, '복사');
    copyBtn.addEventListener('click', async () => {
      if (await copyText(v.url)) toast('접속 주소를 복사했습니다.', 'success');
      else toast('복사하지 못했습니다. 주소를 직접 선택해 복사하세요.', 'warn');
    });
    const row = h('div', { class: 'rm-url-row' }, urlEl, copyBtn);
    if (v.active && isLocal()) row.append(h('a', { class: 'btn btn-sm btn-ghost', href: v.url, target: '_blank', rel: 'noopener noreferrer', 'data-tooltip': '이 Mac에서 원격 주소로 열어 확인합니다' }, '열어 보기 ↗'));
    box.append(row);
    if (!v.active) box.append(h('p', { class: 'field-note' }, '아직 이 주소로는 열리지 않습니다. 왼쪽 단계를 마치고 원격 접속을 켜면 사용할 수 있습니다.'));

    const qr = h('div', { class: `rm-qr${v.active ? '' : ' is-pending'}`, role: 'img', 'aria-label': `접속 주소 QR 코드: ${v.url}` },
      h('span', { class: 'spinner', 'aria-hidden': 'true' }));
    box.append(qr, h('div', { class: 'rm-qr-cap' },
      h('span', {}, '휴대폰 카메라로 비추면 이 주소가 열립니다. 휴대폰도 같은 Tailscale 계정으로 로그인되어 있어야 합니다.'), tipNode('remote_qr')));
    box.append(h('div', { class: 'field-note' }, 'iPhone: Safari에서 연 뒤 공유 버튼 › 홈 화면에 추가 → 앱처럼 열 수 있습니다.'));
    const tok = ++qrToken;
    qrSvg(v.url).then((svg) => {
      if (tok !== qrToken) return;
      qr.replaceChildren(svg);
      if (!v.active) qr.append(h('span', { class: 'rm-qr-overlay' }, '켜면 사용 가능'));
    }).catch((e) => {
      if (tok !== qrToken) return;
      console.warn('QR 코드 생성 실패', e);
      qr.classList.add('is-failed');
      qr.replaceChildren(h('span', { class: 'rm-qr-fail' }, 'QR 코드를 만들지 못했습니다. 위 주소를 직접 입력하세요.'));
    });
    return box;
  }

  function renderLogins(v, local) {
    const saved = v.st.remote_allowed_logins;
    const list = draft || saved;
    const dirty = !!draft && !sameList(draft, saved);
    const userName = (login) => {
      const u = v.ts.users.find((x) => x.login.toLowerCase() === String(login).toLowerCase());
      return u && u.name ? u.name : '';
    };
    const box = h('div', { class: 'rm-logins' },
      h('div', { class: 'field-label' }, h('span', { class: 'label' }, '접속을 허용할 테일넷 로그인'), tipNode('remote_logins'),
        dirty ? h('span', { class: 'badge badge-warn' }, '저장 안 됨') : null));
    const chips = h('div', { class: 'chips rm-login-list' });
    for (const login of list) {
      const nm = userName(login);
      const chip = h('span', { class: 'rm-login-chip' },
        h('span', { class: 'rm-login-id' }, login),
        nm ? h('span', { class: 'rm-login-name' }, nm) : null);
      if (local) {
        const x = h('button', { type: 'button', class: 'icon-btn icon-btn-sm', 'aria-label': `${login} 빼기` }, '×');
        x.addEventListener('click', () => {
          draft = (draft || saved.slice()).filter((l) => l.toLowerCase() !== login.toLowerCase());
          render();
        });
        chip.append(x);
      }
      chips.append(chip);
    }
    if (!list.length) {
      const names = v.ts.users.map((u) => u.login).join(', ');
      chips.append(h('span', { class: 'field-note' }, saved.length || draft
        ? '목록이 비어 있습니다. 최소 한 명은 있어야 합니다.'
        : `비어 있음 — 원격 접속을 켤 때 테일넷 사용자 전부${names ? `(${names})` : ''}가 자동으로 들어갑니다.`));
    }
    box.append(chips);
    if (!local) {
      box.append(h('p', { class: 'field-note' }, '여기에 있는 Tailscale 로그인만 원격으로 열 수 있습니다. 목록은 Mac에서 바꿀 수 있습니다.'));
      return box;
    }

    // 추가
    const input = h('input', {
      type: 'text', inputmode: 'email', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
      placeholder: '예: name@gmail.com (Tailscale 로그인)', 'aria-label': '허용할 로그인 추가', value: addValue,
    });
    input.dataset.rmAdd = '1';
    const addBtn = h('button', { type: 'button', class: 'btn btn-sm' }, '추가');
    const add = (raw) => {
      const login = String(raw || '').trim();
      if (!login) return;
      if (!LOGIN_RE.test(login)) {
        toast('Tailscale 로그인을 정확히 적어 주세요 (예: name@gmail.com). *@도메인 같은 와일드카드는 쓸 수 없습니다.', 'warn');
        return;
      }
      const cur = draft || saved.slice();
      if (cur.some((l) => l.toLowerCase() === login.toLowerCase())) {
        toast('이미 목록에 있습니다.', 'info');
      } else {
        draft = [...cur, login];
      }
      addValue = '';
      render();
    };
    input.addEventListener('input', () => { addValue = input.value; });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        add(input.value);
      }
    });
    addBtn.addEventListener('click', () => add(input.value));
    box.append(h('div', { class: 'input-row rm-login-add' }, input, addBtn));

    const missing = v.ts.users.filter((u) => !list.some((l) => l.toLowerCase() === u.login.toLowerCase()));
    if (missing.length) {
      const sug = h('div', { class: 'chips rm-suggest' }, h('span', { class: 'muted small' }, '테일넷 사용자:'));
      for (const u of missing) {
        const b = h('button', { type: 'button', class: 'chip chip-sm' }, `+ ${u.login}${u.name ? ` (${u.name})` : ''}`);
        b.addEventListener('click', () => add(u.login));
        sug.append(b);
      }
      box.append(sug);
    }

    if (dirty) {
      const saveBtn = h('button', { type: 'button', class: 'btn btn-sm btn-primary' }, '허용 목록 저장');
      const revert = h('button', { type: 'button', class: 'btn btn-sm btn-ghost' }, '되돌리기');
      saveBtn.addEventListener('click', () => withBusy(saveBtn, saveLogins));
      revert.addEventListener('click', () => {
        draft = null;
        render();
      });
      box.append(h('div', { class: 'rm-login-save' }, revert, saveBtn));
    }
    box.append(h('p', { class: 'field-note' }, '여기에 있는 Tailscale 로그인으로 접속한 기기만 Studio를 열 수 있습니다(대소문자 무시). 테일넷에 다른 사람을 초대해도 이 목록에 없으면 막힙니다.'));
    return box;
  }

  // ---------- 동작 ----------
  async function enable() {
    result = null;
    try {
      const r = await api('/api/remote/enable', { method: 'POST', body: {}, timeout: 45000, silent: true });
      if (r && r.tailscale) {
        data = normalize(r);
        error = null;
        loadedAt = Date.now();
      }
      draft = null;
      const v = data ? derive() : null;
      result = { kind: 'ok', message: (r && typeof r.message === 'string' && r.message) || `원격 접속을 켰습니다.${v && v.url ? ` 휴대폰이나 다른 PC에서 ${v.url} 을(를) 여세요.` : ''}`, output: cliOutput(r) };
      toast('원격 접속을 켰습니다. 휴대폰이나 다른 PC에서 접속 주소(또는 QR 코드)로 여세요.', 'success', { title: '원격 접속 켜짐', timeout: 9000 });
    } catch (e) {
      if (e && e.aborted) return;
      const msg = (e && e.message) || '원격 접속을 켜지 못했습니다.';
      result = { kind: 'error', message: msg, output: cliOutput(e && e.data), links: cliLinks(e && e.data) };
      toast(msg, 'error', { title: '원격 접속을 켜지 못했습니다', timeout: 12000 });
    }
    loadStatus();
    await load();
  }

  async function disable() {
    const ok = await confirmDialog({
      title: '원격 접속 끄기',
      message: '원격 접속을 끌까요?',
      detail: '이 Studio로 연결된 Tailscale Serve 설정을 지우고 원격 허용을 끕니다. 지금 원격으로 열려 있는 휴대폰·PC 화면은 바로 끊깁니다. 나중에 다시 켜면 같은 주소로 접속할 수 있습니다.',
      confirmText: '끄기',
      danger: true,
    });
    if (!ok) return;
    result = null;
    try {
      const r = await api('/api/remote/disable', { method: 'POST', body: {}, timeout: 45000, silent: true });
      if (r && r.tailscale) {
        data = normalize(r);
        error = null;
        loadedAt = Date.now();
      }
      result = { kind: 'ok', message: (r && typeof r.message === 'string' && r.message) || '원격 접속을 껐습니다. 이제 이 Mac에서만 Studio를 열 수 있습니다.', output: cliOutput(r) };
      toast('원격 접속을 껐습니다.', 'success');
    } catch (e) {
      if (e && e.aborted) return;
      const msg = (e && e.message) || '원격 접속을 끄지 못했습니다.';
      result = { kind: 'error', message: msg, output: cliOutput(e && e.data) };
      toast(msg, 'error', { title: '원격 접속을 끄지 못했습니다', timeout: 12000 });
    }
    loadStatus();
    await load();
  }

  async function saveLogins() {
    if (!draft || !data) return true;
    const list = draft.slice();
    if (!list.length) {
      toast('허용할 로그인이 최소 한 명은 있어야 합니다. 원격 접속을 막으려면 [원격 접속 끄기]를 누르세요.', 'warn', { timeout: 9000 });
      return false;
    }
    try {
      const r = await api('/api/remote', { method: 'PUT', body: { remote_allowed_logins: list } });
      if (r && r.tailscale) {
        data = normalize(r);
      } else if (r && r.settings && Array.isArray(r.settings.remote_allowed_logins)) {
        data.settings.remote_allowed_logins = strList(r.settings.remote_allowed_logins);
      } else {
        data.settings.remote_allowed_logins = list;
      }
      draft = null;
      toast('허용 목록을 저장했습니다.', 'success');
      render();
      load();
      return true;
    } catch {
      return false;
    }
  }

  // ---------- 바깥에서 부르는 것 ----------
  function activate() {
    if (inflight) return inflight;
    if (!loadedAt || Date.now() - loadedAt > 8000) return load();
    return Promise.resolve();
  }
  function reveal() {
    activate();
    requestAnimationFrame(() => {
      try {
        el.scrollIntoView({ block: 'start', behavior: 'smooth' });
      } catch {
        el.scrollIntoView();
      }
    });
  }

  // 관리 화면에서 HTTPS를 켜고 돌아왔을 때 등: 창이 다시 보이면 최신 상태로
  const onBack = () => {
    if (document.visibilityState === 'visible' && panelVisible() && loadedAt && Date.now() - loadedAt > 4000) load();
  };
  window.addEventListener('focus', onBack);
  document.addEventListener('visibilitychange', onBack);
  // 다른 창(또는 원격 기기)에서 켜고 끈 경우: /api/status의 remote.enabled가 바뀌면 다시 읽는다
  on('status', (s) => {
    const r = s && s.remote && typeof s.remote === 'object' ? !!s.remote.enabled : undefined;
    if (r === undefined) return;
    const changed = lastStatusEnabled !== undefined && r !== lastStatusEnabled;
    lastStatusEnabled = r;
    if (changed && data && panelVisible()) load();
  });

  render();
  return {
    el,
    activate,
    reveal,
    isDirty: () => !!draft && !!data && !sameList(draft, data.settings.remote_allowed_logins),
    save: saveLogins,
    discard() {
      draft = null;
      addValue = '';
      render();
    },
  };
}
