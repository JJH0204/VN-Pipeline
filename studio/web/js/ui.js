// 공용 UI: 토스트, 모달/확인창, 툴팁, 드롭다운 메뉴, 버튼 바쁨 상태, Esc 레이어
import { h, esc, clamp } from './util.js';

// ---------- 키보드 레이어 (모달/라이트박스/메뉴 중 가장 위의 것만 키를 받음) ----------
const layers = [];
export function pushLayer(layer) {
  layers.push(layer);
  return () => {
    const i = layers.indexOf(layer);
    if (i >= 0) layers.splice(i, 1);
  };
}
export function hasLayer() {
  return layers.length > 0;
}
document.addEventListener('keydown', (e) => {
  const top = layers[layers.length - 1];
  if (top && typeof top.onKey === 'function') {
    try {
      top.onKey(e);
    } catch (err) {
      console.error(err);
    }
  }
}, true);

// ---------- 토스트 ----------
const TOAST_ICONS = { info: 'i', success: '✓', error: '!', warn: '!' };
const recentToasts = new Map();

/**
 * @param {string} message
 * @param {'info'|'success'|'error'|'warn'} type
 * @param {{title?: string, action?: {label: string, onClick: Function}, timeout?: number}} opts
 */
export function toast(message, type = 'info', opts = {}) {
  const root = document.getElementById('toasts');
  if (!root) return { close() {} };
  const key = `${type}|${opts.title || ''}|${message}`;
  const now = Date.now();
  if ((recentToasts.get(key) || 0) > now - 2500) return { close() {} };
  recentToasts.set(key, now);
  if (recentToasts.size > 50) recentToasts.clear();

  let timer = null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 200);
  };
  const el = h('div', { class: `toast toast-${type}`, role: type === 'error' ? 'alert' : 'status' },
    h('span', { class: 'toast-icon', 'aria-hidden': 'true' }, TOAST_ICONS[type] || 'i'),
    h('div', { class: 'toast-body' },
      opts.title ? h('div', { class: 'toast-title' }, opts.title) : null,
      h('div', { class: 'toast-msg' }, message)),
    opts.action ? h('button', {
      type: 'button', class: 'btn btn-sm toast-action',
      onclick: () => {
        close();
        try { opts.action.onClick(); } catch (e) { console.error(e); }
      },
    }, opts.action.label) : null,
    h('button', { type: 'button', class: 'toast-close', 'aria-label': '알림 닫기', onclick: close }, '×'));
  root.append(el);
  while (root.children.length > 5) root.firstElementChild.remove();
  const timeout = opts.timeout ?? (type === 'error' ? 8000 : opts.action ? 7000 : 4000);
  const arm = () => { if (timeout > 0) timer = setTimeout(close, timeout); };
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', arm);
  arm();
  return { close };
}

// ---------- 모달 ----------
let modalSeq = 0;
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * @param {{title?: string, body?: Node|string, actions?: Array<{label: string, kind?: string, value?: any, onClick?: Function, autofocus?: boolean}>, size?: 'sm'|'md'|'lg'|'xl', dismissible?: boolean, onClose?: Function, className?: string}} o
 */
