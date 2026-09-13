// 节点内容阶梯自适应求解器 [INLINE 预备]
//
// 解决的问题: 原 fitFontSize() 用二分法把字号连续压到 0.1px 精度(无级缩放),
// 结果是节点越小字越小、字号任意取值、间距比例失衡, 没有"档位"可言。
//
// 本模块换成网页式的响应式行为 —— 一个节点只有一个自由变量: 字号档位 k;
// 其余尺寸(内边距/行间距/图标)都是 k 的函数, 在 [紧凑, 舒适] 弹性区间内按剩余空间松弛:
//
//   缩小 → 字号不动, 弹性间距从"舒适"被压向"紧凑"(t: 1 → 0)
//   压到 t=0 仍放不下 → 字号跃迁到下一档(×1/ratio), 空间被释放
//   → 新档位下间距重新松弛回接近舒适(t 回到较高值) → 重复
//
// 纯函数, 不访问 DOM。文本换行由调用方注入的 measure 回调负责:
//   measure(text, fontPx, availW, role) -> { lines, width }   width = 最长一行的像素宽
//   role 为 'label' | 'sub', 供调用方按角色切换字重(主副标题字重不同, 同字号下宽度不同)
// 浏览器侧用 Range.getClientRects() 实测, Node 侧用估算器, 两边共用同一套求解逻辑。

export const NODE_FIT_DEFAULTS = Object.freeze({
  ratio: 1.125,        // 相邻档位的字号比(1.125 = 大二度; 越大跃迁感越强)
  minFontPx: 10,       // 字号下限, 到此不再降档, 改为截断
  maxTiers: 14,        // 向下最多生成多少档
  upSteps: 0,          // 允许比基准字号大几档(默认 0: 只缩不放, 与现有行为一致)
  hysteresisPx: 6,     // 滞回: 想升回大一档, 需要比降档点再宽/高这么多, 防止边界抖动
  padXTight: 0.45,     // 水平内边距的紧凑系数(相对同档舒适值)
  padYTight: 0.35,     // 垂直内边距的紧凑系数
  gapTight: 0.4,       // 标题/副标题间距的紧凑系数
  minPadXPx: 6,        // 内边距绝对地板, 再挤也不越过
  minPadYPx: 4,
  minIconPx: 12,       // 图标绝对地板
  maxLabelLines: 3,    // 主标题最多折几行, 超了就降档(字小→行少)
  maxSubLines: 2,
  lineH: 1.15,         // 与 skins.mjs 的 LINE_H 同口径
  fitEpsilonPx: 1,     // 松弛时预留的安全余量: 分配到最后一丝像素会让浏览器凭空多折一行
});

function nfSnap(v) { return Math.round(v * 2) / 2; }              // 字号吸附到 0.5px, 保证渲染清晰
function nfRound(v) { return Math.round(v * 10) / 10; }
function nfClamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

// 形状修正: 菱形/圆的可用矩形小于外接矩形(与 skins.mjs skinTextBox 同口径), 不含内边距
function nfShapeBox(w, h, variant) {
  if (variant === 'decision') return { w: w * 0.6 - 8, h: h * 0.4 - 6 };
  if (variant === 'circle') return { w: w * 0.75, h: h * 0.66 - 6 };
  return { w: w, h: h };
}

// 基准字号 → 档位阶梯(从大到小)
export function buildTypeLadder(basePx, opts) {
  const o = Object.assign({}, NODE_FIT_DEFAULTS, opts || {});
  const base = nfSnap(Math.max(o.minFontPx, basePx));
  const out = [];
  for (let i = o.upSteps; i >= 1; i--) out.push(nfSnap(base * Math.pow(o.ratio, i)));
  out.push(base);
  let f = base;
  while (out.length < o.maxTiers + o.upSteps) {
    f = f / o.ratio;
    const s = nfSnap(f);
    if (s < o.minFontPx || s >= out[out.length - 1]) break;
    out.push(s);
  }
  if (out[out.length - 1] > o.minFontPx) out.push(nfSnap(o.minFontPx));
  return out;
}

