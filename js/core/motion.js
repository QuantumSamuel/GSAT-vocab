// ============================================================
// 動效基建（5.1.1 B0）：全站共用的小型動效工具，唯一實作
// 出處樣品：4.0/ui-samples/5.0/animations-samples.html（class 對應樣式在
// style.css「5.1.1 動效」區段，前綴 d1/d2/d3 沿用樣品命名）。
// 紅線：動畫只用 transform/opacity（對勾描繪的 stroke-dashoffset 不觸發重排，樣品已註明）；
// prefers-reduced-motion 的 CSS 側由 style.css 既有全域規則攔截（壓到 .01ms），
// 因此動畫必須走 class 加 animation 才會被攔到，本模組的 replay 也因此只用 class。
// ============================================================

// 查詢系統的「減少動態效果」偏好。
// CSS 動畫不用問這裡（style.css 的 @media (prefers-reduced-motion: reduce) 全域攔截）；
// JS 主動繪製的動畫（celebrate.js 的 canvas 彩帶）CSS 攔不到，動手前必須先問一次。
export function prefersReduced() {
  try {
    return !!(typeof window !== 'undefined' && window.matchMedia
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch {
    return false; // 查不到偏好就照常播放（與樣品一致：攔截失敗不該把功能整個關掉）
  }
}

// 重播一個 animation class：先移除、強制 reflow、再加回，animationend 後自動移除。
// 樣品同款。之所以不直接改 inline style：class 加 keyframes 才會被 reduced-motion
// 全域規則與未來的頁面級動畫開關攔截；inline style 會繞過那道防線。
// 補充：reduced-motion 下 duration 被壓到 .01ms，animationend 仍會照常觸發，
// 所以 class 移除路徑不需要特例。
export function replay(node, cls) {
  if (!node) return;
  node.classList.remove(cls);
  void node.offsetWidth; // 強制 reflow：同一個 class 立刻重播才會重新起跑
  node.classList.add(cls);
  node.addEventListener('animationend', () => node.classList.remove(cls), { once: true });
}

// 連續答對計數器（d2-combo 徽記的資料端，spec B4）。
// 不綁死 DOM：引擎端把徽記元素交給 render()，斷裂（n 不足 2）時由 render 清空隱藏；
// 這樣四個練習引擎都能把徽記掛在自己的進度區或題殼位置，掛點自由度留在接線步驟。
// 行為：連對滿 2 起顯示「連對 N」並用 d2-combo 彈入；答錯歸零（record(false)）。
export function makeCombo() {
  let n = 0;
  return {
    // 記一題：ok 為真累加、為假歸零；回傳目前連對數（引擎端要顯示其他回饋時可用）
    record(ok) {
      n = ok ? n + 1 : 0;
      return n;
    },
    reset() { n = 0; },
    // 把目前狀態畫到徽記元素：滿 2 顯示文字並彈入；不足 2 清空（斷裂即隱藏）。
    // 清空時連 class 一併移除：animationend 移除在瀏覽器才會發生，斷裂路徑不能指望它，
    // 免得殘留的 d2-combo class 在未來加上持久樣式（字色等）時露餡。
    render(node) {
      if (!node) return;
      if (n >= 2) {
        node.textContent = `連對 ${n}`;
        replay(node, 'd2-combo');
      } else {
        node.classList.remove('d2-combo');
        node.textContent = '';
      }
    },
  };
}
