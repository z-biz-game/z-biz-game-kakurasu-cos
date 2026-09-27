// The generator, and the difficulty bands it fills. Both are measurements: a lot is only a
// candidate if two independent counters agree that it has exactly one solution, and it is
// only *published* in a band if the deterministic solver in logic.js can print a real
// reasoning figure for it under a bounded budget.
//
// Acceptance, in order, with a counter for every rejection reason (tools/bake.mjs prints all
// of them, so the accept rate in DESIGN.md is a number a maintainer can re-run):
//
//   1. draw a random 0/1 grid, read its clue pair off it            (grid.js cluesOf)
//   2. count solutions with the subset DP, limit 2 -> must be exactly 1
//   3. count again with the cell-by-cell backtracker, limit 2 -> must agree  [ambiguity]
//   4. run the deterministic solver under a node cap -> depth/chains/backtracks
//      must exist and the cap must not have been hit                        [capped]
//   5. the measured (depth, chains) must land in the tier's band             [band]
//   6. measure the inclusion-minimal core of the clue set (recorded, never a
//      gate — see the comment on `coreStatus`, and DESIGN.md 2.4 for why the
//      full Kakurasu clue set can never be minimal)
//
// Nothing here is unbounded: every loop has an attempt ceiling and every counter has a cap.
// That is what makes it survivable to call `makeLot` from a browser (the #/random route does);
// the exhaustive 2^(r*c) enumeration stays in test/anchorlib.mjs, out of every shipped path.
//
// Pure module: no window, no document.

import { rngFrom, hashSeed } from './rng.js';
import { cluesOf, validateLot, MARKED } from './grid.js';
import { countSolutionsDP, countSolutionsBacktrack, minimalCore, findSolution } from './count.js';
import { analyse } from './logic.js';

// Difficulty bands, by name and board size. `band` is the *measured* envelope each tier is
// filled from, written by tools/bake.mjs into js/data/lots.js as TIERS_META and re-read here
// through js/core/library.js. The placeholder [0, 0] below means "not measured yet":
// makeLot refuses to band-filter against it, so nothing can silently ship unmeasured.
export const TIERS = [
  { key: 'shoal', label: '浅滩', en: 'SHOAL', r: 4, c: 4, band: [0, 0], blurb: '4×4' },
  { key: 'linked', label: '连环', en: 'LINKED', r: 5, c: 5, band: [0, 0], blurb: '5×5' },
  { key: 'twined', label: '交缠', en: 'TWINED', r: 6, c: 6, band: [0, 0], blurb: '6×6' },
  { key: 'master', label: '迷阵', en: 'MASTER', r: 7, c: 7, band: [0, 0], blurb: '7×7' },
];

export const MAX_ATTEMPTS = 400;
// Budgets. Deliberately small: a lot the solver cannot measure inside these is not published,
// rather than published with a number from an unfinished search.
export const SOLVER_NODE_CAP = 4000;
export const CORE_NODE_CAP = 10000;

export function tierByKey(key) {
  return TIERS.find((t) => t.key === key) || TIERS[0];
}

// The single printed difficulty number. depth dominates because an assumption really is a
// different kind of puzzle than a longer chain; within one depth, chains (propagation rounds)
// order the rest. Pure arithmetic on measured values, so `rank` can be re-derived anywhere.
export function rankOf(measure) {
  return measure.depth * 100 + measure.chains;
}

export function blankStats() {
  return {
    attempted: 0, accepted: 0,
    rejectAmbiguous: 0, rejectBailed: 0, rejectCapped: 0, rejectBand: 0, rejectInvalid: 0, rejectUnsolvable: 0,
    coreVerified: 0, coreBounded: 0, coreFailed: 0,
    maxDpStates: 0, maxSearchNodes: 0, maxCoreNodes: 0,
    msTotal: 0,
  };
}

function rollGrid(rng, r, c) {
  // A uniform random board. Density is fixed at 1/2 on purpose: 数和格's clue map is injective
  // for ~98% of boards at 4x4, so a biased density would only skew which clue values appear,
  // and every bias would have to be documented as a choice rather than a measurement.
  const cells = new Array(r * c);
  for (let i = 0; i < cells.length; i++) cells[i] = rng() < 0.5 ? MARKED : 0;
  return cells;
}

