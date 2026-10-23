// ============================================================
// 6.2.2 整合交付：模擬考「閱讀／克漏字」分項證據生產者
//
// 【接到哪裡】
//   ① 每個 run 建立點（設定頁按「開始」／錯題重練）呼叫 captureRunStart(run, { auth })：
//      把「當時的 owner＋auth generation」寫進 run.evidence，作為場次起點綁定。
//   ② 成績頁（showReport）呼叫 recordRunEvidence(run, { auth })：只依①的綁定寫本機證據。
//   auth 由呼叫端注入（產品是 services/auth.js 的 getUser／getAuthGeneration）；
//   本層不自己 import 產品 auth，讓「誰在什麼時候讀帳戶」顯式可見，也方便用替身測試。
//   不接 620 的閱讀頁、也不接 621 的克漏字出題頁——那兩支的實際版本還沒交付，
//   先接會變成接一個不存在的介面。詳見 integration-manifest.mjs。
//
// 【為什麼要在「開始」就綁 owner＋generation，而不是成績頁再問一次】
//   成績頁才去問「現在是誰」有兩個已回報過的錯誤：
//    ・訪客作答、中途才登入 → 舊答案被新帳戶認領（把不是該帳戶的作答記到剛登入的帳號）。
//    ・A 看成績後切到 B，B 再按一次「查看成績」→ 舊版在 guard 之前就回
//      run.evidence.output，於是 B 看到 A 的摘要（跨帳戶洩漏）。
//   因此本層：沒有起點綁定一律拒收（MISSING_START_BINDING，不猜 owner）；
//   owner 或 generation 與起點不一致一律拒收；摘要快取只在「同一份綁定」下可回用，
//   所以 A→B→A 也不會偷復用（generation 已經變了）。
//
// 【一場 run ＝ 一場次】
//   sessionKey＝JSON([ownerId, runId])：同一 run 的篇單元共用一個場次；
//   run 內不同篇各自一個觀測單元（不同 sourceId），同 run 同篇重答只會落同一個
//   eventId（去重，不膨脹分子分母）；下一個 run（再練一次／錯題重練）一定是新場次。
//   場次結束時呼叫 endRunSession（結束本次／再練一次／錯題重練前），把場次收掉。
//
// 【來源完整性】每個觀測單元＝「一場次裡的一篇文章／一個克漏字組」
//   provenance.source   exam-real／exam-ai／exam-archive（三個題庫嚴格分離）
//   provenance.sourceId 無歧義 tuple：year|paper|section|(g{group} 或 q{qnum})
//                       （真題庫 113／114 年 E1 的閱讀 group 5 是不同文章，
//                        只寫 paper#section#group 會撞在一起，見 unitSourceIdOf）
//   provenance.revision 由呼叫端傳（例：real.json meta.generated／archive builtAt），
//                       未提供就維持 null——不假造版本號
//   provenance.capturedAt 場次起點時間（固定值，重送同 run 不會變 → 可去重）
//
// 【提示（hinted）只記看得見的事實】
//   真模擬考（6.1.2/js/pages/exam.js）在「作答前」確實有一種可展開的輔助：
//   考古題卷（bank==='archive'）且該題是題組首題時，會插入
//   <details class="passage-zh">「文章中文翻譯」——使用者可以不看題目就先讀整篇中譯。
//   所以「作答前完全沒有任何提示管道」是錯的敘述（舊版註解／清單／測試都寫錯，已改）。
//   但那是「整篇文章的中譯輔助」，不是逐題提示：exam.js 沒有紀錄任何一題有沒有被
//   這份中譯幫到，也沒有逐題提示名單；620 閱讀／621 克漏字的提示名單同樣還沒交付。
//   因此 run.evidenceHinted 沒給時，事件仍記 hinted=null（未觀測）並在 missing 標
//   HINT_NOT_OBSERVED，不假填 false——「假的確定沒有提示」會讓弱項與提示統計說謊，
//   而且不能為了補這個洞就自己發明新的提示判定規則（那要使用者核准）。
//   有給名單時才記 true／false（＝已觀測）。
//
// 【與彙整核心一致的規約】
//   ・沒作答的單元照樣留一筆，但 measure 的分子分母是 null（unknown），不是 0：
//     coverage 的 attempted 小於 available，彙整核心不會把該分項標 complete。
//   ・原始錯誤與提示一律保留。
//   ・不產生任何任務、不動 SRS／每日份量／診斷資格、不設通過或停測門檻。
// ============================================================
import { SECTION_LABELS } from '../core/evidence-aggregate.js';
import {
  HINT_NOT_OBSERVED, HINT_SCHEMA, assertAlive, createEvidenceStore, makeGuard,
} from '../services/evidence-store.js';

