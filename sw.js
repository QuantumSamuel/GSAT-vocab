// ============================================================
// 6.3.3 8-4 離線快取（恢復離線功能；更新策略依提案 2026-10-23 建議 A）
// 版本化 APP_SHELL：
//   · APP_SHELL（cache-first）：首頁核心——訪客離線也能看骨架（功能需網路）。
//   · 其餘（network-first）：訪問過即快取——Pro 帳戶離線可用「已快取」的非 AI 功能。
// 更新：VERSION 常數改變（與 sw-version.txt 同步）→ cache 名不同 → activate 清舊快取；
//   skipWaiting＋clients.claim 讓新 SW 立即接管，app.js 以 controllerchange 提示更新。
// 登出清 owner 分片：帳戶資料在 IndexedDB（非本快取）；公開 APP_SHELL 保留。
// ============================================================
const VERSION = '6.2.2.2';
const CACHE = 'vocab2-' + VERSION;

const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './sw-version.txt',
  './css/style.css',
  './js/app.js',
  './js/core/ui.js',
  './js/core/router.js',
  './js/core/eventbus.js',
  './js/core/motion.js',
  './js/core/bank-picker.js',
  './js/services/auth.js',
  './js/services/vocab.js',
  './js/services/store.js',
  './js/services/settings.js',
  './js/services/sync.js',
  './js/pages/home.js',
];

function isShellRequest(url) {
  const path = url.pathname.replace(/^\//, '');
  return APP_SHELL.includes('./' + path);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/functions/')) return; // API 一律網路，不離線

  if (isShellRequest(url)) {
    // cache-first：離線也能顯示首頁骨架（功能不可用由頁面層提示）
    event.respondWith(
      caches.match(request).then((hit) => hit || fetch(request).then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(request, clone));
        }
        return res;
      })),
    );
    return;
  }
  // network-first：訪問過即快取（Pro 離線可用已快取的功能頁/分片）
  event.respondWith(
    fetch(request).then((res) => {
      if (res.ok) {
        const clone = res.clone();
        caches.open(CACHE).then((c) => c.put(request, clone));
      }
      return res;
    }).catch(() => caches.match(request)),
  );
});