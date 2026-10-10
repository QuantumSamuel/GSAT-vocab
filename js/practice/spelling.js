// ============================================================
// 引擎：拼寫練習（4.1.1）——單字／片語／中譯英（題庫＋AI）
// 中譯英＝Shared Translation Practice Engine 的拼寫應用
//
// 4.3.1 批次 3（單字／片語）：
//   ① 範圍二選一：字庫範圍（Lv 下拉）或單詞本（bank-picker 單選，只列單詞本）
//   ② 題數 segmented（5/10/15/全部），取代寫死的 5 題
//   ③ 片語拼寫的單詞本池＝該單詞本中 collocations 有片語的字；無資料則提示
// 5.0：範圍第三選「AI 題庫字」＝ai-bank.js aiTestedWords 的正解詞（中翻英不動）
// 5.0.x：① 單字／片語改為**逐字母鎖定**（打錯的字母變紅且不放行，必須打對才能前進；
//   全部字母到位＝該字完成，不再等「確認」按鈕）——錯誤字母**不做統計收集**（spec 5.7 第 1 節明示不做）。
//   既有自動還原原型（顯示正確答案）與空格跳格（translate-engine 的 ComeKey 機制）不受影響，
//   本次只動單字／片語拼寫的輸入判定層。
//   ② 完成畫面加「錯題重練」（拼錯的字組成記憶體臨時題集、同一引擎同一設定重跑）。
// 5.0.4 A／D 項：同一支引擎服務兩種學習需求，runWordSpell 的 opts.mode 決定「看不看得到字母」
//   ① mode:'blind'（**練習**拼寫，預設）＝盲打：作答中不顯示英文，中文一行＋輸入格一行；
//   ② mode:'show'（**學習**拼寫，由 pages/study.js 呼叫 startWordSpellStudy）＝顯示字母模式：
//      字母灰色顯示、打對轉綠、Enter 換下一題。
//   ③ 該字 settled 後 Enter＝下一題（最後一題＝完成畫面）；當前輸入格＝accent 下劃線＋閃爍。
// ============================================================
import { getWords, loadWords } from '../services/vocab.js';
import { el, escapeHtml, openDialog, toast } from '../core/ui.js';
import { mountShell, mountCompletion, shuffle } from './shell.js';
import { clearBackHandler } from '../core/router.js';
import { makeCombo } from '../core/motion.js';
import { mountSentence, tokenize, wireWordActions, alignBlanks } from './translate-engine.js';
import { mountJoinPanel } from './word-card.js';
import { generateJSON, hasKey, getProviderId } from '../services/ai/index.js';
import { addEvent } from '../services/store.js';
import { bankPickerHTML, readBankSelection, wordbookSources, poolFromWordbookSources } from '../core/bank-picker.js';
import { aiTestedWords, loadAiBank } from './ai-bank.js';
import { archiveTranslateItems, loadArchiveBank } from './archive-bank.js';

// ---------- 入口 ----------
export async function renderSpelling(main, subtype) {
  subtype = subtype || new URLSearchParams(location.hash.split('?')[1] || '').get('type') || 'word';
  await loadWords();
  const LABEL = { word: '拼寫・單字', phrase: '拼寫・片語', zh2en: '拼寫・中譯英' }[subtype] || '拼寫';
  if (subtype === 'zh2en') return renderZh2EnSource(main, LABEL);
  return renderWordSpellSetup(main, subtype, LABEL);
}

