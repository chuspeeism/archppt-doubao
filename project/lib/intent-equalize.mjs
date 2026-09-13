// lib/intent-equalize.mjs —— 意图化等化求解器（纯函数，不进产物）。
//
// 出处：八份手调日志（tests/fixtures/tuning-logs/）的等化反事实实验。结论是
// 手调终稿里 1–9px 的档内不齐是操作精度噪声，等化零损失；但另一批差异承载
// 信息（尺寸两档、间距分层、对齐轴），绝不能抹平。本求解器把前者收敛、把
// 后者当硬约束保护，产出「意图几何基准夹具」（scripts/build-intent-baselines.mjs）。
//
// 只动 spec.positions 与节点几何（x/y/w/h）；edges 的 sourcePort/targetPort/
// segShifts/labelT 与 frame 一律不碰。三类候选变换：
//   a) 锚线吸附：边线/中线与多数派线或容器矩形线差 ≤8px 时吸附；
//   b) 尺寸档内统一：同容器组 w/h 聚类定出档代表值，簇内改动 ≤10px 统一过去。
//      整批被护栏拒之后的回退阶梯是「整体 → **互锁连通分量** → 逐成员」，分组
//      不认容器边界（见 interlockGroups）；
//   c) 行/列间距等化：先整行均匀（位移 ≤10px 才行），不行再按 ≥12px 档差
//      分层、层内统一；间距低于质检 minSpacing 的先提升到 minSpacing。
//      **三段各有一族摆法，一律依次试、取第一个过护栏的**：
//        c1 起端钉位 / 末端钉位 / 对称居中 / 等宽微缩两端钉位；
//        c2 两端钉位 / 挪首成员·末端钉位 / 挪末成员·起端钉位；
//        c3 段首为锚（往后铺）/ 挪首成员·段末为锚（往前铺）。
//      c2、c3 的「挪首成员」是补进来的（见 uniformPlans）：候选集里只有「往后铺」
//      时，自由成员恰好在段首的行整行无解——04 的 lis 就是这个几何。
// rejected 是**完整账本**：所有试过并被拒的候选都留着，被后续摆法取代的标
// superseded/supersededBy，让夹具不靠 README 就能审计「为什么是这个摆法」。
// 两条硬约束（缺一不可）：
//   ① 保护性不变量：既有 0px 精确对齐（边线-边线/中线-中线/节点-容器矩形，同名
//      特征）改动后必须全部保持；吸附与间距等化还要求不把节点从任何既有多成员线
//      上挪走——方向永远是「创造对齐、不销毁对齐」。
//      典型陷阱见日志 09：argo/harbor y=585 与长条 y=584 差 1px，但三者中线
//      同为 y=620 精确对齐，把 585 吸到 584 是错的。
//      **枚举不认容器边界**：叶-叶关系一律全部两两（含跨父），只加投影带条件。
//      按父分桶的后果见 02（kafka 的 x=1020 / cx=1154.5 / r=1289 跨三个父，行间距
//      均匀化挪它 9px 一次销毁 8 条）与 08（security_linkage.r==rule_engine.r==1163）。
//      **容器线要按「会漂移」放大枚举范围**：容器矩形由子节点包围盒派生，被动
//      叶子一动，祖先容器的边线就跟着跑，此时挂在这条容器线上的「其它没被动的
//      节点 / 其它容器」的对齐会被静默销毁。所以先算出被动叶子的全部祖先容器，
//      对这些容器把枚举扩到「全部叶子 × 该容器」与「容器 × 容器（含跨父）」；
//      不受影响的容器维持原范围，避免枚举爆炸。漏这一条的后果见日志 05：三召回
//      卡对称外扩把 recall_layer 顶宽 6px，rerank_diversity.r==recall_layer.r
//      ==960、client.x==recall_layer.x==119、collection.x==online_recommendation.x
//      ==95 三条可见对齐一起断，而旧枚举一条都看不见。
//   ② 评分护栏：每个候选应用后用 buildScene+checkQuality 复算——分数不许降、
//      不许出现新 issue 类型、逐节点 fit(lines/subLines/tier) 不变、padX 除
//      缩宽的几何归因份额（Δw/2）外不许变小、自量四向出框量不许变大。
//      违反即整条拒绝并记入 rejected。**回退不许有破坏性**：为保住既有对齐而钉的
//      锚位被护栏拒绝后，不许滑到会销毁该对齐的其它锚位，整条候选拒绝并成文记录。
// 确定性与幂等：同输入同输出；对输出再跑一遍不再产生 changes。
import { cloneSpec, fromBuildSpec, buildScene, qualityOptionsOf, qualityThresholdsOf } from './arch-doc.mjs';
import { checkQuality } from './quality-checker.mjs';

const DEFAULTS = Object.freeze({
  snapTol: 8,    // a) 吸附距离上限
  sizeTol: 10,   // b) 尺寸档内统一的最大改动（也是聚类的单链阈值）
  maxShift: 10,  // 任一节点相对输入的累计位移上限
  tierGap: 12,   // c) 间距档差：相邻间距差 ≥ 该值视为两个档，层差保留。
                 //    只用于分层，**不再充当「销毁多成员轴线」的豁免**（见 loseLineMovers）
});

const AXES = {
  x: { feats: ['x', 'cx', 'r'], pos: 'x', size: 'w', end: 'r', mid: 'cx' },
  y: { feats: ['y', 'cy', 'b'], pos: 'y', size: 'h', end: 'b', mid: 'cy' },
};

const rectOfPos = (p) => ({
  x: p.x, y: p.y, w: p.w, h: p.h,
  r: p.x + p.w, b: p.y + p.h, cx: p.x + p.w / 2, cy: p.y + p.h / 2,
});

function leafList(spec) {
  const out = [];
  const walk = (nodes, parent, chain) => {
    for (const n of nodes || []) {
      if (Array.isArray(n.children) && n.children.length) { walk(n.children, n.id, [...chain, n.id]); continue; }
      if (n.id != null) out.push({ id: n.id, parent: parent || '@root', ancestors: new Set(chain) });
    }
  };
  walk(spec.nodes, null, []);
  return out;
}

function evaluate(spec) {
  const s = fromBuildSpec(spec);
  const scene = buildScene(s);
  const report = checkQuality(scene, qualityOptionsOf(s));
  return { scene, report };
}

