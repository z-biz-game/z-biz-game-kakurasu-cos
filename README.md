# 数和 · KAKURASU

浏览器原生的数和格（Kakurasu）：一个 0/1 棋盘，每行每列各带一条**带权**和的线索，把每条线索都点准确就通关。
交付物是四件东西：`js/data/lots.js` 里 40 关**实测**题库（四档难度带各 10 关）、`js/core/` 里两条互不共享机器的解数计数器、
一个确定性求解器量出来的难度数字，以及守住这两件事的 node 门禁。
屏上那个"解数 1"不是标的，是 DP 与逐格回溯各数一遍、且被 4×4 全空间 `2^16` 穷举在测试层对过账之后才印出来的。

零依赖、零打包器、零图片素材：`package.json` 的 `dependencies` 与 `devDependencies` 都是 `{}`，画面全部由 canvas 2D 程序绘制。
本机环境：Apple M5 Pro（15 核）、node v26.8.1、日期 2026-09-29。**墙钟只当读数**：这台机器上同时有别的代理的闸在跑，秒数复跑不出同一个值，所以本文凡是要说成本的地方都引那条阈值断言，读数只列在标注了「量级」的那一列。

---

## 规则（以及它的出处）

```
row clue[y] = Σ 被选中格子的 (x+1)      ← 行线索由「列号」付费
col clue[x] = Σ 被选中格子的 (y+1)      ← 列线索由「行号」付费
```

这两行不是装饰：`js/core/grid.js:84-94` 的 `rowSum`/`colSum` 就是它逐字的实现（`s += x + 1` 与 `s += y + 1`），
`cluesOf`（`js/core/grid.js:96`）把它摊成一条棋盘对应的线索对，`maxClue(n) = n(n+1)/2`（`js/core/grid.js:36`）给出单条线索的上限，
超上限在 `validateLot` 里报 `clue-range`。视图只读 `statusOf` 的 `{sum, clue, ok, over, left}`（`js/core/grid.js:183-195`）来上色：
金色未满、青绿正好等于线索、超出即红（`js/view.js:178,189` 写死 `#d8a13c / #78dcff / #e2685f`）——
权重都是正数，一行**超过**线索就回不来了，所以红色是死路而不是警告。

名字的日英对照只在难度带标签上（`js/core/make.js:34-39`）：浅滩 SHOAL · 连环 LINKED · 交缠 TWINED · 迷阵 MASTER；
界面与标题是中文"数和 / 数和格"加英文 KAKURASU（`index.html` 的 `<title>`、`package.json` 的 `description`）。

**出处的诚实口径**：这份仓里没有任何外部规则来源。本轮对代码与配置（`*.js *.mjs *.cjs *.html *.css *.yml`）grep 过
`https?://`，8 处命中逐条数过是：`tools/playtest.mjs` 的 4 处（web 与 CDP 的本机回环口）、`server.cjs` 的 2 处
（URL 解析的哨兵 base 与启动打印）、`electron/main.cjs:22` 加载本机端口的 1 处，加 `index.html:8` 那个内联 SVG favicon 的
`xmlns='http://www.w3.org/2000/svg'`。**没有一条指向外部规则页**。更硬的一条：把 `Nikoli`、`Tatham` 这两个数和格常被挂上去的
外部权威名在整个仓里 grep（含 `*.md *.json`），**零命中** —— 所以"官方规则如此""日英双源"这类说法在本仓连一个字都没有，写不出来。
能给出的出处只有仓内两处：代码本身（上面那几个 `file:line`），以及 `DESIGN.md` §2.1–§2.4。
`DESIGN.md` 另外引用了 brief 的"规格 §2 与契约 §3"和 `/tmp/puzzle-brief/probe5.mjs`（§2.3 那条"DP 往列状态里加错号"的坑就是照抄它留下的），
那两样都不在仓里，本轮没有可核对的副本，因此本 README 不转述它们的原文，只转述本仓代码与测试实际断言的东西。

---

## 承诺表：每条承诺都有一道真会红的命令守着

下表右列的条数是**本轮跑出来的**（`node test/<file>` 交回的 `rows:` 行），不是估的；括号里另标出数字来自哪个源码常量。

| 屏上/文档里的承诺 | 哪条命令会红 | 它判什么 | 条数与出处 |
| --- | --- | --- | --- |
| 每关**只有一个解** | `node test/lots.test.mjs` | 40 行每行：印着的 `solutions` 必须是 1，且 `countSolutionsDP(limit=2)` 与 `countSolutionsBacktrack(limit=2)` 都数出 1、都不许 `bailed`；解格重算必须还原 `rows`/`cols`；`marks` 必须等于解格数 | 实测 `rows: 13 fail: 0`（条数 = 该文件 `test(...)` 调用数，`tools/harness.mjs` 打印） |
| 4×4 全空间的四条锚点 | `node test/anchor.test.mjs` | 类大小之和 = 65536、类数 = 64959（枚举与行子集四重积两条路各自算）、64382 唯一 + 577 多解、抽查 400 类三方一致 | 实测 `rows: 11 fail: 0`；期望值是**手写常量** `ANCHOR`（`test/anchor.test.mjs:19-25`：`65536 / 64959 / 64382 / 577 / 400`），不由 `js/core` 算出 |
| 屏上"推理 N"改不掉 | `node test/lots.test.mjs`、`npm run bake` | 40 行逐行重跑 `analyse`，`depth/chains/backtracks/nodes` 必须逐个相等，且 `rank == depth*100 + chains`；bake 出货前那段逐格复验（`tools/bake.mjs:190-193`）用同一条路径复验 | 实测 `rows: 13 fail: 0`；上限是 `SOLVER_NODE_CAP = 4000`（`js/core/make.js:44`），同一文件另断言 `nodes <= 4000`、`depth <= 12` |
| 难度带是量出来的，不是尺寸标签 | `node test/lots.test.mjs` | 四带出货 rank 必须严格递增且各自落在自己带内；顶层必须有 `depth > 0` 的关，且只能落在 master | 实测 `rows: 13 fail: 0`；带子来自 `tools/bake.mjs` 的切带（`FEASIBLE` 默认 `0.06`，`tools/bake.mjs:86`） |
| "最少 N 点"是下界 | `node test/game.test.mjs` | `par = 唯一解的格子数`；并且真的对 4×4 的 `2^16` 状态点击图跑一遍 BFS，断言 `dist[目标] == popcount(目标)` | 实测 `rows: 14 fail: 0`（BFS 把 2^16 状态全跑一遍，不是抽样） |
| 线索极小化**只说证明过的部分** | `node test/lots.test.mjs` | `coreStatus` 只许 `holds`/`bounded`；`holds` 的行必须 `coreSize < clues` 且重跑 `minimalCore` 仍 `holds` 同尺寸；`bounded` 只断言 `1 <= coreSize <= r+c`，不冒充精确 | 实测 `rows: 13 fail: 0`；重新验证的"便宜行"（`holds` 且 `r <= 5`）要求 `>= 4` 条 |
| 校验器每条错误码都活着 | `node test/grid.test.mjs` | `dims / missing-row-clue / missing-col-clue / clue-range / cell-overlap / cell-value / grid-shape / solution-clue` 这 8 个码（清单是 `js/core/grid.js:127-129` 的 `ERROR_CODES`）逐条有负例，末尾还有一条元断言：拿 8 个坏探针跑 `validateLot`，任何码没被 produced 过就报错 | 实测 `rows: 32 fail: 0`（`test/grid.test.mjs:114-127`） |
| 三条计数路线不共谋 | `node test/count.test.mjs` | 5 个手算 fixture（含"经典歧义块 = 2 解"与"满行对三条空列 = 0 解"）各由穷举、DP、回溯三路复现；并有"同一串数字按带权是 1 解、按格子数是另一盘"的反证 | 实测 `rows: 27 fail: 0`；fixture 的期望值是字面量（`test/count.test.mjs:11-35`） |
| 求解器确定、且不肯半成品出货 | `node test/logic.test.mjs` | 同一线索对两次调用逐字节相等；`nodeCap` 太小或 `depthCap` 超了就报 `capped`，不编数字；提示只能点纯推理能证的格 | 实测 `rows: 26 fail: 0` |
| 现场生成有边界、会终止 | `node test/make.test.mjs` | `MAX_ATTEMPTS` 必须被 honoring（`makeLot` 撞带子时 `attempted == 400` 且返回 `null`）；每条拒绝路径都记账；`js/*` 里不许混进穷举 | 实测 `rows: 14 fail: 0`；两条计时闸：穷举搜索 `< 20000ms`（`test/make.test.mjs:94`）、`< 1500 ms/题面`（`:140`） |
| `js/core` 不知道有屏幕 | `node test/storage.test.mjs` | **源码级**扫描 `js/core/*.js` 里非注释行的 `window.`/`document.`，白名单只有 `storage.js`，而它必须暴露 `rawBackend`、必须 `throw`、消费者必须 `try` 包住；再断言除 `library.js` 外没有 core 模块伸出 `../` | 实测 `rows: 18 fail: 0` |

