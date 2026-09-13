// lib/edge-router.mjs [INLINE] —— 正交连线布线器 (P0: 通道模型 + 统一端口分配 + 轨道分配)
//
// 设计要点（对应"线条重合"根因 R1/R2/R4/R6）:
//   1. 通道模型: 由节点矩形推出行间/列间的空闲带(band), 中段坐标只能落在带内的"轨道"上,
//      不再由 (a.y+b.y)/2 直接算出 —— 消除"同行对之间的边坐标恒等"这一必然重合。
//   2. 统一端口分配: 端口按"通道 + 同列/同行节点组"整体分配槽位, 源侧与目标侧共用一个
//      槽位阶梯, 对称展开, 轴对齐边独占中心槽以保直线 —— 消除"源/目标计数器各自从 0 起"的撞车。
//   3. 轨道分配: 同一条带内, 投影区间重叠的中段必须占不同轨道(区间图染色, 按左端点贪心即最优);
//      轨道次序由"引脚穿越投票"决定, 压低引脚与中段的交叉数。
//   4. 全局两阶段: 先定端口与形状, 再统一定坐标 —— 不再是"先布的边永不让位"的单遍贪心。
//   5. 终局评估 + 违规重选(阶段 F): 选面打分用的是"中心端口 + 临时形状", 端口全局分配与
//      轨道落位之后的最终几何可能出现选面时预料不到的穿节点/穿容器/边边交叉。对最终几何
//      按 quality-checker 同口径评估违规, 只对卷入违规的边做"重选面 × 重选带"的确定性
//      迭代, 每步全量重跑 B–E 再评估, 有改善才采纳 —— 消灭的是"贪心选面的既成事实"。
//   6. 端口次序按"嵌套 / 交错"分类排(erPortRank): 同一条边界上并排引出的多条边, 谁该占
//      上游端口取决于它在带里是"U 形"还是"穿越形", 两类的正确次序恰好相反。排反了会凭空
//      多出一处交叉, 而且轨道怎么调都消不掉 —— 这是选面和轨道分配都够不着的一层。
//   7. 阶梯形(4 段绕行): L 的两个拐点都被挡死时, 沿图外圈绕过去。老走线器只有 L 与 Z,
//      被整排节点 + 通栏容器夹住的边只能硬穿, 阶段 F 换多少次面都无解。它受 stairBudget
//      约束: 躲硬穿随时可用, 只为躲边边交叉的全图限额。
//   8. 束线(第 10 步, 2026-08-18 第二轮日志): 同一个节点同一面同方向的 ≥2 条 Z 形 / 直线边,
//      端口一律收到这一面的正中 —— "三线合一"。这是第 6 步"共享起点"的推广: 不再只认聚合点、
//      不再只认出边、不再要求 ≥3。合并只动端口, 不强并轨道: 枢纽居中时两侧的中段区间天然
//      不重叠, 自己就落到同一条轨道上(15 号的梳齿)。一束一试, 仍由终局评估按"违规逐项不劣化"
//      决定采不采。调用方(arch-doc 的 autoLayout)只在规整定稿那一步开它, 并把收拢过的端口
//      写成 spec 里的端口声明 —— 渲染永远按声明走, 走线器不会在用户不知情时擅自并线。
//
// 约束: 本文件会被 generate.mjs 内联进生成的 HTML(import 行会被剥离), 因此不得 import 其它模块。
// 评估口径的阈值(sharedPortRadius / collinearGap / edgeNodeInset / detourRatio 等)与
// lib/quality-checker.mjs 的 QUALITY_RULES 同源 —— 这里的默认值只是脱离调用方单独使用时的
// 兜底, 生成器与工作台都应把 QUALITY_RULES 里的对应值经 options 传入, 不要在两处各改各的。

export const ROUTER_DEFAULTS = Object.freeze({
  stub: 18,             // 端口最小引出长度(轨道距节点边的下限即由 bandMargin 保证)
  portPitch: 24,        // 同组端口的期望间距
  portMinPitch: 10,     // 端口间距下限(节点太窄时压缩到此值)
  portInset: 12,        // 端口距节点角的最小距离
  // 同一条带内相邻轨道的期望间距。下限不是美观取的, 是"一行边标签塞得进去": 相邻两条
  // 轨道之间的净空就是标签唯一能落脚的缝, 而标签只能沿自己那条折线滑动(工作台的
  // relaxEdgeLabels 不做横向让位)。默认皮肤的边标签行高 24px, 缝比它窄一点点, 标签
  // 就只能压在邻线上 —— case-08 的「MQTT / 上云」压住「视频流」就是 22 差 2px 差出来的。
  trackPitch: 26,
  trackMinPitch: 12,    // 轨道间距下限(带太窄时退让到此值)
  bandMargin: 16,       // 轨道距条带边界(即节点边)的最小距离
  outerBand: 140,       // 首行之上/末行之下的虚拟外侧条带厚度
  groupTol: 24,         // 同列(行)归组容差: 中心坐标差小于该值视为同列
  alignTol: 6,          // 轴对齐判定容差
  obstaclePad: 8,       // 避障时节点外扩量
  bendPenalty: 90,      // 转折惩罚基准(选面阶段线性计费; 终局评估按 erBendCost 凹函数计费)
  // 选面阶段的同面拥挤惩罚, **线性**计费: 这一面上已有 n 条时, 再加一条罚 penalty * n。
  //
  // 曾经是累进(n*(n+1)/2)且取 90, 与 bendPenalty 同量级 —— 那是把"一边一面"当成了
  // 优化目标。2026-08-16 按判别力实测降级: 人工终稿 vs autoLayout 在这一项上是
  // **2 : 1 持平 5**(八份里五份完全打平), 人机无差别, 学它没有依据。
  // 它还与第 6 步的"共享起点"方向相反 —— case-02 那三条决策边同起点是孙毅确认过的意图,
  // 累进的分面罚会把它们强行拆到不同面上去。
  //
  // 取 12 是让它退回"只打破平局": 选面得分里最小的真冲突代价是 bendPenalty(90),
  // 12 * n 在 n 小于 7 时都买不动一个折点, 也压不过 12px 以上的路径长度差。
  // 即: 两个面在几何上几乎一样好时才分面, 一旦另一面要多绕, 就老实堆在同一面。
  sideLoadPenalty: 12,
  blockPenalty: 4000,   // 选面阶段每穿过一个节点的惩罚(远大于任何路径长度, 等价于硬约束)
  minSep: 12,           // 判定"视觉合并"的最小平行间距
  bounds: null,         // 画布边界 {x,y,w,h}: 外圈虚拟带被钳在边界内, 绕行不越出画布
  boundsPad: 8,         // 钳制时距边界的留白
  // ---- 箭头前端净空 ----
  // 首/末直线段的最短长度, 弯折不许顶到箭头跟前。像素量纲, 由调用方按箭头长度
  // (edge-weight 的 headLen, 随整图几何系数缩放)传入; 0 = 关闭。
  minLastSeg: 0,
  // ---- 阶段 F: 终局评估与违规重选 ----
  refinePasses: 2,      // 违规边重选的最大轮数(0=关闭, 热路径可关)
  refineBands: 3,       // 重选时每个同轴面组合额外尝试的候选带数
  sharedOrigin: true,   // 聚合点扇出时, 额外试一版"多条边收拢到同一个起点"(准则 3 的路由面)
  sharedOriginIds: null, // 允许收拢的节点 id 集合; null = 一个都不收(安全默认), 由 arch-doc 传聚合点
  // 束线(设计要点 8): 同节点同面同方向的 ≥ bundleMin 条 Z 形 / 直线边收到该面正中。
  // 只认「两端同轴且朝向相对」的边: U 形(同面出入)与 L 形不收 —— 那两类靠端口次序避免交叉
  // (erPortRank), 收拢会把次序打乱, tests/edge-router-shapes 的 U 形断言就是盯这个的。
  // 默认**关**(与 sharedOriginIds:null 一样走安全默认): 只有 arch-doc 的 materializeBundles
  // 在规整定稿那一步显式打开; 并线结果落成端口声明后, 任何调用方(含 generate 内联到页面里的
  // 运行时)按声明走线就能复现, 不需要也不该自己再并一次。
  bundle: false,
  bundleMin: 2,          // 第二轮日志: 05 号两条边并成一股、11 号三线合一, 2 条就并
  stairBudget: 1,       // "只为躲边边交叉"而绕外圈(阶梯形)的线条数上限; 躲硬穿不受限
  // 评估权重: 相对比例对齐 QUALITY_RULES 的扣分权重(medium:low = 4:1),
  // 绝对数值远大于路径长度, 保证"消一处违规"永远优先于"省一段线"。
  crossPenalty: 1200,         // 边×边交叉(QC crossing/medium)
  nodeCrossPenalty: 4000,     // 边穿非端点节点(QC crossing/medium, 视觉上不可接受, 加倍重罚)
  containerCrossPenalty: 1200,// 边穿非端点容器(QC crossing/medium)
  collinearPenalty: 1200,     // 无共享端点的边共线重叠(QC overlap/medium)
  detourPenalty: 300,         // 绕行超标 / 弯折超上限(QC low)
  lastSegPenalty: 150,        // 弯折贴箭头(美学项, 低于任何 QC 违规)
  // 走线净空: 中段与"非端点盒"平行贴行时的最小净空。QC 只判"穿没穿过", 不判"离多远",
  // 于是同样两条候选带, 贴着容器顶边 2px 擦过去的那条因为短一点就赢了。手调日志里
  // 人一律把这种长跨线抬开(case-05 顶跨 segShifts -62: 距容器顶 2px → 64px)。
  // clearMin 取 10 而不是 bandMargin(16): 两张卡之间 24px 的合法通道走中线是 12px,
  // 定 16 会把正常穿通道也罚上, 定 10 只罚"贴边擦过去"。
  clearMin: 10,
  clearPenalty: 220,          // 贴边代价: 高于 lastSegPenalty(美学项), 低于任何 QC 违规
  nearParallelPenalty: 250,   // 近距平行(间距 < minSep 的视觉合并, 老走线器的既有目标, QC 不计分)
  lengthWeight: 0.2,          // 终局评估里路径长度的权重: QC 不给长度扣分, 长度只作
                              // 次级取舍——用一段绕行换掉一处交叉/穿越永远是划算的
  // 背面穿出: erPickBand 兜底可能把中段放到端口的"背面", 线会纵穿自己的源/目标卡。
  // QC 豁免端点节点所以打分看不见, 但视觉上等同穿节点 —— 评估时同罚。
  // ---- 与 QUALITY_RULES 同源的评估阈值(调用方应传入, 见文件头注释) ----
  maxBends: 3,
  sharedPortRadius: 30,
  collinearGap: 3,
  collinearMinOverlap: 40,
  edgeNodeInset: 2,
  detourRatio: 1.8,
  detourMinLength: 120,
});

const ER_SIDES = ['top', 'bottom', 'left', 'right'];
const ER_OUT = { top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
const ER_OPPOSITE = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
const erIsVSide = (side) => side === 'top' || side === 'bottom';
const erClamp = (v, lo, hi) => (lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v)));

/* ---------- 手调端点(吸附锚点) ----------
   端点可以被钉在节点四周的固定档位上: 每条边 5 档(1/6 … 5/6), 四条边共 20 档。
   不取 0 与 1 两档: 端点落在角上时引出段贴着相邻边走, 看不出来到底接在哪条边上。
   钉住之后这条边不再参与选面与端口分配, 也不参与阶段 F 的违规重选 —— 手调优先,
   引擎不跟用户抢。「引出段垂直于所接的那条边」对手调端点同样成立。 */
export const EDGE_PORT_SIDES = Object.freeze(ER_SIDES.slice());
export const EDGE_PORT_SNAPS = Object.freeze([1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6]);

export function isEdgePort(port) {
  return !!port && ER_SIDES.indexOf(port.side) >= 0
    && Number.isFinite(port.t) && port.t >= 0 && port.t <= 1;
}

// 端口沿边的自由轴坐标（竖直边取 x, 水平边取 y）
const erPortCoord = (rect, port) => (erIsVSide(port.side)
  ? rect.x + rect.w * port.t
  : rect.y + rect.h * port.t);

export function edgePortPoint(rect, port) {
  const p = isEdgePort(port) ? port : { side: 'right', t: 0.5 };
  return erPortPoint(rect, p.side, erPortCoord(rect, p));
}

export function edgePortAnchors(rect) {
  const out = [];
  for (const side of ER_SIDES) {
    for (const t of EDGE_PORT_SNAPS) {
      const p = edgePortPoint(rect, { side, t });
      out.push({ side, t, x: p.x, y: p.y });
    }
  }
  return out;
}

// 拖动端点时用: 找离指针最近的那一档
export function snapEdgePort(rect, point) {
  let best = null;
  for (const a of edgePortAnchors(rect)) {
    const d = (a.x - point.x) * (a.x - point.x) + (a.y - point.y) * (a.y - point.y);
    if (!best || d < best.d) best = { d, side: a.side, t: a.t };
  }
  return best ? { side: best.side, t: best.t } : { side: 'right', t: 0.5 };
}

/* 手调中间段。
   「中间段」= 除首段与末段之外的每一段: 三折线有 1 段可调, 四折线有 2 段, 以此类推。
   段是横的就上下挪、是竖的就左右挪; 挪一段, 它前后两段的长度随之一长一短, 别的段不动
   （正交折线里相邻两段必然互相垂直, 所以平移一段只改这两段的长度, 不会把折线拧歪）。
   钳位只有一条规则: 前后两段都不许缩到 minLeg 以下, 也不许反向。反向就是折回自身;
   而首段 / 末段一旦反向或缩没, 就等于沿着节点边滑出去 —— 「引出段垂直于所接的边」
   这条规则正是靠这一条钳位在手调时继续成立。
   shifts 缺项或为 0 时该段原样不动(几何逐比特不变), 返回的是钳完的实际位移。 */
