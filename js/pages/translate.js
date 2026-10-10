// ============================================================
// 頁面：翻譯題（2.1.0 改為一句/題）——兩種來源共用此作答介面
// 1) 本頁「AI 翻譯題」：學測風格（一句中文＋提示字），來源＝不會單字／單詞本
// 2) 「練習 → 中譯英」（startZhToEn 進入）：勾選單詞本出題，句中自然包含
//    單詞本單字但「不標提示」，學測難度，可含其他單字
// 作答後顯示標準答案／可替代答案／解析；AI 批改一句滿分 4 分。
// ============================================================
import { getWords, loadWords } from '../services/vocab.js';
import { addEvent, getWordbooks } from '../services/store.js';
import { generateJSON } from '../services/ai/index.js';
import { el, escapeHtml, ICONS } from '../core/ui.js';

let session = null; // { source:'standalone'|'practice', showHints, questions, idx }

const QUESTION_PROMPT_HEAD = `你是台灣高中英文老師，正在幫高三學生出「學測風格翻譯題」練習（中譯英）。
請根據下列目標單字出題，規則：
1. 每題一句中文，句子要自然用到該題的目標單字（一題一個目標字，讓每個目標字都出現一次）
2. 仿學測格式：句末以「（提示：英文關鍵字詞）」標示翻譯時應使用的字詞（目標字或其常見變化／搭配詞）
3. 句子長度與難度比照學測，適合高三學生
4. 每題提供標準答案（英譯）、可替代答案（1～2 種同樣可接受的譯法）、重點解析（繁體中文，60 字內，說明搭配詞與句型）
5. 只輸出 JSON，不要任何其他文字，格式：
{"questions":[{"words":["目標字"],"zh":"中文句","hint":"提示字詞","std":"英文句","alt":"可替代英譯","note":"重點解析"}]}

目標單字（JSON）：
`;

const ZH2EN_PROMPT_HEAD = `你是台灣高中英文老師，正在出「中譯英」練習題（難度比照學測）。
規則：
1. 每題一句中文；句中要自然包含指定單字中的至少一個——不要標示是哪些字、不要加任何提示
2. 句子可以搭配其他單字；主題多樣（校園、生活、社會、環境、科技等）
3. 句子長度與難度比照學測，適合高三學生
4. 每題提供標準答案（英譯）、可替代答案（1 種同樣可接受的譯法）、重點解析（繁體中文，60 字內）
5. 只輸出 JSON，不要任何其他文字，格式：
{"questions":[{"used":["用到的單字"],"zh":"中文句","std":"英文句","alt":"可替代英譯","note":"重點解析"}]}

可使用的單字（JSON）：
`;

const GRADE_PROMPT_HEAD = `你是大學學測英文科的閱卷老師。以下是翻譯題（中譯英，一句，滿分 4 分）的批改任務。
請以學測閱卷標準批改學生的翻譯：
- score：0～4 整數（句意完整、文法正確、用字恰當的程度）
- verdict：「優」/「尚可」/「需加強」
- issues：錯誤或可改進處（繁體中文；每條引用學生原文片段並說明問題，無錯誤則空陣列）
- fixed：建議修改後的英文句（學生句子已正確時給與原句相同的句子）
只輸出 JSON，不要任何其他文字，格式：
{"score":0,"verdict":"","issues":[""],"fixed":"","comment":"總評（繁體中文 60 字內）"}

題目（中文、提示與標準答案，JSON）：
`;

export function renderTranslate(main) {
  if (session) renderSession(main);
  else renderSetup(main);
}

// 「練習 → 中譯英」入口：practice.js 生成題目後呼叫
export function startZhToEn(questions) {
  session = { source: 'practice', showHints: false, questions, idx: 0 };
  location.hash = '#/translate';
}

