# DESIGN · 数和 KAKURASU —— 写给接手的维护者代理

本文只回答两件事：**为什么这样实现**，以及**哪条约束一破就出 bug**。
交付口径与验证记录在 `deliverable.md`，玩法在 `README.md`。

```
index.html   css/game.css
js/main.js   路由 + DOM + window.kakurasu / window.kaku 测试钩子
js/view.js   canvas 2D + 指针；只管像素与手势
js/core/     grid model / 解数计数器 / 确定性求解器 / 生成器 / 存档 / rng —— 纯函数
js/data/lots.js  40 关实测题库（tools/bake.mjs 产出，test/lots.test.mjs 复算）
tools/       bake.mjs 出题+复验 · playtest.mjs 零依赖 CDP 驱动 · verify.sh 验收门 · harness.mjs
test/        8 个 node 测试文件；anchorlib.mjs 是唯一允许做 2^(r·c) 穷举的地方
```

---

## 1. 三层规则，以及它为什么不是洁癖

`js/core/*` 里不许出现 `window.` / `document.`（`test/storage.test.mjs` 有一条**源码级**断言在
守这条线，白名单只有 `storage.js`）。这样 `node --test` 才能直接 import 求解器，把 4×4 全空间
的锚点跑成一条断言，而不是"在浏览器里 console 看一眼"。`test/storage.test.mjs` 同时断言：
core 里出现 `requestAnimationFrame`/`addEventListener` 就是越层。

`view.js` 不判合法性，`main.js` 不画像素，`core` 不知道有屏幕。数和最怕的重复实现是
"UI 自己算一遍行和"：那样点子和判定会各自漂移。这里只有一处算带权和（`grid.js` 的
`rowSum`/`colSum`），视图通过 `game.progress()` 读回来上色。

`storage.js` 是唯一的例外，而且它的守卫是**会抛异常**而不是返回 null：
`rawBackend()` 在没有 window、或浏览器在**读属性**时就抛（Safari 隐私模式、部分 webview 的
file://）的场合抛 `Error`；调用方 `current()` 把抛包成"这次没有持久层"。返回 null 之所以不行：
null 和"存储答话说这里没有存档"是同一种形状，而后者是合法地开新局 —— 把前者误判成后者，
用户会发现自己的成绩被静默清空。两条路径在 `test/storage.test.mjs` 都有断言。

## 2. 规则与模型

### 2.1 权重就是玩法

```
row clue[y] = Σ 被选中格子的 (x+1)      ← 行线索由「列号」付费
col clue[x] = Σ 被选中格子的 (y+1)      ← 列线索由「行号」付费
```

`test/count.test.mjs` 里有一条专门的反证：同一串印刷数字 `[1,2,3,4]/[1,2,3,4]`，按带权和数出
1 个解（对角线 `1000/0100/0010/0001`），按"格子数"数出的是另一个棋盘（阶梯形）。也就是说
`count == 1` 这个结论**依赖权重定义**，不是换个定义也照样成立的空话。

`maxClue(n) = n(n+1)/2`；超出即 `validateLot` 报 `clue-range`。校验器的每条错误码
（`dims` / `missing-row-clue` / `missing-col-clue` / `clue-range` / `cell-overlap` / `cell-value`
/ `grid-shape` / `solution-clue`）都被 `test/grid.test.mjs` 的负例打到过一次 —— 打不到的码
等于没在工作。

### 2.2 尺寸上限

`checkDims`：边长 4..8、且 `r*c ≤ 49`。所以 7×7 与 6×8 在内，8×8 之外全拒。原因是 DP 的状态
是**列部分和向量**，随 c 组合爆炸；这不是性能调优项，是规格 6 的硬边界。

### 2.3 两条计数器，一条都不能省

`countSolutionsDP`：逐行，状态 = 已填行的各列部分和；转移 = 选一个列子集使其**列号**和等于
该行线索，并把**行号** y+1 加到对应列的部分和上；部分和越过线索即剪；末了向量恰好等于列线索
向量的状态数即解数。

`countSolutionsBacktrack`：逐格、行优先、DFS，只共享规则不共享机器。

