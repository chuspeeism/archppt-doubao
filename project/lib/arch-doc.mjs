// 架构图文档模型：spec 是唯一格式（与 generate.mjs、Skill、校验器、Mermaid 转换共用）。
// 纯函数、无 DOM 依赖；工作台在浏览器里内联使用，Node 侧由 tests 直接 import。
//
// spec = {
//   title, subtitle, layout: 'A'|'B'|'C', skin, direction, icons,
//   mode: 'flow' | 'layered',       // 排版模式：流程图（缺省）/ 分层图，见 layoutLayered
//   nodes: [ { id, label, sublabel, variant, icon, iconPosition, side?, children? } ],   // 嵌套树，容器带 children
//                                    // side: 'left'|'right' 只在 layered 下对顶层容器生效 —— 贯穿全高的竖向「体系」列
//   edges: [ { id, source, target, label, style, bidirectional, reversed, undirected, labelT,
//              sourcePort, targetPort, segShifts } ],  // 后三个是手调走线，见 setEdgePort / setEdgeSegShift
//                                    // undirected: 两头都不画箭头（关联线），优先级高于 bidirectional / reversed
//   frame: { x, y, w, h },
//   positions: { [leafId]: { x, y, w, h } }
// }
//
// 容器不写坐标：包围盒由子项递归推出（containerRect）。

import { SLIDE_WIDTH, SLIDE_HEIGHT, normalizeLayoutId, getSlideLayout, getDefaultFrame } from './slide-layouts.mjs';
import { SKINS, DEFAULT_SKIN, skinMetrics, skinLayout, skinCardWidth, skinCardHeight, skinExportTheme, skinCssVarMap, scaleMetrics, skinQualityOptions, skinPanelLabelRect, METRICS_DEFAULTS } from './skins.mjs';
import { estimateTextWidth, checkQuality, QUALITY_RULES, edgesBundled, segmentOnSharedTrunk } from './quality-checker.mjs';
import { aabbIntersects, segmentIntersectsRect, segmentsIntersect, rectContains } from './geometry-utils.mjs';
import { routeEdges, ROUTER_DEFAULTS, isEdgePort, snapEdgePort, edgePortAnchors, edgePortPoint } from './edge-router.mjs';
import { edgeWeight } from './edge-weight.mjs';
import { nodeFitStyle, solveNodeFit, makeEstimateMeasurer } from './node-fit.mjs';
import { matchIcon, iconSlugExists } from './icons/icon-matcher.mjs';
import { measureLayout, scoreLayout, vetoedByPrecision } from './layout-metrics.mjs';
import { LAYOUT_WEIGHTS } from './layout-weights.mjs';
import { TECH_ICONS } from './icons/tech-icons.mjs';
import { GENERIC_ICONS } from './icons/generic-icons.mjs';

export const CANVAS = { w: SLIDE_WIDTH, h: SLIDE_HEIGHT };
export const FRAME_MIN = { w: 300, h: 200 };
export const NODE_MIN = { w: 120, h: 56 };

// 跨编组的缝相对编组内部缝的倍率（准则 4，判别力 7:1）。1.0 等于关掉这条规则。
//
// 取值是扫出来的。1.0 / 1.3 / 1.6 / 2.2 / 3.0 各跑一遍十用例 + bench：
//
//   倍率   十用例均分  最低  实测分组间距比   墨水   完整度  走线总长
//   1.0      97.6      95      0.956       0.224  0.665   4494
//   1.3      98.0      95      1.012       0.224  0.661   4494   ← 取它
//   1.6      98.0      95      1.062       0.224  0.660   4497
//   2.2      96.8      88      1.130       0.224  0.658   4502   ← 跌破 95
//   3.0      96.4      84      1.201       0.224  0.656   4509   ← 跌破 95
//
// 2.2 起十用例就有一份跌破 95，硬验收不允许。1.3 与 1.6 各项几乎无差别，
// 版面分把 1.3 排在 1.6 前面（0.500 对 0.482），取 1.3。
//
// **实测倍率远达不到名义倍率**：名义 1.3，实测分组间距比只从 0.956 到 1.012。
// 原因是组内缝早就贴在硬下限上了（LABEL_GAP_X 要塞得下横穿的边标签，
// BAND_GAP_Y 要塞得下相邻两行容器的内边距），预算中性能匀出来的余量非常有限。
// 人工终稿是 2.231 —— 他们不是靠挤组内缝，是靠把容器本身做大（横条、容器内竖排）
// 腾出结构性的余量。那两件事分别是第 4、5 步，这条倍率要等它们之后才谈得上再抬。
export const GROUP_GAP_SCALE = 1.3;

// 已落地规则的开关，集中在一处。默认全开；消融实验（B 方案）按需逐条关掉。
// 开关本身也是文档 —— 看一眼就知道引擎现在到底装了几条规则。
// 注意：这是**可变对象**，脚本会改它；引擎侧每次都现读，不要缓存。
export const LAYOUT_RULES = {
  groupGap: true,        // 第 3 步：跨编组的缝比组内宽（预算中性）
  shapeSearch: true,     // 第 4 步：容器内竖排 / 形状搜索
  // 独占一行的叶卡横向拉满（几何触发）。2026-08-18 评估过关掉它（台账 L2）：第二轮 20 号的
  // 三根几何横条他拆回单卡，但第一轮 04 / 05 / 09 的几何横条他都留着；关掉后 bench 走线 −9%、
  // 0px 对齐 94.8 → 97.2，可 round2 墨水 0.287 → 0.262（04 / 08 号卡片缩成扁片 —— 横条一直在
  // 替卡片撑版面，那是卡片填充该管的事），十用例 case-01 掉到 92。证据两边各半，**先不关**；
  // 拉不拉满交给版面分裁决（相邻直达率进裁判之后，它对每条横条都会问「值不值」）。
  spanBars: true,
  // 第 9 步：同一行的顶层容器把最后一排挪到本行底线。**默认关**（孙毅 2026-08-16 拍板）：
  // 机制与候选闸都在，但它只填得动多排的矮容器（bench 九份只有 log-05），
  // 而填充候选的 +0.1 完整度会让变体级裁判在 log-02 上换形状、走线翻倍。
  // 见 docs/step9-content-fill.md 第八节。第 15 步 R4 卡片填充默认开之后，
  // log-05 的洞已被治好；2026-08-26 移植时病仍在 log-02/04/07 等（见 docs/step9-content-fill.md 8.7）。
  elasticFill: false,
  hubBar: true,          // 第 5 步：连着 ≥3 个兄弟的聚合点独占一行（语义触发）
  sideLoadTiebreak: true, // 第 2 步：同面拥挤只作平局打破（关掉 = 回到累进重罚）
  // 第 10 步：束线（三线合一）—— 一键规整定稿后，把「同节点同面同方向的 ≥2 条 Z 形 / 直线边」
  // 收到面正中，并以**端口声明**（sourcePort / targetPort，带 auto:true）写回 spec。
  // 束线不进裁判（候选之间仍按不并线的走线比）、也不改任何手工端口，见 autoLayout 的注释。
  bundle: true,
  // 聚合点也认扇入（≥3 个来源指向它，第二轮 12 根人工条里 8 根是扇入）。第 12 步做开关时默认关
  // （扇入点摊横条会白占一行、把版面推歪：14 号 2404 → 4932），第 13 步竖条做出来之后打开 ——
  // 扇入点摊成竖条、跨行占位、来源竖排同层时拉到货架高度。round2 消融见台账第 13 步。
  hubFanIn: true,
  // 第 14 步（台账 L4）：摆位目标加「相邻直达」。爬山的代理代价里，一条叶到叶的边两端不在相邻
  // 轨道上（同行且中间没卡 / 同列且中间没卡）就罚 adjacencyProxy 格（与 Σ|Δ列| 同一单位）；
  // 爬山的动作加「容器内任意两张同尺寸叶卡对调」与「叶卡挪进容器网格里的空位」——只交换相邻
  // 兄弟够不到「把目标卡挪到源卡对面」这种手调里最常见的动作（07 号「以混合检索为中心依次
  // 排序」、09 号「调整顺序，减少弯折」）。取值 0 = 关掉这一刀。
  adjacencyProxy: 2,
  adjacencyMoves: true,
  // 第 14 步（台账 L5）：复杂度闸。图够简单时不启用 L1 / L3 / L4（横竖条 / 束线 / 相邻直达摆位），
  // 保持等大等距网格 —— 12 / 13 / 17 / 19 四份他说「别动」（13 号备注：简单图排整齐、等大小才是
  // 高优先级，极致优化线条反而不好看）。判据：跨容器边 ≥ 6 或存在 ≥3 的扇入 / 扇出（阈值从
  // 4 份「别动」vs 其余 13 份反推，样本少，在 bench 上扫过；见 layoutComplexity）。
  complexityGate: true,
  // 台账 R4 卡片填充：卡片尺寸上限（相对内容所需的目标尺寸）与单方向拉伸上限。原值 1.6 / 1.3。
  cardFillScaleMax: 2.4,
  cardFillStretch: 2.0,
  // 台账 R4 第一刀：格距下限逐道缝算（标签通道只抬带标签直连边横穿的那道、容器内边距只抬有容器
  // 开始 / 结束的那道行缝），不再拿全图最宽的那道当所有缝的下限 —— 富余先给卡片。
  seamFloors: true,
};

// 台账 L5：一张图「复杂不复杂」。跨容器的边够多、或有一个点连着三个以上的卡，才值得
// 拉条 / 束线 / 按相邻直达重摆；否则等大等距的网格就是最好的答案（四份「别动」的共同点）。
export function layoutComplexity(spec) {
  const top = new Map();
  const walk = (n, root) => { top.set(n.id, root); (n.children || []).forEach((c) => walk(c, root)); };
  (spec.nodes || []).forEach((n) => walk(n, n.id));
  const edges = (spec.edges || []).filter((e) => e.source !== e.target);
  const crossEdges = edges.filter((e) => top.get(e.source) !== top.get(e.target)).length;
  const inD = new Map();
  const outD = new Map();
  edges.forEach((e) => {
    outD.set(e.source, (outD.get(e.source) || 0) + 1);
    inD.set(e.target, (inD.get(e.target) || 0) + 1);
  });
  const maxFan = Math.max(0, ...inD.values(), ...outD.values());
  const complex = crossEdges >= COMPLEXITY_MIN_CROSS_EDGES || maxFan >= COMPLEXITY_MIN_FAN;
  return { crossEdges, maxFan, complex };
}
export const COMPLEXITY_MIN_CROSS_EDGES = 6;
export const COMPLEXITY_MIN_FAN = 3;
// 这一次规整到底开没开那三刀：闸关着 = 全开；闸开着 = 看 layoutComplexity
export function activeRules(spec) {
  const gate = LAYOUT_RULES.complexityGate ? layoutComplexity(spec).complex : true;
  return {
    hubBar: LAYOUT_RULES.hubBar && gate,
    bundle: LAYOUT_RULES.bundle && gate,
    adjacencyProxy: gate ? LAYOUT_RULES.adjacencyProxy : 0,
    adjacencyMoves: LAYOUT_RULES.adjacencyMoves && gate,
  };
}

// 与 spec-validator / generate.mjs 同一份取值
export const VARIANTS = [
  { id: 'default', label: '默认卡片', kind: 'look' },
  { id: 'accent', label: '强调', kind: 'look' },
  { id: 'store', label: '存储', kind: 'look' },
  { id: 'muted', label: '弱化', kind: 'look' },
  { id: 'decision', label: '菱形 · 判定', kind: 'shape' },
  { id: 'pill', label: '胶囊', kind: 'shape' },
  { id: 'database', label: '圆柱 · 数据库', kind: 'shape' },
  { id: 'circle', label: '圆形', kind: 'shape' },
];
export const EDGE_STYLES = [
  { id: 'solid', label: '实线' },
  { id: 'dashed', label: '虚线' },
  { id: 'bold', label: '加粗' },
];
// 方向三选一，只决定箭头画在哪一端；source / target 这对关系不受它影响
export const EDGE_DIRECTIONS = [
  { id: 'forward', label: '正向' },
  { id: 'reversed', label: '反向' },
  { id: 'both', label: '双向' },
];

const measurer = makeEstimateMeasurer();

/* ---------------- 树 ---------------- */

export function isContainer(node) {
  return !!node && Array.isArray(node.children);
}

export function walkNodes(nodes, fn, parent = null, depth = 0) {
  for (const n of nodes || []) {
    fn(n, parent, depth);
    if (isContainer(n)) walkNodes(n.children, fn, n, depth + 1);
  }
}

export function findNodeById(spec, id) {
  let hit = null;
  walkNodes(spec.nodes, (n) => { if (!hit && n.id === id) hit = n; });
  return hit;
}

export function parentOfId(spec, id) {
  let hit = null;
  walkNodes(spec.nodes, (n, parent) => { if (!hit && n.id === id) hit = parent; });
  return hit;
}

export function nodeDepth(spec, id) {
  let d = 0;
  walkNodes(spec.nodes, (n, parent, depth) => { if (n.id === id) d = depth; });
  return d;
}

export function siblingsOf(spec, id) {
  const parent = parentOfId(spec, id);
  return parent ? parent.children : spec.nodes;
}

export function leafNodes(spec) {
  const out = [];
  walkNodes(spec.nodes, (n) => { if (!isContainer(n)) out.push(n); });
  return out;
}

export function containerNodes(spec) {
  const out = [];
  walkNodes(spec.nodes, (n) => { if (isContainer(n)) out.push(n); });
  return out;
}

export function descendantLeafIds(spec, id) {
  const node = findNodeById(spec, id);
  if (!node) return [];
  if (!isContainer(node)) return [node.id];
  const out = [];
  walkNodes(node.children, (n) => { if (!isContainer(n)) out.push(n.id); });
  return out;
}

// id 在 parentId 这一层的祖先（不在这棵子树里返回 null）——排版时把跨层连线投影到同一层比较
export function projectToLevel(spec, id, parentId) {
  const target = parentId == null ? null : parentId;
  let cur = findNodeById(spec, id);
  while (cur) {
    const parent = parentOfId(spec, cur.id);
    if ((parent ? parent.id : null) === target) return cur.id;
    cur = parent;
  }
  return null;
}

export function isDescendantOf(spec, id, ancestorId) {
  let cur = parentOfId(spec, id);
  while (cur) {
    if (cur.id === ancestorId) return true;
    cur = parentOfId(spec, cur.id);
  }
  return false;
}

// 从树上摘下节点并返回它；positions 不动，调用方决定是否清理
export function detachNode(spec, id) {
  let detached = null;
  const strip = (list) => {
    const i = list.findIndex((n) => n.id === id);
    if (i >= 0) { detached = list.splice(i, 1)[0]; return true; }
    return list.some((n) => (isContainer(n) ? strip(n.children) : false));
  };
  strip(spec.nodes);
  return detached;
}

export function attachNode(spec, node, parentId, index) {
  const list = parentId ? (findNodeById(spec, parentId) || {}).children : spec.nodes;
  if (!list) return false;
  if (typeof index === 'number' && index >= 0 && index <= list.length) list.splice(index, 0, node);
  else list.push(node);
  return true;
}

/* ---------------- 规范化 ---------------- */

export function cloneSpec(spec) {
  return JSON.parse(JSON.stringify(spec));
}

export function nextId(spec, prefix) {
  const used = new Set();
  walkNodes(spec.nodes, (n) => used.add(n.id));
  (spec.edges || []).forEach((e) => used.add(e.id));
  let i = 1;
  while (used.has(prefix + i)) i += 1;
  return prefix + i;
}

// 补齐可选字段、给边补 id、清掉悬空的 positions 与连线
export function normalizeSpec(raw) {
  const spec = raw && typeof raw === 'object' ? raw : {};
  spec.title = String(spec.title == null ? '' : spec.title).trim() || '架构图';
  if (spec.subtitle != null) spec.subtitle = String(spec.subtitle);
  spec.layout = normalizeLayoutId(spec.layout);
  spec.skin = spec.skin && SKINS[spec.skin] ? spec.skin : DEFAULT_SKIN;
  if (!Array.isArray(spec.nodes)) spec.nodes = [];
  if (!Array.isArray(spec.edges)) spec.edges = [];
  if (!spec.positions || typeof spec.positions !== 'object') spec.positions = {};
  if (!spec.frame || !(spec.frame.w > 0) || !(spec.frame.h > 0)) spec.frame = getDefaultFrame(spec.layout);
  // 排版模式二选一：只有 layered 才落字段，flow 是缺省、不写（toBuildSpec 同口径，老 spec 逐字不变）
  if (spec.mode === 'layered') spec.mode = 'layered'; else delete spec.mode;

  const ids = new Set();
  walkNodes(spec.nodes, (n) => {
    if (!n.id || ids.has(n.id)) n.id = nextId(spec, 'n');
    ids.add(n.id);
    n.label = String(n.label == null ? '' : n.label);
    if (isContainer(n) && n.variant !== 'container') n.variant = 'container';
    if (!isContainer(n) && n.variant === 'container') n.children = [];
    // side 只认 left / right，写坏的丢掉（校验器另报 error）
    if (n.side != null && n.side !== 'left' && n.side !== 'right') delete n.side;
  });

  const edgeIds = new Set();
  spec.edges = spec.edges.filter((e) => e && ids.has(e.source) && ids.has(e.target));
  spec.edges.forEach((e, i) => {
    if (!e.id || edgeIds.has(e.id)) e.id = `e${i + 1}`;
    edgeIds.add(e.id);
    if (e.style && !EDGE_STYLES.some((s) => s.id === e.style)) delete e.style;
    // 无箭头（关联线）：非布尔一律丢掉；为真时它压过另外两个方向字段（优先级 undirected > bidirectional > reversed）
    if (e.undirected != null && typeof e.undirected !== 'boolean') delete e.undirected;
    if (e.undirected) { delete e.bidirectional; delete e.reversed; }
    // 方向是三选一：双向 / 反向 / 正向。双向已经两头都有箭头，再叠反向没有意义
    if (e.bidirectional) delete e.reversed;
    // 手调走线：端点档位与中段位移。写坏的一律丢掉回到自动布线，别让一个脏字段把整条边卡住
    ['sourcePort', 'targetPort'].forEach((key) => {
      if (e[key] == null) return;
      if (!isEdgePort(e[key])) { delete e[key]; return; }
      e[key] = { side: e[key].side, t: Math.round(e[key].t * 1000) / 1000, ...(e[key].auto ? { auto: true } : {}) };
    });
    // midShift 是 segShifts 之前的写法（只调三折线的第 2 段），读进来即升级成数组
    if (e.midShift != null) {
      if (Number.isFinite(e.midShift) && e.midShift && !Array.isArray(e.segShifts)) e.segShifts = [e.midShift];
      delete e.midShift;
    }
    if (e.segShifts != null) {
      const clean = Array.isArray(e.segShifts)
        ? e.segShifts.map((v) => (Number.isFinite(v) ? Math.round(v) : 0))
        : [];
      while (clean.length && !clean[clean.length - 1]) clean.pop();   // 末尾的 0 是没调过的段，不用存
      if (clean.length) e.segShifts = clean; else delete e.segShifts;
    }
  });

  Object.keys(spec.positions).forEach((id) => { if (!ids.has(id)) delete spec.positions[id]; });
  return spec;
}

/* ---------------- 皮肤与度量 ---------------- */

// 外框缩放系数的钳制区间，口径同 generate.mjs 的 TYPE_SCALE_RANGE
export const TYPE_SCALE_RANGE = { min: 0.3, max: 2 };

export function skinOf(spec) {
  return SKINS[spec.skin] || SKINS[DEFAULT_SKIN];
}

// 外框相对「打开时那一版外框」缩了多少。generate.mjs 的 BASE_FRAME 在载入时固定，
// 这里同样在 fromBuildSpec 时把 baseFrame 钉死，之后拖外框 / 切版式都相对它算。
export function frameScale(spec) {
  const base = spec.baseFrame || getDefaultFrame(spec.layout);
  if (!spec.frame || !(base.w > 0) || !(base.h > 0)) return 1;
  const s = Math.min(spec.frame.w / base.w, spec.frame.h / base.h);
  if (!Number.isFinite(s) || s <= 0) return 1;
  return Math.max(TYPE_SCALE_RANGE.min, Math.min(TYPE_SCALE_RANGE.max, s));
}

// 运行时度量 = 皮肤结构 token × 外框缩放。卡片内边距、图标、字号、容器内边距都读它。
export function metricsOf(spec) {
  return layeredPanelMetrics(spec, scaleMetrics(skinMetrics(skinOf(spec)), frameScale(spec)));
}

// 质检阈值里的「距离」也随外框一起缩：外框缩小后整张图间距同比变小，
// 阈值若仍按原始像素判定，会刷出一片假的「间距不足 / 距容器边太近」。
// 基准值取自 lib/quality-checker.mjs 的 QUALITY_RULES，这里只做缩放，不另立标准。
// 排版侧要按质检的阈值判断时用这个，不要直接用 qualityOptionsOf。
// qualityOptionsOf 只给「随皮肤/几何变化的增量」，其余阈值（intrusionMin、
// labelEndpointIntrusion…）留在 QUALITY_RULES 里，由 checkQuality 内部
// Object.assign({}, QUALITY_RULES, options) 补齐。排版侧漏了这一步不会报错，
// 只会读到 undefined，比较全部为假 —— 规则静默失效，非常难查。
export function qualityThresholdsOf(spec) {
  return Object.assign({}, QUALITY_RULES, qualityOptionsOf(spec));
}

export function qualityOptionsOf(spec) {
  const s = frameScale(spec);
  const opts = skinQualityOptions(metricsOf(spec));
  opts.containerMargin = QUALITY_RULES.containerMargin * s;
  opts.minSpacing = QUALITY_RULES.minSpacing * s;
  // 箭头实体尺寸随整图几何系数缩放，不挂线宽——edge-weight 硬约束
  const ewQc = edgeWeight(Number((skinOf(spec).tokens || {}).ew) || 2, s);
  opts.arrowClearPx = ewQc.headLen;
  opts.arrowHalfPx = ewQc.headHalf;
  return opts;
}

// 导出主题与 CSS 变量里的结构 token 与 metricsOf 同一份口径：分层图的层带内边距收紧
// （layeredPanelMetrics）必须同时落到排版、页面 CSS 与 SVG / PPTX 导出，否则编组标题会压到卡片上。
export function themeOf(spec) {
  const theme = skinExportTheme(skinOf(spec));
  if (layoutModeOf(spec) === 'layered') theme.metrics = layeredPanelMetrics(spec, theme.metrics);
  return theme;
}

export function cssVarsOf(spec) {
  const skin = skinOf(spec);
  if (layoutModeOf(spec) !== 'layered') return skinCssVarMap(skin);
  return skinCssVarMap(skin, layeredPanelMetrics(spec, skinMetrics(skin)));
}

/* ---------------- 坐标 ---------------- */

export function rectOf(spec, id) {
  const p = spec.positions[id];
  return p ? { x: p.x, y: p.y, w: p.w, h: p.h } : null;
}

export function setRect(spec, id, rect) {
  const next = {
    x: Math.round(rect.x), y: Math.round(rect.y),
    w: Math.round(rect.w), h: Math.round(rect.h),
  };
  const prev = spec.positions[id];
  // 几何一变, 这张卡上由束线（第 10 步）写下的 auto 端口就不算数了: 那是按旧坐标决定的面与位置,
  // 留着会把边冻在旧面上(拖到对面去时直线穿过整排卡)。用户自己钉的端口不动。
  if (!prev || prev.x !== next.x || prev.y !== next.y || prev.w !== next.w || prev.h !== next.h) {
    clearAutoPorts(spec, id);
  }
  spec.positions[id] = next;
}