// ---------- 設定畫面（僅本頁 AI 翻譯題用） ----------
async function renderSetup(main) {
  await loadWords();
  const wordsById = new Map(getWords().map((w) => [w.id, w]));
  const books = (await getWordbooks())
    .map((b) => ({ ...b, wordIds: b.wordIds.filter((id) => wordsById.has(id)) }))
    .filter((b) => b.wordIds.length > 0);

  if (books.length === 0) {
    main.replaceChildren(el(`
      <section class="card">
          <p class="warning">還沒有可出題的單詞本。先到「練習」加入單詞本並保存，再到這裡出題。</p>
      </section>`));
    return;
  }

  // 預設：全部勾選；題數預設 = 去重後單字總數（上限 10）
  const uniqueCountOf = (checkedIds) => {
    const pool = books
      .filter((b) => checkedIds.includes(String(b.id)))
      .flatMap((b) => b.wordIds);
    return new Set(pool).size;
  };
  const allIds = books.map((b) => String(b.id));
  let maxN = uniqueCountOf(allIds);
  let count = Math.min(maxN, 10);

  const bookChecks = books.map((b) => `
      <label class="level-item">
        <input type="checkbox" name="tr-book" value="${escapeHtml(String(b.id))}" checked>
        <span>${escapeHtml(b.name)}（${b.wordIds.length} 字）</span>
      </label>`).join('');

  const page = el(`
    <section class="card">
      <p class="muted">每題一句中譯英（含提示字），由 AI 依你勾選的單詞本即時出題，附標準答案、可替代答案與 AI 批改。</p>
      <div class="scope-head">
        <span class="st">出題範圍（單詞本，可複選）</span>
        <span class="scope-actions">
          <button class="btn" id="btn-scope-all">全選</button>
          <button class="btn" id="btn-scope-none">全不選</button>
        </span>
      </div>
      <div class="scope-list" id="scope-list">${bookChecks}</div>
      <p class="warning" id="scope-warning"></p>
      <div class="scope-head">
        <span class="st">題數</span>
        <span class="muted small" id="count-max-label">可出題上限：${maxN}</span>
      </div>
      <div class="count-row">
        <input type="number" id="tr-count-num" min="1" max="${maxN}" value="${count}">
        <input type="range" id="tr-count-slider" min="1" max="${maxN}" value="${count}">
      </div>
      <p class="warning" id="tr-warning"></p>
      <button class="btn primary" id="btn-generate">生成翻譯題（約 10～20 秒）</button>
    </section>`);

  // ---- 全選／全不選 ----
  page.querySelector('#btn-scope-all').addEventListener('click', () => {
    page.querySelectorAll('#scope-list input').forEach((i) => { i.checked = true; });
    syncMax();
  });
  page.querySelector('#btn-scope-none').addEventListener('click', () => {
    page.querySelectorAll('#scope-list input').forEach((i) => { i.checked = false; });
    syncMax();
  });

  // ---- 依勾選重算可出題上限（去重）----
  const checkedIdsNow = () => [...page.querySelectorAll('#scope-list input:checked')].map((i) => i.value);
  function syncMax() {
    maxN = uniqueCountOf(checkedIdsNow());
    page.querySelector('#count-max-label').textContent = `可出題上限：${maxN}`;
    const num = page.querySelector('#tr-count-num');
    const slider = page.querySelector('#tr-count-slider');
    num.max = String(maxN);
    slider.max = String(maxN);
    if (Number(num.value) > maxN) num.value = String(maxN);
    if (Number(slider.value) > maxN) slider.value = String(maxN);
    count = Number(num.value);
  }
  page.querySelectorAll('#scope-list input').forEach((i) =>
    i.addEventListener('change', syncMax));

  // ---- 題數：滑桿與數字輸入同步 ----
  const num = page.querySelector('#tr-count-num');
  const slider = page.querySelector('#tr-count-slider');
  num.addEventListener('input', () => {
    let v = Math.max(1, Math.min(maxN, Number(num.value) || 1));
    slider.value = String(v);
  });
  num.addEventListener('change', () => {
    let v = Math.max(1, Math.min(maxN, Number(num.value) || 1));
    num.value = String(v);
    slider.value = String(v);
  });
  slider.addEventListener('input', () => {
    num.value = slider.value;
  });

  // ---- 生成 ----
  page.querySelector('#btn-generate').addEventListener('click', async () => {
    const warn = page.querySelector('#tr-warning');
    const checked = checkedIdsNow();
    if (checked.length === 0) {
      warn.textContent = '請至少勾選一本單詞本';
      return;
    }
    const n = Math.min(count, maxN);
    const pool = books
      .filter((b) => checked.includes(String(b.id)))
      .flatMap((b) => b.wordIds)
      .map((id) => wordsById.get(id))
      .filter(Boolean);
    const uniq = [...new Map(pool.map((w) => [w.id, w])).values()];
    const words = shuffle(uniq).slice(0, n);
    if (words.length === 0) {
      warn.textContent = '選擇的範圍裡沒有單字';
      return;
    }

    main.replaceChildren(el(`
      <section class="card">
          <p>正在出 ${words.length} 題…請稍候</p>
        <p class="muted">生成約需 10～20 秒，若網路不穩會自動重試。</p>
      </section>`));

    try {
      const questions = await generateExamQuestions(words, words.length);
      session = { source: 'standalone', showHints: true, questions, idx: 0 };
      renderSession(main);
    } catch (err) {
      session = null;
      main.replaceChildren(el(`
        <section class="card">
          <p class="warning">生成失敗：${escapeHtml(String(err.message || err))}</p>
          <!-- 5.0.4 C 項：這顆是「回到設定頁重試」的**動作鈕**（不是頁內返回鈕），故保留；
               措辭由「返回重試」改為「重新嘗試」以免與已移除的返回鈕混淆。 -->
          <button class="btn primary" id="btn-retry">${ICONS.refresh} 重新嘗試</button>
        </section>`));
      main.querySelector('#btn-retry').addEventListener('click', () => renderTranslate(main));
    }
  });

  main.replaceChildren(page);
}

