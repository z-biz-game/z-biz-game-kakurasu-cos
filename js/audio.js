// 音效与静音。这里唯一值得较真的是"静音"二字的实现方式：
//
// 把 master gain 设成 0 不是静音 —— 振荡器照样逐个新建、AudioContext 照样 running，
// 只是恰好听不见，CPU 与功耗一分不少，而且任何读 ctx.state 的判据都会被洗成假绿。
// 本模块的静音做两件事：① `suspend()` 真的把 AudioContext 停下去（state 变 suspended）；
// ② `blip()` 在静音态**直接返回**，一个节点都不建。`nodesCreated` 就是给测试盯这条用的。
//
// 暂停也走同一条通道：暂停时上下文该停就停，恢复时再 resume —— 但 muted 与 paused 是两个
// 独立原因，只有两者都不成立时才允许 running（见 sync()）。
//
// 浏览器不允许在用户手势之前出声，所以上下文是懒建的：第一次 tap/sfx 由 main.js 在手势里触发。

let ctx = null;
let master = null;
let muted = false;
let paused = false;
let nodesCreated = 0;
let failures = 0;

function Ctor() {
  if (typeof window === 'undefined' || !window) return null;
  return window.AudioContext || window.webkitAudioContext || null;
}

function ensure() {
  if (ctx) return ctx;
  const K = Ctor();
  if (!K) return null;
  try {
    ctx = new K();
    master = ctx.createGain();
    master.gain.value = 0.16;
    master.connect(ctx.destination);
  } catch (err) {
    failures += 1;
    ctx = null;
    master = null;
    return null;
  }
  return ctx;
}

// muted || paused 才是"该安静"的真条件；分开存是因为 HUD 只报静音态。
function sync() {
  if (!ctx) return;
  const quiet = muted || paused;
  const want = quiet ? 'suspended' : 'running';
  if (ctx.state === want) return;
  const p = quiet ? ctx.suspend() : ctx.resume();
  if (p && typeof p.catch === 'function') p.catch(() => { failures += 1; });
}

export function blip(kind = 'tap') {
  if (muted) return false; // 静音态不建节点：这条是"真静音"与"假静音"的分界
  const c = ensure();
  if (!c || c.state !== 'running') return false;
  const t = c.currentTime;
  const spec = {
    tap: { f: 660, to: 520, d: 0.07, type: 'triangle' },
    mark: { f: 300, to: 240, d: 0.06, type: 'square' },
    undo: { f: 420, to: 620, d: 0.08, type: 'triangle' },
    win: { f: 520, to: 1040, d: 0.34, type: 'sine' },
    bad: { f: 200, to: 150, d: 0.16, type: 'sawtooth' },
    hint: { f: 880, to: 880, d: 0.1, type: 'sine' },
  }[kind] || { f: 600, to: 600, d: 0.05, type: 'sine' };
  try {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = spec.type;
    osc.frequency.setValueAtTime(spec.f, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(40, spec.to), t + spec.d);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.9, t + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + spec.d);
    osc.connect(gain);
    gain.connect(master);
    osc.start(t);
    osc.stop(t + spec.d + 0.02);
    nodesCreated += 1;
    return true;
  } catch (err) {
    failures += 1;
    return false;
  }
}

export const audio = {
  get muted() { return muted; },
  get paused() { return paused; },
  get state() {
    return {
      hasContext: !!ctx,
      ctxState: ctx ? ctx.state : 'none',
      muted,
      paused,
      nodesCreated,
      failures,
    };
  },
  setMuted(on) {
    muted = !!on;
    sync();
    return muted;
  },
  toggleMuted() { return this.setMuted(!muted); },
  // 暂停/恢复只改"原因位"，绝不越过静音：静音时恢复暂停也不许出声。
  setPaused(on) {
    paused = !!on;
    sync();
    return paused;
  },
  // 用户手势里调一次，让上下文在允许出声的时机被建起来（autoplay 策略）。
  unlock() {
    if (muted) return false;
    const c = ensure();
    if (!c) return false;
    if (c.state === 'suspended') {
      const p = c.resume();
      if (p && typeof p.catch === 'function') p.catch(() => { failures += 1; });
    }
    return true;
  },
  reset() {
    nodesCreated = 0;
    failures = 0;
    return true;
  },
};
