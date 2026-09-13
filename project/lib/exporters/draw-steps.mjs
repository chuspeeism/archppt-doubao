// draw-steps.mjs
// 把 Scene（契约 §1）编译成一串**有序的绘制指令**，供「逐个画出来」的驱动器消费
// （当前唯一的消费者是 project/drivers/mac-powerpoint.mjs，用 AppleScript 驱动
// Microsoft PowerPoint for Mac）。
//
// 这一层只回答两个问题：**先画什么后画什么**、**每一笔的几何与颜色是多少**。
// 「怎么画」（AppleScript 怎么写、形状怎么建）是驱动器的事，这里一个字都不管。
//
// 排版口径不在这里重写：字号自适应、变体配色、结构 token、连线权重全部 import 自
// scene-svg.mjs —— 它是排版的唯一来源。**字体同理**：西文 / 中日韩两个族名 import 自
// scene-pptx.mjs 的 pptxFonts()，与原生 PPTX 导出共用同一份替身规则
// （两步替身的来龙去脉见 docs/pptx-font-substitution.md）。驱动器不设字体的话，
// PowerPoint 会把文字落到主题字体（等线 / 等线 Light / Calibri）上，而卡片宽、药丸宽
// 都是按苹方估的，渲成等线就对不齐 —— 这是「驱动器画出来的那张看着旧」最扎眼的一条。
// draw-steps 与 scene-pptx 是同一份 Scene 的
// 两个消费者，绘制顺序也刻意保持一致（背景 → 标题/副标题 → 容器 → 节点 → 文字 →
// 全部边线 → 全部边标签），这样「一步步画出来的那张」和「一次性导出的那张」是同一张图。
//
// 坐标单位：Scene 是 1920×1080 设计像素，PowerPoint 幻灯片默认 960×540 pt，
// 所以默认 scale = 0.5，**所有几何量与字号统一乘 scale**，出口即 pt。
//
// 导出名：sceneToDrawSteps / drawStepsSummary / flattenColor / DRAW_STEP_KINDS /
//         DRAW_OP_KINDS / DRAW_DEFAULT_SCALE / DRAW_SHAPE_OPS

import { SCENE_THEME_DEFAULTS, svgFitFontSize, svgEstimateTextWidth, svgVariantStyle, svgMetric, svgMetricRaw, svgLenPx, svgPanelLabelPaint, svgEdgeWeight, svgEdgeInk } from './scene-svg.mjs';
import { dmlColor } from './drawingml.mjs';
import { PPTX_TEXT_METRICS, pptxFonts } from './scene-pptx.mjs';

/** step.kind 的全集。面板只认这六种，别的一律不许出现（见 shells/doubao/runner/panel/CONTRACT.md）。 */
export const DRAW_STEP_KINDS = Object.freeze(['title', 'subtitle', 'container', 'node', 'edge', 'label']);

/** op.op 的全集。 */
export const DRAW_OP_KINDS = Object.freeze(['rect', 'roundRect', 'text', 'line', 'label']);

/**
 * 会在 PowerPoint 里**新建一个形状**的原语。`text` 不在其中 ——
 * 它是「把文字写进本 step 前一个形状里」，不新建形状。
 * 所以：幻灯片最终形状数 === 全部 step 里这四种 op 的总数。
 * scripts/doubao-draw-check.mjs 靠这条等式验收。
 */
export const DRAW_SHAPE_OPS = Object.freeze(['rect', 'roundRect', 'line', 'label']);

/** Scene 是 1920×1080 设计像素，幻灯片是 960×540 pt。 */
export const DRAW_DEFAULT_SCALE = 0.5;

const round2 = (v) => Math.round(Number(v) * 100) / 100;

