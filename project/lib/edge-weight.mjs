// 连线视觉权重求解器：由「整图几何系数」得出线宽与箭头端点几何。
//
// 整图几何系数 S = 生成期装框系数(FIT_SCALE) × 运行期外框缩放系数(typeScale)。
// 在此之前只有后者进了 CSS(--type-scale)，生成期把内容缩到 0.66 的图，线宽和箭头
// 仍按 1.0 画，于是节点缩小而连线不缩，观感失衡。这里把两级系数合并成一个 S。
//
// 三条约束决定了算法形状：
//   1. 线宽不能等比缩到亚像素。页面上还有一层舞台缩放(1920 设计像素 → 视口宽度,
//      通常约 0.67)，S=0.3 时等比线宽只剩 0.6 设计像素、约 0.4 设备像素，抗锯齿后
//      是一条灰雾。故线宽用压缩指数 γ 跟随 S，并设绝对下限。
//   2. 箭头端点要等比跟随 S，不能跟随线宽。线宽被 γ 压缩后缩得比几何慢，端点若挂在
//      线宽上就会在小图里显得过大——这正是要修的现象。
//   3. 端点仍要和线宽保持可读比例。线宽触底后端点若还按 S 缩，会退化成一个墨点，
//      故端点长度另设「不短于线宽 N 倍、不长于线宽 M 倍」的双向护栏。
//
// marker 单位保持 SVG 默认的 markerUnits="strokeWidth"：端点几何以线宽为单位写入，
// 于是 .edge.bold(1.6 倍线宽) 自动得到 1.6 倍的端点，不需要第二套 marker。

export const EDGE_WEIGHT_DEFAULTS = Object.freeze({
  gamma: 0.75,        // 线宽跟随 S 的压缩指数，1 为等比
  minWidthPx: 1,      // 线宽下限（设计像素）
  maxWidthRatio: 2.5, // 线宽上限 = 皮肤基准线宽 × 该值
  // 端点比例对齐设计稿（Arch Skin Stratum.dc.html 的 marker：viewBox 10×10、
  // markerWidth 7、path "M1 1 L9 5 L1 9"、stroke-width 取皮肤基准线宽）——
  // 换算成"线宽的倍数"就是长 5.6、半高 2.8、笔画 1.12。原来的 7 / 3.5 / 1.6
  // 比设计稿长四分之一、粗四成，密图上端点会盖住相邻的卡片描边。
  headUnits: 5.6,     // S=1 时端点长度 = 皮肤基准线宽 × 该值
  headAspect: 0.5,    // 端点半高 / 端点长度
  headLegRatio: 1.12, // 端点笔画粗细 / 线宽
  headMinRatio: 2.8,  // 端点长度下限 = 线宽 × 该值
  headMaxRatio: 6.4,  // 端点长度上限 = 线宽 × 该值
});

const round = (v, digits) => {
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
};

const clamp = (lo, v, hi) => (v < lo ? lo : v > hi ? hi : v);

const finitePositive = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * @param {number} baseWidth 皮肤基准线宽（设计像素，S=1 时的线宽）
 * @param {number} scale     整图几何系数 S
 * @param {object} [options] 覆盖 EDGE_WEIGHT_DEFAULTS 的部分参数
 * @returns {{width:number, headLen:number, headHalf:number, headLeg:number, scale:number}}
 */
export function edgeWeight(baseWidth, scale, options) {
  const o = { ...EDGE_WEIGHT_DEFAULTS, ...(options || {}) };
  const base = finitePositive(baseWidth, 2);
  const s = finitePositive(scale, 1);

  const width = clamp(o.minWidthPx, base * Math.pow(s, o.gamma), base * o.maxWidthRatio);
  const headLen = clamp(width * o.headMinRatio, base * o.headUnits * s, width * o.headMaxRatio);

  return {
    scale: s,
    width: round(width, 2),
    headLen: round(headLen, 2),
    headHalf: round(headLen * o.headAspect, 2),
    headLeg: round(width * o.headLegRatio, 2),
  };
}

/**
 * 把 edgeWeight() 的像素几何换算成 markerUnits="strokeWidth" 下的 marker 属性。
 * 单位是「线宽的倍数」，因此 marker 会随引用它的那条线的线宽一起变（粗边线自动得到大端点）。
 * @param {{width:number, headLen:number, headHalf:number, headLeg:number}} weight
 * @returns {{markerWidth:number, markerHeight:number, strokeWidth:number,
 *            refX:number, refY:number, refXRev:number, d:string, dRev:string}}
 */
export function arrowMarkerGeometry(weight) {
  const w = finitePositive(weight && weight.width, 2);
  const lenU = finitePositive(weight && weight.headLen, w * 7) / w;
  const halfU = finitePositive(weight && weight.headHalf, w * 3.5) / w;
  const legU = finitePositive(weight && weight.headLeg, w * 1.6) / w;
  // 留半个笔画的余量，否则圆角端点会被 marker 视口裁掉（旧版 markerHeight=8 就裁掉了约 0.3 单位）
  const pad = legU / 2;
  const n = (v) => round(v, 3);

  const tipX = pad + lenU;
  const midY = pad + halfU;
  const botY = pad + halfU * 2;

  return {
    markerWidth: n(lenU + legU),
    markerHeight: n(halfU * 2 + legU),
    strokeWidth: n(legU),
    refX: n(tipX),
    refY: n(midY),
    refXRev: n(pad),
    d: `M${n(pad)} ${n(pad)} L${n(tipX)} ${n(midY)} L${n(pad)} ${n(botY)}`,
    dRev: `M${n(tipX)} ${n(pad)} L${n(pad)} ${n(midY)} L${n(tipX)} ${n(botY)}`,
  };
}

// —— 颜色拆分：把带 alpha 的边色拆成「不透明色 + alpha」——
// 线和箭头端点若都用带 alpha 的颜色描边，端点压在线上的那一段会二次合成而变深。
// 拆开后两者都用不透明色画，alpha 交给元素级 opacity（SVG 的 opacity 是组不透明度，
// 元素连同它的 marker 先合成到离屏缓冲、再整体上 alpha），重叠处不再叠加。
const HEX_RE = /^#([0-9a-f]{3,8})$/i;

export function splitColorAlpha(color) {
  const raw = String(color == null ? '' : color).trim();
  if (!raw) return { solid: '#000000', alpha: 1 };

  const rgba = raw.match(/^rgba?\(([^)]+)\)$/i);
  if (rgba) {
    const parts = rgba[1].split(/[,/]/).map((p) => p.trim()).filter((p) => p !== '');
    if (parts.length >= 3) {
      const alpha = parts.length >= 4 ? parseFloat(parts[3]) : 1;
      return {
        solid: `rgb(${parts[0]}, ${parts[1]}, ${parts[2]})`,
        alpha: Number.isFinite(alpha) ? clamp(0, alpha, 1) : 1,
      };
    }
    return { solid: raw, alpha: 1 };
  }

  const hex = raw.match(HEX_RE);
  if (hex) {
    const h = hex[1];
    if (h.length === 4) {
      return { solid: `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`, alpha: round(parseInt(h[3] + h[3], 16) / 255, 3) };
    }
    if (h.length === 8) {
      return { solid: `#${h.slice(0, 6)}`, alpha: round(parseInt(h.slice(6, 8), 16) / 255, 3) };
    }
    return { solid: raw, alpha: 1 };
  }

  return { solid: raw, alpha: 1 };
}
