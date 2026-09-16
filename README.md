# Arch Diagram Live —— 豆包技能：架构图直接画进 PowerPoint

跟豆包说一句「把我们这套系统画成架构图 PPT」，它就会：

1. 把你描述的系统整理成一份架构图语义 JSON（哪些模块、怎么分层、谁连谁）；
2. 自己调起本机的 Microsoft PowerPoint，**一个图元一个图元地画出来**，
   旁边浏览器里还有个面板同步显示画到第几步；
3. 画完存成 `.pptx` 放到桌面，把文件路径回给你。

全程不需要你复制粘贴、不需要你点任何按钮。**画出来的每个形状都是真 PowerPoint 图元，可以继续编辑。**

## 前提

| 要求 | 说明 |
|---|---|
| macOS 或 Windows | macOS 走 AppleScript，Windows 走 PowerShell + COM。**Windows 那条还没在真机上跑过**，见「已知限制」 |
| 桌面版 Microsoft PowerPoint | mac 实测 16.112.4。**必须是桌面版**，Microsoft 365 网页版、Keynote、WPS 都不行 |
| 先手动开一次 PowerPoint | 首次使用前自己打开一次，完成登录激活、关掉「新增功能」之类的提示窗，再用这个技能 |
| 豆包工作（DoubaoWork） | 技能装在它的用户技能目录里 |
| Node 18+ | macOS 上**豆包自带**（实测 v22）。**Windows 上不保证自带**，`node -v` 没反应就去 nodejs.org 装一个 LTS。零 npm 依赖，只用标准库 |

## 安装（三步）

**第一步**：把本仓库放进豆包的用户技能目录，目录名必须是 `arch-diagram-live`。

macOS：

```bash
git clone https://github.com/chuspeeism/archppt-doubao.git \
  ~/Library/Application\ Support/DoubaoWork/Default/.doubaowork/agent_mode/workspace/.user_skills/arch-diagram-live
```

Windows（PowerShell，**目录是推测值**，见下）：

```powershell
git clone https://github.com/chuspeeism/archppt-doubao.git "$env:LOCALAPPDATA\DoubaoWork\User Data\Default\.doubaowork\agent_mode\workspace\.user_skills\arch-diagram-live"
```

> Windows 版豆包工作的技能目录官方没公开，上面那条是推测的。装完 `/` 列表里没出现的话，
> 先自己找一下真正的 `.user_skills` 在哪，再往里放：
>
> ```powershell
> Get-ChildItem -Path $env:LOCALAPPDATA,$env:APPDATA,$env:USERPROFILE -Recurse -Depth 6 -Filter ".user_skills" -Directory -ErrorAction SilentlyContinue
> ```

下 zip 的话，解压后把文件夹**改名成 `arch-diagram-live`**再放进上面那个目录
（目录名要跟 `SKILL.md` 里的 `name` 一字不差，否则豆包找不到它）。

**第二步**：**完全退出并重开豆包工作**。技能是启动时扫目录发现的，不重启不会出现。

**第三步**：在对话框里输入 `/`，选 **Arch Diagram Live**，**在同一条消息里**接着描述你的系统。

> 技能必须和问题写在同一条消息里。先单发技能、下一条再问，技能正文不生效。

## 用起来长什么样

```
/ Arch Diagram Live
我们的订单系统：App 和小程序走 API 网关，后面是订单、支付、库存三个服务，
订单写 MySQL，支付走 Kafka 异步通知库存，全链路上报到监控。画一张架构图。
```

**豆包会先问你要哪款皮肤**——`stratum`（默认，技术文档）/ `handbook`（讲义培训）/
`journal`（论文白皮书）/ `source`（README、工程风）四选一，回一句「默认」也行；
你答完它才开始生成。

接着豆包会回一句「架构描述已生成，开始在 PowerPoint 里逐步绘制」并贴出 JSON，
然后 PowerPoint 被拉到前台开始画，**半分钟到一分钟**后回你一行 `已保存：/Users/…/架构图-….pptx`
（画完之后面板上的完成态还会亮 20 秒才返回，这段也算在内）。

