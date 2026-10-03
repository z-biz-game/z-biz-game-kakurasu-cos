// The shell: hash routes in, canvas out, records in between. Nothing here knows the rules of
// the grid — those live in js/core — and nothing here draws — that is js/view.js.
//
// Route table:
//   #/campaign/<n> | #/c/<n>   the nth baked lot
//   #/lot/<id>                 a shared baked lot, by the id printed in js/data/lots.js
//   #/daily                    today's lot, picked from the baked pool by hashSeed(YYYY-MM-DD)
//   #/random/<tier>/<key>      a live lot, generated from `key` under the same acceptance gates
//   anything else              falls back to the campaign frontier
//
// The daily board is *not* generated live: it is a pool index, so two devices on the same date
// cannot drift, and a page load never runs a search. #/random is the only live generation in the
// app, and it is bounded by MAX_ATTEMPTS plus the counters' node caps (js/core/make.js).

import { createGame, tap, undo, reset, progress, remaining, grade, overLines, cellValue, ON, NOTE } from './core/game.js';
import { store } from './core/storage.js';
import { TIERS, ALL, byId, at, lotsIn, tierByKey, tiersWithBands, dailyFromPool, randomLot, stats as poolStats } from './core/library.js';
import { nextDeduction, analyse } from './core/logic.js';
import { countSolutionsDP, countSolutionsBacktrack } from './core/count.js';
import { SOLVER_NODE_CAP } from './core/make.js';
import { formatGrid, markCount } from './core/grid.js';
import { todayKey } from './core/rng.js';
import { createView } from './view.js';

const $ = (id) => document.getElementById(id);
const el = {
  modes: $('modes'), totals: $('totals'), crumbs: $('crumbs'), readout: $('readout'),
  shelf: $('shelf'), hintline: $('hintline'), curtain: $('curtain'), stars: $('stars'),
  verdict: $('verdict'), tally: $('tally'), undo: $('undo'), note: $('note'), hint: $('hint'),
  restart: $('restart'), share: $('share'), next: $('next'), again: $('again'),
  toast: $('toast'), canvas: $('grid'), wipe: $('wipe'),
};

const LEVELS = ALL.length;
const app = {
  mode: 'campaign',
  index: 1,
  route: null,
  lot: null,
  game: null,
  live: null, // the live-generated lot, when the route is #/random
  hints: 0,
  label: '',
  day: null,
};

function clampIndex(n) {
  return Math.min(LEVELS, Math.max(1, Number(n) || 1));
}

