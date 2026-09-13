// scene-svg.mjs [INLINE]
// 把 Scene（契约 §1）渲染为完整的自包含 <svg> 字符串（1920×1080，无外链、无 foreignObject）。
// 绘制顺序：背景 → 标题/副标题 → 容器 → 节点 → 节点图标 → 节点文字 → 全部边线 → 全部边标签。
// SVG 没有 z-index，谁后画谁在上：连线是全图最顶层的可见物，必须整体排在节点之后，
// 否则节点卡片会把穿过它的线段盖断（六种导出共用这一份，PPTX/PDF 里同样会断）。
import { edgeWeight, arrowMarkerGeometry, splitColorAlpha } from '../edge-weight.mjs';

export const SCENE_THEME_DEFAULTS = Object.freeze({
  background: '#090d14',
  panel: '#151e2b',
  text: '#f3f6fa',
  textSecondary: '#a7b0c0',
  textMuted: '#727d90',
  accent: '#5ac8fa',
  store: '#78dcb4',
  border: 'rgba(255,255,255,0.16)',
  containerBorder: 'rgba(255,255,255,0.09)',
  containerFill: 'rgba(255,255,255,0.03)',
  edge: 'rgba(190,205,225,0.6)',
  edgeLabelBg: '#ffffff',
  edgeLabelText: '#26303f',
  fontFamily: '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
});

