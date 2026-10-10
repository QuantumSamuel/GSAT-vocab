// ============================================================
// 歷屆真題模擬考：純邏輯層（4.2.0）
// 資料來源：data/questions/real.json（real＝歷屆真題；與 AI 題庫嚴格分離）
// 本模組刻意零 DOM／零 services 依賴——可被 node 直接 import 做過濾與排序測試，
// 畫面（設定／作答／成績）一律在 js/pages/exam.js。
// ============================================================

export const REAL_URL = 'data/questions/real.json';
export const YEARS = [113, 114];
export const PAPERS = ['E1', 'E2', 'E3', 'E4', 'N1', 'N2', 'N3', 'N4'];
// 作答順序＝學測卷面順序：詞彙 → 綜合 → 文意選填 → 篇章結構 → 閱讀
export const SECTIONS = ['詞彙題', '綜合測驗', '文意選填', '篇章結構', '閱讀測驗'];
export const MINI_QUIZ_SIZE = 15;

// 剔除原因（全部視為「OCR 品質」問題，成績頁要顯示計數）
export const DROP_REASONS = {
  'no-stem': '題幹缺失',
  'no-answer': '無標準答案',
  'answer-missing': '正解不在選項中',
  'no-option-text': '選項文字全缺',
  'option-count': '選項筆數異常（不足 2 個）',
  'option-blank': '部分選項文字空白',
  'multi-answer': '多選題型（v2）',
};

export function paperKey(year, paper) {
  return `${year}${paper}`;
}

export function qPaperKey(q) {
  return `${q.year}${q.paper}`;
}

