// ============================================================
// 頁面：首頁（2.1.2 響應式）
// 手機：快捷 → 每日任務（含月曆）單欄直向
// 平板/電腦（橫向寬幕）：左欄＝每日任務＋快捷，右欄＝複習月曆
// ============================================================
import { el, escapeHtml, ICONS } from '../core/ui.js';
import { getUser, restFetch } from '../services/auth.js';
import { renderDailyTask } from './review.js';

export async function renderHome(main) {
  // 3.1.0：公告橫幅（後台發佈；每則只提示一次）
  // 3.3.0：最多並列 3 則（最新優先），每則各自可關閉
  let annRow = '';
  try {
    const rows = await restFetch('vocab_announcements?active=eq.true&order=created_at.desc&limit=3');
    const cards = rows
      .filter((ann) => localStorage.getItem('vocab2_seen_ann_' + ann.id) !== '1')
      .map((ann) => `
        <section class="ann-card">
          <span class="ann-text"><svg class="ann-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 16.5 5v14L3 13.5z"/><path d="M11.3 16.9a3.1 3.1 0 1 1-6-1.6"/></svg>${escapeHtml(ann.content)}</span>
          <button class="icon-btn ann-close" data-ann-id="${ann.id}" aria-label="關閉公告" title="關閉公告">${ICONS.close}</button>
        </section>`).join('');
    if (cards) annRow = `<div class="ann-row">${cards}</div>`;
  } catch { /* 未設定 Supabase／離線時靜默 */ }

  // 3.3.1（T-016）：訪客看得到每日任務與月曆的排版，但內容模糊＋不可操作
  const guest = !getUser();
  const lockTip = guest ? `
    <div class="card-lock-tip">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
      登入後解鎖每日任務與複習 <a href="#/auth?tab=login">登入</a>
    </div>` : '';

  main.replaceChildren(el(`
    <div>${annRow}</div>
    <div class="home-layout">
      <section class="card home-daily ${guest ? 'card-locked' : ''}">
        ${lockTip}
        <div id="daily-card"></div>
      </section>
      <section class="card home-cal ${guest ? 'card-locked' : ''}">
        ${lockTip}
        <div id="cal-card"></div>
      </section>
      <div class="quick-grid">
        <a class="quick-card" href="#/practice">
          <span class="quick-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/></svg></span>
          <span class="quick-title">練習</span>
        </a>
        <a class="quick-card" href="#/lookup">
          <span class="quick-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg></span>
          <span class="quick-title">查詢</span>
        </a>
      </div>
    </div>`));

  renderDailyTask(
    main.querySelector('#daily-card'),
    main.querySelector('#cal-card'),
  );

  main.querySelectorAll('[data-ann-id]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.annId;
    localStorage.setItem('vocab2_seen_ann_' + id, '1');
    b.closest('.ann-card')?.remove();
  }));
}
