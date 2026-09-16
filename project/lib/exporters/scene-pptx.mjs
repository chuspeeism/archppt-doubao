// scene-pptx.mjs [INLINE]
// 把 Scene（契约 §1）画成**原生 PPT 形状**：圆角矩形、菱形、椭圆、自由形连线、
// 真文本框、真矢量图标。旧的 pptx-writer 只会把整页 PNG 铺满一张 slide，
// 打开后除了缩放什么都做不了；这里出来的每一张卡、每一条线都能在 PowerPoint 里选中改。
//
// 唯一的正确性依据是「与 sceneToSvg 画同一个东西」，所以字号自适应、变体配色、
// 结构 token 取值、连线权重全部 import 自 scene-svg.mjs，不另写一份 ——
// 之前 PPTX 与页面对不上，根子就在两边各算各的。
//
// 绘制顺序同 SVG：背景 → 标题/副标题 → 容器 → 节点 → 图标 → 文字 → 全部边线 → 全部边标签。
// PPT 没有 z-index，也是后写的压在上面，两边天然一致。
//
// 导出名：sceneToPptxShapes / sceneToPptx / PPTX_TEXT_METRICS / pptxFonts

// import 必须整行写完（构建期按行剥离，见 docs/phase2-contracts.md §0）
import { dmlColor, dmlSolidFill, dmlNoFill, dmlLine, dmlPrstShape, dmlRoundAdj, dmlCustomShape, dmlTextShape, dmlSlideXml } from './drawingml.mjs';
import { svgPathToSubpaths, svgMarkupToShapes } from './svg-path.mjs';
import { SCENE_THEME_DEFAULTS, svgFitFontSize, svgEstimateTextWidth, svgVariantStyle, svgMetric, svgMetricRaw, svgLenPx, svgIconChip, svgPanelLabelPaint, svgEdgeWeight, svgEdgeInk, svgViewBoxSize } from './scene-svg.mjs';
import { sceneTitleFit } from '../title-fit.mjs';

// 文本竖直落点的换算常数（单位：em）。
//   centralDrop —— SVG 的 dominant-baseline="central" 相对「PowerPoint 行盒中心」的偏移。
//   baselineToCentral —— 字母基线上方多少算 central（标题/副标题按基线定位）。
// 都由 scripts/pptx-calibrate.mjs 在真 PowerPoint 上扫出来，别凭手感改。
export const PPTX_TEXT_METRICS = { centralDrop: 0, baselineToCentral: 0.36 };

// centralDrop 跟**西文字体**走，不是一个全局常数：PowerPoint 的 anchor="ctr" 居中的是
// 行盒，字形在行盒里的位置由字体的 ascent/descent 比例决定，换个西文族就会整体挪一点。
// 实测（scripts/pptx-calibrate.mjs，真 PowerPoint）：
//   苹方系皮肤 5 份用例里 4 份在 0 最好，加偏移只会变差；
//   等宽皮肤（Menlo）case-08 从 92.50% → 94.60%，把 source 皮肤套到 case-01 上
//   同样从 98.73% → 99.02% —— 换了用例仍然跟着字体走，所以按字体建表而不是取平均。
const PPTX_CENTRAL_DROP = { menlo: 0.05 };
const pptxCentralDropFor = (latin) => {
  const v = PPTX_CENTRAL_DROP[String(latin || '').toLowerCase()];
  return Number.isFinite(v) ? v : PPTX_TEXT_METRICS.centralDrop;
};

const pptxNum = (v) => Math.round(Number(v) * 100) / 100;

const pptxAlphaColor = (color, alpha) => {
  const c = dmlColor(color);
  if (!c) return color;
  const a = c.alpha * (Number.isFinite(alpha) ? alpha : 1);
  return `rgba(${parseInt(c.hex.slice(0, 2), 16)},${parseInt(c.hex.slice(2, 4), 16)},`
    + `${parseInt(c.hex.slice(4, 6), 16)},${a})`;
};

const pptxGeo = (palette) =>
  (Number.isFinite(palette.geoScale) && palette.geoScale > 0 ? palette.geoScale : 1);

// —— 文本：把 SVG 的落点口径换成 dmlTextShape 要的「行盒中心」——
const pptxCentral = (palette, y, px) =>
  y + (Number.isFinite(palette.pptxCentralDrop) ? palette.pptxCentralDrop : PPTX_TEXT_METRICS.centralDrop) * px;
const pptxFromBaseline = (palette, baselineY, px) => {
  const k = Number.isFinite(palette.pptxBaselineToCentral)
    ? palette.pptxBaselineToCentral : PPTX_TEXT_METRICS.baselineToCentral;
  return pptxCentral(palette, baselineY - k * px, px);
};

