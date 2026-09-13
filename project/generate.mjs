// 架构图 POC 生成器 v2 —— 网格驱动布局(孙毅算法)
// 阶段1 排模块(P1): 等大卡片钉入网格, 有连线/同容器的模块相邻, 连线模块行列对齐,
//                   蛇形换行凑画面比例, 空格留行尾(对齐优先时可让位), 同容器连续成块
// 阶段2 画容器:     容器不参与排版, 按子模块包围盒+内边距"包"出来, 嵌套即嵌套包围盒
// 阶段3 连箭头(P2): 先选面, 再全局分配端口槽位, 中段落到空闲带内的独立轨道(见 lib/edge-router.mjs)
// 用法: node generate.mjs diagram.json 输出.html [--strict] [--quality-all] [--quality-json <路径>]
import { readFileSync, writeFileSync } from 'node:fs';
import { fitRectIntoFrame } from './lib/geometry.mjs';
import { getDefaultFrame, normalizeLayoutId, SLIDE_HEIGHT, SLIDE_WIDTH } from './lib/slide-layouts.mjs';
import { validateSpec } from './lib/spec-validator.mjs';
import { TECH_ICONS } from './lib/icons/tech-icons.mjs';
import { GENERIC_ICONS } from './lib/icons/generic-icons.mjs';
import { matchIcon, iconSlugExists } from './lib/icons/icon-matcher.mjs';
import { checkQuality } from './lib/quality-checker.mjs';
import { edgeLabelPoint, aabbIntersects } from './lib/geometry-utils.mjs';
import { routeEdges } from './lib/edge-router.mjs';
import { sanitizeSkinCss, describeSkinCssIssues } from './lib/skin-css.mjs';
import { SKINS, DEFAULT_SKIN, skinCssText, skinMetrics, skinLayout, skinCardWidth, skinCardHeight, skinQualityOptions, skinPanelLabelRect, scaleMetrics, METRICS_DEFAULTS, LINE_H_SUB } from './lib/skins.mjs';
import { edgeWeight, arrowMarkerGeometry } from './lib/edge-weight.mjs';
import { fromBuildSpec, autoLayout, materializeBundles, buildScene as buildSceneOf, qualityOptionsOf, metricsOf, frameScale, layoutModeOf, layeredPanelMetrics, rectOf as adRectOf, setRect as adSetRect } from './lib/arch-doc.mjs';
import { autoFix } from './lib/auto-fixer.mjs';

// ---------- 命令行参数 ----------
// 位置参数保持向后兼容: 第 1 个是输入 JSON, 第 2 个是输出 HTML。
const rawArgs = process.argv.slice(2);
const cliFlags = { strict: false, qualityAll: false, qualityJson: null };
const positional = [];
for (let i = 0; i < rawArgs.length; i += 1) {
  const arg = rawArgs[i];
  if (arg === '--strict') cliFlags.strict = true;
  else if (arg === '--quality-all') cliFlags.qualityAll = true;
  else if (arg === '--quality-json') { cliFlags.qualityJson = rawArgs[i + 1]; i += 1; }
  else if (arg.startsWith('--quality-json=')) cliFlags.qualityJson = arg.slice('--quality-json='.length);
  else if (arg.startsWith('--')) {
    console.error(`未知参数: ${arg}\n用法: node generate.mjs <输入.json> <输出.html> [--strict] [--quality-all] [--quality-json <路径>]`);
    process.exit(2);
  } else positional.push(arg);
}
if (cliFlags.qualityJson === undefined || cliFlags.qualityJson === '') {
  console.error('--quality-json 需要一个输出路径');
  process.exit(2);
}
const inputPath = positional[0] || 'diagram.json';
const outputPath = positional[1] || '架构图-折行.html';

const spec = JSON.parse(readFileSync(inputPath, 'utf8'));
const validation = validateSpec(spec);
if (!validation.valid) {
  throw new Error(`架构图 JSON 校验失败:\n- ${validation.errors.join('\n- ')}`);
}
for (const warning of validation.warnings) console.warn(`WARN: ${warning}`);
spec.layout = normalizeLayoutId(spec.layout);
spec.frame = spec.frame ? { ...spec.frame } : getDefaultFrame(spec.layout);

// ---------- Phase 3: 皮肤解析 ----------
if (spec.skin && !SKINS[spec.skin]) {
  console.warn(`WARN: 未知皮肤 "${spec.skin}"，已回退 ${DEFAULT_SKIN}（可选: ${Object.keys(SKINS).join('/')}）`);
}
const skinId = spec.skin && SKINS[spec.skin] ? spec.skin : DEFAULT_SKIN;
const activeSkin = SKINS[skinId];
// 第一层结构 token: 卡片宽高、容器内边距、节点间距、质检口径都由这里推导，
// 生成器里不再出现写死的图标尺寸/间距/字号常数。
const METRICS = skinMetrics(activeSkin, (msg) => console.warn(`WARN: 皮肤 "${skinId}" ${msg}`));
const LAY = skinLayout(METRICS);
// 第二层: 皮肤的自由 CSS。限定作用域到 #stage, 丢弃一切影响几何的声明后再注入。
const skinExtra = sanitizeSkinCss(activeSkin.extraCss);
for (const line of describeSkinCssIssues(skinExtra.issues)) console.warn(`WARN: 皮肤 "${skinId}" ${line}`);

// ---------- Phase 2: 运行时库内联(剥离 import/export 后拼进生成 HTML) ----------
const INLINE_LIB_FILES = [
  'lib/edge-weight.mjs',   // 必须排在 skins.mjs 之前: skins 的 CSS 变量要用它拆边色
  'lib/skin-css.mjs',
  'lib/skins.mjs',
  'lib/node-fit.mjs',
  'lib/geometry-utils.mjs',
  'lib/quality-checker.mjs',
  'lib/edge-router.mjs',
  'lib/auto-fixer.mjs',
  'lib/icons/icon-matcher.mjs',
  'lib/exporters/minimal-zip.mjs',
  'lib/exporters/minimal-pdf.mjs',
  'lib/exporters/pptx-writer.mjs',
  'lib/exporters/scene-svg.mjs',
  // 原生 PPTX 三件套必须排在 scene-svg 之后：scene-pptx 直接复用它的字号自适应与变体配色
  'lib/exporters/svg-path.mjs',
  'lib/exporters/drawingml.mjs',
  'lib/exporters/scene-pptx.mjs',
];
const stripModuleSyntax = (code) => code
  .split('\n')
  .filter((line) => !/^\s*import\s/.test(line))
  .map((line) => line.replace(/^export\s+(?=(const|let|var|function|class)\b)/, ''))
  .join('\n');
const inlinedRuntimeLibs = INLINE_LIB_FILES
  .map((rel) => `// ---- inlined: ${rel} ----\n${stripModuleSyntax(readFileSync(new URL(rel, import.meta.url), 'utf8'))}`)
  .join('\n');

// ---------- Phase 2: 图标解析(显式 slug 优先, 否则按标签自动匹配; icons:false 全局关) ----------
const iconOf = new Map(); // 叶子 id -> { slug, type, position }
const iconsEnabled = spec.icons !== false;
const resolveIcons = (nodes) => {
  for (const n of nodes || []) {
    if (n.variant === 'container' || (n.children && n.children.length)) { resolveIcons(n.children); continue; }
    if (n.icon === false) continue;
    let hint = typeof n.icon === 'string' ? n.icon : null;
    if (hint && !iconSlugExists(hint, TECH_ICONS, GENERIC_ICONS)) {
      // 修 P1#7: 拼错的显式 slug 不再静默吞掉
      const fallback = matchIcon(n.label, null, TECH_ICONS, GENERIC_ICONS);
      console.warn(`WARN: 节点 ${n.id} 的显式图标 "${hint}" 不在图标库中${fallback ? `，已按标签回退为 "${fallback.slug}"（导出 JSON 将随之更新）` : '，且标签无法自动匹配，已忽略'}`);
      hint = null;
    }
    if (!iconsEnabled && !hint) continue;
    const hit = matchIcon(n.label, hint, TECH_ICONS, GENERIC_ICONS);
    if (hit) {
      iconOf.set(n.id, { slug: hit.slug, type: hit.type, position: n.iconPosition === 'top' ? 'top' : 'left' });
      n.icon = hit.slug; // 写回节点: 运行时与导出 JSON 都携带最终图标
      if (n.iconPosition !== 'top') delete n.iconPosition;
    } else if (hint) {
      console.warn(`WARN: 节点 ${n.id} 的图标 "${hint}" 不在图标库中，已忽略`);
    }
  }
};
resolveIcons(spec.nodes);
const usedIconAssets = {};
for (const { slug, type } of iconOf.values()) {
  if (usedIconAssets[slug]) continue;
  usedIconAssets[slug] = type === 'tech'
    ? { type: 'tech', name: TECH_ICONS[slug].name, color: TECH_ICONS[slug].color, path: TECH_ICONS[slug].path, viewBox: TECH_ICONS[slug].viewBox }
    : { type: 'generic', name: GENERIC_ICONS[slug].name, svg: GENERIC_ICONS[slug].svg, viewBox: GENERIC_ICONS[slug].viewBox };
}
// 受限许可证提示: simple-icons 整体是 CC0, 但个别品牌图标带自己的条款,
// 其中含 NonCommercial 的不可用于商业场景。用到时在构建期提示, 不阻塞。
const ICON_LICENSES = (() => {
  try {
    const list = JSON.parse(readFileSync(new URL('lib/icons/manifest.json', import.meta.url), 'utf8'));
    return new Map(list.map((e) => [e.slug, e]));
  } catch { return new Map(); }
})();
{
  const restricted = [];
  for (const slug of Object.keys(usedIconAssets)) {
    const meta = ICON_LICENSES.get(slug);
    const lic = meta && meta.license;
    if (!lic || lic === 'CC0-1.0' || lic === 'ISC') continue;
    restricted.push({ slug, lic, nc: lic.includes('-NC-'), guidelines: meta.guidelines || '' });
  }
  const nc = restricted.filter((r) => r.nc);
  if (nc.length) {
    console.warn(`WARN: 用到 ${nc.map((r) => `${r.slug}(${r.lic})`).join('、')}，该许可证禁止商业使用；商业场景请改用其它图标或先确认品牌方现行政策${nc[0].guidelines ? `（${nc[0].guidelines}）` : ''}`);
  }
  const attrib = restricted.filter((r) => !r.nc);
  if (attrib.length) {
    console.warn(`WARN: 用到需要署名的图标 ${attrib.map((r) => `${r.slug}(${r.lic})`).join('、')}，分发时请随附 THIRD-PARTY-NOTICES.md`);
  }
}

// 品牌色对比度适配: 深色皮肤提亮过深品牌色, 浅色皮肤压暗过浅品牌色
const iconDisplayColor = (hex) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return hex || (activeSkin.tone === 'dark' ? '#e8ecf2' : '#3f4754');
  const v = parseInt(m[1], 16);
  const r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (activeSkin.tone === 'dark') return lum < 0.18 ? '#e8ecf2' : `#${m[1]}`;
  return lum > 0.85 ? '#5f6b7a' : `#${m[1]}`;
};
const iconSpanHtml = (id) => {
  const meta = iconOf.get(id);
  if (!meta) return '';
  const asset = usedIconAssets[meta.slug];
  const inner = asset.type === 'tech'
    ? `<svg viewBox="${asset.viewBox}"><path d="${asset.path}" fill="${iconDisplayColor(asset.color)}"/></svg>`
    : `<svg viewBox="${asset.viewBox}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${asset.svg}</svg>`;
  return `<span class="node-icon${asset.type === 'generic' ? ' generic' : ''}" data-icon="${meta.slug}">${inner}</span>`;
};
const nodeIconClass = (id) => {
  const meta = iconOf.get(id);
  return meta ? ` has-icon icon-${meta.position}` : '';
};

const isContainer = (n) => n.variant === 'container' || (n.children && n.children.length);

// ---------- 通用: 文字宽度估算(中文按字宽) ----------
const textWidth = (text, px) => {
  let w = 0;
  for (const ch of text || '') w += ch.charCodeAt(0) > 0x2e7f ? px : px * 0.58;
  return w;
};

// ---------- 层级索引 ----------
const nodeById = new Map();
const parentOf = new Map(); // id -> 父节点(顶层为 null)
const indexTree = (nodes, parent) => {
  for (const n of nodes) {
    nodeById.set(n.id, n);
    parentOf.set(n.id, parent);
    if (n.children) indexTree(n.children, n);
  }
};
indexTree(spec.nodes, null);

// 把任意节点投影为某 parent 的直接子项(含自身); 不在其下返回 null
const projectTo = (id, parent) => {
  let n = nodeById.get(id);
  while (n) {
    if ((parentOf.get(n.id) || null) === parent) return n.id;
    n = parentOf.get(n.id);
  }
  return null;
};

// parent 直接子项按投影边做拓扑序(平局保持原顺序)
const topoOrder = (items, parent) => {
  const ids = items.map((n) => n.id);
  const pos = new Map(ids.map((v, i) => [v, i]));
  const adj = new Map(ids.map((v) => [v, []]));
  const indeg = new Map(ids.map((v) => [v, 0]));
  for (const e of spec.edges) {
    const s = projectTo(e.source, parent), t = projectTo(e.target, parent);
    if (s && t && s !== t && adj.has(s) && !adj.get(s).includes(t)) {
      adj.get(s).push(t);
      indeg.set(t, indeg.get(t) + 1);
    }
  }
  const ready = ids.filter((v) => !indeg.get(v)).sort((a, b) => pos.get(a) - pos.get(b));
  const out = [];
  while (ready.length) {
    const v = ready.shift();
    out.push(v);
    for (const w of adj.get(v)) {
      indeg.set(w, indeg.get(w) - 1);
      if (!indeg.get(w)) { ready.push(w); ready.sort((a, b) => pos.get(a) - pos.get(b)); }
    }
  }
  for (const v of ids) if (!out.includes(v)) out.push(v);
  return out.map((v) => items.find((n) => n.id === v));
};

// ---------- 阶段1-3 统一引擎: 与工作台「一键规整」完全同一条链路 ----------
// 旧的独立排版拷贝(块树/货架打包/像素映射/装框缩放)已删除——两套引擎必然双向漂移,
// 同一份 spec 在生成器与工作台里各有一个分数。现在坐标、走线、标签、质检全部
// 出自 lib/arch-doc.mjs 的 autoLayout 管线(含摆位消交叉、走线通道净空、标签松弛),
// 生成器只负责把结果渲染成单文件 HTML。
// spec.positions / labelT(浏览器导出的编辑结果)在规整后覆盖应用,
// 保持「重新生成不丢手动编辑」的既有承诺。
const presetLabelT = new Map((spec.edges || [])
  .filter((e) => e.id && Number.isFinite(e.labelT))
  .map((e) => [e.id, e.labelT]));
