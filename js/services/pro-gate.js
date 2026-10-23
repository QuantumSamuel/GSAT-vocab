// ============================================================
// 6.3.0 Pro 功能閘（學習站共用模組）——本機候選元件，尚未掛進正式頁面
//
// 裁決（2026-10-22）：Pro 功能 8 項全 Pro；無 Pro 時這些功能顯示
// 「正在開發中」；診斷入口隱藏、每日任務不客制化。
//
// 本模組只做「判定＋呈現字串」，不碰 DOM 生命週期、不直接呼叫網路——
// proStatus 由呼叫端注入（production 接 pro-api.js 的 proStatus；
// 測試用 mock），因此可被 node 直接 import 測試。
//
// 接線說明（待 6.3.0 目錄確認後由頁面消費）：
//   - 頁面載入時呼叫 proGateStatus(featureId, proStatusFn) 取得
//     { state: 'loading' | 'available' | 'unavailable' }；
//   - state==='unavailable' 時以 gateCardHtml(featureLabel) 取代頁面主體；
//   - diagnostic 入口（practice/home）在 unavailable 時隱藏；
//   - daily_tasks 個人化卡在 unavailable 時不渲染（不客制化）。
// ============================================================

// 與 pro-activation-core PRO_FEATURES 一致的 8 項（2026-10-22 裁決）
export const PRO_FEATURES = Object.freeze([
  'diagnostic', 'daily_tasks', 'short_recheck', 'mock_exam',
  'translate', 'ai_weekly_report', 'fsrs_review', 'archive_full_exam',
]);

export const FEATURE_LABELS = Object.freeze({
  diagnostic: '詞彙診斷',
  daily_tasks: '每日任務',
  short_recheck: '短複測',
  mock_exam: '模擬考',
  translate: '翻譯題',
  ai_weekly_report: 'AI 學習週報',
  fsrs_review: 'FSRS 複習引擎',
  archive_full_exam: '模擬考真題全卷',
});

function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/**
 * 依 proStatus 回應判定功能是否可用。
 * proStatusFn：回傳 promise，resolve 為 { status, plan, expiresAt, hasPro, grants }（pro-api.js 契約）。
 * 誠實失敗原則：HTTP 失敗／壞形狀／throw 一律視為 unavailable（不當成有效 Pro）。
 */
export async function proGateStatus(featureId, proStatusFn, { hasProField = 'hasPro' } = {}) {
  if (!PRO_FEATURES.includes(featureId)) return { state: 'available', featureId, source: 'free' };
  let pro;
  try {
    pro = await proStatusFn();
  } catch {
    return { state: 'unavailable', featureId, source: 'pro', reason: 'PRO_STATUS_ERROR' };
  }
  if (!isPlainObject(pro) || pro[hasProField] !== true || pro.status !== 'active') {
    return { state: 'unavailable', featureId, source: 'pro', reason: 'NO_ACTIVE_PRO' };
  }
  // 有 active Pro 即解鎖全部 8 項（benefits 細分授權由後端 evaluateAccess 裁決；
  // 前端只做「是否有有效 Pro」的第一道呈現閘，不做細項權限自判）
  return { state: 'available', featureId, source: 'pro', reason: 'PRO_ACTIVE' };
}

/** 「正在開發中」卡片 HTML（純字串；消費端用 el() 掛入）。 */
export function gateCardHtml(featureId, extraNote = '') {
  const label = FEATURE_LABELS[featureId] || featureId;
  return `<section class="card pro-gate">
    <h2>${label}</h2>
    <p class="muted">Pro 功能（2026-10-22 裁決）：未升級時顯示「正在開發中」。${extraNote}</p>
    <p class="pro-gate-badge">正在開發中</p>
  </section>`;
}

/** 裁決：診斷入口在無 Pro 時隱藏（不是顯示「正在開發中」）。 */
export function shouldHideEntry(featureId) {
  return featureId === 'diagnostic';
}

/** 裁決：每日任務在無 Pro 時不客制化（不顯示個人化每日任務卡）。 */
export function shouldSuppressPersonalized(featureId) {
  return featureId === 'daily_tasks';
}