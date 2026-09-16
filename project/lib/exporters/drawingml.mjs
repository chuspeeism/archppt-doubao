// drawingml.mjs [INLINE]
// PPTX 形状层的低阶写法：坐标换算、颜色、描边、预设几何、自由形、文本框。
// 只负责「把参数拼成合法的 DrawingML」，不认识 Scene，也不做任何排版决策。
//
// 单位口径（整张表的地基，别改）：
//   画布 1920×1080 设计像素 → 幻灯片 12192000×6858000 EMU，**1 像素 = 6350 EMU 整除**，
//   所以坐标不产生任何取整漂移；1 像素 = 0.5pt，字号 sz（1/100 pt）= 像素 × 50。
//
// 导出名：DML_* / dmlEsc / dmlColor / dmlSolidFill / dmlNoFill / dmlLine / dmlXfrm /
//         dmlPrstShape / dmlCustomShape / dmlTextShape / dmlGroup / dmlSlideXml

export const DML_EMU_PER_PX = 6350;
// 自由形包围盒的最小边长（设计像素）。见 dmlCustomShape 里的说明。
export const DML_MIN_GEOM_BOX = 12;
export const DML_SLIDE_W = 12192000;
export const DML_SLIDE_H = 6858000;
export const DML_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
  + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
  + ' xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

export const dmlEmu = (px) => Math.round(Number(px) * DML_EMU_PER_PX);
export const dmlSz = (px) => Math.max(100, Math.round(Number(px) * 50));

export const dmlEsc = (text) => String(text == null ? '' : text)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

const dmlHex2 = (v) => {
  const n = Math.max(0, Math.min(255, Math.round(v)));
  return (n < 16 ? '0' : '') + n.toString(16).toUpperCase();
};

const DML_NAMED = {
  black: '#000000', white: '#ffffff', none: null, transparent: null, currentcolor: null,
};

/** CSS 颜色 → { hex:'RRGGBB', alpha:0..1 }；none/transparent 返回 null。 */
export function dmlColor(css) {
  const raw = String(css == null ? '' : css).trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(DML_NAMED, lower)) {
    const hit = DML_NAMED[lower];
    return hit ? { hex: hit.slice(1).toUpperCase(), alpha: 1 } : null;
  }
  const rgba = raw.match(/^rgba?\(([^)]+)\)$/i);
  if (rgba) {
    const parts = rgba[1].split(/[,/]/).map((p) => p.trim()).filter((p) => p !== '');
    if (parts.length < 3) return null;
    const ch = (s) => (s.indexOf('%') >= 0 ? (parseFloat(s) / 100) * 255 : parseFloat(s));
    const a = parts.length >= 4 ? parseFloat(parts[3]) : 1;
    return {
      hex: dmlHex2(ch(parts[0])) + dmlHex2(ch(parts[1])) + dmlHex2(ch(parts[2])),
      alpha: Number.isFinite(a) ? Math.max(0, Math.min(1, a)) : 1,
    };
  }
  const hex = raw.match(/^#([0-9a-fA-F]{3,8})$/);
  if (!hex) return null;
  let h = hex[1];
  if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
  if (h.length === 6) return { hex: h.toUpperCase(), alpha: 1 };
  if (h.length === 8) return { hex: h.slice(0, 6).toUpperCase(), alpha: parseInt(h.slice(6, 8), 16) / 255 };
  return null;
}

const dmlClr = (c) => `<a:srgbClr val="${c.hex}">`
  + (c.alpha < 1 ? `<a:alpha val="${Math.round(c.alpha * 100000)}"/>` : '')
  + '</a:srgbClr>';

export function dmlSolidFill(css) {
  const c = dmlColor(css);
  return c ? `<a:solidFill>${dmlClr(c)}</a:solidFill>` : '<a:noFill/>';
}

export const dmlNoFill = () => '<a:noFill/>';

/**
 * 描边。dash 传 SVG 的 stroke-dasharray 数组（设计像素），会换算成 custDash
 * ——DrawingML 的 custDash 以「线宽的千分比」计量，能一比一还原 6 6 这种写法，
 * prstDash 的 dash(4,3) 会短一截。
 */
