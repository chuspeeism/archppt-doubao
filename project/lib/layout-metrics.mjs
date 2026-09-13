// lib/layout-metrics.mjs —— 版面指标（只报数，不打分）
// 仅 Node 侧使用，零依赖；口径与 lib/quality-checker.mjs 同源（编组归属直接读它的 qcParentIdOf）。
//
// 为什么和质检分开：
//   质检回答「这张图有没有错」——重叠、越界、截断、交叉，每一项都能指到具体的两个对象。
//   本模块回答「这张图摆得满不满、齐不齐、绕不绕」——没有单点错误，但整张图的观感差别很大。
//   case-4 的手工调优里，91 步中有相当一部分既不消除任何质检项、也不新增任何质检项，
//   分数从 90 到 100 的过程里质检始终看不见饱满度与走线拓扑的变化
//   （见 docs/tuning-log-principles.md 的「排版规则台账」一节）。
//   所以这些量必须能单独测出来，否则「改完更好看了」永远只能靠眼睛判断。
//
// 这里的每个数都是**方向性**的：同一份 spec 的两个版本之间比较才有意义，
// 不存在「0.31 算好还是算坏」的绝对判据，因此本模块不设阈值、不给结论。
import { polylineLength, manhattanDistance, countBends } from './geometry-utils.mjs';
import { qcParentIdOf } from './quality-checker.mjs';

const r3 = (v) => Math.round(v * 1000) / 1000;
const r1 = (v) => Math.round(v * 10) / 10;

// 一组数按容差归桶，返回「有多少个坐标是和别人对齐的」：
// 每个桶贡献 size-1（第一个定基准，后面的都是对齐上去的）。
function alignedCount(values, tol) {
  const sorted = values.slice().sort((a, b) => a - b);
  let total = 0;
  let i = 0;
  while (i < sorted.length) {
    let j = i + 1;
    while (j < sorted.length && sorted[j] - sorted[i] <= tol) j += 1;
    total += (j - i) - 1;
    i = j;
  }
  return total;
}

// 轴对齐线段与矩形「平行贴行」的净空；与 lib/edge-router.mjs 的 erSegRectClear 同口径。
// 0 表示压在矩形上（穿卡），Infinity 表示这一段根本不与矩形并行相遇。
function segRectClear(p, q, r) {
  const horizontal = Math.abs(p.y - q.y) <= 0.5;
  const vertical = Math.abs(p.x - q.x) <= 0.5;
  if (!horizontal && !vertical) return Infinity;
  const lo = horizontal ? Math.min(p.x, q.x) : Math.min(p.y, q.y);
  const hi = horizontal ? Math.max(p.x, q.x) : Math.max(p.y, q.y);
  const rLo = horizontal ? r.x : r.y;
  const rHi = horizontal ? r.x + r.w : r.y + r.h;
  if (hi <= rLo || lo >= rHi) return Infinity;
  const c = horizontal ? p.y : p.x;
  const cLo = horizontal ? r.y : r.x;
  const cHi = horizontal ? r.y + r.h : r.x + r.w;
  if (c >= cLo && c <= cHi) return 0;
  return c < cLo ? cLo - c : c - cHi;
}

function bboxOf(rects) {
  if (!rects.length) return null;
  let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity;
  for (const r of rects) {
    x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.w); y2 = Math.max(y2, r.y + r.h);
  }
  return { x: x1, y: y1, w: Math.max(1, x2 - x1), h: Math.max(1, y2 - y1) };
}

/**
 * 量一张场景图的版面指标。
 * @param {object} scene   buildScene() 的输出
 * @param {object} [options]
 * @param {number} [options.alignTol=2]  边界共线的判定容差（像素）
 * @returns {object} 指标表，全部为数值；无节点时各项为 0。
 */
