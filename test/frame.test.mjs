// 关卡内三档帧率对拍（30 / 60 / 120 Hz）—— BRIEF_COS §3 的硬骨头，常驻成仓里的一条判据。
//
// 为什么自己写量尺：官方 cos_frame_probe.js 用 vm.runInContext 装载 index.html 里的 `<script src>`，
// 那是 classic script 的语义；本仓是 ES module（`<script type="module">` + import/export），所以它
// 对任何 module 仓都只能报"无法比对（SyntaxError: Cannot use import statement outside a module）"——
// 实测同族的 z-biz-game-gridlock-cos 也是同一句话。量具判不了，不等于可以不判。
//
// 判尺两把，缺一把就是空跑：
//   A 轨迹（**按 sim 步号对齐**）：两个档位共同采到的每一个步号上，仿真钟 / 涟漪 age / 半径 / 提示
//     读数必须逐位相同；越线时刻的钟差不许超过一帧的步数（一阶采样滞后，探针口径 ≤3 倍 gap）。
//     对账特意选涟漪还在飞的步号段（寿命 51 步），否则 ages 是空数组，"逐位相同"白过。
//   B 进度（**按墙钟时长对齐**）：喂满 1.000 s 虚拟墙钟，三档各自跑过的 simSteps 极差 ≤1 步。
//     §6 的口径落在这里：定步长写完之后，逐粒子的 `p.age += s` 早就不吃帧 dt 了，拿常量替换它照样
//     结构性地绿；真正还在吃 dt 的是累加器那一行 `accum += dt`，所以阴性对照钉它（判红），另外再钉
//     一发 `simClock += SIM_STEP` → `+= dt` 证明判尺 A 也不是白过。
//
// 两个已踩过的坑按 §3 绕开：① 对齐按 sim 步号、不按墙钟虚拟秒（1000/60 的浮点亏损会让 60Hz 少喂
// 5e-13 秒、累加器少跑一步，凭空判红）；② 沙箱时钟从 1000ms 起（从 0 起步会被 view 的
// `last || now` 哨兵吃掉一帧，凭空造出一个 25ms 的假帧率依赖）。
// 还有一条实测出来的相位事实：30Hz 每帧 4 步且带 3 步余数，只踩 步号 ≡ 3 (mod 4)；60Hz 踩偶数步号。
// 于是 30↔60 的共有步号恒为 0 —— 那是采样相位错开，不是缺陷，硬要"三档同步号逐位相同"只会把判尺
// 自己判死。所以逐位对账拿最密的 120Hz 当参考档，跨三档的比较走"越线时刻 + 一帧步数容差"。
// 随机也钉住：每档装同一个 LCG 顶掉 Math.random 并比对抽样序列 —— 题面是写死的第 1 关，抽样根本
// 不该影响状态，这条断言就是把它钉住。
import { test, run, ok, eq, atest } from '../tools/harness.mjs';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeWorld, freshView, press } from './fakeworld.mjs';

const root = new URL('..', import.meta.url).pathname;
const SIM_STEP = 1 / 120; // 与 js/view.js 同源；第 0 行断言它没漂
const RIPPLE_LIFE = 0.42; // 同上
const LIFE_STEPS = Math.ceil(RIPPLE_LIFE / SIM_STEP); // 50.4 → 51 步后涟漪必须清场
const TIERS = [30, 60, 120];
const WALL_SEC = 1; // 每档喂 1.000 秒虚拟墙钟
const HINT_MS = 2600;

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const spread = (xs) => Math.max(...xs) - Math.min(...xs);
const r6 = (v) => Math.round(v * 1e6) / 1e6;
const fmt = (xs, pick) => xs.map((t) => `${t.fps}Hz:${JSON.stringify(pick(t))}`).join(' ');
const snapKey = (s) => JSON.stringify([s.simClock, s.ages, s.radius, s.hintPhase, s.hintUntil, s.ripples]);
// 一帧最多能跑几步：30Hz 是 4 步。越线时刻的容差按它算，不按 1 步算 —— 那是采样相位，不是缺陷。
const FRAME_STEPS = Math.round(1 / SIM_STEP / Math.min(...TIERS));

