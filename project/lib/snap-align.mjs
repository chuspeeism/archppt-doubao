// lib/snap-align.mjs [INLINE] —— 吸附对齐求解（契约 §2.1）
// 纯函数：无 DOM/window/document，ES2019，顶层标识符一律 snap / SNAP 前缀。
// 只被 build-editor.mjs 内联（工作台的拖动 / 缩放路径用它），生成产物不需要。
//
// 坐标一律是画布坐标（不是屏幕像素）。阈值也必须换算到画布坐标后再传进来，
// 否则画布缩放变了、屏幕上的吸附手感就会跟着变。

export const SNAP_DEFAULT_THRESHOLD = 6;
export const SNAP_MIN_SIZE = { w: 1, h: 1 };

// 同距时的取舍顺序：边对边 > 中线对中线 > 边对中线 > 等尺寸。
// 等尺寸排最后是因为它不画贯穿线，命中了不容易被看出来，不该抢掉更直观的边对齐。
const SNAP_RANK = { edge: 0, center: 1, mixed: 2, size: 3 };
const SNAP_EPS = 1e-9;

function snapNum(v) { return typeof v === 'number' && isFinite(v) ? v : NaN; }

function snapNormalizeRect(r) {
  if (!r) return null;
  const x = snapNum(r.x);
  const y = snapNum(r.y);
  const w = snapNum(r.w);
  const h = snapNum(r.h);
  if (isNaN(x) || isNaN(y) || isNaN(w) || isNaN(h)) return null;
  return { x, y, w, h };
}

// 一个矩形在某根轴上的三条参考线：两条边 + 一条中线
export function snapRectLines(rect, axis) {
  const r = snapNormalizeRect(rect);
  if (!r) return [];
  if (axis === 'y') {
    return [
      { key: 'top', pos: r.y, kind: 'edge' },
      { key: 'centerY', pos: r.y + r.h / 2, kind: 'center' },
      { key: 'bottom', pos: r.y + r.h, kind: 'edge' },
    ];
  }
  return [
    { key: 'left', pos: r.x, kind: 'edge' },
    { key: 'centerX', pos: r.x + r.w / 2, kind: 'center' },
    { key: 'right', pos: r.x + r.w, kind: 'edge' },
  ];
}

// resize 时哪条边在动：柄名里带 w/e 决定 x 轴那条，带 n/s 决定 y 轴那条。
// 只拖 n / s 的柄在 x 轴上没有活动边，这根轴就整个不参与吸附。
export function snapMovingEdge(handle, axis) {
  const h = String(handle || '');
  if (axis === 'y') {
    if (h.indexOf('n') >= 0) return 'top';
    if (h.indexOf('s') >= 0) return 'bottom';
    return null;
  }
  if (h.indexOf('w') >= 0) return 'left';
  if (h.indexOf('e') >= 0) return 'right';
  return null;
}

function snapPairRank(movingKind, targetKind) {
  if (movingKind === 'edge' && targetKind === 'edge') return SNAP_RANK.edge;
  if (movingKind === 'center' && targetKind === 'center') return SNAP_RANK.center;
  return SNAP_RANK.mixed;
}

function snapByCloseness(a, b) {
  const da = Math.abs(a.delta);
  const db = Math.abs(b.delta);
  if (Math.abs(da - db) > SNAP_EPS) return da - db;
  if (a.rank !== b.rank) return a.rank - b.rank;
  return a.order - b.order;
}

// 把候选套到矩形上：move 平移整体（尺寸一律不动），resize 只推动那条被拖的边。
// 返回 null 表示这个候选会把尺寸压到下限以下，应当换下一个候选。
function snapApply(rect, axis, movingKey, delta, minSize, mode) {
  const out = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
  if (mode !== 'resize') {
    if (axis === 'x') out.x = rect.x + delta;
    else out.y = rect.y + delta;
    return out;
  }
  if (axis === 'x') {
    if (movingKey === 'left') {
      out.x = rect.x + delta;
      out.w = rect.w - delta;
    } else {
      out.w = rect.w + delta;
    }
    if (out.w < minSize.w - SNAP_EPS) return null;
  } else {
    if (movingKey === 'top') {
      out.y = rect.y + delta;
      out.h = rect.h - delta;
    } else {
      out.h = rect.h + delta;
    }
    if (out.h < minSize.h - SNAP_EPS) return null;
  }
  return out;
}

