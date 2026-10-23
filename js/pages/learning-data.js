// ============================================================
// 頁面：學習資料（本人）——6.0.3 新增（已核准）
// 只服務「本人」的學習資料同步：狀態／立即同步／匯出 JSON／選檔預覽後合併還原。
//
// 【範圍與界線】
//  ・本頁只新增本檔；不改 router／app／store／backend／其他產品檔。
//    路由註冊與選單入口由另一批接手（本檔先備好 renderLearningData／onLeave）。
//  ・服務由另一批接上，固定 import '../services/learning-sync.js'——本檔不得
//    自行建立服務檔、也不 mock 產品服務。介面：
//      getLearningSyncStatus() -> {ownerId,state,pending,lastSyncedAt,error?}
//      syncLearningNow({signal}={}) -> 狀態
//      exportLearningBackup() -> JSON envelope
//      previewLearningBackup(input) -> {ownerId,dayPlanCount,eventCount,hasDiagnostic}
//      restoreLearningBackup(input) -> 合併後狀態
//  ・舊的 marks／wordbooks 同步（8 碼快照、賬戶雲端備份）完全不動；本頁只管
//    6.0 個人化學習資料（dayPlan／事件／診斷）。文案明示與 8 碼分享分開。
//
// 【生命週期與競態（沿用 daily-tasks.js 既有風格）】
//  ・onLeave 遞增 epoch、abort 在途請求、解除訂閱。
//  ・authReady 後才取 owner 與 auth generation；所有 await／file 讀取／Blob 下載／
//    服務寫入回來都檢查原 owner／generation／路由 epoch——A→B→A 或離頁不得
//    錯帳下載／還原、不得晚到覆蓋畫面。
//  ・auth:changed → 停手並顯示「重新開啟」真按鈕（同一 hash 可重載）。
//  ・監聽 learning-sync:changed 僅在同 owner 且仍存活時更新，不做頻繁 poll。
// ============================================================
import { el, openDialog, toast, escapeHtml } from '../core/ui.js';
import { on } from '../core/eventbus.js';
import { routeGuard } from '../core/router.js';
import { getUser, getAuthGeneration, authReady } from '../services/auth.js';
import {
  getLearningSyncStatus,
  syncLearningNow,
  exportLearningBackup,
  previewLearningBackup,
  restoreLearningBackup,
} from '../services/learning-sync.js';

// ---------- 模組狀態 ----------
let controller = null;
let unsubAuth = null;
let unsubSync = null;
let epoch = 0;
// 選檔世代：每次「選檔／離頁／換帳戶」都遞增；readFile／preview／合併對話框／
// merge 每個 await 回來都要比對，晚到的舊檔不得覆蓋新選檔或再 restore。
let selGen = 0;

export function onLeave() {
  epoch++;
  selGen++;
  controller?.abort();
  controller = null;
  unsubAuth?.();
  unsubAuth = null;
  unsubSync?.();
  unsubSync = null;
}

// ---------- 狀態文字（不顯示 raw token／error 長堆疊） ----------
const STATE_LABEL = {
  idle: '已就緒',
  syncing: '同步中…',
  offline: '離線（連線後可再同步）',
  error: '同步失敗',
  not_configured: '尚未設定雲端同步',
};

// 「立即同步」結果訊息：只有真 idle＋pending=false 才是「同步完成」。
// 其餘狀態（offline／error／not_configured／pending 未清）不得冒稱同步完成。
function syncResultMessage(status) {
  if (!status) return '同步未完成（可再試一次）。';
  const state = status.state;
  const pending = !!status.pending;
  if (state === 'idle' && !pending) return '同步完成。';
  if (state === 'idle' && pending) return '本機已合併待同步（雲端尚未完成，可再試一次）。';
  if (state === 'offline') return pending
    ? '離線：本機已合併待同步（連線後可再同步）。'
    : '離線：未同步（連線後可再同步）。';
  if (state === 'not_configured') return '尚未設定雲端同步（可再試一次）。';
  if (state === 'error') return `同步失敗：${safeMessage(status.error) || '未知錯誤'}（可再試一次）`;
  if (state === 'syncing') return '同步仍在進行（請稍候再試）。';
  return pending ? '本機已合併待同步（可再試一次）。' : '同步未完成（可再試一次）。';
}

