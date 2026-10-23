// 診斷／短複測專用資料庫；不覆寫既有 vocab2 / SRS 資料。
// 6.0.3：DB_VERSION 由 2 升到 3，新增 syncMeta 儲存區（合併式 outbox：dirtyVersion／
//   ackedVersion／cloudRevision／lastSyncedAt 與持久化待補傳記號 pendingEvents／pendingPlans）。
//   遷移 v1／v2 → v3 把既有具 owner 的 plan／event 標 pending；缺 owner 的舊 quiz 不領養。
//   每次任務或證據的「實質變更」與 dirty 記號在同一 RW 交易內原子 +1；semantic no-op
//   不 +revision／dirty、也不 emit。commitRecheckBatch 的 events＋latest plan updater＋
//   guards＋dirty 全部同交易，不先讀交易外舊快照再寫。
//   固定匯出 readLearningState／getLearningSyncMeta／mergeLearningLocal／adoptLearningRemote。
//   事件 extra 保留可選布林 hinted（缺省＝false；非法型別拒收；同 ID true/false 衝突）。
// 6.0.2：DB_VERSION 由 1 升到 2，新增 recheckEvents 儲存區（owner 隔離、eventId 冪等）。
// 連線維持 6.0 基底語義：每次交易各自 open、交易結束即 close，不引入跨交易連線快取。
// 升級一律「先檢查 contains 再建立」補齊，避免重複 createObjectStore 的 ConstraintError；
// attempts／drafts／dayPlans／preferences 於升級路徑完全不動，確保舊資料不遺失。
import { mergeLearningState, createLearningBackup, validateLearningBackup, BACKUP_FORMAT } from '../core/learning-backup.js';
import { emit } from '../core/eventbus.js';

const DB_NAME = 'vocab2_diagnostic_600';
const DB_VERSION = 3;
const BASE_STORES = ['attempts', 'drafts', 'dayPlans', 'preferences'];
const RECHECK_STORE = 'recheckEvents';
const SYNC_META_STORE = 'syncMeta';

function fault(code, message) { return Object.assign(new Error(message), { code }); }
function ownerKey(ownerId) {
  if (typeof ownerId !== 'string' || !ownerId.trim()) throw fault('UNAUTHENTICATED', '請先登入再保存診斷資料');
  return ownerId;
}
function verifyOwner(ownerId, value) {
  ownerKey(ownerId);
  if (value?.ownerId != null && value.ownerId !== ownerId) throw fault('OWNER_MISMATCH', '資料帳戶不符，未保存');
}
function revisionNumber(revision) {
  if (!Number.isSafeInteger(revision) || revision < 0) throw fault('INVALID_REVISION', '診斷版本無效');
  return revision;
}
function callGuard(guard) {
  if (typeof guard === 'function') guard();
}

// 補齊全部儲存區；只在「不存在」時建立，既有區塊與資料原封不動。
function ensureStores(db) {
  if (!db.objectStoreNames.contains('attempts')) db.createObjectStore('attempts', { keyPath: 'ownerId' });
  if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts', { keyPath: ['ownerId', 'attemptId'] });
  if (!db.objectStoreNames.contains('dayPlans')) db.createObjectStore('dayPlans', { keyPath: ['ownerId', 'localDate'] });
  if (!db.objectStoreNames.contains('preferences')) db.createObjectStore('preferences', { keyPath: 'ownerId' });
  if (!db.objectStoreNames.contains(RECHECK_STORE)) {
    const recheck = db.createObjectStore(RECHECK_STORE, { keyPath: 'eventId' });
    recheck.createIndex('byOwnerWord', ['ownerId', 'wordId']);
    recheck.createIndex('byOwner', 'ownerId');
  }
  if (!db.objectStoreNames.contains(SYNC_META_STORE)) {
    db.createObjectStore(SYNC_META_STORE, { keyPath: 'ownerId' });
  }
}

// v1／v2 → v3 遷移：既有具 owner 的 plan／event 標為 pending（待補傳），
// 缺 owner 的舊 quiz／plan 一律不領養。遷移只在 onupgradeneeded 觸發（升級到 3 才跑）。
function migrateToV3(tx) {
  const metaStore = tx.objectStore(SYNC_META_STORE);
  const plansReq = tx.objectStore('dayPlans').getAll();
  const eventsReq = tx.objectStore(RECHECK_STORE).getAll();
  let plans = null;
  let events = null;
  const tryFinish = () => {
    if (plans === null || events === null) return;
    const byOwner = new Map();
    for (const plan of (plans || [])) {
      if (plan && typeof plan.ownerId === 'string' && plan.ownerId.trim()) {
        const m = byOwner.get(plan.ownerId) || { plans: [], events: [] };
        if (!m.plans.includes(plan.localDate)) m.plans.push(plan.localDate);
        byOwner.set(plan.ownerId, m);
      }
    }
    for (const ev of (events || [])) {
      if (ev && typeof ev.ownerId === 'string' && ev.ownerId.trim()) {
        const m = byOwner.get(ev.ownerId) || { plans: [], events: [] };
        if (!m.events.includes(ev.eventId)) m.events.push(ev.eventId);
        byOwner.set(ev.ownerId, m);
      }
    }
    for (const [ownerId, { plans: planDates, events: evIds }] of byOwner) {
      const version = 1;
      metaStore.put({
        ownerId,
        dirtyVersion: version,
        ackedVersion: 0,
        cloudRevision: 0,
        lastSyncedAt: null,
        pendingEvents: evIds.map((eventId) => ({ eventId, version })),
        pendingPlans: planDates.map((localDate) => ({ localDate, version })),
        diagnosticMeta: null,
      });
    }
  };
  plansReq.onsuccess = () => { plans = plansReq.result || []; tryFinish(); };
  plansReq.onerror = () => { plans = []; tryFinish(); };
  eventsReq.onsuccess = () => { events = eventsReq.result || []; tryFinish(); };
  eventsReq.onerror = () => { events = []; tryFinish(); };
}

