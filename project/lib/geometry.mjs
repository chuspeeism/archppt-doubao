const DEFAULT_FRAME_LIMITS = Object.freeze({
  minW: 300,
  minH: 200,
  canvasW: 1920,
  canvasH: 1080,
  minVisible: 100,
});

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function roundRect(rect, precision = 100) {
  const round = (value) => Math.round(value * precision) / precision;
  return {
    x: round(rect.x),
    y: round(rect.y),
    w: round(rect.w),
    h: round(rect.h),
  };
}

export function normalizeRect(rect, frame) {
  if (!frame || frame.w <= 0 || frame.h <= 0) throw new Error('frame 的宽高必须为正数');
  return {
    nx: (rect.x - frame.x) / frame.w,
    ny: (rect.y - frame.y) / frame.h,
    nw: rect.w / frame.w,
    nh: rect.h / frame.h,
  };
}

export function denormalizeRect(normalized, frame) {
  if (!frame || frame.w <= 0 || frame.h <= 0) throw new Error('frame 的宽高必须为正数');
  return {
    x: frame.x + normalized.nx * frame.w,
    y: frame.y + normalized.ny * frame.h,
    w: normalized.nw * frame.w,
    h: normalized.nh * frame.h,
  };
}

export function transformRectBetweenFrames(rect, fromFrame, toFrame) {
  return roundRect(denormalizeRect(normalizeRect(rect, fromFrame), toFrame));
}

export function transformPositionMap(positions, fromFrame, toFrame) {
  const out = {};
  for (const [id, rect] of Object.entries(positions || {})) {
    if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.y)) continue;
    const source = {
      x: rect.x,
      y: rect.y,
      w: Number.isFinite(rect.w) ? rect.w : 0,
      h: Number.isFinite(rect.h) ? rect.h : 0,
    };
    out[id] = transformRectBetweenFrames(source, fromFrame, toFrame);
    if (!Number.isFinite(rect.w)) delete out[id].w;
    if (!Number.isFinite(rect.h)) delete out[id].h;
  }
  return out;
}

export function moveFrame(frame, dx, dy, options = {}) {
  const limits = { ...DEFAULT_FRAME_LIMITS, ...options };
  const maxX = limits.canvasW - limits.minVisible;
  const maxY = limits.canvasH - limits.minVisible;
  const minX = Math.min(0, limits.minVisible - frame.w);
  const minY = Math.min(0, limits.minVisible - frame.h);
  return roundRect({
    x: clamp(frame.x + finite(dx), minX, maxX),
    y: clamp(frame.y + finite(dy), minY, maxY),
    w: frame.w,
    h: frame.h,
  });
}

export function resizeFrameFromHandle(frame, handle, dx, dy, options = {}) {
  const limits = { ...DEFAULT_FRAME_LIMITS, ...options };
  const direction = String(handle || 'se').toLowerCase();
  let left = frame.x;
  let top = frame.y;
  let right = frame.x + frame.w;
  let bottom = frame.y + frame.h;
  const deltaX = finite(dx);
  const deltaY = finite(dy);

  if (direction.includes('w')) left += deltaX;
  if (direction.includes('e')) right += deltaX;
  if (direction.includes('n')) top += deltaY;
  if (direction.includes('s')) bottom += deltaY;

  if (right - left < limits.minW) {
    if (direction.includes('w')) left = right - limits.minW;
    else right = left + limits.minW;
  }
  if (bottom - top < limits.minH) {
    if (direction.includes('n')) top = bottom - limits.minH;
    else bottom = top + limits.minH;
  }

  const minLeft = Math.min(0, limits.minVisible - (right - left));
  const minTop = Math.min(0, limits.minVisible - (bottom - top));
  if (left > limits.canvasW - limits.minVisible) {
    const shift = left - (limits.canvasW - limits.minVisible);
    left -= shift;
    if (!direction.includes('w')) right -= shift;
  }
  if (top > limits.canvasH - limits.minVisible) {
    const shift = top - (limits.canvasH - limits.minVisible);
    top -= shift;
    if (!direction.includes('n')) bottom -= shift;
  }
  left = Math.max(minLeft, left);
  top = Math.max(minTop, top);

  return roundRect({ x: left, y: top, w: right - left, h: bottom - top });
}

export function fitRectIntoFrame(rect, frame, padding = 24) {
  const inner = {
    x: frame.x + padding,
    y: frame.y + padding,
    w: Math.max(1, frame.w - padding * 2),
    h: Math.max(1, frame.h - padding * 2),
  };
  const scale = Math.min(inner.w / rect.w, inner.h / rect.h);
  const w = rect.w * scale;
  const h = rect.h * scale;
  return {
    x: inner.x + (inner.w - w) / 2,
    y: inner.y + (inner.h - h) / 2,
    w,
    h,
    scale,
  };
}

export function affinePoint(point, fromRect, toRect) {
  return {
    x: toRect.x + ((point.x - fromRect.x) / fromRect.w) * toRect.w,
    y: toRect.y + ((point.y - fromRect.y) / fromRect.h) * toRect.h,
  };
}