// 逐位对账：拿"两档共同采到的步号"，与最密的参考档比。
function agreeAgainst(tiers, ref) {
  return tiers.filter((t) => t !== ref).map((t) => {
    const common = [...t.snaps.keys()].filter((k) => ref.snaps.has(k));
    const bad = common.filter((k) => snapKey(t.snaps.get(k)) !== snapKey(ref.snaps.get(k)));
    const accumOver = common.filter((k) => Math.abs(t.snaps.get(k).accum - ref.snaps.get(k).accum) >= SIM_STEP);
    const inFlight = common.filter((k) => k <= LIFE_STEPS - 3 && t.snaps.get(k).ages.length >= 2);
    const afterLife = common.filter((k) => k >= LIFE_STEPS + 3);
    return {
      fps: t.fps,
      ref: ref.fps,
      common: common.length,
      bad: bad.length,
      badSample: bad.slice(0, 2).map((k) => ({ k, a: t.snaps.get(k), b: ref.snaps.get(k) })),
      accumOver: accumOver.length,
      inFlight: inFlight.length,
      afterLife: afterLife.length,
      deadClean: afterLife.every((k) => t.snaps.get(k).ripples === 0 && ref.snaps.get(k).ripples === 0),
    };
  });
}

// 各档"第一次越线"的读数：越线步号只许差一帧的步数，越线时的钟也只许差一帧的步数。
function crossing(tiers, target) {
  return tiers.map((t) => {
    const k = Math.min(...[...t.snaps.keys()].filter((x) => x >= target));
    return { fps: t.fps, k, snap: t.snaps.get(k) };
  });
}

// 跑一档：一块假壳 + 真的第 1 关 + 一次真落子 + 一次真提示，然后逐帧喂 dt = 1000/fps 的虚拟时间。
async function runTier(fps, { viewUrl, matches = false } = {}) {
  const realRandom = Math.random;
  const rand = lcg(0x5eed1);
  const draws = [];
  Math.random = () => { const v = rand(); draws.push(v); return v; };
  try {
    const world = makeWorld({ matches });
    const { game, view } = await freshView(world, viewUrl ? { viewUrl } : {});
    const dtMs = 1000 / fps;
    let clock = 1000;
    clock = world.frame(dtMs, clock); // 第 1 帧只负责建立 last：三档到这里都该跑 0 步
    const first = view.fx();
    press(world, view.cellPoint(5)); // 真落一子：game 收到、涟漪生成
    const tappedSteps = view.fx().simSteps;
    view.showHint(6); // 真提示：hintUntil 与脉冲相位都挂到仿真钟上
    const snaps = new Map();
    for (let i = 1; i <= fps * WALL_SEC; i += 1) {
      clock = world.frame(dtMs, clock);
      const fx = view.fx();
      snaps.set(fx.simSteps, {
        simSteps: fx.simSteps,
        simClock: r6(fx.simClock),
        ages: fx.rippleAges.map(r6),
        radius: fx.rippleRadius.map((v) => Math.round(v * 1e3) / 1e3),
        ripples: fx.ripples,
        accum: r6(fx.accum),
        frames: fx.frames,
        hintPos: fx.hintPos,
        hintUntil: fx.hintUntil,
        hintPhase: r6((fx.simClock * 1000) % 1100), // 脉冲相位只允许来自仿真钟
      });
    }
    const end = view.fx();
    return {
      fps,
      game,
      view,
      snaps,
      firstSteps: first.simSteps,
      tappedSteps,
      taps: game.taps,
      cell: game.cells[5],
      end: { simSteps: end.simSteps, simClock: r6(end.simClock), ripples: end.ripples, accum: r6(end.accum) },
      draws: draws.slice(0, 4).map((v) => v.toFixed(12)),
    };
  } finally {
    Math.random = realRandom;
  }
}

const viewSrc = readFileSync(join(root, 'js/view.js'), 'utf8');
const tmpRoot = mkdtempSync(join(tmpdir(), 'kaku-mutant-'));

