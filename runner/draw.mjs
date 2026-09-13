#!/usr/bin/env node
// draw.mjs —— 豆包特供版的运行器：一份架构图语义 JSON 进去，一份 pptx 出来，
// 中间在 PowerPoint 里**肉眼可见地**一个一个画。
//
//   spec.json → 校验 → 引擎算布局（Scene）→ 绘制指令流 → 驱动 PowerPoint → 事件 → pptx
//
// **两个平台**：macOS 用 AppleScript（project/drivers/mac-powerpoint.mjs），
// Windows 用 PowerShell + COM（project/drivers/win-powerpoint.mjs）。同一份 steps、同一套事件，
// 面板一个字都不用改。选哪个由 PLATFORM 决定（见下面的 resolvePlatform）。
//
// 布局这一步不自己算：走 project/lib/scene-from-spec.mjs 的 sceneFromSpec / themeFor，
// 口径与 generate.mjs 构建期一字不差（autoLayout → autoFix → positions 覆盖 →
// materializeBundles → buildScene，主题 = skinExportTheme × 装框系数）。
// 画出来的那张和 skill 导出的那张是同一张图，不是第二套引擎。
//
// 本文件同时是**库**：run.mjs 直接 import 下面这几个导出，绝不重写一遍同样的逻辑。
//   findEngineRoot / ENGINE_ROOT   向上找含 project/generate.mjs 的那一层
//   makeWriter                     事件流写手（一行一个 JSON）
//   readAndValidateSpec            读 + 校验（一个路径或一串路径；认 deck）
//   buildPlan                      loaded → { slides: [{scene, theme, steps, summary}], summary }
//   runDrawPlan                    plan → 驱动 PowerPoint（多页）
//
// **一份 PPT 可以有多套架构图**（deck）。两种写法都行：
//   ① 一份 deck 文件：`{ "title": "整套的名字", "slides": [ 单图 spec, 单图 spec ] }`
//   ② 多个位置参数：`node draw.mjs a.json b.json` —— 顺序就是页序，
//      其中任何一份自己又是 deck 就把它的 slides 展开接进去。
// 没有 slides 的单图 spec 行为一个字都不变。
//
// 用法：
//   node draw.mjs <spec.json> [<spec2.json> …] [--delay 400] [--out <pptx>]
//                             [--events <steps.jsonl>]
//                             [--no-activate] [--no-animation] [--append] [--keep-script]
//
// 默认值：
//   --delay    400（每步之后停 400ms，给人看；出片设 0）
//   --out      ~/Desktop/架构图-YYYYMMDD-HHmmss.pptx（同名自动加 -2 / -3）
//   --events   <本目录>/.state/steps.jsonl
//
// 退出码：0 成功 / 2 spec 校验失败或 --out 落点不合法 / 3 PowerPoint 没响应（授权框没处理掉）
//         5 画起来之后 PowerPoint 中途无响应（前台压着对话框）/ 1 其它

