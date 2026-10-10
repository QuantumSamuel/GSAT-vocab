// ============================================================
// 頁面：模擬考（4.2.0；5.0 加入 AI 題庫卷；5.2 加入考古題來源）
// 三個來源嚴格分離（紅線）：
//   real    data/questions/real.json（歷屆真題 E／N 卷），題目資料在 exam-data.js
//   ai      data/questions/ai/（AI 題庫），year:'AI'、paper A1/B1/V1，由 ai-bank.js 攤平
//   archive data/questions/archive/archive_v1.json（考古題：大考中心歷屆題目整理），
//           由 archive-bank.js 攤平；每題 sourceType:'archive'、paper 為「屆次＋考試別」
// 本頁只負責組卷參數與畫面；三者的攤平／排序都在各自的資料層。
// 流程：設定畫面 → 作答（復用 Question Shell）→ 成績報告
// 訪客可用（題目全在本機、答案不外傳），故不設註冊牆。
// ============================================================
import { el, escapeHtml, ICONS, iconInline, openDialog } from '../core/ui.js';
import { mountShell } from '../practice/shell.js';
import { clearBackHandler, setBackHandler } from '../core/router.js';
import { addEvent, bumpMistake, recordMistake } from '../services/store.js';
import { DROP_REASONS, PAPERS, SECTIONS, YEARS, buildPaperRun, groupGaps, isUsable, loadRealBank, paperKey, qPaperKey, sectionStats, usableCountByPaper } from '../practice/exam-data.js';
import { AI_PAPERS, AI_PAPER_SECTIONS, aiPaperCounts, loadAiBank } from '../practice/ai-bank.js';
import { archiveQuestions, archiveScopeCount, archiveYears, archiveYearFilter, FIGURE_BASE, loadArchiveBank } from '../practice/archive-bank.js';

// 5.2 考古題：屆次範圍三選一（全部／近 10 屆／105 屆起）、抽題數（10/20/40/全部）
const ARCHIVE_SCOPES = [
  { id: 'all', label: '全部' },
  { id: 'recent10', label: '近 10 屆' },
  { id: 'since105', label: '105 屆起' },
];
const ARCHIVE_SIZES = ['10', '20', '40', 'all'];

/** Fisher-Yates（回新陣列）；本檔自帶而不 import shell.js 的 shuffle，讓測試可直接驗組卷 */
const shuffleArr = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// 進行中的場次（切到其他頁再回來不中斷；「再練一次」時清空）
let run = null;
// { mode, papers, questions, idx, results:[{picked,good}], dropped, bank:'real'|'ai'|'archive', isMistakeRetry? }
// 5.0.x：isMistakeRetry＝由錯題本「錯題當卷重考」進來（同一引擎、同一作答流程，
//   只是錯題再錯時累計次數而不另建列）
let pendingRetry = null; // 從錯題本帶進來的 run（跨頁時保留；renderExam 進場取用）

export async function renderExam(main) {
  if (run) renderQuestion(main);
  else if (pendingRetry) startMistakeRetry(main, pendingRetry);
  else await renderSetup(main);
}

/**
 * 5.0.x（spec 5.7 第 3 節）：錯題本「錯題當卷重考」入口。
 * 由 mistake-bank.js 呼叫。參數可以是兩種形狀（都要能用，避免呼叫端各自猜）：
 *   ① buildMistakeRetryRun() 的回傳值 { run, total, used, skipped } —— 錯題本頁走這條；
 *   ② 直接給 run 本體（含 questions）—— 內部呼叫／測試走這條。
 * 上限 20 題由 mistake-bank.js 控管；這裡只負責「用同一引擎跑這一份卷」。
 */
export function startMistakeRetryWith(payload, mainEl) {
  const target = mainEl || document.getElementById('app');
  const retry = payload && Array.isArray(payload.questions) ? { run: payload } : payload;
  if (!retry || !retry.run) return false;
  pendingRetry = retry;
  startMistakeRetry(target, retry);
  return true;
}

function startMistakeRetry(main, retry) {
  pendingRetry = null;
  const base = retry.run || {};
  // bank 決定作答頁的題型標籤與錯題記錄的來源別（real／ai）；錯題本分頁已帶著，
  // 帶不動就依題目的 paper 猜（AI 卷的 paper 是 A1/B1/V1，真題卷是 E1…N4）。
  const bank = base.bank || (base.meta?.sourceType === 'ai' ? 'ai' : 'real');
  run = {
    ...base,
    mode: 'mistake-retry',
    bank,
    idx: 0,
    results: [],
    isMistakeRetry: true,
  };
  renderQuestion(main);
}