// 变异副本：只准动那一行。副本要能被 node 加载，所以把 './core/game.js' 换成绝对 file URL ——
// 参考副本做同样的替换，行数对账才只反映那一次变异。
function mutant(tag, find, replace) {
  const abs = `from '${pathToFileURL(join(root, 'js/core/game.js')).href}'`;
  ok(viewSrc.includes(find), `js/view.js 里找不到「${find}」：该变异在本仓不可表达`);
  eq(viewSrc.split('\n').filter((l) => l.includes(find)).length, 1, `「${find}」出现不止一次，变异会一次改多处`);
  const base = viewSrc.replace("from './core/game.js'", abs);
  const mutated = viewSrc.replace(find, replace).replace("from './core/game.js'", abs);
  eq(mutated.split('\n').filter((l, i) => l !== base.split('\n')[i]).length, 1, '副本与正版不止差一行');
  const file = join(tmpRoot, `view.${tag}.mjs`);
  writeFileSync(file, mutated, 'utf8');
  return pathToFileURL(file).href;
}

let tiers = null;
let ref = null; // 最密的一档（120Hz）当逐位对账的参考
let pairs = null;

await atest('第 0 行：判尺钉在真代码上 —— 常量没漂、靶行还在、三档都真进了关卡', async () => {
  ok(viewSrc.includes('const SIM_STEP = 1 / 120;'), 'js/view.js 的 SIM_STEP 改了：本 suite 的对齐假设要一起改');
  ok(viewSrc.includes('const RIPPLE_LIFE = 0.42;'), 'js/view.js 的 RIPPLE_LIFE 改了：清场步数要一起改');
  ok(viewSrc.includes('accum += dt;'), '累加器不再吃 dt：阴性对照的靶子没了');
  ok(viewSrc.includes('simClock += SIM_STEP;'), '仿真钟不再按定步长推进');
  ok(viewSrc.includes('p.age += s;'), '涟漪 age 不再按步长推进');
  tiers = [];
  for (const fps of TIERS) tiers.push(await runTier(fps));
  for (const t of tiers) {
    eq(t.firstSteps, 0, `${t.fps}Hz 首帧跑了 ${t.firstSteps} 步：last 哨兵被喂出假帧率依赖`);
    eq(t.tappedSteps, 0, `${t.fps}Hz 落子前仿真已推进 ${t.tappedSteps} 步：对齐点不公共`);
    eq(t.taps, 1, `${t.fps}Hz 那一次点按没被 game 收到 —— 等于没进关卡`);
    ok(t.cell !== 0, `${t.fps}Hz 格子 5 没被点亮`);
    eq(t.view.fx().hintPos, 6, `${t.fps}Hz 提示没挂上：脉冲相位无从可拍`);
  }
  eq(tiers[0].draws, tiers[1].draws, 'LCG 抽样序列不一致：这轮对拍不可复现');
  eq(tiers[1].draws, tiers[2].draws, 'LCG 抽样序列不一致：这轮对拍不可复现');
  ref = tiers[tiers.length - 1];
  pairs = agreeAgainst(tiers, ref);
  const p3060 = [...tiers[0].snaps.keys()].filter((k) => tiers[1].snaps.has(k)).length;
  console.log(`  [对拍] 起点 ${fmt(tiers, (t) => t.tappedSteps)} 步｜参考档 ${ref.fps}Hz｜共有步号 ${fmt(pairs, (p) => [p.fps, p.common])}｜30↔60 共有 ${p3060}（相位错开，见文件头）`);
});

test('判尺 A1 轨迹：与最密档共同采到的每个步号上，钟 / 涟漪 age / 半径 / 提示读数逐位相同', () => {
  for (const p of pairs) {
    ok(p.common >= 20, `${p.fps}Hz 与 ${p.ref}Hz 只有 ${p.common} 个共有步号（要 ≥20）：采样没对齐，对账无从谈起`);
    // 门槛按实测定：最疏的一档 30Hz 每帧 4 步，而涟漪寿命只有 51 步 —— 落在寿命窗口内的采样本来就
    // 只有 12 个。把门槛抬到 20 是拿门槛当装饰，判不了任何东西。
    ok(p.inFlight >= 8, `${p.fps}Hz 在涟漪寿命内的共有步号只有 ${p.inFlight} 个：拿空 ages 比"相同"是白过`);
    ok(p.afterLife >= 8, `${p.fps}Hz 清场线之后的共有步号只有 ${p.afterLife} 个：清场分支没被拍到`);
    eq(p.bad, 0, `${p.fps}Hz 有 ${p.bad} 个共有步号的状态与 ${p.ref}Hz 不同，首个：${JSON.stringify(p.badSample)}`);
    eq(p.accumOver, 0, `${p.fps}Hz 有 ${p.accumOver} 个共有步号上余量差 ≥1 步：累加器在漏`);
    ok(p.deadClean, `${p.fps}Hz 与 ${p.ref}Hz 的清场读数不一致：粒子寿命不只在虚拟时长上`);
  }
  const at = (k) => fmt(tiers, (t) => (t.snaps.has(k) ? t.snaps.get(k).radius[0] : '—'));
  console.log(`  [A1] 逐位对账通过：${fmt(pairs, (p) => [p.fps, p.common, p.inFlight])}；步号 40 的涟漪半径 ${at(40)}，age ${fmt(tiers, (t) => (t.snaps.has(40) ? t.snaps.get(40).ages : '—'))}`);
});

