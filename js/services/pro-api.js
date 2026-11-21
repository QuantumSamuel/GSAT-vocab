// ============================================================
// 6.3.0 Pro 權益前端 transport（學習站版）
// 來源：6.0/6.2.2（現行學習站）；呼叫 6.3.0 真後端 Edge Function「pro-api」。
//
// 安全與保存原則：
//   1. 瀏覽器只用「公開 anon key（loadSupabaseConfig）」＋「本人 JWT（getAccessToken）」，
//      絕不讀取高權限金鑰或本機工作流金鑰。授權最終由 SQL（auth.uid()）裁決，
//      前端 role 不當授權。
//   2. 明碼只出現在「建立成功」當下回給呼叫者一次；本檔不回傳 code 給後續操作、
//      不存 localStorage／IndexedDB／全域 cache、不 log 憑證或明碼。
//   3. 不設任意 timeout／TTL／預算／重試上限；每次呼叫都照實連線並誠實失敗。
//   4. 身份競態：呼叫開始時凍結 owner（getUser().id）＋ authGeneration，
//      每個 await 之後與採用回應之前檢查；A→B→A、登出後晚回、跨分頁登出，
//      都不把舊回應交回成有效結果；同帳戶正常續期（getAccessToken 內部 refresh，
//      generation 不變）不誤失效。
//
// 誠實失敗原則：HTTP 失敗、壞 JSON、空回應、頂層／data 的 ok:false／unknown、
// 形狀不一致（缺必填欄位、型別錯、hasPro 與 status 不符等）一律拋錯，
// 絕不把不確定結果當成「有效 Pro」回給呼叫端。
//
// 本檔只提供「本人」status／redeem；管理動作（create／list／void／revoke）只放在
// 後台站獨立 transport（不跨站 import）。DI：production 預設接本站真模組；
// 測試可用 deps 注入相同契約的假模組（loadSupabaseConfig/getAccessToken/getUser/
// getAuthGeneration/fetchImpl），不連真 DB。
// ============================================================
import { getAccessToken, getUser, getAuthGeneration } from './auth.js';
import { loadSupabaseConfig } from './sync.js';
import { on } from '../core/eventbus.js';

const FN = 'pro-api';

function fault(code, message, status) { return Object.assign(new Error(message), { code, status }); }
function abortError() { return new DOMException('已取消 Pro 請求', 'AbortError'); }
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

// loadSupabaseConfig 中繼資料 → 正確錯誤（與 learning-api／diagnostic-api 同一契約）
function configError(config) {
  if (config?.failure === 'network') {
    return new TypeError(`無法載入 Supabase 設定（網路失敗）：${config.error || 'network error'}`);
  }
  if (config?.failure === 'http' && typeof config.status === 'number') {
    return fault('CONFIG_HTTP_ERROR', `Supabase 設定暫時無法取得（HTTP ${config.status}）`, config.status);
  }
  return fault('NOT_CONFIGURED', '尚未設定 Supabase（見 supabase_config.txt 說明）');
}

// ---------- 回應形狀驗證（誠實失敗，不當有效 Pro） ----------
function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

// status：data.ok 必須 true；status 只接受 SQL 允許集合；hasPro 必須＝(status==='active')；
// grants 必須是 array；非 active 時 plan/expiresAt 必須 null；active limited_term 必有 expiresAt。
function validateStatus(data) {
  if (!isPlainObject(data) || data.ok !== true) return 'INVALID_OK';
  if (typeof data.status !== 'string' || !['active', 'expired', 'revoked', 'none'].includes(data.status)) return 'INVALID_STATUS';
  if (typeof data.hasPro !== 'boolean') return 'INVALID_HASPRO';
  if (data.hasPro !== (data.status === 'active')) return 'INCONSISTENT_HASPRO';
  if (!Array.isArray(data.grants)) return 'INVALID_GRANTS';
  if (data.status === 'active') {
    if (!['permanent', 'limited_term'].includes(data.plan)) return 'INVALID_PLAN';
    if (data.plan === 'permanent' && data.expiresAt !== null) return 'INVALID_EXPIRES';
    if (data.plan === 'limited_term' && (typeof data.expiresAt !== 'string' || !data.expiresAt)) return 'INVALID_EXPIRES';
  } else {
    if (data.plan !== null || data.expiresAt !== null) return 'INVALID_EXPIRES';
  }
  return null;
}