// ---------- 設定畫面 ----------
async function renderSetup(main) {
  let bank = null;
  let aiBank = null;
  let arcBank = null;
  let loadErr = null;
  let aiErr = '';
  let arcErr = '';
  try {
    bank = await loadRealBank(); // 1.4MB 僅在進入 #/exam 時載入（懶載入鐵律）
  } catch (err) {
    loadErr = String(err.message || err);
  }
  // 5.0：AI 題庫與真題同樣只在進入 #/exam 時載入一次（模組級快取，切換來源不重複 fetch）
  loadAiBank().then((b) => { aiBank = b; }).catch((err) => { aiErr = String(err.message || err); });
  // 5.2：考古題（archive_v1.json 3.2MB）同樣只在進 #/exam 時載入一次，非阻塞帶回
  loadArchiveBank().then((b) => { arcBank = b; }).catch((err) => { arcErr = String(err.message || err); });

  if (!bank) {
    main.replaceChildren(el(`
      <section class="card">
        <h2>歷屆真題模擬考</h2>
        <p class="warning">題庫載入失敗：${escapeHtml(loadErr)}</p>
        <div class="controls">
          <button class="btn primary" id="exam-retry">重試</button>
          <!-- 5.0.4 C 項：移除頁內「返回」鈕（返回走左上角 back-fab） -->
        </div>
      </section>`));
    main.querySelector('#exam-retry').addEventListener('click', () => renderSetup(main));
    return;
  }

  const counts = usableCountByPaper(bank); // 16 卷可用題數
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  // 真題卷別清單（學年＋卷型聯動後重畫；函式化才能在 AI 卷別與真題卷別間切換）
  const realPapersHtml = (y, et) => ['1', '2', '3', '4'].map((n) => {
    const pk = `${y}${et}${n}`;
    const cnt = counts[pk] ?? 0;
    const few = cnt > 0 && cnt < 30;
    return `
      <label class="level-item">
        <input type="radio" name="exam-paper" value="${pk}">
        <span>${pk}（${cnt} 題）${et === 'N' ? '・OCR' : ''}${few ? `・${iconInline(ICONS.warnTriangle, 11)}題數偏少` : ''}</span>
      </label>`;
  }).join('');

  main.replaceChildren(el(`
    <section class="card">
      <h2>歷屆真題模擬考</h2>
      <!-- 5.1.2 B-5（用戶 2026-10-07 核准）：單卷模式說明行移除；單卷語意已由「一次考一份」
           的卷別選擇與題型勾選本身表達，說明行屬重複。 -->

      <p><strong>試卷來源</strong></p>
      <div class="segmented" role="radiogroup" aria-label="試卷來源">
        <label><input type="radio" name="exam-src" value="real" checked><span>歷屆真題</span></label>
        <label><input type="radio" name="exam-src" value="ai"><span>AI 題庫</span></label>
        <label><input type="radio" name="exam-src" value="archive"><span>考古題</span></label>
      </div>

      <div id="exam-real-rows">
        <p><strong>學年</strong></p>
        <div class="level-grid" id="exam-years">
          ${YEARS.map((y) => `
            <label class="level-item"><input type="radio" name="exam-year" value="${y}"${y === 113 ? ' checked' : ''}><span>${y} 學測</span></label>`).join('')}
        </div>

        <p><strong>卷型</strong></p>
        <div class="level-grid" id="exam-etype">
          <label class="level-item"><input type="radio" name="exam-etype" value="E" checked><span>E 卷（文字層，品質最佳）</span></label>
          <label class="level-item"><input type="radio" name="exam-etype" value="N"><span>N 卷（OCR 掃描，可能有辨識誤差）</span></label>
        </div>
      </div>

      <!-- 5.2 考古題：屆次範圍＋題數。區段勾選沿用下方共用的「題型」列（同名五區段），
           不另開一組 checkbox，避免同一件事有兩個勾選來源互相打架。
           考古題不選卷別——它本來就是跨屆次的題庫池，所以卷別列會收起。 -->
      <div id="exam-archive-rows" class="hidden">
        <p><strong>屆次範圍</strong></p>
        <div class="segmented" role="radiogroup" aria-label="屆次範圍">
          ${ARCHIVE_SCOPES.map((sc, i) => `
            <label><input type="radio" name="exam-arc-scope" value="${sc.id}"${i === 0 ? ' checked' : ''}><span>${sc.label}</span></label>`).join('')}
        </div>
        <p class="settings-note muted small" id="exam-arc-scope-note"></p>

        <p><strong>題數</strong></p>
        <div class="segmented" role="radiogroup" aria-label="考古題題數">
          ${ARCHIVE_SIZES.map((v, i) => `
            <label><input type="radio" name="exam-arc-size" value="${v}"${i === 1 ? ' checked' : ''}><span>${v === 'all' ? '全部' : v}</span></label>`).join('')}
        </div>
        <p class="settings-note muted small" id="exam-arc-count-note"></p>
      </div>

      <p><strong>卷別</strong></p>
      <div class="level-grid" id="exam-papers"></div>

      <p><strong id="exam-sections-title">題型</strong>（依學測順序出題；剔除的題目自動跳過）</p>
      <div class="level-grid" id="exam-sections">
        ${['詞彙題', '綜合測驗', '文意選填', '篇章結構'].map((s) => `
          <label class="level-item"><input type="checkbox" name="exam-section" value="${s}" checked><span>${s}</span></label>`).join('')}
        <label class="level-item"><input type="checkbox" name="exam-section" value="中翻英" disabled><span>中翻英（建置中）</span></label>
        <label class="level-item"><input type="checkbox" name="exam-section" value="閱讀測驗" disabled><span>閱讀測驗（4.3.2）</span></label>
      </div>

      <p class="muted small" id="exam-note">${iconInline(ICONS.warnTriangle, 14)}<span>N 卷為 OCR 掃描：可用題數較少、個別題目帶辨識標記；剔除的題目會在成績頁列出。</span></p>
      <p class="warning" id="exam-warn"></p>
      <div class="controls">
        <button class="btn primary" id="exam-start">開始模擬考</button>
        <!-- 5.0.4 C 項：移除頁內「返回」鈕（返回走左上角 back-fab） -->
      </div>
    </section>`));

  const warn = main.querySelector('#exam-warn');
  const srcVal = () => main.querySelector('input[name="exam-src"]:checked')?.value || 'real';
  const yearVal = () => Number(main.querySelector('input[name="exam-year"]:checked')?.value || 113);
  const etypeVal = () => main.querySelector('input[name="exam-etype"]:checked')?.value || 'E';
  const arcScopeVal = () => main.querySelector('input[name="exam-arc-scope"]:checked')?.value || 'all';
  const arcSizeVal = () => main.querySelector('input[name="exam-arc-size"]:checked')?.value || '20';

  // 卷別清單重畫（單選：一次一份卷）。real 依學年＋卷型；ai 依 AI 卷別與各區段小計。
  // 4.3.1：預設選中第一份有題的卷（radio 需程式設定 checked——innerHTML 的 checked 屬性
  // 在 jsdom/重繪時不會作用在「後設的 default」上，瀏覽器需顯式指定）
  const renderPapers = () => {
    const isAi = srcVal() === 'ai';
    const host = main.querySelector('#exam-papers');
    // AI 卷別的題數與區段小計來自 aiPaperCounts（模組級快取：AI 題庫還沒到位時先顯示 0）
    const aiCounts = aiBank ? aiPaperCounts(aiBank) : null;
    host.innerHTML = isAi
      ? AI_PAPERS.map((p) => {
        const c = aiCounts ? aiCounts[p] : { total: 0, sections: {} };
        const secText = AI_PAPER_SECTIONS[p].map((s) => `${s} ${c.sections[s] ?? 0}`).join('・');
        return `
        <label class="level-item">
          <input type="radio" name="exam-paper" value="AI${p}"${c.total ? ' checked' : ' disabled'}>
          <span>${p}（${c.total} 題）・${secText}</span>
        </label>`;
      }).join('')
      : realPapersHtml(yearVal(), etypeVal());
    const firstUsable = host.querySelector('input:not([disabled])');
    if (firstUsable) firstUsable.checked = true;
  };
  renderPapers();
  main.querySelectorAll('input[name="exam-year"]').forEach((r) => r.addEventListener('change', renderPapers));
  main.querySelectorAll('input[name="exam-etype"]').forEach((r) => r.addEventListener('change', renderPapers));

  // 5.0：題型勾選隨所選 AI 卷連動——該卷沒有的區段停用並取消勾選；
  // 換卷別／換來源時重新勾上該卷可用的區段（否則使用者會卡在「一個題型都沒勾」）。
  //（真題卷的「閱讀測驗」維持停用：real 卷啟用閱讀是 5.0 待辦，另案）
  const OCR_NOTE = 'N 卷為 OCR 掃描：可用題數較少、個別題目帶辨識標記；剔除的題目會在成績頁列出。';
  const AI_NOTE = 'AI 題庫為 GLM 產生、逐題複核過的題目（非歷屆真題），答題後會顯示解析。';
  // 5.2：考古題＝大考中心歷屆題目（含參考試卷）整理，答題後顯示官方解析與文章中譯。
  const ARC_NOTE = '考古題為大考中心歷屆題目（含參考試卷）整理：依區段勾選＋屆次範圍抽題，答題後顯示解析與文章中譯。';
  // 勾選策略只認「本次新變成可用的題型」：
  //   ① 新可用 → 自動勾上（AI 卷到位、A1↔V1 換卷等「本來沒有、不能不打勾」的情境）
  //   ② 一直可用 → 保留使用者現況（real 模式換卷別不重置勾選；不搶手動取消）
  //   ③ 變成不可用 → 停用＋取消勾選
  // 首次呼叫（prevOn 為 null）走 ① 的初始狀態：把該來源可用的題型全部勾上。
  let prevOn = null; // 上一次同步時「可用（未停用）」的題型集合
  const syncSections = () => {
    const src = srcVal();
    const isAi = src === 'ai';
    const isArc = src === 'archive';
    const paper = (main.querySelector('input[name="exam-paper"]:checked')?.value || '');
    const allow = isAi
      ? new Set(AI_PAPER_SECTIONS[String(paper).replace(/^AI/, '')] || [])
      : null;
    const nowOn = new Set();
    main.querySelectorAll('input[name="exam-section"]').forEach((b) => {
      if (b.value === '中翻英') { b.disabled = true; b.checked = false; return; } // 兩種引擎都還沒接上
      // real 卷閱讀測驗仍未開放；考古題五區段全開（其題庫本來就有閱讀）
      const locked = !isArc && (b.value === '閱讀測驗');
      const on = isArc ? true : (!isAi ? !locked : (allow ? allow.has(b.value) : false));
      b.disabled = !on;
      if (!on) { b.checked = false; return; }
      nowOn.add(b.value);
      if (!prevOn || !prevOn.has(b.value)) b.checked = true;
    });
    prevOn = nowOn;
    main.querySelector('#exam-real-rows').classList.toggle('hidden', isAi || isArc);
    // 5.2：考古題沒有「卷別」可選（跨屆次的題庫池）→ 卷別列收起；區段勾選沿用共用的題型列
    main.querySelector('#exam-papers').classList.toggle('hidden', isArc);
    main.querySelector('#exam-archive-rows').classList.toggle('hidden', !isArc);
    // 題型列的小標：考古題的「區段」就是這五個區段，標題跟著換（同一組 checkbox，不另開一組）
    const title = main.querySelector('#exam-sections-title');
    if (title) title.textContent = isArc ? '區段' : '題型';
    // 說明行的圖標與文字一起換：文字走 escapeHtml（XSS 紅線：不裸插 innerHTML）
    const note = isArc
      ? (arcErr ? `考古題載入失敗：${arcErr}` : ARC_NOTE)
      : (isAi ? (aiErr ? `AI 題庫載入失敗：${aiErr}` : AI_NOTE) : OCR_NOTE);
    main.querySelector('#exam-note').innerHTML = `${iconInline(ICONS.warnTriangle, 14)}${escapeHtml(note)}`;
    syncArcNotes();
  };
  /**
   * 5.2：考古題區塊的題數說明（非同步回填——考古題還在載入時先顯示「載入中」）。
   * 數字取自 archiveScopeCount：屆次範圍 ∩ 目前勾選的區段的可用題數，
   * 使用者換範圍／換區段就會看到「這個組合其實只有幾題」。
   */
  const syncArcNotes = () => {
    if (srcVal() !== 'archive') return;
    const scopeNote = main.querySelector('#exam-arc-scope-note');
    const countNote = main.querySelector('#exam-arc-count-note');
    const secs = [...main.querySelectorAll('input[name="exam-section"]:checked')].map((i) => i.value);
    if (!arcBank) {
      if (scopeNote) scopeNote.textContent = arcErr ? `考古題載入失敗：${arcErr}` : '考古題載入中…';
      if (countNote) countNote.textContent = '';
      return;
    }
    const years = archiveYears(arcBank);
    const label = (ARCHIVE_SCOPES.find((s) => s.id === arcScopeVal()) || {}).label || '全部';
    // secs 可能是空（使用者把區段全取消了）→ archiveScopeCount 收到空陣列會當「不過濾」，
    // 顯示全庫題數會誤導；此時直接說明「請至少勾一個區段」
    const n = secs.length ? archiveScopeCount(arcBank, arcScopeVal(), secs) : 0;
    if (scopeNote) {
      scopeNote.textContent = secs.length
        ? `考古題涵蓋 ${years[0]}～${years[years.length - 1]} 屆（${years.length} 屆，另有無年份的參考試卷只在「全部」可抽）；屆次範圍「${label}」在目前勾選的區段有 ${n} 題。`
        : '考古題涵蓋 ' + years[0] + '～' + years[years.length - 1] + ` 屆（${years.length} 屆）；請至少勾選一個區段。`;
    }
    if (countNote) countNote.textContent = '考古題依「可作答的完整單位」抽題：文意選填／篇章結構為共用選項池的整組，會整組一起抽出。';
  };
  main.querySelector('#exam-archive-rows').addEventListener('change', (e) => {
    if (e.target?.name === 'exam-arc-scope') syncArcNotes();
  });
  // 區段勾選（共用題型列）變動也會改考古題的可抽題數
  main.querySelector('#exam-sections').addEventListener('change', syncArcNotes);
  main.querySelectorAll('input[name="exam-src"]').forEach((r) => r.addEventListener('change', () => {
    renderPapers();
    syncSections();
  }));
  // 卷別 radio 由 renderPapers 逐次重畫（innerHTML 會換掉節點）→ 監聽掛在容器上做事件委派，
  // 否則換卷別後新產生的 radio 不會觸發 syncSections（題型勾選不會跟著卷別走）
  main.querySelector('#exam-papers').addEventListener('change', (e) => {
    if (e.target?.name === 'exam-paper') syncSections();
  });
  syncSections();
  // AI 題庫是非同步載入的（模組快取）：到位後同時重畫卷別清單與題型勾選
  //（syncSections 必須一起呼叫——只有 renderPapers 會讓題型停在「全 off」而無法開始）
  loadAiBank().then((b) => {
    aiBank = b;
    if (srcVal() === 'ai') { renderPapers(); syncSections(); }
  }).catch(() => {});
  // 5.2 考古題同樣非阻塞帶回：到位後只要重跑 syncSections（屆次範圍的可抽題數在區塊內更新），
  // 題型勾選狀態已由 syncSections 在使用者切到考古題時設定好，不需重置
  loadArchiveBank().then((b) => {
    arcBank = b;
    syncArcNotes();
  }).catch(() => {});

  main.querySelector('#exam-start').addEventListener('click', () => {
    const src = srcVal();
    const sections = [...main.querySelectorAll('input[name="exam-section"]:checked')].map((i) => i.value);
    if (!sections.length) { warn.textContent = '請至少勾選一個題型。'; return; }
    let built;
    if (src === 'archive') {
      // 5.2 考古題：不走 buildPaperRun（考古題沒有 E/N 卷別，題目來自八個區段資料夾），
      // 改為 archiveQuestions 篩選＋抽 N 題，再照 SECTIONS 的學測卷面順序排序。
      if (!arcBank) { warn.textContent = '考古題還在載入，請稍候再試。'; return; }
      built = buildArchiveRun(arcBank, { sections, scope: arcScopeVal(), size: arcSizeVal() });
      if (!built.questions.length) {
        warn.textContent = '這個組合沒有可作答的考古題，請放寬屆次範圍或換區段。';
        return;
      }
      run = { ...built, mode: 'paper', bank: 'archive', idx: 0, results: [] };
      renderQuestion(main);
      return;
    }
    const pk = main.querySelector('input[name="exam-paper"]:checked')?.value || '';
    if (!pk) { warn.textContent = '這份卷別沒有可作答的題目，請換一份。'; return; }
    if (src === 'ai') {
      if (!aiBank) { warn.textContent = 'AI 題庫還在載入，請稍候再試。'; return; }
      const paper = pk.replace(/^AI/, '');
      built = buildPaperRun(aiBank, { year: 'AI', paper, sections }); // AI 卷：year 為字串 'AI'
      run = { ...built, mode: 'paper', bank: 'ai', idx: 0, results: [] };
    } else {
      const year = yearVal();
      const paper = pk.slice(String(year).length);
      built = buildPaperRun(bank, { year, paper, sections });
      run = { ...built, mode: 'paper', bank: 'real', idx: 0, results: [] };
    }
    if (!built.questions.length) {
      warn.textContent = '這個組合沒有可作答的題目，請換卷別或題型。';
      return;
    }
    renderQuestion(main);
  });
}