// 每次呼叫都新開連線、交易結束即關閉（不引入跨交易連線快取）。
function openDB() {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (err) { reject(err); return; }
    let blocked = false;
    req.onupgradeneeded = () => {
      ensureStores(req.result);
      migrateToV3(req.transaction);
    };
    req.onsuccess = () => {
      if (blocked) { req.result.close(); return; }
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => reject(req.error || fault('STORAGE_ERROR', '無法開啟本機診斷資料庫'));
    req.onblocked = () => { blocked = true; reject(fault('STORAGE_BLOCKED', '其他分頁佔用本機診斷資料庫，請關閉後重試')); };
  });
}

// 回應只在 transaction complete 後送出；完成／失敗／例外路徑都要關閉連線。
async function transact(storeName, mode, operation, additionalStores = []) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    let tx, value, failure;
    try { tx = db.transaction([storeName, ...additionalStores], mode); }
    catch (err) { db.close(); reject(err); return; }
    const fail = (err) => {
      failure = err;
      try { tx.abort(); } catch { db.close(); reject(err); }
    };
    tx.oncomplete = () => { db.close(); resolve(value); };
    tx.onabort = () => { db.close(); reject(failure || tx.error || fault('STORAGE_ERROR', '本機保存失敗，尚未保存')); };
    tx.onerror = () => { failure ||= tx.error; };
    try { operation(tx.objectStore(storeName), (result) => { value = result; }, fail, tx); }
    catch (err) { fail(err); }
  });
}
function read(storeName, key) {
  return transact(storeName, 'readonly', (store, setValue) => {
    const req = store.get(key);
    req.onsuccess = () => setValue(req.result ?? null);
  });
}

// 多儲存區交易 runner：operation({ store, resolve, fail, tx })。
// store(name) 取該交易的 objectStore；resolve(value) 設回傳值；fail(err) 整批 abort。
function runTransaction(storeNames, mode, operation) {
  return new Promise((resolve, reject) => {
    openDB().then((db) => {
      let tx;
      try { tx = db.transaction(storeNames, mode); }
      catch (err) { db.close(); reject(err); return; }
      let settled = false;
      let resultValue;
      let failure = null;
      const resolveFn = (value) => { resultValue = value; };
      const failFn = (err) => {
        if (settled) return;
        failure = err;
        try { tx.abort(); } catch { settled = true; db.close(); reject(failure || err); }
      };
      tx.oncomplete = () => { settled = true; db.close(); resolve(resultValue); };
      tx.onabort = () => { settled = true; db.close(); reject(failure || tx.error || fault('STORAGE_ERROR', '本機保存失敗，尚未保存')); };
      tx.onerror = () => { failure ||= tx.error; };
      const store = (name) => tx.objectStore(name);
      try { operation({ store, resolve: resolveFn, fail: failFn, tx }); }
      catch (err) { failFn(err); }
    }, reject);
  });
}

// ============================================================
// syncMeta 存取
// ============================================================
function emptyMeta(ownerId) {
  return {
    ownerId,
    dirtyVersion: 0,
    ackedVersion: 0,
    cloudRevision: 0,
    lastSyncedAt: null,
    pendingEvents: [],
    pendingPlans: [],
    diagnosticMeta: null,
  };
}
function normalizeMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const n = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
  return {
    ownerId: meta.ownerId,
    dirtyVersion: n(meta.dirtyVersion),
    ackedVersion: n(meta.ackedVersion),
    cloudRevision: n(meta.cloudRevision),
    lastSyncedAt: meta.lastSyncedAt ?? null,
    pendingEvents: Array.isArray(meta.pendingEvents) ? meta.pendingEvents : [],
    pendingPlans: Array.isArray(meta.pendingPlans) ? meta.pendingPlans : [],
    diagnosticMeta: meta.diagnosticMeta ?? null,
  };
}
// 讀 syncMeta 並轉換（transform 回傳新 meta 或 null 不寫）。在既有 RW 交易內。
function updateMeta(tx, ownerId, transform) {
  const metaStore = tx.objectStore(SYNC_META_STORE);
  const req = metaStore.get(ownerId);
  req.onsuccess = () => {
    try {
      const meta = normalizeMeta(req.result) || emptyMeta(ownerId);
      const next = transform(meta);
      if (next) metaStore.put(next);
    } catch (err) {
      try { tx.abort(); } catch { /* ignore */ }
    }
  };
  req.onerror = () => { try { tx.abort(); } catch { /* ignore */ } };
}
// dirtyVersion +1，並把 pending 的 eventId／localDate 記號標到新版本。純函式。
function bumpMeta(meta, pending = []) {
  const dirtyVersion = meta.dirtyVersion + 1;
  const next = { ...meta, dirtyVersion };
  for (const { eventId, localDate } of pending) {
    if (eventId != null) {
      const idx = next.pendingEvents.findIndex((e) => e.eventId === eventId);
      if (idx >= 0) next.pendingEvents = next.pendingEvents.map((e, i) => (i === idx ? { eventId, version: dirtyVersion } : e));
      else next.pendingEvents = [...next.pendingEvents, { eventId, version: dirtyVersion }];
    }
    if (localDate != null) {
      const idx = next.pendingPlans.findIndex((p) => p.localDate === localDate);
      if (idx >= 0) next.pendingPlans = next.pendingPlans.map((p, i) => (i === idx ? { localDate, version: dirtyVersion } : p));
      else next.pendingPlans = [...next.pendingPlans, { localDate, version: dirtyVersion }];
    }
  }
  return next;
}

