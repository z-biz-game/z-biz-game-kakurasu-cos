// 浏览器侧模块（音效/偏好/离线壳）。这些文件在 node 里跑不了整个 shell，但它们各自的行为
// 不需要真浏览器：把它们要的那几个全局补上，就能问出"静音到底挂起了没有"这种问题。
//
// 这里最要紧的一条：静音判据不看 ctx 的 gain，看 `log.osc` —— 假静音（gain=0）照样逐条新建
// 振荡器，真静音必须一条都不新建，并且 AudioContext 的 state 要真的变 suspended。
import { test, run, eq, ok } from '../tools/harness.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SETTINGS_KEY, defaults, readSettings, writeSettings } from '../js/settings.js';
import { registerServiceWorker } from '../js/pwa.js';
import { createGame, tap as tapCell } from '../js/core/game.js';
import { at } from '../js/core/library.js';

const root = new URL('..', import.meta.url).pathname;

// ---- fake WebAudio --------------------------------------------------------------------------------
function fakeWorld({ startSuspended = false, resistSuspend = false } = {}) {
  const log = { suspends: 0, resumes: 0, osc: 0, gains: 0, starts: 0, stops: 0 };
  class FakeAudioContext {
    constructor() {
      this.state = startSuspended ? 'suspended' : 'running';
      this.currentTime = 0;
      this.destination = { name: 'destination' };
    }
    createGain() {
      log.gains += 1;
      return { gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
    }
    createOscillator() {
      log.osc += 1;
      return {
        type: '',
        frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect() {},
        start() { log.starts += 1; },
        stop() { log.stops += 1; },
      };
    }
    suspend() {
      log.suspends += 1;
      if (!resistSuspend) this.state = 'suspended'; // resist 时浏览器拒绝挂起，state 照旧 running
      return Promise.resolve();
    }
    resume() { log.resumes += 1; this.state = 'running'; return Promise.resolve(); }
  }
  return { log, win: { AudioContext: FakeAudioContext } };
}

// harness 的 test() 同步调用 body，永远不会 await 一个 async body —— 那样抛出的断言错误会
// 变成没人管的 promise，行还是绿的。所以 async 行必须先 await 再登记。
async function atest(name, fn) {
  try {
    await fn();
    test(name, () => {});
  } catch (err) {
    test(name, () => { throw err; });
  }
}

async function freshAudio(opts) {
  const world = fakeWorld(opts);
  globalThis.window = world.win;
  const mod = await import(`../js/audio.js?instance=${Math.random()}`);
  return { world, audio: mod.audio, blip: mod.blip };
}

// ---- 静音 ------------------------------------------------------------------------------------------
await atest('导入时不建上下文：autoplay 策略下建 AudioContext 必须由手势发起', async () => {
  const { audio, world } = await freshAudio({ startSuspended: true });
  eq(audio.state.hasContext, false);
  eq(world.log.osc, 0);
});

await atest('上下文被浏览器挂起时，第一声不出声也不建振荡器', async () => {
  const { audio, blip, world } = await freshAudio({ startSuspended: true });
  eq(blip('tap'), false, '被挂起的上下文里不许建节点');
  eq(audio.state.hasContext, true, '但上下文本身已经建好了（下一次手势就能出声）');
  eq(world.log.osc, 0);
  eq(audio.state.failures, 0, '这条路是正常分支，不是异常');
});

await atest('手势里 unlock() 之后，一次 tap 恰好建一条振荡器', async () => {
  const { audio, blip, world } = await freshAudio({ startSuspended: true });
  eq(audio.unlock(), true);
  eq(audio.state.ctxState, 'running');
  eq(blip('tap'), true);
  eq(world.log.osc, 1);
  eq(world.log.starts, 1);
  eq(audio.state.nodesCreated, 1);
});

await atest('静音 = 挂起上下文 + 一条节点都不新建（不是把音量调成 0）', async () => {
  const { audio, blip, world } = await freshAudio({ startSuspended: false });
  eq(audio.unlock(), true);
  eq(blip('tap'), true);
  const oscBefore = world.log.osc;
  eq(audio.setMuted(true), true);
  eq(audio.state.ctxState, 'suspended', '静音必须真的 suspend()');
  eq(world.log.suspends, 1);
  for (const kind of ['tap', 'mark', 'undo', 'win', 'bad', 'hint']) eq(blip(kind), false, `${kind} 在静音态不该出声`);
  eq(world.log.osc, oscBefore, '振荡器计数一动不动，这才是真静音');
  eq(audio.state.nodesCreated, 1);
});

await atest('浏览器拒绝挂起时仍然一条节点不建：静音判据不看 ctx.state', async () => {
  const { audio, blip, world } = await freshAudio({ startSuspended: false, resistSuspend: true });
  eq(audio.unlock(), true);
  eq(blip('tap'), true);
  const oscBefore = world.log.osc;
  eq(audio.setMuted(true), true);
  eq(audio.state.ctxState, 'running', '这个浏览器不给挂起 —— 此时只有 muted 这道门能拦住声音');
  eq(blip('tap'), false);
  eq(blip('win'), false);
  eq(world.log.osc, oscBefore, '把 master gain 调成 0 的假静音会在这里红：它照样建节点');
});

await atest('静音与暂停是两个独立原因：解除暂停也不许越过静音出声', async () => {
  const { audio, blip, world } = await freshAudio({ startSuspended: false });
  eq(audio.unlock(), true);
  eq(audio.setPaused(true), true);
  eq(audio.state.ctxState, 'suspended');
  eq(blip('tap'), false);
  eq(audio.setMuted(true), true);
  eq(audio.setPaused(false), false); // 暂停解除了，但静音还在
  eq(audio.state.ctxState, 'suspended', '只有 muted 与 paused 都不成立时才许 running');
  eq(world.log.osc, 0);
  eq(audio.setMuted(false), false);
  eq(audio.state.ctxState, 'running');
  eq(blip('tap'), true);
  eq(world.log.osc, 1);
});

await atest('HUD 只报静音态，不报暂停态：muted/paused 各自可读', async () => {
  const { audio } = await freshAudio({ startSuspended: false });
  audio.unlock();
  eq(audio.muted, false);
  audio.setPaused(true);
  eq(audio.paused, true);
  eq(audio.muted, false, '暂停不等于静音');
});

// ---- 偏好（逐字段回落，不做一把梭 assign）-------------------------------------------------------------
delete globalThis.window;

function fakeLocal(mem = new Map()) {
  const api = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
  return { api, mem };
}

function withLocal(make, body) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage');
  const saved = globalThis.localStorage;
  const made = make();
  globalThis.localStorage = made.api;
  try {
    return { out: body(made), made };
  } finally {
    if (had) globalThis.localStorage = saved;
    else delete globalThis.localStorage;
  }
}

