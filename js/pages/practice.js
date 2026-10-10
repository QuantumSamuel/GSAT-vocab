// ============================================================
// 頁面：練習（2.0.8）
// 進入先選類型：單詞本練習（跳到不會單字頁）／配對／選擇／拼寫／模擬考／錯題本
// 5.0.4 A 項：原本的「隨機練習（＝抽卡，性質是學習）」整組搬到 #/study（pages/study.js）；
//   本頁只留測驗與錯題回顧。抽卡引擎（startPractice／renderSession）仍留本檔供兩處共用。
// 卡片三態：英文 ↔ 簡略中文（單擊／空白鍵）；雙擊／F 鍵＝完整版中文
// 兩顆獨立按鈕：加入單詞本（結束時命名保存）／加入複習計劃（SRS 排程）
// ============================================================
import { examStarCount,getWords,loadWords } from '../services/vocab.js';
import { getUnknownIds, getWordbooks, markUnknown, unmarkUnknown, addWordbook, addEvent, getSrsQueues } from '../services/store.js';
import { getAnim, getFlipSpeak, rollFace } from '../services/settings.js';
import { getUser } from '../services/auth.js';
import { generateZhToEnQuestions, startZhToEn } from './translate.js';
import { loadRealBank, isUsable } from '../practice/exam-data.js';
import { getMistakes } from '../services/store.js';
import { el, escapeHtml, emptyState, ICONS, iconInline, phoneticPretty, speak, speakBtn, starsSvg, zhLines } from '../core/ui.js';
import { replay } from '../core/motion.js';
// 5.0.4：換頁需要「同 hash 也重畫」與「離頁守衛」（見 goHash／renderSession 兩處註解）
import { render as renderRoute, routeGuard, setBackHandler, clearBackHandler } from '../core/router.js';
// 5.1.1 H1 接續學習：resume key 的讀寫實作集中在 study.js（key 名、TTL、欄位形狀單點維護，
// home.js 的橫幅與本檔的序列化共用同一份形狀）；本檔只在抽新卡時寫、在兩個收尾點清。
import { saveResumeStudy, clearResumeStudy } from './study.js';

// ---------- 練習狀態（切到其他頁面再回來，練習不中斷） ----------
let session = null;
// { mode: 'random'|'unknown'|'wordbook'|'study', pool, shown, idx, wordbookIds:Set, startedAt, resume? }
// resume（5.1.1 H1，mode==='study' 時存在）：{ scope, dim, vals, presetName, seedShown? }——
// 範圍描述由 study.js 傳入（本檔不知道範圍怎麼選的），序列化時與進度合組成 resume key payload
// shown 每筆：{ word, side:'en'|'zh', zhDetail:'brief'|'full' }
let unknownIds = null; // 加入複習計劃的 wordId 集合
let swipeConsumed = false; // 滑動換字後擋掉緊接的 click 翻面
let lastCardKey = ''; // 動畫用：只有卡片內容變了才播換面

export function renderPractice(main) {
  // 5.1.2 缺陷 B：抽卡 session 進行中按返回＝「離開這場、回到發起它的那一頁」，
  //   不是退一頁。session 的 hash 全程是 #/practice（既有路由），routeStack 看不到
  //   session 這一層，不接 context 返回就會直接 history 退到進練習之前的頁、
  //   順手把進行中的 session 留在記憶體裡（下一頁的返回鍵行為也不對）。
  //   函式本體固定（便於 clearBackHandler 的 owner 把關），狀態一律現讀 session。
  if (session) setBackHandler(backFromSession);
  else clearBackHandler(backFromSession);
  if (session) renderSession(main);
  else renderChooser(main);
}

// 返回＝走 leaveSession 的同一條路徑（學習場回 #/study、單詞本練習回練習首頁）。
// 這裡不直接呼叫 leaveSession：endPractice 才有「有加入單詞本就問要不要保存」的分支，
// 返回屬於「中止」而非「結束」，不該跳出保存表單打斷使用者。
function backFromSession() {
  leaveSession();
}

