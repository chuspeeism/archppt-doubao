# 豆包特供版 · 运行器

**它干什么**：豆包把架构图的语义 JSON 落盘，`run.mjs` 一条命令跑完 —— 起面板、探授权、
用引擎算好布局，然后驱动本机的 Microsoft PowerPoint **一个图元一个图元地画出来**
（肉眼可见，像有人在替你操作），画完存成 `.pptx` 放到桌面、把路径报回去。
旁边有个网页面板，同步显示画到第几步了。

下面「一键（等剪贴板）」和「手动，分三步」是**开发调试路径**，装了技能包的用户走不到那儿 ——
他那条路只有 `run.mjs` 这一条命令。

跟 skill 的 `导出 PPTX` 有什么不一样：那个是一次性把文件写出来，你看不到过程；
这个是真的在 PowerPoint 里一笔一笔画。**两者画的是同一张图** —— 布局、配色、
排版口径全部来自同一个引擎（`scene-svg.mjs` 是唯一的排版来源）。

---

## 装什么

| 要求 | 说明 |
|---|---|
| macOS | 用到 `pbpaste` / `osascript`，只在 macOS 上跑 |
| Node 18+ | 零 npm 依赖，只用标准库 |
| Microsoft PowerPoint for Mac | 实测 16.112.4。**必须是桌面版**，网页版和 Keynote 都不行 |
| 自动化权限 | 第一次跑会弹一次「**豆包工作**想要控制 Microsoft PowerPoint」（从豆包里跑就是这个主体；自己在终端里跑才是「终端」），点允许。之后不再弹 |

装好之后什么都不用配置。

## 怎么跑

### 零人工：`run.mjs` 一条命令（豆包技能包走这条）

已经有一份 spec 的话，一条命令跑完全程——起面板、开浏览器、**先探一下 PowerPoint 有没有人应答**、
在 PowerPoint 里逐个画、存 pptx、报路径：

```bash
node run.mjs <spec.json> --delay 350
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--delay <毫秒>` | 350 | 每步之后停多久，给人看；出片设 0 |
| `--out <pptx>` | `~/Desktop/架构图-YYYYMMDD-HHmmss.pptx` | 另存路径；不给时同名自动加 -2 / -3，不覆盖。**落点有护栏**，见下 |
| `--port <端口>` | 7431 | 面板端口。**已被占用就直接复用**正在跑的那个，不报错 |
| `--no-open` | 关 | 不自动打开浏览器 |
| `--keep-panel <秒>` | 20 | 画完之后面板再留多久（让完成态停一会儿）；失败时不等 |
| `--dry-run` | 关 | 只走校验 + 布局 + 指令流，**不起面板、不碰 PowerPoint**。出货冒烟用它 |

**输出契约**（调用方只看最后一行就够）：成功退出码 0，stdout 最后一行
`已保存：<pptx 绝对路径>`；`--dry-run` 时是 `DRY-OK steps=<n> shapes=<n>`；
失败退出码非 0，最后一行 `失败：<原因>`。

**退出码 3 单独表示「PowerPoint 没应答、要人去点授权框」**，最后一行是
`失败：需要授权 —— PowerPoint 没有响应（-1712）。第一次使用需要在系统弹出的…`。
**退出码 4 单独表示「本机没装桌面版 PowerPoint」**（探针报 `-1728`），最后一行是
`失败：没装 PowerPoint —— …`。这两条分开是因为解法相反：后者根本没有授权框可点。
**退出码 5 单独表示「画起来之后 PowerPoint 中途没应答」**（收到过 `@@STEP … done`
或进了 `@@PHASE saving` 之后的 -1712），最后一行是 `失败：PowerPoint 无响应 —— …`。
它跟 3 的分界线就是**有没有画起来**：一步都没画 = 授权没给；已经画了 = PowerPoint
前台压着一个对话框（保存时的「授予文件访问权限」最常见），已画好的内容不会丢。
`-1743` 不分段 —— 那个码任何阶段都只有「授权被拒」一种意思，永远归 3。

