// ============================================================
// 6.0.2 短複測服務層：把「本機證據儲存」與「純函式判定」接起來。
//
// 刻意只做本機讀取與判定，不回傳任何 SRS 指令：
//   - 只提供 mastered_candidate 這個「候選」狀態，不呼叫 graduate。
//   - 不接 UI、不產生複測份量、不觸發雲端同步（依 6.0.2 規格）。
// ============================================================
import { recheckStatus, recheckLabel } from '../core/recheck.js';
import { appendRecheckEvent, listRecheckEvents, listOwnerRecheckEvents } from './diagnostic-store.js';

/**
 * 記錄一筆短複測證據（帳戶隔離、eventId 冪等）。
 * 缺 owner／session／word／有效時間、或 correct 非布林、mode 非法的，
 * 由 diagnostic-store 拒收並丟出對應錯誤碼。
 */
export async function recordRecheck(ownerId, event) {
  return appendRecheckEvent(ownerId, event);
}

/**
 * 依本機證據計算某字的短複測狀態（含 UI 用標籤）。
 * events 可由呼叫端注入（測試用）；未提供時自動由儲存層讀取。
 */
export async function getRecheckStatus(ownerId, wordId, { events, ...options } = {}) {
  const source = events ?? await listRecheckEvents(ownerId, wordId);
  const result = recheckStatus(source, { ownerId, wordId, ...options });
  return { ...result, label: recheckLabel(result.status) };
}

/**
 * 批次計算某帳戶所有字（或指定字集合）的短複測狀態。
 * 只讀一次儲存層後在記憶體依字分組，避免逐字開交易。
 */
export async function listRecheckStatuses(ownerId, wordIds, options = {}) {
  const all = await listOwnerRecheckEvents(ownerId);
  const byWord = new Map();
  for (const e of all) {
    const key = String(e.wordId);
    if (!byWord.has(key)) byWord.set(key, []);
    byWord.get(key).push(e);
  }
  const ids = wordIds == null ? [...byWord.keys()] : wordIds.map(String);
  const out = new Map();
  for (const id of ids) {
    const result = recheckStatus(byWord.get(id) || [], { ownerId, wordId: id, ...options });
    out.set(id, { ...result, label: recheckLabel(result.status) });
  }
  return out;
}
