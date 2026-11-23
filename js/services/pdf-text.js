// PDF 取字（7.4 第 4 段，2026-11-24）
//
// 目的：把「文字型 PDF」的課文／題目取出來，餵給自製題組（克漏字／提取）。
//
// 為什麼不引入 pdf.js：
//   · 離線優先，不想為了一個功能加幾百 KB 的相依與授權負擔
//   · 我們只需要「取出文字」，不需要排版、字型、圖片
// 做法：解析 PDF 的 content stream（BT…ET 之間的 Tj／TJ 文字指令），
//       Flate 壓縮用瀏覽器內建的 DecompressionStream('deflate')，不加外部函式庫。
//
// 限制（必須明說）：
//   · 掃描檔（圖片）沒有文字層 → 取不到字，會回 scanned:true
//   · 複雜版面（多欄、表格、直排）只會得到「大致順序」，需人工校正
//   · 只支援 FlateDecode 與未壓縮；其他濾鏡（LZW、ASCII85）不處理

function latin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
  return s;
}

async function inflateOnce(bytes, format) {
  const ds = new DecompressionStream(format);
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

async function inflate(bytes) {
  if (typeof DecompressionStream !== 'function') throw new Error('NO_DECOMPRESSION_STREAM');
  // PDF 的 FlateDecode 是 zlib 包裝（deflate）；少數工具產生 raw deflate，兩種都試。
  try { return await inflateOnce(bytes, 'deflate'); } catch { return await inflateOnce(bytes, 'deflate-raw'); }
}

// 把 PDF 字串內容的跳脫還原：(\( \)) \\ \n \r \t \ddd
function unescapePdfString(s) {
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch !== '\\') { out += ch; continue; }
    const n = s[i + 1];
    if (n === undefined) break;
    if (n === 'n') { out += '\n'; i += 1; }
    else if (n === 'r') { out += '\r'; i += 1; }
    else if (n === 't') { out += '\t'; i += 1; }
    else if (n === '(' || n === ')' || n === '\\') { out += n; i += 1; }
    else if (/[0-7]/.test(n)) {
      let oct = n;
      let k = i + 2;
      while (oct.length < 3 && /[0-7]/.test(s[k] || '')) { oct += s[k]; k += 1; }
      out += String.fromCharCode(parseInt(oct, 8));
      i = k - 1;
    } else { out += n; i += 1; }
  }
  return out;
}

// 從一段 content stream 抽文字：(...)Tj / [...]TJ / (..) ' / (..) "
export function textFromContent(content) {
  const out = [];
  const tokens = /\((?:\\.|[^\\()])*\)\s*(?:Tj|'|")|\[(?:[^\[\]]|\\.)*\]\s*TJ|T\*|Td|TD/g;
  let m;
  while ((m = tokens.exec(content)) !== null) {
    const tk = m[0];
    if (/^T\*|Td|TD/.test(tk)) { out.push('\n'); continue; }
    const strings = tk.match(/\((?:\\.|[^\\()])*\)/g) || [];
    for (const raw of strings) out.push(unescapePdfString(raw.slice(1, -1)));
    if (/\]\s*TJ/.test(tk)) out.push('');
  }
  return out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
}

async function streamBytes(bytes, isFlate) {
  if (!isFlate) return bytes;
  try { return await inflate(bytes); } catch { return null; }
}

/**
 * @param {ArrayBuffer|Uint8Array} input PDF 位元組
 * @returns {Promise<{text:string, pages:number, streams:number, scanned:boolean, reasons:string[]}>}
 */
export async function extractPdfText(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 5 || latin1(bytes.slice(0, 5)) !== '%PDF-') {
    return { text: '', pages: 0, streams: 0, scanned: false, reasons: ['NOT_A_PDF'] };
  }
  const src = latin1(bytes);
  const pages = (src.match(/\/Type\s*\/Page[^s]/g) || []).length;
  const chunks = [];
  const reasons = [];
  let streams = 0;
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const start = m.index + m[0].length;
    const end = src.indexOf('endstream', start);
    if (end < 0) break;
    const header = src.slice(Math.max(0, m.index - 300), m.index);
    const isFlate = /\/FlateDecode/.test(header);
    // endstream 前面的換行不屬於資料，留下來會讓 inflate 失敗
    let endTrim = end;
    if (src[endTrim - 1] === '\n') endTrim -= 1;
    if (src[endTrim - 1] === '\r') endTrim -= 1;
    const raw = bytes.slice(start, endTrim);
    streams += 1;
    // eslint-disable-next-line no-await-in-loop
    const data = await streamBytes(raw, isFlate);
    if (!data) { reasons.push('INFLATE_FAILED'); continue; }
    const content = latin1(data);
    if (!/BT/.test(content)) continue; // 圖片或字型資料流
    const text = textFromContent(content);
    if (text.trim()) chunks.push(text);
  }
  const text = chunks.join('\n').trim();
  const scanned = text.length === 0;
  if (scanned) reasons.push('NO_TEXT_LAYER');
  return { text, pages, streams, scanned, reasons };
}