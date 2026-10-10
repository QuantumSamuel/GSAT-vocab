// ============================================================
// 頁面：不會單字／單詞本（2.0.2 起；2.0.5 SRS 欄；2.0.8 單詞本練習入口）
// 3.0.2 單詞本升級：
//   ① 每本單詞本優先收攏，點開才展開完整選單（單字清單＋操作）
//   ② 分組（扁平一層）：可新增／改名／刪除；刪除時底下單詞本退回未分組
//   ③ 批量導入：空格/逗號/換行分隔，確認時驗證，不合格字挑出列清單確認
//   ④ 排序：輸入序／等級／A-Z／Z-A（瀏覽按順序，練習永遠隨機）
//   ⑤ 後台單詞本：雲端 vocab_presets（4.0.2 起可展開預覽、分組顯示；本地 presets.json 仍支援）
// 【4.0.0】「不會單字」表格移至複習頁（review.js）底部
// ============================================================
import { getWords, loadWords } from '../services/vocab.js';
import {
  addGroup,
  addWordbook,
  appendWordIds,
  deleteGroup,
  deleteWordbook,
  getGroups,
  getRecentLookups,
  getUnknownMarks,
  getWordbooks,
  getSrsQueues,
  getEvents,
  mergeWordbookInto,
  renameGroup,
  touchWordbook,
  updateWordbook,
} from '../services/store.js';
import { masteryOfBook, dueOfBook } from '../core/mastery.js';
import { startPractice } from './practice.js';
import { renderLookupWeekBlock, wireLookupWeek } from './lookup-week.js';
import { el, escapeHtml, dateStr, exportCsv, ICONS, iconInline, openDialog, toast } from '../core/ui.js';
import { routeGuard } from '../core/router.js';
import { parseWordTokens } from '../services/search.js';
import { restFetch } from '../services/auth.js';
import { verifyTokens } from '../services/search.js';

// 頁面狀態（切頁再回來保留）
let expandedBookId = null;   // 展開中的單詞本
let importOpen = false;      // 導入面板開啟中
let importResult = null;     // { valid:[word], invalid:[token], name, groupId, sort }
let importState = { text: '', name: '', groupId: '', sort: 'input' }; // 重渲染保留輸入
let presetsCache = null;     // 後台單詞本（懶載入）
let presetsCacheAt = 0;      // 5.0.0：快取時間戳（loadPresets 有 60 秒 TTL）
let presetExpanded = null;   // 展開中的後台單詞本（名稱）
let sixKSec = 'L5-2';        // 5.3：6000 單字選擇器目前選的節（切頁再回來保留）
// 5.1.1 W2：精熟度與 Due 的輸入端（切頁再回來保留，免重複讀 events 表）
// graduateIds 為 events 中 type==='graduate' 的 wordId 集合；null 表示尚未回填
// （首次渲染不顯示精熟度列，絕不顯示 0% 誤導使用者）。
let graduateIds = null;
let dueRows = null;

// ============================================================
// 5.3：6000 單字（後台一鍵佈建的 38 列單元單詞本）
// 名稱格式 `6000單字 <節>・u<N>` 由 admin.js 的 SIXK_GROUP/SIXK_SEP 產生，
// 這裡逐字對應解析——兩邊只要一個字不同，選擇器就會認不出來（故不共用常數檔）。
const SIXK_GROUP = '6000單字';
const SIXK_TITLE = '6000 單字';   // 卡片標題（group_name 無空格，用另一個字面量免得顯示成「6000單字」）
const SIXK_SEP = '・';
const SIXK_SECS = ['L5-2', 'L6', 'PLUS'];   // PLUS：docx 沒有此節，UI 顯示停用態
const SIXK_RE = new RegExp(`^${SIXK_GROUP} (.+)${SIXK_SEP}u(\\d+)$`);

// 解析 preset 名稱 → { sec, unit }；不是 6000 單字回 null
function parseSixKName(name) {
  const m = SIXK_RE.exec(String(name || ''));
  return m ? { sec: m[1], unit: Number(m[2]) } : null;
}

// 導入鈕的下載箭頭（4.1.1：取代 emoji；4.2.0 改用 ICONS.download 單一來源）
const IMPORT_SVG = ICONS.download;