export function applyEdgeSegShifts(pts, shifts, options) {
  return erApplySegShifts(pts, shifts, Object.assign({}, ROUTER_DEFAULTS, options || {}));
}

function erApplySegShifts(pts, wanted, opt) {
  const inner = Math.max(0, pts.length - 3);   // 可调的中间段数 = 段数 - 2
  const out = pts.map((p) => ({ x: p.x, y: p.y }));
  const shifts = [];
  const want = Array.isArray(wanted) ? wanted : [];
  const minLeg = Math.max(6, opt.stub / 2);
  for (let k = 0; k < inner; k += 1) {
    shifts.push(0);
    const d = Number(want[k]);
    if (!Number.isFinite(d) || !d) continue;
    const i = k + 1;                                              // 中间段从第 2 段(下标 1)起
    const ax = Math.abs(out[i].y - out[i + 1].y) < 0.6 ? 'y' : 'x'; // 横段上下挪, 竖段左右挪
    const c = out[i][ax];
    let lo = -Infinity;
    let hi = Infinity;
    // out[i-1] 与 out[i+2] 分别是前一段、后一段的另一头: 它们在 ax 上的坐标就是这两段的长度基准
    [out[i - 1][ax], out[i + 2][ax]].forEach((nb) => {
      if (Math.abs(nb - c) < 0.5) return;                          // 已经贴在一起, 不再由它定界
      if (nb > c) hi = Math.min(hi, nb - minLeg);
      else lo = Math.max(lo, nb + minLeg);
    });
    if (lo > hi) continue;                                         // 前后两段挤到一起, 这一段动不了
    const applied = Math.min(hi, Math.max(lo, c + d)) - c;
    out[i][ax] += applied;
    out[i + 1][ax] += applied;
    shifts[k] = Math.round(applied * 10) / 10;
  }
  return { pts: out, shifts };
}

// 自动几何的腿长合法性钳位: 每条中间段都钳进「前后两段 ≥ minLeg 且不反向」的范围。
// 轨道分配只管同带互不重叠, 不管引出腿还剩多长; 腿被压没时首段并进中段, 变成沿着
// 节点边走 —— 垂直性当场失效。手调之前先保证自动线是合法的, Z/四折/阶梯统一走这一道。
function erClampInnerLegal(pts, opt) {
  const out = pts.map((p) => ({ x: p.x, y: p.y }));
  const minLeg = Math.max(6, opt.stub / 2);
  // 首段与末段除了"不许被压没", 还要吃箭头净空。轨道分配只保证轨道离**带边界**够远,
  // 而端口挂在容器边界上时带边界并不是端口(容器边常常落在带的内部) —— 差出来的那一截
  // 正是箭头前端被折点顶掉的量。case-10 的「审计」就是这么只剩 9px 引出腿的。
  const endLeg = Math.max(minLeg, opt.minLastSeg || 0);
  const tail = out.length - 1;
  for (let i = 1; i <= out.length - 3; i += 1) {
    const ax = Math.abs(out[i].y - out[i + 1].y) < 0.6 ? 'y' : 'x';
    const c = out[i][ax];
    let lo = -Infinity;
    let hi = Infinity;
    [[out[i - 1][ax], i === 1 ? endLeg : minLeg],
     [out[i + 2][ax], i + 2 === tail ? endLeg : minLeg]].forEach((pair) => {
      const nb = pair[0], m = pair[1];
      if (Math.abs(nb - c) < 0.5) return;
      if (nb > c) hi = Math.min(hi, nb - m);
      else lo = Math.max(lo, nb + m);
    });
    if (lo > hi) continue;
    const v = Math.min(hi, Math.max(lo, c));
    if (v === c) continue;
    out[i][ax] = v;
    out[i + 1][ax] = v;
  }
  return out;
}

// 首尾段是否垂直于各自所接的那条边。构建期自检与测试共用这一份判据。
export function edgeEndsPerpendicular(pts, sideA, sideB) {
  if (!pts || pts.length < 2) return false;
  const ok = (p, q, side) => (erIsVSide(side)
    ? Math.abs(p.x - q.x) < 0.6 && Math.abs(p.y - q.y) > 0.5
    : Math.abs(p.y - q.y) < 0.6 && Math.abs(p.x - q.x) > 0.5);
  return ok(pts[0], pts[1], sideA) && ok(pts[pts.length - 1], pts[pts.length - 2], sideB);
}

// 端口落在边上的第几档: 回给编辑器画手柄用(未手调时也有值, 即自动分配的那一档)
function erPortDescriptor(rect, side, coord) {
  const span = erIsVSide(side) ? rect.w : rect.h;
  const base = erIsVSide(side) ? rect.x : rect.y;
  const t = span > 0 ? (coord - base) / span : 0.5;
  return { side, t: Math.round(erClamp(t, 0, 1) * 1000) / 1000 };
}

const erToArray = (src) => {
  if (!src) return [];
  if (Array.isArray(src)) return src.filter((r) => r && Number.isFinite(r.x) && Number.isFinite(r.y));
  const out = [];
  src.forEach((r, id) => {
    if (r && Number.isFinite(r.x) && Number.isFinite(r.y)) out.push({ id: r.id != null ? r.id : id, x: r.x, y: r.y, w: r.w, h: r.h });
  });
  return out;
};

// 端口沿边的自由轴(竖直边=x, 水平边=y)
const erSideCenter = (r, side) => (erIsVSide(side) ? r.x + r.w / 2 : r.y + r.h / 2);
const erSideLo = (r, side) => (erIsVSide(side) ? r.x : r.y);
const erSideHi = (r, side) => (erIsVSide(side) ? r.x + r.w : r.y + r.h);
const erPortPoint = (r, side, coord) => {
  if (side === 'top') return { x: coord, y: r.y };
  if (side === 'bottom') return { x: coord, y: r.y + r.h };
  if (side === 'left') return { x: r.x, y: coord };
  return { x: r.x + r.w, y: coord };
};
// 端口所在边的固定轴坐标(竖直边=y, 水平边=x)
const erSideFixed = (r, side) => {
  if (side === 'top') return r.y;
  if (side === 'bottom') return r.y + r.h;
  if (side === 'left') return r.x;
  return r.x + r.w;
};

// ---------- 通道(空闲带)----------
// axis='y' 得到行与行之间的水平带(承载横向中段); axis='x' 得到列与列之间的垂直带。
// clampRange 存在时把首尾两条外圈虚拟带钳进边界(绕行不越出画布)。
function erFreeBands(rects, axis, outer, clampRange) {
  const iv = [];
  for (const r of rects) iv.push(axis === 'y' ? [r.y, r.y + r.h] : [r.x, r.x + r.w]);
  if (!iv.length) return [];
  iv.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const occ = [[iv[0][0], iv[0][1]]];
  for (let i = 1; i < iv.length; i += 1) {
    const cur = occ[occ.length - 1];
    if (iv[i][0] <= cur[1]) cur[1] = Math.max(cur[1], iv[i][1]);
    else occ.push([iv[i][0], iv[i][1]]);
  }
  const raw = [];
  raw.push({ lo: occ[0][0] - outer, hi: occ[0][0] });
  for (let i = 1; i < occ.length; i += 1) raw.push({ lo: occ[i - 1][1], hi: occ[i][0] });
  raw.push({ lo: occ[occ.length - 1][1], hi: occ[occ.length - 1][1] + outer });
  if (clampRange) {
    const first = raw[0];
    first.lo = Math.min(Math.max(first.lo, clampRange.lo), first.hi);
    const last = raw[raw.length - 1];
    last.hi = Math.max(Math.min(last.hi, clampRange.hi), last.lo);
  }
  return raw.map((b, i) => ({ index: i, lo: b.lo, hi: b.hi, center: (b.lo + b.hi) / 2, size: b.hi - b.lo, outermost: i === 0 || i === raw.length - 1 }));
}
const erBandAt = (bands, c) => bands.find((b) => c >= b.lo - 0.5 && c <= b.hi + 0.5) || null;
// 端口引脚所经过的带。叶节点的边界恰好是带边界; 容器边界可能落在带内部, 此时就是它所在的那条带。
const erBandOfPort = (bands, coord, dir) => {
  const here = erBandAt(bands, coord);
  if (here) return here;
  let best = null;
  for (const b of bands) {
    if (dir > 0 && b.lo >= coord - 0.5) { if (!best || b.lo < best.lo) best = b; }
    if (dir < 0 && b.hi <= coord + 0.5) { if (!best || b.hi > best.hi) best = b; }
  }
  return best;
};
// 位于 c1..c2 之间(允许部分相交)的带, 按与 prefer 的距离排序
const erBandsBetween = (bands, c1, c2, prefer) => {
  const lo = Math.min(c1, c2), hi = Math.max(c1, c2);
  return bands
    .filter((b) => b.hi > lo - 0.5 && b.lo < hi + 0.5)
    .sort((p, q) => Math.abs(p.center - prefer) - Math.abs(q.center - prefer) || (p.index - q.index));
};

// ---------- 几何工具 ----------
const erPathLen = (pts) => pts.slice(1).reduce((a, p, i) => a + Math.abs(p.x - pts[i].x) + Math.abs(p.y - pts[i].y), 0);
const erDedupe = (pts) => pts.filter((p, i) => !i || Math.abs(p.x - pts[i - 1].x) > 0.5 || Math.abs(p.y - pts[i - 1].y) > 0.5);
const erSpanOverlap = (a1, a2, b1, b2) => {
  const lo = Math.max(Math.min(a1, a2), Math.min(b1, b2));
  const hi = Math.min(Math.max(a1, a2), Math.max(b1, b2));
  return hi - lo;
};
// proper 交点: 交点严格位于两条线段内部(端点相接/共线不算)。口径同 geometry-utils 的
// segmentsIntersect —— 本模块禁止 import, 故此处以 er 前缀内联一份。
const erProperCross = (p1, p2, p3, p4) => {
  const d1x = p2.x - p1.x, d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x, d2y = p4.y - p3.y;
  const denom = d1x * d2y - d1y * d2x;
  if (denom === 0) return null;
  const eps = 1e-9;
  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
  const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / denom;
  if (t <= eps || t >= 1 - eps || u <= eps || u >= 1 - eps) return null;
  return { x: p1.x + t * d1x, y: p1.y + t * d1y };
};
// 线段是否进入矩形内部(贴边滑过/触角不算)。口径同 geometry-utils 的 segmentIntersectsRect。
const erSegEntersRect = (p1, p2, rect) => {
  if (!rect || rect.w <= 0 || rect.h <= 0) return false;
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const pArr = [-dx, dx, -dy, dy];
  const qArr = [p1.x - rect.x, rect.x + rect.w - p1.x, p1.y - rect.y, rect.y + rect.h - p1.y];
  let t0 = 0, t1 = 1;
  for (let i = 0; i < 4; i += 1) {
    if (pArr[i] === 0) {
      if (qArr[i] < 0) return false;
    } else {
      const ratio = qArr[i] / pArr[i];
      if (pArr[i] < 0) {
        if (ratio > t1) return false;
        if (ratio > t0) t0 = ratio;
      } else {
        if (ratio < t0) return false;
        if (ratio < t1) t1 = ratio;
      }
    }
  }
  const isPoint = dx === 0 && dy === 0;
  if (!isPoint && t1 <= t0) return false;
  const mx = p1.x + dx * ((t0 + t1) / 2);
  const my = p1.y + dy * ((t0 + t1) / 2);
  return mx > rect.x && mx < rect.x + rect.w && my > rect.y && my < rect.y + rect.h;
};
const erShrink = (r, m) => ({ x: r.x + m, y: r.y + m, w: r.w - 2 * m, h: r.h - 2 * m });
const erCenterInRect = (r, rect) => {
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  return cx >= rect.x && cx <= rect.x + rect.w && cy >= rect.y && cy <= rect.y + rect.h;
};
// 轴对齐折线的转折数(重复点已被 erDedupe 合并, 共线中间点不计)
const erBendsOf = (pts) => {
  let n = 0;
  for (let i = 1; i < pts.length - 1; i += 1) {
    const ax = pts[i].x - pts[i - 1].x, ay = pts[i].y - pts[i - 1].y;
    const bx = pts[i + 1].x - pts[i].x, by = pts[i + 1].y - pts[i].y;
    if (Math.abs(ax * by - ay * bx) > 1e-6 || ax * bx + ay * by < 0) n += 1;
  }
  return n;
};
// 轴对齐线段对的共线重叠长度(垂直距离超过 gap 或不共线返回 0), 口径同 quality-checker
const erCollinearLen = (p1, p2, p3, p4, gap) => {
  const h1 = Math.abs(p1.y - p2.y) <= 0.5, h2 = Math.abs(p3.y - p4.y) <= 0.5;
  const v1 = Math.abs(p1.x - p2.x) <= 0.5, v2 = Math.abs(p3.x - p4.x) <= 0.5;
  if (h1 && h2 && Math.abs(p1.y - p3.y) <= gap) return Math.max(0, erSpanOverlap(p1.x, p2.x, p3.x, p4.x));
  if (v1 && v2 && Math.abs(p1.x - p3.x) <= gap) return Math.max(0, erSpanOverlap(p1.y, p2.y, p3.y, p4.y));
  return 0;
};

