// The player's board: a 0/1/2 cell array plus a tap history, and the two rules the shell is
// allowed to ask about — does this tap count, and is the board solved.
//
// Cell states: 0 = open (contributes nothing), 1 = marked (contributes its line weight),
// 2 = noted out (a cross: known-empty, contributes nothing either). Only state 1 pays.
//
// `par` here is not a difficulty label, it is the tap floor, and it is arithmetic:
// a tap changes exactly one cell, the board starts all-open, and the certified answer has
// `marks` cells set, so no route is shorter than `marks` taps. That is the same counting
// argument a hypercube distance rests on, and test/game.test.mjs checks it against a real
// breadth-first search of the whole 2^16 mark/unmark graph for a 4x4 lot — so "perfect" on
// this screen is a proven-minimum claim, not a mood.
//
// Pure module: no window, no document.

import { MARKED, EMPTY, formatGrid, statusOf, isClueConsistent, isSolution, markCount, cellIndex } from './grid.js';

export const OPEN = EMPTY;
export const ON = MARKED;
export const NOTE = 2;

export function createGame(lot) {
  const cells = new Array(lot.r * lot.c).fill(OPEN);
  return {
    lot,
    r: lot.r,
    c: lot.c,
    cells,
    taps: 0,
    history: [],
    done: false,
    noteMode: false,
    par: markCount(lot.solution),
    target: formatGrid(lot.solution, lot.r, lot.c),
  };
}

export function cellValue(game, y, x) {
  return game.cells[cellIndex(game.r, game.c, y, x)];
}

// One tap. Returns true when the board changed, false when it was refused (out of bounds,
// already solved, or a cycle that lands where it started). The view is not allowed to decide
// this for itself.
export function tap(game, pos, { note = game.noteMode } = {}) {
  if (game.done) return false;
  if (!Number.isInteger(pos) || pos < 0 || pos >= game.cells.length) return false;
  const before = game.cells[pos];
  const after = note ? (before === NOTE ? OPEN : NOTE) : (before === ON ? OPEN : ON);
  if (after === before) return false;
  game.cells[pos] = after;
  // A note is a scribble, not progress: it is undone as a pair with the tap that removes it,
  // but it is billed, because it costs the player a click and "perfect" is about clicks.
  game.history.push({ pos, before, after });
  game.taps += 1;
  checkDone(game);
  return true;
}

export function undo(game) {
  const last = game.history.pop();
  if (!last) return false;
  game.cells[last.pos] = last.before;
  game.taps += 1; // undo is a click too; the floor is about reaching the answer, not about retreating
  game.done = false;
  return true;
}

export function reset(game) {
  game.cells = new Array(game.r * game.c).fill(OPEN);
  game.taps = 0;
  game.history = [];
  game.done = false;
  return game;
}

export function progress(game) {
  return statusOf(game.lot, game.cells);
}

// The completion test has two halves and both are checked: every weighted line sum matches,
// and the board is the baked answer grid cell for cell. While `solutions === 1` the two
// cannot disagree — that implication is what test/lot.test.mjs pins down — and stating both
// means a lot whose uniqueness claim were ever wrong cannot quietly read as a win.
export function checkDone(game) {
  const ok = isClueConsistent(game.lot, game.cells) && isSolution(game.lot, game.cells);
  game.done = ok;
  return ok;
}

export function overLines(game) {
  const p = progress(game);
  return p.over;
}

export function remaining(game) {
  const cur = game.cells;
  const want = game.lot.solution;
  let diff = 0;
  for (let i = 0; i < cur.length; i++) if (cur[i] !== want[i]) diff += 1;
  return diff;
}

export function grade(game) {
  if (!game.done) return { stars: 0, label: '' };
  if (game.taps === game.par) return { stars: 3, label: '一次到位' };
  if (game.taps <= game.par * 1.5) return { stars: 2, label: '略有反复' };
  return { stars: 1, label: '解出来了' };
}
