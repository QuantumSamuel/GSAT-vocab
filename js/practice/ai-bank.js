// ============================================================
// AI 題庫資料層（5.0）——把 data/questions/ai/ 的 pool 題庫攤平成單一題目流
//
// 為什麼要有這一層：
//   ① 六個檔案的 schema 各自不同（詞彙檔是 questions[]＋數字 answer＋帶前綴的選項；
//      poola_v1/poolb_v1 是「組層 passage + 題層 questions[]」），消費端不該各寫一套。
//      本模組把差異全部收攏成 real.json 相容的單一形狀（字母 options + 乾淨 option_texts）。
//   ② 來源嚴格分離：所有攤平題一律 sourceType:'ai'、year:'AI'，paper 為 A1/B1/V1/D1，
//      絕不與歷屆真題的數字學年／E・N 卷別混淆（紅線：不得混入 real 池或假冒真題卷號）。
//   ③ 零 DOM／零 services 依賴——可被 node 直接 import 做資料測試，畫面一律在消費端。
//
// 與 exam-data.js 的關係：exam-data.js 負責「組卷規則」（排序、剔除、區段），
// 本模組只負責「資料形狀」；AI 題是 real.json 的同級資料源，餵進同一組 buildPaperRun。
// ============================================================

export const AI_DIR = 'data/questions/ai/';

// 攤平順序＝題號連續性的約定：先詞彙三檔（V1）再 poola（A1）再 poolb（B1）再 draft（D1）。
// 詞彙三檔各自原編 1-30，攤平時依 poolc→b2→b3 重編 1..90，讓 V1 卷是一份連續的詞彙卷。
const VOCAB_FILES = [
  { file: 'poolc_v1.json', source: 'poolc-v1' },
  { file: 'poolb_v2.json', source: 'poolb-v2' },
  { file: 'poolb_v3.json', source: 'poolb-v3' },
];
const PAPER_V = 'V1';
const PAPER_A = { file: 'poola_v1.json', source: 'poola-v1', paper: 'A1' };
const PAPER_B = { file: 'poolb_v1.json', source: 'poolb-v1', paper: 'B1' };
const DRAFT = { file: 'draft_v1.json', source: 'ai-draft-v1', paper: 'D1' };

// 區段名與 real.json 的 SECTIONS 完全一致，排序才接得上 exam 引擎
const SEC_VOCAB = '詞彙題';
const SEC_CLOZE = '綜合測驗';
const SEC_DISCOURSE = '篇章結構';
const SEC_READING = '閱讀測驗';

// 模擬考開放的 AI 卷別（D1 僅供選擇練習的來源計數，不進 exam 卷別清單）
export const AI_PAPERS = ['A1', 'B1', 'V1'];
/** 各 AI 卷可用的區段（勾選題型時依此啟用／停用） */
export const AI_PAPER_SECTIONS = {
  A1: [SEC_CLOZE, SEC_DISCOURSE],
  B1: [SEC_READING, SEC_DISCOURSE],
  V1: [SEC_VOCAB],
};

const LETTERS = 'ABCDEFGHIJ';
// 詞彙 pool 的選項文字把「A. 」前綴內嵌在字串裡（poolc_v1/poolb_v2/poolb_v3），
// poolb_v1 的 options 欄也是完整形式——兩處都要剝乾淨，否則畫面會出現「A. A. production」
const stripPrefix = (s) => String(s ?? '').replace(/^[A-J][.、]\s*/, '');
const asLetters = (arr) => (Array.isArray(arr) ? arr : []).map((_, i) => LETTERS[i]);

// ---------- 載入：模組級 in-flight 去重快取，失敗不鎖死可重試 ----------
// 比照 exam-data.js loadRealBank 的寫法：4.3.1 教訓——資料檔用 cache:'no-cache'，
// 避免瀏覽器 heuristic 快取抓到改版前的舊檔。
let aiData = null;
let aiPromise = null;

