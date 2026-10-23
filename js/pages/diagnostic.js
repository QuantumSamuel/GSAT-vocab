// 帳戶一次診斷：伺服器決定題目、進度與成績，本頁只管理操作及重試。
export function createDiagnosticPage({ api, store, auth }) {
  let main, attempt, ownerId, controller, unsubscribe, generation = 0;
  let selected = new Set(), unknown = false, pendingPayload = null, busy = false;
  let status = '', cacheWarning = '', draftTail = Promise.resolve(), draftTimer;
  const valid = (token) => token === generation && !controller?.signal.aborted && auth.getUser()?.id === ownerId;
  const node = (tag, props = {}, text) => {
    const n = main.ownerDocument.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'className') n.className = value;
      else if (key === 'disabled') n.disabled = value;
      else n.setAttribute(key, value);
    }
    if (text !== undefined) n.textContent = String(text);
    return n;
  };
  const button = (text, attrs, click) => {
    const b = node('button', { type: 'button', className: 'btn', ...attrs }, text);
    b.addEventListener('click', click); return b;
  };
  function shell(title) {
    main.replaceChildren();
    const root = node('section', { className: 'diagnostic-page', 'aria-label': title });
    const heading = node('div', { className: 'diagnostic-heading' });
    heading.append(node('h1', {}, title), node('a', { href: '#/practice', className: 'btn' }, '返回練習'));
    root.append(heading); main.append(root); return root;
  }
  function message(text) {
    const root = shell('詞彙診斷'); root.append(node('p', { role: 'status' }, text));
    return root;
  }
  function showStatus(root) {
    root.append(node('p', { className: 'diagnostic-status', role: 'status', 'aria-live': 'polite' }, [status, cacheWarning].filter(Boolean).join(' ')));
  }
  const draftData = () => ({ questionId: attempt.currentQuestion.id, selectedOptionIds: [...selected], unknown, ...(pendingPayload ? { payload: pendingPayload } : {}) });
  function queueDraft(syncCloud = true) {
    const token = generation, current = attempt, draft = draftData(), account = ownerId;
    const work = draftTail.catch(() => {}).then(async () => {
      await store.saveDraft(account, current.attemptId, current.revision, draft);
      if (syncCloud && valid(token)) {
        await api.saveDiagnosticDraft({ attemptId: current.attemptId, expectedRevision: current.revision, ...draft }, { signal: controller.signal });
      }
    });
    draftTail = work;
    return work;
  }
  function selectionChanged() {
    status = '尚未提交'; draw(); clearTimeout(draftTimer);
    const token = generation;
    // 先保存在本機；雲端採串行去抖，避免較早選擇晚到覆寫較新選擇。
    queueDraft(false).catch(() => { if (valid(token)) { cacheWarning = '本機草稿保存失敗，請保持此頁開啟。'; draw(); } });
    draftTimer = setTimeout(() => {
      if (!valid(token) || busy || pendingPayload) return;
      queueDraft(true).catch(() => { if (valid(token)) { status = '選擇保留在本機；雲端草稿尚未同步。'; draw(); } });
    }, 150);
  }
  async function accept(next, token) {
    if (!valid(token)) return;
    if (!next || next.ownerId !== ownerId || !['in_progress', 'completed'].includes(next.status)) throw new Error('伺服器狀態不完整，請重試。');
    attempt = next; selected = new Set(); unknown = false; pendingPayload = null;
    status = ''; cacheWarning = '';
    // 雲端成功已經提交。快取故障不能把頁面留在已鎖定的舊題。
    try { await store.saveAttempt(ownerId, next); }
    catch { if (valid(token)) cacheWarning = '本機狀態保存失敗；雲端進度已確認，仍可繼續。'; }
    if (!valid(token)) return;
    if (next.status === 'in_progress' && next.currentQuestion) {
      let draft = next.draft;
      try {
        const cached = await store.getDraft(ownerId, next.attemptId);
        if (cached?.revision === next.revision) draft = cached.draft;
      } catch { cacheWarning = '本機草稿讀取失敗，請確認本題選擇。'; }
      if (!valid(token)) return;
      if (draft?.questionId === next.currentQuestion.id) {
        const ids = new Set(next.currentQuestion.options.map(o => o.id));
        selected = new Set((draft.selectedOptionIds || []).filter(id => ids.has(id)));
        unknown = Boolean(draft.unknown); if (unknown) selected.clear();
        const p = draft.payload;
        if (p?.requestId && p.attemptId === next.attemptId && p.expectedRevision === next.revision && p.questionId === next.currentQuestion.id) {
          pendingPayload = p; selected = new Set(p.selectedOptionIds || []); unknown = Boolean(p.unknown);
          status = '上次提交尚未確認；請重試確認同一筆答案。';
        }
      }
    }
    if (valid(token)) draw();
  }
  async function load() {
    const token = generation; busy = true; message('正在確認雲端診斷進度…');
    try {
      const next = await api.getOrStartDiagnostic({ signal: controller.signal });
      await accept(next, token);
    } catch (error) {
      if (valid(token)) {
        const root = message(`無法載入診斷：${error.message || error}。尚未完成的資格不會因此消耗。`);
        root.append(button('重新連線', {}, load));
      }
    } finally { if (valid(token)) { busy = false; if (attempt) draw(); } }
  }
  async function submit() {
    if (busy || (!pendingPayload && !unknown && !selected.size)) return;
    const token = generation; busy = true; clearTimeout(draftTimer);
    if (!pendingPayload) {
      pendingPayload = { attemptId: attempt.attemptId, expectedRevision: attempt.revision, questionId: attempt.currentQuestion.id, selectedOptionIds: [...selected], unknown, requestId: globalThis.crypto.randomUUID() };
    }
    status = '正在提交，等待雲端確認…'; draw();
    try {
      await queueDraft(false);
      if (!valid(token)) return;
      const next = await api.submitDiagnosticAnswer(pendingPayload, { signal: controller.signal });
      await accept(next, token);
    } catch (error) {
      if (!valid(token)) return;
      if (error.code === 'CONFLICT') {
        try {
          status = '進度已在其他裝置更新，正在讀取…'; draw();
          await accept(await api.getOrStartDiagnostic({ signal: controller.signal }), token);
        } catch (readError) { if (valid(token)) status = `未確認提交：${readError.message || readError}。請重試同一筆答案。`; }
      } else status = `未確認提交：${error.message || error}。選擇已鎖定，請重試同一筆答案。`;
    } finally { if (valid(token)) { busy = false; draw(); } }
  }
  function drawQuestion(root) {
    const q = attempt.currentQuestion;
    if (!q || !Array.isArray(q.options) || q.options.length !== 4) { root.append(node('p', { role: 'alert' }, '題目載入不完整，請重新連線；此錯誤不算瓶頸。')); return; }
    const card = node('article', { className: 'card diagnostic-question' });
    card.append(node('p', { className: 'diagnostic-progress-text' }, `第 ${attempt.answeredCount + 1} 題 · 已作答 ${attempt.answeredCount} 題`));
    card.append(node('progress', { 'aria-label': '作答進行中，題數依作答情況調整' }));
    const prompt = node('div', { className: 'match-prompt' });
    prompt.append(node('div', { className: 'mp-word' }, q.word), node('div', { className: 'mp-hint' }, '選出你認為正確的中文意思，可複選'));
    const grid = node('div', { className: 'match-grid g4', role: 'group', 'aria-label': '中文意思選項' });
    for (const option of q.options) {
      const b = button(option.text, { className: `match-card${selected.has(option.id) ? ' selected' : ''}`, 'data-focus': `option-${option.id}`, 'aria-pressed': String(selected.has(option.id)), disabled: busy || Boolean(pendingPayload) }, () => {
        if (busy || pendingPayload) return;
        unknown = false; selected.has(option.id) ? selected.delete(option.id) : selected.add(option.id); selectionChanged();
      });
      // 原生 button 的 Enter／空白鍵即是複選切換，不另外攔截鍵盤。
      grid.append(b);
    }
    const actions = node('div', { className: 'diagnostic-actions' });
    actions.append(button('不知道', { 'data-unknown': '', 'data-focus': 'unknown', 'aria-pressed': String(unknown), disabled: busy || Boolean(pendingPayload) }, () => {
      if (busy || pendingPayload) return;
      unknown = !unknown; selected.clear(); selectionChanged();
    }), button(pendingPayload && !busy ? '重試確認' : '提交本題', { 'data-submit': '', disabled: busy || (!unknown && !selected.size && !pendingPayload) }, submit));
    card.append(prompt, grid, actions); showStatus(card); root.append(card);
    root.append(node('p', { className: 'diagnostic-note' }, '提交後不能修改，全部完成才公布答案。未完成可下次接續；作答需要連線。'));
  }
  function drawReview(root, result) {
    const details = node('details'); details.append(node('summary', {}, '查看逐題答案與解析'));
    const list = node('ol', { className: 'diagnostic-reviews' });
    for (const review of result.answerReview || []) {
      const q = review.question || review;
      const options = q.options || review.options || [];
      const label = ids => (ids || []).map(id => options.find(o => o.id === id)?.text || id).join('、') || '無';
      const score = Number.isFinite(review.scoreUnits) ? review.scoreUnits / 12 : review.score ?? 0;
      const item = node('li'); item.append(node('strong', {}, q.word || review.word || review.questionId));
      item.append(node('p', {}, review.unknown ? '你的作答：不知道（0 分）' : `你的作答：${label(review.selectedOptionIds)}；部分得分 ${score.toFixed(2)}`));
      item.append(node('p', {}, `正確意思：${label(review.correctOptionIds)}`));
      item.append(node('p', {}, `漏選：${label(review.missedOptionIds)}；誤選：${label(review.wrongOptionIds)}`));
      item.append(node('p', {}, review.explanation || q.explanation || '')); list.append(item);
    }
    details.append(list); root.append(details);
  }
  async function changeLoad(load) {
    if (busy) return;
    const token = generation; busy = true; status = '正在更新每日份量…'; draw();
    try {
      const response = await api.setDiagnosticLoad(load, { signal: controller.signal });
      if (!valid(token)) return;
      const authoritative = response?.attempt || response;
      attempt = { ...attempt, ...(authoritative?.attemptId ? authoritative : {}), load: authoritative?.load || load };
      status = '每日份量已更新；開始每日任務即可查看清單。';
    } catch (error) { if (valid(token)) status = `份量尚未更新：${error.message || error}。請重試。`; }
    finally { if (valid(token)) { busy = false; draw(); } }
  }
  function drawResult(root) {
    const result = attempt.result;
    if (!result) { root.append(node('p', { role: 'alert' }, '結果尚未完整載入，請重新連線。')); return; }
    const card = node('article', { className: 'card' });
    card.append(node('h2', {}, result.completionReason === 'bottleneck' ? '已找到目前的詞義瓶頸' : '七個級別已達標'));
    card.append(node('progress', { value: '1', max: '1', 'aria-label': '診斷已完成' }));
    card.append(node('p', {}, `診斷已完成 · 已作答 ${result.answeredCount} 題`));
    card.append(node('p', { className: 'diagnostic-note' }, '詞彙量待校準。得分表示詞義辨認表現，不直接換算成會幾個字；未測級別不代表不會。'));
    const wrap = node('div', { className: 'diagnostic-table-wrap' }), table = node('table'), header = node('tr');
    for (const name of ['級別', '實答題數', '平均得分率', '漏選選項', '誤選選項', '不知道']) header.append(node('th', { scope: 'col' }, name));
    const head = node('thead'); head.append(header); const body = node('tbody');
    for (let level = 1; level <= 7; level++) {
      const row = (result.levels || []).find(r => r.level === level), measured = Boolean(row?.n), tr = node('tr');
      const average = measured ? row.sumScoreUnits / (12 * row.n) : 0;
      for (const value of [`Lv${level}`, measured ? row.n : '—', measured ? `${(average * 100).toFixed(1)}%` : '—', measured ? row.omittedOptionCount : '—', measured ? row.wrongOptionCount : '—', measured ? row.unknownCount : '—']) tr.append(node('td', {}, value));
      body.append(tr);
    }
    table.append(head, body); wrap.append(table); card.append(wrap);
    card.append(node('p', { className: 'diagnostic-note' }, '平均得分率按每題部分得分等權計算。漏選／誤選按選項數分開記錄，不知道另計題數。本測驗門檻尚待實測校準。'));
    card.append(node('h2', {}, '需要補強的地方'));
    for (const level of result.focusLevels || []) {
      const row = result.levels?.find(r => r.level === level);
      const hasWeakness = row?.omittedOptionCount || row?.wrongOptionCount || row?.unknownCount;
      card.append(node('p', {}, !row?.n ? `接下來探索 Lv${level}；此級尚未實測，不能視為已證實的弱項。` : hasWeakness ? `Lv${level}：優先鞏固實際漏選、誤選及不知道的單字。` : `Lv${level}：本次未測出明顯弱項，以進階練習與任務內檢核持續確認。`));
    }
    drawReview(card, result); root.append(card);
    const plan = node('article', { className: 'card diagnostic-plan' }); plan.append(node('h2', {}, '你的學習計畫已安排'));
    plan.append(node('p', {}, '先完成到期複習，再補強診斷弱項與主攻範圍的新字。'));
    const choices = node('div', { className: 'diagnostic-load-options', role: 'group', 'aria-label': '每日份量' });
    for (const [load, label, fresh, total] of [['light', '輕量', 5, 30], ['standard', '標準', 10, 50], ['intensive', '加強', 20, 80]]) {
      const b = button('', { className: 'btn diagnostic-load-choice', 'data-load': load, 'aria-pressed': String((attempt.load || 'standard') === load), disabled: busy }, () => changeLoad(load));
      b.append(node('strong', {}, label), node('span', {}, `新字最多 ${fresh} · 總量最多 ${total}`)); choices.append(b);
    }
    plan.append(choices, node('p', { className: 'diagnostic-note' }, '直接點選份量即可更新，設置中也可調整。完成紀錄保留，超量複習仍待處理，不改到期日。每日任務完成明細目前先存本機。'), node('a', { href: '#/daily-tasks', className: 'btn' }, '開始每日任務'));
    showStatus(plan); root.append(plan);
  }
  function draw() {
    if (!main || !attempt) return;
    const active = main.contains(main.ownerDocument.activeElement) ? main.ownerDocument.activeElement?.getAttribute('data-focus') : null;
    const root = shell(attempt.status === 'completed' ? '診斷結果' : '詞彙診斷');
    attempt.status === 'completed' ? drawResult(root) : drawQuestion(root);
    if (active) [...root.querySelectorAll('[data-focus]')].find(el => el.getAttribute('data-focus') === active && !el.disabled)?.focus();
  }
  function onLeave() {
    generation++; controller?.abort(); unsubscribe?.(); unsubscribe = null; clearTimeout(draftTimer);
    attempt = null; pendingPayload = null; main = null;
  }
  async function renderDiagnostic(target) {
    onLeave(); main = target; busy = false; status = ''; cacheWarning = ''; draftTail = Promise.resolve();
    controller = new AbortController(); const token = generation;
    message('正在確認登入狀態…');
    unsubscribe = auth.subscribe(() => {
      const currentMain = main; generation++; controller.abort(); clearTimeout(draftTimer); attempt = null; pendingPayload = null;
      if (currentMain) { main = currentMain; const root = message('帳戶已變更，請重新進入診斷確認此帳戶的進度。'); root.append(node('a', { href: '#/auth', className: 'btn' }, '帳戶設定')); }
    });
    await auth.ready;
    if (token !== generation) return;
    ownerId = auth.getUser()?.id;
    if (!ownerId) { const root = message('登入後才能開始或接續帳戶的一次性診斷。'); root.append(node('a', { href: '#/auth', className: 'btn' }, '登入帳戶')); return; }
    await load();
  }
  return { renderDiagnostic, onLeave };
}

