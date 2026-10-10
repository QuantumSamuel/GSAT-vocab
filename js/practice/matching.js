// ============================================================
// 引擎：配對練習（4.3.1 批次 1）——一字多義／同義詞／反義詞／片語
// 語意多重選：卡片點選（可多選）→ 確定 → 卡片位置不變的著色回饋
// 資料來源：字庫 senses（一字多義）、exam.json.synonyms（同義詞）、
//           data/questions/matching.json（反義詞／片語題庫）、
//           5.0 起另有「AI 題庫出題字」＝ai-bank.js aiTestedWords 的正解詞
//
// 4.3.1 批次 1 三項改造：
//   ① 子分頁移除題型選擇器——題型由 URL ?type=（sense/syn/ant/phrase）決定，無則預設 sense
//   ② 題庫引用單詞本：bank-picker 單選（字庫／單詞本×N）；單詞本僅 sense/syn 可用
//   ③ 排版重做：.settings-row（左 .tp-card-title 標題＋右控制項）＋ .section-divider 分組
//      順序＝題庫來源 → 選項數 → 允許 0 個正確 → 干擾字範圍
// 5.0.x：干擾字範圍新增第三選「同詞本」（spec 5.7 第 9 節）——單詞本來源時干擾字優先從
//   同一本單詞本抽，不足則回退同等級、再回退全字庫（逐級回退、保證湊滿選項數）。
//   單詞本來源預設選「同詞本」（使用者仍可改成全字庫／同等級）。
// ============================================================
import { getWords, loadWords } from '../services/vocab.js';
import { loadExam } from '../services/vocab.js';
import { el, escapeHtml, emptyState, openDialog } from '../core/ui.js';
import { mountShell, mountCompletion, shuffle } from './shell.js';
import { clearBackHandler } from '../core/router.js';
import { makeCombo } from '../core/motion.js';
import { addEvent } from '../services/store.js';
import { bankPickerHTML, readBankSelection, wordbookSources, poolFromWordbookSources } from '../core/bank-picker.js';
import { aiTestedWords, loadAiBank } from './ai-bank.js';

const QS_PER_RUN = 8;
const TYPES = ['sense', 'syn', 'ant', 'phrase'];
// 固定題庫型：真題型的反義詞／片語無法從單詞本合成，只能用固定題庫
const FIXED_BANK_TYPES = ['ant', 'phrase'];
const WORDBOOK_NOTE = '反義詞與片語使用固定題庫，單詞本來源僅適用一字多義與同義詞';
// 5.0：反義詞／片語（固定題庫型）開放單詞本——語意＝用單詞本篩題，不是限縮出題池
const FIXED_WB_NOTE = '固定題庫＋單詞本：只出「題目或答案裡包含單詞本單字」的題目';
// 5.0：AI 出題字來源（與單詞本同屬「限縮出題池」；反義詞／片語無 AI 對應題型）
const AI_BANK = 'ai-words';
const AI_BANK_NOTE = '出題字＝AI 題庫（詞彙＋綜合測驗）的正解詞';
// 5.0：syn 型態選 AI 出題字目前無題可出——同義詞題唯一資料源是 exam.json 的 synonyms
// （實測 17 字：provide/main/major/safe/secure/aircraft/airplane|plane/entrance/entry/
// exterior/external/huge/immense/jump/leap/stable/steady），與 AI 出題池交集 0；
// synonymsTentative 另有 2 筆（strain/stress）同樣不在池內。genSynonym 的
// 「entries < 3 即不出題」門檻必然觸發，畫面只會撞空狀態。
// 依 spec 3.3（只有 fixedBank 型＝ant/phrase 停用 AI 來源）**不**把這個來源停用，
// 改成在註記與空狀態說明講到真正的資料原因，讓使用者知道是「同義詞表還沒收錄」
// 而不是題庫壞掉；等 synonyms 表擴充（同義詞資料工作，非本次接線範圍）後
// 這個組合會自然開始出題，程式端不用回頭改。
const AI_SYN_NOTE = '同義詞題目前無 AI 出題字可用（題源 exam.json 的同義詞表尚未收錄 AI 題庫的正解詞）';

