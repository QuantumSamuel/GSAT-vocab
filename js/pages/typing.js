// ============================================================
// 頁面：打字背單字（7.0.0，2026-11-22）
//
// 【定位】第三個學習入口：聽音 → 打整字 → 錯字重排到章末 → 章末結算。
//   與「拼寫學習」的差別：拼寫是逐字母提示、看字母打；打字是聽音回想、整字輸入。
//
// 【規則（本版定案）】
//   · 一章 20 字，隨機抽自所選 Lv 範圍
//   · 每字顯示中文義項並自動發音；使用者輸入整字後 Enter 送出
//   · 答錯不擋輸入，該字重排到章末再打一次；重打次數累計
//   · 一次答對才計入「一次過關」
//   · 中途離開或 SW 重載 → sessionStorage 接續同一章（比照連接詞頁）
//   · 不改 SRS 排程（本版只記錄事件，不動到期日）
// ============================================================
import { getWords, loadWords } from '../services/vocab.js';
import { el, escapeHtml, speak, logError } from '../core/ui.js';
import { capturePage, getOwnerId } from '../services/owner-guard.js';
import { emit } from '../core/eventbus.js';
import { addEvent } from '../services/store.js';

const CHAPTER_SIZE = 20;
const STORE_KEY = 'gsat-typing-chapter-v1';

let progress = null; // { levels, queue:[{id,word,senses}], idx, done, retries, startedAt, owner }

function loadProgress() {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p || !Array.isArray(p.queue) || !p.queue.length) return null;
    return p;
  } catch { return null; }
}
function saveProgress(p) {
  try {
    if (p) sessionStorage.setItem(STORE_KEY, JSON.stringify(p));
    else sessionStorage.removeItem(STORE_KEY);
  } catch { /* 私密模式 */ }
}