// 单边弯折代价: 严格凹函数(边际递减)。总弯折数相同时, "集中到少数边"的方案
// (如 1+3 折)必须优于"均摊"的方案(如 2+2 折) —— 多数线保持干净是明确的产品诉求。
// 同面拥挤的代价: 这一面上已有 n 条时, 再加一条罚 penalty * n(线性)。
//
// 原先是累进 n*(n+1)/2, 目的是"挡住第三条继续堆同一面"。判别力实测下来这个目的
// 本身就不成立(人机 2:1 持平 5), 于是连同权重一起降级为平局打破, 见 ROUTER_DEFAULTS
// 的 sideLoadPenalty 注释。累进 + 大权重会把"分面"变成硬目标, 与共享起点直接冲突。
export function erSideLoadCost(n, opt) {
  if (!(n > 0)) return 0;
  // 消融开关：关掉平局打破 = 回到降级之前的累进重罚（90 × n(n+1)/2）
  if (opt.sideLoadProgressive) return 90 * n * (n + 1) / 2;
  return opt.sideLoadPenalty * n;
}

// 轴对齐线段与矩形"平行贴行"时的净空(不在投影范围内 = 不构成贴行, 返回 Infinity;
// 相交返回 0)。只量平行方向, 端头擦过去不算贴行。
function erSegRectClear(p, q, r) {
  const horizontal = Math.abs(p.y - q.y) <= 0.5;
  const vertical = Math.abs(p.x - q.x) <= 0.5;
  if (!horizontal && !vertical) return Infinity;
  const lo = horizontal ? Math.min(p.x, q.x) : Math.min(p.y, q.y);
  const hi = horizontal ? Math.max(p.x, q.x) : Math.max(p.y, q.y);
  const rLo = horizontal ? r.x : r.y;
  const rHi = horizontal ? r.x + r.w : r.y + r.h;
  if (hi <= rLo || lo >= rHi) return Infinity;          // 投影不重叠: 不是贴着它走
  const c = horizontal ? p.y : p.x;
  const cLo = horizontal ? r.y : r.x;
  const cHi = horizontal ? r.y + r.h : r.x + r.w;
  if (c >= cLo && c <= cHi) return 0;
  return c < cLo ? cLo - c : c - cHi;
}

export function erBendCost(bends) {
  return bends > 0 ? Math.sqrt(bends) : 0;
}

// 两级命中口径:
//   countHits  外扩 obstaclePad 之后的"留白"口径 —— 用来挑干净路线(贴着节点边走也算挨着)
//   deepHits   与 erEvaluate/quality-checker 同口径的"真穿进去" —— 只在所有候选都不干净时
//              用来兜底取舍。留白偏好不该把路径推回真的穿节点的那一条。
function erMakeHitTest(obstacles, cores) {
  const hitsIn = (boxes, p1, p2, ex) => {
    const x1 = Math.min(p1.x, p2.x) - 0.5, x2 = Math.max(p1.x, p2.x) + 0.5;
    const y1 = Math.min(p1.y, p2.y) - 0.5, y2 = Math.max(p1.y, p2.y) + 0.5;
    let n = 0;
    for (const o of boxes) {
      if (ex.indexOf(o.id) < 0 && x1 < o.x + o.w && x2 > o.x && y1 < o.y + o.h && y2 > o.y) n += 1;
    }
    return n;
  };
  const countHits = (pts, ex) => pts.slice(1).reduce((a, p, i) => a + hitsIn(obstacles, pts[i], p, ex), 0);
  const deepHits = (pts, ex) => {
    let n = 0;
    for (let i = 1; i < pts.length; i += 1) {
      for (const c of cores) {
        if (ex.indexOf(c.id) < 0 && erSegEntersRect(pts[i - 1], pts[i], c)) n += 1;
      }
    }
    return n;
  };
  // 背面穿出: 路径纵穿自己的源/目标卡。erEvaluate 里按 nodeCrossPenalty 重罚, 但选面阶段
  // 原本看不见它 —— countHits 恰好把两个端点排除掉了。同面拥挤改成累进计费之后,
  // "换一面"的收益可能盖过一条从自己背面穿出去的烂形状, 所以选面这里也要能看见。
  const ownHits = (pts, ids) => {
    let n = 0;
    for (let i = 1; i < pts.length; i += 1) {
      for (const c of cores) {
        if (ids.indexOf(c.id) >= 0 && erSegEntersRect(pts[i - 1], pts[i], c)) n += 1;
      }
    }
    return n;
  };
  return { countHits, deepHits, ownHits, pathClear: (pts, ex) => countHits(pts, ex) === 0 };
}

// 自环: 右侧出 → 绕右上角 → 顶边入。出入端口坐标来自全局端口分配, 避免与同侧其它连线并线。
function erSelfLoop(r, exitY, enterX) {
  const y = Number.isFinite(exitY) ? exitY : r.y + r.h / 2;
  const x = Number.isFinite(enterX) ? enterX : r.x + r.w / 2;
  return [
    { x: r.x + r.w, y },
    { x: r.x + r.w + 26, y },
    { x: r.x + r.w + 26, y: r.y - 22 },
    { x, y: r.y - 22 },
    { x, y: r.y },
  ];
}

// Z 形中段所在的带。带必须位于两端口的"朝外"一侧, 否则中段会从背面穿过节点。
// 阶段 A(选面打分)与阶段 C(定形状)共用本函数, 两阶段口径不一致会导致选面误判。
function erPickBand(bands, fixedA, dirA, fixedB, dirB, stub) {
  const outwardOk = (b) => (dirA > 0 ? b.lo >= fixedA - 0.5 : b.hi <= fixedA + 0.5)
                        && (dirB > 0 ? b.lo >= fixedB - 0.5 : b.hi <= fixedB + 0.5);
  const c1 = fixedA + dirA * stub;
  const c2 = fixedB + dirB * stub;
  const prefer = (c1 + c2) / 2;
  const usable = bands.filter(outwardOk).sort((p, q) =>
    Math.abs(p.center - prefer) - Math.abs(q.center - prefer) || (p.index - q.index));
  const hit = usable.find((b) => prefer >= b.lo - 0.5 && prefer <= b.hi + 0.5);
  if (hit) return { band: hit, mid: prefer };            // 朴素中点本就落在空闲带里: 保持原几何
  if (usable.length) return { band: usable[0], mid: usable[0].center };
  const between = erBandsBetween(bands, c1, c2, prefer);
  if (between.length) return { band: between[0], mid: between[0].center };
  const fake = { index: -1, lo: prefer - 30, hi: prefer + 30, center: prefer, size: 60 };
  return { band: fake, mid: prefer };
}

// L 形的两个拐点(先横后竖 / 先竖后横)。阶段 A 与阶段 C 共用, 两处候选集必须一致。
const erCorners = (a, axisA, b) => (axisA === 'h'
  ? [{ x: b.x, y: a.y }, { x: a.x, y: b.y }]
  : [{ x: a.x, y: b.y }, { x: b.x, y: a.y }]);

// 一条腿可以落在哪些带上, 由近及远。
// 第一顺位是"沿朝向引出 stub 之后落进的那条带" —— 端口若挂在容器边界上, 这条边界
// 常常落在带的内部, 严格要求"整条带都在端口外侧"会把它漏掉(erBandOfPort 有同款让步)。
// 其后是所有严格位于外侧的带, 按与端口的距离排序, 最外圈那条自然排在最末。
// reach 这一关是留给首/末段的: 带必须够得着端口外侧至少一个 stub, 否则腿会落在端口
// 背面, 引出段当场掉头。
function erDetourBands(bands, fixed, dir, stub) {
  const out = [];
  const reach = (b) => (dir > 0 ? b.hi >= fixed + stub - 0.5 : b.lo <= fixed - stub + 0.5);
  const push = (b) => { if (b && reach(b) && out.indexOf(b) < 0) out.push(b); };
  push(erBandAt(bands, fixed + dir * stub));
  bands.filter((b) => (dir > 0 ? b.lo >= fixed - 0.5 : b.hi <= fixed + 0.5))
    .sort((p, q) => (Math.abs(p.center - fixed) - Math.abs(q.center - fixed)) || (p.index - q.index))
    .forEach(push);
  return out;
}
// 两段绕行(4 段)的落位方案: 两端落在不同轴上, 而 L 形那个唯一合法的拐点被堵死时的出路。
// 从 A 沿自身朝向拐到一条带上, 横过去, 再贴着 B 朝外的那条带拐进 B。
//
// 「贴着端口的那一档」就是老的 stub-first 四折, 「最外圈那一档」就是老的阶梯形 ——
// 两者本来就是同一种折线, 差别只在两条腿放在哪条带上, 所以这里合成一族由近及远枚举,
// 取第一个 clear 的组合。分开写的代价是实打实的: stub-first 那一支不进阶段 D 的轨道
// 分配, 同一排并排绕出去的几条边会压在同一个 stub 偏移上(case-01 的三条「遥测」),
// 而且它对非端点容器视而不见, 会从通栏容器身上直穿过去(case-06 的「合规放行」)。
//
// clear(pts) 由调用方注入(卡片 + 非端点容器同口径)。全不通过时返回最贴身的那一组并
// 标记 clear:false, 由调用方决定要不要退回别的形状。
function erStairPlan(a, sideA, b, sideB, hBands, vBands, opt, clear) {
  const oa = ER_OUT[sideA], ob = ER_OUT[sideB];
  const aIsH = !!oa.x;
  // A 侧的带承载"沿 A 朝向拐出去"的那段, B 侧的带承载"贴着 B 拐进来"的那段
  const aBands = aIsH ? vBands : hBands;
  const bBands = aIsH ? hBands : vBands;
  const aCands = erDetourBands(aBands, aIsH ? a.x : a.y, aIsH ? oa.x : oa.y, opt.stub);
  const bCands = erDetourBands(bBands, aIsH ? b.y : b.x, aIsH ? ob.y : ob.x, opt.stub);
  if (!aCands.length || !bCands.length) return null;
  const mk = (aBand, bBand, ok) => ({
    aIsH, aBand, bBand, clear: ok,
    // 绕外圈 = 两条腿里有一条落在最外圈的虚拟带上(erFreeBands 首末两条, 它们是给绕行
    // 开出来的路, 图里其它东西都够不着)。阶段 F 的绕行名额只认这一档, 在两排卡片之间
    // 拐两下的同族形状不占名额(见 routeEdges 的 stairCap)。
    outer: !!(aBand.outermost || bBand.outermost),
  });
  for (const aBand of aCands) {
    for (const bBand of bCands) {
      if (clear(erDedupe(erStairPts(a, b, { aIsH }, aBand.center, bBand.center)))) {
        return mk(aBand, bBand, true);
      }
    }
  }
  return mk(aCands[0], bCands[0], false);
}
const erStairPts = (a, b, plan, aTrack, bTrack) => (plan.aIsH
  ? [a, { x: aTrack, y: a.y }, { x: aTrack, y: bTrack }, { x: b.x, y: bTrack }, b]
  : [a, { x: a.x, y: aTrack }, { x: bTrack, y: aTrack }, { x: bTrack, y: b.y }, b]);

// 选面阶段用的候选形状(中心端口, 仅用于打分比较 16 种取舍)。
//
// 这里**不**给阶梯形留位置: 阶段 A 是跨 16 种选面横向比价, 而阶梯形靠"换一条边入线"
// 常能省下上百像素, 多出来的那个弯只罚 90 —— 放进来的话, 本该一折了事的线会被它以
// 二三十分的微弱优势挤掉, 全图绕成阶梯。阶梯形只在阶段 C 兜底(选定的 L 两个拐点都被
// 挡死时才落形), 该不该为它换选面由阶段 F 按最终几何的真实代价决定。
function erShapeFor(a, sideA, b, sideB, opt, hBands, vBands) {
  const oa = ER_OUT[sideA], ob = ER_OUT[sideB];
  const stub = opt.stub;
  const axisA = oa.x ? 'h' : 'v', axisB = ob.x ? 'h' : 'v';
  const cands = [];
  if (axisA === axisB) {
    const vertical = axisA === 'v';
    if (!vertical && Math.abs(a.y - b.y) < opt.alignTol && oa.x === -ob.x) cands.push([a, { x: b.x, y: a.y }]);
    if (vertical && Math.abs(a.x - b.x) < opt.alignTol && oa.y === -ob.y) cands.push([a, { x: a.x, y: b.y }]);
    const m = erPickBand(vertical ? hBands : vBands,
      vertical ? a.y : a.x, vertical ? oa.y : oa.x,
      vertical ? b.y : b.x, vertical ? ob.y : ob.x, stub).mid;
    cands.push(vertical ? [a, { x: a.x, y: m }, { x: b.x, y: m }, b] : [a, { x: m, y: a.y }, { x: m, y: b.y }, b]);
  } else {
    // L 形与阶段 C 的落形一致(不带 stub 冗余点), 否则 bends 计数在 Z/L 之间不可比。
    // 两个拐法都要给, 阶段 C 也是挑第一个不被挡的那个。
    for (const c of erCorners(a, axisA, b)) cands.push([a, c, b]);
  }
  return cands.map(erDedupe).filter((pts) => pts.length >= 2);
}

/**
 * 布线主入口。
 * @param {object} input
 *   rects  全部可连接矩形(叶节点 + 容器), Array<{id,x,y,w,h}> 或 Map
 *   cards  叶节点矩形(用于避障与推导通道), 缺省时取 rects
 *   edges  Array<{id,source,target}>, 顺序即确定性依据
 *   options 覆盖 ROUTER_DEFAULTS
 * @returns {{routes: Map<string,{pts,sa,sb}>, stats: object}}
 */
