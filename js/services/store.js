// ============================================================
// 使用者資料保存（IndexedDB，本機瀏覽器內）
// 2.0.2：不會單字標記；2.0.5：SRS 排程；2.0.8：具名單詞本
// 2.0.10：單詞本 id 遷移為 UUID（跨裝置同步不衝突）
// 2.0.13：學習事件記錄（統計用）
// 4.2.0：寫入成功後 emit('store:changed', {kind})，供 15 秒即時同步去抖上傳
//   （選 eventbus 而非 document CustomEvent：本專案的跨模組通訊一律走 core/eventbus.js，
//    見 core/eventbus.js 檔頭說明；addEvent 刻意不 emit——events 不進雲端備份且高頻）
// 5.0.0：單詞本新增 pendingWords（字庫外字＝待補清單），字庫收錄後由 fillPendingWordbooks 自動補進
//   （列形狀見 STORE_BOOKS 註解；本檔的「欄位白名單」重建路徑必須同步加 pendingWords，
//    否則雲端同步後待補清單會消失——這是 2.0.10 以來就有的白名單陷阱）
// ============================================================
import { emit } from '../core/eventbus.js';
import { wordIndex } from './search.js';

const DB_NAME = 'vocab2';
const DB_VERSION = 6;
const STORE_MARKS = 'marks';       // keyPath: wordId → { wordId, addedAt, stage, dueAt }
const STORE_BOOKS = 'wordbooks';   // keyPath: id(uuid) → { id, name, wordIds[], pendingWords?, groupId?, sort?, endedAt, lastPracticedAt }
const STORE_EVENTS = 'events';     // keyPath: id(auto) → { at, type, wordId?, extra? }
const STORE_GROUPS = 'groups';     // 3.0.2 分組：keyPath id(uuid) → { id, name, order }

// 產生 UUID：優先 crypto.randomUUID，舊 iOS Safari 退回手動 v4
function uuid() {
  if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) => (
    Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))
  ).toString(16));
}

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  const p = new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      // 4.1.0 修復：同步拋錯（Firefox 私密模式 SecurityError）也走同一清毒化路徑——
      // 保留原始錯誤訊息給呼叫者，並由 p.catch 解除毒化（可重試）
      reject(e);
      return;
    }
    req.onupgradeneeded = (e) => {
      const db = req.result;
      const oldVersion = e.oldVersion; // 升級「前」的版本號
      if (!db.objectStoreNames.contains(STORE_MARKS)) {
        db.createObjectStore(STORE_MARKS, { keyPath: 'wordId' });
      }
      if (!db.objectStoreNames.contains(STORE_BOOKS)) {
        db.createObjectStore(STORE_BOOKS, { keyPath: 'id' });
      } else if (oldVersion < 3) {
        // 2.0.10 遷移：舊的 autoIncrement 數字 id 改為 UUID
        const os = req.transaction.objectStore(STORE_BOOKS);
        const allReq = os.getAll();
        allReq.onsuccess = () => {
          const rows = allReq.result || [];
          os.clear();
          for (const r of rows) {
            os.put({ ...r, id: uuid() });
          }
        };
      }
      if (!db.objectStoreNames.contains(STORE_EVENTS)) {
        db.createObjectStore(STORE_EVENTS, { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORE_GROUPS)) {
        db.createObjectStore(STORE_GROUPS, { keyPath: 'id' }); // 3.0.2 分組
      }
      // 3.0.0 一次性淨空：括號共用條目拆分、字庫重編，
      // 舊的複習計劃（marks）與單詞本（wordbooks）依用戶定案全數清空
      if (oldVersion > 0 && oldVersion < 5) {
        if (db.objectStoreNames.contains(STORE_MARKS)) {
          req.transaction.objectStore(STORE_MARKS).clear();
        }
        if (db.objectStoreNames.contains(STORE_BOOKS)) {
          req.transaction.objectStore(STORE_BOOKS).clear();
        }
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // 4.1.1：版本升級時主動讓路——本分頁仍開著連線會讓另一分頁的升級卡在 blocked
      //（僅有 onblocked 的 console.warn 不足以解決）。close 後 dbPromise 仍指向已關閉的
      // 連線，故一併清空，讓下一次呼叫自動重開並觸發升級。
      db.onversionchange = () => {
        db.close();
        if (dbPromise === p) dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null; // 4.1.0 修復：開啟失敗不留毒化 promise（私密瀏覽器等情境可重試）
      reject(req.error ?? new Error('無法開啟本機資料庫'));
    };
    req.onblocked = () => console.warn('本機資料庫被其他分頁鎖住，關閉其他分頁後即可繼續。');
  });
  // 4.1.0 修復：任何失敗（同步拋錯/onerror）都由 p.catch 解除毒化——
  // 呼叫者收到原始錯誤、無未處理 rejection、且可重試
  p.catch(() => { if (dbPromise === p) dbPromise = null; });
  dbPromise = p;
  return dbPromise;
}

