// lib/quality-checker.mjs [INLINE] —— 质量检查（契约 §3，PRD §2.2/§2.7）
// 只允许 import ./geometry-utils.mjs 与 ./text-metrics.mjs；无 DOM 依赖；ES2019。
import { aabbIntersects, aabbOverlapArea, rectContains, segmentsIntersect, segmentIntersectsRect, polylineLength, manhattanDistance, countBends, expandRect } from './geometry-utils.mjs';
import { estimateTextWidth, textFontOf } from './text-metrics.mjs';

// 判断「一张架构图是否合理」的唯一一份准则：生成器、只读产物、工作台都读这里。
// 工作台侧原本另有一套简化判断（重叠 / 越界 / 裁切 / 孤立 / 穿越），已合并进本文件；
// 「一键规整」排版时用的阈值也取自这里（lib/arch-doc.mjs 的 autoLayout），
// 不要再在别处新写一套阈值——需要按渲染器差异调整的，用 options 覆盖（见 skinQualityOptions
// 与 lib/arch-doc.mjs 的 qualityOptionsOf）。
//
// 带 ← 结构 token 标记的项由生成器从皮肤的第一层 token 推导后传入（lib/skins.mjs METRICS_SPEC）；
// 这里的默认值只是脱离生成器单独调用时的兜底，改皮肤请改 token，不要改这里。
export const QUALITY_RULES = Object.freeze({
  nodeLabelPx: 24,        // ← typeNode      节点标签字号
  nodeSubPx: 20,          // ← typeSmall     副标签字号
  nodePaddingX: 28,       // ← cardPadX      节点水平内边距（单侧）
  nodePadY: 16,           // ← skinLayout().padY  纵向留白扣减量
  labelSubGap: 5,         // ← labelSubGap   标签与副标签间距
  lineHeight: 1.15,       // ← LINE_H        文本行高系数
  iconTopHeight: 34,      // ← iconSizeTop + iconGapTop  顶置图标占用的垂直空间
  minSpacing: 20,         // 同容器内叶子节点最小边距（24 → 20，决定见 docs/decisions.md 2026-08-16）
  boundsTolerance: 2,     // 节点越界容差
  containerMargin: 12,    // 子节点距容器边最小距离
  maxBends: 3,            // 单条边最大转折点数
  detourRatio: 1.8,       // 路径长 / 曼哈顿距离阈值
  detourMinLength: 120,   // detour 只检查路径长超过该值的边
  edgeNodeInset: 2,       // 边穿节点检测时节点内缩量（外扩 -2px）
  sharedPortRadius: 30,   // 共享端点边对: 距共享节点该半径内的交点视为正常汇入, 之外报交叉
  collinearGap: 3,        // 共线重叠判定: 两平行段垂直距离阈值
  collinearMinOverlap: 40,// 共线重叠判定: 报告所需的最小重叠长度
  bundlePointTol: 6,      // 同束判定: 同源/同汇的两条边在共享节点上端点相距 ≤ 此值视为同一个点（最小轨距 12 的一半）
  intrusionMin: 3,        // 非成员节点与容器边界重叠的最小侵入深度
  labelEndpointIntrusion: 3, // 边标签压住自身端点卡片的最小侵入深度（同 intrusionMin 的口径）
  iconLeftWidth: 36,      // ← iconSize + iconGapX  icon-left 占用的水平空间
  nodeBorderPx: 1.5,      // 卡片单边边框宽度：border-box 下它吃掉的是内容宽高，不计入会高估可用空间
  labelWrap: true,        // 渲染器是否允许标签折行：false 时超宽即截断（编辑器的卡片是 nowrap + ellipsis）
  arrowClearPx: 12,       // ← edgeWeight().headLen   箭头长度：沿末段方向从端点向后占用的长度
  arrowHalfPx: 6,         // ← edgeWeight().headHalf  箭头半高（垂直于线方向的半宽）
});

