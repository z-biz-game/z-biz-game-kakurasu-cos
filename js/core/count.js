// Solution *counters*. This file is the reason the sentence "this puzzle has exactly one
// solution" is a fact rather than an opinion in this repo.
//
// Two independent implementations live here on purpose:
//
//   countSolutionsDP        — row by row over column-subset states (fast, the one bake uses)
//   countSolutionsBacktrack — cell by cell depth-first, row-major (independent code path)
//
// A third route, the exhaustive 2^(r*c) enumeration, deliberately does NOT live here: it is
// in test/anchorlib.mjs so no page load or playtest can ever reach it. test/anchor.test.mjs
// then proves that all three agree on the 4x4 space, and that the DP and the backtracking
// counter agree on 400 sampled clue classes.
//
// Both counters COUNT. Neither is a first-solution search wearing a count's clothes: they
// keep going until `limit` solutions have been found, which is why `limit: 2` is enough to
// *prove* ambiguity and never enough to prove uniqueness (see `exact` in the return).
//
// Pure module: no window, no document.

import { MARKED } from './grid.js';

// Both counters return
//   { count, bailed, states|nodes }
// count  : the number of solutions found. Trusted as the exact total only while count < limit;
//          count === limit means "at least limit" (that is all an ambiguity proof needs).
// bailed : true when an internal ceiling was hit before the space was exhausted, i.e. the
//          count is meaningless. Callers must treat a bail as "reject", never as "ambiguous".
// states / nodes : measured work, printed by tools/bake.mjs so the cost claim is checkable.

const DEFAULT_STATE_CAP = 400000;
const DEFAULT_NODE_CAP = 2000000;

function clampLimit(limit) {
  return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : Infinity;
}

// --------------------------------------------------------------------------- the DP ----
// State: the vector of partial column sums after the first y rows have been filled.
// Transition: choose a subset of columns for row y whose *column* weights (x+1) sum to
// rows[y]; each chosen column x then takes the *row* weight (y+1) into its partial sum.
// Prune any state whose partial sum passes its clue (weights only grow). At the end, the
// states whose vector equals the column clue vector exactly are the solutions.
//
// This is why 8x8 and larger are out of scope (spec 6): the state is a c-dimensional vector.
export function countSolutionsDP(lot, { limit = 2, ignoreRows = null, ignoreCols = null, stateCap = DEFAULT_STATE_CAP } = {}) {
  const { r, c, rows, cols } = lot;
  const dropR = ignoreRows || [];
  const dropC = ignoreCols || [];
  const cap = clampLimit(limit);
  const subsets = [];
  for (let s = 0; s <= (c * (c + 1)) / 2; s++) subsets[s] = [];
  const all = [];
  for (let m = 0; m < (1 << c); m++) {
    let w = 0;
    const hits = [];
    for (let x = 0; x < c; x++) if (m & (1 << x)) { w += x + 1; hits.push(x); }
    all.push(hits);
    subsets[w].push(hits);
  }
  const anySubset = all;

  let cur = new Map();
  cur.set('', 1);
  let states = 1;
  for (let y = 0; y < r; y++) {
    const freeRow = dropR.includes(y);
    const allowed = freeRow ? anySubset : subsets[rows[y]] || [];
    const next = new Map();
    for (const [key, count] of cur) {
      const v = y === 0 ? new Array(c).fill(0) : key.split(',').map(Number);
      for (const hits of allowed) {
        const nv = v.length === c ? v.slice() : new Array(c).fill(0);
        let bad = false;
        // A cell in row y contributes the ROW weight (y+1) to its column's sum. Getting this
        // wrong (adding the column's own weight instead) is the one bug that makes a DP
        // counter silently return 0 for almost every real puzzle — and it is exactly the bug
        // sitting unused in the brief's own probe5.mjs `kakurasuDp`. test/count.test.mjs
        // pins it with a hand-computed 4x4 case.
        for (const x of hits) {
          nv[x] += y + 1;
          if (!dropC.includes(x) && nv[x] > cols[x]) { bad = true; break; }
        }
        if (bad) continue;
        const nk = nv.join(',');
        const before = next.get(nk) || 0;
        const merged = before + count;
        next.set(nk, Number.isFinite(cap) && merged > cap ? cap : merged);
      }
    }
    cur = next;
    if (cur.size > states) states = cur.size;
    if (cur.size > stateCap) return { count: 0, bailed: true, states: cur.size, reason: 'state-cap' };
    if (cur.size === 0) return { count: 0, bailed: false, states: 0 };
  }

  let total = 0;
  for (const [key, count] of cur) {
    const v = key.split(',').map(Number);
    if (v.length !== c) continue;
    let ok = true;
    for (let x = 0; x < c; x++) {
      if (dropC.includes(x)) continue;
      if (v[x] !== cols[x]) { ok = false; break; }
    }
    if (ok) {
      total += count;
      if (total >= cap) return { count: cap, bailed: false, states };
    }
  }
  return { count: total, bailed: false, states };
}

