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
import { audio } from './audio.js';
import { readSettings, writeSettings } from './settings.js';
import { registerServiceWorker } from './pwa.js';

const $ = (id) => document.getElementById(id);
const el = {
  modes: $('modes'), totals: $('totals'), crumbs: $('crumbs'), readout: $('readout'),
  shelf: $('shelf'), hintline: $('hintline'), curtain: $('curtain'), stars: $('stars'),
  verdict: $('verdict'), tally: $('tally'), undo: $('undo'), note: $('note'), hint: $('hint'),
  restart: $('restart'), share: $('share'), next: $('next'), again: $('again'),
  toast: $('toast'), canvas: $('grid'), wipe: $('wipe'),
  pause: $('pause'), sound: $('sound'), fullscreen: $('fullscreen'), help: $('help'),
  helpcard: $('helpcard'), helpclose: $('helpclose'), pausecard: $('pausecard'),
  resume: $('resume'), pausetally: $('pausetally'), hud: $('hud'),
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
  paused: false,
  helpOpen: false,
  sw: { status: 'pending', reason: '' },
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
    audio.blip('bad');
    if (why === 'done') say('这一关已经解开了 —— 盘面锁定');
    else say(`第 <b>${Math.floor(pos / app.game.c) + 1}</b> 行第 <b>${(pos % app.game.c) + 1}</b> 列现在不能这么点`);
  },
  onPaint: () => {},
  // 读数是仿真时长的显示器：0.1 仿真秒一次，暂停时 simClock 不推进所以它也不动。
  onFrame: (clock) => {
    const node = el.readout.querySelector('#clockval');
    if (node) node.textContent = fmtClock(clock);
  },
});

