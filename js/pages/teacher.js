// 班級名單：老師端與學生加入（7.5 P1，2026-11-24）
//
// 老師端 #/teacher：建立班級、看加入代碼、看成員暱稱。
// 學生端 #/class-join：輸入代碼＋暱稱加入。
// 隱私：只顯示暱稱，不收本名／email。
import { el, escapeHtml } from '../core/ui.js';
import { getUser, getProfile } from '../services/auth.js';
import { createClass, listMyClasses, listMembers, joinClass, isValidCode, normalizeNickname, createAssignment, listAssignments, listMyAssignments, classStats, formatClassStats, rankClasses, formatRanking, classMemberContacts, classLeaderboard, formatContacts, formatLeaderboard } from '../services/classes.js';

export async function renderTeacher(main) {
  const user = getUser();
  const profile = getProfile();
  const role = profile?.role || '';
  if (!user?.id || (role !== 'teacher' && role !== 'admin')) {
    main.replaceChildren(el(`
      <section class="page teacher-page">
        <h2>教師端</h2>
        <div class="gate-card">
          <h3>需要教師權限</h3>
          <p class="muted small">這個頁面只開放給教師帳號。學生可以用「加入班級」輸入老師給的 6 碼代碼。</p>
          <a class="btn" href="#/class-join">我是學生，要加入班級</a>
        </div>
      </section>`));
    return;
  }

  main.replaceChildren(el(`
    <section class="page teacher-page">
      <h2>教師端</h2>
      <p class="muted small">建立班級後會得到 6 碼代碼，學生用代碼加入。<strong>只收暱稱，不收本名或 email。</strong></p>
      <div class="row-inline">
        <input id="class-name" class="input-shared" type="text" maxlength="40" placeholder="班級名稱（例：二年三班）">
        <button class="btn primary" id="class-create" type="button">建立班級</button>
      </div>
      <p class="muted small" id="class-note" aria-live="polite"></p>
      <div id="class-list"></div>
      <h3>班級季賽（只顯示班級整體）</h3>
      <p class="muted small" id="season-note">說明：每 1 個待複習字 2 分、每 1 次複習 1 分；只列班級分數，不列個別學生。</p>
      <p class="muted small" id="season-box">載入中…</p>
    </section>`));

  const note = main.querySelector('#class-note');
  const list = main.querySelector('#class-list');

  const draw = async () => {
    const classes = await listMyClasses();
    if (!classes.length) { list.innerHTML = '<p class="muted small">還沒有班級。</p>'; return; }
    list.innerHTML = classes.map((c) => `
      <div class="class-card" data-id="${escapeHtml(c.id)}">
        <p><strong>${escapeHtml(c.name)}</strong>　代碼：<code>${escapeHtml(c.join_code)}</code></p>
        <p class="muted small class-members" data-id="${escapeHtml(c.id)}">載入成員…</p>
        <p class="muted small class-stats" data-id="${escapeHtml(c.id)}">載入班級統計…</p>
        <div class="row-inline">
          <button class="btn subtle contacts-toggle" type="button" data-id="${escapeHtml(c.id)}">顯示學生 email</button>
          <button class="btn subtle board-toggle" type="button" data-id="${escapeHtml(c.id)}">個別排行（預設關）</button>
        </div>
        <p class="muted small contacts-out" data-id="${escapeHtml(c.id)}" hidden></p>
        <p class="muted small board-out" data-id="${escapeHtml(c.id)}" hidden></p>
        <div class="assign-box" data-id="${escapeHtml(c.id)}">
          <div class="row-inline">
            <input class="input-shared assign-title" type="text" maxlength="60" placeholder="指派標題（例：本週 Lv2 單字）">
            <input class="input-shared assign-min" type="number" min="1" max="7" value="1" style="width:4rem">
            <input class="input-shared assign-max" type="number" min="1" max="7" value="3" style="width:4rem">
            <input class="input-shared assign-due" type="date">
            <button class="btn assign-add" type="button">建立指派</button>
          </div>
          <p class="muted small assign-list">尚無指派</p>
        </div>
      </div>`).join('');
    for (const c of classes) {
      const box = list.querySelector('.class-members[data-id="' + c.id + '"]');
      // eslint-disable-next-line no-await-in-loop
      const members = await listMembers(c.id);
      box.textContent = members.length ? '成員（' + members.length + '）：' + members.map((m) => m.nickname).join('、') : '尚無成員';
      const cOut = list.querySelector('.contacts-out[data-id="' + c.id + '"]');
      const cBtn = list.querySelector('.contacts-toggle[data-id="' + c.id + '"]');
      cBtn?.addEventListener('click', async () => {
        if (!cOut.hidden) { cOut.hidden = true; cBtn.textContent = '顯示學生 email'; return; }
        cBtn.disabled = true;
        const r = await classMemberContacts(c.id);
        cBtn.disabled = false;
        cBtn.textContent = r.ok ? '隱藏學生 email' : '顯示學生 email';
        cOut.hidden = false;
        cOut.textContent = r.ok ? '成員聯絡：' + formatContacts(r.rows)
          : (r.code === 'HTTP_404' ? '尚不可用：請先在資料庫套用 class-insights SQL（email 功能）' : '無法取得（' + r.code + '）');
      });
      const bOut = list.querySelector('.board-out[data-id="' + c.id + '"]');
      const bBtn = list.querySelector('.board-toggle[data-id="' + c.id + '"]');
      bBtn?.addEventListener('click', async () => {
        if (!bOut.hidden) { bOut.hidden = true; return; }
        bBtn.disabled = true;
        const r = await classLeaderboard(c.id);
        bBtn.disabled = false;
        bOut.hidden = false;
        bOut.textContent = r.ok ? '個別排行：' + formatLeaderboard(r.rows)
          : (r.code === 'HTTP_404' ? '尚不可用：請先在資料庫套用 class-insights SQL（排行功能）' : '無法取得（' + r.code + '）');
      });
      const sbox = list.querySelector('.class-stats[data-id="' + c.id + '"]');
      if (sbox) {
        const s = await classStats(c.id);
        sbox.textContent = formatClassStats(s);
      }
      const abox = list.querySelector('.assign-box[data-id="' + c.id + '"]');
      if (abox) {
        const ALIST = async () => {
          const arr = await listAssignments(c.id);
          const p2 = abox.querySelector('.assign-list');
          p2.textContent = arr.length
            ? '指派（' + arr.length + '）：' + arr.map((a) => a.title + (a.due_at ? '（' + String(a.due_at).slice(0, 10) + ' 前）' : '')).join('、')
            : '尚無指派';
        };
        await ALIST();
        abox.querySelector('.assign-add')?.addEventListener('click', async () => {
          const title = abox.querySelector('.assign-title').value;
          const minLv = Number(abox.querySelector('.assign-min').value) || 1;
          const maxLv = Number(abox.querySelector('.assign-max').value) || minLv;
          const due = abox.querySelector('.assign-due').value || '';
          const r = await createAssignment({ classId: c.id, title, target: { type: 'level', minLv, maxLv }, dueAt: due });
          const note2 = note;
          if (!r.ok) {
            note2.textContent = ({ TITLE_REQUIRED: '請填指派標題', BAD_RANGE: '等級範圍錯誤', PAST_DATE: '期限不可在過去', BAD_DATE: '期限格式錯誤', FORBIDDEN: '沒有權限對這個班指派' }[r.code] || '建立失敗');
            return;
          }
          abox.querySelector('.assign-title').value = '';
          note2.textContent = '已建立指派：' + title;
          await ALIST();
        });
      }
    }
  };

  main.querySelector('#class-create').addEventListener('click', async () => {
    const name = main.querySelector('#class-name').value;
    note.textContent = '建立中…';
    const r = await createClass(name);
    if (!r.ok) {
      const msg = { NAME_REQUIRED: '請輸入班級名稱', NOT_LOGGED_IN: '請先登入', CREATE_FAILED: '建立失敗，稍後再試', CODE_COLLISION: '代碼重複，請再試一次' }[r.code] || '建立失敗';
      note.textContent = msg;
      return;
    }
    note.textContent = '已建立：' + r.class.name + '，代碼 ' + r.class.join_code;
    main.querySelector('#class-name').value = '';
    await draw();

  // 7.5 P4：季賽（用各班的聚合分數排序）
  try {
    const classes = await listMyClasses();
    const withStats = [];
    for (const c of classes) {
      withStats.push({ id: c.id, name: c.name, stats: await classStats(c.id) });
    }
    const seasonBox = main.querySelector('#season-box');
    if (seasonBox) seasonBox.textContent = formatRanking(rankClasses(withStats));
  } catch {
    const seasonBox = main.querySelector('#season-box');
    if (seasonBox) seasonBox.textContent = '季賽資料載入失敗';
  }
  });

  await draw();
}

