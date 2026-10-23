// ============================================================
// 6.0.3 學習狀態匯出／還原／跨裝置合併（純函式，無 IDB／DOM／網路）
//
// Envelope 格式（白名單，不含 token／任意私密 extras）：
//   {
//     format: 'gsat-learning',
//     schemaVersion: 1,
//     ownerId,
//     exportedAt,          // ISO 字串（僅用於顯示，digest 忽略）
//     diagnostic?,         // 可選唯讀 DTO（只留參考欄位，不還原資格）
//     dayPlans: [],        // 每筆含 ownerId/localDate/revision/load/ids 陣列
//     recheckEvents: [],   // 每筆含 ownerId/eventId/wordId/at/mode/bool/session/hinted
//   }
//
// 已核准規則（使用者定案，2026-10-15）：
//   - 只輸出白名單欄位，不帶 token／任意私密 extras。
//   - 診斷 DTO 只留非題庫參考欄位，不還原資格／答案；且 owner 必須一致。
//   - 所有 nested owner 一致（含 diagnostic）；localDate 為有效實際日曆日期；
//     load 三檔必填；IDs 皆陣列且 completed 必須來源於原 plan 內；revision 非負安全整數。
//   - wordId 只非空 string 或有限 number，儲存保留原類型，比對以 String；
//     物件／空值／NaN 等無效值一律拒絕，不 String 化冒成功。
//   - new/review/可選 reinforcementIds 兩兩互斥（String 比對）。
//   - overflow 與 recheck 批次 metadata 保留合法欄位，不丟失已作答進度。
//   - 重複日期拒絕，避免 Map 覆寫遺失完成。
//   - 事件需 owner/eventId/wordId/type=recheck/at/mode/bool/session；每 (owner,eventId) 去重；
//     相同 ID 不同 payload 丟 EVENT_PAYLOAD_CONFLICT 不覆蓋；time 正規化同瞬間等價；
//     保留原 wordId 型別。
//   - 事件 extra.hinted 為可選布林（提示後辨認只保留練習、不列候選）：缺省＝false 且與
//     false 語義等價（同 ID missing=false 不衝突），true 與 false 為不同 payload 須衝突；
//     存在但非布林一律拒絕；create→validate→merge→digest 皆完整保留，digest 缺省與
//     false 等價、true 不同。
//   - merge：remote 優先同日期計畫（preferRemotePlan 預設 true）；合併 completed 去重；
//     完成字若不在 chosen list，依來源 new/review/reinforcement 種類補回，分母不小於完成；
//     不得重複 new/review/reinforcement；global revision 採 remote.revision，不和 plan revision 混。
//   - 原資料不可 mutation。
//   - digest：忽略 exportedAt；dayPlans 按日期、events 按 ID、集合（completed/overflow）排序；
//     任務清單（new/review/reinforcement）word 順序有意義需保留。
// ============================================================

export const BACKUP_FORMAT = 'gsat-learning';
export const BACKUP_SCHEMA_VERSION = 1;

