// Save file. One localStorage key, plain JSON, a versioned shape so an old save is recognised
// rather than mistaken for a new one, and a guarded back end.
//
// This is the ONE file in js/core that touches a browser global, and the guard is load-bearing
// rather than decorative. `window.localStorage` is not "undefined when unavailable": in Safari
// private mode and under some embedded webviews *reading the property throws*, and `setItem`
// throws on quota even when the object is there. So the handle is fetched inside a try, and
// the low-level accessor `rawBackend()` reports failure by THROWING — it never returns null,
// because a null here would be indistinguishable from "storage answered and said empty", and
// the second case legitimately starts a new save. Every caller in this file catches that throw
// and degrades to an in-memory session; `test/storage.test.mjs` asserts both halves (the throw
// is real, and the game still plays).
//
// Records are keyed by lot id (the baked campaign ids plus the date-derived daily id), with a
// campaign unlock pointer and a lifetime tally.

const KEY = 'kakurasu.save.v1';
// 存档格式版本号。写档带上、读档校验：将来改形状时旧档宁可整档丢弃，也不能被误读。
export const SAVE_VERSION = 1;

export const SAVE_KEY = KEY;

function blank() {
  return {
    v: SAVE_VERSION,
    records: {},
    daily: {},
    unlocked: 1,
    stats: { solves: 0, perfect: 0, taps: 0, hints: 0, notes: 0 },
  };
}

let cache = null;

// Throws when there is no usable localStorage. Callers decide what that means.
export function rawBackend() {
  if (typeof window === 'undefined' || !window) throw new Error('no window: no persistent save backend');
  const ls = window.localStorage; // may itself throw: that is why this whole body is wrapped
  if (!ls || typeof ls.getItem !== 'function' || typeof ls.setItem !== 'function') {
    throw new Error('localStorage is not callable');
  }
  return ls;
}

function current() {
  try {
    return rawBackend();
  } catch (err) {
    return null; // no window (node), blocked storage, or a throwing getter: memory-only
  }
}

// 数字字段的归一自带一份，不依赖仓里有没有 count() —— 少一层隐式耦合。
function recordNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// 存档两段式解码的第一段：整档 JSON 落到这里之后，**逐字段**归一。
// 一条记录不是"能用/不能用"二选一 —— 类型错的字段自己退成默认值，整条照样留下。
// 第二段（sanitizeRecords）在下面：它只丢掉归一后彻底没意义的记录，别的记录不受牵连。
function sanitizeRecord(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const out = {};
  out.solved = !!r.solved;
  out.best = recordNum(r.best);
  out.plays = recordNum(r.plays);
  out.perfect = !!r.perfect;
  return out;
}

// 逐条隔离：坏的那条丢掉，好的那些原样留下，绝不因为一条把整份存档作废。
function sanitizeRecords(p) {
  const out = {};
  if (!p || typeof p !== 'object' || Array.isArray(p)) return out;
  for (const [id, rec] of Object.entries(p)) {
    const clean = sanitizeRecord(rec);
    if (clean) out[id] = clean;
  }
  return out;
}

function load() {
  if (cache) return cache;
  const ls = current();
  let raw = null;
  if (ls) {
    try {
      raw = window.localStorage.getItem(KEY);
    } catch (err) {
      raw = null;
    }
  }
  if (raw) {
    try {
      const p = JSON.parse(raw);
      // 版本门：只认本仓写出去的版本。将来升 v2 时，旧档宁可整档丢弃也不能被误读成新档。
      if (p && typeof p === 'object' && !Array.isArray(p)
          && (p.v === undefined || p.v === SAVE_VERSION)) {
        const base = blank();
        cache = {
          records: sanitizeRecords(p.records),
          daily: p.daily && typeof p.daily === 'object' ? p.daily : base.daily,
          unlocked: Number(p.unlocked) > 0 ? Number(p.unlocked) : base.unlocked,
          stats: { ...base.stats, ...(p.stats || {}) },
        };
        return cache;
      }
    } catch (err) {
      // A corrupt save is not worth keeping; start clean rather than crash the shell.
    }
  }
  cache = blank();
  return cache;
}

function persist() {
  const ls = current();
  if (!ls) return false;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(cache));
    return true;
  } catch (err) {
    return false; // quota or a blocked write: the session stays in memory, which is the deal
  }
}

export const store = {
  get records() { return load().records; },
  get stats() { return load().stats; },
  get daily() { return load().daily; },
  get unlocked() { return load().unlocked; },
  get persistent() { return current() !== null; },

  record(id) {
    return load().records[id] || null;
  },

  // Unlocking is monotone: replaying an early board must never hide a later one.
  unlock(n) {
    const s = load();
    if (n > s.unlocked) s.unlocked = n;
    persist();
    return s.unlocked;
  },

  markDaily(dateKey, id) {
    const s = load();
    s.daily[dateKey] = { id, at: Date.now() };
    persist();
  },

  dailyDone(dateKey) {
    return load().daily[dateKey] || null;
  },

  // `par` is the tap floor proved in js/core/game.js, so "一次到位" is a fact about this board.
  // A hinted run bills the hint and never takes the perfect flag; a best is only ever lowered,
  // never raised, by a worse replay.
  solve(id, { taps, par, hints }) {
    const s = load();
    const prev = s.records[id];
    const cur = {
      solved: true,
      best: !prev || !prev.best || taps < prev.best ? taps : prev.best,
      plays: (prev && prev.plays ? prev.plays : 0) + 1,
      perfect: (taps <= par && !hints) || !!(prev && prev.perfect),
    };
    s.records[id] = cur;
    s.stats.solves += 1;
    s.stats.taps += taps;
    s.stats.hints += hints || 0;
    if (taps <= par && !hints) s.stats.perfect += 1;
    persist();
    return cur;
  },

  note() {
    const s = load();
    s.stats.notes += 1;
    persist();
    return s.stats.notes;
  },

  // Wipe: both the in-memory cache and whatever is on disk. `js/main.js` arms this behind a
  // double click, and a stale cache surviving a wipe would be worse than no wipe at all — the
  // screen would say "cleared" while the records came back.
  reset() {
    cache = blank();
    const ls = current();
    if (ls) {
      try {
        ls.removeItem(KEY);
      } catch (err) {
        /* nothing was ever persisted */
      }
    }
    return cache;
  },
};
