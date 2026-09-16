#!/usr/bin/env node
// verify.mjs —— 豆包特供版的**验收包**：一条命令跑完，产出一个 zip 证据包。
//
// 为什么有这个文件：Windows 那条链写完了但**没有 Windows 机器可验**。那台机器上会有一个
// 代理（或一个人）替我们执行 —— 他不会排错，只会把 zip 发回来。所以这条命令要满足：
//   ① 一条命令跑完，不需要任何交互；② 任何一步失败都**照样出包**（失败信息在报告里）；
//   ③ 同一个脚本在 macOS 上一字不改地跑得起来，这边才验得了它本身。
//
// 孙毅的验收目标只有两条，报告开头就回答这两条：
//   (1) 能跑通 —— 引擎算得出、PowerPoint 画得出、pptx 落得了盘；
//   (2) 能看到在 PowerPoint 里**逐个**画的过程 —— 屏幕截图连拍 + 事件流里成对的
//       start/done 带 ms，两份互为佐证。
//
// 用法：
//   node "<技能目录>/runner/verify.mjs" [--quick] [--delay 350] [--quick-delay 0]
//                                      [--out-dir <目录>] [--spec <json>]
//
// | 参数 | 默认 | 说明 |
// |---|---|---|
// | `--quick` | 关 | 跳过「两页 deck」那一步，只验单页（快一半） |
// | `--delay <毫秒>` | 350 | 传给 run.mjs 的逐步延时。**别设 0** —— 设 0 就看不见「逐个画」了 |
// | `--quick-delay <毫秒>` | 0 | 连线与线上文字每步之后停多久，默认 0（小元素快画）；大元素仍按 `--delay` |
// | `--out-dir <目录>` | `<桌面>/架构图验收-<时间戳>/` | 证据落在哪。**必须在桌面/文稿/下载底下**，PowerPoint 沙盒只对这几处默认放行 |
// | `--spec <json>` | 引擎根的 `diagram.json`，没有就用内置兜底 | 第一页用哪份 spec |
//
// stdout：每一步一行人话进度，**最后两行固定**是
//   `结论：通过` 或 `结论：失败 —— <一句话>`
//   `验收包：<zip 绝对路径>`
// 退出码 0 = 通过，1 = 失败（失败时 zip 照样出）。
//
// 跑完产出（默认落桌面）：
//   架构图验收-<平台>-<时间戳>.zip          ← 发回来的就是这一个
//   架构图验收-<时间戳>/                     ← 同一份内容摊开，方便直接翻
//     验收报告.md            开头一段人话 + 环境表 + 逐步结论 + 形状数对照 + 事件流统计
//     env.json               环境快照（机器可读）
//     架构图验收-单页.pptx / 架构图验收-两页.pptx
//     steps-single.jsonl / steps-deck.jsonl      事件流（panel/CONTRACT.md 的格式）
//     shots-single/ shots-deck/                  每 500ms 一张全屏，最多 240 张
//     deck-两页.json         第二步用的 deck（第一页 = --spec，第二页 = 内置小图）
//
// 约束（改这个文件之前先看一眼）：
//   * 只用 Node 标准库 + 已有的 `project/lib`，零 npm 依赖；
//   * 引擎根走 `draw.mjs` 导出的 `ENGINE_ROOT`（向上找含 project/generate.mjs 的那层），
//     **不许写死层数** —— 开发仓里深 3 层，出货包里深 1 层；
//   * 路径带空格、中文都要能跑：一律 spawn + 参数数组，不拼 shell 字符串；
//   * 不 `process.chdir`；
//   * Windows 的 PowerShell 片段写成 **UTF-8 带 BOM** 的临时 .ps1 再 `-File` 执行 ——
//     跟驱动器同一套规矩（`project/drivers/win-powerpoint.mjs` 差异 5：5.1 读无 BOM 的
//     UTF-8 会按系统 ANSI 代码页解，中文全成乱码而且不报错）。
//
// **平台判断用 `process.platform`，不是 draw.mjs 的 `DRIVER_PLATFORM`**：后者认
// `ARCH_DOUBAO_PLATFORM=win32` 这个测试口子，而截屏、解包这些是真真切切要看本机是谁。

import { spawn } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync,
  realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { arch, release, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  ENGINE_ROOT, RUNNER_DIR, desktopDir, uniqueOut, readAndValidateSpec, buildPlan,
} from './draw.mjs';

const { buildStoreZip } = await import(
  pathToFileURL(join(ENGINE_ROOT, 'project/lib/exporters/minimal-zip.mjs')).href
);

/* ══ 0. 常量与小工具 ══════════════════════════════════════════════════════ */

const USAGE = `用法: node verify.mjs [--quick] [--delay 350] [--quick-delay 0]
                     [--out-dir <目录>] [--spec <json>]

一条命令跑完豆包特供版的验收，产出一个 zip 证据包（默认落桌面）。
任何一步失败都照样出包 —— 把 zip 发回去就行，判读不用在这台机器上做。

  --quick          跳过「两页 deck」那一步，只验单页
  --delay <毫秒>   传给 run.mjs 的逐步延时，默认 350（别设 0，设 0 就看不见逐个画）
  --quick-delay <毫秒>
                   连线与线上文字每步之后停多久，默认 0（小元素快画）；大元素仍按 --delay
  --out-dir <目录> 证据落在哪，默认 <桌面>/架构图验收-<时间戳>/
  --spec <json>    第一页用哪份 spec，默认引擎根的 diagram.json（出货包里没有那份，
                   会退回 verify.mjs 自带的兜底示例，写进证据目录）

最后两行固定是「结论：通过 / 结论：失败 —— …」和「验收包：<zip 绝对路径>」。
退出码 0 = 通过。`;

/** 截屏节奏与上限：每 500ms 一张，最多 240 张 = 2 分钟。超了就停，不让证据包无限长。 */
export const SHOT_INTERVAL_MS = 500;
export const SHOT_MAX = 240;
/** 截图长边缩到这个像素再存。5K 屏原图 2.4MB/张 × 240 张 = 570MB，装不进一个能发的包。 */
const SHOT_MAX_DIM = 1600;
/** minimal-zip 是全内存拼的（STORE 不压缩）。超过这个总量就退回平台自带的打包工具。 */
const ZIP_MEMORY_LIMIT = 400 * 1024 * 1024;
/** 真画那一步的兜底超时。远端没人盯着，PowerPoint 真挂死了得有人把它掐掉再出包。 */
const DRAW_TIMEOUT_MS = 15 * 60 * 1000;

const IS_WIN = process.platform === 'win32';
const PLATFORM_NAME = IS_WIN ? 'Windows' : (process.platform === 'darwin' ? 'macOS' : process.platform);