function fmtClock(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function setGame(lot, label) {
  app.lot = lot;
  app.label = label || app.label;
  app.game = createGame(lot);
  app.hints = 0;
  view.attach(app.game);
  // 换关 = 新的一局，上一局的暂停态不许带过来：货架与模式按钮在面板里、暂停卡只盖住棋盘，
  // 所以暂停中照样点得动 —— 不清就会得到一开局就冻住的关，和一张写着别人用时与点击数的卡。
  setPaused(false);
  el.curtain.hidden = true;
  say('');
}

function say(html) {
  el.hintline.innerHTML = html;
}

function starText(n) {
  return '★'.repeat(n) + '☆'.repeat(3 - n);
}

function field(label, value, note, cls = '', id = '') {
  return `<div class="${cls}"><dt>${label}</dt><dd${id ? ` id="${id}"` : ''}>${value}</dd><dt><small>${note}</small></dt></div>`;
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
    field('用时', fmtClock(view.fx().simClock), '暂停即冻结', '', 'clockval'),
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
  audio.unlock(); // 这里在用户手势的调用栈上：上下文要在此刻建起来，否则第一次出声会被策略吞掉
  const v = app.game.cells[pos];
  audio.blip(v === NOTE ? 'mark' : v === ON ? 'tap' : 'undo');
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
  audio.blip('win');
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
    audio.unlock();
    audio.blip('undo');
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
  audio.unlock();
  audio.blip('hint');
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

// 重开不是"再调一次 init()"。要复位的清单：格子、点击数、撤销栈、提示用量、结算弹层、
// 暂停态、以及 view 里的涟漪/提示/累加器/仿真时钟 —— 漏掉最后一组，下一局会带着上一局的
// 粒子与时钟起跑，屏上的"用时"就成了两个局的和。
function restart() {
  reset(app.game);
  app.hints = 0;
  el.curtain.hidden = true;
  setPaused(false);
  view.resetFx();
  view.redraw();
  render();
  say('回到起点');
}

el.restart.addEventListener('click', restart);
el.share.addEventListener('click', shareLink);
el.again.addEventListener('click', restart);
el.next.addEventListener('click', () => go(`#/c/${Math.min(LEVELS, app.index + 1)}`));

// ---- 暂停：view 的 frame 里整段跳过仿真推进（累加器清零），盘面无条件拒收点按；
// 恢复后格子、撤销栈、提示用量都还在，只有时间被冻住过。
function setPaused(on) {
  app.paused = !!on && !(app.game && app.game.done);
  view.setPaused(app.paused);
  audio.setPaused(app.paused);
  el.pausecard.hidden = !app.paused;
  el.pause.setAttribute('aria-pressed', String(app.paused));
  el.pause.textContent = app.paused ? '继续' : '暂停';
  if (app.paused) {
    const fx = view.fx();
    el.pausetally.innerHTML = `已用 <b>${fmtClock(fx.simClock)}</b> · 点击 <b>${app.game ? app.game.taps : 0}</b> · 仿真步 <b>${fx.simSteps}</b>`;
  }
  return app.paused;
}

const togglePause = () => setPaused(!app.paused);
el.pause.addEventListener('click', togglePause);
el.resume.addEventListener('click', () => setPaused(false));

// ---- 静音：真静音（挂起上下文 + 不建振荡器），偏好落盘见 js/settings.js
function setMuted(on) {
  const m = audio.setMuted(!!on);
  el.sound.setAttribute('aria-pressed', String(!m));
  el.sound.textContent = m ? '静音' : '音效';
  writeSettings({ muted: m });
  return m;
}

const toggleMute = () => setMuted(!audio.muted);
el.sound.addEventListener('click', toggleMute);

// ---- 全屏：目标元素是 documentElement，按钮是 HUD 里真实存在的 #fullscreen ----
//
// 一律**特性探测**，不做 UA 判断：iPhone 版 Safari 压根没有元素全屏（只有 <video> 能全屏），
// 老 Edge 只认 ms 前缀。方法在不在是量的，UA 字符串是猜的，猜错就静默失效。
//
// 按钮 id 必须与 index.html 对得上：按钮不在 DOM 里就是死代码，玩家按不到，功能等于没做。
// 找不到时要在控制台喊出来，别让这个坑静默地烂在下一棒手里。
function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

function toggleFullscreen(root = document.documentElement) {
  if (isFullscreen()) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (!exit) return false;
    const p = exit.call(document);
    if (p && typeof p.catch === 'function') p.catch(() => toast('退出全屏没被允许'));
    return false;
  }
  // 老 Edge 的 msRequestFullscreen 挂在元素上，和标准名同一个位置，所以并排取即可。
  const req = root.requestFullscreen || root.webkitRequestFullscreen || root.msRequestFullscreen;
  if (!req) {
    toast('这个浏览器不支持全屏');
    return false;
  }
  const p = req.call(root);
  // 返回的 promise 没人接会升级成 unhandledrejection，冒到 window.onerror——离屏预载时足以把整页判死。
  if (p && typeof p.catch === 'function') p.catch(() => toast('全屏没被允许（要由用户手势发起）'));
  return true;
}

function syncFullscreen() {
  const on = isFullscreen();
  if (el.fullscreen) {
    el.fullscreen.setAttribute('aria-pressed', String(on));
    el.fullscreen.textContent = on ? '退出全屏' : '全屏';
    el.fullscreen.title = on ? '退出全屏 (F)' : '全屏 (F)';
  }
  return on;
}

// 不支持元素全屏时把按钮变灰并说明原因：只留一个按不动的按钮，玩家会以为这活根本没做完。
function prepareFullscreenBtn() {
  if (!el.fullscreen) {
    console.warn('[fullscreen] index.html 里找不到 #fullscreen，全屏开关没有入口');
    return;
  }
  const root = document.documentElement;
  if (root.requestFullscreen || root.webkitRequestFullscreen || root.msRequestFullscreen) return;
  el.fullscreen.disabled = true;
  el.fullscreen.setAttribute('aria-disabled', 'true');
  el.fullscreen.title = '这个浏览器不提供元素全屏（iOS Safari 请用「添加到主屏幕」）';
}

if (el.fullscreen) el.fullscreen.addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', syncFullscreen);
document.addEventListener('webkitfullscreenchange', syncFullscreen);
prepareFullscreenBtn();

// ---- 玩法说明：首启自动开一次，看过写进偏好；H 或 ? 随时可开
function setHelp(on) {
  app.helpOpen = !!on;
  el.helpcard.hidden = !app.helpOpen;
  el.help.setAttribute('aria-pressed', String(app.helpOpen));
  if (!app.helpOpen) writeSettings({ helpSeen: true });
  return app.helpOpen;
}

el.help.addEventListener('click', () => setHelp(!app.helpOpen));
el.helpclose.addEventListener('click', () => setHelp(false));
el.helpcard.addEventListener('click', (ev) => { if (ev.target === el.helpcard) setHelp(false); });

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

// 键位表（弹层里也认，方便只用键盘的人）：
//   Enter/Space 开始或继续 · P 暂停 · R 重开 · U 撤销 · N 标记 · G 提示
//   M 静音 · F 全屏 · H 或 ? 玩法 · Esc 关闭弹层
// 焦点停在某个按钮上时**不抢** Enter/Space —— 那是浏览器要用来"按下这个按钮"的键，
// 抢了就会出现"按一次触发两件事"。
function closeTopOverlay() {
  if (app.helpOpen) return setHelp(false);
  if (app.paused) return setPaused(false);
  if (!el.curtain.hidden) { el.curtain.hidden = true; return true; }
  return false;
}

window.addEventListener('keydown', (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const k = ev.key === ' ' ? 'space' : String(ev.key).toLowerCase();
  const onButton = document.activeElement && document.activeElement.tagName === 'BUTTON';
  if (k === 'escape') { closeTopOverlay(); return; }
  if (app.helpOpen && k !== 'h' && k !== '?' && k !== 'space' && k !== 'enter') return;
  if (k === '?' || k === 'h') { ev.preventDefault(); setHelp(!app.helpOpen); return; }
  if (k === 'space' || k === 'enter') {
    if (onButton) return;
    ev.preventDefault();
    audio.unlock();
    if (app.helpOpen) setHelp(false);
    else if (app.paused) setPaused(false);
    else if (!el.curtain.hidden) restart(); // 结算屏上的 Enter = 再来一次
    return;
  }
  if (k === 'p') { ev.preventDefault(); togglePause(); }
  else if (k === 'r') { ev.preventDefault(); restart(); }
  else if (k === 'u') { ev.preventDefault(); el.undo.click(); }
  else if (k === 'n') { ev.preventDefault(); el.note.click(); }
  else if (k === 'g') { ev.preventDefault(); el.hint.click(); }
  else if (k === 'm') { ev.preventDefault(); toggleMute(); }
  else if (k === 'f' || k === 'F') { ev.preventDefault(); toggleFullscreen(); }
});

view.start();
// Deliberately not paused on visibilitychange: the hint pulse and the win card are driven from
// the same loop, and a tab that reports itself hidden (headless Chrome does) must still be able
// to finish a level.
apply();
// 静音是设备偏好，启动就得恢复成屏上读得到的样子（按钮标红 + 上下文挂起）。
setMuted(readSettings().muted);
syncFullscreen();
if (!readSettings().helpSeen) setHelp(true);
// SW 注册放在最后：它不该和首屏抢主线程，也不许在 file:// 下留一条红字。
Promise.resolve(registerServiceWorker())
  .then((r) => { app.sw = r || { status: 'skipped', reason: 'no-result' }; })
  .catch((err) => { app.sw = { status: 'failed', reason: String((err && err.message) || err) }; });

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
      // 窗口状态：帧率对拍与"暂停/静音到底成立没有"的判据都从这里读，不看 DOM 文本。
      phase: app.helpOpen ? 'HELP' : (app.paused ? 'PAUSED' : (g && g.done ? 'WON' : 'PLAYING')),
      paused: app.paused,
      helpOpen: app.helpOpen,
      muted: audio.muted,
      ctxState: audio.state.ctxState,
      audioNodes: audio.state.nodesCreated,
      reduceMotion: view.fx().reduceMotion,
      simClock: view.fx().simClock,
      simSteps: view.fx().simSteps,
      accum: view.fx().accum,
      ripples: view.fx().ripples,
      frames: view.fx().frames,
      texture: view.fx().texture,
      glow: view.fx().glow,
      glowBrass: view.fx().glowBrass,
      fullscreen: isFullscreen(),
      sw: app.sw.status,
      droppedRecords: store.dropped.records,
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
  // ---- 行为驱动口：harness 用这些真按一次，而不是读界面文本
  fx() { return view.fx(); },
  audioState() { return audio.state; },
  pause() { return setPaused(true); },
  resume() { return setPaused(false); },
  togglePause() { return togglePause(); },
  setMuted(on) { return setMuted(on); },
  toggleMute() { return toggleMute(); },
  toggleFullscreen() { return toggleFullscreen(); },
  setHelp(on) { return setHelp(on); },
  settings() { return readSettings(); },
  blip(kind) { return audio.blip(kind); },
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