// One candidate lot, fully checked. Returns { lot, measure, core } or { reject: 'reason' }.
export function evaluateClues(r, c, rows, cols, { core = false, stats = null } = {}) {
  const t0 = Date.now();
  const lot = { r, c, rows: rows.slice(), cols: cols.slice() };
  const v = validateLot({ ...lot, cells: null });
  if (!v.ok) return { reject: 'invalid', errors: v.errors };
  const dp = countSolutionsDP(lot, { limit: 2 });
  if (dp.bailed) return { reject: 'bailed', dp };
  if (dp.count !== 1) return { reject: 'ambiguous', dp };
  const bt = countSolutionsBacktrack(lot, { limit: 2 });
  if (bt.bailed) return { reject: 'bailed', dp, bt };
  if (bt.count !== 1) return { reject: 'ambiguous', dp, bt };
  const measure = analyse(lot, { nodeCap: SOLVER_NODE_CAP });
  if (!measure.solved) return { reject: 'unsolvable', measure };
  if (measure.capped) return { reject: 'capped', measure };
  // The answer grid is produced by the counter's own walk, never copied from the dice that
  // generated the clue pair: if the two routes disagreed about *which* board solves it, the
  // shipped `solution` string would be a second opinion rather than a measurement.
  const solution = findSolution(lot);
  if (!solution) return { reject: 'unsolvable', measure };
  const out = { lot: { ...lot, solution }, measure, dp, bt };
  if (core) {
    const core1 = minimalCore(out.lot, { nodeCap: CORE_NODE_CAP });
    out.core = core1;
    out.lot.coreSize = core1.size;
    out.lot.coreStatus = core1.minimality;
    out.lot.coreDropped = core1.dropped;
  }
  out.millis = Date.now() - t0;
  if (stats) {
    stats.maxDpStates = Math.max(stats.maxDpStates, dp.states || 0);
    stats.maxSearchNodes = Math.max(stats.maxSearchNodes, measure.nodes || 0);
    if (out.core) stats.maxCoreNodes = Math.max(stats.maxCoreNodes, coreMaxNodes(out));
  }
  return out;
}

function coreMaxNodes(out) {
  return out.core.report.reduce((m, o) => Math.max(m, o.nodes || 0), 0);
}

// ------------------------------------------------------------------------ the generator ----
export function makeLot(seed, tier, { stats = blankStats(), band = null, withCore = false } = {}) {
  const t = typeof tier === 'string' ? tierByKey(tier) : tier;
  const rng = rngFrom(seed);
  const envelope = band || t.band;
  const measured = !!(envelope && (envelope[0] || envelope[1]));
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    stats.attempted += 1;
    const cells = rollGrid(rng, t.r, t.c);
    const { rows, cols } = cluesOf(cells, t.r, t.c);
    const res = evaluateClues(t.r, t.c, rows, cols, { core: withCore, stats });
    if (res.reject) {
      if (res.reject === 'ambiguous') stats.rejectAmbiguous += 1;
      else if (res.reject === 'bailed') stats.rejectBailed += 1;
      else if (res.reject === 'capped') stats.rejectCapped += 1;
      else if (res.reject === 'unsolvable') stats.rejectUnsolvable += 1;
      else stats.rejectInvalid += 1;
      continue;
    }
    const rank = rankOf(res.measure);
    if (measured && (rank < envelope[0] || rank > envelope[1])) {
      stats.rejectBand += 1;
      continue;
    }
    if (res.core) {
      if (res.core.minimality === 'holds') stats.coreVerified += 1;
      else if (res.core.minimality === 'bounded') stats.coreBounded += 1;
      else stats.coreFailed += 1;
    }
    stats.accepted += 1;
    stats.msTotal += res.millis || 0;
    stats.maxSearchNodes = Math.max(stats.maxSearchNodes, res.measure.nodes);
    return {
      id: `${t.key}-${String(seed).slice(-6)}-${attempt}`,
      tier: t.key,
      r: t.r,
      c: t.c,
      rows: res.lot.rows,
      cols: res.lot.cols,
      solution: res.lot.solution,
      solutions: 1,
      depth: res.measure.depth,
      chains: res.measure.chains,
      backtracks: res.measure.backtracks,
      nodes: res.measure.nodes,
      rank,
      coreSize: res.lot.coreSize === undefined ? null : res.lot.coreSize,
      coreStatus: res.lot.coreStatus || 'skipped',
      coreDropped: res.lot.coreDropped || null,
      clues: t.r + t.c,
    };
  }
  stats.rejectExhausted = (stats.rejectExhausted || 0) + 1;
  return null;
}

// A deterministic clue pair for the daily board: the date string is the seed, so every device
// on the same calendar day gets the same puzzle. The search below is the *bounded* one, so a
// page load never runs an open-ended search — see the header comment and DESIGN.md 3.
export function lotKeyFor(seed, tierKey) {
  return `${tierKey}:${hashSeed(String(seed))}`;
}

export function dailyLot(dateKey, tiers = TIERS, opts = {}) {
  const h = hashSeed(String(dateKey));
  const tier = tiers[h % tiers.length];
  const seed = `daily:${dateKey}:${tier.key}`;
  return makeLot(seed, tier, opts);
}

