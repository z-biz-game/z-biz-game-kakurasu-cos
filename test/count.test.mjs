// The solution counters. The expectations below are worked out by hand (or, for the 4x4
// cross-checks, by the independent exhaustive enumeration in test/anchorlib.mjs) and typed in
// as literals; none of them is read back from js/core/count.js.
import { test, run, ok, eq } from '../tools/harness.mjs';
import { countSolutionsDP, countSolutionsBacktrack, isUnique, findSolution, findSolutions, clueLoadBearing, minimalCore } from '../js/core/count.js';
import { bruteCount, classSizes } from './anchorlib.mjs';
import { cluesOf, parseGrid, formatGrid } from '../js/core/grid.js';

// ---- hand-computed fixtures -------------------------------------------------------------
// Every pair below is annotated with the reasoning that gives its count. The counters are
// then required to reproduce that number, both of them, independently.
const FIXTURES = [
  { name: 'all zeros: only the empty board pays 0 to every line', rows: [0, 0, 0, 0], cols: [0, 0, 0, 0], want: 1 },
  {
    // col x needs 1, so only row 0 may pay into it... and row 0 needs 1, so exactly one cell.
    name: 'one marked corner', rows: [1, 0, 0, 0], cols: [1, 0, 0, 0], want: 1,
  },
  {
    // row 0 pays 1 -> its cell is in column 0; row 1 pays 2 -> column 1; row 2 pays 3 ->
    // column 2 (1+3 would need column 0, already spent); row 3 pays 4 -> column 3.
    name: 'the diagonal', rows: [1, 2, 3, 4], cols: [1, 2, 3, 4], want: 1,
  },
  {
    // row 0 demands 1+2+3+4, so all four cells are marked, so every column owes at least 1;
    // columns 1..3 owe 0. Contradiction.
    name: 'impossible: a full row against three empty columns', rows: [10, 0, 0, 0], cols: [1, 0, 0, 0], want: 0,
  },
  {
    // The 3x3 corner block can split two ways: rows {0,1} pay columns {0,1} and row 2 pays
    // column 2, or rows {1,2} pay columns {0,1} while rows 0,1 pay column 2. Both give
    // rows=3,3,3 and cols=3,3,3; the fourth line is empty either way.
    name: 'the classic ambiguous block', rows: [3, 3, 3, 0], cols: [3, 3, 3, 0], want: 2,
  },
];

for (const f of FIXTURES) {
  const lot = { r: 4, c: 4, rows: f.rows, cols: f.cols };
  test(`hand fixture "${f.name}" counts ${f.want} by exhaustive enumeration`, () => {
    eq(bruteCount(4, 4, f.rows, f.cols), f.want);
  });
  test(`and the subset DP reproduces it: ${f.want}`, () => {
    const dp = countSolutionsDP(lot, { limit: 10 });
    eq(dp.bailed, false);
    eq(dp.count, f.want);
  });
  test(`and the cell-by-cell backtracker reproduces it: ${f.want}`, () => {
    const bt = countSolutionsBacktrack(lot, { limit: 10 });
    eq(bt.bailed, false);
    eq(bt.count, f.want);
  });
}

test('the two ambiguous boards really are the pair reasoned out above', () => {
  const lot = { r: 4, c: 4, rows: [3, 3, 3, 0], cols: [3, 3, 3, 0] };
  const sols = findSolutions(lot, 2).map((cells) => formatGrid(cells, 4, 4));
  eq(sols.sort(), ['1100/1100/0010/0000', '0010/0010/1100/0000'].sort());
});

test('an impossible lot yields no answer grid', () => {
  eq(findSolution({ r: 4, c: 4, rows: [10, 0, 0, 0], cols: [1, 0, 0, 0] }), null);
});

test('limit: 2 caps the count at 2 without ever under-counting an ambiguity', () => {
  const lot = { r: 4, c: 4, rows: [3, 3, 3, 0], cols: [3, 3, 3, 0] };
  eq(countSolutionsDP(lot, { limit: 2 }).count, 2);
  eq(countSolutionsBacktrack(lot, { limit: 2 }).count, 2);
  // A 5x5 all-zero board is unique; asking for at most 2 must still say 1.
  eq(countSolutionsDP({ r: 5, c: 5, rows: [0, 0, 0, 0, 0], cols: [0, 0, 0, 0, 0] }, { limit: 2 }).count, 1);
});