/**
 * 把任意 CSS 颜色压成不透明的 `#RRGGBB`。
 *
 * PowerPoint 的 `fore color` 只吃 {R,G,B} 整数三元组，没有 alpha 这一维
 * （形状级 transparency 是另一套属性，逐个设会让每步多一次 Apple event，
 * 而半透明色在架构图里全是「浅色叠在底色上」，直接合成掉观感一样）。
 * 所以带 alpha 的颜色在这一层就按 backdrop 合成掉，驱动器只会看到纯色。
 *
 * @param {string} css 任意 CSS 颜色（#rgb / #rrggbb / #rrggbbaa / rgb() / rgba()）
 * @param {string} backdrop 底色，必须是已经不透明的 `#RRGGBB`
 * @returns {string|null} `#RRGGBB`；无法解析（none / transparent / currentColor）时返回 null
 */
export function flattenColor(css, backdrop) {
  const c = dmlColor(css);
  if (!c) return null;
  if (c.alpha >= 1) return `#${c.hex}`;
  const back = dmlColor(backdrop) || { hex: 'FFFFFF', alpha: 1 };
  const mix = (hi, lo) => {
    const fg = parseInt(c.hex.slice(hi, lo), 16);
    const bg = parseInt(back.hex.slice(hi, lo), 16);
    const v = Math.round(fg * c.alpha + bg * (1 - c.alpha));
    return (v < 16 ? '0' : '') + Math.max(0, Math.min(255, v)).toString(16).toUpperCase();
  };
  return `#${mix(0, 2)}${mix(2, 4)}${mix(4, 6)}`;
}

const geoOf = (palette) => (Number.isFinite(palette.geoScale) && palette.geoScale > 0 ? palette.geoScale : 1);

// 矩形 inner 是否落在 outer 里（留 1px 容差，容器边与卡片边相切也算在内）
const rectInside = (outer, inner) => inner.x >= outer.x - 1 && inner.y >= outer.y - 1
  && inner.x + inner.w <= outer.x + outer.w + 1 && inner.y + inner.h <= outer.y + outer.h + 1;

/**
 * 每个容器 / 节点脚下踩的是什么底色 —— 半透明色要按它合成。
 * 容器按 depth 由浅到深逐层合成；节点取「包住它的最深那个容器」的合成底色。
 */
const buildBackdrops = (scene, palette, pageBg) => {
  const containers = (Array.isArray(scene.containers) ? scene.containers : [])
    .slice().sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0));
  const fills = new Map();
  const under = (rect, maxDepth) => {
    let best = null;
    for (const c of containers) {
      if ((c.depth ?? 0) >= maxDepth) continue;
      if (!rectInside(c, rect)) continue;
      if (!best || (c.depth ?? 0) > (best.depth ?? 0)) best = c;
    }
    return best ? (fills.get(best.id) || pageBg) : pageBg;
  };
  for (const c of containers) {
    const back = under(c, c.depth ?? 0);
    fills.set(c.id, flattenColor(palette.containerFill, back) || back);
  }
  return {
    /** 容器自己踩的底色（画它的边框/底板时用） */
    forContainer: (c) => under(c, c.depth ?? 0),
    /** 节点踩的底色 */
    forNode: (n) => under(n, Infinity),
  };
};

// 变体 → PowerPoint 形状。默认走圆角矩形，其余四种各有对应的 autoshape。
const shapeOfVariant = (variant, w, h, radius) => {
  if (variant === 'decision') return { op: 'rect', shape: 'diamond' };
  if (variant === 'circle') return { op: 'rect', shape: 'oval' };
  if (variant === 'database') return { op: 'rect', shape: 'can' };
  if (variant === 'pill') return { op: 'roundRect', shape: 'roundRect', radius: Math.min(w, h) / 2 };
  return { op: 'roundRect', shape: 'roundRect', radius };
};

/** circle 变体的外框 → 内切正圆的外接方框；其余变体原样返回。 */
const geoOfCircle = (n) => {
  if (n.variant !== 'circle') return { x: n.x, y: n.y, w: n.w, h: n.h };
  const r = Math.min(n.w, n.h) / 2;
  return { x: n.x + n.w / 2 - r, y: n.y + n.h / 2 - r, w: r * 2, h: r * 2 };
};

