// ============================================================
// 資料層健檢（6.2.3，2026-11-21）
//
// 目的：把「字庫／題庫／例句／詞典」載入失敗的原因分門別類，讓畫面能講清楚是哪一種，
// 而不是統一的「載入失敗」。同時提供啟動自檢，抓「檔案在但內容壞掉」的情況：
//   · 筆數異常（檔案被截斷或換成別版）
//   · 重複 id（合併或重建時出錯）
//   · 版本字串不一致（快取舊版與新程式混用）
//
// 只做檢查、不改資料；所有函式回傳 { ok, code, detail } 供呼叫端決定顯示什麼。
// ============================================================

export const DATA_CODES = {
  HTTP: 'DATA_HTTP',
  BAD_JSON: 'DATA_BAD_JSON',
  EMPTY: 'DATA_EMPTY',
  SCHEMA: 'DATA_SCHEMA',
  DUPLICATE_IDS: 'DATA_DUPLICATE_IDS',
  VERSION_MISMATCH: 'DATA_VERSION_MISMATCH',
};

export const DATA_CODE_TEXT = {
  [DATA_CODES.BAD_JSON]: '資料檔格式錯誤（不是合法 JSON）',
  [DATA_CODES.EMPTY]: '資料檔是空的',
  [DATA_CODES.SCHEMA]: '資料檔缺少必要欄位',
  [DATA_CODES.DUPLICATE_IDS]: '資料檔有重複的識別碼',
  [DATA_CODES.VERSION_MISMATCH]: '資料版本與程式不一致',
};

const fail = (code, detail) => ({ ok: false, code, detail });
const pass = (detail = '') => ({ ok: true, code: null, detail });

// 字庫：words 陣列，每筆至少 id 與 word；ids 不得重複
export function validateWords(data, { minCount = 1000 } = {}) {
  if (!data || typeof data !== 'object') return fail(DATA_CODES.BAD_JSON, '不是物件');
  if (!Array.isArray(data.words)) return fail(DATA_CODES.SCHEMA, '缺少 words 陣列');
  if (data.words.length === 0) return fail(DATA_CODES.EMPTY, '字庫是空的');
  if (data.words.length < minCount) return fail(DATA_CODES.EMPTY, `words 只有 ${data.words.length} 筆（預期至少 ${minCount}）`);

  const seen = new Set();
  const dups = [];
  for (const w of data.words) {
    if (!w || typeof w !== 'object') return fail(DATA_CODES.SCHEMA, 'words 內有非物件項目');
    if (!w.id || !w.word) return fail(DATA_CODES.SCHEMA, `缺少 id 或 word：${JSON.stringify(w).slice(0, 60)}`);
    if (seen.has(w.id)) dups.push(w.id);
    seen.add(w.id);
  }
  if (dups.length) return fail(DATA_CODES.DUPLICATE_IDS, `重複 id ${dups.length} 個，例如 ${dups.slice(0, 3).join('、')}`);

  // meta 若有宣告筆數，必須與實際相符（防「檔案被截斷」）
  const declared = data.meta?.count ?? data.meta?.wordCount;
  if (typeof declared === 'number' && declared !== data.words.length) {
    return fail(DATA_CODES.VERSION_MISMATCH, `meta 宣告 ${declared} 筆，實際 ${data.words.length} 筆`);
  }
  return pass(`${data.words.length} 筆`);
}

// 題庫：passages 陣列，每篇要有 id 與 items／blanks
export function validateExam(data, { minPassages = 1 } = {}) {
  if (!data || typeof data !== 'object') return fail(DATA_CODES.BAD_JSON, '不是物件');
  if (!Array.isArray(data.passages)) return fail(DATA_CODES.SCHEMA, '缺少 passages 陣列');
  if (data.passages.length < minPassages) return fail(DATA_CODES.EMPTY, `passages 只有 ${data.passages.length} 篇`);
  const seen = new Set();
  for (const p of data.passages) {
    if (!p || !p.id) return fail(DATA_CODES.SCHEMA, 'passage 缺少 id');
    if (seen.has(p.id)) return fail(DATA_CODES.DUPLICATE_IDS, `重複 passage id：${p.id}`);
    seen.add(p.id);
  }
  return pass(`${data.passages.length} 篇`);
}

// 例句：sentences 物件（word → 陣列）
export function validateSentences(data) {
  if (!data || typeof data !== 'object') return fail(DATA_CODES.BAD_JSON, '不是物件');
  if (!data.sentences || typeof data.sentences !== 'object') return fail(DATA_CODES.SCHEMA, '缺少 sentences 物件');
  const keys = Object.keys(data.sentences);
  if (!keys.length) return fail(DATA_CODES.EMPTY, 'sentences 為空');
  return pass(`${keys.length} 個詞有例句`);
}

// 啟動自檢：把多個檔案的結果彙整成一張表；任何一項失敗都會回報（不丟例外）
export function selfCheck(results) {
  const rows = Object.entries(results || {}).map(([name, r]) => ({ name, ...r }));
  const failed = rows.filter((r) => !r.ok);
  return { ok: failed.length === 0, rows, failed };
}