export function routeEdges(input) {
  const opt = Object.assign({}, ROUTER_DEFAULTS, (input && input.options) || {});
  const rects = erToArray(input && input.rects);
  const cards = erToArray(input && input.cards);
  const cardRects = cards.length ? cards : rects;
  const rectById = new Map();
  for (const r of rects) rectById.set(r.id, r);

  const stats = { bands: 0, tracks: 0, maxTracksInBand: 0, residualConflicts: 0 };
  const rawEdges = (input && input.edges) || [];
  if (!rects.length || !rawEdges.length) return { routes: new Map(), stats };

  const obstacles = cardRects.map((r) => ({
    id: r.id, x: r.x - opt.obstaclePad, y: r.y - opt.obstaclePad,
    w: r.w + opt.obstaclePad * 2, h: r.h + opt.obstaclePad * 2,
  }));
  const cores = cardRects.map((r) => erShrink(r, opt.edgeNodeInset));
  for (let i = 0; i < cores.length; i += 1) cores[i].id = cardRects[i].id;
  const { countHits, deepHits, ownHits, pathClear } = erMakeHitTest(obstacles, cores);
  const bnd = opt.bounds;
  const hClamp = bnd ? { lo: bnd.y + opt.boundsPad, hi: bnd.y + bnd.h - opt.boundsPad } : null;
  const vClamp = bnd ? { lo: bnd.x + opt.boundsPad, hi: bnd.x + bnd.w - opt.boundsPad } : null;
  const hBands = erFreeBands(cardRects, 'y', opt.outerBand, hClamp); // 承载横向中段
  const vBands = erFreeBands(cardRects, 'x', opt.outerBand, vClamp); // 承载纵向中段
  stats.bands = hBands.length + vBands.length;

  // 非端点容器穿越评估用: cards 之外的 rect 即容器(cards 缺省时无从区分, 集合为空)
  const cardIdSet = new Set(cardRects.map((r) => r.id));
  const containerRects = cards.length ? rects.filter((r) => !cardIdSet.has(r.id)) : [];
  // 形状构建期的容器净空判据, 与 erEvaluate 的 containerCross 完全同口径(含"容器装着
  // 自己的端点就豁免"这条)。避障用的 obstacles 只有卡片 —— 挑形状时看不见容器, 拐点就会
  // 压着通栏容器落下去; 而阶段 F 只能换面换带, 换不掉一个从一开始就穿进去的拐点。
  const boxClear = (pts, srcId, dstId) => {
    const sRect = rectById.get(srcId), tRect = rectById.get(dstId);
    for (const c of containerRects) {
      if (c.id === srcId || c.id === dstId) continue;
      if ((sRect && erCenterInRect(sRect, c)) || (tRect && erCenterInRect(tRect, c))) continue;
      const shrunk = erShrink(c, opt.edgeNodeInset);
      for (let i = 1; i < pts.length; i += 1) {
        if (erSegEntersRect(pts[i - 1], pts[i], shrunk)) return false;
      }
    }
    return true;
  };

  // ===== 阶段 A: 选面 =====================================================
  // 中心端口打分, 只决定"从哪条边出/入"; 具体端口坐标留给阶段 B 全局分配。
  const items = rawEdges.map((e, i) => {
    const ra = rectById.get(e.source), rb = rectById.get(e.target);
    const aligned = !!(ra && rb && (
      Math.abs((ra.y + ra.h / 2) - (rb.y + rb.h / 2)) < opt.alignTol ||
      Math.abs((ra.x + ra.w / 2) - (rb.x + rb.w / 2)) < opt.alignTol));
    return {
      edge: e, index: i, ra, rb, aligned, bandIdx: null,
      pinA: isEdgePort(e.sourcePort) ? e.sourcePort : null,
      pinB: isEdgePort(e.targetPort) ? e.targetPort : null,
    };
  });
  const sideOrder = items.slice().sort((p, q) => (q.aligned - p.aligned) || (p.index - q.index));
  const sideLoad = new Map();
  const loadOf = (id, side) => sideLoad.get(id + ':' + side) || 0;
  const bumpLoad = (id, side) => sideLoad.set(id + ':' + side, loadOf(id, side) + 1);

  for (const it of sideOrder) {
    if (!it.ra || !it.rb) continue;
    if (it.edge.source === it.edge.target) {
      // 自环也走端口分配, 否则它固定占住右边中点, 与同侧其它连线并线
      it.sa = 'right';
      it.sb = 'top';
      bumpLoad(it.edge.source, 'right');
      bumpLoad(it.edge.target, 'top');
      continue;
    }
    const ex = [it.edge.source, it.edge.target];
    // 被挡不再是硬过滤而是重罚: 无遮挡的组合永远胜出; 全被挡时也能挑出"穿得最少"的那个,
    // 而不是退回写死的 right/left(那会让线从节点背面穿出去)。
    let best = null;
    // 端点被手调钉住时, 这一端的候选边只剩它自己 —— 选面只在另一端还有自由度
    const sidesA = it.pinA ? [it.pinA.side] : ER_SIDES;
    const sidesB = it.pinB ? [it.pinB.side] : ER_SIDES;
    for (const sa of sidesA) for (const sb of sidesB) {
      const pa = erPortPoint(it.ra, sa, erSideCenter(it.ra, sa));
      const pb = erPortPoint(it.rb, sb, erSideCenter(it.rb, sb));
      const load = erSideLoadCost(loadOf(it.edge.source, sa), opt)
                 + erSideLoadCost(loadOf(it.edge.target, sb), opt);
      for (const pts of erShapeFor(pa, sa, pb, sb, opt, hBands, vBands)) {
        const score = erPathLen(pts) + (pts.length - 2) * opt.bendPenalty
          + load + (countHits(pts, ex) + ownHits(pts, ex)) * opt.blockPenalty;
        if (!best || score < best.score) best = { score, sa, sb };
      }
    }
    if (!best) best = { sa: it.pinA ? it.pinA.side : 'right', sb: it.pinB ? it.pinB.side : 'left', score: Infinity };
    it.sa = best.sa;
    it.sb = best.sb;
    bumpLoad(it.edge.source, best.sa);
    bumpLoad(it.edge.target, best.sb);
  }

  // ===== 阶段 B–E: 求解一遍(可重入, 供阶段 F 反复调用) =====================
  const ctx = { opt, hBands, vBands, hit: { pathClear, deepHits, boxClear }, rectById, items, sideOrder, cardRects, containerRects };
  let sol = erSolve(ctx);
  let best = erEvaluate(sol.routes, ctx);

  // ===== 阶段 F: 终局评估 + 违规边重选面/重选带 ===========================
  const passes = Math.max(0, opt.refinePasses | 0);
  // 绕外圈的名额是"阶段 F 新增"的名额: 基础解里本来就绕出去的不倒扣(它们是形状构建
  // 阶段唯一走得通的路线, 撤掉只会变成硬穿), 但重选不许在此之上再添 —— 每多一条绕图
  // 外圈的线都会把版面重心拉歪。躲硬穿的边(best.hard)随时可以绕, 名额只管"为了少一处
  // 边边交叉而绕"这一类。
  const stairCap = Math.max(opt.stairBudget, sol.stairs.size);
  // 手调过的边（钉端点 / 挪过中段）不参与重选：用户已经接管, 引擎不跟用户抢
  const erUserTuned = (it) => it.pinA || it.pinB
    || (Array.isArray(it.edge.segShifts) && it.edge.segShifts.some((v) => Number.isFinite(v) && v !== 0));
  for (let pass = 0; pass < passes; pass += 1) {
    if (!best.involve.size) break;
    const targets = items
      .filter((it) => it.ra && it.rb && it.edge.source !== it.edge.target
        && !erUserTuned(it) && best.involve.has(it.edge.id))
      .sort((p, q) => (best.involve.get(q.edge.id) - best.involve.get(p.edge.id)) || (p.index - q.index));
    let improved = false;
    for (const it of targets) {
      const saved = { sa: it.sa, sb: it.sb, bandIdx: it.bandIdx };
      let bestTrial = null;
      for (const sa of ER_SIDES) for (const sb of ER_SIDES) {
        for (const bandIdx of erCandidateBands(it, sa, sb, ctx)) {
          if (sa === saved.sa && sb === saved.sb
            && (bandIdx == null ? saved.bandIdx == null : bandIdx === saved.bandIdx)) continue;
          it.sa = sa; it.sb = sb; it.bandIdx = bandIdx;
          const trialSol = erSolve(ctx);
          // 绕外圈是"奇观路线": 它必然又长又弯, 但也确实是唯一能翻过整排节点 / 整块通栏
          // 容器的形状。准入分两档:
          //   硬穿(节点 / 容器 / 自己背面)躲不开的边随时可以改走它 —— 那就是它存在的理由;
          //   只为少一处边边交叉而绕的, 受 stairCap 限额。交叉是可接受的次级瑕疵,
          //   而每多一条绕图外圈的线都会把版面重心拉歪 —— 这也正是"长/弯集中到少数几条,
          //   多数线保持干净"这条产品准则的直接落地。
          if (trialSol.stairs.size > stairCap && !best.hard.has(it.edge.id)) continue;
          const trialScore = erEvaluate(trialSol.routes, ctx);
          if (!bestTrial || trialScore.cost < bestTrial.score.cost) {
            bestTrial = { sa, sb, bandIdx, sol: trialSol, score: trialScore };
          }
        }
      }
      if (bestTrial && bestTrial.score.cost < best.cost - 1e-6) {
        it.sa = bestTrial.sa; it.sb = bestTrial.sb; it.bandIdx = bestTrial.bandIdx;
        sol = bestTrial.sol;
        best = bestTrial.score;
        improved = true;
      } else {
        it.sa = saved.sa; it.sb = saved.sb; it.bandIdx = saved.bandIdx;
      }
    }
    if (!improved) break;
  }

  // ===== 收尾: 独占通道的绕行腿收回端口旁边 ===============================
  // 绕行的两条腿默认和 Z 形中段一样走通道正中。可一旦这条腿在带里没有对手(轨道只有
  // 一条), 正中就白占了: 那条正中线是横穿这条带的边、以及它们的标签唯一的落脚处
  // (见 trackPitch 的注释)。让到端口旁边(引出一个 stub 就转)不影响任何人, 还更短。
  //
  // 只在定稿之后做, 不参与阶段 A/F 的比价 —— 比价必须有一把稳定的尺子, 让"贴身"
  // 反过来影响选面, 同样长短的两条路线会因为一条腿贴不贴身而互换名次(3x4 网格的
  // 对角互换就是这么从"一条绕行 + 一处交叉"翻成"一条绕行 + 两处交叉"的)。
  // 收完再按同一口径复评一次, 只有不带来新违规才采纳。
  const hugged = erSolve(ctx, true);
  const huggedScore = erEvaluate(hugged.routes, ctx);
  if (huggedScore.cost <= best.cost + 1e-6) { sol = hugged; best = huggedScore; }

  // 共享起点候选: 同一把尺子比一次, 但比的是**违规数**, 不是混合代价。
  //
  // 混合代价里带 lengthWeight, 而收拢起点几乎必然让总长多出一点点(实测 3297 → 3301,
  // 违规数两边一模一样)。要是按混合代价卡"严格更优", 这个候选永远出不了头 ——
  // 而它不是省长度的手段, 是准则 3 的表达方式: 多条边从同一个点发散, 读者才看得出
  // "这是同一个源"。孙毅确认过 case-02 三条决策边同起点 x=971 是意图。
  // 所以口径是: 一处违规都不许多, 多出来的长度不计较。
  if (opt.sharedOrigin) {
    const shared = erSolve(ctx, true, true);
    const sharedScore = erEvaluate(shared.routes, ctx);
    if (erViolNoWorse(sharedScore.viol, best.viol)) { sol = shared; best = sharedScore; }
  }

  // 束线候选(设计要点 8): 在上面已采纳的那一版之上, 再把"同节点同面同方向 ≥ bundleMin 条
  // Z 形 / 直线边"的端口收到面的正中。采纳口径与共享起点完全相同 —— 违规逐项不劣化, 长度不计
  // 较: 第二轮 17 份手调里 15 / 11 / 05 / 04 / 20 都是这么画的(15 号三处主干 + 梳齿, 11 号
  // 三个渠道并成一股进订单中心), 它不是省长度的手段, 是"这几条边同源 / 同汇"的表达方式。
  //
  // 分两层, 都按"一束一试"做候选, 一束被拒不连累别的束:
  //   ① 选面 —— 一组边的对面全都在同一侧时, 整组改走那一面(见 erBundleGroups)。阶段 A 逐条
  //      选面时 L 形(1 折)总是赢 Z 形(2 折), 三条扇出会被拆到上 / 右 / 下三个面上, 梳齿根本
  //      形不成 —— 而人工是一律从同一面出的。改面之后这一组的束键进入 bundleKeys 一起试。
  //   ② 端口收拢 —— erSolve 的阶段 B'' 只收拢 ctx.bundleKeys 里点名的束。改面组试完之后,
  //      再把阶段 A 本来就放在同一面上的束(如枢纽居中的扇出)逐束试一遍。
  // 每次试都整套重解 + 终局评估; 被采纳的组给成员打上"已认领", 后面的组不再动它们的面
  // (否则后一组会把前一组的束拆散、留下为束而改的孤零零 Z 形)。
  if (opt.bundle) {
    ctx.bundleKeys = new Set();
    const claimed = new Set();
    const groups = erBundleGroups(items, opt);
    const forceFaces = (g) => {
      for (const m of g.members) {
        if (m.isSource) { m.it.sa = g.face; m.it.sb = ER_OPPOSITE[g.face]; }
        else { m.it.sb = g.face; m.it.sa = ER_OPPOSITE[g.face]; }
        m.it.bandIdx = null;
      }
    };
    const snapshotFaces = (g) => g.members.map((m) => ({ it: m.it, sa: m.it.sa, sb: m.it.sb, bandIdx: m.it.bandIdx }));
    const restoreFaces = (snap) => { for (const r of snap) { r.it.sa = r.sa; r.it.sb = r.sb; r.it.bandIdx = r.bandIdx; } };
    const tryKey = (key) => {
      ctx.bundleKeys.add(key);
      const trial = erSolve(ctx, true, !!sol.sharedOrigin, true);
      // 这一束在 B'' 里得真的收拢了才算(被 blocked / 单位对面够不到时什么都没收):
      // 否则改面组会留下"为束而改的孤零零 Z 形" —— 多两个折、没有束
      const made = (trial.bundledCount.get(key) || 0) >= Math.max(2, opt.bundleMin | 0);
      const trialScore = made ? erEvaluate(trial.routes, ctx) : null;
      if (made && erViolNoWorse(trialScore.viol, best.viol)) { sol = trial; best = trialScore; return true; }
      ctx.bundleKeys.delete(key);
      return false;
    };
    for (const g of groups) {
      // 已被前面某组认领的边不再改面; 剩下的不够一束就整组跳过
      g.members = g.members.filter((m) => !claimed.has(m.it));
      if (g.members.length < Math.max(2, opt.bundleMin | 0)) continue;
      const snap = snapshotFaces(g);
      forceFaces(g);
      if (tryKey(g.key)) { for (const m of g.members) claimed.add(m.it); }
      else restoreFaces(snap);
    }
    // 阶段 A 自己就摆在同一面上的束: 只收拢、不改面, 同样一束一试
    for (const key of erBundleFanKeys(items, opt)) {
      if (ctx.bundleKeys.has(key)) continue;
      tryKey(key);
    }
  }

  stats.tracks = sol.stats.tracks;
  stats.maxTracksInBand = sol.stats.maxTracksInBand;
  stats.residualConflicts = erCountResidual(sol.routes, opt.minSep);
  stats.violations = best.viol;
  return { routes: sol.routes, stats };
}