上面 8 套 node 门禁合起来是 **155 条断言，0 失败**。`npm test` 本轮复跑过，每次都 `exit 0`。这一层没有 `RESULT:` 汇总行——每套自己打印一行 `rows: N fail: M`
（格式来自 `tools/harness.mjs:32`），整套的汇总行 `=== ALL GREEN ===` 只在 `tools/verify.sh` 里出现，
而**本轮整闸跑到底了**：`bash tools/verify.sh` 退 0，末尾就是那一行 `=== ALL GREEN ===`（逐段读数在下面
「浏览器层」一节，`VERIFY_RC` 写在自己的日志里）。

---

## 怎么跑：`package.json` 的 11 条 scripts 逐条核对

脚本清单就是 `package.json:7-19` 这个块的原文，11 条都在，没有虚构：

| script | 实际执行的命令 | 本轮跑过吗 | 结果 |
| --- | --- | --- | --- |
| `start` | `node server.cjs` | 是（直接起 `server.cjs`） | 打印 `数和 Kakurasu served at http://127.0.0.1:5192/  (ctrl+c to stop)`；`SIGINT` 后 `lsof` 确认端口已释放 |
| `dev` | `node server.cjs 5192` | 与 `start` 同一条路径（只是把端口写死），未单独起 | 端口默认值 `5192` 在 `server.cjs:59` 与 `tools/verify.sh:21` 各写一次 |
| `check` | `for f in js/*.js js/*/*.js server.cjs electron/main.cjs tools/*.mjs test/*.mjs; do node --check "$f"; done && echo OK` | 是（随 `npm test`） | 打印 `OK`；同一 glob 实测展开 **29 个文件**（js 根 3 + js/core 8 + js/data 1 + server.cjs 1 + electron/main.cjs 1 + tools/*.mjs 6 + test/*.mjs 9）。这个数以前是手抄的、写着 25，差 4 个而全套绿灯——现在由 D9f 按 `package.json` 里那串 token 现场展开来对账 |
| `unit` | `for f in test/*.test.mjs; do node "$f"; done` | 是（随 `npm test`，也逐个跑过） | 8 个文件全绿，见下表 |
| `test` | `npm run check && npm run unit && node tools/docs-test.mjs` | **是** | `exit 0`，交回 8 行 `rows: N fail: 0`（见下一节的逐条读数）再加本仓的文档对账汇总行 |
| `bake` | `node tools/bake.mjs` | **否** | 它按 `[4/4] wrote 40 lots -> js/data/lots.js` 改写题库源文件（`tools/bake.mjs:263`），文档轮不动已发货的题库，所以没跑；DESIGN 里那组 `wall=206.2s` 本轮未复现 |
| `electron` | `electron .` | **否** | `dependencies`/`devDependencies` 都是 `{}`，仓里没有 `node_modules`，`electron` 也不在 PATH；`electron/main.cjs` 只是那份 34 行的壳 |
| `verify` | `bash tools/verify.sh` | **是**（本轮跑到底；起 `server.cjs` + 本机 headless Chrome，9352/5192 两个端口事先空着） | 退 0，末尾 `=== ALL GREEN ===`：8 套 node 门禁 + 6 段浏览器断言 101 行 + 控制台 `(none)` + 文档对账 30 行 + 部署集 52 行 + 部署集阴性自证。逐段读数在「浏览器层」那一节 |
| `deploy-set` | `node tools/deploy-set.mjs` | 绿：对拷出来的产物提要求（见「上线的到底是哪一批文件」一节） |
| `deploy-set:selftest` | `node tools/deploy-set-selftest.mjs` | 绿：9 刀逐类打红且点名 + 1 条阴性对照 |
| `doctest` | `node tools/docs-test.mjs` | 是（随 `npm test`，也随 `bash tools/verify.sh`） | 本文与 DESIGN 里每一条 `路径:行号` 读回盘上对账，见「文档行号对账」一节 |

门禁之外还有两条可跑入口，本轮都验过：

```bash
node --test test/         # 本轮：ℹ tests 8  ℹ pass 8  ℹ fail 0
node test/anchor.test.mjs # 只跑证明层：rows: 11 fail: 0
```

注意 `node --test` 只报**文件级**的 8 条（本仓测试用自研 harness，自己 `console.log` + `process.exit`），
真正的断言条数看每个文件自己打印的 `rows:` 行，别把 `tests 8` 当成"8 条断言"。

---

## 门禁清单：实测交回的条数与耗时

下面每一行都是本轮在本机 `node test/<file>` 单独跑出来的，`rows` 与那列量级同源，一条都没有引用别人的读数：

| 门禁 | 交回（原样） | 本机量级（读数，不参与判定） |
| --- | --- | --- |
| `test/anchor.test.mjs` | `rows: 11 fail: 0` | 1.55s（含 2^16 全空间枚举；文件内计时闸 `elapsed < 20000` ms） |
| `test/count.test.mjs` | `rows: 27 fail: 0` | 0.19s |
| `test/game.test.mjs` | `rows: 14 fail: 0` | 0.02s（含 2^16 状态 BFS） |
| `test/grid.test.mjs` | `rows: 32 fail: 0` | 0.02s |
| `test/logic.test.mjs` | `rows: 26 fail: 0` | 0.02s |
| `test/lots.test.mjs` | `rows: 13 fail: 0` | 0.93s（40 关逐行重测） |
| `test/make.test.mjs` | `rows: 14 fail: 0` | 0.44s |
| `test/storage.test.mjs` | `rows: 18 fail: 0` | 0.02s（含源码扫描） |

浏览器层**本轮实测跑到底了**（`bash tools/verify.sh` → `tools/playtest.mjs`，走真实 CDP 打 `http://127.0.0.1:5192/`）：
6 段交回 101 行、控制台 `(none)`、整套退 0 且末尾是 `=== ALL GREEN ===`。要说准一件事：这一层能跑，但**本仓的脚本挡不住
"另一个仓的 Chrome"** —— `tools/verify.sh:35-39` 只预检自己的 `9352` 这一条（被占则 `exit 6`），
它对别的端口上的 Chrome 一无所知（那里没有 `pgrep` 全机扫描那一层），所以派生之前"同一时刻只留一个 headless 台架"
靠的是台架纪律，不是一道红闸。下表那一列是**源码里 `rec(` 调用的点数**，本轮交回的读数与它逐段相等：

| 段 | 判什么 | 源码点数 |
| --- | --- | --- |
| `@boot` | 直接进游戏、canvas 有真像素且不是未样式化的 300×150（backing store 与 CSS 盒按 dpr 对账）、棋盘真被画出来、题库加载、每档报实测范围、带子严格递增、顶档含需假设的关、浏览器自己重跑两条计数器与 `analyse` 必须与印在行上的一致、面板打印"点击/最少/解数/推理"、about 文案点名 65536/64959/64382 | 15 |
| `@play` | 关卡下限等于自己的格数、线索对确由解格按位加权得到、半解不算解、双点两次记两次点击并回到原画面、撤销记一次点击、重开清空、按 `par` 收关给 `★★★` 且 `perfect` 打标、超 `par` 有解无标、记录保最好而非最新、提示按一次推理计费、满行按权重付 10、超线索行不算进度且被计数 | 16 |
| `@routes` | `#/c/7`、越界索引钳位（99999 与 0）、末关属顶档、`#/daily` 两次同盘且标签带日期、四档 `#/random/<band>/<token>` 各自落带且可复现（**循环内**，4 次）、同 token 跨档不同难度、换 token 换盘、裸 `#/random` 会铸造 token、`#/lot/<id>` 与未知 id 兜底、`#/nonsense` 仍发牌 | 16（实跑 19） |
| `@save` | 双次点击才清空存档、清空后 `records` 归零且 `localStorage` 键为 `null`、解一关写入 `kakurasu.save.v1`、解锁推进到 2、`perfect` 打标、第 2 关可点第 3 关仍锁、面板回读"最佳"、每日槽写入、页内报 `persistent === true` | 14 |
| `@reloaded` | 必须排在 `@save` 之后且在自己的驱动进程里跑：新页面从磁盘读回进度、第一关记录回来、货架显示已完成、表头计数、每日槽被记住、`reset` 后磁盘上什么都不留 | 6 |
| `@pointer` | 真实 `Input.dispatchMouseEvent`：20 个控件都存在、整条认证解用鼠标点完、原地双点回到原画面、点线索槽不计、拖拽涂装一笔连出三格、越界与 gutter 点不动、键盘 `u/h/r/n` | 34（其中 3 处只在失败时说话：gutter 找不到点、认证解途中某格不在屏上、某口没计费 ⇒ 正常路径 31 行） |

合计 **101 处**调用点；把 routes 那条 4 档循环展开、去掉那 3 条「只在失败时说话」的行，正常路径应交回 **101 行**
（boot 15 / play 16 / routes 19 / save 14 / reloaded 6 / pointer 31）——**本轮交回的就是这 101 行，逐段与点数表相等**。
第二道闸与控制台洁净绑在一起：`tools/verify.sh:132` 对每段输出 grep
`[EXCEPTION]|[log:error]|[error]|[warning]`，命中即算红——所以 `willReadFrequently`、内联 favicon 这些细节是门禁的一部分，不是风格。

CI 两道 job（`.github/workflows/ci.yml`，本机未观测，只按文件定义记录）：
`unit` 在 ubuntu-latest / node 22 上跑与 `npm run check` **同一份 glob** 的 `node --check`，再逐个跑 `test/*.test.mjs`；
`browser` 用 `SKIP_UNIT=1 WD_TIMEOUT=240 bash tools/verify.sh`，即只跑上面那 6 段。

**这台机器上没有任何一道闸读红**：`npm test` 交回 9 行 `rows:`（8 套 node 门禁 + 这条文档腿），全是 `fail: 0`，
两条计时闸（anchor 的 20s、make 的 1500ms/题面）都远未触及。

要复跑浏览器层，命令是 `bash tools/verify.sh`（全 6 段）或 `SCENARIOS="pointer" bash tools/verify.sh`（只跑真指针那一段）。
前提是本机 `5192` 与 `9352` 两个端口空着、且没有另一个仓的 headless Chrome 在听 —— 后者脚本自己不检查，见本节开头。

---

## 文档行号对账（`node tools/docs-test.mjs`）

本文和 `DESIGN.md` 里的每一处 `路径:行号` 都是**证据**而不是装饰：文件在不在盘上、行号在不在界内、
被指的那几行是不是真的坐着文档所说的那个名字，都由这条命令逐条读回盘上核对。它自己打印的这一轮读数：

```
解析 114 条 · 续引 1 条 · 无法定址 0 处 · 带指认 33 条 · 跨仓引用 0 处
文档行号对账：2 份文档 · 114 条引用 · 33 条带指认 · 30 条判据
30 通过 / 0 失败
```

这条腿自己发 30 条判据（台账：文档行号对账 30 条）——那个数由它本轮实发，删掉一条断言就撞红。

判据分五族，每一族都有一把对应的刀（见下面「下刀台账」）：

- **边界**：路径按**仓根相对**解析，所以裸文件名不算引用——「怎么跑」那一节原本写着「verify.sh:21」，
  而仓根下没有那份脚本，补上目录之后它才读得回实处（见上面第 1 条）。行号越界、或者整段落在一串空行上，
  都判红：在界内不等于指到了代码。
- **锚点**：紧贴引用的那个名字（「`minimalCore()`（`js/core/count.js:246`）」这种写法）必须作为
  **完整标识符**出现在被指的那几行里。整词而不是子串：`node` 坐在 `let nodes = 0;` 上也算"出现"，
  一次真的漂就这样被读成绿。
- **续引**：同一个句子里的裸「:140」借用最近那条完整引用的出处，跨句号/空行/新标题则**不借**，
  报「无法定址」而不是静默跳过。本轮实数 1 条借到、0 处借不到——借不到不等于文档有错，但一定要说话。
- **等式**：上面那行读数不是打印出来就完事——文档里抄的「解析 114 条」「带指认 33 条」「续引 1 条」
  「无法定址 0 处」「跨仓引用 0 处」与「30 条判据」全部与本轮实数**逐相等式**。只写下限抓不住
  "文档抄的是上一轮那个数"；加一条判据而不改那个数，红的是文档。
- **接线**：这条腿必须在 `package.json` 的 `doctest`、`npm test` 的链、`tools/verify.sh`、
  `.github/workflows/ci.yml` 里各出现一次，四格分开判——只在 CI 跑的门不算门。它另外还钉住两件事：
  目录里的 node 套件实数就是 8 个（把这条腿算成第九个套件就是文档说谎），以及「怎么跑」那一节的
  标题条数、表里列的 script 名、`package.json` 的键三者必须互相对得上。

### 这一腿第一轮咬到了什么

全是它自己红出来的，不是人读出来的：

1. **14 处裸文件名引用**（「verify.sh:21」「make.js:41」「grid.js:206-210」…）照字面全部"文件不存在"。
   逐条读原文后补成仓根相对路径——裸名在这仓里唯一，但"唯一"是这个仓今天的形状，不是规则。
2. **13 处端口被写成了行号引用的形状**：文档把 5192、9352、5180、9340、5181、9341 这些端口写进
   反引号、前面带一个冒号——而"冒号 + 数字"正是续引的语法。于是借得到出处的那几条被拿去和被借那个
   文件的实际行数比长度（判越界），借不到的进「无法定址」。
   修法不是给端口挂一个文件——那会把"看着对、指着错"写进文档；是把端口写成不带冒号的 `5192`，
   一个不进引用语法的形状。**这是本仓文档与这条腿的语法之间唯一一处真正的歧义**：四位数的行号在
   语法上是合法的，闸读不出意图，所以意图必须由写法自己交代。
3. **一处指向隔壁的引用**：「端口默认值 5192 在 server.cjs:56」——56 行是 `module.exports`，
   默认值在 `server.cjs:59`。这一条没有锚点，边界与空行两把刀都不响，是读原文读出来的。
4. **「怎么跑」那一节的数字是手抄的**：标题印 8 条、表里列 10 行、`package.json` 实数 10 个键。
   新增的 D9e 现在当场数这三者并要求互相对得上（本仓加了 `doctest` 之后是 11）。
5. **`DESIGN.md` 一条行号引用都没有**，D2b 因此判红：文件被读进来了，但里面没有任何指得回实处的东西。
   现在它带着本轮补的引用，把"权重就是玩法""两条计数器不共谋""bail 一律拒绝""点击路径不许穷举"
   这些说法逐条钉到代码上。
6. **bake 四段的标签是文档起的**：文档写 `[1/4] prove` / `[2/4] measure` / `[3/4] publish`，
   代码打印的是 `[1/4] proof` / `[2/4] ladder` / `[3/4] <档位>`。文档改成照抄打印前缀，并给出各自行号。
7. **一句委托给不存在的文件的口径**：`DESIGN.md:4` 原先把"交付口径与验证记录"委托给 `deliverable.md`，
   而那个文件从没进过仓（本文早已写明）。现在第 4 行自己说清它没有随仓发货，两处口径一致。

### 这一腿没覆盖什么

- 它核的是**位置**，不是**语义**：行号在界内、锚点整词命中，不等于那句散文真的对。上面第 3、6、7 条
  都是它抓不到或只能抓到一半的形状，靠的是把每一条引用连同落点原文打出来逐条读。
- 文档里没有写成 `路径:行号` 的断言（"8 个文件全绿"、"40 关"、"wall=206.2s"这类）它一条也看不见；
  那些数字住在别处：套件数由 D9d 当场数目录，script 条数由 D9e 当场数 `package.json`，
  题库那 40 行由 `node test/lots.test.mjs` 逐行重烤重验。
- 跨仓引用（`../别的仓/文件:行号`）只按形状分类并计数，不参与本仓的越界检查——单仓 checkout 里
  兄弟仓不在盘上，真去读它会在 CI 里必红。本轮实数 0 处。
- 浏览器层不归它管：`bash tools/verify.sh` 里这条腿跑在 node 侧，页面里的数字由 `tools/playtest.mjs` 那套
  CDP 断言管，两套不互相代证。
- 「N 行」那条等式认的是**写法**：只有"反引号里的仓根相对路径 + 紧跟一个（N 行）"这种形状才会被核。
  数字后面还接着话的写法——像「（59 行，40 关烘进来的题库）」——会静静放过去。本仓第一轮就栽在这里：
  目录结构那一节最早写在围栏里、全是裸文件名，整节没有一条进得了闸的眼睛，而它是**绿**的。
  改的是写法（下面那张表），不是给解析器加一条"容忍括号里还有别的字"的规则——家族共用一个口径，
  为一篇文档 fork 它，代价由下一个读别仓文档的人付。

### 下刀台账

台架是仓外 `_scratch/kakurasu-docs-teeth/` 下的一份**副本**（它不进 `npm test`，也不随仓发货；
下面这张表是它本轮的读数，不是每次跑闸都会重发的东西）。三条纪律：刀只许红它该红的那一格；
红完立刻恢复副本并要求整闸回绿（红留在台上，不留在树里）；刀不许改文件行数——插一行就挪行号，
别的格子跟着红，一台架就说不清是谁咬的，所以 K8/K9/K10/K13 用的是**同行改写**而不是删行。

| 刀 | 砍在哪 | 该红的那一格 | 实测 |
| --- | --- | --- | --- |
| K1 | README 的 `minimalCore()` 那条引用行号窗口上移一格（246 → 244，落在它自己的注释上） | 锚点 | 红 1 格 |
| K2 | 把 `js/core/count.js` 写成 `js/core/counnt.js` | 边界（文件不存在） | 红 1 格 |
| K3 | `tools/verify.sh:21` 改指 verify.sh 现量到的第一个内部空行 | 边界（在界内但整段空白） | 红 1 格 |
| K4 | H1 行尾追加一条前面没有完整引用的裸续引 | 只让「无法定址」动（越界与解析条数都不理它） | 红 1 格 |
| K4b | 读数那行的「解析 114 条」抄成 100 条 | 只让那一条等式动（闸没数错，是文档说谎） | 红 1 格 |
| K5 | 把 `minimalCore()` 那个注解换成中文词 | 「N 条带指认」（锚点那半转为空转；D3 转绿是预期） | 红 1 格 |
| K6 | `anchorHit` 退回子串匹配 | D7 假引用九把 + D7b 前缀靶子那把哨 | 红 2 格 |
| K7 | 从副本里摘走 `DESIGN.md` | D1 输入集 / D2 边界（README 引的 `DESIGN.md:4`、`DESIGN.md:13` 落在不存在的文件上）+ 两条等式 | 红 4 格 |
| K8 | 把 D3a 那一格改成 `if (0)` 前缀 | 条数台账 | 红 1 格 |
| K9 | `ci.yml` 那一步换成另一条命令 | 接线 CI 格 | 红 1 格 |
| K10 | `tools/verify.sh` 里那一行换成另一条命令 | 接线本地整闸格 | 红 1 格 |
| K11 | 改 `package.json` 的 `doctest` 命令 | 接线 package.json 格 | 红 1 格 |
| K12 | 标题「11 条 scripts」改成 9 条 | script 同源那格（标题条数 / 表里行 / 键数三者对账） | 红 1 格 |
| K13 | 从 `npm test` 的链尾摘掉这条命令 | 接线链格（D9a/D9b/D9c 照旧绿：链外的三格还在） | 红 1 格 |
| K14 | 把 README 换成一句没有引用的话 | D2b + 五条等式 + D9e + D9f + D10（「文档行号对账 30 条」和 glob 那句都住在 README 里）；D1/D2/D3 照旧绿 | 红 9 格 |
| K15 | `css/game.css` 的行数从 161 改成 100 | 边界（`路径`（N 行）是等式，不是修辞） | 红 1 格 |
| K16 | 把 `README.md` 整个从副本里摘走（比 K14 更狠：文件不在了） | 这条腿**不许崩**：实测红 9 格且每一条都点名（D1 输入集 + 五条等式 + D9e + D9f + D10），没有一条 stack trace | 红 9 格 |
| K17 | README 印的「`npm run check` glob 实测展开 **29 个文件**」改成 30 | D9f（这一格现场按 `package.json` 的 token 展开再和文档对账——补的就是"文档写 25、实数 29、全套照样绿"那个洞） | 红 1 格 |

K7 那一行值得单说：它**不**红覆盖面下限（D2a）——摘走 DESIGN.md 之后 README 自己那一份还剩 62 条引用
（本轮实测；两份都在时是 114 条），早就过了 45 的下限，所以"少一份文档"这件事不是那条下限抓的，
抓它的是 D1。这类"以为会响、实测没响"的格子如果照推理写进断言，台架就会在自己讲的故事上打转；
上面每一行的"实测"都来自副本上真跑出来的 FAIL 行原文，K7、K14、K16 三把还在下断言之前先单独探过一遍
（先量再写，不是先跑再照着输出补期望）。

K16 是给这条腿自己补的一格。第一版在这里是**崩**的：`tools/docs-test.mjs` 无条件 `readFileSync('README.md')`，
文件不在就抛，于是 rc 非 0 却一条 FAIL 都没有——日志读起来是"闸挂了"，没人能把它归给某一条判据。
现在那份读是带存在性判断的，缺文件改口成 D9e 与 D1 红，其余各格照旧给读数。

这台架自己也被核着：`rows: 38 ok: 38 fail: 0` / `ALL TEETH BITE`——38 = 未下刀的对照腿 1 条 +
18 把刀 × 2（红一次 + 恢复后回绿）+ 末尾"仓里那棵树一个字节都没被碰过"那 1 条（48 个文件逐个比 md5）。
对照腿那条是全套的前提：它要是红的，后面 18 条"红了"全是废话。

补一条本轮学到的纪律，因为它一开始是假绿的一种：**"只许红它该红的那一格"要用 FAIL 总数来断言**。
`k.re` 只数它自己那几格，一条多红着的格子会从这个口径里溜走，而台架照样打印 ok——D9f 加进来之后，
K14/K16 各多红一格（那两条承诺 README 里都住着），台上写的还是"红 8 格"，直到台架自己加了
「共红 N 格（要 M）」这一式才把 9 报出来。现在每把刀都同时断言"该红的都在"和"总数就是那么多"。

同一轮里 K17 第一次下刀就**失败**而不是打红：它的 needle 是「glob 实测展开 **29 个文件**」，而这句话在下面
这张台账里被引用了一次，`edit()` 要求命中恰好 1 次，于是报的是"needle 命中 2 次"。这台架的下刀断言
（命中数、行数不变）就是为这两种情形准备的——它宁可拒绝下刀，也不在别的地方悄悄改一处。

## 目录结构（按真实 `ls`；下面每一条「N 行」都落在被这条腿核对的那种写法上——路径按仓根相对给出，
写歪一格、或者指的文件不在盘上，`node tools/docs-test.mjs` 就红）

| 路径与实测行数 | 是什么 |
| --- | --- |
| `js/core/grid.js`（260 行） | 棋盘模型：`rowSum`/`colSum` 是全仓唯一算带权和的地方，`validateLot` 的错误码、`checkDims` 的尺寸闸也在这里 |
| `js/core/count.js`（277 行） | 两条互不共享机器的解数计数器（DP 与回溯），加上线索极小化的 `minimalCore()` |
| `js/core/logic.js`（266 行） | 确定性求解器，`analyse` 那四个数（depth / chains / backtracks / nodes）由它产出 |
| `js/core/make.js`（187 行） | 出题器：掷棋盘 → 读线索 → 两条计数器各数一遍 → `analyse` → 卡难度带 |
| `js/core/game.js`（109 行） | 点击 / 撤销 / 进度的状态机；它不画像素，像素也不算合法性 |
| `js/core/storage.js`（200 行） | 唯一允许碰 `localStorage` 的模块，守卫是"抛异常"而不是"返回 null" |
| `js/core/rng.js`（49 行） | 可复现的种子随机 |
| `js/core/library.js`（110 行） | 战役序列的装配 |
| `js/main.js`（620 行） | 路由 + DOM + `window.kakurasu` / `window.kaku` 两个测试钩子 |
| `js/view.js`（407 行） | canvas 2D + 指针手势，只管像素 |
| `js/sw-register.js`（12 行） | service worker 注册 |
| `js/data/lots.js`（59 行） | 40 关烘进来的题库，`tools/bake.mjs` 的产物 |
| `test/anchorlib.mjs`（138 行） | 全仓唯一允许做 `2^(r*c)` 穷举的地方 |
| `test/anchor.test.mjs`（142 行） | 证明层：4×4 全空间枚举 + 三方一致 |
| `test/count.test.mjs`（209 行） | 计数器语义，含"权重定义换掉就数出另一个棋盘"那条反证 |
| `test/game.test.mjs`（192 行） | 状态机与 `par`：对 2^16 点击图真跑 BFS |
| `test/grid.test.mjs`（270 行） | 校验器的每条错误码都被负例打过一次 |
| `test/logic.test.mjs`（189 行） | 求解器的可复现性（两次调用逐字节相等） |
| `test/lots.test.mjs`（170 行） | 题库逐行重烤重验（印在产物上的数字改不对） |
| `test/make.test.mjs`（157 行） | 出题器的边界：会终止、每条拒绝路径都记账 |
| `test/storage.test.mjs`（281 行） | 存档语义，加**源码级**的越层扫描 |
| `tools/bake.mjs`（268 行） | 出题 + 复验四段（proof / ladder / 各档位 / write） |
| `tools/playtest.mjs`（679 行） | 零依赖 CDP 驱动的浏览器断言 |
| `tools/verify.sh`（154 行） | 本地整闸：node 侧 + 浏览器侧，一条命令跑完 |
| `tools/harness.mjs`（34 行） | 九个消费者共用的 `rows: N fail: M` 打印形状 |
| `tools/docs-test.mjs`（431 行） | 就是本节这条腿 |
| `tools/deploy-set.mjs`（347 行） | 部署集闸：检查即将上传的那份产物 |
| `tools/deploy-set-selftest.mjs`（316 行） | 上面那道闸的阴性自证（每一类断言当场打红一次） |
| `tools/assemble-site.sh`（31 行） | 部署产物的唯一清单，`.github/workflows/pages.yml` 与本地闸调同一支 |
| `css/game.css`（161 行） | 唯一的样式文件，提示行 34px 的高度是预留出来的 |
| `electron/main.cjs`（34 行） | 那份壳：仓里没有 `node_modules`，`electron` 不在 PATH |
| `.github/workflows/ci.yml`（59 行） | CI：`npm run check` → `npm run unit` → 本闸 |
| `.github/workflows/pages.yml`（43 行） | Pages 发布，调 `tools/assemble-site.sh` |
| `index.html`（75 行） | 单页外壳，favicon 是内联 SVG data-URI（否则 404 进控制台） |
| `server.cjs`（69 行） | 零依赖静态服务器，端口默认值在这里 |
| `package.json`（48 行） | 上面「怎么跑」那一节逐条核对的那 11 条 script |
| `DESIGN.md`（233 行） | 为什么这样实现，以及哪条约束一破就出 bug |
| `sw.js`（56 行） | service worker 本体 |

`LICENSE`（MIT，"Copyright (c) 2026 z-biz-game"）、`manifest.webmanifest`、`.gitignore` 这三条**不在**上面那张
表里，也不在那条等式里——这条腿认的扩展名表里没有它们，所以这里不写行数，要核只能 `ls`。
`icons/` 是仓里唯一的二进制（6 个 PNG），行数无从可核。

`test/` 里 9 个 `.mjs`：8 个 `*.test.mjs`（`DESIGN.md:13` 那句"8 个 node 测试文件"与实数一致）加
`anchorlib.mjs`——它是全仓唯一允许做 `2^(r*c)` 穷举的地方，自带 `MAX_ENUM_CELLS = 20` 闸门（`test/anchorlib.mjs:14`），
`js/*`、页面加载路径、`playtest.mjs` 都不引用它。测试层与 `js/core` **各写一遍权重**（`anchorlib.mjs` 不调用 `grid.js`），
两边对得上才算证据。

`css/` 只有 1 个文件、`electron/` 只有 1 个、`.github/workflows/` 只有 2 个——全部由 `ls` 核对过，没有虚构目录。
`DESIGN.md:4` 自己写明"过程文档 `deliverable.md` 没有随仓发货"，仓里确实没有这个文件（`ls deliverable.md` 报
`No such file or directory`，也没有 `docs/`）。因此本 README 不引用它，交付口径只以能跑的命令为准。

---

## 难度是怎么量出来的（数字全部来自烘进题库的实测分布）

`js/core/logic.js` 的 `analyse(lot)` 是一个确定性求解器，输出四个可复算的数：
`depth`（最多同时挂几层假设）、`chains`（最难那条路线的传播轮数）、`backtracks`（假设被反证后撤销的次数）、`nodes`（传播调用次数）。
它固定线序（先行后列、按下标）、固定分支序（先选中后留空）、固定选格启发（候选最少→下标最小），不读时钟、不用 RNG。
划带用的单一数值是 `rank = depth*100 + chains`（`js/core/make.js:54` 的 `rankOf`）。

`tools/bake.mjs` 的 `[2/4] measure` 每档抽 **120** 个随机唯一题面量 rank 分布，然后从实测值里**切**候选刀口，
要求每一档在自己那格里至少填得满 `FEASIBLE`（默认 `0.06`，`tools/bake.mjs:86`）否则换切点，最后一档取到无穷。
烘进 `js/data/lots.js` 的 `TIERS_META` 因此带着那 120 个样本的原始分布（下面四行是本轮 `node` 读 `lots.js` 打印的）：

```
shoal  浅滩 SHOAL   4×4  带 [1,1]      n=120  rank 1..2     p50 1  p75 1  p90 2    需假设 0.0%   0.1 ms/题  被拒 5
linked 连环 LINKED  5×5  带 [2,2]      n=120  rank 1..3     p50 2  p75 2  p90 2    需假设 0.0%   0.1 ms/题  被拒 6
twined 交缠 TWINED  6×6  带 [3,3]      n=120  rank 1..205   p50 2  p75 3  p90 3    需假设 3.3%   0.7 ms/题  被拒 25
master 迷阵 MASTER  7×7  带 [4,9999]   n=120  rank 2..609   p50 3  p75 6  p90 206  需假设 24.2%  11.1 ms/题 被拒 46
```

出货侧（`LOTS` 那 40 行，本轮按 `tier` 分组算出的范围）：

```
shoal   rank 1-1    marks 4-11   depthMax 0  backtracksMax 0  nodesMax 1   coreSize 5-6   holds 10/10
linked  rank 2-2    marks 10-16  depthMax 0  backtracksMax 0  nodesMax 1   coreSize 6-7   holds 8/10
twined  rank 3-3    marks 13-21  depthMax 0  backtracksMax 0  nodesMax 1   coreSize 9-10  holds 0/10
master  rank 4-409  marks 19-30  depthMax 4  backtracksMax 6  nodesMax 11  coreSize 11-13 holds 0/10
```

需要假设的关在整个题库里只有 **3** 个，全在 master：`master-01`（depth 2, rank 205）、`master-05`（depth 1, rank 108）、
`master-10`（depth 4, chains 9, backtracks 6, rank 409）。`test/lots.test.mjs` 有一条断言专门盯这件事：
没有 `depth > 0` 的关就报错，而不是靠"带子名字听起来更难"蒙过去。

三个量纲的边界要说清：

* **小盘之间的差别是链长，不是假设层数。** `depth` 在 4×4/5×5/6×6 的样本里实测恒为 0（见上表 `需假设 0.0% / 0.0% / 3.3%`），
  "单行子集排除"已经够强。屏上的"推理"数字对此不打掩护，因为它就是 `depth*100 + chains`。
* **`coreSize` 在 6×6/7×7 上是上界而不是精确值。** 20 行全是 `coreStatus: 'bounded'`（贪心删线索时撞了
  `CORE_NODE_CAP = 10000`，`js/core/make.js:45`），测试也只按"上界"口径断言。`holds` 的行数逐档是 10/8/0/0。
* **`msPerLot` 是 bake 那台机器、那次负载下的读数**，只用于档间相对比较，不是性能承诺。
  `test/make.test.mjs:140` 那条 `< 1500 ms/题面` 是防"有人把穷举放到点击路径上"的宽松闸，不是性能指标。

出题链条 `makeLot(seed, tier)`（`js/core/make.js`）每关要走：掷随机 0/1 棋盘 → 读线索对 → DP 数到 2 必须 = 1 →
回溯再数必须也 = 1 → `analyse` 不许撞上限 → rank 必须落在带内 → 仅 bake 才测线索极小化。
每条失败都记进 `blankStats()` 的计数器，`bake` 的 `[4/4]` 原样打印（`tools/bake.mjs:264-267`）。
上限一组：`MAX_ATTEMPTS = 400`（`js/core/make.js:41`）、`SOLVER_NODE_CAP = 4000`、`CORE_NODE_CAP = 10000`、
求解器自身默认 `nodeCap = 20000 / depthCap = 12`（`js/core/logic.js:172`）、两条计数器的 `stateCap = 400000 / nodeCap = 2000000`
（`js/core/count.js:30-31`）。任何一条撞线都拒绝该题面——**绝不把来自未完成搜索的数字印到屏幕上**。

`par`（"最少 N 点"）是另一条论证：一次点击只改一格、开局全空，所以下界就是唯一解的汉明距离；
`test/game.test.mjs` 不满足于这句论证，它对 4×4 的 `2^16` 状态点击图真跑了一遍 BFS 来反证。

---

## 屏上的每个数字是谁算的

| 屏幕上 | 谁算的 | 怎么复现 |
| --- | --- | --- |
| `解数 1` | `js/core/count.js` 两条互不共享机器的计数器：逐行子集 DP（状态 = 已填行的各列部分和）与逐格行优先回溯，都数到 2 就停 | `node test/lots.test.mjs`（对 40 关各重算两遍） |
| `推理 409`（= `depth*100 + chains`） | `js/core/logic.js` 那个确定性求解器实测的假设层数与传播轮数 | `node test/lots.test.mjs`（逐行重测四个字段）· `npm run bake` 的 `[3/4]`（本轮未跑） |
| `最少 N 点` | 唯一解的格子数；每点只改一格 → 没有更短的路 | `node test/game.test.mjs`（2^16 状态 BFS 反证） |
| 难度带 1 / 2 / 3 / 4+ | `tools/bake.mjs` 从每档 120 个实测 rank 里切的四刀，每刀要求该尺寸填得满 | `node test/lots.test.mjs`（带子严格递增 + 出货落带）· `tools/bake.mjs` 的 `[2/4] ladder/fill` |
| 每行 `coreSize` / `coreStatus` | `minimalCore()` 贪心删线索，删到"再删任一条 ⇒ ≥2 解" | `node test/count.test.mjs` + `node test/anchor.test.mjs`（核心里每条线索都由独立穷举证明咬得住） |

外部锚点（可独立重算的算术事实，不是拼出来的中间量）：把 4×4 的全部 `2^16 = 65536` 个棋盘按
`(行线索, 列线索)` 归类，`test/anchor.test.mjs` 逐条复现下面四件事，期望值是**手写**在文件里的字面量：

* 各类大小之和恰为 **65536**（每格棋盘只落进一个桶）；
* 类数 **64959**，且由两条独立数法（枚举 2^16 个棋盘 / 完全不看棋盘、直接走行子集的四重积）各自算出同一个数；
* 其中 **64382** 类唯一解、**577** 类多解，且多解类的大小都恰好是 2（`64382 + 2×577 = 65536`，闭式从另一边再对一次账）；
* 抽查 **400** 个类，DP、回溯、穷举三条路给出同一个数。

这四条数的**来历**要说准：`test/anchor.test.mjs` 开头自己写着期望值是"typed in by hand from the brief"
（手抄自那份 brief，而 brief 不在仓里，本轮没有它的副本）；这份测试能证明的是**本仓的实现复算得出同一组数**，
而不是"某个外部权威也这么写"。两类性质要分开：`65536`（=`2^16`）与 `64382 + 2×577 = 65536` 是纯算术、任何人重跑枚举都会落到同一点；
`64959 / 64382 / 577 / 400` 这四个数在本仓只有一个支撑面，就是那个独立枚举，没有第二个来源。

烘进产物的快照是 `js/data/lots.js` 的 `PROOF`：`{"sum":65536,"classes":64959,"classesBySubset":64959,"unique":64382,
"multi":577,"multiAllSizeTwo":true,"agree":{"n":400,"agreed":400}}`，`test/lots.test.mjs` 会再跑一遍独立枚举来验它没过期。
同文件另外两条不是来自 brief、是从枚举里掉出来的交叉核对：577 个多解类各取前 40 个，两条计数器必须都数出 2；
以及 `MAX_ENUM_CELLS = 20` 真的拒掉了 5×5/6×6/7×7（断言 `threw == 6`）。

---

## 玩法与路由（只写代码里真有的东西）

* 点一格 = 选中它，立刻按 `(x+1)` 计入所在行的带权和、按 `(y+1)` 计入所在列的和；再点 = 取消，**两次都记点击数**。
* `标记` 划叉的格子不计入任何和，只是给自己留记号：格值三态是 `js/core/game.js:18-20` 的 `OPEN = 0 / ON = 1 / NOTE = 2`
  （前两个复用 `js/core/grid.js:16-17` 的 `EMPTY`/`MARKED`），`tap` 的三态轮转写在 `js/core/game.js:49`，提示与传播会尊重被划掉的格
  （`test/logic.test.mjs` 有专门一条）。
* 键盘（`js/main.js:391-395`）：`u` 撤销 · `h` 提示 · `r` 重开 · `n` 标记 · `escape` 收起结算卡。撤销也记一次点击，
  因为"一次到位"是关于点击数的陈述（`@pointer`/`@play` 都有断言钉它）。
* 提示只说**纯推理能证明**的格子；若求解器认为要假设，那是 `depth` 实测出来的，不是它懒得想。
* 完成判定（`js/core/game.js:86`）：`isClueConsistent && isSolution` —— 前者就是 `statusOf(...).allOk`，即每条行列的带权和
  都恰好等于线索（`js/core/grid.js:202-204`），**且**盘面与那个被证明唯一的解逐格相同（`js/core/grid.js:206-210`）。
  两条计数器在数到 2 就停，语义要读准：`count === limit` 只表示"至少 limit 个"，`count < limit && !bailed` 才是精确，
  撞上限一律 `bailed` 并由调用方拒绝，不许把 bail 解释成"多解"。
* 路由解析在 `js/main.js:52-57`，认这几种：`#/campaign/<n>` 与 `#/c/<n>`（同一支，索引越界钳位到首尾）、
  `#/lot/<id>`、`#/daily`、`#/random/<tier>/<key>`（tier 缺省落 SHOAL，缺 key 时铸造一次并写回 URL），
  其余一律回落到战役 frontier。
* `#/daily` 是 `hashSeed(YYYY-MM-DD) % 40` 落在**题库**下标上，纯函数、零搜索
  （本轮按当前产物现算：`2026-09-27` → `master-02`、`09-28` → `shoal-09`、`09-29` → `twined-06`；换一天就换一个，这条只有函数意义）。
  `#/random` 才会现场跑生成器，被 `MAX_ATTEMPTS` 与计数器上限夹住。
* 存档只有一个 localStorage 键 `kakurasu.save.v1`（`js/core/storage.js:17`），清空要点两次。
  页面钩子是 `window.kakurasu`，同时挂了别名 `window.kaku`（`js/main.js:488-490`），`version === 1`。

---

## 端口与 URL 形态（取自 `server.cjs` / `tools/verify.sh` / `playtest.mjs` / CI 定义）

| 端口 | 用途 | 出处 |
| --- | --- | --- |
| `5192` | 本仓 web；`server.cjs` 默认值，`npm run dev` 显式传同一个数，`tools/verify.sh:21` 的 `WEB_PORT` | 实测打印 `数和 Kakurasu served at http://127.0.0.1:5192/` |
| `9352` | 本仓 devtools（CDP），`tools/verify.sh:20` | 被占用即 `exit 6`（`tools/verify.sh:35-39`），防止驱动连到别人的 tab 再把"0 browser asserts"当通过 |
| `5180` / `9340` | 兄弟仓 gridlock 的 web/devtools | 本轮 grep 其 `verify.sh` 得到的默认值 |
| `5181` / `9341` | 兄弟仓 nine-rings 的 web/devtools | 同上 |

`verify.sh` 的退出码是分层的：找不到 Chrome 退 2、devtools 没绑上退 3、静态服务器没答退 4、
`window.kakurasu` 没出现退 5、CDP 端口被占退 6；看门狗 `WD_TIMEOUT` 默认 420s，CI 收到 240s。

**浏览器闸跑几种 URL 形状**：一个 origin（`BASE_URL`，默认 `http://127.0.0.1:5192/`）之上的 7 种 hash 形状——
裸 `/`（`tools/verify.sh:88` 先 `open "$BASE"`）、`#/c/<n>`（含 0、99999、末关三种边界）、`#/lot/<id>`（含未知 id）、
`#/daily`、`#/random/<band>/<token>`（四档各一次）、裸 `#/random`、`#/nonsense`。
`tools/playtest.mjs:18-21` 用 `new URL(BASE).origin` 判断"是不是我们的 tab"，所以 `BASE_URL` 换成别的 origin 也能跑。

**CI 覆盖哪一种**：只覆盖 `http://127.0.0.1:5192/`。`ci.yml` 的 browser job 只设 `SKIP_UNIT=1` 与 `WD_TIMEOUT=240`，
**没有设 `BASE_URL`**，因此走的是默认回环口。

**CI 不覆盖哪些**：
`.github/workflows/pages.yml` 只做产物拷贝（`cp index.html` + `cp -r css js`，明确把 server、electron、tools、test 留在门外），
没有任何断言——也就是说 `https://<user>.github.io/<repo>/` 这条线上形状**没有闸**：
`tools/playtest.mjs:112-115` 的注释解释了 `waitShell` 是为 GitHub Pages 准备的（固定 sleep 曾让无辜的部署看起来坏了），
但没有一个 workflow 真的拿它去打个 Pages URL；`localhost:<port>` 写法同样没被覆盖；
`file://` 双击从来不是支持的玩法（ES module 需要 origin）。

静态服务器的实际行为（本轮用 `curl` 打本机 `5192` 端口实测，起完就杀）：
`/` 与 `/index.html` → 200 `text/html; charset=utf-8` 3590 字节；`/css/game.css` → 200 `text/css` 7069；
`/js/main.js` → 200 `text/javascript` 19847；`/js/core/count.js` → 200 12658；`/js/data/lots.js` → 200 16304；
全部带 `Cache-Control: no-cache`；`/nope.js` → 404；`/%zz`（坏编码）→ 400 `bad request`。
`server.cjs:29-31` 先把路径 `normalize`、剥掉前导的 `../`，再用 `startsWith(root)` 兜一层 403；
本轮实测 `/%2e%2e/%2e%2e/etc/passwd` 命中的是 **404**（前导 `..` 在第一步就被剥掉，压根没走到 403 那条分支），
两种形状都出不去仓库根，但要知道红的是哪一行。

---

## 不承诺什么

* **不承诺"抹掉任一条线索后解数 ≥ 2"。** 这不是"还没调好"，是完整线索集上做不到。`DESIGN.md` §2.4 记录的读数是：
  4×4 抽 1200 个唯一解类 × 8 条线索 = 9600 次"抹掉一条"，`count` 全为 1，**0 条**线索是 load-bearing 的，
  5×5/6×6/7×7 各抽 120 个随机唯一题面，同样一条都没有。**那个 9600 本轮未复现**（它是 bake 时代的抽样读数），
  测试层里真会红的是它的可复现版本：`test/anchor.test.mjs` 第 10 条抽 24 个唯一解类 × 8 次抹线索，
  用独立穷举 `bruteCount` 数，阈值写成 `stillUnique >= 24*8 - 8`（也就是允许至多 8 次真的破掉唯一性），
  `test/count.test.mjs` 另有两条"冗余线索抹掉仍唯一 + 独立枚举复核"。
  本仓因此把那条反证搬到**包含极小核心**上：`minimalCore()` 贪心删线索，删完剩下的每条都由独立穷举证明
  "再删它 ⇒ ≥2 解"，`coreSize`/`coreStatus` 逐行标在数据里。
* **不承诺 8×8 及以上。** `checkDims` 是边长 4..8 且 `r*c <= 49`（`js/core/grid.js:20-31`）：
  7×7 与 6×8（48 格）在内，8×8 在外，`test/grid.test.mjs` 有正负例（3×3 与 8×8 都拒，且报错信息说得出为什么）。
  原因是 DP 的状态是列部分和向量，随列数组合爆炸——这是硬边界，不是性能调优项。
* **不承诺 6×6/7×7 的 `coreSize` 是精确值。** 那 20 行是 `bounded`，数字是上界。
* **浏览器层给的是本轮读数，不是承诺。** 本轮 `bash tools/verify.sh` 跑到底并退 0，末尾就是 `=== ALL GREEN ===`：
  6 段共 101 行断言、控制台 `(none)`、外加文档对账 30 行与部署集 52 行。它证明的是**这台机器的 headless Chrome
  在这一轮里**那 101 件事成立——不证明别的浏览器、不证明真机的触摸路径，也不保证下一次复跑同样绿。
  还有一件它抓不住：`tools/verify.sh:35-39` 只预检自己的 9352（被占则退 6），对**别的端口上**正在监听的
  Chrome 一无所知，所以"同一时刻只留一个 headless 台架"是台架纪律，不是一道红闸。
* **不承诺 `npm run electron` 能跑。** `electron/main.cjs` 与 `package.json` 的 `build` 段是壳，
  但仓里零依赖、没有 `node_modules`，Electron 二进制不在任何地方；`npm run bake` 同样未跑（它会改写 `js/data/lots.js`）。
* **不承诺计时可移植。** 本文那列「本机量级」是这台 M5 Pro、node v26.8.1 在一次负载下的读数；
  CI 是 ubuntu + node 22，`DESIGN.md` 里 `wall=206.2s`、`bake 3.5 分钟` 是 2026-09-27 那台机器的数，本轮未复现。
  结构量（65536/64959/64382/577/400/40/155）逐位可复现，计时量随机器漂移。
* **不承诺 dev 服务器的访问控制。** 它只挡"逃出仓库根"，仓库根内的任何文件都直接发：
  本轮实测 `/.git/config` → 200（373 字节）、`/.git/HEAD` → 200、`/package.json` → 200、`/server.cjs` → 200、
  `/tools/bake.mjs` → 200。线上靠 `pages.yml` 只拷 `index.html` + `css/` + `js/` 来兜，不靠服务器。
* **不承诺外部规则出处、也不承诺文档完备。** 仓内没有一条外部 URL；`DESIGN.md:4` 说明那份过程文档 `deliverable.md` 没有随仓发货，仓里不存在它。
* **刻意不做的产品面**（`DESIGN.md` §8）：成就、排行榜、签到、内购、云存档、分享战绩；
  多解计数榜单（本仓只发布唯一解）；点击时全枚举；打包器与任何图片/音频/字体资产；npm 依赖。
* 唯一分享的东西是谜题本身：`#/lot/<id>`。

## 上线的到底是哪一批文件

这个仓没有打包器：站点=一次文件拷贝。以前「拷哪些」写在 `pages.yml` 的 `run:` 里（手抄的几行
`cp`）。本地 `index.html` 直读仓库根，永远自洽；线上却按那份清单拷，于是页面后来引用的
`manifest.webmanifest`、`sw.js`、`icons/*` 可能一个都没上去——线上 404，而仓里的引擎测试与
真浏览器闸全绿，因为它们跑的都是仓库根，没有任何一步在「按清单拷」的那个环境下加载过页面。

现在清单只有一份，住在 `tools/assemble-site.sh`：CI 调它拷 `_site`，本地闸调它拷临时目录，
然后**对拷出来的产物**提要求（`tools/deploy-set.mjs`）：

- **W 清单与页面同源**：`pages.yml` 里必须真有 `run: bash tools/assemble-site.sh <dir>` 这一行，
  `ci.yml` 里必须真有 `run: node tools/deploy-set.mjs`。认的是调用那一行，不是文件里出现过这个
  路径——注释里本来就会写它，只 grep 字符串会被一句散文喂绿。
- **R 引用可达**：引用不靠手打名单。从 `index.html` 的 `href/src` 出发，凡解析出来是 `.js`/`.css`
  的就把那一站也扫一遍（CSS 的 `url()`、JS 去掉注释后的 `'./…'` 字面量、`new URL(x, base)` 的两种
  基、`navigator.serviceWorker.register`、`scope`），`manifest` 的 icons/screenshots/shortcuts 各自
  的 `src` 也算引用。取径上读不到的那一站本身就是红（读不到＝这一站根本没扫）。每条引用都必须在
  产物里且非 0 字节；绝对路径单列一条红，因为 Pages 挂在 `/<repo>/` 前缀下会跳出去。
- **P 位图不许说谎**：`manifest` 声明的 `sizes` 必须等于 PNG IHDR 的真实宽高——文件图标读文件头，
  内联成 base64 的图标先解码再读同一段。后一条不是可选项：图标可能住在清单里而不是盘上的 `.png`
  （有的仓另有一条"零二进制文件"的承诺，那条只约束"有没有 .png 这个文件"）；如果 P 段只筛文件名，
  声明写 512 而真图 192 就一路放行。
- **钉住两个数**：R 段实际检查的路径条数（`33`）与这一次跑的断言条数（`51`），两个数
  都钉在 `tools/deploy-set.mjs` 顶部的那对常量里。没改页面却掉了，说明解析断了；删掉一张图标会同时
  少一条 R10 与那张的 P1/P2，所以两个数一起钉，断言条数能漂就是闸在缩水的信号。这一节故意只写数值、
  不写那对常量的名字，也不写别仓文档闸的编号：有的仓的文档闸会拿"文档里出现过的同名标识号"回数它
  自己的条数，还有的会把文档里点到的每个组编号逐个核对"这一轮真的发过"——两道闸共用一个名字，
  或者在本仓的文档里出现一个本仓没有的组编号，打红的都是不相干的那一边。

`tools/deploy-set-selftest.mjs` 是这两颗钉的阳性证明：它把仓库复制到临时目录，照着每一类断言
各下一刀（X1 清单不收位图目录 / X2 模块边改名 / X3 CSS 写绝对路径 / X4 `start_url` 绝对 /
X5 删光 >=512 图标 / X6 少一个必填字段 / X7 声明尺寸与真图不符 / X8 workflow 不调脚本 /
X9 CI 不跑闸 / X10 是阴性对照——往入口 JS 追加一行只写在注释里的假路径，闸必须仍然绿、条数仍然
`33`、断言仍然 `51`；X11 og:image 退回相对路径 / X12 og:image 的前缀指向别的 slug /
X13 内联位图谎报尺寸——只在有靶子时下：X11/X12 要页面上那句 og:image，X13 要清单里真有一段 base64
图标，没有就打印 SKIP；反过来 X1 没有位图目录可砍时改砍 css，P 段一位都不核时台架直接报靶子不够），
要求每一刀都让闸**点名**变红。靶子从 `DEPLOY_SET_DUMP=1`
的出处表现挑（取径真的会读的那支 JS / 那一张 CSS，不写死某一个仓的入口名），所以页面改了、仓与仓
不同，台架跟着走。

`node tools/deploy-set.mjs` 与 `node tools/deploy-set-selftest.mjs` 就是 CI 跑的那两条命令本身
（package.json 里的 `deploy-set` / `deploy-set:selftest` 只是同一支脚本的 npm 入口）；本仓的整闸在 `tools/verify.sh` 的 `=== deploy-set ===` 那一段也各跑一次。它们红的时候并进本仓那条出口的退出码——这一条是这么证的：
把 ci.yml 里那行 `run: node tools/deploy-set.mjs` 砍掉，本仓整闸必须点名红且退出码非 0。
所以「本地全绿、线上 404 自己的 manifest / sw.js / 图标」这一类坏法在本地就会红。

## 在线试玩

<https://z-biz-game.github.io/z-biz-game-kakurasu-cos/>（`main` 分支推送即自动部署）
