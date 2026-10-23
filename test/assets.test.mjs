// 美术资产自证：盘上那 13 张图必须是**真 PNG**、必须**被引用到**、而且必须**能按同一 seed 重跑出来**。
//
// 为什么值得单开一套：资产是最容易注水的一层 —— 0 字节占位、SVG 改扩展名冒充 PNG、manifest 写着
// 192/512 而盘上根本没有、图生成了但游戏一次都没画它，四种都能骗过人眼。所以这里逐张解 IHDR，
// 再把 index.html / manifest.webmanifest / css/game.css / js/view.js / electron/main.cjs 里写下的每个路径拿去跟磁盘对账，
// 最后用 assets/gen/gen_art.py 的默认 seed 往临时目录重跑一遍，逐张比 SHA-256 —— 比上了才叫
// "可复现"，比不上就说明盘上的图是被手改过的。Pillow 不在就如实报话跳过，绝不给假绿。
import { test, run, ok, eq, atest } from '../tools/harness.mjs';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';

const root = new URL('..', import.meta.url).pathname;
const read = (rel) => readFileSync(join(root, rel));
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

// PNG 只读文件头就够：8 字节魔数 + IHDR 的宽高/位深/色彩类型。色彩类型 6 = RGBA。
function pngHead(buf) {
  if (buf.length < 26) return null;
  if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
  if (buf.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  return {
    w: buf.readUInt32BE(16),
    h: buf.readUInt32BE(20),
    depth: buf[24],
    color: buf[25],
    bytes: buf.length,
  };
}

// ---- 纯 node 解像素（本仓资产全是 8 位 RGBA、非隔行）：安全区这种判据得盯真图，
// 而 Pillow 在 CI 上不一定有 —— 工厂侧量一次，仓侧再量一次，两边都不许靠"我记得坐标"过关。
function decodePng(buf) {
  let off = 8;
  let w = 0;
  let h = 0;
  let bitDepth = 0;
  let colorType = 0;
  const parts = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') parts.push(Buffer.from(data));
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8 || colorType !== 6) throw new Error(`只支持 8 位 RGBA，实测 depth=${bitDepth} color=${colorType}`);
  const raw = inflateSync(Buffer.concat(parts));
  const bpp = 4;
  const stride = w * bpp;
  const px = Buffer.alloc(h * stride);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const o = y * stride;
    const i0 = y * (stride + 1) + 1;
    for (let i = 0; i < stride; i++) {
      const v = raw[i0 + i];
      const a = i >= bpp ? px[o + i - bpp] : 0;
      const b = y > 0 ? px[o - stride + i] : 0;
      const c = i >= bpp && y > 0 ? px[o - stride + i - bpp] : 0;
      px[o + i] = (ft === 0 ? v
        : ft === 1 ? v + a
        : ft === 2 ? v + b
        : ft === 3 ? v + ((a + b) >> 1)
        : v + paeth(a, b, c)) & 255;
    }
  }
  return { w, h, px };
}

// 母题 = 铜块 (#d8a13c) 与青蓝刻度 (#78dcff) 那两种颜色；暗底与面板不算内容。
const MOTIF = [[216, 161, 60], [120, 220, 255]];
function motifBbox({ w, h, px }) {
  let minx = w;
  let miny = h;
  let maxx = -1;
  let maxy = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = px[i];
      const g = px[i + 1];
      const b = px[i + 2];
      let near = false;
      for (const [tr, tg, tb] of MOTIF) {
        if (Math.abs(r - tr) + Math.abs(g - tg) + Math.abs(b - tb) < 70) { near = true; break; }
      }
      if (!near) continue;
      if (x < minx) minx = x;
      if (x > maxx) maxx = x;
      if (y < miny) miny = y;
      if (y > maxy) maxy = y;
    }
  }
  return { minx, miny, maxx, maxy };
}

const ASSETS = [
  'icons/master-1024.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/icon-192.png',
  'icons/icon-96.png', 'icons/icon-48.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png',
  'icons/favicon-16.png', 'icons/og-card.png',
  'assets/img/board-texture.png', 'assets/img/glow-cyan-64.png', 'assets/img/glow-brass-64.png',
];