/**
 * 5.2 考古題組卷：區段 ∩ 屆次範圍 → 抽 N 題 → 照 SECTIONS 順序排。
 *
 * 與 real／AI 卷的差別（都刻意的）：
 *   ① 不走 buildPaperRun——考古題沒有「一份卷」的概念，是 81～115 屆跨屆的題目池；
 *      paper 欄是「屆次＋考試別」（如 109學測），每屆本身就是一個可辨識的子集。
 *   ② 抽題在「整組」之前先做段落級過濾，但文意選填／篇章結構是共用選項池的整組題：
 *      抽到某格就必須連整組帶進來，否則 passage 會出現沒有題目的空格。
 *      故抽題單位＝「可作答的最小完整單位」：非共用池題逐題、cloze-bank 題整組。
 *   ③ 抽完照 SECTIONS（學測卷面順序）＋屆次＋組序排出，作答順序與真題卷一致。
 */
function buildArchiveRun(arcBank, { sections, scope, size }) {
  const pool = archiveQuestions(arcBank, { ...(archiveYearFilter(arcBank, scope) || {}), sections });
  // 過濾掉不可作答者（走 exam-data 的同一套剔除規則：isUsable）——考古題全為站方整理，
  // buildChecks 已驗 0 命中，但保留這道保險，題庫日後改版也不會出空按鈕
  const usable = pool.filter((q) => isUsable(q));
  const secRank = (s) => Math.max(0, SECTIONS.indexOf(s));
  const order = (a, b) => (secRank(a.section) - secRank(b.section))
    || ((a.group ?? 0) - (b.group ?? 0))
    || ((a.qnum ?? 0) - (b.qnum ?? 0));
  usable.sort(order);

  const want = size === 'all' ? usable.length : Math.max(1, Number(size) || 20);
  // 抽題單位＝「可作答的最小完整單位」：共用選項池的題（文意選填／篇章結構）必須整組一起抽，
  // 否則 passage 會出現沒有題目的空格。
  // 整組大小不一（篇章實測 4／5／6 格、文意 10／12 格），使用者要 20 題不一定抽得到剛好 20：
  // 規則是「不超過上限，且不放棄整組」——依序塞塞得下的組，塞不下的跳過；
  // 若一個都塞不下（上限比最小的組還小），才退而取最小的一組並提示題數會少於設定值。
  const units = [];
  const seen = new Set();
  for (const q of usable) {
    const gk = q.option_pool === 'cloze-bank' ? `${q.section}#${q.group}` : null;
    if (gk && seen.has(gk)) continue;
    if (gk) seen.add(gk);
    units.push(gk ? usable.filter((m) => `${m.section}#${m.group}` === gk) : [q]);
  }
  const picked = [];
  let budget = want;
  for (const unit of shuffleArr(units)) {
    if (unit.length > budget) continue; // 不硬塞半組
    picked.push(...unit);
    budget -= unit.length;
  }
  if (!picked.length && units.length) {
    // 上限比任何一組都小 → 取最小的一組（至少讓使用者有題可做；實際題數在 meta.actual）
    const smallest = units.reduce((a, b) => (a.length <= b.length ? a : b));
    picked.push(...smallest);
  }
  picked.sort(order);
  const years = [...new Set(picked.map((q) => q.year).filter((y) => y != null))].sort((a, b) => b - a);
  return {
    papers: [`考古題 ${years[0] ?? ''}～${years[years.length - 1] ?? ''}（${years.length} 屆）`],
    questions: picked,
    dropped: { total: 0, byReason: {} },
    meta: { scope, sections, size: picked.length, want, years },
  };
}

