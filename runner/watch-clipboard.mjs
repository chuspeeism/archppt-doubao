#!/usr/bin/env node
// watch-clipboard.mjs —— 「豆包写完 JSON → 人点一下复制 → 本地驱动器自动接手」通道的探针。
//
// 每 500ms 读一次 macOS 剪贴板（pbpaste），内容变了就试着当「架构图语义 JSON」解：
// 去掉 markdown 围栏 → JSON.parse → 顶层像不像 spec → 落盘 inbox/ → 调 validate-spec.mjs 校验。
// 只做通道，不画图。
//
// 用法：
//   node watch-clipboard.mjs                 一直监听
//   node watch-clipboard.mjs --once          收到第一份「校验通过」的 spec 后退出（驱动器用这个）
//   node watch-clipboard.mjs --once --timeout=30
//
// 选项：
//   --once                 第一份 ACCEPTED 之后退出（退出码 0）
//   --timeout=<秒>         到点还没等到 ACCEPTED 就退出（退出码 3）；0 表示不限时
//   --interval=<毫秒>      轮询间隔，默认 500
//   --inbox=<目录>         落盘目录，默认脚本旁边的 inbox/
//   --validator=<路径>     外挂校验脚本路径，默认从仓库里找（见 defaultValidator），也可用环境变量
//                          ARCH_VALIDATOR；找不到就用包内的 project/lib/spec-validator.mjs 进程内校验
//   --json-out             每条日志改成一行 JSON（驱动器按事件类型解析，见下）
//   --include-initial      连启动那一刻剪贴板里已有的内容也一起处理（默认只处理「启动之后的变化」）
//   --help
//
// --json-out 的事件（一行一个 JSON，UTF-8）：
//   {"ts","type":"log","message"}                                  人话日志，随便忽略
//   {"ts","type":"hit","bytes","how","nodes","edges","title"}      命中一份像 spec 的 JSON
//   {"ts","type":"accepted","path","title","nodes","edges"}        校验通过，path 是绝对路径
//   {"ts","type":"rejected","path","errors":[...]}                 校验没过
//   {"ts","type":"exit","code","reason"}                           退出
//
// 退出码：
//   0  正常结束（--once 收到 ACCEPTED / Ctrl+C 干净退出）
//   1  启动期致命错误（找不到 pbpaste、显式指定的校验脚本不存在、连引擎根都找不到、inbox 建不出来）
//   3  --timeout 到点仍未收到 ACCEPTED
//
// 注意（macOS 的坑，见 REPORT.md）：pbpaste 的输出编码跟着 locale 走。LC_CTYPE 不是 UTF-8 时，
// 中文会被转成 GBK 字节、emoji 直接变成 "?"，而 JSON.parse 照样成功——于是你会拿到一份
// 「结构合法、中文全是乱码」的 spec。所以这里给 pbpaste 强行注入 LC_CTYPE=UTF-8。

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// 校验脚本按**仓库**解析，不再写死某台机器上的 ~/.claude/skills/ 绝对路径 ——
// 那份路径换台机器、换个 checkout 就失效。口径同 scripts/_root.mjs：
// 从本文件往上找含 project/generate.mjs 的那一层（= 引擎根），再往下拼 skill 的脚本目录。
export function defaultValidator(from = HERE) {
  const candidates = [];
  let dir = from;
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(dir, 'project', 'generate.mjs'))) {
      candidates.push(join(dir, '.claude', 'skills', 'arch-diagram-ppt', 'scripts', 'validate-spec.mjs'));
      candidates.push(join(dir, 'scripts', 'validate-spec.mjs')); // 出货仓：skill 根就是引擎根
      break;
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  // 最后兜底：装到 ~/.claude/skills/ 的那一份
  candidates.push(join(process.env.HOME || '', '.claude', 'skills', 'arch-diagram-ppt', 'scripts', 'validate-spec.mjs'));
  return candidates.find((p) => existsSync(p)) || null;
}

