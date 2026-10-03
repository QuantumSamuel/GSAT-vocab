// ============================================================
// 引擎：選擇練習（4.3.1 批次 2）——單選／克漏字／文意選填
//
// 4.3.1 批次 2（spec「批次 2」六項）：
//   ① 子分頁移除題型 <select>——題型只由 URL ?type=（single/cloze/discourse）決定；
//      設定畫面改為「範圍（題庫來源）＋題數（5/10/15/全部）」
//   ② 題庫來源 bank-picker 複選：self-made（selection.json 的 single）
//      ／real（real.json：single→詞彙題、cloze→綜合測驗、discourse→文意選填）
//      ／ai（5.0：data/questions/ai/ 六檔經 ai-bank.js 攤平；含詞彙／綜合／篇章）
//      ／archive（5.2：data/questions/archive/archive_v1.json 經 archive-bank.js 攤平；
//      大考中心歷屆題目整理，單選←詞彙題 843／克漏字←綜合測驗整組／文意選填←56 篇）
//      可複選混合抽題，每題渲染時顯示來源小徽章
//   ③ 解析：自製／AI／考古題直接用 explanation；真題沒有 explanation → 顯示提示
//   ④ 答題後每個選項可點 → 展開迷你單詞卡（word-card.js），可「加入單詞本／加入複習」
//      收集到 run.joinPool
//   ⑤ 完成畫面（提前結束或全部答完）由 mountJoinPanel 提供「新建／合併單詞本」
//   ⑥ 克漏字／文意選填的來源徽章與題庫混合同樣適用（real.json 區段過濾）
//
// 資料端註記：real.json 的 N 卷克漏字題組有 stem 缺漏、OCR 把答案句中的數字
// 也寫成「nn.」形式，整組無法可靠還原標記 → 過濾掉（N 卷不進本練習的克漏字池）。
//
// 【5.2 考古題的兩處刻意差異】
//   ① 克漏字標記還原不走 toClozeGroups：考古題上游的標記是「{11}」而非 real.json 的
//      裸「nn.」，句中另有不相干的數字（"at the age of 41"），用裸數字正則必然錯位
//      → 改用 archive-bank.js 的 archiveClozeGroups（精確 {NN} 還原）。
//   ② 考古題是非阻塞載入（5.0 起的效能紅線）：題數由 applyNonBlockingCounts 一併回填，
//      進頁面不等 3.2MB 的 archive_v1.json。
// ============================================================
import { el, escapeHtml, emptyState, openDialog, toast } from '../core/ui.js';
import { mountShell, mountCompletion, shuffle } from './shell.js';
import { addEvent } from '../services/store.js';
import { loadWords, loadExam } from '../services/vocab.js';
import { bankPickerHTML, readBankSelection } from '../core/bank-picker.js';
import { findWordWithLemma, mountMiniCard, mountJoinPanel } from './word-card.js';
import { loadAiBank } from './ai-bank.js';
import { archiveClozeGroups, archiveDiscourseItems, archiveSingleItems, loadArchiveBank } from './archive-bank.js';

const TYPES = ['single', 'cloze', 'discourse'];
const TYPE_LABEL = { single: '單選', cloze: '克漏字', discourse: '文意選填' };
const REAL_SECTION = { single: '詞彙題', cloze: '綜合測驗', discourse: '文意選填' };
const COUNT_OPTS = ['5', '10', '15', 'all'];

const SELF_URL = 'data/questions/selection.json';
const REAL_URL = 'data/questions/real.json';

// ---------- 題庫載入（模組級快取；失敗不鎖死、可重試） ----------
const selfCache = new Map();
const realCache = new Map();

async function loadSelf() {
  if (!selfCache.has('p')) {
    const p = (async () => {
      const res = await fetch(SELF_URL, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`自製題庫載入失敗（${res.status}）`);
      const data = await res.json();
      return {
        single: Array.isArray(data.single) ? data.single : [],
        cloze: Array.isArray(data.cloze) ? data.cloze : [],
        discourse: Array.isArray(data.discourse) ? data.discourse : [],
      };
    })();
    selfCache.set('p', p);
    p.catch(() => selfCache.delete('p')); // 失敗可重試
  }
  return selfCache.get('p');
}
async function loadReal() {
  if (!realCache.has('p')) {
    const p = (async () => {
      const res = await fetch(REAL_URL, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`歷屆真題庫載入失敗（${res.status}）`);
      const data = await res.json();
      if (!Array.isArray(data.questions) || !data.questions.length) throw new Error('歷屆真題資料格式錯誤');
      return data;
    })();
    realCache.set('p', p);
    p.catch(() => realCache.delete('p'));
  }
  return realCache.get('p');
}

const letterIdx = (a) => 'ABCDEFGHIJ'.indexOf(String(a || ''));

