// ============================================================
// 6.0.2 短複測與滾動校準：證據判定（純函式）
//
// 目的：用「recheck」事件判定某字是否仍弱，或足以當作短複測精熟候選。
// 刻意不直接改 SRS / graduate：此模組只回狀態與建議，資料寫入由呼叫端決定。
//
// 已核准規則（使用者定案，2026-10-14）：
//   1. 一筆有效證據必須具備：非空 ownerId、有效 wordId、有效 sessionId、
//      有效時間、mode 僅限 recognition／recall、correct 必須是布林值。
//      任一缺漏或歧義者保守排除，不計入樣本（不因此升級精熟）。
//   2. 以 owner／word／session 三個維度隔離；不同 owner 的證據互不影響。
//   3. 同一個 session 內多次作答「只算一個樣本」；且該 session 只要曾出現
//      一次答錯，之後在同場重答正確也不會被洗掉——該 session 一律視為失誤。
//   4. 取「最近 3 個不同 session」：全對且其中至少 1 個 session 含一次
//      無提示（recall）成功，才回 mastered_candidate。
//   5. 只標短複測達標候選，不直接使 SRS 畢業：本模組不回傳 graduate 指令。
//   6. 排序一律以「數值時間」為主鍵（支援 number epoch 或可解析的 ISO 字串），
//      不以 at|id 之類的字串拼接排序；時間相同時以 sessionId、id 做穩定 tie-break。
//
// 已核准規則（提示後辨認只算練習，2026-10-15）：
//   7. extra.hinted 為 optional boolean；缺省等同 false（legacy 相容，不臆測改寫）。
//      新增的 fallback recognition（提示後辨認）一律必帶 hinted:true；recall 為 false 或缺省。
//      帶了 hinted 但型別非布林者，一律視為無效證據排除（不計樣本）。
//   8. 只有「合格場次」（該場至少一次未 hinted 作答）才加 1 達標樣本；僅 hinted 作答的場次
//      只作練習，不計樣本、也不算成功 recall。任一錯誤（含僅 hinted 的錯誤場次）不可被洗掉。
//   9. 取最近 requiredSamples 個合格場次，全對且 >= requiredRecall 次成功 recall 才回
//      mastered_candidate；窗起點之後若有任何失誤（含其間／之後的僅 hinted 錯誤場次），
//      不得忽略而拿更舊的合格場次認定達標，需「錯後」再有足夠合格全對場次才恢復。
// ============================================================

export const RECHECK_VERSION = 'recheck-2-v1';
export const DEFAULT_REQUIRED_SAMPLES = 3;
export const DEFAULT_REQUIRED_RECALL = 1;

const VALID_MODES = new Set(['recognition', 'recall']);

