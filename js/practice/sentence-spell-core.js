// 例句拼字純引擎（無 DOM、無事件、無持久化、無網路、無產品路由）
// 依賴注入：題目、出現位置（offset）、詞形證據由呼叫端提供；本檔不決定重複出現的產品政策。
// 座標一律是 JS 字串索引（UTF-16 code unit），start 含、end 不含。

export const CORE_FORMAT = 'sentence-spell-core-v1';
export const CORE_VERSION = '2026-11-10';

const LETTER_RX = /^\p{L}$/u;

/** 單一字母（Unicode letter，含重音字）；非字母回 null。 */
export function asLetter(ch) {
  return typeof ch === 'string' && [...ch].length === 1 && LETTER_RX.test(ch) ? ch : null;
}

/** 大小寫不敏感比較；只為比對，不改動顯示用原文。 */
export function sameLetter(a, b) {
  if (!asLetter(a) || !asLetter(b)) return false;
  return a.toLocaleLowerCase() === b.toLocaleLowerCase();
}

function compactWhitespace(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function fail(reason, detail) {
  return { ok: false, reason, detail: detail ?? null };
}

/**
 * 驗證並凍結一題的明確契約。
 * @param {object} input
 * @param {string|number} input.wordId
 * @param {string} input.lemma
 * @param {string} input.surface 文中實際詞形（例如 runs），作答大小寫不敏感
 * @param {string|number} input.sourceSentenceId
 * @param {string} input.en 原始英文句（保留原 casing／標點／Unicode）
 * @param {string} input.zh 中文意思（完成前不得外露給 view）
 * @param {Array<{start:number,end:number,surface?:string}>} input.occurrences 呼叫端指定的出現位置
 * @param {Array<object>} input.morphologyEvidence 詞形證據（來源證明）
 * @returns {{ok:true,question:object}|{ok:false,reason:string,detail:any}}
 */
export function buildQuestion(input) {
  if (!input || typeof input !== 'object') return fail('invalid_input');
  const { wordId, lemma, surface, sourceSentenceId, en, zh, occurrences, morphologyEvidence } = input;

  if (wordId === undefined || wordId === null || String(wordId) === '') return fail('missing_word_id');
  if (!compactWhitespace(lemma)) return fail('missing_lemma');
  if (!compactWhitespace(surface)) return fail('missing_surface');
  if (sourceSentenceId === undefined || sourceSentenceId === null || String(sourceSentenceId) === '') {
    return fail('missing_source_sentence_id');
  }
  if (typeof en !== 'string' || en.length === 0) return fail('missing_sentence');
  if (typeof zh !== 'string' || compactWhitespace(zh) === '') return fail('missing_meaning');
  if (!Array.isArray(occurrences) || occurrences.length === 0) return fail('no_occurrences');
  if (!Array.isArray(morphologyEvidence)) return fail('missing_morphology_evidence');

  const declaredSurface = String(surface);
  if (![...declaredSurface].some((ch) => asLetter(ch))) return fail('no_letters', { surface: declaredSurface });

  const normalized = [];
  for (const raw of occurrences) {
    if (!raw || typeof raw !== 'object') return fail('invalid_occurrence', raw);
    const start = Number(raw.start);
    const end = Number(raw.end);
    if (!Number.isInteger(start) || !Number.isInteger(end)) return fail('invalid_occurrence', raw);
    if (start < 0 || end > en.length || start >= end) return fail('occurrence_out_of_bounds', { start, end, length: en.length });
    const original = en.slice(start, end);
    if (original.toLocaleLowerCase() !== declaredSurface.toLocaleLowerCase()) {
      return fail('occurrence_surface_mismatch', { start, end, original, declaredSurface });
    }
    if (raw.surface !== undefined && String(raw.surface) !== original) {
      return fail('occurrence_surface_mismatch', { start, end, original, provided: String(raw.surface) });
    }
    normalized.push({ start, end, surface: original });
  }

  normalized.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < normalized.length; i++) {
    if (normalized[i].start < normalized[i - 1].end) {
      return fail('overlapping_occurrences', { previous: normalized[i - 1], current: normalized[i] });
    }
  }

  const counts = new Set(normalized.map((occ) => [...occ.surface].filter((ch) => asLetter(ch)).length));
  if (counts.size !== 1 || counts.has(0)) return fail('inconsistent_letter_counts', { counts: [...counts] });

  const question = Object.freeze({
    format: CORE_FORMAT,
    wordId: String(wordId),
    lemma: String(lemma),
    declaredSurface,
    surface: normalized[0].surface,
    sourceSentenceId: String(sourceSentenceId),
    en,
    zh,
    occurrences: Object.freeze(normalized.map((occ) => Object.freeze({ ...occ }))),
    morphologyEvidence: Object.freeze(morphologyEvidence.map((e) => Object.freeze({ ...e }))),
    repeated: normalized.length > 1,
    hinted: normalized.length > 1,
    hintReasons: Object.freeze(normalized.length > 1 ? ['repeated_occurrences_shared_completion'] : []),
  });
  return { ok: true, question };
}

