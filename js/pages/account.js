// ============================================================
// 頁面：賬戶（4.0.0 新增；入口在使用者選單「個人主頁」下方）
// 四區：①帳號資訊 ②修改密碼（需先驗證原密碼）
//        ③雲端同步（帳號備份，自 sync.js 移入）④注銷賬號（自 profile.js 移入）
// 【關聯註記】本機學習統計仍在個人主頁；8 碼快照同步仍在「同步」頁
// ============================================================
import { getUser, getProfile, restFetch, signOut, changePassword } from '../services/auth.js';
import { applySnapshot, fetchAccountBackup, uploadAccountBackup } from '../services/sync.js';
import { el, escapeHtml, openDialog, toast } from '../core/ui.js';

export async function renderAccount(main) {
  const user = getUser();
  if (!user) { location.hash = '#/auth?tab=login'; return; }
  const profile = getProfile();

  main.replaceChildren(el(`
    <div class="account-layout">
      <section class="card ac-info">
        <h2>賬戶</h2>
        <p>Email：<strong>${escapeHtml(user.email || '')}</strong>
          ${profile?.role === 'admin' ? '<span class="badge">管理員</span>' : ''}
          ${profile?.banned ? '<span class="import-bad">（已停權）</span>' : ''}</p>
      </section>
      <section class="card ac-pw">
        <h2>修改密碼</h2>
        <div class="pw-form">
          <label>原密碼 <input type="password" id="pw-old" autocomplete="current-password"></label>
          <label>新密碼 <input type="password" id="pw-new" autocomplete="new-password" placeholder="至少 8 碼"></label>
          <label>確認新密碼 <input type="password" id="pw-new2" autocomplete="new-password"></label>
        </div>
        <div class="controls controls-start">
          <button class="btn primary" id="btn-pw-save">儲存新密碼</button>
        </div>
        <p class="pf-danger-msg" id="pw-msg"></p>
      </section>
      <section class="card ac-sync">
        <h2>雲端同步（帳號）</h2>
        <p class="muted small">把複習計劃與單詞本備份到你的帳號，換裝置登入同一帳號即可還原；與「同步」頁的 8 碼代碼並行，互不干擾。</p>
        <div class="controls controls-start">
          <button class="btn primary" id="btn-ac-upload">上傳備份到雲端</button>
          <button class="btn" id="btn-ac-restore">還原雲端備份</button>
        </div>
        <p class="warning" id="ac-warning"></p>
        <div id="ac-backup-panel"></div>
      </section>
      <section class="card pf-danger ac-danger">
        <h2>注銷賬號</h2>
        <p class="pf-danger-note">注銷後帳號立即停權、Email 釋出；雲端資料保留，恢復需聯絡管理員。本機資料不受影響。</p>
        <button class="btn subtle" id="ac-delete">注銷我的帳號</button>
        <p class="pf-danger-msg" id="ac-danger-msg"></p>
      </section>
    </div>`));

  bindPassword(main);
  bindBackup(main);
  bindDelete(main);
}

// ---------- ② 修改密碼：前端先驗兩次輸入一致，後端 changePassword 驗原密碼 ----------
function bindPassword(main) {
  const btn = main.querySelector('#btn-pw-save');
  const msg = main.querySelector('#pw-msg');
  btn.addEventListener('click', async () => {
    const oldPw = main.querySelector('#pw-old').value;
    const newPw = main.querySelector('#pw-new').value;
    const newPw2 = main.querySelector('#pw-new2').value;
    msg.textContent = '';
    if (!oldPw) { msg.textContent = '請輸入原密碼。'; return; }
    if (newPw.length < 8) { msg.textContent = '新密碼至少 8 碼。'; return; }
    if (newPw !== newPw2) { msg.textContent = '兩次輸入的新密碼不一致。'; return; }
    if (newPw === oldPw) { msg.textContent = '新密碼不可與原密碼相同。'; return; }
    btn.disabled = true;
    msg.textContent = '驗證與更新中…';
    try {
      await changePassword(oldPw, newPw);
      msg.textContent = '';
      main.querySelector('#pw-old').value = '';
      main.querySelector('#pw-new').value = '';
      main.querySelector('#pw-new2').value = '';
      // 4.2.0：資訊型 alert → toast（改密本身不另加確認框，維持一次提交流程）
      toast('密碼已更新，下次登入請使用新密碼。', 'ok');
    } catch (err) {
      msg.textContent = `修改失敗：${escapeHtml(String(err.message || err).slice(0, 160))}`;
    }
    btn.disabled = false;
  });
}