const VALID_LOADS = new Set(['light', 'standard', 'intensive']);
const VALID_MODES = new Set(['recognition', 'recall']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function fault(code, message = code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// ownerId 必須是非空 string（不接受 number 轉型）。
function ownerString(v) {
  if (typeof v === 'string' && v.trim()) return v;
  return null;
}

function isSafeNonNegativeInt(v) {
  return Number.isSafeInteger(v) && v >= 0;
}

// 有效時間：可轉成有限數值（number epoch ms 或可 Date.parse 的字串）。
function timeValue(at) {
  if (typeof at === 'number' && Number.isFinite(at)) return at;
  if (typeof at === 'string' && at.trim()) {
    const t = Date.parse(at);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

// wordId：只非空 string 或有限 number（不含 NaN/Infinity/物件/空字串）。
function isWordId(v) {
  if (typeof v === 'string' && v.trim()) return true;
  if (typeof v === 'number' && Number.isFinite(v)) return true;
  return false;
}

function wordIdKey(v) {
  return String(v);
}

// 實際日曆日期：格式符合且是該年月日的真實存在日（不含 2/30 等）。
function isValidCalendarDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function uniqueArrByString(xs) {
  const seen = new Set();
  const out = [];
  for (const x of xs) {
    const k = String(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

// 兩筆事件是否為同一 payload（wordId 字串化比對、時間正規化比對）。
// hinted 以「是否 true」比對：缺省與 false 視為等價，true 則不同（避免提示後辨認被誤升級）。
function sameEventPayload(a, b) {
  if (!a || !b) return false;
  if (wordIdKey(a.wordId) !== wordIdKey(b.wordId)) return false;
  if (timeValue(a.at) !== timeValue(b.at)) return false;
  const ea = a.extra || {};
  const eb = b.extra || {};
  if ((ea.hinted === true) !== (eb.hinted === true)) return false;
  return ea.sessionId === eb.sessionId && ea.mode === eb.mode && ea.correct === eb.correct;
}

// ============================================================
// 診斷 DTO 白名單（對照 6.0/backend/diagnostic-600.sql public_attempt）。
// 只輸出允許的參考欄位，真正白名單，不做黑名單剔除；所有陣列／物件
// 深副本，不留輸入引用，也不還原資格／答案／題庫。
// ============================================================

// focusLevels：整數 Lv1-7 的陣列（number 型別，整數且在 1..7）。
function isFocusLevel(v) {
  return Number.isInteger(v) && v >= 1 && v <= 7;
}
function pickFocusLevels(v) {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return undefined;
  const out = [];
  for (const x of v) {
    if (!isFocusLevel(x)) return undefined;
    out.push(x);
  }
  return out;
}

// result.levels：各級合法統計，不可整體刪除；只留白名單欄位。
const RESULT_LEVEL_KEYS = ['level', 'n', 'sumScoreUnits', 'meanScore', 'omittedOptionCount', 'wrongOptionCount', 'unknownCount'];
function pickResultLevel(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
  if (!isFocusLevel(entry.level)) return undefined;
  const out = {};
  for (const k of RESULT_LEVEL_KEYS) {
    if (entry[k] === undefined) continue;
    const val = entry[k];
    if (k === 'level') { out.level = val; continue; }
    if (typeof val === 'number' && Number.isFinite(val)) out[k] = val;
    else if (val === null) out[k] = null;
  }
  return out;
}

// result DTO 白名單：algorithmVersion/completionReason/answeredCount/focusLevels/
// vocabularyEstimate:{status}/levels。不可輸出 answerReview/未知 secret 欄位。
function pickResultDTO(result, ownerId) {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return undefined;
  if (result.ownerId != null && result.ownerId !== ownerId) {
    throw fault('OWNER_MISMATCH', 'result owner 不符');
  }
  const out = {};
  if (typeof result.algorithmVersion === 'string') out.algorithmVersion = result.algorithmVersion;
  if (typeof result.completionReason === 'string') out.completionReason = result.completionReason;
  if (isSafeNonNegativeInt(result.answeredCount)) out.answeredCount = result.answeredCount;
  const fl = pickFocusLevels(result.focusLevels);
  if (fl !== undefined) out.focusLevels = fl;
  if (result.vocabularyEstimate != null && typeof result.vocabularyEstimate === 'object' && !Array.isArray(result.vocabularyEstimate)) {
    const ve = {};
    if (typeof result.vocabularyEstimate.status === 'string') ve.status = result.vocabularyEstimate.status;
    out.vocabularyEstimate = ve;
  }
  if (result.levels !== undefined) {
    if (!Array.isArray(result.levels)) throw fault('INVALID_DIAGNOSTIC', 'result.levels 無效');
    const levels = [];
    for (const entry of result.levels) {
      const row = pickResultLevel(entry);
      if (row === undefined) throw fault('INVALID_DIAGNOSTIC', 'result.levels 含無效統計');
      levels.push(row);
    }
    out.levels = levels;
  }
  return out;
}

// planSeed DTO 白名單：attemptId/algorithmVersion/focusLevels/weakWordIds。
function pickPlanSeedDTO(seed, ownerId) {
  if (seed === null || typeof seed !== 'object' || Array.isArray(seed)) return undefined;
  if (seed.ownerId != null && seed.ownerId !== ownerId) {
    throw fault('OWNER_MISMATCH', 'planSeed owner 不符');
  }
  const out = {};
  if (typeof seed.attemptId === 'string') out.attemptId = seed.attemptId;
  if (typeof seed.algorithmVersion === 'string') out.algorithmVersion = seed.algorithmVersion;
  const fl = pickFocusLevels(seed.focusLevels);
  if (fl !== undefined) out.focusLevels = fl;
  if (seed.weakWordIds !== undefined) {
    if (!Array.isArray(seed.weakWordIds)) throw fault('INVALID_DIAGNOSTIC', 'planSeed.weakWordIds 無效');
    const weakWordIds = [];
    for (const w of seed.weakWordIds) {
      if (!isWordId(w)) throw fault('INVALID_WORD_ID', 'planSeed.weakWordIds 含無效 wordId');
      weakWordIds.push(w);
    }
    out.weakWordIds = weakWordIds;
  }
  return out;
}

const DIAGNOSTIC_KEYS = ['attemptId', 'status', 'revision', 'answeredCount', 'load', 'result', 'planSeed', 'completionReason', 'focusLevels', 'level', 'degree'];

function pickDiagnosticDTO(diag, ownerId) {
  if (diag == null) return undefined;
  if (typeof diag !== 'object' || Array.isArray(diag)) return undefined;
  // diagnostic.ownerId 若存在必須與 envelope owner 一致（nested owner 全一致）。
  if (diag.ownerId != null && diag.ownerId !== ownerId) {
    throw fault('OWNER_MISMATCH', 'diagnostic owner 不符');
  }
  const out = {};
  if (typeof diag.attemptId === 'string') out.attemptId = diag.attemptId;
  if (diag.status === 'in_progress' || diag.status === 'completed') out.status = diag.status;
  if (isSafeNonNegativeInt(diag.revision)) out.revision = diag.revision;
  if (isSafeNonNegativeInt(diag.answeredCount)) out.answeredCount = diag.answeredCount;
  if (typeof diag.load === 'string' && VALID_LOADS.has(diag.load)) out.load = diag.load;
  const fl = pickFocusLevels(diag.focusLevels);
  if (fl !== undefined) out.focusLevels = fl;
  if (typeof diag.completionReason === 'string') out.completionReason = diag.completionReason;
  if (isFocusLevel(diag.level)) out.level = diag.level;
  if (typeof diag.degree === 'number' && Number.isFinite(diag.degree)) out.degree = diag.degree;
  if (diag.result !== undefined) {
    const result = pickResultDTO(diag.result, ownerId);
    if (result !== undefined) out.result = result;
  }
  if (diag.planSeed !== undefined) {
    const seed = pickPlanSeedDTO(diag.planSeed, ownerId);
    if (seed !== undefined) out.planSeed = seed;
  }
  out.ownerId = ownerId;
  return out;
}

// ============================================================
// 正規化：wordId 陣列（保留原類型、String 去重、拒無效值）
// ============================================================
function normalizeWordIdList(arr, label) {
  if (!Array.isArray(arr)) throw fault('INVALID_PLAN', `dayPlan ${label} 無效`);
  const out = [];
  const seen = new Set();
  for (const v of arr) {
    if (!isWordId(v)) throw fault('INVALID_WORD_ID', `dayPlan ${label} 含無效 wordId`);
    const k = String(v);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

// ============================================================
// recheck 批次 metadata：保留合法欄位，不丟失已作答進度。
// 欄位型別嚴格驗證：session/version 非空 string；wordIds 合法 ID 陣列；
// progress 每字 key 皆在 wordIds 內；phase=recall|recognition；
// flags 若有必 boolean；recallCorrect/recognitionCorrect 只 bool 或 null；
// eventId 只非空 string 或 null；時間欄位 valid time 或 null。
// ============================================================
const RECHECK_PROGRESS_FLAG_KEYS = ['revealedEnglish', 'recallSubmitted', 'recognitionAnswered', 'answered', 'submitted'];
const RECHECK_PROGRESS_BOOL_NULL_KEYS = ['recallCorrect', 'recognitionCorrect'];

function isBoolOrNull(v) {
  return typeof v === 'boolean' || v === null;
}

function normalizeRecheckBatch(batch) {
  if (batch == null) return undefined;
  if (typeof batch !== 'object' || Array.isArray(batch)) throw fault('INVALID_PLAN', 'recheck 批次格式無效');

  // wordIds 必須是合法 ID 陣列（若提供）。
  const wordIds = batch.wordIds !== undefined
    ? normalizeWordIdList(batch.wordIds, 'recheck.wordIds')
    : undefined;

  // wordIds 集合（用於驗證 progress 每字皆在內）。
  const wordIdSet = wordIds ? new Set(wordIds.map(String)) : null;

  const out = {};
  if (batch.version !== undefined) {
    if (typeof batch.version !== 'string' || !batch.version.trim()) throw fault('INVALID_PLAN', 'recheck.version 非空 string');
    out.version = batch.version;
  }
  if (batch.sessionId !== undefined) {
    if (typeof batch.sessionId !== 'string' || !batch.sessionId.trim()) throw fault('INVALID_PLAN', 'recheck.sessionId 非空 string');
    out.sessionId = batch.sessionId;
  }
  if (wordIds !== undefined) out.wordIds = wordIds;

  if (batch.progress !== undefined) {
    if (batch.progress === null || typeof batch.progress !== 'object' || Array.isArray(batch.progress)) {
      throw fault('INVALID_PLAN', 'recheck.progress 格式無效');
    }
    const prog = {};
    for (const id of Object.keys(batch.progress)) {
      if (wordIdSet && !wordIdSet.has(id)) throw fault('INVALID_PLAN', 'recheck.progress 含不在 wordIds 內的字');
      const v = batch.progress[id];
      if (v === null || typeof v !== 'object' || Array.isArray(v)) {
        throw fault('INVALID_PLAN', 'recheck.progress 字項格式無效');
      }
      const row = {};
      if (v.phase !== undefined) {
        if (v.phase !== 'recall' && v.phase !== 'recognition') throw fault('INVALID_PLAN', 'recheck.progress.phase 無效');
        row.phase = v.phase;
      }
      for (const pk of RECHECK_PROGRESS_FLAG_KEYS) {
        if (v[pk] !== undefined) {
          if (typeof v[pk] !== 'boolean') throw fault('INVALID_PLAN', `recheck.progress.${pk} 非布林`);
          row[pk] = v[pk];
        }
      }
      for (const pk of RECHECK_PROGRESS_BOOL_NULL_KEYS) {
        if (v[pk] !== undefined) {
          if (!isBoolOrNull(v[pk])) throw fault('INVALID_PLAN', `recheck.progress.${pk} 非 bool/null`);
          row[pk] = v[pk];
        }
      }
      if (v.eventId !== undefined) {
        if (!(typeof v.eventId === 'string' && v.eventId.trim()) && v.eventId !== null) {
          throw fault('INVALID_PLAN', 'recheck.progress.eventId 無效');
        }
        row.eventId = v.eventId;
      }
      prog[id] = row;
    }
    out.progress = prog;
  }

  if (batch.submitted !== undefined) {
    if (typeof batch.submitted !== 'boolean') throw fault('INVALID_PLAN', 'recheck.submitted 非布林');
    out.submitted = batch.submitted;
  }
  if (batch.submittedAt !== undefined) {
    if (batch.submittedAt !== null && timeValue(batch.submittedAt) == null) throw fault('INVALID_PLAN', 'recheck.submittedAt 無效');
    out.submittedAt = batch.submittedAt;
  }
  if (batch.createdAt !== undefined) {
    if (batch.createdAt !== null && timeValue(batch.createdAt) == null) throw fault('INVALID_PLAN', 'recheck.createdAt 無效');
    out.createdAt = batch.createdAt;
  }
  return out;
}

// ============================================================
// recheck 批次合併：相同 session 保守合併兩端進度，不倒退、不丟答。
// ============================================================
function isAnswerIndicated(row) {
  if (!row || typeof row !== 'object') return false;
  if (row.answered === true) return true;
  if (row.recallSubmitted === true) return true;
  if (row.recognitionAnswered === true) return true;
  if (row.submitted === true) return true;
  if (row.recallCorrect === true || row.recallCorrect === false) return true;
  if (row.recognitionCorrect === true || row.recognitionCorrect === false) return true;
  return false;
}

function mergeProgressRow(a, b) {
  // a = base 端，b = other 端。傳回保守合併結果（不倒退）。
  if (a == null) return b;
  if (b == null) return a;
  const out = {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const av = a[k];
    const bv = b[k];
    if (av === undefined) { out[k] = bv; continue; }
    if (bv === undefined) { out[k] = av; continue; }
    if (k === 'revealedEnglish' || k === 'submitted') {
      // 布林：曾 true 不得倒退為 false。
      out[k] = (av === true || bv === true);
    } else if (k === 'recallCorrect' || k === 'recognitionCorrect') {
      // 曾錯（false）不得被對洗掉：任一 false 即 false；否則任一非 null 值優先。
      if (av === false || bv === false) out[k] = false;
      else if (av !== null) out[k] = av;
      else out[k] = bv;
    } else if (k === 'phase') {
      out[k] = av === 'recall' || bv === 'recall' ? 'recall' : (av === 'recognition' || bv === 'recognition' ? 'recognition' : av);
    } else if (k === 'answered') {
      out[k] = (av === true || bv === true);
    } else if (k === 'recallSubmitted' || k === 'recognitionAnswered') {
      out[k] = (av === true || bv === true);
    } else if (k === 'eventId') {
      out[k] = av !== null ? av : bv;
    } else {
      out[k] = av;
    }
  }
  return out;
}

function mergeRecheckBatch(baseBatch, otherBatch) {
  if (baseBatch == null) return otherBatch;
  if (otherBatch == null) return baseBatch;
  // 不同 session：保留 base 批次（chosen base），事件歷史由 merge 主流程另行聯集。
  const sameSession = baseBatch.sessionId != null && otherBatch.sessionId != null
    && baseBatch.sessionId === otherBatch.sessionId;

  const out = {
    version: baseBatch.version != null ? baseBatch.version : otherBatch.version,
    sessionId: baseBatch.sessionId != null ? baseBatch.sessionId : otherBatch.sessionId,
  };

  // wordIds：union 兩端（保留原類型、去重）。
  const wordIdMap = new Map();
  for (const w of (baseBatch.wordIds || [])) wordIdMap.set(String(w), w);
  for (const w of (otherBatch.wordIds || [])) if (!wordIdMap.has(String(w))) wordIdMap.set(String(w), w);
  out.wordIds = [...wordIdMap.values()];

  if (!sameSession) {
    // 不同 session：保留 base 進度，其餘欄位採 base。
    if (baseBatch.progress !== undefined) out.progress = baseBatch.progress;
    if (baseBatch.submitted !== undefined) out.submitted = baseBatch.submitted;
    if (baseBatch.submittedAt !== undefined) out.submittedAt = baseBatch.submittedAt;
    if (baseBatch.createdAt !== undefined) out.createdAt = baseBatch.createdAt;
    return out;
  }

  // 相同 session：保守合併 progress。
  const progress = {};
  const baseProg = baseBatch.progress || {};
  const otherProg = otherBatch.progress || {};
  for (const id of out.wordIds.map(String)) {
    const a = baseProg[id];
    const b = otherProg[id];
    const merged = mergeProgressRow(a, b);
    if (merged !== undefined) progress[id] = merged;
  }
  out.progress = progress;

  // submitted 不倒退：任一 true 即 true。
  const subA = baseBatch.submitted;
  const subB = otherBatch.submitted;
  if (subA !== undefined || subB !== undefined) {
    out.submitted = (subA === true || subB === true);
  }
  if (baseBatch.submittedAt !== undefined) out.submittedAt = baseBatch.submittedAt;
  else if (otherBatch.submittedAt !== undefined) out.submittedAt = otherBatch.submittedAt;
  if (baseBatch.createdAt !== undefined) out.createdAt = baseBatch.createdAt;
  else if (otherBatch.createdAt !== undefined) out.createdAt = otherBatch.createdAt;
  return out;
}

// ============================================================
// 正規化：dayPlan
// ============================================================
function normalizeDayPlan(ownerId, plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw fault('INVALID_PLAN', 'dayPlan 格式無效');
  if (plan.ownerId !== ownerId) throw fault('OWNER_MISMATCH', 'dayPlan owner 不符');
  if (!isValidCalendarDate(plan.localDate)) throw fault('INVALID_DATE', 'dayPlan localDate 無效');
  if (!VALID_LOADS.has(plan.load)) throw fault('INVALID_LOAD', 'dayPlan load 無效');
  if (!isSafeNonNegativeInt(plan.revision)) throw fault('INVALID_REVISION', 'dayPlan revision 無效');

  const reviewIds = normalizeWordIdList(plan.reviewIds, 'reviewIds');
  const newIds = normalizeWordIdList(plan.newIds, 'newIds');
  const completedIds = normalizeWordIdList(plan.completedIds, 'completedIds');
  const reinforcementIds = plan.reinforcementIds === undefined
    ? undefined
    : normalizeWordIdList(plan.reinforcementIds, 'reinforcementIds');

  // new/review/reinforcement 兩兩互斥（String 比對）。
  const reviewSet = new Set(reviewIds.map(String));
  const newSet = new Set(newIds.map(String));
  const reinSet = reinforcementIds ? new Set(reinforcementIds.map(String)) : new Set();
  for (const id of newSet) if (reviewSet.has(id)) throw fault('INVALID_PLAN', 'dayPlan new/review 重複字');
  for (const id of reinSet) {
    if (reviewSet.has(id) || newSet.has(id)) throw fault('INVALID_PLAN', 'dayPlan reinforcement 與 new/review 重複字');
  }

  // completed 必須來源於原 plan 的 newIds ∪ reviewIds ∪ reinforcementIds。
  const allowed = new Set([...reviewSet, ...newSet, ...reinSet]);
  for (const c of completedIds) {
    if (!allowed.has(String(c))) throw fault('INVALID_PLAN', 'dayPlan completed 不在原 plan 內');
  }

  const out = {
    ownerId,
    localDate: plan.localDate,
    revision: plan.revision,
    load: plan.load,
    reviewIds,
    newIds,
    completedIds,
  };
  if (reinforcementIds !== undefined) out.reinforcementIds = reinforcementIds;
  if (plan.attemptId != null) out.attemptId = plan.attemptId;
  if (plan.overflowDueIds !== undefined) out.overflowDueIds = normalizeWordIdList(plan.overflowDueIds, 'overflowDueIds');
  if (plan.overflowMustIds !== undefined) out.overflowMustIds = normalizeWordIdList(plan.overflowMustIds, 'overflowMustIds');
  if (plan.recheck !== undefined) {
    const batch = normalizeRecheckBatch(plan.recheck);
    if (batch !== undefined) out.recheck = batch;
  }
  return out;
}

// 正規化 dayPlans 陣列，並拒絕重複日期。
function normalizeDayPlans(ownerId, plans) {
  const seen = new Set();
  const out = [];
  for (const p of plans) {
    const normalized = normalizeDayPlan(ownerId, p);
    if (seen.has(normalized.localDate)) throw fault('DUPLICATE_DATE', 'dayPlans 重複日期');
    seen.add(normalized.localDate);
    out.push(normalized);
  }
  return out;
}

// ============================================================
// 正規化：recheckEvent
// ============================================================
function normalizeRecheckEvent(ownerId, evt) {
  if (!evt || typeof evt !== 'object' || Array.isArray(evt)) throw fault('INVALID_EVENT', 'recheckEvent 格式無效');
  if (evt.ownerId !== ownerId) throw fault('OWNER_MISMATCH', 'recheckEvent owner 不符');
  const eventId = evt.eventId;
  if (typeof eventId !== 'string' || !eventId.trim()) throw fault('INVALID_EVENT_ID', 'recheckEvent 缺少 eventId');
  const wordId = evt.wordId;
  if (!isWordId(wordId)) throw fault('INVALID_WORD_ID', 'recheckEvent 缺少有效 wordId');
  const extra = evt.extra;
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw fault('INVALID_EVENT', 'recheckEvent 缺少 extra');
  if (typeof extra.sessionId !== 'string' || !extra.sessionId.trim()) throw fault('INVALID_SESSION', 'recheckEvent 缺少 sessionId');
  if (!VALID_MODES.has(extra.mode)) throw fault('INVALID_MODE', 'recheckEvent mode 無效');
  if (typeof extra.correct !== 'boolean') throw fault('INVALID_CORRECT', 'recheckEvent correct 非布林');
  if (timeValue(evt.at) == null) throw fault('INVALID_TIME', 'recheckEvent 時間無效');
  // hinted：可選布林（提示後辨認，只保留練習、不列候選）。缺省視為 false，與 false
  // 語義等價；存在但非布林（null／string／number／物件等）一律拒絕，不 String 化冒成功。
  let hinted = false;
  if (extra.hinted !== undefined) {
    if (typeof extra.hinted !== 'boolean') throw fault('INVALID_HINTED', 'recheckEvent hinted 非布林');
    hinted = extra.hinted;
  }
  return {
    eventId,
    ownerId,
    wordId, // 保留原類型（string 或 number）
    type: 'recheck',
    at: evt.at,
    extra: { sessionId: extra.sessionId, mode: extra.mode, correct: extra.correct, hinted },
  };
}

// 事件每 (owner, eventId) 去重；相同 ID 不同 payload 衝突。
function normalizeRecheckEvents(ownerId, events) {
  const seen = new Map();
  const out = [];
  for (const e of events) {
    const n = normalizeRecheckEvent(ownerId, e);
    const key = `${n.ownerId}\u0000${n.eventId}`;
    const existing = seen.get(key);
    if (existing) {
      if (!sameEventPayload(existing, n)) {
        throw fault('EVENT_PAYLOAD_CONFLICT', '相同 eventId 有不同內容');
      }
      continue;
    }
    seen.set(key, n);
    out.push(n);
  }
  return out;
}

// ============================================================
// createLearningBackup(state, { now = new Date() } = {}) -> 同步 envelope
// ============================================================
export function createLearningBackup(state, { now = new Date() } = {}) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw fault('INVALID_STATE', '狀態格式無效');
  const ownerId = ownerString(state.ownerId);
  if (ownerId == null) throw fault('INVALID_OWNER_ID', '缺少 ownerId');

  const dayPlans = normalizeDayPlans(ownerId, Array.isArray(state.dayPlans) ? state.dayPlans : []);
  const recheckEvents = normalizeRecheckEvents(ownerId, Array.isArray(state.recheckEvents) ? state.recheckEvents : []);

  const exportedAt = (now instanceof Date && !Number.isNaN(now.getTime()))
    ? now.toISOString()
    : (timeValue(now) != null ? new Date(timeValue(now)).toISOString() : new Date().toISOString());

  const envelope = {
    format: BACKUP_FORMAT,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    ownerId,
    exportedAt,
    dayPlans,
    recheckEvents,
  };
  const diag = pickDiagnosticDTO(state.diagnostic, ownerId);
  if (diag != null) envelope.diagnostic = diag;
  return envelope;
}

// ============================================================
// validateLearningBackup(value, ownerId) -> 驗證正規化副本（可接 JSON 字串）
// ============================================================
export function validateLearningBackup(value, ownerId) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); }
    catch { throw fault('INVALID_BACKUP', '備份 JSON 損壞'); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fault('INVALID_BACKUP', '備份格式無效');

  // 舊八碼形狀（legacy 分享備份）不認領。
  if (value.format !== BACKUP_FORMAT) {
    if (typeof value.code === 'string' && value.code.length === 8 && value.format == null) {
      throw fault('LEGACY_BACKUP_UNSUPPORTED', '舊八碼備份不支援，不能認領');
    }
    throw fault('INVALID_BACKUP', '備份 format 不符');
  }
  if (value.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    if (value.schemaVersion > BACKUP_SCHEMA_VERSION) throw fault('FUTURE_SCHEMA', '備份版本過新，拒絕');
    throw fault('INVALID_BACKUP', '備份版本不符');
  }

  const wantOwner = ownerString(ownerId);
  if (wantOwner == null) throw fault('INVALID_OWNER_ID', '缺少 ownerId');
  const envOwner = value.ownerId;
  if (typeof envOwner !== 'string' || !envOwner.trim()) throw fault('INVALID_BACKUP', '備份缺少 ownerId');
  if (envOwner !== wantOwner) throw fault('OWNER_MISMATCH', '備份 owner 不符');

  if (!Array.isArray(value.dayPlans)) throw fault('INVALID_BACKUP', 'dayPlans 缺失');
  if (!Array.isArray(value.recheckEvents)) throw fault('INVALID_BACKUP', 'recheckEvents 缺失');

  const dayPlans = normalizeDayPlans(envOwner, value.dayPlans);
  const recheckEvents = normalizeRecheckEvents(envOwner, value.recheckEvents);

  const out = {
    format: BACKUP_FORMAT,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    ownerId: envOwner,
    exportedAt: value.exportedAt,
    dayPlans,
    recheckEvents,
  };
  if (value.diagnostic != null) {
    const dto = pickDiagnosticDTO(value.diagnostic, envOwner);
    if (dto != null) out.diagnostic = dto;
  }
  return out;
}

// ============================================================
// mergeLearningState(local, remote, { preferRemotePlan = true } = {})
// -> { ownerId, revision, dayPlans, recheckEvents }
// ============================================================
export function mergeLearningState(local, remote, { preferRemotePlan = true } = {}) {
  if (!local || typeof local !== 'object' || Array.isArray(local)) throw fault('INVALID_STATE', 'local 格式無效');
  const ownerId = ownerString(local.ownerId);
  if (ownerId == null) throw fault('INVALID_OWNER_ID', '缺少 ownerId');
  if (!remote || typeof remote !== 'object' || Array.isArray(remote)) throw fault('INVALID_STATE', 'remote 格式無效');
  if (remote.ownerId !== ownerId) throw fault('OWNER_MISMATCH', 'remote owner 不符');

  const localPlans = normalizeDayPlans(ownerId, Array.isArray(local.dayPlans) ? local.dayPlans : []);
  const remotePlans = normalizeDayPlans(ownerId, Array.isArray(remote.dayPlans) ? remote.dayPlans : []);

  const remoteByDate = new Map(remotePlans.map((p) => [p.localDate, p]));
  const localByDate = new Map(localPlans.map((p) => [p.localDate, p]));
  const allDates = [...new Set([...remoteByDate.keys(), ...localByDate.keys()])];

  const mergedPlans = [];
  for (const date of allDates) {
    const rp = remoteByDate.get(date);
    const lp = localByDate.get(date);
    const base = preferRemotePlan && rp ? rp : (lp || rp);
    const other = preferRemotePlan && rp ? lp : rp;

    const completedSet = new Set(base.completedIds.map(String));
    if (other) for (const c of other.completedIds) completedSet.add(String(c));

    const newSet = new Set(base.newIds.map(String));
    const reviewSet = new Set(base.reviewIds.map(String));
    const reinSet = new Set((base.reinforcementIds || []).map(String));

    const newOriginals = new Map(base.newIds.map((v) => [String(v), v]));
    const reviewOriginals = new Map(base.reviewIds.map((v) => [String(v), v]));
    const reinOriginals = new Map((base.reinforcementIds || []).map((v) => [String(v), v]));
    const otherNew = other ? new Map(other.newIds.map((v) => [String(v), v])) : new Map();
    const otherReview = other ? new Map(other.reviewIds.map((v) => [String(v), v])) : new Map();
    const otherRein = other ? new Map((other.reinforcementIds || []).map((v) => [String(v), v])) : new Map();

    if (other) {
      for (const c of other.completedIds) {
        const key = String(c);
        if (newSet.has(key) || reviewSet.has(key) || reinSet.has(key)) continue;
        const otherKind =
          otherNew.has(key) ? 'new' :
          otherReview.has(key) ? 'review' :
          otherRein.has(key) ? 'reinforcement' :
          base.reviewIds.map(String).includes(key) ? 'review' :
          base.newIds.map(String).includes(key) ? 'new' :
          (base.reinforcementIds || []).map(String).includes(key) ? 'reinforcement' : 'new';
        if (otherKind === 'review') { reviewSet.add(key); if (!reviewOriginals.has(key)) reviewOriginals.set(key, c); }
        else if (otherKind === 'reinforcement') { reinSet.add(key); if (!reinOriginals.has(key)) reinOriginals.set(key, c); }
        else { newSet.add(key); if (!newOriginals.has(key)) newOriginals.set(key, c); }
      }
    }

    const newArr = [...newSet].filter((id) => !reviewSet.has(id) && !reinSet.has(id)).map((id) => newOriginals.get(id));
    const reviewArr = [...reviewSet].filter((id) => !reinSet.has(id)).map((id) => reviewOriginals.get(id));
    const reinArr = [...reinSet].map((id) => reinOriginals.get(id));

    const plan = {
      ownerId,
      localDate: date,
      revision: base.revision,
      load: base.load,
      reviewIds: reviewArr,
      newIds: newArr,
      completedIds: [...completedSet].map((id) => {
        const src = newOriginals.get(id) ?? reviewOriginals.get(id) ?? reinOriginals.get(id) ?? otherNew.get(id) ?? otherReview.get(id) ?? otherRein.get(id);
        return src !== undefined ? src : id;
      }),
    };
    if (base.reinforcementIds !== undefined || reinArr.length) plan.reinforcementIds = reinArr;
    if (base.attemptId != null) plan.attemptId = base.attemptId;
    if (base.overflowDueIds !== undefined) plan.overflowDueIds = base.overflowDueIds;
    if (base.overflowMustIds !== undefined) plan.overflowMustIds = base.overflowMustIds;
    const mergedRecheck = mergeRecheckBatch(base.recheck, other ? other.recheck : undefined);
    if (mergedRecheck !== undefined) plan.recheck = mergedRecheck;
    mergedPlans.push(plan);
  }

  const localEvents = normalizeRecheckEvents(ownerId, Array.isArray(local.recheckEvents) ? local.recheckEvents : []);
  const remoteEvents = normalizeRecheckEvents(ownerId, Array.isArray(remote.recheckEvents) ? remote.recheckEvents : []);
  const eventMap = new Map();
  for (const e of [...remoteEvents, ...localEvents]) {
    const key = `${e.ownerId}\u0000${e.eventId}`;
    const existing = eventMap.get(key);
    if (existing) {
      if (!sameEventPayload(existing, e)) throw fault('EVENT_PAYLOAD_CONFLICT', '相同 eventId 有不同內容');
      continue;
    }
    eventMap.set(key, e);
  }

  // global revision 採 remote.revision，不和任何 plan revision 混。
  const revision = isSafeNonNegativeInt(remote.revision)
    ? remote.revision
    : (isSafeNonNegativeInt(local.revision) ? local.revision : 0);

  return {
    ownerId,
    revision,
    dayPlans: mergedPlans,
    recheckEvents: [...eventMap.values()],
  };
}

// ============================================================
// learningDigest(value) -> Promise<SHA256 hex>
// 使用 browser crypto.subtle（不 import node:crypto）。
// 忽略 exportedAt；dayPlans 按日期、events 按 ID、集合（completed/overflow）排序；
// 任務清單（new/review/reinforcement）word 順序保留。
// ============================================================
function deepCanonical(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(deepCanonical);
  const out = {};
  for (const k of Object.keys(v).sort()) out[k] = deepCanonical(v[k]);
  return out;
}

function sortByString(a, b) {
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

const SET_FIELDS = new Set(['completedIds', 'overflowDueIds', 'overflowMustIds']);
const ORDERED_FIELDS = new Set(['reviewIds', 'newIds', 'reinforcementIds']);

function canonicalPlan(p) {
  const out = {};
  for (const k of Object.keys(p).sort()) {
    if (SET_FIELDS.has(k)) {
      out[k] = [...(p[k] || [])].sort(sortByString);
    } else if (ORDERED_FIELDS.has(k)) {
      out[k] = [...(p[k] || [])];
    } else if (k === 'recheck') {
      out[k] = deepCanonical(p[k]);
    } else {
      out[k] = p[k];
    }
  }
  return out;
}

function canonicalEvent(e) {
  const out = {};
  for (const k of Object.keys(e).sort()) {
    if (k === 'extra') out[k] = deepCanonical(e[k]);
    else out[k] = e[k];
  }
  return out;
}

function canonicalEnvelope(env) {
  const dayPlans = (env.dayPlans || []).map(canonicalPlan).sort((a, b) => {
    const da = a.localDate ?? '';
    const db = b.localDate ?? '';
    return da < db ? -1 : da > db ? 1 : 0;
  });
  const recheckEvents = (env.recheckEvents || []).map(canonicalEvent).sort((a, b) => {
    const ia = a.eventId ?? '';
    const ib = b.eventId ?? '';
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  });
  const out = {
    format: env.format,
    schemaVersion: env.schemaVersion,
    ownerId: env.ownerId,
    dayPlans,
    recheckEvents,
  };
  if (env.diagnostic != null) out.diagnostic = deepCanonical(env.diagnostic);
  return out;
}

export async function learningDigest(value) {
  const c = globalThis.crypto?.subtle;
  if (!c) throw fault('CRYPTO_UNAVAILABLE', 'crypto.subtle 不可用');
  let obj = value;
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj); }
    catch { throw fault('INVALID_BACKUP', 'digest 內容損壞'); }
  }
  const canonical = JSON.stringify(canonicalEnvelope(obj));
  const data = new TextEncoder().encode(canonical);
  const buf = await c.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
