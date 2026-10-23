// ============================================================
// 頁面：學習（5.0.4 A 項）——步驟式設定：學習方法 → 範圍 → 開始
//
// 為什麼要有這一頁：原本「隨機抽卡（＝看字記形）」藏在練習首頁的「隨機練習」按鈕後面，
//   但它其實不是測驗、不是計分，是學習。練習頁同時塞了測驗／學習／錯題回顧三種性質的
//   入口，首頁也分不出「練習」與「學習」。5.0.4 把學習抽成獨立一頁：
//     ① 首頁快捷格兩格改三格：練習／學習／查詢；抽屜「學習」群組多一個「學習」入口。
//     ② 學習方法二選一：單詞卡學習（隨機抽卡）＋拼寫學習（顯示字母模式）。
//     ③ 範圍（依方法出現對應選項）：字庫（星級 5 星～1 星 或 Lv1-7）＋預設單詞本（bank-picker 單選）。
//
// 兩種拼寫模式的差異（5.0.4 A／D 兩節並存不互干擾）：
//   練習拼寫＝**盲打**：作答中不顯示英文，只能看中文釋義（spelling.js opts.mode='blind'）
//   學習拼寫＝**顯示字母**：字母灰色顯示在格上，逐字打對轉綠（spelling.js opts.mode='show'）
//   引擎同一支（runWordSpell），只差 opts.mode；計分與統計路徑完全相同。
//
// 【搬遷不遺失】單詞卡學習＝原 practice.js 的隨機練習（等級／星級二維度）整組搬來，
//   抽卡流程仍是 practice.js 的同一支 startPractice（統計記錄、加入單詞本／複習計劃不變），
//   差異只在結束後的落點：mode==='study' 回本頁（其餘模式回練習首頁，行為不變）。
// ============================================================
import { getWords, getExam, loadExam, loadWords } from '../services/vocab.js';
import { el, escapeHtml, starsSvg } from '../core/ui.js';

// 學習方法（segmented 二選一；值即 opts.mode 的分流依據）
const METHODS = [
  { id: 'card', label: '單詞卡學習', desc: '隨機抽卡翻面：看字記形，可隨時加入單詞本與複習計劃' },
  { id: 'spell', label: '拼寫學習', desc: '字母以灰色顯示在格上，逐字打對轉綠；打完按 Enter 換下一題' },
];

// 字庫範圍的兩個維度（星級／等級）——沿用 practice.js 隨機練習的同一組標籤與勾選器
const DIM_STAR = 'star';
const DIM_LEVEL = 'level';

// 5.1.3 2.2：自選學多少個。
// 【為什麼獨立於 currentSelection()】字數限制不是「範圍描述」的一部分：scope/dim/vals/
//   presetName 是能重建字池的語意欄位，字數只是對既有字池的一次截斷。塞進 resumeMeta 的
//   語意欄位會讓「用哪些設定重建字池」與「學多少」混在一起，接續學習還原時分不出該不該
//   重新套用。0 代表全部（數字框留空）。
let countLimit = 0;
// 目前字池大小＝字數列的上限。只能由 poolForScope 的結果回填（效能鐵律：不為字數另外抓
// 任何資料來源），所以字數列的上限一律等預覽算完才有意義。
let countMax = 0;

// ============================================================
// 5.1.1 H1 接續學習：resume key 的唯一讀寫實作
// 為什麼集中在本檔：三個消費端各拿一半需求——practice.js 只寫／清、home.js 只讀（畫
// 橫幅）、本頁讀＋接回。放任三處各自組 payload 遲早漂移（形狀一變就要三處同步改），
// 故 key 名、TTL、欄位形狀全部收在這裡，practice/home 只 import 函式。
// spell 學習不走 practice.js 的抽卡 session，天然不序列化（spec：v1 只做抽卡接回）。
// ============================================================

// localStorage key 與 有效期（48 小時，spec 明文；超過視為範圍可能已過時，橫幅不再出現）
export const RESUME_KEY = 'vocab2_resume_study';
export const RESUME_TTL_MS = 48 * 60 * 60 * 1000;

/**
 * 序列化目前抽卡進度（practice.js nextCard 每成功抽一張呼叫一次；spec H1）。
 * meta 為 null（單詞本練習／不會單字場）時不寫——只有 mode==='study' 的場次可接回。
 * total 為 spec 形狀之外追加的欄位：橫幅要顯示「抽卡 idx+1/總數」，而總數（字池大小）
 * 無法從 scope/dim/vals 不重建字池就推出來（首頁不能為了算數同步載字庫，違反效能鐵律）。
 */
export function saveResumeStudy(meta, sessionLike) {
  if (!meta) return;
  try {
    localStorage.setItem(RESUME_KEY, JSON.stringify({
      scope: meta.scope,
      dim: meta.scope === 'bank' ? (meta.dim ?? null) : null,
      vals: meta.scope === 'bank' ? [...(meta.vals || [])] : null,
      presetName: meta.scope === 'preset' ? (meta.presetName ?? null) : null,
      shownIds: (sessionLike.shown || []).map((e) => e.word.id),
      idx: sessionLike.idx,
      total: (sessionLike.pool || []).length,
      // 5.1.3 2.2：字數限制一併存下，接回時才知道上次的字池被截到幾個。
      // 與 scope/dim/vals/presetName 分開存：那些是「重建字池的範圍」，count 只是「這次學幾個」。
      count: countLimit,
      at: Date.now(),
    }));
  } catch { /* 隱私模式等 localStorage 不可寫：接續功能靜默缺席，不影響練習本身 */ }
}