/**
 * 依原句子字元 offset 建立挖空版型；所有文字、casing、標點、Unicode 原樣保留。
 * 同一題的多個出現處共用同一組字母索引（一次作答、同步顯示）。
 * @returns {{ok:true,layout:object}|{ok:false,reason:string,detail:any}}
 */
export function buildLayout(question) {
  if (!question || typeof question !== 'object' || !Array.isArray(question.occurrences)) {
    return fail('invalid_question');
  }
  const { en, occurrences } = question;
  if (typeof en !== 'string' || occurrences.length === 0) return fail('invalid_question');

  const parts = [];
  const letterExpected = [];
  const layoutOccurrences = [];
  let cursor = 0;

  occurrences.forEach((occ, occurrenceIndex) => {
    if (occ.start > cursor) {
      parts.push({ type: 'text', start: cursor, end: occ.start, text: en.slice(cursor, occ.start) });
    }
    const chars = [];
    const letterIndices = [];
    let within = 0;
    for (let offset = occ.start; offset < occ.end; offset++) {
      const ch = en[offset];
      if (asLetter(ch)) {
        const index = within;
        if (occurrenceIndex === 0) letterExpected.push(ch);
        letterIndices.push(index);
        chars.push({ type: 'letter', index, expected: ch, start: offset, end: offset + 1 });
        within += 1;
      } else {
        chars.push({ type: 'static', ch, start: offset, end: offset + 1 });
      }
    }
    parts.push({
      type: 'target',
      occurrenceIndex,
      start: occ.start,
      end: occ.end,
      surface: occ.surface,
      chars,
    });
    layoutOccurrences.push({
      occurrenceIndex,
      start: occ.start,
      end: occ.end,
      surface: occ.surface,
      letterIndices,
    });
    cursor = occ.end;
  });

  if (cursor < en.length) {
    parts.push({ type: 'text', start: cursor, end: en.length, text: en.slice(cursor) });
  }

  const distinctCounts = new Set(layoutOccurrences.map((occ) => occ.letterIndices.length));
  if (distinctCounts.size !== 1) return fail('inconsistent_letter_counts', { counts: [...distinctCounts] });

  return {
    ok: true,
    layout: {
      format: CORE_FORMAT,
      answer: question.surface,
      declaredSurface: question.declaredSurface,
      letterCount: letterExpected.length,
      letters: letterExpected,
      parts,
      occurrences: layoutOccurrences,
      repeated: occurrences.length > 1,
    },
  };
}

/** 建立單次作答狀態；不持久化、不寫事件。 */
export function createState(question) {
  const built = buildLayout(question);
  if (!built.ok) return built;
  return {
    ok: true,
    state: {
      question,
      layout: built.layout,
      pos: 0,
      letterCount: built.layout.letterCount,
      status: Array.from({ length: built.layout.letterCount }, () => 'empty'),
      shown: Array.from({ length: built.layout.letterCount }, () => ''),
      wrongAttempts: 0,
      wrongPositions: [],
      completed: false,
      completionCount: 0,
    },
  };
}

