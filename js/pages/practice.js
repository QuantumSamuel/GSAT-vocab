// ============================================================
// 頁面：練習（2.0.8）
// 進入先選模式：隨機練習（等級選擇）／單詞本練習（跳到不會單字頁）
// 卡片三態：英文 ↔ 簡略中文（單擊／空白鍵）；雙擊／F 鍵＝完整版中文
// 兩顆獨立按鈕：加入單詞本（結束時命名保存）／加入複習計劃（SRS 排程）
// ============================================================
import { examStarCount,getWords,loadExam,loadWords } from '../services/vocab.js';
import { getUnknownIds, getWordbooks, markUnknown, unmarkUnknown, addWordbook, addEvent } from '../services/store.js';
import { getAnim, rollFace } from '../services/settings.js';
import { getUser } from '../services/auth.js';
import { generateZhToEnQuestions, startZhToEn } from './translate.js';
import { loadRealBank, isUsable } from '../practice/exam-data.js';
import { el, escapeHtml, emptyState, ICONS, iconInline, phoneticPretty, speakBtn, starsSvg, zhLines } from '../core/ui.js';

// ---------- 練習狀態（切到其他頁面再回來，練習不中斷） ----------
let session = null;
// { mode: 'random'|'unknown'|'wordbook', pool, shown, idx, wordbookIds:Set, startedAt }
// shown 每筆：{ word, side:'en'|'zh', zhDetail:'brief'|'full' }
let unknownIds = null; // 加入複習計劃的 wordId 集合
let swipeConsumed = false; // 滑動換字後擋掉緊接的 click 翻面
let lastCardKey = ''; // 動畫用：只有卡片內容變了才播換面
let flipSwapTimer = null;

export function renderPractice(main) {
  if (session) renderSession(main);
  else renderChooser(main);
}

// 供其他頁面（不會單字／單詞本）直接開一場練習
export function startPractice(pool, mode) {
  session = {
    mode,
    pool,
    shown: [],
    idx: -1,
    wordbookIds: new Set(),
    startedAt: new Date().toISOString(),
  };
  location.hash = '#/practice';
}

// ---------- 模式選單 ----------
// ---------- 練習首頁：4 分類 IA（4.1.1：單詞卡／配對／選擇／拼寫） ----------
// 【4.2.0 決策 6A】模擬考不再與四分類並列成第 5 個 section，
//   改為「分類間隔線之後的 feature 卡」：滿欄、左側 4px accent 直條、右側真題數 badge。
//   真題數走 loadRealBank 的模組級 in-flight 快取，且**不阻塞**首屏——
//   先畫出佔位 badge，題庫回來後再就地換字（fillExamBadge）。
let examBadgeState = 'idle';  // idle＝還沒載；ok＝已得數；fail＝載不到
let examUsableCount = 0;     // 模組級快取：只算一次，之後進練習頁直接顯示

// 把真題數寫進 feature 卡的 badge（畫面上可能已換頁，故每次都重新抓節點）
function paintExamBadge() {
  const badge = document.getElementById('exam-count');
  if (!badge) return;
  badge.hidden = false;
  badge.textContent = examBadgeState === 'ok'
    ? `真題 ${examUsableCount} 題`
    : examBadgeState === 'fail' ? '題庫未載入' : '真題 …';
}

async function fillExamBadge() {
  if (examBadgeState !== 'idle') { paintExamBadge(); return; }
  try {
    const bank = await loadRealBank();
    examUsableCount = (bank?.questions || []).filter(isUsable).length;
    examBadgeState = 'ok';
  } catch {
    examBadgeState = 'fail'; // 靜默降級：feature 卡本身仍可點進 #/exam（該頁有自己的錯誤提示與重試）
  }
  paintExamBadge();
}

