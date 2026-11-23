// ============================================================
// Google Gemini 實作（3.0.4：改為 provider 介面的實作模組）
// 4.1.2：模型改為備援鏈——gemini-flash-lite-latest 別名正被淘汰（同族已陸續
//        404），首選失效自動降級到實名版；使用者可在設置頁覆寫模型。
// 3.x 不吃 thinkingConfig，不要送
// ============================================================

// 備援鏈：別名優先（維持既有行為）＋實名版備援（不會被別名淘汰波及）
const MODEL_CHAIN = ['gemini-flash-lite-latest', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite'];
const MODEL_PREF_KEY = 'vocab2_gemini_model';
let usableModel = null; // session 內記住最後成功的模型，避免每次重打失效別名

/**
 * 使用者覆寫的模型（設置頁選擇）；空值＝使用備援鏈自動降級。
 * 由 settings.js 呼叫。
 */
export function getPreferredModel() {
  return localStorage.getItem(MODEL_PREF_KEY) || '';
}

export function setPreferredModel(id) {
  if (id) localStorage.setItem(MODEL_PREF_KEY, id);
  else localStorage.removeItem(MODEL_PREF_KEY);
  usableModel = null; // 覆寫後重新走鏈
}

function buildChain() {
  const pref = getPreferredModel();
  return pref ? [pref, ...MODEL_CHAIN.filter((m) => m !== pref)] : MODEL_CHAIN;
}

function isModelUnavailable(status, detail) {
  if (status === 404) return true;
  return status === 400 &&
    (detail.includes('not found') || detail.includes('not supported for this model') ||
      detail.includes('do not have access') || detail.includes('has been retired'));
}

/**
 * 呼叫 Gemini 並回傳解析後的 JSON（含限流／退避重試＋模型備援鏈）。
 * 由 services/ai/index.js 依使用者選擇的供應商呼叫。
 */
export async function sendGemini(key, prompt, { maxOutputTokens = 8192, temperature = 0.7 } = {}) {
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature,
      maxOutputTokens,
    },
  };

  const chain = buildChain();
  if (usableModel && chain.includes(usableModel)) chain.unshift(usableModel); // 記住的可用模型優先

  let lastErr = null;
  for (const model of chain) {
    const API = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await fetch(API, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': key,
          },
          body: JSON.stringify(body),
        });
        if (res.status === 429) {
          const wait = 20 * (attempt + 1);
          console.warn(`限流，等 ${wait} 秒後重試…`);
          await sleep(wait * 1000);
          lastErr = new Error('429 限流');
          continue;
        }
        if (!res.ok) {
          const detail = (await res.text()).slice(0, 200);
          // 間歇性的「User location is not supported」（FAILED_PRECONDITION）可重試
          const locationErr = res.status === 400 &&
            (detail.includes('location') || detail.includes('FAILED_PRECONDITION'));
          if (locationErr && attempt < 4) {
            console.warn(`地區誤判（間歇性），等 ${(attempt + 1) * 3} 秒後重試…`);
            await sleep((attempt + 1) * 3 * 1000);
            lastErr = new Error(`Gemini HTTP 400：${detail}`);
            continue;
          }
          // 4.1.2：模型失效（404／模型下架）→ 降級鏈的下一個模型，不在此拋出
          if (isModelUnavailable(res.status, detail) && attempt === 0) {
            console.warn(`模型 ${model} 不可用，改用備援模型…`);
            break;
          }
          throw new Error(`Gemini HTTP ${res.status}：${detail}`);
        }
        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) throw new Error('Gemini 回應內容為空');
        let parsed = JSON.parse(text);
        if (Array.isArray(parsed)) parsed = { results: parsed };
        usableModel = model;
        return parsed;
      } catch (err) {
        if (String(err.message).startsWith('Gemini HTTP')) throw err; // 參數/金鑰錯誤不重試
        lastErr = err;
        const wait = 4 * (attempt + 1);
        console.warn(`網路不穩（${String(err).slice(0, 60)}），等 ${wait} 秒後重試…`);
        await sleep(wait * 1000);
      }
    }
  }
  throw new Error(`Gemini 重試多次仍失敗：${lastErr?.message ?? lastErr}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
