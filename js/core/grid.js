// The board model: r rows x c columns of 0/1 cells, plus the two clue vectors that make a
// 数和格 (Kakurasu) puzzle what it is.
//
// The weighting is the whole game and it is stated once, here, so nothing else in the repo
// can quietly redefine it:
//
//   row clue[y] = sum over marked cells in row y of (x + 1)   -- the COLUMN index pays
//   col clue[x] = sum over marked cells in column x of (y + 1) -- the ROW index pays
//
// Both indices are 1-based, as printed on the grid edges. A 4x4 board therefore carries
// weights 1,2,3,4 on every row and 1,2,3,4 on every column, and a clue of 0 forces an empty
// line while a clue of 10 (= 1+2+3+4) forces a full one.
//
// This file is pure: no window, no document, no DOM. `node --test` imports it directly.

export const EMPTY = 0;
export const MARKED = 1;
export const UNKNOWN = -1;

export const MIN_DIM = 4;
export const MAX_DIM = 8;
// Spec 6: nothing 8x8 or larger. The DP in count.js carries a *vector of partial column
// sums* as its state, so cost grows combinatorially with c and linearly in rows; 49 cells
// (7x7, or 6x8 = 48) is the ceiling everything here is measured under.
export const MAX_CELLS = 49;

export function checkDims(r, c) {
  if (!Number.isInteger(r) || !Number.isInteger(c)) throw new Error(`dims must be integers, got ${r}x${c}`);
  if (r < MIN_DIM || c < MIN_DIM) throw new Error(`board too small: ${r}x${c} (min ${MIN_DIM}x${MIN_DIM})`);
  if (r > MAX_DIM || c > MAX_DIM) throw new Error(`board too large: ${r}x${c} (max ${MAX_DIM})`);
  if (r * c > MAX_CELLS) throw new Error(`board too many cells: ${r}x${c} = ${r * c} > ${MAX_CELLS}`);
  return true;
}

// Largest clue a line of length n can possibly carry: every cell marked.
export function maxClue(n) {
  return (n * (n + 1)) / 2;
}

export function emptyGrid(r, c) {
  checkDims(r, c);
  return new Array(r * c).fill(EMPTY);
}

export function unknownGrid(r, c) {
  checkDims(r, c);
  return new Array(r * c).fill(UNKNOWN);
}

export function cellIndex(r, c, y, x) {
  if (!Number.isInteger(y) || !Number.isInteger(x)) throw new Error(`cell index must be integers, got ${y},${x}`);
  if (y < 0 || y >= r || x < 0 || x >= c) throw new Error(`cell out of bounds: ${y},${x} in a ${r}x${c} board`);
  return y * c + x;
}

export function cellAt(cells, r, c, y, x) {
  return cells[cellIndex(r, c, y, x)];
}

// "1010/0101/..." -> flat array. Row separator keeps the format human-shareable in a URL.
export function parseGrid(text, r, c) {
  checkDims(r, c);
  const rows = String(text).split('/');
  if (rows.length !== r) throw new Error(`grid has ${rows.length} rows, board is ${r} tall: ${text}`);
  const out = [];
  for (const row of rows) {
    if (row.length !== c) throw new Error(`grid row "${row}" is ${row.length} wide, board is ${c} wide`);
    for (const ch of row) {
      if (ch !== '0' && ch !== '1') throw new Error(`grid cell "${ch}" is neither 0 nor 1`);
      out.push(ch === '1' ? MARKED : EMPTY);
    }
  }
  return out;
}

export function formatGrid(cells, r, c) {
  const rows = [];
  for (let y = 0; y < r; y++) rows.push(cells.slice(y * c, y * c + c).map((v) => (v === MARKED ? '1' : v === UNKNOWN ? '.' : '0')).join(''));
  return rows.join('/');
}

// Weighted sums. These are the only two lines that implement the rule; a row's weights are
// column indices and a column's weights are row indices, by design.
export function rowSum(cells, r, c, y) {
  let s = 0;
  for (let x = 0; x < c; x++) if (cells[cellIndex(r, c, y, x)] === MARKED) s += x + 1;
  return s;
}

