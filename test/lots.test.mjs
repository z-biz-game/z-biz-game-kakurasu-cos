// The shipped pool. This file is the anti-tamper gate: it re-derives every printed number in
// js/data/lots.js from the serialised clue pair alone and fails if a row and its own
// measurement disagree. Hand-editing a `depth` or a `solutions` field breaks the build here,
// on the same code path tools/bake.mjs used, without re-running the bake.
import { test, run, ok, eq } from '../tools/harness.mjs';
import { LOTS, TIERS_META, PROOF } from '../js/data/lots.js';
import { deserializeLot, validateLot, cluesOf, markCount, formatGrid } from '../js/core/grid.js';
import { countSolutionsDP, countSolutionsBacktrack, minimalCore } from '../js/core/count.js';
import { analyse } from '../js/core/logic.js';
import { SOLVER_NODE_CAP, rankOf, TIERS } from '../js/core/make.js';
import { ALL, byId, at, lotsIn, stats, tierByKey, dailyFromPool } from '../js/core/library.js';

const rows = ALL;

test('the pool is loaded, non-empty and shaped as promised', () => {
  ok(LOTS.length >= 24, `only ${LOTS.length} lots shipped`);
  eq(rows.length, LOTS.length);
  eq(new Set(rows.map((l) => l.id)).size, rows.length, 'duplicate lot id');
  for (const t of TIERS) eq(lotsIn(t.key).length >= 8, true, `tier ${t.key} is thin`);
});

test('every shipped lot is a valid, self-consistent board', () => {
  for (const lot of rows) {
    const v = validateLot({ ...lot, cells: lot.solution });
    ok(v.ok, `${lot.id}: ${JSON.stringify(v.errors)}`);
    eq(formatGrid(lot.solution, lot.r, lot.c).length, lot.r * lot.c + lot.r - 1);
  }
});

test('THE THESIS: every published lot has exactly one solution, counted twice', () => {
  for (const lot of rows) {
    eq(lot.solutions, 1, `${lot.id} does not even claim to be unique`);
    const dp = countSolutionsDP(lot, { limit: 2 });
    ok(!dp.bailed, `${lot.id}: the DP bailed at ${dp.states} states`);
    eq(dp.count, 1, `${lot.id}: the subset DP counts ${dp.count}`);
    const bt = countSolutionsBacktrack(lot, { limit: 2 });
    ok(!bt.bailed, `${lot.id}: the backtracker bailed at ${bt.nodes} nodes`);
    eq(bt.count, 1, `${lot.id}: the backtracker counts ${bt.count}`);
  }
});

test('the printed answer grid is the solution, not a decoration', () => {
  for (const lot of rows) {
    const truth = cluesOf(lot.solution, lot.r, lot.c);
    eq(truth.rows, lot.rows, `${lot.id} row clues`);
    eq(truth.cols, lot.cols, `${lot.id} column clues`);
    eq(lot.marks, markCount(lot.solution), `${lot.id} mark count`);
  }
});

test('the printed difficulty comes back out of the clue pair, digit for digit', () => {
  for (const lot of rows) {
    const an = analyse(lot, { nodeCap: SOLVER_NODE_CAP });
    ok(an.solved, `${lot.id}: unsolvable on re-measurement`);
    ok(!an.capped, `${lot.id}: re-measurement hit the cap`);
    for (const key of ['depth', 'chains', 'backtracks', 'nodes']) {
      eq(an[key], lot[key], `${lot.id}.${key}`);
    }
    eq(lot.rank, rankOf(an), `${lot.id}: rank is not depth*100 + chains`);
  }
});

test('the search stayed inside its stated budget on every shipped lot', () => {
  for (const lot of rows) {
    ok(lot.nodes <= SOLVER_NODE_CAP, `${lot.id} used ${lot.nodes} nodes over the cap`);
    ok(lot.depth <= 12, `${lot.id} depth ${lot.depth}`);
  }
  eq(TIERS_META.length, TIERS.length);
});

test('the minimisation record is honest about what it proved', () => {
  for (const lot of rows) {
    ok(['holds', 'bounded'].includes(lot.coreStatus), `${lot.id}: coreStatus ${lot.coreStatus}`);
    ok(lot.coreSize >= 1 && lot.coreSize <= lot.r + lot.c, `${lot.id}: coreSize ${lot.coreSize}`);
    eq(lot.clues, lot.r + lot.c);
    if (lot.coreStatus === 'holds') ok(lot.coreSize < lot.clues, `${lot.id}: a full set claimed minimal`);
  }
  // Re-measure the cheap ones end to end: 'holds' is a claim that survives a second run.
  const cheap = rows.filter((l) => l.coreStatus === 'holds' && l.r <= 5);
  ok(cheap.length >= 4, `only ${cheap.length} proven cores to re-check`);
  for (const lot of cheap) {
    const core = minimalCore(lot);
    eq(core.minimality, 'holds', lot.id);
    eq(core.size, lot.coreSize, lot.id);
  }
});

