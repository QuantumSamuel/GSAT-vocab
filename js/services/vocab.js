// ============================================================
// 字庫資料（全站共用，只載入一次）
//
// 回傳契約（4.1.1 統一声明；改動前請先讀這裡）
//   loadWords()      → 回傳「字單物件陣列」；失敗拋出（呼叫端以 try/catch 顯示提示）
//   loadExam()       → 回傳「考題資料物件」（缺鍵以 makeEmptyExam() 補齊）；
//                      失敗拋出前會自動改成回傳空殼物件——呼叫端永不因它 throw
//   loadSentences()  → 回傳「例句表物件」（wordId 字串 → [{en, zh}]）；
//                      失敗僅 console.warn 並回傳 undefined，呼叫端不需 try/catch
//   loadCollocations() → 回傳 undefined；片語資料改由 getCollocationsFor() 讀取
// 三者皆為 in-flight 去重：同一時間的並行呼叫共用同一個 fetch，失敗不鎖死、可重試。
// ============================================================
let words = null; // 單字陣列
let meta = null;  // 字庫資訊（來源、產生日期等）
let sentences = null; // 例句表：wordId → [{en, zh}]（懶載入）

let wordsPromise = null;
export async function loadWords() {
  if (words) return words;
  if (!wordsPromise) {
    wordsPromise = (async () => {
      const res = await fetch('data/words.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(`載入字庫失敗（HTTP ${res.status}）`);
      const data = await res.json();
      // 4.1.0 修復：空/壞字庫不得靜默通過（會把空索引永久快取）
      if (!data || !Array.isArray(data.words) || !data.words.length) throw new Error('字庫資料格式錯誤');
      words = data.words;
      meta = data.meta ?? {};
      return words;
    })();
  }
  const mine = wordsPromise;
  try {
    return await mine;
  } finally {
    if (wordsPromise === mine && !words) wordsPromise = null; // 失敗不鎖死；identity 檢查防交錯誤清
  }
}

export function getWords() {
  if (!words) throw new Error('字庫尚未載入，請先呼叫 loadWords()');
  return words;
}

export function getMeta() {
  return meta;
}

// 例句（2.0.7）：查詢頁用到時才載入；載入失敗不影響其他功能
// 4.1.1：比照 loadWords 的 wordsPromise 加 in-flight 去重——查詢頁連續輸入會多次觸發，
// 未去重時同一份 sentences.json 會被重複抓取
let sentencesPromise = null;
export async function loadSentences() {
  if (sentences) return sentences;
  if (!sentencesPromise) {
    sentencesPromise = (async () => {
      const res = await fetch('data/sentences.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(res.status);
      const data = await res.json();
      if (!data || typeof data.sentences !== 'object' || data.sentences === null || !Object.keys(data.sentences).length) throw new Error('例句資料格式錯誤'); // 4.1.0：空殼同樣視為失敗
      sentences = data.sentences;
      return sentences;
    })();
  }
  const mine = sentencesPromise;
  try {
    return await mine;
  } catch (err) {
    console.warn('例句載入失敗（下次查詢時重試）：', err); // 4.1.0：失敗不寫入空殼，保留重試機會
    return undefined; // 失敗不拋出（既有呼叫端 lookup.js 只 await、不處理回傳）
  } finally {
    if (sentencesPromise === mine && !sentences) sentencesPromise = null; // 失敗不鎖死；identity 檢查防交錯誤清
  }
}

export function getSentencesFor(wordId) {
  return sentences?.[String(wordId)] ?? [];
}

// 片語/搭配詞（2.0.9）：AI 生成，進度會持續增加 → 每次進查詢頁都重新抓取
let collocations = null;

export async function loadCollocations() {
  try {
    const res = await fetch('data/collocations.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status);
    collocations = (await res.json()).collocations;
  } catch (err) {
    console.warn('片語資料載入失敗：', err);
    collocations = collocations ?? {}; // 離線時沿用已載入的內容
  }
}

export function getCollocationsFor(wordId) {
  return collocations?.[String(wordId)] ?? [];
}

// ---------- 考題資料（4.0.1）：exam.json 懶載入（星級／考題例句／形近字） ----------
// 不入 SW 預取（1.2MB，效能鐵律）：首次用到才抓，離線時此區自動隱藏
let examData = null;
// 4.1.0：EMPTY_EXAM 改為工廠函式 makeEmptyExam()（見 loadExam）——共用常數會讓巢狀物件被參考污染
let examPromise = null;
// 4.1.1：失敗後的短暫冷卻——查詢頁每次 showWord 都會呼叫 loadExam()，
// examPromise 失敗即清（為可重試）會讓離線/後端異常時反覆重抓 1.6MB。
// 冷卻窗內直接回空殼，恢復後由後續呼叫正常重試。
const EXAM_RETRY_COOLDOWN_MS = 60000;
let examFailAt = null;
export async function loadExam() {
  if (examData) return examData;
  if (examFailAt !== null && Date.now() - examFailAt < EXAM_RETRY_COOLDOWN_MS) {
    return makeEmptyExam(); // 冷卻中：不再發請求
  }
  if (examPromise) {
    const r = await examPromise;
    if (r.ok) return r.data;
    return makeEmptyExam(); // 失敗：每位呼叫者取得獨立空殼，杜絕參考共用
  }
  examPromise = (async () => {
    try {
      const res = await fetch('data/exam.json', { cache: 'no-cache' });
      if (!res.ok) return { ok: false };
      const src = await res.json();
      // 4.1.0 修復：以 src 為底補齊缺鍵（保留 meta 等全部來源欄位），null 值正規化為空物件
      const data = { ...makeEmptyExam(), ...src };
      for (const k of Object.keys(data)) {
        if (data[k] === null) data[k] = makeEmptyExam()[k] ?? {};
      }
      examData = data;
      return { ok: true, data: examData };
    } catch {
      // 取捨說明（冷眼複核建議記錄）：失敗不快取是為了「恢復後可重試」；離線場景 fetch 快速失敗不會真傳 1.6MB，正確性優先於流量
      return { ok: false };
    }
  })();
  const mine = examPromise;
  const r = await mine;
  // 4.1.1：失敗才清，且僅建立者清（identity 檢查）；同時記錄失敗時間供冷卻判斷
  if (examPromise === mine && !r.ok) {
    examPromise = null;
    examFailAt = Date.now();
  }
  return r.ok ? r.data : makeEmptyExam();
}

// 4.1.0：改用工廠函式——每次 fallback 取得獨立物件，避免巢狀結構被共用參考污染
function makeEmptyExam() {
  return { stars: {}, examSentences: {}, lookalikes: {}, synonyms: {}, synonymsTentative: {}, roots: {}, sensesReview: {}, sentenceZh: {} };
}
export function getExam() { return examData; }

// 單字卡的星級數（UI 與資料端共用）：0 顆回 0，由呼叫端決定是否顯示
// 4.2.0：UI 改用 core/ui.js 的 starsSvg() 畫星；examStarsText（⭐.repeat）已移除（emoji 禁令、零呼叫死碼）
export function examStarCount(w) {
  return examData?.stars?.[String(w.id)] ?? 0;
}