// 清掉束线落下的 auto 端口。传 nodeId 只清碰到这张卡的边（两端都清 —— 一端的面变了, 束就不成立），
// 不传清全图。用户自己钉的端口（没有 auto 标记）一律不动。
export function clearAutoPorts(spec, nodeId) {
  let n = 0;
  (spec.edges || []).forEach((e) => {
    if (nodeId != null && e.source !== nodeId && e.target !== nodeId) return;
    if (e.sourcePort && e.sourcePort.auto) { delete e.sourcePort; n += 1; }
    if (e.targetPort && e.targetPort.auto) { delete e.targetPort; n += 1; }
  });
  return n;
}

// 容器包围盒：递归取子项并集 + 皮肤给的容器内边距。skip 用于拖动中排除自身。
export function containerRect(spec, id, metrics, skip) {
  const node = findNodeById(spec, id);
  if (!isContainer(node)) return rectOf(spec, id);
  const pad = skinLayout(metrics || metricsOf(spec)).panelPad;
  let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity; let any = false;
  for (const child of node.children) {
    const r = isContainer(child)
      ? containerRect(spec, child.id, metrics, skip)
      : ((skip && skip.has(child.id)) ? null : rectOf(spec, child.id));
    if (!r) continue;
    any = true;
    x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.w); y2 = Math.max(y2, r.y + r.h);
  }
  if (!any) return null;
  return {
    x: Math.round(x1 - pad.left), y: Math.round(y1 - pad.top),
    w: Math.round(x2 - x1 + pad.left + pad.x), h: Math.round(y2 - y1 + pad.top + pad.bottom),
  };
}

// 命中最深的容器（拖放归属判定）
export function containerAt(spec, pt, skip) {
  const metrics = metricsOf(spec);
  const hits = containerNodes(spec)
    .map((c) => ({ id: c.id, r: containerRect(spec, c.id, metrics, skip), depth: nodeDepth(spec, c.id) }))
    .filter((o) => o.r && pt.x > o.r.x && pt.x < o.r.x + o.r.w && pt.y > o.r.y && pt.y < o.r.y + o.r.h)
    .sort((a, b) => b.depth - a.depth);
  return hits.length ? hits[0].id : null;
}

export function leafAt(spec, pt, skipId) {
  const hits = leafNodes(spec).filter((n) => {
    if (skipId && n.id === skipId) return null;
    const r = rectOf(spec, n.id);
    return r && pt.x > r.x && pt.x < r.x + r.w && pt.y > r.y && pt.y < r.y + r.h;
  });
  return hits.length ? hits[hits.length - 1].id : null;
}

/* ---------------- 图标 ---------------- */

export function resolveIcon(spec, node) {
  if (node.icon === false) return null;
  const hint = typeof node.icon === 'string' ? node.icon : null;
  if (hint && !iconSlugExists(hint, TECH_ICONS, GENERIC_ICONS)) return matchIcon(node.label, null, TECH_ICONS, GENERIC_ICONS);
  if (spec.icons === false && !hint) return null;
  return matchIcon(node.label, hint, TECH_ICONS, GENERIC_ICONS);
}

export function iconAsset(slug) {
  return TECH_ICONS[slug] ? { ...TECH_ICONS[slug], type: 'tech' }
    : GENERIC_ICONS[slug] ? { ...GENERIC_ICONS[slug], type: 'generic' } : null;
}

/* ---------------- 一键规整（移植 generate.mjs 阶段 1 的网格排布） ---------------- */

const CONTAINER_MAX_COLS = 4;
const UNIT = { w: 300, h: 170 };

function topoOrder(spec, items, parentId) {
  const ids = items.map((n) => n.id);
  const pos = new Map(ids.map((v, i) => [v, i]));
  const adj = new Map(ids.map((v) => [v, []]));
  const indeg = new Map(ids.map((v) => [v, 0]));
  (spec.edges || []).forEach((e) => {
    const s = projectToLevel(spec, e.source, parentId);
    const t = projectToLevel(spec, e.target, parentId);
    if (s && t && s !== t && adj.has(s) && adj.has(t) && adj.get(s).indexOf(t) < 0) {
      adj.get(s).push(t);
      indeg.set(t, indeg.get(t) + 1);
    }
  });
  const ready = ids.filter((v) => !indeg.get(v)).sort((a, b) => pos.get(a) - pos.get(b));
  const out = [];
  while (ready.length) {
    const v = ready.shift();
    out.push(v);
    adj.get(v).forEach((w) => {
      indeg.set(w, indeg.get(w) - 1);
      if (!indeg.get(w)) { ready.push(w); ready.sort((a, b) => pos.get(a) - pos.get(b)); }
    });
  }
  ids.forEach((v) => { if (out.indexOf(v) < 0) out.push(v); });
  return out.map((v) => items.find((n) => n.id === v));
}

// maxCols：这个容器最多摆几列。写死 4 的时候「列数永远 ≥ 行数」，
// 容器内竖排根本不在候选集里 —— 不是打分没选中，是压根摆不出来。
// 现在由调用方逐个变体下传（见 SHAPE_VARIANTS），1 就是彻底竖排。
// 语义触发的横条（准则 3 / 3.1）：容器里**连着 ≥3 个兄弟**、且在兄弟中度数最高的那个
// 节点，是这一层的聚合点。人工终稿里它一律被摊成横条，被聚合者排成一行放在它下面
// （case-02 的决策中心、case-04 的 HIS 核心 200×216 竖块 → 680×56 横条，都是这个形态）。
//
// 与原来那条几何触发「一行只剩一张叶卡就拉满」的区别：几何触发看的是打包完的残局，
// 谁落单谁被拉满，跟这张卡是不是聚合点没关系 —— case-04 里被拉满的是 gw / idm，
// 而人真正拉成横条的是 HIS 核心。两条触发现在并存，都受收尾处版面分裁决。
//
// 判据是**出度**（扇出到几个不同的节点），不是「同容器里的兄弟数」。
// 一开始按同容器兄弟数写，log-02 的决策中心一个都数不出来 —— 它扇出的
// 拦截 / 放行 / 二次验证 三张卡在另一个容器（response-loop）里，而它自己那层
// （decisioning）只有规则引擎和模型服务两个兄弟。准则 3.1 说的「对三个以上兄弟扇出」
// 指的是被扇出的那一组，不要求它们跟聚合点同父。
//
// 实测这条判据正好挑中两个目标、且只挑中它们：
//   log-02  decision-center 出度 3（kafka 出度 1、feature-platform 2，都排除）
//   log-04  his             出度 4（gw 出度 1，排除）
// 全图的聚合点集合（逐个容器问 hubIdOf）。走线器用它决定哪些节点可以收拢起点。
export function hubIdsOf(spec) {
  const ids = new Set();
  walkNodes(spec.nodes, (n) => {
    if (!isContainer(n)) return;
    const id = hubIdOf(spec, n);
    if (id) ids.add(id);
  });
  return ids;
}

export function hubIdOf(spec, node) {
  const h = hubInfoOf(spec, node);
  return h ? h.id : null;
}

// 聚合点的完整描述：{ id, dir: 'out' | 'in', n, others }。
// 扇出与扇入都算：第二轮 17 份里人拉出的 12 根条，**8 根是扇入**（≥3 个来源指向它 ——
// 08 号边缘网关 4 进、11 号订单中心 3 进、10 号湖仓 3 进、16 号图谱 3 进、20 号统一采集器 3 进），
// 只认出度会把大半漏掉。判据仍是「对面有 ≥3 个不同节点」。扇出的聚合点摊成**横条**（独占一行，
// 被聚合者落在下面）；扇入的聚合点摊成**竖条**（独占一列，长度对齐来源那一组 —— 08 号边缘网关
// 673 高、11 号订单中心 466、20 号统一采集器 327，人拉的四根竖条全是扇入）。同一张卡两头都够数时
// 取扇入（11 / 20 号人的选择），同一容器几张卡都够数时取对面更多的、平局取靠前的。
export function hubInfoOf(spec, node) {
  const kids = node.children || [];
  if (kids.length < 2) return null;              // 条要跨过点什么才有意义
  const fanOut = new Map();
  const fanIn = new Map();
  for (const e of spec.edges || []) {
    if (e.source === e.target) continue;
    if (!fanOut.has(e.source)) fanOut.set(e.source, new Set());
    fanOut.get(e.source).add(e.target);
    if (!fanIn.has(e.target)) fanIn.set(e.target, new Set());
    fanIn.get(e.target).add(e.source);
  }
  let best = null;
  for (const k of kids) {                        // 按 children 顺序遍历，平局取靠前的
    if (isContainer(k)) continue;                // 容器摊成条没有意义，尺寸由子节点定
    const outs = fanOut.get(k.id) || EMPTY_SET;
    let ins = LAYOUT_RULES.hubFanIn ? (fanIn.get(k.id) || EMPTY_SET) : EMPTY_SET;
    // 扇入的来源得是「并排站着的一组」—— 同一个父容器里的兄弟（08 号四个现场设备、20 号采集层
    // 三个来源、11 号三个渠道都是）。从三个不同容器各来一条线的汇点（case-01 的可观测性）不算：
    // 那不是一组，竖条没有对面可对齐，反而把它自己的容器推歪。
    if (ins.size >= HUB_MIN_FANOUT) {
      const srcs = [...ins].map((id) => findNodeById(spec, id));
      const parents = new Set(srcs.map((n) => { const p = n ? parentOfId(spec, n.id) : null; return p ? p.id : '__top__'; }));
      // 来源里有容器（整个编组连过来的线）也不算一组 —— case-01 的可观测性就是三个容器各一条
      if (parents.size !== 1 || srcs.some((n) => !n || isContainer(n))) ins = EMPTY_SET;
    }
    const useIn = ins.size >= HUB_MIN_FANOUT && ins.size >= outs.size;
    const n = Math.max(outs.size, ins.size);
    if (n < HUB_MIN_FANOUT) continue;
    if (!best || n > best.n) best = { id: k.id, n, dir: useIn ? 'in' : 'out', others: useIn ? ins : outs };
  }
  return best;
}
const EMPTY_SET = new Set();
// 「三个以上」—— 准则 3 的原话，八份日志里 14 条长条都满足
const HUB_MIN_FANOUT = 3;

function buildBlock(spec, node, maxCols = CONTAINER_MAX_COLS, rules = activeRules(spec)) {
  if (!isContainer(node)) return { id: node.id, isLeaf: true, cols: 1, rows: 1, children: [] };
  const kids = topoOrder(spec, node.children, node.id).map((k) => buildBlock(spec, k, maxCols, rules));
  const cap = Math.max(1, maxCols);

  // 聚合点抽出来独占一行，排在最前面；兄弟们照常打包，落在它下面。
  // 只对叶子生效：容器本身摊成横条没有意义（它的宽度由子节点决定）。
  let hub = null;
  let hubDir = 'out';
  let hubOthers = null;
  let rest = kids;
  if (rules.hubBar) {
    const info = hubInfoOf(spec, node);
    const i = info == null ? -1 : kids.findIndex((b) => b.id === info.id && b.isLeaf && b.cols === 1);
    if (i >= 0) { hub = kids[i]; hubDir = info.dir; hubOthers = info.others; rest = kids.filter((_, j) => j !== i); }
  }
  // 扇入的聚合点摊成竖条：独占最左一列，兄弟们在它右边照常打包（列数少一列）。
  // 竖条要多高，打包这一层只知道自己容器的行数；来源那一组多半在别的容器里、和它同在一层
  // 货架上 —— 那时按货架的高度拉（见 layoutOnce 里 stretchVbars），长度对齐来源那一组。
  const vbar = hub != null && hubDir === 'in' && maxCols > 1;
  const capRest = vbar ? Math.max(1, cap - 1) : cap;

  const rowsArr = [[]];
  let w = 0;
  rest.forEach((b) => {
    if (w + b.cols > capRest && rowsArr[rowsArr.length - 1].length) { rowsArr.push([]); w = 0; }
    rowsArr[rowsArr.length - 1].push(b);
    w += b.cols;
  });
  // 扇出的聚合点独占一行、放在最上面 —— 扇出边因此从底边往下走，与被聚合者的排布方向正交（准则 3.1）
  if (hub && !vbar) rowsArr.unshift([hub]);
  const children = [];
  let cy = 0;
  let maxW = 0;
  const x0 = vbar ? 1 : 0;   // 竖条占着第 0 列
  rowsArr.forEach((row) => {
    let cx = x0;
    const h = Math.max(...row.map((b) => b.rows));
    row.forEach((b) => { children.push({ block: b, dx: cx, dy: cy }); cx += b.cols; });
    maxW = Math.max(maxW, cx);
    cy += h;
  });
  if (vbar) {
    hub.vbar = true;
    hub.vbarSources = hubOthers;
    // 先按一张普通卡占第 0 列；来源那一组竖着排在同一层货架上时才拉高（stretchVbars）。
    // 来源横着排（如 case-04 三个终端一行）时竖条对不上任何东西，拉高只会白占地方。
    hub.rowSpan = 1;
    children.unshift({ block: hub, dx: 0, dy: 0 });
    maxW = Math.max(maxW, 1);
    cy = Math.max(cy, 1);
  }
  // 一行里只剩一张叶卡时，把它横向拉满这个容器 —— 八份手调终稿里最反复出现的一个动作
  // （case-05 重排横条 252→834、case-04 gw/idm 200→730+、case-08 device_access 188→917）。
  // 触发条件放在打包这一层而不是像素层：这里才知道"这一行只有它"。留一格宽的容器不算，
  // 那种拉不拉都一样。span 之后卡片仍然只占一个格位，宽度在 place() 里按跨列数换算。
  // 语义横条（聚合点那一行）归 hubBar 管，几何横条（别的独占一行的叶卡）归 spanBars 管 ——
  // 两条规则各自有开关，关掉几何横条不能连聚合点的横条一起关掉（2026-08-18 关 spanBars 时踩到）。
  if (maxW > 1) {
    rowsArr.forEach((row) => {
      if (!(row.length === 1 && row[0].isLeaf && row[0].cols === 1)) return;
      const isHub = hub != null && row[0] === hub;
      // 竖条容器里的行从第 1 列起，拉满只拉到右边界，不盖竖条
      const spanTo = maxW - x0;
      if (spanTo <= 1) return;
      if ((isHub && rules.hubBar) || (!isHub && LAYOUT_RULES.spanBars)) row[0].span = spanTo;
    });
  }
  return { id: node.id, isLeaf: false, cols: maxW, rows: cy, children };
}

// 弹性填充（准则：内容区收成一个完整矩形）。
//
// 同一行的顶层容器里，最高的那个把行高撑起来，矮的下面全是空的 —— 实测这就是
// 内容区完整度的全部亏空：log-04 三个容器 292/765/292，行内空洞 40%；
// log-05 四个 774/263/263/374，43.9%。人工终稿没有这种洞。
//
// 容器矩形是子节点包围盒推出来的，不能直接设。所以「把容器撑到行高」实际是
// 把多出来的高度分给它的子节点 —— 把最后一排整排挪到底线（方案 A「撑缝」，
// 理由见函数体内）。卡片尺寸一律不动：加宽牵动 node-fit 的折行与全图字号档位，
// 加高违反「同层等高」，两条都是硬约束。
//
// 这是一次无条件的几何改写，**不自己裁决**：由 layoutOnce 收尾处拿它当候选，
// 与不填充的版本一起交 pickCandidate。
//
// 返回挪动了几张卡。0 = 这张图填不动（没有同行容器、slack 不足、或容器只有一排），
// 调用方据此省掉一个与不填充逐字相同的候选。
// gapY：撑到别的顶层容器头顶时至少留这么宽的缝（传质检的 minSpacing）。
export function elasticFill(spec, metrics, gapY = 0) {
  const tops = containerNodes(spec).filter((c) => nodeDepth(spec, c.id) === 0);
  if (tops.length < 2) return 0;
  const rects = new Map();
  for (const c of tops) {
    const r = containerRect(spec, c.id, metrics);
    if (r) rects.set(c.id, r);
  }
  if (rects.size < 2) return 0;
  let raised = 0;
  const xOverlap = (a, b) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0;
  // 按纵向重叠聚成「行」：同一行的容器**并排**（横向互不重叠）、共用一条底线。
  // 只按纵向重叠聚，会把上下叠放的容器也拉进同一行 —— log-05 的 4 列形状里两个矮容器
  // 骑在一个宽容器的顶边上，2 列形状里一个矮容器正压在另一个头顶：一撑就把子卡撑进
  // 下面那个容器，六处 critical 重叠，候选还没到裁判手里就废了。
  const shelves = [];
  for (const c of [...rects.keys()].sort((a, b) => rects.get(a).y - rects.get(b).y)) {
    const r = rects.get(c);
    const hit = shelves.find((sh) => Math.min(sh.y2, r.y + r.h) - Math.max(sh.y1, r.y) > 10
      && sh.ids.every((o) => !xOverlap(rects.get(o), r)));
    if (hit) { hit.ids.push(c); hit.y1 = Math.min(hit.y1, r.y); hit.y2 = Math.max(hit.y2, r.y + r.h); }
    else shelves.push({ y1: r.y, y2: r.y + r.h, ids: [c] });
  }
  for (const sh of shelves) {
    if (sh.ids.length < 2) continue;
    for (const id of sh.ids) {
      const r = rects.get(id);
      const bottom = r.y + r.h;
      // 底线目标是本行最高的那个容器的底边；同一列下方若另有顶层容器（别的行的），
      // 最多撑到它头顶上方 gapY 处 —— 撑进去就是 critical。
      let ceiling = sh.y2;
      rects.forEach((o, oid) => {
        if (oid === id || o.y <= r.y || !xOverlap(o, r)) return;
        ceiling = Math.min(ceiling, o.y - gapY);
      });
      const slack = ceiling - bottom;
      if (slack < 4) continue;
      // 这个容器的叶子按 y 聚成排
      const leaves = descendantLeafIds(spec, id).map((lid) => ({ id: lid, r: rectOf(spec, lid) })).filter((n) => n.r);
      if (!leaves.length) continue;
      const rows = [];
      for (const n of leaves.slice().sort((a, b) => a.r.y - b.r.y)) {
        const row = rows.find((q) => Math.min(q.y2, n.r.y + n.r.h) - Math.max(q.y1, n.r.y) > 4);
        if (row) { row.items.push(n); row.y1 = Math.min(row.y1, n.r.y); row.y2 = Math.max(row.y2, n.r.y + n.r.h); }
        else rows.push({ y1: n.r.y, y2: n.r.y + n.r.h, items: [n] });
      }
      // 只把**最后一排**整排下移到底线，其余卡片逐字不变（方案 A「撑缝」的最小形式）。
      //
      // 两条路都试过、都被护栏否掉：
      //   · slack 平摊到每一排、下面的排依次下移 —— 拆断跨容器的 0px 对齐
      //     （log-02 从 117 掉到 88），第 6 步的护栏当场报红。
      //   · 只加高最后一排的卡（方案 B「撑卡」）—— 墨水确实涨（0.232 → 0.274），
      //     但一张卡撑到 8 倍高（log-05 64 → 510），违反「同层等高」的产品契约
      //     （tests/arch-doc.test.mjs），还把 case-04 的语义横条判掉、case-01 掉到 92。
      // 只挪最后一排：既有对齐保住绝大多数（bench 94.8 → 96.7），质检反而升。
      //
      // 只有一排的容器不动：整排下移等于把整个容器往下搬，顶边就不共线了 ——
      // 人工终稿恰恰是「容器顶边共线、各自填满」（case-04）。分不掉就算了。
      if (rows.length < 2) continue;
      const last = rows[rows.length - 1];
      for (const n of last.items) {
        setRect(spec, n.id, { x: n.r.x, y: Math.round(n.r.y + slack), w: n.r.w, h: n.r.h });
        raised += 1;
      }
    }
  }
  return raised;
}