// 模擬考區段 → 分項。刻意只映射三個已核准分項；其餘（文意選填／篇章結構／中翻英）
// 沒有核准的分項語意，寧可回報「未支援」也不硬塞進 cloze 冒充。
export const SECTION_MAP = Object.freeze({
  '詞彙題': 'vocabulary',
  '綜合測驗': 'cloze',
  '閱讀測驗': 'reading',
});

export const UNSUPPORTED_SECTIONS = Object.freeze(['文意選填', '篇章結構', '中翻英']);

// 題庫 → 證據來源代號（與 6.0 既有的 real／ai／archive 三來源分流一致）
export const SOURCE_BY_BANK = Object.freeze({
  real: 'exam-real',
  ai: 'exam-ai',
  archive: 'exam-archive',
});

export const SESSION_HINT_NOTE = '真模擬考在作答前可展開「文章中文翻譯」（考古題卷、每組首題一次），'
  + '那是整篇中譯輔助、沒有逐題觀測紀錄；620 閱讀／621 克漏字的逐題提示名單也還沒交付。'
  + '本層沒有名單時記為未觀測（null＋HINT_NOT_OBSERVED），不推定為沒有提示，也不自行新增提示判定規則。';

// 真模擬考「作答前」實際看得到的輔助（如實記錄，別再把「沒有提示管道」寫進文件）。
// 這些輔助不會被換算成逐題 hinted：沒有逐題觀測，就只能記未觀測。
export const PRE_ANSWER_AIDS = Object.freeze([
  {
    id: 'archive-passage-zh',
    what: '考古題卷的「文章中文翻譯」可展開區塊（<details class="passage-zh">）',
    where: 'js/pages/exam.js 的 renderQuestion（僅 bank==="archive" 且該題為題組首題）',
    scope: 'passage',
    perItemObservation: false,
    affectsHinted: false,
    note: '整篇中譯輔助；exam.js 未記錄哪一題用過它，所以逐題 hinted 仍為未觀測（null）。',
  },
]);

// run.evidence 的起點綁定版本；結構改變時遞增，舊 run 會被當成「沒有綁定」拒收。
export const RUN_BINDING_VERSION = 1;

// 觀測單元 id 的欄位分隔符：欄位內的 '|' 會被跳脫成 %7C，所以分隔符本身不會出現在欄位裡。
export const UNIT_ID_SEP = '|';

let defaultStore = null;

export function getDefaultEvidenceStore() {
  if (!defaultStore) defaultStore = createEvidenceStore();
  return defaultStore;
}

function authOf(deps) {
  return deps?.auth || null;
}

/**
 * auth 介面：只需要 getUser() 與 getAuthGeneration()（產品 services/auth.js 的既有介面）。
 * 本層刻意不靜態 import 產品 auth：由呼叫端（exam.js／結果頁／測試）注入，
 * 這樣「誰在什麼時候讀帳戶」是顯式的，也不會讓本模組在別處被動拿到登入狀態。
 */
function requireAuth(auth, who) {
  if (!auth || typeof auth.getUser !== 'function' || typeof auth.getAuthGeneration !== 'function') {
    throw new TypeError(`${who} 需要 auth 介面（getUser／getAuthGeneration）`);
  }
  return auth;
}