// ---------- 題目產生器：每型回傳 [{prompt, promptSub, options:[{text,correct}], hint}] ----------
// opts: { optionCount, allowZero, range }（4.1.1 修復：allowZero/range 原為死設定，現已接入）
// 4.3.1 批次 1：pool＝「出題池」（字庫或單詞本限縮後的字）；allWords＝干擾字來源（全字庫）
function genSenseMulti(pool, allWords, opts, bookPool = null) {
  const src = Array.isArray(pool) && pool.length ? pool : allWords;
  const ref = Array.isArray(allWords) && allWords.length ? allWords : src;
  // 出題池過濾：單詞本來源時，只有 senses≥2 的字能出一字多義題
  const multi = src.filter((w) => (w.senses || []).length >= 2);
  if (multi.length < 3) return [];
  const sensePool = shuffle(ref.flatMap((w) => (w.senses || []).map((s) => s.trim())).filter(Boolean));
  const qs = shuffle(multi).slice(0, QS_PER_RUN).map((w) => {
    const correct = shuffle([...new Set((w.senses || []).map((s) => s.trim()).filter(Boolean))]);
    const takeN = Math.min(correct.length, opts.optionCount - 1);
    const picked = correct.slice(0, Math.max(1, takeN));
    const lvPool = opts.range === 'lv' ? ref.filter((x) => x.level === w.level) : ref;
    const lvSensePool = opts.range === 'lv' ? lvPool.flatMap((x) => (x.senses || []).map((s) => s.trim())).filter(Boolean) : sensePool;
    // 5.0.x：同詞本優先 → 同等級 → 全字庫（逐級回退；opts.range 在呼叫端已轉成 all，
    //   所以這裡以 bookPool 是否存在判斷要不要走回退鏈）
    const pools = bookPool
      ? [
        bookPool.flatMap((x) => (x.senses || []).map((s) => s.trim())).filter(Boolean),
        (lvSensePool.length ? lvSensePool : sensePool),
      ]
      : [(lvSensePool.length ? lvSensePool : sensePool)];
    const distractors = sampleDistinctChain(pools, opts.optionCount - picked.length, new Set(correct));
    const options = shuffle([...picked.map((t) => ({ text: t, correct: true })), ...distractors.map((t) => ({ text: t, correct: false }))]);
    return { prompt: w.word, promptSub: w.pos || '', options, hint: '選出這個單字的所有中文意思（可複選）' };
  });
  return qs;
}

// 4.3.1 批次 1：entries 改從「出題池」過濾 exam.synonyms（單詞本來源＝該單詞本有同義詞的字）
function genSynonym(pool, allWords, synMap, opts, bookPool = null) {
  const src = Array.isArray(pool) && pool.length ? pool : allWords;
  const all = Array.isArray(allWords) && allWords.length ? allWords : src;
  const inPool = new Set(src.map((w) => w.word));
  const entries = Object.entries(synMap).filter(([w, arr]) => arr.length > 0 && inPool.has(w));
  if (entries.length < 3) return [];
  const wordPool = opts.range === 'lv' ? all : all.map((w) => w.word);
  const qs = shuffle(entries).slice(0, QS_PER_RUN).map(([w, syns]) => {
    // allowZero（4.1.1 修復）：允許產生沒有正確答案的題目（考「沒有就都不選」）
    const wantZero = opts.allowZero && Math.random() < 0.25;
    const byLevel = opts.range === 'lv'
      ? all.find((x) => x.word === w)
      : null;
    const distractorPool = opts.range === 'lv' && byLevel
      ? all.filter((x) => x.level === byLevel.level).map((x) => x.word)
      : (Array.isArray(wordPool) ? wordPool : all.map((x) => x.word));
    const correct = wantZero ? [] : shuffle(syns.filter((s) => s !== w)).slice(0, Math.max(1, Math.floor(opts.optionCount / 2)));
    // 5.0.x：同詞本優先 → 同等級／全字庫（逐級回退）
    const pools = bookPool ? [[...bookPool.map((x) => x.word), ...(distractorPool || [])]] : [distractorPool];
    const distractors = sampleDistinctChain(pools, opts.optionCount - correct.length, new Set([w, ...syns]));
    const options = shuffle([...correct.map((t) => ({ text: t, correct: true })), ...distractors.map((t) => ({ text: t, correct: false }))]);
    return { prompt: w, promptSub: '英', options, hint: '選出這個單字的同義詞（可複選；沒有就都不選）' };
  });
  return qs;
}

