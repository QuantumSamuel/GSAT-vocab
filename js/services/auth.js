// ============================================================
// 帳號系統（3.1.0）：Supabase Auth（Email＋密碼），REST 呼叫、零依賴
// 登入狀態存 localStorage（vocab2_session），過期自動以 refresh_token 續期
// 對外介面：signUp / signIn / signOut / getUser / getProfile / restFetch
// 事件：auth:changed（登入／登出時發出，後台入口與頁面據此更新）
// 安全：所有資料表存取靠 RLS；金鑰只有 anon key（公開設計），無 service_role
// ------------------------------------------------------------
// 【關聯註記・3.2.0 註冊模式】REGISTRATION_MODE 單點開關（本檔內）：
//   'key'＝金鑰+Email 註冊（現行；signUpWithKey；5.0.0 起金鑰可設使用次數，
//         1＝一碼一人強綁定，>1＝可重複使用，見 tools/supabase_450.sql）
//   'otp'＝Email+6 位驗證碼（verifySignupCode/resendSignupCode 保留於本檔、
//         入口隱藏；切回 'otp' 時：auth 頁恢復 OTP 分支＋Supabase 開啟
//         Confirm email 即可，頁面端不需改動）
//   兩模式共用 signIn/afterLogin/session，互不影響
// ============================================================
import { loadSupabaseConfig } from './sync.js';
import { setRoleCache } from '../core/entitlements.js';
import { emit } from '../core/eventbus.js';

const SESSION_KEY = 'vocab2_session';
let session = loadSession();   // { access_token, refresh_token, expires_at, user:{id,email} }
let profile = null;            // { role, banned, email, ... }（登入後載入）

function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)) || null; } catch { return null; }
}

function saveSession(s) {
  session = s;
  if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  else localStorage.removeItem(SESSION_KEY);
}

export function getUser() { return session?.user ?? null; }
export function isLoggedIn() { return Boolean(session?.access_token); }
export function getProfile() { return profile; }

function translateAuthError(msg) {
  const m = String(msg);
  if (/Invalid login credentials/i.test(m)) return '帳號或密碼錯誤';
  if (/Email not confirmed/i.test(m)) return 'Email 尚未驗證：請點信箱中的驗證連結後重新登入（若信件內有 6 位驗證碼，也可回到註冊面板輸入完成註冊）';
  if (/already registered/i.test(m)) return '此 Email 已註冊過：請直接登入；若你先前已註銷帳號，需等管理員永久刪除後才能重新註冊。';
  if (/at least/i.test(m)) return '密碼至少 8 碼';
  if (/rate limit|Too many/i.test(m)) return '嘗試太頻繁，請稍後再試';
  if (/unable to validate/i.test(m)) return 'Email 格式不正確';
  return m;
}

