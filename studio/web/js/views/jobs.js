// 작업 탭: 대기/진행/완료/실패 목록, 진행률, 취소/재시도/기록 삭제, 실패 메시지
import { h, refs, fmtClock, fmtDuration, fmtRelative, fmtDateTime, nowSec, detectAlpha } from '../util.js';
import { toast, confirmDialog, withBusy, emptyState, helpLink } from '../ui.js';
import {
  store, on, sortedJobs, isActive, cancelJob, retryJob, deleteJobRecord, loadJobs, comfy, engineBlockReason,
} from '../store.js';
import {
  statusBadge, jobTitle, jobMetaChips, jobPercent, stageText, queueAhead, jobExprCount, openJobOutputs, showJobError,
  itemFromOutput, openEngineLog,
} from '../components.js';
import { remainingText, etaText, jobEtaOpts } from '../eta.js';

const FILTERS = [
  ['all', '전체'],
  ['active', '진행·대기'],
  ['done', '완료'],
  ['failed', '실패·취소'],
];
const match = (f, j) => f === 'all'
  || (f === 'active' && isActive(j))
  || (f === 'done' && j.status === 'done')
  || (f === 'failed' && (j.status === 'error' || j.status === 'cancelled'));

export function createJobsView() {
  let $ = null;
  let filter = 'all';
  let visible = false;
  const rows = new Map(); // id -> {row, r, status, outKey, actKey}

  // 필터 버튼은 한 번만 만들고 숫자·선택 상태만 바꾼다 (진행 이벤트마다 버튼을 새로 만들면 클릭이 씹힐 수 있음)
  let filterBtns = null; // k -> {b, n}
  function renderFilters() {
    if (!filterBtns) {
      filterBtns = new Map();
      $.filters.replaceChildren();
      for (const [k, label] of FILTERS) {
        const n = h('span', { class: 'seg-count' });
        const b = h('button', { type: 'button', class: 'seg-btn' }, label, n);
        b.addEventListener('click', () => {
          filter = k;
          renderAll();
        });
        filterBtns.set(k, { b, n });
        $.filters.append(b);
      }
    }
    const jobs = [...store.jobs.values()];
    for (const [k] of FILTERS) {
      const { b, n } = filterBtns.get(k);
      const cnt = String(jobs.filter((j) => match(k, j)).length);
      if (n.textContent !== cnt) n.textContent = cnt;
      b.classList.toggle('active', filter === k);
      b.setAttribute('aria-pressed', filter === k ? 'true' : 'false');
    }
    const c = comfy();
    $.engineQueue.textContent = c.running
      ? `엔진 대기열: 실행 ${c.queue_running || 0} · 대기 ${c.queue_pending || 0}`
      : '엔진 꺼짐';
    $.engineQueue.dataset.tooltip = '다른 프로그램(예: ComfyUI 웹 화면)에서 넣은 작업도 포함된 엔진 전체 대기열입니다.';
  }

  function makeRow(job) {
    const row = h('article', { class: 'job-row' });
    row.innerHTML = `
      <div class="job-status" data-ref="status"></div>
      <div class="job-main">
        <div class="job-title-line">
          <span class="job-title" data-ref="title"></span>
          <span class="job-time" data-ref="time"></span>
        </div>
        <div class="meta-chips" data-ref="meta"></div>
        <div class="job-progress-wrap" data-ref="progWrap" hidden>
          <div class="job-stage" data-ref="stage"></div>
          <div class="progress" data-ref="progress"><div class="progress-bar" data-ref="bar"></div></div>
        </div>
        <div class="job-stats"><span data-ref="elapsed"></span><span data-ref="eta"></span><span class="job-pct" data-ref="pct"></span></div>
        <div class="job-error" data-ref="error" hidden></div>
        <div class="job-outputs" data-ref="outputs"></div>
      </div>
      <div class="job-actions" data-ref="actions"></div>`;
    const entry = { row, r: refs(row), status: null, outKey: '', actKey: '' };
    rows.set(job.id, entry);
    patch(entry, job);
    return row;
  }

  function renderActions(entry, job) {
    const block = engineBlockReason();
    const key = `${job.status}|${(job.outputs || []).length}|${block}`;
    if (key === entry.actKey) return;
    entry.actKey = key;
    const a = entry.r.actions;
    a.replaceChildren();
    const btn = (label, kind, fn, tip, needsEngine = false) => {
      const b = h('button', { type: 'button', class: `btn btn-sm ${kind ? 'btn-' + kind : ''}` }, label);
      const wrap = h('span', { class: 'btn-guard' }, b);
      if (needsEngine && block) {
        b.disabled = true;
        wrap.dataset.tooltip = block;
      } else if (tip) {
        wrap.dataset.tooltip = tip;
      }
      b.addEventListener('click', () => withBusy(b, fn));
      a.append(wrap);
    };
    if (isActive(job)) {
      btn('취소', 'ghost', () => cancelJob(job.id), job.status === 'running' ? '지금 단계에서 생성을 중단합니다. 이미 저장된 이미지는 남습니다.' : '대기열에서 뺍니다');
      return;
    }
    if (job.status === 'error') btn('실패 원인', 'ghost', async () => showJobError(job));
    if (job.status === 'done' && (job.outputs || []).length) btn('결과 보기', 'ghost', async () => openJobOutputs(job, 0));
    btn(job.status === 'done' ? '다시 생성' : '다시 시도', 'ghost', () => retryJob(job.id), '같은 설정으로 새 작업을 만듭니다 (랜덤 시드였다면 새 시드)', true);
    btn('기록 삭제', 'danger-ghost', async () => {
      if (await deleteJobRecord(job.id)) toast('작업 기록을 지웠습니다. 이미지 파일은 그대로 남아 있습니다.', 'info');
    }, '목록에서만 지웁니다 (이미지 파일은 유지)');
  }

  function renderOutputs(entry, job) {
    const outs = job.outputs || [];
    const key = outs.map((o) => o.path).join('|');
    if (key === entry.outKey) return;
    entry.outKey = key;
    const box = entry.r.outputs;
    box.replaceChildren();
    const max = 8;
    outs.slice(0, max).forEach((o, i) => {
      const it = itemFromOutput(o);
      const img = h('img', { src: it.thumb, alt: it.name, loading: 'lazy', decoding: 'async' });
      const b = h('button', { type: 'button', class: 'out-thumb', 'aria-label': `${it.name} 크게 보기` }, img);
      img.addEventListener('load', () => detectAlpha(img, it.path, (al) => b.classList.toggle('checker', al)), { once: true });
      b.addEventListener('click', () => openJobOutputs(job, i));
      box.append(b);
    });
    if (outs.length > max) {
      const more = h('button', { type: 'button', class: 'out-more' }, `+${outs.length - max}`);
      more.addEventListener('click', () => openJobOutputs(job, max));
      box.append(more);
    }
  }

  function tickRow(entry, job) {
    const r = entry.r;
    const now = nowSec();
    const exprCount = jobExprCount(job);
    if (job.status === 'running') {
      r.elapsed.textContent = job.started ? `경과 ${fmtClock(now - job.started)}` : '';
      r.eta.textContent = remainingText(job, { exprCount });
    } else if (job.status === 'queued') {
      const n = queueAhead(job);
      r.elapsed.textContent = n ? `앞에 ${n}개 작업` : '곧 시작';
      r.eta.textContent = etaText(job.spec || {}, jobEtaOpts(job, { exprCount }));
    } else if (job.started && job.finished) {
      r.elapsed.textContent = `소요 ${fmtDuration(job.finished - job.started)}`;
      r.eta.textContent = '';
    } else {
      r.elapsed.textContent = '';
      r.eta.textContent = '';
    }
  }

  function patch(entry, job) {
    const r = entry.r;
    entry.row.className = `job-row st-${job.status}`;
    entry.row.dataset.id = job.id;
    if (entry.status !== job.status) {
      r.status.replaceChildren(statusBadge(job.status));
      entry.status = job.status;
    }
    r.title.textContent = jobTitle(job);
    r.time.textContent = fmtRelative(job.created);
    r.time.dataset.tooltip = `만든 시각 ${fmtDateTime(job.created)}${job.finished ? `\n끝난 시각 ${fmtDateTime(job.finished)}` : ''}`;
    r.meta.replaceChildren(...jobMetaChips(job));
    const running = job.status === 'running';
    const active = isActive(job);
    r.progWrap.hidden = !active;
    if (active) {
      const pct = jobPercent(job);
      r.stage.textContent = running ? stageText(job) : '대기 중';
      r.progress.classList.toggle('indeterminate', !running || pct <= 0.5);
      r.bar.style.width = `${running ? pct : 0}%`;
      r.pct.textContent = running ? `${Math.floor(pct)}%` : '';
    } else {
      r.pct.textContent = '';
    }
    if (job.status === 'error') {
      const msg = job.error || '알 수 없는 오류';
      r.error.hidden = false;
      r.error.replaceChildren(
        h('span', { class: 'job-error-text' }, msg.length > 180 ? msg.slice(0, 180) + '…' : msg),
        msg.length > 180 ? h('button', { type: 'button', class: 'link-btn', onclick: () => showJobError(job) }, '전체 보기') : '');
    } else {
      r.error.hidden = true;
    }
    renderOutputs(entry, job);
    renderActions(entry, job);
    tickRow(entry, job);
  }

  function renderAll() {
    if (!$) return;
    renderFilters();
    rows.clear();
    $.list.replaceChildren();
    const jobs = sortedJobs().filter((j) => match(filter, j));
    if (!store.jobsLoaded) {
      $.list.append(h('div', { class: 'loading-row' }, h('span', { class: 'spinner' }), h('span', {}, '작업 목록을 불러오는 중…')));
      return;
    }
    if (!jobs.length) {
      const texts = {
        all: ['아직 작업이 없습니다', '생성·캐릭터·배경 탭에서 이미지를 만들면 여기에 기록됩니다.'],
        active: ['진행 중이거나 대기 중인 작업이 없습니다', '엔진이 쉬고 있습니다.'],
        done: ['완료된 작업이 없습니다', ''],
        failed: ['실패하거나 취소된 작업이 없습니다', '좋은 소식입니다.'],
      }[filter];
      $.list.append(emptyState({
        icon: '≡', title: texts[0], text: texts[1],
        actions: filter === 'all' ? [h('a', { class: 'btn btn-sm btn-primary', href: '#/generate' }, '이미지 만들기')] : [],
      }));
      return;
    }
    const act = jobs.filter(isActive).sort((a, b) => (a.created || 0) - (b.created || 0));
    const rest = jobs.filter((j) => !isActive(j));
    if (act.length) {
      $.list.append(h('h3', { class: 'list-group-title' }, `진행·대기 ${act.length}`));
      for (const j of act) $.list.append(makeRow(j));
    }
    if (rest.length) {
      if (act.length) $.list.append(h('h3', { class: 'list-group-title' }, '기록'));
      for (const j of rest) $.list.append(makeRow(j));
    }
  }

  function onJob(job, prev) {
    if (!$) return;
    const entry = rows.get(job.id);
    // 지금 필터에 보이지 않는 작업(예: '완료' 필터에서 진행 중인 작업)의 진행 이벤트는 목록을 다시 그리지 않는다.
    // 새로 필터에 들어오는 경우(진행 → 완료 등)는 아래에서 전체를 다시 그린다.
    if (!entry && !match(filter, job)) {
      if (visible) renderFilters();
      else stale = true;
      return;
    }
    const groupChanged = !prev || isActive(prev) !== isActive(job) || !entry;
    if (groupChanged || (entry && !match(filter, job))) {
      if (visible) renderAll();
      else stale = true;
      return;
    }
    patch(entry, job);
    renderFilters();
  }
  let stale = false;

  function mount(el) {
    el.innerHTML = `
      <div class="jobs-view">
        <div class="panel jobs-toolbar">
          <div class="seg" data-ref="filters" role="group" aria-label="작업 필터"></div>
          <span class="toolbar-spacer"></span>
          <span class="muted small" data-ref="engineQueue"></span>
          <button type="button" class="btn btn-sm btn-ghost" data-ref="log">엔진 로그</button>
          <button type="button" class="btn btn-sm btn-ghost" data-ref="clean">끝난 기록 정리</button>
          <button type="button" class="btn btn-sm btn-ghost" data-ref="refresh">새로고침</button>
          ${helpLink('troubleshooting', '? 문제 해결')}
        </div>
        <div class="job-list" data-ref="list"></div>
      </div>`;
    $ = refs(el);
    $.log.addEventListener('click', openEngineLog);
    $.refresh.addEventListener('click', () => withBusy($.refresh, loadJobs));
    $.clean.addEventListener('click', () => withBusy($.clean, async () => {
      const done = [...store.jobs.values()].filter((j) => !isActive(j));
      if (!done.length) {
        toast('정리할 기록이 없습니다.', 'info');
        return;
      }
      const ok = await confirmDialog({
        title: '끝난 기록 정리',
        message: `완료·실패·취소된 작업 기록 ${done.length}개를 목록에서 지울까요?`,
        detail: '기록만 지우며 이미지 파일은 그대로 남습니다. 갤러리에서 계속 볼 수 있습니다.',
        confirmText: '기록 지우기',
        danger: true,
      });
      if (!ok) return;
      let n = 0;
      for (const j of done) {
        if (await deleteJobRecord(j.id)) n++;
      }
      toast(`작업 기록 ${n}개를 지웠습니다.`, 'success');
      renderAll();
    }));

    on('jobs', () => { if (visible) renderAll(); else stale = true; });
    on('job', onJob);
    on('job-removed', (id) => {
      const e = rows.get(id);
      if (e) {
        e.row.remove();
        rows.delete(id);
      }
      if (visible) renderFilters();
      if (!rows.size && visible) renderAll();
    });
    on('status', () => {
      if (!visible) return;
      renderFilters();
      for (const [id, e] of rows) {
        const j = store.jobs.get(id);
        if (j) renderActions(e, j);
      }
    });
    on('characters', () => { if (visible) renderAll(); });
    on('tick', () => {
      if (!visible) return;
      for (const [id, e] of rows) {
        const j = store.jobs.get(id);
        if (j) {
          tickRow(e, j);
          if (!isActive(j)) e.r.time.textContent = fmtRelative(j.created);
        }
      }
    });
    renderAll();
  }

  return {
    id: 'jobs',
    title: '작업',
    mount,
    show() {
      visible = true;
      if (stale) stale = false;
      renderAll();
    },
    hide() {
      visible = false;
    },
    isDirty: () => false,
  };
}