/** 目前帳戶快照：owner 只認字串 id；generation 由 auth 模組提供（同帳戶重登也會變）。 */
export function ownerSnapshotOf(auth) {
  const user = typeof auth?.getUser === 'function' ? auth.getUser() : null;
  const ownerId = typeof user?.id === 'string' && user.id.trim() ? user.id.trim() : null;
  const generation = typeof auth?.getAuthGeneration === 'function' ? auth.getAuthGeneration() : 0;
  return { ownerId, generation };
}

function sourceOfRun(run) {
  const bank = run?.bank;
  return SOURCE_BY_BANK[bank] || SOURCE_BY_BANK.real;
}

function revisionOfRun(run) {
  const rev = run?.evidenceRevision;
  return typeof rev === 'string' && rev.trim() ? rev.trim() : null;
}

// 只跳脫分隔符本身與跳脫字元（不編碼中文，讓結果頁顯示得出人看得懂的來源）。
// 先把 '%' 跳脫成 %25，再把 '|' 跳脫成 %7C，所以「欄位內含 |」與「欄位原文是 %7C」不會混淆。
function unitField(value) {
  if (value == null || value === '') return '';
  return String(value).replace(/%/g, '%25').replace(/\|/g, '%7C');
}

/**
 * 觀測單元的來源 id：一篇閱讀文章／一個克漏字組就是一個單元。
 * tuple 為 year|paper|section|(g{group}|q{qnum})：真題庫有 113／114 年同卷別同題組，
 * 少了 year 就會把「113 年 E1 閱讀 group 5」與「114 年 E1 閱讀 group 5」當成同一篇。
 * 欄位內的 '%' 與 '|' 會被跳脫（%25／%7C），所以欄位含分隔符時也不會碰撞（無歧義）。
 */
export function unitSourceIdOf(question) {
  if (!question) return null;
  const year = unitField(question.year != null ? question.year : '?');
  const paper = unitField(question.paper != null ? question.paper : '?');
  const section = unitField(question.section != null ? question.section : '?');
  const locator = question.group != null
    ? `g${unitField(question.group)}`
    : `q${unitField(question.qnum != null ? question.qnum : '?')}`;
  return [year, paper, section, locator].join(UNIT_ID_SEP);
}

/**
 * 把一次 run 的題目依「觀測單元」分組。
 * 回傳 { units, unsupported }：unsupported 只回報未映射區段的題數，不生成事件。
 */
export function groupRunUnits(run) {
  const questions = Array.isArray(run?.questions) ? run.questions : [];
  const units = new Map();
  const unsupported = new Map();
  questions.forEach((question, index) => {
    const section = SECTION_MAP[question?.section];
    if (!section) {
      const key = String(question?.section ?? '未標區段');
      unsupported.set(key, (unsupported.get(key) || 0) + 1);
      return;
    }
    const sourceId = unitSourceIdOf(question);
    if (!sourceId) return;
    const key = `${section}|${sourceId}`;
    if (!units.has(key)) units.set(key, { section, sourceId, indexes: [], questions: [] });
    units.get(key).indexes.push(index);
    units.get(key).questions.push(question);
  });
  return {
    units: [...units.values()],
    unsupported: [...unsupported.entries()].map(([section, questionCount]) => ({
      section,
      questionCount,
      code: 'SECTION_NOT_MAPPED',
      detail: `${section} 沒有核准的分項語意，未寫入分項證據`,
    })),
  };
}

/**
 * 單一觀測單元的原始量。
 * numerator／denominator 只算「已作答」的題：未作答不是答錯，故分母＝attempted。
 * itemCount＝本次抽到的題量、passageCount＝1（一個單元就是一篇／一組）。
 * 完全沒作答時分子分母留 null（unknown），另一併保留 coverage 讓 core 判 partial。
 */
