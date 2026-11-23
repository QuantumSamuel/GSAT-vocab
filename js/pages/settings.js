import { mountDailyLoadControls } from '../services/daily-load-controls.js';
// ============================================================
// 頁面：設置（2.1.1）——統合個性化設定
// 基本色調（淺色/深色）× 強調色（藍/橘/綠/粉/灰）、字體大小、翻譯題預設題數
// ============================================================
import {
  ACCENTS, accentDot, getAnim, getAccent, getAutoSync, getFace, getFlipSpeak, getFontSize, getMode,
  getReviewStrength, REVIEW_STRENGTHS, setFlipSpeak, setReviewStrength, getSrsAlgorithm, getFsrsRetention, setSrsAlgorithm, setFsrsRetention,
  getWordSize, setWordSize, setAccent, setAnim, setAutoSync, setFace, setFontSize, setMode,
  getPresets, savePreset, applyPreset, deletePreset, getDailyNewLimit, setDailyNewLimit } from '../services/settings.js';
import { el, safeErrorText, logError } from '../core/ui.js';
import { getKey, getProviderId, listProviders, saveKey, setProviderId } from '../services/ai/index.js';
import { getPreferredModel, setPreferredModel } from '../services/ai/gemini.js';
import { replayOnboarding } from '../core/onboarding.js';
import { proGateStatus } from '../services/pro-gate.js';
import { proStatus, proRedeem } from '../services/pro-api.js';

let settingsGeneration = 0;