test('没有 localStorage 时读偏好返回默认值并说 persistent: false，而不是抛', () => {
  const s = readSettings(); // node 下 typeof localStorage === 'undefined'
  eq(s, { ...defaults, persistent: false });
});

test('偏好坏一处只坏一处：整份 null、类型错、越界长度都不带走别的字段', () => {
  const cases = [
    ['null', 'null', { muted: false, helpSeen: false, lastMode: '' }],
    ['array', '[1,2,3]', { muted: false, helpSeen: false, lastMode: '' }],
    ['number', '7', { muted: false, helpSeen: false, lastMode: '' }],
    ['muted 是字符串', '{"muted":"yes","helpSeen":true}', { muted: false, helpSeen: true, lastMode: '' }],
    ['muted 是数字', '{"muted":1,"lastMode":"daily"}', { muted: false, helpSeen: false, lastMode: 'daily' }],
    ['lastMode 超长', `{"muted":true,"lastMode":"${'x'.repeat(40)}"}`, { muted: true, helpSeen: false, lastMode: '' }],
    ['lastMode 是对象', '{"helpSeen":true,"lastMode":{"a":1}}', { muted: false, helpSeen: true, lastMode: '' }],
  ];
  for (const [name, raw, want] of cases) {
    const { out } = withLocal(() => {
      const mem = new Map([[SETTINGS_KEY, raw]]);
      return { api: { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: () => {}, removeItem: () => {} }, mem };
    }, () => readSettings());
    eq(out, { ...want, persistent: true }, name);
  }
});

