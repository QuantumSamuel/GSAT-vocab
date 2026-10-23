// ============================================================
// 6.0.3 本人學習資料同步服務（js/services/learning-sync.js）
//
// 【職責】只服務「目前登入 owner」的個人化學習資料（每日計畫 dayPlans、短複測
//   證據 recheckEvents）：狀態查詢／立即同步／匯出／預覽／合併還原。
//   與舊八碼快照分享、帳號雲端備份、SRS 完全分開，互不改動。
//
// 【已核准規則（使用者定案）】
//  ・沿 Supabase：先寫本機，離線待補傳；不建立高頻輪詢、不無限重試。
//  ・同一 owner＋同一 auth generation 單一飛行（singleflight）：並行 manual 與
//    事件觸發共用同一個在途請求，不重複上傳。
//  ・pending（meta.dirtyVersion > ackedVersion）時，直接以「本裝置最近已認列的
//    cloudRevision」為 baseRevision，上傳擷取的快照 V；絕不先 pull 取得新版本後，
//    再把舊本機清單當成基於新版上傳。
//  ・無 pending 才 pull；pull 不帶 ACK（不確認任何本機版本）。
//  ・所有 await 前後、以及 store 交易內，都以凍結的 owner／generation／abort
//    guard 再驗一次；A→B→A 的晚到回應與 finally 不得復活或清除新 flight。
//  ・遠端 owner 不符／格式錯誤／ACK 不完整 → 零 adopt、零 acked、不動
//    lastSyncedAt；網路失敗可回 offline／error 狀態，但驗證／owner／abort／storage
//    失敗一律不得假成功。
//  ・成功 adopt 後，latest 資料由 store 於同一交易合併；ACK 只確認上傳的版本 V，
//    等待期間新增的 V+1 仍 pending（可續以同一 flight 補傳）。
//  ・restore 先 validate 同 owner／schema 全部內容，才合併本機；本機已成功但雲端
//    失敗時回 pending／error 狀態（不得 throw 造成誤稱本機未存）。
//  ・preview 不落地；export 只用 core 白名單，不洩 token／正解。export 於本機無診斷摘要時
//    以 diagnostic-api.getDiagnosticResult 補一次本帳戶權威摘要（不合成資格／不寫 attempts），
//    網路暫時失敗可降級為無摘要，401／403／錯 owner／格式錯／AUTH_CHANGED 不吞。
//  ・init 只事件驅動＋去抖（auth:changed／online／本機變更事件），不 setInterval／
//    輪詢；冪等且 cleanup 解除所有 listeners。
//
// 【依賴邊界】storage 依賴（diagnostic-store 的 4 個固定 API）與 core 備份核心均由
//   主線提供；本服務不自建、也不 mock 產品服務。真實整合由主線以雙獨立 IDB＋SQL
//   HTTP 與真瀏覽器驗收；本檔自測只驗邊界契約（tools/smoke_learning_sync_603.mjs）。
// ============================================================
import {
  createLearningBackup,
  validateLearningBackup,
  mergeLearningState, // 僅作 pull 前的同 ID 不同內容衝突偵測；正式合併由 store 於交易內完成
} from '../core/learning-backup.js';
import {
  pullLearningState,
  mergeLearningState as pushLearningState,
} from './learning-api.js';
import { getDiagnosticResult } from './diagnostic-api.js';
import { authReady, getUser, getAuthGeneration } from './auth.js';
import { on, emit } from '../core/eventbus.js';
import {
  readLearningState,
  getLearningSyncMeta,
  mergeLearningLocal,
  adoptLearningRemote,
} from './diagnostic-store.js';

const SCHEMA_VERSION = 1;
const CHANGE_EVENT = 'learning-sync:changed';
// 本機變更訊號：store 端（另一工作）於每次任務／證據變更發出 learning:local-changed。
const LOCAL_CHANGE_EVENTS = ['learning:local-changed'];
const DEBOUNCE_MS = 600;

// 單一飛行：{ ownerId, generation, controller, promise }。僅同 owner＋generation 共用。
let flight = null;
// 最近一次狀態（僅供 getLearningSyncStatus 沿用錯誤／待同步顯示）。
const lastStatus = new Map();
let cleanup = null;
let debounceTimer = null;

