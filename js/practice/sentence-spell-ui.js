// ============================================================
// 例句拼字（候選 UI 接線，2026-11-10；核心／來源沿用 sentence-spell-core.js／source.js）
//
// 邊界（本批）：
//   ・只新增「例句拼字」學習方法與其 UI；卡片／拼寫兩種舊模式與舊路由完全不動。
//   ・作答畫面只由 core 的 layout 資料組 DOM：外部文字一律 textContent，不用 innerHTML 塞資料。
//   ・完成前不得把答案放進 dataset／隱藏屬性／可讀屬性；完成後才顯示單字卡。
//   ・不寫 quiz 事件（避免被統計當成盲打答對率），只寫本模式自己的 hinted 學習紀錄。
//     事件型別刻意與 recheck 不同 → 不可能被 short-recheck 當成合格樣本。
//   ・不碰 SRS／due／複習候選／獨立回想；不寫任何正式 DB schema、不連網寫入帳戶資料。
//   ・使用者已裁決：重複出現的目標字全部挖空、共用同一組作答格與同一筆完成紀錄。
//   ・本檔的 JS 本來就可被使用者檢視；不做也不宣稱防作弊，只保證完成前畫面沒有答案。
//
// 舊模式界線：舊拼寫（spelling.js）既有的 dataset 答案與統計路徑一律不動；本檔只提供
// 新學習方法的入口，兩者共用 mountSpellKeyboard 的已核准手動／裝置預設策略。
// ============================================================
import {
  createState, typeLetter, completionSummary,
} from './sentence-spell-core.js';
import { buildQuestionFromSource } from './sentence-spell-source.js';
import { loadSentences, getSentencesFor } from '../services/vocab.js';
import { loadLexiconEntry } from '../services/lexicon.js';
import { el, openDialog } from '../core/ui.js';
import { mountShell, mountCompletion, shuffle } from './shell.js';
import { clearBackHandler } from '../core/router.js';
import { mountSpellKeyboard } from './spell-keyboard.js';
import { miniCardHtml } from './word-card.js';
import { addEvent } from '../services/store.js';
import { capturePage } from '../services/owner-guard.js';

// 本模式的 hinted 學習事件型別。刻意不是 'quiz'（不進盲打答對率）也不是 'recheck'
// （core/recheck.js 只接受 type==='recheck'；本型別再怎麼寫都不會成為短複測樣本）。
export const SENTENCE_EVENT = 'sentence-spell';

const LETTER_RX = /^\p{L}$/u;
// 作答格 → { 共用字母索引, 這個出現處的原始字元 }。
// 原始字元只存在 JS 閉包，不寫進 dataset／隱藏屬性：完成前 DOM 上沒有任何答案線索；
// 打對後才用它顯示「各自 occurrence」的 casing／Unicode，不把第一個出現處的字形複製到其他處。
const SLOT_INDEX = new WeakMap();

const REASON_TEXT = {
  no_example: '沒有例句',
  no_target_occurrence: '例句找不到目標字',
  ambiguous_source_matches: '詞形對應衝突',
  multiple_surface_forms: '同句出現多種詞形',
  unsupported_surface_form: '詞形未經來源宣告',
  ambiguous_meaning: '例句釋義不唯一',
  unreliable_example: '例句釋義不完整',
  lexicon_word_id_mismatch: '詞庫對應不符',
  lexicon_word_mismatch: '詞庫字面不符',
  occurrence_surface_mismatch: '例句與詞形不一致',
  inconsistent_letter_counts: '重複出現的字母數不一致',
  overlapping_occurrences: '出現位置重疊',
};

function reasonText(code) {
  return REASON_TEXT[code] || `來源不適用（${String(code || 'unknown')}）`;
}