// 结构 token(px) → em 比例。字号一变, 所有间距/图标按同一比例跟着变,
// 这样降档之后节点看上去仍是"同一个设计", 而不是小字配大边距。
export function nodeFitStyle(metrics, opts) {
  const o = opts || {};
  const baseFont = metrics.typeNode;
  const padY = Math.max(4, (metrics.cardMinH - metrics.typeNode * NODE_FIT_DEFAULTS.lineH) / 2);
  return {
    basePx: baseFont,
    subRatio: metrics.typeSmall / baseFont,
    padXEm: metrics.cardPadX / baseFont,
    padYEm: padY / baseFont,
    gapEm: metrics.labelSubGap / baseFont,
    iconEm: metrics.iconSize / baseFont,
    iconGapEm: metrics.iconGapX / baseFont,
    iconTopEm: metrics.iconSizeTop / baseFont,
    // 顶置图标与文字的实际间距取 max(iconGapTop, labelSubGap): 渲染侧图标下方是
    // 容器行距(labelSubGap)再补足到 iconGapTop, 补足量不允许为负
    iconGapTopEm: Math.max(metrics.iconGapTop, metrics.labelSubGap) / baseFont,
    variant: o.variant || 'default',
    icon: o.icon || null,               // 'left' | 'top' | null
    // 卡片单边边框宽度。border-box 下边框吃掉的是内容宽高, 不算进来就会比实际多出 2×borderPx
    // 的可用空间, 表现为"求解说放得下、浏览器里多折一行"。
    borderPx: o.borderPx || 0,
  };
}

// 某一档字号下的全部尺寸槽位: c = 舒适值, m = 紧凑值(可被挤到的极限)
function nfSlots(fontPx, style, o) {
  const padXc = Math.max(o.minPadXPx, fontPx * style.padXEm);
  const padYc = Math.max(o.minPadYPx, fontPx * style.padYEm);
  const gapc = fontPx * style.gapEm;
  const iconGapXc = fontPx * style.iconGapEm;
  const iconGapTopC = fontPx * style.iconGapTopEm;
  return {
    padXc: padXc, padXm: Math.max(o.minPadXPx, padXc * o.padXTight),
    padYc: padYc, padYm: Math.max(o.minPadYPx, padYc * o.padYTight),
    gapc: gapc, gapm: gapc * o.gapTight,
    iconGapXc: iconGapXc, iconGapXm: iconGapXc * o.gapTight,
    iconGapTopC: iconGapTopC, iconGapTopM: iconGapTopC * o.gapTight,
    iconW: Math.max(o.minIconPx, fontPx * style.iconEm),
    iconH: Math.max(o.minIconPx, fontPx * style.iconTopEm),
  };
}