import { existsSync, statSync, readFileSync, mkdirSync, appendFileSync, writeFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 向上找「引擎根目录」——含 project/generate.mjs 的那一层。写法照搬
 * .claude/skills/arch-diagram-ppt/scripts/_root.mjs，理由也一样：同一份 runner
 * 要在两种布局下跑，深度不一样。
 *   开发仓：shells/doubao/runner/  → 往上 3 层是仓库根
 *   技能包：<skill>/runner/        → 往上 1 层就是 <skill>/
 * 写死层数就必须在投影时改路径，改错了只有装了包的人才会发现。
 */
export function findEngineRoot(fromDir = HERE) {
  let dir = fromDir;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(resolve(dir, 'project/generate.mjs'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(
    '找不到引擎根目录（含 project/generate.mjs 的那一层）。\n'
    + `已从 ${fromDir} 向上找了 8 层。\n`
    + '如果这是刚装好的技能包，检查 project/ 目录是否完整。',
  );
}

export const ENGINE_ROOT = findEngineRoot();
export const RUNNER_DIR = HERE;
export const DEFAULT_EVENTS = join(HERE, '.state', 'steps.jsonl');

// 路径里有空格、中文时，裸字符串的 import() 会被当 URL 解析而挂掉，统一走 file:// URL。
const importEngine = (rel) => import(pathToFileURL(join(ENGINE_ROOT, rel)).href);

/* ── 按平台选驱动器 ────────────────────────────────────────────────────────
 * macOS 走 AppleScript（`project/drivers/mac-powerpoint.mjs`），Windows 走 PowerShell + COM
 * （`project/drivers/win-powerpoint.mjs`）。**同一份 steps 进去、同一套事件出来**，
 * 面板与 run.mjs 的出口契约一个字都不用改，区别只在「怎么下命令」和判词的措辞。
 *
 * `resolvePlatform` 多出来的两个口子**只给测试用**（本机是 macOS，没有 Windows 机器，
 * win32 那条分支不给个覆盖口就是没人跑过的死代码）：
 *   - 环境变量 `ARCH_DOUBAO_PLATFORM=win32|darwin`
 *   - 隐藏参数 `--platform win32|darwin`（跟 `--probe-cmd` 同级，USAGE 里不列）
 * 必须在**模块加载时**就解析：驱动器是 top-level await import 进来的，等 parseArgs 跑完再看
 * 就晚了。所以这里直接扫 process.argv，而不是等 run.mjs 把解析结果递过来。
 */
export function resolvePlatform(env = process.env, argv = process.argv, fallback = process.platform) {
  const ok = (v) => (v === 'win32' || v === 'darwin' ? v : null);
  const fromEnv = ok(env.ARCH_DOUBAO_PLATFORM);
  if (fromEnv) return fromEnv;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--platform') { const v = ok(argv[i + 1]); if (v) return v; }
    else if (arg.startsWith('--platform=')) { const v = ok(arg.slice('--platform='.length)); if (v) return v; }
  }
  return fallback;
}

/** 本次运行按哪个平台办事。`win32` 走 Windows 驱动器，其余（darwin / linux）走 mac 那条。 */
export const PLATFORM = resolvePlatform();
/** 事件流里写出去的那个值，只有两种（linux 上跟 darwin 归一档，判词也走 mac 那份）。 */
export const DRIVER_PLATFORM = PLATFORM === 'win32' ? 'win32' : 'darwin';
const IS_WIN = DRIVER_PLATFORM === 'win32';

const { validateSpec } = await importEngine('project/lib/spec-validator.mjs');
const { sceneFromSpec, themeFor } = await importEngine('project/lib/scene-from-spec.mjs');
const { sceneToDrawSteps, drawStepsSummary } = await importEngine('project/lib/exporters/draw-steps.mjs');
export const DRIVER_PATH = IS_WIN
  ? 'project/drivers/win-powerpoint.mjs'
  : 'project/drivers/mac-powerpoint.mjs';
const driver = await importEngine(DRIVER_PATH);
const { runDrawDeck } = driver;

/* 「PowerPoint 没有响应」的判词与码识别都在驱动器里，这里只是转口 —— run.mjs 靠它，
 * 省得再找一次引擎根，也保证两条路（预检 / 绘制）用的是同一句话。
 *
 * 两边的导出名不一样，对应关系（见 docs/doubao-windows.md 第 1 节的表）：
 *   mac `powerPointAuthMessage`               ↔ win `powerPointBusyMessage`
 *   mac `noResponseCode` / `missingPowerPointCode` ↔ win `classifyFailure`
 * Windows 上判词里**一个「授权」字都不许有** —— 那边压根没有自动化授权框，
 * 把人引去点一个不存在的框，他只会一直回「重试」。 */
export const powerPointAuthMessage = IS_WIN ? driver.powerPointBusyMessage : driver.powerPointAuthMessage;
export const noResponseCode = IS_WIN
  ? ((text) => driver.classifyFailure(text).code)
  : driver.noResponseCode;
// 「没装桌面版 PowerPoint」是另一条出口（退出码 4），判词同样只有驱动器那一份
export const powerPointMissingMessage = driver.powerPointMissingMessage;
export const missingPowerPointCode = IS_WIN
  ? ((text) => { const f = driver.classifyFailure(text); return f.kind === 'missing' ? f.code : null; })
  : driver.missingPowerPointCode;
// 「画起来之后 PowerPoint 中途没响应」是第三条出口（退出码 5），同上
export const powerPointStalledMessage = driver.powerPointStalledMessage;
/* 「本机连 PowerShell 都没有」是第四条出口（退出码 6），**只有 Windows 有** ——
 * mac 那边壳是系统自带的 osascript，找不到它不是一类用户能自己处理的事。
 * mac 上两个都是 null，run.mjs 靠 `powerShellMissingMessage &&` 直接短路掉这一支。 */
export const powerShellMissingMessage = IS_WIN ? driver.powerShellMissingMessage : null;
export const NO_POWERSHELL_CODE = IS_WIN ? driver.WIN_NO_POWERSHELL_CODE : null;
/**
 * Windows 的预检（`probePowerPoint({ probeCmd })`）由驱动器提供；mac 那条 run.mjs 自己
 * 拼 osascript（一条 `get version`），所以这里是 null。签名与返回值两边一模一样。
 */
export const probePowerPoint = IS_WIN ? driver.probePowerPoint : null;

const USAGE = `用法: node draw.mjs <spec.json> [<spec2.json> …] [--delay 毫秒] [--out <pptx>]
                              [--events <steps.jsonl>]
                              [--no-activate] [--no-animation] [--append] [--keep-script]

多个 spec = 一份多页 PPT（顺序按参数顺序）；一份顶层带 slides 数组的 deck 文件同理。

退出码: 0 成功 / 2 spec 校验失败或 --out 落点不合法 / 3 PowerPoint 没响应（要授权）
        5 画起来之后 PowerPoint 中途无响应（前台压着对话框）/ 1 其它`;

const pad = (n, w = 2) => String(n).padStart(w, '0');

/**
 * 「桌面在哪」。macOS 上永远是 `~/Desktop`，Windows 上不一定 —— 现在装了 Office 的机器
 * 常把桌面重定向到 OneDrive，`%USERPROFILE%\Desktop` 可能压根不存在（中文系统里那个
 * 目录还叫「桌面」）。找不到就落在主目录，总比往一个不存在的目录写强。
 *
 * 顺序是**先本地、后 OneDrive**：本地桌面还在的机器上行为跟以前一字不差。
 * @param {string} [home] 主目录，测试用临时 HOME 造三种布局
 */
export function desktopDir(home = homedir()) {
  const candidates = [
    join(home, 'Desktop'),
    join(home, 'OneDrive', 'Desktop'),
    join(home, 'OneDrive', '桌面'),
  ];
  for (const dir of candidates) {
    try { if (statSync(dir).isDirectory()) return dir; } catch { /* 下一个 */ }
  }
  return home;
}

/**
 * 默认落点。**时间戳精确到秒**：只到分钟的话，一分钟内画第二张就撞上第一张的文件名，
 * 而 `save pPres in (POSIX file …)` 对已存在的同名文件没有任何避让 —— 用户看到的是
 * 两次都报同一个路径、桌面上只剩后一张（或者第二次保存直接失败，因为第一张还开在
 * PowerPoint 里占着那个路径）。整条链实测 12–26 秒，一分钟内跑第二次是常事。
 */
export const defaultOut = (d = new Date()) => join(desktopDir(),
  `架构图-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
  + `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.pptx`);

/** 同名就往后加 -2 / -3……最多试到 -99，再撞就认了（同秒重跑本来就不该发生）。 */
export function uniqueOut(path) {
  if (!existsSync(path)) return path;
  const dot = path.lastIndexOf('.');
  const stem = dot > 0 ? path.slice(0, dot) : path;
  const ext = dot > 0 ? path.slice(dot) : '';
  for (let i = 2; i <= 99; i += 1) {
    const candidate = `${stem}-${i}${ext}`;
    if (!existsSync(candidate)) return candidate;
  }
  return path;
}

/* ── --out 落点护栏 ────────────────────────────────────────────────────────
 * 2026-09-12 实测的第二脚：`--out /private/tmp/…/verify/x.pptx`，20 步 26 个形状
 * 全部画进 PowerPoint，**保存那一步**挂死到 -1712。原因是 PowerPoint 是沙盒 App：
 * 往它没被授权的目录保存，系统会弹「授予文件访问权限：Microsoft PowerPoint 需要访问
 * 名为 verify 的文件夹」，对话框挂着没人点，Apple event 干等到系统两分钟上限。
 *
 * 分两级，因为这两种情况能做的事不一样：
 *   **硬拒绝**（退出码 2）：系统临时目录，以及任何不在用户主目录之下的路径。
 *     沙盒基本不可能放行这些地方，画完二三十秒再挂比一开始就拒绝亏太多。
 *   **软提示**（照跑）：主目录之下、但不在桌面 / 文稿 / 下载三处。实测 ~/Library/… 深处
 *     照样会弹那个框（点一次「选择…」就过），所以不拦，只把话提前说在前面。
 */
export const SANDBOX_HARD_DENY = Object.freeze([
  '/tmp', '/private/tmp', '/var/folders', '/private/var/folders', '/var/tmp', '/private/var/tmp',
]);

/** 这三处 PowerPoint 沙盒默认就能写（实测），落在这儿不提示。 */
export const SANDBOX_QUIET_DIRS = Object.freeze(['Desktop', 'Documents', 'Downloads']);

/** 软提示那一句。stdout 打成 `提示：<它>`，事件流里是一条 log/warn。 */
export const SANDBOX_WARNING = '输出目录不是桌面/文稿/下载，'
  + 'PowerPoint 可能弹出「授予文件访问权限」对话框，弹了就点「选择…」授予';

/**
 * realpath 能解到哪算哪：要写的 pptx 通常还不存在，逐级往上找到已存在的那一层解真路径，
 * 再把剩下的段接回去。不这么做，`/tmp/x/y.pptx` 与它的真身 `/private/tmp/x/y.pptx`
 * 在前缀比对里就是两个东西（macOS 的 /tmp、/var 本身都是软链）。
 */
export function realpathish(target) {
  let dir = resolve(target);
  const rest = [];
  for (let i = 0; i < 64; i += 1) {
    try {
      const real = realpathSync(dir);
      return rest.length ? join(real, ...rest) : real;
    } catch { /* 这一层还不存在，继续往上找 */ }
    const up = dirname(dir);
    if (up === dir) break;
    rest.unshift(basename(dir));
    dir = up;
  }
  return resolve(target);
}

const under = (path, base) => path === base || path.startsWith(base.endsWith('/') ? base : `${base}/`);

/**
 * 检查 --out 的落点。**不抛异常**，结果自带判定。
 *
 * **两个平台两套规矩**：上面那一整套沙盒护栏是 macOS 的事 —— PowerPoint for Mac 是沙盒
 * App。Windows 版不是沙盒 App，能写的地方直接写，所以 win32 上**不硬拒绝、也不软提示**，
 * 只要求父目录建得出来（建不出来才拒绝，退出码 2；`C:\` 根下、没权限的目录会撞上）。
 *
 * @param {string} outPath
 * @param {'darwin'|'win32'} [platform] 默认按本次运行的平台；测试可以点名
 * @returns {{ ok: boolean, real: string, refusal?: string, warning?: string }}
 *   refusal 有值 = 硬拒绝，调用方打 `失败：<refusal>` 并退出码 2；
 *   warning 有值 = 照跑，但先打一行 `提示：<warning>`。
 */
export function checkOutPath(outPath, platform = DRIVER_PLATFORM) {
  const real = realpathish(outPath);
  if (platform === 'win32') {
    const dir = dirname(real);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (error) {
      return {
        ok: false,
        real,
        refusal: `输出目录 ${dir} 建不出来（${error.code || error.message}），`
          + '请换一个你有写权限的目录，比如桌面',
      };
    }
    return { ok: true, real };
  }
  const home = realpathish(homedir());
  const inSystemTmp = SANDBOX_HARD_DENY.some((bad) => under(real, bad));
  if (inSystemTmp || !under(real, home)) {
    return {
      ok: false,
      real,
      refusal: `输出路径 ${outPath} 不在你的用户目录下，`
        + 'PowerPoint 沙盒不能直接写入，请改用桌面或文稿目录',
    };
  }
  const quiet = SANDBOX_QUIET_DIRS.some((name) => under(real, join(home, name)));
  return quiet ? { ok: true, real } : { ok: true, real, warning: SANDBOX_WARNING };
}

/** 节点总数（含容器的孩子），只为事件里那个数好看一点，不参与任何判定。 */
export function countNodes(nodes) {
  let n = 0;
  const walk = (list) => {
    for (const item of Array.isArray(list) ? list : []) {
      n += 1;
      if (item && Array.isArray(item.children)) walk(item.children);
    }
  };
  walk(nodes);
  return n;
}

/* ── spec 文件的编码 ───────────────────────────────────────────────────────
 * 豆包在 Windows 上是用 PowerShell 5.1 把 spec 写到盘上的，那边有两个静默的坑：
 *   ① `Set-Content -Encoding UTF8` 写出来的 UTF-8 **带 BOM**（U+FEFF）。BOM 在
 *      `JSON.parse` 眼里是「意料之外的记号」，直接报 `Unexpected token`，
 *      而用户只会看到「spec 读不了或不是合法 JSON」——一个字都看不出真凶是 BOM。
 *   ② 不带 `-Encoding` 时 5.1 按系统 ANSI 代码页写，中文 Windows 上就是 **GBK**。
 *      按 UTF-8 解出来满屏 U+FFFD，JSON 结构可能还是合法的，于是标题变乱码、
 *      跑完才发现，或者恰好撞上转义位置直接解析失败。
 * 两条都在读的时候原地救回来。SKILL.md 里也让豆包用 `WriteAllText` + 无 BOM 的
 * UTF8Encoding 写，这里是第二道保险。
 */
export function decodeSpecText(buf) {
  // **必须是 TextDecoder，不能是 `buf.toString('utf8')`** —— 剥 BOM 的正是它：
  // WHATWG 的 UTF-8 解码器默认 `ignoreBOM:false`，开头的 EF BB BF 会被吃掉；
  // Buffer.toString 原样留着，于是 JSON.parse 第一个字符就报 Unexpected token。
  let text = new TextDecoder('utf-8').decode(buf);
  // U+FFFD = UTF-8 解码遇到坏字节。真 UTF-8 的中文不会出现它，所以拿它当「换 GBK 再试一次」的信号
  if (text.includes('�')) {
    try {
      const gbk = new TextDecoder('gbk').decode(buf);
      if (!gbk.includes('�')) text = gbk;
    } catch { /* 这个 Node 没带 gbk 解码表就算了，照 UTF-8 的结果往下走 */ }
  }
  return text;
}

function parseArgs(argv) {
  const opts = {
    specs: [],
    delay: 400,
    out: null,
    events: DEFAULT_EVENTS,
    activate: true,
    animate: true,
    append: false,
    keepScript: false,
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
      case '--events': opts.events = abs(take()); break;
      case '--no-activate': opts.activate = false; break;
      case '--no-animation': opts.animate = false; break;
      case '--append': opts.append = true; break;
      case '--keep-script': opts.keepScript = true; break;
      // 隐藏参数，只给测试用：强行按某个平台选驱动器（见 resolvePlatform）。
      // 真正生效是在模块加载时扫 argv 完成的，这里只是别让它撞上「未知参数」。
      case '--platform': take(); break;
      case '--help': case '-h': opts.help = true; break;
      default:
        if (key.startsWith('--')) throw new Error(`未知参数: ${arg}（用 --help 看用法）`);
        // 多个位置参数 = 一份多页 deck，顺序按参数顺序
        opts.specs.push(abs(arg));
    }
  }
  if (!Number.isFinite(opts.delay) || opts.delay < 0) throw new Error('--delay 必须是非负毫秒数');
  return opts;
}

// 事件按契约一行一个 JSON 追加（shells/doubao/runner/panel/CONTRACT.md）。
// 写事件永远不许把主流程搞挂：盘满、目录没了，顶多少一行日志。
export function makeWriter(path, append) {
  mkdirSync(dirname(path), { recursive: true });
  if (!append) writeFileSync(path, '', 'utf8');
  return (event) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
    try { appendFileSync(path, `${line}\n`, 'utf8'); } catch { /* 事件写不进去不影响画图 */ }
    return line;
  };
}

/**
 * 读 + 校验。**一份 PPT 可以有多套架构图**（deck）：
 *
 *   单图 spec —— 顶层直接是 `{ title, nodes, edges, … }`，行为跟以前一个字都不差。
 *   deck     —— 顶层是 `{ title?, slides: [ 单图 spec, … ] }`，每一项各自过校验，
 *                报错和告警都带上 `slides[i]:` 前缀（下标从 0 起，跟数组一致）。
 *
 * 给多个路径（`node run.mjs a.json b.json`）等于一个多页 deck，顺序按参数顺序；
 * 其中任何一份自己又是 deck 就把它的 slides 展开接进去。
 *
 * 不抛异常，结果自带 code：0 通过 / 2 读不了或没过校验。
 *
 * @param {string|string[]} pathOrPaths 一个 spec 路径，或按页顺序排好的一串路径
 * @returns {{ ok: boolean, code: number, deck: boolean, slides: object[],
 *             title: string|null, warnings: string[], message?: string }}
 */
export function readAndValidateSpec(pathOrPaths) {
  const paths = Array.isArray(pathOrPaths) ? pathOrPaths : [pathOrPaths];
  const many = paths.length > 1;
  const fail = (deck, message) => ({ ok: false, code: 2, deck, slides: [], title: null, warnings: [], message });

  const specs = [];
  let deck = many;      // 给了多份路径本身就是 deck
  let deckTitle = null;

  for (const path of paths) {
    let raw;
    try {
      raw = JSON.parse(decodeSpecText(readFileSync(path)));
    } catch (error) {
      // 一份的时候判词跟以前一字不差；多份的时候得说清是哪一份读不了
      return fail(deck, `${many ? `${basename(path)}：` : ''}spec 读不了或不是合法 JSON：${error.message}`);
    }
    const isDeck = raw && typeof raw === 'object' && !Array.isArray(raw) && Array.isArray(raw.slides);
    if (!isDeck) { specs.push(raw); continue; }

    deck = true;
    if (raw.nodes != null || raw.edges != null) {
      return fail(true, '顶层写了 slides 就不要再写 nodes/edges'
        + '（每一页的 nodes/edges 写在它自己那一项里）');
    }
    if (raw.slides.length === 0) return fail(true, 'slides 是空数组，至少要有一页');
    if (deckTitle == null && String(raw.title || '').trim() !== '') deckTitle = raw.title;
    for (const one of raw.slides) specs.push(one);
  }

  const warnings = [];
  for (let i = 0; i < specs.length; i += 1) {
    // 单图不带前缀（老行为），deck 一律带上页号 —— 不然「title 不能为空」根本不知道说哪一页
    const prefix = deck ? `slides[${i}]: ` : '';
    const validation = validateSpec(specs[i]);
    if (!validation.valid) return fail(deck, `${prefix}spec 校验失败：${validation.errors.join('；')}`);
    for (const w of validation.warnings || []) warnings.push(`${prefix}${w}`);
  }

  const firstTitle = specs.length && specs[0] && specs[0].title != null ? specs[0].title : null;
  return { ok: true, code: 0, deck, slides: specs, title: deckTitle != null ? deckTitle : firstTitle, warnings };
}

/**
 * 读校验的结果 → 绘制计划。**永远是多页形状**，单图就是只有一页的 deck。
 *
 * @param {{slides: object[]}|object} loaded readAndValidateSpec 的结果；
 *        为了好调，直接丢一份单图 spec 进来也认
 * @returns {{ slides: Array<{scene, theme, steps, summary}>,
 *             summary: { total: number, shapes: number, byKind: object, slides: number } }}
 *          summary 是**整份 PPT 的合计**：total / shapes 相加，byKind 逐项相加，slides 是页数
 */
export function buildPlan(loaded) {
  const specs = loaded && Array.isArray(loaded.slides) ? loaded.slides : [loaded];
  const slides = specs.map((spec) => {
    const built = sceneFromSpec(spec);
    const scene = built.scene;
    const theme = themeFor(scene, built.ws, spec.skin);
    const steps = sceneToDrawSteps(scene, theme);
    return { scene, theme, steps, summary: drawStepsSummary(steps) };
  });
  const summary = { total: 0, shapes: 0, byKind: {}, slides: slides.length };
  for (const page of slides) {
    summary.total += page.summary.total;
    summary.shapes += page.summary.shapes;
    for (const [kind, n] of Object.entries(page.summary.byKind)) {
      summary.byKind[kind] = (summary.byKind[kind] || 0) + n;
    }
  }
  return { slides, summary };
}

/** plan → 驱动 PowerPoint。每页的底色取各自 theme.background，标题取各自 scene.title。 */
export function runDrawPlan(plan, opts, say) {
  const pages = plan.slides.map((page) => ({
    steps: page.steps,
    background: page.theme.background,
    title: page.scene.title && page.scene.title.text ? page.scene.title.text : null,
  }));
  return runDrawDeck(pages, {
    delayMs: opts.delay,
    outPath: opts.out,
    activate: opts.activate !== false,
    animate: opts.animate !== false,
    keepScript: opts.keepScript === true,
  }, say);
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    return 1;
  }
  if (opts.help) { console.log(USAGE); return 0; }
  if (!opts.specs.length) { console.error(`缺 spec.json\n\n${USAGE}`); return 1; }
  if (!opts.out) opts.out = uniqueOut(defaultOut());

  // 落点护栏：沙盒写不进去的地方一开始就拒绝，别等画完二三十秒才在保存那一步挂死
  const outCheck = checkOutPath(opts.out);
  if (!outCheck.ok) { console.log(`失败：${outCheck.refusal}`); return 2; }
  if (outCheck.warning) console.log(`提示：${outCheck.warning}`);

  const write = makeWriter(opts.events, opts.append);
  const say = (event) => { console.log(write(event)); };
  if (outCheck.warning) say({ type: 'log', level: 'warn', message: outCheck.warning });

  // --- 1. 读 + 校验 --------------------------------------------------------
  const loaded = readAndValidateSpec(opts.specs);
  if (!loaded.ok) {
    say({ type: 'error', message: loaded.message });
    return loaded.code;
  }
  for (const w of loaded.warnings) say({ type: 'log', level: 'warn', message: w });

  // --- 2. 算布局 -----------------------------------------------------------
  let plan;
  try {
    plan = buildPlan(loaded);
  } catch (error) {
    say({ type: 'error', message: `算布局失败：${error.message}` });
    return 1;
  }
  const summary = plan.summary;
  // byKind 是面板底部四类计数的分母（容器 0/3、节点 0/14 …），只列这一份图里出现过的 kind；
  // 多页时是各页相加，进度条的分母也是整份 PPT
  say({ type: 'phase', phase: 'layout', total: summary.total, byKind: summary.byKind, slides: summary.slides });
  say({
    type: 'log', level: 'info',
    message: `布局好了：${summary.slides > 1 ? `${summary.slides} 页 / ` : ''}`
      + `${summary.total} 步 / ${summary.shapes} 个形状（`
      + Object.entries(summary.byKind).map(([k, v]) => `${k} ${v}`).join('，') + '）',
  });

  // --- 3. 驱动 PowerPoint --------------------------------------------------
  let result;
  try {
    result = await runDrawPlan(plan, opts, say);
  } catch (error) {
    // 已经画起来之后再撞上 -1712：不是授权，是 PowerPoint 前台压着一个对话框
    // （最常见的是保存时的「授予文件访问权限」）。退出码 5，见文件头。
    if (error.stalledCode) {
      say({ type: 'error', message: error.message, detail: error.detail || null });
      return 5;
    }
    // 预检阶段的 -1712、以及任何阶段的 -1743：授权框没处理掉，判词原样发出去，
    // 原始 osascript 堆栈放 detail（退出码 3 专表这件事，见文件头）。
    if (error.authCode) {
      say({ type: 'error', message: error.message, detail: error.detail || null });
      return 3;
    }
    say({ type: 'error', message: `画的时候出错了：${error.message}` });
    return 1;
  }

  say({
    type: 'phase', phase: 'done',
    file: result.file,
    shapes: result.shapes != null ? result.shapes : summary.shapes,
    elapsedMs: result.elapsedMs,
    animation: result.animation,
    slides: result.slides != null ? result.slides : summary.slides,
  });
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
if (invoked) process.exitCode = await main();
