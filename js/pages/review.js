import { getUser, getAuthGeneration } from '../services/auth.js';
import { completeTaskWord } from '../services/daily-tasks.js';
import { on } from '../core/eventbus.js';
import { localDateKey } from '../core/daily-plan.js';
import { capturePage, registerOwnerReset } from '../services/owner-guard.js';
// ============================================================
// 複習元件（2.1.0）——內嵌於首頁
// 到期清單 → 複習月曆（可翻月、點日期預覽）→ 開始複習（翻面自評，
// 1→3→7→14 天推進、畢業自動移出）全都在首頁完成，不再有獨立複習頁
// ============================================================
import { examStarCount,getWords,loadExam,loadWords } from '../services/vocab.js';
import { addEvent, clearUnknown, getEvents, getSrsQueues, getUnknownMarks, gradeReview, gradeTaskReview, previewReview, unmarkUnknown, updateMarkDue, srsIntervals } from '../services/store.js';
import { getAnim, getFlipSpeak, rollFace } from '../services/settings.js';
import { el, escapeHtml, ICONS, iconInline, openDialog, speak, speakBtn, starsSvg, toast, zhLines } from '../core/ui.js';
import { dateKey, mountCalendar, todayKey } from '../core/calendar.js';

// 6.2.0：帳戶更換（含登出 guest、A→B→A）時立即清掉本模組的 session／月曆快取，
// 中央 app handler 再重畫新 owner；同 owner token 續期不觸發 reset。
registerOwnerReset(() => {
  daily = null;
  schedOpen = false;
  calMonth = null;
  calSelected = null;
  containerEl = null;
  calContainerEl = null;
  manageSelect = null;
  calCounts.clear();
  calInstance = null;
  overviewToken++;
});

let daily = null;      // { view:'session'|'result', cards, idx, done }
let calMonth = null;   // 月曆目前顯示的月份（1 號）
let calSelected = null; // 點選的日期（YYYY-MM-DD）
let containerEl = null;    // 複習卡內容區
let calContainerEl = null; // 複習月曆卡內容區（桌面雙欄用）
// 複習管理頁的日期選取回呼：只由 renderReviewManage 設定；其他頁面不設，選日期僅更新預覽。
let manageSelect = null;

// 4.2.0 批次 3：每日期的排程字數（Map<YYYY-MM-DD, count>）與月曆實例
// 由月曆元件 mountCalendar 自持；呼叫端只負責算字表與重畫
let calCounts = new Map();
let calInstance = null;

// 6.1.1：卡片引擎一律讀「真標記」的 engine；不以全域設定開關判定既有卡。
// 每日任務的卡片會在 startTaskReview 取得同一批標記後帶入 mark。
const isFsrsCard = (card) => (card?.mark?.engine || card?.engine) === 'fsrs6';
const emptyDone = () => ({ graduated: [], advanced: 0, again: 0, fsrs: { again: 0, hard: 0, good: 0 } });

export async function renderDailyTask(taskEl, calEl) {
  containerEl = taskEl;
  calContainerEl = calEl;
  await loadWords();
  await loadExam();
  if (daily?.view === 'session') renderReviewSession();
  else if (daily?.view === 'result') renderResult();
  else await renderOverview();
}

// ---------- 總覽（到期清單＋月曆＋排程管理） ----------
let schedOpen = false; // 排程管理面板開合
// 每次總覽重畫遞增。晚到的非同步結果（月曆佇列）只能套用在同一次總覽，
// 不能改寫已開始的複習 session、已離頁或已換頁的新內容。
let overviewToken = 0;

