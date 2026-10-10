// ============================================================
// AI 供應商抽象層（3.0.4）：統一介面＝generateJSON(prompt, opts)
// 頁面（翻譯題／批改）只 import 這裡，不直接碰供應商實作。
// 新增供應商：寫一個實作檔（或一行 OpenAI 相容註冊）＋加進 PROVIDERS。
// 金鑰存 localStorage（每裝置一份）；3.1 起可由帳號權益表接管供應商限制。
// ============================================================
import { sendGemini } from './gemini.js';

const KEY_PREFIX = 'vocab2_key_';
const LEGACY_GEMINI_KEY = 'vocab2_gemini_key'; // 2.1.2–3.0.2 的舊鍵位，相容讀取
const PROVIDER_KEY = 'vocab2_ai_provider';

// OpenAI 相容端點共用（DeepSeek／GLM 同格式）
async function sendOpenAI(url, model, key, prompt, { maxOutputTokens = 8192, temperature = 0.7 } = {}) {
  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    temperature,
    max_tokens: maxOutputTokens,
  };
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
      });
      if (res.status === 429) {
        const wait = 20 * (attempt + 1);
        await sleep(wait * 1000);
        lastErr = new Error('429 限流');
        continue;
      }
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 200);
        if (res.status >= 500 && attempt < 4) {
          await sleep(4 * (attempt + 1) * 1000);
          lastErr = new Error(`HTTP ${res.status}：${detail}`);
          continue;
        }
        throw new Error(`HTTP ${res.status}：${detail}`);
      }
      const data = await res.json();
      let text = data.choices?.[0]?.message?.content ?? '';
      text = String(text).replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
      if (!text) throw new Error('回應內容為空');
      let parsed = JSON.parse(text);
      if (Array.isArray(parsed)) parsed = { results: parsed };
      return parsed;
    } catch (err) {
      if (String(err.message).startsWith('HTTP 4')) throw err; // 金鑰/參數錯誤不重試
      lastErr = err;
      await sleep(4 * (attempt + 1) * 1000);
    }
  }
  throw new Error(`重試多次仍失敗：${lastErr?.message ?? lastErr}`);
}

async function sendDeepSeek(key, prompt, opts) {
  return sendOpenAI('https://api.deepseek.com/chat/completions', 'deepseek-chat', key, prompt, opts);
}

async function sendGLM(key, prompt, opts) {
  return sendOpenAI('https://open.bigmodel.cn/api/paas/v4/chat/completions', 'glm-4-flash', key, prompt, opts);
}

// ---------- 供應商註冊表 ----------
export const PROVIDERS = {
  gemini:   { name: 'Google Gemini', free: true,  applyUrl: 'aistudio.google.com（Get API key）', send: sendGemini },
  deepseek: { name: 'DeepSeek',      free: false, applyUrl: 'platform.deepseek.com',            send: sendDeepSeek },
  glm:      { name: '智譜 GLM',       free: true,  applyUrl: 'open.bigmodel.cn（有免費額度）',      send: sendGLM },
};

export function listProviders() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({ id, name: p.name, free: p.free, applyUrl: p.applyUrl }));
}

export function getProviderId() {
  const v = localStorage.getItem(PROVIDER_KEY);
  return PROVIDERS[v] ? v : 'gemini';
}

export function setProviderId(id) {
  if (PROVIDERS[id]) localStorage.setItem(PROVIDER_KEY, id);
}

// 金鑰管理（gemini 相容讀取舊鍵位 vocab2_gemini_key）
export function getKey(id = getProviderId()) {
  return localStorage.getItem(KEY_PREFIX + id) ||
    (id === 'gemini' ? localStorage.getItem(LEGACY_GEMINI_KEY) || '' : '');
}

export function saveKey(id, key) {
  localStorage.setItem(KEY_PREFIX + id, String(key || '').trim());
}

export function hasKey(id = getProviderId()) {
  return getKey(id).length > 0;
}

// ---------- 統一入口（頁面唯一呼叫點） ----------
export async function generateJSON(prompt, opts = {}) {
  const id = getProviderId();
  const key = getKey(id);
  if (!key) {
    const p = PROVIDERS[id];
    throw new Error(`尚未設定 ${p.name} 金鑰：請到「設置」的「AI 金鑰」貼上（申請：${p.applyUrl}）`);
  }
  return PROVIDERS[id].send(key, prompt, opts);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
