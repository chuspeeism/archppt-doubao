# 步骤面板事件契约

面板**只依赖这份契约**，不读 spec、不读 pptx、不认识引擎。换皮的人改样式不改钩子。

事件落在一个文件里：`shells/doubao/runner/.state/steps.jsonl`（可用 `draw.mjs --events` 改）。
**一行一个 JSON，UTF-8，追加写**。谁先写谁先出现，顺序就是真实发生的顺序。

## 事件全集

```jsonc
{"ts":"<ISO>","type":"phase","phase":"waiting"}
{"ts":"<ISO>","type":"phase","phase":"received","title":"AI Agent 产品架构","nodes":14,"edges":9,"slides":1,"specPath":"/abs/path"}
{"ts":"<ISO>","type":"phase","phase":"layout","total":27,"byKind":{"title":1,"subtitle":1,"container":3,"node":14,"edge":9,"label":1},"slides":1}
{"ts":"<ISO>","type":"phase","phase":"auth","platform":"darwin"}
{"ts":"<ISO>","type":"phase","phase":"slide","slide":2,"slides":3,"title":"数据链路"}
{"ts":"<ISO>","type":"step","i":1,"total":27,"kind":"node","id":"gateway","label":"API 网关","status":"start","slide":1,"slides":1}
{"ts":"<ISO>","type":"step","i":1,"total":27,"kind":"node","id":"gateway","label":"API 网关","status":"done","ms":163,"slide":1,"slides":1}
{"ts":"<ISO>","type":"phase","phase":"saving"}
{"ts":"<ISO>","type":"phase","phase":"done","file":"/Users/sunyi/Desktop/架构图-20260912-1030.pptx","shapes":27,"elapsedMs":9800,"animation":true,"slides":1}
{"ts":"<ISO>","type":"error","message":"…","step":12,"detail":"原始报错，可选"}
{"ts":"<ISO>","type":"log","level":"info","message":"…"}
```

`ts` 一律 ISO 8601（`new Date().toISOString()`）。

### type

| type | 什么时候写 | 谁写 |
|---|---|---|
| `phase` | 阶段切换 | `start.command`（waiting / received）、`draw.mjs`（layout / done）、驱动器（saving） |
| `step` | 每个图元画之前、画完各一条 | 驱动器（mac 是 `project/drivers/mac-powerpoint.mjs`，Windows 是 `project/drivers/win-powerpoint.mjs`；两边发的事件一模一样） |
| `error` | 出错，流程到此为止。`message` 是给人看的判词，`detail`（可选）放原始报错 | `draw.mjs` / `run.mjs` |
| `log` | 人话旁白，面板可以只显示最后一条 | 谁都可以写 |

### phase 的取值与顺序

`waiting` → `received` → `layout` → `auth` → （一串 step）→ `saving` → `done`

**一份 PPT 可以有多页**（多套架构图）。多页时每页的第一步之前多一条 `slide`：

`… → auth` → `slide`(1) → （第 1 页的 step）→ `slide`(2) → （第 2 页的 step）→ `saving` → `done`

中途可能直接跳到 `error`，那就没有后续 phase 了。

- `waiting`：面板起来了，正在等剪贴板里出现架构图 JSON。
- `received`：收到并且**校验通过**了一份 spec。带 `title` / `nodes` / `edges` / `slides` / `specPath`。
  多页时 `title` 是整套的名字（deck 没写就取第一页的标题），`nodes` / `edges` 是各页之和，
  `slides` 是页数（单页就是 1），`specPath` 是第一份 spec 的路径。
- `layout`：引擎算完布局，`total` 是总步数 —— 进度条的分母从这里来。
  `byKind` 是**按 kind 分的步数**，面板底部「容器 0/3　节点 0/14　连线 0/9　标签 0/1」
  那一行的分母。只列**这一份图里真出现过的 kind**（没有容器的图就没有 `container` 这一项），
  各项之和 === `total`。写它的是 `draw.mjs`，值直接取 `drawStepsSummary(steps).byKind`。
  **`byKind` 之前没有，面板拿不到分母就不显示那一行** —— 所以 `layout` 之前（等待、已收到）
  底部那行是空的，不许拿 spec 里的节点数去凑。
  多页时 `total` / `byKind` 都是**整份 PPT 的合计**（各页相加），另带一个 `slides` = 页数。
- `slide`：**翻到下一页了**，带 `slide`（第几页，1 起）、`slides`（共几页）、
  `title`（这一页的标题，可能是 null）。每页第一步之前发一条。
  **只有页数 ≥ 2 时才发** —— 单页的事件流里没有这一条，面板显示跟以前一模一样。
  它**不是一个版面**：折状态时只更新「画到第几页」，不许写进 `phase`
  （写进去面板会去找一个不存在的版面，整块空掉）。
