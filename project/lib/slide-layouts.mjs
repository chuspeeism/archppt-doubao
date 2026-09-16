export const SLIDE_WIDTH = 1920;
export const SLIDE_HEIGHT = 1080;

export const SLIDE_LAYOUTS = Object.freeze({
  A: Object.freeze({
    id: 'A',
    label: '左标题 · 右架构图',
    titleBox: Object.freeze({ x: 64, y: 64, w: 544, h: 952, align: 'left-center' }),
    diagramBox: Object.freeze({ x: 672, y: 64, w: 1184, h: 952 }),
    margins: Object.freeze({ top: 64, right: 64, bottom: 64, left: 64, gap: 64 }),
  }),
  B: Object.freeze({
    id: 'B',
    label: '左上标题 · 下方架构图',
    titleBox: Object.freeze({ x: 64, y: 64, w: 800, h: 240, align: 'top-left' }),
    diagramBox: Object.freeze({ x: 64, y: 304, w: 1792, h: 712 }),
    margins: Object.freeze({ top: 64, right: 64, bottom: 64, left: 64, gap: 0 }),
  }),
  C: Object.freeze({
    // 2026-09-15：标题从「居中」改成「与架构图左边对齐」。原本标题框从 x=360 起、
    // 架构图从 x=120 起，本身就偏右 240px，导出时标题一律左锚在 360 → 看起来是「标题向右漂」。
    id: 'C',
    label: '宽标题 · 下方架构图',
    titleBox: Object.freeze({ x: 120, y: 64, w: 1680, h: 180, align: 'top-left' }),
    diagramBox: Object.freeze({ x: 120, y: 244, w: 1680, h: 772 }),
    margins: Object.freeze({ top: 64, right: 120, bottom: 64, left: 120, gap: 0 }),
  }),
});

const LAYOUT_ALIASES = new Map([
  ['A', 'A'],
  ['LEFT', 'A'],
  ['LEFT-TITLE', 'A'],
  ['TITLE-LEFT', 'A'],
  ['B', 'B'],
  ['TOP-LEFT', 'B'],
  ['TITLE-TOP-LEFT', 'B'],
  ['C', 'C'],
  ['TOP-CENTER', 'C'],
  ['TITLE-TOP-CENTER', 'C'],
]);

export function normalizeLayoutId(value, fallback = 'B') {
  const key = String(value || '').trim().toUpperCase();
  return LAYOUT_ALIASES.get(key) || fallback;
}

export function getSlideLayout(value) {
  return SLIDE_LAYOUTS[normalizeLayoutId(value)];
}

export function getDefaultFrame(value) {
  const { diagramBox } = getSlideLayout(value);
  return { ...diagramBox };
}

export function recommendLayout({ title = '', subtitle = '', leafCount = 0 } = {}) {
  const titleLength = Array.from(String(title)).length;
  const subtitleLength = Array.from(String(subtitle)).length;
  if (titleLength > 16 || subtitleLength > 34) return 'A';
  if (titleLength <= 10 && subtitleLength <= 16 && leafCount <= 9) return 'C';
  return 'B';
}