两条都在数到 `limit` 时饱和，返回 `{count, bailed, states|nodes}`。**语义要读准**：
`count === limit` 只表示"至少 limit 个"（证伪唯一性够用），`count < limit && !bailed` 才是
"精确"（证明唯一性必须如此）。`bailed` 表示撞了上限、这个数字没有意义 —— 调用方一律**拒绝**，
不允许把 bail 解释成"多解"（那会把"这条线索是冗余的"这类断言蒙过去）。

> **踩过的坑（真事）**：brief 自带的 `/tmp/puzzle-brief/probe5.mjs` 里那个 `kakurasuDp`
> 往列状态里加的是**列号**而不是行号（`v[col-1] += col`），对它自己的样例只会返回 0 解；
> 它在 probe5 里其实从未被调用 —— probe5 的"DP==回溯"那条锚点实际比的是"穷举类大小==回溯"。
> 我的第一版照抄了这个语义，于是 400 个类里 396 个对不上。现在 `count.js` 里那一行有注释钉住，
> `test/count.test.mjs` 用手写 fixture 卡住它。

### 2.4 规格里那条反证在完整线索集上不成立 —— 本仓的处理

规格 §2 与契约 §3 都要求："同一题解数=1，**人为去掉一条线索后 ≥2**"。实测：

* 4×4 抽 1200 个唯一解类 × 8 条线索 = 9600 次"抹掉一条"，`count` **全为 1**，0 条线索是
  load-bearing 的；抽样用独立的 2^16 穷举复核过（`test/count.test.mjs`、`test/anchor.test.mjs`
  各断言一次）。
* 5×5/6×6/7×7 各抽 120 个随机唯一题面，同样一条 load-bearing 线索都没有。

原因不神秘：8 条精确带权和压 16 个二元未知数，本来就过定；抹掉一条还剩 7 条。
所以**没有把断言放宽**，而是把它搬到可满足的地方 —— `minimalCore()`：按固定顺序（先行后列、
按下标）贪心删线索，只要能证明删掉仍唯一就删。删完剩下的集合是**包含极小**的，此时
"再删任一条 ⇒ ≥2"真的成立，且被独立枚举验证（4×4 全部 3 个抽样类）。
题库每行因此带 `coreSize` 与 `coreStatus`：

| coreStatus | 含义 | 测试怎么断言 |
| --- | --- | --- |
| `holds` | 贪心未撞上限，且核心里每条线索都被证明 load-bearing | 重跑 `minimalCore` 必须仍是 `holds` 且 `coreSize` 相同 |
| `bounded` | 某次"能不能删"的判定撞了 state/node 上限 → 核心没走完，`coreSize` 只是**上界** | 只断言 `1 ≤ coreSize ≤ r+c`，不冒充精确 |

2026-09-27 这一次 bake：4×4 10/10 `holds`、5×5 8/10、6×6 0/10、7×7 0/10 —— 大盘算力不够是
**事实**，写在这里而不是偷偷去掉那一列。

### 2.5 唯一性只在 bake/test 里被穷举对账

`test/anchorlib.mjs` 是唯一做 2^(r·c) 穷举的文件，并且它自己**重新实现**了一遍权重（不调用
`grid.js`），所以两边一致才是证据。它带 `MAX_ENUM_CELLS = 20` 的闸门：5×5 以上直接抛，
免得有人手滑把 7×7 塞进某个页面加载路径。`tools/verify.sh` 的 node 段会跑到它（约 1s），
但页面加载、`playtest.mjs`、`js/*` 全都不引用它。

## 3. 难度是量出来的

`js/core/logic.js` 是一个**确定性**求解器，输出四个数：

| 字段 | 含义 |
| --- | --- |
| `depth` | 求解器最多同时挂着几层**假设**（0 = 纯传播就能推到底） |
| `chains` | 最难那条路线上的传播轮数（推理链长度） |
| `backtracks` | 假设被反证、需要撤销的次数 |
| `nodes` | `propagate()` 调用次数 —— 让"成本"这件事也可检查 |

可复现性优先于速度：固定线序（先行后列、按下标）、固定分支序（先选中后留空）、固定选格启发
（候选最少→下标最小）、不读时钟、不用 RNG、不依赖 Map/Set 的插入序。`test/logic.test.mjs`
断言同一线索对两次调用逐字节相等。`analyse` 被夹了两次上限（`nodeCap=4000`、`depthCap=12`），
任何一条撞线都返回 `capped: true`，生成器**拒绝**该题面 —— 绝不给一个来自未完成搜索的数字印到
屏幕上。

