// 도움말 탭: help/index.json 목차 + help/*.html 조각을 한 페이지로 표시
import { h, refs, encodePath, debounce } from '../util.js';
import { emptyState, spinner } from '../ui.js';
import { store, loadHelpIndex, loadTips } from '../store.js';
import { isPhone } from '../mobile.js';

/** 섹션으로 스크롤할 때 위쪽 여백: 데스크톱은 상단 바(탭 포함) 아래 112px, 휴대폰은 얇은 상단 바 바로 아래 */
function topOffset() {
  if (!isPhone()) return 112;
  const bar = document.getElementById('topbar');
  return (bar ? bar.getBoundingClientRect().height : 50) + 12;
}

// 다른 탭의 "? 설명" 링크(#/help/<주제>)를 실제 섹션 id로 연결하기 위한 후보
const TOPIC_HINTS = {
  start: { ids: ['start', 'getting-started', 'intro', 'quickstart'], words: ['시작'] },
  workflow: { ids: ['workflow', 'workflows', 'flow', 'pipeline'], words: ['워크플로', '작업 흐름', '흐름'] },
  prompt: { ids: ['prompt', 'prompts', 'prompting'], words: ['프롬프트'] },
  models: { ids: ['models', 'model', 'checkpoints', 'checkpoint'], words: ['체크포인트', '모델'] },
  loras: { ids: ['loras', 'lora'], words: ['lora', '로라'] },
  quality: { ids: ['quality', 'quality-settings', 'settings'], words: ['품질'] },
  sprites: { ids: ['sprites', 'sprite', 'expressions', 'expression'], words: ['스프라이트', '표정'] },
  troubleshooting: { ids: ['troubleshooting', 'troubleshoot', 'trouble', 'faq', 'problems', 'issues'], words: ['문제', '해결'] },
  license: { ids: ['license', 'licenses', 'licensing'], words: ['라이선스'] },
};

export function resolveHelpTopic(topic, index) {
  if (!index || !index.length) return null;
  if (!topic) return index[0].id;
  if (index.some((s) => s.id === topic)) return topic;
  const hint = TOPIC_HINTS[topic];
  if (hint) {
    for (const id of hint.ids) if (index.some((s) => s.id === id)) return id;
    for (const w of hint.words) {
      const f = index.find((s) => String(s.title || '').toLowerCase().includes(w.toLowerCase()));
      if (f) return f.id;
    }
  }
  const f = index.find((s) => s.id.includes(topic) || topic.includes(s.id));
  return f ? f.id : index[0].id;
}

