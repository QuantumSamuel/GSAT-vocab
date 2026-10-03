// ============================================================
// 頁面：同步（2.0.10；4.0.0 精簡——只保留 8 碼快照的上傳與下載）
// 上傳雲端：整份資料（複習計劃＋單詞本）以 8 碼代碼存上 Supabase
// 下載雲端：輸入代碼 → 勾選範圍（複習計劃／單詞本）→ 合併或替換 → 還原
// 【4.0.0】帳號雲端備份移至「賬戶」頁（account.js）；需先在
//   supabase_config.txt 填入 Project URL 與 anon key
// ============================================================
import {
  applySnapshot,
  fetchSnapshot,
  getLocalCode,
  loadSupabaseConfig,
  localSummary,
  resetLocalCode,
  uploadSnapshot,
} from '../services/sync.js';
import { el, escapeHtml, openDialog, toast } from '../core/ui.js';

export async function renderSync(main) {
  const config = await loadSupabaseConfig();
  const local = await localSummary();

  if (!config.configured) {
    main.replaceChildren(el(`
      <section class="card">
        <h2>同步</h2>
        <p>尚未設定 Supabase，請完成以下一次性設定：</p>
        <ol>
          <li>到 <strong>supabase.com</strong> 用 Google/GitHub 帳號註冊（免費）</li>
          <li>建立專案（Region 建議 Tokyo 或 Singapore）</li>
          <li>專案頁 <strong>Project Settings（API）</strong>，複製 <strong>Project URL</strong> 與 <strong>anon public key</strong></li>
          <li>填入本資料夾的 <strong>supabase_config.txt</strong>（格式見檔內說明）</li>
          <li>在 Supabase 的 <strong>SQL Editor</strong> 執行本資料夾 <strong>tools/supabase_setup.sql</strong> 的內容</li>
        </ol>
        <p class="muted">完成後重新整理本頁即可使用。</p>
      </section>`));
    return;
  }

  const page = el(`
    <div class="sync-layout">
    <section class="card sy-sum">
      <p class="muted">本機資料：複習計劃 ${local.marks} 字 · 單詞本 ${local.wordbooks} 本</p>
    </section>

    <section class="card sy-up">
      <h2>上傳雲端</h2>
      <p class="muted">把本機的複習計劃與單詞本整份上傳，取得同步代碼；之後再上傳會更新同一組代碼的雲端資料。</p>
      <div class="controls">
        <button class="btn primary" id="btn-upload">上傳到雲端</button>
      </div>
      <div id="upload-result"></div>
    </section>

    <section class="card sy-down">
      <h2>從雲端下載</h2>
      <div class="search-row">
        <input type="text" id="dl-code" placeholder="輸入 8 碼同步代碼" maxlength="8"
               autocomplete="off" spellcheck="false" class="input-mono-upper">
        <button class="btn primary" id="btn-fetch">查詢</button>
      </div>
      <p class="warning" id="dl-warning"></p>
      <div id="dl-panel"></div>
    </section>
    </div>`);

  // ---- 上傳 ----
  page.querySelector('#btn-upload').addEventListener('click', async () => {
    const box = page.querySelector('#upload-result');
    const btn = page.querySelector('#btn-upload');
    btn.disabled = true;
    box.replaceChildren(el('<p class="muted">上傳中…</p>'));
    try {
      const r = await uploadSnapshot();
      box.replaceChildren(el(`
        <div class="save-form">
          <p>上傳成功。你的同步代碼（在另一台裝置輸入即可下載）：</p>
          <p class="sync-code">${r.code}</p>
          <p class="muted">已上傳：複習計劃 ${r.marks} 字、單詞本 ${r.wordbooks} 本。請把代碼記下來或抄到別處。</p>
        </div>`));
    } catch (err) {
      box.replaceChildren(el(`<p class="warning">上傳失敗：${escapeHtml(String(err.message || err))}</p>`));
    }
    btn.disabled = false;
  });

  // ---- 下載：查詢 ----
  let snapshot = null;
  page.querySelector('#dl-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') page.querySelector('#btn-fetch').click();
  });
  page.querySelector('#btn-fetch').addEventListener('click', async () => {
    const warn = page.querySelector('#dl-warning');
    const panel = page.querySelector('#dl-panel');
    warn.textContent = '';
    panel.replaceChildren();
    const code = page.querySelector('#dl-code').value.trim().toUpperCase();
    try {
      snapshot = await fetchSnapshot(code);
    } catch (err) {
      warn.textContent = `${err.message}`;
      return;
    }
    renderDownloadPanel(panel, snapshot);
  });

  function renderDownloadPanel(panel, snap) {
    const bookNames = snap.wordbooks.map((b) => escapeHtml(b.name)).join('、') || '（無）';
    panel.replaceChildren(el(`
      <div class="save-form">
        <p>雲端快照（匯出時間：${escapeHtml((snap.exportedAt || '').replace('T', ' ').slice(0, 19))}）：</p>
        <ul>
          <li>複習計劃：<strong>${snap.marks.length}</strong> 字</li>
          <li>單詞本：<strong>${snap.wordbooks.length}</strong> 本（${bookNames}）</li>
        </ul>
        <p><strong>要還原的部分：</strong></p>
        <div class="level-item"><input type="checkbox" id="chk-marks" checked><span>複習計劃（${snap.marks.length} 字）</span></div>
        <div class="level-item"><input type="checkbox" id="chk-books" checked><span>單詞本（${snap.wordbooks.length} 本）</span></div>
        <p><strong>還原方式：</strong></p>
        <div class="mode-grid">
          <label class="mode-card"><input type="radio" name="dl-mode" value="merge" checked>
            <span class="mode-title">合併</span>
            <span class="mode-desc">保留本機既有，加入雲端多出來的</span></label>
          <label class="mode-card"><input type="radio" name="dl-mode" value="replace">
            <span class="mode-title">替換</span>
            <span class="mode-desc">本機該部分整個換成雲端資料</span></label>
        </div>
        <div class="controls">
          <button class="btn primary" id="btn-apply">執行還原</button>
        </div>
        <div id="apply-result"></div>
      </div>`));

    panel.querySelector('#btn-apply').addEventListener('click', async () => {
      const useMarks = panel.querySelector('#chk-marks').checked;
      const useBooks = panel.querySelector('#chk-books').checked;
      if (!useMarks && !useBooks) {
        toast('請至少勾選一個要還原的部分', 'bad');
        return;
      }
      const mode = panel.querySelector('input[name="dl-mode"]:checked').value;
      const scope = { marks: useMarks, wordbooks: useBooks };
      const modeText = mode === 'replace' ? '替換（本機該部分會被覆蓋）' : '合併（保留本機、加入雲端）';
      const rangeText = `${useMarks ? '複習計劃' : ''}${useMarks && useBooks ? '、' : ''}${useBooks ? '單詞本' : ''}`;
      // 4.2.0：confirm → openDialog（「替換」覆蓋本機資料＝danger；「合併」為一般動作）
      const ok = await openDialog({
        title: '執行還原',
        body: `確定以「${modeText}」方式還原？範圍：${rangeText}。`,
        danger: mode === 'replace',
        okText: mode === 'replace' ? '替換' : '合併',
        cancelText: '取消',
      });
      if (!ok) return;
      const resultBox = panel.querySelector('#apply-result');
      resultBox.replaceChildren(el('<p class="muted">還原中…</p>'));
      try {
        const r = await applySnapshot(snapshot, scope, mode);
        const parts = [];
        if (scope.marks) {
          parts.push(mode === 'replace' ? `複習計劃已替換為 ${r.marks} 字` : `複習計劃新增 ${r.marks} 字（本機既有保留）`);
        }
        if (scope.wordbooks) {
          parts.push(mode === 'replace' ? `單詞本已替換為 ${r.wordbooks} 本` : `單詞本新增 ${r.wordbooks} 本（名稱相同者保留本機）`);
        }
        resultBox.replaceChildren(el(`<p class="finish">${parts.join('；')}</p>`));
      } catch (err) {
        resultBox.replaceChildren(el(`<p class="warning">還原失敗：${escapeHtml(String(err.message || err))}</p>`));
      }
    });
  }

  main.replaceChildren(page);
}
