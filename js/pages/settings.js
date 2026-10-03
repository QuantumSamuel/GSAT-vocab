// ============================================================
// 頁面：設置（2.1.1）——統合個性化設定
// 基本色調（淺色/深色）× 強調色（藍/橘/綠/粉/灰）、字體大小、翻譯題預設題數
// ============================================================
import {
  ACCENTS, accentDot, getAnim, getAccent, getAutoSync, getFace, getFontSize, getMode,
  getSynTentative, setSynTentative,
  getWordSize, setWordSize, setAccent, setAnim, setAutoSync, setFace, setFontSize, setMode,
} from '../services/settings.js';
import { el, ICONS, iconInline } from '../core/ui.js';
import { getKey, getProviderId, listProviders, saveKey, setProviderId } from '../services/ai/index.js';
import { getPreferredModel, setPreferredModel } from '../services/ai/gemini.js';

export function renderSettings(main) {
  const accentCards = ACCENTS.map((a) => `
      <label class="mode-card accent-card" data-a="${a.id}">
        <span class="theme-dot" style="background:${accentDot(a.id)}"></span>
        <span class="mode-title">${a.name}</span>
      </label>`).join('');

  // 4.2.0 批次 3：2~4 選一的短選項全改 .segmented（label＋input[type=radio]）。
  // 保留 .mode-card 的兩組：視覺效果（需實際感受差異）與強調色（圓點卡）。
  const seg = (name, items, id = '') => `
      <div class="segmented"${id ? ` id="${id}"` : ''}>
        ${items.map(([v, lab]) => `<label><input type="radio" name="${name}" value="${v}"><span>${lab}</span></label>`).join('')}
      </div>`;

  const page = el(`
    <section class="card">
      <h2>設置</h2>

      <h3>基本色調</h3>
      ${seg('set-mode', [['auto', '自動'], ['light', '淺色'], ['dark', '深色']])}

      <h3>強調色</h3>
      <div class="mode-grid accent-grid">${accentCards}</div>

      <h3>字體大小</h3>
      ${seg('set-font', [['s', '小'], ['m', '中'], ['l', '大']])}

      <h3>單字卡字體（練習／複習卡的英文單字）</h3>
      ${seg('wordsize', [['s', '小'], ['m', '中（預設）'], ['l', '大'], ['xl', '特大']], 'wordsize-grid')}

      <h3>視覺效果</h3>
      <p class="muted small">全站動畫風格：翻面與切頁的感覺。</p>
      <div class="mode-grid">
        <label class="mode-card"><input type="radio" name="set-anim" value="flip">
          <span class="mode-title">立體翻轉</span></label>
        <label class="mode-card"><input type="radio" name="set-anim" value="soft">
          <span class="mode-title">輕柔淡入</span></label>
        <label class="mode-card"><input type="radio" name="set-anim" value="spring">
          <span class="mode-title">彈性活潑</span></label>
      </div>

      <h3>單字卡預設顯示面</h3>
      <p class="muted small">練習與複習的單字卡一開始先顯示哪一面。</p>
      ${seg('set-face', [['en', '英文'], ['zh', '中文'], ['random', '隨機']])}

      <h3>資料自動同步（需登入帳號）</h3>
      <p class="muted small">登入後每 15 秒（畫面關閉時暫停）比對本機與雲端備份：本機較多時自動上傳、雲端較多時自動合併；互有多少時會詢問你。</p>
      ${seg('set-autosync', [['on', '開啟'], ['off', '關閉']])}

      <h3>查詢顯示</h3>
      <p class="muted small">${iconInline(ICONS.warnTriangle, 13)}<span>查詢單字時顯示「存疑近義」（AI 判讀、帶警示標記的參考條目）；關閉後只顯示通過審核的近義字。</span></p>
      ${seg('set-syn-tent', [['on', '顯示'], ['off', '隱藏']])}

      <h3>AI 供應商與金鑰（翻譯題／批改用）</h3>
      <p class="muted small">金鑰只存在此裝置的瀏覽器；更換供應商後記得貼上該供應商的金鑰。</p>
      <div class="segmented">
        ${listProviders().map((p) => `
        <label><input type="radio" name="set-ai" value="${p.id}">
          <span>${p.name}${p.free ? '' : '（付費）'}</span></label>`).join('')}
      </div>
      <p class="muted small" id="ai-apply-hint"></p>
      <div class="search-row">
        <input type="password" id="set-ai-key" placeholder="貼上目前供應商的 API 金鑰"
               autocomplete="off" spellcheck="false">
        <button class="btn primary" id="btn-save-key">保存</button>
      </div>
      <p class="finish hidden" id="key-saved">金鑰已保存。</p>
      <div class="search-row search-row-tight" id="gemini-model-row">
        <select id="set-gemini-model" class="select-flex">
          <option value="">模型：自動（失效自動換備援，建議）</option>
          <option value="gemini-flash-lite-latest">gemini-flash-lite-latest</option>
          <option value="gemini-3.1-flash-lite">gemini-3.1-flash-lite</option>
          <option value="gemini-2.5-flash-lite">gemini-2.5-flash-lite</option>
        </select>
      </div>

      <p class="finish">設定立即生效並自動保存。</p>
    </section>`);

  // ---- AI 供應商與金鑰（3.0.4） ----
  const aiHint = page.querySelector('#ai-apply-hint');
  const keyInput = page.querySelector('#set-ai-key');
  const modelRow = page.querySelector('#gemini-model-row');
  const modelSelect = page.querySelector('#set-gemini-model');

  function refreshAiUi() {
    const id = getProviderId();
    const p = listProviders().find((x) => x.id === id);
    aiHint.textContent = `${p.name}｜申請：${p.applyUrl}${p.free ? '（有免費額度）' : '（按用量計費）'}`;
    keyInput.value = getKey(id);
    // 模型選擇僅 Gemini 有效（其他供應商模型由服務端寫死）
    modelRow.classList.toggle('hidden', id !== 'gemini');
    modelSelect.value = getPreferredModel();
  }
  refreshAiUi();

  modelSelect.addEventListener('change', () => setPreferredModel(modelSelect.value));

  page.querySelectorAll('input[name="set-ai"]').forEach((r) => {
    r.checked = r.value === getProviderId();
    r.addEventListener('change', () => {
      setProviderId(r.value);
      refreshAiUi();
    });
  });
  page.querySelector('#btn-save-key').addEventListener('click', () => {
    saveKey(getProviderId(), keyInput.value);
    keyInput.value = getKey();
    page.querySelector('#key-saved').classList.remove('hidden');
    setTimeout(() => page.querySelector('#key-saved').classList.add('hidden'), 2500);
  });

  // 初始狀態（4.2.0：wordsize 的 checked 原先寫在模板裡，統一移到這裡）
  page.querySelector(`input[name="set-mode"][value="${getMode()}"]`).checked = true;
  page.querySelector(`input[name="set-font"][value="${getFontSize()}"]`).checked = true;
  page.querySelector(`input[name="set-face"][value="${getFace()}"]`).checked = true;
  page.querySelector(`input[name="set-anim"][value="${getAnim()}"]`).checked = true;
  page.querySelector(`input[name="set-autosync"][value="${getAutoSync() ? 'on' : 'off'}"]`).checked = true;
  page.querySelector(`input[name="set-syn-tent"][value="${getSynTentative() ? 'on' : 'off'}"]`).checked = true;
  page.querySelector(`input[name="wordsize"][value="${getWordSize()}"]`).checked = true;

  page.querySelectorAll('input[name="set-mode"]').forEach((r) =>
    r.addEventListener('change', () => setMode(r.value)));
  page.querySelectorAll('.accent-card').forEach((card) => {
    card.addEventListener('click', () => {
      setAccent(card.dataset.a);
      paintAccentCards(page);
    });
  });
  page.querySelectorAll('input[name="set-font"]').forEach((r) =>
    r.addEventListener('change', () => setFontSize(r.value)));
  page.querySelectorAll('input[name="set-face"]').forEach((r) =>
    r.addEventListener('change', () => setFace(r.value)));
  page.querySelectorAll('input[name="set-anim"]').forEach((r) =>
    r.addEventListener('change', () => setAnim(r.value)));
  page.querySelectorAll('input[name="set-autosync"]').forEach((r) =>
    r.addEventListener('change', () => setAutoSync(r.value === 'on')));

  paintAccentCards(page);
  page.querySelectorAll('#wordsize-grid input[name="wordsize"]').forEach((r) => {
    r.addEventListener('change', () => setWordSize(r.value));
  });

  page.querySelectorAll('input[name="set-syn-tent"]').forEach((r) =>
    r.addEventListener('change', () => setSynTentative(r.value === 'on')));

  main.replaceChildren(page);
}

// 目前選中的強調色卡高亮
function paintAccentCards(page) {
  const cur = getAccent();
  page.querySelectorAll('.accent-card').forEach((c) =>
    c.classList.toggle('on', c.dataset.a === cur));
}
