#!/usr/bin/env node
// server.mjs —— 步骤面板的零依赖 http 服务。只做三件事，见 CONTRACT.md：
//   GET /        面板页（index.html）
//   GET /events  SSE：先把 steps.jsonl 已有的行全部回放，再 tail 新行
//   GET /state   按契约折叠出的当前状态快照（刷新页面不丢状态）
//
// 用法：node server.mjs [--port 7431] [--events <steps.jsonl>] [--replay-ms 0]
//
// --replay-ms：新连上来的 /events 把「已有的那些行」按这个间隔一行一行喂出去，
// 而不是一次性倒完。0（默认）= 一次倒完，真实运行时用这个；截图和彩排用 80 之类的值
// 把一份录好的事件文件当录像带回放。喂完之后照常 tail 新行。
//
// tail 用「按字节偏移轮询」而不是 fs.watch：事件文件是追加写的小文件，250ms 轮一次
// 读增量，成本可以忽略；fs.watch 在 macOS 上对「同一个文件被反复 append」的通知并不可靠，
// 而且文件被 draw.mjs 截断重建时（不带 --append 的那次）还得自己认出来重放。

import { createServer } from 'node:http';
import { readFileSync, statSync, openSync, readSync, closeSync, existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = resolve(HERE, '..');

const POLL_MS = 250;

function parseArgs(argv) {
  const opts = { port: 7431, events: join(RUNNER, '.state', 'steps.jsonl'), replayMs: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const inline = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : null;
    const key = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    const take = () => { if (inline != null) return inline; i += 1; return argv[i]; };
    if (key === '--port') opts.port = Number(take());
    else if (key === '--events') { const v = take(); opts.events = isAbsolute(v) ? v : resolve(process.cwd(), v); }
    else if (key === '--replay-ms') opts.replayMs = Number(take());
    else if (key === '--help' || key === '-h') opts.help = true;
    else throw new Error(`未知参数: ${arg}`);
  }
  if (!Number.isFinite(opts.port) || opts.port < 1 || opts.port > 65535) throw new Error('--port 不合法');
  if (!Number.isFinite(opts.replayMs) || opts.replayMs < 0) throw new Error('--replay-ms 必须是非负毫秒数');
  return opts;
}

/** 把事件流折叠成 CONTRACT.md 里 /state 的那个形状。 */
export function foldEvents(events) {
  const state = {
    phase: 'waiting', title: null, specPath: null, nodes: null, edges: null,
    total: null, byKind: null, slides: null, slide: null, slideTitle: null,
    platform: null,
    current: null, done: [], result: null, error: null, log: null,
  };
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'phase') {
      if (e.phase === 'received') {
        state.phase = 'received';
        state.title = e.title ?? null;
        state.specPath = e.specPath ?? null;
        state.nodes = e.nodes ?? null;
        state.edges = e.edges ?? null;
        if (e.slides != null) state.slides = e.slides;
      } else if (e.phase === 'layout') {
        state.phase = 'layout';
        state.total = e.total ?? null;
        // byKind 是底部四类计数的分母：{"node":14,"edge":9,…}，只列出现过的 kind
        state.byKind = e.byKind && typeof e.byKind === 'object' ? e.byKind : null;
        if (e.slides != null) state.slides = e.slides;
      } else if (e.phase === 'slide') {
        // 翻页。**不动 state.phase** —— slide 不是一个版面，只是「现在画到第几页」；
        // 塞进 phase 会让面板去找一个不存在的版面，整块空掉。单页时压根不发这条。
        state.slide = e.slide ?? null;
        if (e.slides != null) state.slides = e.slides;
        state.slideTitle = e.title ?? null;
      } else if (e.phase === 'auth') {
        // 预检。**带 platform**（'darwin' | 'win32'）—— 面板这一格的文案分平台：
        // mac 在等那个「豆包工作想要控制 Microsoft PowerPoint」的授权框，
        // Windows 上没有授权框，只是在唤起 PowerPoint。老事件没有这个字段，折出来是 null。
        state.phase = 'auth';
        if (e.platform != null) state.platform = e.platform;
      } else if (e.phase === 'done') {
        state.phase = 'done';
        state.current = null;
        if (e.slides != null) state.slides = e.slides;
        state.result = {
          file: e.file ?? null, shapes: e.shapes ?? null,
          elapsedMs: e.elapsedMs ?? null, animation: e.animation !== false,
        };
      } else {
        state.phase = e.phase;
      }
      continue;
    }
    if (e.type === 'step') {
      if (e.total != null) state.total = e.total;
      if (e.slides != null) state.slides = e.slides;
      if (e.slide != null) state.slide = e.slide;
      if (e.status === 'start') {
        // 见到第一条 step 就从 layout 进 drawing —— drawing 是折叠出来的，事件里没有
        if (state.phase !== 'done' && state.phase !== 'error') state.phase = 'drawing';
        state.current = { i: e.i, kind: e.kind, id: e.id, label: e.label };
      } else if (e.status === 'done') {
        state.done.push({ i: e.i, kind: e.kind, id: e.id, label: e.label, ms: e.ms ?? null, slide: e.slide ?? null });
        if (state.current && state.current.i === e.i) state.current = null;
      }
      continue;
    }
    if (e.type === 'error') {
      state.phase = 'error';
      state.error = { message: e.message || '未知错误', step: e.step ?? null };
      continue;
    }
    if (e.type === 'log') state.log = e.message || null;
  }
  return state;
}

