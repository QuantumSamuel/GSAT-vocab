// 自製題組頁（7.4.0，2026-11-24）：貼文字 → 克漏字 → 存本機
//
// 權限：Pro 限定（teacher 角色待 7.5 P1 建立後再加）。
// 不上雲：題庫只存本機 localStorage，介面明示「僅供個人練習」。
import { el, escapeHtml } from '../core/ui.js';
import { proGateStatus } from '../services/pro-gate.js';
import { proStatus } from '../services/pro-api.js';
import { loadWords } from '../services/vocab.js';
import { buildCloze, readBank, saveBankEntry, deleteBankEntry, checkAnswer, progressOf } from '../services/make-quiz.js';
import { extractQuestions } from '../services/extract-quiz.js';
import { extractPdfText } from '../services/pdf-text.js';
import { ocrPdfFile, OCR_PAGE_LIMIT } from '../services/ocr.js';

export async function renderMake(main) {
  const gate = await proGateStatus('make_quiz', proStatus);
  if (gate.state !== 'available') {
    main.replaceChildren(el(`
      <section class="page make-page">
        <h2>自製題組</h2>
        <p class="muted small">把教材貼進來，系統依字庫挑字挖空成四選一克漏字。答案取自原文、可重現，不需要 AI。</p>
        <div class="gate-card">
          <h3>此功能為 Pro／教師功能</h3>
          <p class="muted small">目前狀態：${escapeHtml(gate.reason || gate.state)}。題庫只會存在你自己的裝置，不上傳、不分享。</p>
          <a class="btn" href="#/pro">了解 Pro</a>
        </div>
      </section>`));
    return;
  }

  const words = await loadWords();
  let pending = [];

  main.replaceChildren(el(`
    <section class="page make-page">
      <h2>自製題組</h2>
      <p class="muted small">貼上課文或文章 → 選等級範圍 → 產生克漏字。答案一律取自原文，干擾項取自同詞性、相近等級的字。<strong>只存本機，不上雲、不分享。</strong></p>
      <textarea id="make-text" class="input-shared" rows="8" placeholder="貼上教材內容（英文段落）…"></textarea>
      <div class="row-inline">
        <label>等級 <input id="make-min" type="number" min="1" max="7" value="1" class="input-shared" style="width:4.5rem"></label>
        <label>到 <input id="make-max" type="number" min="1" max="7" value="6" class="input-shared" style="width:4.5rem"></label>
        <label>最多 <input id="make-max-items" type="number" min="3" max="20" value="10" class="input-shared" style="width:4.5rem"> 題</label>
        <label class="btn subtle" for="make-pdf">從 PDF 取字</label>
        <input id="make-pdf" type="file" accept="application/pdf,.pdf" hidden>
        <button class="btn primary" id="make-run" type="button">產生克漏字</button>
        <button class="btn" id="make-extract" type="button">提取既有題目</button>
      </div>
      <p class="muted small" id="make-note" aria-live="polite"></p>
      <div id="make-preview"></div>
      <div class="row-inline" id="make-actions" hidden>
        <input id="make-title" class="input-shared" type="text" maxlength="40" placeholder="題組名稱（例：第三課課文）">
        <button class="btn primary" id="make-save" type="button">存進本機題庫</button>
      </div>
      <h3>本機題庫</h3>
      <div id="make-bank"></div>
      <div id="bank-practice" hidden></div>
    </section>`));

  const note = main.querySelector('#make-note');
  const preview = main.querySelector('#make-preview');
  const actions = main.querySelector('#make-actions');

  // 7.4.1：本機題庫練習（四選一，只在本機）
  const startPractice = (entry) => {
    const host = main.querySelector('#bank-practice');
    let idx = 0; let right = 0;
    const drawStep = () => {
      const p = progressOf(entry.items.length, idx);
      if (p.done) {
        host.innerHTML = '<p><strong>' + escapeHtml(entry.title) + '</strong>：' + entry.items.length + ' 題，答對 ' + right + ' 題。</p>'
          + '<button class="btn" id="bank-again" type="button">再練一次</button>';
        host.querySelector('#bank-again').addEventListener('click', () => { idx = 0; right = 0; drawStep(); });
        return;
      }
      const it = entry.items[idx];
      host.innerHTML = '<p class="muted small">' + escapeHtml(entry.title) + '　第 ' + (p.index + 1) + ' / ' + p.total + ' 題</p>'
        + '<p>' + escapeHtml(it.sentence.replace(new RegExp(it.word, 'i'), '______')) + '</p>'
        + '<div class="row-inline">' + it.options.map((o) => '<button class="btn opt" type="button" data-o="' + escapeHtml(o) + '">' + escapeHtml(o) + '</button>').join('') + '</div>'
        + '<p class="muted small" id="bank-fb" aria-live="polite"></p>';
      host.querySelectorAll('.opt').forEach((btn) => btn.addEventListener('click', () => {
        const res = checkAnswer(it, btn.dataset.o);
        if (res.correct) right += 1;
        const fb = host.querySelector('#bank-fb');
        fb.textContent = res.correct ? '答對' : '答錯，答案是 ' + res.answer;
        host.querySelectorAll('.opt').forEach((x) => { x.disabled = true; });
        idx += 1;
        setTimeout(drawStep, 700);
      }));
    };
    host.hidden = false;
    drawStep();
  };

  const drawBank = () => {
    const bank = readBank();
    const box = main.querySelector('#make-bank');
    if (!bank.length) { box.innerHTML = '<p class="muted small">還沒有自製題組。</p>'; return; }
    box.innerHTML = bank.map((b) => `
      <div class="bank-row" data-id="${escapeHtml(b.id)}">
        <span>${escapeHtml(b.title)}（${b.items.length} 題）</span>
        <button class="btn subtle bank-play" type="button" data-id="${escapeHtml(b.id)}">練習</button>
        <button class="btn subtle bank-del" type="button" data-id="${escapeHtml(b.id)}">刪除</button>
      </div>`).join('');
    box.querySelectorAll('.bank-del').forEach((b) => b.addEventListener('click', () => {
      deleteBankEntry(b.dataset.id);
      drawBank();
    }));
    box.querySelectorAll('.bank-play').forEach((b) => b.addEventListener('click', () => {
      const entry = readBank().find((x) => x.id === b.dataset.id);
      if (entry) startPractice(entry);
    }));
  };

  main.querySelector('#make-run').addEventListener('click', () => {
    const text = main.querySelector('#make-text').value;
    const minLv = Number(main.querySelector('#make-min').value) || 1;
    const maxLv = Number(main.querySelector('#make-max').value) || 6;
    const maxItems = Number(main.querySelector('#make-max-items').value) || 10;
    if (minLv > maxLv) { note.textContent = '等級範圍錯誤：下限不可大於上限。'; return; }
    const r = buildCloze(text, { words, minLv, maxLv, maxItems });
    pending = r.items;
    if (!r.items.length) {
      note.textContent = '這段文字裡沒有符合條件的字（字庫內、等級範圍、干擾項足夠）。可以放寬等級或換一段文字。';
      preview.innerHTML = '';
      actions.hidden = true;
      return;
    }
    note.textContent = `產生 ${r.items.length} 題（字庫內符合條件的字有 ${r.skipped.wordsInRange} 個）`;
    preview.innerHTML = r.items.map((it, i) => `
      <div class="cloze-item">
        <p><strong>${i + 1}.</strong> ${escapeHtml(it.sentence.replace(new RegExp(it.word, 'i'), '______'))}</p>
        <p class="muted small">選項：${it.options.map((o) => escapeHtml(o)).join('　')}</p>
        <p class="muted small">答案：${escapeHtml(it.answer)}</p>
      </div>`).join('');
    actions.hidden = false;
  });

  main.querySelector('#make-pdf')?.addEventListener('change', async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    note.textContent = '讀取 PDF…';
    try {
      const buf = await file.arrayBuffer();
      const r = await extractPdfText(new Uint8Array(buf));
      if (r.reasons.includes('NOT_A_PDF')) { note.textContent = '這不是 PDF 檔。'; return; }
      if (r.scanned) {
        note.innerHTML = '';
        const btn = document.createElement('button');
        btn.className = 'btn';
        btn.type = 'button';
        btn.textContent = '這個 PDF 沒有文字層 → 用離線 OCR 取字（較慢）';
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          note.textContent = 'OCR 進行中（最多 ' + OCR_PAGE_LIMIT + ' 頁，可能要一兩分鐘）…';
          try {
            const o = await ocrPdfFile(file, { onProgress: (m) => { if (m?.status) note.textContent = 'OCR：' + m.status + (m.progress ? ' ' + Math.round(m.progress * 100) + '%' : ''); } });
            main.querySelector('#make-text').value = o.text;
            note.textContent = 'OCR 完成：' + o.pages + ' 頁、平均信心 ' + o.avgConfidence
              + (o.needsReview ? '（分數偏低，請逐句人工核對）' : '（仍請抽樣核對）')
              + (o.truncated ? '；檔案共 ' + o.totalPages + ' 頁，只處理前 ' + o.pages + ' 頁' : '')
              + '。OCR 結果只算候選，未經你核可前不會進題庫。';
          } catch (err) {
            note.textContent = 'OCR 失敗：' + (err && err.message ? err.message : '未知錯誤');
          } finally {
            ev.target.value = '';
          }
        });
        note.appendChild(btn);
        return;
      }
      main.querySelector('#make-text').value = r.text;
      note.textContent = '已取字 ' + r.text.length + ' 字（' + r.pages + ' 頁、' + r.streams + ' 個資料流）。版面複雜時請自行校正段落。';
    } catch (err) {
      note.textContent = 'PDF 解析失敗：' + (err && err.message ? err.message : '未知錯誤');
    } finally {
      ev.target.value = '';
    }
  });

  main.querySelector('#make-extract')?.addEventListener('click', () => {
    const text = main.querySelector('#make-text').value;
    const r = extractQuestions(text);
    if (!r.items.length && !r.needsAnswer.length) {
      note.textContent = '解析不到題目：請確認為「1. 題幹／(A)(B)(C)(D) 選項／答案：1-5 ABCDA」這種格式。';
      preview.innerHTML = '';
      actions.hidden = true;
      return;
    }
    pending = r.items.map((it) => ({ word: it.answer, sentence: it.stem, options: it.options, answer: it.answer, no: it.no }));
    note.textContent = '解析到 ' + r.stats.parsed + ' 題；可入庫 ' + r.items.length + ' 題；待補答案 ' + r.needsAnswer.length + ' 題'
      + (r.needsAnswer.length ? '（待補答案的題目不會入庫）' : '');
    preview.innerHTML = (pending.length ? pending.map((it, i) => `
      <div class="cloze-item"><p><strong>${it.no || i + 1}.</strong> ${escapeHtml(it.sentence)}</p>
      <p class="muted small">選項：${it.options.map((o) => escapeHtml(o)).join('　')}</p>
      <p class="muted small">答案：${escapeHtml(it.answer)}</p></div>`).join('') : '')
      + (r.needsAnswer.length ? '<p class="muted small">待補答案（未入庫）：' + r.needsAnswer.map((x) => '第 ' + x.no + ' 題').join('、') + '</p>' : '');
    actions.hidden = pending.length === 0;
  });

  main.querySelector('#make-save').addEventListener('click', () => {
    if (!pending.length) return;
    const title = main.querySelector('#make-title').value || '自製題組';
    saveBankEntry({ title, items: pending });
    note.textContent = `已存入本機題庫：${title}（${pending.length} 題）`;
    main.querySelector('#make-title').value = '';
    pending = [];
    preview.innerHTML = '';
    actions.hidden = true;
    drawBank();
  });

  drawBank();
}