// ---------- ③ 雲端同步（帳號備份）：自 sync.js 移入 ----------
function bindBackup(main) {
  main.querySelector('#btn-ac-upload').addEventListener('click', async () => {
    const warn = main.querySelector('#ac-warning');
    const panel = main.querySelector('#ac-backup-panel');
    warn.textContent = '';
    panel.replaceChildren(el('<p class="muted">備份上傳中…</p>'));
    try {
      const r = await uploadAccountBackup();
      panel.replaceChildren(el(`<p class="finish">備份完成：複習計劃 ${r.marks} 字、單詞本 ${r.wordbooks} 本（${escapeHtml((r.exportedAt || '').replace('T', ' ').slice(0, 19))}）</p>`));
    } catch (err) {
      panel.replaceChildren(el(`<p class="warning">備份失敗：${escapeHtml(String(err.message || err))}</p>`));
    }
  });

  main.querySelector('#btn-ac-restore').addEventListener('click', async () => {
    const warn = main.querySelector('#ac-warning');
    const panel = main.querySelector('#ac-backup-panel');
    warn.textContent = '';
    panel.replaceChildren(el('<p class="muted">讀取雲端備份…</p>'));
    try {
      const backup = await fetchAccountBackup();
      if (!backup) { panel.replaceChildren(el('<p class="muted">雲端還沒有備份：先按「上傳備份到雲端」。</p>')); return; }
      renderRestorePanel(panel, backup);
    } catch (err) {
      panel.replaceChildren(el(`<p class="warning">讀取失敗：${escapeHtml(String(err.message || err))}</p>`));
    }
  });

  function renderRestorePanel(panel, backup) {
    panel.replaceChildren(el(`
      <div class="save-form">
        <p>雲端備份（${escapeHtml((backup.uploadedAt || '').replace('T', ' ').slice(0, 19))}）：</p>
        <ul>
          <li>複習計劃：<strong>${backup.marks.length}</strong> 字</li>
          <li>單詞本：<strong>${backup.wordbooks.length}</strong> 本</li>
        </ul>
        <p><strong>還原方式：</strong></p>
        <div class="mode-grid">
          <label class="mode-card"><input type="radio" name="ac-mode" value="merge" checked>
            <span class="mode-title">合併</span>
            <span class="mode-desc">保留本機既有，加入雲端多出來的</span></label>
          <label class="mode-card"><input type="radio" name="ac-mode" value="replace">
            <span class="mode-title">替換</span>
            <span class="mode-desc">本機該部分整個換成雲端資料</span></label>
        </div>
        <div class="controls">
          <button class="btn primary" id="btn-ac-apply">執行還原</button>
        </div>
        <div id="ac-apply-result"></div>
      </div>`));
    panel.querySelector('#btn-ac-apply').addEventListener('click', async () => {
      const mode = panel.querySelector('input[name="ac-mode"]:checked').value;
      const resultBox = panel.querySelector('#ac-apply-result');
      // 4.2.0：confirm → openDialog（「替換」覆蓋本機資料＝danger；「合併」為一般動作）
      const ok = await openDialog({
        title: '執行還原',
        body: mode === 'replace'
          ? '「替換」會把本機的複習計劃與單詞本整個換成雲端備份，本機既有的這兩部分會被覆蓋。'
          : '以「合併」方式還原雲端備份？本機既有的資料會保留。',
        danger: mode === 'replace',
        okText: mode === 'replace' ? '替換' : '合併',
        cancelText: '取消',
      });
      if (!ok) return;
      resultBox.replaceChildren(el('<p class="muted">還原中…</p>'));
      try {
        const r = await applySnapshot(backup, { marks: true, wordbooks: true }, mode);
        resultBox.replaceChildren(el(`<p class="finish">${mode === 'replace' ? '已替換' : '已合併'}：複習計劃 ${r.marks} 字、單詞本 ${r.wordbooks} 本</p>`));
      } catch (err) {
        resultBox.replaceChildren(el(`<p class="warning">還原失敗：${escapeHtml(String(err.message || err))}</p>`));
      }
    });
  }
}

// ---------- ④ 注銷賬號：兩次確認（第二次輸入 4 位隨機碼），自 profile.js 移入 ----------
function bindDelete(main) {
  const btn = main.querySelector('#ac-delete');
  const msg = main.querySelector('#ac-danger-msg');
  btn.addEventListener('click', async () => {
    // 4.2.0：注銷＝最高級破壞性動作（danger），第二段改用 openDialog 的 input 模式輸入 4 位碼
    const ok = await openDialog({
      title: '注銷帳號',
      body: '確定要注銷帳號？注銷後會立即被登出，Email 釋出後可能被他人重新註冊。此操作不可復原。',
      danger: true,
      okText: '繼續注銷',
      cancelText: '取消',
    });
    if (!ok) return;

    const code = String(Math.floor(1000 + Math.random() * 9000));
    const typed = await openDialog({
      title: '防誤觸確認',
      // bodyHtml：把要照打的 4 位碼排成等寬塊（4.2.0 批次 3 新增 .dlg-code）
      bodyHtml: `請輸入以下 4 位數字以確認注銷：<span class="dlg-code">${escapeHtml(code)}</span>輸入完全相同的數字才能繼續。`,
      input: true,
      value: '',
      placeholder: '輸入 4 位數字',
      danger: true,
      okText: '確認注銷',
      cancelText: '取消',
    });
    if (typed === null) { msg.textContent = '已取消，帳號未變更。'; return; }
    if (typed.trim() !== code) { msg.textContent = '數字不符，已取消，帳號未變更。'; return; }

    btn.disabled = true;
    msg.textContent = '處理中…';
    try {
      await restFetch('rpc/delete_own_account', { method: 'POST', body: JSON.stringify({}) });
      await signOut();
      location.hash = '#/';
      toast('帳號已注銷', 'ok');
    } catch (err) {
      btn.disabled = false;
      msg.textContent = `注銷失敗：${escapeHtml(String(err.message || err).slice(0, 160))}`;
    }
  });
}