export async function renderUnknown(main) {
  const stillOn = routeGuard(); // 4.3.0（Pool A Medium）：離頁守衛
  await loadWords();
  if (!stillOn()) return;

  const wordsById = new Map(getWords().map((w) => [w.id, w]));
  const marks = (await getUnknownMarks()).filter((m) => wordsById.has(m.wordId));
  const [books, groups] = [await getWordbooks(), await getGroups()];

  // ---- 練習入口：已保存單詞本＋分組 ----
  // 5.1.1 W2：分組內排序改「精熟度升冪」（弱本浮上），同分依名稱。
  // 精熟度資料尚未回填（首次渲染）時退回舊的「最近練習在前」——效能鐵律：
  // 初始渲染不新增 blocking fetch（graduate 事件在 events 表，整表 getAll 較重）。
  const byGroup = (gid) => {
    const inGroup = books.filter((b) => (b.groupId ?? null) === gid);
    return graduateIds
      ? rankBooksByMastery(inGroup, marks, graduateIds).map((r) => r.book)
      : [...inGroup].sort((a, b) => (a.endedAt < b.endedAt ? 1 : -1));
  };

  const groupSections = [
    ...groups.map((g) => ({ id: g.id, name: g.name, books: byGroup(g.id), managed: true })),
    { id: null, name: '未分組', books: byGroup(null), managed: false },
  ].filter((s) => s.books.length > 0 || s.managed);

  const groupHtml = groupSections.map((s) => {
    const cards = s.books.map((b) => bookCardHtml(b, wordsById, marks)).join('');
    const manage = s.managed ? `
      <span class="grp-actions">
        <button class="btn subtle btn-rename-group" data-id="${s.id}" data-name="${escapeHtml(s.name)}">改名</button>
        <button class="btn subtle btn-del-group" data-id="${s.id}" data-name="${escapeHtml(s.name)}">刪除</button>
      </span>` : '';
    return `
      <div class="wb-group">
        <div class="wb-group-head">
          <span class="grp-name">${escapeHtml(s.name)}</span>
          <span class="grp-count">${s.books.length} 本</span>
          ${manage}
        </div>
        ${cards || '<p class="muted small note-inset">這個分組還沒有單詞本。</p>'}
      </div>`;
  }).join('');

  // 5.1.3：第四顆按鈕「從檔案庫中選擇」（多選匯入）。兩個分支都給：還沒有任何單詞本時，
  // 檔案庫裡的後台單詞本一樣選得到（它們正是第一次建書的來源）。
  const pickBtn = '<button class="btn" id="btn-pick-presets">從檔案庫中選擇</button>';
  const bookTools = books.length || groups.length ? `
      <div class="wb-toolbar">
        <button class="btn ${importOpen ? 'marked' : ''}" id="btn-import" aria-label="導入單字" title="導入單字">${IMPORT_SVG} 導入單字</button>
        <button class="btn" id="btn-add-group">新增分組</button>
        <button class="btn" id="btn-export-books">匯出全部（CSV）</button>
        ${pickBtn}
      </div>` : `
      <div class="wb-toolbar">
        <button class="btn ${importOpen ? 'marked' : ''}" id="btn-import" aria-label="導入單字" title="導入單字">${IMPORT_SVG} 導入單字</button>
        <button class="btn" id="btn-add-group">新增分組</button>
        ${pickBtn}
      </div>`;

  // ---- 導入面板（展開時） ----
  const importResultHtml = importResult ? `
      <p class="import-verdict">${importResult.valid.length
        ? `${iconInline(ICONS.checkCircle, 14)}<span>可導入 <strong>${importResult.valid.length}</strong> 字</span>`
        : `${iconInline(ICONS.warnTriangle, 14)}<span>沒有可導入的字</span>`}${importResult.invalid.length
        ? `<span>；字庫外或拼錯 ${importResult.invalid.length} 個：<span class="import-bad">${importResult.invalid.map(escapeHtml).join('、')}</span>（將略過）</span>`
        : ''}</p>
      ${importResult.valid.length ? `
        <div class="wb-words wb-words-compact">${importResult.valid
          .map((w) => `<span class="chip">Lv${w.level}　${escapeHtml(w.word)}</span>`).join('')}</div>` : ''}` : '';
  const importPanel = importOpen ? `
      <div class="import-panel">
        <h3>批量導入單字</h3>
        <p class="muted small">以空格、逗號或換行分隔；字庫外的字會在驗證時挑出來讓你確認。</p>
        <textarea id="import-text" rows="5" placeholder="例如：apple banana orange&#10;或一行多字以空格分隔" spellcheck="false">${escapeHtml(importState.text)}</textarea>
        <div class="import-row">
          <label>單詞本名稱 <input type="text" id="import-name" maxlength="30" placeholder="留空自動命名" value="${escapeHtml(importState.name)}"></label>
          <label>排序
            <select id="import-sort">
              <option value="input"${importState.sort === 'input' ? ' selected' : ''}>我輸入的順序</option>
              <option value="level"${importState.sort === 'level' ? ' selected' : ''}>等級（低到高）</option>
              <option value="az"${importState.sort === 'az' ? ' selected' : ''}>字母 A 到 Z</option>
              <option value="za"${importState.sort === 'za' ? ' selected' : ''}>字母 Z 到 A</option>
            </select>
          </label>
          <label>存入分組
            <select id="import-group"><option value="">未分組</option>
              ${groups.map((g) => `<option value="${g.id}"${importState.groupId === g.id ? ' selected' : ''}>${escapeHtml(g.name)}</option>`).join('')}
            </select>
          </label>
        </div>
        <div id="import-result">${importResultHtml}</div>
        <div class="import-actions">
          <button class="btn primary" id="btn-validate">驗證</button>
          ${importResult && importResult.valid.length ? '<button class="btn primary" id="btn-import-confirm">確認導入</button>' : ''}
          <button class="btn subtle" id="btn-import-close">收起</button>
        </div>
      </div>` : '';

  // ---- 後台單詞本（4.0.2：可展開預覽內容；依 group_name 分組顯示） ----
  const presets = await loadPresets();
  const byWord = new Map(getWords().map((w) => [w.word, w]));
  // 5.3：6000 單字群組不進一般 preset 列表（否則會多出 38 張一模一樣的卡），
  //     改由獨立的「6000 單字」選擇器承接。
  // 池 B 發現（medium）：原本用「群組＝6000單字」一刀切把整組搬進選擇器，但有些列
  //   使用者永遠點不到：① 名稱不符「6000單字 <節>・u<N>」→ 解析不成 chip；
  //   ② 節＝PLUS（停用態）→ chip 在畫面上永遠不顯示。
  //   這些列會從「選擇器」與「一般列表」兩邊一起消失（看不到也匯不進）。
  //   處置：① 解析不出來 → 直接給一般卡；② PLUS 節 → 不進 chip，另給一般卡；
  //   ③ 節不在 spec 三節內（後台手動加的 L7 等）→ 節仍進 segmented（點得進去），
  //      但同時保留一張一般卡，讓「不切到那一節」的使用者也有入口（刻意保留兩份入口：
  //      選擇器是節內導覽，一般卡是保底可達性；spec 三節的 38 列不受影響，不會重複）。
  const sixKGroup = presets.filter((p) => p.group === SIXK_GROUP);
  const sixKUnit = new Map(sixKGroup.map((p) => [p.name, parseSixKName(p.name)]));
  const isSpecSec = (sec) => SIXK_SECS.includes(sec);
  const sixKChipNames = new Set(sixKGroup
    .filter((p) => { const k = sixKUnit.get(p.name); return k && k.sec !== 'PLUS'; })
    .map((p) => p.name));
  // 選擇器點不到的列（自訂名／PLUS 節／spec 三節外的節）另留一張一般卡
  const sixKAlsoCard = (p) => {
    const k = sixKUnit.get(p.name);
    return !k || k.sec === 'PLUS' || !isSpecSec(k.sec);
  };
  const plainPresets = presets.filter((p) => p.group !== SIXK_GROUP
    || !sixKChipNames.has(p.name) || sixKAlsoCard(p));
  const sixKHtml = sixKBoxHtml(sixKGroup.filter((p) => sixKChipNames.has(p.name)));
  const presetGroups = new Map();
  for (const p of plainPresets) {
    const g = p.group || '';
    if (!presetGroups.has(g)) presetGroups.set(g, []);
    presetGroups.get(g).push(p);
  }
  const presetsHtml = plainPresets.length ? `
      <div class="preset-box">
        <h3>後台單詞本</h3>
        ${[...presetGroups.entries()].filter(([, ps]) => ps.length).map(([g, ps]) => `
          ${g ? `<div class="wb-group-head"><span class="grp-name">${escapeHtml(g)}</span><span class="grp-count">${ps.length} 本</span></div>` : ''}
          ${ps.map((p) => presetCardHtml(p, byWord)).join('')}
        `).join('')}
      </div>` : '';

  const page = el(`
    <div>
    <section class="card">
      ${marks.length > 0 ? `
        <button class="btn primary" id="btn-practice-unknown">練習全部不會單字（${marks.length}）</button>
      ` : `
        <p class="muted">還沒有不會單字。到「查詢」搜尋單字後加入複習計劃，或在「練習」中加入單詞本。</p>
      `}
      <h3 class="section-title">單詞本</h3>
      ${bookTools}
      ${importPanel}
      ${books.length || groups.length ? groupHtml : '<p class="muted small note-tight">尚無單詞本；可在練習結束時保存，或用「導入單字」批量建立。</p>'}
      ${sixKHtml}
      ${presetsHtml}
    </section>
    <div id="lookup-week-slot"></div>
    <section class="card">
      <h3>不會單字</h3>
      <p class="muted small">${marks.length
        ? `目前共 ${marks.length} 字；完整清單與管理已移至「複習」頁底部。`
        : '還沒有標記任何單字。到「查詢」搜尋單字後按「標記為不會」按鈕，或在「練習」中加入複習計劃。'}</p>
      <button class="btn" id="btn-goto-review">前往複習頁管理</button>
    </section>
    </div>`);

  // ================= 事件：練習入口 =================
  const btnAll = page.querySelector('#btn-practice-unknown');
  if (btnAll) {
    btnAll.addEventListener('click', () => {
      const pool = marks.map((m) => wordsById.get(m.wordId)).filter(Boolean);
      startPractice(pool, 'unknown');
    });
  }

  // 4.0.0：不會單字管理入口 → 複習頁
  page.querySelector('#btn-goto-review').addEventListener('click', () => {
    location.hash = '#/review';
  });

  // ================= 事件：單詞本卡（收攏/展開與內部操作） =================
  // 4.2.0 批次 3：展開態的卡片頭改成 div[role=button]（.list-row--tappable 需無邊框），
  // 故手動補 Enter／Space 的鍵盤等價（button 元素本來就有）
  const toggleBook = (id) => {
    expandedBookId = expandedBookId === id ? null : id;
    renderUnknown(main);
  };
  page.querySelectorAll('.wb-card-head').forEach((h) => {
    h.addEventListener('click', () => toggleBook(h.dataset.id));
    if (h.tagName !== 'BUTTON') {
      h.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        toggleBook(h.dataset.id);
      });
    }
  });

  page.querySelectorAll('.btn-practice-book').forEach((b) => {
    b.addEventListener('click', async () => {
      const book = books.find((x) => String(x.id) === b.dataset.id);
      if (!book) return;
      const pool = book.wordIds.map((id) => wordsById.get(id)).filter(Boolean);
      if (pool.length === 0) {
        toast('這本單詞本裡的單字已不在字庫中', 'bad');
        return;
      }
      await touchWordbook(book.id);
      startPractice(pool, 'wordbook');
    });
  });

  page.querySelectorAll('.btn-delete-book').forEach((b) => {
    b.addEventListener('click', async () => {
      const book = books.find((x) => String(x.id) === b.dataset.id);
      if (!book) return;
      // 4.2.0：刪除類 confirm → openDialog（danger：整本單詞本被移除）
      const ok = await openDialog({
        title: '刪除單詞本',
        body: `刪除單詞本「${book.name}」？本機會一併移除這本書的複習進度，此操作不可復原。`,
        danger: true,
        okText: '刪除',
        cancelText: '取消',
      });
      if (!ok) return;
      await deleteWordbook(book.id);
      if (expandedBookId === String(book.id)) expandedBookId = null;
      toast(`已刪除單詞本「${book.name}」`, 'ok');
      renderUnknown(main);
    });
  });

  // 展開區：排序切換（存回單詞本）
  page.querySelectorAll('.wb-sort').forEach((sel) => {
    sel.addEventListener('change', async () => {
      await updateWordbook(sel.dataset.id, { sort: sel.value });
      renderUnknown(main);
    });
  });
  // 展開區：移動分組
  page.querySelectorAll('.wb-move').forEach((sel) => {
    sel.addEventListener('change', async () => {
      await updateWordbook(sel.dataset.id, { groupId: sel.value || null });
      renderUnknown(main);
    });
  });

  // ================= 事件：分組管理 =================
  page.querySelector('#btn-add-group').addEventListener('click', async () => {
    // 4.2.0：原生輸入框 → openDialog 的 input 模式（回傳 string｜null）
    const name = await openDialog({
      title: '新增分組',
      body: '分組只是把單詞本分類，不影響單字內容。',
      input: true,
      value: '',
      placeholder: '輸入分組名稱',
    });
    if (name && name.trim()) {
      await addGroup(name.trim());
      toast(`已新增分組「${name.trim()}」`, 'ok');
      renderUnknown(main);
    }
  });
  page.querySelectorAll('.btn-rename-group').forEach((b) => {
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      // 4.2.0：原生輸入框 → openDialog 的 input 模式（帶入原名稱）
      const name = await openDialog({
        title: '重新命名分組',
        body: '改成新名稱；底下的單詞本不會變動。',
        input: true,
        value: b.dataset.name,
        placeholder: '輸入新的分組名稱',
      });
      if (name && name.trim() && name.trim() !== b.dataset.name) {
        await renameGroup(b.dataset.id, name.trim());
        toast(`已改名為「${name.trim()}」`, 'ok');
        renderUnknown(main);
      }
    });
  });
  page.querySelectorAll('.btn-del-group').forEach((b) => {
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      // 4.2.0：刪除類 confirm → openDialog（danger）
      const ok = await openDialog({
        title: '刪除分組',
        body: `刪除分組「${b.dataset.name}」？底下的單詞本會退回「未分組」，不會消失。`,
        danger: true,
        okText: '刪除',
        cancelText: '取消',
      });
      if (!ok) return;
      await deleteGroup(b.dataset.id);
      toast(`已刪除分組「${b.dataset.name}」`, 'ok');
      renderUnknown(main);
    });
  });

  // ================= 事件：導入 =================
  // 輸入即存（重渲染不丟字）
  page.querySelector('#import-text')?.addEventListener('input', (e) => {
    importState.text = e.target.value;
  });
  page.querySelector('#import-name')?.addEventListener('input', (e) => {
    importState.name = e.target.value;
  });
  page.querySelector('#import-sort')?.addEventListener('change', (e) => {
    importState.sort = e.target.value;
  });
  page.querySelector('#import-group')?.addEventListener('change', (e) => {
    importState.groupId = e.target.value;
  });
  page.querySelector('#btn-import').addEventListener('click', () => {
    importOpen = !importOpen;
    importResult = importOpen ? importResult : null;
    renderUnknown(main);
  });
  page.querySelector('#btn-import-close')?.addEventListener('click', () => {
    importOpen = false;
    importResult = null;
    renderUnknown(main);
  });
  page.querySelector('#btn-validate')?.addEventListener('click', () => {
    const tokens = parseWordTokens(page.querySelector('#import-text').value);
    const { valid, invalid } = verifyTokens(tokens);
    importResult = {
      valid,
      invalid,
      name: page.querySelector('#import-name').value.trim(),
      groupId: page.querySelector('#import-group').value || null,
      sort: page.querySelector('#import-sort').value,
    };
    renderUnknown(main);
  });
  page.querySelector('#btn-import-confirm')?.addEventListener('click', async () => {
    const r = importResult;
    if (!r || r.valid.length === 0) return;
    const now = new Date();
    const pad = (v) => String(v).padStart(2, '0');
    const name = r.name || `導入單詞本_${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    const id = await addWordbook({
      name,
      wordIds: sortWords(r.valid, r.sort).map((w) => w.id),
      endedAt: now.toISOString(),
    });
    if (r.groupId) await updateWordbook(id, { groupId: r.groupId });
    if (r.sort !== 'input') await updateWordbook(id, { sort: r.sort });
    importOpen = false;
    importResult = null;
    expandedBookId = String(id);
    renderUnknown(main);
  });

  // 後台單詞本：展開／收攏（4.2.0：展開態卡片頭是 div[role=button]，需補鍵盤等價）
  const togglePreset = (name) => {
    presetExpanded = presetExpanded === name ? null : name;
    renderUnknown(main);
  };
  page.querySelectorAll('.preset-card-head').forEach((h) => {
    h.addEventListener('click', () => togglePreset(h.dataset.name));
    if (h.tagName !== 'BUTTON') {
      h.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        togglePreset(h.dataset.name);
      });
    }
  });

  // 後台單詞本導入（一般卡與 6000 單字選擇器共用同一支 importPresetByName）
  page.querySelectorAll('.btn-preset').forEach((b) => {
    b.addEventListener('click', async () => { await importPresetByName(b.dataset.name, main); });
  });

  // 5.3：6000 單字選擇器（節切換／單元導入）。資料全部來自已載入的 presets 快取，不新增 fetch
  page.querySelectorAll('.sixk-sec').forEach((r) => {
    r.addEventListener('change', () => {
      if (r.disabled) return;
      sixKSec = r.value;
      renderUnknown(main);
    });
  });
  page.querySelectorAll('.btn-sixk-unit').forEach((b) => {
    b.addEventListener('click', async () => { await importPresetByName(b.dataset.name, main); });
  });

  // 5.1.3：從檔案庫中選擇（多選匯入）。資料一律走 loadPresets 的 60 秒快取（上面已呼叫過），
  // 本路徑零新增 fetch。匯入本身沿用 importPresetByName（quiet 版），不複製一份。
  page.querySelector('#btn-pick-presets')?.addEventListener('click', async () => {
    const done = await openPresetPicker(presets, groups);
    if (!done || !done.names.length) return;
    // 分組：填了新名稱就用 addGroup 新建並記住新 id，否則用下拉選項的值（空字串就是未分組）
    let gid = done.groupId;
    if (done.newGroup) {
      gid = await addGroup(done.newGroup);
    }
    const rows = [];
    for (const nm of done.names) {
      const r = await importPresetByName(nm, null, gid || null, true);
      if (r) rows.push(r);
    }
    const total = rows.reduce((n, r) => n + r.validCount, 0);
    const pend = rows.reduce((n, r) => n + r.pendingCount, 0);
    // 一條彙總 toast（逐本的 toast 會洗版，故多選路徑一律 quiet）
    toast(`已匯入 ${rows.length} 本單詞本，共 ${total} 字${pend ? `；${pend} 字不在字庫，已記錄待字庫補上後自動加入` : ''}`, 'ok');
    renderUnknown(main);   // expandedBookId 已是最後一本（importPresetByName 內設定）
  });

  // 5.3：單詞本合併
  page.querySelectorAll('.btn-book-merge').forEach((b) => {
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const target = books.find((x) => String(x.id) === b.dataset.id);
      if (!target) return;
      // 來源清單＝其他單詞本（不能自己併自己）
      const others = books.filter((x) => String(x.id) !== String(target.id));
      if (others.length === 0) {
        toast('只有這一本單詞本，沒有可合併的來源', 'bad');
        return;
      }
      // 對話框的 overlay 在 Promise resolve 前就被移除，選項必須在「等待期間」讀取：
      // openDialog 的 Promise executor 同步執行（appendChild 當場完成），故呼叫後立刻可抓到 overlay。
      const choice = { source: String(others[0].id), drop: false };
      const opened = openDialog({
        title: '合併單詞本',
        bodyHtml: `
          <p>把哪一本併入「${escapeHtml(target.name)}」？來源本的字會接在目標本後面（重複的字不重複加入）。</p>
          <div class="bank-picker" role="radiogroup" aria-label="選擇來源單詞本">
            ${others.map((o, i) => `
              <label class="bank-item">
                <input type="radio" name="merge-source" value="${escapeHtml(o.id)}"${i === 0 ? ' checked' : ''}>
                <span class="bank-item-label">${escapeHtml(o.name)}</span>
                <span class="bank-item-count muted">${(o.wordIds || []).length} 字</span>
              </label>`).join('')}
          </div>
          <p class="section-divider">合併後要不要刪掉來源本？</p>
          <label class="settings-switch"><input type="checkbox" id="merge-delete"><span>合併後刪除來源本</span></label>
          `,
        okText: '合併',
        cancelText: '取消',
      });
      const ov = [...document.querySelectorAll('.dlg-overlay')].pop();   // 取最後開啟的那一個
      ov?.querySelectorAll('input[name="merge-source"]').forEach((r) => {
        r.addEventListener('change', () => { choice.source = r.value; });
      });
      ov?.querySelector('#merge-delete')?.addEventListener('change', (e) => { choice.drop = !!e.target.checked; });
      if (!await opened) return;
      const picked = others.find((o) => String(o.id) === String(choice.source));
      const dropSource = choice.drop;
      if (!picked) { toast('沒有選來源本', 'bad'); return; }
      // 池 B 發現（high ＋ medium 兩輪）：
      //   ① 對話框開著時 targets/來源都是 renderUnknown 開頭抓的快照，等待期間另一條真實寫入
      //      路徑（5.0.0 待補自動補進／雲端合併匯入，都走 store.appendWordIds）append 的字會被蓋掉。
      //   ② 只把來源「重讀」一次仍不夠：重讀完成到下一個交易開始之間又有視窗；勾「刪除來源本」時
      //      那些晚到的字會隨來源本一起消失，而 toast 仍宣稱成功。
      // 兩者都是「讀改寫跨不過交易邊界」。處置：整段（讀來源 → 改目標 → 選刪）併進
      // store.mergeWordbookInto 的單一 readwrite 交易——IndexedDB 對同一 objectStore 的交易是
      // 序列化的，其他寫入路徑只可能整個排在它之前（字有進目標本）或之後，不存在中間地帶。
      // 不再另外呼叫 getWordbooks／appendWordIds／deleteWordbook，三步各自一個交易正是視窗來源。
      const r = await mergeWordbookInto(target.id, picked.id, { dropSource });
      if (!r.merged) {
        const why = r.reason === 'target-missing' ? '目標單詞本已不存在，未合併'
          : r.reason === 'source-missing' ? '來源本已不存在' : '來源與目標是同一本，無需合併';
        toast(why, 'bad');
        return;
      }
      toast(`已將『${r.sourceName}』併入『${target.name}』（新增 ${r.added} 字）${dropSource ? '、來源本已刪除' : ''}`, 'ok');
      renderUnknown(main);
    });
  });

  // ================= 事件：匯出 =================
  page.querySelector('#btn-export-books')?.addEventListener('click', () => {
    const rowsOut = [];
    for (const b of books) {
      for (const id of b.wordIds) {
        const w = wordsById.get(id);
        if (!w) continue;
        rowsOut.push([b.name, w.level <= 6 ? `Lv${w.level}` : 'Lv7補充', w.word, w.pos, w.senses.join('；')]);
      }
    }
    if (rowsOut.length === 0) {
      toast('單詞本裡沒有可匯出的單字', 'bad');
      return;
    }
    exportCsv(`單詞本_${dateStr()}.csv`, ['單詞本', '等級', '英文', '詞性', '中文'], rowsOut);
    toast(`已匯出 ${rowsOut.length} 個單字`, 'ok');
  });
  page.querySelectorAll('.btn-export-book').forEach((b) => {
    b.addEventListener('click', () => {
      const book = books.find((x) => String(x.id) === b.dataset.id);
      if (!book) return;
      const rowsOut = book.wordIds.map((id) => wordsById.get(id)).filter(Boolean)
        .map((w) => [book.name, w.level <= 6 ? `Lv${w.level}` : 'Lv7補充', w.word, w.pos, w.senses.join('；')]);
      if (rowsOut.length === 0) { toast('沒有可匯出的單字', 'bad'); return; }
      exportCsv(`${book.name}_${dateStr()}.csv`, ['單詞本', '等級', '英文', '詞性', '中文'], rowsOut);
      toast(`已匯出 ${rowsOut.length} 個單字`, 'ok');
    });
  });

  main.replaceChildren(page);

  // 5.0.x：本週查過的字（spec 5.7 第 6 節）——chips 跳查詢＋一鍵全部加入單詞本
  // 【非阻塞】這一區要掃 events（getRecentLookups → getEvents 整表 getAll），
  //   依本專案既有慣例不在進頁路徑 await：先畫完主體，區塊到位後再就地插入
  //   （與 practice.js 的 fillExamBadge、exam.js 的 AI 題庫計數同一套路）。
  renderLookupWeekBlock({ wordsById, books }).then((html) => {
    const slot = main.querySelector('#lookup-week-slot');
    if (!slot || !html) return;            // 離頁了或本週沒查過 → 不渲染
    slot.innerHTML = html;
    wireLookupWeek(main, { wordsById, books });
  }).catch(() => {
    const slot = main.querySelector('#lookup-week-slot');
    if (slot) slot.remove();               // 讀不到就不留空殼
  });

  // 5.1.1 W2：精熟度與 Due 非阻塞回填。graduate 事件在 events 表（整表 getAll 較重，
  //   本頁慣例是不在進頁路徑 await，見上方本週查詢字的同一理由）——故分組區先畫完
  //   （退回舊排序），資料到位後整頁重算：排序轉為精熟度升冪、卡片補上精熟度條。
  // 用整頁重渲染而非局部 DOM 手術：卡的收攏展開與內部六組按鈕的監聽都在本次 render 結束時
  // 統一綁定，局部改動會漏綁（toggleBook 已是同一套機制，expandedBookId／importState 保留）。
  if (!graduateIds) {
    Promise.all([getSrsQueues(), getEvents()]).then(([{ due }, events]) => {
      if (!stillOn()) return;              // 期間已切頁：不覆蓋新頁（routeGuard 慣例）
      graduateIds = new Set(events.filter((e) => e.type === 'graduate').map((e) => String(e.wordId)));
      dueRows = due;
      renderUnknown(main);                 // 重渲染：排序與卡片精熟度條到位
    }).catch(() => {
      // 讀不到 graduate 資料：卡片維持不顯示精熟度列，不誤顯示 0%
    });
  }
}

// 5.1.1 W2：單詞本排序＝精熟度升冪（弱本浮上），同分依名稱（spec W2 明文）。
// 導出供 smoke 測試直接對照排序口徑；精熟度本身走 core/mastery.js 的共用 helper。
export function rankBooksByMastery(books, marks, graduateIds) {
  const rows = (books || []).map((b) => ({ book: b, ...masteryOfBook(b, marks, graduateIds) }));
  rows.sort((a, b) => (a.pct - b.pct) || a.book.name.localeCompare(b.book.name, 'zh-Hant-TW'));
  return rows;
}

// ================= 單詞本卡：收攏／展開 =================
// 5.1.1 W2：卡片補精熟度條＋「精熟 N%・Due M」（樣品 M3）。精熟度與 Due 一律走
// core/mastery.js 的共用 helper（首頁 H3 卡片牆同一支，spec 明文禁止兩處各寫一份）。
// graduateIds 未回填時整列不渲染（不顯示 0%／Due 0，避免誤導）。
function bookCardHtml(b, wordsById, marks) {
  const validIds = b.wordIds.filter((id) => wordsById.has(id));
  const count = validIds.length;
  const expanded = expandedBookId === String(b.id);
  // 5.0.0：待補小標（字庫外字；補齊後自動消失）
  const pending = Array.isArray(b.pendingWords) ? b.pendingWords : [];
  const tag = pending.length
    ? `<span class="grp-tag" title="字庫補上後會自動加入">+${pending.length} 待補</span>` : '';
  const m = graduateIds
    ? { pct: masteryOfBook(b, marks, graduateIds).pct, due: dueOfBook(b, dueRows || []) }
    : null;
  const masteryHtml = m
    ? `<div class="wb-mastery">
        <div class="wb-mastery-bar" title="精熟 ${m.pct}%"><i style="width:${m.pct}%"></i></div>
        <div class="wb-mastery-txt muted small">精熟 ${m.pct}%・Due ${m.due}</div>
      </div>`
    : '';
  if (!expanded) {
    return `
      <button class="list-row--tappable wb-card collapsed wb-card-head" data-id="${b.id}">
        <span class="wb-card-top">
          <span class="wb-name">${escapeHtml(b.name)}${tag}</span>
          <span class="wb-meta">${count} 字${iconInline(ICONS.chevronRight, 13)}</span>
        </span>
        ${masteryHtml}
      </button>`;
  }
  const sorted = sortWords(validIds.map((id) => wordsById.get(id)), b.sort || 'input');
  const listHtml = sorted.length
    ? sorted.map((w) => `<span class="chip">Lv${w.level}　${escapeHtml(w.word)}</span>`).join('')
    : '<p class="muted small">這本單詞本裡的單字已不在字庫中。</p>';
  const ended = new Date(b.endedAt).toLocaleString('zh-TW', { hour12: false });
  return `
    <div class="wb-card expanded">
      <div class="list-row--tappable wb-card-head" data-id="${b.id}" role="button" tabindex="0">
        <span class="wb-name">${escapeHtml(b.name)}${tag}</span>
        <span class="wb-meta">${count} 字${iconInline(ICONS.chevronDown, 13)}</span>
      </div>
      ${masteryHtml}
      <div class="wb-detail">
        <div class="wb-meta wb-detail-meta">練習結束於 ${ended}</div>
        ${pending.length ? `<p class="muted small">待補 ${pending.length}：${escapeHtml(pending.slice(0, 6).join('、'))}${pending.length > 6 ? '…' : ''}（字庫補上後會自動加入）</p>` : ''}
        <div class="wb-controls">
          <label>瀏覽排序
            <select class="wb-sort" data-id="${b.id}">
              ${['input|我輸入的順序', 'level|等級（低到高）', 'az|字母 A 到 Z', 'za|字母 Z 到 A'].map((o) => {
                const [v, t] = o.split('|');
                return `<option value="${v}"${(b.sort || 'input') === v ? ' selected' : ''}>${t}</option>`;
              }).join('')}
            </select>
          </label>
          <button class="btn primary btn-practice-book" data-id="${b.id}">練習（隨機）</button>
          <button class="btn btn-export-book" data-id="${b.id}">匯出 CSV</button>
          <button class="btn btn-book-merge" data-id="${b.id}">合併</button>
          <button class="btn subtle btn-delete-book" data-id="${b.id}">刪除</button>
        </div>
        <div class="wb-words">${listHtml}</div>
      </div>
    </div>`;
}

// ================= 排序與解析工具 =================
// 瀏覽排序：input＝匯入時的字序（wordIds 原序）；練習永遠隨機（startPractice 不受影響）
function sortWords(wordObjs, mode) {
  const arr = [...wordObjs];
  if (mode === 'level') arr.sort((a, b) => a.level - b.level || a.word.localeCompare(b.word));
  else if (mode === 'az') arr.sort((a, b) => a.word.localeCompare(b.word));
  else if (mode === 'za') arr.sort((a, b) => b.word.localeCompare(a.word));
  return arr;
}


// ================= 預設單詞本 =================
// 5.0.0：pending_words（字庫外待補字）需 tools/supabase_440.sql 才存在。
// 未執行時 PostgREST 整包 select 會回 42703／PGRST204，連雲端單詞本都會跟著消失，
// 故先帶欄位試、認出「欄位不存在」再退回不帶欄位重抓（待補小標消失，功能不壞）。
function missingPendingColumn(err) {
  return /42703|PGRST204/.test(String(err?.message || err));
}

// 5.0.0：小寫化＋去重（待補清單一律小寫存，比對時與 search.js 的索引鍵一致）
function dedupeLower(list) {
  const seen = new Set();
  const out = [];
  for (const t of list || []) {
    const s = String(t ?? '').trim().toLowerCase();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

async function loadPresets() {
  // 5.0.0：60 秒 TTL——後台的自動補進會改雲端 words／pending_words，久坐快取會讓
  // 匯入拿到舊清單（池 B 驗證發現）；TTL 過短則每次渲染都打 Supabase
  if (presetsCache && Date.now() - presetsCacheAt < 60000) return presetsCache;
  try {
    const res = await fetch('data/presets.json');
    presetsCache = res.ok ? ((await res.json()).presets || []).map((p) => ({ ...p, group: p.group || '' })) : [];
    presetsCacheAt = Date.now();
  } catch { /* 離線時用檔案內建（可能為空） */ }
  try {
    // 後台發佈的雲端單詞本（同名以雲端為準）
    // 4.0.2 修復：欄位是 description（原代碼誤 select desc 導致 42703，整包失敗被 catch 吞掉，
    // 使用者端因此從 3.3.1 起看不到後台發佈的單詞本）；並加 group_name 分組
    const base = 'vocab_presets?active=eq.true&select=name,description,words,group_name';
    let rows;
    try {
      rows = await restFetch(`${base},pending_words`);
    } catch (err) {
      if (!missingPendingColumn(err)) throw err;
      rows = await restFetch(base);
    }
    const byName = new Map(presetsCache.map((p) => [p.name, p]));
    for (const r of rows) {
      byName.set(r.name, {
        name: r.name, desc: r.description || '', group: r.group_name || '',
        words: Array.isArray(r.words) ? r.words : JSON.parse(r.words || '[]'),
        pendingWords: dedupeLower(Array.isArray(r.pending_words) ? r.pending_words : []),
      });
    }
    presetsCache = [...byName.values()];
    presetsCacheAt = Date.now();
  } catch { /* 未設定 Supabase 或雲端無資料 */ }
  return presetsCache;
}

// ---------- 5.0.4：給「學習」頁（#/study）用的預設單詞本入口 ----------
// 【為什麼要有這兩支】預設單詞本是後台發佈的**名稱＋英文 token** 清單（words 存字面，
//   不是字庫 id），所以學習頁無法走 bank-picker 的 wordbook:<id> 那條路；這裡把既有
//   presetsCache 的兩種查法（列清單／取字面）各開一個小出口，單一資料源仍是本檔的
//   loadPresets（60 秒 TTL），避免學習頁再打一次 Supabase。
// 形狀刻意與 core/bank-picker.js 的 wordbookSources() 一致，讓學習頁直接餵 bankPickerHTML。
export async function presetBankSources() {
  return (await loadPresets())
    .map((p) => ({
      id: `preset:${p.name}`,
      label: p.group ? `${p.group}・${p.name}` : p.name,
      count: (p.words || []).length,
    }));
}

export async function presetWords(name) {
  const hit = (await loadPresets()).find((p) => p.name === name);
  return Array.isArray(hit?.words) ? hit.words : [];
}

// ================= 後台單詞本一鍵導入（一般卡與 6000 單字選擇器共用） =================
// 抽出來的原因：5.3 的 6000 單元導入要「完全沿用」這段流程（含 pendingWords 收集），
// 複製一份的話待補字邏輯會各自漂移；故單一實作、兩處呼叫。
// 5.1.3 再加兩條路徑（從檔案庫多選匯入），仍然是同一支實作：
//   groupId：匯入後要落進哪個分組；不傳就不動分組（單本路徑維持原行為，向後相容）。
//   quiet：多選時逐本跳 toast 會洗版，傳 true 讓這裡不跳，由呼叫端在全部匯完後跳一條彙總。
async function importPresetByName(name, main, groupId = null, quiet = false) {
  const p = (await loadPresets()).find((x) => x.name === name);
  if (!p) return null;
  const { valid, invalid } = verifyTokens(parseWordTokens(p.words.join(' ')));
  const now = new Date();
  // 5.0.0：字庫外的字不只略過，還記進 pendingWords（字庫收錄後啟動時自動補進）
  // 兩個來源都要收：① 本次匯入當下字庫沒有的字（invalid）
  //              ② 雲端列已記錄的待補字（p.pendingWords，後台發佈時就存下來的字庫外字）
  // 少收 ② 會讓「後台發佈 → 使用者匯入」這條主要路徑上的待補字整批遺失。
  const pending = dedupeLower([...invalid, ...(p.pendingWords || [])]);
  const id = await addWordbook({
    name: p.name,
    wordIds: sortWords(valid, 'input').map((w) => w.id),
    endedAt: now.toISOString(),
    pendingWords: pending,
  });
  if (groupId) await updateWordbook(id, { groupId });
  expandedBookId = String(id);
  // 4.2.0：資訊型 alert → toast（字庫外略過屬提醒，不中斷）
  if (!quiet && pending.length) {
    // 列 6 個上限：單詞本常有十幾個待補字，全列會把提示擠成兩行
    toast(`『${p.name}』導入完成（${valid.length} 字）；${pending.length} 字不在字庫，已記錄待字庫補上後自動加入：${pending.slice(0, 6).join('、')}${pending.length > 6 ? '…' : ''}`);
  }
  if (main) renderUnknown(main);   // main 為 undefined 時只匯入不重繪（測試可直接呼叫本函式驗資料）
  return { id, validCount: valid.length, pendingCount: pending.length, name: p.name };
}

// ================= 從檔案庫中選擇（5.1.3：一次匯入多本） =================
// 資料來源是本檔既有的 loadPresets 快取（renderUnknown 開頭已呼叫），本路徑零新增 fetch。
// 匯入本身交給呼叫端走 importPresetByName(quiet)，這裡只負責「勾選＋選分組」並回傳結果。
// 回傳 { names:[preset 名], groupId, newGroup }；取消或沒勾則回 null。
//
// 節分組：6000 單字依節（沿用既有的 parseSixKName 與 SIXK_SECS 切法與節序），
// 其餘依後台分組名。順序沿用頁面呈現（6000 單字在前，一般後台單詞本在後）。
function presetSections(presets) {
  const sixK = presets.filter((p) => p.group === SIXK_GROUP);
  const rest = presets.filter((p) => p.group !== SIXK_GROUP);
  const bySec = new Map();
  for (const p of sixK) {
    // 名稱不符「6000單字 <節>・u<N>」的自訂列解析不出節，併進同一區的「其他」不會看不到
    const sec = parseSixKName(p.name)?.sec ?? '其他';
    if (!bySec.has(sec)) bySec.set(sec, []);
    bySec.get(sec).push(p);
  }
  const secs = SIXK_SECS.slice().sort((a, b) => {
    const oa = a === 'PLUS' ? 1 : 0;
    const ob = b === 'PLUS' ? 1 : 0;
    return oa - ob || (bySec.has(a) === bySec.has(b) ? 0 : bySec.has(a) ? -1 : 1);
  });
  for (const s of bySec.keys()) if (!secs.includes(s)) secs.push(s);
  const out = secs.filter((s) => bySec.has(s)).map((sec) => ({
    title: `${SIXK_TITLE} ${sec}`,
    items: bySec.get(sec).slice().sort((a, b) => (parseSixKName(a.name)?.unit || 0) - (parseSixKName(b.name)?.unit || 0)),
  }));
  const byGroup = new Map();
  for (const p of rest) {
    const g = p.group || '';
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(p);
  }
  for (const g of [...byGroup.keys()].sort((a, b) => a.localeCompare(b, 'zh-Hant-TW'))) {
    out.push({ title: g || '未分組', items: byGroup.get(g) });
  }
  return out;
}

function openPresetPicker(presets, groups) {
  const secs = presetSections(presets || []);
  if (!secs.length) {
    toast('檔案庫裡還沒有可匯入的單詞本', 'bad');
    return Promise.resolve(null);
  }
  const picked = new Set();
  const choice = { groupId: '', newGroup: '' };
  const opened = openDialog({
    title: '從檔案庫中選擇單詞本',
    bodyHtml: `
      <p class="muted small">一次勾選多本，匯入後會各自建成一本單詞本；勾「待補」的字會記錄下來，字庫補上時自動加入。</p>
      <div class="import-actions">
        <button class="btn subtle" type="button" data-pick-all>全選本節</button>
        <button class="btn subtle" type="button" data-pick-none>清除選取</button>
      </div>
      <div class="sched-scroll">
        ${secs.map((s, i) => `
          <div class="wb-group">
            <div class="wb-group-head">
              <span class="grp-name">${escapeHtml(s.title)}</span>
              <span class="grp-count">${s.items.length} 本</span>
              <span class="grp-actions"><button class="btn subtle" type="button" data-pick-sec="${i}">全選本節</button></span>
            </div>
            <div class="bank-picker">
              ${s.items.map((p) => {
                // 字數與 5.3 的 6000 單元選擇器同一口徑：verifyTokens 去重後的 valid 數
                const v = verifyTokens(p.words || []).valid.length;
                const pend = (p.pendingWords || []).length;
                return `
                <label class="bank-item">
                  <input type="checkbox" class="pick-row" data-sec="${i}" value="${escapeHtml(p.name)}">
                  <span class="bank-item-label">${escapeHtml(p.name)}</span>
                  <span class="bank-item-count muted">${v} 字${pend ? `＋${pend} 待補` : ''}</span>
                </label>`;
              }).join('')}
            </div>
          </div>`).join('')}
      </div>
      <div class="import-row">
        <label>存入分組
          <select id="pick-group"><option value="">未分組</option>
            ${(groups || []).map((g) => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.name)}</option>`).join('')}
          </select>
        </label>
        <label>新分組名稱（留空不新建）
          <input type="text" id="pick-newgroup" maxlength="30" placeholder="留空不新建" spellcheck="false">
        </label>
      </div>`,
    okText: '匯入所選（0）',
    cancelText: '取消',
  });
  // 對話框的 overlay 在 Promise resolve 前就被移除，選項必須在「等待期間」讀取：
  // openDialog 的 Promise executor 同步執行（appendChild 當場完成），故呼叫後立刻可抓到 overlay。
  const ov = [...document.querySelectorAll('.dlg-overlay')].pop();
  const rowsOf = () => [...ov.querySelectorAll('.pick-row')];
  const okBtn = ov.querySelector('[data-r="1"]');
  const syncOk = () => {
    okBtn.textContent = `匯入所選（${picked.size}）`;
    okBtn.disabled = picked.size === 0;   // 一本都沒勾不給按
  };
  rowsOf().forEach((r) => r.addEventListener('change', () => {
    if (r.checked) picked.add(r.value); else picked.delete(r.value);
    syncOk();
  }));
  ov.querySelector('[data-pick-all]').addEventListener('click', () => {
    for (const r of rowsOf()) { r.checked = true; picked.add(r.value); }
    syncOk();
  });
  ov.querySelector('[data-pick-none]').addEventListener('click', () => {
    for (const r of rowsOf()) r.checked = false;
    picked.clear();
    syncOk();
  });
  // 每一節自己的「全選本節」：38 列分散在三節，只給一個全選等於沒得選
  secs.forEach((_s, i) => {
    ov.querySelector(`[data-pick-sec="${i}"]`).addEventListener('click', () => {
      for (const r of ov.querySelectorAll(`.pick-row[data-sec="${i}"]`)) {
        r.checked = true;
        picked.add(r.value);
      }
      syncOk();
    });
  });
  ov.querySelector('#pick-group').addEventListener('change', (e) => { choice.groupId = e.target.value; });
  ov.querySelector('#pick-newgroup').addEventListener('input', (e) => { choice.newGroup = e.target.value.trim(); });
  syncOk();
  return opened.then((ok) => {
    if (!ok || picked.size === 0) return null;
    return { names: [...picked], groupId: choice.groupId, newGroup: choice.newGroup };
  });
}