// 束线成员资格(设计要点 8): 这条边在节点 nodeId 这一端能不能进束。
//   · 自环不进; 任一端手调过(钉端点 / 挪过中段)的不进 —— 与阶段 F 的 erUserTuned 同口径,
//     用户接管的边引擎不跟他抢, 也免得用户拖一段就让整束散开;
//   · 源端有箭头的边(双向 / 反向)不进出边束: 它的箭头会压在同点出发的同伴上、指向自己的邻居;
//     入边束里双向边照常(那一端和别人一样是箭头), 反向边不进(那一端没箭头, 挤进一堆箭头里会
//     被读成有箭头)。
const erBundleEligible = (it, isSource) => {
  if (!it.ra || !it.rb || it.edge.source === it.edge.target) return false;
  if (it.pinA || it.pinB) return false;
  if (Array.isArray(it.edge.segShifts) && it.edge.segShifts.some((v) => Number.isFinite(v) && v !== 0)) return false;
  if (it.edge.reversed) return false;
  if (isSource && it.edge.bidirectional) return false;
  return true;
};
// 束键: 节点 | 面 | 方向 | 线型。线型也进键 —— 实线主流程边与虚线配置边不并成一股
// (09 号人工并的是同一容器出来的两条虚线, 实线 e-staging 单独走)。
const erBundleStyleOf = (it) => (String(it.edge.style || 'solid') === 'dashed' ? 'dashed' : 'solid');
const erBundleKeyOf = (it, isSource, face) => `${isSource ? it.edge.source : it.edge.target}|${face}|${isSource ? 'out' : 'in'}|${erBundleStyleOf(it)}`;

// 束线的分组(设计要点 8 的第一层): 同一个节点的同方向(出 / 入)、同线型的边里, 对面全都落在
// 它某一面之外的那一组, 记下"整组该走的面"。判定:
//   · 成员资格见 erBundleEligible;
//   · 对面的矩形整体在面 F 之外, 且与 F 之间至少留出 2·stub 的通道(相接 / 只隔几个像素的
//     对面没有"主干"可言, 强改成 Z 形只会画出几像素的引出腿);
//   · 对面那组站在同一条道上(朝向 N 的那条边坐标彼此差不过 groupTol): 梳齿的齿等长, 主干才
//     贴着那一组走; 散在不同列 / 行里的对面不强制改面 —— 那种改成 Z 形只多折不合线;
//   · 一组 ≥ bundleMin 条; 同时满足两个面时取"对面那组垂直于 F 铺开得更开"的那个 ——
//     梳齿的齿要垂直于主干, 对面那组是竖着排的就从左右面走, 横着排的就从上下面走;
//     两个方向铺得一样开(斜对角)时不强制, 交给阶段 A 的选面。
// 只出分组不改状态; 改面与采纳在 routeEdges 里逐组做。
function erBundleGroups(items, opt) {
  const min = Math.max(2, opt.bundleMin | 0);
  const byNode = new Map();
  for (const it of items) {
    for (const isSource of [true, false]) {
      if (!erBundleEligible(it, isSource)) continue;
      const nodeId = isSource ? it.edge.source : it.edge.target;
      const k = `${nodeId}|${isSource ? 'out' : 'in'}|${erBundleStyleOf(it)}`;
      if (!byNode.has(k)) byNode.set(k, { rect: isSource ? it.ra : it.rb, members: [] });
      byNode.get(k).members.push({ it, isSource, far: isSource ? it.rb : it.ra });
    }
  }
  const groups = [];
  const keys = [...byNode.keys()].sort();
  const channel = 2 * opt.stub;
  for (const k of keys) {
    const g = byNode.get(k);
    if (g.members.length < min) continue;
    const N = g.rect;
    const laneOk = (near) => {
      const v = g.members.map(near);
      return Math.max(...v) - Math.min(...v) <= opt.groupTol;
    };
    const beyond = {
      right: g.members.every((m) => m.far.x - (N.x + N.w) >= channel) && laneOk((m) => m.far.x),
      left: g.members.every((m) => N.x - (m.far.x + m.far.w) >= channel) && laneOk((m) => m.far.x + m.far.w),
      bottom: g.members.every((m) => m.far.y - (N.y + N.h) >= channel) && laneOk((m) => m.far.y),
      top: g.members.every((m) => N.y - (m.far.y + m.far.h) >= channel) && laneOk((m) => m.far.y + m.far.h),
    };
    const cx = g.members.map((m) => m.far.x + m.far.w / 2);
    const cy = g.members.map((m) => m.far.y + m.far.h / 2);
    const spreadX = Math.max(...cx) - Math.min(...cx);
    const spreadY = Math.max(...cy) - Math.min(...cy);
    const straddleOk = (f) => erStraddles(N, f, g.members.map((m) => m.far), opt);
    let face = null;
    let bestScore = 0;
    for (const f of ER_SIDES) {
      if (!beyond[f]) continue;
      if (!straddleOk(f)) continue;
      // 面的法线是横向(左右)时, 齿要竖着铺开; 法线是纵向(上下)时, 齿要横着铺开
      const score = erIsVSide(f) ? spreadX - spreadY : spreadY - spreadX;
      if (score > bestScore + 0.5) { bestScore = score; face = f; }
    }
    if (!face) continue;
    const [nodeId, dir, style] = k.split('|');
    // 束键与阶段 B'' 同形: 节点|面|方向|线型(见 erBundleKeyOf)
    groups.push({ key: `${nodeId}|${face}|${dir}|${style}`, face, members: g.members });
  }
  return groups;
}

// 阶段 A 之后, 当前面组合下已经"同节点同面同方向同线型 ≥ bundleMin 条 Z 形 / 直线"的束键。
// 这些束不需要改面, 只需要收拢; routeEdges 逐束试。
function erBundleFanKeys(items, opt) {
  const min = Math.max(2, opt.bundleMin | 0);
  const fans = new Map();
  for (const it of items) {
    if (!it.sa || !it.sb) continue;
    const oa = ER_OUT[it.sa], ob = ER_OUT[it.sb];
    const opposed = erIsVSide(it.sa) === erIsVSide(it.sb) && oa.x === -ob.x && oa.y === -ob.y;
    if (!opposed) continue;
    for (const isSource of [true, false]) {
      if (!erBundleEligible(it, isSource)) continue;
      const face = isSource ? it.sa : it.sb;
      const key = erBundleKeyOf(it, isSource, face);
      if (!fans.has(key)) fans.set(key, { rect: isSource ? it.ra : it.rb, face, fars: [] });
      fans.get(key).fars.push(isSource ? it.rb : it.ra);
    }
  }
  const out = [];
  for (const [key, f] of fans) {
    if (f.fars.length < min) continue;
    // 与 erBundleGroups 的 straddleOk 同一条规矩: 对面那组骑跨正中两侧、或有一条正对着, 才收
    if (!erStraddles(f.rect, f.face, f.fars, opt)) continue;
    out.push(key);
  }
  return out.sort();
}

// 对面那组要么骑跨在这一面的正中两侧(枢纽居中, 梳齿往两边分), 要么其中有一条正对着能直连
// (直线当主干, 别的齿从主干上分出去)。全部偏在一侧、又没有一条正对时不并: 那种只能各占
// 一条轨道分层走(20 号形态), 齿之间只有 26px, 标签放哪都压着邻齿 —— 人工能手挪标签,
// 引擎的落标签器躲不开(07 / 14 号实测多出一处「标签压同伴支线」)。
function erStraddles(N, face, fars, opt) {
  const c = erIsVSide(face) ? N.x + N.w / 2 : N.y + N.h / 2;
  let lo = 0, hi = 0, mid = 0;
  for (const far of fars) {
    const fc = erIsVSide(face) ? far.x + far.w / 2 : far.y + far.h / 2;
    if (Math.abs(fc - c) < opt.alignTol) mid += 1; else if (fc < c) lo += 1; else hi += 1;
  }
  return mid > 0 || (lo > 0 && hi > 0);
}

// 重选面时的候选带: 只有同轴组合才有"带"可选; null 表示交给 erPickBand 走默认。
function erCandidateBands(it, sa, sb, ctx) {
  const oa = ER_OUT[sa], ob = ER_OUT[sb];
  const axisA = oa.x ? 'h' : 'v', axisB = ob.x ? 'h' : 'v';
  if (axisA !== axisB) return [null];
  const vertical = axisA === 'v';
  const bands = vertical ? ctx.hBands : ctx.vBands;
  const fixedA = erSideFixed(it.ra, sa), dirA = vertical ? oa.y : oa.x;
  const fixedB = erSideFixed(it.rb, sb), dirB = vertical ? ob.y : ob.x;
  const outwardOk = (b) => (dirA > 0 ? b.lo >= fixedA - 0.5 : b.hi <= fixedA + 0.5)
                        && (dirB > 0 ? b.lo >= fixedB - 0.5 : b.hi <= fixedB + 0.5);
  const prefer = (fixedA + dirA * ctx.opt.stub + fixedB + dirB * ctx.opt.stub) / 2;
  const usable = bands.filter(outwardOk).sort((p, q) =>
    Math.abs(p.center - prefer) - Math.abs(q.center - prefer) || (p.index - q.index));
  const k = Math.max(1, ctx.opt.refineBands | 0);
  const picked = usable.slice(0, k);
  // 最外侧的可用带必须始终在候选里: 纵穿中间行的长边唯一的脱困方式是从图形外圈绕行,
  // 而外圈带距离 prefer 最远, 只按邻近取 k 条永远轮不到它。
  if (usable.length) {
    const byIndex = usable.slice().sort((p, q) => p.index - q.index);
    for (const b of [byIndex[0], byIndex[byIndex.length - 1]]) {
      if (picked.indexOf(b) < 0) picked.push(b);
    }
  }
  const out = [null];
  for (const b of picked) out.push(b.index);
  return out;
}