// marks 儲存區的寫入入口（注意：交易建立後要立刻使用，中間不可 await）
async function store(mode) {
  const db = await openDB();
  return db.transaction(STORE_MARKS, mode).objectStore(STORE_MARKS);
}

// wordbooks 儲存區的寫入入口
async function booksStore(mode) {
  const db = await openDB();
  return db.transaction(STORE_BOOKS, mode).objectStore(STORE_BOOKS);
}

function reqAsPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---- 學習事件記錄（2.0.13 統計用） ----
// type: 'card'（練習卡，wordId）| 'review'（複習評分，wordId＋extra=remembered）
//     | 'translate'（翻譯題提交，extra={words:N}）| 'wordbook-saved'
async function eventsStore(mode) {
  const db = await openDB();
  return db.transaction(STORE_EVENTS, mode).objectStore(STORE_EVENTS);
}

// 記錄事件（失敗不影響主流程，僅 console 警告）
export async function addEvent(type, wordId = null, extra = null) {
  try {
    const os = await eventsStore('readwrite');
    await reqAsPromise(os.put({ at: new Date().toISOString(), type, wordId, extra }));
  } catch (err) {
    console.warn('事件記錄失敗：', err);
  }
}

// 全部事件（舊→新）
export async function getEvents() {
  const os = await eventsStore('readonly');
  const rows = await reqAsPromise(os.getAll());
  rows.sort((a, b) => (a.at < b.at ? -1 : 1));
  return rows;
}

// ---- 不會標記 + SRS 間隔複習（2.0.5） ----
// 複習週期：標記後 1 天到期；答對依 1→3→7→14 天推進；
// 14 天階段再答對即「畢業」，自動移出不會清單。答錯回到 1 天。

export const SRS_INTERVALS = [1, 3, 7, 14]; // 天（索引＝stage）
const DAY_MS = 24 * 60 * 60 * 1000;

export async function markUnknown(wordId) {
  const now = new Date();
  const os = await store('readwrite');
  await reqAsPromise(os.put({
    wordId,
    addedAt: now.toISOString(),
    stage: 0,
    dueAt: new Date(now.getTime() + SRS_INTERVALS[0] * DAY_MS).toISOString(),
  }));
  emit('store:changed', { kind: 'mark' });
}

export async function unmarkUnknown(wordId) {
  const os = await store('readwrite');
  await reqAsPromise(os.delete(wordId));
  emit('store:changed', { kind: 'mark' });
}

export async function clearUnknown() {
  const os = await store('readwrite');
  await reqAsPromise(os.clear());
  emit('store:changed', { kind: 'marks' }); // 整批清空：數量會大減，必須走完整比對
}

// 全部標記記錄（依加入時間排序；補齊舊版記錄缺少的 SRS 欄位）
export async function getUnknownMarks() {
  const os = await store('readonly');
  const rows = await reqAsPromise(os.getAll());
  for (const r of rows) {
    if (r.stage === undefined) {
      r.stage = 0;
      r.dueAt = r.dueAt
        || new Date(new Date(r.addedAt).getTime() + SRS_INTERVALS[0] * DAY_MS).toISOString();
    }
  }
  rows.sort((a, b) => (a.addedAt < b.addedAt ? -1 : 1));
  return rows;
}

// 以 Set 形式取得已標記的 wordId（查詢/練習頁判斷用）
export async function getUnknownIds() {
  const rows = await getUnknownMarks();
  return new Set(rows.map((r) => r.wordId));
}