// 护栏基线：分数、issue 类型集、逐节点 fit/padX、自量四向出框量、容器矩形
function guardBaseline(spec) {
  const { scene, report } = evaluate(spec);
  const fit = new Map();
  const padX = new Map();
  const over = new Map();
  const frame = spec.frame;
  for (const n of scene.nodes) {
    fit.set(n.id, `${n.fit.lines}/${n.fit.subLines}/${n.fit.tier}`);
    padX.set(n.id, n.padX);
    over.set(n.id, [
      Math.max(0, frame.x - n.x),
      Math.max(0, (n.x + n.w) - (frame.x + frame.w)),
      Math.max(0, frame.y - n.y),
      Math.max(0, (n.y + n.h) - (frame.y + frame.h)),
    ]);
  }
  const containers = new Map(scene.containers.map((c) => [c.id, rectOfPos(c)]));
  return { scene, report, fit, padX, over, containers, types: new Set(report.issues.map((i) => i.type)) };
}

/* ---------------- 视觉轴的单一口径 ---------------- */

// 投影带：x 族特征（x/cx/r）画的是竖线，两矩形要在 **x 区间**上相交，才算「同一条
// 竖轴上下堆叠」；y 族（y/cy/b）画横线，要求 **y 区间**相交。条件只看族、不看具体
// 特征——x 与 r 画的是同一族的线，带条件完全一样。
function inProjectionBand(ra, rb, f) {
  const axis = AXES.x.feats.includes(f) ? AXES.x : AXES.y;
  return Math.min(ra[axis.end], rb[axis.end]) - Math.max(ra[axis.pos], rb[axis.pos]) > 0;
}

// 两个矩形是否落在同一条视觉轴上：**同名（或同族）特征相等 + 投影带相交**。
// 这是全模块唯一的一份判定，linesOf / membershipsOf / loseLineMovers / anchorPrefs /
// invariantRelations / interlockGroups 全部走它——口径分家过一次，代价是 04：
// nurse.b == db.y == 496 值相等，但 nurse 的 y 区间 408..496 与 db 的 496..608 只在端点
// 496 相接、重叠为 0——那是「上下相邻」不是「同一条横线」。invariantRelations 带着投影带
// 条件（正确地）不认它，loseLineMovers 不带（错误地）认了，于是「nurse 会销毁对齐」
// 这个否决理由是假的，doctor/nurse/selfhelp 的列等化被一条不存在的轴挡了下来。
// 反过来 his.y == db.y == 496（等化把 his 从 495 吸上来才产生）纵向重叠 56px，是真轴，
// 照旧认——投影带滤掉的是相接，不是并排。
export function onSameVisualAxis(ra, rb, fa, fb = fa) {
  return ra[fa] === rb[fb] && inProjectionBand(ra, rb, fa);
}

// 轴向线表：值 → 落在该值上的节点 id 集（任一同族特征命中即算）。不认容器边界，
// 因为「视觉上的一条线」不分容器。取成员一律走 partnersAt——**值相等只是入场券，
// 还要与参照节点过投影带**。用于 a) 的多数派与零销毁判定、c) 的等化不许把节点挪下线。
function linesOf(spec, leaves, axis) {
  const feats = AXES[axis].feats;
  const rects = new Map();
  for (const { id } of leaves) {
    const p = spec.positions[id];
    if (p) rects.set(id, rectOfPos(p));
  }
  const byValue = new Map();
  for (const [id, rc] of rects) {
    for (const f of feats) {
      if (!byValue.has(rc[f])) byValue.set(rc[f], new Set());
      byValue.get(rc[f]).add(id);
    }
  }
  return {
    values: byValue,
    // 与 id 同处一条视觉轴、落在 value 上的其它成员（已过投影带）
    partnersAt(id, value) {
      const rc = rects.get(id);
      const set = byValue.get(value);
      if (!rc || !set) return [];
      return [...set].filter((qid) => qid !== id && inProjectionBand(rects.get(qid), rc, feats[0]));
    },
  };
}

// 节点当前压着的那些线（每条附同轴伙伴，理由文案要点名到人才可复核）
const membershipsOf = (lines, spec, id, axis) => {
  const rc = rectOfPos(spec.positions[id]);
  const out = [];
  for (const f of AXES[axis].feats) {
    const partners = lines.partnersAt(id, rc[f]);
    if (partners.length) out.push({ feat: f, value: rc[f], partners });
  }
  return out;
};

const lineText = (ms) => ms.map((m) => `${m.feat}=${m.value}（同轴 ${m.partners.join('、')}）`).join('、');

// 0px 精确对齐关系（不变量 ① 的枚举范围）。叶-叶走 onSameVisualAxis（同名特征相等
// ＋投影带相交）。**容器那两段有意不加投影带条件**：容器矩形是子节点包围盒的派生量，
// 一条边线断了会连锁到挂在它上面的所有东西，护栏这里取更宽的一档（值相等即保护），
// 与「容器线守门×8」那条断言的枚举范围一致。返回可复核的关系表。三段范围：
//   · **全部叶子两两（含跨父）**，至少一端被动；
//   · 叶子 × 容器矩形——被动叶子对全部容器，**外加全部叶子对「会漂移的容器」**；
//   · 容器 × 容器（含跨父）——至少一端会漂移。
// 叶-叶不许按父分桶：视觉上的一条轴线不认容器边界。漏这一条的后果实测两处——
// 02 的 kafka.x==flink.x==model-service.x==1020、cx==1154.5、r==1289（还串着
// decision-center / verify 的右缘）跨三个父，行间距均匀化把 kafka 挪 9px 一次销毁
// 8 条关系；08 的 security_linkage.r==rule_engine.r==1163 跨父，被尺寸档统一撞断。
// 「会漂移的容器」＝被动叶子的全部祖先。容器矩形是子节点包围盒派生的，被动叶子
// 一动这些容器的边线就跟着跑；不把范围放大到全部叶子/全部容器，挂在这条线上的
// 对齐就没有任何东西盯着（05 的容器线不变量漏洞）。
function invariantRelations(spec, leaves, containers, affected) {
  const rel = [];
  const feats = [...AXES.x.feats, ...AXES.y.feats];
  const drifting = new Set();
  for (const l of leaves) {
    if (!affected.has(l.id)) continue;
    for (const cid of l.ancestors) if (containers.has(cid)) drifting.add(cid);
  }
  const ids = leaves.map((l) => l.id);
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      if (!affected.has(ids[i]) && !affected.has(ids[j])) continue;
      const a = spec.positions[ids[i]];
      const b = spec.positions[ids[j]];
      if (!a || !b) continue;
      const ra = rectOfPos(a);
      const rb = rectOfPos(b);
      for (const f of feats) {
        if (onSameVisualAxis(ra, rb, f)) rel.push({ kind: 'node', a: ids[i], b: ids[j], f });
      }
    }
  }
  for (const l of leaves) {
    const p = spec.positions[l.id];
    if (!p) continue;
    const rc = rectOfPos(p);
    for (const [cid, cr] of containers) {
      if (!affected.has(l.id) && !drifting.has(cid)) continue;
      for (const f of feats) if (rc[f] === cr[f]) rel.push({ kind: 'container', a: l.id, b: cid, f });
    }
  }
  const cids = [...containers.keys()];
  for (let i = 0; i < cids.length; i += 1) {
    for (let j = i + 1; j < cids.length; j += 1) {
      if (!drifting.has(cids[i]) && !drifting.has(cids[j])) continue;
      const ra = containers.get(cids[i]);
      const rb = containers.get(cids[j]);
      for (const f of feats) if (ra[f] === rb[f]) rel.push({ kind: 'pair', a: cids[i], b: cids[j], f });
    }
  }
  return rel;
}

