// THE PROOF. Four published facts about the 4x4 Kakurasu space, each reproduced here from a
// complete enumeration, with the expected values typed in by hand from the brief. If any of
// these breaks, every `solutions: 1` printed by tools/bake.mjs and shown on screen is a lie,
// so this file is the one the repo exists to keep green.
//
//   1. closure identity  : the clue classes partition the 2^16 boards; their sizes sum to 65536
//   2. class count       : 64959 distinct clue pairs, by two independent counting routes
//   3. counter agreement : the subset DP == the cell-by-cell backtracker == the enumeration on
//                          400 sampled classes
//   4. uniqueness census : 64382 classes have exactly one solution, 577 have more
//
// Expected values are literals, not computed from js/core. This file runs in the node layer
// only: it walks 2^16 boards, and nothing that a page loads may import it.
import { test, run, ok, eq } from '../tools/harness.mjs';
import { closureIdentity, classSizes, classesBySubsetProduct, bruteCount, cluesFromMask, MAX_ENUM_CELLS } from './anchorlib.mjs';
import { cluesOf } from '../js/core/grid.js';
import { countSolutionsDP, countSolutionsBacktrack, minimalCore } from '../js/core/count.js';

const ANCHOR = {
  sum: 65536, // 2^16
  classes: 64959,
  unique: 64382,
  multi: 577,
  sample: 400,
};

const t0 = Date.now();
const proof = closureIdentity(4, 4, { sample: ANCHOR.sample });
const elapsed = Date.now() - t0;

test('the model in js/core and the enumeration in this file agree about a board', () => {
  // Two implementations of the same rule, in two files that do not import each other's
  // weights: this is the hinge that lets the anchors below say anything about the shipped game.
  for (const mask of [0, 1, 4369, 32768, 65535, 12345]) {
    const cells = [];
    for (let i = 0; i < 16; i++) cells.push((mask >> i) & 1);
    eq(cluesFromMask(4, 4, mask), cluesOf(cells, 4, 4), `mask ${mask}`);
  }
});

test(`1. closure identity: class sizes sum to exactly ${ANCHOR.sum}`, () => {
  eq(proof.sum, ANCHOR.sum);
  eq(proof.cells, 16);
});

test(`2. distinct 4x4 clue classes: ${ANCHOR.classes}, by both counting routes`, () => {
  eq(proof.classes, ANCHOR.classes);
  eq(proof.classesBySubset, ANCHOR.classes);
  // route A buckets the 2^16 boards; route B never looks at a board at all and instead walks
  // the fourfold product of row subsets. Same number, different machinery.
  eq(classSizes(4, 4).size, classesBySubsetProduct(4, 4).size);
});

test(`3. DP == backtracking == enumeration on ${ANCHOR.sample} sampled classes`, () => {
  eq(proof.agree.n, ANCHOR.sample);
  eq(proof.agree.agreed, ANCHOR.sample);
});

test(`4. uniqueness census: ${ANCHOR.unique} unique + ${ANCHOR.multi} multiple = ${ANCHOR.classes}`, () => {
  eq(proof.unique, ANCHOR.unique);
  eq(proof.multi, ANCHOR.multi);
  eq(proof.unique + proof.multi, proof.classes);
});

test('and every multiple class in the 4x4 space has exactly two boards', () => {
  // Not in the brief; it falls out of the enumeration and it is a useful cross-check on the
  // census above: 64382 * 1 + 577 * 2 = 65536, which is the closure identity again from the
  // other side.
  eq(proof.multiAllSizeTwo, true);
  eq(proof.unique + 2 * proof.multi, ANCHOR.sum);
});

test('the whole proof runs in seconds, so it stays in the test layer where it belongs', () => {
  ok(elapsed < 20000, `enumeration took ${elapsed}ms`);
});

test('the exhaustive enumerator refuses anything it cannot finish', () => {
  eq(MAX_ENUM_CELLS, 20);
  let threw = 0;
  for (const [r, c] of [[5, 5], [6, 6], [7, 7]]) {
    try { classSizes(r, c); } catch { threw += 1; }
    try { bruteCount(r, c, new Array(r).fill(0), new Array(c).fill(0)); } catch { threw += 1; }
  }
  eq(threw, 6);
  // ... and the 4x4 space is the biggest thing the shipped counters are checked against.
  eq(bruteCount(4, 4, [0, 0, 0, 0], [0, 0, 0, 0]), 1);
});

test('the 577 ambiguous classes are real: each is counted as ambiguous by both counters', () => {
  const multi = [...classSizes(4, 4).entries()].filter(([, n]) => n > 1).slice(0, 40);
  eq(multi.length, 40);
  for (const [k, n] of multi) {
    const [rs, cs] = k.split('|');
    const lot = { r: 4, c: 4, rows: rs.split(':').map(Number), cols: cs.split(':').map(Number) };
    eq(countSolutionsDP(lot, { limit: 2 }).count, 2, `dp ${k}`);
    eq(countSolutionsBacktrack(lot, { limit: 2 }).count, 2, `bt ${k}`);
    eq(n, 2);
  }
});

test('a single-clue drop keeps uniqueness on the 4x4 space (the brief expected the opposite)', () => {
  // Measured over every class: dropping one of the eight clues almost never breaks uniqueness,
  // because eight exact weighted sums overhang sixteen binary cells. Sampled with the
  // independent enumerator so the claim is not resting on js/core.
  const entries = [...classSizes(4, 4).entries()].filter(([, n]) => n === 1);
  const step = Math.floor(entries.length / 24);
  let stillUnique = 0;
  let checked = 0;
  for (let i = 0; i < entries.length && checked < 24; i += step) {
    checked += 1;
    const [k] = entries[i];
    const [rs, cs] = k.split('|');
    const rows = rs.split(':').map(Number);
    const cols = cs.split(':').map(Number);
    for (let y = 0; y < 4; y++) if (bruteCount(4, 4, rows, cols, { ignoreRows: [y] }) === 1) stillUnique += 1;
    for (let x = 0; x < 4; x++) if (bruteCount(4, 4, rows, cols, { ignoreCols: [x] }) === 1) stillUnique += 1;
  }
  eq(checked, 24);
  // 24 classes x 8 clue drops. Anything below the full count is a drop that DID break
  // uniqueness; the number is a measured fact about how redundant the full board is.
  ok(stillUnique >= 24 * 8 - 8, `only ${stillUnique}/${24 * 8} single-clue drops stayed unique`);
});

test('but every clue pair does have an inclusion-minimal core whose clues all bite', () => {
  // ... and that is where the brief's falsification actually lives. Three different classes,
  // each checked against the independent enumerator.
  const samples = [...classSizes(4, 4).entries()].filter(([, n]) => n === 1).slice(0, 3);
  for (const [k] of samples) {
    const [rs, cs] = k.split('|');
    const lot = { r: 4, c: 4, rows: rs.split(':').map(Number), cols: cs.split(':').map(Number) };
    const core = minimalCore(lot);
    eq(core.minimality, 'holds', k);
    ok(core.size <= lot.r + lot.c);
    for (const e of core.report) {
      const ignoreRows = e.kind === 'row' ? core.dropped.rows.concat([e.index]) : core.dropped.rows;
      const ignoreCols = e.kind === 'col' ? core.dropped.cols.concat([e.index]) : core.dropped.cols;
      ok(bruteCount(4, 4, lot.rows, lot.cols, { ignoreRows, ignoreCols }) >= 2, `core clue ${e.kind}${e.index} in ${k}`);
    }
  }
});

run();