/**
 * 找引擎根（含 project/generate.mjs 的那一层）。跟 draw.mjs 的 findEngineRoot 同口径，
 * 这里不 import 它，是因为 draw.mjs 顶层会把整套引擎和驱动器一起拉起来，
 * 而这个探针只需要一个校验器。
 */
function engineRoot(from = HERE) {
  let dir = from;
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(dir, 'project', 'generate.mjs'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/**
 * 进程内校验，**出货包里唯一走得通的那条**。
 *
 * 上面那三个候选全是「外挂 CLI」`scripts/validate-spec.mjs`，而豆包出货清单不投影
 * scripts/ —— 包里前两个候选必然不存在，只剩「用户自己也装过 Claude 版 skill」这一个
 * 兜底。开发机上恰好装着，所以这条通道在开发机跑得通、在陌生人机器上 100% 启动即退：
 * start.command 面板起来了、浏览器开了，终端只留一句「找不到校验脚本: /Users/<别人>/…」。
 * 而包里明明带着 project/lib/spec-validator.mjs（run.mjs / draw.mjs 走的就是它）。
 *
 * 所以：找不到 CLI 就在进程内调同一个 validateSpec，输出格式跟 CLI 对齐
 * （`INVALID <path>` + 每条错误一行 `- …`），下游解析那几行不用改。
 */
export async function validateInProcess(specPath) {
  const root = engineRoot();
  if (!root) return { status: 1, out: `INVALID ${specPath}\n- 找不到引擎根目录（含 project/generate.mjs 的那一层）` };
  let validateSpec;
  try {
    ({ validateSpec } = await import(pathToFileURL(join(root, 'project/lib/spec-validator.mjs')).href));
  } catch (error) {
    return { status: 1, out: `INVALID ${specPath}\n- 校验器加载失败: ${error.message}` };
  }
  let spec;
  try {
    spec = JSON.parse(readFileSync(specPath, 'utf8'));
  } catch (error) {
    return { status: 1, out: `INVALID ${specPath}\n- 无法读取或解析 JSON: ${error.message}` };
  }
  const result = validateSpec(spec);
  const lines = [];
  if (!result.valid) {
    lines.push(`INVALID ${specPath}`);
    for (const e of result.errors) lines.push(`- ${e}`);
  } else {
    lines.push(`VALID ${specPath}`);
    lines.push(`layout=${result.normalizedLayout} nodes=${result.nodeCount} leaves=${result.leafCount}`);
  }
  for (const w of result.warnings || []) lines.push(`WARN: ${w}`);
  return { status: result.valid ? 0 : 1, out: lines.join('\n') };
}

const PBPASTE = '/usr/bin/pbpaste';
const MAX_CLIPBOARD_BYTES = 64 * 1024 * 1024; // 剪贴板可以很大，别让 execFileSync 的默认 1MB 截断

// ---------------------------------------------------------------- 剪贴板读取

// 只强制 LC_CTYPE；LANG 留着用户自己的（只要不是 UTF-8，LC_CTYPE 的优先级更高）。
const PB_ENV = { ...process.env, LC_CTYPE: 'UTF-8' };

export function readClipboard() {
  const buf = execFileSync(PBPASTE, ['-Prefer', 'txt'], {
    encoding: 'buffer',
    maxBuffer: MAX_CLIPBOARD_BYTES,
    env: PB_ENV,
  });
  return buf.toString('utf8');
}

// ---------------------------------------------------------------- 围栏剥离

// 整段就是一个围栏块：```json ... ```  /  ``` ... ```  /  ~~~json ... ~~~  /  ````json ... ````
const WHOLE_FENCE = /^\s*(`{3,}|~{3,})[ \t]*([A-Za-z0-9_+-]*)[ \t]*\r?\n([\s\S]*?)\r?\n?\1[ \t]*\s*$/;
// 围栏块夹在闲聊里：「好的，这是架构图：\n```json\n{...}\n```\n还需要我…」
const INNER_FENCE = /(`{3,}|~{3,})[ \t]*([A-Za-z0-9_+-]*)[ \t]*\r?\n([\s\S]*?)\r?\n\1/;
// 只有开头围栏、没有收尾：模型还在流式输出时人就按了复制。剥掉开头那行再试，
// 内容没写完的话 JSON.parse 自然会失败，不会误判。
const OPEN_FENCE = /^\s*(?:`{3,}|~{3,})[ \t]*[A-Za-z0-9_+-]*[ \t]*\r?\n([\s\S]*)$/;

// 返回「值得拿去 JSON.parse 的候选串」，按可信度排序。
export function candidates(raw) {
  const out = [];
  const push = (s, how) => {
    const t = (s || '').replace(/^﻿/, '').trim(); // 顺手吃掉 BOM
    if (t && !out.some((c) => c.text === t)) out.push({ text: t, how });
  };
  push(raw, 'raw');
  const whole = WHOLE_FENCE.exec(raw);
  if (whole) push(whole[3], `fence:${whole[1][0] === '`' ? 'backtick' : 'tilde'}${whole[2] ? '+' + whole[2] : ''}`);
  const inner = INNER_FENCE.exec(raw);
  if (inner) push(inner[3], `fence-in-prose:${inner[2] || 'none'}`);
  if (!whole) {
    const open = OPEN_FENCE.exec(raw);
    if (open) push(open[1], 'fence-unclosed');
  }
  return out;
}

// 兼容老调用点：只要剥完的那一份。
export const stripFences = (raw) => candidates(raw).at(-1).text;

// ---------------------------------------------------------------- 识别规则

// 「像不像架构图 spec」的门槛，按 references/schema.md 的必填字段定：
//   根是 object、nodes 是非空数组、数组里装的是带 id / label 的对象。
// title 故意不进门槛——缺 title 的应该被「校验拒绝」并报出原因，而不是被静默忽略。
export function looksLikeSpec(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (!Array.isArray(value.nodes) || value.nodes.length === 0) return false;
  return value.nodes.some(
    (n) => n && typeof n === 'object' && !Array.isArray(n) && ('id' in n || 'label' in n),
  );
}

// 从一段剪贴板文本里抽出 spec；抽不到返回 null。
export function extractSpec(raw) {
  for (const c of candidates(raw)) {
    let parsed;
    try {
      parsed = JSON.parse(c.text);
    } catch {
      continue;
    }
    if (!looksLikeSpec(parsed)) continue;
    return { text: c.text, spec: parsed, how: c.how };
  }
  return null;
}

// ---------------------------------------------------------------- 主流程

const pad = (n, w = 2) => String(n).padStart(w, '0');
function stamp(d = new Date()) {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
}
function fileStamp(d = new Date()) {
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}`
  );
}
// --json-out 打开之后 log() 也走 JSON，人话进 message 字段；一行一个对象，绝不换行。
let JSON_OUT = false;
const log = (...parts) => {
  if (JSON_OUT) { emitJson({ type: 'log', message: parts.map((p) => String(p)).join(' ') }); return; }
  console.log(`[${stamp()}]`, ...parts);
};
function emitJson(obj) {
  if (!JSON_OUT) return;
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...obj }));
}

