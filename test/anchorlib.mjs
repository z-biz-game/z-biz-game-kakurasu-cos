// The exhaustive enumerations, and nothing else. This file is deliberately NOT under js/core:
// nothing a page loads may reach it, because the whole point of the 4x4 proof is that it walks
// all 2^16 boards, and the same call on a 7x7 would walk 2^49. (5x5 and up are refused outright
// by the cell guard below, so a typo cannot turn a test into a hang.)
//
// It also re-implements the weighting from scratch instead of importing it from js/core/grid.js.
// That is the point: if the model and this file agree, the agreement is evidence; if they
// shared a definition, it would be a tautology.
//
// Used by test/anchor.test.mjs (the repo's proof) and by tools/bake.mjs phase 1.

import { countSolutionsDP, countSolutionsBacktrack } from '../js/core/count.js';

export const MAX_ENUM_CELLS = 20;

function guard(r, c) {
  if (r * c > MAX_ENUM_CELLS) {
    throw new Error(`refusing to enumerate ${r}x${c}: 2^${r * c} boards (limit 2^${MAX_ENUM_CELLS})`);
  }
}

// Independent of js/core: weights spelled out here.
export function cluesFromMask(r, c, mask) {
  const rows = new Array(r).fill(0);
  const cols = new Array(c).fill(0);
  for (let y = 0; y < r; y++) {
    for (let x = 0; x < c; x++) {
      if (mask & (1 << (y * c + x))) {
        rows[y] += x + 1; // a marked cell pays its COLUMN index into its row clue
        cols[x] += y + 1; // and its ROW index into its column clue
      }
    }
  }
  return { rows, cols };
}

export function clueKeyOf(rows, cols) {
  return `${rows.join(':')}|${cols.join(':')}`;
}

// Every board, bucketed by the clue pair it produces.
export function classSizes(r, c) {
  guard(r, c);
  const sizes = new Map();
  for (let mask = 0; mask < 2 ** (r * c); mask++) {
    const { rows, cols } = cluesFromMask(r, c, mask);
    const k = clueKeyOf(rows, cols);
    sizes.set(k, (sizes.get(k) || 0) + 1);
  }
  return sizes;
}

// The same class count by a completely different route: never touch a board, instead walk the
// tuples of row-subsets and read off both clue vectors. If the two routes agree on how many
// clue classes exist, at least one of them is not counting what it thinks it counts.
export function classesBySubsetProduct(r, c) {
  guard(r, c);
  const subs = [];
  for (let m = 0; m < 2 ** c; m++) {
    let w = 0;
    const hits = [];
    for (let x = 0; x < c; x++) if (m & (1 << x)) { w += x + 1; hits.push(x); }
    subs.push({ w, hits });
  }
  const seen = new Set();
  const walk = (y, rows, cols) => {
    if (y === r) {
      seen.add(clueKeyOf(rows, cols));
      return;
    }
    for (const s of subs) {
      const next = cols.slice();
      for (const x of s.hits) next[x] += y + 1;
      walk(y + 1, rows.concat([s.w]), next);
    }
  };
  walk(0, [], new Array(c).fill(0));
  return seen;
}

// Exhaustive count for one clue pair, optionally with clues removed (the independent third
// opinion for the redundancy/falsification tests).
export function bruteCount(r, c, rows, cols, { ignoreRows = [], ignoreCols = [] } = {}) {
  guard(r, c);
  let n = 0;
  for (let mask = 0; mask < 2 ** (r * c); mask++) {
    const { rows: rr, cols: cc } = cluesFromMask(r, c, mask);
    let ok = true;
    for (let y = 0; y < r && ok; y++) if (!ignoreRows.includes(y) && rr[y] !== rows[y]) ok = false;
    for (let x = 0; x < c && ok; x++) if (!ignoreCols.includes(x) && cc[x] !== cols[x]) ok = false;
    if (ok) n += 1;
  }
  return n;
}

// The whole 4x4 proof in one call, with the cross-checks the brief measured.
// `limit` samples classes for the three-way count agreement.
export function closureIdentity(r = 4, c = 4, { sample = 400 } = {}) {
  guard(r, c);
  const sizes = classSizes(r, c);
  let sum = 0;
  let unique = 0;
  let multi = 0;
  for (const n of sizes.values()) {
    sum += n;
    if (n === 1) unique += 1;
    else multi += 1;
  }
  const byProduct = classesBySubsetProduct(r, c);
  const entries = [...sizes.entries()];
  let agreed = 0;
  const step = Math.max(1, Math.floor(entries.length / sample));
  let n = 0;
  for (let i = 0; i < entries.length && n < sample; i += step) {
    const [k, size] = entries[i];
    n += 1;
    const [rs, cs] = k.split('|');
    const lot = { r, c, rows: rs.split(':').map(Number), cols: cs.split(':').map(Number) };
    // `size` is the exhaustive answer (how many of the 2^(r*c) boards fall in this bucket),
    // so it is the third opinion; both counters cap at 2, hence the min(). For classes of size
    // 1 or 2 the comparison is exact, and for larger ones it is a bound both routes must share.
    const want = Math.min(size, 2);
    const dp = countSolutionsDP(lot, { limit: 2 });
    const bt = countSolutionsBacktrack(lot, { limit: 2 });
    if (!dp.bailed && !bt.bailed && dp.count === want && bt.count === want) agreed += 1;
  }
  return {
    size: `${r}x${c}`,
    cells: r * c,
    sum,
    classes: sizes.size,
    classesBySubset: byProduct.size,
    unique,
    multi,
    multiAllSizeTwo: entries.every(([k, v]) => v === 1 || v === 2),
    agree: { n, agreed },
  };
}