test('判尺 A2 轨迹：同一目标步号上三档第一次越线的钟差 ≤ 一帧步数（4 步 = 0.033s）', () => {
  for (const target of [24, 40, 100]) {
    const c = crossing(tiers, target);
    const ks = c.map((x) => x.k);
    const clocks = c.map((x) => x.snap.simClock);
    ok(spread(ks) <= FRAME_STEPS, `目标 ${target} 步的越线步号 ${fmt(c, (x) => x.k)} 极差 ${spread(ks)} > ${FRAME_STEPS} 步`);
    ok(spread(clocks) <= FRAME_STEPS * SIM_STEP + 1e-9, `目标 ${target} 步的越线钟 ${fmt(c, (x) => x.snap.simClock)} 极差 ${r6(spread(clocks))}s > 一帧`);
    console.log(`  [A2] 目标 ${target} 步 → 越线 ${fmt(c, (x) => x.k)}（极差 ${spread(ks)}），越线钟 ${fmt(c, (x) => x.snap.simClock)}（极差 ${r6(spread(clocks))}s）`);
  }
});

test('判尺 B 进度：喂满 1.000s 虚拟墙钟，三档 simSteps 极差 ≤1 步（进度挂在时长上，不挂在帧数上）', () => {
  const steps = tiers.map((t) => t.end.simSteps);
  const clocks = tiers.map((t) => t.end.simClock);
  ok(spread(steps) <= 1, `simSteps ${fmt(tiers, (t) => t.end.simSteps)}，极差 ${spread(steps)} 步 > 1 —— 帧率在改仿真进度`);
  ok(spread(clocks) <= SIM_STEP + 1e-9, `simClock ${fmt(tiers, (t) => t.end.simClock)}，极差 ${r6(spread(clocks))}s > 1 步`);
  console.log(`  [B] 1.000s 墙钟后 simSteps ${fmt(tiers, (t) => t.end.simSteps)}（极差 ${spread(steps)}），simClock ${fmt(tiers, (t) => t.end.simClock)}（极差 ${r6(spread(clocks))}s）`);
});

test('反静止快照：状态随虚拟时长演进 —— 1 秒之内也一直在变，不是三档全等就完事', () => {
  for (const t of tiers) {
    const keys = [...t.snaps.keys()];
    const early = t.snaps.get(Math.min(...keys.filter((k) => k >= 4)));
    const late = t.snaps.get(Math.min(...keys.filter((k) => k >= 30)));
    const last = t.snaps.get(Math.max(...keys));
    ok(early && late && last.simSteps > late.simSteps, `${t.fps}Hz 取不到早/晚/末三个读数`);
    ok(late.ages[0] > early.ages[0], `${t.fps}Hz：age 不随虚拟时长增长（${early.ages[0]} → ${late.ages[0]}）`);
    ok(late.radius[0] > early.radius[0], `${t.fps}Hz：半径不随虚拟时长增长（${early.radius[0]} → ${late.radius[0]}）`);
    ok(late.simClock > early.simClock, `${t.fps}Hz 仿真钟没走`);
    ok(last.ripples === 0, `${t.fps}Hz 跑到 ${last.simSteps} 步（清场线 ${LIFE_STEPS} 步）还有 ${last.ripples} 条粒子`);
  }
  console.log(`  [演进] 步号 4→30 的 age/半径都增长，${LIFE_STEPS} 步（${RIPPLE_LIFE}s）后三档都归 0；提示 ${HINT_MS}ms 内一直挂着`);
});