// 清除接續進度（結束練習／字池抽完／橫幅關閉／接回失敗都走這支）
export function clearResumeStudy() {
  try { localStorage.removeItem(RESUME_KEY); } catch { /* 同上 */ }
}

/**
 * 讀取接續進度（home.js 畫橫幅與本頁接回共用）。
 * 三種態（spec H1）：存在時原樣回傳；過期與毀損（JSON 壞或形狀不對）都靜默清除並回 null。
 * 讀取端就地把壞 key 清掉，呼叫端不必再分別處理。
 */
export function readResumeStudy() {
  let raw;
  try { raw = localStorage.getItem(RESUME_KEY); } catch { return null; }
  if (!raw) return null;
  let d;
  try { d = JSON.parse(raw); } catch {
    clearResumeStudy(); // 毀損 JSON：靜默清除不報錯（spec H1）
    return null;
  }
  const shapeOk = d
    && (d.scope === 'bank' || d.scope === 'preset')
    && Array.isArray(d.shownIds)
    && Number.isFinite(d.idx)
    && Number.isFinite(d.total)
    && Number.isFinite(d.at);
  if (!shapeOk) {
    clearResumeStudy();
    return null;
  }
  if (Date.now() - d.at > RESUME_TTL_MS) {
    clearResumeStudy(); // 過期：靜默清除不報錯（spec H1）
    return null;
  }
  return d;
}