function renderChooser(main) {
  const ICONS = {
    cards: '<rect x="3" y="5" width="14" height="14" rx="2"/><path d="M7 3h12a2 2 0 0 1 2 2v10"/>',
    match: '<path d="M8 7h8M8 12h8M8 17h8"/><circle cx="4.5" cy="7" r="1.5"/><circle cx="4.5" cy="12" r="1.5"/><circle cx="4.5" cy="17" r="1.5"/>',
    pick: '<path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/>',
    spell: '<path d="M17 3l4 4L8 20H4v-4z"/>',
    exam: '<path d="M5 4h11l3 3v13H5z"/><path d="M8 11h8M8 15h5"/>',
  };
  const card = (href, icon, title, desc) => `
    <a class="pt-card" href="${href}">
      <span class="pt-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONS[icon]}</svg></span>
      <span><span class="pt-title">${title}</span><br><span class="pt-desc">${desc}</span></span>
    </a>`;
  const btn = (label, desc, id) => `
    <button class="pt-card" id="${id}">
      <span class="pt-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONS.cards}</svg></span>
      <span><span class="pt-title">${label}</span><br><span class="pt-desc">${desc}</span></span>
    </button>`;

  main.replaceChildren(el(`
    <section class="card">
      <h2>練習</h2>
      <p class="muted small">選擇練習類型；答題結果與統計自動記錄。</p>
      <div class="practice-tree">
        <div class="pt-section">
          <div class="tp-section-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="5" width="14" height="14" rx="2"/><path d="M7 3h12a2 2 0 0 1 2 2v10"/></svg>單詞卡</div>
          <div class="pt-grid pt-2x2">
            ${btn('隨機練習', '從字庫選等級抽卡', 'btn-tree-random')}
            ${btn('單詞本練習', '從已保存的單詞本抽卡', 'btn-tree-wb')}
          </div>
        </div>
        <div class="pt-section">
          <div class="tp-section-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 7h8M8 12h8M8 17h8"/><circle cx="4.5" cy="7" r="1.5"/><circle cx="4.5" cy="12" r="1.5"/><circle cx="4.5" cy="17" r="1.5"/></svg>配對</div>
          <div class="pt-grid pt-2x2">
            ${card('#/practice/matching?type=sense', 'match', '一字多義', '一個字多個意思，全部選對')}
            ${card('#/practice/matching?type=syn', 'match', '同義詞', '選出意思相近的字')}
            ${card('#/practice/matching?type=ant', 'match', '反義詞', '選出語意相反的字')}
            ${card('#/practice/matching?type=phrase', 'match', '片語', '片語與中文配對')}
          </div>
        </div>
        <div class="pt-section">
          <div class="tp-section-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/></svg>選擇</div>
          <div class="pt-grid pt-3row">
            ${card('#/practice/selection?type=single', 'pick', '單選', '題庫單選題')}
            ${card('#/practice/selection?type=cloze', 'pick', '克漏字', '5 題一組・文章對照')}
            ${card('#/practice/selection?type=discourse', 'pick', '文意選填', '選字填格')}
          </div>
        </div>
        <div class="pt-section">
          <div class="tp-section-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3l4 4L8 20H4v-4z"/></svg>拼寫</div>
          <div class="pt-grid pt-3row">
            ${card('#/practice/spelling?type=word', 'spell', '單字拼寫', '看中文拼出單字')}
            ${card('#/practice/spelling?type=phrase', 'spell', '片語拼寫', '看中文拼出片語')}
            ${card('#/practice/spelling?type=zh2en', 'spell', '中譯英', '題庫挖空／整句＋AI')}
          </div>
        </div>
        <!-- 4.2.0 決策 6A：feature 卡（間隔線之後的滿欄單卡），不再是第 5 個 section -->
        <div class="section-divider"></div>
        <a class="pt-card pt-card--feature" href="#/exam">
          <span class="pt-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONS.exam}</svg></span>
          <span class="pt-feature-body">
            <span class="pt-title">歷屆真題模擬考</span>
            <span class="pt-desc">113/114 學測五大題型・整卷／迷你</span>
          </span>
          <span class="badge pt-feature-badge" id="exam-count">真題 …</span>
        </a>
      </div>
    </section>`));

  // 真題數不阻塞首屏：畫完才去載（4.2.0 效能鐵律）
  fillExamBadge();

  main.querySelector('#btn-tree-random').addEventListener('click', () => {
    renderSelection(main);
  });
  main.querySelector('#btn-tree-wb').addEventListener('click', () => {
    renderWordbookChooser(main);
  });
}