// ------------------------------------------------------------------ the backtracking ----
// Deliberately a different shape: one cell at a time, row-major, no subset enumeration, no
// shared state vectors. It only shares the *rules* with the DP, never the machinery, which
// is what makes an agreement between the two worth something.
export function countSolutionsBacktrack(lot, { limit = 2, ignoreRows = null, ignoreCols = null, nodeCap = DEFAULT_NODE_CAP, onSolution = null } = {}) {
  const { r, c, rows, cols } = lot;
  const dropR = ignoreRows || [];
  const dropC = ignoreCols || [];
  const cap = clampLimit(limit);
  const cells = new Array(r * c).fill(0);
  const rowAcc = new Array(r).fill(0);
  const colAcc = new Array(c).fill(0);
  // What a line can still collect from here on: used for the "too small to reach" prune,
  // the mirror of the "already too big" one. Both are arithmetic on 1-based weights.
  const tailRowWeight = (from) => {
    let s = 0;
    for (let x = from; x < c; x++) s += x + 1;
    return s;
  };
  let found = 0;
  let nodes = 0;
  let bailed = false;

  function walk(y, x) {
    if (bailed || found >= cap) return;
    if (y === r) {
      found += 1;
      if (onSolution) onSolution(cells.slice());
      return;
    }
    nodes += 1;
    if (nodes > nodeCap) { bailed = true; return; }
    const nextY = x === c - 1 ? y + 1 : y;
    const nextX = x === c - 1 ? 0 : x + 1;
    for (const value of [1, 0]) {
      const rowLeft = c - 1 - x;
      if (value) {
        cells[y * c + x] = MARKED;
        rowAcc[y] += x + 1;
        colAcc[x] += y + 1;
      } else {
        cells[y * c + x] = 0;
      }
      // An ignored clue imposes nothing at all: no upper bound, no "must still be reachable"
      // bound, no closing equality. Pretending otherwise would make a dropped clue look like
      // it still constrained the search, and the redundancy test would pass for the wrong
      // reason (test/count.test.mjs drives this with a hand-built ambiguous pair).
      const rowOk = dropR.includes(y) || (rowAcc[y] <= rows[y] && rowAcc[y] + tailRowWeight(x + 1) >= rows[y]);
      const colOk = dropC.includes(x) || (colAcc[x] <= cols[x] && colAcc[x] + tailColWeight(y) >= cols[x]);
      const rowClosed = x !== c - 1 || dropR.includes(y) || rowAcc[y] === rows[y];
      if (rowOk && colOk && rowClosed) walk(nextY, nextX);
      if (value) {
        rowAcc[y] -= x + 1;
        colAcc[x] -= y + 1;
      }
      cells[y * c + x] = 0;
    }
  }

  // sum of weights still available in column x below row y (1-based row indices)
  function tailColWeight(y) {
    let s = 0;
    for (let k = y + 1; k < r; k++) s += k + 1;
    return s;
  }

  walk(0, 0);
  return { count: found, bailed, nodes };
}

// Convenience: is this clue pair provably unique? Requires the *exact* answer, so no limit
// saturation and no bail may have happened. This is the single gate every published lot and
// every re-derived baked lot goes through.
export function isUnique(lot, opts = {}) {
  const dp = countSolutionsDP(lot, { limit: 2, ...opts });
  if (dp.bailed || dp.count !== 1) return { unique: false, dp, bt: null };
  const bt = countSolutionsBacktrack(lot, { limit: 2, ...opts });
  return { unique: !bt.bailed && bt.count === 1, dp, bt };
}

// The answer grid itself, via the backtracking route. bake uses this, so the printed
// solution string is produced by the solver rather than copied from the generator's dice.
export function findSolution(lot) {
  let hit = null;
  const res = countSolutionsBacktrack(lot, { limit: 1, onSolution: (cells) => { hit = cells; } });
  return hit;
}

