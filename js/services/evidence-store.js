// ============================================================
// 6.2.2 整合交付：分項作答證據的「本機、帳戶隔離」儲存層
//
// 【範圍】
//   只存 6.2.2 的分項證據事件（vocabulary／reading／cloze），全部在本機
//   IndexedDB；不連雲端、不寫正式 SQL、不改 SRS／每日任務／診斷資格。
//   跨裝置同步與正式後端由上游交付後另批接。
//
// 【為什麼 owner＋generation 要在 await 前後都驗】
//   A→B→A 情境：頁面以 A 身分讀取，中途登出再登入回 A。舊的 await 回來時
//   「owner 還是 A」但 generation 已經變了兩次——只比 owner 會讓舊結果汙染新頁。
//   因此每個寫入／讀取邊界都用 makeGuard().alive() 檢查 owner「且」generation。
//
// 【場次（session）＝一次模擬考 run】
//   舊版 ensureSession 只用 ownerId 當鍵，同一帳戶永遠共用一個「沒結束」的場次，
//   等於沒有場次語意。現在場次以呼叫端給的 sessionKey（＝owner＋runId）為鍵：
//    ・同一 run 的同一篇重答 → 同一個場次、同一個觀測單元 → 去重／只記 retake 審計
//    ・下一 run → 新 sessionKey → 新場次
//    ・run 結束時 endSession(sessionKey) 把場次收掉（endedAt）
//   場次是暫態資料；v1→v2 升級時只重建 sessions store，不動既有 events／pending。
//
// 【去重與衝突】
//   eventKey＝JSON.stringify([source, sourceId, eventId])（與彙整核心同一條 tuple），
//   eventId 由生產者用「場次＋場次執行 id＋來源單元」決定性組出，所以重整或重複
//   送同一批事件只會落一筆；內容不同時保留第一筆並回報 conflict，不靜默覆寫。
//
// 【提示（hinted）三態＋觀測來源 schema】
//   true／false＝已觀測；null＝上游沒給、未觀測。缺值一律不假填 false，
//   轉給彙整核心時由 toAggregateEvents 去掉 hinted 並標 HINT_NOT_OBSERVED
//   （核心契約只接受布林，未知不能冒充成「沒有提示」）。
//
//   【v1 舊資料的 false 不可升格成「確定沒有提示」】
//     v1（622-repair-input-v2）的 normalize 是 `hinted: raw.hinted === true`：
//     **沒有逐題名單時寫成 false**。升級到本版後，那個 false 若被當成「已觀測且沒有提示」，
//     等於舊資料替使用者作證；同一事件重送（本版給 null）還會被誤判成 conflict。
//     本版因此把「提示值的來源」寫進資料：
//       ・hintSchema=per-item-v2      本版生產者以逐題名單寫入（true／false 可信）
//       ・hintSchema=unknown-source-v2 本版寫入但呼叫端沒給逐題來源（布林不可信）
//       ・hintSchema=legacy-v1-default 舊版資料（原本沒有 schema 欄位；false 來自 v1 預設）
//     規則（不新增產品判定規則，只貫徹既有「未觀測＝null」）：
//       ・explicit true 一律保守保留（真有提示就照實記）。
//       ・false 只有在 hintSchema=per-item-v2 時才算「已觀測且沒有提示」；
//         其餘來源的 false 在彙整投影改成未知（拿掉 hinted＋HINT_NOT_OBSERVED
//         ＋HINT_OBSERVATION_UNVERIFIED），並在事件上留下可追溯的 schema／對帳紀錄。
//       ・原事件不覆寫：raw hinted 原值、量測值、firstAttempt 全部保留；
//         重送的提示表示差異只記一筆對帳（hintReconciliation），事件列數不膨脹。
//
// 【失敗保存】
//   寫入失敗（配額、DB 被鎖、私密模式）不得回假成功：saveEventSafely 會把事件
//   放進 pending 佇列並回 {ok:false, code:'WRITE_FAILED'}，由結果頁顯示「未保存」
//   並提供重試。
//
// 【開檔／升級（見 openDatabase）】
//   ・被別的頁的舊連線擋住（blocked）→ 明確錯誤 DB_BLOCKED（retryable:true），
//     不是永遠 pending；那個遲到的連線會立刻 close()，不留洩漏的連線。
//   ・開檔失敗不進快取（dbPromise 會清掉）→ 同一個 store 實例可以真的重試，
//     不會永遠拿到同一個 rejected promise。
//   ・versionchange（別的頁升級或刪除本 DB）→ 主動關掉自己的連線並作廢快取，
//     下一個操作自動重開；不會拿著已關閉的連線拋 InvalidStateError。
// ============================================================
import { SECTION_KEYS, eventKey, unitKey } from '../core/evidence-aggregate.js';

