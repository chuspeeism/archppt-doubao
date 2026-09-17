// title-fit.mjs [INLINE]
// 左上角那行大标题的排版：**先折行，装不下再缩字号**。四条链路（工作台画布 / SVG 导出 /
// 原生 PPTX / 豆包逐步画）共用这一份结论，行的断法、字号、行高三处必须一致。
//
// 与节点标签的政策**正好相反**：节点标签是「只缩不折」（scene-svg.mjs 的 svgFitFontSize，
// 由 tests/scene-svg.test.mjs「overlong labels shrink font size without wrapping」守着）。
// 标题是全图唯一一处会折行的文字，别把这两条政策互相抄过去。
//
// 策略与常数的来由见 docs/title-fit-spec.md。
//
// 纯函数、无 DOM、无 npm 依赖；估宽复用全引擎那把标定尺子 lib/text-metrics.mjs 的 estimateTextWidth
// （同一份口径，不再各抄一份）。默认不带 font → text-metrics 的默认字体；**调用方应当传自己的 measure**：
// arch-doc 的 titleBlock 按 spec 的皮肤取 label 组字体 + ge680 档，导出器用 scene-svg 的 svgTitleMeasure。
// 内联顺序：必须排在 text-metrics.mjs / quality-checker.mjs 之后、arch-doc.mjs 与导出器之前。
import { estimateTextWidth } from './text-metrics.mjs';

export const TITLE_PX = 72, TITLE_MIN_PX = 36, TITLE_MAX_LINES = 4, TITLE_LINE = 1.15;
// 降字号的档距：72 → 70 → … → 36，正好落在下限上
export const TITLE_STEP_PX = 2;

// 折行单元：CJK（及一切码位 > 0xff 的字符）逐字可断；ASCII 连成词，只在空白处断，不拆词。
// 与 estimateTextWidth 的宽 / 窄判据（codePointAt > 0xff）用同一条线，估宽与断点不会打架。
const titleTokens = (para) => {
  const out = [];
  let word = '';
  const flush = () => { if (word) { out.push({ t: word, space: false }); word = ''; } };
  for (const ch of String(para)) {
    if (/\s/.test(ch)) { flush(); out.push({ t: ch, space: true }); continue; }
    if (ch.codePointAt(0) > 0xff) { flush(); out.push({ t: ch, space: false }); continue; }
    word += ch;
  }
  flush();
  return out;
};

const rtrim = (s) => String(s).replace(/\s+$/, '');

/**
 * 在 maxW 之内按估宽贪心折行。标题里已有的 `\n` 是硬断行，各段各自折。
 * 单个词比 maxW 还宽时独占一行并允许溢出（不拆词）。
 * @returns {string[]} 至少一行
 */
export function wrapTitle(text, px, maxW, measure) {
  const m = typeof measure === 'function' ? measure : estimateTextWidth;
  const size = Number(px) > 0 ? Number(px) : TITLE_PX;
  const limit = Number(maxW);
  const paras = String(text ?? '').split(/\r?\n/);
  if (!(limit > 0)) return paras.map(rtrim);
  const out = [];
  for (const para of paras) {
    let line = '';
    let pushed = 0;
    for (const tok of titleTokens(para)) {
      if (!line) { if (tok.space) continue; line = tok.t; continue; }
      const next = line + tok.t;
      if (m(next, size) <= limit) { line = next; continue; }
      out.push(rtrim(line)); pushed += 1;
      line = tok.space ? '' : tok.t;
    }
    if (line || !pushed) { out.push(rtrim(line)); }
  }
  return out;
}

/**
 * 先折行再缩字号，直到「行数 ≤ maxLines 且 总高 ≤ maxH」。
 * 到 minPx 还放不下就停在 minPx 并允许溢出（整行都留着，不截断文字）。
 *
 * @returns {{ px:number, lines:string[], lineH:number, h:number }}
 *   lineH = px × lineHeight，h = lines.length × lineH，都是**未取整**的浮点数；
 *   要取整由调用方自己 Math.round（titleBlock 只对 y / h 取整，导出器按 svgNum 保留两位）。
 */
export function fitTitle(text, opts = {}) {
  const basePx = Number.isFinite(opts.basePx) ? Number(opts.basePx) : TITLE_PX;
  const minPx = Number.isFinite(opts.minPx) ? Number(opts.minPx) : TITLE_MIN_PX;
  const maxLines = Number.isFinite(opts.maxLines) && opts.maxLines >= 1
    ? Math.floor(opts.maxLines) : TITLE_MAX_LINES;
  const lineHeight = Number.isFinite(opts.lineHeight) ? Number(opts.lineHeight) : TITLE_LINE;
  const maxH = Number.isFinite(opts.maxH) ? Number(opts.maxH) : Infinity;
  const maxW = Number.isFinite(opts.maxW) ? Number(opts.maxW) : Infinity;
  const measure = typeof opts.measure === 'function' ? opts.measure : estimateTextWidth;

  const floor = Math.min(basePx, Math.max(1, minPx));
  let px = Math.max(floor, basePx);
  let lines = wrapTitle(text, px, maxW, measure);
  while (px > floor) {
    if (lines.length <= maxLines && lines.length * (px * lineHeight) <= maxH + 1e-9) break;
    px = Math.max(floor, px - TITLE_STEP_PX);
    lines = wrapTitle(text, px, maxW, measure);
  }
  const lineH = px * lineHeight;
  return { px, lines, lineH, h: lines.length * lineH };
}

/**
 * 导出器共用的「有就用、没有就算」：
 *   - `scene.title` 带 `lines` + `px`（arch-doc.buildScene 那条链路）→ 直接采信，四条链路同一份断法；
 *   - 没带（只读页把 h1 的 DOM rect 拼成 scene，没有排版结论）→ 现场按框宽 `title.w` 折一遍。
 * 三个导出器都调这一个，别各抄一份。
 */
export function sceneTitleFit(title, opts = {}) {
  const lineHeight = Number.isFinite(opts.lineHeight) ? Number(opts.lineHeight) : TITLE_LINE;
  const given = title && Array.isArray(title.lines)
    ? title.lines.filter((l) => typeof l === 'string') : null;
  const px = title && Number.isFinite(title.px) && title.px > 0 ? Number(title.px) : 0;
  if (given && given.length && px) {
    const lineH = px * lineHeight;
    return { px, lines: given.slice(), lineH, h: given.length * lineH };
  }
  const maxW = Number.isFinite(opts.maxW) ? Number(opts.maxW)
    : (title && Number.isFinite(Number(title.w)) ? Number(title.w) : Infinity);
  return fitTitle(title && title.text, { ...opts, maxW, lineHeight });
}