function fault(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}
function abortError() { return new DOMException('已取消學習同步請求', 'AbortError'); }
function isAbort(err) { return err?.name === 'AbortError' || err?.code === 'AUTH_CHANGED'; }
function isOffline() {
  try { return typeof navigator !== 'undefined' && navigator.onLine === false; } catch { return false; }
}
// 對外錯誤一律轉為乾淨 Error（帶 code／status），不外洩堆疊或原始內容。
function safeError(err) {
  const message = typeof err?.message === 'string' && err.message.trim() ? err.message : '學習同步失敗';
  const out = new Error(message);
  if (err?.code) out.code = err.code;
  if (err?.status !== undefined) out.status = err.status;
  return out;
}
function pendingOf(meta) {
  if (!meta || !Number.isFinite(meta.dirtyVersion) || !Number.isFinite(meta.ackedVersion)) return true;
  return meta.dirtyVersion > meta.ackedVersion;
}
function classifyError(err) {
  if (err?.code === 'NOT_CONFIGURED') return 'not_configured';
  if (isOffline()) return 'offline';
  return 'error';
}
function makeStatus(ownerId, { state, pending, lastSyncedAt, error }) {
  const status = { ownerId, state, pending: Boolean(pending), lastSyncedAt: lastSyncedAt ?? null };
  if (error) status.error = safeError(error);
  return status;
}
// 發布狀態：快取最近終態並發出 owner-scoped learning-sync:changed。
// 只快取終態（idle／error／offline／not_configured）；syncing 不覆蓋快取，
// 使失敗在真成功前持續反映於 getLearningSyncStatus。
function publish(status) {
  if (status.ownerId && status.state !== 'syncing') {
    lastStatus.set(status.ownerId, {
      generation: getAuthGeneration(),
      state: status.state,
      pending: status.pending,
      lastSyncedAt: status.lastSyncedAt,
      error: status.error,
    });
  }
  try { emit(CHANGE_EVENT, status); } catch { /* listener 失敗不得影響同步 */ }
  return status;
}
// 凍結 owner／generation／abort 的同步 guard；store 於交易內也會呼叫。
function makeGuard(ownerId, generation, signal) {
  return function guard() {
    if (getUser()?.id !== ownerId || getAuthGeneration() !== generation) {
      throw fault('AUTH_CHANGED', '登入帳戶已變更，學習同步已中止');
    }
    if (signal?.aborted) throw abortError();
  };
}
function checkOwner(ownerId, generation) {
  if (getUser()?.id !== ownerId || getAuthGeneration() !== generation) {
    throw fault('AUTH_CHANGED', '登入帳戶已變更，學習同步已中止');
  }
}
function deviceLocalDate(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
function parseBackupText(input) {
  if (typeof input !== 'string') return input;
  try { return JSON.parse(input); } catch { throw fault('INVALID_BACKUP', '備份 JSON 損壞'); }
}
function uniqueEventIds(events) {
  const seen = new Set();
  const out = [];
  for (const evt of (Array.isArray(events) ? events : [])) {
    const id = evt?.eventId;
    if (typeof id === 'string' && id && !seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}
function forwardAbort(signal, controller) {
  if (!signal) return () => {};
  if (signal.aborted) { controller.abort(); return () => {}; }
  const onAbort = () => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

// ---------- 單次上傳（pending 路徑）：以同一次原子 snapshot 的 meta 為 version／base ----------
async function pushOnce(f, guard) {
  const { ownerId, controller } = f;
  const snapshot = await readLearningState(ownerId, { guard });
  const m = snapshot.meta;
  if (!m || !Number.isFinite(m.dirtyVersion) || !Number.isFinite(m.ackedVersion) || !Number.isFinite(m.cloudRevision)) {
    throw fault('STORAGE_ERROR', '本機同步中繼資料不完整');
  }
  if (m.dirtyVersion <= m.ackedVersion) { // 讀取時已無 pending：不重複上傳
    f.progressMeta = m;
    return m;
  }
  const version = m.dirtyVersion; // 擷取版本 V（與 baseRevision 同源，避免與前次 getMeta 混搭）
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    ownerId,
    baseRevision: m.cloudRevision,
    clientLocalDate: deviceLocalDate(),
    dayPlans: Array.isArray(snapshot.dayPlans) ? snapshot.dayPlans : [],
    recheckEvents: Array.isArray(snapshot.recheckEvents) ? snapshot.recheckEvents : [],
  };
  const submittedIds = uniqueEventIds(payload.recheckEvents);
  const result = await pushLearningState(payload, { signal: controller.signal });
  guard();
  // 完整保留 result（含 acknowledgedEventIds）供 store validateAck；ack 帶上傳版本 V 與本次提交 ID。
  await adoptLearningRemote(ownerId, result, { guard, ack: { version, eventIds: submittedIds } });
  guard();
  const next = await getLearningSyncMeta(ownerId, { guard });
  f.progressMeta = next; // 記錄已成功 adopt 的進度，供後續輪次失敗時回報真實 lastSyncedAt／pending
  return next;
}

// ---------- 單次下載（無 pending 路徑）：pull 不帶 ACK ----------
async function pullOnce(f, guard) {
  const { ownerId, controller } = f;
  const remote = await pullLearningState({ signal: controller.signal });
  guard();
  const local = await readLearningState(ownerId, { guard });
  // 遠端事件與本機同 ID 不同內容時，先以 core 合併偵測衝突；衝突即不 adopt（零寫入）。
  mergeLearningState(local, remote, { preferRemotePlan: true });
  guard();
  await adoptLearningRemote(ownerId, {
    ownerId: remote.ownerId,
    revision: remote.revision,
    dayPlans: remote.dayPlans,
    recheckEvents: remote.recheckEvents,
  }, { guard });
  guard();
}

// pending 補傳：成功後若仍有 pending（等待期間新增）則續傳；失敗即停，不無限重試。
async function pushLoop(f, guard) {
  let previousAcked = null;
  for (;;) {
    guard();
    const next = await pushOnce(f, guard);
    if (next.dirtyVersion <= next.ackedVersion) return next;              // 已清空
    if (previousAcked !== null && next.ackedVersion <= previousAcked) return next; // 無進展：停止，避免空轉
    previousAcked = next.ackedVersion;
  }
}

// 一次同步：pending → 上傳（可續傳）；無 pending → pull 一次。
async function runSyncFlight(f) {
  const { ownerId } = f;
  const guard = makeGuard(ownerId, f.generation, f.controller.signal);
  let meta = null;
  try {
    meta = await getLearningSyncMeta(ownerId, { guard });
    publish(makeStatus(ownerId, { state: 'syncing', pending: pendingOf(meta), lastSyncedAt: meta.lastSyncedAt }));
    if (meta.dirtyVersion > meta.ackedVersion) {
      meta = await pushLoop(f, guard);
    } else {
      await pullOnce(f, guard);
      meta = await getLearningSyncMeta(ownerId, { guard });
      // pull 期間本機可能又有變更（local-changed 觸發只會 join 本 flight）：
      // 此時改走上傳（仍以交易內保存的已知 cloudRevision 為 base），不讓 pending 永遠等待。
      if (meta.dirtyVersion > meta.ackedVersion) meta = await pushLoop(f, guard);
    }
    return publish(makeStatus(ownerId, {
      state: 'idle', pending: pendingOf(meta), lastSyncedAt: meta.lastSyncedAt,
    }));
  } catch (err) {
    // abort／換帳戶不得假成功、也不得發布誤導狀態：直接往外拋。
    if (isAbort(err)) {
      checkOwner(ownerId, f.generation);
      throw abortError();
    }
    const latest = f.progressMeta || meta;
    return publish(makeStatus(ownerId, {
      state: classifyError(err),
      pending: latest ? pendingOf(latest) : true,
      lastSyncedAt: latest?.lastSyncedAt,
      error: err,
    }));
  }
}

/**
 * 立即同步目前登入 owner 的學習資料。同 owner＋generation 的並行呼叫共用單一 flight。
 * 網路失敗回 offline／error 狀態（不 throw）；abort／換帳戶直接往外拋（不假成功）。
 */
export async function syncLearningNow({ signal } = {}) {
  await authReady;
  const ownerId = getUser()?.id ?? null;
  const generation = getAuthGeneration();
  if (!ownerId) return publish(makeStatus(null, { state: 'not_configured', pending: false, lastSyncedAt: null }));
  const active = flight && flight.ownerId === ownerId && flight.generation === generation ? flight : null;
  if (active) return joinFlight(active, signal); // 加入既有 flight；若本呼叫已取消則立即拒絕

  const controller = new AbortController();
  const detachExternal = forwardAbort(signal, controller);
  const f = { ownerId, generation, controller, promise: null, queued: false };
  const offAuth = on('auth:changed', () => {
    if (getUser()?.id !== ownerId || getAuthGeneration() !== generation) controller.abort();
  });
  f.promise = runSyncFlight(f).finally(() => {
    offAuth();
    detachExternal();
    if (flight === f) flight = null; // 只清自己的 flight；A→B→A 舊 finally 不得清新 flight
    if (f.queued) scheduleSync();    // 飛行期間被去抖觸發的同步：收尾後補跑，不遺失
  });
  flight = f;
  return f.promise;
}

// 加入既有 flight：尊重本呼叫的 signal（已取消即拒絕；未取消則隨之結束）。
function joinFlight(f, signal) {
  if (!signal) return f.promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    f.promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (err) => { signal.removeEventListener('abort', onAbort); reject(err); },
    );
  });
}

