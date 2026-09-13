// scene-from-spec.mjs —— 把一份 spec.json 走成 { scene, ws }，再由 themeFor 配出主题。
// 口径与 generate.mjs 构建期一字不差（autoLayout → autoFix → positions 覆盖 →
// materializeBundles → buildScene，主题 = skinExportTheme × 装框系数，edgeScale = 整图几何系数）。
//
// 为什么在 project/lib/ 而不是 scripts/ 下：这两个函数是「spec → 可导出的 Scene」这条
// 主干路上的一环，凡是要拿 spec 直接出图的消费者都要用——还原度量具（scripts/fidelity/）、
// 豆包运行器（shells/doubao/runner/）都在用。豆包特供版出货时只投影 project/，不投影
// scripts/，所以它必须在引擎里，不能留在量具目录下。
// scripts/fidelity/case.mjs 现在只是这里的转发壳，老的 import 路径照常能用。

import {
  fromBuildSpec, autoLayout, materializeBundles, buildScene,
  qualityOptionsOf, metricsOf, frameScale, rectOf, setRect,
} from './arch-doc.mjs';
import { checkQuality } from './quality-checker.mjs';
import { autoFix } from './auto-fixer.mjs';
import { SKINS, DEFAULT_SKIN, skinExportTheme, skinMetrics, scaleMetrics, skinCardHeight } from './skins.mjs';

export function sceneFromSpec(spec) {
  const presetLabelT = new Map((spec.edges || [])
    .filter((e) => e.id && Number.isFinite(e.labelT))
    .map((e) => [e.id, e.labelT]));
  const ws = fromBuildSpec(spec);
  autoLayout(ws);
  {
    const fixScene = buildScene(ws);
    const fixResult = autoFix(fixScene, checkQuality(fixScene, qualityOptionsOf(ws)));
    for (const [id, p] of Object.entries(fixResult.positions)) setRect(ws, id, p);
  }
  if (spec.positions) {
    for (const [id, p] of Object.entries(spec.positions)) {
      const cur = rectOf(ws, id);
      if (!cur || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      setRect(ws, id, {
        x: p.x, y: p.y,
        w: Number.isFinite(p.w) ? p.w : cur.w,
        h: Number.isFinite(p.h) ? p.h : cur.h,
      });
    }
  }
  materializeBundles(ws);
  for (const e of ws.edges) if (presetLabelT.has(e.id)) e.labelT = presetLabelT.get(e.id);
  return { scene: buildScene(ws), ws };
}

export function themeFor(scene, ws, skinId) {
  const skin = SKINS[skinId] || SKINS[DEFAULT_SKIN];
  const FIT = frameScale(ws);
  const metrics = metricsOf(ws);
  const baseCardH = skinCardHeight(metrics, {
    hasSub: scene.nodes.some((n) => n.sublabel != null && n.sublabel !== ''),
  });
  const cardH = scene.nodes.length ? Math.max(...scene.nodes.map((n) => n.h)) : baseCardH;
  const geoFit = Math.max(0.3, Math.min(2, FIT * (cardH / Math.max(1, baseCardH))));
  const theme = skinExportTheme(skin);
  theme.metrics = scaleMetrics(skinMetrics(skin), FIT);
  theme.geoScale = 1;      // 外框缩放系数（工作台的 --type-scale），构建期恒为 1
  theme.edgeScale = geoFit;
  return theme;
}