const workSpec = fromBuildSpec(spec);
autoLayout(workSpec);
{
  // doTidy 同序: 规整后把可自动修复的节点级问题(重叠/越界/压容器边)当场修掉
  const fixScene = buildSceneOf(workSpec);
  const fixReport = checkQuality(fixScene, qualityOptionsOf(workSpec));
  const fixResult = autoFix(fixScene, fixReport);
  for (const [id, p] of Object.entries(fixResult.positions)) adSetRect(workSpec, id, p);
}
if (spec.positions) {
  for (const [id, p] of Object.entries(spec.positions)) {
    const cur = adRectOf(workSpec, id);
    if (!cur || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    adSetRect(workSpec, id, {
      x: p.x,
      y: p.y,
      w: Number.isFinite(p.w) ? p.w : cur.w,
      h: Number.isFinite(p.h) ? p.h : cur.h,
    });
  }
}
// 上面 autoFix / positions 覆盖改过坐标的卡, 它们身上的束线端口已由 setRect 清掉;
// 在**最终坐标**上再并一次线(第 10 步), 否则按规整坐标写下的束套到用户坐标上会错位。
materializeBundles(workSpec);
for (const e of workSpec.edges) {
  if (presetLabelT.has(e.id)) e.labelT = presetLabelT.get(e.id);
}

const scene = buildSceneOf(workSpec);
// 整图结构 token 的缩放系数与质检口径都取工作台同一份——分数按构造统一
const FIT_SCALE = frameScale(workSpec);
const RENDER_METRICS = metricsOf(workSpec);
const QC_OPTS = qualityOptionsOf(workSpec);
// 边标签字号与 buildScene 的标签盒同源(typeSmall × 0.8)
const EDGE_LABEL_PX = Math.round(RENDER_METRICS.typeSmall * 0.8);
// 标签沿线拖动时中心点距连线两端的最小弧长(px), 越界会压住箭头或端点节点
const EDGE_LABEL_PAD = Math.round(24 * FIT_SCALE * 10) / 10;
const round1k = (v) => Math.round(v * 1000) / 1000;
// 几何密度系数: 线宽/箭头要跟着「内容被压进外框的程度」走, 不能只跟结构 token 的
// 缩放(fromBuildSpec 会把 baseFrame 钉死, 新 spec 的 frameScale 恒为 1)。
// autoLayout 把卡片等比压缩进外框, 实际卡高 / 皮肤基准卡高 就是那份压缩比。
const geoBaseCardH = skinCardHeight(RENDER_METRICS, {
  hasSub: scene.nodes.some((n) => n.sublabel != null && n.sublabel !== ''),
});
const geoCardH = scene.nodes.length ? Math.max(...scene.nodes.map((n) => n.h)) : geoBaseCardH;
const GEO_SCALE = Math.max(0.3, Math.min(2, FIT_SCALE * (geoCardH / Math.max(1, geoBaseCardH))));
const BUILD_EDGE_WEIGHT = edgeWeight(Number(activeSkin.tokens.ew) || 2, GEO_SCALE);
const BUILD_ARROW = arrowMarkerGeometry(BUILD_EDGE_WEIGHT);

const cardRect = new Map(scene.nodes.map((n) => [n.id, { x: n.x, y: n.y, w: n.w, h: n.h }]));
const containerRect = new Map(scene.containers.map((c) => [c.id, { x: c.x, y: c.y, w: c.w, h: c.h }]));
const depthOf = new Map(scene.containers.map((c) => [c.id, c.depth]));

// 边 id: spec 里显式 id 优先, 否则用 fromBuildSpec 归一化时分配的 id(与 scene.edges 对齐)
const edgeIdFor = (e, i) => e.id || (workSpec.edges[i] && workSpec.edges[i].id) || `e${i}`;
const labelTOf = new Map(workSpec.edges.map((e) => [e.id, e.labelT]));
const edgesOut = scene.edges.map((e) => ({
  id: e.id,
  source: e.source,
  target: e.target,
  pts: e.pts,
  style: e.style,
  undirected: !!e.undirected,
  bidirectional: e.bidirectional,
  reversed: e.reversed,
  label: e.label ? { text: e.label.text, x: e.label.x + e.label.w / 2, y: e.label.y + e.label.h / 2 } : null,
  labelT: Number.isFinite(labelTOf.get(e.id)) ? labelTOf.get(e.id) : undefined,
}));

const generatedPositions = Object.fromEntries([...cardRect.entries()].map(([id, r]) => [
  id,
  { x: r.x, y: r.y, w: r.w, h: r.h },
]));

// ---------- Phase 2: 构建期质量检查(确定性几何, 不阻塞, 仅报告) ----------
// scene 与质检口径都来自 arch-doc 管线, 此处分数与工作台「一键规整」逐位一致
const buildQuality = checkQuality(scene, QC_OPTS);
// 质量报告统一走 stdout(此前有问题走 stderr、无问题走 stdout, 自动化只捕获 stdout 时会丢失报告)。
// 评分口径: 满分 100; 交付门槛以 critical 与 high 清零为准, medium/low 为改进建议。
const bySev = buildQuality.issuesBySeverity;
if (buildQuality.totalIssues > 0) {
  console.log(`质量检查: ${buildQuality.totalIssues} 个问题 (critical ${bySev.critical} / high ${bySev.high} / medium ${bySev.medium} / low ${bySev.low}), 评分 ${buildQuality.score}/100 (交付门槛: critical 与 high 均为 0)`);
  const shown = cliFlags.qualityAll ? buildQuality.issues : buildQuality.issues.slice(0, 12);
  for (const issue of shown) console.log(`  - [${issue.severity}] ${issue.description}`);
  if (shown.length < buildQuality.issues.length) {
    console.log(`  … 其余 ${buildQuality.issues.length - shown.length} 条: 加 --quality-all 查看全部, 或在页面内打开质量面板`);
  }
} else {
  console.log('质量检查: 无问题, 评分 100/100');
}
if (cliFlags.qualityJson) {
  writeFileSync(cliFlags.qualityJson, JSON.stringify(buildQuality, null, 2));
  console.log(`质量报告已写入 ${cliFlags.qualityJson}`);
}

// ---------- 渲染 ----------
const roundedPath = (pts, r = 14) => {
  if (pts.length < 2) return '';
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i], prev = pts[i - 1], next = pts[i + 1];
    const inLen = Math.hypot(p.x - prev.x, p.y - prev.y);
    const outLen = Math.hypot(next.x - p.x, next.y - p.y);
    const rr = Math.min(r, inLen / 2, outLen / 2);
    if (rr < 1) { d += ` L ${p.x} ${p.y}`; continue; }
    const inU = { x: (p.x - prev.x) / inLen, y: (p.y - prev.y) / inLen };
    const outU = { x: (next.x - p.x) / outLen, y: (next.y - p.y) / outLen };
    d += ` L ${p.x - inU.x * rr} ${p.y - inU.y * rr}`;
    d += ` Q ${p.x} ${p.y} ${p.x + outU.x * rr} ${p.y + outU.y * rr}`;
  }
  d += ` L ${pts.at(-1).x} ${pts.at(-1).y}`;
  return d;
};

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const runtimeModel = {
  title: spec.title,
  subtitle: spec.subtitle,
  direction: spec.direction,
  layout: spec.layout,
  skin: skinId,
  nodes: spec.nodes,
  // 构建期为了让开节点 / 编组标题而挪过的标签, 要把 labelT 一并带给运行时,
  // 否则页面按默认落点重算一遍, 标签又弹回压着的位置
  edges: spec.edges.map((e, i) => {
    const id = edgeIdFor(e, i);
    const picked = (edgesOut.find((x) => x && x.id === id) || {}).labelT;
    return Number.isFinite(picked) ? { ...e, id, labelT: picked } : { ...e, id };
  }),
  frame: spec.frame,
  positions: { ...generatedPositions, ...(spec.positions || {}) },
};
// 排版模式：只有 layered 才落字段（与 toBuildSpec 同口径）。运行时 serialize() 原样写回,
// 切版式 / 导出 JSON 后重新生成不会丢掉分层模式。
const LAYOUT_MODE = layoutModeOf(workSpec);
if (LAYOUT_MODE === 'layered') runtimeModel.mode = 'layered';
// 分层图下容器内边距收紧(layeredPanelMetrics)。运行时不内联 arch-doc, 但换肤时要按新皮肤重算
// 结构 token, 所以构建期把每套皮肤收紧后的那几个值算好下发, 运行时只查表——单一口径仍在 arch-doc。
// flow 下表为空, 运行时原样返回基准度量(一个像素都不动)。
const LAYERED_PANEL_METRICS = LAYOUT_MODE === 'layered'
  ? Object.fromEntries(Object.keys(SKINS).map((id) => {
    const m = layeredPanelMetrics(workSpec, skinMetrics(SKINS[id]));
    return [id, { panelPadTop: m.panelPadTop, panelPadX: m.panelPadX }];
  }))
  : {};
