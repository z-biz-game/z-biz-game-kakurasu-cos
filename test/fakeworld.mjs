// view.js 要的那几个浏览器全局，在 node 里补出来就够了：一块画布、一对媒体查询、一条 rAF 队列。
//
// 这份壳原来长在 test/browser.test.mjs 里；帧率对拍（test/frame.test.mjs）要拿**同一块壳**跑
// 正版与变异副本，两边各抄一遍就会各飘一半 —— 所以抽到这里，两-suite 共用。
//
// 三个刻意保留的细节：
//   - ctx 是 Proxy：任何没实现的方法都返回空函数，view.js 加一条新调用不会把测试炸在无关处。
//   - Image 的 src setter 里排队微任务，`loadArt()` 的 onload 因此真的会跑，纹理/发光 sprite
//     的加载分支在 node 里也是走到的（fx().texture/glow/glowBrass 就是它的读数）。
//   - pump 的虚拟时钟**从 1000ms 起**（可传 from）：从 0 起步会被 view 的 `last || now` 哨兵
//     吃掉一帧，凭空造出一个假的帧率依赖。

import { createGame, tap as tapCell } from '../js/core/game.js';
import { at } from '../js/core/library.js';

let viewSeq = 0;

export function makeWorld({ matches = false, pointer = true } = {}) {
  const listeners = new Map();
  const box = { left: 0, top: 0, right: 480, bottom: 480, width: 480, height: 480 };
  const base = {
    fillStyle: '', strokeStyle: '', font: '', globalAlpha: 1, lineWidth: 1, textAlign: '', textBaseline: '',
    shadowBlur: 0, shadowColor: '', globalCompositeOperation: '', lineCap: '', lineJoin: '', miterLimit: 10, filter: 'none',
  };
  const ctx = new Proxy(base, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'measureText') return () => ({ width: 8, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 });
      if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4 * 64), width: 8, height: 8 });
      if (k === 'createPattern') return () => ({ __pattern: true });
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} });
      return () => {};
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  const canvas = {
    width: 0, height: 0, style: {}, className: '',
    getContext: () => ctx,
    getBoundingClientRect: () => box,
    addEventListener: (t, fn) => { if (!listeners.has(t)) listeners.set(t, []); listeners.get(t).push(fn); },
    removeEventListener: () => {}, setAttribute: () => {}, getAttribute: () => null, toDataURL: () => 'data:,',
  };
  let pending = null;
  let changeHandler = null;
  globalThis.requestAnimationFrame = (cb) => { pending = cb; return 1; };
  globalThis.cancelAnimationFrame = () => { pending = null; };
  globalThis.Image = class {
    constructor() { this.width = 64; this.height = 64; }
    set src(v) { this._s = v; queueMicrotask(() => { if (this.onload) this.onload(); }); }
    get src() { return this._s; }
  };
  globalThis.window = {
    devicePixelRatio: 1,
    PointerEvent: pointer ? function PointerEvent() {} : undefined,
    matchMedia: () => ({ matches, addEventListener: (t, fn) => { if (t === 'change') changeHandler = fn; }, removeEventListener: () => {} }),
    addEventListener: () => {}, removeEventListener: () => {},
  };
  return {
    canvas,
    listeners,
    dispatch(type, ev) { for (const fn of (listeners.get(type) || [])) fn(ev); },
    // 逐帧喂虚拟时间：返回最后的时钟，方便调用方把三档接在同一条时间轴上。
    pump(frames, dtMs, from = 1000) {
      let c = from;
      for (let i = 0; i < frames; i += 1) {
        c += dtMs;
        const cb = pending;
        pending = null;
        if (cb) cb(c);
      }
      return c;
    },
    // 一帧一帧地推：帧率对拍要在"越线的那一帧"就停下取数，一次喂 N 帧会直接越过对齐点。
    frame(dtMs, from) { return this.pump(1, dtMs, from); },
    setReducedMotion(on) { if (changeHandler) changeHandler({ matches: !!on }); },
  };
}

// `viewUrl` 让同一块壳能加载 js/view.js 的**变异副本**（阴性对照用）；默认就是仓里那份。
export async function freshView(world, { viewUrl, lot = 1 } = {}) {
  const url = viewUrl || new URL(`../js/view.js?view=${(viewSeq += 1)}`, import.meta.url).href;
  const { createView } = await import(url);
  const game = createGame(at(lot));
  const view = createView(world.canvas, {
    onTap: (pos, note) => tapCell(game, pos, { note }),
    onIllegal: () => false,
    onPaint: () => {},
    onFrame: () => {},
  });
  view.attach(game);
  view.measure();
  view.start();
  return { game, view };
}

export function press(world, pt, type = 'pointerdown', extra = {}) {
  world.dispatch(type, { clientX: pt.x, clientY: pt.y, buttons: 1, button: 0, preventDefault() {}, ...extra });
  const upType = type === 'touchstart' ? 'touchend' : (type === 'mousedown' ? 'mouseup' : 'pointerup');
  if (upType === 'touchend') world.dispatch(upType, { changedTouches: [], preventDefault() {} });
  else world.dispatch(upType, { clientX: pt.x, clientY: pt.y, buttons: 0, preventDefault() {} });
}