// ---------- 單詞本練習選擇（自舊 renderChooser 抽出保留） ----------
async function renderWordbookChooser(main) {
  const books = await getWordbooks();
  main.replaceChildren(el(`
    <section class="card">
      <h2>單詞本練習</h2>
      <p class="muted">選擇單詞本後開始；每個單字只會出現一次。</p>
      <div class="level-grid" id="z2e-books">
        ${books.map((b) => `
          <label class="level-item">
            <input type="checkbox" value="${b.id}"><span>${escapeHtml(b.name)}（${(b.wordIds || []).length} 字）</span>
          </label>`).join('') || emptyState({ icon: 'book', title: '尚無單詞本', desc: '在練習結束時可保存，或用「導入單字」批量建立。' })}
      </div>
      <p class="warning" id="practice-warning"></p>
      <div class="controls">
        <button class="btn" id="btn-back">${ICONS.chevronLeft} 返回</button>
        <button class="btn primary" id="btn-wb-start">開始練習</button>
      </div>
    </section>`));
  main.querySelector('#btn-back').addEventListener('click', () => renderChooser(main));
  main.querySelector('#btn-wb-start').addEventListener('click', async () => {
    const warn = main.querySelector('#practice-warning');
    // 4.1.1 修復（Pool A 複核）：冷啟動直闖時字庫可能未載入——補 loadWords 防護（與中譯英路徑一致）
    let byId;
    try {
      let words = getWords();
      if (!words.length) throw new Error('字庫尚未載入');
      byId = new Map(words.map((w) => [w.id, w]));
    } catch {
      try {
        await loadWords();
        byId = new Map(getWords().map((w) => [w.id, w]));
      } catch {
        warn.textContent = '字庫載入失敗，請檢查網路後重試。';
        return;
      }
    }
    const ids = [...main.querySelectorAll('#z2e-books input:checked')].map((i) => i.value);
    const pool = books.filter((b) => ids.includes(String(b.id)))
      .flatMap((b) => (b.wordIds || []).map((id) => ({ id, name: b.name })));
    const seen = new Set();
    const dedup = pool.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
    const words = dedup.map((x) => byId.get(x.id)).filter(Boolean);
    if (!words.length) {
      warn.textContent = '請至少勾選一本含有效單字的單詞本';
      return;
    }
    startPractice(words, 'wordbook');
  });
}

// ---------- 中譯英：勾選單詞本 → AI 出題（4.1.1 修復：由拼寫・中譯英的「單詞本・AI 出題」卡進入） ----------
export async function renderZh2EnSelect(main) {
  const books = await getWordbooks();

  const bookChecks = books.map((b) => {
    const count = b.wordIds.length;
    return `
      <label class="level-item">
        <input type="checkbox" value="${escapeHtml(String(b.id))}" checked>
        <span>${escapeHtml(b.name)}（${count} 字）</span>
      </label>`;
  }).join('');

  const page = el(`
    <section class="card">
      <h2>中譯英</h2>
      <p class="muted">勾選單詞本後出題：題目句子會包含單詞本裡的單字（不特別標示），難度比照學測，可搭配其他單字。</p>
      ${books.length === 0 ? `
        <p class="warning">還沒有已保存的單詞本。先在「練習」中加入單詞本並保存。</p>
      ` : `
        <div class="level-grid" id="z2e-books">${bookChecks}</div>
        <p><strong>題數：</strong>
          <label class="level-item"><input type="radio" name="z2e-count" value="5" checked><span>5 題</span></label>
          <label class="level-item"><input type="radio" name="z2e-count" value="10"><span>10 題</span></label>
          <label class="level-item"><input type="radio" name="z2e-count" value="15"><span>15 題</span></label>
        </p>
        <p class="muted">※ 實際題數不超過勾選單詞本的總字數。</p>
        <p class="warning" id="z2e-warning"></p>
        <button class="btn primary" id="btn-z2e-gen">生成翻譯題（約 10～20 秒）</button>
      `}
    </section>`);

  page.querySelector('#btn-z2e-gen')?.addEventListener('click', async () => {
    const warn = page.querySelector('#z2e-warning');
    const selectedIds = [...page.querySelectorAll('#z2e-books input:checked')].map((i) => i.value);
    const count = Number(page.querySelector('input[name="z2e-count"]:checked').value);
    const pool = books
      .filter((b) => selectedIds.includes(String(b.id)))
      .flatMap((b) => b.wordIds.map((id) => ({ id, name: b.name })));
    // 去重（同一字可能出現在多本）
    const unique = [...new Map(pool.map((x) => [x.id, x])).values()];
    if (unique.length === 0) {
      warn.textContent = '請至少勾選一本單詞本';
      return;
    }
    // 字池換成單字資料（4.1.0 修復：冷啟動直闖時字庫可能未載入——顯示提示而非靜默無反應）
    let wordsById;
    try {
      wordsById = new Map(getWords().map((w) => [w.id, w]));
    } catch {
      try {
        await loadWords(); // 4.1.0：比照其他頁面實際載入字庫（重新整理無法解除此狀態）
        wordsById = new Map(getWords().map((w) => [w.id, w]));
      } catch {
        warn.textContent = '字庫載入失敗，請檢查網路後重試。';
        return;
      }
    }
    const words = unique.map((x) => wordsById.get(x.id)).filter(Boolean);
    const n = Math.min(count, words.length);

    main.replaceChildren(el(`
      <section class="card">
        <h2>中譯英</h2>
        <p>正在出 ${n} 題…請稍候</p>
        <p class="muted">生成約需 10～20 秒，若網路不穩會自動重試。</p>
      </section>`));

    try {
      const questions = await generateZhToEnQuestions(words, n);
      startZhToEn(questions); // 跳到翻譯題作答介面
    } catch (err) {
      main.replaceChildren(el(`
        <section class="card">
          <h2>中譯英</h2>
          <p class="warning">生成失敗：${escapeHtml(String(err.message || err))}</p>
          <button class="btn primary" id="btn-retry">${ICONS.chevronLeft} 返回重試</button>
        </section>`));
      main.querySelector('#btn-retry').addEventListener('click', () => renderZh2EnSelect(main));
    }
  });

  main.replaceChildren(page);
}


