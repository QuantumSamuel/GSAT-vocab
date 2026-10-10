// ============================================================
// 頁面：個人主頁（3.3.1 正式版；4.0.0 注銷賬號移至賬戶頁＋橫屏並排）
// 兩區：①帳號資訊（Email＋註冊日期，註冊日期來自雲端 profiles）
//        ②本機學習統計（複習計劃／單詞本／練習統計，全部來本機 IndexedDB）
// 【關聯註記】本機統計不讀雲端、雲端也不回讀——兩邊各自獨立，
//   換機或注銷都不影響本機資料；注銷流程在賬戶頁（account.js）
// ============================================================
import { getUser, restFetch } from '../services/auth.js';
import { getEvents, getUnknownMarks, getWordbooks, srsIntervals } from '../services/store.js';
import { el, escapeHtml } from '../core/ui.js';

export async function renderProfile(main) {
  const user = getUser();
  if (!user) { location.hash = '#/auth?tab=login'; return; }

  main.replaceChildren(el(`
    <div class="profile-layout">
      <section class="card">
        <h2>個人主頁</h2>
        <div class="prop-list">
          <div class="prop-row"><span class="prop-k">Email</span><span class="prop-v">${escapeHtml(user.email || '')}</span></div>
          <div class="prop-row"><span class="prop-k">註冊日期</span><span class="prop-v muted" id="pf-regdate">載入中…</span></div>
          <div class="prop-row"><span class="prop-k">資料位置</span><span class="prop-v">本機瀏覽器（IndexedDB）</span></div>
        </div>
      </section>
      <section class="card">
        <h2>學習總覽</h2>
        <p class="notice-bar">以下數據只存在這台裝置，不會上傳。</p>
        <div id="pf-stats"><p class="muted">載入中…</p></div>
      </section>
    </div>`));

  loadRegDate(user.id);
  loadStats(main.querySelector('#pf-stats'));
}

// ---------- ① 帳號：註冊日期（雲端 profiles） ----------
async function loadRegDate(uid) {
  const box = document.getElementById('pf-regdate');
  if (!box) return;
  // 只填右欄的值（.prop-v），標籤「註冊日期」在模板裡，不重複輸出
  try {
    const rows = await restFetch(`profiles?select=created_at&id=eq.${uid}`);
    const created = rows?.[0]?.created_at;
    box.textContent = created ? String(created).slice(0, 10) : '查無資料';
    box.classList.toggle('muted', !created);
  } catch {
    box.textContent = '無法取得（離線或尚未設定雲端）';
  }
}

// ---------- ② 學習總覽（全本機；IndexedDB 讀取失敗不影響其他區） ----------
const fmtInt = (n) => Number(n || 0).toLocaleString('zh-TW');

async function loadStats(box) {
  if (!box) return;
  try {
    const [marks, books, events] = await Promise.all([
      getUnknownMarks(),
      getWordbooks(),
      getEvents(),
    ]);

    // 複習計劃：各 stage 字數（srsIntervals() 索引＝stage；畢業者已移出清單）
    const stageIntervals = srsIntervals();
    const stageCounts = new Array(stageIntervals.length).fill(0);
    for (const m of marks) {
      const s = Number(m.stage) || 0;
      if (s >= 0 && s < stageCounts.length) stageCounts[s]++;
    }
    const stageNote = stageIntervals.map((d, i) => `${d}天 ${stageCounts[i]}`).join('｜');

    // 單詞本：本數＋總字數
    const bookWords = books.reduce((sum, b) => sum + (Array.isArray(b.wordIds) ? b.wordIds.length : 0), 0);

    // 練習統計：練習卡／複習次數／答對率／翻譯題
    let cards = 0, reviews = 0, good = 0, translate = 0, graduated = 0;
    for (const ev of events) {
      if (ev.type === 'card') cards++;
      else if (ev.type === 'review') { reviews++; if (ev.extra === true) good++; }
      else if (ev.type === 'translate') translate++;
      else if (ev.type === 'graduate') graduated++;
    }
    const rate = reviews ? Math.round(good / reviews * 100) : 0;

    box.replaceChildren(el(`
      <div class="pf-stats-grid">
        <div class="pf-block">
          <h3>複習計劃</h3>
          <p>總計 <strong>${fmtInt(marks.length)}</strong> 字</p>
          <p class="muted small">各階段：${stageNote}</p>
          <p class="muted small">已畢業 <strong>${fmtInt(graduated)}</strong> 字（答對推進到最後一階段後自動移出）</p>
        </div>
        <div class="pf-block">
          <h3>單詞本</h3>
          <p><strong>${fmtInt(books.length)}</strong> 本｜共 <strong>${fmtInt(bookWords)}</strong> 字</p>
        </div>
        <div class="pf-block">
          <h3>練習統計</h3>
          <p>練習卡 <strong>${fmtInt(cards)}</strong> 次｜翻譯題 <strong>${fmtInt(translate)}</strong> 次</p>
          <p>複習 <strong>${fmtInt(reviews)}</strong> 次｜答對率 <strong>${rate}%</strong>（${fmtInt(good)}／${fmtInt(reviews)}）</p>
        </div>
      </div>`));
  } catch (err) {
    box.replaceChildren(el(`<p class="warning">統計載入失敗：${escapeHtml(String(err.message || err))}</p>`));
  }
}