function parseHash(hash = location.hash) {
  const p = String(hash).replace(/^#\/?/, '').split('/').filter(Boolean);
  if (p[0] === 'daily') return { mode: 'daily' };
  if (p[0] === 'random') return { mode: 'random', tier: p[1] || TIERS[0].key, key: p[2] || null };
  if (p[0] === 'lot') return { mode: 'lot', id: p[1] };
  const n = p[0] === 'c' || p[0] === 'campaign' ? Number(p[1]) : Number(p[0]);
  return { mode: 'campaign', index: clampIndex(n) };
}

function linkFor(rt) {
  if (rt.mode === 'daily') return '#/daily';
  if (rt.mode === 'random') return `#/random/${rt.tier}/${rt.key}`;
  if (rt.mode === 'lot') return `#/lot/${rt.id}`;
  return `#/c/${rt.index}`;
}

function resolve(rt) {
  if (rt.mode === 'daily') {
    const day = todayKey();
    return { lot: dailyFromPool(day), label: `每日数和 · ${day}`, note: day, day };
  }
  if (rt.mode === 'random') {
    const tier = tierByKey(rt.tier);
    const live = randomLot(rt.key, tier.key);
    if (live) {
      return { lot: hydrate(live, `random-${rt.key}`), live, label: `随机 · ${tier.label}`, note: tier.blurb };
    }
    // The bounded search found nothing inside its attempt ceiling for this token. Say so and
    // hand over a baked lot rather than hanging or blanking the board.
    return { lot: at(0), label: `随机 · ${tier.label}（改用题库）`, note: '生成器在 400 次尝试内没有抽中这一档' };
  }
  if (rt.mode === 'lot') {
    const lot = byId(rt.id) || ALL[0];
    return { lot, label: `关卡 ${lot.id}`, note: tierByKey(lot.tier).blurb };
  }
  const lot = at(rt.index - 1);
  return { lot, label: `第 ${rt.index} 关`, note: `共 ${LEVELS} 关 · ${tierByKey(lot.tier).label}` };
}

// A live lot carries its answer as a grid string; the baked rows are already parsed. This
// normalises both into the shape createGame() wants, so the shell has one code path.
function hydrate(live, id) {
  const solution = typeof live.solution === 'string' ? parseSolution(live.solution, live.r, live.c) : live.solution;
  return { ...live, id, solution, marks: markCount(solution) };
}

function parseSolution(text, r, c) {
  // js/core/grid.js owns the real parser; live lots arrive from makeLot with an array already,
  // so this only ever runs for a string.
  const out = [];
  for (const ch of String(text).replace(/\//g, '')) out.push(ch === '1' ? ON : 0);
  if (out.length !== r * c) throw new Error(`bad live solution ${text}`);
  return out;
}

const view = createView(el.canvas, {
  onTap: (pos, note) => commit(pos, note),
  onIllegal: (pos, why) => {
    if (why === 'done') say('这一关已经解开了 —— 盘面锁定');
    else say(`第 <b>${Math.floor(pos / app.game.c) + 1}</b> 行第 <b>${(pos % app.game.c) + 1}</b> 列现在不能这么点`);
  },
  onPaint: () => {},
});

function setGame(lot, label) {
  app.lot = lot;
  app.label = label || app.label;
  app.game = createGame(lot);
  app.hints = 0;
  view.attach(app.game);
  el.curtain.hidden = true;
  say('');
}

function say(html) {
  el.hintline.innerHTML = html;
}

function starText(n) {
  return '★'.repeat(n) + '☆'.repeat(3 - n);
}

function field(label, value, note, cls = '') {
  return `<div class="${cls}"><dt>${label}</dt><dd>${value}</dd><dt><small>${note}</small></dt></div>`;
}

function renderCrumbs() {
  const tier = tierByKey(app.lot.tier);
  const rec = store.record(app.lot.id);
  el.crumbs.innerHTML = `${app.label}<b>${tier.label}<span class="band"> ${tier.blurb}</span></b>`;
  el.readout.innerHTML = [
    field('点击', app.game.taps, '含撤销'),
    field('最少', app.game.par, '唯一解的格子数', 'par'),
    field('解数', app.lot.solutions, '两条计数器算出', 'sols'),
    field('推理', app.lot.rank, `深度 ${app.lot.depth} · 轮数 ${app.lot.chains}`, 'best'),
    field('超和', overLines(app.game), '行或列已越过线索', 'over'),
    field('最佳', rec && rec.best ? rec.best : '—', rec && rec.perfect ? '等于最少' : '你的纪录'),
  ].join('');
  el.undo.disabled = !app.game.history.length || app.game.done;
  el.hint.disabled = app.game.done;
  el.note.setAttribute('aria-pressed', String(!!app.game.noteMode));
}

function renderTotals() {
  const solvedN = ALL.filter((l) => {
    const r = store.record(l.id);
    return r && r.solved;
  }).length;
  const perfectN = ALL.filter((l) => {
    const r = store.record(l.id);
    return r && r.perfect;
  }).length;
  el.totals.innerHTML = `已通 <b>${solvedN}</b>/${LEVELS} · 完美 <b>${perfectN}</b> · 提示 <b>${store.stats.hints}</b>`;
}

function renderShelf() {
  if (app.mode === 'campaign') {
    const unlocked = store.unlocked;
    let html = '';
    for (const tier of tiersWithBands()) {
      html += `<p class="tier">${tier.label} · ${tier.blurb} · 题库 ${tier.lots} 关</p>`;
      for (const lot of lotsIn(tier.key)) {
        const n = ALL.indexOf(lot) + 1;
        const rec = store.record(lot.id);
        const cls = [
          n === app.index ? 'here' : '',
          rec && rec.perfect ? 'perfect' : rec && rec.solved ? 'done' : '',
        ].filter(Boolean).join(' ');
        html += `<button type="button" data-index="${n}" class="${cls}" title="推理 ${lot.rank} · 最少 ${lot.marks} 点" ${n > unlocked ? 'disabled' : ''}>${n}</button>`;
      }
    }
    el.shelf.innerHTML = html;
    el.shelf.querySelectorAll('button[data-index]').forEach((b) => {
      b.addEventListener('click', () => go(`#/c/${b.dataset.index}`));
    });
    return;
  }
  if (app.mode === 'random') {
    let html = '<p class="tier">选一段（数字是实测推理值）</p>';
    for (const tier of tiersWithBands()) {
      const on = app.route && tier.key === app.route.tier ? 'here' : '';
      html += `<button type="button" class="${on}" data-tier="${tier.key}">${tier.label}<br><small>${tier.blurb}</small></button>`;
    }
    html += '<button type="button" class="wide" data-reroll="1">换一局</button>';
    el.shelf.innerHTML = html;
    el.shelf.querySelectorAll('button[data-tier]').forEach((b) => {
      b.addEventListener('click', () => go(`#/random/${b.dataset.tier}/${token()}`));
    });
    el.shelf.querySelector('[data-reroll]').addEventListener('click', () => go(`#/random/${app.route.tier}/${token()}`));
    return;
  }
  if (app.mode === 'daily') {
    const done = app.day && store.dailyDone(app.day);
    el.shelf.innerHTML = `<p class="tier">今天这一局对所有人相同${done ? ' · 已通过' : ''}</p>`
      + `<button type="button" class="wide" data-back="1">回到战役 第 ${store.unlocked} 关</button>`;
  } else {
    el.shelf.innerHTML = '<p class="tier">分享的关卡</p>';
  }
  const back = el.shelf.querySelector('[data-back]');
  if (back) back.addEventListener('click', () => go(`#/c/${store.unlocked}`));
}

function token() {
  // `Math.random()` can in principle return exactly 0, which would stringify to "0" and mint an
  // empty token — and an empty token is a route that re-mints itself forever.
  return Math.random().toString(36).slice(2) || 'roll';
}

function render() {
  el.modes.querySelectorAll('button').forEach((b) => {
    b.setAttribute('aria-current', String(b.dataset.mode === app.mode));
  });
  renderCrumbs();
  renderTotals();
  renderShelf();
}

// The one place a tap happens: a finger on the canvas, a replay from a test link, and the
// solver's own hint all arrive here and are held to the same rule.
function commit(pos, note) {
  const moved = tap(app.game, pos, note === undefined ? undefined : { note });
  if (!moved) {
    view.redraw();
    return false;
  }
  if (app.game.done) finish();
  else {
    view.redraw();
    renderCrumbs();
    const nowOn = app.game.cells[pos] === ON;
    const isNote = app.game.cells[pos] === NOTE;
    const y = Math.floor(pos / app.game.c) + 1;
    const x = (pos % app.game.c) + 1;
    const prog = progress(app.game);
    say(`${isNote ? '划掉' : nowOn ? '选中' : '取消'} <b>第 ${y} 行第 ${x} 列</b> · 第 ${y} 行 ${prog.rows[y - 1].sum}/${prog.rows[y - 1].clue} · 第 ${x} 列 ${prog.cols[x - 1].sum}/${prog.cols[x - 1].clue} · 还差 <b>${remaining(app.game)}</b> 格`);
  }
  return true;
}

function finish() {
  const lot = app.lot;
  const g = app.game;
  const rec = store.solve(lot.id, { taps: g.taps, par: g.par, hints: app.hints });
  if (app.day) store.markDaily(app.day, lot.id);
  let nextIndex = 0;
  if (app.mode === 'campaign') {
    store.unlock(Math.max(store.unlocked, app.index + 1));
    nextIndex = app.index < LEVELS ? app.index + 1 : 0;
  }
  const gr = grade(g);
  el.stars.textContent = starText(gr.stars);
  el.verdict.textContent = gr.label;
  el.tally.innerHTML = `你的 <b>${g.taps}</b> 点 · 最少 <b>${g.par}</b> 点（唯一解的格子数）· 解数 <b>${lot.solutions}</b> · 提示 <b>${app.hints}</b>`
    + (rec.best === g.taps ? '<br>这是这一关的最好成绩' : '');
  el.next.hidden = !nextIndex;
  el.curtain.hidden = false;
  render();
}

function go(hash) {
  if (location.hash === hash) apply();
  else location.hash = hash;
}

function apply() {
  const rt = parseHash();
  app.route = rt;
  app.mode = rt.mode;
  if (rt.mode === 'random' && !rt.key) {
    // A bare #/random/twined would mean a different board on every visit and an unreproducible
    // link, so the token is minted once and written back into the URL.
    location.replace(`${location.pathname}${location.search}#/random/${rt.tier}/${token()}`);
    return;
  }
  const r = resolve(rt);
  if (!r.lot) {
    say('这一段还没有关卡');
    return;
  }
  app.live = r.live || null;
  app.day = r.day || null;
  app.index = rt.mode === 'campaign' ? rt.index : ALL.indexOf(r.lot) + 1;
  setGame(r.lot, r.label);
  render();
}

let toastTimer = 0;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 1800);
}

function shareLink() {
  const url = `${location.origin}${location.pathname}#/lot/${app.lot.id}`;
  const done = () => toast('链接已复制');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(done, () => toast(url));
  } else {
    toast(url);
  }
}

