// lib/auto-fixer.mjs [INLINE] —— 节点级问题自动修复（契约 §4，PRD §2.5.1）
// 只允许 import ./geometry-utils.mjs；只修 overlap / out_of_bounds / spacing；不改边。
// overlap 含两种：节点×节点（双方都可移动）与节点×容器边界侵入（容器包围盒由
// 子项推导、不可直接移动，只把节点往外推）。
import { aabbOverlapArea, rectContains } from './geometry-utils.mjs';

const afRectGap = (a, b) => {
  const gx = Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w), 0);
  const gy = Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h), 0);
  return Math.hypot(gx, gy);
};

const afClampToFrame = (rect, frame, margin) => {
  // 夹回 frame 内（含 margin 边距）；frame 放不下时靠左/上对齐。返回是否发生移动。
  if (!frame) return false;
  const loX = frame.x + margin;
  const hiX = frame.x + frame.w - margin - rect.w;
  const loY = frame.y + margin;
  const hiY = frame.y + frame.h - margin - rect.h;
  const nx = hiX < loX ? loX : Math.min(hiX, Math.max(loX, rect.x));
  const ny = hiY < loY ? loY : Math.min(hiY, Math.max(loY, rect.y));
  const moved = Math.abs(nx - rect.x) > 1e-9 || Math.abs(ny - rect.y) > 1e-9;
  rect.x = nx;
  rect.y = ny;
  return moved;
};

const afSeparate = (r1, r2, extraGap) => {
  // PRD §2.5.1：沿最小重叠轴移动 r2；extraGap 为分离后追加的间距。返回移动量（0 表示已满足）。
  const cx1 = r1.x + r1.w / 2;
  const cy1 = r1.y + r1.h / 2;
  const cx2 = r2.x + r2.w / 2;
  const cy2 = r2.y + r2.h / 2;
  const needX = (r1.w + r2.w) / 2 + extraGap - Math.abs(cx1 - cx2);
  const needY = (r1.h + r2.h) / 2 + extraGap - Math.abs(cy1 - cy2);
  if (needX <= 0 || needY <= 0) return 0; // 某个轴上已有足够间距
  if (needX <= needY) {
    r2.x += needX * (cx2 >= cx1 ? 1 : -1);
    return needX;
  }
  r2.y += needY * (cy2 >= cy1 ? 1 : -1);
  return needY;
};

