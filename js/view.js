// Canvas renderer + pointer handling for 数和. This file owns pixels and gestures and decides
// nothing: js/core/game.js is the only place a tap is judged, and js/core/grid.js is the only
// place a weighted sum is computed. The view *asks* for a cell to be tapped and reads the
// board back through `progress()` for styling — there is no second copy of the rule in here.
//
// The picture is generated from two tokens (the clue gutters, the numbers, the grid, the marks,
// the crosses) plus three bitmaps that `assets/gen/gen_art.py` bakes and this file actually draws:
// `board-texture.png` under the board (a board with grain reads as a board, a flat rectangle
// reads as a UI panel), `glow-cyan-64.png` for the hint pulse and the mark/undo ripple, and
// `glow-brass-64.png` for the ripple of a cell that got selected — the two sprite colours are the
// two colours the cells themselves use. Both are loaded lazily and every draw path survives their
// absence — `node --check` and the headless suites never fetch anything.
//
// Geometry is measured from the canvas's own client box and mapped back out through
// `cellPoint()`, so an automated finger presses where a cell actually is rather than where this
// file's constants happen to suggest.
//
// Motion is on a fixed step. `frame()` accumulates real elapsed seconds and runs the sim in
// `SIM_STEP` slices, so a ripple's radius after 1.000 s of virtual time is the same number at
// 30, 60 and 120 Hz. That accumulator is the one line the frame-rate harness indicts when it
// goes wrong (`accum += dt` → `accum += 1/60` must change the verdict, and `test/frame.test.mjs`
// checks exactly that with a mutated copy of this file).

import { progress, ON, NOTE } from './core/game.js';

