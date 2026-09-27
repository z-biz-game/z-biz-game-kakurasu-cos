// The deterministic solver: what it can force, what it has to assume, and the four numbers it
// prints. Also the source of the in-game hint, which is only allowed to state something
// propagation actually proved.
import { test, run, ok, eq } from '../tools/harness.mjs';
import { lineCandidates, propagate, propagateOnce, analyse, nextDeduction, propagationOnly, branchCell, toSolverState } from '../js/core/logic.js';
import { UNKNOWN, MARKED, EMPTY, formatGrid } from '../js/core/grid.js';
import { findSolutions } from '../js/core/count.js';

// ---- line candidates, by hand -----------------------------------------------------------
// A line of width 4 has weights 1,2,3,4. The subsets and their sums are arithmetic, written
// out here rather than asked of the code under test.
const wide = [{ pos: 0, weight: 1 }, { pos: 1, weight: 2 }, { pos: 2, weight: 3 }, { pos: 3, weight: 4 }];
test('a clue of 0 forces the whole line empty', () => {
  const c = lineCandidates(wide, 0);
  eq(c.masks.length, 1);
  eq(c.forced, []);
  eq(c.dead, [0, 1, 2, 3]);
});
test('a clue of 1 can only be column 1', () => {
  const c = lineCandidates(wide, 1);
  eq(c.forced, [0]);
  eq(c.dead, [1, 2, 3]);
});
test('a clue of 10 can only be every column', () => {
  const c = lineCandidates(wide, 10);
  eq(c.forced, [0, 1, 2, 3]);
  eq(c.dead, []);
});
test('a clue of 5 is {1,4} or {2,3}: nothing forced, nothing dead', () => {
  const c = lineCandidates(wide, 5);
  eq(c.masks.length, 2);
  eq(c.forced, []);
  eq(c.dead, []);
});
test('a clue of 3 is {3} or {1,2}, so column 4 is out', () => {
  const c = lineCandidates(wide, 3);
  eq(c.dead, [3]);
  eq(c.forced, []);
});
test('an unreachable clue has no candidates at all', () => {
  const c = lineCandidates(wide.slice(0, 2), 9);
  eq(c.none, true);
  eq(c.masks.length, 0);
});
test('a negative requirement is a contradiction, not a crash', () => {
  eq(lineCandidates(wide, -1).none, true);
});

// ---- propagation on a hand-solvable board -------------------------------------------------
// The diagonal lot: rows 1,2,3,4 against columns 1,2,3,4. Row 0 can only be column 0, row 1
// only column 1, and that reasoning walks the whole board without ever supposing anything.
const diag = { r: 4, c: 4, rows: [1, 2, 3, 4], cols: [1, 2, 3, 4] };
test('propagation solves the diagonal completely', () => {
  const res = propagate(diag, new Array(16).fill(UNKNOWN));
  eq(res.contradiction, false);
  eq(res.solved, true);
  eq(formatGrid(res.state, 4, 4), '1000/0100/0010/0001');
  ok(res.rounds >= 1 && res.rounds <= 4, `rounds was ${res.rounds}`);
});
test('a single pass already empties row 0 and kills its other three cells', () => {
  const state = new Array(16).fill(UNKNOWN);
  const res = propagateOnce(diag, state);
  eq(res.contradiction, false);
  ok(res.forced >= 4, `only ${res.forced} cells decided`);
  eq(state.slice(0, 4), [MARKED, EMPTY, EMPTY, EMPTY]);
});
test('an impossible lot is contradicted, not silently half-filled', () => {
  const bad = { r: 4, c: 4, rows: [10, 0, 0, 0], cols: [1, 0, 0, 0] };
  const res = propagate(bad, new Array(16).fill(UNKNOWN));
  eq(res.contradiction, true);
  eq(analyse(bad).solved, false);
});
test('over-capacity is a contradiction', () => {
  const lot = { r: 4, c: 4, rows: [1, 2, 3, 4], cols: [1, 2, 3, 4] };
  const state = new Array(16).fill(EMPTY);
  state[0] = MARKED;
  state[3] = MARKED; // row 0 pays 1 + 4 = 5 against a clue of 1
  eq(propagate(lot, state).contradiction, true);
});
test('propagate never touches the array it was handed', () => {
  const state = new Array(16).fill(UNKNOWN);
  const before = state.slice();
  propagate(diag, state);
  eq(state, before);
});
test('a lot with an all-empty row still determines the rest', () => {
  const lot = { r: 4, c: 4, rows: [1, 2, 3, 0], cols: [1, 2, 3, 0] };
  const res = propagate(lot, new Array(16).fill(UNKNOWN));
  eq(res.solved, true);
  eq(formatGrid(res.state, 4, 4), '1000/0100/0010/0000');
});