// 洗牌（Fisher-Yates；回新陣列）。本模組自帶而不 import shell.js 的 shuffle，
// 為了維持「零 DOM 依賴」的分層，讓 node 測試可以直接載入本檔。
function shuffleArr(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- 題庫載入（in-flight 去重；失敗不鎖死、可重試） ----------
let realData = null;
let realPromise = null;

export async function loadRealBank() {
  if (realData) return realData;
  if (!realPromise) {
    realPromise = (async () => {
      const res = await fetch(REAL_URL);
      if (!res.ok) throw new Error(`歷屆真題載入失敗（HTTP ${res.status}）`);
      const data = await res.json();
      if (!data || !Array.isArray(data.questions) || !data.questions.length) throw new Error('歷屆真題資料格式錯誤');
      realData = data;
      return data;
    })();
  }
  const mine = realPromise;
  try {
    return await mine;
  } finally {
    if (realPromise === mine && !realData) realPromise = null; // 失敗不鎖死；identity 檢查防交錯清
  }
}

// ---------- 品質過濾 ----------
/** 該題是否因 OCR 品質不可用；可用回 null，不可用回剔除原因代碼 */
export function dropReason(q) {
  if (!q) return 'no-stem';
  if (q.stem == null || String(q.stem).trim() === '') return 'no-stem';
  const ans = q.answer == null ? '' : String(q.answer).trim();
  if (!ans || ans === 'UNKNOWN') return 'no-answer';
  if (ans.length > 1) return 'multi-answer'; // 多選連寫：v1 不支援，整題剔除（實測 0 筆）
  const opts = Array.isArray(q.options) ? q.options : [];
  if (!opts.includes(ans)) return 'answer-missing';
  if (opts.length < 2) return 'option-count'; // 4.2.0 修復（debug sweep）：單一選項＝假題，必按必對、灌水分數
  const texts = Array.isArray(q.option_texts) ? q.option_texts : [];
  if (opts.length && texts.every((t) => !String(t ?? '').trim())) return 'no-option-text';
  // 4.2.0 修復（debug sweep）：部分選項文字空白＝畫面出現只有字母的空按鈕（甚至正解恰為空鈕）
  if (opts.some((o, i) => !String(texts[i] ?? '').trim())) return 'option-blank';
  return null;
}

export function isUsable(q) {
  return dropReason(q) === null;
}

// ---------- 排序：學年 → 卷別 → 區段 → 題組 → 題號 ----------
export function compareQuestion(a, b) {
  // 5.0：AI 題的 year 是字串 'AI'，Number('AI') 為 NaN —— NaN 為 falsy，|| 會自然落到
  // 後續比較（卷別／區段／題組／題號），行為可接受（AI 卷同 year，只靠 paper 與排序分）。
  return (Number(a.year) - Number(b.year))
    || (PAPERS.indexOf(a.paper) - PAPERS.indexOf(b.paper))
    || (SECTIONS.indexOf(a.section) - SECTIONS.indexOf(b.section))
    || ((a.group ?? 0) - (b.group ?? 0))
    || ((a.qnum ?? 0) - (b.qnum ?? 0));
}

/**
 * 組卷。
 * opts: { years:[113,114], papers:['E1','N2'], mode:'paper'|'mini', size? }
 * 回傳 { mode, papers:[key], questions:[], dropped:{total, byReason, byPaper} }
 *   mode 'paper'＝整卷模擬：只取「第一份有可用題目的勾選卷別」全部題目（單卷約 46 題）
 *   mode 'mini' ＝迷你測驗：從勾選卷別的可用題目隨機抽 size 題，再照卷面順序排
 */
export function buildExam(bank, opts = {}) {
  const years = [...new Set((opts.years && opts.years.length ? opts.years : YEARS).map(Number))];
  const allKeys = years.flatMap((y) => PAPERS.map((p) => paperKey(y, p)));
  const paperKeys = new Set(opts.papers && opts.papers.length ? opts.papers : allKeys);
  const mode = opts.mode === 'mini' ? 'mini' : 'paper';
  const size = Number(opts.size) > 0 ? Number(opts.size) : MINI_QUIZ_SIZE;

  const pool = (bank?.questions || []).filter((q) => years.includes(Number(q.year)) && paperKeys.has(qPaperKey(q)));
  const byPaperDrop = {};   // paperKey → { reasons:{code:n} }
  const usable = [];
  for (const q of pool) {
    const reason = dropReason(q);
    if (!reason) { usable.push(q); continue; }
    const key = qPaperKey(q);
    byPaperDrop[key] = byPaperDrop[key] || { reasons: {} };
    byPaperDrop[key].reasons[reason] = (byPaperDrop[key].reasons[reason] || 0) + 1;
  }
  const sorted = usable.sort(compareQuestion);

  let questions = [];
  const usedKeys = new Set();
  if (mode === 'paper') {
    if (sorted.length) {
      const key = qPaperKey(sorted[0]); // 排序後第一題＝第一份有可用題目的勾選卷別
      questions = sorted.filter((q) => qPaperKey(q) === key);
      usedKeys.add(key);
    }
  } else {
    questions = shuffleArr(sorted).slice(0, size).sort(compareQuestion);
    questions.forEach((q) => usedKeys.add(qPaperKey(q)));
  }

  const byReason = {};
  for (const key of mode === 'mini' ? paperKeys : usedKeys) {
    const r = byPaperDrop[key]?.reasons;
    if (!r) continue;
    for (const [code, n] of Object.entries(r)) byReason[code] = (byReason[code] || 0) + n;
  }
  const dropped = { total: Object.values(byReason).reduce((a, b) => a + b, 0), byReason };
  return { mode, size, papers: [...usedKeys], questions, dropped };
}

/**
 * 4.3.1 批次 5：模擬考重構——單卷三層選擇＋區段勾選＋固定順序。
 * 5.0：AI 題的 year 為字串 'AI'，故 year 不再 Number 化、比較改用 String()
 * （數字學年 113 的行為不變：String(113) === String('113')）。
 * opts: { year:Number|'AI', paper:'E1'|..|'A1'|'B1'|'V1', sections:['詞彙題',…] }
 * （中翻英未抽、閱讀測驗 real 卷本版不開放——sections 由呼叫端先過濾）
 * 回傳 { papers:[key], questions:[], dropped:{total,byReason}, groups:{key:{blanks,asked,missing}} }
 * 規則：
 *  - 依 SECTIONS 固定順序排列、不打亂（單選題→綜合測驗→文意選填→篇章結構→閱讀測驗）
 *  - 剔除的題直接跳過（不顯示）
 *  - 共用選項池題組（group!=null）：整組出現；若組內有剔除題，該空格在 passage 已存在
 *    （無法移除），呼叫端以 dropped 資訊在題目 caption/成績頁標示
 */
export function buildPaperRun(bank, opts = {}) {
  const year = opts.year;
  const paper = String(opts.paper || '');
  const sections = Array.isArray(opts.sections) && opts.sections.length ? opts.sections : SECTIONS;
  const key = paperKey(year, paper);
  const sameYear = (q) => String(q.year) === String(year);
  const pool = (bank?.questions || []).filter((q) => sameYear(q) && qPaperKey(q) === key);
  const byPaperDrop = {};
  const usable = [];
  const droppedByReason = {};
  for (const q of pool) {
    const reason = dropReason(q);
    if (!reason) { usable.push(q); continue; }
    droppedByReason[reason] = (droppedByReason[reason] || 0) + 1;
    byPaperDrop[key] = byPaperDrop[key] || { reasons: {} };
    byPaperDrop[key].reasons[reason] = (byPaperDrop[key].reasons[reason] || 0) + 1;
  }
  // 只留勾選的區段，依固定順序；剔除的組員不佔位（passage 仍在，空格視覺保留由渲染端標示）
  const secRank = (s) => SECTIONS.indexOf(s);
  const questions = usable
    .filter((q) => sections.includes(q.section))
    .sort((a, b) => (secRank(a.section) - secRank(b.section))
      || ((a.group ?? 0) - (b.group ?? 0))
      || ((a.qnum ?? 0) - (b.qnum ?? 0)));
  const total = droppedByReason && Object.values(droppedByReason).reduce((a, b) => a + b, 0);
  return {
    papers: [key],
    questions,
    dropped: { total, byReason: droppedByReason },
    meta: { year, paper, sections },
  };
}

/**
 * 4.3.1：題組完整性盤點——回傳該卷每個共用池組的「文章空格 vs 可作答題號」差集，
 * 供成績頁/題目 caption 標示「（本卷未收錄）」。回傳 [{section, group, missing:[qnum]}]。
 */
export function groupGaps(bank, year, paper) {
  const key = paperKey(year, paper);
  const pool = (bank?.questions || []).filter((q) => Number(q.year) === year && qPaperKey(q) === key);
  const gaps = [];
  const byGroup = new Map();
  for (const q of pool) {
    if (q.group == null) continue;
    if (!byGroup.has(q.group)) byGroup.set(q.group, { section: q.section, asked: new Set(), blanks: new Set() });
    const g = byGroup.get(q.group);
    if (isUsable(q)) g.asked.add(q.qnum);
    // 從 passage 抽空格編號（「NN.」或「NN．」出現在文中的數字）
    const re = /(?:^|\s)(\d{1,2})[.．]/g;
    let m;
    while ((m = re.exec(String(q.passage || ''))) !== null) {
      const n = Number(m[1]);
      if (n >= 1 && n <= 50) g.blanks.add(n);
    }
  }
  for (const [group, g] of byGroup) {
    const missing = [...g.blanks].filter((n) => !g.asked.has(n)).sort((a, b) => a - b);
    if (missing.length) gaps.push({ section: g.section, group, missing });
  }
  return gaps;
}

// ---------- 設定畫面用：各卷可用題數 ----------
export function usableCountByPaper(bank, years = YEARS) {
  const map = {};
  for (const y of years) for (const p of PAPERS) map[paperKey(y, p)] = 0;
  for (const q of bank?.questions || []) {
    const key = qPaperKey(q);
    if (!(key in map)) continue;
    if (isUsable(q)) map[key]++;
  }
  return map;
}

// ---------- 成績：各區段得分 ----------
/** qs：題目陣列；results：以題序索引的 { picked, good }（未答為空洞） */
export function sectionStats(qs, results = []) {
  const map = new Map();
  qs.forEach((q, i) => {
    if (!map.has(q.section)) map.set(q.section, { section: q.section, total: 0, correct: 0, answered: 0 });
    const s = map.get(q.section);
    s.total++;
    const r = results[i];
    if (r) { s.answered++; if (r.good) s.correct++; }
  });
  return SECTIONS.filter((s) => map.has(s)).map((s) => map.get(s));
}