export function measureLayout(scene, options = {}) {
  const tol = Number.isFinite(options.alignTol) ? options.alignTol : 2;
  const nodes = Array.isArray(scene.nodes) ? scene.nodes : [];
  const containers = Array.isArray(scene.containers) ? scene.containers : [];
  const edges = Array.isArray(scene.edges) ? scene.edges : [];
  const frame = scene.frame || scene.canvas || { x: 0, y: 0, w: 1, h: 1 };
  const frameArea = Math.max(1, frame.w * frame.h);

  if (!nodes.length) {
    return Object.fromEntries(LAYOUT_METRICS.map((m) => [m.key, 0]));
  }

  // ---- 面积：卡片铺了多少、内容区有没有缺口 ----
  const inkArea = nodes.reduce((a, n) => a + n.w * n.h, 0);
  const tops = containers.filter((c) => (c.depth ?? 0) === 0);
  // 内容区完整度：顶层容器（没有容器时退化为节点）铺满自己的包围盒了吗。
  // 摊成几条横带时包围盒里会留大片空洞，这个比值掉得很明显；排成等高的几栏时接近 1。
  const units = tops.length ? tops : nodes;
  const unitArea = units.reduce((a, c) => a + c.w * c.h, 0);
  const contentBox = bboxOf(units.concat(nodes));
  const contentFill = unitArea / Math.max(1, contentBox.w * contentBox.h);

  // ---- 走线：绕不绕、折不折 ----
  let len = 0;
  let lower = 0;
  let bends = 0;
  for (const e of edges) {
    const pts = Array.isArray(e.pts) ? e.pts : [];
    if (pts.length < 2) continue;
    len += polylineLength(pts);
    lower += manhattanDistance(pts[0], pts[pts.length - 1]);
    bends += countBends(pts);
  }

  // ---- 对齐：边界共线的比例、同组卡片的宽度档位 ----
  // 四条边各自归桶。分母是「最多可能有多少条对齐关系」= 4 × (节点数 - 1)。
  const L = nodes.map((n) => n.x);
  const R = nodes.map((n) => n.x + n.w);
  const T = nodes.map((n) => n.y);
  const B = nodes.map((n) => n.y + n.h);
  const aligned = alignedCount(L, tol) + alignedCount(R, tol) + alignedCount(T, tol) + alignedCount(B, tol);
  const alignRatio = aligned / Math.max(1, 4 * (nodes.length - 1));

  // 同组等宽：按编组分桶，统计每组里出现了几种宽度、以及组内宽度极差。
  // 取全图最大值——只要有一个编组参差，整张图看上去就不齐。
  const byGroup = new Map();
  for (const n of nodes) {
    const key = qcParentIdOf(n, containers) || '__root__';
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(n.w);
  }
  let widthTiers = 0;
  let widthSpread = 0;
  for (const ws of byGroup.values()) {
    if (ws.length < 2) continue;
    // 跨列长条不算「不等宽」。
    //
    // 这两项守的是**手抖**：准则 6 / 7（同组等宽、右边界优先）已被证伪为拖拽误差，
    // 机器 0:6 完胜人工，所以只作守门。而**刻意拉成的横条是准则 3**，证据 6/8 份日志、
    // 已确认，是要学的东西。把两者混在一个数里，守门项就会把规则本身否掉 ——
    // 实测正是如此：一条 636 宽的横条混在 190 宽的卡片里，widthSpread 886，
    // 远超 vetoTol=2，于是**每一个带横条的候选都被一票否决**，
    // 几何触发的横条从第 1 步起就再没活过，语义触发的也一样。
    //
    // 阈值取台账的长条口径：宽度 ≥ 该组常规宽的 1.5 倍即为长条，从这两项里剔除。
    // 基准取**最窄**的那张，不取中位数：编组只有两张卡时（横条 + 一张普通卡），
    // 中位数会落到横条身上，反过来把普通卡当成异类，长条一张也剔不掉。
    // 台账说的「众数宽」就是常规卡那一档，最窄值是它最稳的代理。
    // 注意 log-02 的 190 / 240 两档是按节点类型分的合法分档（240 < 190×1.5），不会被误剔。
    const base = Math.min(...ws);
    const plain = ws.filter((w) => w < base * 1.5);
    if (plain.length < 2) continue;
    const tiers = plain.length - alignedCount(plain, tol);
    widthTiers = Math.max(widthTiers, tiers);
    widthSpread = Math.max(widthSpread, Math.max(...plain) - Math.min(...plain));
  }

  // 分组间距比：跨编组的缝比编组内部的缝宽多少。间距本身在说明分组 ——
  // 一样宽时「这几张卡是一组」只能靠容器边框去讲。
  const innerGap = []; const outerGap = [];
  for (const axis of ['x', 'y']) {
    const cross = axis === 'x' ? 'y' : 'x';
    const size = axis === 'x' ? 'w' : 'h';
    const crossSize = axis === 'x' ? 'h' : 'w';
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i]; const b = nodes[j];
        // 只看在另一轴上有重叠的一对，斜对角的两张卡之间没有「缝」可言
        if (Math.min(a[cross] + a[crossSize], b[cross] + b[crossSize]) - Math.max(a[cross], b[cross]) < 10) continue;
        const gap = Math.max(a[axis] - (b[axis] + b[size]), b[axis] - (a[axis] + a[size]));
        if (gap < 0) continue;
        (qcParentIdOf(a, containers) === qcParentIdOf(b, containers) ? innerGap : outerGap).push(gap);
      }
    }
  }
  const groupGapRatio = innerGap.length && outerGap.length
    ? Math.min(...outerGap) / Math.max(1, Math.min(...innerGap)) : 0;

  // ---- 走法：边从哪几个面出入、贴不贴卡、起点收不收拢 ----
  // 这一段（连同 segRectClear）并自 scripts/score-tuning-logs.mjs。两套量表并成一套的
  // 理由见 docs/decisions.md 2026-08-16「PR #15 去留清单」：同一件事有两份实现，
  // 两边的数就会各自漂，谁也不能拿来跟谁比。原量表里的「卡尺寸种类」按同一条决定作废
  // ——它把「刻意拉成横条」和「280/280/277 的手抖」混进一个数，方向会学反。
  // 注意（第 10 步束线之后）：束线把同源 / 同汇的几条边收到同一个点，这里仍按几个口子算，
  // 「一边一面」在带束的图上会读低。没有改口径：这项权重 0.742 是在不并线的走线上拟合的，
  // 改定义等于换裁判 —— 实测把「一束算一个口子」放进来会让 17 号（人工说「别动」的那份）
  // 换形状。等台账 R2 重拟权重时一起处理；束线本身不进裁判（见 arch-doc autoLayout）。
  const portsOf = new Map();
  for (const e of edges) {
    for (const [id, port] of [[e.source, e.sourcePort], [e.target, e.targetPort]]) {
      if (!port) continue;
      if (!portsOf.has(id)) portsOf.set(id, []);
      portsOf.get(id).push(port.side);
    }
  }
  let multiPort = 0; let distinctClean = 0; let sidesUsed = 0;
  for (const sides of portsOf.values()) {
    if (sides.length < 2) continue;
    multiPort += 1;
    sidesUsed += new Set(sides).size;
    if (new Set(sides).size === sides.length) distinctClean += 1;
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const inBox = (n, b) => n && n.x + n.w / 2 >= b.x && n.x + n.w / 2 <= b.x + b.w
    && n.y + n.h / 2 >= b.y && n.y + n.h / 2 <= b.y + b.h;
  const boxes = nodes.concat(containers);
  let minClearance = Infinity;
  let throughCards = 0;
  for (const e of edges) {
    const pts = Array.isArray(e.pts) ? e.pts : [];
    for (const b of boxes) {
      // 端点自己、以及「装着端点的那个容器」都不算障碍：边当然要从它们身上出发
      if (b.id === e.source || b.id === e.target) continue;
      if (inBox(byId.get(e.source), b) || inBox(byId.get(e.target), b)) continue;
      let hitCard = false;
      for (let i = 1; i < pts.length; i += 1) {
        const c = segRectClear(pts[i - 1], pts[i], b);
        if (c < minClearance) minClearance = c;
        if (c === 0 && byId.has(b.id)) hitCard = true;
      }
      if (hitCard) throughCards += 1;
    }
  }

  // 共享起点：同一节点的多条边从同一个点出发（±2px）。case-2 的三条决策边同起点
  // x=971 是孙毅确认过的意图，走线器现在只会把它们散开 —— 先量着，第 6 步进候选。
  const originBuckets = new Map();
  for (const e of edges) {
    const pts = Array.isArray(e.pts) ? e.pts : [];
    if (pts.length < 2) continue;
    const key = `${e.source}|${Math.round(pts[0].x / 2)}|${Math.round(pts[0].y / 2)}`;
    originBuckets.set(key, (originBuckets.get(key) || 0) + 1);
  }
  const sharedOrigins = [...originBuckets.values()].filter((n) => n >= 2).length;

  // ---- 相邻直达率：捋直线段 / 有关联的节点摆在一起 ----
  // 2026-08-18 第二批调优日志（tests/fixtures/tuning-logs/round2/）反复印证的准则——
  // notes[] 里孙毅写的最多的一条就是「捋直线段」：人工终稿 150/190=0.79，
  // 引擎自然输出只有 99/190=0.52。一条边算「相邻直达」要满足三件事：
  //   (a) 两端点面对面：在垂直于连线方向的那根轴上有明显重叠（>40% 较窄一方的那段延伸）；
  //   (b) 中间没有别的叶子节点挡道（挡道区域 = 重叠段 × 两者间的空隙）；
  //   (c) 沿垂直轴基本对齐：中心差 ≤6px，或一方中心落进另一方的延伸范围内
  //       （盖住几个兄弟的横/竖长条就是这种情形）。
  // observe：只报数，判别力还没在这批日志上验过，没验过的量不许当裁判——
  // 升不升进 routing 组，等 --validate 攒够统计再定。
  let adjacentCount = 0;
  for (const e of edges) {
    const a = byId.get(e.source);
    const b = byId.get(e.target);
    if (!a || !b || a === b) continue;
    const overlapOn = (axis, size) => Math.min(a[axis] + a[size], b[axis] + b[size]) - Math.max(a[axis], b[axis]);
    const overlapX = overlapOn('x', 'w');
    const overlapY = overlapOn('y', 'h');
    // 面对面：恰好一根轴有重叠（垫在同一带上）、另一根轴有缝（隔开的方向）。
    // 两轴都重叠（矩形相交）或两轴都有缝（斜对角）都不算面对面。
    let axisP; let axisM; // P=垂直轴（有重叠）M=主轴（有缝）
    if (overlapY > 0 && overlapX <= 0) { axisP = 'y'; axisM = 'x'; } else if (overlapX > 0 && overlapY <= 0) { axisP = 'x'; axisM = 'y'; } else continue;
    const sizeP = axisP === 'y' ? 'h' : 'w';
    const sizeM = axisM === 'y' ? 'h' : 'w';
    const overlapP = axisP === 'y' ? overlapY : overlapX;
    if (overlapP <= 0.4 * Math.min(a[sizeP], b[sizeP])) continue;               // (a) 面对面的重叠不够

    const pLo = Math.max(a[axisP], b[axisP]);
    const pHi = Math.min(a[axisP] + a[sizeP], b[axisP] + b[sizeP]);
    const mLo = Math.min(a[axisM] + a[sizeM], b[axisM] + b[sizeM]);
    const mHi = Math.max(a[axisM], b[axisM]);
    const blocked = nodes.some((c) => {
      if (c === a || c === b) return false;
      return c[axisP] + c[sizeP] > pLo && c[axisP] < pHi && c[axisM] + c[sizeM] > mLo && c[axisM] < mHi;
    });
    if (blocked) continue;                                                     // (b) 中间有别的叶子节点挡道

    const centerA = a[axisP] + a[sizeP] / 2;
    const centerB = b[axisP] + b[sizeP] / 2;
    const aligned = Math.abs(centerA - centerB) <= 6
      || (centerA >= b[axisP] && centerA <= b[axisP] + b[sizeP])
      || (centerB >= a[axisP] && centerB <= a[axisP] + a[sizeP]);
    if (!aligned) continue;                                                    // (c) 垂直轴上没对齐

    adjacentCount += 1;
  }

  return {
    inkRatio: r3(inkArea / frameArea),                                   // 卡片总面积 ÷ 外框
    contentFill: r3(contentFill),                                        // 顶层容器面积和 ÷ 内容包围盒
    edgeLength: Math.round(len),                                         // 折线总长
    edgeDetour: r3(lower > 0 ? len / lower : 0),                         // 总长 ÷ 曼哈顿下界（1 为不绕）
    bends,                                                               // 折点总数
    bendsPerEdge: r1(edges.length ? bends / edges.length : 0),
    alignRatio: r3(alignRatio),                                          // 边界共线关系数 ÷ 上限
    widthTiers,                                                          // 单个编组内最多几种卡片宽度
    widthSpread: Math.round(widthSpread),                                // 单个编组内宽度极差（像素）
    groupGapRatio: r3(groupGapRatio),                                    // 跨编组最小缝 ÷ 编组内最小缝
    minClearance: Number.isFinite(minClearance) ? Math.round(minClearance) : 0,  // 边中段离最近非端点盒的距离
    sideDistinct: multiPort ? r3(distinctClean / multiPort) : 0,         // 多边节点里「一边一面」的比例
    portSides: multiPort ? r1(sidesUsed / multiPort) : 0,                // 多边节点平均用了几个面
    throughCards: throughCards,                                          // 边压在非端点卡片上的次数
    sharedOrigins,                                                       // 同节点同起点的边组数
    adjacentStraight: r3(edges.length ? adjacentCount / edges.length : 0), // 相邻直达的边 ÷ 全部边
  };
}