export async function renderStudy(main) {
  main.replaceChildren(el(`
    <div class="study-layout">
      <section class="card study-settings-card">
        <!-- 5.1.2 A-1／A-2（用戶 2026-10-07 核准）：頁內大標題與定位說明行全數移除——
             頂欄 chrome-bar 已顯示頁名「學習」，頁內再放一次是重複；說明行屬操作提示，
             移到下方設定列的說明文字即可，不再另立一段。 -->
        <div class="settings-list" id="study-settings"></div>
        <div class="controls">
          <button class="btn primary" id="study-start">開始學習</button>
        </div>
        <p class="warning" id="study-warn"></p>
      </section>
      <!-- 5.1.1 S1：即時預覽卡（樣品 M4，accent 邊框）；手機單欄時退到設定下方 -->
      <aside class="card study-preview" id="study-preview">
        <p class="small study-preview-kicker">這次會學到</p>
        <div class="study-preview-num" id="study-prev-num">— 字</div>
        <p class="muted small" id="study-prev-dist"></p>
        <div class="study-preview-chips" id="study-prev-chips"></div>
      </aside>
    </div>`));

  const warn = () => main.querySelector('#study-warn');
  const host = main.querySelector('#study-settings');

  // ---------- 5.1.3 2.2：字數列（數字框＋滑桿互同步，上限跟著字池大小走） ----------
  // 上限只能從 poolForScope 的結果取得（效能鐵律：不為字數另外抓資料來源），所以每次預覽
  // 算完字池才回填；換範圍把字池變小時，超過新上限的字數會被夾回「全部」（而不是讓預覽
  // 顯示一個使用者根本選不到的字數）。
  const countEls = () => ({
    num: host.querySelector('#study-count-num'),
    slider: host.querySelector('#study-count-slider'),
    hint: host.querySelector('#study-count-hint'),
  });
  // 把 countLimit 寫回兩個輸入元件（兩者是同一個值的兩個入口，故永遠一起寫）。
  // countMax 為 0 代表字池還沒算出來（進頁初始、或接回在預覽之前跑），此時不夾值，
  // 只照填的值顯示，等第一次 syncCountUi 再校正上限。
  const writeCountUi = () => {
    const { num, slider } = countEls();
    if (!num || !slider) return;
    const top = Math.max(1, countMax);
    const shown = countMax > 0 ? Math.min(countLimit, top) : countLimit;
    num.value = countLimit > 0 ? String(shown) : '';   // 留空＝全部
    slider.value = String(countLimit > 0 ? shown : top);
  };
  // 字池大小更新時：校正上限、夾住超出值、處理只剩 1 字的情況（滑桿停用並說明原因）
  const syncCountUi = (max) => {
    countMax = Math.max(0, Number(max) || 0);
    const { num, slider, hint } = countEls();
    if (!slider || !hint) return;
    if (countLimit > countMax) countLimit = 0;   // 上限縮到比原值小：回到全部，不偷偷改成別的字數
    const top = String(Math.max(1, countMax));
    slider.max = top;
    num.max = top;
    slider.disabled = countMax <= 1;
    num.disabled = countMax <= 1;
    hint.textContent = countMax === 1 ? `範圍裡只有 ${countMax} 字，無法再少` : '';
    writeCountUi();
  };
  const bindCountUi = () => {
    const { num, slider } = countEls();
    if (!num || !slider) return;
    // 數字框：清空或填 0 都視為「全部」；超出上限的輸入夾回上限（與滑桿同一口徑）
    const onNum = () => {
      const raw = num.value.trim();
      const v = raw === '' ? 0 : Number(raw);
      countLimit = Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
      writeCountUi();
      schedulePreview();
    };
    num.addEventListener('input', onNum);
    num.addEventListener('change', onNum);
    slider.addEventListener('input', () => {
      countLimit = Number(slider.value) || 0;
      writeCountUi();
      schedulePreview();
    });
  };

  // ---------- 5.1.1 S1：即時預覽（右欄） ----------
  // 字池演算法一律走 poolForScope（開始按鈕、H1 接回、此處預覽共用同一份，
  // spec 明文禁止兩份漂移）。預設顯示提示而非 0——「0 字」會被誤讀成「這個範圍沒有字」。
  const prevNum = main.querySelector('#study-prev-num');
  const prevDist = main.querySelector('#study-prev-dist');
  const prevChips = main.querySelector('#study-prev-chips');
  const paintPreviewEmpty = (msg) => {
    if (!prevNum.isConnected) return;      // 期間已切頁或重畫
    prevNum.textContent = '— 字';
    prevDist.textContent = msg;
    prevChips.replaceChildren();
  };
  const paintPreview = (pool, dist) => {
    if (!prevNum.isConnected) return;
    prevNum.textContent = `${pool.length} 字`;
    // 格式照 spec S1：星級模式「5星×8」、Lv 模式「Lv4×8」
    prevDist.textContent = dist.map((d) => `${d.label}×${d.n}`).join('・');
    prevChips.replaceChildren(el(
      pool.slice(0, 5).map((w) => `<span class="chip">${escapeHtml(w.word)}</span>`).join('')
      + (pool.length > 5 ? `<span class="muted small">…另 ${pool.length - 5} 字</span>` : ''),
    ));
  };

  // 目前畫面的設定（開始按鈕與預覽共用同一個讀取口）
  const currentSelection = () => ({
    scope: host.querySelector('input[name="study-scope"]:checked')?.value || 'bank',
    dim: dim === DIM_LEVEL ? DIM_LEVEL : DIM_STAR,
    vals: [...host.querySelectorAll('#study-dim-grid input:checked')].map((i) => Number(i.value)),
    presetName: selectedPresetName,
  });

  // debounce 120ms（spec S1）：勾選連按時不重複算；previewSeq 擋住慢的回傳覆蓋新的結果
  let previewTimer = null;
  let previewSeq = 0;
  const schedulePreview = () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(runPreview, 120);
  };
  const runPreview = async () => {
    if (!host.isConnected) return;
    const sel = currentSelection();
    const my = ++previewSeq;
    const settle = (fn) => {
      if (my !== previewSeq || !host.isConnected) return;   // 已有更新的請求或已離頁
      fn();
    };
    try {
      if (sel.scope === 'bank' && !sel.vals.length) {
        settle(() => paintPreviewEmpty('先勾選星級或 Lv，這裡會顯示字池'));
        return;
      }
      if (sel.scope === 'preset' && !sel.presetName) {
        settle(() => paintPreviewEmpty('先選一本書，這裡會顯示字池'));
        return;
      }
      // getWords() 未載入會直接丟錯；loadWords 有 in-flight 去重，重複呼叫只抓一次。
      // 只在真的選了範圍才抓（上面的 hint 分支先回），進頁首屏不會因此多一次請求。
      await loadWords();
      const pool = await poolForScope(sel.scope, sel.dim, sel.vals, sel.presetName);
      const useStar = sel.scope === 'bank' && sel.dim === DIM_STAR;
      settle(() => {
        syncCountUi(pool.length);                       // 字數列上限＝目前字池大小
        // 5.1.3 2.2：預覽顯示的是「截斷後」的字池（與開始按鈕、接回同一支 applyCount），
        // 否則字數框填 10 而字池有 300 字時，預覽會顯示 300 字，實際只學 10 字。
        const usePool = applyCount(pool, countLimit);
        paintPreview(
          usePool,
          poolDistribution(usePool, useStar ? DIM_STAR : DIM_LEVEL,
            useStar ? (w) => (getExam().stars?.[String(w.id)] || 0) : null),
        );
      });
    } catch {
      settle(() => paintPreviewEmpty('字池計算失敗，請稍後再試'));
    }
  };

  let method = METHODS[0].id; // 'card' | 'spell'
  let dim = DIM_STAR;         // 字庫篩選維度

  // 星級／等級勾選列（星星走 starsSvg，emoji 禁令；標籤沿用 practice.js 隨機練習的寫法）。
  // 【5.1.1 H1 從 paint() 內移出】接續學習還原範圍設定時也要重畫這一格
  // （維度切換後勾選列內容整組不同），不挪出就得在還原路徑複製一份 HTML（兩份漂移）。
  const paintDim = () => {
    const title = host.querySelector('#study-dim-title');
    const grid = host.querySelector('#study-dim-grid');
    if (!title || !grid) return;
    title.textContent = dim === DIM_STAR ? '星級' : '等級';
    grid.innerHTML = dim === DIM_STAR
      ? [5, 4, 3, 2, 1].map((s) => `
          <label class="level-item"><input type="checkbox" value="${s}"><span class="stars" aria-label="${s} 星">${starsSvg(s, 14)}</span></label>`).join('')
      : [1, 2, 3, 4, 5, 6, 7].map((lv) => `
          <label class="level-item"><input type="checkbox" value="${lv}"><span>${lv <= 6 ? 'Lv' + lv : 'Lv7 補充'}</span></label>`).join('');
    // 5.1.1 S1：勾選列每次重畫（維度切換、接續學習還原），監聽要跟著重綁
    grid.querySelectorAll('input').forEach((i) => i.addEventListener('change', schedulePreview));
  };

  // 範圍種類切換：字庫 ↔ 預設單詞本（收合不適用的整列）。同上移出 paint()：
  // 接續學習把勾選回填到畫面後要重跑一次，讓對應的列正確展開。
  const syncScope = () => {
    const bankRow = host.querySelector('#study-bank-row');
    const dimRow = host.querySelector('#study-dim-row');
    const presetRow = host.querySelector('#study-preset-row');
    if (!bankRow || !dimRow || !presetRow) return;
    const scope = host.querySelector('input[name="study-scope"]:checked')?.value || 'bank';
    const isBank = scope === 'bank';
    bankRow.classList.toggle('hidden', !isBank);
    dimRow.classList.toggle('hidden', !isBank);
    presetRow.classList.toggle('hidden', isBank);
  };

  /**
   * 畫出整組設定列。
   * 兩種方法共用同一組「範圍」選項（字庫／預設單詞本），差異只在進入的引擎，
   * 所以切換方法時只要換說明文字，不需重畫範圍列（省一次使用者輸入被清掉的風險）。
   */
  const paint = () => {
    host.replaceChildren(el(`
      <div class="settings-row">
        <div class="settings-row-title">
          <h3 class="tp-card-title">學習方法</h3>
          <p class="tp-caption">決定用哪一套引擎與作答方式</p>
        </div>
        <div class="settings-row-main">
          <div class="segmented" role="radiogroup" aria-label="學習方法">
            ${METHODS.map((m, i) => `
              <label><input type="radio" name="study-method" value="${m.id}"${i === 0 ? ' checked' : ''}><span>${m.label}</span></label>`).join('')}
          </div>
        </div>
      </div>
      <p class="settings-note muted small" id="study-method-note">${escapeHtml(METHODS[0].desc)}</p>
      <div class="section-divider"></div>
      <div class="settings-row">
        <div class="settings-row-title">
          <h3 class="tp-card-title">範圍</h3>
          <p class="tp-caption">字庫依星級或等級；或改用後台發佈的預設單詞本</p>
        </div>
        <div class="settings-row-main">
          <div class="segmented" role="radiogroup" aria-label="範圍種類">
            <label><input type="radio" name="study-scope" value="bank" checked><span>字庫</span></label>
            <label><input type="radio" name="study-scope" value="preset"><span>預設單詞本</span></label>
          </div>
        </div>
      </div>
      <div class="section-divider"></div>
      <!-- 5.1.3 2.2：字數列（範圍之後、字庫之前）。樣式沿用 translate.js 的 .count-row
           （數字框＋range 滑桿，CSS 已在 style.css:589-600），不新增樣式類別。
           上限（滑桿 max）只能從 poolForScope 的結果回填，故初值以 1 起算，
           由 syncCountUi 在每次預覽算完字池後校正。 -->
      <div class="settings-row settings-row--stack" id="study-count-row">
        <div class="settings-row-title">
          <h3 class="tp-card-title">字數</h3>
          <p class="tp-caption" id="study-count-desc">不填就是全部；填數字就只學這些字（從範圍裡隨機取）</p>
        </div>
        <div class="settings-row-main">
          <div class="count-row">
            <input type="number" id="study-count-num" min="1" step="1" placeholder="全部" aria-label="字數">
            <input type="range" id="study-count-slider" min="1" step="1" value="1" aria-label="字數滑桿">
          </div>
          <p class="muted small" id="study-count-hint"></p>
        </div>
      </div>
      <div class="section-divider"></div>
      <div class="settings-row" id="study-bank-row">
        <div class="settings-row-title">
          <h3 class="tp-card-title">字庫</h3>
          <p class="tp-caption">依考題星級（5 星到 1 星）或官方課綱等級（Lv1-7）篩選</p>
        </div>
        <div class="settings-row-main">
          <div class="segmented" role="radiogroup" aria-label="字庫篩選維度" id="study-dim">
            <label><input type="radio" name="study-dim" value="${DIM_STAR}" checked><span>根據星級</span></label>
            <label><input type="radio" name="study-dim" value="${DIM_LEVEL}"><span>根據 Lv</span></label>
          </div>
        </div>
      </div>
      <div class="section-divider"></div>
      <div class="settings-row settings-row--stack" id="study-dim-row">
        <div class="settings-row-title"><h3 class="tp-card-title" id="study-dim-title">星級</h3></div>
        <div class="settings-row-main"><div class="level-grid" id="study-dim-grid"></div></div>
      </div>
      <div class="section-divider"></div>
      <div class="settings-row settings-row--stack hidden" id="study-preset-row">
        <div class="settings-row-title">
          <h3 class="tp-card-title">預設單詞本</h3>
          <p class="tp-caption" id="study-preset-note">後台發佈、目前上架中的單詞本</p>
        </div>
        <div class="settings-row-main" id="study-preset-main"></div>
      </div>`));

    paintDim();
    host.querySelectorAll('input[name="study-dim"]').forEach((r) => r.addEventListener('change', () => {
      dim = r.value;
      paintDim();
      schedulePreview();
    }));

    // 方法切換只換說明行（範圍形狀不變，避免清掉使用者已勾的星級／單詞本）
    host.querySelectorAll('input[name="study-method"]').forEach((r) => r.addEventListener('change', () => {
      method = r.value;
      const note = host.querySelector('#study-method-note');
      if (note) note.textContent = METHODS.find((m) => m.id === method)?.desc || '';
      schedulePreview();
    }));

    host.querySelectorAll('input[name="study-scope"]').forEach((r) => r.addEventListener('change', () => {
      syncScope();
      schedulePreview();
    }));
    syncScope();

    // 5.1.3 2.2：字數列監聽（數字框與滑桿互相同步，寫入後重跑預覽）
    bindCountUi();
    syncCountUi(countMax);   // 進頁先以 countMax=0（上限未知）初始化；預覽算完字池再校正

    // 預設單詞本清單（bank-picker 單選）：**非阻塞**——先畫好整頁，資料到位後就地回填，
    // 進頁不因這一步卡住（效能鐵律：不新增進頁 blocking fetch）。
    // 資料來自 unknown.js 同一支 60 秒 TTL 的 presets 快取，不重複打 Supabase。
    const presetMain = host.querySelector('#study-preset-main');
    presetMain.replaceChildren(el('<p class="muted small">載入中…</p>'));
    loadPresetSources().then((sources) => {
      if (!presetMain.isConnected) return; // 期間已切頁或重畫
      if (!sources.length) {
        presetMain.replaceChildren(el('<p class="muted small">尚無上架中的預設單詞本（可由管理員在後台發佈）。</p>'));
        return;
      }
      // 5.0.4（用戶指示）：預設單詞本改「標籤層級」選擇（例：6000單 > L5-2 > u8）——
      //   38 列的完整名稱（6000單字 L5-2・u1）在這裡太冗長，改為三層收斂。
      renderPresetCascade(presetMain, sources, schedulePreview);
    }).catch((err) => {
      if (!presetMain.isConnected) return;
      presetMain.replaceChildren(el(`<p class="warning">預設單詞本載入失敗：${escapeHtml(String(err.message || err))}</p>`));
    });

    // 5.1.1 S1：畫完設定後先跑一次預覽（預設無勾選 → 顯示提示而非 0 字）
    schedulePreview();
  };
  paint();

  main.querySelector('#study-start').addEventListener('click', async () => {
    const w = warn();
    w.textContent = '';
    // 5.1.1 S1：開始按鈕改讀 currentSelection() + poolForScope()——與即時預覽同一份
    // 字池演算法（spec 明文禁止兩份漂移，否則畫面顯示的字數與實際開練的不一致）
    const sel = currentSelection();
    try {
      await loadWords(); // 4.1.0 慣例：字庫載入失敗給可見提示，不靜默無反應
    } catch {
      w.textContent = '字庫載入失敗，請檢查網路後重試。';
      return;
    }

    // ---------- 範圍 → 字池（開始按鈕、H1 接續學習、S1 預覽共用 poolForScope） ----------
    let pool = null;
    try {
      pool = await poolForScope(sel.scope, sel.dim, sel.vals, sel.presetName);
    } catch (err) {
      w.textContent = err.message; // 提示文案集中定義在 poolFromBankDim／poolFromPresetName
      return;
    }

    // ---------- 依方法進入對應引擎 ----------
    // 5.1.3 2.2：字數截斷與接續學習、即時預覽共用同一支 applyCount（三處禁各自實作）
    pool = applyCount(pool, countLimit);
    if (method === 'spell') {
      // 拼寫學習＝顯示字母模式（灰色字母 → 打對轉綠 → Enter 換下一題）
      const { startWordSpellStudy } = await import('../practice/spelling.js');
      startWordSpellStudy(pool, { mode: 'show' });
      return;
    }
    // 單詞卡學習＝隨機抽卡（practice.js 同一支引擎；統計記錄與加入單詞本／複習計劃不變）。
    // 第三參數帶範圍描述：H1 接續學習靠它在每次抽新卡時序列化進度（見 practice.js nextCard）。
    const { startPractice } = await import('../pages/practice.js');
    startPractice(pool, 'study', {
      scope: sel.scope,
      dim: sel.scope === 'bank' ? sel.dim : null,
      vals: sel.scope === 'bank' ? sel.vals : null,
      presetName: sel.scope === 'preset' ? (sel.presetName ?? null) : null,
    });
  });

  // ---------- 5.1.1 H1 接續學習：#/study?resume=1 時還原上次抽卡場 ----------
  // 只有首頁橫幅的「接回」會帶這個 query；日常點進學習頁（無 query）不觸發，
  // resume key 保留在 localStorage 給下一次接回。
  const resumeQuery = new URLSearchParams(location.hash.split('?')[1] || '');
  if (resumeQuery.get('resume') === '1') await tryResumeStudy();

  /**
   * 接回流程（spec H1）依序：還原範圍設定、以原規則重建字池、以 shownIds 還原
   * session.shown，最後交給 practice.js 的同一支抽卡引擎續抽。
   * 失敗分兩級：字庫載入失敗屬暫時性問題（key 保留，稍後可再接回）；
   * 範圍重建不出、或 shownIds 全數失效代表這場已無法接續（清 key＋如實提示）。
   */
  async function tryResumeStudy() {
    const data = readResumeStudy(); // 過期／毀損已在讀取端靜默清除並回 null
    if (!data) return;
    const w = warn();
    try {
      await loadWords();
    } catch {
      w.textContent = '字庫載入失敗，請檢查網路後重試。';
      return;
    }
    let pool;
    try {
      pool = await poolForScope(
        data.scope === 'preset' ? 'preset' : 'bank',
        data.dim === DIM_LEVEL ? DIM_LEVEL : DIM_STAR,
        (data.vals || []).map(Number).filter(Number.isFinite),
        data.presetName,
      );
    } catch {
      // 原範圍已重建不出來（字庫改版／星級資料缺／預設單詞本下架等）：如實提示並清 key
      clearResumeStudy();
      w.textContent = '原範圍已失效，請重新開始。';
      return;
    }
    // shownIds 還原成 seed：字庫找不到的 id 逐個跳過（字庫改版可能少字）；全數失敗即無法接續
    const byId = new Map(getWords().map((x) => [x.id, x]));
    const seed = (data.shownIds || []).map((id) => byId.get(id)).filter(Boolean);
    if (!seed.length) {
      clearResumeStudy();
      w.textContent = '原範圍已失效，請重新開始。';
      return;
    }
    restoreSettingsUi(data);
    // 5.1.3 2.2：接回時字數同樣走 applyCount（與開始按鈕、即時預覽同一支）。
    // 舊 payload 沒有 count 欄位時，restoreSettingsUi 已把 countLimit 設成 0（＝全部），
    // applyCount 會原樣回傳整個字池 → 舊的接續場不會因為少了欄位而縮水。
    const { startPractice } = await import('../pages/practice.js');
    startPractice(applyCount(pool, countLimit), 'study', {
      scope: data.scope,
      dim: data.scope === 'bank' ? (data.dim === DIM_LEVEL ? DIM_LEVEL : DIM_STAR) : null,
      vals: data.scope === 'bank' ? (data.vals || []).map(Number).filter(Number.isFinite) : null,
      presetName: data.scope === 'preset' ? (data.presetName ?? null) : null,
      seedShown: seed,
    });
  }

  // 把接續的範圍設定回填到畫面（preset 名稱或星級/Lv 勾選）——
  // 讓「還原範圍設定」不只在資料層成立：結束練習回到本頁重畫前、以及
  // 還原當下的 DOM，看到的勾選都與原場次一致。
  function restoreSettingsUi(data) {
    const scopeRadio = host.querySelector(`input[name="study-scope"][value="${data.scope === 'preset' ? 'preset' : 'bank'}"]`);
    if (scopeRadio) scopeRadio.checked = true;
    if (data.scope === 'preset') {
      selectedPresetName = data.presetName ?? null;
    } else {
      dim = data.dim === DIM_LEVEL ? DIM_LEVEL : DIM_STAR;
      const dimRadio = host.querySelector(`input[name="study-dim"][value="${dim}"]`);
      if (dimRadio) dimRadio.checked = true;
      paintDim();
      const vals = new Set((data.vals || []).map(Number));
      host.querySelectorAll('#study-dim-grid input').forEach((i) => { i.checked = vals.has(Number(i.value)); });
    }
    // 5.1.3 2.2：字數一併還原。舊 payload 沒有 count 欄位（5.1.1/5.1.2 寫的）→ 視為 0
    //   （全部），接回後字數框留空，行為與接回前完全一致，不因為少一個欄位就判成毀損。
    const c = Number(data.count);
    countLimit = Number.isFinite(c) && c > 0 ? Math.floor(c) : 0;
    writeCountUi();
    syncScope();
  }
}