export async function renderClassJoin(main) {
  main.replaceChildren(el(`
    <section class="page class-join-page">
      <h2>加入班級</h2>
      <p class="muted small">輸入老師給的 6 碼代碼，並取一個顯示用的暱稱（<strong>不要填本名</strong>）。</p>
      <div class="row-inline">
        <input id="join-code" class="input-shared" type="text" maxlength="6" placeholder="6 碼代碼" spellcheck="false">
        <input id="join-nick" class="input-shared" type="text" maxlength="20" placeholder="暱稱（例：小安）">
        <button class="btn primary" id="join-go" type="button">加入</button>
      </div>
      <p class="muted small" id="join-note" aria-live="polite"></p>
      <a class="btn" href="#/practice">回練習</a>
    </section>`));

  const note = main.querySelector('#join-note');
  main.querySelector('#join-go').addEventListener('click', async () => {
    const code = main.querySelector('#join-code').value;
    const nick = main.querySelector('#join-nick').value;
    if (!isValidCode(code)) { note.textContent = '代碼格式不對（6 碼，字母數字，不含 0/O/1/I/L）。'; return; }
    const n = normalizeNickname(nick);
    if (!n.ok) { note.textContent = n.code === 'NICK_REQUIRED' ? '請填暱稱。' : '暱稱太長（最多 20 字）。'; return; }
    note.textContent = '加入中…';
    const r = await joinClass(code, nick);
    note.textContent = r.ok ? '已加入「' + r.className + '」' : ({
      CODE_NOT_FOUND: '代碼無效（找不到這個班級）',
      BAD_NICKNAME: '暱稱格式不對',
      UNAUTHENTICATED: '請先登入',
    }[r.code] || '加入失敗，稍後再試');
    if (r.ok) {
      const arr = await listMyAssignments();
      const box = document.createElement('div');
      box.className = 'my-assignments';
      box.innerHTML = '<h3>我的指派</h3>' + (arr.length
        ? arr.map((a) => '<p class="muted small">' + (a.title || '指派') + (a.due_at ? '（' + String(a.due_at).slice(0, 10) + ' 前）' : '') + '</p>').join('')
        : '<p class="muted small">目前沒有指派。</p>');
      main.querySelector('.class-join-page').appendChild(box);
    }
  });
}