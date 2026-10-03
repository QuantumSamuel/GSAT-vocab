// ============================================================
// 學測英文單字 3.0 — 啟動入口（3.0.3 分層重構）
// 本檔只負責「啟動與全域接線」：
//   路由/頁面 → core/router.js（懶載入）    事件匯流排 → core/eventbus.js
//   UI 工具  → core/ui.js                  權益閘    → core/entitlements.js
//   資料層   → services/*（頁面不得直接觸碰瀏覽器儲存）
// ============================================================
import { ICONS, el, escapeHtml, initSpeakDelegation, toast } from './core/ui.js';
import { emit, on } from './core/eventbus.js';
import { initRouter } from './core/router.js';
import { applyAll, migrateOldTheme, getAutoSync, watchSystemMode } from './services/settings.js';
import { getUser, signOut, initAuth } from './services/auth.js';
import { startHeartbeat, stopHeartbeat } from './services/heartbeat.js';
import { cancelPendingUpload, isSyncing, isSyncLocked, notifyStoreChanged, resetSyncState, resolveConflict, runAutoSyncCycle } from './services/sync.js';
import { fillPendingWordbooks, getWordbooks } from './services/store.js';
import { loadWords } from './services/vocab.js';
import { canManage } from './core/entitlements.js';

// ---------- 自動同步衝突對話框（3.1.1）：本機與雲端互有多少時詢問 ----------
function showSyncConflictDialog({ local, cloud }) {
  document.getElementById('sync-dialog')?.remove();
  document.body.appendChild(el(`
    <div id="sync-dialog" role="alertdialog">
      <div class="sd-title">雲端與本機資料不一致</div>
      <div class="sd-detail">本機：複習計劃 ${local.m} 字、單詞本 ${local.b} 本｜雲端：${cloud.m} 字、${cloud.b} 本。要如何處理？</div>
      <div class="sd-actions">
        <button class="btn primary" data-choice="overwrite">本機覆蓋雲端</button>
        <button class="btn" data-choice="merge">合併兩邊</button>
        <button class="btn subtle" data-choice="later">稍後</button>
      </div>
    </div>`));
  const dialog = document.getElementById('sync-dialog');
  dialog.querySelectorAll('[data-choice]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      dialog.querySelector('.sd-detail').textContent = '處理中…';
      try {
        await resolveConflict(btn.dataset.choice);
      } catch (err) {
        console.warn('衝突處理失敗：', err.message);
      }
      dialog.remove();
    });
  });
}

