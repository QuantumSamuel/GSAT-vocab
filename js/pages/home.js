// ============================================================
// 頁面：首頁（2.1.2 響應式；5.1.1 H1-H5 排版擴充）
// 手機（單欄直向）：快捷、今日任務、複習卡（含月曆）、單詞本牆、月曆、動機卡
// 平板/電腦（橫向寬幕）：今日任務跨欄；左欄為複習卡＋快捷＋單詞本牆，右欄為複習月曆＋動機卡
// 5.1.1 新增（出處樣品 ui-samples/5.0/layout-review-50x.html M1，用戶 2026-10-05 裁決）：
//   H5 今日目標條（頁首細條）／H1 接續橫幅（公告之下）／H2 今日任務徑（跨欄）／
//   H3 單詞本卡片牆／H4 動機卡。計數類一律非阻塞回填（效能鐵律，見 fillHomeData）。
// ============================================================
import { el, elAll, escapeHtml, ICONS } from '../core/ui.js';
import { getUser, restFetch } from '../services/auth.js';
import { renderDailyTask } from './review.js';
import { getEvents, getGroups, getSrsQueues, getUnknownMarks, getWordbooks } from '../services/store.js';
// 精熟度／連續天數／倒數與目標常數的唯一實作（W2 與 H3 共用同一支，禁止兩處各寫一份）
import { masteryOfBook, dueOfBook, streakOfEvents, gsatDaysLeft, TODAY_GOAL } from '../core/mastery.js';
// H1 接續學習：resume key 的讀寫實作集中在 study.js（本頁只讀＋關閉時清）
import { readResumeStudy, clearResumeStudy } from './study.js';
import { replay } from '../core/motion.js';

// 學習一節的張數（H2 第二節的 done 條件）。與 practice.js 段末摘要的 SEGMENT_SIZE 同值：
// 「一節」的定義就是 10 張；不直接 import 是為了不把抽卡引擎整組拉進首頁依賴圖。
const SECTION_CARDS = 10;

// ---------- 今日各類活動計數（H2/H4/H5 共用的資料端；now 可注入供單元測） ----------

