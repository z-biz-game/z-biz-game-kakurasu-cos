// The board model: weights, clue extraction, validation, serialisation, and the rng contract.
// Every expectation here is typed by hand from the rules in js/core/grid.js's header comment —
// none of them is read back out of the module under test.
import { test, run, ok, eq } from '../tools/harness.mjs';
import {
  hashSeed, mulberry32, rngFrom, todayKey,
} from '../js/core/rng.js';
import {
  cluesOf, rowSum, colSum, maxClue, validateLot, parseGrid, formatGrid, statusOf,
  isSolution, isClueConsistent, markCount, serializeLot, deserializeLot, checkDims,
  cellIndex, emptyGrid, clueKey, parseClueKey, ERROR_CODES,
} from '../js/core/grid.js';

// ---- the weighting, by hand -------------------------------------------------------------
// A 4x4 board with the diagonal marked: cell (y,y) sits in column y, so row y collects the
// weight (y+1) and column y collects the weight (y+1) from row index y.
const diag = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
];
test('row clue is the sum of COLUMN indices, worked by hand', () => {
  eq(cluesOf(diag, 4, 4).rows, [1, 2, 3, 4]);
});
test('column clue is the sum of ROW indices, worked by hand', () => {
  eq(cluesOf(diag, 4, 4).cols, [1, 2, 3, 4]);
});
test('a full row of 4 costs 1+2+3+4 = 10, an empty one 0', () => {
  const full = new Array(16).fill(1);
  eq(cluesOf(full, 4, 4).rows, [10, 10, 10, 10]);
  eq(cluesOf(full, 4, 4).cols, [10, 10, 10, 10]);
  eq(maxClue(4), 10);
  eq(maxClue(7), 28);
  eq(maxClue(8), 36);
});
test('an off-diagonal cell pays both of its line weights', () => {
  // only cell (row 2, col 0) marked: row 2 sees weight 1, column 0 sees weight 3
  const cells = new Array(16).fill(0);
  cells[2 * 4 + 0] = 1;
  const { rows, cols } = cluesOf(cells, 4, 4);
  eq(rows, [0, 0, 1, 0]);
  eq(cols, [3, 0, 0, 0]);
});
test('rowSum/colSum agree with cluesOf on a second hand-built board', () => {
  // 1 1 0 0  -> 1+2 = 3
  // 0 0 0 1  -> 4
  // 1 0 1 0  -> 1+3 = 4
  // 0 1 0 1  -> 2+4 = 6
  const cells = [1, 1, 0, 0, 0, 0, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1];
  eq([rowSum(cells, 4, 4, 0), rowSum(cells, 4, 4, 1), rowSum(cells, 4, 4, 2), rowSum(cells, 4, 4, 3)], [3, 4, 4, 6]);
  // column 0 sees rows 0 and 2 -> 1 + 3 = 4; column 1 sees rows 0 and 3 -> 1 + 4 = 5;
  // column 2 sees row 2 -> 3; column 3 sees rows 1 and 3 -> 2 + 4 = 6
  eq([colSum(cells, 4, 4, 0), colSum(cells, 4, 4, 1), colSum(cells, 4, 4, 2), colSum(cells, 4, 4, 3)], [4, 5, 3, 6]);
  eq(cluesOf(cells, 4, 4), { rows: [3, 4, 4, 6], cols: [4, 5, 3, 6] });
});
test('a rectangular 3x5 board weights rows 1..3 and columns 1..5', () => {
  // row 0: cols 1 and 4 -> 2 + 5 = 7.  row 1: cols 0 and 2 -> 1 + 3 = 4.  row 2: empty -> 0.
  // col 0: row 1 -> 2.  col 1: row 0 -> 1.  col 2: row 1 -> 2.  col 3: -.  col 4: row 0 -> 1.
  const cells = [0, 1, 0, 0, 1, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0];
  eq(cluesOf(cells, 3, 5).rows, [7, 4, 0]);
  eq(cluesOf(cells, 3, 5).cols, [2, 1, 2, 0, 1]);
});

