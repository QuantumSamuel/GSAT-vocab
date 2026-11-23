// 從教材提取既有題目（7.4 第 3 段，2026-11-24）
//
// 目的：使用者貼上「本來就有題目的教材」（課本習題、考卷），把題幹／選項／答案解析成結構化題目。
// 三條硬規則：
//   1. 沒有答案的題目「不入庫」，只能進待補清單（不猜、不自動補）
//   2. 每題給信心分數；不足 4 個選項或找不到答案就降低
//   3. 純規則解析，不呼叫 AI；解析不了就明說，不硬湊

const ANSWER_SECTION = /(?:^|\n)\s*(?:答案|解答|answer\s*key|answers?)\s*[:：]?\s*/i;

export function confidenceOf(q) {
  let score = 0;
  if (q.options.length >= 4) score += 0.5;
  else if (q.options.length === 3) score += 0.3;
  else if (q.options.length === 2) score += 0.15;
  if (q.answer) score += 0.35;
  if (q.stem && q.stem.length >= 12) score += 0.15;
  return Math.min(1, Number(score.toFixed(2)));
}

function parseAnswerKey(text) {
  const map = new Map();
  const m = ANSWER_SECTION.exec(text);
  if (!m) return map;
  const tail = text.slice(m.index + m[0].length);
  // 形式一：1-5 DABCB ／ 6-10 ABCDE
  const ranges = tail.matchAll(/(\d{1,3})\s*[-–~]\s*(\d{1,3})\s*[:：]?\s*([A-Da-d]{2,20})/g);
  for (const r of ranges) {
    const start = Number(r[1]);
    const letters = r[3].toUpperCase().split('');
    letters.forEach((ch, i) => { if (/[A-D]/.test(ch)) map.set(String(start + i), ch); });
  }
  // 形式二：1. A ／ 2.B ／ 3：C
  const pairs = tail.matchAll(/(\d{1,3})\s*[.、:：)]?\s*([A-Da-d])(?![A-Za-z])/g);
  for (const p of pairs) {
    const n = Number(p[1]);
    if (!map.has(String(n))) map.set(String(n), p[2].toUpperCase());
  }
  return map;
}

export function extractQuestions(text) {
  const src = String(text || '');
  const answerKey = parseAnswerKey(src);
  const body = ANSWER_SECTION.test(src) ? src.slice(0, ANSWER_SECTION.exec(src).index) : src;
  const lines = body.split(/\r?\n/);

  const raw = [];
  let cur = null;
  for (const line of lines) {
    const t = line.trim();
    if (!t) { if (cur) cur.lines.push(''); continue; }
    const qStart = /^(\d{1,3})\s*[.、)]\s*(.+)$/.exec(t);
    // 一行可能塞多個選項：(A) face (B) faces (C) faced (D) facing
    const optParts = t.split(/(?=[（(]?[A-D][)）.、])/).filter((x) => /^[（(]?[A-D][)）.、]/.test(x));
    if (qStart && !optParts.length) {
      if (cur) raw.push(cur);
      cur = { no: qStart[1], stem: qStart[2].trim(), lines: [], options: [] };
      continue;
    }
    if (optParts.length && cur) {
      for (const part of optParts) {
        const o = /^[（(]?([A-Da-d])[)）.、]\s*(.+)$/.exec(part.trim());
        if (o) cur.options.push({ letter: o[1].toUpperCase(), text: o[2].trim() });
      }
      continue;
    }
    if (cur) cur.lines.push(t);
  }
  if (cur) raw.push(cur);

  const items = [];
  const needsAnswer = [];
  for (const q of raw) {
    const stem = [q.stem, ...q.lines].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    const answerLetter = answerKey.get(String(q.no)) || null;
    const answerText = answerLetter ? (q.options.find((o) => o.letter === answerLetter)?.text || answerLetter) : null;
    const rec = {
      no: q.no,
      stem,
      options: q.options.map((o) => o.text),
      letters: q.options.map((o) => o.letter),
      answerLetter,
      answer: answerText,
      confidence: 0,
    };
    rec.confidence = confidenceOf(rec);
    if (q.options.length < 2 || !stem) continue; // 解析不了就不硬湊
    if (rec.answerText || rec.answer) items.push(rec);
    else needsAnswer.push(rec);
  }

  return {
    items: items.filter((r) => r.answer),
    needsAnswer,
    stats: { parsed: raw.length, ready: items.filter((r) => r.answer).length, needsAnswer: needsAnswer.length, answerKeyFound: answerKey.size },
  };
}