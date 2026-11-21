// ============================================================
// 題庫來源選擇器（4.3.1 批次 0 基建）
// 各練習引擎共用：單選（radio segmented）或複選（checkbox）
// 來源註冊制：self-made（自製）／real（真題）／ai（AI 題庫）／wordbook:<id>（單詞本）
// ============================================================
import { escapeHtml } from './ui.js';
import { getWordbooks } from '../services/store.js';
import { getWords } from '../services/vocab.js';

/** 產生題庫來源選擇的 HTML（checkbox 複選版）。name 為 radio/checkbox 群名。 */
export function bankPickerHTML({ name, multiple = true, checked = [], sources = null }) {
  const list = sources || bankSources();
  const type = multiple ? 'checkbox' : 'radio';
  return `<div class="bank-picker" role="group" aria-label="題庫來源">${list.map((s) => `
    <label class="bank-item">
      <input type="${type}" name="${name}" value="${escapeHtml(s.id)}"${checked.includes(s.id) ? ' checked' : ''}>
      <span class="bank-item-label">${escapeHtml(s.label)}</span>
      <span class="bank-item-count muted">${s.count != null ? s.count + ' 題' : ''}</span>
    </label>`).join('')}</div>`;
}

/** 讀取勾選的來源 id 陣列。host 為包含 .bank-picker 的容器元素。 */
export function readBankSelection(host, name) {
  return [...host.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => i.value);
}

/** 預設來源清單（含題數；wordbook 來源由呼叫端動態加）。 */
export function bankSources() {
  const out = [
    { id: 'self-made', label: '自製題（站內編寫）' },
    { id: 'real', label: '歷屆真題' },
    { id: 'ai', label: 'AI 題庫' },
  ];
  return out;
}

/** 單詞本來源（動態，async：getWordbooks 走 IndexedDB）：[{id:'wordbook:<id>', label:'單詞本：名稱', count:字數}] */
export async function wordbookSources() {
  const books = await getWordbooks();
  return books.map((b) => ({
    id: `wordbook:${b.id}`,
    label: `單詞本：${b.name}`,
    count: (b.wordIds || []).length,
  }));
}

/**
 * 從勾選的來源取出字池（word 物件陣列）。
 * 回傳 { pool, bySource }——bySource 供來源徽章標示（word.__src）。
 * 注意：real/ai 題庫的「題」不是「字池」——此函式只處理字池型來源（wordbook/字庫範圍），
 * 題庫型來源由各引擎自行載入題庫檔。
 * 4.3.1 批次 1 修復：getWordbooks/getWords 皆為 async（IndexedDB／懶載入），
 * 原碼同步呼叫會拿到 Promise 再 .map/.find → TypeError，單詞本來源整組不可用。
 */
export async function poolFromWordbookSources(selectedIds) {
  const bySource = new Map();
  const pool = [];
  const seen = new Set();
  const all = await getWords();
  // id 一律以字串比對：單詞本 wordIds 來自 IndexedDB／雲端備份，型別可能是 number 或 string
  const byId = new Map(all.map((w) => [String(w.id), w]));
  const books = await getWordbooks();
  for (const sel of selectedIds) {
    if (!sel.startsWith('wordbook:')) continue;
    const wid = sel.slice('wordbook:'.length);
    const book = books.find((b) => String(b.id) === String(wid));
    if (!book) continue;
    const words = (book.wordIds || []).map((id) => byId.get(String(id))).filter(Boolean);
    for (const w of words) {
      if (seen.has(String(w.id))) continue;
      seen.add(String(w.id));
      const tagged = { ...w, __src: `wordbook:${book.name}` };
      pool.push(tagged);
    }
    bySource.set(sel, { label: `單詞本：${book.name}`, words: words.length });
  }
  return { pool, bySource };
}

/** 計算某字池的可用字數（有釋義者）——供 bankPicker 顯示 count。 */
export function countUsable(pool) {
  return pool.filter((w) => (w.senses || []).length > 0).length;
}
