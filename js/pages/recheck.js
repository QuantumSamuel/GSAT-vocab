// ============================================================
// 6.0.2 短複測頁（pages/recheck.js）
//
// 從每日任務當日字取最多輕量 3／標準 5／加強 8 字，做短複測：
//   ① 中文意思 → 輸入英文（無提示回想；trim＋大小寫正規化）
//   ② 答不出 → 揭示英文 → 四張中文選項卡辨認（只保留練習，不計達標證據）
// 全程沿用既有卡片樣式（spell-board／match-grid／match-card），不加新 icon。
//
// 【6.0.2 真 UI 修正】每次 recall／recognition／reveal「一律採用服務回傳的最新
//   session／plan 再重畫」，不得沿用 UI 端舊快照；每次 await 後都要重驗
//   owner／世代／路由／日期 guard；忙碌時鎖住真正的 body input 與卡片／controls，
//   並防重入；錯誤／abort 不假裝前進，保留原選擇可重試。
//
// 【界線】不改 SRS／marks／dueAt；不完成原學習／複習任務；不新增今日任務字數。
//   UI 只是操作既有 API（services/recheck-session.js）；候選狀態只顯示「短複測達標候選」。
// ============================================================
import { el, escapeHtml } from '../core/ui.js';
import { routeGuard } from '../core/router.js';
import { getUser, getAuthGeneration } from '../services/auth.js';
import { getDailyPlan } from '../services/daily-tasks.js';
import { loadWords } from '../services/vocab.js';
import {
  getRecheckSession, submitRecheckRecall, revealRecheck, submitRecheckRecognition, submitRecheckBatch,
} from '../services/recheck-session.js';
import { buildRecognitionOptions, safeRecallPrompt, recheckCap } from '../core/recheck-session.js';
import { proGateStatus } from '../services/pro-gate.js';
import { proStatus } from '../services/pro-api.js';
import { mountProGateCard } from '../services/pro-gate-dom.js';
import { listRecheckStatuses } from '../services/recheck-service.js';
import { shuffle } from '../practice/shell.js';
import { on } from '../core/eventbus.js';
import { localDateKey } from '../core/daily-plan.js';

const NEUTRAL_PROMPT = '請依中文意思拼出這個單字';

let controller = null, unsubscribe = null, epoch = 0;

export function onLeave() {
  epoch++;
  controller?.abort();
  controller = null;
  unsubscribe?.();
  unsubscribe = null;
}

export function renderRecheck(main) {
  return mount(main);
}