// ---------- 單題渲染（復用 Question Shell） ----------
function renderQuestion(main) {
  const q = run.questions[run.idx];
  const prev = run.results[run.idx]; // 已答過 → 還原狀態且不重複計分
  const key = qPaperKey(q);
  // 5.0：AI 題 year 為 'AI'，qPaperKey 會拼出「AIA1」——改用 AI 卷別（AI ${paper}）
  const isAi = run.bank === 'ai';
  // 5.2：考古題的 paper 已是「屆次＋考試別」（如 109學測），題型標籤直接用 paper
  const isArc = run.bank === 'archive';
  const typeLabel = isArc ? `考古題 ${q.paper}・${q.section}` : (isAi ? `AI ${q.paper}・${q.section}` : `${key}・${q.section}`);

  const shell = mountShell(main, {
    typeLabel, // mountShell 內部已 escapeHtml（shell.js:18）
    cur: run.idx + 1,
    total: run.questions.length,
    canPrev: run.idx > 0,
    canNext: run.idx < run.questions.length - 1,
    onPrev: () => { run.idx--; renderQuestion(main); },
    onNext: () => { run.idx++; renderQuestion(main); },
  });

  const opts = Array.isArray(q.options) ? q.options : [];
  const texts = Array.isArray(q.option_texts) ? q.option_texts : [];
  const isBank = q.option_pool === 'cloze-bank';
  const maybe = Array.isArray(q.maybe) ? q.maybe : [];

  // 5.2：考古題的段落型題目（綜合測驗／文意選填／篇章結構／閱讀）把「當前這格」強調出來，
  // 與 selection.js 的克漏字／文意選填一致（比照其 renderCloze 的 .passage-blank 規則）。
  // 標記已是 [n]（archive-bank.js 攤平時就從 {NN} 換過來），故用 [一至二兩位數] 匹配。
  const passageHtml = q.passage
    ? `<div class="sel-passage">${escapeHtml(q.passage).replace(
      /\[(\d{1,2})\]/g,
      (m, n) => `<strong class="${Number(n) === q.qnum ? 'passage-blank' : ''}">[${n}]</strong>`,
    )}</div>`
    : '';
  // 5.1.0（方案 b）考古題附圖：閱讀測驗有 13 題是圖表題，題幹要看圖才答得出來。
  // 圖檔已收入本機 data/questions/archive/figures/（檔名＝build 產出的 webp 檔名），
  // 不外連站方 → 離線也看得到，且站方改版不會讓本站的題變成壞圖。
  // 位置＝文章之後、題幹之前：題目問的就是圖上的東西，圖在題幹上方才讀得到順序。
  // XSS 紅線：src 與圖下出處都是外部資料（站方整理檔的檔名與出處文字），一律 escapeHtml。
  // 只有考古題會有 figure 欄位（isArc 判斷），real／AI 卷不受影響。
  const fig = (isArc && q.figure && q.figure.file) ? q.figure : null;
  const figureHtml = fig
    ? `<figure class="q-figure">
        <img src="${escapeHtml(FIGURE_BASE + fig.file)}" alt="題目附圖${fig.source ? `（${escapeHtml(fig.source)}）` : ""}" loading="lazy">
        ${fig.source ? `<figcaption class="tp-caption">附圖出處：${escapeHtml(fig.source)}</figcaption>` : ''}
      </figure>`
    : '';

  // 5.0.x：錯題重考的說明（來源／區段／取用幾題）——換頁後這是使用者唯一看得到的地方
  const retryNote = run.mode === 'mistake-retry' && run.meta?.note
    ? `<p class="tp-caption note-tense" role="status">${escapeHtml(run.meta.note)}（錯題重考：來源 ${escapeHtml(SRC_NAME(run.bank))}・${escapeHtml(String(run.meta.section || '全部區段'))}）</p>`
    : '';
  shell.content.appendChild(el(`
    <div>
      ${retryNote}
      ${passageHtml}
      ${figureHtml}
      <p class="tp-body">${escapeHtml(q.stem)}</p>
      <p class="tp-caption">第 ${escapeHtml(String(q.qnum))} 題${isBank ? '（整組共用選項）' : ''}${maybe.length ? `　${iconInline(ICONS.warnTriangle, 12)}${escapeHtml(maybe.join('；'))}` : ''}</p>
      <div id="exam-opts">
        ${opts.map((letter, i) => `
          <button class="sel-option" data-i="${i}">${escapeHtml(letter)}. ${escapeHtml(texts[i] ?? '')}</button>`).join('')}
      </div>
      <div class="tp-caption" id="exam-explain"></div>
    </div>`));

  // 5.2：文章中譯只在「本題是該組第一題」時摺疊顯示一次（逐題重複會把頁面拉得很長）
  if (isArc && q.passageZh && isGroupHead(run, run.idx)) {
    // 內容走 textContent（外部資料；紅線），不拼 HTML 字串
    const zhBox = document.createElement('details');
    zhBox.className = 'passage-zh';
    const zhSummary = document.createElement('summary');
    zhSummary.textContent = '文章中文翻譯';
    const zhBody = document.createElement('div');
    zhBody.className = 'passage-zh-body';
    zhBody.textContent = String(q.passageZh);
    zhBox.append(zhSummary, zhBody);
    const host = shell.content.querySelector('.sel-passage');
    // .after() 在部分環境（jsdom 的 fragment 節點）不會落到 DOM，改用 parent.insertBefore
    if (host?.parentElement) host.parentElement.insertBefore(zhBox, host.nextSibling);
    else shell.content.appendChild(zhBox);
  }

  const btns = shell.content.querySelectorAll('.sel-option');

  /**
   * 結束本次模擬考（4.2.0 修復提供出口；5.1.2 起同時是 back-fab 的情境返回）。
   * 【為什麼要抽出來】作答中按左上角返回，語意等同「結束本次」——
   *   直接退一頁會把這場留在記憶體裡、畫面卻停在別頁，返回鈕的行為也亂掉。
   *   取消時場次還在，handler 要留著（下一鍵才接得上）；確認後場次結束，清掉。
   *   owner 是本函式（每次換題同一個函式本體），clearBackHandler 才不會誤清別頁的 handler。
   */
  async function quitExam() {
    // 4.2.0：confirm → openDialog（結束＝離開流程但不是破壞性資料操作，danger: false）
    const ok = await openDialog({
      title: '結束本次模擬考',
      body: '結束本次模擬考？已作答的題目不會保存。',
      danger: false,
      okText: '結束',
      cancelText: '繼續考',
    });
    if (!ok) return;
    run = null;
    clearBackHandler(quitExam);
    renderSetup(main);
  }
  // 4.2.0 修復（debug sweep Low）：作答中提供「結束本次」出口——修復前想換卷別必須走完整場
  const quit = document.createElement('button');
  quit.className = 'btn subtle';
  quit.textContent = '結束本次';
  quit.addEventListener('click', quitExam);
  main.querySelector('.q-nav').appendChild(quit);
  // 5.1.2：掛情境返回（mountShell 沒收到 onQuit——模擬考的結束鈕是自組的，這裡自己掛）
  setBackHandler(quitExam);

  const showResult = (picked) => {
    btns.forEach((b, i) => {
      b.disabled = true;
      if (opts[i] === q.answer) b.classList.add('f-correct');
      else if (i === picked) b.classList.add('f-wrong');
    });
    const good = run.results[run.idx]?.good;
    const ansText = texts[opts.indexOf(q.answer)] ?? q.answer;
    // 回饋走 textContent（shell.js 的 setFeedback），OCR 文字不需跳脫
    shell.setFeedback(
      good ? `答對了｜${q.answer}. ${ansText}` : `答錯了｜正解 ${q.answer}. ${ansText}`,
      good ? 'ok' : 'bad',
    );
    // 5.0：AI 題答題後顯示解析。走 textContent（AI 題庫的解析含引號、括號與原文，
    // 一律視為外部文字；紅線：不得 innerHTML 裸插）
    // 5.2：考古題的解析同路徑顯示（站方整理的長教學文同樣視為外部文字）
    const explainEl = shell.content.querySelector('#exam-explain');
    if ((isAi || isArc) && explainEl && q.explanation) explainEl.textContent = `解析：${q.explanation}`;
  };

  if (prev) {
    showResult(prev.picked);
  } else {
    btns.forEach((b) => b.addEventListener('click', () => {
      if (run.results[run.idx]) return; // 以 run 記錄已答題，翻頁往返不重複計分
      const picked = Number(b.dataset.i);
      const good = opts[picked] === q.answer;
      run.results[run.idx] = { picked, good };
      addEvent('quiz', null, { q: `exam:${q.section}`, ok: good }); // 4.1.1 慣例：題型作答計入統計
      // 5.0.x 錯題本：只有 real／ai 卷進（spec 5.7 第 3 節；考古題與錯題重考不重複記錄）
      if (!good && (run.bank === 'real' || run.bank === 'ai')) noteMistake(q, good, run);
      showResult(picked);
      if (run.idx === run.questions.length - 1) appendDone(shell.content, main);
    }));
  }
  if (run.idx === run.questions.length - 1) appendDone(shell.content, main);
}

