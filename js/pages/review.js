// ============================================================
// 複習元件（2.1.0）——內嵌於首頁
// 到期清單 → 複習月曆（可翻月、點日期預覽）→ 開始複習（翻面自評，
// 1→3→7→14 天推進、畢業自動移出）全都在首頁完成，不再有獨立複習頁
// ============================================================
import { examStarCount,getWords,loadExam,loadWords } from '../services/vocab.js';
import { addEvent, clearUnknown, getEvents, getSrsQueues, getUnknownMarks, gradeReview, unmarkUnknown, updateMarkDue, srsIntervals } from '../services/store.js';
import { getAnim, getFlipSpeak, rollFace } from '../services/settings.js';
import { el, escapeHtml, ICONS, iconInline, openDialog, speak, speakBtn, starsSvg, toast, zhLines } from '../core/ui.js';
import { dateKey, mountCalendar, todayKey } from '../core/calendar.js';

let daily = null;      // { view:'session'|'result', cards, idx, done }
let calMonth = null;   // 月曆目前顯示的月份（1 號）
let calSelected = null; // 點選的日期（YYYY-MM-DD）
let containerEl = null;    // 複習卡內容區
let calContainerEl = null; // 複習月曆卡內容區（桌面雙欄用）

// 4.2.0 批次 3：每日期的排程字數（Map<YYYY-MM-DD, count>）與月曆實例
// 由月曆元件 mountCalendar 自持；呼叫端只負責算字表與重畫
let calCounts = new Map();
let calInstance = null;

export async function renderDailyTask(taskEl, calEl) {
  containerEl = taskEl;
  calContainerEl = calEl;
  await loadWords();
  await loadExam();
  if (daily?.view === 'session') renderReviewSession();
  else if (daily?.view === 'result') renderResult();
  else renderOverview();
}

// ---------- 總覽（到期清單＋月曆＋排程管理） ----------
let schedOpen = false; // 排程管理面板開合

