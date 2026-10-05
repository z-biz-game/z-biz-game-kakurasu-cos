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

export const SAVE_KEY = KEY;

function blank() {
  return {
    records: {},
    daily: {},
    unlocked: 1,
    stats: { solves: 0, perfect: 0, taps: 0, hints: 0 },
  };
}

const MAX_BEST = 1e6; // 一关的点击数不可能到这个量级；到了就是脏数据，不是纪录
const MAX_UNLOCKED = 1e4;

function intIn(v, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > max) return null;
  return n;
}

// 第二段解码的第一半：一条记录坏掉只丢这一条。`null`、缺字段、类型错、越界值各走各的分支，
// 都不许把同一份存档里其他关卡的成绩一起带走 —— 那是"整局冻死"的成因。
export function sanitizeRecords(raw) {
  const out = { records: {}, dropped: 0 };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw != null) out.dropped = 1;
    return out;
  }
  for (const id of Object.keys(raw)) {
    const v = raw[id];
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      out.dropped += 1;
      continue;
    }
    const best = intIn(v.best, MAX_BEST);
    const plays = intIn(v.plays, MAX_BEST);
    if (v.best !== undefined && best === null) {
      out.dropped += 1; // best 存在但不可用：这条记录不可信，整条丢
      continue;
    }
    if (!v.solved && best === null) {
      out.dropped += 1;
      continue;
    }
    out.records[id] = {
      solved: !!v.solved,
      best: best === null ? 0 : best,
      plays: plays === null ? 1 : plays,
      perfect: !!v.perfect,
    };
  }
  return out;
}

// 每日槽只用来判断"今天打过没有"，坏一条不影响别的日期。
export function sanitizeDaily(raw) {
  const out = { daily: {}, dropped: 0 };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw != null) out.dropped = 1;
    return out;
  }
  for (const day of Object.keys(raw)) {
    const v = raw[day];
    if (typeof v === 'string' && v.length <= 64) {
      out.daily[day] = { id: v, at: 0 };
      continue;
    }
    if (!v || typeof v !== 'object' || Array.isArray(v) || typeof v.id !== 'string') {
      out.dropped += 1;
      continue;
    }
    out.daily[day] = { id: v.id, at: Number.isFinite(Number(v.at)) ? Number(v.at) : 0 };
  }
  return out;
}

export function sanitizeStats(raw) {
  const base = blank().stats;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  for (const k of Object.keys(base)) {
    const n = intIn(raw[k], Number.MAX_SAFE_INTEGER);
    if (n !== null) base[k] = n;
  }
  return base;
}

// 解码入口：给一份已经 JSON.parse 出来的东西（或垃圾），返回一份可直接用的存档 + 丢弃计数。
export function decodeSave(p) {
  const base = blank();
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    return { save: base, dropped: { records: 1, daily: 1 }, corrupt: true };
  }
  const rec = sanitizeRecords(p.records);
  const day = sanitizeDaily(p.daily);
  const unlocked = intIn(p.unlocked, MAX_UNLOCKED);
  return {
    save: {
      records: rec.records,
      daily: day.daily,
      unlocked: unlocked && unlocked >= 1 ? unlocked : base.unlocked,
      stats: sanitizeStats(p.stats),
    },
    dropped: { records: rec.dropped, daily: day.dropped },
    corrupt: false,
  };
}

let cache = null;
let dropped = { records: 0, daily: 0 };

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

function load() {
  if (cache) return cache;
  const ls = current();
  let raw = null;
  if (ls) {
    try {
      raw = ls.getItem(KEY);
    } catch (err) {
      raw = null;
    }
  }
  if (raw) {
    try {
      const p = JSON.parse(raw);
      const decoded = decodeSave(p);
      cache = decoded.save;
      dropped = decoded.dropped;
      return cache;
    } catch (err) {
      // A corrupt save is not worth keeping; start clean rather than crash the shell.
      dropped = { records: 1, daily: 1 };
    }
  }
  cache = blank();
  return cache;
}

function persist() {
  const ls = current();
  if (!ls) return false;
  try {
    ls.setItem(KEY, JSON.stringify(cache));
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
  // 本次解码丢掉的条数：一条坏记录只丢那一条，这个数就是"丢了几条"的证据。
  get dropped() { load(); return dropped; },

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

  // Wipe: both the in-memory cache and whatever is on disk. `js/main.js` arms this behind a
  // double click, and a stale cache surviving a wipe would be worse than no wipe at all — the
  // screen would say "cleared" while the records came back.
  reset() {
    cache = blank();
    dropped = { records: 0, daily: 0 };
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
