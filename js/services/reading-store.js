// ============================================================
// 閱讀模式本機儲存（6.2.0）：原生 IndexedDB、owner-keyed 狀態
//
// 【為什麼不用 localStorage，也不只靠單一 JS 環境的 promise 佇列】
//   上一版把「每個 owner 一把 localStorage key」配一條模組內 promise 佇列，
//   確實修掉了「同一個 JS 環境裡兩筆並行寫入互相覆寫」的 11 個反例；
//   但佇列只存在於「這個模組實例」：
//     兩個獨立分頁（兩個模組實例）共用同一份 localStorage 時
//       Promise.all([addEntry('user:A','book',alpha), addEntry('user:A','known',beta)])
//     仍是 book=[]、known=[beta]。單實例互斥不是跨分頁安全。
//   現在改用瀏覽器原生的 IndexedDB：
//     · 一個資料庫 vocab2_reading，兩個 object store：
//         state（key＝ownerId → 完整閱讀狀態）
//         migration（key＝ownerId → 遷移標記）
//     · 每一次「讀－改－寫」都放在同一個 readwrite 交易裡（read-modify-write inside tx）。
//       IndexedDB 對同一組 object store 的 readwrite 交易本身就是跨分頁／跨模組實例
//       串行執行的（由瀏覽器排隊），所以後一筆一定看得到前一筆已 commit 的結果，
//       不會再用舊快照整份覆寫。這不是另一本模組內的 Map，也不是 WebLocks。
//     · 成功只認「交易 commit 完成」（tx.oncomplete）；交易中止／寫入丟錯一律 reject，
//       不假裝成功，也不會留下半套資料。
//   注意：WebLocks 缺少時不做任何降級或停用；本檔完全不需要 WebLocks。
//   注意：跨裝置同步未做（IndexedDB 是本機的）；雲端同步另案，不在此宣稱。
//
// 【為什麼不寫既有 marks／wordbooks／events】
//   6.1.2 的 store.js 是同一個 IndexedDB 資料庫，marks／wordbooks／events 都沒有 owner 欄位；
//   同一個瀏覽器換帳號時資料是共用的。閱讀模式的收藏／已懂若寫進去，A 的收藏會出現在 B 的
//   畫面。因此本檔獨立一個資料庫、每個 owner 一筆記錄，不共用、不改既有 store.js。
//
// 【既有 localStorage 閱讀資料的遷移（同 owner 首次使用）】
//   舊版 key：vocab2_reading_v1:<encodeURIComponent(ownerId)>（明確屬於某個 owner）。
//   第一次為某 owner 讀寫時，在「同一個 readwrite 交易」裡：
//     · 先看該 owner 是否已有 IndexedDB 記錄 → 有就只用那份，不用舊值覆寫。
//     · 再看遷移標記 → 已標記就跳過（所以重整、重開分頁都不會倒灌舊值）。
//     · 都沒有才把舊 key 的收藏／已懂／文章／lastBatch 正規化後寫入，並寫下標記。
//     · 舊 key 原值不刪（只讀不寫），其他 owner 的 key 一律不碰，全域舊 SRS／單詞本不認領。
//   兩分頁同時首次開啟時，兩個交易由 IndexedDB 排隊：先 commit 的寫標記＋資料，
//   後進來的看到標記或既有記錄就只讀不覆寫，所以不會把較新的資料蓋回舊值。
//
// 【owner 與 generation 守衛】
//   每筆寫入都可帶 guard（頁面提供：owner／頁面 generation 一變就丟錯）。
//   交易內在「讀到資料之後」與「真正落地之前」各驗一次；guard 失敗就 abort 交易，
//   這次寫入不會落盤。頁面層另外在 await 回來後再驗一次，避免把舊結果畫回新頁。
//   不同 owner 各一條模組內佇列（只影響本環境的排隊順序）；跨分頁的真正互斥由
//   IndexedDB 交易負責。
// ============================================================

export const READING_NS = 'vocab2_reading_v1';
export const BUCKETS = ['book', 'review', 'known'];

/** 資料庫結構（測試與除錯用；產品程式只透過本檔函式存取）。 */
export const READING_DB = {
  name: 'vocab2_reading',
  version: 1,
  records: 'state',
  migrations: 'migration',
};

const nowIso = () => new Date().toISOString();