/** 事件文件头这么多字节当代际指纹。第一行是 phase:received，够分辨两轮。 */
const HEAD_BYTES = 64;

/**
 * 读事件文件里从 offset 起的完整行；返回 { lines, offset, reset, head }（半行留到下次）。
 *
 * **「被截断重建」有两种，只认「变短」认不全。** run.mjs 每轮开头用
 * makeWriter(events, false) 把 steps.jsonl 清空重写，而这里 250ms 轮询一次：
 * 如果上一轮留下的文件比新一轮头 250ms 内写出的内容**短**（上一轮早死、只留了一行
 * error 的时候就是这样），轮询那一刻 size 已经超过旧 offset，`size < offset` 不成立，
 * 于是从旧偏移量中间开始读 —— 把一条 JSON 的后半截当成一行推给面板（面板 JSON.parse
 * 失败静默丢弃），而且不发 reset：面板顶着上一轮的标题、已完成列表和进度分母不动，
 * 新一轮的 phase:received 整条丢失，用户以为卡住了。
 * 所以再比一次文件头的指纹：头 64 字节变了，就是换了一轮。
 *
 * @param {string} path 事件文件
 * @param {number} offset 上次读到哪
 * @param {string|null} [prevHead] 上次拿到的 head，传了才做代际判断
 */
export function readFrom(path, offset, prevHead) {
  if (!existsSync(path)) return { lines: [], offset: 0, reset: offset !== 0, head: null };
  const size = statSync(path).size;
  const fd = openSync(path, 'r');
  try {
    let head = '';
    if (size > 0) {
      const hb = Buffer.alloc(Math.min(HEAD_BYTES, size));
      const hn = readSync(fd, hb, 0, hb.length, 0);
      head = hb.subarray(0, hn).toString('hex');
    }
    // 变短 = 明显的截断重建；头变了 = 长度盖过来的那种截断重建。
    // 文件不足 64 字节时 head 会随着追加变长，所以「一个是另一个的前缀」算同一轮
    // （hex 定长两字符一字节，前缀判断是安全的）。
    const sameGeneration = prevHead == null || prevHead === '' || head === ''
      || head.startsWith(prevHead) || prevHead.startsWith(head);
    const truncated = size < offset || (offset > 0 && !sameGeneration);
    const from = truncated ? 0 : offset;
    if (size === from) return { lines: [], offset: from, reset: truncated, head };
    const buf = Buffer.alloc(size - from);
    const n = readSync(fd, buf, 0, buf.length, from);
    const text = buf.subarray(0, n).toString('utf8');
    const parts = text.split('\n');
    const partial = parts.pop();
    return {
      lines: parts.filter((l) => l.trim() !== ''),
      offset: from + n - Buffer.byteLength(partial, 'utf8'),
      reset: truncated,
      head,
    };
  } finally {
    closeSync(fd);
  }
}