// ---------- 各來源正規化：統一成引擎內部的題目格式（並打上來源標記） ----------
// 單選：{ q, options[], answer:index, explanation|null, src:'self-made'|'real'|'ai', srcText }
function realSingle(questions) {
  return questions
    .filter((q) => q.section === '詞彙題' && q.stem && (q.option_texts || []).length >= 2 && letterIdx(q.answer) >= 0)
    .map((q) => ({
      q: q.stem,
      options: q.option_texts,
      answer: letterIdx(q.answer),
      explanation: q.explanation || null,
      src: 'real',
      srcText: `真題 ${q.year}${q.paper}`,
      year: q.year, paper: q.paper, qnum: q.qnum,
    }));
}
function aiSingle(questions) {
  return questions
    .filter((q) => q.section === '詞彙題' && q.stem && (q.option_texts || []).length >= 2 && letterIdx(q.answer) >= 0)
    .map((q) => ({
      q: q.stem,
      options: q.option_texts,
      answer: letterIdx(q.answer),
      explanation: q.explanation || null,
      src: 'ai',
      srcText: 'AI',
    }));
}
function selfSingle(list) {
  return (list || []).map((q) => ({
    q: q.q,
    options: q.options,
    answer: Number(q.answer),
    explanation: q.explanation || null,
    src: 'self-made',
    srcText: '自製',
  }));
}

/**
 * 克漏字整組：把 real.json／AI 題庫的「同一段文章的一組空」轉成引擎格式。
 * 標記還原：題號在 passage 內以「nn.」（OCR 常掉點成裸 nn）出現，
 * 逐題把該處替換成 [i]；任一題的標記找不到就整組丟棄（不產出半截文章）。
 */
function toClozeGroups(questions, src) {
  const groups = new Map();
  for (const q of questions) {
    if (!q.stem || !q.passage || !(q.option_texts || []).length || letterIdx(q.answer) < 0) continue;
    const key = `${q.year ?? ''}${q.paper ?? ''}-${q.group ?? 0}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(q);
  }
  const out = [];
  for (const arr of groups.values()) {
    arr.sort((a, b) => a.qnum - b.qnum);
    let passage = arr[0].passage;
    const items = [];
    let ok = true;
    for (let i = 0; i < arr.length; i++) {
      const q = arr[i];
      const re = new RegExp(`(^|[^\\d])${q.qnum}\\.?(?![\\d])`);
      const m = passage.match(re);
      if (!m) { ok = false; break; }
      const at = m.index + m[1].length;
      const after = passage[at + String(q.qnum).length];
      passage = `${passage.slice(0, at)}[${i + 1}]${passage.slice(at + String(q.qnum).length + (after === '.' ? 1 : 0))}`;
      items.push({
        q: `[${i + 1}]`,
        options: q.option_texts,
        answer: letterIdx(q.answer),
        explanation: q.explanation || null,
        src,
        srcText: src === 'real' ? `真題 ${q.year}${q.paper}` : 'AI',
      });
    }
    if (ok && items.length) out.push({ passage, items });
  }
  return out;
}
function selfClozeGroups(list) {
  return (list || []).map((g) => ({
    passage: g.passage,
    items: g.questions.map((q) => ({
      q: q.q, options: q.options, answer: Number(q.answer),
      explanation: q.explanation || null, src: 'self-made', srcText: '自製',
    })),
  }));
}

/** 文意選填整篇：{ passage, options[], blanks:{'1':word}, src, srcText } */
function toDiscourseItems(questions, src) {
  const groups = new Map();
  for (const q of questions) {
    if (!q.passage || !(q.option_texts || []).length || letterIdx(q.answer) < 0) continue;
    const key = `${q.year ?? ''}${q.paper ?? ''}-${q.group ?? 0}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(q);
  }
  const out = [];
  for (const arr of groups.values()) {
    arr.sort((a, b) => a.qnum - b.qnum);
    const options = arr[0].option_texts;
    // 共用選項池（option_pool: cloze-bank）必須整組一致，否則正解會指到別組的字
    if (arr.some((q) => JSON.stringify(q.option_texts) !== JSON.stringify(options))) continue;
    let passage = arr[0].passage;
    const blanks = {};
    let ok = true;
    for (let i = 0; i < arr.length; i++) {
      const q = arr[i];
      const re = new RegExp(`(^|[^\\d])${q.qnum}\\.?(?![\\d])`);
      const m = passage.match(re);
      if (!m) { ok = false; break; }
      const at = m.index + m[1].length;
      const after = passage[at + String(q.qnum).length];
      passage = `${passage.slice(0, at)}[${i + 1}]${passage.slice(at + String(q.qnum).length + (after === '.' ? 1 : 0))}`;
      blanks[i + 1] = options[letterIdx(q.answer)];
    }
    if (ok && Object.keys(blanks).length) {
      out.push({ passage, options, blanks, src, srcText: src === 'real' ? `真題 ${arr[0].year}${arr[0].paper}` : 'AI' });
    }
  }
  return out;
}
function selfDiscourseItems(list) {
  return (list || []).map((d) => ({ passage: d.passage, options: d.options, blanks: d.blanks, src: 'self-made', srcText: '自製' }));
}