export function autoFix(scene, report) {
  const frameMargin = 12;   // out_of_bounds 夹回后的边距
  const minGap = 24;        // 分离/推开后的目标间距
  const gapSlack = 0.5;     // 略超阈值，避免浮点边界再次触发
  const boundsTolerance = 2;

  const frame = scene ? scene.frame : null;
  const nodes = scene && Array.isArray(scene.nodes) ? scene.nodes : [];
  const containers = scene && Array.isArray(scene.containers) ? scene.containers : [];
  const containerById = new Map();
  for (const c of containers) {
    if (c && c.id != null && !containerById.has(c.id)) containerById.set(c.id, { x: c.x, y: c.y, w: c.w, h: c.h });
  }
  const order = [];
  const original = new Map();
  const work = new Map();
  for (const n of nodes) {
    if (!n || n.id == null || work.has(n.id)) continue;
    order.push(n.id);
    original.set(n.id, { x: n.x, y: n.y, w: n.w, h: n.h });
    work.set(n.id, { x: n.x, y: n.y, w: n.w, h: n.h });
  }

  const allIssues = report && Array.isArray(report.issues) ? report.issues : [];
  const fixable = [];
  const fixedIssueIds = [];
  const unfixedIssueIds = [];
  for (const issue of allIssues) {
    if (!issue) continue;
    const nodeLevel = issue.category === 'node'
      && (issue.type === 'overlap' || issue.type === 'out_of_bounds' || issue.type === 'spacing');
    if (nodeLevel) fixable.push(issue);
    else unfixedIssueIds.push(issue.id);
  }

  const oobIds = new Set();
  const spacingPairs = [];
  const intrusionPairs = [];   // [节点 id, 容器 id]：节点压在非成员容器的边界上
  for (const issue of fixable) {
    const els = issue.affectedElements || [];
    if (issue.type === 'out_of_bounds' && els[0] != null) oobIds.add(els[0]);
    if (issue.type === 'spacing' && els.length >= 2) spacingPairs.push([els[0], els[1]]);
    if (issue.type === 'overlap' && els.length >= 2 && containerById.has(els[1])) intrusionPairs.push([els[0], els[1]]);
  }

  const movedIds = new Set();
  const clampMoved = () => {
    let count = 0;
    for (const id of order) {
      if (!oobIds.has(id) && !movedIds.has(id)) continue;
      if (afClampToFrame(work.get(id), frame, frameMargin)) {
        movedIds.add(id);
        count += 1;
      }
    }
    return count;
  };

  // 迭代最多 10 轮：夹回越界 → 分离重叠 → 推开 spacing → 再夹回，直到收敛
  for (let round = 0; round < 10; round += 1) {
    let movement = 0;
    movement += clampMoved();
    for (let i = 0; i < order.length; i += 1) {
      for (let j = i + 1; j < order.length; j += 1) {
        const a = work.get(order[i]);
        const b = work.get(order[j]);
        if (aabbOverlapArea(a, b) <= 0) continue;
        const dist = afSeparate(a, b, minGap + gapSlack);
        if (dist > 0) {
          movement += dist;
          movedIds.add(order[j]);
          afClampToFrame(b, frame, frameMargin);
        }
      }
    }
    for (const pair of spacingPairs) {
      const a = work.get(pair[0]);
      const b = work.get(pair[1]);
      if (!a || !b) continue;
      if (aabbOverlapArea(a, b) > 0) continue; // 重叠交给 overlap 分离逻辑
      if (afRectGap(a, b) >= minGap) continue;
      const dist = afSeparate(a, b, minGap + gapSlack);
      if (dist > 0) {
        movement += dist;
        movedIds.add(pair[1]);
        afClampToFrame(b, frame, frameMargin);
      }
    }
    for (const pair of intrusionPairs) {
      // 容器包围盒不可移动：afSeparate 以容器为 r1、节点为 r2，只推节点。
      // 追加间距取小值——目标只是让节点离开边界，不是把它推到 minGap 之外。
      const node = work.get(pair[0]);
      const box = containerById.get(pair[1]);
      if (!node || !box) continue;
      if (aabbOverlapArea(node, box) <= 0) continue;
      const dist = afSeparate(box, node, 4);
      if (dist > 0) {
        movement += dist;
        movedIds.add(pair[0]);
        afClampToFrame(node, frame, frameMargin);
      }
    }
    movement += clampMoved();
    if (movement < 1e-6) break; // 收敛
  }

  // 按最终位置逐条复核
  for (const issue of fixable) {
    const els = issue.affectedElements || [];
    let resolved = false;
    if (issue.type === 'out_of_bounds') {
      const r = work.get(els[0]);
      resolved = !!r && (!frame || rectContains(frame, r, -boundsTolerance));
    } else {
      const a = work.get(els[0]);
      const b = work.get(els[1]) || containerById.get(els[1]);
      if (a && b) {
        if (issue.type === 'overlap') resolved = aabbOverlapArea(a, b) <= 0;
        else resolved = aabbOverlapArea(a, b) <= 0 && afRectGap(a, b) >= minGap;
      }
    }
    if (resolved) fixedIssueIds.push(issue.id);
    else unfixedIssueIds.push(issue.id);
  }

  const positions = {};
  for (const id of order) {
    const before = original.get(id);
    const after = work.get(id);
    if (Math.abs(before.x - after.x) > 1e-6 || Math.abs(before.y - after.y) > 1e-6) {
      positions[id] = { x: after.x, y: after.y, w: after.w, h: after.h };
    }
  }
  return { positions, fixedIssueIds, unfixedIssueIds };
}