export function measureForUnit(unitsEntry, results) {
  const list = Array.isArray(results) ? results : [];
  const answered = unitsEntry.indexes.filter((index) => list[index] && typeof list[index].good === 'boolean');
  const correct = answered.filter((index) => list[index].good).length;
  const attempted = answered.length;
  const available = unitsEntry.indexes.length;
  return {
    numerator: attempted > 0 ? correct : null,
    denominator: attempted > 0 ? attempted : null,
    itemCount: available,
    passageCount: 1,
    coverage: { attempted, available },
  };
}

/**
 * 提示觀測狀態：null／undefined＝上游沒給名單 → 未觀測（不是「確定沒有提示」）。
 * 給 Set 或陣列才視為已觀測（名單內 true、名單外 false）。
 */
export function hintObservationOf(hintedSourceIds) {
  if (hintedSourceIds == null) return { observed: false, hinted: new Set() };
  const hinted = hintedSourceIds instanceof Set
    ? hintedSourceIds
    : new Set(Array.isArray(hintedSourceIds) ? hintedSourceIds.map(String) : []);
  return { observed: true, hinted };
}

/**
 * 純函式：把一次 run 轉成待寫入的證據事件（不做 IO，方便聚焦測試）。
 * session＝{ sessionId }；runId／capturedAt 由呼叫端給固定值。
 */
export function buildRunEvidence(run, { ownerId, sessionId, runId, capturedAt, hintedSourceIds = null } = {}) {
  if (!run || !Array.isArray(run.questions)) throw new TypeError('buildRunEvidence 需要模擬考 run');
  if (typeof ownerId !== 'string' || !ownerId.trim()) throw new TypeError('buildRunEvidence 需要 ownerId');
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new TypeError('buildRunEvidence 需要 sessionId');
  if (typeof runId !== 'string' || !runId.trim()) throw new TypeError('buildRunEvidence 需要 runId');
  if (!Number.isFinite(capturedAt) || capturedAt < 0) throw new TypeError('buildRunEvidence 需要 capturedAt');
  const source = sourceOfRun(run);
  const revision = revisionOfRun(run);
  const hint = hintObservationOf(hintedSourceIds);
  const { units, unsupported } = groupRunUnits(run);
  const events = units.map((unit, order) => ({
    // eventId 決定性：同一 run 的同一單元重送（重整、重複按「查看成績」）必得同一個 id → 去重。
    eventId: `${runId}·${unit.sourceId}`,
    ownerId,
    section: unit.section,
    sessionId,
    // occurredAt 用「場次起點＋單元序」：固定值才能讓重送去重；真實作答時刻另存於彙整層 audit。
    occurredAt: capturedAt + order,
    provenance: { source, sourceId: unit.sourceId, revision, capturedAt },
    measure: measureForUnit(unit, run.results),
    // 未觀測＝null（不寫 false）：false 是「已觀測且確定沒有提示」的斷言。
    hinted: hint.observed ? hint.hinted.has(unit.sourceId) : null,
    // 提示值的來源 schema：只有真的拿到逐題名單時才標 per-item-v2。
    // 沒有標記的 false（例如 v1 舊資料）在彙整投影一律算「觀測不確定」，不可當成沒有提示。
    hintSchema: hint.observed ? HINT_SCHEMA : null,
    missing: hint.observed ? [] : [{
      code: HINT_NOT_OBSERVED,
      detail: '上游未提供提示名單：作答前的提示未觀測，不推定為沒有提示',
    }],
  }));
  return { events, unsupported, source, revision, hintObserved: hint.observed };
}

function nextRunId(seed, random = Math.random) {
  const at = Number.isFinite(seed) ? seed : Date.now();
  return `r-${at.toString(36)}-${Math.floor(random() * 1e6).toString(36)}`;
}

/** 場次鍵：同一 owner 的同一個 run 永遠同一把鍵；不同 run 一定不同（＝不同場次）。 */
export function runSessionKeyOf(binding) {
  return JSON.stringify([binding.ownerId, binding.runId]);
}