export const DB_NAME = 'vocab2_exam_evidence_622';
export const DB_VERSION = 2;
export const STORE_EVENTS = 'events';
export const STORE_SESSIONS = 'sessions';
export const STORE_PENDING = 'pendingEvents';

// 提示未觀測的代碼：缺值不是「沒有提示」，而是「看不到」。
export const HINT_NOT_OBSERVED = 'HINT_NOT_OBSERVED';

// 提示值的來源 schema（見檔頭說明）。這三個值只描述「hinted 是怎麼來的」，不改變提示的判定規則。
export const HINT_SCHEMA = 'per-item-v2';
export const HINT_SCHEMA_UNKNOWN = 'unknown-source-v2';
export const HINT_SCHEMA_LEGACY = 'legacy-v1-default';

// 舊資料／無逐題觀測來源的 false 只能算「觀測不確定」，不能算「確定沒有提示」。
export const HINT_OBSERVATION_UNVERIFIED = 'HINT_OBSERVATION_UNVERIFIED';

// 提示訊號：這些 missing code 與 hinted 本身只表示「提示狀態的表示法」，不是作答內容。
// 同一事件重送時若只有這些差異，不算內容衝突（不覆寫原事件，改記一筆對帳）。
const HINT_SIGNAL_CODES = new Set([HINT_NOT_OBSERVED, HINT_OBSERVATION_UNVERIFIED]);

function missingCodeOf(entry) {
  if (typeof entry === 'string') return entry.trim();
  return entry && typeof entry === 'object' ? (nonEmpty(entry.code) || null) : null;
}

// 去掉「提示表示法」後的內容（hinted／提示相關 missing／schema 標記都不算作答內容）。
// 只用來判斷「同一事件重送的差異是不是只有提示表示法」，不改動任何實際寫入的值。
function withoutHintSignals(event) {
  const copy = { ...event };
  delete copy.hinted;
  delete copy.hintSchema;
  delete copy.hintReconciliation;
  copy.missing = (Array.isArray(copy.missing) ? copy.missing : [])
    .filter((entry) => !HINT_SIGNAL_CODES.has(missingCodeOf(entry)));
  return copy;
}

function hintSignalsEqual(a, b) {
  return JSON.stringify(withoutHintSignals(a)) === JSON.stringify(withoutHintSignals(b));
}

const SECTION_SET = new Set(SECTION_KEYS);

function fault(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function requireOwner(ownerId) {
  if (typeof ownerId !== 'string' || !ownerId.trim()) {
    throw fault('UNAUTHENTICATED', '請先登入再保存分項證據');
  }
  return ownerId;
}

// 場次 id 由場次鍵決定性導出：同一個 run 重送／重開都拿到同一個 sessionId，
// 不同 run（不同鍵）一定不同——不會因為同一毫秒＋同樣亂數而撞號。
export function sessionIdOf(sessionKey) {
  let hash = 5381;
  for (let i = 0; i < sessionKey.length; i += 1) hash = ((hash * 33) ^ sessionKey.charCodeAt(i)) >>> 0;
  return `s-${hash.toString(36)}-${sessionKey.length.toString(36)}`;
}

function requireSessionKey(sessionKey) {
  const key = nonEmpty(sessionKey);
  if (!key) {
    throw fault('INVALID_SESSION_KEY', '需要場次鍵（sessionKey）：本機一場模擬考＝一個場次，不能用永久共用場次');
  }
  return key;
}

function nullableCount(value, name) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw fault('INVALID_MEASURE', `${name} 必須是非負整數或 null`);
  }
  return value;
}

function normalizeMeasure(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw fault('INVALID_MEASURE', 'measure 必須是物件或 null');
  const numerator = nullableCount(raw.numerator, 'measure.numerator');
  const denominator = nullableCount(raw.denominator, 'measure.denominator');
  const itemCount = nullableCount(raw.itemCount, 'measure.itemCount');
  const passageCount = nullableCount(raw.passageCount, 'measure.passageCount');
  let coverage = null;
  if (raw.coverage != null) {
    if (typeof raw.coverage !== 'object' || Array.isArray(raw.coverage)) {
      throw fault('INVALID_COVERAGE', 'coverage 必須是物件或 null');
    }
    const attempted = nullableCount(raw.coverage.attempted, 'coverage.attempted');
    const available = nullableCount(raw.coverage.available, 'coverage.available');
    if (attempted == null || available == null) {
      throw fault('INVALID_COVERAGE', 'coverage 必須同時提供 attempted 與 available');
    }
    if (attempted > available) throw fault('INVALID_COVERAGE', 'coverage.attempted 不可大於 available');
    coverage = { attempted, available };
  }
  const hasNumerator = numerator != null;
  const hasDenominator = denominator != null;
  if (hasNumerator !== hasDenominator) throw fault('INVALID_MEASURE', '分子與分母必須同時提供，或同時留 null');
  if (hasDenominator && denominator === 0) throw fault('INVALID_MEASURE', '分母必須大於 0');
  if (hasNumerator && hasDenominator && numerator > denominator) {
    throw fault('INVALID_MEASURE', '分子不可大於分母');
  }
  return { numerator, denominator, itemCount, passageCount, coverage };
}