function cleanOwner(ownerId) {
  const id = String(ownerId ?? '').trim();
  if (!id) throw new Error('缺少帳戶識別，閱讀收藏未寫入');
  return id;
}

/** 測試與除錯用：舊版 localStorage 的 owner key（owner 之間絕不共用）。 */
export function ownerStorageKey(ownerId) {
  return `${READING_NS}:${encodeURIComponent(cleanOwner(ownerId))}`;
}

/** 某 owner 的空狀態（頁面在資料庫暫時無法使用時也要有安全的空殼可畫）。 */
export function emptyState(ownerId) {
  return { v: 1, ownerId, book: [], review: [], known: [], article: null, lastBatch: null, updatedAt: null };
}

function cleanEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const key = String(raw.key ?? '').trim();
  if (!key) return null;
  const wordId = Number.isInteger(Number(raw.wordId)) && Number(raw.wordId) > 0 ? Number(raw.wordId) : null;
  const entry = {
    key,
    wordId,
    word: String(raw.word ?? '').slice(0, 120),
    at: typeof raw.at === 'string' && raw.at ? raw.at : nowIso(),
  };
  // 6.2.0：「加入複習」真的寫進複習排程（store.markUnknown）。這裡記下這張卡是不是
  //   「閱讀頁這次建立的」，撤回時才不會把使用者原本就有的複習卡刪掉。
  if (raw.madeMark === true) entry.madeMark = true;
  return entry;
}

function cleanArticle(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = typeof raw.text === 'string' ? raw.text : '';
  if (!text.trim()) return null;
  const source = raw.source === 'archive' ? 'archive' : 'paste';
  return {
    source,
    title: String(raw.title ?? '').slice(0, 200),
    text,
    meta: String(raw.meta ?? '').slice(0, 200),
    archiveId: raw.archiveId ? String(raw.archiveId).slice(0, 120) : null,
    at: typeof raw.at === 'string' && raw.at ? raw.at : nowIso(),
  };
}

function cleanBatch(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.keys)) return null;
  const keys = [...new Set(raw.keys.map((k) => String(k ?? '').trim()).filter(Boolean))];
  if (!keys.length) return null;
  return { keys, at: typeof raw.at === 'string' && raw.at ? raw.at : nowIso() };
}

function normalize(ownerId, data) {
  const state = emptyState(ownerId);
  if (!data || typeof data !== 'object') return state;
  for (const bucket of BUCKETS) {
    const seen = new Set();
    const list = Array.isArray(data[bucket]) ? data[bucket] : [];
    for (const item of list) {
      const entry = cleanEntry(item);
      if (!entry || seen.has(entry.key)) continue;
      seen.add(entry.key);
      state[bucket].push(entry);
    }
  }
  state.article = cleanArticle(data.article);
  state.lastBatch = cleanBatch(data.lastBatch);
  state.updatedAt = typeof data.updatedAt === 'string' ? data.updatedAt : null;
  return state;
}

// ---------- 資料庫連線 ----------

let dbPromise = null;
let dbRef = null; // 快取中那條連線（用來判斷該不該清掉快取）

function idbFactory() {
  const factory = globalThis.indexedDB;
  if (!factory) throw new Error('此環境不支援 IndexedDB，閱讀本機資料無法讀寫');
  return factory;
}

/** 只有「快取還指著這條連線」才清：不要把後來成功建立的新連線一起清掉。 */
function forgetDb(db) {
  if (dbRef === db) {
    dbRef = null;
    dbPromise = null;
  }
}