async function renderOverview() {
  const { due, upcoming } = await getSrsQueues();
  const wordsById = new Map(getWords().map((w) => [w.id, w]));

  // 3.0.3 集合式顯示：以複習次數（階段）分組，每組一列＋調整鈕
  const STAGE_LABEL = ['第一次複習', '第二次複習', '第三次複習', '第四次複習（畢業）'];
  const stageGroups = new Map();
  for (const m of due) {
    const s = Math.min(m.stage, STAGE_LABEL.length - 1);
    if (!stageGroups.has(s)) stageGroups.set(s, []);
    stageGroups.get(s).push(m);
  }
  const dueGroups = [...stageGroups.entries()].sort((a, b) => a[0] - b[0]).map(([stage, ms]) => {
    const words = ms.map((m) => wordsById.get(m.wordId)).filter(Boolean);
    const shown = words.slice(0, 3).map((w) => escapeHtml(w.word)).join('、');
    const more = words.length > 3 ? ` 等 ${words.length} 字` : '';
    return `
      <div class="due-group" data-stage="${stage}">
        <span class="dg-words">${shown}${more}</span>
        <span class="dg-stage">${STAGE_LABEL[stage]}</span>
        <button class="btn subtle dg-adjust" title="調整這組的複習時間">調整</button>
      </div>`;
  }).join('');

  // 今日完成率環圈：已評分 /（到期＋已評分）
  const events = await getEvents();
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const doneToday = events.filter((e) => e.type === 'review' && new Date(e.at).getTime() >= startOfToday).length;
  const planned = due.length + doneToday;
  const pct = planned ? Math.round((doneToday / planned) * 100) : 0;

  const startBtn = due.length
    ? `<button class="btn primary" id="btn-start-review">開始複習（${due.length} 字）</button>`
    : '<p class="finish">今日沒有到期的複習。標記新單字後，明天會出現在這裡。</p>';

  containerEl.replaceChildren(
    el(`<div><div class="task-head">
        <h2>複習</h2>
        <button class="btn subtle" id="btn-adjust" title="批量調整排程">調整</button>
      </div>
      <div class="srs-summary">
        <div class="srs-box ${due.length ? 'due' : ''}">
          <div class="num">${due.length}</div><div class="label">今日到期</div>
        </div>
        <button class="srs-box srs-box-btn" id="btn-sched" title="點擊管理未來排程">
          <div class="num">${upcoming.length}</div><div class="label">排程中 ${iconInline(ICONS.chevronDown, 13)}</div>
        </button>
        <div class="srs-box ring-box" title="今日已複評 ${doneToday} 次／共 ${planned} 次">
          <svg class="ring" viewBox="0 0 36 36">
            <circle class="ring-bg" cx="18" cy="18" r="15.9"></circle>
            <circle class="ring-fg" cx="18" cy="18" r="15.9" stroke-dasharray="${pct} 100"></circle>
          </svg>
          <div class="label">完成率 ${pct}%</div>
        </div>
      </div>
      ${startBtn}
      ${dueGroups ? `<div class="daily-list list-offset">${dueGroups}</div>` : ''}
      ${schedOpen ? '<div class="sched-panel sched-scroll" id="sched-panel"></div>' : ''}</div>`));

  calContainerEl.replaceChildren(
    el(`<div><h3>複習月曆</h3>
      <div id="daily-cal"></div>
      <div id="daily-cal-preview"></div></div>`));

  // 集合式：每組的「調整」＝整組日期平移到指定日
  containerEl.querySelectorAll('.dg-adjust').forEach((b) => {
    b.addEventListener('click', () => {
      const row = b.closest('.due-group');
      if (row.querySelector('.dg-adjust-ui')) { row.querySelector('.dg-adjust-ui').remove(); return; }
      row.insertAdjacentHTML('beforeend', `
        <div class="dg-adjust-ui">
          <input type="date" class="dg-date">
          <button class="btn primary dg-apply">整組套用</button>
          <button class="btn subtle dg-cancel">取消</button>
        </div>`);
      row.querySelector('.dg-cancel').addEventListener('click', () => row.querySelector('.dg-adjust-ui').remove());
      row.querySelector('.dg-apply').addEventListener('click', async () => {
        const v = row.querySelector('.dg-date').value;
        if (!v) return;
        const stage = Number(row.dataset.stage);
        for (const m of stageGroups.get(stage)) await updateMarkDue(m.wordId, v);
        renderOverview();
      });
    });
  });

  // 排程管理（點「排程中」開合）＋ 調整按鈕 → 複習管理頁
  containerEl.querySelector('#btn-sched').addEventListener('click', () => {
    schedOpen = !schedOpen;
    renderOverview();
  });
  containerEl.querySelector('#btn-adjust').addEventListener('click', () => {
    location.hash = '#/review';
  });
  if (schedOpen) {
    renderScheduleManager(containerEl.querySelector('#sched-panel'), upcoming, wordsById);
  }

  await renderCalendar(calContainerEl.querySelector('#daily-cal'), wordsById);

  const startBtnEl = containerEl.querySelector('#btn-start-review');
  if (startBtnEl) {
    startBtnEl.addEventListener('click', () => {
      daily = {
        view: 'session',
        cards: due.map((m) => ({ word: wordsById.get(m.wordId) })).filter((c) => c.word),
        idx: 0,
        done: { graduated: [], advanced: 0, again: 0 },
      };
      renderReviewSession();
    });
  }
}