function normalizeMissing(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw fault('INVALID_MISSING', 'missing 必須是陣列');
  return raw.map((entry) => {
    if (typeof entry === 'string' && entry.trim()) return { code: entry.trim(), detail: null };
    if (entry && typeof entry === 'object' && nonEmpty(entry.code)) {
      return { code: entry.code.trim(), detail: nonEmpty(entry.detail) };
    }
    throw fault('INVALID_MISSING', 'missing 項目必須是非空字串或含 code 的物件');
  });
}

/** hinted 三態：true／false＝已觀測；null／缺值＝未觀測（絕不假填 false）。 */
function normalizeHinted(raw) {
  if (raw === true || raw === false) return raw;
  if (raw == null) return null;
  throw fault('INVALID_HINTED', 'hinted 只能是 true／false，或省略／null 表示未觀測');
}

/**
 * 正規化並驗證一筆證據事件；owner 不符一律拒絕（跨 owner 不落地）。
 * 回傳的 event 欄位順序固定，供 canonical 比對／去重使用。
 */
export function normalizeEvidenceEvent(ownerId, raw) {
  requireOwner(ownerId);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fault('INVALID_EVENT', '證據事件必須是物件');
  const evOwner = nonEmpty(raw.ownerId);
  if (!evOwner) throw fault('INVALID_OWNER', '事件缺少 ownerId');
  if (evOwner !== ownerId) throw fault('OWNER_MISMATCH', '事件帳戶與目前帳戶不符，未寫入');
  const eventId = nonEmpty(raw.eventId);
  if (!eventId) throw fault('INVALID_EVENT_ID', '事件缺少 eventId');
  const section = nonEmpty(raw.section);
  if (!section || !SECTION_SET.has(section)) {
    throw fault('INVALID_SECTION', `section 必須是 ${SECTION_KEYS.join('／')}`);
  }
  const sessionId = nonEmpty(raw.sessionId);
  if (!sessionId) throw fault('INVALID_SESSION', '事件缺少 sessionId');
  if (!Number.isFinite(raw.occurredAt) || raw.occurredAt < 0) {
    throw fault('INVALID_OCCURRED_AT', 'occurredAt 必須是有限非負數（epoch ms）');
  }
  const source = nonEmpty(raw.provenance?.source);
  const sourceId = nonEmpty(raw.provenance?.sourceId);
  if (!source || !sourceId) throw fault('MISSING_PROVENANCE', 'provenance 必須含 source 與 sourceId');
  const revision = nonEmpty(raw.provenance?.revision);
  const capturedAt = Number.isFinite(raw.provenance?.capturedAt) && raw.provenance.capturedAt >= 0
    ? raw.provenance.capturedAt
    : null;
  const event = {
    eventId,
    ownerId,
    section,
    sessionId,
    occurredAt: raw.occurredAt,
    provenance: { source, sourceId, revision, capturedAt },
    measure: normalizeMeasure(raw.measure),
    hinted: normalizeHinted(raw.hinted),
    hintSchema: normalizeHintSchema(raw.hintSchema),
    missing: normalizeMissing(raw.missing),
  };
  return { event, eventKey: eventKey(event), unitKey: unitKey(event) };
}

/**
 * 保留已知來源標記；只有 per-item-v2 能讓 false 被視為已觀測。
 * unknown 與 legacy 的差別只用來追溯，不會把未知升格為「確定無提示」。
 */
function normalizeHintSchema(raw) {
  return [HINT_SCHEMA,HINT_SCHEMA_UNKNOWN,HINT_SCHEMA_LEGACY].includes(raw) ? raw : null;
}

/**
 * 事件裡的提示狀態可不可信（＝有沒有可證明的逐題提示觀測來源）。
 *   observed   hinted 是布林且來源寫明是逐題名單；或 explicit true（保守保留）
 *   unverified hinted=false 但來源不可證明（v1 舊資料／呼叫端沒給名單）
 *   unobserved 根本沒有觀測值（null／缺值）
 * 注意：這裡只表達「這個值可不可以當成已觀測」，不推論有沒有提示。
 */
export function hintTrustOf(event) {
  const hinted = event?.hinted;
  if (hinted === true) return 'observed';
  if (hinted === false) return event?.hintSchema === HINT_SCHEMA ? 'observed' : 'unverified';
  return 'unobserved';
}

