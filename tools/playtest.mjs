// Minimal CDP driver for headless playtesting (Node 21+ global WebSocket/fetch).
// env: CDP_PORT (devtools port, default 9352), BASE_URL (page to attach to, default
//      http://127.0.0.1:5192/)
// usage:
//   node playtest.mjs open  <url>          # reuse-or-create our page and navigate
//   node playtest.mjs nav   <url>
//   node playtest.mjs eval  '<js expression>'   # pass `nonav` to skip the reload
//   node playtest.mjs eval  '@boot'        # | @play | @routes | @save | @reloaded | @pointer
//   node playtest.mjs tap   <pos>          # one real mouse press+release on cell pos
//   node playtest.mjs shot  <path.png>
//   node playtest.mjs logs
//
// Every scenario reports { rows, fail } in the same shape as tools/harness.mjs, so
// tools/verify.sh aggregates node suites and browser suites on one line.
const PORT = process.env.CDP_PORT || 9352;
// Which page to attach to. Hard-coding the dev-server port silently evaluates against a fresh
// about:blank tab when pointed at any other origin.
const BASE = process.env.BASE_URL || 'http://127.0.0.1:5192/';
const SHELL_TIMEOUT = Number(process.env.SHELL_TIMEOUT || 30000);
const ORIGIN = new URL(BASE).origin;
const isOurs = (u) => typeof u === 'string' && u.startsWith(ORIGIN);
const cmd = process.argv[2];
const arg = process.argv[3];

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
        if (globalThis.__printEvents) globalThis.__printEvents(msg);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One real mouse event at a client-space coordinate. Shared by the @pointer suite and the
// `tap` command so the two cannot drift apart in what "a press" means over the wire.
const mouseAt = (cdp, sessionId, type, x, y, buttons) => cdp.send('Input.dispatchMouseEvent', {
  type, x, y, button: 'left', buttons, clickCount: type === 'mousePressed' ? 1 : 0,
}, sessionId);

// Press and release at the point the page says cell k currently occupies.
async function tapCellAt(cdp, sessionId, runJS, pos, hold = 30, rest = 80) {
  const p = await runJS(`window.kakurasu.cellPoint(${pos})`);
  if (!p) return null;
  await mouseAt(cdp, sessionId, 'mousePressed', p.x, p.y, 1);
  await sleep(hold);
  await mouseAt(cdp, sessionId, 'mouseReleased', p.x, p.y, 0);
  await sleep(rest);
  return p;
}