const parseLine = (line) => { try { return JSON.parse(line); } catch { return null; } };

/** 静态资源白名单：面板页拆出来的那几个文件，按名字点名，不做目录遍历。 */
const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/panel.css', ['panel.css', 'text/css; charset=utf-8']],
  ['/panel.js', ['panel.js', 'text/javascript; charset=utf-8']],
]);

export function createPanelServer(opts) {
  const eventsPath = opts.events;
  const replayMs = Number(opts.replayMs) > 0 ? Number(opts.replayMs) : 0;

  return createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];

    if (STATIC.has(url)) {
      const [name, type] = STATIC.get(url);
      const path = join(HERE, name);
      let body;
      try { body = readFileSync(path); } catch {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`找不到面板文件：${path}`);
        return;
      }
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
      return;
    }

    if (url === '/state') {
      const { lines } = readFrom(eventsPath, 0);
      const state = foldEvents(lines.map(parseLine).filter(Boolean));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(state));
      return;
    }

    if (url === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      // 先整个回放一遍已有的行，再 tail —— 后开的面板也能看到完整过程
      let offset = 0;
      let head = null;
      const pump = () => {
        const got = readFrom(eventsPath, offset, head);
        if (got.reset) res.write('event: reset\ndata: {}\n\n');
        offset = got.offset;
        head = got.head;
        for (const line of got.lines) res.write(`data: ${line}\n\n`);
      };

      let timer = null;
      const beat = setInterval(() => res.write(': keep-alive\n\n'), 15000);
      const stop = () => { if (timer) clearInterval(timer); clearInterval(beat); };

      if (replayMs > 0) {
        // 录像带模式：已有的行按 replayMs 一行一行喂，喂完再从当时记下的 offset 接着 tail
        const first = readFrom(eventsPath, 0);
        offset = first.offset;
        head = first.head;
        const tape = first.lines.slice();
        timer = setInterval(() => {
          if (tape.length) { res.write(`data: ${tape.shift()}\n\n`); return; }
          clearInterval(timer);
          timer = setInterval(pump, POLL_MS);
        }, replayMs);
      } else {
        pump();
        timer = setInterval(pump, POLL_MS);
      }

      req.on('close', stop);
      res.on('close', stop);
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404');
  });
}

// 「是不是被直接 node 起来的」。必须按 realpath 比：macOS 的 /tmp 和 /var 本身就是
// 软链（/private/…），Node 解析模块时会把 import.meta.url 解成真路径，而 process.argv[1]
// 保持原样——直接比字符串会得出「没被直接调用」，于是整个脚本一声不吭地退出码 0。
const invoked = (() => {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  try { return realpathSync(process.argv[1]) === realpathSync(self); }
  catch { return resolve(process.argv[1]) === self; }
})();
if (invoked) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  if (opts.help) {
    console.log('用法: node server.mjs [--port 7431] [--events <steps.jsonl>] [--replay-ms 0]');
    process.exit(0);
  }
  const server = createPanelServer(opts);
  server.listen(opts.port, '127.0.0.1', () => {
    console.log(`面板: http://localhost:${opts.port}`);
    console.log(`事件: ${opts.events}`);
    if (opts.replayMs > 0) console.log(`回放: 已有的行按 ${opts.replayMs}ms 一行喂出去`);
  });
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`端口 ${opts.port} 已被占用 —— 多半是上一次的面板还在跑。`
        + `\n关掉它：lsof -ti tcp:${opts.port} | xargs kill`);
    } else {
      console.error(error.message);
    }
    process.exit(1);
  });
}