await atest('reduceMotion 命中：三档粒子恒为 0，但仿真照跑（降级的是动效，不是进度）', async () => {
  const rm = [];
  for (const fps of TIERS) rm.push(await runTier(fps, { matches: true }));
  for (const t of rm) {
    eq(t.taps, 1, `${t.fps}Hz 降级态下那一次点按没生效`);
    ok(t.view.reducedMotion() === true, `${t.fps}Hz 媒体查询没被读到`);
    for (const s of t.snaps.values()) eq(s.ripples, 0, `${t.fps}Hz 第 ${s.simSteps} 步还有粒子`);
    eq(t.view.fx().hintPos, 6, `${t.fps}Hz 提示整个没了：应该只退化成静图描边`);
  }
  const rmp = agreeAgainst(rm, rm[rm.length - 1]);
  for (const p of rmp) eq(p.bad, 0, `降级态下 ${p.fps}Hz 有 ${p.bad} 个同步号状态分叉`);
  const steps = rm.map((t) => t.end.simSteps);
  ok(spread(steps) <= 1, `降级态的进度仍在跟帧率跑：${fmt(rm, (t) => t.end.simSteps)}`);
  console.log(`  [reduceMotion] 粒子 0 条｜逐位对账 ${fmt(rmp, (p) => [p.fps, p.common, p.bad])}｜1.000s 墙钟后 simSteps ${fmt(rm, (t) => t.end.simSteps)}（极差 ${spread(steps)}）`);
});

await atest('阴性对照一：accum += dt 换成 accum += 1/60，判尺 B 必须红（§6 口径：钉在还吃帧 dt 的那一行）', async () => {
  const url = mutant('accum', 'accum += dt;', 'accum += 1 / 60;');
  const mut = [];
  for (const fps of TIERS) mut.push(await runTier(fps, { viewUrl: url }));
  const steps = mut.map((t) => t.end.simSteps);
  ok(spread(steps) > 1, `变异副本 1.000s 后 simSteps ${fmt(mut, (t) => t.end.simSteps)} 极差 ${spread(steps)} ≤ 1：判尺 B 是空跑的`);
  // 同步号上的轨迹对变异一来说仍然全等 —— 那是定步长的结构性性质，不是尺子失效（§6 第三条实测）。
  const mp = agreeAgainst(mut, mut[mut.length - 1]);
  console.log(`  [阴性一] accum += 1/60 → simSteps ${fmt(mut, (t) => t.end.simSteps)}（极差 ${spread(steps)} 步）⇒ 判红；正版 ${fmt(tiers, (t) => t.end.simSteps)}（极差 ${spread(tiers.map((t) => t.end.simSteps))} 步）`);
  console.log(`  [阴性一] 同步步号状态对变异一仍全等（${fmt(mp, (p) => [p.fps, p.common, p.bad])}）：结构性性质，§6 已记账，所以判红必须落在 B 这一把`);
});

await atest('阴性对照二：simClock += SIM_STEP 换成 simClock += dt，判尺 A 必须红（证明 A 不是白过）', async () => {
  const url = mutant('clock', 'simClock += SIM_STEP;', 'simClock += dt;');
  const mut = [];
  for (const fps of TIERS) mut.push(await runTier(fps, { viewUrl: url }));
  const mp = agreeAgainst(mut, mut[mut.length - 1]);
  ok(mp.every((p) => p.bad > 0), `变异副本在共有步号上与参考档全等（${fmt(mp, (p) => [p.fps, p.common, p.bad])}）：判尺 A 是空跑的`);
  const c = crossing(mut, 40);
  console.log(`  [阴性二] simClock += dt → ${fmt(mp, (p) => [p.fps, p.common, p.bad])} 个同步号分叉，首个读数 ${JSON.stringify(mp[0].badSample[0])}`);
  console.log(`  [阴性二] 目标 40 步的越线钟 ${fmt(c, (x) => x.snap.simClock)}（极差 ${r6(spread(c.map((x) => x.snap.simClock)))}s，正版 ${r6(spread(crossing(tiers, 40).map((x) => x.snap.simClock)))}s）⇒ 判红`);
});

run();