// ---------- 排程管理：改日期／上下排序／刪除 ----------
function renderScheduleManager(panel, upcoming, wordsById) {
  if (upcoming.length === 0) {
    panel.replaceChildren(el('<p class="muted">目前沒有未來的排程。</p>'));
    return;
  }
  const rows = upcoming.map((m) => {
    const w = wordsById.get(m.wordId);
    const d = new Date(m.dueAt);
    const dateVal = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return `
      <div class="sched-row" data-wid="${m.wordId}">
        <span class="sched-word">${escapeHtml(w.word)}</span>
        <input type="date" value="${dateVal}" data-wid="${m.wordId}">
        <button class="btn subtle" data-act="del" data-wid="${m.wordId}" title="移出複習計劃" aria-label="移出複習計劃"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9.5 7V4.5h5V7"/><path d="M6.5 7l1 13h9l1-13"/><path d="M10 11v5.5M14 11v5.5"/></svg></button>
      </div>`;
  }).join('');

  panel.replaceChildren(el(`
    <p class="sched-hint">改日期＝調整複習時間；右側圖示＝移出複習計劃。要整組調整請用上方各組的「調整」。</p>
    ${rows}`));

  // 改日期
  panel.querySelectorAll('input[type="date"]').forEach((inp) => {
    inp.addEventListener('change', async () => {
      if (!inp.value) return;
      await updateMarkDue(Number(inp.dataset.wid), inp.value);
      renderDailyTask(containerEl, calContainerEl); // 4.0.4 修復：補月曆容器參數（漏傳會 crash）
    });
  });
  // 移出複習計劃
  panel.querySelectorAll('.sched-row .btn').forEach((b) => {
    b.addEventListener('click', async () => {
      const wid = Number(b.dataset.wid);
      const w = wordsById.get(wid);
      if (!w) return;
      // 4.2.0：confirm → openDialog（移出排程＝破壞性，danger）
      const ok = await openDialog({
        title: '移出複習計劃',
        body: `把「${w.word}」移出複習計劃？單字仍留在字庫，只是不再排程。`,
        danger: true,
        okText: '移出',
        cancelText: '取消',
      });
      if (!ok) return;
      await unmarkUnknown(wid);
      toast(`已把「${w.word}」移出複習計劃`, 'ok');
      renderDailyTask(containerEl, calContainerEl); // 4.0.4 修復：同上
    });
  });
}

// ---------- 月曆（4.2.0 批次 3：繪製改用 core/calendar.js 的 mountCalendar） ----------
async function renderCalendar(calEl, wordsById) {
  if (!calMonth) {
    const now = new Date();
    calMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  }
  const todayK = todayKey();

  // 彙整每日到期數與字表（含已過期＝算今天）
  const { due, upcoming } = await getSrsQueues();
  const perDay = new Map();
  const wordsByDate = new Map();
  calCounts.clear();
  const addDay = (m, w) => {
    const d = new Date(m.dueAt);
    const key = d.getTime() <= Date.now() ? todayK : dateKey(d);
    perDay.set(key, (perDay.get(key) || 0) + 1);
    calCounts.set(key, (calCounts.get(key) || 0) + 1);
    if (!wordsByDate.has(key)) wordsByDate.set(key, []);
    wordsByDate.get(key).push(w);
  };
  for (const m of due) {
    const w = wordsById.get(m.wordId);
    if (w) addDay(m, w);
  }
  for (const m of upcoming) {
    const w = wordsById.get(m.wordId);
    if (w) addDay(m, w);
  }

  // 預覽區（預設今天，或使用者點選的日期）
  // 4.2.0 批次 3：點日期不再整個重 renderCalendar（會重建月曆實例與流失焦點），
  // 改為就地重畫預覽文字
  const paintPreview = () => {
    const previewKey = calSelected || todayK;
    const list = wordsByDate.get(previewKey) || [];
    const label = previewKey === todayK ? '今天' : previewKey;
    const previewEl = calContainerEl.querySelector('#daily-cal-preview');
    if (!previewEl) return;
    previewEl.replaceChildren(el(`
      <div class="cal-preview">
        ${list.length
          ? `<p class="muted">${escapeHtml(label)}要複習 ${list.length} 字：</p>
             <p>${list.map((w) => `<span class="chip">${escapeHtml(w.word)}</span>`).join(' ')}</p>`
          : `<p class="muted">${escapeHtml(label)}：沒有排程。</p>`}
      </div>`));
  };

  calInstance = mountCalendar(calEl, {
    month: calMonth,
    selected: calSelected,
    counts: calCounts,
    onSelect: (key) => { calSelected = key; paintPreview(); },
    onMonth: (m) => { calMonth = m; },
  });

  paintPreview();
}