/**
 * Scene → 有序绘制指令流。
 *
 * @param {object} scene 契约 §1 的 Scene
 * @param {object} theme skinExportTheme() 出来的导出主题（缺省回落 SCENE_THEME_DEFAULTS）
 * @param {{ scale?: number }} [options] scale 默认 0.5（1920px → 960pt）
 * @returns {Array} steps，每项 `{ i, total, kind, id, label, ops, skipped? }`
 */
export function sceneToDrawSteps(scene, theme, options) {
  if (!scene || typeof scene !== 'object') throw new Error('sceneToDrawSteps: scene 不能为空');
  const palette = { ...SCENE_THEME_DEFAULTS, ...(theme || {}) };
  const opts = options || {};
  const scale = Number.isFinite(opts.scale) && opts.scale > 0 ? opts.scale : DRAW_DEFAULT_SCALE;
  const S = (v) => round2(Number(v) * scale);

  const nodes = Array.isArray(scene.nodes) ? scene.nodes : [];
  const containers = Array.isArray(scene.containers) ? scene.containers : [];
  const edges = Array.isArray(scene.edges) ? scene.edges : [];
  const geo = geoOf(palette);
  // 皮肤的 CSS 字体栈 → PPT 的两个字段（西文 a:latin / 中日韩 a:ea）。等宽皮肤（terminal）
  // 得到等宽族、衬线皮肤（journal）得到衬线族，跟着皮肤走，这里不做第二套判断。
  const fonts = pptxFonts(palette);
  const pageBg = flattenColor(palette.background, '#FFFFFF') || '#FFFFFF';
  const backdrops = buildBackdrops(scene, palette, pageBg);

  const steps = [];
  const push = (kind, id, label, ops, extra) => {
    if (!ops.length) return;
    steps.push({ kind, id, label, ops, ...(extra || {}) });
  };

  // 文本框：几何一律按「给定盒子」落，驱动器会把 auto size 关掉，PowerPoint 不许自己缩。
  const textBox = (box, text, font, color, align, extra) => ({
    op: 'label',
    x: S(box.x), y: S(box.y), w: S(box.w), h: S(box.h),
    text: String(text),
    fontSize: S(font),
    fontLatin: fonts.latin,
    fontEa: fonts.ea,
    color,
    align: align || 'center',
    anchor: 'middle',
    fill: null,
    stroke: null,
    ...(extra || {}),
  });

  // ---- 1. 标题 / 副标题 ----------------------------------------------------
  // SVG 按字母基线定位，PowerPoint 的文本框按行盒中心定位，换算常数与 scene-pptx 同源。
  const fromBaseline = (baselineY, px) => baselineY - PPTX_TEXT_METRICS.baselineToCentral * px;
  if (scene.title && scene.title.text) {
    const font = svgFitFontSize(scene.title.text, 56, scene.title.w);
    const h = font * 1.25;
    const w = Math.max(4, svgEstimateTextWidth(scene.title.text, font) * 1.35 + font);
    const cy = fromBaseline(scene.title.y + font * 0.9, font);
    push('title', 'title', scene.title.text, [
      textBox({ x: scene.title.x, y: cy - h / 2, w, h }, scene.title.text, font,
        flattenColor(palette.text, pageBg) || '#000000', 'left', { bold: true }),
    ]);
  }
  if (scene.subtitle && scene.subtitle.text) {
    const font = svgFitFontSize(scene.subtitle.text, 28, scene.subtitle.w);
    const h = font * 1.25;
    const w = Math.max(4, svgEstimateTextWidth(scene.subtitle.text, font) * 1.35 + font);
    const cy = fromBaseline(scene.subtitle.y + font * 0.9, font);
    push('subtitle', 'subtitle', scene.subtitle.text, [
      textBox({ x: scene.subtitle.x, y: cy - h / 2, w, h }, scene.subtitle.text, font,
        flattenColor(palette.textSecondary, pageBg) || '#666666', 'left'),
    ]);
  }

  // ---- 2. 容器（浅层在先，深层压在上面）------------------------------------
  const sortedContainers = containers.slice().sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0));
  for (const c of sortedContainers) {
    const back = backdrops.forContainer(c);
    const ops = [{
      op: 'roundRect',
      shape: 'roundRect',
      x: S(c.x), y: S(c.y), w: S(c.w), h: S(c.h),
      radius: S(16 * geo),
      fill: flattenColor(palette.containerFill, back),
      stroke: flattenColor(palette.containerBorder, back),
      strokeWidth: S(1.5),
      dash: 'dash',
    }];
    const label = c.label == null ? '' : String(c.label);
    if (label !== '') {
      const inside = flattenColor(palette.containerFill, back) || back;
      const paint = svgPanelLabelPaint(c, palette);
      const mode = svgMetricRaw(palette, 'panelLabelMode');
      const padLeft = svgMetric(palette, 'panelPadLeft') || svgMetric(palette, 'panelPadX');
      const barH = svgMetric(palette, 'panelLabelH');
      const labelPadX = svgMetric(palette, 'panelLabelPadX');
      const colW = svgMetric(palette, 'panelLabelW');
      const base = Number.isFinite(c.labelPx) ? c.labelPx : 20;
      const r = svgLenPx(paint.rawR) || 16 * geo * 0.5;
      const ink = flattenColor(paint.ink, inside) || flattenColor(palette.textMuted, inside);
      const plate = paint.bg ? flattenColor(paint.bg, inside) : null;

      if (mode === 'bar-top') {
        const font = svgFitFontSize(label, base, c.w - labelPadX * 2, Math.min(15, base));
        const centered = svgMetricRaw(palette, 'panelLabelAlign') === 'center';
        ops.push(textBox({ x: c.x, y: c.y, w: c.w, h: barH }, label, font, ink,
          centered ? 'center' : 'left',
          { fill: plate, radius: S(r), padX: centered ? 0 : S(labelPadX) }));
      } else if (mode === 'side') {
        // 竖排：逐字一段，整列在竖条里居中（口径同 scene-svg 的 writing-mode:vertical-rl）
        const inset = svgMetric(palette, 'panelLabelInset');
        const barX = c.x + inset;
        const barY = c.y + inset;
        const barHeight = Math.max(0, c.h - inset * 2);
        const font = svgFitFontSize(label, base, barHeight - labelPadX * 2, Math.min(15, base));
        const chars = label.split('').filter((ch) => ch.trim() !== '');
        ops.push(textBox({ x: barX, y: barY, w: colW, h: barHeight }, chars.join('\n'), font, ink,
          'center', { fill: plate, radius: S(r), vertical: true }));
      } else {
        // chip：贴容器左内边距，在顶部内边距带里垂直居中。
        // 药丸宽度 = 文字宽 + 两侧 padX，所以文字在药丸里居中 === 左内缩 padX，用 center 对齐即可。
        const padTop = svgMetric(palette, 'panelPadTop');
        const font = svgFitFontSize(label, base,
          c.w - padLeft - svgMetric(palette, 'panelPadX') - labelPadX * 2, Math.min(15, base));
        const chipW = svgEstimateTextWidth(label, font) + labelPadX * 2;
        const chipY = c.y + (padTop - barH) / 2;
        ops.push(textBox({ x: c.x + padLeft, y: chipY, w: chipW, h: barH }, label, font, ink,
          'center', { fill: plate, radius: S(r) }));
      }
    }
    push('container', c.id, label, ops);
  }

  // ---- 3. 节点（卡片 + 标签 + sublabel 第二行小字）---------------------------
  // 图标本版**不画**：SVG 图标要拆成自由形，AppleScript 没有 build freeform（见 T1 探针第四节），
  // 逐个建路径不现实。跳过的事实记在 step.skipped 上，面板会照原样显示。
  for (const n of nodes) {
    const back = backdrops.forNode(n);
    const style = svgVariantStyle(n.variant, palette);
    const shape = shapeOfVariant(n.variant, n.w, n.h, 12 * geo);
    // circle 变体画的是外框的**内切正圆**（scene-svg.mjs 的 <circle r=min(w,h)/2>、
    // scene-pptx.mjs 的 pptxNodeShape 都是这份算式），不是撑满外框的椭圆。
    // 常规摆位下卡片是宽扁的、排版器会把它摆正，但扇入聚合点的横条、跨行竖条、
    // 碰撞削宽、spec.positions 手动给的宽高都能留下 w ≠ h —— 那时三条导出路
    // 画出来就是两种形状、两个位置。
    const box = geoOfCircle(n);
    const ops = [{
      op: shape.op,
      shape: shape.shape,
      x: S(box.x), y: S(box.y), w: S(box.w), h: S(box.h),
      ...(shape.radius != null ? { radius: S(shape.radius) } : {}),
      fill: flattenColor(style.fill, back),
      stroke: flattenColor(style.stroke, back),
      strokeWidth: S(1.5),
    }];

    const inside = flattenColor(style.fill, back) || back;
    const pad = Number.isFinite(n.padX) ? n.padX : svgMetric(palette, 'cardPadX');
    let availW = n.w - pad * 2;
    if (n.variant === 'decision') availW = n.w * 0.6;
    if (n.variant === 'circle') availW = Math.min(n.w, n.h) * 0.72;
    const label = n.label == null ? '' : String(n.label);
    const sublabel = n.sublabel == null ? '' : String(n.sublabel);
    const labelBase = Number.isFinite(n.labelPx) ? n.labelPx : svgMetric(palette, 'typeNode');
    const subBase = Number.isFinite(n.subPx) ? n.subPx : svgMetric(palette, 'typeSmall');
    if (label !== '') {
      const font = svgFitFontSize(label, labelBase, availW, Math.min(15, labelBase));
      ops.push({
        op: 'text', text: label, fontSize: S(font),
        fontLatin: fonts.latin, fontEa: fonts.ea,
        color: flattenColor(style.label, inside) || flattenColor(palette.text, inside),
        align: 'center', anchor: 'middle', bold: true,
      });
    }
    if (sublabel !== '') {
      const font = svgFitFontSize(sublabel, subBase, availW, Math.min(15, subBase));
      ops.push({
        op: 'text', text: sublabel, fontSize: S(font),
        fontLatin: fonts.latin, fontEa: fonts.ea,
        color: flattenColor(palette.textSecondary, inside) || '#666666',
        align: 'center', anchor: 'middle', bold: false,
      });
    }
    const hasIcon = !!(n.icon && (n.icon.path || n.icon.svg));
    push('node', n.id, label, ops, hasIcon ? { skipped: 'icon' } : null);
  }

  // ---- 4. 全部边线（一条边一个 step，内部是多段线）--------------------------
  // 折线只能拿多段 line shape 拼（AppleScript 没有 build freeform），所以 SVG 的
  // 圆角拐点在这里退化成直角。方向**四选一**，与 scene-svg 的 markerStart/markerEnd 同口径：
  // 无向两头都没箭头 / 双向两头都有 / 反向只在 source 一侧 / 正向只在 target 一侧。
  // 优先级 undirected > bidirectional > reversed，跟校验器承诺用户的那条一致。
  const ink = svgEdgeInk(palette);
  const baseW = svgEdgeWeight(palette).width;
  // 半透明边色要按页面底色压成不透明。**不许手工切 `#rrggbb` 的字符串**：
  // svgEdgeInk 拿到 rgba() 写法时返回的 solid 是 `rgb(r, g, b)`（见 lib/edge-weight.mjs 的
  // splitColorAlpha），按 slice(1,3) 切出来是 "gb"/"(1"/"90"，parseInt 全是 NaN，
  // 最后产出 "#NANNAN0C" 这种废色；驱动器的 rgb() 只查长度是不是 6，废色返回 null，
  // 于是它干脆不发 `set fore color of line format` —— 不报错、不告警，整张图的连线
  // 悄悄退回 PowerPoint 主题默认线色。midnight / terminal 两套皮肤的边色就是 rgba 写法。
  // dmlColor 认得 rgb() / rgba() / #rgb / #rrggbb 全部写法，交给它解析。
  const inkSolid = dmlColor(ink.solid);
  const edgeColor = flattenColor(
    inkSolid && ink.alpha < 1
      ? `rgba(${parseInt(inkSolid.hex.slice(0, 2), 16)},${parseInt(inkSolid.hex.slice(2, 4), 16)},${parseInt(inkSolid.hex.slice(4, 6), 16)},${ink.alpha})`
      : ink.solid,
    pageBg,
  ) || '#888888';
  for (const e of edges) {
    const pts = Array.isArray(e.pts) ? e.pts : [];
    if (pts.length < 2) continue;
    const style = e.style === 'dashed' || e.style === 'bold' ? e.style : 'solid';
    const width = style === 'bold' ? baseW * 1.75 : baseW;
    const undirected = !!e.undirected;
    const backOnly = !undirected && !e.bidirectional && !!e.reversed;
    const ops = [];
    for (let i = 0; i < pts.length - 1; i += 1) {
      const last = i === pts.length - 2;
      ops.push({
        op: 'line',
        x1: S(pts[i].x), y1: S(pts[i].y), x2: S(pts[i + 1].x), y2: S(pts[i + 1].y),
        color: edgeColor,
        width: S(width),
        dash: style === 'dashed' ? 'dash' : null,
        arrowStart: !undirected && i === 0 && (!!e.bidirectional || backOnly),
        arrowEnd: !undirected && last && !backOnly,
      });
    }
    push('edge', e.id, e.label && e.label.text ? String(e.label.text) : '', ops);
  }

  // ---- 5. 全部边标签（压在所有线之上）--------------------------------------
  for (const e of edges) {
    const l = e.label;
    if (!l || l.text == null || String(l.text) === '') continue;
    const base = Number.isFinite(l.px) ? l.px : 18;
    const font = svgFitFontSize(l.text, base, l.w - 16, Math.min(15, base));
    push('label', e.id, String(l.text), [
      textBox({ x: l.x, y: l.y, w: l.w, h: l.h }, l.text, font,
        flattenColor(palette.edgeLabelText, flattenColor(palette.edgeLabelBg, pageBg) || pageBg) || '#333333',
        'center',
        {
          fill: flattenColor(palette.edgeLabelBg, pageBg),
          stroke: flattenColor('rgba(0,0,0,0.08)', flattenColor(palette.edgeLabelBg, pageBg) || pageBg),
          strokeWidth: S(1),
          radius: S(l.h / 2),
        }),
    ]);
  }

  const total = steps.length;
  return steps.map((s, i) => ({ i: i + 1, total, ...s }));
}

/** 给驱动器和面板用的一句话摘要：几步、几个形状、按 kind 分了几类。 */
export function drawStepsSummary(steps) {
  const list = Array.isArray(steps) ? steps : [];
  const byKind = {};
  let shapes = 0;
  for (const s of list) {
    byKind[s.kind] = (byKind[s.kind] || 0) + 1;
    for (const op of s.ops || []) if (DRAW_SHAPE_OPS.indexOf(op.op) >= 0) shapes += 1;
  }
  return { total: list.length, shapes, byKind };
}