// 注意（暫時性失敗必須可重試）：
//   Promise 執行器是「同步」執行的，所以在執行器內把 dbPromise 設回 null 沒有用：
//   外層 `dbPromise = attempt` 的 assignment 在執行器之後才跑，會把 null 覆寫成那顆
//   已 rejected 的 Promise，於是之後每一次呼叫都直接回同一個舊錯誤、永遠不重試。
//   因此改成本檔的寫法：
//     · 同步失敗用 syncFailed 記住，等 assignment 之後才清空；
//     · 非同步失敗（request.onerror）由 attempt.catch 清空；
//     · 兩者都只在「快取仍是這一次」時清，避免清掉後來成功的新連線。
//   失敗一律如實 reject（不假成功），但下一次呼叫一定會重新開啟。
function openDb() {
  if (dbPromise) return dbPromise;
  let syncFailed = false;
  const attempt = new Promise((resolve, reject) => {
    let req;
    try {
      req = idbFactory().open(READING_DB.name, READING_DB.version);
    } catch (err) {
      syncFailed = true; // 真正的清空在 assignment 之後（見上）
      reject(err);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(READING_DB.records)) db.createObjectStore(READING_DB.records);
      if (!db.objectStoreNames.contains(READING_DB.migrations)) db.createObjectStore(READING_DB.migrations);
    };
    req.onsuccess = () => {
      const db = req.result;
      // 其他分頁要升級版本時先讓路（自己不卡住別人），下次再用新連線。
      db.onversionchange = () => { try { db.close(); } catch { /* 已關閉 */ } forgetDb(db); };
      db.onclose = () => forgetDb(db);
      dbRef = db;
      resolve(db);
    };
    req.onerror = () => reject(req.error || new Error('無法開啟閱讀本機資料庫'));
  });
  dbPromise = attempt;
  if (syncFailed) dbPromise = null; // assignment 之後才清，下次呼叫才會真的重開
  // 任何失敗都清快取（下一次重新嘗試）；也順便讓這顆 Promise 有處理器，不產生未處理拒絕。
  attempt.catch(() => {
    if (dbPromise === attempt) {
      dbRef = null;
      dbPromise = null;
    }
  });
  return attempt;
}

/** 舊版 owner-scoped localStorage 內容（只讀；找不到／壞掉都回 null，不刪原值）。 */
function readLegacyState(id) {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return null;
    const raw = storage.getItem(ownerStorageKey(id));
    if (raw === null) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    return data;
  } catch {
    return null;
  }
}

function abortQuietly(tx) {
  try { tx.abort(); } catch { /* 交易已結束 */ }
}

/** 把寫入層的錯誤轉成使用者看得懂、且不假裝成功的訊息（守衛錯誤原樣保留）。 */
function persistError(err, kind = '本機儲存失敗，這次變更沒有保存') {
  const msg = String(err?.message || err || '');
  if (/OWNER_CHANGED|GUARD/.test(msg)) return err instanceof Error ? err : new Error(msg);
  return new Error(msg ? `${kind}（${msg}）` : kind);
}

function assertGuard(guard) {
  if (typeof guard === 'function') guard();
}

/**
 * 讀取某 owner 的閱讀狀態。
 * 改為 async：IndexedDB 沒有同步讀；頁面必須在 await 之後再驗 owner／generation。
 * 首次使用會在同一個交易內做一次舊 localStorage 遷移（見檔頭）。
 */
export async function readState(ownerId) {
  const id = cleanOwner(ownerId);
  const db = await openDb();
  const record = await getRecord(db, id);
  if (record.found) return normalize(id, record.raw);
  return migrateOnce(db, id);
}

function getRecord(db, id) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(READING_DB.records, 'readonly');
    } catch (err) {
      reject(err);
      return;
    }
    const req = tx.objectStore(READING_DB.records).get(id);
    let value;
    let found = false;
    req.onsuccess = () => {
      found = req.result !== undefined;
      value = req.result;
    };
    tx.oncomplete = () => resolve({ found, raw: value });
    tx.onabort = () => reject(tx.error || new Error('閱讀本機資料讀取失敗'));
    // onerror 之後一定接 onabort；不重複 reject。
    tx.onerror = () => undefined;
  });
}

/**
 * 首次使用：在單一 readwrite 交易內「只做一次」遷移。
 * 已標記 → 直接讀現值；已有記錄 → 只補標記，不用舊值覆寫；都沒有才寫入遷移值。
 */