// ---- 束线（同束边对）的几何判定，质检与标签落位（arch-doc 的 relaxEdgeLabels）共用同一把尺 ----
// 同束：两条边在同一个节点上角色相同（同源或同汇——一出一入经同一节点不算），在那个节点上
// 从同一个点出发 / 汇入（±tol），且紧挨节点的那一段同轴（沿同一条线出发 / 汇入才是一股主干，
// 贴着角从两个面出去的不算）。tol 取 QUALITY_RULES.bundlePointTol。
const qcSameAxisNear = (a1, a2, b1, b2, tol) => {
  const aH = Math.abs(a1.y - a2.y) <= 0.5, bH = Math.abs(b1.y - b2.y) <= 0.5;
  const aV = Math.abs(a1.x - a2.x) <= 0.5, bV = Math.abs(b1.x - b2.x) <= 0.5;
  if (aH && bH) return Math.abs(a1.y - b1.y) <= tol;
  if (aV && bV) return Math.abs(a1.x - b1.x) <= tol;
  return false;
};
const qcEndSeg = (e, role) => {
  const pts = Array.isArray(e.pts) ? e.pts : [];
  if (pts.length < 2 || e.source === e.target) return null;
  return role === 'source' ? [pts[0], pts[1]] : [pts[pts.length - 1], pts[pts.length - 2]];
};
export function edgesBundled(e1, e2, tol = QUALITY_RULES.bundlePointTol) {
  if (!e1 || !e2 || e1.id === e2.id) return false;
  const roles = [];
  if (e1.source === e2.source) roles.push('source');
  if (e1.target === e2.target) roles.push('target');
  for (const role of roles) {
    const a = qcEndSeg(e1, role), b = qcEndSeg(e2, role);
    if (!a || !b) continue;
    if (Math.abs(a[0].x - b[0].x) <= tol && Math.abs(a[0].y - b[0].y) <= tol
      && qcSameAxisNear(a[0], a[1], b[0], b[1], tol)) return true;
  }
  return false;
}
// 齿根：交点 p 贴着某一条边这一段的端点（≤ tol），且该端点相邻的另一段与对方被交的那段同轴、
// 垂距 ≤ tol —— 即这条边在这里刚从主干上拐出来，主干与对方那段本是同一条线。
export function bundleJunctionAt(e1, s1, e2, s2, p, tol = QUALITY_RULES.bundlePointTol) {
  const near = (a, b) => Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol;
  const check = (e, s, other, os) => {
    const pts = e.pts;
    const o1 = other.pts[os], o2 = other.pts[os + 1];
    if (near(p, pts[s]) && s > 0 && qcSameAxisNear(pts[s - 1], pts[s], o1, o2, tol)) return true;
    if (near(p, pts[s + 1]) && s + 2 < pts.length && qcSameAxisNear(pts[s + 1], pts[s + 2], o1, o2, tol)) return true;
    return false;
  };
  return check(e1, s1, e2, s2) || check(e2, s2, e1, s1);
}
// other 的第 s 段是不是两条边共有的主干（与 e 的某一段同轴且垂距 ≤ tol），或是从 e 的线上
// 分出去 / 汇进来的那一根齿（它的一端落在 e 的某一段上）。齿根压在标签底下读者仍能看出
// 标签属于哪条线；只有与 e 平行、不相接的同伴支线才算被误读的那种压线（17 号「战绩 / 结算掉落」）。
const qcPointOnSeg = (p, a, b, tol) => {
  const minX = Math.min(a.x, b.x) - tol, maxX = Math.max(a.x, b.x) + tol;
  const minY = Math.min(a.y, b.y) - tol, maxY = Math.max(a.y, b.y) + tol;
  if (p.x < minX || p.x > maxX || p.y < minY || p.y > maxY) return false;
  if (Math.abs(a.y - b.y) <= 0.5) return Math.abs(p.y - a.y) <= tol;   // 横段
  if (Math.abs(a.x - b.x) <= 0.5) return Math.abs(p.x - a.x) <= tol;   // 竖段
  return false;
};
export function segmentOnSharedTrunk(e, other, s, tol = QUALITY_RULES.bundlePointTol) {
  const o1 = other.pts[s], o2 = other.pts[s + 1];
  for (let i = 0; i < e.pts.length - 1; i += 1) {
    if (qcSameAxisNear(e.pts[i], e.pts[i + 1], o1, o2, tol)) return true;
    if (qcPointOnSeg(o1, e.pts[i], e.pts[i + 1], tol) || qcPointOnSeg(o2, e.pts[i], e.pts[i + 1], tol)) return true;
  }
  return false;
}

export const QC_SEVERITY_WEIGHTS = Object.freeze({ critical: 15, high: 8, medium: 4, low: 1 });

// 节点出框的阶梯罚分：critical 平权 15 分对量级钝感——手调日志 02 里「名单服务」出框 91px
// 与反事实的 149px 同分，评分器分不出「差一点」与「差很多」。罚分从 critical 基础分起步，
// 溢出每满 bandPx 加一档 step，封顶 base + maxExtra（越界再大，图也只是废一次，不许炸穿总分）。
export const QC_OOB_PENALTY = Object.freeze({ bandPx: 40, step: 5, maxExtra: 20 });

export function qcOobPenalty(overflowPx) {
  const base = QC_SEVERITY_WEIGHTS.critical;
  if (!Number.isFinite(overflowPx) || overflowPx <= 0) return base;
  const extra = Math.floor(overflowPx / QC_OOB_PENALTY.bandPx) * QC_OOB_PENALTY.step;
  return base + Math.min(QC_OOB_PENALTY.maxExtra, extra);
}

// 矩形越出 frame 的最大溢出量（四个方向取最大；未越出返回 0）
const qcFrameOverflow = (rect, frame) => Math.max(
  frame.x - rect.x,
  frame.y - rect.y,
  (rect.x + rect.w) - (frame.x + frame.w),
  (rect.y + rect.h) - (frame.y + frame.h),
  0,
);

const qcRectGap = (a, b) => {
  const gx = Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w), 0);
  const gy = Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h), 0);
  return Math.hypot(gx, gy);
};

const qcCenterInRect = (node, rect) => {
  const cx = node.x + node.w / 2;
  const cy = node.y + node.h / 2;
  return cx >= rect.x && cx <= rect.x + rect.w && cy >= rect.y && cy <= rect.y + rect.h;
};

// 「节点属于哪个编组」只有这一份口径，lib/layout-metrics.mjs 也读它 —— 各写一份必然漂移。
export const qcParentIdOf = (node, containers) => {
  // 取包含节点中心的最深容器（depth 最大；同深取面积最小）；无则 null
  let best = null;
  for (const c of containers) {
    if (!qcCenterInRect(node, c)) continue;
    if (!best) { best = c; continue; }
    const bestDepth = best.depth ?? 0;
    const currDepth = c.depth ?? 0;
    if (currDepth > bestDepth || (currDepth === bestDepth && c.w * c.h < best.w * best.h)) best = c;
  }
  return best ? best.id : null;
};