export function dmlLine(opts) {
  const o = opts || {};
  const c = dmlColor(o.color);
  if (!c || !(o.width > 0)) return '<a:ln><a:noFill/></a:ln>';
  const cap = o.cap === 'round' ? ' cap="rnd"' : o.cap === 'square' ? ' cap="sq"' : '';
  let dash = '';
  if (Array.isArray(o.dash) && o.dash.length >= 2 && o.dash[0] > 0) {
    const u = (v) => Math.max(1000, Math.round((v / o.width) * 100000));
    dash = `<a:custDash><a:ds d="${u(o.dash[0])}" sp="${u(o.dash[1])}"/></a:custDash>`;
  } else if (typeof o.dash === 'string') {
    dash = `<a:prstDash val="${o.dash}"/>`;
  }
  const join = o.join === 'bevel' ? '<a:bevel/>' : o.join === 'miter' ? '<a:miter lim="800000"/>' : '<a:round/>';
  const end = (tag, e) => (e
    ? `<a:${tag} type="${e.type || 'arrow'}" w="${e.w || 'med'}" len="${e.len || 'med'}"/>`
    : '');
  return `<a:ln w="${dmlEmu(o.width)}"${cap}>`
    + `<a:solidFill>${dmlClr(c)}</a:solidFill>`
    + dash + join + end('headEnd', o.headEnd) + end('tailEnd', o.tailEnd)
    + '</a:ln>';
}

export const dmlXfrm = (x, y, w, h, rotDeg) => {
  const rot = Number.isFinite(rotDeg) && rotDeg ? ` rot="${Math.round(rotDeg * 60000)}"` : '';
  return `<a:xfrm${rot}><a:off x="${dmlEmu(x)}" y="${dmlEmu(y)}"/>`
    + `<a:ext cx="${dmlEmu(Math.max(0, w))}" cy="${dmlEmu(Math.max(0, h))}"/></a:xfrm>`;
};

const dmlNvSp = (id, name, txBox) =>
  `<p:nvSpPr><p:cNvPr id="${id}" name="${dmlEsc(name)}"/>`
  + `<p:cNvSpPr${txBox ? ' txBox="1"' : ''}/><p:nvPr/></p:nvSpPr>`;

const DML_EMPTY_TX = '<p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody>';

/** 预设几何形状（矩形 / 圆角矩形 / 椭圆 / 菱形…）。adj 是 roundRect 的圆角比例。 */
export function dmlPrstShape(o) {
  const adj = Number.isFinite(o.adj)
    ? `<a:avLst><a:gd name="adj" fmla="val ${Math.round(o.adj)}"/></a:avLst>`
    : '<a:avLst/>';
  return `<p:sp>${dmlNvSp(o.id, o.name || 'shape')}`
    + `<p:spPr>${dmlXfrm(o.x, o.y, o.w, o.h, o.rot)}`
    + `<a:prstGeom prst="${o.prst}">${adj}</a:prstGeom>`
    + (o.fill || dmlNoFill())
    + (o.line || '')
    + '</p:spPr>'
    + DML_EMPTY_TX
    + '</p:sp>';
}

/** 圆角矩形的 adj：DrawingML 里是「圆角半径 ÷ 短边」的十万分比。 */
export const dmlRoundAdj = (r, w, h) => {
  const m = Math.min(w, h);
  if (!(m > 0)) return 0;
  return Math.max(0, Math.min(50000, Math.round((r / m) * 100000)));
};

/**
 * 自由形。subpaths 来自 svg-path.mjs，坐标是画布绝对值；这里平移到形状包围盒内。
 * box 可显式给（例如描边要留出线宽余量），不给就按顶点算。
 */
