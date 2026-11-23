// ============================================================
// 6.3.3 8-7 內建英文鍵盤（手機端）——本機候選元件
// 裁決：手機端啟用網站內建特殊鍵盤，避免輸入法自動顯示。
// 決策（使用者 2026-10-23 裁示）：QWERTY 佈局；片語／中譯英共用；螢幕閱讀器相容。
//
// 接入方式：按鍵 onclick 對目標 input dispatch 標準 KeyboardEvent
// （key=字母／Backspace／空格／Enter），讓既有 keydown handler
// （逐字母鎖定等）完全共用，零重複邏輯。
// 觸控為主要輸入時預設展開；滑鼠／精細指標裝置預設收起，所有裝置都可手動切換。
// aria-label 供螢幕閱讀器。
// ============================================================
import { el } from '../core/ui.js';

const ROWS = [
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
  ['shift-placeholder', 'z', 'x', 'c', 'v', 'b', 'n', 'm', 'backspace'],
];
const EXTRA = ['space', 'enter'];

/**
 * 能力探測：只用 Media Queries 判斷「主要輸入」，
 * 不把 `ontouchstart` 當唯一依據——混合裝置（觸控＋滑鼠）兩者都存在，
 * 但主要指標可能是滑鼠。pointer: coarse 代表主要指標是觸控。
 */
function mq(query) {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
    return window.matchMedia(query);
  } catch {
    return null;
  }
}

export function detectInputProfile() {
  const m = mq('(pointer: coarse)');
  const hasPointerQuery = !!m;
  const coarsePrimary = !!mq('(pointer: coarse)')?.matches;
  const finePrimary = !!mq('(pointer: fine)')?.matches;
  const anyCoarse = !!mq('(any-pointer: coarse)')?.matches;
  const anyFine = !!mq('(any-pointer: fine)')?.matches;
  const landscape = !!mq('(orientation: landscape)')?.matches;
  const portrait = !!mq('(orientation: portrait)')?.matches;
  const maxTouchPoints = (typeof navigator !== 'undefined' && (navigator.maxTouchPoints || 0)) || 0;
  return { hasPointerQuery, coarsePrimary, finePrimary, anyCoarse, anyFine, landscape, portrait, maxTouchPoints };
}

/** 相容舊介面：是否具觸控能力（不代表觸控是主要輸入）。 */
export function isTouchDevice() {
  const p = detectInputProfile();
  return p.coarsePrimary || p.anyCoarse || p.maxTouchPoints > 0;
}

/**
 * 預設是否展開內建鍵盤（已核准規則）：
 * - 主要指標為觸控（pointer: coarse）→ 一律預設展開，與橫豎方向無關。
 * - 主要指標為精細（pointer: fine，含觸控筆電的滑鼠／觸控板）→ 只有同時為橫屏
 *   才預設收起；直屏（portrait）預設展開。
 * - 其他／未知能力（無法判定主要指標或方向）→ 預設展開，確保仍可輸入。
 * 判斷只取「主要指標」，不把 any-pointer: coarse 當依據：觸控筆電即使有觸控，
 * 主要輸入仍是滑鼠時就看方向；平板即使接了觸控筆（any-pointer: fine）也仍以觸控為主。
 * 所有裝置都保留手動切換。
 */