function migrateOnce(db, id) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction([READING_DB.records, READING_DB.migrations], 'readwrite');
    } catch (err) {
      reject(err);
      return;
    }
    const states = tx.objectStore(READING_DB.records);
    const marks = tx.objectStore(READING_DB.migrations);
    let state = null;
    let failure = null;
    const fail = (err) => { failure = failure || err; abortQuietly(tx); };

    const markReq = marks.get(id);
    markReq.onsuccess = () => {
      const already = Boolean(markReq.result);
      const curReq = states.get(id);
      curReq.onsuccess = () => {
        try {
          const existing = curReq.result;
          if (existing !== undefined) {
            // 已經有（較新的）資料：只補標記，絕不拿舊 localStorage 蓋回去。
            state = normalize(id, existing);
            if (!already) marks.put({ at: nowIso(), source: 'existing' }, id);
            return;
          }
          const legacy = already ? null : readLegacyState(id);
          state = normalize(id, legacy);
          state.updatedAt = state.updatedAt || nowIso();
          states.put(state, id);
          if (!already) marks.put({ at: nowIso(), source: legacy ? 'legacy' : 'empty' }, id);
        } catch (err) {
          fail(err);
        }
      };
      curReq.onerror = () => fail(curReq.error || new Error('閱讀本機資料讀取失敗'));
    };
    markReq.onerror = () => fail(markReq.error || new Error('閱讀本機遷移標記讀取失敗'));
    tx.oncomplete = () => {
      if (state) resolve(state);
      else reject(failure || new Error('閱讀本機資料遷移未完成'));
    };
    tx.onabort = () => reject(failure || tx.error || new Error('閱讀本機資料遷移失敗'));
    tx.onerror = () => undefined;
  });
}

/**
 * 在「同一個 readwrite 交易」內做 read-modify-write：
 *   get 狀態 →（必要時同交易內遷移）→ fn(state) → guard → put。
 * 交易跨分頁由 IndexedDB 排隊，所以同 owner 的並行寫入不會用舊快照覆寫；
 * 只有 tx.oncomplete（真的 commit）才回成功；guard 失敗或寫入錯誤一律 abort＋reject。
 */
function runReadModifyWrite(db, id, fn, guard) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction([READING_DB.records, READING_DB.migrations], 'readwrite');
    } catch (err) {
      reject(err);
      return;
    }
    const states = tx.objectStore(READING_DB.records);
    const marks = tx.objectStore(READING_DB.migrations);
    let settled = false;
    let finalState = null;
    let finalResult;
    let failure = null;

    const done = (settle, value) => {
      if (settled) return;
      settled = true;
      settle(value);
    };
    const fail = (err) => { failure = failure || err; abortQuietly(tx); };
    const guardOk = () => {
      try {
        assertGuard(guard);
        return true;
      } catch (err) {
        fail(err);
        return false;
      }
    };

    const markReq = marks.get(id);
    markReq.onsuccess = () => {
      const already = Boolean(markReq.result);
      const curReq = states.get(id);
      curReq.onsuccess = () => {
        try {
          const existing = curReq.result;
          let base;
          if (existing !== undefined) {
            base = normalize(id, existing);
            if (!already) marks.put({ at: nowIso(), source: 'existing' }, id);
          } else {
            const legacy = already ? null : readLegacyState(id);
            base = normalize(id, legacy);
            if (!already) marks.put({ at: nowIso(), source: legacy ? 'legacy' : 'empty' }, id);
          }
          // 「讀完資料」之後再驗一次 owner／generation：等待期間換帳戶就不改也不寫。
          if (!guardOk()) return;
          const result = fn(base);
          // 「真正落地前」最後一次：守衛失敗就 abort，這筆不會有任何一半寫入。
          if (!guardOk()) return;
          base.updatedAt = nowIso();
          states.put(base, id);
          finalState = base;
          finalResult = result;
        } catch (err) {
          fail(err);
        }
      };
      curReq.onerror = () => fail(curReq.error || new Error('閱讀本機資料讀取失敗'));
    };
    markReq.onerror = () => fail(markReq.error || new Error('閱讀本機遷移標記讀取失敗'));

    tx.oncomplete = () => {
      if (failure) { done(reject, persistError(failure)); return; }
      if (!finalState) { done(reject, new Error('本機儲存交易未完成，這次變更沒有保存')); return; }
      done(resolve, { state: finalState, result: finalResult });
    };
    tx.onabort = () => {
      const err = failure || tx.error || new Error('本機儲存交易中止，這次變更沒有保存');
      done(reject, persistError(err));
    };
    tx.onerror = () => undefined; // 統一由 onabort 收尾
  });
}

// ---------- 模組內佇列（只負責本環境的排隊順序；跨分頁互斥靠 IndexedDB 交易） ----------

const writeQueues = new Map();