// ============================================================
// 既有 exports（6.0／6.0.2 基底保留）
// ============================================================
export async function getAttempt(ownerId) { return read('attempts', ownerKey(ownerId)); }
export async function saveAttempt(ownerId, attempt) {
  verifyOwner(ownerId, attempt);
  revisionNumber(attempt?.revision);
  if (!attempt?.attemptId) throw fault('INVALID_ATTEMPT', '診斷場次無效');
  return transact('attempts', 'readwrite', (store, setValue, fail) => {
    const req = store.get(ownerId);
    req.onsuccess = () => {
      try {
        const current = req.result ?? null;
        if (current && (attempt.revision < current.revision || attempt.attemptId !== current.attemptId
          || (current.status === 'completed' && attempt.status !== 'completed'))) {
          throw fault('CONFLICT', '本機診斷已有較新資料，請重新讀取');
        }
        const next = { ...attempt, ownerId };
        store.put(next);
        setValue(next);
      } catch (err) { fail(err); }
    };
  });
}
export async function getDraft(ownerId, attemptId) {
  return read('drafts', [ownerKey(ownerId), attemptId]);
}
export async function saveDraft(ownerId, attemptId, revision, draft) {
  verifyOwner(ownerId, draft);
  revisionNumber(revision);
  if (!attemptId || (draft?.attemptId != null && draft.attemptId !== attemptId)) throw fault('INVALID_ATTEMPT', '草稿場次不符');
  return transact('drafts', 'readwrite', (store, setValue, fail, tx) => {
    const attemptRequest = tx.objectStore('attempts').get(ownerId);
    attemptRequest.onsuccess = () => {
      const attempt = attemptRequest.result;
      if (attempt && (attempt.attemptId !== attemptId || attempt.revision > revision || attempt.status === 'completed')) {
        fail(fault('CONFLICT', '正式診斷已有較新資料，草稿未保存')); return;
      }
      const request = store.get([ownerId, attemptId]);
      request.onsuccess = () => {
        if (request.result && revision < request.result.revision) {
          fail(fault('CONFLICT', '草稿已有較新版本，請重新讀取')); return;
        }
        try {
          const next = { ownerId, attemptId, revision, draft };
          store.put(next); setValue(next);
        } catch (err) { fail(err); }
      };
    };
  }, ['attempts']);
}
export async function getDayPlan(ownerId, localDate) {
  return read('dayPlans', [ownerKey(ownerId), localDate]);
}
export async function listDayPlans(ownerId) {
  ownerKey(ownerId);
  return transact('dayPlans', 'readonly', (store, setValue) => {
    const req = store.getAll();
    req.onsuccess = () => setValue(req.result.filter((plan) => plan.ownerId === ownerId));
  });
}

// 無 revision 的 canonical 內容鍵：semantic no-op 用（revision 屬自動遞增 metadata，不列入內容）。
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}
function planContentKey(plan) {
  if (!plan || typeof plan !== 'object') return null;
  const { revision, ...rest } = plan;
  return canonical(rest);
}

export async function updateDayPlan(ownerId, localDate, updater) {
  ownerKey(ownerId);
  if (typeof localDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(localDate)) throw fault('INVALID_DATE', '任務日期無效');
  if (typeof updater !== 'function') throw fault('INVALID_UPDATER', '缺少本機更新函式');
  let changed = false;
  const result = await runTransaction(['dayPlans', SYNC_META_STORE], 'readwrite', ({ store, resolve, fail, tx }) => {
    const req = store('dayPlans').get([ownerId, localDate]);
    req.onsuccess = () => {
      try {
        const current = req.result ?? null;
        const next = updater(current);
        if (next && typeof next.then === 'function') throw fault('INVALID_UPDATER', '本機更新函式必須同步完成');
        if (next == null) { resolve(current); return; }
        verifyOwner(ownerId, next);
        if (current && planContentKey(next) === planContentKey(current)) { resolve(current); return; }
        const stored = { ...next, ownerId, localDate, revision: (current?.revision ?? 0) + 1 };
        store('dayPlans').put(stored);
        updateMeta(tx, ownerId, (meta) => {
          changed = true;
          return bumpMeta(meta, [{ localDate }]);
        });
        resolve(stored);
      } catch (err) { fail(err); }
    };
    req.onerror = () => fail(req.error);
  });
  if (changed) emit('learning:local-changed', { ownerId });
  return result;
}

export async function getPreference(ownerId) { return read('preferences', ownerKey(ownerId)); }
export async function savePreference(ownerId, preference) {
  verifyOwner(ownerId, preference);
  return transact('preferences', 'readwrite', (store, setValue) => {
    const next = { ...preference, ownerId };
    store.put(next);
    setValue(next);
  });
}

// ============================================================
// 6.0.2 短複測證據儲存（帳戶隔離、eventId 冪等）
// ============================================================
const VALID_RECHECK_MODES = new Set(['recognition', 'recall']);
function recheckTime(at) {
  if (typeof at === 'number' && Number.isFinite(at)) return at;
  if (typeof at === 'string' && at.trim() && Number.isFinite(Date.parse(at))) return Date.parse(at);
  return null;
}
function normalizeRecheckInput(ownerId, event) {
  ownerKey(ownerId);
  if (!event || typeof event !== 'object') throw fault('INVALID_EVIDENCE', '短複測證據格式無效');
  if (event.ownerId != null && event.ownerId !== ownerId) throw fault('OWNER_MISMATCH', '資料帳戶不符，未保存');
  const eventId = event.eventId;
  if (typeof eventId !== 'string' || !eventId.trim()) throw fault('INVALID_EVENT_ID', '短複測證據缺少 eventId，未保存');
  const wordId = event.wordId;
  if ((typeof wordId !== 'string' || !wordId.trim()) && !(typeof wordId === 'number' && Number.isFinite(wordId))) {
    throw fault('INVALID_WORD_ID', '短複測證據缺少有效 wordId，未保存');
  }
  const extra = event.extra;
  if (!extra || typeof extra !== 'object') throw fault('INVALID_EVIDENCE', '短複測證據缺少 extra，未保存');
  if (typeof extra.sessionId !== 'string' || !extra.sessionId.trim()) throw fault('INVALID_SESSION', '短複測證據缺少 sessionId，未保存');
  if (!VALID_RECHECK_MODES.has(extra.mode)) throw fault('INVALID_MODE', '短複測模式無效，未保存');
  if (typeof extra.correct !== 'boolean') throw fault('INVALID_CORRECT', '短複測作答必須是布林值，未保存');
  if (recheckTime(event.at) == null) throw fault('INVALID_TIME', '短複測證據缺少有效時間，未保存');
  // hinted：可選布林（提示後辨認只保留練習、不列候選）。缺省＝false 與 false 語義等價；
  // 存在但非布林（null／string／number／物件等）一律拒絕，不 String 化冒成功。
  let hinted = false;
  if (extra.hinted !== undefined) {
    if (typeof extra.hinted !== 'boolean') throw fault('INVALID_HINTED', '短複測證據 hinted 非布林，未保存');
    hinted = extra.hinted;
  }
  return {
    eventId,
    ownerId,
    wordId,
    type: 'recheck',
    at: event.at,
    extra: { sessionId: extra.sessionId, mode: extra.mode, correct: extra.correct, hinted },
  };
}

