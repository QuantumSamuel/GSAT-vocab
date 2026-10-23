// ============================================================
// 6.3.3 8-7 內建英文鍵盤（手機端）——本機候選元件
// 裁決：手機端啟用網站內建特殊鍵盤，避免輸入法自動顯示。
// 決策（使用者 2026-10-23 裁示）：QWERTY 佈局；片語／中譯英共用；螢幕閱讀器相容。
//
// 接入方式：按鍵 onclick 對目標 input dispatch 標準 KeyboardEvent
// （key=字母／Backspace／空格／Enter），讓既有 keydown handler
// （逐字母鎖定等）完全共用，零重複邏輯。
// 觸控裝置才顯示（避免破壞桌面）；aria-label 供螢幕閱讀器。
// ============================================================
import { el } from '../core/ui.js';

const ROWS = [
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
  ['shift-placeholder', 'z', 'x', 'c', 'v', 'b', 'n', 'm', 'backspace'],
];
const EXTRA = ['space', 'enter'];

export function isTouchDevice() {
  return typeof window !== 'undefined' && ('ontouchstart' in window || (navigator?.maxTouchPoints || 0) > 0);
}

/**
 * 掛載內建鍵盤到 container。
 * target：接收 KeyboardEvent 的 input（既有 keydown handler 消費）。
 * options.onKey：額外回呼（可選；如需要同步 UI 狀態）。
 * 回傳鍵盤根節點（呼叫端決定要不要掛）。
 */
export function buildSpellKeyboard(target, options = {}) {
  const { onKey } = options;
  const root = el('<div class="spell-kbd" role="group" aria-label="內建英文鍵盤"></div>');

  const press = (key, label, extraClass = '') => {
    const btn = el(`<button type="button" class="spell-kbd-key ${extraClass}" aria-label="${label}">${label}</button>`);
    btn.addEventListener('click', () => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      target.focus();
      if (typeof onKey === 'function') onKey(key);
    });
    return btn;
  };

  for (const row of ROWS) {
    const rowEl = el('<div class="spell-kbd-row"></div>');
    for (const k of row) {
      if (k === 'shift-placeholder') continue; // QWERTY 大小寫：單一字母鍵即可（拼寫輸入皆小寫）
      if (k === 'backspace') {
        rowEl.append(press('Backspace', '退格', 'spell-kbd-key--wide'));
      } else {
        rowEl.append(press(k, k.toUpperCase()));
      }
    }
    root.append(rowEl);
  }

  // 空格（片語詞間）與換行（完成後下一題）——中譯英共用同一鍵盤時空格必須在
  const extraRow = el('<div class="spell-kbd-row"></div>');
  extraRow.append(press(' ', '空格', 'spell-kbd-key--space'));
  extraRow.append(press('Enter', 'Enter', 'spell-kbd-key--wide'));
  root.append(extraRow);

  return root;
}