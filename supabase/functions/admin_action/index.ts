// ============================================================
// Edge Function：admin_action（3.3.0 v2——修復 SUPABASE_URL 重複宣告導致的
// BOOT_ERROR「Identifier has already been declared」）
// 【關聯註記】前端封裝＝js/services/adminApi.js（edgeAdminAction）
// 職責：需要 service_role 權限的管理操作（修改/重置密碼、硬刪除）
// 安全：驗證呼叫者 JWT → profiles 確認 role=admin／非停權／
//       層級規則（reset_password 需層級 2+；硬刪除僅層級 3）→
//       不可操作自己與層級不低於自己的帳號 → 每次呼叫記入 function_logs
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

Deno.serve(async (req) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
  };
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  // 記帳（成功與失敗都記；用戶硬要求的用量即時呈現資料源）
  const logEvent = async (actor: string | null, target: string | null, ok: boolean, detail: string) => {
    try {
      await admin.from('function_logs').insert({ fn: 'admin_action', actor, target_uid: target, ok, detail });
    } catch { /* 記帳失敗不影響回覆 */ }
  };

  let actorId: string | null = null;
  let targetUid: string | null = null;
  let action = '';

  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader.startsWith('Bearer ')) throw new Error('NO_TOKEN');
    const token = authHeader.slice(7);

    // 呼叫者身份（以 JWT 驗證，不信任前端聲明）
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser(token);
    if (userErr || !userData?.user) throw new Error('INVALID_TOKEN');
    actorId = userData.user.id;

    // 呼叫者層級
    const { data: prof, error: profErr } = await admin
      .from('profiles').select('role, admin_level, banned').eq('id', actorId).single();
    if (profErr || !prof) throw new Error('PROFILE_NOT_FOUND');
    if (prof.role !== 'admin' || prof.banned) throw new Error('FORBIDDEN');
    const myLv = prof.admin_level ?? 0;

    const body = await req.json();
    action = String(body.action ?? '');
    targetUid = String(body.targetUid ?? '');
    if (!targetUid) throw new Error('缺少 targetUid');

    // 目標帳號層級（牴觸採高優先級＝低階者根本動不了高階者）
    const { data: tgt, error: tgtErr } = await admin
      .from('profiles').select('admin_level, role, banned, email').eq('id', targetUid).single();
    if (tgtErr || !tgt) throw new Error('TARGET_NOT_FOUND');
    const tgtLv = tgt.admin_level ?? 0;

    if (targetUid === actorId) throw new Error('FORBIDDEN: 不能對自己操作');
    if (tgtLv >= myLv) throw new Error(`FORBIDDEN: 目標帳號層級（${tgtLv}）不低於你（${myLv}）`);

    let ok = false;
    let detail = '';

    if (action === 'reset_password') {
      if (myLv < 1) throw new Error('FORBIDDEN: 僅管理員可執行');
      const newPassword = String(body.newPassword ?? '');
      if (newPassword.length < 6) throw new Error('密碼至少 6 碼');
      const { error } = await admin.auth.admin.updateUserById(targetUid, { password: newPassword });
      if (error) throw new Error(error.message);
      detail = '重置密碼（管理員指定）';
      ok = true;
    } else if (action === 'hard_delete') {
      if (myLv < 3) throw new Error('FORBIDDEN: 硬刪除僅根管理員（層級 3）');
      const { error } = await admin.auth.admin.deleteUser(targetUid);
      if (error) throw new Error(error.message);
      detail = '硬刪除帳號';
      ok = true;
    } else {
      throw new Error(`未知 action：${action}`);
    }

    await logEvent(actorId, targetUid, ok, detail);
    return new Response(JSON.stringify({ ok: true, action, detail }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const detail = String((err as Error).message ?? err).slice(0, 200);
    await logEvent(actorId, targetUid, false, detail);
    return new Response(JSON.stringify({ ok: false, error: detail }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
});
