// ============================================================
// 迷你單詞卡（4.3.1 批次 2 共用元件）
// 需求來源：spec 批次 2 第 4 項（選擇・每個選項）＋ 批次 4 第 1 項（中譯英 content words）
// 做法：
//   ① 原型還原：字庫 words.json 只收詞條原形（listen 有、listening 無），
//      句中抽出來的是屈折形（listening／students／boxes）。先查原字，
//      查不到再依「經驗庫 wordbank-headword-only-lemma-check」的順序去綴尾：
//      ies→y → ([^aeiou])es→$1 → s→'' → ied→y → ed→'' → ing→'' → er→'' → est→''
//   ② 卡片：.mini-card 緊湊版（Lv badge／考題星級／音標／釋義前 3 條）
//   ③ 兩個動作鈕：加入單詞本（4.1.1 沿用「累加到同一本收錄本」的路徑）
//      與加入複習（markUnknown／再點取消）——比照 js/pages/practice.js 的
//      toggleWordbook／togglePlan 對應的 store API
//   ④ 練習級 joinPool：加入單詞本／加入複習的字都收進 joinPool（Set of word.id），
//      完成畫面由 mountJoinPanel 提供「新建／合併」兩個動作
// ============================================================
import { el, escapeHtml, ICONS, openDialog, phoneticPretty, starsSvg, toast } from '../core/ui.js';
import { findWord } from '../services/search.js';
import { getUser } from '../services/auth.js';
import {
  markUnknown, unmarkUnknown, addWordbook, updateWordbook, getWordbooks, getUnknownIds,
} from '../services/store.js';
import { loadExam, examStarCount } from '../services/vocab.js';

// ---------- ① 原型還原 ----------
// 依序嘗試的綴尾規則（由少到多試，命中即停；順序比照經驗庫 wordbank-headword-only-lemma-check）
const LEMMA_RULES = [
  [/ies$/, 'y'],
  [/([^aeiou])es$/, '$1'],
  [/s$/, ''],
  [/ied$/, 'y'],
  [/ed$/, ''],
  [/ing$/, ''],
  [/er$/, ''],
  [/est$/, ''],
];

/**
 * 把句中字面還原成字庫收錄的原形並回傳字庫資料。
 * 回傳 { word, raw, viaLemma }；字庫查不到回 null（呼叫端可自訂 fallback）。
 * 套用順序：原字 → 逐條綴尾規則 → 「ing 還原後重複一次」的變化（running → run）。
 */
export function findWordWithLemma(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const direct = findWord(text);
  if (direct) return { word: direct, raw: text, viaLemma: false };
  for (const [re, rep] of LEMMA_RULES) {
    if (!re.test(text)) continue;
    const cand = text.replace(re, rep);
    if (cand === text) continue;
    const w = findWord(cand);
    if (w) return { word: w, raw: text, viaLemma: true };
  }
  return null;
}

// ---------- ② 迷你單詞卡 ----------
/** 卡片 HTML（.mini-card 緊湊版）。w 為字庫 word 物件；raw 為原字（預設 w.word）。 */
export function miniCardHtml(w, raw) {
  const stars = examStarCount(w);
  const senses = (w.senses || []).slice(0, 3);
  return `
    <div class="mc-kv">
      <span class="mc-kv-k">${escapeHtml(w.word)}</span>
      ${raw && String(raw).toLowerCase() !== String(w.word).toLowerCase()
        ? `<span class="mc-kv-raw">（句中為 ${escapeHtml(raw)}）</span>` : ''}
      <span class="badge">Lv${w.level}</span>
      ${stars ? `<span class="stars" title="考題星級 ${stars} 星">${starsSvg(stars, 12)}</span>` : ''}
      ${w.phonetic ? `<span class="mc-kv-phonetic">/${escapeHtml(phoneticPretty(w.phonetic))}/</span>` : ''}
    </div>
    <div class="mc-senses">${senses.map((s) => `<div>${escapeHtml(s)}</div>`).join('')}</div>`;
}

/**
 * 迷你單詞卡元件：給定字庫 word，渲染兩顆小鈕（加入單詞本／加入複習）並回呼狀態。
 * host ＝ 卡片容器（由呼叫端掛在選項或 content-words 下方）。
 * joinPool ＝ 練習級 Set of word.id（可省略）。onChange?.(word, 'book'|'plan', inPool) 回呼。
 */