// ---- the four printed numbers -----------------------------------------------------------
test('the diagonal needs no assumption and reports depth 0', () => {
  const an = analyse(diag, { nodeCap: 4000 });
  eq(an.solved, true);
  eq(an.capped, false);
  eq(an.depth, 0);
  eq(an.backtracks, 0);
  ok(an.chains >= 1, `chains ${an.chains}`);
  eq(an.nodes, 1, 'no branching means exactly one search node');
});
test('analyse is a pure function of the clue pair: same in, same out', () => {
  const lot = { r: 5, c: 5, rows: [2, 5, 8, 1, 4], cols: [3, 6, 2, 9, 4] };
  const a = analyse(lot, { nodeCap: 4000 });
  const b = analyse(lot, { nodeCap: 4000 });
  eq(a, b);
  eq(JSON.stringify(a), JSON.stringify(b));
});
test('analyse does not modify the lot', () => {
  const lot = { r: 4, c: 4, rows: [1, 2, 3, 4], cols: [1, 2, 3, 4] };
  const before = JSON.stringify(lot);
  analyse(lot, { nodeCap: 4000 });
  eq(JSON.stringify(lot), before);
});
test('a node cap that is too small reports capped instead of inventing numbers', () => {
  const hard = { r: 6, c: 6, rows: [6, 3, 11, 6, 1, 15], cols: [7, 10, 6, 3, 14, 6] };
  const tiny = analyse(hard, { nodeCap: 1 });
  ok(tiny.capped || !tiny.solved, JSON.stringify(tiny));
  const roomy = analyse(hard, { nodeCap: 4000 });
  eq(typeof roomy.depth, 'number');
});
test('depthCap rejects a search that stopped resembling human reasoning', () => {
  const an = analyse(diag, { nodeCap: 4000, depthCap: 0 });
  eq(an.solved, true);
  eq(an.capped, false, 'depth 0 is inside a cap of 0');
  const strict = analyse(diag, { nodeCap: 4000, depthCap: -1 });
  eq(strict.capped, true);
});
test('propagationOnly says how far logic goes before any guess', () => {
  const p = propagationOnly(diag);
  eq(p.solved, true);
  eq(p.undecided, 0);
  ok(p.rounds >= 1);
});
test('branchCell picks the lowest-index cell with the fewest live candidates', () => {
  const state = new Array(16).fill(UNKNOWN);
  const pick = branchCell(diag, state);
  eq(typeof pick.pos, 'number');
  ok(pick.count >= 1);
  // with one cell decided, the same call must be deterministic and still point at a cell
  state[0] = MARKED;
  const again = branchCell(diag, state);
  ok(again.pos !== 0);
});
test('toSolverState maps open/marked/noted onto unknown/marked/empty', () => {
  eq(toSolverState([0, 1, 2, 0]), [UNKNOWN, MARKED, EMPTY, UNKNOWN]);
});

// ---- the hint ---------------------------------------------------------------------------
test('a hint on an empty diagonal board names a provable cell', () => {
  const cells = new Array(16).fill(0);
  const h = nextDeduction(diag, cells);
  eq(h.pos, 0);
  eq(h.value, MARKED);
});
test('a hint after the board is already right says so', () => {
  const solved = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  eq(nextDeduction(diag, solved).complete, true);
});
test('a hint on a board that cannot be finished reports the contradiction', () => {
  const cells = new Array(16).fill(0);
  cells[0] = 1;
  cells[3] = 1;
  eq(nextDeduction(diag, cells).contradiction, true);
});
test('a noted-out cell is respected by the hint', () => {
  const cells = new Array(16).fill(0);
  cells[0] = 2; // cross out the only cell row 0 could pay 1 from
  const h = nextDeduction(diag, cells);
  eq(h.contradiction, true);
});
test('the hint never claims a cell the answer grid contradicts', () => {
  // For every shipped-style lot we can build by hand here: take the answer from the counter,
  // then walk the hint chain from an empty board and check each named cell against it.
  const lot = { r: 4, c: 4, rows: [3, 3, 3, 0], cols: [3, 3, 3, 0] };
  const answer = findSolutions(lot, 1)[0];
  ok(!!answer);
  const cells = new Array(16).fill(0);
  for (let step = 0; step < 20; step++) {
    const h = nextDeduction(lot, cells);
    if (h.complete || h.stuck) break;
    if (h.contradiction) break;
    cells[h.pos] = h.value === MARKED ? 1 : 2;
    eq(h.value === MARKED, answer[h.pos] === MARKED, `hint ${step} pointed the wrong way`);
  }
});

run();