/**
 * 依勾選來源組出該題型的題目池。
 * 回傳 { single:[], cloze:[{passage,items}], discourse:[{passage,options,blanks}] }
 * 四個來源各自轉換後併進同一個陣列；引擎不記得來源，只看 items/dialogue 的形狀，
 * 來源別由每題的 src/srcText 帶到畫面上的徽章（紅線：四種來源不可混淆）。
 *
 * 5.2 補充：兩個非阻塞來源（ai／archive）各自 try/catch。
 * 混勾時單一來源壞掉不能讓整場作廢——使用者勾了「自製＋考古題」，考古題的 500 不該
 * 讓自製題也一題都出不出來。失敗的來源只在 errors 裡記名，由呼叫端在警告列顯示。
 * （blocking 的 self-made／real 維持原行為：它們在進頁面時已載入，這裡失敗＝模組被改壞。）
 */
export async function buildPools(type, selected) {
  const want = new Set(selected);
  const out = { single: [], cloze: [], discourse: [], errors: [] };
  if (want.has('self-made')) {
    const self = await loadSelf();
    if (type === 'single') out.single.push(...selfSingle(self.single));
    else if (type === 'cloze') out.cloze.push(...selfClozeGroups(self.cloze));
    else out.discourse.push(...selfDiscourseItems(self.discourse));
  }
  if (want.has('real')) {
    const real = await loadReal();
    const sec = REAL_SECTION[type];
    const hit = real.questions.filter((q) => q.section === sec);
    if (type === 'single') out.single.push(...realSingle(hit));
    else if (type === 'cloze') {
      // N 卷克漏字：stem 缺漏且 OCR 把句中數字也標成「nn.」，整組還原不可靠 → 排除
      out.cloze.push(...toClozeGroups(hit.filter((q) => q.paper?.startsWith('E')), 'real'));
    } else out.discourse.push(...toDiscourseItems(hit, 'real'));
  }
  if (want.has('ai')) {
    // 5.0：AI 題庫改由 ai-bank.js 攤平（六檔 → 單一題目流，區段名與真題一致）。
    // 文意選填仍對應不到（AI 題庫的對應區段是「篇章結構」，per-question 選項池，
    // 不符 toDiscourseItems 要求的整組共用池）——故文意選填的 AI 來源維持 0。
    try {
      const ai = (await loadAiBank()).questions;
      const sec = REAL_SECTION[type];
      const hit = ai.filter((q) => q.section === sec);
      if (type === 'single') out.single.push(...aiSingle(hit));
      else if (type === 'cloze') out.cloze.push(...toClozeGroups(hit, 'ai'));
      else out.discourse.push(...toDiscourseItems(hit, 'ai'));
    } catch (err) {
      out.errors.push(`AI 題庫：${String(err.message || err)}`);
    }
  }
  if (want.has('archive')) {
    // 5.2：考古題三題型各自對應一個區段（詞彙／綜合／文意選填），轉換函式在 archive-bank.js
    // （克漏字用精確的 {NN} 還原，不用 real.json 的裸數字正則）
    try {
      const arc = await loadArchiveBank();
      if (type === 'single') out.single.push(...archiveSingleItems(arc));
      else if (type === 'cloze') out.cloze.push(...archiveClozeGroups(arc));
      else out.discourse.push(...archiveDiscourseItems(arc));
    } catch (err) {
      out.errors.push(`考古題：${String(err.message || err)}`);
    }
  }
  return out;
}

/**
 * 非阻塞來源（AI／考古題）在此題型的可用題數——設定畫面的 bank-picker 計數回填用。
 * 抽成一個函式讓兩個非阻塞來源走同一條路徑（5.0 與 5.2 的行為一致）。
 */
export async function countPoolFor(type, src) {
  if (src === 'archive') {
    const arc = await loadArchiveBank();
    if (type === 'single') return archiveSingleItems(arc).length;
    if (type === 'cloze') return archiveClozeGroups(arc).length;
    return archiveDiscourseItems(arc).length;
  }
  const ai = (await loadAiBank()).questions;
  const hit = ai.filter((q) => q.section === REAL_SECTION[type]);
  if (type === 'single') return aiSingle(hit).length;
  if (type === 'cloze') return toClozeGroups(hit, 'ai').length;
  return toDiscourseItems(hit, 'ai').length;
}

let run = null; // { type, qs, group, item, idx, correct, results[], subtypeLabel, joinPool:Set, wordsById:Map }