/** 도움말 조각 정리: 스크립트·이벤트 속성 제거, 내부 링크를 라우터 형식으로 */
function sanitize(html) {
  const t = document.createElement('template');
  t.innerHTML = html;
  t.content.querySelectorAll('script, iframe, object, embed, link, meta, style, base, form').forEach((n) => n.remove());
  t.content.querySelectorAll('*').forEach((el) => {
    for (const a of [...el.attributes]) {
      const name = a.name.toLowerCase();
      const val = String(a.value || '').trim().toLowerCase();
      if (name.startsWith('on')) el.removeAttribute(a.name);
      else if ((name === 'href' || name === 'src' || name === 'xlink:href') && (val.startsWith('javascript:') || val.startsWith('data:text'))) el.removeAttribute(a.name);
    }
    if (el.tagName === 'A') {
      const href = el.getAttribute('href') || '';
      if (/^#[^/]/.test(href)) el.setAttribute('href', `#/help/${href.slice(1)}`);
      else if (/^https?:\/\//i.test(href)) {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }
    }
    if (el.id) el.id = `hx-${el.id}`;
  });
  return t.content;
}

export function createHelpView() {
  let $ = null;
  let loading = null;
  let loaded = false;
  let index = [];
  let wrappers = new Map(); // id -> element
  let io = null;
  let activeId = '';
  let pendingTopic = null;

  function setActive(id) {
    if (!id || id === activeId) return;
    activeId = id;
    $.toc.querySelectorAll('a[data-id]').forEach((a) => {
      const on_ = a.dataset.id === id;
      a.classList.toggle('active', on_);
      if (on_) a.setAttribute('aria-current', 'true');
      else a.removeAttribute('aria-current');
    });
    // 휴대폰: 목차가 가로로 넘기는 한 줄이므로 지금 읽는 가이드가 보이게 옆으로 옮긴다
    if (isPhone()) {
      const a = $.toc.querySelector('a.active');
      const list = a && a.closest('.toc-list');
      if (a && list) list.scrollTo({ left: Math.max(0, a.offsetLeft - 12), behavior: 'smooth' });
    }
  }

  function renderMissing(msg) {
    $.toc.replaceChildren();
    $.content.replaceChildren(emptyState({
      icon: '?',
      title: '도움말 파일을 찾지 못했습니다',
      text: msg || 'studio/web/help/ 폴더의 index.json과 가이드 파일을 확인하세요. 설치 직후라면 잠시 후 다시 불러와 보세요.',
      actions: [h('button', { type: 'button', class: 'btn btn-sm', onclick: () => { loaded = false; store.helpIndex = null; load(true).then(() => scrollToTopic(pendingTopic)); } }, '다시 불러오기')],
    }));
  }

  async function load(force = false) {
    if (loaded && !force) return;
    if (loading) return loading;
    loading = (async () => {
      $.content.replaceChildren(spinner('도움말을 불러오는 중…'));
      let idx = store.helpIndex;
      if (!idx || force) idx = await loadHelpIndex();
      if (!store.tipsLoaded) loadTips();
      if (!idx || !idx.length) {
        renderMissing(store.helpError || '');
        return;
      }
      index = idx;
      const results = await Promise.all(idx.map(async (s) => {
        try {
          const res = await fetch(`/static/help/${encodePath(s.file)}`, { cache: 'no-store' });
          if (!res.ok) throw new Error(String(res.status));
          return { s, html: await res.text() };
        } catch {
          return { s, html: null };
        }
      }));
      render(results);
      loaded = true;
    })();
    try {
      await loading;
    } finally {
      loading = null;
    }
  }

  function render(results) {
    $.toc.replaceChildren();
    $.content.replaceChildren();
    wrappers = new Map();
    if (io) io.disconnect();
    const ol = h('ol', { class: 'toc-list' });
    for (const { s, html } of results) {
      const a = h('a', { href: `#/help/${encodeURIComponent(s.id)}`, class: 'toc-link' }, s.title || s.id);
      a.dataset.id = s.id;
      ol.append(h('li', {}, a));
      const wrap = h('div', { class: 'help-section', id: `help-${s.id}` });
      wrap.dataset.id = s.id;
      if (html == null) {
        wrap.append(h('h2', {}, s.title || s.id), h('p', { class: 'muted' }, `이 가이드 파일(help/${s.file})을 불러오지 못했습니다.`));
      } else {
        const frag = sanitize(html);
        if (!frag.querySelector('h1, h2')) wrap.append(h('h2', {}, s.title || s.id));
        wrap.append(frag);
      }
      $.content.append(wrap);
      wrappers.set(s.id, wrap);
    }
    $.toc.append(ol);
    $.count.textContent = `${results.length}개 가이드`;
    if ('IntersectionObserver' in window) {
      io = new IntersectionObserver((entries) => {
        const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (vis.length) setActive(vis[0].target.dataset.id);
      }, { rootMargin: '-120px 0px -65% 0px' });
      for (const w of wrappers.values()) io.observe(w);
    }
    applySearch();
  }

  function applySearch() {
    const q = $.search.value.trim().toLowerCase();
    let n = 0;
    for (const [id, w] of wrappers) {
      const s = index.find((x) => x.id === id);
      const hit = !q || w.textContent.toLowerCase().includes(q) || String(s && s.title || '').toLowerCase().includes(q);
      w.hidden = !hit;
      const a = $.toc.querySelector(`a[data-id="${CSS.escape(id)}"]`);
      if (a) a.parentElement.hidden = !hit;
      if (hit) n++;
    }
    $.searchNote.textContent = q ? (n ? `${n}개 가이드에서 찾음` : '검색 결과가 없습니다') : '';
  }

  function scrollToTopic(topic) {
    if (!loaded) return;
    // 섹션 안의 소제목 앵커(#hx-...)로 바로 가는 링크
    if (topic && !index.some((s) => s.id === topic)) {
      let anchor = null;
      try {
        anchor = $.content.querySelector(`#hx-${CSS.escape(topic)}`);
      } catch {
        anchor = null;
      }
      if (anchor) {
        const sec = anchor.closest('.help-section');
        if (sec && sec.hidden) {
          $.search.value = '';
          applySearch();
        }
        if (sec) setActive(sec.dataset.id);
        requestAnimationFrame(() => {
          window.scrollTo({ top: Math.max(0, anchor.getBoundingClientRect().top + window.scrollY - topOffset()), behavior: 'smooth' });
        });
        return;
      }
    }
    const id = resolveHelpTopic(topic, index);
    const w = id && wrappers.get(id);
    if (!w) return;
    if (w.hidden) {
      $.search.value = '';
      applySearch();
    }
    setActive(id);
    requestAnimationFrame(() => {
      const top = w.getBoundingClientRect().top + window.scrollY - topOffset();
      window.scrollTo({ top: Math.max(0, top), behavior: topic ? 'smooth' : 'auto' });
    });
  }

  function mount(el) {
    el.innerHTML = `
      <div class="help-layout">
        <aside class="panel help-nav">
          <div class="panel-head"><h2 class="panel-title">도움말</h2><span class="muted small" data-ref="count"></span></div>
          <input type="search" class="list-search" data-ref="search" placeholder="도움말 검색 (예: vpred, 손, LoRA)" aria-label="도움말 검색">
          <div class="small muted" data-ref="searchNote"></div>
          <nav class="help-toc" data-ref="toc" aria-label="도움말 목차"></nav>
        </aside>
        <article class="panel help-content prose" data-ref="content"></article>
      </div>`;
    $ = refs(el);
    $.search.addEventListener('input', debounce(applySearch, 150));
    // 지금 주소와 같은 링크를 다시 누르면 hashchange가 일어나지 않으므로 직접 그 위치로 스크롤한다
    el.addEventListener('click', (e) => {
      const a = e.target instanceof Element ? e.target.closest('a[href^="#/help/"]') : null;
      if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const href = a.getAttribute('href');
      if (href !== location.hash) return;
      e.preventDefault();
      let topic = href.slice('#/help/'.length);
      try {
        topic = decodeURIComponent(topic);
      } catch { /* 그대로 사용 */ }
      scrollToTopic(topic);
    });
  }

  return {
    id: 'help',
    title: '도움말',
    mount,
    async show(params) {
      pendingTopic = params && params[0] ? params[0] : null;
      await load();
      scrollToTopic(pendingTopic);
    },
    hide() {},
    isDirty: () => false,
  };
}