el.modes.addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-mode]');
  if (!b) return;
  if (b.dataset.mode === 'campaign') go(`#/c/${clampIndex(store.unlocked)}`);
  else if (b.dataset.mode === 'daily') go('#/daily');
  else go(`#/random/${TIERS[0].key}/${token()}`);
});

el.undo.addEventListener('click', () => {
  if (undo(app.game)) {
    view.redraw();
    renderCrumbs();
    if (!app.game.history.length) say('回到起点');
  }
});

el.note.addEventListener('click', () => {
  app.game.noteMode = !app.game.noteMode;
  renderCrumbs();
  say(app.game.noteMode ? '标记模式：点格子是<b>划掉</b>它（不计入带权和），再点取消' : '选格模式：点格子计入行/列带权和');
  view.redraw();
});

el.hint.addEventListener('click', () => {
  const h = nextDeduction(app.lot, app.game.cells);
  app.hints += 1;
  if (h.contradiction) {
    say('提示说：这一盘已经自相矛盾了 —— 有行的带权和越过了线索，先撤销');
  } else if (h.complete) {
    say('提示说：盘面已经对了');
  } else if (h.stuck) {
    say('提示说：纯推理到此为止，这一格之后要<em>假设</em>（实测深度 ' + app.lot.depth + '）');
  } else {
    const y = Math.floor(h.pos / app.game.c) + 1;
    const x = (h.pos % app.game.c) + 1;
    view.showHint(h.pos);
    say(`提示：<b>第 ${y} 行第 ${x} 列</b> ${h.value === ON ? '必须选中' : '必须留空'} —— 每一行都试过了，只有这一种走法`);
  }
  renderCrumbs();
});