async function mount(main) {
  onLeave();
  const generation = epoch;
  controller = new AbortController();
  const stillOn = routeGuard();
  const authGeneration = getAuthGeneration();
  const alive = () => generation === epoch && getAuthGeneration() === authGeneration && stillOn();
  // 6.3.0 Pro 閘：短複測屬 8 項 Pro；無有效 Pro →「正在開發中」。
  const gate = await proGateStatus('short_recheck', proStatus);
  if (!alive()) return;
  if (gate.state !== 'available') {
    mountProGateCard(main, 'short_recheck', () => renderRecheck(main), '短複測屬 Pro 功能；無有效 Pro 時此頁顯示「正在開發中」。');
    return;
  }
  main.replaceChildren(el('<section class="card"><h2>短複測</h2><p role="status">正在準備當日短複測…</p></section>'));
  unsubscribe = on('auth:changed', () => {
    const wasCurrent = stillOn();
    onLeave();
    if (wasCurrent) {
      main.replaceChildren(el('<section class="card"><p>帳戶已變更，請重新開啟短複測。</p><button type="button" class="btn">重新開啟</button></section>'));
      main.querySelector('button').onclick = () => mount(main);
    }
  });
  try {
    const { attempt, plan } = await getDailyPlan({ signal: controller.signal });
    if (!alive()) return;
    const words = await loadWords();
    if (!alive()) return;
    const byId = new Map(words.map((w) => [String(w.id), w]));
    const { session } = await getRecheckSession(plan.ownerId, plan.localDate, { plan, load: plan.load });
    if (!alive()) return;
    paint({ attempt, plan, session, byId, allWords: words });
  } catch (err) {
    if (!alive()) return;
    const needsLogin = /UNAUTHENTICATED/.test(err.message);
    const needsDiagnosis = /NOT_COMPLETED/.test(err.message);
    main.replaceChildren(el(`<section class="card"><h2>短複測</h2><p role="status">${
      needsLogin ? '登入並完成一次詞彙診斷後即可使用短複測。'
      : needsDiagnosis ? '請先完成詞彙診斷，短複測會從當日任務字取樣。'
      : '暫時無法準備短複測：' + escapeHtml(err.message)
    }</p><a class="btn primary" href="${needsLogin ? '#/auth?tab=login' : needsDiagnosis ? '#/diagnostic' : '#/daily-tasks'}">${needsLogin ? '登入' : needsDiagnosis ? '開始／繼續診斷' : '回每日任務'}</a></section>`));
  }

  function paint({ attempt, plan, session, byId, allWords }) {
    if (!alive()) return;
    const cap = recheckCap(plan.load);
    const wordIds = (session.wordIds || []).map(String);
    const words = wordIds.map((id) => byId.get(id)).filter(Boolean);
    const answeredCount = wordIds.filter((id) => session.progress?.[id]?.answered).length;
    const submitted = session.submitted === true;
    const headerTop = `
      <p class="muted small">${escapeHtml(plan.localDate)} · 當日任務字短複測</p>
      <h2>短複測</h2>
      <p class="muted small">中文意思 → 輸入英文（無提示回想）；答不出可轉英文，從四張中文卡辨認；提示後的辨認只保留練習紀錄，不計達標候選證據。不改動到期複習與每日字數。</p>
      <p role="status" id="rc-message"></p>
      <p id="rc-stats">已作答 <strong>${answeredCount}</strong>／${wordIds.length} 字（上限 ${cap} 字）</p>`;
    const header = headerTop;
    if (!words.length) {
      main.replaceChildren(el(`<section class="card">${header}<p class="muted">今日任務字為空或都已複測完成，暫無可短複測的字。</p><a class="btn" href="#/daily-tasks">回每日任務</a></section>`));
      return;
    }
    if (submitted) {
      renderResult({ main, plan, session, header, words, alive });
      return;
    }
    renderWorksheet({ main, plan, session, header, words, alive, allWords });
  }
}