// 贯穿线的跨度：沿垂直于该线的方向，从「拖动矩形与命中目标」的最小端量到最大端，
// 所以线一定同时穿过对齐的双方，看一眼就知道是跟谁对齐上的。
function snapGuideSpan(axis, rect, targets) {
  let lo;
  let hi;
  if (axis === 'x') {
    lo = rect.y;
    hi = rect.y + rect.h;
  } else {
    lo = rect.x;
    hi = rect.x + rect.w;
  }
  for (let i = 0; i < targets.length; i += 1) {
    const t = targets[i];
    const a = axis === 'x' ? t.y : t.x;
    const b = axis === 'x' ? t.y + t.h : t.x + t.w;
    if (a < lo) lo = a;
    if (b > hi) hi = b;
  }
  return { start: lo, end: hi };
}

/* snapAlign(input) -> result
   input:
     rect      {x,y,w,h}  拖动中的矩形（多选时传选区包围盒）；resize 时传柄已经算完的那个盒子
     targets   [{id,x,y,w,h}]  其他矩形（叶子节点 + 容器包围盒），调用方负责剔掉自身/祖先/后代
     threshold number  画布坐标下的吸附阈值（默认 6）
     mode      'move' | 'resize'
     handle    resize 时是哪个柄：nw n ne e se s sw w
     disabled  true 时原样返回（Alt 临时禁用走这里）
     matchSize resize 时是否吸附成与他人相等的宽/高，默认开
     minSize   {w,h}  尺寸下限，候选会把盒子压得更小就换下一个
   result:
     rect      修正后的 {x,y,w,h}
     dx, dy    相对入参 rect 的位移（resize 时只反映左上角的变化）
     snapped   { x: bool, y: bool }  哪根轴命中了
     guides    [{ orientation:'v'|'h', pos, start, end, kind:'edge'|'center', from, to, targetIds }]
     sizeHints [{ axis:'w'|'h', size, targetIds }]  等尺寸命中时的提示
*/
export function snapAlign(input) {
  const opt = input || {};
  const rect = snapNormalizeRect(opt.rect);
  const empty = {
    rect: rect ? { x: rect.x, y: rect.y, w: rect.w, h: rect.h } : null,
    dx: 0,
    dy: 0,
    snapped: { x: false, y: false },
    guides: [],
    sizeHints: [],
  };
  if (!rect) return empty;

  const threshold = typeof opt.threshold === 'number' && isFinite(opt.threshold)
    ? opt.threshold : SNAP_DEFAULT_THRESHOLD;
  if (opt.disabled || !(threshold > 0)) return empty;

  const targets = [];
  const rawTargets = Array.isArray(opt.targets) ? opt.targets : [];
  for (let i = 0; i < rawTargets.length; i += 1) {
    const t = snapNormalizeRect(rawTargets[i]);
    if (t) targets.push({ id: rawTargets[i].id, x: t.x, y: t.y, w: t.w, h: t.h });
  }
  if (!targets.length) return empty;

  const mode = opt.mode === 'resize' ? 'resize' : 'move';
  const minSize = {
    w: opt.minSize && isFinite(opt.minSize.w) ? opt.minSize.w : SNAP_MIN_SIZE.w,
    h: opt.minSize && isFinite(opt.minSize.h) ? opt.minSize.h : SNAP_MIN_SIZE.h,
  };
  const matchSize = mode === 'resize' && opt.matchSize !== false;

  const result = {
    rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
    dx: 0,
    dy: 0,
    snapped: { x: false, y: false },
    guides: [],
    sizeHints: [],
  };

  ['x', 'y'].forEach((axis) => {
    // move 时整个矩形都在动，三条参考线都可以去够别人；
    // resize 时只有被拖的那条边在动，其余边不许被吸附带跑。
    let movingLines;
    if (mode === 'resize') {
      const key = snapMovingEdge(opt.handle, axis);
      movingLines = key ? snapRectLines(rect, axis).filter((l) => l.key === key) : [];
    } else {
      movingLines = snapRectLines(rect, axis);
    }
    if (!movingLines.length) return;

    const candidates = [];
    let order = 0;
    for (let i = 0; i < targets.length; i += 1) {
      const target = targets[i];
      const targetLines = snapRectLines(target, axis);
      for (let m = 0; m < movingLines.length; m += 1) {
        const ml = movingLines[m];
        for (let k = 0; k < targetLines.length; k += 1) {
          const tl = targetLines[k];
          const delta = tl.pos - ml.pos;
          if (Math.abs(delta) > threshold) continue;
          candidates.push({
            type: 'align',
            delta,
            rank: snapPairRank(ml.kind, tl.kind),
            order: order++,
            movingKey: ml.key,
            targetKey: tl.key,
            kind: tl.kind,
            pos: tl.pos,
            target,
          });
        }
      }
    }

    if (matchSize) {
      const dim = axis === 'x' ? 'w' : 'h';
      const movingKey = snapMovingEdge(opt.handle, axis);
      for (let i = 0; i < targets.length; i += 1) {
        const target = targets[i];
        const diff = target[dim] - rect[dim];
        if (!movingKey || Math.abs(diff) > threshold) continue;
        // 'left' / 'top' 往负方向长，所以推动量与尺寸差反号
        const grow = (movingKey === 'left' || movingKey === 'top') ? -diff : diff;
        candidates.push({
          type: 'size',
          delta: grow,
          rank: SNAP_RANK.size,
          order: order++,
          movingKey,
          size: target[dim],
          target,
        });
      }
    }

    if (!candidates.length) return;
    candidates.sort(snapByCloseness);

    for (let i = 0; i < candidates.length; i += 1) {
      const best = candidates[i];
      const next = snapApply(result.rect, axis, best.movingKey, best.delta, minSize, mode);
      if (!next) continue;
      result.rect = next;
      result.snapped[axis] = true;

      if (best.type === 'size') {
        const ids = [];
        for (let k = 0; k < targets.length; k += 1) {
          if (Math.abs(targets[k][axis === 'x' ? 'w' : 'h'] - best.size) < 1e-6) ids.push(targets[k].id);
        }
        result.sizeHints.push({ axis: axis === 'x' ? 'w' : 'h', size: best.size, targetIds: ids });
        break;
      }

      // 同一根线上可能同时压着好几个矩形，贯穿线要把它们一起罩住
      const hit = [];
      const ids = [];
      for (let k = 0; k < targets.length; k += 1) {
        const lines = snapRectLines(targets[k], axis);
        for (let j = 0; j < lines.length; j += 1) {
          if (Math.abs(lines[j].pos - best.pos) < 1e-6) {
            hit.push(targets[k]);
            ids.push(targets[k].id);
            break;
          }
        }
      }
      result.guides.push({
        orientation: axis === 'x' ? 'v' : 'h',
        pos: best.pos,
        start: 0,
        end: 0,
        kind: best.kind,
        from: best.movingKey,
        to: best.targetKey,
        targetIds: ids,
        _axis: axis,
        _hit: hit,
      });
      break;
    }
  });

  // 跨度用两根轴都定完之后的矩形算，否则先出的那条线会按吸附前的位置画歪
  result.guides.forEach((g) => {
    const span = snapGuideSpan(g._axis, result.rect, g._hit);
    g.start = span.start;
    g.end = span.end;
    delete g._axis;
    delete g._hit;
  });

  result.dx = result.rect.x - rect.x;
  result.dy = result.rect.y - rect.y;
  return result;
}