// 兩筆證據是否為同一 payload。hinted 以「是否 true」比對：缺省與 false 等價，true 則不同。
function sameRecheckPayload(a, b) {
  if (!a || !b) return false;
  if (String(a.wordId) !== String(b.wordId)) return false;
  if (recheckTime(a.at) !== recheckTime(b.at)) return false;
  const ea = a.extra || {};
  const eb = b.extra || {};
  if ((ea.hinted === true) !== (eb.hinted === true)) return false;
  return ea.sessionId === eb.sessionId && ea.mode === eb.mode && ea.correct === eb.correct;
}

export async function appendRecheckEvent(ownerId, event) {
  const record = normalizeRecheckInput(ownerId, event);
  let changed = false;
  const result = await runTransaction([RECHECK_STORE, SYNC_META_STORE], 'readwrite', ({ store, resolve, fail, tx }) => {
    const existingReq = store(RECHECK_STORE).get(record.eventId);
    existingReq.onsuccess = () => {
      try {
        const existing = existingReq.result;
        if (existing) {
          if (existing.ownerId !== ownerId) { fail(fault('EVENT_ID_CONFLICT', '此證據編號已被其他帳戶使用，未保存')); return; }
          if (!sameRecheckPayload(existing, record)) { fail(fault('EVENT_PAYLOAD_CONFLICT', '此證據編號已有不同內容，未覆寫既有證據')); return; }
          resolve({ stored: false, duplicate: true, event: existing });
          return;
        }
        store(RECHECK_STORE).put(record);
        updateMeta(tx, ownerId, (meta) => {
          changed = true;
          return bumpMeta(meta, [{ eventId: record.eventId }]);
        });
        resolve({ stored: true, duplicate: false, event: record });
      } catch (err) { fail(err); }
    };
    existingReq.onerror = () => fail(existingReq.error);
  });
  if (changed) emit('learning:local-changed', { ownerId });
  return result;
}

export async function listRecheckEvents(ownerId, wordId) {
  ownerKey(ownerId);
  if ((typeof wordId !== 'string' || !wordId.trim()) && !(typeof wordId === 'number' && Number.isFinite(wordId))) {
    throw fault('INVALID_WORD_ID', '缺少有效 wordId');
  }
  const wanted = String(wordId);
  return transact(RECHECK_STORE, 'readonly', (store, setValue) => {
    const req = store.index('byOwner').getAll(ownerId);
    req.onsuccess = () => setValue(req.result.filter((r) => r.ownerId === ownerId && String(r.wordId) === wanted));
  });
}
export async function listOwnerRecheckEvents(ownerId) {
  ownerKey(ownerId);
  return transact(RECHECK_STORE, 'readonly', (store, setValue) => {
    const req = store.index('byOwner').getAll(ownerId);
    req.onsuccess = () => setValue(req.result.filter((r) => r.ownerId === ownerId));
  });
}

