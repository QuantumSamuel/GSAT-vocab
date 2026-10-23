// ============================================================
// 月曆元件（4.2.0 批次 3 — spec D-3）——首頁「複習月曆」與複習頁「複習管理」
// 原本兩份 inline 實作（review.js 的 renderCalendar 與 renderReviewManage）合併成此一處。
// 純繪製層：格子的日期、狀態（無排程／有排程／今天／選中）與點擊／翻月回呼都在此；
// 「哪些日期有排程、幾個字」由呼叫端算好後用 counts（Map）傳進來。
// ============================================================
import { el, escapeHtml, ICONS } from './ui.js';

const WEEK = ['一', '二', '三', '四', '五', '六', '日'];

/** 本地日期 → YYYY-MM-DD（不經 toISOString，避免時區把日期退一天） */
export function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 今天（本地時區）的日期字串 */
export function todayKey() {
  return dateKey(new Date());
}

/** 月曆顯示的月份（該月 1 號） */
function monthStart(m) {
  return m instanceof Date ? new Date(m.getFullYear(), m.getMonth(), 1) : new Date();
}

/**
 * 掛載月曆。
 * @param {HTMLElement} host          容器（內容會被整個取代）
 * @param {object} opts
 *   month      Date   目前顯示的月份（未給＝本月）
 *   selected   string 選中的日期（YYYY-MM-DD，未給＝不選）
 *   counts     Map<string,number>|object 每日排程字數（0／缺省＝無排程）
 *   onSelect   (key)=>void  點日期
 *   onMonth    (month:Date)=>void 翻月（回傳該月 1 號）
 *   navIds     {prev,next} 翻月鈕 id（給既有頁面的 querySelector 用）
 * @returns {{ setMonth(m:Date):void, setCounts(c):void, setSelected(k):void, destroy():void }}
 */
export function mountCalendar(host, opts = {}) {
  if (!host) throw new Error('mountCalendar：host 必填');
  const state = {
    month: monthStart(opts.month),
    selected: opts.selected || null,
    counts: opts.counts || new Map(),
  };

  const countOf = (key) => {
    const c = state.counts;
    if (c instanceof Map) return c.get(key) || 0;
    return Number(c?.[key]) || 0;
  };

  // 回呼在點擊當下才讀 opts（呼叫端可換掉／不換），避免把當時的閉包釘死
  const paint = () => {
    const y = state.month.getFullYear();
    const mo = state.month.getMonth();
    const tk = todayKey();
    const startOffset = (new Date(y, mo, 1).getDay() + 6) % 7; // 週一為一週之始
    const daysInMonth = new Date(y, mo + 1, 0).getDate();

    let cells = '';
    for (let i = 0; i < startOffset; i++) cells += '<span class="cal-cell empty"></span>';
    for (let d = 1; d <= daysInMonth; d++) {
      const key = `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const n = countOf(key);
      cells += `
        <button class="cal-cell ${n ? 'has' : ''} ${key === tk ? 'today' : ''} ${key === state.selected ? 'sel' : ''}"
                data-key="${key}" aria-label="${y} 年 ${mo + 1} 月 ${d} 日${n ? `，${n} 字待複習` : ''}">
          ${n
            ? `<span class="cal-date">${d}</span><span class="cal-count">${n}</span>`
            : `<span class="cal-day">${d}</span>`}
        </button>`;
    }

    const prevId = opts.navIds?.prev || 'cal-prev';
    const nextId = opts.navIds?.next || 'cal-next';
    host.replaceChildren(el(`
      <div class="calendar">
        <div class="cal-head">
          <button class="icon-btn cal-nav" id="${escapeHtml(prevId)}" aria-label="上個月" title="上個月">${ICONS.chevronLeft}</button>
          <strong>${y} 年 ${mo + 1} 月</strong>
          <button class="icon-btn cal-nav" id="${escapeHtml(nextId)}" aria-label="下個月" title="下個月">${ICONS.chevronRight}</button>
        </div>
        <div class="cal-grid">
          ${WEEK.map((w) => `<span class="cal-week">${w}</span>`).join('')}
          ${cells}
        </div>
      </div>`));

    host.querySelector(`#${prevId}`)?.addEventListener('click', () => {
      state.month = new Date(y, mo - 1, 1);
      paint();
      opts.onMonth?.(state.month);
    });
    host.querySelector(`#${nextId}`)?.addEventListener('click', () => {
      state.month = new Date(y, mo + 1, 1);
      paint();
      opts.onMonth?.(state.month);
    });
    host.querySelectorAll('.cal-cell[data-key]').forEach((b) => {
      b.addEventListener('click', () => {
        state.selected = b.dataset.key;
        paint();
        opts.onSelect?.(b.dataset.key);
      });
    });
  };

  paint();

  return {
    /** 換顯示月份（不觸發 onMonth，避免與呼叫端自己的狀態打架） */
    setMonth(m) { state.month = monthStart(m); paint(); },
    /** 換排程字數後重畫（不必重建實例） */
    setCounts(c) { state.counts = c || new Map(); paint(); },
    /** 換選中日期後重畫 */
    setSelected(k) { state.selected = k || null; paint(); },
    destroy() { host.replaceChildren(); },
  };
}