async function renderOverview() {
  const token = ++overviewToken;
  const host = containerEl;
  const guard = capturePage();
  const stillCurrent = () => guard.active()
    && token === overviewToken
    && containerEl === host
    && daily?.view !== 'session'
    && daily?.view !== 'result';
  let due, upcoming;
  try {
    ({ due, upcoming } = await getSrsQueues());
  } catch (err) {
    if (err?.code === 'ACCOUNT_CHANGED' || /ACCOUNT_CHANGED/.test(String(err.message))) return;
    throw err;
  }
  if (!stillCurrent()) return;
  const wordsById = new Map(getWords().map((w) => [w.id, w]));

  // 3.0.3 集合式顯示：以複習次數（階段）分組，每組一列＋調整鈕
  // 6.1.1：固定排程與 FSRS 分開列示。FSRS 沒有「第四次畢業」這種固定階段，不得誤標。
  const STAGE_LABEL = ['第一次複習', '第二次複習', '第三次複習', '第四次複習（畢業）'];
  const stageGroups = new Map();
  const fsrsDue = [];
  for (const m of due) {
    if (m.engine === 'fsrs6') { fsrsDue.push(m); continue; }
    const s = Math.min(Number.isInteger(m.stage) ? m.stage : 0, STAGE_LABEL.length - 1);
    if (!stageGroups.has(s)) stageGroups.set(s, []);
    stageGroups.get(s).push(m);
  }
  const groupRow = (ms, label, key) => {
    const words = ms.map((m) => wordsById.get(m.wordId)).filter(Boolean);
    const shown = words.slice(0, 3).map((w) => escapeHtml(w.word)).join('、');
    const more = words.length > 3 ? ` 等 ${words.length} 字` : '';
    return `
      <div class="due-group" data-stage="${key}">
        <span class="dg-words">${shown}${more}</span>
        <span class="dg-stage">${label}</span>
        <button class="btn subtle dg-adjust" title="調整這組的複習時間">調整</button>
      </div>`;
  };
  const dueGroups = [...stageGroups.entries()].sort((a, b) => a[0] - b[0])
    .map(([stage, ms]) => groupRow(ms, STAGE_LABEL[stage], String(stage))).join('')
    + (fsrsDue.length ? groupRow(fsrsDue, 'FSRS 排程', 'fsrs') : '');

  // 今日完成率環圈：已評分 /（到期＋已評分）
  let events;
  try {
    events = await getEvents();
  } catch (err) {
    if (err?.code === 'ACCOUNT_CHANGED' || /ACCOUNT_CHANGED/.test(String(err.message))) return;
    throw err;
  }
  if (!stillCurrent()) return;
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
        const key = row.dataset.stage;
        const targets = key === 'fsrs' ? fsrsDue : (stageGroups.get(Number(key)) || []);
        for (const m of targets) {
          if (!guard.active()) return; // 6.2.0：換帳戶即停手，不把 A 的排程改寫進 B
          await updateMarkDue(m.wordId, v, { owner: guard });
        }
        if (guard.active()) renderOverview();
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
    renderScheduleManager(containerEl.querySelector('#sched-panel'), upcoming, wordsById, guard);
  }

  // 入口 listener 必須與按鈕顯示同一個同步階段綁定：月曆還要再等一次
  // getSrsQueues，若隔著 await 才綁，按鈕已出現但點擊會無效。
  const startBtnEl = containerEl.querySelector('#btn-start-review');
  if (startBtnEl) {
    startBtnEl.addEventListener('click', () => {
      if (!stillCurrent() || !containerEl?.contains(startBtnEl)) return; // 過期總覽／已離頁
      if (daily?.view === 'session' || daily?.view === 'result') return; // 防連按
      daily = {
        view: 'session',
        cards: due.map((m) => ({ word: wordsById.get(m.wordId), mark: m })).filter((c) => c.word),
        idx: 0,
        done: emptyDone(),
        _owner: capturePage(),
      };
      renderReviewSession();
    });
  }

  await renderCalendar(calContainerEl.querySelector('#daily-cal'), wordsById, token);
}