/** run 是否帶「起點綁定」。缺欄位或版本不符都視為沒有綁定（拒收，不猜）。 */
export function hasRunBinding(run) {
  const binding = run?.evidence;
  if (!binding || binding.version !== RUN_BINDING_VERSION) return false;
  if (typeof binding.runId !== 'string' || !binding.runId.trim()) return false;
  if (!Object.prototype.hasOwnProperty.call(binding, 'ownerId')) return false;
  if (!(binding.ownerId === null || typeof binding.ownerId === 'string')) return false;
  if (!Number.isFinite(binding.generation)) return false;
  if (!Number.isFinite(binding.capturedAt) || binding.capturedAt < 0) return false;
  return true;
}

/**
 * 真考試開始時呼叫（設定頁按「開始」、錯題重練）：捕捉當時的 owner＋generation。
 * 之後成績頁只用這份綁定；不會在 showReport 當下重新猜帳戶。
 * 訪客 ownerId 記 null——代表「這場沒有帳戶」，不是「之後登入就認領」。
 */
export function captureRunStart(run, deps = {}) {
  if (!run || typeof run !== 'object') throw new TypeError('captureRunStart 需要模擬考 run');
  const auth = requireAuth(authOf(deps), 'captureRunStart');
  const snapshot = ownerSnapshotOf(auth);
  const startedAt = (typeof deps.now === 'function' ? deps.now : Date.now)();
  run.evidence = {
    version: RUN_BINDING_VERSION,
    runId: typeof deps.runId === 'string' && deps.runId.trim() ? deps.runId.trim() : nextRunId(startedAt, deps.random),
    ownerId: snapshot.ownerId,
    generation: snapshot.generation,
    startedAt,
    capturedAt: startedAt,
    sessionKey: null,
    sessionId: null,
    output: null,
    writePromise: null,
  };
  return run.evidence;
}

/**
 * 結束本場的證據場次（結束本次／再練一次／錯題重練前呼叫）。
 * 沒有場次鍵（還沒寫過證據）時是 no-op；有在途寫入時先等它落地再收場次，
 * 避免「按再練一次」比寫入更快而留下永遠沒收的場次。
 */
export async function endRunSession(run, deps = {}) {
  const binding = run?.evidence;
  if (!hasRunBinding(run)) return { ok: false, code: 'MISSING_START_BINDING', skipped: true };
  if (binding.writePromise) {
    try { await binding.writePromise; } catch { /* 寫入失敗也要收場次 */ }
  }
  const sessionKey = binding.sessionKey;
  if (!sessionKey) return { ok: true, skipped: true, code: 'NO_SESSION' };
  const store = deps.store || getDefaultEvidenceStore();
  try {
    await store.endSession(sessionKey);
    binding.sessionKey = null;
    binding.sessionId = null;
    return { ok: true, sessionKey };
  } catch (err) {
    return { ok: false, code: err?.code || 'END_SESSION_FAILED', error: String(err?.message || err) };
  }
}

// ---------- 在途寫入登記（供結果頁等待「同一份承諾」，不設超時、不輪詢） ----------
// 為什麼要有這一層：離頁／去結果頁時不能把導覽卡在寫入上，也不能宣稱「已完成」；
// 但結果頁若在寫到一半時讀 IndexedDB，就會顯示半套數字。
// 解法：導覽不阻塞，結果頁在渲染前等待「同一個 owner 目前在途的那幾份寫入承諾」，
// 寫完再讀一次（保存中 → 已保存／失敗可重試）。沒有任意超時、沒有重試次數上限、沒有 TTL。
const inFlightWrites = new Map(); // ownerId → Set<Promise>

function trackWrite(ownerId, promise) {
  if (typeof ownerId !== 'string' || !ownerId.trim()) return;
  let set = inFlightWrites.get(ownerId);
  if (!set) {
    set = new Set();
    inFlightWrites.set(ownerId, set);
  }
  set.add(promise);
  const forget = () => {
    set.delete(promise);
    if (set.size === 0) inFlightWrites.delete(ownerId);
  };
  promise.then(forget, forget);
}