/**
 * 字庫範圍 → 字池。開始按鈕與 H1 接續學習共用（spec：字池演算法禁止兩份漂移；
 * 後續 S1 的即時預覽也走這裡）。錯誤一律拋 Error（訊息即現行提示文案），
 * 由呼叫端決定顯示位置——開始按鈕顯示原文，接回顯示「原範圍已失效」。
 */
async function poolFromBankDim(dim, vals) {
  if (!vals.length) throw new Error('請至少選擇一項星級或等級。');
  const all = getWords();
  let pool;
  if (dim === DIM_LEVEL) {
    pool = all.filter((x) => vals.includes(x.level));
  } else {
    // 星級來自 exam.json（考題星級資料）；loadExam 失敗回空殼 → 明確提示而非靜默 0 命中
    const exam = await loadExam();
    const hasStars = Object.values(exam.stars || {}).some((n) => Number(n) > 0);
    if (!hasStars) throw new Error('星級資料尚未載入，請改用「根據 Lv」或稍後再試。');
    pool = all.filter((x) => vals.includes(exam.stars[String(x.id)] ?? 0));
  }
  if (!pool.length) throw new Error('沒有符合的單字，請重新選擇星級或等級。');
  return pool;
}

// 預設單詞本範圍 → 字池（同上：與接回共用同一份；錯誤訊息沿用原開始按鈕的文案）
async function poolFromPresetName(name) {
  if (!name) throw new Error('請先選擇一本預設單詞本。');
  const pool = await poolFromPreset(name);
  if (!pool.length) throw new Error('這本單詞本沒有可用的字（字庫未收錄或無釋義）。');
  return pool;
}