// ---------- 排程管理：改日期／上下排序／刪除 ----------
function renderScheduleManager(panel, upcoming, wordsById, guard) {
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

  // 改日期（render-time guard：A 舊輸入框在 B 畫面派 change 不得改 B 的排程）
  panel.querySelectorAll('input[type="date"]').forEach((inp) => {
    inp.addEventListener('change', async () => {
      if (!inp.value || !guard.active()) return;
      await updateMarkDue(Number(inp.dataset.wid), inp.value, { owner: guard });
      if (guard.active()) renderDailyTask(containerEl, calContainerEl); // 4.0.4 修復：補月曆容器參數（漏傳會 crash）
    });
  });
  // 移出複習計劃
  panel.querySelectorAll('.sched-row .btn').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!guard.active()) return;
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
      if (!ok || !guard.active()) return;
      try {
        await unmarkUnknown(wid, { owner: guard });
      } catch (err) {
        if (err?.code === 'ACCOUNT_CHANGED' || /ACCOUNT_CHANGED/.test(String(err.message))) return;
        throw err;
      }
      if (!guard.active()) return;
      toast(`已把「${w.word}」移出複習計劃`, 'ok');
      renderDailyTask(containerEl, calContainerEl); // 4.0.4 修復：同上
    });
  });
}

// ---------- 月曆（4.2.0 批次 3：繪製改用 core/calendar.js 的 mountCalendar） ----------
async function renderCalendar(calEl, wordsById, token = overviewToken) {
  if (!calMonth) {
    const now = new Date();
    calMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  }
  const todayK = todayKey();
  const calHost = calContainerEl;
  const overviewRoot = containerEl?.firstElementChild;
  const guard = capturePage();
  // 月曆與複習 session 共用頁面：按下開始複習後月曆仍要留在原位，
  // 因此不能把 session／result 當成「已離頁」。這裡只擋換頁、重畫與容器被移除；
  // 否則使用者按得比月曆的非同步繪製快時，這個入口會永遠空白。
  const stillCurrent = () => guard.active()
    && token === overviewToken
    && calContainerEl === calHost
    && containerEl?.contains(overviewRoot)
    && calHost?.contains(calEl)
    && calHost?.isConnected;

  // 彙整每日到期數與字表（含已過期＝算今天）
  let due, upcoming;
  try {
    ({ due, upcoming } = await getSrsQueues());
  } catch (err) {
    // renderOverview 在按鈕 handler 中 fire-and-forget；切帳戶時此讀取會合法失效。
    if (err?.code === 'ACCOUNT_CHANGED' || /ACCOUNT_CHANGED/.test(String(err.message))) return;
    throw err;
  }
  // 月曆讀取較慢：此時使用者可能已按開始複習、離頁或換頁；晚到資料不得再畫。
  if (!stillCurrent()) return;
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
    onSelect: (key) => {
      calSelected = key;
      paintPreview();
      // 複習管理頁沿用同一顆月曆選日期（不再另掛第二顆）；由頁面注入回呼更新左側清單。
      manageSelect?.(key);
    },
    onMonth: (m) => { calMonth = m; },
  });

  paintPreview();
}

// 4.2.0 批次 3：todayKeyStr 與 WEEK 皆已併入 core/calendar.js（dateKey/todayKey/mountCalendar）

// ---------- 複習進行中 ----------
const REVIEW_GRADES = [
  { key: 'again', label: '忘了', hotkey: '1' },
  { key: 'hard', label: '勉強', hotkey: '2' },
  { key: 'good', label: '記得', hotkey: '3' },
];

const reviewSessionToken = () => ({
  authGeneration: getAuthGeneration(),
  ownerId: daily?.taskContext?.ownerId ?? getUser()?.id ?? null,
  wordId: daily?.cards?.[daily.idx]?.word?.id ?? null,
});

function gradeControlsFor(card) {
  if (isFsrsCard(card)) {
    return `<div class="controls grade-controls grade-3 hidden" id="grade-controls">
        ${REVIEW_GRADES.map((g) => `<button class="btn${g.key === 'good' ? ' primary' : ''}" id="btn-${g.key}" data-grade="${g.key}"><span class="grade-key">${g.hotkey}</span>${g.label}<small id="due-${g.key}"></small></button>`).join('')}
      </div>
      <p class="muted hint">快速鍵：空白鍵＝翻面、1＝忘了、2＝勉強、3＝記得。日期為本機計算的下次複習時間；預覽不會寫入。</p>`;
  }
  return `<div class="controls grade-controls grade-2 hidden" id="grade-controls">
        <button class="btn" id="btn-again" data-grade="again">還不太會（明天再來）</button>
        <button class="btn primary" id="btn-good" data-grade="good">記住了</button>
      </div>
      <p class="muted hint">快速鍵：空白鍵＝翻面、1＝還不太會、2＝記住了</p>`;
}