/**
 * 5.0.x（spec 5.7 第 3 節）：答錯的題寫進錯題本。
 * 首次錯＝建立新列；同一題重考再錯＝bumpMistake 累計（不重複建列）。
 * paperKey 用「卷別識別碼」：real 卷＝113E1 這類，AI 卷＝AI A1（不可與真題卷號混淆，紅線）。
 * fire-and-forget：錯題記錄失敗不得影響作答。
 */
function noteMistake(q, good, runRef, isRetry = false) {
  const paperKey = runRef.bank === 'ai' ? `AI ${String(q.paper).replace(/^AI/, '')}` : `${q.year}${q.paper}`;
  const rec = {
    sourceType: runRef.bank === 'ai' ? 'ai' : 'real',
    paperKey,
    section: q.section,
    qnum: q.qnum,
    stem: q.stem || '',
    wordHead: Array.isArray(q.option_texts) && q.options ? (q.option_texts[q.options.indexOf(q.answer)] || null) : null,
  };
  const fn = isRetry ? bumpMistake(rec) : recordMistake(rec);
  if (fn && typeof fn.catch === 'function') fn.catch(() => {});
}

/** 來源顯示名（真題卷與 AI 卷嚴格分離，紅線：不可混淆） */
function SRC_NAME(bank) {
  return bank === 'ai' ? 'AI 題庫' : (bank === 'archive' ? '考古題' : '歷屆真題');
}

