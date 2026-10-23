// ============================================================
// 新手教程（5.1.0 方案 A：首次進站步驟卡）
// 全螢幕遮罩＋每步一屏的引導卡：3~5 步，「跳過」常駐，最後一步直接進第一次學習。
//
// 為什麼放在 core 而不是 pages：
//   它不是頁面（沒有路由、不寫進目錄），而是疊在 App 上的一層 UI；app.js 啟動時與
//   設置頁的「重看」入口共用同一份，所以放 core/ui.js 旁邊。
// 為什麼用 localStorage 旗標而不是問後端：教程是裝置層的一次性提示，不是帳號屬性；
//   帳號同步只搬資料，搬「看過教程」沒有好處，反過來還會讓換裝置的使用者被重複轟炸。
//
// 紅線：動畫只用 transform/opacity 且有 prefers-reduced-motion 專屬規則；零 emoji（示意圖是
//   內聯 SVG）；文案全部繁中。
// ============================================================
import { el, escapeHtml } from './ui.js';

/** 看過的旗標鍵。值寫 '1'：存在即可，不必記何時看過 */
const KEY_SEEN = 'vocab2_onboarding_seen';

// ---------- 步驟內容（5 步；措辭可調，id 供測試與日後埋點定位） ----------
// 每步＝標題＋說明＋示意圖（內聯 SVG）。文案刻意短：步驟卡是「給第一次來的人看一次」的東西，
// 寫太長使用者會直接跳過，寫太短又記不住本站在做什麼。
const STEPS = [
  {
    id: 'welcome',
    title: '歡迎來到學測英文單字',
    // 【為什麼不寫「離線可用」】4.0.3 起離線功能已關閉（sw.js 於 activate 解除註冊並清空
    //   所有快取，app.js 每次啟動再清一次）。教程是給第一次來的人看的事實陳述，
    //   宣稱一個不存在的特性會讓人以為斷網也能用，之後才發現不是——那是教程不該做的事。
    //   這裡改講真正成立的兩件事：資料在本機、不必註冊就能開始。
    desc: '這是一個學測英文單字網站：7,213 個單字（108 課綱 Lv1–6 ＋舊制補充詞），'
      + '外加大考中心歷屆考古題。字庫與題目都在你的裝置上，不必註冊就能直接開始。',
    art: `<svg viewBox="0 0 120 84" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="10" y="14" width="44" height="56" rx="5"/>
            <path d="M20 30h24M20 40h18"/>
            <rect x="66" y="14" width="44" height="56" rx="5"/>
            <path d="M76 30h24M76 40h18"/>
            <path d="M88 56l8 8 16-18"/>
          </svg>`,
  },
  {
    id: 'study',
    title: '學習：像翻卡一樣記單字',
    desc: '首頁的「學習」會隨機抽單字卡。點卡片翻面看另一面，喇叭鈕朗讀；'
      + '不熟的字按「加入複習計劃」（登入後可用），它就會進入複習排程。',
    art: `<svg viewBox="0 0 120 84" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="34" y="14" width="52" height="58" rx="6"/>
            <path d="M46 34h28M46 44h20M46 58h16"/>
            <path d="M24 62c-6 0-10 4-10 9M96 62c6 0 10 4 10 9"/>
          </svg>`,
  },
  {
    id: 'review',
    title: '複習排程：答錯的字會回來找你',
    desc: '答對的字依 1、3、7、14 天往後推；答錯的字會重新排進今天。'
      + '每天回首頁完成「複習」就有進度，不用自己記哪幾個字還沒背。',
    art: `<svg viewBox="0 0 120 84" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="16" y="18" width="88" height="56" rx="6"/>
            <path d="M16 34h88M40 12v12M80 12v12"/>
            <path d="M34 50l8 8 14-16"/>
            <path d="M68 50h18M68 60h12"/>
          </svg>`,
  },
  {
    id: 'lookup',
    title: '查詢與單詞本',
    desc: '查詢頁可以查單字的釋義與詞性；查過的字會列在單詞本頁的「本週查過的字」，'
      + '可一鍵收進單詞本單獨練習。查不到或暫時不會的字，先收進「不會單字」，會自動排進複習。',
    art: `<svg viewBox="0 0 120 84" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="52" cy="38" r="22"/>
            <path d="M68 54l16 16"/>
            <path d="M42 38h20M42 30h20"/>
          </svg>`,
  },
  {
    id: 'done',
    title: '準備好了，開始第一次學習',
    desc: '接下來每一步都有說明：抽卡、複習、查詢都有專屬頁面，卡住了隨時回來看這份導引。',
    art: `<svg viewBox="0 0 120 84" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M60 12l12 24 26 4-19 18 5 26-24-13-24 13 5-26-19-18 26-4z"/>
          </svg>`,
  },
];