// 供其他頁面（不會單字／單詞本／學習）直接開一場練習
// 5.0.4：mode 'study'＝從 #/study 進來的單詞卡學習場（結束後回學習頁，其餘回練習首頁）
// 【同 hash 時也要重畫】抽卡場的 hash 一直是 #/practice；從「單詞本練習」選擇頁
//   （同樣在 #/practice 底下）按開始時，直接賦值不會觸發 hashchange、畫面不動。
//   改走 goHash()：同值就自行呼叫 router.render()，跨頁則賦值觸發 hashchange。
export function startPractice(pool, mode, resumeMeta = null) {
  session = {
    mode,
    pool,
    shown: [],
    idx: -1,
    wordbookIds: new Set(),
    startedAt: new Date().toISOString(),
    resume: resumeMeta, // 5.1.1 H1：範圍描述（scope/dim/vals/presetName）＋seedShown；他場次為 null
  };
  // 接續學習（H1）：seedShown 為原場次已看過的字，還原成 shown 並停在最後一張，續按「下一個」
  // 即接著抽新卡。這些字在原場次首次抽出時已記過 'card' 事件，這裡刻意不重記（統計不重複計數）。
  const seed = Array.isArray(resumeMeta?.seedShown) ? resumeMeta.seedShown.filter(Boolean) : [];
  if (seed.length) {
    session.shown = seed.map((word) => ({ word, side: rollFace(), zhDetail: 'brief' }));
    session.idx = session.shown.length - 1;
  }
  goHash('#/practice');
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

  // 5.1.1 P1：推薦卡先畫出「學習新字一節」（不需要任何計數的靜態項，首屏即可用），
  // 到期數／錯題數到位後就地升級成更該先做的那一項——與下方 fillExamBadge 同一套路。
  main.replaceChildren(el(`
    <section class="card pt-rec-card">
      <a class="pt-card pt-card--rec" id="pt-recommend" href="#/study">
        <span class="pt-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H19v3H6.5A2.5 2.5 0 0 1 4 20.5z"/></svg></span>
        <span class="pt-rec-body">
          <span class="pt-rec-kicker">推薦練習</span>
          <span class="pt-title" id="pt-rec-title"></span>
          <span class="pt-desc" id="pt-rec-desc"></span>
        </span>
        <span class="pt-rec-btn" id="pt-rec-btn"></span>
      </a>
    </section>
    <section class="card">
      <!-- 5.0.4 B 項：移除 <h2>練習</h2> 與描述行——入口（首頁快捷格／抽屜／頂部標籤）
           已經有名稱，頁首再寫一次是重複資訊，且把四分類卡往下推。
           5.0.4 A 項：隨機練習（抽卡＝學習）已搬至 #/study，單詞卡分類只剩單詞本練習。 -->
      <!-- 5.1.3：原「全部分類」那整條摺疊控制列（標題列與展開鈕）連同包住分類樹的
           摺疊容器（帶 hidden 屬性的那一層）已整組移除，分類樹直接常駐顯示、
           預設展開且沒有展開鈕或收起鈕，與使用者回報的指示一致。
           5.1.1 P1 的推薦卡（上方 #pt-recommend）不受影響，仍承接「現在最該做什麼」。 -->
      <div class="practice-tree">
        <div class="pt-section">
          <div class="tp-section-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="5" width="14" height="14" rx="2"/><path d="M7 3h12a2 2 0 0 1 2 2v10"/></svg>單詞卡</div>
          <div class="pt-grid pt-2x2">
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
        <!-- 5.0.x 錯題本（spec 5.7 第 3 節）：與模擬考同一層級的 feature 卡。
             範圍＝模擬考的 real／ai 卷＋選擇練習中 real／ai 來源的題（配對／拼寫不進）。 -->
        <a class="pt-card pt-card--feature" href="#/mistakes">
          <span class="pt-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h11l3 3v13H5z"/><path d="M9 12h6M9 16h4"/></svg></span>
          <span class="pt-feature-body">
            <span class="pt-title">錯題本</span>
            <span class="pt-desc">真題／AI 題庫答錯的題・可當卷重考</span>
          </span>
          <span class="badge pt-feature-badge" id="mistake-count">錯題 …</span>
        </a>
      </div>
    </section>`));

  // 5.0.4 A 項：#btn-tree-random（隨機練習＝抽卡）已搬到 #/study，練習頁不再掛它
  // 5.1.3：分類樹改為常駐展開，原摺疊控制列與其切換事件已一併移除，
  //   這裡只留下單詞本練習的入口掛載。
  main.querySelector('#btn-tree-wb').addEventListener('click', () => {
    renderWordbookChooser(main);
  });

  paintRecommend();

  // 真題數不阻塞首屏：畫完才去載（4.2.0 效能鐵律）
  fillExamBadge();

  // 5.0.x：錯題數與 P1 推薦卡的錯題候選項同源（同一支 getMistakes，不重複讀庫）
  getMistakes().then((rows) => {
    recMistakeCount = rows.length;
    const badge = document.getElementById('mistake-count');
    if (badge) badge.textContent = rows.length ? `錯題 ${rows.length} 題` : '尚無錯題';
    paintRecommend();
  }).catch(() => {
    const badge = document.getElementById('mistake-count');
    if (badge) badge.textContent = '讀取失敗';
  });

  // 5.1.1 P1：複習到期數（推薦卡最高優先項）同樣非阻塞回填
  getSrsQueues().then(({ due }) => {
    recDueCount = due.length;
    paintRecommend();
  }).catch(() => { /* 讀不到就不升級推薦項，維持「學習新字一節」的靜態顯示 */ });
}