/**
 * 把本機儲存的事件轉成 6.2.2 彙整核心的契約。
 * 核心只接受布林 hinted（未知不合法），所以「未觀測」必須拿掉 hinted 欄位，
 * 並在 missing 標上 HINT_NOT_OBSERVED——下游才知道這是觀測限制，而不是「確定沒有提示」。
 *
 * 【v1 舊資料的 false／沒有逐題來源的 false】
 *   hinted=false 只有在 hintSchema=per-item-v2（真的有名單）時才原樣傳給核心；
 *   其餘的 false 一律改投影成未知（HINT_NOT_OBSERVED ＋ HINT_OBSERVATION_UNVERIFIED），
 *   並在 detail 寫明「觀測不確定，不推定為沒有提示」。explicit true 保守保留。
 *   這裡只改「表示法」，不改任何量測值、不改第一筆的內容。
 */
export function toAggregateEvents(events) {
  const list = Array.isArray(events) ? events : [];
  return list.map((event) => {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return event;
    const trust = hintTrustOf(event);
    if (trust === 'observed') return event;
    const rest = { ...event };
    delete rest.hinted;
    const missing = Array.isArray(rest.missing) ? [...rest.missing] : [];
    const hasCode = (code) => missing.some((entry) => missingCodeOf(entry) === code);
    if (!hasCode(HINT_NOT_OBSERVED)) {
      missing.push({
        code: HINT_NOT_OBSERVED,
        detail: trust === 'unverified'
          ? '舊資料（或沒有逐題提示觀測來源）的提示狀態不可當成「沒有提示」：提示未觀測'
          : '上游未提供提示狀態：提示未觀測，不推定為沒有提示',
      });
    }
    if (trust === 'unverified' && !hasCode(HINT_OBSERVATION_UNVERIFIED)) {
      missing.push({
        code: HINT_OBSERVATION_UNVERIFIED,
        detail: '這個提示值是舊版預設（或來源不明）寫下的 false，沒有可證明的逐題觀測來源，'
          + '只能算觀測不確定；原值保留在事件裡，不改寫歷史。',
      });
    }
    rest.missing = missing;
    return rest;
  });
}

// ---------- IndexedDB 基礎 ----------
/**
 * 開啟本機 DB。
 *
 * 【為什麼一定要處理 onblocked／onversionchange／失敗快取】
 *   ① 別的頁（或別的 store 實例）還握著舊版本連線時，這次升級會被「擋住」：
 *      瀏覽器在這種情況下只發 blocked 事件，open 請求本身既不成功也不失敗。
 *      舊版沒有 onblocked → Promise 永遠 pending，呼叫端（成績頁寫入、結果頁讀取）
 *      就永遠等不到結果，看起來像「卡住」而不是「失敗可重試」。
 *      現在 blocked 一律回一個明確、可重試的錯誤（DB_BLOCKED），呼叫端可以顯示
 *      「請關閉其他分頁後重試」並真的重試。
 *   ② 被擋住的那個 open 請求並不會取消：舊連線關掉之後它仍會成功。
 *      這條遲到的連線沒有人會用（我們已經回錯誤了），所以一旦 onsuccess 進來
 *      而這個 Promise 已經結算過，就立刻 close()，避免洩漏一條沒人關的連線
 *      （洩漏的連線會讓其他頁的升級／刪除永遠卡在 blocked）。
 *   ③ 版本被其他頁升級／刪除時（versionchange）要主動關掉自己的連線，
 *      否則對方會一直 blocked；同時通知上層作廢連線快取，下一個操作重開。
 */
