// project/lib/text-metrics.mjs —— 全引擎唯一的文字估宽尺子 [INLINE]
//
// 方案 C（docs/text-width-calibration-plan.md）第 4.4 节的落地：估算逻辑只在这一处，
// quality-checker / node-fit / arch-doc / generate.mjs 运行时 / 工作台全部转调这里。
// 数据来自真浏览器标定（labs/text-width-calibration.md，第①路），表是生成的：
// project/lib/text-metrics-table.mjs（`node scripts/build-text-metrics-table.mjs`），不要手抄。
//
// 口径：
//   - 逐字形：ASCII 可打印字符与量过的非 ASCII 标点查表（em），汉字与其它未量到的非 ASCII 字符 1.0em；
//   - 字体由皮肤 × 角色决定（textFontOf），字重档 le500 / 600to650 / ge680；
//   - 编组标题（panel）先大写、每字加 letter-spacing（含末字，Chrome 的行为）；
//   - 估算仍是估算，余量单独给（textWidthMargin），排版侧的 needW 与折行判断（makeTextMeasurer）都加，不藏在常数里。
//
// 内联约束（docs/phase2-contracts.md §0）：只 import 同目录 [INLINE] 模块、整行书写、
// 顶层标识符全局唯一（tm 前缀）、不碰 DOM。text-metrics-table.mjs 必须排在本模块之前。
//
// 导出名：TEXT_METRICS_DEFAULT_FONT / textFontOf / textWidthEm / estimateTextWidth /
//         textWidthMargin / makeTextMeasurer / textHasLatin
import { TEXT_METRICS_GROUPS, TEXT_METRICS_SKINS } from './text-metrics-table.mjs';

// font 省略时的落点：sans 组 600–650 档（卡片标题的常见落点，且 sans 取的是 pingfang / sfpro 的最大值）
export const TEXT_METRICS_DEFAULT_FONT = Object.freeze({ group: 'sans', tier: '600to650', ls: 0, upper: false });
const TM_FALLBACK_SKIN = 'stratum';
const TM_LATIN_RE = /[A-Za-z0-9]/;

const tmCellOf = (font) => {
  const f = font || TEXT_METRICS_DEFAULT_FONT;
  const group = TEXT_METRICS_GROUPS[f.group] || TEXT_METRICS_GROUPS[TEXT_METRICS_DEFAULT_FONT.group];
  const tier = group.tiers[f.tier] || group.tiers[TEXT_METRICS_DEFAULT_FONT.tier];
  return tier.glyphs;
};

// 皮肤 × 角色 → 字体描述 { group, tier, ls, upper }。
// 第一参可以是皮肤 id 字符串、带 skin 字段的 spec、或带 skinId 字段的对象；认不出的皮肤按默认皮肤（stratum）。
// role: 'label' | 'sub' | 'edge' | 'panel' | 'title'；认不出的角色按 label。
//
// `title`（左上角那行大标题，lib/title-fit.mjs）没有单独标定：它与卡片标题同一个字体族，只是字重更粗
// （四条链路都写 font-weight 720），所以按 label 组的字体取 ≥680 档。**这个映射只此一份**——
// arch-doc 的 titleBlock 与 scene-svg 的 svgTextFont / svgTitleMeasure 都转调这里，别在别处再写一遍。
export function textFontOf(metricsOrSkinId, role) {
  let id = null;
  if (typeof metricsOrSkinId === 'string') id = metricsOrSkinId;
  else if (metricsOrSkinId && typeof metricsOrSkinId === 'object') {
    if (typeof metricsOrSkinId.skinId === 'string') id = metricsOrSkinId.skinId;
    else if (typeof metricsOrSkinId.skin === 'string') id = metricsOrSkinId.skin;
  }
  const skin = (id && TEXT_METRICS_SKINS[id]) || TEXT_METRICS_SKINS[TM_FALLBACK_SKIN];
  if (role === 'title') return { ...skin.label, tier: 'ge680' };
  return skin[role] || skin.label;
}

export function textHasLatin(text) {
  return TM_LATIN_RE.test(String(text == null ? '' : text));
}