async function authFetch(config, path, body, token) {
  const res = await fetch(`${config.url}/auth/v1/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: config.key,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(translateAuthError(data.error_description || data.msg || data.message || `HTTP ${res.status}`));
  return data;
}

function persistAuth(data) {
  if (!data.access_token) return; // 需 email 驗證等情境：無 session
  saveSession({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
    user: { id: data.user?.id, email: data.user?.email },
  });
}

// ---------- 對外：註冊／登入／登出 ----------
// 註冊模式開關（3.2.0）：'key' 現行；'otp' 保留代碼、入口隱藏
export const REGISTRATION_MODE = 'key';

// 產生 16 位金鑰（大小寫字母＋數字；排除易混淆字元），後台「產生金鑰」用
export function generateInviteKey() {
  const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 4.0.2：全大寫（與 check_invite 的大寫比對一致，並排除 I/O 混淆）
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => CHARS[b % CHARS.length]).join('');
}

// 金鑰格式驗證（前端先驗；真正的有效性由後端 check_invite 把關）
// 4.0.2：自定義金鑰放寬為 4～40 位（字母、數字、-、_）；產生金鑰固定 16 位全大寫
export function isValidInviteKey(key) {
  return /^[A-Za-z0-9_-]{4,40}$/.test(String(key || '').trim());
}

/**
 * 金鑰註冊（3.2.0 現行）：先驗金鑰 → 註冊 → 綁定金鑰（消耗一次使用次數）。
 * 任一步失敗即中斷；金鑰只在註冊成功後才消耗。
 * 5.0.0（supabase_450.sql）：金鑰可設次數上限，單次金鑰仍是一碼一人強綁定。
 */
export async function signUpWithKey(email, password, inviteKey) {
  const config = await loadSupabaseConfig();
  if (!config.configured) throw new Error('尚未設定 Supabase（見 supabase_config.txt 說明）');
  const code = String(inviteKey || '').trim();
  if (!code) throw new Error('請輸入註冊金鑰（向管理員索取）');

  // ① 金鑰有效性（後端把關，前端格式檢只是提示）
  // 5.0.0：金鑰可設使用次數（tools/supabase_450.sql），失效原因有兩種：
  //    單次金鑰已被綁定、多次金鑰已用完名額 → 文案要同時涵蓋兩者
  const ok = await restFetch('rpc/check_invite', {
    method: 'POST',
    body: JSON.stringify({ p_code: code }),
  });
  if (ok !== true) throw new Error('金鑰無效或已用完，請向管理員索取');

  // ② 註冊（Confirm email 關閉 → 直接取得 session）
  const data = await authFetch(config, 'signup', { email, password });
  if (!data.access_token) {
    // 專案仍開著 Confirm email 時的引導（不消耗金鑰）
    throw new Error('註冊需要信箱驗證：請通知管理員到 Supabase 關閉「Confirm email」後再試');
  }
  persistAuth(data);

  // ③ 綁定金鑰（先到先得；失敗僅記錄，帳號已存在）
  // 5.0.0：多次金鑰在最後一個名額被搶走時同樣走這裡——語意不變（帳號已建立，keyBound=false）
  let keyBound = true;
  try {
    keyBound = (await restFetch('rpc/claim_invite', {
      method: 'POST',
      body: JSON.stringify({ p_code: code }),
    })) === true;
  } catch (err) {
    keyBound = false;
  }
  if (!keyBound) console.warn('金鑰綁定失敗（可能已被搶用）：', code);

  await afterLogin();
  return { keyBound };
}

export async function signUp(email, password) {
  const config = await loadSupabaseConfig();
  if (!config.configured) throw new Error('尚未設定 Supabase（見 supabase_config.txt 說明）');
  const data = await authFetch(config, 'signup', { email, password });
  if (!data.access_token) {
    return { needsConfirm: true, message: '註冊成功！請到信箱點擊驗證連結後再登入。' };
  }
  persistAuth(data);
  await afterLogin();
  return { needsConfirm: false };
}

// 註冊後以信箱驗證碼（6 位數，Email OTP）完成驗證並登入
export async function verifySignupCode(email, code) {
  const config = await loadSupabaseConfig();
  if (!config.configured) throw new Error('尚未設定 Supabase（見 supabase_config.txt 說明）');
  const token = String(code || '').replace(/\D/g, '');
  if (token.length !== 6) throw new Error('驗證碼應為 6 位數字');
  const data = await authFetch(config, 'verify', { type: 'signup', email, token });
  persistAuth(data);
  await afterLogin();
  return getUser();
}

// 重發註冊驗證碼
export async function resendSignupCode(email) {
  const config = await loadSupabaseConfig();
  if (!config.configured) throw new Error('尚未設定 Supabase（見 supabase_config.txt 說明）');
  const res = await fetch(`${config.url}/auth/v1/resend`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: config.key },
    body: JSON.stringify({ type: 'signup', email }),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(translateAuthError(d.error_description || d.msg || `HTTP ${res.status}`));
  }
}

export async function signIn(email, password) {
  const config = await loadSupabaseConfig();
  if (!config.configured) throw new Error('尚未設定 Supabase（見 supabase_config.txt 說明）');
  const data = await authFetch(config, 'token?grant_type=password', { email, password });
  persistAuth(data);
  await afterLogin();
  return getUser();
}

export async function signOut() {
  const config = await loadSupabaseConfig();
  try {
    if (session?.access_token && config.configured) {
      await authFetch(config, 'logout', null, session.access_token);
    }
  } catch { /* 登出以本地為準 */ }
  saveSession(null);
  profile = null;
  setRoleCache(null);
  emit('auth:changed', null);
}

// ---------- Token 續期 ----------
async function ensureFreshToken() {
  if (!session) return null;
  if (session.expires_at - Date.now() > 60_000) return session.access_token;
  const config = await loadSupabaseConfig();
  const data = await authFetch(config, 'token?grant_type=refresh_token', { refresh_token: session.refresh_token });
  persistAuth(data);
  return session.access_token;
}

export async function getAccessToken() {
  return ensureFreshToken();
}

// ---------- 登入後：載 profile（角色／停權）＋更新活躍時間 ----------
async function afterLogin() {
  const token = session.access_token;
  const config = await loadSupabaseConfig();
  const uid = getUser().id;
  const res = await fetch(`${config.url}/rest/v1/profiles?select=*&id=eq.${uid}`, {
    headers: { apikey: config.key, Authorization: `Bearer ${token}` },
  });
  const rows = await res.json().catch(() => []);
  profile = rows[0] ?? null;
  if (profile?.banned) {
    // 4.3.0 修復（Pool B 獵捕）：signOut 會把模組級 profile 設成 null——
    // 旗標必須在 signOut 前取值，否則停權/已註銷分流拋 TypeError
    const isDeleted = profile.deleted === true;
    await signOut();
    // deleted=true＝使用者自行註銷（軟刪除，待管理員永久刪除）——與管理員停權分流
    throw new Error(isDeleted
      ? '此 Email 的帳號已註銷，需管理員永久刪除後才能重新註冊；如有需要請聯絡管理員。'
      : '此帳號已被停用，請聯絡管理員');
  }
  setRoleCache(profile?.role ?? 'user');
  if (profile) {
    await fetch(`${config.url}/rest/v1/profiles?id=eq.${uid}`, {
      method: 'PATCH',
      headers: {
        apikey: config.key, Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json', Prefer: 'return=minimal',
      },
      body: JSON.stringify({ last_seen: new Date().toISOString() }),
    });
    await restFetch('vocab_usage', {
      method: 'POST',
      headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify({ user_id: uid }),
    }).catch(() => {}); // 活躍 ping（每天一筆，失敗不影響）
  }
  emit('auth:changed', getUser());
}

// ---------- 帶登入態的 REST（admin／雲端備份／公告／預設單詞本共用） ----------
// 未登入時以 anon key 呼叫（僅限 RLS 開放公開讀取的表）
export async function restFetch(path, options = {}) {
  const config = await loadSupabaseConfig();
  const token = await getAccessToken().catch(() => null);
  const res = await fetch(`${config.url}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: config.key,
      Authorization: `Bearer ${token || config.key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new Error(`Supabase HTTP ${res.status}：${detail}`);
  }
  // 3.2.0 修復：INSERT 成功（201/204＋return=minimal）回應是空內容，不能 res.json()
  const text = await res.text();
  if (res.status === 204 || !text) return null;
  return JSON.parse(text);
}

// ---------- 啟動（app.js 呼叫一次）：還原會話＋載 profile ----------
// 4.2.0：auth 就緒 promise——冷載時 router 的 admin 硬閘（canManage）須等本 promise
// resolve 後再判斷，否則 initAuth 尚未完成會誤顯「無權限」（既有競態，debug 實證）
let _authReadyResolve; // 須先宣告——promise executor 同步執行，放後面會 TDZ
export const authReady = new Promise((resolve) => { _authReadyResolve = resolve; });

export async function initAuth() {
  try {
    if (!isLoggedIn()) { emit('auth:changed', null); return; }
    await ensureFreshToken();
    await afterLogin();
  } catch (err) {
    // 過期／網路失敗：保留本地資料，僅退回未登入
    saveSession(null);
    profile = null;
    setRoleCache(null);
    emit('auth:changed', null);
    console.warn('登入狀態還原失敗：', err.message);
  } finally {
    _authReadyResolve(); // 成功／失敗／未登入，都要解除 router 硬閘的等待
  }
}

// ---------- 修改密碼（4.0.0）：先以原密碼獨立驗身，再更新密碼 ----------
// ① token?grant_type=password 驗證原密碼（獨立請求，不打斷現有 session）
// ② PUT /auth/v1/user 更新密碼；GoTrue 換發新 token 時同步接上本地 session
export async function changePassword(oldPassword, newPassword) {
  const config = await loadSupabaseConfig();
  if (!config.configured) throw new Error('尚未設定 Supabase（見 supabase_config.txt 說明）');
  if (!getUser()) throw new Error('尚未登入');
  if (!newPassword || String(newPassword).length < 8) throw new Error('新密碼至少 8 碼');
  try {
    await authFetch(config, 'token?grant_type=password', {
      email: getUser().email,
      password: String(oldPassword || ''),
    });
  } catch {
    throw new Error('原密碼不正確');
  }
  const token = await getAccessToken();
  const res = await fetch(`${config.url}/auth/v1/user`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      apikey: config.key,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ password: String(newPassword) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(translateAuthError(data.error_description || data.msg || data.message || `HTTP ${res.status}`));
  }
  if (data.access_token && data.refresh_token) persistAuth(data);
  return true;
}