/**
 * 吃一個字母。打錯：該格標紅、游標留在原格、不需 Backspace，下一個字母直接覆蓋；
 * 打對：該格轉綠並前進，已綠的格子不會再被改寫。完成後任何輸入都是 no-op。
 * @returns {{accepted:boolean,completed:boolean,position:number,duplicate?:boolean}}
 */
export function typeLetter(state, ch) {
  if (!state) return { accepted: false, completed: false, position: -1 };
  if (state.completed) {
    return { accepted: false, completed: true, position: state.pos, duplicate: true };
  }
  const letter = asLetter(ch);
  if (!letter) return { accepted: false, completed: false, position: state.pos };

  const index = state.pos;
  const expected = state.layout.letters[index];
  if (expected == null) return { accepted: false, completed: false, position: index };

  if (sameLetter(letter, expected)) {
    state.status[index] = 'ok';
    state.shown[index] = expected;
    state.pos = index + 1;
    if (state.pos >= state.letterCount) {
      state.completed = true;
      state.completionCount += 1;
    }
    return { accepted: true, completed: state.completed, position: index };
  }

  state.status[index] = 'bad';
  state.shown[index] = letter;
  state.wrongAttempts += 1;
  if (!state.wrongPositions.includes(index)) state.wrongPositions.push(index);
  return { accepted: false, completed: false, position: index };
}

/** 完成前一律 null；完成後才回實際 surface（保留原句 casing）。 */
export function revealedAnswer(state) {
  return state && state.completed ? state.question.surface : null;
}

/** 完成前一律 null；完成後才回中文意思。 */
export function revealedMeaning(state) {
  return state && state.completed ? state.question.zh : null;
}

/**
 * 完成卡資料；完成前回 null。重複呼叫結果一致（不重複計次）。
 */
export function completionSummary(state) {
  if (!state || !state.completed) return null;
  return {
    wordId: state.question.wordId,
    lemma: state.question.lemma,
    surface: state.question.surface,
    meaning: state.question.zh,
    en: state.question.en,
    sourceSentenceId: state.question.sourceSentenceId,
    morphologyEvidence: [...state.question.morphologyEvidence],
    wrongAttempts: state.wrongAttempts,
    wrongPositions: [...state.wrongPositions],
    hinted: state.question.hinted,
    hintReasons: [...state.question.hintReasons],
    completionCount: state.completionCount,
  };
}

/**
 * 可安全交給 UI 於「完成前」渲染的視圖：只含文字片段、每格狀態、目前位置。
 * 不含答案字母、lemma、中文意思；target 片段不帶 expected。
 * 完成後才附 completion 卡。
 */
export function buildView(state) {
  if (!state || !state.layout) return null;
  const parts = state.layout.parts.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    return {
      type: 'target',
      occurrenceIndex: part.occurrenceIndex,
      chars: part.chars.map((c) => {
        if (c.type === 'static') return { type: 'static', ch: c.ch };
        const status = state.status[c.index];
        // 打對時顯示「這一個出現處」自己的原始字元（casing 不互相複製）；
        // 打錯時共用同一個作答狀態，顯示實際輸入的字母。
        const shown = status === 'ok' ? c.expected : (status === 'bad' ? state.shown[c.index] : '');
        return {
          type: 'letter',
          index: c.index,
          status,
          shown,
          current: !state.completed && c.index === state.pos,
        };
      }),
    };
  });
  return {
    format: CORE_FORMAT,
    parts,
    letterCount: state.letterCount,
    pos: state.pos,
    wrongAttempts: state.wrongAttempts,
    completed: state.completed,
    completion: completionSummary(state),
  };
}

export default {
  CORE_FORMAT,
  CORE_VERSION,
  asLetter,
  sameLetter,
  buildQuestion,
  buildLayout,
  createState,
  typeLetter,
  revealedAnswer,
  revealedMeaning,
  completionSummary,
  buildView,
};
