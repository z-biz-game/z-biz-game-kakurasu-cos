// Canvas renderer + pointer handling for 数和. This file owns pixels and gestures and decides
// nothing: js/core/game.js is the only place a tap is judged, and js/core/grid.js is the only
// place a weighted sum is computed. The view *asks* for a cell to be tapped and reads the
// board back through `progress()` for styling — there is no second copy of the rule in here.
//
// Everything drawn is generated: the clue gutters, the numbers, the grid, the marks, the
// crosses. No image files, no fonts, no sprites. The one thing the picture has to get right is
// the *weighting*: a marked cell pays its column number into its row clue and its row number
// into its column clue, and the gutter digits that tick up as you paint are what make that
// visible. A player who cannot see the sum cannot see the constraint.
//
// Geometry is measured from the canvas's own client box and mapped back out through
// `cellPoint()`, so an automated finger presses where a cell actually is rather than where this
// file's constants happen to suggest.

import { progress, ON, NOTE } from './core/game.js';

const PAD = 18;
const CLUE_RATIO = 0.42; // gutter width as a fraction of a cell, for the clue digits
const HINT_MS = 2600;

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

export function createView(canvas, { onTap, onIllegal, onPaint } = {}) {
  // `willReadFrequently` because tools/playtest.mjs reads the bitmap back to prove a legal tap
  // changes the picture and a refused one does not; without it Chrome logs a warning per
  // readback, which would drown the console-clean assertion in the browser gate.
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let game = null;
  let geom = { cell: 30, x0: 40, y0: 40, w: 320, h: 320, clue: 14 };
  let hint = null; // { pos, until }
  let raf = 0;
  let last = 0;
  let warm = 0; // the first frames always repaint, so the canvas is never blank
  let paint = null; // { value, seen:Set } while a drag is in progress

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
    if (!game || game.done) return;
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
    draw();
  }

  // A drag paints a run: every cell the finger crosses since the press gets the same decision
  // the first cell got, billed as its own tap. Released cells are not revisited.
  function move(ev) {
    if (!paint || !game || game.done) return;
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
    ctx.strokeStyle = 'rgba(226, 232, 240, 0.08)';
    ctx.lineWidth = 1;
    roundRect(ctx, 8, 8, w - 16, h - 16, 14);
    ctx.stroke();

    drawClues(prog, cell, clue, x0, y0, r, c);
    drawCells(prog, cell, clue, x0, y0, r, c);
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
          const t = (performance.now() % 1100) / 1100;
          ctx.strokeStyle = `rgba(120, 220, 255, ${(0.9 - t * 0.6).toFixed(3)})`;
          ctx.lineWidth = 2 + t * 3;
          const grow = t * cell * 0.18;
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

  function step(dt) {
    if (!game) return false;
    let busy = false;
    if (hint) {
      if (performance.now() < hint.until) busy = true;
      else hint = null;
    }
    return busy;
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.064, (now - (last || now)) / 1000);
    last = now;
    const busy = step(dt);
    if (busy || warm < 4) {
      warm++;
      draw();
    }
  }

  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);

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

  return {
    attach(next) {
      game = next;
      hint = null;
      paint = null;
      measure();
    },
    detach() {
      game = null;
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
      const step = xb > xa ? 1 : -1;
      const out = [];
      for (let x = xa; x !== xb + step; x += step) out.push(ya * c + x);
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
    measure,
    redraw: draw,
    showHint(pos) {
      hint = { pos, until: performance.now() + HINT_MS };
      draw();
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
