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
| 屏上"推理 N"改不掉 | `node test/lots.test.mjs`、`npm run bake` | 40 行逐行重跑 `analyse`，`depth/chains/backtracks/nodes` 必须逐个相等，且 `rank == depth*100 + chains`；bake 的 `[3/4] publish` 用同一条路径复验 | 实测 `rows: 13 fail: 0`；上限是 `SOLVER_NODE_CAP = 4000`（`js/core/make.js:44`），同一文件另断言 `nodes <= 4000`、`depth <= 12` |
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
而那一层本轮没有跑（见「不承诺」一节）。

---

## 怎么跑：`package.json` 的 8 条 scripts 逐条核对

脚本清单就是 `package.json:7-16` 的原文，8 条都在，没有虚构：

| script | 实际执行的命令 | 本轮跑过吗 | 结果 |
| --- | --- | --- | --- |
| `start` | `node server.cjs` | 是（直接起 `server.cjs`） | 打印 `数和 Kakurasu served at http://127.0.0.1:5192/  (ctrl+c to stop)`；`SIGINT` 后 `lsof` 确认端口已释放 |
| `dev` | `node server.cjs 5192` | 与 `start` 同一条路径（只是把端口写死），未单独起 | 端口默认值 `5192` 在 `server.cjs:56` 与 `verify.sh:21` 各写一次 |
| `check` | `for f in js/*.js js/*/*.js server.cjs electron/main.cjs tools/*.mjs test/*.mjs; do node --check "$f"; done && echo OK` | 是（随 `npm test`） | 打印 `OK`；同一 glob 实测展开 **25 个文件**（js 根 2 + core/data 9 + server.cjs 1 + electron 1 + tools/*.mjs 3 + test/*.mjs 9） |
| `unit` | `for f in test/*.test.mjs; do node "$f"; done` | 是（随 `npm test`，也逐个跑过） | 8 个文件全绿，见下表 |
| `test` | `npm run check && npm run unit` | **是** | `exit 0`，交回 8 行 `rows: N fail: 0`（见下一节的逐条读数） |
| `bake` | `node tools/bake.mjs` | **否** | 它按 `[4/4] wrote 40 lots -> js/data/lots.js` 改写题库源文件（`tools/bake.mjs:263`），文档轮不动已发货的题库，所以没跑；DESIGN 里那组 `wall=206.2s` 本轮未复现 |
| `electron` | `electron .` | **否** | `dependencies`/`devDependencies` 都是 `{}`，仓里没有 `node_modules`，`electron` 也不在 PATH；`electron/main.cjs` 只是那份 34 行的壳 |
| `verify` | `bash tools/verify.sh` | **否** | 本轮这台机器上已有一个别的仓的 headless Chrome 带着 `--remote-debugging-port=9373` 在听（`/tmp/sky-chrome-profile`），浏览器台架的纪律是同一时刻只留一个，所以没有派生它。要验的人自己跑，命令在「门禁清单」一节末尾。本文浏览器层的数字全部是源码点数，不是实测 |
| `deploy-set` | `node tools/deploy-set.mjs` | 绿：对拷出来的产物提要求（见「上线的到底是哪一批文件」一节） |
| `deploy-set:selftest` | `node tools/deploy-set-selftest.mjs` | 绿：9 刀逐类打红且点名 + 1 条阴性对照 |

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

浏览器层（`bash tools/verify.sh` → `tools/playtest.mjs`，走真实 CDP 打 `http://127.0.0.1:5192/`）**本轮没有实测**，
原因是这台机器上此刻有另一个仓的 headless Chrome 带着 `--remote-debugging-port=9373` 在听，而浏览器台架的纪律是同一时刻只留一个。
要说准一件事：**本仓的脚本挡不住这种情形** —— `verify.sh:35-39` 只预检自己的 `:9352`（被占则 `exit 6`），
它对别的端口上的 Chrome 一无所知（那里没有 `pgrep` 全机扫描那一层），所以停下来的是台架纪律，不是一道红闸。
下表条数是**源码里 `rec(` 调用的点数**，不是交回的读数：

| 段 | 判什么 | 源码点数 |
| --- | --- | --- |
| `@boot` | 直接进游戏、canvas 有真像素且不是未样式化的 300×150（backing store 与 CSS 盒按 dpr 对账）、棋盘真被画出来、题库加载、每档报实测范围、带子严格递增、顶档含需假设的关、浏览器自己重跑两条计数器与 `analyse` 必须与印在行上的一致、面板打印"点击/最少/解数/推理"、about 文案点名 65536/64959/64382 | 15 |
| `@play` | 关卡下限等于自己的格数、线索对确由解格按位加权得到、半解不算解、双点两次记两次点击并回到原画面、撤销记一次点击、重开清空、按 `par` 收关给 `★★★` 且 `perfect` 打标、超 `par` 有解无标、记录保最好而非最新、提示按一次推理计费、满行按权重付 10、超线索行不算进度且被计数 | 16 |
| `@routes` | `#/c/7`、越界索引钳位（99999 与 0）、末关属顶档、`#/daily` 两次同盘且标签带日期、四档 `#/random/<band>/<token>` 各自落带且可复现（**循环内**，4 次）、同 token 跨档不同难度、换 token 换盘、裸 `#/random` 会铸造 token、`#/lot/<id>` 与未知 id 兜底、`#/nonsense` 仍发牌 | 16（实跑 19） |
| `@save` | 双次点击才清空存档、清空后 `records` 归零且 `localStorage` 键为 `null`、解一关写入 `kakurasu.save.v1`、解锁推进到 2、`perfect` 打标、第 2 关可点第 3 关仍锁、面板回读"最佳"、每日槽写入、页内报 `persistent === true` | 14 |
| `@reloaded` | 必须排在 `@save` 之后且在自己的驱动进程里跑：新页面从磁盘读回进度、第一关记录回来、货架显示已完成、表头计数、每日槽被记住、`reset` 后磁盘上什么都不留 | 6 |
| `@pointer` | 真实 `Input.dispatchMouseEvent`：20 个控件都存在、整条认证解用鼠标点完、原地双点回到原画面、点线索槽不计、拖拽涂装一笔连出三格、越界与 gutter 点不动、键盘 `u/h/r/n` | 34（其中 3 处只在失败时说话：gutter 找不到点、认证解途中某格不在屏上、某口没计费 ⇒ 正常路径 31 行） |

合计 **101 处**调用点；把 routes 那条 4 档循环展开、去掉那 3 条「只在失败时说话」的行，正常路径应交回 **101 行**（boot 15 / play 16 / routes 19 / save 14 / reloaded 6 / pointer 31）。第二道闸与控制台洁净绑在一起：`verify.sh:132` 对每段输出 grep
`[EXCEPTION]|[log:error]|[error]|[warning]`，命中即算红——所以 `willReadFrequently`、内联 favicon 这些细节是门禁的一部分，不是风格。

CI 两道 job（`.github/workflows/ci.yml`，本机未观测，只按文件定义记录）：
`unit` 在 ubuntu-latest / node 22 上跑与 `npm run check` **同一份 glob** 的 `node --check`，再逐个跑 `test/*.test.mjs`；
`browser` 用 `SKIP_UNIT=1 WD_TIMEOUT=240 bash tools/verify.sh`，即只跑上面那 6 段。

**这台机器上没有任何一道 node 闸读红**：`npm test` 的 8 行 `rows:` 全是 `fail: 0`，两条计时闸（anchor 的 20s、make 的 1500ms/题面）都远未触及。

想补上浏览器层那一格读数，命令是 `bash tools/verify.sh`（全 6 段）或 `SCENARIOS="pointer" bash tools/verify.sh`（只跑真指针那一段）。
前提是本机 `:5192` 与 `:9352` 空着、且没有另一个仓的 headless Chrome 在听 —— 后者脚本自己不检查，见本节开头。

---

## 目录结构（按真实 `ls`，行数为同一轮 `wc -l` 的输出）

仓库根 13 项版本内容（再加一个 `.git`）：

```
.github/workflows/  ci.yml · pages.yml      css/  game.css (110)
js/  main.js (490) · view.js (391)          js/core/  count.js (277) · game.js (109) · grid.js (260)
                                                      library.js (110) · logic.js (266) · make.js (187)
                                                      rng.js (49) · storage.js (165)
js/data/  lots.js (59)                      test/  8 个 *.test.mjs + anchorlib.mjs (138)
tools/  bake.mjs (268) · harness.mjs (34) · playtest.mjs (679) · verify.sh (145)
electron/  main.cjs (34)                    index.html (68) · server.cjs (69) · package.json (39)
DESIGN.md (233) · README.md · LICENSE (21 行, MIT, "Copyright (c) 2026 z-biz-game") · .gitignore
```

`test/` 里 9 个 `.mjs`：8 个 `*.test.mjs`（`DESIGN.md:13` 那句"8 个 node 测试文件"与实数一致）加
`anchorlib.mjs`——它是全仓唯一允许做 `2^(r*c)` 穷举的地方，自带 `MAX_ENUM_CELLS = 20` 闸门（`test/anchorlib.mjs:14`），
`js/*`、页面加载路径、`playtest.mjs` 都不引用它。测试层与 `js/core` **各写一遍权重**（`anchorlib.mjs` 不调用 `grid.js`），
两边对得上才算证据。

`css/` 只有 1 个文件、`electron/` 只有 1 个、`.github/workflows/` 只有 2 个——全部由 `ls` 核对过，没有虚构目录。
tools/assemble-site.sh  部署产物的唯一清单（pages.yml 与本地闸调同一支）
tools/deploy-set.mjs  部署集闸：检查即将上传的那份产物
tools/deploy-set-selftest.mjs  部署集闸的阴性自证（每一类断言当场打红一次）
`DESIGN.md:4` 说"交付口径与验证记录在 `deliverable.md`"，**但仓里没有这个文件**（`ls deliverable.md` 报
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
上限一组：`MAX_ATTEMPTS = 400`（`make.js:41`）、`SOLVER_NODE_CAP = 4000`、`CORE_NODE_CAP = 10000`、
求解器自身默认 `nodeCap = 20000 / depthCap = 12`（`logic.js:172`）、两条计数器的 `stateCap = 400000 / nodeCap = 2000000`
（`count.js:30-31`）。任何一条撞线都拒绝该题面——**绝不把来自未完成搜索的数字印到屏幕上**。

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
  （前两个复用 `js/core/grid.js:16-17` 的 `EMPTY`/`MARKED`），`tap` 的三态轮转写在 `game.js:49`，提示与传播会尊重被划掉的格
  （`test/logic.test.mjs` 有专门一条）。
* 键盘（`js/main.js:391-395`）：`u` 撤销 · `h` 提示 · `r` 重开 · `n` 标记 · `escape` 收起结算卡。撤销也记一次点击，
  因为"一次到位"是关于点击数的陈述（`@pointer`/`@play` 都有断言钉它）。
* 提示只说**纯推理能证明**的格子；若求解器认为要假设，那是 `depth` 实测出来的，不是它懒得想。
* 完成判定（`js/core/game.js:86`）：`isClueConsistent && isSolution` —— 前者就是 `statusOf(...).allOk`，即每条行列的带权和
  都恰好等于线索（`js/core/grid.js:202-204`），**且**盘面与那个被证明唯一的解逐格相同（`grid.js:206-210`）。
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
| `:5192` | 本仓 web；`server.cjs` 默认值，`npm run dev` 显式传同一个数，`verify.sh:21` 的 `WEB_PORT` | 实测打印 `数和 Kakurasu served at http://127.0.0.1:5192/` |
| `:9352` | 本仓 devtools（CDP），`verify.sh:20` | 被占用即 `exit 6`（`verify.sh:35-39`），防止驱动连到别人的 tab 再把"0 browser asserts"当通过 |
| `:5180` / `:9340` | 兄弟仓 gridlock 的 web/devtools | 本轮 grep 其 `verify.sh` 得到的默认值 |
| `:5181` / `:9341` | 兄弟仓 nine-rings 的 web/devtools | 同上 |

`verify.sh` 的退出码是分层的：找不到 Chrome 退 2、devtools 没绑上退 3、静态服务器没答退 4、
`window.kakurasu` 没出现退 5、CDP 端口被占退 6；看门狗 `WD_TIMEOUT` 默认 420s，CI 收到 240s。

**浏览器闸跑几种 URL 形状**：一个 origin（`BASE_URL`，默认 `http://127.0.0.1:5192/`）之上的 7 种 hash 形状——
裸 `/`（`verify.sh:88` 先 `open "$BASE"`）、`#/c/<n>`（含 0、99999、末关三种边界）、`#/lot/<id>`（含未知 id）、
`#/daily`、`#/random/<band>/<token>`（四档各一次）、裸 `#/random`、`#/nonsense`。
`playtest.mjs:18-21` 用 `new URL(BASE).origin` 判断"是不是我们的 tab"，所以 `BASE_URL` 换成别的 origin 也能跑。

**CI 覆盖哪一种**：只覆盖 `http://127.0.0.1:5192/`。`ci.yml` 的 browser job 只设 `SKIP_UNIT=1` 与 `WD_TIMEOUT=240`，
**没有设 `BASE_URL`**，因此走的是默认回环口。

**CI 不覆盖哪些**：
`.github/workflows/pages.yml` 只做产物拷贝（`cp index.html` + `cp -r css js`，明确把 server、electron、tools、test 留在门外），
没有任何断言——也就是说 `https://<user>.github.io/<repo>/` 这条线上形状**没有闸**：
`playtest.mjs:112-115` 的注释解释了 `waitShell` 是为 GitHub Pages 准备的（固定 sleep 曾让无辜的部署看起来坏了），
但没有一个 workflow 真的拿它去打个 Pages URL；`localhost:<port>` 写法同样没被覆盖；
`file://` 双击从来不是支持的玩法（ES module 需要 origin）。

静态服务器的实际行为（本轮用 `curl` 打本机 `:5192` 实测，起完就杀）：
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
* **不承诺任何浏览器层的实测结论。** 本轮这台机器的 headless Chrome 台架被别的仓占着（见「怎么跑」一节 `verify` 那一行），
  `tools/verify.sh` 因此没有派生，所以 canvas 命中、devicePixelRatio 对账、
  拖拽涂装、存档真的落盘、路由真的解析这些**只有定义、没有本轮读数**。
  想验的人自己跑：`bash tools/verify.sh`（本机口 5192/9352，占用会退 6）。
* **不承诺 `npm run electron` 能跑。** `electron/main.cjs` 与 `package.json` 的 `build` 段是壳，
  但仓里零依赖、没有 `node_modules`，Electron 二进制不在任何地方；`npm run bake` 同样未跑（它会改写 `js/data/lots.js`）。
* **不承诺计时可移植。** 本文那列「本机量级」是这台 M5 Pro、node v26.8.1 在一次负载下的读数；
  CI 是 ubuntu + node 22，`DESIGN.md` 里 `wall=206.2s`、`bake 3.5 分钟` 是 2026-09-27 那台机器的数，本轮未复现。
  结构量（65536/64959/64382/577/400/40/155）逐位可复现，计时量随机器漂移。
* **不承诺 dev 服务器的访问控制。** 它只挡"逃出仓库根"，仓库根内的任何文件都直接发：
  本轮实测 `/.git/config` → 200（373 字节）、`/.git/HEAD` → 200、`/package.json` → 200、`/server.cjs` → 200、
  `/tools/bake.mjs` → 200。线上靠 `pages.yml` 只拷 `index.html` + `css/` + `js/` 来兜，不靠服务器。
* **不承诺外部规则出处、也不承诺文档完备。** 仓内没有一条外部 URL；`DESIGN.md:4` 引用的 `deliverable.md` 在仓里不存在。
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