const PAD = 18;
const CLUE_RATIO = 0.42; // gutter width as a fraction of a cell, for the clue digits
const HINT_MS = 2600;
const SIM_STEP = 1 / 120; // 120 Hz 定步长：比任何真实刷新率都快，所以帧率只改变步数不改变轨迹
const MAX_FRAME = 0.064; // 一帧最多补 64ms：切出去再回来不许把粒子瞬移过去
const RIPPLE_LIFE = 0.42; // 秒
const RIPPLE_RISE = 0.1; // 秒：淡入用的时间，不是"帧数除以 6"

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export function createView(canvas, { onTap, onIllegal, onPaint, onFrame } = {}) {
  // `willReadFrequently` because tools/playtest.mjs reads the bitmap back to prove a legal tap
  // changes the picture and a refused one does not; without it Chrome logs a warning per
  // readback, which would drown the console-clean assertion in the browser gate.
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let game = null;
  let geom = { cell: 30, x0: 40, y0: 40, w: 320, h: 320, clue: 14 };
  let hint = null; // { pos, until } — `until` 是**仿真时刻**，不是 performance.now()
  let raf = 0;
  // ---- 减弱动效（prefers-reduced-motion）----
  // 提示格的呼吸环按 t = (now % 1100) / 1100 变粗变大变淡，是纯装饰。
  // 减弱动效下把 t 钉在 0.5：环照画、格照指，只停相位。
  //
  // reduceMotion 只有**一个**声明，在下面 matchQuery 那块（并线时两侧各声明了一次：
  // 一份是写死的 false，一份从媒体查询取值并订阅变化 —— 同名顶层声明在 ES module 里
  // 是 SyntaxError，整份 view 模块一行都不执行）。这里先用法，下面的声明随后初始化它；
  // ringPhase 是闭包，调用时才读这个变量，所以顺序不影响它。
  const ringPhase = () => (reduceMotion ? 0.5 : (performance.now() % 1100) / 1100);

  let last = 0;
  let warm = 0; // the first frames always repaint, so the canvas is never blank
  let paint = null; // { value, seen:Set } while a drag is in progress

  // ---- 定步长仿真的状态：这三行就是帧率无关的全部内容
  let accum = 0; // 未满一步的余量（秒）
  let simClock = 0; // 已推进的仿真时长（秒），= simSteps * SIM_STEP
  let simSteps = 0;
  let ripples = []; // { x, y, age, kind } —— 位置由 age 算，age 由定步长累加
  let paused = false;
  let frames = 0;
  let lastTick = 0; // onFrame 的节流锚点，单位是**仿真秒**

  // reduceMotion 是一个真分支，不是一句声明：粒子与脉冲整个不生成，提示退化成静图描边。
  const motionQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;
  let reduceMotion = !!(motionQuery && motionQuery.matches);
  if (motionQuery && typeof motionQuery.addEventListener === 'function') {
    motionQuery.addEventListener('change', (ev) => {
      reduceMotion = !!ev.matches;
      if (reduceMotion) ripples = [];
      draw();
    });
  }

  // 位图资产：加载失败或压根没有 Image（node、file:// 断网）都只是"没有纹理"，不是错误。
  const art = { texture: null, pattern: null, glow: null, glowBrass: null };
  function loadArt(src, key, then) {
    if (typeof Image !== 'function') return;
    const im = new Image();
    im.onload = () => {
      art[key] = im;
      if (then) then(im);
      draw();
    };
    im.onerror = () => { art[key + 'Error'] = true; };
    im.src = src;
  }
  loadArt('assets/img/board-texture.png', 'texture', (im) => {
    const p = ctx.createPattern(im, 'repeat');
    if (p) art.pattern = p;
  });
  loadArt('assets/img/glow-cyan-64.png', 'glow');
  loadArt('assets/img/glow-brass-64.png', 'glowBrass');

  function measure() {
    const box = canvas.getBoundingClientRect();
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const W = Math.max(200, Math.round(box.width));
    const H = Math.max(200, Math.round(box.height));
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!game) return;
    const r = game.r;
    const c = game.c;
    // The clue gutters eat into the board, so the binding constraint is (n + gutter) per side.
    const gutter = 1 + CLUE_RATIO;
    const cell = Math.max(14, Math.floor(Math.min((W - PAD * 2) / (c + gutter), (H - PAD * 2) / (r + gutter))));
    geom = {
      cell,
      clue: Math.round(cell * CLUE_RATIO),
      x0: Math.round((W - (c * cell + cell * CLUE_RATIO)) / 2 + cell * CLUE_RATIO),
      y0: Math.round((H - (r * cell + cell * CLUE_RATIO)) / 2 + cell * CLUE_RATIO),
      w: W,
      h: H,
    };
    draw();
  }

  function localPoint(ev) {
    const box = canvas.getBoundingClientRect();
    return { x: ev.clientX - box.left, y: ev.clientY - box.top };
  }

  function cellRect(pos) {
    const { cell, x0, y0 } = geom;
    const c = game.c;
    const y = Math.floor(pos / c);
    const x = pos % c;
    return { x: x0 + x * cell, y: y0 + y * cell, s: cell };
  }

  // canvas-local -> client pixels, the mapping the hit test reads run backwards.
  function toClient(ux, uy) {
    const box = canvas.getBoundingClientRect();
    return { x: Math.round(box.left + ux), y: Math.round(box.top + uy) };
  }

  function posAtLocal(ux, uy) {
    if (!game) return -1;
    const { cell, x0, y0 } = geom;
    const x = Math.floor((ux - x0) / cell);
    const y = Math.floor((uy - y0) / cell);
    if (x < 0 || y < 0 || x >= game.c || y >= game.r) return -1;
    return y * game.c + x;
  }

  function applyTap(pos, note) {
    if (!game || pos < 0) return false;
    if (game.done) {
      if (onIllegal) onIllegal(pos, 'done');
      return false;
    }
    const moved = onTap ? onTap(pos, note) : false;
    if (!moved && onIllegal) onIllegal(pos, 'refused');
    return moved;
  }

  function down(ev) {
    if (!game || game.done || paused) return;
    const p = localPoint(ev);
    const pos = posAtLocal(p.x, p.y);
    if (pos < 0) return; // the gutter and the margins are not cells, and cost nothing
    ev.preventDefault();
    const note = game.noteMode;
    const before = game.cells[pos];
    const willMark = note ? before !== NOTE : before !== ON;
    if (!applyTap(pos, note)) {
      draw();
      return;
    }
    if (onPaint) onPaint(true);
    paint = { want: willMark ? (note ? NOTE : ON) : 0, seen: new Set([pos]) };
    if (hint && hint.pos === pos) hint = null;
    spawnRipple(pos, willMark ? (note ? 'mark' : 'tap') : 'undo');
    draw();
    return true;
  }

  // A drag paints a run: every cell the finger crosses since the press gets the same decision
  // the first cell got, billed as its own tap. Released cells are not revisited.
  function move(ev) {
    if (!paint || !game || game.done || paused) return;
    if (!(ev.buttons & 1)) { up(ev); return; }
    const p = localPoint(ev);
    const pos = posAtLocal(p.x, p.y);
    if (pos < 0 || paint.seen.has(pos)) return;
    paint.seen.add(pos);
    const v = game.cells[pos];
    if (v === paint.want) return;
    ev.preventDefault();
    applyTap(pos, paint.want === NOTE);
    draw();
  }

  function up() {
    if (paint && onPaint) onPaint(false);
    paint = null;
  }

  function draw() {
    const { w, h, cell, clue, x0, y0 } = geom;
    ctx.clearRect(0, 0, w, h);
    if (!game) return;
    const { r, c } = game;
    const prog = progress(game);

    ctx.fillStyle = '#181b21';
    roundRect(ctx, 8, 8, w - 16, h - 16, 14);
    ctx.fill();
    if (art.pattern) {
      // 纹理只叠在面板上：裁到同一个圆角路径里，透明度压到读得出"有颗粒"而读不出"脏"。
      ctx.save();
      roundRect(ctx, 8, 8, w - 16, h - 16, 14);
      ctx.clip();
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = art.pattern;
      ctx.fillRect(8, 8, w - 16, h - 16);
      ctx.restore();
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = 'rgba(226, 232, 240, 0.08)';
    ctx.lineWidth = 1;
    roundRect(ctx, 8, 8, w - 16, h - 16, 14);
    ctx.stroke();

    drawClues(prog, cell, clue, x0, y0, r, c);
    drawCells(prog, cell, clue, x0, y0, r, c);
    drawRipples();
  }

  // 涟漪的半径只依赖 r.age，而 r.age 由定步长累加而来 —— 所以 30/60/120Hz 画出来同一张图。
  // 落子用铜（和它点亮的那块渐变同色），标记/撤销/提示用青蓝；缺一张退到另一张，两张都没有才描边。
  function drawRipples() {
    if (!ripples.length) return;
    ctx.save();
    for (const p of ripples) {
      const t = Math.max(0, Math.min(1, p.age / RIPPLE_LIFE));
      const fade = t < 0.2 ? t / 0.2 : 1 - (t - 0.2) / 0.8;
      const rad = p.r0 + t * p.r1;
      const sprite = p.kind === 'tap'
        ? (art.glowBrass || art.glow)
        : (art.glow || art.glowBrass);
      if (sprite) {
        ctx.globalAlpha = 0.55 * fade;
        ctx.drawImage(sprite, p.x - rad, p.y - rad, rad * 2, rad * 2);
      } else {
        ctx.globalAlpha = 0.5 * fade;
        ctx.strokeStyle = p.kind === 'mark'
          ? 'rgba(159,171,185,1)'
          : (p.kind === 'tap' ? 'rgba(216,161,60,1)' : 'rgba(120,220,255,1)');
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  function drawClues(prog, cell, clue, x0, y0, r, c) {
    const font = Math.max(9, Math.round(cell * 0.42));
    const small = Math.max(7, Math.round(cell * 0.26));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let x = 0; x < c; x++) {
      const line = prog.cols[x];
      const cx = x0 + x * cell + cell / 2;
      const cy = y0 - clue / 2 - 2;
      ctx.fillStyle = line.over ? '#e2685f' : line.ok ? '#78dcff' : '#d8a13c';
      ctx.font = `600 ${font}px ${MONO}`;
      ctx.fillText(String(line.clue), cx, cy - small * 0.7);
      ctx.fillStyle = 'rgba(143, 152, 168, 0.85)';
      ctx.font = `${small}px ${MONO}`;
      ctx.fillText(String(line.sum), cx, cy + font * 0.62);
    }
    for (let y = 0; y < r; y++) {
      const line = prog.rows[y];
      const cx = x0 - clue / 2 - 2;
      const cy = y0 + y * cell + cell / 2;
      ctx.fillStyle = line.over ? '#e2685f' : line.ok ? '#78dcff' : '#d8a13c';
      ctx.font = `600 ${font}px ${MONO}`;
      ctx.fillText(String(line.clue), cx - small * 0.9, cy);
      ctx.fillStyle = 'rgba(143, 152, 168, 0.85)';
      ctx.font = `${small}px ${MONO}`;
      ctx.fillText(String(line.sum), cx + font * 0.55, cy);
    }
  }

  function drawCells(prog, cell, clue, x0, y0, r, c) {
    const inset = Math.max(2, Math.round(cell * 0.10));
    for (let y = 0; y < r; y++) {
      for (let x = 0; x < c; x++) {
        const pos = y * c + x;
        const v = game.cells[pos];
        const rect = { x: x0 + x * cell, y: y0 + y * cell, s: cell };
        ctx.fillStyle = 'rgba(255, 255, 255, 0.022)';
        roundRect(ctx, rect.x + inset, rect.y + inset, cell - inset * 2, cell - inset * 2, 4);
        ctx.fill();
        if (v === ON) {
          const grad = ctx.createLinearGradient(rect.x, rect.y, rect.x, rect.y + cell);
          grad.addColorStop(0, '#e8b855');
          grad.addColorStop(1, '#b8842b');
          ctx.fillStyle = grad;
          roundRect(ctx, rect.x + inset, rect.y + inset, cell - inset * 2, cell - inset * 2, 4);
          ctx.fill();
          ctx.strokeStyle = 'rgba(255, 238, 205, 0.35)';
          ctx.lineWidth = 1;
          roundRect(ctx, rect.x + inset + 1.5, rect.y + inset + 1.5, cell - inset * 2 - 3, cell - inset * 2 - 3, 3);
          ctx.stroke();
        } else if (v === NOTE) {
          ctx.strokeStyle = 'rgba(159, 171, 185, 0.75)';
          ctx.lineWidth = Math.max(1.5, cell * 0.07);
          ctx.lineCap = 'round';
          const a = rect.x + cell * 0.3;
          const b = rect.x + cell * 0.7;
          const d = rect.y + cell * 0.3;
          const e = rect.y + cell * 0.7;
          ctx.beginPath();
          ctx.moveTo(a, d); ctx.lineTo(b, e);
          ctx.moveTo(b, d); ctx.lineTo(a, e);
          ctx.stroke();
        }
        if (hint && hint.pos === pos) {
          // 相位取自仿真时钟：用 performance.now() 的话，脉冲走到哪一格取决于墙钟读了多少次，
          // 帧率对拍量到的就不是"同一虚拟时刻的同一状态"。
          const t = reduceMotion ? 0.35 : ((simClock * 1000) % 1100) / 1100;
          ctx.strokeStyle = `rgba(120, 220, 255, ${(0.9 - t * 0.6).toFixed(3)})`;
          ctx.lineWidth = 2 + t * 3;
          const grow = reduceMotion ? 0 : t * cell * 0.18;
          roundRect(ctx, rect.x + inset - grow, rect.y + inset - grow, cell - inset * 2 + grow * 2, cell - inset * 2 + grow * 2, 6);
          ctx.stroke();
        }
      }
    }
    // the grid itself, drawn last so the cells read as a board and not as tiles
    ctx.strokeStyle = 'rgba(226, 232, 240, 0.22)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= c; x++) {
      ctx.beginPath();
      ctx.moveTo(x0 + x * cell, y0);
      ctx.lineTo(x0 + x * cell, y0 + r * cell);
      ctx.stroke();
    }
    for (let y = 0; y <= r; y++) {
      ctx.beginPath();
      ctx.moveTo(x0, y0 + y * cell);
      ctx.lineTo(x0 + c * cell, y0 + y * cell);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(216, 161, 60, 0.55)';
    ctx.lineWidth = 2;
    ctx.strokeRect(x0 - 1, y0 - 1, c * cell + 2, r * cell + 2);
    // the two axes the clues belong to, labelled so the weighting is not a guess
    ctx.fillStyle = 'rgba(143, 152, 168, 0.9)';
    ctx.font = `${Math.max(8, Math.round(cell * 0.24))}px ${MONO}`;
    ctx.textAlign = 'left';
    ctx.fillText('列号 →', x0, y0 - clue - 6);
    ctx.save();
    ctx.translate(x0 - clue - 6, y0 + 4);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'left';
    ctx.fillText('行号 →', 0, 0);
    ctx.restore();
  }

  function step(s) {
    let busy = false;
    if (hint) {
      if (simClock < hint.until) busy = true;
      else hint = null;
    }
    if (ripples.length) {
      for (const p of ripples) p.age += s;
      ripples = ripples.filter((p) => p.age < RIPPLE_LIFE);
      if (ripples.length) busy = true;
    }
    return busy;
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    frames += 1;
    // 这一帧真正过了多少秒。沙箱/浏览器都可能给出不单调的时间戳，负数一律按 0 处理，否则 accum 会倒退；
    // 上限 MAX_FRAME 是"切出去半小时回来不许瞬移"的那道闸。dt 是全仓唯一的帧耗时来源。
    const dt = Math.min(MAX_FRAME, Math.max(0, (now - (last || now)) / 1000));
    last = now;
    let busy = false;
    if (paused) {
      // 暂停期间仿真整个不推进；余量清零，否则恢复瞬间要补跑一大串步骤，涟漪会瞬移。
      accum = 0;
      busy = false;
    } else {
      accum += dt; // ← 帧率对拍的钉头就在这行：改成 `accum += SIM_STEP` 三档立刻分叉
      let guard = 0;
      while (accum >= SIM_STEP && guard < 256) {
        accum -= SIM_STEP;
        simClock += SIM_STEP;
        simSteps += 1;
        guard += 1;
        busy = step(SIM_STEP) || busy;
      }
      if (guard >= 256) accum = 0; // 长时间挂起后的追帧上限：宁可掉仿真也不冻结主线程
    }
    if (onFrame && simClock - lastTick >= 0.1) {
      lastTick = simClock;
      onFrame(simClock);
    }
    if (busy || warm < 4) {
      warm += 1;
      draw();
    }
  }

  // 一次点按的落点：半径从半格长到一格半，寿命 RIPPLE_LIFE 秒。reduceMotion 下整个不生成。
  function spawnRipple(pos, kind) {
    if (reduceMotion || !game || pos < 0) return 0;
    const rect = cellRect(pos);
    ripples.push({
      x: rect.x + rect.s / 2,
      y: rect.y + rect.s / 2,
      r0: rect.s * 0.5,
      r1: rect.s * 1.0,
      age: 0,
      kind: kind || 'tap',
    });
    return ripples.length;
  }

  const hasPointer = typeof window !== 'undefined' && typeof window.PointerEvent === 'function';
  if (hasPointer) {
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
  } else {
    // 回落路径：老 WebView 没有 PointerEvent。触摸点取第一根手指，坐标仍是 clientX/clientY，
    // 因此和 pointer 分支共用同一个 getBoundingClientRect 换算 —— 不允许出现第二套命中逻辑。
    const touch = (ev) => {
      const t = ev.touches && ev.touches.length ? ev.touches[0] : (ev.changedTouches && ev.changedTouches[0]);
      if (!t) return null;
      return { clientX: t.clientX, clientY: t.clientY, buttons: 1, preventDefault: () => ev.preventDefault() };
    };
    canvas.addEventListener('touchstart', (ev) => { const p = touch(ev); if (p) down(p); }, { passive: false });
    canvas.addEventListener('touchmove', (ev) => { const p = touch(ev); if (p) move(p); }, { passive: false });
    canvas.addEventListener('touchend', (ev) => { up(); }, { passive: false });
    canvas.addEventListener('touchcancel', () => up(), { passive: false });
    canvas.addEventListener('mousedown', down);
    canvas.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    canvas.addEventListener('mouseleave', up);
  }

  // The canvas box is decided by CSS and a `window` resize event does not always follow it
  // (a phone rotating, the panel reflowing, a devtools split), so watch the box itself: the hit
  // test maps client pixels through geometry measured from that box, and measuring late means
  // tapping the wrong cell. Guarded, because `node --check` also loads this file.
  if (typeof ResizeObserver === 'function') {
    let first = true;
    const ro = new ResizeObserver(() => {
      if (first) { first = false; return; } // the initial callback is the layout we measured
      measure();
    });
    ro.observe(canvas);
  }

  // 换关/重开/暂停都要走这里：漏掉任何一项缓存，下一局就会带着上一局的粒子与时钟起跑。
  // 必须是词法作用域里的普通函数：对象字面量里的方法互相调不到，attach() 里裸调 resetFx() 会抛。
  function clearFx() {
    hint = null;
    paint = null;
    ripples = [];
    accum = 0;
    simClock = 0;
    simSteps = 0;
  }

  return {
    attach(next) {
      game = next;
      clearFx();
      measure();
    },
    detach() {
      game = null;
    },
    resetFx() {
      clearFx();
      return this.fx();
    },
    setPaused(on) {
      paused = !!on;
      if (paused) {
        paint = null; // 暂停时手指抬起：恢复后不允许从半路接着划
      } else {
        last = 0; // 下一帧重新起算，暂停多久都不补时间
      }
      draw();
      return paused;
    },
    // 帧率对拍读的就是这一个对象：全部是"仿真推进了多少"，没有一项是墙钟或帧数。
    fx() {
      return {
        simClock,
        simSteps,
        accum,
        ripples: ripples.length,
        rippleAges: ripples.map((p) => Math.round(p.age * 1e6) / 1e6),
        rippleRadius: ripples.map((p) => Math.round((p.r0 + (p.age / RIPPLE_LIFE) * p.r1) * 1e3) / 1e3),
        frames,
        paused,
        reduceMotion,
        hintUntil: hint ? Math.round(hint.until * 1e6) / 1e6 : 0,
        hintPos: hint ? hint.pos : -1,
        texture: !!art.pattern,
        glow: !!art.glow,
        glowBrass: !!art.glowBrass,
      };
    },
    reducedMotion() {
      return reduceMotion;
    },
    measure,
    redraw: draw,
    showHint(pos) {
      hint = { pos, until: simClock + HINT_MS / 1000 };
      spawnRipple(pos, 'hint');
      draw();
    },
    // Client-space centre of cell `pos` as it stands right now — what an automated finger needs.
    cellPoint(pos) {
      if (!game || pos < 0 || pos >= game.cells.length) return null;
      const rect = cellRect(pos);
      const p = toClient(rect.x + rect.s / 2, rect.y + rect.s / 2);
      return {
        ...p,
        pos,
        r: Math.round(rect.s / 2),
        size: rect.s,
        value: game.cells[pos],
        note: game.noteMode,
        done: game.done,
      };
    },
    // Where a client-space point lands: -1 when it is gutter, margin or outside the board.
    pointAt(clientX, clientY) {
      const box = canvas.getBoundingClientRect();
      return posAtLocal(clientX - box.left, clientY - box.top);
    },
    // Which cells a drag from a to b would paint, for the @pointer suite's run assertion.
    runFrom(a, b) {
      if (!game) return [];
      const c = game.c;
      const [ya, xa] = [Math.floor(a / c), a % c];
      const [yb, xb] = [Math.floor(b / c), b % c];
      if (ya !== yb) return [a];
      const dir = xb > xa ? 1 : -1;
      const out = [];
      for (let x = xa; x !== xb + dir; x += dir) out.push(ya * c + x);
      return out;
    },
    painting() {
      return !!paint;
    },
    // A cheap fingerprint of what is on screen: the browser suite uses it to assert that a
    // legal tap changes pixels and a refused one does not.
    pixelsHash() {
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let sum = 0;
      for (let i = 0; i + 2 < d.length; i += 4 * 617) sum = (sum * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7) % 2147483647;
      return sum;
    },
    painted() {
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4 * 97) if (d[i] > 0) n++;
      return n;
    },
    start() {
      if (!raf) {
        last = 0;
        warm = 0;
        raf = requestAnimationFrame(frame);
      }
    },
    stop() {
      cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}

const MONO = '"SF Mono", "JetBrains Mono", Menlo, Consolas, "PingFang SC", monospace';
