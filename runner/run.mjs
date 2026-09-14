#!/usr/bin/env node
// run.mjs —— 豆包只跑这一条命令。
//
// 一句话：给它一份架构图语义 JSON，它把「起面板 → 打开浏览器 → 在 PowerPoint 里逐个画
// → 存 pptx → 报路径」整条链跑完，**不需要人碰任何东西**。
//
//   起面板服务（端口被占就复用已在跑的那个）
//     → open http://localhost:<port>
//     → phase:received（标题、节点数、边数、spec 路径）
//     → 读 + 校验 + 算布局（draw.mjs 的 buildPlan）
//     → phase:auth：拿一条最小指令探 PowerPoint 有没有人应答（授权预检）
//     → 驱动 PowerPoint 逐个画（draw.mjs 的 runDrawPlan）
//     → 完成态在面板上停 --keep-panel 秒
//     → stdout 最后一行固定是「已保存：<pptx 绝对路径>」
//
// 用法：
//   node run.mjs <spec.json> [<spec2.json> …] [--delay 350] [--out <pptx>] [--port 7431]
//                            [--no-open] [--keep-panel 20] [--dry-run]
//                            [--skin <id>] [--window left,top,width,height]
//
// **一份 PPT 可以有多套架构图**（deck）。两种写法：
//   ① 一份 deck 文件：`{ "title": "整套的名字", "slides": [ 单图 spec, 单图 spec ] }`
//   ② 多个位置参数：`node run.mjs a.json b.json` —— 顺序就是页序。
// 没有 slides 的单图 spec 行为一个字都不变；deck 时 stdout 倒数第二行多打一句「共 k 页」。
//
// | 参数 | 默认 | 说明 |
// |---|---|---|
// | `--delay <毫秒>` | 350 | 每步之后停多久，给人看；出片设 0 |
// | `--out <pptx>` | `~/Desktop/架构图-YYYYMMDD-HHmmss.pptx` | 另存路径；不给时同名自动加 -2 / -3，不覆盖 |
// | `--port <端口>` | 7431 | 面板端口；已被占用就当作「上一次的面板还在跑」直接复用 |
// | `--no-open` | 关 | 不自动打开浏览器 |
// | `--keep-panel <秒>` | 20 | 画完之后面板再留多久（让完成态停一会儿）。失败时不等 |
// | `--dry-run` | 关 | 只走校验 + 布局 + 指令流，不起面板、不碰 PowerPoint |
// | `--events <jsonl>` | `<本目录>/.state/steps.jsonl` | 事件流落盘位置 |
// | `--skin <id>` | 不给 | **覆盖每一页**的皮肤，用来「同一份 JSON 换个皮肤再画一遍」。id 不在 14 套里 = 退出码 2 |
// | `--window <l,t,w,h>` | 不给 | 把 PowerPoint 窗口摆到这个矩形（屏幕点、原点左上）。**只在 macOS 生效**，演示模式用 |
// | `--no-activate` / `--no-animation` / `--keep-script` | 关 | 同 draw.mjs |
//
// 退出码 0 = 成功，stdout 最后一行 `已保存：<绝对路径>`（`--dry-run` 是 `DRY-OK steps=n shapes=m`，
// deck 是 `DRY-OK steps=n shapes=m slides=k`，n / m 都是全 deck 之和）。
// 非 0 = 失败，stdout 最后一行 `失败：<原因>`。调用方只看最后一行就够了。
//
// **两个平台**：macOS 走 AppleScript 驱动器，Windows 走 PowerShell + COM 驱动器
// （draw.mjs 的 PLATFORM 决定）。事件流、退出码、「最后一行」的契约两边完全一致，
// 只有退出码 3 那一行的措辞分平台 —— Windows 上没有自动化授权框这回事，见下。
//
// 四个退出码单独表示四件「解法完全不同」的事，别的失败要改 spec 或查日志，这几条不用：
//   3 = **PowerPoint 没应答**。mac：要人去点授权框，最后一行 `失败：需要授权 —— <判词>`
//       （预检阶段、一步都没画时的 -1712/-1743，以及任何阶段的 -1743）。
//       Windows：没有授权框，真凶是 PowerPoint 前台压着一个对话框，
//       最后一行 `失败：PowerPoint 未就绪 —— <判词>`（busy 码 0x80010001 / 0x8001010A）
//   4 = **本机没装桌面版 PowerPoint**，最后一行 `失败：没装 PowerPoint —— <判词>`
//       （以前这一条被并进 3，用户被引去找一个永远不会出现的授权框，回「重试」无限循环）
//   5 = **画起来之后 PowerPoint 中途没应答**，最后一行 `失败：PowerPoint 无响应 —— <判词>`
//       （收到过 `@@STEP … done` 或进了 `@@PHASE saving` 之后的 -1712。这时候自动化授权
//        早就证明有了，真凶是 PowerPoint 前台压着一个对话框 —— 保存到没被授权的目录时
//        弹的「授予文件访问权限」就是最常见的那一个。已画好的内容不会丢。）
//   6 = **本机连 PowerShell 都没有**（只有 Windows 会走到），最后一行
//       `失败：没有 PowerShell —— <判词>`。跟 PowerPoint 一点关系都没有：是壳自己起不来。
//       以前这一支被套上 busy 判词，用户被支使去 PowerPoint 里找一个不存在的对话框。
//
// 还有一条**不占新退出码、但结论行单列**的：PowerPoint 进程画到一半被关掉 / 崩了
// （`0x80010108` / `0x800706BA` / `0x800706BE`），退出码仍旧 1，最后一行
// `失败：PowerPoint 中途退出 —— <判词>`。套通用的「画的时候出错了：」前缀，
// 真正该做的事（先把 PowerPoint 重新打开）会被埋在一层没用的转述后面。
//
// `--out` 的落点有护栏（**只在 macOS**）：/tmp、/var/folders 这类系统临时目录，以及任何
// 不在用户主目录之下的路径，一开始就拒绝（退出码 2）—— PowerPoint 沙盒写不进去，画完
// 二三十秒才在保存那一步挂死太亏。落在主目录下但不在桌面/文稿/下载时只提示一句，照跑。
// Windows 版 PowerPoint 不是沙盒 App，那边不硬拒绝也不提示，只要求父目录建得出来。
//
// 默认落点是「桌面」：Windows 上桌面常被 OneDrive 重定向，依次试
// `~/Desktop` → `~/OneDrive/Desktop` → `~/OneDrive/桌面`，都没有就落主目录。
//
// 「最后一行」是硬契约：`失败：` 那一行永远只有一行。绘制阶段的原始 osascript 堆栈是
// 多行的，进 stdout 前会被压成一行（完整文本留在事件流的 detail 里）。