export function mountMiniCard(host, { word, raw, bookName = '練習收錄', joinPool = null, onChange } = {}) {
  const wrap = el(`<div class="mini-card">${miniCardHtml(word, raw)}
    <div class="mc-actions">
      <button class="btn-text" data-act="book" data-id="${word.id}">加入單詞本</button>
      <button class="btn-text" data-act="mark" data-id="${word.id}" aria-label="加入複習">${ICONS.starOutline} 加入複習</button>
    </div>
  </div>`);
  let bookId = null;
  let inPlan = false;
  const sync = () => {
    const bookBtn = wrap.querySelector('[data-act="book"]');
    const markBtn = wrap.querySelector('[data-act="mark"]');
    bookBtn.textContent = joinPool && joinPool.has(String(word.id)) ? '已在本次收集' : '加入單詞本';
    markBtn.innerHTML = `${inPlan ? ICONS.star : ICONS.starOutline} ${inPlan ? '已在複習計劃' : '加入複習'}`;
  };
  wrap.addEventListener('click', async (e) => {
    const btn = e.target.closest('.btn-text');
    if (!btn) return;
    // 4.1.1：加入單詞本／複習屬註冊牆內動作——訪客導向註冊
    if (!getUser()) { location.hash = '#/auth?tab=signup'; return; }
    const id = Number(btn.dataset.id);
    btn.disabled = true;
    try {
      if (btn.dataset.act === 'mark') {
        if (inPlan) { await unmarkUnknown(id); inPlan = false; toast('已移出複習計劃', ''); }
        else { await markUnknown(id); inPlan = true; toast('已加入複習計劃', 'ok'); }
        if (joinPool) { if (inPlan) joinPool.add(String(id)); else joinPool.delete(String(id)); }
      } else {
        if (!bookId) {
          bookId = await addWordbook({ name: bookName, wordIds: [], endedAt: new Date().toISOString() });
        }
        const books = await getWordbooks();
        const book = books.find((b) => String(b.id) === String(bookId));
        const ids = book ? [...new Set([...(book.wordIds || []).map(String), String(id)])] : [String(id)];
        await updateWordbook(bookId, { wordIds: ids });
        if (joinPool) joinPool.add(String(id));
        toast(`已加入單詞本「${bookName}」`, 'ok');
      }
      sync();
      if (onChange) onChange(word, btn.dataset.act, inPlan);
    } catch (err) {
      btn.disabled = false;
      toast(`加入失敗：${String(err.message || err).slice(0, 80)}`, 'bad');
    }
  });
  host.appendChild(wrap);
  // 初始狀態：查一次複習計劃，避免重複按鈕
  (async () => {
    try {
      const ids = await getUnknownIds();
      inPlan = ids.has(word.id) || ids.has(String(word.id));
      sync();
    } catch { /* 讀不到就當未加入 */ }
  })();
  return wrap;
}

// ---------- ③ 練習結束：joinPool 面板（新建／合併） ----------
const pad2 = (v) => String(v).padStart(2, '0');
function defaultBookName() {
  const now = new Date();
  return `單詞本_${pad2(now.getMonth() + 1)}${pad2(now.getDate())}_${pad2(now.getHours())}${pad2(now.getMinutes())}`;
}

/**
 * 在完成畫面下方掛「本次收集的字」整合面板。
 * joinPool：Set of word.id（字串化 id）；wordById：Map 字串 id → word 物件（用於列出清單）。
 * 回傳 { hasWords }；joinPool 為空時不掛任何東西。
 */
