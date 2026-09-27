// The content pipeline: prove the counters on an exhaustive space, measure the difficulty
// distribution, publish the campaign, then re-derive every printed number from the serialised
// clue pair — and fail the build if one of them does not come back the same.
//
// This is where the expensive maths is allowed to happen. A click in the game never reaches
// any of it: the shipped rows are the output, and `js/core/library.js` reads them.
//
//   node tools/bake.mjs                  # writes js/data/lots.js
//   PER_BAND=16 node tools/bake.mjs      # longer campaign
//   PROBE=200 node tools/bake.mjs        # bigger rank-measurement sample
//
// Phases, each one printing what it measured:
//   1  prove     — the 4x4 closure identity, two independent class counts, DP == backtracking
//                  == exhaustive enumeration. Cheap (a few hundred ms) and it is the external
//                  evidence that `solutions: 1` on every row below means something.
//   2  measure   — the rank distribution of each board size, from live generation.
//   3  publish   — fill each band, re-verify every row, record the clue-minimisation result.
//   4  write     — js/data/lots.js, including the proof block and the measured envelopes.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TIERS, makeLot, blankStats, rankOf, SOLVER_NODE_CAP } from '../js/core/make.js';
import { countSolutionsDP, countSolutionsBacktrack, minimalCore } from '../js/core/count.js';
import { analyse } from '../js/core/logic.js';
import { validateLot, cluesOf, formatGrid, parseGrid, markCount } from '../js/core/grid.js';
import { closureIdentity } from '../test/anchorlib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PER_BAND = Number(process.env.PER_BAND || 10);
const PROBE = Number(process.env.PROBE || 120);

const t0 = Date.now();
const ms = () => ((Date.now() - t0) / 1000).toFixed(1);

// ---- phase 1: prove the counters on the whole 4x4 space --------------------------------
const proof = closureIdentity(4);
console.log(`[1/4] proof 4x4: sum-of-class-sizes=${proof.sum} classes=${proof.classes} unique=${proof.unique} multi=${proof.multi} ${ms()}s`);
if (proof.sum !== 65536) throw new Error(`closure identity broken: ${proof.sum} != 65536`);
if (proof.classes !== proof.classesBySubset) throw new Error(`the two class-counting routes disagree: ${proof.classes} vs ${proof.classesBySubset}`);
// the exact values the brief measured; if one of these moves, a counter changed under us
if (proof.classes !== 64959 || proof.unique !== 64382 || proof.multi !== 577) {
  throw new Error(`anchor drift: classes=${proof.classes} unique=${proof.unique} multi=${proof.multi}`);
}
const cross = proof.agree;
console.log(`[1/4] DP==backtracking==brute force on ${cross.n} sampled classes: ${cross.agreed}/${cross.n} agreed`);
if (cross.agreed !== cross.n) throw new Error('the counters disagree on sampled classes');

// ---- phase 2: measure the difficulty distribution of each board size -------------------
// `rank` is depth*100 + chains, both measured by js/core/logic.js on the clue pair.
const measured = {};
for (const tier of TIERS) {
  const ranks = [];
  const stats = blankStats();
  const start = Date.now();
  let seed = 0;
  while (ranks.length < PROBE && seed < PROBE * 20) {
    const lot = makeLot(`measure-${tier.key}-${seed++}`, tier, { stats, withCore: false, band: null });
    if (lot) ranks.push(rankOf(lot));
  }
  ranks.sort((a, b) => a - b);
  const q = (p) => ranks[Math.min(ranks.length - 1, Math.floor(p * ranks.length))];
  measured[tier.key] = {
    ranks,
    n: ranks.length,
    min: ranks[0],
    max: ranks[ranks.length - 1],
    p50: q(0.5),
    p75: q(0.75),
    p90: q(0.9),
    assumeRate: ranks.filter((r) => r >= 100).length / ranks.length,
    msPerLot: ((Date.now() - start) / ranks.length).toFixed(1),
    rejected: stats.attempted - stats.accepted,
  };
  console.log(`[2/4] ${tier.key} ${tier.r}x${tier.c}: ranks n=${ranks.length} min=${ranks[0]} p50=${q(0.5)} p75=${q(0.75)} p90=${q(0.9)} max=${ranks[ranks.length - 1]} needs-assumption=${(100 * measured[tier.key].assumeRate).toFixed(1)}% ${measured[tier.key].msPerLot} ms/lot`);
}

