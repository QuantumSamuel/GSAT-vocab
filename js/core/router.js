// ============================================================
// 路由核心（3.0.3 分層重構）：頁面註冊表＋生命週期＋chrome＋過場動畫
// 頁面模組「懶載入」：首次造訪才下載該頁程式（效能預算：首頁只載首頁需要的）
// 新頁面接法：在 PAGE_MODULES 加一列 ＋ index.html 選單加一項，完成
// ============================================================
import { el, escapeHtml, ICONS } from './ui.js';
import { emit } from './eventbus.js';
import { canManage } from './entitlements.js';
import { isLoggedIn, authReady } from '../services/auth.js';

// ---------- 頁面註冊表 ----------
// load：動態載入器（懶載入）；render：該模組的渲染函式名；label：頂部頁面名
const PAGE_MODULES = {
  '':        { label: '',       load: () => import('../pages/home.js'),     render: 'renderHome' },
  practice:  { label: '練習',   load: () => import('../pages/practice.js'), render: 'renderPractice' },
  'practice/matching': { label: '配對',  load: () => import('../practice/matching.js'), render: 'renderMatching' },
  'practice/selection': { label: '選擇', load: () => import('../practice/selection.js'), render: 'renderSelection' },
  'practice/spelling': { label: '拼寫',  load: () => import('../practice/spelling.js'), render: 'renderSpelling' },
  exam:      { label: '模擬考', load: () => import('../pages/exam.js'),         render: 'renderExam' },
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

export function getPageLabel(hash) {
  return PAGE_MODULES[hash]?.label ?? '';
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
  // 4.1.1：子頁（配對／選擇／拼寫）返回其父層「練習」，其餘頁維持回首頁
  document.getElementById('back-fab')?.addEventListener('click', () => {
    location.hash = PARENT[currentRoute()] || '#/';
  });
  overlay?.addEventListener('click', (e) => {
    if (e.target === overlay) closeMenu(); // 點背景收合
  });
  document.querySelectorAll('.menu a').forEach((a) =>
    a.addEventListener('click', closeMenu));
  document.getElementById('drawer-close')?.addEventListener('click', closeMenu); // 4.2.0 抽屜關閉鈕
}

// ---------- 啟動（app.js 呼叫一次） ----------
export function initRouter() {
  initMenu();
  window.addEventListener('hashchange', render);
  render();

  // 閒置時預熱常用頁面（首次點擊更順；requestIdleCallback 不影響首載）
  const warmup = ['practice', 'lookup', 'unknown'];
  const warm = () => warmup.forEach((name) => PAGE_MODULES[name].load());
  if ('requestIdleCallback' in window) requestIdleCallback(warm, { timeout: 4000 });
  else setTimeout(warm, 3000);
}