const pad = (n, w = 2) => String(n).padStart(w, '0');
const stampOf = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
  + `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
/** 压成一行：结论行、表格单元格里不许出现换行。 */
const oneLine = (t) => String(t == null ? '' : t).replace(/\s*[\r\n]+\s*/g, ' / ').trim();
/** run.mjs 的结论行自带「失败：」前缀，转述时剥掉，别叠成「校验失败：失败：…」。 */
export const stripFail = (t) => String(t == null ? '' : t).replace(/^失败：/, '').trim();

/* ══ 1. 内置 spec ═════════════════════════════════════════════════════════
 * 第一页优先用引擎根的 `diagram.json`（开发仓里有，跟文档里的 34 步 / 46 形状对得上）。
 * **出货包里没有那份文件** —— `dist-manifest.doubao.json` 不投影它（冒烟时是从开发仓临时
 * 递进去的）。所以必须自带一份兜底，否则装了技能包的人跑 `node runner/verify.mjs`
 * 第一步就报「spec 读不了」，「一条命令跑完」当场作废。
 * 兜底这份带容器和嵌套容器，跟 diagram.json 一个量级，验的东西不缩水。
 */
export const FALLBACK_FIRST_SPEC = Object.freeze({
  title: '验收示例 · 订单系统架构',
  subtitle: '这份图是 verify.mjs 自带的兜底 spec（引擎根没有 diagram.json 时用它）',
  layout: 'B',
  direction: 'RIGHT',
  nodes: [
    { id: 'client', label: '用户端', sublabel: 'Web · 小程序', variant: 'accent' },
    {
      id: 'access',
      label: '接入层',
      variant: 'container',
      children: [
        { id: 'gateway', label: 'API 网关', sublabel: '限流 · 路由' },
        { id: 'auth', label: '鉴权服务', sublabel: 'OAuth2' },
      ],
    },
    {
      id: 'core',
      label: '交易核心',
      variant: 'container',
      children: [
        { id: 'order', label: '订单服务', sublabel: '下单 · 改单' },
        {
          id: 'pay',
          label: '支付域',
          variant: 'container',
          children: [
            { id: 'cashier', label: '收银台', sublabel: '渠道路由', variant: 'accent' },
            { id: 'settle', label: '清结算', sublabel: '对账 · 分账' },
          ],
        },
        { id: 'stock', label: '库存服务', sublabel: '扣减 · 回滚' },
      ],
    },
    {
      id: 'infra',
      label: '基础设施',
      variant: 'container',
      children: [
        { id: 'db', label: '订单库', sublabel: 'MySQL 分库分表' },
        { id: 'mq', label: '消息队列', sublabel: '削峰 · 异步' },
        { id: 'obs', label: '可观测', sublabel: '日志 · 追踪' },
      ],
    },
  ],
  edges: [
    { source: 'client', target: 'gateway', label: 'HTTPS' },
    { source: 'gateway', target: 'auth', label: '校验' },
    { source: 'gateway', target: 'order', label: '下单' },
    { source: 'order', target: 'cashier', label: '收款' },
    { source: 'order', target: 'stock', label: '锁库存' },
    { source: 'cashier', target: 'settle', label: '结算' },
    { source: 'order', target: 'db', label: '落库' },
    { source: 'order', target: 'mq', label: '事件' },
    { source: 'settle', target: 'obs', label: '遥测' },
  ],
});

/**
 * 第一页用哪份 spec。三选一，优先级从高到低：
 *   1. `--spec` 明确指定的；
 *   2. 引擎根的 `diagram.json`（开发仓里有）；
 *   3. 内置的 `FALLBACK_FIRST_SPEC`（写进证据目录，顺带进包，别人能照着复现）。
 *
 * @returns {{ path: string, source: string }} source 是给报告里那张环境表看的人话
 */
export function resolveFirstSpec({ explicit, engineRoot, outDir, write = writeFileSync }) {
  if (explicit) return { path: explicit, source: '--spec 指定' };
  const bundled = join(engineRoot, 'diagram.json');
  if (existsSync(bundled)) return { path: bundled, source: '引擎根的 diagram.json' };
  const fallback = join(outDir, 'spec-第一页.json');
  write(fallback, `${JSON.stringify(FALLBACK_FIRST_SPEC, null, 2)}\n`, 'utf8');
  return { path: fallback, source: 'verify.mjs 自带的兜底示例（引擎根没有 diagram.json）' };
}

/* ══ 1b. 第二页：写死在这里的 6 节点小图 ══════════════════════════════════
 * deck 那一步要证明「一份 PPT 里能画多套架构图」，第二页故意跟第一页不一样：
 * 没有容器、节点少、标题是**中英混排**（`数据链路 Pipeline`）—— PowerPoint 会把中英
 * 拆成两个 run 存进 slideXml，核对标题时必须先把 `<a:t>` 拼起来再找，这一页就是那条断言的靶子。
 */
export const SECOND_PAGE_SPEC = Object.freeze({
  title: '数据链路 Pipeline',
  subtitle: '验收第二页 · 6 个节点，无容器',
  layout: 'B',
  direction: 'RIGHT',
  nodes: [
    { id: 'src', label: '数据源', sublabel: '日志 · 埋点', variant: 'accent' },
    { id: 'collect', label: '采集', sublabel: 'Agent' },
    { id: 'queue', label: '消息队列', sublabel: 'Kafka' },
    { id: 'etl', label: '清洗加工', sublabel: 'Flink' },
    { id: 'store', label: '数据仓库', sublabel: 'ClickHouse' },
    { id: 'bi', label: '报表看板', sublabel: 'BI', variant: 'accent' },
  ],
  edges: [
    { source: 'src', target: 'collect', label: '上报' },
    { source: 'collect', target: 'queue' },
    { source: 'queue', target: 'etl' },
    { source: 'etl', target: 'store', label: '落库' },
    { source: 'store', target: 'bi', label: '查询' },
  ],
});

/* ══ 2. 纯函数：pptx 解包之后怎么数 ═══════════════════════════════════════ */

/**
 * 一页 slideXml 里有多少个形状。
 *
 * **不能裸 `indexOf('<p:sp')`** —— `<p:spPr>`（形状属性）和 `<p:spTree>`（形状树）
 * 都以它开头，一页会多数出几十个。所以后面必须跟一个「标签名结束」的字符。
 * 闭合标签 `</p:sp>` 天然不匹配（它是 `</p:sp`，没有 `<p:sp`）。
 *
 * @returns {{ sp: number, cxnSp: number, total: number }} total = sp + cxnSp
 */
export function countShapesInSlideXml(xml) {
  const text = String(xml == null ? '' : xml);
  const sp = (text.match(/<p:sp(?=[\s>/])/g) || []).length;
  const cxnSp = (text.match(/<p:cxnSp(?=[\s>/])/g) || []).length;
  return { sp, cxnSp, total: sp + cxnSp };
}

/** XML 实体还原。`&amp;` 必须**最后**换，不然 `&amp;lt;` 会被二次解成 `<`。 */
export function xmlUnescape(text) {
  return String(text == null ? '' : text)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * 一页 slideXml 里的全部文字，**按出现顺序拼成一串**。
 *
 * 为什么不直接 grep 标题：PowerPoint 存盘时会按字体/语言把一段文字切成多个 run，
 * 中英混排的「数据链路 Pipeline」很可能存成 `<a:t>数据链路 </a:t><a:t>Pipeline</a:t>`。
 * 直接找整串必然落空，而那是**假阴性**——标题其实画对了。
 */
export function slideTextOf(xml) {
  const text = String(xml == null ? '' : xml);
  const out = [];
  const re = /<a:t>([\s\S]*?)<\/a:t>/g;
  let m = re.exec(text);
  while (m) { out.push(xmlUnescape(m[1])); m = re.exec(text); }
  return out.join('');
}

/** 比对标题时两边都抹掉空白：run 拆分处的空格有没有留下来不该影响结论。 */
export const squash = (s) => String(s == null ? '' : s).replace(/\s+/g, '');

/** 一页的标题在不在这页的文字里。标题是空的（没写 title）就算命中，不制造假红。 */
export function slideHasTitle(xml, title) {
  const want = squash(title);
  if (!want) return true;
  return squash(slideTextOf(xml)).includes(want);
}

/* ══ 3. 纯函数：事件流怎么统计 ════════════════════════════════════════════ */

/**
 * 把一份 steps.jsonl（panel/CONTRACT.md 的格式）折成统计。
 * 「逐个画」的机器证据就在这里：`step` 事件 start/done 成对、每个 done 带 `ms`、
 * 最后有 `phase:done`。三条都成立才说明它真的是一步一步画的，而不是一次性写盘。
 *
 * @returns {{ lines, bad, starts, dones, paired, unpaired: number[], missingMs: number[],
 *             hasDone: boolean, totalMs: number, slowest: object|null,
 *             slides: number|null, shapes: number|null, elapsedMs: number|null,
 *             file: string|null, phases: string[] }}
 */
export function summarizeEvents(text) {
  const out = {
    lines: 0, bad: 0, starts: 0, dones: 0, paired: false, unpaired: [], missingMs: [],
    hasDone: false, totalMs: 0, slowest: null,
    slides: null, shapes: null, elapsedMs: null, file: null, phases: [],
  };
  const seen = new Map();   // i → { start: n, done: n, ms: number|null }
  for (const raw of String(text == null ? '' : text).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    out.lines += 1;
    let e;
    try { e = JSON.parse(line); } catch { out.bad += 1; continue; }
    if (!e || typeof e !== 'object') { out.bad += 1; continue; }
    if (e.type === 'phase') {
      out.phases.push(String(e.phase));
      if (e.phase === 'done') {
        out.hasDone = true;
        out.slides = e.slides != null ? Number(e.slides) : out.slides;
        out.shapes = e.shapes != null ? Number(e.shapes) : out.shapes;
        out.elapsedMs = e.elapsedMs != null ? Number(e.elapsedMs) : out.elapsedMs;
        out.file = e.file != null ? String(e.file) : out.file;
      }
      continue;
    }
    if (e.type !== 'step') continue;
    const i = Number(e.i);
    const slot = seen.get(i) || { start: 0, done: 0, ms: null };
    if (e.status === 'start') { slot.start += 1; out.starts += 1; }
    else if (e.status === 'done') {
      slot.done += 1;
      out.dones += 1;
      if (Number.isFinite(Number(e.ms))) {
        slot.ms = Number(e.ms);
        out.totalMs += slot.ms;
        if (!out.slowest || slot.ms > out.slowest.ms) {
          out.slowest = { i, kind: e.kind ?? null, label: e.label ?? null, ms: slot.ms };
        }
      } else {
        out.missingMs.push(i);
      }
    }
    seen.set(i, slot);
  }
  for (const [i, slot] of [...seen.entries()].sort((a, b) => a[0] - b[0])) {
    if (slot.start !== 1 || slot.done !== 1) out.unpaired.push(i);
  }
  out.paired = seen.size > 0 && out.unpaired.length === 0 && out.missingMs.length === 0;
  return out;
}

/**
 * 事件流统计 → 报告里的一行。
 *
 * **`file` 必须是 jsonl 的名字**，不能让 `...ev` 盖掉：`summarizeEvents` 折出来的 `ev.file`
 * 是 `phase:done` 里那个 **pptx 绝对路径**，同名。写成 `{ file: name, ...ev }` 的话，
 * 报告「事件流」那一列会整列显示 pptx 路径 —— 表格看着还挺正常，但它答非所问
 * （2026-09-13 第一次真跑就是这样，肉眼才发现）。
 */
export const eventRow = (fileName, ev) => ({ ...ev, file: fileName });

/* ══ 4. 纯函数：报告怎么渲染 ══════════════════════════════════════════════ */

const mark = (ok) => (ok == null ? '—' : (ok ? '通过' : '**失败**'));

/**
 * 验收报告（Markdown）。**开头一段是写给人看的**：两条目标各自过没过、
 * 翻哪张截图能看见「画到一半」的 PowerPoint。后面的表格才是给判读用的。
 * 纯函数：进去一个 model，出来一段文本，不碰文件系统 —— 测试直接打在这一层。
 */
export function renderReport(model) {
  const m = model || {};
  const L = [];
  const conclusion = m.conclusion || { ok: false, reason: '没跑完' };
  const goals = m.goals || {};
  const shotHint = m.shotHint || null;

  L.push(`# 架构图 · 豆包特供版验收报告（${m.platform || '未知平台'}）`);
  L.push('');
  L.push(`生成时间：${m.generatedAt || '—'}　　结论：**${conclusion.ok ? '通过' : `失败 —— ${oneLine(conclusion.reason)}`}**`);
  L.push('');
  L.push('## 先看这一段');
  L.push('');
  L.push('这份包回答的就两个问题，别的都是佐证材料。');
  L.push('');
  L.push(`**① 能跑通吗** —— ${mark(goals.runnable)}。${oneLine(goals.runnableWhy || '')}`);
  L.push('');
  L.push(`**② 能看见它在 PowerPoint 里一个一个画吗** —— ${mark(goals.visible)}。${oneLine(goals.visibleWhy || '')}`);
  if (shotHint) {
    L.push('');
    L.push(`看这张：\`${shotHint}\` —— 屏幕连拍的中间一张，PowerPoint 窗口里图只画了一半。`
      + '整段过程翻 `shots-single/` 从头到尾。');
  }
  L.push('');
  L.push('两条证据是互相独立的：截图是**眼睛看到的**，`steps-*.jsonl` 里成对的 '
    + '`start`/`done`（每条 `done` 带真实耗时 `ms`）是**机器记下来的**。'
    + '一次性写盘的导出不会产生这种事件流。');
  L.push('');

  L.push('## 环境');
  L.push('');
  L.push('| 项 | 值 |');
  L.push('|---|---|');
  for (const [k, v] of Object.entries(m.env || {})) L.push(`| ${k} | ${oneLine(v)} |`);
  L.push('');

  L.push('## 每一步的结论');
  L.push('');
  L.push('| 步骤 | 结论 | 说明 |');
  L.push('|---|---|---|');
  for (const s of m.steps || []) L.push(`| ${s.name} | ${mark(s.ok)} | ${oneLine(s.note || '')} |`);
  L.push('');

  L.push('## 形状数对照（pptx 解包后逐页数）');
  L.push('');
  if (!(m.shapeRows || []).length) {
    L.push('（没有可对照的 pptx —— 真画那一步没跑到或没跑成。）');
  } else {
    L.push('| pptx | 第几页 | 引擎预期 | `<p:sp>` | `<p:cxnSp>` | 实得合计 | 形状数 | 标题命中 |');
    L.push('|---|---|---|---|---|---|---|---|');
    for (const r of m.shapeRows) {
      L.push(`| ${r.file} | ${r.slide} | ${r.expected} | ${r.sp} | ${r.cxnSp} | ${r.total} |`
        + ` ${mark(r.countOk)} | ${mark(r.titleOk)}（${oneLine(r.title || '（无标题）')}） |`);
    }
  }
  L.push('');

  L.push('## 事件流统计');
  L.push('');
  if (!(m.eventRows || []).length) {
    L.push('（没有事件流 —— 真画那一步没跑到。）');
  } else {
    L.push('| 事件流 | 行数 | start/done | 配对 | `phase:done` | 步耗时合计 | 最慢一步 |');
    L.push('|---|---|---|---|---|---|---|');
    for (const r of m.eventRows) {
      const slow = r.slowest
        ? `#${r.slowest.i} ${r.slowest.kind || ''} ${oneLine(r.slowest.label || '')} ${r.slowest.ms}ms`
        : '—';
      L.push(`| ${r.file} | ${r.lines} | ${r.starts}/${r.dones} | ${mark(r.paired)} |`
        + ` ${mark(r.hasDone)} | ${r.totalMs}ms | ${slow} |`);
    }
  }
  L.push('');

  L.push('## 屏幕连拍');
  L.push('');
  L.push('截图是**整块屏幕的原样**。`run.mjs` 会把 PowerPoint 拉到前台（`activate`），'
    + '但要是这台机器上有别的窗口压在它上面，图里看到的就是那个窗口 —— '
    + '那说明「拉到前台」没生效，**不是没画**（画没画看形状数对照表和事件流）。'
    + '连拍每 500ms 一张，跟前一张一模一样的会被删掉，所以编号出现空档是正常的：空档 = 那段时间画面没动。');
  L.push('');
  if (!(m.shotRows || []).length) {
    L.push('（没有截图。）');
  } else {
    L.push('| 目录 | 张数 | 第一张 | 最后一张 | 说明 |');
    L.push('|---|---|---|---|---|');
    for (const r of m.shotRows) {
      L.push(`| ${r.dir} | ${r.count} | ${r.first || '—'} | ${r.last || '—'} | ${oneLine(r.note || '')} |`);
    }
  }
  L.push('');

  if (m.tail && (m.tail.lines || []).length) {
    L.push(`## 失败现场：\`${m.tail.step}\` 的最后 ${m.tail.lines.length} 行原文`);
    L.push('');
    L.push('```');
    for (const line of m.tail.lines) L.push(line);
    L.push('```');
    L.push('');
  }

  L.push('## 包里都有什么');
  L.push('');
  L.push('```');
  for (const f of m.files || []) L.push(f);
  L.push('```');
  L.push('');
  L.push(`打包方式：${m.packer || '—'}`);
  L.push('');
  return L.join('\n');
}

