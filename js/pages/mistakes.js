// ============================================================
// 頁面：錯題本（5.0.x；spec 4.0/5.7-50x-features-spec.md 第 3 節）
//
// 範圍：模擬考的 real／ai 卷＋選擇練習中 real／ai 來源的題（配對／拼寫不進——
//   單字類錯誤走 SRS；考古題也不進，spec 只列 real／ai）。
// 分頁：來源（真題／AI）× 區段。
// 每頁有「錯題當卷重考」：由 mistake-bank.js 重建原題、組卷上限 20 題，交給
//   exam.js 的同一套作答引擎（startMistakeRetryWith）。
// 紅線：題幹／出處／區段名全部 escapeHtml（題目文字是外部資料）。
// 雲端：錯題本只存本機（spec 暫緩雲同步），頁面上有說明。
// ============================================================
import { clearMistakes, getMistakes } from '../services/store.js';
import { el, escapeHtml, emptyState, iconInline, ICONS, openDialog, toast } from '../core/ui.js';
import { MISTAKE_RETRY_LIMIT, buildMistakeRetryRun, mistakePages } from '../practice/mistake-bank.js';

// 目前選中的分頁（切頁再回來保留；null＝第一頁）
let curKey = null;

const SRC_LABEL = { real: '歷屆真題', ai: 'AI 題庫' };
/** 題幹前 40 字（spec 第 3 節：題幹前 40 字＋出處＋錯誤次數） */
const stemBrief = (s) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > 40 ? `${t.slice(0, 40)}…` : t;
};

export async function renderMistakes(main) {
  const rows = await getMistakes();
  const pages = mistakePages(rows);

  const head = `
    <section class="card">
      <h2>錯題本</h2>
      <p class="muted small">記錄歷屆真題與 AI 題庫中答錯的題目（選擇練習中來自真題／AI 的題也會進來）。
        配對與拼寫的錯誤走「不會單字」複習計畫，不列在這裡。資料只存在這台裝置（雲端同步尚未開放）。</p>
      <p class="warning" id="mk-warn"></p>
    </section>`;

  if (!rows.length) {
    // 空狀態走 emptyState（spec 第 3 節）
    main.replaceChildren(el(`${head}<section class="card">${emptyState({
      icon: 'book',
      title: '還沒有錯題',
      desc: '歷屆真題模擬考與選擇練習（真題／AI 來源）答錯的題會自動收進這裡，也可以整份重考。',
      actionHtml: '<a class="btn" href="#/practice">回到練習</a>',
    })}</section>`));
    return;
  }

  const keys = pages.map((p) => p.key);
  if (!curKey || !keys.includes(curKey)) curKey = keys[0];
  const page = pages.find((p) => p.key === curKey);

  const tabs = pages.map((p) => `
    <label class="level-item">
      <input type="radio" name="mk-page" value="${escapeHtml(p.key)}"${p.key === curKey ? ' checked' : ''}>
      <span>${escapeHtml(SRC_LABEL[p.sourceType] || p.sourceType)}・${escapeHtml(p.section)}（${p.items.length}）</span>
    </label>`).join('');

  const items = page.items.map((r) => `
    <div class="mistake-item">
      <div class="mistake-stem">${escapeHtml(stemBrief(r.stem))}
        <div class="mistake-meta">${escapeHtml(r.paperKey || '未標出處')}・第 ${escapeHtml(String(r.qnum ?? '?'))} 題・${escapeHtml(r.section || '未標區段')}</div>
      </div>
      <span class="mistake-count">錯 ${escapeHtml(String(r.gotWrongCount || 1))} 次</span>
    </div>`).join('');

  main.replaceChildren(el(`
    ${head}
    <section class="card">
      <h3 class="tp-card-title">依來源與區段</h3>
      <div class="level-grid" id="mk-tabs">${tabs}</div>
      <div class="controls controls-start">
        <button class="btn primary" id="mk-retry">錯題當卷重考（最多 ${MISTAKE_RETRY_LIMIT} 題）</button>
        <button class="btn subtle" id="mk-clear">清空錯題本</button>
      </div>
      <p class="muted small note-tight">${iconInline(ICONS.warnTriangle, 13)}<span>重考用的是題庫裡的原題；題庫改版後若某題已不存在，重考時會自動略過（並在重考卷裡顯示題數）。</span></p>
      <div id="mk-list">${items}</div>
    </section>`));

  const warn = main.querySelector('#mk-warn');

  main.querySelectorAll('input[name="mk-page"]').forEach((r) =>
    r.addEventListener('change', () => { curKey = r.value; renderMistakes(main); }));

  // ---------- 錯題當卷重考 ----------
  main.querySelector('#mk-retry').addEventListener('click', async () => {
    const btn = main.querySelector('#mk-retry');
    btn.disabled = true;
    warn.textContent = '正在從題庫重建原題…';
    let built;
    try {
      built = await buildMistakeRetryRun(page);
    } catch (err) {
      warn.textContent = `重建題目失敗：${String(err.message || err).slice(0, 90)}`;
      btn.disabled = false;
      return;
    }
    warn.textContent = '';
    btn.disabled = false;
    if (!built.run) {
      warn.textContent = '這頁的錯題在目前題庫裡都找不到原題（可能題庫已改版），無法重考。';
      return;
    }
    // 誠實說明取用與略過數量（spec：上限 20 題）
    const notes = [`將重考 ${built.used} 題`];
    if (built.total > MISTAKE_RETRY_LIMIT) notes.push(`本頁共 ${built.total} 題，取錯得最多的前 ${MISTAKE_RETRY_LIMIT} 題`);
    if (built.skipped) notes.push(`${built.skipped} 題在題庫找不到原題，已略過`);
    const note = notes.join('；') + '。';
    warn.textContent = note;
    // 交給模擬考引擎（同一引擎、同一作答流程）。說明文字也一起帶過去：
    //   進作答頁後錯題本那一行已被換掉，說明留在原頁等於使用者看不到。
    built.run.meta = { ...(built.run.meta || {}), note };
    const examMod = await import('./exam.js');
    const target = document.getElementById('app');
    examMod.startMistakeRetryWith(built.run, target);
    toast(note, '');
  });

  // ---------- 清空 ----------
  main.querySelector('#mk-clear').addEventListener('click', async () => {
    const ok = await openDialog({
      title: '清空錯題本',
      body: `確定清空全部 ${rows.length} 筆錯題紀錄？此操作不可復原（單字類的錯誤不受影響）。`,
      danger: true,
      okText: '清空',
      cancelText: '取消',
    });
    if (!ok) return;
    await clearMistakes();
    curKey = null;
    toast('已清空錯題本', 'ok');
    renderMistakes(main);
  });
}
