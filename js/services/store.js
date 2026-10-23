// ============================================================
// 使用者資料保存（IndexedDB，本機瀏覽器內）
// 2.0.2：不會單字標記；2.0.5：SRS 排程；2.0.8：具名單詞本
// 2.0.10：單詞本 id 遷移為 UUID（跨裝置同步不衝突）
// 2.0.13：學習事件記錄（統計用）
// 4.2.0：寫入成功後 emit('store:changed', {kind})，供 15 秒即時同步去抖上傳
//   （選 eventbus 而非 document CustomEvent：本專案的跨模組通訊一律走 core/eventbus.js，
//    見 core/eventbus.js 檔頭說明；addEvent 刻意不 emit——events 不進雲端備份且高頻）
// 5.0.0：單詞本新增 pendingWords（字庫外字＝待補清單），字庫收錄後由 fillPendingWordbooks 自動補進
// 6.2.0：**帳戶隔離**（見下方「owner 分區」一節）
// ============================================================
//
// 【owner 分區（6.2.0）】
//   舊版（2.0.x～6.1.x）的資料庫 vocab2（DB_VERSION 7）裡的 marks／wordbooks／groups／
//   events／examMistakes 都**沒有 owner 欄位**：同一個瀏覽器換帳號時資料是共用的，
//   A 的收藏與複習排程會出現在 B 的畫面。
//   本版改成：
//     · 新資料一律寫入新資料庫 vocab2_owner（v1），每筆記錄的 key 是 [ownerId, id]，
//       同一 object store 內以 ownerId 前綴分區；查詢一律走該 owner 的 key range／前綴，
//       不是在讀取結果才 filter（避免「先撈別人的再篩掉」這種洩漏路徑）。
//     · ownerId 由 services/owner-context.js 提供（auth.js 在 session 邊界推入）；
//       本檔**不 import auth.js**——那會造成 auth → sync → store → auth 循環相依。
//     · 未登入時 owner＝'guest'，訪客自成一個獨立分區，不與任何帳戶共用。
//     · 既有 vocab2 舊資料**完整保留、不改不刪不清、不自動改到期日**：
//       本檔對舊庫只提供唯讀盤點（listUnclaimedLegacy），不做任何自動歸屬。
//       「舊資料算誰的」是產品決策，尚未定案 → 一律視為未認領，不預設給當前帳戶或 guest。
//
// 【守衛（await 後／真正提交前）】
//   每個寫入都在開始時 captureOwner()，並在
//     ① 交易內讀到資料之後、② 真正 put／delete 之前 各驗一次 owner＋generation。
//   等待期間換帳戶／登出／同一帳戶重新登入（generation 變）→ 交易 abort、如實 reject，
//   不會有「一半寫進 A、一半寫進 B」或「舊請求回包寫進新帳戶」。
//   前端這個守衛只防本機分區污染，**不構成伺服器授權**（權限仍在 Supabase RLS／RPC）。
// ============================================================
import { emit } from '../core/eventbus.js';
import { wordIndex } from './search.js';
// 5.0.x：複習強度三段的天數集中定義在 services/settings.js（使用者偏好層），
// 本檔（資料層）只負責讀它並套用——天數不在此處散落。
import {
  getReviewStrength, REVIEW_STRENGTHS, getSrsAlgorithm, getFsrsRetention,
} from './settings.js';
import {
  FSRS_ENGINE, isFsrsEngine, newFsrsState, previewFsrs, applyFsrsReview,
  normalizeMarkRecords, normalizeFsrsState, parseValidDate,
} from '../core/fsrs-engine.js';
import { captureOwner, getOwnerId, GUEST_OWNER } from './owner-context.js';

// 舊資料庫：只讀盤點用（6.2.0 起本檔不再寫入它）
export const LEGACY_DB = { name: 'vocab2', version: 7 };

// 新的 owner 分區資料庫：key＝[ownerId, id]，一庫多帳戶分區
export const OWNER_DB = {
  name: 'vocab2_owner',
  version: 1,
  marks: 'marks',           // key [owner, wordId] → { ownerId, wordId, addedAt, stage, dueAt, engine?, fsrsState? }
  wordbooks: 'wordbooks',   // key [owner, id(uuid)] → { ownerId, id, name, wordIds[], pendingWords?, groupId?, sort?, endedAt, lastPracticedAt }
  groups: 'groups',         // key [owner, id(uuid)] → { ownerId, id, name, order }
  events: 'events',         // key [owner, id(uuid)] → { ownerId, id, at, type, wordId?, extra? }
  mistakes: 'mistakes',     // key [owner, id(uuid)] → { ownerId, id, sourceType, paperKey, section, qnum, ... }
};
export const OWNER_STORES = ['marks', 'wordbooks', 'groups', 'events', 'mistakes'];

// 產生 UUID：優先 crypto.randomUUID，舊 iOS Safari 退回手動 v4
function uuid() {
  if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) => (
    Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))
  ).toString(16));
}

// ---------- 資料庫連線（owner 分區庫） ----------

let dbPromise = null;
let dbRef = null;

function idbFactory() {
  const factory = globalThis.indexedDB;
  if (!factory) throw new Error('此環境不支援 IndexedDB，本機資料無法讀寫');
  return factory;
}

/** 只有「快取還指著這條連線」才清：不要把後來成功建立的新連線一起清掉。 */
function forgetDb(db) {
  if (dbRef === db) {
    dbRef = null;
    dbPromise = null;
  }
}

// 暫時性失敗必須可重試（沿用 reading-store 的修法）：
//   Promise 執行器同步執行，在執行器內把 dbPromise 設回 null 會被外層 assignment 覆寫成
//   那顆已 rejected 的 Promise，之後每次呼叫都回同一個舊錯誤。故用 syncFailed 在 assignment
//   之後才清；非同步失敗由 attempt.catch 清；兩者都只在「快取仍是這一次」時清。
function openDB() {
  if (dbPromise) return dbPromise;
  let syncFailed = false;
  const attempt = new Promise((resolve, reject) => {
    let req;
    try {
      req = idbFactory().open(OWNER_DB.name, OWNER_DB.version);
    } catch (err) {
      syncFailed = true;
      reject(err);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of OWNER_STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name); // key 由應用層給：[owner, id]
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // 其他分頁要升級版本時先讓路，下次再用新連線。
      db.onversionchange = () => { try { db.close(); } catch { /* 已關閉 */ } forgetDb(db); };
      db.onclose = () => forgetDb(db);
      dbRef = db;
      resolve(db);
    };
    req.onerror = () => reject(req.error || new Error('無法開啟本機資料庫'));
  });
  dbPromise = attempt;
  if (syncFailed) dbPromise = null;
  attempt.catch(() => {
    if (dbPromise === attempt) { dbRef = null; dbPromise = null; }
  });
  return attempt;
}

// ---------- key / 交易小工具 ----------

/** 分區鍵：[ownerId, id]（都以字串存，避免數字／字串 id 混用時同一筆被當成兩筆）。 */
function rowKey(ownerId, id) {
  return [String(ownerId), String(id)];
}

/**
 * 某 owner 的完整 key range（含前綴，不含其他 owner）。
 * 瀏覽器一定有全域 IDBKeyRange；少數 Node 測試環境只注入 indexedDB 而沒有它，
 * 此時回 null，由 collectOwner／deleteOwner 走「游標逐鍵比對前綴」的退路
 * （只比 key、只讀自己前綴的列，不是先把別人的資料撈出來再 filter）。
 */
function ownerRange(ownerId) {
  const R = globalThis.IDBKeyRange;
  if (!R) return null;
  const prefix = String(ownerId);
  return R.bound([prefix], [prefix, []]);
}

/** 讀出某 owner 在該 store 的全部資料（只碰自己的前綴）。 */
function collectOwner(os, ownerId) {
  const range = ownerRange(ownerId);
  if (range) {
    const req = os.getAll(range);
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error || new Error('本機資料讀取失敗'));
    });
  }
  const prefix = String(ownerId);
  return new Promise((resolve, reject) => {
    const rows = [];
    const req = os.openCursor();
    req.onerror = () => reject(req.error || new Error('本機資料讀取失敗'));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) { resolve(rows); return; }
      const key = cursor.key;
      if (Array.isArray(key) && String(key[0]) === prefix) rows.push(cursor.value);
      cursor.continue();
    };
  });
}