/** 這個帳戶現在有幾筆分項證據寫入還在途（0＝沒有）。 */
export function runEvidenceWritesInFlight(ownerId) {
  return inFlightWrites.get(ownerId)?.size ?? 0;
}

/**
 * 等這個帳戶的在途寫入全部落地（不設超時：寫入失敗會 reject／回 failed，不會永遠假等）。
 * 結果頁用它在渲染數字前等「同一份在途承諾」，等到後自己重讀一次資料。
 */
export async function waitForRunEvidenceWrites(ownerId) {
  for (;;) {
    const set = inFlightWrites.get(ownerId);
    if (!set || set.size === 0) return { ok: true, pending: 0 };
    await Promise.allSettled([...set]);
  }
}

/**
 * 收尾本場證據（離頁、回首頁、去分項結果時用）：
 * 先等本場在途寫入落地（endRunSession 內部等 writePromise），再收場次。
 *
 * 【沒有超時】前一版有未經核准的 `timeoutMs=1500` 上限：時間到就回 SETTLE_TIMEOUT，
 * 呼叫端看到非 ok 也只能照樣導覽，等於用一個產品沒核准的數字決定「證據要等多久」。
 * 那個上限已移除：本函式就是老實等到結束或失敗，並如實回報結果。
 * 想「不卡導覽」請用非阻塞呼叫（`void settleRunEvidence(run)`），
 * 讓結果頁去等同一份在途寫入（waitForRunEvidenceWrites），而不是隨意截斷寫入。
 * 也不因此新增 beforeunload 的 async 寫入保證：關頁面時寫不完就照實留在 pending 佇列。
 */
export async function settleRunEvidence(run, { store, timeoutMs } = {}) {
  if (timeoutMs !== undefined) {
    throw new TypeError('settleRunEvidence 不再接受 timeoutMs：未經核准的超時上限已移除，請改用非阻塞導覽＋結果頁等待在途寫入');
  }
  if (!run || !hasRunBinding(run)) {
    return { ok: false, code: 'MISSING_START_BINDING', settled: false, skipped: true };
  }
  const result = await endRunSession(run, store ? { store } : {});
  return { ...result, settled: result?.ok === true };
}


/**
 * 路由離頁清理（真 exam 生命週期）：離開 #/exam（回首頁、去別的頁、去分項結果）
 * 時由 router 的離頁清單呼叫。
 *  ・成績頁已經產生過的場次 → 收掉（等本場寫入落地再收，避免留下永遠沒收的場次）
 *  ・作答中的 run → **不動**：真模擬考的 run 保留在模組記憶體（切頁回來可續答），
 *    場次要跟著它留著；下一場一定是新 run → 新場次鍵，不會誤用舊場次。
 *  ・判斷依據是「這個模組記憶體裡的 run 有沒有產生過成績頁」（binding.finishedAt），
 *    不是資料庫的 endedAt。**endedAt:null 只表示「這個場次還沒被收掉」，不代表有人正在作答**；
 *    反過來說，無法確認某場是否真的結束時也不代收、不猜，如實保留（下次用新 run 新場次）。
 *  ・不新增 beforeunload 的 async 寫入保證，也不清理歷史 pending：寫不完就照實留著。
 */
export async function onExamPageLeave(run, deps = {}) {
  if (!run || !hasRunBinding(run)) return { ok: false, code: 'MISSING_START_BINDING', skipped: true };
  const binding = run.evidence;
  if (!Number.isFinite(binding.finishedAt) && !binding.writePromise) {
    return { ok: true, code: 'RUN_IN_PROGRESS', skipped: true };
  }
  return settleRunEvidence(run, deps);
}


/**
 * 把一次模擬考的分項證據寫進本機、帳戶隔離的儲存。
 * 驗證順序（不可調換）：起點綁定 → 現在 owner／generation 是否仍是同一人 → 才看摘要快取
 * → 才談「共用同一個在途寫入」（單飛）。寫入失敗不回假成功（failed>0，結果頁顯示未保存並可重試）。
 */
