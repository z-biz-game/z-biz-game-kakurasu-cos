// The generator: what it accepts, what it refuses, and whether a seed really pins the board.
// Every claim here is about reproducibility, because that is what makes a shared link and a
// daily board mean the same thing on two devices.
import { test, run, ok, eq } from '../tools/harness.mjs';
import { makeLot, evaluateClues, blankStats, tierByKey, TIERS, rankOf, MAX_ATTEMPTS, SOLVER_NODE_CAP } from '../js/core/make.js';
import { countSolutionsDP } from '../js/core/count.js';
import { cluesOf, formatGrid, validateLot } from '../js/core/grid.js';
import { hashSeed } from '../js/core/rng.js';
import { LOTS } from '../js/data/lots.js';

const lotFrom = (seed, tier) => makeLot(seed, tier, { withCore: false });

test('the same seed makes the same lot, twice, on two calls', () => {
  for (const t of TIERS) {
    const a = lotFrom(`seed-${t.key}-7`, t);
    const b = lotFrom(`seed-${t.key}-7`, t);
    ok(a && b, `${t.key}: the generator found nothing for a seed it should handle`);
    eq(a.rows, b.rows);
    eq(a.cols, b.cols);
    eq(a.solution, b.solution);
    eq(a.depth, b.depth);
    eq(a.chains, b.chains);
    eq(a.nodes, b.nodes);
  }
});

test('different seeds make different boards', () => {
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    const lot = lotFrom(`spread-${i}`, 'linked');
    ok(lot, `nothing came out of spread-${i}`);
    seen.add(`${lot.rows.join(',')}|${lot.cols.join(',')}`);
  }
  ok(seen.size >= 30, `only ${seen.size}/40 distinct clue pairs`);
});

test('every generated lot is valid, unique and inside its tier size', () => {
  const stats = blankStats();
  for (let i = 0; i < 24; i++) {
    for (const t of TIERS) {
      const lot = makeLot(`audit-${i}`, t, { stats, withCore: false });
      if (!lot) continue;
      eq(lot.r, t.r);
      eq(lot.c, t.c);
      eq(lot.solutions, 1);
      eq(validateLot({ ...lot, cells: lot.solution }).ok, true, lot.id || 'unknown');
      eq(lot.depth >= 0 && lot.chains >= 1, true);
      ok(lot.nodes <= SOLVER_NODE_CAP);
    }
  }
  ok(stats.accepted > 0);
});

test('a lot is described by its clue pair, and the answer grid reproduces it', () => {
  const lot = lotFrom('describe-1', 'shoal');
  ok(lot);
  eq(cluesOf(lot.solution, lot.r, lot.c), { rows: lot.rows, cols: lot.cols });
  eq(lot.clues, lot.r + lot.c);
  ok(/^[01/]+$/.test(formatGrid(lot.solution, lot.r, lot.c)));
});