// ============================================================
// 6.0.2 短複測「批次提交」：進度（dayPlans）與證據（recheckEvents）同交易
// ============================================================
// events 形狀（已正規化）：{ eventId, wordId, type:'recheck', at, extra:{sessionId,mode,correct,hinted} }。
// updater(currentDayPlan) 回傳「新的 dayPlan」、null（不更新 dayPlans），或
//   { plan, events }（同時更新 dayPlan 並追加 events；供逐字提交把 progress 與
//   UUID 證據同交易落地）。events 一律冪等（同 ID 同 payload 不重寫、異 payload 衝突）。
// eventBuilder(currentDayPlan)：選用同步回呼，於交易內讀到最新 plan 後推導 events。
// guards：同步函式陣列，任一丟錯即整批 abort（不落地）。
// 回傳：{ events: [{eventId, stored, duplicate}], plan }。
export async function commitRecheckBatch(ownerId, localDate, { events: incoming = [], eventBuilder, updater, guards = [] } = {}) {
  ownerKey(ownerId);
  if (typeof localDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(localDate)) throw fault('INVALID_DATE', '任務日期無效');
  const staticRecords = (Array.isArray(incoming) ? incoming : []).map((event) => normalizeRecheckInput(ownerId, event));
  let changed = false;
  const result = await runTransaction(['dayPlans', RECHECK_STORE, SYNC_META_STORE], 'readwrite', ({ store, resolve, fail, tx }) => {
    const runGuards = () => { for (const g of (Array.isArray(guards) ? guards : [])) if (typeof g === 'function') g(); };
    const planStore = store('dayPlans');
    const eventsStore = store(RECHECK_STORE);
    let records = null;
    let results = [];
    let nextPlan = null;
    let wroteEventIds = [];
    let wrotePlan = false;

    // 步驟三：套用 updater、寫回（與事件同一交易）。updater 於事件寫入後呼叫，
    //   其回傳的 plan 才反映本次提交的鎖定狀態；亦可回傳 { plan, events } 追加工件。
    const stepWrite = () => {
      try {
        runGuards();
        if (typeof updater === 'function') {
          const next = updater(nextPlan);
          if (next && typeof next.then === 'function') throw fault('INVALID_UPDATER', '本機更新函式必須同步完成');
          if (next != null) {
            if (typeof next === 'object' && !Array.isArray(next) && (Object.hasOwn(next, 'plan') || Object.hasOwn(next, 'events'))) {
              const extraEvents = (Array.isArray(next.events) ? next.events : []).map((event) => normalizeRecheckInput(ownerId, event));
              const planNext = next.plan ?? null;
              if (planNext != null) {
                verifyOwner(ownerId, planNext);
                if (!nextPlan || planContentKey(planNext) !== planContentKey(nextPlan)) {
                  const stored = { ...planNext, ownerId, localDate, revision: (nextPlan?.revision ?? 0) + 1 };
                  planStore.put(stored);
                  nextPlan = stored;
                  wrotePlan = true;
                }
              }
              writeExtraEvents(extraEvents, () => { finish(); });
              return;
            }
            verifyOwner(ownerId, next);
            if (!nextPlan || planContentKey(next) !== planContentKey(nextPlan)) {
              const stored = { ...next, ownerId, localDate, revision: (nextPlan?.revision ?? 0) + 1 };
              planStore.put(stored);
              nextPlan = stored;
              wrotePlan = true;
            }
          }
        }
        finish();
      } catch (err) { fail(err); return; }
    };
    const writeExtraEvents = (extraEvents, done) => {
      let i = 0;
      const step = () => {
        if (i >= extraEvents.length) { done(); return; }
        const rec = extraEvents[i];
        const req = eventsStore.get(rec.eventId);
        req.onsuccess = () => {
          try {
            runGuards();
            const existing = req.result;
            if (existing) {
              if (existing.ownerId !== ownerId) { fail(fault('EVENT_ID_CONFLICT', '此證據編號已被其他帳戶使用，未保存')); return; }
              if (!sameRecheckPayload(existing, rec)) { fail(fault('EVENT_PAYLOAD_CONFLICT', '此證據編號已有不同內容，未覆寫既有證據')); return; }
              results.push({ eventId: rec.eventId, stored: false, duplicate: true });
            } else {
              eventsStore.put(rec);
              wroteEventIds.push(rec.eventId);
              results.push({ eventId: rec.eventId, stored: true, duplicate: false });
            }
          } catch (err) { fail(err); return; }
          i += 1;
          step();
        };
        req.onerror = () => fail(req.error);
      };
      step();
    };
    const finish = () => {
      if (wroteEventIds.length || wrotePlan) {
        updateMeta(tx, ownerId, (meta) => {
          changed = true;
          return bumpMeta(meta, [...wroteEventIds.map((eventId) => ({ eventId })), ...(wrotePlan ? [{ localDate }] : [])]);
        });
      }
      resolve({ events: results, plan: nextPlan });
    };
    // 步驟一：讀取當日計畫（含最新 recheck），決定 events 來源。
    const stepPlan = () => {
      const planReq = planStore.get([ownerId, localDate]);
      planReq.onsuccess = () => {
        try {
          runGuards();
          const current = planReq.result ?? null;
          nextPlan = current;
          if (typeof eventBuilder === 'function') {
            const built = eventBuilder(current);
            if (built && typeof built.then === 'function') throw fault('INVALID_UPDATER', '本機事件產生函式必須同步完成');
            records = (Array.isArray(built) ? built : []).map((event) => normalizeRecheckInput(ownerId, event));
          } else {
            records = staticRecords;
          }
          stepEvents(0);
        } catch (err) { fail(err); return; }
      };
      planReq.onerror = () => fail(planReq.error);
    };
    // 步驟二：逐筆事件冪等／衝突檢核（全部在同交易內，依最新 plan 推導出的 events）。
    const stepEvents = (i) => {
      if (i >= (records?.length ?? 0)) { stepWrite(); return; }
      const rec = records[i];
      const req = eventsStore.get(rec.eventId);
      req.onsuccess = () => {
        try {
          runGuards();
          const existing = req.result;
          if (existing) {
            if (existing.ownerId !== ownerId) { fail(fault('EVENT_ID_CONFLICT', '此證據編號已被其他帳戶使用，未保存')); return; }
            if (!sameRecheckPayload(existing, rec)) { fail(fault('EVENT_PAYLOAD_CONFLICT', '此證據編號已有不同內容，未覆寫既有證據')); return; }
            results.push({ eventId: rec.eventId, stored: false, duplicate: true });
          } else {
            eventsStore.put(rec);
            wroteEventIds.push(rec.eventId);
            results.push({ eventId: rec.eventId, stored: true, duplicate: false });
          }
        } catch (err) { fail(err); return; }
        stepEvents(i + 1);
      };
      req.onerror = () => fail(req.error);
    };
    try { runGuards(); stepPlan(); } catch (err) { fail(err); }
  });
  if (changed) emit('learning:local-changed', { ownerId });
  return result;
}

// ============================================================
// 6.0.3 學習同步：唯讀狀態、outbox 記號、還原合併、雲端採用
// ============================================================
function snapshotOf(ownerId, meta, dayPlans, recheckEvents, diagnostic) {
  return {
    ownerId,
    revision: meta.cloudRevision,
    dayPlans,
    recheckEvents,
    diagnostic,
    meta,
  };
}

