// lib/skin-css.mjs [INLINE] —— 皮肤第二层: 自由 CSS 的作用域限定与几何属性拦截。
// 无 DOM 依赖；ES2019；构建期与运行时换肤共用同一份实现。
//
// 分层契约（见 docs/skins-notes.md）:
//   第一层 结构 token  —— 会被布局引擎读走，必须走 METRICS_SPEC，有默认值和取值范围；
//   第二层 装饰 token + extraCss —— 不进入任何几何计算，取值自由。
// 本文件负责守住第二层的边界: 凡是能改变盒子尺寸、位置、排版度量的声明一律丢弃并记录，
// 其余原样保留。丢弃而不是构建失败——设计稿里多写一条 padding 不该阻塞出图。

// 任何规则里都不允许（直接改变文字度量或盒模型语义）。精确匹配——
// font-weight / font-family 是观感，放行；font 简写含字号，拦截。
const ALWAYS_FORBIDDEN_EXACT = [
  'font', 'font-size', 'line-height', 'letter-spacing', 'word-spacing', 'tab-size',
  'box-sizing', 'zoom', 'writing-mode', 'direction', 'aspect-ratio',
  'columns', 'column-count', 'column-width', 'contain', 'container-type',
];

// 只在"绝对定位的伪元素"规则里允许（脱离文档流，不影响节点盒子）
const FLOW_FORBIDDEN = [
  'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
  'padding', 'margin', 'gap', 'row-gap', 'column-gap', 'inset',
  'top', 'right', 'bottom', 'left', 'position', 'display', 'float',
  'flex', 'grid', 'order', 'align-content', 'align-items', 'align-self',
  'justify-content', 'justify-items', 'justify-self', 'place-content', 'place-items', 'place-self',
  'transform', 'scale', 'rotate', 'translate', 'border-width',
];

// 文档根: 出现在选择器任何位置都拒绝（改到这里等于绕过作用域）
const ROOT_SELECTORS = [':root', 'html', 'body', '*'];
// 编辑器浮层: 不进入演示态、打印和导出，出现在任何位置都拒绝
const CHROME_SELECTORS = [
  '.toolbar', '.layout-switch', '.quality-', '.export-', '.json-', '.toast',
  '.frame-box', '.frame-handle', '.frame-label', '.connect-hint', '.skin-menu', '.skin-swatch',
  // 缩放手柄与吸附辅助线（.snap- 收前缀; .node- 不能收前缀, 会误伤 .node-label 等内容类）
  '.node-handle', '.node-edge', '.frame-edge', '.snap-',
];
// 结构容器: 只能当作用域前缀，不能当被改写的目标
const SCOPE_ONLY_SELECTORS = ['#stage', '#canvas'];

// 第一层 token 的 CSS 变量: 只能改 metrics，不能在 extraCss 里绕过取值范围
const RESERVED_CUSTOM_PROPS = [
  '--icon-size', '--icon-size-top', '--icon-gap-x', '--icon-gap-top', '--label-sub-gap',
  '--card-pad-x', '--type-node', '--type-small', '--panel-pad-x', '--panel-pad-top',
];

const SCOPE = '#stage';
const MAX_LENGTH = 20000;

const propExact = (prop, list) => list.indexOf(prop) >= 0;

const propPrefix = (prop, list) => {
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (prop === p || prop.indexOf(p + '-') === 0) return true;
  }
  // border-*-width 一类的后缀写法
  if (prop.indexOf('border') === 0 && /(^|-)width$/.test(prop)) return true;
  return false;
};

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

// 按顶层花括号切成 [{ prelude, body }]，未闭合的尾块丢弃
const splitBlocks = (css) => {
  const out = [];
  let depth = 0;
  let start = 0;
  let preludeEnd = -1;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') {
      if (depth === 0) preludeEnd = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        out.push({ prelude: css.slice(start, preludeEnd).trim(), body: css.slice(preludeEnd + 1, i) });
        start = i + 1;
      }
      if (depth < 0) depth = 0;
    }
  }
  return out;
};

// 顶层分号切声明（跳过引号与括号内的分号）
const splitDeclarations = (body) => {
  const out = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === quote && body[i - 1] !== '\\') quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ';' && depth === 0) { out.push(body.slice(start, i)); start = i + 1; }
  }
  out.push(body.slice(start));
  return out.map(function(d) { return d.trim(); }).filter(Boolean);
};

const isPseudoElementSelector = (sel) => /::(before|after)\b/.test(sel);

