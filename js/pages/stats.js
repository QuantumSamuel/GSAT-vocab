// ============================================================
// 頁面：學習統計（2.0.13；2.0.14 加 CSV 匯出）
// 複習計劃現況、不會字等級分布、練習量與複習答對率（事件自 2.0.13 起記錄）
// ============================================================
import { getWords, loadWords } from '../services/vocab.js';
import { addEvent, getEvents, getWordbooks, getSrsQueues, getUnknownMarks, SRS_INTERVALS } from '../services/store.js';
import { el, escapeHtml, dateStr, exportCsv } from '../core/ui.js';

export async function renderStats(main) {
  await loadWords();
  const wordsById = new Map(getWords().map((w) => [w.id, w]));
  const marks = (await getUnknownMarks()).filter((m) => wordsById.has(m.wordId));
  const { due, upcoming } = await getSrsQueues();
  const books = await getWordbooks();
  const events = await getEvents();

  // ---- 複習階段分布 ----
  const stageCount = new Array(SRS_INTERVALS.length).fill(0);
  for (const m of marks) {
    if (m.stage >= 0 && m.stage < SRS_INTERVALS.length) stageCount[m.stage]++;
  }
  const stageMax = Math.max(1, ...stageCount);
  const stageRows = stageCount.map((c, i) => `
      <div class="stat-row">
        <span class="stat-label">第 ${i + 1} 階（${SRS_INTERVALS[i]} 天）</span>
        <span class="stat-bar"><span style="width:${(c / stageMax) * 100}%"></span></span>
        <span class="stat-val">${c}</span>
      </div>`).join('');

  // ---- 不會字等級分布（併入下方「等級掌握度」） ----
  const lvCount = new Map();
  for (const m of marks) {
    const w = wordsById.get(m.wordId);
    if (!w) continue;
    lvCount.set(w.level, (lvCount.get(w.level) || 0) + 1);
  }

  // ---- 練習量與答對率（事件） ----
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfWeek = startOfToday - ((now.getDay() + 6) % 7) * 86400000; // 週一為一週之始
  let cardsToday = 0, cardsWeek = 0, cardsAll = 0;
  let reviewTotal = 0, reviewGood = 0, translateCount = 0;
  let quizTotal = 0, quizGood = 0; // 4.1.1：題型練習作答（extra={q,ok}）
  for (const e of events) {
    const t = new Date(e.at).getTime();
    if (e.type === 'card') {
      cardsAll++;
      if (t >= startOfToday) cardsToday++;
      if (t >= startOfWeek) cardsWeek++;
    } else if (e.type === 'review') {
      reviewTotal++;
      if (e.extra === true) reviewGood++;
    } else if (e.type === 'translate') {
      translateCount++;
    } else if (e.type === 'quiz') {
      quizTotal++;
      if (e.extra && e.extra.ok === true) quizGood++;
    }
  }
  const rate = reviewTotal ? Math.round((reviewGood / reviewTotal) * 100) : null;
  const quizRate = quizTotal ? Math.round((quizGood / quizTotal) * 100) : null;

  // ---- 連續學習天數（3.0.3；今天還沒學不中斷計算） ----
  const activeDays = new Set(events.map((e) => new Date(e.at).toDateString()));
  let streak = 0;
  {
    const day = new Date();
    if (!activeDays.has(day.toDateString())) day.setDate(day.getDate() - 1);
    while (activeDays.has(day.toDateString())) { streak++; day.setDate(day.getDate() - 1); }
  }

  // ---- 學習熱力圖（3.0.3；近 15 週，活動＝練習/複習/翻譯任一次） ----
  // 4.2.0 批次 3：左側補星期標（一/三/五）、底部補四階圖例
  const DAY = 86400000;
  const dayCounts = new Map();
  for (const e of events) {
    const k = new Date(e.at).toDateString();
    dayCounts.set(k, (dayCounts.get(k) || 0) + 1);
  }
  const todayMid = new Date(); todayMid.setHours(0, 0, 0, 0);
  const dow = (todayMid.getDay() + 6) % 7; // 週一=0
  const heatStart = new Date(todayMid.getTime() - (14 * 7 + dow) * DAY);
  // 每 4 週標一次月份（7 月中左右），避免窄螢幕擠成一團
  const monthMarks = new Set();   // 該欄起始的月份序號
  const monthLabels = new Map();  // 欄序號 → 「M月」
  let lastMonth = -1;
  for (let w = 0; w < 15; w++) {
    const first = new Date(heatStart.getTime() + w * 7 * DAY);
    if (first.getMonth() !== lastMonth) {
      lastMonth = first.getMonth();
      monthMarks.add(w);
      monthLabels.set(w, `${lastMonth + 1}月`);
    }
  }
  let heatCols = '';
  for (let w = 0; w < 15; w++) {
    let col = '';
    for (let d = 0; d < 7; d++) {
      const day = new Date(heatStart.getTime() + (w * 7 + d) * DAY);
      const future = day > todayMid;
      const n = dayCounts.get(day.toDateString()) || 0;
      const lvl = n === 0 ? 0 : n < 5 ? 1 : n < 15 ? 2 : n < 30 ? 3 : 4;
      col += `<span class="heat-cell${future ? ' future' : ''} h${lvl}" title="${day.getMonth() + 1}/${day.getDate()}：${n} 次"></span>`;
    }
    const label = monthMarks.has(w)
      ? `<span class="heat-month">${escapeHtml(monthLabels.get(w))}</span>`
      : '<span class="heat-month"></span>';
    heatCols += `<div class="heat-col-wrap">${label}<div class="heat-col">${col}</div></div>`;
  }

  // ---- 等級掌握度（3.0.3；未學／學習中／畢業，畢業自本版起記錄） ----
  const words = getWords();
  const graduatedLv = new Map();
  for (const e of events) {
    if (e.type !== 'graduate') continue;
    const w = wordsById.get(e.wordId);
    if (w) graduatedLv.set(w.level, (graduatedLv.get(w.level) || 0) + 1);
  }
  // 4.2.0 批次 3：.stat-val 補總數（原本只顯示畢業數，未學／學習中的比例看不出來）
  const masteryRows = [1, 2, 3, 4, 5, 6, 7].map((lv) => {
    const total = words.filter((w) => w.level === lv).length;
    const learning = lvCount.get(lv) || 0;
    const grad = graduatedLv.get(lv) || 0;
    const fresh = Math.max(0, total - learning - grad);
    const pct = (n) => (total ? (n / total) * 100 : 0);
    const name = lv <= 6 ? `Lv${lv}` : 'Lv7 補充';
    return `
      <div class="stat-row mastery-row">
        <span class="stat-label">${name}</span>
        <span class="mastery-bar" title="未學 ${fresh}／學習中 ${learning}／畢業 ${grad}">
          <span class="m-fresh" style="width:${pct(fresh)}%"></span><span class="m-learning" style="width:${pct(learning)}%"></span><span class="m-grad" style="width:${pct(grad)}%"></span>
        </span>
        <span class="stat-val" title="已畢業 ${grad}／全 ${total} 字">${grad}${total ? ` / ${total}` : ''}</span>
      </div>`;
  }).join('');

  const page = el(`
    <div class="stats-layout">
    <section class="card st-full">
      <div class="stat-tiles">
        <div class="stat-tile"><div class="stat-tile-num">${cardsToday}</div><div class="stat-tile-label">今日練習卡</div></div>
        <div class="stat-tile"><div class="stat-tile-num">${cardsWeek}</div><div class="stat-tile-label">本週練習卡</div></div>
        <div class="stat-tile"><div class="stat-tile-num">${rate === null ? '—' : rate + '%'}</div><div class="stat-tile-label">複習答對率</div><div class="stat-tile-sub">共 ${reviewTotal} 次</div></div>
        <div class="stat-tile"><div class="stat-tile-num">${translateCount}</div><div class="stat-tile-label">翻譯題提交</div></div>
        <div class="stat-tile"><div class="stat-tile-num">${streak}</div><div class="stat-tile-label">連續學習天數</div></div>
        <div class="stat-tile"><div class="stat-tile-num">${quizTotal === 0 ? '—' : (quizTotal < 10 ? `${quizRate}%（樣本少）` : `${quizRate}%`)}</div><div class="stat-tile-label">題型練習答對率</div><div class="stat-tile-sub">共 ${quizTotal} 次</div></div>
      </div>
      <p class="muted">※ 練習量自 2.0.13、畢業字數自 3.0.3 起記錄。</p>
    </section>

    <section class="card">
      <h2>學習熱力圖（近 15 週）</h2>
      <div class="heat">
        <div class="heat-dow"><span>一</span><span></span><span>三</span><span></span><span>五</span><span></span><span>日</span></div>
        <div class="heat-body">${heatCols}</div>
      </div>
      <p class="heat-legend tp-caption">
        <span>少</span>
        <span class="heat-cell h1"></span><span class="heat-cell h2"></span><span class="heat-cell h3"></span><span class="heat-cell h4"></span>
        <span>多（當天活動次數）</span>
      </p>
      <p class="muted small note-tight">顏色越深＝當天活動越多（練習＋複習＋翻譯）。</p>
    </section>

    <section class="card">
      <h2>等級掌握度</h2>
      ${masteryRows}
      <p class="muted small note-tight">灰＝未學 · 藍＝學習中（在複習計劃） · 深色＝已畢業（3.0.3 起記錄）。滑過長條看數字，右側為「已畢業／全部」字數。</p>
    </section>

    <section class="card">
      <h2>複習計劃現況（${marks.length} 字）</h2>
      <p>今日到期 <strong>${due.length}</strong> 字 · 排程中 ${upcoming.length} 字（到期清單見首頁每日任務）</p>
      ${marks.length ? `<h3>複習階段分布</h3>${stageRows}` : '<p class="muted">尚無資料。</p>'}
    </section>

    <section class="card">
      <h2>單詞本</h2>
      <p>共 ${books.length} 本，合計 ${books.reduce((s, b) => s + b.wordIds.length, 0)} 字。</p>
      <div class="controls controls-start">
        <button class="btn" id="btn-export-unknown">匯出不會單字（CSV）</button>
        <button class="btn" id="btn-export-events">匯出學習紀錄（CSV）</button>
      </div>
      <p class="muted">CSV 可用 Excel 直接開啟。</p>
    </section>
    </div>`);

  page.querySelector('#btn-export-unknown')?.addEventListener('click', () => {
    const rows = marks.map((m) => {
      const w = wordsById.get(m.wordId);
      return [
        w.level <= 6 ? `Lv${w.level}` : 'Lv7補充',
        w.word,
        w.pos,
        w.senses.join('；'),
        `第${m.stage + 1}階`,
        (m.dueAt || '').slice(0, 10),
      ];
    });
    exportCsv(`不會單字_${dateStr()}.csv`,
      ['等級', '英文', '詞性', '中文', '複習階段', '下次複習'], rows);
  });

  page.querySelector('#btn-export-events')?.addEventListener('click', async () => {
    const events = await getEvents();
    const rows = events.map((e) => {
      const typeName = { card: '練習卡', review: '複習評分', translate: '翻譯題', quiz: '題型練習', export: '匯出' }[e.type] || e.type;
      const detail = e.type === 'review'
        ? (e.extra === true ? '記住了' : '還不太會')
        : e.type === 'quiz'
          ? `${(e.extra && e.extra.q) || '未知題型'}｜${e.extra && e.extra.ok === true ? '答對' : '未全對'}`
          : (e.type === 'card' && wordsById.get(e.wordId)?.word) || '';
      return [e.at.slice(0, 19).replace('T', ' '), typeName, detail];
    });
    exportCsv(`學習紀錄_${dateStr()}.csv`, ['時間', '事件', '內容'], rows);
  });

  main.replaceChildren(page);
}

// ---------- CSV 匯出（2.0.14） ----------