/**
 * 刪除某 owner 在該 store 的全部資料（只刪自己的前綴）。
 * 回傳 Promise：呼叫端**必須 await** 之後才 put 新資料——
 * 沒有全域 IDBKeyRange 的環境走游標退路時，游標是非同步的；不 await 就先 put，
 * 游標的 delete 會晚一步把剛寫進去的資料刪掉（本版自查抓到的真 bug）。
 */
function deleteOwner(os, ownerId) {
  const range = ownerRange(ownerId);
  if (range) return reqAsPromise(os.delete(range));
  const prefix = String(ownerId);
  return new Promise((resolve, reject) => {
    const req = os.openCursor();
    req.onerror = () => reject(req.error || new Error('本機資料刪除失敗'));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) { resolve(); return; }
      const key = cursor.key;
      if (Array.isArray(key) && String(key[0]) === prefix) cursor.delete();
      cursor.continue();
    };
  });
}

function reqAsPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * 讀出某 owner 在該 store 的全部資料（只走自己的 key range）。
 * 6.2.0 修補（主線反例）：讀取也必須綁 owner＋generation——
 *   舊版只捕捉 ownerId，`getUnknownMarks()` 還沒回來就換帳戶時，
 *   仍會把 A 的資料當成結果交出去（前端若只看 ownerId 就照樣畫）。
 *   這裡在 openDB 之後、讀到資料之後、交易完成回傳之前各驗一次；
 *   換帳戶／同一帳戶重新登入（generation 變）一律丟 ACCOUNT_CHANGED，呼叫端不得使用該結果。
 */
async function ownerRows(storeName, owner = captureOwner()) {
  const db = await openDB();
  owner.assertActive();
  const tx = db.transaction(storeName, 'readonly');
  const os = tx.objectStore(storeName);
  const rows = await collectOwner(os, owner.ownerId);
  owner.assertActive(); // 讀到資料之後
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error || new Error('本機資料讀取失敗'));
    tx.onerror = () => undefined;
  });
  owner.assertActive(); // 交易完成、回傳之前
  return rows;
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('本機資料交易中止，這次變更沒有保存'));
    tx.onerror = () => undefined;
  });
}

/**
 * 單一 store 的 read-modify-write：讀該 owner 的現有資料 → fn(rows) → 守衛 → 寫回。
 * fn 回傳 { put:[{id, row}], delete:[id], result }（都省略＝不寫）。
 * 交易內「讀完」與「真正落地前」各驗一次 owner／generation。
 */
async function ownerRmw(storeName, fn, opts = {}) {
  const owner = opts.owner || captureOwner();
  const extraGuard = typeof opts.guard === 'function' ? opts.guard : null;
  const guardAll = () => { owner.assertActive(); if (extraGuard) extraGuard(); };
  const db = await openDB();
  guardAll();
  const tx = db.transaction(storeName, 'readwrite');
  const os = tx.objectStore(storeName);
  const done = txDone(tx);
  let result;
  let writes = false;
  try {
    const rows = await collectOwner(os, owner.ownerId);
    guardAll(); // ① 讀完資料之後
    const plan = fn(rows) || {};
    guardAll(); // ② 真正落地之前
    for (const id of plan.delete || []) { os.delete(rowKey(owner.ownerId, id)); writes = true; }
    for (const item of plan.put || []) {
      os.put({ ...item.row, ownerId: owner.ownerId }, rowKey(owner.ownerId, item.id));
      writes = true;
    }
    result = plan.result;
  } catch (err) {
    try { tx.abort(); } catch { /* 已結束 */ }
    await done.catch(() => undefined);
    throw err;
  }
  await done;
  // commit 之後、回傳之前再驗一次：真 commit 無法回滾，因此換帳戶時**拒收結果**，
  // 由呼叫端（頁面／每日任務／同步）放棄這筆結果，不把它算到新帳戶頭上。
  owner.assertActive();
  if (writes && opts.kind) emit('store:changed', { kind: opts.kind });
  return result;
}

/** 單一 store 的單筆 get→改→put（同一個交易內完成）。 */
async function ownerPatchOne(storeName, id, updater, opts = {}) {
  const owner = opts.owner || captureOwner();
  const extraGuard = typeof opts.guard === 'function' ? opts.guard : null;
  const guardAll = () => { owner.assertActive(); if (extraGuard) extraGuard(); };
  const db = await openDB();
  guardAll();
  const tx = db.transaction(storeName, 'readwrite');
  const os = tx.objectStore(storeName);
  const done = txDone(tx);
  const key = rowKey(owner.ownerId, id);
  let result = null;
  let writes = false;
  try {
    const rec = await reqAsPromise(os.get(key));
    guardAll();
    if (rec !== undefined) {
      const next = updater(rec);
      if (next !== null && next !== undefined) {
        guardAll();
        if (next === false) os.delete(key); else os.put({ ...next, ownerId: owner.ownerId }, key);
        writes = true;
        result = next === false ? null : next;
      }
    }
  } catch (err) {
    try { tx.abort(); } catch { /* 已結束 */ }
    await done.catch(() => undefined);
    throw err;
  }
  await done;
  // commit 之後、回傳之前再驗一次：真 commit 無法回滾，因此換帳戶時**拒收結果**，
  // 由呼叫端（頁面／每日任務／同步）放棄這筆結果，不把它算到新帳戶頭上。
  owner.assertActive();
  if (writes && opts.kind) emit('store:changed', { kind: opts.kind });
  return result;
}

// ---------- 學習事件記錄（2.0.13 統計用） ----------
// type: 'card'（練習卡，wordId）| 'review'（複習評分，wordId＋extra=remembered）
//     | 'translate'（翻譯題提交，extra={words:N}）| 'wordbook-saved'
// 6.2.0：事件也進 owner 分區（統計／近 N 天查詢都不會跨帳戶）。
export async function addEvent(type, wordId = null, extra = null, opts = {}) {
  try {
    const owner = opts.owner || captureOwner();
    const rec = { id: uuid(), at: new Date().toISOString(), type, wordId, extra };
    await ownerRmw('events', () => ({ put: [{ id: rec.id, row: rec }], result: rec }), { owner });
  } catch (err) {
    console.warn('事件記錄失敗：', err);
  }
}

// 全部事件（舊→新；只含目前捕捉到的 owner）
export async function getEvents() {
  const owner = captureOwner();
  const rows = await ownerRows('events', owner);
  owner.assertActive(); // 排序／回傳前再驗一次
  rows.sort((a, b) => (a.at < b.at ? -1 : 1));
  owner.assertActive();
  return rows;
}

/**
 * 5.0.x（spec 5.7 第 6 節）：近 N 天查過的字（events 中 type='lookup' 的紀錄去重後的 wordId）。
 * 回傳 [{ wordId, at }]，最近查過的在前。查無資料回空陣列（呼叫端據此不渲染區塊）。
 */
export async function getRecentLookups(days = 7) {
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const rows = await getEvents();
  const seen = new Map();
  for (const e of rows) {
    if (e.type !== 'lookup' || e.wordId == null) continue;
    if (!(new Date(e.at).getTime() >= since)) continue;
    const k = String(e.wordId);
    const prev = seen.get(k);
    if (!prev || prev.at < e.at) seen.set(k, { wordId: e.wordId, at: e.at });
  }
  return [...seen.values()].sort((x, y) => (x.at < y.at ? 1 : -1));
}

// ---- 不會標記 + SRS 間隔複習（2.0.5） ----
// 複習週期：標記後 1 天到期；答對依 1→3→7→14 天推進；
// 14 天階段再答對即「畢業」，自動移出不會清單。答錯回到 1 天。

const DAY_MS = 24 * 60 * 60 * 1000;

// 5.0.x：複習強度三段（輕鬆／標準／紮實）。天數的**唯一來源**是 services/settings.js 的
//   REVIEW_STRENGTHS（使用者偏好層，localStorage）；本檔只在排程當下現讀，切換後「新排程」立刻
//   套用新天數，既有到期日不追溯（spec 5.7 第 5 節：使用者已排的日期不變）。
//   SRS_INTERVALS 保留為「標準強度」的天數（2.0.5 以來的舊匯出，避免外部引用破壞）；
//   真正顯示當前強度天數的消費端（統計頁／個人主頁／複習管理頁）一律呼叫 srsIntervals()。
export function srsIntervals() {
  const cur = REVIEW_STRENGTHS.find((s) => s.id === getReviewStrength());
  return cur ? cur.intervals : DEFAULT_INTERVALS;
}
const DEFAULT_INTERVALS = REVIEW_STRENGTHS.find((s) => s.id === 'normal').intervals;
export const SRS_INTERVALS = DEFAULT_INTERVALS; // 相容舊匯出（預設強度＝標準 1/3/7/14）