// ---------- 入口 ----------
if (location.protocol === 'file:') {
  // 直接點兩下 index.html 開啟時，瀏覽器會擋下 fetch，改顯示操作指引
  document.getElementById('app').replaceChildren(el(`
    <section class="card error">
      <h2><span class="card-h2-icon">${ICONS.warn}</span>請不要直接點兩下 index.html 開啟</h2>
      <p>請回到資料夾執行 <strong>啟動.bat</strong>，它會自動啟動本機伺服器並開啟瀏覽器。</p>
    </section>`));
} else {
  migrateOldTheme(); // 舊色調值遷移（2.1.1）
  applyAll();
  watchSystemMode(); // 深色跟隨系統（3.0.1）

  // 全域錯誤可視化（3.0.3 除錯空間）：主動回報到事件匯流排，接監聽即可收集
  window.addEventListener('error', (e) => emit('app:error', String(e.message)));
  window.addEventListener('unhandledrejection', (e) => emit('app:error', String(e.reason)));

  initRouter(); // 路由＋目錄＋過場動畫（頁面懶載入）
  initSpeakDelegation(); // 4.3.0 修復（用戶回報聲音無法播放）：3.0.1 起此接線從未呼叫，所有發音鈕都是死的

  // 帳號系統（3.1.0）：還原登入狀態

  // 使用者選單（3.2.0）：右上 👉 下拉；依登入狀態動態渲染
  // 【關聯註記】只依賴 auth.js 對外介面（getUser/canManage/signOut）與路由，不碰內部狀態
  // 3.3.0：後台入口移入此選單（僅管理員可見）——原先在 ☰ 目錄的 #admin-link 已移除
  const userFab = document.getElementById('user-fab');
  const userMenu = document.getElementById('user-menu');
  const renderUserMenu = () => {
    const user = getUser();
    const items = user
      ? `
        <div class="um-email" title="${escapeHtml(user.email || '')}">${escapeHtml(user.email || '')}</div>
        <a href="#/profile"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5"/></svg><span>個人主頁</span></a>
        <a href="#/account"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="11" r="2"/><path d="M14 9.5h4M14 13.5h4"/><path d="M6 16.5c.6-1.4 1.5-2 2.5-2s1.9.6 2.5 2"/></svg><span>賬戶</span></a>
        <a href="#/stats"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M6 20V10M12 20V4M18 20v-7"/></svg><span>統計</span></a>
        ${canManage() ? `<a href="#/admin"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 12h4m4 0h4"/><circle cx="6" cy="17" r="2.5"/><circle cx="18" cy="17" r="2.5"/><path d="M6 14.5V7a2 2 0 0 1 2-2h1"/><path d="M18 14.5V7a2 2 0 0 0-2-2h-1"/></svg><span>後台管理</span></a>` : ''}
        <button id="um-logout"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 12H4m4-4-4 4 4 4"/><path d="M10 4h8v16h-8"/></svg><span>登出</span></button>`
      : `
        <div class="um-guest">尚未登入</div>
        <a href="#/auth?tab=login"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 12H4m4-4-4 4 4 4"/><path d="M10 4h8v16h-8"/></svg><span>登入</span></a>
        <a href="#/auth?tab=signup"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5"/><path d="M19 8v6m3-3h-6"/></svg><span>註冊</span></a>`;
        // 3.3.1 用戶指示：訪客選單不顯示統計（統計頁本身有註冊牆，直達 URL 仍會看到鎖卡）
    userMenu.innerHTML = items;
    userMenu.querySelector('#um-logout')?.addEventListener('click', async () => {
      closeUserMenu();
      await signOut();
      location.hash = '#/';
    });
  };
  const closeUserMenu = () => {
    userMenu?.classList.remove('open');
    document.getElementById('menu-overlay')?.classList.remove('open');
  };
  userFab?.addEventListener('click', () => {
    renderUserMenu();
    const overlay = document.getElementById('menu-overlay');
    const opening = !userMenu.classList.contains('open');
    userMenu.classList.toggle('open', opening);
    overlay.classList.toggle('open', opening);
  });
  document.getElementById('menu-overlay')?.addEventListener('click', closeUserMenu);
  on('auth:changed', () => { renderUserMenu(); closeUserMenu(); });
  // 3.2.0 改進（用戶指示）：登入/註冊頁隱藏右上使用者按鈕
  on('page:enter', ({ name }) => {
    userFab?.classList.toggle('hidden', name === 'auth');
  });

  // 自動同步（4.2.0）：15 秒 setTimeout 串鏈＋變更去抖上傳
  // 【關聯註記】3.1.1 原為 setInterval(5 分鐘)。改 15 秒後必須用「跑完再排下一次」的
  // 串鏈而非 setInterval：rpc 掛掉或網路慢時 setInterval 會疊輪、把請求堆在瀏覽器裡。
  // 每輪的跳過條件都在鏈內判斷（不取消鏈），確保使用者回到前景即恢復。
  const SYNC_INTERVAL_MS = 15 * 1000;
  let syncTimer = null;
  const stopAutoSync = () => {
    if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
    document.getElementById('sync-dialog')?.remove();
  };

  // 單一入口：所有觸發點（15 秒鏈／登入／回到前景／store:changed 去抖）都走這裡
  const runSyncNow = () => {
    if (!getUser() || !getAutoSync()) return;
    runAutoSyncCycle().catch((err) => console.warn('自動同步失敗：', err.message));
  };

  // 15 秒鏈：只在可執行時真的發輪，否則跳過本輪（畫面關閉／離線／未登入／衝突鎖／忙碌）
  const scheduleNextSync = () => {
    syncTimer = setTimeout(async () => {
      syncTimer = null;
      if (getUser() && getAutoSync()
          && document.visibilityState === 'visible'
          && navigator.onLine
          && !isSyncLocked()
          && !isSyncing()) {
        runSyncNow();
      }
      scheduleNextSync(); // 無論有沒有跑，下一輪照排
    }, SYNC_INTERVAL_MS);
  };

  on('auth:changed', (user) => {
    stopAutoSync();
    cancelPendingUpload(); // 4.3.0 修復（Pool B High）：取消前一帳號的去抖上傳，防跨帳號資料外洩
    resetSyncState(); // 4.2.0 修復（debug sweep High）：換帳號重置 localRev/衝突鎖，否則新帳號第一輪必幽靈衝突
    if (user) {
      // 只看「有沒有登入」決定要不要掛鏈；開關（getAutoSync）交給每輪判斷，
      // 否則使用者中途在設置頁打開自動同步仍要重新登入才會生效
      scheduleNextSync();
      // 登入後先跑一輪（自動加載雲端數據）
      runSyncNow();
    }
  });
  // 回到前景立刻補跑（15 秒鏈在背景時會跳過，前景切回要立刻追上）
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && getUser() && getAutoSync()
        && !isSyncLocked() && !isSyncing()) runSyncNow();
  });
  // 本機資料變更 → sync.js 內部去抖 4 秒後跑一輪（一次 20 題練習的 20 次寫入合併成 1 次上傳）
  on('store:changed', () => notifyStoreChanged());
  on('sync:conflict', showSyncConflictDialog);

  // 使用時間心跳（3.3.0）：登入後每 5 分鐘回報在線／使用分鐘；登出即停
  // 【關聯註記】heartbeat.js 不自行判斷登入，開關完全由 auth:changed 驅動
  on('auth:changed', (user) => {
    stopHeartbeat();
    if (user) startHeartbeat();
  });

  // ---------- 5.0.0 待補單字自動補進（啟動一次，靜默） ----------
  // 背景：匯入後台單詞本時，字庫外的字會被記進單詞本的 pendingWords；
  //   等字庫收錄後，啟動 App 順手把它們補進 wordIds（spec 2.2）。
  // 【效能鐵律】fire-and-forget：整條鏈沒有 await、也不回傳給啟動流程。
  //   兩道零成本閘（5.0.0 池 B 驗證後收緊）：
  //   ① 先只讀 IndexedDB 的單詞本（便宜），沒有任何一本帶非空 pendingWords 就直接返回
  //      ——不會為此抓 3.09MB 的 words.json（池 B 啟動流量探針的結論）；
  //   ② fillPendingWordbooks 內部再以字庫複檢，無可補的字不開寫入交易。
  // 放在 initAuth 之前：登入／同步都要讀單詞本，先補好可避免同步把未補的狀態上傳。
  const runPendingFill = () => {
    getWordbooks()
      .then((books) => {
        const hasPending = books.some((b) => Array.isArray(b.pendingWords) && b.pendingWords.length > 0);
        if (!hasPending) return []; // 常見情況：零 fetch、零寫入
        return loadWords().then(() => fillPendingWordbooks());
      })
      .then((filled) => {
        if (!filled || filled.length === 0) return; // 沒有實際補進 → 不擾動使用者
        const total = filled.reduce((a, f) => a + f.count, 0);
        // 多本合併成一句（書名以頓號連接，6 本以上只列前 5 本）
        const names = filled.slice(0, 5).map((f) => `『${f.name}』`).join('、');
        toast(`字庫更新：已自動補進 ${names}${filled.length > 5 ? ` 等 ${filled.length} 本` : ''}共 ${total} 個單字`, 'ok');
      })
      .catch(() => { /* 字庫未載入或待補補進失敗：靜默，不影響啟動 */ });
  };
  runPendingFill();

  // 4.2.0 修復（既有競態）：initRouter 同步首渲染時 profile 尚未載入，
  // 冷載直接落在 #/admin 等權限頁會誤顯「無權限」——initAuth 完成後重渲染當前路由
  initAuth()
    .then(() => import('./core/router.js').then((r) => r.render()))
    .catch(() => {});

  // ---------- Service Worker（4.0.3 關閉：用戶指示——防止整站被保存離線自架） ----------
  // 不再註冊 SW；本機殘留的舊 SW 於啟動時解除註冊，並清空所有舊快取
  //（解除註冊不會自動刪 caches，須明確刪除）。此後 App 一律走網路載入，離線不可用；
  // iOS「加入主畫面」的桌面捷徑不受影響（僅失去離線）。
  if ('serviceWorker' in navigator) {
    (async () => {
      try {
        const regs = await navigator.serviceWorker.getRegistrations();
        for (const r of regs) await r.unregister();
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      } catch { /* 隱私模式等情境下清理失敗不影響使用 */ }
    })();
  }
}