// ---------- 入口：設定＋開始 ----------
export async function renderSelection(main, subtypeLabel = '選擇') {
  const qsType = new URLSearchParams(location.hash.split('?')[1] || '').get('type');
  const type = TYPES.includes(qsType) ? qsType : 'single';
  // 換題型進入時丟棄進行中的舊場景（比照 matching.js）
  if (run && run.type !== type) run = null;
  // 迷你單詞卡要查字庫與考題星級：先確保兩者已載（失敗不擋練習，只影響卡片）
  await loadWords().catch(() => {});
  loadExam().catch(() => {});

  // 非阻塞來源的計數：counts 為 null＝尚未回填（畫面寫「載入中」）；
  // 回填失敗記在 asyncFailed，畫面寫「載入失敗」並停用該來源——兩者都不可勾，
  // 絕不顯示「-1 題」或永遠停在「載入中」（池 B 實測：初值 -1 讓失敗路徑整組失效）。
  let counts = { 'self-made': 0, real: 0, ai: null, archive: null };
  const asyncFailed = new Set();
  let loadErr = '';
  try {
    // self／real 沿用 4.3.1 以來的 blocking 載入（畫面要靠它們的題數決定預設勾選）；
    // AI 題庫與考古題改非阻塞（5.0／5.2 紅線：不得在進頁面路徑新增 blocking fetch），
    // 到位後由 applyAsyncCounts 回填題數與停用狀態
    const [self, real] = await Promise.all([
      loadSelf().catch((err) => { loadErr = String(err.message || err); return null; }),
      loadReal().catch(() => null),
    ]);
    if (self) counts['self-made'] = type === 'single' ? self.single.length : (type === 'cloze' ? self.cloze.length : self.discourse.length);
    if (real) {
      const hit = real.questions.filter((q) => q.section === REAL_SECTION[type]);
      counts.real = type === 'cloze'
        ? toClozeGroups(hit.filter((q) => q.paper?.startsWith('E')), 'real').length
        : type === 'discourse' ? toDiscourseItems(hit, 'real').length : realSingle(hit).length;
    }
  } catch (err) {
    loadErr = String(err.message || err);
  }

  // total 只計 blocking 來源（AI／考古題尚未到位）；self／real 全空＝真的載入失敗或無題
  const total = counts['self-made'] + counts.real;
  if (!total) {
    warnEmpty(main, loadErr || `題庫載入失敗。`);
    return;
  }

  // 來源說明（四種來源各有其代表性，寫死在一處；回填時重組同一句）
  const SRC_HINT = '自製＝本站編寫的練習題（非考題、非 AI 生成）；真題＝歷屆考題；AI＝AI 生成、經逐題人工複核；考古題＝大考中心歷屆題目（含參考試卷）整理。';
  /** 非阻塞來源的計數文字：null→「…（載入中）」、失敗→「…（載入失敗）」、其餘為數字 */
  const asyncCountText = (src) => {
    if (counts[src] == null) return asyncFailed.has(src) ? '…（載入失敗）' : '…（載入中）';
    return `${counts[src]}${counts[src] === 0 ? '（此題型無題）' : ''}`;
  };
  const noteText = () => `${SRC_HINT}此題型目前可用題數：自製 ${counts['self-made']}／真題 ${counts.real}／AI ${asyncCountText('ai')}／考古題 ${asyncCountText('archive')}`;

  main.replaceChildren(el(`
    <section class="card">
      <h2>選擇・${TYPE_LABEL[type]}</h2>
      <p class="muted small">題型由練習首頁決定（${escapeHtml(TYPE_LABEL[type])}）；可複選題庫來源，系統會混合抽題，每題都會標示來源。</p>
      <div class="settings-list" id="sel-settings">
        <div class="settings-row settings-row--stack">
          <div class="settings-row-title">
            <h3 class="tp-card-title">題庫來源</h3>
            <p class="tp-caption">可複選：自製／歷屆真題／AI 題庫／考古題</p>
          </div>
          <div class="settings-row-main">
            ${bankPickerHTML({
              name: 'sel-bank',
              multiple: true,
              checked: counts['self-made'] ? ['self-made'] : (counts.real ? ['real'] : ['ai']),
              sources: [
                { id: 'self-made', label: '自製題（站內編寫）', count: counts['self-made'] },
                { id: 'real', label: '歷屆真題', count: counts.real },
                { id: 'ai', label: 'AI 題庫', count: null }, // 非阻塞：題數由 applyAsyncCounts 回填
                { id: 'archive', label: '考古題（大考中心歷屆）', count: null },
              ],
            })}
            <p class="settings-note muted small">${escapeHtml(noteText())}</p>
          </div>
        </div>
        <div class="section-divider"></div>
        <div class="settings-row">
          <div class="settings-row-title">
            <h3 class="tp-card-title">題數</h3>
            <p class="tp-caption">「全部」＝勾選來源中此題型的全部可用題</p>
          </div>
          <div class="settings-row-main">
            <div class="segmented" role="radiogroup" aria-label="題數">
              ${COUNT_OPTS.map((v, i) => `<label><input type="radio" name="sel-count" value="${v}"${i === 0 ? ' checked' : ''}><span>${v === 'all' ? '全部' : v}</span></label>`).join('')}
            </div>
          </div>
        </div>
      </div>
      <div class="controls"><button class="btn primary" id="sel-start">開始練習</button></div>
      <p class="warning" id="sel-warn"></p>
    </section>`));

  // 數量為 0 的來源：停用並淡出（AI／考古題題數非阻塞，由 applyAsyncCounts 處理，不在這裡判）
  // 整列換成帶 .bank-item--empty 的版本（bank-picker.js 是批次 0 共用檔，本檔不動它）
  main.querySelectorAll('.bank-picker input[name="sel-bank"]').forEach((i) => {
    if (counts[i.value] || i.value === 'ai' || i.value === 'archive') return;
    const label = i.closest('.bank-item');
    if (!label) return;
    const faded = el(`<label class="bank-item bank-item--empty">${label.innerHTML}</label>`);
    const input = faded.querySelector('input');
    input.checked = false;
    input.disabled = true;
    label.replaceWith(faded);
  });

  /**
   * 5.0＋5.2：兩個非阻塞來源（AI 題庫、考古題）共用同一條回填路徑。
   * applyAsyncCounts(src, n)：n 為數字＝回填成功；n 為 null＝載入失敗。
   * 兩種情況都必須「顯示一個明確狀態 + 停用不可勾」，差異只在文字：
   *   失敗 → 「載入失敗」＋淡出停用；零題 → 「0 題（此題型無題）」＋淡出停用；成功 → 數字。
   * 停在「載入中」或顯示「-1 題」都是壞掉的畫面（池 B 實測）。
   */
  const applyAsyncCounts = (src) => (n) => {
    const input = main.querySelector(`.bank-picker input[name="sel-bank"][value="${src}"]`);
    if (!input) return; // 已離開設定畫面（main 被 replaceChildren 過）
    if (n == null) asyncFailed.add(src);
    else counts[src] = n;
    const label = input.closest('.bank-item');
    const countEl = label?.querySelector('.bank-item-count');
    if (countEl) countEl.textContent = n == null ? '載入失敗' : `${n} 題`;
    const unavailable = n == null || n === 0;
    if (label) label.classList.toggle('bank-item--empty', unavailable);
    if (unavailable) { input.checked = false; input.disabled = true; }
    const note = main.querySelector('.settings-note');
    if (note) note.textContent = noteText();
  };
  const applyAiCounts = applyAsyncCounts('ai');
  const applyArcCounts = applyAsyncCounts('archive');
  loadAiBank().then(() => countPoolFor(type, 'ai')).then(applyAiCounts).catch(() => applyAiCounts(null));
  loadArchiveBank().then(() => countPoolFor(type, 'archive')).then(applyArcCounts).catch(() => applyArcCounts(null));

  main.querySelector('#sel-start').addEventListener('click', async () => {
    const warn = main.querySelector('#sel-warn');
    warn.textContent = '';
    const selected = readBankSelection(main, 'sel-bank');
    if (!selected.length) { warn.textContent = '請至少勾選一個題庫來源。'; return; }
    const countRaw = main.querySelector('input[name="sel-count"]:checked').value;
    const want = countRaw === 'all' ? Infinity : Number(countRaw);
    let pool;
    try {
      pool = await buildPools(type, selected);
    } catch (err) {
      warn.textContent = `題庫載入失敗：${String(err.message || err).slice(0, 80)}`;
      return;
    }
    // 5.2：單一來源失敗只提示、不作廢整場（buildPools 已各自 try/catch，errors 帶來源名）。
    // 全部來源都失敗才停在警告列；還有其他來源的題就繼續出題。
    // 部分失敗走 toast 而非 #sel-warn：出題會把設定卡整張換掉（renderSingle 的 replaceChildren），
    // 寫在 #sel-warn 的訊息會當場消失，使用者根本看不到（池 B 實測）。
    const failed = pool.errors || [];
    const anyLeft = (type === 'discourse' ? pool.discourse : (type === 'single' ? pool.single : pool.cloze)).length;
    if (failed.length && !anyLeft) {
      warn.textContent = `題庫載入失敗：${failed.join('；')}`.slice(0, 160);
      return;
    }
    if (failed.length) {
      toast(`部分題庫來源載入失敗，本次只出其他來源的題：${failed.join('；')}`, 'bad');
    }
    if (type === 'discourse') {
      // 文意選填＝整篇作答（一次一整篇），只取一篇
      if (!pool.discourse.length) { warnEmpty(main); return; }
      const item = shuffle(pool.discourse)[0];
      run = { type, item, idx: 0, correct: 0, results: [], subtypeLabel, joinPool: new Set(), wordsById: new Map() };
      renderDiscourse(main);
      return;
    }
    const list = type === 'single' ? pool.single : pool.cloze;
    if (!list.length) { warnEmpty(main); return; }
    const picked = shuffle(list).slice(0, want === Infinity ? list.length : want);
    if (!picked.length) { warnEmpty(main); return; }
    if (type === 'single') {
      run = { type, qs: picked, idx: 0, correct: 0, results: [], subtypeLabel, joinPool: new Set(), wordsById: new Map() };
      renderSingle(main);
    } else {
      const group = picked[0];
      run = { type, group, qs: group.items, idx: 0, correct: 0, results: [], subtypeLabel, joinPool: new Set(), wordsById: new Map() };
      renderCloze(main);
    }
  });
}