// ---- the ladder ------------------------------------------------------------------------
// Cut from the measurements above, with no hand-typed numbers. A band is a rank interval; the
// four must be contiguous and strictly increasing (so the campaign really does get harder),
// and each tier must be able to *fill* its own band: at least FEASIBLE of its sampled lots
// have to land inside it, or the cut is rejected and the search moves on. That last clause is
// where the difficulty claim is falsified or confirmed -- a band nobody can reach is not a
// difficulty, it is a build that never finishes.
const FEASIBLE = Number(process.env.FEASIBLE || 0.06);
const pool = [...new Set(TIERS.flatMap((t) => measured[t.key].ranks))].sort((a, b) => a - b);
const massIn = (tierKey, lo, hi) => {
  const ranks = measured[tierKey].ranks;
  const n = ranks.filter((r) => r >= lo && r <= hi).length;
  return n / ranks.length;
};

function findCuts() {
  const tops = pool.filter((v) => v >= 1);
  for (const c1 of tops) {
    if (c1 >= tops[tops.length - 1]) break;
    if (massIn(TIERS[0].key, pool[0], c1) < FEASIBLE) continue;
    for (const c2 of tops) {
      if (c2 <= c1 || c2 >= tops[tops.length - 1]) continue;
      if (massIn(TIERS[1].key, c1 + 1, c2) < FEASIBLE) continue;
      for (const c3 of tops) {
        if (c3 <= c2) continue;
        if (massIn(TIERS[2].key, c2 + 1, c3) < FEASIBLE) continue;
        if (massIn(TIERS[3].key, c3 + 1, Infinity) < FEASIBLE) continue;
        return [c1, c2, c3];
      }
    }
  }
  return null;
}

const cuts = findCuts();
if (!cuts) throw new Error(`no difficulty ladder is reachable at ${FEASIBLE * 100}% fill for all four sizes`);
let floor = pool[0];
TIERS.forEach((t, i) => {
  const hi = i === TIERS.length - 1 ? Infinity : cuts[i];
  t.band = [floor, hi];
  floor = hi + 1;
  const m = measured[t.key];
  if (massIn(t.key, t.band[0], t.band[1]) < FEASIBLE) {
    throw new Error(`${t.key}: band [${t.band}] has no measurable fill`);
  }
});
console.log(`[2/4] ladder: cuts at rank ${cuts.join(', ')} (from ${TIERS.map((t) => measured[t.key].ranks.length).join('/')} sampled lots)`);
console.log(`[2/4] fill:   ${TIERS.map((t) => `${t.key}=${(100 * massIn(t.key, t.band[0], t.band[1])).toFixed(0)}%`).join(' ')}`);

// ---- phase 3: publish and re-verify -----------------------------------------------------
const stats = blankStats();
const out = [];
for (const tier of TIERS) {
  let seed = 0;
  let tries = 0;
  while (out.filter((o) => o.tier === tier.key).length < PER_BAND && tries < PER_BAND * 60) {
    tries += 1;
    const lot = makeLot(`lot-${tier.key}-${seed++}`, tier, { stats, band: tier.band, withCore: true });
    if (!lot) continue;
    const row = {
      id: `${tier.key}-${String(out.filter((o) => o.tier === tier.key).length + 1).padStart(2, '0')}`,
      tier: tier.key,
      r: lot.r,
      c: lot.c,
      rows: lot.rows,
      cols: lot.cols,
      solution: formatGrid(lot.solution, lot.r, lot.c),
      solutions: 1,
      depth: lot.depth,
      chains: lot.chains,
      backtracks: lot.backtracks,
      nodes: lot.nodes,
      rank: rankOf(lot),
      clues: lot.clues,
      coreSize: lot.coreSize,
      coreStatus: lot.coreStatus,
      coreDropped: lot.coreDropped,
      marks: markCount(lot.solution),
    };
    verifyRow(row, stats);
    out.push(row);
  }
  const made = out.filter((o) => o.tier === tier.key).length;
  if (made < PER_BAND) throw new Error(`${tier.key}: only ${made}/${PER_BAND} lots found in ${tries} attempts (band ${tier.band})`);
  console.log(`[3/4] ${tier.key}: ${made} lots in ${tries} generator runs ${ms()}s`);
}