export async function mountJoinPanel(host, { joinPool, wordById, bookName = '練習收錄', title = '本次收集的單字' } = {}) {
  if (!joinPool || !joinPool.size) return { hasWords: false };
  if (!getUser()) {
    host.appendChild(el(`<div class="join-panel">
      <p class="muted small">本次收集 ${joinPool.size} 個單字。登入後可一鍵存成單詞本。</p>
    </div>`));
    return { hasWords: true };
  }
  const ids = [...joinPool];
  const words = ids.map((id) => wordById?.get(String(id))).filter(Boolean);
  const unknown = await getUnknownIds();
  const inPlan = (id) => unknown.has(id) || unknown.has(String(id));

  const panel = el(`<div class="join-panel">
    <h3 class="tp-card-title">${escapeHtml(title)}（${joinPool.size}）</h3>
    <div class="join-words">${words.map((w) => `
      <span class="chip ${inPlan(w.id) ? 'chip--plan' : ''}">${escapeHtml(w.word)}${inPlan(w.id) ? `<span class="chip-flag">${ICONS.star}</span>` : ''}</span>`).join('')}
    </div>
    <div class="join-actions">
      <button class="btn primary" data-j="new">新建單詞本</button>
      <button class="btn" data-j="merge">合併到現有單詞本</button>
    </div>
    <div class="join-form hidden" id="join-new-form">
      <div class="search-row">
        <input type="text" id="join-name" maxlength="30" value="${escapeHtml(bookName)}" placeholder="單詞本名稱">
      </div>
      <div class="controls">
        <button class="btn primary" data-j="new-save">保存單詞本</button>
        <button class="btn" data-j="new-cancel">取消</button>
      </div>
    </div>
    <div class="join-form hidden" id="join-merge-form"></div>
  </div>`);
  host.appendChild(panel);

  const show = (id) => { panel.querySelectorAll('.join-form').forEach((f) => f.classList.add('hidden')); panel.querySelector(id)?.classList.remove('hidden'); };

  panel.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-j]');
    if (!b) return;
    const act = b.dataset.j;
    try {
      if (act === 'new') {
        show('#join-new-form');
        panel.querySelector('#join-name').focus();
        panel.querySelector('#join-name').select();
        return;
      }
      if (act === 'new-cancel') { show(null); return; }
      if (act === 'new-save') {
        const name = panel.querySelector('#join-name').value.trim() || defaultBookName();
        b.disabled = true;
        await addWordbook({ name, wordIds: ids.map(String), endedAt: new Date().toISOString() });
        toast(`已保存單詞本「${name}」`, 'ok');
        markDone();
        return;
      }
      if (act === 'merge') {
        const form = panel.querySelector('#join-merge-form');
        if (form.dataset.loaded !== '1') {
          const books = await getWordbooks();
          form.innerHTML = books.length
            ? `<p class="muted small">勾選要合併進去的單詞本（會保留原有的字）：</p>
               ${books.map((bk) => `<label class="check-plain join-merge-item">
                 <input type="checkbox" value="${escapeHtml(String(bk.id))}">
                 <span>${escapeHtml(bk.name)}（${(bk.wordIds || []).length} 字）</span>
               </label>`).join('')}
               <div class="controls">
                 <button class="btn primary" data-j="merge-save">合併</button>
                 <button class="btn" data-j="new-cancel">取消</button>
               </div>`
            : '<p class="warning">還沒有已保存的單詞本，請改用「新建單詞本」。</p>';
          form.dataset.loaded = '1';
        }
        show('#join-merge-form');
        return;
      }
      if (act === 'merge-save') {
        const form = panel.querySelector('#join-merge-form');
        const picked = [...form.querySelectorAll('input:checked')].map((i) => i.value);
        if (!picked.length) { toast('請至少勾選一本單詞本', 'bad'); return; }
        b.disabled = true;
        const books = await getWordbooks();
        for (const bid of picked) {
          const bk = books.find((x) => String(x.id) === String(bid));
          if (!bk) continue;
          const merged = [...new Set([...(bk.wordIds || []).map(String), ...ids.map(String)])];
          await updateWordbook(bid, { wordIds: merged });
        }
        toast(`已合併到 ${picked.length} 本單詞本`, 'ok');
        markDone();
        return;
      }
    } catch (err) {
      b.disabled = false;
      toast(`保存失敗：${String(err.message || err).slice(0, 80)}`, 'bad');
    }
  });

  function markDone() {
    panel.querySelectorAll('[data-j]').forEach((x) => { x.disabled = true; });
    panel.querySelector('.join-actions')?.insertAdjacentHTML('afterend', '<p class="muted small" id="join-done">單詞本已保存。</p>');
  }
  return { hasWords: true };
}