// 5.1.1 S1：單一的字池解析入口——開始按鈕、H1 接回、即時預覽三者共用同一支，
// 否則預覽顯示的字數會與實際開練的不一致（spec 明文禁止兩份漂移）。
// 維度與勾選值在此正規化（星級資料缺／Lv7 的 0 值過濾都在這裡，只寫一次）。
export async function poolForScope(scope, dim, vals, presetName) {
  const isPreset = scope === 'preset';
  return isPreset
    ? poolFromPresetName(presetName)
    : poolFromBankDim(
        dim === DIM_LEVEL ? DIM_LEVEL : DIM_STAR,
        (vals || []).map(Number).filter(Number.isFinite),
      );
}

/**
 * 5.1.3 2.2：字數限制 → 截斷後的字池（純函式）。
 * n <= 0（不填＝全部）或 n >= pool.length（填得比字池還多）時**回傳原陣列本身**，
 * 呼叫端不必再複製；否則以 Fisher–Yates 洗牌後取前 n 個回傳新陣列。
 * 【不修改傳入的 pool】洗牌在副本上做：開始按鈕與接回拿到的 pool 之後還會被
 * practice.js 的抽卡引擎讀，順序不能被這裡的隨機洗掉。
 * 【三處共用一支】開始按鈕、接續學習（即時預覽）都呼叫這裡，
 * spec 明文禁止三處各自實作一份，否則預覽顯示的字數會與實際開練的不一致。
 */