// 4.1.1 分流：msg 有值＝真的出錯（保留 .warning 警示樣式）；無值＝題庫為空的正常狀態
function warnEmpty(main, msg) {
  if (msg) {
    main.replaceChildren(el(`<section class="card"><p class="warning">${escapeHtml(msg)}</p></section>`));
    return;
  }
  main.replaceChildren(el(`<section class="card">${emptyState({
    icon: 'book',
    title: '題庫擴充中',
    desc: '這個題型目前還沒有可用題目，請換一個題庫來源。',
    actionHtml: '<a class="btn" href="#/practice">回到練習</a>',
  })}</section>`));
}

// 完成畫面出口：最後一題答完後出現
function appendDoneButton(container, onDone) {
  const done = document.createElement('button');
  done.className = 'btn primary';
  done.textContent = '查看成績';
  done.addEventListener('click', onDone);
  container.appendChild(done);
}

// ---------- 提前結束（共用基建第 4 項） ----------
function quitToCompletion(main, title) {
  const ok = openDialog({
    title: '提前結束',
    body: '已作答的題目會計入成績，未作答的不計。',
    okText: '結束',
  });
  return ok.then((yes) => {
    if (!yes) return false;
    showSelectionCompletion(main, `${title}・提前結束`, `${run.correct} / ${run.qs?.length ?? 0}`);
    return true;
  });
}

