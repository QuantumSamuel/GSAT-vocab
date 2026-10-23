// ============================================================
// 心跳模組（3.3.0）：App 開著＋已登入時，每 5 分鐘回報一次活躍
// 兩種資料分開送：
//   last_seen   —— 每次心跳都更新（後台「是否在線」判斷用，10 分鐘內算在線）
//   minutes     —— 只有「有作為」才累計（呼叫 bump_usage RPC，每次 +5 分鐘）
// 「有作為」＝兩次心跳之間頁面內發生過 pointerdown / keydown / click
//   → App 開著但放著不動的使用者，不會灌水「使用時間」
// 【關聯註記】僅依賴 services/auth.js 的 getAccessToken/getUser/restFetch；
//   由 app.js 在 auth:changed 時 start/stop，本模組不自行判斷登入
// 【關聯註記】3.3.0 後台「使用時間／是否在線」的資料來源；
//   與 5.3.1 過場動畫無關（純資料回報，不涉及任何畫面效果）
// ============================================================
import { getUser, restFetch } from './auth.js';

const BEAT_MS = 5 * 60 * 1000;   // 心跳間隔：5 分鐘（與後台「在線」10 分鐘判斷相容）

let timer = null;
let activeSinceLastBeat = false;

// 監聽使用者動作（passive：只讀事件屬性，不阻塞滾動與手勢）
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'click'];
const onActivity = () => { activeSinceLastBeat = true; };
let listenersBound = false;

function bindActivityListeners() {
  if (listenersBound) return;
  for (const type of ACTIVITY_EVENTS) {
    document.addEventListener(type, onActivity, { passive: true, capture: true });
  }
  listenersBound = true;
}

function unbindActivityListeners() {
  if (!listenersBound) return;
  for (const type of ACTIVITY_EVENTS) {
    document.removeEventListener(type, onActivity, { capture: true });
  }
  listenersBound = false;
}

// 送一次心跳：回報在線時間；有作為才累計使用分鐘
async function beat() {
  const user = getUser();
  if (!user) return;
  const wasActive = activeSinceLastBeat;
  try {
    if (wasActive) {
      await restFetch('rpc/bump_usage', { method: 'POST', body: JSON.stringify({}) });
    }
  } catch (err) {
    console.warn('心跳（使用時間）回報失敗：', err.message || err);
  }
  try {
    // 4.0.2：last_seen 每次心跳都更新（在線判斷）；last_active 只有「有作為」才更新
    //（後台在線點點的「持續活躍」判斷用；需 supabase_400.sql 的 last_active 欄位）
    await restFetch(`profiles?id=eq.${user.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        last_seen: new Date().toISOString(),
        ...(wasActive ? { last_active: new Date().toISOString() } : {}),
      }),
    });
  } catch (err) {
    console.warn('心跳（在線時間）回報失敗：', err.message || err);
  }
  activeSinceLastBeat = false;
}

// 開始心跳（app.js 於登入時呼叫）
export function startHeartbeat() {
  stopHeartbeat();
  bindActivityListeners();
  activeSinceLastBeat = false;
  timer = setInterval(() => { beat(); }, BEAT_MS);
}

// 停止心跳（app.js 於登出時呼叫）
export function stopHeartbeat() {
  if (timer) { clearInterval(timer); timer = null; }
  unbindActivityListeners();
  activeSinceLastBeat = false;
}

// 手動補一次（頁面重新顯示時呼叫：切回分頁會累積使用時間，但不重設計時器）
export async function beatOnce() {
  await beat();
}