**`--out` 的落点有护栏**（`--dry-run` 也走这一道）：
`/tmp`、`/private/tmp`、`/var/folders`、`/var/tmp` 这类系统临时目录，以及任何不在
用户主目录之下的路径，**一开始就拒绝**（退出码 2，最后一行
`失败：输出路径 … 不在你的用户目录下，PowerPoint 沙盒不能直接写入，请改用桌面或文稿目录`）。
落在主目录下、但不在 `~/Desktop` / `~/Documents` / `~/Downloads` 三处时**照跑**，
只先打一行 `提示：输出目录不是桌面/文稿/下载，PowerPoint 可能弹出「授予文件访问权限」…`
（这一行不是结论行，最后一行仍旧是 `已保存：` / `DRY-OK`）。默认落点是桌面，不受影响。

`失败：` 那一行**永远只有一行**。绘制失败时驱动器攒的是多行文本（`osascript 退出码 N`
加最多 20 行原始输出），进 stdout 前会被压成一行（换行换成 ` / `），完整文本留在
事件流的 `detail` 里。
真画之前 `run.mjs` 会先写一条 `phase:auth`、用一条最小指令（`get version`，25 秒超时）
探 PowerPoint 有没有人应答：探不通就立刻给这句判词，而不是让人对着不动的面板等两分钟。

`run.mjs` 和 `draw.mjs` 不是两套逻辑：可复用的那几块（引擎根查找、读校验、算布局、
驱动 PowerPoint）都在 `draw.mjs` 里导出，`run.mjs` 直接 import。

**引擎根是向上找的**（照 `scripts/_root.mjs` 的写法找含 `project/generate.mjs` 的那一层），
所以开发仓布局 `shells/doubao/runner/` 和技能包布局 `<技能目录>/runner/` 同一份代码都能跑。
`.state/` 永远落在 runner 目录旁边。

### 一键（人在场，等剪贴板）

在 Finder 里双击 `start.command`。它会：

1. 起面板服务，浏览器打开 `http://localhost:7431`
2. 等你复制架构图 JSON（默认最多等 10 分钟）
3. 收到之后驱动 PowerPoint 开画，每步停 400ms
4. 画完在终端提示「按回车关闭」，回车后关掉面板

三个可以用环境变量改的旋钮：

```bash
DOUBAO_PANEL_PORT=7431      # 面板端口
DOUBAO_DRAW_DELAY=400       # 每步停多少毫秒；出片设 0
DOUBAO_WAIT_SECONDS=600     # 等复制动作等多久
```

### 手动，分三步

```bash
cd <技能目录>/runner      # 开发仓里是 shells/doubao/runner

# 1) 面板（另开一个终端）
node panel/server.mjs --port 7431 --events .state/steps.jsonl

# 2) 等剪贴板，拿到一份校验通过的 spec
node watch-clipboard.mjs --once --timeout=600 --json-out --inbox=.state/inbox

# 3) 画（spec 路径从上一步的 accepted 事件里取）
node draw.mjs <spec.json> --delay 400 --events .state/steps.jsonl --append
```

### 只画，不等剪贴板

手上已经有 spec 的话，直接：

```bash
cd <技能目录>/runner && node draw.mjs <你的 spec.json> --delay 400
```

`draw.mjs` 的参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| `--delay <毫秒>` | 400 | 每步之后停多久。**这是给人看的，不是技术必需**；设 0 就是尽快画完 |
| `--out <pptx>` | `~/Desktop/架构图-YYYYMMDD-HHmmss.pptx` | 另存路径；不给时同名自动加 -2 / -3，不覆盖 |
| `--events <jsonl>` | `.state/steps.jsonl` | 事件流落盘位置 |
| `--append` | 关 | 往事件文件后面接着写（`start.command` 用这个）；不给就先清空 |
| `--no-activate` | 关 | 不把 PowerPoint 拉到前台（它照样在画，只是不抢焦点） |
| `--no-animation` | 关 | 不加进入动画 |
| `--keep-script` | 关 | 留下生成的 `.applescript` 临时文件，排错用 |