// ---------- 單字／片語：設定＋出題 ----------
// 4.3.1 批次 3：範圍（字庫／單詞本）＋題數；單詞本分支出題池＝該單詞本的字
async function renderWordSpellSetup(main, subtype, label) {
  const all = getWords();
  const isPhrase = subtype === 'phrase';
  const levelById = new Map(all.map((w) => [String(w.id), w.level]));

  main.replaceChildren(el(`
    <section class="card">
      <h2>${escapeHtml(label)}</h2>
      <p class="muted small">${isPhrase
        ? '看中文意思，拼出對應的英文片語（片語庫收錄自字庫搭配詞）。'
        : '看中文意思，拼出英文單字。'}</p>
      <div class="settings-list">
        <div class="settings-row">
          <div class="settings-row-title">
            <h3 class="tp-card-title">範圍</h3>
            <p class="tp-caption">${isPhrase ? '單詞本來源＝該單詞本中收有片語的字' : '單詞本來源＝該單詞本的字'}</p>
          </div>
          <div class="settings-row-main">
            <div class="segmented" role="radiogroup" aria-label="範圍">
              <label><input type="radio" name="sp-scope" value="bank" checked><span>字庫範圍</span></label>
              <label><input type="radio" name="sp-scope" value="wordbook"><span>單詞本</span></label>
              <label><input type="radio" name="sp-scope" value="ai"><span>AI 題庫字</span></label>
            </div>
          </div>
        </div>
        <div class="section-divider"></div>
        <div class="settings-row" id="sp-lv-row">
          <div class="settings-row-title">
            <h3 class="tp-card-title">字庫範圍</h3>
            <p class="tp-caption">${isPhrase ? '依片語主字的等級篩選' : '依單字等級篩選'}</p>
          </div>
          <div class="settings-row-main">
            <select id="sp-lv">
              <option value="all">全部字庫</option>
              ${[1, 2, 3, 4, 5, 6].map((lv) => `<option value="${lv}">Lv${lv}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="section-divider"></div>
        <div class="settings-row settings-row--stack hidden" id="sp-wb-row">
          <div class="settings-row-title"><h3 class="tp-card-title">單詞本</h3></div>
          <div class="settings-row-main" id="sp-wb-main"></div>
        </div>
        <div class="section-divider"></div>
        <div class="settings-row settings-row--stack hidden" id="sp-ai-row">
          <div class="settings-row-title"><h3 class="tp-card-title">AI 題庫字</h3></div>
          <div class="settings-row-main">
            <p class="settings-note muted small">正解詞範圍＝AI 題庫（詞彙＋綜合測驗）出題過的單字<span id="sp-ai-count"></span></p>
          </div>
        </div>
        <div class="section-divider"></div>
        <div class="settings-row">
          <div class="settings-row-title">
            <h3 class="tp-card-title">題數</h3>
            <p class="tp-caption">「全部」＝此範圍的可用題數</p>
          </div>
          <div class="settings-row-main">
            <div class="segmented" role="radiogroup" aria-label="題數">
              <label><input type="radio" name="sp-count" value="5" checked><span>5</span></label>
              <label><input type="radio" name="sp-count" value="10"><span>10</span></label>
              <label><input type="radio" name="sp-count" value="15"><span>15</span></label>
              <label><input type="radio" name="sp-count" value="all"><span>全部</span></label>
            </div>
          </div>
        </div>
      </div>
      <div class="controls"><button class="btn primary" id="sp-start">開始練習</button></div>
      <p class="warning" id="sp-warn"></p>
    </section>`));

  // 單詞本來源（只列單詞本；單選）
  const books = await wordbookSources();
  const wbHost = main.querySelector('#sp-wb-main');
  if (books.length) {
    wbHost.innerHTML = bankPickerHTML({ name: 'sp-wb', multiple: false, checked: [books[0].id], sources: books });
  } else {
    wbHost.innerHTML = '<p class="muted small">尚無已保存的單詞本（練習結束時可保存）。</p>';
  }

  // 範圍三選一：字庫範圍 ↔ 單詞本 ↔ AI 題庫字（顯示切換）
  const lvRow = main.querySelector('#sp-lv-row');
  const wbRow = main.querySelector('#sp-wb-row');
  const aiRow = main.querySelector('#sp-ai-row');
  const syncScope = () => {
    const scope = main.querySelector('input[name="sp-scope"]:checked')?.value;
    lvRow.classList.toggle('hidden', scope !== 'bank');
    wbRow.classList.toggle('hidden', scope !== 'wordbook');
    aiRow.classList.toggle('hidden', scope !== 'ai');
  };
  main.querySelectorAll('input[name="sp-scope"]').forEach((r) => r.addEventListener('change', syncScope));
  syncScope();
  // 效能鐵律：AI 題庫的題數非阻塞載入（進頁面不等大檔 fetch），到位後回填。
  // 計數取「與字庫的交集」——出題池本來就是 all.filter(w => set.has(w.word))
  loadAiBank().then((b) => {
    const set = new Set(aiTestedWords(b));
    const n = all.filter((w) => set.has(w.word)).length;
    const el = main.querySelector('#sp-ai-count');
    if (el) el.textContent = `（${n} 字）`;
  }).catch(() => {});

  main.querySelector('#sp-start').addEventListener('click', async () => {
    const warn = main.querySelector('#sp-warn');
    warn.textContent = '';
    const scope = main.querySelector('input[name="sp-scope"]:checked').value;
    const countRaw = main.querySelector('input[name="sp-count"]:checked').value;
    // 「全部」＝把此範圍的可用題目全拿；數字則為上限（不足時提示）
    // 【注意】want 為 Infinity 時不可做 length < want 比較——有限長度必定「小於 Infinity」，
    // 會把「全部」永遠擋成「資料不足」（QA 實證：全部=37 卻提示可練習的字不足）
    const want = countRaw === 'all' ? Infinity : Number(countRaw);
    const enough = (n) => want === Infinity || n >= want;
    let qs;
    try {
      if (scope === 'wordbook') {
        const sel = readBankSelection(main, 'sp-wb')[0];
        if (!sel) { warn.textContent = '請先選擇一個單詞本。'; return; }
        const pool = (await poolFromWordbookSources([sel])).pool;
        if (!pool.length) { warn.textContent = '這個單詞本沒有可用的字。'; return; }
        if (isPhrase) {
          // 片語拼寫＝該單詞本中 collocations 有片語的字（4.3.1 批次 3）
          const ids = new Set(pool.map((w) => String(w.id)));
          const allPhrases = await loadPhrases();
          const cands = allPhrases.filter((p) => ids.has(String(p.wordId)));
          if (!cands.length) { warn.textContent = '此單詞本無片語資料'; return; }
          qs = pickPhrases(cands, want);
          if (!qs.length) { warn.textContent = '此單詞本無片語資料'; return; }
        } else {
          const cands = pool.filter((w) => (w.senses || []).length > 0 && /^[A-Za-z][A-Za-z'-]*$/.test(w.word));
          if (!cands.length) { warn.textContent = '這個單詞本可練習的字不足。'; return; }
          if (!enough(cands.length)) { warn.textContent = '這個範圍可練習的字不足。'; return; }
          qs = shuffle(cands).slice(0, want === Infinity ? cands.length : want).map((w) => ({
            word: w.word, zh: (w.senses || [])[0] || w.word, senses: w.senses || [], level: w.level,
          }));
        }
      } else if (scope === 'ai') {
        // 5.0：AI 題庫字＝AI 題庫（詞彙＋綜合測驗）出過題的字，限縮自字庫。
        // 片語分支同單詞本：只取 pool 中有 collocations 的字（collocations.json 的 wordId 對應字庫 id）
        const set = new Set(aiTestedWords(await loadAiBank()));
        const pool = all.filter((w) => set.has(w.word));
        if (!pool.length) { warn.textContent = 'AI 題庫字沒有可用的字。'; return; }
        if (isPhrase) {
          const ids = new Set(pool.map((w) => String(w.id)));
          const allPhrases = await loadPhrases();
          const cands = allPhrases.filter((p) => ids.has(String(p.wordId)));
          if (!cands.length) { warn.textContent = '此範圍無片語資料'; return; }
          if (!enough(cands.length)) { warn.textContent = '這個範圍可練習的片語不足。'; return; }
          qs = pickPhrases(cands, want);
        } else {
          const cands = pool.filter((w) => (w.senses || []).length > 0 && /^[A-Za-z][A-Za-z'-]*$/.test(w.word));
          if (!cands.length) { warn.textContent = '這個範圍可練習的字不足。'; return; }
          if (!enough(cands.length)) { warn.textContent = '這個範圍可練習的字不足。'; return; }
          qs = shuffle(cands).slice(0, want === Infinity ? cands.length : want).map((w) => ({
            word: w.word, zh: (w.senses || [])[0] || w.word, senses: w.senses || [], level: w.level,
          }));
        }
      } else if (isPhrase) {
        const lv = main.querySelector('#sp-lv').value;
        // 4.1.1 修復（QA 實證）：片語拼寫改從 collocations.json 抽真片語（原實作過濾後只剩單字）
        const allPhrases = await loadPhrases();
        const cands = lv === 'all' ? allPhrases : allPhrases.filter((p) => String(levelById.get(String(p.wordId))) === String(lv));
        if (!cands.length) { warn.textContent = '這個範圍可練習的片語不足。'; return; }
        if (!enough(cands.length)) { warn.textContent = '這個範圍可練習的片語不足。'; return; }
        qs = pickPhrases(cands, want);
      } else {
        const lv = main.querySelector('#sp-lv').value;
        const pool = all.filter((w) => lv === 'all' || w.level === Number(lv));
        const candidates = pool.filter((w) => (w.senses || []).length > 0 && /^[A-Za-z][A-Za-z'-]*$/.test(w.word));
        if (!candidates.length) { warn.textContent = '這個範圍可練習的字不足。'; return; }
        if (!enough(candidates.length)) { warn.textContent = '這個範圍可練習的字不足。'; return; }
        qs = shuffle(candidates).slice(0, want === Infinity ? candidates.length : want).map((w) => ({
          word: w.word,
          zh: (w.senses || [])[0] || w.word,
          senses: w.senses || [],
          level: w.level,
        }));
      }
    } catch (err) {
      if (scope === 'ai') { warn.textContent = `AI 題庫載入失敗：${String(err.message || err)}`; return; }
      if (isPhrase) { warn.textContent = '片語庫載入失敗，請檢查網路後重試。'; return; }
      warn.textContent = '載入失敗，請稍後再試。';
      return;
    }
    runWordSpell(main, qs, { subtype, label, mode: 'blind' });
  });
}

// 片語取樣（去重後截到 want；want＝Infinity 時全取）
function pickPhrases(cands, want) {
  const seen = new Set();
  const qs = [];
  for (const q of shuffle(cands)) {
    const key = q.word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    qs.push({ word: q.word, zh: q.zh, senses: [], level: 0 });
    if (qs.length >= want) break;
  }
  return qs;
}

// ---------- 盲打的中文提示：不得夾帶正解（5.0.4 D 項）----------
// 【為什麼要過濾】字庫的 senses 原文有些是「英文註解型」中文，例如
//   shoes → 「鞋子（shoe 的複數）」、gloves → 「手套（glove的複數）」、
//   participation → 「participate的變形」。
//   盲打（練習）時字母格是空的，答案就靠這行中文——提示裡寫出正解（或其幾乎全部字母）
//   等於沒盲打。實測 7117 個可拼寫字中，這類提示有十幾個；片語庫另有以單字母佔位符
//   書寫的（「視A為B」，A 剛好是片語裡的一個字）。
//
// 【什麼算「洩漏」】不是只比完整正解，而是比**前綴關係**：
//   「shoe 的複數」洩漏 shoes、「participate的變形」洩漏 participation（差一個 -ion），
//   只比完整正解抓不到。規則：提示裡的任一拉丁 token，若與正解互為前綴且長度 ≥3
//   （去複數／去所有格後比較），就算洩漏。片語則以**每個字**分別檢查。
//
// 【修法】依序嘗試：① 拿掉括號內含拉丁字母的註解 → ② 拿掉「英文＋的」前綴
//   → ③ 換該字的其他 sense → ④ 拉丁佔位符換成中文「某物」→ ⑤ 中性文案。
//   寧可提示簡單，也不把答案寫在提示裡。學習（顯示字母）模式不過濾：字母本來就擺在格上。
function zhForPrompt(q, isStudy) {
  if (isStudy) return q.zh; // 顯示字母模式：字母本來就在畫面上，提示過濾沒有意義
  const answer = String(q.word || '');
  if (!answer) return q.zh;

  // 正解的每個字（片語逐字比）；單字就是它自己
  const answerParts = answer.split(/\s+/).filter(Boolean)
    .map((w) => w.toLowerCase().replace(/'s$/, '').replace(/s$/, ''))
    .filter((w) => w.length >= 3);

  const leaks = (s) => {
    const t = String(s || '');
    if (!t) return false;
    const tokens = (t.toLowerCase().match(/[a-z][a-z'-]*/g) || [])
      .map((x) => x.replace(/'s$/, '').replace(/s$/, ''))
      .filter((x) => x.length >= 3);
    if (!answerParts.length) return false;
    return tokens.some((tok) => answerParts.some((a) => a.startsWith(tok) || tok.startsWith(a)));
  };
  if (!leaks(q.zh)) return q.zh;

  // ① 拿掉含拉丁字母的括號註解（鞋子（shoe 的複數） → 鞋子）
  const noParen = String(q.zh).replace(/[（(][^）)]*[A-Za-z][^）)]*[）)]/g, '').trim();
  if (noParen && !leaks(noParen)) return noParen;

  // ② 拿掉「英文＋的」前綴（participate的變形 → 變形；只在「的」後接非字母時才動）
  const noLatinPrefix = String(noParen || q.zh).replace(/[A-Za-z][A-Za-z'-]*的(?=[^A-Za-z])/g, '').trim();
  if (noLatinPrefix && !leaks(noLatinPrefix)) return noLatinPrefix;

  // ③ 換該字的其他 sense（該字通常有不含英文註解的那一條）
  for (const s of (q.senses || [])) {
    if (s && !leaks(s)) return s;
  }

  // ④ 拉丁佔位符換成中文「某物」（視A為B → 視某物為某物；佔位語意不損失）
  const noPlaceholder = String(q.zh).replace(/(?<![A-Za-z])[A-Z](?![A-Za-z])/g, '某物').trim();
  if (noPlaceholder && !leaks(noPlaceholder)) return noPlaceholder;

  // ⑤ 仍不行：中性文案（寧可提示簡單，也不把答案寫在提示裡）
  return '請依中文意思拼出英文單字';
}

// 片語題目：collocations.json（首次用到才抓 1.6MB，模組級快取；效能鐵律）
// 4.3.1 批次 3：每筆帶 wordId（collocations 的 key ＝字庫 id），供單詞本範圍過濾
let phraseCache = null;
async function loadPhrases() {
  if (phraseCache) return phraseCache;
  const p = (async () => {
    const res = await fetch('data/collocations.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`片語庫載入失敗（${res.status}）`);
    const data = await res.json();
    const out = [];
    const cols = data.collocations || {};
    for (const [wordId, arr] of Object.entries(cols)) {
      for (const c of arr || []) {
        if (c && c.p && c.zh && c.p.includes(' ') && /^[A-Za-z][A-Za-z' -]*$/.test(c.p)) out.push({ word: c.p, zh: c.zh, wordId: String(wordId) });
      }
    }
    if (!out.length) throw new Error('片語庫格式異常');
    return out;
  })();
  phraseCache = p;
  try {
    return await p;
  } catch (err) {
    phraseCache = null; // 失敗不鎖死，可重試
    throw err;
  }
}

// ---------- 單字／片語會話 ----------
// 4.3.1 批次 3（共用基建第 4 項）：提前結束——確認後回設定畫面
// 5.0.x：逐字母鎖定（spec 第 1 節）＋完成畫面錯題重練（spec 第 2 節）
//
// 5.0.4 D 項：兩種作答模式並存（同一次作答的兩種「看字程度」）
//   mode:'blind'（**練習**拼寫，預設）＝盲打測驗：作答中畫面不得出現英文單字或字母，
//     只留「中文釋義一行＋輸入格一行」；格子的數量等於字長（＝格形狀提示，非答案）。
//   mode:'show'（**學習**拼寫）＝顯示字母：字母以灰色顯示在格上，逐字打對轉綠（看字打字）。
//   其餘行為（逐字母鎖定、計分、統計、錯題重練、退格規則）兩模式完全相同，只有
//   「格子上有沒有字」與「提示文案」不同。學與練因此能共用一支引擎，不會互相干擾。
//
// 逐字母鎖定的行為細節（與整字判定的差別）：
//   ・每敲一個字元即與正解同一位置的字元比對：對→字母格鎖定為正確（綠）、游標前進；
//     錯→該格變紅且**鎖住不放行**（游標留在該格，後續輸入被忽略，直到打對或按退格解除為止）。
//   ・空格＝跳過一個字母（片語的詞間空格；不解錯、也不鎖）。
//   ・Backspace＝解除當前（或上一個）鎖定的錯格並退回該格；**已打對的字母不可被退掉**
//     （否則退格就成了反推正解的作弊路徑）。要重打就按下一題再回來。
//   ・正解字母全部鎖定＝該字完成（自動計分與記事件、給回饋）；不保留「確認」按鈕。
//   ・【5.0.4】該字完成後按 Enter＝直接進下一題（最後一題＝進完成畫面），
//     逐字母模式下 Enter 從此不再只是「確認這裡」——否則使用者打完一個字還要去按下一題。
//   【「錯題」的定義】逐字母鎖定下不存在「整字打錯」——打錯的字母必須改正才能走完，
//     所以「走完＝全對」在數學上永遠成立，錯題就永遠是 0，spec 第 2 節的「錯題重練」
//     會永遠沒有東西可練。故本題算不算錯，看「這題有沒有打錯過字母」：
//     零錯字＝答對；曾打錯過至少一個字母＝錯題（改正後也算，照樣練一次）。
//     【這不是「錯誤字母統計」】wrongSlots 只活在這次 run 的記憶體與題目物件裡：
//       不寫進 events、不進統計頁、不上雲端（spec 第 1 節明示不做錯誤字母統計）。
//     錯過的字母位置記在 q.wrongSlots：① 供翻頁回來時把那些格子上色；
//       ② 兼作「這題錯過哪些字母」的依據。退格改正只解除**鎖定與紅色**，不改紀錄。
//   ・離場路徑不變：shell 的「上一題／下一題」與「提前結束」照舊可用。
//   ・【真實鍵盤路徑】字元由 keydown 與 input 兩條路進來（池 B 對向驗證）：
//     ① keydown：自己消化 e.key 並 preventDefault（否則瀏覽器仍會把字元灌進 input，
//        同一個字被算兩次）；② input：處理貼上／手機 autocorrect／無 keydown 的合成輸入。
//     兩條路都呼叫同一個 typeChar()，故行為一致。
function runWordSpell(main, qs, opts = {}) {
  const subtype = opts.subtype || 'word';
  const label = opts.label || '拼寫・單字';
  const mode = opts.mode === 'show' ? 'show' : 'blind'; // 預設盲打（練習）
  const isStudy = mode === 'show';
  let idx = 0;
  let correct = 0;
  // 5.1.1 B4：連對計數（d2-combo 徽記）。與 idx／correct 同層放閉包：一次 run 一份，
  // 殼層每次換題重掛徽記節點，狀態留在這裡才不會跟著歸零。
  const combo = makeCombo();

  /**
   * 重跑指定的題目集合（錯題重練 / 再練一次共用）。
   * list 為臨時題集（記憶體內，不持久化——持久化是錯題本的事）。
   * 每個臨時題目都清掉 answered 標記，讓重跑可以重新作答。
   */
  const startRun = (list) => {
    const fresh = list.map((q) => ({ ...q, answered: undefined }));
    idx = 0;
    correct = 0;
    combo.reset(); // 重跑＝新場景，連對從零起算
    renderQ(fresh);
  };

  const quitSpell = async () => {
    const ok = await openDialog({
      title: '提前結束',
      body: '已作答的題目不會計入成績（未答題不影響）',
      okText: '結束',
    });
    if (!ok) return; // 取消：場次還在，handler 留著（下一鍵才接得上）
    // 5.1.2：場次結束，清掉情境返回——回設定頁／學習頁後返回鈕該走 routeStack 了
    clearBackHandler();
    // 學習場回學習頁（引擎不換路由，全程 hash 已是 #/study）
    if (isStudy) { await goStudy(); return; }
    renderSpelling(main, subtype); // 練習場回設定畫面
  };

  /**
   * 回到學習頁（#/study）。
   * 【為什麼不能只 location.hash = '#/study'】學習場是由 pages/study.js 直接呼叫引擎開跑的，
   *   路由**從來沒有離開** #/study；把 hash 設成同值不會觸發 hashchange，router 不重畫，
   *   使用者會停在最後一題的作答畫面（或完成畫面）動不了。
   *   故同值時直接叫 router.render() 重畫學習頁。
   */
  const goStudy = async () => {
    if (location.hash === '#/study') {
      const router = await import('../core/router.js');
      await router.render();
      return;
    }
    location.hash = '#/study';
  };

  /**
   * 完成畫面：錯題（answered === false）> 0 才掛「錯題重練」，
   * 臨時題集只活在這次 run 裡（不寫進任何持久化——那是錯題本的事）。
   */
  const showCompletion = (list) => {
    const total = list.length;
    const wrong = list.filter((q) => q.answered === false);
    mountCompletion(main, {
      title: `${label}完成`,
      scoreText: `${correct} / ${total}`,
      stats: [
        { num: total, label: '總題數' },
        { num: correct, label: '答對題數' },
      ],
      // 5.0.x：錯題 > 0 才出現（spec 第 2 節；0 題時按鈕不存在，畫面與既有行為一致）
      wrongCount: wrong.length,
      onRetryWrong: wrong.length ? () => startRun(wrong) : undefined,
      onAgain: () => { if (isStudy) { goStudy(); return; } renderSpelling(main, subtype); },
      correct, total, // 5.1.1 B4：正確率滿 80% 殼層會放彩帶
    });
  };

  const renderQ = (list = qs) => {
    const q = list[idx];
    if (!q) return; // 防呆：越界翻頁（btn 已 disabled 時仍被程式觸發）不得讓整頁炸掉
    const shell = mountShell(main, {
      typeLabel: label, cur: idx + 1, total: list.length,
      canPrev: idx > 0, canNext: idx < list.length - 1,
      onPrev: () => { if (idx > 0) { idx--; renderQ(list); } },
      onNext: () => { if (idx < list.length - 1) { idx++; renderQ(list); } },
      onQuit: quitSpell,
      combo, // 5.1.1 B4：殼層進度區掛連對徽記
    });

    // 字母格：正解長度＋1（多一格＝游標所在的當前格）
    const target = q.word;
    const chars = [...target];
    // 字母格用 DOM 節點逐一組（不塞進 HTML 字串：`el()` 只認字串，元素會被字串化）
    // 【5.0.4 D 項】盲打（練習）時格子**不放字母**——只留格形與下劃線；顯示字母（學習）
    //   才把字母以灰色寫進格子（打對後由 .spell-slot--ok 轉綠）。
    const slotRow = document.createElement('span');
    slotRow.className = 'spell-slots';
    slotRow.id = 'sp-slots';
    slotRow.classList.toggle('spell-slots--show', isStudy);
    for (const ch of chars) {
      const s = document.createElement('span');
      s.className = 'spell-slot';
      if (isStudy) {
        if (ch === ' ') s.innerHTML = '&nbsp;';   // 片語的詞間空格
        else s.textContent = ch;                  // 文字走 textContent（外部資料，紅線）
      }
      slotRow.appendChild(s);
    }
    // 尾端游標格帶穩定的 --tail 類別：它是「游標所在的空格」，不是正解的一個字母，
    // 測試與其他消費端要能把它與字母格區分開（游標會移動，只靠 --cur 分不出來）。
    // 5.1.2 修復：尾端游標格（--tail）移除——它只在「字還沒打完」時可見，
    // 恰好就是使用者看到的「單字後面多一格空格」；當前位置指示已由字母格的 --at 樣式負責。
    const slots = [...slotRow.querySelectorAll('.spell-slot')];
    // 【5.0.4 D 項】盲打時正解不在畫面，煙霧測試需要一個不影響視覺的資料來源才能
    //   「照著打」——掛在字母列上的 data 屬性（無 CSS、無 aria、不可見也不朗讀）。
    //   這是測試可及性用的錨點，不是給使用者看的資訊（回饋行才顯示單字）。
    slotRow.dataset.spellAnswer = target;

    // 【5.0.4 D 項】兩行分離：中文釋義一行、英文輸入格一行。
    //   舊版把中文與格子放在同一列（flex 同行），一行長一短、視線要在中間跳。
    shell.content.appendChild(el(`
      <div class="spell-board ${isStudy ? 'spell-board--show' : 'spell-board--blind'}">
        <p class="spell-zh-line zh-prompt">${escapeHtml(zhForPrompt(q, isStudy))}</p>
        <p class="spell-slots-line"><span class="spell-slots-slot" id="sp-slots-host"></span></p>
        <input class="spell-input" id="sp-input" autocomplete="off" autocapitalize="off" spellcheck="false"
               inputmode="text" style="position:absolute;opacity:0;width:1px;height:1px;padding:0;border:0"
               aria-label="拼寫輸入">
        <p class="tp-caption" id="sp-hint">${isStudy
          ? '字母已淡灰顯示在格上：照著打，打對的字母會轉綠；打完按 Enter 換下一題。'
          : '看中文意思拼出英文：照著格子一個一個打，打錯的字母會變紅並停住，打對才能繼續。'}</p>
      </div>`));
    shell.content.querySelector('#sp-slots-host').replaceWith(slotRow);
    const input = shell.content.querySelector('#sp-input');
    input.focus();

    // 光標位置：pos ＝ 已鎖定的字母數（chars 下標；遇空格自動跳格）
    let pos = 0;
    const paint = () => {
      slots.forEach((n, i) => n.classList.toggle('spell-slot--at', i === pos));
    };
    const hint = shell.content.querySelector('#sp-hint');

    // 本題**曾經**打錯過的字母位置（append-only：改正後仍保留，故錯題判定不被退格洗掉）
    const wrongSlots = [];
    const good = () => wrongSlots.length === 0;

    /**
     * 這個字走完：計分、記事件、回饋、補完成出口。
     * 【守門】settled 一旦為 true 就直接 return（idempotent）：
     *   沒有這道守門時，「全部打對之後再按 Enter」或「完成後繼續打字」會重複計分、
     *   重複寫 quiz 事件 → 完成畫面出現 7/5 這種分數灌水（池 B 對向驗證第 2 項）。
     * 完成後 input 直接 disabled：使用者看到的是「這題已完成」，不是「還能繼續打」。
     */
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      const ok = good(); // 零錯字＝答對；打錯過字母＝錯題（定義見函式上方說明）
      if (ok) correct++;
      q.answered = ok;
      q.wrongSlots = [...wrongSlots];
      addEvent('quiz', null, { q: subtype, ok }); // 4.1.1：題型作答計入統計（首次作答才執行）
      // 5.1.1 B4：連對計數（逐字母鎖定下「零錯字＝答對」；只在新完成時記，還原分支不重複）
      combo.record(ok);
      combo.render(shell.comboEl);
      // 盲打模式下回饋才顯示單字（作答中不得預顯示答案；D 項）
      shell.setFeedback(ok ? `正確：${target}` : `拼好了，但有字母打錯過（已改正）：${target}`, ok ? 'ok' : 'bad');
      // 5.1.2 修復：輸入框「不停用」——Enter 換下一題的監聽就掛在它身上，停用會立刻失焦，
      // 桌面端按 Enter 永遠沒反應（jsdom 合成事件測不出失焦，故 5.0.4 煙霧沒攔到）。
      // 已完成的守門靠 settled 旗標（typeChar／Backspace／Enter 分支都先查 settled），不停用也安全。
      if (idx === list.length - 1) {
        const done = document.createElement('button');
        done.className = 'btn primary';
        done.textContent = '查看成績';
        done.addEventListener('click', () => showCompletion(list));
        shell.content.querySelector('#sp-hint').after(done);
      } else if (hint) {
        // 5.0.4 D：提示改成「下一步是什麼」，讓 Enter＝下一題不靠猜
        hint.textContent = '這個字完成了：按 Enter 換下一題（Backspace 已鎖定，不能再改）。';
      }
    };

    // 4.1.1 修復（QA）：回已答題直接還原已答狀態，不再重複計分
    if (q.answered !== undefined) {
      // 曾錯過的字母格上紅色（改正過也是紅的：那是這題的錯處），其餘綠
      const bad = new Set((q.wrongSlots || []).map(Number));
      slots.forEach((n, i) => n.classList.add(bad.has(i) ? 'spell-slot--bad' : 'spell-slot--ok'));
      // 5.1.2：輸入框不停用（理由見 finish() 內註解）——還原分支的輸入同樣被 settled 外的
      // q.answered 重建流程鎖住，且 Enter 換題必須有活的監聽器
      shell.setFeedback(q.answered ? `正確：${target}` : `已完成（有字母打錯過）：${target}`, q.answered ? 'ok' : 'bad');
      // Pool A 複核：還原分支也要有完成出口，否則回最後一題再次死路
      if (idx === list.length - 1 && list.every((x) => x.answered !== undefined)) {
        const done = document.createElement('button');
        done.className = 'btn primary';
        done.textContent = '查看成績';
        done.addEventListener('click', () => showCompletion(list));
        shell.content.querySelector('#sp-hint').after(done);
      }
      return;
    }

    paint();

    // 5.0.x：輸入框為了「逐字母鎖定」做成不可見（字母顯示在格子上），
    //   點字母格任一處都把焦點交還輸入框，觸控／手機不會因此打不了字。
    slotRow.addEventListener('click', () => { if (!input.disabled) input.focus(); }); // input 已不再停用，此守衛僅留防禦

    /**
     * 逐字母判定核心：吃一個字元，對當前格。
     * 回傳 'continue' ＝ 可以繼續吃下一個字；'stop' ＝ 該格被鎖住／已走完，後續字元丟掉。
     * keydown（真實鍵盤）與 input（貼上／autocorrect）都走這裡，兩條路行為一致。
     */
    const typeChar = (ch) => {
      if (settled) return 'stop';
      if (pos >= chars.length) return 'stop';
      // 空格＝跳格（片語的詞間空格）：跳過正確位置的空格，不判對錯
      if (chars[pos] === ' ') { pos++; return 'continue'; }
      if (ch === ' ') return 'continue'; // 目標不是空格時，打空格＝忽略（不鎖、不前進）
      const slot = slots[pos];
      // 這一格已經鎖住（先前打錯過）→ 本次輸入不放行
      if (slot.classList.contains('spell-slot--lock')) return 'stop';
      if (String(ch).toLowerCase() === String(chars[pos]).toLowerCase()) {
        slot.classList.add('spell-slot--ok');
        pos++;
        if (hint) hint.textContent = '';
        return 'continue';
      }
      // 打錯：該字母格變紅並鎖住不放行，游標停在這裡（後續輸入被忽略）
      slot.classList.add('spell-slot--bad');
      slot.classList.add('spell-slot--lock');
      if (!wrongSlots.includes(pos)) wrongSlots.push(pos);
      // 5.1.1 B4：錯題在這一刻已確定（wrongSlots 不可洗掉，見上方說明），連對當場斷裂
      // 隱藏，不用等整字完成；finish 的 record(false) 會再記一次（歸零是冪等的）
      combo.record(false);
      combo.render(shell.comboEl);
      if (hint) hint.textContent = '這個字母不對：打對才能繼續（Backspace 可解除這一格的鎖定）。';
      return 'stop';
    };

    /** 收尾：跳過尾端空格 → 到位就完成 */
    const settleProgress = () => {
      while (pos < chars.length && chars[pos] === ' ') pos++;
      if (pos >= chars.length) {
        paint();
        finish();
        return;
      }
      paint();
    };

    input.addEventListener('input', () => {
      // 貼上／手機 autocorrect／無 keydown 的合成輸入：一次可能來多個字元，逐字元依序處理
      const typed = input.value;
      input.value = ''; // 輸入框只當鍵盤來源，字元一律走 typeChar
      for (const ch of typed) {
        if (typeChar(ch) === 'stop') break;
      }
      settleProgress();
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace') {
        e.preventDefault();
        // 本題已完成：字母格全部鎖定，不許再退（否則畫面會同時出現「已打對」的綠色
        // 與仍可繼續輸入的游標，自相矛盾；池 B 對向驗證第 14 項）
        if (settled) return;
        // 退格規則：① 當前格鎖住（打錯過）→ 解除鎖定並退回未鎖定；② 當前格沒鎖但前一格鎖住
        //   → 同樣解除那一格的鎖；③ 都沒鎖 → 純粹往前退一格。
        // 為什麼不讓「已打對的字母」被退格拿掉：那會讓使用者用退格反推正解（字母題的作弊路徑），
        //   所以已打對的格子不可退；要重打這一題就按下一題再回來。
        const cur = pos < chars.length ? slots[pos] : null;
        if (cur?.classList.contains('spell-slot--lock')) {
          // 只解除鎖定與紅色；wrongSlots 是「曾經錯過」的紀錄，不因改正而消失
          cur.classList.remove('spell-slot--bad', 'spell-slot--lock');
          if (hint) hint.textContent = '';
          paint();
          return;
        }
        if (pos > 0) {
          const prev = slots[pos - 1];
          if (prev.classList.contains('spell-slot--lock')) {
            pos--;
            prev.classList.remove('spell-slot--bad', 'spell-slot--lock');
            if (hint) hint.textContent = '';
            paint();
            return;
          }
          if (pos < chars.length) { pos--; paint(); }
        }
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        // 5.0.4 D 項：逐字母模式下「送出答案」＝打完全部字母，Enter 從此是**換下一題**：
        //   該字完成（settled）→ 直接進下一題；最後一題 → 完成畫面；未完成 → 不動作
        //   （避免使用者以為 Enter 會判對錯）。可重複按（idempotent：走同一條換頁路徑）。
        if (!settled) {
          if (pos >= chars.length) finish();
          return;
        }
        if (idx < list.length - 1) { idx++; renderQ(list); return; }
        showCompletion(list);
        return;
      }
      if (e.key.length !== 1) return; // Enter／Tab／方向鍵等不是字元，交給瀏覽器
      // 真實鍵盤路徑：自己吃掉這個字元並 preventDefault。
      // 為什麼要 preventDefault：字元若同時灌進 input 事件，同一個字母會被算兩次
      // （第一次在這裡鎖綠前進、第二次在 input 裡落在下一格）。池 B 對向驗證第 1 項。
      e.preventDefault();
      if (settled) return;
      typeChar(e.key);
      settleProgress();
    });
  };

  renderQ(qs);
}

/**
 * 5.0.4 A 項：學習頁（#/study）的「拼寫學習」入口＝顯示字母模式。
 * 由 pages/study.js 動態呼叫：把字池轉成本引擎的題目形狀後直接開跑。
 * 【為什麼不開一個新路由】學習場與練習場的作答判定、計分、統計、錯題重練完全相同，
 *   只有 opts.mode 不同；走同一支引擎才能保證兩邊行為一致（不會各自漂移）。
 * 【作答體驗差異】字母灰色顯示在格上 → 打對轉綠 → 打完按 Enter 換下一題（看字打字，記形用）。
 */
export function startWordSpellStudy(pool, opts = {}) {
  const main = opts.main || document.getElementById('app');
  if (!main) return;
  // 只取可作答的單純英文字（與練習拼寫的候選規則一致：要有釋義、純字母／連字號／撇號）
  const cands = (pool || []).filter((w) => (w.senses || []).length > 0 && /^[A-Za-z][A-Za-z'-]*$/.test(w.word));
  if (!cands.length) {
    toast('這個範圍沒有可拼寫的單字（需有中文釋義且為英文字母）。', 'bad');
    return;
  }
  const qs = shuffle(cands).slice(0, opts.count || 10).map((w) => ({
    word: w.word, zh: (w.senses || [])[0] || w.word, senses: w.senses || [], level: w.level,
  }));
  runWordSpell(main, qs, { subtype: 'spell-study', label: '拼寫學習', mode: 'show' });
}

// ---------- 中譯英：來源選擇（題庫挖空／題庫整句／AI 挖空／AI 整句／AI 單詞本翻譯） ----------
// 4.3.1 批次 4：①題數 segmented（3/5/10）套用所有來源；②入口重排——三張 AI 卡同一排
//（.pt-grid.pt-3row），「單詞本・AI 出題」改名「AI・單詞本翻譯」
const ZH2EN_COUNTS = ['3', '5', '10'];
// 語句級 joinPool：跨句子共用（同一場練習收集的單字在完成畫面一次整合）
let zh2enJoin = null;
let zh2enWordById = new Map();

async function renderZh2EnSource(main, label) {
  let bankCount = 0;
  try {
    const res = await fetch('data/questions/translation.json', { cache: 'no-cache' });
    bankCount = res.ok ? ((await res.json()).sentences || []).length : 0;
  } catch { /* 題庫不存在 */ }

  main.replaceChildren(el(`
    <section class="card">
      <h2>${escapeHtml(label)}</h2>
      <p class="muted small">把中文句子翻譯成英文：直接在句中空格輸入答案（不分大小寫、標點不需輸入）。</p>
      <div class="settings-list">
        <div class="settings-row">
          <div class="settings-row-title">
            <h3 class="tp-card-title">題數</h3>
            <p class="tp-caption">所有來源共用；題庫不足時以實際可抽數為準</p>
          </div>
          <div class="settings-row-main">
            <div class="segmented" role="radiogroup" aria-label="題數" id="z2e-count-seg">
              ${ZH2EN_COUNTS.map((v, i) => `<label><input type="radio" name="z2e-count" value="${v}"${i === 0 ? ' checked' : ''}><span>${v}</span></label>`).join('')}
            </div>
          </div>
        </div>
      </div>
      <div class="pt-section">
        <div class="tp-section-title">題庫來源</div>
        <div class="pt-grid pt-2x2">
          <button class="pt-card" data-src="bank-blank">
            <span class="pt-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 7h16M4 12h10M4 17h7"/></svg></span>
            <span><span class="pt-title">題庫・挖空翻譯</span><br><span class="pt-desc">題庫句挖空 ${bankCount ? `（現有 ${bankCount} 句）` : '（題庫準備中）'}</span></span>
          </button>
          <button class="pt-card" data-src="bank-full">
            <span class="pt-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 6h16M4 12h16M4 18h16"/></svg></span>
            <span><span class="pt-title">題庫・整句翻譯</span><br><span class="pt-desc">每個字都是空格 ${bankCount ? `（現有 ${bankCount} 句）` : ''}</span></span>
          </button>
        </div>
      </div>
      <div class="pt-section">
        <div class="tp-section-title">歷屆真題</div>
        <div class="pt-grid pt-2x2">
          <button class="pt-card" data-src="archive-blank">
            <span class="pt-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 7h16M4 12h10M4 17h7"/></svg></span>
            <span><span class="pt-title">考古題・挖空翻譯</span><br><span class="pt-desc">大考中心歷屆中翻英題<span id="sp2-arc-count"></span></span></span>
          </button>
          <button class="pt-card" data-src="archive-full">
            <span class="pt-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 6h16M4 12h16M4 18h16"/></svg></span>
            <span><span class="pt-title">考古題・整句翻譯</span><br><span class="pt-desc">官方答案整句，每個字都是空格</span></span>
          </button>
        </div>
      </div>
      <div class="pt-section">
        <div class="tp-section-title">AI 出題</div>
        <div class="pt-grid pt-3row">
          <button class="pt-card" data-src="ai-blank">
            <span class="pt-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M12 3l1.7 4.3L18 9l-4.3 1.7L12 15l-1.7-4.3L6 9l4.3-1.7z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z"/></svg></span>
            <span><span class="pt-title">AI・挖空翻譯</span><br><span class="pt-desc">AI 產生句子與空格（需 AI 金鑰）</span></span>
          </button>
          <button class="pt-card" data-src="ai-full">
            <span class="pt-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4z"/></svg></span>
            <span><span class="pt-title">AI・整句翻譯</span><br><span class="pt-desc">大型輸入框＋AI 逐句批改（紅色定位錯誤）</span></span>
          </button>
          <button class="pt-card" data-src="wb-ai">
            <span class="pt-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14"/><path d="M8 7h8M8 11h8M8 15h5"/></svg></span>
            <span><span class="pt-title">AI・單詞本翻譯</span><br><span class="pt-desc">勾選單詞本，AI 依其中的單字出翻譯題</span></span>
          </button>
        </div>
      </div>
      <p class="warning" id="sp2-warn"></p>
    </section>`));

  const warn = () => main.querySelector('#sp2-warn');
  const wantCount = () => Number(main.querySelector('input[name="z2e-count"]:checked')?.value || 3);

  main.querySelectorAll('.pt-card').forEach((c) => c.addEventListener('click', async () => {
    const src = c.dataset.src;
    if ((src === 'bank-blank' || src === 'bank-full') && !bankCount) {
      warn().textContent = '題庫檔 data/questions/translation.json 尚未就緒。';
      return;
    }
    if (src.startsWith('archive-')) {
      // 5.2：考古題還在載入／載入失敗 → 提示後擋（題庫沒到位時點進去只會看到空白句）
      try {
        await loadArchiveBank();
      } catch (err) {
        warn().textContent = `考古題載入失敗：${String(err.message || err)}`;
        return;
      }
    }
    if (src.startsWith('ai-') && !hasKey(getProviderId())) {
      warn().textContent = '尚未設定 AI 金鑰：請到「設置」的「AI 金鑰」貼上。';
      return;
    }
    if (src === 'ai-full') {
      // AI 整句＝既有 AI 翻譯流（大型輸入框＋AI 批改錯誤定位）：導向翻譯頁
      location.hash = '#/translate';
      return;
    }
    if (src === 'wb-ai') {
      // 「AI・單詞本翻譯」＝4.1.0「單詞本 AI 出題」入口（由 js/pages/practice.js 實作）
      const count = wantCount();
      const { renderZh2EnSelect } = await import('../pages/practice.js');
      renderZh2EnSelect(main);
      // 該頁的題數選項（5/10/15）由另一工程師維護的 practice.js 提供：
      // 把這裡選的題數對應過去（沒有完全相同值就取最接近的）
      applyZh2EnCount(main, count);
      return;
    }
    runBankOrAi(main, src, wantCount());
  }));

  // 5.2：考古題（中翻英 211 題）非阻塞回填計數——進 zh2en 設定畫面不等 3.2MB 的 archive_v1.json
  loadArchiveBank().then((b) => {
    const n = archiveTranslateItems(b).length;
    const el = main.querySelector('#sp2-arc-count');
    if (el) el.textContent = `（現有 ${n} 句）`;
    return n;
  }).then((n) => {
    if (n) return;
    // 題庫為空（載入失敗或檔案異常）→ 兩張考古題卡停用淡出，避免點進去才發現沒題
    for (const card of main.querySelectorAll('.pt-card[data-src^="archive-"]')) {
      card.disabled = true;
      card.classList.add('bank-item--empty');
    }
  }).catch(() => {
    for (const card of main.querySelectorAll('.pt-card[data-src^="archive-"]')) {
      card.disabled = true;
      card.classList.add('bank-item--empty');
    }
  });
}

/** 把選好的題數套到 practice.js 的中譯英出題頁（值不同則取最接近的一檔） */
function applyZh2EnCount(main, count) {
  const radios = [...main.querySelectorAll('input[name="z2e-count"]')];
  if (!radios.length) return;
  const best = radios
    .map((r) => ({ r, d: Math.abs(Number(r.value) - count) }))
    .sort((a, b) => a.d - b.d)[0].r;
  best.checked = true;
}

// ---------- 題庫／AI 挖空 會話（多句：題數 segmented） ----------
async function runBankOrAi(main, src, want = 3) {
  // 「整句」＝每個 word 都是空格；題庫與考古題兩組來源各有一張整句卡（5.2 加考古題時漏過一次）
  const allBlank = src === 'bank-full' || src === 'archive-full';
  let specs;
  if (src === 'archive-blank' || src === 'archive-full') {
    // 5.2 考古題中翻英：官方答案原句（en）＋中文題目（zh），走同一條 mountSentence 流程。
    //   archive-blank：每句挖 2～3 個 content words（官方句子較短，挖太多沒有練習價值）
    //   archive-full：每個 word 都是空格（＝逐字翻譯，難度最高）
    const bank = await loadArchiveBank();
    const items = archiveTranslateItems(bank);
    if (!items.length) {
      main.replaceChildren(el('<section class="card"><p class="warning">考古題中翻英題庫載入失敗，請重新整理頁面再試。</p></section>'));
      return;
    }
    specs = shuffle(items).slice(0, want).map((it) => {
      const label = `考古題 ${it.year ?? ''}${it.exam ? `（${it.exam}）` : ''}`.trim();
      if (src === 'archive-blank') {
        const toks = tokenize(it.en);
        const wordIdx = [];
        toks.forEach((t, i) => { if (t.t === 'word' && /[A-Za-z]{3,}/.test(t.w)) wordIdx.push(i); });
        // 短句取 1 格、稍長取 3 格；content words 抓 content letters（去掉 of/the 這類功能字）
        const wantN = Math.min(3, Math.max(1, Math.round(wordIdx.length / 5)));
        const picked = shuffle(wordIdx).slice(0, wantN);
        const blanks = picked.map((i) => ({
          pos: i,
          answer: stripPunctWord(toks[i].w),
          alts: [],
        })).filter((b) => b.answer);
        return { sentence: it.en, zh: `${it.zh}　（${label}）`, blanks: blanks.length ? blanks : [{ pos: wordIdx[0], answer: stripPunctWord(toks[wordIdx[0]].w), alts: [] }] };
      }
      const toks = it.en.split(/\s+/);
      return {
        sentence: it.en, zh: `${it.zh}　（${label}）`,
        blanks: toks.map((w, i) => ({ pos: i, answer: w.replace(/[.,!?;:'"]/g, ''), alts: [] })).filter((b) => b.answer),
      };
    });
  } else if (src === 'bank-blank' || src === 'bank-full') {
    const bank = JSON.parse((await (await fetch('data/questions/translation.json', { cache: 'no-cache' })).text()));
    const picked = shuffle(bank.sentences).slice(0, want);
    specs = picked.map((s) => {
      if (src === 'bank-blank') {
        // 隨機挖空：≥1 個、上限全部標記位置
        const picks = shuffle(s.blanks).slice(0, Math.max(1, s.blanks.length));
        return { sentence: s.en, zh: s.zh, blanks: picks.map((b) => ({ pos: b.pos, answer: b.answer, alts: b.alts || [] })) };
      }
      // 整句：每個 word 都是空格
      const toks = s.en.split(/\s+/);
      return {
        sentence: s.en, zh: s.zh,
        blanks: toks.map((w, i) => ({ pos: i, answer: w.replace(/[.,!?;:'"]/g, ''), alts: [] })).filter((b) => b.answer),
      };
    });
  } else {
    // AI 挖空：請 AI 產生 want 句原句＋挖空位置＋答案（架構擴充點：可換題庫來源）
    main.replaceChildren(el(`<section class="card"><p class="muted">AI 正在產生 ${want} 題…請稍候（約 5–20 秒）</p></section>`));
    const topic = shuffle(['technology', 'school life', 'environment', 'travel', 'health', 'sports', 'food culture'])[0];
    const prompt =
      `請以台灣學測英文程度，围绕主題「${topic}」寫 ${want} 句 12～18 個單字的英文句子，並各自標記 2～3 個重要 content words 作為挖空答案。` +
      `只回 JSON：{"items":[{"sentence":"原句","zh":"繁體中文翻譯","blanks":[{"pos":<0-based word index>,"answer":"word","alts":["可替代答案"]}]}]}`;
    let out;
    try {
      out = await generateJSON(prompt, { temperature: 0.8 });
    } catch (err) {
      main.replaceChildren(el(`<section class="card"><p class="warning">AI 產生題目失敗：${escapeHtml(String(err.message || err).slice(0, 140))}</p></section>`));
      return;
    }
    const items = Array.isArray(out?.items) ? out.items : [];
    specs = items.map((it) => {
      const sentence = String(it?.sentence || '');
      const toks = sentence.split(/\s+/);
      const blanks = alignBlanks(sentence, (it?.blanks || [])
        .filter((b) => Number.isInteger(b?.pos) && b.pos >= 0 && b.pos < toks.length)
        .map((b) => ({ pos: Number(b.pos), answer: String(b.answer || '').replace(/[.,!?;:'"]/g, ''), alts: (b.alts || []).map(String) })));
      return { sentence, zh: it?.zh, blanks };
    }).filter((s) => s.sentence && s.blanks.length).slice(0, want);
    if (!specs.length) { main.replaceChildren(el('<section class="card"><p class="warning">AI 產生的題目格式異常，請再試一次。</p></section>')); return; }
  }
  if (!specs.length) { main.replaceChildren(el('<section class="card"><p class="warning">沒有可作答的題目，請重新整理頁面再試。</p></section>')); return; }

  zh2enJoin = new Set();
  zh2enWordById = new Map();
  // 5.2：考古題來源的標籤（「考古題・挖空」而不是「題庫・挖空」）
  runZh2EnSession(main, { specs, allBlank, isAi: src.startsWith('ai'), srcTag: src.startsWith('archive') ? '考古題' : null });
}

/** 去掉英文單字尾端的標點（挖空答案比對用；與 translate-engine 的 stripPunct 同義） */
const stripPunctWord = (w) => String(w || '').replace(/[.,!?;:'"()]/g, '');

/**
 * 中譯英多句會話：逐句作答（上／下一題），最後一句答完進完成畫面。
 * 4.3.1 批次 4：最後一格答對（opts.onAllCorrect）→ toast「全部正確」＋自動收束本句，
 * 與按「檢查答案」同一條路徑（同一句只收束一次）。
 */
function runZh2EnSession(main, { specs, allBlank, isAi, srcTag }) {
  let idx = 0;
  let correctCount = 0;
  // 5.1.1 B4：連對計數（d2-combo 徽記）；一次會話一份，與 idx／correctCount 同層
  const combo = makeCombo();

  const showCompletion = () => {
    mountCompletion(main, {
      title: '中譯英完成',
      scoreText: `${correctCount} / ${specs.length}`,
      stats: [{ num: specs.length, label: '總句數' }, { num: correctCount, label: '全對句數' }],
      onAgain: () => renderSpelling(main, 'zh2en'),
      correct: correctCount, total: specs.length, // 5.1.1 B4：正確率滿 80% 殼層會放彩帶
    });
    const host = main.querySelector('.completion')?.parentElement || main;
    mountJoinPanel(host, { joinPool: zh2enJoin, wordById: zh2enWordById, bookName: '中譯英練習收錄' });
  };

  const finishSentence = () => {
    if (idx < specs.length - 1) { idx++; renderQ(); return; }
    showCompletion();
  };

  const renderQ = () => {
    const spec = specs[idx];
    const shell = mountShell(main, {
      typeLabel: `中譯英・${isAi ? 'AI' : (srcTag || '題庫')}・${allBlank ? '整句' : '挖空'}`,
      cur: idx + 1, total: specs.length,
      canPrev: idx > 0, canNext: idx < specs.length - 1,
      onPrev: () => { if (idx > 0) { idx--; renderQ(); } },
      onNext: () => { if (idx < specs.length - 1) { idx++; renderQ(); } },
      combo, // 5.1.1 B4：殼層進度區掛連對徽記
    });
    let settled = false; // 本句是否已判定（避免 input 連續觸發重複收束）
    const settle = () => {
      if (settled) return;
      settled = true;
      const ok = eng.isAllCorrect();
      if (ok) correctCount++;
      // 5.1.1 B3/B4：中譯英原本只有 toast、殼內沒有回饋行；為疊加 d1 對錯動畫補上
      // 與其他引擎同款的殼內回饋（文字沿用 toast 語意），動畫由殼層 setFeedback 統一掛。
      shell.setFeedback(ok ? '全部正確' : '有些空格尚未正確', ok ? 'ok' : 'bad');
      combo.record(ok);
      combo.render(shell.comboEl);
      if (ok) toast('全部正確！', 'ok');
      else toast('有些空格尚未正確，紅色底線的空格需要修改。', 'bad');
      eng.markGrades();
      addEvent('quiz', null, { q: 'zh2en', ok: eng.isAllCorrect() });
      appendDone(shell.content);
    };
    const eng = mountSentence(shell.content, spec, { onAllCorrect: settle });

    const actions = document.createElement('div');
    actions.className = 'controls';
    actions.innerHTML = `
      <button class="btn" id="tz-reveal">顯示答案</button>
      <button class="btn primary" id="tz-check">檢查答案</button>`;
    shell.content.appendChild(actions);

    const wordPool = [...new Set(spec.sentence.split(/\s+/).map((w) => w.replace(/[.,!?;:'"]/g, '')))
    ].filter((w) => /^[A-Za-z][A-Za-z'-]{2,}$/.test(w) && w.length >= 3);

    actions.querySelector('#tz-reveal').addEventListener('click', () => {
      eng.revealAll();
      // content words：重要單字（挖空答案優先）＋迷你單詞卡（加入單詞本／加入複習）
      const cws = [...new Set(spec.blanks.map((b) => b.answer))];
      wireWordActions(shell.content, {
        words: cws.length ? cws : wordPool.slice(0, 8),
        bookName: '中譯英練習收錄',
        joinPool: zh2enJoin,
        onAdded: () => {},
      });
      actions.remove();
    });
    actions.querySelector('#tz-check').addEventListener('click', settle);
  };

  // 自動收束後的最後出口：手動「下一句／看成績」
  const appendDone = (host) => {
    const done = document.createElement('button');
    done.className = 'btn primary';
    done.textContent = idx < specs.length - 1 ? '下一句' : '查看成績';
    done.addEventListener('click', () => {
      if (idx < specs.length - 1) { idx++; renderQ(); return; }
      showCompletion();
    });
    host.appendChild(done);
  };

  renderQ();
}