/**
 * 該題是否為題組的第一題（同一 passage 的第一個出現）。
 * 文章中譯只在這裡顯示一次——逐題重複會把作答頁拉得很長，且對讀者沒有新資訊。
 */
function isGroupHead(run, idx) {
  const q = run.questions[idx];
  if (!q || q.group == null) return true; // 詞彙題無組，每題都算首題（但也沒有 passageZh）
  if (idx === 0) return true; // 第一題必然是首題（迴圈不會執行，必須另外判定）
  for (let i = idx - 1; i >= 0; i--) {
    const p = run.questions[i];
    if (p.section !== q.section || p.group !== q.group) return true;
  }
  return false;
}

// 最後一題的完成出口（比照 selection.js 的 appendDoneButton）
function appendDone(container, main) {
  if (container.querySelector('#exam-done')) return;
  const done = document.createElement('button');
  done.className = 'btn primary';
  done.id = 'exam-done';
  done.textContent = '查看成績';
  done.addEventListener('click', () => showReport(main));
  const bar = document.createElement('div');
  bar.className = 'controls';
  bar.appendChild(done);
  container.appendChild(bar);
}

// ---------- 成績報告 ----------
function showReport(main) {
  // 5.1.2：場次已結束，把情境返回還給 routeStack（否則返回鈕還是「結束本次」的舊 handler）
  clearBackHandler();
  const qs = run.questions;
  const stats = sectionStats(qs, run.results);
  const answered = run.results.filter(Boolean).length;
  const correct = run.results.filter((r) => r && r.good).length;
  const dropEntries = Object.entries(run.dropped.byReason);

  // 分區段得分小表（附表頭，讓兩張表不像混在一起）
  const secTable = stats.map((s) => `
    <tr><td>${escapeHtml(s.section)}</td><td>${s.correct} / ${s.total}</td></tr>`).join('');
  // OCR 剔除明細（各原因的可讀文字；數字為題數）
  const dropTable = dropEntries.map(([code, n]) => `
    <tr><td>${escapeHtml(DROP_REASONS[code] || code)}</td><td>${n} 題</td></tr>`).join('');
  // 迷你測驗可能橫跨多卷，名單過長只顯示卷數
  // 5.0：AI 卷的 papers 是 'AIA1' 這類字串，成績頁顯示為「AI A1」，不讓人誤認為真題卷號
  const paperList = (run.bank === 'ai' ? run.papers.map((k) => `AI ${String(k).replace(/^AI/, '')}`) : run.papers);
  const paperText = paperList.length > 3
    ? `${paperList.length} 份卷別`
    : paperList.join('・');

  // 5.0.x 錯題重練（spec 第 2 節）：本次答錯的題組成記憶體臨時題集、同一引擎重跑。
  //   考古題（archive）不入錯題本（spec 第 3 節範圍只列 real／ai），故不掛這顆鈕。
  const retryQs = run.bank === 'archive'
    ? []
    : run.questions.filter((_, i) => run.results[i] && !run.results[i].good);

  main.replaceChildren(el(`
    <section class="card">
      <div class="completion">
        <h2>模擬考完成</h2>
        <!-- 5.1.1 B4：成績頁不放彩帶（考試不慶祝），僅分數彈入（d2-finish-score） -->
        <div class="c-score d2-finish-score">${correct} / ${qs.length}</div>
        <div class="c-stats">
          <div class="srs-box"><div class="num">${answered}</div><div class="label">已作答</div></div>
          <div class="srs-box"><div class="num">${qs.length - answered}</div><div class="label">未作答</div></div>
          <div class="srs-box"><div class="num exam-papers">${escapeHtml(paperText)}</div><div class="label">來源卷別</div></div>
        </div>
        <table class="exam-report">
          <tr class="er-head"><td colspan="2">各區段得分</td></tr>
          ${secTable}
          ${run.bank === 'archive' ? `<tr class="er-note"><td colspan="2">${escapeHtml(archiveNote(run.meta))}</td></tr>` : ''}
          ${dropEntries.length ? `
            <tr class="er-head"><td colspan="2">因 OCR 品質剔除 ${run.dropped.total} 題（已從題庫排除，與本次抽題無關）</td></tr>
            ${dropTable}
            ${run.mode === 'mini' ? '<tr class="er-note"><td colspan="2">迷你測驗僅從可用題中隨機抽題，其餘可用題未列入本次。</td></tr>' : ''}` : ''}
        </table>
        </table>
        <div class="c-actions">
          ${retryQs.length ? `<button class="btn primary" id="c-wrong">錯題重練（${retryQs.length}）</button>` : ''}
          <button class="btn ${retryQs.length ? '' : 'primary'}" id="c-again">再練一次</button>
          <!-- 5.0.4 C 項：成績頁的「返回」鈕移除，返回一律走左上角 back-fab -->
        </div>
      </div>
    </section>`));

  main.querySelector('#c-wrong')?.addEventListener('click', () => startMistakeRetry(main, { run: retryRunFor(retryQs) }));
  main.querySelector('#c-again').addEventListener('click', () => { run = null; renderSetup(main); });
}

