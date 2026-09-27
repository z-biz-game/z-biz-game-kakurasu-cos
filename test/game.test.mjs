// The player's board: taps, notes, undo, the completion test, and the proof that `par` really
// is the floor. The floor is checked two ways: by arithmetic on the tap rule, and by a real
// breadth-first search of the whole mark/unmark graph of a 4x4 board (2^16 states), which is
// the "no shorter route exists" refutation the contract asks for.
import { test, run, ok, eq } from '../tools/harness.mjs';
import { createGame, tap, undo, reset, progress, checkDone, remaining, grade, overLines, cellValue, ON, NOTE, OPEN } from '../js/core/game.js';
import { cluesOf, markCount, formatGrid } from '../js/core/grid.js';
import { findSolution } from '../js/core/count.js';

const diag = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const diagLot = () => {
  const { rows, cols } = cluesOf(diag, 4, 4);
  return { id: 'shoal-tst', tier: 'shoal', r: 4, c: 4, rows, cols, solution: diag.slice(), solutions: 1, depth: 0, chains: 2, backtracks: 0, nodes: 1, marks: 4 };
};

test('a new game starts empty, unsolved, and knows its own tap floor', () => {
  const g = createGame(diagLot());
  eq(g.cells, new Array(16).fill(OPEN));
  eq(g.taps, 0);
  eq(g.done, false);
  eq(g.par, 4);
  eq(g.par, markCount(diag));
});

test('a tap marks, the next tap on the same cell clears it, and both are billed', () => {
  const g = createGame(diagLot());
  eq(tap(g, 0), true);
  eq(g.cells[0], ON);
  eq(g.taps, 1);
  eq(tap(g, 0), true);
  eq(g.cells[0], OPEN);
  eq(g.taps, 2);
});

test('a tap outside the board is refused and costs nothing', () => {
  const g = createGame(diagLot());
  for (const pos of [-1, 16, 999, 1.5, NaN]) eq(tap(g, pos), false, `pos ${pos}`);
  eq(g.taps, 0);
  eq(g.cells.some((v) => v !== OPEN), false);
});

test('note mode crosses a cell without paying its weight', () => {
  const g = createGame(diagLot());
  eq(tap(g, 3, { note: true }), true);
  eq(g.cells[3], NOTE);
  eq(progress(g).rows[0].sum, 0);
  eq(tap(g, 3, { note: true }), true);
  eq(g.cells[3], OPEN);
  // a normal tap on a noted cell marks it: the cross is a scribble, not a lock
  tap(g, 5, { note: true });
  eq(tap(g, 5), true);
  eq(g.cells[5], ON);
  eq(progress(g).rows[1].sum, 2);
});

test('undo takes the last tap back and leaves the floor alone', () => {
  const g = createGame(diagLot());
  tap(g, 0);
  tap(g, 6);
  eq(g.cells[6], ON);
  eq(undo(g), true);
  eq(g.cells[6], OPEN);
  eq(g.cells[0], ON);
  eq(undo(g), true);
  eq(g.cells[0], OPEN);
  eq(undo(g), false, 'nothing left to undo');
  ok(g.taps >= 4, 'undo is itself a click and is billed');
});

test('reset returns to the empty board and clears the history', () => {
  const g = createGame(diagLot());
  tap(g, 0);
  tap(g, 1);
  reset(g);
  eq(g.taps, 0);
  eq(g.history.length, 0);
  eq(g.cells.every((v) => v === OPEN), true);
  eq(undo(g), false);
});

test('an over-capacity line is shown as over and never counts as progress', () => {
  const g = createGame(diagLot());
  tap(g, 0); // row 0 pays 1: exactly its clue
  eq(progress(g).rows[0].ok, true);
  eq(progress(g).rows[0].over, false);
  tap(g, 3); // and now 1 + 4 = 5 against a clue of 1
  eq(progress(g).rows[0].over, true);
  eq(progress(g).rows[0].left, -4);
  eq(overLines(g), 1);
  eq(checkDone(g), false);
});

test('matching every clue on a unique lot is the answer, and only the answer', () => {
  const g = createGame(diagLot());
  for (const pos of [0, 5, 10, 15]) tap(g, pos);
  eq(progress(g).allOk, true);
  eq(checkDone(g), true);
  eq(g.done, true);
  eq(grade(g), { stars: 3, label: '一次到位' });
  eq(remaining(g), 0);
});

