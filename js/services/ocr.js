// OCR（7.4 第 5 段，2026-11-24）
//
// 目的：掃描 PDF（沒有文字層）也能取字，餵給自製題組。
// 全部離線：tesseract.js 與英文模型、pdf.js 都放在 vendor/，不連 CDN。
//
// 原則（使用者裁定）：
//   · OCR 只產候選，一律經人工確認
//   · 未經抽樣核可前，不寫入任何題庫
//   · 分數低的頁面要標出來，不要讓使用者以為結果可信

const VENDOR = new URL('../../vendor/', import.meta.url);

export const OCR_PAGE_LIMIT = 5;      // 一次最多處理幾頁（每頁都要跑 OCR，很慢）
export const OCR_LOW_CONFIDENCE = 60; // 低於此分數要提示人工複核
export const OCR_SCALE = 1.6;         // PDF 頁面轉圖的倍率

export function normalizeOcrText(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[|_~`]/g, ' ')       // OCR 常見雜訊
    .trim();
}

export function summarizeOcr(pages) {
  const list = Array.isArray(pages) ? pages : [];
  const confidences = list.map((p) => Number(p.confidence) || 0);
  const avg = confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0;
  const low = list.filter((p) => (Number(p.confidence) || 0) < OCR_LOW_CONFIDENCE).map((p) => p.page);
  return {
    pages: list.length,
    avgConfidence: Number(avg.toFixed(1)),
    lowPages: low,
    text: list.map((p) => p.text).join('\n\n').trim(),
    needsReview: low.length > 0 || avg < OCR_LOW_CONFIDENCE,
  };
}

async function createWorker(onProgress) {
  // tesseract 的 ESM 檔可能把 createWorker 放在具名匯出或 default 上，兩種都接受。
  const mod = await import(new URL('ocr/tesseract/tesseract.esm.min.js', VENDOR).href);
  const createWorker = mod.createWorker || mod.default?.createWorker || mod.default;
  if (typeof createWorker !== 'function') throw new Error('OCR_ENGINE_UNAVAILABLE');
  const worker = await createWorker('eng', 1, {
    workerPath: new URL('ocr/tesseract/worker.min.js', VENDOR).href,
    corePath: new URL('ocr/tesseract/tesseract-core-simd-lstm.wasm.js', VENDOR).href,
    langPath: new URL('ocr/lang', VENDOR).href,
    workerBlobURL: true,
    logger: typeof onProgress === 'function' ? onProgress : undefined,
  });
  return worker;
}

export async function ocrImageBlob(blob, { onProgress } = {}) {
  const worker = await createWorker(onProgress);
  try {
    const r = await worker.recognize(blob);
    return { text: normalizeOcrText(r.data?.text), confidence: Number(r.data?.confidence) || 0 };
  } finally {
    await worker.terminate();
  }
}

// 掃描 PDF：先用 pdf.js 把頁面畫成圖，再逐頁 OCR。
export async function ocrPdfFile(file, { maxPages = OCR_PAGE_LIMIT, onProgress } = {}) {
  const pdfjs = await import(new URL('pdfjs/pdf.min.mjs', VENDOR).href);
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs/pdf.worker.min.mjs', VENDOR).href;
  const buf = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
  const total = Math.min(doc.numPages, Math.max(1, maxPages));
  const worker = await createWorker(onProgress);
  const pages = [];
  try {
    for (let i = 1; i <= total; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: OCR_SCALE });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d');
      // eslint-disable-next-line no-await-in-loop
      await page.render({ canvasContext: ctx, viewport }).promise;
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
      // eslint-disable-next-line no-await-in-loop
      const r = await worker.recognize(blob);
      pages.push({ page: i, text: normalizeOcrText(r.data?.text), confidence: Number(r.data?.confidence) || 0 });
    }
  } finally {
    await worker.terminate();
  }
  const summary = summarizeOcr(pages);
  return { ...summary, totalPages: doc.numPages, truncated: doc.numPages > total };
}