// 文字宽度（em）：逐字形累加；panel 角色先大写；letter-spacing 每字一份（含末字）
export function textWidthEm(text, font) {
  const f = font || TEXT_METRICS_DEFAULT_FONT;
  let s = String(text == null ? '' : text);
  if (!s) return 0;
  if (f.upper) s = s.toUpperCase();
  const glyphs = tmCellOf(f);
  const ls = Number(f.ls) || 0;
  let em = 0;
  let n = 0;
  for (const ch of s) {
    n += 1;
    em += Object.prototype.hasOwnProperty.call(glyphs, ch) ? glyphs[ch] : 1;
  }
  return em + n * ls;
}

// 文字宽度（px）。font 省略 → TEXT_METRICS_DEFAULT_FONT，老调用方不改也能跑。
export function estimateTextWidth(text, px, font) {
  return textWidthEm(text, font) * px;
}

// 排版余量（px）：估算再准也是估算，可用宽 ≥ 估算宽 + 余量。
// 只含汉字：max(2px, 1% × 估算宽)；含 Latin / 数字：max(4px, 2% × 估算宽)。
export function textWidthMargin(text, px, font) {
  const s = String(text == null ? '' : text);
  if (!s) return 0;
  const w = estimateTextWidth(s, px, font);
  return textHasLatin(s) ? Math.max(4, 0.02 * w) : Math.max(2, 0.01 * w);
}

// node-fit 用的测量器（替换旧的 makeEstimateMeasurer）：折行逻辑照抄，只换单字宽。
// fontOrSkin：皮肤 id / spec（按 measure 的 role 参数取 label 或 sub 的字体），
// 或一个字体描述（所有角色共用），或 { label, sub } 两个字体描述的映射。
export function makeTextMeasurer(fontOrSkin) {
  const fontFor = (role) => {
    if (fontOrSkin == null) return textFontOf(TM_FALLBACK_SKIN, role);
    if (typeof fontOrSkin === 'string') return textFontOf(fontOrSkin, role);
    if (typeof fontOrSkin.group === 'string') return fontOrSkin;
    if (fontOrSkin.label || fontOrSkin.sub) return fontOrSkin[role] || fontOrSkin.label || fontOrSkin.sub;
    return textFontOf(fontOrSkin, role);
  };
  return function (text, fontPx, availW, role) {
    const s = String(text == null ? '' : text);
    if (!s) return { lines: 0, width: 0 };
    const f = fontFor(role === 'sub' ? 'sub' : 'label');
    const glyphs = tmCellOf(f);
    const ls = (Number(f.ls) || 0) * fontPx;
    const src = f.upper ? s.toUpperCase() : s;
    // 余量也进折行判断（不只进排版的 needW）：估算仍是估算，可用宽先扣掉 textWidthMargin 再折行，
    // 报回的宽度也含这份余量——node-fit 松弛内边距时就会把它留在文字两侧，而不是分配到最后一丝像素
    // （2026-09-13 审查：只在 needW 加余量，卡片被外框压缩后求解照样把可用宽分光，浏览器里多折一行）。
    const margin = textWidthMargin(s, fontPx, f);
    const fitW = availW - margin;
    // 折行点: 空格处优先(keep-all 下中文之间也可断)
    let lines = 1, cur = 0, max = 0, wordW = 0, wordStart = true;
    for (const ch of src) {
      const w = (Object.prototype.hasOwnProperty.call(glyphs, ch) ? glyphs[ch] : 1) * fontPx + ls;
      const breakable = ch === ' ' || ch.codePointAt(0) > 0xff;
      if (cur + w > fitW && !wordStart) {
        if (breakable || wordW === 0) { max = Math.max(max, cur); lines++; cur = w; wordW = w; }
        else { max = Math.max(max, cur - wordW); lines++; cur = wordW + w; wordW += w; }
      } else { cur += w; wordW = breakable ? 0 : wordW + w; }
      wordStart = false;
    }
    return { lines: lines, width: Math.min(availW, Math.max(max, cur) + margin) };
  };
}