const scopeSelector = (sel) => {
  const s = sel.trim();
  if (!s) return '';
  if (s.indexOf(SCOPE) === 0) return s;
  return SCOPE + ' ' + s;
};

// 取选择器的作用对象（最后一个复合选择器），#stage/#canvas 只在这里出现才算被改写
const selectorSubject = (sel) => {
  const parts = sel.replace(/\s*([>+~])\s*/g, ' ').split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : sel;
};

const selectorBlocked = (sel) => {
  const s = sel.trim();
  for (let i = 0; i < ROOT_SELECTORS.length; i++) {
    const r = ROOT_SELECTORS[i];
    if (s === r || s.indexOf(r + ' ') >= 0 || s.indexOf(' ' + r) >= 0 || s.indexOf(r + ':') === 0) return r;
  }
  for (let i = 0; i < CHROME_SELECTORS.length; i++) {
    if (s.indexOf(CHROME_SELECTORS[i]) >= 0) return CHROME_SELECTORS[i];
  }
  const subject = selectorSubject(s);
  for (let i = 0; i < SCOPE_ONLY_SELECTORS.length; i++) {
    const c = SCOPE_ONLY_SELECTORS[i];
    if (subject === c || subject.indexOf(c + ':') === 0 || subject.indexOf(c + '.') === 0) return c;
  }
  return null;
};