// 讀取完整學習狀態（供匯出／組裝 outbox）。單一 readonly 交易跨 4 個儲存區，保證原子 snapshot：
// plan／events／meta 不會分屬不同版本（避免讀到 V 的資料卻配 V+1 的 meta 而誤 ACK 新變更）。
// diagnostic＝attempts 真資格，缺 attempt 時回退 meta.diagnosticMeta（唯讀 DTO，不成資格）。
// guard 於每個 IDB callback 與最終回傳前都重驗（晚到讀取拒絕採用）。
export async function readLearningState(ownerId, { guard } = {}) {
  ownerKey(ownerId);
  return runTransaction(['attempts', 'dayPlans', RECHECK_STORE, SYNC_META_STORE], 'readonly', ({ store, resolve, fail }) => {
    try {
      callGuard(guard);
      const state = { meta: undefined, plans: undefined, events: undefined, attempt: undefined };
      const tryResolve = () => {
        if (state.meta === undefined || state.plans === undefined || state.events === undefined || state.attempt === undefined) return;
        try {
          callGuard(guard);
          const meta = normalizeMeta(state.meta) || emptyMeta(ownerId);
          const diagnostic = state.attempt ?? meta.diagnosticMeta;
          resolve(snapshotOf(ownerId, meta, state.plans, state.events, diagnostic));
        } catch (err) { fail(err); }
      };
      const attemptReq = store('attempts').get(ownerId);
      attemptReq.onsuccess = () => { try { callGuard(guard); state.attempt = attemptReq.result ?? null; tryResolve(); } catch (err) { fail(err); } };
      const plansReq = store('dayPlans').getAll();
      plansReq.onsuccess = () => { try { callGuard(guard); state.plans = plansReq.result.filter((p) => p.ownerId === ownerId); tryResolve(); } catch (err) { fail(err); } };
      const eventsReq = store(RECHECK_STORE).index('byOwner').getAll(ownerId);
      eventsReq.onsuccess = () => { try { callGuard(guard); state.events = eventsReq.result.filter((e) => e.ownerId === ownerId); tryResolve(); } catch (err) { fail(err); } };
      const metaReq = store(SYNC_META_STORE).get(ownerId);
      metaReq.onsuccess = () => { try { callGuard(guard); state.meta = metaReq.result ?? null; tryResolve(); } catch (err) { fail(err); } };
    } catch (err) { fail(err); }
  });
}

// 讀取同步記號：dirtyVersion／ackedVersion／cloudRevision／lastSyncedAt。guard 於 onsuccess 重驗。
export async function getLearningSyncMeta(ownerId, { guard } = {}) {
  ownerKey(ownerId);
  return runTransaction([SYNC_META_STORE], 'readonly', ({ store, resolve, fail }) => {
    try {
      callGuard(guard);
      const req = store(SYNC_META_STORE).get(ownerId);
      req.onsuccess = () => {
        try {
          callGuard(guard);
          const meta = normalizeMeta(req.result) || emptyMeta(ownerId);
          resolve({
            ownerId,
            dirtyVersion: meta.dirtyVersion,
            ackedVersion: meta.ackedVersion,
            cloudRevision: meta.cloudRevision,
            lastSyncedAt: meta.lastSyncedAt,
          });
        } catch (err) { fail(err); }
      };
      req.onerror = () => fail(req.error);
    } catch (err) { fail(err); }
  });
}

// 把 incoming（備份 envelope 或原始 state）正規化成已驗證 envelope，供合併與診斷 DTO 萃取。
function normalizeIncoming(ownerId, incoming) {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) throw fault('INVALID_BACKUP', '還原內容格式無效');
  if (incoming.format === BACKUP_FORMAT) return validateLearningBackup(incoming, ownerId);
  return createLearningBackup({
    ownerId,
    dayPlans: incoming.dayPlans ?? [],
    recheckEvents: incoming.recheckEvents ?? [],
    diagnostic: incoming.diagnostic,
  }, {});
}

// 依序寫入 events（global 主鍵 eventId 檢查，非 owner 索引）：不存在→put；
// 同 owner 同 payload→duplicate（略過）；異 owner 或異 payload→fail（整批 abort）。
// onStored(eventId) 於真正新寫入時呼叫（供記 pending）。recheckEvents 主鍵是 eventId，
// 不能用「本 owner 索引已讀」取代全庫碰撞驗證。
// guard 於每個 event 讀回 callback、put 前與 onDone 開始都重驗；丟錯即整批 rollback。
function writeEventsChecked(eventsStore, ownerId, events, guard, onDone, onFail, onStored) {
  const g = typeof guard === 'function' ? guard : null;
  let i = 0;
  const step = () => {
    if (i >= events.length) {
      try { if (g) g(); onDone(); } catch (err) { onFail(err); }
      return;
    }
    let rec;
    try { if (g) g(); rec = events[i]; } catch (err) { onFail(err); return; }
    const req = eventsStore.get(rec.eventId);
    req.onsuccess = () => {
      try {
        if (g) g();
        const existing = req.result;
        if (existing) {
          if (existing.ownerId !== ownerId) { onFail(fault('EVENT_ID_CONFLICT', '此證據編號已被其他帳戶使用，未保存')); return; }
          if (!sameRecheckPayload(existing, rec)) { onFail(fault('EVENT_PAYLOAD_CONFLICT', '此證據編號已有不同內容，未覆寫既有證據')); return; }
        } else {
          if (g) g();
          eventsStore.put(rec);
          if (onStored) onStored(rec.eventId);
        }
      } catch (err) { onFail(err); return; }
      i += 1;
      step();
    };
    req.onerror = () => onFail(req.error);
  };
  step();
}

