// Service Worker 注册。两条硬约束：
// ① file:// 下整段跳过且不抛未捕获异常 —— Electron 的 loadFile 与"直接把 index.html 拖进
//    浏览器"都走 file:，那里 origin 是 null，注册必失败，失败就会在控制台留一条红字，
//    把"这版能不能上"的判据（console-clean）打成噪声。
// ② 注册失败只记账，不影响开局：离线壳是加分项，不是运行前提。

export function registerServiceWorker(env = {}) {
  const loc = env.location || (typeof location !== 'undefined' ? location : null);
  const nav = env.navigator || (typeof navigator !== 'undefined' ? navigator : null);
  if (!loc || !nav) return { status: 'skipped', reason: 'no-location-or-navigator' };
  if (loc.protocol === 'file:') return { status: 'skipped', reason: 'file:' };
  if (!nav.serviceWorker || typeof nav.serviceWorker.register !== 'function') {
    return { status: 'skipped', reason: 'unsupported' };
  }
  // scope 用页面所在目录，而不是 '/'：本仓可能被挂在子路径下（GitHub Pages 的 /kakurasu/），
  // 写死 '/' 会让注册直接被拒。
  const base = loc.pathname.replace(/[^/]*$/, '');
  const p = nav.serviceWorker.register(`${base}sw.js`, { scope: base });
  if (!p || typeof p.then !== 'function') return { status: 'registered', reason: 'no-promise' };
  return p.then(
    (reg) => ({ status: 'registered', reason: reg && reg.scope ? String(reg.scope) : 'ok' }),
    (err) => ({ status: 'failed', reason: String((err && err.message) || err) }),
  );
}