function wordIdOf(wordId) {
  const n = Number(wordId);
  if (!Number.isFinite(n) || n <= 0) throw new Error('INVALID_WORD_ID');
  return n;
}

// 6.1.1：新字依「當下」設定的引擎建立；既有字一律不重寫（不改引擎、不改 due）。
// 6.2.0：寫進目前捕捉到的 owner 分區；回傳 true＝這次真的新增，false＝本來就有（去重）。
export async function markUnknown(wordId, opts = {}) {
  const wid = wordIdOf(wordId);
  const owner = opts.owner || captureOwner();
  const extraGuard = typeof opts.guard === 'function' ? opts.guard : null;
  const now = new Date();
  const db = await openDB();
  const guardAll = () => { owner.assertActive(); if (extraGuard) extraGuard(); };
  guardAll();
  const tx = db.transaction(OWNER_DB.marks, 'readwrite');
  const os = tx.objectStore(OWNER_DB.marks);
  const done = txDone(tx);
  const key = rowKey(owner.ownerId, wid);
  let created = false;
  try {
    const existing = await reqAsPromise(os.get(key));
    guardAll(); // 讀完之後
    if (existing === undefined) {
      // 已存在＝重複標記不得按目前開關重設引擎或日期
      const rec = getSrsAlgorithm() === FSRS_ENGINE
        ? (() => {
            const state = newFsrsState(now);
            return {
              wordId: wid, addedAt: now.toISOString(), stage: 0,
              dueAt: state.due, engine: FSRS_ENGINE, fsrsState: state,
            };
          })()
        : {
            wordId: wid,
            addedAt: now.toISOString(),
            stage: 0,
            dueAt: new Date(now.getTime() + srsIntervals()[0] * DAY_MS).toISOString(),
          };
      guardAll(); // 真正落地之前
      os.put({ ...rec, ownerId: owner.ownerId }, key);
      created = true;
    }
  } catch (err) {
    try { tx.abort(); } catch { /* 已結束 */ }
    await done.catch(() => undefined);
    throw err;
  }
  await done;
  // commit 之後、回傳之前再驗一次：真 commit 無法回滾，因此換帳戶時**拒收結果**，
  // 由呼叫端（頁面／每日任務／同步）放棄這筆結果，不把它算到新帳戶頭上。
  owner.assertActive();
  if (created) emit('store:changed', { kind: 'mark' });
  return created;
}

export async function unmarkUnknown(wordId, opts = {}) {
  await ownerPatchOne(OWNER_DB.marks, wordIdOf(wordId), () => false, { kind: 'mark', ...opts });
}

export async function clearUnknown(opts = {}) {
  const owner = opts.owner || captureOwner();
  const extraGuard = typeof opts.guard === 'function' ? opts.guard : null;
  const db = await openDB();
  owner.assertActive();
  if (extraGuard) extraGuard();
  const tx = db.transaction(OWNER_DB.marks, 'readwrite');
  const done = txDone(tx);
  try {
    // 只清自己分區（key range／前綴），不是整庫 clear
    await deleteOwner(tx.objectStore(OWNER_DB.marks), owner.ownerId);
  } catch (err) {
    try { tx.abort(); } catch { /* 已結束 */ }
    await done.catch(() => undefined);
    throw err;
  }
  await done;
  // commit 之後、回傳之前再驗一次：真 commit 無法回滾，因此換帳戶時**拒收結果**，
  // 由呼叫端（頁面／每日任務／同步）放棄這筆結果，不把它算到新帳戶頭上。
  owner.assertActive();
  emit('store:changed', { kind: 'marks' }); // 整批清空：數量會大減，必須走完整比對
}

// 全部標記記錄（依加入時間排序；補齊舊版記錄缺少的 SRS 欄位）——只含目前 owner
export async function getUnknownMarks() {
  const owner = captureOwner();
  const rows = await ownerRows(OWNER_DB.marks, owner);
  owner.assertActive(); // 補齊欄位／回傳前再驗：這批資料只屬於捕捉時的帳戶
  const intervals = srsIntervals();
  const fallback = new Date();
  for (const r of rows) {
    // FSRS 卡沒有「階段」語意，不可套固定排程的補齊邏輯；只補舊顯示欄位，
    // 不動 fsrsState，也不讓缺 addedAt 的合法舊卡在排序或格式化時變成無效日期。
    if (isFsrsEngine(r.engine)) {
      const state = r.fsrsState && typeof r.fsrsState === 'object' ? r.fsrsState : {};
      if (!parseValidDate(r.addedAt)) {
        const anchor = parseValidDate(state.last_review)
          || parseValidDate(state.due)
          || parseValidDate(r.dueAt)
          || fallback;
        r.addedAt = anchor.toISOString();
      }
      // 正常 FSRS 卡的 dueAt 已由匯入驗證與 manual due 同步；此處只防既有壞資料
      // 讓佇列以 NaN 日期靜默漏卡，不主動改寫 fsrsState。
      if (!parseValidDate(r.dueAt)) {
        const due = parseValidDate(state.due) || parseValidDate(r.addedAt);
        r.dueAt = due.toISOString();
      }
      continue;
    }
    // 舊固定排程：缺 stage 補 0；缺 dueAt 依「addedAt＋第一段間隔」補；
    // 連 addedAt 都缺（最小 legacy {wordId}）才用本次讀取的當下時間當錨點。
    const added = parseValidDate(r.addedAt);
    const due = parseValidDate(r.dueAt);
    if (r.stage === undefined) r.stage = 0;
    if (!added) {
      r.addedAt = (due ? new Date(due.getTime() - intervals[0] * DAY_MS) : fallback).toISOString();
    } else {
      r.addedAt = added.toISOString();
    }
    if (!due) {
      const anchor = parseValidDate(r.addedAt);
      r.dueAt = new Date(anchor.getTime() + intervals[0] * DAY_MS).toISOString();
    } else {
      r.dueAt = due.toISOString();
    }
  }
  rows.sort((a, b) => (a.addedAt < b.addedAt ? -1 : 1));
  owner.assertActive();
  return rows;
}

// 以 Set 形式取得已標記的 wordId（查詢/練習頁判斷用）
export async function getUnknownIds() {
  const owner = captureOwner();
  const rows = await getUnknownMarks();
  owner.assertActive();
  const ids = new Set(rows.map((r) => r.wordId));
  owner.assertActive();
  return ids;
}

// 調整某字的下次複習日期（排程管理用；階段不變）
export async function updateMarkDue(wordId, dueAt, opts = {}) {
  const d = parseValidDate(dueAt);
  if (!d) return false; // 非法日期不得寫入，也不得破壞既有合法資料
  const iso = d.toISOString();
  const updated = await ownerPatchOne(OWNER_DB.marks, wordIdOf(wordId), (rec) => {
    const next = { ...rec, dueAt: iso };
    // 6.1.1：FSRS 卡的記憶狀態也帶 due；手動改期必須同步，否則預覽／評分會用舊日期。
    if (isFsrsEngine(next.engine)) next.fsrsState = { ...normalizeFsrsState(next.fsrsState), due: iso };
    return next;
  }, { kind: 'mark', ...opts });
  return Boolean(updated);
}

// ---- SRS 複習佇列 ----

// 到期（該複習）與未到期的標記。每次呼叫都讀最新標記；
// 不用 TTL 快取掩蓋 UI listener 尚未綁定時的重繪競態。
export async function getSrsQueues() {
  const owner = captureOwner();
  const now = Date.now();
  const rows = await getUnknownMarks();
  owner.assertActive();
  const due = rows.filter((r) => new Date(r.dueAt).getTime() <= now);
  const upcoming = rows.filter((r) => new Date(r.dueAt).getTime() > now);
  upcoming.sort((a, b) => (a.dueAt < b.dueAt ? -1 : 1));
  owner.assertActive();
  return { due, upcoming };
}

// 6.1.1：純預覽——只讀標記並用該卡自己的引擎計算，不寫入、不改 due。
// FSRS 卡回傳 again／hard／good 三鍵；固定卡回 null（UI 維持原兩鍵）。
export async function previewReview(wordId, at = Date.now()) {
  const owner = captureOwner();
  const rows = await getUnknownMarks();
  owner.assertActive();
  const rec = rows.find((r) => r.wordId === wordId);
  if (!rec || !isFsrsEngine(rec.engine)) return null;
  const preview = previewFsrs(rec.fsrsState, at, getFsrsRetention());
  owner.assertActive(); // 純讀：回傳前同樣不得跨帳戶
  return preview;
}