/* ══ 5. 起子进程 ══════════════════════════════════════════════════════════ */

/**
 * 跑一条 node 命令，把 stdout / stderr 逐行收下来。**不抛异常**。
 * @returns {Promise<{ code: number, out: string[], all: string[], lastLine: string }>}
 *          `lastLine` 按 run.mjs 的输出契约取 **stdout** 的最后一行（stdout 空了才退回合并流）
 */
function runNode(args, { cwd, timeoutMs = 0 } = {}) {
  return new Promise((done) => {
    const out = [];
    const all = [];
    let child;
    try {
      child = spawn(process.execPath, args, { cwd: cwd || ENGINE_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      done({ code: -1, out: [], all: [`起不来：${error.message}`], lastLine: `起不来：${error.message}` });
      return;
    }
    // 兜底超时：远端那台机器上没人盯着，PowerPoint 真挂死了得有人把它掐掉
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        all.push(`（verify.mjs 等了 ${Math.round(timeoutMs / 1000)} 秒还没结束，已强制结束）`);
        try { child.kill('SIGKILL'); } catch { /* 已经走了 */ }
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    }
    const feed = (bucket) => {
      let buf = '';
      return (chunk) => {
        buf += chunk;
        const parts = buf.split(/\r?\n/);
        buf = parts.pop();
        for (const line of parts) { bucket.push(line); all.push(line); }
      };
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', feed(out));
    child.stderr.on('data', feed([]));
    child.on('error', (error) => { all.push(`起不来：${error.message}`); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      const pick = (list) => {
        for (let i = list.length - 1; i >= 0; i -= 1) if (list[i].trim()) return list[i].trim();
        return '';
      };
      done({ code: code == null ? -1 : code, out, all, lastLine: pick(out) || pick(all) });
    });
  });
}

/** 把一段 PowerShell 写成 UTF-8 **带 BOM** 的临时 .ps1（5.1 不带 BOM 会把中文读坏）。 */
function writePs1(text, name = 'verify.ps1') {
  const dir = join(tmpdir(), `arch-verify-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `﻿${text}`, 'utf8');
  return { dir, path };
}

const PS_ARGS = (script, extra = []) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...extra];

/** 跑一段 PowerShell，等它结束。**不抛异常**。 */
function runPs1(text, extra = [], { timeoutMs = 60000, name = 'verify.ps1' } = {}) {
  return new Promise((done) => {
    let tmp;
    try { tmp = writePs1(text, name); } catch (error) { done({ ok: false, out: `写不了临时脚本：${error.message}` }); return; }
    let child;
    try {
      child = spawn('powershell.exe', PS_ARGS(tmp.path, extra), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      try { rmSync(tmp.dir, { recursive: true, force: true }); } catch { /* 清不掉就算了 */ }
      done({ ok: false, out: `起不来 powershell.exe：${error.message}` });
      return;
    }
    let buf = '';
    let killed = false;
    const timer = setTimeout(() => { killed = true; try { child.kill(); } catch { /* 已经走了 */ } }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const grab = (c) => { if (buf.length < 8000) buf += c; };
    child.stdout.on('data', grab);
    child.stderr.on('data', grab);
    child.on('error', (error) => {
      clearTimeout(timer);
      try { rmSync(tmp.dir, { recursive: true, force: true }); } catch { /* 同上 */ }
      done({ ok: false, out: `起不来 powershell.exe：${error.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      try { rmSync(tmp.dir, { recursive: true, force: true }); } catch { /* 同上 */ }
      done({ ok: !killed && code === 0, out: buf.trim() });
    });
  });
}