// 摆一遍完整的版：打包 → 摆位 → 铺满 → 消交叉 → 走线 → 标签 → 质检。
// 返回一份候选记录（score / blocking / issues / metrics），几何留在传进来的 spec 上。
// opts.onCandidates(cands, winner) —— 只读诊断钩子：把收尾处的横条候选交出去。
function layoutOnce(spec, maxCols, opts = {}) {
  const rules = activeRules(spec);
  const topBlocks = topoOrder(spec, spec.nodes, null).map((n) => buildBlock(spec, n, maxCols, rules));
  if (!topBlocks.length) return null;

  const metrics = metricsOf(spec);
  const frame = spec.frame;
  const AREA = { w: frame.w, h: frame.h };

  const packTop = (Ct) => {
    const shelves = [[]];
    let w = 0;
    topBlocks.forEach((b) => {
      if (w + b.cols > Ct && shelves[shelves.length - 1].length) { shelves.push([]); w = 0; }
      shelves[shelves.length - 1].push(b);
      w += b.cols;
    });
    let R = 0;
    let C = 0;
    shelves.forEach((s) => {
      R += Math.max(...s.map((b) => b.rows));
      C = Math.max(C, s.reduce((a, b) => a + b.cols, 0));
    });
    return { shelves, R, C };
  };

  const minC = Math.max(...topBlocks.map((b) => b.cols));
  const sumC = topBlocks.reduce((a, b) => a + b.cols, 0);
  let plan = null;
  for (let Ct = minC; Ct <= sumC; Ct += 1) {
    const p = packTop(Ct);
    const aspect = (p.C * UNIT.w) / (p.R * UNIT.h);
    const score = Math.abs(Math.log(aspect / (AREA.w / AREA.h)));
    if (!plan || score < plan.score) plan = { shelves: p.shelves, R: p.R, C: p.C, score };
  }

  const cellOf = new Map();
  const placeBlock = (b, x, y) => {
    if (b.isLeaf) { cellOf.set(b.id, { x, y, span: b.span || 1, rowSpan: b.rowSpan || 1 }); return; }
    b.children.forEach((c) => placeBlock(c.block, x + c.dx, y + c.dy));
  };
  const centerCol = (id) => {
    const node = findNodeById(spec, id);
    if (!node) return null;
    if (!isContainer(node)) {
      const c = cellOf.get(id);
      return c ? c.x + (c.span || 1) / 2 : null;
    }
    const cols = descendantLeafIds(spec, id)
      .map((leaf) => cellOf.get(leaf))
      .filter(Boolean)
      .map((c) => c.x + (c.span || 1) / 2);
    return cols.length ? cols.reduce((a, b) => a + b, 0) / cols.length : null;
  };
  const shelfHas = (shelf, id) => shelf.some((b) => b.id === id || (!b.isLeaf && isDescendantOf(spec, id, b.id)));

  // 竖条拉到货架的高度：来源那一组和它同在一层货架时，货架的行数就是那一组竖排的行数
  //（08 号现场设备四张竖排 → 边缘网关四行高；20 号采集层三张 → 统一采集器三行高）。
  // 来源不在同一层时保持自己容器的行数。
  const stretchVbars = (shelf, h) => {
    const walk = (b) => {
      if (b.isLeaf) {
        if (!b.vbar || !b.vbarSources) return;
        // 来源那一组所在的顶层块得在这一层、且是竖着排的一列（cols === 1）——竖条才有对面可对齐
        const srcBlock = shelf.find((tb) => [...b.vbarSources].some((id) => tb.id === id || (!tb.isLeaf && isDescendantOf(spec, id, tb.id))));
        b.rowSpan = srcBlock && srcBlock.cols === 1 && srcBlock.rows >= 2 ? Math.max(1, h) : 1;
        return;
      }
      b.children.forEach((c) => walk(c.block));
    };
    shelf.forEach(walk);
  };

  let gy = 0;
  const shelfMeta = [];   // 每层的摆放顺序/纵坐标/宽度/已选偏移，供下面的摆位消交叉爬山重排
  plan.shelves.forEach((shelf, si) => {
    const shelfW = shelf.reduce((a, b) => a + b.cols, 0);
    const h = Math.max(...shelf.map((b) => b.rows));
    stretchVbars(shelf, h);
    const order = si % 2 ? shelf.slice().reverse() : shelf;

    if (si > 0) {
      order.forEach((b) => {
        if (b.isLeaf || b.rows !== 1) return;
        const hasInternal = (spec.edges || []).some((e) => {
          const s = projectToLevel(spec, e.source, b.id);
          const t = projectToLevel(spec, e.target, b.id);
          return s && t && s !== t;
        });
        if (hasInternal) return;
        const desire = (child) => {
          const cols = [];
          (spec.edges || []).forEach((e) => {
            const isSrc = e.source === child.id || (!child.isLeaf && isDescendantOf(spec, e.source, child.id));
            const isTgt = e.target === child.id || (!child.isLeaf && isDescendantOf(spec, e.target, child.id));
            const other = isSrc ? e.target : isTgt ? e.source : null;
            if (!other) return;
            const oc = centerCol(other);
            if (oc != null) cols.push(oc);
          });
          return cols.length ? cols.reduce((a, c) => a + c, 0) / cols.length : null;
        };
        const entries = b.children.map((c, i) => ({ c, i, want: desire(c.block) }));
        entries.sort((p, q) => (p.want == null ? p.i * 100 : p.want) - (q.want == null ? q.i * 100 : q.want));
        let cx = 0;
        entries.forEach((en) => { en.c.dx = cx; cx += en.c.block.cols; });
        b.children.sort((p, q) => p.dx - q.dx);
      });
    }

    let bestGx = si % 2 ? plan.C - shelfW : 0;
    let bestCost = Infinity;
    for (let gx0 = 0; gx0 <= plan.C - shelfW; gx0 += 1) {
      let x = gx0;
      order.forEach((b) => { placeBlock(b, x, gy); x += b.cols; });
      let cost = 0;
      (spec.edges || []).forEach((e) => {
        if (shelfHas(shelf, e.source) === shelfHas(shelf, e.target)) return;
        const a = centerCol(e.source);
        const c = centerCol(e.target);
        if (a != null && c != null) cost += Math.abs(a - c);
      });
      const tieBonus = (si % 2 ? plan.C - shelfW - gx0 : gx0) * 0.01;
      if (cost + tieBonus < bestCost) { bestCost = cost + tieBonus; bestGx = gx0; }
    }
    let x = bestGx;
    order.forEach((b) => { placeBlock(b, x, gy); x += b.cols; });
    shelfMeta.push({ order, gy, shelfW, gx: bestGx });
    gy += h;
  });


  // 卡片尺寸：宽按最长文字定，高按皮肤度量；间距下限直接取质检准则——
  // 排版用的阈值和事后判定用的是同一个数，规整完不会再被自己的检查判成不合格。
  const qc = qualityOptionsOf(spec);
  const MIN_GAP = qc.minSpacing;
  const INSET = Math.max(qc.containerMargin, 28);   // 外框内侧留白，同时兜住容器包围盒
  const leaves = Array.from(cellOf.keys()).map((id) => findNodeById(spec, id)).filter(Boolean);
  const needW = (n) => {
    const tw = Math.max(estimateTextWidth(n.label, metrics.typeNode), estimateTextWidth(n.sublabel, metrics.typeSmall));
    if (n.variant === 'decision') return Math.round((tw + metrics.cardPadX) / 0.6);
    return Math.round(tw + metrics.cardPadX * 2 + (resolveIcon(spec, n) ? metrics.iconSize + metrics.iconGapX : 0));
  };
  const hasDecision = leaves.some((n) => n.variant === 'decision');
  // targetW 是「最终像素口径」的目标宽：缩放之后仍要够宽，否则文字被 node-fit 降档甚至截断。
  // 上下限要跟着字号一起缩：needW 已经是缩放后的文字宽度，若还按原始像素卡 240 的下限，
  // 小外框下会为了摆下 240 宽的卡把整图压得更小，反而把 12px 的字塞进放不下的卡里。
  // 口径同 generate.mjs 的 typeScaleWProbe。
  const typeScaleW = metrics.typeNode / METRICS_DEFAULTS.typeNode;
  const targetW = Math.min(
    Math.round((hasDecision ? 400 : 360) * typeScaleW),
    Math.max(Math.round(240 * typeScaleW), Math.round(Math.max(...leaves.map(needW)))),
  );
  const CARD_W = targetW;
  const anySub = leaves.some((n) => n.sublabel != null && n.sublabel !== '');
  // 嵌套越深的卡片越矮（cardDepthShrink），行高取该行最高的那张，矮的在行内垂直居中。
  // 各层强行等高会把内层容器挤得很拥挤 —— 深层本来就已经被外层的内边距吃掉一圈。
  const leafDepth = new Map(leaves.map((n) => [n.id, Math.max(0, nodeDepth(spec, n.id) - 1)]));
  const cardHAt = (id) => skinCardHeight(metrics, { hasSub: anySub, depth: leafDepth.get(id) || 0 });
  const CARD_H = Math.max(...leaves.map((n) => cardHAt(n.id)));
  const g = metrics.gutterScale;
  const fs = frameScale(spec);
  const room = { w: Math.max(NODE_MIN.w, AREA.w - INSET * 2), h: Math.max(NODE_MIN.h, AREA.h - INSET * 2) };
  // 自然格距：卡片按 1:1 摆时的间距，跟着卡片一起缩放，缩放后不低于质检准则的最小间距。
  const NAT_GAP_X = Math.max(MIN_GAP, 56 * g * fs);
  const NAT_GAP_Y = Math.max(MIN_GAP, 64 * g * fs);
  // 行距还有一道下限：容器的顶部标题带与底部内边距都是定值、不随卡片缩放。
  // 相邻两行之间要同时容下「上一行结束的那几层容器的下内边距」+「下一行开始的那几层
  // 容器的上内边距」，否则两个容器会直接贴死甚至相交 —— 质检的 overlap 只看节点压容器，
  // 容器压容器它不报，但图面上就是图 1 里那种编组挤在一起的样子。
  // 嵌套容器的内边距逐层叠加，所以按「在这一行开始 / 结束的最深容器层数」算。
  const PAD_BOTTOM = Math.round(metrics.panelPadX * 0.8);
  // 逐道行缝算「这道缝要塞下多少容器内边距」：第 j 行结束的容器层数 × 底边距 + 第 j+1 行开始的
  // 容器层数 × 顶边距。**按缝算，不取全图最大值**（台账 R4）：以前把最宽的那道缝当全图的下限，
  // 容器内部的行缝也被撑到那么宽，卡片只好缩小 —— 09 号引擎行缝 62、人工 33，卡片 186 对 257。
  const containerRowsCache = () => containerNodes(spec).map((c) => {
    const rows = descendantLeafIds(spec, c.id).map((leaf) => cellOf.get(leaf)).filter(Boolean).map((cell) => cell.y);
    return rows.length ? { levels: nodeDepth(spec, c.id) + 1, first: Math.min(...rows), last: Math.max(...rows) } : null;
  }).filter(Boolean);
  const bandFloorsY = () => {
    const startsAt = new Map();
    const endsAt = new Map();
    containerRowsCache().forEach(({ levels, first, last }) => {
      startsAt.set(first, Math.max(startsAt.get(first) || 0, levels));
      endsAt.set(last, Math.max(endsAt.get(last) || 0, levels));
    });
    const out = [];
    const opensAt = [];
    const lastRow = Math.max(-1, ...startsAt.keys(), ...endsAt.keys());
    for (let j = 0; j < lastRow; j += 1) {
      const opens = startsAt.get(j + 1) || 0;
      const closes = endsAt.get(j) || 0;
      out[j] = opens || closes ? opens * metrics.panelPadTop + closes * PAD_BOTTOM + MIN_GAP : 0;
      opensAt[j] = opens > 0;   // 下一行有容器开始：这道缝的下半段是它的顶部内边距 / 编组标题带
    }
    return { out, opensAt };
  };
  // 列缝同理：容器左右两侧的内边距只抬容器开始 / 结束的那道列缝
  const bandFloorsX = () => {
    const startsAt = new Map();
    const endsAt = new Map();
    containerNodes(spec).forEach((c) => {
      const cells = descendantLeafIds(spec, c.id).map((leaf) => cellOf.get(leaf)).filter(Boolean);
      if (!cells.length) return;
      const levels = nodeDepth(spec, c.id) + 1;
      const first = Math.min(...cells.map((cell) => cell.x));
      const last = Math.max(...cells.map((cell) => cell.x + (cell.span || 1) - 1));
      startsAt.set(first, Math.max(startsAt.get(first) || 0, levels));
      endsAt.set(last, Math.max(endsAt.get(last) || 0, levels));
    });
    // 容器的左右内边距按皮肤取（journal 的编组标题是竖在左侧的一条带，左内边距 60）；
    // 「side」模式的皮肤里，从左边穿进容器的带标签边，标签还得落在那条带之外 —— 加上标签宽
    const pad = skinLayout(metrics).panelPad;
    const sideBand = skinLayout(metrics).panelLabel.mode === 'side';
    const out = [];
    const opensAt = [];
    const lastCol = Math.max(-1, ...startsAt.keys(), ...endsAt.keys());
    for (let i = 0; i < lastCol; i += 1) {
      const opens = startsAt.get(i + 1) || 0;
      const closes = endsAt.get(i) || 0;
      out[i] = opens * pad.left + closes * pad.x;
      opensAt[i] = sideBand && opens > 0;
    }
    return { out, opensAt };
  };
  // 全图一个下限（老口径，seamFloors 关掉时用）：只看有容器开始的那几道缝，与原实现一致
  let bandGap = MIN_GAP;
  {
    const startsAt = new Map();
    const endsAt = new Map();
    containerRowsCache().forEach(({ levels, first, last }) => {
      startsAt.set(first, Math.max(startsAt.get(first) || 0, levels));
      endsAt.set(last, Math.max(endsAt.get(last) || 0, levels));
    });
    startsAt.forEach((levels, row) => {
      if (row === 0) return;
      bandGap = Math.max(bandGap, levels * metrics.panelPadTop + (endsAt.get(row - 1) || 0) * PAD_BOTTOM + MIN_GAP);
    });
  }
  const BAND_GAP_Y = bandGap;
  // 带标签的相邻格直连边：标签比线还宽时（标签 88px vs 相邻列距 48px 的直线），
  // 任何落点都无法让箭头露出来。把对应方向的格距下限抬到「标签跨度 + 两端箭头 +
  // 余量」——用一点卡片尺寸换连线与箭头的可读性，是明确的产品取舍。
  const edgeLabelPxNow = Math.round(metrics.typeSmall * 0.8);
  const ewGap = edgeWeight(Number((skinOf(spec).tokens || {}).ew) || 2, fs);
  // 抽成函数是因为要算两次：这里按进场邻接算一次定初值，爬山重排完再按定稿邻接
  // 复算一次（见下面的 enforceLabelGapFloors）。两处必须同一把尺，抄一份迟早跑偏。
  const labelGapFloors = () => {
    let x = 0;
    let y = 0;
    (spec.edges || []).forEach((e) => {
      if (!e.label) return;
      const ca = cellOf.get(e.source);
      const cb = cellOf.get(e.target);
      if (!ca || !cb) return;
      // 单向边只有目标端有箭头，标签可以贴着源端放——净空按方向性精确计，
      // 少要一个箭头位就少压窄一点卡片
      const arrowEnds = e.undirected ? 0 : e.bidirectional ? 2 : 1;   // 无箭头边两头都不用留箭头位
      const clearance = ewGap.headLen * arrowEnds + 8 * (arrowEnds + 1);
      if (ca.y === cb.y && Math.abs(ca.x - cb.x) === 1) {
        x = Math.max(x, estimateTextWidth(e.label, edgeLabelPxNow) + 24 + clearance);
      }
      if (ca.x === cb.x && Math.abs(ca.y - cb.y) === 1) {
        y = Math.max(y, Math.round(edgeLabelPxNow * 1.5) + clearance);
      }
    });
    return { x, y };
  };
  // 逐道缝的标签下限：只有真有带标签的相邻直连边横穿的那道缝才要塞得下标签（准则 5：
  // 「横向余量集中给承载横向带标签连线的通道」，日志 03 的 139 / 163 / 106）。
  const labelFloorsBySeam = () => {
    const x = [];
    const y = [];
    const xLabel = [];
    const yLabel = [];
    // 任何一条边横穿的缝都要放得下走线通道：两侧各留质检的最小净空，中间是线本身
    const corridor = MIN_GAP * 2 + ewGap.headLen;
    // 连着容器的边也算：容器按它后代叶卡格位的包围盒当一个大格位（log-03 的 hypervisor → qnx_vm，
    // 老口径全图一个下限时不用管它，逐缝之后不算它那道缝就只剩 78px，标签压卡 + 盖箭头）
    const cellOfAny = (id) => {
      const c = cellOf.get(id);
      if (c) return c;
      const cells = descendantLeafIds(spec, id).map((leaf) => cellOf.get(leaf)).filter(Boolean);
      if (!cells.length) return null;
      const x0 = Math.min(...cells.map((k) => k.x));
      const y0 = Math.min(...cells.map((k) => k.y));
      const x1 = Math.max(...cells.map((k) => k.x + (k.span || 1) - 1));
      const y1 = Math.max(...cells.map((k) => k.y + (k.rowSpan || 1) - 1));
      return { x: x0, y: y0, span: x1 - x0 + 1, rowSpan: y1 - y0 + 1 };
    };
    (spec.edges || []).forEach((e) => {
      if (e.source === e.target) return;
      const ca = cellOfAny(e.source);
      const cb = cellOfAny(e.target);
      if (!ca || !cb) return;
      const arrowEnds = e.undirected ? 0 : e.bidirectional ? 2 : 1;   // 无箭头边两头都不用留箭头位
      const clearance = ewGap.headLen * arrowEnds + 8 * (arrowEnds + 1);
      // 标签落在哪一段由走线与落标签决定，摆位这一层只做保守估计：
      //   同行直连边：标签在两张卡之间的横向缝里，列缝要塞得下标签宽；
      //   同列直连边：标签在两张卡之间的纵向缝里，行缝要塞得下标签高；
      //   拐弯的边：横段落在某道行缝里、竖段落在某道列缝里，标签会挑放得下的那段 —— 行缝给标签高
      //   （横段带标签最常见），列缝只给走线通道（给标签宽会让每道列缝都撑到 115，等于回到全图一个数）。
      const labelW = e.label ? estimateTextWidth(e.label, edgeLabelPxNow) + 24 + clearance : 0;
      const labelH = e.label ? Math.round(edgeLabelPxNow * 1.5) + clearance : 0;
      // 同行的带标签边（不限相邻）：它横穿的每道列缝都要塞得下标签 —— 标签落在哪道缝不知道，只能都留；
      // 只留相邻那道试过：case-01 隔列的同行边标签压到中间的卡上，质检 92 → 90。
      // 行区间相交且列区间不相交 = 横着连（含跨行的条与容器包围盒）
      const rowsMeet = Math.max(ca.y, cb.y) <= Math.min(ca.y + (ca.rowSpan || 1) - 1, cb.y + (cb.rowSpan || 1) - 1);
      const colsMeet = Math.max(ca.x, cb.x) <= Math.min(ca.x + (ca.span || 1) - 1, cb.x + (cb.span || 1) - 1);
      const sameRow = rowsMeet && !colsMeet;
      // 连着容器的边：只有紧挨着（中间就一道缝）时才把标签宽压给那道缝 —— 隔着几列的容器边
      //（case-01 三条到 observability 的遥测边）标签落在中间某处，全部缝都抬会把版面撑回老样子
      const viaContainer = !cellOf.has(e.source) || !cellOf.has(e.target);
      const aR0 = ca.x + (ca.span || 1) - 1;
      const bR0 = cb.x + (cb.span || 1) - 1;
      const seamsBetween = sameRow ? Math.max(ca.x, cb.x) - Math.min(aR0, bR0) : 0;
      // 隔着几列的容器边连通道也不抬：它的走线器会绕着容器走，抬中间的缝只是把版面撑开（case-01 实测 95 → 89）
      if (viaContainer && !(sameRow && seamsBetween === 1)) return;
      const needX = sameRow ? Math.max(corridor, labelW) : corridor;
      const needY = Math.max(corridor, labelH);
      // 横向只抬两个盒子**之间**的缝（左盒右缘到右盒左缘），别把盒子自己跨过的缝也算进去
      const aR = ca.x + (ca.span || 1) - 1;
      const bR = cb.x + (cb.span || 1) - 1;
      const x0 = sameRow ? Math.min(aR, bR) : Math.min(ca.x, cb.x);
      const x1 = sameRow ? Math.max(ca.x, cb.x) : Math.max(aR, bR);
      const y0 = Math.min(ca.y, cb.y);
      const y1 = Math.max(ca.y + (ca.rowSpan || 1) - 1, cb.y + (cb.rowSpan || 1) - 1);
      for (let i = x0; i < x1; i += 1) {
        x[i] = Math.max(x[i] || 0, needX);
        // 同行直连的带标签边穿过容器边上的列缝：标签得落在编组标题带之外（journal 那种竖带）
        if (e.label && sameRow) xLabel[i] = Math.max(xLabel[i] || 0, labelW);
      }
      for (let j = y0; j < y1; j += 1) {
        y[j] = Math.max(y[j] || 0, needY);
        // 带标签的边竖着穿过这道缝：记下标签本身要占的高度，容器开始 / 结束的缝要把它加在内边距之外
        if (e.label) yLabel[j] = Math.max(yLabel[j] || 0, labelH);
      }
    });
    return { x, y, xLabel, yLabel };
  };
  const entryFloors = labelGapFloors();
  const LABEL_GAP_X = entryFloors.x;
  const LABEL_GAP_Y = entryFloors.y;

  // 在原点按给定卡片尺寸与格距摆一遍，再量实际占地。占地要连容器包围盒一起量：
  // 容器的内边距比节点大，只看节点会摆出「节点在框内、容器压出框」的结果。
  // 走线通道净空要收窄的卡片：id -> { px, side }。side 是"往哪一侧收"，
  // 'right' 表示左边不动、右缘往左收，'left' 反之。见 widenBlockedCorridors()。
  const cut = new Map();

  // 跨编组的缝比编组内部宽 —— **间距本身在说明分组**（准则 4）。
  //
  // 这是判别力表里人工最强的一项（7:1，八份日志只输一份），而 main 实测 0.956：
  // 跨编组的缝比编组内部还窄，等于用间距在说「这几张卡是一组」的反话。日志 08 的
  // 对照最直白：容器边界处 230–233px，容器内部 38–51px，相差四倍以上。
  //
  // 判定口径：一条轨道（列 / 行）上所有格位的顶层编组构成一个集合，相邻两条轨道的
  // 集合**不相交**时，这道缝才算跨组缝。相交（同一个编组横跨两条轨道）时不放大 ——
  // 否则会把一个编组自己劈成两半，那正是「间距在说明分组」的反面。
  const topGroupCache = new Map();
  const topGroupOf = (id) => {
    if (!topGroupCache.has(id)) topGroupCache.set(id, projectToLevel(spec, id, null));
    return topGroupCache.get(id);
  };
  // 轨道 i 与 i+1 之间是不是跨组缝。cellOf 会被消交叉阶段改写，所以每次摆位都重算。
  const crossSeams = (axis) => {
    const groups = new Map();
    cellOf.forEach((c, id) => {
      const from = c[axis];
      // 跨列的长条同时站在好几条轨道上，每一条都要记上它的编组
      const to = axis === 'x' ? from + ((c.span || 1) - 1) : from + ((c.rowSpan || 1) - 1);
      for (let i = from; i <= to; i += 1) {
        if (!groups.has(i)) groups.set(i, new Set());
        groups.get(i).add(topGroupOf(id));
      }
    });
    const last = Math.max(-1, ...groups.keys());
    const cross = [];
    for (let i = 0; i < last; i += 1) {
      const a = groups.get(i);
      const b = groups.get(i + 1);
      cross[i] = !!(a && b && ![...a].some((g) => b.has(g)));
    }
    return cross;
  };
  // 轨道起点：逐条累加「格位尺寸 + 这道缝」，跨组缝宽、组内缝窄。
  //
  // **预算中性**：缝的总额固定，只在「跨组」与「组内」之间重新分配，不额外占地。
  // 这一条是实测逼出来的。先做的版本是直接把跨组缝乘 1.6，结果三项一起看是这样：
  //
  //         墨水    完整度   分组间距比
  //   1.0   0.225   0.660   0.951
  //   1.6   0.194   0.606   1.159      ← 间距比涨了，墨水和完整度掉了
  //   人工  0.284   0.732   2.231      ← 三项同时最好
  //
  // 直接放大等于凭空多占地，铺满外框那一步只好把卡片缩小，墨水和完整度就跟着掉 ——
  // 版面分把这版判负（平均 0.442 对 1.0 的 0.532），判得对。
  // 人工的做法不是「多留缝」，是**把余量从别处挪进缝里**：日志 03 的左右边距
  // 52 / 52 压到 4 / 12，省出来的全给了列间距 107 → 139 / 163（准则 5）。
  // 预算中性就是这个意思：总宽不变，卡片尺寸不受影响，只有缝的分布变了。
  // floors：逐道缝的硬下限数组（标签通道 / 容器内边距 / 最小间距），只抬需要抬的那一道。
  const railOffsets = (cross, cellSize, gap, floors) => {
    const nCross = cross.filter(Boolean).length;
    const nInner = cross.length - nCross;
    let inner = gap;
    let outer = gap;
    // 两种缝都存在时才谈得上分配；全是跨组缝（或全是组内缝）时放大只是整体变宽
    if (LAYOUT_RULES.groupGap && nCross > 0 && nInner > 0 && GROUP_GAP_SCALE > 1) {
      const budget = cross.length * gap;
      // 组内缝只许被压窄，绝不许被抬宽：下限有可能已经高于当前 gap（小外框里
      // 容器内边距就会这样），那时候「抬到下限」会让整张图变宽/变高，
      // 铺满那一步反过来缩小卡片 —— 正是这条规则要避免的事。
      const minInner = Math.min(gap, LAYOUT_RULES.seamFloors ? MIN_GAP : Math.max(MIN_GAP, ...floors.map((f) => f || 0)));
      outer = gap * GROUP_GAP_SCALE;
      inner = (budget - nCross * outer) / nInner;
      if (inner < minInner) {
        inner = minInner;
        outer = (budget - nInner * inner) / nCross;
        // 组内缝已经压到底还是匀不出余量：退回均匀，不做这次重分配
        if (outer <= gap) { inner = gap; outer = gap; }
      }
    }
    const out = [0];
    for (let i = 0; i < cross.length; i += 1) {
      const seam = cross[i] ? outer : inner;
      // 老口径（seamFloors 关）：下限只约束 minInner，不逐缝抬；逐缝口径才按每道缝的下限抬
      const floor = LAYOUT_RULES.seamFloors ? Math.max(MIN_GAP, floors[i] || 0) : 0;
      out[i + 1] = out[i] + cellSize + Math.max(seam, floor);
    }
    return out;
  };

  const place = (cw, ch, gx, gy) => {
    const scale = ch / CARD_H;
    // 组内缝可以被压窄来供养跨组缝，但不能压破**硬下限**：
    //   x —— 质检的最小间距，以及带标签的边横穿时标签本身的宽度（LABEL_GAP_X）
    //   y —— 再加上相邻两行容器内边距之和（BAND_GAP_Y，随卡片压缩比放松）
    // 起初这里只floor 到 MIN_GAP，case-06 的「本地收单」标签立刻压到了隔壁那条线上：
    // 组内通道被压到比标签还窄，标签沿线滑到哪都躲不开。LABEL_GAP_X 存在的理由就是这个。
    // 逐道缝的下限：标签通道只抬带标签直连边横穿的那道缝，容器内边距只抬有容器开始 / 结束的
    // 那道行缝（随卡片压缩比放松），其余缝只守最小间距（台账 R4：富余给卡片、不给用不上的缝）
    const lf = LAYOUT_RULES.seamFloors ? labelFloorsBySeam() : null;
    const bf = LAYOUT_RULES.seamFloors ? bandFloorsY() : null;
    const bfx = LAYOUT_RULES.seamFloors ? bandFloorsX() : null;
    const seams = (axis) => crossSeams(axis);
    const crossX = seams('x');
    const crossY = seams('y');
    // 列缝：容器左右内边距 + 穿过这道缝的标签宽（容器边上的缝里标签得落在内边距之外，相加）
    const floorsX = crossX.map((_, i) => (lf
      ? Math.max(lf.x[i] || 0, (bfx.out[i] || 0) + (bfx.opensAt[i] ? (lf.xLabel[i] || 0) : 0))
      : Math.max(MIN_GAP, LABEL_GAP_X)));
    // 有容器开始的行缝里穿着带标签的竖边：标签得落在顶部内边距 / 编组标题带之外，标签高加在内边距上
    //（handbook / source 的 bar-top 标题带实测被压过）；只有容器结束的缝取大就够
    const floorsY = crossY.map((_, j) => (lf
      ? Math.max(lf.y[j] || 0, (bf.out[j] || 0) * Math.min(1, scale) + (bf.opensAt[j] ? (lf.yLabel[j] || 0) : 0))
      : Math.max(MIN_GAP, LABEL_GAP_Y, BAND_GAP_Y * Math.min(1, scale))));
    const colX = railOffsets(crossX, cw, gx, floorsX);
    const rowY = railOffsets(crossY, ch, gy, floorsY);
    const railAt = (rail, i, cell, gap) => (i < rail.length
      ? rail[i]
      : (rail.length ? rail[rail.length - 1] + (cell + gap) * (i - rail.length + 1) : i * (cell + gap)));
    cellOf.forEach((c, id) => {
      const node = findNodeById(spec, id);
      // 跨列的卡（独占一行被拉满的那种）连同它跨过的格缝一起算宽 ——
      // 现在缝可能不等宽，所以按两端轨道的实际距离量，不能再用 cw*span + gx*(span-1)
      const span = c.span || 1;
      const x0 = railAt(colX, c.x, cw, gx);
      let w = Math.round(railAt(colX, c.x + span - 1, cw, gx) + cw - x0);
      // 跨行的竖条（扇入聚合点）连同它跨过的行缝一起算高，与横条跨列同理
      const rowSpan = c.rowSpan || 1;
      const y0 = railAt(rowY, c.y, ch, gy);
      let h = rowSpan > 1
        ? Math.round(railAt(rowY, c.y + rowSpan - 1, ch, gy) + ch - y0)
        : Math.round(cardHAt(id) * scale);
      let x = Math.round(x0);
      if (node && node.variant === 'circle' && w > h) { x += Math.round((w - h) / 2); w = h; }
      const shave = cut.get(id);
      if (shave && shave.px > 0) {
        w = Math.max(NODE_MIN.w, w - shave.px);
        if (shave.side === 'left') x += Math.round(cw) - w;   // 右缘不动，左缘往右收
      }
      // 比行高矮的卡在行内垂直居中；竖条顶着行的上沿
      const y = rowSpan > 1 ? Math.round(y0) : Math.round(y0 + (ch - h) / 2);
      setRect(spec, id, { x, y, w, h });
    });
  };
  const occupied = () => {
    let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity;
    const add = (r) => {
      if (!r) return;
      x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y);
      x2 = Math.max(x2, r.x + r.w); y2 = Math.max(y2, r.y + r.h);
    };
    cellOf.forEach((_, id) => add(rectOf(spec, id)));
    containerNodes(spec).forEach((c) => add(containerRect(spec, c.id, metrics)));
    return { x: x1, y: y1, w: Math.max(1, x2 - x1), h: Math.max(1, y2 - y1) };
  };

  // 铺满外框分两步走，横竖分开算：
  //   ① 卡片连同自然格距等比缩放，取「还放得进外框」的最大倍率——各向同性，卡片不会被拉成扁片；
  //   ② 剩下的富余按方向补回去：先补卡片（横向补宽、纵向补高），再补格距。
  // 第二步必须分方向做，两行节点才铺得满一个很高的外框。只做第一步的话，
  // 吃紧的那个方向一封顶，另一个方向就永远空着一大片——这正是「一键规整后留一大块空白」的来由。
  // 越界在准则里是 critical，所以两步都以「量出来的占地不超出 room」为硬约束；
  // 容器内边距是定值、不随卡片变小，占地对倍率不是线性的，只能按实测二分。
  const boxAt = (cs, gx, gy) => {
    place(CARD_W * cs, CARD_H * cs, gx, gy);
    return occupied();
  };
  // 行距下限在卡片被压到 1:1 以下时按同一系数放松：小外框里连卡片都摆不下的时候，
  // 越出外框（准则里是 critical）比两个容器贴在一起（准则不报）严重得多。
  const gapsAt = (cs) => (LAYOUT_RULES.seamFloors
    // 逐缝下限时基础格距只按卡片比例走：要塞标签 / 内边距的那几道缝由 place() 里的 floors 单独抬
    ? { x: Math.max(MIN_GAP, NAT_GAP_X * cs), y: Math.max(MIN_GAP, NAT_GAP_Y * cs) }
    : {
      // LABEL_GAP 不随 cs 缩：标签字号跟 frameScale 走、不跟卡片压缩比走，
      // 卡片再小，标签也还是那么宽
      x: Math.max(MIN_GAP, NAT_GAP_X * cs, LABEL_GAP_X),
      y: Math.max(MIN_GAP, NAT_GAP_Y * cs, BAND_GAP_Y * Math.min(1, cs), LABEL_GAP_Y),
    });
  const fitsAt = (cs) => {
    const gap = gapsAt(cs);
    const b = boxAt(cs, gap.x, gap.y);
    return b.w <= room.w && b.h <= room.h;
  };
  // 卡片最多比目标尺寸大多少：原来一刀切 1.6（「再大就只是空卡片」）。第二轮手调里 04 / 09 号的卡
  // 是引擎的两倍高、四成宽，他看 log-09 对照时说「节点又很小」—— 富余该先给卡片（台账 R4）。
  const CARD_SCALE_MAX = LAYOUT_RULES.cardFillScaleMax;
  let cardScale = CARD_SCALE_MAX;
  if (!fitsAt(cardScale)) {
    let lo = 0;
    let hi = cardScale;
    for (let i = 0; i < 20; i += 1) {
      const mid = (lo + hi) / 2;
      if (fitsAt(mid)) lo = mid; else hi = mid;
    }
    cardScale = lo;
  }
  let CW = CARD_W * cardScale;
  let CH = CARD_H * cardScale;
  const base = gapsAt(cardScale);
  let GUT_X = base.x;
  let GUT_Y = base.y;
  // 把某个量从当前值加到「刚好还放得进外框」为止：占地对卡片尺寸和格距都单调递增，
  // 能加到上限就取上限，否则二分。set 负责写回并重新摆放，fits 只看它管的那个方向。
  const growTo = (from, cap, set, fits) => {
    const ok = (v) => { set(v); return fits(occupied()); };
    if (cap <= from) { set(from); return from; }
    if (ok(cap)) return cap;
    if (!ok(from)) { set(from); return from; }
    let lo = from;
    let hi = cap;
    for (let i = 0; i < 18; i += 1) {
      const mid = (lo + hi) / 2;
      if (ok(mid)) lo = mid; else hi = mid;
    }
    set(lo);
    return lo;
  };
  const fitsW = (b) => b.w <= room.w;
  const fitsH = (b) => b.h <= room.h;
  const redraw = () => place(CW, CH, GUT_X, GUT_Y);
  // 富余先补进卡片，再补进格距。卡片有两道上限：单个方向最多在等比之外再拉伸三成
  // （不然会拉出长条），且不论怎么补，都不超过目标尺寸的 CARD_SCALE_MAX 倍。
  // 格距上限按卡片尺寸给、不按固定像素：卡片大则间距同步放宽，
  // 节点少、外框大的图才铺得开；封顶是为了让两三个节点的图不至于散成孤岛。
  const CARD_STRETCH = LAYOUT_RULES.cardFillStretch;
  const GAP_X_MAX = 1.4;
  const GAP_Y_MAX = 2.4;
  const capW = Math.min(CW * CARD_STRETCH, CARD_W * CARD_SCALE_MAX);
  const capH = Math.min(CH * CARD_STRETCH, CARD_H * CARD_SCALE_MAX);
  CW = growTo(CW, capW, (v) => { CW = v; redraw(); }, fitsW);
  GUT_X = growTo(GUT_X, Math.max(GUT_X, CW * GAP_X_MAX), (v) => { GUT_X = v; redraw(); }, fitsW);
  CH = growTo(CH, capH, (v) => { CH = v; redraw(); }, fitsH);
  GUT_Y = growTo(GUT_Y, Math.max(GUT_Y, CH * GAP_Y_MAX), (v) => { GUT_Y = v; redraw(); }, fitsH);
  redraw();

  // 居中（收尾与 L4 的质检闸都用；定义提前到爬山之前）
  const recenter = () => {
    const fitted = occupied();
    const dx = Math.round(frame.x + Math.max(INSET, (frame.w - fitted.w) / 2) - fitted.x);
    const dy = Math.round(frame.y + Math.max(INSET, (frame.h - fitted.h) / 2) - fitted.y);
    cellOf.forEach((_, id) => {
      const r = rectOf(spec, id);
      if (r) setRect(spec, id, { x: r.x + dx, y: r.y + dy, w: r.w, h: r.h });
    });
  };

  // ---- 摆位消交叉：相邻交换 × 行偏移重扫（代理粗筛 + 真实走线复核） ----------
  // 逐层贪心摆放只看「已摆好的层」，摆完后用完整信息再修一遍顺序。两级口径：
  //   粗筛：把每条边当作端点中心的直线段数 proper 交点（快，但与正交走线有偏差）；
  //   复核：代理说有利的候选，真跑一次走线器按违规代价裁决，代价上升就回滚；
  //   收尾再与进场摆位整体比一次，防止爬山的路径依赖造成净退步。
  // 对角正对的 X 型边在拓扑上必然交叉，走线器无从化解，只有交换节点顺序能拆掉。
  const gridCenter = (id) => {
    const node = findNodeById(spec, id);
    if (!node) return null;
    if (!isContainer(node)) {
      const c = cellOf.get(id);
      // 横条仍按格位算中心（改成按跨度算会让 09 号的爬山换路、cols3 掉 3 分 —— 与竖条无关的扰动，不动）；
      // 竖条按跨过的行数取中心
      return c ? { x: c.x + 0.5, y: c.y + (c.rowSpan || 1) / 2 } : null;
    }
    const cells = descendantLeafIds(spec, id).map((leaf) => cellOf.get(leaf)).filter(Boolean);
    if (!cells.length) return null;
    return {
      x: cells.reduce((a, c) => a + c.x + 0.5, 0) / cells.length,
      y: cells.reduce((a, c) => a + c.y + 0.5, 0) / cells.length,
    };
  };
  // 台账 L4：格位上的「相邻直达」—— 两张叶卡同行（含跨行条的行区间相交）且中间没有别的卡，
  // 或同列且中间没有别的卡。与 lib/layout-metrics.mjs 的 adjacentStraight 同义、只是按格位算。
  const occupancyNow = () => {
    const occ = new Map();
    cellOf.forEach((c, id) => {
      for (let i = 0; i < (c.span || 1); i += 1) {
        for (let j = 0; j < (c.rowSpan || 1); j += 1) occ.set(`${c.x + i},${c.y + j}`, id);
      }
    });
    return occ;
  };
  const directOnGrid = (occ, a, b) => {
    const ax1 = a.x + (a.span || 1) - 1;
    const ay1 = a.y + (a.rowSpan || 1) - 1;
    const bx1 = b.x + (b.span || 1) - 1;
    const by1 = b.y + (b.rowSpan || 1) - 1;
    const rowsMeet = Math.max(a.y, b.y) <= Math.min(ay1, by1);
    const colsMeet = Math.max(a.x, b.x) <= Math.min(ax1, bx1);
    if (rowsMeet && !colsMeet) {
      const [L, R] = ax1 < b.x ? [ax1, b.x] : [bx1, a.x];
      for (let y = Math.max(a.y, b.y); y <= Math.min(ay1, by1); y += 1) {
        for (let x = L + 1; x < R; x += 1) if (occ.has(`${x},${y}`)) return false;
      }
      return true;
    }
    if (colsMeet && !rowsMeet) {
      const [T, B] = ay1 < b.y ? [ay1, b.y] : [by1, a.y];
      for (let x = Math.max(a.x, b.x); x <= Math.min(ax1, bx1); x += 1) {
        for (let y = T + 1; y < B; y += 1) if (occ.has(`${x},${y}`)) return false;
      }
      return true;
    }
    return false;
  };
  const ADJ_K = rules.adjacencyProxy;
  const proxyCost = () => {
    const segs = [];
    let span = 0;
    let nonDirect = 0;
    const occ = ADJ_K > 0 ? occupancyNow() : null;
    (spec.edges || []).forEach((e) => {
      if (e.source === e.target) return;
      const a = gridCenter(e.source);
      const b = gridCenter(e.target);
      if (!a || !b) return;
      segs.push([a, b]);
      span += Math.abs(a.x - b.x);
      if (occ) {
        const ca = cellOf.get(e.source);
        const cb = cellOf.get(e.target);
        // 只算叶到叶；连着容器的边没有「对面」可言
        if (ca && cb && !directOnGrid(occ, ca, cb)) nonDirect += 1;
      }
    });
    let crossings = 0;
    for (let i = 0; i < segs.length; i += 1) {
      for (let j = i + 1; j < segs.length; j += 1) {
        if (segmentsIntersect(segs[i][0], segs[i][1], segs[j][0], segs[j][1])) crossings += 1;
      }
    }
    return crossings * 1000 + span + ADJ_K * nonDirect;
  };
  const reflowShelf = (m) => {
    let rx = m.gx;
    m.order.forEach((b) => { placeBlock(b, rx, m.gy); rx += b.cols; });
    redraw();
  };
  const routeCostNow = () => {
    const cardsArr = [];
    cellOf.forEach((_, id) => {
      const r = rectOf(spec, id);
      if (r) cardsArr.push({ id, x: r.x, y: r.y, w: r.w, h: r.h });
    });
    const rects = cardsArr.slice();
    containerNodes(spec).forEach((c) => {
      const r = containerRect(spec, c.id, metrics);
      if (r) rects.push({ id: c.id, x: r.x, y: r.y, w: r.w, h: r.h });
    });
    // 不改 refine 轮数等保真度参数：复核口径必须与 buildScene 的正式布线一致，
    // 两级保真度不齐时，低保真下"持平"的交换会在正式布线里变差。
    // 候选复核一律不并线（bundle:false），与裁判口径一致 —— 束线是定稿后的事（见 autoLayout）。
    const routed = routeEdges({
      rects,
      cards: cardsArr,
      edges: (spec.edges || []).map((e) => ({
        id: e.id, source: e.source, target: e.target, style: e.style,
        bidirectional: !!e.bidirectional, reversed: !e.bidirectional && !!e.reversed,
      })),
      options: { bundle: false },
    });
    const v = routed.stats.violations || {};
    const W = ROUTER_DEFAULTS;
    return (v.crossPairs || 0) * W.crossPenalty
      + ((v.nodeCross || 0) + (v.backside || 0)) * W.nodeCrossPenalty
      + (v.containerCross || 0) * W.containerCrossPenalty
      + (v.collinearPairs || 0) * W.collinearPenalty
      + (v.nearParallel || 0) * W.nearParallelPenalty
      + ((v.detours || 0) + (v.bendsOver || 0)) * W.detourPenalty;
  };
  // 连 span / rowSpan 一起存：只存 x / y 的话回滚之后横条 / 竖条的跨度就丢了，收尾的拉满候选跟着消失
  const snapshotCells = () => {
    const s = new Map();
    cellOf.forEach((c, id) => s.set(id, { ...c }));
    return s;
  };
  const restoreCells = (snap) => {
    cellOf.clear();
    snap.forEach((c, id) => cellOf.set(id, { ...c }));
    redraw();
  };
  const entryCells = snapshotCells();
  const entryReal = routeCostNow();
  let realNow = entryReal;
  // 已应用的候选交给走线器复核：违规代价不升即采纳（同分时代理已更优，仍算改善）
  const verifyOrRevert = (revert) => {
    const after = routeCostNow();
    if (after <= realNow) { realNow = after; return true; }
    revert();
    return false;
  };
  const containerRows = [];
  const collectRows = (b, m) => {
    if (b.isLeaf) return;
    const rows = new Map();
    b.children.forEach((c) => {
      if (c.block.vbar) return;   // 竖条守着最左一列，不参与行内换位
      if (!rows.has(c.dy)) rows.set(c.dy, []);
      rows.get(c.dy).push(c);
    });
    rows.forEach((kids) => { if (kids.length > 1) containerRows.push({ kids, m }); });
    b.children.forEach((c) => collectRows(c.block, m));
  };
  shelfMeta.forEach((m) => m.order.forEach((b) => collectRows(b, m)));
  const containerGrids = [];
  const collectGrids = (b, m) => {
    if (b.isLeaf) return;
    if (b.children.length > 1) containerGrids.push({ kids: b.children, cols: b.cols, rows: b.rows, m });
    b.children.forEach((c) => collectGrids(c.block, m));
  };
  shelfMeta.forEach((m) => m.order.forEach((b) => collectGrids(b, m)));
  const swapKids = (kids, i, m) => {
    const start = Math.min(...kids.map((k) => k.dx));
    const tmp = kids[i];
    kids[i] = kids[i + 1];
    kids[i + 1] = tmp;
    let dx = start;
    kids.forEach((k) => { k.dx = dx; dx += k.block.cols; });
    reflowShelf(m);
  };
  for (let pass = 0; pass < 2; pass += 1) {
    let improved = false;
    shelfMeta.forEach((m) => {
      for (let i = 0; i + 1 < m.order.length; i += 1) {
        const beforeProxy = proxyCost();
        const tmp = m.order[i];
        m.order[i] = m.order[i + 1];
        m.order[i + 1] = tmp;
        reflowShelf(m);
        const revert = () => {
          m.order[i + 1] = m.order[i];
          m.order[i] = tmp;
          reflowShelf(m);
        };
        if (proxyCost() < beforeProxy - 1e-9) {
          if (verifyOrRevert(revert)) improved = true;
        } else {
          revert();
        }
      }
      const oldGx = m.gx;
      let bg = m.gx;
      let bc = Infinity;
      for (let gx0 = 0; gx0 <= plan.C - m.shelfW; gx0 += 1) {
        m.gx = gx0;
        reflowShelf(m);
        const c = proxyCost();
        if (c < bc - 1e-9) { bc = c; bg = gx0; }
      }
      m.gx = bg;
      reflowShelf(m);
      if (bg !== oldGx) {
        if (verifyOrRevert(() => { m.gx = oldGx; reflowShelf(m); })) improved = true;
      }
    });
    containerRows.forEach((row) => {
      row.kids.sort((p, q) => p.dx - q.dx);
      for (let i = 0; i + 1 < row.kids.length; i += 1) {
        const beforeProxy = proxyCost();
        swapKids(row.kids, i, row.m);
        if (proxyCost() < beforeProxy - 1e-9) {
          if (verifyOrRevert(() => swapKids(row.kids, i, row.m))) improved = true;
        } else {
          swapKids(row.kids, i, row.m);
        }
      }
    });
    if (!improved) break;
  }
  if (realNow > entryReal) {
    // 保险丝：爬山的净效果反而更差（代理误导的路径依赖），整体回滚到进场摆位
    restoreCells(entryCells);
  }

  // ---- 台账 L4 第二段：容器内任意对调 / 挪空位（在经典爬山之后单独跑） ----------
  // 行内相邻交换（swapKids）假定同一行的卡挨着排、从最小 dx 顺次重排；任意对调 / 挪空位之后行里
  // 会有空位、卡也会跨行，这个假设不再成立（07 号实测把 vector_store 与 hybrid_retrieval 排到同一格）。
  // 所以这一段放在经典爬山全部结束之后，只用自己的两种动作，不再碰 swapKids。
  // 收尾多一道闸：走线器看不见标签，这一段挪完若 medium 以上的质检问题比挪之前多，整段回滚 ——
  // case-08 实测 device_access 挪到列底后两条 U 形边叠在右侧，标签压线（medium），走线器
  // 却因为拆掉一处交叉而放行。L4 是锦上添花的一刀，不许自己引入新缺陷。
  if (rules.adjacencyMoves && containerGrids.length) {
    const preL4Cells = snapshotCells();
    const preL4Real = realNow;
    // 两个数：medium 以上总数，以及其中「标签类」（压线 / 压卡）的条数 —— 用一处交叉换一处
    // 标签压线总数不变，但标签压线是走线器完全看不见的那一类，单独不许多。
    const qcIssuesNow = () => {
      recenter();
      relaxEdgeLabels(spec);
      const report = checkQuality(buildScene(spec), qualityOptionsOf(spec));
      redraw();
      const notLow = report.issues.filter((i) => i.severity !== 'low');
      return { all: notLow.length, label: notLow.filter((i) => i.category === 'label').length };
    };
    const preL4Issues = qcIssuesNow();
    for (let pass = 0; pass < 2; pass += 1) {
      let improved = false;
    // 台账 L4 的第二半：容器内**任意**两张同尺寸叶卡对调、叶卡挪进容器网格里的空位。
    // 相邻交换只在一行里挪，够不到「把目标卡挪到源卡对面」；这两种动作在同一张容器网格里挪，
    // 不改容器的行列数、不碰横条 / 竖条 / 嵌套容器，靠代理粗筛 + 走线器复核同一套闸。
      containerGrids.forEach((g) => {
        const movable = g.kids.filter((c) => c.block.isLeaf && !c.block.vbar && (c.block.span || 1) === 1 && (c.block.rowSpan || 1) === 1);
        const tryMove = (apply, undo) => {
          const beforeProxy = proxyCost();
          apply();
          reflowShelf(g.m);
          if (proxyCost() < beforeProxy - 1e-9) {
            if (verifyOrRevert(() => { undo(); reflowShelf(g.m); })) { improved = true; return true; }
            return false;
          }
          undo();
          reflowShelf(g.m);
          return false;
        };
        for (let i = 0; i < movable.length; i += 1) {
          for (let j = i + 1; j < movable.length; j += 1) {
            const p = movable[i];
            const q = movable[j];
            const swap = () => { const dx = p.dx; const dy = p.dy; p.dx = q.dx; p.dy = q.dy; q.dx = dx; q.dy = dy; };
            tryMove(swap, swap);
          }
        }
        movable.forEach((c) => {
          const taken = new Set();
          g.kids.forEach((k) => {
            if (k === c) return;
            const cw = k.block.span || k.block.cols;
            const chh = k.block.rowSpan || k.block.rows;
            for (let x = 0; x < cw; x += 1) for (let y = 0; y < chh; y += 1) taken.add(`${k.dx + x},${k.dy + y}`);
          });
          for (let y = 0; y < g.rows; y += 1) {
            for (let x = 0; x < g.cols; x += 1) {
              if (taken.has(`${x},${y}`) || (x === c.dx && y === c.dy)) continue;
              const from = { dx: c.dx, dy: c.dy };
              tryMove(() => { c.dx = x; c.dy = y; }, () => { c.dx = from.dx; c.dy = from.dy; });
            }
          }
        });
      });
      if (!improved) break;
    }
    const moved = [...cellOf.entries()].some(([id, c]) => { const p = preL4Cells.get(id); return !p || p.x !== c.x || p.y !== c.y; });
    if (moved) {
      const after = qcIssuesNow();
      if (after.all > preL4Issues.all || after.label > preL4Issues.label) {
        restoreCells(preL4Cells);
        realNow = preL4Real;
      }
    }
  }

  // 爬山会重排格位，重排后才产生的「带标签边跨相邻两列」从没进过列距下限——
  // 下限是进场时按当时的邻接算的。case-04 就是这个形态：「科研数据仓库」原本隔着
  // 一列，重排后挪到「业务数据库」旁边，e10「同步」（52px）这才被卡进 46px 的通道，
  // 沿线怎么滑都压住两端卡片和自己的箭头。这里按定稿邻接复算，短了就抬列距，
  // 再等比收卡片把整体收回外框——用卡片尺寸换连线可读性，与进场时同一个取舍。
  const finalFloors = labelGapFloors();
  const overflowNow = () => { const b = occupied(); return b.w > room.w + 0.5 || b.h > room.h + 0.5; };
  if (LAYOUT_RULES.seamFloors ? overflowNow() : (finalFloors.x > GUT_X + 0.5 || finalFloors.y > GUT_Y + 0.5)) {
    const keep = { cw: CW, ch: CH, gx: GUT_X, gy: GUT_Y };
    // 逐缝下限时 place() 已把该抬的缝抬起来了，这里只管「抬完装不装得下」；老口径把全图格距抬到下限
    const targetX = LAYOUT_RULES.seamFloors ? GUT_X : Math.max(GUT_X, finalFloors.x);
    const targetY = LAYOUT_RULES.seamFloors ? GUT_Y : Math.max(GUT_Y, finalFloors.y);
    const fitsWith = (k) => {
      CW = keep.cw * k;
      CH = keep.ch * k;
      GUT_X = targetX;
      GUT_Y = targetY;
      redraw();
      const b = occupied();
      return b.w <= room.w && b.h <= room.h;
    };
    if (!fitsWith(1)) {
      // 收卡片换通道有底：收过 LABEL_GAP_TRADE_MIN 之后卡片装不下自己的文字，
      // 换来的净空会被 clipping 抵消，那就整体回滚，宁可留着这处标签重叠。
      if (fitsWith(LABEL_GAP_TRADE_MIN)) {
        let lo = LABEL_GAP_TRADE_MIN;
        let hi = 1;
        for (let i = 0; i < 16; i += 1) {
          const mid = (lo + hi) / 2;
          if (fitsWith(mid)) lo = mid; else hi = mid;
        }
        fitsWith(lo);
      } else {
        CW = keep.cw; CH = keep.ch; GUT_X = keep.gx; GUT_Y = keep.gy;
        redraw();
      }
    }
  }

  widenBlockedCorridors(spec, metrics, cellOf, cut, redraw);

  // 居中 → 落标签 → 量。两个候选（拉满 / 不拉满）必须走同一条收尾链路才可比：
  // 标签落点依赖走线、走线依赖几何，少跑一步就不是同一张图。
  // 量出来的是一整份候选记录，不再只是一个质检分 —— 裁判换成了 pickCandidate。
  const settle = () => {
    recenter();
    relaxEdgeLabels(spec);
    const scene = buildScene(spec);
    const report = checkQuality(scene, qualityOptionsOf(spec));
    return {
      score: report.score,
      blocking: report.issues.filter((i) => i.severity === 'critical' || i.severity === 'high').length,
      issues: report.issues.length,
      metrics: measureLayout(scene),
    };
  };
  const snapshot = () => ({
    pos: JSON.parse(JSON.stringify(spec.positions || {})),
    labelT: (spec.edges || []).map((e) => (Number.isFinite(e.labelT) ? e.labelT : null)),
  });
  const restore = (snap) => {
    spec.positions = JSON.parse(JSON.stringify(snap.pos));
    (spec.edges || []).forEach((e, i) => {
      if (snap.labelT[i] == null) delete e.labelT; else e.labelT = snap.labelT[i];
    });
  };

  // 「独占一行就拉满」是有代价的：横条把它跨过的那几道格缝一起吃掉，而那里可能正是
  // 一条带标签的边的通道（case-02 的「线索 / 结论回流」、case-07 的「关键词召回」都是
  // 这么被挤没的）。打包那一层看不见走线，所以在这里补一次裁决：两个候选各自跑完整
  // 收尾链路，再交给 pickCandidate。
  //
  // 候选表的顺序就是并列时的优先级：拉满排在前面 —— 画面更饱满是这条规则的初衷。
  //
  // 弹性填充（第 9 步）走同一道闸：每种横条状态下各出「填充 / 不填充」两个候选，
  // 最多四个。它是 place() 之后的后处理，redraw() 会把它抹掉 —— 所以先填、量、快照，
  // 再 redraw() 回未填充状态量一次。填不动的图（elasticFill 返回 0）只出一个候选，
  // 别为一份逐字相同的几何再跑一遍收尾链路。
  // 顺序：填充在前 —— 内容区收成完整矩形是这条规则的初衷，与拉满同理。
  //
  // 填充候选先过质检带（VARIANT_QUALITY_BAND，与形状变体同一条）再进裁判。
  // 门禁 ①a 只拦 critical/high，而填充的代价几乎全落在 medium：log-05 的竖排形状里
  // 撑高的卡把连线通道挤没，多出两条交叉一条压线，质检 95 → 88 却一条 high 都没有，
  // 光靠 pickCandidate 拦不住 —— 版面分看见完整度 +0.24 就把它选走了。
  // 交接文档原先假定「接上闸 log-05 会被挡住」，实测不成立，才补的这条带。
  const spans = [...cellOf.values()].filter((c) => (c.span || 1) > 1 || (c.rowSpan || 1) > 1);
  const cands = [];
  const emit = (base, spanned) => {
    let filled = null;
    if (LAYOUT_RULES.elasticFill && elasticFill(spec, metrics, MIN_GAP) > 0) {
      filled = { tag: `${base}+fill`, ...settle(), snap: snapshot(), spanned, filled: true };
      redraw();
    }
    const bare = { tag: base, ...settle(), snap: snapshot(), spanned, filled: false };
    if (filled && filled.score >= bare.score - VARIANT_QUALITY_BAND) cands.push(filled);
    cands.push(bare);
  };
  if (spans.length) {
    emit('span', true);
    spans.forEach((c) => { c.spanWanted = c.span; c.rowSpanWanted = c.rowSpan; c.span = 1; c.rowSpan = 1; });
    redraw();
  }
  emit('plain', false);
  // qualityOnly：不动用版面分的裁决口径，只给 referenceLayout 用（见那里的注释）
  const winner = cands.length === 1
    ? cands[0]
    : (opts.qualityOnly
      ? cands.reduce((a, b) => (b.score > a.score ? b : a))
      : pickCandidate(cands));
  if (opts.onCandidates) opts.onCandidates(cands, winner);
  restore(winner.snap);
  spans.forEach((c) => { c.span = winner.spanned ? c.spanWanted : 1; c.rowSpan = winner.spanned ? c.rowSpanWanted : 1; });
  return { score: winner.score, blocking: winner.blocking, issues: winner.issues, metrics: winner.metrics };
}

