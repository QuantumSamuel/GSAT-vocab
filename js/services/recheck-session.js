// ============================================================
// 6.0.2 短複測「當日批次」服務層（services/recheck-session.js）
//   6.0.3 跨裝置證據：新批次 sessionId 以 owner＋localDate 固定（既有 602 批次
//   sessionId 不重設）；真正首次逐字提交就把進度與「不可變 UUID 事件」同交易保存，
//   重試沿用 persisted ID／原時間而不重造；不同裝置同字不同作答→不同 eventID，
//   同批次內任意錯仍不能洗。回想後 fallback 辨認事件 hinted:true、recall 缺省/false。
//
// 把純流程（core/recheck-session.js）、本機儲存（diagnostic-store.js）與判定
// （core/recheck.js）接起來。所有寫入都帶 owner／localDate，且 owner／世代／跨日 guard
// 會在 IDB 交易內再驗一次（見 diagnostic-store.commitRecheckBatch）。
//
// 【刻意不做】不改 SRS／marks／dueAt、不自動完成原學習／複習任務、不增加今日任務字數、
//   不呼叫模型、不導入未知或缺 owner 的舊 quiz、不生成逐字歷史、雲端採用／還原不補造作答。
// ============================================================
import {
  RECHECK_SESSION_VERSION,
  recheckCap,
  pickRecheckWordIds,
  reconcileRecheckWordIds,
  newProgressEntry,
  applyRecallSubmit,
  applyReveal,
  applyRecognitionSubmit,
  evidenceForSession,
  recheckEventId,
} from '../core/recheck-session.js';
import { getDayPlan, updateDayPlan, commitRecheckBatch, listOwnerRecheckEvents } from './diagnostic-store.js';
import { getUser, getAuthGeneration } from './auth.js';
import { localDateKey } from '../core/daily-plan.js';
import { emit } from '../core/eventbus.js';

export { RECHECK_SESSION_VERSION, recheckCap };