/** 跑一条外部命令收 stdout。**不抛异常**。 */
function runCmd(cmd, args, { timeoutMs = 60000, cwd } = {}) {
  return new Promise((done) => {
    let child;
    try { child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...(cwd ? { cwd } : {}) }); }
    catch (error) { done({ ok: false, out: `${cmd} 起不来：${error.message}` }); return; }
    let buf = '';
    let killed = false;
    const timer = setTimeout(() => { killed = true; try { child.kill(); } catch { /* 已经走了 */ } }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const grab = (c) => { if (buf.length < 8000) buf += c; };
    child.stdout.on('data', grab);
    child.stderr.on('data', grab);
    child.on('error', (error) => { clearTimeout(timer); done({ ok: false, out: `${cmd} 起不来：${error.message}` }); });
    child.on('close', (code) => { clearTimeout(timer); done({ ok: !killed && code === 0, out: buf.trim() }); });
  });
}

/* ══ 6. 屏幕连拍 ══════════════════════════════════════════════════════════
 * 两个平台各一套，**接口一样**：`start(dir)` → `stop()`。
 *   macOS ：每张起一次 `screencapture -x -C -m`（0.3 秒），再 `sips -Z` 把长边缩到 1600
 *           （5K 全屏原图 2.4MB/张，240 张就 570MB，装不进一个能发的包；缩完 ~340KB）。
 *   Windows：**起一个常驻 PowerShell 子进程自己循环**（每张新起一个进程要 0.5–1 秒，
 *           节奏就没了），缩放用 `Graphics.DrawImage` 在进程里做完。
 *           停：Node 建一个哨兵文件，脚本每轮检查一次，看见就退出。
 */
