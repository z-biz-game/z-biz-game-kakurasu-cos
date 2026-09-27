// The save file. Two properties matter and both are asserted against a fake browser: the
// guarded back end really throws when there is no localStorage (rather than quietly answering
// "empty"), and a throwing localStorage still leaves a playable game.
import { test, run, ok, eq } from '../tools/harness.mjs';
import { store, rawBackend, SAVE_KEY } from '../js/core/storage.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;

function fakeStore({ throwOnGet = false, throwOnSet = false, corrupt = false, blockAll = false } = {}) {
  const mem = new Map();
  const api = {
    getItem: (k) => {
      if (throwOnGet) throw new Error('SecurityError: storage is disabled');
      return mem.has(k) ? mem.get(k) : null;
    },
    setItem: (k, v) => {
      if (throwOnSet) throw new Error('QuotaExceededError');
      mem.set(k, String(v));
    },
    removeItem: (k) => {
      mem.delete(k);
    },
  };
  if (corrupt) mem.set(SAVE_KEY, '{not json');
  if (blockAll) return { __throws: true };
  return { api, mem };
}

function withWindow(make, body) {
  const saved = globalThis.window;
  const made = make();
  if (made.__throws) {
    globalThis.window = {};
    Object.defineProperty(globalThis.window, 'localStorage', { get() { throw new Error('SecurityError'); } });
  } else {
    globalThis.window = { localStorage: made.api };
  }
  try {
    return { out: body(made), made };
  } finally {
    if (saved === undefined) delete globalThis.window;
    else globalThis.window = saved;
  }
}

test('with no window at all, the guarded accessor throws rather than returning null', () => {
  let err = null;
  try { rawBackend(); } catch (e) { err = e; }
  ok(err instanceof Error, 'rawBackend() must throw under node');
  eq(/no window/.test(err.message), true);
  eq(rawBackend.name, 'rawBackend');
});

test('and the game keeps playing anyway, in memory', () => {
  store.reset();
  eq(store.persistent, false);
  eq(store.unlocked, 1);
  const rec = store.solve('shoal-01', { taps: 12, par: 10, hints: 0 });
  eq(rec.best, 12);
  eq(rec.perfect, false);
  eq(Object.keys(store.records).length, 1);
  eq(store.stats.solves, 1);
  // ... and nothing was written anywhere, because there is nowhere to write
  eq(typeof globalThis.window, 'undefined');
});

test('best only ever goes down, plays and solves only ever go up', () => {
  store.reset();
  const first = store.solve('shoal-02', { taps: 20, par: 15, hints: 0 });
  eq(first.best, 20);
  const worse = store.solve('shoal-02', { taps: 40, par: 15, hints: 0 });
  eq(worse.best, 20, 'a worse replay must not overwrite the record');
  eq(worse.plays, 2);
  const better = store.solve('shoal-02', { taps: 15, par: 15, hints: 0 });
  eq(better.best, 15);
  eq(better.perfect, true);
  eq(store.stats.solves, 3);
  eq(store.stats.taps, 75);
});

test('a perfect flag is earned once and never lost', () => {
  store.reset();
  store.solve('shoal-03', { taps: 9, par: 9, hints: 0 });
  const after = store.solve('shoal-03', { taps: 99, par: 9, hints: 3 });
  eq(after.perfect, true);
  eq(store.stats.perfect, 1, 'the tally only counts a fresh perfect run');
});

test('a hinted run bills the hint and does not take the perfect flag', () => {
  store.reset();
  const rec = store.solve('shoal-04', { taps: 9, par: 9, hints: 2 });
  eq(rec.perfect, false);
  eq(store.stats.hints, 2);
  eq(store.stats.perfect, 0);
});

test('unlock is monotone: replaying level one cannot hide level nine', () => {
  store.reset();
  eq(store.unlock(5), 5);
  eq(store.unlock(2), 5);
  eq(store.unlock(5), 5);
  eq(store.unlock(9), 9);
  eq(store.unlocked, 9);
});