async function fetchJson(name) {
  const res = await fetch(AI_DIR + name, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`AI 題庫 ${name} 載入失敗（HTTP ${res.status}）`);
  return res.json();
}

export async function loadAiBank() {
  if (aiData) return aiData;
  if (!aiPromise) {
    aiPromise = (async () => {
      const names = [...VOCAB_FILES.map((f) => f.file), PAPER_A.file, PAPER_B.file, DRAFT.file];
      const raws = await Promise.all(names.map((n) => fetchJson(n)));
      const byFile = Object.fromEntries(names.map((n, i) => [n, raws[i]]));
      const questions = [
        ...vocabToV1(byFile),
        ...groupToFlat(byFile[PAPER_A.file], PAPER_A, { kind: 'cloze' }),
        ...groupToFlat(byFile[PAPER_A.file], PAPER_A, { kind: 'discourse' }),
        ...groupToFlat(byFile[PAPER_B.file], PAPER_B, { kind: 'reading' }),
        ...groupToFlat(byFile[PAPER_B.file], PAPER_B, { kind: 'discourse' }),
        ...draftToFlat(byFile[DRAFT.file]),
      ];
      if (!questions.length) throw new Error('AI 題庫資料格式錯誤');
      aiData = { questions, files: names };
      return aiData;
    })();
  }
  const mine = aiPromise;
  try {
    return await mine;
  } finally {
    if (aiPromise === mine && !aiData) aiPromise = null; // 失敗不鎖死；identity 檢查防交錯清
  }
}

// ---------- 各檔轉換 ----------
/** 詞彙三檔（poolc_v1/poolb_v2/poolb_v3）→ V1 卷：題幹=q、數字 answer、選項帶前綴 */
function vocabToV1(byFile) {
  const out = [];
  // 三檔各編 1-30；攤平時依 poolc→b2→b3 的順序重編 1..90，讓 V1 卷是一份連續的詞彙卷
  let seq = 0;
  for (const { file, source } of VOCAB_FILES) {
    const list = Array.isArray(byFile[file]?.questions) ? byFile[file].questions : [];
    for (const q of list) {
      seq += 1;
      out.push(flat({
        source,
        paper: PAPER_V,
        section: q.section || SEC_VOCAB,
        qnum: seq,
        stem: q.q,
        optionTexts: (q.options || []).map(stripPrefix),
        answer: LETTERS[Number(q.answer)],
        explanation: q.explanation || null,
        // 詞彙題逐題各自四選一，pool 檔未標 option_pool；標 per-question 讓考卷引擎
        // 知道「不可當成共用選項池」（renderQuestion 只在 option_pool==='cloze-bank' 時加註記）
        optionPool: 'per-question',
      }));
    }
  }
  return out;
}

/**
 * 組層題庫（poola_v1 的 cloze/discourse、poolb_v1 的 reading/discourse）→ 攤平到題層。
 * 組層的 year/paper/group/passage 展開到每一題；題層自己的欄位優先（篇章結構各題
 * option_texts 排列不同，poola meta.integrationNote 註記：不可當共用選項池）。
 */
function groupToFlat(data, { source, paper }, { kind }) {
  const groups = Array.isArray(data?.[kind]) ? data[kind] : [];
  const section = kind === 'cloze' ? SEC_CLOZE : kind === 'reading' ? SEC_READING : SEC_DISCOURSE;
  const out = [];
  for (const g of groups) {
    const list = Array.isArray(g.questions) ? g.questions : [];
    for (const q of list) {
      out.push(flat({
        source,
        year: q.year || g.year || 'AI',
        paper: q.paper || g.paper || paper,
        section: q.section || g.section || section,
        group: q.group ?? g.group ?? null,
        qnum: q.qnum,
        stem: q.stem,
        // 篇章結構的 passage 帶 1-4 的圈碼標記（題層；組層 passage 較舊），優先取題層
        passage: q.passage ?? g.passage,
        options: q.options,
        optionTexts: Array.isArray(q.option_texts) ? q.option_texts : (q.options || []).map(stripPrefix),
        answer: q.answer,
        explanation: q.explanation || null,
        optionPool: q.option_pool || 'per-question',
      }));
    }
  }
  return out;
}