// 试一档: 放得下就返回完整解(含松弛后的间距), 放不下返回 null
function nfTryTier(fontPx, tier, bw, bh, content, style, measure, o) {
  const s = nfSlots(fontPx, style, o);
  const subPx = content.sublabel ? nfRound(fontPx * style.subRatio) : 0;
  const hasLeftIcon = style.icon === 'left';
  const hasTopIcon = style.icon === 'top';

  const iconColW = hasLeftIcon ? s.iconW + s.iconGapXm : 0;
  const availW = bw - s.padXm * 2 - iconColW;
  if (availW < fontPx * 0.9) return null;                 // 一个汉字都塞不进, 直接降档

  const lab = measure(content.label || '', fontPx, availW, 'label');
  if (lab.lines > o.maxLabelLines) return null;           // 折行太多 → 降档(字更小 → 行更少)
  let sub = null;
  if (subPx) {
    sub = measure(content.sublabel, subPx, availW, 'sub');
    if (sub.lines > o.maxSubLines) return null;
  }

  const labH = lab.lines * fontPx * o.lineH;
  const subH = sub ? sub.lines * subPx * o.lineH : 0;
  const iconRowH = hasTopIcon ? s.iconH + s.iconGapTopM : 0;
  const needH = labH + (sub ? s.gapm + subH : 0) + iconRowH;
  const innerH = bh - s.padYm * 2;
  if (needH > innerH) return null;

  // —— 松弛: 把剩余空间按各槽位的弹性额度等比分配回去, 上限为舒适值 ——
  // 余量一律留 fitEpsilonPx 不分配, 且各槽位向下取整: 分配到最后一丝像素会让渲染宽度
  // 比测量宽度小零点几个像素, 文字就凭空多折一行(实测过的真实故障)。
  const textW = Math.max(lab.width, sub ? sub.width : 0);
  const slackX = Math.max(0, availW - textW - o.fitEpsilonPx);
  const elasticX = (s.padXc - s.padXm) * 2 + (hasLeftIcon ? s.iconGapXc - s.iconGapXm : 0);
  const tX = elasticX > 0.01 ? nfClamp(slackX / elasticX, 0, 1) : 1;

  const slackY = Math.max(0, innerH - needH - o.fitEpsilonPx);
  const elasticY = (s.padYc - s.padYm) * 2
    + (sub ? s.gapc - s.gapm : 0)
    + (hasTopIcon ? s.iconGapTopC - s.iconGapTopM : 0);
  const tY = elasticY > 0.01 ? nfClamp(slackY / elasticY, 0, 1) : 1;

  const mix = function (m, c, t) { return Math.floor((m + (c - m) * t) * 10) / 10; };
  return {
    tier: tier,
    fontPx: fontPx,
    subPx: subPx,
    padX: mix(s.padXm, s.padXc, tX),
    padY: mix(s.padYm, s.padYc, tY),
    gap: sub ? mix(s.gapm, s.gapc, tY) : 0,
    iconSize: hasLeftIcon || hasTopIcon ? nfRound(hasTopIcon ? s.iconH : s.iconW) : 0,
    iconGap: hasLeftIcon ? mix(s.iconGapXm, s.iconGapXc, tX)
      : (hasTopIcon ? mix(s.iconGapTopM, s.iconGapTopC, tY) : 0),
    lines: lab.lines,
    subLines: sub ? sub.lines : 0,
    textW: nfRound(textW),
    contentH: nfRound(needH),
    easeX: Math.round(tX * 100) / 100,   // 0 = 间距已被挤到极限(再小就降档), 1 = 完全舒适
    easeY: Math.round(tY * 100) / 100,
    clampLabel: 0,
    clampSub: 0,
    dropSub: false,
    overflow: false,
  };
}

// 连最小档都放不下: 停在最小档 + 紧凑间距, 用行截断兜底, 并标记 overflow 交给质检
function nfFallback(fontPx, tier, bw, bh, content, style, measure, o) {
  const s = nfSlots(fontPx, style, o);
  const hasLeftIcon = style.icon === 'left';
  const hasTopIcon = style.icon === 'top';
  const availW = Math.max(8, bw - s.padXm * 2 - (hasLeftIcon ? s.iconW + s.iconGapXm : 0));
  const lineH = fontPx * o.lineH;
  const innerH = Math.max(lineH, bh - s.padYm * 2 - (hasTopIcon ? s.iconH + s.iconGapTopM : 0));
  const capacity = Math.max(1, Math.floor(innerH / lineH));

  const lab = measure(content.label || '', fontPx, availW, 'label');
  const subPx = content.sublabel ? nfRound(fontPx * style.subRatio) : 0;
  // 空间不够时先牺牲副标题, 主标题永远保留至少一行
  let clampLabel = Math.min(lab.lines, capacity);
  let clampSub = 0;
  let dropSub = true;
  if (subPx && capacity >= 2) {
    clampLabel = Math.min(lab.lines, capacity - 1);
    clampSub = Math.min(measure(content.sublabel, subPx, availW, 'sub').lines, capacity - clampLabel);
    dropSub = clampSub < 1;
  }
  return {
    tier: tier,
    fontPx: fontPx,
    subPx: dropSub ? 0 : subPx,
    padX: nfRound(s.padXm), padY: nfRound(s.padYm), gap: dropSub ? 0 : nfRound(s.gapm),
    iconSize: hasLeftIcon || hasTopIcon ? nfRound(hasTopIcon ? s.iconH : s.iconW) : 0,
    iconGap: hasLeftIcon ? nfRound(s.iconGapXm) : (hasTopIcon ? nfRound(s.iconGapTopM) : 0),
    lines: clampLabel, subLines: clampSub,
    textW: nfRound(lab.width), contentH: nfRound((clampLabel + clampSub) * lineH),
    easeX: 0, easeY: 0,
    clampLabel: clampLabel < lab.lines ? clampLabel : 0,
    clampSub: clampSub,
    dropSub: dropSub && !!subPx,
    overflow: true,
  };
}

