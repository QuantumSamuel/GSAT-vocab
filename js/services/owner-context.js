// ============================================================
// 帳戶身分橋接（6.2.0）：本機資料的 owner context
//
// 【為什麼要有這一層（而不是 store.js 直接 import auth.js）】
//   專案的 import 方向是 auth.js → sync.js → store.js。
//   若 store.js 反過來 import auth.js 取「現在是誰」，就會形成
//     auth → sync → store → auth
//   的循環相依：模組初始化順序一換，session／config 就可能還沒就緒而被讀成 undefined，
//   而且要寫測試時也得把整條雲端相依拖進來。
//   因此本檔刻意「不 import 任何模組」（只讀 globalThis.localStorage），
//   由 auth.js 在 session 邊界主動把 owner／generation 推進來（身分橋接），
//   store.js 只從這裡「捕捉」owner 並在等待後／提交前守衛。
//
// 【語意】
//   ownerId：已登入＝auth 的 user.id（與 diagnostic-store 的 ownerId 同一格式）；
//            未登入＝'guest'（訪客自成一個獨立分區，不與任何帳戶共用）。
//   generation：session 邊界序號，由 auth.js 的 authGeneration 提供。
//             「同一個帳戶登出再登入」也會換 generation，所以在途的舊請求一律失效。
//
// 【前端界線（不得冒稱伺服器授權）】
//   這個 owner 只是「本機資料的分區鍵」與「防跨帳戶污染的前端守衛」。
//   它不構成任何伺服器授權：真正的存取控制仍在 Supabase RLS／RPC 那一側。
//   本機 owner 寫錯只會影響本機畫面分區，不會讓使用者取得任何額外權限。
// ============================================================

export const GUEST_OWNER = 'guest';

// auth.js 的 session 儲存鍵（只讀，不寫；避免 owner-context 反向依賴 auth.js）
const SESSION_KEY = 'vocab2_session';

let ownerId = null;   // null＝尚未由 auth 橋接（第一次使用時才從 session 推導）
let generation = 0;

function normalizeOwner(value) {
  const id = String(value ?? '').trim();
  return id || GUEST_OWNER;
}

function readSessionOwner() {
  try {
    const raw = globalThis.localStorage?.getItem(SESSION_KEY);
    if (!raw) return GUEST_OWNER;
    const session = JSON.parse(raw);
    const uid = session?.user?.id;
    return uid ? normalizeOwner(uid) : GUEST_OWNER;
  } catch {
    return GUEST_OWNER;
  }
}

/** 目前捕捉到的 owner（未登入＝'guest'）。 */
export function getOwnerId() {
  if (ownerId === null) ownerId = readSessionOwner();
  return ownerId;
}

/** 目前捕捉到的 session 邊界序號。 */
export function getOwnerGeneration() {
  return generation;
}

/**
 * auth.js 在 session 邊界呼叫（登入／登出／換帳戶／其他分頁改 session）。
 * @param {string|null} next 新的 owner（null／空字串＝訪客）
 * @param {number} [nextGeneration] auth.js 的 authGeneration（權威來源）
 * @returns {number} 套用後的 generation
 */
export function setOwner(next, nextGeneration = undefined) {
  const id = normalizeOwner(next);
  const previous = ownerId;
  ownerId = id;
  if (Number.isFinite(nextGeneration)) generation = Math.trunc(nextGeneration);
  else if (previous !== null && previous !== id) generation += 1;
  return generation;
}

/**
 * 捕捉當下的 owner／generation。寫入流程必須在「開始」時捕捉一次，
 * 之後每個 await 回來與真正落地前都用 assertActive() 驗；失敗即丟 ACCOUNT_CHANGED。
 */
export function captureOwner() {
  const at = getOwnerId();
  const gen = generation;
  const capture = {
    ownerId: at,
    generation: gen,
    assertActive() {
      if (getOwnerId() !== capture.ownerId || generation !== capture.generation) {
        const err = new Error('ACCOUNT_CHANGED');
        err.code = 'ACCOUNT_CHANGED';
        throw err;
      }
      return true;
    },
  };
  return capture;
}

/** 驗一個捕捉到的 owner 是否仍有效（不是捕捉物件也能用）。 */
export function assertOwner(owner) {
  if (!owner) {
    const err = new Error('ACCOUNT_CHANGED');
    err.code = 'ACCOUNT_CHANGED';
    throw err;
  }
  if (typeof owner.assertActive === 'function') return owner.assertActive();
  if (getOwnerId() !== owner.ownerId || generation !== owner.generation) {
    const err = new Error('ACCOUNT_CHANGED');
    err.code = 'ACCOUNT_CHANGED';
    throw err;
  }
  return true;
}

/** 同一個 owner 且同一個 session 邊界才算「同一次身分」。 */
export function isSameOwner(a, b) {
  return Boolean(a) && Boolean(b) && a.ownerId === b.ownerId && a.generation === b.generation;
}