export function colSum(cells, r, c, x) {
  let s = 0;
  for (let y = 0; y < r; y++) if (cells[cellIndex(r, c, y, x)] === MARKED) s += y + 1;
  return s;
}

export function cluesOf(cells, r, c) {
  const rows = [];
  const cols = [];
  for (let y = 0; y < r; y++) rows.push(rowSum(cells, r, c, y));
  for (let x = 0; x < c; x++) cols.push(colSum(cells, r, c, x));
  return { rows, cols };
}

// The identity that makes uniqueness meaningful: a board maps to exactly one clue pair, so
// the clue classes partition the 2^(r*c) boards. `|` separates the two vectors.
export function clueKey(r, c, rows, cols) {
  return `${r}x${c}|${rows.join(':')}|${cols.join(':')}`;
}

export function parseClueKey(key) {
  const [size, rs, cs] = String(key).split('|');
  const [r, c] = size.split('x').map(Number);
  return { r, c, rows: rs.split(':').map(Number), cols: cs.split(':').map(Number) };
}

export function markCount(cells) {
  let n = 0;
  for (const v of cells) if (v === MARKED) n++;
  return n;
}

// ---- validation ---------------------------------------------------------------------
// Every published lot passes through this before it is serialised, and every lot read back
// from js/data/lots.js passes through it again. Each error code has a negative test in
// test/grid.test.mjs; a validator that no test ever trips is decoration.

export const ERROR_CODES = [
  'dims', 'missing-row-clue', 'missing-col-clue', 'clue-range', 'cell-overlap', 'cell-value', 'grid-shape', 'solution-clue',
];

export function validateLot(lot) {
  const errors = [];
  const push = (code, msg) => errors.push({ code, msg });
  const r = lot && lot.r;
  const c = lot && lot.c;
  if (!Number.isInteger(r) || !Number.isInteger(c)) {
    push('dims', `r/c must be integers, got ${r}/${c}`);
    return { ok: false, errors };
  }
  try {
    checkDims(r, c);
  } catch (err) {
    push('dims', err.message);
  }
  const rows = lot.rows;
  const cols = lot.cols;
  if (!Array.isArray(rows) || rows.length !== r) push('missing-row-clue', `needs exactly ${r} row clues, got ${Array.isArray(rows) ? rows.length : typeof rows}`);
  if (!Array.isArray(cols) || cols.length !== c) push('missing-col-clue', `needs exactly ${c} column clues, got ${Array.isArray(cols) ? cols.length : typeof cols}`);
  if (Array.isArray(rows)) {
    for (let y = 0; y < rows.length; y++) {
      if (!Number.isInteger(rows[y]) || rows[y] < 0 || rows[y] > maxClue(c)) push('clue-range', `row ${y} clue ${rows[y]} outside 0..${maxClue(c)}`);
    }
  }
  if (Array.isArray(cols)) {
    for (let x = 0; x < cols.length; x++) {
      if (!Number.isInteger(cols[x]) || cols[x] < 0 || cols[x] > maxClue(r)) push('clue-range', `column ${x} clue ${cols[x]} outside 0..${maxClue(r)}`);
    }
  }
  const cells = lot.cells;
  if (Array.isArray(cells)) {
    if (cells.length !== r * c) push('grid-shape', `board has ${cells.length} cells, expected ${r * c}`);
    for (let i = 0; i < cells.length; i++) {
      const v = cells[i];
      // 2 means the same cell was marked twice — an overlap, and the classic double-count bug.
      if (v === 2) push('cell-overlap', `cell ${i} is marked twice`);
      else if (v !== EMPTY && v !== MARKED && v !== UNKNOWN) push('cell-value', `cell ${i} holds ${v}`);
    }
  } else if (cells !== undefined && cells !== null) {
    push('grid-shape', `cells must be an array or omitted, got ${typeof cells}`);
  }
  if (Array.isArray(cells) && cells.length === r * c && cells.every((v) => v === EMPTY || v === MARKED)) {
    const truth = cluesOf(cells, r, c);
    for (let y = 0; y < r; y++) if (Array.isArray(rows) && rows[y] !== truth.rows[y]) push('solution-clue', `row ${y}: grid sums to ${truth.rows[y]}, clue says ${rows[y]}`);
    for (let x = 0; x < c; x++) if (Array.isArray(cols) && cols[x] !== truth.cols[x]) push('solution-clue', `column ${x}: grid sums to ${truth.cols[x]}, clue says ${cols[x]}`);
  }
  return { ok: errors.length === 0, errors };
}

