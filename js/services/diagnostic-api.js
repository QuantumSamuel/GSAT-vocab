// 正式診斷只走登入 RPC；不可使用 restFetch 的匿名 fallback，也不自動重送提交。
import { authReady, getUser, getAccessToken, getAuthGeneration } from './auth.js';
import { loadSupabaseConfig } from './sync.js';
import { on } from '../core/eventbus.js';

function fault(code, message, status) { return Object.assign(new Error(message), { code, status }); }
function abortError() { return new DOMException('已取消診斷請求', 'AbortError'); }
function awaitWithSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(abortError()); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then((value) => { cleanup(); resolve(value); }, (err) => { cleanup(); reject(err); });
  });
}
function responseError(data, status) {
  const detail = typeof data?.error === 'object' ? data.error : data;
  const message = detail?.message || detail?.error_description || (typeof data?.error === 'string' ? data.error : '') || `診斷服務 HTTP ${status}`;
  const known = String(message).match(/\b(UNAUTHENTICATED|CONFLICT|INVALID_ANSWER|NOT_COMPLETED|BANK_ERROR)\b/)?.[1];
  const code = status === 401 ? 'UNAUTHENTICATED' : known || detail?.code || 'RPC_ERROR';
  return fault(code, message, status);
}
// loadSupabaseConfig 的中繼資料 → 正確錯誤。設定檔真網路失敗還原成 TypeError（無 status，
// 讓離線回退可辨識）；HTTP 失敗保留原 status（5xx＝暫時性、401／403＝拒）；
// 缺檔／有效空配置（無 failure）維持 NOT_CONFIGURED，不概括成網路錯誤。
function configError(config) {
  if (config?.failure === 'network') {
    return new TypeError(`無法載入雲端設定檔（網路失敗）：${config.error || 'network error'}`);
  }
  if (config?.failure === 'http' && typeof config.status === 'number') {
    return fault('CONFIG_HTTP_ERROR', `雲端設定檔暫時無法取得（HTTP ${config.status}）`, config.status);
  }
  return fault('NOT_CONFIGURED', '尚未設定診斷雲端服務');
}
async function rpc(name, body, opts = {}) {
  await awaitWithSignal(authReady, opts.signal);
  const ownerId = getUser()?.id;
  const generation = getAuthGeneration();
  if (!ownerId) throw fault('UNAUTHENTICATED', '請先登入再進行診斷');
  const controller = new AbortController();
  let authChanged = false;
  const check = () => {
    if (authChanged || getAuthGeneration() !== generation || getUser()?.id !== ownerId) throw fault('AUTH_CHANGED', '登入帳戶已變更，請重新載入診斷');
    if (opts.signal?.aborted) throw abortError();
  };
  const off = on('auth:changed', () => {
    if (getAuthGeneration() !== generation || getUser()?.id !== ownerId) { authChanged = true; controller.abort(); }
  });
  const abort = () => controller.abort();
  opts.signal?.addEventListener('abort', abort, { once: true });
  try {
    check();
    const config = await awaitWithSignal(loadSupabaseConfig(), controller.signal);
    check();
    if (!config.configured) throw configError(config);
    const token = await awaitWithSignal(getAccessToken(), controller.signal);
    check();
    if (!token) throw fault('UNAUTHENTICATED', '登入已失效，請重新登入');
    const response = await awaitWithSignal(fetch(`${config.url.replace(/\/$/, '')}/rest/v1/rpc/${name}`, {
      method: 'POST', signal: controller.signal,
      headers: { apikey: config.key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }), controller.signal);
    check();
    const text = await awaitWithSignal(response.text(), controller.signal);
    check();
    let data;
    try { data = text ? JSON.parse(text) : null; }
    catch { throw fault('INVALID_RESPONSE', '診斷雲端回應格式無效，請重試', response.status); }
    if (!response.ok || data?.error) throw responseError(data, response.status);
    if (data?.ownerId != null && data.ownerId !== ownerId) throw fault('OWNER_MISMATCH', '雲端回應帳戶不符，未採用資料');
    return data;
  } catch (err) {
    check();
    throw err;
  } finally { off(); opts.signal?.removeEventListener('abort', abort); }
}

export function getOrStartDiagnostic(opts = {}) { return rpc('diagnostic_get_or_start', {}, opts); }
export function submitDiagnosticAnswer(payload, opts = {}) { return rpc('diagnostic_submit', { p_payload: payload }, opts); }
export function getDiagnosticResult(opts = {}) { return rpc('diagnostic_get_result', {}, opts); }
export function saveDiagnosticDraft(payload, opts = {}) { return rpc('diagnostic_save_draft', { p_payload: payload }, opts); }
export function setDiagnosticLoad(load, opts = {}) { return rpc('diagnostic_set_load', { p_load: load }, opts); }