退出码：`0` 成功 / `2` spec 校验没过、或 `--out` 落点不合法 / `3` PowerPoint 没应答
（要点授权框）/ `5` 画起来之后 PowerPoint 中途无响应（前台压着对话框）/ `1` 其它。
`--out` 的落点护栏 `draw.mjs` 与 `run.mjs` 同一份（同一个 `checkOutPath`）。

## 这条链上每个文件干什么

```
run.mjs                零人工入口：面板 + 画 + 报路径，一条命令跑完（豆包技能包用这条）
start.command          一键启动器：把下面三个串起来（人在场、等剪贴板的那条路）
watch-clipboard.mjs    等剪贴板 → 剥围栏 → 校验 → 落盘 inbox/，打印 accepted 事件
draw.mjs               spec → 布局 → 绘制指令 → 驱动 PowerPoint → 事件 → pptx；同时是 run.mjs 的库
panel/server.mjs       零依赖 http：/ 面板页与静态件、/events SSE、/state 快照
panel/index.html       面板页的骨架（六个钩子 id 不许改，见 panel/CONTRACT.md）
panel/panel.css        面板样式：设计稿的 token 全在 :root，960×540 与 640×1080 两版
panel/panel.js         面板前端：连 /events、折叠状态、渲染；?demo=1 页内自播
panel/CONTRACT.md      事件契约 —— 面板只认这一份
.state/                本地状态：事件流、收件箱、截图证据。不入库
```

引擎侧的两块（在 `project/` 里，不在这个目录）：

```
project/lib/scene-from-spec.mjs        spec → Scene + 主题（与构建期口径一字不差）
project/lib/exporters/draw-steps.mjs   Scene → 有序绘制指令流（纯函数，通用）
project/drivers/mac-powerpoint.mjs     指令流 → AppleScript → 驱动 PowerPoint，流式回传事件
```

## 排错

**「找不到 node」**
双击起来的进程拿不到你在 `.zshrc` 里配的 PATH。`start.command` 已经把
`/usr/local/bin` 和 `/opt/homebrew/bin` 补进去了；用 nvm 装的 Node 不在这两处，
把它 `ln -s` 到 `/usr/local/bin/node`，或者改用手动三步跑。

**「端口 7431 已被占用」**
上一次的面板没关干净。`lsof -ti tcp:7431 | xargs kill`。