const runtimeModelJson = JSON.stringify(runtimeModel).replace(/<\//g, '<\\/');
const iconAssetsJson = JSON.stringify(usedIconAssets).replace(/<\//g, '<\\/');

const containerHtml = [...containerRect.entries()]
  .sort((a, b) => depthOf.get(a[0]) - depthOf.get(b[0]))
  .map(([id, r]) => `
    <div class="panel depth-${depthOf.get(id)}" data-id="${id}" style="left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px">
      <span class="panel-label">${esc(nodeById.get(id).label)}</span>
    </div>`).join('');

const leafHtml = [...cardRect.entries()].map(([id, r]) => {
  const n = nodeById.get(id);
  return `
    <div class="node v-${n.variant || 'default'}${nodeIconClass(id)}" data-id="${id}" style="left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px">${iconSpanHtml(id) ? `
      ${iconSpanHtml(id)}` : ''}
      <span class="node-label">${esc(n.label)}</span>${n.sublabel ? `
      <span class="node-sub">${esc(n.sublabel)}</span>` : ''}
    </div>`;
}).join('');

// 连线拆成两层: 命中层(留在节点之下, 接指针) 与视觉层(压在节点之上, 不接指针)。
// 两层的 d 完全一致, 命中层的 16px 描边始终盖住视觉层的细线, 所以拆层不改变命中判定。
const edgeHitSvg = edgesOut.map((e) => {
  const d = roundedPath(e.pts);
  return `        <path class="edge-hit" data-edge-id="${e.id}" data-source="${e.source}" data-target="${e.target}" d="${d}"/>`;
}).join('\n');

const edgeInkSvg = edgesOut.map((e) => {
  const cls = e.style === 'dashed' ? 'edge dashed' : e.style === 'bold' ? 'edge bold' : 'edge';
  // 方向四选一：无向两头都没箭头, 正向只有末端箭头, 反向只有起点箭头, 双向两头都有
  const markers = e.undirected
    ? ''
    : e.reversed && !e.bidirectional
      ? ' marker-start="url(#arrow-rev)"'
      : ` marker-end="url(#arrow)"${e.bidirectional ? ' marker-start="url(#arrow-rev)"' : ''}`;
  const d = roundedPath(e.pts);
  return `        <path class="${cls}" data-edge-id="${e.id}" data-source="${e.source}" data-target="${e.target}" d="${d}"${markers}/>`;
}).join('\n');

const edgeLabelHtml = edgesOut.filter((e) => e.label).map((e) => {
  return `
    <div class="edge-label" data-edge-id="${e.id}" data-source="${e.source}" data-target="${e.target}" style="left:${e.label.x}px;top:${e.label.y}px">${esc(e.label.text)}</div>`;
}).join('');

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>${esc(spec.title)}</title>
<style>
  :root {
    --type-subtitle:28px;
    /* --type-node / --type-small / --icon-* / --card-pad-x / --panel-pad-* 由结构 token 下发, 见 skinCssText */
${skinCssText(activeSkin, RENDER_METRICS)}
    /* 整图几何系数 S = 装框系数 × 外框系数; 连线权重由它求解, 运行时 applyEdgeWeights 改写 */
    --geo-scale:${round1k(GEO_SCALE)};
    --edge-stroke:${BUILD_EDGE_WEIGHT.width}px;
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:100%; height:100%; background:#000; overflow:hidden; }
  body { display:flex; align-items:center; justify-content:center;
         font-family:var(--body-font); }
  #stage { position:relative; width:1920px; height:1080px; flex:none;
           transform-origin:center; overflow:hidden; background:var(--slide-bg); }
  #stage::before { content:""; position:absolute; inset:0; pointer-events:none; opacity:var(--grid-opacity);
           background-image:linear-gradient(rgba(255,255,255,.018) 1px,transparent 1px),
                            linear-gradient(90deg,rgba(255,255,255,.018) 1px,transparent 1px);
           background-size:48px 48px; }
  .title-block { position:absolute; z-index:20; display:flex; flex-direction:column; justify-content:flex-start; }
  .title-block h1 { color:var(--text-primary); font-size:var(--type-title); line-height:1.12;
           font-family:var(--title-font); font-weight:var(--title-weight); letter-spacing:var(--title-ls); text-wrap:balance; }
  .title-block p { margin-top:20px; max-width:100%; color:var(--text-secondary);
           font-size:var(--type-subtitle); line-height:1.45; text-wrap:pretty; }
  .title-block::before { content:""; position:absolute; left:2px; top:-18px; width:56px; height:var(--rule-w);
           background:var(--accent); }
  #stage.layout-A .title-block { left:64px; top:64px; width:544px; height:952px; justify-content:center; }
  #stage.layout-A .title-block::before { top:calc(50% - 104px); }
  #stage.layout-B .title-block { left:64px; top:64px; width:800px; height:240px; }
  #stage.layout-C .title-block { left:360px; top:64px; width:1200px; height:180px; align-items:center; text-align:center; }
  #stage.layout-C .title-block::before { left:50%; transform:translateX(-50%); }
  /* --type-scale: 外框(ARCHITECTURE)缩放系数, 由运行时写入。
     结构 token(--icon-size / --card-pad-x / --type-node ...)已由运行时按同一系数改写,
     此处只处理写死在 CSS 里的几何量: 圆角、描边宽、虚线段长、标签内边距。 */
  #canvas { position:absolute; left:0; top:0; width:${SLIDE_WIDTH}px; height:${SLIDE_HEIGHT}px; transform:none;
           --type-scale:1; }
  .panel { position:absolute; z-index:1; border:var(--panel-bd);
           border-radius:calc(var(--panel-r) * var(--type-scale,1));
           background:var(--panel-bg); }
  .panel.depth-1 { border-radius:calc(var(--panel2-r) * var(--type-scale,1)); border:var(--panel2-bd); background:var(--panel2-bg); }
  /* ===== 编组标题构件(第一层 panelLabelMode): chip 角落药丸 / bar-top 通栏带 / side 竖排 =====
     三种形态的几何全部由结构 token 推导, 配色由 --panel-label-* 下发(会进 SVG/PPTX 导出)。
     标题带高与内边距不随外框缩放(与 panelPadTop 同一档), 只有字号跟着 --type-scale。 */
  /* z-index:1 让标题带压在皮肤给容器加的纹理/角标(.panel::before/::after)之上;
     容器自身 z-index:1 已经开了 stacking context, 所以压不到连线(z-index:2)头上。 */
  .panel-label { position:absolute; z-index:1; box-sizing:border-box; display:flex; align-items:center;
           height:var(--panel-label-h); padding-inline:var(--panel-label-pad-x);
           font:var(--kicker-font); letter-spacing:var(--kicker-ls); white-space:nowrap;
           color:var(--panel-label-ink); background:var(--panel-label-bg);
           border:var(--panel-label-bd); text-transform:uppercase; }
  .panel.depth-1 > .panel-label { color:var(--panel2-label-ink); background:var(--panel2-label-bg);
           border:var(--panel2-label-bd); }
  #stage[data-label-mode="chip"] .panel.depth-1 > .panel-label { border-radius:calc(var(--panel2-label-r) * var(--type-scale,1)); }
  #stage[data-label-mode="bar-top"] .panel.depth-1 > .panel-label { border-radius:calc(var(--panel2-r) * var(--type-scale,1)) calc(var(--panel2-r) * var(--type-scale,1)) 0 0; }
  /* chip: 左对齐容器左内边距, 在顶部内边距带里垂直居中 */
  #stage[data-label-mode="chip"] .panel-label { left:var(--panel-pad-left);
           top:calc((var(--panel-pad-top) - var(--panel-label-h)) / 2);
           border-radius:calc(var(--panel-label-r) * var(--type-scale,1)); }
  /* bar-top: 贯穿容器外框、压住上边框, 圆角跟着容器顶部两角 */
  #stage[data-label-mode="bar-top"] .panel-label { left:0; right:0; top:0; width:auto;
           border-radius:calc(var(--panel-r) * var(--type-scale,1)) calc(var(--panel-r) * var(--type-scale,1)) 0 0; }
  #stage[data-label-mode="bar-top"][data-label-align="center"] .panel-label { justify-content:center; }
  /* side: 竖排贴容器左侧, 列宽由 panelLabelW 给, 横向就全留给内容 */
  /* side: 竖条是"内嵌在容器里的一枚圆角矩形"(设计稿口径), 四角都圆、四周留 inset,
     不是贴着容器边的通栏; 文字在容器高度上居中 —— 顶端对齐时短标题会孤零零吊在上边 */
  #stage[data-label-mode="side"] .panel-label {
           left:var(--panel-label-inset); top:var(--panel-label-inset); bottom:var(--panel-label-inset);
           height:auto; width:var(--panel-label-w);
           writing-mode:vertical-rl; justify-content:center;
           padding-block:var(--panel-label-pad-x); padding-inline:0;
           border-radius:calc(var(--panel-label-r) * var(--type-scale,1)); }
  #stage[data-label-mode="side"] .panel.depth-1 > .panel-label { border-radius:calc(var(--panel2-label-r) * var(--type-scale,1)); }
  /* --card-pad-x / --card-pad-y / --label-sub-gap / --icon-* 由阶梯自适应(node-fit)按节点写到
     元素自身的内联样式上, 覆盖画布级的同名变量; 未参与求解的节点回落到画布级值。 */
  .node { position:absolute; z-index:3; display:flex; flex-direction:column; justify-content:center;
          align-items:center; gap:var(--label-sub-gap); padding-inline:var(--card-pad-x);
          padding-block:var(--card-pad-y,0px);
          border-radius:calc(var(--node-r) * var(--type-scale,1)); border:var(--node-bd);
          background:var(--node-bg);
          box-shadow:var(--node-shadow); }
  /* keep-all: 中文之间不断行, 优先在空格处折行(避免出现 "Grafana 监/控" 这种词被拆开的折行);
     break-word 作为兜底, 保证超长无空格文本仍能折行而不溢出 */
  /* anywhere 与 break-word 的差别: 只有 anywhere 会把"可断行"计入最小内容宽度,
     否则 icon-left 的 grid 轨道会被 "Elasticsearch" 这类长英文词撑开而横向溢出 */
  .node-label, .node-sub { word-break:keep-all; overflow-wrap:break-word; overflow-wrap:anywhere;
          text-align:center; }
  .node-label { color:var(--text-primary); font-size:var(--type-node); font-weight:var(--node-weight); line-height:1.15; }
  .node-sub { color:var(--text-secondary); font-size:var(--type-small); line-height:${LINE_H_SUB}; }
  /* 阶梯自适应的兜底: 已降到最小字号仍放不下时按行截断, 让文字止于卡片内而不是漏出去 */
  .node-label.fit-clamp, .node-sub.fit-clamp { display:-webkit-box; -webkit-box-orient:vertical; overflow:hidden; }
  .node-sub.fit-drop { display:none; }
  /* 文本测量探针: 必须挂在 #stage 之外(舞台带 transform 缩放, 量出来的是屏幕像素) */
  .fit-probe { position:absolute; left:-99999px; top:0; visibility:hidden; pointer-events:none;
          white-space:normal; word-break:keep-all; overflow-wrap:break-word; overflow-wrap:anywhere; }
  .node.v-accent { border:var(--accent-bd);
          background:var(--accent-bg); }
  .node.v-accent .node-label { color:var(--accent-label); }
  .node.v-store { border:var(--store-bd);
          background:var(--store-bg); }
  .node.v-muted { border:var(--muted-bd); background:var(--muted-bg); }
  .node.v-muted .node-label { color:var(--text-secondary); }
  /* ===== 连线的两层 =====
     可见线体是全图最顶层的东西: 压在节点(z3)之上, 线才不会被卡片盖断。
     但"看得见"与"点得到"必须拆开 —— 命中层留在节点之下(z2), 节点区域内的点击
     照旧由节点优先接住; 视觉层整层 pointer-events:none, 不抢任何点击。
     两层的 d 一模一样, 命中层 16px 的描边始终盖住视觉层的细线, 拆层不改命中判定。 */
  svg.wires { position:absolute; left:0; top:0; overflow:visible; }
  svg.wires.wires-hit { z-index:2; }
  svg.wires.wires-ink { z-index:4; pointer-events:none; }
  /* 端点用不透明色描边; alpha 统一由 .edge 的元素级 opacity 承担, 因此端点压住线段的那一段不叠加 */
  svg.wires marker path { stroke:var(--edge-solid); fill:none; }
  .edge-hit { fill:none; stroke:rgba(255,255,255,.001); stroke-width:16px; pointer-events:stroke; }
  /* 线宽与端点几何由 lib/edge-weight.mjs 按「整图几何系数 S = 装框系数 × 外框系数」求解,
     结果下发到 --edge-stroke 与 marker 属性; 这里不再自己乘 --type-scale。
     marker 保持默认 markerUnits="strokeWidth", 所以 .edge.bold 自动得到放大的端点。 */
  /* 可见线体不接指针: 它盖在节点上方, 一旦接了就会把节点的点击抢走。
     点击/悬停一律由 .edge-hit(在节点之下那一层)负责。 */
  .edge { fill:none; stroke:var(--edge-solid); stroke-width:var(--edge-stroke,var(--edge-w));
          opacity:var(--edge-alpha,1); pointer-events:none; }
  .edge.dashed { stroke-dasharray:calc(6px * var(--geo-scale,1)) calc(5px * var(--geo-scale,1));
          opacity:calc(var(--edge-alpha,1) * .72); }
  /* 边标签压在连线视觉层(z4)之上 */
  .edge-label { position:absolute; z-index:5; transform:translate(-50%,-50%);
          padding:calc(3px * var(--type-scale,1)) calc(10px * var(--type-scale,1));
          font-size:calc(${EDGE_LABEL_PX}px * var(--type-scale,1)); color:var(--text-secondary); background:var(--elabel-bg); border:var(--elabel-bd);
          border-radius:calc(var(--elabel-r) * var(--type-scale,1)); white-space:nowrap; }
  .edge-label.empty::before { content:"标签"; color:var(--text-muted); }
  .edge-label.empty:focus::before { content:""; }
  .page-num { position:absolute; z-index:25; right:64px; bottom:64px; color:var(--text-muted); font-size:18px;
          font-variant-numeric:tabular-nums; }
  .node { cursor:grab; user-select:none; transition:box-shadow .15s; }
  /* 高亮/闪烁是临时态: 自带不透明度, 不再乘 --edge-alpha; 线宽按当前线宽加权, 跟着整图缩放 */
  .edge.highlight { stroke:rgb(90,200,250)!important; opacity:.8!important;
          stroke-width:calc(var(--edge-stroke,var(--edge-w)) * 1.2)!important; }
  .edge.flash { animation:edgeFlash .26s ease-in-out 4; }
  @keyframes edgeFlash { 50% { stroke:rgb(90,200,250); opacity:1;
          stroke-width:calc(var(--edge-stroke,var(--edge-w)) * 1.5); } }


  .toolbar { position:absolute; left:50%; bottom:4px; transform:translateX(-50%); display:flex; gap:8px;
          align-items:center; padding:8px 12px; background:rgba(12,17,26,.94);
          border:1px solid rgba(255,255,255,.14); border-radius:10px; z-index:100; box-shadow:0 16px 40px rgba(0,0,0,.34); }
  .toolbar button { background:none; border:1px solid rgba(255,255,255,.2); color:#a9b1c0; font-size:13px;
          padding:5px 14px; border-radius:6px; cursor:pointer; transition:all .15s; white-space:nowrap; }
  .toolbar button:hover { background:rgba(255,255,255,.08); color:#eef1f6; }
  .toolbar button.active { background:rgba(90,200,250,.15); border-color:rgba(90,200,250,.5); color:#5ac8fa; }
  .toolbar button.primary { background:rgba(90,200,250,.2); border-color:rgba(90,200,250,.55); color:#cdeeff; font-weight:600; }
  .toolbar button.primary:hover { background:rgba(90,200,250,.3); color:#eef9ff; }
  .toolbar .sep { width:1px; align-self:stretch; margin:2px 2px; background:rgba(255,255,255,.12); }
  .layout-switch { display:flex; gap:4px; padding:3px; border-radius:7px; background:rgba(255,255,255,.045); }
  .layout-switch button { min-width:34px; padding:4px 9px; font-variant-numeric:tabular-nums; }
  /* 手绘编辑扩展 */
  body.presenting .toolbar { display:none!important; }
  body.presenting .node,
  body.presenting .panel,
  body.presenting .edge,
  body.presenting .edge-hit,
  body.presenting .edge-label { pointer-events:none!important; }
  /* 浏览器打印(Cmd+P / 无头 --print-to-pdf)走浏览器自己的分页, 不经过「导出 → PDF 文档」。
     纸张必须声明成整张幻灯片大小、不留页边距, 否则落在默认 Letter / A4 竖版上只剩左边六成 */
  @media print {
    @page { size:${SLIDE_WIDTH}px ${SLIDE_HEIGHT}px; margin:0; }
    html, body { width:${SLIDE_WIDTH}px; height:${SLIDE_HEIGHT}px; background:var(--slide-bg); overflow:visible; }
    body { display:block; }
    #stage { transform:none!important; }
    .toolbar { display:none!important; }
    .node.v-accent.selected { box-shadow:0 8px 28px rgba(90,200,250,.12), inset 0 1px 0 rgba(255,255,255,.1)!important; }
    .quality-panel, .export-menu, .toast { display:none!important; }
  }
  /* ===== Phase 2: 新节点形状 ===== */
  .node.v-pill { border-radius:999px; }
  .node.v-circle { border-radius:50%; }
  .node.v-decision { background:none; border:none; box-shadow:none; border-radius:0;
          padding-block:0; padding-inline:var(--card-pad-x); }
  .node.v-decision::before { content:""; position:absolute; inset:0; z-index:-2;
          background:var(--accent); opacity:.8; clip-path:polygon(50% 0,100% 50%,50% 100%,0 50%); }
  .node.v-decision::after { content:""; position:absolute; inset:calc(1.6px * var(--type-scale,1)); z-index:-1;
          background:var(--decision-fill); clip-path:polygon(50% 0,100% 50%,50% 100%,0 50%); }
  .node.v-decision .node-label { color:var(--text-primary); }
  .node.v-database { padding-top:calc(10px * var(--type-scale,1));
          border-radius:50% 50% calc(14px * var(--type-scale,1)) calc(14px * var(--type-scale,1))
                      / calc(22px * var(--type-scale,1)) calc(22px * var(--type-scale,1)) calc(14px * var(--type-scale,1)) calc(14px * var(--type-scale,1)); }
  .node.v-database::before { content:""; position:absolute; left:0; right:0;
          top:calc(6px * var(--type-scale,1)); height:calc(16px * var(--type-scale,1));
          border-bottom:1px solid var(--hairline); border-radius:50%; pointer-events:none; }
  /* ===== Phase 2: 节点图标 ===== */
  /* 图标位是一块底板(--icon-size 是底板边长), 字形按 --icon-glyph-ratio 缩在里面。
     底色/圆角/占比都走 tokens, 因此 sceneToSvg 能画出同一块底板, PPTX 不会掉。 */
  .node-icon { flex:none; width:var(--icon-size); height:var(--icon-size); display:flex; align-items:center; justify-content:center;
          color:var(--text-secondary); pointer-events:none;
          background:var(--icon-chip-bg); border-radius:calc(var(--icon-chip-r) * var(--type-scale,1)); }
  .node-icon svg { width:calc(100% * var(--icon-glyph-ratio)); height:calc(100% * var(--icon-glyph-ratio)); display:block; }
  /* 图标 + 文字是一个整体, 在卡片里居中(设计稿口径: justify-content:center);
     用 auto auto 而不是 auto 1fr —— 1fr 会把文字轨道撑到卡片右边缘,
     图标就被推到最左、和文字拉开一大段空白。文字块自身左对齐。 */
  .node.icon-left { display:grid; grid-template-columns:auto minmax(0,auto); justify-content:center;
          column-gap:var(--icon-gap-x); row-gap:var(--label-sub-gap);
          align-content:center; align-items:center; justify-items:start; }
  .node.icon-left .node-icon { grid-column:1; grid-row:1 / span 2; }
  .node.icon-left .node-label, .node.icon-left .node-sub { grid-column:2; text-align:left; min-width:0; }
  /* 顶置图标: 容器行距用 label-sub-gap, 图标下方再补足到 icon-gap-top(不允许为负) */
  .node.icon-top { flex-direction:column; gap:var(--label-sub-gap); }
  .node.icon-top .node-icon { width:var(--icon-size-top); height:var(--icon-size-top);
          margin-bottom:max(0px, calc(var(--icon-gap-top) - var(--label-sub-gap))); }
  /* ===== Phase 2: 粗边样式 ===== */
  .edge.bold { stroke-width:calc(var(--edge-stroke,var(--edge-w)) * 1.6); }
  /* ===== Phase 2: 质量面板 ===== */
  .quality-panel { position:absolute; right:24px; top:24px; width:400px; max-height:calc(100% - 120px); z-index:130;
          display:flex; flex-direction:column; background:rgba(12,17,26,.97); border:1px solid rgba(255,255,255,.14);
          border-radius:12px; box-shadow:0 20px 60px rgba(0,0,0,.5); overflow:hidden; }
  .quality-head { display:flex; align-items:center; gap:10px; padding:14px 16px;
          border-bottom:1px solid rgba(255,255,255,.1); color:var(--text-primary); font-size:16px; font-weight:650; }
  .quality-head .quality-score { margin-left:auto; font-size:14px; font-weight:600; color:#74c0fc;
          padding:2px 10px; border:1px solid rgba(116,192,252,.4); border-radius:99px; }
  .quality-head .quality-close { background:none; border:none; color:var(--text-muted); font-size:16px; cursor:pointer; padding:2px 6px; }
  .quality-head .quality-close:hover { color:#fff; }
  .quality-list { overflow:auto; padding:6px 0; flex:1; }
  .quality-empty { padding:22px 16px; font-size:14px; color:var(--text-secondary); text-align:center; }
  .quality-group { padding:8px 16px 2px; font-size:12px; letter-spacing:.1em; color:var(--text-muted); text-transform:uppercase; }
  .quality-item { display:flex; gap:9px; padding:8px 16px; font-size:14px; line-height:1.4; color:var(--text-secondary); cursor:pointer; }
  .quality-item:hover { background:rgba(255,255,255,.05); color:var(--text-primary); }
  .quality-dot { flex:none; width:8px; height:8px; border-radius:50%; margin-top:6px; }
  .quality-dot.critical { background:#ff6b6b; } .quality-dot.high { background:#ffa94d; }
  .quality-dot.medium { background:#ffd166; } .quality-dot.low { background:#74c0fc; }
  .quality-item .quality-fix-tag { margin-left:auto; flex:none; align-self:center; font-size:11px; color:#69db7c; border:1px solid rgba(105,219,124,.4); border-radius:99px; padding:1px 8px; }
  .quality-actions { display:flex; gap:8px; padding:12px 16px; border-top:1px solid rgba(255,255,255,.1); }
  .quality-actions button { flex:1; background:none; border:1px solid rgba(255,255,255,.2); color:#a9b1c0;
          font-size:13px; padding:6px 0; border-radius:6px; cursor:pointer; }
  .quality-actions button:hover { background:rgba(255,255,255,.08); color:#eef1f6; }
  .quality-actions button.primary { background:rgba(105,219,124,.15); border-color:rgba(105,219,124,.5); color:#8ce99a; }
  .quality-actions button.primary:hover { background:rgba(105,219,124,.28); }
  .node.q-flag { outline:2px dashed #ff6b6b; outline-offset:3px; }
  .panel.q-flag { outline:2px dashed #ffa94d; outline-offset:3px; }
  body.presenting .quality-panel { display:none!important; }
  .toolbar button .badge { display:inline-block; margin-left:5px; min-width:16px; padding:0 4px; font-size:11px;
          line-height:16px; color:#0b0f16; background:#ffd166; border-radius:99px; }
  /* ===== Phase 2: 导出菜单 ===== */
  .menu-anchor { position:relative; display:inline-flex; }
  .export-menu { position:absolute; bottom:calc(100% + 12px); left:50%; transform:translateX(-50%); z-index:140;
          min-width:250px; padding:6px; background:rgba(12,17,26,.98); border:1px solid rgba(255,255,255,.15);
          border-radius:10px; box-shadow:0 18px 50px rgba(0,0,0,.5); }
  .export-menu .export-item { display:flex; justify-content:space-between; gap:14px; width:100%; padding:8px 12px;
          background:none; border:none; border-radius:6px; color:#c6cede; font-size:14px; cursor:pointer; text-align:left; }
  .export-menu .export-item:hover { background:rgba(90,200,250,.14); color:#eaf6ff; }
  .export-menu .export-item .hint { color:var(--text-muted); font-size:12px; }
  .export-menu .export-sep { height:1px; margin:5px 8px; background:rgba(255,255,255,.1); }
  .export-menu .export-scale { display:flex; align-items:center; gap:6px; padding:7px 12px 5px; font-size:12px; color:var(--text-muted); }
  .export-menu .export-scale button { padding:2px 10px; font-size:12px; background:none; border:1px solid rgba(255,255,255,.2);
          color:#a9b1c0; border-radius:5px; cursor:pointer; }
  .export-menu .export-scale button.active { background:rgba(90,200,250,.18); border-color:rgba(90,200,250,.55); color:#5ac8fa; }
  /* ===== Phase 3: 皮肤菜单 ===== */
  .skin-menu { min-width:290px; max-height:520px; overflow:auto; }
  .skin-menu .export-item { align-items:center; }
  .skin-menu .export-item.active { background:rgba(90,200,250,.16); color:#eaf6ff; }
  .skin-swatch { flex:none; display:inline-flex; align-items:center; justify-content:center; width:26px; height:18px;
          margin-right:10px; border-radius:4px; border:1px solid rgba(255,255,255,.25); }
  .skin-swatch span { display:block; width:10px; height:6px; border-radius:2px; }
  /* 早期 10 套折叠在这里, 点 .skin-more 才展开 */
  .skin-menu .skin-more { justify-content:space-between; margin-top:5px; padding-top:10px;
          border-top:1px solid rgba(255,255,255,.1); border-radius:0; color:#8b95a8; font-size:13px; }
  .skin-menu .skin-more:hover { color:#eaf6ff; background:none; }
  .skin-menu .skin-more.has-active .hint { color:#5ac8fa; }
  .skin-menu .skin-legacy { display:none; }
  .skin-menu .skin-legacy.open { display:block; }


  /* ===== Phase 2: 导出进度提示 ===== */
  .toast { position:absolute; left:50%; top:28px; transform:translateX(-50%); z-index:160; padding:9px 20px;
          background:rgba(12,17,26,.96); border:1px solid rgba(255,255,255,.16); border-radius:99px;
          color:#c6cede; font-size:14px; box-shadow:0 12px 36px rgba(0,0,0,.4); }
  /* ===== Phase 2: 只读交互模式(导出的交互式 HTML) =====
     别在这里给 .toolbar / .quality-panel 强写 display:…!important: 产物固定带 data-readonly,
     这种规则与演示态 / 打印的隐藏规则特异性相同又排在后面, 会让演示时工具栏藏不掉、
     质检面板点 ✕ 关不上(面板靠内联 display:none 关闭, 压不过 !important)。 */
  body[data-readonly] .edit-only { display:none!important; }
</style>
<!-- 皮肤第二层: 自由 CSS(已限定作用域并剔除几何属性), 换肤时整块替换 -->
<style id="skin-extra">${skinExtra.css}</style>
</head>
<body data-readonly="1">
  <div id="stage" class="layout-${spec.layout}" data-label-mode="${METRICS.panelLabelMode}" data-label-align="${METRICS.panelLabelAlign}">
    <div class="title-block">
      <h1 data-model-field="title">${esc(spec.title)}</h1>
      <p data-model-field="subtitle">${esc(spec.subtitle || '')}</p>
    </div>
    <div id="canvas" style="width:${SLIDE_WIDTH}px;height:${SLIDE_HEIGHT}px">
${containerHtml}
${leafHtml}
      <!-- 命中层: 留在节点之下, 节点区域内的点击仍由节点优先接住 -->
      <svg class="wires wires-hit" width="${SLIDE_WIDTH}" height="${SLIDE_HEIGHT}">
${edgeHitSvg}
      </svg>
      <!-- 视觉层: 压在节点之上, 整层不接指针事件 -->
      <svg class="wires wires-ink" width="${SLIDE_WIDTH}" height="${SLIDE_HEIGHT}">
        <defs>
          <!-- markerUnits 取默认的 strokeWidth: 端点几何以线宽为单位, 粗边线自动得到大端点。
               尺寸由 lib/edge-weight.mjs 按整图几何系数求解, 运行时 applyEdgeWeights 会重写这些属性。 -->
          <marker id="arrow" markerWidth="${BUILD_ARROW.markerWidth}" markerHeight="${BUILD_ARROW.markerHeight}" refX="${BUILD_ARROW.refX}" refY="${BUILD_ARROW.refY}" orient="auto">
            <path d="${BUILD_ARROW.d}" fill="none" stroke-width="${BUILD_ARROW.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>
          </marker>
          <marker id="arrow-rev" markerWidth="${BUILD_ARROW.markerWidth}" markerHeight="${BUILD_ARROW.markerHeight}" refX="${BUILD_ARROW.refXRev}" refY="${BUILD_ARROW.refY}" orient="auto">
            <path d="${BUILD_ARROW.dRev}" fill="none" stroke-width="${BUILD_ARROW.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>
          </marker>
        </defs>
${edgeInkSvg}
      </svg>
${edgeLabelHtml}
    </div>
    <div class="page-num">01</div>
    <div class="toolbar">
      <span class="layout-switch" aria-label="PPT 版式">
        <button type="button" data-layout="A" title="左标题，右架构图">A</button>
        <button type="button" data-layout="B" title="左上标题，下方架构图">B</button>
        <button type="button" data-layout="C" title="居中标题，下方架构图">C</button>
      </span>
      <span class="sep"></span>
      <button id="btn-quality" title="按共享准则复查几何质量(重叠/越界/交叉等); 要重排请回工作台">质量检查</button>
      <span class="menu-anchor"><button id="btn-skin" title="切换皮肤主题(${Object.keys(SKINS).length} 套)">皮肤 ▾</button></span>
      <span class="menu-anchor"><button id="btn-export" title="导出 PNG/SVG/PDF/PPTX/JPEG/WebP/HTML/JSON">导出 ▾</button></span>
      <button id="btn-present" title="隐藏控件进入演示态">演示</button>
    </div>
  </div>
  <script type="application/json" id="diagram-model">${runtimeModelJson}</script>
  <script>
  // =========== 编辑运行时 ===========
  (() => {
    // Phase 2: 启动即快照原始文档(供"交互式 HTML"导出), 并识别只读模式
    const BOOT_HTML = document.documentElement.outerHTML;
    // ---------- Phase 2 内联库(构建时从 lib/ 拼入, 勿手改) ----------
${inlinedRuntimeLibs}
    const ICON_ASSETS = ${iconAssetsJson};
    const ACTIVE_SKIN_ID = ${JSON.stringify(skinId)};
    // ---------- Phase 2 内联库结束 ----------
    const stage = document.getElementById('stage');
    const canvas = document.getElementById('canvas');
    // 连线两层: 命中层在节点之下接指针, 视觉层在节点之上只负责画
    const svgHit = canvas.querySelector('svg.wires-hit');
    const svgInk = canvas.querySelector('svg.wires-ink');
    const modelEl = document.getElementById('diagram-model');
    let DW = ${SLIDE_WIDTH}, DH = ${SLIDE_HEIGHT};
    // 结构 token: 与构建期同一份口径(含整图等比缩放), 换肤时由 syncSkinMetrics() 就地刷新
    const FIT_SCALE = ${Math.round(FIT_SCALE * 1e6) / 1e6};
    const GEO_FIT = ${Math.round(GEO_SCALE * 1e6) / 1e6}; // 几何密度系数(线宽/箭头), 与结构 token 缩放分离
    const EDGE_LABEL_PAD = ${EDGE_LABEL_PAD}; // 标签沿线拖动时距两端的最小弧长(px)
    // 排版模式与分层图下各皮肤收紧后的容器内边距(构建期由 arch-doc 的 layeredPanelMetrics 算好),
    // 运行时度量一律经 layeredMetricsRuntime, 与工作台 / SVG / PPTX 的 metricsOf 同一口径。
    const LAYOUT_MODE = ${JSON.stringify(LAYOUT_MODE)};
    const LAYERED_PANEL_METRICS = ${JSON.stringify(LAYERED_PANEL_METRICS)};
    function layeredMetricsRuntime(base, skinId) {
      const fix = LAYOUT_MODE === 'layered' ? LAYERED_PANEL_METRICS[skinId] : null;
      if (!fix) return base;
      const out = {};
      Object.keys(base).forEach(function(k) { out[k] = base[k]; });
      out.panelPadTop = fix.panelPadTop;
      out.panelPadX = fix.panelPadX;
      return out;
    }
    // 皮肤结构 token × 装框系数, 再按排版模式收紧容器内边距 —— 运行时所有度量的唯一入口
    function runtimeMetricsFor(skinId) {
      const skin = SKINS[skinId] || SKINS[DEFAULT_SKIN];
      return layeredMetricsRuntime(scaleMetrics(skinMetrics(skin), FIT_SCALE), skinId);
    }
    let METRICS = runtimeMetricsFor(ACTIVE_SKIN_ID);
    // RMETRICS = METRICS × 外框缩放系数。运行时的一切尺寸(内边距/图标/字号/容器内边距)都读它,
    // METRICS 只作为"外框为原始大小时"的基准保留, 换肤时由 syncSkinMetrics() 刷新。
    let RMETRICS = METRICS;
    let LAY = skinLayout(RMETRICS);
    let PAD = LAY.panelPad;
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const SLIDE_LAYOUTS = {
      A: { title: { x:64, y:64, w:544, h:952 }, frame: { x:672, y:64, w:1184, h:952 } },
      B: { title: { x:64, y:64, w:800, h:240 }, frame: { x:64, y:304, w:1792, h:712 } },
      C: { title: { x:360, y:64, w:1200, h:180 }, frame: { x:120, y:244, w:1680, h:772 } }
    };

    const clone = (value) => {
      if (typeof structuredClone === 'function') return structuredClone(value);
      return JSON.parse(JSON.stringify(value));
    };
    const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
    const roundPos = (v) => Math.round(v * 100) / 100;

    function normalizeModel(raw) {
      const out = clone(raw || {});
      const seen = new Set();
      out.nodes = Array.isArray(out.nodes) ? out.nodes : [];
      out.edges = Array.isArray(out.edges) ? out.edges.map(function(edge, i) {
        const copy = Object.assign({}, edge);
        let id = copy.id || ('e' + i);
        while (seen.has(id)) id = id + '_' + i;
        seen.add(id);
        copy.id = id;
        copy.style = copy.style || 'solid';
        // 方向四选一: 无向压过双向, 双向压过反向
        copy.undirected = !!copy.undirected;
        copy.bidirectional = !copy.undirected && !!copy.bidirectional;
        copy.reversed = !copy.undirected && !copy.bidirectional && !!copy.reversed;
        // labelT: 标签沿线位置(0=起点, 1=终点); 非法值丢弃, 回落到"最长一段中点"的默认落点
        if (copy.labelT != null) {
          const t = Number(copy.labelT);
          if (Number.isFinite(t)) copy.labelT = Math.max(0, Math.min(1, t));
          else delete copy.labelT;
        }
        return copy;
      }) : [];
      if (!out.positions || typeof out.positions !== 'object' || Array.isArray(out.positions)) out.positions = {};
      // 排版模式只认 layered, 其余一律当 flow(不落字段)
      if (out.mode !== 'layered') delete out.mode;
      out.layout = ['A','B','C'].indexOf(String(out.layout || '').toUpperCase()) >= 0
        ? String(out.layout).toUpperCase() : 'B';
      if (out.skin != null && !SKINS[out.skin]) delete out.skin;
      if (out.frame && typeof out.frame === 'object' && !Array.isArray(out.frame)
          && typeof out.frame.w === 'number' && typeof out.frame.h === 'number') {
        out.frame = { x: +out.frame.x || 0, y: +out.frame.y || 0, w: +out.frame.w, h: +out.frame.h };
      } else {
        out.frame = clone(SLIDE_LAYOUTS[out.layout].frame);
      }
      return out;
    }

    const initialModel = normalizeModel(JSON.parse(modelEl.textContent || '{}'));
    // key 含内容指纹: diagram.json 一变, 旧存档自动失效; 同标题的过期 key 顺手清掉
    // 只读产物不落盘; 顺手清掉旧版本编辑态留下的存档
    try {
      const stale = 'archdiag:' + (initialModel.title || document.title || location.pathname);
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.indexOf(stale) === 0) localStorage.removeItem(k);
      }
    } catch (err) { /* 隐私模式等场景下忽略 */ }
    let model = clone(initialModel);
    let selection = new Set();

    const nodes = new Map();
    const panels = new Map();
    let nodeDefs = new Map();
    let parentOf = new Map();
    let childIds = new Map();
    let containerIds = new Set();
    let topIds = [];
    let edgeState = new Map();

    canvas.querySelectorAll('.node[data-id]').forEach(function(el) {
      const id = el.dataset.id;
      const x = parseFloat(el.style.left) || 0;
      const y = parseFloat(el.style.top) || 0;
      nodes.set(id, { id: id, el: el, baseX: x, baseY: y, x: x, y: y, w: el.offsetWidth, h: el.offsetHeight });
    });
    canvas.querySelectorAll('.panel[data-id]').forEach(function(el) {
      const id = el.dataset.id;
      panels.set(id, { id: id, el: el, x: parseFloat(el.style.left) || 0, y: parseFloat(el.style.top) || 0,
        w: el.offsetWidth, h: el.offsetHeight });
    });

    // --- 舞台缩放 ---
    const fit = () => {
      const s = Math.min(innerWidth / 1920, innerHeight / 1080);
      stage.style.transform = 'scale(' + s + ')';
      canvas.style.transform = 'none';
    };
    addEventListener('resize', fit); fit();

    // PPT 坐标系固定为 1920×1080；浏览器只缩放整个 stage。
    function resizeCanvasToContent() {
      DW = 1920;
      DH = 1080;
      canvas.style.width = DW + 'px';
      canvas.style.height = DH + 'px';
      [svgHit, svgInk].forEach(function(el) {
        el.setAttribute('width', DW);
        el.setAttribute('height', DH);
      });
      fit();
    }

    function applyStageLayout() {
      stage.classList.remove('layout-A', 'layout-B', 'layout-C');
      stage.classList.add('layout-' + model.layout);
      document.querySelectorAll('[data-layout]').forEach(function(button) {
        button.classList.toggle('active', button.dataset.layout === model.layout);
      });
    }


    // 只读产物没有历史与存档: 版式 / 皮肤切换直接重渲染
    function commitChange() {
      syncAllFromModel();
    }


    function isContainerDef(n) {
      return !!(n && (n.variant === 'container' || (n.children && n.children.length)));
    }

    function indexModel() {
      nodeDefs = new Map();
      parentOf = new Map();
      childIds = new Map();
      containerIds = new Set();
      topIds = [];
      function walk(list, parentId) {
        (list || []).forEach(function(n) {
          nodeDefs.set(n.id, n);
          parentOf.set(n.id, parentId);
          if (parentId) {
            if (!childIds.has(parentId)) childIds.set(parentId, []);
            childIds.get(parentId).push(n.id);
          } else {
            topIds.push(n.id);
          }
          if (isContainerDef(n)) {
            containerIds.add(n.id);
            walk(n.children || [], n.id);
          }
        });
      }
      walk(model.nodes, null);
    }


    function syncAllFromModel() {
      indexModel();
      reconcileDom();
      document.querySelectorAll('[data-model-field]').forEach(function(element) {
        const key = element.dataset.modelField;
        const value = String(model[key] || '');
        if (element.textContent !== value) element.textContent = value;
      });
      syncNodeTextAndPositions();
      syncContainers();
      resizeCanvasToContent();
      applyStageLayout();
      renderEdges();
      refreshSelectionClass();
      syncSkinFromModel();      // Phase 3: 皮肤跟随模型(含 undo/redo/JSON 应用)
      scheduleQualityRefresh(); // Phase 2: 编辑后 500ms 防抖重检
    }

    // ---------- 字号自适应: 文字随 ARCHITECTURE 外框放大/缩小 ----------
    // 外框缩放会等比改写所有节点的 x/y/w/h(applyFrameGeometry), 字号若固定在 24px
    // 就会溢出节点框。这里做两级处理:
    //   1) 等比档: 目标字号 = 基准字号 × 外框缩放系数(相对生成时的外框)
    //   2) 装箱档: 目标字号若仍装不下(非等比拉伸/长文本/菱形窄腰), 二分再缩到装得下为止
    // 估宽口径与 lib/quality-checker.mjs、lib/exporters/scene-svg.mjs 保持一致:
    // CJK 记 1em、ASCII 记 0.52em, 行高 LINE_H; 内边距/图标占位一律取自结构 token。
    let TYPE_BASE = { node: METRICS.typeNode, sub: METRICS.typeSmall, edgeLabel: ${EDGE_LABEL_PX} };
    const TYPE_MIN_PX = 10;                       // 字号下限, 低于此值不再缩(改为允许溢出前的最后防线)
    const TYPE_SCALE_RANGE = { min: 0.3, max: 2 }; // 外框缩放系数的钳制区间
    const BASE_FRAME = clone(
      (initialModel && initialModel.frame)
      || ((SLIDE_LAYOUTS[(initialModel && initialModel.layout) || 'B'] || SLIDE_LAYOUTS.B).frame)
    );

    function typeScale() {
      if (!model.frame || !BASE_FRAME || !(BASE_FRAME.w > 0) || !(BASE_FRAME.h > 0)) return 1;
      const s = Math.min(model.frame.w / BASE_FRAME.w, model.frame.h / BASE_FRAME.h);
      if (!isFinite(s) || s <= 0) return 1;
      return Math.max(TYPE_SCALE_RANGE.min, Math.min(TYPE_SCALE_RANGE.max, s));
    }

    // 外框缩放系数施加到全部结构 token。scaleMetrics 出于构建期的理由不缩容器内边距,
    // 但运行时容器是"子节点包围盒 + 内边距"现算的, 不缩会让容器随缩小越变越胖, 故在此补上。
    function scaleMetricsRuntime(base, s) {
      const out = {};
      const scaled = scaleMetrics(base, s);
      for (let i = 0; i < METRICS_KEYS.length; i++) out[METRICS_KEYS[i]] = scaled[METRICS_KEYS[i]];
      out.panelPadX = base.panelPadX * s;
      out.panelPadTop = base.panelPadTop * s;
      out.panelPadLeft = base.panelPadLeft * s;
      out.panelLabelH = base.panelLabelH * s;
      out.panelLabelPadX = base.panelLabelPadX * s;
      out.panelLabelW = base.panelLabelW * s;
      out.gutterScale = base.gutterScale;   // 比例量, 不参与缩放
      out.panelLabelMode = base.panelLabelMode;   // 枚举, 不参与缩放
      out.panelLabelAlign = base.panelLabelAlign;
      return out;
    }

    // ---------- 连线权重: 线宽与箭头端点随整图几何系数走(lib/edge-weight.mjs) ----------
    // S = FIT_SCALE(生成期把内容装进外框的系数) × typeScale()(运行期外框缩放系数)。
    // 只用后者是原来的 bug: 生成期缩到 0.66 的图, 卡片小了而线宽/箭头照旧。
    // 端点写在 <defs> 的两个 marker 上, 全图共用一份, 因此这里直接改写 marker 属性。
    let appliedEdgeKey = '';
    function applyEdgeWeights(s) {
      const base = Number(currentSkin().tokens.ew) || 2;
      const geo = GEO_FIT * s;
      const key = base + '|' + Math.round(geo * 1000);
      if (key === appliedEdgeKey) return;
      appliedEdgeKey = key;
      const weight = edgeWeight(base, geo);
      const arrow = arrowMarkerGeometry(weight);
      canvas.style.setProperty('--geo-scale', String(Math.round(geo * 1000) / 1000));
      canvas.style.setProperty('--edge-stroke', weight.width + 'px');
      const heads = svgInk.querySelectorAll('defs marker');
      for (let i = 0; i < heads.length; i++) {
        const m = heads[i];
        const rev = m.id === 'arrow-rev';
        m.setAttribute('markerWidth', String(arrow.markerWidth));
        m.setAttribute('markerHeight', String(arrow.markerHeight));
        m.setAttribute('refX', String(rev ? arrow.refXRev : arrow.refX));
        m.setAttribute('refY', String(arrow.refY));
        const p = m.querySelector('path');
        if (p) {
          p.setAttribute('d', rev ? arrow.dRev : arrow.d);
          p.setAttribute('stroke-width', String(arrow.strokeWidth));
        }
      }
    }

    // 把外框缩放系数落到: 结构 token(RMETRICS/LAY/PAD) + CSS 变量 + 连线的走线常量与权重。
    // 写死在 CSS 里的几何量(圆角/虚线段/标签内边距)由 --type-scale / --geo-scale 在 calc() 里消费。
    let appliedScaleKey = '';
    function applyFrameScale() {
      const s = typeScale();
      const key = s + '|' + METRICS.typeNode + '|' + METRICS.cardPadX + '|' + METRICS.iconSize;
      RMETRICS = s === 1 ? METRICS : scaleMetricsRuntime(METRICS, s);
      LAY = skinLayout(RMETRICS);
      PAD = LAY.panelPad;
      STUB = Math.max(4, Math.round(STUB_BASE * s * 10) / 10);
      ROUND = Math.max(3, Math.round(ROUND_BASE * s * 10) / 10);
      applyEdgeWeights(s);   // 皮肤基准线宽也可能变, 故不放在下面的早退之后
      if (key === appliedScaleKey) return s;   // 系数与皮肤都没变时不重写 CSS 变量
      appliedScaleKey = key;
      canvas.style.setProperty('--type-scale', String(Math.round(s * 1000) / 1000));
      const vars = skinMetricsCssVarMap(RMETRICS);
      Object.keys(vars).forEach(function(k) { canvas.style.setProperty(k, vars[k]); });
      return s;
    }

    function estTextWidth(text, px) {
      const s = String(text == null ? '' : text);
      let units = 0;
      for (let i = 0; i < s.length; i++) units += s.charCodeAt(i) > 0xff ? 1 : 0.52;
      return units * px;
    }
    // ================= 节点内容阶梯自适应(lib/node-fit.mjs) =================
    // 档位阶梯建在设计空间(未缩放的 METRICS.typeNode)而不是 RMETRICS: 外框缩放会等比缩小
    // 每个节点的 w/h, 若字号也跟着连续缩, 就永远看不到"先挤间距、再跃迁字号"的过程。
    // upSteps 取 6 是为了 1.125^6 ≈ 2, 覆盖 TYPE_SCALE_RANGE.max, 放大外框时字号仍能逐档升上去。
    const FIT_OPTS = { upSteps: 6, minFontPx: TYPE_MIN_PX, lineH: LINE_H };
    let fitLadderCache = { key: '', ladder: null };
    function fitLadder() {
      const key = (appliedSkinId || '') + '|' + METRICS.typeNode;
      if (fitLadderCache.key !== key) {
        fitLadderCache = { key: key, ladder: buildTypeLadder(METRICS.typeNode, FIT_OPTS) };
      }
      return fitLadderCache.ladder;
    }
    // 整图统一档位: 名义字号(基准 × 外框缩放, 即旧算法的 target)吸附到阶梯上取最大的不超过档。
    // 同一张图的节点必须共用字号 —— 逐节点各自取最优会让相邻卡片字号差出一倍, 是观感事故。
    // 外框连续缩小时, 名义字号连续下降但档位是台阶: 台阶之间字号不动, 由内边距吸收; 跨台阶才跃迁。
    // 这里不做滞回: 档位是缩放的纯函数, 与"上一帧是什么"无关。带状态的滞回会让边界恰好落在
    // 档位值上时(缩放系数为 1 就是这种情况)卡在旧档, 重置/切版式后整图停在错误字号。
    // 节点级的滞回仍然保留(prevTier), 那里比较的是盒子尺寸, 确实需要防抖。
    function pickStartTier(ladder, nominalPx) {
      for (let i = 0; i < ladder.length; i++) {
        if (ladder[i] <= nominalPx + 1e-6) return i;
      }
      return ladder.length - 1;
    }

    // ---- 文本测量: 交给浏览器实测, 不再用估算宽度倒推行数 ----
    // 探针挂在 body 上(不在 #stage 里), 因为舞台带 transform 缩放, getClientRects 会返回屏幕像素。
    let fitProbeEl = null, fitProbeKey = '', fitRange = null;
    const fitProbeFont = { label: null, sub: null };
    const fitMeasureCache = new Map();
    const fitBorderCache = new Map();
    function fitProbeFonts(role) {
      const key = (appliedSkinId || '') + '|' + METRICS.typeNode;
      if (fitProbeKey !== key) {
        fitProbeKey = key;
        fitMeasureCache.clear();
        fitBorderCache.clear();
        fitProbeFont.label = fitFontOf(canvas.querySelector('.node-label'), '650');
        fitProbeFont.sub = fitFontOf(canvas.querySelector('.node-sub') || canvas.querySelector('.node-label'), '400');
      }
      return role === 'sub' ? fitProbeFont.sub : fitProbeFont.label;
    }
    function fitFontOf(el, fallbackWeight) {
      const out = { family: '-apple-system,sans-serif', weight: fallbackWeight, ls: 'normal' };
      if (!el) return out;
      try {
        const cs = getComputedStyle(el);
        if (cs.fontFamily) out.family = cs.fontFamily;
        if (cs.fontWeight) out.weight = cs.fontWeight;
        if (cs.letterSpacing) out.ls = cs.letterSpacing;
      } catch (err) { /* 取不到就用兜底值 */ }
      return out;
    }
    function measureText(text, fontPx, availW, role) {
      const s = String(text == null ? '' : text);
      if (!s) return { lines: 0, width: 0 };
      const w = Math.max(1, Math.round(availW * 10) / 10);
      const px = Math.round(fontPx * 10) / 10;
      const key = role + '|' + px + '|' + w + '|' + s;
      const hit = fitMeasureCache.get(key);
      if (hit) return hit;
      const f = fitProbeFonts(role);
      if (!fitProbeEl) {
        fitProbeEl = document.createElement('div');
        fitProbeEl.className = 'fit-probe';
        document.body.appendChild(fitProbeEl);
        fitRange = document.createRange();
      }
      fitProbeEl.style.font = f.weight + ' ' + px + 'px/' + LINE_H + ' ' + f.family;
      fitProbeEl.style.letterSpacing = f.ls;
      fitProbeEl.style.width = w + 'px';
      fitProbeEl.textContent = s;
      fitRange.selectNodeContents(fitProbeEl);
      const rects = fitRange.getClientRects();
      let lines = 0, maxW = 0;
      for (let i = 0; i < rects.length; i++) {
        if (rects[i].width < 0.5) continue;
        lines++;
        if (rects[i].width > maxW) maxW = rects[i].width;
      }
      if (!lines) { lines = 1; maxW = 0; }
      const out = { lines: lines, width: Math.round(maxW * 10) / 10 };
      if (fitMeasureCache.size > 4000) fitMeasureCache.clear();   // 拖动时可用宽连续变化, 防止无限增长
      fitMeasureCache.set(key, out);
      return out;
    }
    // border-box 下边框吃掉的是内容宽高, 不计入就会比实际多出 2×border 的可用空间
    function fitBorderPx(el) {
      const key = el.className;
      if (fitBorderCache.has(key)) return fitBorderCache.get(key);
      let px = 0;
      try { px = parseFloat(getComputedStyle(el).borderLeftWidth) || 0; } catch (err) { px = 0; }
      fitBorderCache.set(key, px);
      return px;
    }
    function nodeFitStyleOf(n, def) {
      const variant = (def && def.variant) || 'default';
      const hasIcon = !!(def && def.icon && typeof def.icon === 'string' && ICON_ASSETS[def.icon]);
      const iconTop = hasIcon && def.iconPosition === 'top';
      return nodeFitStyle(METRICS, {
        variant: variant === 'decision' || variant === 'circle' ? variant : 'default',
        icon: hasIcon ? (iconTop ? 'top' : 'left') : null,
        borderPx: fitBorderPx(n.el),
      });
    }
    // 求解结果落到 DOM: 间距/图标写成节点自身的 CSS 变量(覆盖画布级), 字号写内联 font-size
    function applyNodeFit(n, sol, def) {
      const el = n.el;
      const hasIcon = !!(def && def.icon && typeof def.icon === 'string' && ICON_ASSETS[def.icon]);
      const iconTop = hasIcon && def.iconPosition === 'top';
      el.style.setProperty('--card-pad-x', sol.padX + 'px');
      el.style.setProperty('--card-pad-y', sol.padY + 'px');
      el.style.setProperty('--label-sub-gap', sol.gap + 'px');
      if (hasIcon) {
        el.style.setProperty(iconTop ? '--icon-size-top' : '--icon-size', sol.iconSize + 'px');
        el.style.setProperty(iconTop ? '--icon-gap-top' : '--icon-gap-x', sol.iconGap + 'px');
      }
      const labelEl = el.querySelector('.node-label');
      const subEl = el.querySelector('.node-sub');
      if (labelEl) {
        labelEl.style.fontSize = sol.fontPx + 'px';
        labelEl.classList.toggle('fit-clamp', sol.clampLabel > 0);
        if (sol.clampLabel > 0) labelEl.style.webkitLineClamp = String(sol.clampLabel);
        else labelEl.style.webkitLineClamp = '';
      }
      if (subEl) {
        subEl.style.fontSize = (sol.subPx || sol.fontPx * (METRICS.typeSmall / METRICS.typeNode)) + 'px';
        subEl.classList.toggle('fit-drop', !!sol.dropSub);
        subEl.classList.toggle('fit-clamp', sol.clampSub > 0);
        if (sol.clampSub > 0) subEl.style.webkitLineClamp = String(sol.clampSub);
        else subEl.style.webkitLineClamp = '';
      }
    }
    // 皮肤的 kicker 字号(容器标签基准), 从 --kicker-font 简写里取 px; 换肤后失效重取
    let kickerBaseCache = { skin: null, px: 19 };
    function kickerBasePx() {
      const key = appliedSkinId || '';
      if (kickerBaseCache.skin === key) return kickerBaseCache.px;
      let px = 19;
      try {
        const raw = getComputedStyle(document.documentElement).getPropertyValue('--kicker-font');
        const m = /([\\d.]+)px/.exec(raw || '');
        if (m) px = parseFloat(m[1]);
      } catch (err) { /* 取不到就用默认 19px */ }
      kickerBaseCache = { skin: key, px: px };
      return px;
    }

    // 按当前外框缩放系数重排框内所有文字(节点走阶梯自适应, 容器标签仍按比例缩)
    function applyTypeScale() {
      const scale = applyFrameScale();
      const ladder = fitLadder();
      const startTier = pickStartTier(ladder, METRICS.typeNode * scale);
      nodes.forEach(function(n, id) {
        const def = nodeDefs.get(id) || {};
        // v-database 用 padding-top 给顶部的椭圆让位, 那部分高度不能算进可用区
        const dbTop = def.variant === 'database' ? 10 * scale : 0;
        const sol = solveNodeFit({ w: n.w, h: n.h - dbTop },
          { label: def.label || '', sublabel: def.sublabel },
          nodeFitStyleOf(n, def), measureText,
          Object.assign({ prevTier: n.fitTier, startTier: startTier }, FIT_OPTS));
        n.fitTier = sol.tier;
        n.fit = sol;
        n.labelPx = sol.fontPx;
        n.subPx = sol.subPx || Math.round(sol.fontPx * (METRICS.typeSmall / METRICS.typeNode) * 10) / 10;
        applyNodeFit(n, sol, def);
      });
      const kickerTarget = kickerBasePx() * scale;
      // 编组标题可用长度随形态变: 药丸吃内容区宽, 通栏带吃整条带宽, 竖排吃容器高
      function panelLabelAvail(p) {
        const pad = RMETRICS.panelLabelPadX * 2;
        if (RMETRICS.panelLabelMode === 'side') return p.h - pad;
        if (RMETRICS.panelLabelMode === 'bar-top') return p.w - pad;
        return p.w - LAY.panelPad.left - RMETRICS.panelPadX - pad;
      }
      panels.forEach(function(p, id) {
        const def = nodeDefs.get(id) || {};
        const labelEl = p.el.querySelector('.panel-label');
        if (!labelEl) return;
        const availW = Math.max(16, panelLabelAvail(p));
        const w = estTextWidth(def.label || '', kickerTarget);
        const px = w > availW
          ? Math.max(TYPE_MIN_PX, Math.round(kickerTarget * (availW / w) * 10) / 10)
          : Math.round(kickerTarget * 10) / 10;
        p.labelPx = px;
        labelEl.style.fontSize = px + 'px';
      });
    }

    function syncNodeTextAndPositions() {
      nodes.forEach(function(n, id) {
        const pos = model.positions && model.positions[id];
        n.x = pos && typeof pos.x === 'number' ? pos.x : n.baseX;
        n.y = pos && typeof pos.y === 'number' ? pos.y : n.baseY;
        n.el.style.left = n.x + 'px';
        n.el.style.top = n.y + 'px';
        if (pos && typeof pos.w === 'number') { n.w = pos.w; n.el.style.width = pos.w + 'px'; }
        if (pos && typeof pos.h === 'number') { n.h = pos.h; n.el.style.height = pos.h + 'px'; }
        const def = nodeDefs.get(id);
        if (def) {
          const labelEl = n.el.querySelector('.node-label');
          if (labelEl && labelEl.textContent !== String(def.label || '')) labelEl.textContent = def.label || '';
          let subEl = n.el.querySelector('.node-sub');
          if (def.sublabel != null) {
            if (!subEl) {
              subEl = document.createElement('span');
              subEl.className = 'node-sub';
              n.el.appendChild(subEl);
            }
            if (subEl.textContent !== String(def.sublabel || '')) subEl.textContent = def.sublabel || '';
          } else if (subEl) {
            subEl.remove();
          }
        }
      });
      panels.forEach(function(panel, id) {
        const def = nodeDefs.get(id);
        const labelEl = panel.el.querySelector('.panel-label');
        if (def && labelEl && labelEl.textContent !== String(def.label || '')) labelEl.textContent = def.label || '';
      });
    }

    function syncContainers() {
      applyFrameScale();   // 容器由子节点包围盒 + PAD 现算, PAD 必须先按当前外框系数刷新
      function compute(id) {
        const panel = panels.get(id);
        const rects = [];
        (childIds.get(id) || []).forEach(function(childId) {
          if (containerIds.has(childId)) rects.push(compute(childId));
          else if (nodes.has(childId)) rects.push(nodes.get(childId));
        });
        if (!panel || !rects.length) return panel || { x: 0, y: 0, w: 0, h: 0 };
        const x1 = Math.min.apply(null, rects.map(function(r) { return r.x; })) - PAD.left;
        const y1 = Math.min.apply(null, rects.map(function(r) { return r.y; })) - PAD.top;
        const x2 = Math.max.apply(null, rects.map(function(r) { return r.x + r.w; })) + PAD.x;
        const y2 = Math.max.apply(null, rects.map(function(r) { return r.y + r.h; })) + PAD.bottom;
        panel.x = x1; panel.y = y1; panel.w = x2 - x1; panel.h = y2 - y1;
        panel.el.style.left = panel.x + 'px';
        panel.el.style.top = panel.y + 'px';
        panel.el.style.width = panel.w + 'px';
        panel.el.style.height = panel.h + 'px';
        return panel;
      }
      topIds.forEach(function(id) {
        if (containerIds.has(id)) compute(id);
      });
      applyTypeScale(); // 几何变了就重算字号(容器尺寸此时已就绪)
    }

    function rectOf(id) {
      return nodes.get(id) || panels.get(id) || null;
    }

    // --- 连线路径算法(移植自生成器阶段3) ---
    // 静止态(启动/落位/提交/撤销)用 computeQualityRoutes: 避障 + 端口错开, 与生成器同质
    // 拖拽过程(pointermove)用 bestRoute: 无避障快速版, 保帧率; 松手后 rerouteAll 恢复全质量
    // 走线常量随外框缩放(applyFrameScale 改写), 否则外框缩小后出线段与圆角相对节点显得过大
    const STUB_BASE = 18, ROUND_BASE = 14;
    let STUB = STUB_BASE, ROUND = ROUND_BASE;
    const SIDES = ['top','bottom','left','right'];
    const portPt = (n, side, off = 0) => side === 'top' ? {x: n.x + n.w/2 + off, y: n.y}
      : side === 'bottom' ? {x: n.x + n.w/2 + off, y: n.y + n.h}
      : side === 'left' ? {x: n.x, y: n.y + n.h/2 + off}
      : {x: n.x + n.w, y: n.y + n.h/2 + off};
    const outDir = {top:{x:0,y:-1},bottom:{x:0,y:1},left:{x:-1,y:0},right:{x:1,y:0}};
    const pathLen = pts => pts.slice(1).reduce((a,p,i) => a + Math.abs(p.x-pts[i].x) + Math.abs(p.y-pts[i].y), 0);

    function candidateRoutes(a, sa, b, sb) {
      const oa = outDir[sa], ob = outDir[sb];
      const a1 = {x:a.x+oa.x*STUB, y:a.y+oa.y*STUB};
      const b1 = {x:b.x+ob.x*STUB, y:b.y+ob.y*STUB};
      const axA = oa.x?'h':'v', axB = ob.x?'h':'v';
      const cands = [];
      if (axA === axB) {
        if (axA==='h' && Math.abs(a.y-b.y)<6 && oa.x===-ob.x) cands.push([a, {x:b.x, y:a.y}]);
        if (axA==='v' && Math.abs(a.x-b.x)<6 && oa.y===-ob.y) cands.push([a, {x:a.x, y:b.y}]);
        if (axA==='h') { const mx=(a1.x+b1.x)/2; cands.push([a,a1,{x:mx,y:a1.y},{x:mx,y:b1.y},b1,b]); }
        else { const my=(a1.y+b1.y)/2; cands.push([a,a1,{x:a1.x,y:my},{x:b1.x,y:my},b1,b]); }
      } else {
        cands.push(axA==='h' ? [a,a1,{x:b1.x,y:a1.y},b1,b] : [a,a1,{x:a1.x,y:b1.y},b1,b]);
      }
      return cands
        .map(pts => pts.filter((p,i) => !i || Math.abs(p.x-pts[i-1].x)>0.5 || Math.abs(p.y-pts[i-1].y)>0.5))
        .filter(pts => pts.length >= 2);
    }

    function selfLoopRoute(r) {
      // 自环: 右侧出 → 绕右上角 → 顶边入(与构建器一致, 修 P0#2)
      return [
        { x: r.x + r.w, y: r.y + r.h / 2 },
        { x: r.x + r.w + 26, y: r.y + r.h / 2 },
        { x: r.x + r.w + 26, y: r.y - 22 },
        { x: r.x + r.w / 2, y: r.y - 22 },
        { x: r.x + r.w / 2, y: r.y }
      ];
    }

    function bestRoute(srcNode, tgtNode) {
      if (srcNode === tgtNode) return selfLoopRoute(srcNode);
      let best = null;
      for (const sa of SIDES) for (const sb of SIDES) {
        const a = portPt(srcNode, sa), b = portPt(tgtNode, sb);
        for (const pts of candidateRoutes(a, sa, b, sb)) {
          const score = pathLen(pts) + (pts.length-2)*90;
          if (!best || score < best.score) best = {pts: pts, score: score};
        }
      }
      return best ? best.pts : [portPt(srcNode,'right'), portPt(tgtNode,'left')];
    }

    // 静止态布线与构建期共用 lib/edge-router.mjs(已内联), 保证页面几何与构建产物一致
    // 布线器的几何常量(引出长度/轨道间距/外侧条带厚度…)都是绝对像素, 整图缩小后必须同比缩,
    // 否则外侧条带仍按原厚度取轨道, 连线会从外框上方绕出去。penalty 里只有 bendPenalty 与
    // 路径长同量纲, 一并缩; blockPenalty 是硬约束, 不动。
    const ROUTER_SCALED_KEYS = ['stub','portPitch','portMinPitch','portInset','trackPitch','trackMinPitch',
      'bandMargin','outerBand','groupTol','obstaclePad','minSep','bendPenalty'];
    function routerOptionsNow() {
      const s = typeScale();
      const o = {};
      if (s !== 1 && typeof ROUTER_DEFAULTS !== 'undefined') {
        ROUTER_SCALED_KEYS.forEach(function(k) {
          if (isFinite(ROUTER_DEFAULTS[k])) o[k] = Math.max(2, ROUTER_DEFAULTS[k] * s);
        });
      }
      // 与构建期(arch-doc buildScene)同一份: 画布边界钳制外圈绕行 + 箭头前端净空
      o.bounds = { x: 0, y: 0, w: 1920, h: 1080 };
      const ewBase = Number(((SKINS[model.skin] || SKINS[ACTIVE_SKIN_ID] || {}).tokens || {}).ew) || 2;
      o.minLastSeg = Math.ceil(edgeWeight(ewBase, GEO_FIT * s).headLen * 1.25);
      return o;
    }

    function computeQualityRoutes() {
      const cards = [];
      nodes.forEach(function(n) { cards.push({ id: n.id, x: n.x, y: n.y, w: n.w, h: n.h }); });
      const rects = cards.slice();
      panels.forEach(function(p) { rects.push({ id: p.id, x: p.x, y: p.y, w: p.w, h: p.h }); });
      const wanted = model.edges
        .filter(function(e) { return rectOf(e.source) && rectOf(e.target); })
        .map(function(e) {
          // 手调走线跟着 model.edges 一起进来, 拖节点重算时也要带上, 否则线会弹回自动布线
          return { id: e.id, source: e.source, target: e.target,
            sourcePort: e.sourcePort, targetPort: e.targetPort, segShifts: e.segShifts };
        });
      const routed = routeEdges({ rects: rects, cards: cards, edges: wanted, options: routerOptionsNow() });
      const routes = new Map();
      routed.routes.forEach(function(r, id) { routes.set(id, r.pts); });
      // 布线器未覆盖的边(端点缺失等)退回无避障最短路
      model.edges.forEach(function(e) {
        if (routes.has(e.id)) return;
        const ra = rectOf(e.source), rb = rectOf(e.target);
        if (ra && rb) routes.set(e.id, bestRoute(ra, rb));
      });
      return routes;
    }

    function rerouteAll() {
      const routes = computeQualityRoutes();
      edgeState.forEach(function(e) {
        const pts = routes.get(e.id);
        if (pts) setEdgePath(e, pts);
      });
    }

    function roundedD(pts) {
      if (pts.length < 2) return '';
      let d = 'M '+pts[0].x+' '+pts[0].y;
      for (let i=1; i<pts.length-1; i++) {
        const p=pts[i], prev=pts[i-1], next=pts[i+1];
        const inL=Math.hypot(p.x-prev.x,p.y-prev.y), outL=Math.hypot(next.x-p.x,next.y-p.y);
        const rr=Math.min(ROUND,inL/2,outL/2);
        if(rr<1){d+=' L '+p.x+' '+p.y; continue;}
        const inU={x:(p.x-prev.x)/inL,y:(p.y-prev.y)/inL};
        const outU={x:(next.x-p.x)/outL,y:(next.y-p.y)/outL};
        d+=' L '+(p.x-inU.x*rr)+' '+(p.y-inU.y*rr);
        d+=' Q '+p.x+' '+p.y+' '+(p.x+outU.x*rr)+' '+(p.y+outU.y*rr);
      }
      d+=' L '+pts.at(-1).x+' '+pts.at(-1).y;
      return d;
    }

    function renderEdges() {
      [svgHit, svgInk].forEach(function(layer) {
        layer.querySelectorAll('path[data-edge-id]').forEach(function(el) { el.remove(); });
      });
      canvas.querySelectorAll('.edge-label[data-edge-id]').forEach(function(el) { el.remove(); });
      edgeState = new Map();
      model.edges.forEach(function(edge) {
        createEdgeDom(edge);
      });
      rerouteAll();
    }

    function createEdgeDom(edge) {
      const hitEl = document.createElementNS(SVG_NS, 'path');
      hitEl.classList.add('edge-hit');
      const pathEl = document.createElementNS(SVG_NS, 'path');
      pathEl.classList.add('edge');
      if (edge.style === 'dashed') pathEl.classList.add('dashed');
      [hitEl, pathEl].forEach(function(el) {
        el.dataset.edgeId = edge.id;
        el.dataset.source = edge.source;
        el.dataset.target = edge.target;
      });
      // 无向边两头都不设 marker
      if (!edge.undirected && (!edge.reversed || edge.bidirectional)) pathEl.setAttribute('marker-end', 'url(#arrow)');
      if (!edge.undirected && (edge.bidirectional || edge.reversed)) pathEl.setAttribute('marker-start', 'url(#arrow-rev)');
      svgHit.appendChild(hitEl);
      svgInk.appendChild(pathEl);
      let labelEl = null;
      if (hasOwn(edge, 'label')) {
        labelEl = document.createElement('div');
        labelEl.className = 'edge-label';
        labelEl.dataset.edgeId = edge.id;
        labelEl.dataset.source = edge.source;
        labelEl.dataset.target = edge.target;
        labelEl.textContent = edge.label || '';
        labelEl.classList.toggle('empty', !edge.label);
        canvas.appendChild(labelEl);
      }
      const state = { id: edge.id, source: edge.source, target: edge.target, hitEl: hitEl, pathEl: pathEl, labelEl: labelEl,
        labelT: Number.isFinite(edge.labelT) ? edge.labelT : null };
      edgeState.set(edge.id, state);
    }

    function setEdgePath(e, pts) {
      const d = roundedD(pts);
      e.pts = pts; // Phase 2: 质量检查/导出需要折线顶点
      e.hitEl.setAttribute('d', d);
      e.pathEl.setAttribute('d', d);
      positionEdgeLabel(e);
    }

    // 标签落点: 拖过的边按 labelT(归一化弧长)沿线定位, 没拖过的仍落在最长一段中点
    function positionEdgeLabel(e) {
      if (!e || !e.labelEl || !Array.isArray(e.pts) || !e.pts.length) return;
      const p = edgeLabelPoint(e.pts, Number.isFinite(e.labelT) ? e.labelT : undefined, EDGE_LABEL_PAD);
      if (!p) return;
      e.labelEl.style.left = p.x + 'px';
      e.labelEl.style.top = p.y + 'px';
    }

    // 拖拽中的快速版: 单边重算, 不做避障
    function updateEdge(e) {
      const sn = rectOf(e.source), tn = rectOf(e.target);
      if (!sn || !tn) return;
      setEdgePath(e, bestRoute(sn, tn));
    }


    function captureLeafGeometry() {
      const out = {};
      nodes.forEach(function(node, id) {
        out[id] = { x: node.x, y: node.y, w: node.w, h: node.h };
      });
      return out;
    }

    function applyFrameGeometry(fromFrame, toFrame, baseline) {
      if (!fromFrame || !toFrame || fromFrame.w <= 0 || fromFrame.h <= 0) return;
      if (!model.positions) model.positions = {};
      Object.keys(baseline || {}).forEach(function(id) {
        const rect = baseline[id];
        const nx = (rect.x - fromFrame.x) / fromFrame.w;
        const ny = (rect.y - fromFrame.y) / fromFrame.h;
        const nw = rect.w / fromFrame.w;
        const nh = rect.h / fromFrame.h;
        model.positions[id] = {
          x: roundPos(toFrame.x + nx * toFrame.w),
          y: roundPos(toFrame.y + ny * toFrame.h),
          w: roundPos(nw * toFrame.w),
          h: roundPos(nh * toFrame.h)
        };
      });
      syncNodeTextAndPositions();
      syncContainers();
      edgeState.forEach(function(edge) { updateEdge(edge); });
    }


    function switchLayout(layoutId) {
      const nextId = ['A','B','C'].indexOf(layoutId) >= 0 ? layoutId : 'B';
      if (nextId === model.layout) return;
      const oldFrame = clone(model.frame);
      const baseline = captureLeafGeometry();
      model.layout = nextId;
      model.frame = clone(SLIDE_LAYOUTS[nextId].frame);
      applyFrameGeometry(oldFrame, model.frame, baseline);
      commitChange();
    }


    // --- 拖拽 ---




    // --- 连线 / 删除模式 ---
    const btnExport = document.getElementById('btn-export');
    const btnSkin = document.getElementById('btn-skin');
    const btnQuality = document.getElementById('btn-quality');
    const btnPresent = document.getElementById('btn-present');
    const layoutButtons = Array.from(document.querySelectorAll('[data-layout]'));

    layoutButtons.forEach(function(button) {
      button.onclick = function() { switchLayout(button.dataset.layout); };
    });
    btnExport.onclick = function(ev) {
      ev.stopPropagation();
      toggleExportMenu();
    };
    btnSkin.onclick = function(ev) {
      ev.stopPropagation();
      toggleSkinMenu();
    };
    btnQuality.onclick = function() {
      toggleQualityPanel();
    };
    btnPresent.onclick = function() {
      const on = !document.body.classList.contains('presenting');
      if (on) clearSelection();
      document.body.classList.toggle('presenting', on);
      btnPresent.classList.toggle('active', on);
      btnPresent.textContent = on ? '退出演示' : '演示';
    };


    // --- 架构图外框: 重画 / 移动 / 八方向缩放 ---


    function flashEdge(id) {
      const state = edgeState.get(id);
      if (!state) return;
      state.pathEl.classList.remove('flash');
      void state.pathEl.offsetWidth;
      state.pathEl.classList.add('flash');
      setTimeout(function() { if (state.pathEl) state.pathEl.classList.remove('flash'); }, 1100);
    }

    // =========== 手绘编辑扩展: 加节点 / 编组嵌套 / 框定 / 一键规整 ===========


    // --- DOM 对账: 节点/容器像连线一样由 model 驱动生成/移除(修"新增节点刷新后隐形") ---
    function containerDepth(id) {
      let d = 0, p = parentOf.get(id);
      while (p != null) { if (containerIds.has(p)) d++; p = parentOf.get(p); }
      return d;
    }

    function createNodeDom(def) {
      const el = document.createElement('div');
      el.className = 'node v-' + (def.variant || 'default');
      el.dataset.id = def.id;
      const pos = model.positions && model.positions[def.id];
      const hasSub = def.sublabel != null && def.sublabel !== '';
      const w = pos && typeof pos.w === 'number' ? pos.w : 200;
      const h = pos && typeof pos.h === 'number' ? pos.h : (hasSub ? 84 : 64);
      const x = pos && typeof pos.x === 'number' ? pos.x : 0;
      const y = pos && typeof pos.y === 'number' ? pos.y : 0;
      el.style.left = x + 'px'; el.style.top = y + 'px';
      el.style.width = w + 'px'; el.style.height = h + 'px';
      const iconEl = makeIconSpan(def);
      if (iconEl) {
        el.classList.add('has-icon', 'icon-' + (def.iconPosition === 'top' ? 'top' : 'left'));
        el.appendChild(iconEl);
      }
      const label = document.createElement('span');
      label.className = 'node-label';
      label.textContent = def.label || '';
      el.appendChild(label);
      if (hasSub) {
        const sub = document.createElement('span');
        sub.className = 'node-sub';
        sub.textContent = def.sublabel;
        el.appendChild(sub);
      }
      canvas.appendChild(el);
      nodes.set(def.id, { id: def.id, el: el, baseX: x, baseY: y, x: x, y: y, w: w, h: h });
    }

    function createPanelDom(def) {
      const el = document.createElement('div');
      el.className = 'panel depth-' + containerDepth(def.id);
      el.dataset.id = def.id;
      const label = document.createElement('span');
      label.className = 'panel-label';
      label.textContent = def.label || '';
      el.appendChild(label);
      canvas.appendChild(el);
      panels.set(def.id, { id: def.id, el: el, x: 0, y: 0, w: 0, h: 0 });
    }

    function removeNodeDom(id) {
      const n = nodes.get(id);
      if (n) { n.el.remove(); nodes.delete(id); }
      selection.delete(id);
    }
    function removePanelDom(id) {
      const p = panels.get(id);
      if (p) { p.el.remove(); panels.delete(id); }
    }

    function reconcileDom() {
      const wantNodes = new Set(), wantPanels = new Set();
      nodeDefs.forEach(function(def, id) {
        if (isContainerDef(def)) wantPanels.add(id); else wantNodes.add(id);
      });
      Array.from(nodes.keys()).forEach(function(id) { if (!wantNodes.has(id)) removeNodeDom(id); });
      Array.from(panels.keys()).forEach(function(id) { if (!wantPanels.has(id)) removePanelDom(id); });
      wantNodes.forEach(function(id) { if (!nodes.has(id)) createNodeDom(nodeDefs.get(id)); });
      wantPanels.forEach(function(id) { if (!panels.has(id)) createPanelDom(nodeDefs.get(id)); });
      panels.forEach(function(p, id) { p.el.className = 'panel depth-' + containerDepth(id); });
    }


    // --- 选择 ---
    function selectOnly(id) { selection = new Set(id ? [id] : []); refreshSelectionClass(); }
    function clearSelection() { if (!selection.size) return; selection = new Set(); refreshSelectionClass(); }
    function refreshSelectionClass() {
      nodes.forEach(function(n, id) { n.el.classList.toggle('selected', selection.has(id)); });
    }


    // 架构图外框只作为数据存在(model.frame: 版式切换与字号缩放读它), 只读产物不画外框元素 ——
    // 它原是编辑态拖动 / 缩放的手柄, 编辑迁到工作台后样式也跟着走了, 留下的空 div 会以静态流
    // 排在画布原点, 把「ARCHITECTURE」标签露在幻灯片左上角。工作台只读态同样不显示外框。


    // --- 导出 / 重置 ---
    function serialize() {
      const out = {
        title: model.title,
        subtitle: model.subtitle,
        direction: model.direction,
        layout: model.layout,
        skin: model.skin,
        nodes: model.nodes.map(cleanNode),
        edges: model.edges.map(cleanEdge),
        positions: cleanPositions(model.positions || {})
      };
      if (model.frame) out.frame = model.frame;
      if (model.mode === 'layered') out.mode = 'layered';   // flow 是缺省, 不写
      Object.keys(out).forEach(function(key) {
        if (out[key] == null) delete out[key];
      });
      return out;
    }

    function cleanNode(n) {
      const out = {};
      Object.keys(n).forEach(function(key) {
        if (key !== 'children') out[key] = n[key];
      });
      if (Array.isArray(n.children)) out.children = n.children.map(cleanNode);
      return out;
    }

    function cleanEdge(e) {
      const out = { id: e.id, source: e.source, target: e.target };
      if (e.label && e.label.trim()) out.label = e.label;
      // 标签沿线位置只在有标签且拖动过时写出, 重新生成时按它复位
      if (out.label && Number.isFinite(e.labelT)) out.labelT = Math.round(e.labelT * 1000) / 1000;
      if (e.style && e.style !== 'solid') out.style = e.style;
      if (e.undirected) out.undirected = true;
      else if (e.bidirectional) out.bidirectional = true;
      else if (e.reversed) out.reversed = true;
      return out;
    }

    function cleanPositions(positions) {
      const out = {};
      Object.keys(positions).forEach(function(id) {
        const p = positions[id];
        if (p && typeof p.x === 'number' && typeof p.y === 'number') {
          out[id] = { x: roundPos(p.x), y: roundPos(p.y) };
          if (typeof p.w === 'number' && typeof p.h === 'number') { out[id].w = p.w; out[id].h = p.h; }
        }
      });
      return out;
    }

    function downloadJson() {
      const blob = new Blob([JSON.stringify(serialize(), null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'diagram-edited.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
    }


    // --- 快捷键 ---

    // =========== Phase 2: 质量检查 / 多格式导出 / JSON 编辑 / 皮肤 ===========
    let appliedSkinId = null;
    // 导出主题里的结构 token 也要带上整图缩放, 否则 SVG/PPTX 的图标与内边距跟页面对不上
    function exportThemeFor(skin, skinId) {
      const theme = skinExportTheme(skin);
      theme.metrics = runtimeMetricsFor(skinId || appliedSkinId || ACTIVE_SKIN_ID);
      return theme;
    }
    let EXPORT_THEME = exportThemeFor(SKINS[ACTIVE_SKIN_ID] || SKINS[DEFAULT_SKIN], ACTIVE_SKIN_ID);

    // 导出用主题 = 皮肤主题 × 当前外框缩放系数。结构 token、线宽、圆角都跟着缩,
    // 否则导出的 PNG/SVG/PPTX/PDF 与页面上看到的比例对不上。
    // geoScale 只含外框系数(圆角等几何量在页面上也只吃 --type-scale, 保持导出与页面一致);
    // edgeScale 是整图几何系数(装框 × 外框), scene-svg 用它跑与页面同一个 edgeWeight 求解器。
    function exportThemeNow() {
      const s = typeScale();
      const theme = {};
      Object.keys(EXPORT_THEME).forEach(function(k) { theme[k] = EXPORT_THEME[k]; });
      if (s !== 1) theme.metrics = scaleMetricsRuntime(EXPORT_THEME.metrics, s);
      theme.geoScale = s;
      theme.edgeScale = GEO_FIT * s;
      return theme;
    }

    function currentSkin() {
      return SKINS[appliedSkinId] || SKINS[ACTIVE_SKIN_ID] || SKINS[DEFAULT_SKIN];
    }
    function toneIconColor(hex, tone) {
      const s = String(hex || '');
      const raw = s.charAt(0) === '#' ? s.slice(1) : s;
      const fallback = tone === 'dark' ? '#e8ecf2' : '#3f4754';
      if (raw.length !== 6) return s || fallback;
      const v = parseInt(raw, 16);
      if (isNaN(v)) return fallback;
      const r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
      const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      if (tone === 'dark') return lum < 0.18 ? '#e8ecf2' : '#' + raw;
      return lum > 0.85 ? '#5f6b7a' : '#' + raw;
    }
    function brightIconColor(hex) {
      return toneIconColor(hex, currentSkin().tone);
    }

    // ---------- 皮肤切换 ----------
    let skinMenuEl = null, skinMenuOpen = false;
    let skinLegacyEl = null, skinMoreEl = null, skinLegacyOpen = false;
    function syncSkinFromModel() {
      const id = model.skin && SKINS[model.skin] ? model.skin : ACTIVE_SKIN_ID;
      if (id === appliedSkinId) return;
      appliedSkinId = id;
      const skin = SKINS[id];
      const map = skinCssVarMap(skin, runtimeMetricsFor(id));
      Object.keys(map).forEach(function(k) { document.documentElement.style.setProperty(k, map[k]); });
      EXPORT_THEME = exportThemeFor(skin, id);
      refreshIconFills(skin);
      syncSkinExtraCss(skin);
      syncSkinMetrics(skin);
      applyEdgeWeights(typeScale());   // 皮肤基准线宽变了要重算线宽与端点(结构 token 可能没变, 不能靠 syncSkinMetrics)
      if (skinMenuEl) markSkinMenuActive();
    }
    // 第二层自由 CSS: 换肤时整块替换 <style id="skin-extra">。
    // 与构建期同一个 sanitizeSkinCss, 因此页面内换肤和重新构建的结果一致。
    function syncSkinExtraCss(skin) {
      const el = document.getElementById('skin-extra');
      if (!el) return;
      const result = sanitizeSkinCss(skin.extraCss);
      el.textContent = result.css;
      const lines = describeSkinCssIssues(result.issues);
      for (let i = 0; i < lines.length; i++) console.warn('皮肤 "' + skin.nameEn + '" ' + lines[i]);
    }
    // 皮肤的结构 token 变了 → 容器内边距、字号基准、文字装箱口径全部跟着换,
    // 然后重算容器包围盒与连线(节点坐标不动, 用户的手动摆位保持不变)。
    function syncSkinMetrics(skin) {
      const next = runtimeMetricsFor(appliedSkinId || ACTIVE_SKIN_ID);
      let changed = false;
      Object.keys(next).forEach(function(k) { if (next[k] !== METRICS[k]) changed = true; });
      if (!changed) return;
      METRICS = next;
      LAY = skinLayout(METRICS);
      PAD = LAY.panelPad;
      TYPE_BASE = { node: METRICS.typeNode, sub: METRICS.typeSmall, edgeLabel: TYPE_BASE.edgeLabel };
      // 编组标题的形态是枚举, 只能靠属性选择器切; CSS 变量管不了 left/right/writing-mode 这一组
      stage.dataset.labelMode = METRICS.panelLabelMode;
      stage.dataset.labelAlign = METRICS.panelLabelAlign;
      syncContainers();   // 内部会调 applyTypeScale
      rerouteAll();
      renderEdges();
    }
    function refreshIconFills(skin) {
      canvas.querySelectorAll('.node-icon:not(.generic)').forEach(function(span) {
        const asset = ICON_ASSETS[span.dataset.icon];
        if (!asset || !asset.color) return;
        const p = span.querySelector('path');
        if (p) p.setAttribute('fill', toneIconColor(asset.color, skin.tone));
      });
    }
    function setSkin(id) {
      if (!SKINS[id]) return;
      const prev = model.skin && SKINS[model.skin] ? model.skin : ACTIVE_SKIN_ID;
      if (id === prev) { closeSkinMenu(); return; }
      model.skin = id;
      syncSkinFromModel();
      closeSkinMenu();
      showToast('已切换皮肤: ' + SKINS[id].nameZh + ' ' + SKINS[id].nameEn, 1600);
    }
    function skinMenuItem(id) {
      const skin = SKINS[id];
      const b = document.createElement('button');
      b.className = 'export-item';
      b.dataset.skin = id;
      const swatch = '<span class="skin-swatch" style="background:' + skin.tokens.bg + '"><span style="background:' + skin.tokens.accent + '"></span></span>';
      b.innerHTML = swatch + skin.nameZh + ' ' + skin.nameEn + '<span class="hint">' + skin.usage + '</span>';
      b.onclick = function(ev) { ev.stopPropagation(); setSkin(id); };
      return b;
    }
    // 主打 4 套直出, 早期 10 套收进 .skin-legacy, 由 .skin-more 二次点击展开。
    function ensureSkinMenu() {
      if (skinMenuEl) return skinMenuEl;
      const anchor = btnSkin.parentElement;
      skinMenuEl = document.createElement('div');
      skinMenuEl.className = 'export-menu skin-menu';
      skinMenuEl.style.display = 'none';
      FEATURED_SKIN_IDS.forEach(function(id) { skinMenuEl.appendChild(skinMenuItem(id)); });
      skinMoreEl = document.createElement('button');
      skinMoreEl.className = 'export-item skin-more';
      skinMoreEl.setAttribute('aria-expanded', 'false');
      skinMoreEl.onclick = function(ev) { ev.stopPropagation(); setSkinLegacyOpen(!skinLegacyOpen); };
      skinMenuEl.appendChild(skinMoreEl);
      skinLegacyEl = document.createElement('div');
      skinLegacyEl.className = 'skin-legacy';
      LEGACY_SKIN_IDS.forEach(function(id) { skinLegacyEl.appendChild(skinMenuItem(id)); });
      skinMenuEl.appendChild(skinLegacyEl);
      setSkinLegacyOpen(false);
      anchor.appendChild(skinMenuEl);
      markSkinMenuActive();
      return skinMenuEl;
    }
    function setSkinLegacyOpen(open) {
      skinLegacyOpen = !!open;
      if (skinLegacyEl) skinLegacyEl.classList.toggle('open', skinLegacyOpen);
      renderSkinMore();
    }
    // 折叠只由这个按钮控制, 不自动展开（默认皮肤 midnight 就在折叠组里, 自动展开等于没折叠）。
    // 代价是收起时看不到选中项, 所以把当前皮肤名写在按钮上。
    function renderSkinMore() {
      if (!skinMoreEl) return;
      const active = model.skin && SKINS[model.skin] ? model.skin : ACTIVE_SKIN_ID;
      const inside = LEGACY_SKIN_IDS.indexOf(active) >= 0;
      skinMoreEl.setAttribute('aria-expanded', String(skinLegacyOpen));
      skinMoreEl.classList.toggle('has-active', !skinLegacyOpen && inside);
      skinMoreEl.innerHTML = '更多皮肤 · ' + LEGACY_SKIN_IDS.length + ' 套<span class="hint">'
        + (skinLegacyOpen ? '收起 ▴' : (inside ? '当前 · ' + SKINS[active].nameZh + ' ▾' : '展开 ▾')) + '</span>';
    }
    function markSkinMenuActive() {
      if (!skinMenuEl) return;
      const active = model.skin && SKINS[model.skin] ? model.skin : ACTIVE_SKIN_ID;
      skinMenuEl.querySelectorAll('.export-item[data-skin]').forEach(function(b) {
        b.classList.toggle('active', b.dataset.skin === active);
      });
      renderSkinMore();
    }
    function toggleSkinMenu() { if (skinMenuOpen) closeSkinMenu(); else openSkinMenu(); }
    function openSkinMenu() {
      closeExportMenu();
      ensureSkinMenu().style.display = 'block';
      markSkinMenuActive();
      skinMenuOpen = true;
      btnSkin.classList.add('active');
    }
    function closeSkinMenu() {
      if (skinMenuEl) skinMenuEl.style.display = 'none';
      skinMenuOpen = false;
      btnSkin.classList.remove('active');
    }

    function makeIconSpan(def) {
      const asset = def && def.icon && typeof def.icon === 'string' ? ICON_ASSETS[def.icon] : null;
      if (!asset) return null;
      const span = document.createElement('span');
      span.className = 'node-icon' + (asset.type === 'generic' ? ' generic' : '');
      span.dataset.icon = def.icon;
      if (asset.type === 'tech') {
        span.innerHTML = '<svg viewBox="' + asset.viewBox + '"><path d="' + asset.path + '" fill="' + brightIconColor(asset.color) + '"/></svg>';
      } else {
        span.innerHTML = '<svg viewBox="' + asset.viewBox + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + asset.svg + '</svg>';
      }
      return span;
    }

    function stageRelativeRect(el) {
      const sb = stage.getBoundingClientRect();
      const rb = el.getBoundingClientRect();
      const scale = sb.width / 1920 || 1;
      return { x: (rb.left - sb.left) / scale, y: (rb.top - sb.top) / scale, w: rb.width / scale, h: rb.height / scale };
    }

    function buildSceneRuntime() {
      const layoutSpec = SLIDE_LAYOUTS[model.layout] || SLIDE_LAYOUTS.B;
      const scene = {
        canvas: { w: DW, h: DH },
        frame: model.frame ? clone(model.frame) : clone(layoutSpec.frame),
        nodes: [], containers: [], edges: []
      };
      const h1 = document.querySelector('.title-block h1');
      const subEl = document.querySelector('.title-block p');
      if (h1 && model.title) { const r = stageRelativeRect(h1); scene.title = { text: model.title, x: r.x, y: r.y, w: r.w, h: r.h }; }
      if (subEl && model.subtitle) { const r2 = stageRelativeRect(subEl); scene.subtitle = { text: model.subtitle, x: r2.x, y: r2.y, w: r2.w, h: r2.h }; }
      nodes.forEach(function(n, id) {
        const def = nodeDefs.get(id) || {};
        const asset = def.icon && typeof def.icon === 'string' ? ICON_ASSETS[def.icon] : null;
        scene.nodes.push({
          id: id, label: def.label || '', sublabel: def.sublabel,
          x: n.x, y: n.y, w: n.w, h: n.h,
          // 自适应后的实际字号: 质检与导出都按它算, 保证屏幕 / 质检 / 导出三处一致
          labelPx: n.labelPx, subPx: n.subPx,
          // 阶梯自适应解出的实际内边距/间距/图标尺寸与折行结论。导出按它排版,
          // 质检按 fit.overflow 直接采信(不必再用估算宽度重新推一遍折行)
          padX: n.fit ? n.fit.padX : undefined,
          padY: n.fit ? n.fit.padY : undefined,
          labelGap: n.fit ? n.fit.gap : undefined,
          iconPx: n.fit && n.fit.iconSize ? n.fit.iconSize : undefined,
          iconGapPx: n.fit && n.fit.iconSize ? n.fit.iconGap : undefined,
          fit: n.fit ? { lines: n.fit.lines, subLines: n.fit.subLines, tier: n.fit.tier,
            overflow: n.fit.overflow, dropSub: n.fit.dropSub } : undefined,
          variant: def.variant || 'default',
          icon: asset ? { slug: def.icon, type: asset.type,
            color: asset.color ? brightIconColor(asset.color) : undefined,
            path: asset.path, svg: asset.svg, viewBox: asset.viewBox,
            position: def.iconPosition === 'top' ? 'top' : 'left' } : undefined
        });
      });
      panels.forEach(function(p, id) {
        const def = nodeDefs.get(id) || {};
        scene.containers.push({ id: id, label: def.label || '', x: p.x, y: p.y, w: p.w, h: p.h,
          labelPx: p.labelPx, depth: containerDepth(id) });
      });
      edgeState.forEach(function(e) {
        const me = model.edges.find(function(m) { return m.id === e.id; }) || {};
        const entry = { id: e.id, source: e.source, target: e.target,
          pts: (e.pts || []).map(function(p) { return { x: p.x, y: p.y }; }),
          style: me.style || 'solid', undirected: !!me.undirected,
          bidirectional: !me.undirected && !!me.bidirectional,
          reversed: !me.undirected && !me.bidirectional && !!me.reversed };
        if (e.labelEl && me.label) {
          const lw = e.labelEl.offsetWidth || 60;
          const lh = e.labelEl.offsetHeight || 27;
          const lx = parseFloat(e.labelEl.style.left) || 0;
          const ly = parseFloat(e.labelEl.style.top) || 0;
          entry.label = { text: me.label, x: lx - lw / 2, y: ly - lh / 2, w: lw, h: lh,
            px: Math.round(TYPE_BASE.edgeLabel * typeScale() * 10) / 10 };
        }
        scene.edges.push(entry);
      });
      return scene;
    }

    // 质检阈值里的"距离"随外框一起缩: 外框缩小后整张图的间距同比变小,
    // 若阈值仍按原始像素判定, 会刷出一片"间距不足 / 距容器边太近"的假问题。
    function qualityOptionsNow() {
      const s = typeScale();
      const opts = skinQualityOptions(RMETRICS);
      // 阈值基准只有一份: 内联进来的 quality-checker 的 QUALITY_RULES。
      // 这里曾经写死 12 / 24, 与 lib/arch-doc.mjs 的 qualityOptionsOf 各持一份 ——
      // 下限从 24 改到 20 时, 产物运行时会静默留在 24。改成引用, 口径分叉就不可能发生。
      opts.containerMargin = QUALITY_RULES.containerMargin * s;
      opts.minSpacing = QUALITY_RULES.minSpacing * s;
      // 箭头实体尺寸与页面实际画出的箭头同一份几何(GEO_FIT × 运行时外框系数)
      const ewBase = Number(((SKINS[model.skin] || SKINS[ACTIVE_SKIN_ID] || {}).tokens || {}).ew) || 2;
      const ewNowQc = edgeWeight(ewBase, GEO_FIT * s);
      opts.arrowClearPx = ewNowQc.headLen;
      opts.arrowHalfPx = ewNowQc.headHalf;
      return opts;
    }

    // ---------- 质量检查 UI ----------
    let qualityPanelEl = null, qualityOpen = false, qualityTimer = null, lastReport = null;
    const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];
    const SEVERITY_LABEL = { critical: '严重', high: '较高', medium: '中等', low: '轻微' };

    function computeQualityReportNow() {
      try { lastReport = checkQuality(buildSceneRuntime(), qualityOptionsNow()); }
      catch (err) { console.warn('质量检查失败', err); lastReport = null; }
      updateQualityBadge();
      if (qualityOpen) { renderQualityPanel(); applyQualityFlags(); }
      return lastReport;
    }
    function scheduleQualityRefresh() {
      if (qualityTimer) clearTimeout(qualityTimer);
      qualityTimer = setTimeout(computeQualityReportNow, 500);
    }
    function updateQualityBadge() {
      if (!btnQuality) return;
      const n = lastReport ? lastReport.totalIssues : 0;
      btnQuality.innerHTML = n > 0 ? '质量检查<span class="badge">' + n + '</span>' : '质量检查';
    }
    function toggleQualityPanel() {
      qualityOpen = !qualityOpen;
      btnQuality.classList.toggle('active', qualityOpen);
      if (qualityOpen) { computeQualityReportNow(); }
      else { if (qualityPanelEl) qualityPanelEl.style.display = 'none'; clearQualityFlags(); }
    }
    function ensureQualityPanel() {
      if (!qualityPanelEl) {
        qualityPanelEl = document.createElement('div');
        qualityPanelEl.className = 'quality-panel';
        stage.appendChild(qualityPanelEl);
      }
      return qualityPanelEl;
    }
    function clearQualityFlags() {
      canvas.querySelectorAll('.q-flag').forEach(function(el) { el.classList.remove('q-flag'); });
    }
    function applyQualityFlags() {
      clearQualityFlags();
      if (!lastReport) return;
      lastReport.issues.forEach(function(issue) {
        (issue.affectedElements || []).forEach(function(id) {
          const target = nodes.get(id) || panels.get(id);
          if (target) target.el.classList.add('q-flag');
        });
      });
    }
    function renderQualityPanel() {
      const panel = ensureQualityPanel();
      panel.style.display = 'flex';
      panel.innerHTML = '';
      const head = document.createElement('div');
      head.className = 'quality-head';
      head.appendChild(document.createTextNode('质量检查报告'));
      const score = document.createElement('span');
      score.className = 'quality-score';
      score.textContent = lastReport ? lastReport.score + ' 分' : '—';
      head.appendChild(score);
      const closeBtn = document.createElement('button');
      closeBtn.className = 'quality-close';
      closeBtn.textContent = '✕';
      closeBtn.onclick = toggleQualityPanel;
      head.appendChild(closeBtn);
      panel.appendChild(head);
      const list = document.createElement('div');
      list.className = 'quality-list';
      const issues = lastReport ? lastReport.issues : [];
      if (!issues.length) {
        const empty = document.createElement('div');
        empty.className = 'quality-empty';
        empty.textContent = '未发现质量问题，图面很干净 ✓';
        list.appendChild(empty);
      } else {
        SEVERITY_ORDER.forEach(function(sev) {
          const group = issues.filter(function(it) { return it.severity === sev; });
          if (!group.length) return;
          const groupHead = document.createElement('div');
          groupHead.className = 'quality-group';
          groupHead.textContent = SEVERITY_LABEL[sev] + ' (' + group.length + ')';
          list.appendChild(groupHead);
          group.forEach(function(issue) {
            const item = document.createElement('div');
            item.className = 'quality-item';
            const dot = document.createElement('span');
            dot.className = 'quality-dot ' + sev;
            item.appendChild(dot);
            const text = document.createElement('span');
            text.textContent = issue.description + (issue.suggestion ? '。建议: ' + issue.suggestion : '');
            item.appendChild(text);
            if (issue.autoFixable) {
              const tag = document.createElement('span');
              tag.className = 'quality-fix-tag';
              tag.textContent = '可修复';
              item.appendChild(tag);
            }
            item.onclick = function() { focusIssue(issue); };
            list.appendChild(item);
          });
        });
      }
      panel.appendChild(list);
      const actions = document.createElement('div');
      actions.className = 'quality-actions';
      // 只读产物不提供自动修复(它要改坐标), 改到工作台里做
      const rerun = document.createElement('button');
      rerun.textContent = '重新检查';
      rerun.onclick = function() { computeQualityReportNow(); };
      actions.appendChild(rerun);
      panel.appendChild(actions);
    }
    function focusIssue(issue) {
      const ids = issue.affectedElements || [];
      let selected = false;
      ids.forEach(function(id) {
        if (edgeState.has(id)) flashEdge(id);
        if (!selected && (nodes.has(id) || panels.has(id))) { selectOnly(id); selected = true; }
      });
    }

    // 只读产物只保留 Esc: 关菜单 / 退出演示
    document.addEventListener('keydown', function(ev) {
      if (ev.key !== 'Escape') return;
      if (exportMenuOpen) { closeExportMenu(); ev.preventDefault(); return; }
      if (skinMenuOpen) { closeSkinMenu(); ev.preventDefault(); return; }
      if (document.body.classList.contains('presenting')) {
        document.body.classList.remove('presenting');
        btnPresent.classList.remove('active');
        btnPresent.textContent = '演示';
        ev.preventDefault();
      }
    });

    // ---------- 导出 ----------
    let exportMenuEl = null, exportMenuOpen = false, exportScale = 2, toastEl = null, toastTimer = null;
    function showToast(msg, ms) {
      if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'toast'; stage.appendChild(toastEl); }
      toastEl.textContent = msg;
      toastEl.style.display = 'block';
      if (toastTimer) clearTimeout(toastTimer);
      if (ms) toastTimer = setTimeout(function() { toastEl.style.display = 'none'; }, ms);
    }
    function exportFileBase() {
      const bad = '\\\\/:*?"<>|';
      const raw = String(model.title || 'architecture-diagram');
      let out = '';
      for (let i = 0; i < raw.length; i++) {
        const ch = raw.charAt(i);
        out += bad.indexOf(ch) >= 0 || ch === ' ' ? '-' : ch;
      }
      return out.slice(0, 60) || 'architecture-diagram';
    }
    function downloadBlobFile(blob, filename) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function() { URL.revokeObjectURL(url); }, 1500);
    }
    function preExportNotice() {
      const report = lastReport || computeQualityReportNow();
      if (report && report.totalIssues > 0) showToast('注意: 当前有 ' + report.totalIssues + ' 个质量问题, 已继续导出…');
    }
    function currentSvgString() {
      return sceneToSvg(buildSceneRuntime(), exportThemeNow());
    }
    function svgToCanvasEl(svgString, scale, cb) {
      const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = function() {
        try {
          const c = document.createElement('canvas');
          c.width = Math.round(DW * scale);
          c.height = Math.round(DH * scale);
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0, c.width, c.height);
          URL.revokeObjectURL(url);
          cb(null, c);
        } catch (err) { URL.revokeObjectURL(url); cb(err); }
      };
      img.onerror = function() { URL.revokeObjectURL(url); cb(new Error('SVG 光栅化失败')); };
      img.src = url;
    }
    function exportRaster(format, scale, quality, done) {
      preExportNotice();
      showToast('正在渲染 ' + format.toUpperCase() + ' (' + scale + 'x)…');
      let svgStr;
      try { svgStr = currentSvgString(); }
      catch (err) { showToast('导出失败: ' + err.message, 2600); return; }
      svgToCanvasEl(svgStr, scale, function(err, canvasEl) {
        if (err) { showToast('导出失败: ' + err.message, 2600); return; }
        const MIME_BY_FORMAT = { jpeg: 'image/jpeg', webp: 'image/webp', png: 'image/png' };
        const mime = MIME_BY_FORMAT[format] || MIME_BY_FORMAT.png;
        canvasEl.toBlob(function(blob) {
          if (!blob) { showToast('导出失败: 浏览器不支持 ' + format, 2600); return; }
          if (done) { done(blob, canvasEl); return; }
          downloadBlobFile(blob, exportFileBase() + '.' + (format === 'jpeg' ? 'jpg' : format));
          showToast('已导出 ' + format.toUpperCase(), 1800);
        }, mime, quality);
      });
    }
    function exportPNG(scale) { exportRaster('png', scale || exportScale); }
    function exportJPEG(scale) { exportRaster('jpeg', scale || exportScale, 0.92); }
    function exportWebP(scale) { exportRaster('webp', scale || exportScale, 0.92); }
    function exportSVGFile() {
      preExportNotice();
      try {
        const svgStr = currentSvgString();
        downloadBlobFile(new Blob([svgStr], { type: 'image/svg+xml' }), exportFileBase() + '.svg');
        showToast('已导出 SVG', 1800);
      } catch (err) { showToast('导出失败: ' + err.message, 2600); }
    }
    function exportPDFFile() {
      exportRaster('jpeg', 2, 0.92, function(blob, canvasEl) {
        blob.arrayBuffer().then(function(buf) {
          const pdfBytes = buildJpegPdf({ pageW: 960, pageH: 540, jpeg: new Uint8Array(buf), imgW: canvasEl.width, imgH: canvasEl.height });
          downloadBlobFile(new Blob([pdfBytes], { type: 'application/pdf' }), exportFileBase() + '.pdf');
          showToast('已导出 PDF', 1800);
        }).catch(function(err) { showToast('PDF 导出失败: ' + err.message, 2600); });
      });
    }
    const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    // 原生 PPTX: 每张卡、每条线、每段文字都是 PowerPoint 里能选中能改的真形状。
    // 几何与配色跟 sceneToSvg 同源(scene-pptx 直接 import 它的求解函数), 所以
    // 导出件和页面是同一张图, 不是截图。
    function exportPPTXFile() {
      try {
        const scene = buildSceneRuntime();
        const dropped = [];
        const pack = sceneToPptx(scene, exportThemeNow(), { onDrop: function(n) { dropped.push(n); } });
        const bytes = buildPptx({ title: model.title || 'Architecture Diagram', slideXml: pack.slideXml, background: pack.background });
        downloadBlobFile(new Blob([bytes], { type: PPTX_MIME }), exportFileBase() + '.pptx');
        showToast(dropped.length ? ('已导出 PPTX(' + dropped.length + ' 个元素画不出, 已跳过)') : '已导出 PPTX', dropped.length ? 3000 : 1800);
      } catch (err) { showToast('PPTX 导出失败: ' + err.message, 2600); }
    }
    // 兜底: 整页位图铺满一张 slide。原生形状在个别老版本 Office 里出问题时用它。
    function exportPPTXImageFile() {
      exportRaster('png', 2, undefined, function(blob, canvasEl) {
        blob.arrayBuffer().then(function(buf) {
          const bytes = buildPptx({ title: model.title || 'Architecture Diagram', png: new Uint8Array(buf), pngW: canvasEl.width, pngH: canvasEl.height });
          downloadBlobFile(new Blob([bytes], { type: PPTX_MIME }), exportFileBase() + '-image.pptx');
          showToast('已导出 PPTX(整页图片)', 1800);
        }).catch(function(err) { showToast('PPTX 导出失败: ' + err.message, 2600); });
      });
    }
    // 分享出去的副本：只读 + 打开即演示。只看 <body> 标签本身 —— 运行时脚本里也写着这两个属性名,
    // 拿整份 HTML 做 indexOf 永远找得到, 副本就永远进不了演示态
    function viewerBootHtml(html) {
      return html.replace(/<body([^>]*)>/, function(tag, attrs) {
        if (attrs.indexOf('data-readonly') < 0) attrs += ' data-readonly="1"';
        if (attrs.indexOf('data-present-on-load') < 0) attrs += ' data-present-on-load="1"';
        return '<body' + attrs + '>';
      });
    }
    function exportInteractiveHtml() {
      try {
        const json = JSON.stringify(serialize()).split('</').join('<\\\\/');
        const marker = 'id="diagram-model">';
        const start = BOOT_HTML.indexOf(marker);
        const end = BOOT_HTML.indexOf('</' + 'script>', start);
        if (start < 0 || end < 0) { showToast('导出失败: 未找到数据块', 2600); return; }
        const html = viewerBootHtml(BOOT_HTML.slice(0, start + marker.length) + json + BOOT_HTML.slice(end));
        downloadBlobFile(new Blob(['<!DOCTYPE html>' + '\\n' + html], { type: 'text/html' }), exportFileBase() + '-viewer.html');
        showToast('已导出交互式 HTML(只读)', 2000);
      } catch (err) { showToast('导出失败: ' + err.message, 2600); }
    }
    function ensureExportMenu() {
      if (exportMenuEl) return exportMenuEl;
      const anchor = btnExport.parentElement;
      exportMenuEl = document.createElement('div');
      exportMenuEl.className = 'export-menu';
      exportMenuEl.style.display = 'none';
      const items = [
        { label: 'PNG 图片', hint: '文档/博客', fn: function() { exportPNG(); } },
        { label: 'SVG 矢量图', hint: '无限缩放', fn: exportSVGFile },
        { label: 'PDF 文档', hint: '打印/分享', fn: exportPDFFile },
        { label: 'PowerPoint (PPTX)', hint: '可编辑形状', fn: exportPPTXFile },
        { label: 'PPTX(整页图片)', hint: '兜底', fn: exportPPTXImageFile },
        { label: 'JPEG 图片', hint: '压缩体积', fn: function() { exportJPEG(); } },
        { label: 'WebP 图片', hint: '现代浏览器', fn: function() { exportWebP(); } },
        { label: '交互式 HTML', hint: '只读分享', fn: exportInteractiveHtml },
        { label: 'JSON 数据', hint: '再次生成', fn: downloadJson }
      ];
      items.forEach(function(it) {
        const b = document.createElement('button');
        b.className = 'export-item';
        b.innerHTML = it.label + '<span class="hint">' + it.hint + '</span>';
        b.onclick = function(ev) { ev.stopPropagation(); closeExportMenu(); it.fn(); };
        exportMenuEl.appendChild(b);
      });
      const sep = document.createElement('div');
      sep.className = 'export-sep';
      exportMenuEl.appendChild(sep);
      const scaleRow = document.createElement('div');
      scaleRow.className = 'export-scale';
      scaleRow.appendChild(document.createTextNode('位图分辨率'));
      [1, 2, 4].forEach(function(s) {
        const b = document.createElement('button');
        b.textContent = s + 'x';
        b.classList.toggle('active', s === exportScale);
        b.onclick = function(ev) {
          ev.stopPropagation();
          exportScale = s;
          scaleRow.querySelectorAll('button').forEach(function(x) { x.classList.toggle('active', x === b); });
        };
        scaleRow.appendChild(b);
      });
      exportMenuEl.appendChild(scaleRow);
      anchor.appendChild(exportMenuEl);
      return exportMenuEl;
    }
    function toggleExportMenu() { if (exportMenuOpen) closeExportMenu(); else openExportMenu(); }
    function openExportMenu() {
      closeSkinMenu();
      ensureExportMenu().style.display = 'block';
      exportMenuOpen = true;
      btnExport.classList.add('active');
    }
    function closeExportMenu() {
      if (exportMenuEl) exportMenuEl.style.display = 'none';
      exportMenuOpen = false;
      btnExport.classList.remove('active');
    }
    document.addEventListener('click', function(ev) {
      const inAnchor = ev.target.closest && ev.target.closest('.menu-anchor');
      if (exportMenuOpen && !inAnchor) closeExportMenu();
      if (skinMenuOpen && !inAnchor) closeSkinMenu();
    });

    // ---------- JSON 编辑器 ----------

    syncAllFromModel();

    // 只读只是禁编辑, 不代表一进来就进演示态; 演示由用户点, 或由「交互式 HTML」导出显式指定
    if (document.body.hasAttribute('data-present-on-load')) {
      document.body.classList.add('presenting');
      btnPresent.classList.add('active');
      btnPresent.textContent = '退出演示';
    }
    // 只读产物的脚本接口: 查看 / 版式 / 皮肤 / 质检 / 导出, 不含任何编辑方法
    window.archDiagram = {
      serialize: serialize,
      buildScene: buildSceneRuntime,
      setLayout: switchLayout,
      getLayout: function() { return model.layout; },
      setSkin: setSkin,
      getSkin: function() { return model.skin || ACTIVE_SKIN_ID; },
      listSkins: function() { return Object.keys(SKINS); },
      checkQuality: function() { const r = computeQualityReportNow(); return r ? r.score : null; },
      getQualityReport: function() { return computeQualityReportNow(); },
      toSvgString: function() { return sceneToSvg(buildSceneRuntime(), skinExportTheme(SKINS[model.skin] || SKINS[ACTIVE_SKIN_ID])); },
      exportPNG: exportPNG,
      exportSVG: exportSVGFile,
      exportPDF: exportPDFFile,
      exportPPTX: exportPPTXFile,
      exportPPTXImage: exportPPTXImageFile,
      exportJPEG: exportJPEG,
      exportWebP: exportWebP,
      exportJSON: downloadJson,
      exportInteractiveHTML: exportInteractiveHtml
    };

    setTimeout(computeQualityReportNow, 150); // PRD §2.6: 生成完成后自动执行一次
  })();
  </script>
</body>
</html>
`;

writeFileSync(outputPath, html);

// 输出的几何数字一律用产物的最终像素坐标(1920×1080 幻灯坐标系)。
// 布局阶段的抽象网格坐标只用于排版, 不再对外展示, 避免与页面实测值对不上。
const finalRects = [...cardRect.values(), ...containerRect.values()];
const finalX1 = Math.min(...finalRects.map((r) => r.x));
const finalY1 = Math.min(...finalRects.map((r) => r.y));
const finalX2 = Math.max(...finalRects.map((r) => r.x + r.w));
const finalY2 = Math.max(...finalRects.map((r) => r.y + r.h));
const sampleCard = [...cardRect.values()][0];
console.log(`OK -> ${outputPath}  节点 ${cardRect.size} / 容器 ${containerRect.size}, 图面 ${Math.round(finalX2 - finalX1)}x${Math.round(finalY2 - finalY1)}, 卡片 ${Math.round(sampleCard.w)}x${Math.round(sampleCard.h)}, 连线 ${edgesOut.length} (单位: 1920x1080 幻灯像素)`);

if (cliFlags.strict && (bySev.critical > 0 || bySev.high > 0)) {
  console.error(`--strict: 存在 ${bySev.critical} 个 critical 与 ${bySev.high} 个 high 级质量问题, 判定为不通过。产物已写出, 退出码 1。`);
  process.exit(1);
}