// ---------- 分組與生成 ----------
function payloadOf(words) {
  return words.map((w) => ({
    word: w.word,
    pos: w.pos,
    meaning: w.dictBrief || (w.senses || []).join('；'),
  }));
}

function normalizeQuestions(raw) {
  const questions = (raw.questions || [])
    .filter((q) => q.zh && q.std)
    .map((q) => ({
      words: q.words || q.used || [],
      zh: stripHint(q.zh || ''),
      hint: q.hint || '',
      std: q.std || '',
      alt: q.alt || '',
      note: q.note || '',
      userAnswer: '',
      submitted: false,
      grading: null,
    }));
  if (questions.length === 0) throw new Error('AI 回傳的題目格式無法解析，請重試一次');
  return questions;
}

// AI 有時把「（提示：…）」寫進中文句裡，先清掉（畫面統一由 hint 欄位呈現）
function stripHint(zh) {
  return String(zh)
    .replace(/（提示：[^）]*）/g, '')
    .replace(/\(提示：[^)]*\)/g, '')
    .replace(/（提示:[^）]*）/g, '')
    .trim();
}

async function generateExamQuestions(words, n) {
  const resp = await generateJSON(
    QUESTION_PROMPT_HEAD + JSON.stringify(payloadOf(shuffle(words).slice(0, n)), null, 0));
  return normalizeQuestions(resp);
}