// ================= 6000 單字選擇器（5.3） =================
// 節 → 單元兩層；資料全部來自 loadPresets 的快取（紅線：不新增 blocking fetch）。
// 節名不在已佈建的列裡時顯示停用態（PLUS 永遠是停用態：docx 沒有這節）。
function sixKBoxHtml(presets) {
  if (!presets.length) return '';
  const bySec = new Map();
  for (const p of presets) {
    const k = parseSixKName(p.name);
    if (!k) continue;
    if (!bySec.has(k.sec)) bySec.set(k.sec, []);
    bySec.get(k.sec).push(p);
  }
  // 節清單：spec 5.3 第 2 節的三節排前（PLUS 停用態），已佈建的節優先，
  // 最後補上其餘實際存在的節（後台手動新增的 L7 等）——節清單外的節若不補，
  // 它的列在 segmented 裡沒有入口，等於看不到也匯不進（池 B 發現 medium）。
  // 節清單外的節不設停用：它們是「真的佈建了單元」的節，點得進去才是事實。
  const secs = SIXK_SECS.slice().sort((a, b) => {
    const oa = a === 'PLUS' ? 1 : 0;
    const ob = b === 'PLUS' ? 1 : 0;
    return oa - ob || (bySec.has(a) === bySec.has(b) ? 0 : bySec.has(a) ? -1 : 1);
  });
  for (const s of bySec.keys()) if (!secs.includes(s)) secs.push(s);
  const cur = bySec.has(sixKSec) ? sixKSec : (secs.find((s) => bySec.has(s)) || sixKSec);
  const units = (bySec.get(cur) || []).slice().sort((a, b) => (parseSixKName(a.name)?.unit || 0) - (parseSixKName(b.name)?.unit || 0));
  const segHtml = secs.map((s) => {
    const on = s === cur;
    // PLUS 停用：來源檔沒有此節，按了也不會有任何單元
    return `
      <label${s === 'PLUS' ? ' class="muted"' : ''}>
        <input type="radio" class="sixk-sec" name="sixk-sec" value="${escapeHtml(s)}"${on ? ' checked' : ''}${s === 'PLUS' ? ' disabled' : ''}>
        <span>${escapeHtml(s === 'PLUS' ? 'PLUS（未加入）' : s)}</span>
      </label>`;
  }).join('');
  const unitHtml = units.length
    ? `<div class="chip-pool">${units.map((p) => {
        const k = parseSixKName(p.name);
        // 5.0.0 池 B 驗證：字數顯示以「字庫 word id 去重後」為準—— chairman/chairwoman 這類
        // 變化形會展開到同一筆字庫條目（如 chairperson/chair/…），雲端 token 數會比實際匯入多
        const v = verifyTokens(p.words || []).valid.length;
        const pend = (p.pendingWords || []).length;
        return `<button class="chip-opt btn-sixk-unit" data-name="${escapeHtml(p.name)}" title="${escapeHtml(p.name)}">u${k.unit}　${v} 字${pend ? `＋${pend} 待補` : ''}</button>`;
      }).join('')}</div>`
    : '<p class="muted small">這個節還沒有可匯入的單元。</p>';
  const pendingTotal = units.reduce((n, p) => n + ((p.pendingWords || []).length), 0);
  return `
      <div class="preset-box" id="sixk-box">
        <h3>${escapeHtml(SIXK_TITLE)}</h3>
        <div class="segmented" role="radiogroup" aria-label="${escapeHtml(SIXK_GROUP)} 節">${segHtml}</div>
        ${unitHtml}
        ${pendingTotal ? `<p class="muted small">目前共 ${pendingTotal} 個字尚未收錄於字庫，匯入後會記錄待補、字庫補上時自動加入。</p>` : ''}
      </div>`;
}