// 把不变量 ① 的枚举范围原样暴露出来，供测试逐条核对。**这是必要的**：只看
// 「等化前后终态有没有丢关系」抓不住枚举盲区——08 实测过一次巧合，跨父的
// timeseries_db 与 energy_dashboard 各自被独立候选挪了 4px，中间态线断了，终态
// 又双双落在 1205 上，前后对比看不出来。枚举范围要能被直接断言。
export function invariantRelationsOf(rawSpec, affectedIds) {
  const spec = cloneSpec(rawSpec);
  const leaves = leafList(spec).filter((l) => spec.positions && spec.positions[l.id]);
  const affected = new Set(affectedIds || leaves.map((l) => l.id));
  return invariantRelations(spec, leaves, guardBaseline(spec).containers, affected);
}

function makeState(rawSpec, opts) {
  const spec = cloneSpec(rawSpec);
  const leaves = leafList(spec).filter((l) => spec.positions && spec.positions[l.id]);
  return {
    opts: Object.assign({}, DEFAULTS, opts),
    spec,
    leaves,
    original: Object.fromEntries(leaves.map((l) => [l.id, { ...spec.positions[l.id] }])),
    thresholds: qualityThresholdsOf(fromBuildSpec(spec)),
    guard: guardBaseline(spec),
    changes: [],
    rejected: [],
  };
}

// 候选事务：应用 → 累计位移上限 → 不变量 ① → 评分护栏 ② → 提交或整条拒绝
function tryCandidate(st, muts, desc, reason, postCheck) {
  const eps = 1e-6;
  const next = cloneSpec(st.spec);
  const affected = new Set();
  for (const m of muts) {
    const p = next.positions[m.id];
    if (!p) return { ok: false, why: `节点 ${m.id} 无坐标` };
    for (const f of ['x', 'y', 'w', 'h']) if (m[f] != null) p[f] = Math.round(m[f]);
    affected.add(m.id);
  }
  for (const id of affected) {
    const o = st.original[id];
    const p = next.positions[id];
    // 理由要带实测值：谁、哪个字段、从哪到哪、超了多少。README 里那张「实测拒绝理由
    // （rejected 原文）」的表格是逐字粘过去的，缺了数字就得靠散文补，一补就有出入。
    const excess = (f, lim) => (Math.abs(p[f] - o[f]) > lim + eps
      ? `${f} ${o[f]}→${p[f]}，实测 ${Math.abs(p[f] - o[f])}px` : null);
    const moved = excess('x', st.opts.maxShift) || excess('y', st.opts.maxShift);
    if (moved) return reject(st, desc, `节点 ${id} 累计位移超过 ${st.opts.maxShift}px（${moved}）`);
    const resized = excess('w', st.opts.sizeTol) || excess('h', st.opts.sizeTol);
    if (resized) return reject(st, desc, `节点 ${id} 累计尺寸改动超过 ${st.opts.sizeTol}px（${resized}）`);
  }
  const rel = invariantRelations(st.spec, st.leaves, st.guard.containers, affected);
  const after = guardBaseline(next);
  for (const r of rel) {
    const ra = r.kind === 'pair' ? after.containers.get(r.a) : rectOfPos(next.positions[r.a]);
    const rb = r.kind === 'node' ? rectOfPos(next.positions[r.b]) : after.containers.get(r.b);
    if (!ra || !rb || ra[r.f] !== rb[r.f]) {
      return reject(st, desc, `破坏既有精确对齐 ${r.a}.${r.f} == ${r.b}.${r.f}`);
    }
  }
  if (after.report.score < st.guard.report.score) {
    return reject(st, desc, `复算分下降 ${st.guard.report.score} → ${after.report.score}`);
  }
  for (const t of after.types) if (!st.guard.types.has(t)) return reject(st, desc, `出现新 issue 类型 ${t}`);
  for (const [id, f] of after.fit) {
    if (st.guard.fit.has(id) && st.guard.fit.get(id) !== f) {
      return reject(st, desc, `节点 ${id} 的 fit 变了 ${st.guard.fit.get(id)} → ${f}`);
    }
  }
  for (const [id, px] of after.padX) {
    if (!st.guard.padX.has(id)) continue;
    const shrunk = Math.max(0, (st.spec.positions[id].w - next.positions[id].w) / 2); // 缩宽的几何归因份额
    if (px < st.guard.padX.get(id) - shrunk - eps) {
      return reject(st, desc, `节点 ${id} 的 padX 变小 ${st.guard.padX.get(id)} → ${px}`);
    }
  }
  for (const [id, ov] of after.over) {
    const before = st.guard.over.get(id);
    if (!before) continue;
    for (let i = 0; i < 4; i += 1) {
      if (ov[i] > before[i] + eps) return reject(st, desc, `节点 ${id} 出框量变大`);
    }
  }
  if (postCheck) {
    const why = postCheck(next, after);
    if (why) return reject(st, desc, why);
  }
  for (const m of muts) {
    const from = st.spec.positions[m.id];
    const to = next.positions[m.id];
    for (const f of ['x', 'y', 'w', 'h']) {
      if (to[f] !== from[f]) st.changes.push({ id: m.id, field: f, from: from[f], to: to[f], reason });
    }
  }
  st.spec = next;
  st.guard = after;
  return { ok: true };
}

function reject(st, desc, why) {
  st.rejected.push({ candidate: desc, reason: why });
  return { ok: false, why };
}

/* ---------------- a) 锚线吸附 ---------------- */