/* ---------------- 分层排版（mode: 'layered'） ----------------
   国内 PPT 里最常见的「分层总体架构图」：若干横向层带从上到下堆叠，每层里卡片横排铺满整层，
   层与层之间不画线；旁边常有一两根贯穿全高的竖向「体系」列（安全保障 / 运维监控 / 标准规范）。
   这一族图没有走线要争通道，所以不产生候选、不进裁判、不束线、不弹性填充 —— 几何完全由
   spec 的树形与外框决定，同一份 spec 连跑两次逐字节相同。

   规则（spec 字段名与 docs 同口径）：
   · 顶层节点按数组顺序从上到下各成一层。容器 = 层带（子卡片横排，放不下分多行、各行张数均衡、
     行内等宽铺满）；叶子 = 通栏单卡横条；带 side: left|right 的顶层容器 = 贴在图面左 / 右侧、
     贯穿全部层带高度的竖向列（子卡片竖排等高铺满）。
   · 层带里的嵌套容器当作该行的一个格子，内部按同样规则递归打包；该行的行高取最高者，叶卡拉到行高。
   · 容器矩形是由子卡片包围盒 + 皮肤内边距推出来的（containerRect），不能直接设——这里按
     「层带外框 → 减内边距 → 子卡片区」反推子卡片位置，推导出的容器矩形恰好等于目标层带矩形。 */