import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RUNNER_DIR, DEFAULT_EVENTS, defaultOut, countNodes,
  makeWriter, readAndValidateSpec, buildPlan, runDrawPlan, uniqueOut,
  powerPointAuthMessage, noResponseCode,
  powerPointMissingMessage, missingPowerPointCode,
  powerShellMissingMessage, NO_POWERSHELL_CODE,
  checkOutPath, DRIVER_PLATFORM, probePowerPoint as driverProbePowerPoint,
  applySkin, parseWindowBounds, WINDOW_ARG_ERROR,
} from './draw.mjs';
import { createPanelServer } from './panel/server.mjs';

const USAGE = `用法: node run.mjs <spec.json> [<spec2.json> …] [--delay 350] [--out <pptx>]
                          [--port 7431] [--no-open] [--keep-panel 20] [--dry-run]
                          [--skin <id>] [--window left,top,width,height]

多个 spec = 一份多页 PPT（顺序按参数顺序）；一份顶层带 slides 数组的 deck 文件同理。

--skin <id>          覆盖**每一页**的皮肤（不改 spec 文件），用来「同一份 JSON 换个皮肤再画一遍」。
                     id 不在 14 套里 = 退出码 2，最后一行「失败：spec 校验失败：皮肤 … 不存在」。
--window l,t,w,h     把 PowerPoint 窗口摆到这个矩形（屏幕点、原点左上）。**只在 macOS 生效**，
                     演示模式用；摆不动只在面板上记一条 warn，绝不让绘制失败。

成功: 退出码 0，最后一行「已保存：<pptx 绝对路径>」（多页时上一行还有「共 k 页」）
失败: 退出码非 0，最后一行「失败：<原因>」（永远只有一行）
      退出码 2 也管 --out 落点不合法（沙盒写不进去的目录）
      退出码 3 专表「PowerPoint 没应答」，最后一行 mac 是「失败：需要授权 —— …」，
             Windows 是「失败：PowerPoint 未就绪 —— …」（那边没有授权框）
      退出码 4 专表「本机没装桌面版 PowerPoint」，最后一行「失败：没装 PowerPoint —— …」
      退出码 5 专表「画起来之后 PowerPoint 中途无响应」，最后一行「失败：PowerPoint 无响应 —— …」
      退出码 6 专表「本机连 PowerShell 都没有」（只有 Windows 会走到），
             最后一行「失败：没有 PowerShell —— …」
      PowerPoint 画到一半被关掉 / 崩了仍是退出码 1，最后一行「失败：PowerPoint 中途退出 —— …」`;