// 調整某字的下次複習日期（排程管理用；階段不變）
export async function updateMarkDue(wordId, dueAt) {
  const rows = await getUnknownMarks();
  const rec = rows.find((r) => r.wordId === wordId);
  if (!rec) return false;
  rec.dueAt = new Date(dueAt).toISOString();
  const os = await store('readwrite');
  await reqAsPromise(os.put(rec));
  emit('store:changed', { kind: 'mark' });
  return true;
}

// ---- SRS 複習佇列 ----

// 到期（該複習）與未到期的標記
export async function getSrsQueues() {
  const now = Date.now();
  const rows = await getUnknownMarks();
  const due = rows.filter((r) => new Date(r.dueAt).getTime() <= now);
  const upcoming = rows.filter((r) => new Date(r.dueAt).getTime() > now);
  upcoming.sort((a, b) => (a.dueAt < b.dueAt ? -1 : 1));
  return { due, upcoming };
}

// 記錄一次複習結果：remembered=true 推進階段（可能畢業），false 回到第 0 階段
export async function gradeReview(wordId, remembered) {
  // 先讀出記錄計算新狀態，最後才開寫入交易
  // （IndexedDB 交易在 await 期間會自動提交，不能開了交易才去做別的讀取）
  const rows = await getUnknownMarks();
  const rec = rows.find((r) => r.wordId === wordId);
  if (!rec) return null;

  if (!remembered) {
    rec.stage = 0;
    rec.dueAt = new Date(Date.now() + SRS_INTERVALS[0] * DAY_MS).toISOString();
    const os = await store('readwrite');
    await reqAsPromise(os.put(rec));
    emit('store:changed', { kind: 'mark' });
    return { graduated: false, stage: 0 };
  }

  const nextStage = rec.stage + 1;
  if (nextStage >= SRS_INTERVALS.length) {
    const os = await store('readwrite');
    await reqAsPromise(os.delete(wordId)); // 畢業：移出不會清單
    emit('store:changed', { kind: 'mark' });
    addEvent('graduate', wordId); // 3.0.3 起記錄畢業（統計掌握度用）
    return { graduated: true };
  }
  rec.stage = nextStage;
  rec.dueAt = new Date(Date.now() + SRS_INTERVALS[nextStage] * DAY_MS).toISOString();
  const os = await store('readwrite');
  await reqAsPromise(os.put(rec));
  emit('store:changed', { kind: 'mark' });
  return { graduated: false, stage: nextStage };
}

// ---- 具名單詞本（2.0.8） ----

// 保存一次練習收集的單詞本；回傳新記錄 id（UUID）
// 5.0.0：pendingWords（字庫外字＝待補清單）只在有值時才寫入欄位，
//   避免每一本練習產生的單詞本都多存一個空陣列（同步 payload 是整份上傳的）
export async function addWordbook({ name, wordIds, endedAt, pendingWords }) {
  const rec = {
    id: uuid(),
    name,
    wordIds,
    endedAt,
    lastPracticedAt: endedAt,
  };
  if (pendingWords && pendingWords.length) rec.pendingWords = pendingWords;
  const os = await booksStore('readwrite');
  await reqAsPromise(os.add(rec));
  emit('store:changed', { kind: 'wordbook' });
  return rec.id;
}

// 全部已保存單詞本（新的在前）
export async function getWordbooks() {
  const os = await booksStore('readonly');
  const rows = await reqAsPromise(os.getAll());
  rows.sort((a, b) => (a.endedAt > b.endedAt ? -1 : 1));
  return rows;
}

export async function deleteWordbook(id) {
  const os = await booksStore('readwrite');
  await reqAsPromise(os.delete(id));
  emit('store:changed', { kind: 'wordbook' });
}

// 記錄「最近一次練習這本單詞本」的時間
export async function touchWordbook(id) {
  const os0 = await booksStore('readonly');
  const rec = await reqAsPromise(os0.get(id));
  if (!rec) return;
  rec.lastPracticedAt = new Date().toISOString();
  const os = await booksStore('readwrite');
  await reqAsPromise(os.put(rec));
  emit('store:changed', { kind: 'wordbook' });
}

// ---- 分組與單詞本欄位（3.0.2） ----

async function groupsStore(mode) {
  const db = await openDB();
  return db.transaction(STORE_GROUPS, mode).objectStore(STORE_GROUPS);
}