// 指标表：报表与 bench 直接读它，不要各写一份。
//   dir    ↑1 越大越好 / ↓-1 越小越好
//   group  space=铺得满不满 · routing=走线拓扑 · precision=摆得准不准
//
// group 的划分不是拍脑袋，是在 8 份手工调优日志上量出来的
// （scripts/layout-bench.mjs --validate，下面的比分是在 main 当前引擎上重测的）：
//
//   space 三项    人工胜 6:2 / 5:2 / 7:1 —— **当前引擎最大的短板**。质检分已经到 96.3，
//                 而这三项全线落后人工：分组间距比只有 0.957，跨编组的缝比编组内部还窄。
//                 质检对这三项完全无感（checkQuality 的准则表里没有任何一条查它们），
//                 所以「盯着质检分优化」不会改善它们，反而会为了消交叉把编组拆散。
//                 分组间距的实现留在 claude/case-4-optimization-analysis-8867d3 的
//                 GROUP_GAP_SCALE，那套排版改动在当前 main 上实测净劣化，没有合入。
//   routing 两类  走线总长人工胜 7:1，仍是短板；折点数已经追平反超（3:4），
//                 说明走线净空 / 端口分面那几条规则起了作用。
//   precision 三项 autoLayout 胜人工终稿 5~6 / 8 —— 手调够不到像素级精度，
//                 这几项人工反而更差（本人已确认：宽度不等、间距不等是手调误差而非意图）。
//                 只作「不要退化」的守门项，绝不能拿人工终稿当目标。
//
//   observe 三项  走法指标，孙毅第 3 题「走线总长与走法都入围」。**只报数，不进版面分**：
//                 判别力还没验过的量不许当裁判——那正是「卡尺寸种类」犯过的错。
//                 三项 --validate 会照常统计。adjacentStraight（相邻直达率）曾在这一组，
//                 2026-08-18 在 round2 17 份上量出人工 14:0 持平 3 之后升进 routing（见表尾）。
//
// 量过但删掉的：外框利用率（两种对照都是 4:4，无信号）；
// 卡尺寸种类（把「刻意横条」与「3px 手抖」混成一个数，决定见 docs/decisions.md 2026-08-16）。
export const LAYOUT_METRICS = Object.freeze([
  { key: 'inkRatio', label: '卡片墨水占比', dir: 1, group: 'space' },
  { key: 'contentFill', label: '内容区完整度', dir: 1, group: 'space' },
  { key: 'groupGapRatio', label: '分组间距比', dir: 1, group: 'space' },
  { key: 'edgeLength', label: '走线总长', dir: -1, group: 'routing' },
  { key: 'edgeDetour', label: '绕行倍率', dir: -1, group: 'routing' },
  { key: 'bends', label: '折点总数', dir: -1, group: 'routing' },
  { key: 'bendsPerEdge', label: '每条边折点', dir: -1, group: 'routing' },
  { key: 'minClearance', label: '最小净空', dir: 1, group: 'routing' },      // 来源 PR #15
  { key: 'sideDistinct', label: '一边一面', dir: 1, group: 'routing' },      // 来源 PR #15
  // precision 组带 vetoTol 的项才参与否决；单位不一样（档数 / 像素），
  // 拿同一个数去比是错的，所以容差写在表里而不是埋进代码。
  //
  // alignRatio **不带 vetoTol，不参与否决** —— 这是第 4 步踩出来的。
  // 它是全图的边界共线比例，会随「摆成几列」天然变化：竖排比横排更容易对齐，
  // 差个 0.09 是形状不同，不是谁更潦草。带 0.02 的容差去否决，结果是形状搜索的
  // 四个变体里三个被它一票否掉，最后按 alignRatio 单项选，版面分完全失效
  // （case-04 实测选中版面分 0.076 的那个，而最好的是 0.878）。
  // 否决项要盯的是「机器本来就该做到、且与形状无关」的事 —— 那是下面两项：同组等宽。
  { key: 'alignRatio', label: '边界共线率', dir: 1, group: 'precision' },
  { key: 'widthTiers', label: '组内宽度档位', dir: -1, group: 'precision', vetoTol: 1 },
  { key: 'widthSpread', label: '组内宽度极差', dir: -1, group: 'precision', vetoTol: 2 },
  { key: 'portSides', label: '接口面数', dir: 1, group: 'observe' },
  { key: 'throughCards', label: '穿卡数', dir: -1, group: 'observe' },
  { key: 'sharedOrigins', label: '共享起点数', dir: 1, group: 'observe' },
  // 相邻直达率：2026-08-18 从第二批调优日志读出来的准则（「捋直线段 / 有关联的节点摆在一起」）。
  // 判别力在 round2 17 份上量过：人工终稿 vs 引擎重跑 **14 : 0，持平 3**（07 / 12 / 19），
  // 是所有指标里最一边倒的一项，按台账规矩升进 routing 组、权重由 fit-layout-weights 拟合。
  { key: 'adjacentStraight', label: '相邻直达率', dir: 1, group: 'routing' },
]);