**画完想换个配色，直接说一句「换成 handbook 皮肤」就行**——不用重新描述系统、不用重新生成 JSON，
它拿刚才那份架构图换一款皮肤从头重画一遍，另存成一个新文件，原来那份不动（时间跟第一次差不多）。

**macOS 上第一次跑会弹一个系统授权框**：「**豆包工作**想要控制 Microsoft PowerPoint」——**点允许**。
点了拒绝就画不了，要去「系统设置 → 隐私与安全性 → 自动化」里把它打开。
真正开画之前技能会先确认一次 PowerPoint 有没有响应，面板上写着「正在确认 PowerPoint 授权」，
这时候就是在等你点那个框。PowerPoint 冷启动的那一次会比后面慢 20 秒左右，属正常。

**Windows 上没有这个授权框**——一个程序驱动 PowerPoint 不需要谁点允许，系统设置里也没有
对应的开关。同一步在面板上写的是「正在唤起 PowerPoint」，你什么都不用点，等着就行。
那边「PowerPoint 不应答」只有一种原因：**它前台压着一个对话框**（首次启动的登录/激活、
恢复文档、另存冲突），切过去处理掉再回复「重试」。

画的过程中**别动鼠标**，PowerPoint 需要保持在前台。

## 出问题了看这张表

下面这张表是 **macOS** 的。Windows 上的对照：`失败：PowerPoint 未就绪 —— …`（Windows 没有
「需要授权」这一行）意思是 PowerPoint 前台压着对话框，切过去处理掉再回复「重试」；
`失败：没装 PowerPoint —— …` 和 `失败：PowerPoint 无响应 —— …` 两边同义；
命令跑不起来、提示找不到 `node`，就去 nodejs.org 装一个 Node.js LTS。

| 现象 | 多半是什么 | 怎么办 |
|---|---|---|
| 回复里是 `失败：需要授权 —— PowerPoint 没有响应…` | 授权还没点 | 按那句话做：点「允许」，然后回复「重试」 |
| 报 `-1712`，或者面板停在「布局完成」不动 | **授权框没弹出来，或被别的系统弹窗挡住了** —— 同一时间 macOS 只显示一个授权框 | 先把屏幕上其他系统弹窗处理掉，再回复「重试」；看到「豆包工作想要控制 Microsoft PowerPoint」时点「允许」 |
| 报 `-1743` | 授权框弹过，被点了「不允许」 | 系统设置 → 隐私与安全性 → 自动化 → 豆包工作 → 勾上 Microsoft PowerPoint |
| 回复里是 `失败：没装 PowerPoint —— …` | 本机没有桌面版 PowerPoint（只装了网页版 / Keynote / WPS） | 装桌面版 Microsoft PowerPoint for Mac。**这条跟授权无关**，自动化列表里不会有 PowerPoint 可勾 |
| 回复里是 `失败：PowerPoint 无响应 —— …`，或者形状都画出来了、卡在保存 | PowerPoint 前台压着一个对话框在等人点。最常见的是「**授予文件访问权限**：Microsoft PowerPoint 需要访问名为 X 的文件夹」——**保存位置不在桌面 / 文稿 / 下载时就可能出现**（PowerPoint 是沙盒 App） | 切到 PowerPoint 窗口，在框里点「**选择…**」授予一次（同一个文件夹以后不再问），或者干脆改存到桌面；然后回复「重试」。**已经画好的内容还在，不会丢**，也不用重新生成 JSON |
| `/` 列表里找不到这个技能 | 装完没重启豆包，或目录名不对 | 目录名必须是 `arch-diagram-live`，然后完全退出并重开豆包工作 |

**`-1712` 分两种，看判词第一句就能分清（2026-09-12 两次实测各踩一遍）：**

- 「**PowerPoint 没有响应**（-1712）」= **一个图元都没画**，那次自动化授权还没点掉，
  框可能被屏幕上别的系统弹窗挡住了。先把那些框处理掉，看到「豆包工作想要控制
  Microsoft PowerPoint」时点「允许」，再回复「重试」。**不要重装 Office。**
