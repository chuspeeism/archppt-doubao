// lib/geometry-utils.mjs [INLINE] —— 纯几何工具（契约 §2）
// 无 DOM/window/document 依赖；ES2019；所有导出均为具名导出，整行 export。

export function aabbIntersects(r1, r2) {
  // 边界相触（相等）不算相交，因此用严格不等号
  return r1.x + r1.w > r2.x && r2.x + r2.w > r1.x && r1.y + r1.h > r2.y && r2.y + r2.h > r1.y;
}

export function aabbOverlapArea(r1, r2) {
  const ox = Math.min(r1.x + r1.w, r2.x + r2.w) - Math.max(r1.x, r2.x);
  const oy = Math.min(r1.y + r1.h, r2.y + r2.h) - Math.max(r1.y, r2.y);
  return ox > 0 && oy > 0 ? ox * oy : 0;
}

export function rectContains(outer, inner, margin = 0) {
  // inner 是否完全落在 outer 内缩 margin 后的区域内（边界重合算包含）
  return inner.x >= outer.x + margin
    && inner.y >= outer.y + margin
    && inner.x + inner.w <= outer.x + outer.w - margin
    && inner.y + inner.h <= outer.y + outer.h - margin;
}

export function segmentsIntersect(p1, p2, p3, p4) {
  // proper intersection：交点严格位于两条线段内部；共线/平行/端点相接返回 null
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x;
  const d2y = p4.y - p3.y;
  const denom = d1x * d2y - d1y * d2x;
  if (denom === 0) return null; // 平行或共线
  const eps = 1e-9;
  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
  const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / denom;
  if (t <= eps || t >= 1 - eps || u <= eps || u >= 1 - eps) return null;
  return { x: p1.x + t * d1x, y: p1.y + t * d1y };
}

export function segmentIntersectsRect(p1, p2, rect) {
  // Liang-Barsky：线段任一部分进入矩形内部才算 true（仅贴边滑过/触角不算）
  if (!rect || rect.w <= 0 || rect.h <= 0) return false;
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const pArr = [-dx, dx, -dy, dy];
  const qArr = [p1.x - rect.x, rect.x + rect.w - p1.x, p1.y - rect.y, rect.y + rect.h - p1.y];
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < 4; i += 1) {
    if (pArr[i] === 0) {
      if (qArr[i] < 0) return false; // 与该边界平行且在外侧
    } else {
      const r = qArr[i] / pArr[i];
      if (pArr[i] < 0) {
        if (r > t1) return false;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return false;
        if (r < t1) t1 = r;
      }
    }
  }
  const isPoint = dx === 0 && dy === 0;
  if (!isPoint && t1 <= t0) return false; // 单点触碰（角点）不算
  // 裁剪后中点必须严格位于矩形内部，排除沿边缘滑过的情形
  const mx = p1.x + dx * ((t0 + t1) / 2);
  const my = p1.y + dy * ((t0 + t1) / 2);
  return mx > rect.x && mx < rect.x + rect.w && my > rect.y && my < rect.y + rect.h;
}

export function polylineLength(pts) {
  if (!Array.isArray(pts) || pts.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < pts.length; i += 1) {
    total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  return total;
}

export function manhattanDistance(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export function pointSegmentDistance(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function countBends(pts) {
  // 方向发生改变的中间顶点数；重复点合并；共线中间点不算转折
  if (!Array.isArray(pts) || pts.length < 3) return 0;
  const merged = [];
  for (const p of pts) {
    const last = merged[merged.length - 1];
    if (!last || Math.abs(last.x - p.x) > 1e-9 || Math.abs(last.y - p.y) > 1e-9) merged.push(p);
  }
  let bends = 0;
  for (let i = 1; i < merged.length - 1; i += 1) {
    const ax = merged[i].x - merged[i - 1].x;
    const ay = merged[i].y - merged[i - 1].y;
    const bx = merged[i + 1].x - merged[i].x;
    const by = merged[i + 1].y - merged[i].y;
    const crossV = ax * by - ay * bx;
    const dotV = ax * bx + ay * by;
    if (Math.abs(crossV) > 1e-6 || dotV < 0) bends += 1;
  }
  return bends;
}

export function expandRect(r, m) {
  return { x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m };
}

// ---------- 边标签沿线定位 ----------
// t 为归一化弧长参数：0 = 折线起点，1 = 折线终点。缺省（非有限数）时落在最长一段的中点。

export function polylinePointAtT(pts, t) {
  if (!Array.isArray(pts) || pts.length === 0) return null;
  const first = { x: pts[0].x, y: pts[0].y };
  if (pts.length === 1) return first;
  const total = polylineLength(pts);
  if (total === 0) return first;
  const target = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0)) * total;
  let acc = 0;
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1];
    const b = pts[i];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (segLen === 0) continue;
    if (acc + segLen >= target) {
      const k = (target - acc) / segLen;
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
    }
    acc += segLen;
  }
  const last = pts[pts.length - 1];
  return { x: last.x, y: last.y };
}

