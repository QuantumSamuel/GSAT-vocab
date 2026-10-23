// ============================================================
// 6.0.2 短複測「當日批次」純流程（core/recheck-session.js）
//
// 目的：把「當日任務字」轉成一批最多 3／5／8 字（輕量／標準／加強）的短複測，
//   逐字「先中文→輸入英文無提示回想；答不出可轉英文→四張中文選項卡辨認」。
//   本模組只做純函式（無 DOM、無 IDB、無時間窗、無 token、不呼叫模型），
//   資料寫入交給 services/recheck-session.js；判定交給 core/recheck.js。
//
// 已核准規則（使用者核准第二批，2026-10-15）：
//   1. 只從「當日任務字」取樣，最多輕量 3／標準 5／加強 8 個不同字；不增加今日任務字數，
//      也不自動完成原學習／複習任務。
//   2. 回想（recall）＝中文意思為提示、輸入英文；比對前 trim＋大小寫正規化。
//      提示不得洩漏英文答案（沿用既有的前綴洩漏過濾精神）。
//   3. 答不出可轉「辨認（recognition）」：揭示英文＋四張中文選項卡。
//      只要曾揭示英文，該字本場就不得再算無提示回想。
//   4. 轉題型不得把「不知道」洗成正確 recall；只有實際提交的回想才具回想證據。
//   5. 逐字只產生「一筆」最強證據（事件）：曾提交回想 → recall；否則辨認 → recognition；
//      兩者皆無 → 不產生事件（該字未作答）。
//   5b. 提示後辨認（fallback recognition）必帶 extra.hinted:true（只算練習）；無提示回想帶
//      hinted:false。呼叫端把此旗標原樣帶入事件 extra。
//   6. 負載升降只增刪「未作答」的字；已作答者一律保留，不重排。
//   7. 事件 eventId 由 sessionId＋wordId 穩定推導：重試沿用同一 eventId（冪等）。
//
// 【範圍界線】不改 SRS／marks／dueAt；不生成逐字歷史；未知或缺 owner 的舊 quiz 不得導入。
// ============================================================

export const RECHECK_SESSION_VERSION = 'recheck-session-1';

// 輕量／標準／加強對應的短複測字數上限（與 daily-plan 的 LOADS 三檔一致）
export const RECHECK_CAPS = Object.freeze({ light: 3, standard: 5, intensive: 8 });

export function recheckCap(load) {
  if (!Object.hasOwn(RECHECK_CAPS, load)) throw new Error('INVALID_LOAD');
  return RECHECK_CAPS[load];
}

// ---------- 回想比對 ----------
// 正規化：trim＋小寫。刻意不折疊多重空白（片語為單字，維持既有語意即可）。
export function normalizeAnswerInput(value) {
  return String(value ?? '').trim().toLowerCase();
}

// 提交的回想是否正確：輸入與正解在 trim＋大小寫正規化後完全相同。
export function judgeRecall(input, answer) {
  const expected = normalizeAnswerInput(answer);
  if (!expected) return false;
  return normalizeAnswerInput(input) === expected;
}

