// The measuring stick for difficulty: a deterministic human-style solver, and the numbers it
// prints while solving.
//
// Uniqueness (count.js) says *whether* a puzzle can be solved. This file says *how hard* it
// was, and the answer is a measurement of a real algorithm rather than a label somebody
// chose:
//
//   depth      — how many assumptions the solver had to stack at its deepest.
//                0 means pure propagation solved it: every cell fell out of the clues with no
//                guessing at all. This is what the difficulty bands are cut from.
//   chains     — propagation rounds along the hardest surviving line of play, i.e. how long
//                the inference chain had to run before the board was determined.
//   backtracks — how many times an assumption hit a contradiction and had to be undone.
//   nodes      — propagate() calls, i.e. the search's work. Printed by bake so a cost claim
//                can be checked rather than asserted.
//
// Determinism matters more than speed here: the same clue pair must give the same four
// numbers on every machine, forever, or tools/bake.mjs cannot re-derive the printed
// difficulty. So: fixed line order (rows then columns, by index), fixed branch order (marked
// before empty), fixed cell choice (fewest live candidates, then lowest index), no clock, no
// RNG, and no dependence on insertion order of any Map/Set.
//
// The propagation rules are the two a human uses on a 数和格 board:
//   * a cell that every way-of-making-the-clue includes  -> mark it
//   * a cell that no way-of-making-the-clue includes     -> clear it
// and a line whose marked weights already pass its clue is a flat contradiction.
//
// Pure module: no window, no document. Every entry point copies its input; nothing here
// mutates a caller's array (test/logic.test.mjs holds it to that).

import { MARKED, EMPTY, UNKNOWN, statusOf } from './grid.js';

// Player cells are 0 = undecided, 1 = marked, 2 = noted-out (a cross: known empty).
// The solver wants 0 = known empty, 1 = marked, -1 = still open.
export function toSolverState(cells) {
  return cells.map((v) => (v === 1 ? MARKED : v === 2 ? EMPTY : UNKNOWN));
}

// Candidates for one line: which subsets of the still-unknown weights hit `need` exactly.
// Weights are 1-based positions, so a line of length n has weights 1..n and at most 2^n
// subsets — 256 at n=8 — which is why this stays cheap and needs no memoisation.
// Returns { masks, forced, dead, none }: `forced` are positions present in *every* mask,
// `dead` positions present in *none*.
export function lineCandidates(unknowns, need) {
  const n = unknowns.length;
  if (need < 0) return { masks: [], forced: [], dead: unknowns.map((u) => u.pos), none: true };
  const masks = [];
  const seen = new Array(n).fill(0);
  const total = 1 << n;
  for (let m = 0; m < total; m++) {
    let s = 0;
    for (let i = 0; i < n; i++) if (m & (1 << i)) s += unknowns[i].weight;
    if (s !== need) continue;
    masks.push(m);
    for (let i = 0; i < n; i++) if (m & (1 << i)) seen[i] += 1;
    if (masks.length >= 4096) break; // hard bound; unreachable at n <= 8 but never loop-open
  }
  const forced = [];
  const dead = [];
  for (let i = 0; i < n; i++) {
    if (masks.length === 0) dead.push(unknowns[i].pos);
    else if (seen[i] === masks.length) forced.push(unknowns[i].pos);
    else if (seen[i] === 0) dead.push(unknowns[i].pos);
  }
  return { masks, forced, dead, none: masks.length === 0 };
}