// ---- live feedback for the view ------------------------------------------------------
// Per-line sums of the player's current board. `over` is a hard no in this game: a line
// whose weighted sum already exceeds its clue can never come back (weights are positive),
// so the view highlights it and the completion test refuses it.
export function statusOf(lot, cells) {
  const { r, c, rows, cols } = lot;
  const lineRows = [];
  const lineCols = [];
  for (let y = 0; y < r; y++) {
    const sum = rowSum(cells, r, c, y);
    lineRows.push({ sum, clue: rows[y], ok: sum === rows[y], over: sum > rows[y], left: rows[y] - sum });
  }
  for (let x = 0; x < c; x++) {
    const sum = colSum(cells, r, c, x);
    lineCols.push({ sum, clue: cols[x], ok: sum === cols[x], over: sum > cols[x], left: cols[x] - sum });
  }
  const allOk = lineRows.every((l) => l.ok) && lineCols.every((l) => l.ok);
  return { rows: lineRows, cols: lineCols, allOk, over: [...lineRows, ...lineCols].filter((l) => l.over).length };
}

// A board is "clue-consistent" when every weighted sum matches its clue. That is the
// player-facing win test; `isSolution` additionally compares against the baked answer grid,
// and the two cannot disagree while `solutions === 1` — which test/lot.test.mjs asserts.
export function isClueConsistent(lot, cells) {
  return statusOf(lot, cells).allOk;
}

export function isSolution(lot, cells) {
  if (!Array.isArray(lot.solution)) return false;
  for (let i = 0; i < lot.solution.length; i++) if (lot.solution[i] !== cells[i]) return false;
  return true;
}

// ---- serialisation -------------------------------------------------------------------
// The shipped form carries only what a solver needs (the clue pair) plus what a *print*
// claims (the answer grid and the measured numbers). `tools/bake.mjs` re-derives the
// measured numbers from the clue pair alone; the answer grid is checked against the clues.

export function serializeLot(lot) {
  return {
    id: lot.id,
    tier: lot.tier,
    r: lot.r,
    c: lot.c,
    rows: lot.rows.slice(),
    cols: lot.cols.slice(),
    solution: formatGrid(lot.solution, lot.r, lot.c),
    solutions: lot.solutions,
    depth: lot.depth,
    chains: lot.chains,
    backtracks: lot.backtracks,
    nodes: lot.nodes,
    rank: lot.rank,
    clues: lot.r + lot.c,
    coreSize: lot.coreSize === undefined ? null : lot.coreSize,
    coreStatus: lot.coreStatus || 'skipped',
    marks: markCount(lot.solution),
  };
}

export function deserializeLot(row) {
  const lot = {
    id: row.id,
    tier: row.tier,
    r: Number(row.r),
    c: Number(row.c),
    rows: row.rows.map(Number),
    cols: row.cols.map(Number),
    solutions: Number(row.solutions),
    depth: Number(row.depth),
    chains: Number(row.chains),
    backtracks: Number(row.backtracks),
    nodes: Number(row.nodes),
    marks: Number(row.marks),
    rank: Number(row.rank),
    clues: Number(row.clues),
    coreSize: row.coreSize === null || row.coreSize === undefined ? null : Number(row.coreSize),
    coreStatus: String(row.coreStatus || 'skipped'),
  };
  lot.solution = parseGrid(row.solution, lot.r, lot.c);
  return lot;
}