// ================= 後台單詞本卡：收攏／展開（4.0.2） =================
function presetCardHtml(p, byWord) {
  const words = Array.isArray(p.words) ? p.words : [];
  const pending = p.pendingWords || [];
  const expanded = presetExpanded === p.name;
  // 5.0.0：待補小標（沿用後台既有的 .grp-tag 藥丸樣式，不另立 class）
  const tag = pending.length
    ? `<span class="grp-tag" title="字庫補上後會自動加入">+${pending.length} 待補</span>` : '';
  if (!expanded) {
    return `
      <button class="list-row--tappable wb-card collapsed preset-card-head" data-name="${escapeHtml(p.name)}">
        <span class="wb-name">${escapeHtml(p.name)}${tag}</span>
        <span class="wb-meta">${words.length} 字${p.desc ? '　' + escapeHtml(p.desc) : ''}${iconInline(ICONS.chevronRight, 13)}</span>
      </button>`;
  }
  const listHtml = words.length
    ? words.map((wd) => {
        const w = byWord.get(wd);
        return `<span class="chip">${w ? `Lv${w.level}　` : ''}${escapeHtml(wd)}</span>`;
      }).join('')
    : '<p class="muted small">這本單詞本沒有內容。</p>';
  return `
    <div class="wb-card expanded">
      <div class="list-row--tappable preset-card-head wb-card-head" data-name="${escapeHtml(p.name)}" role="button" tabindex="0">
        <span class="wb-name">${escapeHtml(p.name)}${tag}</span>
        <span class="wb-meta">${words.length} 字${p.desc ? '　' + escapeHtml(p.desc) : ''}${iconInline(ICONS.chevronDown, 13)}</span>
      </div>
      <div class="wb-detail">
        <div class="wb-words">${listHtml}</div>
        ${pending.length ? `<p class="muted small">待補 ${pending.length}：${escapeHtml(pending.slice(0, 6).join('、'))}${pending.length > 6 ? '…' : ''}（字庫補上後會自動加入）</p>` : ''}
        <div class="wb-controls">
          <button class="btn primary btn-preset" data-name="${escapeHtml(p.name)}">導入到我的單詞本</button>
        </div>
      </div>
    </div>`;
}