// 分组的用法，三条互斥的规矩（scoreLayout 与候选挑选都按它走）：
//   space / routing  进加权和，权重由判别力算出来
//   precision        不进加权和，只作否决：比候选集里最好的差出 alignTol 即淘汰
//   observe          既不加权也不否决，只出现在报表里
export const SCORED_GROUPS = Object.freeze(['space', 'routing']);
// 版面分里一项的候选间极差小于最大值的这个比例时视为打平（2026-08-18 第 14 步，见 scoreLayout）
export const SCORE_NOISE_REL = 0.05;
export const VETO_GROUP = 'precision';

/**
 * 版面分：**只在同一份 spec 的候选之间**比较，绝不跨 spec 比。
 *
 * 为什么必须要有 peers：这些量没有绝对判据。0.223 的墨水占比既不好也不坏，
 * 只有「同一张图的另一种排法是 0.19」才说明问题。归一化因此拿候选集自己的
 * min/max 做基准，而不是任何写死的量程——写死量程等于偷偷引入了绝对判据。
 *
 * 与质检分永不相加（docs/handoff-质检分与版面分.md 5.2）：相加就等于给
 * 「没有绝对判据的量」硬安一个绝对判据，那正是现在这套「质检分 + 一个 medium
 * 容差」补丁的由来。质检当门禁，版面分只在过了门禁的候选之间排序。
 *
 * @param {object} metrics  被打分的候选（measureLayout 的输出）
 * @param {object[]} peers  同一份 spec 的全部候选（含 metrics 自己）
 * @param {object} weights  指标 → 权重，来自 tests/fixtures/layout-weights.json
 * @returns {number|null} 0..1；候选不足两个时返回 null，调用方退回质检分
 */