export function dmlCustomShape(o) {
  const subs = o.subpaths || [];
  let x0 = o.box ? o.box.x : Infinity;
  let y0 = o.box ? o.box.y : Infinity;
  let x1 = o.box ? o.box.x + o.box.w : -Infinity;
  let y1 = o.box ? o.box.y + o.box.h : -Infinity;
  if (!o.box) {
    for (const s of subs) {
      for (const op of s.ops) {
        for (let i = 0; i + 1 < op.p.length; i += 2) {
          if (op.p[i] < x0) x0 = op.p[i];
          if (op.p[i] > x1) x1 = op.p[i];
          if (op.p[i + 1] < y0) y0 = op.p[i + 1];
          if (op.p[i + 1] > y1) y1 = op.p[i + 1];
        }
      }
    }
  }
  if (!Number.isFinite(x0)) return '';
  // 包围盒必须撑够宽：
  //   1. 水平/垂直直线有一边是 0，EMU 取整后 ext 变成 0，形状直接不画；
  //   2. 更阴的一条 —— 盒子窄到几个像素时，渲染器把 path 空间映射到 ext 会算歪。
  //      实测（scripts 里的隔离用例）：盒宽 1px 的竖线整体左移 2.7px，2px 移 1.1px，
  //      ≥8px 之后误差回到 0.1px 以内。所以一律把盒子对称撑到至少 DML_MIN_GEOM_BOX。
  //      顶点是相对 x0/y0 算的，撑完线还落在原位，只是选中框大一圈。
  const minBox = Number.isFinite(o.minBox) ? o.minBox : DML_MIN_GEOM_BOX;
  if (x1 - x0 < minBox) { const d0 = (minBox - (x1 - x0)) / 2; x0 -= d0; x1 += d0; }
  if (y1 - y0 < minBox) { const d0 = (minBox - (y1 - y0)) / 2; y0 -= d0; y1 += d0; }
  const w = x1 - x0;
  const h = y1 - y0;
  const P = (x, y) => `<a:pt x="${dmlEmu(x - x0)}" y="${dmlEmu(y - y0)}"/>`;
  let d = '';
  for (const s of subs) {
    for (const op of s.ops) {
      if (op.t === 'M') d += `<a:moveTo>${P(op.p[0], op.p[1])}</a:moveTo>`;
      else if (op.t === 'L') d += `<a:lnTo>${P(op.p[0], op.p[1])}</a:lnTo>`;
      else if (op.t === 'Q') d += `<a:quadBezTo>${P(op.p[0], op.p[1])}${P(op.p[2], op.p[3])}</a:quadBezTo>`;
      else if (op.t === 'C') d += `<a:cubicBezTo>${P(op.p[0], op.p[1])}${P(op.p[2], op.p[3])}${P(op.p[4], op.p[5])}</a:cubicBezTo>`;
    }
    if (s.closed) d += '<a:close/>';
  }
  // fill="norm" 走非零环绕；图标里的挖空（如 docker 的方块）靠子路径反向绕行实现，
  // 数据源本身就是这么画的，照抄即可。
  return `<p:sp>${dmlNvSp(o.id, o.name || 'path')}`
    + `<p:spPr>${dmlXfrm(x0, y0, w, h)}`
    + '<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/>'
    + '<a:rect l="0" t="0" r="r" b="b"/>'
    + `<a:pathLst><a:path w="${dmlEmu(w)}" h="${dmlEmu(h)}"${o.fillMode ? ` fill="${o.fillMode}"` : ''}>${d}</a:path></a:pathLst>`
    + '</a:custGeom>'
    + (o.fill || dmlNoFill())
    + (o.line || '')
    + '</p:spPr>'
    + DML_EMPTY_TX
    + '</p:sp>';
}

/**
 * 文本框（单行，或用 `lines` 传多行）。锚点口径与 SVG 的 text 对齐：
 *   align 'middle' → 盒子在 cx 居中、段落居中；'start' → 盒子左缘落在 x、段落左对齐。
 * 竖直方向一律「盒子中心对齐到 cy + nudge」，盒高默认取 lineH，anchor=ctr。
 *
 * 多行（`lines` 给两行以上）：仍是**一个**形状、一个段落，行间插 `<a:br/>`；
 * `lnSpc` 写的是 `lineH`（精确行距），盒高用 `boxH` 另给。
 * 调用方要保证「盒子中心 = 整块文字的中心」，这样第一行的落点与单行时**完全一致**
 * ——单行的竖直落点是在真 PowerPoint 上标过的（pptxFromBaseline），不能因为支持多行就动它。
 */