const PS_SHOOTER = `# 由 shells/doubao/runner/verify.mjs 生成的连拍脚本，不要手改
param([string]$Dir, [int]$Max = 240, [int]$IntervalMs = 500, [string]$StopFile = '', [int]$MaxDim = 1600)
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
$pBounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$pI = 0
while ($pI -lt $Max) {
  if ($StopFile -ne '' -and (Test-Path -LiteralPath $StopFile)) { break }
  $pI = $pI + 1
  try {
    $pFull = New-Object System.Drawing.Bitmap($pBounds.Width, $pBounds.Height)
    $pG = [System.Drawing.Graphics]::FromImage($pFull)
    $pG.CopyFromScreen($pBounds.X, $pBounds.Y, 0, 0, $pFull.Size)
    $pG.Dispose()
    $pShot = $pFull
    $pLong = [Math]::Max($pBounds.Width, $pBounds.Height)
    if ($pLong -gt $MaxDim) {
      $pScale = $MaxDim / $pLong
      $pW = [int]($pBounds.Width * $pScale)
      $pH = [int]($pBounds.Height * $pScale)
      $pSmall = New-Object System.Drawing.Bitmap($pW, $pH)
      $pG2 = [System.Drawing.Graphics]::FromImage($pSmall)
      $pG2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $pG2.DrawImage($pFull, 0, 0, $pW, $pH)
      $pG2.Dispose()
      $pFull.Dispose()
      $pShot = $pSmall
    }
    $pName = Join-Path $Dir ('{0:D3}.png' -f $pI)
    $pShot.Save($pName, [System.Drawing.Imaging.ImageFormat]::Png)
    $pShot.Dispose()
  } catch { }
  Start-Sleep -Milliseconds $IntervalMs
}
`;

function makeShooter(dir) {
  mkdirSync(dir, { recursive: true });
  const state = { stopped: false, note: '', child: null, tmp: null, loop: null, stopFile: join(dir, '.stop') };

  if (IS_WIN) {
    try {
      state.tmp = writePs1(PS_SHOOTER, 'shoot.ps1');
      state.child = spawn(
        'powershell.exe',
        PS_ARGS(state.tmp.path, [
          '-Dir', dir, '-Max', String(SHOT_MAX), '-IntervalMs', String(SHOT_INTERVAL_MS),
          '-StopFile', state.stopFile, '-MaxDim', String(SHOT_MAX_DIM),
        ]),
        { stdio: 'ignore', windowsHide: true },
      );
      state.child.on('error', (error) => { state.note = `连拍起不来：${error.message}`; });
    } catch (error) {
      state.note = `连拍起不来：${error.message}`;
    }
  } else {
    state.loop = (async () => {
      for (let i = 1; i <= SHOT_MAX && !state.stopped; i += 1) {
        const t0 = Date.now();
        const file = join(dir, `${pad(i, 3)}.png`);
        // eslint-disable-next-line no-await-in-loop
        const shot = await runCmd('screencapture', ['-x', '-C', '-m', file], { timeoutMs: 15000 });
        if (!shot.ok && !state.note) state.note = `screencapture 报错：${oneLine(shot.out) || '（无输出）'}`;
        // 退出码 0 但文件没出来 = 多半是「屏幕录制」权限没给。这一条必须说出来，
        // 不然报告只会写「截图 0 张」，远端那位不知道该去点哪个开关。
        if (shot.ok && !existsSync(file) && !state.note) {
          state.note = 'screencapture 退出码 0 但没生成文件 —— 多半是本机没给「屏幕录制」权限';
        }
        // 缩不动就留原图：证据在，包大一点而已
        // eslint-disable-next-line no-await-in-loop
        if (shot.ok) await runCmd('sips', ['-Z', String(SHOT_MAX_DIM), file], { timeoutMs: 15000 });
        const rest = SHOT_INTERVAL_MS - (Date.now() - t0);
        // eslint-disable-next-line no-await-in-loop
        if (rest > 0) await sleep(rest);
      }
    })();
  }

  return {
    async stop() {
      state.stopped = true;
      if (IS_WIN) {
        try { writeFileSync(state.stopFile, 'stop', 'utf8'); } catch { /* 建不了就直接 kill */ }
        const child = state.child;
        if (child && child.exitCode == null) {
          await Promise.race([
            new Promise((r) => { child.once('close', r); }),
            sleep(3000),
          ]);
          if (child.exitCode == null) { try { child.kill(); } catch { /* 已经走了 */ } }
        }
        if (state.tmp) { try { rmSync(state.tmp.dir, { recursive: true, force: true }); } catch { /* 清不掉就算了 */ } }
        try { rmSync(state.stopFile, { force: true }); } catch { /* 同上 */ }
      } else if (state.loop) {
        await state.loop;
      }
      return { note: state.note, ...listShots(dir) };
    },
  };
}

/**
 * 把**跟前一张一模一样**的截图删掉，返回剩下的清单。
 *
 * 为什么要这一步：卡住的时候连拍最有用，但也最没用 —— 2026-09-13 本机实测，保存那一步
 * 挂了两分钟，240 张里有 200 多张是同一个「授予文件访问权限」对话框，一份证据包 317MB。
 * 逐字节比一遍，重复的删掉，剩下的编号会出现空档 —— **空档本身就是信息**：那段时间画面没动。
 *
 * 只跟「上一张**留下来的**」比，不是两两全比：画面 A→B→A 的三张要全留，那是真的动过。
 */
export function dedupeShots(dir) {
  const before = listShots(dir);
  let prev = null;
  let dropped = 0;
  for (const name of before.names) {
    const path = join(dir, name);
    let buf;
    try { buf = readFileSync(path); } catch { continue; }
    if (prev && prev.length === buf.length && prev.equals(buf)) {
      try { rmSync(path, { force: true }); dropped += 1; continue; } catch { /* 删不掉就留着 */ }
    }
    prev = buf;
  }
  return { ...listShots(dir), dropped };
}

/** 数一个 shots 目录：几张、第一张和最后一张是什么时候拍的。 */
export function listShots(dir) {
  let names = [];
  try { names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.png')).sort(); }
  catch { return { count: 0, first: null, last: null, names: [] }; }
  const at = (n) => {
    try { return new Date(statSync(join(dir, n)).mtimeMs).toISOString(); } catch { return null; }
  };
  return {
    count: names.length,
    first: names.length ? at(names[0]) : null,
    last: names.length ? at(names[names.length - 1]) : null,
    names,
  };
}

/* ══ 7. pptx 解包 ═════════════════════════════════════════════════════════
 * 两边都**先把 .pptx 复制成 .zip 再解**：Expand-Archive 只认 .zip 后缀，
 * mac 的 unzip 虽然不挑，但两边同一套动作，出问题时少一个变量。
 */
export async function unpackPptx(pptxPath, workDir) {
  mkdirSync(workDir, { recursive: true });
  const zipPath = join(workDir, 'copy.zip');
  const outDir = join(workDir, 'x');
  try { copyFileSync(pptxPath, zipPath); }
  catch (error) { return { ok: false, why: `复制不了 pptx：${error.message}`, slides: [] }; }
  mkdirSync(outDir, { recursive: true });

  const r = IS_WIN
    ? await runPs1(
      "# 由 verify.mjs 生成的解包脚本\nparam([string]$Zip, [string]$Dest)\n"
      + "Expand-Archive -LiteralPath $Zip -DestinationPath $Dest -Force\n",
      ['-Zip', zipPath, '-Dest', outDir], { name: 'unzip.ps1' },
    )
    : await runCmd('unzip', ['-o', '-q', zipPath, '-d', outDir]);
  if (!r.ok) return { ok: false, why: `解包失败：${oneLine(r.out) || '（无输出）'}`, slides: [] };

  const slideDir = join(outDir, 'ppt', 'slides');
  let names = [];
  try {
    names = readdirSync(slideDir)
      .filter((n) => /^slide\d+\.xml$/.test(n))
      .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  } catch (error) {
    return { ok: false, why: `包里没有 ppt/slides/：${error.message}`, slides: [] };
  }
  const slides = names.map((n) => ({ name: n, xml: readFileSync(join(slideDir, n), 'utf8') }));
  return { ok: true, why: '', slides };
}

/* ══ 8. 打包 ══════════════════════════════════════════════════════════════ */

/** 一个目录下的全部文件（相对路径），按名字排序。 */
function walk(dir, prefix = '') {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const files = [];
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.name.startsWith('.')) continue;      // .unpack / .stop 之类的中间物不进包
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) files.push(...walk(join(dir, e.name), rel));
    else files.push(rel);
  }
  return files;
}