export function findSolutions(lot, limit = 2) {
  const out = [];
  countSolutionsBacktrack(lot, { limit, onSolution: (cells) => out.push(cells) });
  return out;
}

// How many clues of this lot actually carry information? For each of the r+c clues, drop it
// and re-count: a *redundant* clue leaves the puzzle unique anyway, and per spec 2 such a
// lot must not ship (its difficulty number would be fake). Returns one entry per clue.
export function clueLoadBearing(lot, { skipRows = [], skipCols = [], nodeCap = 10000, stateCap = 200000 } = {}) {
  const probe = (kind, index) => {
    const ignoreRows = kind === 'row' ? skipRows.concat([index]) : skipRows;
    const ignoreCols = kind === 'col' ? skipCols.concat([index]) : skipCols;
    // The cell-by-cell search answers "are there at least two?" fast when the answer is yes,
    // but it can wander when the relaxed puzzle is nearly empty of solutions. The subset DP
    // is the opposite: it never stops early, yet its state space stays small. Trying the
    // cheap route first and falling back means a bail really means "both gave up".
    const bt = countSolutionsBacktrack(lot, { limit: 2, ignoreRows, ignoreCols, nodeCap });
    if (!bt.bailed) {
      return { kind, index, clue: kind === 'row' ? lot.rows[index] : lot.cols[index], count: bt.count, bailed: false, via: 'backtrack', nodes: bt.nodes, loadBearing: bt.count >= 2 };
    }
    const dp = countSolutionsDP(lot, { limit: 2, ignoreRows, ignoreCols, stateCap });
    return {
      kind,
      index,
      clue: kind === 'row' ? lot.rows[index] : lot.cols[index],
      count: dp.count,
      bailed: dp.bailed,
      via: 'dp',
      states: dp.states,
      loadBearing: !dp.bailed && dp.count >= 2,
    };
  };
  const report = [];
  for (let y = 0; y < lot.r; y++) if (!skipRows.includes(y)) report.push(probe('row', y));
  for (let x = 0; x < lot.c; x++) if (!skipCols.includes(x)) report.push(probe('col', x));
  return report;
}

// Greedy inclusion-minimal *core* of the clue set: drop clues one at a time, in a fixed
// order (rows then columns, by index), whenever the puzzle stays provably unique without it.
// Deterministic, so the same clue pair always yields the same core and the same `clues`
// count. The core is what the falsification test runs on: by construction every clue that
// survives is load-bearing, i.e. dropping it alone gives >=2 solutions -- while the FULL
// Kakurasu clue set is not, which is the finding recorded in DESIGN.md 2.4.
export function minimalCore(lot, { nodeCap = 10000, dpStateCap = 60000 } = {}) {
  let dropR = [];
  let dropC = [];
  let bounded = false;
  for (let y = 0; y < lot.r; y++) {
    const res = countSolutionsDP(lot, { limit: 2, ignoreRows: dropR.concat([y]), ignoreCols: dropC, stateCap: dpStateCap });
    if (res.bailed) bounded = true;
    else if (res.count === 1) dropR.push(y);
  }
  for (let x = 0; x < lot.c; x++) {
    const res = countSolutionsDP(lot, { limit: 2, ignoreRows: dropR, ignoreCols: dropC.concat([x]), stateCap: dpStateCap });
    if (res.bailed) bounded = true;
    else if (res.count === 1) dropC.push(x);
  }
  // Verifying the result means one exhaustive "is it still unique without this clue?" search
  // per surviving clue. If an earlier drop test already gave up, that verification would be
  // reporting on a core the greedy never really finished, and it is also the expensive half:
  // so a bail short-circuits to 'bounded' and the check is skipped.
  if (bounded) {
    return { dropped: { rows: dropR, cols: dropC }, size: lot.r + lot.c - dropR.length - dropC.length, minimality: 'bounded', bounded: true, report: [] };
  }
  const load = clueLoadBearing(lot, { skipRows: dropR, skipCols: dropC, nodeCap });
  const bounded2 = load.some((l) => l.bailed);
  const verdict = bounded2 ? 'bounded' : (load.every((l) => l.loadBearing) ? 'holds' : 'failed');
  return {
    dropped: { rows: dropR, cols: dropC },
    size: lot.r + lot.c - dropR.length - dropC.length,
    minimality: verdict,
    bounded: bounded2,
    report: load,
  };
}