function showSelectionCompletion(main, title, scoreText) {
  mountCompletion(main, {
    title,
    scoreText,
    stats: [
      { num: run.qs?.length ?? 0, label: '總題數' },
      { num: run.correct, label: '答對題數' },
    ],
    onAgain: () => renderSelection(main),
    onBack: () => { location.hash = '#/practice'; },
  });
  // 批次 2 第 5 項：本次收集的單字 → 新建／合併單詞本
  const host = main.querySelector('.completion')?.parentElement || main;
  mountJoinPanel(host, { joinPool: run.joinPool, wordById: run.wordsById, bookName: '選擇練習收錄' });
}

// ---------- 來源徽章 ----------
// data-src 帶來源別名（樣式在 css 批次 2 區塊：.src-badge[data-src="real"]…）
function srcBadgeHtml(q) {
  return `<span class="src-badge" data-src="${escapeHtml(q.src || '')}">${escapeHtml(q.srcText || '')}</span>`;
}

// ---------- 選項迷你單詞卡（批次 2 第 4 項） ----------
// 答題後每個選項可二次點擊 → 展開迷你單詞卡（原文先查字庫，查不到走綴尾還原）。
// 同一時間只展開一張；再次點同一個選項＝收合。
function wireOptionCards(shellContent, q, btnOfOption) {
  const openCard = (i, slot) => {
    const raw = String(q.options[i] || '').trim();
    if (!raw) return;
    const hit = findWordWithLemma(raw);
    if (!hit) {
      slot.appendChild(el(`<div class="mini-card mini-card--none"><div class="mc-senses"><div>「${escapeHtml(raw)}」不在字庫中。</div></div></div>`));
      return;
    }
    mountMiniCard(slot, {
      word: hit.word,
      raw: hit.viaLemma ? raw : '',
      bookName: '選擇練習收錄',
      joinPool: run.joinPool,
      onChange: (w) => run.wordsById.set(String(w.id), w),
    });
    run.wordsById.set(String(hit.word.id), hit.word);
  };
  q.options.forEach((_, i) => {
    const btn = btnOfOption(i);
    if (!btn) return;
    btn.insertAdjacentHTML('beforeend', '<span class="sel-lookup-hint">查釋義</span>');
    btn.addEventListener('click', () => {
      // 已作答的選項不再改分（作答守衛在上一个 handler 先擋），這裡只處理展開／收合
      const existing = shellContent.querySelector(`.mc-slot[data-for="${i}"]`);
      if (existing) { existing.remove(); return; }
      shellContent.querySelectorAll('.mc-slot').forEach((n) => n.remove());
      const slot = el('<div class="mc-slot"></div>');
      slot.dataset.for = String(i);
      btn.after(slot);
      openCard(i, slot);
    });
  });
}

// ---------- 解析（批次 2 第 3 項） ----------
function explainText(q) {
  if (q.explanation) return q.explanation;
  if (q.src === 'real') return '（真題：詳解請見解析本）';
  if (q.src === 'archive') return '（考古題：本題無站方解析）';
  return '（本題無解析）';
}

