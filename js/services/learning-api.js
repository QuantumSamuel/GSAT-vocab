// ============================================================
// 6.0.3 學習狀態 REST 邊界（已核准：只走登入 RPC，不匿名 fallback、不自動重送）。
//
// 兩個固定出口：
//   pullLearningState(opts)         → rpc/learning_pull  body {}
//   mergeLearningState(payload, s)  → rpc/learning_merge body { p_payload: payload }
//
// 邊界契約（呼叫端 D 依此組裝 outbox／採用回應）：
//   merge payload：
//     {
//       ownerId,           // 必須等於目前 signed owner（寫前即拒）
//       schemaVersion: 1,
//       baseRevision,      // 非負安全整數
//       dayPlans: [],      // 陣列（內容由 core 驗證後傳入）
//       recheckEvents: [], // 本次提交事件；每筆需 eventId
//     }
//   merge 成功回應：
//     {
//       ownerId,               // 必須等於本次 owner，缺 owner 一律拒
//       revision,              // 非負安全整數
//       dayPlans: [],
//       recheckEvents: [],
//       acknowledgedEventIds,  // 只能含本次提交 eventId，且本次每個 unique eventId 都必須在此
//       conflict,              // 選用：衝突旗標
//     }
//   ACK 為整批 transactional：少一個或含額外 ID → INVALID_RESPONSE，
//   呼叫端不得清 outbox（未 ACK 者下次以穩定 eventId 重送）。
//
// owner/generation 競態：一次操作 context——await authReady 後即凍結
// ownerId＋generation，一路傳入 rpc 與 response validation；所有 await 後
// 與最終採用回應前 check。A→B→A 亦失效，不得重捕捉新 owner 讓舊操作復活。
//
// 參照 diagnostic-api.js：authReady／getUser／getAccessToken／getAuthGeneration／
// auth:changed，並以 AbortSignal 貫穿；401 不退回匿名；網路錯誤不自動重送。
// ============================================================
import { authReady, getUser, getAccessToken, getAuthGeneration } from './auth.js';
import { loadSupabaseConfig } from './sync.js';
import { on } from '../core/eventbus.js';

function fault(code, message, status) { return Object.assign(new Error(message), { code, status }); }
function abortError() { return new DOMException('已取消學習同步請求', 'AbortError'); }
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
  const message = detail?.message || detail?.error_description || (typeof data?.error === 'string' ? data.error : '') || `學習同步服務 HTTP ${status}`;
  const known = String(message).match(/\b(UNAUTHENTICATED|CONFLICT|INVALID_PAYLOAD|OWNER_MISMATCH|INVALID_RESPONSE)\b/)?.[1];
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
  return fault('NOT_CONFIGURED', '尚未設定學習同步雲端服務');
}
function isSafeNonNegativeInt(v) { return Number.isSafeInteger(v) && v >= 0; }

// 寫前驗證 merge payload；非法即拒，不得發出請求。回傳本次 unique eventId 集合。
function validateMergePayload(payload, ownerId) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw fault('INVALID_PAYLOAD', '學習同步內容格式無效');
  }
  if (payload.ownerId !== ownerId) throw fault('OWNER_MISMATCH', '學習同步內容帳戶不符');
  if (payload.schemaVersion !== 1) throw fault('INVALID_PAYLOAD', '學習同步版本不支援');
  if (!isSafeNonNegativeInt(payload.baseRevision)) throw fault('INVALID_PAYLOAD', '學習同步基準版本無效');
  if (!Array.isArray(payload.dayPlans)) throw fault('INVALID_PAYLOAD', '學習同步 dayPlans 無效');
  if (!Array.isArray(payload.recheckEvents)) throw fault('INVALID_PAYLOAD', '學習同步 recheckEvents 無效');
  const ids = new Set();
  for (const evt of payload.recheckEvents) {
    const id = evt?.eventId;
    if (typeof id !== 'string' || !id.trim()) throw fault('INVALID_PAYLOAD', '學習同步事件缺少 eventId');
    ids.add(id);
  }
  return ids;
}

// 驗證 merge 成功回應；ACK 不完整或含額外 ID → INVALID_RESPONSE。
function validateMergeResult(data, ownerId, submittedIds) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw fault('INVALID_RESPONSE', '學習同步回應格式無效');
  if (typeof data.ownerId !== 'string' || !data.ownerId) throw fault('INVALID_RESPONSE', '學習同步回應缺少帳戶');
  if (data.ownerId !== ownerId) throw fault('OWNER_MISMATCH', '學習同步回應帳戶不符，未採用資料');
  if (!isSafeNonNegativeInt(data.revision)) throw fault('INVALID_RESPONSE', '學習同步回應版本無效');
  if (!Array.isArray(data.dayPlans)) throw fault('INVALID_RESPONSE', '學習同步回應 dayPlans 無效');
  if (!Array.isArray(data.recheckEvents)) throw fault('INVALID_RESPONSE', '學習同步回應 recheckEvents 無效');
  if (!Array.isArray(data.acknowledgedEventIds)) throw fault('INVALID_RESPONSE', '學習同步回應缺少 ACK');
  const acked = new Set();
  for (const id of data.acknowledgedEventIds) {
    if (typeof id !== 'string' || !id.trim() || !submittedIds.has(id)) {
      throw fault('INVALID_RESPONSE', '學習同步 ACK 含非本次提交的事件');
    }
    acked.add(id);
  }
  for (const id of submittedIds) {
    if (!acked.has(id)) throw fault('INVALID_RESPONSE', '學習同步批次未完整認列，未清除待送');
  }
  return data;
}

