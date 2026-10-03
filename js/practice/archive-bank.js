// ============================================================
// 考古題資料層（5.2）——把 data/questions/archive/archive_v1.json 攤平成單一題目流
//
// 為什麼要有這一層（比照 ai-bank.js 的三條理由）：
//   ① archive_v1.json 的形狀是「區段組」（詞彙是單題、五個段落型區段是 passage + items[]），
//      而 exam 的排序/剔除規則、selection 的克漏字與文意選填轉換函式吃的是
//      real.json 相容的單一題目形狀。本模組把差異收攏在這裡。
//   ② 來源嚴格分離：每題一律 sourceType:'archive'、source:'archive'，year 為數字學年、
//      paper 為「屆次＋考試別」（如 '109學測'）。絕不與 real 池（113/114、E/N 卷）
//      或 AI 池（year:'AI'、A1/B1/V1）混淆（紅線）。
//   ③ 零 DOM／零 services 依賴——可被 node 直接 import 做資料測試，畫面一律在消費端。
//
// 【與 spec 的實測偏差，回報用】
//   spec §3.2 說克漏字「沿用 toClozeGroups 的 NN. 還原」，但上游整理檔的空格標記實際是
//   「{11}」而非裸「11.」，且句中常有不相干的數字（"at the age of 41"、"reach 50"）。
//   selection.js 的裸數字正則會先撞到那些數字而錯位，故本模組另給 archiveClozeGroups()
//   用精確的 {NN} 還原，消費端直接吃它的輸出。
// ============================================================

export const ARCHIVE_URL = 'data/questions/archive/archive_v1.json';

// 六個區段：前五個進題目流，中翻英是獨立引擎（spelling zh2en 的歷屆真題卡）
export const SEC_VOCAB = '詞彙題';
export const SEC_CLOZE = '綜合測驗';
export const SEC_COMPLETION = '文意選填';
export const SEC_DISCOURSE = '篇章結構';
export const SEC_READING = '閱讀測驗';
export const SEC_TRANSLATE = '中翻英';
/** 可作答的區段（模擬考的區段勾選用；順序＝學測卷面順序） */
export const ARCHIVE_SECTIONS = [SEC_VOCAB, SEC_CLOZE, SEC_COMPLETION, SEC_DISCOURSE, SEC_READING];

const LETTERS = 'ABCDEFGHIJKL';
const asLetters = (n) => Array.from({ length: n }, (_, i) => LETTERS[i]);

/**
 * 取「含該空格的整句」當題幹。
 * 克漏字／文意選填／篇章結構上游沒有題層題幹，模擬考畫面要有一行能指向空格位置的題幹。
 * 即時從 passage 還原（不存檔——寫進資料檔要多 180KB，而這是純可再生的衍生欄位）。
 */
export function sentenceOf(text, marker) {
  const parts = String(text).split(/(?<=[.!?])\s+/);
  const hit = parts.find((s) => s.includes(marker));
  return (hit ?? String(text).slice(0, 120)).trim();
}

// ---------- 載入：模組級 in-flight 去重快取，失敗不鎖死可重試 ----------
// 比照 ai-bank.js：4.3.1 教訓——資料檔用 cache:'no-cache'，避免抓到改版前的舊檔。
let archiveData = null;
let archivePromise = null;

export async function loadArchiveBank() {
  if (archiveData) return archiveData;
  if (!archivePromise) {
    archivePromise = (async () => {
      const res = await fetch(ARCHIVE_URL, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`考古題載入失敗（HTTP ${res.status}）`);
      const data = await res.json();
      const sec = data?.sections || {};
      if (!Array.isArray(sec[SEC_VOCAB]) || !sec[SEC_VOCAB].length) throw new Error('考古題資料格式錯誤');
      archiveData = data;
      return data;
    })();
  }
  const mine = archivePromise;
  try {
    return await mine;
  } finally {
    if (archivePromise === mine && !archiveData) archivePromise = null; // identity 檢查防交錯清
  }
}

// ============================================================
// 攤平：區段組 → real.json 相容題物件
// ============================================================

/** 詞彙題：已是單題形狀，只補字母 options 與共用欄位 */
function flattenVocab(bank) {
  return (bank?.sections?.[SEC_VOCAB] || []).map((q) => flat(q, {
    section: SEC_VOCAB,
    group: null,
    qnum: q.qnum,
    stem: q.stem,
    optionTexts: q.options,
    answer: LETTERS[q.answer],
    explanation: q.explanation || null,
    stemZh: q.stemZh || '',
    optionPool: 'per-question',
  }));
}

