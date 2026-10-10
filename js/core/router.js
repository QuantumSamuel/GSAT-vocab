// ============================================================
// 路由核心（3.0.3 分層重構）：頁面註冊表＋生命週期＋chrome＋過場動畫
// 頁面模組「懶載入」：首次造訪才下載該頁程式（效能預算：首頁只載首頁需要的）
// 新頁面接法：在 PAGE_MODULES 加一列 ＋ index.html 選單加一項，完成
// ============================================================
import { el, escapeHtml, ICONS } from './ui.js';
import { emit } from './eventbus.js';
import { canManage } from './entitlements.js';
import { isLoggedIn, authReady } from '../services/auth.js';
import { replay } from './motion.js';

// ---------- 頁面註冊表 ----------
// load：動態載入器（懶載入）；render：該模組的渲染函式名；label：頂部頁面名
const PAGE_MODULES = {
  '':        { label: '',       load: () => import('../pages/home.js'),     render: 'renderHome' },
  practice:  { label: '練習',   load: () => import('../pages/practice.js'), render: 'renderPractice' },
  // 5.0.4 A 項：學習（隨機抽卡＋顯示字母拼寫）從練習頁搬出來成獨立頁
  study:     { label: '學習',   load: () => import('../pages/study.js'),    render: 'renderStudy' },
  'practice/matching': { label: '配對',  load: () => import('../practice/matching.js'), render: 'renderMatching' },
  'practice/selection': { label: '選擇', load: () => import('../practice/selection.js'), render: 'renderSelection' },
  'practice/spelling': { label: '拼寫',  load: () => import('../practice/spelling.js'), render: 'renderSpelling' },
  exam:      { label: '模擬考', load: () => import('../pages/exam.js'),         render: 'renderExam' },
  // 5.0.x 錯題本（spec 5.7 第 3 節）：不設註冊牆——錯題只存在本機，訪客看自己的錯題是合理的
  mistakes:  { label: '錯題本', load: () => import('../pages/mistakes.js'),   render: 'renderMistakes' },
  lookup:    { label: '查詢',   load: () => import('../pages/lookup.js'),   render: 'renderLookup' },
  unknown:   { label: '單詞本', load: () => import('../pages/unknown.js'),  render: 'renderUnknown' },
  review:    { label: '複習',   load: () => import('../pages/review.js'),   render: 'renderReviewManage' },
  sync:      { label: '同步',   load: () => import('../pages/sync.js'),     render: 'renderSync' },
  translate: { label: '翻譯題', load: () => import('../pages/translate.js'),render: 'renderTranslate' },
  stats:     { label: '統計',   load: () => import('../pages/stats.js'),    render: 'renderStats' },
  intro:     { label: '介紹',   load: () => import('../pages/intro.js'),    render: 'renderIntro' },
  settings:  { label: '設置',   load: () => import('../pages/settings.js'), render: 'renderSettings' },
  auth:      { label: '',       load: () => import('../pages/auth.js'),     render: 'renderAuth' },
  profile:   { label: '個人主頁', load: () => import('../pages/profile.js'), render: 'renderProfile' },
  account:   { label: '賬戶', load: () => import('../pages/account.js'), render: 'renderAccount' },
  admin:     { label: '後台',   load: () => import('../pages/admin.js'),    render: 'renderAdmin' },
};

// 4.1.1：子頁返回的父層（key 為 PAGE_MODULES 的路由代碼，不帶 #/ 與 query）
const PARENT = {
  'practice/matching': '#/practice',
  'practice/selection': '#/practice',
  'practice/spelling': '#/practice',
  exam: '#/practice', // 4.2.0：模擬考從練習頁進入，返回鍵回練習
  mistakes: '#/practice', // 5.0.x：錯題本由練習頁的 feature 卡進入，返回鍵回練習
};

// 已載入頁面的模組快取（動態 import 本身有快取，這裡存掛載/卸載勾子的記錄）
const loaded = new Map();
let currentPage = null;

// 鎖形 SVG（4.1.1：取代 emoji；4.2.0 改用 ICONS.lock 單一來源）——無權限卡與訪客註冊牆共用
const LOCK_SVG = ICONS.lock;

// 切頁方向（3.0.2 款B）：依註冊表順序決定左推或右推
const ROUTE_ORDER = Object.keys(PAGE_MODULES);
let lastRoute = null;