// ---------- 5.1.1 P1：推薦練習卡（樣品 M2，accent 邊框） ----------
// 優先序（spec P1）：複習到期 → 錯題本 → 學習新字一節。
// 計數一律非阻塞回填：null 表示「還沒讀到」，不等同 0——讀取失敗時不該把
// 「複習到期」硬降級成「學習新字」（會誤導使用者以為沒有到期卡）。
let recDueCount = null;
let recMistakeCount = null;

// 三種候選項的文案集中於此：paintRecommend 只負責照文案填畫面，避免兩處漂移。
// 計數以參數傳入（預設取模組級快取），故可直接單測優先序而不必動模組狀態。
export function recommendPick(due = recDueCount, mistakes = recMistakeCount) {
  if (due > 0) {
    return {
      href: '#/review',
      title: `複習到期 ${due} 張`,
      desc: '依你的複習排程計算——先清到期卡再練新的',
      btn: '開始複習',
    };
  }
  if (mistakes > 0) {
    return {
      href: '#/mistakes',
      title: `錯題重練 ${mistakes} 題`,
      desc: '真題與 AI 題庫答錯的題——重看錯法比練新題更划算',
      btn: '開始重練',
    };
  }
  return {
    href: '#/study',
    title: '學習新字一節',
    desc: '隨機抽卡記形——清完複習後再練新的',
    btn: '開始學習',
  };
}

// 就地回填推薦卡（計數到位後呼叫；畫面可能已換頁，故每次重新抓節點）
function paintRecommend() {
  const host = document.getElementById('pt-recommend');
  if (!host) return;
  const p = recommendPick();
  host.href = p.href;
  host.querySelector('#pt-rec-title').textContent = p.title;
  host.querySelector('#pt-rec-desc').textContent = p.desc;
  host.querySelector('#pt-rec-btn').textContent = p.btn;
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
        <!-- 5.0.4 C 項：移除頁內「返回」鈕（返回走左上角 back-fab；此頁用短按即可回上一層） -->
        <button class="btn primary" id="btn-wb-start">開始練習</button>
      </div>
    </section>`));
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
          <!-- 5.0.4 C 項：這顆是「回到出題頁重試」的**動作鈕**（不是頁內返回鈕），故保留；
               措辭由「返回重試」改為「重新嘗試」以免與已移除的返回鈕混淆。 -->
          <button class="btn primary" id="btn-retry">${ICONS.refresh} 重新嘗試</button>
        </section>`));
      main.querySelector('#btn-retry').addEventListener('click', () => renderZh2EnSelect(main));
    }
  });

  main.replaceChildren(page);
}