/**
 * 綜合測驗（克漏字）：一組 = passage ＋ items。
 *
 * 兩處刻意的取捨（都是為了讓模擬考與選擇練習的畫面一致）：
 *   ① 抽題以「組」為單位（整組必須一起出現，否則 passage 缺格），故 qnum 以篇內序號重編，
 *      group 用篇序號（數字，讓排序函式能直接比大小）。
 *   ② passage 與 passageZh 的 {NN} 標記在攤平時就換成 [1]…[n]（依篇內序號，不是原題號），
 *      stem 也用換完的標記取句。這裡若沿用資料檔的 {NN}，模擬考與選擇練習會一個顯示
 *      {31}、一個顯示 [1]，而且沒有當前格的高亮可比對（池 B 實測：考古題綜合測驗的
 *      模擬考畫面直接把 {31} 印出來）。換完後兩端都吃 [n]，畫面規則完全一致。
 *      中文譯本沒有空格標記，不需要處理。
 */
function flattenCloze(bank) {
  const out = [];
  (bank?.sections?.[SEC_CLOZE] || []).forEach((g, gi) => {
    // 先建立原題號 → 篇內序號的對照表，再逐格替換（文章與題幹共用同一張表）
    const map = new Map((g.items || []).map((it, ii) => [it.num, ii + 1]));
    const passage = markUpBlank(g.passage, map);
    const passageZh = markUpBlank(g.passageZh, map);
    (g.items || []).forEach((it, ii) => {
      const n = ii + 1;
      out.push(flat(g, {
        section: SEC_CLOZE,
        group: gi + 1,
        qnum: n,
        stem: sentenceOf(passage, `[${n}]`),
        passage,
        passageZh,
        optionTexts: it.options,
        answer: LETTERS[it.answerIdx],
        explanation: it.explanation || null,
        optionPool: 'per-question',
      }));
    });
  });
  return out;
}

/** 把 {NN}／__NN__ 依對照表換成 [n]；對照表沒有的原題號原樣保留（不猜、不刪） */
function markUpBlank(text, map) {
  if (!map.size) return String(text ?? '');
  return String(text ?? '').replace(/\{(\d+)\}|__(\d+)__/g, (m, a, b) => {
    const key = Number(a ?? b);
    return map.has(key) ? `[${map.get(key)}]` : m;
  });
}

/** 文意選填：整篇共用一個 wordBank（option_pool: cloze-bank），answers 是正解在 bank 的索引 */
function flattenCompletion(bank) {
  const out = [];
  (bank?.sections?.[SEC_COMPLETION] || []).forEach((g, gi) => {
    (g.answers || []).forEach((ai, ii) => {
      out.push(flat(g, {
        section: SEC_COMPLETION,
        group: gi + 1,
        qnum: ii + 1,
        stem: sentenceOf(g.passage, `[${ii + 1}]`),
        passage: g.passage,
        passageZh: g.passageZh,
        optionTexts: g.wordBank,
        answer: LETTERS[ai],
        explanation: g.explanations?.[ii + 1] || g.glosses?.[ii + 1] || null,
        optionPool: 'cloze-bank',
      }));
    });
  });
  return out;
}

/** 篇章結構：同文意選填（共用句選項池 cloze-bank） */
function flattenDiscourse(bank) {
  const out = [];
  (bank?.sections?.[SEC_DISCOURSE] || []).forEach((g, gi) => {
    (g.answers || []).forEach((ai, ii) => {
      out.push(flat(g, {
        section: SEC_DISCOURSE,
        group: gi + 1,
        qnum: ii + 1,
        stem: sentenceOf(g.passage, `[${ii + 1}]`),
        passage: g.passage,
        passageZh: g.passageZh,
        optionTexts: g.options,
        answer: LETTERS[ai],
        explanation: g.explanations?.[ii + 1] || null,
        optionPool: 'cloze-bank',
      }));
    });
  });
  return out;
}

/** 閱讀測驗：文章共用，題目逐題（per-question） */
function flattenReading(bank) {
  const out = [];
  (bank?.sections?.[SEC_READING] || []).forEach((g, gi) => {
    (g.items || []).forEach((it, ii) => {
      out.push(flat(g, {
        section: SEC_READING,
        group: gi + 1,
        qnum: ii + 1,
        stem: it.stem,
        passage: g.passage,
        passageZh: g.passageZh,
        optionTexts: it.options,
        answer: LETTERS[it.answerIdx],
        explanation: it.explanation || null,
        optionPool: 'per-question',
      }));
    });
  });
  return out;
}

