// ============================================================
// 頁面：介紹（2.1.0；3.0.1 新增更新日志；4.0.0 更新路線圖＋日志）
// 字庫統計＋開發路線圖＋版本更新日志（1.0.0 起完整記錄）
// ============================================================
import { getMeta, getWords, loadWords } from '../services/vocab.js';
import { el, escapeHtml } from '../core/ui.js';

// 版本更新日志（新版本上線時在此補一行；文字對應更新日志.txt）
const VERSION_LOG = [
  { group: '4.x', open: true, items: [
    ['5.0.0', 'AI 題庫全面接線：data/questions/ai/ 五檔 202 題（poola 綜合測驗 40＋篇章結構 24、poolb 閱讀 24＋篇章 24、poolc/b2/b3 詞彙 90，全部 GLM 逐題複核）接入四端——模擬考新增「試卷來源」切換與 AI 虛擬卷 A1/B1/V1（區段隨卷連動、答題後顯示解析）；選擇練習 AI 來源擴充（單選 98／克漏字 9 組）；配對與拼寫新增「AI 題庫出題字」範圍（AI 題正解詞 ∩ 字庫 115 字，進頁面非阻塞載入）；既有煙霧 17 支全綠（含新增 smoke_aibank_500）'],
    ['4.3.1', '練習全面升級：配對/拼寫可引用單詞本題庫＋設定畫面重排（題型由練習首頁選定，子頁改選範圍/題數/題庫來源）；選擇練習可選題庫來源（自製/歷屆真題/AI，可複選混抽）＋題數選擇＋選項單字卡查詢＋完成後新建/合併單詞本；中譯英：變化形自動還原原型查詢、答對自動標綠、空格鍵跳格、格子下劃線、AI 出題三卡同排＋題數選擇；模擬考重構：學年、卷型、卷別三層選擇（單卷）＋題型勾選（固定學測順序）＋題組完整性標示；所有練習可提前結束；全部圖示 SVG（零 emoji）'],
    ['4.2.0', '出題系統上線：歷屆真題模擬考（113/114 學測真題 727 題・五大區段・題組文章・成績報告，N 卷 OCR 題帶標記）；單選題庫擴充（+12 題含解析）；近義詞庫審核清理；例句覆蓋率提升至 99%；字庫釋義全庫重整（依 ECDICT 繁中釋義）；AI 供應商模型備援鏈（失效自動降級）；真 15 秒即時同步（變更即上傳＋雲端版本鎖，需管理員執行 420.sql 後生效）；4.1.2：新題型作答計入統計、返回鍵回練習首頁、目錄高亮、Dialog/Empty/Segmented 元件落地、介面圖示收尾'],
    ['4.1.1', '全站 Design System 統一（Soft Minimal × Material 3）：Typography Scale＋semantic 色＋focus ring＋motion tokens＋Button 三層級＋Toast/Dialog/Empty state；練習首頁 4 分類 IA（單詞卡/配對/選擇/拼寫）；新題型：配對 4 種、選擇 3 種、拼寫 3 種（Shared Translation Engine：direct-in-sentence 空格輸入）；emoji UI 圖標全面 SVG 化'],
    ['4.1.0', '反饋功能（右上按鈕進入工單，管理員於後台回復）＋字庫 AI 釋義審核合併（1,416 字，如 complex＝綜合大樓）＋查詢「標記為不會」移至單字行右側'],
    ['4.0.1', '字庫更新：考題星級（依出現次數分檔）＋考題例句（每字最多 3 句，標註來源卷）＋形近字（單詞網第一軸）；練習抽卡新增「按照星級」維度；AI 兩軸（近義字＋同詞根，經機械過濾）與中文釋義審核（1,416 字補充修正，如 complex＝綜合大樓）'],
    ['4.0.0', '界面修正與調整：練習選單文字改黑白（圖示保留強調色）／公告喇叭與排程刪除改統一線條圖標／「不會單字」移至複習頁底部／同步頁精簡為 8 碼上傳下載／使用者選單新增「賬戶」（修改密碼＋帳號雲端同步＋注銷）／個人主頁橫屏並排'],
  ]},
  { group: '3.x', open: false, items: [
    ['3.3.1', '個人主頁（學習總覽＋注銷賬號）＋註冊牆（未登入鎖定功能頁）＋後台重排＋統計折線圖'],
    ['3.3.0', '後台重設計：層級導覽／實時監控（Edge Function 用量＋線上數＋存儲量）／賬號控制（三級層級）／系統狀態'],
    ['3.2.0', '註冊制改版：16 位註冊金鑰（一碼一人強綁定，後台生成/添加）＋全新登入/註冊界面＋使用者選單（目錄移左上、右上使用者圖標）；郵箱驗證碼制隱藏保留'],
    ['3.1.1', '練習選單圖示與子標題改強調色／後台入口僅管理員可見／自動同步：登入後每 5 分鐘比對本機與雲端（本機較多自動上傳、雲端較多自動合併、互有多少時詢問），設置頁可開關'],
    ['3.1.0', '帳號系統（Email＋信箱驗證碼註冊）／帳號雲端備份與還原（8 碼快照並行）／後台管理（使用者／預設單詞本發佈／統計看板／公告）／新版自動更新'],
    ['3.0.5', '視覺效果自由調整：立體翻轉／輕柔淡入／彈性活潑三款，設置頁即時切換'],
    ['3.0.4', 'AI 多供應商：Gemini／DeepSeek／智譜自由切換（統一介面，各供應商獨立金鑰）'],
    ['3.0.3', '分層重構（core/services，路由懶載入）＋複習統計：每日任務集合式／完成率環圈／熱力圖／等級掌握度／使用說明'],
    ['3.0.2', '單詞本升級：收攏＋分組＋批量導入驗證＋瀏覽排序＋預設單詞本機制；動畫換「立體翻轉」'],
    ['3.0.1', '體感升級：豎屏練習橫條選單／單字發音鈕／深色跟隨系統／滑動換字／PWA 更新提示／介紹頁更新日志'],
    ['3.0.0', '字庫括號拆分（7106 字，衍生字補齊釋義音標片語例句）／查詢同族字連結／單字卡預設顯示面／目錄移除翻譯題／強調色去勾'],
  ]},
  { group: '2.x', open: false, items: [
    ['2.1.2', '響應式（手機單欄／橫屏雙欄）＋金鑰輸入制＋部署上線＋iOS 相容強化'],
    ['2.1.1', 'Soft Minimal UI 全面改版＋強調色五選一＋月曆格改版'],
    ['2.1.0', '版面重構：每日任務／複習月曆／設置頁／介紹頁／左上目錄'],
    ['2.0.14', '深色模式／字體三級／CSV 匯出'],
    ['2.0.13', '學習統計（練習量／答對率／階段與等級分布）'],
    ['2.0.12', 'AI 批改：逐句評分挑錯（0～4 分制）'],
    ['2.0.11', 'AI 翻譯題（一句版，雙入口）'],
    ['2.0.10', '雲端同步（Supabase 快照式，8 碼代碼）'],
    ['2.0.9', 'AI 片語／搭配詞（7005 字全覆蓋）'],
    ['2.0.8', '首頁快捷＋每日任務＋單詞本雙按鈕'],
    ['2.0.7', 'Tatoeba 例句（3915 字）'],
    ['2.0.6', 'ECDICT 釋義／音標／詞形變化（7005 字定案）'],
    ['2.0.5', 'SRS 間隔複習（1、3、7、14 天，畢業自動移出）'],
    ['2.0.4', '字表升級：108 課綱比對＋舊制補充'],
    ['2.0.3', 'PWA 化：離線快取／可安裝'],
    ['2.0.2', '查詢＋不會標記＋IndexedDB 保存'],
    ['2.0.1', '隨機練習（等級多選、不重複抽字）'],
    ['2.0.0', '網頁版專案骨架＋字庫 JSON 化'],
  ]},
  { group: '1.x', open: false, items: [
    ['1.1.6', '1.x 收尾'],
    ['1.1.5', '修復版面與單詞本練習邏輯（2.0 操作的基準版本）'],
    ['1.1.0', '練習操作成形（隨機練習／單詞本）'],
    ['1.0.0', '專案起始：學測 6000 單字桌面版'],
  ]},
];