async function formatDueAt(dueAt) {
  const t = new Date(dueAt).getTime();
  if (!Number.isFinite(t)) return '';
  const diff = t - Date.now();
  if (diff <= 0) return '現在';
  const minutes = Math.max(1, Math.round(diff / 60000));
  if (minutes < 60) return `${minutes} 分鐘後`;
  const d = new Date(t);
  const today = new Date();
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return sameDay ? `今天 ${time}` : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

async function refreshFsrsDuePreview(active = daily) {
  const c = active?.cards?.[active.idx];
  if (!c || active.view !== 'session' || !isFsrsCard(c) || !c.flipped || active.saving) return;
  const box = containerEl?.querySelector('#fsrs-preview-box');
  if (!box) return;
  box.classList.remove('hidden');
  box.textContent = '正在計算下次複習時間…';
  const token = reviewSessionToken();
  const previewId = ++c.fsrsPreviewId;
  // 非同步預覽的舊結果不得覆蓋新卡片／新頁面／新帳戶／新日期。
  const stillCurrent = () => daily === active
    && active.view === 'session'
    && active.cards[active.idx] === c
    && c.flipped
    && !active.saving
    && c.fsrsPreviewId === previewId
    && !!containerEl?.isConnected
    && (!active.taskContext || localDateKey() === active.taskContext.localDate)
    && reviewSessionToken().wordId === token.wordId
    && reviewSessionToken().ownerId === token.ownerId
    && reviewSessionToken().authGeneration === token.authGeneration;
  try {
    const preview = await previewReview(c.word.id, Date.now());
    if (!stillCurrent()) return;
    if (preview?.engine !== 'fsrs6') {
      box.textContent = '下次複習時間暫時無法預覽，仍可評分。';
      return;
    }
    const parts = [];
    for (const g of REVIEW_GRADES) {
      if (!stillCurrent()) return;
      const label = preview?.[g.key]?.dueAt ? await formatDueAt(preview[g.key].dueAt) : '';
      if (!stillCurrent()) return;
      parts.push(`${g.label}${label ? `：${label}` : ''}`);
      const hint = containerEl?.querySelector(`#due-${g.key}`);
      if (hint && label) hint.textContent = label;
    }
    if (!stillCurrent()) return;
    box.textContent = `下次複習：${parts.join('／')}`;
  } catch {
    if (stillCurrent()) box.textContent = '下次複習時間暫時無法預覽，仍可評分。';
  }
}

function renderReviewSession() {
  const c = daily.cards[daily.idx];
  c.side = rollFace(); // 3.0.0：預設顯示面依設置（英文/中文/隨機）
  c.flipped = false;
  c.flipping = false;
  c.fsrsPreviewId = (c.fsrsPreviewId || 0) + 1;
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
      ${gradeControlsFor(c)}
      <p class="muted hint fsrs-due hidden" id="fsrs-preview-box">計算中…</p>
      <button class="btn subtle" id="btn-stop">暫停（下次繼續）</button></div>`));

  containerEl.querySelector('#btn-flip').addEventListener('click', flip);
  containerEl.querySelector('#r-card').addEventListener('click', (e) => {
    if (e.target.closest('.speak-btn')) return; // 發音鈕不翻面
    flip();
  });
  containerEl.querySelectorAll('#grade-controls [data-grade]').forEach((b) => {
    b.addEventListener('click', () => grade(b.dataset.grade));
  });
  containerEl.querySelector('#btn-stop').addEventListener('click', () => {
    const task=daily?.taskContext;daily = null;
    if(task){location.hash='#/daily-tasks';task.onStop?.();return;}
    renderDailyTask(containerEl, calContainerEl);
  });
}

function flip() {
  if (!daily || daily.view !== 'session' || !containerEl) return;
  const active = daily;
  const c = active.cards[active.idx];
  const cardEl = containerEl.querySelector('#r-card');
  if (!c || !cardEl || c.flipped || c.flipping) return;
  c.flipping = true;
  const applyMid = () => {
    if (daily !== active || active.view !== 'session' || active.cards[active.idx] !== c) return;
    const wordEl = containerEl?.querySelector('#r-word');
    if (!wordEl || !containerEl.contains(cardEl)) return;
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
    if (active.taskContext) c.meaningSeen = true;
    c.flipped = true;
    c.flipping = false;
    containerEl.querySelector('#r-hint').textContent = '';
    containerEl.querySelector('#grade-controls')?.classList.remove('hidden');
    containerEl.querySelector('#btn-flip')?.classList.add('hidden');
    // 翻面完成後才做純讀取預覽；結果不寫入、不影響評分。
    void refreshFsrsDuePreview(active);
  };
  cardEl.classList.remove('flipping');
  void cardEl.offsetWidth;
  if (active.taskContext) {
    // 任務翻面先同步換內容；離頁後不留下會改寫其他頁面的計時器。
    applyMid();cardEl.classList.add('flipping');
  } else if (getAnim() === 'flip') {
    // 立體翻轉：翻到 90° 時換內容
    cardEl.classList.add('flipping');
    setTimeout(applyMid, 110);
    setTimeout(() => { if (!containerEl?.contains(cardEl)) return; cardEl.classList.remove('flipping'); }, 260);
  } else {
    // 輕柔淡入／彈性活潑：直接換內容
    applyMid();
    cardEl.classList.add('flipping');
    cardEl.addEventListener('animationend', () => cardEl.classList.remove('flipping'), { once: true });
  }
}

async function grade(action) {
  if (!daily || daily.view !== 'session' || daily.saving) return;
  const pageGuard = daily._owner || capturePage();
  if (!pageGuard.active()) return; // 換帳戶後已失效；不清舊卡、不寫新帳戶
  const c = daily.cards[daily.idx];
  if (!c) return;
  const fsrsCard = isFsrsCard(c);
  // 固定卡沿用原 boolean 評分；只有 FSRS 卡送 again／hard／good。
  if (!fsrsCard && typeof action === 'string') action = action === 'good';
  const remembered = action === 'hard' || action === 'good' || action === true;
  if (daily.taskContext && (getUser()?.id !== daily.taskContext.ownerId || getAuthGeneration()!==daily.taskContext.authGeneration || !c.meaningSeen)) return;
  if (!c.flipped) return; // 1/2/3 與點按都必須先翻面
  const active = daily;
  active.saving = true;
  setGradeBusy(true);
  let result;
  try {
    const assertActive=()=>{
      const ctx=active.taskContext;
      if(daily!==active || getUser()?.id!==ctx.ownerId || getAuthGeneration()!==ctx.authGeneration)throw new Error('ACCOUNT_CHANGED');
      if(localDateKey()!==ctx.localDate)throw new Error('DAY_CHANGED');
    };
    result = active.taskContext
      ? await gradeTaskReview(c.word.id, action ?? remembered, {...active.taskContext, assertActive})
      : await gradeReview(c.word.id, action ?? remembered, { owner: pageGuard });
    if(active.taskContext) {
      assertActive();
      if(!result)throw new Error('這個字的複習排程已不存在，請回每日任務重新整理。');
      const ctx=active.taskContext;
      await completeTaskWord(ctx.ownerId,ctx.localDate,c.word.id,'review');
      if(daily!==active || getUser()?.id!==ctx.ownerId)return;
    }
  } catch(err) {
    if(!active.taskContext) {
      if (err?.code === 'ACCOUNT_CHANGED' || /ACCOUNT_CHANGED/.test(String(err.message))) return; // 已失效：不回報舊畫面
      throw err;
    }
    const hint=containerEl?.querySelector('#r-hint');if(hint)hint.textContent='尚未保存完成：'+err.message;
    return;
  } finally {
    active.saving=false;
    if (daily === active && active.cards[active.idx] === c) setGradeBusy(false);
  }
  if (daily !== active || !pageGuard.active()) return; // 保存期間已離開／換帳戶：晚到結果不得改寫新頁面
  if(!active.taskContext)addEvent('review', c.word.id, remembered, { owner: pageGuard }); // 統計（2.0.13 起）
  if (isFsrsCard(c)) {
    const key = action === 'again' || action === 'hard' || action === 'good' ? action : (remembered ? 'good' : 'again');
    if (!active.done.fsrs) active.done.fsrs = { again: 0, hard: 0, good: 0 };
    active.done.fsrs[key] = (active.done.fsrs[key] || 0) + 1;
  } else if (result?.graduated) active.done.graduated.push(c.word);
  else if (remembered) active.done.advanced++;
  else active.done.again++;

  active.idx++;
  if (active.idx >= active.cards.length) {
    active.view = 'result';
    renderResult();
  } else {
    renderReviewSession();
  }
}

function setGradeBusy(busy) {
  const controls = containerEl?.querySelector('#grade-controls');
  if (!controls) return;
  controls.querySelectorAll('button').forEach((b) => { b.disabled = !!busy; });
}

// ---------- 結算 ----------
function renderResult() {
  if(daily?.taskContext){
    const active=daily;
    containerEl.replaceChildren(el('<section class="card"><h2>這批複習已完成</h2><p>已保存到今日任務。</p><button class="btn primary" id="task-review-done">回每日任務</button></section>'));
    containerEl.querySelector('#task-review-done').onclick=()=>{daily=null;active.taskContext.onStop?.();};
    return;
  }
  const done = daily.done;
  const gradList = done.graduated.map((w) => `<span class="chip">${escapeHtml(w.word)}</span>`).join(' ');
  const fsrs = done.fsrs || { again: 0, hard: 0, good: 0 };
  const fixedTotal = done.graduated.length + done.advanced + done.again;
  const fsrsTotal = fsrs.again + fsrs.hard + fsrs.good;
  const total = fixedTotal + fsrsTotal;
  // 固定排程保留原文案；FSRS 不誤稱「第四次畢業」或 Again「明天再來」。
  const fixedLine = fixedTotal
    ? `進入下一階段 ${done.advanced} 字 · 明天再來 ${done.again} 字 · 畢業 ${done.graduated.length} 字`
    : '';
  const fsrsLine = fsrsTotal
    ? `FSRS 已更新排程：忘了 ${fsrs.again} 字 · 勉強 ${fsrs.hard} 字 · 記得 ${fsrs.good} 字（下次複習時間見翻面後的預覽）`
    : '';
  containerEl.replaceChildren(el(`<div>
      <h2>複習</h2>
      <div class="finish">
        複習完成（共 ${total} 字）：<br>
        ${[fixedLine, fsrsLine].filter(Boolean).join('<br>')}
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
  const card = daily.cards[daily.idx];
  const fsrs = isFsrsCard(card);
  if (e.key === ' ') {
    if (e.target.tagName === 'BUTTON') return;
    e.preventDefault();
    flip();
  } else if (e.key === '1') {
    grade(fsrs ? 'again' : false);
  } else if (e.key === '2') {
    grade(fsrs ? 'hard' : true);
  } else if (e.key === '3' && fsrs) {
    grade('good'); // 固定卡只保留原兩鍵，3 不提交
  }
});