// One more independent pass over the finished list, after every row has been through
// `verifyRow` — the point is that nothing shares state between the two.
for (const row of out) {
  const lot = { r: row.r, c: row.c, rows: row.rows, cols: row.cols };
  const dp = countSolutionsDP(lot, { limit: 2 });
  if (dp.bailed || dp.count !== row.solutions) throw new Error(`${row.id}: second opinion says ${JSON.stringify(dp)}`);
}

function verifyRow(row, st) {
  const lot = { r: row.r, c: row.c, rows: row.rows.slice(), cols: row.cols.slice() };
  const v = validateLot({ ...lot, cells: row.solution ? parseGrid(row.solution, row.r, row.c) : null });
  if (!v.ok) throw new Error(`${row.id}: invalid lot ${JSON.stringify(v.errors)}`);
  // the answer grid must itself reproduce the clue pair, or the row is a lie about its own puzzle
  const truth = cluesOf(parseGrid(row.solution, row.r, row.c), row.r, row.c);
  if (JSON.stringify(truth.rows) !== JSON.stringify(row.rows) || JSON.stringify(truth.cols) !== JSON.stringify(row.cols)) {
    throw new Error(`${row.id}: solution grid does not sum to its own clues`);
  }
  // re-derive the printed count from the serialised clues, with both counters
  const dp = countSolutionsDP(lot, { limit: 2 });
  if (dp.bailed) throw new Error(`${row.id}: DP bailed (states ${dp.states})`);
  if (dp.count !== 1) throw new Error(`${row.id}: claims solutions 1, the DP counts ${dp.count}`);
  const bt = countSolutionsBacktrack(lot, { limit: 2 });
  if (bt.bailed || bt.count !== 1) throw new Error(`${row.id}: the backtracker says ${JSON.stringify(bt)}`);
  // re-derive the printed difficulty
  const an = analyse(lot, { nodeCap: SOLVER_NODE_CAP });
  if (an.capped || !an.solved) throw new Error(`${row.id}: the solver cannot re-measure this lot ${JSON.stringify(an)}`);
  for (const key of ['depth', 'chains', 'backtracks', 'nodes']) {
    if (an[key] !== row[key]) throw new Error(`${row.id}: printed ${key}=${row[key]}, re-measured ${an[key]}`);
  }
  if (row.rank !== rankOf(an)) throw new Error(`${row.id}: rank ${row.rank} is not depth*100+chains`);
  if (row.marks !== markCount(parseGrid(row.solution, row.r, row.c))) throw new Error(`${row.id}: marks/par mismatch`);
  // the minimisation record: 'holds' means every surviving clue of the core was proven
  // load-bearing; 'bounded' means the search gave up and the number is an upper bound only.
  if (row.coreStatus === 'holds') {
    const core = minimalCore(lot);
    if (core.minimality !== 'holds' || core.size !== row.coreSize) {
      throw new Error(`${row.id}: core re-measurement disagrees ${core.minimality}/${core.size} vs ${row.coreStatus}/${row.coreSize}`);
    }
  } else if (row.coreStatus !== 'bounded') {
    throw new Error(`${row.id}: unexpected coreStatus ${row.coreStatus}`);
  }
  st.maxDpStates = Math.max(st.maxDpStates, dp.states);
}