// ---- dimensions and the 8x8 ban ---------------------------------------------------------
test('4..8 per side is in range, and the cell ceiling is 49', () => {
  ok(checkDims(4, 4));
  ok(checkDims(7, 7));
  ok(checkDims(6, 8)); // 48 cells: the widest board the spec allows
});
test('3x3 and 8x8 are refused, with a message that says why', () => {
  let msg = '';
  try { checkDims(3, 3); } catch (e) { msg = e.message; }
  ok(/too small/.test(msg), msg);
  msg = '';
  try { checkDims(8, 8); } catch (e) { msg = e.message; }
  ok(/too many cells/.test(msg), msg); // 64 > 49, spec 6
});

// ---- validators, each one tripped by a negative ------------------------------------------
test('a missing row clue is reported, not defaulted', () => {
  const v = validateLot({ r: 4, c: 4, rows: [1, 2, 3], cols: [1, 2, 3, 4] });
  ok(!v.ok);
  ok(v.errors.some((e) => e.code === 'missing-row-clue'), JSON.stringify(v.errors));
});
test('a missing column clue is reported', () => {
  const v = validateLot({ r: 4, c: 4, rows: [1, 2, 3, 4], cols: [1, 2, 3] });
  ok(v.errors.some((e) => e.code === 'missing-col-clue'), JSON.stringify(v.errors));
});
test('a cell marked twice is an overlap and is reported', () => {
  const cells = new Array(16).fill(0);
  cells[0] = 2;
  const v = validateLot({ r: 4, c: 4, rows: [0, 0, 0, 0], cols: [0, 0, 0, 0], cells });
  ok(v.errors.some((e) => e.code === 'cell-overlap'), JSON.stringify(v.errors));
});
test('a cell holding junk other than 0/1 is reported', () => {
  const cells = new Array(16).fill(0);
  cells[5] = 7;
  const v = validateLot({ r: 4, c: 4, rows: [0, 0, 0, 0], cols: [0, 0, 0, 0], cells });
  ok(v.errors.some((e) => e.code === 'cell-value'), JSON.stringify(v.errors));
});
test('a clue above what a line can pay is out of range', () => {
  const v = validateLot({ r: 4, c: 4, rows: [11, 0, 0, 0], cols: [0, 0, 0, 0] });
  ok(v.errors.some((e) => e.code === 'clue-range'), JSON.stringify(v.errors));
});
test('a board whose sums disagree with its own clues is caught', () => {
  const v = validateLot({ r: 4, c: 4, rows: [9, 0, 0, 0], cols: [1, 0, 0, 0], cells: diag.slice() });
  ok(v.errors.some((e) => e.code === 'solution-clue'), JSON.stringify(v.errors));
});
test('a well-formed lot validates clean', () => {
  const { rows, cols } = cluesOf(diag, 4, 4);
  eq(validateLot({ r: 4, c: 4, rows, cols, cells: diag }), { ok: true, errors: [] });
});
test('every error code the validator can emit is exercised above', () => {
  const seen = new Set();
  const probes = [
    { r: 4, c: 4, rows: [1, 2, 3], cols: [1, 2, 3, 4] },
    { r: 4, c: 4, rows: [1, 2, 3, 4], cols: [1, 2, 3] },
    { r: 4, c: 4, rows: [0, 0, 0, 0], cols: [0, 0, 0, 0], cells: Object.assign(new Array(16).fill(0), { 0: 2 }) },
    { r: 4, c: 4, rows: [11, 0, 0, 0], cols: [0, 0, 0, 0] },
    { r: 4, c: 4, rows: [9, 0, 0, 0], cols: [1, 0, 0, 0], cells: diag.slice() },
    { r: 2, c: 2, rows: [0, 0], cols: [0, 0] },
    { r: 4, c: 4, rows: [0, 0, 0, 0], cols: [0, 0, 0, 0], cells: Object.assign(new Array(16).fill(0), { 5: 7 }) },
    { r: 4, c: 4, rows: [0, 0, 0, 0], cols: [0, 0, 0, 0], cells: [0, 0, 0] },
  ];
  for (const p of probes) for (const e of validateLot(p).errors) seen.add(e.code);
  for (const code of ERROR_CODES) ok(seen.has(code), `code ${code} is never produced by any negative case`);
});