`rank = depth*100 + chains` 是划难度带用的单一数值（`make.js` 的 `rankOf`）。实测分布
（2026-09-27，本机，每档 120 个随机唯一题面）：

```
4×4  rank 1..2      需假设 0.0%    0.1 ms/题
5×5  rank 1..3      需假设 0.0%    0.1 ms/题
6×6  rank 1..205    需假设 3.3%    0.7 ms/题
7×7  rank 2..609    需假设 24.2%   11.1 ms/题
```

带子是 bake 从这些分布里**切**出来的，不是手填的：候选切点取实测 rank 值，要求每一档在
自己那一格里至少能填出 `FEASIBLE`（默认 6%）的题面，否则换切点；最后一档取到 ∞。
这一次切出 `shoal [1,1] / linked [2,2] / twined [3,3] / master [4,∞)`，填充分别是
83% / 58% / 21% / 44%。 出货结果：`shoal 1-1 (depth 0) · linked 2-2 (depth 0) ·
twined 3-3 (depth 0) · master 4-409 (depth 0-4)`。

> 诚实结论：`depth` 在 4×4/5×5/6×6 上实测恒为 0 —— "单行子集排除"已经足够强，小盘不需要假设。
> 所以小盘之间的差别是**链长**而不是**假设层数**，屏幕上的"推理"数字对此不打掩护；
> 需要假设的题面确实存在，但只在 7×7（`test/lots.test.mjs` 有一条断言：题库里必须有 `depth>0`
> 的关，且只能落在 master 档）。

### 3.1 点击时允许什么

契约禁止"点击时现场无上限搜索"。本仓的边界：

* 战役 / 每日：从 `js/data/lots.js` 读，**零搜索**。
* 提示 `nextDeduction()`：一次传播到不动点 + 必要时逐格 `limit=2` 试探，棋盘最大 49 格。
* `#/random`：现场跑生成器，但被 `MAX_ATTEMPTS=400` 与两个计数器上限夹住，且
  `withCore:false`（线索极小化只在 bake 跑）。实测：4×4~6×6 亚毫秒，7×7 约 7-12 ms/题面，
  加带子过滤后仍是个位数次尝试。`test/make.test.mjs` 有一条 1500ms/题面的宽松上限，
  它防的是"有人不小心把穷举放到了点击路径上"，不是性能指标。
* `recheck()`（`window.kakurasu`）：页面内对当前关重跑两条 `limit=2` 计数 + `analyse`，
  浏览器断言用它证明"屏幕上的 1 是浏览器自己算出来的"。

### 3.2 `par` / 最少点击数

`par = 唯一解里 1 的个数`。一次点击只改一格、开局全空 → 达到该棋盘的下界就是它的汉明距离。
`test/game.test.mjs` 不满足于这段论证：它真的对 4×4 的 2^16 状态点击图跑了一遍 BFS，
断言 `dist[目标] == popcount(目标)`（并顺手在若干棋盘上验证同一律）。撤销**也记一次点击**，
因为"一次到位"是关于点击数的陈述。

## 4. 生成器

`makeLot(seed, tier)`：掷随机 0/1 棋盘 → 读出线索对 → DP 数到 2 必须=1 → 回溯再数必须也=1
→ `analyse` 必须不撞上限 → rank 必须落在该档带内 →（仅 bake）测线索极小化。
每次失败都记进 `blankStats()` 的对应计数器，bake 结尾原样打印。

2026-09-27 这一次实测（本机、load ~30）：

```
attempted=111 accepted=40 (36.0%)  ambiguous=19  band=52  capped=0  bailed=0
maxDpStates=39144  maxSolverNodes=11  maxCoreNodes=8527  wall=206.2s（40 关，含复验）
```

拒绝原因里 `band` 占大头是**设计如此**（带子窄），不是命中率差：这 111 次尝试里只有 19 次因
为多解被拒（唯一性通过率约 83%），其余 52 次都是落在带子外面。

## 5. bake 的复验链