let defaultPage, wrapperGeneration = 0;
export async function renderDiagnostic(main) {
  const token = ++wrapperGeneration;
  // 6.3.0 Pro 閘：詞彙診斷屬 8 項 Pro；無有效 Pro（含未登入／查詢失敗）→「正在開發中」。
  const [gateMod, gateDom] = await Promise.all([
    import('../services/pro-gate.js'), import('../services/pro-gate-dom.js'),
  ]);
  const gate = await gateMod.proGateStatus('diagnostic', (await import('../services/pro-api.js')).proStatus);
  if (token !== wrapperGeneration) return;
  if (gate.state !== 'available') {
    gateDom.mountProGateCard(main, 'diagnostic', () => renderDiagnostic(main), '診斷屬 Pro 功能；無有效 Pro 時入口隱藏，此頁顯示「正在開發中」。');
    return;
  }
  if (!defaultPage) {
    const [api, store, auth, bus] = await Promise.all([import('../services/diagnostic-api.js'), import('../services/diagnostic-store.js'), import('../services/auth.js'), import('../core/eventbus.js')]);
    if (token !== wrapperGeneration) return;
    defaultPage = createDiagnosticPage({
      api: { ...api, setDiagnosticLoad: async (load, opts) => (await import('../services/daily-tasks.js')).setDailyLoad(load, opts) },
      store, auth: { getUser: auth.getUser, ready: auth.authReady, subscribe: listener => bus.on('auth:changed', listener) },
    });
  }
  if (token === wrapperGeneration) return defaultPage.renderDiagnostic(main);
}
export function onLeave() { wrapperGeneration++; defaultPage?.onLeave(); }
