import { normalizeLayoutId, getDefaultFrame } from './slide-layouts.mjs';
import { SKINS } from './skins.mjs';

const ALLOWED_VARIANTS = new Set(['default', 'accent', 'store', 'muted', 'container', 'decision', 'pill', 'database', 'circle']);
const ALLOWED_EDGE_STYLES = new Set(['solid', 'dashed', 'bold']);
const ALLOWED_ICON_POSITIONS = new Set(['left', 'top']);
const ALLOWED_PORT_SIDES = new Set(['top', 'bottom', 'left', 'right']);
// 排版模式与分层图的 side 列（lib/arch-doc.mjs 的 layoutLayered 同口径）
const ALLOWED_MODES = new Set(['flow', 'layered']);
const ALLOWED_SIDES = new Set(['left', 'right']);
// 叶子数量的建议上限：流程图 14；分层图 20–30 张卡是常态，放宽到 30
const LEAF_COUNT_LIMIT = 14;
const LEAF_COUNT_LIMIT_LAYERED = 30;
// 分层图层带（不含 side 列）超过这个数建议合并相邻层
const LAYERED_BAND_LIMIT = 6;
// 分层图 side 列能装几张子卡片：按版式外框高粗估，每张卡占「最小卡高 56 + 行距 24」，列的上下内边距约 64。
// 超过就会被压到下限以下、越出外框（排版器不再静默压扁，质检会报 out_of_bounds）。B 版式约 8 张、A 版式约 11 张
const LAYERED_SIDE_CARD_PITCH = 56 + 24;
const LAYERED_SIDE_PAD = 64;
const layeredSideCardLimit = (spec) => {
  const frameH = spec && spec.frame && Number.isFinite(spec.frame.h) ? spec.frame.h : getDefaultFrame(spec && spec.layout).h;
  return Math.max(1, Math.floor((frameH - LAYERED_SIDE_PAD + (LAYERED_SIDE_CARD_PITCH - 56)) / LAYERED_SIDE_CARD_PITCH));
};

// planning-rules.md / SKILL.md 要求嵌套不超过 3 层（容器层级）。
// walk 的 depth 从 0 开始：depth=0 的数组装的是第 1 层节点，所以 嵌套层数 = depth + 1。
const NESTING_LEVEL_LIMIT = 3;
const NESTING_LEVEL_HARD_LIMIT = 6;

/**
 * id 的字符集。SKILL.md / references/schema.md 一直要求「只用 ASCII 字母数字下划线」，
 * 但这条规则以前只在提示词里，代码不落地 —— 于是 id 成了一条没有转义的注入通道：
 * 驱动器把 step.id 拼进 AppleScript 的 `--` 注释行，而 AppleScript 的注释只到行尾，
 * id 里一个换行就能让后面那段变成 tell 块里的可执行语句（2026-09-12 复现，
 * 生成的脚本里出现了独立成行的 `do shell script`）。
 *
 * 驱动器那一侧已经压掉换行；这里再把入口收紧，两道都要有：id 不是给人看的文案，
 * 显示名走 label / sublabel，收紧它不损失任何表达力。上游的 Mermaid 解析器早就把
 * 非 ASCII 节点名换成了 n1/n2，工作台自动生成的也是 n1/e1/g1，现存 spec 无一例外。
 */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const badIdHint = (id) => (/[\r\n\t]/.test(id)
  ? '（里面有换行或制表符）'
  : '（只允许 ASCII 字母、数字、下划线、连字符，最长 64 字符）');

const isContainerNode = (node) =>
  node.variant === 'container' || (Array.isArray(node.children) && node.children.length > 0);

