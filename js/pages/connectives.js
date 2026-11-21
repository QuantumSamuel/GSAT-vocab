// ============================================================
// 頁面：連接詞搭配練習（6.3.4，2026-11-21）
//
// 題源：官方歷屆題（data/connectives.json，由 build-connectives-20261121.mjs 產生）
//       —— 只收「正解是連接詞」的題目，選項與解析沿用官方，不改寫、不生成。
//
// 一輪 10 題；選答後立即對答案並顯示官方解析；結束顯示分數，可再練一次。
// 不做 SRS 排程、不寫入錯題本（避免與既有練習流程互相影響）；本輪成績只存在畫面上。
// ============================================================
import { el, escapeHtml } from '../core/ui.js';
import { capturePage } from '../services/owner-guard.js';

const ROUND_SIZE = 10;
let cache = null;
// 2026-11-21：auth／設定在渲染後落定會讓 router 重畫本頁；把一輪的進度存在模組層，
// 重畫時還原，否則使用者剛答的題會被洗掉（線上實測）。
let progress = null; // { round, idx, score, chosen }
// 2026-11-21：Service Worker 首次接管會觸發整頁重新載入；模組層變數會被清掉，
// 所以同時寫進 sessionStorage，重載後可接續同一輪（換分頁或關站就重來，符合「練習」性質）。
const PROGRESS_KEY = 'gsat-connectives-progress-v1';
function loadProgress(){ try { const raw = sessionStorage.getItem(PROGRESS_KEY); if(!raw) return null; const p = JSON.parse(raw); if(!p || !Array.isArray(p.round) || !p.round.length) return null; return p; } catch { return null; } }
function saveProgress(){ try { if (progress) sessionStorage.setItem(PROGRESS_KEY, JSON.stringify(progress)); else sessionStorage.removeItem(PROGRESS_KEY); } catch { /* 私密模式等情境忽略 */ } }
progress = loadProgress();

async function loadBank() {
  if (cache) return cache;
  const res = await fetch('data/connectives.json', { cache: 'no-cache' });
  if (!res.ok) {
    const err = new Error(`連接詞題庫載入失敗（HTTP ${res.status}）`);
    err.code = 'DATA_HTTP';
    throw err;
  }
  let data;
  try {
    data = await res.json();
  } catch {
    const err = new Error('連接詞題庫格式錯誤（不是合法 JSON）');
    err.code = 'DATA_BAD_JSON';
    throw err;
  }
  if (!data || !Array.isArray(data.items) || !data.items.length) {
    const err = new Error('連接詞題庫是空的');
    err.code = 'DATA_EMPTY';
    throw err;
  }
  cache = data;
  return data;
}

function pickRound(items, size = ROUND_SIZE) {
  const pool = [...items];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(size, pool.length));
}