function validateRedeem(data) {
  if (!isPlainObject(data) || data.ok !== true) return 'INVALID_OK';
  if (typeof data.grantId !== 'string' || !data.grantId) return 'INVALID_GRANT_ID';
  if (!['permanent', 'limited_term'].includes(data.kind)) return 'INVALID_KIND';
  if (data.status !== 'active') return 'INVALID_GRANT_STATUS';
  if (data.hasPro !== true) return 'INVALID_HASPRO';
  return null;
}

// 依發起動作驗證成功回應的「data」欄位形狀；回 null＝合法，回字串＝失敗原因。
// 頂層 ok 必須 true；body.action 必須與發起動作完全相等，data 才依真後端契約驗型。
function validateSuccessData(body, action) {
  if (body?.ok !== true || !('data' in body)) return 'INVALID_ENVELOPE';
  if (typeof body.action !== 'string' || body.action !== action) return 'ACTION_MISMATCH';
  switch (action) {
    case 'status': return validateStatus(body.data);
    case 'redeem': return validateRedeem(body.data);
    default: return 'UNKNOWN_ACTION';
  }
}

// Edge Function 非 2xx／商務錯誤 → 誠實錯誤（保留後端錯誤碼與 status）
function responseError(data, status) {
  const detail = data && isPlainObject(data)
    ? (data.error || data.message || data.detail)
    : null;
  const message = detail ? String(detail) : `Pro 服務 HTTP ${status}`;
  // 後端已把已知錯誤碼放在 error 字串（UNAUTHENTICATED／FORBIDDEN／CODE_NOT_FOUND…）
  return fault(
    status === 401 ? 'UNAUTHENTICATED'
      : (isPlainObject(data) && typeof data.error === 'string' ? data.error
        : (status >= 500 ? 'PRO_SERVER_ERROR' : 'PRO_ERROR')),
    message,
    status,
  );
}

// ---------- 身份競態守衛 ----------
// 呼叫開始即凍結 owner＋generation，並在 getToken／loadConfig／fetch／body 讀取／採用前
// 都重核；任何一次不符（含登出、跨分頁、A→B→A）即拋 AUTH_CHANGED。
// 同帳戶續期不改 generation（auth.js preserveGeneration），不會誤失效。
function makeSessionGuard(deps, ownerId, generation) {
  let authChanged = false;
  const off = deps.on ? deps.on('auth:changed', () => {
    if (deps.getGeneration() !== generation || deps.getUser()?.id !== ownerId) authChanged = true;
  }) : null;
  const check = () => {
    if (authChanged || deps.getGeneration() !== generation || deps.getUser()?.id !== ownerId) {
      throw fault('AUTH_CHANGED', '登入帳戶已變更，未採用舊的 Pro 回應', 401);
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

// 核心：POST 到 /functions/v1/pro-api。呼叫開始先凍結身份，每個 await 後都重核。
async function callProApi(action, payload, opts = {}) {
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
    if (!text) throw fault('INVALID_RESPONSE', 'Pro 服務回應為空，請重試', res.status >= 400 ? res.status : 502);
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw fault('INVALID_RESPONSE', 'Pro 服務回應格式無效（不是 JSON），請重試', res.status >= 400 ? res.status : 502);
    }
    guard.check();
    if (!res.ok) throw responseError(body, res.status);
    const invalid = validateSuccessData(body, action);
    if (invalid) throw fault('INVALID_RESPONSE', `Pro 服務回應形狀不符（${invalid}），未採用`, 502);
    guard.check();
    return body.data;
  } finally {
    guard.cleanup?.();
  }
}

// ---------- 對外（學習站：只本人 status／redeem） ----------
/** 查本人 Pro 狀態；成功回 { status, plan, expiresAt, hasPro, grants } */
export function proStatus(opts = {}) {
  return callProApi('status', {}, opts);
}

/** 兌換啟用碼；成功回 { grantId, kind, status, startsAt, expiresAt, hasPro } */
export function proRedeem(code, opts = {}) {
  const c = String(code ?? '').trim();
  if (!c) throw fault('INVALID_CODE', '請輸入啟用碼');
  return callProApi('redeem', { code: c }, opts);
}