function startOfToday(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// H5：今日活動總次數（**所有類型**的事件各算一次：練習卡／複習／翻譯／題型／查詢／畢業）
// 注意：統計頁沒有「活動次數」區塊，熱力圖的「活動」另有定義（練習＋複習＋翻譯）；
//   這裡的口徑為今日 events 總數，與那兩處刻意不同（H5 要的是「今天做了多少事」）。
export function todayActivityCount(events, now = new Date()) {
  const start = startOfToday(now);
  return (events || []).filter((e) => new Date(e.at).getTime() >= start).length;
}

// H2 第二節：今日抽卡張數（card 事件）
export function todayCardCount(events, now = new Date()) {
  const start = startOfToday(now);
  return (events || []).filter((e) => e.type === 'card' && new Date(e.at).getTime() >= start).length;
}

// H2 第三節：今日配對回合數。quiz 事件的 extra.q 是各引擎寫入的題型字串——
// matching.js 寫的是 matchingLabel() 的四種值（「配對・一字多義」等，皆以「配對」開頭）；
// selection 寫 single/cloze/discourse、spelling 寫 word/phrase/zh2en、exam 寫 exam:開頭，
// 故以前綴「配對」過濾即精確對應配對引擎（如實對應，不另造題型清單）。
export function todayMatchingCount(events, now = new Date()) {
  const start = startOfToday(now);
  return (events || []).filter((e) => e.type === 'quiz'
    && String(e.extra?.q || '').startsWith('配對')
    && new Date(e.at).getTime() >= start).length;
}

// H4 本週學習：本週事件總次數。本週以週一為起點（與 stats.js 的週界同一規則）
export function weekActivityCount(events, now = new Date()) {
  const start = startOfToday(now);
  const weekStart = start - ((new Date(start).getDay() + 6) % 7) * 86400000;
  return (events || []).filter((e) => new Date(e.at).getTime() >= weekStart).length;
}

// ---------- H2：今日任務徑的三節點狀態 ----------

/**
 * done 條件（spec H2）：1.複習到期清空（N===0）2.今日 card 事件 ≥10（一節）
 * 3.今日 quiz 事件中配對題型 ≥1（一回合）。current 為第一個未完成的節點；
 * 全部完成時 allDone 為 true（節點全綠，另顯示「今日任務完成」）。
 */
export function taskPathState(dueN, cardsToday, matchToday) {
  const done = [dueN === 0, cardsToday >= SECTION_CARDS, matchToday >= 1];
  const cur = done.indexOf(false);
  return { done, cur, allDone: cur === -1 };
}

// ---------- H5：今日目標條 ----------

// 進度與達標（n 為今日活動次數；pct 上限 100；done 為真時進度條換 ok 色全滿）
export function goalProgress(n) {
  return { pct: Math.min(100, Math.round((n / TODAY_GOAL) * 100)), done: n >= TODAY_GOAL };
}

// ---------- H3：單詞本卡片牆 ----------

/**
 * 首頁卡片牆的資料端：排序（Due 多先、同數依名稱）＋最多 6 本（spec H3）。
 * 精熟度與 Due 一律經 core/mastery.js 的共用 helper（W2 同一支）。
 * 回傳 [{ name, due, pct }]，供 paint 與單元測直接用。
 */
export function homeBookCards(books, due, marks, graduateIds) {
  const rows = (books || []).map((b) => ({
    name: b?.name || '',
    due: dueOfBook(b, due),
    pct: masteryOfBook(b, marks, graduateIds).pct,
  }));
  rows.sort((a, b) => b.due - a.due || a.name.localeCompare(b.name, 'zh-Hant'));
  return rows.slice(0, 6);
}

/**
 * 5.1.7（用戶指示「優先以分組的方式呈現」，spec 第 3.1 節）：把單詞本依 groupId 分組。
 * 回傳 [{ id, name, due, books: [{ name, due, pct }] }]，books 內已排序。
 *   分組順序照 js/pages/unknown.js 的 groupSections（先依 getGroups 回傳的順序逐組列出，
 *   最後接一個 id 為 null 的「未分組」；本頁沒有書的組不列出，unknown.js 另會顯示空組提示）。
 *   組內排序沿用 homeBookCards（Due 多先、同數依名稱 localeCompare zh-Hant）。
 *   組層級只給 Due 加總（純加總）；**不算精熟百分比**——那需要另寫一套加權演算法，
 *   spec 明文禁止，也不值得為一個首頁小卡新造一個跟單詞本頁漂移的口徑。
 *   不套 slice(0, 6)：那個上限是 homeBookCards 的「精熟度條牆」上限，
 *   展開某一組時要把該組的書都列出來（否則組的 Due 加總會跟畫面對不上）。
 */
export function homeBookGroups(books, groups, due, marks, graduateIds) {
  const rows = (books || []).map((b) => ({
    gid: b?.groupId ?? null,
    name: b?.name || '',
    due: dueOfBook(b, due),
    pct: masteryOfBook(b, marks, graduateIds).pct,
  }));
  const sections = [
    ...(groups || []).map((g) => ({ id: g?.id ?? null, name: g?.name || '' })),
    { id: null, name: '未分組' },
  ];
  return sections
    .map((s) => {
      const list = rows.filter((r) => r.gid === s.id)
        .sort((a, b) => b.due - a.due || a.name.localeCompare(b.name, 'zh-Hant'))
        .map((r) => ({ name: r.name, due: r.due, pct: r.pct }));
      return { id: s.id, name: s.name, due: list.reduce((t, r) => t + r.due, 0), books: list };
    })
    .filter((s) => s.books.length > 0);
}

// ---------- H4：動機卡圖示（零 emoji：與 core/ui.js 同風格的 stroke SVG） ----------
const MOTIV_ICONS = {
  // 連續天數：火苗（外焰弧線＋內焰）
  flame: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21a7 7 0 0 0 7-7c0-4.2-3.2-6.6-4.8-9.7C13 7.2 9 7.6 9 11a3 3 0 0 0 6 .2c0-1.3-.6-2.2-1.3-3"/></svg>',
  // 學測倒數：旗標
  flag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V4"/><path d="M5 4h12l-3 3.5L17 11H5"/></svg>',
  // 本週學習：活動折線
  pulse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2.5-6 4.5 12 2.5-6H21"/></svg>',
};

// ---------- 公告（3.1.0 起；5.1.3 重做，出處 spec 5.15 第 1.2 節） ----------

// 5.1.3 四項改動的理由（診斷見 spec 1.2，三個原因疊加才會「只能顯示一條」）：
//   ① limit 由 3 改 8——超過 3 則從來看不到（根因 A）。
//   ② 關閉不再寫 localStorage。原本寫進 'vocab2_seen_ann_'+id 永久有效，
//      使用者按過一次該則就永遠不再出現，三則按過兩則就只剩一條（根因 B，使用者的真實體驗）。
//      改成模組層 dismissed Set，本次開啟分頁內有效；刻意不在 renderHome 開頭重置，
//      讓同一分頁內切到別頁再回來維持同一組已關閉。
//      舊的 vocab2_seen_ann_* key 不主動清理（過期或毀損皆無害），讀取時不再依賴它。
//   ③ 列尾補一顆還原鈕（僅 N>0 才渲染），點了只重畫公告區塊，不整頁重畫
//      ——整頁重畫會再打一次公告請求，違反進頁不重打請求的效能鐵律。
//   ④ 每張卡文字改單行省略：完整文字放 title，內容放一個帶 class="ann-text" 的 span
//      （單行省略與截斷規則由 css/style.css 那一支處理）。
const ANNOUNCEMENT_QUERY = 'vocab_announcements?active=eq.true&order=created_at.desc&limit=8';

// ---------- 致謝（5.1.8；用戶提供文字，掛在公告之上） ----------
// 這是純靜態內容：不讀資料、不發請求、不進後台。寫成常數陣列而不是塞在 HTML 模板裡，
// 理由是「四則贊助 + 一句結語」的結構化資料寫成陣列之後，萬一日後要改成可編輯
// （例如放進設定頁或介紹頁）只要搬這個常數，不必重寫模板。
// 金額是字串的一部分（不加貨幣單位符號），數字本身不參與任何運算。
const THANKS = [
  { who: '煉天魔尊蔡仙尊', amount: '66' },
  { who: '絕世女神李神仙', amount: '55' },
  { who: '蓋世神武游大炮', amount: '50' },
  { who: '日本第一女忍者', amount: '88' },
];
const THANKS_FOOTER = '因為有你們的幫助，網頁才能開發下去，感恩有你們！';

// 本次開啟分頁內已關閉的公告 id（不寫 localStorage，見上）
const dismissed = new Set();
// 上次取回的公告原樣（未濾已關閉）——還原鈕就地重畫靠它，不重新請求
let lastAnns = [];

function annCardHtml(ann) {
  const text = String(ann.content ?? '');
  // 圖示與文字各自成一個 span：ann-text 只包文字，單行省略（nowrap＋ellipsis）才作用得到文字本身
  return `
    <section class="ann-card">
      <svg class="ann-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 16.5 5v14L3 13.5z"/><path d="M11.3 16.9a3.1 3.1 0 1 1-6-1.6"/></svg>
      <span class="ann-text" title="${escapeHtml(text)}">${escapeHtml(text)}</span>
      <button class="icon-btn ann-close" data-ann-id="${escapeHtml(ann.id)}" aria-label="關閉公告" title="關閉公告">${ICONS.close}</button>
    </section>`;
}

// 公告區塊的畫面（含還原鈕）。renderHome 與還原鈕都呼叫這一支：
// 只換 #ann-box 的內容，頁面其他區塊不動，也不重新打請求。
function paintAnnouncements(main) {
  const box = main.querySelector('#ann-box');
  if (!box) return; // 期間已切頁：不重畫（isConnected 慣例）
  const hiddenN = lastAnns.filter((a) => dismissed.has(a.id)).length;
  const cards = lastAnns.filter((a) => !dismissed.has(a.id)).map(annCardHtml).join('');
  const restore = hiddenN > 0
    ? `<button class="btn subtle" id="ann-restore">顯示已關閉的公告（${hiddenN}）</button>`
    : '';
  box.replaceChildren(el(`${cards ? `<div class="ann-row">${cards}</div>` : ''}${restore}`));
  box.querySelectorAll('[data-ann-id]').forEach((b) => b.addEventListener('click', () => {
    dismissed.add(b.dataset.annId); // 本分頁內關閉即可（不寫 localStorage）
    paintAnnouncements(main);
  }));
  box.querySelector('#ann-restore')?.addEventListener('click', () => {
    lastAnns.forEach((a) => dismissed.delete(a.id)); // 本次這組公告移出已關閉
    paintAnnouncements(main);
  });
}

// 致謝區塊的畫面（5.1.8 新增；5.1.11 由公告上方移到首頁最下方）。
// 與公告區塊同一層級，插在 .home-layout 之後（頁面最後一塊）。
// 只有靜態內容，所以這支不需要任何參數，也不做 isConnected 檢查
// （它由 renderHome 的 replaceChildren 一次畫出來，之後不會被重畫）。
function thanksHtml() {
  const rows = THANKS.map((t) => `
    <li class="thanks-item">
      <span class="thanks-who">感謝 ${escapeHtml(t.who)}贊助 ${escapeHtml(t.amount)} 元</span>
    </li>`).join('');
  return `
    <section class="thanks-card" aria-label="致謝">
      <h2 class="thanks-title">致謝</h2>
      <ul class="thanks-list">${rows}</ul>
      <p class="thanks-foot">${escapeHtml(THANKS_FOOTER)}</p>
    </section>`;
}

export async function renderHome(main) {
  // 3.1.0：公告橫幅（後台發佈；5.1.3 起「關閉」只在本分頁有效）
  try {
    const rows = await restFetch(ANNOUNCEMENT_QUERY);
    // id 一律轉字串：關閉鈕讀到的是 dataset（字串），不統一會讓已關閉對不回來
    lastAnns = (Array.isArray(rows) ? rows : []).map((a) => ({ ...a, id: String(a.id) }));
  } catch { lastAnns = []; } // 未設定 Supabase／離線時靜默

  // 3.3.1（T-016）：訪客看得到複習卡與月曆的排版，但內容模糊＋不可操作
  const guest = !getUser();
  const lockTip = guest ? `
    <div class="card-lock-tip">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
      登入後解鎖複習計畫 <a href="#/auth?tab=login">登入</a>
    </div>` : '';

  main.replaceChildren(el(`
    <!-- 5.1.3：公告容器。內容由 paintAnnouncements 畫（整頁重畫與還原鈕共用同一支） -->
    <div id="ann-box"></div>
    <div class="goal" id="home-goal">
      <!-- H5：分鐘數是「40 次活動」的靜態粗估文案，不是追蹤數據（真實分鐘數追蹤為 spec 第 5 節範圍外） -->
      <span class="goal-label">今日目標 ${TODAY_GOAL} 次活動（約 15 分鐘）</span>
      <span class="goal-bar"><i id="goal-fill" style="width:0%"></i></span>
      <span class="goal-count muted" id="goal-count">0/${TODAY_GOAL}</span>
    </div>
    <div id="home-resume"></div>
    <div class="home-layout">
      <section class="card home-tasks ${guest ? 'card-locked' : ''}">
        ${guest ? lockTip : ''}
        <p class="home-sec-title">今日任務</p>
        <!-- H2：三節點（手機直向是垂直路徑；寬屏是橫排三個有色底方塊）。
             三個節點都是 <a href>，點哪一格就跳哪個功能頁，所以不需要 START 徽章。 -->
        <div class="path" id="home-path">${guest ? '' : '<p class="muted small">載入中…</p>'}</div>
        <p class="path-done" id="home-path-done" hidden>今日任務完成</p>
      </section>
      <section class="card home-daily ${guest ? 'card-locked' : ''}">
        ${lockTip}
        <div id="daily-card"></div>
      </section>
      <div class="quick-grid">
        <a class="quick-card" href="#/practice">
          <span class="quick-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/></svg></span>
          <span class="quick-title">練習</span>
        </a>
        <!-- 5.0.4 A 項：快捷格由兩格改三格——「學習」指隨機抽卡＋顯示字母拼寫（記形用），
             與「練習」（測驗計分）、「查詢」（工具）性質不同，擺在一起不好選。 -->
        <a class="quick-card" href="#/study">
          <span class="quick-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H19v3H6.5A2.5 2.5 0 0 1 4 20.5z"/><path d="M9 7.5h6"/></svg></span>
          <span class="quick-title">學習</span>
        </a>
        <a class="quick-card" href="#/lookup">
          <span class="quick-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg></span>
          <span class="quick-title">查詢</span>
        </a>
      </div>
      <section class="card home-wb ${guest ? 'card-locked' : ''}" id="home-wb" hidden>
        <!-- H3：無單詞本不渲染（初始 hidden，回填有資料才顯示） -->
        ${guest ? lockTip : ''}
        <p class="home-sec-title">我的單詞本<a class="wb-all" href="#/unknown">全部</a></p>
        <div class="wgrid" id="wb-grid"></div>
      </section>
      <section class="card home-cal ${guest ? 'card-locked' : ''}">
        ${lockTip}
        <div id="cal-card"></div>
      </section>
      <div class="home-motiv" id="home-motiv">
        <!-- H4 動機卡：手機橫向三卡、寬幕與月曆同欄縱向堆疊（樣品 .motiv） -->
        <div class="motiv">
          <span class="motiv-ic">${MOTIV_ICONS.flame}</span>
          <div class="num" id="motiv-streak">…</div>
          <div class="lbl">連續天數</div>
        </div>
        <div class="motiv">
          <span class="motiv-ic">${MOTIV_ICONS.flag}</span>
          <div class="num" id="motiv-gsat">…</div>
          <div class="lbl">學測倒數天</div>
        </div>
        <div class="motiv">
          <span class="motiv-ic">${MOTIV_ICONS.pulse}</span>
          <div class="num" id="motiv-week">…</div>
          <div class="lbl">本週學習</div>
        </div>
      </div>
    </div>
    <!-- 5.1.11：致謝區塊移到首頁最下方（純靜態） -->
    ${thanksHtml()}`));

  renderDailyTask(
    main.querySelector('#daily-card'),
    main.querySelector('#cal-card'),
  );

  // 公告區塊（含還原鈕的掛載）與接續橫幅：兩支各自只畫自己那一塊
  paintAnnouncements(main);
  paintResume(main);
  // 非阻塞回填（效能鐵律：首頁進頁不做 blocking fetch）——本函式在 replaceChildren
  // 之後才讀本機資料，每個回填點先查節點還在不在（期間已切頁就停手），
  // 與 applyAiCounts／loadPresetSources 的 isConnected 慣例同一精神。
  fillHomeData(main, guest);
}

// ---------- H1：接續橫幅（公告之下；存在且 48 小時內才渲染） ----------

function paintResume(main) {
  const host = main.querySelector('#home-resume');
  if (!host) return;
  const data = readResumeStudy(); // 過期／毀損已在讀取端靜默清除並回 null（spec H1）
  if (!data) return;
  host.replaceChildren(el(`
    <div class="resume">
      <span class="resume-play" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M8 5.5v13l11-6.5z"/></svg></span>
      <div class="resume-body">
        <b>繼續上次</b>
        <div class="small muted">${escapeHtml(resumeScopeDesc(data))}——抽卡 ${Number(data.idx) + 1}/${Number(data.total)}</div>
      </div>
      <a class="btn resume-go" href="#/study?resume=1">接回</a>
      <button class="icon-btn resume-close" aria-label="關閉接續提醒" title="關閉">${ICONS.close}</button>
    </div>`));
  // 關閉即清除 key（spec H1）：這場不要了，橫幅不再出現
  host.querySelector('.resume-close').addEventListener('click', () => {
    clearResumeStudy();
    host.replaceChildren();
  });
}

// 接續橫幅的範圍描述（樣品：6000單字 L5-2・u3——抽卡 12/30）。
// 字庫範圍依維度描述成星級／等級清單；星形符號走文字「星」（星形 SVG 在橫幅小字裡太擠）。
function resumeScopeDesc(data) {
  if (data.scope === 'preset') return data.presetName ? String(data.presetName) : '預設單詞本';
  const vals = (data.vals || []).map(Number).filter(Number.isFinite);
  if (!vals.length) return '字庫自選範圍';
  if (data.dim === 'level') return `字庫 ${vals.sort((a, b) => a - b).map((v) => `Lv${v}`).join('・')}`;
  return `字庫 ${vals.sort((a, b) => b - a).map((v) => `${v}星`).join('・')}`;
}

// ---------- H2/H3/H4/H5：計數回填（非阻塞） ----------

async function fillHomeData(main, guest) {
  let srs;
  let events;
  let books;
  let marks;
  let groups;
  try {
    if (guest) {
      // 訪客：任務徑與單詞本已鎖定模糊（card-locked 慣例）不讀那兩份資料；
      // 動機卡與目標條不涉及帳號，本機事件照常顯示
      events = await getEvents();
    } else {
      // 5.1.7：分組清單併進既有的同一個 Promise.all（效能鐵律：不新增進頁請求）
      [srs, events, books, marks, groups] = await Promise.all([
        getSrsQueues(),
        getEvents(),
        getWordbooks(),
        getUnknownMarks(),
        getGroups(),
      ]);
    }
  } catch { return; } // 本機讀取失敗：區塊停在「載入中…」／隱藏，不炸首頁

  paintMotiv(main, events);
  paintGoal(main, events);
  if (guest) return;
  paintTaskPath(main, srs.due.length, events);
  paintWordbooks(main, books, groups, srs.due, marks, events);
}

// H2：今日任務徑
function paintTaskPath(main, dueN, events) {
  const host = main.querySelector('#home-path');
  if (!host) return; // 期間已切頁：不回填（isConnected 慣例）
  const cardsToday = todayCardCount(events);
  const matchToday = todayMatchingCount(events);
  const st = taskPathState(dueN, cardsToday, matchToday);
  const nodes = [
    {
      href: '#/review',
      title: `複習到期 ${dueN} 張`,
      sub: st.done[0] ? '今日到期卡已清空' : '先清到期卡再練新的',
    },
    {
      href: '#/study',
      title: '學習一節',
      sub: st.done[1] ? `已完成（今日 ${cardsToday} 張）` : `今日已抽 ${cardsToday} 張`,
    },
    {
      href: '#/practice/matching',
      title: '配對一回合',
      sub: st.done[2] ? '已完成' : '任選一種配對題型',
    },
  ];
  // 5.1.8：這裡必須用 elAll 而不是 el。el() 遇多個根元素會包一層無 class 的
  // <div>，那層 div 會成為 .path 的唯一直屬子節點，三個 .node 就全落在同一格
  // 裡垂直堆疊（實測 .path 直屬子節點數 = 1、grid 只算到一欄）。elAll 回傳
  // DocumentFragment，三個 .node 才是 .path 的直屬網格項目。
  host.replaceChildren(elAll(nodes.map((n, i) => `
    <a class="node${st.done[i] ? ' done' : ''}${i === st.cur ? ' cur' : ''}" href="${n.href}">
      <span class="nt">${escapeHtml(n.title)}</span>
      <span class="node-sub small muted">${escapeHtml(n.sub)}</span>
    </a>`).join('')));
  const doneMsg = main.querySelector('#home-path-done');
  if (doneMsg) doneMsg.hidden = !st.allDone;
}

// ---------- H3：單詞本卡片牆（分組層與單詞本層） ----------

// 5.1.7（用戶指示「優先以分組的方式呈現，點擊之後再顯示單詞本」，spec 第 3.2 節）：
// 目前展開中的分組（null 就是停在分組清單層）。
// 注意「未分組」那一組的 id 本身就是 null，會跟「沒展開任何組」撞碼，
// 所以畫面端用空字串代表「展開中的未分組」（資料端 homeBookGroups 回傳的 id 仍是 null，
// 這個 null／空字串的映射只發生在畫面層，且統一由 groupKey 一處處理）。
const WB_UNGROUPED = '';
let wbOpenGroup = null;
// 最近一次回填的資料：點分組卡與點返回時只重畫 #wb-grid，靠這兩份就地重畫
// （不呼叫 renderHome，那會再打一次公告請求並重打本機資料，違反進頁不重打請求的慣例）。
let wbGroups = [];
let wbBooks = [];
// 有沒有真的分組可分（決定要不要出分組層）：
// 只看「是否至少有一本的 groupId 非 null」——沒有就維持現況直接列單詞本卡，
// 不會因為「未分組」那一組永遠存在就讓沒有分組的使用者多按一次。
// 另一個必須成立的前提是 wbGroups 非空（groupId 指向已刪除分組的殘留書會讓它空），
// 兩個條件同時成立才出分組層，否則那種殘留資料會讓單詞本牆整片變空白。
let wbHasGroups = false;

// 畫面層的分組鍵：dataset 讀回來一律是字串，所以兩邊都經這裡統一成字串再比
const groupKey = (id) => (id === null || id === undefined ? WB_UNGROUPED : String(id));

// H3：單詞本卡片牆（無分組時最多 6 本：Due 多先、同數依名稱；無單詞本整區不渲染）
function paintWordbooks(main, books, groups, due, marks, events) {
  const sec = main.querySelector('#home-wb');
  if (!sec) return;
  // 精熟的定義：有 graduate 事件且目前不在複習計劃（與 core/mastery.js 同一口徑）
  const graduateIds = (events || []).filter((e) => e.type === 'graduate').map((e) => e.wordId);
  const cards = homeBookCards(books, due, marks, graduateIds);
  if (!cards.length) return;
  wbGroups = homeBookGroups(books, groups, due, marks, graduateIds);
  wbBooks = cards;
  wbHasGroups = wbGroups.length > 0 && (books || []).some((b) => (b?.groupId ?? null) !== null);
  // 分組層到不了（沒有任何一組）時把展開狀態清掉，免得下一段有分組的資料回填時
  // 直接跳進某一組、使用者看到的是沒按過的那一組的書
  if (!wbHasGroups) wbOpenGroup = null;
  // 展開中的分組若已不存在（分組被刪掉或書被移走），退回分組清單層，不畫出空的 #wb-grid
  if (wbOpenGroup !== null && !wbGroups.some((g) => groupKey(g.id) === wbOpenGroup)) {
    wbOpenGroup = null;
  }
  sec.hidden = false;
  drawWordbooks(main);
}

// 單詞本卡（分組層與無分組層用的是同一張卡，內容與 5.1.4 現況完全相同）
const wcardHtml = (c) => `
  <a class="wcard" href="#/unknown">
    <span class="nm">${escapeHtml(c.name)}</span>
    <span class="bar"><i style="width:${c.pct}%"></i></span>
    <span class="due">Due ${c.due}・精熟 ${c.pct}%</span>
  </a>`;

// 只重畫 #wb-grid 與標題列右側的控制鈕（展開與返回都在同一個 #wb-grid 內就地切換，
// 不整頁重畫、不重新請求）。事件綁在每次重畫才新建的元素上，模組層不累積 listener。
function drawWordbooks(main) {
  const grid = main.querySelector('#wb-grid');
  if (!grid) return; // 期間已切頁：不重畫（isConnected 慣例）
  const open = wbOpenGroup === null
    ? null
    : wbGroups.find((g) => groupKey(g.id) === wbOpenGroup);
  // 5.1.8：三處都改 elAll。.wgrid 是 grid 容器，el() 的包層 div 會讓
  // 所有 .wcard／.wgroup 變成它的孫節點，網格欄位就只算得到一欄
  // （這也是「方格看起來怪怪的」另一個來源：單欄直排而不是三欄並排）。
  // 完全沒有分組可分：維持現況直接列單詞本卡（不出現分組層，也沒有返回鈕）
  if (!wbHasGroups) {
    grid.replaceChildren(elAll(wbBooks.map(wcardHtml).join('')));
    setWbBackBtn(main, false);
    return;
  }
  // 展開某一組：就地顯示該組的單詞本卡（卡本身仍連到單詞本頁，行為與現況相同）
  if (open) {
    grid.replaceChildren(elAll(open.books.map(wcardHtml).join('')));
    setWbBackBtn(main, true);
    return;
  }
  // 第一層：分組卡（分組名＋「N 本・Due M」；組層級不算精熟百分比，理由見 homeBookGroups 註解）
  grid.replaceChildren(elAll(wbGroups.map((g) => `
    <button type="button" class="wgroup" data-gid="${escapeHtml(groupKey(g.id))}">
      <span class="wg-name">${escapeHtml(g.name)}</span>
      <span class="wg-meta">${g.books.length} 本・Due ${g.due}</span>
    </button>`).join('')));
  setWbBackBtn(main, false);
  grid.querySelectorAll('.wgroup').forEach((btn) => btn.addEventListener('click', () => {
    wbOpenGroup = btn.dataset.gid; // 分組卡不跳頁，只切換 #wb-grid 內的內容
    drawWordbooks(main);
  }));
}

// 標題列右側的兩個控制互斥（spec 3.2）：未展開只有「全部」連結，展開時換成「返回分組」。
// 用隱藏與移除而不是兩個都常駐（.btn／.btn-text 有 display，會蓋過 UA 的 [hidden]）；
// 移除後重建可避免沿用舊節點上綁過的 listener。
function setWbBackBtn(main, expanded) {
  const title = main.querySelector('#home-wb .home-sec-title');
  if (!title) return;
  const link = title.querySelector('.wb-all');
  title.querySelector('#wb-back')?.remove();
  if (link) link.hidden = expanded;
  if (!expanded) return;
  const back = el('<button type="button" class="wb-all btn-text" id="wb-back">返回分組</button>');
  title.append(back);
  back.addEventListener('click', () => {
    wbOpenGroup = null;
    drawWordbooks(main);
  });
}

// H4：動機卡（連續天數／學測倒數／本週學習）
function paintMotiv(main, events) {
  const set = (id, v) => {
    const n = main.querySelector(`#${id}`);
    if (n) n.textContent = String(v);
  };
  set('motiv-streak', streakOfEvents(events));
  set('motiv-gsat', gsatDaysLeft());
  set('motiv-week', weekActivityCount(events));
}

// H5：今日目標條（活動算今日 events 總次數；達標時 ok 色全滿）
function paintGoal(main, events) {
  const goal = main.querySelector('#home-goal');
  if (!goal) return;
  const n = todayActivityCount(events);
  const g = goalProgress(n);
  const fill = goal.querySelector('#goal-fill');
  if (fill) {
    // 紅線 2 慣例：width 瞬設到目標比例（不動畫 width），填充感交給 d2-progress 的 scaleX 動畫
    fill.style.width = `${g.pct}%`;
    fill.classList.toggle('is-ok', g.done);
    replay(fill, 'd2-progress');
  }
  const count = goal.querySelector('#goal-count');
  if (count) count.innerHTML = `<b>${n}</b>/${TODAY_GOAL}`;
}