// ---------- 單選 ----------
function renderSingle(main) {
  const q = run.qs[run.idx];
  const prev = run.results[run.idx];
  const shell = mountShell(main, {
    typeLabel: '選擇・單選',
    cur: run.idx + 1, total: run.qs.length,
    canPrev: run.idx > 0, canNext: run.idx < run.qs.length - 1,
    onPrev: () => { run.idx--; renderSingle(main); },
    onNext: () => { run.idx++; renderSingle(main); },
    onQuit: () => { quitToCompletion(main, '單選練習'); },
  });
  shell.content.appendChild(el(`
    <div>
      <div class="sel-head">${srcBadgeHtml(q)}<p class="tp-body">${escapeHtml(q.q)}</p></div>
      <div id="sel-opts">
        ${q.options.map((o, i) => `<button class="sel-option" data-i="${i}">${String.fromCharCode(65 + i)}. ${escapeHtml(o)}</button>`).join('')}
      </div>
      <div class="q-feedback" id="sel-explain"></div>
    </div>`));
  const opts = [...shell.content.querySelectorAll('.sel-option')];

  const showResult = (picked) => {
    opts.forEach((btn, i) => {
      btn.disabled = true;
      if (i === q.answer) btn.classList.add('f-correct');
      else if (i === picked) btn.classList.add('f-wrong');
    });
    shell.content.querySelector('#sel-explain').textContent = explainText(q);
    shell.setFeedback(run.results[run.idx].good ? '答對了' : '答錯了', run.results[run.idx].good ? 'ok' : 'bad');
    wireOptionCards(shell.content, q, (i) => opts[i]);
    if (run.idx === run.qs.length - 1) {
      appendDoneButton(shell.content, () => showSelectionCompletion(main, '單選練習完成', `${run.correct} / ${run.qs.length}`));
    }
  };

  if (prev) {
    showResult(prev.picked); // 已答題還原，不重複計分
    return;
  }
  opts.forEach((b) => b.addEventListener('click', () => {
    if (run.results[run.idx]) return; // 以 run 記錄已答題，翻頁往返不再重複計分
    const picked = Number(b.dataset.i);
    const good = picked === q.answer;
    if (good) run.correct++;
    run.results[run.idx] = { picked, good };
    addEvent('quiz', null, { q: 'single', ok: good }); // 題型作答計入統計（首次作答才執行）
    showResult(picked);
  }));
}

// ---------- 克漏字（整組一次載入、一次一題、文章持續可見） ----------
function renderCloze(main) {
  const g = run.group;
  const q = run.qs[run.idx];
  const prev = run.results[run.idx];
  const shell = mountShell(main, {
    typeLabel: '選擇・克漏字',
    cur: run.idx + 1, total: run.qs.length,
    canPrev: run.idx > 0, canNext: run.idx < run.qs.length - 1,
    onPrev: () => { run.idx--; renderCloze(main); },
    onNext: () => { run.idx++; renderCloze(main); },
    onQuit: () => { quitToCompletion(main, '克漏字練習'); },
  });
  // 文章持續可見；當前題號的空格以強調色顯示
  const passage = escapeHtml(g.passage).replace(/\[(\d{1,2})\]/g, (m, n) => {
    const cur = Number(n) === run.idx + 1;
    return `<strong class="${cur ? 'passage-blank' : ''}">[${n}]</strong>`;
  });
  shell.content.appendChild(el(`
    <div>
      <div class="sel-head">${srcBadgeHtml(q)}</div>
      <div class="sel-passage">${passage}</div>
      <div id="sel-zh-host"></div>
      <p class="tp-body">${escapeHtml(q.q)}</p>
      <div id="sel-opts">
        ${q.options.map((o, i) => `<button class="sel-option" data-i="${i}">${String.fromCharCode(65 + i)}. ${escapeHtml(o)}</button>`).join('')}
      </div>
      <div class="q-feedback" id="sel-explain"></div>
    </div>`));
  const opts = [...shell.content.querySelectorAll('.sel-option')];

  // 5.2：考古題的組有中譯，放在文章下方摺疊（外部文字走 textContent；紅線）
  const zhHost = shell.content.querySelector('#sel-zh-host');
  if (zhHost && g.passageZh) {
    const det = document.createElement('details');
    det.className = 'passage-zh';
    const sum = document.createElement('summary');
    sum.textContent = '文章中文翻譯';
    const body = document.createElement('div');
    body.className = 'passage-zh-body';
    body.textContent = g.passageZh;
    det.append(sum, body);
    zhHost.appendChild(det);
  }

  const showResult = (picked) => {
    opts.forEach((btn, i) => {
      btn.disabled = true;
      if (i === q.answer) btn.classList.add('f-correct');
      else if (i === picked) btn.classList.add('f-wrong');
    });
    shell.content.querySelector('#sel-explain').textContent = explainText(q);
    shell.setFeedback(run.results[run.idx].good ? '答對了' : '答錯了', run.results[run.idx].good ? 'ok' : 'bad');
    wireOptionCards(shell.content, q, (i) => opts[i]);
    if (run.idx === run.qs.length - 1) {
      appendDoneButton(shell.content, () => showSelectionCompletion(main, '克漏字練習完成', `${run.correct} / ${run.qs.length}`));
    }
  };

  if (prev) {
    showResult(prev.picked);
    return;
  }
  opts.forEach((b) => b.addEventListener('click', () => {
    if (run.results[run.idx]) return; // 同 renderSingle 的守衛
    const picked = Number(b.dataset.i);
    const good = picked === q.answer;
    if (good) run.correct++;
    run.results[run.idx] = { picked, good };
    addEvent('quiz', null, { q: 'cloze', ok: good });
    showResult(picked);
  }));
}

