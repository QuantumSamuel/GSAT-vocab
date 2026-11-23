// ============================================================
// 反饋功能（4.1.0）：右上角反饋按鈕 → 工單面板
// 登入使用者：填寫問題（工單）＋查看自己歷史工單與管理員回復
// 資料表 vocab_feedback（見 tools/supabase_410.sql）；未登入提示先登入
// ============================================================
import { getUser, restFetch } from './services/auth.js';
import { el, escapeHtml } from './core/ui.js';

export function initFeedback() {
  document.getElementById('feedback-fab')?.addEventListener('click', openPanel);
}

initFeedback();

function openPanel() {
  const old = document.getElementById('feedback-panel');
  if (old) { old.remove(); return; }
  const user = getUser();
  document.body.appendChild(el(`
    <div id="feedback-panel" role="dialog" aria-label="反饋">
      <div class="fb-head">
        <strong>意見反饋</strong>
        <button class="btn subtle" id="fb-close" aria-label="關閉"><svg class="icon-sm-14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      </div>
      ${user ? `
        <textarea id="fb-text" rows="4" maxlength="1000"
          placeholder="描述遇到的問題或建議（2～1000 字）" spellcheck="false"></textarea>
        <div class="controls controls-end fb-actions">
          <button class="btn primary" id="fb-send">送出工單</button>
        </div>
        <p class="warning" id="fb-warning"></p>
        <div class="fb-list-title">我的工單</div>
        <div id="fb-list"><p class="muted small">載入中…</p></div>
      ` : `
        <p class="muted note-block">反饋需要登入後使用（方便我們回復你）。</p>
        <div class="controls controls-start">
          <a class="btn primary" href="#/auth?tab=login">前往登入</a>
        </div>
      `}
    </div>`));
  document.getElementById('fb-close').addEventListener('click', () => closePanel());
  if (user) {
    document.getElementById('fb-send').addEventListener('click', sendFeedback);
    loadMine();
  }
}

function closePanel() { document.getElementById('feedback-panel')?.remove(); }

async function sendFeedback() {
  const warn = document.getElementById('fb-warning');
  const btn = document.getElementById('fb-send');
  const text = document.getElementById('fb-text').value.trim();
  warn.textContent = '';
  if (text.length < 2) { warn.textContent = '請先填寫問題內容。'; return; }
  btn.disabled = true;
  try {
    await restFetch('vocab_feedback', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ user_id: getUser().id, content: text }),
    });
    document.getElementById('fb-text').value = '';
    await loadMine();
  } catch (err) {
    warn.textContent = `送出失敗：${escapeHtml(String(err.message || err).slice(0, 140))}`;
  }
  btn.disabled = false;
}

async function loadMine() {
  const box = document.getElementById('fb-list');
  if (!box) return;
  try {
    const rows = await restFetch('vocab_feedback?select=*&order=created_at.desc&limit=20');
    if (!rows.length) { box.replaceChildren(el('<p class="muted small">還沒有工單。填寫上方表單送出後，管理員會在這裡回復你。</p>')); return; }
    box.replaceChildren(el(rows.map((r) => `
      <div class="fb-item">
        <div class="fb-q">${escapeHtml(r.content)}
          <span class="muted small">${String(r.created_at || '').slice(0, 10)}</span></div>
        ${r.reply ? `<div class="fb-a">${escapeHtml(r.reply)}</div>` : '<div class="fb-a muted small">待管理員回復</div>'}
      </div>`).join('')));
  } catch (err) {
    box.replaceChildren(el(`<p class="warning small">載入失敗：${escapeHtml(String(err.message || err).slice(0, 120))}</p>`));
  }
}
