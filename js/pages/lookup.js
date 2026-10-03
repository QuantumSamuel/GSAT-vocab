// ============================================================
// 頁面：單字查詢（2.0.2 起；2.0.6 詳細字卡；2.0.7 例句）
// 查字 → 顯示等級/音標/釋義/詞形變化/例句 → 可標記/取消「不會」
// 查不到時提供相近字建議
// 4.3.0：字卡重排——頭部 .word-header（Lv／星級徽章＋單字與音標同行，不顯示詞性）、
//   移除與 dict 重複的 .senses 清單、AI 審核義項併入 .dict-senses、
//   考題例句改用與例句相同的 .example 結構（出處標在 .example-source）
// ============================================================
import { examStarCount,getCollocationsFor,getSentencesFor,getWords,loadCollocations,loadExam,loadSentences,loadWords } from '../services/vocab.js';
import { getUnknownIds, markUnknown, unmarkUnknown } from '../services/store.js';
import { el, escapeHtml, ICONS, iconInline, phoneticPretty, speakBtn, starsSvg } from '../core/ui.js';
import { idIndex, suggestions, wordIndex } from '../services/search.js';
import { getSynTentative } from '../services/settings.js';

export async function renderLookup(main) {
  await loadWords();

  const page = el(`
    <section class="card">
      <div class="search-row">
        <input type="text" id="lookup-input" placeholder="輸入英文單字，按 Enter 查詢"
               autocomplete="off" spellcheck="false">
        <button class="btn primary" id="btn-search">查詢</button>
      </div>
      <p class="warning" id="lookup-warning"></p>
      <div id="lookup-result"></div>
    </section>`);

  const input = page.querySelector('#lookup-input');
  const resultBox = page.querySelector('#lookup-result');
  const warn = page.querySelector('#lookup-warning');

  // 頁面內任何位置按 Enter 都能查詢（輸入框自己已處理，這裡處理焦點在外的情況）
  page.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (document.activeElement === input) return; // 輸入框自己會查
    if (e.target.matches('textarea, button, a, select')) return;
    e.preventDefault();
    search();
  });

  async function search() {
    const q = input.value.trim().toLowerCase();
    warn.textContent = '';
    if (!q) {
      warn.textContent = '請輸入英文單字';
      resultBox.replaceChildren();
      return;
    }
    const word = wordIndex().get(q);
    if (word) {
      await showWord(word);
    } else {
      const cands = suggestions(q);
      const list = cands.length
        ? cands.map((c) => `<button class="suggestion" data-word="${c}">${c}</button>`).join('')
        : '<span class="muted">沒有相近的字</span>';
      resultBox.replaceChildren(el(`
        <div class="lookup-miss">
          <p>字庫裡沒有「${escapeHtml(q)}」，相近的字：</p>
          <div class="suggestion-list">${list}</div>
        </div>`));
      resultBox.querySelectorAll('button.suggestion').forEach((b) => {
        b.addEventListener('click', () => {
          input.value = b.dataset.word;
          search();
          input.focus(); // 焦點回輸入框，繼續用 Enter 查下一個字
        });
      });
    }
  }

  async function showWord(word) {
    const marked = (await getUnknownIds()).has(word.id);
    await loadSentences();
    await loadCollocations();
    // 4.0.1：考題資料（星級／考題例句／形近字／AI 釋義審核）— exam.json 懶載入；
    // 離線或載入失敗時 loadExam 回空殼，對應區塊自然不顯示。
    const exam = await loadExam();
    const wl = word.word.toLowerCase();

    // 片語/搭配詞（2.0.9；AI 生成，涵蓋率隨批次腳本推進而增加）
    const cols = getCollocationsFor(word.id);
    const colBlock = cols.length ? `
      <div class="collocations">
        <div class="collocations-title">片語與搭配詞</div>
        ${cols.map((c) => `
          <div class="col-item">
            <span class="col-p">${escapeHtml(c.p)}</span>
            <span class="col-zh">${escapeHtml(c.zh)}</span>
          </div>`).join('')}
      </div>` : '';

    // 例句與考題例句共用同一組規則（4.3.0）：高亮目標字＋.example 結構
    const hlRe = new RegExp(`\\b${word.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\w*`, 'gi');
    const hl = (s) => escapeHtml(s).replace(hlRe, (m0) => `<mark class="ex-hl">${m0}</mark>`);
    // 一句例句＝.example-en（英文，目標字高亮）＋.example-zh（中譯）＋選填 .example-source（出處小徽章）
    const renderExample = (en, zh, source = '') => `
      <div class="example">
        <div class="example-en">${hl(en)}</div>
        ${zh ? `<div class="example-zh">${escapeHtml(zh)}</div>` : ''}
        ${source ? `<div class="example-source">${escapeHtml(source)}</div>` : ''}
      </div>`;

    // 例句（2.0.7；Tatoeba，CC-BY 2.0）
    const sents = getSentencesFor(word.id);
    const sentBlock = sents.length ? `
      <div class="examples">
        <div class="examples-title">例句</div>
        ${sents.map((s) => renderExample(s.en, s.zh)).join('')}
      </div>` : '';

    // 考題例句（4.0.1）：4.3.0 改用與例句完全相同的 .example 結構——
    // 原本的 <ul class="exam-sent-list"> 把出處、英文、中譯擠一行，長句折行很難讀。
    // 出處保留，另以 .example-source 小徽章標在句尾（不再混在句首）。
    const exSents = exam.examSentences[String(word.id)] || [];
    const zhMap = exam.sentenceZh || {};
    const examBlock = exSents.length ? `
      <div class="examples">
        <div class="examples-title">考題例句（113/114 模擬考）</div>
        ${exSents.map((item) => {
          const raw = String(item);
          const cut = raw.indexOf('】');
          const [tag, en] = cut === -1 ? ['', raw] : [raw.slice(0, cut + 1), raw.slice(cut + 1)];
          // 出處徽章去掉【】外框（tag 形如【113E1英語-題目】→ 113E1英語-題目），語意不變但更好讀
          const source = tag ? tag.replace(/^【|】$/g, '') : '';
          return renderExample(en, zhMap[en] || zhMap[raw] || '', source);
        }).join('')}
      </div>` : '';

    // ECDICT 詳細釋義（2.0.6；已轉台灣繁體）＋4.3.0：AI 審核補充的義項併入同一區塊
    // 原本另有「釋義補充（AI 審核）」獨立區塊，與此處資訊重複，故併為同一個 .dict-senses；
    // 兩個來源以行首的 .dict-ai-tag 小標區隔。senseFix（修正提示）不再顯示，資料仍在 exam.json。
    // 只有 AI add、沒有 dictSenses 的字也要照樣輸出此區塊。
    const senseAddList = (exam.sensesReview[wl] || {}).add || [];
    const dictRows = (word.dictSenses || []).filter((s) => !/^<.+>$/.test(String(s).trim()));
    const dictBlock = (dictRows.length || senseAddList.length) ? `
      <div class="dict-senses">
        ${dictRows.map((s) => `<div class="dict-row">${escapeHtml(s)}</div>`).join('')}
        ${senseAddList.map((s) => `<div class="dict-row dict-row--ai"><span class="dict-ai-tag">AI 補充</span>${escapeHtml(s)}</div>`).join('')}
      </div>` : '';

    // 詞形變化表（三態／複數／比較級）
    const tense = word.tense;
    const tenseRows = tense ? [
      tense.s && ['三單', tense.s],
      tense.past && ['過去式', tense.past],
      tense.pp && tense.pp !== tense.past && ['過去分詞', tense.pp],
      tense.ing && ['現在分詞', tense.ing],
    ].filter(Boolean) : [];
    const tenseBlock = tenseRows.length ? `
      <div class="tense-table"><table>
        <tbody>${tenseRows.map(([k, v]) => `<tr><th>${k}</th><td>${escapeHtml(v)}</td></tr>`).join('')}</tbody>
      </table></div>` : '';

    // 4.0.1：考題例句已在上面組好；形近字（exam.json 查無資料時整區隱藏）
    const lookalikes = exam.lookalikes[wl] || [];
    const lookBlock = lookalikes.length ? `
      <div class="collocations">
        <div class="collocations-title">形近字</div>
        <div class="suggestion-list">${lookalikes.map((x) =>
          `<button class="suggestion" data-word="${escapeHtml(x)}">${escapeHtml(x)}</button>`).join('')}</div>
      </div>` : '';

    // 4.0.1：單詞網另外兩軸（近義／同詞根，AI 產出經機械過濾）
    const syns = exam.synonyms[wl] || [];
    const rootInfo = exam.roots[wl] || null;
    const synBlock = syns.length ? `
      <div class="collocations">
        <div class="collocations-title">近義字</div>
        <div class="suggestion-list">${syns.map((x) =>
          `<button class="suggestion" data-word="${escapeHtml(x)}">${escapeHtml(x)}</button>`).join('')}</div>
      </div>` : '';
    // 4.2.0：存疑近義（AI 判讀、帶標註）——依設置開關顯示，用戶端可自行剔除
    const synTent = (getSynTentative() && exam.synonymsTentative[wl]) || [];
    const synTentBlock = synTent.length ? `
      <div class="collocations">
        <div class="collocations-title">存疑近義（AI 判讀，僅供參考；可在設置頁關閉）</div>
        <div class="suggestion-list">${synTent.map((x) =>
          `<button class="suggestion" data-word="${escapeHtml(x)}" title="存疑條目：語意部分重疊，依字庫釋義判讀未完全成立">${iconInline(ICONS.warnTriangle, 13)}<span>${escapeHtml(x)}</span></button>`).join('')}</div>
      </div>` : '';
    const rootBlock = rootInfo && rootInfo.kin.length ? `
      <div class="collocations">
        <div class="collocations-title">同詞根（${escapeHtml(rootInfo.family)}）</div>
        <div class="suggestion-list">${rootInfo.kin.map((x) =>
          `<button class="suggestion" data-word="${escapeHtml(x)}">${escapeHtml(x)}</button>`).join('')}</div>
      </div>` : '';
    // 4.3.0：「釋義補充（AI 審核）」獨立區塊已移除，AI 義項改併入上方 dictBlock

    // 同族字（3.0.0）：母字↔衍生字互相顯示並提供入口
    const fam = (word.family || []).map((id) => idIndex().get(id)).filter(Boolean);
    const famBlock = fam.length ? `
      <div class="collocations">
        <div class="collocations-title">同族字</div>
        <div class="suggestion-list">${fam.map((f) =>
          `<button class="suggestion" data-word="${escapeHtml(f.word)}">${escapeHtml(f.word)}（Lv${f.level}）</button>`).join('')}</div>
      </div>` : '';

    const stars = examStarCount(word);
    // 4.3.0：單字頭部重排——上方一列標籤（Lv 徽章＋考題星級），下方一列大字單字＋音標同行。
    // 原本 .kv 四列定義列表（Lv/星級/音標/詞性＋單字）資訊密度低、要捲很久才看到字；
    // 詞性（pos）整列移除，ECDICT 的 dictSenses 每列本身已帶 n./a. 詞性標記。
    resultBox.replaceChildren(el(`
      <div class="word-detail">
        <div class="word-header">
          <div class="word-badges">
            <span class="badge lv${word.level}">${word.level <= 6 ? 'Lv' + word.level : '補充'}</span>
            ${stars
              ? `<span class="badge exam-badge stars" aria-label="考題星級 ${stars} 星">${starsSvg(stars, 11)}</span>`
              : '<span class="muted tp-caption">未出現於考題</span>'}
          </div>
          <div class="word-main">
            <span class="word-en tp-word-en">${escapeHtml(word.word)}</span>
            ${word.phonetic ? `<span class="word-phonetic">/${escapeHtml(phoneticPretty(word.phonetic))}/</span>` : ''}
          </div>
        </div>
        <div class="word-actions">
          ${speakBtn(word.word)}
          <button class="btn btn-mark-top ${marked ? 'marked' : ''}" id="btn-mark"
                  aria-label="${marked ? '取消標記不會' : '標記為不會'}">
            ${marked ? ICONS.star : ICONS.starOutline} ${marked ? '已標記不會' : '標記為不會'}
          </button>
        </div>
        ${dictBlock}
        ${tenseBlock}
        ${famBlock}
        ${lookBlock}
        ${synBlock}
        ${synTentBlock}
        ${rootBlock}
        ${colBlock}
        ${sentBlock}
        ${examBlock}
      </div>`));

    resultBox.querySelector('#btn-mark').addEventListener('click', async () => {
      const nowMarked = !(await getUnknownIds()).has(word.id);
      if (nowMarked) await markUnknown(word.id);
      else await unmarkUnknown(word.id);
      await showWord(word); // 重新繪製按鈕狀態
    });

    // 同族字點擊 → 直接查該字
    resultBox.querySelectorAll('.suggestion[data-word]').forEach((b) => {
      b.addEventListener('click', () => {
        input.value = b.dataset.word;
        search();
      });
    });
  }

  page.querySelector('#btn-search').addEventListener('click', search);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') search();
  });

  main.replaceChildren(page);
  input.focus();
}

