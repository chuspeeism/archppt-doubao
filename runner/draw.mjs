#!/usr/bin/env node
// draw.mjs —— 豆包特供版的运行器：一份架构图语义 JSON 进去，一份 pptx 出来，
// 中间在 PowerPoint 里**肉眼可见地**一个一个画。
//
//   spec.json → 校验 → 引擎算布局（Scene）→ 绘制指令流 → AppleScript 驱动 PowerPoint → 事件 → pptx
//
// 布局这一步不自己算：走 project/lib/scene-from-spec.mjs 的 sceneFromSpec / themeFor，
// 口径与 generate.mjs 构建期一字不差（autoLayout → autoFix → positions 覆盖 →
// materializeBundles → buildScene，主题 = skinExportTheme × 装框系数）。
// 画出来的那张和 skill 导出的那张是同一张图，不是第二套引擎。
//
// 本文件同时是**库**：run.mjs 直接 import 下面这几个导出，绝不重写一遍同样的逻辑。
//   findEngineRoot / ENGINE_ROOT   向上找含 project/generate.mjs 的那一层
//   makeWriter                     事件流写手（一行一个 JSON）
//   readAndValidateSpec            读 + 校验
//   buildPlan                      spec → { scene, theme, steps, summary }
//   runDrawPlan                    plan → 驱动 PowerPoint
//
// 用法：
//   node draw.mjs <spec.json> [--delay 400] [--out <pptx>] [--events <steps.jsonl>]
//                             [--no-activate] [--no-animation] [--append] [--keep-script]
//
// 默认值：
//   --delay    400（每步之后停 400ms，给人看；出片设 0）
//   --out      ~/Desktop/架构图-YYYYMMDD-HHmmss.pptx（同名自动加 -2 / -3）
//   --events   <本目录>/.state/steps.jsonl
//
// 退出码：0 成功 / 2 spec 校验失败或 --out 落点不合法 / 3 PowerPoint 没响应（授权框没处理掉）
//         5 画起来之后 PowerPoint 中途无响应（前台压着对话框）/ 1 其它

import { existsSync, readFileSync, mkdirSync, appendFileSync, writeFileSync, realpathSync } from 'node:fs';
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

const { validateSpec } = await importEngine('project/lib/spec-validator.mjs');
const { sceneFromSpec, themeFor } = await importEngine('project/lib/scene-from-spec.mjs');
const { sceneToDrawSteps, drawStepsSummary } = await importEngine('project/lib/exporters/draw-steps.mjs');
const driver = await importEngine('project/drivers/mac-powerpoint.mjs');
const { runDraw } = driver;

// 「PowerPoint 没有响应」的判词与码识别都在驱动器里，这里只是转口 —— run.mjs 靠它，
// 省得再找一次引擎根，也保证两条路（预检 / 绘制）用的是同一句话。
export const powerPointAuthMessage = driver.powerPointAuthMessage;
export const noResponseCode = driver.noResponseCode;
// 「没装桌面版 PowerPoint」是另一条出口（退出码 4），判词同样只有驱动器那一份
export const powerPointMissingMessage = driver.powerPointMissingMessage;
export const missingPowerPointCode = driver.missingPowerPointCode;
// 「画起来之后 PowerPoint 中途没响应」是第三条出口（退出码 5），同上
export const powerPointStalledMessage = driver.powerPointStalledMessage;

const USAGE = `用法: node draw.mjs <spec.json> [--delay 毫秒] [--out <pptx>] [--events <steps.jsonl>]
                              [--no-activate] [--no-animation] [--append] [--keep-script]

退出码: 0 成功 / 2 spec 校验失败或 --out 落点不合法 / 3 PowerPoint 没响应（要授权）
        5 画起来之后 PowerPoint 中途无响应（前台压着对话框）/ 1 其它`;

const pad = (n, w = 2) => String(n).padStart(w, '0');

/**
 * 默认落点。**时间戳精确到秒**：只到分钟的话，一分钟内画第二张就撞上第一张的文件名，
 * 而 `save pPres in (POSIX file …)` 对已存在的同名文件没有任何避让 —— 用户看到的是
 * 两次都报同一个路径、桌面上只剩后一张（或者第二次保存直接失败，因为第一张还开在
 * PowerPoint 里占着那个路径）。整条链实测 12–26 秒，一分钟内跑第二次是常事。
 */