// 還原／本機合併：現有本機 plan 為 base，完成／證據 union；只增不解鎖。
// 不寫 attempts／drafts／資格／SRS；readonly diagnostic 另存 meta.diagnosticMeta 供匯出，不成資格。
// 逐計畫 semantic 比較：只有實質 changed 的 date 才寫／標 pending，no-op 零寫（不 bump dirty／emit）。
export async function mergeLearningLocal(ownerId, incoming, { guard } = {}) {
  ownerKey(ownerId);
  const env = normalizeIncoming(ownerId, incoming);
  let changed = false;
  const result = await runTransaction(['attempts', 'dayPlans', RECHECK_STORE, SYNC_META_STORE], 'readwrite', ({ store, resolve, fail }) => {
    const readAll = (cb) => {
      const state = { plans: undefined, events: undefined, meta: undefined, attempt: undefined };
      const tryDone = () => { if (state.plans !== undefined && state.events !== undefined && state.meta !== undefined && state.attempt !== undefined) cb(state); };
      const plansReq = store('dayPlans').getAll();
      plansReq.onsuccess = () => { state.plans = plansReq.result.filter((p) => p.ownerId === ownerId); tryDone(); };
      const eventsReq = store(RECHECK_STORE).index('byOwner').getAll(ownerId);
      eventsReq.onsuccess = () => { state.events = eventsReq.result.filter((e) => e.ownerId === ownerId); tryDone(); };
      const metaReq = store(SYNC_META_STORE).get(ownerId);
      metaReq.onsuccess = () => { state.meta = metaReq.result ?? null; tryDone(); };
      const attemptReq = store('attempts').get(ownerId);
      attemptReq.onsuccess = () => { state.attempt = attemptReq.result ?? null; tryDone(); };
    };
    try {
      callGuard(guard);
      readAll(({ plans, events, meta: metaRaw, attempt }) => {
        try {
          callGuard(guard);
          const meta = normalizeMeta(metaRaw) || emptyMeta(ownerId);
          // 正規化本機（與 mergeLearningState 同 normalize 規則），供逐日期 semantic 比較。
          const localEnv = createLearningBackup({ ownerId, dayPlans: plans, recheckEvents: events }, {});
          const localPlanByDate = new Map(localEnv.dayPlans.map((p) => [p.localDate, p]));
          const localEventIds = new Set(localEnv.recheckEvents.map((e) => e.eventId));
          const localState = { ownerId, revision: meta.cloudRevision, dayPlans: plans, recheckEvents: events };
          const incomingState = { ownerId, revision: 0, dayPlans: env.dayPlans, recheckEvents: env.recheckEvents };
          // 現有本機 plan 為 base：把 incoming 當 local、本機當 remote（remote 為 plan base）。
          const merged = mergeLearningState(incomingState, localState);
          const changedDates = [];
          const finalPlans = [];
          for (const mp of merged.dayPlans) {
            const lp = localPlanByDate.get(mp.localDate);
            const finalPlan = { ...mp, revision: Math.max(lp?.revision ?? 0, mp.revision ?? 0) };
            finalPlans.push(finalPlan);
            if (!lp || planContentKey(mp) !== planContentKey(lp)) {
              changedDates.push(mp.localDate);
              store('dayPlans').put(finalPlan);
            }
          }
          const newEvents = merged.recheckEvents.filter((e) => !localEventIds.has(e.eventId));
          const storedEventIds = [];
          writeEventsChecked(store(RECHECK_STORE), ownerId, newEvents, guard, () => {
            try {
              const diagnosticMeta = env.diagnostic ?? meta.diagnosticMeta;
              const hasNew = changedDates.length > 0 || storedEventIds.length > 0;
              const pending = [
                ...storedEventIds.map((eventId) => ({ eventId })),
                ...changedDates.map((localDate) => ({ localDate })),
              ];
              const nextMeta = hasNew ? bumpMeta({ ...meta, diagnosticMeta }, pending) : { ...meta, diagnosticMeta };
              // no-op 零寫：dirty 不變且 diagnosticMeta 不變就不 put meta。
              const metaChanged = hasNew || canonical(diagnosticMeta) !== canonical(meta.diagnosticMeta);
              if (metaChanged) store(SYNC_META_STORE).put(nextMeta);
              changed = hasNew;
              const diagnostic = attempt ?? nextMeta.diagnosticMeta;
              resolve(snapshotOf(ownerId, nextMeta, finalPlans, merged.recheckEvents, diagnostic));
            } catch (err) { fail(err); }
          }, fail, (eventId) => { storedEventIds.push(eventId); });
        } catch (err) { fail(err); }
      });
    } catch (err) { fail(err); }
  });
  if (changed) emit('learning:local-changed', { ownerId });
  return result;
}

function safeNonNegativeInt(v) { return Number.isSafeInteger(v) && v >= 0; }

// 驗證 remote（pull／merge 回應）：owner 一致、revision 非負、dayPlans／recheckEvents 為陣列。
// 深層合法性交由 mergeLearningState 正規化（無效即拋錯，整筆拒收）。
function validateRemoteState(ownerId, remote) {
  if (!remote || typeof remote !== 'object' || Array.isArray(remote)) throw fault('INVALID_RESPONSE', '雲端學習狀態格式無效');
  if (remote.ownerId !== ownerId) throw fault('OWNER_MISMATCH', '雲端學習狀態帳戶不符');
  if (!safeNonNegativeInt(remote.revision)) throw fault('INVALID_RESPONSE', '雲端學習狀態版本無效');
  if (!Array.isArray(remote.dayPlans)) throw fault('INVALID_RESPONSE', '雲端學習狀態 dayPlans 無效');
  if (!Array.isArray(remote.recheckEvents)) throw fault('INVALID_RESPONSE', '雲端學習狀態 recheckEvents 無效');
  return remote;
}