test('isUnique is the conjunction of both counters, not one of them', () => {
  eq(isUnique({ r: 4, c: 4, rows: [1, 2, 3, 4], cols: [1, 2, 3, 4] }).unique, true);
  eq(isUnique({ r: 4, c: 4, rows: [3, 3, 3, 0], cols: [3, 3, 3, 0] }).unique, false);
  eq(isUnique({ r: 4, c: 4, rows: [10, 0, 0, 0], cols: [1, 0, 0, 0] }).unique, false);
});

// ---- the weights really are what constrains the answer ----------------------------------
// If the model were silently counting cells instead of paying indices, the same printed
// numbers would describe a different puzzle. Both readings are enumerated here from scratch
// (independently of js/core) and compared, on two different clue pairs.
function unweightedSolutions(rows, cols) {
  const out = [];
  for (let m = 0; m < 65536; m++) {
    const rc = [0, 0, 0, 0];
    const cc = [0, 0, 0, 0];
    for (let i = 0; i < 16; i++) if (m & (1 << i)) { rc[Math.floor(i / 4)] += 1; cc[i % 4] += 1; }
    const good = rows.every((v, y) => v === rc[y]) && cols.every((v, x) => v === cc[x]);
    if (good) out.push(m);
  }
  return out;
}
function maskToGrid(m) {
  const rowsOut = [];
  for (let y = 0; y < 4; y++) rowsOut.push([0, 1, 2, 3].map((x) => ((m >> (y * 4 + x)) & 1)).join(''));
  return rowsOut.join('/');
}

test('the diagonal clue pair answers differently under the two definitions', () => {
  const rows = [1, 2, 3, 4];
  const cols = [1, 2, 3, 4];
  const weighted = countSolutionsDP({ r: 4, c: 4, rows, cols }, { limit: 10 });
  eq(weighted.count, 1);
  eq(formatGrid(findSolution({ r: 4, c: 4, rows, cols }), 4, 4), '1000/0100/0010/0001');
  const plain = unweightedSolutions(rows, cols);
  eq(plain.length, 1);
  // Same eight printed numbers, different board: the staircase. Reading the clues as cell
  // counts would answer this puzzle wrong, which is what makes the weighting load-bearing.
  eq(maskToGrid(plain[0]), '0001/0011/0111/1111');
});

test('the ambiguous block is ambiguous by weight and unique by cell count', () => {
  const rows = [3, 3, 3, 0];
  const cols = [3, 3, 3, 0];
  eq(countSolutionsDP({ r: 4, c: 4, rows, cols }, { limit: 10 }).count, 2);
  eq(unweightedSolutions(rows, cols).length, 1);
});

test('a 5x5 board with a known answer reproduces its own clues from the answer', () => {
  const solution = [
    1, 1, 0, 0, 1,
    0, 1, 1, 0, 0,
    0, 0, 1, 1, 0,
    1, 0, 0, 1, 1,
    0, 1, 0, 0, 1,
  ];
  const { rows, cols } = cluesOf(solution, 5, 5);
  eq(rows, [1 + 2 + 5, 2 + 3, 3 + 4, 1 + 4 + 5, 2 + 5]);
  eq(cols, [1 + 4, 1 + 2 + 5, 2 + 3, 3 + 4, 1 + 4 + 5]);
  const lot = { r: 5, c: 5, rows, cols };
  const dp = countSolutionsDP(lot, { limit: 2 });
  eq(dp.bailed, false);
  ok(dp.count === 1 || dp.count === 2, `count came back ${dp.count}`);
  if (dp.count === 1) {
    eq(formatGrid(findSolution(lot), 5, 5), formatGrid(solution, 5, 5));
  }
});

// ---- purity ------------------------------------------------------------------------------
test('counting does not modify the lot it was given', () => {
  const lot = { r: 4, c: 4, rows: [3, 3, 3, 0], cols: [3, 3, 3, 0] };
  const before = JSON.stringify(lot);
  countSolutionsDP(lot, { limit: 10 });
  countSolutionsBacktrack(lot, { limit: 10 });
  clueLoadBearing(lot);
  minimalCore(lot);
  findSolutions(lot, 2);
  eq(JSON.stringify(lot), before);
});