function assertOwner(ownerId, generation = getAuthGeneration()) {
  if (getUser()?.id !== ownerId || getAuthGeneration() !== generation) throw new Error('ACCOUNT_CHANGED');
}
function assertDay(localDate) {
  if (localDateKey() !== localDate) throw new Error('DAY_CHANGED');
}
// 每次寫入交易內都要重驗：owner／世代／跨日。
function makeGuards(ownerId, localDate, generation) {
  return [
    () => assertOwner(ownerId, generation),
    () => assertDay(localDate),
  ];
}
function nowIso() { return new Date().toISOString(); }
function randomId() {
  try { return globalThis.crypto?.randomUUID?.() || `rcs-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
  catch { return `rcs-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
}
// 6.0.3：新批次 sessionId 以 owner＋localDate 固定（跨裝置同一天同 session）。
function sessionIdForOwnerDate(ownerId, localDate) {
  return `rcs:${ownerId}:${localDate}`;
}

// 把計畫字轉成短複測批次（保留已作答；未作答者依當日任務字補足到 cap）。
// priorIds＝次日弱字等優先字（可選）。回傳新的 recheck 批次（不寫入）。
function buildBatch({ current, plan, cap, priorIds = [] }) {
  const desired = pickRecheckWordIds({ plan, cap, priorIds });
  const prev = current?.recheck;
  const ownerId = current?.ownerId;
  const localDate = current?.localDate;
  if (!prev || !Array.isArray(prev.wordIds)) {
    const wordIds = desired.slice(0, cap);
    return {
      version: RECHECK_SESSION_VERSION,
      sessionId: sessionIdForOwnerDate(ownerId, localDate),
      wordIds,
      progress: Object.fromEntries(wordIds.map((id) => [id, newProgressEntry()])),
      submitted: false,
      submittedAt: null,
      createdAt: nowIso(),
    };
  }
  const progress = { ...(prev.progress || {}) };
  const answeredIds = Object.keys(progress).filter((id) => progress[id]?.answered);
  const wordIds = reconcileRecheckWordIds({ currentIds: prev.wordIds, answeredIds, nextIds: desired, cap });
  const nextProgress = {};
  for (const id of wordIds) nextProgress[id] = progress[id] ? { ...progress[id] } : newProgressEntry();
  return {
    version: prev.version || RECHECK_SESSION_VERSION,
    sessionId: prev.sessionId, // 同 owner/localDate 重開頁沿用同一 session（不新增）；既有 602 批次不重設。
    wordIds,
    progress: nextProgress,
    submitted: prev.submitted === true,
    submittedAt: prev.submittedAt ?? null,
    createdAt: prev.createdAt ?? nowIso(),
  };
}

/**
 * 取得（必要時建立／調整）當日短複測批次。
 * 同 owner／localDate 重開頁：沿用既有 sessionId，不新增 session；
 * 負載升降只增刪未作答，已作答保留。回傳 { session, plan }。
 */
export async function getRecheckSession(ownerId, localDate, { plan, load = 'standard', priorIds = [] } = {}) {
  const generation = getAuthGeneration();
  assertOwner(ownerId, generation);
  assertDay(localDate);
  const cap = recheckCap(load);
  if (!plan) throw new Error('MISSING_PLAN');
  const nextPlan = await updateDayPlan(ownerId, localDate, (current) => {
    assertOwner(ownerId, generation);
    assertDay(localDate);
    if (!current) throw new Error('TASK_NOT_FOUND');
    // 以交易當下的 current plan 取樣，不信任外部可能過期的 plan。
    const recheck = buildBatch({ current, plan: current, cap, priorIds });
    return { ...current, recheck };
  });
  assertOwner(ownerId, generation);
  return { session: nextPlan.recheck, plan: nextPlan };
}

// 逐字更新：以交易內 guard 重驗後寫回（進度即時保存，儲存失敗不前進）。
// mutate(prev) 回傳下一筆 progress（可能含 rejected）。只改進度，不產生事件。
async function patchProgress(ownerId, localDate, wordId, mutator) {
  const generation = getAuthGeneration();
  const guards = makeGuards(ownerId, localDate, generation);
  const result = await commitRecheckBatch(ownerId, localDate, {
    events: [],
    guards,
    updater: (current) => {
      if (!current?.recheck) throw new Error('RECHECK_NOT_FOUND');
      const batch = current.recheck;
      if (batch.submitted) throw new Error('RECHECK_LOCKED');
      const id = String(wordId);
      if (!batch.wordIds.map(String).includes(id)) throw new Error('WORD_NOT_IN_BATCH');
      const prev = batch.progress?.[id] || newProgressEntry();
      const next = mutator(prev);
      if (next?.rejected === 'REVEALED') throw new Error('REVEALED_NO_RECALL');
      const { rejected, ...clean } = next || {};
      return { ...current, recheck: { ...batch, progress: { ...batch.progress, [id]: clean } } };
    },
  });
  assertOwner(ownerId, generation);
  return result.plan.recheck;
}

// 真正首次逐字提交：進度與「不可變 UUID 事件」同交易落地。
// first 偵測第一次實質作答；buildEvent 依進度組事件（含 hinted）。重試（已作答）不重造事件。
async function submitWord(ownerId, localDate, wordId, mutator, { first, buildEvent }) {
  const generation = getAuthGeneration();
  const guards = makeGuards(ownerId, localDate, generation);
  const result = await commitRecheckBatch(ownerId, localDate, {
    guards,
    updater: (current) => {
      for (const g of guards) g();
      if (!current?.recheck) throw new Error('RECHECK_NOT_FOUND');
      const batch = current.recheck;
      if (batch.submitted) throw new Error('RECHECK_LOCKED');
      const id = String(wordId);
      if (!batch.wordIds.map(String).includes(id)) throw new Error('WORD_NOT_IN_BATCH');
      const prev = batch.progress?.[id] || newProgressEntry();
      const next = mutator(prev);
      if (next?.rejected === 'REVEALED') throw new Error('REVEALED_NO_RECALL');
      const { rejected, ...clean } = next || {};
      const isFirst = first(prev, clean);
      const events = [];
      let progress = { ...batch.progress, [id]: clean };
      if (isFirst) {
        const eventId = randomId();
        const at = nowIso();
        const sessionId = batch.sessionId;
        progress = { ...progress, [id]: { ...clean, eventId } };
        events.push({
          eventId,
          wordId,
          type: 'recheck',
          at,
          extra: buildEvent(clean, sessionId),
        });
      }
      return { plan: { ...current, recheck: { ...batch, progress } }, events };
    },
  });
  assertOwner(ownerId, generation);
  return result.plan.recheck;
}

// 提交回想（打字）。correct 由正解判定；錯誤＝揭示英文並轉辨認（證據仍為 recall=false）。
export async function submitRecheckRecall(ownerId, localDate, wordId, input, { answer } = {}) {
  return submitWord(ownerId, localDate, wordId, (prev) => applyRecallSubmit(prev, { input, answer }), {
    first: (prev, next) => next.recallSubmitted === true && prev.recallSubmitted !== true,
    buildEvent: (progress, sessionId) => ({
      sessionId,
      mode: 'recall',
      correct: progress.recallCorrect === true,
      hinted: false, // recall 缺省／false：無提示回想不標 hinted。
    }),
  });
}

// 「不知道」：揭示英文、轉辨認。只改 progress 不算答，不製造 recall 事件。
export async function revealRecheck(ownerId, localDate, wordId) {
  return patchProgress(ownerId, localDate, wordId, (prev) => applyReveal(prev));
}

// 提交辨認（四張中文選項卡）。回想後 fallback 辨認事件 hinted:true（提示後辨認只練習、不列候選）。
export async function submitRecheckRecognition(ownerId, localDate, wordId, { correct } = {}) {
  return submitWord(ownerId, localDate, wordId, (prev) => applyRecognitionSubmit(prev, { correct }), {
    first: (prev, next) => next.recognitionAnswered === true && prev.recognitionAnswered !== true,
    buildEvent: (progress, sessionId) => ({
      sessionId,
      mode: 'recognition',
      correct: progress.recognitionCorrect === true,
      hinted: true, // 辨認＝已揭示英文，屬提示後作答。
    }),
  });
}

/**
 * 提交整批：把已作答字的證據與 submitted 鎖定「同一交易」寫入。
 * 6.0.3：逐字提交已把進度＋UUID 事件同交易落地，故整批提交只鎖定／引用既有事件；
 *   相容舊未逐字落事件的批次：僅明確 user submit 可 materialize 既有已作答 progress
 *   （穩定舊 ID rc:sessionId:wordId）。雲端採用／還原絕不補造作答。
 * 回傳 { session, plan, events }。
 */
export async function submitRecheckBatch(ownerId, localDate) {
  const generation = getAuthGeneration();
  assertOwner(ownerId, generation);
  assertDay(localDate);
  const at = nowIso();
  const guards = makeGuards(ownerId, localDate, generation);
  const result = await commitRecheckBatch(ownerId, localDate, {
    guards,
    eventBuilder: (current) => {
      for (const g of guards) g();
      if (!current?.recheck) throw new Error('RECHECK_NOT_FOUND');
      const batch = current.recheck;
      if (batch.submitted) return [];
      const sessionId = batch.sessionId;
      const evidence = evidenceForSession({ sessionId, wordIds: batch.wordIds, progress: batch.progress });
      // 只 materialize 尚未逐字落事件的字（progress.eventId 為 null 的舊批次）；
      // 已逐字落事件者（progress.eventId 已設）只鎖定、不重造。
      const toMaterialize = evidence.filter((e) => !batch.progress[String(e.wordId)]?.eventId);
      return toMaterialize.map((e) => ({
        eventId: e.eventId || recheckEventId(sessionId, e.wordId),
        wordId: e.wordId,
        type: 'recheck',
        at,
        extra: { sessionId, mode: e.mode, correct: e.correct === true, hinted: e.hinted === true },
      }));
    },
    updater: (current) => {
      for (const g of guards) g();
      if (!current?.recheck) throw new Error('RECHECK_NOT_FOUND');
      const batch = current.recheck;
      if (batch.submitted) return current;
      const sessionId = batch.sessionId;
      const evidence = evidenceForSession({ sessionId, wordIds: batch.wordIds, progress: batch.progress });
      const nextProgress = { ...batch.progress };
      for (const e of evidence) {
        const id = String(e.wordId);
        const existing = nextProgress[id]?.eventId;
        // 保留既有（逐字 UUID）eventId；僅舊缺 ID 的字才補 deterministic 舊 ID。
        nextProgress[id] = { ...(nextProgress[id] || newProgressEntry()), eventId: existing || e.eventId };
      }
      return {
        ...current,
        recheck: { ...batch, progress: nextProgress, submitted: true, submittedAt: at },
      };
    },
  });
  assertOwner(ownerId, generation);
  assertDay(localDate);
  const sessionId = result.plan?.recheck?.sessionId;
  emit('recheck:submitted', { ownerId, localDate, sessionId, events: result.events });
  return { session: result.plan?.recheck, plan: result.plan, events: result.events };
}

// 只讀：讀取當日批次（不建立）。無則回 null。
export async function readRecheckSession(ownerId, localDate) {
  const plan = await getDayPlan(ownerId, localDate);
  return plan?.recheck ?? null;
}

// 只讀：讀取該帳戶所有短複測證據（供次日弱字推導；僅本人、僅有效證據）。
export async function listOwnerRecheck(ownerId) {
  return listOwnerRecheckEvents(ownerId);
}
