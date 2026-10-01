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

run();