test('非 JSON 的偏好字节标 corrupt，但仍然给出可用的默认值', () => {
  const { out } = withLocal(() => {
    const mem = new Map([[SETTINGS_KEY, '{not json']]);
    return { api: { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: () => {}, removeItem: () => {} }, mem };
  }, () => readSettings());
  eq(out.corrupt, true);
  eq(out.muted, false);
  eq(out.persistent, true);
});

test('写偏好真的落盘，读回来是同一个值', () => {
  const { made } = withLocal(() => fakeLocal(), () => {
    eq(writeSettings({ muted: true }).ok, true);
    eq(writeSettings({ helpSeen: true }).ok, true);
    return readSettings();
  });
  const onDisk = JSON.parse(made.mem.get(SETTINGS_KEY));
  eq(onDisk, { muted: true, helpSeen: true, lastMode: '' });
  eq(Object.prototype.hasOwnProperty.call(onDisk, 'persistent'), false, '运行时字段不许写进盘');
});

test('写盘被拒（配额）时本次会话仍然生效，只是不落盘', () => {
  const { out } = withLocal(() => ({
    api: { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); }, removeItem: () => {} },
  }), () => writeSettings({ muted: true }));
  eq(out.ok, false);
  eq(out.settings.muted, true, '内存里的偏好不该因为写失败被吞掉');
  eq(out.settings.persistent, undefined, 'settings 里不带运行时字段');
});

// ---- 离线壳 -----------------------------------------------------------------------------------------
test('file:// 下跳过注册，且不留下未捕获异常', () => {
  const r = registerServiceWorker({
    location: { protocol: 'file:', pathname: '/tmp/index.html' },
    navigator: { serviceWorker: { register: () => { throw new Error('file:// 不该被调用'); } } },
  });
  eq(r.status, 'skipped');
  eq(r.reason, 'file:');
});

test('没有 serviceWorker 的浏览器同样只是跳过', () => {
  const r = registerServiceWorker({ location: { protocol: 'https:', pathname: '/' }, navigator: {} });
  eq(r.status, 'skipped');
  eq(r.reason, 'unsupported');
});

await atest('注册用的是页面目录下的 sw.js 和同一个 scope，不是写死的 /', async () => {
  const calls = [];
  const r = await registerServiceWorker({
    location: { protocol: 'https:', pathname: '/kakurasu/index.html' },
    navigator: { serviceWorker: { register: (url, opts) => { calls.push([url, opts]); return Promise.resolve({ scope: `${opts.scope}sw.js` }); } } },
  });
  eq(calls, [['/kakurasu/sw.js', { scope: '/kakurasu/' }]]);
  eq(r.status, 'registered');
});

await atest('注册失败只记账，不抛', async () => {
  const r = await registerServiceWorker({
    location: { protocol: 'https:', pathname: '/' },
    navigator: { serviceWorker: { register: () => Promise.reject(new Error('The manifest is missing')) } },
  });
  eq(r.status, 'failed');
  eq(/manifest/.test(r.reason), true);
});

// ---- 接线（这些是"模块存在但没被用上"的防线）-------------------------------------------------------------
test('manifest 与 sw 的引用都在盘上，且 cache 名带版本号', () => {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const sw = readFileSync(join(root, 'sw.js'), 'utf8');
  const main = readFileSync(join(root, 'js', 'main.js'), 'utf8');
  ok(/rel="manifest"/.test(html), 'index.html 必须挂 manifest');
  ok(/networkFirst|cache-first|caches\.open/.test(sw), 'sw.js 得有缓存策略');
  ok(/kakurasu-v\d/.test(sw), 'cache 名要带版本');
  ok(/registerServiceWorker/.test(main), 'main.js 真的要注册 sw');
});