/** draft_v1 → D1 卷：題層已是 real 形狀，只補 year:'AI' / paper:'D1' */
function draftToFlat(data) {
  const list = Array.isArray(data?.questions) ? data.questions : [];
  return list.map((q) => flat({
    source: q.source || DRAFT.source,
    year: q.year || 'AI',
    paper: q.paper || DRAFT.paper,
    section: q.section,
    group: q.group ?? null,
    qnum: q.qnum,
    stem: q.stem,
    passage: q.passage ?? null,
    options: q.options,
    optionTexts: Array.isArray(q.option_texts) ? q.option_texts : [],
    answer: q.answer,
    explanation: q.explanation || null,
    optionPool: q.option_pool || 'per-question',
    maybe: Array.isArray(q.maybe) ? q.maybe : null,
  }));
}

/** 統一形狀的組裝點：字母 options ＋ 乾淨 option_texts（real.json 相容） */
function flat(o) {
  const texts = Array.isArray(o.optionTexts) ? o.optionTexts.map((t) => String(t ?? '')) : [];
  const letters = asLetters(texts);
  return {
    sourceType: 'ai',
    source: o.source,
    year: o.year ?? 'AI',
    paper: o.paper,
    section: o.section,
    group: o.group ?? null,
    qnum: o.qnum ?? null,
    stem: o.stem ?? '',
    ...(o.passage ? { passage: o.passage } : {}),
    options: letters,
    option_texts: texts,
    answer: o.answer,
    explanation: o.explanation ?? null,
    option_pool: o.optionPool ?? 'per-question',
    ...(o.maybe ? { maybe: o.maybe } : {}),
  };
}

// ---------- 統計：各卷題數與區段小計（設定畫面的卷別清單用） ----------
/** 回傳 { A1:{total,sections:{…}}, B1:{…}, V1:{…}, D1:{…} }（含零題的卷別） */
export function aiPaperCounts(bank) {
  const out = {};
  for (const p of [...AI_PAPERS, DRAFT.paper]) out[p] = { total: 0, sections: {} };
  for (const q of bank?.questions || []) {
    const hit = out[q.paper];
    if (!hit) continue;
    hit.total++;
    hit.sections[q.section] = (hit.sections[q.section] || 0) + 1;
  }
  return out;
}

/**
 * 出過題的單字（正解詞）。只取 詞彙題／綜合測驗——篇章結構與閱讀的答案是整句，不能進單字池。
 *
 * 正解詞形狀（池品質門之外仍會出現的兩類，實測 138 題中 23 題）：
 *   ① 屈折形／比較級（repaired、works、shortest、doing）——字庫只收原形
 *   ② 句首連接詞大寫（Because／Since／Meanwhile）——原句在句首，題庫原樣保留
 * 這兩類在「出題池過濾（w.word ∈ set）」時自然落選（set 可含也可不含原形），
 * 屬可預期的落差，不在此處做原形化——原形化會讓同義題/拼寫題拿到與題庫不同的字形。
 */
export function aiTestedWords(bank) {
  const out = [];
  const seen = new Set();
  for (const q of bank?.questions || []) {
    if (q.section !== SEC_VOCAB && q.section !== SEC_CLOZE) continue;
    const i = LETTERS.indexOf(String(q.answer ?? ''));
    const w = String(q.option_texts?.[i] ?? '').trim();
    if (!w || seen.has(w)) continue; // 保留原形大小寫去重（題庫正解一律小寫開頭）
    seen.add(w);
    out.push(w);
  }
  return out;
}