// 阶段 B–E 的一次完整求解: 端口分配 → 形状构建 → 轨道分配 → 落坐标。
// 无共享可变状态(端口对象每次新建), 阶段 F 反复调用以评估不同的选面/选带组合。
function erSolve(ctx, hug, sharedOrigin, bundle) {
  const { opt, hBands, vBands, hit, sideOrder } = ctx;
  const routes = new Map();
  const stats = { tracks: 0, maxTracksInBand: 0 };

  // ---- 阶段 B: 全局端口分配 ----
  // 归组键 = (端口朝向的空闲带) × (垂直于该朝向的中心坐标, 按 groupTol 量化)。
  // 同列上下相邻的两个节点, 其面向同一条带的端口进入同一组 —— 这是"引脚共用 x"类重合的根因修复。
  const ports = [];
  for (const it of sideOrder) {
    if (!it.sa || !it.ra || !it.rb) continue;
    ports.push(erMakePort(it, true, opt, hBands, vBands));
    ports.push(erMakePort(it, false, opt, hBands, vBands));
  }
  const groups = new Map();
  for (const p of ports) {
    if (!groups.has(p.key)) groups.set(p.key, []);
    groups.get(p.key).push(p);
  }
  const groupKeys = [...groups.keys()].sort();
  for (const key of groupKeys) {
    // 同通道内按中心坐标邻近聚类: 相邻中心距超过 groupTol 即断开, 各簇独立分配槽位
    const sorted = groups.get(key).slice().sort((p, q) => (p.center - q.center) || (p.order - q.order));
    let cluster = [];
    for (const p of sorted) {
      if (cluster.length && p.center - cluster[cluster.length - 1].center > opt.groupTol) {
        erAssignPortSlots(cluster, opt);
        cluster = [];
      }
      cluster.push(p);
    }
    if (cluster.length) erAssignPortSlots(cluster, opt);
  }

  // ---- 阶段 B': 共享起点候选 ----
  //
  // 默认做法是把同一节点同一面的多个端口沿边散开, 一条边一个槽位。人工不是这么画的:
  // case-02 的三条决策边全部从 x=971 这一个点出发(孙毅确认过是意图), case-04 的
  // e4/e5/e6 三条边都声明从 HIS 核心底边 t=0.5 出发、再靠 segShifts 分开。
  // 聚合点扇出时, "从一个点发散"比"三个并排的起点"更能表达"这是同一个源"。
  //
  // 这里只生成候选, 不做决定: 收拢版与散开版各解一遍, 由阶段 F 的同一把终局评估尺子
  // 比代价, 不劣化才采纳(见下面 shared 那一段)。
  if (sharedOrigin) {
    const only = opt.sharedOriginIds;
    const fan = new Map();
    for (const it of sideOrder) {
      for (const [port, isSource] of [[it.portA, true], [it.portB, false]]) {
        if (!port || port.pinned) continue;
        // 只收拢调用方点名的聚合点。不点名就不收 —— 通用的几何规则会把走线器的
        // 嵌套/交错顺序打乱(穿越形三条边靠端口顺序避免横段交叉, 收拢就乱了)。
        if (!only || !only.has(port.rect.id)) continue;
        const k = `${port.rect.id}|${port.side}|${isSource ? 'out' : 'in'}`;
        if (!fan.has(k)) fan.set(k, []);
        fan.get(k).push(port);
      }
    }
    for (const ports of fan.values()) {
      // 只收**聚合点的扇出**（同一面 ≥3 条同向边）。两条边的情形不收:
      // 那多半是 U 形回绕或普通的一进一出, 散开才是对的, 收拢会把走线器的
      // 嵌套/交错顺序打乱(tests/edge-router-shapes 的两条断言就是盯这个的)。
      // ≥3 正好对上准则 3 的「对三个以上兄弟扇出」, 也对上 case-02 / case-04 的三条边。
      if (ports.length < 3) continue;
      // 收到这一面的正中: 那是"唯一公共点"最自然的位置, 也是手调日志里的取法(t=0.5)
      for (const port of ports) port.coord = erClamp(port.center, port.lo + 2, port.hi - 2);
    }
  }

  // ---- 阶段 B'': 束线候选(设计要点 8) ----
  //
  // 第二轮 17 份日志里"三线合一"是出现最多的手法之一: 同一个节点同一面上, 几条同向的边
  // 一律从同一个点出发 / 汇入同一个点(手工端口 104 处里 79 处 t=0.5)。与 B' 的三点不同:
  //   ① 不限聚合点 —— 15 号内容投稿 → 三个模型不是 hubIdOf 认的点(11 号订单中心是, B' 本就
  //      收得到它的入边; 束线的增量在枢纽不在同一行时的改面);
  //   ② 入边也收 —— 12 根人工拉的条里 8 根是扇入, 三线合一多半发生在汇入端;
  //   ③ ≥ bundleMin(2)条就收 —— 05 号"让 A 到 BC 的两条线重合"是他写在备注里的。
  // 只收「两端同轴且朝向相对」的 Z 形 / 直线边。U 形 / L 形靠端口次序(erPortRank)避免交叉,
  // 收拢会打乱那个次序 —— B' 的注释里说的"通用几何规则会打乱嵌套/交错顺序"指的就是它们;
  // 把它们排除在外之后, 剩下的同向 Z 形从同一点出发, 嵌套次序仍由阶段 D 的投票决定,
  // 排错了会被终局评估数出交叉、候选整体不采纳。
  // 只动端口, 不并轨道: 枢纽居中时两侧中段区间天然不重叠、自然同轨(梳齿); 含一条正对直线的
  // 一头形态(20 号: 一条直下、两条从同点出发分层走)中段各占一轨。全偏一侧、没有正对的不并
  // (见 erStraddles)。只收 ctx.bundleKeys 点名的束(routeEdges 一束一试); 空集则一个都不收。
  const bundledCount = new Map();   // 束键 → 这一次真正收到正中的端口数(routeEdges 据此判断这一束成没成)
  if (bundle && ctx.bundleKeys && ctx.bundleKeys.size) {
    const fan = new Map();
    const onFace = new Map();   // (rect|side) → 这一面上的全部端口: 束点附近有任何"不属于本束"的端口就不收
    for (const it of sideOrder) {
      if (!it.ra || !it.rb || !it.portA || !it.portB) continue;
      const oa = ER_OUT[it.sa], ob = ER_OUT[it.sb];
      const opposed = erIsVSide(it.sa) === erIsVSide(it.sb) && oa.x === -ob.x && oa.y === -ob.y;
      for (const [port, isSource] of [[it.portA, true], [it.portB, false]]) {
        const faceKey = `${port.rect.id}|${port.side}`;
        if (!onFace.has(faceKey)) onFace.set(faceKey, []);
        const k = opposed && erBundleEligible(it, isSource) ? erBundleKeyOf(it, isSource, port.side) : null;
        onFace.get(faceKey).push({ port, key: k });
        if (!k || !ctx.bundleKeys.has(k)) continue;
        if (!fan.has(k)) fan.set(k, []);
        fan.get(k).push({ port, it, mate: isSource ? it.portB : it.portA, far: isSource ? it.edge.target : it.edge.source });
      }
    }
    for (const [k, members] of fan) {
      // 同源同汇的平行边(两条 A→B)不进束: 收到同一点会完全重合成一条线, 第二条连同标签一起消失
      const seenFar = new Set();
      const uniq = members.filter((m) => { if (seenFar.has(m.far)) return false; seenFar.add(m.far); return true; });
      if (uniq.length < Math.max(2, opt.bundleMin | 0)) continue;
      const first = uniq[0].port;
      const center = erClamp(first.center, first.lo + 2, first.hi - 2);
      // 面正中 portMinPitch 内已有**不属于本束**的端口(手调钉住的 / 反向边 / 别的束 / 另一线型 /
      // 同面入边…): 收拢上去箭头或线会叠在一起, 这一束不收
      const faceKey = `${first.rect.id}|${first.side}`;
      const blocked = (onFace.get(faceKey) || []).some((o) => o.key !== k && Math.abs(o.port.coord - center) < opt.portMinPitch);
      if (blocked) continue;
      let count = 0;
      for (const m of uniq) {
        // "两端口单位"(同一簇里正对、被 erAssignPortSlots 配成同坐标的直线): 只挪一端会把直线
        // 掰成几像素的小折。两端一起挪, 对面挪不到同一坐标(超出它的边)就整条不动。
        // 对面已被别的束收走(mate.bundled)的也不动 —— 前一束优先, 别把它拆散。
        const unit = m.mate && m.mate.key === m.port.key && Math.abs(m.mate.coord - m.port.coord) < 0.5;
        if (unit) {
          if (m.mate.bundled && Math.abs(m.mate.coord - center) > 0.5) continue;
          const mateCoord = erClamp(center, m.mate.lo + 2, m.mate.hi - 2);
          if (Math.abs(mateCoord - center) > 0.5) continue;
          m.mate.coord = mateCoord;
          m.mate.bundled = true;
        } else if (m.mate && !m.mate.bundled && Math.abs(m.mate.coord - center) < opt.alignTol) {
          // 束里那条"对齐直线": 两端中心差几个像素(< alignTol)、本来按源端坐标画成直线。
          // 若只把这一端收到面正中, 直线会落在另一端的坐标上、与束点差 1~4px, 同伴的齿在离
          // 节点几十像素处"穿过"它, 终局评估记一处交叉、整束被否(11 / 20 号人工摆位实测)。
          // 让另一端跟到同一坐标(仍在对齐容差内), 直线就正好压在束点上。
          const mateCoord = erClamp(center, m.mate.lo + 2, m.mate.hi - 2);
          if (Math.abs(mateCoord - center) < 0.5) m.mate.coord = mateCoord;
        }
        m.port.coord = center;
        m.port.bundled = true;
        count += 1;
      }
      bundledCount.set(k, count);
    }
  }

  // ---- 阶段 C: 形状构建(中段坐标仍为符号) ----
  const shapes = [];
  for (const it of sideOrder) {
    if (!it.ra || !it.rb) continue;
    if (it.edge.source === it.edge.target) {
      const loop = erApplySegShifts(
        erSelfLoop(it.ra, it.portA.coord, it.portB.coord), it.edge.segShifts, opt);
      routes.set(it.edge.id, {
        pts: loop.pts, sa: 'right', sb: 'top',
        portA: erPortDescriptor(it.ra, 'right', it.portA.coord),
        portB: erPortDescriptor(it.ra, 'top', it.portB.coord),
        segShifts: loop.shifts, bendCount: loop.shifts.length,
      });
      continue;
    }
    const pa = erPortPoint(it.ra, it.sa, it.portA.coord);
    const pb = erPortPoint(it.rb, it.sb, it.portB.coord);
    shapes.push(erBuildShape(it, pa, pb, opt, hBands, vBands, hit));
  }

  // ---- 阶段 D: 轨道分配(区间图染色 + 引脚穿越投票排序) ----
  const pools = new Map();
  for (const s of shapes) {
    for (const m of s.mids) {
      const poolKey = m.axis + ':' + m.band.index;
      if (!pools.has(poolKey)) pools.set(poolKey, { axis: m.axis, band: m.band, segs: [] });
      pools.get(poolKey).segs.push(m);
    }
  }
  const poolKeys = [...pools.keys()].sort();
  for (const key of poolKeys) {
    const pool = pools.get(key);
    const used = erAssignTracks(pool.segs, pool.band, opt, hug);
    stats.tracks += used;
    if (used > stats.maxTracksInBand) stats.maxTracksInBand = used;
  }

  // ---- 阶段 E: 落坐标 → 腿长合法性钳位 → 手调中间段 ----
  const stairs = new Set();
  for (const s of shapes) {
    const base = erClampInnerLegal(erEmit(s), opt);
    const moved = erApplySegShifts(base, s.item.edge.segShifts, opt);
    if (s.stair && s.stair.outer) stairs.add(s.item.edge.id);
    routes.set(s.item.edge.id, {
      pts: moved.pts, sa: s.item.sa, sb: s.item.sb,
      portA: erPortDescriptor(s.item.ra, s.item.sa, s.item.portA.coord),
      portB: erPortDescriptor(s.item.rb, s.item.sb, s.item.portB.coord),
      segShifts: moved.shifts, bendCount: moved.shifts.length,
      // 束线(设计要点 8)收拢过的端: 调用方(arch-doc 的 autoLayout)据此把束写成端口声明
      bundled: { source: !!s.item.portA.bundled, target: !!s.item.portB.bundled },
    });
  }
  return { routes, stats, stairs, sharedOrigin: !!sharedOrigin, bundled: !!bundle, bundledCount };
}

// 终局评估: 对最终几何按 quality-checker 同口径计数违规, 汇成单一代价。
// 代价 = 违规(交叉/穿节点/穿容器/共线重叠 » 绕行/超弯折 » 弯折贴箭头)
//      + 弯折凹代价(集中优于均摊) + 路径总长(最次要, 但保证"无违规时越短越好")。
// 违规逐项不劣化: 任何一类计数都不许比对照多。只看违规, 不看长度。
function erViolNoWorse(a, b) {
  for (const k of Object.keys(b)) {
    if ((a[k] || 0) > (b[k] || 0)) return false;
  }
  return true;
}

