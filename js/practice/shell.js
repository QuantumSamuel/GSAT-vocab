// ============================================================
// 練習共用 Question Shell（4.1.1：Unified Question Shell）
// 題型／進度 → 題目內容 → 答案區 → 提示／回饋 → 上一題／下一題
// 各題型只替換 Content Area；completion 亦由本模組提供
// ============================================================
import { el, escapeHtml, ICONS } from '../core/ui.js';

/**
 * 建立並掛載 Question Shell。
 * opts: { typeLabel, cur, total, main, onPrev, onNext, canPrev, canNext }
 * 回傳 { content, feedback, setProgress(cur,total), setFeedback(text,kind), shell }
 */
export function mountShell(main, opts) {
  main.replaceChildren(el(`
    <section class="card">
      <div class="q-shell">
        <div class="q-shell-head">
          <span class="q-type">${escapeHtml(opts.typeLabel)}</span>
          <div class="q-progress-bar"><span id="qs-bar" style="width:0%"></span></div>
          <span class="q-progress-num" id="qs-num"></span>
        </div>
        <div class="q-content" id="qs-content"></div>
        <div class="q-feedback" id="qs-feedback"></div>
        <div class="q-nav">
          <button class="btn q-nav-btn" id="qs-prev" ${opts.canPrev ? '' : 'disabled'}>${ICONS.chevronLeft} 上一題</button>
          <button class="btn primary q-nav-btn" id="qs-next" ${opts.canNext ? '' : 'disabled'}>下一題 ${ICONS.chevronRight}</button>
          <button class="btn btn-quit" id="qs-quit" ${opts.onQuit ? '' : 'hidden'}>提前結束</button>
        </div>
      </div>
    </section>`));
  const $ = (id) => main.querySelector('#' + id);
  const setProgress = (cur, total) => {
    $('qs-bar').style.width = `${total ? Math.round((cur / total) * 100) : 0}%`;
    $('qs-num').textContent = `${cur} / ${total}`;
  };
  setProgress(opts.cur, opts.total);
  if (opts.onPrev) $('qs-prev').addEventListener('click', opts.onPrev);
  if (opts.onNext) $('qs-next').addEventListener('click', opts.onNext);
  // 4.3.1：提前結束（所有引擎通用——onQuit 由呼叫端提供，確認對話框也在呼叫端）
  if (opts.onQuit) $('qs-quit').addEventListener('click', opts.onQuit);
  return {
    content: $('qs-content'),
    feedback: $('qs-feedback'),
    prevBtn: $('qs-prev'),
    nextBtn: $('qs-next'),
    setProgress,
    setFeedback(text, kind = '') {
      this.feedback.textContent = text || '';
      this.feedback.className = 'q-feedback' + (kind ? ' ' + kind : '');
    },
  };
}

/**
 * 完成畫面：分數／統計／再練一次／返回。
 * opts: { title, scoreText, stats: [{num,label}], onAgain, onBack }
 */
export function mountCompletion(main, opts) {
  main.replaceChildren(el(`
    <section class="card">
      <div class="completion">
        <h2>${escapeHtml(opts.title || '練習完成')}</h2>
        <div class="c-score">${escapeHtml(opts.scoreText)}</div>
        <div class="c-stats">
          ${(opts.stats || []).map((s) => `
            <div class="srs-box"><div class="num">${escapeHtml(String(s.num))}</div><div class="label">${escapeHtml(s.label)}</div></div>`).join('')}
        </div>
        <div class="c-actions">
          <button class="btn primary" id="c-again">再練一次</button>
          <button class="btn" id="c-back">返回</button>
        </div>
      </div>
    </section>`));
  main.querySelector('#c-again')?.addEventListener('click', opts.onAgain);
  main.querySelector('#c-back')?.addEventListener('click', opts.onBack);
}

/**
 * 工具：洗牌（Fisher-Yates；回新陣列）
 */
export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 工具：從陣列抽 n 個不同元素（不含 exclude 集合）
 */
export function sampleExcluding(arr, n, exclude, pick = (x) => x) {
  const pool = shuffle(arr.filter((x) => !exclude.has(pick(x))));
  return pool.slice(0, n);
}