/** 目前登入 owner 的同步狀態；未登入回 not_configured。 */
export async function getLearningSyncStatus() {
  await authReady;
  const ownerId = getUser()?.id ?? null;
  const generation = getAuthGeneration();
  if (!ownerId) return makeStatus(null, { state: 'not_configured', pending: false, lastSyncedAt: null });

  let meta;
  try {
    meta = await getLearningSyncMeta(ownerId, { guard: makeGuard(ownerId, generation, null) });
  } catch (err) {
    if (isAbort(err)) throw err;
    return makeStatus(ownerId, { state: classifyError(err), pending: true, lastSyncedAt: null, error: err });
  }
  const pending = pendingOf(meta);
  if (flight && flight.ownerId === ownerId && flight.generation === generation) {
    return makeStatus(ownerId, { state: 'syncing', pending, lastSyncedAt: meta.lastSyncedAt });
  }
  const cached = lastStatus.get(ownerId);
  // 同 owner＋generation 的最後失敗持續反映（即使已無 pending），直到真成功取代；不發假綠燈。
  if (cached && cached.generation === generation && isFailureState(cached.state)) {
    return makeStatus(ownerId, { state: cached.state, pending, lastSyncedAt: cached.lastSyncedAt ?? meta.lastSyncedAt, error: cached.error });
  }
  if (isOffline()) {
    return makeStatus(ownerId, { state: 'offline', pending, lastSyncedAt: meta.lastSyncedAt });
  }
  return makeStatus(ownerId, { state: 'idle', pending, lastSyncedAt: meta.lastSyncedAt });
}