function phaseSnap(st) {
  for (const axis of ['x', 'y']) {
    for (const { id, parent, ancestors } of st.leaves) {
      const lines = linesOf(st.spec, st.leaves, axis);
      const rc = rectOfPos(st.spec.positions[id]);
      const targets = [];
      for (const f of AXES[axis].feats) {
        for (const v of lines.values.keys()) {
          // 多数派线：除自己至少两个**同带**成员（口径见 onSameVisualAxis）
          if (lines.partnersAt(id, v).length < 2) continue;
          const d = v - rc[f];
          if (d === 0 || Math.abs(d) > st.opts.snapTol || !Number.isInteger(d)) continue;
          targets.push({ f, v, d });
        }
        for (const [cid, cr] of st.guard.containers) {
          if (!ancestors.has(cid)) continue; // 容器矩形线只吸自己的祖先容器
          const d = cr[f] - rc[f];
          if (d === 0 || Math.abs(d) > st.opts.snapTol || !Number.isInteger(d)) continue;
          targets.push({ f, v: cr[f], d, container: cid });
        }
      }
      if (!targets.length) continue;
      targets.sort((a, b) => Math.abs(a.d) - Math.abs(b.d) || a.v - b.v || a.f.localeCompare(b.f));
      const t = targets[0];
      const desc = `吸附 ${id} ${t.f}:${rc[t.f]}→${t.v}`;
      const kept = membershipsOf(lines, st.spec, id, axis);
      if (kept.length) {
        reject(st, desc, `节点已在既有精确线上（${lineText(kept)}），吸附会把它挪下线`);
        continue;
      }
      const pair = equalizedPairOf(st, id, parent, axis);
      if (pair) {
        reject(st, desc, `所在${axis === 'x' ? '行' : '列'}已有等距对（${pair}），吸附会把它打破`);
        continue;
      }
      // 容器线随子节点动：若吸附对象是自己撑边的容器，线会跟着跑。理由只陈述实测值
      const postCheck = t.container == null ? null : (next, after) => {
        const cr = after.containers.get(t.container);
        const got = rectOfPos(next.positions[id])[t.f];
        if (!cr) return `容器 ${t.container} 吸附后不存在`;
        if (got !== cr[t.f]) return `吸附后 ${id}.${t.f}=${got}，容器 ${t.container}.${t.f} 也跟着移到 ${cr[t.f]}，两者仍不相等`;
        return null;
      };
      tryCandidate(st, [{ id, [AXES[axis].pos]: st.spec.positions[id][AXES[axis].pos] + t.d }], desc, `锚线吸附(${axis}→${t.v})`, postCheck);
    }
  }
}

// 节点紧邻的间距若与相邻间距相等（等距对），吸附不许打破——挪它就把这一对拆了，
// 而且下一轮等化又会把它摆回来，不收敛。返回命中的那一对（供理由文案点名），否则 null。
function equalizedPairOf(st, id, parent, axis) {
  const runs = runsOf(st, parent, axis === 'x' ? 'row' : 'col');
  for (const run of runs) {
    const k = run.ids.indexOf(id);
    if (k < 0 || run.gaps.length < 2) continue;
    for (const i of [k - 1, k]) {
      if (i < 0 || i >= run.gaps.length) continue;
      for (const j of [i - 1, i + 1]) {
        if (j < 0 || j >= run.gaps.length) continue;
        if (run.gaps[i] === run.gaps[j]) return `${run.ids[Math.min(i, j)]}…${run.ids[Math.max(i, j) + 1]} 间距 ${run.gaps[i]}px×2`;
      }
    }
  }
  return null;
}

/* ---------------- b) 尺寸档内统一 ---------------- */

function phaseSize(st) {
  for (const dim of ['w', 'h']) {
    const axis = dim === 'w' ? 'x' : 'y';
    const globalFreq = new Map();
    for (const { id } of st.leaves) {
      const v = st.spec.positions[id][dim];
      globalFreq.set(v, (globalFreq.get(v) || 0) + 1);
    }
    const clusters = [];
    const parents = [...new Set(st.leaves.map((l) => l.parent))];
    for (const parent of parents) {
      const members = st.leaves.filter((l) => l.parent === parent);
      const byValue = new Map();
      for (const m of members) {
        const v = st.spec.positions[m.id][dim];
        if (!byValue.has(v)) byValue.set(v, []);
        byValue.get(v).push(m.id);
      }
      const values = [...byValue.keys()].sort((a, b) => a - b);
      let group = [];
      const flush = () => {
        if (group.length >= 2) {
          const rep = pickRep(group, byValue, globalFreq);
          const changers = group.filter((v) => v !== rep && Math.abs(v - rep) <= st.opts.sizeTol)
            .flatMap((v) => byValue.get(v));
          if (changers.length) clusters.push({ parent, rep, changers });
        }
        group = [];
      };
      for (const v of values) {
        if (group.length && v - group[group.length - 1] > st.opts.sizeTol) flush();
        group.push(v);
      }
      flush();
    }
    const byRep = new Map();
    for (const c of clusters) {
      if (!byRep.has(c.rep)) byRep.set(c.rep, []);
      byRep.get(c.rep).push(c);
    }
    for (const rep of [...byRep.keys()].sort((a, b) => a - b)) {
      const comp = byRep.get(rep);
      applySizeComposite(st, dim, axis, rep, comp);
    }
  }
}

function pickRep(values, byValue, globalFreq) {
  // 簇代表值：全图同维度频次最高者优先（02 的判定卡 92/96 应并到全图标准高 96），
  // 平手看簇内数量，再平手取较小值
  return [...values].sort((a, b) => (globalFreq.get(b) || 0) - (globalFreq.get(a) || 0)
    || byValue.get(b).length - byValue.get(a).length
    || a - b)[0];
}

// 锚选择：静态对齐的边优先保住（如底边对齐则改另一侧保底边）；两侧都各有静态
// 对齐则该成员不可统一。返回 { order, pinned }：order 是按优先级排好的锚位列表，
// pinned 非空表示 order[0] 是「为保住既有对齐而钉的锚」——这种锚被护栏拒绝之后
// 不许回退（回退到别的锚位就是把那条线撞断，见 08 的 security_linkage）。
// null 表示不可行。
function anchorPrefs(st, id, axis, movingSet) {
  const { feats, mid } = AXES[axis];
  const rc = rectOfPos(st.spec.positions[id]);
  const witness = new Map();
  const statics = feats.filter((f) => {
    for (const { id: qid } of st.leaves) {
      if (qid === id || movingSet.has(qid)) continue;
      const q = rectOfPos(st.spec.positions[qid]);
      // 同一条视觉轴才算静态锚：值相等还要过投影带（口径见 onSameVisualAxis）
      if (feats.some((g) => onSameVisualAxis(q, rc, g, f))) { witness.set(f, qid); return true; }
    }
    return false;
  });
  if (statics.length >= 2) {
    return { blocked: statics.map((f) => `${f}=${rc[f]}（同轴 ${witness.get(f)}）`).join('、') };
  }
  const pinned = statics.length ? statics[0] : null;
  const order = pinned ? [pinned] : [mid];
  for (const f of [mid, ...feats.filter((x) => x !== mid)]) if (!order.includes(f)) order.push(f);
  return { order, pinned, pinnedAt: pinned ? `${pinned}=${rc[pinned]}（同轴 ${witness.get(pinned)}）` : null };
}