export function validateSpec(spec) {
  const errors = [];
  const warnings = [];
  const ids = new Set();
  const leaves = [];
  const endpointIds = new Set();
  let deepest = { level: 0, path: 'nodes' };

  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return { valid: false, errors: ['根对象必须是 JSON object'], warnings };
  }
  if (!String(spec.title || '').trim()) errors.push('title 不能为空');
  if (!Array.isArray(spec.nodes) || !spec.nodes.length) errors.push('nodes 必须是非空数组');

  // 排版模式：flow（流程图，缺省）/ layered（分层图）
  if (spec.mode != null && !ALLOWED_MODES.has(spec.mode)) {
    errors.push(`mode 仅支持 flow/layered，收到: ${spec.mode}`);
  }
  const layered = spec.mode === 'layered';
  let bandCount = 0;   // layered 下的层带数（顶层节点里不当 side 列的那些）

  function walk(nodes, path = 'nodes', depth = 0, ancestorIds = []) {
    if (!Array.isArray(nodes)) {
      errors.push(`${path} 必须是数组`);
      return;
    }
    const level = depth + 1;
    if (nodes.length && level > deepest.level) deepest = { level, path };
    nodes.forEach((node, index) => {
      const at = `${path}[${index}]`;
      if (!node || typeof node !== 'object' || Array.isArray(node)) {
        errors.push(`${at} 必须是对象`);
        return;
      }
      const id = String(node.id || '').trim();
      if (!id) errors.push(`${at}.id 不能为空`);
      else if (!ID_RE.test(id)) errors.push(`${at}.id 不合法: ${JSON.stringify(id)}${badIdHint(id)}`);
      else if (ids.has(id)) errors.push(`节点 id 重复: ${id}`);
      else ids.add(id);
      const label = String(node.label || '').trim();
      if (!label) errors.push(`${at}.label 不能为空`);
      if (node.variant && !ALLOWED_VARIANTS.has(node.variant)) warnings.push(`${at}.variant "${node.variant}" 将按 default 渲染`);
      if (node.icon != null && node.icon !== false && typeof node.icon !== 'string') {
        errors.push(`${at}.icon 必须是图标 slug 字符串或 false（禁用自动匹配）`);
      }
      if (node.iconPosition != null && !ALLOWED_ICON_POSITIONS.has(node.iconPosition)) {
        errors.push(`${at}.iconPosition 仅支持 left/top，收到: ${node.iconPosition}`);
      }
      // side: 分层图里贴在左 / 右侧、贯穿全高的竖向「体系」列。只对顶层容器生效，且 v1 只支持列内全是叶子
      let isSideColumn = false;
      if (node.side != null) {
        if (!ALLOWED_SIDES.has(node.side)) {
          errors.push(`${at}.side 仅支持 left/right，收到: ${node.side}`);
        } else if (depth > 0) {
          warnings.push(`${at}.side 只对顶层节点生效，将被忽略`);
        } else if (!layered) {
          warnings.push(`${at}.side 只在 mode: "layered" 下生效，当前按流程图排版将被忽略`);
        } else if (!Array.isArray(node.children) || !node.children.length) {
          warnings.push(`${at}.side 列必须是带 children 的容器，将按普通层带处理`);
        } else if (node.children.some((child) => child && isContainerNode(child))) {
          warnings.push(`${at}.side 列的子节点只能是叶子（v1 不支持列内嵌套容器），将按普通层带处理`);
        } else {
          isSideColumn = true;
          const limit = layeredSideCardLimit(spec);
          if (node.children.length > limit) {
            warnings.push(`${at}.side 列有 ${node.children.length} 张子卡片，${normalizeLayoutId(spec.layout)} 版式的外框高约装 ${limit} 张，多出的会被压扁并越出外框，建议拆成两根列或合并`);
          }
        }
      }
      if (layered && depth === 0 && !isSideColumn) bandCount += 1;
      if (!isContainerNode(node)) leaves.push({ id, label, ancestorIds });
      if (node.children != null) {
        walk(node.children, `${at}.children`, depth + 1, id ? [...ancestorIds, id] : ancestorIds);
      }
    });
  }
  walk(spec.nodes || []);

  if (layered) {
    if (bandCount === 0) errors.push('mode: "layered" 至少要有一条层带（不带 side 的顶层节点）');
    if (bandCount > LAYERED_BAND_LIMIT) {
      warnings.push(`层带有 ${bandCount} 条，超过 ${LAYERED_BAND_LIMIT} 条时每层都会被压得很扁，建议合并相邻的层`);
    }
  }

  if (deepest.level > NESTING_LEVEL_HARD_LIMIT) {
    warnings.push(
      `节点嵌套达到 ${deepest.level} 层（最深处: ${deepest.path}），已超过 ${NESTING_LEVEL_HARD_LIMIT} 层，` +
        `远高于建议的 ${NESTING_LEVEL_LIMIT} 层上限；投影时几乎无法分辨节点归属，请重新划分层级`
    );
  } else if (deepest.level > NESTING_LEVEL_LIMIT) {
    warnings.push(
      `节点嵌套达到 ${deepest.level} 层（最深处: ${deepest.path}），超过建议的 ${NESTING_LEVEL_LIMIT} 层上限；` +
        '这是可读性建议，不影响构建，但嵌套过深时容器边框层层叠加，投影时难以分辨节点归属，建议压平到 3 层以内'
    );
  }

  if (spec.layout != null && !['A', 'B', 'C'].includes(String(spec.layout).toUpperCase())) {
    errors.push(`layout 仅支持 A/B/C，收到: ${spec.layout}`);
  }
  if (spec.icons != null && spec.icons !== false && spec.icons !== true) {
    errors.push('icons 仅支持 true/false（false 表示全局禁用图标自动匹配）');
  }
  if (spec.skin != null) {
    if (typeof spec.skin !== 'string') {
      errors.push('skin 必须是字符串');
    } else if (!SKINS[spec.skin]) {
      warnings.push(`skin "${spec.skin}" 不存在，将回退默认皮肤（可选: ${Object.keys(SKINS).join('/')}）`);
    }
  }
  if (spec.frame != null) {
    const frame = spec.frame;
    if (!frame || typeof frame !== 'object' || ['x', 'y', 'w', 'h'].some((key) => !Number.isFinite(frame[key]))) {
      errors.push('frame 必须包含有限数值 x/y/w/h');
    } else if (frame.w < 300 || frame.h < 200) {
      errors.push('frame 最小尺寸为 300×200');
    }
  }
  if (spec.positions != null && (!spec.positions || typeof spec.positions !== 'object' || Array.isArray(spec.positions))) {
    errors.push('positions 必须是以节点 id 为键的对象');
  } else if (spec.positions) {
    for (const [id, position] of Object.entries(spec.positions)) {
      const at = `positions.${id}`;
      if (!ids.has(id)) {
        errors.push(`${at} 引用不存在节点`);
        continue;
      }
      if (!position || typeof position !== 'object' || Array.isArray(position)) {
        errors.push(`${at} 必须是对象`);
        continue;
      }
      if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
        errors.push(`${at} 必须包含有限数值 x/y`);
      }
      const hasW = position.w != null;
      const hasH = position.h != null;
      if (hasW !== hasH) errors.push(`${at}.w 和 h 必须同时提供`);
      if (hasW && (!Number.isFinite(position.w) || !Number.isFinite(position.h) || position.w <= 0 || position.h <= 0)) {
        errors.push(`${at}.w/h 必须是正数`);
      }
    }
  }

  if (!Array.isArray(spec.edges)) {
    errors.push('edges 必须是数组');
  } else {
    const edgeIds = new Set();
    spec.edges.forEach((edge, index) => {
      const at = `edges[${index}]`;
      if (!edge || typeof edge !== 'object' || Array.isArray(edge)) {
        errors.push(`${at} 必须是对象`);
        return;
      }
      if (!ids.has(edge.source)) errors.push(`${at}.source 引用不存在节点: ${edge.source}`);
      if (!ids.has(edge.target)) errors.push(`${at}.target 引用不存在节点: ${edge.target}`);
      if (edge.source === edge.target) warnings.push(`${at} 是自环边`);
      if (edge.id != null && edge.id !== '') {
        const eid = String(edge.id);
        // 边 id 同样会被拼进 AppleScript 注释行，跟节点 id 走同一条规矩
        if (!ID_RE.test(eid)) errors.push(`${at}.id 不合法: ${JSON.stringify(eid)}${badIdHint(eid)}`);
        else if (edgeIds.has(eid)) errors.push(`边 id 重复: ${eid}`);
        else edgeIds.add(eid);
      }
      if (edge.style && !ALLOWED_EDGE_STYLES.has(edge.style)) errors.push(`${at}.style 仅支持 solid/dashed/bold`);
      // reversed: 只把箭头画在 source 一侧, source/target 本身不变（用于表达"回流"而不改连接关系）
      if (edge.reversed != null && typeof edge.reversed !== 'boolean') errors.push(`${at}.reversed 必须是布尔值`);
      // undirected: 两头都不画箭头的关联线。优先级 undirected > bidirectional > reversed
      if (edge.undirected != null && typeof edge.undirected !== 'boolean') errors.push(`${at}.undirected 必须是布尔值`);
      if (edge.undirected === true && (edge.bidirectional || edge.reversed)) {
        warnings.push(`${at} 同时写了 undirected 与 bidirectional/reversed，无箭头优先，将忽略 bidirectional/reversed`);
      } else if (edge.reversed && edge.bidirectional) {
        warnings.push(`${at} 同时写了 bidirectional 与 reversed，reversed 将被忽略`);
      }
      // labelT: 标签沿连线的位置, 0 = 起点, 1 = 终点; 缺省时落在最长一段的中点
      if (edge.labelT != null && (typeof edge.labelT !== 'number' || !Number.isFinite(edge.labelT) || edge.labelT < 0 || edge.labelT > 1)) {
        errors.push(`${at}.labelT 必须是 0~1 之间的数值`);
      }
      if (edge.labelT != null && !edge.label) warnings.push(`${at}.labelT 无对应 label，将被忽略`);
      // sourcePort / targetPort: 手调端点，{ side: top|bottom|left|right, t: 0~1 }，t 是沿该边的位置
      [['sourcePort', 'source'], ['targetPort', 'target']].forEach(([key, end]) => {
        const port = edge[key];
        if (port == null) return;
        if (!port || typeof port !== 'object' || Array.isArray(port)) {
          errors.push(`${at}.${key} 必须是对象 { side, t }`);
          return;
        }
        if (!ALLOWED_PORT_SIDES.has(port.side)) {
          errors.push(`${at}.${key}.side 仅支持 top/bottom/left/right，收到: ${port.side}`);
        }
        if (typeof port.t !== 'number' || !Number.isFinite(port.t) || port.t < 0 || port.t > 1) {
          errors.push(`${at}.${key}.t 必须是 0~1 之间的数值`);
        }
        if (edge[end] === edge.source && edge.source === edge.target) {
          warnings.push(`${at} 是自环边，${key} 不生效`);
        }
      });
      // segShifts: 中间段（首末段之外的每一段）相对自动位置的位移（px），按段序排列。
      // 挪一段，它前后两段的长度随之一长一短；三折线只有 1 项，四折线 2 项，以此类推。
      if (edge.segShifts != null) {
        if (!Array.isArray(edge.segShifts)) {
          errors.push(`${at}.segShifts 必须是数组（每个中间段一个位移，单位 px）`);
        } else if (edge.segShifts.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
          errors.push(`${at}.segShifts 的每一项都必须是有限数值`);
        }
      }
      // midShift: segShifts 之前的写法，只调三折线的第 2 段；读入时升级成 segShifts: [值]
      if (edge.midShift != null) {
        if (typeof edge.midShift !== 'number' || !Number.isFinite(edge.midShift)) {
          errors.push(`${at}.midShift 必须是数值`);
        } else if (edge.segShifts != null) {
          warnings.push(`${at} 同时写了 segShifts 与旧字段 midShift，midShift 将被忽略`);
        } else {
          warnings.push(`${at}.midShift 是旧字段，已改名为 segShifts: [${edge.midShift}]`);
        }
      }
      endpointIds.add(edge.source);
      endpointIds.add(edge.target);
    });
  }

  // 孤立叶子节点：容器不参与检查（容器靠包含关系表达语义）。
  // edges 为空数组时整张图本就没有连线（diagram-blank.json 这类空白起步就是如此），
  // 逐个提示只会变成每次构建的固定噪音，因此完全跳过。
  if (Array.isArray(spec.edges) && spec.edges.length) {
    for (const leaf of leaves) {
      if (!leaf.id || endpointIds.has(leaf.id)) continue;
      // 所在容器（含更外层容器）本身连了线时，该叶子通过包含关系已经接入图中，不算孤立。
      if (leaf.ancestorIds.some((ancestorId) => endpointIds.has(ancestorId))) continue;
      warnings.push(
        `节点 "${leaf.label || leaf.id}"（id: ${leaf.id}）未出现在任何 edge 的 source 或 target 中，` +
          '与图中其余部分没有连线，请确认是否遗漏'
      );
    }
  }

  // 重复 label：多为复制节点后忘记改名，但也可能是有意重复，因此只给 warning。
  const labelOwners = new Map();
  for (const leaf of leaves) {
    if (!leaf.label || !leaf.id) continue;
    if (!labelOwners.has(leaf.label)) labelOwners.set(leaf.label, []);
    labelOwners.get(leaf.label).push(leaf.id);
  }
  for (const [label, owners] of labelOwners) {
    if (owners.length < 2) continue;
    warnings.push(
      `label "${label}" 被 ${owners.length} 个叶子节点重复使用（id: ${owners.join(', ')}），` +
        '请确认是否为复制节点后未修改'
    );
  }

  const leafCount = countLeaves(spec.nodes || []);
  const leafLimit = layered ? LEAF_COUNT_LIMIT_LAYERED : LEAF_COUNT_LIMIT;
  if (leafCount > leafLimit) warnings.push(`叶子节点数量为 ${leafCount}，建议合并语义或缩小系统范围`);

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    normalizedLayout: normalizeLayoutId(spec.layout),
    nodeCount: ids.size,
    leafCount,
  };
}

function countLeaves(nodes) {
  let count = 0;
  for (const node of nodes) {
    if (Array.isArray(node.children) && node.children.length) count += countLeaves(node.children);
    else count += 1;
  }
  return count;
}
