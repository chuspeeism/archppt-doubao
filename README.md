# Arch Diagram Live —— 为豆包定制的 PPT 架构图 Skill

这是一个为**豆包**定制的 Skill。用自然语言描述你的系统，豆包就能梳理模块、分组和连接关系，生成**可编辑的 PowerPoint 架构图**。

跟豆包说一句「把我们这套系统画成架构图 PPT」，即可获得保存在桌面的 `.pptx` 文件和文件路径。

**架构图中的文字、形状和连线均为 PowerPoint 原生图元**，可以继续修改，方便用于方案评审、技术文档和培训材料。

## 前提

| 要求 | 说明 |
|---|---|
| macOS 或 Windows | 在本机安装和使用 |
| 桌面版 Microsoft PowerPoint | 需要已安装并激活的桌面版 Microsoft PowerPoint |
| 先手动开一次 PowerPoint | 首次使用前自己打开一次，完成登录激活、关掉「新增功能」之类的提示窗，再用这个技能 |
| 豆包工作（DoubaoWork） | 技能装在它的用户技能目录里 |
| Node.js 18+ | 若当前环境找不到 `node` 命令，请从 [Node.js 官网](https://nodejs.org/)安装 LTS 版本 |

## 安装（三步）

**第一步**：把本仓库放进豆包的用户技能目录，目录名必须是 `arch-diagram-live`。

macOS：

```bash
git clone https://github.com/chuspeeism/archppt-doubao.git \
  ~/Library/Application\ Support/DoubaoWork/Default/.doubaowork/agent_mode/workspace/.user_skills/arch-diagram-live
```

Windows（PowerShell）：先找到豆包工作的 `.user_skills` 目录。

```powershell
Get-ChildItem -Path $env:LOCALAPPDATA,$env:APPDATA,$env:USERPROFILE -Recurse -Depth 6 -Filter ".user_skills" -Directory -ErrorAction SilentlyContinue
```

将下面的占位路径替换为实际找到的豆包技能目录，再执行：

```powershell
git clone https://github.com/chuspeeism/archppt-doubao.git "C:\替换为实际路径\.user_skills\arch-diagram-live"
```

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

选择风格后，豆包会生成架构图并保存为 `.pptx`，完成后回复文件路径。打开文件即可继续编辑。

**想换个配色，直接说一句「换成 handbook 皮肤」就行**——不用重新描述系统，
豆包会基于原有架构生成新的配色版本，另存成一个新文件，保留原文件。

**macOS 上第一次跑会弹一个系统授权框**：「**豆包工作**想要控制 Microsoft PowerPoint」——**点允许**。
点了拒绝就画不了，要去「系统设置 → 隐私与安全性 → 自动化」里把它打开。

Windows 上若 PowerPoint 提示登录、激活、恢复文档或另存冲突，先处理提示，再回复「重试」。

生成期间请保持 PowerPoint 在前台，避免操作，以免影响任务执行。

## 出问题了看这张表

下面这张表是 **macOS** 的。Windows 上的对照：`失败：PowerPoint 未就绪 —— …`（Windows 没有
「需要授权」这一行）意思是 PowerPoint 前台压着对话框，切过去处理掉再回复「重试」；
`失败：没装 PowerPoint —— …` 和 `失败：PowerPoint 无响应 —— …` 两边同义；
命令跑不起来、提示找不到 `node`，就去 [Node.js 官网](https://nodejs.org/)安装 LTS 版本。

| 现象 | 多半是什么 | 怎么办 |
|---|---|---|
| 回复里是 `失败：需要授权 —— PowerPoint 没有响应…` | 授权还没点 | 按那句话做：点「允许」，然后回复「重试」 |
| 报 `-1712`，并提示「PowerPoint 没有响应」 | 授权尚未完成，或授权框被其他系统弹窗挡住 | 先处理其他系统弹窗；看到「豆包工作想要控制 Microsoft PowerPoint」时点「允许」，然后回复「重试」 |
| 报 `-1743` | 授权框弹过，被点了「不允许」 | 系统设置 → 隐私与安全性 → 自动化 → 豆包工作 → 勾上 Microsoft PowerPoint |
| 回复里是 `失败：没装 PowerPoint —— …` | 本机没有桌面版 PowerPoint（只装了网页版 / Keynote / WPS） | 装桌面版 Microsoft PowerPoint for Mac。**这条跟授权无关**，自动化列表里不会有 PowerPoint 可勾 |
| 回复里是 `失败：PowerPoint 无响应 —— …`，或文件未能保存 | PowerPoint 有等待处理的对话框，例如「授予文件访问权限」 | 切到 PowerPoint 处理提示；如需文件夹权限，点「选择…」授权，或改存到桌面，然后回复「重试」 |
| `/` 列表里找不到这个技能 | 装完没重启豆包，或目录名不对 | 目录名必须是 `arch-diagram-live`，然后完全退出并重开豆包工作 |

**遇到 `-1712`，可根据报错文字处理：**

- 「**PowerPoint 没有响应**（-1712）」：先完成 macOS 自动化授权，看到「豆包工作想要控制
  Microsoft PowerPoint」时点「允许」，再回复「重试」。
- 「**PowerPoint 在绘制/保存时没有响应**（-1712）」：查看 PowerPoint 是否有等待处理的对话框，
  例如文件访问权限、登录激活或恢复文档提示，处理后回复「重试」。

## 关于这个仓库

本仓库是**分发产物**，由开发仓投影生成，请不要直接在这里提交改动——下次发布会被覆盖。

图标来自第三方，许可与义务见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)（仅收录 CC0-1.0 与 ISC）。