function mutFor(st, id, axis, rep, anchor) {
  const { pos, size, end, mid } = AXES[axis];
  const rc = rectOfPos(st.spec.positions[id]);
  const m = { id, [size]: rep };
  if (anchor === end) m[pos] = rc[end] - rep;
  else if (anchor === mid) m[pos] = Math.round(rc[mid] - rep / 2);
  else m[pos] = rc[pos];
  return m;
}

// 回退阶梯的分组：**按不变量互锁关系的连通分量，与父容器无关**。两类互锁边，
// 任一成立就必须同进同退：
//   ① 同一条 0px 对齐线：被改动轴的同名特征相等且投影带相交（改 w 只动 x/cx/r，
//      y 族撞不断，所以只看本轴）。谁单独动谁断线。
//   ② 当前同尺寸：这条边是**自觉的取舍**，不是几何必然。拆开做并不会造出新的档值
//      （09 的 72 本来就在图上），付出的是「这一对当前等高」、换来的是「其中一张并入
//      多数派档」。选前者：成对等高是肉眼可见的关系，单张并档只是统计上的整齐。
// 按父分簇是错的：它既可能拆开互锁对，也可能捆住无关成员。08 实测两头都踩——
// timeseries_db(∈cloud_platform) 与 energy_dashboard(∈ops_apps) 被 x=1201 互锁却被
// 分到两簇，而 energy_dashboard 与 security_linkage 无任何互锁却因同父被捆在一起；
// 于是「唯一可行解 = 只动互锁的那一对」这一档在阶梯上根本不存在，整批被拒。
// 连通分量把它复原：{timeseries_db, energy_dashboard} 一起做成（w 282→278、
// x 1201→1205、r 保持 1483，0px 对齐零破坏、复算分 100→100），{security_linkage}
// 单独成组仍被评分护栏拒（锚=r，100→96），不接受破坏性回退。
// ② 是 09 的守门：staging/regression 两条通栏长条同为 h=72，它们无共享 y 轴线，只有
// 这条边能把它们绑在一起（staging 两侧均有静态对齐而不可行 → 整组拒绝，两张都不动）。
// 代价照实说：regression 单张本可 h 72→70 并入多数派档，被这条边挡下（见夹具 README
// 「已知缺口」）。
function interlockGroups(st, axis, ids) {
  const feats = AXES[axis].feats;
  const size = AXES[axis].size;
  const uf = new Map(ids.map((id) => [id, id]));
  const find = (a) => {
    let r = a;
    while (uf.get(r) !== r) r = uf.get(r);
    while (uf.get(a) !== r) { const nx = uf.get(a); uf.set(a, r); a = nx; }
    return r;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) uf.set(rb, ra);
  };
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const ra = rectOfPos(st.spec.positions[ids[i]]);
      const rb = rectOfPos(st.spec.positions[ids[j]]);
      const sharedLine = feats.some((f) => onSameVisualAxis(ra, rb, f));
      const sameSize = st.spec.positions[ids[i]][size] === st.spec.positions[ids[j]][size];
      if (sharedLine || sameSize) union(ids[i], ids[j]);
    }
  }
  const groups = new Map();
  for (const id of ids) {
    const k = find(id);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(id);
  }
  return [...groups.values()];
}

function applySizeComposite(st, dim, axis, rep, comp) {
  const allChangers = comp.flatMap((c) => c.changers);
  const movingSet = new Set(allChangers);
  const parentOf = new Map(st.leaves.map((l) => [l.id, l.parent]));
  const planOf = (ids, moving) => {
    const plan = [];
    for (const id of ids) {
      const prefs = anchorPrefs(st, id, axis, moving);
      if (prefs.blocked) return { infeasible: id, blocked: prefs.blocked };
      plan.push({
        id, prefs: prefs.order, pinned: prefs.pinned, pinnedAt: prefs.pinnedAt,
      });
    }
    return { plan };
  };
  const whole = planOf(allChangers, movingSet);
  const wholeDesc = `尺寸档统一 ${dim}→${rep}（整批：${allChangers.join('、')}）`;
  if (whole.infeasible) {
    // 「不可行」也是试过并被否决，要留在账本里——否则整批这一档在 rejected 里
    // 一个字都没有，读夹具的人看不出回退阶梯是从哪一级开始的
    reject(st, wholeDesc, `成员 ${whole.infeasible} 两侧均有静态精确对齐（${whole.blocked}），改尺寸必销毁其一，整批不可行`);
  } else {
    const muts = whole.plan.map((p) => mutFor(st, p.id, axis, rep, p.prefs[0]));
    if (tryCandidate(st, muts, wholeDesc, `尺寸档统一(${dim}→${rep})`).ok) return;
  }
  // 回退一：按互锁连通分量分组（见 interlockGroups）。
  // 静态性判定始终用整个复合体的 movingSet：同一档想动的节点互相不算对方的静态锚，
  // 否则 08 的 timeseries/energy 会因为彼此的 x=1201 线在回退层互相锁死。
  for (const group of interlockGroups(st, axis, allChangers)) {
    const per = planOf(group, movingSet);
    const scope = [...new Set(group.map((id) => parentOf.get(id)))].join('+');
    const descC = `尺寸档统一 ${dim}→${rep}（${scope}: ${group.join('、')}）`;
    if (per.infeasible) {
      reject(st, descC, `成员 ${per.infeasible} 两侧均有静态精确对齐（${per.blocked}），改尺寸必销毁其一，整组拒绝`);
      continue;
    }
    const muts = per.plan.map((p) => mutFor(st, p.id, axis, rep, p.prefs[0]));
    if (tryCandidate(st, muts, descC, `尺寸档统一(${dim}→${rep})`).ok) continue;
    // 回退二：逐成员，锚位按优先级依次试。
    // **保线锚位不许回退**：p.pinned 非空说明 p.prefs[0] 是为保住既有对齐钉的锚，
    // 换任何别的锚位都会把那条线撞断。这种成员只试这一个锚，被护栏拒了就整条候选
    // 拒绝并成文记录——不许静默滑到破坏性锚位（08 的 security_linkage：锚=r 被
    // 「复算分 100→96」拒掉后旧代码回退到锚=x，把 r==rule_engine.r==1163 撞断且
    // rejected 里一个字都没有）。
    for (const p of per.plan) {
      const anchors = p.pinned ? [p.pinned] : p.prefs;
      let done = false;
      for (const anchor of anchors) {
        const descM = `尺寸档统一 ${dim}→${rep}（${p.id}，锚=${anchor}）`;
        if (tryCandidate(st, [mutFor(st, p.id, axis, rep, anchor)], descM, `尺寸档统一(${dim}→${rep},锚=${anchor})`).ok) {
          done = true;
          break;
        }
      }
      if (done) continue;
      st.rejected.push(p.pinned
        ? {
          candidate: `尺寸档统一 ${dim}→${rep}（${p.id}）`,
          reason: `保线锚位（锚=${p.pinned}）被护栏拒绝，不接受破坏性回退——换锚会把 ${p.id}.${p.pinnedAt} 这条线撞断，整条候选拒绝`,
        }
        : { candidate: `尺寸档统一 ${dim}→${rep}（${p.id}）`, reason: '所有锚位均被护栏拒绝' });
    }
  }
}