function erEvaluate(routes, ctx) {
  const { opt, rectById, items, cardRects, containerRects } = ctx;
  const list = [];
  for (const it of items) {
    const r = routes.get(it.edge.id);
    if (r && r.pts && r.pts.length >= 2) list.push({ it, pts: r.pts, self: it.edge.source === it.edge.target });
  }
  const involve = new Map();
  const bump = (id) => involve.set(id, (involve.get(id) || 0) + 1);
  // hard: 正在硬穿(节点 / 容器 / 自己背面)的边。阶段 F 用它决定谁有资格改走阶梯形绕外圈。
  const hard = new Set();
  const viol = { crossPairs: 0, nodeCross: 0, containerCross: 0, collinearPairs: 0, nearParallel: 0, backside: 0, detours: 0, bendsOver: 0, lastSegShort: 0, tight: 0 };
  let bendCostSum = 0;
  let totalLen = 0;
  let tightCostSum = 0;

  const nearSharedRect = (p, id) => {
    const r = rectById.get(id);
    if (!r) return false;
    return p.x >= r.x - opt.sharedPortRadius && p.x <= r.x + r.w + opt.sharedPortRadius
        && p.y >= r.y - opt.sharedPortRadius && p.y <= r.y + r.h + opt.sharedPortRadius;
  };

  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const A = list[i], B = list[j];
      const shared = [];
      for (const id of [A.it.edge.source, A.it.edge.target]) {
        if (id === B.it.edge.source || id === B.it.edge.target) shared.push(id);
      }
      let hit = null;
      for (let s1 = 0; s1 < A.pts.length - 1 && !hit; s1 += 1) {
        for (let s2 = 0; s2 < B.pts.length - 1 && !hit; s2 += 1) {
          const p = erProperCross(A.pts[s1], A.pts[s1 + 1], B.pts[s2], B.pts[s2 + 1]);
          if (p && shared.some((id) => nearSharedRect(p, id))) continue;
          hit = p;
        }
      }
      if (hit) { viol.crossPairs += 1; bump(A.it.edge.id); bump(B.it.edge.id); }
      if (!shared.length) {
        let overlapLen = 0;
        for (let s1 = 0; s1 < A.pts.length - 1; s1 += 1) {
          for (let s2 = 0; s2 < B.pts.length - 1; s2 += 1) {
            overlapLen = Math.max(overlapLen,
              erCollinearLen(A.pts[s1], A.pts[s1 + 1], B.pts[s2], B.pts[s2 + 1], opt.collinearGap));
          }
        }
        if (overlapLen > opt.collinearMinOverlap) { viol.collinearPairs += 1; bump(A.it.edge.id); bump(B.it.edge.id); }
      }
      // 近距平行: 不到 QC 的共线阈值, 但两条线视觉上已合并难辨。阈值取
      // min(minSep, portMinPitch) —— 端口阶梯压缩到 portMinPitch 是合法布局, 不误伤。
      //
      // 共享端点的两条边豁免, 与上面 collinearPairs 同口径。原先只豁免了共线、
      // 没豁免近距平行, 于是**弱条件反而比强条件更严**: 从同一个点扇出的两条边,
      // 共线不算违规, 挨得近却算 —— 这一处不一致把"共享起点"候选判死了
      // (case-02 三条决策边同起点是孙毅确认过的意图)。汇入同一个节点本来就该并行一段。
      const nearGap = Math.min(opt.minSep, opt.portMinPitch) - 0.01;
      let nearHit = false;
      if (shared.length) continue;
      for (let s1 = 0; s1 < A.pts.length - 1 && !nearHit; s1 += 1) {
        for (let s2 = 0; s2 < B.pts.length - 1 && !nearHit; s2 += 1) {
          nearHit = erCollinearLen(A.pts[s1], A.pts[s1 + 1], B.pts[s2], B.pts[s2 + 1], nearGap) > 24;
        }
      }
      if (nearHit) { viol.nearParallel += 1; bump(A.it.edge.id); bump(B.it.edge.id); }
    }
  }

  for (const E of list) {
    const exIds = [E.it.edge.source, E.it.edge.target];
    for (const n of cardRects) {
      if (exIds.indexOf(n.id) >= 0) continue;
      const shrunk = erShrink(n, opt.edgeNodeInset);
      for (let s = 0; s < E.pts.length - 1; s += 1) {
        if (erSegEntersRect(E.pts[s], E.pts[s + 1], shrunk)) { viol.nodeCross += 1; bump(E.it.edge.id); hard.add(E.it.edge.id); break; }
      }
    }
    // 背面穿出: 路径纵穿自己的源/目标卡(合法的出线从边界向外走, 永远不会进入内部)
    if (!E.self) {
      for (const id of exIds) {
        const own = rectById.get(id);
        if (!own) continue;
        const shrunk = erShrink(own, opt.edgeNodeInset);
        for (let s = 0; s < E.pts.length - 1; s += 1) {
          if (erSegEntersRect(E.pts[s], E.pts[s + 1], shrunk)) { viol.backside += 1; bump(E.it.edge.id); hard.add(E.it.edge.id); break; }
        }
      }
    }
    for (const c of containerRects) {
      if (exIds.indexOf(c.id) >= 0) continue;
      const sRect = rectById.get(E.it.edge.source);
      const tRect = rectById.get(E.it.edge.target);
      if ((sRect && erCenterInRect(sRect, c)) || (tRect && erCenterInRect(tRect, c))) continue;
      const shrunk = erShrink(c, opt.edgeNodeInset);
      for (let s = 0; s < E.pts.length - 1; s += 1) {
        if (erSegEntersRect(E.pts[s], E.pts[s + 1], shrunk)) { viol.containerCross += 1; bump(E.it.edge.id); hard.add(E.it.edge.id); break; }
      }
    }
    // 贴边: 与非端点盒平行贴行且净空不足 clearMin。按缺多少线性计费, 只取该边最坏的一处
    // —— 一条边贴着几个盒子走是同一个毛病(带子选低了), 重复计费会盖过真违规的权重。
    if (opt.clearMin > 0 && opt.clearPenalty > 0) {
      let worst = Infinity;
      const boxes = containerRects.length ? cardRects.concat(containerRects) : cardRects;
      for (const box of boxes) {
        if (exIds.indexOf(box.id) >= 0) continue;
        const sRect = rectById.get(E.it.edge.source);
        const tRect = rectById.get(E.it.edge.target);
        // 装着自己端点的容器不算(出入自己的容器边界是合法的), 与 containerCross 同口径
        if ((sRect && erCenterInRect(sRect, box)) || (tRect && erCenterInRect(tRect, box))) continue;
        for (let s = 0; s < E.pts.length - 1; s += 1) {
          const g = erSegRectClear(E.pts[s], E.pts[s + 1], box);
          if (g < worst) worst = g;
        }
      }
      if (worst < opt.clearMin) {
        viol.tight += 1;
        bump(E.it.edge.id);   // 进 involve, 阶段 F 才有资格给它重选带
        tightCostSum += (opt.clearMin - worst) / opt.clearMin * opt.clearPenalty;
      }
    }
    const len = erPathLen(E.pts);
    totalLen += len;
    const bends = erBendsOf(E.pts);
    bendCostSum += erBendCost(bends) * opt.bendPenalty;
    if (bends > opt.maxBends) { viol.bendsOver += 1; bump(E.it.edge.id); }
    if (!E.self) {
      const head = E.pts[0], tail = E.pts[E.pts.length - 1];
      const direct = Math.abs(head.x - tail.x) + Math.abs(head.y - tail.y);
      if (len > opt.detourMinLength && direct > 0 && len / direct > opt.detourRatio) {
        viol.detours += 1;
        bump(E.it.edge.id);
      }
      if (opt.minLastSeg > 0 && E.pts.length >= 3) {
        const firstSeg = Math.abs(E.pts[1].x - E.pts[0].x) + Math.abs(E.pts[1].y - E.pts[0].y);
        const lastSeg = Math.abs(tail.x - E.pts[E.pts.length - 2].x) + Math.abs(tail.y - E.pts[E.pts.length - 2].y);
        if (firstSeg < opt.minLastSeg - 1e-6) { viol.lastSegShort += 1; bump(E.it.edge.id); }
        if (lastSeg < opt.minLastSeg - 1e-6) { viol.lastSegShort += 1; bump(E.it.edge.id); }
      }
    }
  }

  const cost = viol.crossPairs * opt.crossPenalty
    + (viol.nodeCross + viol.backside) * opt.nodeCrossPenalty
    + viol.containerCross * opt.containerCrossPenalty
    + viol.collinearPairs * opt.collinearPenalty
    + viol.nearParallel * opt.nearParallelPenalty
    + (viol.detours + viol.bendsOver) * opt.detourPenalty
    + viol.lastSegShort * opt.lastSegPenalty
    + tightCostSum
    + bendCostSum
    + totalLen * opt.lengthWeight;
  return { cost, involve, viol, hard };
}

// 生成一个端口请求。isSource 决定它挂在源端还是目标端。
function erMakePort(it, isSource, opt, hBands, vBands) {
  const rect = isSource ? it.ra : it.rb;
  const other = isSource ? it.rb : it.ra;
  const side = isSource ? it.sa : it.sb;
  const vertical = erIsVSide(side);
  // 端口朝外的方向: top 朝上(-1), bottom 朝下(+1), left 朝左(-1), right 朝右(+1)
  const dir = vertical ? ER_OUT[side].y : ER_OUT[side].x;
  const bands = vertical ? hBands : vBands;
  const band = erBandOfPort(bands, erSideFixed(rect, side), dir);
  const center = erSideCenter(rect, side);
  const farCenter = vertical ? other.x + other.w / 2 : other.y + other.h / 2;
  // 轴对齐直线: 两侧朝向相反且中心共线 —— 该端口须独占中心槽以保留直线
  const oa = ER_OUT[it.sa], ob = ER_OUT[it.sb];
  const opposed = erIsVSide(it.sa) === erIsVSide(it.sb) && oa.x === -ob.x && oa.y === -ob.y;
  const anchor = opposed && Math.abs(erSideCenter(it.ra, it.sa) - erSideCenter(it.rb, it.sb)) < opt.alignTol;
  // 粗分组只按"朝向 + 所经通道"; 同通道内再按邻近聚类切细, 避免量化分桶在边界把该协同的端口拆开
  const key = (vertical ? 'V' : 'H') + ':' + (band ? band.index : 'x' + rect.id + side);
  const pin = isSource ? it.pinA : it.pinB;
  const port = {
    key, rect, side, vertical, center, farCenter, anchor,
    sameAxis: erIsVSide(it.sa) === erIsVSide(it.sb),
    uShape: it.sa === it.sb,
    order: it.index,
    coord: pin ? erPortCoord(rect, pin) : center,
    pinned: !!pin,
    lo: erSideLo(rect, side), hi: erSideHi(rect, side),
  };
  if (isSource) it.portA = port; else it.portB = port;
  return port;
}

// 单位在带内的形态:
//   dir  -1 往小坐标去 / +1 往大坐标去 / 0 带内没有横段
//   nest true = "U 形"(两个引脚都从带的同一侧插进来, 边在带里挂一段又拐回去)
//        false = "穿越形"(一个引脚从 lo 侧、另一个从 hi 侧, 边横穿整条带)
// 只有 Z 形(两端同轴)才在这条带里横穿; L 形从这个端口引出的是一条直腿, 横段落在别处,
// 与本组的嵌套无关, 记 dir=0。双端口单位("正对")是直线, 同样记 0。
function erPortShape(u, opt) {
  const p = u.ports[0];
  if (u.ports.length > 1 || !p.sameAxis) return { dir: 0, nest: false };
  const reach = u.farCenter - u.center;
  return {
    dir: Math.abs(reach) <= opt.alignTol ? 0 : (reach > 0 ? 1 : -1),
    nest: p.uShape,
  };
}

// 组内次序: 先按走向分块, 块内再按 U 形/穿越形分块, 最后按远端坐标排。
//
// 关键在于两类边的排法是**相反**的, 这也是最容易改错的地方:
//
//   U 形(如两条边同时挂在某个节点底边上, 往同一侧跑): 谁跑得远谁占外圈轨道, 而外圈那条
//   的引脚必须落在"上游"一侧, 否则它的引脚要从内圈那条的横段上穿过去。远端越远 → 端口
//   坐标越小(往右跑)或越大(往左跑), 两种情况都等价于**按 farCenter 降序**。
//   按升序排(旧做法)会让两条边的横段互相交错, 轨道怎么排都必然交叉一次 —— case-08 的
//   e_gate/e_camera 同时汇入边缘网关底边、case-09 的 e-logs/e-production 同时挂在生产
//   集群底边, 都是这么撞出来的。
//
//   穿越形(如 b3 底边出、c0 顶边入, 横穿整条带): 两条边的引脚一个在 lo 侧一个在 hi 侧,
//   区间只要嵌套反而必然交叉一次, 交错才不交叉 —— 所以**按 farCenter 升序**(旧做法在这
//   一类上本来就是对的, 不能一起改掉)。
//
// 两类混在同一走向里时, 穿越形要占"下游"一侧: 往右跑时穿越形在前(小坐标), 往左跑时在后。
// 这样 U 形的两个引脚都落在穿越形的区间之外, 谁在内圈谁在外圈都不会撞。
function erPortRank(p, q) {
  return (p.dir - q.dir) || (p.cls - q.cls) || (p.far - q.far)
    || (p.order - q.order) || (p.center - q.center);
}

// 组内槽位阶梯。
// 单位(unit)不是端口而是"必须共坐标的一束端口": 一条边的两个端口若落进同一组, 说明它们
// 隔着同一条带正对, 必须共用一个坐标才能连成直线 —— 拆成两个槽位会把直线掰成折线。
// 次序按"走向分块 + 块内嵌套"(见 erPortRank), 轴对齐的单位独占中心槽。
function erAssignPortSlots(all, opt) {
  // 手调钉住的端点不参与分配: 它的坐标是用户给的, 挪走就等于没钉住。
  const group = all.filter((p) => !p.pinned);
  if (!group.length) return;
  const unitMap = new Map();
  for (const p of group) {
    const k = String(p.order);
    if (!unitMap.has(k)) unitMap.set(k, { ports: [], order: p.order, anchor: false });
    const u = unitMap.get(k);
    u.ports.push(p);
    if (p.anchor) u.anchor = true;
  }
  const units = [...unitMap.values()];
  for (const u of units) {
    u.center = u.ports.reduce((a, p) => a + p.center, 0) / u.ports.length;
    // 双端口单位("正对"): 远端就是自己, 排序键取自身中心
    u.farCenter = u.ports.length > 1 ? u.center
      : u.ports.reduce((a, p) => a + p.farCenter, 0) / u.ports.length;
  }
  const n = units.length;
  const apply = (u, coord) => { for (const p of u.ports) p.coord = erClamp(coord, p.lo + 2, p.hi - 2); };
  for (const u of units) {
    const s = erPortShape(u, opt);
    u.dir = s.dir;
    u.cls = s.dir === 0 ? 0 : ((s.dir < 0) === s.nest ? 0 : 1);
    u.far = s.nest ? -u.farCenter : u.farCenter;
  }
  units.sort(erPortRank);
  if (n === 1) { apply(units[0], units[0].center); erAvoidPinned(all, units, opt); return; }

  let allowedLo = -Infinity, allowedHi = Infinity;
  for (const p of group) {
    allowedLo = Math.max(allowedLo, p.lo + opt.portInset);
    allowedHi = Math.min(allowedHi, p.hi - opt.portInset);
  }
  if (allowedLo >= allowedHi) {
    // 组内节点在该轴上重叠不足(宽度差异过大等), 退化为按节点各自分配
    const byNode = new Map();
    for (const p of group) {
      const k = p.rect.id + ':' + p.side;
      if (!byNode.has(k)) byNode.set(k, []);
      byNode.get(k).push(p);
    }
    if (byNode.size > 1) { for (const sub of byNode.values()) erAssignPortSlots(sub, opt); return; }
    const shrink = Math.min(opt.portInset, group[0].rect.w / 4, group[0].rect.h / 4);
    allowedLo = group[0].lo + shrink;
    allowedHi = group[0].hi - shrink;
  }

  let anchorIdx = -1;
  for (let i = 0; i < n; i += 1) if (units[i].anchor) { anchorIdx = i; break; }
  const base = anchorIdx >= 0 ? units[anchorIdx].center
    : erClamp(units.reduce((a, u) => a + u.center, 0) / n, allowedLo, allowedHi);
  const below = anchorIdx >= 0 ? anchorIdx : (n - 1) / 2;
  const above = anchorIdx >= 0 ? (n - 1 - anchorIdx) : (n - 1) / 2;
  const room = Math.min(below > 0 ? (base - allowedLo) / below : Infinity,
                        above > 0 ? (allowedHi - base) / above : Infinity);
  const pitch = Math.max(opt.portMinPitch, Math.min(opt.portPitch, room));
  for (let i = 0; i < n; i += 1) {
    apply(units[i], erClamp(base + (i - below) * pitch, Math.min(allowedLo, base), Math.max(allowedHi, base)));
  }
  // 锚点必须精确落在中心, 否则直线会歪
  if (anchorIdx >= 0) apply(units[anchorIdx], units[anchorIdx].center);
  erAvoidPinned(all, units, opt);
}