// One pass over every line, mutating `state`. Returns { contradiction, forced }.
// Exported for the tests and for the view's "what changed this round" highlight; every other
// entry point in this file copies before calling it.
export function propagateOnce(lot, state) {
  const { r, c } = lot;
  let forced = 0;
  let contradiction = false;
  for (let y = 0; y < r && !contradiction; y++) {
    contradiction = applyLine(state, lot.rows[y], rowCells(y, c));
  }
  for (let x = 0; x < c && !contradiction; x++) {
    contradiction = applyLine(state, lot.cols[x], colCells(x, r));
  }
  return { contradiction, forced };

  function applyLine(st, clue, cells) {
    let sum = 0;
    const unknowns = [];
    for (const cell of cells) {
      const v = st[cell.pos];
      if (v === MARKED) sum += cell.weight;
      else if (v === UNKNOWN) unknowns.push(cell);
    }
    if (sum > clue) return true;
    if (unknowns.length === 0) return clue - sum !== 0;
    const cand = lineCandidates(unknowns, clue - sum);
    if (cand.none) return true;
    for (const pos of cand.forced) if (st[pos] !== MARKED) { st[pos] = MARKED; forced += 1; }
    for (const pos of cand.dead) if (st[pos] !== EMPTY) { st[pos] = EMPTY; forced += 1; }
    return false;
  }
  function rowCells(y, width) {
    const out = [];
    for (let x = 0; x < width; x++) out.push({ pos: y * width + x, weight: x + 1 });
    return out;
  }
  function colCells(x, height) {
    const out = [];
    for (let y = 0; y < height; y++) out.push({ pos: y * height + x, weight: y + 1 });
    return out;
  }
}

// Propagation to a fixpoint. Never touches the caller's array.
// Returns { contradiction, solved, rounds, state }.
export function propagate(lot, cells) {
  const state = Array.isArray(cells) ? cells.slice() : new Array(lot.r * lot.c).fill(UNKNOWN);
  let rounds = 0;
  for (;;) {
    const res = propagateOnce(lot, state);
    if (res.contradiction) return { contradiction: true, solved: false, rounds, state };
    if (!res.forced) break;
    rounds += 1;
    if (rounds > lot.r * lot.c) return { contradiction: true, solved: false, rounds, state };
  }
  let unknown = 0;
  for (const v of state) if (v === UNKNOWN) unknown += 1;
  return { contradiction: false, solved: unknown === 0, rounds, state };
}

// How many ways can the line through this cell still be made? Small = decided soon.
function lineWidth(state, lot, kind, index, width, height) {
  let sum = 0;
  const unknowns = [];
  if (kind === 'row') {
    for (let x = 0; x < width; x++) {
      const p = index * width + x;
      if (state[p] === MARKED) sum += x + 1;
      else if (state[p] === UNKNOWN) unknowns.push({ pos: p, weight: x + 1 });
    }
    return lineCandidates(unknowns, lot.rows[index] - sum).masks.length;
  }
  for (let y = 0; y < height; y++) {
    const p = y * height + index;
    if (state[p] === MARKED) sum += y + 1;
    else if (state[p] === UNKNOWN) unknowns.push({ pos: p, weight: y + 1 });
  }
  return lineCandidates(unknowns, lot.cols[index] - sum).masks.length;
}

// Where the solver would branch next: undecided cell with the fewest live candidates, then
// lowest index. Purely a function of the state, which is what keeps `depth` reproducible.
export function branchCell(lot, state) {
  const { r, c } = lot;
  let best = null;
  for (let y = 0; y < r; y++) {
    for (let x = 0; x < c; x++) {
      const pos = y * c + x;
      if (state[pos] !== UNKNOWN) continue;
      const score = Math.min(
        lineWidth(state, lot, 'row', y, c, r),
        lineWidth(state, lot, 'col', x, c, r),
      );
      if (!best || score < best.count || (score === best.count && pos < best.pos)) best = { pos, count: score };
    }
  }
  return best;
}

