// ============================================================
// 練習共用 Question Shell（4.1.1：Unified Question Shell）
// 題型／進度 → 題目內容 → 答案區 → 提示／回饋 → 上一題／下一題
// 各題型只替換 Content Area；completion 亦由本模組提供
// 5.1.1 動效接線（spec B3/B4）：對錯回饋動畫、進度條填充、連對徽記與完成慶祝
// 都集中在殼層做一次——配對／選擇／拼寫三個引擎共用本題殼，
// 引擎端只在「作答當下」呼叫 combo.record，不需要各自重寫動畫。
// 【範圍界線・獨立驗證第 2 項已確認此界線成立】翻譯引擎（中譯英）不用本殼：
//   它自組題面（textarea＋標準答案區），且作答當下沒有對錯判定（對錯由事後按的
//   AI 批改給分），沒有可閃的 ok／bad；它只拿完成頁的分數彈入，不放彩帶——
//   沒有答對率就不猜比例（寧可少慶祝也不拿「作答率」冒充「答對率」）。
//   文意選填（selection.js renderDiscourse）同樣自組題殼，用 flashFeedback 單獨接。
// ============================================================
import { el, escapeHtml, ICONS } from '../core/ui.js';
import { replay } from '../core/motion.js';
import { dropConfetti } from '../core/celebrate.js';
import { setBackHandler, clearBackHandler } from '../core/router.js';

/**
 * 建立並掛載 Question Shell。
 * opts: { typeLabel, cur, total, main, onPrev, onNext, canPrev, canNext, onQuit,
 *         combo }（combo＝5.1.1 B4：core/motion.js 的 makeCombo() 實例，
 *         只有練習引擎傳（模擬考不傳＝考試不顯示連對）；傳了才在進度區掛徽記，
 *         並立即以目前連對數渲染一次，換題時徽記才不會憑空消失）
 * 【5.1.2】傳了 onQuit 就同時掛上「情境返回」：左上角返回鈕與殼內的提前結束鈕同款流程。
 * 回傳 { content, feedback, comboEl, setProgress(cur,total), setFeedback(text,kind), shell }
 */
export function mountShell(main, opts) {
  main.replaceChildren(el(`
    <section class="card">
      <div class="q-shell">
        <div class="q-shell-head">
          <span class="q-type">${escapeHtml(opts.typeLabel)}</span>
          <div class="q-progress-bar"><span id="qs-bar" style="width:0%"></span></div>
          <span class="q-progress-num" id="qs-num"></span>
          ${opts.combo ? '<span class="q-combo" id="qs-combo" aria-live="polite"></span>' : ''}
        </div>
        <div class="q-content" id="qs-content"></div>
        <div class="q-feedback-row"><div class="q-feedback" id="qs-feedback"></div></div>
        <div class="q-nav">
          <button class="btn q-nav-btn" id="qs-prev" ${opts.canPrev ? '' : 'disabled'}>${ICONS.chevronLeft} 上一題</button>
          <button class="btn primary q-nav-btn" id="qs-next" ${opts.canNext ? '' : 'disabled'}>下一題 ${ICONS.chevronRight}</button>
          <button class="btn btn-quit" id="qs-quit" ${opts.onQuit ? '' : 'hidden'}>提前結束</button>
        </div>
      </div>
    </section>`));
  const $ = (id) => main.querySelector('#' + id);
  const setProgress = (cur, total) => {
    // 5.1.1 B4：width 瞬設到目標比例（紅線 2：不做 width 過場，style.css 已移除舊的
    // width transition），填充感交給 d2-progress 的 scaleX 動畫（transform，不觸發重排）
    $('qs-bar').style.width = `${total ? Math.round((cur / total) * 100) : 0}%`;
    replay($('qs-bar'), 'd2-progress');
    $('qs-num').textContent = `${cur} / ${total}`;
  };
  setProgress(opts.cur, opts.total);
  const comboEl = opts.combo ? $('qs-combo') : null;
  if (opts.combo) opts.combo.render(comboEl); // 換題重掛時帶入前幾題的連對狀態（不足 2 自動隱藏）
  if (opts.onPrev) $('qs-prev').addEventListener('click', opts.onPrev);
  if (opts.onNext) $('qs-next').addEventListener('click', opts.onNext);
  // 4.3.1：提前結束（所有引擎通用——onQuit 由呼叫端提供，確認對話框也在呼叫端）
  if (opts.onQuit) $('qs-quit').addEventListener('click', opts.onQuit);
  // 5.1.2 缺陷 B：引擎作答中按左上角返回＝「提前結束」，與殼內的「提前結束」鈕同款。
  //   掛在殼層的好處是三個引擎與模擬考共用同一條接線（各引擎只要給 onQuit），
  //   換題重掛時 setBackHandler 會覆蓋成同一個函式本體，不會堆疊。
  //   【為什麼 owner 是 opts.onQuit】引擎每次換題都給新的箭頭函式，owner 就是那一顆；
  //   離場時（完成畫面／提前結束）引擎端呼叫 clearBackHandler(onQuit) 即可，
  //   不會誤清掉下一個引擎剛掛上的 handler。
  if (opts.onQuit) setBackHandler(opts.onQuit);
  else clearBackHandler(mountShell);
  return {
    content: $('qs-content'),
    feedback: $('qs-feedback'),
    prevBtn: $('qs-prev'),
    nextBtn: $('qs-next'),
    comboEl,
    setProgress,
    setFeedback(text, kind = '') {
      this.feedback.textContent = text || '';
      this.feedback.className = 'q-feedback' + (kind ? ' ' + kind : '');
      // 5.1.1 B3：對錯動畫疊加（d1-correct 彈跳＋tick 描繪／d1-wrong 震動＋cross），
      // 既有 ok／bad 著色不動；回看已答題（還原分支）會重現同一段回饋，動畫跟著重播一次，
      // 與「還原也重現著色」的既有行為同一語意。
      if (kind === 'ok' || kind === 'bad') flashFeedback(this.feedback, kind === 'ok');
    },
  };
}