async function main() {
  const info = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new CDP(ws);
  let list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  if (cmd === 'open') {
    for (const t of list) if (t.type === 'page' && isOurs(t.url)) {
      try { await cdp.send('Target.closeTarget', { targetId: t.id || t.targetId }); } catch { /* gone already */ }
    }
    await sleep(300);
    list = [];
  }
  const existing = cmd === 'open' ? null : list.find((t) => t.type === 'page' && isOurs(t.url));
  let targetId, sessionId;
  if (existing) {
    targetId = existing.id || existing.targetId;
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  } else {
    ({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }));
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  }
  const logs = [];
  globalThis.__printEvents = (m) => {
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push(`[${m.params.type}] ` + m.params.args.map((a) => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' '));
    } else if (m.method === 'Runtime.exceptionThrown') {
      const e = m.params.exceptionDetails;
      logs.push(`[EXCEPTION] ${e.exception?.description || e.text}\n  at ${e.url}:${e.lineNumber}`);
    } else if (m.method === 'Log.entryAdded') {
      const e = m.params.entry;
      if (e.level === 'error' || e.source === 'rendering') logs.push(`[log:${e.level}] ${e.text} ${e.url || ''}`);
    }
  };
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Log.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);

  const runJS = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  // Wait on the shell, not on a timer. The page is a module graph fetched over the network: a
  // fixed sleep is long enough for a localhost server and too short for GitHub Pages, where it
  // made an innocent deployment look broken (`window.kakurasu` still undefined, canvas still
  // the unstyled 300x150 default). The floor keeps the local case as fast as it was.
  const waitShell = async (floorMs, budgetMs = SHELL_TIMEOUT) => {
    await sleep(floorMs);
    const deadline = Date.now() + budgetMs;
    for (;;) {
      let ready = false;
      try {
        ready = await runJS('!!(window.kakurasu && window.kakurasu.state && window.kakurasu.state.id)');
      } catch { ready = false; }
      if (ready) return true;
      if (Date.now() > deadline) return false;
      await sleep(150);
    }
  };

  if (cmd === 'open') {
    await cdp.send('Page.navigate', { url: arg || BASE }, sessionId);
    await waitShell(600);
    console.log('opened ' + (arg || BASE) + '\n' + (logs.join('\n') || '(no console output)'));
  } else if (cmd === 'nav') {
    await cdp.send('Page.navigate', { url: arg }, sessionId);
    await waitShell(400);
    console.log('navigated\n' + (logs.join('\n') || '(no console output)'));
  } else if (cmd === 'tap') {
    // One cell, pressed and released for real, against the page that is already open (no
    // navigation, so the game keeps running between commands). Having this on the command line
    // means the screenshot a human reviews can be produced by a finger, not an injected call.
    const pos = Number(arg);
    if (!Number.isInteger(pos) || pos < 0) {
      console.log('tap wants a cell index, got: ' + arg);
      process.exit(1);
    }
    const p = await tapCellAt(cdp, sessionId, runJS, pos);
    if (!p) {
      console.log('EVAL THROW: no cell ' + pos + ' on screen');
      process.exit(1);
    }
    const now = await runJS('window.kakurasu.state.taps + "/" + window.kakurasu.state.par + " done=" + window.kakurasu.state.done');
    console.log(`tapped cell ${pos} at ${p.x},${p.y} -> ${now}`);
  } else if (cmd === 'eval') {
    if (process.argv[4] !== 'nonav') {
      await cdp.send('Page.navigate', { url: BASE }, sessionId);
      await waitShell(300);
    }
    if (arg && arg.startsWith('@')) {
      const name = arg.slice(1);
      let value = null;
      if (name === 'pointer') {
        value = await pointerScenario(cdp, sessionId, runJS);
      } else if (SCENARIOS[name]) {
        // Clear the row buffer *before* running. With `nonav` every scenario is evaluated in the
        // same page, so if this suite throws at parse time the fallback below would otherwise
        // hand back the previous suite's rows and verify.sh would print them as if they belonged
        // to this one — a broken suite that looks green.
        await runJS('window.__lastRows = null; 1');
        try {
          value = await runJS(SCENARIOS[name]);
        } catch (err) {
          const dumped = await runJS('JSON.stringify(window.__lastRows||[])').catch(() => '[]');
          value = { rows: JSON.parse(dumped) };
          value.rows.push({ test: `@${name} threw`, pass: false, detail: String(err.message).slice(0, 300) });
        }
      } else {
        console.log('unknown scenario ' + name + ' — have ' + Object.keys(SCENARIOS).join(', ') + ', pointer');
        process.exit(1);
      }
      value.fail = (value.rows || []).filter((r) => !r.pass).map((r) => r.test);
      console.log(JSON.stringify(value, null, 2));
    } else {
      try {
        console.log(JSON.stringify(await runJS(arg), null, 2));
      } catch (err) {
        console.log('EVAL THROW: ' + err.message);
      }
    }
    if (logs.length) console.log('--- console ---\n' + logs.join('\n'));
  } else if (cmd === 'shot') {
    await runJS('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    (await import('node:fs')).writeFileSync(arg, Buffer.from(data, 'base64'));
    console.log('wrote ' + arg + ' (' + Math.round(data.length / 1024) + 'kB b64)');
  } else if (cmd === 'logs') {
    await sleep(800);
    console.log(logs.join('\n') || '(none)');
  }
  ws.close();
  process.exit(0);
}