- `auth`：**预检**——真画之前先用一条最小指令探 PowerPoint 有没有人应答。
  带一个字段 **`platform`**，取值只有 `"darwin"` 和 `"win32"`，它决定面板这一格说什么，
  因为两个平台在等的**根本不是同一件事**：
  - `darwin`：在等系统那个「豆包工作想要控制 Microsoft PowerPoint」的授权框。它被别的
    系统弹窗挡住时**不会出现**，指令就干等到超时（-1712）。面板显示
    「正在确认 PowerPoint 授权」+「若系统弹出授权框，请点「允许」」，
    不许再停在「布局完成」装作什么都没发生。
  - `win32`：**没有授权框这回事**（一个进程用 COM 驱动另一个不需要谁点允许，系统设置里
    也没有对应开关）。这一步只是在唤起 PowerPoint、看它应不应答，面板显示
    「正在唤起 PowerPoint」+「首次启动要等十几秒，不用点任何东西」。
    Windows 那一侧的任何文案里**都不许出现「授权」「允许」「系统设置」**——
    把人引去点一个不存在的框，他只会一直回「重试」。

  升级前录下来的老事件流没有 `platform`，折出来是 `null`，按 mac 那套文案显示。
  探不通就直接进 `error`，`message` 是那句固定判词，`detail` 里是原始报错。
- `saving`：所有图元画完，正在另存 pptx。**这一段挂住是有前科的**：PowerPoint 是沙盒 App，
  往它没被授权访问的目录保存时系统会弹「授予文件访问权限：Microsoft PowerPoint 需要访问
  名为 X 的文件夹」，框挂着没人点，Apple event 干等到系统两分钟上限报 -1712。
  这时候图**已经画完了**，所以判词和退出码都跟预检那条分开（退出码 5，见下表）。
- `done`：完事。`file` 是 pptx 的绝对路径，`shapes` 是幻灯片上真实的形状数
  （多页时是各页之和），`elapsedMs` 是驱动器从起到落的耗时，`animation` 是「进入动画
  有没有加上」（加不上不算失败，见 README 的「尽力而为」一节），`slides` 是页数。

### step

`kind` **取值固定为这六个**，面板不必兼容别的：

`title` / `subtitle` / `container` / `node` / `edge` / `label`

- `i` 从 1 起，`total` 与 `phase:layout` 的 `total` 一致。
  **多页时 `i` 是整份 PPT 的连续编号**（第 2 页的第一步不是 1，是第 1 页步数 + 1），
  重编号由驱动器做，每页自己的 steps 仍旧各自从 1 编号。
- `status` 只有 `start` 和 `done` 两种，成对出现。
- `ms` 只在 `done` 上有，是这一步实际花的毫秒。
- `id` 是图元在 spec 里的 id（标题/副标题固定是 `title` / `subtitle`）。
- `label` 是给人看的名字，可能是空串。
- `slide` 是这一步画在第几页（1 起），`slides` 是共几页。单页时恒为 1 / 1。

一个 `step` 不等于一个形状：一条边是一个 step，内部可能是三段线。
形状总数以 `phase:done` 的 `shapes` 为准。

## 写事件那一侧的退出码

`run.mjs` 的调用方（豆包）只看 stdout 最后一行，但退出码要分得清：

| 退出码 | 最后一行 | 什么意思 |
|---|---|---|
| 0 | `已保存：<pptx 绝对路径>` | 成功（`--dry-run` 是 `DRY-OK steps=n shapes=m`；多页是 `DRY-OK steps=n shapes=m slides=k`，多页时 `已保存：` 上面还有一行 `共 k 页`） |
| 2 | `失败：spec 校验失败：…` / `失败：slides[1]: spec 校验失败：…` / `失败：输出路径 … 不在你的用户目录下…` | spec 读不了、没过校验，或者 `--out` 落在 PowerPoint 沙盒写不进去的地方。多页时报错带 `slides[i]:` 前缀，i 从 0 起 |
| **3** | mac：`失败：需要授权 —— <判词>`；Windows：`失败：PowerPoint 未就绪 —— <判词>` | **PowerPoint 没应答**。mac 上是那个授权框没点掉：预检没过（一步都没画）的 -1712 / -1743，以及任何阶段的 -1743。Windows 上没有授权框，真凶是 PowerPoint 前台压着一个对话框（busy 码 `0x80010001` / `0x8001010A`，一步都没画时） |
| **4** | `失败：没装 PowerPoint —— <判词>` | **本机没有桌面版 PowerPoint**（预检报 `-1728`）。跟 3 分开是因为那个授权框根本不存在 |
| **5** | `失败：PowerPoint 无响应 —— <判词>` | **已经画起来之后**（收到过 `@@STEP … done` 或进了 `@@PHASE saving`）再撞上 -1712：PowerPoint 前台压着一个对话框（最常见的是保存时的「授予文件访问权限」）。已画好的内容还在 PowerPoint 里 |
| 1 | `失败：<原因>` | 其它 |