// 只讀既有批次所對應的「當日任務字」是否已完成（不新增今日字數）。
function renderWorksheet({ main, plan, session, header, words, alive, allWords }) {
  const ownerId = plan.ownerId, localDate = plan.localDate;
  // state.session 一律代表「服務回傳的最新批次」；每次操作後就地更新，畫面據此重畫。
  const state = { session, busy: false };
  const cap = recheckCap(plan.load);

  const guardAfterAwait = () => {
    if (!alive()) return false;
    if (getUser()?.id !== ownerId) return false;
    if (localDateKey() !== localDate) return false;
    return true;
  };

  // 「已收尾」＝回想答對、或已完成辨認。回想答錯但尚未辨認者仍算未收尾（需續作辨認），
  // 否則重開頁會把「回想答錯、待辨認」的字誤判為已完成而跳過。
  const isResolved = (p) => p?.recallCorrect === true || p?.recognitionAnswered === true;
  const firstUnansweredIdx = () => {
    const progress = state.session.progress || {};
    const wordIds = state.session.wordIds.map(String);
    const firstUnanswered = wordIds.find((id) => !isResolved(progress[id]));
    let i = firstUnanswered ? words.findIndex((w) => String(w.id) === firstUnanswered) : 0;
    return i < 0 ? 0 : i;
  };
  let idx = firstUnansweredIdx();

  // 以最新 session 重建 header 的「已作答／總數」列（服務回傳後即時反映）。
  const refreshHeaderStats = () => {
    const wordIds = state.session.wordIds.map(String);
    const answered = wordIds.filter((id) => state.session.progress?.[id]?.answered).length;
    const stats = main.querySelector('#rc-stats');
    if (stats) stats.innerHTML = `已作答 <strong>${answered}</strong>／${wordIds.length} 字（上限 ${cap} 字）`;
  };

  const paintCard = () => {
    if (!alive()) return;
    // 每次重畫都重建全新可用的 controls，前一次操作的忙碌鎖在此解除（否則
    // 「我不知道」→ 揭示 → onDone 重畫後 state.busy 仍為 true，辨認卡永遠按不動）。
    state.busy = false;
    const progress = state.session.progress || {};
    const word = words[idx];
    if (!word) return;
    const wid = String(word.id);
    const p = progress[wid] || {};
    const answered = p.answered === true;
    const phase = p.phase || 'recall';
    const reveal = p.revealedEnglish === true;
    const card = el(`
      <section class="card">
        ${header}
        <div class="spell-board spell-board--blind">
          <p class="spell-zh-line zh-prompt" id="rc-prompt">${escapeHtml(safeRecallPrompt(word.senses, { answer: word.word }))}</p>
          <div id="rc-body"></div>
        </div>
        <div class="controls" id="rc-controls"></div>
      </section>`);
    main.replaceChildren(card);
    refreshHeaderStats();
    const msg = main.querySelector('#rc-message');
    msg.textContent = `第 ${idx + 1} / ${words.length} 字`;
    const body = main.querySelector('#rc-body');
    const controls = main.querySelector('#rc-controls');
    // 忙碌鎖：鎖住真正的 body 內 input 與卡片按鈕，以及下方 controls。
    const setBusy = (v) => {
      state.busy = v;
      main.querySelectorAll('#rc-body input, #rc-body button, #rc-controls button').forEach((x) => { x.disabled = v; });
    };

    // 回想答錯＝已作答（answered=true）但仍停在辨認階段、尚未辨認：此時不得被 answered
    // 攔成唯讀結果，必須續呈現正確英文＋四卡辨認（回想錯誤證據保留、recallCorrect 不得被洗）。
    const pendingRecognition = !p.recognitionAnswered && (phase === 'recognition' || reveal);
    if (answered && !pendingRecognition) {
      // 已作答且已收尾：顯示結果（唯讀），提供上／下一字與提交
      const bits = [];
      if (p.recallSubmitted) bits.push(`回想${p.recallCorrect ? '正確' : '未正確'}（有回想證據）`);
      if (p.recognitionAnswered) bits.push(`提示後辨認${p.recognitionCorrect ? '正確' : '未正確'}（只算練習）`);
      const evidence = bits.length ? bits.join('；') : '已作答';
      body.appendChild(el(`<p class="tp-caption" id="rc-done">此字已作答：${evidence}。</p>`));
      navButtons({ controls, idx, words, onGo: (n) => { idx = n; paintCard(); }, onSubmit: () => submitAll() });
      return;
    }

    if (phase === 'recognition' || reveal) {
      // 辨認：揭示英文＋四張中文選項卡（干擾池＝完整詞庫，不以 batch 少數字當池）
      const options = buildRecognitionOptions(word, allWords && allWords.length ? allWords : words, { count: 4 });
      // 防 fallback 白送：正解不得等於中性填空（無真中文意思時不假送答案），且需有可控干擾。
      const usable = options.length >= 2
        && options[0].correct === true
        && options[0].text !== NEUTRAL_PROMPT;
      if (!usable) {
        body.appendChild(el('<p class="tp-caption" id="rc-nocards">此字暫無足夠中文選項可作辨認，請改用其他方式完成或稍後重試。</p>'));
        addUnknownOnly({ controls, word });
        navButtons({ controls, idx, words, allowNoAnswer: true, onGo: (n) => { idx = n; paintCard(); }, onSubmit: () => submitAll() });
        return;
      }
      // 回想答錯才進到這裡：明確告知「回想未正確、接下來只練習」，且本場不重答回想、原錯誤保留。
      const recallWrong = p.recallSubmitted === true && p.recallCorrect === false;
      const shuffled = shuffle(options);
      body.appendChild(el(`${recallWrong ? '<p class="tp-caption" id="rc-recog-note">回想未正確，接下來只練習；本場不重答回想，原錯誤會保留。</p>' : ''}
        <p class="spell-zh-line" id="rc-word">${escapeHtml(word.word)}<span class="tp-caption">（已揭示英文，本場不再算無提示回想）</span></p>
        <div class="match-grid g4" id="rc-grid">
          ${shuffled.map((o, i) => `<button class="match-card" data-i="${i}">${escapeHtml(o.text)}</button>`).join('')}
        </div>`));
      const grid = main.querySelector('#rc-grid');
      grid.querySelectorAll('.match-card').forEach((c) => c.addEventListener('click', async () => {
        if (state.busy) return;
        const opt = shuffled[Number(c.dataset.i)];
        setBusy(true);
        c.classList.add(opt.correct ? 'f-correct' : 'f-wrong');
        try {
          const next = await submitRecheckRecognition(ownerId, localDate, word.id, { correct: opt.correct === true });
          if (!guardAfterAwait()) return;
          state.session = next;                 // 採服務回傳最新 session
          grid.querySelectorAll('.match-card').forEach((x) => { x.disabled = true; });
          const m = main.querySelector('#rc-message');
          if (m) m.textContent = opt.correct ? '辨認正確。' : '辨認未正確。';
          paintCard();                          // 依服務回傳進度重畫
        } catch (err) {
          if (!alive()) return;
          setBusy(false);
          c.classList.remove('f-correct', 'f-wrong'); // 失敗不前進：清掉暫態標記，保留選項可重試
          const m = main.querySelector('#rc-message');
          if (m) m.textContent = '未能保存作答，請重試：' + err.message;
        }
      }));
      addUnknownButton({ controls, word, progress: state.session.progress, onDone: paintCard, alive, guardAfterAwait, setBusy, state, ownerId, localDate });
      return;
    }

    // 回想：輸入英文（無提示）
    body.appendChild(el(`<input class="spell-input rc-input" id="rc-input" autocomplete="off" autocapitalize="off" spellcheck="false" inputmode="text" aria-label="輸入英文" placeholder="輸入英文單字">
      <p class="tp-caption">看中文意思輸入英文；答不出可按「我不知道」轉為辨認。</p>`));
    const input = main.querySelector('#rc-input');
    input.focus();
    const recallBtn = document.createElement('button');
    recallBtn.className = 'btn primary';
    recallBtn.textContent = '提交回想';
    recallBtn.addEventListener('click', async () => {
      if (state.busy) return;
      setBusy(true);
      try {
        const next = await submitRecheckRecall(ownerId, localDate, word.id, input.value, { answer: word.word });
        if (!guardAfterAwait()) return;
        state.session = next;                   // 採服務回傳最新 session 再畫
        paintCard();
      } catch (err) {
        if (!alive()) return;
        setBusy(false);
        const m = main.querySelector('#rc-message');
        if (m) m.textContent = '未能保存作答，請重試：' + err.message;
      }
    });
    controls.appendChild(recallBtn);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); recallBtn.click(); } });
    addUnknownButton({ controls, word, progress: state.session.progress, onDone: paintCard, alive, guardAfterAwait, setBusy, state, ownerId, localDate });
    navButtons({ controls, idx, words, allowNoAnswer: true, onGo: (n) => { idx = n; paintCard(); }, onSubmit: () => submitAll() });
  };

  // 提交整批：一律採用服務回傳的 session／plan（資料層真回應），不用 UI 舊 session 取代。
  async function submitAll() {
    if (state.busy) return;
    state.busy = true;
    main.querySelectorAll('#rc-body input, #rc-body button, #rc-controls button').forEach((x) => { x.disabled = true; });
    const msg = main.querySelector('#rc-message');
    try {
      const { plan: nextPlan, session: next } = await submitRecheckBatch(ownerId, localDate);
      if (!alive()) return;
      renderResult({ main, plan: nextPlan, session: next, header, words, alive });
    } catch (err) {
      if (!alive()) return;
      state.busy = false;
      main.querySelectorAll('#rc-body input, #rc-body button, #rc-controls button').forEach((x) => { x.disabled = false; });
      if (msg) msg.textContent = '未能提交短複測，請重試：' + err.message;
    }
  }

  function addUnknownOnly({ controls, word }) {
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = '我不知道';
    b.addEventListener('click', () => {
      const m = main.querySelector('#rc-message');
      if (m) m.textContent = '此字暫無可用選項，請先回報或稍後重試。';
    });
    controls.appendChild(b);
  }

  function addUnknownButton({ controls, word, onDone, alive, guardAfterAwait, setBusy, state, ownerId, localDate }) {
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = '我不知道';
    b.addEventListener('click', async () => {
      if (state.busy) return;
      setBusy(true);
      try {
        const next = await revealRecheck(ownerId, localDate, word.id);
        if (!guardAfterAwait()) return;
        state.session = next;                  // 採服務回傳最新 session
        onDone();
      } catch (err) {
        if (!alive()) return;
        setBusy(false);
        const m = main.querySelector('#rc-message');
        if (m) m.textContent = '未能切換題型，請重試：' + err.message;
      }
    });
    controls.appendChild(b);
  }

  paintCard();
}