// 钉住的端口(用户手钉 / 束线落成的端口声明)不参与阶梯, 但阶梯不能压到它身上: 同一簇里剩下的
// 端口若离某个钉住的坐标不到 portMinPitch, 往远离它的一侧推开 —— 否则束线落成端口声明之后,
// 同面上剩下的那一个端口按 n===1 直接回到面正中, 正好压在束点上(02 / 20 号实测),
// 采纳时评估过的几何与最终渲染就对不上了。
function erAvoidPinned(all, units, opt) {
  const pinned = all.filter((p) => p.pinned).map((p) => p.coord);
  if (!pinned.length) return;
  for (const u of units) {
    if (u.anchor) continue;   // 正对直线的锚点不挪: 挪了直线就歪, 与钉住端口叠也是钉的一方该让
    for (const p of u.ports) {
      let c = p.coord;
      for (let guard = 0; guard < 4; guard += 1) {
        const hit = pinned.find((pc) => Math.abs(c - pc) < opt.portMinPitch);
        if (hit === undefined) break;
        const dir = c >= hit ? 1 : -1;
        const pushed = hit + dir * opt.portMinPitch;
        // 推出边界就往另一边推
        c = pushed >= p.lo + 2 && pushed <= p.hi - 2 ? pushed : hit - dir * opt.portMinPitch;
      }
      p.coord = erClamp(c, p.lo + 2, p.hi - 2);
    }
  }
}

// 形状: 直线 / Z 形(1 条待定中段) / L 形(坐标已定) / 阶梯形(2 条待定中段)。
// 待定中段统一挂在 shape.mids 上, 由阶段 D 一起做轨道分配 —— 阶梯形也因此和 Z 形共用
// 同一套轨道, 不会跟别的边并出 9px 的"视觉合并"。
function erBuildShape(it, pa, pb, opt, hBands, vBands, hit) {
  const oa = ER_OUT[it.sa], ob = ER_OUT[it.sb];
  const axisA = oa.x ? 'h' : 'v', axisB = ob.x ? 'h' : 'v';
  const ex = [it.edge.source, it.edge.target];
  const shape = { item: it, pa, pb, mids: [], pts: null };
  // mid: 一条待定中段。axis 是它自己的走向('h' 横向落在 hBand, 'v' 纵向落在 vBand)。
  // span 是它在自身走向上的区间(区间图染色用), legs 是两端引脚(排轨道的投票用)。
  // prefer 是"没人跟它抢时想落在哪": 只有绕行的两条腿会填, 值是各自端口引出一个 stub
  // 的落点。带里但凡有第二条中段跟它区间重叠, 阶段 D 的轨道阶梯就接管, prefer 作废。
  const mkMid = (axis, band, span, legs, prefer) => ({ item: it, axis, band, span, legs, prefer, track: band.center });

  if (axisA === axisB) {
    const vertical = axisA === 'v';
    const sameCoord = vertical ? Math.abs(pa.x - pb.x) : Math.abs(pa.y - pb.y);
    const opposed = vertical ? (oa.y === -ob.y) : (oa.x === -ob.x);
    if (opposed && sameCoord < opt.alignTol) {
      shape.pts = vertical ? [pa, { x: pa.x, y: pb.y }] : [pa, { x: pb.x, y: pa.y }];
      return shape;
    }
    // 中段落在空闲带的某条轨道上(带的选择与阶段 A 打分同源);
    // 阶段 F 重选时可通过 it.bandIdx 强制指定候选带(必须仍在两端口的朝外一侧)。
    const bands = vertical ? hBands : vBands;
    let band = null;
    if (Number.isFinite(it.bandIdx)) {
      const forced = bands.find((b) => b.index === it.bandIdx);
      if (forced) {
        const dirA = vertical ? oa.y : oa.x, dirB = vertical ? ob.y : ob.x;
        const fA = vertical ? pa.y : pa.x, fB = vertical ? pb.y : pb.x;
        const okA = dirA > 0 ? forced.lo >= fA - 0.5 : forced.hi <= fA + 0.5;
        const okB = dirB > 0 ? forced.lo >= fB - 0.5 : forced.hi <= fB + 0.5;
        if (okA && okB) band = forced;
      }
    }
    if (!band) {
      band = erPickBand(bands,
        vertical ? pa.y : pa.x, vertical ? oa.y : oa.x,
        vertical ? pb.y : pb.x, vertical ? ob.y : ob.x, opt.stub).band;
    }
    shape.mids.push(mkMid(vertical ? 'h' : 'v', band,
      vertical ? [pa.x, pb.x] : [pa.y, pb.y],
      // 引脚从带的哪一侧进入: 决定"想在上"还是"想在下"
      [{ coord: vertical ? pa.x : pa.y, fromLo: (vertical ? pa.y : pa.x) <= band.lo + 0.5 },
       { coord: vertical ? pb.x : pb.y, fromLo: (vertical ? pb.y : pb.x) <= band.lo + 0.5 }]));
    return shape;
  }

  // L 形: 拐点由两个端口唯一确定。只认「垂直拐点」——对角那个拐点会让首段沿着
  // 端口所在的边滑出去, 违反「首尾段垂直于所接的边」(手调端点后这条规则是可见契约)。
  const clear = (pts) => hit.pathClear(pts, ex) && hit.boxClear(pts, it.edge.source, it.edge.target);
  const lPts = erDedupe([pa, erCorners(pa, axisA, pb)[0], pb]);
  if (clear(lPts)) { shape.pts = lPts; return shape; }
  // L 被挡: 改走两段绕行(4 段) —— 首尾仍是各自端口的垂直引出, 中间两条腿各落在一条
  // 空闲带上, 由近及远取第一个干净的组合。两条腿都挂进 shape.mids, 所以它们和 Z 形
  // 共用阶段 D 的轨道分配: 同一侧并排绕出去的几条边会被拉开, 不会压成同一条线。
  const stubLen = Math.max(opt.stub, opt.minLastSeg || 0);
  const plan = erStairPlan(pa, it.sa, pb, it.sb, hBands, vBands, opt, clear);
  if (plan && plan.clear) {
    const aAxis = plan.aIsH ? 'v' : 'h';   // A 侧那段的走向
    const bAxis = plan.aIsH ? 'h' : 'v';   // B 侧那段的走向
    const aSpan = plan.aIsH ? [pa.y, plan.bBand.center] : [pa.x, plan.bBand.center];
    const bSpan = plan.aIsH ? [plan.aBand.center, pb.x] : [plan.aBand.center, pb.y];
    shape.mids.push(mkMid(aAxis, plan.aBand, aSpan, [
      { coord: aSpan[0], fromLo: (plan.aIsH ? pa.x : pa.y) <= plan.aBand.lo + 0.5 },
      { coord: aSpan[1], fromLo: (plan.aIsH ? pb.x : pb.y) <= plan.aBand.lo + 0.5 },
    ], plan.aIsH ? pa.x + oa.x * stubLen : pa.y + oa.y * stubLen));
    shape.mids.push(mkMid(bAxis, plan.bBand, bSpan, [
      { coord: bSpan[0], fromLo: (plan.aIsH ? pa.y : pa.x) <= plan.bBand.lo + 0.5 },
      { coord: bSpan[1], fromLo: (plan.aIsH ? pb.y : pb.x) <= plan.bBand.lo + 0.5 },
    ], plan.aIsH ? pb.y + ob.y * stubLen : pb.x + ob.x * stubLen));
    shape.stair = plan;
    return shape;
  }
  // 全被挡: 在两个垂直候选里按"真穿进节点"的条数取舍 —— 外扩留白只是偏好, 不该把
  // 路线推回真穿节点的那条; 平手取折数少的 L。第二个候选是贴身四折(各自引出 stub
  // 再折), 引出长度吃箭头净空: 折点离箭头太近, 箭头样式就毁了。
  const stubA = { x: pa.x + oa.x * stubLen, y: pa.y + oa.y * stubLen };
  const stubB = { x: pb.x + ob.x * stubLen, y: pb.y + ob.y * stubLen };
  const knee = axisA === 'h' ? { x: stubA.x, y: stubB.y } : { x: stubB.x, y: stubA.y };
  const detour = erDedupe([pa, stubA, knee, stubB, pb]);
  let best = null;
  for (const pts of [lPts, detour]) {
    const deep = hit.deepHits(pts, ex);
    if (!best || deep < best.deep) best = { deep, pts };
  }
  shape.pts = best.pts;
  return shape;
}

// 区间图染色 + 投票排序。返回占用的轨道数。
function erAssignTracks(segs, band, opt, hug) {
  if (!segs.length) return 0;
  const inSpan = (c, span) => c > Math.min(span[0], span[1]) + 0.5 && c < Math.max(span[0], span[1]) - 0.5;
  for (const a of segs) {
    let vote = 0;
    for (const b of segs) {
      if (b === a) continue;
      for (const leg of a.legs) if (inSpan(leg.coord, b.span)) vote += leg.fromLo ? -1 : 1;
    }
    a.vote = vote;
  }
  const spanLen = (s) => Math.abs(s.span[1] - s.span[0]);
  // 票数小者靠近带的 lo 侧; 平票时长段在外, 短段在内(嵌套), 再平则按边序保确定性
  segs.sort((p, q) => (p.vote - q.vote) || (spanLen(q) - spanLen(p)) || (p.item.index - q.item.index));

  const slots = []; // slots[i] = 已占该槽的区间数组
  for (const s of segs) {
    let idx = 0;
    for (; idx < slots.length; idx += 1) {
      const clash = slots[idx].some((o) => erSpanOverlap(s.span[0], s.span[1], o.span[0], o.span[1]) > 0.5);
      if (!clash) break;
    }
    if (idx === slots.length) slots.push([]);
    slots[idx].push(s);
    s.slot = idx;
  }
  const used = slots.length;
  // 箭头前端净空: 引脚(首/末直线段)的长度 = |轨道 - 带边界|, 轨道离带边至少要有
  // minLastSeg, 否则弯折顶到箭头跟前。带太窄时以 band.size/3 为上限退让(几何上放不下)。
  const clearance = opt.minLastSeg > 0 ? Math.min(opt.minLastSeg, band.size / 3) : 0;
  const margin = Math.max(Math.min(opt.bandMargin, band.size / 4), clearance);
  const usableLo = band.lo + margin;
  const usableHi = band.hi - margin;
  const room = usableHi - usableLo;
  const pitch = used > 1
    ? Math.max(opt.trackMinPitch, Math.min(opt.trackPitch, room / (used - 1)))
    : 0;
  const center = erClamp(band.center, usableLo + pitch * (used - 1) / 2, usableHi - pitch * (used - 1) / 2);
  for (const s of segs) s.track = center + (s.slot - (used - 1) / 2) * pitch;
  // 只有一条轨道 = 带里的中段两两不重叠, 谁落在哪儿都不会跟别人并线。此时绕行的腿
  // 回到它自己的 prefer(贴着端口引出一个 stub 就转), 把整条通道的正中让出来 ——
  // 正中那条线是横穿这条带的边、以及它们的标签唯一的落脚处(见 trackPitch 的注释)。
  // 两处例外照旧走正中: 最外圈那两条虚拟带本来就是给绕行开的, 没人跟它抢正中;
  // 腿被挤到更远的带上时 prefer 落在带外, 贴过去就贴到别人的卡片边上了。
  if (hug && used === 1 && !band.outermost) {
    for (const s of segs) {
      if (Number.isFinite(s.prefer) && s.prefer >= usableLo && s.prefer <= usableHi) s.track = s.prefer;
    }
  }
  return used;
}

function erEmit(shape) {
  if (shape.pts) return shape.pts;
  const { pa, pb, mids } = shape;
  if (shape.stair) return erDedupe(erStairPts(pa, pb, shape.stair, mids[0].track, mids[1].track));
  const track = mids[0].track;
  const pts = mids[0].axis === 'h'
    ? [pa, { x: pa.x, y: track }, { x: pb.x, y: track }, pb]
    : [pa, { x: track, y: pa.y }, { x: track, y: pb.y }, pb];
  return erDedupe(pts);
}

// 残留共线重合自检(供构建期打印, 正常应为 0)
function erCountResidual(routes, minSep) {
  const segs = [];
  routes.forEach((r, id) => {
    for (let i = 1; i < r.pts.length; i += 1) segs.push({ id, a: r.pts[i - 1], b: r.pts[i] });
  });
  let n = 0;
  for (let i = 0; i < segs.length; i += 1) for (let j = i + 1; j < segs.length; j += 1) {
    const A = segs[i], B = segs[j];
    if (A.id === B.id) continue;
    const aH = Math.abs(A.a.y - A.b.y) < 0.6, bH = Math.abs(B.a.y - B.b.y) < 0.6;
    const aV = Math.abs(A.a.x - A.b.x) < 0.6, bV = Math.abs(B.a.x - B.b.x) < 0.6;
    if (aH && bH && Math.abs(A.a.y - B.a.y) < minSep
      && erSpanOverlap(A.a.x, A.b.x, B.a.x, B.b.x) > 24) n += 1;
    else if (aV && bV && Math.abs(A.a.x - B.a.x) < minSep
      && erSpanOverlap(A.a.y, A.b.y, B.a.y, B.b.y) > 24) n += 1;
  }
  return n;
}
