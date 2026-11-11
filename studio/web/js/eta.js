// 예상 소요 시간 (M4 Pro 기준 대략치). 모든 값은 "예상"으로 표기한다.
import { sizeWH, clamp, fmtDuration, roundEta, nowSec, noPeople } from './util.js';

const BASE_AREA = 832 * 1216;
const T_BASE = 95;
const T_HIRES = 140;
const T_FACE = 50; // 얼굴이 작을 때만 실행 → 범위(~)로 표기
const T_HANDS = 40;
const T_EXPR = 55;
const T_EXPR_UPSCALE = 12;
// 포즈(ControlNet)를 붙이면 1차 생성이 약 40% 느려진다(실측 3.4 → 4.9 s/it, §9.10).
// 첫 사용 때 ControlNet 모델(2.5GB)을 불러오는 시간은 범위의 위쪽에만 더한다.
const POSE_SLOWDOWN = 1.4;
const T_POSE_LOAD = 60;

/** spec.pose가 있으면 포즈를 쓰는 작업인지 (배경 모드는 포즈를 무시) */
export function usesPose(spec) {
  const p = spec && spec.pose;
  return !!p && (typeof p === 'string' || !!p.name) && !noPeople(spec.mode || 'prompt');
}

/** 작업 객체로 예상 옵션 만들기: 실제 적용된 포즈 크기(job.pose.size)를 함께 넘긴다 */
export function jobEtaOpts(job, opts = {}) {
  const ps = job && job.pose && Array.isArray(job.pose.size) ? job.pose.size : null;
  return ps ? { ...opts, poseSize: ps } : opts;
}

/**
 * @param {object} spec JobSpec
 * @param {{exprCount?: number, poseSize?: number[]}} opts poseSize: 크기를 비워 둔 포즈 작업이 실제로 쓰는 크기
 * @returns {{min: number, max: number}} 초
 */
export function estimate(spec, opts = {}) {
  const mode = spec.mode || 'prompt';
  const pose = usesPose(spec);
  const size = !spec.size && pose && Array.isArray(opts.poseSize) ? opts.poseSize : spec.size;
  const [w, h] = sizeWH(size, mode);
  const k = clamp((w * h) / BASE_AREA, 0.3, 4);
  const hires = spec.hires !== false;
  const face = spec.face !== false && !noPeople(mode);
  const hands = spec.hands !== false && !noPeople(mode);
  const per = T_BASE * (pose ? POSE_SLOWDOWN : 1) + (hires ? T_HIRES : 0) + (hands ? T_HANDS : 0);
  const faceSec = face ? T_FACE : 0;
  if (mode === 'pixel' || mode === 'icon' || mode === 'sheet') return estimateAsset(spec, mode, k);
  const n = mode === 'sprite' ? 1 : clamp(parseInt(spec.count, 10) || 1, 1, 32);
  let min = per * k * n;
  let max = (per + faceSec) * k * n + (pose ? T_POSE_LOAD : 0);
  if (mode === 'sprite') {
    let ex = opts.exprCount;
    if (ex == null) ex = Array.isArray(spec.expressions) ? spec.expressions.length : 6;
    const extra = ex * (T_EXPR + (spec.upscale ? T_EXPR_UPSCALE : 0)) * k;
    min += extra;
    max += extra;
  }
  return { min: Math.round(min), max: Math.round(max) };
}

/** 스프라이트 시트 생성 횟수: {rows: 한 장에 그리는 줄 수, frames: 프레임마다 따로 그리는 장 수}
 *  (vnlib/spritesheet.py 의 SEPARATE_MOTIONS·SEPARATE_DIRS 와 같아야 함: 쓰러짐 동작, 뒷모습 줄) */
export function sheetGens(sh = {}) {
  const motions = sh.motions && sh.motions.length ? sh.motions : ['walk'];
  const dirs = sh.directions || ['down', 'left', 'right', 'up'];
  const mir = sh.mirror !== false && dirs.includes('left');
  const made = dirs.filter((d) => !(mir && d === 'left'));
  if (mir && !made.includes('right')) made.push('right');
  const n = Number(sh.frames) || 4;
  let rows = 0;
  let frames = 0;
  for (const m of motions) {
    for (const d of made) {
      if (m === 'down' || d === 'up') frames += n;
      else rows += 1;
    }
  }
  return { rows, frames };
}

/** 도트·아이콘: 도트는 1차 생성만, 아이콘은 1024×1024를 줄(아이콘) 수 × 변형 장수만큼 + 배경 제거 */
function estimateAsset(spec, mode, k) {
  const T_CUT = 8;
  if (mode === 'pixel') {
    const n = clamp(parseInt(spec.count, 10) || 1, 1, 32);
    const px = spec.pixel || {};
    const cut = px.subject !== 'scene' && px.transparent !== false ? T_CUT : 0;
    const t = (T_BASE + cut) * k * n;
    return { min: Math.round(t), max: Math.round(t * 1.15) };
  }
  if (mode === 'sheet') {
    // 생성 1회 ≈ 0.9메가픽셀 + 포즈. 하이레즈는 한 장에 그리는 줄에만 (따로 그리는 프레임은 이미 칸의 2배)
    const g = sheetGens(spec.sheet);
    const base = (T_BASE * POSE_SLOWDOWN + T_CUT) * 0.92;
    const t = base * (g.rows + g.frames) + (spec.hires ? T_HIRES * 0.92 * g.rows : 0);
    return { min: Math.round(t), max: Math.round(t * 1.15 + T_POSE_LOAD) };
  }
  const lines = String(spec.prompt || '').split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).length || 1;
  const per = clamp(parseInt(spec.count, 10) || 1, 1, 8);
  const ic = spec.icon || {};
  const ka = (1024 * 1024) / BASE_AREA;
  const hires = ic.style !== 'pixel' && spec.hires !== false;
  const t = (T_BASE + (hires ? T_HIRES : 0) + T_CUT) * ka * lines * per;
  return { min: Math.round(t), max: Math.round(t * 1.15) };
}

export function etaText(spec, opts = {}) {
  const { min, max } = estimate(spec, opts);
  const a = roundEta(min);
  const b = roundEta(max);
  if (b - a < 15) return `예상 약 ${fmtDuration(b)}`;
  return `예상 ${fmtDuration(a)} ~ ${fmtDuration(b)}`;
}

/** 진행 중인 작업의 남은 시간(초) 추정. 추정 불가면 null */
export function remainingSeconds(job, opts = {}) {
  if (!job || job.status !== 'running' || !job.started) return null;
  const elapsed = Math.max(0, nowSec() - job.started);
  const p = Number(job.progress && job.progress.percent) || 0;
  const est = estimate(job.spec || {}, jobEtaOpts(job, opts));
  const byEstimate = Math.max(0, (est.min + est.max) / 2 - elapsed);
  if (p >= 5 && elapsed > 8) {
    const byProgress = (elapsed * (100 - p)) / p;
    const w = clamp(p / 40, 0, 1);
    return Math.max(0, w * byProgress + (1 - w) * byEstimate);
  }
  return byEstimate;
}

export function remainingText(job, opts = {}) {
  const r = remainingSeconds(job, opts);
  if (r == null) return '';
  if (r < 5) return '거의 완료';
  return `남은 시간 예상 약 ${fmtDuration(roundEta(r))}`;
}
