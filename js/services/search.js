// ============================================================
// 單字搜尋服務（3.0.3 分層重構）：全站唯一的字庫索引
// 查詢頁（lookup）與單詞本導入驗證（unknown）共用同一套，
// 終結兩套索引行為不一致的問題
// ============================================================
import { getWords } from './vocab.js';

let byWord = null; // 小寫單字（含展開形式）→ 單字資料
let byId = null;   // id → 單字資料

// 展開合併形式：'a/an'、'he (him, his)'（歷史資料相容）→ 多個查找鍵
function expandWord(word) {
  const s = String(word).toLowerCase().replace(/\s+/g, '');
  const keys = new Set([s]);
  for (const part of s.split('/')) {
    keys.add(part);
    const m = part.match(/^(.+?)\(([^()]+)\)(.*)$/);
    if (m) {
      const [, base, opt, tail] = m;
      keys.add(base + tail);
      keys.add(base + opt + tail);
      if (opt.includes(',')) {
        for (const item of opt.split(',')) {
          if (item.trim()) keys.add(item.trim());
        }
      }
    }
  }
  keys.delete('');
  return [...keys];
}

export function wordIndex() {
  if (!byWord) {
    // 4.1.0 修復（索引毒化）：先建局部 Map，成功後才寫入模組快取——
    // getWords() 拋錯時 byWord 保持 null，下次呼叫會重試而非永久卡在空索引
    const map = new Map();
    for (const w of getWords()) {
      for (const key of expandWord(w.word)) {
        if (!map.has(key)) map.set(key, w); // 重複單字保留第一筆（比照舊版）
      }
    }
    byWord = map;
  }
  return byWord;
}

export function idIndex() {
  if (!byId) {
    const map = new Map(); // 4.1.0 修復：同 wordIndex，失敗不留半成品
    for (const w of getWords()) map.set(w.id, w);
    byId = map;
  }
  return byId;
}

// 精確查一個字（已 lowercase）
export function findWord(token) {
  return wordIndex().get(String(token).toLowerCase()) ?? null;
}

// 批次驗證（單詞本導入用）：回傳 { valid:[word], invalid:[token] }，自動去重
export function verifyTokens(tokens) {
  const valid = [];
  const invalid = [];
  const seen = new Set();
  for (const t of tokens) {
    const w = wordIndex().get(String(t).toLowerCase());
    if (!w) { invalid.push(t); continue; }
    if (seen.has(w.id)) continue;
    seen.add(w.id);
    valid.push(w);
  }
  return { valid, invalid };
}

// 切分輸入：空格／逗號／分號／頓號／換行／tab（單詞本導入與後台發佈共用）
// 4.0.2：先展開「word(變化1, 變化2)」括號形式（如 coincidence(coincide, coincidental)
// → coincidence coincide coincidental）；大小寫視為同一字去重（保留原順序與原寫法）
export function parseWordTokens(text) {
  const expanded = String(text || '')
    .replace(/([A-Za-z][A-Za-z'\u2019\-]*)\s*\(([^()]+)\)/g, (_m, base, inner) => `${base} ${inner}`);
  const seen = new Set();
  const out = [];
  for (const tok of expanded.split(/[\s,;，；、]+/)) {
    const w = tok.replace(/^[.。'"()（）]+|[.。'"()（）]+$/g, '');
    if (!w) continue;
    const k = w.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(w);
  }
  return out;
}

// ---------- 相近字建議（查詢頁查不到時） ----------
export function suggestions(q) {
  const lower = q.toLowerCase();
  const starts = [];
  const contains = [];
  const typos = [];
  for (const key of wordIndex().keys()) {
    if (key === lower) continue;
    if (key.startsWith(lower)) starts.push(key);
    else if (lower.length >= 3 && key.includes(lower)) contains.push(key);
    else if (Math.abs(key.length - lower.length) <= 2 && editDistance(key, lower) <= 2) typos.push(key);
  }
  const out = [...starts.slice(0, 8), ...contains.slice(0, 4)];
  if (out.length === 0) out.push(...typos.sort((a, b) => a.length - b.length).slice(0, 5));
  return out;
}

// 簡易編輯距離（錯字建議用；字庫 7100 字逐一比對也夠快）
function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 99; // 快速排除，避免長度差太多的字做完整比對
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,        // 刪除
        cur[j - 1] + 1,     // 插入
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1), // 替換
      );
    }
    prev = cur;
  }
  return prev[n];
}