// 「合併還原」結果訊息：本機合併成功但雲端待補傳，顯示「本機已合併待同步」，
// 不得把雲端失敗／pending 未清冒稱「全同步」。
function mergeResultMessage(status) {
  if (!status) return '已合併到本機（尚未確認雲端同步）。';
  const state = status.state;
  const pending = !!status.pending;
  if (state === 'idle' && !pending) return '已合併完成（本機與雲端一致）。';
  if (state === 'not_configured') return '已合併到本機（尚未設定雲端同步）。';
  if (state === 'offline') return '本機已合併待同步（離線，連線後可再同步）。';
  if (state === 'error') return `本機已合併待同步（雲端同步失敗：${safeMessage(status.error) || '未知錯誤'}，可再試一次）。`;
  if (state === 'syncing') return '本機已合併待同步（雲端同步進行中）。';
  return pending ? '本機已合併待同步（可再試一次）。' : '已合併到本機。';
}

// 安全訊息：截斷、去除換行（避免長堆疊或意外內容外洩到畫面）
function safeMessage(err) {
  const raw = String(err?.message || err || '未知錯誤');
  return raw.replace(/\s+/g, ' ').trim().slice(0, 160);
}

function fmtTime(value) {
  if (!value) return '尚無';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '尚無';
  try {
    // 依裝置 locale 與時區顯示（不截 ISO 字串假裝本地時間）
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(d);
  } catch {
    return d.toISOString();
  }
}