// 目前的路由代碼（hash 去掉前綴 #/ 與 ?query，4.1.1 抽出共用）
// 例：#/practice/matching?type=syn → 'practice/matching'
function currentRoute() {
  return location.hash.replace(/^#\/?/, '').split('?')[0];
}

// 完整落點（5.1.2）：routeStack 的元素存完整 hash（連 query），返回時才能原樣跳回去。
// 空 hash 統一記成 '#/'——location.replace('#') 與 '#/' 在瀏覽器裡等價，
// 但 jsdom 兩者行為不同（會產生一次不同的 hashchange），統一形狀比較好測。
function fullHash() {
  const h = location.hash || '#/';
  return h === '#' ? '#/' : h;
}

export function getPageLabel(hash) {
  return PAGE_MODULES[hash]?.label ?? '';
}

// ---------- 5.1.2：返回導航改用 routeStack（取代 5.0.4 的 navDepth） ----------
// 【為什麼要換掉 navDepth】5.0.4 C 項把「有沒有上一頁」記在 history.state 的
//   vocabDepth 上，那是**數字計數**，看不出「上一頁是誰」。缺陷 A（實測重現）就是
//   這個性質造成的：直接開 #/practice/matching 時深度是 1，第一次返回走 fallback
//   `location.hash = PARENT[...]`——賦值會**推入新 history entry**，而 render 又把
//   深度加到 2；第二次返回因此改走 history.back()，於是跳回配對頁，
//   變成 matching → practice → matching 的無限循環。
//
// 【routeStack 的形狀】app 層的路由堆疊，元素＝{ route, hash }：
//   ・route＝路由代碼（去掉 #/ 與 query），hash＝完整 location.hash（含 query）。
//   ・query 變化不推新層（缺陷 C：#/lookup?w=X 的每次變化只更新既有元素的 hash），
//     返回時直接回上一個 route，使用者不會覺得「按返回沒反應、要按很多次」。
//
// 【兩種換頁的判別】render 發現 route 變了時，看這次是誰發動的：
//   ・navigatingBack（自己按 back-fab 發動的返回）→ 把剛才那一層收掉再記新落點；
//   ・route === 倒數第二層的 route（瀏覽器返回鈕、程式導航回上一層都是這個特徵）→ pop；
//   ・其餘（點連結、程式導航到新頁、瀏覽器前進鈕）→ push。
//   瀏覽器返回不需要另外的旗標：它帶來的 hashchange 走同一支 render，
//   而它帶回來的 route 一定就是 stack 裡的倒數第二層。
//
// 【goBack 為什麼用 location.replace】goBack 一律把「當前這一筆 history entry 換掉」
//   成目標 hash，而不是新增一筆。缺陷 A 的迴圈正是「返回卻推了紀錄」造成的；
//   replace 之後再按返回，退的是我們自己維護的 stack，不會和瀏覽器紀錄打架。
const routeStack = []; // [{ route, hash, seq }]——目前所在 route 在最後一筆
let navigatingBack = false; // goBack 發動的那一次換頁（render 用完即清）
let popPending = false; // popstate 觸發的那一次換頁（瀏覽器返回／前進鈕；render 用完即清）
let popTargetSeq = null; // 那次 popstate 帶回來的 history.state.vocabSeq（非 null 才算是回到我們某一層）
let backHandler = null; // 情境返回處理器（練習場／引擎作答中），見 setBackHandler

/**
 * 把目前這層的序號寫進 history.state（5.1.2）。
 * 序號隨層遞增：back/forward 回到某一層時，popstate 帶回來的 state 會是那一層的序號，
 * 因此可以判斷「這次 pop 的落點是不是 routeStack 裡真的有的層」——
 * 這解決了兩類問題：①某些環境在賦值式換 hash 時也觸發 popstate（不過濾會誤判成返回）；
 * ②forward 回到我們已 pop 掉的層（序號對不上 stack）。
 * 用 replaceState 而非 pushState：不新增 history 紀錄（缺陷 A 的迴圈就是多推紀錄造成的）。
 */
function markCurrentLayer() {
  const top = routeStack[routeStack.length - 1];
  if (!top) return;
  const prevSeq = routeStack[routeStack.length - 2]?.seq || 0;
  top.seq = Math.max(top.seq || 0, prevSeq + 1);
  try {
    window.history?.replaceState?.({ ...(window.history.state || {}), vocabSeq: top.seq }, '');
  } catch { /* 隱私模式等情境不支援 replaceState：序號退化成不分層，行為仍正確 */ }
}

/**
 * 註冊情境返回處理器（5.1.2，缺陷 B：抽卡 session 與引擎作答中按返回會跳層／遺失進度）。
 * fn 會在 back-fab 短按（或鍵盤 Enter）時被呼叫一次，**取代** routeStack 邏輯。
 * 自動帶上註冊當下的 route 與完整 hash：使用者離開該頁、或該頁的 query 換了
 * （見 render 裡的清理條件），就把 handler 清掉，免得引擎忘記 clearBackHandler 時
 * 返回鍵還在呼叫舊流程。
 */
export function setBackHandler(fn) {
  // 5.1.2 修（獨立驗證 high 第 2 項）：要連完整 hash 一起記，只比 route 會漏掉
  //   「同 route 換 query」這條路徑（例：配對 sense 作答中換到 syn）——matching.js
  //   換題型時已把舊場次丟棄、畫面回到設定畫面，但 route 仍是 practice/matching，
  //   舊 handler 因此留著；使用者在設定畫面按返回會跳出「提前結束」框且 hash 不變，
  //   按取消再按又跳同一個框，返回鍵等於失效。比完整 hash 才認得出「這已不是當初那一題」。
  backHandler = typeof fn === 'function'
    ? { fn, route: currentRoute(), hash: fullHash() }
    : null;
}

/**
 * 清除情境返回處理器。可帶 owner（註冊時的同一個函式）做把關：
 * 只有目前掛著的正是自己才清，避免 A 頁的收尾把 B 頁剛掛上的 handler 誤清掉。
 */
export function clearBackHandler(owner) {
  if (owner && backHandler && backHandler.fn !== owner) return;
  backHandler = null;
}

/**
 * 目前是否有情境返回處理器（5.1.2）。給煙霧測試與除錯用：
 * 測試不該靠「按了返回鈕畫面變了」去反推有沒有 handler，直接讀這個旗標才斷得準。
 */
export function hasBackHandler() {
  return Boolean(backHandler);
}

/**
 * 只讀的 routeStack 快照（5.1.2，測試／除錯用）。
 * 回傳淺拷貝的陣列：測試拿它斷「有沒有長出多餘的一層」，
 * 不直接開放內部陣列，避免測試誤改到 App 的真實狀態。
 */
export function getRouteStack() {
  return routeStack.map((s) => ({ ...s }));
}

// ---------- 主渲染流程 ----------
export async function render() {
  const hash = currentRoute(); // 3.2.0：hash 可帶 ?query（如 #/auth?tab=login）
  const page = PAGE_MODULES[hash] || PAGE_MODULES[''];
  const main = document.getElementById('app');
  const dir = lastRoute === null ||
    ROUTE_ORDER.indexOf(hash) >= ROUTE_ORDER.indexOf(lastRoute) ? 'page-fwd' : 'page-back';

  // 目錄高亮目前頁面
  // 4.1.1：改「精確或前綴」——子頁（#/practice/matching）也讓父層 #/practice 亮起；
  // '#/' 特判不參與前綴比對，否則任何頁都會被首頁點亮
  const current = hash === '' ? '#/' : `#/${hash}`;
  document.querySelectorAll('.menu a').forEach((a) => {
    const href = a.getAttribute('href');
    const active = href === current || (href !== '#/' && current.startsWith(href + '/'));
    a.classList.toggle('active', active);
  });

  // 5.1.2：把這次換頁記入 routeStack（見檔頭說明）。
  // 【route 粒度是本段的核心】stack 的元素存「路由代碼＋完整 hash」，
  //   所以同一個 route 只換 query（缺陷 C）時只更新落點、不長出新層。
//   5.1.2 修（獨立驗證 high 第 1 項）：判斷「這次是返回」只用兩個可靠訊號——
  //   navigatingBack（自己按 back-fab）與 popPending（popstate 且帶我們的 history.state 標記）。
  //   【為什麼不能靠「route 是否等於倒數第二層」來猜】原本為省一個狀態變數用那個條件
  //   當返回特徵，但日常往返 A → B → A（抽屜點回同一頁）會誤判：堆疊 ['',A,B] 遇到
  //   新 hash=A 時，A 等於 stack[len-2].route → 誤 pop 掉 B，於是按返回直接跳回首頁、
  //   中間那層消失。popstate 才是「這次變化來自瀏覽器紀錄」的唯一可靠訊號。
  //   （forward 同樣帶 popstate，一併視為返回方向；前進到 stack 沒有的頁面時
  //     isBack 成立但 route 對不上 stack，pop 之後立刻補 push 落點，最終形態正確。）
const backByFlag = navigatingBack;
  navigatingBack = false;
  // popstate 帶回來的序號若對不上 stack 裡任何一層，就是「這個落點不是我們記錄過的層」
  // （jsdom 賦值式換 hash 也觸發 popstate、forward 回到已 pop 掉的層等），
  // 那就當成普通換頁 push，不要 pop 掉還在用的層。
  const seq = popTargetSeq;
  const wasPop = popPending;
  popPending = false;
  popTargetSeq = null;
  const isBack = backByFlag || (wasPop && seq !== null && routeStack.some((s) => s.seq === seq));
  const full = fullHash();
  const prev = routeStack[routeStack.length - 1];
  if (prev && prev.route === hash) {
    prev.hash = full; // 同 route 的變化＝只換 query：更新當前層落點，不灌新層
  } else if (isBack && routeStack.length > 1) {
    routeStack.pop();
    // 前進（forward）與「popstate 落在 stack 沒有的層」都會走到這裡：
    //   pop 之後頂端未必就是使用者實際所在的那頁，補回落點才能讓下一鍵返回退對。
    //   判準＝頂端 route 不是這次的 hash（真返回時頂端必然就是目標頁）。
    const top = routeStack[routeStack.length - 1];
    if (top && top.route !== hash) routeStack.push({ route: hash, hash: full });
    else if (top) top.hash = full;
  } else if (isBack) {
    // stack 只有一層（＝App 的第一頁，或冷啟動直闖子頁）：返回走的是
    // PARENT/主頁的 fallback，而 fallback 用的是 location.replace（不新增 history 紀錄），
    // 所以這裡也是「把當前層換成落點層」，不是 push——否則 stack 會長成
    // [子頁, 父頁]，下一鍵返回又退回合對頁（缺陷 A 的迴圈就是這樣長出來的）。
    routeStack[0] = { route: hash, hash: full };
  } else {
    routeStack.push({ route: hash, hash: full });
  }
  markCurrentLayer();
  // 使用者離開註冊 handler 的那一頁，或該頁的 query 換了（引擎換題型）→ 清掉它。
  // 沒離開且 query 沒換則保留，返回時還接得上（正常作答中按返回仍走提前結束確認）。
  if (backHandler && (backHandler.route !== hash || backHandler.hash !== full)) backHandler = null;

  // 切頁自動收合目錄、更新返回鈕與頁面標籤
  closeMenu();
  updateChrome(page.label);

  try {
    // 後台硬閘（3.2.0）：非管理員連 admin.js 模組都不下載
    // 【關聯註記】canManage() 來自 core/entitlements（由 auth.js 登入後設定）
    // 4.2.0 修復（既有競態）：冷載直接落在 #/admin 時 initAuth 尚未完成、
    // roleCache 還是 null——先等 authReady 再判斷，成功登入者不再誤顯「無權限」
    if (hash === 'admin' && !canManage()) {
      await authReady;
    }
    if (hash === 'admin' && !canManage()) {
      main.replaceChildren(el(`
        <section class="card error">
          <h2><span class="card-h2-icon">${LOCK_SVG}</span>無權限</h2>
          <p>此頁面僅限管理員使用。請以管理員帳號登入後再進入。</p>
          <button class="btn primary" id="btn-goto-auth">前往登入</button>
        </section>`));
      main.querySelector('#btn-goto-auth').addEventListener('click', () => {
        location.hash = '#/auth?tab=login';
      });
      return;
    }
    // 懶載入：首次造訪才下載該頁模組
    if (!loaded.has(hash)) {
      loaded.set(hash, await page.load());
    }
    const mod = loaded.get(hash);
    await mod[page.render](main);
    currentPage = hash;

    // 註冊牆（3.3.1）：訪客進入鎖定功能頁 → 內容模糊＋鎖卡（無法操作）
    // 【關聯註記】層級例外：router（core）直接讀 services/auth 的 isLoggedIn——
    // 為讓鎖定邏輯單點存在於 router，刻意接受這次 core→services 依賴
    const GUEST_LOCKED = ['unknown', 'review', 'stats', 'sync'];
    const guestLocked = !isLoggedIn() && GUEST_LOCKED.includes(hash);
    main.classList.toggle('guest-locked', guestLocked);
    if (guestLocked) {
      const feature = { unknown: '單詞本', review: '複習計劃', stats: '統計', sync: '雲端同步' }[hash];
      main.prepend(el(`
        <div class="guest-lock">
          ${LOCK_SVG}
          <h2>${feature}需要登入</h2>
          <p class="muted">登入後即可使用，資料同步到你的帳號，跨裝置不遺失。</p>
          <div class="controls">
            <a class="btn primary" href="#/auth?tab=login">登入</a>
            <a class="btn" href="#/auth?tab=signup">註冊</a>
          </div>
        </div>`));
    }

    // 動畫（3.0.2 款B）：內容依方向推進
    main.classList.remove('page-fwd', 'page-back');
    void main.offsetWidth;
    main.classList.add(dir);
    // 5.1.1 B1：頁面進場（d3-fade-in）——掛點集中在 router 渲染完成處（spec 允許的
    // 兩個方案之一，另一方案是各頁 el() 外層各自掛；集中在這裡新頁零成本接入）。
    // 掛在 main 的第一個子節點（各頁的根卡片）而非 main 本身：main 已帶 page-fwd／
    // page-back 的方向動畫，同一元素第二個 animation 簡寫會互相覆蓋。
    // 只進不出：class 由 replay 的 animationend 自動移除，不做「等出場再換頁」。
    // 【跳過空殼】各頁第一個子節點可能是空容器（例：首頁無未讀公告時的 <div></div>），
    //   動畫掛上去等於使用者什麼都看不到；改取第一個有內容的子節點。
    const firstWithContent = [...main.children]
      .find((n) => n.textContent.trim() || n.querySelector('*'));
    replay(firstWithContent || null, 'd3-fade-in');
    lastRoute = hash;
    emit('page:enter', { name: hash || 'home' });
  } catch (err) {
    main.replaceChildren(el(`
      <section class="card error">
        <h2><span class="card-h2-icon">${ICONS.warn}</span>發生錯誤</h2><p>${escapeHtml(String(err.message || err))}</p>
      </section>`));
  }
}

// ---------- 頂部 chrome：返回鈕與頁面標籤 ----------
function updateChrome(label) {
  const backFab = document.getElementById('back-fab');
  const topLabel = document.getElementById('top-label');
  if (!backFab || !topLabel) return;
  const isHome = !location.hash || location.hash === '#/';
  backFab.classList.toggle('shown', !isHome);
  topLabel.textContent = isHome ? '' : label;
}

// ---------- ☰ 目錄開合 ----------
// 4.3.0（Pool A Medium）：離頁守衛——async 頁面渲染在 await 期間可能已切頁，
// 回來後 replaceChildren 會覆蓋新頁。回傳一個 stillOn(pageHash) 函式供渲染器檢查。
export function routeGuard() {
  const at = currentRoute();
  return () => currentRoute() === at;
}

export function closeMenu() {
  document.getElementById('menu-overlay')?.classList.remove('open');
  document.querySelector('.menu')?.classList.remove('open');
  document.getElementById('user-menu')?.classList.remove('open'); // 3.2.0：使用者選單同收
}

function initMenu() {
  const fab = document.getElementById('menu-fab');
  const overlay = document.getElementById('menu-overlay');
  fab?.addEventListener('click', () => {
    overlay.classList.toggle('open');
    document.querySelector('.menu')?.classList.toggle('open');
  });
  initBackFab();
  overlay?.addEventListener('click', (e) => {
    if (e.target === overlay) closeMenu(); // 點背景收合
  });
  document.querySelectorAll('.menu a').forEach((a) =>
    a.addEventListener('click', closeMenu));
  document.getElementById('drawer-close')?.addEventListener('click', closeMenu); // 4.2.0 抽屜關閉鈕
}

// ---------- back-fab 雙手勢（5.0.4 C 項；5.1.2 換 routeStack 驅動）----------
// 【為什麼要雙手勢】頁內「返回」鈕全數移除後，返回的責任全落在左上角這顆。
//   短按＝回上一頁（routeStack 的上一層，符合「我剛從那邊過來」的心智）；
//   長按＝回主頁（有人其實只想「結束這裡、回首頁」，不想一頁一頁退）。
//   長按與短按互斥：長按計時一到就記下 longPressed，pointerup 只走長按分支。
// 【5.1.2 兩處改動】① 返回不再用 history.back()（改 routeStack ＋ location.replace，
//   缺陷 A 的迴圈就是「返回卻推了 history 紀錄」造成的）；
//   ② 長按回主頁同樣改 location.replace——回首頁不該在使用者歷史裡多留一段。
const LONG_PRESS_MS = 500;

function initBackFab() {
  const backFab = document.getElementById('back-fab');
  if (!backFab) return;
  let timer = null;
  let longPressed = false;

  // 長按＝結束這裡、回首頁：stack 直接清到只剩主頁（宣告「之前的路徑就此作廢」），
  // 否則清完再進子頁時，返回會從被清掉的舊路徑中間開始退。
  const goHome = () => {
    // 已在主頁就什麼都不做：**同一個 hash 不會觸發 hashchange**，
    // 若照樣設 navigatingBack，旗標會留著，害下一次正常換頁被誤判成返回
    // （實測會把主頁那一層直接覆蓋掉，返回從此少一層）。
    if (fullHash() === '#/') return;
    routeStack.length = 0;
    navigatingBack = false;
    backHandler = null;
    location.replace('#/');
  };
  const goBack = () => {
    // 5.1.2 情境返回（缺陷 B）：有註冊 handler 就只呼叫它一次——
    //   練習場／引擎作答中按返回是「結束這場」的語意，不是「退一頁」的語意。
    //   【為什麼不在這裡清掉 handler】使用者可以在確認框按「取消」，那時場次還在，
    //   handler 必須留著，下一鍵才接得上；真的離場時由引擎端 leaveSession／
    //   mountCompletion 清（見各檔註解）。
    if (backHandler) {
      backHandler.fn();
      return;
    }
    const target = routeStack.length > 1
      ? routeStack[routeStack.length - 2].hash
      // stack 只有一層（冷啟動直闖子頁、或已在最底層）→ 退回父層／主頁
      : (PARENT[currentRoute()] || '#/');
    // 同 hash 不觸發 hashchange，這時設旗標只會留下吃不到的旗標（見 goHome 的說明）
    if (target === fullHash()) return;
    navigatingBack = true;
    // 用 replace 而非賦值：賦值會推入新 history entry，下一鍵返回又會退回這裡（缺陷 A）
    location.replace(target);
  };

  const cancel = () => {
    if (timer) { clearTimeout(timer); timer = null; }
  };

  backFab.addEventListener('pointerdown', () => {
    longPressed = false;
    cancel();
    timer = setTimeout(() => { longPressed = true; }, LONG_PRESS_MS);
  });
  // pointercancel（捲動搶走手勢）與 pointerleave 都不算放開，避免半路觸發返回
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) =>
    backFab.addEventListener(ev, cancel));
  backFab.addEventListener('pointerup', () => {
    if (longPressed) { goHome(); return; } // 長按鬆手＝回主頁
    goBack();
  });
  // 鍵盤可及性：Enter／空白等同一次短按（純 pointer 事件時鍵盤使用者按不到）
  backFab.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goBack(); }
  });
}