/**
 * 5.0.x：把本次答錯的題組成一份臨時題卷（形狀同 buildPaperRun 的輸出）。
 * 臨時題集只活在這次 run 裡（不持久化）；同一批題目在錯題本裡的錯誤次數由
 * renderQuestion 的 noteMistake 走 bumpMistake 累計（isMistakeRetry=true）。
 */
function retryRunFor(wrongQs) {
  const papers = [...new Set(wrongQs.map((q) => (run.bank === 'ai'
    ? `AI ${String(q.paper).replace(/^AI/, '')}`
    : `${q.year}${q.paper}`)))];
  return {
    papers,
    questions: wrongQs,
    dropped: { total: 0, byReason: {} },
    meta: {
      fromMistakes: true,
      retryWrong: true,
      sourceType: run.bank,
      section: '本次錯題',
      used: wrongQs.length,
      total: wrongQs.length,
      note: `將重考 ${wrongQs.length} 題（本次答錯的題，來源 ${SRC_NAME(run.bank)}）。`,
    },
  };
}

/** 考古題成績頁的來源說明（屆次範圍＋屆數＋題數；內容全來自本次 run 的 meta） */
function archiveNote(meta) {
  const years = meta?.years || [];
  const span = years.length
    ? `屆次 ${years[years.length - 1]}～${years[0]}（${years.length} 屆）`
    : '屆次未標';
  return `來源：考古題（大考中心歷屆題目整理）；屆次範圍 ${(ARCHIVE_SCOPES.find((s) => s.id === meta?.scope) || {}).label || '全部'}，${span}，本次抽出 ${meta?.size ?? 0} 題。`;
}