function parseArgs(argv) {
  const opts = {
    once: false,
    timeout: 0,
    interval: 500,
    inbox: resolve(HERE, 'inbox'),
    validator: process.env.ARCH_VALIDATOR || defaultValidator(),
    includeInitial: false,
    jsonOut: false,
    help: false,
  };
  for (const arg of argv) {
    const [key, value] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, null];
    switch (key) {
      case '--once': opts.once = true; break;
      case '--json-out': opts.jsonOut = true; break;
      case '--include-initial': opts.includeInitial = true; break;
      case '--help': case '-h': opts.help = true; break;
      case '--timeout': opts.timeout = Number(value); break;
      case '--interval': opts.interval = Number(value); break;
      case '--inbox': opts.inbox = isAbsolute(value || '') ? value : resolve(process.cwd(), value || ''); break;
      case '--validator': opts.validator = isAbsolute(value || '') ? value : resolve(process.cwd(), value || ''); break;
      default: throw new Error(`未知参数: ${arg}（用 --help 看用法）`);
    }
  }
  if (!Number.isFinite(opts.timeout) || opts.timeout < 0) throw new Error('--timeout 必须是非负数（秒）');
  if (!Number.isFinite(opts.interval) || opts.interval < 50) throw new Error('--interval 必须 >= 50（毫秒）');
  return opts;
}