/** 步驟數（匯出給測試與頁面顯示用） */
export const ONBOARDING_STEPS = STEPS;

/** 使用者是否已看過教程（旗標存在即算看過） */
export function hasSeenOnboarding() {
  try {
    return localStorage.getItem(KEY_SEEN) !== null;
  } catch {
    return true; // 隱私模式等情境讀不到 → 視為看過，不要擋住 App
  }
}

/** 寫旗標（看完或跳過都寫；失敗不影響 App） */
function markSeen() {
  try {
    localStorage.setItem(KEY_SEEN, '1');
  } catch { /* 寫不進就當沒寫：最多下次再看到一次，不該因此卡住 */ }
}

/** 清旗標（設置頁「重看新手教程」用；清完由呼叫端立刻重播） */
export function resetOnboardingFlag() {
  try {
    localStorage.removeItem(KEY_SEEN);
  } catch { /* 同上 */ }
}

// 同一時間只允許一份教程（重看時已在進行中 → 直接回傳同一場，不再起新的一份）
let active = null;

/**
 * 啟動步驟卡。
 * 回傳 Promise，流程結束（完成或跳過）時 resolve；app.js 不 await（fire-and-forget）。
 * opts.onFinish(done)：流程結束後呼叫，done=true 表示走完最後一步、false 表示中途跳過。
 */