function openDatabase(idb, { onVersionChange } = {}) {
  return new Promise((resolve, reject) => {
    let req;
    let settled = false;
    // 三個 settle 出口共用：先到者決定結果，後到的只做善後（關連線）。
    const fail = (code, message, cause) => {
      if (settled) return;
      settled = true;
      const err = fault(code, message);
      if (cause) err.cause = cause;
      reject(err);
    };
    try {
      req = idb.open(DB_NAME, DB_VERSION);
    } catch (err) {
      fail('OPEN_FAILED', `無法開啟本機證據資料庫：${err?.message || err}`, err);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_EVENTS)) {
        const store = db.createObjectStore(STORE_EVENTS, { keyPath: ['ownerId', 'eventKey'] });
        store.createIndex('byOwner', 'ownerId');
        store.createIndex('byOwnerUnit', ['ownerId', 'unitKey']);
      }
      // v1 的 sessions 以 ownerId 為鍵（永久共用場次）；v2 改以 sessionKey 為鍵。
      // 場次是暫態資料，結構不合就重建；既有 events／pending 不動。
      if (db.objectStoreNames.contains(STORE_SESSIONS)) {
        const existing = req.transaction.objectStore(STORE_SESSIONS);
        const keyPath = existing.keyPath;
        const legacyKeyPath = Array.isArray(keyPath) ? keyPath.join(',') === 'ownerId' : keyPath === 'ownerId';
        if (legacyKeyPath) db.deleteObjectStore(STORE_SESSIONS);
      }
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        const sessions = db.createObjectStore(STORE_SESSIONS, { keyPath: 'sessionKey' });
        sessions.createIndex('byOwner', 'ownerId');
      }
      if (!db.objectStoreNames.contains(STORE_PENDING)) {
        const pending = db.createObjectStore(STORE_PENDING, { keyPath: ['ownerId', 'eventKey'] });
        pending.createIndex('byOwner', 'ownerId');
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // 版本被其他頁升級／刪除：關掉自己的連線並讓上層作廢快取（否則對方一直 blocked）。
      db.onversionchange = () => {
        try { db.close(); } catch { /* 已關閉 */ }
        if (typeof onVersionChange === 'function') {
          try { onVersionChange(); } catch { /* 上層作廢失敗不影響關閉連線 */ }
        }
      };
      if (settled) {
        // 已經回過 DB_BLOCKED／錯誤的遲到連線：沒有人會用它，立刻關掉避免洩漏。
        try { db.close(); } catch { /* 已關閉 */ }
        return;
      }
      settled = true;
      resolve(db);
    };
    req.onerror = () => {
      const err = req.error;
      fail('OPEN_FAILED', `無法開啟本機證據資料庫：${err?.message || err || '未知錯誤'}`, err);
    };
    // 舊連線擋住升級：明確失敗（可重試），不要讓 Promise 永遠 pending。
    req.onblocked = () => {
      const err = fault(
        'DB_BLOCKED',
        '本機證據資料庫正被其他分頁（或舊連線）使用，升級被擋住；請關閉其他分頁後重試',
      );
      err.retryable = true;
      if (settled) return;
      settled = true;
      reject(err);
    };
  });
}

/** 對外看到的錯誤碼語意：這些是「可重試」，不是資料格式錯誤。 */
const RETRYABLE_OPEN_CODES = new Set(['DB_BLOCKED', 'OPEN_FAILED']);

export function isRetryableOpenError(err) {
  return Boolean(err && (err.retryable === true || RETRYABLE_OPEN_CODES.has(err.code)));
}

function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || fault('TX_ABORTED', '交易中止'));
    tx.onerror = () => reject(tx.error || fault('TX_ERROR', '交易失敗'));
  });
}

// ---------- 守衛（owner＋generation） ----------
/**
 * 建立守衛。ownerId／generation 是「進場當時」的值；getOwnerId／getGeneration
 * 是讀取當下的值。alive() 必須同時成立才算同一頁同一帳戶。
 */
export function makeGuard({ ownerId, generation, getOwnerId, getGeneration }) {
  return {
    ownerId,
    generation,
    alive() {
      if (typeof ownerId !== 'string' || !ownerId.trim()) return false;
      if (typeof getOwnerId === 'function' && getOwnerId() !== ownerId) return false;
      if (typeof getGeneration === 'function' && getGeneration() !== generation) return false;
      return true;
    },
  };
}

export function assertAlive(guard, message = '帳戶或頁面已變更，已停止本次操作') {
  if (!guard || typeof guard.alive !== 'function') return;
  if (!guard.alive()) throw fault('STALE_ACCOUNT', message);
}