test('the daily slot is written and read back', () => {
  store.reset();
  eq(store.dailyDone('2026-09-27'), null);
  store.markDaily('2026-09-27', 'twined-04');
  const mark = store.dailyDone('2026-09-27');
  eq(mark.id, 'twined-04');
  ok(mark.at > 0);
  eq(store.dailyDone('2026-09-28'), null);
});

test('a solve reaches the disk when there is a disk to reach', () => {
  store.reset();
  const { made } = withWindow(() => fakeStore(), () => {
    store.reset();
    store.solve('linked-01', { taps: 12, par: 12, hints: 0 });
    store.unlock(3);
    return store.records['linked-01'].best;
  });
  const raw = JSON.parse(made.mem.get(SAVE_KEY));
  eq(raw.records['linked-01'].best, 12);
  eq(raw.records['linked-01'].perfect, true);
  eq(raw.unlocked, 3);
  eq(raw.stats.solves, 1);
});

// A genuinely cold module instance: the cache at the top of storage.js is per-module, so the
// only way to test "the next session reads what this one wrote" in node is to import the file
// a second time under a different specifier. Top-level await makes that possible in a sync
// suite; the browser layer covers the same ground with @save + @reloaded.
const disk = new Map();
const diskApi = {
  getItem: (k) => (disk.has(k) ? disk.get(k) : null),
  setItem: (k, v) => disk.set(k, String(v)),
  removeItem: (k) => disk.delete(k),
};
globalThis.window = { localStorage: diskApi };
disk.set(SAVE_KEY, JSON.stringify({
  records: { 'master-01': { solved: true, best: 27, plays: 2, perfect: true } },
  daily: { '2026-09-27': { id: 'master-01', at: 1 } },
  unlocked: 4,
  stats: { solves: 2, perfect: 1, taps: 51, hints: 0, notes: 0 },
}));
const reloaded = await import('../js/core/storage.js?cold=1');
test('a save written by one session is read by the next', () => {
  eq(reloaded.store.unlocked, 4);
  eq(reloaded.store.record('master-01').best, 27);
  eq(reloaded.store.record('master-01').perfect, true);
  eq(reloaded.store.stats.solves, 2);
  eq(reloaded.store.dailyDone('2026-09-27').id, 'master-01');
  eq(reloaded.store.persistent, true);
});
const partialDisk = new Map([['anything', null]]);
globalThis.window = { localStorage: { getItem: (k) => (k === SAVE_KEY ? JSON.stringify({ records: { a: { solved: true } } }) : null), setItem: () => {}, removeItem: () => {} } };
const partial = await import('../js/core/storage.js?cold=2');
test('a partial save fills in the fields it does not carry', () => {
  const cold = partial;
  eq(cold.store.unlocked, 1);
  eq(cold.store.stats.taps, 0);
  eq(cold.store.record('a').solved, true);
  eq(cold.store.daily, {});
});
delete globalThis.window;

test('a corrupt save starts clean instead of crashing the shell', () => {
  withWindow(() => fakeStore({ corrupt: true }), () => {
    store.reset(); // drop the module cache so the corrupt bytes are really read
    const rec = store.solve('shoal-05', { taps: 8, par: 8, hints: 0 });
    eq(rec.best, 8);
    eq(store.unlocked, 1);
  });
});

test('a localStorage that throws on read is survivable', () => {
  withWindow(() => fakeStore({ throwOnGet: true }), () => {
    store.reset();
    eq(store.persistent, true); // the object is callable; only this read failed
    const rec = store.solve('shoal-06', { taps: 7, par: 7, hints: 0 });
    eq(rec.best, 7);
    eq(store.stats.solves, 1);
  });
});