**上面这张表写的是 macOS 的判词。Windows 上 3 的措辞不一样**（`失败：PowerPoint 未就绪 —— …`，
含义是「PowerPoint 前台压着一个对话框」），4 和 5 两边同义、措辞已经对齐。
Windows 的错误码是 HRESULT 而不是 AppleEvent 码：`0x80040154` → 4，
`0x80010001` / `0x8001010A` 一步都没画 → 3、画起来之后 → 5，
`0x80010108` / `0x800706BA` / `0x800706BE`（PowerPoint 进程没了）→ 1。

3、4、5 单列，是因为这三条的解法跟别的失败完全不同，也跟彼此完全不同：
3 是去点「豆包工作想要控制 Microsoft PowerPoint」那个框（Windows 上改成去处理掉
PowerPoint 前台压着的对话框）；4 是去装桌面版 PowerPoint
（系统设置的自动化列表里根本不会出现它）；5 是去 PowerPoint 窗口把压着的对话框点掉
（图已经画好了，重试只是重新保存一次）。三条都不用改 spec、不用看日志。

**3 和 5 的分界线就是「有没有画起来」**：一步都没画的 -1712 = 授权没给；
画起来之后的 -1712 = 前台压着对话框。以前两种都套授权判词，于是「26 个形状全画完、
卡在保存」的人被告知「第一次使用需要在授权框里点允许」——能画 26 个形状就说明授权
早就有了（2026-09-12 实测查实）。

## 面板的 DOM 钩子

`index.html` 里这六个 id 是**约定**，换皮只改样式和结构，不要改 id：

| id | 放什么 |
|---|---|
| `#phase` | 当前阶段的人话（等待 / 已收到 / 绘制中 / 保存中 / 完成 / 出错） |
| `#progress` | 进度，形如 `12 / 34` |
| `#current` | 正在画的那一步（kind + label） |
| `#done-list` | 已完成步骤的列表容器，每项一个子元素 |
| `#result` | 完成后的结果：pptx 路径、形状数、耗时。没结果时应当是空的 |
| `#error` | 出错信息；没出错时应当是空的 |

文件名和路径**一律从 `phase:done` 的 `file` 里拆**（basename 当文件名、dirname 当路径），
不许写死一个示例路径。

面板页还认两个地址栏参数（不进契约，改皮的人可以自己定）：
`?layout=tall|wide` 强制版式（默认按视口高宽比，高/宽 > 1.2 走 640×1080 的竖长版），
`?demo=1` 不连 SSE、页内自动播放一遍，用于录屏彩排和对设计稿。

## 面板服务的三个口

`shells/doubao/runner/panel/server.mjs`，默认端口 **7431**。

| 路由 | 返回 |
|---|---|
| `GET /` | `index.html` |
| `GET /panel.css`、`GET /panel.js` | 面板页拆出来的样式与脚本（白名单点名，不做目录遍历） |
| `GET /events` | SSE。**先把 `steps.jsonl` 已有的行整个回放一遍**，再 tail 新行。每行一个 `data:` |
| `GET /state` | 按本契约折叠出的当前状态快照（JSON），刷新页面不丢状态 |

起服务时加 `--replay-ms <毫秒>`，`/events` 就把**已有的行**按这个间隔一行一行喂出去
（喂完照常 tail 新行），用来把一份录好的事件文件当录像带放。默认 0 = 一次倒完，真实运行用这个。

`/state` 的形状：

```jsonc
{
  "phase": "drawing",              // waiting|received|layout|auth|drawing|saving|done|error
  "title": "AI Agent 产品架构",
  "specPath": "/abs/path",
  "nodes": 14, "edges": 9,
  "total": 34,
  "byKind": { "title":1, "subtitle":1, "container":4, "node":10, "edge":9, "label":9 },
  "slides": 3,                     // 共几页（单页 spec 也会写 1）
  "slide": 2,                      // 画到第几页
  "slideTitle": "数据链路",         // 这一页的标题
  "platform": "darwin",            // 'darwin' | 'win32'，来自 phase:auth；老事件流是 null
  "current": { "i": 12, "kind": "node", "id": "gateway", "label": "API 网关" },
  "done":    [ { "i": 1, "kind": "title", "id": "title", "label": "…", "ms": 120, "slide": 1 } ],
  "result":  { "file": "…", "shapes": 46, "elapsedMs": 9800, "animation": true },
  "error":   null,
  "log":     "布局好了：34 步 / 46 个形状"
}
```

`phase` 里多出来的 `drawing` 是**折叠出来的**，不是事件里的值：
见到第一条 `step` 就从 `layout` 进 `drawing`。

`slides` / `slide` / `slideTitle` 没收到过对应事件时是 `null`。面板只在 `slides > 1` 时
才显示「第 2/3 页 · <本页标题>」和已完成列表里的翻页分隔项 —— 单页界面跟以前一模一样。