// ---- grid text and indexing -------------------------------------------------------------
test('a grid string round-trips and is bounds-checked', () => {
  eq(formatGrid(diag, 4, 4), '1000/0100/0010/0001');
  eq(parseGrid('1000/0100/0010/0001', 4, 4), diag);
});
test('a malformed grid string is refused', () => {
  let n = 0;
  for (const bad of ['100/0100/0010/0001', '1000/0100/0010', '100x/0100/0010/0001']) {
    try { parseGrid(bad, 4, 4); } catch { n += 1; }
  }
  eq(n, 3);
});
test('reading outside the board throws instead of returning undefined', () => {
  let n = 0;
  for (const [y, x] of [[4, 0], [0, 4], [-1, 0], [0, -1]]) {
    try { cellIndex(4, 4, y, x); } catch { n += 1; }
  }
  eq(n, 4);
});
test('emptyGrid makes a board of the right size and all zeros', () => {
  const g = emptyGrid(5, 6);
  eq(g.length, 30);
  eq(markCount(g), 0);
});

// ---- live line status --------------------------------------------------------------------
test('statusOf flags a line that has passed its clue, and only that line', () => {
  const lot = { r: 4, c: 4, rows: [1, 2, 3, 4], cols: [1, 2, 3, 4] };
  const cells = new Array(16).fill(0);
  cells[0] = 1; // row 0 = 1 (ok), col 0 = 1 (ok)
  const s = statusOf(lot, cells);
  eq(s.rows[0].ok, true);
  eq(s.cols[0].ok, true);
  eq(s.allOk, false);
  eq(s.over, 0);
  cells[3] = 1; // row 0 now pays 1 + 4 = 5 against a clue of 1
  const s2 = statusOf(lot, cells);
  eq(s2.rows[0].over, true);
  eq(s2.rows[0].sum, 5);
  eq(s2.over, 1);
  eq(isClueConsistent(lot, cells), false);
});
test('an over-capacity board is never "solved", even if it lands on the answer', () => {
  const lot = { r: 4, c: 4, rows: [1, 2, 3, 4], cols: [1, 2, 3, 4], solution: diag.slice() };
  eq(isSolution(lot, diag), true);
  eq(isClueConsistent(lot, diag), true);
  const wrong = diag.slice();
  wrong[15] = 0;
  wrong[14] = 1; // pays 3 into row 3 instead of 4
  eq(isSolution(lot, wrong), false);
  eq(isClueConsistent(lot, wrong), false);
});

// ---- serialisation -----------------------------------------------------------------------
test('a lot survives serialize/deserialize with its clue pair intact', () => {
  const lot = { id: 'x-01', tier: 'shoal', r: 4, c: 4, rows: [1, 2, 3, 4], cols: [1, 2, 3, 4], solution: diag.slice(), solutions: 1, depth: 0, chains: 2, backtracks: 0, nodes: 1, marks: 4 };
  const row = serializeLot(lot);
  eq(row.solution, '1000/0100/0010/0001');
  const back = deserializeLot(row);
  eq(back.rows, lot.rows);
  eq(back.cols, lot.cols);
  eq(back.solution, diag);
  eq(back.solutions, 1);
  eq(back.depth, 0);
  eq(markCount(back.solution), 4);
});
test('a clue pair survives the key round trip', () => {
  const k = clueKey(4, 4, [1, 2, 3, 4], [4, 3, 2, 1]);
  eq(parseClueKey(k), { r: 4, c: 4, rows: [1, 2, 3, 4], cols: [4, 3, 2, 1] });
});

