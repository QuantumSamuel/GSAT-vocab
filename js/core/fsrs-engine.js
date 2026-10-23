// ============================================================
// 6.1.1：FSRS 6 排程引擎（純函式層）
// 真演算法一律走 vendor/ts-fsrs-5.4.2.mjs；本檔只做：
//   1. 標記／備份資料的欄位與日期驗證（先驗後寫，避免毀舊資料）
//   2. Date ↔ JSON（ISO 字串）序列化，IndexedDB／雲端備份共用同一格式
//   3. 預覽與評分共用同一個 scheduler 設定（request_retention、關閉 fuzz）
// 卡片狀態的權威來源是標記上的 fsrsState；engine 只在新字加入時決定一次。
// ============================================================
import { fsrs, createEmptyCard, Rating } from '../vendor/ts-fsrs-5.4.2.mjs';

export const FSRS_ENGINE = 'fsrs6';
export const FIXED_ENGINE = 'fixed';
export const DEFAULT_RETENTION = 0.9;

const RATING_KEYS = { again: Rating.Again, hard: Rating.Hard, good: Rating.Good };
const NUMERIC_FIELDS = [
  'stability', 'difficulty', 'elapsed_days', 'scheduled_days',
  'reps', 'lapses', 'learning_steps',
];
// reps／lapses／learning_steps 是次數或步數，必須是非負整數；
// 其餘排程量可以是小數（stability／difficulty），但不得為負。
const INTEGER_FIELDS = new Set(['reps', 'lapses', 'learning_steps']);
const MAX_DIFFICULTY = 10;

function isValidWordId(wordId) {
  if (typeof wordId === 'number') return Number.isFinite(wordId);
  if (typeof wordId === 'string') return wordId.trim().length > 0;
  return false;
}

export function isFsrsEngine(engine) {
  return engine === FSRS_ENGINE;
}

export function parseValidDate(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value);
  if (typeof value === 'string' && value.trim()) {
    const d = new Date(value);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  return null;
}

export function normalizeRetention(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : DEFAULT_RETENTION;
}

function scheduler(retention) {
  return fsrs({ request_retention: normalizeRetention(retention), enable_fuzz: false });
}

// 把任何來源的 fsrsState（Date 或 JSON 字串）驗證並轉成可安全儲存的形狀。
// 數值欄位必須齊全、有限且非負；reps／lapses／learning_steps 另須是整數；
// difficulty 限 vendor 範圍 0～10；state 必須是 0～3 的整數；due 必須是有效日期；
// last_review 可省略（新卡），有值時也必須有效。缺一即擲錯，呼叫端不得先清舊資料。
export function normalizeFsrsState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('INVALID_FSRS_STATE');
  }
  // 先保留原始欄位（含 vendor 日後新增的狀態欄位），再逐項覆蓋正規化值。
  const out = { ...raw };
  for (const field of NUMERIC_FIELDS) {
    const value = raw[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`INVALID_FSRS_STATE:${field}`);
    }
    if (INTEGER_FIELDS.has(field) && !Number.isInteger(value)) {
      throw new Error(`INVALID_FSRS_STATE:${field}`);
    }
    out[field] = value;
  }
  if (raw.difficulty > MAX_DIFFICULTY) {
    throw new Error('INVALID_FSRS_STATE:difficulty');
  }
  if (!Number.isInteger(raw.state) || raw.state < 0 || raw.state > 3) {
    throw new Error('INVALID_FSRS_STATE:state');
  }
  const due = parseValidDate(raw.due);
  if (!due) throw new Error('INVALID_FSRS_STATE:due');
  out.due = due.toISOString();
  out.state = raw.state;
  if (raw.last_review !== undefined && raw.last_review !== null) {
    const last = parseValidDate(raw.last_review);
    if (!last) throw new Error('INVALID_FSRS_STATE:last_review');
    out.last_review = last.toISOString();
  } else {
    delete out.last_review;
  }
  return out;
}

function toVendorCard(state) {
  const card = {
    due: new Date(state.due),
    stability: state.stability,
    difficulty: state.difficulty,
    elapsed_days: state.elapsed_days,
    scheduled_days: state.scheduled_days,
    reps: state.reps,
    lapses: state.lapses,
    learning_steps: state.learning_steps,
    state: state.state,
  };
  if (state.last_review) card.last_review = new Date(state.last_review);
  return card;
}

export function newFsrsState(now = new Date()) {
  return normalizeFsrsState(createEmptyCard(now));
}