export function polylineProjectT(pts, p) {
  // 折线上距 p 最近的点对应的归一化弧长；折线退化为一个点时返回 0
  if (!Array.isArray(pts) || pts.length < 2 || !p) return 0;
  const total = polylineLength(pts);
  if (total === 0) return 0;
  let acc = 0;
  let bestDist = Infinity;
  let bestT = 0;
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1];
    const b = pts[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) continue;
    const segLen = Math.sqrt(lenSq);
    let k = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
    k = Math.max(0, Math.min(1, k));
    const dist = Math.hypot(p.x - (a.x + dx * k), p.y - (a.y + dy * k));
    if (dist < bestDist) {
      bestDist = dist;
      bestT = (acc + k * segLen) / total;
    }
    acc += segLen;
  }
  return bestT;
}

export function clampLabelT(pts, t, pad = 18) {
  // 把 t 收进距两端至少 pad 像素的区间，避免标签压住箭头或端点节点；
  // 折线过短时退让为总长的 25%，保证区间非空。
  const total = polylineLength(pts);
  const value = Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0.5;
  if (!(total > 0)) return 0.5;
  const margin = Math.min(Math.max(0, pad), total * 0.25) / total;
  return Math.max(margin, Math.min(1 - margin, value));
}

export function longestSegmentIndex(pts) {
  // 曼哈顿长度最长的一段（并列取靠前的一段），与历史默认标签落点口径一致
  if (!Array.isArray(pts) || pts.length < 2) return -1;
  let best = -1;
  let bestLen = -1;
  for (let i = 1; i < pts.length; i += 1) {
    const len = Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y);
    if (len > bestLen) {
      bestLen = len;
      best = i;
    }
  }
  return best;
}

// 被手动拖到某处、从此钉住的浮层落位：只夹回可视框，**不翻面、不跟锚点走**。
// 自动落位（editor 的 placeFloat）会为了避开选区翻到另一侧——那是浮层还没被指定位置时的规则；
// 一旦用户亲手把它拖到某处，再自动挪走就等于把这次拖动撤销掉了。
// 可视框比浮层还小时贴住左上，保证起点（拖拽柄那一侧）始终可见、还能再拖出来。
export function clampPinnedFloat(pin, size, box, edge = 10) {
  const fit = (v, lo, hi) => (hi < lo ? lo : Math.min(Math.max(v, lo), hi));
  return {
    left: fit(pin.left, box.left + edge, box.right - edge - size.w),
    top: fit(pin.top, box.top + edge, box.bottom - edge - size.h),
  };
}

export function edgeLabelPoint(pts, t, pad = 18) {
  // 未拖动过的边（t 非有限数）保持"最长一段中点"的原始几何，不走弧长换算，避免浮点漂移
  if (!Array.isArray(pts) || pts.length === 0) return null;
  if (!Number.isFinite(t)) {
    const i = longestSegmentIndex(pts);
    if (i < 0) return { x: pts[0].x, y: pts[0].y };
    return { x: (pts[i - 1].x + pts[i].x) / 2, y: (pts[i - 1].y + pts[i].y) / 2 };
  }
  return polylinePointAtT(pts, clampLabelT(pts, t, pad));
}