// 供「練習 → 中譯英」使用（無提示格式）
export async function generateZhToEnQuestions(words, n) {
  const resp = await generateJSON(
    ZH2EN_PROMPT_HEAD + JSON.stringify(payloadOf(shuffle(words).slice(0, n)), null, 0));
  return normalizeQuestions(resp);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- 作答畫面 ----------
function renderSession(main) {
  const q = session.questions[session.idx];
  const submitted = q.submitted;
  const title = session.source === 'practice' ? '中譯英練習' : 'AI 翻譯題';
  const meta = session.showHints
    ? `目標字：${q.words.map((w) => escapeHtml(w)).join('、')}`
    : `句中包含你勾選單詞本裡的單字`;

  const answerBlock = submitted ? `
      <div class="tr-answers">
        <div class="tr-answer-line"><span class="tr-label">標準答案</span>${escapeHtml(q.std)}</div>
        ${q.alt ? `<div class="tr-answer-line alt"><span class="tr-label">可替代</span>${escapeHtml(q.alt)}</div>` : ''}
        ${q.note ? `<p class="tr-note">${escapeHtml(q.note)}</p>` : ''}
      </div>` : '';

  const gradingBlock = submitted && q.grading ? gradingElement(q) : '';

  const page = el(`
    <section class="card">
      <div class="status">【${title}】第 ${session.idx + 1} / ${session.questions.length} 題 · ${meta}</div>
      <div class="tr-question">
        <div class="tr-line">
          <span class="tr-no">1</span>
          <span>${escapeHtml(q.zh)}${session.showHints && q.hint ? `（提示：${escapeHtml(q.hint)}）` : ''}</span>
        </div>
      </div>
      ${submitted ? `
        <div class="tr-user"><span class="tr-label">你的翻譯</span>${escapeHtml(q.userAnswer || '（未作答）')}</div>
        ${answerBlock}
        <div id="tr-grading"></div>
      ` : `
        <textarea id="tr-input" rows="2" placeholder="在此輸入英文翻譯…"></textarea>
      `}
      <div class="controls">
        ${submitted
          ? `<button class="btn primary" id="btn-next">${session.idx < session.questions.length - 1 ? `下一題 ${ICONS.chevronRight}` : '完成練習'}</button>`
          : `<button class="btn primary" id="btn-submit">提交對答案</button>`}
        ${submitted && q.userAnswer && !q.grading ? `<button class="btn" id="btn-grade">AI 批改</button>` : ''}
        <button class="btn subtle" id="btn-quit">結束（${session.source === 'practice' ? '回練習選單' : '回設定'}）</button>
      </div>
    </section>`);

  if (!submitted) {
    page.querySelector('#btn-submit').addEventListener('click', () => {
      q.userAnswer = page.querySelector('#tr-input').value.trim();
      q.submitted = true;
      addEvent('translate', null, { words: 1 }); // 統計（2.0.13 起）
      renderSession(main);
      main.querySelector('.tr-answers')?.scrollIntoView({ behavior: 'smooth' });
    });
  } else {
    page.querySelector('#btn-next').addEventListener('click', () => {
      if (session.idx < session.questions.length - 1) {
        session.idx++;
        renderSession(main);
      } else {
        renderSummary(main);
      }
    });
    page.querySelector('#btn-grade')?.addEventListener('click', () => runGrading(main, q));
  }
  page.querySelector('#btn-quit').addEventListener('click', () => {
    const source = session?.source;
    session = null;
    if (source === 'practice') {
      location.hash = '#/practice'; // hashchange 會渲染練習選單
    } else {
      renderTranslate(main);
    }
  });

  main.replaceChildren(page);
}

// ---------- AI 批改（一句滿分 4 分） ----------
async function runGrading(main, q) {
  q.grading = { loading: true };
  renderGradingInto(main, q);
  const payload = {
    zh: q.zh,
    hint: q.hint,
    std: q.std,
    student: q.userAnswer,
  };
  try {
    const resp = await generateJSON(GRADE_PROMPT_HEAD + JSON.stringify(payload, null, 0));
    q.grading = { done: true, ...resp };
  } catch (err) {
    q.grading = { done: true, error: String(err.message || err) };
  }
  renderGradingInto(main, q);
  main.querySelector('.tr-grading')?.scrollIntoView({ behavior: 'smooth' });
}

function renderGradingInto(main, q) {
  const box = main.querySelector('#tr-grading');
  if (!box) return;
  box.replaceChildren(gradingElement(q));
}

function gradingElement(q) {
  const g = q.grading;
  if (g?.loading) {
    return el('<p class="muted">AI 批改中…（約 5～15 秒）</p>');
  }
  if (g?.error) {
    return el(`<p class="warning">批改失敗：${escapeHtml(g.error)}（可再按一次 AI 批改重試）</p>`);
  }
  if (g?.score === undefined) {
    return el('<p class="warning">批改結果格式異常，請重試。</p>');
  }
  const verdict = g.verdict || '';
  const rows = (g.issues || []).map((x) => `<div class="grade-issue">${escapeHtml(x)}</div>`).join('')
    || '<div class="grade-issue ok">無明顯錯誤</div>';
  return el(`
    <div class="tr-grading">
      <div class="grade-head">
        <span>AI 批改</span>
        <span class="grade-score">${g.score} / 4</span>
        <span class="grade-verdict v-${verdict === '優' ? 'good' : verdict === '尚可' ? 'mid' : 'bad'}">${escapeHtml(verdict)}</span>
      </div>
      ${rows}
      ${g.fixed ? `<div class="grade-fixed"><span class="tr-label">建議</span>${escapeHtml(g.fixed)}</div>` : ''}
      ${g.comment ? `<p class="grade-comment">${escapeHtml(g.comment)}</p>` : ''}
    </div>`);
}

// ---------- 完成畫面 ----------
// 5.1.1 B4：作答數字掛 d2-finish-score 彈入（本引擎唯一取得的動效）。
// 【不掛彩帶】core/celebrate.js 的放彩帶條件是「答對率滿 80%」，但中譯英在作答當下
//   沒有對錯判定，對錯要等使用者事後按「AI 批改」才出來——完成畫面此刻只有作答率，
//   拿它冒充答對率去放彩帶等於對不準就慶祝，故這裡只彈分數（寧可少慶祝也不猜）。
function renderSummary(main) {
  const source = session.source;
  const answered = session.questions.filter((q) => q.userAnswer).length;
  const page = el(`
    <section class="card">
      <h2>練習完成</h2>
      <p><span class="d2-finish-score">共 ${session.questions.length} 題，你作答了 ${answered} 題。</span> 核對完答案後可再出一份新題。</p>
      <button class="btn primary" id="btn-again">${source === 'practice' ? '回練習選單' : '再出一份新題'}</button>
    </section>`);
  page.querySelector('#btn-again').addEventListener('click', () => {
    session = null;
    if (source === 'practice') location.hash = '#/practice';
    else renderTranslate(main);
  });
  main.replaceChildren(page);
}