function pickChapter(words, levels) {
  const pool = words.filter((w) => levels.includes(Number(w.level)) && w.word && !/[^A-Za-z0-9\-' ]/.test(w.word));
  const picked = [];
  const seen = new Set();
  let guard = 0;
  while (picked.length < CHAPTER_SIZE && pool.length && guard < pool.length * 3) {
    guard += 1;
    const w = pool[Math.floor(Math.random() * pool.length)];
    if (seen.has(w.id)) continue;
    seen.add(w.id);
    picked.push({ id: w.id, word: w.word, senses: (w.senses || []).slice(0, 2), phonetic: w.phonetic || '' });
  }
  return picked;
}

// 逐字母比對：正確綠、錯誤紅、尚未輸入為灰
function letterCompare(input, answer) {
  const a = String(answer);
  const v = String(input);
  let html = '';
  for (let i = 0; i < a.length; i += 1) {
    const ch = a[i];
    const typed = v[i];
    const cls = typed == null ? 'pending' : (typed.toLowerCase() === ch.toLowerCase() ? 'ok' : 'bad');
    html += `<span class="lt ${cls}">${escapeHtml(ch)}</span>`;
  }
  if (v.length > a.length) html += `<span class="lt extra">${escapeHtml(v.slice(a.length))}</span>`;
  return html;
}

export async function renderTyping(main) {
  const guard = capturePage();
  const stillOn = () => guard.active() && main.isConnected;
  const owner = getOwnerId() ?? 'guest';

  main.replaceChildren(el(`<div class="page typing-page">
    <h1 class="h1">打字背單字</h1>
    <p class="muted small">聽發音、打整字。一章 20 字，打錯的字會排到章末再打一次。</p>
    <div id="typing-body"></div>
  </div>`));
  const body = main.querySelector('#typing-body');

  try { await loadWords(); } catch (err) {
    logError?.(err);
    body.replaceChildren(el('<p class="warning">字庫載入失敗，請確認網路後重試。</p>'));
    return;
  }
  if (!stillOn()) return;

  const words = getWords();
  progress = loadProgress();
  if (progress && progress.owner !== owner) progress = null; // 換帳號不接續別人的章節

  const renderSetup = () => {
    const levels = [1, 2, 3, 4, 5, 6];
    body.replaceChildren(el(`<div class="card">
      <label class="muted small">字彙範圍</label>
      <div class="typing-levels">${levels.map((lv) => `<label class="chk"><input type="checkbox" class="lv" value="${lv}" checked> Lv${lv}</label>`).join('')}</div>
      <div class="controls" style="margin-top:12px">
        <button class="btn primary" id="typing-start">開始一章（20 字）</button>
      </div>
      <p class="muted small" id="typing-hint"></p>
    </div>`));
    const hint = body.querySelector('#typing-hint');
    const updateHint = () => {
      const picked = [...body.querySelectorAll('.lv:checked')].map((x) => Number(x.value));
      const n = words.filter((w) => picked.includes(Number(w.level))).length;
      hint.textContent = picked.length ? `這個範圍有 ${n} 個單字` : '請至少選一個 Lv';
    };
    body.querySelectorAll('.lv').forEach((x) => x.addEventListener('change', updateHint));
    updateHint();
    body.querySelector('#typing-start').addEventListener('click', () => {
      const picked = [...body.querySelectorAll('.lv:checked')].map((x) => Number(x.value));
      if (!picked.length) { hint.textContent = '請至少選一個 Lv'; return; }
      const queue = pickChapter(words, picked);
      if (!queue.length) { hint.textContent = '這個範圍沒有可練習的單字'; return; }
      progress = { levels: picked, queue, idx: 0, done: 0, retries: 0, missed: [], missletters: {}, startedAt: Date.now(), owner };
      saveProgress(progress);
      paint();
    });
  };

  const paint = () => {
    if (!stillOn()) return;
    if (!progress) { renderSetup(); return; }
    const { queue, idx } = progress;

    if (idx >= queue.length) { renderSummary(); return; }

    const item = queue[idx];
    const total = queue.length;
    body.replaceChildren(el(`<div class="typing-card">
      <p class="muted small">第 ${idx + 1} / ${total} 題｜已完成 ${progress.done}｜重打 ${progress.retries} 次</p>
      <div class="typing-bar" aria-hidden="true"><i style="width:${Math.round((idx / total) * 100)}%"></i></div>
      <div class="typing-prompt">
        <strong>${escapeHtml(item.senses.join('；') || '（無釋義）')}</strong>
        ${item.phonetic ? `<span class="ph">${escapeHtml(item.phonetic)}</span>` : ''}
        <button class="btn subtle" id="typing-play" type="button" aria-label="再聽一次">再聽</button>
      </div>
      <div class="typing-letters" id="typing-letters" aria-live="polite">${letterCompare('', item.word)}</div>
      <input id="typing-input" class="input-shared" type="text" autocomplete="off" autocapitalize="off"
             autocorrect="off" spellcheck="false" enterkeyhint="done" aria-label="輸入整字" />
      <div class="controls">
        <button class="btn primary" id="typing-submit" type="button">送出（Enter）</button>
        <button class="btn" id="typing-quit" type="button">結束這一章</button>
      </div>
      <p class="muted small" id="typing-feedback" aria-live="assertive"></p>
    </div>`));

    const input = body.querySelector('#typing-input');
    const letters = body.querySelector('#typing-letters');
    const feedback = body.querySelector('#typing-feedback');

    const play = () => { try { speak(item.word); } catch { /* 無語音可用 */ } };
    play();
    body.querySelector('#typing-play').addEventListener('click', play);
    input.focus();
    // 手機鍵盤彈出會把輸入框推到可視區外：聚焦時與 viewport 變動時重新捲入
    const keepVisible = () => {
      if (typeof input.scrollIntoView !== 'function') return; // jsdom 等環境沒有這個 API
      try { input.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch { try { input.scrollIntoView(); } catch { /* 忽略 */ } }
    };
    keepVisible();
    if (typeof window !== 'undefined' && window.visualViewport) {
      const onVV = () => keepVisible();
      window.visualViewport.addEventListener('resize', onVV, { once: true });
    }

    input.addEventListener('input', () => { letters.innerHTML = letterCompare(input.value, item.word); });

    const submit = () => {
      if (!input.isConnected) return;
      const typed = String(input.value).trim();
      if (!typed) { feedback.textContent = '請先輸入單字'; return; }
      const ok = typed.toLowerCase() === item.word.toLowerCase();
      // 7.0.1：把每次作答記成 quiz 事件，統計頁的答題正確率與活動熱力圖才會算到打字模式
      addEvent('quiz', item.id, { q: 'typing', ok });
      if (ok) {
        progress.done += 1;
        feedback.textContent = '答對';
        progress.idx += 1;
        saveProgress(progress);
        paint();
      } else {
        progress.retries += 1;
        progress.missed = Array.isArray(progress.missed) ? progress.missed : [];
        if (!progress.missed.includes(item.id)) progress.missed.push(item.id);
        // 7.3.5：錯誤字母分析——記下「答錯位置對應的目標字母」
        progress.missletters = progress.missletters || {};
        const ans = item.word.toLowerCase();
        const typedLower = typed.toLowerCase();
        for (let i = 0; i < ans.length; i += 1) {
          if (typedLower[i] !== ans[i] && /[a-z]/.test(ans[i])) {
            progress.missletters[ans[i]] = (progress.missletters[ans[i]] || 0) + 1;
          }
        }
        letters.innerHTML = letterCompare(typed, item.word);
        feedback.textContent = '再想一下，已排到章末重打';
        progress.queue.push(item);          // 重排到章末
        progress.idx += 1;
        saveProgress(progress);
        setTimeout(() => { if (stillOn()) paint(); }, 450);
      }
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
    body.querySelector('#typing-submit').addEventListener('click', submit);
    body.querySelector('#typing-quit').addEventListener('click', () => {
      progress = null;
      saveProgress(null);
      renderSetup();
    });
  };

  const renderSummary = () => {
    // 7.3.5：把本章的錯誤字母累計進本機統計，並取前三名顯示
    const letters = progress.missletters || {};
    const topLetters = Object.entries(letters)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([ch, n]) => `${ch}×${n}`)
      .join('、');
    try {
      const KEY = 'vocab2_typing_letters';
      const agg = JSON.parse(localStorage.getItem(KEY) || '{}');
      for (const [ch, n] of Object.entries(letters)) agg[ch] = (agg[ch] || 0) + n;
      localStorage.setItem(KEY, JSON.stringify(agg));
    } catch { /* 私密模式忽略 */ }
    const total = progress.queue.length;
    const secs = Math.max(1, Math.round((Date.now() - progress.startedAt) / 1000));
    const rate = total ? Math.round((progress.done / total) * 100) : 0;
    body.replaceChildren(el(`<div class="card typing-summary">
      <h2 class="h2">這一章完成</h2>
      <ul class="muted small" style="margin:8px 0 12px 18px">
        <li>一次過關：<strong>${progress.done} / ${total}</strong>（${rate}%）</li>
        <li>重打次數：<strong>${progress.retries}</strong></li>
        <li>用時：<strong>${Math.floor(secs / 60)} 分 ${secs % 60} 秒</strong></li>
        <li>最常打錯的字母：<strong>${topLetters || '（這一章沒有打錯）'}</strong></li>
      </ul>
      <div class="controls">
        <button class="btn primary" id="typing-again">再練一章</button>
        <button class="btn" id="typing-missed" type="button"${(progress.missed || []).length ? '' : ' disabled'}>只練打錯的 ${(progress.missed || []).length} 字</button>
        <a class="btn" href="#/practice">回練習</a>
      </div>
    </div>`));
    emit('typing:finished', { done: progress.done, total, retries: progress.retries, seconds: secs, levels: progress.levels });
    body.querySelector('#typing-missed')?.addEventListener('click', () => {
      const ids = progress.missed || [];
      if (!ids.length) return;
      const byId = new Map(getWords().map((w) => [w.id, w]));
      const queue = ids.map((id) => byId.get(id)).filter(Boolean).map((w) => ({ id: w.id, word: w.word, senses: (w.senses || []).slice(0, 2), phonetic: w.phonetic || '' }));
      if (!queue.length) return;
      progress = { levels: progress.levels, queue, idx: 0, done: 0, retries: 0, missed: [], missletters: {}, startedAt: Date.now(), owner };
      saveProgress(progress);
      paint();
    });
    body.querySelector('#typing-again').addEventListener('click', () => {
      const levels = progress.levels;
      const queue = pickChapter(getWords(), levels);
      progress = { levels, queue, idx: 0, done: 0, retries: 0, missed: [], missletters: {}, startedAt: Date.now(), owner };
      saveProgress(progress);
      paint();
    });
  };

  paint();
}