export async function renderConnectives(main) {
  const guard = capturePage();
  const stillOn = () => guard.active() && shell.isConnected;
  const shell = el('<section class="card"><h2>連接詞搭配練習</h2><div id="conn-body"><p class="muted">正在載入題庫…</p></div></section>');
  main.replaceChildren(shell);
  const body = shell.querySelector('#conn-body');
  // 2026-11-21：改用事件委派——原本把 click 綁在每次 paint 產生的節點上，
  // 若 auth／設定在渲染後落定造成重繪，舊節點被換掉，使用者按下去就沒反應（線上實測）。
  let onOption = null;
  let onNext = null;
  body.addEventListener('click', (e) => {
    const opt = e.target.closest('.conn-opt');
    if (opt && onOption) { onOption(opt); return; }
    const next = e.target.closest('#conn-next');
    if (next && onNext) onNext();
  });

  let bank;
  try {
    bank = await loadBank();
  } catch (err) {
    if (!stillOn()) return;
    body.replaceChildren(el(`<div class="warning">${escapeHtml(err.message)}</div>
      <p class="muted small">題庫檔案位於 data/connectives.json；可執行 <code>node 6.0/authoring/build-connectives-20261121.mjs</code> 重新產生。</p>`));
    return;
  }
  if (!stillOn()) return;

  const renderFeedback = (q) => {
    const fb = body.querySelector('#conn-feedback');
    if (!fb) return;
    const chosenIdx = progress.chosen[progress.idx];
    const correct = chosenIdx === q.answerIdx;
    fb.innerHTML = `<p><strong>${correct ? '答對' : '答錯'}</strong>｜正解：${escapeHtml(q.answer)}</p>
      ${q.explanation ? `<p>官方解析：${escapeHtml(q.explanation)}</p>` : ''}
      <button class="btn primary" id="conn-next">${progress.idx + 1 === progress.round.length ? '看結果' : '下一題'}</button>`;
    onNext = () => { progress.idx += 1; saveProgress(); paint(); };
  };

  const paint = () => {
    if (!stillOn()) return;
    const { round, idx } = progress;
    if (idx >= round.length) {
      body.replaceChildren(el(`<div class="finish">
        <p><strong>本輪結束：${progress.score} / ${round.length}</strong>（答對率 ${Math.round((progress.score / round.length) * 100)}%）</p>
        <div class="controls">
          <button class="btn primary" id="conn-again">再練一次</button>
          <a class="btn" href="#/practice">回練習</a>
        </div>
        <details class="muted small"><summary>看本輪作答</summary><ol>${round.map((q, i) => {
          const c = progress.chosen[i];
          const ok = c === q.answerIdx;
          return `<li>${ok ? '✅' : '❌'} ${escapeHtml(q.sentence || q.id)}｜你選 ${escapeHtml(q.options[c] || '（未答）')}｜正解 ${escapeHtml(q.answer)}</li>`;
        }).join('')}</ol></details>
      </div>`));
      body.querySelector('#conn-again').addEventListener('click', () => { progress = null; saveProgress(); startRound(); });
      onOption = null;
      onNext = null;
      return;
    }

    const q = round[idx];
    const opts = q.options.map((text, i) => `<button class="btn conn-opt" data-i="${i}">${String.fromCharCode(65 + i)}. ${escapeHtml(text)}</button>`).join('');
    body.replaceChildren(el(`<div class="conn-q">
      <p class="muted small">第 ${idx + 1} / ${round.length} 題｜${escapeHtml(q.exam || '')}${q.year ? ' ' + q.year : ''}｜官方題（${escapeHtml(q.id)}）</p>
      <p class="conn-sentence">${escapeHtml(q.sentence || '（此題沒有可顯示的句子，仍可作答）')}</p>
      <div class="conn-opts">${opts}</div>
      <div id="conn-feedback" class="muted small"></div>
    </div>`));

    // 重繪後若這一題已作答，還原「已答」的樣子（不讓重畫把進度洗掉）
    const chosenIdx = progress.chosen[idx];
    if (chosenIdx !== undefined) {
      body.querySelectorAll('.conn-opt').forEach((b, i) => {
        b.disabled = true;
        if (i === q.answerIdx) b.classList.add('primary');
        else if (i === chosenIdx) b.classList.add('marked');
      });
      renderFeedback(q);
    }

    onOption = (btn) => {
      // 使用者點擊只改本頁 DOM，不需要 render 世代守衛；
      // 用 guard.active() 會讓「auth 落定後重繪」把舊畫面的點擊全部吃掉（線上實測）。
      if (!body.isConnected) return;
      if (progress.chosen[progress.idx] !== undefined) return;
      const picked = Number(btn.dataset.i);
      progress.chosen[progress.idx] = picked;
      saveProgress();
      if (picked === q.answerIdx) progress.score += 1;
      body.querySelectorAll('.conn-opt').forEach((b, i) => {
        b.disabled = true;
        if (i === q.answerIdx) b.classList.add('primary');
        else if (i === picked) b.classList.add('marked');
      });
      renderFeedback(q);
    };
  };

  const startRound = () => {
    if (!progress) { progress = { round: pickRound(bank.items), idx: 0, score: 0, chosen: [] }; saveProgress(); }
    paint();
  };

  startRound();
}