/** 統一形狀的組裝點（字母 options ＋ 乾淨 option_texts，real.json 相容） */
function flat(g, o) {
  const texts = Array.isArray(o.optionTexts) ? o.optionTexts.map((t) => String(t ?? '')) : [];
  const year = g?.year ?? null;
  const exam = g?.exam || '';
  const q = {
    sourceType: 'archive',
    source: 'archive',
    year,
    paper: `${year ?? '?'}${exam}`,
    section: o.section,
    group: o.group ?? null,
    qnum: o.qnum ?? null,
    stem: o.stem ?? '',
    options: asLetters(texts.length),
    option_texts: texts,
    answer: o.answer,
    explanation: o.explanation ?? null,
    option_pool: o.optionPool ?? 'per-question',
  };
  if (o.passage) q.passage = o.passage;
  if (o.passageZh) q.passageZh = o.passageZh;
  if (o.stemZh) q.stemZh = o.stemZh;
  return q;
}

/**
 * 攤平整檔成單一題目流（real.json 相容）。
 * opts: { sections?:區段[], minYear?:數字, years?:數字[] }
 *   不傳即全收。minYear 用於屆次範圍的「105 屆起」，years 用於「近 10 屆」列舉。
 *   year 為 null 的段落（上游 3 篇學測參考試卷）只在完全不篩時出現——
 *   屆次範圍無法歸類它們，寧可不給也不假造年份。
 */
export function archiveQuestions(bank, opts = {}) {
  const all = [
    ...flattenVocab(bank),
    ...flattenCloze(bank),
    ...flattenCompletion(bank),
    ...flattenDiscourse(bank),
    ...flattenReading(bank),
  ];
  // 「有傳 sections 鍵就照它過濾」：空陣列代表使用者取消所有區段 → 結果應為空，
  // 而不是被當成「不過濾」。故用 hasOwnProperty 判斷有沒有指定，而不是看長度。
  const hasSections = Object.prototype.hasOwnProperty.call(opts, 'sections');
  const only = hasSections ? new Set(opts.sections || []) : null;
  const years = Array.isArray(opts.years) && opts.years.length ? new Set(opts.years.map(Number)) : null;
  const minYear = Number.isFinite(opts.minYear) ? Number(opts.minYear) : null;
  const filtering = only || years || minYear != null;
  return all.filter((q) => {
    if (only && !only.has(q.section)) return false;
    if (filtering && (q.year == null || !Number.isFinite(Number(q.year)))) return false;
    if (years && !years.has(Number(q.year))) return false;
    if (minYear != null && Number(q.year) < minYear) return false;
    return true;
  });
}

/**
 * 克漏字整組（考古題版）：{ passage, passageZh, items:[{q,options,answer,explanation,src,srcText}] }
 *
 * 與 selection.js 的 toClozeGroups 的差別只在標記還原：
 *   toClozeGroups 用裸數字 regex 找「nn.」（real.json 的格式）；
 *   考古題上游的標記是精確的「{11}」，句中另有不相干的數字（"at the age of 41"），
 *   用裸數字必然錯位，故逐題用 {NN} 替換成 [i]。找不到標記就整組丟棄（不產出半截文章）。
 */
export function archiveClozeGroups(bank) {
  const out = [];
  for (const g of bank?.sections?.[SEC_CLOZE] || []) {
    let passage = String(g.passage || '');
    const items = [];
    let ok = true;
    (g.items || []).forEach((it, i) => {
      const re = new RegExp(`\\{${it.num}\\}`);
      if (!re.test(passage)) { ok = false; return; }
      passage = passage.replace(re, `[${i + 1}]`);
      items.push({
        q: `[${i + 1}]`,
        options: it.options,
        answer: it.answerIdx,
        explanation: it.explanation || null,
        category: it.category || '',
        src: 'archive',
        srcText: `考古題 ${g.year ?? ''}${g.exam || ''}`.trim(),
      });
    });
    if (ok && items.length) out.push({ passage, passageZh: g.passageZh || '', items, source: g });
  }
  return out;
}