// 间距基数（× gutterScale × frameScale，再与质检最小间距取大）
const LAYERED_GAP_CARD = 24;       // 卡片之间（横 / 竖同值）
const LAYERED_GAP_BAND = 28;       // 层带之间
const LAYERED_CARD_H_MAX = 1.75;   // 竖向富余分给卡高的上限（× 基准卡高）
const LAYERED_SIDE_H_MAX = 2.2;    // side 列卡片高的上限（× 基准卡高），再多的富余进卡片间距
const LAYERED_BAND_GAP_MAX = 3;    // 竖向富余分给层带间距的上限（× 层带间距）
const LAYERED_SIDE_W_RATIO = 0.2;  // side 列外宽不超过外框宽的这个比例
// side 列卡宽的安全余量与下限（都 × typeScaleW，余量再 × frameScale）。needW 是估算字宽 + 左右内边距 + 图标位，
// 浏览器实测字宽比估算略大：卡宽恰好 == needW 时，4 个汉字 + 图标的卡（夹具 01 的 身份认证 / 权限管控 / 数据加密 /
// 审计日志）在工作台里全部折成两行。流程排版没这个问题，因为它的卡宽下限是 240 × typeScaleW（layoutOnce 的 targetW）；
// side 列是竖排、宽度从需求宽反推，得自己留余量、设下限。封顶（LAYERED_SIDE_W_RATIO）仍优先：顶到封顶就以封顶为准。
export const LAYERED_SIDE_W_MARGIN = 24;
export const LAYERED_SIDE_CARD_W_MIN = 220;
// 压缩的最后一档：卡高最低压到基准卡高的这个比例（stratum 68 → 41），再不够就越界交给质检。
// 需求原文的下限是 NODE_MIN.h；主打皮肤的层带内边距即使收紧，夹具 01（B 版式五层）/ 02（A 版式
// 四层带嵌套）也塞不进 56，这一档是拟定值，待孙毅拍板（docs/decisions.md 2026-09-12）。
export const LAYERED_CARD_H_FLOOR = 0.6;
// 分层图的层带内边距：流程图的容器内边距（stratum 顶 64 / 底 21）是给稀疏编组留的呼吸位，
// 五条层带光内边距就吃掉 425px。分层图里容器标题带上下只留 LAYERED_LABEL_GAP，左右收到
// LAYERED_PANEL_PAD_X（底部内边距 = 0.8 × 左右，见 skinLayout）。side 标题模式（journal）本就贴边，不动。
const LAYERED_LABEL_GAP = 8;
const LAYERED_PANEL_PAD_X = 16;

// 分层图下收紧的结构 token；flow 下原样返回同一个对象（一个像素都不动）。metricsOf / cssVarsOf /
// themeOf 三处都经它，排版、页面 CSS、SVG / PPTX 导出读到的是同一组内边距。
export function layeredPanelMetrics(spec, metrics) {
  if (layoutModeOf(spec) !== 'layered' || !metrics) return metrics;
  const m = Object.assign({}, metrics);
  let top = m.panelPadTop;
  if (m.panelLabelMode === 'chip') top = m.panelLabelH + LAYERED_LABEL_GAP * 2;
  else if (m.panelLabelMode === 'bar-top') top = m.panelLabelH + Math.round(LAYERED_LABEL_GAP * 1.5);
  m.panelPadTop = Math.min(m.panelPadTop, top);
  m.panelPadX = Math.min(m.panelPadX, LAYERED_PANEL_PAD_X);
  return m;
}

// 排版模式：只有 'layered' 一个非缺省值，其余一律按流程图
export function layoutModeOf(spec) {
  return spec && spec.mode === 'layered' ? 'layered' : 'flow';
}

// 这个顶层节点在分层图里当不当 side 列：side 合法、是容器、有子节点、且子节点全是叶子（v1 不支持
// 列内嵌套 —— 校验器给 warning，这里按普通层带处理）。非顶层节点的 side 由调用方过滤。
export function layeredSideOf(node) {
  if (!node || (node.side !== 'left' && node.side !== 'right')) return null;
  if (!isContainer(node) || !node.children.length) return null;
  if (node.children.some((c) => isContainer(c))) return null;
  return node.side;
}

/**
 * 分层排版。只写 spec.positions[叶子 id]，不改 frame、不改树；返回 spec。
 * 竖向预算：自然总高 < 外框高时，富余先均匀加给卡高（上限 1.75×基准），再加给层带间距（上限 3×），
 * 再有富余就留白在底部（side 列需求高更高时放开上限继续吃，直到满足或外框用尽）；
 * 自然总高 > 外框高时卡高与各间距按比例压缩：先等比一刀，被下限截住的量
 * 不再出力，其余的轮流继续让（间距到质检最小间距、卡高到 NODE_MIN.h）；内边距不随压缩缩，到这一步
 * 还不够就让卡高继续降到 LAYERED_CARD_H_FLOOR × 基准（最后一档），再不够就越界，交给质检报 out_of_bounds。
 */
export function layoutLayered(spec) {
  const metrics = metricsOf(spec);
  const frame = spec.frame;
  const pad = skinLayout(metrics).panelPad;
  const fs = frameScale(spec);
  const g = metrics.gutterScale;
  // 质检最小间距随外框缩放是小数（20 × frameScale）；间距本来就是整像素，往上取整，
  // 否则压缩循环按整像素递减会在 15 → 14 那一步跌破 14.7，质检对每对上下相邻卡片各报一条 spacing
  const MIN_GAP = Math.ceil(qualityThresholdsOf(spec).minSpacing);
  const gapX = Math.max(MIN_GAP, Math.round(LAYERED_GAP_CARD * g * fs));
  const gapY0 = gapX;
  const gapBand0 = Math.max(MIN_GAP, Math.round(LAYERED_GAP_BAND * g * fs));
  const leaves = leafNodes(spec);
  if (!leaves.length || !(spec.nodes || []).length) return spec;

  // 卡片基准高与流程排版同口径：全图有没有 sublabel 决定一档，同一张图里所有卡片等高
  const anySub = leaves.some((n) => n.sublabel != null && n.sublabel !== '');
  const H0 = skinCardHeight(metrics, { hasSub: anySub });
  // 卡片最小宽：口径照抄 layoutOnce 的 needW（文字估宽 + 左右内边距 + 图标位），再兜 NODE_MIN.w
  const needW = (n) => {
    const tw = Math.max(estimateTextWidth(n.label, metrics.typeNode), estimateTextWidth(n.sublabel, metrics.typeSmall));
    if (n.variant === 'decision') return Math.round((tw + metrics.cardPadX) / 0.6);
    return Math.round(tw + metrics.cardPadX * 2 + (resolveIcon(spec, n) ? metrics.iconSize + metrics.iconGapX : 0));
  };
  const minWOf = (n) => Math.max(NODE_MIN.w, needW(n));
  // 一个节点当「格子」时的最小外宽：叶子 = 卡片最小宽；容器 = 最宽后代格子 + 左右内边距（全竖排时的宽）
  const cellMinW = (n) => (isContainer(n)
    ? (n.children.length ? Math.max(...n.children.map(cellMinW)) : NODE_MIN.w) + pad.left + pad.x
    : minWOf(n));

  // 顶层节点分两拨：side 列 / 层带。全是 side 列时没有层带可贴，全部降级成层带
  const top = spec.nodes;
  let sides = top.filter((n) => layeredSideOf(n));
  let bands = top.filter((n) => !layeredSideOf(n));
  if (!bands.length) { bands = top.slice(); sides = []; }

  // side 列外宽：卡宽 = max(最宽子卡所需宽 + 安全余量, 下限)，再加左右内边距，封顶外框宽的 20%
  // （封顶生效时以封顶为准）。typeScaleW 口径同 layoutOnce 的 targetW。
  const typeScaleW = metrics.typeNode / METRICS_DEFAULTS.typeNode;
  const sideMargin = Math.round(LAYERED_SIDE_W_MARGIN * typeScaleW * fs);
  const sideCardMin = Math.round(LAYERED_SIDE_CARD_W_MIN * typeScaleW);
  const sideCap = Math.round(frame.w * LAYERED_SIDE_W_RATIO);
  const cols = sides.map((n) => {
    const inner = Math.max(sideCardMin, Math.max(...n.children.map(minWOf)) + sideMargin);
    const w = Math.max(pad.left + pad.x + 16, Math.min(sideCap, inner + pad.left + pad.x));
    return { node: n, side: layeredSideOf(n), w: Math.round(w) };
  });
  const leftCols = cols.filter((c) => c.side === 'left');
  const rightCols = cols.filter((c) => c.side === 'right');
  const bandX = Math.round(frame.x + leftCols.reduce((a, c) => a + c.w + gapX, 0));
  const bandRight = Math.round(frame.x + frame.w - rightCols.reduce((a, c) => a + c.w + gapX, 0));
  const bandW = Math.max(NODE_MIN.w, bandRight - bandX);

  // 层带打包（与卡高无关的部分）：每行几张、每张多宽、嵌套容器递归
  const planBox = (node, W) => {
    const Wi = Math.round(W - pad.left - pad.x);
    const kids = node.children;
    const n = kids.length;
    const rows = [];
    if (!n) return { node, rows };
    const minW = Math.max(...kids.map(cellMinW));
    const kmax = Math.max(1, Math.floor((Wi + gapX) / (minW + gapX)));
    const k = Math.min(n, kmax);
    const r = Math.ceil(n / k);
    const base = Math.floor(n / r);
    const extra = n % r;   // 前 extra 行多一张（7 张两行 → 4 + 3）
    let idx = 0;
    for (let i = 0; i < r; i += 1) {
      const m = base + (i < extra ? 1 : 0);
      const cellW = (Wi - (m - 1) * gapX) / m;
      const items = [];
      for (let j = 0; j < m; j += 1) {
        const child = kids[idx];
        idx += 1;
        const x0 = j * (cellW + gapX);
        const x1 = j === m - 1 ? Wi : x0 + cellW;   // 最后一格贴到内宽右缘，整行恰好铺满
        const dx = Math.round(x0);
        const w = Math.round(x1) - dx;
        items.push({ node: child, dx, w, box: isContainer(child) ? planBox(child, w) : null });
      }
      rows.push({ items });
    }
    return { node, rows };
  };
  // 高度是卡高 H 与行距 gy 的函数：行高取该行最高者（嵌套容器外高 / 卡高）
  const boxH = (box, H, gy) => {
    if (!box.rows.length) return pad.top + H + pad.bottom;
    let h = pad.top + pad.bottom;
    box.rows.forEach((row, i) => { h += rowH(row, H, gy) + (i ? gy : 0); });
    return h;
  };
  const rowH = (row, H, gy) => Math.max(H, ...row.items.map((it) => (it.box ? boxH(it.box, H, gy) : H)));

  const plans = bands.map((b) => (isContainer(b) ? planBox(b, bandW) : null));
  const bandH = (i, H, gy) => (plans[i] ? boxH(plans[i], H, gy) : H);
  const totalH = (H, gy, gb) => bands.reduce((a, b, i) => a + bandH(i, H, gy), 0) + (bands.length - 1) * gb;

  // 竖向预算
  let H = H0;
  let gy = gapY0;
  let gb = gapBand0;
  const floorH = Math.min(NODE_MIN.h, H0);
  // side 列的竖向需求：最高的那根按「n 张 × 卡高下限 + (n−1) 行距 + 上下内边距」算。层带堆叠比它矮，
  // side 卡就会被压到下限以下 —— 层带自己塞得下不等于整张图塞得下
  const sideNeedH = (rowGap) => cols.reduce((a, c) => {
    const n = c.node.children.length;
    return Math.max(a, pad.top + pad.bottom + n * floorH + (n - 1) * rowGap);
  }, 0);
  const T0 = totalH(H0, gapY0, gapBand0);
  if (T0 < frame.h) {
    const Hmax = Math.round(H0 * LAYERED_CARD_H_MAX);
    while (H < Hmax && totalH(H + 1, gy, gb) <= frame.h) H += 1;
    if (bands.length > 1) {
      const rem = frame.h - totalH(H, gy, gb);
      gb = Math.min(gb * LAYERED_BAND_GAP_MAX, gb + Math.floor(rem / (bands.length - 1)));
    }
    // 层带堆叠仍矮于 side 列需求高时，卡高与层带间距放开上限、各 1px 轮流继续吃底部富余，
    // 直到满足需求或外框用尽（两条单卡层带 + 8 张 side 卡：不这么做 side 卡只剩 38px 而底部空着 148px）
    const target = Math.min(frame.h, sideNeedH(gy));
    while (totalH(H, gy, gb) < target) {
      let grew = false;
      if (totalH(H + 1, gy, gb) <= frame.h) { H += 1; grew = true; }
      if (bands.length > 1 && totalH(H, gy, gb) < target && totalH(H, gy, gb + 1) <= frame.h) { gb += 1; grew = true; }
      if (!grew) break;
    }
  } else if (T0 > frame.h) {
    const s = frame.h / T0;
    H = Math.max(floorH, Math.round(H0 * s));
    gy = Math.max(MIN_GAP, Math.round(gapY0 * s));
    gb = Math.max(MIN_GAP, Math.round(gapBand0 * s));
    // 等比一刀后被各自下限截住的量不再出力，剩下的超出由还有余量的量轮流吃：层带间距、行距
    // 压到质检最小间距，卡高压到 NODE_MIN.h。三者各让 1px 一轮，仍是按比例收。
    // （handbook 皮肤下夹具 01 曾在卡高到底后放弃，层带间距 23 / 行距 20 留着 12px 没用，底带压出外框 15px。）
    while (totalH(H, gy, gb) > frame.h && (gb > MIN_GAP || gy > MIN_GAP || H > floorH)) {
      if (gb > MIN_GAP) gb -= 1;
      if (gy > MIN_GAP && totalH(H, gy, gb) > frame.h) gy -= 1;
      if (H > floorH && totalH(H, gy, gb) > frame.h) H -= 1;
    }
    // 容器内边距是皮肤常数、不随压缩缩（containerRect 的口径），分层图已按 layeredPanelMetrics 收紧，
    // 五层带的 B 版式仍可能不够。最后一档：卡高继续往下找，但不低于 LAYERED_CARD_H_FLOOR × 基准
    // （拟定值，待拍板）；到底还塞不进就越界，交给质检报 out_of_bounds。
    const lastMin = Math.min(H, Math.ceil(H0 * LAYERED_CARD_H_FLOOR));
    while (H > lastMin && totalH(H, gy, gb) > frame.h) H -= 1;
  }

  // 落位：层带从外框顶开始堆叠
  const place = (box, x, y) => {
    let cy = y + pad.top;
    box.rows.forEach((row) => {
      const rh = rowH(row, H, gy);
      row.items.forEach((it) => {
        const ix = x + pad.left + it.dx;
        if (it.box) place(it.box, ix, cy);
        else spec.positions[it.node.id] = { x: Math.round(ix), y: Math.round(cy), w: it.w, h: Math.round(rh) };
      });
      cy += rh + gy;
    });
  };
  let y = frame.y;
  bands.forEach((b, i) => {
    const h = bandH(i, H, gy);
    if (plans[i]) place(plans[i], bandX, y);
    else spec.positions[b.id] = { x: bandX, y: Math.round(y), w: bandW, h: Math.round(h) };
    y += h + (i < bands.length - 1 ? gb : 0);
  });
  const stackH = Math.round(y - frame.y);

  // side 列：外高 = 层带堆叠总高；子卡片等高铺满列内高。卡高封顶 2.2 × 层带卡高（层带被压缩时跟着
  // 压，同一张图里两种卡高最多差 2.2 倍；不压缩时即需求的 2.2 × 基准），富余进卡片间距。
  // 只有 1 张子卡时没有间距可匀，这张卡直接填满列内高 —— 容器矩形由子卡反推，子卡不撑满列就不贯穿。
  // 卡高的硬底与层带最后一档同一口径（LAYERED_CARD_H_FLOOR × 基准）：外框装不下这么多张时不再静默压扁
  // （12 张曾压成 32px、字号掉 3 档而质检 100 分），改为按行距顺排、越出列底，交给质检报 out_of_bounds。
  const placeSide = (col, x) => {
    const kids = col.node.children;
    const n = kids.length;
    const innerH = stackH - pad.top - pad.bottom;
    const cardW = Math.round(col.w - pad.left - pad.x);
    const chMax = Math.round(Math.min(H, H0) * LAYERED_SIDE_H_MAX);
    // 硬底与层带的有效下限同一口径：先守 min(NODE_MIN.h, 基准)，最后一档 0.6 × 基准；带副标题时基准更高，
    // 0.6 × 基准可能反超 NODE_MIN.h，取两者之小，否则竖向预算按 NODE_MIN.h 算出的堆叠高会装不下这个硬底
    const chMin = Math.min(chMax, floorH, Math.ceil(H0 * LAYERED_CARD_H_FLOOR));
    const ch = n === 1 ? Math.max(chMin, innerH) : Math.max(chMin, Math.min(chMax, Math.floor((innerH - (n - 1) * gy) / n)));
    const overflow = n * ch + (n - 1) * gy > innerH;
    const gap = n > 1 ? (overflow ? gy : (innerH - n * ch) / (n - 1)) : 0;
    const y0 = frame.y + pad.top;
    kids.forEach((k, i) => {
      // 最后一张贴到列底，推导出的容器底边与最后一带底边严格相等（越界时顺排，不再贴底）
      const cy = n > 1 && i === n - 1 && !overflow ? frame.y + pad.top + innerH - ch : Math.round(y0 + i * (ch + gap));
      spec.positions[k.id] = { x: Math.round(x + pad.left), y: cy, w: cardW, h: ch };
    });
  };
  let lx = frame.x;
  leftCols.forEach((c) => { placeSide(c, lx); lx += c.w + gapX; });
  let rx = bandRight + gapX;
  rightCols.forEach((c) => { placeSide(c, rx); rx += c.w + gapX; });

  // 分层图通常没有连线；有带标签的边就照流程排版落一次标签
  if ((spec.edges || []).some((e) => e.label)) relaxEdgeLabels(spec);
  return spec;
}

