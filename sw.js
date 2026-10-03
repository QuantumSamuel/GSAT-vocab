// ============================================================
// 4.0.3 離線快取關閉（用戶指示：防止整站被保存離線自架）
// 這支 Stub 的唯一任務：接手既有使用者的舊 SW 後，清空所有快取並自我解除註冊。
// app.js 已不再註冊 SW——之後所有請求一律走網路，離線功能不可用
//（iOS「加入主畫面」的桌面捷徑不受影響，僅失去離線）。
// 本檔保留在站上是為了讓「已裝過舊 SW 的瀏覽器」有更新可抓，完成清場後即退出。
// ============================================================
const DEAD_VERSION = 'vocab2-4.1.1-cleanup';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    await self.registration.unregister();
    console.info('[SW] 離線快取已關閉：快取清空、Service Worker 已解除註冊');
  })());
});
