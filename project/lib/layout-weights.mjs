// lib/layout-weights.mjs —— **构建产物，不要手改。**
// 来源：孙毅的成对盲评 + 第二轮手调终稿（B 方案），34 条判断，一致率 94%。
// 由 `node scripts/fit-layout-weights.mjs --write` 生成。
//
// 为什么不再用判别力比分（A 方案）：它在候选差别很大时配不平 —— 第 4 步实测
// diagram.json 选中的那版墨水掉 40%、只换来 gap 从 1.0 到 1.09，而人工终稿是
// 墨水与 gap 同时最高的。锚因此换成「孙毅比较两张图时的选择」，那个判断不受
// 鼠标精度限制，也不会把手抖当成意图。
export const LAYOUT_WEIGHTS = Object.freeze({
  inkRatio: 0.738,          // 卡片墨水占比 · space
  contentFill: 0.739,       // 内容区完整度 · space
  groupGapRatio: 0.626,     // 分组间距比 · space
  edgeLength: 0,        // 走线总长 · routing
  edgeDetour: 0,        // 绕行倍率 · routing
  bends: 0.042,             // 折点总数 · routing
  bendsPerEdge: 0.042,      // 每条边折点 · routing
  minClearance: 0.186,      // 最小净空 · routing
  sideDistinct: 0.75,      // 一边一面 · routing
  alignRatio: 0,        // 边界共线率 · precision
  widthTiers: 0,        // 组内宽度档位 · precision
  widthSpread: 0,       // 组内宽度极差 · precision
  portSides: 0,         // 接口面数 · observe
  throughCards: 0,      // 穿卡数 · observe
  sharedOrigins: 0,     // 共享起点数 · observe
  adjacentStraight: 0.564,  // 相邻直达率 · routing
});
export const LAYOUT_WEIGHTS_SAMPLES = 34;