// ---------- 文意選填（chip 指派到格；提交後著色） ----------
function renderDiscourse(main) {
  const item = run.item;
  const options = shuffle(item.options.map((w, i) => ({ w, i })));
  const used = new Map(); // boxIdx -> {w, i}
  let submitted = false;

  main.replaceChildren(el(`
    <section class="card">
      <div class="q-shell">
        <div class="q-shell-head"><span class="q-type">選擇・文意選填</span>
          <span class="q-progress-num">${item.options.length} 選 ${Object.keys(item.blanks).length} 格</span></div>
        <div class="sel-head">${srcBadgeHtml(item)}</div>
        <div class="sel-passage">${escapeHtml(item.passage)}</div>
        <!-- 5.2：考古題有逐篇中譯，摺疊放在文章下方（外部文字走 textContent；紅線） -->
        <div id="dc-zh-host"></div>
        <div class="discourse-boxes" id="dc-boxes">
          ${Object.keys(item.blanks).map((n) => `<div class="dbox" data-n="${n}">${n}</div>`).join('')}
        </div>
        <div class="tp-caption">點下方單字填入第一個空格；點已填的格可退回。</div>
        <div class="chip-pool" id="dc-pool">
          ${options.map((o) => `<button class="chip-opt" data-i="${o.i}">${escapeHtml(o.w)}</button>`).join('')}
        </div>
        <div class="controls"><button class="btn primary" id="dc-submit">提交答案</button></div>
      </div>
    </section>`));

  const boxes = [...main.querySelectorAll('.dbox')];
  const chips = [...main.querySelectorAll('.chip-opt')];
  const totalBlanks = Object.keys(item.blanks).length;
  // 5.2：考古題的逐格解析在提交後逐格顯示（與正解同位置，比較時不用回頭找）
  const zhHost = main.querySelector('#dc-zh-host');
  if (zhHost && item.passageZh) {
    const det = document.createElement('details');
    det.className = 'passage-zh';
    const sum = document.createElement('summary');
    sum.textContent = '文章中文翻譯';
    const body = document.createElement('div');
    body.className = 'passage-zh-body';
    body.textContent = item.passageZh;
    det.append(sum, body);
    zhHost.appendChild(det);
  }
  main.querySelector('#dc-submit').addEventListener('click', () => {
    if (submitted) return;
    submitted = true;
    let correct = 0;
    boxes.forEach((bx) => {
      const n = bx.dataset.n;
      const entry = used.get(Number(n));
      const good = entry && String(item.blanks[n]) === entry.w;
      if (good) correct++;
      bx.classList.add(good ? 'f-correct' : 'f-wrong');
      if (!good) {
        const ans = el('<span class="dc-answer"></span>');
        ans.textContent = `正解 ${item.blanks[n]}`;
        bx.appendChild(ans);
      }
      // 5.2：考古題有逐格解析（真題與自製題沒有 explanations，故只有考古題會顯示）
      if (!good && item.explanations?.[n]) {
        const ex = el('<div class="tp-caption dc-explain"></div>');
        ex.textContent = item.explanations[n];
        bx.appendChild(ex);
      }
    });
    chips.forEach((c) => { c.disabled = true; c.classList.remove('used'); });
    main.querySelector('#dc-submit').disabled = true;
    run.correct = correct;
    addEvent('quiz', null, { q: 'discourse', ok: correct === totalBlanks }); // 題型作答計入統計
    main.querySelector('.q-shell').insertAdjacentHTML('beforeend',
      `<div class="q-feedback ${correct === totalBlanks ? 'ok' : 'bad'}">答對 ${correct} / ${totalBlanks} 格</div>`);
    appendDoneButton(main.querySelector('.q-shell'), () => showDiscourseCompletion(main, correct, totalBlanks));
  });

  main.querySelector('#dc-pool').addEventListener('click', (e) => {
    if (submitted) return;
    const chip = e.target.closest('.chip-opt');
    if (!chip || chip.classList.contains('used')) return;
    const empty = boxes.find((bx) => !used.get(Number(bx.dataset.n)));
    if (!empty) return;
    const n = Number(empty.dataset.n);
    used.set(n, { w: chip.textContent, i: Number(chip.dataset.i) });
    empty.textContent = chip.textContent;
    empty.classList.add('filled');
    chip.classList.add('used');
  });
  main.querySelector('#dc-boxes').addEventListener('click', (e) => {
    if (submitted) return;
    const bx = e.target.closest('.dbox');
    if (!bx) return;
    const n = Number(bx.dataset.n);
    const entry = used.get(n);
    if (!entry) return;
    used.delete(n);
    bx.textContent = n;
    bx.classList.remove('filled');
    chips.forEach((c) => { if (Number(c.dataset.i) === entry.i) c.classList.remove('used'); });
  });
}

function showDiscourseCompletion(main, correct, total) {
  mountCompletion(main, {
    title: '文意選填完成',
    scoreText: `${correct} / ${total}`,
    stats: [{ num: total, label: '總格數' }, { num: correct, label: '答對格數' }],
    onAgain: () => renderSelection(main),
    onBack: () => { location.hash = '#/practice'; },
  });
  const host = main.querySelector('.completion')?.parentElement || main;
  mountJoinPanel(host, { joinPool: run.joinPool, wordById: run.wordsById, bookName: '選擇練習收錄' });
}