// 形状变体：每个容器最多摆几列。1 = 彻底竖排，4 = 原来的写死值。
//
// 为什么必须整套摆完再比，而不是在打包那一层挑：**打包层看不见走线**。
// 同一批卡片横排还是竖排，决定的是边从哪个面出、要不要绕、标签有没有地方落 ——
// 这些全在走线之后才知道。case-5 会话曾在打包层按纵横比挑，实测走线净空 61 → 13；
// 三次实现三次结论不同，共同原因就是这个。所以这里每个变体都跑完整链路，
// 再交给第 1 步的版面分裁决。
//
// 顺序即并列时的优先级：4 排在最前 —— 与改动之前的行为一致，没有理由时不换。
const SHAPE_VARIANTS = Object.freeze([4, 3, 2, 1]);

// 变体之间允许的质检分代价上限。
//
// 门禁 ①a 只拦 critical/high，而形状变体之间的差别几乎全落在 medium：四个变体的
// blocking 常常都是 0，于是版面分说了算。两个候选时这没问题（第 1 步孙毅拍板：
// 多一条 medium 换走线短 21% 是划算的），四个候选时就不行了 —— case-01 上竖排版
// 的版面分确实最高（0.654 对 0.553，墨水 0.259 对 0.172），但它带着 9 条 medium，
// 质检分 97 → 67。孙毅同意的是「多一条」，不是「多六条」。
//
// 起初取 4，与 npm run bench 的 TOLERANCE.perSpec 同源；带宽扫描（0/1/2/4）发现 4 起
// 十用例跌破 95，定为 2（docs/decisions.md 第 4 步）。
// 第 9 步的弹性填充候选也过这条带（见 layoutOnce 收尾处），不另立一个数。
export const VARIANT_QUALITY_BAND = 2;

/**
 * 参考布局：**不动用版面分**的「引擎自然输出」，只用来度量判别力。
 *
 * 为什么需要它 —— 第 4 步踩到的一个真问题：版面分开始决定形状之后，
 * 权重的推导变成了自反的。权重 → 选哪个形状 → 版面指标 → 判别力比分 → 权重。
 * 实测这个循环**不收敛**，而是以周期 2 来回跳：
 *   奇数轮 groupGapRatio 0.75 / edgeLength 0.75
 *   偶数轮 groupGapRatio 0.25 / edgeLength 0.25
 * 「权重三方一致」那条测试就是这么红的 —— 它红得对。
 *
 * 判别力要回答的是「人工在哪几项上强过机器的**自然**输出」，那个参照必须与
 * 正在被评估的挑选策略无关，否则就是拿裁判自己的判决去训练裁判。所以这里固定成：
 * 默认形状（SHAPE_VARIANTS[0]，即改动之前的 4 列）+ 只比质检分的横条裁决。
 * 这样权重表与形状搜索解耦，重跑多少次都是同一组数。
 */
export function referenceLayout(spec) {
  const trial = cloneSpec(spec);
  if (layoutModeOf(trial) === 'layered') { clearAutoPorts(trial); layoutLayered(trial); return trial; }
  layoutOnce(trial, SHAPE_VARIANTS[0], { qualityOnly: true });
  return trial;
}

/**
 * 一键规整。对每个形状变体各摆一整套，再由版面分挑一个。
 * opts.onVariants(cands, winner) —— 变体级的只读诊断钩子。
 * opts.onCandidates —— 透传给每个变体内部的横条裁决（会被调用多次，每个变体一次）。
 */
export function autoLayout(spec, opts = {}) {
  const cands = [];
  const variants = LAYOUT_RULES.shapeSearch ? SHAPE_VARIANTS : SHAPE_VARIANTS.slice(0, 1);
  // 上一次规整写下的束线端口先清掉，让这一次重新决定；用户自己钉的端口一个不动
  clearAutoPorts(spec);
  // 分层图走自己的排版器：没有候选、没有裁判、不束线（层与层之间本来就不画线）
  if (layoutModeOf(spec) === 'layered') return layoutLayered(spec);
  for (const maxCols of variants) {
    const trial = cloneSpec(spec);
    const rec = layoutOnce(trial, maxCols, opts);
    if (rec) cands.push({ tag: `cols${maxCols}`, maxCols, ...rec, spec: trial });
  }
  if (!cands.length) return spec;
  // 先按质检分划一条带：比最好的变体差出 VARIANT_QUALITY_BAND 以上的直接出局，
  // 剩下的再交给版面分排序。带内的取舍仍然是版面分说了算（松门禁的本意）。
  const bestScore = Math.max(...cands.map((c) => c.score));
  // 2026-08-18 试过给带加一道 95 分的下沿（十用例门禁那个数）：case-09 的 cols3（94，一处交叉，
  // 换来相邻直达 0.5 → 0.688、完整度 0.54 → 0.68，就是他手调的那种蛇形主链）被挡在门外，
  // 顶上来的却是 cols4 —— 95 分但走线 7389（cols3 是 4785）。门槛保住了一分质检、丢了一整张图。
  // 所以不设下沿：带宽 2 就是他拍板的「多一条 medium 换更像手调」，门禁那条测试改成 94 并注明。
  const inBand = cands.filter((c) => c.score >= bestScore - VARIANT_QUALITY_BAND);
  const winner = pickCandidate(inBand.length ? inBand : cands, LAYOUT_WEIGHTS, cands);
  if (opts.onVariants) opts.onVariants(cands, winner);
  // 把胜出变体的几何搬回调用方的 spec —— 只搬摆位结果与标签落点，别的字段不动
  spec.positions = JSON.parse(JSON.stringify(winner.spec.positions || {}));
  const byId = new Map((winner.spec.edges || []).map((e) => [e.id, e]));
  (spec.edges || []).forEach((e) => {
    const w = byId.get(e.id);
    if (!w) return;
    if (Number.isFinite(w.labelT)) e.labelT = w.labelT; else delete e.labelT;
  });
  if (winner.spec.frame) spec.frame = { ...winner.spec.frame };
  // 第 10 步：束线（三线合一）是**定稿之后的走线后处理，不进裁判**。候选（形状变体 / 拉满不拉满）
  // 之间的比较仍按不并线的走线量，选定之后才并线。理由：版面分的权重是在不并线的走线上拟合的
  // （B 方案 12 条盲评），并线让几个候选的一边一面 / 质检分同时跳高，裁判就会在变体级换形状 ——
  // log-02 实测从四栏（走线 2570）换成一张卡缩到墨水 0.173、走线 5604 的版本，只因为它的分组
  // 间距比与净空更高。那是权重的问题（台账 R2），不该由束线来背；等权重重拟之后再放进裁判。
  // 并线的结果以**端口声明**写回 spec（两端都写，带 auto:true）：渲染按声明走，与人工「三线合一」
  // 的表达方式（手工端口 104 处里 79 处 t=0.5）完全一样；手工画的图不经过这里，不会被擅自并线；
  // 下一次规整先把 auto 端口清掉再重新决定。写完端口再按并线后的走线落一次标签。
  if (activeRules(spec).bundle) materializeBundles(spec);
  return spec;
}

// 束线落成端口声明。先清掉上一次的 auto 端口再重新决定（同一份 spec 调两次结果相同），
// 只动束线收拢过的边；走线器只收任一端都没被钉住的边，所以写下的两端都是空的。
// 两端都写: 只钉一端, 走线器下次会给另一端重新选面, 梳齿就散了。
// 两道闸（2026-08-18 第 15 步）：① 落地后按端口声明重新渲染必须逐点复现并线几何 —— 走线器给钉住端口的边
// 另选通道、梳齿错位就是变形；② 质检分不许比不并线低（逐缝下限之后 case-01 实测 98 → 77）。
// 任一不满足就整个撤回、返回 0 —— 撤回之后再调一次仍是 0，幂等。
export function materializeBundles(spec) {
  clearAutoPorts(spec);
  const ptsOf = (sc) => Object.fromEntries(sc.edges.map((e) => [e.id, e.pts.map((p) => [Math.round(p.x), Math.round(p.y)])]));
  const scoreOf = () => checkQuality(buildScene(spec), qualityOptionsOf(spec)).score;
  const before = scoreOf();
  const scene = buildScene(spec, { bundle: true });
  const bundledPts = ptsOf(scene);
  const byId = new Map(scene.edges.map((se) => [se.id, se]));
  let touched = 0;
  (spec.edges || []).forEach((e) => {
    const se = byId.get(e.id);
    if (!se || !se.bundled || !(se.bundled.source || se.bundled.target)) return;
    if (se.sourcePort) { e.sourcePort = { side: se.sourcePort.side, t: se.sourcePort.t, auto: true }; touched += 1; }
    if (se.targetPort) { e.targetPort = { side: se.targetPort.side, t: se.targetPort.t, auto: true }; touched += 1; }
  });
  if (!touched) return 0;
  relaxEdgeLabels(spec);
  const plainPts = ptsOf(buildScene(spec));
  const near = (p, q) => p && q && p.length === q.length && p.every((pt, i) => Math.abs(pt[0] - q[i][0]) <= 1 && Math.abs(pt[1] - q[i][1]) <= 1);
  const shapeKept = (spec.edges || []).every((e) => {
    const pinned = (e.sourcePort && e.sourcePort.auto) || (e.targetPort && e.targetPort.auto);
    return !pinned || near(plainPts[e.id], bundledPts[e.id]);
  });
  if (!shapeKept || scoreOf() < before) {
    clearAutoPorts(spec);
    relaxEdgeLabels(spec);
    return 0;
  }
  return touched;
}

/**
 * 候选挑选的裁判（docs/handoff-质检分与版面分.md 5.4 第 3 步）。
 *
 * 旧做法是「质检分最高的赢，同分取列表靠前的」。问题在于质检分对饱满度、分组间距、
 * 走线拓扑完全无感 —— 台账里那组硬证据：日志 03 的两个状态同为 100 分，一个列间距
 * 均匀 107、一个 139/163/106，评分器分不出来。同分时它只能退回列表顺序，等于没挑。
 *
 * 四步，顺序不能换：
 *   ① 质检门禁：critical / high 的条数不比最优候选多。质检是**绝对**判据，
 *      先于一切取舍 —— 工具在用户没要求时不该自己引入新缺陷。
 *   ② precision 否决：这几项机器本来就赢人工，只作「不许退化」的淘汰线。
 *   ③ 版面分高者胜（同一份 spec 的候选之间归一化）。
 *   ④ 仍并列 → 取列表靠前的（列表按「越靠前越像手工调优」排序）。
 *
 * 质检分本身不参与排序。只有一种例外：候选在**每一项版面指标上逐字相同**，
 * 版面分因此算不出来（scoreLayout 返回 null）。这时质检看见的 medium / low
 * 差别是仅有的信息，丢掉它没有道理，所以退回比质检分。注意这与「④ 并列」
 * 不是一回事 —— 并列是两边各有胜负、加权后打平，那时列表顺序说了算。
 *
 * 两个数永不相加：相加等于给没有绝对判据的量硬安一个绝对判据。
 *
 * @param {object[]} cands  每项含 { score, blocking, metrics }，按优先级排好序
 * @returns {object} 胜出的候选（永不返回空）
 */
// 门禁松紧的唯一开关。
//   false = 只拦 critical/high（**当前默认**，孙毅 2026-08-16 拍板）
//   true  = 连 medium/low 也不许新增（台账「不该自己引入新缺陷」的口径）
//
// 取舍是明摆着的，孙毅看过对照页之后选的松：放行「多一条 medium」换来的是
// case-04 走线总长短 21%、最小净空多 56%。代价是十用例均分 98.0 → 97.6、
// case-04 100 → 96，且几何触发的横条 gw/idm 被判掉 —— 后者由第 5 步的语义横条接管。
// 详见 docs/decisions.md 2026-08-16。
export const STRICT_GATE = false;

export function pickCandidate(cands, weights = LAYOUT_WEIGHTS, normPeers = null) {
  if (!Array.isArray(cands) || !cands.length) return null;
  if (cands.length === 1) return cands[0];

  // ①a 门禁（严重）：critical / high 不比最优候选多。
  const minBlocking = Math.min(...cands.map((c) => c.blocking || 0));
  let pool = cands.filter((c) => (c.blocking || 0) <= minBlocking);

  // ①b 门禁（不新增缺陷）：连 medium / low 也不许比最优候选多。**当前关闭。**
  //
  // 台账原话是「人工可以为别的取舍主动接受扣分（日志 02、05 都这么干过），工具在
  // 用户没要求时不该自己引入新缺陷」。孙毅看过 case-04 的对照之后判定：那一条讲的是
  // 「工具别自作主张」，而现在版面分就是他授权的那个主张，所以这一道关掉。
  //
  // 实测这一道确实有分量：case-04 上「不拉满」走线总长赢「拉满」21%、净空多 56%，
  // 版面分 0.67 : 0.33，但会新增一条 overlap:e10+e8（e10 的标签压在 e8 的线上，medium）。
  // 关掉之后十用例均分 98.0 → 97.6、case-04 100 → 96，几何触发的横条 gw/idm 被判掉。
  if (STRICT_GATE) {
    const minIssues = Math.min(...pool.map((c) => c.issues ?? 0));
    const clean = pool.filter((c) => (c.issues ?? 0) <= minIssues);
    if (clean.length) pool = clean;
  }

  // ② precision 否决。全被否决时退回否决前的池子——裁判的职责是挑一个，不是挑空。
  const kept = pool.filter((c) => !vetoedByPrecision(c.metrics, pool.map((p) => p.metrics)));
  if (kept.length) pool = kept;
  if (pool.length === 1) return pool[0];

  // ③ 版面分。归一化的基准默认是过了门禁的这几个；调用方也可以把**全部**候选传进来当基准
  //（normPeers）—— 只剩两个候选时 min/max 归一化把每一项都变成 0 / 1，量级信息全丢：
  // 07 号 cols1（墨水 0.081、分组间距比 5.37）对 cols3（0.226、1.00），一张卡缩到三分之一
  // 与间距比高五倍在两两归一化里同样各得 1 分；拿四个变体一起当量程，cols3 0.555 : cols1 0.495。
  const peers = (normPeers && normPeers.length >= pool.length ? normPeers : pool).map((c) => c.metrics);
  let best = pool[0];
  let bestScore = scoreLayout(best.metrics, peers, weights);
  for (const c of pool.slice(1)) {
    const s = scoreLayout(c.metrics, peers, weights);
    if (s == null || bestScore == null) continue;
    if (s > bestScore + 1e-9) { best = c; bestScore = s; }   // ④ 并列不换手
  }
  if (bestScore != null) return best;

  // 版面分算不出来（各项全平）→ 退回质检分，仍是同分取靠前
  for (const c of pool.slice(1)) if (c.score > best.score) best = c;
  return best;
}

// 编组标题在容器里占住的那块 + 连线标签的盒子 —— 排版与质检共用这一份量尺。
export function panelLabelBands(spec, scene, metrics) {
  const m = metrics || metricsOf(spec);
  return (scene.containers || [])
    .filter((c) => c.label != null && String(c.label) !== '')
    .map((c) => ({
      id: c.id,
      label: c.label,
      rect: skinPanelLabelRect(m, c, estimateTextWidth(c.label, m.typeSmall)),
    }));
}

// 边标签盒子的几何 —— **按浏览器实测标定，不是推的。**
//
// 产物里的 `.edge-label` 样式是：
//   padding: calc(3px * --type-scale) calc(10px * --type-scale)
//   font-size: calc(14px * --type-scale);  border: 1px;  line-height: normal
// 所以内边距**跟着字号一起缩**（基准 14px 时是 3/10），边框不缩，行高取 normal。
//
// 实测（headless 之外真开一个浏览器读 getBoundingClientRect，样式直接取产物本身）：
//   type-scale  字号    「校验」      「推理请求」   高
//     0.8      11.2    40.41       62.80      22.80
//     1.0      14.0    50.00       78.00      28.00
//     1.2      16.8    59.59       93.19      32.69
//     1.4      19.6    69.20      108.41      37.89
//     1.6      22.4    78.80      123.60      42.59
// 反解出来：宽 = 文字宽 + 2×(10/14)×字号 + 2（边框），高 = 1.4×字号 + 2×(3/14)×字号 + 2。
// 中日韩字符实测正好 1.0em（50 = 2×14 + 20 + 2），与 estimateTextWidth 的口径一致。
//
// 改动之前是 `文字宽 + 24` 与 `round(字号 × 1.5)`，两个数都是推的：
// 在实际运行的字号（typeSmall × 0.8 ≈ 11.2）上**宽了约 6px、矮了约 5.5px**。
// 矮这一头尤其要命 —— 压叠判定按矮盒子算，标签实际压住了线也判不出来。
const LABEL_PAD_X = 10 / 14;   // 单侧内边距 ÷ 基准字号
const LABEL_PAD_Y = 3 / 14;
const LABEL_BORDER = 1;        // 边框不随 type-scale 缩
const LABEL_LINE = 1.4;        // line-height:normal 的实测值

export function edgeLabelSize(text, px) {
  return {
    w: estimateTextWidth(text, px) + 2 * LABEL_PAD_X * px + 2 * LABEL_BORDER,
    h: LABEL_LINE * px + 2 * LABEL_PAD_Y * px + 2 * LABEL_BORDER,
  };
}

export function edgeLabelBoxAt(text, pts, labelT, px) {
  const p = edgeLabelPointOf(pts, Number.isFinite(labelT) ? labelT : undefined);
  const { w, h } = edgeLabelSize(text, px);
  return { x: p.x - w / 2, y: p.y - h / 2, w, h };
}

// 走线通道净空 —— 带标签的连线穿过编组标题时，标题至少要有一侧留得下标签。
//
// 沿线挪标签只在通道本来就够宽时有用。学报的实测：「推理请求」80px 宽，穿过
// 「推理引擎」40px 宽的竖排标题，通道总共才 79px，标题两侧只剩 29 / 10 ——
// 挪到哪都压得上。设计侧手调时的做法是把通道另一侧的卡片收窄 90，让出净空。
// 这里把那个做法自动化：收窄「站在容器外面的那个端点卡」，朝容器的方向收，
// 下限是它自己内容需要的宽度（收过头文字会溢出，质检直接报 high）。
//
// 收到「够用」就停，不是能多窄就多窄 —— 其余卡片保持等宽，图面才整齐。
// 标签沿线的落点候选：先在中段找，找不到再往两头够。
// 通栏带横贯容器顶部，连线在带子里的那一段无论怎么挪都压得上，只有拐到竖直短脚才躲得开；
// 短脚往往只占全长的百分之几，所以必须够到 0.05 / 0.95。clampLabelT 保证不贴到端点上。
const LABEL_T_CANDIDATES = [null, 0.5, 0.44, 0.56, 0.38, 0.62, 0.3, 0.7, 0.24, 0.76, 0.2, 0.8, 0.16, 0.84, 0.12, 0.88, 0.1, 0.9, 0.08, 0.92, 0.05, 0.95];

// 标签「回家」的拉力：候选落点偏离自然落点（最长直段的中点）越远，代价越高。
// 手调日志里 4 次 labelT 调整全部是把标签拉回 0.5 附近（case-05: 0.3→0.498），
// 原因是 costOf 只算冲突、不算"滑了多远"，冲突代价一样时它取的是候选表里排在前面的。
//
// 取 3 是刻意压在最小冲突代价（压别的连线 = 4）之下：滑满全程也只值 3 分，
// **这条拉力永远买不掉一处真冲突**，只在冲突代价相同或接近时决定去留。
// 试过 12：journal 皮肤的 HTTPS 标签就会为了靠近中点而压回编组标题带
// （tests/label-clearance.test.mjs 会红）——那正是这条拉力不该有的权力。
const LABEL_HOME_PULL = 3;
const CORRIDOR_CLEARANCE = 10;   // 标签与标题之间的净空
const CORRIDOR_PASSES = 3;
// 「收卡片换通道」的底：卡片等比收到原尺寸的这个比例仍装不下抬高后的列距，就回滚。
// 再往下卡片放不下自己的文字，换来的净空会被 clipping 抵消，不划算。
const LABEL_GAP_TRADE_MIN = 0.62;