// 對錯閃示圖示的計時器（同一元素重閃時先取消舊的，免得舊計時把新圖示提前淡掉）
const flashTimers = new WeakMap();

/**
 * 5.1.1 B3：對錯短暫圖示（答對 tick、答錯 cross），600ms 後淡出、約 1 秒後移除，
 * 不常駐佔版面（spec 明文）。匯出給自組題殼的文意選填（selection.js renderDiscourse）用。
 * 【為什麼圖示不是回饋元素的子節點】qa_5k_xss／qa_sweep_escape 等既有檢查把
 * 「.q-feedback 內出現任何元素」當作解析型注入的徵兆；站方圖示雖非注入，
 * 但放在專屬兄弟節點 .d1-mark 上可以兩全——檢查照樣有效、圖示照樣出現。
 */
export function flashFeedback(node, ok) {
  if (!node) return;
  replay(node, ok ? 'd1-correct' : 'd1-wrong');
  let mark = node.parentElement?.querySelector(':scope > .d1-mark');
  if (!mark) {
    mark = document.createElement('span');
    mark.className = 'd1-mark';
    node.before(mark);
  }
  for (const t of flashTimers.get(mark) || []) clearTimeout(t);
  mark.className = `d1-mark ${ok ? 'd1-mark--good' : 'd1-mark--bad'}`;
  mark.innerHTML = ok ? ICONS.tick : ICONS.cross; // ICONS 是站內常數 SVG（非外部資料）
  const t1 = setTimeout(() => mark.classList.add('d1-mark--out'), 600);
  const t2 = setTimeout(() => { mark.innerHTML = ''; mark.className = 'd1-mark'; }, 980);
  flashTimers.set(mark, [t1, t2]);
}

/**
 * 完成畫面：分數／統計／再練一次。
 * opts: { title, scoreText, stats: [{num,label}], onAgain,
 *         wrongCount?, onRetryWrong?, correct?, total? }
 *
 * 5.0.x（spec 5.7 第 2 節）：本次有錯題時多一顆「錯題重練」——
 * 把本次答錯的題組成**記憶體內**的臨時題集，用同一引擎、同一設定立刻重跑。
 * 臨時題集不持久化（持久化是錯題本 examMistakes 的事）。
 * wrongCount === 0 時不出現此按鈕（現狀不變）。
 *
 * 5.0.4 C 項：不再有「返回」鈕與 onBack。頁內返回鈕全數移除後，返回一律走左上角
 * back-fab（短按回上一頁、長按回主頁）；「再練一次／錯題重練」等動作鈕保留。
 *
 * 5.1.1 B4：分數掛 d2-finish-score 彈入；正確率滿 80% 才放彩帶（core/celebrate.js，
 * reduced-motion 時該函式自行擋下）。correct／total 由引擎端如實傳入，
 * 缺任一或 total 為 0 就不放——寧可少慶祝也不猜比例。模擬考成績頁不走本函式
 * （exam.js 自組報告），天然不受彩帶影響（考試不慶祝，spec B4）。
 */
export function mountCompletion(main, opts) {
  // 5.1.2 缺陷 B：完成畫面上沒有「提前結束」語意了（場次已結束），把情境返回還給
  // routeStack —— 否則使用者停在成績頁時按返回，會被 onQuit 的舊 handler 接走。
  clearBackHandler();
  const wrongCount = Number(opts.wrongCount || 0);
  const canRetry = wrongCount > 0 && typeof opts.onRetryWrong === 'function';
  main.replaceChildren(el(`
    <section class="card completion-host">
      <div class="completion">
        <h2>${escapeHtml(opts.title || '練習完成')}</h2>
        <div class="c-score d2-finish-score">${escapeHtml(opts.scoreText)}</div>
        <div class="c-stats">
          ${(opts.stats || []).map((s) => `
            <div class="srs-box"><div class="num">${escapeHtml(String(s.num))}</div><div class="label">${escapeHtml(s.label)}</div></div>`).join('')}
        </div>
        <div class="c-actions">
          ${canRetry ? '<button class="btn primary" id="c-wrong">錯題重練（' + wrongCount + '）</button>' : ''}
          <button class="btn ${canRetry ? '' : 'primary'}" id="c-again">再練一次</button>
        </div>
      </div>
    </section>`));
  main.querySelector('#c-wrong')?.addEventListener('click', opts.onRetryWrong);
  main.querySelector('#c-again')?.addEventListener('click', opts.onAgain);
  const total = Number(opts.total);
  const correct = Number(opts.correct);
  if (Number.isFinite(total) && Number.isFinite(correct) && total > 0 && correct / total >= 0.8) {
    dropConfetti(main.querySelector('.completion-host'));
  }
}

/**
 * 工具：洗牌（Fisher-Yates；回新陣列）
 */
export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 工具：從陣列抽 n 個不同元素（不含 exclude 集合）
 */
export function sampleExcluding(arr, n, exclude, pick = (x) => x) {
  const pool = shuffle(arr.filter((x) => !exclude.has(pick(x))));
  return pool.slice(0, n);
}
