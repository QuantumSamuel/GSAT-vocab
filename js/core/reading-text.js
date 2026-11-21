// ============================================================
// 閱讀模式文字層（6.2.0）：純函式、零 DOM。
// 目標（使用者核准的 6.2.0 第一批）：
//   ① 原文一字不動：切段與切詞只記錄「起訖 offset」，任何畫面都回原文切片，
//      不重組、不正規化大小寫、不吞空白。測試以「把 token 值接回去 === 原段落」把關。
//   ② 詞形歸併走既有 search.findWordWithTense（words.json 的 tense 欄位），
//      本檔不另建字典、不冒充查詞結果；查不到就標 miss，由畫面顯示「字庫未收錄」。
//   ③ stats 以「詞條識別碼」聚合：同一個字的大小寫、變化形都指向同一筆，
//      閱讀頁的高亮、字數統計、批次已懂才不會把 went／go 當兩個字。
// 為什麼 offset 是相對「段落字串」而不是整篇：貼上文章以空行分段，段落之間不顯示
//   分隔字元；用段落內 offset 才能讓畫面精確切出原文（含段落內換行），
//   整篇的累計位置另外用 docStart 提供，兩者都不改動任何字元。
// ============================================================

// 英文詞：允許字內單引號／彎引號／連字號（don't、rock-'n'-roll、well-known）。
// 不含句末所有格撇號（heroes' → 取 heroes），避免把標點算進查詞鍵。
const WORD_RE = /[A-Za-z]+(?:['\u2019-][A-Za-z]+)*/g;

/** 查詞鍵：小寫、彎引號統一成直引號（只影響查詞鍵，畫面仍用原始切片 raw）。 */
export function normalizeToken(raw) {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/^['-]+|['-]+$/g, '');
}

/**
 * 切段：只認「空行」（兩個以上換行）為段落界線。
 * 段落內部的單一換行保留（原文可能刻意換行）；CRLF 先正規化成 LF，
 * 這是換行字元的等價表示，不算改寫文字內容。
 */
export function splitParagraphs(raw) {
  const text = String(raw ?? '').replace(/\r\n?/g, '\n');
  if (!text.trim()) return [];
  return text
    .split(/\n{2,}/)
    .map((s) => s.replace(/^\n+|\n+$/g, ''))
    .filter((s) => s.trim().length > 0);
}

/** 切一個段落：文字片段與單詞片段交錯，兩者都帶精確 start／end（相對段落）。 */
export function tokenizeParagraph(text) {
  const src = String(text ?? '');
  const tokens = [];
  let last = 0;
  let m;
  WORD_RE.lastIndex = 0;
  while ((m = WORD_RE.exec(src))) {
    if (m.index > last) tokens.push({ type: 'text', value: src.slice(last, m.index), start: last, end: m.index });
    tokens.push({
      type: 'word',
      value: m[0],
      start: m.index,
      end: m.index + m[0].length,
      raw: m[0],
      key: normalizeToken(m[0]),
    });
    last = m.index + m[0].length;
  }
  if (last < src.length) tokens.push({ type: 'text', value: src.slice(last), start: last, end: src.length });
  return tokens;
}

/** 整篇切詞：回傳 { paragraphs:[{index,text,docStart,tokens}], chars }（chars＝原文字元數）。 */
export function tokenizeArticle(raw) {
  const paragraphs = [];
  let docStart = 0;
  for (const text of splitParagraphs(raw)) {
    paragraphs.push({ index: paragraphs.length, text, docStart, tokens: tokenizeParagraph(text) });
    docStart += text.length;
  }
  return { paragraphs, chars: docStart };
}

/**
 * 套上詞形解析：resolve(rawKey) → { word, viaTense } 或 null。
 * 回傳新的 { paragraphs, stats }；stats 的 key＝字庫 id（字串）或 'raw:xxx'（未收錄）。
 * 每個 word token 會多出：key（聚合鍵）、wordId、lemma、level、miss、viaTense、raw。
 * 這個函式不改原文：token.value 與 start／end 原樣保留。
 */
export function annotate(doc, resolve) {
  const cache = new Map();
  const stats = new Map();
  const paragraphs = doc.paragraphs.map((para) => ({
    ...para,
    tokens: para.tokens.map((tok, ti) => {
      if (tok.type !== 'word') return tok;
      let hit;
      if (cache.has(tok.key)) hit = cache.get(tok.key);
      else {
        hit = resolve ? resolve(tok.key) : null;
        cache.set(tok.key, hit);
      }
      const word = hit?.word ? hit.word : null;
      const key = word ? String(word.id) : `raw:${tok.key}`;
      const lemma = word ? String(word.word) : tok.raw;
      const next = {
        ...tok,
        key,
        wordId: word ? word.id : null,
        lemma,
        level: word?.level ?? null,
        miss: !word,
        viaTense: Boolean(hit?.viaTense),
      };
      const st = stats.get(key) || {
        key,
        wordId: next.wordId,
        word: lemma,
        level: next.level,
        miss: next.miss,
        count: 0,
        forms: [],
        first: { pi: para.index, ti },
      };
      st.count++;
      // 詞形提示只記「文中寫法與原形不同」的形式（含大小寫變化、時態／複數）。
      const low = tok.raw.toLowerCase();
      if (!st.miss && low !== String(lemma).toLowerCase() && !st.forms.includes(low)) st.forms.push(low);
      stats.set(key, st);
      return next;
    }),
  }));
  return { paragraphs, stats };
}

/** 文章統計：不同詞條數、可點單詞總數（畫面說明用）。 */
export function statsSummary(stats) {
  let distinct = 0;
  let positions = 0;
  for (const st of stats.values()) {
    distinct++;
    positions += st.count;
  }
  return { distinct, positions };
}

/**
 * 找出 token 所在句子的起訖（相對段落）。字卡「文中出現」只引用這一句，
 * 不複製整段，也不改寫原文；回傳的切片可直接以 textContent 分段顯示。
 */
export function sentenceBounds(text, start, end) {
  const src = String(text ?? '');
  const s = Math.max(0, Math.min(Number(start) || 0, src.length));
  const e = Math.max(s, Math.min(Number(end) || s, src.length));
  let from = s;
  while (from > 0) {
    const prev = src.slice(Math.max(0, from - 3), from);
    if (/[.!?]["'\u201d\u2019)\]]?\s$/.test(prev)) break;
    from--;
  }
  let to = e;
  while (to < src.length) {
    if (/[.!?]/.test(src[to])) {
      // 句末標點後面允許結尾引號／括號，再接空白或段落結尾才算斷句。
      // 這樣「3.14」「U.S.A」不會被小數點／縮寫點切成半句。
      let j = to + 1;
      while (j < src.length && /["'\u201d\u2019)\]]/.test(src[j])) j++;
      if (j >= src.length || /\s/.test(src[j])) {
        to = j;
        break;
      }
    }
    to++;
  }
  return { start: from, end: Math.max(to, e) };
}