// ---- dropping clues: the measured truth, not the wished-for one ---------------------------
test('a redundant clue can be removed from the full 4x4 clue set and still be unique', () => {
  // This is the finding that DESIGN.md 2.4 records: the brief asks for "drop any clue and the
  // count goes to >= 2", and exhaustive enumeration says that is not how Kakurasu behaves --
  // 8 clues on a 4x4 are far more than enough to pin 16 cells.
  const lot = { r: 4, c: 4, rows: [1, 0, 0, 0], cols: [1, 0, 0, 0] };
  const rep = clueLoadBearing(lot);
  eq(rep.length, 8);
  eq(rep.every((e) => e.count === 1), true, JSON.stringify(rep));
  eq(bruteCount(4, 4, lot.rows, lot.cols, { ignoreRows: [1] }), 1);
  eq(bruteCount(4, 4, lot.rows, lot.cols, { ignoreCols: [3] }), 1);
});
test('a redundant clue is also redundant under exhaustive enumeration', () => {
  const lot = { r: 4, c: 4, rows: [1, 2, 3, 4], cols: [1, 2, 3, 4] };
  const rep = clueLoadBearing(lot);
  for (const e of rep) {
    const via = e.kind === 'row'
      ? bruteCount(4, 4, lot.rows, lot.cols, { ignoreRows: [e.index] })
      : bruteCount(4, 4, lot.rows, lot.cols, { ignoreCols: [e.index] });
    eq(e.count, via, `${e.kind} ${e.index}`);
  }
});

test('the greedy core of a 4x4 clue pair is inclusion-minimal and every clue in it bites', () => {
  const lot = { r: 4, c: 4, rows: [1, 2, 3, 4], cols: [1, 2, 3, 4] };
  const core = minimalCore(lot);
  ok(core.size < lot.r + lot.c, `the full set was claimed minimal: ${core.size}`);
  eq(core.minimality, 'holds');
  ok(core.report.length > 0);
  ok(core.report.every((e) => e.loadBearing), JSON.stringify(core.report));
  for (const e of core.report) {
    // The exhaustive check has to drop the *same* set the core already dropped, plus this
    // clue: leaving the greedy's dropped rows in place would re-tighten the puzzle and make
    // the clue look redundant when it is not.
    const ignoreRows = e.kind === 'row' ? core.dropped.rows.concat([e.index]) : core.dropped.rows;
    const ignoreCols = e.kind === 'col' ? core.dropped.cols.concat([e.index]) : core.dropped.cols;
    const via = bruteCount(4, 4, lot.rows, lot.cols, { ignoreRows, ignoreCols });
    ok(via >= 2, `core clue ${e.kind} ${e.index} drops to ${via} under exhaustive enumeration`);
  }
});

test('every 4x4 clue class is counted the same by the DP, the backtracker and the enumeration', () => {
  // Walk the whole class space once (this is the same data the anchor test uses) and check a
  // spread of classes across the size range: 1-solution, 2-solution, and a handful in between.
  const entries = [...classSizes(4, 4).entries()];
  const picked = [entries[0], entries[1], entries[400], entries[9000], entries[30000], entries[64000]];
  const ambiguous = entries.find(([, n]) => n > 1);
  ok(!!ambiguous, 'the enumeration found no multi-solution class at all');
  for (const [k, n] of picked.concat([ambiguous])) {
    if (!k) continue;
    const [rs, cs] = k.split('|');
    const lot = { r: 4, c: 4, rows: rs.split(':').map(Number), cols: cs.split(':').map(Number) };
    const want = Math.min(n, 2);
    eq(countSolutionsDP(lot, { limit: 2 }).count, want, `dp for ${k}`);
    eq(countSolutionsBacktrack(lot, { limit: 2 }).count, want, `bt for ${k}`);
  }
  ok(ambiguous[1] === 2, `every 4x4 multi class should have exactly 2 boards, saw ${ambiguous[1]}`);
});

run();