// 有效時間：可轉成有限數值（number epoch ms 或可 Date.parse 的字串）。
function timeValue(at) {
  if (typeof at === 'number' && Number.isFinite(at)) return at;
  if (typeof at === 'string' && at.trim()) {
    const t = Date.parse(at);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

function nonEmptyString(v) {
  return (typeof v === 'string' && v.trim()) ? v : (typeof v === 'number' && Number.isFinite(v) ? String(v) : null);
}

// 一筆證據是否有效；無效者一律排除，不回傳部分欄位。
export function isValidRecheck(e) {
  if (!e || e.type !== 'recheck') return false;
  if (nonEmptyString(e.ownerId) == null) return false;
  if (nonEmptyString(e.wordId) == null) return false;
  const extra = e.extra;
  if (!extra || typeof extra !== 'object') return false;
  if (nonEmptyString(extra.sessionId) == null) return false;
  if (!VALID_MODES.has(extra.mode)) return false;
  if (typeof extra.correct !== 'boolean') return false;
  // extra.hinted 為可選布林：缺省＝false（legacy 相容）；有值但非布林 → 視為歧義，排除。
  if (Object.hasOwn(extra, 'hinted') && typeof extra.hinted !== 'boolean') return false;
  if (timeValue(e.at) == null) return false;
  return true;
}

function attemptKey(ownerId, wordId) {
  return `${ownerId}\u0000${wordId}`;
}

// session 內穩定排序用的次鍵：時間 → 序號 → id。
function attemptOrder(a, b) {
  const ta = timeValue(a.at);
  const tb = timeValue(b.at);
  if (ta !== tb) return ta - tb;
  const ia = a.seq ?? 0;
  const ib = b.seq ?? 0;
  if (ia !== ib) return ia - ib;
  const ida = nonEmptyString(a.id) ?? '';
  const idb = nonEmptyString(b.id) ?? '';
  return ida < idb ? -1 : ida > idb ? 1 : 0;
}

/**
 * 依附 owner + word 分組，回傳每個 (ownerId, wordId) 的 session 聚合結果。
 * 每個 session 聚合成：
 *   { sessionId, at（該 session 內最晚時間）, correct（只要曾錯即 false）,
 *     qualified（該場至少一次未 hinted 作答）,
 *     recall（含一次未提示成功 recall） }
 * 回傳 Map<string, SessionVerdict[]>，key 為 `${ownerId}\0${wordId}`。
 */
export function normalizeRecheckEvents(events = []) {
  const grouped = new Map(); // attemptKey -> Map<sessionId, attempts[]>
  let seq = 0;
  for (const e of events) {
    if (!isValidRecheck(e)) continue;
    const key = attemptKey(nonEmptyString(e.ownerId), nonEmptyString(e.wordId));
    if (!grouped.has(key)) grouped.set(key, new Map());
    const bySession = grouped.get(key);
    const sid = nonEmptyString(e.extra.sessionId);
    if (!bySession.has(sid)) bySession.set(sid, []);
    bySession.get(sid).push({ ...e, seq: seq++ });
  }
  const out = new Map();
  for (const [key, bySession] of grouped) {
    const verdicts = [];
    for (const [sessionId, attempts] of bySession) {
      attempts.sort(attemptOrder);
      const last = attempts[attempts.length - 1];
      const correct = attempts.every((a) => a.extra.correct === true);
      // 合格場次：至少一次「未 hinted」作答（recall 一律未提示；recognition 需 hinted 不為 true）。
      const qualified = attempts.some((a) => a.extra.hinted !== true);
      // 成功 recall 必須是未提示（hinted 不成立）且答對；hinted 只作練習，不算成功 recall。
      const recall = attempts.some((a) => a.extra.mode === 'recall' && a.extra.correct === true && a.extra.hinted !== true);
      verdicts.push({
        sessionId,
        at: last.at,
        seq: last.seq,
        correct,
        qualified,
        recall,
        wrongCount: attempts.filter((a) => a.extra.correct !== true).length,
        attemptCount: attempts.length,
      });
    }
    out.set(key, verdicts);
  }
  return out;
}

function sessionOrder(a, b) {
  const ta = timeValue(a.at);
  const tb = timeValue(b.at);
  if (ta !== tb) return ta - tb;
  const sa = nonEmptyString(a.sessionId) ?? '';
  const sb = nonEmptyString(b.sessionId) ?? '';
  if (sa !== sb) return sa < sb ? -1 : 1;
  return (a.seq ?? 0) - (b.seq ?? 0);
}

/**
 * 回傳單字的短複測狀態（需指定 ownerId 與 wordId）：
 *  - insufficient：合格（未 hinted）session 樣本 < requiredSamples
 *  - weak：最近 requiredSamples 個合格 session 的窗起點之後有任何失誤
 *          （含該窗內或之後的僅 hinted 錯誤場次）
 *  - learning：合格樣本足、全對，但成功無提示 recall 次數不足
 *  - mastered_candidate：最近 requiredSamples 個合格 session 全對，且 recall >= requiredRecall
 */
export function recheckStatus(events = [], {
  ownerId,
  wordId,
  requiredSamples = DEFAULT_REQUIRED_SAMPLES,
  requiredRecall = DEFAULT_REQUIRED_RECALL,
} = {}) {
  if (nonEmptyString(ownerId) == null) throw new Error('INVALID_OWNER_ID');
  if (nonEmptyString(wordId) == null) throw new Error('INVALID_WORD_ID');
  if (!Number.isInteger(requiredSamples) || requiredSamples < 1) throw new Error('INVALID_SAMPLES');
  if (!Number.isInteger(requiredRecall) || requiredRecall < 0) throw new Error('INVALID_RECALL');
  const mapped = normalizeRecheckEvents(events);
  const all = (mapped.get(attemptKey(nonEmptyString(ownerId), nonEmptyString(wordId))) || [])
    .slice()
    .sort(sessionOrder);
  // 僅合格場次（至少一次未 hinted 作答）計入達標樣本；僅 hinted 的場次只作練習。
  const qualified = all.filter((s) => s.qualified);
  if (qualified.length < requiredSamples) {
    return {
      status: 'insufficient',
      samples: qualified.length,
      requiredSamples,
      recallCount: qualified.filter((s) => s.recall).length,
    };
  }
  // 取最近 requiredSamples 個合格場次為判定窗；但「窗起點之後」（含窗內與其後）出現的
  // 任何失誤都不可被忽略——包含僅 hinted 的錯誤場次，故一併納入 span 檢查。
  const window = qualified.slice(-requiredSamples);
  const spanStart = all.indexOf(window[0]);
  const span = all.slice(spanStart < 0 ? 0 : spanStart);
  const wrongCount = span.filter((s) => s.correct !== true).length;
  const recallCount = window.filter((s) => s.recall).length;
  if (wrongCount > 0) {
    return { status: 'weak', samples: window.length, requiredSamples, recallCount, wrongCount };
  }
  if (recallCount < requiredRecall) {
    return { status: 'learning', samples: window.length, requiredSamples, recallCount, requiredRecall };
  }
  return { status: 'mastered_candidate', samples: window.length, requiredSamples, recallCount, requiredRecall };
}

/**
 * 現行使用者可看到的簡短描述，供 UI 之後使用，不在這裡接 DOM。
 */
export function recheckLabel(status) {
  switch (status) {
    case 'mastered_candidate': return '短複測已達標';
    case 'learning': return '尚需回想證據';
    case 'weak': return '建議再補強';
    default: return '樣本不足';
  }
}