test('a tap after the win is refused: the board is frozen at the answer', () => {
  const g = createGame(diagLot());
  for (const pos of [0, 5, 10, 15]) tap(g, pos);
  eq(g.done, true);
  const before = g.cells.slice();
  eq(tap(g, 1), false);
  eq(g.cells, before);
});

test('wasting taps is measured, not forgiven', () => {
  const g = createGame(diagLot());
  for (const pos of [0, 5, 10, 15]) tap(g, pos);
  reset(g);
  // solve it with one wasted round trip on a cell that must stay empty
  for (const pos of [0, 1, 1, 5, 10, 15]) tap(g, pos);
  eq(g.done, true);
  eq(g.taps, 6);
  eq(remaining(g), 0);
  ok(g.taps > g.par, `${g.taps} should exceed the floor ${g.par}`);
  eq(grade(g).stars, 2, 'two over the floor still reads as tidy');
  eq(grade(createGame(diagLot())).stars, 0, 'an unfinished board is not graded');
});

test('cellValue is bounds-checked the same way tap is', () => {
  const g = createGame(diagLot());
  eq(cellValue(g, 1, 1), OPEN);
  let threw = 0;
  for (const [y, x] of [[4, 0], [0, 4]]) {
    try { cellValue(g, y, x); } catch { threw += 1; }
  }
  eq(threw, 2);
});

// ---- the floor, by exhaustive search ------------------------------------------------------
// 2^16 states is the whole mark/unmark graph of a 4x4 board: an edge is one tap, which flips
// exactly one cell. So the shortest winning play from the empty board is the Hamming distance
// to the answer, and BFS over that graph is an independent confirmation of `par` -- the number
// the "一次到位" star rests on.
test('BFS over all 65536 four-by-four boards confirms the tap floor', () => {
  const start = 0;
  const target = diag.reduce((acc, v, i) => acc | (v << i), 0);
  const dist = new Int32Array(1 << 16).fill(-1);
  dist[start] = 0;
  const queue = new Int32Array(1 << 16);
  let head = 0;
  let tail = 0;
  queue[tail++] = start;
  let popped = 0;
  while (head < tail && popped < (1 << 16) + 5) {
    const s = queue[head++];
    popped += 1;
    // no early exit: the assertion below also reads a neighbouring distance
    for (let i = 0; i < 16; i++) {
      const t = s ^ (1 << i);
      if (dist[t] === -1) {
        dist[t] = dist[s] + 1;
        queue[tail++] = t;
      }
    }
  }
  const pop = (m) => { let n = 0; for (let i = 0; i < 16; i++) if (m & (1 << i)) n += 1; return n; };
  eq(dist[target], 4);
  eq(dist[target], createGame(diagLot()).par);
  // The law the floor rests on, checked across the graph rather than at one point: the
  // shortest play from the empty board to any position is exactly its number of marks.
  for (const m of [0, 1, target, target ^ 1, target | 2, 65535, 12345]) {
    eq(dist[m], pop(m), `mask ${m}`);
  }
});

test('the floor is popcount of the answer for a lot the counter produced', () => {
  const lot = { r: 4, c: 4, rows: [3, 3, 3, 0], cols: [3, 3, 3, 0] };
  const answer = findSolution(lot);
  ok(Array.isArray(answer), 'the counter returned no board');
  const g = createGame({ ...lot, id: 'x', tier: 'shoal', solution: answer, marks: markCount(answer), solutions: 1 });
  eq(g.par, markCount(answer));
  eq(g.par, formatGrid(answer, 4, 4).split('').filter((ch) => ch === '1').length);
  ok(g.par >= 1 && g.par <= 16);
});

test('tapping a whole answer in any order lands on it', () => {
  const g = createGame(diagLot());
  const order = [15, 5, 10, 0];
  for (const pos of order) eq(tap(g, pos), true);
  for (let i = 0; i < 16; i++) if (diag[i]) eq(g.cells[i], ON);
  eq(g.done, true);
  eq(g.taps, g.par);
});

run();