// 文字估宽的尺子只有一把：lib/text-metrics.mjs 的 estimateTextWidth（真浏览器标定的逐字形表，
// 2026-09-13 起）。本模块不再自己定义；内联作用域下由 text-metrics 定义同名函数，它排在本模块之前。
// 字体按 options.skinId × 角色取（textFontOf），没传皮肤就用默认组。

// 变体/图标感知的标签可用宽度（与渲染器口径一致，修 P1#8）
const qcLabelAvailWidth = (n, opts) => {
  // 运行时解出的实际内边距优先；边框在 border-box 下占用内容宽，两侧都要扣
  const padX = Number.isFinite(n.padX) ? n.padX : opts.nodePaddingX;
  // 边框宽：场景节点带 borderPx（buildScene 按皮肤 × 变体取，与 node-fit 求解同源）就用它，没有再退到选项
  const border = (Number.isFinite(n.borderPx) ? n.borderPx : (opts.nodeBorderPx || 0)) * 2;
  let avail = n.w - border - padX * 2;
  if (n.variant === 'decision') avail = n.w * 0.6 - 8;       // 菱形中线可用宽
  else if (n.variant === 'circle') avail = n.w * 0.75 - border;  // 圆内接近似
  if (n.icon && n.icon.position !== 'top') avail -= opts.iconLeftWidth;
  return Math.max(20, avail);
};

// 估宽是近似值: 超出可用宽 2% 以内视为"能挤下一行"，不预测折行（避免边缘性误报）。
// 尺子标定前是 8%（旧口径对 Latin 差可达 12px 以上）；标定后含 Latin 的标签 p95 差 < 4px，收到 2%。
const QC_WRAP_TOLERANCE = 1.02;
const qcPredictLines = (textW, availW) => (textW > availW * QC_WRAP_TOLERANCE ? Math.ceil(textW / availW) : 1);

// 轴对齐线段的共线重叠长度（不共线或垂直距离超过 gap 返回 0）
const qcCollinearOverlap = (p1, p2, p3, p4, gap) => {
  const h1 = Math.abs(p1.y - p2.y) <= 0.5;
  const h2 = Math.abs(p3.y - p4.y) <= 0.5;
  const v1 = Math.abs(p1.x - p2.x) <= 0.5;
  const v2 = Math.abs(p3.x - p4.x) <= 0.5;
  if (h1 && h2 && Math.abs(p1.y - p3.y) <= gap) {
    const lo = Math.max(Math.min(p1.x, p2.x), Math.min(p3.x, p4.x));
    const hi = Math.min(Math.max(p1.x, p2.x), Math.max(p3.x, p4.x));
    return Math.max(0, hi - lo);
  }
  if (v1 && v2 && Math.abs(p1.x - p3.x) <= gap) {
    const lo = Math.max(Math.min(p1.y, p2.y), Math.min(p3.y, p4.y));
    const hi = Math.min(Math.max(p1.y, p2.y), Math.max(p3.y, p4.y));
    return Math.max(0, hi - lo);
  }
  return 0;
};