function widenBlockedCorridors(spec, metrics, cellOf, cut, redraw) {
  const labelMode = skinLayout(metrics).panelLabel.mode;
  // 两种通道各有一道闸：编组标题通道只有竖排标题（side）值得收窄卡片（见 bands 那行），
  // 端点通道与皮肤的标题排法无关，任何皮肤都要处理，所以这里不能整个函数提前返回。
  const px = Math.round(metrics.typeSmall * 0.8);
  const qcOpts = qualityThresholdsOf(spec);
  const minWidthOf = (node) => {
    const textW = Math.max(
      estimateTextWidth(node.label, metrics.typeNode),
      estimateTextWidth(node.sublabel, metrics.typeSmall),
    );
    return skinCardWidth(metrics, textW, { variant: node.variant, hasLeftIcon: !!resolveIcon(spec, node) });
  };

  for (let pass = 0; pass < CORRIDOR_PASSES; pass += 1) {
    const scene = buildScene(spec);
    // 闸一：只有竖排标题（side）值得为编组标题收窄卡片。通栏带（bar-top）横贯容器整宽、
    // 药丸（chip）缩在角落，前者收窄也躲不开、后者本来就不挡道 —— 那两种交给挪标签。
    const bands = labelMode === 'side' ? panelLabelBands(spec, scene, metrics) : [];
    const byId = new Map((spec.edges || []).map((e) => [e.id, e]));
    let changed = false;

    for (const edge of scene.edges) {
      const text = typeof edge.label === 'string' ? edge.label : (edge.label && edge.label.text) || '';
      if (!text) continue;
      const spec1 = byId.get(edge.id);
      const box = edgeLabelBoxAt(text, edge.pts, spec1 && spec1.labelT, px);
      const band = bands.find((b) => aabbIntersects(box, b.rect));
      if (!band) continue;

      // 闸二：先看沿线挪能不能救。能救就别动卡片 —— 收窄是最后手段，
      // 手调基准里也只收了三张，其余保持等宽。
      if (LABEL_T_CANDIDATES.some((t) => {
        const probe = edgeLabelBoxAt(text, edge.pts, t == null ? undefined : t, px);
        return !bands.some((b) => aabbIntersects(probe, b.rect))
          && !scene.nodes.some((n) => n.id !== edge.source && n.id !== edge.target && aabbIntersects(probe, n));
      })) continue;

      // 该收谁：站在这个容器外面的那个端点。两端都在里面 / 都在外面就放弃，
      // 那属于走线通道仲裁，不是收窄卡片能解决的。
      const inside = (id) => id === band.id || isDescendantOf(spec, id, band.id);
      const outer = inside(edge.source) === inside(edge.target)
        ? null
        : (inside(edge.source) ? edge.target : edge.source);
      const node = outer ? findNodeById(spec, outer) : null;
      if (!node || isContainer(node) || !cellOf.has(outer)) continue;

      const rect = rectOf(spec, outer);
      if (!rect) continue;
      // 卡片在标题的哪一侧，就把它朝标题的方向收
      const side = rect.x < band.rect.x ? 'right' : 'left';
      const gap = side === 'right'
        ? band.rect.x - (rect.x + rect.w)
        : rect.x - (band.rect.x + band.rect.w);
      const need = Math.ceil(box.w + CORRIDOR_CLEARANCE * 2 - gap);
      if (need <= 0) continue;

      const floor = minWidthOf(node);
      const already = (cut.get(outer) || { px: 0 }).px;
      const room = Math.max(0, rect.w - floor);
      const add = Math.min(need, room);
      if (add <= 0) continue;   // 已经收到内容宽了，再收文字要溢出

      cut.set(outer, { px: already + add, side });
      changed = true;
    }

    // 端点通道 —— 两张端点卡片之间的直通道比标签还窄时，标签向两侧均匀外溢，
    // 压进自己的源卡与目标卡，还把自己的箭头盖住（质检记两条 medium）。
    // 这是 case-04「业务数据库 ←同步— 科研数据仓库」的形态：通道 46px、标签 52px，
    // 沿 46px 的直线怎么滑都压得上，只有把通道让开才有解。
    for (const edge of scene.edges) {
      const text = typeof edge.label === 'string' ? edge.label : (edge.label && edge.label.text) || '';
      if (!text) continue;
      const spec1 = byId.get(edge.id);
      const box = edgeLabelBoxAt(text, edge.pts, spec1 && spec1.labelT, px);
      const src = scene.nodes.find((n) => n.id === edge.source);
      const tgt = scene.nodes.find((n) => n.id === edge.target);
      if (!src || !tgt) continue;
      // 侵入判定与 quality-checker 同口径：擦边放过，压进去才算
      const intrudes = (n, r) => {
        if (!aabbIntersects(r, n)) return false;
        const ow = Math.min(n.x + n.w, r.x + r.w) - Math.max(n.x, r.x);
        const oh = Math.min(n.y + n.h, r.y + r.h) - Math.max(n.y, r.y);
        return Math.min(ow, oh) >= qcOpts.labelEndpointIntrusion;
      };
      if (!intrudes(src, box) && !intrudes(tgt, box)) continue;
      // 闸：沿线挪能救就别动卡片，与编组标题通道同一条原则
      if (LABEL_T_CANDIDATES.some((t) => {
        const probe = edgeLabelBoxAt(text, edge.pts, t == null ? undefined : t, px);
        return !intrudes(src, probe) && !intrudes(tgt, probe)
          && !scene.nodes.some((n) => n.id !== edge.source && n.id !== edge.target && aabbIntersects(probe, n));
      })) continue;

      // 只处理横向直通道：cut 只能收宽度，纵向通道收不出来（要动行高，属于另一层）
      const [left, right] = src.x <= tgt.x ? [src, tgt] : [tgt, src];
      const gap = right.x - (left.x + left.w);
      const verticallyApart = left.y + left.h <= right.y || right.y + right.h <= left.y;
      if (gap <= 0 || verticallyApart) continue;
      // 净空要够箭头露出来：箭头从端点沿线向后占 headLen，比标题通道的 10px 更严
      const clearance = Math.max(CORRIDOR_CLEARANCE, Math.ceil(qcOpts.arrowClearPx) + 2);
      const need = Math.ceil(box.w + clearance * 2 - gap);
      if (need <= 0) continue;

      // 两侧对半收，图面才保持等宽；每侧各自受自己的内容宽下限约束。
      // 左边收不动（已到内容宽）时余量整个落给右边，不要因为对半就少让出净空。
      let remaining = need;
      const sides = [[left, 'right'], [right, 'left']];
      sides.forEach(([node, side], i) => {
        if (remaining <= 0) return;
        if (!cellOf.has(node.id)) return;
        const spec2 = findNodeById(spec, node.id);
        if (!spec2 || isContainer(spec2)) return;
        const already = (cut.get(node.id) || { px: 0 }).px;
        const room = Math.max(0, node.w - minWidthOf(spec2));
        const add = Math.min(i === 0 ? Math.ceil(remaining / 2) : remaining, room);
        if (add <= 0) return;
        cut.set(node.id, { px: already + add, side });
        remaining -= add;
        changed = true;
      });
    }

    if (!changed) return;
    redraw();
  }
}

// 规整的收尾：把互相压住、压在节点上、或压在别的连线上的标签，沿各自的折线挪开。
// 这三条在准则里分别记 high / high / medium，而它们完全由摆放决定，
// 应该由「一键规整」当场解决，而不是留在报告里让用户手动拖。
export function relaxEdgeLabels(spec) {
  const labeled = (spec.edges || []).filter((e) => e.label);
  if (!labeled.length) return spec;
  const scene = buildScene(spec);
  const routes = new Map();
  scene.edges.forEach((e) => routes.set(e.id, e.pts));
  const sceneEdgeOf = new Map(scene.edges.map((se) => [se.id, se]));
  const px = Math.round(metricsOf(spec).typeSmall * 0.8);
  // 落点候选：先在中段找，找不到再往两头够。通栏带（bar-top）横贯整个容器顶部，
  // 连线在带子里的那一段无论怎么挪都压得上，只有拐到竖直段才躲得开 —— 0.12 / 0.88
  // 这两档就是为它留的。clampLabelT 会保证不贴到端点上。
  const CANDIDATE_T = LABEL_T_CANDIDATES;
  const placed = [];
  const rectAt = (e, t) => {
    const pts = routes.get(e.id);
    if (!pts) return null;
    const p = edgeLabelPointOf(pts, t == null ? undefined : t);
    const w = estimateTextWidth(e.label, px) + 24;
    const h = Math.round(px * 1.5);
    return { x: p.x - w / 2, y: p.y - h / 2, w, h };
  };
  // 编组标题占住的那块（药丸 / 通栏带 / 竖排列）——连线标签压在编组标题上，
  // 是图面上最刺眼的一种重叠，代价与压住节点同档
  const metricsNow = metricsOf(spec);
  const labelBands = scene.containers
    .filter((c) => c.label != null && String(c.label) !== '')
    .map((c) => skinPanelLabelRect(metricsNow, c, estimateTextWidth(c.label, metricsNow.typeSmall)));
  // 箭头净空 / 端点侵入的口径一律从 qualityOptionsOf 取，和质检器读同一组数：
  // 排版器照着自己的一套摆、质检器照着另一套判，就会出现「摆到最优仍然扣分」。
  const qcOpts = qualityThresholdsOf(spec);
  // 箭头禁区与 quality-checker 的 qcArrowBox 同形：从端点沿末段方向向后 headLen、
  // 垂直半高 headHalf 的方向盒，不是居中方块——居中方块在横平竖直的走线上
  // 会同时高估垂直方向、低估沿线方向，两边都对不上质检器。
  const arrowBoxAt = (tip, prev) => {
    const len = qcOpts.arrowClearPx;
    const half = qcOpts.arrowHalfPx;
    const horizontal = Math.abs(tip.y - prev.y) <= Math.abs(tip.x - prev.x);
    if (horizontal) {
      return { x: tip.x > prev.x ? tip.x - len : tip.x, y: tip.y - half, w: len, h: half * 2 };
    }
    return { x: tip.x - half, y: tip.y > prev.y ? tip.y - len : tip.y, w: half * 2, h: len };
  };
  const arrowZones = [];
  scene.edges.forEach((se) => {
    if (!se.pts || se.pts.length < 2) return;
    const n = se.pts.length;
    // 哪一端真有箭头，与质检器同判：反向边的箭头在起点，双向边两端都有，无箭头边一端都没有
    if (se.undirected) return;
    if (se.bidirectional || se.reversed) arrowZones.push(arrowBoxAt(se.pts[0], se.pts[1]));
    if (se.bidirectional || !se.reversed) arrowZones.push(arrowBoxAt(se.pts[n - 1], se.pts[n - 2]));
  });
  const canvasRect = { x: 0, y: 0, w: CANVAS.w, h: CANVAS.h };
  // 代价与准则对齐：出画布 1000（clipping/high 且视觉不可接受，等同硬禁止）；
  // 压非端点节点 8、压别的标签 8（都是 high）；压编组标题 6（美学，手调基准的底线）；
  // 压别的连线 4（medium）；盖住箭头 4、压进自己的端点卡片 4（都是 medium）。
  // 再加一项「滑了多远」：候选按 LABEL_HOME_PULL 计费，冲突代价相同时永远选更靠近
  // 自然落点(最长直段中点)的那个，冲突代价差得不多时也不值得滑很远。
  const costOf = (rect, e, labelBoxes, t) => {
    let cost = 0;
    if (Number.isFinite(t)) {
      const pts = routes.get(e.id);
      if (pts) cost += Math.abs(t - naturalLabelT(pts)) * LABEL_HOME_PULL;
    }
    if (!rectContains(canvasRect, rect, 0)) cost += 1000;
    // 端点卡片不再一刀切豁免：标签是不透明 chip，压进自己的源/目标卡片就是在卡面上
    // 挖白洞，质检器按侵入深度记 overlap/medium（labelEndpointIntrusion）。这里用同一个
    // 阈值，让排版器有动机把标签挪出去。一条边最多压两个端点，但那是同一处缺陷
    // （通道不够宽 / 落点不对），与质检器一致只记一次，否则会盖过「压非端点节点」的权重。
    let intrudesEndpoint = false;
    for (const n of scene.nodes) {
      if (!aabbIntersects(rect, n)) continue;
      if (n.id !== e.source && n.id !== e.target) { cost += 8; continue; }
      const ow = Math.min(n.x + n.w, rect.x + rect.w) - Math.max(n.x, rect.x);
      const oh = Math.min(n.y + n.h, rect.y + rect.h) - Math.max(n.y, rect.y);
      if (Math.min(ow, oh) >= qcOpts.labelEndpointIntrusion) intrudesEndpoint = true;
    }
    if (intrudesEndpoint) cost += 4;
    for (const pr of labelBoxes) if (aabbIntersects(rect, pr)) cost += 8;
    for (const band of labelBands) if (aabbIntersects(rect, band)) cost += 6;
    // 压别的连线 4 —— 但同束（第 10 步）的边共有的那段主干不算：那也是自己的线，质检同口径
    // 不报（segmentOnSharedTrunk）。不豁免的话，束里的边不管把标签放哪都是 4 分起步，
    // 与「盖住箭头 4」打平，就会顺着自然落点把标签放在同伴的支线上、真的被误读。
    const mine = sceneEdgeOf.get(e.id);
    routes.forEach((pts, id) => {
      if (id === e.id) return;
      const other = sceneEdgeOf.get(id);
      const bundled = !!(mine && other && edgesBundled(mine, other, qcOpts.bundlePointTol));
      for (let i = 0; i < pts.length - 1; i += 1) {
        if (!segmentIntersectsRect(pts[i], pts[i + 1], rect)) continue;
        if (bundled && segmentOnSharedTrunk(mine, other, i, qcOpts.bundlePointTol)) continue;
        cost += 4;
        return;
      }
    });
    for (const z of arrowZones) if (aabbIntersects(rect, z)) cost += 4;
    return cost;
  };
  // 第一轮：按边序贪心落位（对照「已放好的」标签）
  const finalRect = new Map();
  labeled.forEach((e) => {
    let best = null;
    for (const t of CANDIDATE_T) {
      const rect = rectAt(e, t);
      if (!rect) break;
      const cost = costOf(rect, e, placed, t);
      if (!best || cost < best.cost) best = { t, cost, rect };
      if (!cost) break;
    }
    if (!best) return;
    if (best.t == null) delete e.labelT; else e.labelT = best.t;
    placed.push(best.rect);
    finalRect.set(e.id, best.rect);
  });
  // 后续轮：贪心有次序依赖——先放的标签占住位置，后放的短边（clampLabelT 收窄后
  // 沿线无处可逃）就只能硬叠上去。改成互让迭代：每个标签对照「其余全部标签的
  // 当前位置」重选，有改善就搬，直到稳定。
  const othersOf = (id) => [...finalRect.entries()].filter(([k]) => k !== id).map(([, r]) => r);
  for (let round = 0; round < 3; round += 1) {
    let moved = false;
    labeled.forEach((e) => {
      if (!finalRect.has(e.id)) return;
      const others = othersOf(e.id);
      let best = null;
      for (const t of CANDIDATE_T) {
        const rect = rectAt(e, t);
        if (!rect) break;
        const cost = costOf(rect, e, others, t);
        if (!best || cost < best.cost) best = { t, cost, rect };
        if (!cost) break;
      }
      if (!best) return;
      const currentT = Number.isFinite(e.labelT) ? e.labelT : null;
      const currentCost = costOf(finalRect.get(e.id), e, others, currentT);
      if (best.cost < currentCost - 1e-9 && best.t !== currentT) {
        if (best.t == null) delete e.labelT; else e.labelT = best.t;
        finalRect.set(e.id, best.rect);
        moved = true;
      }
    });
    if (!moved) break;
  }
  return spec;
}

/* ---------------- 选区规整（只整选中的叶子，选区外零变化） ----------------
   全量规整会摧毁手调布局（日志里 0 分、23 分的全量规整都被当场撤销），而手感
   过冲压出来的 19/18px 间距又只差几个像素就达标（日志 05 终稿唯一扣分）。
   这一档补的就是中间态：把选中的那几张卡等距重锚、间距不足撑到质检准则的
   minSpacing，其余一个像素不动。 */

// 同行 / 同列判定：交叉轴区间有重叠即算同一条道（按区间链式合并）。
// 行按 y 聚类、列按 x 聚类；同一行里的卡片彼此在 x 上不重叠，
// 所以行整完再整列不会把同一对卡片处理两遍。
function tidyLanesOf(rects, crossAxis) {
  const lo = (o) => o.r[crossAxis];
  const hi = (o) => o.r[crossAxis] + (crossAxis === 'y' ? o.r.h : o.r.w);
  const sorted = rects.slice().sort((a, b) => lo(a) - lo(b));
  const lanes = [];
  sorted.forEach((o) => {
    const last = lanes[lanes.length - 1];
    if (last && lo(o) < last.hi) { last.items.push(o); last.hi = Math.max(last.hi, hi(o)); }
    else lanes.push({ items: [o], hi: hi(o) });
  });
  return lanes.map((l) => l.items);
}

// 一条道内沿主轴等距重锚。间距下限之内「够用即止」：
//   两端边界装得下（均分间距 ≥ gapMin）→ 两端不动，只把中间的卡摆匀；
//   装不下 → 间距取 gapMin（一分不多），以这条道当前中心对称外扩。
// 全程整数网格（setRect 只存整数、gapMin 已取整），重跑一遍每个目标值都
// 与现值相同 —— 幂等由此保证，不靠额外的收敛判断。
function tidyLaneRun(spec, items, axis, gapMin) {
  if (items.length < 2) return false;
  const sizeOf = (r) => (axis === 'x' ? r.w : r.h);
  const list = items.slice().sort((a, b) => a.r[axis] - b.r[axis]);
  const startEdge = list[0].r[axis];
  const endEdge = list[list.length - 1].r[axis] + sizeOf(list[list.length - 1].r);
  const sum = list.reduce((a, o) => a + sizeOf(o.r), 0);
  const evenGap = (endEdge - startEdge - sum) / (list.length - 1);
  let gap = evenGap;
  let start = startEdge;
  if (evenGap < gapMin) {
    gap = gapMin;
    const span = sum + gap * (list.length - 1);
    start = Math.round((startEdge + endEdge - span) / 2);
  }
  let changed = false;
  let cursor = start;
  list.forEach((o) => {
    const target = Math.round(cursor);
    if (target !== o.r[axis]) {
      const next = { x: o.r.x, y: o.r.y, w: o.r.w, h: o.r.h };
      next[axis] = target;
      setRect(spec, o.id, next);
      o.r = rectOf(spec, o.id);
      changed = true;
    }
    cursor += sizeOf(o.r) + gap;
  });
  return changed;
}

// 选区规整入口：ids 里只认叶子（容器与不存在的 id 直接忽略），不足两张不动图。
// 间距下限与质检同一份准则（qualityOptionsOf → QUALITY_RULES.minSpacing 随外框缩放），
// 向上取整落到整数网格 —— setRect 只存整数，间距取小数会在四舍五入后又低回阈值。
// 返回是否有改动，编辑器拿它决定提示与要不要入撤销栈。
export function tidySelection(spec, ids) {
  const wanted = new Set(ids || []);
  const leaves = leafNodes(spec).filter((n) => wanted.has(n.id) && rectOf(spec, n.id));
  if (leaves.length < 2) return false;
  const gapMin = Math.ceil(qualityOptionsOf(spec).minSpacing - 1e-9);
  const pick = () => leaves.map((n) => ({ id: n.id, r: rectOf(spec, n.id) }));
  let changed = false;
  tidyLanesOf(pick(), 'y').forEach((lane) => {   // 行：y 聚类，行内动 x
    if (tidyLaneRun(spec, lane, 'x', gapMin)) changed = true;
  });
  tidyLanesOf(pick(), 'x').forEach((lane) => {   // 列：x 聚类，列内动 y
    if (tidyLaneRun(spec, lane, 'y', gapMin)) changed = true;
  });
  return changed;
}

/* ---------------- 版式与外框 ---------------- */

export const TITLE_LINE = 1.15;

export function titleBlock(spec) {
  const box = getSlideLayout(spec.layout).titleBox;
  const titlePx = 56;
  const subPx = 24;
  const h = titlePx * TITLE_LINE + (spec.subtitle ? 12 + subPx * 1.4 : 0);
  const centered = box.align === 'top-center';
  const y = box.align === 'left-center' ? box.y + Math.max(0, (box.h - h) / 2) : box.y;
  return { x: box.x, y: Math.round(y), w: box.w, h: Math.round(h), centered, titlePx, subPx };
}

export function captureGeometry(spec) {
  const out = {};
  Object.keys(spec.positions).forEach((id) => { out[id] = { ...spec.positions[id] }; });
  return out;
}

// 外框变化时按归一化坐标做非等比仿射。连续拖动必须传拖拽起始时的 baseline，
// 否则每帧都在上一帧结果上再变换一次，位移会累积。
export function applyFrameGeometry(spec, fromFrame, toFrame, baseline) {
  if (!fromFrame || !toFrame || !(fromFrame.w > 0) || !(fromFrame.h > 0)) return spec;
  const base = baseline || captureGeometry(spec);
  Object.keys(base).forEach((id) => {
    const rect = base[id];
    setRect(spec, id, {
      x: toFrame.x + ((rect.x - fromFrame.x) / fromFrame.w) * toFrame.w,
      y: toFrame.y + ((rect.y - fromFrame.y) / fromFrame.h) * toFrame.h,
      w: Math.max(NODE_MIN.w, (rect.w / fromFrame.w) * toFrame.w),
      h: Math.max(NODE_MIN.h, (rect.h / fromFrame.h) * toFrame.h),
    });
  });
  return spec;
}

export function switchLayout(spec, layoutId) {
  const next = normalizeLayoutId(layoutId);
  const from = spec.frame;
  spec.layout = next;
  spec.frame = getDefaultFrame(next);
  return applyFrameGeometry(spec, from, spec.frame);
}

export function resetFrame(spec) {
  const from = spec.frame;
  spec.frame = getDefaultFrame(spec.layout);
  return applyFrameGeometry(spec, from, spec.frame);
}

function resizeRect(rect, handle, dx, dy, min) {
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.w;
  let bottom = rect.y + rect.h;
  if (handle.indexOf('w') >= 0) left += dx;
  if (handle.indexOf('e') >= 0) right += dx;
  if (handle.indexOf('n') >= 0) top += dy;
  if (handle.indexOf('s') >= 0) bottom += dy;
  if (right - left < min.w) {
    if (handle.indexOf('w') >= 0) left = right - min.w; else right = left + min.w;
  }
  if (bottom - top < min.h) {
    if (handle.indexOf('n') >= 0) top = bottom - min.h; else bottom = top + min.h;
  }
  return { x: Math.round(left), y: Math.round(top), w: Math.round(right - left), h: Math.round(bottom - top) };
}

export function resizeFrameRect(frame, handle, dx, dy) { return resizeRect(frame, handle, dx, dy, FRAME_MIN); }
export function resizeNodeRect(rect, handle, dx, dy) { return resizeRect(rect, handle, dx, dy, NODE_MIN); }
// 多选缩放框：下限不是常量，而是由组里最小的那张卡反推出来的（见 groupScaleMin），
// 所以这一档必须把 min 当参数收，不能像上面两个那样写死。
export function resizeGroupRect(box, handle, dx, dy, min) {
  return resizeRect(box, handle, dx, dy, min || NODE_MIN);
}

/* ---------------- 场景图（质检 / 路由 / 导出 / 画布共用） ---------------- */