function isFailureState(state) {
  return state === 'error' || state === 'offline' || state === 'not_configured';
}

/** 匯出目前 owner 的學習資料備份 envelope（core 白名單，不洩 token／正解）。 */
// 匯出時補缺（僅此處，不為背景同步新增輪詢）：新裝置尚未進 daily，本機沒有診斷
// attempt／readonly meta 時，以服務層 getDiagnosticResult 取得本帳戶權威摘要補進 DTO。
// 不合成資格、不寫 attempts／drafts、不改 SQL／資格。
// getDiagnosticResult 是共用 generic rpc，不深驗回應，故這裡必須自行驗 owner／status／
// attemptId／revision／result 形狀，200 回 null／{}／非 completed／錯 owner 一律拒，
// 不得冒「無摘要」成功。
// 錯誤分類（明確允許清單）：AUTH_CHANGED／abort／INVALID_RESPONSE／OWNER_MISMATCH／
// UNAUTHENTICATED／401／403 一律往外拋；只有 NOT_COMPLETED／NOT_CONFIGURED（維持
// local-only 出口）／真正無 status 的 TypeError（網路失敗）／HTTP 500–599 可降級為
// 「無遠端摘要」，保留同 owner 本機既有摘要。其餘一律拋出，不吞。
const DIAGNOSTIC_FATAL_CODES = new Set(['AUTH_CHANGED', 'UNAUTHENTICATED', 'OWNER_MISMATCH', 'INVALID_RESPONSE']);
function isDiagnosticFatal(err) {
  if (isAbort(err)) return true; // AbortError／AUTH_CHANGED
  const status = err?.status;
  if (status === 401 || status === 403) return true;
  return DIAGNOSTIC_FATAL_CODES.has(err?.code);
}
function isDiagnosticDegradable(err) {
  if (isDiagnosticFatal(err)) return false;
  if (err?.code === 'NOT_COMPLETED') return true;   // 未完成：允許無摘要
  if (err?.code === 'NOT_CONFIGURED') return true;  // 未設定：維持 local-only 出口
  const status = err?.status;
  if (typeof status === 'number') return status >= 500 && status <= 599; // 暫時性 HTTP
  return err instanceof TypeError;                  // 無 status 的真網路失敗
}
// getDiagnosticResult 回應深驗：必須是物件、owner 精確相符、status completed，
// 且具合法 attemptId／revision／result 物件。不合格即拒，不當成權威摘要。
function validateAuthoritativeDiagnostic(data, ownerId) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw fault('INVALID_RESPONSE', '診斷摘要回應格式無效');
  }
  if (typeof data.ownerId !== 'string' || !data.ownerId) {
    throw fault('INVALID_RESPONSE', '診斷摘要回應缺少帳戶');
  }
  if (data.ownerId !== ownerId) {
    throw fault('OWNER_MISMATCH', '診斷摘要回應帳戶不符，未採用');
  }
  if (data.status !== 'completed') {
    throw fault('INVALID_RESPONSE', '診斷摘要回應狀態非 completed');
  }
  if (typeof data.attemptId !== 'string' || !data.attemptId.trim()) {
    throw fault('INVALID_RESPONSE', '診斷摘要回應缺少 attemptId');
  }
  if (!Number.isSafeInteger(data.revision) || data.revision < 0) {
    throw fault('INVALID_RESPONSE', '診斷摘要回應 revision 無效');
  }
  if (data.result == null || typeof data.result !== 'object' || Array.isArray(data.result)) {
    throw fault('INVALID_RESPONSE', '診斷摘要回應 result 格式無效');
  }
  return data;
}
async function fetchAuthoritativeDiagnostic(ownerId, generation, guard) {
  let data;
  try {
    data = await getDiagnosticResult();
  } catch (err) {
    if (!isDiagnosticDegradable(err)) {
      if (isAbort(err)) { checkOwner(ownerId, generation); throw abortError(); }
      throw err;
    }
    guard();
    return null; // NOT_COMPLETED／NOT_CONFIGURED／真網路或 5xx：允許無遠端摘要
  }
  guard();
  return validateAuthoritativeDiagnostic(data, ownerId);
}
export async function exportLearningBackup() {
  await authReady;
  const ownerId = getUser()?.id ?? null;
  const generation = getAuthGeneration();
  if (!ownerId) throw fault('UNAUTHENTICATED', '請先登入再匯出學習資料');
  const guard = makeGuard(ownerId, generation, null);
  const snapshot = await readLearningState(ownerId, { guard });
  guard();
  // 本機已有診斷摘要（attempt 或 readonly meta）一律沿用，不覆蓋。
  let diagnostic = snapshot.diagnostic ?? null;
  if (diagnostic == null) {
    const remote = await fetchAuthoritativeDiagnostic(ownerId, generation, guard);
    guard();
    if (remote != null) diagnostic = remote;
  }
  return createLearningBackup({
    ownerId,
    dayPlans: snapshot.dayPlans,
    recheckEvents: snapshot.recheckEvents,
    diagnostic,
  }, { now: new Date() });
}