export function defaultKeyboardExpanded(profile = detectInputProfile()) {
  if (profile.coarsePrimary) return true; // 觸控為主要輸入：永遠預設顯示
  if (profile.finePrimary) return profile.landscape !== true; // 精細指標：只有橫屏才收起
  return true; // 其他／未知能力：預設可輸入（展開）
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

/**
 * 可收合的內建鍵盤：多一個切換鈕，所有裝置都能展開／收起。
 * options.expanded：布林＝沿用上一個畫面的手動選擇；null／undefined＝依裝置預設。
 * options.onToggle(expanded)：使用者手動切換時回呼，呼叫端可在換題之間保留選擇。
 * 回傳 { root, keyboard, toggle, isExpanded, setExpanded, destroy }。
 *
 * 可及性：切換鈕有 aria-expanded／aria-controls，鍵盤隱藏時用 hidden
 * （不可聚焦、螢幕閱讀器不會讀到）。收起時不搶焦點，按鈕焦點留在切換鈕。
 */
export function mountSpellKeyboard(target, options = {}) {
  const profile = detectInputProfile();
  const touchCapable = profile.anyCoarse || profile.maxTouchPoints > 0;
  const hasPref = typeof options.expanded === 'boolean';
  let manual = hasPref ? options.expanded : null; // null＝跟隨裝置預設，不因換題／旋轉被覆寫
  let expanded = hasPref ? options.expanded : defaultKeyboardExpanded(profile);

  const panel = el('<div class="spell-kbd-panel"></div>');
  const toggle = el('<button type="button" class="btn spell-kbd-toggle"></button>');
  const keyboard = buildSpellKeyboard(target);
  keyboard.id = 'spell-kbd';
  toggle.setAttribute('aria-controls', 'spell-kbd');
  panel.append(toggle, keyboard);

  /**
   * 同步畫面與輸入模式。
   * 展開＋觸控裝置：readonly／inputmode=none，避免系統輸入法自動彈出。
   * 收起：移除 readonly，觸控裝置仍可叫出系統鍵盤作答（收起不造成無法作答）。
   */
  const sync = (notify = false) => {
    keyboard.hidden = !expanded;
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.textContent = expanded ? '收起內建鍵盤' : '顯示內建鍵盤';
    if (expanded && touchCapable) {
      target.setAttribute('readonly', '');
      target.setAttribute('inputmode', 'none');
    } else {
      target.removeAttribute('readonly');
      target.setAttribute('inputmode', 'text');
    }
    if (notify && typeof options.onToggle === 'function') options.onToggle(expanded);
  };

  toggle.addEventListener('click', (event) => {
    expanded = !expanded;
    manual = expanded;
    sync(true);
    // 滑鼠／觸控切換後把焦點交回輸入框，實體鍵盤可立即繼續打字；
    // 鍵盤啟動（Enter／Space，detail=0）則保留焦點在切換鈕，維持按鍵操作與可及性。
    if (event.detail > 0) target.focus();
  });

  // 無手動選擇時才跟隨能力／方向變化（例如接上滑鼠、橫豎旋轉）；
  // 一旦使用者手動切換過，manual 即固定，旋轉或換題都不覆寫。
  const mqls = [];
  for (const query of [
    '(pointer: coarse)', '(pointer: fine)',
    '(orientation: landscape)', '(orientation: portrait)',
    '(any-pointer: coarse)', '(any-pointer: fine)',
  ]) {
    const m = mq(query);
    if (m) mqls.push(m);
  }
  const onDeviceChange = () => {
    if (manual !== null) return; // 手動選擇優先
    expanded = defaultKeyboardExpanded(detectInputProfile());
    sync(false);
  };
  for (const m of mqls) m.addEventListener?.('change', onDeviceChange);

  let destroyed = false;
  const dispose = () => {
    if (destroyed) return;
    destroyed = true;
    for (const m of mqls) m.removeEventListener?.('change', onDeviceChange);
    if (typeof window !== 'undefined') window.removeEventListener('hashchange', onLeave);
  };
  // 離場（路由 hash 改變）時移除全域監聽，避免殘留。
  function onLeave() { dispose(); }
  if (typeof window !== 'undefined') window.addEventListener('hashchange', onLeave);

  sync(false);

  return {
    root: panel,
    keyboard,
    toggle,
    touchCapable,
    isExpanded: () => expanded,
    setExpanded: (next) => { expanded = !!next; manual = expanded; sync(true); },
    destroy: dispose,
  };
}
