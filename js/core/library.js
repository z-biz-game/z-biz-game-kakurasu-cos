// The shipped pool, and the routes in front of it. Everything a player can reach resolves
// through here: campaign order, `#/lot/<id>` shares, the daily pick, and the bounded live
// generator behind `#/random`.
//
// Two kinds of puzzle exist in this repo and they must not be confused:
//
//   * published rows (js/data/lots.js) — baked by tools/bake.mjs, every printed number
//     re-derived from the serialised clue pair, `solutions` proven to be 1 by two counters.
//     The campaign and the daily board come from here, so a page load never searches.
//   * live lots (#/random/<tier>/<key>) — generated in the browser from the seed in the URL,
//     under the same acceptance gates but with the expensive clue-minimisation skipped
//     (`withCore: false`). Bounded by MAX_ATTEMPTS and by the counters' node caps.
//
// Pure module: no window, no document.

import { LOTS, TIERS_META, PROOF } from '../data/lots.js';
import { deserializeLot, clueKey } from './grid.js';
import { TIERS, makeLot, rankOf, blankStats } from './make.js';
import { hashSeed } from './rng.js';

export const ALL = LOTS.map(deserializeLot);
export { TIERS, PROOF, blankStats };

// The band a tier is filled from, merged with the envelope the shipped rows actually landed
// in. `band` is the generation target, `shipped` is what the campaign really shows; the two
// are printed side by side by bake so they can never be silently conflated.
const META = new Map(TIERS_META.map((m) => [m.key, m]));

export function tierByKey(key) {
  const t = TIERS.find((x) => x.key === key) || TIERS[0];
  const m = META.get(t.key);
  if (!m) return { ...t };
  // The baked meta overrides the placeholder band in make.js: `band` here is the rung the
  // ladder was cut to, and `measured` is the sample it was cut from. A tier with no baked row
  // keeps its unmeasured [0, 0], which makeLot treats as "do not filter".
  return {
    ...t,
    ...m,
    shipped: [m.rankMin, m.rankMax],
    depthBand: [m.depthMin, m.depthMax],
    chainsBand: [m.chainsMin, m.chainsMax],
  };
}

export function tiersWithBands() {
  return TIERS.map((t) => tierByKey(t.key));
}

export function byId(id) {
  return ALL.find((l) => l.id === id) || null;
}

export function at(index) {
  return ALL[Math.min(ALL.length - 1, Math.max(0, index))];
}

export function lotsIn(tierKey) {
  return ALL.filter((l) => l.tier === tierKey);
}

// Same calendar day, same board, on every device: the date string is hashed and taken modulo
// the pool, and the pool is checked in as source. No search, no clock dependence beyond the
// date itself.
export function dailyFromPool(dateKey) {
  const h = hashSeed(String(dateKey));
  return ALL[h % ALL.length];
}

// Live generation for #/random. Deterministic in `key`: same link, same board, and the lot
// that comes back has been through the same uniqueness gates as the shipped ones.
export function randomLot(key, tierKey, stats = blankStats()) {
  const tier = tierByKey(tierKey);
  return makeLot(`random:${tier.key}:${key}`, tier, { stats, band: tier.band, withCore: false });
}

export function rankOfLot(lot) {
  return rankOf(lot);
}

export function lotKey(lot) {
  return clueKey(lot.r, lot.c, lot.rows, lot.cols);
}

export function stats() {
  const byTier = {};
  for (const base of TIERS) {
    const t = tierByKey(base.key);
    const mine = ALL.filter((l) => l.tier === t.key);
    const ranks = mine.map(rankOf);
    byTier[t.key] = {
      n: mine.length,
      band: t.band,
      min: mine.length ? Math.min(...ranks) : null,
      max: mine.length ? Math.max(...ranks) : null,
      depthMin: mine.length ? Math.min(...mine.map((l) => l.depth)) : null,
      depthMax: mine.length ? Math.max(...mine.map((l) => l.depth)) : null,
      backtracksMax: mine.length ? Math.max(...mine.map((l) => l.backtracks)) : null,
      size: `${t.r}×${t.c}`,
      coresVerified: mine.filter((l) => l.coreStatus === 'holds').length,
      cells: mine.reduce((a, l) => a + l.marks, 0),
    };
  }
  return {
    lots: ALL.length,
    byTier,
    proof: PROOF,
    unique: ALL.filter((l) => l.solutions === 1).length,
    assumptionLots: ALL.filter((l) => l.depth > 0).length,
  };
}