// The one suite a page-side script cannot run: real input. Everything below goes through
// Chrome's own mouse over CDP, so what gets asserted is the pointer-to-cell wiring in js/view.js
// rather than the rule behind it. In 数和 every cell tap is legal, so the "illegal input" this
// genre actually has is (a) pressing outside the grid and (b) a board whose line has passed its
// clue — which must still not read as a win.
async function pointerScenario(cdp, sessionId, runJS) {
  const rows = [];
  const rec = (name, pass, detail) => rows.push({
    test: name, pass: !!pass,
    detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)),
  });
  const mouse = (type, x, y, buttons) => mouseAt(cdp, sessionId, type, x, y, buttons);
  const key = (k) => cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', text: k, key: k, code: 'Key' + k.toUpperCase(), windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0),
  }, sessionId);
  const tapCell = (pos) => tapCellAt(cdp, sessionId, runJS, pos, 24, 60);

  async function drag(from, dx, dy) {
    const steps = 6;
    await mouse('mousePressed', from.x, from.y, 1);
    for (let i = 1; i <= steps; i++) {
      await mouse('mouseMoved', Math.round(from.x + (dx * i) / steps), Math.round(from.y + (dy * i) / steps), 1);
    }
    await mouse('mouseReleased', Math.round(from.x + dx), Math.round(from.y + dy), 0);
    await sleep(70);
  }

  const ids = await runJS(`['grid','modes','totals','crumbs','readout','hintline','curtain','stars','verdict','tally','again','next','undo','hint','note','restart','share','shelf','wipe','toast']
    .map((i) => [i, !!document.getElementById(i)])`);
  rec('every control the shell reaches for exists', ids.every(([, on]) => on), Object.fromEntries(ids));

  await runJS(`window.kakurasu.load('#/lot/shoal-01'); 'ok'`);
  await sleep(350);
  const start = await runJS(`(() => {
    const g = window.kakurasu;
    return { state: g.state, lot: g.lot(), cells: g.cells(), text: g.gridText(), px: g.pixels(), lit: g.painted(), sums: g.sums() };
  })()`);
  const par = start.state.par;
  rec('a lot loads with a certified answer and a tap floor to match', start.state.id === 'shoal-01' && par === start.lot.solution.split('').filter((ch) => ch === '1').length,
    { id: start.state.id, par, solution: start.lot.solution });
  rec('the canvas is painted with something on it', start.lit > 50 && start.px > 0, { lit: start.lit, px: start.px });
  rec('the board starts empty and the panel prints its line sums', start.cells.every((v) => v === 0) && start.sums.rows.every((l) => l.sum === 0), start.sums.rows.map((l) => [l.sum, l.clue]));

  // Pressing outside the grid — in the clue gutter, where the numbers live — is not a tap.
  const miss = await runJS(`(() => {
    const g = window.kakurasu;
    const box = document.getElementById('grid').getBoundingClientRect();
    const p0 = g.cellPoint(0);
    const cands = [[box.left + 3, box.top + 3], [box.right - 3, box.top + 3], [box.left + 3, box.bottom - 3], [box.right - 3, box.bottom - 3], [p0.x - p0.size, box.top + box.height / 2]];
    for (const [x, y] of cands) {
      // A point outside the viewport would dispatch a mouse event that never reaches the page,
      // which would make "nothing happened" true for the wrong reason.
      if (x < 1 || y < 1 || x > innerWidth - 1 || y > innerHeight - 1) continue;
      if (g.pointAt(x, y) === -1) return { x: Math.round(x), y: Math.round(y) };
    }
    return null;
  })()`);
  if (!miss) {
    rec('a press in the clue gutter is not a cell', false, 'no gutter point was reachable on screen');
  } else {
    const saidBefore = await runJS(`document.getElementById('hintline').textContent`);
    await mouse('mousePressed', miss.x, miss.y, 1);
    await sleep(24);
    await mouse('mouseReleased', miss.x, miss.y, 0);
    await sleep(120);
    const afterMiss = await runJS(`(() => { const g = window.kakurasu; return { taps: g.state.taps, said: document.getElementById('hintline').textContent, cells: g.cells() }; })()`);
    rec('a press in the clue gutter is not a cell: no tap, no message, no change', afterMiss.taps === 0 && afterMiss.said === saidBefore && afterMiss.cells.every((v) => v === 0), { miss, after: afterMiss });
  }

  // One real tap on a cell: billed, visible, and the gutter digits move.
  const first = (await runJS('window.kakurasu.answer()'))[0];
  const tap1 = await tapCell(first);
  const after1 = await runJS(`(() => { const g = window.kakurasu; return {
    taps: g.state.taps, cells: g.cells(), sums: g.sums(), px: g.pixels(), point: g.cellPoint(${first}), said: document.getElementById('hintline').textContent,
  }; })()`);
  const y = Math.floor(first / start.state.c);
  const x = first % start.state.c;
  rec('a real tap marks exactly that cell and costs one click', after1.taps === 1 && after1.cells[first] === 1 && after1.cells.every((v, i) => v === (i === first ? 1 : 0)), { first, taps: after1.taps });
  rec('and the row sum moved by the column index, not by one', after1.sums.rows[y].sum === x + 1, { row: y, col: x, sum: after1.sums.rows[y].sum, clue: after1.sums.rows[y].clue });
  rec('and the column sum moved by the row index', after1.sums.cols[x].sum === y + 1, { col: x, sum: after1.sums.cols[x].sum });
  rec('the cell the panel points at is the cell that changed', !!after1.point && after1.point.pos === first && after1.point.value === 1, after1.point);
  rec('the shell names the cell it just paid for', new RegExp('第 ' + (y + 1) + ' 行第 ' + (x + 1) + ' 列').test(after1.said), after1.said);
  await sleep(250);
  rec('a legal tap changes the picture', after1.px !== start.px, { before: start.px, after: after1.px });

  // Press and release in the same place twice: the cell returns to empty and the board, after
  // the animation settles, is the picture it was.
  await tapCell(first);
  await sleep(250);
  const back = await runJS(`(() => { const g = window.kakurasu; return { taps: g.state.taps, cells: g.cells(), px: g.pixels() }; })()`);
  rec('tapping the same cell twice returns the board', back.cells.every((v) => v === 0) && back.px === start.px, { taps: back.taps, px: back.px, start: start.px });

  // Drag to paint a run along a row.
  const run = await runJS(`(() => {
    const g = window.kakurasu;
    const r = g.state.c;
    return { cells: g.runFrom(r * 1, r * 1 + 2), a: g.cellPoint(r * 1), b: g.cellPoint(r * 1 + 2) };
  })()`);
  const tapsBefore = await runJS('window.kakurasu.state.taps');
  await drag(run.a, run.b.x - run.a.x, 0);
  const painted = await runJS(`(() => { const g = window.kakurasu; return { cells: g.cells(), taps: g.state.taps, sums: g.sums() }; })()`);
  rec('a drag paints every cell it crossed, one click each', painted.cells.filter((v) => v === 1).length === run.cells.length && painted.taps - tapsBefore === run.cells.length, { want: run.cells, cells: painted.cells, taps: painted.taps, before: tapsBefore });
  rec('and the row sum is the sum of the column indices it painted', painted.sums.rows[1].sum === run.cells.reduce((a, p) => a + (p % start.state.c) + 1, 0), painted.sums.rows[1]);

  // Over-capacity: paint an entire row of a 4x4 against a small clue. It is a legal action and
  // must be shown as over, but it must never read as progress toward the win.
  await runJS(`document.getElementById('restart').click(); 'ok'`);
  await sleep(200);
  const overflow = await runJS(`(() => {
    const g = window.kakurasu;
    const c = g.state.c;
    g.play([0, 1, 2, 3]);
    return { state: g.state, sums: g.sums(), lot: g.lot() };
  })()`);
  rec('a full row pays 1+2+3+4 = 10 into its clue', overflow.sums.rows[0].sum === 10, overflow.sums.rows[0]);
  rec('a line past its clue is reported as over, not as near-miss', overflow.sums.rows[0].over === (overflow.lot.rows[0] < 10) && overflow.state.over >= (overflow.lot.rows[0] < 10 ? 1 : 0), { over: overflow.state.over, clue: overflow.lot.rows[0] });
  rec('and an over-sum board is not a win', overflow.state.done === false && overflow.sums.rows[0].ok === false, { done: overflow.state.done });

  // The whole certified solution, tapped for real.
  await runJS(`document.getElementById('restart').click(); 'ok'`);
  await sleep(200);
  const answer = await runJS('window.kakurasu.answer()');
  let played = 0;
  const log = [];
  for (const pos of answer) {
    const p = await tapCell(pos);
    if (!p) { rec(`cell ${pos} is on screen`, false, p); break; }
    const now = await runJS(`(() => { const g = window.kakurasu; return { taps: g.state.taps, done: g.state.done, left: g.state.left }; })()`);
    played += 1;
    log.push({ pos, ...now });
    if (now.taps !== played) { rec(`tap ${played} counted as one click`, false, log); break; }
  }
  rec('the mouse taps the whole certified answer, one click per mark', played === answer.length && played === par, log);
  await sleep(400);
  const end = await runJS(`(() => {
    const g = window.kakurasu;
    return {
      state: g.state,
      recheck: g.recheck(),
      sums: g.sums(),
      stars: document.getElementById('stars').textContent,
      verdict: document.getElementById('verdict').textContent,
      tally: document.getElementById('tally').textContent,
      curtain: !document.getElementById('curtain').hidden,
      record: g.store.record(g.state.id),
    };
  })()`);
  rec('every line sum equals its clue and the board is declared solved', end.state.done && end.sums.rows.every((l) => l.ok) && end.sums.cols.every((l) => l.ok), end.sums);
  rec('the page re-counts this lot as exactly one solution, twice', end.recheck.counted.dp === 1 && end.recheck.counted.bt === 1 && end.recheck.printed.solutions === 1, end.recheck);
  rec('the win card goes up with three stars at the tap floor', end.curtain && end.stars === '★★★' && end.verdict === '一次到位', { stars: end.stars, verdict: end.verdict });
  // NOTE: textContent, not innerHTML — the string being matched here is the *rendered sentence*,
  // and the <b> around the number lives in the markup, not in the text the browser reads out.
  rec('the card prints the player count against the measured floor', end.tally.indexOf('你的 ' + par + ' 点') >= 0 && end.tally.indexOf('最少 ' + par + ' 点') >= 0, end.tally);
  rec('and it prints the counted solution count too', /解数 1/.test(end.tally), end.tally);
  rec('the run is on record at the floor', end.record && end.record.best === par && end.record.perfect === true, end.record);
  const frozen = await runJS(`(() => { const g = window.kakurasu; const before = g.cells(); g.tapCell(0); return { same: JSON.stringify(before) === JSON.stringify(g.cells()), taps: g.state.taps }; })()`);
  rec('a tap after the win is refused and changes nothing', frozen.same && frozen.taps === par, frozen);

  // Notes: a cross must not pay its weight.
  await runJS(`document.getElementById('again').click(); 'ok'`);
  await sleep(250);
  await runJS(`window.kakurasu.toggleNote(true); 'ok'`);
  const p5 = await runJS('window.kakurasu.cellPoint(5)');
  await mouse('mousePressed', p5.x, p5.y, 1);
  await sleep(24);
  await mouse('mouseReleased', p5.x, p5.y, 0);
  await sleep(140);
  const noted = await runJS(`(() => { const g = window.kakurasu; return { cells: g.cells(), sums: g.sums(), taps: g.state.taps, note: g.state.noteMode }; })()`);
  rec('a note crosses the cell out without paying anything', noted.cells[5] === 2 && noted.taps === 1 && noted.sums.rows[1].sum === 0 && noted.sums.cols[1].sum === 0, { cell: noted.cells[5], sums: noted.sums.rows[1] });
  await runJS(`window.kakurasu.toggleNote(false); 'ok'`);

  // Keyboard shortcuts the panel advertises: u (undo), h (hint), r (restart), n (note).
  await runJS(`document.getElementById('restart').click(); 'ok'`);
  await sleep(200);
  await runJS(`window.kakurasu.play([0]); 'ok'`);
  await key('u');
  await sleep(220);
  rec('the u key undoes', (await runJS('window.kakurasu.cells()')).every((v) => v === 0), await runJS('window.kakurasu.cells()'));
  await key('h');
  await sleep(220);
  const hinted = await runJS(`(() => { const g = window.kakurasu; return { hints: g.state.hints, said: document.getElementById('hintline').textContent }; })()`);
  rec('the h key asks for a hint that names a cell or admits a guess', hinted.hints === 1 && /(提示)/.test(hinted.said), hinted);
  await runJS(`window.kakurasu.play(window.kakurasu.answer().slice(0, 3)); 'ok'`);
  await key('r');
  await sleep(220);
  rec('the r key restarts', (await runJS('window.kakurasu.state.taps')) === 0 && (await runJS('window.kakurasu.cells()')).every((v) => v === 0), await runJS('window.kakurasu.state'));
  await key('n');
  await sleep(150);
  rec('the n key toggles note mode', (await runJS('window.kakurasu.state.noteMode')) === true, await runJS('window.kakurasu.state.noteMode'));
  await key('n');
  await sleep(150);
  rec('and toggles it back', (await runJS('window.kakurasu.state.noteMode')) === false, await runJS('window.kakurasu.state.noteMode'));

  return { rows };
}

