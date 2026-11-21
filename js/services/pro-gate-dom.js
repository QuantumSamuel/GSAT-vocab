// ============================================================
// 6.3.0 Pro 閘 DOM 版（學習站頁面接線用）
// 包裝 pro-gate.js 的純函式判定＋「正在開發中」卡，提供掛進 main 的 helper。
// 與 pro-gate.js 分離：純邏輯檔保持零 DOM（可 node 直測），
// 本檔才依賴 ui.js 的 el（瀏覽器／jsdom 環境）。
// ============================================================
import { el } from '../core/ui.js';
import { gateCardHtml } from './pro-gate.js';

/**
 * 把「正在開發中」閘卡（含重新檢查鈕）掛進 main。
 * retry：回呼，重新觸發頁面 render（各頁面自己提供）。
 * 回傳掛上的 card 節點。
 */
export function mountProGateCard(main, featureId, retry, extraNote = '') {
  const card = el(gateCardHtml(featureId, extraNote));
  const retryBtn = el('<button class="btn" type="button">重新檢查</button>');
  retryBtn.addEventListener('click', retry);
  card.append(retryBtn);
  main.replaceChildren(card);
  return card;
}