// 갤러리 탭: 폴더/종류/캐릭터 필터, 검색, 무한 스크롤, 라이트박스
import { h, refs, lsGet, lsSet, debounce, KIND_LABELS } from '../util.js';
import { api } from '../api.js';
import { store, on } from '../store.js';
import { galleryGrid } from '../components.js';

const FILTER_KEY = 'vn.gallery.filters';
const KINDS = ['', 'concept', 'sprite', 'cg', 'prompt', 'bg', 'sheet', 'pixel', 'icon', 'other'];
const THUMB_SIZES = { sm: '작게', md: '보통', lg: '크게' };

export function createGalleryView() {
  let $ = null;
  let grid = null;
  let visible = false;
  let stale = false;
  let newCount = 0;
  const saved = lsGet(FILTER_KEY, {}) || {};
  const f = {
    q: '',
    folder: typeof saved.folder === 'string' ? saved.folder : '',
    kind: KINDS.includes(saved.kind) ? saved.kind : '',
    char: typeof saved.char === 'string' ? saved.char : '',
  };
  let thumbSize = THUMB_SIZES[saved.size] ? saved.size : 'md';
  let folders = [];

  function persist() {
    lsSet(FILTER_KEY, { folder: f.folder, kind: f.kind, char: f.char, size: thumbSize });
  }
  function params() {
    return { folder: f.folder, q: f.q, char: f.char, kind: f.kind };
  }
  function apply() {
    persist();
    newCount = 0;
    $.newPill.hidden = true;
    renderFilterState();
    grid.setParams(params());
  }

  function renderFolders() {
    const sel = $.folder;
    sel.replaceChildren(h('option', { value: '' }, '모든 폴더'));
    const list = folders.slice();
    if (f.folder && !list.includes(f.folder)) list.unshift(f.folder);
    for (const d of list) sel.append(h('option', { value: d }, `output/${d}`));
    sel.value = f.folder;
  }
  function renderChars() {
    const sel = $.char;
    sel.replaceChildren(h('option', { value: '' }, '모든 캐릭터'));
    const ids = new Set();
    for (const c of store.characters) {
      ids.add(c.id);
      sel.append(h('option', { value: c.id }, c.name ? `${c.name} (${c.id})` : c.id));
    }
    if (f.char && !ids.has(f.char)) sel.append(h('option', { value: f.char }, f.char));
    sel.value = f.char;
  }
  function renderKinds() {
    $.kinds.replaceChildren();
    for (const k of KINDS) {
      const b = h('button', { type: 'button', class: `seg-btn${f.kind === k ? ' active' : ''}`, 'aria-pressed': f.kind === k ? 'true' : 'false' }, k ? KIND_LABELS[k] : '전체');
      b.addEventListener('click', () => {
        if (f.kind === k) return;
        f.kind = k;
        renderKinds();
        apply();
      });
      $.kinds.append(b);
    }
  }
  function renderSizes() {
    $.sizes.replaceChildren();
    for (const [k, label] of Object.entries(THUMB_SIZES)) {
      const b = h('button', { type: 'button', class: `seg-btn${thumbSize === k ? ' active' : ''}`, 'aria-pressed': thumbSize === k ? 'true' : 'false' }, label);
      b.addEventListener('click', () => {
        thumbSize = k;
        renderSizes();
        $.gridSlot.className = `gallery-grid gallery-size-${thumbSize}`;
        persist();
      });
      $.sizes.append(b);
    }
  }
  function renderFilterState() {
    const active = !!(f.q || f.folder || f.kind || f.char);
    $.reset.hidden = !active;
    // 휴대폰에서 접어 둔 필터(폴더·캐릭터·종류) 중 켜진 개수
    const n = [f.folder, f.kind, f.char].filter(Boolean).length;
    $.filterToggle.textContent = n ? `필터 ${n}` : '필터';
    $.filterToggle.classList.toggle('active', !!n);
  }

  function mount(el) {
    el.innerHTML = `
      <div class="gallery-view">
        <div class="panel gallery-toolbar" data-ref="toolbar">
          <div class="toolbar-row">
            <input type="search" class="gallery-search" data-ref="q" placeholder="파일 이름·프롬프트 검색" aria-label="이미지 검색">
            <button type="button" class="btn btn-sm gallery-filter-toggle" data-ref="filterToggle" aria-expanded="false">필터</button>
            <select class="select select-sm gf-extra" data-ref="folder" aria-label="폴더 필터"></select>
            <select class="select select-sm gf-extra" data-ref="char" aria-label="캐릭터 필터"></select>
            <button type="button" class="btn btn-sm btn-ghost" data-ref="reset" hidden>필터 초기화</button>
            <span class="toolbar-spacer"></span>
            <span class="gallery-count" data-ref="count" aria-live="polite"></span>
          </div>
          <div class="toolbar-row gf-extra">
            <div class="seg" data-ref="kinds" role="group" aria-label="종류 필터"></div>
            <span class="toolbar-spacer"></span>
            <div class="seg seg-sm" data-ref="sizes" role="group" aria-label="썸네일 크기"></div>
            <button type="button" class="btn btn-sm btn-ghost" data-ref="refresh">새로고침</button>
            <button type="button" class="btn btn-sm btn-ghost" data-ref="openOutput" data-local-only>출력 폴더 열기</button>
          </div>
        </div>
        <button type="button" class="new-pill" data-ref="newPill" hidden></button>
        <div data-ref="gridSlot"></div>
      </div>`;
    $ = refs(el);
    $.gridSlot.className = `gallery-grid gallery-size-${thumbSize}`;

    grid = galleryGrid({
      params: params(),
      pageSize: 60,
      infinite: true,
      showKind: true,
      emptyTitle: '조건에 맞는 이미지가 없습니다',
      emptyText: '필터를 바꾸거나, 생성 탭에서 새 이미지를 만들어 보세요.',
      emptyActions: () => (f.q || f.folder || f.kind || f.char)
        ? [h('button', { type: 'button', class: 'btn btn-sm', onclick: resetFilters }, '필터 초기화')]
        : [h('a', { class: 'btn btn-sm btn-primary', href: '#/generate' }, '이미지 만들기')],
      onLoaded: ({ items, total, folders: fl }) => {
        if (Array.isArray(fl) && fl.join('|') !== folders.join('|')) {
          folders = fl;
          renderFolders();
        }
        $.count.textContent = total ? `${items.length.toLocaleString()} / ${total.toLocaleString()}장` : '';
      },
    });
    $.gridSlot.append(grid.el);

    function resetFilters() {
      f.q = '';
      f.folder = '';
      f.kind = '';
      f.char = '';
      $.q.value = '';
      renderFolders();
      renderChars();
      renderKinds();
      apply();
    }

    $.q.addEventListener('input', debounce(() => {
      const v = $.q.value.trim();
      if (v === f.q) return;
      f.q = v;
      apply();
    }, 350));
    $.folder.addEventListener('change', () => { f.folder = $.folder.value; apply(); });
    $.char.addEventListener('change', () => { f.char = $.char.value; apply(); });
    $.reset.addEventListener('click', resetFilters);
    // 휴대폰: 필터 줄은 접어 두고 [필터]로 펼친다 (mobile.css의 .gallery-toolbar.is-open)
    $.filterToggle.addEventListener('click', () => {
      const open = !$.toolbar.classList.contains('is-open');
      $.toolbar.classList.toggle('is-open', open);
      $.filterToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    $.refresh.addEventListener('click', () => { newCount = 0; $.newPill.hidden = true; grid.reload(); });
    on('secret-purged', () => { newCount = 0; $.newPill.hidden = true; grid.reload(); }); // 시크릿 그림이 지워짐
    $.openOutput.addEventListener('click', () => {
      api('/api/open-folder', { method: 'POST', body: { which: 'output' } }).catch(() => {});
    });
    $.newPill.addEventListener('click', () => {
      newCount = 0;
      $.newPill.hidden = true;
      grid.reload();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    renderFolders();
    renderChars();
    renderKinds();
    renderSizes();
    renderFilterState();
    grid.reload();

    on('characters', renderChars);
    on('job', (job, prev) => {
      if (job.status !== 'done' || (prev && prev.status === 'done')) return;
      const n = (job.outputs || []).length;
      if (!n) return;
      if (!visible) {
        stale = true;
        return;
      }
      newCount += n;
      $.newPill.textContent = `새 이미지 ${newCount}장 · 눌러서 새로고침`;
      $.newPill.hidden = false;
    });
    on('gallery-changed', () => { if (!visible) stale = true; });
  }

  return {
    id: 'gallery',
    title: '갤러리',
    mount,
    show() {
      visible = true;
      if (stale) {
        stale = false;
        newCount = 0;
        $.newPill.hidden = true;
        grid.reload();
      }
    },
    hide() {
      visible = false;
    },
    isDirty: () => false,
  };
}

