// ============================================================
// 6.3.1 AI 週報前端 transport（學習站版）——本機候選元件，尚未接正式頁
// 呼叫 6.3.1 真後端 Edge Function「weekly-report-api」（候選：
// authoring/631-service-repair-input/6.0/backend/weekly-631/supabase/functions/weekly-report-api/）。
//
// 安全與保存原則（比照 pro-api.js）：
//   1. 瀏覽器只用「公開 anon key（loadSupabaseConfig）」＋「本人 JWT（getAccessToken）」，
//      授權最終由 SQL（auth.uid()）裁決，前端 role 不當授權。
//   2. 不存週報內容到 localStorage／IndexedDB／全域 cache、不 log 憑證。
//   3. 不設任意 timeout／TTL／預算／重試上限；照實連線並誠實失敗。
//   4. 身份競態：呼叫開始凍結 owner＋authGeneration，每個 await 後與採用前重核；
//      A→B→A、登出後晚回、跨分頁登出都不把舊回應交回成有效結果。
//   5. 誠實失敗：HTTP 失敗、壞 JSON、空回應、頂層／data ok:false、形狀不一
//      一律拋錯，不把不確定結果當成功。
//
// 本檔只提供「本人」weekly actions（status/generate/history/history_delete）；
// admin_config 屬後台站（admin-site），不在此列。DI：production 預設接本站真模組；
// 測試可用 deps 注入同契約假模組。
// ============================================================
import { getAccessToken, getUser, getAuthGeneration } from './auth.js';
import { loadSupabaseConfig } from './sync.js';
import { on } from '../core/eventbus.js';

const FN = 'weekly-report-api';

function fault(code, message, status) { return Object.assign(new Error(message), { code, status }); }
function abortError() { return new DOMException('已取消週報請求', 'AbortError'); }
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

// loadSupabaseConfig 中繼資料 → 正確錯誤（與 pro-api.js 同一契約）
function configError(config) {
  if (config?.failure === 'network') {
    return new TypeError(`無法載入 Supabase 設定（網路失敗）：${config.error || 'network error'}`);
  }
  if (config?.failure === 'http' && typeof config.status === 'number') {
    return fault('CONFIG_HTTP_ERROR', `Supabase 設定暫時無法取得（HTTP ${config.status}）`, config.status);
  }
  return fault('NOT_CONFIGURED', '尚未設定 Supabase（見 supabase_config.txt 說明）');
}

function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

// 身份競態守衛（與 pro-api.js 同形）
function makeSessionGuard(deps, ownerId, generation) {
  let authChanged = false;
  const off = deps.on ? deps.on('auth:changed', () => {
    if (deps.getGeneration() !== generation || deps.getUser()?.id !== ownerId) authChanged = true;
  }) : null;
  const check = () => {
    if (authChanged || deps.getGeneration() !== generation || deps.getUser()?.id !== ownerId) {
      throw fault('AUTH_CHANGED', '登入帳戶已變更，未採用舊的週報回應', 401);
    }
  };
  return { check, cleanup: () => { if (typeof off === 'function') off(); } };
}

function resolveDeps(opts = {}) {
  const injected = opts.deps || {};
  return {
    loadConfig: injected.loadSupabaseConfig || loadSupabaseConfig,
    getToken: injected.getAccessToken || getAccessToken,
    getUser: injected.getUser || getUser,
    getGeneration: injected.getAuthGeneration || getAuthGeneration,
    fetchImpl: injected.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null),
    on: injected.on !== undefined ? injected.on : on,
  };
}

// 成功回應形狀判定：頂層 ok 必須 true、action 必須與發起一致、data 必須存在。
function validateEnvelope(body, action) {
  if (!isPlainObject(body) || body.ok !== true) return 'INVALID_ENVELOPE';
  if (!('data' in body)) return 'INVALID_ENVELOPE';
  if (typeof body.action !== 'string' || body.action !== action) return 'ACTION_MISMATCH';
  return null;
}

