// ============================================================
// 頁面：閱讀（6.2.0 第一批）
//
// 依已驗樣品 6.0/ui-samples/reading-620-review.html 的版面與用語實作正式頁：
//   · 兩個來源：貼上純文字 / 既有考古題「閱讀測驗」文章（只放正文，不含題目、答案、解析）
//   · 真 tokenizer＋真 lemma：文字層見 core/reading-text.js（精確 offset、原文不動）
//   · 輕量字卡：只向 words.json 要單字資料；詞典詳情按需載入單一 lexicon 分片
//   · 「加入單詞本」「加入複習」「標示已懂」分開：
//       加入單詞本 → store.addWordsToReadingWordbook（真的具名單詞本「閱讀收藏」，去重）
//       加入複習   → store.markUnknown（真的複習排程／FSRS 既有入口，沿用既有排程規則）
//       標示已懂   → 只寫閱讀頁自己的 owner 分區（閱讀自評，不改 SRS／診斷／每日任務）
//
// 【刻意不做的事】
//   ① 不改 SRS 排程規則、不加新的詞數上限：加入複習就是走既有的 markUnknown 入口，
//      引擎（固定間隔／FSRS）、保留率、到期日一律沿用 services/store.js 的原規則。
//   ② 不載 sentences／collocations／exam 三個大檔（字卡只用 words.json）。
//   ③ 不改診斷、每日任務、備份規則；「已懂」僅是閱讀自評。
//
// 【帳戶競態】所有非同步結果回到畫面前，都驗「頁面 generation＋owner＋帳號＋這次操作的 token」；
//   A 的遲到結果不會畫到 B 的頁面。換帳號時立即重讀新 owner 的閱讀狀態並重畫。
//   寫入層另在交易內（讀完／落地前）再驗 owner，換帳戶時整筆不落地。
//
// 【6.2.0 補：readState 改成 async】
//   儲存層改用原生 IndexedDB（見 services/reading-store.js），沒有同步讀。
//   所以這裡：
//     · 首次掛載先 await readState，回來後再驗 generation／owner；等待期間離頁或換帳戶
//       就整段丟棄，不把舊 owner 的資料畫進新頁。
//     · auth:changed 先把畫面清成新 owner 的空狀態（A 的字一秒都不留在 B 的畫面），
//       再 await 讀新 owner；用遞增的 stateLoadToken＋authEpoch＋owner 三關驗證，
//       只有「最後一次」載入的結果可以套用。
//     · 寫入仍走 store 的 mutate（交易內再驗 owner），await 回來後再驗 still() 才重畫。
// ============================================================
import { el, elAll, escapeHtml, ICONS, phoneticPretty, toast } from '../core/ui.js';
import { on } from '../core/eventbus.js';
import { getUser } from '../services/auth.js';
import { loadWords } from '../services/vocab.js';
import { findWordWithTense, idIndex } from '../services/search.js';
import { loadLexiconEntry } from '../services/lexicon.js';
import { lexiconDetailsHtml } from '../core/lexicon-view.js';
import { annotate, sentenceBounds, statsSummary, tokenizeArticle } from '../core/reading-text.js';
import * as readingStore from '../services/reading-store.js';
import {
  markUnknown, unmarkUnknown, addWordsToReadingWordbook, removeWordsFromReadingWordbook, READING_BOOK_NAME,
} from '../services/store.js';
import { loadArchiveBank, SEC_READING } from '../practice/archive-bank.js';

const PAGE_SIZE = 10;
const MAX_BATCH_ROWS = 24;

let mountGeneration = 0;
let activeCleanup = null;

/** 路由離開時由 core/router.js 呼叫：讓所有在途結果失效並解除訂閱。 */
export function onLeave() {
  mountGeneration++;
  activeCleanup?.();
  activeCleanup = null;
}

function currentOwner() {
  const user = getUser();
  return user?.id ? `user:${user.id}` : 'guest';
}

// store.js 的分區鍵（與每日任務／診斷同一格式：登入＝user.id，未登入＝'guest'）。
function accountOwner() {
  return getUser()?.id ?? 'guest';
}

const formNote = (tok) => (tok?.viaTense ? `文中作「${tok.value}」，原形 ${tok.lemma}` : '');