// 記錄一次複習結果：remembered=true 推進階段（可能畢業），false 回到第 0 階段
// 每日任務跨兩個 IDB：把 SRS 效果與可重播的收據放同一個交易。
// 診斷庫完成寫入失敗或關頁後，可按 owner/date/word 讀回收據，不能再次推進 SRS。
// 6.1.1：FSRS 卡在同一交易內以真 vendor 計算並寫回完整 fsrsState／dueAt；
// 收據仍以 owner＋localDate＋word 去重，換帳戶或換日重驗後才可寫。
// 6.2.0：marks 與 events 都在 owner 分區庫裡，同一個交易即可原子完成；
//   context.ownerId 只當「收據鍵」，資料分區仍以捕捉到的 owner 為準。
export async function gradeTaskReview(wordId, remembered, context) {
  if (!context?.ownerId || !/^\d{4}-\d{2}-\d{2}$/.test(context.localDate)) throw new Error('INVALID_TASK_CONTEXT');
  context.assertActive?.();
  const wid = wordIdOf(wordId);
  const owner = captureOwner();
  const db = await openDB();
  const guardAll = () => { owner.assertActive(); context.assertActive?.(); };
  guardAll();
  const tx = db.transaction([OWNER_DB.marks, OWNER_DB.events], 'readwrite');
  const marks = tx.objectStore(OWNER_DB.marks);
  const events = tx.objectStore(OWNER_DB.events);
  const markKey = rowKey(owner.ownerId, wid);
  const done = txDone(tx);
  let result;
  try {
    const existingEvents = await collectOwner(events, owner.ownerId);
    guardAll();
    const found = existingEvents.find((e) => e.type === 'review' && e.wordId === wid
      && e.extra?.taskReceipt?.ownerId === context.ownerId && e.extra.taskReceipt.localDate === context.localDate);
    if (found) {
      result = found.extra.taskReceipt.result;
    } else {
      const rec = await reqAsPromise(marks.get(markKey));
      guardAll();
      if (!rec) throw new Error('REVIEW_MARK_NOT_FOUND');
      const at = new Date().toISOString();
      if (isFsrsEngine(rec.engine)) {
        // Hard 只能是明確的 'hard'；不得因 truthy 被當成 Good。
        const rated = applyFsrsReview(rec.fsrsState, remembered, new Date(), getFsrsRetention());
        result = { graduated: false, grade: rated.grade };
        marks.put({ ...rec, dueAt: rated.dueAt, fsrsState: rated.state, ownerId: owner.ownerId }, markKey);
      } else {
        const stage = Number.isInteger(rec.stage) ? rec.stage : 0;
        const intervals = srsIntervals(), nextStage = remembered ? stage + 1 : 0;
        const graduated = remembered && nextStage >= intervals.length;
        result = graduated ? { graduated: true } : { graduated: false, stage: nextStage };
        if (graduated) {
          marks.delete(markKey);
          const graduateId = uuid();
          events.put({ id: graduateId, ownerId: owner.ownerId, at, type: 'graduate', wordId: wid, extra: null }, rowKey(owner.ownerId, graduateId));
        } else {
          marks.put({ ...rec, stage: nextStage, dueAt: new Date(Date.now() + intervals[nextStage] * DAY_MS).toISOString(), ownerId: owner.ownerId }, markKey);
        }
      }
      const receiptId = uuid();
      events.put({
        id: receiptId, ownerId: owner.ownerId, at, type: 'review', wordId: wid,
        extra: { taskReceipt: { ownerId: context.ownerId, localDate: context.localDate, remembered, result } },
      }, rowKey(owner.ownerId, receiptId));
    }
  } catch (err) {
    try { tx.abort(); } catch { /* 已結束 */ }
    await done.catch(() => undefined);
    throw err;
  }
  await done;
  // commit 之後、回傳之前再驗一次：真 commit 無法回滾，因此換帳戶時**拒收結果**，
  // 由呼叫端（頁面／每日任務／同步）放棄這筆結果，不把它算到新帳戶頭上。
  owner.assertActive();
  emit('store:changed', { kind: 'mark' });
  return result;
}

export async function gradeReview(wordId, remembered, opts = {}) {
  const owner = opts.owner || captureOwner();
  // 先讀出記錄計算新狀態，最後才開寫入交易
  // （IndexedDB 交易在 await 期間會自動提交，不能開了交易才去做別的讀取）
  const rows = await getUnknownMarks();
  owner.assertActive();
  const rec = rows.find((r) => r.wordId === wordId);
  if (!rec) return null;

  // 6.1.1：FSRS 卡用真 vendor 三鍵評分；預覽（previewReview）與這裡同引擎、
  // 同保留率、同序列化格式。固定卡維持下方原階段／畢業邏輯。
  if (isFsrsEngine(rec.engine)) {
    const rated = applyFsrsReview(rec.fsrsState, remembered, new Date(), getFsrsRetention());
    rec.dueAt = rated.dueAt;
    rec.fsrsState = rated.state;
    await ownerPatchOne(OWNER_DB.marks, wordId, () => ({ ...rec }), { kind: 'mark', owner, ...opts });
    owner.assertActive();
    return { graduated: false, grade: rated.grade };
  }

  if (!remembered) {
    rec.stage = 0;
    rec.dueAt = new Date(Date.now() + srsIntervals()[0] * DAY_MS).toISOString();
    await ownerPatchOne(OWNER_DB.marks, wordId, () => ({ ...rec }), { kind: 'mark', owner, ...opts });
    owner.assertActive();
    return { graduated: false, stage: 0 };
  }

  const intervals = srsIntervals();
  const nextStage = rec.stage + 1;
  if (nextStage >= intervals.length) {
    await ownerPatchOne(OWNER_DB.marks, wordId, () => false, { kind: 'mark', owner, ...opts }); // 畢業：移出不會清單
    addEvent('graduate', wordId, null, { owner }); // 3.0.3 起記錄畢業（統計掌握度用）
    return { graduated: true };
  }
  rec.stage = nextStage;
  rec.dueAt = new Date(Date.now() + intervals[nextStage] * DAY_MS).toISOString();
  await ownerPatchOne(OWNER_DB.marks, wordId, () => ({ ...rec }), { kind: 'mark', owner, ...opts });
  owner.assertActive();
  return { graduated: false, stage: nextStage };
}

// ---- 具名單詞本（2.0.8） ----

/** 閱讀頁「加入單詞本」用的收藏本名稱（同一帳戶共用一本，跨次累積、去重）。 */
export const READING_BOOK_NAME = '閱讀收藏';

// 保存一次練習收集的單詞本；回傳新記錄 id（UUID）
// 5.0.0：pendingWords（字庫外字＝待補清單）只在有值時才寫入欄位，
//   避免每一本練習產生的單詞本都多存一個空陣列（同步 payload 是整份上傳的）
export async function addWordbook({ name, wordIds, endedAt, pendingWords }, opts = {}) {
  const rec = {
    id: uuid(),
    name,
    wordIds: Array.isArray(wordIds) ? wordIds : [],
    endedAt: endedAt || new Date().toISOString(),
    lastPracticedAt: endedAt || new Date().toISOString(),
  };
  if (pendingWords && pendingWords.length) rec.pendingWords = pendingWords;
  await ownerRmw(OWNER_DB.wordbooks, () => ({ put: [{ id: rec.id, row: rec }], result: rec }), { kind: 'wordbook', ...opts });
  return rec.id;
}

// 全部已保存單詞本（新的在前；只含目前捕捉到的 owner）
export async function getWordbooks() {
  const owner = captureOwner();
  const rows = await ownerRows(OWNER_DB.wordbooks, owner);
  owner.assertActive();
  rows.sort((a, b) => (a.endedAt > b.endedAt ? -1 : 1));
  owner.assertActive();
  return rows;
}

export async function deleteWordbook(id, opts = {}) {
  await ownerPatchOne(OWNER_DB.wordbooks, id, () => false, { kind: 'wordbook', ...opts });
}

// 記錄「最近一次練習這本單詞本」的時間
export async function touchWordbook(id, opts = {}) {
  await ownerPatchOne(OWNER_DB.wordbooks, id, (rec) => ({ ...rec, lastPracticedAt: new Date().toISOString() }), { kind: 'wordbook', ...opts });
}