export async function getGroups() {
  const os = await groupsStore('readonly');
  const rows = await reqAsPromise(os.getAll());
  rows.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return rows;
}

export async function addGroup(name) {
  const rec = { id: uuid(), name, order: Date.now() };
  const os = await groupsStore('readwrite');
  await reqAsPromise(os.put(rec));
  emit('store:changed', { kind: 'group' });
  return rec.id;
}

export async function renameGroup(id, name) {
  const os0 = await groupsStore('readonly');
  const rec = await reqAsPromise(os0.get(id));
  if (!rec) return;
  rec.name = name;
  const os = await groupsStore('readwrite');
  await reqAsPromise(os.put(rec));
  emit('store:changed', { kind: 'group' });
}

// 刪除分組：群組內單詞本退回「未分組」，不會消失
export async function deleteGroup(id) {
  const os0 = await booksStore('readonly');
  const books = await reqAsPromise(os0.getAll());
  for (const b of books) {
    if (b.groupId === id) {
      const osW = await booksStore('readwrite');
      await reqAsPromise(osW.put({ ...b, groupId: null }));
    }
  }
  const os = await groupsStore('readwrite');
  await reqAsPromise(os.delete(id));
  emit('store:changed', { kind: 'group' });
}

// 通用單詞本欄位更新（groupId／sort 等）
export async function updateWordbook(id, patch) {
  const os0 = await booksStore('readonly');
  const rec = await reqAsPromise(os0.get(id));
  if (!rec) return;
  const os = await booksStore('readwrite');
  await reqAsPromise(os.put({ ...rec, ...patch }));
  emit('store:changed', { kind: 'wordbook' });
}