export function checkQuality(scene, options = {}) {
  const opts = Object.assign({}, QUALITY_RULES, options);
  const canvas = (scene && scene.canvas) || { w: 1920, h: 1080 };
  const canvasRect = { x: 0, y: 0, w: canvas.w, h: canvas.h };
  const frame = scene ? scene.frame : null;
  const nodes = scene && Array.isArray(scene.nodes) ? scene.nodes : [];
  const containers = scene && Array.isArray(scene.containers) ? scene.containers : [];
  const edges = scene && Array.isArray(scene.edges) ? scene.edges : [];

  const issues = [];
  const seenIds = new Set();
  // metrics: 结构化量值（如 { overflowPx }），penalty: 覆盖 severity 平权的定制罚分
  const addIssue = (type, severity, category, elements, description, suggestion, autoFixable, position, metrics, penalty) => {
    const id = `${type}:${elements.join('+')}`;
    if (seenIds.has(id)) return;
    seenIds.add(id);
    const issue = { id, severity, category, type, description, affectedElements: elements.slice(), suggestion, autoFixable };
    if (position) issue.position = position;
    if (metrics) issue.metrics = metrics;
    if (Number.isFinite(penalty)) issue.penalty = penalty;
    issues.push(issue);
  };

  const nodeName = (n) => String(n.label || n.id);
  const parentIds = new Map();
  for (const n of nodes) parentIds.set(n.id, qcParentIdOf(n, containers));

  // ---- 节点检查 ----------------------------------------------------------
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i];
      const b = nodes[j];
      const area = aabbOverlapArea(a, b);
      if (area > 0) {
        // overlap / critical
        addIssue('overlap', 'critical', 'node', [a.id, b.id],
          `节点 "${nodeName(a)}" 与 "${nodeName(b)}" 重叠（重叠面积 ${Math.round(area)}px²）`,
          `沿最小重叠轴分离两个节点并保持 ${opts.minSpacing}px 间距`,
          true,
          {
            x: (Math.max(a.x, b.x) + Math.min(a.x + a.w, b.x + b.w)) / 2,
            y: (Math.max(a.y, b.y) + Math.min(a.y + a.h, b.y + b.h)) / 2,
          });
      } else if (parentIds.get(a.id) === parentIds.get(b.id)) {
        // spacing / medium（同容器内才检，且不重叠）
        const gap = qcRectGap(a, b);
        if (gap < opts.minSpacing) {
          addIssue('spacing', 'medium', 'node', [a.id, b.id],
            `节点 "${nodeName(a)}" 与 "${nodeName(b)}" 间距 ${gap.toFixed(1)}px，小于最小间距 ${opts.minSpacing}px`,
            `将两个节点推开至至少 ${opts.minSpacing}px 间距`,
            true);
        }
      }
    }
  }
  if (frame) {
    for (const n of nodes) {
      // out_of_bounds / critical（容差 2px）——罚分随出框量走阶梯（见 qcOobPenalty）
      if (!rectContains(frame, n, -opts.boundsTolerance)) {
        const overflowPx = Math.round(qcFrameOverflow(n, frame));
        addIssue('out_of_bounds', 'critical', 'node', [n.id],
          `节点 "${nodeName(n)}" 超出架构图外框 ${overflowPx}px（容差 ${opts.boundsTolerance}px）`,
          `将节点移回外框内并保留 ${opts.containerMargin}px 边距`,
          true,
          { x: n.x + n.w / 2, y: n.y + n.h / 2 },
          { overflowPx },
          qcOobPenalty(overflowPx));
      }
    }
  }

  // ---- 标签检查（换行感知，修 P1#8） -------------------------------------
  for (const n of nodes) {
    // 运行时的阶梯自适应已按浏览器实测折行求解过一遍，直接采信它的结论，
    // 不再用估算宽度重推一遍（两套口径不一致正是此前 clipping 误报的来源）。
    // 构建期没有 DOM，n.fit 缺席，走下面的估算路径。
    if (n.fit && typeof n.fit === 'object') {
      const fitLines = Number.isFinite(n.fit.lines) ? n.fit.lines : 1;
      const fitSubLines = Number.isFinite(n.fit.subLines) ? n.fit.subLines : 0;
      if (n.fit.overflow) {
        addIssue('clipping', 'high', 'label', [n.id],
          `节点 "${nodeName(n)}" 降到最小字号仍放不下，文字已被截断${n.fit.dropSub ? '（副标签已隐藏）' : ''}`,
          '增大节点尺寸或精简文字',
          false,
          { x: n.x + n.w / 2, y: n.y + n.h / 2 });
      } else if (fitLines > 1 || fitSubLines > 1) {
        addIssue('clipping', 'low', 'label', [n.id],
          `节点 "${nodeName(n)}" 文字折行显示（标签 ${fitLines} 行${fitSubLines > 1 ? `, 副标签 ${fitSubLines} 行` : ''}）`,
          '如需单行显示可缩短文字或增大节点宽度',
          false);
      }
      continue;
    }
    const availW = qcLabelAvailWidth(n, opts);
    // 运行时会按外框缩放自适应字号并写回 labelPx/subPx；没有就按生成基准字号算
    const labelPx = Number.isFinite(n.labelPx) ? n.labelPx : opts.nodeLabelPx;
    const subPx = Number.isFinite(n.subPx) ? n.subPx : opts.nodeSubPx;
    const labelW = estimateTextWidth(n.label, labelPx, textFontOf(opts.skinId, 'label'));
    const subW = n.sublabel ? estimateTextWidth(n.sublabel, subPx, textFontOf(opts.skinId, 'sub')) : 0;
    const labelLines = qcPredictLines(labelW, availW);
    const subLines = subW > 0 ? qcPredictLines(subW, availW) : 0;
    if (!opts.labelWrap) {
      // 不折行的渲染器（编辑器卡片是 nowrap + ellipsis）：超宽的后果是截断，不是变高
      const over = Math.max(labelW, subW) - availW;
      if (labelLines > 1 || subLines > 1) {
        addIssue('clipping', 'medium', 'label', [n.id],
          `节点 "${nodeName(n)}" 文字比可用宽度多出约 ${Math.round(over)}px，单行渲染下会被截断`,
          '增大节点宽度或精简文字',
          false,
          { x: n.x + n.w / 2, y: n.y + n.h / 2 });
      }
      continue;
    }
    const lineH = labelPx * opts.lineHeight;
    const subLineH = subPx * opts.lineHeight;
    const totalTextH = labelLines * lineH + subLines * subLineH + (subLines ? opts.labelSubGap : 0);
    const innerH = n.h - opts.nodePadY - (n.icon && n.icon.position === 'top' ? opts.iconTopHeight : 0);
    const wrapped = labelLines > 1 || subLines > 1; // 未折行的文本不会被纵向裁切
    if (wrapped && totalTextH > innerH) {
      // 折行后仍纵向溢出 → 明显溢出报 high, 轻微溢出报 medium
      const severe = totalTextH > innerH + lineH * 0.5;
      addIssue('clipping', severe ? 'high' : 'medium', 'label', [n.id],
        `节点 "${nodeName(n)}" 文字折行后约需 ${Math.round(totalTextH)}px, 超出节点内高 ${Math.round(innerH)}px（标签约 ${labelLines} 行${subLines ? ` + 副标签约 ${subLines} 行` : ''}）`,
        '增大节点尺寸或精简文字',
        false,
        { x: n.x + n.w / 2, y: n.y + n.h / 2 });
    } else if (labelLines > 1 || subLines > 1) {
      // 能装下但会折行 → 仅提示
      addIssue('clipping', 'low', 'label', [n.id],
        `节点 "${nodeName(n)}" 文字超宽将自动折行（标签约 ${labelLines} 行${subLines > 1 ? `, 副标签约 ${subLines} 行` : ''}）`,
        '如需单行显示可缩短文字或增大节点宽度',
        false);
    }
  }
  const labeledEdges = edges.filter((e) => e && e.label && Number.isFinite(e.label.x));
  for (const e of labeledEdges) {
    // clipping / high：边标签越出 canvas
    if (!rectContains(canvasRect, e.label, 0)) {
      addIssue('clipping', 'high', 'label', [e.id],
        `边 ${e.id} 的标签 "${e.label.text ?? ''}" 超出画布`,
        '将标签移回画布内或缩短标签文字',
        false,
        { x: e.label.x, y: e.label.y });
    }
    // overlap / high：边标签与非端点节点相交
    // 端点不能一刀切豁免：标签贴着自己的端点是常态，整片压上去不是。标签是不透明 chip
    // （见 lib/skins.mjs 各皮肤的 .edge-label），压进卡片就是在卡面上挖一个白洞。
    // 按侵入深度分档，口径同上面的 intrusionMin —— 擦边放过，压进去才报。
    const endpointHits = [];
    for (const n of nodes) {
      if (!aabbIntersects(e.label, n)) continue;
      if (n.id !== e.source && n.id !== e.target) {
        addIssue('overlap', 'high', 'label', [e.id, n.id],
          `边 ${e.id} 的标签与节点 "${nodeName(n)}" 相交`,
          '调整标签位置或为标签添加不透明底色',
          false,
          { x: e.label.x, y: e.label.y });
        continue;
      }
      const ow = Math.min(n.x + n.w, e.label.x + e.label.w) - Math.max(n.x, e.label.x);
      const oh = Math.min(n.y + n.h, e.label.y + e.label.h) - Math.max(n.y, e.label.y);
      const depth = Math.min(ow, oh);
      if (depth >= opts.labelEndpointIntrusion) endpointHits.push({ node: n, depth });
    }
    if (endpointHits.length) {
      // 一条边最多压住两个端点，而这是同一处缺陷（通道不够宽 / 落点不对），一次修改一起消失。
      // 拆成两条会让「标签卡在窄通道里向两侧均匀外溢」这种最常见的形态被扣两次分，故合并上报。
      const deepest = endpointHits.reduce((a, b) => (b.depth > a.depth ? b : a));
      addIssue('overlap', 'medium', 'label', [e.id, ...endpointHits.map((h) => h.node.id)],
        `边 ${e.id} 的标签压住端点卡片 ${endpointHits.map((h) => `"${nodeName(h.node)}"`).join(' 与 ')}（侵入 ${Math.round(deepest.depth)}px）`,
        '加宽走线通道或沿线移动标签，让标签与端点卡片脱开',
        false,
        { x: e.label.x, y: e.label.y });
    }
  }
  // ---- 束线（同束边对）----------------------------------------------------
  // 第二轮调优日志（2026-08-18）里出现最多的手法之一是「三线合一」：同源 / 同汇的几条边并成
  // 一股主干再梳齿分开（15 号三处、11 号三个渠道并入订单中心、05 号「让 A 到 BC 的两条线重合」）。
  // 老口径把并线之后的标签相叠 / 标签压同伴的线 / 齿根处的交叉全按缺陷算，15 号手调
  // 终稿因此 100 → 64。
  // 同束的判据（故意收得窄，只认人工与走线器都会画出来的那一种形态）：
  //   两条边在同一个节点上**角色相同**（同源或同汇——一出一入经同一节点不算），
  //   在那个节点上从同一个点出发 / 汇入（±bundlePointTol：11 号手调三条边汇入点差 4px，
  //   是手的精度，视觉上就是一个点），且紧挨节点的那一段同轴（沿同一条线出发 / 汇入才是
  //   一股主干，贴着角从两个面出去的不算）。
  // 同束之内的豁免也只豁免束本身：
  //   · 交叉：只免「齿根接主干」那一处（交点贴着某条边的拐点，且拐点另一侧那段与对方被交段
  //     近共线）——那是主干手抖偏几个像素造成的伪交叉；离主干远的真 X 形照报；
  //   · 标签压同伴的线：只免压在两条边共有的主干段上；压在同伴的支线上照报；
  //   · 标签相叠：文字相同降为 low（视觉上就是一枚标签），文字不同降为 medium（下面那枚仍被盖住）。
  const qcBundleCache = new Map();
  const qcBundled = (e1, e2) => {
    if (!e1 || !e2 || e1.id === e2.id) return false;
    const key = e1.id < e2.id ? `${e1.id}|${e2.id}` : `${e2.id}|${e1.id}`;
    if (!qcBundleCache.has(key)) qcBundleCache.set(key, edgesBundled(e1, e2, opts.bundlePointTol));
    return qcBundleCache.get(key);
  };
  const qcTrunkJunction = (e1, s1, e2, s2, p) => bundleJunctionAt(e1, s1, e2, s2, p, opts.bundlePointTol);
  const qcOnSharedTrunk = (e, other, s) => segmentOnSharedTrunk(e, other, s, opts.bundlePointTol);

  for (let i = 0; i < labeledEdges.length; i += 1) {
    for (let j = i + 1; j < labeledEdges.length; j += 1) {
      // overlap / high：两个边标签相交（同束降为 low）
      const e1 = labeledEdges[i];
      const e2 = labeledEdges[j];
      if (aabbIntersects(e1.label, e2.label)) {
        const bundled = qcBundled(e1, e2);
        const sameText = bundled && String(e1.label.text) === String(e2.label.text);
        addIssue('overlap', bundled ? (sameText ? 'low' : 'medium') : 'high', 'label', [e1.id, e2.id],
          bundled
            ? (sameText ? `同束同文的边 ${e1.id} 与边 ${e2.id} 的标签相叠，视觉上是一枚标签` : `同束的边 ${e1.id} 与边 ${e2.id} 的标签相叠，下面那枚被盖住`)
            : `边 ${e1.id} 与边 ${e2.id} 的标签相交`,
          bundled ? '把标签挪到各自的分支段上' : '偏移其中一个标签',
          false,
          { x: e1.label.x, y: e1.label.y });
      }
    }
  }

  // ---- 连线检查 ----------------------------------------------------------
  const routedEdges = edges.filter((e) => e && Array.isArray(e.pts) && e.pts.length >= 2);
  const rectById = new Map();
  for (const n of nodes) rectById.set(n.id, n);
  for (const c of containers) if (!rectById.has(c.id)) rectById.set(c.id, c);
  const qcNearRect = (pt, id, radius) => {
    const r = rectById.get(id);
    if (!r) return false;
    return pt.x >= r.x - radius && pt.x <= r.x + r.w + radius
        && pt.y >= r.y - radius && pt.y <= r.y + r.h + radius;
  };
  const qcEdgeDesc = (e) => e.label && e.label.text ? `${e.id}(${e.label.text})` : e.id;
  for (let i = 0; i < routedEdges.length; i += 1) {
    for (let j = i + 1; j < routedEdges.length; j += 1) {
      const e1 = routedEdges[i];
      const e2 = routedEdges[j];
      const sharedIds = [];
      for (const id of [e1.source, e1.target]) {
        if (id === e2.source || id === e2.target) sharedIds.push(id);
      }
      // proper 交叉：共享端点的边对不再整对豁免——只豁免共享节点附近的正常汇入交点（修 P0#4）
      let hit = null;
      const bundled = qcBundled(e1, e2);
      for (let s1 = 0; s1 < e1.pts.length - 1 && !hit; s1 += 1) {
        for (let s2 = 0; s2 < e2.pts.length - 1 && !hit; s2 += 1) {
          const p = segmentsIntersect(e1.pts[s1], e1.pts[s1 + 1], e2.pts[s2], e2.pts[s2 + 1]);
          if (p && sharedIds.some((id) => qcNearRect(p, id, opts.sharedPortRadius))) continue;
          // 同束：只免齿根接主干那一处（主干手抖偏几个像素造成的伪交叉），远处的真 X 照报
          if (p && bundled && qcTrunkJunction(e1, s1, e2, s2, p)) continue;
          hit = p;
        }
      }
      if (hit) {
        addIssue('crossing', 'medium', 'edge', [e1.id, e2.id],
          `边 ${qcEdgeDesc(e1)} 与边 ${qcEdgeDesc(e2)} 交叉`,
          '重新路由其中一条边或添加桥接标记',
          false, hit);
      }
      // 共线重叠：两条无共享端点的边大段重叠, 视觉合并不可辨（修 P0#4）
      if (!sharedIds.length) {
        let overlapLen = 0;
        for (let s1 = 0; s1 < e1.pts.length - 1; s1 += 1) {
          for (let s2 = 0; s2 < e2.pts.length - 1; s2 += 1) {
            overlapLen = Math.max(overlapLen, qcCollinearOverlap(
              e1.pts[s1], e1.pts[s1 + 1], e2.pts[s2], e2.pts[s2 + 1], opts.collinearGap));
          }
        }
        if (overlapLen > opts.collinearMinOverlap) {
          addIssue('overlap', 'medium', 'edge', [e1.id, e2.id],
            `边 ${qcEdgeDesc(e1)} 与边 ${qcEdgeDesc(e2)} 共线重叠约 ${Math.round(overlapLen)}px, 视觉上合并为一条线`,
            '调整其中一条边的端口或路径, 避免长距离并线',
            false);
        }
      }
    }
  }
  // 边标签盖住箭头本体（含自己这条边的箭头）：箭头必须在标签前后露出来。
  // 箭头实体 = 从端点沿所在线段向后 headLen、垂直半高 headHalf 的盒子
  //（尺寸从 edgeWeight 传入，随整图几何系数缩放）。
  const qcArrowBox = (tip, prev) => {
    const len = opts.arrowClearPx;
    const half = opts.arrowHalfPx;
    const horizontal = Math.abs(tip.y - prev.y) <= Math.abs(tip.x - prev.x);
    if (horizontal) {
      const back = tip.x > prev.x ? tip.x - len : tip.x;
      return { x: back, y: tip.y - half, w: len, h: half * 2 };
    }
    const back = tip.y > prev.y ? tip.y - len : tip.y;
    return { x: tip.x - half, y: back, w: half * 2, h: len };
  };
  for (const e of labeledEdges) {
    for (const other of routedEdges) {
      const boxes = [];
      const n = other.pts.length;
      // 无箭头边（undirected）两头都没有箭头实体，没有可被盖住的东西
      if (!other.undirected) {
        if (other.bidirectional || other.reversed) boxes.push(qcArrowBox(other.pts[0], other.pts[1]));
        if (other.bidirectional || !other.reversed) boxes.push(qcArrowBox(other.pts[n - 1], other.pts[n - 2]));
      }
      if (boxes.some((box) => aabbIntersects(e.label, box))) {
        addIssue('arrow_covered', 'medium', 'label', [e.id, other.id],
          e.id === other.id
            ? `边 ${qcEdgeDesc(e)} 的标签盖住了自己的箭头`
            : `边 ${qcEdgeDesc(e)} 的标签盖住了边 ${other.id} 的箭头`,
          '沿线移动标签，让箭头前后留出净空',
          false,
          { x: e.label.x, y: e.label.y });
      }
    }
  }
  // 边标签压在其他边的线上（修 P0#4; 对称互压只报一条避免重复计分）
  for (const e of labeledEdges) {
    for (const other of routedEdges) {
      if (other.id === e.id) continue;
      if (seenIds.has(`overlap:${other.id}+${e.id}`)) continue;
      const bundled = qcBundled(e, other);
      let pressed = false;
      for (let s = 0; s < other.pts.length - 1 && !pressed; s += 1) {
        if (!segmentIntersectsRect(other.pts[s], other.pts[s + 1], e.label)) continue;
        // 同束：压在两条边共有的主干段上不算（那也是自己的线）；压在同伴的支线上照报
        if (bundled && qcOnSharedTrunk(e, other, s)) continue;
        pressed = true;
      }
      if (pressed) {
        addIssue('overlap', 'medium', 'label', [e.id, other.id],
          `边 ${qcEdgeDesc(e)} 的标签压在边 ${other.id} 的线上, 易被误读为后者的标签`,
          '偏移标签或调整边路径',
          false,
          { x: e.label.x, y: e.label.y });
      }
    }
  }
  for (const e of routedEdges) {
    for (const n of nodes) {
      if (n.id === e.source || n.id === e.target) continue;
      const shrunk = expandRect(n, -opts.edgeNodeInset);
      let through = false;
      for (let s = 0; s < e.pts.length - 1 && !through; s += 1) {
        through = segmentIntersectsRect(e.pts[s], e.pts[s + 1], shrunk);
      }
      if (through) {
        // crossing / medium：边穿过非端点叶子节点
        addIssue('crossing', 'medium', 'edge', [e.id, n.id],
          `边 ${e.id} 穿过节点 "${nodeName(n)}"`,
          '重新路由，添加 waypoint 绕开该节点',
          false,
          { x: n.x + n.w / 2, y: n.y + n.h / 2 });
      }
    }
    // bends / low：转折点 > 3
    const bends = countBends(e.pts);
    if (bends > opts.maxBends) {
      addIssue('bends', 'low', 'edge', [e.id],
        `边 ${e.id} 转折点过多（${bends} > ${opts.maxBends}）`,
        '简化路径或调整节点位置以减少转折',
        false);
    }
    // detour / low：路径长 / 曼哈顿距离 > 1.8 且路径长 > 120px（自环边天然绕行, 豁免）
    if (e.source !== e.target) {
      const pathLen = polylineLength(e.pts);
      const direct = manhattanDistance(e.pts[0], e.pts[e.pts.length - 1]);
      if (pathLen > opts.detourMinLength && direct > 0 && pathLen / direct > opts.detourRatio) {
        addIssue('detour', 'low', 'edge', [e.id],
          `边 ${e.id} 路径过长（路径 ${Math.round(pathLen)}px / 曼哈顿 ${Math.round(direct)}px ≈ ${(pathLen / direct).toFixed(2)}）`,
          '优化路由，减少绕行',
          false);
      }
    }
  }
  // 边穿过非端点容器（修 P0#4: 复合状态/分组被外部边纵贯极易误读）
  for (const e of routedEdges) {
    for (const c of containers) {
      if (c.id === e.source || c.id === e.target) continue;
      const srcNode = rectById.get(e.source);
      const tgtNode = rectById.get(e.target);
      const srcInside = srcNode && qcCenterInRect(srcNode, c);
      const tgtInside = tgtNode && qcCenterInRect(tgtNode, c);
      if (srcInside || tgtInside) continue; // 端点在容器内, 出入边界是合法的
      const shrunk = expandRect(c, -opts.edgeNodeInset);
      let through = false;
      for (let s = 0; s < e.pts.length - 1 && !through; s += 1) {
        through = segmentIntersectsRect(e.pts[s], e.pts[s + 1], shrunk);
      }
      if (through) {
        addIssue('crossing', 'medium', 'edge', [e.id, c.id],
          `边 ${qcEdgeDesc(e)} 穿过容器 "${c.label || c.id}"（两端点均不在该容器内）`,
          '重新路由绕开该容器边界',
          false,
          { x: c.x + c.w / 2, y: c.y + c.h / 2 });
      }
    }
  }

  // ---- 版面区块碰撞（修 P0#4: 标题区 × 图形区盲区） -----------------------
  const qcBlockOverlap = (blockRect, blockName) => {
    if (!blockRect || !frame || !Number.isFinite(blockRect.x)) return;
    const area = aabbOverlapArea(blockRect, frame);
    if (area <= 0) return;
    const ow = Math.min(blockRect.x + blockRect.w, frame.x + frame.w) - Math.max(blockRect.x, frame.x);
    const oh = Math.min(blockRect.y + blockRect.h, frame.y + frame.h) - Math.max(blockRect.y, frame.y);
    if (Math.min(ow, oh) < 6) return; // 轻微擦边不报
    addIssue('overlap', 'medium', 'label', [blockName],
      `${blockName === 'title' ? '标题' : '副标题'}区与架构图外框重叠约 ${Math.round(ow)}×${Math.round(oh)}px`,
      '缩短文案、上移标题或下移/缩小外框',
      false,
      { x: Math.max(blockRect.x, frame.x) + ow / 2, y: Math.max(blockRect.y, frame.y) + oh / 2 });
  };
  if (scene && scene.title) qcBlockOverlap(scene.title, 'title');
  if (scene && scene.subtitle) qcBlockOverlap(scene.subtitle, 'subtitle');

  // ---- 容器检查 ----------------------------------------------------------
  // 容器越出外框（手调日志 03 的容器出框 12–20px 此前完全零报——旧检查只看叶子节点，
  // 容器矩形压出 frame 对评分器不可见）。容器包围盒由成员推导、不能直接搬动，
  // 修法是收缩布局或移动成员，所以 autoFixable 为 false、起步权重放 medium。
  if (frame) {
    for (const c of containers) {
      if (!rectContains(frame, c, -opts.boundsTolerance)) {
        const overflowPx = Math.round(qcFrameOverflow(c, frame));
        addIssue('container_out_of_bounds', 'medium', 'container', [c.id],
          `容器 "${c.label || c.id}" 超出架构图外框 ${overflowPx}px（容差 ${opts.boundsTolerance}px）`,
          '收缩容器布局或将其成员节点移回外框内',
          false,
          { x: c.x + c.w / 2, y: c.y + c.h / 2 },
          { overflowPx });
      }
    }
  }
  // 非成员节点侵入容器边界（修 P0#4: case04 顶层叶子压容器边框）
  for (const c of containers) {
    for (const n of nodes) {
      if (qcCenterInRect(n, c)) continue; // 成员(中心在内)由 container_margin 检查
      if (!aabbIntersects(n, c)) continue;
      const ow = Math.min(n.x + n.w, c.x + c.w) - Math.max(n.x, c.x);
      const oh = Math.min(n.y + n.h, c.y + c.h) - Math.max(n.y, c.y);
      if (Math.min(ow, oh) < opts.intrusionMin) continue;
      addIssue('overlap', 'medium', 'node', [n.id, c.id],
        `节点 "${nodeName(n)}"（非成员）与容器 "${c.label || c.id}" 边界重叠 ${Math.round(Math.min(ow, oh))}px`,
        '将节点移出容器边界或扩大行距',
        true,
        { x: Math.max(n.x, c.x) + ow / 2, y: Math.max(n.y, c.y) + oh / 2 });
    }
  }
  for (const c of containers) {
    const inside = nodes.filter((n) => qcCenterInRect(n, c));
    if (!inside.length) {
      // empty_container / low
      addIssue('empty_container', 'low', 'container', [c.id],
        `容器 "${c.label || c.id}" 没有子节点`,
        '删除空容器或向其中添加节点',
        false,
        { x: c.x + c.w / 2, y: c.y + c.h / 2 });
      continue;
    }
    for (const n of inside) {
      if (parentIds.get(n.id) !== c.id) continue; // 只检直接子节点
      const margin = Math.min(
        n.x - c.x,
        n.y - c.y,
        c.x + c.w - (n.x + n.w),
        c.y + c.h - (n.y + n.h),
      );
      if (margin < opts.containerMargin) {
        // container_margin / low（保留一位小数, 避免四舍五入后出现"12px 小于 12px"这类自相矛盾的表述）
        addIssue('container_margin', 'low', 'container', [c.id, n.id],
          `容器 "${c.label || c.id}" 内节点 "${nodeName(n)}" 距容器边 ${margin.toFixed(1)}px，小于 ${opts.containerMargin}px`,
          '扩大容器或将节点向内移动',
          false);
      }
    }
  }

  // ---- 结构检查 ----------------------------------------------------------
  // 孤立节点：不出现在任何一条边的两端。口径取自 lib/spec-validator.mjs（编辑器侧原本自带一份
  // 更粗的同名判断，合并到这里统一）——整张图没有连线时不报（空白起步会变成每次都有的固定噪音），
  // 所在容器（含更外层容器）连了线的也不算孤立，因为它已经通过包含关系接入图中。
  if (edges.length) {
    const endpointIds = new Set();
    for (const e of edges) { endpointIds.add(e.source); endpointIds.add(e.target); }
    const ancestorIdsOf = (rect) => containers
      .filter((c) => c.id !== rect.id && qcCenterInRect(rect, c))
      .map((c) => c.id);
    for (const n of nodes) {
      if (endpointIds.has(n.id)) continue;
      if (ancestorIdsOf(n).some((id) => endpointIds.has(id))) continue;
      addIssue('isolated', 'low', 'node', [n.id],
        `节点 "${nodeName(n)}" 没有出现在任何连线的两端，与图中其余部分没有连接`,
        '补一条连线说明它与谁交互，或确认它是否应该留在图里',
        false,
        { x: n.x + n.w / 2, y: n.y + n.h / 2 });
    }
  }

  // ---- 汇总 --------------------------------------------------------------
  // 默认按 QC_SEVERITY_WEIGHTS 平权；带 issue.penalty 的条目（目前只有 out_of_bounds
  // 的量级阶梯）用定制罚分覆盖，severity/type 口径不变。
  const issuesBySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  let penaltyTotal = 0;
  for (const issue of issues) {
    issuesBySeverity[issue.severity] += 1;
    penaltyTotal += Number.isFinite(issue.penalty) ? issue.penalty : QC_SEVERITY_WEIGHTS[issue.severity];
  }
  const score = Math.max(0, 100 - penaltyTotal);

  return {
    timestamp: Date.now(),
    totalIssues: issues.length,
    issuesBySeverity,
    issues,
    score,
  };
}