// ---- 分組與單詞本欄位（3.0.2） ----

export async function getGroups() {
  const owner = captureOwner();
  const rows = await ownerRows(OWNER_DB.groups, owner);
  owner.assertActive();
  rows.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  owner.assertActive();
  return rows;
}

export async function addGroup(name, opts = {}) {
  const rec = { id: uuid(), name, order: Date.now() };
  await ownerRmw(OWNER_DB.groups, () => ({ put: [{ id: rec.id, row: rec }], result: rec }), { kind: 'group', ...opts });
  return rec.id;
}

export async function renameGroup(id, name, opts = {}) {
  await ownerPatchOne(OWNER_DB.groups, id, (rec) => ({ ...rec, name }), { kind: 'group', ...opts });
}

// 刪除分組：群組內單詞本退回「未分組」，不會消失
// 單詞本與分組在同一個交易內處理：避免「已退回未分組／分組已刪」只做一半。
export async function deleteGroup(id, opts = {}) {
  const owner = opts.owner || captureOwner();
  const guardAll = () => { owner.assertActive(); if (typeof opts.guard === 'function') opts.guard(); };
  const db = await openDB();
  guardAll();
  const tx = db.transaction([OWNER_DB.wordbooks, OWNER_DB.groups], 'readwrite');
  const books = tx.objectStore(OWNER_DB.wordbooks);
  const groups = tx.objectStore(OWNER_DB.groups);
  const done = txDone(tx);
  try {
    const rows = await collectOwner(books, owner.ownerId);
    guardAll();
    for (const b of rows) {
      if (b.groupId === id) books.put({ ...b, groupId: null, ownerId: owner.ownerId }, rowKey(owner.ownerId, b.id));
    }
    groups.delete(rowKey(owner.ownerId, id));
    guardAll();
  } catch (err) {
    try { tx.abort(); } catch { /* 已結束 */ }
    await done.catch(() => undefined);
    throw err;
  }
  await done;
  // commit 之後、回傳之前再驗一次：真 commit 無法回滾，因此換帳戶時**拒收結果**，
  // 由呼叫端（頁面／每日任務／同步）放棄這筆結果，不把它算到新帳戶頭上。
  owner.assertActive();
  emit('store:changed', { kind: 'group' });
}

// 通用單詞本欄位更新（groupId／sort 等）
export async function updateWordbook(id, patch, opts = {}) {
  await ownerPatchOne(OWNER_DB.wordbooks, id, (rec) => ({ ...rec, ...patch }), { kind: 'wordbook', ...opts });
}

// 5.0.0：把「多個 id 接在某本單詞本的字尾」當成一次增量寫入。
// 為什麼需要它：分兩段讀寫（先 readonly get、再 readwrite put）之間仍有空窗，
// 這段空窗裡若雲端快照（同步頁／帳戶頁的「替換」還原走 replaceAllWordbooks）
// 落地同一本單詞本，先讀到的 wordIds 當 patch 寫回會把對方帶來的新字蓋掉，
// 而 mergeWordbooks 只補本機沒有的 id，補不回來。
// 這裡把 get 與 put 放進**同一個 readwrite 交易**：IndexedDB 對同一 objectStore
// 的交易是序列化的，交易存續期間其他 readwrite 交易（含 replaceAllWordbooks
// 背後的 clear＋put）會被排到本交易之後才執行，故空窗不存在。
// updater 回傳 null 代表「這次不用寫」（書已被刪／字已由雲端帶進來）。
export async function appendWordIds(id, updater, opts = {}) {
  const owner = opts.owner || captureOwner();
  const guardAll = () => { owner.assertActive(); if (typeof opts.guard === 'function') opts.guard(); };
  const db = await openDB();
  guardAll();
  const tx = db.transaction(OWNER_DB.wordbooks, 'readwrite');
  const os = tx.objectStore(OWNER_DB.wordbooks);
  const key = rowKey(owner.ownerId, id);
  const done = txDone(tx);
  let added = null;
  let writes = false;
  try {
    const rec = await reqAsPromise(os.get(key));
    guardAll();
    if (rec !== undefined) {
      const next = updater(rec);
      if (next) {
        const { __added, ...clean } = next;     // __added 只用來回報數量，不寫進資料
        guardAll();
        os.put({ ...clean, ownerId: owner.ownerId }, key);
        writes = true;
        added = __added ?? 0;
      }
    }
  } catch (err) {
    try { tx.abort(); } catch { /* 已結束 */ }
    await done.catch(() => undefined);
    throw err;
  }
  await done;
  // commit 之後、回傳之前再驗一次：真 commit 無法回滾，因此換帳戶時**拒收結果**，
  // 由呼叫端（頁面／每日任務／同步）放棄這筆結果，不把它算到新帳戶頭上。
  owner.assertActive();
  if (writes) emit('store:changed', { kind: 'wordbook' });
  return added;
}