function genFromBank(bankItems, opts, hint, bookPool = null) {
  if (!Array.isArray(bankItems) || bankItems.length < 3) return [];
  const qs = shuffle(bankItems).slice(0, QS_PER_RUN).map((item) => {
    // allowZero（4.1.1 修復）：部分題目不出正確選項（考「沒有就都不選」）
    const wantZero = opts.allowZero && Math.random() < 0.25;
    const correct = wantZero ? [] : shuffle([...item.correct]);
    const picked = correct.slice(0, Math.max(1, opts.optionCount - 1));
    // 5.0.x：同詞本優先 → 題庫既有的干擾池（逐級回退；湊不滿照舊整題不採用）
    // bookPool 傳進來的是 **word 物件陣列**（genSenseMulti／genSynonym 收到的一樣），
    // 這裡的選項文字是純字串，所以必須先 map 成 w.word；
    // 未 map 會讓 String(word 物件) 變成 "[object Object]"（池 B 對向驗證第 6 項）。
    const bookTexts = Array.isArray(bookPool)
      ? bookPool.map((x) => (typeof x === 'string' ? x : x?.word)).filter((x) => typeof x === 'string' && x)
      : [];
    const pools = bookTexts.length ? [bookTexts, (item.distractorPool || [])] : [(item.distractorPool || [])];
    const distractors = sampleDistinctChain(pools, opts.optionCount - picked.length, new Set(item.correct));
    if (distractors.length < opts.optionCount - picked.length) return null;
    const options = shuffle([...picked.map((t) => ({ text: t, correct: true })), ...distractors.map((t) => ({ text: t, correct: false }))]);
    return { prompt: item.prompt, promptSub: item.promptSub || '', options, hint };
  }).filter(Boolean);
  return qs;
}