export async function renderLearningData(main) {
  onLeave();
  const generation = epoch;
  controller = new AbortController();
  const stillOn = routeGuard();
  let owner = null;
  let authGeneration = getAuthGeneration();
  const alive = () =>
    generation === epoch && getAuthGeneration() === authGeneration && stillOn();

  // auth:changed：停止手上工作，換成「重新開啟」真按鈕（samehash 可重載）
  unsubAuth = on('auth:changed', () => {
    const wasCurrent = stillOn();
    onLeave();
    if (wasCurrent) {
      main.replaceChildren(el(`
        <section class="card">
          <h2>學習資料（本人）</h2>
          <p>帳戶已變更，請重新開啟此頁。</p>
          <div class="controls controls-start">
            <button type="button" class="btn primary" id="ld-reopen">重新開啟</button>
          </div>
        </section>`));
      main.querySelector('#ld-reopen').onclick = () => renderLearningData(main);
    }
  });

  // 先畫骨架：載入不必等網路成功才有畫面
  main.replaceChildren(el(`
    <section class="card">
      <h2>學習資料（本人）</h2>
      <p class="muted" role="status">正在確認登入狀態…</p>
    </section>`));

  // authReady 後取得 owner／generation（冷載時 session 尚未還原完）
  await authReady;
  if (!alive()) return;
  const user = getUser();
  authGeneration = getAuthGeneration();
  owner = user?.id ?? null;

  // 未登入：真連結登入（不建立假服務）
  if (!owner) {
    main.replaceChildren(el(`
      <section class="card">
        <h2>學習資料（本人）</h2>
        <p role="status">登入後即可查看你的學習資料同步狀態，並備份／還原到你的帳戶。</p>
        <div class="controls controls-start">
          <a class="btn primary" href="#/auth?tab=login">登入</a>
          <a class="btn" href="#/auth?tab=signup">註冊</a>
        </div>
        <p class="muted small">此頁只處理你自己的學習資料；與「同步」頁的 8 碼代碼分享分開。</p>
      </section>`));
    return;
  }

  paintShell(main);
  wire(main);

  // 狀態讀取（網路失敗不擋畫面，只更新狀態文字）
  refreshStatus();

  async function refreshStatus() {
    const statusEl = main.querySelector('#ld-status-text');
    if (!statusEl) return;
    try {
      const status = await getLearningSyncStatus();
      if (!alive()) return;
      if (!status || status.ownerId !== owner) return;
      renderStatus(status);
    } catch (err) {
      if (!alive()) return;
      statusEl.textContent = `暫時無法取得同步狀態：${safeMessage(err)}`;
    }
  }

  function renderStatus(status) {
    const statusEl = main.querySelector('#ld-status-text');
    const metaEl = main.querySelector('#ld-status-meta');
    if (!statusEl) return;
    const label = STATE_LABEL[status.state] || '狀態未知';
    statusEl.textContent = status.pending ? `${label}（有未同步變更）` : label;
    if (metaEl) {
      const parts = [`上次同步：${fmtTime(status.lastSyncedAt)}`];
      if (status.state === 'error' && status.error) {
        parts.push(`原因：${safeMessage(status.error)}`);
      }
      metaEl.textContent = parts.join(' · ');
    }
  }

  // learning-sync:changed：僅同 owner 且仍存活才更新，不做頻繁 poll
  subscribeSyncChanged();

  function subscribeSyncChanged() {
    unsubSync = on('learning-sync:changed', (payload) => {
      if (!alive()) return;
      if (!payload || payload.ownerId !== owner) return;
      renderStatus(payload);
    });
  }

  // ---------- 畫面骨架（現有 card／btn，深淺主題通用的語意色） ----------
  function paintShell(root) {
    root.replaceChildren(el(`
      <section class="card ld-sync">
        <h2>學習資料（本人）</h2>
        <p class="notice-bar">此頁只處理你自己帳戶的個人化學習資料（每日計畫、學習紀錄、診斷結果）。與「同步」頁的 8 碼代碼分享分開，互不干擾。</p>

        <div class="ld-group">
        <h3>同步狀態</h3>
        <p id="ld-status-text" role="status" aria-live="polite">讀取中…</p>
        <p id="ld-status-meta" class="muted small"></p>

        <div class="controls controls-start">
          <button class="btn primary" id="ld-sync-now">立即同步</button>
        </div>
        <p class="warning" id="ld-sync-msg"></p>
        </div>

        <div class="ld-group">
        <h3>匯出備份</h3>
        <p class="muted small">把你的學習資料匯出成一個 JSON 檔，保存在自己的裝置。</p>
        <div class="controls controls-start">
          <button class="btn" id="ld-export">匯出 JSON 檔</button>
        </div>
        <p class="warning" id="ld-export-msg"></p>
        </div>

        <div class="ld-group">
        <h3>從備份檔還原</h3>
        <p class="muted small">選擇先前匯出的 JSON 檔，先預覽內容數量，確認後才合併。<strong>只會合併同一個帳戶</strong>的資料；<strong>不會重設診斷結果</strong>，本機既有資料保留。</p>
        <div class="controls controls-start">
          <label class="btn" for="ld-file">選擇備份檔</label>
          <input type="file" id="ld-file" accept="application/json,.json" hidden>
        </div>
        <div id="ld-preview"></div>
        </div>
      </section>`));
  }

  // ---------- 事件接線（按鈕在保存中防重點、可恢復 retry） ----------
  function wire(root) {
    // 匯出 JSON 檔
    root.querySelector('#ld-export').addEventListener('click', async () => {
      const btn = root.querySelector('#ld-export');
      const msg = root.querySelector('#ld-export-msg');
      if (btn.disabled) return;
      btn.disabled = true;
      msg.textContent = '匯出中…';
      try {
        const envelope = await exportLearningBackup();
        if (!alive()) return; // 離頁／換帳戶：不得錯帳下載
        downloadJson(envelope, owner);
        msg.textContent = '已開始下載備份檔。';
      } catch (err) {
        if (!alive()) return;
        msg.textContent = `匯出失敗：${safeMessage(err)}（可再試一次）`;
      } finally {
        if (alive()) btn.disabled = false;
      }
    });

    // 立即同步
    root.querySelector('#ld-sync-now').addEventListener('click', async () => {
      const btn = root.querySelector('#ld-sync-now');
      const msg = root.querySelector('#ld-sync-msg');
      if (btn.disabled) return;
      btn.disabled = true;
      msg.textContent = '同步中…';
      try {
        const status = await syncLearningNow({ signal: controller.signal });
        if (!alive()) return; // 晚到回應不得覆蓋新畫面
        if (status && status.ownerId && status.ownerId !== owner) return;
        if (status) renderStatus(status);
        msg.textContent = syncResultMessage(status);
      } catch (err) {
        if (!alive()) return;
        msg.textContent = `同步失敗：${safeMessage(err)}（可再試一次）`;
      } finally {
        if (alive()) btn.disabled = false;
      }
    });

    // 選檔 → 顯示預覽數量 → 預覽成功才顯示「合併還原」按鈕
    root.querySelector('#ld-file').addEventListener('change', async (e) => {
      const input = e.target.files?.[0];
      const preview = root.querySelector('#ld-preview');
      if (!input) return;
      // 每次選檔取得一個新世代；晚到的舊選檔（讀檔／preview／restore）都不得套用。
      const selToken = ++selGen;
      const stillSel = () => selToken === selGen && alive();
      preview.replaceChildren(el('<p class="muted">讀取檔案…</p>'));
      try {
        const text = await readFileText(input);
        if (!stillSel()) return; // 讀檔期間已換選檔／離頁／換帳戶
        const result = await previewLearningBackup(text);
        if (!stillSel()) return; // 舊選檔 preview 晚到：不得覆蓋新選檔畫面
        if (!result || result.ownerId !== owner) {
          preview.replaceChildren(el('<p class="warning">此備份檔屬於其他帳戶，不能合併還原。</p>'));
          return;
        }
        renderPreview(preview, text, result, selToken, stillSel);
      } catch (err) {
        if (!stillSel()) return;
        preview.replaceChildren(el(`<p class="warning">讀取或預覽失敗：${escapeHtml(safeMessage(err))}，未寫入任何資料。</p>`));
      } finally {
        // 允許重新選同一個檔案（change 不再觸發的經典問題）
        if (e.target) e.target.value = '';
      }
    });
  }

  function renderPreview(preview, text, result, selToken, stillSel) {
    preview.replaceChildren(el(`
      <div class="save-form">
        <p>此備份檔內容：</p>
        <ul>
          <li>每日計畫：<strong>${Number(result.dayPlanCount) || 0}</strong> 筆</li>
          <li>學習紀錄：<strong>${Number(result.eventCount) || 0}</strong> 筆</li>
          <li>診斷結果：<strong>${result.hasDiagnostic ? '有（合併後保留本機診斷，不重設）' : '無'}</strong></li>
        </ul>
        <div class="controls controls-start">
          <button class="btn primary" id="ld-merge">合併還原</button>
        </div>
        <p class="warning" id="ld-merge-msg"></p>
      </div>`));
    preview.querySelector('#ld-merge').addEventListener('click', async () => {
      const btn = preview.querySelector('#ld-merge');
      const msg = preview.querySelector('#ld-merge-msg');
      if (btn.disabled) return;
      // 這個按鈕只屬於本次選檔；換選檔後它已 detach，舊參考不得再觸發 restore。
      if (selToken !== selGen) return;
      const ok = await openDialog({
        title: '合併還原學習資料',
        body: '將把此備份檔的每日計畫與學習紀錄合併到你自己的帳戶；本機既有資料保留，診斷結果不會被重設。',
        okText: '合併',
        cancelText: '取消',
      });
      if (!ok) return;
      if (selToken !== selGen) return; // 對話框期間已換選檔：不得再 restore 舊檔
      if (!stillSel()) return; // 對話框期間可能已離頁／換帳戶
      btn.disabled = true;
      msg.textContent = '合併中…';
      try {
        const status = await restoreLearningBackup(text);
        if (selToken !== selGen) return; // 舊選檔 restore 晚到：不得覆蓋新選檔畫面
        if (!alive()) return; // 服務寫入回來晚於換帳戶／離頁：不得覆蓋
        if (status && status.ownerId && status.ownerId !== owner) return;
        if (status) renderStatus(status);
        msg.textContent = mergeResultMessage(status);
        toast('學習資料已合併', 'ok');
      } catch (err) {
        if (!stillSel()) return;
        msg.textContent = `合併失敗：${safeMessage(err)}，未寫入（可再試一次）。`;
      } finally {
        if (stillSel()) btn.disabled = false;
      }
    });
  }

  // ---------- 工具 ----------
  function readFileText(file) {
    if (typeof file.text === 'function') return file.text();
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result ?? ''));
      fr.onerror = () => reject(fr.error || new Error('讀取檔案失敗'));
      fr.readAsText(file);
    });
  }

  // JSON envelope → Blob 下載（檔名不含 token；帶 owner 短碼與日期）
  function downloadJson(envelope, forOwner) {
    const json = JSON.stringify(envelope, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = URL.createObjectURL(blob);
    a.download = `learning-data-${String(forOwner || '').slice(0, 8)}-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 0);
  }
}