// 主入口。box = {w,h} 卡片外框像素; content = {label, sublabel};
// opts.prevTier  上一帧的档位, 传了才启用滞回(拖动时不来回跳)。
// opts.startTier 起始档位, 即"整图统一的档位"。从它开始往下找, 不会高于它 ——
//   同一张图里的节点必须共用字号, 个别放不下的节点才单独再降档。
//   不传则从最大档找起(单个节点独立求解, 实验台就是这么用的)。
export function solveNodeFit(box, content, style, measure, opts) {
  const o = Object.assign({}, NODE_FIT_DEFAULTS, opts || {});
  const ladder = style.ladder || buildTypeLadder(style.basePx, o);
  const prev = typeof o.prevTier === 'number' ? o.prevTier : null;
  const from = Math.max(0, Math.min(ladder.length - 1,
    typeof o.startTier === 'number' ? o.startTier : 0));
  const bd = (style.borderPx || 0) * 2;
  const shape = nfShapeBox(box.w - bd, box.h - bd, style.variant);
  for (let k = from; k < ladder.length; k++) {
    // 升档(k 比上一帧更小 = 字更大)要多留 hysteresisPx, 降档立刻生效 —— 只在回拖时产生迟滞
    const grow = prev !== null && k < prev ? o.hysteresisPx : 0;
    const hit = nfTryTier(ladder[k], k, shape.w - grow, shape.h - grow,
      content, style, measure, o);
    if (hit) { hit.ladder = ladder; return hit; }
  }
  const last = ladder.length - 1;
  const out = nfFallback(ladder[last], last, shape.w, shape.h, content, style, measure, o);
  out.ladder = ladder;
  return out;
}

// Node 侧/构建期用的估算测量器(CJK 记 1em, ASCII 记 0.52em, 贪心折行),
// 与 generate.mjs estTextWidth / quality-checker 同口径。浏览器侧应换成 DOM 实测。
export function makeEstimateMeasurer() {
  const unit = function (ch) { return ch.charCodeAt(0) > 0xff ? 1 : 0.52; };
  return function (text, fontPx, availW) {
    const s = String(text == null ? '' : text);
    if (!s) return { lines: 0, width: 0 };
    // 折行点: 空格处优先(keep-all 下中文之间也可断)
    let lines = 1, cur = 0, max = 0, wordW = 0, wordStart = true;
    for (let i = 0; i < s.length; i++) {
      const w = unit(s[i]) * fontPx;
      const breakable = s[i] === ' ' || s.charCodeAt(i) > 0xff;
      if (cur + w > availW && !wordStart) {
        if (breakable || wordW === 0) { max = Math.max(max, cur); lines++; cur = w; wordW = w; }
        else { max = Math.max(max, cur - wordW); lines++; cur = wordW + w; wordW += w; }
      } else { cur += w; wordW = breakable ? 0 : wordW + w; }
      wordStart = false;
    }
    return { lines: lines, width: Math.min(availW, Math.max(max, cur)) };
  };
}