function responseError(data, status) {
  const detail = data && isPlainObject(data) ? (data.error || data.message || data.detail) : null;
  const message = detail ? String(detail) : `週報服務 HTTP ${status}`;
  return fault(
    status === 401 ? 'UNAUTHENTICATED'
      : (isPlainObject(data) && typeof data.error === 'string' ? data.error
        : (status >= 500 ? 'WEEKLY_SERVER_ERROR' : 'WEEKLY_ERROR')),
    message,
    status,
  );
}

// 核心：POST 到 /functions/v1/weekly-report-api。呼叫開始凍結身份，每個 await 後重核。
async function callWeekly(action, payload, opts = {}) {
  const deps = resolveDeps(opts);
  const { signal } = opts;
  const ownerId = deps.getUser()?.id;
  const generation = deps.getGeneration();
  if (!ownerId) throw fault('UNAUTHENTICATED', '尚未登入', 401);
  const guard = makeSessionGuard(deps, ownerId, generation);
  try {
    guard.check();
    const token = await awaitWithSignal(deps.getToken(), signal);
    guard.check();
    if (!token) throw fault('UNAUTHENTICATED', '尚未登入', 401);
    const config = await awaitWithSignal(deps.loadConfig(), signal);
    guard.check();
    if (!config?.configured) throw configError(config);
    const res = await awaitWithSignal(deps.fetchImpl(`${String(config.url).replace(/\/$/, '')}/functions/v1/${FN}`, {
      method: 'POST',
      headers: {
        apikey: config.key,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action, ...payload }),
    }), signal);
    guard.check();
    const text = await awaitWithSignal(res.text(), signal);
    guard.check();
    if (!text) throw fault('INVALID_RESPONSE', '週報服務回應為空，請重試', res.status >= 400 ? res.status : 502);
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw fault('INVALID_RESPONSE', '週報服務回應格式無效（不是 JSON），請重試', res.status >= 400 ? res.status : 502);
    }
    guard.check();
    if (!res.ok) throw responseError(body, res.status);
    const invalid = validateEnvelope(body, action);
    if (invalid) throw fault('INVALID_RESPONSE', `週報服務回應形狀不符（${invalid}），未採用`, 502);
    guard.check();
    return body.data;
  } finally {
    guard.cleanup?.();
  }
}

// ---------- 對外（學習站：本人週報 actions；週報屬 8 項 Pro，由頁面層配 pro-gate 閘） ----------

/** 查本人週報狀態（生成狀態、恢復待辦、週期等）。opts：{ timeZone?, periodStartMs?, periodEndMs? } */
export function weeklyStatus(opts = {}) {
  return callWeekly('status', {}, opts);
}

/** 查本人週期事實（每日任務／短複測原始計數）。 */
export function weeklyFacts({ periodStartMs, periodEndMs, timeZone, weekStart }, opts = {}) {
  if (!periodStartMs && !weekStart) throw fault('INVALID_PERIOD', '需提供 periodStartMs/periodEndMs 或 weekStart');
  return callWeekly('facts', { periodStartMs, periodEndMs, timeZone, weekStart }, opts);
}

/** 按需生成／更新 AI 週報摘要（使用者觸發；不擅發）。 */
export function weeklyGenerate({ periodStartMs, periodEndMs, timeZone, weekStart }, opts = {}) {
  if (!periodStartMs && !weekStart) throw fault('INVALID_PERIOD', '需提供 periodStartMs/periodEndMs 或 weekStart');
  return callWeekly('generate', { periodStartMs, periodEndMs, timeZone, weekStart }, opts);
}

/** 週報歷史清單。 */
export function weeklyHistory(opts = {}) {
  return callWeekly('history', {}, opts);
}

/** 刪除一筆週報歷史。 */
export function weeklyHistoryDelete(historyId, opts = {}) {
  const id = String(historyId ?? '').trim();
  if (!id) throw fault('INVALID_HISTORY_ID', '需要 historyId');
  return callWeekly('history_delete', { historyId: id }, opts);
}