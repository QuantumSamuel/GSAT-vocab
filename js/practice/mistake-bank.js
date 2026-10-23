// ============================================================
// 錯題本資料層（5.0.x；spec 4.0/5.7-50x-features-spec.md 第 3 節）
//
// 職責：
//   ① 由錯題紀錄（store.js 的 examMistakes）**重建原題**（題目必須能在作答引擎跑，
//      不能只存一段題幹文字——否則「錯題當卷重考」無題可答）。
//   ② 分頁：來源（真題／AI）× 區段（spec 指定的分頁維度）。
//   ③ 「錯題當卷重考」組卷，上限 20 題（spec 明訂）。
//
// 為什麼是獨立模組：資料重建牽涉 real.json／AI 題庫兩個資料源與 exam-data 的排序規則，
//   放在 pages 層會讓頁面檔膨脹；本檔零 DOM，可被 node 直接測。
//
// 【範圍】spec 第 3 節只列 real（歷屆真題）與 ai（AI 題庫）；考古題（archive）與
//   選擇練習的自製題不進錯題本（單字／自造題的錯誤走 SRS）。此限制是刻意的。
// 【雲端】錯題本只存本機、不進雲端同步（spec 第 3 節明示暫緩）。
// ============================================================
import { getMistakes } from '../services/store.js';
import { loadRealBank } from './exam-data.js';
import { loadAiBank } from './ai-bank.js';

// 錯題當卷重考的題數上限（spec 第 3 節明訂）
export const MISTAKE_RETRY_LIMIT = 20;
// 區段的顯示順序（沿用 SECTIONS 的學測卷面順序；排序 import 成本低，直接寫在此）
const SECTION_ORDER = ['詞彙題', '綜合測驗', '文意選填', '篇章結構', '閱讀測驗'];

/** 錯題的分頁鍵（來源 × 區段）；空區段不產生分頁。 */
export function mistakePages(rows) {
  const byKey = new Map();
  for (const r of rows || []) {
    const src = r.sourceType === 'ai' ? 'ai' : 'real';
    const section = String(r.section || '未標區段');
    const key = `${src}|${section}`;
    if (!byKey.has(key)) byKey.set(key, { key, sourceType: src, section, items: [] });
    byKey.get(key).items.push(r);
  }
  const rank = (s) => {
    const i = SECTION_ORDER.indexOf(s);
    return i < 0 ? SECTION_ORDER.length : i;
  };
  return [...byKey.values()].sort((a, b) =>
    (a.sourceType === b.sourceType ? 0 : (a.sourceType === 'real' ? -1 : 1)) || (rank(a.section) - rank(b.section)));
}

/** 同一分頁內，依題號排序（題號缺漏的排最後） */
function byQnum(a, b) {
  const x = Number.isFinite(Number(a.qnum)) ? Number(a.qnum) : Infinity;
  const y = Number.isFinite(Number(b.qnum)) ? Number(b.qnum) : Infinity;
  return x - y;
}

/**
 * 由錯題紀錄重建原題。回傳 Map(mistakeKey → 原題物件)。
 * 題目已不存在於該來源題庫（題庫改版、該卷被下架）者不被重建，呼叫端據此略過。
 * 載入失敗（離線／題庫檔缺）回空 Map——UI 顯示「無法重建題目」而不是壞掉。
 */
export async function rebuildQuestions(rows) {
  const want = rows || [];
  if (!want.length) return new Map();
  const out = new Map();
  const need = (t) => want.some((r) => (r.sourceType === 'ai' ? 'ai' : 'real') === t);
  const key = (r) => mistakeKeyOf(r);
  try {
    if (need('real')) {
      const bank = await loadRealBank();
      for (const q of bank?.questions || []) {
        out.set(`real|${q.year}${q.paper}|${q.section}|${q.qnum ?? ''}`, q);
      }
    }
  } catch { /* 真題庫載不到：AI 部分仍可重建 */ }
  try {
    if (need('ai')) {
      const ai = await loadAiBank();
      for (const q of ai?.questions || []) {
        out.set(`ai|AI ${String(q.paper || 'A1').replace(/^AI/, '')}|${q.section}|${q.qnum ?? ''}`, q);
      }
    }
  } catch { /* AI 題庫載不到 */ }
  return new Map(want.map((r) => [key(r), out.get(key(r))]).filter(([, q]) => q));
}

/** 與 store.js mistakeKey 同一形狀（此處不 import store：頁面層與資料層都不該為了一個字串格式互相依賴） */
function mistakeKeyOf(m) {
  return `${m.sourceType}|${m.paperKey}|${m.section}|${m.qnum ?? ''}`;
}

/**
 * 錯題當卷重考：組一份 run（形狀同 exam.js 的 buildPaperRun 輸出）。
 * 上限 MISTAKE_RETRY_LIMIT 題；依「錯誤次數由多到少 → 題號」排序（先練最容易再錯的）。
 * 回傳 { run, total, used, skipped }：
 *   total ＝ 這頁的錯題數；used ＝ 實際組進去的題數；skipped ＝ 重建不出原題的筆數。
 */
export async function buildMistakeRetryRun(page) {
  const rows = (page?.items || []).slice().sort((a, b) =>
    (Number(b.gotWrongCount) || 0) - (Number(a.gotWrongCount) || 0) || byQnum(a, b));
  const rebuilt = await rebuildQuestions(rows);
  const picked = [];
  const skipped = [];
  for (const r of rows) {
    if (picked.length >= MISTAKE_RETRY_LIMIT) break; // 上限 20（spec）
    const q = rebuilt.get(mistakeKeyOf(r));
    if (!q) { skipped.push(r); continue; }
    picked.push(q);
  }
  if (!picked.length) return { run: null, total: rows.length, used: 0, skipped: skipped.length };
  // 排序照 SECTIONS 卷面順序（與一般模擬考作答順序一致）
  const rank = (s) => {
    const i = SECTION_ORDER.indexOf(s);
    return i < 0 ? SECTION_ORDER.length : i;
  };
  picked.sort((a, b) => (rank(a.section) - rank(b.section)) || byQnum(a, b));
  const papers = [...new Set(picked.map((q) => (page.sourceType === 'ai'
    ? `AI ${String(q.paper || 'A1').replace(/^AI/, '')}`
    : `${q.year}${q.paper}`)))];
  return {
    run: {
      papers,
      questions: picked,
      dropped: { total: 0, byReason: {} },
      meta: { fromMistakes: true, sourceType: page.sourceType, section: page.section, used: picked.length, total: rows.length },
    },
    total: rows.length,
    used: picked.length,
    skipped: skipped.length,
  };
}