// ---- phase 4: write ---------------------------------------------------------------------
const meta = TIERS.map((tier) => {
  const mine = out.filter((l) => l.tier === tier.key);
  const ranks = mine.map((l) => l.rank);
  return {
    key: tier.key,
    label: tier.label,
    r: tier.r,
    c: tier.c,
    band: [tier.band[0], tier.band[1] === Infinity ? 9999 : tier.band[1]],
    rankMin: Math.min(...ranks),
    rankMax: Math.max(...ranks),
    depthMin: Math.min(...mine.map((l) => l.depth)),
    depthMax: Math.max(...mine.map((l) => l.depth)),
    chainsMin: Math.min(...mine.map((l) => l.chains)),
    chainsMax: Math.max(...mine.map((l) => l.chains)),
    backtracksMax: Math.max(...mine.map((l) => l.backtracks)),
    coreVerified: mine.filter((l) => l.coreStatus === 'holds').length,
    coreBounded: mine.filter((l) => l.coreStatus === 'bounded').length,
    lots: mine.length,
    measured: measured[tier.key],
    blurb: `推理 ${Math.min(...ranks)}${Math.max(...ranks) > Math.min(...ranks) ? '-' + Math.max(...ranks) : ''} · ${tier.r}×${tier.c}`,
  };
});

const lines = [
  '// Generated by tools/bake.mjs — every number in this file is a measurement, and',
  '// `node test/lots.test.mjs` re-derives all of them from the clue pairs below. Do not',
  '// hand-edit: a row whose printed `solutions`/`depth`/`chains`/`backtracks`/`nodes` does',
  '// not come back out of `rows`+`cols` fails the build in tools/bake.mjs AND in the test.',
  '//',
  '//   solutions  : counted twice, by the subset DP and by the cell-by-cell backtracker',
  '//                (js/core/count.js). Only 1 is published.',
  '//   depth      : assumption layers the deterministic solver (js/core/logic.js) needed',
  '//   chains     : propagation rounds on the hardest surviving line of play',
  '//   backtracks : contradictions it hit and undid,  nodes : search steps (cap ' + SOLVER_NODE_CAP + ')',
  '//   rank       : depth*100 + chains, the number the difficulty bands are cut on',
  '//   coreSize   : size of an inclusion-minimal subset of the clues that still pins this',
  '//                board. "holds" = proven, every clue left in it is load-bearing;',
  '//                "bounded" = the search hit its ceiling, so this is an upper bound.',
  '//                The FULL Kakurasu clue set is never minimal — see DESIGN.md 2.4.',
  `export const PROOF = ${JSON.stringify({ ...proof, agree: { n: cross.n, agreed: cross.agreed } })};`,
  `export const TIERS_META = ${JSON.stringify(meta)};`,
  'export const LOTS = [',
  ...out.map((l) => `  ${JSON.stringify(l)},`),
  '];',
  '',
];
const path = join(root, 'js', 'data', 'lots.js');
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, lines.join('\n'));

const accept = stats.accepted / Math.max(1, stats.attempted);
console.log(`[4/4] wrote ${out.length} lots -> js/data/lots.js`);
console.log(`[4/4] generator: attempted=${stats.attempted} accepted=${stats.accepted} (${(100 * accept).toFixed(1)}%) `
  + `ambiguous=${stats.rejectAmbiguous} capped=${stats.rejectCapped} bailed=${stats.rejectBailed} band=${stats.rejectBand} `
  + `core holds=${stats.coreVerified} bounded=${stats.coreBounded} failed=${stats.coreFailed}`);
console.log(`[4/4] cost: maxDpStates=${stats.maxDpStates} maxSolverNodes=${stats.maxSearchNodes} maxCoreNodes=${stats.maxCoreNodes} wall=${ms()}s`);
console.log(`[4/4] bands shipped: ${meta.map((m) => `${m.key} ${m.rankMin}-${m.rankMax} (depth ${m.depthMin}-${m.depthMax})`).join(' | ')}`);