// ---------- 儲存層 ----------
// random 僅保留簽名相容（場次 id 已改由 sessionKey 決定性導出，不再依賴亂數）。
export function createEvidenceStore({ indexedDB: idb = globalThis.indexedDB, now = () => Date.now(), random = Math.random } = {}) {
  void random;
  let dbPromise = null;
  let activeToken = null;
  const open = () => {
    if (!idb) return Promise.reject(fault('NO_INDEXEDDB', '此環境沒有 IndexedDB，無法保存分項證據'));
    if (!dbPromise) {
      // token 用來判斷「versionchange 講的是不是現在快取的那一條連線」：
      // 舊連線作廢後才不會把之後新開的連線一起清掉。
      const token = {};
      activeToken = token;
      const attempt = openDatabase(idb, {
        onVersionChange: () => {
          if (activeToken === token) {
            activeToken = null;
            dbPromise = null; // 快取作廢：下一個操作重開（不會拿著已關閉的連線）
          }
        },
      }).catch((err) => {
        // 失敗不留在快取：blocked／open 失敗之後呼叫端可以真的重試，而不是永遠拿到同一個 rejected promise。
        if (dbPromise === attempt) {
          activeToken = null;
          dbPromise = null;
        }
        throw err;
      });
      dbPromise = attempt;
    }
    return dbPromise;
  };

  async function saveSession(ownerId, session) {
    requireOwner(ownerId);
    const sessionKey = requireSessionKey(session?.sessionKey);
    const db = await open();
    const tx = db.transaction([STORE_SESSIONS], 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore(STORE_SESSIONS).put({ ...session, sessionKey, ownerId });
    await done;
    return { ...session, sessionKey, ownerId };
  }

  async function getSession(sessionKey) {
    const key = requireSessionKey(sessionKey);
    const db = await open();
    const tx = db.transaction([STORE_SESSIONS], 'readonly');
    const record = await requestPromise(tx.objectStore(STORE_SESSIONS).get(key));
    await transactionDone(tx).catch(() => {});
    return record || null;
  }

  /**
   * 取得（或在需要時建立）某個場次。sessionKey 必填：
   * 「一場模擬考 run ＝ 一個場次」，同一 run 重送回同一個 sessionId，下一 run 一定是新場次。
   */
  async function ensureSession(ownerId, { sessionKey, forceNew = false } = {}) {
    requireOwner(ownerId);
    const key = requireSessionKey(sessionKey);
    const db = await open();
    const tx = db.transaction([STORE_SESSIONS], 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore(STORE_SESSIONS);
    const current = await requestPromise(store.get(key));
    if (current && current.ownerId !== ownerId) {
      try { tx.abort(); } catch { /* 已中止 */ }
      await done.catch(() => { /* abort 的拒絕在此收掉，避免未處理的 rejection */ });
      throw fault('SESSION_OWNER_MISMATCH', '場次鍵屬於另一個帳戶，未沿用');
    }
    if (current && !current.endedAt && !forceNew) {
      await done;
      return { ...current };
    }
    if (current?.endedAt && !forceNew) {
      // 已結束的場次不得被沿用：一場 run 就只有一場；下一場請用新的場次鍵（下一個 run）。
      await done;
      throw fault('SESSION_ENDED', '這個場次已結束，不能用同一個場次鍵再寫入（下一場請用新的 run）');
    }
    const startedAt = now();
    const siblings = await requestPromise(store.index('byOwner').getAll(ownerId));
    const previous = (siblings || []).filter((row) => row.sessionKey !== key)
      .sort((a, b) => b.startedAt - a.startedAt)[0] || null;
    const session = {
      sessionKey: key,
      ownerId,
      sessionId: sessionIdOf(key),
      startedAt,
      endedAt: null,
      previousSessionId: current?.sessionId ?? previous?.sessionId ?? null,
    };
    store.put(session);
    await done;
    return { ...session };
  }

  /** 結束某個場次：之後同一 sessionKey 再寫入會開新場次（呼叫端正常不會再寫）。 */
  async function endSession(sessionKey) {
    const key = requireSessionKey(sessionKey);
    const db = await open();
    const tx = db.transaction([STORE_SESSIONS], 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore(STORE_SESSIONS);
    const current = await requestPromise(store.get(key));
    if (current && !current.endedAt) {
      store.put({ ...current, endedAt: now() });
    }
    await done;
    return true;
  }

  /**
   * 寫入一筆證據事件（冪等）。回傳：
   *   stored    首次寫入
   *   duplicate 同 eventKey、內容相同（重整／重送）
   *   conflict  同 eventKey、內容不同（保留第一筆，不覆寫）
   * 例外：既有那筆的 hinted 來源不可證明（v1 舊資料／沒有逐題名單）時，重送的提示表示法
   * 差異不算內容衝突——原事件不覆寫，只記一筆可追溯的對帳（hintReconciliation），
   * 回傳仍是 duplicate（事件列數不膨脹，分子分母不重複計入）。
   * owner 不符或格式不合法一律丟錯，不落地。
   *
   * hintSchema：呼叫端可指明這批 hinted 的來源（例如重放 v1 pending 時標 legacy）。
   */
  async function saveEvent(ownerId, raw, { hintSchema = null } = {}) {
    const { event, eventKey: key, unitKey: unit } = normalizeEvidenceEvent(ownerId, raw);
    const db = await open();
    const tx = db.transaction([STORE_EVENTS], 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore(STORE_EVENTS);
    const existing = await requestPromise(store.get([ownerId, key]));
    if (existing) {
      const same = JSON.stringify(existing.event) === JSON.stringify(event);
      if (same) {
        await done;
        return {
          status: 'duplicate',
          eventKey: key,
          unitKey: unit,
          keptEventId: existing.event.eventId,
        };
      }
      // 只有提示表示法不同，且既有那筆的提示來源不可證明 → 對帳，不覆寫、不算衝突。
      if (hintSignalsEqual(existing.event, event) && hintTrustOf(existing.event) !== 'observed') {
        const previous = existing.hintReconciliation || null;
        const record = {
          code: HINT_OBSERVATION_UNVERIFIED,
          storedHinted: existing.event.hinted === undefined ? null : existing.event.hinted,
          receivedHinted: event.hinted,
          storedSchema: existing.hintSchema ?? existing.event?.hintSchema ?? HINT_SCHEMA_LEGACY,
          receivedSchema: event.hintSchema ?? null,
          firstAt: previous?.firstAt ?? now(),
          lastAt: now(),
          count: (previous?.count ?? 0) + 1,
        };
        // 只補對帳欄位：raw event（含 hinted:false 原值與量測值）一個 byte 都不改。
        store.put({ ...existing, hintReconciliation: record });
        await done;
        return {
          status: 'duplicate',
          eventKey: key,
          unitKey: unit,
          keptEventId: existing.event.eventId,
          hintReconciled: HINT_OBSERVATION_UNVERIFIED,
          hintReconciliation: record,
        };
      }
      await done;
      return {
        status: 'conflict',
        eventKey: key,
        unitKey: unit,
        keptEventId: existing.event.eventId,
      };
    }
    store.put({
      ownerId,
      eventKey: key,
      unitKey: unit,
      eventId: event.eventId,
      section: event.section,
      sessionId: event.sessionId,
      source: event.provenance.source,
      sourceId: event.provenance.sourceId,
      occurredAt: event.occurredAt,
      // 可追溯的來源 schema：沒有 per-item-v2 標記的布林值不可當成已觀測。
      // 本版新寫入至少記 unknown；只有真正缺標記的歷史列才由decorate辨為legacy。
      hintSchema: normalizeHintSchema(hintSchema) ?? event.hintSchema ?? HINT_SCHEMA_UNKNOWN,
      event,
    });
    await done;
    return { status: 'stored', eventKey: key, unitKey: unit, keptEventId: event.eventId };
  }

  /**
   * 讀出事件（含可追溯的提示來源）：
   *   ・hintSchema：這個 hinted 值來自哪裡（per-item-v2／unknown-source-v2／legacy-v1-default／null）
   *   ・hintReconciliation：舊資料與重送的提示表示法對帳紀錄（只有發生過才出現）
   * 事件本身的 raw 值（含 v1 留下的 hinted:false）一個 byte 都不改。
   */
  function decorate(row) {
    const event = { ...row.event };
    event.hintSchema = row.hintSchema ?? row.event?.hintSchema ?? null;
    if (row.hintSchema == null && event.hintSchema == null && event.hinted === false) {
      // v1 的欄位裡沒有 schema：那次 false 來自 v1 預設，不是逐題觀測。
      event.hintSchema = HINT_SCHEMA_LEGACY;
    }
    if (row.hintReconciliation) event.hintReconciliation = row.hintReconciliation;
    return event;
  }

  async function listEvents(ownerId) {
    requireOwner(ownerId);
    const db = await open();
    const tx = db.transaction([STORE_EVENTS], 'readonly');
    const rows = await requestPromise(tx.objectStore(STORE_EVENTS).index('byOwner').getAll(ownerId));
    await transactionDone(tx).catch(() => {});
    return rows
      .filter((row) => row.ownerId === ownerId)
      .map((row) => decorate(row))
      .sort((a, b) => a.occurredAt - b.occurredAt || a.eventId.localeCompare(b.eventId));
  }

  async function listUnitEvents(ownerId, unit) {
    requireOwner(ownerId);
    if (!nonEmpty(unit)) throw fault('INVALID_UNIT', '缺少觀測單元 key');
    const db = await open();
    const tx = db.transaction([STORE_EVENTS], 'readonly');
    const rows = await requestPromise(tx.objectStore(STORE_EVENTS).index('byOwnerUnit').getAll([ownerId, unit]));
    await transactionDone(tx).catch(() => {});
    return rows.filter((row) => row.ownerId === ownerId).map((row) => decorate(row));
  }

  // ---------- 失敗保存（pending 佇列） ----------
  async function queuePending(ownerId, raw, error, { hintSchema = null } = {}) {
    const { event, eventKey: key } = normalizeEvidenceEvent(ownerId, raw);
    const db = await open();
    const tx = db.transaction([STORE_PENDING], 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore(STORE_PENDING);
    const existing = await requestPromise(store.get([ownerId, key]));
    const attempts = (existing?.attempts ?? 0) + 1;
    store.put({
      ownerId,
      eventKey: key,
      attempts,
      at: now(),
      error: String(error?.message || error || '未知錯誤').slice(0, 200),
      // 待寫佇列也要記來源：v1 的 pending 沒有這個欄位，重放時標 legacy，不把 false 升格。
      hintSchema: hintSchema ?? event.hintSchema ?? existing?.hintSchema ?? HINT_SCHEMA_UNKNOWN,
      event,
    });
    await done;
    return { queued: true, attempts };
  }

  async function listPending(ownerId) {
    requireOwner(ownerId);
    const db = await open();
    const tx = db.transaction([STORE_PENDING], 'readonly');
    const rows = await requestPromise(tx.objectStore(STORE_PENDING).index('byOwner').getAll(ownerId));
    await transactionDone(tx).catch(() => {});
    return rows
      .filter((row) => row.ownerId === ownerId)
      .map((row) => ({
        eventKey: row.eventKey,
        attempts: row.attempts,
        at: row.at,
        error: row.error,
        hintSchema: row.hintSchema ?? HINT_SCHEMA_LEGACY,
        event: row.event,
      }))
      .sort((a, b) => a.at - b.at);
  }


  async function dropPending(ownerId, key) {
    requireOwner(ownerId);
    const db = await open();
    const tx = db.transaction([STORE_PENDING], 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore(STORE_PENDING).delete([ownerId, key]);
    await done;
    return true;
  }

  /**
   * 帶守衛的寫入：await 前後都檢查 owner＋generation。
   * 寫入失敗時放進 pending 並回報失敗（絕不假成功）；stale 時回 STALE_ACCOUNT。
   */
  async function saveEventSafely(ownerId, raw, { guard, hintSchema = null } = {}) {
    try {
      assertAlive(guard);
      const result = await saveEvent(ownerId, raw, { hintSchema });
      if (guard && !guard.alive()) {
        return { ok: false, code: 'STALE_ACCOUNT', storedInBackground: true, ...result };
      }
      return { ok: true, ...result };
    } catch (err) {
      if (err.code === 'OWNER_MISMATCH' || err.code === 'INVALID_EVENT' || err.code === 'INVALID_SECTION'
        || err.code === 'INVALID_MEASURE' || err.code === 'INVALID_COVERAGE' || err.code === 'MISSING_PROVENANCE'
        || err.code === 'INVALID_OWNER' || err.code === 'INVALID_EVENT_ID' || err.code === 'INVALID_SESSION'
        || err.code === 'INVALID_OCCURRED_AT' || err.code === 'INVALID_MISSING' || err.code === 'UNAUTHENTICATED'
        || err.code === 'INVALID_HINTED') {
        return { ok: false, code: err.code, error: err.message };
      }
      if (err.code === 'STALE_ACCOUNT') return { ok: false, code: 'STALE_ACCOUNT', error: err.message };
      // 開不了 DB（被別的頁擋住／開檔失敗）：這是可重試的環境問題，不是事件格式問題；
      // 連 DB 都開不了時 pending 佇列同樣寫不進去，所以不假裝「已排入待寫」。
      if (isRetryableOpenError(err)) {
        return {
          ok: false, code: err.code, retryable: true, pending: false, error: err.message,
        };
      }
      // 真正的寫入失敗（配額／被鎖／私密模式）→ 保留在 pending，回報未保存
      let queued = false;
      try {
        await queuePending(ownerId, raw, err, { hintSchema });
        queued = true;
      } catch { queued = false; }
      return { ok: false, code: 'WRITE_FAILED', pending: queued, error: String(err.message || err) };
    }
  }

  /**
   * 重試 pending 佇列；成功（含 duplicate／conflict）即移除。
   * v1 留下來的 pending 沒有 hintSchema 欄位 → 以 legacy 身分重放：
   * raw hinted 原值保留，該 false 在彙整投影仍算「觀測不確定」，不升格成已觀測。
   */
  async function flushPending(ownerId, { guard } = {}) {
    requireOwner(ownerId);
    assertAlive(guard);
    const rows = await listPending(ownerId);
    const result = { flushed: 0, failed: 0, remaining: rows.length, failedCodes: [] };
    for (const row of rows) {
      const saved = await saveEventSafely(ownerId, row.event, {
        guard,
        hintSchema: row.hintSchema ?? HINT_SCHEMA_LEGACY,
      });
      if (saved.ok) {
        await dropPending(ownerId, row.eventKey);
        result.flushed += 1;
      } else {
        result.failed += 1;
        result.failedCodes.push(saved.code);
      }
    }
    if (guard && !guard.alive()) throw fault('STALE_ACCOUNT', '帳戶或頁面已變更，已停止重試');
    result.remaining = (await listPending(ownerId)).length;
    return result;
  }

  async function close() {
    if (!dbPromise) { activeToken = null; return; }
    const current = dbPromise;
    dbPromise = null;
    activeToken = null;
    try { (await current).close(); } catch { /* noop */ }
  }

  return {
    ensureSession,
    endSession,
    saveSession,
    getSession,
    saveEvent,
    saveEventSafely,
    listEvents,
    listUnitEvents,
    listPending,
    flushPending,
    dropPending,
    close,
  };
}
