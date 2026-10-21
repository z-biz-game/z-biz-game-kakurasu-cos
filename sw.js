'use strict';
// 数和 · KAKURASU 的离线壳。
//
// 三条实测换来的口径：
//   1) 缓存名带版本号（VERSION）：每次发版改这一个常量，activate 里把所有非本版的名字删干净，
//      于是旧版本不会留在设备上占空间、也不会被误命中。名字必须写成 kakurasu-v<数字>：
//      仓里的浏览器闸按这个名字认桶（test/browser.test.mjs 的 loadSw 直接开同名桶），
//      名字对不上，离线壳的断言就分不出"哪个桶是本版"。
//   2) 一律 **网络优先**，命中网络才回填缓存。手工 VERSION + cache-first 的组合，
//      发出去的 HTML 会配上上一版的 js/css，出一个"新界面配旧逻辑"的鬼状态，
//      而且玩家自己无法恢复（只能等缓存过期）。
//      本仓的 js/css 是无 hash 的裸文件名（index.html 直接引 css/game.css、js/main.js），
//      一旦 cache-first 把它们钉死，发新版就会出现"新 HTML 配旧 JS"的鬼状态 ——
//      玩家看到的界面和跑着的规则不是同一份。断网时才退到缓存，
//      那正是"上次成功抓取的那一份"，自洽。
//   3) activate 用 startsWith 而不是全等：并线前的旧桶名带后缀（kakurasu-cos-v1-shell），
//      全等清不掉它们，而它们正是"新界面配旧逻辑"最容易藏身的地方。
const VERSION = 'kakurasu-v1';
const PRECACHE = ['index.html', 'manifest.webmanifest'];

self.addEventListener('install', (ev) => {
  // 立刻接管，不等旧标签页全关：新版本等旧标签页，页面会一直用旧壳。
  self.skipWaiting();
  // 首屏两件套先抓下来：断网时至少能打开界面，而不是浏览器的错误页。
  const ready = caches.open(VERSION).then((c) => c.addAll(PRECACHE).catch(() => {}));
  if (ev && typeof ev.waitUntil === 'function') ev.waitUntil(ready);
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
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
      .catch(async () => {
        const hit = await caches.match(req);
        if (hit) return hit;
        // 导航请求（地址栏/刷新/桌面图标）离线时回落到缓存的那份壳，不白屏。
        if (req.mode === 'navigate') {
          // './' 相对 SW 作用域解析成站点根（也就是 index.html 所在的那条），
          // 命中的是缓存里那条根记录；'index.html' 兜底，作用域不在根目录时也能命中。
          const shell = (await caches.match('./')) || (await caches.match('index.html'));
          if (shell) return shell;
        }
        return Response.error();
      })
  );
});