`tools/bake.mjs` 四段：`[1/4] prove`（4×4 全空间锚点 + 400 类三方一致）→ `[2/4] measure`
（rank 分布 + 切带）→ `[3/4] publish`（每关写入前：`validateLot`、解格自证线索对、两条计数器
重数、`analyse` 重测 `depth/chains/backtracks/nodes` 必须逐个相等、`rank` 必须等于
`depth*100+chains`、`marks` 必须等于解格数、`holds` 的核心重测必须仍 `holds` 且同尺寸）→
`[4/4] write`。任何一条对不上，构建失败。**印在产物上的数字因此不可能手工改对**：
`test/lots.test.mjs` 读的是同一份序列化线索对，再跑一遍同样的判断。

## 6. 视图与手势（像素层的坑）

* **devicePixelRatio**：`canvas.width = round(cssW * dpr)` 之后 `setTransform(dpr,0,0,dpr,0,0)`。
  少了这一步，Retina 上线条糊、命中测试偏一半。`@boot` 有一条断言把 backing store 与 CSS 盒
  对账（`|w - boxW*dpr| ≤ dpr+1`），并拒绝未样式化的 300×150 默认盒。
* **`getContext('2d', {willReadFrequently:true})`**：台架要 `getImageData` 读回位图指纹
  （证明合法点击改了画面、非法点击没改）。不加这个 flag，Chrome 每次读回打一条 rendering
  警告，`verify.sh` 的"控制台必须干净"就会假红。
* **ResizeObserver**：`window` 的 resize 不覆盖面板文字回流、手机转屏、devtools 分屏 ——
  这些都改画布盒而不改窗口。命中测试把 client 像素映射回**上次量到的**几何，量晚了就点错格。
* **提示行高度固定 34px**（`css/game.css` 里注释了原因）：如果提示文字从 1 行变 2 行，画布盒
  会被挤小、格子会从手指底下挪走。高度是预留的，不是协商来的。
* **拖拽涂装**：`pointerdown` 决定这一笔是"选中"还是"取消"，`pointermove` 对**新进入**的格子
  套用同一决定，每格各自记一次点击；`pointerup` 结束。台架 `@pointer` 用
  `Input.dispatchMouseEvent` 真实走一遍：整条认证解用点击走完、原地双点回到原画面、
  线索槽里按下不计、涂装一笔连出三个格子。
* `pointAt()` 返回 -1（ gutter / 边距）即"不是格子"，既不计数也不报错 —— 与 `tap()` 的越界
  拒绝一起构成"非法位置点不动"。

## 7. 台架（CDP）的坑，都是这农场里踩过换回来的

* 导航之后 **`waitShell()` 轮询 `window.kakurasu.state.id`**，不 `sleep()`。固定 sleep 在
  localhost 够用，打线上就是三条假故障。
* 结果 JSON 用**花括号计数**从 console 里截，不要 `JSON.parse(整行)`（headless 会在同一行
  尾部追加文本）。
* Chrome 用 `mktemp -d` 独立 profile；`/json/version` **和** web 根目录都就绪才开始；
  `trap cleanup EXIT` 里对每个后台 PID 都 `wait`（否则结尾刷一串 `Killed: 9`）；
  watchdog 子 shell 必须重定向 fd，否则管道里的消费者会被拖到超时。
* **端口**：本仓 web `:5192`、devtools `:9352`。跑之前 `pgrep -fl remote-debugging-port` +
  `lsof -nP -iTCP -sTCP:LISTEN` 查一遍：别的 builder 的 Chrome 停在错误端口上，会让驱动连到
  **别人的 tab**，然后把"0 browser asserts"当成通过。`verify.sh` 现在开头就查端口，占了就退 6。
* `index.html` 的 favicon 是**内联 SVG data-URI**：`href="data:,"` 会让 `/favicon.ico` 的 404
  进控制台，控制台不干净 = 断言红。
* `@reloaded` 必须排在 `@save` 之后、且在自己的驱动进程里跑（`eval` 不带 `nonav`），否则它
  分不清"模块缓存里还热着"和"磁盘上真有"。
* 浏览器断言的 `async` 体在 Node 侧是**模板字面量的源码文本**，正斜杠要写 `\\/`，否则页面收到
  一个未闭合的正则字面量，整套件在 parse 期就死。

## 8. 刻意不做

成就 / 排行榜 / 签到 / 内购 / 云存档 / 分享战绩；多解计数排行榜（本仓只发布唯一解）；
8×8 以上；点击时全枚举；打包器与任何图片/音频/字体资产；npm 依赖。

`deliverable.md` 的"未实现清单"是这份文档的诚实尾巴，两边口径一致。
