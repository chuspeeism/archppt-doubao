// lib/parsers/json-validator.mjs
// Phase 2 JSON 输入校验薄封装（契约 §6 / §9）。
// - re-export 现有 validateSpec（保持基础行为不变）；
// - validateSpecPhase2 在基础校验之上补齐 Phase 2 字段校验：
//     * node.icon 必须是 slug 字符串或 false
//     * node.iconPosition 仅支持 left/top
//     * variant 白名单追加 decision/pill/database/circle
//     * edge.style 追加 bold
//     * 顶层 icons 只能是布尔值（false = 全局禁用图标自动匹配）
// 兼容两个版本的 lib/spec-validator.mjs：
//   - 未集成 Phase 2 的旧版：过滤其对新 variant/style 的误报 warning/error，再补上新字段校验；
//   - 已集成 Phase 2 的新版：通过前缀去重避免重复报错。
// 本模块不修改 lib/spec-validator.mjs 本身。

import { validateSpec as runBaseValidateSpec } from '../spec-validator.mjs';

export { validateSpec } from '../spec-validator.mjs';

const PHASE2_VARIANTS = new Set(['decision', 'pill', 'database', 'circle']);
const PHASE2_EDGE_STYLES = new Set(['bold']);
const ICON_POSITIONS = new Set(['left', 'top']);

export function validateSpecPhase2(spec) {
  const base = runBaseValidateSpec(spec);
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return base;

  // 1) 过滤旧版基础校验对 Phase 2 新枚举值的误报
  const errors = base.errors.filter((message) => {
    const styleHit = message.match(/^edges\[(\d+)\]\.style 仅支持 solid\/dashed$/);
    if (!styleHit) return true;
    const edge = Array.isArray(spec.edges) ? spec.edges[Number(styleHit[1])] : null;
    return !(edge && PHASE2_EDGE_STYLES.has(edge.style));
  });
  const warnings = base.warnings.filter((message) => {
    const variantHit = message.match(/\.variant "([^"]*)" 将按 default 渲染$/);
    return !(variantHit && PHASE2_VARIANTS.has(variantHit[1]));
  });

  // 2) 追加 Phase 2 校验；若基础校验（新版）已报同一字段则不重复报
  const pushUnique = (prefix, message) => {
    if (!errors.some((existing) => existing.startsWith(prefix))) errors.push(message);
  };

  if (spec.icons != null && typeof spec.icons !== 'boolean') {
    pushUnique('icons ', 'icons 只能是布尔值（false 表示全局禁用图标自动匹配）');
  }
  const walk = (nodes, path) => {
    if (!Array.isArray(nodes)) return;
    nodes.forEach((node, index) => {
      if (!node || typeof node !== 'object' || Array.isArray(node)) return;
      const at = `${path}[${index}]`;
      if (node.icon != null && node.icon !== false && typeof node.icon !== 'string') {
        pushUnique(`${at}.icon `, `${at}.icon 必须是图标 slug 字符串或 false（禁用自动匹配）`);
      } else if (typeof node.icon === 'string' && !node.icon.trim()) {
        pushUnique(`${at}.icon `, `${at}.icon 不能是空字符串`);
      }
      if (node.iconPosition != null && !ICON_POSITIONS.has(node.iconPosition)) {
        pushUnique(`${at}.iconPosition `, `${at}.iconPosition 仅支持 left/top`);
      }
      if (Array.isArray(node.children)) walk(node.children, `${at}.children`);
    });
  };
  walk(spec.nodes, 'nodes');

  return { ...base, valid: errors.length === 0, errors, warnings };
}