export async function recordRunEvidence(run, deps = {}) {
  if (!run || !Array.isArray(run.questions) || !Array.isArray(run.results)) {
    return { ok: false, code: 'INVALID_RUN', error: '這不是可記錄的模擬考場次' };
  }
  // ① 起點綁定：成績頁不重新猜 owner；沒有綁定就拒收。
  if (!hasRunBinding(run)) {
    return {
      ok: false,
      code: 'MISSING_START_BINDING',
      skipped: true,
      error: '這場模擬考沒有開始時的帳戶綁定，不寫入分項證據（不在成績頁推測帳戶）',
    };
  }
  const binding = run.evidence;
  // ② 訪客開始的場次：即使現在已登入，也不得把舊答案認領新帳戶。
  if (!binding.ownerId) {
    return {
      ok: false,
      code: 'UNAUTHENTICATED',
      skipped: true,
      error: '這場是訪客開始的：分項證據只記本人帳戶，登入後也不回溯認領',
    };
  }
  const auth = authOf(deps);
  // 沒有 auth 介面就無法驗證「現在是不是同一人」→ 拒收，不退回猜測。
  if (!auth || typeof auth.getUser !== 'function' || typeof auth.getAuthGeneration !== 'function') {
    return {
      ok: false,
      code: 'AUTH_UNAVAILABLE',
      skipped: true,
      error: '沒有 auth 介面可驗證目前帳戶，本次不寫入（不在成績頁推測 owner）',
    };
  }
  const current = ownerSnapshotOf(auth);
  // ③ 先驗現在是不是同一帳戶／同一 generation，之後才准讀快取摘要。
  //    注意：比的是「現在」與「起點綁定」，不是 guard 自己的副本。
  if (current.ownerId !== binding.ownerId) {
    return {
      ok: false,
      code: 'ACCOUNT_CHANGED',
      skipped: true,
      current,
      error: '作答中途換了帳戶：本次不寫入，也不把舊作答記到新帳戶',
    };
  }
  if (current.generation !== binding.generation) {
    return {
      ok: false,
      code: 'STALE_ACCOUNT',
      skipped: true,
      current,
      error: '帳戶狀態已變（登出／重新登入／換頁）：本次不寫入，也不回用舊摘要',
    };
  }
  const guards = deps.guards || makeGuard({
    ownerId: binding.ownerId,
    generation: binding.generation,
    getOwnerId: () => ownerSnapshotOf(auth).ownerId,
    getGeneration: () => ownerSnapshotOf(auth).generation,
  });
  try {
    assertAlive(guards);
  } catch (err) {
    return { ok: false, code: err.code || 'STALE_ACCOUNT', skipped: true, error: err.message };
  }
  // ④ 成績頁已產生 → 標記本場「已完結」。離頁清理（router 的 onLeave／回首頁／
  //    去分項結果）只收這種場次：作答中的 run 依真 exam 生命週期會留在記憶體
  //    （切頁再回來可續答），它的場次要跟著 run 留著，不能提前收掉。
  if (!Number.isFinite(binding.finishedAt)) binding.finishedAt = Date.now();
  // ⑤ 摘要快取：只有「同一份起點綁定」產生的摘要可以回用。
  if (binding.output) {
    const cached = binding.output;
    const sameBinding = cached.ownerId === binding.ownerId
      && cached.generation === binding.generation
      && cached.runId === binding.runId;
    if (sameBinding) return cached;
    return {
      ok: false,
      code: 'STALE_EVIDENCE_CACHE',
      skipped: true,
      error: '快取摘要不屬於這份場次綁定，已丟棄不採用',
    };
  }

  // ⑥ 單飛（single-flight）：同一份綁定同時被要求兩次（成績頁重畫、使用者連點、
  //    兩個呼叫端一起收尾）時共用同一個在途寫入，不各自把同一批事件再寫一遍。
  //    這個入口在 owner／generation 驗證「之後」，所以換成 B 的呼叫在前面就已經被
  //    擋掉（ACCOUNT_CHANGED／STALE_ACCOUNT），不會拿到 A 的承諾或摘要。
  if (binding.writePromise) {
    try {
      return await binding.writePromise;
    } catch (err) {
      return { ok: false, code: err?.code || 'EVIDENCE_WRITE_FAILED', error: String(err?.message || err) };
    }
  }

  const work = (async () => {
    const store = deps.store || getDefaultEvidenceStore();
    const sessionKey = runSessionKeyOf(binding);
    // 一場 run ＝ 一個場次：同 run 重送拿到同一個 sessionId，下一 run 一定新場次。
    const session = await store.ensureSession(binding.ownerId, { sessionKey });
    // await 之後再驗一次（A→B→A 不得沿用舊場次寫入新頁）
    if (ownerSnapshotOf(auth).ownerId !== binding.ownerId
      || ownerSnapshotOf(auth).generation !== binding.generation) {
      return { ok: false, code: 'STALE_ACCOUNT', skipped: true, error: '帳戶或頁面已變更，已停止寫入' };
    }
    assertAlive(guards);
    binding.sessionKey = sessionKey;
    binding.sessionId = session.sessionId;
    const built = buildRunEvidence(run, {
      ownerId: binding.ownerId,
      sessionId: session.sessionId,
      runId: binding.runId,
      capturedAt: binding.capturedAt,
      hintedSourceIds: run.evidenceHinted,
    });
    const summary = {
      ok: true,
      ownerId: binding.ownerId,
      generation: binding.generation,
      sessionId: session.sessionId,
      sessionKey,
      runId: binding.runId,
      source: built.source,
      hintObserved: built.hintObserved,
      written: 0,
      duplicates: 0,
      conflicts: 0,
      failed: 0,
      pending: 0,
      unsupported: built.unsupported,
      events: [],
    };
    for (const event of built.events) {
      const saved = await store.saveEventSafely(binding.ownerId, event, { guard: guards });
      if (!saved.ok) {
        if (saved.code === 'STALE_ACCOUNT') {
          return { ...summary, ok: false, code: 'STALE_ACCOUNT', error: '帳戶或頁面已變更，已停止寫入' };
        }
        summary.failed += 1;
        if (saved.pending) summary.pending += 1;
        summary.events.push({
          sourceId: event.provenance.sourceId,
          section: event.section,
          status: 'failed',
          code: saved.code,
        });
        continue;
      }
      if (saved.status === 'stored') summary.written += 1;
      else if (saved.status === 'duplicate') summary.duplicates += 1;
      else if (saved.status === 'conflict') summary.conflicts += 1;
      summary.events.push({
        sourceId: event.provenance.sourceId,
        section: event.section,
        status: saved.status,
        numerator: event.measure?.numerator ?? null,
        denominator: event.measure?.denominator ?? null,
        itemCount: event.measure?.itemCount ?? null,
        passageCount: event.measure?.passageCount ?? null,
        coverage: event.measure?.coverage ?? null,
      });
    }
    summary.ok = summary.failed === 0;
    if (summary.failed > 0) summary.code = 'PARTIAL_WRITE';
    // 只有全數落盤才記成「已寫」；部分失敗保留可重試狀態。
    if (summary.ok) binding.output = summary;
    return summary;
  })();

  binding.writePromise = work;
  // 登記在途寫入：結果頁據此等「同一份承諾」再讀，不靠輪詢、不靠超時。
  trackWrite(binding.ownerId, work);
  try {
    return await work;
  } catch (err) {
    return { ok: false, code: err?.code || 'EVIDENCE_WRITE_FAILED', error: String(err?.message || err) };
  } finally {
    if (binding.writePromise === work) binding.writePromise = null;
  }
}

/** 供結果頁／測試使用的分項中文名。 */
export function sectionLabelOf(section) {
  return SECTION_LABELS[section] || section;
}
