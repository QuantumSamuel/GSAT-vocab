// ============================================================
// 引擎：拼寫練習（4.1.1）——單字／片語／中譯英（題庫＋AI）
// 中譯英＝Shared Translation Practice Engine 的拼寫應用
//
// 4.3.1 批次 3（單字／片語）：
//   ① 範圍二選一：字庫範圍（Lv 下拉）或單詞本（bank-picker 單選，只列單詞本）
//   ② 題數 segmented（5/10/15/全部），取代寫死的 5 題
//   ③ 片語拼寫的單詞本池＝該單詞本中 collocations 有片語的字；無資料則提示
// 5.0：範圍第三選「AI 題庫字」＝ai-bank.js aiTestedWords 的正解詞（中翻英不動）
// ============================================================
import { getWords, loadWords } from '../services/vocab.js';
import { el, escapeHtml, openDialog, toast } from '../core/ui.js';
import { mountShell, mountCompletion, shuffle } from './shell.js';
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
    runWordSpell(main, label, qs, subtype);
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
function runWordSpell(main, label, qs, subtype) {
  let idx = 0;
  let correct = 0;

  const quitSpell = async () => {
    const ok = await openDialog({
      title: '提前結束',
      body: '已作答的題目不會計入成績（未答題不影響）',
      okText: '結束',
    });
    if (!ok) return;
    renderSpelling(main, subtype); // 回設定畫面
  };

  const showCompletion = () => {
    mountCompletion(main, {
      title: `${label}完成`,
      scoreText: `${correct} / ${qs.length}`,
      stats: [
        { num: qs.length, label: '總題數' },
        { num: correct, label: '答對題數' },
      ],
      onAgain: () => renderSpelling(main, subtype),
      onBack: () => { location.hash = '#/practice'; },
    });
  };

  const renderQ = () => {
    const q = qs[idx];
    if (!q) return; // 防呆：越界翻頁（btn 已 disabled 時仍被程式觸發）不得讓整頁炸掉
    const shell = mountShell(main, {
      typeLabel: label, cur: idx + 1, total: qs.length,
      canPrev: idx > 0, canNext: idx < qs.length - 1,
      onPrev: () => { if (idx > 0) { idx--; renderQ(); } },
      onNext: () => { if (idx < qs.length - 1) { idx++; renderQ(); } },
      onQuit: quitSpell,
    });
    shell.content.appendChild(el(`
      <div>
        <div class="spell-input-row">
          <span class="zh-prompt">${escapeHtml(q.zh)}</span>
          <input class="spell-input" id="sp-input" autocomplete="off" autocapitalize="off" spellcheck="false"
                 style="min-width:${Math.max(120, q.word.length * 14)}px">
        </div>
        <div class="controls"><button class="btn primary" id="sp-check">確認</button></div>
      </div>`));
    const input = shell.content.querySelector('#sp-input');
    const checkBtn = shell.content.querySelector('#sp-check');
    input.focus();

    // 4.1.1 修復（QA）：回已答題直接還原已答狀態，不再重複計分
    if (q.answered !== undefined) {
      input.value = q.word;
      input.disabled = true;
      input.classList.add(q.answered ? 'ok' : 'bad');
      checkBtn.disabled = true;
      shell.setFeedback(q.answered ? `正確：${q.word}` : `正確答案：${q.word}`, q.answered ? 'ok' : 'bad');
      // Pool A 複核：還原分支也要有完成出口，否則回最後一題再次死路
      if (idx === qs.length - 1 && qs.every((x) => x.answered !== undefined)) {
        const done = document.createElement('button');
        done.className = 'btn primary';
        done.textContent = '查看成績';
        done.addEventListener('click', showCompletion);
        shell.content.querySelector('.controls').appendChild(done);
      }
      return;
    }

    const check = () => {
      const good = input.value.trim().toLowerCase() === q.word.toLowerCase();
      if (good) correct++;
      q.answered = good;
      addEvent('quiz', null, { q: subtype, ok: good }); // 4.1.1：題型作答計入統計（首次作答才執行）
      input.disabled = true;
      input.classList.add(good ? 'ok' : 'bad');
      input.style.borderColor = '';
      checkBtn.disabled = true;
      shell.setFeedback(good ? `正確：${q.word}` : `正確答案：${q.word}`, good ? 'ok' : 'bad');
      // 提示完整 senses
      if (!good && q.senses.length > 1) shell.setFeedback(`${shell.feedback.textContent}｜其他意思：${q.senses.filter((s) => s !== q.zh).slice(0, 3).join('、')}`, 'bad');
      // 最後一題答完 → 完成畫面（4.1.1 修復：原實作到此死路）
      if (idx === qs.length - 1) {
        const done = document.createElement('button');
        done.className = 'btn primary';
        done.textContent = '查看成績';
        done.addEventListener('click', showCompletion);
        shell.content.querySelector('.controls').appendChild(done);
      }
    };
    checkBtn.addEventListener('click', check);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !checkBtn.disabled) check(); });
  };

  renderQ();
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

  const showCompletion = () => {
    mountCompletion(main, {
      title: '中譯英完成',
      scoreText: `${correctCount} / ${specs.length}`,
      stats: [{ num: specs.length, label: '總句數' }, { num: correctCount, label: '全對句數' }],
      onAgain: () => renderSpelling(main, 'zh2en'),
      onBack: () => { location.hash = '#/practice'; },
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
    });
    let settled = false; // 本句是否已判定（避免 input 連續觸發重複收束）
    const settle = () => {
      if (settled) return;
      settled = true;
      if (eng.isAllCorrect()) { correctCount++; toast('全部正確！', 'ok'); }
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