// ---------- 等級選擇畫面（隨機練習） ----------
async function renderSelection(main) {
  const page = el(`
    <section class="card">
      <h2>隨機單字練習</h2>
      <p class="muted">選擇等級後開始；每個單字只會出現一次，直到選定範圍全部抽完為止。</p>
      <div class="mode-grid dim-row grid-gap-sm" id="dim-row">
        <label class="mode-card"><input type="radio" name="practice-dim" value="level" checked>
          <span class="mode-title">按照等級</span><span class="mode-desc">Lv1–Lv7（官方課綱）</span></label>
        <label class="mode-card"><input type="radio" name="practice-dim" value="star">
          <span class="mode-title">按照星級</span><span class="mode-desc">5 星到 1 星（考題出現次數）</span></label>
      </div>
      <div class="level-grid" id="level-grid"></div>
      <p class="warning" id="practice-warning"></p>
      <button class="btn primary" id="btn-start">開始練習</button>
    </section>`);

  const grid = page.querySelector('#level-grid');
  const warn = page.querySelector('#practice-warning');
  const exam = await loadExam();
  let dim = 'level';
  const levelItems = () => [1, 2, 3, 4, 5, 6, 7].map((lv) => `
      <label class="level-item"><input type="checkbox" value="${lv}"><span>${lv <= 6 ? 'Lv' + lv : 'Lv7 補充'}</span></label>`).join('');
  const starItems = () => [5, 4, 3, 2, 1].map((s) => `
      <label class="level-item"><input type="checkbox" value="${s}"><span class="stars" aria-label="${s} 星">${starsSvg(s, 14)}</span></label>`).join('');
  grid.innerHTML = levelItems();
  page.querySelectorAll('#dim-row input[name="practice-dim"]').forEach((r) => {
    r.addEventListener('change', () => {
      dim = r.value;
      grid.innerHTML = dim === 'level' ? levelItems() : starItems();
    });
  });

  page.querySelector('#btn-start').addEventListener('click', async () => {
    try {
      await loadWords(); // 4.1.0 修復：字庫載入失敗給出可見提示，不再靜默無反應（與中譯英路徑一致）
    } catch {
      warn.textContent = '字庫載入失敗，請檢查網路後重試。';
      return;
    }
    const vals = [...grid.querySelectorAll('input:checked')].map((i) => Number(i.value));
    if (vals.length === 0) {
      warn.textContent = '請至少選擇一項！';
      return;
    }
    const all = getWords();
    const pool = dim === 'level'
      ? all.filter((w) => vals.includes(w.level))
      : all.filter((w) => vals.includes(exam.stars[String(w.id)] ?? 0));
    if (pool.length === 0) {
      warn.textContent = '沒有符合的單字，請重新選擇等級';
      return;
    }
    session = {
      mode: 'random',
      pool,
      shown: [],
      idx: -1,
      wordbookIds: new Set(),
      startedAt: new Date().toISOString(),
    };
    renderSession(main);
  });
  main.replaceChildren(page);
}

