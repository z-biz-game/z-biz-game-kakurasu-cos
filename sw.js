// 数和 · KAKURASU 的离线壳。
//
// 缓存名带版本号（VERSION）：每次发版改这一个常量，activate 里把所有非当前名的 cache 全删掉，
// 于是旧版本不会留在设备上占空间、也不会被误命中。
//
// 策略是**同源子资源网络优先、失败退缓存**。这里刻意不用 cache-first：本仓的 js/css 是
// 无 hash 的裸文件名（index.html 直接引 css/game.css、js/main.js），一旦 cache-first 把它们
// 钉死，发新版就会出现"新 HTML 配旧 JS"的鬼状态 —— 玩家看到的界面和跑着的规则不是同一份。
// 断网时才退到缓存，那正是"上次成功抓取的那一份"，自洽。
'use strict';

const VERSION = 'kakurasu-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  let url;
  try {
    url = new URL(req.url);
  } catch (err) {
    return; // 解析不了的请求（data:、blob:）不是我们的地盘
  }
  if (url.origin !== self.location.origin) return; // 第三方资源不接管，也不冒充接管

  ev.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit
        // 离线打开导航请求时退回缓存里的 index.html，别白屏
        || (req.mode === 'navigate' ? caches.match('./') : Response.error()))),
  );
});