// 小型 DOM 建構器：所有動態文字一律 textContent，不把使用者內容塞進 innerHTML。
function mk(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

export async function renderReading(main) {
  const gen = ++mountGeneration;
  activeCleanup?.();

  let mounted = true;
  let authEpoch = 0;
  let ownerId = currentOwner();
  const alive = () => mounted && gen === mountGeneration;
  const offs = [];
  const cleanup = () => {
    mounted = false;
    offs.splice(0).forEach((off) => off());
    document.removeEventListener('keydown', onKeydown);
  };
  activeCleanup = cleanup;

  // ---------- 讀取本機狀態（IndexedDB 為 async；await 之後再驗 generation／owner） ----------
  let stateLoadToken = 0;
  let storageError = '';
  let state = null;
  for (let attempt = 0; attempt < 4 && !state; attempt++) {
    const loadOwner = currentOwner();
    let next = null;
    try {
      next = await readingStore.readState(loadOwner);
    } catch (err) {
      if (!alive()) return; // 等結果時已離頁：不畫回
      // 本機資料庫暫時不可用：不假裝有資料，也不因此停用頁面（收藏時會明白提示失敗）。
      storageError = String(err?.message || err);
      ownerId = loadOwner;
      state = readingStore.emptyState(loadOwner);
      break;
    }
    if (!alive()) return; // 等結果時已離頁：不畫回
    if (currentOwner() !== loadOwner) continue; // 等結果時換了帳戶：重讀，不用舊 owner 的資料
    ownerId = loadOwner;
    state = next;
  }
  if (!state) state = readingStore.emptyState(ownerId);

  // ---------- 頁面狀態 ----------
  let article = state.article ? { ...state.article } : null;
  let doc = article ? tokenizeArticle(article.text) : null;
  let annotated = null; // { paragraphs, stats }（words.json 到位後才有）
  let stats = new Map();
  let wordsReady = false;
  let wordsError = '';
  let wordsPromise = null;
  let archiveBank = null;
  let archiveError = '';
  let archivePromise = null;
  let sourceTab = article?.source === 'archive' ? 'archive' : 'paste';
  let yearFilter = 'all';
  let archivePage = 0;
  let wordOpen = false;
  let wordPi = -1;
  let wordTi = -1;
  let wordReq = 0;
  let batchOpen = false;
  let batchBusy = false; // 批次寫入在途（避免連點重複送出；不是停用功能）

  // ---------- 版面 ----------
  main.replaceChildren(elAll(`
    <section class="card reading-top">
      <div class="reading-head">
        <div>
          <h2>閱讀</h2>
          <p class="muted small">點單字查詞；「加入單詞本」「加入複習」會寫進這個帳戶的單詞本與複習排程，「已懂」只是閱讀自評。</p>
        </div>
        <span class="reading-tag">本機</span>
      </div>

      <div class="segmented reading-source" role="radiogroup" aria-label="文章來源">
        <label><input type="radio" name="rw-source" value="paste"${sourceTab === 'paste' ? ' checked' : ''}><span>貼上文章</span></label>
        <label><input type="radio" name="rw-source" value="archive"${sourceTab === 'archive' ? ' checked' : ''}><span>考古題文章</span></label>
      </div>

      <div id="rw-paste" class="reading-paste${sourceTab === 'paste' ? '' : ' hidden'}">
        <label class="sr-only" for="rw-paste-title">文章標題</label>
        <input id="rw-paste-title" class="reading-title-input" type="text" maxlength="120" placeholder="標題（可留空）" autocomplete="off">
        <label class="sr-only" for="rw-paste-text">文章內容</label>
        <textarea id="rw-paste-text" class="reading-textarea" spellcheck="false" placeholder="把英文文章貼在這裡…&#10;&#10;段落請用空行分隔。只會當純文字顯示，不解析 HTML。"></textarea>
        <div class="reading-paste-meta" id="rw-paste-meta"></div>
        <div class="controls controls-start">
          <button class="btn primary" type="button" data-rw="apply-paste">閱讀這篇</button>
          <button class="btn subtle" type="button" data-rw="clear-paste">清空</button>
        </div>
      </div>

      <div id="rw-archive" class="reading-archive${sourceTab === 'archive' ? '' : ' hidden'}">
        <div class="reading-archive-bar">
          <label class="reading-year"><span class="muted small">屆次</span>
            <select id="rw-year" aria-label="考古題屆次"></select>
          </label>
          <div class="controls controls-start">
            <button class="btn small" type="button" data-rw="archive-prev">上一批</button>
            <button class="btn small" type="button" data-rw="archive-next">下一批</button>
          </div>
        </div>
        <p class="status-note" id="rw-archive-status"></p>
        <ul class="reading-archive-list" id="rw-archive-list"></ul>
      </div>
    </section>

    <section class="card reading-article-card">
      <div class="source-bar" id="rw-source"></div>
      <div class="article-meta" id="rw-meta"></div>
      <div class="article-body" id="rw-body"></div>
      <div class="legend">
        <span><i class="sw hl"></i>已收集（單詞本／複習）</span>
        <span><i class="sw known"></i>已懂</span>
        <span><i class="sw miss"></i>字庫未收錄</span>
      </div>
      <p class="status-note" id="rw-status"></p>
    </section>

    <section class="card reading-side">
      <div class="reading-side-head"><h3>本次收集</h3><span class="muted small" id="rw-collect-count"></span></div>
      <div id="rw-collect"></div>
      <div class="reading-side-head"><h3>批次已懂</h3><span class="muted small">只影響閱讀自評</span></div>
      <div id="rw-batch"></div>
      <div class="reading-side-head"><h3>已懂清單</h3></div>
      <div id="rw-known"></div>
    </section>

    <div class="reading-word-layer" id="rw-word-layer" hidden>
      <div class="reading-word-scrim" data-rw="close-word"></div>
      <section class="reading-word-panel" id="rw-word-panel" role="dialog" aria-modal="true" aria-labelledby="rw-word-title" tabindex="-1"></section>
    </div>
  `));

  const $ = (id) => main.querySelector(`#${id}`);
  const pasteBox = $('rw-paste');
  const archiveBox = $('rw-archive');
  const titleInput = $('rw-paste-title');
  const textArea = $('rw-paste-text');
  const pasteMeta = $('rw-paste-meta');
  const yearSel = $('rw-year');
  const archiveStatus = $('rw-archive-status');
  const archiveList = $('rw-archive-list');
  const layer = $('rw-word-layer');
  const panel = $('rw-word-panel');

  if (article?.source === 'paste') {
    titleInput.value = article.title || '';
    textArea.value = article.text || '';
  }
  renderPasteMeta();
  renderAll();
  ensureWords(); // 不阻塞首屏：文章先顯示，字庫到位後再標詞條與高亮
  if (sourceTab === 'archive') ensureArchive();
  // 本機資料庫打不開時明白講（功能不停用，但收藏寫入會失敗並提示），不假裝資料還在。
  if (storageError) toast(`本機資料庫無法使用：${storageError}（閱讀仍可看，收藏不會保存）`, 'bad');

  // ---------- 文字/詞形 ----------
  function ensureWords() {
    if (wordsReady) return Promise.resolve(true);
    if (!wordsPromise) {
      wordsPromise = loadWords().then(
        () => { wordsReady = true; wordsError = ''; return true; },
        (err) => { wordsError = String(err?.message || err); return false; },
      );
    }
    return wordsPromise.then((ok) => {
      if (!alive()) return ok;
      if (ok && doc && !annotated) {
        annotateNow();
        renderArticle();
        renderStatus();
        renderSide();
        if (wordOpen) renderWordPanel();
      } else {
        renderStatus();
      }
      return ok;
    });
  }

  function annotateNow() {
    if (!doc) { annotated = null; stats = new Map(); return; }
    annotated = annotate(doc, (key) => findWordWithTense(key));
    stats = annotated.stats;
  }

  function wordOf(tok) {
    if (!wordsReady || !tok?.wordId) return null;
    try { return idIndex().get(Number(tok.wordId)) || null; } catch { return null; }
  }

  function glossOf(word) {
    return (word?.senses || []).slice(0, 2).join('；');
  }

  function buckets() {
    return {
      book: new Set(state.book.map((e) => e.key)),
      review: new Set(state.review.map((e) => e.key)),
      known: new Set(state.known.map((e) => e.key)),
    };
  }

  function hasEntry(bucket, key) {
    return state[bucket].some((e) => e.key === key);
  }

  // ---------- 文章切換 ----------
  async function setArticle(next) {
    const opOwner = ownerId;
    const opEpoch = authEpoch;
    const opGen = gen;
    const still = () => mounted && gen === mountGeneration && authEpoch === opEpoch && ownerId === opOwner;
    let saved = true;
    try {
      await readingStore.saveArticle(opOwner, next, {
        guard: () => { if (!still()) throw new Error('READING_OWNER_CHANGED'); },
      });
    } catch (err) {
      if (!still()) return; // A 的文章不套到 B 的頁面
      saved = false;
    }
    if (!still() || opGen !== gen) return;
    article = next ? { ...next } : null;
    doc = article ? tokenizeArticle(article.text) : null;
    annotated = null;
    stats = new Map();
    batchOpen = false;
    closeWord(false);
    if (wordsReady && doc) annotateNow();
    renderAll();
    if (!saved) toast('本機儲存空間不足，這篇仍可閱讀，但重整後不會保留', 'bad');
  }

  async function applyPaste() {
    const text = textArea.value;
    const title = titleInput.value.trim();
    if (!text.trim()) { toast('請先貼上文章內容', 'bad'); textArea.focus(); return; }
    await setArticle({ source: 'paste', title, text, meta: '貼上文章・純文字', archiveId: null });
  }

  async function clearPaste() {
    titleInput.value = '';
    textArea.value = '';
    renderPasteMeta();
    if (article?.source === 'paste') await setArticle(null);
    else renderAll();
    textArea.focus();
  }

  function renderPasteMeta() {
    const text = textArea.value;
    const paras = text.replace(/\r\n?/g, '\n').split(/\n{2,}/).filter((p) => p.trim()).length;
    pasteMeta.replaceChildren(
      el(`<span>${text.length} 字元</span>`),
      el(`<span>${paras} 個段落（以空行分隔）</span>`),
      el('<span>只保存在本機這個帳戶</span>'),
    );
  }

  // ---------- 考古題列表 ----------
  function ensureArchive() {
    if (archiveBank) { renderArchive(); return Promise.resolve(archiveBank); }
    if (!archivePromise) {
      archiveStatus.textContent = '正在載入考古題清單…';
      archivePromise = loadArchiveBank().then(
        (data) => { archiveBank = data; archiveError = ''; return data; },
        (err) => { archiveError = String(err?.message || err); return null; },
      ).finally(() => { archivePromise = null; });
    }
    return archivePromise.then((data) => {
      if (!alive()) return null;
      renderArchive();
      return data;
    });
  }

  function readingPassages() {
    return archiveBank?.sections?.[SEC_READING] || [];
  }

  function renderArchive() {
    const show = sourceTab === 'archive';
    archiveBox.classList.toggle('hidden', !show);
    if (!show) return;
    yearSel.replaceChildren();
    const all = readingPassages();
    if (!archiveBank) {
      archiveStatus.textContent = archiveError ? `考古題載入失敗：${archiveError}` : '正在載入考古題清單…';
      archiveList.replaceChildren();
      if (archiveError) {
        archiveList.appendChild(el(`<li class="reading-archive-empty"><button class="btn small" type="button" data-rw="retry-archive">重試</button></li>`));
      }
      return;
    }
    const years = [...new Set(all.map((g) => g.year).filter((y) => Number.isFinite(Number(y))))].sort((a, b) => b - a);
    yearSel.appendChild(el('<option value="all">全部</option>'));
    years.forEach((y) => yearSel.appendChild(el(`<option value="${y}">${y} 屆</option>`)));
    yearSel.value = yearFilter;
    const filtered = yearFilter === 'all' ? all : all.filter((g) => String(g.year) === String(yearFilter));
    const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    if (archivePage >= pages) archivePage = pages - 1;
    if (archivePage < 0) archivePage = 0;
    archiveStatus.textContent = `共 ${filtered.length} 篇閱讀測驗文章（第 ${archivePage + 1}／${pages} 批）；只顯示正文，不含題目與答案。`;
    archiveList.replaceChildren();
    if (!filtered.length) {
      archiveList.appendChild(el('<li class="reading-archive-empty muted small">這個屆次沒有閱讀測驗文章。</li>'));
      return;
    }
    filtered.slice(archivePage * PAGE_SIZE, archivePage * PAGE_SIZE + PAGE_SIZE).forEach((g) => {
      const li = el('<li></li>');
      const btn = el(`<button type="button" class="reading-archive-item" data-rw="pick-archive" data-id="${escapeHtml(String(g.id))}"></button>`);
      const title = mk('span', 'reading-archive-title');
      title.textContent = g.title || '（未命名文章）';
      const meta = mk('span', 'reading-archive-meta');
      meta.textContent = `考古題 ${g.year ?? ''}${g.exam || ''}・閱讀測驗・${String(g.passage || '').length} 字元`;
      btn.appendChild(title);
      btn.appendChild(meta);
      li.appendChild(btn);
      archiveList.appendChild(li);
    });
  }

  async function pickArchive(id) {
    const g = readingPassages().find((item) => String(item.id) === String(id));
    if (!g) return;
    await setArticle({
      source: 'archive',
      title: g.title || '（未命名文章）',
      text: g.passage || '',
      meta: `考古題 ${g.year ?? ''}${g.exam || ''}・閱讀測驗`,
      archiveId: g.id,
    });
  }

  // ---------- 畫面渲染 ----------
  function renderAll() {
    renderSourceTabs();
    renderSourceBar();
    renderMeta();
    renderArticle();
    renderStatus();
    renderSide();
  }

  function renderSourceTabs() {
    main.querySelectorAll('input[name="rw-source"]').forEach((r) => { r.checked = r.value === sourceTab; });
    pasteBox.classList.toggle('hidden', sourceTab !== 'paste');
    archiveBox.classList.toggle('hidden', sourceTab !== 'archive');
    if (sourceTab === 'archive') renderArchive();
  }

  function renderSourceBar() {
    const host = $('rw-source');
    if (!article) {
      host.replaceChildren(el('<span class="muted small">尚未選擇文章</span>'));
      return;
    }
    host.replaceChildren();
    const name = mk('span', 'src-name');
    name.textContent = article.source === 'archive' ? '考古題文章' : '貼上文章';
    host.appendChild(name);
    const note = mk('span');
    note.textContent = article.meta || (article.source === 'archive' ? '只顯示正文' : '純文字・不解析 HTML');
    host.appendChild(note);
    const tag = mk('span', 'reading-tag');
    tag.textContent = article.source === 'archive' ? '考古題' : '未同步';
    host.appendChild(tag);
  }

  function renderMeta() {
    const host = $('rw-meta');
    host.replaceChildren();
    if (!article) {
      host.appendChild(el('<span class="muted small">可以貼上自己的文章，或從考古題挑一篇閱讀測驗。</span>'));
      return;
    }
    const title = mk('div', 'article-title');
    title.textContent = article.title || '（未命名貼文）';
    const meta = mk('div', 'muted small');
    meta.textContent = article.source === 'archive'
      ? `${article.meta}・正文 ${article.text.length} 字元`
      : `本機保存・${article.text.length} 字元`;
    host.appendChild(title);
    host.appendChild(meta);
  }

  function renderArticle() {
    const host = $('rw-body');
    host.replaceChildren();
    const paragraphs = annotated?.paragraphs || doc?.paragraphs || [];
    if (!article || !paragraphs.length) {
      const empty = el('<div class="reading-empty"></div>');
      empty.appendChild(el('<p><strong>選一篇文章開始</strong></p>'));
      empty.appendChild(el('<p class="muted small">貼上自己的英文文章，或切到「考古題文章」挑一篇閱讀測驗。文章只顯示正文，不含題目與答案。</p>'));
      host.appendChild(empty);
      return;
    }
    const marks = buckets();
    paragraphs.forEach((para) => {
      const p = mk('p', 'para');
      para.tokens.forEach((tok, ti) => {
        if (tok.type !== 'word') {
          // 原文的空白、標點、換行一律以文字節點原樣放回：不 innerHTML、不改寫。
          p.appendChild(document.createTextNode(tok.value));
          return;
        }
        const btn = mk('button');
        btn.type = 'button';
        btn.className = 'w';
        if (tok.miss) btn.classList.add('missing');
        else if (marks.known.has(tok.key)) btn.classList.add('known');
        else if (marks.book.has(tok.key) || marks.review.has(tok.key)) btn.classList.add('in-book');
        btn.dataset.rw = 'open-word';
        btn.dataset.pi = String(para.index);
        btn.dataset.ti = String(ti);
        btn.textContent = tok.value; // 原字原樣（大小寫、撇號都不動）
        const label = tok.miss ? `字庫未收錄：${tok.value}` : `${tok.lemma}${tok.level ? `・Lv${tok.level}` : ''}`;
        btn.title = label;
        btn.setAttribute('aria-label', `查詢 ${tok.value}`);
        btn.setAttribute('aria-haspopup', 'dialog');
        p.appendChild(btn);
      });
      host.appendChild(p);
    });
  }

  function renderStatus() {
    const host = $('rw-status');
    if (!article) {
      host.textContent = storageError
        ? `本機資料庫暫時無法使用：${storageError}。閱讀仍可看，收藏這次不會保存。`
        : '尚未選擇文章。';
      return;
    }
    if (!wordsReady) {
      host.textContent = wordsError
        ? `字庫載入失敗：${wordsError}。文章仍可閱讀；查詞與收藏暫時不可用。`
        : '文章已顯示；正在背景載入字庫以標記詞條（不影響閱讀）。';
      return;
    }
    const { distinct, positions } = statsSummary(stats);
    host.textContent = `${distinct} 個不同詞條・共 ${positions} 次可點位置；字卡只讀 words.json，詞典詳情展開時才載入。`;
  }

  function renderSide() {
    renderCollect();
    renderBatch();
    renderKnown();
  }

  function entryLine(entry, kind) {
    const word = wordOf({ wordId: entry.wordId });
    const kindLabel = kind === 'book' ? '單詞本' : kind === 'review' ? '複習排程' : '已懂';
    const gloss = word ? glossOf(word) : '';
    return `${kindLabel}${word ? `・Lv${word.level}` : ''}${gloss ? `・${gloss}` : ''}`;
  }

  function renderCollect() {
    const host = $('rw-collect');
    host.replaceChildren();
    const rows = [];
    [...state.book].forEach((e) => rows.push([e, 'book']));
    [...state.review].filter((e) => !hasEntry('book', e.key)).forEach((e) => rows.push([e, 'review']));
    [...state.known].filter((e) => !hasEntry('book', e.key) && !hasEntry('review', e.key)).forEach((e) => rows.push([e, 'known']));
    $('rw-collect-count').textContent = rows.length ? `${rows.length} 個字` : '';
    if (!rows.length) {
      host.appendChild(el('<p class="empty">尚未收集任何字。點文章中的單字，再從字卡加入單詞本或複習。</p>'));
      return;
    }
    const ul = el('<ul class="collect-list"></ul>');
    rows.forEach(([entry, kind]) => {
      const li = el('<li class="collect-item"></li>');
      const cw = el('<div class="cw"></div>');
      const b = mk('b');
      b.textContent = entry.word;
      const sp = mk('span');
      sp.textContent = entryLine(entry, kind);
      cw.appendChild(b);
      cw.appendChild(sp);
      li.appendChild(cw);
      const btn = el('<button type="button" class="btn small subtle" data-rw="withdraw"></button>');
      btn.dataset.bucket = kind;
      btn.dataset.key = entry.key;
      btn.textContent = '撤回';
      btn.setAttribute('aria-label', `撤回 ${entry.word} 的${kind === 'book' ? '單詞本' : kind === 'review' ? '複習' : '已懂'}`);
      li.appendChild(btn);
      ul.appendChild(li);
    });
    host.appendChild(ul);
  }

  function batchCandidates() {
    const known = new Set(state.known.map((e) => e.key));
    return [...stats.values()]
      .filter((st) => !st.miss && !known.has(st.key))
      .sort((a, b) => b.count - a.count || String(a.word).localeCompare(String(b.word)));
  }

  function renderBatch() {
    const host = $('rw-batch');
    host.replaceChildren();
    if (!article) { host.appendChild(el('<p class="empty">選文章後可批次標示已懂。</p>')); return; }
    if (!annotated) {
      host.appendChild(el('<p class="status-note">字庫載入後才能列出候選字。</p>'));
      return;
    }
    const rows = batchCandidates();
    const openBtn = el('<button type="button" class="btn small" data-rw="batch-open">批次標示已懂…</button>');
    openBtn.disabled = !rows.length || batchOpen;
    host.appendChild(openBtn);
    host.appendChild(el(`<p class="status-note">${rows.length
      ? `候選：本文未標示已懂的 ${rows.length} 個不同字${rows.length ? `（${rows.slice(0, 8).map((r) => r.word).join('、')}${rows.length > 8 ? ' 等' : ''}）` : ''}。`
      : '這篇文章的字都已在「已懂」清單，或沒有可批次處理的字。'}</p>`));
    if (!batchOpen) return;
    const box = el('<div class="confirm-box" role="alertdialog" aria-labelledby="rw-batch-title"></div>');
    const h = mk('h4');
    h.id = 'rw-batch-title';
    h.textContent = `確定把這 ${rows.length} 個字標示為已懂？`;
    box.appendChild(h);
    const list = mk('p', 'small muted');
    list.textContent = rows.slice(0, MAX_BATCH_ROWS).map((r) => r.word).join('、') + (rows.length > MAX_BATCH_ROWS ? ` 等 ${rows.length} 字` : '');
    box.appendChild(list);
    box.appendChild(el('<p class="small muted">只會加入「已懂」清單，不改複習排程、診斷或每日任務；套用後可整批撤回。</p>'));
    const foot = el('<div class="controls controls-end"></div>');
    const cancel = el('<button type="button" class="btn small" data-rw="batch-cancel">取消</button>');
    const apply = el('<button type="button" class="btn small primary" data-rw="batch-apply">確認標示</button>');
    foot.appendChild(cancel);
    foot.appendChild(apply);
    box.appendChild(foot);
    host.appendChild(box);
  }

  function renderKnown() {
    const host = $('rw-known');
    host.replaceChildren();
    if (!state.known.length) {
      host.appendChild(el('<p class="empty">尚未標示任何字。</p>'));
    } else {
      const wrap = el('<div class="chips"></div>');
      state.known.forEach((entry) => {
        const chip = el('<button type="button" class="chip"></button>');
        chip.dataset.rw = 'withdraw';
        chip.dataset.bucket = 'known';
        chip.dataset.key = entry.key;
        chip.textContent = `${entry.word} ×`;
        chip.title = `撤回「${entry.word}」的已懂標示`;
        wrap.appendChild(chip);
      });
      host.appendChild(wrap);
    }
    if (state.lastBatch) {
      const undo = el('<button type="button" class="btn small" data-rw="batch-undo"></button>');
      undo.appendChild(el(ICONS.refresh));
      undo.appendChild(el('<span>撤回上一次批次</span>'));
      host.appendChild(undo);
    }
  }

  // ---------- 字卡 ----------
  function currentToken() {
    const paragraphs = annotated?.paragraphs || doc?.paragraphs || [];
    return paragraphs[wordPi]?.tokens?.[wordTi] || null;
  }

  function openWord(pi, ti) {
    wordOpen = true;
    wordPi = pi;
    wordTi = ti;
    batchOpen = false;
    const req = ++wordReq;
    layer.hidden = false;
    layer.classList.add('open');
    renderWordPanel();
    panel.focus({ preventScroll: true });
    if (!annotated) {
      ensureWords().then((ok) => {
        if (!ok) return;
        if (!alive() || !wordOpen || req !== wordReq) return;
        renderWordPanel();
      });
    }
  }

  function closeWord(restore = true) {
    if (!wordOpen) return;
    const pi = wordPi;
    const ti = wordTi;
    wordOpen = false;
    wordReq++;
    layer.classList.remove('open');
    layer.hidden = true;
    panel.replaceChildren();
    if (restore) {
      const target = main.querySelector(`[data-rw="open-word"][data-pi="${pi}"][data-ti="${ti}"]`);
      if (target) target.focus({ preventScroll: true });
    }
  }

  function renderWordPanel() {
    panel.replaceChildren();
    if (!wordOpen) return;
    const tok = currentToken();
    if (!tok || tok.type !== 'word') { return; }
    const word = wordOf(tok);
    const resolved = tok.key ? tok : { ...tok, key: `raw:${tok.key}`, miss: true, wordId: null, lemma: tok.raw };

    const head = el('<div class="wp-head"></div>');
    const headText = el('<div></div>');
    const wordLine = mk('div', 'wp-word');
    wordLine.id = 'rw-word-title';
    wordLine.textContent = word ? word.word : tok.value;
    headText.appendChild(wordLine);
    const phon = mk('div', 'wp-phon');
    if (word) {
      const ph = word.usphone || word.phonetic || '';
      phon.textContent = `${ph ? `/${phoneticPretty(ph)}/　` : ''}${word.pos ? `${word.pos}　` : ''}Lv${word.level}`;
    } else {
      phon.textContent = wordsError ? '字庫未載入，無法查詞' : (!wordsReady ? '正在載入字庫…' : '字庫未收錄');
    }
    headText.appendChild(phon);
    head.appendChild(headText);
    const close = el('<button type="button" class="icon-btn" data-rw="close-word" aria-label="關閉"></button>');
    close.appendChild(el(ICONS.close));
    head.appendChild(close);
    panel.appendChild(head);

    const body = el('<div class="wp-body"></div>');
    panel.appendChild(body);

    if (!word) {
      if (!wordsReady && !wordsError) {
        body.appendChild(el('<p class="wp-line">正在載入字庫…字卡會在載入後自動更新。</p>'));
        return;
      }
      body.appendChild(el(`<div class="wp-miss">字庫未收錄：${escapeHtml(tok.value)}</div>`));
      body.appendChild(el('<p class="wp-line">不冒充查詞結果。可到查詢頁看相近字，或直接複製原字。</p>'));
      const acts = el('<div class="wp-actions"></div>');
      const lookup = el('<a class="btn" data-rw="go-lookup"></a>');
      lookup.href = `#/lookup?w=${encodeURIComponent(tok.key || tok.value)}`;
      lookup.appendChild(el(ICONS.arrowUpRight));
      lookup.appendChild(el('<span>到查詢頁查這個字</span>'));
      acts.appendChild(lookup);
      const copy = el('<button type="button" class="btn" data-rw="copy-word"></button>');
      copy.dataset.word = tok.value;
      copy.appendChild(el('<span>複製原字</span>'));
      acts.appendChild(copy);
      const knownBtn = wordsError ? null : knownToggle(resolved);
      if (knownBtn) acts.appendChild(knownBtn);
      body.appendChild(acts);
      body.appendChild(el('<p class="wp-note">「已懂」只是這篇文章的閱讀自評，不會改複習排程、診斷或每日任務。</p>'));
      return;
    }

    if (tok.viaTense) {
      const note = mk('p', 'wp-line');
      note.textContent = formNote({ ...resolved, value: tok.value, lemma: word.word });
      body.appendChild(note);
    }
    const gloss = mk('div', 'wp-gloss');
    gloss.textContent = glossOf(word) || '（沒有中文釋義）';
    body.appendChild(gloss);

    const st = stats.get(tok.key);
    const countLine = mk('div', 'wp-line');
    const forms = st?.forms || [];
    countLine.textContent = `本文出現 ${st?.count ?? 1} 次${forms.length ? `（含 ${forms.slice(0, 4).join('、')}）` : ''}`;
    body.appendChild(countLine);

    const acts = el('<div class="wp-actions"></div>');
    acts.appendChild(toggleButton('book', tok, word));
    acts.appendChild(toggleButton('review', tok, word));
    acts.appendChild(knownToggle(resolved, false));
    body.appendChild(acts);

    // 文中語境：用 tokenizer 的精確 offset 切原文，目標字以 <mark> 標出。
    const para = (annotated?.paragraphs || doc?.paragraphs || [])[wordPi];
    if (para) {
      const bounds = sentenceBounds(para.text, tok.start, tok.end);
      const ctx = mk('p', 'wp-context');
      ctx.appendChild(document.createTextNode(para.text.slice(bounds.start, tok.start)));
      const mark = mk('mark');
      mark.textContent = para.text.slice(tok.start, tok.end);
      ctx.appendChild(mark);
      ctx.appendChild(document.createTextNode(para.text.slice(tok.end, bounds.end)));
      body.appendChild(ctx);
    }

    const note = mk('p', 'wp-note');
    note.textContent = '「加入單詞本」寫進這個帳戶的單詞本「' + READING_BOOK_NAME + '」；「加入複習」寫進複習排程，'
      + '依既有的排程規則（引擎、保留率、到期日）計算，不另外改期。兩個動作分開，加入前會先去重。'
      + '「已懂」只是這篇文章的閱讀自評，不改複習、診斷或每日任務。都只存在本機的這個帳戶。';
    body.appendChild(note);

    // 按需詞典詳情：不展開就不抓 lexicon 分片，也不碰 sentences／collocations／exam。
    const details = el('<details class="reading-lex"></details>');
    const summary = el('<summary>詞典詳情（按需載入）</summary>');
    details.appendChild(summary);
    const lexBody = el('<div class="reading-lex-body muted small">展開後才載入這個字的詞典分片。</div>');
    details.appendChild(lexBody);
    const opEpoch = authEpoch;
    const opOwner = ownerId;
    const opReq = wordReq;
    details.addEventListener('toggle', () => {
      if (!details.open || details.dataset.loaded === '1') return;
      details.dataset.loaded = '1';
      lexBody.textContent = '正在載入詞典詳情…';
      loadLexiconEntry(word.id, { word }).then(
        (entry) => {
          if (!alive() || authEpoch !== opEpoch || ownerId !== opOwner || !wordOpen || wordReq !== opReq || !panel.contains(details)) return;
          if (!entry) { lexBody.textContent = '這個字沒有可顯示的詞典詳情。'; return; }
          lexBody.classList.remove('muted');
          lexBody.innerHTML = lexiconDetailsHtml(entry);
        },
        (err) => {
          if (!alive() || authEpoch !== opEpoch || ownerId !== opOwner || !wordOpen || wordReq !== opReq) return;
          lexBody.textContent = `詞典詳情載入失敗：${String(err?.message || err)}`;
        },
      );
    });
    body.appendChild(details);
  }

  function toggleButton(bucket, tok) {
    const on = hasEntry(bucket, tok.key);
    const btn = el(`<button type="button" class="btn${on ? ' primary' : ''}"></button>`);
    btn.dataset.rw = bucket === 'book' ? 'toggle-book' : 'toggle-review';
    btn.setAttribute('aria-pressed', String(on));
    if (bucket === 'review') btn.appendChild(el(ICONS.starOutline));
    btn.appendChild(el('<span></span>'));
    btn.lastChild.textContent = on
      ? (bucket === 'book' ? '已加入單詞本（點擊撤回）' : '已加入複習（點擊撤回）')
      : (bucket === 'book' ? '加入單詞本' : '加入複習');
    return btn;
  }

  function knownToggle(tok) {
    const on = hasEntry('known', tok.key);
    const btn = el(`<button type="button" class="btn${on ? ' primary' : ''}"></button>`);
    btn.dataset.rw = 'toggle-known';
    btn.setAttribute('aria-pressed', String(on));
    btn.appendChild(el(ICONS.checkCircle));
    const span = mk('span');
    span.textContent = on ? '已標示已懂（點擊撤回）' : '標示已懂';
    btn.appendChild(span);
    return btn;
  }

  // ---------- 收藏 / 已懂寫入（真 store；owner-scoped） ----------
  // 單詞本與複習是兩個不同動作：
  //   加入單詞本 → 真的具名單詞本（閱讀收藏），已在書內不重複加
  //   加入複習   → 真的複習排程（markUnknown 既有入口，引擎／到期日照原規則）
  // 任何一步失敗都如實提示，不假裝成功，也不先把畫面標成已加入。
  async function toggleEntry(bucket) {
    const tok = currentToken();
    if (!tok || tok.type !== 'word') return;
    if (!tok.wordId && bucket !== 'known') {
      toast('這個字不在字庫，先到查詢頁確認再收藏', 'bad');
      return;
    }
    const key = tok.key || `raw:${tok.key}`;
    const entry = {
      key,
      wordId: tok.wordId ?? null,
      word: tok.lemma || tok.value,
      at: new Date().toISOString(),
    };
    const has = hasEntry(bucket, key);
    const opOwner = ownerId;
    const opEpoch = authEpoch;
    const opAccount = accountOwner();
    const still = () => mounted && gen === mountGeneration && authEpoch === opEpoch
      && ownerId === opOwner && accountOwner() === opAccount;
    const guard = () => { if (!still()) throw new Error('READING_OWNER_CHANGED'); };
    let message = '';
    let tone = 'ok';
    try {
      if (bucket === 'book' && has) {
        await removeWordsFromReadingWordbook([tok.wordId], { guard });
        const res = await readingStore.removeEntry(opOwner, bucket, key, { guard });
        if (!still()) return;
        state = res.state;
        message = `已從單詞本撤回 ${entry.word}`;
        tone = '';
      } else if (bucket === 'book') {
        const result = await addWordsToReadingWordbook([tok.wordId], { guard });
        if (!still()) return;
        const res = await readingStore.addEntry(opOwner, bucket, entry, { guard });
        state = res.state;
        message = result.added.length
          ? `已加入單詞本（${READING_BOOK_NAME}）：${entry.word}`
          : `已在單詞本（${READING_BOOK_NAME}）：${entry.word}`;
      } else if (bucket === 'review' && has) {
        const previous = state.review.find((e) => e.key === key);
        if (previous?.madeMark) await unmarkUnknown(tok.wordId, { guard });
        const res = await readingStore.removeEntry(opOwner, bucket, key, { guard });
        if (!still()) return;
        state = res.state;
        message = previous?.madeMark
          ? `已撤回複習：${entry.word}`
          : `已從閱讀清單移除 ${entry.word}（它原本就在複習排程，排程沒有被刪）`;
        tone = '';
      } else if (bucket === 'review') {
        const created = await markUnknown(tok.wordId, { guard });
        if (!still()) return;
        const res = await readingStore.addEntry(
          opOwner, bucket, created ? { ...entry, madeMark: true } : entry, { guard },
        );
        state = res.state;
        message = created
          ? `已加入複習排程：${entry.word}（依既有排程規則）`
          : `已在複習排程：${entry.word}`;
      } else if (has) {
        const res = await readingStore.removeEntry(opOwner, bucket, key, { guard });
        if (!still()) return;
        state = res.state;
        message = `已從已懂撤回 ${entry.word}`;
        tone = '';
      } else {
        const res = await readingStore.addEntry(opOwner, bucket, entry, { guard });
        if (!still()) return;
        state = res.state;
        message = `已標示已懂：${entry.word}（閱讀自評）`;
      }
    } catch (err) {
      if (!still()) return;
      toast(String(err?.message || err), 'bad');
      return;
    }
    if (!still()) return;
    renderArticle();
    renderSide();
    renderWordPanel();
    const rw = bucket === 'book' ? 'toggle-book' : bucket === 'review' ? 'toggle-review' : 'toggle-known';
    panel.querySelector(`[data-rw="${rw}"]`)?.focus(); // 重繪後把焦點留在同一顆按鈕（鍵盤操作不斷鏈）
    if (message) toast(message, tone);
  }

  async function withdraw(bucket, key) {
    const opOwner = ownerId;
    const opEpoch = authEpoch;
    const opAccount = accountOwner();
    const still = () => mounted && gen === mountGeneration && authEpoch === opEpoch
      && ownerId === opOwner && accountOwner() === opAccount;
    const guard = () => { if (!still()) throw new Error('READING_OWNER_CHANGED'); };
    const entry = (state[bucket] || []).find((e) => e.key === key);
    try {
      // 撤回要一起處理「真 store」與閱讀清單，順序：先真 store（來源），再閱讀清單紀錄。
      if (bucket === 'book' && entry?.wordId) await removeWordsFromReadingWordbook([entry.wordId], { guard });
      if (bucket === 'review' && entry?.wordId && entry.madeMark) await unmarkUnknown(entry.wordId, { guard });
      const res = await readingStore.removeEntry(opOwner, bucket, key, { guard });
      if (!still()) return;
      state = res.state;
    } catch (err) {
      if (!still()) return;
      toast(String(err?.message || err), 'bad');
      return;
    }
    renderArticle();
    renderSide();
    renderWordPanel();
    toast(bucket === 'review' && !entry?.madeMark
      ? '已從閱讀清單移除（這張複習卡原本就在排程，未刪除）'
      : '已撤回', 'ok');
  }

  async function applyBatch() {
    if (!annotated) return;
    // 寫入還在途時再按一次「確認標示」不要重複送出：重送只會多一次空批次與誤導的提示。
    // （真正的資料保護在 reading-store：沒有新增新字時不換掉 lastBatch，撤回能力不會被吃掉。）
    if (batchBusy) return;
    const rows = batchCandidates();
    if (!rows.length) { batchOpen = false; renderBatch(); return; }
    const entries = rows.map((r) => ({
      key: r.key,
      wordId: r.wordId,
      word: r.word,
      at: new Date().toISOString(),
    }));
    const opOwner = ownerId;
    const opEpoch = authEpoch;
    const still = () => mounted && gen === mountGeneration && authEpoch === opEpoch && ownerId === opOwner;
    let added = [];
    batchBusy = true;
    try {
      const res = await readingStore.applyKnownBatch(opOwner, entries, { guard: () => { if (!still()) throw new Error('READING_OWNER_CHANGED'); } });
      if (!still()) return;
      state = res.state;
      added = res.result.added;
    } catch (err) {
      if (!still()) return;
      toast(String(err?.message || err), 'bad');
      return;
    } finally {
      batchBusy = false;
    }
    batchOpen = false;
    renderArticle();
    renderSide();
    toast(added.length ? `已標示 ${added.length} 字為已懂（可整批撤回）` : '沒有新增任何字', added.length ? 'ok' : '');
  }

  async function undoBatch() {
    const opOwner = ownerId;
    const opEpoch = authEpoch;
    const still = () => mounted && gen === mountGeneration && authEpoch === opEpoch && ownerId === opOwner;
    let removed = 0;
    try {
      const res = await readingStore.undoLastBatch(opOwner, { guard: () => { if (!still()) throw new Error('READING_OWNER_CHANGED'); } });
      if (!still()) return;
      state = res.state;
      removed = res.result.removed.length;
    } catch (err) {
      if (!still()) return;
      toast(String(err?.message || err), 'bad');
      return;
    }
    renderArticle();
    renderSide();
    toast(removed ? `已撤回上次批次的 ${removed} 個字` : '沒有可撤回的批次', removed ? 'ok' : '');
  }

  // ---------- 事件 ----------
  async function onClick(event) {
    if (!alive()) return;
    const target = event.target.closest('[data-rw]');
    if (!target) return;
    const action = target.dataset.rw;
    if (action === 'open-word') {
      event.preventDefault();
      openWord(Number(target.dataset.pi), Number(target.dataset.ti));
      return;
    }
    if (action === 'close-word') { event.preventDefault(); closeWord(true); return; }
    if (action === 'go-lookup') { closeWord(false); return; } // 不 preventDefault：讓連結照常到查詢頁
    if (action === 'toggle-book') { await toggleEntry('book'); return; }
    if (action === 'toggle-review') { await toggleEntry('review'); return; }
    if (action === 'toggle-known') { await toggleEntry('known'); return; }
    if (action === 'withdraw') { await withdraw(target.dataset.bucket, target.dataset.key); return; }
    if (action === 'batch-open') { batchOpen = true; renderBatch(); main.querySelector('[data-rw="batch-apply"]')?.focus(); return; }
    if (action === 'batch-cancel') { batchOpen = false; renderBatch(); main.querySelector('[data-rw="batch-open"]')?.focus(); return; }
    if (action === 'batch-apply') { await applyBatch(); return; }
    if (action === 'batch-undo') { await undoBatch(); return; }
    if (action === 'pick-archive') { await pickArchive(target.dataset.id); return; }
    if (action === 'archive-prev') { archivePage = Math.max(0, archivePage - 1); renderArchive(); return; }
    if (action === 'archive-next') { archivePage += 1; renderArchive(); return; }
    if (action === 'retry-archive') { archiveError = ''; ensureArchive(); return; }
    if (action === 'apply-paste') { await applyPaste(); return; }
    if (action === 'clear-paste') { await clearPaste(); return; }
    if (action === 'copy-word') {
      const word = target.dataset.word || '';
      const done = () => toast(`已複製「${word}」`, 'ok');
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(word).then(done, () => toast('複製失敗，請手動選取', 'bad'));
      else toast('此環境不支援剪貼簿', 'bad');
    }
  }

  function onChange(event) {
    if (event.target.name === 'rw-source') {
      sourceTab = event.target.value === 'archive' ? 'archive' : 'paste';
      renderSourceTabs();
      if (sourceTab === 'archive') ensureArchive();
      return;
    }
    if (event.target.id === 'rw-year') {
      yearFilter = event.target.value;
      archivePage = 0;
      renderArchive();
      return;
    }
    if (event.target.id === 'rw-paste-text') {
      renderPasteMeta();
      return;
    }
  }

  function onInput(event) {
    if (event.target.id === 'rw-paste-text') renderPasteMeta();
  }

  function onKeydown(event) {
    if (!alive()) return;
    if (event.key === 'Escape') {
      if (wordOpen) { event.preventDefault(); closeWord(true); return; }
      if (batchOpen) { event.preventDefault(); batchOpen = false; renderBatch(); return; }
    }
    if (event.key === 'Tab' && wordOpen) {
      const focusable = [...panel.querySelectorAll('button, [href], summary, input, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter((node) => !node.disabled && node.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }

  main.addEventListener('click', onClick);
  main.addEventListener('change', onChange);
  main.addEventListener('input', onInput);
  document.addEventListener('keydown', onKeydown);

  // 換帳號：先把畫面清成新 owner 的空狀態，再 async 讀新 owner；
  // 只有最後一次載入（token／epoch／owner 三關都對）才套用，await 後的舊資料不會畫回。
  function applyOwnerState(next) {
    state = next;
    article = next.article ? { ...next.article } : null;
    doc = article ? tokenizeArticle(article.text) : null;
    annotated = null;
    stats = new Map();
    batchOpen = false;
    closeWord(false);
    yearFilter = 'all';
    archivePage = 0;
    sourceTab = article?.source === 'archive' ? 'archive' : 'paste';
    titleInput.value = article?.source === 'paste' ? (article.title || '') : '';
    textArea.value = article?.source === 'paste' ? (article.text || '') : '';
    if (wordsReady && doc) annotateNow();
    renderPasteMeta();
    renderAll();
    if (sourceTab === 'archive') ensureArchive();
  }

  offs.push(on('auth:changed', () => {
    if (!alive()) return;
    authEpoch++;
    const epoch = authEpoch;
    const token = ++stateLoadToken;
    const nextOwner = currentOwner();
    ownerId = nextOwner;
    applyOwnerState(readingStore.emptyState(nextOwner)); // 立刻清掉上一個帳戶的畫面
    (async () => {
      let next = null;
      try {
        next = await readingStore.readState(nextOwner);
      } catch (err) {
        if (!alive() || token !== stateLoadToken) return;
        storageError = String(err?.message || err);
        toast(`本機資料庫無法使用：${storageError}`, 'bad');
        return;
      }
      // await 之後三關都對才畫：遲到的 A 結果不會套到 B（或 A→B→A 之後的新頁）。
      if (!alive() || token !== stateLoadToken || epoch !== authEpoch || ownerId !== nextOwner) return;
      storageError = '';
      applyOwnerState(next);
    })();
  }));

  // 路由離開由 onLeave 收尾（router 已把 reading 納入離頁清理清單）。
}