// ---------- 啟動（app.js 呼叫一次） ----------
export function initRouter() {
  initMenu();
  // 5.1.2：popstate 只**打旗標**不自己 render——hashchange 緊接著會觸發 render，
  //   由 render 讀 popPending 判斷「這次變化來自瀏覽器紀錄」。
  //   （直接在此呼叫 render 會讓同一頁被畫兩次，且 hash 尚未更新、stack 會記錯。）
  //   為什麼需要這個旗標：不能靠「route 是否等於 stack 倒數第二層」猜返回——
  //   日常往返 A → B → A（抽屜點回同一頁）會誤判成返回而吃掉中間那一層，
  //   按返回直接跳回首頁。popstate 是唯一可靠的訊號。
  //   【為什麼判 state 有沒有我們的標記】jsdom 與部分 WebView 在「賦值式」換 hash 時
  //   也會觸發 popstate（實測），不過濾會把「點連結換頁」誤判成返回、
  //   該 push 的變成 pop 而少一層。render 每寫一層就用 replaceState 蓋上
  //   vocabSeq 序號，因此「back/forward 回到某層」時 state 帶著那一層的序號，
  //   可用它判斷這次 pop 落點是不是 stack 裡真的有的層（見 popTargetSeq）。
  window.addEventListener('popstate', (e) => {
    popPending = true;
    const seq = Number(e.state?.vocabSeq);
    popTargetSeq = Number.isFinite(seq) && seq > 0 ? seq : null;
  });
  window.addEventListener('hashchange', render);
  render();

  // 閒置時預熱常用頁面（首次點擊更順；requestIdleCallback 不影響首載）
  const warmup = ['practice', 'lookup', 'unknown'];
  const warm = () => warmup.forEach((name) => PAGE_MODULES[name].load());
  if ('requestIdleCallback' in window) requestIdleCallback(warm, { timeout: 4000 });
  else setTimeout(warm, 3000);
}
