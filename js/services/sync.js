// ============================================================
// 雲端同步模組（2.0.10）：Supabase 快照式上傳/下載
// 上傳：整份匯出（複習計劃＋單詞本）→ 以 8 碼代碼存入雲端（重複上傳更新同一代碼）
// 下載：輸入代碼取回快照 → 勾選範圍（複習計劃／單詞本）→ 合併（保留本機、加入雲端）或替換
// 設定：supabase_config.txt（Project URL + anon key，見檔內說明）
// 【關聯註記】3.3.0：管理員後台「學習數據」讀取備份 payload.eventsSummary
//   （events 明細仍只存在本機 IndexedDB，雲端只放 ~0.2KB 的統計摘要；
//    payload 格式向後相容，舊版讀取會忽略此欄位）
// ============================================================
import { getAccessToken, getUser, restFetch, signOut } from './auth.js';
import {
  clearUnknown,
  exportMarks,
  exportWordbooks,
  getEvents,
  getUnknownMarks,
  getWordbooks,
  mergeMarks,
  mergeWordbooks,
  replaceAllMarks,
  replaceAllWordbooks,
} from './store.js';

const CODE_KEY = 'vocab2_sync_code';
const CHAR_SET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉 0/1/I/O 等易混字元

// ---------- 設定 ----------
export async function loadSupabaseConfig() {
  try {
    const res = await fetch('supabase_config.txt', { cache: 'no-cache' });
    const text = await res.text();
    let url = '', key = '';
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*#?\s*(Project URL|anon key)\s*=\s*(.+?)\s*$/i);
      if (!m) continue;
      if (m[1].toLowerCase().startsWith('project')) url = m[2].replace(/^#/, '').trim();
      else key = m[2].replace(/^#/, '').trim();
    }
    // 未設定時設定檔是「# Project URL=」註解狀態 → 值為空
    if (url && !url.startsWith('https://')) url = '';
    return { url, key, configured: Boolean(url && key) };
  } catch (err) {
    return { url: '', key: '', configured: false, error: String(err) };
  }
}

// ---------- 同步代碼 ----------
function generateCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => CHAR_SET[b % CHAR_SET.length]).join('');
}

export function getLocalCode() {
  return localStorage.getItem(CODE_KEY) || '';
}

export function setLocalCode(code) {
  localStorage.setItem(CODE_KEY, code);
}

export function resetLocalCode() {
  const code = generateCode();
  localStorage.setItem(CODE_KEY, code);
  return code;
}