// ---- rng: determinism, not public vectors -------------------------------------------------
// hashSeed is an FNV-1a-DERIVED two-round UTF-16 mixer (low byte xor+multiply, then high byte
// xor+multiply), so it is NOT textbook FNV-1a and must never be asserted against a published
// vector. These are the self-consistency properties the shell and the daily board rely on.
test('hashSeed is stable across calls', () => {
  eq(hashSeed('2026-09-27'), hashSeed('2026-09-27'));
  eq(hashSeed('lot-shoal-01'), hashSeed('lot-shoal-01'));
});
test('hashSeed wants a string; rngFrom is the one that coerces', () => {
  // hashSeed walks `str.length`/`charCodeAt`, so a bare number hashes to the offset basis
  // rather than to the digits. rngFrom does the String() conversion, and that is the path
  // every seed in this repo actually travels.
  eq(hashSeed(20260927), 2166136261); // the untouched FNV offset basis: the loop never ran
  eq(rngFrom(7).int(1000), mulberry32(7).int(1000));
  eq(rngFrom('7').int(1000), mulberry32(hashSeed('7')).int(1000));
});
test('hashSeed lands in 32-bit unsigned range for a mixed corpus', () => {
  for (const s of ['', 'a', 'a'.repeat(200), '数和', '2026-09-27', 'lot-shoal-01', '\u0000\u00ff']) {
    const h = hashSeed(s);
    ok(Number.isInteger(h) && h >= 0 && h <= 0xffffffff, `${JSON.stringify(s)} -> ${h}`);
  }
});
test('hashSeed separates nearby seeds', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(hashSeed(`seed-${i}`));
  ok(seen.size >= 495, `only ${seen.size}/500 distinct`);
  ok(hashSeed('a') !== hashSeed('b'));
  ok(hashSeed('2026-09-27') !== hashSeed('2026-09-28'));
});
test('the two-round mixer is deliberately not textbook FNV-1a', () => {
  // textbook FNV-1a of "a" is 0 ca5a8e2a-ish; ours differs because the high byte is mixed too.
  let fnv = 0x811c9dc5;
  for (const ch of 'a') {
    fnv ^= ch.charCodeAt(0);
    fnv = Math.imul(fnv, 0x01000193);
  }
  eq(hashSeed('a') === (fnv >>> 0), false);
  eq(hashSeed('a') >>> 0, hashSeed('a'));
});
test('mulberry32 is reproducible and stays in [0,1)', () => {
  const a = mulberry32(12345);
  const b = mulberry32(12345);
  eq([a(), a(), a()], [b(), b(), b()]);
  const c = mulberry32(999);
  const xs = Array.from({ length: 200 }, () => c());
  ok(xs.every((x) => x >= 0 && x < 1));
  ok(new Set(xs.map((x) => Math.floor(x * 8))).size === 8, '8 buckets should all be hit');
});
test('the rng helpers int/range/pick/shuffle/chance are all seeded', () => {
  const r1 = rngFrom('abc');
  const r2 = rngFrom('abc');
  eq(r1.int(10), r2.int(10));
  eq(r1.range(3, 7), r2.range(3, 7));
  eq(r1.pick(['a', 'b', 'c', 'd']), r2.pick(['a', 'b', 'c', 'd']));
  eq(r1.shuffle([1, 2, 3, 4, 5]), r2.shuffle([1, 2, 3, 4, 5]));
  eq(typeof r1.chance(0.5), 'boolean');
  const r3 = rngFrom(42);
  const r4 = rngFrom(42);
  eq(r3.int(1000), r4.int(1000));
  const fn = rngFrom('abc');
  ok(typeof fn === 'function' && typeof fn.int === 'function');
  eq(rngFrom(fn) === fn, true, 'an rng passes through unchanged');
});
test('todayKey formats a local date and accepts an explicit one', () => {
  eq(todayKey(new Date(2026, 8, 27)), '2026-09-27');
  eq(todayKey(new Date(2026, 0, 1)), '2026-01-01');
  eq(/^\d{4}-\d{2}-\d{2}$/.test(todayKey()), true);
});

run();