export function startOnboarding(opts = {}) {
  // 已在進行中 → 原樣回傳同一場。
  // 【為什麼不是「收掉舊的再開新的」】舊版是 close() 舊的然後回舊的 Promise，結果是
  //   連按兩次「重看」時第二次什麼都不做，畫面上一片空白，旗標卻已被寫成「看過」
  //   （池 B qa_510_wiring C4 抓到）。使用者按了兩次什麼都沒看到＝功能壞掉。
  // 「已經在看」不是一種錯誤狀態，把焦點拉回來就是正確回應。
  if (active) {
    active.refocus();
    return active.promise;
  }
  let idx = 0;
  let resolveDone;
  const promise = new Promise((res) => { resolveDone = res; });

  const ov = el(`<div id="ob-overlay" role="dialog" aria-modal="true" aria-label="新手教程"></div>`);
  document.body.appendChild(ov);
  // 開啟時記下觸發者，結束後焦點回到原處（可及性；比照 ui.js openDialog 的做法）
  const prevFocus = document.activeElement;
  // 被焦點困住「拉回來」的那些節點：頁面自己 focus() 的目標。
  // 結束時還給「最後一個還活著的」—— 教程期間它被壓下來了，還回去才算還原使用者原本的意圖
  // （冷啟動落在查詢頁時，那個節點就是 #lookup-input）。
  // 為什麼是堆疊而不是單一變數：被蓋住的目標可能先後出現多個，而其中一些會在教程還沒結束前
  //   就被移除（openDialog 的確定鈕被點掉後整個 .dlg-overlay 就不存在了）。
  //   存單一變數的話，那個已消失的按鈕會蓋掉真正的目標，結束時焦點掉回 body。
  //   逐筆往回找第一個 isConnected 的，語意是「使用者最後真正想操作、且還活著的節點」。
  const escapees = [];

  const finish = (completed) => {
    markSeen();
    offFocusTrap();
    ov.remove();
    // 由最後往前找第一個還連著文件的（見 escapees 的說明），找不到才退回開啟前的節點
    const back = escapees.findLast((n) => n?.isConnected) || prevFocus;
    if (back?.isConnected) back.focus(); // 鍵盤操作不斷鏈
    active = null;
    resolveDone(completed);
    opts.onFinish?.(completed);
  };

  const refocus = () => { ov.querySelector('#ob-next')?.focus(); };

  const paint = () => {
    const s = STEPS[idx];
    const last = idx === STEPS.length - 1;
    ov.innerHTML = `
      <div class="ob-card">
        <div class="ob-art" aria-hidden="true">${s.art}</div>
        <h2 class="ob-title">${escapeHtml(s.title)}</h2>
        <p class="ob-desc">${escapeHtml(s.desc)}</p>
        <ol class="ob-dots" aria-label="進度">
          ${STEPS.map((x, i) => `<li class="ob-dot${i === idx ? ' on' : ''}" data-i="${i}"></li>`).join('')}
        </ol>
        <div class="ob-actions">
          <button type="button" class="btn subtle" id="ob-skip">跳過</button>
          <span class="ob-spacer"></span>
          ${idx > 0 ? '<button type="button" class="btn" id="ob-prev">上一步</button>' : ''}
          <button type="button" class="btn primary" id="ob-next">${last ? '開始第一次學習' : '下一步'}</button>
        </div>
      </div>`;
    // 每步重繪後把焦點放到主要動作鈕：鍵盤／讀屏使用者不會停在已被換掉的節點上
    ov.querySelector('#ob-next')?.focus();
  };

  ov.addEventListener('click', (e) => {
    const dot = e.target.closest('.ob-dot');
    if (dot) { idx = Number(dot.dataset.i); paint(); return; }
    if (e.target.closest('#ob-skip')) { finish(false); return; }
    if (e.target.closest('#ob-prev')) { idx = Math.max(0, idx - 1); paint(); return; }
    if (e.target.closest('#ob-next')) {
      if (idx === STEPS.length - 1) {
        finish(true);
        // 最後一步＝導引的實際任務：直接把人送進第一次學習（學習頁抽卡）
        location.hash = '#/study';
        return;
      }
      idx += 1;
      paint();
    }
  });
  // 鍵盤：Enter 或右箭號＝下一步、← 上一步、Esc 跳過（滑動與點擊之外的第三種操作方式）
  ov.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); finish(false); return; }
    if (e.key === 'ArrowRight') { e.stopPropagation(); ov.querySelector('#ob-next')?.click(); }
    if (e.key === 'ArrowLeft') { e.stopPropagation(); ov.querySelector('#ob-prev')?.click(); }
  });

  // ---------- 焦點困住（focus trap）----------
  // 遮罩只擋視覺不擋 DOM，焦點有四種方式流出去，全靠下面三道補網撐住：
  //   ① 頁面 render 尾端的 focus()（查詢頁 lookup.js:282，冷啟動落在 #/lookup 時它在
  //      paint 之後才跑，池 B C3）／使用者自己點遮罩外的元素 → focusin 攔截器
  //   ② 持有焦點的節點被移除（不觸發 focusin／focusout，池 B C2c ④）→ MutationObserver
  //   ③ 使用者點遮罩暗色背景（只發 focusout，池 B C2c ⑤）→ blur 補網
  // 不用 `inert`（全站支援不完整，jsdom 連屬性都不認）。API 全走 window.：jsdom 只掛了它。
  //
  // 【放行判準】只放行「使用者看得見的自成組模態」＝role=dialog/alertdialog 且所在層 z 高於遮罩。
  //   全站符合的只有 app.js:24 的 #sync-dialog（z=210）；openDialog 是 z=150 < 遮罩，使用者
  //   看不到它。抽屜 .menu 有 z=210 但不是對話框，刻意不放行：closeMenu()（router.js:216）
  //   只切 class，連結還留著，焦點卡在收合的抽屜裡就又收不到按鍵。
  const gcs = (n) => window.getComputedStyle(n);
  const Z_AUTO = Number.POSITIVE_INFINITY; // position:fixed 的 auto z 在同層堆疊中視為最高
  const DIALOG_ROLE = /^(dialog|alertdialog)$/;
  const coveredZ = Number(gcs(ov).zIndex) || 0;
  /** 焦點目標所在的覆蓋層 z（往上找有定位的祖先）；沒有＝頁面內容（z=0，一定被蓋住） */
  const layerZOf = (node) => {
    for (let n = node; n && n !== document.body; n = n.parentElement) {
      const cs = gcs(n);
      if (cs.position === 'fixed' || cs.position === 'absolute' || cs.position === 'sticky') {
        const z = cs.zIndex;
        return z && z !== 'auto' ? Number(z) : Z_AUTO; // 有定位但 z auto → 排在別的層之上
      }
    }
    return 0;
  };
  const isOpenDialog = (node) => {
    for (let n = node; n && n !== document.body; n = n.parentElement) {
      if (DIALOG_ROLE.test(n.getAttribute?.('role') || '')) return layerZOf(n) > coveredZ;
    }
    return false;
  };
  // body 也算「掉出去」：焦點在 body 時按鍵事件不會冒到遮罩上，Esc／方向鍵同樣失效
  const shouldTrap = (node) => !!node && !ov.contains(node) && !isOpenDialog(node);
  const refocusIfLost = () => {
    if (active && shouldTrap(document.activeElement)) refocus();
  };
  // blur 補網：判準是「blur 之後焦點落在哪」而非「被 blur 的是誰」（點遮罩背景時被 blur 的
  //   就是遮罩內的主鈕）。複查刻意用微任務而非計時器：同樣能等到各環境把焦點交給 body
  //   （jsdom 的 blur() 是派發完才換，實測），但不排常駐計時器 —— 池 B C6 守著那條紅線。
  let pending = false;
  const onFocusIn = (e) => {
    if (!shouldTrap(e.target)) return;     // 遮罩內或對話框自己處理
    escapees.push(e.target);                // 記住被搶到哪去，結束時還回去（找最後活著的）
    refocus();                              // 立刻拉回主要動作鈕
  };
  const onBlur = () => {
    if (!active || pending) return;         // 同一輪只排一次
    pending = true;
    window.queueMicrotask(() => { pending = false; refocusIfLost(); });
  };
  // MutationObserver 補網：持有焦點的節點被移除時沒有任何事件，靠 DOM 變動複查。
  // 結束時三道都要卸，否則會跟「焦點還原」打架。
  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('blur', onBlur, true);
  const mo = new window.MutationObserver(refocusIfLost);
  mo.observe(document.body, { childList: true, subtree: true });
  // hashchange 補網（池 B C2c ④ 複驗）：closeMenu() 收合抽屜只切 class，連結留在 DOM、
  //   焦點停在它上面且不會再觸發 focusin——換頁（路由變更）時主動複查一次。
  const onHashChange = () => refocusIfLost();
  window.addEventListener('hashchange', onHashChange);
  const offFocusTrap = () => {
    document.removeEventListener('focusin', onFocusIn, true);
    document.removeEventListener('blur', onBlur, true);
    window.removeEventListener('hashchange', onHashChange);
    mo.disconnect();
  };

  paint();
  // 冷啟動補網（池 B C3）：落在會自己 focus() 的頁面（如查詢頁）時，頁面 render 尾端的
  //   focus() 在教程啟動之前就跑掉了——啟動當下先檢查一次當前焦點，掉在外面就拉回。
  refocusIfLost();
  active = { close: () => finish(false), refocus, promise };
  return promise;
}

/**
 * 啟動接線（app.js 用）：旗標不存在才顯示。
 * 「顯示一次」的判斷全部在這裡，呼叫端不必自己碰 localStorage。
 */
export function startOnboardingIfFirstVisit(opts = {}) {
  if (hasSeenOnboarding()) return null;
  return startOnboarding(opts);
}

/**
 * 設置頁「重看新手教程」：清旗標＋立刻重播。
 * 刻意不重新載入頁面——使用者是在設置頁按的，重播完留在原頁最不打斷。
 */
export function replayOnboarding() {
  resetOnboardingFlag();
  return startOnboarding();
}