// ------------------------------------------------------------------------ the analysis ----
// `lot` is { r, c, rows, cols }. Returns { solved, depth, chains, backtracks, nodes, capped }.
// capped === true means a budget ran out: those numbers are then NOT a measurement of this
// puzzle, so callers must reject the lot rather than print them. No unbounded search is
// allowed anywhere, and this one is bounded twice (nodes and depth).
export function analyse(lot, { nodeCap = 20000, depthCap = 12 } = {}) {
  const total = lot.r * lot.c;
  let nodes = 0;
  let backtracks = 0;
  let capped = false;

  function search(state) {
    nodes += 1;
    if (nodes > nodeCap) { capped = true; return null; }
    const prop = propagate(lot, state);
    if (prop.contradiction) { backtracks += 1; return null; }
    if (prop.solved) return { depth: 0, chains: prop.rounds };
    const pick = branchCell(lot, prop.state);
    if (!pick) { backtracks += 1; return null; }
    const arms = [];
    for (const value of [MARKED, EMPTY]) {
      const next = prop.state.slice();
      next[pick.pos] = value;
      const sub = search(next);
      if (sub) arms.push(sub);
      if (capped) return null;
    }
    if (arms.length === 0) { backtracks += 1; return null; }
    return {
      depth: 1 + Math.max(...arms.map((a) => a.depth)),
      chains: prop.rounds + Math.max(...arms.map((a) => a.chains)),
    };
  }

  const out = search(new Array(total).fill(UNKNOWN));
  if (out && out.depth > depthCap) {
    // Past the cap the "human solver" is just a search, and a number from that is not a
    // difficulty measurement. Say so, and let the generator reject the lot.
    return { solved: true, depth: out.depth, chains: out.chains, backtracks, nodes, capped: true };
  }
  return {
    solved: !!out,
    depth: out ? out.depth : -1,
    chains: out ? out.chains : -1,
    backtracks,
    nodes,
    capped,
  };
}

// A hint for the shell: the next cell pure propagation can prove from the player's board.
// { pos, value } to play, { contradiction: true } when the board can no longer be finished,
// or { stuck: true } when everything left needs an assumption — which the panel reports as
// "这一步之后要猜" instead of inventing a guess and calling it a hint.
export function nextDeduction(lot, cells) {
  const { r, c } = lot;
  const state = toSolverState(cells);
  // A board whose every line already sums to its clue is finished: nothing is left to deduce,
  // and telling the player to cross out the empties they did not mark would be noise.
  if (statusOf(lot, cells.map((v) => (v === 1 ? 1 : 0))).allOk) return { complete: true };
  const res = propagate(lot, state);
  if (res.contradiction) {
    const first = state.map((v, i) => ({ v, i })).find((o) => o.v === MARKED);
    return { contradiction: true, pos: first ? first.i : 0 };
  }
  if (res.solved) {
    for (let i = 0; i < state.length; i++) {
      if (state[i] !== res.state[i]) return { pos: i, value: res.state[i] };
    }
    return { complete: true };
  }
  // Anything the fixpoint pass decided on its own is the cheapest honest hint.
  for (let i = 0; i < state.length; i++) {
    if (state[i] === UNKNOWN && res.state[i] !== UNKNOWN) return { pos: i, value: res.state[i] };
  }
  // Nothing fell out of a single line: report a cell one assumption proves, so the panel can
  // distinguish "pure logic still works here" from "this needs a guess".
  for (let i = 0; i < state.length; i++) {
    if (state[i] !== UNKNOWN) continue;
    const probe = state.slice();
    probe[i] = MARKED;
    const markOk = !propagate(lot, probe).contradiction;
    const probe2 = state.slice();
    probe2[i] = EMPTY;
    const clearOk = !propagate(lot, probe2).contradiction;
    if (markOk && !clearOk) return { pos: i, value: MARKED };
    if (clearOk && !markOk) return { pos: i, value: EMPTY };
  }
  const pick = branchCell(lot, state);
  return { stuck: true, pos: pick ? pick.pos : -1 };
}

// How far a pure-logic player gets without ever guessing. The panel uses it to be honest
// about where the assumption in `depth` actually enters.
export function propagationOnly(lot) {
  const res = propagate(lot, new Array(lot.r * lot.c).fill(UNKNOWN));
  let left = 0;
  for (const v of res.state) if (v === UNKNOWN) left += 1;
  return { solved: res.solved && !res.contradiction, contradiction: res.contradiction, rounds: res.rounds, undecided: left };
}