function enqueueWrite(ownerKey, task) {
  const prior = writeQueues.get(ownerKey) || Promise.resolve();
  // 前筆無論成功或失敗，這一筆都要跑（錯誤只回報給前筆自己的呼叫端）。
  const run = prior.then(() => task(), () => task());
  const tail = run.then(() => undefined, () => undefined);
  writeQueues.set(ownerKey, tail);
  tail.then(() => {
    if (writeQueues.get(ownerKey) === tail) writeQueues.delete(ownerKey);
  });
  return run;
}

async function mutate(ownerId, fn, { guard } = {}) {
  const id = cleanOwner(ownerId);
  assertGuard(guard); // 呼叫當下：已經換帳戶／離頁就別排隊
  return enqueueWrite(id, async () => {
    assertGuard(guard); // 排到隊首：等待期間換帳戶就不讀也不寫
    const db = await openDb();
    return runReadModifyWrite(db, id, fn, guard);
  });
}

// ---------- 對外操作 ----------

/** 新增或更新一筆收藏（book／review／known）。重複 key 不新增第二筆。 */
export function addEntry(ownerId, bucket, entry, opts = {}) {
  if (!BUCKETS.includes(bucket)) return Promise.reject(new Error('未知的收藏分類'));
  const clean = cleanEntry(entry);
  if (!clean) return Promise.reject(new Error('收藏內容不完整'));
  return mutate(ownerId, (state) => {
    if (!state[bucket].some((e) => e.key === clean.key)) state[bucket].push(clean);
    return state[bucket].find((e) => e.key === clean.key);
  }, opts);
}

/** 撤回單筆收藏（三個清單都可）。找不到就原樣回傳，不報錯。 */
export function removeEntry(ownerId, bucket, key, opts = {}) {
  if (!BUCKETS.includes(bucket)) return Promise.reject(new Error('未知的收藏分類'));
  const wanted = String(key ?? '');
  return mutate(ownerId, (state) => {
    state[bucket] = state[bucket].filter((e) => e.key !== wanted);
    // 撤回已懂時，若它正好是上一次批次的成員，批次紀錄同步縮小，避免「撤回後再按整批撤回」無效。
    if (bucket === 'known' && state.lastBatch) {
      state.lastBatch.keys = state.lastBatch.keys.filter((k) => k !== wanted);
      if (!state.lastBatch.keys.length) state.lastBatch = null;
    }
    return state[bucket];
  }, opts);
}

/**
 * 批次標示已懂：只加入「原本不在已懂清單」的字，並記下 lastBatch 供整批撤回。
 * 回傳 { state, result:{added:[key...]} }；added 為空代表這次沒有新增任何字。
 */
export function applyKnownBatch(ownerId, entries, opts = {}) {
  const list = (Array.isArray(entries) ? entries : []).map(cleanEntry).filter(Boolean);
  return mutate(ownerId, (state) => {
    const have = new Set(state.known.map((e) => e.key));
    const added = [];
    for (const entry of list) {
      if (have.has(entry.key)) continue;
      have.add(entry.key);
      state.known.push(entry);
      added.push(entry.key);
    }
    // 只有真的加入新字才換掉 lastBatch；沒有新增時保留上一次批次，
    // 否則「重複按確認」（或全部字已在清單）會把還能撤回的批次紀錄清掉。
    if (added.length) state.lastBatch = { keys: added, at: nowIso() };
    return { added };
  }, opts);
}

/** 撤回上一次批次：只移除那一批實際加入的字（不影響先前就已懂的字）。 */
export function undoLastBatch(ownerId, opts = {}) {
  return mutate(ownerId, (state) => {
    const batch = state.lastBatch;
    if (!batch) return { removed: [] };
    const drop = new Set(batch.keys);
    const removed = state.known.filter((e) => drop.has(e.key)).map((e) => e.key);
    state.known = state.known.filter((e) => !drop.has(e.key));
    state.lastBatch = null;
    return { removed };
  }, opts);
}

/** 保存目前文章（貼上或考古題）。article 傳 null＝清除。貼上全文原樣保存，不改寫。 */
export function saveArticle(ownerId, article, opts = {}) {
  const clean = article ? cleanArticle(article) : null;
  if (article && !clean) return Promise.reject(new Error('文章內容是空的'));
  return mutate(ownerId, (state) => {
    state.article = clean;
    return state.article;
  }, opts);
}