/* ---------------- c) 行/列间距等化 ---------------- */

// 同容器、交叉轴区间重叠链构成的行（或列），按主轴排序；区间倒挂（重叠）的组不算
function runsOf(st, parent, orient) {
  const main = orient === 'row' ? AXES.x : AXES.y;
  const cross = orient === 'row' ? AXES.y : AXES.x;
  const members = st.leaves.filter((l) => l.parent === parent && st.spec.positions[l.id]);
  const used = new Set();
  const runs = [];
  for (const seed of members) {
    if (used.has(seed.id)) continue;
    const group = [seed.id];
    used.add(seed.id);
    let grew = true;
    while (grew) {
      grew = false;
      for (const m of members) {
        if (used.has(m.id)) continue;
        const a = rectOfPos(st.spec.positions[m.id]);
        const hit = group.some((gid) => {
          const b = rectOfPos(st.spec.positions[gid]);
          return Math.min(a[cross.end], b[cross.end]) - Math.max(a[cross.pos], b[cross.pos]) > 0;
        });
        if (hit) { group.push(m.id); used.add(m.id); grew = true; }
      }
    }
    if (group.length < 2) continue;
    group.sort((a, b) => st.spec.positions[a][main.pos] - st.spec.positions[b][main.pos]);
    const gaps = [];
    let ok = true;
    for (let i = 1; i < group.length; i += 1) {
      const prev = rectOfPos(st.spec.positions[group[i - 1]]);
      const curr = rectOfPos(st.spec.positions[group[i]]);
      const g = curr[main.pos] - prev[main.end];
      if (g < 0) { ok = false; break; }
      gaps.push(g);
    }
    if (ok) runs.push({ ids: group, gaps });
  }
  return runs;
}

function phaseSpacing(st) {
  for (const orient of ['row', 'col']) {
    const main = orient === 'row' ? AXES.x : AXES.y;
    const parents = [...new Set(st.leaves.map((l) => l.parent))];
    for (const parent of parents) {
      for (const seedRun of runsOf(st, parent, orient)) {
        equalizeRun(st, parent, orient, main, seedRun.ids);
      }
    }
  }
}

function currentRun(st, parent, orient, ids) {
  return runsOf(st, parent, orient).find((r) => r.ids.length === ids.length && r.ids.every((x, i) => x === ids[i])) || null;
}

// c1 的摆法候选。段要变宽，两端总得让一头——让哪头由护栏说了算，所以把摆法列
// 成候选依次试，而不是一上来就对称外扩（对称外扩两端同时推，必顶破容器线）。
// 顺序：① 起端钉位 ② 末端钉位 ③ 对称居中 ④ 等宽微缩·两端钉位。
// ④ 是两端都被容器线钉死时的唯一出路：外沿分毫不动，靠成员各让几个 px 腾出
// 通道（05 的三召回卡 252→247、间距 26，recall_layer 矩形逐字段不变）。
function spacingPlans(st, block, main, minSp) {
  const ws = block.map((id) => st.spec.positions[id][main.size]);
  const k = block.length;
  const start = rectOfPos(st.spec.positions[block[0]])[main.pos];
  const end = rectOfPos(st.spec.positions[block[k - 1]])[main.end];
  const span = ws.reduce((s, w) => s + w, 0) + (k - 1) * minSp;
  const flat = Array(k - 1).fill(minSp);
  const plans = [
    { tag: '起端钉位', from: start, ws, gaps: flat },
    { tag: '末端钉位', from: end - span, ws, gaps: flat },
    { tag: '对称居中', from: Math.round((start + end) / 2 - span / 2), ws, gaps: flat },
  ];
  const avail = end - start;
  if (span > avail) {
    // 4a 全等宽的段：搜一个能让「宽度、间距各自整齐」的整数解（间距从 minSp 往上探）
    if (ws.every((w) => w === ws[0])) {
      for (let g = minSp; g <= minSp + k; g += 1) {
        const total = avail - (k - 1) * g;
        if (total <= 0 || ws[0] - total / k > st.opts.sizeTol) break;
        if (total % k !== 0) continue;
        plans.push({ tag: `等宽微缩·两端钉位(${ws[0]}→${total / k}，间距 ${g})`, from: start, ws: ws.map(() => total / k), gaps: Array(k - 1).fill(g) });
        break;
      }
    }
    // 4b 宽度不齐的段：缺口按成员均摊，间距一律 minSp
    const deficit = span - avail;
    const base = Math.floor(deficit / k);
    const rem = deficit % k;
    const shrunk = ws.map((w, i) => w - base - (i < rem ? 1 : 0));
    if (shrunk.every((w, i) => w > 0 && ws[i] - w <= st.opts.sizeTol)) {
      plans.push({ tag: `微缩·两端钉位(间距 ${minSp})`, from: start, ws: shrunk, gaps: flat });
    }
  }
  return plans.map((p) => {
    let acc = p.from;
    const muts = block.map((id, i) => {
      const m = { id, [main.pos]: acc };
      if (p.ws[i] !== st.spec.positions[id][main.size]) m[main.size] = p.ws[i];
      acc += p.ws[i] + (p.gaps[i] || 0);
      return m;
    });
    return { tag: p.tag, muts };
  });
}