// ---- the rejections, one per reason ------------------------------------------------------
test('an ambiguous clue pair is refused as ambiguous, never published', () => {
  const res = evaluateClues(4, 4, [3, 3, 3, 0], [3, 3, 3, 0]);
  eq(res.reject, 'ambiguous');
});
test('an impossible clue pair is refused too', () => {
  const res = evaluateClues(4, 4, [10, 0, 0, 0], [1, 0, 0, 0]);
  eq(res.reject, 'ambiguous'); // 0 solutions is not 1, and the generator has no exception for it
  eq(countSolutionsDP({ r: 4, c: 4, rows: [10, 0, 0, 0], cols: [1, 0, 0, 0] }, { limit: 2 }).count, 0);
});
test('a malformed clue vector is refused as invalid', () => {
  eq(evaluateClues(4, 4, [11, 0, 0, 0], [0, 0, 0, 0]).reject, 'invalid');
  eq(evaluateClues(4, 4, [1, 2], [0, 0, 0, 0]).reject, 'invalid');
  eq(evaluateClues(9, 9, [1, 2, 3], [1, 2, 3]).reject, 'invalid');
});
test('the band filter is applied to the measured rank, not to the board size', () => {
  const easy = lotFrom('band-1', 'twined');
  ok(easy);
  const rank = rankOf(easy);
  const stats = blankStats();
  const impossible = makeLot('band-2', 'twined', { stats, band: [rank + 500, rank + 900], withCore: false });
  eq(impossible, null, 'a band nobody can reach must return null, not a lot');
  eq(stats.rejectBand + stats.rejectAmbiguous, MAX_ATTEMPTS, `expected all ${MAX_ATTEMPTS} attempts to be rejected, saw ${JSON.stringify(stats)}`);
  ok(stats.rejectBand > MAX_ATTEMPTS / 3, `most attempts should fail on the band, not on uniqueness: ${JSON.stringify(stats)}`);
  // and the same seed with no band filter does produce something
  ok(makeLot('band-2', 'twined', { withCore: false }));
});
test('the attempt ceiling is honoured, so makeLot always terminates', () => {
  const stats = blankStats();
  const t0 = Date.now();
  eq(makeLot('never', { key: 'shoal', label: 'x', r: 4, c: 4, band: [500, 501] }, { stats, withCore: false }), null);
  eq(stats.attempted, MAX_ATTEMPTS);
  ok(Date.now() - t0 < 20000, `an exhausted search took ${Date.now() - t0}ms`);
});
test('stats account for every attempt it made', () => {
  const stats = blankStats();
  for (let i = 0; i < 30; i++) makeLot(`acct-${i}`, 'shoal', { stats, withCore: false });
  eq(stats.attempted, stats.accepted + stats.rejectAmbiguous + stats.rejectBailed + stats.rejectCapped + stats.rejectBand + stats.rejectInvalid + stats.rejectUnsolvable);
  ok(stats.accepted > 0 && stats.attempted >= 30);
});

// ---- determinism of the routes that need it ---------------------------------------------
test('the daily seed is a pure function of the date string', () => {
  const one = makeLot(`daily:2026-09-27:twined`, tierByKey('twined'), { withCore: false });
  const again = makeLot(`daily:2026-09-27:twined`, tierByKey('twined'), { withCore: false });
  eq(one.rows, again.rows);
  eq(one.cols, again.cols);
  const other = makeLot('daily:2026-09-28:twined', tierByKey('twined'), { withCore: false });
  ok(other);
  // A different day *may* land on the same clue pair; it just may not be the same by
  // construction. Over a fortnight the two must visibly differ most of the time.
  const days = new Set();
  for (let d = 1; d <= 14; d++) {
    const key = `daily:2026-10-${String(d).padStart(2, '0')}:twined`;
    const lot = makeLot(key, tierByKey('twined'), { withCore: false });
    if (lot) days.add(lot.rows.join(',') + '|' + lot.cols.join(','));
  }
  ok(days.size >= 10, `14 days produced only ${days.size} boards`);
  ok(hashSeed('2026-09-27') !== hashSeed('2026-09-28'));
});

test('tierByKey falls back to the first band rather than undefined', () => {
  eq(tierByKey('twined').key, 'twined');
  eq(tierByKey('not-a-band').key, 'shoal');
  eq(typeof tierByKey('linked').r, 'number');
});

test('live generation is bounded enough to run in a browser tab', () => {
  const t0 = Date.now();
  let n = 0;
  for (let i = 0; i < 20; i++) {
    const lot = makeLot(`browser-${i}`, 'master', { withCore: false });
    if (lot) n += 1;
  }
  const per = (Date.now() - t0) / Math.max(1, n);
  ok(n >= 5, `only ${n}/20 attempts produced a lot`);
  // A generous ceiling: this is a correctness guard against an accidental unbounded search,
  // not a performance claim (those numbers live in DESIGN.md, from the bake run).
  ok(per < 1500, `${per.toFixed(0)} ms per live lot is too slow for a click`);
});

test('the shipped campaign is what the generator can reproduce, band by band', () => {
  // Not a byte-for-byte re-derivation (bake reseeds per row), but every shipped band must
  // still be fillable by a fresh generator run, or the pool is a one-off accident.
  for (const t of TIERS) {
    const meta = LOTS.filter((l) => l.tier === t.key);
    ok(meta.length > 0);
    const ranks = LOTS.filter((l) => l.tier === t.key).map((l) => l.rank);
    const band = [Math.min(...ranks), Math.max(...ranks)];
    const lot = makeLot(`refill-${t.key}`, t, { band, withCore: false });
    ok(lot, `${t.key}: cannot reproduce its shipped rank band ${band}`);
    ok(lot.rank >= band[0] && lot.rank <= band[1]);
  }
});

run();