export function applyCount(pool, n) {
  const src = pool || [];
  const k = Number(n);
  if (!Number.isFinite(k) || k <= 0 || k >= src.length) return src;
  const a = [...src];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, Math.floor(k));
}

// 5.1.1 S1：字池的分布摘要（純函式，預覽卡的「Lv4×8」／「5星×8」那一行）。
// 星級模式走 exam 星級（降序 5 到 1）、Lv 模式走課綱等級（升序）；
// starOf 為 null 時代表沒有星級資料，一律歸入「未分級」（預覽在 preset 範圍時走 Lv，不用它）。
export function poolDistribution(pool, dim, starOf = null) {
  const isStar = dim === DIM_STAR;
  const counts = new Map();
  for (const w of pool || []) {
    const k = isStar ? (starOf ? starOf(w) : 0) : w.level;
    const key = String(k);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const keys = isStar
    ? [5, 4, 3, 2, 1, 0].filter((k) => counts.has(String(k)))
    : [...counts.keys()].map(Number).sort((a, b) => a - b);
  return keys.map((k) => ({
    key: k,
    n: counts.get(String(k)),
    label: isStar ? (k > 0 ? `${k}星` : '未分級') : (k <= 6 ? `Lv${k}` : 'Lv7 補充'),
  }));
}

/**
 * 預設單詞本來源清單（bank-picker 單選用）。
 * 動態 import unknown.js：那一頁很大且本頁不需要它的其他功能，靜態引入會把
 * 整個單詞本頁（含 import/合併/6000 選擇器）一起拉進學習頁的模組依賴圖。
 */
async function loadPresetSources() {
  const { presetBankSources } = await import('./unknown.js');
  return presetBankSources();
}

// 5.0.4（用戶指示）：預設單詞本「標籤層級」選擇器——6000單 > L5-2 > u8 這種三層收斂，
//   取代 38 列完整名稱的冗長清單。其他群組/無群組的預設單詞本退為兩層（群組 > 本）。
//   選取結果存 selectedPresetName（完整名稱），開始按鈕與 poolFromPreset 仍以名稱為 key。
let selectedPresetName = null;
function renderPresetCascade(container, sources, onSelect) {
  // 解析標籤：6000 群組名稱格式固定「6000單字 <節>・u<N>」；其餘用群組名收斂
  const SIXK = /^6000單字 (.+)・(u\d+)$/;
  const tree = new Map(); // groupTag → Map(secTag → [{id, unit, count}])
  const order = [];
  for (const s of sources) {
    const name = s.id.replace(/^preset:/, '');
    const label = s.label || name;
    let groupTag, secTag, unit;
    const m = SIXK.exec(name);
    if (label.startsWith('6000單字・') && m) {
      groupTag = '6000單'; secTag = m[1]; unit = m[2];
    } else {
      const i = label.indexOf('・');
      groupTag = i > 0 ? label.slice(0, i) : '其他';
      secTag = ''; unit = name;
    }
    if (!tree.has(groupTag)) { tree.set(groupTag, new Map()); order.push(groupTag); }
    const g = tree.get(groupTag);
    if (!g.has(secTag)) g.set(secTag, []);
    g.get(secTag).push({ id: s.id, name, unit, count: s.count });
  }
  if (order.length && order[0] !== '6000單') order.sort((a, b) => (a === '6000單' ? -1 : b === '6000單' ? 1 : a.localeCompare(b)));
  const groups = order.map((g) => ({ tag: g, secs: [...tree.get(g).keys()] }));

  let curGroup = groups[0]?.tag || null;
  let curSec = tree.get(curGroup)?.keys().next().value ?? null;
  container.replaceChildren(el('<div id="study-preset-cascade"></div>'));
  const host2 = container.firstElementChild;
  const note = () => {
    const n = host2.parentElement.parentElement.querySelector('#study-preset-note');
    if (!n) return;
    const item = (tree.get(curGroup)?.get(curSec) || []).find((x) => x.name === selectedPresetName);
    const path = [curGroup, ...(curSec ? [curSec] : []), ...(item ? [item.unit] : [])];
    n.textContent = `已選：${path.join(' > ')}${item ? `（${item.count} 字）` : ''}`;
  };
  const paint = () => {
    const g = tree.get(curGroup) || new Map();
    const items = g.get(curSec) || [];
    if (!items.some((x) => x.name === selectedPresetName) && items.length) selectedPresetName = items[0].name;
    const seg = (name2, list, cur, cls) => `
      <div class="segmented" role="radiogroup" aria-label="${escapeHtml(name2)}">${list.map((v) => `
        <label><input type="radio" name="${cls}" value="${escapeHtml(v)}"${v === cur ? ' checked' : ''}><span>${escapeHtml(v)}</span></label>`).join('')}</div>`;
    const chips = items.map((x) => `
      <button type="button" class="chip-opt study-unit-chip" data-name="${escapeHtml(x.name)}"${x.name === selectedPresetName ? ' style="border-color: var(--accent); color: var(--accent);"' : ''}>
        ${escapeHtml(x.unit)}　${x.count} 字</button>`).join('');
    host2.replaceChildren(el(`
      <div class="segmented" role="radiogroup" aria-label="詞書群組">${groups.map((gg) => `
        <label><input type="radio" name="study-preset-group" value="${escapeHtml(gg.tag)}"${gg.tag === curGroup ? ' checked' : ''}><span>${escapeHtml(gg.tag)}</span></label>`).join('')}</div>
      ${curSec ? seg('單元分節', [...g.keys()], curSec, 'study-preset-sec') : ''}
      <div class="chip-pool">${chips}</div>`));
    // 5.1.1 S1：任一層級變更都要通知呼叫端重算預覽（字池隨選取即時變）
    const notify = () => { if (onSelect) onSelect(); };
    host2.querySelectorAll('input[name="study-preset-group"]').forEach((r) => r.addEventListener('change', () => {
      curGroup = r.value; curSec = tree.get(curGroup)?.keys().next().value ?? null; paint(); note(); notify();
    }));
    host2.querySelectorAll('input[name="study-preset-sec"]').forEach((r) => r.addEventListener('change', () => {
      curSec = r.value; paint(); note(); notify();
    }));
    host2.querySelectorAll('.study-unit-chip').forEach((c) => c.addEventListener('click', () => {
      selectedPresetName = c.dataset.name; paint(); note(); notify();
    }));
    note();
  };
  paint();
}

/**
 * 預設單詞本 → 字池。
 * 預設單詞本以**名稱**為 key（words 存的是英文 token 字串，不是字庫 id），
 * 所以不能用 bank-picker 的 poolFromWordbookSources（那條走 wordbook:<id>）；
 * 這裡以小寫字面比對字庫，與 search.js 的索引鍵規則一致。
 */
async function poolFromPreset(sel) {
  const name = String(sel).replace(/^preset:/, '');
  const { presetWords } = await import('./unknown.js');
  const tokens = await presetWords(name);
  if (!tokens.length) return [];
  const byText = new Map();
  for (const w of getWords()) byText.set(String(w.word).toLowerCase(), w);
  const seen = new Set();
  const out = [];
  for (const t of tokens) {
    const w = byText.get(String(t).toLowerCase());
    if (!w || seen.has(w.id)) continue;
    seen.add(w.id);
    out.push(w);
  }
  return out;
}

// 匯出方法清單（供煙霧測試直接對照，不從 DOM 反推常數）
export const STUDY_METHODS = METHODS;