function navButtons({ controls, idx, words, onGo, onSubmit, allowNoAnswer }) {
  const prev = document.createElement('button');
  prev.className = 'btn';
  prev.textContent = '上一個';
  prev.disabled = idx <= 0;
  prev.addEventListener('click', () => onGo(idx - 1));
  const next = document.createElement('button');
  next.className = 'btn';
  next.textContent = '下一個';
  next.disabled = idx >= words.length - 1;
  next.addEventListener('click', () => onGo(idx + 1));
  const submit = document.createElement('button');
  submit.className = 'btn primary';
  submit.textContent = '提交短複測';
  submit.addEventListener('click', () => onSubmit());
  controls.append(prev, next, submit);
}

async function renderResult({ main, plan, session, header, words, alive }) {
  const candidateIds = words.map((w) => String(w.id));
  let statuses = new Map();
  try { statuses = await listRecheckStatuses(plan.ownerId, candidateIds); }
  catch { /* 只讀狀態失敗不影響結果頁 */ }
  if (!alive()) return;
  // 以資料層真正回應顯示逐字結果，而非 UI 舊快照。
  const progress = session.progress || {};
  const answered = candidateIds.filter((id) => progress[id]?.answered).length;
  const candidates = candidateIds.filter((id) => statuses.get(id)?.status === 'mastered_candidate');
  const statusLine = candidates.length
    ? `短複測達標候選：${candidates.length} 字（僅標示候選，不代表 SRS 畢業）。`
    : '本批尚無「短複測達標候選」。';
  main.replaceChildren(el(`<section class="card">
    ${header}
    <p class="finish">短複測已提交並鎖定，證據已保存（本批作答 ${answered}／${candidateIds.length} 字）。</p>
    <p role="status" id="rc-candidate">${escapeHtml(statusLine)}</p>
    <p class="muted small">短複測不會自動完成原本的學習／複習任務，也不改動到期日。</p>
    <div class="controls"><a class="btn primary" href="#/daily-tasks">回每日任務</a></div>
  </section>`));
  const stats = main.querySelector('#rc-stats');
  if (stats) stats.innerHTML = `已作答 <strong>${answered}</strong>／${candidateIds.length} 字`;
}