// ---------- 回想提示：不得洩漏英文答案 ----------
// 與 practice/spelling.js 的 zhForPrompt 同一精神（前綴洩漏視為洩漏），但在本模組獨立實作：
// core 不可反向依賴 pages。規則：
//   senses 中任一提示若含拉丁 token，且與正解（或其字首）互為前綴且長度 ≥3 → 洩漏。
//   依序嘗試：① 原提示 → ② 拿掉含拉丁字母的括號註解 → ③ 換其他 sense → ④ 中性文案。
function latinTokens(text) {
  return (String(text ?? '').toLowerCase().match(/[a-z][a-z'-]*/g) || [])
    .map((x) => x.replace(/'s$/, '').replace(/s$/, ''))
    .filter((x) => x.length >= 3);
}
function leaksAnswer(prompt, answerParts) {
  if (!answerParts.length) return false;
  return latinTokens(prompt).some((tok) => answerParts.some((a) => a.startsWith(tok) || tok.startsWith(a)));
}
export function safeRecallPrompt(senses, { answer } = {}) {
  const list = Array.isArray(senses) ? senses.filter(Boolean).map((s) => String(s).trim()).filter(Boolean) : [];
  if (!list.length) return '';
  const answerParts = String(answer ?? '').split(/\s+/).filter(Boolean)
    .map((w) => w.toLowerCase().replace(/'s$/, '').replace(/s$/, ''))
    .filter((w) => w.length >= 3);
  for (const s of list) {
    if (!leaksAnswer(s, answerParts)) return s;
  }
  for (const s of list) {
    const noParen = s.replace(/[（(][^）)]*[A-Za-z][^）)]*[）)]/g, '').trim();
    if (noParen && !leaksAnswer(noParen, answerParts)) return noParen;
  }
  return '請依中文意思拼出這個單字';
}

// ---------- 辨認題：四張中文選項卡 ----------
// 正解＝該字的第一個（未洩漏的）中文意思；干擾＝同池其他字的 sense。
// 回傳 [{text, correct}]，固定 count 張（不足時回實際可得張數）。順序未洗牌，由呼叫端洗。
export function buildRecognitionOptions(word, pool, { count = 4 } = {}) {
  const correctText = safeRecallPrompt(word?.senses, { answer: word?.word });
  if (!correctText) return [];
  // 同字的其他已知詞義不能被當成錯誤選項（例如 bank 的「河岸」）。
  const used = new Set([correctText, ...(word.senses || []).map((sense) => safeRecallPrompt([sense], { answer: word.word }))]);
  const options = [{ text: correctText, correct: true }];
  for (const w of (Array.isArray(pool) ? pool : [])) {
    if (options.length >= count) break;
    if (String(w?.id) === String(word?.id) || String(w?.word) === String(word?.word)) continue;
    const t = safeRecallPrompt(w?.senses, { answer: w?.word });
    if (!t || used.has(t)) continue;
    used.add(t);
    options.push({ text: t, correct: false });
  }
  return options;
}

// ---------- 取樣：當日任務字中挑短複測字 ----------
// 順序：① 指定優先弱字（priorIds，存在於計畫中者）② 到期複習 ③ 學習新字。
// 只取「當日任務字」（reviewIds∪newIds），不新增字、不改任務。回傳去重後的 id 陣列（≤ cap）。
export function pickRecheckWordIds({ plan, cap, priorIds = [] } = {}) {
  if (!plan) return [];
  if (!Number.isInteger(cap) || cap < 0) throw new Error('INVALID_CAP');
  const reviewIds = Array.isArray(plan.reviewIds) ? plan.reviewIds : [];
  const newIds = Array.isArray(plan.newIds) ? plan.newIds : [];
  const reinforcementIds = Array.isArray(plan.reinforcementIds) ? plan.reinforcementIds : [];
  const inPlan = new Set([...reviewIds, ...newIds, ...reinforcementIds].map((id) => String(id)));
  const out = [];
  const seen = new Set();
  const push = (id) => {
    const key = String(id);
    if (!inPlan.has(key) || seen.has(key) || out.length >= cap) return;
    seen.add(key);
    out.push(id);
  };
  for (const id of priorIds) push(id);
  for (const id of reviewIds) push(id);
  for (const id of newIds) push(id);
  for (const id of reinforcementIds) push(id);
  return out;
}

// ---------- 負載升降：只增刪未作答 ----------
// 已作答（answeredIds）的字一律保留；未作答者依 nextIds 補足到 cap，超出者刪除。
// 回傳新的 wordIds（字串）。順序維持：先保留已作答（原順序），再依 nextIds 補未作答。
// 已作答者即使數量 > cap（降載）也全數保留，僅未作答縮減——不得丟掉已答 4/5。
export function reconcileRecheckWordIds({ currentIds = [], answeredIds = [], nextIds = [], cap } = {}) {
  if (!Number.isInteger(cap) || cap < 0) throw new Error('INVALID_CAP');
  // 比較一律用 String；但輸出保留原始 wordId 型別（數字仍是數字）。
  const answered = new Set((answeredIds || []).map(String));
  const kept = (currentIds || []).filter((id) => answered.has(String(id)));
  const keptSet = new Set(kept.map(String));
  const out = [...kept];
  for (const id of (nextIds || [])) {
    if (out.length >= cap) break;
    if (keptSet.has(String(id))) continue;
    keptSet.add(String(id));
    out.push(id);
  }
  return out;
}

// ---------- 逐字進度狀態機 ----------
export function newProgressEntry() {
  return {
    phase: 'recall',            // 'recall' | 'recognition'
    revealedEnglish: false,     // 是否已揭示英文（顯示過答案）
    recallSubmitted: false,     // 是否實際提交過回想
    recallCorrect: null,        // 提交回想的結果（布林）／未提交為 null
    recognitionAnswered: false, // 是否提交過辨認
    recognitionCorrect: null,
    answered: false,            // 該字本場是否已作答（回想或辨認其一）
    eventId: null,              // 提交時寫入的穩定 eventId（供重試冪等）
  };
}

// 提交回想。已揭示英文且尚未提交過回想者不得再算回想（回傳原狀態、標記 rejected）。
// 本場一旦已提交過回想（recallSubmitted），證據即凍結：不得因再次提交而改寫 recallCorrect，
// 亦即「先答錯、再答對」不會把曾錯的回想洗成正確（守衛，不只靠 UI 禁鈕）。
export function applyRecallSubmit(progress, { input, answer } = {}) {
  const p = { ...newProgressEntry(), ...progress };
  if (p.revealedEnglish && !p.recallSubmitted) {
    return { ...p, rejected: 'REVEALED' };
  }
  if (p.recallSubmitted) {
    // 已提交過回想：保守保留本場結果，不得重答灌樣本。
    return { ...p, rejected: null };
  }
  const correct = judgeRecall(input, answer);
  return {
    ...p,
    recallSubmitted: true,
    recallCorrect: correct,
    answered: true,
    // 回想錯誤＝等同「答不出」：揭示英文並轉辨認，但證據仍是 recall=false（不洗成正確 recall）
    revealedEnglish: correct ? p.revealedEnglish : true,
    phase: correct ? 'recall' : 'recognition',
    rejected: null,
  };
}

// 「不知道」：揭示英文、轉辨認。不改 recall 證據（仍是未提交）。
// 已揭示英文或已提交回想者，不得把已揭示英文倒退回「無提示回想」狀態。
export function applyReveal(progress) {
  const p = { ...newProgressEntry(), ...progress };
  if (p.revealedEnglish || p.recallSubmitted) {
    return { ...p, rejected: null };
  }
  return { ...p, revealedEnglish: true, phase: 'recognition', rejected: null };
}

// 提交辨認（四張中文選項卡）。correct 由呼叫端依正解判定後帶入（布林）。
// 已提交過辨認者，不得重答改寫本場結果（守衛）。
export function applyRecognitionSubmit(progress, { correct } = {}) {
  const p = { ...newProgressEntry(), ...progress };
  if (typeof correct !== 'boolean') throw new Error('INVALID_CORRECT');
  if (p.recognitionAnswered) return { ...p, rejected: null };
  return { ...p, recognitionAnswered: true, recognitionCorrect: correct, answered: true, rejected: null };
}

// 穩定 eventId：同 session＋同字永遠相同 → 重試沿用，配合 store 的 eventId 冪等語意。
export function recheckEventId(sessionId, wordId) {
  if (sessionId == null || String(sessionId).trim() === '') throw new Error('INVALID_SESSION');
  return `rc:${sessionId}:${wordId}`;
}

// 由逐字進度推導「一筆最強證據」：曾提交回想 → recall；否則辨認 → recognition；皆無 → null。
// 這是「只有實際回想提交才有回想證據」的唯一出口；不接受任何型別轉換把未提交洗成回想。
// extra.hinted 旗標：辨認一律是「提示後辨認」（fallback recognition）→ 必帶 hinted:true；
//   回想為無提示 → hinted:false。呼叫端（services eventBuilder）據此把旗標原樣帶入 extra。
export function evidenceForWord(wordId, progress, sessionId) {
  if (!progress || !progress.answered) return null;
  const eventId = progress.eventId || recheckEventId(sessionId, wordId);
  if (progress.recallSubmitted) {
    return { eventId, wordId, mode: 'recall', correct: progress.recallCorrect === true, hinted: false };
  }
  if (progress.recognitionAnswered) {
    return { eventId, wordId, mode: 'recognition', correct: progress.recognitionCorrect === true, hinted: true };
  }
  return null;
}

// 由整批進度推導出全部要提交的事件（未作答者不產生事件）。
export function evidenceForSession(session) {
  const sessionId = session?.sessionId;
  const progress = session?.progress || {};
  const out = [];
  for (const wordId of (session?.wordIds || []).map(String)) {
    const ev = evidenceForWord(wordId, progress[wordId], sessionId);
    if (ev) out.push(ev);
  }
  return out;
}

// ---------- 次日弱字（prior）推導 ----------
// 依既有證據：同 owner 的每字，取時間嚴格小於今日（前一場）的最新一場；該場曾錯（correct=false）
// 或整個最近窗仍 weak 者視為弱字優先。樣本少（只有 1 場且錯）也算，不必等 3 場。
// 只導入「有效證據」：缺 ownerId／wordId／sessionId／時間者一律忽略（未知/缺 owner 的舊 quiz 不得導入）。
// events 為 recheck 事件陣列；todayKey 為 'YYYY-MM-DD'（該字於今日之前的場次才算 prior）。
function eventTimeMs(at) {
  if (typeof at === 'number' && Number.isFinite(at)) return at;
  if (typeof at === 'string' && at.trim()) {
    const t = Date.parse(at);
    if (Number.isFinite(t)) return t;
  }
  return null;
}
export function priorWeakWordIds(events, { ownerId, todayStartMs } = {}) {
  if (ownerId == null || String(ownerId).trim() === '') throw new Error('INVALID_OWNER_ID');
  const cutoff = Number.isFinite(todayStartMs) ? todayStartMs : null;
  const startOfToday = cutoff ?? (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();
  const byWord = new Map(); // wordId(str) -> { raw, attempts[] }
  for (const e of (Array.isArray(events) ? events : [])) {
    if (!e || e.type !== 'recheck') continue;
    if (String(e.ownerId) !== String(ownerId)) continue;
    if (e.wordId == null || String(e.wordId).trim() === '') continue;
    const sessionId = e.extra?.sessionId;
    if (sessionId == null || String(sessionId).trim() === '') continue;
    const t = eventTimeMs(e.at);
    if (t == null) continue;
    if (!(e.extra?.mode === 'recognition' || e.extra?.mode === 'recall')) continue;
    if (typeof e.extra?.correct !== 'boolean') continue;
    // 非法 hinted 型別者排除（與 core 判定的有效證據一致）；hinted 錯誤仍照常計入弱字。
    if (e.extra && Object.hasOwn(e.extra, 'hinted') && typeof e.extra.hinted !== 'boolean') continue;
    const key = String(e.wordId);
    if (!byWord.has(key)) byWord.set(key, { raw: e.wordId, attempts: [] });
    byWord.get(key).attempts.push({ t, correct: e.extra.correct, sessionId: String(sessionId) });
  }
  const out = [];
  for (const [, { raw, attempts }] of byWord) {
    // 取時間嚴格小於今日開始的最新一場（以 session 聚合：同場曾錯即該場失誤）。
    const before = attempts.filter((a) => a.t < startOfToday);
    if (!before.length) continue;
    const bySession = new Map();
    for (const a of before) {
      const s = bySession.get(a.sessionId) || { t: a.t, wrong: false };
      if (a.t > s.t) s.t = a.t;
      if (a.correct !== true) s.wrong = true;
      bySession.set(a.sessionId, s);
    }
    const latest = [...bySession.values()].sort((a, b) => b.t - a.t)[0];
    if (latest && latest.wrong) out.push(raw);
  }
  return out;
}