- 「**PowerPoint 在绘制/保存时没有响应**（-1712）」= 图**已经画进去了**，卡在中途或保存。
  这时候授权早就有了，去看 PowerPoint 窗口压着什么对话框（「授予文件访问权限」、
  首次启动的登录/激活提示、恢复文档提示），点掉再回复「重试」。

## 怎么验收

想确认这台机器上到底能不能用（尤其是 Windows —— 那条链还没在真机上跑过），
**不用一条条手工比对，跑这一条命令就行**：

macOS：

```bash
node ~/Library/Application\ Support/DoubaoWork/Default/.doubaowork/agent_mode/workspace/.user_skills/arch-diagram-live/runner/verify.mjs
```

Windows（PowerShell，路径按你实际装的位置改）：

```powershell
node "$env:APPDATA\DoubaoWork\...\.user_skills\arch-diagram-live\runner\verify.mjs"
```

它会自己跑完：算一遍布局 → 在 PowerPoint 里真画一页 → 再画一份两页的 → 解开 pptx
逐页数形状、对标题 → 写报告 → 把全部证据打成一个 zip。
**跑的时候 PowerPoint 会被拉到前台一两分钟，同时每 0.5 秒截一张屏**——别去动鼠标键盘。

跑完 stdout 的**最后两行**就是结论：

```
结论：通过
验收包：/Users/你/Desktop/架构图验收-macOS-20260913-041500.zip
```

把那个 zip 发回来就行，里面有：

| 文件 | 是什么 |
|---|---|
| `验收报告.md` | 开头一段直接回答两个问题：**能跑通吗**、**能看见它在 PowerPoint 里一个一个画吗** |
| `shots-single/` `shots-deck/` | 屏幕连拍。翻中间几张，能看见 PowerPoint 里图只画了一半 |
| `架构图验收-单页.pptx` `架构图验收-两页.pptx` | 真画出来的成品，可以直接打开继续编辑 |
| `steps-*.jsonl` | 每一步的开始/结束事件和耗时（「逐个画」的机器证据） |
| `env.json` | 环境快照 |

**失败也会出包**（退出码 1），报告里写清卡在哪一步、原始报错是什么 —— 照样发回来即可。

第一页画的是 verify.mjs 自带的示例架构图（技能包里不带 `diagram.json`），那份 spec 也会一并写进证据目录，想换成自己的图就加 `--spec <你的.json>`。

常用参数：`--quick` 跳过两页那一步（快一半）、`--delay 600` 画慢一点更好看清、
`--out-dir <目录>` 换个落点（**得在桌面/文稿/下载底下**，PowerPoint 沙盒只对这几处默认放行）。

## 已知限制

- **Windows 那条链还没在真机上跑过。** 代码写完了、在 macOS 上按 Windows 分支测过一整轮
  （用假的 PowerShell 喂事件），但**一次都没发给过真的 Windows PowerPoint**。
  第一次用碰到怪事请回报：卡片圆角、中文乱码、连线方向、形状数对不对。
- **图标不画。** PowerPoint 的 AppleScript 接口建不出自由形，SVG 图标没法逐点画出来。
  卡片和文字照画，带图标的节点只是少个图标。
- **折线的圆角拐点退化成直角。** 同样是因为只能用多段直线拼折线。
- **中文字体跟 PowerPoint 主题走**，控不了。视觉上正常，只是精确指定不了字体。

## 目录里都是什么

```
SKILL.md        豆包读的技能正文（它照这个走）
runner/         绘制器：run.mjs 一条命令跑完全程，panel/ 是步骤面板
                verify.mjs 是验收包：一条命令跑完 + 连拍屏幕 + 打成 zip（见「怎么验收」）
project/        排版引擎（算布局、配色、连线），无第三方依赖
version.json    版本号
```

`runner/.state/` 是运行时产生的本地状态（写进来的 JSON、事件流），可以随便删。

## 关于这个仓库

本仓库是**分发产物**，由开发仓投影生成，请不要直接在这里提交改动——下次发布会被覆盖。

图标来自第三方，许可与义务见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)（仅收录 CC0-1.0 与 ISC）。