function parseArgs(argv) {
  const opts = {
    specs: [],
    delay: 350,
    out: null,
    port: 7431,
    open: true,
    keepPanel: 20,
    dryRun: false,
    events: DEFAULT_EVENTS,
    activate: true,
    animate: true,
    keepScript: false,
    skin: null,          // --skin：覆盖每一页的皮肤；null = 各页用自己 spec 里写的
    window: null,        // --window：{left, top, width, height}；null = 不动窗口
    probeCmd: null,      // 仅测试用的隐藏参数，见 --probe-cmd 那一支
    help: false,
  };
  const abs = (v) => (isAbsolute(v) ? v : resolve(process.cwd(), v));
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const inline = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : null;
    const key = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    const take = () => { if (inline != null) return inline; i += 1; return argv[i]; };
    switch (key) {
      case '--delay': opts.delay = Number(take()); break;
      case '--out': opts.out = abs(take()); break;
      case '--port': opts.port = Number(take()); break;
      case '--no-open': opts.open = false; break;
      case '--keep-panel': opts.keepPanel = Number(take()); break;
      case '--dry-run': opts.dryRun = true; break;
      case '--events': opts.events = abs(take()); break;
      case '--no-activate': opts.activate = false; break;
      case '--no-animation': opts.animate = false; break;
      case '--keep-script': opts.keepScript = true; break;
      case '--skin': opts.skin = take(); break;
      // 写错了走「未知参数」那一路（退出码 1）：这是人当场敲的参数，敲错了他要的是
      // 「你敲错了」，不是一张按默认几何画出来的图
      case '--window': {
        const bounds = parseWindowBounds(take());
        if (!bounds) throw new Error(WINDOW_ARG_ERROR);
        opts.window = bounds;
        break;
      }
      // 隐藏参数，只给测试用：把授权预检的探针换成任意一条 shell 命令（/bin/sh -c <它>），
      // 这样测「预检失败」不需要真去惹 PowerPoint。USAGE 里不列。
      case '--probe-cmd': opts.probeCmd = take(); break;
      // 同上，只给测试用：强行按 win32 / darwin 选驱动器与判词。真正生效是在 draw.mjs
      // 模块加载时扫 argv 完成的（驱动器是 top-level await import 的，等这里解析就晚了），
      // 这一支只负责别让它撞上「未知参数」。USAGE 里同样不列。
      case '--platform': take(); break;
      case '--help': case '-h': opts.help = true; break;
      default:
        if (key.startsWith('--')) throw new Error(`未知参数: ${arg}（用 --help 看用法）`);
        // 多个位置参数 = 一份多页 deck，顺序按参数顺序
        opts.specs.push(abs(arg));
    }
  }
  if (!Number.isFinite(opts.delay) || opts.delay < 0) throw new Error('--delay 必须是非负毫秒数');
  if (!Number.isFinite(opts.port) || opts.port < 1 || opts.port > 65535) throw new Error('--port 不合法');
  if (!Number.isFinite(opts.keepPanel) || opts.keepPanel < 0) throw new Error('--keep-panel 必须是非负秒数');
  return opts;
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** 收摊等多久算够。掐完连接还不回来就不等了，「失败：」那一行比面板收干净重要。 */
const CLOSE_PANEL_TIMEOUT_MS = 2000;