export async function renderSettings(main) {
  const gen = ++settingsGeneration;
  // 6.3.0 Pro 閘：FSRS 複習引擎屬 8 項 Pro。無有效 Pro → FSRS 節顯示「正在開發中」並停用，
  // 其餘免費設定（色調/字體/複習強度/發音/同步/AI 金鑰）維持可用。
  const gate = await proGateStatus('fsrs_review', proStatus);
  if (gen !== settingsGeneration) return;
  const fsrsLocked = gate.state !== 'available';
  // 6.3.0：Pro 權益現況（兌換卡顯示）。查詢失敗＝後端未就緒，如實顯示（無 Pro 呈現）。
  let proNow = null;
  try {
    proNow = await proStatus();
    if (gen !== settingsGeneration) return;
  } catch { proNow = null; }
  const hasPro = Boolean(proNow?.hasPro);
  const proPlanText = proNow?.plan === 'permanent' ? 'Pro・永久'
    : proNow?.expiresAt ? `Pro・限期至 ${new Date(proNow.expiresAt).toLocaleDateString()}` : '';
  const proStatusText = hasPro
    ? `<strong class="text-good">${proPlanText}</strong>`
    : (proNow === null ? 'Pro 服務尚未就緒（後端 Edge 部署後可用）' : '尚未啟用 Pro');

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

      <!-- 6.3.0：Pro 權益＋兌換碼輸入（裁決：Pro 8 功能全 Pro；兌換入口在此） -->
      <div class="settings-group pro-redeem-group">
        <h3>Pro 權益</h3>
        <p class="muted small">Pro 功能共 8 項（2026-10-22 裁決）：詞彙診斷、每日任務、短複測、模擬考、翻譯題、AI 週報、FSRS 複習引擎、模擬考真題全卷；未升級時顯示「正在開發中」。</p>
        <p class="pro-status-line" id="pro-status-line">${proStatusText}</p>
        <div class="import-row">
          <input type="text" id="pro-redeem-code" class="input-shared" placeholder="輸入 Pro 兌換碼（向管理員索取）" autocomplete="off" spellcheck="false" maxlength="40">
          <button class="btn primary" id="btn-pro-redeem">兌換</button>
        </div>
        <p class="muted small" id="pro-redeem-note"></p>
      </div>

      <div class="settings-group">
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
      </div>

      <div class="settings-group">
      <div id="daily-load-settings"></div>

      <h3>複習強度</h3>
      <p class="muted small">決定「不會單字」複習的間隔天數。變更後新排的題目立刻套用，已經排好的到期日不會更動。</p>
      ${seg('set-strength', REVIEW_STRENGTHS.map((x) => [x.id, `${x.name}（${x.intervals.join('/')} 天）`]), 'strength-grid')}
      <p class="muted small" id="strength-note"></p>

      <h3>FSRS 排程</h3>
      <p class="muted small">預設關閉。開啟後「新加入」複習計劃的字改用 FSRS 6；已加入的字仍沿用加入時的引擎，切換不會重寫既有到期日。</p>
      <div class="segmented" id="srs-algorithm-grid">
        <label><input type="radio" name="set-srs-algorithm" value="fixed"><span>固定排程</span></label>
        <label><input type="radio" name="set-srs-algorithm" value="fsrs6"${fsrsLocked ? ' disabled' : ''}><span>FSRS 6（新字）${fsrsLocked ? '・Pro' : ''}</span></label>
      </div>
      <label class="range-row" for="set-fsrs-retention">
        <span>目標保留率：<strong id="fsrs-retention-value">90%</strong></span>
        <input id="set-fsrs-retention" type="range" min="1" max="99" step="1" value="90"${fsrsLocked ? ' disabled' : ''}>
      </label>
      <p class="muted small">滑桿整數 1～99。保留率越高通常複習越頻繁；目前固定強度選項仍保留。</p>
      ${fsrsLocked ? '<p class="pro-gate-badge">FSRS 複習引擎屬 Pro 功能（2026-10-22 裁決）：未升級時顯示「正在開發中」。</p>' : ''}
      </div>

      <div class="settings-group">
        <h3>選項群組（Preset）</h3>
        <p class="muted small">把上面的演算法、目標保留率與複習強度存成一組，之後一鍵套用。只改本機設定，不動任何卡片的到期日。</p>
        <div class="row-inline">
          <input id="preset-name" class="input-shared" type="text" maxlength="24" placeholder="名稱（例：考前衝刺）">
          <button class="btn" id="preset-save" type="button">存成 preset</button>
        </div>
        <div id="preset-list"></div>
        <p class="muted small" id="preset-note" aria-live="polite"></p>
      </div>

      <div class="settings-group">
      <h3>翻面自動發音</h3>
      <p class="muted small">抽卡翻面（中文面翻成英文）的瞬間自動朗讀該單字，不用另外按發音鈕。</p>
      ${seg('set-flip-speak', [['off', '關閉'], ['on', '開啟']])}

      <h3>資料自動同步（需登入帳號）</h3>
      <p class="muted small">登入後每 15 秒（畫面關閉時暫停）比對本機與雲端備份：本機較多時自動上傳、雲端較多時自動合併；互有多少時會詢問你。</p>
      ${seg('set-autosync', [['on', '開啟'], ['off', '關閉']])}

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
        <select id="set-gemini-model" class="select-flex" aria-label="AI 模型（自動或指定型號）">
          <option value="">模型：自動（失效自動換備援，建議）</option>
          <option value="gemini-flash-lite-latest">gemini-flash-lite-latest</option>
          <option value="gemini-3.1-flash-lite">gemini-3.1-flash-lite</option>
          <option value="gemini-2.5-flash-lite">gemini-2.5-flash-lite</option>
        </select>
      </div>

      <h3>新手教程</h3>
      <p class="muted small">第一次進站時會有五步導引（本站是什麼、學習、複習排程、查詢與單詞本）。</p>
      <div class="controls">
        <button class="btn" id="btn-replay-onboarding">重看新手教程</button>
      </div>
      </div>

      <p class="finish">設定立即生效並自動保存。</p>
    </section>`);

  mountDailyLoadControls(page.querySelector('#daily-load-settings'));

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
  page.querySelector(`input[name="set-strength"][value="${getReviewStrength()}"]`).checked = true;
  page.querySelector(`input[name="set-srs-algorithm"][value="${getSrsAlgorithm()}"]`).checked = true;
  page.querySelector(`input[name="set-flip-speak"][value="${getFlipSpeak() ? 'on' : 'off'}"]`).checked = true;
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

  // ---- 5.0.x 複習強度／翻面自動發音 ----
  // 強度切換後立刻把「目前設定的天數」寫出來：使用者最想確認的就是「會變成幾天」，
  // 而天數的定義在 services/settings.js（唯一來源），這裡只是把同一份值顯示出來。
  const strengthNote = page.querySelector('#strength-note');
  const paintStrength = () => {
    const cur = REVIEW_STRENGTHS.find((x) => x.id === getReviewStrength());
    if (!strengthNote || !cur) return;
    const vs = REVIEW_STRENGTHS.map((x) => `${x.name} ${x.intervals.join('/')} 天`).join('　｜　');
    strengthNote.textContent = `目前：${cur.name}（${cur.intervals.join('/')} 天）。三段對照：${vs}。`;
  };
  paintStrength();
  page.querySelectorAll('input[name="set-strength"]').forEach((r) =>
    r.addEventListener('change', () => { setReviewStrength(r.value); paintStrength(); }));
  page.querySelectorAll('input[name="set-srs-algorithm"]').forEach((r) =>
    r.addEventListener('change', () => setSrsAlgorithm(r.value)));

  // 7.2.0：Preset 選項群組（Anki 借鑑）—— 存一組三個旋鈕、一鍵套用
  const presetList = page.querySelector('#preset-list');
  const presetNote = page.querySelector('#preset-note');
  const paintPresets = () => {
    if (!presetList) return;
    const list = getPresets();
    presetList.innerHTML = list.length
      ? list.map((x) => `<div class="preset-row" data-name="${String(x.name).replace(/"/g, '&quot;')}">
          <span class="preset-label">${x.name}<small class="muted">（${x.values.algorithm === 'fsrs6' ? 'FSRS6' : '固定'}・${Math.round(x.values.retention * 100)}%・${x.values.strength}）</small></span>
          <span class="preset-acts"><button class="btn subtle" data-act="apply" type="button">套用</button><button class="btn subtle" data-act="del" type="button">刪除</button></span>
        </div>`).join('')
      : '<p class="muted small">還沒有 preset。</p>';
  };
  const limitInput = page.querySelector('#daily-limit');
  const limitNote = page.querySelector('#daily-limit-note');
  if (limitInput) {
    const show = (v) => {
      limitInput.value = String(v);
      if (limitNote) limitNote.textContent = v === 0 ? '目前：不限（新字標多少給多少）' : '目前：每天最多 ' + v + ' 個新字（超過的排到兩天後）';
    };
    show(getDailyNewLimit());
    page.querySelectorAll('#daily-limit-quick button').forEach((b) => b.addEventListener('click', () => {
      show(setDailyNewLimit(b.dataset.v));
    }));
    limitInput.addEventListener('input', () => {
      const v = Number(limitInput.value) || 0;
      if (limitNote) limitNote.textContent = v === 0 ? '目前：不限（放開即儲存）' : '目前：每天最多 ' + v + ' 個新字（放開即儲存）';
    });
    limitInput.addEventListener('change', () => {
      show(setDailyNewLimit(limitInput.value));
    });
    page.querySelector('#daily-limit-save')?.addEventListener('click', () => {
      show(setDailyNewLimit(limitInput.value));
    });
  }

  page.querySelector('#preset-save')?.addEventListener('click', () => {
    try {
      savePreset(page.querySelector('#preset-name').value);
      page.querySelector('#preset-name').value = '';
      if (presetNote) presetNote.textContent = '已儲存';
      paintPresets();
    } catch { if (presetNote) presetNote.textContent = '操作失敗，請重試'; }
  });
  presetList?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const name = btn.closest('.preset-row')?.dataset.name || '';
    try {
      if (btn.dataset.act === 'apply') {
        applyPreset(name);
        paintStrength();
        paintFsrsRetention();
        page.querySelectorAll('input[name="set-srs-algorithm"]').forEach((r) => { r.checked = r.value === getSrsAlgorithm(); });
        if (presetNote) presetNote.textContent = `已套用「${name}」`;
      } else {
        deletePreset(name);
        paintPresets();
        if (presetNote) presetNote.textContent = `已刪除「${name}」`;
      }
    } catch { if (presetNote) presetNote.textContent = '操作失敗，請重試'; }
  });
  paintPresets();

  const fsrsRetentionInput = page.querySelector('#set-fsrs-retention');
  const fsrsRetentionValue = page.querySelector('#fsrs-retention-value');
  const paintFsrsRetention = () => {
    const pct = Math.round(getFsrsRetention() * 100);
    if (fsrsRetentionInput) fsrsRetentionInput.value = String(pct);
    if (fsrsRetentionValue) fsrsRetentionValue.textContent = `${pct}%`;
  };
  paintFsrsRetention();
  if (!fsrsLocked) {
    // Pro 可用時才綁 FSRS 互動；鎖定（無 Pro）時 input disabled，維持「正在開發中」。
    fsrsRetentionInput?.addEventListener('input', () => {
      const raw = Number(fsrsRetentionInput.value);
      if (!Number.isFinite(raw)) { paintFsrsRetention(); return; }
      // 滑桿整數 1～99，對應有效保留率 0 < r < 1；顯示實際保存值。
      const pct = Math.min(99, Math.max(1, Math.round(raw)));
      setFsrsRetention(pct / 100);
      fsrsRetentionInput.value = String(pct);
      fsrsRetentionValue.textContent = `${pct}%`;
    });
  }

  page.querySelectorAll('input[name="set-flip-speak"]').forEach((r) =>
    r.addEventListener('change', () => setFlipSpeak(r.value === 'on')));

  // ---- 5.1.0 新手教程：重看（清旗標＋立刻重播，不重新載入頁面）----
  // 放在設置頁而不是介紹頁：設定頁是「已用過的人」會回去找的地方，
  // 而導引就是給已用過的人重看的；介紹頁是給第一次來的人看的，那時還沒看過教程。
  page.querySelector('#btn-replay-onboarding').addEventListener('click', () => replayOnboarding());

  // 6.3.0：Pro 兌換碼輸入（裁決：兌換入口在此）。後端未就緒時如實顯示失敗，不假裝成功。
  page.querySelector('#btn-pro-redeem').addEventListener('click', async () => {
    const codeInput = page.querySelector('#pro-redeem-code');
    const note = page.querySelector('#pro-redeem-note');
    const btn = page.querySelector('#btn-pro-redeem');
    const code = (codeInput?.value || '').trim();
    note.textContent = '';
    if (!code) { note.textContent = '請輸入 Pro 兌換碼'; return; }
    btn.disabled = true;
    try {
      const res = await proRedeem(code);
      if (res?.hasPro) {
        note.textContent = '兌換成功：Pro 已啟用。';
        note.className = 'muted small text-good';
        codeInput.value = '';
        setTimeout(() => renderSettings(main), 600); // 重新渲染，讓 FSRS 節解鎖
      } else {
        note.textContent = '兌換未生效（後端未回傳 Pro），請稍後重試。';
        note.className = 'muted small warning';
      }
    } catch (err) {
      logError('settings.redeem', err);
      note.textContent = '兌換失敗：' + safeErrorText(err, '請稍後重試');
      note.className = 'muted small warning';
    } finally {
      btn.disabled = false;
    }
  });

  main.replaceChildren(page);
}

// 目前選中的強調色卡高亮
function paintAccentCards(page) {
  const cur = getAccent();
  page.querySelectorAll('.accent-card').forEach((c) =>
    c.classList.toggle('on', c.dataset.a === cur));
}