const USAGE = `用法: node watch-clipboard.mjs [--once] [--timeout=秒] [--interval=毫秒]
                              [--inbox=目录] [--validator=路径] [--include-initial] [--json-out]

退出码: 0 正常 / 1 启动期致命错误 / 3 --timeout 到点仍未收到 ACCEPTED`;

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  if (opts.help) { console.log(USAGE); return; }
  JSON_OUT = opts.jsonOut;

  // --- 启动期自检：任何一条不满足就直接退，不要在循环里反复报同一个错 ---
  if (!existsSync(PBPASTE)) {
    console.error(`找不到 ${PBPASTE}——这个探针只在 macOS 上跑。`);
    process.exitCode = 1;
    return;
  }
  // 显式指定了却不存在 —— 那是打错了，直接退；没指定就用包内的进程内校验器兜底。
  if (opts.validator && !existsSync(opts.validator)) {
    console.error(`找不到校验脚本: ${opts.validator}\n用 --validator=<绝对路径> 或环境变量 ARCH_VALIDATOR 指定。`);
    process.exitCode = 1;
    return;
  }
  if (!opts.validator && !engineRoot()) {
    console.error('找不到校验器：既没有外挂的 validate-spec.mjs，也找不到包内的 project/lib/spec-validator.mjs。\n'
      + '检查 project/ 目录是否完整，或用 --validator=<绝对路径> / 环境变量 ARCH_VALIDATOR 指定。');
    process.exitCode = 1;
    return;
  }
  try {
    mkdirSync(opts.inbox, { recursive: true });
  } catch (error) {
    console.error(`建不出落盘目录 ${opts.inbox}: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  log(`监听剪贴板，每 ${opts.interval}ms 读一次`);
  log(`落盘目录: ${opts.inbox}`);
  log(`校验器: ${opts.validator || '包内 project/lib/spec-validator.mjs（进程内）'}`);
  if (opts.once) log('模式: --once（收到第一份校验通过的 spec 后退出）');
  if (opts.timeout) log(`超时: ${opts.timeout}s`);

  let last = null;
  let timer = null;
  let timeoutTimer = null;
  let stopped = false;
  let accepted = 0;
  let rejected = 0;

  const stop = (code, why) => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    log(`${why}（命中 ${accepted} 份，拒绝 ${rejected} 份）`);
    emitJson({ type: 'exit', code, reason: why, accepted, rejected });
    process.exitCode = code; // 不调 process.exit()，让 stdout 自然冲干净
  };
  function onSignal() { console.log(); stop(0, '收到中断，退出'); }
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  // 启动那一刻剪贴板里已有的东西，默认当成「上一次」的基线跳过，
  // 免得驱动器一启动就把上一轮的残留当成新 spec。
  if (!opts.includeInitial) {
    try {
      last = readClipboard();
      log(`基线: 启动时剪贴板已有 ${Buffer.byteLength(last, 'utf8')} 字节，跳过（要处理它就加 --include-initial）`);
    } catch (error) {
      log(`读基线失败（不致命）: ${error.message}`);
    }
  }

  if (opts.timeout) {
    timeoutTimer = setTimeout(() => stop(3, `超时 ${opts.timeout}s 未收到合格 spec`), opts.timeout * 1000);
    timeoutTimer.unref?.();
  }

  // async：包内校验器是动态 import 的（进程内那条兜底路），所以这一轮要能 await。
  // 定时器只在每轮末尾的 schedule() 里重排，不会并发跑两轮。
  const tick = async () => {
    if (stopped) return;
    let raw;
    try {
      raw = readClipboard();
    } catch (error) {
      log(`读剪贴板失败: ${error.message}`);
      schedule();
      return;
    }
    if (raw === last) { schedule(); return; }
    last = raw;

    const bytes = Buffer.byteLength(raw, 'utf8');
    const hit = extractSpec(raw);
    if (!hit) {
      log(`剪贴板变了（${bytes} 字节），不是架构图 JSON，忽略。开头: ${preview(raw)}`);
      schedule();
      return;
    }

    log(`命中架构图 JSON（${bytes} 字节，来源: ${hit.how}，nodes=${hit.spec.nodes.length}，title=${JSON.stringify(hit.spec.title ?? null)}）`);
    emitJson({
      type: 'hit', bytes, how: hit.how,
      nodes: countNodes(hit.spec.nodes), edges: Array.isArray(hit.spec.edges) ? hit.spec.edges.length : 0,
      title: hit.spec.title ?? null,
    });

    const specPath = resolve(opts.inbox, `spec-${fileStamp()}.json`);
    try {
      writeFileSync(specPath, hit.text.endsWith('\n') ? hit.text : `${hit.text}\n`, 'utf8');
    } catch (error) {
      log(`落盘失败: ${error.message}`);
      schedule();
      return;
    }
    log(`已落盘 ${specPath}`);

    // validate-spec.mjs 用 resolve(process.cwd(), argv[2]) 解析路径，所以一定要传绝对路径。
    let code;
    let out;
    if (opts.validator) {
      const run = spawnSync(process.execPath, [opts.validator, specPath], { encoding: 'utf8' });
      code = run.status;
      out = `${run.stdout || ''}${run.stderr || ''}`.trimEnd();
    } else {
      const run = await validateInProcess(specPath);
      code = run.status;
      out = run.out.trimEnd();
    }
    log(`校验退出码: ${code}`);
    for (const line of (out ? out.split('\n') : ['(校验脚本没有输出)'])) log(`  | ${line}`);

    if (code === 0) {
      accepted += 1;
      log(`ACCEPTED ${specPath}`);
      emitJson({
        type: 'accepted', path: specPath, title: hit.spec.title ?? null,
        nodes: countNodes(hit.spec.nodes), edges: Array.isArray(hit.spec.edges) ? hit.spec.edges.length : 0,
      });
      if (opts.once) { stop(0, '--once 已拿到合格 spec'); return; }
    } else {
      rejected += 1;
      log('REJECTED 校验没过，原因见上面几行 |');
      emitJson({
        type: 'rejected', path: specPath,
        errors: (out ? out.split('\n') : []).filter((l) => l.trim().startsWith('-')).map((l) => l.trim().replace(/^-\s*/, '')),
      });
    }
    schedule();
  };

  function schedule() {
    if (stopped) return;
    timer = setTimeout(() => { tick().catch((error) => { log(`轮询出错: ${error.message}`); schedule(); }); }, opts.interval);
  }

  schedule();
}

// 节点总数（含容器的孩子），只为事件里那个数好看一点，不参与任何判定
function countNodes(nodes) {
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

function preview(text, n = 60) {
  const one = text.replace(/\s+/g, ' ').trim();
  return JSON.stringify(one.length > n ? `${one.slice(0, n)}…` : one);
}

// 「是不是被直接 node 起来的」。必须按 realpath 比（run.mjs / panel/server.mjs 里同一段注释）：
// macOS 的 /tmp 和 /var 本身就是软链（/private/…），Node 解析模块时会把 import.meta.url
// 解成真路径，而 process.argv[1] 保持原样——直接比字符串会得出「没被直接调用」，
// 于是整个脚本一声不吭地退出码 0，start.command 那边只看到监听器「跑完了」却什么也没发生。
const invokedAsScript = (() => {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  try { return realpathSync(process.argv[1]) === realpathSync(self); }
  catch { return resolve(process.argv[1]) === self; }
})();
if (invokedAsScript) main();