export function scoreLayout(metrics, peers, weights) {
  if (!metrics || !Array.isArray(peers) || peers.length < 2) return null;
  let sum = 0;
  let total = 0;
  for (const m of LAYOUT_METRICS) {
    if (!SCORED_GROUPS.includes(m.group)) continue;
    const w = Number(weights && weights[m.key]) || 0;
    if (w <= 0) continue;
    const vals = peers.map((p) => Number(p[m.key])).filter(Number.isFinite);
    if (!vals.length) continue;
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    // 全体候选在这一项上打平：它区分不了任何东西，不该稀释别的项的话语权。
    // 「打平」按相对量看（SCORE_NOISE_REL）：min/max 归一化会把 1.00 : 1.03 的分组间距比放大成
    // 0 : 1、白送 0.6 的权重 —— case-04 的 cols1（墨水 0.054，卡缩到一半）就是靠这 3% 赢的。
    // 差距小于噪声档的项一律不计，与 precision 组的 vetoTol 是同一个道理：不拿噪声当判据。
    if (hi - lo <= SCORE_NOISE_REL * Math.max(Math.abs(hi), Math.abs(lo), 1e-9)) continue;
    const norm = (Number(metrics[m.key]) - lo) / (hi - lo);
    sum += w * (m.dir > 0 ? norm : 1 - norm);
    total += w;
  }
  return total > 0 ? sum / total : null;
}

/**
 * precision 组否决：这几项上机器本来就赢人工（0:6、1:5），学过去是退化，
 * 所以它们不进加权和，只作「不许比候选集里最好的差出太多」的淘汰线。
 * 容差取各指标自己的 vetoTol。
 * @returns {boolean} true = 该淘汰
 */
export function vetoedByPrecision(metrics, peers) {
  if (!metrics || !Array.isArray(peers) || peers.length < 2) return false;
  for (const m of LAYOUT_METRICS) {
    // 只有显式声明了 vetoTol 的项才参与否决 —— 没声明的（如 alignRatio）只报数
    if (m.group !== VETO_GROUP || !Number.isFinite(m.vetoTol)) continue;
    const vals = peers.map((p) => Number(p[m.key])).filter(Number.isFinite);
    if (!vals.length) continue;
    const best = m.dir > 0 ? Math.max(...vals) : Math.min(...vals);
    const gap = (best - Number(metrics[m.key])) * m.dir;   // >0 表示比最好的差
    if (gap > (m.vetoTol ?? 0) + 1e-9) return true;
  }
  return false;
}