// 4.2.0 批次 3：todayKeyStr 與 WEEK 皆已併入 core/calendar.js（dateKey/todayKey/mountCalendar）

// ---------- 複習進行中 ----------
function renderReviewSession() {
  const c = daily.cards[daily.idx];
  c.side = rollFace(); // 3.0.0：預設顯示面依設置（英文/中文/隨機）
  const zhFirst = c.side === 'zh';
  containerEl.replaceChildren(el(`<div>
      <h2>複習中</h2>
      <div class="status" id="r-status">第 ${daily.idx + 1} / ${daily.cards.length} 字</div>
      <div class="flashcard" id="r-card" title="點一下翻面">
        <span class="badge lv${c.word.level}">${c.word.level <= 6 ? 'Lv' + c.word.level : '補充'}</span>${examStarCount(c.word) ? `<span class="badge exam-badge stars" aria-label="考題星級 ${examStarCount(c.word)} 星">${starsSvg(examStarCount(c.word), 11)}</span>` : ''}
        <div class="word" id="r-word">${zhFirst ? escapeHtml(zhLines(c.word.dictBrief || c.word.senses.join('；') || c.word.word)) : escapeHtml(c.word.word)}</div>
        <div class="pos">${zhFirst ? '' : escapeHtml(c.word.pos || '')}</div>
        ${speakBtn(c.word.word)}
        <p class="muted" id="r-hint">${zhFirst ? '先回想英文單字，再翻面對答案' : '先回想中文意思，再翻面對答案'}</p>
      </div>
      <div class="controls">
        <button class="btn primary" id="btn-flip">翻面對答案</button>
      </div>
      <div class="controls hidden" id="grade-controls">
        <button class="btn" id="btn-again">還不太會（明天再來）</button>
        <button class="btn primary" id="btn-good">記住了</button>
      </div>
      <p class="muted hint">快速鍵：空白鍵＝翻面、1＝還不太會、2＝記住了</p>
      <button class="btn subtle" id="btn-stop">暫停（下次繼續）</button></div>`));

  containerEl.querySelector('#btn-flip').addEventListener('click', flip);
  containerEl.querySelector('#r-card').addEventListener('click', (e) => {
    if (e.target.closest('.speak-btn')) return; // 發音鈕不翻面
    flip();
  });
  containerEl.querySelector('#btn-again').addEventListener('click', () => grade(false));
  containerEl.querySelector('#btn-good').addEventListener('click', () => grade(true));
  containerEl.querySelector('#btn-stop').addEventListener('click', () => {
    daily = null;
    renderDailyTask(containerEl, calContainerEl);
  });
}

function flip() {
  if (!daily || daily.view !== 'session' || !containerEl) return;
  const c = daily.cards[daily.idx];
  const wordEl = containerEl.querySelector('#r-word');
  const cardEl = containerEl.querySelector('#r-card');
  const applyMid = () => {
    if (c.side === 'zh') {
      // 中文面 → 翻出英文
      wordEl.textContent = c.word.word;
      c.side = 'en';
      // 5.0.x（spec 5.7 第 8 節）：翻面自動發音（預設關）——復用 core/ui.js 的 speak()
      if (getFlipSpeak()) speak(c.word.word);
    } else {
      wordEl.textContent = zhLines(c.word.dictBrief || c.word.senses.join('；') || c.word.word);
      c.side = 'zh';
    }
    containerEl.querySelector('#r-hint').textContent = '';
    containerEl.querySelector('#grade-controls').classList.remove('hidden');
    containerEl.querySelector('#btn-flip').classList.add('hidden');
  };
  cardEl.classList.remove('flipping');
  void cardEl.offsetWidth;
  if (getAnim() === 'flip') {
    // 立體翻轉：翻到 90° 時換內容
    cardEl.classList.add('flipping');
    setTimeout(applyMid, 110);
    setTimeout(() => cardEl.classList.remove('flipping'), 260);
  } else {
    // 輕柔淡入／彈性活潑：直接換內容
    applyMid();
    cardEl.classList.add('flipping');
    cardEl.addEventListener('animationend', () => cardEl.classList.remove('flipping'), { once: true });
  }
}

