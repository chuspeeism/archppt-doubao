// svg-path.mjs [INLINE]
// SVG 图形 → 归一化子路径，供 PPTX 的 a:custGeom 直接落笔。
//
// 为什么要做这件事：图标是 SVG（simple-icons 的单条填充 path，lucide 的描边元素组）。
// 想让 PPTX 里是**真形状**而不是贴图，就得把 SVG 的路径语法翻成 DrawingML 认识的
// moveTo / lnTo / quadBezTo / cubicBezTo / close。SVG 有的、DrawingML 没有的只有两样：
//   1. 圆弧 A/a —— 用端点参数化解出圆心，再按 ≤90° 切段近似成三次贝塞尔（误差 < 万分之三）；
//   2. 平滑简写 S/T —— 展开成完整的 C/Q。
// 其余 H/V/相对指令都在解析时化成绝对坐标，出口只剩 M/L/Q/C/Z 五种。
//
// 导出名：svgPathToSubpaths / svgMarkupToShapes / SVGP_KAPPA

export const SVGP_KAPPA = 0.5522847498307936;

const svgpNum = /[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/g;

// 逐字符扫描，不做「先切成 token 数组」那一步。两个坑逼着必须这么写：
//   1. 圆弧的两个 flag 允许不带分隔符地黏在后面（`a1 1 0 011 1` 里的 `011`
//      是 large=0 / sweep=1 / x=1）。按数字切会读成 11，整条路径从此错位。
//   2. 指令字母和数字之间也允许不带分隔符（`h-4.5v3`）。按数组消费时，
//      一旦某条指令的参数个数与实际不符，就会把下一个指令字母当数字吃进去，
//      算出来是 NaN 或 "18.695h" 这种字符串。**一个 NaN 坐标能让 PowerPoint
//      放弃渲染它之后的所有形状**，整页只画一半 —— 这就是当初 14 个技术图标
//      连带半张图消失的原因。
const svgpScanner = (src) => {
  const s = String(src == null ? '' : src);
  let i = 0;
  const isWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === ',';
  const skipWs = () => { while (i < s.length && isWs(s[i])) i += 1; };
  const atEnd = () => { skipWs(); return i >= s.length; };
  const peekCommand = () => {
    skipWs();
    const c = s[i];
    return c && 'MmLlHhVvCcSsQqTtAaZz'.indexOf(c) >= 0 ? c : null;
  };
  const takeCommand = () => { const c = peekCommand(); if (c) i += 1; return c; };
  const hasNumber = () => {
    skipWs();
    const c = s[i];
    if (!c) return false;
    if (c === '+' || c === '-' || c === '.') return true;
    return c >= '0' && c <= '9';
  };
  const readNumber = () => {
    skipWs();
    const start = i;
    if (s[i] === '+' || s[i] === '-') i += 1;
    while (i < s.length && s[i] >= '0' && s[i] <= '9') i += 1;
    if (s[i] === '.') {
      i += 1;
      while (i < s.length && s[i] >= '0' && s[i] <= '9') i += 1;
    }
    if (s[i] === 'e' || s[i] === 'E') {
      const save = i;
      i += 1;
      if (s[i] === '+' || s[i] === '-') i += 1;
      let digits = 0;
      while (i < s.length && s[i] >= '0' && s[i] <= '9') { i += 1; digits += 1; }
      if (!digits) i = save;
    }
    if (i === start) return NaN;
    const v = parseFloat(s.slice(start, i));
    return Number.isFinite(v) ? v : NaN;
  };
  // 圆弧 flag 只吃一个字符的 0/1
  const readFlag = () => {
    skipWs();
    const c = s[i];
    if (c === '0' || c === '1') { i += 1; return c === '1' ? 1 : 0; }
    return NaN;
  };
  return { atEnd, peekCommand, takeCommand, hasNumber, number: readNumber, flag: readFlag };
};

// 端点参数化圆弧 → 一串三次贝塞尔控制点。算法同 SVG 1.1 附录 F.6。
const svgpArcToCubics = (x1, y1, rx0, ry0, rot, large, sweep, x2, y2) => {
  if (x1 === x2 && y1 === y2) return [];
  let rx = Math.abs(rx0);
  let ry = Math.abs(ry0);
  if (rx === 0 || ry === 0) return [[x1, y1, x2, y2, x2, y2]];
  const phi = (rot * Math.PI) / 180;
  const cosP = Math.cos(phi);
  const sinP = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cosP * dx + sinP * dy;
  const y1p = -sinP * dx + cosP * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  const sign = large === sweep ? -1 : 1;
  const numer = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const denom = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const co = sign * Math.sqrt(Math.max(0, numer / denom));
  const cxp = (co * rx * y1p) / ry;
  const cyp = (-co * ry * x1p) / rx;
  const cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2;
  const cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => {
    const dot = ux * vx + uy * vy;
    const len = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy)) || 1;
    let a = Math.acos(Math.max(-1, Math.min(1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const theta1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dTheta = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
  if (sweep && dTheta < 0) dTheta += 2 * Math.PI;

  const segs = Math.max(1, Math.ceil(Math.abs(dTheta) / (Math.PI / 2)));
  const step = dTheta / segs;
  const alpha = (4 / 3) * Math.tan(step / 4);
  const out = [];
  let t = theta1;
  let px = x1;
  let py = y1;
  for (let i = 0; i < segs; i += 1) {
    const t2 = t + step;
    const cosT = Math.cos(t);
    const sinT = Math.sin(t);
    const cosT2 = Math.cos(t2);
    const sinT2 = Math.sin(t2);
    // 端点与切向量都要转回旋转后的坐标系
    const ex = cx + rx * cosT2 * cosP - ry * sinT2 * sinP;
    const ey = cy + rx * cosT2 * sinP + ry * sinT2 * cosP;
    const d1x = -rx * sinT * cosP - ry * cosT * sinP;
    const d1y = -rx * sinT * sinP + ry * cosT * cosP;
    const d2x = -rx * sinT2 * cosP - ry * cosT2 * sinP;
    const d2y = -rx * sinT2 * sinP + ry * cosT2 * cosP;
    out.push([px + alpha * d1x, py + alpha * d1y, ex - alpha * d2x, ey - alpha * d2y, ex, ey]);
    px = ex;
    py = ey;
    t = t2;
  }
  return out;
};

/**
 * SVG path data → 子路径数组。
 * 每条子路径 = { closed, ops: [ {t:'M'|'L'|'Q'|'C', p:[...] } ] }，坐标全为绝对值。
 * 任何一步解析不出有限数就当场收手，把已解析的部分返回 —— 宁可少画一个图标，
 * 也不能让 NaN 流进 DrawingML。
 */
export function svgPathToSubpaths(d) {
  const sc = svgpScanner(d);
  const subs = [];
  let cur = null;
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let prevCx = null;
  let prevCy = null;
  let prevQx = null;
  let prevQy = null;
  let cmd = '';
  let bail = false;

  const open = () => { cur = { closed: false, ops: [] }; subs.push(cur); };
  const ensure = () => { if (!cur) { open(); cur.ops.push({ t: 'M', p: [x, y] }); startX = x; startY = y; } };
  const fin = (...vals) => vals.every((v) => Number.isFinite(v));

  while (!bail && !sc.atEnd()) {
    const next = sc.peekCommand();
    if (next) {
      cmd = sc.takeCommand();
      if (cmd === 'Z' || cmd === 'z') {
        if (cur) { cur.closed = true; x = startX; y = startY; }
        cur = null;
        prevCx = prevCy = prevQx = prevQy = null;
        continue;
      }
    } else if (!cmd) {
      break;   // 开头就不是指令，放弃
    }
    if (!sc.hasNumber()) { if (!next) break; continue; }

    const rel = cmd >= 'a' && cmd <= 'z';
    const C = cmd.toUpperCase();

    if (C === 'M') {
      const nx = sc.number();
      const ny = sc.number();
      if (!fin(nx, ny)) { bail = true; break; }
      x = rel ? x + nx : nx;
      y = rel ? y + ny : ny;
      startX = x; startY = y;
      open();
      cur.ops.push({ t: 'M', p: [x, y] });
      cmd = rel ? 'l' : 'L';   // M 之后的隐式重复是 L
      prevCx = prevCy = prevQx = prevQy = null;
      continue;
    }

    ensure();

    if (C === 'L') {
      const nx = sc.number();
      const ny = sc.number();
      if (!fin(nx, ny)) { bail = true; break; }
      x = rel ? x + nx : nx;
      y = rel ? y + ny : ny;
      cur.ops.push({ t: 'L', p: [x, y] });
      prevCx = prevCy = prevQx = prevQy = null;
    } else if (C === 'H') {
      const nx = sc.number();
      if (!fin(nx)) { bail = true; break; }
      x = rel ? x + nx : nx;
      cur.ops.push({ t: 'L', p: [x, y] });
      prevCx = prevCy = prevQx = prevQy = null;
    } else if (C === 'V') {
      const ny = sc.number();
      if (!fin(ny)) { bail = true; break; }
      y = rel ? y + ny : ny;
      cur.ops.push({ t: 'L', p: [x, y] });
      prevCx = prevCy = prevQx = prevQy = null;
    } else if (C === 'C' || C === 'S') {
      let c1x;
      let c1y;
      if (C === 'C') {
        const ax = sc.number();
        const ay = sc.number();
        if (!fin(ax, ay)) { bail = true; break; }
        c1x = rel ? x + ax : ax;
        c1y = rel ? y + ay : ay;
      } else {
        c1x = prevCx == null ? x : 2 * x - prevCx;
        c1y = prevCy == null ? y : 2 * y - prevCy;
      }
      const bx = sc.number();
      const by = sc.number();
      const ex0 = sc.number();
      const ey0 = sc.number();
      if (!fin(bx, by, ex0, ey0)) { bail = true; break; }
      const c2x = rel ? x + bx : bx;
      const c2y = rel ? y + by : by;
      const ex = rel ? x + ex0 : ex0;
      const ey = rel ? y + ey0 : ey0;
      cur.ops.push({ t: 'C', p: [c1x, c1y, c2x, c2y, ex, ey] });
      prevCx = c2x; prevCy = c2y;
      prevQx = prevQy = null;
      x = ex; y = ey;
    } else if (C === 'Q' || C === 'T') {
      let qx;
      let qy;
      if (C === 'Q') {
        const ax = sc.number();
        const ay = sc.number();
        if (!fin(ax, ay)) { bail = true; break; }
        qx = rel ? x + ax : ax;
        qy = rel ? y + ay : ay;
      } else {
        qx = prevQx == null ? x : 2 * x - prevQx;
        qy = prevQy == null ? y : 2 * y - prevQy;
      }
      const ex0 = sc.number();
      const ey0 = sc.number();
      if (!fin(ex0, ey0)) { bail = true; break; }
      const ex = rel ? x + ex0 : ex0;
      const ey = rel ? y + ey0 : ey0;
      cur.ops.push({ t: 'Q', p: [qx, qy, ex, ey] });
      prevQx = qx; prevQy = qy;
      prevCx = prevCy = null;
      x = ex; y = ey;
    } else if (C === 'A') {
      const rx = sc.number();
      const ry = sc.number();
      const rot = sc.number();
      const large = sc.flag();
      const sweep = sc.flag();
      const ex0 = sc.number();
      const ey0 = sc.number();
      if (!fin(rx, ry, rot, large, sweep, ex0, ey0)) { bail = true; break; }
      const ex = rel ? x + ex0 : ex0;
      const ey = rel ? y + ey0 : ey0;
      const cubics = svgpArcToCubics(x, y, rx, ry, rot, large, sweep, ex, ey);
      let ok = true;
      for (const c of cubics) {
        if (!c.every((v) => Number.isFinite(v))) { ok = false; break; }
        cur.ops.push({ t: 'C', p: c });
      }
      if (!ok) { bail = true; break; }
      if (!cubics.length) cur.ops.push({ t: 'L', p: [ex, ey] });
      prevCx = prevCy = prevQx = prevQy = null;
      x = ex; y = ey;
    } else {
      break;
    }
  }
  return subs.filter((sp) => sp.ops.length > 1 || sp.closed);
}

// 一次把标签上的属性解析成表。用静态正则而不是按名字拼 new RegExp：
// 既省得每个属性重编译一次，也避开页面侧「悬空引用」检查把 RegExp 记成未声明标识符。
const SVGP_ATTR_RE = /([A-Za-z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const svgpAttrs = (raw) => {
  const map = {};
  SVGP_ATTR_RE.lastIndex = 0;
  let m = SVGP_ATTR_RE.exec(raw);
  while (m) {
    map[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3];
    m = SVGP_ATTR_RE.exec(raw);
  }
  return map;
};
const svgpAttr = (attrs, name) => (Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null);
const svgpN = (attrs, name, dflt) => {
  const v = svgpAttr(attrs, name);
  const n = v == null ? NaN : parseFloat(v);
  return Number.isFinite(n) ? n : dflt;
};

const svgpEllipsePath = (cx, cy, rx, ry) => {
  const k = SVGP_KAPPA;
  return [{
    closed: true,
    ops: [
      { t: 'M', p: [cx + rx, cy] },
      { t: 'C', p: [cx + rx, cy + ry * k, cx + rx * k, cy + ry, cx, cy + ry] },
      { t: 'C', p: [cx - rx * k, cy + ry, cx - rx, cy + ry * k, cx - rx, cy] },
      { t: 'C', p: [cx - rx, cy - ry * k, cx - rx * k, cy - ry, cx, cy - ry] },
      { t: 'C', p: [cx + rx * k, cy - ry, cx + rx, cy - ry * k, cx + rx, cy] },
    ],
  }];
};

const svgpRectPath = (x, y, w, h, rx, ry) => {
  if (!(rx > 0) && !(ry > 0)) {
    return [{
      closed: true,
      ops: [
        { t: 'M', p: [x, y] }, { t: 'L', p: [x + w, y] },
        { t: 'L', p: [x + w, y + h] }, { t: 'L', p: [x, y + h] },
      ],
    }];
  }
  const a = Math.min(rx > 0 ? rx : ry, w / 2);
  const b = Math.min(ry > 0 ? ry : rx, h / 2);
  const k = SVGP_KAPPA;
  return [{
    closed: true,
    ops: [
      { t: 'M', p: [x + a, y] },
      { t: 'L', p: [x + w - a, y] },
      { t: 'C', p: [x + w - a + a * k, y, x + w, y + b - b * k, x + w, y + b] },
      { t: 'L', p: [x + w, y + h - b] },
      { t: 'C', p: [x + w, y + h - b + b * k, x + w - a + a * k, y + h, x + w - a, y + h] },
      { t: 'L', p: [x + a, y + h] },
      { t: 'C', p: [x + a - a * k, y + h, x, y + h - b + b * k, x, y + h - b] },
      { t: 'L', p: [x, y + b] },
      { t: 'C', p: [x, y + b - b * k, x + a - a * k, y, x + a, y] },
    ],
  }];
};

const svgpPointsPath = (points, closed) => {
  const nums = String(points || '').match(svgpNum);
  if (!nums || nums.length < 4) return [];
  const ops = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    ops.push({ t: i === 0 ? 'M' : 'L', p: [Number(nums[i]), Number(nums[i + 1])] });
  }
  return [{ closed: !!closed, ops }];
};

/**
 * 一段 SVG 内部标记（不含外层 <svg>）→ 形状数组。
 * 每个形状 = { subpaths, fill, stroke, strokeWidth, cap, join }，属性沿祖先 <g> 继承。
 * 只认图标数据里实际出现的元素：g / path / circle / ellipse / rect / line / polyline / polygon。
 */
export function svgMarkupToShapes(markup, inherited) {
  const src = String(markup == null ? '' : markup);
  const out = [];
  const stack = [Object.assign({
    fill: 'none', stroke: null, strokeWidth: 1, cap: 'butt', join: 'miter',
  }, inherited || {})];
  const re = /<\s*(\/?)\s*([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)(\/?)>/g;
  let m = re.exec(src);
  while (m) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const attrs = svgpAttrs(m[3] || '');
    const selfClose = m[4] === '/';
    const top = stack[stack.length - 1];

    if (closing) {
      if (stack.length > 1) stack.pop();
      m = re.exec(src);
      continue;
    }

    const style = {
      fill: svgpAttr(attrs, 'fill') || top.fill,
      stroke: svgpAttr(attrs, 'stroke') || top.stroke,
      strokeWidth: svgpN(attrs, 'stroke-width', top.strokeWidth),
      cap: svgpAttr(attrs, 'stroke-linecap') || top.cap,
      join: svgpAttr(attrs, 'stroke-linejoin') || top.join,
    };

    if (tag === 'g') {
      if (!selfClose) stack.push(style);
      m = re.exec(src);
      continue;
    }

    let subpaths = null;
    if (tag === 'path') subpaths = svgPathToSubpaths(svgpAttr(attrs, 'd') || '');
    else if (tag === 'circle') {
      const r = svgpN(attrs, 'r', 0);
      subpaths = r > 0 ? svgpEllipsePath(svgpN(attrs, 'cx', 0), svgpN(attrs, 'cy', 0), r, r) : [];
    } else if (tag === 'ellipse') {
      subpaths = svgpEllipsePath(svgpN(attrs, 'cx', 0), svgpN(attrs, 'cy', 0),
        svgpN(attrs, 'rx', 0), svgpN(attrs, 'ry', 0));
    } else if (tag === 'rect') {
      subpaths = svgpRectPath(svgpN(attrs, 'x', 0), svgpN(attrs, 'y', 0),
        svgpN(attrs, 'width', 0), svgpN(attrs, 'height', 0),
        svgpN(attrs, 'rx', 0), svgpN(attrs, 'ry', 0));
    } else if (tag === 'line') {
      subpaths = [{
        closed: false,
        ops: [
          { t: 'M', p: [svgpN(attrs, 'x1', 0), svgpN(attrs, 'y1', 0)] },
          { t: 'L', p: [svgpN(attrs, 'x2', 0), svgpN(attrs, 'y2', 0)] },
        ],
      }];
    } else if (tag === 'polyline') subpaths = svgpPointsPath(svgpAttr(attrs, 'points'), false);
    else if (tag === 'polygon') subpaths = svgpPointsPath(svgpAttr(attrs, 'points'), true);

    if (subpaths && subpaths.length) out.push({ subpaths, ...style });
    m = re.exec(src);
  }
  return out;
}
