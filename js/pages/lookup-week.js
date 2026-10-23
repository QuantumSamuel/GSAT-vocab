// ============================================================
// 「本週查過的字」區塊（5.0.x；spec 4.0/5.7-50x-features-spec.md 第 6 節）
//
// 資料來源：查詢頁記的 events（type='lookup'）→ store.js 的 getRecentLookups(7)
// 篩選：近 7 天查過、且**不在任何單詞本**的字（spec 原文明訂）。
// 動作：chips（點＝跳去查詢該字）＋「一鍵全部加入單詞本」。
// 目標單詞本：下拉選既有本或新建「查過的字」（沿用 addWordbook／updateWordbook 與
//   5.0.0 pendingWords 語意——查得到的字就是字庫字，進 wordIds；查不到的一律不列，
//   因為本區塊只列字庫字，沒有字庫外字要記 pendingWords）。
// 空狀態：本週沒查過（或全都在單詞本裡）→ 不渲染區塊（spec 第 6 節）。
// ============================================================
import { addWordbook, appendWordIds, getRecentLookups } from '../services/store.js';
import { el, escapeHtml, toast } from '../core/ui.js';

const DAY_DAYS = 7; // spec：「近 7 天」
const NEW_BOOK_NAME = '查過的字';
const DEFAULT_BOOK_NAME = '本週查過的字';

/**
 * 組出區塊的 HTML 字串（可 await；查不到紀錄回空字串＝不渲染）。
 * ctx: { wordsById: Map, books: [{id,name,wordIds}] }
 */
export async function renderLookupWeekBlock({ wordsById, books }) {
  const recents = await getRecentLookups(DAY_DAYS);
  if (!recents.length) return '';
  // 已在任何單詞本裡的字一律不列（spec：「不在任何單詞本」）
  const inBooks = new Set();
  for (const b of books || []) for (const id of b.wordIds || []) inBooks.add(String(id));
  const words = [];
  const seen = new Set();
  for (const r of recents) {
    const id = String(r.wordId);
    if (seen.has(id) || inBooks.has(id)) continue;
    const w = wordsById.get(r.wordId) || wordsById.get(id);
    if (!w) continue; // 字已不在字庫（字庫改版）→ 略過
    seen.add(id);
    words.push(w);
  }
  if (!words.length) return '';

  const options = (books || []).map((b) =>
    `<option value="${escapeHtml(String(b.id))}">${escapeHtml(b.name)}（${(b.wordIds || []).length} 字）</option>`).join('');

  return `
    <section class="card" id="lookup-week">
      <h3 class="tp-card-title">本週查過的字（${words.length}）</h3>
      <p class="muted small">近 7 天在「查詢」頁查過、且還不在任何單詞本裡的字。點字可再看一次釋義。</p>
      <div class="lookup-week-words">
        ${words.map((w) => `<button class="chip lookup-week-chip" data-word="${escapeHtml(w.word)}">${escapeHtml(w.word)}<span class="chip-flag">Lv${w.level}</span></button>`).join('')}
      </div>
      <div class="lookup-week-target">
        <label class="tp-caption">加入的單詞本
          <select id="lookup-week-target">
            <option value="__new__">新建「${escapeHtml(NEW_BOOK_NAME)}」</option>
            ${options}
          </select>
        </label>
        <div class="controls controls-start">
          <button class="btn primary" id="lookup-week-add">一鍵全部加入單詞本（${words.length}）</button>
        </div>
      </div>
      <p class="muted small note-tight" id="lookup-week-msg"></p>
    </section>`;
}

/**
 * 掛事件（區塊存在才呼叫）。host ＝ 單詞本頁的容器。
 * words 由 ctx 重新取得（呼叫端已有 wordsById，不必再讀字庫）。
 */
export function wireLookupWeek(host, { wordsById, books }) {
  const box = host.querySelector('#lookup-week');
  if (!box) return false;

  // chips → 查詢頁並帶上那個字（#/lookup?w=<word>，lookup.js 進頁會自動查）。
  // 為什麼要帶字：只設 '#/lookup' 會落在空白查詢頁，區塊自己寫的「點字可再看一次釋義」不成立
  // （池 B 對向驗證第 12 項）。encodeURIComponent：字面來自字庫，仍防一手特殊字元。
  box.querySelectorAll('.lookup-week-chip').forEach((b) =>
    b.addEventListener('click', () => {
      location.hash = '#/lookup?w=' + encodeURIComponent(b.dataset.word || '');
    }));

  const msg = box.querySelector('#lookup-week-msg');
  box.querySelector('#lookup-week-add').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const target = box.querySelector('#lookup-week-target').value;
    // 重算一次清單（頁面可能已經過一段時間，避免把已經在別的單詞本裡的字再塞一次）
    const recents = await getRecentLookups(DAY_DAYS);
    const inBooks = new Set();
    for (const b of books || []) for (const id of b.wordIds || []) inBooks.add(String(id));
    // ids 存**字庫原值**（words.json 的數字 id），不轉字串：
    //   單詞本頁的 wordsById 以 w.id 為鍵（數字），寫入字串 id 會讓字數顯示為 0（池 B 實測）。
    //   比較一律用 String() 轉換過的字串，與 store.js 的既有慣例一致。
    const ids = [];
    const seen = new Set();
    for (const r of recents) {
      const id = String(r.wordId);
      if (seen.has(id) || inBooks.has(id)) continue;
      const w = wordsById.get(r.wordId) || wordsById.get(id);
      if (!w) continue;
      seen.add(id);
      ids.push(w.id);
    }
    if (!ids.length) { msg.textContent = '這些字都已經在單詞本裡了（或已不在字庫中）。'; return; }
    btn.disabled = true;
    try {
      if (target === '__new__') {
        await addWordbook({ name: NEW_BOOK_NAME, wordIds: [...ids], endedAt: new Date().toISOString() });
        msg.textContent = `已新建「${NEW_BOOK_NAME}」並加入 ${ids.length} 字。`;
      } else {
        // appendWordIds：單一交易內讀寫（與 5.0.0 待補補進同一條路徑，理由見 store.js）
        const added = await appendWordIds(target, (cur) => {
          if (!cur) return null; // 書已被刪
          // 比對字串、寫回原值：既有的 wordIds 可能是數字也可能是字串（雲端／舊版），
          // 一律以字串判斷重複，但新增的字寫字庫原值，不讓同一本書混入兩種型別。
          const known = new Set((cur.wordIds || []).map(String));
          const addIds = ids.filter((id) => !known.has(String(id)));
          if (!addIds.length) return null;
          return { ...cur, wordIds: [...(cur.wordIds || []), ...addIds], __added: addIds.length };
        });
        msg.textContent = added
          ? `已合併 ${added} 字到該單詞本。`
          : '這些字都已經在該單詞本裡了。';
      }
      toast('本週查過的字已加入單詞本', 'ok');
    } catch (err) {
      msg.textContent = `加入失敗：${String(err.message || err).slice(0, 80)}`;
    } finally {
      btn.disabled = false;
    }
  });
  return true;
}

// 讓 el() 以外的呼叫端也能取到預設名（測試與文件用）
export const LOOKUP_WEEK = { DAY_DAYS, NEW_BOOK_NAME, DEFAULT_BOOK_NAME, el };