async function grade(remembered) {
  if (!daily || daily.view !== 'session') return;
  const c = daily.cards[daily.idx];
  const result = await gradeReview(c.word.id, remembered);
  addEvent('review', c.word.id, remembered); // 統計（2.0.13 起）
  if (result?.graduated) daily.done.graduated.push(c.word);
  else if (remembered) daily.done.advanced++;
  else daily.done.again++;

  daily.idx++;
  if (daily.idx >= daily.cards.length) {
    daily.view = 'result';
    renderResult();
  } else {
    renderReviewSession();
  }
}

// ---------- 結算 ----------
function renderResult() {
  const done = daily.done;
  const gradList = done.graduated.map((w) => `<span class="chip">${escapeHtml(w.word)}</span>`).join(' ');
  const total = done.graduated.length + done.advanced + done.again;
  containerEl.replaceChildren(el(`<div>
      <h2>複習</h2>
      <div class="finish">
        複習完成（共 ${total} 字）：<br>
        進入下一階段 ${done.advanced} 字 · 明天再來 ${done.again} 字 · 畢業 ${done.graduated.length} 字
      </div>
      ${done.graduated.length ? `<p>恭喜掌握：${gradList}</p>` : ''}
      <button class="btn primary" id="btn-back-overview">回到複習</button></div>`));
  containerEl.querySelector('#btn-back-overview').addEventListener('click', () => {
    daily = null;
    renderDailyTask(containerEl, calContainerEl);
  });
}

// ---------- 鍵盤快速鍵（複習進行中生效） ----------
document.addEventListener('keydown', (e) => {
  if (!daily || daily.view !== 'session' || !containerEl?.isConnected) return;
  if (e.target.matches('input, textarea, select')) return;
  if (e.key === ' ') {
    if (e.target.tagName === 'BUTTON') return;
    e.preventDefault();
    flip();
  } else if (e.key === '1') {
    grade(false);
  } else if (e.key === '2') {
    grade(true);
  }
});

// ============================================================
// 頁面：複習（2.1.2）——排程批量調整
// 月曆選日期 → 清單列出該日單字，可改日期／排序／移除
// 【4.0.0】底部新增「不會單字」管理區（自單詞本頁移入，間距縮短）
// ============================================================
let mgmtDate = null;  // 選中的日期（YYYY-MM-DD）
let mgmtMonth = null; // 月曆顯示月份

// 不會單字：下次複習的顯示文字（與原單詞本頁相同）
const dueText = (m) => {
  const dueMs = new Date(m.dueAt).getTime() - Date.now();
  if (dueMs <= 0) return '<span class="due-today">今日複習</span>';
  return `${Math.ceil(dueMs / 86400000)} 天後`;
};