/** 文意選填整篇（考古題版）：{ passage, passageZh, options(wordBank), blanks{'1':正解字}, src, srcText } */
export function archiveDiscourseItems(bank) {
  const out = [];
  for (const g of bank?.sections?.[SEC_COMPLETION] || []) {
    const blanks = {};
    let ok = true;
    (g.answers || []).forEach((ai, i) => {
      const w = g.wordBank?.[ai];
      if (!w) { ok = false; return; }
      blanks[i + 1] = w;
    });
    if (!ok || !Object.keys(blanks).length) continue;
    out.push({
      passage: g.passage,
      passageZh: g.passageZh || '',
      title: g.title || '',
      options: g.wordBank || [],
      blanks,
      explanations: g.explanations || {},
      src: 'archive',
      srcText: `考古題 ${g.year ?? ''}${g.exam || ''}`.trim(),
      source: g,
    });
  }
  return out;
}

/** 詞彙題（考古題版）：引擎內部的單選格式（q/options/answer:index/…） */
export function archiveSingleItems(bank) {
  return (bank?.sections?.[SEC_VOCAB] || []).map((q) => ({
    q: q.stem,
    options: q.options || [],
    answer: Number(q.answer),
    explanation: q.explanation || null,
    src: 'archive',
    srcText: `考古題 ${q.year ?? ''}${q.exam || ''}`.trim(),
    year: q.year,
    exam: q.exam,
  }));
}

// ============================================================
// 統計：各區段題數／各屆題數（設定畫面用）
// ============================================================

const itemsOf = (sec, g) => (sec === SEC_VOCAB ? 1 : (g.items?.length ?? g.answers?.length ?? 0));

/**
 * 回傳 { sections:{區段:題數}, passages:{區段:篇數}, byYear:{屆次:題數}, byExam:{考試別:題數}, total }
 * passages 只列有文章的區段（詞彙題無 passage）。
 */
export function archivePaperCounts(bank) {
  const sections = {};
  const passages = {};
  const byYear = {};
  const byExam = {};
  let total = 0;
  for (const sec of ARCHIVE_SECTIONS) {
    const list = bank?.sections?.[sec] || [];
    sections[sec] = list.reduce((a, g) => a + itemsOf(sec, g), 0);
    if (sec !== SEC_VOCAB) passages[sec] = list.length;
    total += sections[sec];
    for (const g of list) {
      const n = itemsOf(sec, g);
      const yr = g.year == null ? '無年份' : String(g.year);
      byYear[yr] = (byYear[yr] || 0) + n;
      if (g.exam) byExam[g.exam] = (byExam[g.exam] || 0) + n;
    }
  }
  return { sections, passages, byYear, byExam, total };
}

/** 可用的屆次清單（由大到小；不含無年份者——屆次範圍無法歸類它們） */
export function archiveYears(bank) {
  const counts = archivePaperCounts(bank).byYear;
  return Object.keys(counts).filter((y) => /^\d+$/.test(y)).map(Number).sort((a, b) => b - a);
}

/**
 * 屆次範圍 → 篩選條件（給 archiveQuestions 用；'all' 回 null＝不篩，含無年份者）。
 * scope: 'all'（全部）／'recent10'（近 10 屆）／'since105'（105 屆起）
 */
export function archiveYearFilter(bank, scope = 'all') {
  const years = archiveYears(bank);
  if (scope === 'recent10') return { years: years.slice(0, 10) };
  if (scope === 'since105') return { minYear: 105 };
  return null;
}

/**
 * 屆次範圍的題數預估（設定畫面顯示「此範圍有幾題」用；零 DOM）。
 * sections 傳 null／不傳＝不過濾區段（回全庫題數）；傳空陣列＝使用者取消所有區段（回 0）。
 * 靠 archiveQuestions 的 hasOwnProperty 判斷實作，故這裡原樣把鍵傳下去即可。
 */
export function archiveScopeCount(bank, scope = 'all', sections = null) {
  return archiveQuestions(bank, {
    ...(archiveYearFilter(bank, scope) || {}),
    ...(Array.isArray(sections) ? { sections } : {}),
  }).length;
}

/** 中翻英（歷屆真題）：[{id,year,exam,zh,en}]，直接給 spelling zh2en 的歷屆真題卡用 */
export function archiveTranslateItems(bank) {
  return (bank?.sections?.[SEC_TRANSLATE] || []).map((q) => ({
    id: q.id, year: q.year, exam: q.exam, zh: q.zh, en: q.en,
  }));
}
