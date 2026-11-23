// 貼文字→克漏字（7.4.0 第一段，2026-11-24）
//
// 純邏輯：從使用者貼上的文章挑出「字庫內、指定等級範圍」的字，挖空成四選一。
// 答案永遠是原文裡的那個字；干擾項取同詞性、同等級附近的其他字，答案可重現、可驗證。
// 不呼叫 AI、不連網路。

const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'and', 'or', 'in', 'on', 'at', 'for', 'with', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that', 'these', 'those', 'as', 'by', 'from', 'but', 'not', 'so', 'if', 'than', 'then', 'there', 'their', 'they', 'we', 'you', 'he', 'she', 'i']);

export const DEFAULT_MAX_ITEMS = 10;
export const PASSAGE_CHARS = 400;

// 7.6.4：把長文切成「段落」——先依空行，太長再依句數／字數切。
// 目的：出題不要全部擠在前幾句，長文也能涵蓋後半段。
export function splitPassages(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const blocks = raw.split(/\n\s*\n+/).map((b) => b.trim()).filter(Boolean);
  const out = [];
  for (const b of blocks) {
    if (b.length <= PASSAGE_CHARS) { out.push(b); continue; }
    const sentences = b.split(/(?<=[.!?])\s+/);
    let buf = '';
    for (const s of sentences) {
      if ((buf + ' ' + s).trim().length > PASSAGE_CHARS && buf) { out.push(buf.trim()); buf = s; }
      else buf = (buf ? buf + ' ' : '') + s;
    }
    if (buf.trim()) out.push(buf.trim());
  }
  return out;
}

export function tokensOf(text) {
  return String(text || '').split(/([^A-Za-z'-]+)/).filter((t) => t && /[A-Za-z]/.test(t));
}

function sentenceOf(text, word) {
  const parts = String(text || '').split(/(?<=[.!?])\s+/);
  const found = parts.find((s) => new RegExp('(^|[^A-Za-z])' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^A-Za-z]|$)', 'i').test(s));
  return (found || '').trim();
}

/**
 * @param {string} text 使用者貼上的文章
 * @param {object} opts
 *   words: [{id, word, level, pos}]（字庫）
 *   minLv, maxLv: 允許挖空的等級範圍（含）
 *   maxItems: 最多幾題
 * @returns {{items: Array<{word:string, sentence:string, options:string[], answer:string}>, skipped: object}}
 */
export function buildCloze(text, { words = [], minLv = 1, maxLv = 6, maxItems = DEFAULT_MAX_ITEMS } = {}) {
  const inRange = words.filter((w) => {
    const lv = Number(w.level);
    return Number.isFinite(lv) && lv >= minLv && lv <= maxLv && w.pos && !/^\s*$/.test(w.word);
  });
  const byWord = new Map(inRange.map((w) => [String(w.word).toLowerCase(), w]));
  const pool = inRange.filter((w) => w.pos && String(w.word).length > 2);

  const passages = splitPassages(text);
  const perPassage = passages.length > 1 ? Math.max(1, Math.ceil(maxItems / passages.length)) : maxItems;
  const seen = new Set();
  const items = [];
  const scan = (chunk, passageNo) => {
    let made = 0;
    for (const tok of tokensOf(chunk)) {
      if (made >= perPassage || items.length >= maxItems) break;
      const key = tok.toLowerCase();
      if (STOP.has(key) || seen.has(key)) continue;
      const hit = byWord.get(key);
      if (!hit) continue;
      const sentence = sentenceOf(chunk, hit.word) || sentenceOf(chunk, key);
      if (!sentence) continue;
      const distractors = pool
        .filter((w) => w.pos === hit.pos && w.word.toLowerCase() !== key && w.word.toLowerCase() !== hit.word.toLowerCase())
        .sort((a, b) => Math.abs(Number(a.level) - Number(hit.level)) - Math.abs(Number(b.level) - Number(hit.level)))
        .slice(0, 24);
      const pick = [];
      for (let i = 0; i < distractors.length && pick.length < 3; i += 1) {
        if (!pick.includes(distractors[i].word)) pick.push(distractors[i].word);
      }
      if (pick.length < 3) {
        for (const w of pool) {
          if (pick.length >= 3) break;
          const lw = w.word.toLowerCase();
          if (lw === key || pick.includes(w.word)) continue;
          pick.push(w.word);
        }
      }
      if (pick.length < 3) continue;
      const options = [hit.word, ...pick];
      options.sort((a, b) => (a.length - b.length) || a.localeCompare(b));
      items.push({ word: hit.word, sentence, options, answer: hit.word, passage: passageNo });
      seen.add(key);
      made += 1;
    }
  };
  for (let i = 0; i < passages.length; i += 1) {
    if (items.length >= maxItems) break;
    scan(passages[i], i + 1);
  }
  // 沒有段落資訊（例如超短文字）時，退回原本的整篇掃描
  if (!passages.length) scan(text, 1);
  const skipped = { wordsInRange: inRange.length, produced: items.length, text: String(text || '').length };
  return { items, skipped };
}

// ---- 本機題庫（只存本機、不上雲） ----
export const BANK_KEY = 'vocab2_custom_bank';
export const BANK_MAX = 50;

export function readBank() {
  try {
    const raw = JSON.parse(localStorage.getItem(BANK_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter((x) => x && Array.isArray(x.items) && x.items.length);
  } catch { return []; }
}

export function saveBankEntry(entry) {
  const list = readBank();
  const rec = {
    id: 'bank-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    title: String(entry.title || '自製題組').slice(0, 40),
    createdAt: new Date().toISOString(),
    items: (entry.items || []).slice(0, 50),
  };
  const next = [rec, ...list].slice(0, BANK_MAX);
  localStorage.setItem(BANK_KEY, JSON.stringify(next));
  return rec;
}

export function deleteBankEntry(id) {
  const next = readBank().filter((x) => x.id !== id);
  localStorage.setItem(BANK_KEY, JSON.stringify(next));
  return next.length;
}


// ---- 7.4.1：練本機題庫 ----
export function checkAnswer(item, choice) {
  const picked = String(choice || '');
  const answer = String(item?.answer || '');
  return { correct: picked.toLowerCase() === answer.toLowerCase(), answer };
}

export function progressOf(total, index) {
  const n = Math.max(0, Number(total) || 0);
  const i = Math.max(0, Math.min(n, Number(index) || 0));
  return { index: i, total: n, remaining: Math.max(0, n - i), percent: n ? Math.round((i / n) * 100) : 0, done: i >= n };
}
