// ============================================================
// Shared Translation Practice Engine（4.1.1；4.3.1 批次 2 擴充）
// direct-in-sentence 空格輸入：題庫挖空／題庫整句共用同一套機制
// 規則：不分大小寫、忽略空格、標點只顯示不需輸入、雙擊揭示單格、
//       顯示答案＝完整句子＋重要 content words、無計分（學習導向）
//
// 4.3.1 批次 2（第 7/8/9 項與選擇第 4/5 項共用）：
//   ① content words 原型還原（listening → listen，字庫只收原形）
//   ② 迷你單詞卡（.mini-card 緊湊版：Lv／星級／音標／釋義前 3 條＋加入單詞本／加入複習）
//   ③ 練習結束的 joinPool 面板（新建單詞本／合併到現有單詞本＋加入複習狀態）
//   ④ 答對自動標綠、最後一格答對觸發 opts.onAllCorrect、空格鍵切下一格
// ============================================================
import { el, escapeHtml } from '../core/ui.js';
import { findWordWithLemma, mountMiniCard } from './word-card.js';

// 斷詞：英文單字／縮寫／連字號；標點與空白皆為獨立 punct token
const TOKEN_RE = /[A-Za-z][A-Za-z'’-]*|\S/g;

/**
 * 把句子切成 token：[{t:'word', w:'The'}, {t:'punct', w:' '}, {t:'punct', w:','}, ...]
 * （Pool A 複核：regex 的每個 match 原本一律標 word，行內標點/引號/括號會佔 word 序號
 *  造成 pos 位移——改為僅字母開頭的 match 是 word，與 alignBlanks、資料檔重算口徑一致）
 */
export function tokenize(sentence) {
  const out = [];
  const re = new RegExp(TOKEN_RE.source, 'g');
  let last = 0, m;
  while ((m = re.exec(sentence)) !== null) {
    if (m.index > last) out.push({ t: 'punct', w: sentence.slice(last, m.index) });
    out.push({ t: /^[A-Za-z]/.test(m[0]) ? 'word' : 'punct', w: m[0] });
    last = m.index + m[0].length;
  }
  if (last < sentence.length) out.push({ t: 'punct', w: sentence.slice(last) });
  return out;
}

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
const stripPunct = (s) => String(s || '').replace(/[.,!?;:'"()]/g, '');

/**
 * 4.1.1 修復（QA 實證）：blanks.pos 的索引基準各來源不一（題庫標記／AI 的空白切分序號），
 * 統一以 answer 文字為錨，對齊到「tokenize 後 t==='word' 的 0-based 序號」（不含標點與空白）。
 * 同一文字出現多次時依輸入順序貪心往後配，全部對不上則丟棄該空格。
 */
export function alignBlanks(sentence, rawBlanks) {
  const words = tokenize(sentence)
    .filter((t) => t.t === 'word')
    .map((t) => norm(stripPunct(t.w)));
  const used = new Set();
  const out = [];
  let cursor = 0;
  const sorted = [...(rawBlanks || [])].sort((a, b) => (Number(a.pos) || 0) - (Number(b.pos) || 0));
  for (const rb of sorted) {
    const target = norm(stripPunct(rb.answer));
    if (!target) continue;
    let found = -1;
    for (let i = cursor; i < words.length; i++) {
      if (!used.has(i) && words[i] === target) { found = i; break; }
    }
    if (found < 0) {
      for (let i = 0; i < words.length; i++) {
        if (!used.has(i) && words[i] === target) { found = i; break; }
      }
    }
    if (found < 0) continue;
    used.add(found);
    cursor = found + 1;
    out.push({ ...rb, pos: found });
  }
  return out.sort((a, b) => a.pos - b.pos);
}

/**
 * 渲染 direct-in-sentence 句子。
 * spec: { sentence, zh, blanks: [{pos, answer, alts[]}] }（pos 經 alignBlanks 對齊，僅為提示）
 * opts: { onRevealAll?, onAnswer?(pos, userAns, correct) }
 * 回傳 { inputs, isAllCorrect(), revealAll(), markGrades(), getAnswers() }
 */
export function mountSentence(containerEl, spec, opts = {}) {
  const tokens = tokenize(spec.sentence);
  const blankAt = new Map(alignBlanks(spec.sentence, spec.blanks).map((b) => [b.pos, b]));
  const inputs = new Map(); // word 序號 -> input

  let wordIdx = -1;
  const nodes = tokens.map((tk) => {
    if (tk.t === 'punct') {
      const span = document.createElement('span');
      span.className = 'tz-punct';
      span.textContent = tk.w;
      return span;
    }
    wordIdx++;
    const wrap = document.createElement('span');
    wrap.className = 'tz-word';
    const b = blankAt.get(wordIdx);
    if (b) {
      const input = document.createElement('input');
      input.className = 'tz-blank';
      input.size = Math.max(4, stripPunct(b.answer).length);
      input.autocapitalize = 'off';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.dataset.pos = String(wordIdx);
      input.addEventListener('keydown', (e) => {
        // 英文字母輸入時自動進入第一個未完成空格（spec 57）
        if (e.key.length === 1 && !input.value && opts.focusFirstUnfinished) opts.focusFirstUnfinished(input);
        // 4.3.1 批次 2 第 9 項：空格鍵＝「確認這格並跳下一格」（當前格已對才跳；preventDefault 防捲動）
        if (e.key === ' ') {
          if (matches(input.value, b)) {
            e.preventDefault();
            checkOne(input, b, true);
            advance(input);
          }
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          checkOne(input, b, true);
          advance(input);
        }
      });
      input.addEventListener('input', () => {
        // 4.3.1 批次 2 第 8 項：答對即標綠（現行要 Enter 才上色）；最後一格答對 → onAllCorrect
        if (matches(input.value, b)) {
          checkOne(input, b, true);
          advance(input);
          if (opts.onAllCorrect && isAllCorrect()) opts.onAllCorrect();
        }
        if (opts.onInput) opts.onInput();
      });
      input.addEventListener('dblclick', () => {
        input.value = b.answer;
        input.classList.add('revealed');
      });
      inputs.set(wordIdx, input);
      wrap.appendChild(input);
    } else {
      wrap.textContent = tk.w;
    }
    return wrap;
  });

  const sent = document.createElement('div');
  sent.className = 'tz-sentence';
  nodes.forEach((n) => sent.appendChild(n));
  // 5.0.4 D 項：中文題目**移到句子上方自成一行**（原本是接在句子後面的括號行）。
  // 與拼寫單字的兩行版面對齊：中文提示一行、英文輸入一行。
  // 放在句子上方而不是下面，因為「先讀中文再填空」是作答順序；原來接在句子後面時
  // 使用者要先看完整句才在下方找到提示。
  if (spec.zh) {
    const zh = document.createElement('p');
    zh.className = 'tz-zh';
    zh.textContent = spec.zh;
    containerEl.appendChild(zh);
  }
  containerEl.appendChild(sent);

  // 5.0.4 D 項：當前輸入格＝accent 下劃線＋閃爍（只用 opacity；已答對／已答錯不閃）。
  // 誰是「當前格」＝document.activeElement（點哪格就是哪格）；鍵盤作答時由 advance()
  // 把焦點移到下一格，focus 事件會自動把閃爍跟著移過去。已對／已錯的格（.ok／.bad）
  // 維持不閃——否則「打對了」的綠色會一直跳，使用者看不出自己有沒有答對。
  const setActive = (input) => {
    for (const el0 of inputs.values()) el0.classList.remove('tz-blank--at');
    input?.classList.add('tz-blank--at');
  };
  for (const el0 of inputs.values()) {
    el0.addEventListener('focus', () => setActive(el0));
    el0.addEventListener('blur', () => el0.classList.remove('tz-blank--at'));
  }

  function matches(value, b) {
    const v = norm(stripPunct(value));
    if (!v) return false;
    return [b.answer, ...(b.alts || [])].some((a) => norm(a) === v);
  }
  function checkOne(input, b, mark) {
    const good = matches(input.value, b);
    if (mark) {
      input.classList.remove('ok', 'bad');
      input.classList.add(good ? 'ok' : 'bad');
    }
    if (opts.onAnswer) opts.onAnswer(Number(input.dataset.pos), input.value, good);
    return good;
  }
  function advance(input) {
    const arr = [...inputs.entries()].sort((a, b) => a[0] - b[0]);
    const idx = arr.findIndex(([, el0]) => el0 === input);
    for (let j = idx + 1; j < arr.length; j++) {
      if (!arr[j][1].value || !matches(arr[j][1].value, blankAt.get(Number(arr[j][1].dataset.pos)))) {
        arr[j][1].focus();
        return;
      }
    }
  }
  function isAllCorrect() {
    for (const [pos, input] of inputs) {
      const b = blankAt.get(pos);
      if (!b || !matches(input.value, b)) return false;
    }
    return inputs.size > 0;
  }
  function revealAll() {
    for (const [pos, input] of inputs) {
      const b = blankAt.get(pos);
      input.value = b.answer;
      input.classList.add('revealed');
      input.disabled = true;
    }
  }
  // 4.1.1 修復（QA 實證）：標記每個已填空格的對錯——先算結果再上色，不得先 remove 再 contains 判斷
  function markGrades() {
    for (const [pos, input] of inputs) {
      if (!input.value) continue;
      const b = blankAt.get(pos);
      const good = Boolean(b && matches(input.value, b));
      input.classList.remove('ok', 'bad');
      input.classList.add(good ? 'ok' : 'bad');
    }
  }
  return {
    inputs,
    isAllCorrect,
    revealAll,
    markGrades,
    getAnswers: () => [...inputs.entries()].map(([pos, input]) => ({ pos, answer: input.value })),
  };
}

/**
 * 顯示答案後的 content words 列表：點擊→迷你單詞卡；加入單詞本／加入複習（spec 58）
 * wireWordActions(container, { words, bookName, joinPool, onAdded }) —— words: 字面陣列（content words）
 *
 * 4.3.1 批次 2 第 1 項：句中抽到的字是屈折形（listening／students），字庫只收原形——
 * 改由 word-card.js 的 findWordWithLemma 還原後顯示（.mini-card 緊湊版），
 * 單詞本鈕用的是還原後原形的 id；加入的字進 joinPool（練習級），完成畫面由
 * mountJoinPanel 提供「新建／合併」（與選擇練習同一機制）。
 */
export function wireWordActions(container, { words, bookName = '中譯英練習收錄', joinPool = null, onAdded } = {}) {
  const box = document.createElement('div');
  box.className = 'content-words';
  box.innerHTML = '<div class="tp-caption">重要單字（點擊查看中文意思）：</div>';
  const meaning = document.createElement('div');
  meaning.className = 'cw-meaning';
  meaning.id = 'cw-meaning';
  box.addEventListener('click', (e) => {
    const cw = e.target.closest('.cw');
    if (!cw) return;
    const raw = cw.textContent.trim();
    // 同一個字再點一次＝收合
    const open = box.querySelector('.mc-slot[data-for="' + cw.dataset.i + '"]');
    if (open) { open.remove(); cw.classList.remove('cw--open'); return; }
    box.querySelectorAll('.mc-slot').forEach((n) => n.remove());
    box.querySelectorAll('.cw--open').forEach((n) => n.classList.remove('cw--open'));
    const slot = document.createElement('div');
    slot.className = 'mc-slot';
    slot.dataset.for = cw.dataset.i;
    cw.after(slot);
    cw.classList.add('cw--open');
    const hit = findWordWithLemma(raw);
    if (!hit) {
      slot.appendChild(el(`<div class="mini-card mini-card--none"><div class="mc-senses"><div>「${escapeHtml(raw)}」不在字庫中。</div></div></div>`));
      return;
    }
    mountMiniCard(slot, {
      word: hit.word,
      raw: hit.viaLemma ? raw : '',
      bookName,
      joinPool,
      onChange: (w) => { if (onAdded) onAdded(w.id); },
    });
  });
  words.forEach((w, i) => {
    const c = document.createElement('span');
    c.className = 'cw';
    c.dataset.i = String(i);
    c.textContent = w;
    box.appendChild(c);
  });
  box.appendChild(meaning);
  container.appendChild(box);
}