// 处理一条样式规则的声明块，返回保留下来的声明文本
function filterDeclarations(body, ctx, issues) {
  const decls = splitDeclarations(body);
  const kept = [];
  // 绝对定位的伪元素脱离文档流，几何属性对节点盒子无影响，放行
  let absolutePseudo = false;
  if (ctx.pseudoOnly) {
    for (let i = 0; i < decls.length; i++) {
      const m = /^position\s*:\s*(absolute|fixed)\b/i.exec(decls[i]);
      if (m) { absolutePseudo = true; break; }
    }
  }
  for (let i = 0; i < decls.length; i++) {
    const decl = decls[i];
    const colon = decl.indexOf(':');
    if (colon < 0) { issues.push({ type: 'malformed', selector: ctx.selector, detail: decl }); continue; }
    const rawProp = decl.slice(0, colon).trim();
    const prop = rawProp.toLowerCase();
    const value = decl.slice(colon + 1).trim();

    if (prop.indexOf('--') === 0) {
      if (RESERVED_CUSTOM_PROPS.indexOf(prop) >= 0) {
        issues.push({ type: 'reserved-var', selector: ctx.selector, detail: rawProp });
        continue;
      }
      kept.push(rawProp + ':' + value);
      continue;
    }
    if (/url\(\s*['"]?(?!data:)[a-z]+:/i.test(value)) {
      issues.push({ type: 'external-url', selector: ctx.selector, detail: rawProp });
      continue;
    }
    if (propExact(prop, ALWAYS_FORBIDDEN_EXACT)) {
      issues.push({ type: 'typography', selector: ctx.selector, detail: rawProp });
      continue;
    }
    if (propPrefix(prop, FLOW_FORBIDDEN) && !absolutePseudo) {
      issues.push({ type: 'geometry', selector: ctx.selector, detail: rawProp });
      continue;
    }
    kept.push(rawProp + ':' + value);
  }
  return kept.join(';');
}

function processStyleRule(prelude, body, issues) {
  const parts = prelude.split(',');
  const selectors = [];
  for (let i = 0; i < parts.length; i++) {
    const sel = parts[i].trim();
    if (!sel) continue;
    const blocked = selectorBlocked(sel);
    if (blocked) { issues.push({ type: 'selector', selector: sel, detail: blocked }); continue; }
    selectors.push(sel);
  }
  if (!selectors.length) return '';
  let pseudoOnly = true;
  for (let i = 0; i < selectors.length; i++) if (!isPseudoElementSelector(selectors[i])) pseudoOnly = false;
  const kept = filterDeclarations(body, { selector: selectors.join(','), pseudoOnly: pseudoOnly }, issues);
  if (!kept) return '';
  return selectors.map(scopeSelector).join(',') + '{' + kept + '}';
}

function processKeyframes(prelude, body, issues) {
  const frames = splitBlocks(body);
  const out = [];
  for (let i = 0; i < frames.length; i++) {
    const kept = filterDeclarations(frames[i].body, { selector: prelude + ' ' + frames[i].prelude, pseudoOnly: false }, issues);
    if (kept) out.push(frames[i].prelude + '{' + kept + '}');
  }
  if (!out.length) return '';
  return prelude + '{' + out.join('') + '}';
}

/**
 * 把皮肤的自由 CSS 收敛为"只影响观感、只作用于 #stage 内部"的安全片段。
 * @returns {{ css: string, issues: Array<{type:string, selector:string, detail:string}> }}
 */
export function sanitizeSkinCss(raw) {
  const issues = [];
  if (raw == null || raw === '') return { css: '', issues: issues };
  if (typeof raw !== 'string') {
    issues.push({ type: 'type', selector: '', detail: 'extraCss 必须是字符串' });
    return { css: '', issues: issues };
  }
  let css = raw;
  if (css.length > MAX_LENGTH) {
    issues.push({ type: 'too-long', selector: '', detail: css.length + ' > ' + MAX_LENGTH });
    css = css.slice(0, MAX_LENGTH);
  }
  css = stripComments(css);
  // 提前闭合 <style> / 模板字面量注入的防护（生成器把结果拼进模板字符串）
  if (/<\/?\s*style/i.test(css) || css.indexOf('</') >= 0) {
    issues.push({ type: 'markup', selector: '', detail: '不允许出现标签' });
    css = css.replace(/<\/?[^>]*>/g, '');
  }
  if (css.indexOf('`') >= 0 || css.indexOf('${') >= 0) {
    issues.push({ type: 'markup', selector: '', detail: '不允许出现反引号或 ${' });
    css = css.split('`').join('').split('${').join('');
  }

  // 无花括号的语句型 at-rule（@import / @charset / @namespace）先剔除,
  // 否则会被当成后一条规则的选择器, 连累那条规则一起丢
  css = css.replace(/@(import|charset|namespace)[^;{}]*;/gi, function (m) {
    issues.push({ type: 'at-rule', selector: m.trim(), detail: m.trim().split(/\s/)[0] });
    return '';
  });

  const blocks = splitBlocks(css);
  const out = [];
  for (let i = 0; i < blocks.length; i++) {
    const prelude = blocks[i].prelude;
    if (prelude.indexOf('@') === 0) {
      const name = (/^@([a-z-]+)/i.exec(prelude) || [])[1];
      const at = (name || '').toLowerCase();
      if (at === 'media' || at === 'supports' || at === 'layer') {
        const inner = splitBlocks(blocks[i].body);
        const innerOut = [];
        for (let j = 0; j < inner.length; j++) {
          const r = processStyleRule(inner[j].prelude, inner[j].body, issues);
          if (r) innerOut.push(r);
        }
        if (innerOut.length) out.push(prelude + '{' + innerOut.join('') + '}');
        continue;
      }
      if (at === 'keyframes' || at === '-webkit-keyframes') {
        const r = processKeyframes(prelude, blocks[i].body, issues);
        if (r) out.push(r);
        continue;
      }
      issues.push({ type: 'at-rule', selector: prelude, detail: '@' + at + ' 不支持' });
      continue;
    }
    const rule = processStyleRule(prelude, blocks[i].body, issues);
    if (rule) out.push(rule);
  }
  return { css: out.join('\n'), issues: issues };
}

const ISSUE_HINT = {
  geometry: '影响盒子尺寸/位置的属性只能通过第一层结构 token 调整',
  typography: '字号/行高/字距会被布局引擎量测，请改 typeNode/typeSmall',
  'reserved-var': '第一层 token 的 CSS 变量请在 metrics 里改，取值会被校验',
  selector: '该选择器属于编辑器浮层或结构根节点，不随皮肤走',
  'external-url': '生成的 HTML 需离线可用，只允许 data: 内联资源',
  'at-rule': '仅支持 @media / @supports / @layer / @keyframes',
  markup: 'extraCss 只能是 CSS',
  'too-long': 'extraCss 超长已截断',
  malformed: '声明缺少冒号，已忽略',
  type: 'extraCss 必须是字符串',
};

// 把 issues 汇总成给人看的一行行提示（构建期打 WARN、运行时打 console.warn）
export function describeSkinCssIssues(issues) {
  const out = [];
  for (let i = 0; i < issues.length; i++) {
    const it = issues[i];
    const where = it.selector ? ' [' + it.selector + ']' : '';
    out.push('extraCss' + where + ' 丢弃 ' + (it.detail || it.type) + ' —— ' + (ISSUE_HINT[it.type] || it.type));
  }
  return out;
}
