// 例句拼字來源適配器（純函式；不 fetch、不讀寫 storage、不碰 DOM／事件）
// 只接受呼叫端明確提供的 word / sentence / lexiconEntry。
// 詞形只採「原字」或 lexicon.sourceMatches[].raw.exchange 明確宣告的詞形；
// 不套用 -ly/-er/-ing/-s 等字尾規則，也不接受任意共同字尾。
// ECDICT exchange 的 0／1 是 lemma metadata，不是可作答字面答案。

import { buildQuestion } from './sentence-spell-core.js';

export const SOURCE_FORMAT = 'sentence-spell-source-v1';

const ANSWER_CODES = new Set(['p', 'd', 'i', '3', 'r', 't', 's']);
const LEMMA_CODES = new Set(['0', '1']);
const TOKEN_RX = /[\p{Script=Latin}\p{M}]+(?:['’\-][\p{Script=Latin}\p{M}]+)*/gu;

function norm(value) {
  return String(value ?? '').trim().toLocaleLowerCase();
}

function fail(reason, detail) {
  return { ok: false, reason, detail: detail ?? null };
}

/** 解析 ECDICT exchange；只把 p/d/i/3/r/t/s 視為可作答詞形，0/1 留在 lemmaMetadata。 */
export function parseExchange(exchange) {
  const out = { raw: typeof exchange === 'string' ? exchange : '', forms: [], lemmaMetadata: [], unknown: [] };
  if (typeof exchange !== 'string' || exchange.trim() === '') return out;
  for (const item of exchange.split('/')) {
    const token = item.trim();
    if (!token) continue;
    const colon = token.indexOf(':');
    if (colon <= 0) {
      out.unknown.push({ token });
      continue;
    }
    const code = token.slice(0, colon).trim();
    const form = token.slice(colon + 1).trim();
    if (!form) continue;
    if (ANSWER_CODES.has(code)) out.forms.push({ code, form });
    else if (LEMMA_CODES.has(code)) out.lemmaMetadata.push({ code, form });
    else out.unknown.push({ code, form });
  }
  return out;
}

/**
 * 由明確提供的 word／lexiconEntry 導出可接受詞形與來源證明。
 * 多個 sourceMatches 對同一 headword 給出不同詞形時視為 ambiguous，不挑選。
 * headword 與目標字不符的 sourceMatches 一律忽略並標為 unknown（保留 wordId 綁定）。
 */
export function describeSourceForms({ word, lexiconEntry } = {}) {
  if (!word || typeof word !== 'object') return fail('missing_word');
  if (word.id === undefined || word.id === null || String(word.id) === '') return fail('missing_word_id');
  const wordId = String(word.id);
  const lemma = String(word.word ?? '').trim();
  if (!lemma) return fail('missing_lemma');

  const forms = new Map();
  const addForm = (form, evidence) => {
    const key = norm(form);
    if (!key) return;
    if (!forms.has(key)) forms.set(key, { form: String(form), evidence: [] });
    const bucket = forms.get(key);
    if (!bucket.evidence.some((e) => JSON.stringify(e) === JSON.stringify(evidence))) bucket.evidence.push(evidence);
  };

  addForm(lemma, { kind: 'exact', form: lemma, source: 'word.word', wordId });

  let sourceMatchesUsed = 0;
  let sourceMatchesIgnored = 0;
  const ignoredMatches = [];
  const lemmaMetadata = [];
  const exchanges = [];

  if (lexiconEntry) {
    if (String(lexiconEntry.id) !== wordId) {
      return fail('lexicon_word_id_mismatch', { wordId, lexiconId: String(lexiconEntry.id) });
    }
    if (lexiconEntry.word !== undefined && norm(lexiconEntry.word) !== norm(lemma)) {
      return fail('lexicon_word_mismatch', { word: lemma, lexiconWord: String(lexiconEntry.word) });
    }
    const matches = Array.isArray(lexiconEntry.sourceMatches) ? lexiconEntry.sourceMatches : [];
    const bound = matches.filter((m) => m && norm(m.headword) === norm(lemma));
    sourceMatchesIgnored = matches.length - bound.length;
    for (const m of matches) {
      if (!bound.includes(m)) ignoredMatches.push({ headword: m?.headword ?? null, match: m?.match ?? null });
    }

    if (bound.length === 0 && matches.length > 1) {
      const sets = new Set(matches.map((m) => JSON.stringify(parseExchange((m?.raw ?? {}).exchange).forms.map((f) => norm(f.form)).sort())));
      if (sets.size > 1) return fail('ambiguous_source_matches', { wordId, word: lemma, matches: matches.length });
    }

    if (bound.length > 1) {
      const parsed = bound.map((m) => ({ match: m, parsed: parseExchange((m?.raw ?? {}).exchange) }));
      const sets = new Set(parsed.map((p) => JSON.stringify(p.parsed.forms.map((f) => norm(f.form)).sort())));
      if (sets.size > 1) return fail('ambiguous_source_matches', { wordId, word: lemma, matches: bound.length });
    }

    for (const m of bound) {
      sourceMatchesUsed += 1;
      const parsed = parseExchange((m?.raw ?? {}).exchange);
      exchanges.push(parsed.raw);
      for (const meta of parsed.lemmaMetadata) lemmaMetadata.push({ ...meta, headword: m.headword, source: 'lexicon.sourceMatches[].raw.exchange' });
      for (const form of parsed.forms) {
        addForm(form.form, {
          kind: 'declared_form',
          form: form.form,
          code: form.code,
          source: 'lexicon.sourceMatches[].raw.exchange',
          exchange: parsed.raw,
          headword: m.headword,
          match: m.match ?? null,
          wordId,
        });
      }
    }
  }

  return {
    ok: true,
    wordId,
    lemma,
    forms: [...forms.values()],
    formList: [...forms.keys()],
    coverage: {
      exact: true,
      declaredForms: [...forms.keys()].filter((f) => f !== norm(lemma)),
      lexiconUsed: Boolean(lexiconEntry),
      sourceMatchesUsed,
      sourceMatchesIgnored,
      ignoredMatches,
      lemmaMetadata,
      exchanges,
    },
  };
}

/** 依 Latin 詞邊界切 token，回傳原句 offset（非字母相鄰不會被併入）。 */
export function tokenizeSentence(en) {
  const text = typeof en === 'string' ? en : '';
  const tokens = [];
  for (const m of text.matchAll(TOKEN_RX)) {
    tokens.push({ text: m[0], lower: m[0].toLocaleLowerCase(), start: m.index, end: m.index + m[0].length });
  }
  return tokens;
}

function evidenceFor(described, surface) {
  const bucket = described.forms.find((f) => f.form.toLowerCase() === surface.toLowerCase());
  return bucket ? bucket.evidence : [];
}

/**
 * 由來源自動找出現位置：只認「整個 token 等於已宣告詞形」。
 * 同一 surface 重複出現時全部回傳（共用一次作答）；不同 surface 同時出現則明確拒絕。
 * 子字串（display 對 play）或衍生詞（runner 對 run）不會被當成命中，只列為 nearMatches。
 */
export function findOccurrences({ en, described }) {
  if (typeof en !== 'string' || en.length === 0) return fail('no_example');
  const allowed = new Map(described.forms.map((f) => [f.form.toLowerCase(), f]));
  const tokens = tokenizeSentence(en);
  const matched = [];
  const nearMatches = [];
  for (const token of tokens) {
    const exact = allowed.get(token.lower);
    if (exact) {
      matched.push({ start: token.start, end: token.end, surface: token.text, form: exact.form });
      continue;
    }
    for (const candidate of allowed.values()) {
      const base = candidate.form.toLowerCase();
      if (token.lower.startsWith(base + "'") || token.lower.startsWith(base + '’')) {
        nearMatches.push({ ...token, kind: 'possessive_or_clitic', target: candidate.form });
        break;
      }
      if (token.lower.includes(base)) {
        nearMatches.push({ ...token, kind: 'substring', target: candidate.form });
        break;
      }
    }
  }
  if (matched.length === 0) return fail('no_target_occurrence', { nearMatches });
  const surfaces = new Set(matched.map((m) => m.surface.toLowerCase()));
  if (surfaces.size > 1) return fail('multiple_surface_forms', { surfaces: [...surfaces] });
  return { ok: true, occurrences: matched, nearMatches };
}

function readSentence({ sentence, en, zh }) {
  const source = sentence && typeof sentence === 'object' ? sentence : {};
  const resolvedEn = typeof en === 'string' ? en : typeof source.en === 'string' ? source.en : null;
  const resolvedZh = zh !== undefined ? zh : source.zh;
  const sourceSentenceId = source.id ?? source.sourceSentenceId ?? source.sentenceId ?? null;
  return { en: resolvedEn, zh: resolvedZh, sourceSentenceId };
}

/**
 * 建立一題例句拼字題目（純資料，不寫事件、不持久化）。
 * @param {object} input
 * @param {object} input.word 明確提供的 words.json 條目（需 id／word）
 * @param {{en:string,zh?:string,id?:string|number}} [input.sentence] 明確提供的例句
 * @param {object} [input.lexiconEntry] 明確提供的 lexicon sidecar 條目（含 sourceMatches）
 * @param {string|number} [input.sourceSentenceId]
 * @param {string} [input.en]
 * @param {string|string[]} [input.zh] 多於一個意思時明確拒絕，不自行挑選
 * @param {Array<{start:number,end:number}>} [input.occurrences] 呼叫端指定的出現位置（不決定重複政策）
 */
export function buildQuestionFromSource(input = {}) {
  const { word, sentence, lexiconEntry, occurrences: explicitOccurrences } = input;
  if (!word || typeof word !== 'object') return fail('missing_word');

  const described = describeSourceForms({ word, lexiconEntry });
  if (!described.ok) return described;

  const read = readSentence(input);
  if (!read.en) return fail('no_example', { code: 'missing_sentence' });
  if (read.zh === undefined || read.zh === null || (typeof read.zh === 'string' && read.zh.trim() === '')) {
    return fail('unreliable_example', { code: 'missing_meaning' });
  }
  let meaning;
  if (Array.isArray(read.zh)) {
    const distinct = [...new Set(read.zh.map((v) => String(v).trim()).filter(Boolean))];
    if (distinct.length !== 1) return fail('ambiguous_meaning', { meanings: distinct });
    meaning = distinct[0];
  } else if (typeof read.zh === 'string') {
    meaning = read.zh;
  } else {
    return fail('ambiguous_meaning', { type: typeof read.zh });
  }

  const sourceSentenceId = input.sourceSentenceId ?? read.sourceSentenceId;
  if (sourceSentenceId === undefined || sourceSentenceId === null || String(sourceSentenceId) === '') {
    return fail('missing_source_sentence_id');
  }

  let occurrences;
  let nearMatches = [];
  if (explicitOccurrences !== undefined) {
    if (!Array.isArray(explicitOccurrences) || explicitOccurrences.length === 0) return fail('no_occurrences');
    occurrences = [];
    for (const raw of explicitOccurrences) {
      const start = Number(raw?.start);
      const end = Number(raw?.end);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > read.en.length || start >= end) {
        return fail('invalid_occurrence', raw);
      }
      const surface = read.en.slice(start, end);
      if (!described.formList.includes(surface.toLowerCase())) {
        return fail('unsupported_surface_form', { surface, allowed: described.formList });
      }
      occurrences.push({ start, end, surface });
    }
    const surfaces = new Set(occurrences.map((o) => o.surface.toLowerCase()));
    if (surfaces.size > 1) return fail('multiple_surface_forms', { surfaces: [...surfaces] });
  } else {
    const found = findOccurrences({ en: read.en, described });
    if (!found.ok) return found;
    occurrences = found.occurrences;
    nearMatches = found.nearMatches;
  }

  const surface = occurrences[0].surface;
  const evidence = evidenceFor(described, surface);
  if (evidence.length === 0) return fail('unsupported_surface_form', { surface, allowed: described.formList });

  const built = buildQuestion({
    wordId: described.wordId,
    lemma: described.lemma,
    surface,
    sourceSentenceId,
    en: read.en,
    zh: meaning,
    occurrences,
    morphologyEvidence: evidence,
  });
  if (!built.ok) return built;

  return {
    ok: true,
    question: built.question,
    source: {
      format: SOURCE_FORMAT,
      forms: described.forms.map((f) => ({ form: f.form, evidence: f.evidence })),
      coverage: described.coverage,
      nearMatches,
    },
  };
}

export default {
  SOURCE_FORMAT,
  parseExchange,
  describeSourceForms,
  tokenizeSentence,
  findOccurrences,
  buildQuestionFromSource,
};