// ---------- 練習畫面 ----------
async function renderSession(main) {
  unknownIds = await getUnknownIds();
  // 3.3.1（T-016）：訪客可翻卡練習，但「加入單詞本／加入複習計劃」鎖住並導向註冊
  const guest = !getUser();

  const page = el(`
    <section class="card" id="practice-session">
      <div class="status" id="p-status">尚未開始</div>
      <div class="finish hidden" id="p-finish">這個範圍的單字已全部出現完畢！可結束練習，或按上一個回顧。</div>
      <div class="flashcard" id="flashcard" title="點一下切換中/英；長按看完整中文釋義">
        <span class="badge" id="p-badge"></span>
        <div class="word" id="p-word"></div>
        <div class="pos" id="p-pos"></div>
        <div class="speak-row" id="p-speak"></div>
      </div>
      <p class="muted hint">點一下／空白鍵＝翻面 · 連續點兩下／長按／F 鍵＝完整中文 · 左右滑動或方向鍵＝換字 · ${iconInline(ICONS.volume, 13)}＝朗讀</p>
      <div class="controls">
        <button class="btn" id="btn-prev">${ICONS.chevronLeft} 上一個</button>
        <button class="btn primary" id="btn-toggle">切換 中/英</button>
        <button class="btn" id="btn-next">下一個 ${ICONS.chevronRight}</button>
      </div>
      <div class="controls">
        ${session.mode !== 'wordbook' ? `<button class="btn ${guest ? 'btn-locked' : ''}" id="btn-wb">加入單詞本</button>` : ''}
        <button class="btn ${guest ? 'btn-locked' : ''}" id="btn-plan">加入複習計劃</button>
      </div>
      <button class="btn subtle" id="btn-end">結束練習</button>
    </section>`);

  // 長按卡片＝完整釋義（2.1.0）；左右滑動換字（3.0.1）
  let pressTimer = null;
  let longPressed = false;
  let startX = 0;
  let startY = 0;
  const cardEl = page.querySelector('#flashcard');
  cardEl.addEventListener('pointerdown', (e) => {
    longPressed = false;
    swipeConsumed = false;
    startX = e.clientX;
    startY = e.clientY;
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => { longPressed = true; showFullZh(); }, 550);
  });
  cardEl.addEventListener('pointermove', (e) => {
    // 手指移動超過 10px 視為滑動手勢，取消長按判定
    if (Math.abs(e.clientX - startX) > 10 || Math.abs(e.clientY - startY) > 10) {
      clearTimeout(pressTimer);
    }
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) =>
    cardEl.addEventListener(ev, () => clearTimeout(pressTimer)));
  cardEl.addEventListener('pointerup', (e) => {
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (longPressed || swipeConsumed) return;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      swipeConsumed = true;
      if (dx < 0) nextCard();
      else prevCard();
      updateCard();
    }
  });
  cardEl.addEventListener('contextmenu', (e) => e.preventDefault()); // 手機長按不出選單

  page.querySelector('#btn-prev').addEventListener('click', () => { prevCard(); updateCard(); });
  page.querySelector('#btn-next').addEventListener('click', () => { nextCard(); updateCard(); });
  page.querySelector('#btn-toggle').addEventListener('click', flip);
  page.querySelector('#flashcard').addEventListener('click', onCardClick);
  page.querySelector('#btn-end').addEventListener('click', endPractice);
  page.querySelector('#btn-wb')?.addEventListener('click', () => {
    if (guest) { location.hash = '#/auth?tab=signup'; return; } // 3.3.1 訪客鎖
    toggleWordbook();
  });
  page.querySelector('#btn-plan').addEventListener('click', () => {
    if (guest) { location.hash = '#/auth?tab=signup'; return; } // 3.3.1 訪客鎖
    togglePlan();
  });

  main.replaceChildren(page);
  if (session.idx === -1) nextCard();
  updateCard();
}

// ---------- 卡片互動 ----------
// 單擊：翻面；連續點擊（400ms 內第二下）：完整版中文；長按：完整版中文
// 發音鈕與滑動不翻面
let lastTapTime = 0;