function equalizeRun(st, parent, orient, main, ids) {
  const label = orient === 'row' ? '行' : '列';
  // c1: 低于质检 minSpacing 的连续段先提升到 minSpacing（05 的三召回卡 19/18 → 26）
  let run = currentRun(st, parent, orient, ids);
  if (!run) return;
  const minSp = Math.ceil(st.thresholds.minSpacing);
  for (let i = 0; i < run.gaps.length; i += 1) {
    if (run.gaps[i] >= minSp) continue;
    let j = i;
    while (j + 1 < run.gaps.length && run.gaps[j + 1] < minSp) j += 1;
    const block = run.ids.slice(i, j + 2);
    const mark = st.rejected.length;
    for (const plan of spacingPlans(st, block, main, minSp)) {
      const desc = `${label}最小间距提升（${block.join('、')}→${minSp}px，${plan.tag}）`;
      if (tryCandidate(st, plan.muts, desc, `最小间距提升(${minSp},${plan.tag})`).ok) {
        // 前面几种摆法为什么不行，要留在账本里而不是被抹掉。rejected 的契约是
        // 「所有试过并被拒的候选」，这样夹具自身就能审计（05 的起端钉位 / 末端钉位 /
        // 对称居中各自撞了哪条线，以前只写在 README 里，夹具里查不到）。
        // 被后续摆法取代的记录标 superseded，与「整段没做成」区分开。
        for (let k = mark; k < st.rejected.length; k += 1) {
          st.rejected[k] = { ...st.rejected[k], superseded: true, supersededBy: desc };
        }
        break;
      }
    }
    run = currentRun(st, parent, orient, ids);
    if (!run) return;
    i = j;
  }
  // c2: 整行均匀（两端钉住），全员位移 ≤ maxShift 才行；小档差不许把节点挪下既有线
  run = currentRun(st, parent, orient, ids);
  if (!run || run.gaps.length < 2) return;
  const spread = Math.max(...run.gaps) - Math.min(...run.gaps);
  if (spread >= 1 && applyUniform(st, run, main, label, spread)) return;
  // c3: 按 ≥tierGap 的档差分层，层内统一到整数目标（总位移最小者优先），层差保留
  run = currentRun(st, parent, orient, ids);
  if (!run) return;
  let s = 0;
  for (let i = 1; i <= run.gaps.length; i += 1) {
    if (i === run.gaps.length || Math.abs(run.gaps[i] - run.gaps[i - 1]) >= st.opts.tierGap) {
      if (i - s >= 2) applyTier(st, run, main, label, s, i - 1);
      run = currentRun(st, parent, orient, ids);
      if (!run) return;
      s = i;
    }
  }
}

// 挪动者若在既有多成员线上，等化一律拒绝（09 的 CI 行 140/139/139 是精度噪声，
// 但每张卡都和下方卡同列，动谁都销毁一条列线——宁可不动）。
// **这里曾经有一条 ≥tierGap 的档差豁免，已收掉。** 可检验的依据是 02 首行：kafka
// 的 x=1020 与 flink / model-service 同列、r=1289 与 flink / model-service /
// decision-center / verify 同右缘，98/116 两个间距由这两条竖轴与两端卡算得
// （98 = 1020 − app-track.r 922、116 = trade-event.x 1405 − 1289）；旧豁免以
// 「档差 18 ≥ 12」放行，实测一次销毁 8 条叶-叶 0px 关系（含跨父）。
// （「锚线是原语、间距是导出量」是对这批数据的取向表述，无法用反例检验，不进账本。）
// 收掉之后确属噪声却做不成的等化如实记 rejected，不为让断言变绿而放水。
function loseLineMovers(st, main, muts) {
  const axis = main === AXES.x ? 'x' : 'y';
  const lines = linesOf(st.spec, st.leaves, axis);
  const losers = [];
  for (const m of muts) {
    if (m[main.pos] === st.spec.positions[m.id][main.pos]) continue;
    const on = membershipsOf(lines, st.spec, m.id, axis);
    if (on.length) losers.push(`${m.id}（${lineText(on)}）`);
  }
  return losers;
}

// 被拒理由：只陈述实测到的事实——谁压在哪条线上、同轴伙伴是谁、档差多少。
// 「间距是锚线的导出量」这类说法是设计取向，不能用反例检验，不写进账本。
const loseLineReason = (losers, spread) => `${losers.join('；')} 压在既有同带多成员精确线上，等化会把它挪下线（档差 ${spread}px 不构成豁免）`;

// c2 的摆法家族。两端全钉只能重排中间成员——**当中间成员恰好钉在真轴上、自由的却是
// 段首或段末时，这一档根本没有解**，而放弃整行是错的。所以补「挪首成员·末端钉位」
// 与「挪末成员·起端钉位」：其余成员分毫不动，只把那一个自由成员挪到间距一致的位置。
// 04 的 lis/emr/pacs 就是这个几何：emr.cx==idm.cx==920、pacs.r==his.r==1258 都是真轴
// （求解器拒 emr/pacs 是对的），只有 lis 在 x 族上与全图零同值，行距 40/38 → 38/38
// 只需 lis.x 580→582 这一个动作。
// 顺序固定「两端钉位 → 挪首成员 → 挪末成员」：新摆法只在旧摆法全数出局后才轮到。
// 注意这条「已有解维持原判」只在本阶段内部成立——c2 整体排在 c3 之前，给 c2 加摆法
// 会抢在 c3 的已有解之前（05 的 model_training 列原由 c3「列间距档内统一(63)」做成，
// 现在被 c2 的「挪末成员·起端钉位」先做掉；终态几何相同，差别只在账本）。
function uniformPlans(st, run, main) {
  const ids = run.ids;
  const n = ids.length;
  const posOf = (id) => st.spec.positions[id][main.pos];
  const sizeOf = (id) => st.spec.positions[id][main.size];
  const overOf = (muts) => {
    for (const m of muts) {
      const d = Math.abs(m[main.pos] - posOf(m.id));
      if (d > st.opts.maxShift) return { id: m.id, d, to: m[main.pos] };
    }
    return null;
  };
  const plans = [];
  const first = rectOfPos(st.spec.positions[ids[0]]);
  const last = rectOfPos(st.spec.positions[ids[n - 1]]);
  const widths = ids.slice(1, -1).reduce((s, id) => s + sizeOf(id), 0);
  const g = (last[main.pos] - first[main.end] - widths) / run.gaps.length;
  let acc = first[main.end];
  const midMuts = [];
  for (let i = 1; i < n - 1; i += 1) {
    acc += g;
    const id = ids[i];
    const nx = Math.round(acc);
    acc = nx + sizeOf(id);
    if (nx !== posOf(id)) midMuts.push({ id, [main.pos]: nx });
  }
  plans.push({ tag: '两端钉位', muts: midMuts });
  const uniform = (gaps) => gaps.every((x) => x === gaps[0]);
  const tail = run.gaps.slice(1);
  if (uniform(tail)) {
    const nx = posOf(ids[1]) - tail[0] - sizeOf(ids[0]);
    if (nx !== posOf(ids[0])) plans.push({ tag: '挪首成员·末端钉位', muts: [{ id: ids[0], [main.pos]: nx }] });
  }
  const head = run.gaps.slice(0, -1);
  if (uniform(head)) {
    const prev = rectOfPos(st.spec.positions[ids[n - 2]]);
    const nx = prev[main.end] + head[0];
    if (nx !== posOf(ids[n - 1])) plans.push({ tag: '挪末成员·起端钉位', muts: [{ id: ids[n - 1], [main.pos]: nx }] });
  }
  return plans.filter((p) => p.muts.length).map((p) => ({ ...p, over: overOf(p.muts) }));
}