// In-page suites. Each returns { rows: [{ test, pass, detail }] }.
const SCENARIOS = {
  boot: `(async () => {
    const g = window.kakurasu;
    const rows = [];
    const rec = (name, pass, detail) => rows.push({ test: name, pass: !!pass, detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)) });
    window.__lastRows = rows;
    rec('the shell boots straight into a game', g && g.version === 1 && g.state && g.state.mode === 'campaign', g && g.state);
    const c = document.getElementById('grid');
    rec('the canvas has real pixels', c.width > 0 && c.height > 0 && !!c.getContext('2d'), { w: c.width, h: c.height });
    // A canvas whose CSS was never applied is still the 300x150 box the HTML spec hands out, and
    // the game would then draw a 7x7 grid into a strip nobody designed. This is the same check
    // the screenshot catches by eye, inside the gate.
    const box = c.getBoundingClientRect();
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    rec('the canvas is laid out, not the unstyled 300x150 default',
      box.width > 300 && box.height > 300
        && Math.abs(c.width - box.width * dpr) <= dpr + 1 && Math.abs(c.height - box.height * dpr) <= dpr + 1,
      { css: [Math.round(box.width), Math.round(box.height)], backing: [c.width, c.height], dpr });
    rec('the board was actually painted', g.painted() > 50, { litSamples: g.painted() });
    rec('the first lot is a 4x4 with eight clues', g.state.r === 4 && g.state.c === 4 && g.lot().rows.length === 4, g.lot());
    const pool = g.pool;
    rec('the shipped pool loaded', pool && pool.lots >= 24, pool && pool.lots);
    rec('every published lot claims exactly one solution', pool.unique === pool.lots, { unique: pool.unique, lots: pool.lots });
    rec('every band reports a measured range', Object.values(pool.byTier).every((t) => t.n > 0 && t.min <= t.max && t.band[0] >= 1), pool.byTier);
    rec('the bands are a strictly increasing ladder', (() => {
      const b = g.bands;
      for (let i = 1; i < b.length; i++) if (b[i].band[0] <= b[i - 1].band[1]) return false;
      return b[0].band[0] === Math.min(...b.map((x) => x.band[0]));
    })(), g.bands.map((b) => [b.key, b.band, b.rankMin + '-' + b.rankMax]));
    rec('the top band contains boards that needed an assumption', g.bands[g.bands.length - 1].depthMax >= 1 && pool.assumptionLots >= 1, { depthMax: g.bands[g.bands.length - 1].depthMax, assumptionLots: pool.assumptionLots });
    const rc = g.recheck();
    rec("the browser's own DP counter agrees with the printed solution count", rc.counted.dp === rc.printed.solutions && rc.printed.solutions === 1, rc);
    rec('and a second, independent counter agrees too', rc.counted.bt === 1 && !rc.counted.dpBailed && !rc.counted.btBailed, rc.counted);
    rec('the printed difficulty comes back out of the clue pair', rc.measured.depth === rc.printed.depth && rc.measured.chains === rc.printed.chains && rc.measured.backtracks === rc.printed.backtracks && rc.measured.nodes === rc.printed.nodes, rc);
    const readout = document.getElementById('readout').textContent;
    rec('the panel prints clicks, the floor, the solution count and the reasoning figure',
      /点击/.test(readout) && /最少/.test(readout) && /解数/.test(readout) && /推理/.test(readout), readout);
    rec('the about text names the anchors rather than a vibe', (() => {
      const t = document.querySelector('.about').textContent;
      return t.indexOf('65536') >= 0 && t.indexOf('64959') >= 0 && t.indexOf('64382') >= 0;
    })(), 'about section');
    return { rows };
  })()`,

  play: `(async () => {
    const g = window.kakurasu;
    const rows = [];
    const rec = (name, pass, detail) => rows.push({ test: name, pass: !!pass, detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)) });
    window.__lastRows = rows;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const D = (id) => document.getElementById(id);

    g.store.reset();
    g.load('#/lot/shoal-03'); await sleep(200);
    const lot = g.lot();
    const par = g.state.par;
    const answer = g.answer();
    rec('the lot loaded and its floor is its own mark count', g.state.id === 'shoal-03' && par === answer.length && par >= 4, { par, marks: answer.length });
    rec('the clue pair is the answer grid weighted by position', (() => {
      const c = g.state.c;
      const on = new Set(g.answer());
      const rowsWant = [];
      const colsWant = [];
      for (let y = 0; y < g.state.r; y++) {
        let s = 0;
        for (let x = 0; x < c; x++) if (on.has(y * c + x)) s += x + 1;
        rowsWant.push(s);
      }
      for (let x = 0; x < c; x++) {
        let s = 0;
        for (let y = 0; y < g.state.r; y++) if (on.has(y * c + x)) s += y + 1;
        colsWant.push(s);
      }
      return JSON.stringify(rowsWant) === JSON.stringify(lot.rows) && JSON.stringify(colsWant) === JSON.stringify(lot.cols);
    })(), { rows: lot.rows, cols: lot.cols });

    // Partial progress: half the answer, and the panel must count it as unfinished.
    g.play(answer.slice(0, Math.floor(answer.length / 2)));
    const mid = { taps: g.state.taps, done: g.state.done, left: g.state.left, over: g.state.over };
    rec('half the answer is not the answer', mid.taps === Math.floor(answer.length / 2) && mid.done === false && mid.left > 0, mid);
    rec('and nothing on a legal board is over-capacity yet', mid.over === 0, mid);

    // A wasted round trip costs two and cannot be hidden by the win test.
    const before = g.cells();
    g.play([0]);
    const out = g.cells();
    g.play([0]);
    rec('tapping a cell twice costs two clicks and returns the board', g.state.taps === mid.taps + 2 && JSON.stringify(g.cells()) === JSON.stringify(before), { taps: g.state.taps });

    D('undo').click(); await sleep(120);
    // Undo puts the *board* back one step and bills the click that did it: 'par' is about
    // reaching the answer, and an unbilled undo would let 20 mis-taps be erased into a
    // "一次到位". js/core/game.js documents it; test/game.test.mjs pins it.
    // The last recorded tap was the *second* press on cell 0, which cleared it; undoing that
    // tap puts it back, so the board to compare against is the one after the first press.
    rec('undo returns the last tap and bills itself as a click', g.state.taps === mid.taps + 3 && JSON.stringify(g.cells()) === JSON.stringify(out), { taps: g.state.taps, expected: mid.taps + 3 });
    D('restart').click(); await sleep(120);
    rec('重开 clears the board, the count and the card', g.state.taps === 0 && g.cells().every((v) => v === 0) && D('curtain').hidden, g.state);

    // No hint yet: the run below has to be clean for the perfect flag to mean anything.
    g.play(answer);
    await sleep(200);
    const win = { state: g.state, stars: D('stars').textContent, verdict: D('verdict').textContent, rec: g.store.record(g.state.id) };
    rec('finishing the answer wins at the floor', win.state.done && win.state.taps === par && win.stars === '★★★', win.state);
    rec('the record is flagged perfect because the floor was met', win.rec.best === par && win.rec.perfect === true, win.rec);

    D('again').click(); await sleep(150);
    // One deliberate extra click, then finish: over the floor is a solve without the flag.
    g.play([answer[0]]);
    g.play([answer[0]]);
    g.play(answer);
    await sleep(200);
    const sloppy = { taps: g.state.taps, stars: D('stars').textContent, rec: g.store.record(g.state.id) };
    rec('a run over the floor is a solve without the perfect flag', sloppy.taps === par + 2 && sloppy.rec.best === par && sloppy.rec.perfect === true, sloppy);
    rec('the record keeps the best run, not the latest', sloppy.rec.plays === 2 && sloppy.rec.best === par, sloppy.rec);
    rec('the star count reflects the wasted clicks', sloppy.stars === '★★☆' || sloppy.stars === '★☆☆', sloppy.stars);

    // The hint is a claim about logic, asked for on its own, after the runs above, so that
    // billing it cannot quietly change a perfect-flag assertion. The board has to be restarted
    // first: on a finished board the control is disabled by design.
    D('restart').click(); await sleep(150);
    const h1 = g.hintOnce();
    rec('the hint is phrased as a cell or as an admitted guess', h1.hints === 1 && /提示/.test(h1.line), h1);

    // The over-capacity rule, from the panel side: a full row against a small clue.
    D('restart').click(); await sleep(120);
    const c = g.state.c;
    g.play([0, 1, 2, 3]);
    const full = { sums: g.sums().rows[0], state: g.state };
    rec('a full row of a 4x4 pays 10 by weight', full.sums.sum === 10, full.sums);
    rec('an over-capacity line is flagged and does not win', full.sums.clue !== 10 ? full.sums.over === true : true, full.sums);
    rec('and the panel counts how many lines are past their clue', g.state.over >= (full.sums.clue < 10 ? 1 : 0), { over: g.state.over });
    return { rows };
  })()`,

  routes: `(async () => {
    const g = window.kakurasu;
    const rows = [];
    const rec = (name, pass, detail) => rows.push({ test: name, pass: !!pass, detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)) });
    window.__lastRows = rows;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    g.load('#/c/7'); await sleep(160);
    rec('#/c/7 is lot seven', g.state.index === 7 && g.state.mode === 'campaign', g.state);
    g.load('#/c/99999'); await sleep(160);
    rec('a huge index clamps to the last lot', g.state.index === g.pool.lots, { index: g.state.index, lots: g.pool.lots });
    g.load('#/c/0'); await sleep(160);
    rec('index zero clamps up to one', g.state.index === 1, g.state.index);
    g.load('#/c/' + g.pool.lots); await sleep(160);
    rec('the last campaign lot is in the top band', g.state.tier === 'master', g.state);

    g.load('#/daily'); await sleep(160);
    const daily = g.state.id;
    const dailyRows = JSON.stringify(g.lot().rows);
    g.load('#/c/1'); await sleep(160);
    g.load('#/daily'); await sleep(160);
    rec('the daily route is the same puzzle twice', g.state.mode === 'daily' && g.state.id === daily, { first: daily, again: g.state.id });
    rec('and the same clue pair, cell for cell', JSON.stringify(g.lot().rows) === dailyRows, g.lot().rows);
    rec('the daily label carries the date', /^每日数和 · \\d{4}-\\d{2}-\\d{2}$/.test(g.state.label), g.state.label);
    rec('the daily board is a published unique lot', g.lot().solutions === 1 && g.recheck().agrees === true, g.recheck());

    for (const band of g.bands) {
      g.load('#/random/' + band.key + '/fixedseed'); await sleep(160);
      const first = { id: g.state.id, rank: g.state.rank, tier: g.state.tier, solutions: g.state.solutions };
      g.load('#/c/1'); await sleep(160);
      g.load('#/random/' + band.key + '/fixedseed'); await sleep(160);
      rec('#/random/' + band.key + ' stays in its band and repeats itself',
        first.tier === band.key && g.state.id === first.id && first.solutions === 1 && first.rank >= band.band[0] && first.rank <= band.band[1],
        { band: band.band, got: first, again: { id: g.state.id, rank: g.state.rank } });
    }
    g.load('#/random/master/fixedseed'); await sleep(160);
    const masterRank = g.state.rank;
    g.load('#/random/shoal/fixedseed'); await sleep(160);
    rec('the same token in two bands gives two different difficulties', g.state.rank < masterRank, { shoal: g.state.rank, master: masterRank });
    g.load('#/random/linked/other-key'); await sleep(160);
    rec('a different token gives a different board', g.state.id !== 'random-fixedseed', g.state.id);
    g.load('#/random'); await sleep(320);
    rec('a bare #/random mints a token into the URL', /^#\\/random\\/[a-z]+\\/[a-z0-9]+$/.test(location.hash), location.hash);

    g.load('#/c/5'); await sleep(160);
    const sample = g.state.id;
    g.load('#/c/1'); await sleep(160);
    g.load('#/lot/' + sample); await sleep(160);
    rec('#/lot/<id> opens that lot', g.state.id === sample && g.state.mode === 'lot', { want: sample, got: g.state.id });
    g.load('#/lot/master-10'); await sleep(160);
    rec('a 7x7 master lot is shareable by id', g.state.id === 'master-10' && g.state.r === 7 && g.state.c === 7 && g.state.rank >= 4, g.state);
    g.load('#/lot/not-a-real-lot'); await sleep(160);
    rec('an unknown lot id falls back instead of blanking the board', !!g.state.id && g.state.mode === 'lot' && g.state.solutions === 1, g.state);
    g.load('#/nonsense'); await sleep(160);
    rec('an unparseable route still deals a lot', g.state.mode === 'campaign' && g.state.index === 1, g.state);
    return { rows };
  })()`,

  save: `(async () => {
    const g = window.kakurasu;
    const rows = [];
    const rec = (name, pass, detail) => rows.push({ test: name, pass: !!pass, detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)) });
    window.__lastRows = rows;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const D = (id) => document.getElementById(id);
    const KEY = 'kakurasu.save.v1';

    const answerOf = () => g.answer();

    // Wipe first, through the real double-armed control, so what follows starts clean.
    g.load('#/c/1'); await sleep(160);
    g.play(answerOf()); await sleep(160);
    const had = Object.keys(g.store.records).length;
    rec('a solve is on record before the wipe is tried', had >= 1 && g.store.record(g.state.id).best === g.state.par, { had });
    D('wipe').click(); await sleep(90);
    rec('the first click only arms it', Object.keys(g.store.records).length === had && !D('toast').hidden && /清空/.test(D('toast').textContent),
      { records: Object.keys(g.store.records).length, toast: D('toast').textContent });
    D('wipe').click(); await sleep(260);
    rec('清空存档 takes two clicks and clears everything',
      Object.keys(g.store.records).length === 0 && g.store.unlocked === 1 && localStorage.getItem(KEY) === null,
      { records: Object.keys(g.store.records), unlocked: g.store.unlocked, key: localStorage.getItem(KEY) });
    // NOTE: innerHTML, not textContent. This assertion is about the tally being rendered inside
    // its emphasis element, and textContent has no markup in it by definition.
    rec('and the shell re-renders as a clean device', /已通 <b>0<\\/b>/.test(D('totals').innerHTML), D('totals').innerHTML);

    g.load('#/c/1'); await sleep(160);
    const par = g.state.par;
    g.play(answerOf()); await sleep(180);
    const id = g.state.id;
    const raw = JSON.parse(localStorage.getItem(KEY));
    rec('the solve reaches localStorage, not only memory', !!(raw && raw.records[id] && raw.records[id].best === par), raw && Object.keys(raw.records || {}));
    rec('clearing the first lot unlocks the second', g.store.unlocked === 2 && raw.unlocked === 2, { unlocked: g.store.unlocked });
    rec('the record is flagged perfect at the measured floor', raw.records[id].perfect === true && raw.records[id].plays === 1, raw.records[id]);
    const shelf2 = document.querySelector("#shelf button[data-index='2']");
    rec('the shelf lets lot two be clicked', shelf2 && !shelf2.disabled, shelf2 && shelf2.outerHTML);
    const shelf3 = document.querySelector("#shelf button[data-index='3']");
    rec('and keeps lot three locked', shelf3 && shelf3.disabled, shelf3 && shelf3.outerHTML);
    g.load('#/c/1'); await sleep(160);
    // NOTE ON ESCAPING (this body is a template literal, so it is *source text* the page
    // compiles): a regex slash must be written doubled here.
    rec('the panel prints the record it just read back', /<div class=""><dt>最佳<\\/dt><dd>\\d+<\\/dd>/.test(D('readout').innerHTML), D('readout').innerHTML.slice(0, 400));

    g.load('#/daily'); await sleep(180);
    const day = g.state.label.split(' · ')[1];
    g.play(answerOf()); await sleep(180);
    const mark = g.store.dailyDone(day);
    rec('today is logged once solved', !!mark && mark.id === g.state.id, { day, mark });
    rec('the shelf says today is done', /已通过/.test(D('shelf').textContent), D('shelf').textContent);
    const totals = D('totals').innerHTML;
    rec('the header tally counts both solves', /已通 <b>\\d<\\/b>/.test(totals) && /提示/.test(totals), totals);
    rec('the save is guarded: the page reports its backend as available', g.store.persistent === true, { persistent: g.store.persistent });
    return { rows };
  })()`,

  // Run after @save in its own process, so `eval` (without nonav) has really reloaded the page:
  // this is the only suite that can tell a warm module cache from a save on disk.
  reloaded: `(async () => {
    const g = window.kakurasu;
    const rows = [];
    const rec = (name, pass, detail) => rows.push({ test: name, pass: !!pass, detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)) });
    window.__lastRows = rows;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const D = (id) => document.getElementById(id);

    rec('a fresh page reads its progress off disk', g.store.unlocked === 2, { unlocked: g.store.unlocked, records: Object.keys(g.store.records) });
    const ids = Object.keys(g.store.records);
    const r1 = g.store.record(ids[0]);
    rec('and the first lot\\'s record came back', !!r1 && r1.solved === true && r1.perfect === true, { ids, r1 });
    g.load('#/c/1'); await sleep(200);
    rec('the shelf shows it as already done', /perfect|done/.test((document.querySelector("#shelf button[data-index='1']") || {}).className || ''),
      (document.querySelector("#shelf button[data-index='1']") || {}).className);
    rec('the header counts the recovered solve', /已通 <b>[1-9]/.test(D('totals').innerHTML), D('totals').innerHTML);
    g.load('#/daily'); await sleep(200);
    rec('the daily slot is remembered across the reload', g.store.dailyDone(g.state.label.split(' · ')[1]) !== null, g.state);
    g.store.reset();
    rec('and a reset leaves nothing on disk for the next visitor', localStorage.getItem('kakurasu.save.v1') === null, localStorage.getItem('kakurasu.save.v1'));
    return { rows };
  })()`,
};

main().catch((err) => {
  console.error('playtest failed: ' + ((err && err.stack) || err));
  process.exit(1);
});
