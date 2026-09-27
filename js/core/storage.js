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
      if (p && typeof p === 'object') {
        const base = blank();
        cache = {
          records: p.records && typeof p.records === 'object' ? p.records : base.records,
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