function onCardClick(e) {
  if (e.target.closest('.speak-btn')) return; // 發音鈕不翻面
  if (swipeConsumed) { swipeConsumed = false; return; } // 滑動換字後的 click 不翻面
  const now = Date.now();
  if (now - lastTapTime < 400) {
    lastTapTime = 0;
    showFullZh(); // 連續點擊＝完整釋義（3.0.2 修正：不依賴 e.detail，手機也能用）
  } else {
    lastTapTime = now;
    flip();
  }
}

function flip() {
  if (!session || session.idx < 0) return;
  const entry = session.shown[session.idx];
  entry.side = entry.side === 'en' ? 'zh' : 'en';
  if (entry.side === 'zh') entry.zhDetail = 'brief'; // 正常情況翻回中文是簡略版
  updateCard();
}

function showFullZh() {
  if (!session || session.idx < 0) return;
  const entry = session.shown[session.idx];
  entry.side = 'zh';
  entry.zhDetail = 'full';
  updateCard();
}

function toggleWordbook() {
  if (!session || session.idx < 0) return;
  const id = session.shown[session.idx].word.id;
  if (session.wordbookIds.has(id)) session.wordbookIds.delete(id);
  else session.wordbookIds.add(id);
  updateCard();
}

async function togglePlan() {
  if (!session || session.idx < 0) return;
  const id = session.shown[session.idx].word.id;
  if (unknownIds.has(id)) {
    unknownIds.delete(id);
    await unmarkUnknown(id);
  } else {
    unknownIds.add(id);
    await markUnknown(id);
  }
  updateCard();
}

// ---------- 抽字與翻頁 ----------
function nextCard() {
  if (session.idx < session.shown.length - 1) {
    session.idx++;
    return true;
  }
  // 抽一個還沒出現過的單字（比照 1.1.5 的不重複隨機）
  const used = new Set(session.shown.map((e) => e.word.id));
  const remaining = session.pool.filter((w) => !used.has(w.id));
  if (remaining.length === 0) return false; // 全部抽完
  const word = remaining[Math.floor(Math.random() * remaining.length)];
  session.shown.push({
    word,
    side: rollFace(), // 3.0.0：預設顯示面依設置（英文/中文/隨機）
    zhDetail: 'brief',
  });
  session.idx = session.shown.length - 1;
  addEvent('card', word.id); // 統計：練習卡（2.0.13 起）
  return true;
}

function prevCard() {
  if (session.idx > 0) session.idx--;
}

// ---------- 更新畫面 ----------
function updateCard() {
  const page = document.getElementById('practice-session');
  if (!page || !session || session.idx < 0) return;

  const entry = session.shown[session.idx];
  const w = entry.word;
  const cardEl = page.querySelector('#flashcard');

  // 動畫（3.0.2 款B）：卡片內容變了才播 3D 翻面，標記等按鈕操作不重播
  const cardKey = `${session.idx}:${entry.side}:${entry.zhDetail}`;
  // 發音鈕永遠即時更新（3.0.2 修正：中文面也要看得到）
  page.querySelector('#p-speak').innerHTML = speakBtn(w.word);
  if (cardKey !== lastCardKey) {
    lastCardKey = cardKey;
    cardEl.classList.remove('flipping');
    void cardEl.offsetWidth;
    if (getAnim() === 'flip') {
      // 立體翻轉：翻到 90° 時才換內容
      cardEl.classList.add('flipping');
      clearTimeout(flipSwapTimer);
      flipSwapTimer = setTimeout(() => renderCardContent(page, entry, w), 110);
      setTimeout(() => cardEl.classList.remove('flipping'), 260);
    } else {
      // 輕柔淡入／彈性活潑：直接換內容，動畫由 CSS 依 data-anim 呈現
      renderCardContent(page, entry, w);
      cardEl.classList.add('flipping');
      cardEl.addEventListener('animationend', () => cardEl.classList.remove('flipping'), { once: true });
    }
  } else {
    renderCardContent(page, entry, w);
  }

  // 兩顆獨立按鈕的狀態
  const inWb = session.wordbookIds.has(w.id);
  const wbBtn = page.querySelector('#btn-wb');
  if (wbBtn) {
    wbBtn.textContent = inWb ? '已加入單詞本 ·' : '加入單詞本';
    wbBtn.classList.toggle('marked', inWb);
  }

  const inPlan = unknownIds.has(w.id);
  const planBtn = page.querySelector('#btn-plan');
  planBtn.textContent = inPlan ? '已加入複習計劃 ·' : '加入複習計劃';
  planBtn.classList.toggle('marked', inPlan);

  const remaining = session.pool.length - session.shown.length;
  page.querySelector('#p-status').textContent =
    `第 ${session.idx + 1} 張 · 已抽 ${session.shown.length} / ${session.pool.length} · 剩餘 ${remaining} ｜ 單詞本 ${session.wordbookIds.size} · 複習計劃 ${unknownIds.size}`;
  page.querySelector('#p-finish').classList.toggle('hidden',
    !(remaining === 0 && session.idx === session.shown.length - 1));
}