export function openModal(o = {}) {
  const { title = '', body, actions = [], size = 'md', dismissible = true, onClose, className = '' } = o;
  const root = document.getElementById('modal-root') || document.body;
  const titleId = `modal-title-${++modalSeq}`;
  const prevFocus = document.activeElement;
  const bodyEl = h('div', { class: 'modal-body' });
  if (body instanceof Node) bodyEl.append(body);
  else if (body != null && body !== '') bodyEl.append(h('p', { class: 'modal-text' }, String(body)));

  let closed = false;
  let busy = false;
  const footer = h('div', { class: 'modal-footer' });
  const dialog = h('div', {
    class: `modal modal-${size} ${className}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1',
  },
  h('div', { class: 'modal-header' },
    h('h2', { id: titleId, class: 'modal-title' }, title),
    dismissible ? h('button', { type: 'button', class: 'icon-btn modal-x', 'aria-label': '닫기', onclick: () => ctl.close() }, '×') : null),
  bodyEl,
  actions.length ? footer : null);
  const overlay = h('div', { class: 'modal-overlay' }, dialog);

  const setDisabled = (d) => {
    footer.querySelectorAll('button').forEach((b) => { b.disabled = d; });
  };
  const buttons = actions.map((a) => {
    const b = h('button', { type: 'button', class: `btn ${a.kind ? 'btn-' + a.kind : ''}` }, a.label);
    if (a.autofocus) b.dataset.autofocus = '1';
    b.addEventListener('click', async () => {
      if (busy) return;
      if (!a.onClick) {
        ctl.close(a.value);
        return;
      }
      busy = true;
      setDisabled(true);
      b.classList.add('is-busy');
      let keep = false;
      try {
        keep = (await a.onClick(ctl)) === false;
      } catch (e) {
        keep = true;
        if (!(e && e.name === 'ApiError')) {
          console.error(e);
          toast(`처리 중 오류가 발생했습니다: ${e && e.message ? e.message : e}`, 'error');
        }
      } finally {
        busy = false;
        b.classList.remove('is-busy');
        if (!closed) setDisabled(false);
      }
      if (!keep) ctl.close(a.value);
    });
    footer.append(b);
    return b;
  });

  const popLayer = pushLayer({
    onKey: (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (dismissible && !busy) ctl.close();
      } else if (e.key === 'Tab') {
        const items = [...dialog.querySelectorAll(FOCUSABLE)].filter((x) => x.offsetParent !== null);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
          e.preventDefault();
          first.focus();
        }
      }
    },
  });

  let downOnOverlay = false;
  overlay.addEventListener('mousedown', (e) => { downOnOverlay = e.target === overlay; });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay && downOnOverlay && dismissible && !busy) ctl.close();
  });

  const ctl = {
    el: dialog,
    body: bodyEl,
    buttons,
    setDisabled,
    close(value) {
      if (closed) return;
      closed = true;
      popLayer();
      overlay.classList.remove('open');
      overlay.classList.add('closing');
      setTimeout(() => overlay.remove(), 180);
      try {
        if (prevFocus && typeof prevFocus.focus === 'function' && document.contains(prevFocus)) prevFocus.focus();
      } catch { /* 무시 */ }
      try {
        onClose && onClose(value);
      } catch (e) {
        console.error(e);
      }
    },
  };

  root.append(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));
  setTimeout(() => {
    const target = dialog.querySelector('[autofocus], [data-autofocus]') ||
      bodyEl.querySelector('input:not([type="hidden"]):not([disabled]), textarea, select') ||
      buttons[buttons.length - 1] || dialog;
    try { target.focus(); } catch { /* 무시 */ }
  }, 30);
  return ctl;
}

export function confirmDialog({ title = '확인', message = '', detail = '', confirmText = '확인', cancelText = '취소', danger = false } = {}) {
  return new Promise((resolve) => {
    const body = h('div', {},
      h('p', { class: 'modal-text' }, message),
      detail ? h('p', { class: 'modal-detail' }, detail) : null);
    openModal({
      title, body, size: 'sm',
      actions: [
        { label: cancelText, kind: 'ghost', value: false },
        { label: confirmText, kind: danger ? 'danger' : 'primary', value: true, autofocus: true },
      ],
      onClose: (v) => resolve(v === true),
    });
  });
}

/** 여러 선택지 대화상자. 취소/닫기 시 null */
export function choiceDialog({ title = '', message = '', detail = '', choices = [] } = {}) {
  return new Promise((resolve) => {
    const body = h('div', {},
      h('p', { class: 'modal-text' }, message),
      detail ? h('p', { class: 'modal-detail' }, detail) : null);
    openModal({
      title, body, size: 'sm',
      actions: choices.map((c) => ({ label: c.label, kind: c.kind || 'ghost', value: c.value, autofocus: c.autofocus })),
      onClose: (v) => resolve(v === undefined ? null : v),
    });
  });
}

/** 저장하지 않은 변경이 있을 때: 'save' | 'discard' | null(취소) */
export function unsavedDialog(what = '변경 사항', canSave = true) {
  const choices = [{ label: '취소', kind: 'ghost', value: null }, { label: '버리고 이동', kind: 'danger', value: 'discard' }];
  if (canSave) choices.push({ label: '저장 후 이동', kind: 'primary', value: 'save', autofocus: true });
  return choiceDialog({
    title: '저장하지 않은 변경 사항',
    message: `저장하지 않은 ${what}이 있습니다.`,
    detail: '이동하기 전에 저장할까요? [버리고 이동]을 누르면 마지막으로 저장한 상태로 되돌립니다.',
    choices,
  });
}

// ---------- 툴팁 ----------
let tipsSource = () => ({});
export function initTooltips(getTips) {
  tipsSource = getTips;
  const tip = document.getElementById('tooltip');
  if (!tip) return;
  let target = null;
  let timer = null;
  const textOf = (el) => (el.dataset.tip ? (tipsSource()[el.dataset.tip] || '') : (el.dataset.tooltip || ''));
  const position = (el) => {
    const r = el.getBoundingClientRect();
    tip.style.left = '0px';
    tip.style.top = '0px';
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const x = clamp(r.left + r.width / 2 - tw / 2, 8, Math.max(8, window.innerWidth - tw - 8));
    let y = r.top - th - 8;
    let side = 'top';
    if (y < 8) {
      y = r.bottom + 8;
      side = 'bottom';
    }
    tip.style.left = `${Math.round(x)}px`;
    tip.style.top = `${Math.round(y)}px`;
    tip.dataset.side = side;
  };
  const show = (el) => {
    const text = textOf(el);
    if (!text || !document.contains(el)) {
      hide();
      return;
    }
    target = el;
    tip.textContent = text;
    tip.hidden = false;
    tip.classList.remove('show');
    position(el);
    requestAnimationFrame(() => tip.classList.add('show'));
  };
  const hide = () => {
    clearTimeout(timer);
    target = null;
    tip.classList.remove('show');
    tip.hidden = true;
  };
  const findHost = (node) => (node instanceof Element ? node.closest('[data-tip],[data-tooltip]') : null);

  // 터치(휴대폰·태블릿): 호버가 없으므로 ⓘ와 배지처럼 누를 것이 없는 곳은 '탭해서 열고 닫기'.
  // 탭 뒤에 브라우저가 흉내 내는 mouseover/mousedown은 무시한다 (버튼을 눌렀는데 툴팁이 따라 뜨지 않게)
  let touchUntil = 0;
  let touchStart = null;
  const fromTouch = () => Date.now() < touchUntil;
  const INTERACTIVE = 'a[href], button, input, select, textarea, label, summary, [role="button"], [role="tab"], [role="switch"]';
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
    touchUntil = Date.now() + 1000;
    touchStart = { x: e.clientX, y: e.clientY };
    if (target && !(e.target instanceof Element && target.contains(e.target))) hide();
  }, true);
  document.addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
    touchUntil = Date.now() + 1000;
    const st = touchStart;
    touchStart = null;
    if (!st || Math.hypot(e.clientX - st.x, e.clientY - st.y) > 10) return; // 스크롤·끌기
    const t = e.target instanceof Element ? e.target : null;
    const el = findHost(t);
    if (!el || el.classList.contains('tip-i')) return; // ⓘ 는 아래 click에서 처리
    // 누를 수 있는 것(버튼·링크…)은 그 동작만. 단, 꺼진 버튼은 왜 꺼졌는지(guardButton 툴팁)를 보여 준다
    const ctl = t.closest(INTERACTIVE);
    if (ctl && el.contains(ctl) && !ctl.disabled) return;
    if (target === el) hide();
    else show(el);
  }, true);

  document.addEventListener('mouseover', (e) => {
    if (fromTouch()) return;
    const el = findHost(e.target);
    if (el === target) return;
    clearTimeout(timer);
    if (!el) {
      hide();
      return;
    }
    timer = setTimeout(() => show(el), el.dataset.tip ? 60 : 280);
  });
  document.addEventListener('focusin', (e) => {
    const el = findHost(e.target);
    if (!el) return;
    let visible = true;
    try { visible = e.target.matches(':focus-visible'); } catch { /* 구형 브라우저 */ }
    if (visible) show(el);
  });
  document.addEventListener('focusout', () => hide());
  document.addEventListener('click', (e) => {
    const el = e.target instanceof Element ? e.target.closest('.tip-i') : null;
    if (el) {
      e.preventDefault();
      if (target === el) hide();
      else show(el);
    }
  });
  document.addEventListener('scroll', () => { if (target) hide(); }, true);
  window.addEventListener('blur', hide);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && target) hide(); });
  document.addEventListener('mousedown', (e) => {
    if (fromTouch()) return; // 터치는 pointerdown에서 처리
    if (target && !(e.target instanceof Element && e.target.closest('.tip-i'))) hide();
  });
}

/** 툴팁 키가 tips.json에 있을 때만 ⓘ를 보인다 */
export function applyTips(root, tips) {
  if (!root || !root.querySelectorAll) return;
  const list = root.matches && root.matches('.tip-i[data-tip]') ? [root] : [];
  list.push(...root.querySelectorAll('.tip-i[data-tip]'));
  for (const el of list) el.hidden = !(tips && tips[el.dataset.tip]);
}

export function tipIcon(key) {
  return `<button type="button" class="tip-i" data-tip="${esc(key)}" aria-label="설명 보기" hidden>i</button>`;
}
export function tipNode(key) {
  const b = h('button', { type: 'button', class: 'tip-i', 'aria-label': '설명 보기', hidden: true }, 'i');
  b.dataset.tip = key;
  return b;
}

export function helpLink(topic, label = '? 설명') {
  return `<a class="help-link" href="#/help/${esc(topic)}" title="도움말에서 자세히 보기">${esc(label)}</a>`;
}

// ---------- 드롭다운 메뉴 ----------
let currentMenu = null;
export function closeMenu() {
  if (!currentMenu) return;
  const m = currentMenu;
  currentMenu = null;
  m.cleanup();
}

/**
 * @param {HTMLElement} anchor
 * @param {Array<'-'|{label: string, onClick?: Function, danger?: boolean, disabled?: boolean, hint?: string}>} items
 */
export function openMenu(anchor, items, { align = 'left' } = {}) {
  if (currentMenu && currentMenu.anchor === anchor) {
    closeMenu();
    return;
  }
  closeMenu();
  const menu = h('div', { class: 'menu', role: 'menu' });
  for (const it of items) {
    if (it === '-') {
      menu.append(h('div', { class: 'menu-sep', role: 'separator' }));
      continue;
    }
    menu.append(h('button', {
      type: 'button', role: 'menuitem', class: `menu-item${it.danger ? ' danger' : ''}`, disabled: !!it.disabled,
      onclick: () => {
        closeMenu();
        try { it.onClick && it.onClick(); } catch (e) { console.error(e); }
      },
    }, h('span', { class: 'menu-label' }, it.label), it.hint ? h('span', { class: 'menu-hint' }, it.hint) : null));
  }
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let x = align === 'right' ? r.right - mw : r.left;
  x = clamp(x, 8, window.innerWidth - mw - 8);
  let y = r.bottom + 6;
  if (y + mh > window.innerHeight - 8) y = Math.max(8, r.top - mh - 6);
  menu.style.left = `${Math.round(x)}px`;
  menu.style.top = `${Math.round(y)}px`;
  anchor.setAttribute('aria-expanded', 'true');

  const onDown = (e) => {
    if (!menu.contains(e.target) && !anchor.contains(e.target)) closeMenu();
  };
  const onScroll = (e) => {
    if (!menu.contains(e.target)) closeMenu();
  };
  document.addEventListener('mousedown', onDown, true);
  window.addEventListener('resize', closeMenu);
  document.addEventListener('scroll', onScroll, true);
  const pop = pushLayer({
    onKey: (e) => {
      const btns = [...menu.querySelectorAll('.menu-item:not([disabled])')];
      const i = btns.indexOf(document.activeElement);
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeMenu();
        anchor.focus();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        (btns[(i + 1) % btns.length] || btns[0])?.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        (btns[(i - 1 + btns.length) % btns.length] || btns[0])?.focus();
      } else if (e.key === 'Tab') {
        closeMenu();
      }
    },
  });
  currentMenu = {
    anchor,
    cleanup() {
      pop();
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('resize', closeMenu);
      document.removeEventListener('scroll', onScroll, true);
      anchor.setAttribute('aria-expanded', 'false');
      menu.remove();
    },
  };
  menu.querySelector('.menu-item:not([disabled])')?.focus();
}

// ---------- 버튼 바쁨 상태 ----------
export async function withBusy(btn, fn) {
  if (!btn) return fn();
  if (btn.dataset.busy) return undefined;
  btn.dataset.busy = '1';
  const was = btn.disabled;
  btn.disabled = true;
  btn.classList.add('is-busy');
  try {
    return await fn();
  } finally {
    delete btn.dataset.busy;
    btn.classList.remove('is-busy');
    if (typeof btn._refresh === 'function') btn._refresh();
    else btn.disabled = was;
  }
}

/** 오류를 삼키는 이벤트 핸들러 래퍼 (ApiError는 이미 토스트로 알렸으므로 조용히) */
export function safe(fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      if (e && (e.name === 'ApiError' || e.aborted)) return undefined;
      console.error(e);
      toast(`처리 중 오류가 발생했습니다: ${e && e.message ? e.message : e}`, 'error');
      return undefined;
    }
  };
}

// ---------- 작은 조각들 ----------
export function spinner(label = '불러오는 중…') {
  return h('div', { class: 'loading-row', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', {}, label));
}

/**
 * @param {{icon?: string, title: string, text?: string, actions?: Node[]}} o
 */
export function emptyState({ icon = '◇', title, text = '', actions = [] } = {}) {
  return h('div', { class: 'empty-state' },
    h('div', { class: 'empty-icon', 'aria-hidden': 'true' }, icon),
    h('div', { class: 'empty-title' }, title),
    text ? h('div', { class: 'empty-text' }, text) : null,
    actions.length ? h('div', { class: 'empty-actions' }, actions) : null);
}

export function badge(text, kind = 'muted', tooltip = '') {
  const b = h('span', { class: `badge badge-${kind}` }, text);
  if (tooltip) b.dataset.tooltip = tooltip;
  return b;
}

/**
 * 비활성 사유를 보여주는 버튼 래퍼. update(reason)로 상태 갱신.
 * 비활성 버튼은 마우스 이벤트를 받지 않으므로 바깥 span에 툴팁을 단다.
 */
export function guardButton(btn, reasonEl = null) {
  const wrap = h('span', { class: 'btn-guard' });
  btn.replaceWith(wrap);
  wrap.append(btn);
  let reason = '';
  const apply = () => {
    btn.disabled = !!reason || !!btn.dataset.busy;
    if (reason) wrap.dataset.tooltip = reason;
    else delete wrap.dataset.tooltip;
    if (reasonEl) {
      reasonEl.textContent = reason;
      reasonEl.hidden = !reason;
    }
  };
  btn._refresh = apply;
  return {
    wrap,
    btn,
    update(r) {
      reason = r || '';
      apply();
    },
    get reason() {
      return reason;
    },
  };
}