/** 目录总字节数，用来决定拿哪个打包器。数不到的按 0 算。 */
function totalBytes(outDir, rels) {
  let total = 0;
  for (const rel of rels) {
    try { total += statSync(join(outDir, rel)).size; } catch { /* 数不到就当 0 */ }
  }
  return total;
}

/**
 * 用哪个打包器。**报告里要写这一行，所以必须在打包之前就能算出来** ——
 * `minimal-zip` 是全内存拼的（STORE 不压缩），几百 MB 的截图会把内存顶到两倍，
 * 超过上限就退回平台自带的工具。
 */
export function pickPacker(total, isWin = IS_WIN) {
  if (total <= ZIP_MEMORY_LIMIT) return 'minimal-zip';
  return isWin ? 'Compress-Archive' : 'zip -r';
}

/** 把 outDir 整个打成一个 zip。zip 里带一层 outDir 的目录名，解出来就是一个文件夹。 */
async function packEvidence(outDir, zipPath, rels, total) {
  const top = basename(outDir);
  if (pickPacker(total) === 'minimal-zip') {
    try {
      const entries = rels.map((rel) => ({ name: `${top}/${rel}`, data: readFileSync(join(outDir, rel)) }));
      writeFileSync(zipPath, Buffer.from(buildStoreZip(entries)));
      return { ok: true, packer: 'minimal-zip', why: '' };
    } catch (error) {
      // 内存不够或读不了某个文件：往下退到平台工具，别让整个包丢了
      const fallback = await platformZip(outDir, zipPath);
      return { ...fallback, packer: `${fallback.packer}（minimal-zip 失败：${oneLine(error.message)}）` };
    }
  }
  return platformZip(outDir, zipPath);
}

/** 平台自带的打包工具。两边都在 outDir 的**父目录**里跑，包里才带那一层目录名。 */
async function platformZip(outDir, zipPath) {
  if (IS_WIN) {
    const r = await runPs1(
      '# 由 verify.mjs 生成的打包脚本\nparam([string]$Src, [string]$Zip)\n'
      + 'Compress-Archive -LiteralPath $Src -DestinationPath $Zip -Force\n',
      ['-Src', outDir, '-Zip', zipPath], { timeoutMs: 300000, name: 'zip.ps1' },
    );
    return { ok: r.ok, packer: 'Compress-Archive', why: r.ok ? '' : oneLine(r.out) };
  }
  const r = await runCmd('zip', ['-r', '-q', zipPath, basename(outDir)], { timeoutMs: 300000, cwd: dirname(outDir) });
  return { ok: r.ok, packer: 'zip -r', why: r.ok ? '' : oneLine(r.out) };
}

/* ══ 9. 主流程 ════════════════════════════════════════════════════════════ */

export function parseArgs(argv) {
  // quickDelay：连线与线上文字（draw-steps 的 DRAW_QUICK_KINDS）那一档停顿，默认 0 = 小元素快画
  const opts = {
    quick: false, delay: 350, quickDelay: 0, outDir: null, spec: null, dryOnly: false, help: false,
  };
  const abs = (v) => (isAbsolute(v) ? v : resolve(process.cwd(), v));
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const inline = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : null;
    const key = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    const take = () => { if (inline != null) return inline; i += 1; return argv[i]; };
    switch (key) {
      case '--quick': opts.quick = true; break;
      case '--delay': opts.delay = Number(take()); break;
      case '--quick-delay': opts.quickDelay = Number(take()); break;
      case '--out-dir': opts.outDir = abs(take()); break;
      case '--spec': opts.spec = abs(take()); break;
      // 隐藏参数，只给测试用：跑到干跑就收工打包，不碰 PowerPoint、不截屏。USAGE 里不列。
      case '--dry-only': opts.dryOnly = true; break;
      case '--help': case '-h': opts.help = true; break;
      default: throw new Error(`未知参数: ${arg}（用 --help 看用法）`);
    }
  }
  if (!Number.isFinite(opts.delay) || opts.delay < 0) throw new Error('--delay 必须是非负毫秒数');
  if (!Number.isFinite(opts.quickDelay) || opts.quickDelay < 0) throw new Error('--quick-delay 必须是非负毫秒数');
  return opts;
}