function sampleDistinct(pool, n, exclude) {
  const out = [];
  const seen = new Set(exclude);
  for (const x of shuffle(pool)) {
    if (out.length >= n) break;
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

/**
 * 5.0.x：逐級回退抽干擾項（spec 5.7 第 9 節「同詞本」）。
 * pools 由「優先到回退」排列：同詞本 → 同等級 → 全字庫。
 * 每一級都接在同一個 seen 集合上，故前一級已抽到的字不會在下一級重複；
 * 保證湊滿 want 才結束（不足就是不足，會讓該題少選項——呼叫端另有把關）。
 */
function sampleDistinctChain(pools, n, exclude) {
  const out = [];
  const seen = new Set(exclude);
  for (const pool of pools) {
    if (out.length >= n || !Array.isArray(pool) || !pool.length) continue;
    for (const x of shuffle(pool)) {
      if (out.length >= n) break;
      if (seen.has(x)) continue;
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

// ---------- 會話狀態 ----------
let run = null; // { type, qs, idx, results:[{prompt, pickedCorrect, pickedWrong, missed}], settings }
// 5.1.1 B4：連對計數（d2-combo 徽記）。實例放模組層與 run 同步管理——mountShell 每次
// 換題都會重掛徽記節點，狀態若放在殼層會在換題時歸零；新場景開始時 reset（見兩處）。
const combo = makeCombo();

// 設定畫面（題型由 URL 決定；選項數 4/6；允許 0 正確；干擾字範圍；題庫來源）
export async function renderMatching(main, typeLabel = '配對') {
  await loadWords();
  const all = getWords();
  combo.reset(); // 設定畫面＝新場景的起點（開始練習／再練一次都會經過這裡）

  // 題型（4.3.1 批次 1：設定畫面已無題型選擇器，題型只由 URL ?type= 決定，無／未知值一律 sense）
  const qsType = new URLSearchParams(location.hash.split('?')[1] || '').get('type');
  // 4.1.1 修復（QA 實證）：換題型進入時丟棄進行中的舊場景（URL ?type= 才會生效）；同型回來則續演
  if (run && run.type !== (qsType || 'sense')) run = null;
  const curType = TYPES.includes(qsType) ? qsType : 'sense';
  const fixedBank = FIXED_BANK_TYPES.includes(curType);

  // 題庫來源（批次 0 基建）：字庫 ＋ 5.0 的 AI 出題字 ＋ 各單詞本（動態清單）
  const books = await wordbookSources();
  // 效能鐵律：AI 題庫計數不阻塞畫面——先不給 count，載入完成後再回填數字
  const sources = [{ id: 'wordbank', label: '字庫', count: all.length },
    { id: AI_BANK, label: 'AI 題庫出題字' },
    ...books];

  // 效能：只有同義詞題型需要 synonyms（exam.json 1.6MB），改為開始時才抓
  let synMap = null;

  main.replaceChildren(el(`
    <section class="card">
      <h2>${escapeHtml(matchingLabel(curType))}</h2>
      <p class="muted small">從題目選出所有正確答案（可複選），答錯的選項會以紅框標示、漏選的正確答案以綠框提示。</p>
      <div class="settings-list" id="mc-settings">
        <div class="settings-row settings-row--stack">
          <div class="settings-row-title"><h3 class="tp-card-title">題庫來源</h3></div>
          <div class="settings-row-main">
            ${bankPickerHTML({ name: 'mc-bank', multiple: false, checked: ['wordbank'], sources })}
            <p class="settings-note muted small" id="mc-bank-note">${fixedBank ? escapeHtml(WORDBOOK_NOTE) : ''}</p>
          </div>
        </div>
        <div class="section-divider"></div>
        <div class="settings-row">
          <div class="settings-row-title"><h3 class="tp-card-title">選項數</h3></div>
          <div class="settings-row-main">
            <div class="segmented" role="radiogroup" aria-label="選項數">
              <label><input type="radio" name="mc-count" value="4" checked><span>4</span></label>
              <label><input type="radio" name="mc-count" value="6"><span>6</span></label>
            </div>
          </div>
        </div>
        <div class="section-divider"></div>
        <div class="settings-row">
          <div class="settings-row-title">
            <h3 class="tp-card-title">允許 0 個正確</h3>
            <p class="tp-caption">部分題目不出正確選項，考「沒有就都不選」</p>
          </div>
          <div class="settings-row-main">
            <label class="check-plain settings-switch"><input type="checkbox" id="mc-zero"><span>啟用</span></label>
          </div>
        </div>
        <div class="section-divider"></div>
        <div class="settings-row">
          <div class="settings-row-title">
            <h3 class="tp-card-title">干擾字範圍</h3>
            <p class="tp-caption">錯誤選項從哪裡來</p>
          </div>
          <div class="settings-row-main">
            <div class="segmented" role="radiogroup" aria-label="干擾字範圍">
              <label><input type="radio" name="mc-range" value="all"><span>全字庫</span></label>
              <label><input type="radio" name="mc-range" value="lv"><span>同等級</span></label>
              <label id="mc-range-book-wrap"><input type="radio" name="mc-range" value="book" checked><span>同詞本</span></label>
            </div>
            <p class="settings-note muted small" id="mc-range-note"></p>
          </div>
        </div>
      </div>
      <div class="controls"><button class="btn primary" id="mc-start">開始練習</button></div>
      <p class="warning" id="mc-warn"></p>
      <div id="mc-insufficient"></div>
    </section>`));

  // 固定題庫型（反義詞／片語）：AI 出題字來源停用；單詞本 5.0 起可用——
  // 選單詞本＝篩出「題目或答案裡包含單詞本單字」的固定題庫題（見 FIXED_WB_NOTE）
  if (fixedBank) {
    main.querySelectorAll(`.bank-picker input[value="${AI_BANK}"]`).forEach((i) => { i.disabled = true; });
  }
  // 5.0：syn 型的 AI 出題字來源「不」停用——spec 3.3 只要求 fixedBank 型＝ant/phrase 停用。
  // 目前該組合確實無題可出（題源 synonyms 與 AI 池零交集，見 AI_SYN_NOTE），空狀態的
  // 說明文字講到真正的資料原因；等 synonyms 表擴充後自然就會出題，不必回頭改停用規則。

  // 註記文案跟著題庫來源走
  const bankNote = main.querySelector('#mc-bank-note');
  const syncBankNote = () => {
    const sel = readBankSelection(main, 'mc-bank')[0] || 'wordbank';
    const wbSel = sel.startsWith('wordbook:');
    bankNote.textContent = fixedBank
      ? (wbSel ? FIXED_WB_NOTE : WORDBOOK_NOTE)
      : (curType === 'syn' && sel === AI_BANK ? AI_SYN_NOTE : (sel === AI_BANK ? AI_BANK_NOTE : ''));
  };
  main.querySelectorAll('.bank-picker input[name="mc-bank"]').forEach((i) => i.addEventListener('change', syncBankNote));
  syncBankNote();

  // 5.0.x：題庫來源改變時，「同詞本」選項的可用性與預設跟著走
  //   （單詞本來源＝預設選它；其他來源＝停用並回退全字庫）
  const rangeNote = main.querySelector('#mc-range-note');
  const rangeBook = main.querySelector('input[name="mc-range"][value="book"]');
  const rangeAll = main.querySelector('input[name="mc-range"][value="all"]');
  // 使用者自己動過「干擾字範圍」後就不再自動改他的選擇（否則每次換來源都被拉回預設）
  let rangeTouched = false;
  main.querySelectorAll('input[name="mc-range"]').forEach((r) =>
    r.addEventListener('change', () => { rangeTouched = true; }));
  const syncRangeState = () => {
    const sel = readBankSelection(main, 'mc-bank')[0] || 'wordbank';
    const ok = sel.startsWith('wordbook:');
    if (rangeBook) rangeBook.disabled = !ok;
    const row = main.querySelector('#mc-range-book-wrap');
    if (row) row.classList.toggle('bank-item--empty', !ok);
    if (rangeNote) {
      rangeNote.textContent = ok
        ? '「同詞本」＝錯誤選項優先從這本單詞本的單字抽；不夠時回退同等級，再回退全字庫。'
        : '「同詞本」只在題庫來源選單詞本時適用。';
    }
    if (!ok && rangeBook?.checked && rangeAll) {
      // 沒有單詞本可抽 → 停用並回退全字庫（這是系統決定的，不算使用者選過）
      rangeAll.checked = true;
      rangeBook.checked = false;
    } else if (ok && !rangeTouched && rangeBook && !rangeBook.checked) {
      // 單詞本來源的預設＝同詞本（spec 第 9 節；使用者手動改過就尊重他的選擇）
      rangeBook.checked = true;
    }
  };
  main.querySelectorAll('.bank-picker input[name="mc-bank"]').forEach((i) => i.addEventListener('change', syncRangeState));
  syncRangeState();

  // 5.0：AI 出題字的題數非阻塞載入（進頁面不等大檔 fetch）；到位後回填 bank-item-count。
  // 計數取「與字庫的交集」——出題池本來就是 all.filter(w => set.has(w.word))，
  // 顯示 138 個正解詞會讓人誤以為能出 138 題（片語與綴尾形在字庫查不到）。
  loadAiBank().then((b) => {
    const set = new Set(aiTestedWords(b));
    const n = all.filter((w) => set.has(w.word)).length;
    const countEl = main.querySelector(`.bank-picker input[value="${AI_BANK}"]`)?.closest('.bank-item')?.querySelector('.bank-item-count');
    if (countEl) countEl.textContent = `${n} 題`;
  }).catch(() => {});

  main.querySelector('#mc-start').addEventListener('click', async () => {
    const bank = readBankSelection(main, 'mc-bank')[0] || 'wordbank';
    const useWordbook = bank.startsWith('wordbook:');
    const wbFilterFixed = useWordbook && fixedBank; // 反義詞／片語＋單詞本＝篩題（不是限縮出題池）
    const useAi = bank === AI_BANK && !fixedBank;
    // 5.0.x：單詞本來源時，「同詞本」是預設值（spec 第 9 節）——
    //   checked 屬性寫在模板上只是後設的 default，jsdom／重繪時不會作用在「後設的 default」，
    //   故依「題庫來源」在程式裡顯式設定（與 exam.js 選卷別的處理同一理由）。
    const rangeInput = main.querySelector('input[name="mc-range"]:checked');
    const opts = {
      optionCount: Number(main.querySelector('input[name="mc-count"]:checked').value),
      allowZero: main.querySelector('#mc-zero').checked,
      range: rangeInput ? rangeInput.value : 'all',
    };
    // 非單詞本來源時「同詞本」不適用（沒有同詞本可抽）：停用並回退成全字庫
    if (!useWordbook && opts.range === 'book') {
      opts.range = 'all';
      const allRadio = main.querySelector('input[name="mc-range"][value="all"]');
      if (allRadio) allRadio.checked = true;
    }
    const warn = main.querySelector('#mc-warn');
    warn.textContent = '';
    // 出題池：單詞本來源＝該單詞本的字（sense 需 senses≥2、syn 需 exam.synonyms 有值）；
    // AI 出題字來源＝AI 題庫出過題的字；字庫來源＝全字庫。干擾字仍依「干擾字範圍」取自全字庫。
    // 固定題庫型（ant/phrase）＋單詞本：出題池維持全字庫，單詞本只拿來篩固定題庫的題。
    let pool = all;
    let wbWordSet = null;
    // wbPool：這本單詞本的字。sense/syn 直接當出題池（限縮出題池的既有語意）；
    //   ant/phrase（固定題庫型）只用它篩題＋當「同詞本」干擾池，出題池仍是全字庫。
    // 宣告在 try 之外：「同詞本」干擾池的組裝在 try 之後，必須讀得到。
    let wbPool = null;
    try {
      if (useWordbook && !wbFilterFixed) {
        wbPool = (await poolFromWordbookSources([bank])).pool;
        pool = wbPool;
      } else if (useWordbook && wbFilterFixed) {
        wbPool = (await poolFromWordbookSources([bank])).pool;
        wbWordSet = new Set(wbPool.map((w) => String(w.word || '').toLowerCase()));
        if (!wbWordSet.size) { warn.textContent = '這個單詞本是空的。'; return; }
      }
      else if (useAi) {
        const set = new Set(aiTestedWords(await loadAiBank()));
        pool = all.filter((w) => set.has(w.word));
      }
    } catch (err) {
      warn.textContent = useAi
        ? `AI 題庫載入失敗：${String(err.message || err)}`
        : `讀取單詞本失敗：${String(err.message || err)}`;
      return;
    }
    // 5.0.x：干擾字範圍＝同詞本時，把「同一本單詞本」的字獨立交給出題器
    //   （題目本身仍出自題庫來源；只有**錯誤選項**改從同詞本抽）。
    //   逐級回退由 genXxx 的 distractPool chain 決定（實作見下）。
    // 【為什麼用 wbPool 而不是 pool】固定題庫型（ant/phrase）＋單詞本時，
    //   pool 依 5.0 既有語意維持全字庫（單詞本只拿來篩固定題庫的題），
    //   直接取 pool 會讓「同詞本」退化成「全字庫」（池 B 對向驗證第 10 項）。
    //   wbPool 只在單詞本來源時非 null，其餘來源（含 wbFilterFixed 的題目字面不受影響）。
    const distractPool = opts.range === 'book' ? (wbPool || pool) : null;
    if (distractPool) opts.range = 'all'; // 同詞本優先；不足的部分走既有全字庫回退
    let qs = [];
    try {
      if (curType === 'sense') qs = genSenseMulti(pool, all, opts, distractPool);
      else if (curType === 'syn') {
        if (!synMap) synMap = (await loadExam()).synonyms || {}; // 首次用到才抓 1.6MB（效能鐵律）
        qs = genSynonym(pool, all, synMap, opts, distractPool);
      } else {
        let items = await loadBank(curType);
        if (wbFilterFixed) {
          // 「包含單詞本的單字」：題目（prompt）、正解或干擾池裡，任一個英文單字存在於單詞本。
          // 為什麼連干擾池一起比：片語題的 prompt 是中文、正解是整個片語（"look after"），
          // 只看 prompt＋correct 時分詞得到的 look／after 常常不在使用者的單詞本裡，
          // 單詞本來源就永遠空狀態（實測 8 題的片語題庫全數如此）。干擾池是同一份題庫的
          // 英文單字，納入比對才符合「這本單詞本的字跟這題有關」的語意。
          items = items.filter((q) => {
            const words = [String(q.prompt || ''), ...(q.correct || []), ...(q.distractorPool || [])].join(' ');
            return String(words).toLowerCase().split(/[^a-z']+/).some((t) => t && wbWordSet.has(t));
          });
        }
        const hint = curType === 'ant' ? '選出所有反義詞（可複選）' : '選出所有符合的片語（可複選）';
        qs = genFromBank(items, opts, hint, distractPool);
      }
    } catch (err) {
      // 4.1.1 修復（QA）：textContent 會原樣顯示，先前與 escapeHtml 疊加造成二次轉義
      warn.textContent = `產生題目失敗：${String(err.message || err)}`;
      return;
    }
    if (!qs.length) {
      // 4.1.1：題目不足不是錯誤，是「這個組合目前沒東西」→ 走 emptyState 而非紅字警示
      // 【關聯註記】設定畫面保留（不整頁換掉），使用者才能直接改範圍／放寬干擾字範圍
      warn.textContent = '';
      // 5.0：syn ＋ AI 出題字是已知無題可出的組合，說明要講到真正的資料原因
      //（題源 synonyms 表尚未收錄 AI 正解詞），不能只說「題目不足」讓人猜。
      const synAiNoBank = curType === 'syn' && bank === AI_BANK;
      main.querySelector('#mc-insufficient')?.replaceChildren(el(emptyState({
        icon: 'search',
        title: '這個範圍的題目不足',
        desc: synAiNoBank
          ? AI_SYN_NOTE
          : wbFilterFixed
            ? '這個單詞本的單字沒有命中反義詞／片語固定題庫的任何題目（題庫目前規模很小：反義詞 10 題、片語 8 題）。'
            : useWordbook
              ? '這個單詞本可用的題目不足（一字多義需有 2 個以上中文意思的字；同義詞需有同義詞資料）。'
              : useAi
                ? 'AI 題庫出題字可用的題目不足（一字多義需有 2 個以上中文意思的字；同義詞需有同義詞資料）。'
                : '請換題庫來源或擴大干擾字範圍。',
      })));
      return;
    }
    run = { type: curType, qs, idx: 0, results: [], settings: { ...opts, bank }, typeLabel: matchingLabel(curType) };
    renderQuestion(main);
  });

  renderQuestion(main); // 初次無 run → 顯示設定畫面（run 為 null 時 renderQuestion 會 fallback）
}

function matchingLabel(type) {
  return { sense: '配對・一字多義', syn: '配對・同義詞', ant: '配對・反義詞', phrase: '配對・片語' }[type] || '配對';
}

// 4.3.1 批次 1（共用基建第 4 項）：提前結束——確認後清 run 回設定畫面
// 5.1.2：這支同時是 back-fab 短按的情境返回（mountShell 收到 onQuit 就掛上）。
//   確認後場次結束，必須 clearBackHandler，否則使用者回到設定畫面再按返回，
//   會被這支舊的 onQuit 再接走、又跳一次對話框。
async function quitMatching(main) {
  const ok = await openDialog({
    title: '提前結束',
    body: '已作答的題目不會計入成績（未答題不影響）',
    okText: '結束',
  });
  if (!ok) return; // 取消：場次還在，handler 留著（下一鍵才接得上）
  run = null;
  clearBackHandler();
  renderMatching(main);
}

// ---------- 單題渲染 ----------
function renderQuestion(main) {
  if (!run) return;
  const q = run.qs[run.idx];
  const prev = run.results[run.idx]; // 已答過 → 還原狀態（4.1.1 修復：往返翻頁不再重複計分）
  const shell = mountShell(main, {
    typeLabel: run.typeLabel,
    cur: run.idx + 1,
    total: run.qs.length,
    canPrev: run.idx > 0,
    canNext: run.idx < run.qs.length - 1,
    onPrev: () => { run.idx--; renderQuestion(main); },
    onNext: () => { run.idx++; renderQuestion(main); },
    onQuit: () => quitMatching(main),
    combo, // 5.1.1 B4：殼層進度區掛連對徽記
  });
  shell.content.appendChild(el(`
    <div>
      <div class="match-prompt">
        <div class="mp-word">${escapeHtml(q.prompt)}</div>
        ${q.promptSub ? `<div class="mp-hint">${escapeHtml(q.promptSub)}</div>` : ''}
        <div class="mp-hint">${escapeHtml(q.hint)}</div>
      </div>
      <div class="match-grid ${q.options.length > 4 ? 'g6' : 'g4'}" id="mc-grid">
        ${q.options.map((o, i) => `<button class="match-card" data-i="${i}">${escapeHtml(o.text)}</button>`).join('')}
      </div>
      <div class="controls"><button class="btn primary" id="mc-submit">確定答案</button></div>
    </div>`));
  const picked = new Set(prev ? prev.picked : []);
  if (prev) {
    // 還原已答狀態：著色＋回饋，且不再計分
    shell.content.querySelectorAll('.match-card').forEach((c) => {
      const i = Number(c.dataset.i);
      const opt = q.options[i];
      c.disabled = true;
      if (opt.correct && picked.has(i)) c.classList.add('f-correct');
      else if (!opt.correct && picked.has(i)) c.classList.add('f-wrong');
      else if (opt.correct && !picked.has(i)) c.classList.add('f-missed');
    });
    shell.content.querySelector('#mc-submit')?.remove();
    shell.setFeedback(
      prev.perfect ? `全對（${prev.totalCorrect} 個全選正確）` : `正確選 ${prev.pickedCorrect}/${prev.totalCorrect}${prev.pickedWrong ? `｜誤選 ${prev.pickedWrong}` : ''}${prev.missed ? `｜漏選 ${prev.missed}` : ''}`,
      prev.perfect ? 'ok' : 'bad',
    );
    // Pool A 複核：還原分支也要有完成出口
    if (run.idx === run.qs.length - 1) {
      const done = document.createElement('button');
      done.className = 'btn primary';
      done.textContent = '查看成績';
      done.addEventListener('click', () => finishMatching(main, () => { run = null; renderMatching(main); }));
      shell.content.querySelector('.controls').appendChild(done);
    }
  } else {
    shell.content.querySelectorAll('.match-card').forEach((c) => {
      c.addEventListener('click', () => {
        const i = Number(c.dataset.i);
        if (picked.has(i)) { picked.delete(i); c.classList.remove('selected'); }
        else { picked.add(i); c.classList.add('selected'); }
      });
    });
    shell.content.querySelector('#mc-submit').addEventListener('click', () => {
      // 回饋：卡片位置不變——正確被選＝淡綠、錯誤被選＝淡紅粗框、漏選正確＝綠粗框
      shell.content.querySelectorAll('.match-card').forEach((c) => {
        const i = Number(c.dataset.i);
        const opt = q.options[i];
        c.disabled = true;
        c.classList.remove('selected');
        if (opt.correct && picked.has(i)) c.classList.add('f-correct');
        else if (!opt.correct && picked.has(i)) c.classList.add('f-wrong');
        else if (opt.correct && !picked.has(i)) c.classList.add('f-missed');
      });
      shell.content.querySelector('#mc-submit')?.remove();
      const pickedCorrect = [...picked].filter((i) => q.options[i].correct).length;
      const pickedWrong = [...picked].filter((i) => !q.options[i].correct).length;
      const totalCorrect = q.options.filter((o) => o.correct).length;
      const missed = totalCorrect - pickedCorrect;
      const perfect = pickedCorrect === totalCorrect && pickedWrong === 0;
      shell.setFeedback(
        perfect ? `全對（${totalCorrect} 個全選正確）` : `正確選 ${pickedCorrect}/${totalCorrect}${pickedWrong ? `｜誤選 ${pickedWrong}` : ''}${missed ? `｜漏選 ${missed}` : ''}`,
        perfect ? 'ok' : 'bad',
      );
      // 4.1.1 修復（QA 實證）：以題號覆寫而非 push——回上一題重交不會灌水分母
      run.results[run.idx] = { prompt: q.prompt, picked: [...picked], pickedCorrect, pickedWrong, totalCorrect, missed, perfect };
      addEvent('quiz', null, { q: run.typeLabel, ok: perfect }); // 4.1.1：題型作答計入統計（首次作答才執行）
      // 5.1.1 B4：連對計數——口徑與統計事件一致（全對才算連過一題）；只在新作答時記，
      // 還原分支（回看已答題）不會走到這裡，翻頁往返不會重複累計
      combo.record(perfect);
      combo.render(shell.comboEl);
      // 最後一題答完 → 完成畫面出口（4.1.1 修復：原實作到此死路）
      if (run.idx === run.qs.length - 1) {
        const done = document.createElement('button');
        done.className = 'btn primary';
        done.textContent = '查看成績';
        // Pool A 複核：「再練一次」必須清 run——否則同型 run 被保留、跳回舊場景終點頁
        done.addEventListener('click', () => finishMatching(main, () => { run = null; renderMatching(main); }));
        shell.content.querySelector('.controls').appendChild(done);
      }
    });
  }
}

// ---------- 完成 ----------
// 5.0.x（spec 5.7 第 2 節）：錯題重練——把本次沒全對的題組成**記憶體內**臨時題集，
//   用同一引擎、同一設定（run.settings）立刻重跑；臨時題集不持久化。
function finishMatching(main, onAgain) {
  const rs = run?.results.filter(Boolean) || [];
  const perfect = rs.filter((r) => r.perfect).length;
  const wrong = run ? run.qs.filter((_, i) => rs[i] && !rs[i].perfect) : [];
  mountCompletion(main, {
    title: '配對練習完成',
    scoreText: `${perfect} / ${rs.length}`,
    stats: [
      { num: rs.length, label: '總題數' },
      { num: perfect, label: '全對題數' },
    ],
    wrongCount: wrong.length,
    onRetryWrong: wrong.length && run ? () => startMatchingRun(main, wrong, run.settings) : undefined,
    onAgain,
    correct: perfect, total: rs.length, // 5.1.1 B4：正確率滿 80% 殼層會放彩帶
  });
}

/**
 * 5.0.x：以指定的題集（錯題臨時題集）開一場配對練習。
 * 題型沿用 run.type，設定沿用 run.settings（同一引擎、同一設定）——spec 第 2 節要求。
 */
function startMatchingRun(main, qs, settings) {
  run = {
    type: run?.type || 'sense',
    qs,
    idx: 0,
    results: [],
    settings: { ...settings },
    typeLabel: run?.typeLabel || '配對',
  };
  combo.reset(); // 錯題重練＝新場景，連對從零起算
  renderQuestion(main);
}

// ---------- 題庫載入（反義詞／片語） ----------
async function loadBank(type) {
  const res = await fetch('data/questions/matching.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('題庫檔 data/questions/matching.json 不存在');
  const data = await res.json();
  return type === 'ant' ? (data.antonym || []) : (data.phrase || []);
}