test('the four bands form a strictly increasing ladder and the pool sits inside it', () => {
  const seen = TIERS.map((t) => {
    const mine = lotsIn(t.key);
    return { key: t.key, lo: Math.min(...mine.map((l) => l.rank)), hi: Math.max(...mine.map((l) => l.rank)), meta: tierByKey(t.key) };
  });
  for (let i = 1; i < seen.length; i++) {
    ok(seen[i].lo > seen[i - 1].hi, `band ${seen[i].key} starts at ${seen[i].lo}, not above ${seen[i - 1].hi}`);
    // Depth is deliberately NOT compared across rungs: the ladder is cut on rank, and a
    // harder chain at depth 0 is a different axis from an assumption. The assumption claim is
    // made by its own test below, against the whole pool, rather than by implying it here.
    ok(seen[i].meta.rankMin >= seen[i].meta.band[0] && seen[i].meta.rankMax <= seen[i].meta.band[1]);
  }
  for (const s of seen) {
    const band = s.meta.band;
    ok(s.lo >= band[0] && s.hi <= band[1], `${s.key} shipped ranks ${s.lo}..${s.hi} outside band ${band}`);
  }
});

test('the top band actually contains boards that needed an assumption', () => {
  // depth > 0 is the only difficulty in this genre that cannot be argued about: the solver had
  // to suppose something and have it confirmed. If no shipped lot needs one, say so loudly
  // rather than implying that the bands differ in kind.
  const assuming = rows.filter((l) => l.depth > 0);
  ok(assuming.length >= 1, 'no shipped lot needed an assumption; the ladder is chains-only');
  ok(assuming.every((l) => l.tier === 'master'), JSON.stringify(assuming.map((l) => [l.id, l.depth])));
  ok(assuming.some((l) => l.backtracks > 0), 'assumption lots should also have had to undo one');
});

test('the baked proof block still matches a fresh enumeration of the 4x4 space', () => {
  // PROOF is printed by bake from test/anchorlib.mjs. Re-asserting the four anchors here means
  // a stale lots.js cannot survive just because someone skipped anchor.test.mjs.
  eq(PROOF.sum, 65536);
  eq(PROOF.classes, 64959);
  eq(PROOF.classesBySubset, 64959);
  eq(PROOF.unique, 64382);
  eq(PROOF.multi, 577);
  eq(PROOF.agree.agreed, PROOF.agree.n);
});

test('library plumbing: lookup, ordering, and the same daily board on every device', () => {
  eq(byId('shoal-01'), at(0));
  eq(byId('no-such-lot'), null);
  eq(at(9999).id, rows[rows.length - 1].id, 'index past the end must clamp');
  eq(at(-5).id, rows[0].id, 'negative index must clamp');
  const first = dailyFromPool('2026-09-27');
  eq(dailyFromPool('2026-09-27').id, first.id);
  eq(dailyFromPool('2026-09-27').rows, first.rows);
  ok(dailyFromPool('2026-09-28') !== undefined);
  const week = new Set(['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26'].map((d) => dailyFromPool(d).id));
  ok(week.size >= 3, `six consecutive days only produced ${week.size} distinct boards`);
});

test('pool stats report the measured ranges the panel prints', () => {
  const st = stats();
  eq(st.lots, rows.length);
  eq(st.unique, rows.length, 'a shipped lot is not marked unique');
  eq(Object.keys(st.byTier).length, TIERS.length);
  for (const t of TIERS) {
    const b = st.byTier[t.key];
    ok(b.n > 0 && b.min <= b.max, `${t.key}: ${JSON.stringify(b)}`);
    eq(b.size, `${t.r}×${t.c}`);
    ok(b.coresVerified >= 0 && b.coresVerified <= b.n);
  }
  ok(st.assumptionLots >= 1);
});

test('a row survives serialise/deserialise without losing a measurement', () => {
  for (const lot of rows.slice(0, 6)) {
    const text = JSON.stringify({
      id: lot.id, tier: lot.tier, r: lot.r, c: lot.c, rows: lot.rows, cols: lot.cols,
      solution: formatGrid(lot.solution, lot.r, lot.c), solutions: lot.solutions, depth: lot.depth,
      chains: lot.chains, backtracks: lot.backtracks, nodes: lot.nodes, marks: lot.marks,
    });
    const back = deserializeLot(JSON.parse(text));
    eq(back.rows, lot.rows);
    eq(back.solution, lot.solution);
    eq(back.solutions, 1);
    eq(back.depth, lot.depth);
    eq(markCount(back.solution), lot.marks);
  }
});

run();