test('a localStorage that throws on write is survivable, and says so', () => {
  const { made } = withWindow(() => fakeStore({ throwOnSet: true }), () => {
    store.reset();
    const rec = store.solve('shoal-07', { taps: 6, par: 6, hints: 0 });
    eq(rec.best, 6, 'the in-memory record still works');
    eq(store.persistent, true);
    return null;
  });
  eq(made.mem.size, 0, 'a refused write must not have left a record behind');
});

test('a getter that throws (Safari private mode) is survivable too', () => {
  const before = (() => { try { return rawBackend(); } catch { return null; } })();
  eq(before, null, 'node has no localStorage at all');
  withWindow(() => fakeStore({ blockAll: true }), () => {
    let threw = false;
    try { rawBackend(); } catch { threw = true; }
    eq(threw, true, 'the throwing getter must surface as a throw, not as null storage');
    store.reset();
    const rec = store.solve('shoal-08', { taps: 5, par: 5, hints: 0 });
    eq(rec.best, 5);
    eq(store.persistent, false);
  });
});

test('reset really clears both the cache and the disk', () => {
  const made = fakeStore();
  withWindow(() => made, () => {
    store.reset();
    store.solve('shoal-09', { taps: 4, par: 4, hints: 0 });
    store.unlock(6);
    eq(Object.keys(store.records).length, 1);
    eq(made.mem.has(SAVE_KEY), true, 'the solve should have been persisted');
    store.reset();
    eq(Object.keys(store.records).length, 0);
    eq(store.unlocked, 1);
    eq(store.stats.solves, 0);
    eq(made.mem.has(SAVE_KEY), false, 'reset must take the key off the disk too');
  });
  // and after a reset the next solve starts from zero rather than a stale record
  withWindow(() => made, () => {
    store.reset();
    const rec = store.solve('shoal-09', { taps: 9, par: 4, hints: 0 });
    eq(rec.plays, 1);
    eq(rec.best, 9);
  });
});

test('notes are tallied separately from solves', () => {
  store.reset();
  eq(store.note(), 1);
  eq(store.note(), 2);
  eq(store.stats.notes, 2);
});

// ---- the layering rule that makes all of this testable ----------------------------------
test('js/core stays free of window/document except the one guarded module', () => {
  const dir = join(root, 'js', 'core');
  const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
  ok(files.length >= 7, `only ${files.length} core modules`);
  for (const f of files) {
    const src = readFileSync(join(dir, f), 'utf8');
    const hits = src.split('\n').filter((line) => /(^|[^.\w])(window|document)\./.test(line) && !/^\s*\/\//.test(line));
    if (f === 'storage.js') {
      ok(hits.length > 0, 'storage.js is the one allowed browser-global consumer');
      // ... and every use of it must sit inside a try, which is what `rawBackend` is for.
      // The house rule this repo adds: the low-level accessor must THROW when storage is
      // missing or hostile, and every consumer must wrap that throw. Returning null instead
      // would be indistinguishable from "the store answered: no save here", which legitimately
      // starts a new game -- and would silently swallow a blocked-storage browser.
      ok(/export function rawBackend/.test(src), 'storage.js must expose the throwing accessor');
      ok(/throw new Error\('no window/.test(src), 'the accessor must throw, not return null');
      ok(/try \{\s*return rawBackend\(\);\s*\} catch/.test(src), 'every consumer must wrap the throw');
    } else {
      eq(hits, [], `${f} touches a browser global: ${hits.join(' | ')}`);
    }
  }
});

test('no core module imports the DOM or another layer it should not touch', () => {
  for (const f of ['grid.js', 'count.js', 'logic.js', 'make.js', 'game.js', 'library.js', 'rng.js']) {
    const src = readFileSync(join(dir2(f)), 'utf8');
    eq(/import .*from '\.\.\//.test(src), f === 'library.js', `${f} reaches outside js/core`);
    eq(/requestAnimationFrame|addEventListener/.test(src), false, `${f} contains view code`);
  }
});

function dir2(f) {
  return join(root, 'js', 'core', f);
}

run();