export async function renderReviewManage(main) {
  await loadWords();
  if (!mgmtDate) mgmtDate = todayKey();
  if (!mgmtMonth) {
    const n = new Date();
    mgmtMonth = new Date(n.getFullYear(), n.getMonth(), 1);
  }

  const wordsById = new Map(getWords().map((w) => [w.id, w]));
  const { due, upcoming } = await getSrsQueues();
  const todayK = todayKey();

  // 依日期分組（已過期一律算今天）
  const perDay = new Map();
  const mgmtCounts = new Map();
  const addDay = (m) => {
    const w = wordsById.get(m.wordId);
    if (!w) return;
    const d = new Date(m.dueAt);
    const k = d.getTime() <= Date.now() ? todayK : dateKey(d);
    if (!perDay.has(k)) perDay.set(k, []);
    perDay.get(k).push({ word: w, mark: m });
    mgmtCounts.set(k, (mgmtCounts.get(k) || 0) + 1);
  };
  due.forEach(addDay);
  upcoming.forEach(addDay);
  for (const arr of perDay.values()) {
    arr.sort((a, b) => (a.mark.dueAt < b.mark.dueAt ? -1 : 1));
  }

  // ---- 月曆（4.2.0 批次 3：繪製改用 core/calendar.js 的 mountCalendar） ----
  // 年／月由 mountCalendar 自行取用 month 參數，故此處不再展開 y／mo

  // ---- 選中日期的單字列 ----
  const listWords = perDay.get(mgmtDate) || [];
  const label = mgmtDate === todayK ? '今天' : mgmtDate;
  const rows = listWords.map((x) => {
    const d = new Date(x.mark.dueAt);
    const dateVal = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return `
      <div class="mgmt-row">
        <span class="mgmt-word">${escapeHtml(x.word.word)}</span>
        <input type="date" value="${dateVal}" data-wid="${x.word.id}">
        <button class="btn subtle" data-act="del" data-wid="${x.word.id}" title="移出複習計劃">移除</button>
      </div>`;
  }).join('');

  // ---- 不會單字區（4.0.0 自單詞本頁移入；呈現相同、間距縮短） ----
  // 5.0.x：階數跟當前複習強度走（三段都是 4 階，顯示用的天數不再硬寫）
  const stageCount = srsIntervals().length;
  const marks = (await getUnknownMarks()).filter((m) => wordsById.has(m.wordId));
  const unknownRows = marks.map((m) => {
    const w = wordsById.get(m.wordId);
    return `
      <tr>
        <td>Lv${w.level}</td>
        <td class="td-word">${escapeHtml(w.word)}</td>
        <td>${escapeHtml(w.pos)}</td>
        <td>第 ${m.stage + 1} / ${stageCount} 階</td>
        <td>${dueText(m)}</td>
        <td><button class="btn subtle btn-remove" data-id="${w.id}" data-word="${escapeHtml(w.word)}">移除</button></td>
      </tr>`;
  }).join('');

  main.replaceChildren(el(`
    <div class="review-layout">
      <section class="card list-card-wrap">
        <div class="review-day-title">${escapeHtml(label)}要複習的單字（${listWords.length}）</div>
        ${listWords.length ? `<div class="bulk-move">
            <input type="date" id="bulk-date" title="一鍵移動目標日期">
            <button class="btn primary" id="btn-bulk-move">一鍵移動全部</button>
          </div>` : ''}
        ${listWords.length ? rows : '<p class="mgmt-empty">這天沒有排程。點右側月曆選擇其他日期。</p>'}
      </section>
      <section class="card cal-card-wrap">
        <h3>複習月曆</h3>
        <div id="mg-cal"></div>
        <p class="muted small note-below">點日期，左側調整該日單字；改日期、移除立即生效。</p>
      </section>
      <section class="card unknown-card">
        ${marks.length === 0 ? `
          <h3>不會單字</h3>
          <p class="muted">還沒有標記任何單字。到「查詢」搜尋單字後按「標記為不會」按鈕，或在「練習」中加入複習計劃。</p>
        ` : `
          <h3>不會單字（${marks.length}）</h3>
          <p class="muted small">加入複習計劃後自動依 1、3、7、14 天排程複習。資料存在這台裝置的瀏覽器。</p>
          <div class="table-scroll">
            <table>
              <thead><tr><th>等級</th><th>英文</th><th>詞性</th><th>複習階段</th><th>下次複習</th><th>操作</th></tr></thead>
              <tbody>${unknownRows}</tbody>
            </table>
          </div>
          <button class="btn subtle clear-row" id="btn-clear-unknown">全部清除</button>
        `}
      </section>
    </div>`));

  // ---- 月曆（4.2.0 批次 3：掛 core/calendar.js，事件由 mountCalendar 內部綁） ----
  mountCalendar(main.querySelector('#mg-cal'), {
    month: mgmtMonth,
    selected: mgmtDate,
    counts: mgmtCounts,
    navIds: { prev: 'mg-prev', next: 'mg-next' },
    onSelect: (key) => { mgmtDate = key; renderReviewManage(main); },
    onMonth: (m) => { mgmtMonth = m; renderReviewManage(main); },
  });

  // ---- 單字列事件 ----
  main.querySelectorAll('.mgmt-row input[type="date"]').forEach((inp) => {
    inp.addEventListener('change', async () => {
      if (!inp.value) return;
      await updateMarkDue(Number(inp.dataset.wid), inp.value);
      renderReviewManage(main);
    });
  });
  main.querySelectorAll('.mgmt-row .btn').forEach((b) => {
    b.addEventListener('click', async () => {
      const wid = Number(b.dataset.wid);
      const w = wordsById.get(wid);
      if (!w) return;
      // 4.2.0：confirm → openDialog（移出排程＝破壞性，danger）
      const ok = await openDialog({
        title: '移出複習計劃',
        body: `把「${w.word}」移出複習計劃？單字仍留在字庫。`,
        danger: true,
        okText: '移出',
        cancelText: '取消',
      });
      if (!ok) return;
      await unmarkUnknown(wid);
      toast(`已把「${w.word}」移出複習計劃`, 'ok');
      renderReviewManage(main);
    });
  });

  // ---- 一鍵移動（4.0.4）：該日全部單字移到指定日期 ----
  main.querySelector('#btn-bulk-move')?.addEventListener('click', async () => {
    const v = main.querySelector('#bulk-date').value;
    if (!v) { toast('請先選擇要移動到的日期', 'bad'); return; }
    // 4.2.0：confirm → openDialog（整批改期，danger）
    const ok = await openDialog({
      title: '整批移動',
      body: `把 ${label} 的全部 ${listWords.length} 個單字移動到 ${v}？原有的到期日會被覆蓋。`,
      danger: true,
      okText: '移動',
      cancelText: '取消',
    });
    if (!ok) return;
    for (const x of listWords) await updateMarkDue(x.word.id, v);
    toast(`已把 ${listWords.length} 個單字移到 ${v}`, 'ok');
    renderReviewManage(main);
  });

  // ---- 不會單字事件（4.0.0） ----
  main.querySelectorAll('.unknown-card .btn-remove').forEach((b) => {
    b.addEventListener('click', async () => {
      // 4.3.0 修復（Pool A Medium）：與排程列的移除一致——openDialog 確認（danger）
      const ok = await openDialog({
        title: '移出複習計劃',
        body: `把「${b.dataset.word || b.dataset.id}」移出複習計劃？單字仍留在字庫。`,
        danger: true,
        okText: '移除',
      });
      if (!ok) return;
      await unmarkUnknown(Number(b.dataset.id));
      toast('已移出複習計劃', 'ok');
      renderReviewManage(main);
    });
  });
  main.querySelector('#btn-clear-unknown')?.addEventListener('click', async () => {
    // 4.2.0：confirm → openDialog（清除全部標記＝最高級破壞性，danger）
    const ok = await openDialog({
      title: '清除全部標記',
      body: `確定要清除全部 ${marks.length} 個「不會」標記嗎？清除後所有單字都要重新排程，此操作不可復原。`,
      danger: true,
      okText: '全部清除',
      cancelText: '取消',
    });
    if (!ok) return;
    await clearUnknown();
    toast(`已清除 ${marks.length} 個「不會」標記`, 'ok');
    renderReviewManage(main);
  });
}