// 待補清單一律小寫存（比對時與 search.js 的索引鍵一致）；兩本聯集時用它去重。
// 與 unknown.js 的 dedupeLower 同一規則——兩邊各有一份是刻意的（store.js 不得 import 頁面層）。
function dedupeLower(list) {
  const seen = new Set();
  const out = [];
  for (const t of list || []) {
    const s = String(t ?? '').trim().toLowerCase();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

// 5.3：把「來源本」整本併入「目標本」，**讀來源 → 改目標 →（選刪）刪來源**放進同一個 readwrite 交易。
// 為什麼需要它：分步做會留下殘留視窗——讀到的來源快照若在下一個交易開始前被另一條真實寫入
// 路徑（fillPendingWordbooks／雲端合併匯入，都走 appendWordIds）append 了新字，
// 那些字不會進目標本；勾「合併後刪除來源本」時來源本隨即被刪，這些字**永久消失**，
// 而 UI 仍宣稱合併成功。
// 回傳 { merged:false, reason, sourceName }，reason ∈ 'same-book' | 'source-missing' | 'target-missing'；
// 成功時回傳 { merged:true, added, sourceName }。
export async function mergeWordbookInto(targetId, sourceId, { dropSource = false, ...opts } = {}) {
  // 目標與來源同一本 → 沒有東西可併，直接回「無變化」
  if (String(targetId) === String(sourceId)) {
    return { merged: false, reason: 'same-book', added: 0, sourceName: '' };
  }
  const owner = opts.owner || captureOwner();
  const guardAll = () => { owner.assertActive(); if (typeof opts.guard === 'function') opts.guard(); };
  const db = await openDB();
  guardAll();
  const tx = db.transaction(OWNER_DB.wordbooks, 'readwrite');
  const os = tx.objectStore(OWNER_DB.wordbooks);
  const done = txDone(tx);
  let out = null;
  let writes = false;
  try {
    const source = await reqAsPromise(os.get(rowKey(owner.ownerId, sourceId)));
    guardAll();
    if (source === undefined) {
      out = { merged: false, reason: 'source-missing', added: 0, sourceName: '' };
    } else {
      const target = await reqAsPromise(os.get(rowKey(owner.ownerId, targetId)));
      guardAll();
      if (target === undefined) {
        out = { merged: false, reason: 'target-missing', added: 0, sourceName: source.name };
      } else {
        // 來源可能沒有 wordIds（手動建的本／雲端備份缺欄位）：防一手壞資料讓整次合併中斷
        const srcIds = Array.isArray(source.wordIds) ? source.wordIds : [];
        const known = new Set((target.wordIds || []).map(String));
        const addIds = srcIds.filter((id) => !known.has(String(id)));
        const merged = {
          ...target,
          wordIds: [...(target.wordIds || []), ...addIds],
          // 待補清單聯集（小寫化＋去重，與 unknown.js 的 dedupeLower 同一規則）
          pendingWords: dedupeLower([...(target.pendingWords || []), ...(source.pendingWords || [])]),
        };
        guardAll();
        os.put({ ...merged, ownerId: owner.ownerId }, rowKey(owner.ownerId, targetId));
        if (dropSource) os.delete(rowKey(owner.ownerId, sourceId));
        writes = true;
        out = { merged: true, added: addIds.length, sourceName: source.name };
      }
    }
  } catch (err) {
    try { tx.abort(); } catch { /* 已結束 */ }
    await done.catch(() => undefined);
    throw err;
  }
  await done;
  // commit 之後、回傳之前再驗一次：真 commit 無法回滾，因此換帳戶時**拒收結果**，
  // 由呼叫端（頁面／每日任務／同步）放棄這筆結果，不把它算到新帳戶頭上。
  owner.assertActive();
  if (writes) emit('store:changed', { kind: 'wordbook' });
  return out;
}

// ---------- 閱讀頁接真單詞本（6.2.0） ----------
// 「加入單詞本」接的是真的具名單詞本（READING_BOOK_NAME），不是閱讀頁自己的待接桶：
//   · 同一帳戶共用一本，跨次累積；已在書內的 id 不重複加入（真去重）。
//   · 建本與追加在同一個 readwrite 交易內完成：兩個分頁同時按不會各建一本、也不會互相蓋掉。
//   · 守衛在交易內讀完與落地前各驗一次；換帳戶／離頁時不寫入並如實 reject。
// 回傳 { id, added:[wordId...], createdBook:boolean }。
export async function addWordsToReadingWordbook(wordIds, opts = {}) {
  const ids = (Array.isArray(wordIds) ? wordIds : [wordIds])
    .map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0);
  if (!ids.length) throw new Error('沒有可加入單詞本的字');
  const owner = opts.owner || captureOwner();
  const extraGuard = typeof opts.guard === 'function' ? opts.guard : null;
  const guardAll = () => { owner.assertActive(); if (extraGuard) extraGuard(); };
  const db = await openDB();
  guardAll();
  const tx = db.transaction(OWNER_DB.wordbooks, 'readwrite');
  const os = tx.objectStore(OWNER_DB.wordbooks);
  const done = txDone(tx);
  let out = null;
  try {
    const rows = await collectOwner(os, owner.ownerId);
    guardAll();
    const existing = rows.find((b) => b.name === READING_BOOK_NAME);
    const nowIso = new Date().toISOString();
    const base = existing || {
      id: uuid(), name: READING_BOOK_NAME, wordIds: [], pendingWords: [],
      groupId: null, sort: 'input', endedAt: nowIso, lastPracticedAt: nowIso,
    };
    const have = new Set((base.wordIds || []).map(String));
    const added = [];
    for (const id of ids) {
      if (have.has(String(id))) continue; // 真去重：已在書內就不再加第二筆
      have.add(String(id));
      added.push(id);
    }
    const next = existing
      ? { ...base, wordIds: [...(base.wordIds || []), ...added], lastPracticedAt: nowIso }
      : { ...base, wordIds: added };
    guardAll();
    os.put({ ...next, ownerId: owner.ownerId }, rowKey(owner.ownerId, next.id));
    out = { id: next.id, added, createdBook: !existing };
  } catch (err) {
    try { tx.abort(); } catch { /* 已結束 */ }
    await done.catch(() => undefined);
    throw err;
  }
  await done;
  // commit 之後、回傳之前再驗一次：真 commit 無法回滾，因此換帳戶時**拒收結果**，
  // 由呼叫端（頁面／每日任務／同步）放棄這筆結果，不把它算到新帳戶頭上。
  owner.assertActive();
  if (out.added.length) emit('store:changed', { kind: 'wordbook' });
  return out;
}

/** 從閱讀收藏本移除指定字（找不到書／字就原樣回，不報錯）。 */
export async function removeWordsFromReadingWordbook(wordIds, opts = {}) {
  const ids = new Set((Array.isArray(wordIds) ? wordIds : [wordIds]).map(String));
  const owner = opts.owner || captureOwner();
  const extraGuard = typeof opts.guard === 'function' ? opts.guard : null;
  const guardAll = () => { owner.assertActive(); if (extraGuard) extraGuard(); };
  const db = await openDB();
  guardAll();
  const tx = db.transaction(OWNER_DB.wordbooks, 'readwrite');
  const os = tx.objectStore(OWNER_DB.wordbooks);
  const done = txDone(tx);
  const removed = [];
  try {
    const rows = await collectOwner(os, owner.ownerId);
    guardAll();
    const book = rows.find((b) => b.name === READING_BOOK_NAME);
    if (book) {
      const nextIds = (book.wordIds || []).filter((id) => {
        if (!ids.has(String(id))) return true;
        removed.push(id);
        return false;
      });
      if (removed.length) {
        guardAll();
        os.put({ ...book, wordIds: nextIds, ownerId: owner.ownerId }, rowKey(owner.ownerId, book.id));
      }
    }
  } catch (err) {
    try { tx.abort(); } catch { /* 已結束 */ }
    await done.catch(() => undefined);
    throw err;
  }
  await done;
  // commit 之後、回傳之前再驗一次：真 commit 無法回滾，因此換帳戶時**拒收結果**，
  // 由呼叫端（頁面／每日任務／同步）放棄這筆結果，不把它算到新帳戶頭上。
  owner.assertActive();
  if (removed.length) emit('store:changed', { kind: 'wordbook' });
  return removed;
}

// ---------- 5.0.0 待補單字（字庫外字）：字庫收錄後自動補進 ----------

// 把待補清單分流成「字庫已收錄」與「仍不在字庫」兩組（純函式，node 可直接測）
// 刻意不動既有 wordIds，也不改變待補清單原本的順序——
//   words     → 待補字對應的字庫 word（依 pendingWords 原序、去重）
//   rest      → 仍不在字庫的 token（原樣、小寫化後去重）
// lookup 可傳入自訂命中函式（測試用假字庫）；預設用 search.js 的 wordIndex()
// （search.js 只 import vocab.js，不回頭 import store.js，故無循環相依）
export function splitPending(pendingWords, lookup = null) {
  const hit = lookup || ((t) => wordIndex().get(t));
  const words = [];
  const rest = [];
  const seenWord = new Set();
  const seenRest = new Set();
  for (const raw of Array.isArray(pendingWords) ? pendingWords : []) {
    const t = String(raw ?? '').trim().toLowerCase();
    if (!t) continue;
    const w = hit(t);
    if (w) {
      if (seenWord.has(w.id)) continue;
      seenWord.add(w.id);
      words.push(w);
    } else {
      if (seenRest.has(t)) continue;
      seenRest.add(t);
      rest.push(t);
    }
  }
  return { words, rest };
}

// 啟動時呼叫（fire-and-forget，不擋啟動）：把待補字已進字庫的單詞本自動補進
// 效能鐵律：先掃 books，任何一本都沒有非空 pendingWords 就直接 return，
//   不開任何寫入交易、不 emit store:changed（否則 15 秒同步鏈會空轉一輪）
export async function fillPendingWordbooks() {
  const books = await getWordbooks(); // 只掃目前 owner 的書
  const filled = [];
  for (const b of books) {
    if (splitPending(b.pendingWords).words.length === 0) continue; // 全列無變化 → 不寫入
    // 掃描只是「哪些字可能已進字庫」的預篩，實際比對與寫回都在單一 readwrite
    // 交易內重讀最新記錄後完成（appendWordIds），故「讀 books → 寫回」之間
    // 發生的雲端整批取代（replaceAllWordbooks）不會被舊快照蓋掉。
    const added = await appendWordIds(b.id, (cur) => {
      if (!cur) return null;              // 書在掃描後被刪
      const { words, rest } = splitPending(cur.pendingWords);
      if (words.length === 0) return null;
      // 舊記錄理論上都有 wordIds；仍防一手壞資料讓整輪掃描中斷（否則後面的書都不補）
      const ids = Array.isArray(cur.wordIds) ? cur.wordIds : [];
      const known = new Set(ids.map(String));
      const addIds = words.filter((w) => !known.has(String(w.id))).map((w) => w.id);
      if (addIds.length === 0) {
        // 命中的字全部已在單詞本內（舊資料可能同時出現在 wordIds 與 pendingWords）：
        // 仍要把這些 token 從待補清單移除，否則「+N 待補」小標永久卡住（5.0.0 池 B 驗證發現）。
        if (rest.length === (Array.isArray(cur.pendingWords) ? cur.pendingWords.length : 0)) return null;
        return { ...cur, pendingWords: rest, __added: 0 };
      }
      return { ...cur, wordIds: [...ids, ...addIds], pendingWords: rest, __added: addIds.length };
    });
    if (added === null || added === 0) continue; // 無實際補進（雲端已帶入／僅清待補清單）→ 不進回報
    filled.push({ name: b.name, count: added });
  }
  return filled;
}

// ---- 5.0.x 錯題本（examMistakes）----
// 範圍（spec 5.7 第 3 節）：#/exam 的 real／ai 卷，以及選擇練習中來源為 ai／real 的題目。
//   配對／拼寫不進錯題本（單字類錯誤走 SRS）；考古題（archive）也不進——spec 只列 real／ai。
// 雲端同步暫緩：本 store 不在 exportMarks／exportWordbooks 的 payload 內，
//   換裝置後錯題本不會跟著走（UI 有註明；後續版本再評估）。
// 6.2.0：錯題也進 owner 分區（換帳號不會看到別人的錯題）。

/**
 * 記錄一次答錯。同一題（sourceType＋paperKey＋section＋qnum）再錯只累計 gotWrongCount、不另建列。
 * m: { sourceType:'real'|'ai', paperKey, section, qnum, stem?, wordHead? }
 */
export async function recordMistake(m, opts = {}) {
  if (!m || (m.sourceType !== 'real' && m.sourceType !== 'ai')) return null;
  try {
    const key = mistakeKey(m);
    const owner = opts.owner || captureOwner();
    const guardAll = () => { owner.assertActive(); if (typeof opts.guard === 'function') opts.guard(); };
    const db = await openDB();
    guardAll();
    const nowIso = new Date().toISOString();
    const tx = db.transaction(OWNER_DB.mistakes, 'readwrite');
    const os = tx.objectStore(OWNER_DB.mistakes);
    const done = txDone(tx);
    let out = null;
    try {
      const rows = await collectOwner(os, owner.ownerId);
      guardAll();
      const hit = rows.find((r) => mistakeKey(r) === key);
      if (hit) {
        const next = { ...hit, gotWrongCount: (Number(hit.gotWrongCount) || 0) + 1, answeredAt: nowIso };
        guardAll();
        os.put({ ...next, ownerId: owner.ownerId }, rowKey(owner.ownerId, hit.id));
        out = next;
      } else {
        const rec = {
          id: uuid(),
          sourceType: m.sourceType,
          paperKey: String(m.paperKey ?? ''),
          section: String(m.section ?? ''),
          qnum: m.qnum ?? null,
          stem: String(m.stem ?? '').slice(0, 200), // 題幹存前 200 字（列表只顯示前 40 字）
          wordHead: m.wordHead ? String(m.wordHead) : null, // 正解詞（選擇題；拼寫不進本 store）
          answeredAt: nowIso,
          gotWrongCount: 1,
        };
        guardAll();
        os.put({ ...rec, ownerId: owner.ownerId }, rowKey(owner.ownerId, rec.id));
        out = rec;
      }
    } catch (err) {
      try { tx.abort(); } catch { /* 已結束 */ }
      await done.catch(() => undefined);
      throw err;
    }
    await done;
    owner.assertActive(); // commit 之後、回傳之前再驗（換帳戶即拒收這個結果）
    return out;
  } catch (err) {
    console.warn('錯題記錄失敗：', err);
    return null;
  }
}

/** 同一題的識別鍵（來源＋卷別＋區段＋題號）——重建時用它回抓原題，組卷即依此比對 */
function mistakeKey(m) {
  return `${m.sourceType}|${m.paperKey}|${m.section}|${m.qnum ?? ''}`;
}
export { mistakeKey };

/** 全部錯題（最近答錯在前；只含目前 owner） */
export async function getMistakes() {
  const owner = captureOwner();
  const rows = await ownerRows(OWNER_DB.mistakes, owner);
  owner.assertActive();
  rows.sort((a, b) => (a.answeredAt < b.answeredAt ? 1 : -1));
  owner.assertActive();
  return rows;
}

/** 錯題次數加一（重考時再錯用；找不到就不動） */
export async function bumpMistake(m, opts = {}) {
  const key = mistakeKey(m);
  const owner = opts.owner || captureOwner();
  const guardAll = () => { owner.assertActive(); if (typeof opts.guard === 'function') opts.guard(); };
  const db = await openDB();
  guardAll();
  const nowIso = new Date().toISOString();
  const tx = db.transaction(OWNER_DB.mistakes, 'readwrite');
  const os = tx.objectStore(OWNER_DB.mistakes);
  const done = txDone(tx);
  let out = null;
  try {
    const rows = await collectOwner(os, owner.ownerId);
    guardAll();
    const hit = rows.find((r) => mistakeKey(r) === key);
    if (hit) {
      const next = { ...hit, gotWrongCount: (Number(hit.gotWrongCount) || 0) + 1, answeredAt: nowIso };
      guardAll();
      os.put({ ...next, ownerId: owner.ownerId }, rowKey(owner.ownerId, hit.id));
      out = next;
    }
  } catch (err) {
    try { tx.abort(); } catch { /* 已結束 */ }
    await done.catch(() => undefined);
    throw err;
  }
  await done;
  // commit 之後、回傳之前再驗一次：真 commit 無法回滾，因此換帳戶時**拒收結果**，
  // 由呼叫端（頁面／每日任務／同步）放棄這筆結果，不把它算到新帳戶頭上。
  owner.assertActive();
  return out;
}

export async function clearMistakes(opts = {}) {
  const owner = opts.owner || captureOwner();
  const db = await openDB();
  owner.assertActive();
  if (typeof opts.guard === 'function') opts.guard();
  const tx = db.transaction(OWNER_DB.mistakes, 'readwrite');
  const done = txDone(tx);
  try {
    await deleteOwner(tx.objectStore(OWNER_DB.mistakes), owner.ownerId); // 只清自己分區
  } catch (err) {
    try { tx.abort(); } catch { /* 已結束 */ }
    await done.catch(() => undefined);
    throw err;
  }
  await done;
  // commit 之後、回傳之前再驗一次：真 commit 無法回滾，因此換帳戶時**拒收結果**，
  // 由呼叫端（頁面／每日任務／同步）放棄這筆結果，不把它算到新帳戶頭上。
  owner.assertActive();
}

// ---- 雲端同步用（2.0.10） ----
// 6.2.0：匯出只含目前捕捉到的 owner；payload 不帶 ownerId（跨裝置／8 碼分享是既有功能，
//   不因隔離而改變），但寫回本機時一律落在「當下捕捉到的 owner」分區。

/** 去掉分區欄位（備份 payload 不帶 ownerId；匯入時由當下 owner 決定分區）。 */
function stripOwner(row) {
  if (!row || typeof row !== 'object') return row;
  const { ownerId, ...rest } = row;
  void ownerId;
  return rest;
}

// 匯出：原始標記記錄（含 SRS 欄位）
export async function exportMarks(opts = {}) {
  const owner = opts.owner || captureOwner();
  const rows = await getUnknownMarks();
  owner.assertActive();
  return rows.map(stripOwner);
}

// 匯出：全部單詞本（含 id）
export async function exportWordbooks(opts = {}) {
  const owner = opts.owner || captureOwner();
  const rows = await ownerRows(OWNER_DB.wordbooks, owner);
  owner.assertActive();
  return rows.map(stripOwner);
}

// 6.1.1：整批匯入前先同步驗證所有列（數值完整性、state、日期）。
// 驗證失敗在開啟寫入交易前就拋錯，故 clear 永遠不會先毀掉舊資料。
// 合法 legacy 列原樣保留（只正規化有效日期），不再用白名單砍掉欄位。
// 6.2.0：只替換「當下捕捉到的 owner」分區（不是整庫 clear）。
export async function replaceAllMarks(rows, opts = {}) {
  const normalized = normalizeMarkRecords(rows); // 先驗；拋錯時交易根本不會開
  const owner = opts.owner || captureOwner();
  const extraGuard = typeof opts.guard === 'function' ? opts.guard : null;
  const guardAll = () => { owner.assertActive(); if (extraGuard) extraGuard(); };
  const db = await openDB();
  guardAll();
  const tx = db.transaction(OWNER_DB.marks, 'readwrite');
  const os = tx.objectStore(OWNER_DB.marks);
  const done = txDone(tx);
  try {
    guardAll(); // 清空前最後一次守衛
    await deleteOwner(os, owner.ownerId);
    for (const r of normalized) os.put({ ...r, ownerId: owner.ownerId }, rowKey(owner.ownerId, r.wordId));
  } catch (err) {
    try { tx.abort(); } catch { /* 已結束 */ }
    await done.catch(() => undefined);
    throw err;
  }
  await done;
  // commit 之後、回傳之前再驗一次：真 commit 無法回滾，因此換帳戶時**拒收結果**，
  // 由呼叫端（頁面／每日任務／同步）放棄這筆結果，不把它算到新帳戶頭上。
  owner.assertActive();
  emit('store:changed', { kind: 'marks' });
  return normalized.length;
}

// 匯入：合併複習計劃——本機已有的保留，雲端有而本機沒有的加入
// 6.2.0：讀改寫在同一個交易內（避免「先讀清單、再逐筆 put」之間被另一分頁 append 蓋掉）。
export async function mergeMarks(rows, opts = {}) {
  const normalized = normalizeMarkRecords(rows);
  const owner = opts.owner || captureOwner();
  const extraGuard = typeof opts.guard === 'function' ? opts.guard : null;
  const guardAll = () => { owner.assertActive(); if (extraGuard) extraGuard(); };
  const db = await openDB();
  guardAll();
  const tx = db.transaction(OWNER_DB.marks, 'readwrite');
  const os = tx.objectStore(OWNER_DB.marks);
  const done = txDone(tx);
  let added = 0;
  try {
    const localRows = await collectOwner(os, owner.ownerId);
    guardAll();
    const localIds = new Set(localRows.map((r) => String(r.wordId)));
    for (const r of normalized) {
      if (localIds.has(String(r.wordId))) continue;
      localIds.add(String(r.wordId));
      os.put({ ...r, ownerId: owner.ownerId }, rowKey(owner.ownerId, r.wordId));
      added++;
    }
  } catch (err) {
    try { tx.abort(); } catch { /* 已結束 */ }
    await done.catch(() => undefined);
    throw err;
  }
  await done;
  // commit 之後、回傳之前再驗一次：真 commit 無法回滾，因此換帳戶時**拒收結果**，
  // 由呼叫端（頁面／每日任務／同步）放棄這筆結果，不把它算到新帳戶頭上。
  owner.assertActive();
  if (added) emit('store:changed', { kind: 'marks' });
  return added;
}

// 單詞本列的驗證（清空前先驗）：形狀不對就整個拒絕，不得先 clear 再失敗。
// 合法 legacy 列（只有 name／wordIds）照樣接受；不新增白名單砍欄位。
export function validateWordbooks(rows) {
  if (!Array.isArray(rows)) throw new Error('單詞本備份格式錯誤（應為陣列）');
  rows.forEach((r, i) => {
    const at = `單詞本備份第 ${i + 1} 筆`;
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error(`${at}格式錯誤`);
    if (r.name != null && typeof r.name !== 'string') throw new Error(`${at}名稱型別錯誤`);
    if (r.wordIds != null && !Array.isArray(r.wordIds)) throw new Error(`${at}字清單型別錯誤`);
    if (r.pendingWords != null && !Array.isArray(r.pendingWords)) throw new Error(`${at}待補清單型別錯誤`);
    if (r.id != null && String(r.id).trim() === '') throw new Error(`${at}識別碼為空`);
  });
  return rows;
}

function wordbookRow(r) {
  return {
    id: r.id || uuid(),
    name: r.name || '未命名單詞本',
    wordIds: r.wordIds || [],
    pendingWords: r.pendingWords || [],
    groupId: r.groupId ?? null,
    sort: r.sort || 'input',
    endedAt: r.endedAt || new Date().toISOString(),
    lastPracticedAt: r.lastPracticedAt || r.endedAt || new Date().toISOString(),
  };
}

// 匯入：整批替換單詞本（直接替換模式用）
// 5.0.0：pendingWords 必須進白名單，否則雲端同步後待補清單消失（spec 第 1.2 節）
// 6.2.0：先驗所有列 → 再守衛 → 只清自己分區；驗證失敗時舊資料一格都不動。
export async function replaceAllWordbooks(rows, opts = {}) {
  validateWordbooks(rows);
  const owner = opts.owner || captureOwner();
  const extraGuard = typeof opts.guard === 'function' ? opts.guard : null;
  const guardAll = () => { owner.assertActive(); if (extraGuard) extraGuard(); };
  const normalized = rows.map(wordbookRow);
  const db = await openDB();
  guardAll();
  const tx = db.transaction(OWNER_DB.wordbooks, 'readwrite');
  const os = tx.objectStore(OWNER_DB.wordbooks);
  const done = txDone(tx);
  try {
    guardAll(); // 清空前最後一次守衛
    await deleteOwner(os, owner.ownerId);
    for (const r of normalized) os.put({ ...r, ownerId: owner.ownerId }, rowKey(owner.ownerId, r.id));
  } catch (err) {
    try { tx.abort(); } catch { /* 已結束 */ }
    await done.catch(() => undefined);
    throw err;
  }
  await done;
  // commit 之後、回傳之前再驗一次：真 commit 無法回滾，因此換帳戶時**拒收結果**，
  // 由呼叫端（頁面／每日任務／同步）放棄這筆結果，不把它算到新帳戶頭上。
  owner.assertActive();
  emit('store:changed', { kind: 'wordbooks' });
  return rows.length;
}

// 匯入：合併單詞本——只加入本機沒有（id 不同）的單詞本
export async function mergeWordbooks(rows, opts = {}) {
  validateWordbooks(rows);
  const owner = opts.owner || captureOwner();
  const extraGuard = typeof opts.guard === 'function' ? opts.guard : null;
  const guardAll = () => { owner.assertActive(); if (extraGuard) extraGuard(); };
  const db = await openDB();
  guardAll();
  const tx = db.transaction(OWNER_DB.wordbooks, 'readwrite');
  const os = tx.objectStore(OWNER_DB.wordbooks);
  const done = txDone(tx);
  let added = 0;
  try {
    const localRows = await collectOwner(os, owner.ownerId);
    guardAll();
    const localIds = new Set(localRows.map((r) => String(r.id)));
    for (const r of rows) {
      const row = wordbookRow(r);
      if (localIds.has(String(row.id))) continue;
      localIds.add(String(row.id));
      os.put({ ...row, ownerId: owner.ownerId }, rowKey(owner.ownerId, row.id));
      added++;
    }
  } catch (err) {
    try { tx.abort(); } catch { /* 已結束 */ }
    await done.catch(() => undefined);
    throw err;
  }
  await done;
  // commit 之後、回傳之前再驗一次：真 commit 無法回滾，因此換帳戶時**拒收結果**，
  // 由呼叫端（頁面／每日任務／同步）放棄這筆結果，不把它算到新帳戶頭上。
  owner.assertActive();
  if (added) emit('store:changed', { kind: 'wordbooks' });
  return added;
}

// ---------- 未認領的舊資料（6.2.0 只讀盤點） ----------
// 舊庫 vocab2（v7）沒有 owner 欄位：這些資料**不屬於任何已識別帳戶**。
// 本檔只提供唯讀盤點（數量），不寫入、不刪除、不搬移、不自動改到期日，
// 也不預設歸給當前帳戶或 guest——「舊資料算誰的」是產品決策，尚未定案。
// 回傳 { available:false } 代表這個環境無法列舉資料庫（或舊庫不存在）。
export async function listUnclaimedLegacy() {
  const factory = globalThis.indexedDB;
  if (!factory) return { available: false, reason: 'no-indexedDB' };
  let names = null;
  try {
    if (typeof factory.databases === 'function') {
      const list = await factory.databases();
      names = (list || []).map((d) => d.name);
    }
  } catch {
    names = null;
  }
  const empty = { marks: 0, wordbooks: 0, groups: 0, events: 0, examMistakes: 0 };
  if (names && !names.includes(LEGACY_DB.name)) {
    return { available: true, exists: false, counts: empty };
  }
  if (!names) return { available: false, reason: 'cannot-enumerate' };
  const db = await new Promise((resolve, reject) => {
    // 只開既有版本（不帶版本號就不會觸發升級；由上面的 databases() 確認過它存在）
    const req = factory.open(LEGACY_DB.name);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('無法開啟舊本機資料庫'));
  });
  try {
    const counts = {};
    for (const name of ['marks', 'wordbooks', 'groups', 'events', 'examMistakes']) {
      if (!db.objectStoreNames.contains(name)) { counts[name] = 0; continue; }
      const tx = db.transaction(name, 'readonly');
      const req = tx.objectStore(name).count();
      let n = 0;
      req.onsuccess = () => { n = req.result; };
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error);
        tx.onerror = () => undefined;
      });
      counts[name] = n;
    }
    return { available: true, exists: true, counts };
  } finally {
    try { db.close(); } catch { /* 已關閉 */ }
  }
}

/** 目前捕捉到的 owner（供頁面顯示／除錯；不是授權憑證）。 */
export function currentOwnerId() {
  return getOwnerId() || GUEST_OWNER;
}
