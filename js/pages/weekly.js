// ============================================================
// 6.3.1 AI 學習週報頁（本機候選）
// 屬 8 項 Pro（2026-10-22 裁決）：無有效 Pro → 「正在開發中」。
// 週期：週一至週日，依裝置當地日期（631 核准規則；不做 UTC 靜默替換）。
// 內容：每日任務／短複測原始計數（只呈現既有資料；缺資料顯示未知未校準，不生成能力等級）。
// AI 摘要：按需生成（使用者按鈕觸發），呼叫 weekly-api transport。
// 後端（weekly-report-api Edge）未部署／未設定時：誠實顯示「週報服務尚未就緒」＋重試，
// 不假裝成功、不顯示假數據。
//
// 2026-11-16（6.3.1 時區／錯誤契約）三項修正：
//   1. 離頁守衛原本寫成 `routeGuard()`，取得的是函式（恆真），等於沒作用；
//      改成先取 `stillOn` 再呼叫 `stillOn()`，與 daily-tasks／unknown／practice 同慣例。
//   2. 裝置時區取不到時不再假裝 'UTC'（那會讓後端用 UTC 的 dateKey 驗證本地毫秒週期，
//      直接 400 INVALID_WEEK_PERIOD）；現在回傳 timeZone:null，頁面誠實停用並說明原因。
//   3. 錯誤訊息不再直接顯示後端／網路層原文（可能是不可信 detail），改以固定對照表輸出；
//      原文只進 console 供診斷，UI 只顯示代碼。
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

// ---------- 時區與週期（純函式，可單獨測） ----------

const pad2 = (n) => String(n).padStart(2, '0');
/** 本地日期 → YYYY-MM-DD（不經 toISOString，避免時區把日期退一天） */
function localDateKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 裝置 IANA 時區；取不到就回 null，不用 'UTC' 冒充。 */
export function deviceTimeZone() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === 'string' && tz.trim() ? tz.trim() : null;
  } catch {
    return null;
  }
}

/**
 * 本週週一～週日（裝置當地日期）＋毫秒週期。
 * startMs = 當地週一 00:00；endMs = 下週一 00:00（不含）。
 * 用本地 Date 建構子做日期加減，跨月／跨年／DST 由 JS 正規化處理，
 * 因此 endMs-startMs 在 DST 週會是 6.96～7.04 天，後端已允許 6～8 天。
 */
export function localWeek(now = new Date()) {
  const dow = now.getDay(); // 0=Sun
  const diff = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diff);
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  const nextMonday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 7);
  return {
    monday: localDateKey(monday),
    sunday: localDateKey(sunday),
    startMs: monday.getTime(),
    endMs: nextMonday.getTime(),
    timeZone: deviceTimeZone(),
  };
}

/** 週期文字（顯示用；不參與判定）。 */
function periodText(w) {
  return `${w.monday} ～ ${w.sunday}（依本裝置當地日期，週一至週日）`;
}

// ---------- 錯誤呈現（固定對照表；不回顯後端不可信原文） ----------

const ERROR_TEXT = {
  NO_DEVICE_TIMEZONE: '無法取得裝置時區，暫不送出週報請求；請確認系統時區設定後重新載入',
  NOT_CONFIGURED: '週報服務尚未設定',
  CONFIG_HTTP_ERROR: '讀取服務設定失敗，請稍後重試',
  UNAUTHENTICATED: '登入狀態已失效，請重新登入',
  AUTH_CHANGED: '帳戶已變更，請重新載入週報',
  INVALID_RESPONSE: '週報服務回應異常，請重試',
  INVALID_PERIOD: '週期計算異常，請重新載入',
  INVALID_WEEK_PERIOD: '週期不是週一至週日，請回報此問題',
  INVALID_TIMEZONE: '裝置時區無法辨識，請檢查系統時區設定',
  INVALID_HISTORY_ID: '缺少要刪除的週報編號',
  WEEKLY_SERVER_ERROR: '週報服務暫時無法使用，請稍後重試',
  WEEKLY_ERROR: '週報請求失敗，請重試',
};

/** 後端未就緒類錯誤：歷史區塊靜默即可，不必打擾使用者。 */
const NOT_READY_CODES = new Set(['NOT_CONFIGURED', 'CONFIG_HTTP_ERROR', 'UNAUTHENTICATED', 'AUTH_CHANGED']);

export function weeklyErrorText(err) {
  if (err?.name === 'AbortError') return '已取消週報請求';
  const code = typeof err?.code === 'string' ? err.code : '';
  if (ERROR_TEXT[code]) return ERROR_TEXT[code];
  if (err instanceof TypeError) return '網路連線失敗，請確認網路後重試';
  return '週報服務暫時無法使用，請稍後重試';
}

function errorCode(err) {
  return typeof err?.code === 'string' ? err.code : '';
}

function logFailure(scope, err) {
  // 原文只進 console 供診斷；UI 一律用 weeklyErrorText，不把後端 detail 畫給使用者。
  try { console.warn(`[weekly] ${scope}`, errorCode(err) || err?.name || '', err?.message ?? ''); } catch { /* console 不可用時忽略 */ }
}