export function dmlTextShape(o) {
  const px = Number(o.px) || 16;
  const lineH = Number.isFinite(o.lineH) ? o.lineH : px * 1.2;
  const lines = Array.isArray(o.lines) && o.lines.length ? o.lines.map((l) => String(l ?? '')) : [String(o.text ?? '')];
  const boxH = Number.isFinite(o.boxH) && o.boxH > 0 ? Number(o.boxH) : lineH;
  const w = Number.isFinite(o.w) && o.w > 0 ? o.w : Math.max(8, px * String(o.text || '').length * 1.2);
  const cy = Number(o.cy) + (Number(o.nudge) || 0);
  const x = o.align === 'start' ? Number(o.x) : Number(o.cx) - w / 2;
  const algn = o.align === 'start' ? 'l' : o.align === 'end' ? 'r' : 'ctr';
  const spc = Number.isFinite(o.letterSpacing) && o.letterSpacing
    ? ` spc="${Math.round(o.letterSpacing * 50)}"` : '';
  const fill = dmlSolidFill(o.color);
  const font = `<a:latin typeface="${dmlEsc(o.latin || 'Helvetica Neue')}"/>`
    + `<a:ea typeface="${dmlEsc(o.ea || 'PingFang SC')}"/>`
    + `<a:cs typeface="${dmlEsc(o.ea || 'PingFang SC')}"/>`;
  // 换行符自己也带一份 rPr：裸 <a:br/> 会继承默认字号，行高就跟着变了
  const rPr = `<a:rPr lang="zh-CN" altLang="en-US" sz="${dmlSz(px)}" b="${o.bold ? 1 : 0}"${spc} dirty="0">${fill}${font}</a:rPr>`;
  const body = lines
    .map((line) => `<a:r>${rPr}<a:t>${dmlEsc(line)}</a:t></a:r>`)
    .join(`<a:br>${rPr}</a:br>`);
  return `<p:sp>${dmlNvSp(o.id, o.name || 'text', true)}`
    + `<p:spPr>${dmlXfrm(x, cy - boxH / 2, w, boxH)}`
    + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>'
    + '<p:txBody>'
    + '<a:bodyPr wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" rtlCol="0" anchor="ctr" anchorCtr="0">'
    + '<a:noAutofit/></a:bodyPr><a:lstStyle/>'
    + `<a:p><a:pPr algn="${algn}" marL="0" marR="0" indent="0">`
    + `<a:lnSpc><a:spcPts val="${dmlSz(lineH)}"/></a:lnSpc>`
    + '<a:spcBef><a:spcPts val="0"/></a:spcBef><a:spcAft><a:spcPts val="0"/></a:spcAft></a:pPr>'
    + body
    + `<a:endParaRPr lang="zh-CN" sz="${dmlSz(px)}"/>`
    + '</a:p></p:txBody></p:sp>';
}

/** 把一串形状打包成组：整组可以在 PowerPoint 里一起选中、一起移动。 */
export function dmlGroup(o) {
  const b = o.box;
  return `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${o.id}" name="${dmlEsc(o.name || 'group')}"/>`
    + '<p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
    + `<p:grpSpPr><a:xfrm><a:off x="${dmlEmu(b.x)}" y="${dmlEmu(b.y)}"/>`
    + `<a:ext cx="${dmlEmu(b.w)}" cy="${dmlEmu(b.h)}"/>`
    + `<a:chOff x="${dmlEmu(b.x)}" y="${dmlEmu(b.y)}"/>`
    + `<a:chExt cx="${dmlEmu(b.w)}" cy="${dmlEmu(b.h)}"/></a:xfrm></p:grpSpPr>`
    + o.children.join('')
    + '</p:grpSp>';
}

/** 整页 slide XML。 */
export function dmlSlideXml(shapes, bgCss) {
  const bg = dmlColor(bgCss);
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + `<p:sld ${DML_NS}><p:cSld>`
    + (bg ? `<p:bg><p:bgPr><a:solidFill>${dmlClr(bg)}</a:solidFill><a:effectLst/></p:bgPr></p:bg>` : '')
    + '<p:spTree>'
    + '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
    + '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>'
    + '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
    + shapes.join('')
    + '</p:spTree></p:cSld>'
    + '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>\n';
}
