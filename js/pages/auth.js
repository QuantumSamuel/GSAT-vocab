// ============================================================
// 頁面：登入／註冊（3.2.0 全新界面）
// 【關聯註記】註冊模式由 services/auth.js 的 REGISTRATION_MODE 決定：
//   'key'＝顯示金鑰欄（現行）；'otp'＝註冊後走驗證碼面板（入口隱藏）
//   登入一律帳密；未驗證帳號登入時帶出 OTP 面板（3.1.0 相容路徑）
// ============================================================
import { getUser, REGISTRATION_MODE, signIn, signUp, signUpWithKey, verifySignupCode, resendSignupCode } from '../services/auth.js';
import { el, escapeHtml } from '../core/ui.js';

// 分頁狀態以網址 query 為唯一來源（#/auth?tab=signup）——
// 3.3.1 修復：原先模組變數 activeTab 會被每次渲染從網址重讀蓋掉，導致切換失效
function currentTab() {
  const urlTab = new URLSearchParams(location.hash.split('?')[1] || '').get('tab');
  return urlTab === 'signup' ? 'signup' : 'login';
}

// 切換分頁＝改網址（路由重渲染後讀新值）；與當前相同時為 no-op
function switchTab(tab) {
  const target = '#/auth?tab=' + tab;
  if (location.hash !== target) location.hash = target;
}

export function renderAuth(main) {
  if (getUser()) { location.hash = '#/'; return; } // 已登入不進此頁
  const activeTab = currentTab();

  const page = el(`
    <div class="auth-wrap">
      <section class="card auth-card">
        <div class="auth-brand">
          <div class="auth-logo">英</div>
          <h2 class="auth-title">學測英文單字</h2>
        </div>
        <div class="segmented auth-seg">
          <label><input type="radio" name="auth-tab" value="login" ${activeTab === 'login' ? 'checked' : ''}><span>登入</span></label>
          <label><input type="radio" name="auth-tab" value="signup" ${activeTab === 'signup' ? 'checked' : ''}><span>註冊</span></label>
        </div>
        <form id="auth-form" autocomplete="on">
          <label class="auth-label">Email
            <input type="email" id="auth-email" class="input-shared" autocomplete="email" spellcheck="false" required>
          </label>
          <label class="auth-label">密碼
            <input type="password" id="auth-pass" class="input-shared" autocomplete="${activeTab === 'login' ? 'current-password' : 'new-password'}" required minlength="8">
          </label>
          ${activeTab === 'signup' && REGISTRATION_MODE === 'key' ? `
          <label class="auth-label">註冊金鑰（向管理員索取）
            <input type="text" id="auth-key" maxlength="40" autocomplete="off"
                   spellcheck="false" placeholder="輸入管理員提供的金鑰" class="input-shared input-key">
          </label>` : ''}
          <p class="warning" id="auth-warning"></p>
          <button type="submit" class="btn primary auth-submit" id="auth-submit">
            ${activeTab === 'login' ? '登入' : '建立帳號'}
          </button>
        </form>
        <div id="auth-extra"></div>
        <p class="muted small auth-foot">
          ${activeTab === 'signup'
            ? '註冊需註冊金鑰（依管理員設定的可用次數）。已有帳號？<a href="javascript:void(0)" class="auth-switch" data-switch="login">直接登入</a>'
            : '還沒有帳號？<a href="javascript:void(0)" class="auth-switch" data-switch="signup">前往註冊</a>'}
        </p>
      </section>
    </div>`);

  // 分頁切換：改網址 → 路由重渲染（3.3.1 修復）
  // 4.2.0 批次 3：.auth-tabs → .segmented（label＋radio），事件來源由 .auth-tab 鈕改為 radio
  const switchTo = (tab) => switchTab(tab);
  page.querySelectorAll('input[name="auth-tab"]').forEach((r) => {
    r.addEventListener('change', () => { if (r.checked) switchTo(r.value); });
  });
  page.querySelectorAll('.auth-switch').forEach((a) => {
    a.addEventListener('click', () => switchTo(a.dataset.switch));
  });

  // 提交
  page.querySelector('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const warn = page.querySelector('#auth-warning');
    const btn = page.querySelector('#auth-submit');
    const email = page.querySelector('#auth-email').value.trim();
    const pass = page.querySelector('#auth-pass').value;
    warn.textContent = '';
    btn.disabled = true;
    try {
      if (activeTab === 'login') {
        await signIn(email, pass);
        location.hash = '#/';
      } else if (REGISTRATION_MODE === 'key') {
        const key = page.querySelector('#auth-key').value.trim();
        await signUpWithKey(email, pass, key);
        location.hash = '#/';
      } else {
        const r = await signUp(email, pass);
        if (r.needsConfirm) { renderOtpPanel(page, email); return; }
        location.hash = '#/';
      }
    } catch (err) {
      // 3.3.1 封存：OTP 相容路徑停用——未驗證舊帳號請管理員軟刪除後重新註冊，
      // 或由管理員升層級後以上方工具處理（renderOtpPanel 代碼保留於本檔）
      if (/尚未驗證/.test(String(err.message || err))) {
        warn.innerHTML = '此 Email 曾註冊但未完成驗證。請聯絡管理員刪除舊帳號後，使用新的註冊金鑰重新註冊。';
        return;
      }
      warn.textContent = String(err.message || err);
    } finally {
      btn.disabled = false;
    }
  });

  main.replaceChildren(page);
}

// OTP 驗證碼面板（僅 REGISTRATION_MODE='otp' 或未驗證舊帳號登入時使用）
function renderOtpPanel(page, email) {
  const extra = page.querySelector('#auth-extra');
  page.querySelector('#auth-form')?.classList.add('hidden');
  extra.replaceChildren(el(`
    <p class="finish">驗證碼已寄到 <strong>${escapeHtml(email)}</strong>，請輸入信件中的 6 位數字。</p>
    <div class="search-row">
      <input type="text" id="auth-otp" inputmode="numeric" maxlength="6"
             autocomplete="one-time-code" placeholder="6 位數字" class="input-shared input-otp">
      <button class="btn primary" id="btn-otp-verify">完成註冊</button>
    </div>
    <div class="controls controls-start">
      <button class="btn subtle" id="btn-otp-resend">重發驗證碼</button>
    </div>
    <p class="warning" id="otp-warning"></p>`));
  const warn = () => extra.querySelector('#otp-warning');
  extra.querySelector('#btn-otp-verify').addEventListener('click', async () => {
    warn().textContent = '';
    try {
      await verifySignupCode(email, extra.querySelector('#auth-otp').value);
      location.hash = '#/';
    } catch (err) {
      warn().textContent = String(err.message || err);
    }
  });
  extra.querySelector('#btn-otp-resend').addEventListener('click', async () => {
    try {
      await resendSignupCode(email);
      warn().textContent = '已重發，請查收（可能在校 spam 信件夾）';
    } catch (err) {
      warn().textContent = String(err.message || err);
    }
  });
  extra.querySelector('#auth-otp').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') extra.querySelector('#btn-otp-verify').click();
  });
  extra.querySelector('#auth-otp').focus();
}