function restart() {
  reset(app.game);
  app.hints = 0;
  el.curtain.hidden = true;
  view.redraw();
  render();
  say('回到起点');
}

el.restart.addEventListener('click', restart);
el.share.addEventListener('click', shareLink);
el.again.addEventListener('click', restart);
el.next.addEventListener('click', () => go(`#/c/${Math.min(LEVELS, app.index + 1)}`));

// Wiping the save is the one destructive thing this game can do, so it asks twice instead of
// firing on a stray click.
let wipeArmed = false;
el.wipe.addEventListener('click', () => {
  if (!wipeArmed) {
    wipeArmed = true;
    toast('再点一次会清空本机全部成绩');
    setTimeout(() => { wipeArmed = false; }, 4000);
    return;
  }
  store.reset();
  wipeArmed = false;
  toast('存档已清空');
  apply();
});

window.addEventListener('hashchange', apply);
window.addEventListener('resize', () => view.measure());
window.addEventListener('keydown', (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const k = ev.key.toLowerCase();
  if (k === 'escape' && !el.curtain.hidden) el.curtain.hidden = true;
  else if (k === 'u') el.undo.click();
  else if (k === 'h') el.hint.click();
  else if (k === 'r') el.restart.click();
  else if (k === 'n') el.note.click();
});

view.start();
// Deliberately not paused on visibilitychange: the hint pulse and the win card are driven from
// the same loop, and a tab that reports itself hidden (headless Chrome does) must still be able
// to finish a level.
apply();

