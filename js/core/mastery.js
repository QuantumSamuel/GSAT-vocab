// ============================================================
// 精熟度與首頁排版共用資料 helper（5.1.1）
// 為什麼有這個檔：spec H3 明文「W2 與 H3 共用同一支，禁止兩處各寫一份」，
//   H4 的連續天數也指定「抽到 mastery.js 一併共用」（stats.js 未 export，
//   直接 import stats.js 會把整個統計頁拉進依賴圖）。
// 純函式、零 import：資料一律由參數傳入（單詞本物件、marks 列、due 列、graduate
//   事件 id、事件列）。core 不得反向依賴 services／pages（避免循環 import），
//   也因此 node 可直接單元測（tools/smoke_511_layout.mjs）。
// ============================================================

// 116 學年度暫定日程，官方公告後更新（H4 學測倒數；官方日期自動同步為 spec 第 5 節明確不做）
export const GSAT_DATE = '2027-01-22';

// 今日目標的活動次數（H5 今日目標條）。集中定義方便日後調整；
// 調整時記得一併檢視首頁文案的「約 15 分鐘」粗估（那個數字是以 40 次為基準寫的）。
export const TODAY_GOAL = 40;

const DAY_MS = 86400000;

// 把「marks／due 的列（物件帶 wordId）」或「id 集合」正規化成字串 id 的 Set。
// 之所以兩種形狀都收：H3（home.js）拿到的是 getSrsQueues()/getUnknownMarks() 的列，
// W2（unknown.js）與測試手邊常是現成的 id 集合——同一支 helper 不該逼呼叫端先轉形。
function idSetOf(list) {
  const s = new Set();
  for (const x of list || []) {
    s.add(String(x && typeof x === 'object' ? x.wordId : x));
  }
  return s;
}

// 單詞本字 id（去重）：同一字出現多次只算一次（手動導入的單詞本可能重複）
function bookIds(book) {
  return [...idSetOf(book?.wordIds)];
}

/**
 * 單詞本的精熟度（H3 卡片牆與 W2 精熟度條共用）。
 * 精熟指該字有 graduate 事件（gradeReview 走完最後一階時記錄，見 store.js）
 * 且目前不在複習計劃（marks）——畢業後再被標記回去的字不算精熟。
 * 回傳 { grad, total, pct }：畢業字數／單字數（去重）／整數百分比（無字時 0）。
 */
export function masteryOfBook(book, marks, graduateIds) {
  const ids = bookIds(book);
  const markSet = idSetOf(marks);
  const gradSet = idSetOf(graduateIds);
  const grad = ids.filter((id) => gradSet.has(id) && !markSet.has(id)).length;
  const total = ids.length;
  return { grad, total, pct: total ? Math.round((grad / total) * 100) : 0 };
}

/**
 * 單詞本字與複習到期清單的交集數（H3 的「Due N」與 W2 共用）。
 * due 可傳 getSrsQueues().due（列）或 wordId 集合。
 */
export function dueOfBook(book, due) {
  const ids = idSetOf(book?.wordIds);
  const dueSet = idSetOf(due);
  let n = 0;
  for (const id of ids) if (dueSet.has(id)) n++;
  return n;
}

/**
 * 連續學習天數（H4）。演算法照 stats.js 的 3.0.3 版同一份（spec：不重寫成第二份）：
 * 今天還沒學不算中斷——從昨天往前數；任何活動類型都算一天。
 * events 只需要 at（ISO 字串）；now 可注入（單元測用），呼叫端省略即以現在時間計。
 */
export function streakOfEvents(events, now = new Date()) {
  const activeDays = new Set((events || []).map((e) => new Date(e.at).toDateString()));
  let streak = 0;
  const day = new Date(now);
  if (!activeDays.has(day.toDateString())) day.setDate(day.getDate() - 1);
  while (activeDays.has(day.toDateString())) {
    streak++;
    day.setDate(day.getDate() - 1);
  }
  return streak;
}

/**
 * 學測倒數天數（H4）：今天零點到 GSAT_DATE 零點的天數差。
 * 當天為 0；過期顯示 0 不負數（spec 明文）。
 */
export function gsatDaysLeft(now = new Date()) {
  const todayMid = new Date(now);
  todayMid.setHours(0, 0, 0, 0);
  // 無時區後綴的 ISO 日期字串會以本地時區解析，與 todayMid 同基準（不經 UTC 轉換）
  const gsatMid = new Date(`${GSAT_DATE}T00:00:00`);
  return Math.max(0, Math.ceil((gsatMid.getTime() - todayMid.getTime()) / DAY_MS));
}
