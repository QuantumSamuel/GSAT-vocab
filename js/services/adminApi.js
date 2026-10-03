// ============================================================
// 管理員專用 API 封裝（3.3.0）：需要 service_role 才能做的操作
// 【關聯註記】呼叫 Supabase Edge Function（由管理者部署）；
//   使用 services/auth.js 的 getAccessToken；軟刪除走 RPC（admin.js 直接呼叫），
//   本檔只管「需要 service_role 的操作」：重置密碼／硬刪除
// 3.3.0 名稱容錯：v2 修復版實際部署名為 'smart-api'（Dashboard 不支援改名），
//   呼叫順序＝admin_action → smart-api；日後整併名稱時改 FN_FALLBACK 即可
// ============================================================
import { getAccessToken } from './auth.js';
import { loadSupabaseConfig } from './sync.js';

// 4.2.0 對調：admin_action Edge Function 已自專案消失（404 實測 2026-10-02），smart-api 為現役
const FN_PRIMARY = 'smart-api';
const FN_FALLBACK = 'admin_action';

/**
 * 呼叫 admin_action Edge Function。
 * @param {string} action  動作名（reset_password / hard_delete / …）
 * @param {string} targetUid 目標帳號 uid
 * @param {object} extra  附加參數（例如 { newPassword: '00000000' }）
 */
export async function edgeAdminAction(action, targetUid, extra = {}) {
  const config = await loadSupabaseConfig();
  if (!config.configured) throw new Error('尚未設定 Supabase（見 supabase_config.txt 說明）');
  const token = await getAccessToken();
  if (!token) throw new Error('尚未登入');

  let lastErr = null;
  for (const fn of [FN_PRIMARY, FN_FALLBACK]) {
    let res;
    try {
      res = await fetch(`${config.url}/functions/v1/${fn}`, {
        method: 'POST',
        headers: {
          apikey: config.key,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action, targetUid, ...extra }),
      });
    } catch (err) {
      // 網路層失敗（含被刪除函式的 404 無 CORS 標頭被瀏覽器攔）→ 主名稱時換備援
      lastErr = new Error(`無法連到 Edge Function（${fn}）：${String(err.message || err)}`);
      if (fn === FN_PRIMARY) continue;
      throw lastErr;
    }
    const data = await res.json().catch(() => ({}));
    if (res.ok) return data;
    const detail = data?.error || data?.message || data?.detail;
    // 503 BOOT_ERROR／404 = 該名稱沒有可用部署 → 換備援名稱；其他（權限等）直接拋
    if ((res.status === 503 || res.status === 404) && fn === FN_PRIMARY) {
      lastErr = new Error(detail ? String(detail) : `Edge Function HTTP ${res.status}`);
      continue;
    }
    throw new Error(detail ? String(detail) : `Edge Function HTTP ${res.status}`);
  }
  throw lastErr ?? new Error('Edge Function 無法呼叫');
}

// 重置密碼為 8 個 0（使用者首次登入後自行更改）
export async function adminResetPassword(uid, newPassword = '00000000') {
  return edgeAdminAction('reset_password', uid, { newPassword });
}

// 硬刪除帳號（不可復原；後端以 service_role 執行）
export async function adminHardDelete(uid) {
  return edgeAdminAction('hard_delete', uid);
}