// ---------- Supabase REST ----------
async function sbFetch(config, path, options = {}) {
  const res = await fetch(`${config.url}/rest/v1/${path}`, {
    ...options,
    headers: {
      'apikey': config.key,
      'Authorization': `Bearer ${config.key}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new Error(`Supabase HTTP ${res.status}：${detail}`);
  }
  return res;
}

// ---------- 匯出快照 ----------
async function buildSnapshot() {
  // 3.3.0：輕量統計摘要（~0.2KB；管理員後台「學習數據」用；payload 格式向後相容——
  // 舊版讀取忽略此欄位）
  const events = await getEvents();
  const summary = { cards: 0, reviews: 0, good: 0, translate: 0 };
  for (const ev of events) {
    if (ev.type === 'card') summary.cards++;
    else if (ev.type === 'review') { summary.reviews++; if (ev.extra === true) summary.good++; }
    else if (ev.type === 'translate') summary.translate++;
  }
  summary.first = events[0]?.at ?? null;
  summary.last = events[events.length - 1]?.at ?? null;

  return {
    app: 'vocab2',
    exportedAt: new Date().toISOString(),
    marks: await exportMarks(),
    wordbooks: await exportWordbooks(),
    eventsSummary: summary,
  };
}

// 上傳：以本機代碼（或新產生）整份上傳；重複上傳覆蓋同一代碼的雲端快照
export async function uploadSnapshot(deviceLabel = '') {
  const config = await loadSupabaseConfig();
  if (!config.configured) throw new Error('尚未設定 Supabase（見 supabase_config.txt 說明）');

  let code = getLocalCode();
  if (!code) {
    code = resetLocalCode();
  }
  const payload = await buildSnapshot();

  await sbFetch(config, 'vocab_snapshots?on_conflict=code', {
    method: 'POST',
    headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      code,
      payload,
      device_label: deviceLabel || null,
      exported_at: payload.exportedAt,
      uploaded_at: new Date().toISOString(),
    }),
  });

  return { code, marks: payload.marks.length, wordbooks: payload.wordbooks.length };
}

// 查詢某代碼的雲端快照摘要（不寫入本機）
export async function fetchSnapshot(code) {
  const config = await loadSupabaseConfig();
  if (!config.configured) throw new Error('尚未設定 Supabase（見 supabase_config.txt 說明）');
  const clean = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{8}$/.test(clean)) throw new Error('代碼格式錯誤（應為 8 碼英數）');

  const res = await sbFetch(config, `vocab_snapshots?code=eq.${clean}&select=*&limit=1`);
  const rows = await res.json();
  if (!rows.length) throw new Error('查無此代碼（請確認對方已上傳）');
  const row = rows[0];
  const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  return {
    code: clean,
    exportedAt: row.exported_at || payload.exportedAt,
    marks: Array.isArray(payload.marks) ? payload.marks : [],
    wordbooks: Array.isArray(payload.wordbooks) ? payload.wordbooks : [],
  };
}

// 下載還原：scope 選擇範圍，mode = 'merge' | 'replace'
export async function applySnapshot(snapshot, scope, mode) {
  const result = {};
  if (scope.marks) {
    if (mode === 'replace') {
      result.marks = await replaceAllMarks(snapshot.marks); // 回傳總筆數
    } else {
      result.marks = await mergeMarks(snapshot.marks); // 回傳新增筆數
    }
  }
  if (scope.wordbooks) {
    if (mode === 'replace') {
      result.wordbooks = await replaceAllWordbooks(snapshot.wordbooks);
    } else {
      result.wordbooks = await mergeWordbooks(snapshot.wordbooks);
    }
  }
  return result;
}

// ---------- 帳號雲端備份（3.1.0；與 8 碼快照並行，兩套互不干擾） ----------
// 每個帳號一份雲端備份（RLS：只有本人可讀寫），登入同一帳號即可還原
//
// 【關聯註記】4.2.0：上傳改走 peek/push 兩個 RPC（rev 樂觀鎖＋counts＋digest）。
//   舊路徑（REST POST ?on_conflict=user_id）只會覆蓋 body 內的欄位，
//   supabase_420.sql 新增的 rev／digest／marks_count 不在 body 內 → 更新後不會變動，
//   會讓「rev 相同即 in-sync」的判定誤判。**因此 rpcOk 時連手動上傳也必須走 RPC**，
//   只有 rpcOk=false（420.sql 尚未執行）才退回 REST POST。

// 舊路徑：整份覆蓋寫入（rev/digest 不在 body 內，不會被更新）
async function postBackup(payload, deviceLabel = '') {
  const uid = getUser()?.id;
  if (!uid) throw new Error('尚未登入');
  await restFetch('vocab_backups?on_conflict=user_id', {
    method: 'POST',
    headers: { Authorization: `Bearer ${await getAccessToken()}`, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      user_id: uid,
      payload,
      device_label: deviceLabel || null,
      exported_at: payload.exportedAt,
      uploaded_at: new Date().toISOString(),
    }),
  });
  return { marks: payload.marks.length, wordbooks: payload.wordbooks.length, exportedAt: payload.exportedAt };
}

// 帳號備份頁的「手動上傳」：rpcOk 時也走 push_backup（否則 rev/digest 不會更新，
// 下一輪 peek 會誤判雲端有變）。base_rev 取當下雲端的 rev＝使用者明示覆蓋的語意。
export async function uploadAccountBackup(deviceLabel = '') {
  const payload = await buildSnapshot();
  if (!getUser()?.id) throw new Error('尚未登入');
  if (rpcOk) {
    try {
      const cloud = await peekCloudState();
      const res = await pushViaRpc(payload, cloud && !cloud.legacy ? cloud.rev : null, deviceLabel);
      if (res.ok) {
        localRev = Number(res.rev) || localRev;
        digestCache = digestOf(payload);
        clearDirty();
        lastCloudUploadedAt = '';
        return { marks: payload.marks.length, wordbooks: payload.wordbooks.length, exportedAt: payload.exportedAt };
      }
      throw new Error(`雲端已被另一個裝置更新（rev 不符，雲端為 ${res.rev}）；請稍後再上傳，以免蓋掉對方的資料`);
    } catch (err) {
      if (!isRpcUnavailable(err)) throw err;
      disableRpc(err); // 420.sql 尚未執行 → 降級
    }
  }
  const r = await postBackup(payload, deviceLabel);
  clearDirty();
  return r;
}

export async function fetchAccountBackup() {
  const uid = getUser()?.id;
  if (!uid) throw new Error('尚未登入');
  const rows = await restFetch(`vocab_backups?user_id=eq.${uid}&select=*&order=uploaded_at.desc&limit=1`);
  if (!rows.length) return null;
  const row = rows[0];
  const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  return {
    uploadedAt: row.uploaded_at,
    exportedAt: row.exported_at || payload.exportedAt,
    marks: Array.isArray(payload.marks) ? payload.marks : [],
    wordbooks: Array.isArray(payload.wordbooks) ? payload.wordbooks : [],
  };
}

// 供同步頁顯示目前本機狀態
export async function localSummary() {
  const [marks, books] = await Promise.all([getUnknownMarks(), getWordbooks()]);
  return { marks: marks.length, wordbooks: books.length };
}

// ============================================================
// 自動同步（3.1.1；4.2.0 升級為 15 秒輪詢＋rev 樂觀鎖）
// 數量規則（沿用 3.1.1 用戶定案，未變）：
//   本機兩類資料都 ≥ 雲端（至少一類多）→ 本機直接覆蓋雲端
//   雲端兩類都 ≥ 本機（至少一類多）→ 自動合併雲端下來（登入後自動加載）
//   有多有少（交叉）／push 撞 rev（另一裝置先改過雲端）→ 詢問使用者並鎖住整條自動同步
//   兩邊數量完全相同 → 不動作（有本機變更時補一次上傳）
// 由 app.js 以 15 秒 setTimeout 串鏈驅動（另含 visibilitychange 補跑、變更去抖上傳）；
// getAutoSync() 控制開關；rpcOk 控制走 peek/push RPC 或舊的 uploaded_at＋REST 路徑
// ============================================================
import { emit } from '../core/eventbus.js';
import { getAutoSync } from './settings.js';

// ---------- 4.2.0 模組級狀態 ----------
let syncBusy = false;
let lastConflictDismissed = 0;  // 使用者按「稍後」後 10 分鐘內不再打擾
let lastCloudUploadedAt = '';   // 3.3.0 輕量化：上次見到的雲端時間戳（舊路徑用）
let lastSeenAt = '';            // 上次 peek 看到的 updated_at（rev 相同但 digest 缺失時的輔助判定）
let lastConflictAt = 0;         // 最近一次進入衝突的時間（冷卻計算用）
let conflictPending = false;    // 4.2.0 衝突鎖：交叉／rev-mismatch 後鎖住整條自動同步
let localRev = 0;               // 自己上次成功上傳（或上次觀察）後的雲端 rev
let digestCache = '';           // 與 localRev 同一時刻的雲端 digest（空字串＝雲端尚未有 digest）
let rpcOk = true;               // peek/push RPC 可用性；遇 404/42703/PGRST202 → false，之後不再嘗試
let dirty = false;              // 本機有未上傳的變更（store:changed 去抖後標記；上傳失敗保留）
const CONFLICT_COOLDOWN_MS = 10 * 60 * 1000;

// 32-bit FNV-1a（零依賴）：只回答「內容有沒有變」，不是安全雜湊
// 成本說明：只在真的要上傳前計算一次；15 秒 in-sync 快路徑完全不會呼叫
function digestOf(payload) {
  const s = JSON.stringify([payload.marks, payload.wordbooks]);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

// 420.sql 未套用時 PostgREST 的兩種回應：RPC 不存在 → 404/PGRST202；新欄位不存在 → 42703
// （restFetch 拋出的訊息形如「Supabase HTTP 404：{...}」，故比對狀態碼前綴而非任意數字，
//   避免 payload 內容裡剛好出現「404」就被誤判成降級）
function isRpcUnavailable(err) {
  const m = String(err?.message || err || '');
  // 4.2.0 修復（debug sweep）：最後的 /42703/ 原為無邊界比對——若雲端 rev 恰為 42703
  // （或含此子字串），rev-mismatch 訊息會被誤判成「RPC 不可用」而靜默降級整份覆蓋
    // 4.3.0 修復（Pool B High）：第三子句改上下文限定——42703 須出現在 HTTP 錯誤本文內，
  // 舊裸比對會把「雲端 rev 恰為 42703」的 JS 自製訊息誤判成降級
  return /Supabase HTTP (404|42703)\b/.test(m) || /PGRST202/i.test(m) || /Supabase HTTP \d{3}[：:][\s\S]*\b42703\b/.test(m);
}

// 降級只提示一次（否則每 15 秒刷一次 console）
function disableRpc(err) {
  if (!rpcOk) return;
  rpcOk = false;
  console.warn(
    '[同步] peek/push RPC 不可用（請先在 Supabase 執行 tools/supabase_420.sql）；'
    + '已降級為「時間戳＋REST 上傳」舊路徑，本則只提示一次。',
    err?.message || err,
  );
}

// 輕量探測（舊路徑）：只抓 uploaded_at（約 50 bytes），不下載整份 payload
// 【關聯註記】3.3.0 效能優化——原版每輪下載整份備份比對數量，教室規模下
// 月流量會逼近 Supabase 免費額度 5GB；改為「時間戳無變化即 in-sync」
async function peekCloudUploadedAt() {
  const uid = getUser()?.id;
  if (!uid) return null;
  const rows = await restFetch(`vocab_backups?user_id=eq.${uid}&select=uploaded_at&order=uploaded_at.desc&limit=1`);
  return rows[0]?.uploaded_at ?? null;
}

// 輕量探測（4.2.0 主路徑）：rpc/peek_backup 回 {rev, counts, digest, client_id} 或 null（無備份）
// 回傳物件統一形狀：{legacy, rev, marks, wordbooks, digest, clientId, uploadedAt}
async function peekCloudState() {
  const uid = getUser()?.id;
  if (!uid) return null;
  if (rpcOk) {
    try {
      const row = await restFetch('rpc/peek_backup', { method: 'POST', body: JSON.stringify({}) });
      if (!row) return null; // 雲端還沒有備份
      return {
        legacy: false,
        rev: Number(row.rev) || 0,
        marks: Number(row.marks_count) || 0,
        wordbooks: Number(row.wordbooks_count) || 0,
        digest: row.digest || '',
        clientId: row.client_id || '',
        uploadedAt: row.updated_at || '',
      };
    } catch (err) {
      if (!isRpcUnavailable(err)) throw err;
      disableRpc(err);
    }
  }
  return {
    legacy: true, rev: 0, marks: 0, wordbooks: 0, digest: '', clientId: '',
    uploadedAt: await peekCloudUploadedAt(),
  };
}

// 樂觀鎖上傳（4.2.0）：p_base_rev 不符 → {ok:false, reason:'rev-mismatch'}，不覆蓋
async function pushViaRpc(payload, baseRev, deviceLabel = '') {
  const res = await restFetch('rpc/push_backup', {
    method: 'POST',
    body: JSON.stringify({
      p_payload: payload,
      p_device: deviceLabel || null,
      p_client: getLocalCode() || null,
      p_marks: payload.marks.length,
      p_books: payload.wordbooks.length,
      p_digest: digestOf(payload),
      p_base_rev: baseRev === null || baseRev === undefined ? null : Number(baseRev),
    }),
  });
  if (!res || typeof res.ok !== 'boolean') throw new Error('push_backup 回應異常');
  return res;
}

function markDirty() { dirty = true; }
function clearDirty() { dirty = false; }
export function isDirty() { return dirty; }
export function isSyncLocked() { return conflictPending; } // app.js 的 15 秒鏈用它跳過本輪
export function isSyncing() { return syncBusy; }            // app.js 的 15 秒鏈用它跳過本輪

// 4.2.0 修復（debug sweep High）：換帳號時重置模組級同步狀態——
// 舊帳號留下的 localRev 會讓新帳號第一輪 push 必然 rev-mismatch（幽靈衝突＋10 分鐘鎖）。
// rpcOk 是伺服器能力（與帳號無關）刻意保留；dirty 保留（本機未上傳變更仍屬於本機）。
export function resetSyncState() {
  localRev = 0;
  digestCache = '';
  conflictPending = false;
  lastCloudUploadedAt = '';
}

// 上傳去抖：store:changed（一次 20 題練習＝20 次寫入）在 4 秒內合併成 1 次上傳
const UPLOAD_DEBOUNCE_MS = 4000;
let uploadTimer = null;
let applyingCloud = false; // 套用雲端快照期間忽略 store:changed（否則上傳→合併→再上傳）

/**
 * store:changed 的唯一消費端（app.js 以 on('store:changed', notifyStoreChanged) 接線）
 * 語意：標記 dirty → 4 秒靜默後跑一輪同步（離線時 dirty 保留，離線恢復後重試）
 */
export function notifyStoreChanged() {
  if (applyingCloud) return; // 這批變更是自己從雲端合併來的，不算「本機有新東西」
  markDirty();
  if (uploadTimer) clearTimeout(uploadTimer);
  const scheduledFor = getUser()?.id ?? null; // 4.3.0：記下排定時的帳號——觸發時換了人就直接作廢
  uploadTimer = setTimeout(() => {
    uploadTimer = null;
    if ((getUser()?.id ?? null) !== scheduledFor) return; // 4.3.0 修復（Pool B High）：換帳號後舊計時器不得觸發（防跨帳號外洩）
    runAutoSyncCycle().catch((err) => console.warn('變更後上傳失敗（下一輪自動重試）：', err.message));
  }, UPLOAD_DEBOUNCE_MS);
}

// 4.3.0 修復（Pool B High）：換帳號時必須取消前一帳號排定的去抖上傳——
// 否則 A 帳號期間的待上傳會在 B 的 session 下觸發，把本機整份資料推進 B 的雲端（跨帳號外洩）
export function cancelPendingUpload() {
  if (uploadTimer) { clearTimeout(uploadTimer); uploadTimer = null; }
}

async function applyCloudSnapshot(snapshot) {
  applyingCloud = true;
  try {
    await applySnapshot(snapshot, { marks: true, wordbooks: true }, 'merge');
  } finally {
    applyingCloud = false;
  }
}

// 進入衝突：鎖住整條自動同步（10 分鐘冷卻後自動重試）
function enterConflict(local, cloud, cloudAt) {
  conflictPending = true;
  lastConflictAt = Date.now();
  emit('sync:conflict', { local, cloud, cloudAt: cloudAt || '' });
}

// token 過期／被撤銷（Supabase 回 401）→ 登出。放在這裡是因為 restFetch 本身只會丟錯，
// 不處理 401（auth.js 的 initAuth 另有還原失敗路徑，但那要等下一次載入）。
function signOutIfUnauthorized(err) {
  if (!/Supabase HTTP 401\b/.test(String(err?.message || err || ''))) return false;
  signOut().catch(() => {});
  return true;
}

// in-sync 判定（15 秒一輪的常見路徑：命中即 0 次 IndexedDB 讀取、0 次 payload 下載）
//   舊 schema（無 rev）：退回比 uploaded_at（3.3.0 行為）
//   新 schema：rev 必須與上次觀察/上傳後相同；有 digest 時 digest 也要相同
//     若雲端 digest 為 null（420.sql 回填未算、或這列是未升級客戶端用舊 REST 路徑寫的），
//     只能退回比 updated_at
function isInSync(cloud) {
  if (dirty || !cloud) return false;
  if (cloud.legacy) return Boolean(cloud.uploadedAt) && cloud.uploadedAt === lastCloudUploadedAt;
  if (!cloud.rev || cloud.rev !== localRev) return false;
  if (cloud.digest && digestCache) return cloud.digest === digestCache;
  return Boolean(cloud.uploadedAt) && cloud.uploadedAt === lastSeenAt;
}

// 執行一次比對與同步；回傳本輪採取的動作描述（供測試與狀態列）
async function cycle() {
  if (syncBusy || !getAutoSync() || !getUser()) return 'skipped:off';
  if (conflictPending) {
    if (Date.now() - lastConflictAt < CONFLICT_COOLDOWN_MS) return 'skipped:conflict';
    conflictPending = false; // 冷卻到期：解鎖後重新比對
  }
  syncBusy = true;
  try {
    // (a) 輕量探測：rev 未變且 digest 相符 → 立即收工
    //     （15 秒一輪的常見路徑：一次網路來回、零 IndexedDB 讀取、零 payload 下載）
    const cloud = await peekCloudState();
    if (isInSync(cloud)) return 'in-sync';
    if (cloud?.legacy) lastCloudUploadedAt = cloud.uploadedAt || '';
    else if (cloud) lastSeenAt = cloud.uploadedAt || '';

    // (b) 決策：數量比對（主路徑用 peek 帶回的 counts，不下載 payload）
    const local = await localSummary();
    const l = { m: local.marks, b: local.wordbooks };
    if (!cloud) {
      // 雲端沒有備份 → 把本機推上去（首次登入；p_base_rev=null 走 INSERT 分支）
      const r = await pushLocal(l, null);
      emit('sync:auto', { action: 'uploaded-first', local: l });
      return `uploaded-first(${r.marks}m/${r.wordbooks}b)`;
    }
    const c = { m: cloud.marks, b: cloud.wordbooks };
    if (cloud.legacy) {
      // 舊 schema 拿不到 counts → 這裡才下載整份做數量規則
      const full = await fetchAccountBackup();
      if (!full) {
        const r = await pushLocal(l, null);
        emit('sync:auto', { action: 'uploaded-first', local: l });
        return `uploaded-first(${r.marks}m/${r.wordbooks}b)`;
      }
      c.m = full.marks.length;
      c.b = full.wordbooks.length;
    }

    if (l.m === c.m && l.b === c.b) {
      if (!dirty) {
        if (!cloud.legacy) { localRev = cloud.rev; digestCache = cloud.digest || ''; }
        return 'in-sync';
      }
      // 數量一致但本機有變更（SRS 排程推進之類）→ 先記下雲端 rev 再補一次上傳
      //（數量一致＝剛才已比對過兩邊無需合併，雲端 rev 可安全認列，否則 push 會誤判 rev-mismatch）
      if (!cloud.legacy) { localRev = cloud.rev; }
      const r = await pushLocal(l, cloud);
      emit('sync:auto', { action: 'uploaded', local: l, cloud: c });
      return `uploaded(${r.marks}m/${r.wordbooks}b, same-count)`;
    }

    const localMore = l.m >= c.m && l.b >= c.b && (l.m > c.m || l.b > c.b);
    const cloudMore = c.m >= l.m && c.b >= l.b && (c.m > l.m || c.b > l.b);

    if (localMore) {
      const r = await pushLocal(l, cloud);
      if (r.conflicted) return 'conflict-prompted';
      emit('sync:auto', { action: 'uploaded', local: l, cloud: c });
      return `uploaded(${l.m}m/${l.b}b over ${c.m}m/${c.b}b)`;
    }
    if (cloudMore) {
      // 需要實際資料才能合併 → 這裡才下載 payload
      // 合併是「只加不減」（本機既有的保留、雲端多出的加入），即使本機有未上傳的變更也不會
      // 丟資料，所以不需要問使用者；合併完標 dirty，下一輪會把聯集推回雲端
      const full = await fetchAccountBackup();
      if (!full) return 'in-sync';
      await applyCloudSnapshot({ marks: full.marks, wordbooks: full.wordbooks });
      // 合併後本機＝兩邊聯集 → 本機仍領先雲端，必須標記 dirty 讓下一輪補上傳，
      // 否則 15 秒鏈會一直看到「rev 沒變」而永不把合併結果推回雲端
      if (!cloud.legacy) { localRev = cloud.rev; digestCache = cloud.digest || ''; }
      markDirty();
      lastCloudUploadedAt = '';
      lastSeenAt = cloud.legacy ? '' : cloud.uploadedAt;
      emit('sync:auto', { action: 'merged-down', local: l, cloud: c });
      return `merged-down(${c.m}m/${c.b}b over ${l.m}m/${l.b}b)`;
    }
    // 交叉（有多有少）／10 分鐘內按過「稍後」→ 詢問使用者並鎖住整條自動同步
    if (Date.now() - lastConflictDismissed < CONFLICT_COOLDOWN_MS) return 'deferred-by-user';
    enterConflict(l, c, cloud.uploadedAt);
    return 'conflict-prompted';
  } finally {
    syncBusy = false; // 注意：dirty 不在此清除——上傳失敗（離線）必須保留，下一輪重試
  }
}

// runAutoSyncCycle 的外層：401 → 登出（交給 auth.js 既有流程），其餘照舊往外丟
export async function runAutoSyncCycle() {
  try {
    return await cycle();
  } catch (err) {
    if (signOutIfUnauthorized(err)) return 'skipped:unauthorized';
    throw err;
  }
}

// (c) 上傳：p_base_rev＝**localRev（自己上次成功上傳後看到的雲端 rev）**，不是本輪 peek 的 rev。
// 這是 push_backup 樂觀鎖的正確用法：若雲端 rev 在兩次裝置動作之間被別台裝置推進過，
//   base 不符 → 雲端回 {ok:false, reason:'rev-mismatch'} → 轉衝突流程（不覆蓋）。
// 若填「本輪 peek 的 rev」，base 必然等於雲端現況，rev-mismatch 永遠不會發生，
//   樂觀鎖形同虛設、另一台裝置的資料會被靜默蓋掉。
// localRev 為 0（本分頁剛載入、還沒有上傳記憶）時退回用本輪 peek 的 rev。
// force=true 只用於使用者明確按「本機覆蓋雲端」——此時以當下雲端 rev 為 base 強制覆蓋。
async function pushLocal(l, cloud, force = false) {
  const payload = await buildSnapshot();
  const digest = digestOf(payload);
  if (cloud && !cloud.legacy && cloud.digest && cloud.digest === digest) {
    // 內容與雲端完全相同（常見於 merge-down 後的補上傳）→ 不必重複上傳
    localRev = cloud.rev;
    digestCache = digest;
    clearDirty();
    return { marks: payload.marks.length, wordbooks: payload.wordbooks.length };
  }
  const baseRev = force
    ? (cloud && !cloud.legacy ? cloud.rev : null)
    : (localRev || (cloud && !cloud.legacy ? cloud.rev : null));
  if (rpcOk) {
    let res = null;
    try {
      res = await pushViaRpc(payload, baseRev);
    } catch (err) {
      if (!isRpcUnavailable(err)) throw err; // 離線／500 → 往外丟，dirty 保留
      disableRpc(err);
    }
    if (res) {
      if (res.ok) {
        // 4.2.0 修復：上傳後必須記下新 rev，否則下一輪 peek 會誤判「雲端有變」而多下一次載
        localRev = Number(res.rev) || localRev;
        digestCache = digest;
        clearDirty();
        lastCloudUploadedAt = '';
        return { marks: payload.marks.length, wordbooks: payload.wordbooks.length };
      }
      // rev-mismatch：雲端已被另一裝置推進，補抓一次實際數量再問使用者（僅此罕見路徑）
      const fresh = await fetchAccountBackup().catch(() => null);
      enterConflict(
        l,
        fresh ? { m: fresh.marks.length, b: fresh.wordbooks.length } : { m: cloud?.marks ?? 0, b: cloud?.wordbooks ?? 0 },
        fresh?.uploadedAt || cloud?.uploadedAt,
      );
      return { marks: payload.marks.length, wordbooks: payload.wordbooks.length, conflicted: true };
    }
  }
  const r = await postBackup(payload); // 舊路徑：rev/digest 不會被更新，故不動 localRev
  clearDirty();
  lastCloudUploadedAt = '';
  return r;
}

// 使用者在衝突對話框的選擇（由 pages/app 呼叫）
export async function resolveConflict(choice) {
  if (choice === 'overwrite') {
    // 使用者明示「本機覆蓋雲端」→ force：以當下雲端 rev 為 base 跳過樂觀鎖
    const cloud = await peekCloudState();
    const local = await localSummary();
    const r = await pushLocal({ m: local.marks, b: local.wordbooks }, cloud, true);
    if (r.conflicted) return 'conflict-again';
    conflictPending = false;
    lastConflictDismissed = Date.now();
    emit('sync:auto', { action: 'uploaded', by: 'user' });
    return 'uploaded';
  }
  if (choice === 'later') {
    lastConflictDismissed = Date.now(); // 稍後：保持鎖住，10 分鐘冷卻後自動重試
    return 'deferred';
  }
  if (choice === 'merge') {
    const local = await localSummary();
    const cloud = await fetchAccountBackup();
    if (!cloud) return 'no-cloud';
    await applyCloudSnapshot({ marks: cloud.marks, wordbooks: cloud.wordbooks });
    const state = await peekCloudState();
    if (state && !state.legacy) { localRev = state.rev; digestCache = state.digest || ''; }
    // 合併後本機＝兩邊聯集 → 標 dirty 讓下一輪把聯集推回雲端（清掉會永遠停在 in-sync）
    markDirty();
    lastCloudUploadedAt = '';
    conflictPending = false;
    lastConflictDismissed = Date.now();
    emit('sync:auto', { action: 'merged-down', by: 'user', local: { m: local.marks, b: local.wordbooks } });
    return 'merged';
  }
  lastConflictDismissed = Date.now(); // 其他值（含舊版的 'later'）一律視為稍後
  return 'deferred';
}