// 卡片本體（3.0.2 款B：翻到 90° 時由 flip 流程呼叫換內容；發音鈕在 updateCard 即時更新）
function renderCardContent(page, entry, w) {
  const badge = page.querySelector('#p-badge');
  const wordEl = page.querySelector('#p-word');
  const posEl = page.querySelector('#p-pos');

  // 星級走 SVG（emoji 禁令）：文字部分 Lv＋星數，星形交給 starsSvg
  const starsN = examStarCount(w);
  badge.innerHTML = escapeHtml(w.level <= 6 ? `Lv${w.level}` : '補充')
    + (starsN ? `｜<span class="stars" title="考題星級 ${starsN} 星">${starsSvg(starsN, 12)}</span>` : '');

  const zhBrief = zhLines(w.dictBrief || w.senses.join('；') || w.word);
  const zhFullLines = (w.dictSenses?.length ? w.dictSenses : [zhBrief]).join('\n');

  if (entry.side === 'en') {
    wordEl.className = 'word';
    wordEl.textContent = w.word;
    posEl.textContent = (w.phonetic ? `/${phoneticPretty(w.phonetic)}/  ` : '') + (w.pos || '');
  } else if (entry.zhDetail === 'full') {
    wordEl.className = 'word zh-full';
    wordEl.textContent = zhFullLines;
    posEl.textContent = '（完整釋義）';
  } else {
    wordEl.className = 'word zh-brief';
    wordEl.textContent = zhBrief;
    posEl.textContent = '';
  }
}

// ---------- 結束練習 ----------
function endPractice() {
  if (session && session.wordbookIds.size > 0) {
    renderSaveWordbookForm();
  } else {
    session = null;
    renderChooser(document.getElementById('app'));
  }
}

// 結束時替卡片區顯示「命名並保存單詞本」表單
function renderSaveWordbookForm() {
  const page = document.getElementById('practice-session');
  const n = session.wordbookIds.size;
  const now = new Date();
  const pad = (v) => String(v).padStart(2, '0');
  const defaultName =
    `單詞本_${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;

  const form = el(`
    <div class="save-form">
      <h2>保存本次單詞本</h2>
      <p>本次練習共加入 <strong>${n}</strong> 個單字，為這本單詞本取個名字，之後可以隨時抓來再練：</p>
      <div class="search-row">
        <input type="text" id="wb-name" maxlength="30" value="${defaultName}">
      </div>
      <div class="controls">
        <button class="btn primary" id="btn-save-wb">保存單詞本</button>
        <button class="btn" id="btn-skip-wb">跳過（不保存）</button>
      </div>
    </div>`);

  const card = page.querySelector('#flashcard');
  card.replaceWith(form);
  form.querySelector('#wb-name').focus();
  form.querySelector('#wb-name').select();

  form.querySelector('#btn-save-wb').addEventListener('click', async () => {
    const name = form.querySelector('#wb-name').value.trim() || defaultName;
    await addWordbook({
      name,
      wordIds: [...session.wordbookIds],
      endedAt: now.toISOString(),
    });
    session = null;
    renderChooser(document.getElementById('app'));
  });
  form.querySelector('#btn-skip-wb').addEventListener('click', () => {
    session = null;
    renderChooser(document.getElementById('app'));
  });
}

// ---------- 鍵盤快速鍵（只在練習畫面生效） ----------
document.addEventListener('keydown', (e) => {
  if (!document.getElementById('practice-session')) return;
  if (e.target.matches('input, textarea, select')) return;
  if (e.key === ' ') {
    if (e.target.tagName === 'BUTTON') return; // 交給按鈕本身的空白鍵點擊，避免連切兩次
    e.preventDefault();
    flip();
  } else if (e.key === 'f' || e.key === 'F') {
    e.preventDefault();
    showFullZh();
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    prevCard();
    updateCard();
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    nextCard();
    updateCard();
  }
});