**复制了但监听器没反应**
先确认复制出来的**是纯文本**。监听器接受裸 JSON、` ```json ` 围栏、`~~~json`、
大小写混写、四个反引号、CRLF、带 BOM、甚至只有开头没有收尾的围栏（流式输出时按了复制）。
被截断的 JSON 会被正确忽略 —— 那是 `JSON.parse` 在拦，不是漏了。
监听器每 500ms 读一次，从按下复制到落盘平均约 363ms。

**画出来中文全是方块 / 乱码**
`pbpaste` 的编码跟着 locale 走，`LC_CTYPE` 不是 UTF-8 时中文会被转成 GBK 字节，
而 `JSON.parse` 和校验**照样通过**，于是你拿到一份「结构完全合法、标签全是 �」的 spec。
`watch-clipboard.mjs` 自己给 `pbpaste` 注入了 `LC_CTYPE=UTF-8`，所以走这条链不会中招；
但你要是自己写脚本调 `pbcopy`/`pbpaste`，这个坑得自己躲。

**PowerPoint 弹权限框**
第一次会弹一次「**豆包工作**想要控制 Microsoft PowerPoint」（从豆包里跑是这个主体；
自己在终端里跑才是「终端」），点允许，之后不再弹。
点了拒绝的话去 系统设置 → 隐私与安全性 → 自动化 里打开。

**-1712 / 布局完成后面板不动**
授权框**没弹出来**，或者被屏幕上别的系统弹窗挡住了 —— 同一时间 macOS 只显示一个授权框。
表现就是：布局算完了、PowerPoint 被拉到前台却一个图元都不画，两分钟后报
`AppleEvent 已超时 (-1712)`。**不是** PowerPoint 里有模态弹窗（2026-09-12 实测查实）。
处理掉屏幕上其他系统弹窗，重跑一次，看到「豆包工作想要控制 Microsoft PowerPoint」时点「允许」。
`-1743` 是同一件事的另一面：框弹过、被点了拒绝，去 系统设置 → 隐私与安全性 → 自动化 里打开。
现在这两种情况 `run.mjs` 都会在预检阶段就拦下来，退出码 3、最后一行 `失败：需要授权 —— …`。
预检还会把第三种分出去：探针报 `-1728` = **本机没装桌面版 PowerPoint**，退出码 4、
最后一行 `失败：没装 PowerPoint —— …`。以前这种也套授权判词，用户被引去找一个永远不会
出现的授权框，回「重试」无限循环。
**预检通过之后**画到一半又 -1712，判词会多补半句：那时授权已经证明给过了，
更可能是 PowerPoint 自己压着一个模态窗（登录/激活、恢复文档、另存冲突）。

**画完了却卡在保存 / 弹出「授予文件访问权限」对话框**
PowerPoint 是沙盒 App。保存位置**不在桌面 / 文稿 / 下载**时，它可能弹一个
「授予文件访问权限：Microsoft PowerPoint 需要访问名为 X 的文件夹」的系统对话框；
框挂在那儿等人点，`save` 那条 Apple event 就干等到系统两分钟上限报 -1712
（2026-09-12 实测：20 步 26 个形状全画进去了，只有保存这一步挂住）。
**在框里点「选择…」授予一次即可**，或者干脆改存桌面。授予过的文件夹之后不再问。
这种情况 `run.mjs` 给的是退出码 5、最后一行 `失败：PowerPoint 无响应 —— …`，
判词里会写明卡在「绘制」还是「保存」——**不要**再去点自动化授权框，那个框这一轮已经过了。
落在系统临时目录（`/tmp`、`/var/folders`）的路径直接被落点护栏拒掉，压根走不到这一步。

**画到一半停了**
`draw.mjs` 会把 osascript 最后 20 行输出带在错误里，面板上也会显示。
加 `--keep-script` 重跑一次，拿到生成的 `.applescript` 就能定位到具体是哪一步。

## 这一版不做的事

- **图标不画。** PowerPoint 的 AppleScript 字典里没有 `build freeform` / `add nodes`，
  SVG 图标拆成自由形之后没有办法逐点建出来。带图标的节点会在事件里记一条
  `skipped:"icon"`，卡片和文字照画。要图标就用 skill 的 `导出 PPTX`（那条路是直接写
  OOXML，图标是真矢量）。
- **折线的圆角拐点退化成直角。** 同样是因为只能用多段直线拼折线。
- **中文字体控不住。** `east asian name` 设了等于没设（读回来是主题默认字体），
  所以这一版干脆不设字体，跟 PowerPoint 主题走。视觉上正常，只是精确控不了。
- **进入动画是尽力而为。** 加得上就每个形状一条「出现」（`after previous`），
  加不上就跳过，并在 `phase:done` 里报 `animation:false`。**绝不因为动画失败让绘制失败。**
  代价是每个形状多一次 Apple event，实测只多约 0.7s（见下）。

## 速度

实测 `diagram.json`（34 步 / 46 个形状），**PowerPoint 已经在跑**的情况下，各测两次：

| 设置 | 耗时 |
|---|---|
| `--delay 0 --no-animation` | 11.9s / 11.9s |
| `--delay 0` | 12.6s / 12.6s |
| `--delay 400` | 25.9s（= 上面那条 + 34×0.4s 的延时） |

**PowerPoint 冷启动那一次要多花 15～20 秒**（App 起来 + 建第一份文档）。
第一次跑觉得慢是这个原因，不是画得慢 —— 第二次就回到上表。

延时是**给人看的**，技术上不需要。要演示留 400，要出片设 0。
动画那 0.7s 不值得省，除非你确实不要动画。