/** 读一份 version.json（出货包里在引擎根，开发仓里在 shells/doubao/）。读不到就算了。 */
function readVersion() {
  for (const p of [join(ENGINE_ROOT, 'version.json'), join(RUNNER_DIR, '..', 'version.json')]) {
    try { return JSON.parse(readFileSync(p, 'utf8')).version; } catch { /* 下一个 */ }
  }
  return null;
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (error) { console.log(`结论：失败 —— ${oneLine(error.message)}`); console.log('验收包：（没开始，未打包）'); return 1; }
  if (opts.help) { console.log(USAGE); return 0; }

  const startedAt = new Date();
  const stamp = stampOf(startedAt);
  const outDir = opts.outDir || join(desktopDir(), `架构图验收-${stamp}`);
  const zipPath = join(dirname(outDir), `架构图验收-${PLATFORM_NAME}-${stamp}.zip`);

  const steps = [];
  const shapeRows = [];
  const eventRows = [];
  const shotRows = [];
  let tail = null;
  let shotHint = null;
  const say = (line) => { console.log(line); };
  // ok === null = 这一步跳过了，既不是过也不是不过。别拿 `ok ? … : …` 折它，
  // 跳过的步骤会被打成叉，报告和 stdout 上看起来像失败了三步。
  const note = (name, ok, text) => {
    steps.push({ name, ok, note: text });
    say(`${ok == null ? '–' : (ok ? '✓' : '✗')} ${name}　${oneLine(text)}`);
    return ok;
  };
  /** 第一条失败就是结论那一句。 */
  const firstFailure = () => (steps.find((s) => s.ok === false) || null);

  try { mkdirSync(outDir, { recursive: true }); }
  catch (error) {
    console.log(`结论：失败 —— 建不了输出目录 ${outDir}：${oneLine(error.message)}`);
    console.log('验收包：（没开始，未打包）');
    return 1;
  }
  say(`验收目录：${outDir}`);

  // 第一页用哪份 spec：--spec > 引擎根的 diagram.json > 内置兜底（写进证据目录）。
  // 兜底那一支专为**出货包**准备：包里没有 diagram.json，没有它这条命令第一步就断。
  let specPath;
  let specSource;
  try {
    const picked = resolveFirstSpec({ explicit: opts.spec, engineRoot: ENGINE_ROOT, outDir });
    specPath = picked.path;
    specSource = picked.source;
  } catch (error) {
    console.log(`结论：失败 —— 找不到可用的 spec：${oneLine(error.message)}`);
    console.log('验收包：（没开始，未打包）');
    return 1;
  }

  /* ── 1. 环境 ─────────────────────────────────────────────────────────── */
  const env = {
    平台: `${PLATFORM_NAME}（process.platform=${process.platform}，${arch()}，内核 ${release()}）`,
    'Node 版本': process.version,
    技能目录: dirname(RUNNER_DIR),
    运行器目录: RUNNER_DIR,
    引擎根: ENGINE_ROOT,
    'desktopDir()': desktopDir(),
    输出目录: outDir,
    'spec（第一页）': `${specPath}（${specSource}）`,
    逐步延时: `${opts.delay} ms`,
    '连线与线上文字延时': `${opts.quickDelay} ms`,
    模式: `${opts.quick ? '--quick（跳过两页 deck）' : '完整（单页 + 两页 deck）'}${opts.dryOnly ? ' + --dry-only（只到干跑）' : ''}`,
    版本: readVersion() || '（读不到 version.json）',
    开始时间: startedAt.toISOString(),
  };
  if (IS_WIN) {
    const ps = await runPs1(
      "# 由 verify.mjs 生成的探版脚本\n[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n"
      + '$PSVersionTable.PSVersion.ToString()\n', [], { timeoutMs: 30000, name: 'psver.ps1' },
    );
    env['PowerShell 版本'] = ps.ok ? (oneLine(ps.out) || '（没输出）') : `探不到：${oneLine(ps.out)}`;
  }
  note('① 环境', true, `${PLATFORM_NAME} / Node ${process.version} / 引擎根 ${ENGINE_ROOT}`);

  /* ── 2. 干跑：证明引擎算得出来 ───────────────────────────────────────── */
  const runMjs = join(RUNNER_DIR, 'run.mjs');
  const dry = await runNode([runMjs, '--dry-run', specPath]);
  const dryOk = dry.code === 0 && /^DRY-OK steps=\d+ shapes=\d+/.test(dry.lastLine);
  if (!dryOk && !tail) tail = { step: '② 干跑', lines: dry.all.slice(-20) };
  note('② 干跑（校验 + 布局 + 指令流，不碰 PowerPoint）', dryOk,
    dryOk ? dry.lastLine : `校验失败：${stripFail(dry.lastLine) || '（没有输出）'}（退出码 ${dry.code}）`);

  /* ── 3/4. 真画 ───────────────────────────────────────────────────────── */
  /**
   * 跑一次真画：起连拍 → run.mjs → 停连拍 → 记录。
   * `specs` 是位置参数（一份就是单页，deck 文件也是一份）。
   */
  const draw = async (label, specs, pptxName, eventsName, shotsName) => {
    /* ── PowerPoint 必须存到**桌面根目录**，不能存进证据目录 ──────────────────
     * 2026-09-13 本机实测（截图为证）：`--out` 指到 `~/Desktop/架构图验收-<时间戳>/`
     * 这种**刚建出来的**子目录，34 个形状全画完，卡在保存那一步 —— PowerPoint 前台弹
     * 「授予文件访问权限：Microsoft PowerPoint 需要访问名为「架构图验收-…」的文件夹」，
     * 没人点，AppleEvent 干等到系统两分钟上限报 -1712（退出码 5）。
     * PowerPoint for Mac 是沙盒 App，桌面**根目录**它已经有权限（run.mjs 的默认落点就在那儿），
     * 新建的子目录没有。所以：让它存到桌面根，画完由 Node（不受那道沙盒管）挪进证据目录。
     * Windows 版不是沙盒 App，这一手在那边只是多一次改名，无害。
     */
    const parked = uniqueOut(join(desktopDir(), `${pptxName.replace(/\.pptx$/, '')}-${stamp}.pptx`));
    const pptx = join(outDir, pptxName);
    const events = join(outDir, eventsName);
    const shotsDir = join(outDir, shotsName);
    say(`  … ${label}：PowerPoint 会被拉到前台，同时每 ${SHOT_INTERVAL_MS}ms 截一张全屏`);
    const shooter = makeShooter(shotsDir);
    const r = await runNode([
      runMjs, ...specs,
      '--delay', String(opts.delay),
      '--quick-delay', String(opts.quickDelay),
      '--no-open', '--keep-panel', '0',
      '--out', parked, '--events', events,
    ], { timeoutMs: DRAW_TIMEOUT_MS });
    const shots = await shooter.stop();
    const deduped = dedupeShots(shotsDir);
    shotRows.push({
      dir: `${shotsName}/`, count: deduped.count, first: deduped.first, last: deduped.last,
      note: [
        shots.note,
        deduped.dropped ? `另有 ${deduped.dropped} 张跟前一张一模一样（画面没动），已去掉` : '',
        shots.count >= SHOT_MAX ? `连拍到上限 ${SHOT_MAX} 张就停了` : '',
      ].filter(Boolean).join('；'),
    });
    if (deduped.count && !shotHint) shotHint = `${shotsName}/${deduped.names[Math.floor(deduped.names.length / 2)]}`;

    // 画成了就把 pptx 从桌面挪进证据目录（同一个盘，rename 就够；跨盘再退回复制）
    let moved = existsSync(parked);
    if (moved) {
      try { renameSync(parked, pptx); }
      catch { try { copyFileSync(parked, pptx); rmSync(parked, { force: true }); } catch { moved = false; } }
    }
    const ok = r.code === 0 && /^已保存：/.test(r.lastLine) && moved && existsSync(pptx);
    if (!ok && !tail) tail = { step: label, lines: r.all.slice(-20) };
    note(label, ok, ok
      ? `已保存：${pptx}（先落桌面再挪进来；截图 ${deduped.count} 张）`
      : `${stripFail(r.lastLine) || '（没有输出）'}（退出码 ${r.code}，截图 ${deduped.count} 张`
        + `${existsSync(parked) ? `；pptx 还留在桌面：${parked}` : ''}）`);
    return { ok, pptx, events, pptxName, specs, lastLine: r.lastLine };
  };

  const drawn = [];
  if (opts.dryOnly) {
    note('③ 真画单页', null, '跳过（--dry-only）');
    note('④ 真画两页 deck', null, '跳过（--dry-only）');
  } else if (!dryOk) {
    note('③ 真画单页', null, '跳过（干跑没过，画也白画）');
    note('④ 真画两页 deck', null, '跳过（干跑没过）');
  } else {
    drawn.push(await draw('③ 真画单页', [specPath], '架构图验收-单页.pptx', 'steps-single.jsonl', 'shots-single'));
    if (opts.quick) {
      note('④ 真画两页 deck', null, '跳过（--quick）');
    } else {
      const deckPath = join(outDir, 'deck-两页.json');
      let deckOk = true;
      try {
        const first = JSON.parse(readFileSync(specPath, 'utf8'));
        writeFileSync(deckPath, `${JSON.stringify({
          title: '豆包特供版验收 · 两页 deck',
          slides: [first, SECOND_PAGE_SPEC],
        }, null, 2)}\n`, 'utf8');
      } catch (error) {
        deckOk = false;
        note('④ 真画两页 deck', false, `造不出 deck 文件：${oneLine(error.message)}`);
      }
      if (deckOk) {
        drawn.push(await draw('④ 真画两页 deck', [deckPath], '架构图验收-两页.pptx', 'steps-deck.jsonl', 'shots-deck'));
      }
    }
  }

  /* ── 5. 核对 ─────────────────────────────────────────────────────────── */
  let checkOk = null;
  const checkNotes = [];
  if (drawn.length) {
    checkOk = true;
    for (const d of drawn) {
      if (!d.ok) { checkOk = false; checkNotes.push(`${d.pptxName} 没画出来，跳过核对`); continue; }

      // 引擎侧预期：每页各自的 shapes 与标题
      let expected = [];
      try {
        const loaded = readAndValidateSpec(d.specs);
        if (!loaded.ok) throw new Error(loaded.message);
        const plan = buildPlan(loaded);
        expected = plan.slides.map((p) => ({
          shapes: p.summary.shapes,
          title: p.scene.title && p.scene.title.text ? p.scene.title.text : '',
        }));
      } catch (error) {
        checkOk = false; checkNotes.push(`${d.pptxName} 算不出预期：${oneLine(error.message)}`); continue;
      }

      // eslint-disable-next-line no-await-in-loop
      const un = await unpackPptx(d.pptx, join(outDir, '.unpack', d.pptxName));
      if (!un.ok) { checkOk = false; checkNotes.push(`${d.pptxName} ${un.why}`); continue; }
      if (un.slides.length !== expected.length) {
        checkOk = false;
        checkNotes.push(`${d.pptxName} 页数对不上：pptx 里 ${un.slides.length} 页，引擎预期 ${expected.length} 页`);
      }
      for (let i = 0; i < un.slides.length; i += 1) {
        const want = expected[i] || { shapes: null, title: '' };
        const counted = countShapesInSlideXml(un.slides[i].xml);
        const titleOk = slideHasTitle(un.slides[i].xml, want.title);
        const countOk = want.shapes != null && counted.total === want.shapes;
        if (!countOk || !titleOk) checkOk = false;
        shapeRows.push({
          file: d.pptxName, slide: un.slides[i].name,
          expected: want.shapes == null ? '—' : want.shapes,
          sp: counted.sp, cxnSp: counted.cxnSp, total: counted.total,
          countOk, titleOk, title: want.title,
        });
      }

      // 事件流：start/done 成对 + 每条 done 带 ms + 有 phase:done
      let ev;
      try { ev = summarizeEvents(readFileSync(d.events, 'utf8')); }
      catch (error) { checkOk = false; checkNotes.push(`${basename(d.events)} 读不了：${oneLine(error.message)}`); continue; }
      eventRows.push(eventRow(basename(d.events), ev));
      if (!ev.hasDone) { checkOk = false; checkNotes.push(`${basename(d.events)} 里没有 phase:done`); }
      if (!ev.paired) {
        checkOk = false;
        checkNotes.push(`${basename(d.events)} 的 step 事件没配对齐`
          + `（start ${ev.starts} / done ${ev.dones}`
          + `${ev.unpaired.length ? `，落单的 i：${ev.unpaired.slice(0, 10).join(',')}` : ''}`
          + `${ev.missingMs.length ? `，缺 ms 的 i：${ev.missingMs.slice(0, 10).join(',')}` : ''}）`);
      }
    }
    try { rmSync(join(outDir, '.unpack'), { recursive: true, force: true }); } catch { /* 清不掉就留着 */ }
    note('⑤ 核对（pptx 形状数 / 标题 / 事件流配对）', checkOk,
      checkOk ? `${shapeRows.length} 页全部对上，事件流成对且带耗时` : checkNotes.join('；'));
  } else {
    note('⑤ 核对（pptx 形状数 / 标题 / 事件流配对）', null, '跳过（没有可核对的 pptx）');
  }

  /* ── 6. 报告 ─────────────────────────────────────────────────────────── */
  const failed = firstFailure();
  const conclusion = failed
    ? { ok: false, reason: `${failed.name} 没过：${oneLine(failed.note)}` }
    : { ok: true, reason: '' };

  const drewSomething = drawn.some((d) => d.ok);
  const totalShots = shotRows.reduce((n, r) => n + r.count, 0);
  const totalPairs = eventRows.reduce((n, r) => n + r.dones, 0);
  const goals = {
    runnable: opts.dryOnly ? null : (drewSomething && checkOk === true),
    runnableWhy: opts.dryOnly
      ? '这次只跑到干跑（--dry-only），没碰 PowerPoint。'
      : (drewSomething
        ? `pptx 真的落了盘，解包数出来的形状数与引擎预期${checkOk ? '一致' : '**对不上**'}。`
        : `没能画出 pptx —— ${oneLine(conclusion.reason)}`),
    visible: opts.dryOnly ? null : (totalShots > 0 && totalPairs > 0),
    visibleWhy: opts.dryOnly
      ? '同上，没有截图也没有绘制事件。'
      : `屏幕连拍 ${totalShots} 张（每 ${SHOT_INTERVAL_MS}ms 一张），`
        + `事件流里 ${totalPairs} 步各有一对 start/done 且带真实耗时。`,
  };

  const model = {
    platform: PLATFORM_NAME,
    generatedAt: new Date().toISOString(),
    env, steps, shapeRows, eventRows, shotRows, tail, goals, conclusion, shotHint,
    files: [], packer: '（见下）',
  };
  const reportPath = join(outDir, '验收报告.md');
  const envPath = join(outDir, 'env.json');
  const writeEnv = () => {
    writeFileSync(envPath, `${JSON.stringify({
      platform: process.platform, platformName: PLATFORM_NAME, arch: arch(), release: release(),
      node: process.version, engineRoot: ENGINE_ROOT, runnerDir: RUNNER_DIR,
      skillDir: dirname(RUNNER_DIR), desktop: desktopDir(), outDir, spec: specPath,
      specSource, delayMs: opts.delay, quickDelayMs: opts.quickDelay,
      quick: opts.quick, dryOnly: opts.dryOnly,
      version: readVersion(), startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(),
      powerShell: env['PowerShell 版本'] || null,
      steps: steps.map((s) => ({ name: s.name, ok: s.ok, note: s.note })),
      shapeRows, eventRows, shotRows, conclusion,
    }, null, 2)}\n`, 'utf8');
  };
  try { writeEnv(); } catch (error) { say(`  ! env.json 写不了：${oneLine(error.message)}`); }
  const writeReport = () => {
    try { writeFileSync(reportPath, renderReport(model), 'utf8'); return true; }
    catch (error) { say(`  ! 报告写不了：${oneLine(error.message)}`); return false; }
  };
  writeReport();
  note('⑥ 报告', existsSync(reportPath), existsSync(reportPath) ? reportPath : '没写成');

  /* ── 7. 打包（失败也要出包）──────────────────────────────────────────────
   * 顺序有讲究：报告里要列**包内清单**和**打包方式**，两样都得在真打包之前算出来，
   * 否则回填一次就得再打一次包（几十 MB 的截图读两遍，纯浪费）。
   * 走一遍 walk 拿清单、按总量选打包器，回填进报告重写一次，再打包 —— 只打一次。
   * `model.steps` 跟 `steps` 是同一个数组，⑥ 那一行会自动出现在重写的报告里。
   */
  const rels = walk(outDir);
  const total = totalBytes(outDir, rels);
  model.files = rels;
  model.packer = `${pickPacker(total)}（${rels.length} 个文件，共 ${(total / 1048576).toFixed(1)}MB）`;
  writeReport();
  try { writeEnv(); } catch { /* 已经写过一版了 */ }
  say(`  … 打包 ${rels.length} 个文件（${(total / 1048576).toFixed(1)}MB）`);
  const packed = await packEvidence(outDir, zipPath, rels, total);

  const zipOk = packed.ok && existsSync(zipPath);
  console.log(conclusion.ok ? '结论：通过' : `结论：失败 —— ${oneLine(conclusion.reason)}`);
  console.log(zipOk ? `验收包：${zipPath}` : `验收包：（打包失败${packed.why ? `：${oneLine(packed.why)}` : ''}，证据目录：${outDir}）`);
  return conclusion.ok ? 0 : 1;
}

// 「是不是被直接 node 起来的」。按 realpath 比：macOS 的 /tmp、/var 本身是软链，
// 直接比字符串会得出「没被直接调用」，于是整个脚本一声不吭地退出码 0。
const invoked = (() => {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  try { return realpathSync(process.argv[1]) === realpathSync(self); }
  catch { return resolve(process.argv[1]) === self; }
})();
if (invoked) process.exit(await main());