// 5.0.0：把「多個 id 接在某本單詞本的字尾」當成一次增量寫入。
// 為什麼需要它：分兩段讀寫（先 readonly get、再 readwrite put）之間仍有空窗，
// 這段空窗裡若雲端快照（同步頁／帳戶頁的「替換」還原走 replaceAllWordbooks）
// 落地同一本單詞本，先讀到的 wordIds 當 patch 寫回會把對方帶來的新字蓋掉，
// 而 mergeWordbooks 只補本機沒有的 id，補不回來。
// 這裡把 get 與 put 放進**同一個 readwrite 交易**：IndexedDB 對同一 objectStore
// 的交易是序列化的，交易存續期間其他 readwrite 交易（含 replaceAllWordbooks
// 背後的 clear＋put）會被排到本交易之後才執行，故空窗不存在。
// updater 回傳 null 代表「這次不用寫」（書已被刪／字已由雲端帶進來），
// 交易正常結束、不發 put，也不 emit store:changed。
export async function appendWordIds(id, updater) {
  const db = await openDB();
  const tx = db.transaction(STORE_BOOKS, 'readwrite');
  const os = tx.objectStore(STORE_BOOKS);
  const rec = await reqAsPromise(os.get(id));
  if (!rec) return null;
  const next = updater(rec);
  if (!next) return null;
  const { __added, ...clean } = next;     // __added 只用來回報數量，不寫進資料
  await reqAsPromise(os.put(clean));
  emit('store:changed', { kind: 'wordbook' });
  return __added ?? 0;
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
// 路徑（5.0.0 的 fillPendingWordbooks／雲端合併匯入，都走 appendWordIds）append 了新字，
// 那些字不會進目標本；勾「合併後刪除來源本」時來源本隨即被刪，這些字**永久消失**，
// 而 UI 仍宣稱合併成功。純前端把「讀取」與後續「寫入」併進同一個交易是做不到的
// （IndexedDB 的交易一旦建立就只能用它自己開的請求），必須由這裡在交易內一次做完。
// 交易內的序列：get(來源) → get(目標) → put(目標) → [delete(來源)]。
// IndexedDB 對同一 objectStore 的交易是序列化的，故其他 write 路徑只可能**整個**排在它之前
// 或之後，沒有中間地帶：排在之前的 append 會被這次交易讀到（字有進目標本），
// 排在之後的 append 讀到的是已刪／未刪的來源（前者 no-op、後者字留在來源本等下次合併）。
// 回傳 { merged:false, reason, sourceName }，reason ∈ 'same-book' | 'source-missing' | 'target-missing'；
// 成功時回傳 { merged:true, added, sourceName }。
export async function mergeWordbookInto(targetId, sourceId, { dropSource = false } = {}) {
  const db = await openDB();
  const tx = db.transaction(STORE_BOOKS, 'readwrite');
  const os = tx.objectStore(STORE_BOOKS);
  // 目標與來源同一本 → 沒有東西可併，直接回「無變化」
  if (String(targetId) === String(sourceId)) {
    return { merged: false, reason: 'same-book', added: 0, sourceName: '' };
  }
  const source = await reqAsPromise(os.get(sourceId));
  if (!source) return { merged: false, reason: 'source-missing', added: 0, sourceName: '' };
  const target = await reqAsPromise(os.get(targetId));
  if (!target) return { merged: false, reason: 'target-missing', added: 0, sourceName: source.name };
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
  await reqAsPromise(os.put(merged));
  if (dropSource) await reqAsPromise(os.delete(sourceId));
  emit('store:changed', { kind: 'wordbook' });
  return { merged: true, added: addIds.length, sourceName: source.name };
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
  const books = await getWordbooks();
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

// ---- 雲端同步用（2.0.10） ----

// 匯出：原始標記記錄（含 SRS 欄位）
export async function exportMarks() {
  return getUnknownMarks();
}

// 匯出：全部單詞本（含 id）
export async function exportWordbooks() {
  const os = await booksStore('readonly');
  return reqAsPromise(os.getAll());
}

// 匯入：整批替換複習計劃（直接替換模式用）
export async function replaceAllMarks(rows) {
  const os = await store('readwrite');
  await reqAsPromise(os.clear());
  for (const r of rows) {
    os.put({
      wordId: r.wordId,
      addedAt: r.addedAt || new Date().toISOString(),
      stage: r.stage ?? 0,
      dueAt: r.dueAt || new Date().toISOString(),
    });
  }
  emit('store:changed', { kind: 'marks' });
  return rows.length;
}

// 匯入：合併複習計劃——本機已有的保留，雲端有而本機沒有的加入
export async function mergeMarks(rows) {
  const local = await getUnknownMarks();
  const localIds = new Set(local.map((r) => r.wordId));
  const os = await store('readwrite');
  let added = 0;
  for (const r of rows) {
    if (!localIds.has(r.wordId)) {
      os.put({
        wordId: r.wordId,
        addedAt: r.addedAt || new Date().toISOString(),
        stage: r.stage ?? 0,
        dueAt: r.dueAt || new Date().toISOString(),
      });
      added++;
    }
  }
  if (added) emit('store:changed', { kind: 'marks' });
  return added;
}

// 匯入：整批替換單詞本（直接替換模式用）
// 5.0.0：pendingWords 必須進白名單，否則雲端同步後待補清單消失（spec 第 1.2 節）
export async function replaceAllWordbooks(rows) {
  const os = await booksStore('readwrite');
  await reqAsPromise(os.clear());
  for (const r of rows) {
    os.put({
      id: r.id || uuid(),
      name: r.name || '未命名單詞本',
      wordIds: r.wordIds || [],
      pendingWords: r.pendingWords || [],
      groupId: r.groupId ?? null,
      sort: r.sort || 'input',
      endedAt: r.endedAt || new Date().toISOString(),
      lastPracticedAt: r.lastPracticedAt || r.endedAt || new Date().toISOString(),
    });
  }
  emit('store:changed', { kind: 'wordbooks' });
  return rows.length;
}

// 匯入：合併單詞本——只加入本機沒有（id 不同）的單詞本
export async function mergeWordbooks(rows) {
  const os = await booksStore('readonly');
  const local = await reqAsPromise(os.getAll());
  const localIds = new Set(local.map((r) => r.id));
  const osW = await booksStore('readwrite');
  let added = 0;
  for (const r of rows) {
    if (!localIds.has(r.id)) {
      osW.put({
        id: r.id || uuid(),
        name: r.name || '未命名單詞本',
        wordIds: r.wordIds || [],
        pendingWords: r.pendingWords || [],
        groupId: r.groupId ?? null,
        sort: r.sort || 'input',
        endedAt: r.endedAt || new Date().toISOString(),
        lastPracticedAt: r.lastPracticedAt || r.endedAt || new Date().toISOString(),
      });
      added++;
    }
  }
  if (added) emit('store:changed', { kind: 'wordbooks' });
  return added;
}