const html = readFileSync(join(root, 'index.html'), 'utf8');
const css = readFileSync(join(root, 'css/game.css'), 'utf8');
const viewSrc = readFileSync(join(root, 'js/view.js'), 'utf8');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.webmanifest'), 'utf8'));
// 站点部署前缀：社交图若写绝对 URL，就按它剥掉前缀再落地查文件。
// 从 README 里取，部署集闸（tools/deploy-set.mjs）也取同一处，两处同源。
const PAGES = ((readFileSync(join(root, 'README.md'), 'utf8')).match(/https:\/\/z-biz-game\.github\.io\/[A-Za-z0-9._-]+\//) || [''])[0];

test('13 张资产逐张是真 PNG：魔数、IHDR 宽高、8 位 RGBA、非 0 字节，且尺寸与文件名/规范声称一致', () => {
  const want = {
    'icons/master-1024.png': [1024, 1024],
    'icons/icon-512.png': [512, 512],
    'icons/icon-maskable-512.png': [512, 512],
    'icons/icon-192.png': [192, 192],
    'icons/icon-96.png': [96, 96],
    'icons/icon-48.png': [48, 48],
    'icons/apple-touch-icon.png': [180, 180], // 判据要的是"favicon + ≥180px 真 PNG"，这一张就是那枚
    'icons/favicon-32.png': [32, 32],
    'icons/favicon-16.png': [16, 16],
    'icons/og-card.png': [1200, 630], // 社交卡按 1.91:1
    'assets/img/board-texture.png': [256, 256],
    'assets/img/glow-cyan-64.png': [64, 64],
    'assets/img/glow-brass-64.png': [64, 64],
  };
  eq(ASSETS.length, Object.keys(want).length, '资产清单与尺寸表不同步');
  for (const rel of ASSETS) {
    ok(existsSync(join(root, rel)), `${rel} 不在盘上`);
    const head = pngHead(read(rel));
    ok(head, `${rel} 不是 PNG（魔数或 IHDR 不对）—— 0 字节占位与 SVG 改扩展名都在这条上红`);
    eq([head.w, head.h], want[rel], `${rel} 实测 ${head.w}x${head.h}，与声称不符`);
    ok(head.bytes > 200, `${rel} 只有 ${head.bytes} 字节：这个量级画不出可读图形`);
    eq([head.depth, head.color], [8, 6], `${rel} 不是 8 位 RGBA（depth=${head.depth} color=${head.color}）`);
  }
});

test('manifest 字段真实，且 icons[] 每个 src 都指到盘上的真像素（sizes 与像素对账）', () => {
  for (const k of ['name', 'short_name', 'start_url', 'display', 'theme_color', 'background_color']) {
    ok(typeof manifest[k] === 'string' && manifest[k].length > 0, `manifest.${k} 缺失或为空`);
  }
  ok(Array.isArray(manifest.icons) && manifest.icons.length >= 4, `icons 只有 ${(manifest.icons || []).length} 枚`);
  const px = (src) => pngHead(read(src.replace(/^\.\//, '')));
  const seen = new Set();
  for (const ic of manifest.icons) {
    ok(existsSync(join(root, ic.src)), `manifest 引用的 ${ic.src} 不在盘上`);
    const h = px(ic.src);
    ok(h, `${ic.src} 不是真 PNG`);
    const [w, hh] = ic.sizes.split('x').map(Number);
    eq([h.w, h.h], [w, hh], `${ic.src} 声称 ${ic.sizes}，实测 ${h.w}x${h.h}`);
    seen.add(ic.sizes + ':' + (ic.purpose || 'any'));
  }
  ok([...manifest.icons].some((i) => i.sizes === '192x192'), '缺 192x192');
  ok([...manifest.icons].some((i) => i.sizes === '512x512'), '缺 512x512');
  ok([...manifest.icons].some((i) => (i.purpose || '') === 'maskable'), '缺 maskable 一枚');
  eq(seen.size, manifest.icons.length, '有两枚 icons 的 sizes+purpose 完全一样，Android 会当同一枚');
});

test('index.html 引用的每个本地路径都在盘上；apple-touch-icon 唯一且 ≥180px；og/twitter 图是真文件', () => {
  const refs = [...html.matchAll(/(?:href|src)\s*=\s*"([^"]+)"/g)].map((m) => m[1])
    .filter((u) => !/^(https?:|data:|#|mailto:)/.test(u));
  const must = ['icons/favicon-32.png', 'icons/favicon-16.png', 'icons/apple-touch-icon.png',
    'manifest.webmanifest', 'css/game.css', 'js/main.js'];
  eq(must.filter((u) => !refs.includes(u)), [], `href/src 解析少了：现有 ${JSON.stringify(refs)}`);
  for (const u of refs) ok(existsSync(join(root, u)), `index.html 引用 ${u}，盘上没有`);
  const apples = [...html.matchAll(/rel\s*=\s*"apple-touch-icon"[^>]*href\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
  eq(apples.length, 1, `apple-touch-icon 有 ${apples.length} 枚，要求唯一`);
  ok(pngHead(read(apples[0])).w >= 180, `${apples[0]} 宽 ${pngHead(read(apples[0])).w} < 180`);
  for (const prop of ['og:image', 'twitter:image']) {
    const m = new RegExp(`property="${prop}"[^>]*content="([^"]+)"`).exec(html)
      || new RegExp(`name="${prop}"[^>]*content="([^"]+)"`).exec(html);
    ok(m, `${prop} 没写`);
    // 社交图可以写站点绝对 URL（抓取器读的是别人页面上的字符串，不会替我们补 /<slug>/，
    // 部署集闸的 R7 就是管这件事的），也可以写相对路径 —— 两种写法都得落到盘上那张真 PNG，
    // 所以这里先把站点前缀剥掉再落地查文件，两种写法都认。
    // 前缀从 README 里取（部署集闸也这么取，两处同源），取不到就按 origin + 第一段路径剥。
    const rel = PAGES && m[1].startsWith(PAGES)
      ? m[1].slice(PAGES.length)
      : m[1].replace(/^https?:\/\/[^/]+\/[^/]+\//, '').replace(/^https?:\/\/[^/]+\//, '');
    ok(existsSync(join(root, rel)), `${prop} 指向 ${m[1]}（落地 ${rel}），盘上没有`);
    ok(pngHead(read(rel)) !== null, `${prop} 不是真 PNG`);
  }
  ok(/rel\s*=\s*"manifest"/.test(html), 'index.html 没挂 manifest');
  ok(/viewport-fit=cover/.test(html), 'viewport 缺 viewport-fit=cover：iOS 上 env(safe-area-inset-*) 恒为 0');
  ok(/env\(safe-area-inset-(top|left|right|bottom)\)/.test(css), 'css 里没有 env(safe-area-inset-*)');
});

test('游戏内资产真被画：view.js 的三处 loadArt 路径与 css 的 url() 都指到盘上文件', () => {
  const loaded = [...viewSrc.matchAll(/loadArt\('([^']+)'/g)].map((m) => m[1]);
  eq(loaded.sort(), ['assets/img/board-texture.png', 'assets/img/glow-brass-64.png', 'assets/img/glow-cyan-64.png'],
    'view.js 加载的位图清单变了：要么多了死资产，要么少了在用的');
  for (const rel of loaded) ok(existsSync(join(root, rel)), `${rel} 被 view.js 引用却不在盘上`);
  // 两张 sprite 必须各自有被取用的分支，否则其中一张就是"烘好了没人画"的死资产
  ok(/art\.glowBrass\s*\|\|\s*art\.glow/.test(viewSrc), 'glow-brass 只在加载、从没被选中画出来');
  ok(/art\.glow\s*\|\|\s*art\.glowBrass/.test(viewSrc), 'glow-cyan 的退化分支没了');
  ok(/ctx\.createPattern\(im,\s*'repeat'\)/.test(viewSrc), 'board-texture 没有被做成 pattern');
  const urls = [...css.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1]);
  ok(urls.length >= 1, 'css 里没有 url() 引用');
  for (const u of urls) {
    const rel = u.replace(/^(\.\.\/)+/, '');
    ok(existsSync(join(root, rel)), `css 引用 ${u}，解析到 ${rel}，盘上没有`);
    ok(pngHead(read(rel)) !== null, `css 引用 ${u} 不是真 PNG`);
  }
  ok(/background-image:\s*url\("\.\.\/assets\/img\/board-texture\.png"\)/.test(css), '整屏背景没铺上那张母题纹理');
});

test('桌面壳也真用上母题：electron/main.cjs 的窗口 icon 指到盘上的真 PNG，且这张在可复现清单里', () => {
  const mainSrc = readFileSync(join(root, 'electron', 'main.cjs'), 'utf8');
  const m = /path\.join\(__dirname,\s*'\.\.\/([^']+)'\)/.exec(mainSrc);
  ok(m, 'electron/main.cjs 里没有 path.join(__dirname, "../…") 形式的资产路径：桌面壳又跑 Electron 默认图标了');
  const rel = m[1];
  ok(rel.endsWith('.png'), `桌面壳图标不是 PNG：${rel}`);
  ok(existsSync(join(root, rel)), `BrowserWindow 的 icon 指到 ${rel}，盘上没有`);
  const head = pngHead(read(rel));
  ok(head, `${rel} 不是真 PNG`);
  ok(head.w >= 256 && head.h >= 256, `桌面壳图标 ${head.w}x${head.h}，任务栏尺寸下会糊`);
  ok(ASSETS.includes(rel), `${rel} 不在 gen_art.py 的资产清单里：换 seed 重跑就对不上`);
  ok(/icon:\s*ICON/.test(mainSrc), 'ICON 常量没被传进 BrowserWindow —— 建好了没人用的死引用');
});

test('maskable 的母题落在中央 80% 安全区内（纯 node 解像素量真图）', () => {
  const img = decodePng(read('icons/icon-maskable-512.png'));
  eq([img.w, img.h], [512, 512], 'maskable 尺寸不是 512');
  const b = motifBbox(img);
  ok(b.maxx >= b.minx && b.maxy >= b.miny, '一个母题像素都没找到：配色或画法改了，这条判据无从判定');
  const lo = Math.round(img.w * 0.10);
  const hi = Math.round(img.w * 0.90) - 1;
  const inside = b.minx >= lo && b.maxx <= hi && b.miny >= lo && b.maxy <= hi;
  console.log(`  [安全区] bbox=(${b.minx},${b.miny})-(${b.maxx},${b.maxy}) 允许 ${lo}..${hi}`
    + ` 留白 L${b.minx} T${b.miny} R${img.w - 1 - b.maxx} B${img.h - 1 - b.maxy} ⇒ ${inside ? '在圈内' : '越界'}`);
  ok(inside, `母题越出 80% 安全区：圆形遮罩的启动器会切掉边缘那排线索刻度`);
  // 阴性对照：同一把尺量一枚"母题贴到四角"的图，必须判越界 —— 不然上面那条绿是空跑出来的
  const fake = { w: 512, h: 512, px: Buffer.alloc(512 * 512 * 4) };
  for (const [x, y] of [[2, 2], [509, 509]]) {
    const i = (y * 512 + x) * 4;
    fake.px[i] = 216;
    fake.px[i + 1] = 161;
    fake.px[i + 2] = 60;
    fake.px[i + 3] = 255;
  }
  const fb = motifBbox(fake);
  ok(!(fb.minx >= lo && fb.maxx <= hi && fb.miny >= lo && fb.maxy <= hi),
    `阴性对照没判红（量到 bbox=(${fb.minx},${fb.miny})-(${fb.maxx},${fb.maxy})）：这把尺是空跑的`);
});

await atest('生成器可复现：同一 seed 重跑一次，13 张资产的 SHA-256 与盘上逐张相同', async () => {
  const gen = join(root, 'assets', 'gen', 'gen_art.py');
  ok(existsSync(gen), 'assets/gen/gen_art.py 不在仓里：资产就成了不可复现的手改物');
  const genSrc = readFileSync(gen, 'utf8');
  ok(/--seed/.test(genSrc) && /20261002/.test(genSrc), 'gen_art.py 没有 --seed/默认 seed，重跑无从对齐');
  ok(/IHDR|struct\.unpack\(">II"/.test(genSrc), 'gen_art.py 不自己解 IHDR：写完不自证宽高');
  ok(/def check_safe_zone/.test(genSrc), 'gen_art.py 里的 maskable 安全区自证没了：换形状遮罩切掉母题将无人报警');
  let pillowed = true;
  let pillowVer = '未取到';
  try {
    execFileSync('python3', ['-c', 'import PIL'], { stdio: 'ignore' });
    pillowVer = execFileSync('python3', ['-c', 'import PIL;print(PIL.__version__)'], { encoding: 'utf8' }).trim();
  } catch (err) {
    pillowed = false;
  }
  if (!pillowed) {
    console.log('  [可复现] 跳过：本机 python3 没有 Pillow。如实报话 —— 这一行不给假绿，换机器装了就判');
    ok(true, 'placeholder');
    return;
  }
  const out = mkdtempSync(join(tmpdir(), 'kaku-art-'));
  execFileSync('python3', [gen, '--out', out], { stdio: 'ignore' });
  const regen = ASSETS.map((rel) => [rel, sha(readFileSync(join(out, rel)))]);
  eq(regen.length, ASSETS.length, '重跑产出的文件数不对');
  const drift = regen.filter(([rel, h]) => h !== sha(read(rel)));
  // 字节不同有两类，代价完全不同：一类是编码漂移（同一批像素、Pillow 版本换了 chunk/压缩写法），
  // 一类是内容漂移（盘上这张图真的不是这台机器的生成器画出来的）。红之前先分清是哪一类，
  // 否则这条腿会把环境的版本差指控成"有人手改过图"。判据本身不动：字节必须逐张相同。
  let pix = '';
  if (drift.length) {
    try {
      pix = execFileSync('python3', [join(root, 'assets', 'gen', 'pixelcmp.py'), out, ASSETS.join(',')],
        { encoding: 'utf8' }).trim();
    } catch (err) {
      pix = '像素比对没跑成：' + String(err.message || err).slice(0, 60);
    }
  }
  eq(drift.map(([rel]) => rel), [],
    `盘上的图与 gen_art.py 默认 seed 的产物字节不一致（${drift.length} 张）：${drift.map(([rel]) => rel).join(', ')}`
    + ` —— 逐张分「编码漂移（像素相同）」/「内容漂移（像素不同）」${pix}；本机 Pillow=${pillowVer}`);
  console.log(`  [可复现] python3 assets/gen/gen_art.py 重跑 ${ASSETS.length} 张，SHA-256 逐张相同`);
});

run();
