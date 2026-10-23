// ============================================================
// 6.3.1 AI 學習週報頁（本機候選）
// 屬 8 項 Pro（2026-10-22 裁決）：無有效 Pro → 「正在開發中」。
// 週期：週一至週日，依裝置當地日期（631 核准規則；不做 UTC 靜默替換）。
// 內容：每日任務／短複測原始計數（只呈現既有資料；缺資料顯示未知未校準，不生成能力等級）。
// AI 摘要：按需生成（使用者按鈕觸發），呼叫 weekly-api transport。
// 後端（weekly-report-api Edge）未部署／未設定時：誠實顯示「週報服務尚未就緒」＋重試，
// 不假裝成功、不顯示假數據。
// ============================================================
import { el, escapeHtml } from '../core/ui.js';
import { routeGuard } from '../core/router.js';
import { getUser, getAuthGeneration } from '../services/auth.js';
import { proGateStatus, gateCardHtml } from '../services/pro-gate.js';
import { proStatus } from '../services/pro-api.js';
import { weeklyFacts, weeklyGenerate, weeklyHistory } from '../services/weekly-api.js';
import { mountProGateCard } from '../services/pro-gate-dom.js';

let epoch = 0;
export function onLeave() { epoch += 1; }

// 本週週一～週日（裝置當地日期）＋毫秒週期
export function localWeek(now = new Date()) {
  const dow = now.getDay(); // 0=Sun
  const diff = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diff);
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  const start = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate());
  const end = new Date(sunday.getFullYear(), sunday.getMonth(), sunday.getDate() + 1);
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const timeZone = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } })();
  return {
    monday: fmt(monday), sunday: fmt(sunday),
    startMs: start.getTime(), endMs: end.getTime(), timeZone,
  };
}

export async function renderWeekly(main, deps = {}) {
  const gen = ++epoch;
  const alive = () => gen === epoch && routeGuard();
  const { factsFn = weeklyFacts, generateFn = weeklyGenerate, historyFn = weeklyHistory } = deps;
  const { proStatusFn = proStatus } = deps;

  main.replaceChildren(el('<section class="card"><p class="muted">檢查權益中…</p></section>'));

  // 1) Pro 閘
  const gate = await proGateStatus('ai_weekly_report', proStatusFn);
  if (!alive()) return;
  if (gate.state !== 'available') {
    mountProGateCard(main, 'ai_weekly_report', () => renderWeekly(main, deps), 'AI 週報屬 Pro 功能；未升級時此頁顯示「正在開發中」。');
    return;
  }

  const week = localWeek();
  let facts;
  try {
    facts = await factsFn({ periodStartMs: week.startMs, periodEndMs: week.endMs, timeZone: week.timeZone });
  } catch (err) {
    if (!alive()) return;
    // 後端未部署／未設定／失敗：誠實顯示，不假裝
    const card = el(`
      <section class="card">
        <h2>AI 週報（Pro）</h2>
        <p class="muted">${escapeHtml(week.monday)} ～ ${escapeHtml(week.sunday)}（依本裝置當地日期，週一至週日）</p>
        <p class="warning">週報服務尚未就緒：${escapeHtml(String(err?.message ?? err))}</p>
        <p class="muted small">後端（weekly-report-api）部署並設定後即可生成；在此之前如實顯示不可用，不會假冒成功。</p>
      </section>`);
    const retry = el('<button class="btn" type="button">重新載入</button>');
    retry.addEventListener('click', () => renderWeekly(main, deps));
    card.append(retry);
    main.replaceChildren(card);
    return;
  }

  if (!alive()) return;
  // 2) 原始計數（只呈現既有資料；缺資料顯示未知未校準）
  const daily = facts?.facts?.dayPlans || [];
  const recheck = facts?.facts?.recheckEvents || [];
  const dailyText = daily.length
    ? `每日任務：${daily.length} 天計畫、計畫 ${daily.reduce((a, p) => a + (p.total || (p.newIds?.length || 0) + (p.reviewIds?.length || 0) + (p.reinforcementIds?.length || 0)), 0)} 題、完成 ${daily.reduce((a, p) => a + (p.completedIds?.length || 0), 0)} 題（完成率只以真實數量計算）。`
    : '每日任務：此期間沒有每日任務計畫（NO_DAILY_PLANS）。完成率為未知，不以 0 代替。';
  const recheckText = recheck.length
    ? `短複測：${recheck.length} 筆複測事件。`
    : '短複測：無複測事件（未校準）。';

  const card = el(`
    <section class="card">
      <h2>AI 週報（Pro）</h2>
      <p class="muted">${escapeHtml(week.monday)} ～ ${escapeHtml(week.sunday)}（依本裝置當地日期，週一至週日）</p>
      <p>${escapeHtml(dailyText)}</p>
      <p>${escapeHtml(recheckText)}</p>
      <p class="muted small">本週報只呈現既有原始任務／複測統計；缺資料顯示未知未校準，不生成能力等級。</p>
      <div id="weekly-ai"></div>
      <div class="controls controls-start"><button class="btn primary" id="weekly-gen" type="button">生成／更新 AI 摘要</button></div>
    </section>`);
  main.replaceChildren(card);

  // 3) AI 摘要：按需生成（使用者按鈕觸發；不擅發付費請求）。同版本快取命中時標示。
  const aiBox = main.querySelector('#weekly-ai');
  const genBtn = main.querySelector('#weekly-gen');
  if (aiBox && genBtn) {
    genBtn.addEventListener('click', async () => {
      if (genBtn.disabled) return;
      genBtn.disabled = true;
      aiBox.replaceChildren(el('<p class="muted">生成中…（AI 摘要按需生成）</p>'));
      try {
        const data = await generateFn({ periodStartMs: week.startMs, periodEndMs: week.endMs, timeZone: week.timeZone });
        if (!alive()) return;
        const content = data?.report?.aiSummary?.content;
        aiBox.replaceChildren(el(`<h3>AI 摘要</h3><p>${escapeHtml(content || '(無內容)')}</p>${data?.fromCache ? '<p class="muted small">（同版本快取命中）</p>' : ''}`));
      } catch (err) {
        if (!alive()) return;
        aiBox.replaceChildren(el(`<p class="warning">生成失敗：${escapeHtml(String(err?.message ?? err))}（可重試）</p>`));
      } finally {
        if (alive()) genBtn.disabled = false;
      }
    });
  }

  // 4) 歷史（後端未就緒時 historyFn 會失敗，靜默；不顯示假歷史）
  try {
    const history = await historyFn();
    if (alive() && Array.isArray(history?.items) && history.items.length) {
      const host = main.querySelector('#weekly-ai');
      if (host) host.append(el(`<h3>歷史週報</h3><p class="muted small">${history.items.length} 筆</p>`));
    }
  } catch { /* 後端未就緒：不顯示歷史，靜默 */ }
}

export { localWeek as _localWeekForTest };