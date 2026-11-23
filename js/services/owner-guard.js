// ============================================================
// UI 帳戶守衛（6.2.0）：頁面層的 owner＋generation 捕捉與中央失效
//
// 資料層（store.js／reading-store.js）在「呼叫當下」捕捉 owner，交易內再守衛；
// 但舊畫面不會自己知道 owner 已換，所以頁面層必須補兩件事：
//   ① 每次渲染／破壞性操作開始時用 capturePage() 捕捉 owner＋generation，
//      await 之後、DOM 寫入或真正提交前檢查 assertActive()／active()。
//   ② 真正 owner 改變（含登出 guest、A→B、A→B→A）時由 app.js 呼叫
//      resetOwnerState()：遞增 uiEpoch、清掉已註冊的帳戶綁定模組 session、
//      取消已開對話框（resolve false，舊確認流程自然走「不提交」分支）。
//
// 【同 owner token 續期】
//   auth.js 的 ensureFreshToken 走 preserveGeneration，不 emit auth:changed，
//   因此 app.js 不會清畫面、uiEpoch 不變，capturePage() 也保持有效——
//   在途學習不會被普通續期打斷。跨分頁的同 owner storage event 是
//   「同帳戶新 session 邊界」：owner-context generation 會變、舊 capture 失效，
//   但 app.js 依 owner ID 判斷「沒換人」，「不清畫面」；資料層守衛仍負責安全。
//
// 【相依方向】本檔只依賴零相依的 owner-context；不 import auth/router，
//   避免 auth → sync → store → auth 或頁面 → router → 頁面等循環。
// ============================================================
import { captureOwner, getOwnerId, getOwnerGeneration } from './owner-context.js';

const resetHooks = new Set();
let uiEpoch = 0;

export function getUiEpoch() {
  return uiEpoch;
}

/** 註冊「owner 改變時要清掉的帳戶綁定模組 session」回呼。回傳取消函式。 */
export function registerOwnerReset(fn) {
  if (typeof fn === 'function') resetHooks.add(fn);
  return () => resetHooks.delete(fn);
}

/** 中央失效：遞增 uiEpoch、清已註冊的模組 session。 */
export function resetOwnerState() {
  uiEpoch++;
  for (const fn of [...resetHooks]) {
    try { fn(); } catch (err) { console.warn('清除帳戶 session 失敗：', err); }
  }
}

/**
 * 取消所有已開的 .dlg-overlay。
 * 走 cancel 按鈕的 click（openDialog 的 overlay click 監聽會 resolve(false)），
 * 讓舊流程的 `await openDialog(...)` 正常回到「取消」分支；若結構缺 cancel 才直接移除。
 */
export function cancelOpenDialogs() {
  for (const ov of document.querySelectorAll('.dlg-overlay')) {
    const cancel = ov.querySelector('[data-r="0"]');
    if (cancel) { try { cancel.click(); } catch { /* 異常不阻擋繼續清理 */ } }
    else ov.remove();
  }
}

/**
 * 頁面／操作開始時的 owner 捕捉。assertActive() 會丟 ACCOUNT_CHANGED，
 * active() 是同一檢查的布林版本（await 後用 active() 就不必寫一堆 try/catch）。
 */
export function capturePage() {
  const base = captureOwner();
  const epoch = uiEpoch;
  return {
    ownerId: base.ownerId,
    generation: base.generation,
    uiEpoch: epoch,
    assertActive() {
      base.assertActive();
      if (getUiEpoch() !== epoch) {
        const err = new Error('ACCOUNT_CHANGED');
        err.code = 'ACCOUNT_CHANGED';
        throw err;
      }
      return true;
    },
    active() {
      try { return this.assertActive(); } catch { return false; }
    },
  };
}

export { captureOwner, getOwnerId, getOwnerGeneration };