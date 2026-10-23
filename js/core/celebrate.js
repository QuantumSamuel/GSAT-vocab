// ============================================================
// 慶祝彩帶（5.1.1 B0）：canvas 逐片彩帶，移植自動效樣品 animations-samples.html
// 【為什麼用 canvas 而不是 DOM 片】片數一多（70 片），DOM 節點加 CSS animation
// 要建立同樣多的節點與 keyframe 分派；canvas 一層就夠。每片只改繪製參數
// （座標、角度、透明度），不觸發任何版面重排，與「動畫只用 transform/opacity」
// 紅線同一精神（樣品頁已註明此做法）。
// 使用前提：spec B4 規定正確率滿 80% 才叫本函式；exam 成績頁不慶祝（接線步驟的責任）。
// ============================================================
import { prefersReduced } from './motion.js';

// canvas 定位樣式在 style.css 的 .confetti-canvas（絕對定位貼齊容器、不攔滑鼠）；
// 容器端需自備定位（position 相對或絕對），彩帶才會貼齊該容器而不是整頁。
export function dropConfetti(container) {
  // 開頭先檢查（spec B0）：系統開了「減少動態效果」就不噴。
  // CSS 的 reduced-motion 全域規則攔不到 canvas 逐幀繪製，必須在 JS 端擋。
  if (prefersReduced()) return;

  const host = (container && container.nodeType === 1) ? container : document.body;
  if (!host) return;

  // canvas 僅慶祝時建立、結束移除：平時不留任何繪圖表面（記憶體與合成層零成本）
  const canvas = document.createElement('canvas');
  canvas.className = 'confetti-canvas';
  // 尺寸取容器實際大小；jsdom 或隱藏容器會給 0，退回樣品的預設尺寸以免除以 0 類的怪狀態
  const W = host.clientWidth || 320;
  const H = host.clientHeight || 150;
  canvas.width = W;
  canvas.height = H;
  host.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) { canvas.remove(); return; }

  // 顏色取自站上現有 token（accent、good、warn、bad、src-archive），不引入新色。
  // 逐次現讀：跟著使用者的強調色與深色模式走；讀不到（jsdom 無樣式表）用淺色預設退回。
  const fallback = ['#4A6FA5', '#5A8A6A', '#A8814A', '#A85A4A', '#7C5CBF'];
  const colors = ['--accent', '--good', '--warn', '--bad', '--src-archive'].map((v, i) => {
    try {
      const val = getComputedStyle(document.documentElement).getPropertyValue(v).trim();
      return /^#[0-9a-fA-F]{3,8}$/.test(val) ? val : fallback[i];
    } catch {
      return fallback[i];
    }
  });

  const N = 70;
  const bits = [];
  for (let i = 0; i < N; i++) {
    bits.push({
      x: W * (0.15 + Math.random() * 0.7),
      y: -10 - Math.random() * 40,
      vx: (Math.random() - 0.5) * 1.1,
      vy: 1.4 + Math.random() * 2.0,
      w: 4 + Math.random() * 5,
      h: 6 + Math.random() * 7,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.22,
      c: colors[i % colors.length],
      a: 1,
    });
  }

  let frames = 0;
  const step = () => {
    // 容器隨換頁被移除就停手：不空轉完 190 幀，也不對脫離文件的 canvas 繼續畫
    if (!canvas.isConnected) return;
    ctx.clearRect(0, 0, W, H);
    for (const b of bits) {
      b.x += b.vx; b.y += b.vy; b.rot += b.vr;
      if (b.y > H) b.a -= 0.02; // 落到框外就淡出
      ctx.save();
      ctx.globalAlpha = Math.max(0, b.a);
      ctx.translate(b.x, b.y);
      ctx.rotate(b.rot);
      ctx.fillStyle = b.c;
      ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
      ctx.restore();
    }
    if (++frames < 190) requestAnimationFrame(step);
    else { ctx.clearRect(0, 0, W, H); canvas.remove(); } // 190 幀自停並移除（spec B0）
  };
  requestAnimationFrame(step);
}