/** 預覽備份檔內容數量（不落地）；owner 不符時回傳檔案 owner，交由 UI 提示。 */
export async function previewLearningBackup(input) {
  await authReady;
  const ownerId = getUser()?.id ?? null;
  const generation = getAuthGeneration();
  if (!ownerId) throw fault('UNAUTHENTICATED', '請先登入再預覽備份');
  const parsed = parseBackupText(input);
  const fileOwner = typeof parsed?.ownerId === 'string' ? parsed.ownerId : '';
  const validated = validateLearningBackup(parsed, fileOwner);
  checkOwner(ownerId, generation);
  return {
    ownerId: validated.ownerId,
    dayPlanCount: validated.dayPlans.length,
    eventCount: validated.recheckEvents.length,
    hasDiagnostic: validated.diagnostic != null,
  };
}

/**
 * 從備份合併還原：先 validate 同 owner／schema 全部內容，再合併本機；
 * 本機成功後嘗試雲端同步，失敗回 pending／error 狀態（不 throw，避免誤稱本機未存）。
 */
export async function restoreLearningBackup(input) {
  await authReady;
  const ownerId = getUser()?.id ?? null;
  const generation = getAuthGeneration();
  if (!ownerId) throw fault('UNAUTHENTICATED', '請先登入再還原學習資料');
  const guard = makeGuard(ownerId, generation, null);
  // 先驗證同 owner／schema／全部內容；無效備份或不同帳戶即拒、零寫。
  const validated = validateLearningBackup(input, ownerId);
  checkOwner(ownerId, generation);

  try {
    // 直接在同交易由 store 合併／去重（含唯讀診斷 DTO；不寫 attempts 資格、不解鎖診斷）。
    await mergeLearningLocal(ownerId, validated, { guard });
    guard(); // 兩次 await 之後仍要 guard；A→B 即中止，不得啟動新帳戶同步
    return await syncLearningNow();
  } catch (err) {
    // 本機已合併（或交易內零寫）：換帳戶／abort 回狀態而非 throw，避免誤稱本機未存；
    // 其他（storage 等）錯誤才往外拋，不把失敗當成功。
    if (!isAbort(err)) throw err;
    return makeStatus(ownerId, { state: 'error', pending: true, lastSyncedAt: null, error: err });
  }
}