/**
 * 压成一行。stdout 的输出契约是「最后一行就是结论」，而绘制失败时驱动器给的
 * message 是多行的（`osascript 退出码 N` + 最多 20 行原始输出），直接打出去，
 * 最后一行就变成 AppleScript 的某句原始报错，调用方照契约抓到的是那一句。
 * 完整文本仍旧原样留在事件流的 detail 里，排错不丢东西。
 */
export const oneLine = (text) => String(text == null ? '' : text)
  .replace(/\s*[\r\n]+\s*/g, ' / ')
  .trim();

/**
 * 起面板。端口被占用**不算错误**——多半是上一次的面板还在跑，直接复用它
 * （事件文件是同一份，它会 tail 到这一轮的新行）。
 * @returns {Promise<{ server: import('node:http').Server|null, reused: boolean }>}
 */
function startPanel(port, events) {
  return new Promise((done) => {
    const server = createPanelServer({ events, replayMs: 0 });
    const onError = (error) => {
      server.removeListener('listening', onListening);
      if (error && error.code === 'EADDRINUSE') done({ server: null, reused: true });
      else done({ server: null, reused: false, error });
    };
    const onListening = () => {
      server.removeListener('error', onError);
      done({ server, reused: false });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

/**
 * 把面板拉到浏览器里。**打不开不算失败**，面板照样在跑（现有语义，别改）。
 *
 * Windows 那条是 `cmd /c start "" <url>`：`start` 的第一个带引号的参数会被当成**窗口标题**，
 * 不给这个空标题的话，URL 自己就变成标题、浏览器一个都不开。`windowsHide` 免得闪一个黑框。
 */
function openBrowser(url) {
  try {
    const child = DRIVER_PLATFORM === 'win32'
      ? spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true, windowsHide: true })
      : (process.platform === 'darwin'
        ? spawn('open', [url], { stdio: 'ignore', detached: true })
        : spawn('xdg-open', [url], { stdio: 'ignore', detached: true }));
    // ENOENT 是**异步**送来的：没有这一句，找不到 open / cmd / xdg-open 会变成
    // 未处理的 'error' 事件，把整条命令掀翻——而说好了「打不开浏览器不算失败」。
    child.on('error', () => {});
    child.unref();
  } catch { /* 同上 */ }
}

/* ── 授权预检 ──────────────────────────────────────────────────────────────
 * 2026-09-12 端到端实测踩的那一脚：豆包第一次驱动 PowerPoint，macOS 必须先弹一次
 * 「豆包工作想要控制 Microsoft PowerPoint」。那次它被另一个系统授权框挡住、**没能弹出来**，
 * 于是发给 PowerPoint 的指令干等到系统两分钟上限才报 -1712；面板停在「布局完成」一动不动，
 * 豆包把原因猜成「PowerPoint 有模态弹窗」——全错，而且没人看得出来。
 *
 * 所以真画之前先探一下：一条最小的、没有任何副作用的查询（get version）。
 * 它同样会触发那次授权框，区别是**它是我们等得起的那条指令**：25 秒不回就当没授权，
 * 直接给判词，而不是让人盯着不动的面板等两分钟。
 * 顺带的好处：PowerPoint 冷启动那 15–20 秒被挪到了这一步，面板上有话说。
 */
const PROBE_TIMEOUT_SEC = 25;
const PROBE_KILL_MS = (PROBE_TIMEOUT_SEC + 5) * 1000;  // 兜底：连 osascript 自己都不回来
const PROBE_ARGS = [
  '-e', `with timeout of ${PROBE_TIMEOUT_SEC} seconds`,
  '-e', 'tell application "Microsoft PowerPoint" to get version',
  '-e', 'end timeout',
];

/**
 * 探一下 PowerPoint 有没有人应答（**macOS 那条**）。**不抛异常**，结果自带判定。
 *
 * Windows 上这一步换成驱动器导出的 `probePowerPoint({ probeCmd })`（PowerShell + COM，
 * 同样的返回形状），见下面的 `probe`。那边没有授权框，这一步纯粹是「PowerPoint 起得来吗、
 * 它现在应答吗」，顺带把冷启动那十几秒挪到面板有话说的阶段。
 *
 * @param {string|null} probeCmd 仅测试用：给了就改跑 `/bin/sh -c <probeCmd>`
 * @returns {Promise<{ ok: boolean, code?: string, detail: string }>}
 *          code 是嵌进判词括号里的那个东西：`-1712` / `-1743` / `超时` / `无响应`
 */
function probePowerPointMac(probeCmd) {
  return new Promise((done) => {
    let child;
    try {
      child = probeCmd
        ? spawn('/bin/sh', ['-c', probeCmd], { stdio: ['ignore', 'pipe', 'pipe'] })
        : spawn('osascript', PROBE_ARGS, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_CTYPE: 'UTF-8' } });
    } catch (error) {
      done({ ok: false, code: '无响应', detail: `探针起不来：${error.message}` });
      return;
    }
    let out = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* 已经走了就算了 */ }
    }, PROBE_KILL_MS);
    const grab = (chunk) => { if (out.length < 4000) out += chunk; };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', grab);
    child.stderr.on('data', grab);
    child.on('error', (error) => {
      clearTimeout(timer);
      done({ ok: false, code: '无响应', detail: `探针起不来：${error.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const detail = out.trim();
      if (!timedOut && code === 0) { done({ ok: true, detail }); return; }
      // -1712 / -1743 原样带出来给判词用（认码的规矩只有驱动器那一份）；
      // 认不出码就按「超时 / 无响应」说
      done({
        ok: false,
        code: noResponseCode(detail) || (timedOut ? '超时' : '无响应'),
        detail: timedOut
          ? `探针等了 ${PROBE_KILL_MS / 1000} 秒还没回来，已强制结束${detail ? `：${detail}` : ''}`
          : `探针退出码 ${code}${detail ? `：${detail}` : ''}`,
      });
    });
  });
}

/** 按平台挑预检。两边返回同一个形状 `{ ok, code?, detail }`，`--probe-cmd` 两边都认。 */
const probe = (probeCmd) => (DRIVER_PLATFORM === 'win32'
  ? driverProbePowerPoint({ probeCmd })
  : probePowerPointMac(probeCmd));

/* Windows 上「PowerPoint 不应答」跟授权毫无关系（那边没有自动化授权框），所以结论行的
 * 前缀也得换：mac 是「需要授权」，Windows 是「PowerPoint 未就绪」。退出码仍旧是 3 ——
 * 调用方（豆包）靠退出码分诊，靠这一行的措辞告诉用户去干什么。 */
const AUTH_PREFIX = DRIVER_PLATFORM === 'win32' ? 'PowerPoint 未就绪' : '需要授权';

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.log(`失败：${error.message}`);
    return 1;
  }
  if (opts.help) { console.log(USAGE); return 0; }
  if (!opts.specs.length) { console.log(`失败：缺 spec.json（${USAGE.split('\n')[0]}）`); return 1; }

  // ── --out 落点护栏 ──────────────────────────────────────────────────────
  // 沙盒写不进去的地方一开始就拒绝，别等 20 步都画完了、卡在保存那一步等两分钟超时
  // （2026-09-12 实测就是这么挂的）。`--dry-run` 也走这一道，便于提前发现和测试。
  let outWarning = null;
  if (opts.out) {
    const check = checkOutPath(opts.out);
    if (!check.ok) { console.log(`失败：${check.refusal}`); return 2; }
    if (check.warning) { console.log(`提示：${check.warning}`); outWarning = check.warning; }
  }

  // ── 干跑：校验 + 布局 + 指令流，不起面板、不碰 PowerPoint ──────────────
  // 出货冒烟走这条；它证明「包脱离开发仓、引擎根找得到、整条算路走得通」。
  if (opts.dryRun) {
    const validated = readAndValidateSpec(opts.specs);
    if (!validated.ok) { console.log(`失败：${validated.message}`); return validated.code; }
    // --skin 的判定在 --dry-run 下同样走一遍：皮肤敲错了不该等到真去驱动 PowerPoint 才发现
    const loaded = applySkin(validated, opts.skin);
    if (loaded.ok === false) { console.log(`失败：${loaded.message}`); return loaded.code; }
    let plan;
    try { plan = buildPlan(loaded); } catch (error) {
      console.log(`失败：算布局失败：${error.message}`); return 1;
    }
    // 单图那一行**一个字都不许变**（出货冒烟盯着它）；deck 才在后面挂 slides=k
    console.log(`DRY-OK steps=${plan.summary.total} shapes=${plan.summary.shapes}`
      + (loaded.deck ? ` slides=${plan.summary.slides}` : ''));
    return 0;
  }

  if (!opts.out) opts.out = uniqueOut(defaultOut());

  // ── 1. 面板 ────────────────────────────────────────────────────────────
  const write = makeWriter(opts.events, false);
  const say = (event) => { console.log(write(event)); };
  if (outWarning) say({ type: 'log', level: 'warn', message: outWarning });
  const url = `http://localhost:${opts.port}`;
  const panel = await startPanel(opts.port, opts.events);
  if (!panel.server && !panel.reused) {
    console.log(`失败：面板服务起不来：${panel.error ? panel.error.message : '未知原因'}`);
    return 1;
  }
  console.log(panel.reused
    ? `面板：${url}（端口已被占用，复用正在跑的那个）`
    : `面板：${url}`);
  if (opts.open) openBrowser(url);

  /**
   * 收摊。**不能只调 server.close()** —— Node 的 close 只是停止接受新连接，它的回调要等
   * 所有现存连接结束才触发；面板的 /events 是 SSE 长连接，服务端每 15 秒还写一次
   * keep-alive，浏览器不关标签页它就永远不结束。而这条命令默认会 open 浏览器，
   * 所以「画完收摊」和「失败收摊」在真实调用路径上会永远卡在这里，
   * 「已保存：」「失败：」那一行一次都发不出去，豆包只能自己超时（2026-09-12 复现）。
   * 所以：先主动把还挂着的连接掐掉，再等 close；再加一道超时兜底，超时就直接往下走。
   */
  const closePanel = async (waitSeconds) => {
    if (waitSeconds > 0) await sleep(waitSeconds * 1000);
    const server = panel.server;
    if (!server) return;
    await new Promise((r) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; r(); } };
      const timer = setTimeout(finish, CLOSE_PANEL_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      server.close(() => { clearTimeout(timer); finish(); });
      // Node ≥18.2。掐掉 SSE 之后 close 的回调才有机会触发
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    });
  };
  const fail = async (message) => {
    say({ type: 'error', message });
    await closePanel(0);   // 失败不等，让调用方立刻拿到「失败：」那一行
    console.log(`失败：${oneLine(message)}`);
  };
  // 「要人去点授权框」单独一条出口：面板显示判词，stdout 那一行带「需要授权」前缀，
  // 退出码 3。调用方（豆包）只看最后一行就知道该让用户干什么。
  const failAuth = async (message, detail) => {
    say({ type: 'error', message, detail: detail || null });
    await closePanel(0);
    console.log(`失败：${AUTH_PREFIX} —— ${oneLine(message)}`);
    return 3;
  };
  // 「画起来之后 PowerPoint 中途没应答」：跟授权那条分开，因为这一轮的自动化授权
  // 已经用画出来的那些形状证明过了，再让人去点授权框只会绕圈。
  const failStalled = async (message, detail) => {
    say({ type: 'error', message, detail: detail || null });
    await closePanel(0);
    console.log(`失败：PowerPoint 无响应 —— ${oneLine(message)}`);
    return 5;
  };
  // 「本机没装桌面版 PowerPoint」：跟授权那条分开，因为那条让人去点的框根本不存在。
  const failMissing = async (message, detail) => {
    say({ type: 'error', message, detail: detail || null });
    await closePanel(0);
    console.log(`失败：没装 PowerPoint —— ${oneLine(message)}`);
    return 4;
  };
  // 「本机连 PowerShell 都没有」（只有 Windows 会走到）：这一条跟 PowerPoint 毫无关系，
  // 是壳自己起不来。以前它套的是 busy 判词「PowerPoint 没有响应……看看是不是有对话框挡着」，
  // 用户于是去 PowerPoint 里找一个根本不存在的对话框，真原因只在事件流的 detail 里躺着。
  const failNoPowerShell = async (message, detail) => {
    say({ type: 'error', message, detail: detail || null });
    await closePanel(0);
    console.log(`失败：没有 PowerShell —— ${oneLine(message)}`);
    return 6;
  };
  // 「PowerPoint 进程画到一半被关掉 / 崩了」：退出码仍旧 1（没有第二条解法之外的分诊价值），
  // 但结论行单列 —— 套通用的「画的时候出错了：」前缀，用户看到的第一句是一层没用的转述。
  const failGone = async (message, detail) => {
    say({ type: 'error', message, detail: detail || null });
    await closePanel(0);
    console.log(`失败：PowerPoint 中途退出 —— ${oneLine(message)}`);
    return 1;
  };

  // ── 2. 读 + 校验 + phase:received ──────────────────────────────────────
  const validated = readAndValidateSpec(opts.specs);
  if (!validated.ok) { await fail(validated.message); return validated.code; }
  // --skin 套在校验之后、算布局之前。皮肤敲错了跟 spec 没过校验走同一个出口：
  // 面板上一条 error 事件、stdout 一行「失败：…」、退出码 2
  const loaded = applySkin(validated, opts.skin);
  if (loaded.ok === false) { await fail(loaded.message); return loaded.code; }
  // 多页时节点 / 连线数是各页之和，标题取 deck 的 title（没写就取第一页的）
  say({
    type: 'phase', phase: 'received',
    title: loaded.title ?? null,
    nodes: loaded.slides.reduce((n, s) => n + countNodes(s.nodes), 0),
    edges: loaded.slides.reduce((n, s) => n + (Array.isArray(s.edges) ? s.edges.length : 0), 0),
    slides: loaded.slides.length,
    // `--skin` 给的那个 id；没给就是 null（= 各页用自己 spec 里写的皮肤）
    skin: opts.skin != null ? String(opts.skin) : null,
    specPath: opts.specs[0],
  });
  for (const w of loaded.warnings) say({ type: 'log', level: 'warn', message: w });

  // ── 3. 算布局 ──────────────────────────────────────────────────────────
  let plan;
  try { plan = buildPlan(loaded); } catch (error) {
    await fail(`算布局失败：${error.message}`); return 1;
  }
  const summary = plan.summary;
  say({ type: 'phase', phase: 'layout', total: summary.total, byKind: summary.byKind, slides: summary.slides });
  say({
    type: 'log', level: 'info',
    message: `布局好了：${summary.slides > 1 ? `${summary.slides} 页 / ` : ''}`
      + `${summary.total} 步 / ${summary.shapes} 个形状（`
      + Object.entries(summary.byKind).map(([k, v]) => `${k} ${v}`).join('，') + '）',
  });

  // ── 4. 授权预检：PowerPoint 有没有人应答 ───────────────────────────────
  // `platform` 决定面板这一格说什么：mac 说「正在确认 PowerPoint 授权 / 若系统弹出授权框
  // 请点允许」，Windows 说「正在唤起 PowerPoint」—— 那边没有授权框，照抄会让人满屏找一个
  // 不存在的框。契约见 panel/CONTRACT.md 的 auth 那一条。
  say({ type: 'phase', phase: 'auth', platform: DRIVER_PLATFORM });
  const probeResult = await probe(opts.probeCmd);
  if (!probeResult.ok) {
    // 最先认「本机连 PowerShell 都没有」（只有 Windows 的预检会给这个 code）。它必须排在
    // 别的分支前面：这一支压根没跑起来任何东西，没有 HRESULT 可认，落到最后就会被套上
    // busy 判词，把人支使去 PowerPoint 里找一个不存在的对话框。mac 上这两个都是 null。
    if (powerShellMissingMessage && probeResult.code === NO_POWERSHELL_CODE) {
      return failNoPowerShell(powerShellMissingMessage(), probeResult.detail);
    }
    // 再分「没装」还是「没授权」：探针那一条 `get version` 报 -1728 只可能是应用不在。
    // 以前这两种一律套授权判词，于是没装桌面版的人被引去找一个永远不会出现的授权框，
    // 回「重试」还是同一句话，无限循环，全程没人告诉他缺的是 PowerPoint 本身。
    // Windows 上对应的是 `0x80040154`（REGDB_E_CLASSNOTREG，注册表里没有 PowerPoint.Application）——
    // 同一个意思：装的不是桌面版 PowerPoint。判词分平台，退出码都是 4。
    const missing = missingPowerPointCode(probeResult.detail);
    if (missing) return failMissing(powerPointMissingMessage(missing), probeResult.detail);
    return failAuth(powerPointAuthMessage(probeResult.code), probeResult.detail);
  }
  say({ type: 'log', level: 'info', message: 'PowerPoint 已响应' });

  // ── 5. 驱动 PowerPoint ─────────────────────────────────────────────────
  let result;
  try {
    result = await runDrawPlan(plan, opts, say);
  } catch (error) {
    // 绘制阶段也可能撞上「本机连 PowerShell 都没有」（预检走的是 --probe-cmd 那条钩子时）。
    // 跟预检那一支同一件事、同一句判词、同一个退出码 6。
    if (error.powerShellMissing) {
      return failNoPowerShell(error.message, error.detail);
    }
    // PowerPoint 进程画到一半被关掉 / 崩了（0x80010108 / 0x800706BA / 0x800706BE）：
    // 退出码仍旧 1，但结论行单列，别让「画的时候出错了：」把判词压到第二层去。
    if (error.goneCode) {
      return failGone(error.message, error.detail);
    }
    // 已经画起来（有 step done 或进了 saving）之后的 -1712：驱动器给的是另一句判词，
    // 退出码 5。这时候「授权没给」已经被画出来的那些形状排除了，真凶是 PowerPoint 前台
    // 压着一个对话框 —— 保存到没被授权的目录时弹的「授予文件访问权限」最常见。
    if (error.stalledCode) {
      return failStalled(error.message, error.detail);
    }
    // 剩下的 -1743（任何阶段）、以及一步都没画就 -1712：判词与退出码跟预检那条一致，
    // 原始 osascript 堆栈放 detail。只多补半句——这一轮预检刚刚探通过 PowerPoint，
    // 所以「授权从没给过」已经被排除了；剩下最可能的是 PowerPoint 自己压着一个模态窗
    // （登录/激活、恢复文档、另存冲突）。不补这半句，用户只会反复去点一个已经点过的框。
    // Windows 上判词本身（powerPointBusyMessage）已经在说「去看 PowerPoint 窗口压着什么」，
    // 而且**一个「授权」字都不许有** —— 那边没有自动化授权框。所以补的那半句只加在 mac 上。
    if (error.authCode) {
      return failAuth(
        DRIVER_PLATFORM === 'win32'
          ? error.message
          : `${error.message}如果这次之前已经授权过（本轮预检确实探通了 PowerPoint），`
            + '那就先看一眼 PowerPoint 前台是不是压着一个对话框，处理掉再回复「重试」。',
        error.detail,
      );
    }
    await fail(`画的时候出错了：${error.message}`); return 1;
  }
  const slideCount = result.slides != null ? result.slides : summary.slides;
  say({
    type: 'phase', phase: 'done',
    file: result.file,
    shapes: result.shapes != null ? result.shapes : summary.shapes,
    elapsedMs: result.elapsedMs,
    animation: result.animation,
    slides: slideCount,
  });

  // ── 6. 让完成态在面板上停一会儿，再收摊 ────────────────────────────────
  await closePanel(opts.keepPanel);
  // 「已保存：」永远是最后一行（豆包只看这一行）；页数放它上面那一行
  if (slideCount > 1) console.log(`共 ${slideCount} 页`);
  console.log(`已保存：${result.file}`);
  return 0;
}

// 「是不是被直接 node 起来的」。必须按 realpath 比：macOS 的 /tmp 和 /var 本身就是
// 软链（/private/…），Node 解析模块时会把 import.meta.url 解成真路径，而 process.argv[1]
// 保持原样——直接比字符串会得出「没被直接调用」，于是整个脚本一声不吭地退出码 0。
const invoked = (() => {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  try { return realpathSync(process.argv[1]) === realpathSync(self); }
  catch { return resolve(process.argv[1]) === self; }
})();
if (invoked) {
  // 面板服务关了之后可能还剩 SSE 的 keep-alive 定时器挂着，活儿干完就走，不等事件循环自然空。
  process.exit(await main());
}
