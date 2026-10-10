// ============================================================
// 頁面：學習統計（2.0.13；2.0.14 加 CSV 匯出）
// 複習計劃現況、不會字等級分布、練習量與複習答對率（事件自 2.0.13 起記錄）
// ============================================================
import { getWords, loadWords } from '../services/vocab.js';
import { addEvent, getEvents, getWordbooks, getSrsQueues, getUnknownMarks, srsIntervals } from '../services/store.js';
import { el, escapeHtml, dateStr, emptyState, exportCsv } from '../core/ui.js';

export async function renderStats(main) {
  await loadWords();
  const wordsById = new Map(getWords().map((w) => [w.id, w]));
  const marks = (await getUnknownMarks()).filter((m) => wordsById.has(m.wordId));
  const { due, upcoming } = await getSrsQueues();
  const books = await getWordbooks();
  const events = await getEvents();

  // ---- 複習階段分布 ----
  // 5.0.x：顯示的天數跟「複習強度」設定走（天數集中於 services/settings.js）
  const stageIntervals = srsIntervals();
  const stageCount = new Array(stageIntervals.length).fill(0);
  for (const m of marks) {
    if (m.stage >= 0 && m.stage < stageIntervals.length) stageCount[m.stage]++;
  }
  const stageMax = Math.max(1, ...stageCount);
  const stageRows = stageCount.map((c, i) => `
      <div class="stat-row">
        <span class="stat-label">第 ${i + 1} 階（${stageIntervals[i]} 天）</span>
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

  // ---- 5.0.x 圖一：未來 14 天複習負載（spec 第 4 節）----
  // 資料＝現有 SRS 排程的 dueAt 分箱：今天（已過期也計入今天）＋未來 13 天。
  // 沒有任何排程時整張圖不渲染（走 emptyState），避免出現一排 0 的空長條圖。
  const load14 = Array.from({ length: 14 }, () => 0);
  for (const m of marks) {
    const t = new Date(m.dueAt || m.addedAt).getTime();
    if (!Number.isFinite(t)) continue;
    const day = Math.floor((t - todayMid.getTime()) / DAY);
    const idx = day < 0 ? 0 : (day > 13 ? -1 : day);
    if (idx >= 0) load14[idx]++;
  }
  const loadTotal = load14.reduce((a, b) => a + b, 0);
  const loadMax14 = Math.max(1, ...load14); // 長條圖的比例尺（必須在使用它的模板之前算好）
  const load14Html = loadTotal
    ? `<div class="load14">${load14.map((n, i) => `
        <div class="load14-col${i === 0 ? ' load14-col--today' : ''}" title="${i === 0 ? '今天' : `${i} 天後`}：${n} 字">
          <span class="load14-n">${n || ''}</span>
          <span class="load14-bar" style="height:${loadTotal ? Math.max(2, Math.round((n / loadMax14) * 100)) : 2}%"></span>
        </div>`).join('')}</div>
      <div class="load14-x">${load14.map((_, i) => `<span>${i === 0 ? '今天' : (i % 3 === 0 ? `+${i}` : '')}</span>`).join('')}</div>`
    : emptyState({ icon: 'calendar', title: '尚無複習排程', desc: '把單字加入「不會單字／複習計劃」後，這裡會顯示未來 14 天每天的到期字數。' });

  // ---- 5.0.x 圖二：True Retention（spec 第 4 節）----
  // 定義＝「進入 14 天階段後的**首次**複習通過率」。
  // 做法：把 events 的 review 紀錄**重播一次 SRS 狀態機**（答對推進一階、答錯回第 0 階，
  //   與 store.js 的 gradeReview 同一規則），某字第一次推進到最後一階（＝14 天那一階）
  //   就視為「進入 14 天階段」；其後的**第一次**複習評分即這個字的成熟首次複習。
  // 為什麼要重播狀態機：events 只記「有沒有記住」、不記階段；用「連續答對次數」推成熟點
  //   與實際 SRS 完全一致，用時間間隔推則會被中途答錯拖走而算錯。
  //   階數與「複習強度」無關（輕鬆／標準／紮實都是 4 階，只是天數不同）。
  const MATURE_STAGE = 3; // 0-based 第 3 階＝ SRS 的最後一階＝14 天階段
  const reviewByWord = new Map(); // wordId → review 事件（依時間）
  for (const e of events) {
    if (e.type !== 'review' || e.wordId == null) continue;
    if (!reviewByWord.has(String(e.wordId))) reviewByWord.set(String(e.wordId), []);
    reviewByWord.get(String(e.wordId)).push(e);
  }
  let trPass = 0, trTotal = 0;
  for (const list of reviewByWord.values()) {
    list.sort((a, b) => (a.at < b.at ? -1 : 1));
    let stage = 0;         // 與 markUnknown 一致：從第 0 階開始
    let matureAt = false;  // 是否已推進到 14 天那一階
    let firstAfter = null; // 成熟後的首次複習
    for (const e of list) {
      if (matureAt) { firstAfter = e; break; }
      if (e.extra === true) {
        stage += 1;
        if (stage === MATURE_STAGE) matureAt = true;
      } else {
        stage = 0; // 答錯回到第 0 階（與 gradeReview 相同）
      }
    }
    if (!firstAfter) continue; // 還沒成熟，或成熟後還沒複習過
    trTotal++;
    if (firstAfter.extra === true) trPass++;
  }
  const trRate = trTotal ? Math.round((trPass / trTotal) * 100) : null;

  // ---- 5.1.1 T2：單字三桶（分桶口徑與單測在檔尾 bucketWords，避免兩份漂移） ----
  // graduate 事件取自本頁已讀的 events（不新增請求）；marks 同理由頁首的 getUnknownMarks 提供。
  const graduateIds = new Set(events.filter((e) => e.type === 'graduate').map((e) => String(e.wordId)));
  const buckets = bucketWords(wordsById, marks, graduateIds);
  // 展開清單最多顯示 50 個字（spec T2）；超過時如實標示剩餘字數
  const BUCKET_PREVIEW = 50;

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
    <!-- 5.1.1 T1：熱力圖移到 stats-layout 第一位（樣品 M6：打卡記錄先於數字摘要）；
         同時加 st-full——15 週的熱力圖在雙欄半寬會擠到要橫向捲動，全寬才讀得完 -->
    <section class="card st-full">
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

    <!-- 5.1.1 T2：單字三桶（樣品 M6 的 .buckets）；也給 st-full——三桶要並排比對，半寬會擠成一欄 -->
    <section class="card st-full">
      <h2>單字三桶</h2>
      <div class="buckets">
        ${buckets.map((b) => `
        <button type="button" class="bucket ${b.cls}" data-bucket="${b.id}" aria-expanded="false">
          <div class="n">${b.words.length}</div>
          <div class="t">${b.name}</div>
          <div class="bkt-sub muted small">${b.sub}</div>
        </button>`).join('')}
      </div>
      <p class="muted small note-tight">點桶展開單字清單，可以直接開練；待加強是考前衝刺的首選。</p>
      <p class="muted small" id="bkt-note" hidden></p>
      <div id="bkt-detail" hidden></div>
    </section>

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
      <h2>未來 14 天複習負載</h2>
      ${loadTotal ? `<p class="muted small note-tight">依目前排程，未來 14 天每天的到期字數（共 ${loadTotal} 字）。今天的欄位加框標示。</p>${load14Html}`
        : load14Html}
    </section>

    <section class="card">
      <h2>真實記得率（True Retention）</h2>
      ${trTotal ? `<div class="tr-pair">
        <div class="tr-box"><div class="num">${rate === null ? '—' : rate + '%'}</div><div class="label">全期複習答對率（${reviewTotal} 次）</div></div>
        <div class="tr-box"><div class="num">${trRate}%</div><div class="label">成熟字真實記得率（${trPass} / ${trTotal} 字）</div></div>
      </div>
      <p class="muted small note-tight">成熟字的真實記得率＝走完 14 天階段之後，這些字**第一次**再複習時就記住的比率；
        全期答對率會隨練習次數累積而偏高，兩者並排看才看得出「真的記住了多少」。</p>`
        : emptyState({ icon: 'box', title: '尚無成熟的複習紀錄', desc: 'True Retention＝走完 14 天階段後，這些字第一次再複習時就記住的比率。累積到有成熟字之後才會顯示。' })}
    </section>

    <section class="card">
      <h2>等級掌握度</h2>
      ${masteryRows}
      <p class="muted small note-tight">灰＝未學 · 藍＝學習中（在複習計劃） · 深色＝已畢業（3.0.3 起記錄）。滑過長條看數字，右側為「已畢業／全部」字數。</p>
    </section>

    <section class="card">
      <h2>複習計劃現況（${marks.length} 字）</h2>
      <p>今日到期 <strong>${due.length}</strong> 字 · 排程中 ${upcoming.length} 字（到期清單見首頁複習）</p>
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

  // ---------- 5.1.1 T2：單字三桶展開與「開始練這桶」 ----------
  // 訪客鎖：比照站內練習入口慣例不加鎖——practice.js 的分類卡與 unknown.js 的「練習（隨機）」
  // 都沒有訪客閘（訪客本來就能翻卡練習），本頁若特別鎖住會與全站語意不一致。
  // mode 選 'unknown'：不選 'wordbook'（會隱藏「加入單詞本」，而三桶都可能出現想收藏的字），
  // 也不選 'study'（會啟用 H1 接續序列化與 C1 段末結算，兩者的語意都不屬於統計頁的補練）。
  const bktDetail = page.querySelector('#bkt-detail');
  const bktNote = page.querySelector('#bkt-note');
  const fillBucketDetail = (b) => {
    const total = b.words.length;
    // spec T2：清單最多列前 50 個，超出部分如實標示剩餘字數
    const chips = b.words.slice(0, BUCKET_PREVIEW)
      .map((w) => `<span class="chip">Lv${w.level}　${escapeHtml(w.word)}</span>`).join('');
    bktDetail.replaceChildren(el(`
      <p class="small note-tight"><strong>${b.name}</strong>・${b.sub}・共 ${total} 字${total > BUCKET_PREVIEW ? `（顯示前 ${BUCKET_PREVIEW}）` : ''}</p>
      ${total ? chips : '<p class="muted small">這桶目前是空的。</p>'}
      ${total ? `<div class="controls controls-start">
        <button class="btn primary" id="bkt-start">開始練這桶（${total} 字）</button>
      </div>` : ''}
    `));
    bktDetail.hidden = false;
    bktNote.hidden = total <= BUCKET_PREVIEW;
    bktNote.textContent = total > BUCKET_PREVIEW
      ? `字太多，這裡只列前 ${BUCKET_PREVIEW} 個；開練會涵蓋整桶 ${total} 字。`
      : '';
    page.querySelector('#bkt-start')?.addEventListener('click', async () => {
      // 動態 import：統計頁不需要把抽卡引擎拖進靜態依賴圖（與學習頁的接回同一慣例）
      const { startPractice } = await import('../pages/practice.js');
      startPractice(b.words, 'unknown');
    });
  };
  page.querySelectorAll('.bucket').forEach((btn) => btn.addEventListener('click', () => {
    // 同一時間只展開一桶（accordion）；再點一次同一桶即收合
    const wasOpen = !bktDetail.hidden && btn.dataset.open === '1';
    page.querySelectorAll('.bucket').forEach((c) => {
      const on = !wasOpen && c === btn;
      c.classList.toggle('is-open', on);
      c.setAttribute('aria-expanded', String(on));
      if (on) c.dataset.open = '1';
      else delete c.dataset.open;
    });
    if (wasOpen) {
      bktDetail.hidden = true;
      bktNote.hidden = true;
      bktDetail.replaceChildren();
      return;
    }
    const bucket = buckets.find((x) => x.id === btn.dataset.bucket);
    if (bucket) fillBucketDetail(bucket);
  }));

  main.replaceChildren(page);
}

// ---------- CSV 匯出（2.0.14） ----------

// ---------- 5.1.1 T2：單字三桶分桶 ----------
/**
 * 單字三桶（spec T2）。分桶口徑以「曾否有 graduate 事件」與「目前是否在複習計劃」兩軸切分：
 *   學習中＝在 marks 且從未 graduate（還在爬階）
 *   待加強＝曾 graduate 卻仍在 marks（退步字，考前衝刺首選）
 *   已精熟＝曾 graduate 且不在 marks（與 core/mastery.js 的「精熟」同一定義）
 * 三桶互斥、正好覆蓋 marks 與 graduate 的並集，同一個字不會重複計數。
 * 參數形狀比照 core/mastery.js 的 idSetOf：marks／graduateIds 可收列（物件帶 wordId）或 id 集合，
 * 字串與數字 id 都接受。字庫的 id 是數字，marks 側一律 String 化，查表前先建字串鍵鏡像——
 * 直接用 number 鍵的 Map 去 get 字串 id 會永遠找不到，三桶會全數為空。
 * 導出供 smoke 測試對照分桶口徑；純函式、不碰 services。
 */
export function bucketWords(wordsById, marks, graduateIds) {
  const toId = (x) => String(x && typeof x === 'object' ? x.wordId : x);
  const marksIds = new Set(Array.from(marks || []).map(toId));
  const grad = new Set(Array.from(graduateIds || []).map(toId));
  const byStrId = new Map([...(wordsById || new Map())].map(([k, v]) => [String(k), v]));
  const byWord = (ids) => ids.map((id) => byStrId.get(id)).filter(Boolean)
    .sort((a, b) => a.level - b.level || a.word.localeCompare(b.word));
  const defs = [
    { id: 'learning', name: '學習中', sub: '在複習計劃中、尚未畢業', cls: '' },
    { id: 'flagging', name: '待加強', sub: '曾畢業又回到複習計劃', cls: 'warn' },
    { id: 'matured', name: '已精熟', sub: '已不在複習計劃', cls: 'ok' },
  ];
  return defs.map((d) => ({
    ...d,
    words: byWord([...(d.id === 'matured'
      ? [...grad].filter((id) => !marksIds.has(id))
      : [...marksIds].filter((id) => (d.id === 'flagging') === grad.has(id)))]),
  }));
}