const svgEsc = (text) => String(text ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const svgNum = (value) => {
  const rounded = Math.round(Number(value) * 100) / 100;
  return String(rounded);
};

// 与 quality-checker 的 estimateTextWidth 同款估宽算法的局部版本：
// CJK（及其它非 Latin1 字符）记 1em，ASCII 记 0.52em（实测 0.6 高估约 15%）。
export const svgEstimateTextWidth = (text, px) => {
  const value = String(text ?? '');
  let units = 0;
  for (let i = 0; i < value.length; i += 1) {
    units += value.charCodeAt(i) > 0xff ? 1 : 0.52;
  }
  return units * px;
};

// 超宽时按比例缩小字号（不换行），下限 15px——低于此可读性崩坏，宁可轻微溢出。
export const svgFitFontSize = (text, basePx, maxW, minPx = 15) => {
  const width = svgEstimateTextWidth(text, basePx);
  if (width <= 0 || maxW <= 0 || width <= maxW) return basePx;
  const scaled = Math.floor(basePx * (maxW / width) * 10) / 10;
  return Math.max(minPx, scaled);
};

// #rgb / #rrggbb → rgba(r,g,b,alpha)；其它写法原样返回（无法安全加透明度）。
export const svgAlphaColor = (color, alpha) => {
  const value = String(color ?? '');
  const match = value.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (!match) return value;
  let hex = match[1];
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
};

// 正交折线 → 圆角折线 path（转角用二次贝塞尔）。
export const svgRoundedPathD = (pts, radius) => {
  if (!Array.isArray(pts) || pts.length < 2) return '';
  let d = `M ${svgNum(pts[0].x)} ${svgNum(pts[0].y)}`;
  for (let i = 1; i < pts.length - 1; i += 1) {
    const prev = pts[i - 1];
    const curr = pts[i];
    const next = pts[i + 1];
    const inLen = Math.hypot(curr.x - prev.x, curr.y - prev.y);
    const outLen = Math.hypot(next.x - curr.x, next.y - curr.y);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    if (!(r > 0.5) || inLen === 0 || outLen === 0) {
      d += ` L ${svgNum(curr.x)} ${svgNum(curr.y)}`;
      continue;
    }
    const inX = curr.x - ((curr.x - prev.x) / inLen) * r;
    const inY = curr.y - ((curr.y - prev.y) / inLen) * r;
    const outX = curr.x + ((next.x - curr.x) / outLen) * r;
    const outY = curr.y + ((next.y - curr.y) / outLen) * r;
    d += ` L ${svgNum(inX)} ${svgNum(inY)} Q ${svgNum(curr.x)} ${svgNum(curr.y)} ${svgNum(outX)} ${svgNum(outY)}`;
  }
  const last = pts[pts.length - 1];
  d += ` L ${svgNum(last.x)} ${svgNum(last.y)}`;
  return d;
};

export const svgViewBoxSize = (viewBox) => {
  const parts = String(viewBox ?? '').trim().split(/[\s,]+/).map(Number);
  return parts.length === 4 && parts[2] > 0 ? parts[2] : 24;
};

export const svgVariantStyle = (variant, palette) => {
  if (variant === 'accent') {
    return {
      fill: svgAlphaColor(palette.accent, 0.12),
      stroke: svgAlphaColor(palette.accent, 0.55),
      label: palette.accentLabel || palette.text,
    };
  }
  if (variant === 'decision') {
    return {
      fill: palette.decisionFill || palette.panel,
      stroke: palette.accent,
      label: palette.text,
    };
  }
  if (variant === 'store') {
    return {
      fill: svgAlphaColor(palette.store, 0.1),
      stroke: svgAlphaColor(palette.store, 0.45),
      label: palette.text,
    };
  }
  if (variant === 'muted') {
    const mutedBase = palette.tone === 'light' ? '#000000' : '#ffffff';
    return {
      fill: svgAlphaColor(mutedBase, 0.03),
      stroke: svgAlphaColor(mutedBase, 0.1),
      label: palette.textSecondary,
    };
  }
  return { fill: palette.panel, stroke: palette.border, label: palette.text };
};

const svgNodeShapeMarkup = (node, palette) => {
  const style = svgVariantStyle(node.variant, palette);
  const paint = `fill="${style.fill}" stroke="${style.stroke}" stroke-width="1.5"`;
  const { x, y, w, h } = node;
  const cx = x + w / 2;
  const cy = y + h / 2;
  if (node.variant === 'decision') {
    const points = `${svgNum(cx)},${svgNum(y)} ${svgNum(x + w)},${svgNum(cy)} ${svgNum(cx)},${svgNum(y + h)} ${svgNum(x)},${svgNum(cy)}`;
    return `<polygon class="scene-node scene-node-decision" points="${points}" ${paint}/>`;
  }
  if (node.variant === 'pill') {
    return `<rect class="scene-node scene-node-pill" x="${svgNum(x)}" y="${svgNum(y)}" width="${svgNum(w)}" height="${svgNum(h)}" rx="${svgNum(h / 2)}" ry="${svgNum(h / 2)}" ${paint}/>`;
  }
  if (node.variant === 'database') {
    const capRy = Math.min(16, h * 0.16);
    const body = `<rect class="scene-node scene-node-database" x="${svgNum(x)}" y="${svgNum(y + capRy)}" width="${svgNum(w)}" height="${svgNum(h - capRy * 2)}" ${paint}/>`;
    const bottomCap = `<ellipse class="scene-node-database-cap" cx="${svgNum(cx)}" cy="${svgNum(y + h - capRy)}" rx="${svgNum(w / 2)}" ry="${svgNum(capRy)}" ${paint}/>`;
    const topCap = `<ellipse class="scene-node-database-cap" cx="${svgNum(cx)}" cy="${svgNum(y + capRy)}" rx="${svgNum(w / 2)}" ry="${svgNum(capRy)}" ${paint}/>`;
    return body + bottomCap + topCap;
  }
  if (node.variant === 'circle') {
    const r = Math.min(w, h) / 2;
    return `<circle class="scene-node scene-node-circle" cx="${svgNum(cx)}" cy="${svgNum(cy)}" r="${svgNum(r)}" ${paint}/>`;
  }
  const rx = 12 * (Number.isFinite(palette.geoScale) && palette.geoScale > 0 ? palette.geoScale : 1);
  return `<rect class="scene-node scene-node-${svgEsc(node.variant || 'default')}" x="${svgNum(x)}" y="${svgNum(y)}" width="${svgNum(w)}" height="${svgNum(h)}" rx="${svgNum(rx)}" ry="${svgNum(rx)}" ${paint}/>`;
};

// 结构 token（皮肤第一层）在导出侧的取值；palette.metrics 由 skinExportTheme 带入，
// 独立调用（无皮肤上下文）时回落到 METRICS_SPEC 的默认值。
const SVG_METRIC_FALLBACK = { iconSize: 26, iconSizeTop: 28, iconGapX: 10, iconGapTop: 6, cardPadX: 28,
  typeNode: 24, typeSmall: 20, panelPadX: 20, panelPadTop: 42,
  panelPadLeft: 0, panelLabelH: 18, panelLabelPadX: 0, panelLabelW: 40, panelLabelInset: 0, labelSubGap: 5 };
const SVG_METRIC_ENUM_FALLBACK = { panelLabelMode: 'chip', panelLabelAlign: 'left' };
export const svgMetric = (palette, key) => {
  const m = palette && palette.metrics;
  const v = m ? m[key] : undefined;
  return Number.isFinite(v) ? v : SVG_METRIC_FALLBACK[key];
};
// 枚举型结构 token（panelLabelMode / panelLabelAlign）不走数值口径
export const svgMetricRaw = (palette, key) => {
  const m = palette && palette.metrics;
  const v = m ? m[key] : undefined;
  return typeof v === 'string' && v ? v : SVG_METRIC_ENUM_FALLBACK[key];
};
// "10px" → 10；空/none/0 → 0
export const svgLenPx = (value) => {
  const n = parseFloat(String(value == null ? '' : value));
  return Number.isFinite(n) ? n : 0;
};
const svgEstTextWidth = (text, px) => svgEstimateTextWidth(text, px);

// 图标位底板（皮肤 tokens 的 iconChipBg / iconChipR / iconGlyphRatio）。
// 老皮肤没声明就退回无底色、字形铺满，与之前一字不差。
export const svgIconChip = (palette) => {
  const c = palette && palette.iconChip;
  const ratio = c && Number.isFinite(c.glyph) ? c.glyph : 1;
  return {
    bg: c && c.bg && c.bg !== 'transparent' ? c.bg : null,
    r: c ? svgLenPx(c.r) : 0,
    glyph: ratio > 0 && ratio <= 1 ? ratio : 1,
  };
};

const svgNodeIconMarkup = (node, palette) => {
  const icon = node.icon;
  if (!icon || (!icon.path && !icon.svg)) return '';
  const onTop = icon.position === 'top';
  const box = svgMetric(palette, onTop ? 'iconSizeTop' : 'iconSize');
  const chip = svgIconChip(palette);
  // box 是底板边长；字形按 glyph 占比缩在底板正中
  const glyph = box * chip.glyph;
  const scale = glyph / svgViewBoxSize(icon.viewBox);
  // 左置图标: 图标 + 文字是一个整体, 在卡片里居中(设计稿口径), 不再贴着左内边距
  const gapX = svgMetric(palette, 'iconGapX');
  const labelPx = Number.isFinite(node.labelPx) ? node.labelPx : svgMetric(palette, 'typeNode');
  const subPx = Number.isFinite(node.subPx) ? node.subPx : svgMetric(palette, 'typeSmall');
  const tw = Math.max(svgEstTextWidth(node.label, labelPx),
    node.sublabel ? svgEstTextWidth(node.sublabel, subPx) : 0);
  const bx = onTop ? node.x + node.w / 2 - box / 2
    : node.x + Math.max(svgMetric(palette, 'cardPadX'), (node.w - (box + gapX + tw)) / 2);
  const by = onTop ? node.y + svgMetric(palette, 'iconGapTop') + 4 : node.y + node.h / 2 - box / 2;
  const ix = bx + (box - glyph) / 2;
  const iy = by + (box - glyph) / 2;
  const geo = Number.isFinite(palette.geoScale) && palette.geoScale > 0 ? palette.geoScale : 1;
  const plate = chip.bg
    ? `<rect class="scene-icon-chip" x="${svgNum(bx)}" y="${svgNum(by)}" width="${svgNum(box)}" height="${svgNum(box)}" rx="${svgNum(chip.r * geo)}" ry="${svgNum(chip.r * geo)}" fill="${svgEsc(chip.bg)}"/>`
    : '';
  const transform = `translate(${svgNum(ix)} ${svgNum(iy)}) scale(${svgNum(scale)})`;
  if (icon.path) {
    const color = icon.color || palette.accent;
    return `${plate}<g class="scene-icon scene-icon-tech" transform="${transform}"><path d="${svgEsc(icon.path)}" fill="${svgEsc(color)}"/></g>`;
  }
  const color = icon.color || palette.textSecondary;
  return `${plate}<g class="scene-icon scene-icon-generic" transform="${transform}" color="${svgEsc(color)}" fill="none" stroke="${svgEsc(color)}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon.svg}</g>`;
};

const svgNodeTextMarkup = (node, palette) => {
  const style = svgVariantStyle(node.variant, palette);
  // padX/iconPx/iconGapPx 由运行时的阶梯自适应按节点解出；没有就回落到皮肤的结构 token
  const pad = Number.isFinite(node.padX) ? node.padX : svgMetric(palette, 'cardPadX');
  const iconLeftW = (Number.isFinite(node.iconPx) ? node.iconPx : svgMetric(palette, 'iconSize'))
    + (Number.isFinite(node.iconGapPx) ? node.iconGapPx : svgMetric(palette, 'iconGapX'));
  const hasIcon = !!(node.icon && (node.icon.path || node.icon.svg));
  const iconLeft = hasIcon && node.icon.position !== 'top';
  const iconTop = hasIcon && node.icon.position === 'top';
  let availW = node.w - pad * 2;
  let textCx = node.x + node.w / 2;
  if (iconLeft) {
    availW -= iconLeftW;
    textCx += iconLeftW / 2;
  }
  if (node.variant === 'decision') availW = node.w * 0.6;
  if (node.variant === 'circle') availW = Math.min(node.w, node.h) * 0.72;
  let centerY = node.y + node.h / 2;
  // 顶置图标把文字整体压低半个图标带高度，与 HTML 里 icon-top 的纵向堆叠一致
  if (iconTop) centerY += (svgMetric(palette, 'iconSizeTop') + svgMetric(palette, 'iconGapTop')) / 2 - 7;
  const sublabel = node.sublabel == null ? '' : String(node.sublabel);
  const label = node.label == null ? '' : String(node.label);
  const parts = [];
  // labelPx/subPx 由运行时的字号自适应写入(外框缩放后的实际字号)；缺省回落到结构 token 的基准字号
  const labelBase = Number.isFinite(node.labelPx) ? node.labelPx : svgMetric(palette, 'typeNode');
  const subBase = Number.isFinite(node.subPx) ? node.subPx : svgMetric(palette, 'typeSmall');
  const labelFont = svgFitFontSize(label, labelBase, availW, Math.min(15, labelBase));
  const subFont = sublabel ? svgFitFontSize(sublabel, subBase, availW, Math.min(15, subBase)) : 0;
  // 双行时按行高排版(而非固定 ∓12/14)，字号被自适应缩小后行距同步收紧。
  // 解释文字的行高是 1.4，与大标题的 1.15 分开 —— 口径同 lib/skins.mjs 的 LINE_H_SUB。
  const labelLine = labelFont * 1.15;
  const subLine = subFont * 1.4;
  const gap = sublabel ? svgMetric(palette, 'labelSubGap') : 0;
  const blockTop = centerY - (labelLine + gap + subLine) / 2;
  const labelY = sublabel ? blockTop + labelLine / 2 : centerY;
  // 有左置图标时文字块左对齐并紧贴图标（口径同页面的 .node.icon-left）：
  // 整组在卡片里居中，文字块自身从图标右缘起排
  const anchor = iconLeft ? 'start' : 'middle';
  const textW = iconLeft
    ? Math.max(svgEstTextWidth(label, labelFont), sublabel ? svgEstTextWidth(sublabel, subFont) : 0)
    : 0;
  const textX = iconLeft
    ? node.x + (node.w - (iconLeftW + textW)) / 2 + iconLeftW
    : textCx;
  parts.push(`<text class="scene-node-label" x="${svgNum(textX)}" y="${svgNum(labelY)}" text-anchor="${anchor}" dominant-baseline="central" font-size="${svgNum(labelFont)}" font-weight="650" fill="${style.label}">${svgEsc(label)}</text>`);
  if (sublabel) {
    const subY = blockTop + labelLine + gap + subLine / 2;
    parts.push(`<text class="scene-node-sublabel" x="${svgNum(textX)}" y="${svgNum(subY)}" text-anchor="${anchor}" dominant-baseline="central" font-size="${svgNum(subFont)}" fill="${palette.textSecondary}">${svgEsc(sublabel)}</text>`);
  }
  return parts.join('');
};

// 编组标题构件（第一层 panelLabelMode）在导出侧的三种形态。
// 页面走 CSS 属性选择器, 这里走同一份结构 token, 两边必须画出同一个东西 ——
// 尤其是 side 模式: sceneToSvg 不知道方向的话, PPTX 会把层级名横排画出来撑破容器。
export const svgPanelLabelPaint = (container, palette) => {
  const p = (container.depth === 1 ? palette.panel2Label : palette.panelLabel) || {};
  return {
    bg: p.bg && p.bg !== 'transparent' ? p.bg : null,
    ink: p.ink && p.ink !== 'currentColor' ? p.ink : palette.textMuted,
    rawR: p.r,
  };
};

const svgContainerMarkup = (container, palette) => {
  const geo = Number.isFinite(palette.geoScale) && palette.geoScale > 0 ? palette.geoScale : 1;
  const r = 16 * geo;
  const rect = `<rect class="scene-container" x="${svgNum(container.x)}" y="${svgNum(container.y)}" width="${svgNum(container.w)}" height="${svgNum(container.h)}" rx="${svgNum(r)}" ry="${svgNum(r)}" fill="${palette.containerFill}" stroke="${palette.containerBorder}" stroke-width="1.5" stroke-dasharray="6 6"/>`;
  if (container.label == null || String(container.label) === '') return rect;

  const mode = svgMetricRaw(palette, 'panelLabelMode');
  const padLeft = svgMetric(palette, 'panelPadLeft') || svgMetric(palette, 'panelPadX');
  const barH = svgMetric(palette, 'panelLabelH');
  const labelPadX = svgMetric(palette, 'panelLabelPadX');
  const colW = svgMetric(palette, 'panelLabelW');
  const base = Number.isFinite(container.labelPx) ? container.labelPx : 20;
  const paint = svgPanelLabelPaint(container, palette);
  paint.r = svgLenPx(paint.rawR) || r * 0.5;
  const textAttrs = (font) => `font-size="${svgNum(font)}" font-weight="650" letter-spacing="2" fill="${paint.ink}"`;

  if (mode === 'bar-top') {
    const font = svgFitFontSize(container.label, base, container.w - labelPadX * 2, Math.min(15, base));
    const plate = paint.bg
      ? `<rect class="scene-container-bar" x="${svgNum(container.x)}" y="${svgNum(container.y)}" width="${svgNum(container.w)}" height="${svgNum(barH)}" rx="${svgNum(r)}" ry="${svgNum(r)}" fill="${svgEsc(paint.bg)}"/>`
        // 下面两个角要方的: 再盖一块无圆角的矩形补满带子的下半截
        + `<rect class="scene-container-bar-foot" x="${svgNum(container.x)}" y="${svgNum(container.y + barH / 2)}" width="${svgNum(container.w)}" height="${svgNum(barH / 2)}" fill="${svgEsc(paint.bg)}"/>`
      : '';
    const centered = svgMetricRaw(palette, 'panelLabelAlign') === 'center';
    const tx = centered ? container.x + container.w / 2 : container.x + labelPadX;
    const anchor = centered ? 'middle' : 'start';
    const text = `<text class="scene-container-label" x="${svgNum(tx)}" y="${svgNum(container.y + barH / 2)}" text-anchor="${anchor}" dominant-baseline="central" ${textAttrs(font)}>${svgEsc(container.label)}</text>`;
    return rect + plate + text;
  }

  if (mode === 'side') {
    // 竖条是"内嵌在容器里的一枚圆角矩形"(设计稿口径): 四周留 inset、四角都圆
    const inset = svgMetric(palette, 'panelLabelInset');
    const barX = container.x + inset;
    const barY = container.y + inset;
    const barH = Math.max(0, container.h - inset * 2);
    const font = svgFitFontSize(container.label, base, barH - labelPadX * 2, Math.min(15, base));
    const lr = paint.r;
    const plate = paint.bg
      ? `<rect class="scene-container-bar" x="${svgNum(barX)}" y="${svgNum(barY)}" width="${svgNum(colW)}" height="${svgNum(barH)}" rx="${svgNum(lr)}" ry="${svgNum(lr)}" fill="${svgEsc(paint.bg)}"/>`
      : '';
    // 竖排: 逐字换行, 与页面的 writing-mode:vertical-rl 同一个观感; 整列在竖条里居中
    const chars = String(container.label).split('').filter((ch) => ch.trim() !== '');
    const cx = barX + colW / 2;
    const step = font * 1.15;
    const top = barY + barH / 2 - (chars.length - 1) * step / 2;
    const rows = chars.map((ch, i) =>
      `<text class="scene-container-label" x="${svgNum(cx)}" y="${svgNum(top + i * step)}" text-anchor="middle" dominant-baseline="central" ${textAttrs(font)}>${svgEsc(ch)}</text>`).join('');
    return rect + plate + rows;
  }

  // chip: 左对齐容器左内边距, 在顶部内边距带里垂直居中
  const padTop = svgMetric(palette, 'panelPadTop');
  const font = svgFitFontSize(container.label, base, container.w - padLeft - svgMetric(palette, 'panelPadX') - labelPadX * 2, Math.min(15, base));
  const chipW = svgEstTextWidth(container.label, font) + labelPadX * 2;
  const chipY = container.y + (padTop - barH) / 2;
  const plate = paint.bg
    ? `<rect class="scene-container-chip" x="${svgNum(container.x + padLeft)}" y="${svgNum(chipY)}" width="${svgNum(chipW)}" height="${svgNum(barH)}" rx="${svgNum(paint.r)}" ry="${svgNum(paint.r)}" fill="${svgEsc(paint.bg)}"/>`
    : '';
  const text = `<text class="scene-container-label" x="${svgNum(container.x + padLeft + labelPadX)}" y="${svgNum(chipY + barH / 2)}" dominant-baseline="central" ${textAttrs(font)}>${svgEsc(container.label)}</text>`;
  return rect + plate + text;
};

// 连线权重：与页面共用 lib/edge-weight.mjs 的求解器。
// palette.edgeScale 是整图几何系数（装框 × 外框）；老调用方只给 edgeWidth 时按它兜底。
export const svgEdgeWeight = (palette) => {
  const base = Number.isFinite(palette.edgeWidthBase) ? palette.edgeWidthBase
    : Number.isFinite(palette.edgeWidth) ? palette.edgeWidth : 2;
  const scale = Number.isFinite(palette.edgeScale) && palette.edgeScale > 0 ? palette.edgeScale : 1;
  return edgeWeight(base, scale);
};

export const svgEdgeInk = (palette) => {
  if (typeof palette.edgeSolid === 'string' && Number.isFinite(palette.edgeAlpha)) {
    return { solid: palette.edgeSolid, alpha: palette.edgeAlpha };
  }
  return splitColorAlpha(palette.edge);
};

// 只画线体（含箭头端点）。标签由 svgEdgeLabelMarkup 单独出一份，
// 好让所有线先画完、标签再统一压在最上面。
const svgEdgeMarkup = (edge, palette) => {
  const pts = edge.pts;
  if (!Array.isArray(pts) || pts.length < 2) return '';
  const style = edge.style === 'dashed' || edge.style === 'bold' ? edge.style : 'solid';
  // 线宽由 edgeWeight() 按整图几何系数求解，与页面同一份口径（见 svgEdgeWeight）
  const baseW = svgEdgeWeight(palette).width;
  const strokeWidth = style === 'bold' ? baseW * 1.75 : baseW;
  const dash = style === 'dashed' ? ` stroke-dasharray="${svgNum(baseW * 3.5)} ${svgNum(baseW * 3)}"` : '';
  // 方向四选一：无向两头都没箭头；双向两头都有；反向只在 source 一侧；正向只在 target 一侧
  const undirected = !!edge.undirected;
  const backOnly = !undirected && !edge.bidirectional && edge.reversed;
  const markerStart = !undirected && (edge.bidirectional || backOnly) ? ' marker-start="url(#sceneArrow)"' : '';
  const markerEnd = undirected || backOnly ? '' : ' marker-end="url(#sceneArrow)"';
  const geo = Number.isFinite(palette.geoScale) && palette.geoScale > 0 ? palette.geoScale : 1;
  // 线与箭头端点都用不透明色，alpha 放到元素级 opacity（组不透明度）上，
  // 否则端点压住线段的那一段会二次合成而变深——与页面 .edge 的处理一致
  const ink = svgEdgeInk(palette);
  return `<path class="scene-edge scene-edge-${style}" d="${svgRoundedPathD(pts, 8 * geo)}" fill="none" stroke="${ink.solid}"${ink.alpha < 1 ? ` opacity="${svgNum(ink.alpha)}"` : ''} stroke-width="${svgNum(strokeWidth)}"${dash} stroke-linecap="round"${markerEnd}${markerStart}/>`;
};

// 边标签（白底药丸 + 文字）。跟线体分开出，最后统一追加在所有线之上。
const svgEdgeLabelMarkup = (edge, palette) => {
  const pts = edge.pts;
  if (!Array.isArray(pts) || pts.length < 2) return '';
  const label = edge.label;
  if (!label || label.text == null || String(label.text) === '') return '';
  const labelBase = Number.isFinite(label.px) ? label.px : 18;
  const font = svgFitFontSize(label.text, labelBase, label.w - 16, Math.min(15, labelBase));
  const bg = `<rect class="scene-edge-label-bg" x="${svgNum(label.x)}" y="${svgNum(label.y)}" width="${svgNum(label.w)}" height="${svgNum(label.h)}" rx="${svgNum(label.h / 2)}" ry="${svgNum(label.h / 2)}" fill="${palette.edgeLabelBg}" stroke="rgba(0,0,0,0.08)"/>`;
  const text = `<text class="scene-edge-label" x="${svgNum(label.x + label.w / 2)}" y="${svgNum(label.y + label.h / 2)}" text-anchor="middle" dominant-baseline="central" font-size="${svgNum(font)}" fill="${palette.edgeLabelText}">${svgEsc(label.text)}</text>`;
  return bg + text;
};

export function sceneToSvg(scene, theme) {
  if (!scene || typeof scene !== 'object') {
    throw new Error('sceneToSvg: scene 不能为空');
  }
  const palette = { ...SCENE_THEME_DEFAULTS, ...(theme ?? {}) };
  const canvasW = Number(scene.canvas?.w) > 0 ? Number(scene.canvas.w) : 1920;
  const canvasH = Number(scene.canvas?.h) > 0 ? Number(scene.canvas.h) : 1080;
  const nodes = Array.isArray(scene.nodes) ? scene.nodes : [];
  const containers = Array.isArray(scene.containers) ? scene.containers : [];
  const edges = Array.isArray(scene.edges) ? scene.edges : [];
  const parts = [];

  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${svgNum(canvasW)}" height="${svgNum(canvasH)}" viewBox="0 0 ${svgNum(canvasW)} ${svgNum(canvasH)}" font-family="${svgEsc(palette.fontFamily)}">`);
  // 箭头端点：markerUnits 取默认的 strokeWidth，几何以线宽为单位，粗边线自动得到大端点。
  // 端点用不透明色，alpha 已在每条边的 opacity 上，端点与线重叠处不叠加。
  const arrow = arrowMarkerGeometry(svgEdgeWeight(palette));
  const arrowInk = svgEdgeInk(palette);
  parts.push(`<defs><marker id="sceneArrow" refX="${arrow.refX}" refY="${arrow.refY}" markerWidth="${arrow.markerWidth}" markerHeight="${arrow.markerHeight}" orient="auto-start-reverse"><path d="${arrow.d}" fill="none" stroke="${arrowInk.solid}" stroke-width="${arrow.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>`);

  // 1. 背景
  parts.push(`<rect class="scene-bg" x="0" y="0" width="${svgNum(canvasW)}" height="${svgNum(canvasH)}" fill="${palette.background}"/>`);

  // 2. 标题 / 副标题
  if (scene.title && scene.title.text) {
    const font = svgFitFontSize(scene.title.text, 56, scene.title.w);
    parts.push(`<text class="scene-title" x="${svgNum(scene.title.x)}" y="${svgNum(scene.title.y + font * 0.9)}" font-size="${svgNum(font)}" font-weight="720" fill="${palette.text}">${svgEsc(scene.title.text)}</text>`);
  }
  if (scene.subtitle && scene.subtitle.text) {
    const font = svgFitFontSize(scene.subtitle.text, 28, scene.subtitle.w);
    parts.push(`<text class="scene-subtitle" x="${svgNum(scene.subtitle.x)}" y="${svgNum(scene.subtitle.y + font * 0.9)}" font-size="${svgNum(font)}" fill="${palette.textSecondary}">${svgEsc(scene.subtitle.text)}</text>`);
  }

  // 3. 容器（浅层在先）
  const sortedContainers = containers.slice().sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0));
  for (const container of sortedContainers) parts.push(svgContainerMarkup(container, palette));

  // 4. 节点卡片 → 5. 节点图标 → 6. 节点文字
  for (const node of nodes) parts.push(svgNodeShapeMarkup(node, palette));
  for (const node of nodes) {
    const markup = svgNodeIconMarkup(node, palette);
    if (markup) parts.push(markup);
  }
  for (const node of nodes) parts.push(svgNodeTextMarkup(node, palette));

  // 7. 全部边线（含箭头端点）—— 连线是最顶层的可见物，不许被节点卡片盖断
  for (const edge of edges) {
    const markup = svgEdgeMarkup(edge, palette);
    if (markup) parts.push(markup);
  }

  // 8. 全部边标签 —— 压在所有线之上，别的边路过时不会把标签划花
  for (const edge of edges) {
    const markup = svgEdgeLabelMarkup(edge, palette);
    if (markup) parts.push(markup);
  }

  parts.push('</svg>');
  return parts.join('\n');
}