function bump(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

/** 把略過原因整理成「無例句 3、詞形對應衝突 1」這種可顯示字串（只含實際出現的）。 */
export function describeSkips(reasons) {
  const rows = [...(reasons || new Map()).entries()]
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  if (!rows.length) return '';
  return rows.map(([code, n]) => `${reasonText(code)} ${n}`).join('、');
}

/**
 * 依選定字池解析可出題的例句（純資料；DOM 由呼叫端負責）。
 * 只使用明確傳入的載入器（預設就是既有 vocab／lexicon 服務）；不自行 fetch、不寫事件。
 * 回傳 { ok:true, usable:[{word, question, source}], reasons:Map, total }
 * 或 { ok:false, code:'sentences_load_failed'|'lexicon_load_failed', error }
 */
export async function prepareSentenceSession(pool, {
  loadSentences: loadSentencesFn = loadSentences,
  getSentencesFor: getSentencesForFn = getSentencesFor,
  loadLexiconEntry: loadLexiconEntryFn = loadLexiconEntry,
  assertActive = () => {},
} = {}) {
  let sentences;
  try {
    sentences = await loadSentencesFn();
  } catch (error) {
    return { ok: false, code: 'sentences_load_failed', error };
  }
  assertActive();
  // loadSentences() 失敗時既有的契約是回 undefined（不 throw、可重試）；不可當成「沒有例句」。
  if (!sentences) return { ok: false, code: 'sentences_load_failed', error: new Error('SENTENCES_UNAVAILABLE') };

  const usable = [];
  const reasons = new Map();
  for (const word of pool || []) {
    assertActive();
    const list = getSentencesForFn(word.id) || [];
    if (!list.length) { bump(reasons, 'no_example'); continue; }

    let lexiconEntry = null;
    try {
      lexiconEntry = await loadLexiconEntryFn(word.id, { word });
    } catch (error) {
      return { ok: false, code: 'lexicon_load_failed', error };
    }
    assertActive();

    let lastReason = null;
    let built = null;
    for (let i = 0; i < list.length; i += 1) {
      const sentence = list[i] || {};
      // sentences.json 沒有來源 sentence id；用 wordId＋該字例句序號作為可回溯的穩定鍵。
      const sourceSentenceId = `${word.id}#${i}`;
      const result = buildQuestionFromSource({
        word,
        sentence: { en: sentence.en, zh: sentence.zh, id: sourceSentenceId },
        sourceSentenceId,
        lexiconEntry,
      });
      if (result.ok) { built = result; break; }
      lastReason = result.reason || 'unsupported_surface_form';
    }
    if (built) usable.push({ word, question: built.question, source: built.source });
    else bump(reasons, lastReason || 'no_target_occurrence');
  }

  return { ok: true, usable, reasons, total: (pool || []).length };
}

/**
 * 進入例句拼字（由 pages/study.js 呼叫；沿用既有字池與字數設定）。
 * opts.count：本次最多幾題（0／未給＝全部可用題）。
 * opts.loaders：測試用注入（loadSentences／getSentencesFor／loadLexiconEntry）；正式路徑不傳。
 * opts.sessionId：測試用固定場次 id；正式路徑自動產生。
 */
export function startSentenceSpellStudy(pool, opts = {}) {
  const main = opts.main || document.getElementById('app');
  if (!main) return null;
  const countLimit = Number(opts.count) > 0 ? Math.floor(Number(opts.count)) : 0;
  const loaders = opts.loaders || {};
  const sessionId = opts.sessionId || `sentence-spell:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;

  // 帳戶捕捉必須在「開始」時做一次；之後每個 await 回來、每次渲染與每次寫入前都驗。
  const page = capturePage();
  let alive = true;
  let kbdPanel = null;
  let kbdPref = null;
  let backHandlerFn = null;
  let renderToken = 0;

  const dispose = () => {
    if (!alive && !kbdPanel && !backHandlerFn) return;
    alive = false;
    renderToken += 1;
    if (kbdPanel) { kbdPanel.destroy(); kbdPanel = null; }
    if (typeof window !== 'undefined') window.removeEventListener('hashchange', onLeave);
    if (backHandlerFn) { clearBackHandler(backHandlerFn); backHandlerFn = null; }
  };

  const active = () => alive && page.active();

  function onLeave() { dispose(); }

  if (typeof window !== 'undefined') window.addEventListener('hashchange', onLeave);

  const goStudy = async () => {
    dispose();
    if (typeof location === 'undefined') return;
    if (location.hash === '#/study') {
      const router = await import('../core/router.js');
      await router.render();
      return;
    }
    location.hash = '#/study';
  };

  const renderLoading = () => {
    if (!active()) return;
    main.replaceChildren(el(`<section class="card">
      <h2>例句拼字</h2>
      <p class="muted small" id="ss-status" aria-busy="true">正在準備例句與詞形資料…</p>
    </section>`));
  };

  const renderFailure = () => {
    if (!active()) return;
    main.replaceChildren(el(`<section class="card">
      <h2>例句拼字</h2>
      <p class="warning" id="ss-status">例句或詞形資料載入失敗，尚未開始作答；可重試，不會把載入失敗當成「沒有例句」。</p>
      <div class="controls">
        <button class="btn primary" type="button" id="ss-retry">重試</button>
        <button class="btn" type="button" id="ss-back">回學習頁</button>
      </div>
    </section>`));
    main.querySelector('#ss-retry').addEventListener('click', () => { run(); });
    main.querySelector('#ss-back').addEventListener('click', goStudy);
  };

  const renderEmpty = (prepared) => {
    if (!active()) return;
    const skipText = describeSkips(prepared.reasons) || '沒有可用的例句';
    main.replaceChildren(el(`<section class="card">
      <h2>例句拼字</h2>
      <p class="warning" id="ss-status">這個範圍沒有可出題的例句（共 ${prepared.total} 字）：${skipText}。</p>
      <p class="muted small">不憑空造句，也不強制改用猜測的詞形。可改用既有「拼寫學習」（顯示字母模式）。</p>
      <div class="controls">
        <button class="btn primary" type="button" id="ss-oldmode">改用拼寫學習</button>
        <button class="btn" type="button" id="ss-back">回學習頁</button>
      </div>
    </section>`));
    main.querySelector('#ss-oldmode').addEventListener('click', async () => {
      if (!active()) return;
      const { startWordSpellStudy } = await import('./spelling.js');
      if (!active()) return;
      // 先卸載本模式的監聽與返回處理，再交給舊模式（舊模式自己會掛／清自己的）。
      dispose();
      startWordSpellStudy(pool, { mode: 'show', main, ...(countLimit > 0 ? { count: countLimit } : {}) });
    });
    main.querySelector('#ss-back').addEventListener('click', goStudy);
  };

  const renderSummary = (prepared) => {
    if (!active()) return;
    const skipCount = [...prepared.reasons.values()].reduce((a, b) => a + b, 0);
    const skipText = describeSkips(prepared.reasons);
    const countNote = countLimit > 0
      ? `本次最多抽 ${Math.min(countLimit, prepared.usable.length)} 題（可用 ${prepared.usable.length} 題）。`
      : '本次使用全部可用題。';
    main.replaceChildren(el(`<section class="card">
      <h2>例句拼字</h2>
      <p class="muted small">看例句拼出被挖空的字：打對的字母轉綠；打錯會轉紅，下一個字母直接覆蓋（不需要退格）。</p>
      <p class="muted small" id="ss-status">本次範圍 ${prepared.total} 字：可出題 ${prepared.usable.length} 字${skipCount ? `；略過 ${skipCount} 字（${skipText}）` : '；沒有略過'}。${countNote}</p>
      <p class="muted small">這是逐字提示的學習活動：完成紀錄標為 hinted，不計入盲打答對率，也不作為短複測或無提示回想的證據。</p>
      <div class="controls">
        <button class="btn primary" type="button" id="ss-start">開始例句拼字</button>
        <button class="btn" type="button" id="ss-back">回學習頁</button>
      </div>
    </section>`));
    main.querySelector('#ss-start').addEventListener('click', () => startRun(prepared));
    main.querySelector('#ss-back').addEventListener('click', goStudy);
  };

  async function run() {
    if (!active()) return;
    renderLoading();
    let prepared;
    try {
      prepared = await prepareSentenceSession(pool, {
        ...loaders,
        assertActive() {
          if (!active()) {
            const e = new Error('ACCOUNT_CHANGED');
            e.code = 'ACCOUNT_CHANGED';
            throw e;
          }
        },
      });
    } catch (error) {
      if (error && error.code === 'ACCOUNT_CHANGED') return dispose();
      if (!active()) return;
      renderFailure();
      return;
    }
    if (!active()) return;
    if (!prepared.ok) { renderFailure(); return; }
    if (!prepared.usable.length) { renderEmpty(prepared); return; }
    renderSummary(prepared);
  }

  function startRun(prepared) {
    if (!active()) return;
    const list = shuffle(prepared.usable);
    const limited = countLimit > 0 ? list.slice(0, countLimit) : list;
    const items = limited.map((entry) => ({
      word: entry.word,
      question: entry.question,
      source: entry.source,
      state: null,
      recorded: false,
      summary: null,
    }));
    let idx = 0;

    const stateOf = (item) => {
      if (!item.state) {
        const created = createState(item.question);
        item.state = created.ok ? created.state : null;
      }
      return item.state;
    };

    const goNext = () => {
      if (!active()) return;
      if (idx >= items.length - 1) { showSummary(); return; }
      idx += 1;
      renderQ();
    };

    const disposeKeyboard = () => {
      if (kbdPanel) { kbdPanel.destroy(); kbdPanel = null; }
    };

    const showSummary = () => {
      if (!active()) return;
      disposeKeyboard();
      backHandlerFn = null;
      const completed = items.filter((x) => x.summary);
      const correct = completed.filter((x) => x.summary.wrongAttempts === 0).length;
      const total = items.length;
      mountCompletion(main, {
        title: '例句拼字完成',
        scoreText: `${correct} / ${total}`,
        stats: [
          { num: total, label: '題數' },
          { num: completed.length, label: '完成' },
          { num: correct, label: '零錯字' },
        ],
        onAgain: goStudy,
      });
      const note = document.createElement('p');
      note.className = 'muted small';
      note.textContent = '本模式為逐字提示的學習活動；完成紀錄 hinted=true，不列入短複測或盲打統計。';
      main.querySelector('.completion')?.appendChild(note);
    };

    const recordCompletion = (item, summary) => {
      if (item.recorded) return;
      item.recorded = true;
      if (!active()) return;
      try {
        page.assertActive();
      } catch {
        dispose();
        return;
      }
      // 只寫本模式自己的 hinted 學習紀錄；addEvent 以捕捉到的 owner 分區寫入。
      // 欄位依使用者裁決：wordId／session／sourceSentenceId／lemma／surface／everWrong。
      // 這是 generic events 格式（store 的 events store），不改 DB schema；型別不是 quiz／recheck。
      void addEvent(SENTENCE_EVENT, summary.wordId, {
        hinted: true,
        mode: 'sentence-spell',
        session: sessionId,
        sessionId,
        wordId: summary.wordId,
        sourceSentenceId: summary.sourceSentenceId,
        lemma: summary.lemma,
        surface: summary.surface,
        everWrong: summary.wrongAttempts > 0,
        wrongAttempts: summary.wrongAttempts,
        repeated: item.question.repeated === true,
      }, { owner: page });
    };

    const renderCard = (item, summary) => {
      if (!active()) return;
      const host = main.querySelector('#ss-card');
      if (!host || !summary) return;
      host.replaceChildren();
      // 重用既有單詞卡元件（miniCardHtml 內部對字庫文字做 escapeHtml）；只在完成後建立。
      const card = document.createElement('div');
      card.className = 'mini-card';
      card.appendChild(el(miniCardHtml(item.word, summary.surface)));

      const meta = document.createElement('p');
      meta.className = 'tp-caption';
      const wordMeaning = (item.word.senses || [])[0] || summary.meaning;
      meta.textContent = `原形：${summary.lemma}；句中形式：${summary.surface}；意思：${wordMeaning}`;
      card.appendChild(meta);

      if (summary.wrongAttempts > 0) {
        const err = document.createElement('p');
        err.className = 'tp-caption';
        err.textContent = `本題曾打錯 ${summary.wrongAttempts} 次（錯誤歷史保留；改正後仍算曾打錯）。`;
        card.appendChild(err);
      }

      const src = document.createElement('p');
      src.className = 'tp-caption';
      src.textContent = `例句：${summary.en}／${summary.meaning}`;
      card.appendChild(src);      host.appendChild(card);
    };

    const renderQ = () => {
      if (!active()) return;
      renderToken += 1;
      const token = renderToken;
      disposeKeyboard();
      const item = items[idx];
      const state = stateOf(item);

      const onQuit = async () => {
        if (!active()) return;
        const ok = await openDialog({
          title: '提前結束',
          body: '已完成的題目會保留 hinted 學習紀錄；未完成的題目不會寫入。',
          okText: '結束',
        });
        if (!ok) return;
        if (!active()) return;
        await goStudy();
      };

      const shell = mountShell(main, {
        typeLabel: '例句拼字',
        cur: idx + 1,
        total: items.length,
        canPrev: idx > 0,
        canNext: idx < items.length - 1,
        onPrev: () => { if (idx > 0) { idx -= 1; renderQ(); } },
        onNext: () => { if (idx < items.length - 1) { idx += 1; renderQ(); } },
        onQuit,
      });
      // mountShell 已把 onQuit 掛成情境返回；保留同一個函式本體供離場時精準清除。
      backHandlerFn = onQuit;

      const board = document.createElement('div');
      board.className = 'spell-board sentence-spell';

      const sentence = document.createElement('p');
      sentence.className = 'spell-sent';
      sentence.id = 'ss-sentence';
      board.appendChild(sentence);

      const input = document.createElement('input');
      input.className = 'spell-input';
      input.id = 'ss-input';
      input.autocomplete = 'off';
      input.autocapitalize = 'off';
      input.spellcheck = false;
      input.setAttribute('aria-label', '例句拼字輸入');
      input.style.position = 'absolute';
      input.style.opacity = '0';
      input.style.width = '1px';
      input.style.height = '1px';
      input.style.padding = '0';
      input.style.border = '0';
      board.appendChild(input);

      const hint = document.createElement('p');
      hint.className = 'tp-caption';
      hint.id = 'ss-hint';
      hint.textContent = '看例句拼出被挖空的字：打錯的字母會變紅，下一個字母直接覆蓋即可。';
      board.appendChild(hint);

      const cardHost = document.createElement('div');
      cardHost.id = 'ss-card';
      board.appendChild(cardHost);

      shell.content.appendChild(board);
      sentence.addEventListener('click', () => input.focus());

      if (state) {
        buildSentenceDom(sentence, state);
        paint(sentence, state);
      }

      kbdPanel = mountSpellKeyboard(input, {
        expanded: kbdPref === null ? undefined : kbdPref,
        onToggle: (next) => { kbdPref = next; },
      });
      shell.content.appendChild(kbdPanel.root);
      input.focus();

      if (state && state.completed) {
        if (!item.summary) item.summary = completionSummary(state);
        if (!item.recorded) recordCompletion(item, item.summary);
        if (!active()) return;
        renderCard(item, item.summary);
        input.readOnly = true;
        hint.textContent = '這個字已完成：按 Enter 換下一題（最後一題會顯示完成畫面）。';
        addNextButton(shell, items[idx]);
      }

      const paintAndFinish = () => {
        if (!active() || token !== renderToken) return;
        paint(sentence, state);
        if (state && state.completed && !item.recorded) {
          if (!item.summary) item.summary = completionSummary(state);
          recordCompletion(item, item.summary);
          if (!active()) return;
          renderCard(item, item.summary);
          input.readOnly = true;
          hint.textContent = '這個字已完成：按 Enter 換下一題（最後一題會顯示完成畫面）。';
          addNextButton(shell, items[idx]);
        }
      };

      const feed = (chars) => {
        if (!active() || token !== renderToken) return;
        if (!state || state.completed) return;
        for (const ch of chars) {
          if (!LETTER_RX.test(ch)) continue;
          typeLetter(state, ch);
          if (state.completed) break;
        }
        paintAndFinish();
      };

      // 實際字元輸入（含虛擬鍵盤以外的系統輸入）由 input／compositionend 消費；
      // 實體鍵盤的單一字母則由 keydown 消費並 preventDefault（避免同一鍵再觸發 input 而重複計入）。
      const consumeTypedInput = (event) => {
        if (!active() || token !== renderToken) return;
        // 組字（IME）期間不改動輸入框、不評分；等 compositionend 一次取用，避免重複計數。
        if (event && event.isComposing) return;
        const typed = input.value;
        if (!typed) return;
        input.value = '';
        feed([...typed]);
      };
      input.addEventListener('input', consumeTypedInput);
      input.addEventListener('compositionend', consumeTypedInput);

      input.addEventListener('keydown', (event) => {
        if (!active() || token !== renderToken) return;
        // IME 組字中的 keydown（含 Process／229）交給 input／compositionend，不評分也不攔預設。
        if (event.isComposing || event.key === 'Process' || event.keyCode === 229) return;
        // Ctrl／Meta／Alt 是快捷鍵（例如 Ctrl+X 剪下）：不當作答、也不 preventDefault。
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (event.key === 'Enter') {
          event.preventDefault();
          if (state && state.completed) goNext();
          return;
        }
        if (event.key === 'Backspace') {
          // 已核准方向：打錯的字母直接覆蓋，不需要退格；正確格受保護。
          event.preventDefault();
          return;
        }
        if (typeof event.key !== 'string' || [...event.key].length !== 1) return;
        event.preventDefault();
        feed([event.key]);
      });

      function addNextButton(shellNode, current) {
        if (shellNode.content.querySelector('#ss-next')) return;
        const btn = document.createElement('button');
        btn.className = 'btn primary';
        btn.type = 'button';
        btn.id = 'ss-next';
        btn.textContent = current === items[items.length - 1] ? '查看成績' : '下一題';
        btn.addEventListener('click', () => {
          if (!active()) return;
          if (idx >= items.length - 1) showSummary();
          else { idx += 1; renderQ(); }
        });
        shellNode.content.appendChild(btn);
      }
    };

    renderQ();
  }

  run();
  return { dispose };
}

/** 依 core 的 layout 建立題目 DOM；所有文字走 textContent，offset 對應原句。 */
function buildSentenceDom(host, state) {
  const fragment = document.createDocumentFragment();
  const { parts } = state.layout;
  for (const part of parts) {
    if (part.type === 'text') {
      fragment.appendChild(document.createTextNode(part.text));
      continue;
    }
    const group = document.createElement('span');
    group.className = 'spell-sent-target';
    for (const c of part.chars) {
      if (c.type === 'static') {
        const s = document.createElement('span');
        s.className = 'ss-static';
        s.textContent = c.ch;
        group.appendChild(s);
        continue;
      }
      const slot = document.createElement('span');
      slot.className = 'spell-slot';
      const entry = { index: c.index, expected: c.expected };
      SLOT_INDEX.set(slot, entry);
      slot.setAttribute('aria-label', `第 ${c.index + 1} 個字母`);
      group.appendChild(slot);
    }
    fragment.appendChild(group);
  }
  host.replaceChildren(fragment);
}

/** 只更新格子的狀態／顯示字母；完成前絕不寫入答案。 */
function paint(host, state) {
  if (!state) return;
  for (const slot of host.querySelectorAll('.spell-slot')) {
    const entry = SLOT_INDEX.get(slot);
    if (!entry) continue;
    const i = entry.index;
    const status = state.status[i];
    slot.classList.remove('spell-slot--ok', 'spell-slot--bad', 'spell-slot--at');
    if (status === 'ok') {
      // 打對：顯示「這一個出現處」自己的原始字元（各 occurrence 保留各自 casing／標點／Unicode）。
      slot.textContent = entry.expected;
      slot.classList.add('spell-slot--ok');
    } else if (status === 'bad') {
      // 打錯：共用同一作答狀態，顯示實際輸入的字母。
      slot.textContent = state.shown[i];
      slot.classList.add('spell-slot--bad');
    } else {
      slot.textContent = '';
    }
    if (!state.completed && i === state.pos) slot.classList.add('spell-slot--at');
  }
}

export default { SENTENCE_EVENT, describeSkips, prepareSentenceSession, startSentenceSpellStudy };