function applyUniform(st, run, main, label, spread) {
  for (const plan of uniformPlans(st, run, main)) {
    const desc = `${label}间距均匀化（${run.ids.join('、')}，${plan.tag}）`;
    // maxShift 越界也要记账。同一条护栏在 tryCandidate 里留 rejected，在这里
    // 曾经 `return false` 一个字不留，同一份账本两套口径（实测静默 9 次：02 的
    // verify 20px、03 的 voice_assistant 30px 与 dds 12px、04 的 db 12px、07 三处、
    // 08 的 camera 47/50px）。
    if (plan.over) {
      reject(st, desc, `节点 ${plan.over.id} 位移 ${plan.over.d}px 超过上限 ${st.opts.maxShift}px（摆法要求它挪到 ${main.pos}=${plan.over.to}）`);
      continue;
    }
    const losers = loseLineMovers(st, main, plan.muts);
    if (losers.length) {
      reject(st, desc, loseLineReason(losers, spread));
      continue;
    }
    if (tryCandidate(st, plan.muts, desc, `${label}间距均匀化(${plan.tag})`).ok) return true;
  }
  return false;
}

function applyTier(st, run, main, label, gs, ge) {
  const gaps = run.gaps.slice(gs, ge + 1);
  const spread = Math.max(...gaps) - Math.min(...gaps);
  if (spread < 1) return;
  const targets = [];
  for (let t = Math.min(...gaps); t <= Math.max(...gaps); t += 1) targets.push(t);
  const posOf = (id) => st.spec.positions[id][main.pos];
  const sizeOf = (id) => st.spec.positions[id][main.size];
  // 段首右缘为锚往后铺：动的是段内后续成员
  const forwardFor = (t) => {
    const muts = [];
    let total = 0;
    let acc = rectOfPos(st.spec.positions[run.ids[gs]])[main.end];
    for (let i = gs; i <= ge; i += 1) {
      const id = run.ids[i + 1];
      const nx = acc + t;
      const d = nx - posOf(id);
      total += Math.abs(d);
      if (d !== 0) muts.push({ id, [main.pos]: nx });
      acc = nx + sizeOf(id);
    }
    // 层后的节点整体平移，保住与下一档的间距值
    const shift = muts.length ? (muts.find((m) => m.id === run.ids[ge + 1]) || { [main.pos]: posOf(run.ids[ge + 1]) })[main.pos] - posOf(run.ids[ge + 1]) : 0;
    for (let i = ge + 2; i < run.ids.length; i += 1) {
      const id = run.ids[i];
      if (shift !== 0) { muts.push({ id, [main.pos]: posOf(id) + shift }); total += Math.abs(shift); }
    }
    return { muts, total };
  };
  // 段末左缘为锚往前铺：动的是段内**靠前**的成员——「挪首成员」这个几何在
  // 一律往后铺的旧候选集里根本不存在（见 uniformPlans 的同名摆法）
  const backwardFor = (t) => {
    const muts = [];
    let total = 0;
    let acc = posOf(run.ids[ge + 1]);
    for (let i = ge; i >= gs; i -= 1) {
      const id = run.ids[i];
      const nx = acc - t - sizeOf(id);
      const d = nx - posOf(id);
      total += Math.abs(d);
      if (d !== 0) muts.push({ id, [main.pos]: nx });
      acc = nx;
    }
    // 层前的节点整体平移，保住与上一档的间距值
    const shift = muts.length ? (muts.find((m) => m.id === run.ids[gs]) || { [main.pos]: posOf(run.ids[gs]) })[main.pos] - posOf(run.ids[gs]) : 0;
    for (let i = gs - 1; i >= 0; i -= 1) {
      const id = run.ids[i];
      if (shift !== 0) { muts.push({ id, [main.pos]: posOf(id) + shift }); total += Math.abs(shift); }
    }
    return { muts, total };
  };
  const rank = (dir, make) => targets.map((t) => ({ t, dir, ...make(t) })).filter((p) => p.muts.length)
    .sort((a, b) => a.total - b.total || a.t - b.t);
  // 往后铺的整批先试完，再轮到往前铺：本阶段内已有解的段落维持原判（跨阶段不保证，见 uniformPlans）
  const plans = [...rank('段首为锚', forwardFor), ...rank('挪首成员·段末为锚', backwardFor)];
  if (!plans.length) return;
  for (const p of plans) {
    const desc = `${label}间距档内统一（${run.ids.slice(gs, ge + 2).join('、')}→${p.t}px，${p.dir}）`;
    const losers = loseLineMovers(st, main, p.muts);
    if (losers.length) {
      reject(st, desc, loseLineReason(losers, spread));
      continue;
    }
    if (tryCandidate(st, p.muts, desc, `${label}间距档内统一(${p.t},${p.dir})`).ok) return;
  }
}

/* ---------------- 入口 ---------------- */

export function equalizeIntent(rawSpec, opts = {}) {
  const st = makeState(rawSpec, opts);
  // 内部跑到不动点：一轮变换可能造出新的多数派线（如 08 边缘行统一后顶线成形），
  // 下一轮才轮得到吸附。到不动点后再对输出跑一遍必然零改动——幂等由构造保证。
  for (let pass = 0; pass < 8; pass += 1) {
    const before = st.changes.length;
    phaseSnap(st);
    phaseSize(st);
    phaseSpacing(st);
    if (st.changes.length === before) break;
  }
  const seen = new Set();
  const rejected = st.rejected.filter((r) => {
    const key = `${r.candidate}||${r.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { spec: st.spec, changes: st.changes, rejected };
}