// —— 字体：把皮肤的 CSS 字体栈翻成 PPT 的两个字段（西文 a:latin / 中日韩 a:ea）——
//
// 分两步，别把它们揉在一起：
//   第一步「浏览器会用谁」—— 基准就是浏览器画出来的那张图，先把 CSS 栈解析成
//     浏览器最终落地的族；
//   第二步「PowerPoint 选得中吗」—— 选不中的换成实测最接近的替身（见 PPTX_LATIN_SUB）。
//
// DrawingML 每一类字形只能填**一个**族名，没有回退链，所以第一步必须自己解。三条实测规则：
//   1. 栈里第一个具体族就是浏览器实际用的族（栈首那个解析不出来才往后找）。
//   2. -apple-system / system-ui / SF Pro 这类系统族，Chrome 解析成 SF，
//      但 PowerPoint 的字体表里没有它，只能换一个观感最近的替身。
//   3. 中日韩字形取栈里第一个真有汉字的族；栈里写了但本机多半没装的
//      （Noto/思源系列），浏览器同样会回退到苹方，这里跟着回退。
const PPTX_GENERIC = ['sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'ui-sans-serif', 'ui-serif'];
const PPTX_SYSTEM_ALIAS = ['-apple-system', 'system-ui', 'blinkmacsystemfont'];
const PPTX_MONO_ALIAS = ['ui-monospace'];
// macOS 把 SF 全家列为系统保留字体，普通程序（含 Chrome 和 PowerPoint）都选不中它，
// 实际渲染时会**继续往栈后面找**。所以这里也只把它记成候补替身，不当作落地族 ——
// terminal 皮肤写着 'SF Mono',Menlo,...，页面上真正画字的是 Menlo（实测西文宽度
// 与 Menlo 一致、与 SF Mono 不一致），PPT 里就必须也写 Menlo。
const PPTX_UNAVAILABLE = {
  'sf mono': 'Menlo',
  'sf pro': 'Helvetica Neue', 'sf pro text': 'Helvetica Neue', 'sf pro display': 'Helvetica Neue',
};
const PPTX_SYSTEM_SUB = 'Helvetica Neue';
const PPTX_MONO_SUB = 'Menlo';
// 有汉字字形的族（键为小写）→ 落到 PPT 里的名字；值为 null 表示本机多半没装，跟浏览器一起回退
const PPTX_CJK_FAMILIES = {
  'pingfang sc': 'PingFang SC', 'pingfang tc': 'PingFang TC', 'pingfang hk': 'PingFang HK',
  'songti sc': 'Songti SC', 'heiti sc': 'Heiti SC', stheiti: 'STHeiti',
  'hiragino sans gb': 'Hiragino Sans GB',
  'microsoft yahei': 'Microsoft YaHei', simsun: 'SimSun', simhei: 'SimHei',
  'noto sans sc': null, 'noto sans cjk sc': null, 'noto sans mono cjk sc': null,
  'source han sans sc': null, 'source han serif sc': null,
};
const PPTX_CJK_FALLBACK = 'PingFang SC';

// —— 第二步：PowerPoint 选不中的族 → 实测最接近的替身 ——
//
// 苹方是这里唯一也是最贵的一处。macOS 把它装在字体资产目录里
// （/System/Library/AssetsV2/…/PingFang.ttc），只有走系统回退才拿得到，**按族名点名拿不到**：
// Office 的字体表里没有 "PingFang SC"，也没有本地化名 "苹方-简"，写进 a:latin / a:ea
// 会被**静默**换成主题字体（实测替身就是 Calibri，与写 "NoSuchFont" 的结果一模一样）。
//
// 后果是横向步进漂移：Calibri 的西文比苹方的西文窄将近两成（同一把标尺 36px 下，
// 苹方 421px、Calibri 341px），一个空格、一段英文过去就偏一截，误差从左往右累积，
// 后面的中文整体左移。case-10 标题「多租户 SaaS 数据平台」到行尾差了 43px，
// case-04「医院 HIS 系统上云方案」差 30px —— 十份用例标题/副标题只有 75.9%/79.9% 的
// 命中率就是这么来的，跟竖直落点无关。
//
// 替身按实测定，不凭手感：西文候选在真 PowerPoint 上扫过一轮
// （scripts/pptx-calibrate.mjs --param pptxLatin），Helvetica Neue 最好；
// 中日韩候选同法扫 pptxEa。注意「字形宽度最接近」不等于「像得最像」——
// Geneva 的步进比 Helvetica Neue 更接近苹方，但字形差得远，实测反而更低。
const PPTX_LATIN_SUB = {
  'pingfang sc': 'Helvetica Neue', 'pingfang tc': 'Helvetica Neue', 'pingfang hk': 'Helvetica Neue',
};
// 中日韩这边**不要**跟着换。PowerPoint 同样选不中苹方，但它的替身（主题字体 Calibri）
// 没有汉字，于是又走一层系统级中日韩回退 —— 这一层在 macOS 上落回的正好就是苹方本身。
// 实测：把 a:ea 点名换成 Hiragino Sans GB，纯中文标题反而整片掉分
// （case-01 85.2%→77.7%、case-06 85.1%→75.9%、等宽皮肤的 case-08 整份 −2.1 点）。
// 所以这里保持写苹方，让 PowerPoint 自己回退。
const PPTX_EA_SUB = {};
const pptxPptSafe = (family, table) => {
  const hit = table[String(family || '').toLowerCase()];
  return hit || family;
};

const pptxFamilies = (stack) => String(stack == null ? '' : stack)
  .split(',')
  .map((f) => f.trim().replace(/^['"]|['"]$/g, ''))
  .filter((f) => f !== '');

// 导出给 draw-steps.mjs 用：豆包驱动器（AppleScript / COM 逐个画形状那条路）要和
// 原生 PPTX 导出写同一对字体名，否则 PowerPoint 会把文字落到主题字体（等线 / Calibri）上，
// 而卡片宽、药丸宽都是按苹方估的，渲成等线就对不齐。**替身规则只有这一份**，别再抄一遍。
// 加 export 不改逻辑：构建期 stripModuleSyntax 会把行首的 `export ` 整个剥掉，
// 内联进产物的代码与加 export 之前逐字节相同。
export const pptxFonts = (palette) => {
  const families = pptxFamilies(palette.fontFamily);
  let latin = null;
  let pending = null;   // 系统别名对应的替身：只有整条栈都没有具体族时才用它
  let ea = null;
  for (const family of families) {
    const key = family.toLowerCase();
    if (!latin) {
      if (PPTX_SYSTEM_ALIAS.indexOf(key) >= 0) pending = pending || PPTX_SYSTEM_SUB;
      else if (PPTX_MONO_ALIAS.indexOf(key) >= 0) pending = pending || PPTX_MONO_SUB;
      else if (Object.prototype.hasOwnProperty.call(PPTX_UNAVAILABLE, key)) pending = pending || PPTX_UNAVAILABLE[key];
      else if (PPTX_GENERIC.indexOf(key) < 0) latin = family;
    }
    if (!ea && Object.prototype.hasOwnProperty.call(PPTX_CJK_FAMILIES, key)) {
      ea = PPTX_CJK_FAMILIES[key] || PPTX_CJK_FALLBACK;
    }
  }
  latin = latin || pending;
  return {
    latin: palette.pptxLatin || pptxPptSafe(latin || PPTX_SYSTEM_SUB, PPTX_LATIN_SUB),
    ea: palette.pptxEa || pptxPptSafe(ea || PPTX_CJK_FALLBACK, PPTX_EA_SUB),
  };
};

// 一支简易 id 发号器：PPTX 里形状 id 必须唯一且从 2 起（1 给 spTree 根）。
const pptxIds = () => { let n = 1; return () => { n += 1; return n; }; };

// —— 正交折线 → 圆角折线的顶点序列。与 svgRoundedPathD 同一套解法（转角二次贝塞尔），
//    只是出口换成 custGeom 认的 ops。两边必须同款，否则线在拐角处会分家。
const pptxRoundedOps = (pts, radius) => {
  const ops = [{ t: 'M', p: [pts[0].x, pts[0].y] }];
  for (let i = 1; i < pts.length - 1; i += 1) {
    const prev = pts[i - 1];
    const curr = pts[i];
    const next = pts[i + 1];
    const inLen = Math.hypot(curr.x - prev.x, curr.y - prev.y);
    const outLen = Math.hypot(next.x - curr.x, next.y - curr.y);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    if (!(r > 0.5) || inLen === 0 || outLen === 0) {
      ops.push({ t: 'L', p: [curr.x, curr.y] });
      continue;
    }
    ops.push({ t: 'L', p: [curr.x - ((curr.x - prev.x) / inLen) * r, curr.y - ((curr.y - prev.y) / inLen) * r] });
    ops.push({
      t: 'Q',
      p: [curr.x, curr.y,
        curr.x + ((next.x - curr.x) / outLen) * r, curr.y + ((next.y - curr.y) / outLen) * r],
    });
  }
  const last = pts[pts.length - 1];
  ops.push({ t: 'L', p: [last.x, last.y] });
  return { closed: false, ops };
};

// —— 箭头端点：SVG 那枚 marker 是「开口 V 形描边」，几何以线宽为单位写死在
//    arrowMarkerGeometry 里。这里直接在画布坐标里摆同一个 V：尖点落在折线端点，
//    两条腿沿反方向张开。marker 的 markerUnits 是 strokeWidth，所以粗边线的端点
//    自动等比放大，换算成实际长度就是 headLen × (本线线宽 ÷ 基准线宽)。
const pptxArrowOps = (tip, from, weight, strokeWidth) => {
  const dx = tip.x - from.x;
  const dy = tip.y - from.y;
  const len = Math.hypot(dx, dy);
  if (!(len > 0)) return null;
  const ux = dx / len;
  const uy = dy / len;
  const k = strokeWidth / weight.width;
  const back = weight.headLen * k;
  const half = weight.headHalf * k;
  return {
    closed: false,
    ops: [
      { t: 'M', p: [tip.x - back * ux - half * -uy, tip.y - back * uy - half * ux] },
      { t: 'L', p: [tip.x, tip.y] },
      { t: 'L', p: [tip.x - back * ux + half * -uy, tip.y - back * uy + half * ux] },
    ],
  };
};

// 折线两端「朝外」的方向参考点：取最后一段的起点（长度为 0 时往前找）
const pptxDirRef = (pts, atEnd) => {
  if (atEnd) {
    for (let i = pts.length - 2; i >= 0; i -= 1) {
      if (pts[i].x !== pts[pts.length - 1].x || pts[i].y !== pts[pts.length - 1].y) return pts[i];
    }
    return null;
  }
  for (let i = 1; i < pts.length; i += 1) {
    if (pts[i].x !== pts[0].x || pts[i].y !== pts[0].y) return pts[i];
  }
  return null;
};

// —— 图标：SVG 的 path/元素组搬进 custGeom。transform 与 SVG 里那条
//    translate(ix iy) scale(s) 完全一致，逐点算掉即可。
const pptxMapSubpaths = (subpaths, ix, iy, scale) => subpaths.map((s) => ({
  closed: s.closed,
  ops: s.ops.map((op) => {
    const p = [];
    for (let i = 0; i + 1 < op.p.length; i += 2) {
      p.push(pptxNum(ix + op.p[i] * scale), pptxNum(iy + op.p[i + 1] * scale));
    }
    return { t: op.t, p };
  }),
}));

const pptxIconShapes = (node, palette, nextId) => {
  const icon = node.icon;
  if (!icon || (!icon.path && !icon.svg)) return [];
  const onTop = icon.position === 'top';
  const box = svgMetric(palette, onTop ? 'iconSizeTop' : 'iconSize');
  const chip = svgIconChip(palette);
  const glyph = box * chip.glyph;
  const scale = glyph / svgViewBoxSize(icon.viewBox);
  const gapX = svgMetric(palette, 'iconGapX');
  const labelPx = Number.isFinite(node.labelPx) ? node.labelPx : svgMetric(palette, 'typeNode');
  const subPx = Number.isFinite(node.subPx) ? node.subPx : svgMetric(palette, 'typeSmall');
  const tw = Math.max(svgEstimateTextWidth(node.label, labelPx),
    node.sublabel ? svgEstimateTextWidth(node.sublabel, subPx) : 0);
  const bx = onTop ? node.x + node.w / 2 - box / 2
    : node.x + Math.max(svgMetric(palette, 'cardPadX'), (node.w - (box + gapX + tw)) / 2);
  const by = onTop ? node.y + svgMetric(palette, 'iconGapTop') + 4 : node.y + node.h / 2 - box / 2;
  const ix = bx + (box - glyph) / 2;
  const iy = by + (box - glyph) / 2;
  const geo = pptxGeo(palette);
  const out = [];
  if (chip.bg) {
    out.push(dmlPrstShape({
      id: nextId(), name: `图标底板 ${node.id}`, prst: 'roundRect',
      adj: dmlRoundAdj(chip.r * geo, box, box),
      x: bx, y: by, w: box, h: box,
      fill: dmlSolidFill(chip.bg), line: dmlLine({}),
    }));
  }
  if (icon.path) {
    const color = icon.color || palette.accent;
    const subs = pptxMapSubpaths(svgPathToSubpaths(icon.path), ix, iy, scale);
    if (subs.length) {
      out.push(dmlCustomShape({
        id: nextId(), name: `图标 ${node.id}`, subpaths: subs,
        fill: dmlSolidFill(color), line: dmlLine({}),
      }));
    }
    return out;
  }
  const color = icon.color || palette.textSecondary;
  const parts = svgMarkupToShapes(icon.svg, {
    fill: 'none', stroke: color, strokeWidth: 2, cap: 'round', join: 'round',
  });
  for (const part of parts) {
    const stroke = !part.stroke || part.stroke === 'currentColor' ? color : part.stroke;
    const fill = !part.fill || part.fill === 'none' ? null
      : (part.fill === 'currentColor' ? color : part.fill);
    const subs = pptxMapSubpaths(part.subpaths, ix, iy, scale);
    if (!subs.length) continue;
    out.push(dmlCustomShape({
      id: nextId(), name: `图标 ${node.id}`, subpaths: subs,
      fill: fill ? dmlSolidFill(fill) : dmlNoFill(),
      line: dmlLine({
        color: stroke, width: part.strokeWidth * scale,
        cap: part.cap === 'round' ? 'round' : 'butt',
        join: part.join === 'round' ? 'round' : part.join,
      }),
    }));
  }
  return out;
};

const pptxNodeShape = (node, palette, nextId) => {
  const style = svgVariantStyle(node.variant, palette);
  const paint = { fill: dmlSolidFill(style.fill), line: dmlLine({ color: style.stroke, width: 1.5 }) };
  const { x, y, w, h } = node;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const base = { id: nextId(), name: `节点 ${node.id}`, x, y, w, h, ...paint };
  if (node.variant === 'decision') return [dmlPrstShape({ ...base, prst: 'diamond' })];
  if (node.variant === 'pill') return [dmlPrstShape({ ...base, prst: 'roundRect', adj: 50000 })];
  if (node.variant === 'database') {
    // 与 SVG 同序：先柱身，再下盖，最后上盖（后画的压住先画的）
    const capRy = Math.min(16, h * 0.16);
    return [
      dmlPrstShape({ ...base, prst: 'rect', y: y + capRy, h: h - capRy * 2 }),
      dmlPrstShape({ ...paint, id: nextId(), name: `节点 ${node.id} 下盖`, prst: 'ellipse', x, y: y + h - capRy * 2, w, h: capRy * 2 }),
      dmlPrstShape({ ...paint, id: nextId(), name: `节点 ${node.id} 上盖`, prst: 'ellipse', x, y, w, h: capRy * 2 }),
    ];
  }
  if (node.variant === 'circle') {
    const r = Math.min(w, h) / 2;
    return [dmlPrstShape({ ...base, prst: 'ellipse', x: cx - r, y: cy - r, w: r * 2, h: r * 2 })];
  }
  const rx = 12 * pptxGeo(palette);
  return [dmlPrstShape({ ...base, prst: 'roundRect', adj: dmlRoundAdj(rx, w, h) })];
};

const pptxNodeText = (node, palette, nextId) => {
  const style = svgVariantStyle(node.variant, palette);
  const fonts = pptxFonts(palette);
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
  if (iconTop) centerY += (svgMetric(palette, 'iconSizeTop') + svgMetric(palette, 'iconGapTop')) / 2 - 7;
  const sublabel = node.sublabel == null ? '' : String(node.sublabel);
  const label = node.label == null ? '' : String(node.label);
  const labelBase = Number.isFinite(node.labelPx) ? node.labelPx : svgMetric(palette, 'typeNode');
  const subBase = Number.isFinite(node.subPx) ? node.subPx : svgMetric(palette, 'typeSmall');
  const labelFont = svgFitFontSize(label, labelBase, availW, Math.min(15, labelBase));
  const subFont = sublabel ? svgFitFontSize(sublabel, subBase, availW, Math.min(15, subBase)) : 0;
  const labelLine = labelFont * 1.15;
  const subLine = subFont * 1.4;
  const gap = sublabel ? svgMetric(palette, 'labelSubGap') : 0;
  const blockTop = centerY - (labelLine + gap + subLine) / 2;
  const labelY = sublabel ? blockTop + labelLine / 2 : centerY;
  const align = iconLeft ? 'start' : 'middle';
  const textW = iconLeft
    ? Math.max(svgEstimateTextWidth(label, labelFont), sublabel ? svgEstimateTextWidth(sublabel, subFont) : 0)
    : 0;
  const textX = iconLeft
    ? node.x + (node.w - (iconLeftW + textW)) / 2 + iconLeftW
    : textCx;

  const boxW = (text, px) => Math.max(4, svgEstimateTextWidth(text, px) * 1.35 + px);
  const out = [dmlTextShape({
    id: nextId(), name: `文字 ${node.id}`, text: label, px: labelFont, bold: true,
    color: style.label, align, x: textX, cx: textX,
    cy: pptxCentral(palette, labelY, labelFont), lineH: labelLine,
    w: boxW(label, labelFont), ...fonts,
  })];
  if (sublabel) {
    const subY = blockTop + labelLine + gap + subLine / 2;
    out.push(dmlTextShape({
      id: nextId(), name: `副文字 ${node.id}`, text: sublabel, px: subFont, bold: false,
      color: palette.textSecondary, align, x: textX, cx: textX,
      cy: pptxCentral(palette, subY, subFont), lineH: subLine,
      w: boxW(sublabel, subFont), ...fonts,
    }));
  }
  return out;
};

const pptxContainerShapes = (container, palette, nextId) => {
  const geo = pptxGeo(palette);
  const r = 16 * geo;
  const fonts = pptxFonts(palette);
  const out = [dmlPrstShape({
    id: nextId(), name: `容器 ${container.id}`, prst: 'roundRect',
    adj: dmlRoundAdj(r, container.w, container.h),
    x: container.x, y: container.y, w: container.w, h: container.h,
    fill: dmlSolidFill(palette.containerFill),
    line: dmlLine({ color: palette.containerBorder, width: 1.5, dash: [6, 6] }),
  })];
  if (container.label == null || String(container.label) === '') return out;

  const mode = svgMetricRaw(palette, 'panelLabelMode');
  const padLeft = svgMetric(palette, 'panelPadLeft') || svgMetric(palette, 'panelPadX');
  const barH = svgMetric(palette, 'panelLabelH');
  const labelPadX = svgMetric(palette, 'panelLabelPadX');
  const colW = svgMetric(palette, 'panelLabelW');
  const base = Number.isFinite(container.labelPx) ? container.labelPx : 20;
  const paint = svgPanelLabelPaint(container, palette);
  paint.r = svgLenPx(paint.rawR) || r * 0.5;

  if (mode === 'bar-top') {
    const font = svgFitFontSize(container.label, base, container.w - labelPadX * 2, Math.min(15, base));
    if (paint.bg) {
      // 上圆下方的带子：与 SVG 同解法——圆角矩形 + 一块补下半截的直角矩形
      out.push(dmlPrstShape({
        id: nextId(), name: `编组标题带 ${container.id}`, prst: 'roundRect',
        adj: dmlRoundAdj(r, container.w, barH),
        x: container.x, y: container.y, w: container.w, h: barH,
        fill: dmlSolidFill(paint.bg), line: dmlLine({}),
      }));
      out.push(dmlPrstShape({
        id: nextId(), name: `编组标题带脚 ${container.id}`, prst: 'rect',
        x: container.x, y: container.y + barH / 2, w: container.w, h: barH / 2,
        fill: dmlSolidFill(paint.bg), line: dmlLine({}),
      }));
    }
    const centered = svgMetricRaw(palette, 'panelLabelAlign') === 'center';
    const tx = centered ? container.x + container.w / 2 : container.x + labelPadX;
    out.push(dmlTextShape({
      id: nextId(), name: `编组标题 ${container.id}`, text: container.label, px: font, bold: true,
      color: paint.ink, letterSpacing: 2,
      align: centered ? 'middle' : 'start', x: tx, cx: tx,
      cy: pptxCentral(palette, container.y + barH / 2, font), lineH: Math.max(barH, font * 1.2),
      w: Math.max(4, svgEstimateTextWidth(container.label, font) * 1.35 + font * 2), ...fonts,
    }));
    return out;
  }

  if (mode === 'side') {
    const inset = svgMetric(palette, 'panelLabelInset');
    const barX = container.x + inset;
    const barY = container.y + inset;
    const sideH = Math.max(0, container.h - inset * 2);
    const font = svgFitFontSize(container.label, base, sideH - labelPadX * 2, Math.min(15, base));
    if (paint.bg) {
      out.push(dmlPrstShape({
        id: nextId(), name: `编组竖条 ${container.id}`, prst: 'roundRect',
        adj: dmlRoundAdj(paint.r, colW, sideH),
        x: barX, y: barY, w: colW, h: sideH,
        fill: dmlSolidFill(paint.bg), line: dmlLine({}),
      }));
    }
    // 竖排逐字，与页面的 writing-mode:vertical-rl 同观感；整列在竖条里居中
    const chars = String(container.label).split('').filter((ch) => ch.trim() !== '');
    const cx = barX + colW / 2;
    const step = font * 1.15;
    const top = barY + sideH / 2 - ((chars.length - 1) * step) / 2;
    chars.forEach((ch, i) => {
      out.push(dmlTextShape({
        id: nextId(), name: `编组竖字 ${container.id}-${i}`, text: ch, px: font, bold: true,
        color: paint.ink, letterSpacing: 2, align: 'middle', cx,
        cy: pptxCentral(palette, top + i * step, font), lineH: step,
        w: Math.max(4, font * 2.2), ...fonts,
      }));
    });
    return out;
  }

  // chip
  const padTop = svgMetric(palette, 'panelPadTop');
  const font = svgFitFontSize(container.label, base,
    container.w - padLeft - svgMetric(palette, 'panelPadX') - labelPadX * 2, Math.min(15, base));
  const chipW = svgEstimateTextWidth(container.label, font) + labelPadX * 2;
  const chipY = container.y + (padTop - barH) / 2;
  if (paint.bg) {
    out.push(dmlPrstShape({
      id: nextId(), name: `编组标签 ${container.id}`, prst: 'roundRect',
      adj: dmlRoundAdj(paint.r, chipW, barH),
      x: container.x + padLeft, y: chipY, w: chipW, h: barH,
      fill: dmlSolidFill(paint.bg), line: dmlLine({}),
    }));
  }
  const tx = container.x + padLeft + labelPadX;
  out.push(dmlTextShape({
    id: nextId(), name: `编组标题 ${container.id}`, text: container.label, px: font, bold: true,
    color: paint.ink, letterSpacing: 2, align: 'start', x: tx, cx: tx,
    cy: pptxCentral(palette, chipY + barH / 2, font), lineH: Math.max(barH, font * 1.2),
    w: Math.max(4, chipW + font * 2), ...fonts,
  }));
  return out;
};

const pptxEdgeShapes = (edge, palette, nextId) => {
  const pts = edge.pts;
  if (!Array.isArray(pts) || pts.length < 2) return [];
  const style = edge.style === 'dashed' || edge.style === 'bold' ? edge.style : 'solid';
  const weight = svgEdgeWeight(palette);
  const baseW = weight.width;
  const strokeWidth = style === 'bold' ? baseW * 1.75 : baseW;
  const ink = svgEdgeInk(palette);
  const color = ink.alpha < 1 ? pptxAlphaColor(ink.solid, ink.alpha) : ink.solid;
  const geo = pptxGeo(palette);
  const dash = style === 'dashed' ? [baseW * 3.5, baseW * 3] : null;

  // 无向边（undirected）两头都不出端点：heads 留空，既不出「连线端点」形状，也不把箭头并进线体
  const undirected = !!edge.undirected;
  const backOnly = !undirected && !edge.bidirectional && edge.reversed;
  const heads = [];
  if (!undirected && (edge.bidirectional || backOnly)) {
    const ref = pptxDirRef(pts, false);
    if (ref) heads.push(pptxArrowOps(pts[0], ref, weight, strokeWidth));
  }
  if (!undirected && !backOnly) {
    const ref = pptxDirRef(pts, true);
    if (ref) heads.push(pptxArrowOps(pts[pts.length - 1], ref, weight, strokeWidth));
  }
  const arrows = heads.filter(Boolean);
  const body = pptxRoundedOps(pts, 8 * geo);
  const lineStyle = {
    color, width: strokeWidth, cap: 'round', join: 'round', dash,
  };

  // 端点笔画比线体粗：SVG 的 marker 用 headLeg = 线宽 × 1.12 描边。一个 DrawingML
  // 形状只能有一个线宽，想还原这 1.12 倍就得把端点单独出一个形状。
  //
  // 但拆开有代价：边色半透明时，端点压在线体上的那一段会二次合成而变深
  // （SVG 那边线与 marker 同属一个元素，opacity 是组不透明度，天然不叠）。
  // 所以只在**不透明**时拆——十四套皮肤里十二套的边色是不透明的；
  // 半透明的两套（midnight / terminal）宁可让端点细一成二，也不要一块深斑。
  // 虚线本来就必须拆（端点不能跟着虚），那就一并按 headLeg 描。
  const splitArrows = !!dash || ink.alpha >= 1;
  if (!splitArrows) {
    return [dmlCustomShape({
      id: nextId(), name: `连线 ${edge.id}`,
      subpaths: [body].concat(arrows),
      fill: dmlNoFill(), line: dmlLine(lineStyle),
    })];
  }
  const out = [dmlCustomShape({
    id: nextId(), name: `连线 ${edge.id}`, subpaths: [body],
    fill: dmlNoFill(), line: dmlLine(lineStyle),
  })];
  if (arrows.length) {
    out.push(dmlCustomShape({
      id: nextId(), name: `连线端点 ${edge.id}`, subpaths: arrows,
      fill: dmlNoFill(),
      line: dmlLine({
        color,
        width: weight.headLeg * (strokeWidth / weight.width),
        cap: 'round',
        join: 'round',
      }),
    }));
  }
  return out;
};

const pptxEdgeLabelShapes = (edge, palette, nextId) => {
  const label = edge.label;
  if (!Array.isArray(edge.pts) || edge.pts.length < 2) return [];
  if (!label || label.text == null || String(label.text) === '') return [];
  const base = Number.isFinite(label.px) ? label.px : 18;
  const font = svgFitFontSize(label.text, base, label.w - 16, Math.min(15, base));
  const fonts = pptxFonts(palette);
  return [
    dmlPrstShape({
      id: nextId(), name: `边标签底 ${edge.id}`, prst: 'roundRect', adj: 50000,
      x: label.x, y: label.y, w: label.w, h: label.h,
      fill: dmlSolidFill(palette.edgeLabelBg),
      line: dmlLine({ color: 'rgba(0,0,0,0.08)', width: 1 }),
    }),
    dmlTextShape({
      id: nextId(), name: `边标签 ${edge.id}`, text: label.text, px: font, bold: false,
      color: palette.edgeLabelText, align: 'middle',
      cx: label.x + label.w / 2,
      cy: pptxCentral(palette, label.y + label.h / 2, font),
      lineH: Math.max(label.h, font * 1.2),
      w: Math.max(4, label.w), ...fonts,
    }),
  ];
};

// 还原度台专用的四枚对位标记，产物导出永远不带（options.registration 默认 false）
const PPTX_MARKS = [{ x: 24, y: 24 }, { x: 1872, y: 24 }, { x: 24, y: 1032 }, { x: 1872, y: 1032 }];

/** Scene → 形状 XML 数组（按绘制顺序）。 */
export function sceneToPptxShapes(scene, theme, options) {
  if (!scene || typeof scene !== 'object') throw new Error('sceneToPptxShapes: scene 不能为空');
  const palette = { ...SCENE_THEME_DEFAULTS, ...(theme || {}) };
  const opts = options || {};
  const nextId = pptxIds();
  const fonts = pptxFonts(palette);
  // 竖直落点的偏移按西文字体定，解一次挂到调色板上，后面所有文本共用
  if (!Number.isFinite(palette.pptxCentralDrop)) palette.pptxCentralDrop = pptxCentralDropFor(fonts.latin);
  const nodes = Array.isArray(scene.nodes) ? scene.nodes : [];
  const containers = Array.isArray(scene.containers) ? scene.containers : [];
  const edges = Array.isArray(scene.edges) ? scene.edges : [];
  const out = [];

  // 1. 背景走 slide 的 bgPr，不占形状

  // 2. 标题 / 副标题（SVG 按字母基线定位，这里换成行盒中心）
  if (scene.title && scene.title.text) {
    // 标题：**一个**文本形状，行间 <a:br/>，行距用 lnSpc 精确写成 lineH（= px × 1.15），
    // 与 SVG 的 dy 同一个数。折行结论优先采信 scene.title.lines（构建期已算）。
    const fit = sceneTitleFit(scene.title);
    const font = fit.px;
    const rows = fit.lines.length;
    // 第一行的行盒中心按原口径（pptxFromBaseline，真 PowerPoint 上标出来的）不动；
    // 多行时盒子中心 = 第一行中心 + (行数-1) × lineH / 2，盒高取整块文字高。
    const firstCy = pptxFromBaseline(palette, scene.title.y + font * 0.9, font);
    const widest = fit.lines.reduce((acc, line) => Math.max(acc, svgEstimateTextWidth(line, font)), 0);
    out.push(dmlTextShape({
      id: nextId(), name: '标题', text: fit.lines.join('\n'), lines: fit.lines, px: font, bold: true,
      color: palette.text, align: 'start', x: scene.title.x,
      cy: firstCy + (rows - 1) * fit.lineH / 2,
      // 单行时行距 / 盒高沿用标过的 font×1.25（cy 也正好等于 firstCy）→ 与改动前逐字节一致；
      // 多行时行距换成 SVG 同款 lineH（px×1.15），盒高取整块文字高，居中之后第一行的行盒
      // 中心仍然落在 firstCy 上。
      lineH: rows > 1 ? fit.lineH : font * 1.25,
      boxH: rows > 1 ? rows * fit.lineH : font * 1.25,
      w: Math.max(4, widest * 1.35 + font), ...fonts,
    }));
  }
  if (scene.subtitle && scene.subtitle.text) {
    const font = svgFitFontSize(scene.subtitle.text, 28, scene.subtitle.w);
    out.push(dmlTextShape({
      id: nextId(), name: '副标题', text: scene.subtitle.text, px: font, bold: false,
      color: palette.textSecondary, align: 'start', x: scene.subtitle.x,
      cy: pptxFromBaseline(palette, scene.subtitle.y + font * 0.9, font),
      lineH: font * 1.25,
      w: Math.max(4, svgEstimateTextWidth(scene.subtitle.text, font) * 1.35 + font), ...fonts,
    }));
  }

  // 3. 容器（浅层在先）
  const sorted = containers.slice().sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0));
  for (const c of sorted) out.push(...pptxContainerShapes(c, palette, nextId));

  // 4. 节点卡片 → 5. 图标 → 6. 文字
  for (const n of nodes) out.push(...pptxNodeShape(n, palette, nextId));
  for (const n of nodes) out.push(...pptxIconShapes(n, palette, nextId));
  for (const n of nodes) out.push(...pptxNodeText(n, palette, nextId));

  // 7. 全部边线 → 8. 全部边标签
  for (const e of edges) out.push(...pptxEdgeShapes(e, palette, nextId));
  for (const e of edges) out.push(...pptxEdgeLabelShapes(e, palette, nextId));

  if (opts.registration) {
    for (const m of PPTX_MARKS) {
      out.push(dmlPrstShape({
        id: nextId(), name: '对位标记', prst: 'rect', x: m.x, y: m.y, w: 24, h: 24,
        fill: dmlSolidFill('#ff00ff'), line: dmlLine({}),
      }));
    }
  }

  // 最后一道闸：一个坐标写成 NaN，PowerPoint 会**放弃渲染它之后的所有形状**，
  // 整页只画一半而且不报任何错（当初图标解析器的 NaN 就是这么吃掉半张图的）。
  // 宁可少一个元素，也不能让整页塌掉；丢了几个由 onDrop 报出去。
  const clean = [];
  for (const shape of out) {
    if (shape && !/NaN|undefined|Infinity/.test(shape)) { clean.push(shape); continue; }
    if (typeof opts.onDrop === 'function') {
      opts.onDrop((shape.match(/name="([^"]*)"/) || [])[1] || '未知形状');
    }
  }
  return clean;
}

/** Scene → pptx-writer 认的 { slideXml }。 */
export function sceneToPptx(scene, theme, options) {
  const palette = { ...SCENE_THEME_DEFAULTS, ...(theme || {}) };
  return {
    slideXml: dmlSlideXml(sceneToPptxShapes(scene, theme, options), palette.background),
    background: palette.background,
  };
}