// 驗證 ack：version 非負且不超當前 dirty；eventIds 為非空字串集合；
// remote.acknowledgedEventIds 必須與 eventIds 完全一致（不可缺／多）。
// 另驗本次 eventIds 真正出現在 remote.recheckEvents，且內容不與本機衝突——
// 避免空 events 但假 ACK 清 pending。
function validateAck(ownerId, ack, remote, currentDirty, localEvents) {
  if (!ack || typeof ack !== 'object' || Array.isArray(ack)) throw fault('INVALID_ACK', 'ACK 格式無效');
  if (!safeNonNegativeInt(ack.version)) throw fault('INVALID_ACK', 'ACK 版本無效');
  if (ack.version > currentDirty) throw fault('INVALID_ACK', 'ACK 版本超過本機待補傳版本');
  const eventIds = Array.isArray(ack.eventIds) ? ack.eventIds : null;
  if (!eventIds) throw fault('INVALID_ACK', 'ACK 缺少本次提交事件清單');
  for (const id of eventIds) if (typeof id !== 'string' || !id.trim()) throw fault('INVALID_ACK', 'ACK 事件編號無效');
  const remoteAck = remote.acknowledgedEventIds;
  if (!Array.isArray(remoteAck)) throw fault('INVALID_RESPONSE', '雲端回應缺少 ACK 認列清單');
  const submitted = new Set(eventIds);
  const remoteSet = new Set();
  for (const id of remoteAck) {
    if (typeof id !== 'string' || !id.trim() || !submitted.has(id)) throw fault('INVALID_RESPONSE', '雲端 ACK 含非本次提交的事件');
    remoteSet.add(id);
  }
  for (const id of submitted) if (!remoteSet.has(id)) throw fault('INVALID_RESPONSE', '雲端批次未完整認列，未清除待送');
  // 本次提交的 eventIds 必須真正出現在 remote.recheckEvents，且內容不與本機衝突。
  const remoteEventsById = new Map((remote.recheckEvents || []).map((e) => [e.eventId, e]));
  const localEventsById = new Map((localEvents || []).map((e) => [e.eventId, e]));
  for (const id of submitted) {
    const remoteEv = remoteEventsById.get(id);
    if (!remoteEv) throw fault('INVALID_RESPONSE', 'ACK 認列了雲端未含的事件');
    const localEv = localEventsById.get(id);
    if (localEv && !sameRecheckPayload(localEv, remoteEv)) throw fault('EVENT_PAYLOAD_CONFLICT', 'ACK 事件與本機內容衝突');
  }
  return { version: ack.version, eventIds: submitted };
}

// 雲端採用／合併：remote 為 plan base。無 ack 是 pull、不清 pending；有 ack 只 ack 到 V，V+1 保留。
// local latest 於 RW 交易內重讀後合併，不覆寫 V+1；cloudRevision／lastSyncedAt 只在有效採用後更新、不倒退。
// remote.revision 小於目前 cloudRevision 時在任何 put 前拒收（零寫入）。
export async function adoptLearningRemote(ownerId, remote, { guard, ack } = {}) {
  ownerKey(ownerId);
  const validatedRemote = validateRemoteState(ownerId, remote);
  const ackValidated = ack != null ? { raw: ack } : null;
  return runTransaction(['attempts', 'dayPlans', RECHECK_STORE, SYNC_META_STORE], 'readwrite', ({ store, resolve, fail }) => {
    const readAll = (cb) => {
      const state = { plans: undefined, events: undefined, meta: undefined, attempt: undefined };
      const tryDone = () => { if (state.plans !== undefined && state.events !== undefined && state.meta !== undefined && state.attempt !== undefined) cb(state); };
      const plansReq = store('dayPlans').getAll();
      plansReq.onsuccess = () => { state.plans = plansReq.result.filter((p) => p.ownerId === ownerId); tryDone(); };
      const eventsReq = store(RECHECK_STORE).index('byOwner').getAll(ownerId);
      eventsReq.onsuccess = () => { state.events = eventsReq.result.filter((e) => e.ownerId === ownerId); tryDone(); };
      const metaReq = store(SYNC_META_STORE).get(ownerId);
      metaReq.onsuccess = () => { state.meta = metaReq.result ?? null; tryDone(); };
      const attemptReq = store('attempts').get(ownerId);
      attemptReq.onsuccess = () => { state.attempt = attemptReq.result ?? null; tryDone(); };
    };
    try {
      callGuard(guard);
      readAll(({ plans, events, meta: metaRaw, attempt }) => {
        try {
          callGuard(guard);
          const meta = normalizeMeta(metaRaw) || emptyMeta(ownerId);
          // 不倒退：remote.revision 不可小於目前已知 cloudRevision（零寫入）。
          if (validatedRemote.revision < meta.cloudRevision) throw fault('STALE_REVISION', '雲端版本較本機已知版本舊，未採用');
          // 交易內再驗 ack（version 不能超當前 dirty；eventIds 須真在 remote.recheckEvents、內容不與本機衝突）。
          const ackInfo = ackValidated ? validateAck(ownerId, ackValidated.raw, validatedRemote, meta.dirtyVersion, events) : null;
          const localState = { ownerId, revision: meta.cloudRevision, dayPlans: plans, recheckEvents: events };
          const remoteState = { ownerId, revision: validatedRemote.revision, dayPlans: validatedRemote.dayPlans, recheckEvents: validatedRemote.recheckEvents };
          // remote 為 plan base：mergeLearningState(local, remote) 以 remote 為 base，union 完成／證據。
          const merged = mergeLearningState(localState, remoteState);
          const localEventIds = new Set(events.map((e) => e.eventId));
          const finalPlans = merged.dayPlans.map((mp) => {
            const lp = plans.find((x) => x.localDate === mp.localDate);
            return { ...mp, revision: Math.max(lp?.revision ?? 0, mp.revision ?? 0) };
          });
          const newEvents = merged.recheckEvents.filter((e) => !localEventIds.has(e.eventId));
          writeEventsChecked(store(RECHECK_STORE), ownerId, newEvents, guard, () => {
            try {
              for (const p of finalPlans) store('dayPlans').put(p);
              const nowIso = new Date().toISOString();
              let nextMeta = { ...meta, cloudRevision: validatedRemote.revision, lastSyncedAt: nowIso };
              if (ackInfo) {
                const V = ackInfo.version;
                nextMeta.ackedVersion = Math.max(meta.ackedVersion, V);
                nextMeta.pendingEvents = meta.pendingEvents.filter((e) => e.version > V);
                nextMeta.pendingPlans = meta.pendingPlans.filter((p) => p.version > V);
              }
              store(SYNC_META_STORE).put(nextMeta);
              const diagnostic = attempt ?? nextMeta.diagnosticMeta;
              resolve(snapshotOf(ownerId, nextMeta, finalPlans, merged.recheckEvents, diagnostic));
            } catch (err) { fail(err); }
          }, fail);
        } catch (err) { fail(err); }
      });
    } catch (err) { fail(err); }
  });
}
