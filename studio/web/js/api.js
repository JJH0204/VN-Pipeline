// 모든 서버 호출은 api()를 거친다: 오류({"error"})를 한국어 토스트로 보여 주고 ApiError를 던진다.
import { toast } from './ui.js';

export class ApiError extends Error {
  constructor(message, status = 0, data = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
    this.aborted = status === -1;
  }
}

const HTTP_MESSAGES = {
  400: '요청 내용이 올바르지 않습니다.',
  403: '요청이 거부되었습니다.',
  404: '요청한 항목을 찾을 수 없습니다.',
  405: '지원하지 않는 요청입니다.',
  409: '이미 같은 이름의 항목이 있습니다.',
  413: '요청이 너무 큽니다.',
  500: 'Studio 서버 내부 오류가 발생했습니다.',
  502: '엔진(ComfyUI)과 통신하지 못했습니다.',
  503: 'ComfyUI 엔진이 실행 중이 아닙니다. 상단의 [엔진 시작]을 눌러 주세요.',
  504: '서버 응답 시간이 초과되었습니다.',
};

/**
 * @param {string} path
 * @param {{method?: string, body?: any, silent?: boolean, signal?: AbortSignal, timeout?: number}} opts
 * body가 FormData면 그대로 보낸다(Content-Type은 브라우저가 boundary와 함께 정함). 업로드는 기본 120초까지 기다린다.
 */
export async function api(path, opts = {}) {
  const { method = 'GET', body, silent = false, signal } = opts;
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const timeout = opts.timeout ?? (isForm ? 120000 : 30000);
  const ctrl = new AbortController();
  let timedOut = false;
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  const timer = timeout ? setTimeout(() => { timedOut = true; ctrl.abort(); }, timeout) : null;

  let res;
  try {
    const init = { method, signal: ctrl.signal, cache: 'no-store', credentials: 'same-origin' };
    if (isForm) {
      init.body = body;
    } else if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    res = await fetch(path, init);
  } catch (e) {
    clearTimeout(timer);
    if (ctrl.signal.aborted && !timedOut) throw new ApiError('요청이 취소되었습니다.', -1);
    const msg = timedOut
      ? '서버 응답이 너무 늦습니다. 잠시 후 다시 시도해 주세요.'
      : 'Studio 서버에 연결할 수 없습니다. 서버가 실행 중인지 확인해 주세요.';
    if (!silent) toast(msg, 'error');
    throw new ApiError(msg, 0);
  }

  let text = '';
  try {
    text = await res.text();
  } catch (e) {
    clearTimeout(timer);
    if (ctrl.signal.aborted && !timedOut) throw new ApiError('요청이 취소되었습니다.', -1);
    text = '';
  }
  clearTimeout(timer);

  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const msg = (data && typeof data.error === 'string' && data.error) || HTTP_MESSAGES[res.status] || `요청에 실패했습니다 (HTTP ${res.status}).`;
    if (!silent) toast(msg, 'error');
    throw new ApiError(msg, res.status, data);
  }
  return data == null ? {} : data;
}

/** 조용히 실패를 무시하고 싶은 호출용 */
export async function tryApi(path, opts = {}) {
  try {
    return await api(path, opts);
  } catch {
    return null;
  }
}