const api = {
  version: 1,
  get state() {
    const g = app.game;
    return {
      mode: app.mode,
      label: app.label,
      id: app.lot && app.lot.id,
      tier: app.lot && app.lot.tier,
      index: app.index,
      taps: g && g.taps,
      par: g && g.par,
      solutions: app.lot && app.lot.solutions,
      depth: app.lot && app.lot.depth,
      chains: app.lot && app.lot.chains,
      backtracks: app.lot && app.lot.backtracks,
      rank: app.lot && app.lot.rank,
      hints: app.hints,
      done: !!(g && g.done),
      over: g ? overLines(g) : 0,
      left: g ? remaining(g) : -1,
      noteMode: !!(g && g.noteMode),
      unlocked: store.unlocked,
      solved: ALL.filter((l) => store.record(l.id) && store.record(l.id).solved).length,
      curtain: !el.curtain.hidden,
      r: g && g.r,
      c: g && g.c,
      size: g && `${g.r}x${g.c}`,
    };
  },
  get pool() { return poolStats(); },
  get bands() { return tiersWithBands(); },
  load(hash) { go(hash); return app.lot && app.lot.id; },
  // Where cell `pos` is right now, in client pixels — what an automated finger needs.
  cellPoint(pos) { return view.cellPoint(pos); },
  pointAt(x, y) { return view.pointAt(x, y); },
  runFrom(a, b) { return view.runFrom(a, b); },
  cells() { return app.game ? app.game.cells.slice() : null; },
  gridText() { return app.game ? formatGrid(app.game.cells, app.game.r, app.game.c) : null; },
  // The certified answer, as cell indices — so a test taps the answer rather than re-deriving
  // it from the '/'-separated grid string, whose indices are not cell positions.
  answer() { return app.lot ? app.lot.solution.map((v, i) => (v === ON ? i : -1)).filter((i) => i >= 0) : null; },
  sums() { return app.game ? progress(app.game) : null; },
  solution() { return app.lot ? formatGrid(app.lot.solution, app.lot.r, app.lot.c) : null; },
  lot() {
    return app.lot
      ? { id: app.lot.id, r: app.lot.r, c: app.lot.c, rows: app.lot.rows, cols: app.lot.cols, solution: formatGrid(app.lot.solution, app.lot.r, app.lot.c), solutions: app.lot.solutions, rank: app.lot.rank }
      : null;
  },
  // Play a list of cells through the same commit() a finger uses. `null` = default mode.
  play(list, note) {
    for (const pos of list || []) commit(pos, note);
    return app.game.taps;
  },
  tapCell(pos, note) { return commit(pos, note); },
  undoOnce() { el.undo.click(); return app.game.taps; },
  hintOnce() { el.hint.click(); return { hints: app.hints, line: el.hintline.textContent }; },
  noteOnce() { el.note.click(); return app.game.noteMode; },
  toggleNote(on) { if (app.game.noteMode !== !!on) el.note.click(); return app.game.noteMode; },
  reset() { restart(); return app.game.taps; },
  cellValue(y, x) { return cellValue(app.game, y, x); },
  pixels() { return view.pixelsHash(); },
  painted() { return view.painted(); },
  // Re-derive, on this device, the two numbers the screen is billing this lot against: the
  // solution count (both shipped counters) and the measured difficulty. This is what lets the
  // browser suite say "the page agrees with the printed row" rather than "the page printed
  // something". It is a limit-2 count plus a capped search: bounded by construction.
  recheck() {
    const lot = app.lot;
    if (!lot) return null;
    const dp = countSolutionsDP(lot, { limit: 2 });
    const bt = countSolutionsBacktrack(lot, { limit: 2 });
    const an = analyse(lot, { nodeCap: SOLVER_NODE_CAP });
    return {
      printed: { solutions: lot.solutions, depth: lot.depth, chains: lot.chains, backtracks: lot.backtracks, nodes: lot.nodes, rank: lot.rank },
      counted: { dp: dp.count, dpBailed: dp.bailed, dpStates: dp.states, bt: bt.count, btBailed: bt.bailed, btNodes: bt.nodes },
      measured: { solved: an.solved, capped: an.capped, depth: an.depth, chains: an.chains, backtracks: an.backtracks, nodes: an.nodes },
      agrees: dp.count === lot.solutions && bt.count === lot.solutions && !dp.bailed && !bt.bailed
        && an.depth === lot.depth && an.chains === lot.chains && an.backtracks === lot.backtracks && an.nodes === lot.nodes,
    };
  },
  store,
};

window.kakurasu = api;
// The spec's short hook name; both point at the same object so a test link works either way.
window.kaku = api;

// ---- 全屏开关 ----
//
// 绑到 index.html 的 HUD 里真实存在的 #btn-fullscreen。
// 只在 js 里留一串 requestFullscreen 能骗过字符串扫描，但按钮不在 DOM 里就是死代码：
// 玩家按不到，功能等于没做。所以 id 必须与 HTML 里的按钮对得上，缺失时要在控制台喊出来。
//
// 三套 API 一律**特性探测**，不做 UA 判断：iPhone 版 Safari 压根没有元素全屏（只有 <video> 能全屏），
// 老 Edge 只认 ms 前缀，Firefox 认 moz 前缀。UA 字符串是猜的，方法在不在是量的，猜错就静默失效。
function fsRoot() {
  return document.documentElement;
}

function fsElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function fsRequest(root) {
  // 老 Edge 的 msRequestFullscreen 挂在元素上，和标准名同一个位置，所以并排取即可。
  return root.requestFullscreen || root.webkitRequestFullscreen || root.msRequestFullscreen || null;
}

// iOS Safari 会把非 video 元素的请求直接 reject 成 NotAllowedError。
// 这个 promise 没人接就升级成 unhandledrejection，冒到 window.onerror——离屏预载时足以把整页判死。
// 因此凡是可能返回 promise 的调用，返回值一律就地吞掉，绝不让拒绝逃出这一层。
function fsQuiet(p) {
  if (p && typeof p.catch === 'function') p.catch(() => {});
  return p;
}

// 返回 true=请求进入，false=请求退出，null=不支持（调用方据此禁用按钮）。
function toggleFullscreen(root) {
  const req = fsRequest(root);
  if (!req) return null;
  if (fsElement()) {
    // 退出侧同样要兜底：老 Edge 是 msExitFullscreen；万一三者皆无就当无事发生，不抛。
    const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
    if (exit) fsQuiet(exit.call(document));
    return false;
  }
  // 部分实现（如被 Permissions-Policy 挡住的 iframe）会同步抛，所以 catch 和 .catch 两头都要接。
  try {
    fsQuiet(req.call(root));
  } catch (err) {
    // 拒绝即降级：静默保持当前形态，不冒泡、不打断这一局的其余逻辑。
  }
  return true;
}

function bindFullscreen(btn) {
  const root = fsRoot();

  // 状态回写：Esc 和 iOS 下滑手势退出时不会经过按钮，
  // 只有 fullscreenchange 事件能把按钮的文案/字形拉回正确状态，否则它会一直假装自己在全屏里。
  const sync = () => {
    const on = !!fsElement();
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? "退出全屏" : "全屏";
    btn.title = on ? "退出全屏 (F)" : "全屏 (F)";
    document.body.classList.toggle('is-fullscreen', on);
    return on;
  };

  if (!fsRequest(root)) {
    // 不支持就要说明为什么：只把按钮变灰，玩家会以为这活根本没做完。
    btn.disabled = true;
    btn.setAttribute('aria-disabled', 'true');
    btn.title = '这个浏览器不提供元素全屏（iOS Safari 请用「添加到主屏幕」）';
    return;
  }

  btn.addEventListener('click', () => {
    toggleFullscreen(root);
    sync();
  });

  document.addEventListener('fullscreenchange', sync);
  document.addEventListener('webkitfullscreenchange', sync);

  window.addEventListener('keydown', (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    // 正在输入框里打字时不劫持按键，否则会打不出 f。
    if (ev.target && /^(input|textarea|select)$/i.test(ev.target.tagName)) return;
    if (ev.key === "f" || ev.key === "F") {
      ev.preventDefault();
      toggleFullscreen(root);
      sync();
    }
  });

  sync();
}

function bootFullscreen() {
  const btn = document.getElementById("btn-fullscreen");
  if (!btn) {
    // 按钮被谁删掉了？在控制台喊出来，别让这个坑静默地烂在下一棒手里。
    console.warn('[fullscreen] index.html 里找不到 #' + "btn-fullscreen" + '，全屏开关没有入口');
    return;
  }
  bindFullscreen(btn);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootFullscreen);
} else {
  bootFullscreen();
}

// ---- 减弱动效（prefers-reduced-motion）----
//
// 跟住系统设置，而且**运行中改设置要立刻生效**：只读一次 matchMedia 不够，玩家在系统里
// 把开关拨回来，页面还停在上一次读到的答案上。addEventListener 是标准接口，老 Safari 只有
// addListener —— 特性探测，不做 UA 判断。
const motionQuery = typeof matchMedia === 'function'
  ? matchMedia('(prefers-reduced-motion: reduce)') : null;
function applyReduceMotion(on) { view.setReduceMotion(on); }
if (motionQuery) {
  applyReduceMotion(motionQuery.matches);
  if (typeof motionQuery.addEventListener === 'function') {
    motionQuery.addEventListener('change', (e) => applyReduceMotion(e.matches));
  } else if (typeof motionQuery.addListener === 'function') {
    motionQuery.addListener((e) => applyReduceMotion(e.matches));
  }
}
const __rmHook = window.kakurasu;
if (__rmHook && typeof __rmHook === 'object') {
  __rmHook.setReduceMotion = applyReduceMotion;
  __rmHook.isReducedMotion = () => view.isReducedMotion();
}
