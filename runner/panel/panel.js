/* panel.js —— 步骤面板的前端。
 *
 * 只认 CONTRACT.md 的事件流：连 /events（SSE），把事件折叠成状态，再渲染。
 * 折叠口径与 server.mjs 的 foldEvents 是同一份，改一边要改另一边。
 *
 * 地址栏参数：
 *   ?layout=tall|wide   强制版式（默认按视口高宽比：高/宽 > 1.2 用 tall）
 *   ?demo=1             不连 SSE，页内自动播放一遍（录屏彩排 / 与设计稿对照）
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var panel = $('panel');
  var params = new URLSearchParams(location.search);

  /* ── 文案表 ────────────────────────────────────────────── */

  // 阶段 → 顶部状态灯旁的人话
  var PHASE_TEXT = {
    waiting: '待机',
    received: '已就绪',
    layout: '绘制中',
    auth: '确认授权',
    drawing: '绘制中',
    saving: '保存中',
    done: '已完成',
    error: '已中断'
  };
  // 阶段 → 版面（五种版面，layout/auth/saving 并进绘制中）
  var VIEW_OF = {
    waiting: 'waiting', received: 'received', layout: 'drawing', auth: 'drawing',
    drawing: 'drawing', saving: 'drawing', done: 'done', error: 'error'
  };
  // 契约里的六种 kind
  var KIND_TEXT = {
    title: '标题', subtitle: '副标题', container: '容器',
    node: '节点', edge: '连线', label: '标签'
  };
  // 底部四类计数只数图元，不数标题/副标题
  var LEGEND_KINDS = [['container', '容器'], ['node', '节点'], ['edge', '连线'], ['label', '标签']];
  var LOG_ROWS = 14;                 // 已完成列表最多留几行在 DOM 里

  /* ── 版式 ──────────────────────────────────────────────── */

  function pickLayout() {
    var forced = params.get('layout');
    if (forced === 'tall' || forced === 'wide') return forced;
    return window.innerHeight / Math.max(window.innerWidth, 1) > 1.2 ? 'tall' : 'wide';
  }
  function applyLayout() { panel.setAttribute('data-panel', pickLayout()); }
  applyLayout();
  window.addEventListener('resize', applyLayout);

  /* ── 状态 ──────────────────────────────────────────────── */

  var state = null;
  function reset() {
    state = {
      phase: 'waiting', title: null, specPath: null, nodes: null, edges: null,
      total: null, byKind: null, current: null, latest: null, done: [], result: null,
      error: null, log: null, t0: null, tLast: null
    };
  }

  var ms = function (ts) { var t = Date.parse(ts); return Number.isFinite(t) ? t : null; };

  /** 折叠一条事件进 state —— 与 server.mjs 的 foldEvents 同一口径。 */
  function apply(e) {
    if (!e || typeof e !== 'object') return;
    var t = ms(e.ts);
    if (t != null) state.tLast = t;

    if (e.type === 'phase') {
      if (e.phase === 'received') {
        state.phase = 'received';
        state.title = e.title == null ? null : e.title;
        state.specPath = e.specPath == null ? null : e.specPath;
        state.nodes = e.nodes == null ? null : e.nodes;
        state.edges = e.edges == null ? null : e.edges;
      } else if (e.phase === 'layout') {
        state.phase = 'layout';
        state.total = e.total == null ? null : e.total;
        state.byKind = e.byKind && typeof e.byKind === 'object' ? e.byKind : null;
        if (t != null) state.t0 = t;                 // 累计用时从算完布局起算
      } else if (e.phase === 'done') {
        state.phase = 'done';
        state.current = null;
        state.result = {
          file: e.file == null ? null : e.file,
          shapes: e.shapes == null ? null : e.shapes,
          elapsedMs: e.elapsedMs == null ? null : e.elapsedMs,
          animation: e.animation !== false
        };
      } else {
        state.phase = e.phase;
      }
      return;
    }

    if (e.type === 'step') {
      if (e.total != null) state.total = e.total;
      // latest = 最近一条 step，不管 start 还是 done。大字始终显示它 ——
      // 只认 current 的话，一步画完到下一步开画之间那几百毫秒大字会空掉。
      state.latest = { i: e.i, kind: e.kind, id: e.id, label: e.label };
      if (e.status === 'start') {
        if (state.phase !== 'done' && state.phase !== 'error') state.phase = 'drawing';
        if (state.t0 == null && t != null) state.t0 = t;
        state.current = { i: e.i, kind: e.kind, id: e.id, label: e.label };
      } else if (e.status === 'done') {
        state.done.push({ i: e.i, kind: e.kind, id: e.id, label: e.label, ms: e.ms == null ? null : e.ms });
        if (state.current && state.current.i === e.i) state.current = null;
      }
      return;
    }

    if (e.type === 'error') {
      state.phase = 'error';
      state.error = { message: e.message || '未知错误', step: e.step == null ? null : e.step };
      return;
    }

    if (e.type === 'log') state.log = e.message || null;
  }

  /* ── 渲染 ──────────────────────────────────────────────── */

  var el = function (tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  var kindText = function (k) { return KIND_TEXT[k] || k || ''; };
  var typeOf = function (k) { return k === 'title' || k === 'subtitle' ? 'text' : (k || 'text'); };
  var baseName = function (p) { var i = String(p).lastIndexOf('/'); return i < 0 ? String(p) : String(p).slice(i + 1); };
  var dirName = function (p) { var i = String(p).lastIndexOf('/'); return i < 0 ? '' : String(p).slice(0, i + 1); };

  var lastLogKey = null;                              // 用来判断「有没有新行」，决定要不要放滑入动画
  var rowFlip = 0;

  function render() {
    var view = VIEW_OF[state.phase] || 'waiting';
    var doneN = state.done.length;
    var total = state.total;

    panel.setAttribute('data-state', view);
    $('phase').textContent = PHASE_TEXT[state.phase] || state.phase;

    // 版面切换
    var bodies = panel.querySelectorAll('[data-view]');
    for (var i = 0; i < bodies.length; i += 1) {
      bodies[i].hidden = bodies[i].getAttribute('data-view') !== view;
    }

    // 顶部累计用时：按事件 ts 算，完成后用 elapsedMs
    var tracking = view === 'drawing' || view === 'done';
    $('clock').hidden = !tracking;
    if (tracking) {
      var sec = 0;
      if (state.result && state.result.elapsedMs != null) sec = state.result.elapsedMs / 1000;
      else if (state.t0 != null && state.tLast != null) sec = Math.max(0, state.tLast - state.t0) / 1000;
      $('elapsed').textContent = sec.toFixed(1);
    }

    // 已收到
    $('spec-title').textContent = state.title || '未命名架构图';
    $('spec-nodes').textContent = state.nodes == null ? '–' : String(state.nodes);
    $('spec-edges').textContent = state.edges == null ? '–' : String(state.edges);

    // 进度
    var nums = $('progress');
    nums.firstElementChild.textContent = String(doneN);
    nums.lastElementChild.textContent = total == null ? '–' : String(total);
    $('bar').style.width = total ? Math.min(100, (doneN / total) * 100) + '%' : '0%';

    // 当前步骤
    var block = $('current-block');
    var line = $('current');
    var tag = line.children[0];
    var dot = line.children[1];
    var name = line.children[2];
    var eyebrow = $('current-eyebrow');
    var sub = $('current-sub');
    var setEyebrow = function (text) { eyebrow.textContent = text || ''; eyebrow.hidden = !text; };
    var plain = function (kicker, text, type) {
      block.setAttribute('data-type', type || 'text');
      setEyebrow(kicker);
      tag.textContent = ''; dot.textContent = ''; name.textContent = text;
    };
    sub.textContent = '';
    sub.hidden = true;
    if (state.phase === 'auth') {
      // 授权确认：这一步在等 macOS 那个「豆包工作想要控制 Microsoft PowerPoint」的框。
      // 必须把「在等什么、人该干什么」写在脸上 —— 不然就是 2026-09-12 实测那样：
      // 面板停在布局完成一动不动，两分钟后冒一句 -1712，谁也想不到是个没弹出来的授权框。
      plain('', '正在确认 PowerPoint 授权', 'auth');
      sub.textContent = '若系统弹出授权框，请点「允许」';
      sub.hidden = false;
    } else if (state.phase === 'saving') {
      plain('收尾', '正在保存…');
    } else if (total && doneN >= total) {
      plain('收尾', '全部画完');
    } else if (state.latest) {
      block.setAttribute('data-type', typeOf(state.latest.kind));
      setEyebrow('正在绘制');
      tag.textContent = kindText(state.latest.kind);
      dot.textContent = ' · ';
      name.textContent = state.latest.label || state.latest.id || '';
    } else {
      plain('正在绘制', '准备中…');
    }

    renderLog();
    renderLegend();
    renderResult();

    // 错误
    $('error').textContent = state.error ? state.error.message : '';
    $('error-note').textContent = state.error && total
      ? '已完成 ' + doneN + ' / ' + total + (state.error.step != null ? '，断在第 ' + state.error.step + ' 步' : '')
      : '';
  }

  function renderLog() {
    var list = $('done-list');
    var rows = state.done.slice(-LOG_ROWS);
    var key = rows.length ? rows[rows.length - 1].i + ':' + rows.length : '';
    var fresh = key !== lastLogKey && rows.length > 0;
    if (fresh) { lastLogKey = key; rowFlip = 1 - rowFlip; }

    list.textContent = '';
    rows.forEach(function (d, idx) {
      var row = el('div', 'log-row');
      row.setAttribute('data-type', typeOf(d.kind));
      if (fresh && idx === rows.length - 1) row.setAttribute('data-in', rowFlip ? 'a' : 'b');
      row.appendChild(el('span', 'log-check', '✓'));
      row.appendChild(el('span', 'log-mark', ''));
      row.appendChild(el('span', 'log-tag', kindText(d.kind)));
      row.appendChild(el('span', 'log-dot', '·'));
      row.appendChild(el('span', 'log-name', d.label || d.id || ''));
      row.appendChild(el('span', 'log-dur', d.ms == null ? '' : (d.ms / 1000).toFixed(2) + 's'));
      list.appendChild(row);
    });
  }

  function renderLegend() {
    var legend = $('legend');
    // 修正一：没有 byKind（还没算完布局）就没有图元计数，整行藏掉 ——
    // 设计稿的等待态显示「容器 3 节点 14 …」，那时候连 spec 都还没收到。
    if (!state.byKind) { legend.hidden = true; legend.textContent = ''; return; }
    legend.hidden = false;

    var hit = {};
    state.done.forEach(function (d) { hit[d.kind] = (hit[d.kind] || 0) + 1; });

    legend.textContent = '';
    LEGEND_KINDS.forEach(function (k) {
      var all = state.byKind[k[0]];
      if (all == null) return;                 // byKind 只列出现过的 kind
      var item = el('div', 'legend-item');
      item.setAttribute('data-type', k[0]);
      item.appendChild(el('span', 'legend-mark', ''));
      item.appendChild(el('span', 'legend-label', k[1]));
      item.appendChild(el('span', 'legend-count', (hit[k[0]] || 0) + '/' + all));
      legend.appendChild(item);
    });
  }

  function renderResult() {
    var box = $('result');
    if (!state.result) { box.textContent = ''; return; }
    var r = state.result;
    box.textContent = '';

    var head = el('div', '');
    // 修正二：文件名和路径都从事件的 file 里拆，不写死
    head.appendChild(el('div', 'done-file', r.file ? baseName(r.file) : '（未保存）'));
    head.appendChild(el('div', 'done-path', r.file ? dirName(r.file) : ''));
    box.appendChild(head);
    box.appendChild(el('div', 'rule'));

    var stats = el('div', 'done-stats');
    if (r.shapes != null) {
      var s1 = el('div', 'done-stat');
      s1.appendChild(el('span', 'done-num', String(r.shapes)));
      s1.appendChild(el('span', 'done-label', '个形状'));
      stats.appendChild(s1);
    }
    if (r.elapsedMs != null) {
      var s2 = el('div', 'done-stat');
      s2.appendChild(el('span', 'done-num', (r.elapsedMs / 1000).toFixed(1)));
      s2.appendChild(el('span', 'done-label', '秒'));
      stats.appendChild(s2);
    }
    box.appendChild(stats);
    if (r.animation === false) box.appendChild(el('div', 'done-note', '进入动画没加上（不影响这张图）'));
  }

  /* ── 攒帧渲染：一次绘制会连着来几十条事件 ──────────────── */

  var pending = false;
  function scheduleRender() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () { pending = false; render(); });
  }

  /* ── 数据源 A：SSE ─────────────────────────────────────── */

  function connect() {
    var es = new EventSource('/events');
    es.addEventListener('reset', function () { reset(); lastLogKey = null; render(); });
    es.onmessage = function (ev) {
      var e = null;
      try { e = JSON.parse(ev.data); } catch (err) { return; }
      apply(e);
      scheduleRender();
    };
    es.onerror = function () {
      if (es.readyState === 2) { $('phase').textContent = '连接断开'; }
    };
  }

  /* ── 数据源 B：?demo=1 页内自播 ────────────────────────── */

  // 与设计稿 panel-design.html 同一份 27 步脚本：[kind, 名称, 耗时秒]
  var DEMO_STEPS = [
    ['container', '接入层', 0.42], ['container', '智能体运行时', 0.38], ['container', '数据层', 0.16],
    ['node', 'API 网关', 0.31], ['node', '身份鉴权', 0.28], ['node', '会话服务', 0.35],
    ['node', '意图识别', 0.27], ['node', '任务规划器', 0.33], ['node', '工具调用', 0.29],
    ['node', '记忆检索', 0.36], ['node', '向量库', 0.30], ['node', '模型路由', 0.34],
    ['node', '大模型服务', 0.26], ['node', '结果校验', 0.32], ['node', '事件总线', 0.38],
    ['node', '观测面板', 0.29], ['node', '对象存储', 0.31],
    ['edge', '网关 → 会话服务', 0.48], ['edge', '会话服务 → 意图识别', 0.52],
    ['edge', '意图识别 → 规划器', 0.44], ['edge', '规划器 → 工具调用', 0.50],
    ['edge', '工具调用 → 模型路由', 0.49], ['edge', '模型路由 → 大模型服务', 0.40],
    ['edge', '规划器 → 记忆检索', 0.45], ['edge', '记忆检索 → 向量库', 0.53],
    ['edge', '结果校验 → 事件总线', 0.47], ['label', '版本 v2.1', 0.19]
  ];
  var DEMO_STEP_MS = 380;

  function demo() {
    var vt = Date.now();                       // 虚拟时钟：事件 ts 照脚本里的耗时走
    var iso = function () { return new Date(vt).toISOString(); };
    var feed = function (e) { e.ts = iso(); apply(e); scheduleRender(); };
    var total = DEMO_STEPS.length;
    var byKind = {};
    DEMO_STEPS.forEach(function (s) { byKind[s[0]] = (byKind[s[0]] || 0) + 1; });

    var queue = [];
    var at = function (wait, fn) { queue.push([wait, fn]); };

    at(0, function () { reset(); lastLogKey = null; feed({ type: 'phase', phase: 'waiting' }); });
    at(1400, function () {
      feed({ type: 'phase', phase: 'received', title: 'AI Agent 产品架构', nodes: 14, edges: 9 });
    });
    at(1600, function () {
      feed({ type: 'phase', phase: 'layout', total: total, byKind: byKind });
    });
    // 授权确认在演示里停 1 秒（真跑时它等的是 macOS 那个授权框，可能要几秒到二十几秒）
    at(400, function () { feed({ type: 'phase', phase: 'auth' }); });
    // start 和 done 分两拍喂，大字才会比已完成列表先亮一下，跟真跑一遍一样
    DEMO_STEPS.forEach(function (s, i) {
      var base = { type: 'step', i: i + 1, total: total, kind: s[0], id: 'demo-' + i, label: s[1] };
      at(i === 0 ? 1000 : Math.round(DEMO_STEP_MS * 0.4), function () {
        feed({ type: base.type, i: base.i, total: base.total, kind: base.kind, id: base.id, label: base.label, status: 'start' });
      });
      at(Math.round(DEMO_STEP_MS * 0.6), function () {
        vt += Math.round(s[2] * 1000);
        feed({ type: base.type, i: base.i, total: base.total, kind: base.kind, id: base.id, label: base.label, status: 'done', ms: Math.round(s[2] * 1000) });
      });
    });
    at(600, function () { feed({ type: 'phase', phase: 'saving' }); });
    at(900, function () {
      var elapsed = DEMO_STEPS.reduce(function (t, s) { return t + s[2]; }, 0) * 1000;
      feed({
        type: 'phase', phase: 'done',
        file: '/Users/demo/Documents/架构图导出/架构图-20260912-1030.pptx',
        shapes: 27, elapsedMs: Math.round(elapsed), animation: true
      });
    });
    at(4000, function () { /* 停一下再从头来 */ });

    var k = 0;
    (function tick() {
      if (k >= queue.length) { k = 0; vt = Date.now(); }
      var item = queue[k];
      k += 1;
      setTimeout(function () { item[1](); tick(); }, item[0]);
    }());
  }

  /* ── 起 ────────────────────────────────────────────────── */

  reset();
  render();
  if (params.get('demo') === '1') demo(); else connect();
}());