export async function renderIntro(main) {
  await loadWords();

  const byLevel = new Map();
  for (const w of getWords()) byLevel.set(w.level, (byLevel.get(w.level) || 0) + 1);
  const levelRows = [...byLevel.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([lv, n]) => `<tr><td>${lv <= 6 ? 'Lv' + lv : 'Lv7（補充）'}</td><td>${n}</td></tr>`)
    .join('');
  const meta = getMeta();

  const logHtml = VERSION_LOG.map((g) => `
    <details class="log-group"${g.open ? ' open' : ''}>
      <summary>${g.group}</summary>
      <ul class="log-list">
        ${g.items.map(([v, text]) => `<li><span class="log-ver">${v}</span><span class="log-text">${text}</span></li>`).join('')}
      </ul>
    </details>`).join('');

  main.replaceChildren(
    el(`
      <section class="card">
        <h2>字庫統計</h2>
        <p class="muted">資料來源：${(meta.sources || [meta.source]).join('、')}｜產生日期：${meta.generated}</p>
        <p>目前共收錄 <strong>${getWords().length}</strong> 個單字</p>
        <table>
          <thead><tr><th>等級</th><th>單字數</th></tr></thead>
          <tbody>${levelRows}</tbody>
        </table>
        <p class="muted">※ Lv1–6 為官方 108 課綱範圍；Lv7 為舊制 7000 字表補充詞彙。</p>
        <p class="muted">※ 考題星級：依 113/114 學年度學測模擬考題的出現次數分檔——
          5 星＝出現 30 次以上、4 星＝15–29 次、3 星＝8–14 次、2 星＝3–7 次、1 星＝1–2 次、
          未出現不標星。考題例句與形近字資料同源（見下方更新日志 4.0.1）。</p>
      </section>`),
    el(`
      <section class="card">
        <h2>使用說明</h2>
        <ul class="doc-list">
          <li class="doc-item"><span class="doc-title">練習</span><span>隨機抽卡（選等級）、單詞本練習、中譯英。點卡片翻面，連續點兩下／長按看完整釋義，喇叭鈕朗讀，左右滑動換字。</span></li>
          <li class="doc-item"><span class="doc-title">單詞本</span><span>練習中按「加入單詞本」收字，結束時命名保存。支援分組、批量導入（貼上一串單字自動驗證）、排序與 CSV 匯出。</span></li>
          <li class="doc-item"><span class="doc-title">複習</span><span>查詢或練習時按「加入複習計劃」，字會依 1、3、7、14 天排程；每天回首頁完成「每日任務」，答對推進、答錯重來，四階段畢業。複習頁底部可管理全部「不會單字」。</span></li>
          <li class="doc-item"><span class="doc-title">每日任務</span><span>今日到期字以「複習次數」分組顯示，每組可用「調整」整組改日期。</span></li>
          <li class="doc-item"><span class="doc-title">同步</span><span>8 碼代碼雲端備份／還原；登入後每 15 秒自動同步；查詢頁存疑近義可在設置頁開關（快照式，手動上傳下載）。</span></li>
          <li class="doc-item"><span class="doc-title">賬戶</span><span>右上使用者選單進入——修改密碼、帳號雲端同步、注銷賬號。</span></li>
          <li class="doc-item"><span class="doc-title">設置</span><span>深淺色（可跟隨系統）、強調色、字體、單字卡預設顯示面、AI 供應商與金鑰。</span></li>
        </ul>
      </section>`),
    el(`
      <section class="card">
        <h2>資料來源</h2>
        <ul class="doc-list">
          <li class="doc-item"><span class="doc-title">字庫</span><span>${escapeHtml((meta.sources || [meta.source]).join('、'))}（產生日期 ${escapeHtml(meta.generated || '')}，詳見上方字庫統計）。</span></li>
          <li class="doc-item"><span class="doc-title">模擬考真題</span><span>113／114 學年度學測模擬考與聯合模考卷（本站自行數位化）。</span></li>
          <li class="doc-item"><span class="doc-title">考古題</span><span>大考中心歷屆試題（詞彙、綜合測驗、文意選填、篇章結構、閱讀測驗、中譯英、作文），取自 staresto-create（張敬欣）維護的免費題庫站 <a href="https://staresto-create.github.io/JCEE-vocab-questions/" target="_blank" rel="noopener">JCEE-vocab-questions</a>，僅作學習用途。</span></li>
          <li class="doc-item"><span class="doc-title">AI 題庫</span><span>本站以 AI 生成、經逐題人工複核的練習題（非歷屆考題）。</span></li>
          <li class="doc-item"><span class="doc-title">自製題</span><span>本站編寫的練習題（非考題、非 AI 生成）。</span></li>
        </ul>
      </section>`),
    el(`
      <section class="card">
        <h2>開發路線圖</h2>
        <ol class="roadmap">
          <li>［完成］3.0.1　體感升級：過場動畫／交互反應／發音鈕／介面統整</li>
          <li>［完成］3.0.2　單詞本升級：收攏＋分組＋批量導入＋預設單詞本</li>
          <li>［完成］3.0.3　分層重構＋複習與統計：每日任務集合式／完成率環圈／熱力圖／掌握度</li>
          <li>［完成］3.0.4　AI 多供應商（DeepSeek／智譜，內地可用）</li>
          <li>［完成］3.0.5　視覺效果三款自由切換</li>
          <li>［完成］3.1.0　帳號系統＋後台管理初版（Email 驗證碼註冊、雲端備份）</li>
          <li>［完成］3.1.1　自動同步（5 分鐘比對）＋介面修正</li>
          <li>［完成］3.2.0　金鑰註冊制＋登入/註冊新界面＋使用者選單</li>
          <li>［完成］3.3.0　後台重設計（實時監控／三級層級／賬號控制）</li>
          <li>［完成］3.3.1　個人主頁＋注銷賬號＋註冊牆＋統計折線圖</li>
          <li>［完成］4.0.0　界面修正與調整（圖標統一／不會單字移至複習／賬戶頁）</li>
          <li>［完成］4.0.1　字庫更新：考題星級／考題例句／形近詞網（近義軸・同詞根軸・釋義審核進行中）</li>
          <li>［完成］4.1.1　全站 Design System（Soft Minimal × Material 3）＋Practice 新題型（配對/選擇/拼寫＋翻譯引擎）</li>
          <li>［完成］4.0.2　後台管理完善（金鑰／在線狀態／監控／單詞本）</li>
          <li>［完成］4.0.3　安全性測試與加固</li>
          <li>5.0　趣味小遊戲</li>
        </ol>
      </section>`),
    el(`
      <section class="card">
        <h2>更新日志</h2>
        ${logHtml}
      </section>`)
  );
}