test('暂停/静音/全屏/玩法四个 HUD 按钮都存在且被 main.js 绑到 handler', () => {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const main = readFileSync(join(root, 'js', 'main.js'), 'utf8');
  for (const id of ['pause', 'sound', 'fullscreen', 'help', 'helpcard', 'pausecard', 'resume']) {
    ok(new RegExp(`id="${id}"`).test(html), `index.html 缺 #${id}`);
    ok(main.includes(`el.${id}`), `main.js 没用到 #${id}`);
  }
  ok(/requestFullscreen/.test(main), '全屏要真的调 requestFullscreen');
  ok(/matchMedia/.test(readFileSync(join(root, 'js', 'view.js'), 'utf8')), 'reduceMotion 要真的读媒体查询');
});

// ---- view：reduceMotion 与输入回落（把 view 要的几个全局补上，node 里就能跑）--------------------
let viewSeq = 0;
function makeWorld({ matches = false, pointer = true } = {}) {
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
    setReducedMotion(on) { if (changeHandler) changeHandler({ matches: !!on }); },
  };
}

async function freshView(world) {
  const { createView } = await import(`../js/view.js?view=${(viewSeq += 1)}`);
  const game = createGame(at(1)); // 真的第 1 关
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

const press = (world, pt, type = 'pointerdown', extra = {}) => {
  world.dispatch(type, { clientX: pt.x, clientY: pt.y, buttons: 1, button: 0, preventDefault() {}, ...extra });
  const upType = type === 'touchstart' ? 'touchend' : (type === 'mousedown' ? 'mouseup' : 'pointerup');
  if (upType === 'touchend') world.dispatch(upType, { changedTouches: [], preventDefault() {} });
  else world.dispatch(upType, { clientX: pt.x, clientY: pt.y, buttons: 0, preventDefault() {} });
};

await atest('reduceMotion 命中时玩法照改、粒子为零（降级的是动效不是规则）', async () => {
  const world = makeWorld({ matches: true });
  const { game, view } = await freshView(world);
  eq(view.fx().reduceMotion, true);
  press(world, view.cellPoint(5));
  ok(game.cells[5] !== 0, '格子必须被点中');
  world.pump(4, 16);
  eq(view.fx().ripples, 0, '匹配 prefers-reduced-motion 时一条粒子都不许生成');
  view.showHint(5);
  world.pump(4, 16);
  eq(view.fx().ripples, 0);
  eq(view.fx().hintPos, 5, '提示本身仍然给出');
});

await atest('不降级时同一动作生成 1 条涟漪，半径只随仿真时间长大', async () => {
  const world = makeWorld({ matches: false });
  const { view } = await freshView(world);
  press(world, view.cellPoint(5));
  world.pump(2, 16); // 32ms -> 3 步
  const a = view.fx();
  eq(a.ripples, 1);
  world.pump(12, 16);
  const b = view.fx();
  eq(b.ripples, 1);
  ok(b.rippleAges[0] > a.rippleAges[0], `age 必须推进：${a.rippleAges[0]} -> ${b.rippleAges[0]}`);
  ok(b.rippleRadius[0] > a.rippleRadius[0], `半径必须由时间驱动：${a.rippleRadius[0]} -> ${b.rippleRadius[0]}`);
});

await atest('媒体查询从"能动"改成"别动"的瞬间清空已有粒子', async () => {
  const world = makeWorld({ matches: false });
  const { view } = await freshView(world);
  press(world, view.cellPoint(5));
  world.pump(2, 16);
  eq(view.fx().ripples, 1);
  world.setReducedMotion(true);
  eq(view.fx().reduceMotion, true);
  eq(view.fx().ripples, 0, 'change 事件必须真的清场');
});

await atest('没有 PointerEvent 时 touch/mouse 回落走同一套坐标换算，边距不落子也不计费', async () => {
  const world = makeWorld({ matches: false, pointer: false });
  const { game, view } = await freshView(world);
  eq(world.listeners.has('pointerdown'), false, '回落分支不该同时注册 pointer 事件');
  ok(world.listeners.has('touchstart') && world.listeners.has('mousedown'), 'touch 与 mouse 两条回落都要在');
  press(world, { x: 2, y: 2 }, 'touchstart', { touches: [{ clientX: 2, clientY: 2 }] });
  eq(game.taps, 0, '边距/槽位不是格子：不计点击、不改盘面');
  eq(game.cells[0], 0);
  press(world, view.cellPoint(4), 'touchstart', { touches: [{ clientX: view.cellPoint(4).x, clientY: view.cellPoint(4).y }] });
  ok(game.cells[4] !== 0, 'touchstart 必须能落子');
  press(world, view.cellPoint(9), 'mousedown');
  ok(game.cells[9] !== 0, 'mousedown 必须能落子');
  eq(game.taps, 2, '两次落子记两次，边距那次不记');
});

await atest('暂停时仿真不推进、盘面拒收点按，恢复后两边都回来', async () => {
  const world = makeWorld({ matches: false });
  const { game, view } = await freshView(world);
  press(world, view.cellPoint(5));
  world.pump(12, 16); // 先跑 192ms，让仿真真的动起来
  const before = view.fx();
  ok(before.simSteps > 0, '前置条件：仿真已经在推进');
  ok(before.ripples === 1, `前置条件：有一条在飞的涟漪，得到 ${before.ripples}`);
  const tapsBefore = game.taps;
  view.setPaused(true);
  world.pump(30, 16); // 暂停 480ms
  const during = view.fx();
  eq(during.simSteps, before.simSteps, '暂停期间一步都不许多');
  eq(during.simClock, before.simClock, '用时读数必须冻住');
  eq(during.accum, 0, '余量必须清零，否则恢复瞬间要补跑一大串');
  press(world, view.cellPoint(6));
  eq(game.taps, tapsBefore, '暂停期间一次点按都不许生效');
  eq(game.cells[6], 0);
  view.setPaused(false);
  press(world, view.cellPoint(6));
  world.pump(12, 16);
  const after = view.fx();
  ok(after.simSteps > during.simSteps, '恢复后仿真必须接着走');
  ok(game.cells[6] !== 0, '恢复后照样能玩');
  eq(after.ripples >= 1, true, '上一局的涟漪与这一格的涟漪都还在预算内');
});

// ---- service worker：执行 sw.js，问它到底先网络还是先缓存 --------------------------------------------
async function loadSw({ origin = 'https://game.example', netOk = true } = {}) {
  const handlers = {};
  const buckets = new Map();
  const calls = { respond: 0, fetches: [], matched: [], opened: [], deleted: [], claimed: 0, skipped: 0, waiters: [] };
  const bucket = (name) => { if (!buckets.has(name)) buckets.set(name, new Map()); return buckets.get(name); };
  const res = (tag) => ({ ok: true, status: 200, tag, clone() { return { ...this, cloned: true }; } });
  globalThis.self = {
    location: { origin, href: `${origin}/` },
    clients: { claim: async () => { calls.claimed += 1; } },
    skipWaiting: () => { calls.skipped += 1; },
    addEventListener: (t, fn) => { handlers[t] = fn; },
  };
  const resolveKey = (u) => {
    const s = typeof u === 'string' ? u : String((u && u.url) || u);
    if (s === './' || s === '.' || s === '/') return `${globalThis.self.location.origin}/`;
    return s;
  };
  globalThis.caches = {
    keys: async () => [...buckets.keys()],
    open: async (name) => {
      calls.opened.push(name);
      const b = bucket(name);
      return { put: async (req, body) => b.set(resolveKey(req), body), match: async (req) => b.get(resolveKey(req)) || undefined };
    },
    delete: async (name) => { calls.deleted.push(name); return buckets.delete(name); },
    match: async (req) => {
      calls.matched.push(resolveKey(req));
      const key = resolveKey(req);
      for (const b of buckets.values()) { const hit = b.get(key); if (hit) return hit; }
      return undefined;
    },
  };
  globalThis.Response = { error: () => ({ __responseError: true }) };
  const order = [];
  globalThis.fetch = async (req) => {
    order.push('fetch');
    calls.fetches.push(req.url);
    if (!netOk) throw new Error('offline');
    return res('net');
  };
  await import(`../sw.js?sw=${(viewSeq += 1)}`);
  return {
    calls,
    order,
    handlers,
    bucket,
    request: (url, opts = {}) => ({ url, method: opts.method || 'GET', mode: opts.mode || 'cors', headers: new Map() }),
    respond: async (req) => {
      let out = null;
      const ev = { request: req, respondWith: (p) => { calls.respond += 1; out = p; } };
      handlers.fetch(ev);
      const settled = await Promise.resolve(out).catch((e) => ({ rejected: String(e && e.message || e) }));
      return settled;
    },
  };
}

await atest('同源子资源是网络优先：fetch 先被调用，命中后才写缓存', async () => {
  const sw = await loadSw();
  const req = sw.request('https://game.example/js/main.js');
  const out = await sw.respond(req);
  eq(sw.calls.fetches, ['https://game.example/js/main.js']);
  eq(sw.order.includes('fetch'), true);
  eq(sw.calls.matched.length, 0, '在线路径一次都不该去查缓存');
  eq(out.tag, 'net');
  await new Promise((r) => setTimeout(r, 0)); // put 是 fire-and-forget，让微任务落地
  eq(sw.calls.opened, ['kakurasu-v1'], '缓存名必须带版本号');
  eq(sw.bucket('kakurasu-v1').has(req.url), true, '抓到的是否真的进了版本桶');
});

await atest('断网时退回缓存里的同一份，不白屏也不报错', async () => {
  const sw = await loadSw({ netOk: false });
  const url = 'https://game.example/css/game.css';
  sw.bucket('kakurasu-v1').set(url, { tag: 'cached' });
  const out = await sw.respond(sw.request(url));
  eq(out.tag, 'cached', '离线必须命中上次的快照');
  eq(sw.calls.matched, [url]);
});

await atest('离线的导航请求退回缓存里的 index.html，非导航就如实失败', async () => {
  const sw = await loadSw({ netOk: false });
  sw.bucket('kakurasu-v1').set('https://game.example/', { tag: 'shell' });
  const nav = await sw.respond(sw.request('https://game.example/#/c/3', { mode: 'navigate' }));
  eq(nav.tag, 'shell', '导航请求断网时也要有页面可渲染');
  const notNav = await sw.respond(sw.request('https://game.example/js/nope.js'));
  eq(notNav.__responseError, true, '没有缓存的子资源要如实失败，不能伪造命中');
});

await atest('第三方资源与非 GET 一律不接管', async () => {
  const sw = await loadSw();
  const cross = await sw.respond(sw.request('https://evil.example/js/main.js'));
  eq(sw.calls.respond, 0, '跨源请求不许被 respondWith');
  eq(sw.calls.fetches.length, 0, '跨源请求也不该被 sw 代抓');
  eq(cross, null);
  const post = await sw.respond(sw.request('https://game.example/api', { method: 'POST' }));
  eq(post, null, '非 GET 同样不接管');
});

await atest('activate 把所有非当前版本的缓存删干净并接管客户端', async () => {
  const sw = await loadSw();
  sw.bucket('kakurasu-v1');
  sw.bucket('kakurasu-v0');
  sw.bucket('kakurasu-old');
  let waited = null;
  sw.handlers.activate({ waitUntil: (p) => { waited = p; } });
  await waited;
  eq(sw.calls.deleted.sort(), ['kakurasu-old', 'kakurasu-v0'], '只留当前版本桶');
  eq(sw.calls.claimed, 1);
  sw.handlers.install();
  eq(sw.calls.skipped, 1, '安装要 skipWaiting，否则新版本等旧标签页全关');
});

run();