// ============================================================
// 頁面
// ============================================================

export async function renderWeekly(main, deps = {}) {
  const gen = ++epoch;
  const stillOn = routeGuard(); // 6.3.1：routeGuard() 回傳的是函式，必須再呼叫
  const alive = () => gen === epoch && stillOn();
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

  // 2) 週期：每次請求前重算，頁面跨過週界也不會送出上一週的期間
  const periodForRequest = () => {
    const w = localWeek();
    if (!w.timeZone) throw Object.assign(new Error('device timezone unavailable'), { code: 'NO_DEVICE_TIMEZONE' });
    return w;
  };

  let week;
  let facts;
  try {
    week = periodForRequest();
    facts = await factsFn({ periodStartMs: week.startMs, periodEndMs: week.endMs, timeZone: week.timeZone });
  } catch (err) {
    if (!alive()) return;
    logFailure('facts', err);
    const code = errorCode(err);
    const shown = week ?? localWeek();
    const card = el(`
      <section class="card">
        <h2>AI 週報（Pro）</h2>
        <p class="muted">${escapeHtml(periodText(shown))}</p>
        <p class="warning" id="weekly-error">週報服務尚未就緒：${escapeHtml(weeklyErrorText(err))}</p>
        ${code ? `<p class="muted small" id="weekly-error-code">錯誤代碼：${escapeHtml(code)}</p>` : ''}
        <p class="muted small">後端（weekly-report-api）部署並設定後即可生成；在此之前如實顯示不可用，不會假冒成功。</p>
      </section>`);
    const retry = el('<button class="btn" type="button">重新載入</button>');
    retry.addEventListener('click', () => renderWeekly(main, deps));
    card.append(retry);
    main.replaceChildren(card);
    return;
  }

  if (!alive()) return;
  // 3) 原始計數（只呈現既有資料；缺資料顯示未知未校準）
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
      <p class="muted" id="weekly-period">${escapeHtml(periodText(week))}</p>
      <p>${escapeHtml(dailyText)}</p>
      <p>${escapeHtml(recheckText)}</p>
      <p class="muted small">本週報只呈現既有原始任務／複測統計；缺資料顯示未知未校準，不生成能力等級。</p>
      <div id="weekly-ai"></div>
      <div class="controls controls-start"><button class="btn primary" id="weekly-gen" type="button">生成／更新 AI 摘要</button></div>
    </section>`);
  main.replaceChildren(card);

  // 4) AI 摘要：按需生成（使用者按鈕觸發；不擅發付費請求）。同版本快取命中時標示。
  const aiBox = main.querySelector('#weekly-ai');
  const genBtn = main.querySelector('#weekly-gen');
  if (aiBox && genBtn) {
    genBtn.addEventListener('click', async () => {
      if (genBtn.disabled) return;
      genBtn.disabled = true;
      aiBox.replaceChildren(el('<p class="muted">生成中…（AI 摘要按需生成）</p>'));
      try {
        const fresh = periodForRequest();
        const data = await generateFn({ periodStartMs: fresh.startMs, periodEndMs: fresh.endMs, timeZone: fresh.timeZone });
        if (!alive()) return;
        // 頁面停留跨過週界：更新顯示期間，避免文字與實際送出的期間不一致
        if (fresh.monday !== week.monday) {
          week = fresh;
          const label = main.querySelector('#weekly-period');
          if (label) label.textContent = periodText(fresh);
        }
        const content = data?.report?.aiSummary?.content;
        aiBox.replaceChildren(el(`<h3>AI 摘要</h3><p>${escapeHtml(content || '(無內容)')}</p>${data?.fromCache ? '<p class="muted small">（同版本快取命中）</p>' : ''}`));
      } catch (err) {
        if (!alive()) return;
        logFailure('generate', err);
        aiBox.replaceChildren(el(`<p class="warning" id="weekly-gen-error">生成失敗：${escapeHtml(weeklyErrorText(err))}（可重試）</p>`));
      } finally {
        if (alive()) genBtn.disabled = false;
      }
    });
  }

  // 5) 歷史：後端未就緒時靜默；其他失敗如實顯示（不把「載入失敗」說成「沒有歷史」）
  try {
    const history = await historyFn();
    if (alive() && Array.isArray(history?.items) && history.items.length) {
      const host = main.querySelector('#weekly-ai');
      if (host) host.append(el(`<h3>歷史週報</h3><p class="muted small">${history.items.length} 筆</p>`));
    }
  } catch (err) {
    if (!alive()) return;
    const code = errorCode(err);
    if (NOT_READY_CODES.has(code)) return;
    logFailure('history', err);
    const host = main.querySelector('#weekly-ai');
    if (host) host.append(el(`<p class="muted small" id="weekly-history-error">歷史週報載入失敗：${escapeHtml(weeklyErrorText(err))}</p>`));
  }
}

export { localWeek as _localWeekForTest };