// ---------- 5.0.4 A 項：原本的「等級選擇畫面（隨機練習）」已搬到 #/study（pages/study.js）----------
// 抽卡引擎本身（startPractice／renderSession）留在本檔不動：學習頁與單詞本頁共用同一支。

// ---------- 練習畫面 ----------
async function renderSession(main) {
  // 5.0.4：離頁守衛——startPractice 的 goHash() 在「同 hash」時會直接呼叫 router.render()，
  //   而 router.render() → renderPractice() → renderSession() 這條鏈上有 await（IDB）。
  //   這段期間使用者若已切到別頁，回來的 renderSession 會用抽卡畫面覆蓋掉新頁。
  //   （與 4.3.0 unknown.js 的 routeGuard 同一類問題，同一個解法。）
  const stillOn = routeGuard();
  unknownIds = await getUnknownIds();
  if (!stillOn()) return;
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
  const toEn = entry.side !== 'en';
  entry.side = toEn ? 'en' : 'zh';
  if (entry.side === 'zh') entry.zhDetail = 'brief'; // 正常情況翻回中文是簡略版
  // 5.0.x（spec 5.7 第 8 節）：翻面自動發音（預設關）——只在「中文面翻成英文面」時朗讀，
  //   因為那正是使用者「想聽這個字」的時刻；翻回中文面不朗讀（避免吵）。
  if (toEn && getFlipSpeak()) speak(entry.word.word);
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
  if (remaining.length === 0) {
    // 5.1.1 H1：字池抽完代表這場學習走到盡頭，首頁的接續橫幅失去意義，清掉 resume key
    if (session.mode === 'study') clearResumeStudy();
    return false; // 全部抽完
  }
  const word = remaining[Math.floor(Math.random() * remaining.length)];
  session.shown.push({
    word,
    side: rollFace(), // 3.0.0：預設顯示面依設置（英文/中文/隨機）
    zhDetail: 'brief',
  });
  session.idx = session.shown.length - 1;
  addEvent('card', word.id); // 統計：練習卡（2.0.13 起）
  // 5.1.1 H1：抽卡學習場每成功抽一張就序列化進度，首頁接續橫幅與「接回」都靠它。
  // 只在 mode==='study' 做（單詞本練習／不會單字場不提供接回）；spell 學習不走本函式，天然不序列化。
  if (session.mode === 'study') saveResumeStudy(session.resume, session);
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

  // 動畫（5.1.1 B2）：內容「同步」換好之後才播 d3-card-flip（rotateX 42° 淡入）。
  // 【IAB 凍結教訓】舊版 flip 款是「翻到 90° 再用 110ms setTimeout 換內容」——
  // 內容切換依賴動畫計時器，凍結／除頻環境下會停在半翻狀態；本版一律先換內容，
  // 動畫只是裝飾，不再有任何計時器路徑。設置頁三款（立體翻轉／輕柔淡入／彈性活潑）
  // 統一播同一個 d3 視覺，不再依款分流（5.1.1 B2 的既定決定）。
  const cardKey = `${session.idx}:${entry.side}:${entry.zhDetail}`;
  // 發音鈕永遠即時更新（3.0.2 修正：中文面也要看得到）
  page.querySelector('#p-speak').innerHTML = speakBtn(w.word);
  if (cardKey !== lastCardKey) {
    lastCardKey = cardKey;
    renderCardContent(page, entry, w);
    // getAnim() 只回 flip/soft/spring，沒有 'none'，故守門目前恆真（設置頁尚未提供「無動畫」
    // 選項；日後新增時這裡即生效）。三款設定統一播同一個 d3 視覺＝5.1.1 B2 的既定決定。
    if (getAnim() !== 'none') replay(cardEl, 'd3-card-flip');
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

  // 剩餘＝pool 裡「還沒抽過的字數」，不是 pool.length − shown.length。
  // 接續還原（seedShown）時 seed 可能含「在字庫但已不在重建 pool」的字（字庫或範圍改版），
  // 用差值會把剩餘算多、甚至變負數，導致結束鈕提早出現、段末摘要被提前抑制。
  // 口徑與 nextCard 的抽字邏輯一致：used 只認真正出現過的 id。
  const usedIds = new Set(session.shown.map((e) => e.word.id));
  const remaining = session.pool.filter((w) => !usedIds.has(w.id)).length;
  page.querySelector('#p-status').textContent =
    `第 ${session.idx + 1} 張 · 已抽 ${session.shown.length} / ${session.pool.length} · 剩餘 ${remaining} ｜ 單詞本 ${session.wordbookIds.size} · 複習計劃 ${unknownIds.size}`;
  page.querySelector('#p-finish').classList.toggle('hidden',
    !(remaining === 0 && session.idx === session.shown.length - 1));
  updateSegmentCard(page, remaining);
}

// ---------- 段末摘要（5.1.1 C1：mode==='study' only，每 10 張一段） ----------
const SEGMENT_SIZE = 10;

// 本段＝剛看完的 10 張（idx-9 到 idx）。X/Y 不另創評分：逐卡查 session 的兩個真實
// 集合（wordbookIds＝加入單詞本、unknownIds＝加入複習計劃）的「目前」歸屬——
// 使用者中途 toggle 過就以段末當下狀態為準，畫面上如實寫明是「目前的分類結果」。
function segmentStats() {
  const start = Math.max(0, session.idx + 1 - SEGMENT_SIZE);
  let wb = 0;
  let plan = 0;
  for (let i = start; i <= session.idx; i++) {
    const id = session.shown[i].word.id;
    if (session.wordbookIds.has(id)) wb++;
    if (unknownIds.has(id)) plan++;
  }
  return { seen: session.idx + 1, wb, plan };
}

// 依觸發條件掛上／更新／移除段末卡。spec：每 10 張為一段，(idx+1)%10===0 且
// 非最後一張時出現；mode!=='study'（單詞本練習）不渲染，維持現狀。
function updateSegmentCard(page, remaining) {
  const old = page.querySelector('#p-segment');
  const isLastDrawn = remaining === 0 && session.idx === session.shown.length - 1;
  const due = session.mode === 'study'
    && (session.idx + 1) % SEGMENT_SIZE === 0
    && !isLastDrawn;
  if (!due) { old?.remove(); return; }
  const st = segmentStats();
  if (old) { fillSegmentCard(old, st); return; } // 翻面／toggle 等重畫：只更新數字，不重捲動
  const host = el(`
    <div class="seg-settle" id="p-segment" role="status">
      <div class="seg-settle-head">本段結算</div>
      <div class="seg-settle-body">
        <div class="seg-ring"><span class="seg-ring-hole" id="seg-ring-num"></span></div>
        <div class="seg-rows">
          <div>已看 <span class="seg-num" id="seg-seen"></span> 張</div>
          <div class="seg-buckets">
            <span class="seg-bucket">加入單詞本 <span class="seg-num" id="seg-wb"></span> 張</span>
            <span class="seg-bucket">還在學（已加入複習計劃）<span class="seg-num" id="seg-plan"></span> 張</span>
          </div>
          <p class="tp-caption">環形與兩桶計的是本段 ${SEGMENT_SIZE} 張目前的分類結果</p>
        </div>
      </div>
      <div class="controls"><button class="btn primary" id="btn-seg-next">繼續下一節</button></div>
    </div>`);
  fillSegmentCard(host, st);
  host.querySelector('#btn-seg-next').addEventListener('click', () => {
    nextCard();
    updateCard();
    // 捲回卡片續抽（spec：繼續下一節）；可選鏈防禦 jsdom 等未實作 scrollIntoView 的環境
    page.querySelector('#flashcard')?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
  });
  page.querySelector('#flashcard').after(host);
  // spec：出現時自動捲動到結算卡（先掛載再捲動，位置才算得準）
  host.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
}

function fillSegmentCard(host, st) {
  host.querySelector('#seg-seen').textContent = String(st.seen);
  host.querySelector('#seg-wb').textContent = String(st.wb);
  host.querySelector('#seg-plan').textContent = String(st.plan);
  host.querySelector('#seg-ring-num').textContent = String(st.plan);
  // 環形（Y/10）：conic-gradient 是靜態底色不是動畫（紅線 2 只限制動畫屬性）
  const pct = Math.round((st.plan / SEGMENT_SIZE) * 100);
  const ring = host.querySelector('.seg-ring');
  ring.style.background = `conic-gradient(var(--accent) ${pct}%, var(--surface-2) 0)`;
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
// 5.0.4：抽卡場有兩種來源（#/study 的學習、#/practice 的單詞本練習／不會單字），
//   結束後要回到「發起它的那一頁」，否則從學習進來卻被丟回練習首頁會很突兀。
function leaveSession() {
  // 5.1.2：離開 session＝情境返回到此為結案，清掉 handler（owner 把關，
  //   只有目前掛著的正是自己才清，避免誤清別頁剛掛上的）。
  clearBackHandler(backFromSession);
  // 【必須先讀落點、再清 session】落點靠 session.mode 判斷。
  //   順序寫反（先 session=null 再讀）會讓 mode 永遠讀不到 'study'，
  //   學習結束就被丟回練習首頁——這正是 5.0.4 初版踩到的坑。
  const back = backHashOfSession();
  // 5.1.1 H1：結束練習代表這場學習正式收尾，首頁接續橫幅不再出現（spec：leaveSession 清除 key）。
  // 必須在 session=null 之前判斷 mode（順序同上方的落點判斷）。
  if (session?.mode === 'study') clearResumeStudy();
  session = null;
  if (back) { goHash(back); return; }
  renderChooser(document.getElementById('app'));
}

/**
 * 換 hash 並保證畫面真的換頁。
 * 【為什麼需要這一支】location.hash 設成**與當前相同**的值不會觸發 hashchange，
 *   router 就不會重畫——抽卡場的 hash 從頭到尾都是 #/practice（這是既有路由），
 *   所以「同頁內的狀態切換」（例如單詞本選擇頁按下開始、hash 仍是 #/practice）
 *   會靜默不動。這裡對同值情況直接呼叫 renderRoute()，兩條路徑收在同一個函式裡。
 *   【搭配離頁守衛】router.render() 是 async，而 renderSession() 也 await 了 IDB；
 *   若這期間使用者已切到別頁，回來的 renderSession 會用舊畫面覆蓋新頁（4.3.0 同一類問題），
 *   故在 renderSession 內另有 routeGuard() 檢查。兩者缺一不可。
 */
function goHash(hash) {
  if (location.hash === hash) {
    renderRoute().catch(() => {});
  } else {
    location.hash = hash;
  }
}

// 學習場的落點是 #/study；其餘（unknown／wordbook）維持回練習首頁（renderChooser）
function backHashOfSession() {
  return session?.mode === 'study' ? '#/study' : '';
}

function endPractice() {
  if (session && session.wordbookIds.size > 0) {
    renderSaveWordbookForm();
  } else {
    leaveSession();
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
    leaveSession();
  });
  form.querySelector('#btn-skip-wb').addEventListener('click', () => {
    leaveSession();
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