// ============================================================
// 頁面：複習（2.1.2）——排程批量調整
// 月曆選日期 → 清單列出該日單字，可改日期／排序／移除
// 【4.0.0】底部新增「不會單字」管理區（自單詞本頁移入，間距縮短）
// ============================================================
let mgmtDate = null;  // 選中的日期（YYYY-MM-DD）

// 不會單字：下次複習的顯示文字（與原單詞本頁相同）
const dueText = (m) => {
  const dueMs = new Date(m.dueAt).getTime() - Date.now();
  if (dueMs <= 0) return '<span class="due-today">今日複習</span>';
  // FSRS 的間隔可能只有幾分鐘／幾小時，不把「1 天後」硬套到所有卡。
  if (m.engine === 'fsrs6' && dueMs < 3600000) return `${Math.max(1, Math.ceil(dueMs / 60000))} 分鐘後`;
  if (m.engine === 'fsrs6' && dueMs < 86400000) return `${Math.ceil(dueMs / 3600000)} 小時後`;
  return `${Math.ceil(dueMs / 86400000)} 天後`;
};

export async function renderReviewManage(main) {
  await loadWords();
  if (!mgmtDate) mgmtDate = todayKey();

  const wordsById = new Map(getWords().map((w) => [w.id, w]));
  const { due, upcoming } = await getSrsQueues();
  const todayK = todayKey();

  // 依日期分組（已過期一律算今天）
  const perDay = new Map();
  const addDay = (m) => {
    const w = wordsById.get(m.wordId);
    if (!w) return;
    const d = new Date(m.dueAt);
    const k = d.getTime() <= Date.now() ? todayK : dateKey(d);
    if (!perDay.has(k)) perDay.set(k, []);
    perDay.get(k).push({ word: w, mark: m });
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
    // FSRS 卡片沒有固定「第 N／4 階」的畢業概念，不得顯示成固定階段。
    const stageText = m.engine === 'fsrs6' ? 'FSRS 排程' : `第 ${(Number.isInteger(m.stage) ? m.stage : 0) + 1} / ${stageCount} 階`;
    return `
      <tr>
        <td>Lv${w.level}</td>
        <td class="td-word">${escapeHtml(w.word)}</td>
        <td>${escapeHtml(w.pos)}</td>
        <td>${stageText}</td>
        <td>${dueText(m)}</td>
        <td><button class="btn subtle btn-remove" data-id="${w.id}" data-word="${escapeHtml(w.word)}">移除</button></td>
      </tr>`;
  }).join('');

  main.replaceChildren(el(`
    <div class="review-layout">
      <section class="card review-main-card">
        <div id="review-daily-card"></div>
        <div id="review-cal-card"></div>
        <p class="muted small note-below">點日期，左側調整該日單字；改日期、移除立即生效。</p>
      </section>
      <section class="card list-card-wrap">
        <div class="review-day-title">${escapeHtml(label)}要複習的單字（${listWords.length}）</div>
        ${listWords.length ? `<div class="bulk-move">
            <input type="date" id="bulk-date" title="一鍵移動目標日期">
            <button class="btn primary" id="btn-bulk-move">一鍵移動全部</button>
          </div>` : ''}
        ${listWords.length ? rows : '<p class="mgmt-empty">這天沒有排程。點右側月曆選擇其他日期。</p>'}
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

  // 這一頁只掛一顆月曆（#review-cal-card）。原本舊管理區的 #mg-cal 已移除，
  // 日期選取改由此頁注入的 manageSelect 回呼更新左側清單，功能與原文字都保留。
  manageSelect = (key) => {
    if (key === mgmtDate) return;
    mgmtDate = key;
    renderReviewManage(main);
  };
  await renderDailyTask(main.querySelector('#review-daily-card'), main.querySelector('#review-cal-card'));

  // ---- 單字列事件 ----
  const pageGuard = capturePage();
  main.querySelectorAll('.mgmt-row input[type="date"]').forEach((inp) => {
    inp.addEventListener('change', async () => {
      if (!inp.value || !pageGuard.active()) return;
      await updateMarkDue(Number(inp.dataset.wid), inp.value, { owner: pageGuard });
      if (pageGuard.active()) renderReviewManage(main);
    });
  });
  main.querySelectorAll('.mgmt-row .btn').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!pageGuard.active()) return;
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
      if (!ok || !pageGuard.active()) return;
      try {
        await unmarkUnknown(wid, { owner: pageGuard });
      } catch (err) {
        if (err?.code === 'ACCOUNT_CHANGED' || /ACCOUNT_CHANGED/.test(String(err.message))) return;
        throw err;
      }
      if (!pageGuard.active()) return;
      toast(`已把「${w.word}」移出複習計劃`, 'ok');
      renderReviewManage(main);
    });
  });

  // ---- 一鍵移動（4.0.4）：該日全部單字移到指定日期 ----
  main.querySelector('#btn-bulk-move')?.addEventListener('click', async () => {
    if (!pageGuard.active()) return;
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
    if (!ok || !pageGuard.active()) return;
    for (const x of listWords) {
      if (!pageGuard.active()) return;
      await updateMarkDue(x.word.id, v, { owner: pageGuard });
    }
    if (!pageGuard.active()) return;
    toast(`已把 ${listWords.length} 個單字移到 ${v}`, 'ok');
    renderReviewManage(main);
  });

  // ---- 不會單字事件（4.0.0） ----
  main.querySelectorAll('.unknown-card .btn-remove').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!pageGuard.active()) return;
      // 4.3.0 修復（Pool A Medium）：與排程列的移除一致——openDialog 確認（danger）
      const ok = await openDialog({
        title: '移出複習計劃',
        body: `把「${b.dataset.word || b.dataset.id}」移出複習計劃？單字仍留在字庫。`,
        danger: true,
        okText: '移除',
      });
      if (!ok || !pageGuard.active()) return;
      try {
        await unmarkUnknown(Number(b.dataset.id), { owner: pageGuard });
      } catch (err) {
        if (err?.code === 'ACCOUNT_CHANGED' || /ACCOUNT_CHANGED/.test(String(err.message))) return;
        throw err;
      }
      if (!pageGuard.active()) return;
      toast('已移出複習計劃', 'ok');
      renderReviewManage(main);
    });
  });
  main.querySelector('#btn-clear-unknown')?.addEventListener('click', async () => {
    if (!pageGuard.active()) return;
    // 4.2.0：confirm → openDialog（清除全部標記＝最高級破壞性，danger）
    const ok = await openDialog({
      title: '清除全部標記',
      body: `確定要清除全部 ${marks.length} 個「不會」標記嗎？清除後所有單字都要重新排程，此操作不可復原。`,
      danger: true,
      okText: '全部清除',
      cancelText: '取消',
    });
    if (!ok || !pageGuard.active()) return;
    try {
      await clearUnknown({ owner: pageGuard });
    } catch (err) {
      if (err?.code === 'ACCOUNT_CHANGED' || /ACCOUNT_CHANGED/.test(String(err.message))) return;
      throw err;
    }
    if (!pageGuard.active()) return;
    toast(`已清除 ${marks.length} 個「不會」標記`, 'ok');
    renderReviewManage(main);
  });
}

// 6.0.0：以已凍結的每日任務範圍啟動同一套 SRS 評分，不重新抓全體到期字。
// 6.1.1：卡片引擎必須取自該字的真標記（engine），不能在這裡用全域開關猜。
export function startTaskReview(words, taskContext, main) {
  if(getUser()?.id!==taskContext?.ownerId)throw new Error('ACCOUNT_CHANGED');
  if(taskContext.localDate!==localDateKey())throw new Error('DAY_CHANGED');
  taskContext={...taskContext,authGeneration:getAuthGeneration()};
  containerEl=main;calContainerEl=null;
  if(!words.length){daily={view:'session',cards:[],idx:0,done:emptyDone(),taskContext};main.textContent='這批複習已完成。';return;}
  const active={view:'session',cards:[],idx:0,done:emptyDone(),taskContext,loading:true};
  daily=active;
  main.replaceChildren(el('<section class="card"><p class="muted" role="status">正在準備複習卡…</p></section>'));
  const generation=taskContext.authGeneration, ownerId=taskContext.ownerId, localDate=taskContext.localDate;
  getUnknownMarks().then((marks)=>{
    if(daily!==active)return;
    if(getAuthGeneration()!==generation || getUser()?.id!==ownerId){daily=null;main.textContent='帳戶已變更，請重新開啟每日任務。';return;}
    if(localDateKey()!==localDate){daily=null;main.textContent='日期已變更，請重新整理每日任務。';return;}
    const byId=new Map(marks.map(m=>[String(m.wordId),m]));
    active.cards=words.map(word=>({word,mark:byId.get(String(word.id))||null,side:'en',meaningSeen:false}));
    active.loading=false;
    renderReviewSession();
  }).catch(()=>{
    if(daily!==active)return;
    daily=null;
    main.replaceChildren(el('<section class="card"><p>暫時無法讀取複習排程，請回每日任務重新整理。</p></section>'));
  });
}
export function stopTaskReview(){if(daily?.taskContext)daily=null;}
on('auth:changed',()=>{if(daily?.taskContext){daily=null;if(containerEl)containerEl.textContent='帳戶已變更，請重新開啟每日任務。';}});