export function normalizeRating(action) {
  if (typeof action === 'string' && Object.prototype.hasOwnProperty.call(RATING_KEYS, action)) {
    return action;
  }
  // 固定排程的舊 boolean 介面若誤用到 FSRS 卡：true 只代表「記得」＝Good，
  // false＝Again；Hard 只能由明確的 'hard' 字串表達，不得被 truthy 當成 Good。
  if (action === true) return 'good';
  if (action === false) return 'again';
  throw new Error('INVALID_FSRS_RATING');
}

function nextState(state, grade, at, retention) {
  const now = parseValidDate(at) || new Date();
  const item = scheduler(retention).next(toVendorCard(state), now, RATING_KEYS[grade]);
  return normalizeFsrsState(item.card);
}

// 純預覽：回傳三鍵各自的下次狀態／到期時間，不寫入、不改動傳入狀態。
export function previewFsrs(state, at = new Date(), retention = DEFAULT_RETENTION) {
  const normalized = normalizeFsrsState(state);
  const out = { engine: FSRS_ENGINE };
  for (const grade of Object.keys(RATING_KEYS)) {
    const next = nextState(normalized, grade, at, retention);
    out[grade] = { dueAt: next.due, state: next };
  }
  return out;
}

// 正式評分：與 previewFsrs 走同一個 vendor scheduler 與同一份狀態格式。
export function applyFsrsReview(state, action, at = new Date(), retention = DEFAULT_RETENTION) {
  const grade = normalizeRating(action);
  const next = nextState(normalizeFsrsState(state), grade, at, retention);
  return { grade, dueAt: next.due, state: next };
}

// 匯入／同步用：任何標記都要先通過這裡才能進入寫入交易。
// 合法 legacy（無 engine、無 fsrsState）保留其他欄位，缺 stage／addedAt 先補安全值；
// 有 fsrsState 或 engine='fsrs6' 的列，數值、state、日期必須完整有效，addedAt 有值也必須有效。
export function normalizeMarkRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('INVALID_MARK_RECORD');
  }
  if (!isValidWordId(record.wordId)) {
    throw new Error('INVALID_MARK_RECORD:wordId');
  }
  const out = { ...record };
  const hasFsrs = record.engine === FSRS_ENGINE || record.fsrsState !== undefined;
  if (hasFsrs) {
    if (record.engine !== undefined && record.engine !== FSRS_ENGINE) {
      throw new Error('INVALID_FSRS_STATE:engine');
    }
    if (record.fsrsState === undefined) throw new Error('INVALID_FSRS_STATE:missing');
    out.engine = FSRS_ENGINE;
    const state = normalizeFsrsState(record.fsrsState);
    // addedAt 是舊欄位但仍會參與排序與顯示；有值就必須是有效日期，不可默默吞掉。
    if (record.addedAt !== undefined) {
      const added = parseValidDate(record.addedAt);
      if (!added) throw new Error('INVALID_FSRS_STATE:addedAt');
      out.addedAt = added.toISOString();
    } else {
      out.addedAt = state.last_review || state.due;
    }
    const dueAt = record.dueAt === undefined ? new Date(state.due) : parseValidDate(record.dueAt);
    if (!dueAt) throw new Error('INVALID_FSRS_STATE:markDue');
    out.dueAt = dueAt.toISOString();
    // 手動改期只改 dueAt 時，狀態的 due 必須跟著同步，避免預覽／評分用舊日期。
    out.fsrsState = { ...state, due: out.dueAt };
  } else {
    if (record.engine !== undefined && record.engine !== FIXED_ENGINE) {
      throw new Error('INVALID_MARK_RECORD:engine');
    }
    for (const field of ['dueAt', 'addedAt']) {
      if (record[field] === undefined) continue;
      const d = parseValidDate(record[field]);
      if (!d) throw new Error(`INVALID_MARK_RECORD:${field}`);
      out[field] = d.toISOString();
    }
    // 最小 legacy（只有 wordId）也要能安全落地：缺 addedAt 先補當下時間，
    // stage／dueAt 仍由 getUnknownMarks 依原固定排程 fallback 補齊。
    if (out.addedAt === undefined) out.addedAt = new Date().toISOString();
    if (out.stage === undefined) out.stage = 0;
  }
  return out;
}

export function normalizeMarkRecords(rows) {
  if (!Array.isArray(rows)) throw new Error('INVALID_MARK_RECORDS');
  return rows.map(normalizeMarkRecord);
}