// 一次操作 context：await authReady 後凍結 ownerId＋generation，
// 所有 await 後與最終採用回應前一律 check；A→B→A 亦失效。
function makeOperationContext(ownerId, generation, opts) {
  const controller = new AbortController();
  let authChanged = false;
  const check = () => {
    if (authChanged || getAuthGeneration() !== generation || getUser()?.id !== ownerId) {
      throw fault('AUTH_CHANGED', '登入帳戶已變更，請重新載入學習同步');
    }
    if (opts.signal?.aborted) throw abortError();
  };
  const off = on('auth:changed', () => {
    if (getAuthGeneration() !== generation || getUser()?.id !== ownerId) { authChanged = true; controller.abort(); }
  });
  const abort = () => controller.abort();
  opts.signal?.addEventListener('abort', abort, { once: true });
  const cleanup = () => { off(); opts.signal?.removeEventListener('abort', abort); };
  return { ownerId, generation, controller, check, cleanup };
}

async function rpc(name, body, ctx, opts = {}) {
  try {
    ctx.check();
    const config = await awaitWithSignal(loadSupabaseConfig(), ctx.controller.signal);
    ctx.check();
    if (!config.configured) throw configError(config);
    const token = await awaitWithSignal(getAccessToken(), ctx.controller.signal);
    ctx.check();
    if (!token) throw fault('UNAUTHENTICATED', '登入已失效，請重新登入');
    const response = await awaitWithSignal(fetch(`${config.url.replace(/\/$/, '')}/rest/v1/rpc/${name}`, {
      method: 'POST', signal: ctx.controller.signal,
      headers: { apikey: config.key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }), ctx.controller.signal);
    ctx.check();
    const text = await awaitWithSignal(response.text(), ctx.controller.signal);
    ctx.check();
    let data;
    try { data = text ? JSON.parse(text) : null; }
    catch { throw fault('INVALID_RESPONSE', '學習同步雲端回應格式無效，請重試', response.status); }
    if (!response.ok || data?.error) throw responseError(data, response.status);
    return { data, status: response.status };
  } catch (err) {
    // 帳戶變更造成的 abort 需映射為 AUTH_CHANGED；使用者取消維持 AbortError。
    ctx.check();
    throw err;
  }
}

export async function pullLearningState(opts = {}) {
  await awaitWithSignal(authReady, opts.signal);
  const ownerId = getUser()?.id;
  const generation = getAuthGeneration();
  if (!ownerId) throw fault('UNAUTHENTICATED', '請先登入再進行學習同步');
  const ctx = makeOperationContext(ownerId, generation, opts);
  let responseStatus;
  try {
    const { data, status } = await rpc('learning_pull', {}, ctx, opts);
    responseStatus = status;
    ctx.check();
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw fault('INVALID_RESPONSE', '學習同步回應格式無效');
    if (typeof data.ownerId !== 'string' || !data.ownerId) throw fault('INVALID_RESPONSE', '學習同步回應缺少帳戶');
    if (data.ownerId !== ctx.ownerId) throw fault('OWNER_MISMATCH', '學習同步回應帳戶不符，未採用資料');
    if (!isSafeNonNegativeInt(data.revision)) throw fault('INVALID_RESPONSE', '學習同步回應版本無效');
    if (!Array.isArray(data.dayPlans)) throw fault('INVALID_RESPONSE', '學習同步回應 dayPlans 無效');
    if (!Array.isArray(data.recheckEvents)) throw fault('INVALID_RESPONSE', '學習同步回應 recheckEvents 無效');
    return data;
  } catch (err) {
    ctx.check();
    if (responseStatus !== undefined && err.status === undefined) err.status = responseStatus;
    throw err;
  } finally { ctx.cleanup(); }
}

export async function mergeLearningState(payload, opts = {}) {
  await awaitWithSignal(authReady, opts.signal);
  const ownerId = getUser()?.id;
  const generation = getAuthGeneration();
  if (!ownerId) throw fault('UNAUTHENTICATED', '請先登入再進行學習同步');
  const submittedIds = validateMergePayload(payload, ownerId);
  const ctx = makeOperationContext(ownerId, generation, opts);
  let responseStatus;
  try {
    const { data, status } = await rpc('learning_merge', { p_payload: payload }, ctx, opts);
    responseStatus = status;
    ctx.check();
    return validateMergeResult(data, ctx.ownerId, submittedIds);
  } catch (err) {
    ctx.check();
    if (responseStatus !== undefined && err.status === undefined) err.status = responseStatus;
    throw err;
  } finally { ctx.cleanup(); }
}