export const defaultOut = (d = new Date()) => join(homedir(), 'Desktop',
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
 * @returns {{ ok: boolean, real: string, refusal?: string, warning?: string }}
 *   refusal 有值 = 硬拒绝，调用方打 `失败：<refusal>` 并退出码 2；
 *   warning 有值 = 照跑，但先打一行 `提示：<warning>`。
 */
export function checkOutPath(outPath) {
  const real = realpathish(outPath);
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

function parseArgs(argv) {
  const opts = {
    spec: null,
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
      case '--help': case '-h': opts.help = true; break;
      default:
        if (key.startsWith('--')) throw new Error(`未知参数: ${arg}（用 --help 看用法）`);
        if (opts.spec) throw new Error(`只能给一份 spec，多出来的是: ${arg}`);
        opts.spec = abs(arg);
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
 * 读 + 校验。不抛异常，结果自带 code：0 通过 / 2 读不了或没过校验。
 * @returns {{ ok: boolean, code: number, spec?: object, message?: string, warnings: string[] }}
 */
export function readAndValidateSpec(specPath) {
  let spec;
  try {
    spec = JSON.parse(readFileSync(specPath, 'utf8'));
  } catch (error) {
    return { ok: false, code: 2, warnings: [], message: `spec 读不了或不是合法 JSON：${error.message}` };
  }
  const validation = validateSpec(spec);
  if (!validation.valid) {
    return { ok: false, code: 2, warnings: [], message: `spec 校验失败：${validation.errors.join('；')}` };
  }
  return { ok: true, code: 0, spec, warnings: validation.warnings || [] };
}

/** spec → { scene, theme, steps, summary }。算不出来就抛，调用方负责翻译成事件。 */
export function buildPlan(spec) {
  const built = sceneFromSpec(spec);
  const scene = built.scene;
  const theme = themeFor(scene, built.ws, spec.skin);
  const steps = sceneToDrawSteps(scene, theme);
  return { scene, theme, steps, summary: drawStepsSummary(steps) };
}

/** plan → 驱动 PowerPoint。参数与 runDraw 一致，只是把 scene/theme 里那几项替调用方填好。 */
export function runDrawPlan(plan, opts, say) {
  return runDraw(plan.steps, {
    delayMs: opts.delay,
    outPath: opts.out,
    slideTitle: plan.scene.title && plan.scene.title.text ? plan.scene.title.text : undefined,
    background: plan.theme.background,
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
  if (!opts.spec) { console.error(`缺 spec.json\n\n${USAGE}`); return 1; }
  if (!opts.out) opts.out = uniqueOut(defaultOut());

  // 落点护栏：沙盒写不进去的地方一开始就拒绝，别等画完二三十秒才在保存那一步挂死
  const outCheck = checkOutPath(opts.out);
  if (!outCheck.ok) { console.log(`失败：${outCheck.refusal}`); return 2; }
  if (outCheck.warning) console.log(`提示：${outCheck.warning}`);

  const write = makeWriter(opts.events, opts.append);
  const say = (event) => { console.log(write(event)); };
  if (outCheck.warning) say({ type: 'log', level: 'warn', message: outCheck.warning });

  // --- 1. 读 + 校验 --------------------------------------------------------
  const loaded = readAndValidateSpec(opts.spec);
  if (!loaded.ok) {
    say({ type: 'error', message: loaded.message });
    return loaded.code;
  }
  for (const w of loaded.warnings) say({ type: 'log', level: 'warn', message: w });

  // --- 2. 算布局 -----------------------------------------------------------
  let plan;
  try {
    plan = buildPlan(loaded.spec);
  } catch (error) {
    say({ type: 'error', message: `算布局失败：${error.message}` });
    return 1;
  }
  const summary = plan.summary;
  // byKind 是面板底部四类计数的分母（容器 0/3、节点 0/14 …），只列这一份图里出现过的 kind
  say({ type: 'phase', phase: 'layout', total: summary.total, byKind: summary.byKind });
  say({
    type: 'log', level: 'info',
    message: `布局好了：${summary.total} 步 / ${summary.shapes} 个形状（`
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