export function buildScene(spec, opts = {}) {
  const metrics = metricsOf(spec);
  const scene = { canvas: { ...CANVAS }, frame: { ...spec.frame }, nodes: [], containers: [], edges: [] };

  const tb = titleBlock(spec);
  if (spec.title) {
    scene.title = { text: spec.title, x: tb.centered ? tb.x : tb.x, y: tb.y, w: tb.w, h: tb.titlePx * TITLE_LINE };
  }
  if (spec.subtitle) {
    scene.subtitle = { text: spec.subtitle, x: tb.x, y: tb.y + tb.titlePx * TITLE_LINE + 12, w: tb.w, h: tb.subPx * 1.4 };
  }

  leafNodes(spec).forEach((n) => {
    const r = rectOf(spec, n.id);
    if (!r) return;
    const hit = resolveIcon(spec, n);
    const asset = hit ? iconAsset(hit.slug) : null;
    const position = n.iconPosition === 'top' ? 'top' : 'left';
    // icon 传 'left'/'top'/null —— node-fit 靠它决定要不要给图标留位
    const style = nodeFitStyle(metrics, { variant: n.variant, icon: asset ? position : null });
    const fit = solveNodeFit(r, { label: n.label, sublabel: n.sublabel }, style, measurer, {});
    scene.nodes.push({
      id: n.id, label: n.label, sublabel: n.sublabel,
      x: r.x, y: r.y, w: r.w, h: r.h,
      labelPx: fit.fontPx, subPx: fit.subPx,
      padX: fit.padX, padY: fit.padY, labelGap: fit.gap,
      iconPx: fit.iconSize, iconGapPx: fit.iconGap,
      fit: { lines: fit.lines, subLines: fit.subLines, tier: fit.tier, overflow: fit.overflow, dropSub: fit.dropSub },
      variant: n.variant || 'default',
      icon: asset ? { slug: hit.slug, type: asset.type, color: asset.color, path: asset.path, svg: asset.svg, viewBox: asset.viewBox, position } : undefined,
    });
  });

  containerNodes(spec).forEach((c) => {
    const r = containerRect(spec, c.id, metrics);
    if (!r) return;
    scene.containers.push({ id: c.id, label: c.label, x: r.x, y: r.y, w: r.w, h: r.h, labelPx: metrics.typeSmall, depth: nodeDepth(spec, c.id) });
  });

  // 路由用叶节点 + 容器一起做端口候选，只用叶节点做避障
  const rectsById = new Map();
  scene.nodes.forEach((n) => rectsById.set(n.id, { id: n.id, x: n.x, y: n.y, w: n.w, h: n.h }));
  scene.containers.forEach((c) => rectsById.set(c.id, { id: c.id, x: c.x, y: c.y, w: c.w, h: c.h }));
  // 试过把编组标题也塞进避障集，走线质量掉得厉害（QC 100 → 73，出现截断和多处交叉）：
  // 通栏带横贯容器顶部，当成障碍就把容器内唯一的横向通道切碎了。
  // 改为不动走线，只在落点候选里往两头够 —— 见 relaxEdgeLabels 的 CANDIDATE_T。
  // 箭头前端净空按 edgeWeight 的 headLen 取值（随整图几何系数缩放，不挂线宽——
  // edge-weight 硬约束）；bounds 让外圈绕行贴着画布边收住，线和标签都不出画布。
  const ewNow = edgeWeight(Number((skinOf(spec).tokens || {}).ew) || 2, frameScale(spec));
  const routed = routeEdges({
    rects: Array.from(rectsById.values()),
    cards: scene.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y, w: n.w, h: n.h })),
    edges: (spec.edges || []).map((e) => ({
      id: e.id, source: e.source, target: e.target,
      sourcePort: e.sourcePort, targetPort: e.targetPort, segShifts: e.segShifts,
      // 束线要知道源端有没有箭头（双向 / 反向边不进出边束）、线型（实线虚线不并成一股），
      // 见 edge-router 设计要点 8。无箭头边两个方向字段都为假，走线器会把它按「起点无箭头」的
      // 正向边处理（可进出边束）—— 它本来就没有箭头会压到同伴身上，这个口径是对的
      style: e.style, undirected: !!e.undirected,
      bidirectional: !e.undirected && !!e.bidirectional, reversed: !e.undirected && !e.bidirectional && !!e.reversed,
    })),
    options: {
      bounds: { x: 0, y: 0, w: CANVAS.w, h: CANVAS.h },
      minLastSeg: Math.ceil(ewNow.headLen * 1.25),
      // 消融开关：关掉平局打破就回到降级之前的累进重罚
      sideLoadProgressive: !LAYOUT_RULES.sideLoadTiebreak,
      // 允许「多条边收拢到同一个起点」的节点：只有聚合点（准则 3 的那批）。
      // 走线器自己看不出谁是聚合点，这个判断在树上做（hubIdOf），由这里传下去。
      sharedOriginIds: hubIdsOf(spec),
      // 第 10 步：束线只在 autoLayout 定稿那一步显式打开（见那里的注释），平时渲染不并线 ——
      // 并线的结果以端口声明写在 spec 里，渲染按声明走，手工画的图不会被走线器擅自并线
      bundle: !!opts.bundle,
    },
  });

  (spec.edges || []).forEach((e) => {
    const route = routed.routes.get(e.id);
    if (!route) return;
    const entry = {
      id: e.id, source: e.source, target: e.target,
      pts: route.pts.map((p) => ({ x: p.x, y: p.y })),
      // 无箭头边：undirected 为真，两个箭头方向字段恒为假（渲染器 / 质检只看这三个）
      style: e.style || 'solid', undirected: !!e.undirected,
      bidirectional: !e.undirected && !!e.bidirectional, reversed: !e.undirected && !e.bidirectional && !!e.reversed,
      // 端点落在哪条边的哪一档 / 中段实际被挪了多少：编辑器画手柄、回填位移都用它
      sourcePort: route.portA, targetPort: route.portB,
      segShifts: route.segShifts || [], bendCount: route.bendCount || 0,
      pinned: { source: isEdgePort(e.sourcePort), target: isEdgePort(e.targetPort) },
      // 束线（第 10 步）写下的端口声明与用户自己钉的分开标：编辑器可以据此区分"规整钉的"和"我钉的"
      autoPinned: { source: !!(e.sourcePort && e.sourcePort.auto), target: !!(e.targetPort && e.targetPort.auto) },
      bundled: route.bundled || { source: false, target: false },
    };
    if (e.label) {
      const px = Math.round(metrics.typeSmall * 0.8);
      const w = estimateTextWidth(e.label, px) + 24;
      const h = Math.round(px * 1.5);
      const mid = edgeLabelPointOf(entry.pts, e.labelT);
      entry.label = { text: e.label, x: mid.x - w / 2, y: mid.y - h / 2, w, h, px };
    }
    scene.edges.push(entry);
  });

  return scene;
}

/* ---------------- 手调走线（端点档位 / 中段位移） ----------------
   三个入口都只写 spec，几何交给 lib/edge-router.mjs 重算 —— 编辑器里拖一下就重建一次场景图，
   所以这里不缓存任何坐标。端点一旦钉住，布线器不再替这条边选面，但仍走同一套形状构建，
   「首尾段垂直于所接的边」由布线器保证，不在这里判。 */

export function edgePortAt(rect, point) { return snapEdgePort(rect, point); }
export function edgePortAnchorsOf(rect) { return edgePortAnchors(rect); }
export function edgePortXY(rect, port) { return edgePortPoint(rect, port); }

export function setEdgePort(spec, edgeId, which, port) {
  const e = (spec.edges || []).find((x) => x.id === edgeId);
  if (!e || (which !== 'source' && which !== 'target')) return false;
  const key = which === 'source' ? 'sourcePort' : 'targetPort';
  if (port == null) {
    if (e[key] == null) return false;
    delete e[key];
    return true;
  }
  if (!isEdgePort(port)) return false;
  e[key] = { side: port.side, t: Math.round(port.t * 1000) / 1000 };
  return true;
}

// index 是「第几个中间段」（0 = 第 2 段），三折线只有 0，四折线有 0 / 1，以此类推
export function setEdgeSegShift(spec, edgeId, index, shift) {
  const e = (spec.edges || []).find((x) => x.id === edgeId);
  if (!e || !(index >= 0)) return false;
  const list = Array.isArray(e.segShifts) ? e.segShifts.slice() : [];
  while (list.length <= index) list.push(0);
  list[index] = Math.round(Number(shift) || 0);
  while (list.length && !list[list.length - 1]) list.pop();
  if (list.length) e.segShifts = list; else delete e.segShifts;
  return true;
}

// 布线器钳完之后的实际位移整条回填：拖过头的那部分不会攒在 spec 里
export function setEdgeSegShifts(spec, edgeId, shifts) {
  const e = (spec.edges || []).find((x) => x.id === edgeId);
  if (!e) return false;
  const list = (Array.isArray(shifts) ? shifts : []).map((v) => (Number.isFinite(v) ? Math.round(v) : 0));
  while (list.length && !list[list.length - 1]) list.pop();
  if (list.length) e.segShifts = list; else delete e.segShifts;
  return true;
}

// 「端点复位」：把这条边交还给自动布线
export function clearEdgeRouting(spec, edgeId) {
  const e = (spec.edges || []).find((x) => x.id === edgeId);
  if (!e) return false;
  const had = e.sourcePort != null || e.targetPort != null || e.segShifts != null;
  delete e.sourcePort;
  delete e.targetPort;
  delete e.segShifts;
  return had;
}

export function hasManualRouting(edge) {
  return !!edge && (edge.sourcePort != null || edge.targetPort != null
    || (Array.isArray(edge.segShifts) && edge.segShifts.some((v) => v)));
}

// 标签沿线定位：labelT 是 0~1 的归一化弧长；未拖过时落在最长一段的中点
export function edgeLabelPointOf(pts, labelT) {
  if (!pts || pts.length < 2) return { x: 0, y: 0 };
  if (!Number.isFinite(labelT)) {
    let best = null;
    for (let i = 0; i < pts.length - 1; i += 1) {
      const len = Math.abs(pts[i + 1].x - pts[i].x) + Math.abs(pts[i + 1].y - pts[i].y);
      if (!best || len > best.len) best = { len, i };
    }
    const a = pts[best.i];
    const b = pts[best.i + 1];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }
  const segs = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const len = Math.abs(pts[i + 1].x - pts[i].x) + Math.abs(pts[i + 1].y - pts[i].y);
    segs.push(len);
    total += len;
  }
  const pad = Math.min(20, total / 3);
  let want = Math.max(pad, Math.min(total - pad, labelT * total));
  for (let i = 0; i < segs.length; i += 1) {
    if (want <= segs[i] || i === segs.length - 1) {
      const t = segs[i] ? want / segs[i] : 0;
      return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * t, y: pts[i].y + (pts[i + 1].y - pts[i].y) * t };
    }
    want -= segs[i];
  }
  return { x: pts[0].x, y: pts[0].y };
}

// 自然落点的归一化弧长位置：与 edgeLabelPointOf(pts, undefined) 同一个点，
// 只是换算成 t。给 relaxEdgeLabels 量「滑了多远」用。
export function naturalLabelT(pts) {
  if (!pts || pts.length < 2) return 0.5;
  const segs = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const len = Math.abs(pts[i + 1].x - pts[i].x) + Math.abs(pts[i + 1].y - pts[i].y);
    segs.push(len);
    total += len;
  }
  if (!(total > 0)) return 0.5;
  let bi = 0;
  for (let i = 1; i < segs.length; i += 1) if (segs[i] > segs[bi]) bi = i;
  let acc = 0;
  for (let i = 0; i < bi; i += 1) acc += segs[i];
  return (acc + segs[bi] / 2) / total;
}

export function edgeLabelTAt(pts, point) {
  if (!pts || pts.length < 2) return 0;
  let total = 0;
  let acc = 0;
  let best = { d: Infinity, at: 0 };
  const lens = [];
  for (let i = 0; i < pts.length - 1; i += 1) {
    const len = Math.abs(pts[i + 1].x - pts[i].x) + Math.abs(pts[i + 1].y - pts[i].y);
    lens.push(len);
    total += len;
  }
  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = pts[i];
    const b = pts[i + 1];
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const l2 = vx * vx + vy * vy;
    const t = l2 ? Math.max(0, Math.min(1, ((point.x - a.x) * vx + (point.y - a.y) * vy) / l2)) : 0;
    const px = a.x + vx * t;
    const py = a.y + vy * t;
    const d = (point.x - px) ** 2 + (point.y - py) ** 2;
    if (d < best.d) best = { d, at: acc + lens[i] * t };
    acc += lens[i];
  }
  return total ? best.at / total : 0;
}

/* ---------------- 结构命令 ---------------- */

export function addLeaf(spec, opts) {
  const o = opts || {};
  const id = nextId(spec, 'n');
  const node = { id, label: o.label || '新节点' };
  if (o.sublabel) node.sublabel = o.sublabel;
  if (o.variant) node.variant = o.variant;
  attachNode(spec, node, o.parentId || null);
  const metrics = metricsOf(spec);
  const w = o.w || 300;
  const h = o.h || skinCardHeight(metrics, { hasSub: !!o.sublabel });
  setRect(spec, id, { x: o.x == null ? spec.frame.x + 40 : o.x, y: o.y == null ? spec.frame.y + 40 : o.y, w, h });
  return id;
}

export function addEdge(spec, source, target) {
  if (source === target) return null;
  if ((spec.edges || []).some((e) => e.source === source && e.target === target)) return null;
  const id = nextId(spec, 'e');
  spec.edges.push({ id, source, target, label: '' });
  return id;
}

// 编组：新容器插在首个选中项原来的位置，被选中的节点整体移入
export function groupNodes(spec, ids) {
  if (!ids.length) return null;
  const first = findNodeById(spec, ids[0]);
  if (!first) return null;
  const parent = parentOfId(spec, ids[0]);
  const list = parent ? parent.children : spec.nodes;
  const index = list.findIndex((n) => n.id === ids[0]);
  const id = nextId(spec, 'g');
  const container = { id, label: '新分组', variant: 'container', children: [] };
  ids.forEach((nid) => {
    const node = detachNode(spec, nid);
    if (node) container.children.push(node);
  });
  attachNode(spec, container, parent ? parent.id : null, index);
  return id;
}

export function ungroup(spec, id) {
  const node = findNodeById(spec, id);
  if (!isContainer(node)) return false;
  const parent = parentOfId(spec, id);
  const list = parent ? parent.children : spec.nodes;
  const index = list.findIndex((n) => n.id === id);
  const kids = node.children.slice();
  detachNode(spec, id);
  kids.forEach((k, i) => attachNode(spec, k, parent ? parent.id : null, index + i));
  delete spec.positions[id];
  return true;
}

export function duplicateNodes(spec, ids) {
  const made = [];
  ids.forEach((id) => {
    const node = findNodeById(spec, id);
    if (!node) return;
    const parent = parentOfId(spec, id);
    const copy = JSON.parse(JSON.stringify(node));
    const remap = (n) => {
      const old = n.id;
      n.id = nextId(spec, isContainer(n) ? 'g' : 'n');
      const r = rectOf(spec, old);
      if (r) setRect(spec, n.id, { x: r.x + 24, y: r.y + 24, w: r.w, h: r.h });
      if (isContainer(n)) n.children.forEach(remap);
    };
    // 先挂上去再改 id，保证 nextId 能看到已占用的 id
    attachNode(spec, copy, parent ? parent.id : null);
    remap(copy);
    made.push(copy.id);
  });
  return made;
}

export function removeNodes(spec, ids) {
  const gone = new Set();
  ids.forEach((id) => {
    const node = findNodeById(spec, id);
    if (!node) return;
    walkNodes([node], (n) => gone.add(n.id));
    detachNode(spec, id);
  });
  gone.forEach((id) => delete spec.positions[id]);
  spec.edges = spec.edges.filter((e) => !gone.has(e.source) && !gone.has(e.target));
  return gone.size;
}

// 移出所在容器：上提一层，不是直接扔到顶层
export function liftOut(spec, ids) {
  ids.forEach((id) => {
    const parent = parentOfId(spec, id);
    if (!parent) return;
    const grand = parentOfId(spec, parent.id);
    const node = detachNode(spec, id);
    if (node) attachNode(spec, node, grand ? grand.id : null);
  });
  return spec;
}

// 把节点移进指定容器（拖放归属）
export function moveInto(spec, ids, containerId) {
  let moved = 0;
  ids.forEach((id) => {
    if (containerId && (id === containerId || isDescendantOf(spec, containerId, id))) return;
    const parent = parentOfId(spec, id);
    if ((parent ? parent.id : null) === containerId) return;
    const node = detachNode(spec, id);
    if (node && attachNode(spec, node, containerId)) moved += 1;
  });
  return moved;
}

// 画布上拖动落点的归属判定：落进某个容器返回该容器 id，落在空白处返回 null（= 保持原归属，不改）。
// 不把「落空」当成移出：容器盒子是子节点的包围盒，判定时又要把正在拖的节点排除在外，
// 盒子随之缩小——组内随便挪一下都会落在缩小后的盒子外，按落空移出的话节点几乎必然跳出分组。
// 要脱离分组走明确动作：liftOut（⇧⌫ 移出所在容器）、结构树拖到根、或剪切 + 粘贴。
export function dropTargetAt(spec, ids, pt) {
  const skip = new Set();
  ids.forEach((id) => descendantLeafIds(spec, id).forEach((leaf) => skip.add(leaf)));
  const target = containerAt(spec, pt, skip);
  if (!target || ids.indexOf(target) >= 0) return null;
  return target;
}

export function nudge(spec, ids, dx, dy) {
  ids.forEach((id) => {
    descendantLeafIds(spec, id).forEach((leaf) => {
      const r = rectOf(spec, leaf);
      if (r) setRect(spec, leaf, { x: r.x + dx, y: r.y + dy, w: r.w, h: r.h });
    });
  });
  return spec;
}

export function translateNodes(spec, ids, dx, dy, baseline) {
  const base = baseline || captureGeometry(spec);
  ids.forEach((id) => {
    descendantLeafIds(spec, id).forEach((leaf) => {
      const r = base[leaf];
      if (r) setRect(spec, leaf, { x: r.x + dx, y: r.y + dy, w: r.w, h: r.h });
    });
  });
  return spec;
}

// 选中项（含容器）覆盖到的叶子，去重后按 spec 顺序给出。
// 多选里「容器 + 它自己的子节点」同时被选中是常态，不去重的话那些叶子会被缩放两次。
export function groupLeafIds(spec, ids) {
  const out = [];
  const seen = new Set();
  (ids || []).forEach((id) => {
    descendantLeafIds(spec, id).forEach((leaf) => {
      if (seen.has(leaf)) return;
      seen.add(leaf);
      out.push(leaf);
    });
  });
  return out;
}

// 叶子包围盒（不含容器内边距）：多选缩放的参照系。
// 显示出来的那个框是「容器盒 = 子项并集 + panelPad」，pad 是常量不跟着缩，
// 所以换算必须在这个不含 pad 的盒子里做，调用方负责把 pad 那一圈剥掉再传进来。
export function groupLeafBox(spec, ids, baseline) {
  const base = baseline || captureGeometry(spec);
  let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity;
  groupLeafIds(spec, ids).forEach((leaf) => {
    const r = base[leaf];
    if (!r) return;
    x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.w); y2 = Math.max(y2, r.y + r.h);
  });
  return x2 > x1 && y2 > y1 ? { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } : null;
}

// 整组能缩到多小：任一叶子都不许被压到 NODE_MIN 之下，钳的是**整组的缩放系数**。
// 逐个节点各自钳 NODE_MIN（applyFrameGeometry 的做法）会让小卡先触底、大卡继续缩，
// 组内相对大小当场失真——多选缩放看到的就是卡片比例乱跳，这不是「以组的形式缩放」。
// 组里已经比 NODE_MIN 还小的叶子不会被算成「必须先放大」（那样一按手柄整组就弹大），
// 只是把该轴锁在 1：这种组只许放大、不许再缩。
export function groupScaleMin(spec, ids, baseline) {
  const base = baseline || captureGeometry(spec);
  let sx = 0; let sy = 0;
  groupLeafIds(spec, ids).forEach((leaf) => {
    const r = base[leaf];
    if (!r || !(r.w > 0) || !(r.h > 0)) return;
    sx = Math.max(sx, NODE_MIN.w / r.w);
    sy = Math.max(sy, NODE_MIN.h / r.h);
  });
  return { x: Math.min(1, sx || 1), y: Math.min(1, sy || 1) };
}

// 多选缩放：把 ids 覆盖到的叶子按包围盒做仿射，组内相对位置与相对大小同比例跟着走。
// 与 applyFrameGeometry 的两处区别：只动选中的这些（不是全图），且不逐个钳 NODE_MIN
// （下限由 groupScaleMin 在**系数**这一层钳完，见上）。
// 连续拖动必须传按下那一刻的 baseline，否则每帧都在上一帧结果上再乘一次，越缩越快。
export function scaleNodes(spec, ids, fromBox, toBox, baseline) {
  if (!fromBox || !toBox || !(fromBox.w > 0) || !(fromBox.h > 0)) return spec;
  const base = baseline || captureGeometry(spec);
  const sx = toBox.w / fromBox.w;
  const sy = toBox.h / fromBox.h;
  groupLeafIds(spec, ids).forEach((leaf) => {
    const r = base[leaf];
    if (!r) return;
    setRect(spec, leaf, {
      x: toBox.x + (r.x - fromBox.x) * sx,
      y: toBox.y + (r.y - fromBox.y) * sy,
      w: r.w * sx,
      h: r.h * sy,
    });
  });
  return spec;
}

/* ---------------- 与生成器的往返 ---------------- */

// 导出给 generate.mjs 的 spec：去掉运行时字段，容器不写坐标
export function toBuildSpec(spec) {
  const out = {
    title: spec.title,
    layout: spec.layout,
    skin: spec.skin,
    nodes: JSON.parse(JSON.stringify(spec.nodes)),
    edges: (spec.edges || []).map((e) => {
      const o = { id: e.id, source: e.source, target: e.target };
      if (e.label && String(e.label).trim()) o.label = e.label;
      if (o.label && Number.isFinite(e.labelT)) o.labelT = Math.round(e.labelT * 1000) / 1000;
      if (e.style && e.style !== 'solid') o.style = e.style;
      if (e.undirected) o.undirected = true;
      else if (e.bidirectional) o.bidirectional = true;
      else if (e.reversed) o.reversed = true;
      // 手调走线要能跟着 spec 走完整个来回，否则导出再生成就弹回自动布线
      if (isEdgePort(e.sourcePort)) o.sourcePort = { ...e.sourcePort };
      if (isEdgePort(e.targetPort)) o.targetPort = { ...e.targetPort };
      if (Array.isArray(e.segShifts) && e.segShifts.some((v) => v)) o.segShifts = e.segShifts.slice();
      return o;
    }),
    frame: { ...spec.frame },
    positions: {},
  };
  if (spec.subtitle) out.subtitle = spec.subtitle;
  if (spec.direction) out.direction = spec.direction;
  if (spec.icons === false) out.icons = false;
  if (spec.mode === 'layered') out.mode = 'layered';   // flow 是缺省，不写
  leafNodes(spec).forEach((n) => {
    const r = rectOf(spec, n.id);
    if (r) out.positions[n.id] = { x: r.x, y: r.y, w: r.w, h: r.h };
  });
  return out;
}

// 读入 generate.mjs 那套 spec：没有 positions 时直接跑一次规整补齐
export function fromBuildSpec(raw) {
  const spec = normalizeSpec(cloneSpec(raw));
  spec.baseFrame = { ...spec.frame };   // 先钉基准，autoLayout 才能按 scale=1 排
  const missing = leafNodes(spec).some((n) => !rectOf(spec, n.id));
  if (missing) autoLayout(spec);
  return spec;
}

/**
 * 工作台「新开一份 spec」的口径：首开种子 / 重置 / archEditor.openSpec / JSON 面板同用。
 *
 * 为什么不能直接用 fromBuildSpec：它只在「有叶子缺矩形」时才跑 autoLayout，而第 10 步的
 * 束线并线（materializeBundles）藏在 autoLayout 末尾、还带 activeRules(spec).bundle 门控。
 * 一份 positions 齐全的 spec 进工作台时 autoLayout 一步都不跑，也就没有束线端口，
 * 走线器自由选面；而生成器（generate.mjs / scene-from-spec.mjs）是在**最终坐标**上
 * materializeBundles 之后才 buildScene。两边必须同序，否则同一份文件两个样子——
 * 实测 labs/batch2/14-银行核心账务.json：节点与容器 0 处不同，边 e1、e3 的 pts 各差 24px，
 * 质检分 84（工作台首开） vs 92（生成器）。
 *
 * 这里**不补 autoFix**：生成器里 autoFix 排在「用户 positions 覆盖」之前，用户坐标最终
 * 会盖回去；工作台 positions 齐全时全是用户坐标，再跑 autoFix 就是去挪它们，
 * 违背「重新生成不丢手动编辑」。
 *
 * materializeBundles 幂等（进门先 clearAutoPorts 再重新决定），所以对已经在 fromBuildSpec
 * 里跑过 autoLayout 的 spec 再过一遍，结果不变。
 *
 * 也**不改 fromBuildSpec 本身**：生成器与 bench 在它之后立刻 autoLayout，
 * 把并线塞进去等于白跑一遍。
 */
export function openBuildSpec(raw) {
  const spec = fromBuildSpec(raw);
  // 手调 labelT 先存后还，与 generate.mjs 的 presetLabelT 同一做法
  //（materializeBundles 落完端口会 relaxEdgeLabels，把标签重新落一次）
  const preset = new Map((spec.edges || [])
    .filter((e) => Number.isFinite(e.labelT))
    .map((e) => [e.id, e.labelT]));
  materializeBundles(spec);
  spec.edges.forEach((e) => { if (preset.has(e.id)) e.labelT = preset.get(e.id); });
  return spec;
}