/** 事件驅動初始化（可 async 但 app 不 await）；冪等，回傳解除全部 listeners 的 cleanup。 */
export function initLearningSync() {
  if (cleanup) return cleanup;
  const offs = [];
  const requestSync = () => scheduleSync();
  for (const eventName of LOCAL_CHANGE_EVENTS) offs.push(on(eventName, requestSync));
  offs.push(on('auth:changed', () => {
    if (flight && (getUser()?.id !== flight.ownerId || getAuthGeneration() !== flight.generation)) {
      flight.controller.abort();
    }
    scheduleSync();
  }));
  const onOnline = () => scheduleSync();
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('online', onOnline);
  }
  scheduleSync(); // init 於 authReady 後才載入（登入事件已過）：安排一次初始同步，非輪詢
  cleanup = () => {
    for (const off of offs) { try { off(); } catch { /* 解除失敗不影響其他 */ } }
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('online', onOnline);
    }
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    cleanup = null;
  };
  return cleanup;
}

// 事件去抖：合併短時間內的多個觸發為一次同步；無登入者不動作。
function scheduleSync() {
  if (typeof setTimeout !== 'function') return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    runScheduledSync();
  }, DEBOUNCE_MS);
}

// 排定後執行：若同 owner＋generation 已有在途 flight，僅標記 queued（收尾補跑），
// 不另開 flight 也不輪詢；避免 flight 收尾邊界的觸發遺失。
function runScheduledSync() {
  const ownerId = getUser()?.id;
  if (!ownerId) return;
  const generation = getAuthGeneration();
  if (flight && flight.ownerId === ownerId && flight.generation === generation) {
    flight.queued = true;
    return;
  }
  syncLearningNow().catch(() => { /* 失敗保留待同步，等下次觸發或手動同步 */ });
}
