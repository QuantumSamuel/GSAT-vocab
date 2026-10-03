// ============================================================
// 外觀設定（2.1.1 Soft Minimal）
// 基本色調：light／dark；強調色：blue／orange／green／pink／gray
// 存 localStorage，全站共用；由 app.js 在頁面載入時套用
// ============================================================

const KEY_MODE = 'vocab2_mode';     // 'light' | 'dark'
const KEY_ACCENT = 'vocab2_accent'; // 'blue' | 'orange' | 'green' | 'pink' | 'gray'
const KEY_FONTSIZE = 'vocab2_font'; // 's' | 'm' | 'l'

export const ACCENTS = [
  { id: 'blue', name: '藍' },
  { id: 'orange', name: '橘' },
  { id: 'green', name: '綠' },
  { id: 'pink', name: '粉' },
  { id: 'gray', name: '灰' },
];

const ACCENT_DOTS = {
  blue: '#4A6FA5', orange: '#B8722F', green: '#5A8A6A',
  pink: '#B06E85', gray: '#6B6F76',
};

export function getMode() {
  return localStorage.getItem(KEY_MODE) || 'auto';
}

export function getAccent() {
  const v = localStorage.getItem(KEY_ACCENT) || 'blue';
  return ACCENTS.some((a) => a.id === v) ? v : 'blue';
}

export function getFontSize() {
  return localStorage.getItem(KEY_FONTSIZE) || 'm';
}

export function setMode(mode) {
  if (!['light', 'dark', 'auto'].includes(mode)) return;
  localStorage.setItem(KEY_MODE, mode);
  applyMode();
}

export function setAccent(accent) {
  if (!ACCENTS.some((a) => a.id === accent)) return;
  localStorage.setItem(KEY_ACCENT, accent);
  applyAccent();
}

export function setFontSize(size) {
  localStorage.setItem(KEY_FONTSIZE, size);
  applyFontSize();
}

// 單字卡預設顯示面（3.0.0）：'en' | 'zh' | 'random'，適用練習與複習所有單字卡
const KEY_FACE = 'vocab2_face';

export function getFace() {
  const v = localStorage.getItem(KEY_FACE) || 'random';
  return ['en', 'zh', 'random'].includes(v) ? v : 'random';
}

export function setFace(face) {
  if (!['en', 'zh', 'random'].includes(face)) return;
  localStorage.setItem(KEY_FACE, face);
}

export function rollFace() {
  const face = getFace();
  return face === 'random' ? (Math.random() < 0.5 ? 'en' : 'zh') : face;
}

// 視覺效果（3.0.5）：'flip' 立體翻轉 | 'soft' 輕柔淡入 | 'spring' 彈性活潑
// 以 <html data-anim="..."> 控制整套 CSS 動畫；JS 換面節奏也依此分流
const KEY_ANIM = 'vocab2_anim';

export function getAnim() {
  const v = localStorage.getItem(KEY_ANIM) || 'flip';
  return ['flip', 'soft', 'spring'].includes(v) ? v : 'flip';
}

export function setAnim(anim) {
  if (!['flip', 'soft', 'spring'].includes(anim)) return;
  localStorage.setItem(KEY_ANIM, anim);
  applyAnim();
}

export function applyAnim() {
  document.documentElement.dataset.anim = getAnim();
}

// 自動同步（3.1.1 上線、4.2.0 改 15 秒輪詢）：登入後比對本機與雲端；'1' 開（預設）｜'0' 關
// 間隔與觸發（15 秒鏈／回到前景／變更去抖）全在 app.js，本檔只管開關
const KEY_AUTOSYNC = 'vocab2_autosync';

export function getAutoSync() {
  return localStorage.getItem(KEY_AUTOSYNC) !== '0'; // 預設開
}

export function setAutoSync(on) {
  localStorage.setItem(KEY_AUTOSYNC, on ? '1' : '0');
}

// 4.2.0：存疑近義（AI 判讀、帶標註）顯示開關——用戶端可自行剔除
const KEY_SYN_TENT = 'vocab2_syn_tentative';
export function getSynTentative() {
  return localStorage.getItem(KEY_SYN_TENT) !== '0'; // 預設顯示
}
export function setSynTentative(on) {
  localStorage.setItem(KEY_SYN_TENT, on ? '1' : '0');
}

// 在 <html> 上掛 data-mode / data-accent / dark class
// 3.0.1：mode='auto' 時跟隨系統深色設定
export function applyMode() {
  const mode = getMode();
  const dark = mode === 'dark' ||
    (mode === 'auto' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.mode = dark ? 'dark' : 'light';
  document.documentElement.classList.toggle('dark', dark);
}

// 深色跟隨系統（3.0.1）：auto 模式下系統切換即時套用；由 app.js 啟動時呼叫一次
export function watchSystemMode() {
  if (!window.matchMedia) return;
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = () => { if (getMode() === 'auto') applyMode(); };
  if (typeof mq.addEventListener === 'function') mq.addEventListener('change', handler);
  else if (typeof mq.addListener === 'function') mq.addListener(handler); // 舊 Safari
}

export function applyAccent() {
  document.documentElement.dataset.accent = getAccent();
}

export function applyFontSize() {
  const html = document.documentElement;
  html.classList.remove('font-s', 'font-m', 'font-l');
  html.classList.add(`font-${getFontSize()}`);
}

// 單字卡字體大小（4.0.4）：s／m／l／xl，套 html[data-wordsize]
const KEY_WORDSIZE = 'vocab2_wordsize';
export function getWordSize() { return localStorage.getItem(KEY_WORDSIZE) || 'm'; }
export function setWordSize(v) { localStorage.setItem(KEY_WORDSIZE, v); applyWordSize(); }
export function applyWordSize() {
  const html = document.documentElement;
  html.classList.remove('word-s', 'word-m', 'word-l', 'word-xl');
  html.classList.add(`word-${getWordSize()}`);
}

export function applyAll() {
  applyMode();
  applyAccent();
  applyFontSize();
  applyAnim();
  applyWordSize();
}

// 舊 vocab2_theme 遷移（2.1.0 色調制：dark→深色、paper→橘、ink→藍）
export function migrateOldTheme() {
  const old = localStorage.getItem('vocab2_theme');
  if (old === null) return;
  if (old === 'dark') setMode('dark');
  if (old === 'paper') setAccent('orange');
  if (old === 'ink') setAccent('blue');
  localStorage.removeItem('vocab2_theme');
}

export function accentDot(id) {
  return ACCENT_DOTS[id] || '#888';
}
