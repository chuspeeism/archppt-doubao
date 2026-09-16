// mac-powerpoint.mjs
// 绘制指令流（project/lib/exporters/draw-steps.mjs）→ AppleScript 文本 → 驱动
// Microsoft PowerPoint for Mac **逐个**把图元画出来，边画边把事件流回调出去。
//
// 为什么是 AppleScript 不是 JXA：JXA 下 `make new slide` / `make new shape` 的
// 枚举常量与 `at:` 参数全都认不出来，整脚本以 -1728 退出（T1 探针第五节，换了四种写法都挂）。
// AppleScript 一次跑通，唯一代价是下面这条硬性命名约定。
//
// 五条踩过的坑，写在这里免得下一个人再踩一遍（全部出自 T1 探针，本文件逐条照做）：
//
//   1. **变量名一律加 `p` 前缀。** PowerPoint 字典的 MsoAnimProperty 枚举里定义了
//      x / y / width / height / rotation / opacity / colors / visibility 这八个词，
//      在 `tell application` 块里它们会盖掉同名局部变量。写进 `with properties {...}`
//      记录时**不报错**，直接把枚举常量当值传进去，图元静默落到 (25,25)。
//      本文件更进一步：坐标全部在 Node 侧算成字面量内联，生成的脚本里根本没有数值变量。
//   2. **往左 / 往上画的直线会整体偏移一个宽或高。** `make new line shape` 永远把包围盒
//      左上角放在 (begin line X, begin line Y)，方向靠只读的 flip 属性表达。所以每段线
//      建完都无条件补一句 `set left position` / `set top` 到 min —— 向右下的线这两句是空操作。
//   3. **`save as` 之后之前抓住的所有引用全部失效**（-1728）。所以 save 是流程的最后一步。
//   4. **`word wrap: false` 的文本框会自己缩。** 解法不是 T1 建议的「按中心点算」——
//      实测左对齐时缩的是右边、中心并不守恒。正解是 `set auto size to auto size none`，
//      几何就完全按给定的盒子来（本文件实测 400/120/24 原样保持）。
//   5. **纯矩形没有 `adjustment 1`**（-1728），圆角才有，所以圆角设置一律用 try 包住。
//
// 导出名：deckToAppleScript / runDrawDeck / stepsToAppleScript / runDraw / APPLESCRIPT_RESERVED
//         POWERPOINT_NO_RESPONSE_CODES / noResponseCode / powerPointAuthMessage
//         POWERPOINT_MISSING_CODES / missingPowerPointCode / powerPointMissingMessage
//         POWERPOINT_STALLED_CODES / powerPointStalledMessage
//
// **一份 PPT 可以有多页。** deckToAppleScript / runDrawDeck 是多页版本，
// stepsToAppleScript / runDraw 是它俩的单页包装（一个字都不许改口径：
// `stepsToAppleScript(steps, o)` 的输出与 `deckToAppleScript([{ steps,
// background: o.background, title: o.slideTitle }], o)` **逐字节相同**，
// tests/mac-powerpoint-driver.test.mjs 里有一条测试钉着这条等式）。
// Windows 驱动器（project/drivers/win-powerpoint.mjs，另一个会话在写）照同一份接口实现。

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 「哪些 kind 算小元素」的单一来源。相对路径在开发仓与出货仓里一模一样（投影零改写）。
import { DRAW_QUICK_KINDS } from '../lib/exporters/draw-steps.mjs';

/** 坑 1 的那八个词。生成的脚本里不许有同名变量。 */
export const APPLESCRIPT_RESERVED = Object.freeze(
  ['x', 'y', 'width', 'height', 'rotation', 'opacity', 'colors', 'visibility'],
);

/**
 * 坑 6（2026-09-12 实测拿到的）：**「PowerPoint 没应答」只有一种真原因 —— 授权框没处理掉。**
 *
 * macOS 第一次让 A 控制 B 时必须弹一次「A 想要控制 B」。同一时间系统只显示一个授权框，
 * 前面排着别的框时，这一个**弹不出来**，于是发给 PowerPoint 的 Apple event 干等到
 * 系统的两分钟上限 → -1712。表现是「布局算完了、PowerPoint 在前台、一个图元都不画」，
 * 极易被误判成「PowerPoint 里有模态弹窗」。-1743 是同一件事的另一面：框弹过、被点了拒绝。
 *
 * 所以这两个码归同一条判词，说清「谁要授权谁、框在哪、点完怎么继续」。
 */
export const POWERPOINT_NO_RESPONSE_CODES = Object.freeze(['-1712', '-1743']);

/** 从 osascript 的输出里认这两个码；认不出来返回 null。 */
export function noResponseCode(text) {
  const s = String(text == null ? '' : text);
  for (const code of POWERPOINT_NO_RESPONSE_CODES) {
    // \b 收口，免得 -17121 这种也算数
    if (new RegExp(`${code}\\b`).test(s)) return code;
  }
  return null;
}

/**
 * 「PowerPoint 没有响应」的统一判词 —— 面板、stdout、技能正文用的是同一句话。
 * @param {string} [code] 错误码或「超时」这类人话，直接嵌进第一句的括号里
 */
export function powerPointAuthMessage(code) {
  return `PowerPoint 没有响应（${code || '无响应'}）。`
    + '第一次使用需要在系统弹出的「豆包工作想要控制 Microsoft PowerPoint」授权框里点「允许」。'
    + '如果没看到这个框，请先处理掉屏幕上其他系统弹窗，再回复「重试」。';
}

/**
 * 「本机根本没装 Microsoft PowerPoint 桌面版」。osascript 找不到目标应用时报 -1728
 * （中文系统上文案是「不能获得\u201capplication …\u201d」，英文是 Can't get application），
 * 跟「装了、但授权框没处理掉」是两码事，解法也完全相反 —— 后者点一下「允许」就好，
 * 前者点一万次也没有那个框可点：系统设置 → 自动化 列表里压根不会出现 PowerPoint。
 *
 * 只在**授权预检**（一条 `get version`）那一步认这个码：那一步 -1728 只可能是应用不在。
 * 绘制阶段的 -1728 是别的意思（引用失效、属性不存在），不许套这条判词。
 */
export const POWERPOINT_MISSING_CODES = Object.freeze(['-1728']);

/** 从探针输出里认「没装」；认不出来返回 null。 */
export function missingPowerPointCode(text) {
  const s = String(text == null ? '' : text);
  for (const code of POWERPOINT_MISSING_CODES) {
    if (new RegExp(`${code}\\b`).test(s)) return code;
  }
  return null;
}

/** 「没装桌面版 PowerPoint」的统一判词。跟授权判词分开，因为该做的事完全不同。 */
export function powerPointMissingMessage(code) {
  return `本机没找到 Microsoft PowerPoint for Mac 桌面版（${code || '找不到应用'}）。`
    + '这个技能只能驱动**桌面版** PowerPoint，Microsoft 365 网页版、Keynote、WPS 都不行。'
    + '装好桌面版 PowerPoint、手动打开一次完成登录激活，再回复「重试」。'
    + '（这一条跟授权无关，系统设置的自动化列表里不会有 PowerPoint 可勾。）';
}

/**
 * 坑 7（2026-09-12 实测，同一天的第二脚）：**已经画起来之后的 -1712 跟授权没关系。**
 *
 * PowerPoint 是沙盒 App。往它没被授权访问的目录保存（`/private/tmp`、`/var/folders`
 * 这类系统临时目录首当其冲，`~/Library/…` 深处也会）时，系统弹一个
 * 「授予文件访问权限：Microsoft PowerPoint 需要访问名为 X 的文件夹」对话框；
 * 框挂在那儿等人点，`save` 那条 Apple event 就干等到系统两分钟上限 → -1712。
 * 实测那一次 20 步 26 个形状**全部画进去了**，只有保存这一步挂住 —— 而当时的判词还在
 * 说「第一次使用需要在授权框里点允许」，纯属误导：能画 20 步就证明自动化授权早就有了。
 *
 * 所以 -1712 按「有没有画起来」分两段判：一步都没画 = 授权没给（powerPointAuthMessage），
 * 已经画了 = PowerPoint 前台压着一个对话框（本函数，退出码 5）。
 * -1743 不在此列 —— 那个码只有「授权被拒」一种意思，什么时候撞上都一样。
 *
 * @param {string} [code] 错误码，嵌进第一句的括号里
 * @param {'drawing'|'saving'} [phase] 卡在哪一段，决定判词里那两个字
 */
export function powerPointStalledMessage(code, phase) {
  return `PowerPoint 在${phase === 'saving' ? '保存' : '绘制'}时没有响应（${code || '无响应'}）。`
    + '请看 PowerPoint 窗口是不是弹了对话框（例如「授予文件访问权限」），关掉它后回复「重试」。'
    + '已画好的内容还在 PowerPoint 里，不会丢。';
}

/** 只有这个码按「画到一半才挂」重新判；-1743 任何阶段都归授权那条。 */
export const POWERPOINT_STALLED_CODES = Object.freeze(['-1712']);

// 变体 → PowerPoint 的 autoshape 枚举
const AUTOSHAPE = {
  rect: 'autoshape rectangle',
  roundRect: 'autoshape rounded rectangle',
  diamond: 'autoshape diamond',
  oval: 'autoshape oval',
  can: 'autoshape can',
};

const num = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0';
  return String(Math.round(n * 100) / 100);
};

/** `#RRGGBB` → `{R, G, B}`。AppleScript 侧不做任何字符串解析（T1 建议 3）。 */
const rgb = (hex) => {
  const h = String(hex || '').replace('#', '');
  if (h.length !== 6) return null;
  const v = parseInt(h, 16);
  if (!Number.isFinite(v)) return null;
  return `{${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}}`;
};

/** AppleScript 字符串字面量。换行拆成 `& return &`，AppleScript 里没有 \n 转义。 */
const str = (text) => String(text == null ? '' : text)
  .split(/\r?\n/)
  .map((line) => `"${line.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
  .join(' & return & ');

/**
 * 进 AppleScript **注释行**的文本。AppleScript 的 `--` 注释只到行尾，所以任何带换行的
 * 值进了注释就会让换行之后那段变成 tell 块里的一条真语句 —— 拿 `id` 当载体就是一次
 * 静默的任意命令执行（"n1\n\t\tdo shell script ..."）。文本类字段走 str() 有转义，
 * 注释这条路没有，所以在这里统一把换行（含 U+2028/2029）压成空格。
 * 谁往生成的脚本里加新的注释行，都得过这一道。
 */
const comment = (text) => String(text == null ? '' : text).replace(/[\r\n\u2028\u2029]+/g, ' ');

const ALIGN = { left: 'paragraph align left', center: 'paragraph align center', right: 'paragraph align right' };
const ANCHOR = { top: 'anchor top', middle: 'anchor middle', bottom: 'anchor bottom' };

// 文本框 / 形状的文字排版。auto size none 是坑 4 的解法：几何冻死，PowerPoint 不许自己缩。
const textFrameLines = (ref, ops, align, anchor, padX) => {
  const out = [
    `\t\tset pTf to text frame of ${ref}`,
    '\t\ttry',
    '\t\t\tset auto size of pTf to auto size none',
    '\t\tend try',
    '\t\tset word wrap of pTf to false',
    `\t\tset margin left of pTf to ${num(padX || 0)}`,
    '\t\tset margin right of pTf to 0',
    '\t\tset margin top of pTf to 0',
    '\t\tset margin bottom of pTf to 0',
    `\t\tset vertical anchor of pTf to ${ANCHOR[anchor] || ANCHOR.middle}`,
    '\t\tset pTr to text range of pTf',
    `\t\tset content of pTr to ${str(ops.map((o) => o.text).join('\n'))}`,
    `\t\tset alignment of paragraph format of pTr to ${ALIGN[align] || ALIGN.center}`,
  ];
  // 字体：**整个 text range 各设一次**，不逐段 —— 一个形状里两段字用的是同一套族名，
  // 逐段设只是白白多几次 Apple event。族名由 draw-steps 从 pptxFonts() 算好挂在 op 上
  // （与原生 PPTX 导出同一份替身规则，见 docs/pptx-font-substitution.md）：
  // `ASCII name` 管 0–127 的西文，`east asian name` 管中日韩。一句都不设的话，
  // PowerPoint 会把文字落到主题字体（等线 / Calibri），中文西文都跟页面对不上。
  //
  // 两句各包一层 try：这两个属性在本机的字典里确实有（sdef 查得到），但老版本
  // PowerPoint for Mac 未必；字典里没有就是 -1728，不包 try 会让**整次绘制**挂掉。
  // op 上没挂字体字段时一句都不写（面板/旧调用方传进来的 op 仍旧照常画）。
  //
  // ⚠️ **`east asian name` 那句对苹方是个空操作，这是 PowerPoint 的老毛病，不是这里写错了。**
  // 2026-09-13 在本机真 PowerPoint 上量的：`set east asian name … to "PingFang SC"` **不报错**，
  // 回读却还是原值 —— 与写 "NoSuchFontXYZ" 的结果一模一样；换成 "Songti SC" / "Microsoft YaHei" /
  // "SimSun" / "Heiti SC" 则立刻生效。根子是 docs/pptx-font-substitution.md §1 那条：
  // Office 的字体表里根本没有 "PingFang SC"，按族名点名拿不到。所以：
  //   * 苹方系皮肤（14 套里 11 套）这句写了等于没写，段落上留的是主题 EA（本机是「等线」，
  //     而等线没装 → 系统级中日韩回退 → 画出来正好还是苹方）。这与原生 PPTX 导出写
  //     `<a:ea typeface="PingFang SC"/>` 的**渲染结果一致**（那边同样点不中、同样回退）。
  //   * academic 皮肤（Songti SC）这句是真生效的，所以不能因为「对苹方没用」就删掉。
  // 也别改成写别的中文族来「让它生效」—— docs/pptx-font-substitution.md §2 实测过，
  // 那样纯中文标题整片掉分（case-01 85.2%→77.7%）。PPTX_EA_SUB 保持为空是有代价换来的。
  const fontOf = (key) => {
    for (const o of ops) {
      const v = o && o[key];
      if (typeof v === 'string' && v !== '') return v;
    }
    return null;
  };
  const latin = fontOf('fontLatin');
  const ea = fontOf('fontEa');
  if (latin) {
    out.push('\t\ttry');
    out.push(`\t\t\tset ASCII name of font of pTr to ${str(latin)}`);
    out.push('\t\tend try');
  }
  if (ea) {
    out.push('\t\ttry');
    out.push(`\t\t\tset east asian name of font of pTr to ${str(ea)}`);
    out.push('\t\tend try');
  }
  // 逐段设字号 / 字色 / 粗细：节点的「大标题 + 第二行小字」就靠这个，一个形状两段字。
  //
  // **段号要按每个 op 实际占几段累加**，不能拿 op 的序号当段号：content 是把所有 op 的
  // text 用换行拼起来的，op 自己的 text 里带换行时段数就多于 op 数。以前按 `paragraph i+1`
  // 写，label="订单服务\n(Order)" + sublabel="MySQL 主库" 会把 sublabel 的 9pt 浅色套到
  // label 的第二行上，真正的 sublabel（第 3 段）一条样式都没有、用默认字号字色渲染 ——
  // 那张卡片跟其它卡片长得完全不一样。容器的竖排标题（每个字一段）也走这条路，
  // 累加之后它那一个 op 的样式会铺满自己的每一段，行为跟以前一致。
  let para = 1;
  ops.forEach((o) => {
    const span = String(o.text == null ? '' : o.text).split(/\r?\n/).length;
    // 只有一个 op 且不含换行时，直接对整个 text range 设，省几条 Apple event
    const targets = ops.length === 1 && span === 1
      ? ['pTr']
      : Array.from({ length: span }, (_, k) => `paragraph ${para + k} of pTr`);
    para += span;
    for (const target of targets) {
      out.push(`\t\tset font size of font of ${target} to ${num(o.fontSize)}`);
      const color = rgb(o.color);
      if (color) out.push(`\t\tset font color of font of ${target} to ${color}`);
      if (o.bold) out.push(`\t\tset bold of font of ${target} to true`);
    }
  });
  return out;
};

// 圆角：adjustment 1 是「半径 / 短边的一半」的比例，0 = 直角，0.5 = 半圆（药丸）
const roundAdj = (radius, w, h) => {
  const half = Math.max(1, Math.min(Number(w) || 0, Number(h) || 0) / 2);
  return Math.max(0, Math.min(0.5, (Number(radius) || 0) / half));
};

const shapeGeometry = (o) => `{left position:${num(o.x)}, top:${num(o.y)}, width:${num(o.w)}, height:${num(o.h)}}`;

const emitOp = (o, animate) => {
  const lines = [];
  const paint = (ref) => {
    const fill = rgb(o.fill);
    if (fill) lines.push(`\t\tset fore color of fill format of ${ref} to ${fill}`);
    const stroke = rgb(o.stroke);
    if (stroke) {
      lines.push(`\t\tset fore color of line format of ${ref} to ${stroke}`);
      lines.push(`\t\tset line weight of line format of ${ref} to ${num(o.strokeWidth || 0.75)}`);
      if (o.dash) lines.push(`\t\tset dash style of line format of ${ref} to line dash style dash`);
    } else {
      // line format 没有 visible 属性，藏描边只能把透明度推到 1
      lines.push(`\t\ttry`);
      lines.push(`\t\t\tset transparency of line format of ${ref} to 1.0`);
      lines.push('\t\tend try');
    }
  };
  const animateShape = (ref) => {
    if (!animate) return;
    lines.push('\t\tif pAnimOK then');
    lines.push('\t\t\ttry');
    lines.push(`\t\t\t\tadd effect (main sequence of timeline of pSld) for ${ref} fx animation type appear trigger after previous`);
    lines.push('\t\t\ton error pErr number pNum');
    lines.push('\t\t\t\tset pAnimOK to false');
    lines.push('\t\t\t\tmy emit("@@ANIM fail " & pErr & " (" & pNum & ")")');
    lines.push('\t\t\tend try');
    lines.push('\t\tend if');
  };

  if (o.op === 'rect' || o.op === 'roundRect') {
    const kind = AUTOSHAPE[o.shape] || AUTOSHAPE[o.op] || AUTOSHAPE.rect;
    lines.push(`\t\tset pSh to make new shape at pSld with properties {auto shape type:${kind}, left position:${num(o.x)}, top:${num(o.y)}, width:${num(o.w)}, height:${num(o.h)}}`);
    if (o.radius != null) {
      // 坑 5：直角矩形没有 adjustment 1，try 包住
      lines.push('\t\ttry');
      lines.push(`\t\t\tset adjustment_value of adjustment 1 of pSh to ${num(roundAdj(o.radius, o.w, o.h))}`);
      lines.push('\t\tend try');
    }
    paint('pSh');
    animateShape('pSh');
    return { lines, shapeRef: 'pSh' };
  }

  if (o.op === 'label') {
    if (rgb(o.fill)) {
      // 有底色 → 圆角矩形形状（边标签的白底药丸、容器的标题药丸都走这条）
      lines.push(`\t\tset pSh to make new shape at pSld with properties {auto shape type:${AUTOSHAPE.roundRect}, left position:${num(o.x)}, top:${num(o.y)}, width:${num(o.w)}, height:${num(o.h)}}`);
      lines.push('\t\ttry');
      lines.push(`\t\t\tset adjustment_value of adjustment 1 of pSh to ${num(roundAdj(o.radius != null ? o.radius : 0, o.w, o.h))}`);
      lines.push('\t\tend try');
      paint('pSh');
    } else {
      // 无底色 → 纯文本框（text box 默认就是无填充无描边，不用另外藏）
      lines.push(`\t\tset pSh to make new text box at pSld with properties ${shapeGeometry(o)}`);
    }
    lines.push(...textFrameLines('pSh', [o], o.align, o.anchor, o.padX));
    animateShape('pSh');
    return { lines, shapeRef: 'pSh' };
  }

  if (o.op === 'line') {
    lines.push(`\t\tset pLn to make new line shape at pSld with properties {begin line X:${num(o.x1)}, begin line Y:${num(o.y1)}, end line X:${num(o.x2)}, end line Y:${num(o.y2)}}`);
    // 坑 2：包围盒左上角按 min 修回来。向右下的线这两句是空操作，无条件写。
    lines.push(`\t\tset left position of pLn to ${num(Math.min(Number(o.x1), Number(o.x2)))}`);
    lines.push(`\t\tset top of pLn to ${num(Math.min(Number(o.y1), Number(o.y2)))}`);
    const color = rgb(o.color);
    if (color) lines.push(`\t\tset fore color of line format of pLn to ${color}`);
    lines.push(`\t\tset line weight of line format of pLn to ${num(o.width || 1)}`);
    if (o.dash) lines.push('\t\tset dash style of line format of pLn to line dash style dash');
    if (o.arrowEnd) {
      lines.push('\t\tset end arrowhead style of line format of pLn to triangle arrowhead');
      lines.push('\t\tset end arrowhead width of line format of pLn to medium width arrowhead');
      lines.push('\t\tset end arrowhead length of line format of pLn to medium arrowhead');
    }
    if (o.arrowStart) {
      // 下面第三句的 `begin arrow head length` **不是笔误**：PowerPoint.sdef 里 begin 端的
      // length 就写作三个词（style / width 是一个词，end 端三句也都是一个词），微软自己不对称。
      // 写成 `begin arrowhead length` 字典里查无此词，osascript 编译整份脚本时直接 -2740，
      // 一个图元都画不出来。tests/mac-powerpoint-driver.test.mjs 里有一条测试钉着它。
      lines.push('\t\tset begin arrowhead style of line format of pLn to triangle arrowhead');
      lines.push('\t\tset begin arrowhead width of line format of pLn to medium width arrowhead');
      lines.push('\t\tset begin arrow head length of line format of pLn to medium arrowhead');
    }
    animateShape('pLn');
    return { lines, shapeRef: 'pLn' };
  }

  return { lines, shapeRef: null };
};

/* ── 演示模式：把 PowerPoint 窗口摆到指定矩形 ──────────────────────────────
 * 2026-09-13 在本机真 PowerPoint（16.x）上量的：`document window` 的四个几何属性
 * （`left position` / `top` / `width` / `height`，全是 real）**写得动，回读逐个对得上** ——
 * 新建一份演示文稿，`set pWin to document window 1` 拿到的就是它自己的窗口
 * （实测：另开一份演示文稿在前，`document window 1` 仍是刚 make 出来的那一份），
 * 从 {294, 30, 1600, 900} 设到 {1280, 30, 1280, 992}，回读一字不差。
 *
 * 两条实测出来的注意事项：
 *   - `top` 小于菜单栏高度会被 macOS 夹到 30（设 25 回读是 30）。这不是失败，别当错处理。
 *   - `document window 1 of pPres` 这种写法 PowerPoint **不按容器解析**，给的还是全局
 *     document window 1。所以不如直接写 `document window 1`，别让人误以为它锁定了某一份。
 *
 * 整段包在 try 里，失败只发一条 `@@WINDOW fail`：**摆窗口是锦上添花，绝不能让绘制失败**
 * （跟 `@@ANIM fail` / `@@BG fail` 一个待遇）。
 */

/**
 * 归一 `options.windowBounds`。任何一个分量不是有限数、或宽高 ≤ 0 就整段不生成 ——
 * 一个 NaN 坐标会让 PowerPoint 放弃渲染它之后的所有形状（见 CLAUDE.md 硬约束 4）。
 */
const windowBoundsOf = (wb) => {
  if (!wb || typeof wb !== 'object') return null;
  const v = ['left', 'top', 'width', 'height'].map((k) => Number(wb[k]));
  if (v.some((n) => !Number.isFinite(n))) return null;
  if (!(v[2] > 0) || !(v[3] > 0)) return null;
  return { left: v[0], top: v[1], width: v[2], height: v[3] };
};

/**
 * 把 deck 的每一页归一成 `{ steps, background, title }`。空数组当一页空页处理，
 * 免得下面到处判 length。
 */
const normalizeSlides = (slides) => {
  const list = Array.isArray(slides) && slides.length ? slides : [{}];
  return list.map((s) => ({
    steps: Array.isArray(s && s.steps) ? s.steps : [],
    background: s && s.background != null ? s.background : null,
    title: s && s.title != null ? s.title : null,
  }));
};

/**
 * 多页 deck 的绘制指令流 → 可直接交给 osascript 的 AppleScript 文本。
 *
 * 一份 PPT 里可以有多套架构图：`slides` 每一项是**一页**，`steps` 是这一页自己
 * `sceneToDrawSteps()` 的产物（每页各自从 1 编号）。**全局重编号在这里做** ——
 * 生成的 `@@STEP` 标记里的 i = 之前各页步数之和 + 本页 step.i，total = 全 deck 步数之和。
 * 这样面板上的进度条分母是整份 PPT，而不是每翻一页就从头数一遍。
 *
 * 页与页之间只差三句：新建一页（`make new slide at end`）、这一页自己的底色、
 * 一条 `@@SLIDE <n> start`。**`save` 仍旧只在最后发一次**（坑 3：save 之后引用全失效）。
 *
 * 机器可读标记（都走 `log`，即 stderr）：
 *   `@@SLIDE <n> start`（每页第一步之前一条，单页时也发）
 *   `@@STEP <i> start` / `@@STEP <i> done`（i 是全 deck 的连续编号）
 *   `@@SHAPES <n>`（**每页一条**，调用方累加）
 *   `@@PHASE saving` / `@@PHASE done <绝对路径>`
 *   `@@ANIM fail …` / `@@BG fail …` / `@@WINDOW fail …`（尽力而为的三项失败时各报一次）
 *
 * @param {Array<{steps: Array, background?: string|null, title?: string|null}>} slides 每项一页
 * @param {object} [options] delayMs 每步之后停多久（演示 400，出片 0）；
 *                           quickDelayMs 连线与线上文字（DRAW_QUICK_KINDS）每步之后停多久，
 *                           **不给就等于 delayMs**（= 加这个参数之前的行为，逐字节相同）；
 *                           outPath 另存路径；
 *                           activate 是否把 PowerPoint 拉到前台；animate 是否加进入动画；
 *                           windowBounds `{left, top, width, height}`（屏幕点、原点左上）
 *                           = 把新建演示文稿的窗口摆到这里，**不给就一句窗口语句都不生成**
 */
export function deckToAppleScript(slides, options) {
  const opts = options || {};
  const pages = normalizeSlides(slides);
  const delayMs = Number.isFinite(opts.delayMs) ? Math.max(0, opts.delayMs) : 0;
  const delaySec = Math.round(delayMs) / 1000;
  // 小元素（连线、线上文字）走第二档。不给 quickDelayMs 就跟 delayMs 一个值 ——
  // 生成的脚本与加这个参数之前逐字节相同。
  const quickDelayMs = Number.isFinite(opts.quickDelayMs) ? Math.max(0, opts.quickDelayMs) : delayMs;
  const quickDelaySec = Math.round(quickDelayMs) / 1000;
  const animate = opts.animate !== false;
  const grandTotal = pages.reduce((n, p) => n + p.steps.length, 0);
  const out = [];

  out.push('-- 由 project/drivers/mac-powerpoint.mjs 生成，不要手改');
  if (pages.length === 1) {
    // 单页的头几行与多页刻意不同：stepsToAppleScript 走的就是这一支，
    // 它的输出必须跟改多页之前一字不差（出货冒烟和一堆断言盯着这一段）。
    if (pages[0].title) out.push(`-- 幻灯片：${comment(pages[0].title)}`);
  } else {
    out.push(`-- 共 ${pages.length} 页`);
    pages.forEach((p, k) => { if (p.title) out.push(`-- 第 ${k + 1} 页：${comment(p.title)}`); });
  }
  out.push(`-- 共 ${grandTotal} 步`);
  out.push('');
  out.push('property pAnimOK : true');
  out.push('');
  out.push('on emit(pMsg)');
  out.push('\tlog pMsg');
  out.push('end emit');
  out.push('');
  out.push('on run');
  out.push('\ttell application "Microsoft PowerPoint"');
  // 坑 6：第一次联系 PowerPoint 要么几乎立刻回，要么就是授权框没处理掉——后者默认会干等
  // 系统那两分钟上限才报 -1712。收紧到 30 秒，让调用方早点拿到判词，而不是让人盯着不动的面板。
  out.push('\t\twith timeout of 30 seconds');
  if (opts.activate !== false) {
    out.push('\t\t\tactivate');
    out.push('\t\t\tdelay 1.0');
  }
  out.push('\t\t\tset pPres to make new presentation');
  out.push('\t\t\tif (count of slides of pPres) = 0 then');
  out.push('\t\t\t\tset pSld to make new slide at end of pPres with properties {layout:slide layout blank}');
  out.push('\t\t\telse');
  out.push('\t\t\t\tset pSld to slide 1 of pPres');
  out.push('\t\t\t\tset layout of pSld to slide layout blank');
  out.push('\t\t\tend if');
  out.push('\t\tend timeout');
  // 演示模式：把刚建出来的这份演示文稿的窗口摆到位。不给 windowBounds 时**一句都不写**，
  // 生成的脚本与加这个功能之前逐字节相同。
  const wb = windowBoundsOf(opts.windowBounds);
  if (wb) {
    out.push('\t\ttry');
    out.push('\t\t\tset pWin to document window 1');
    out.push(`\t\t\tset left position of pWin to ${num(wb.left)}`);
    out.push(`\t\t\tset top of pWin to ${num(wb.top)}`);
    out.push(`\t\t\tset width of pWin to ${num(wb.width)}`);
    out.push(`\t\t\tset height of pWin to ${num(wb.height)}`);
    out.push('\t\ton error pErr number pNum');
    out.push('\t\t\tmy emit("@@WINDOW fail " & pErr & " (" & pNum & ")")');
    out.push('\t\tend try');
  }
  // 底色能设就设，设不了只记一笔，不让整次绘制失败。每页各设各的。
  const pushBackground = (hex) => {
    const bg = rgb(hex);
    if (!bg) return;
    out.push('\t\ttry');
    out.push('\t\t\tset follow master background of pSld to false');
    out.push(`\t\t\tset fore color of fill format of background of pSld to ${bg}`);
    out.push('\t\ton error pErr number pNum');
    out.push('\t\t\tmy emit("@@BG fail " & pErr & " (" & pNum & ")")');
    out.push('\t\tend try');
  };
  pushBackground(pages[0].background);
  if (!animate) out.push('\t\tset pAnimOK to false');
  out.push('\t\tmy emit("@@PHASE ready")');

  let offset = 0;   // 之前各页的步数之和 —— 全局重编号的底数
  pages.forEach((page, p) => {
    if (p > 0) {
      out.push('');
      if (page.title) out.push(`\t\t-- 第 ${p + 1} 页：${comment(page.title)}`);
      out.push('\t\tset pSld to make new slide at end of pPres with properties {layout:slide layout blank}');
      pushBackground(page.background);
    }
    out.push(`\t\tmy emit("@@SLIDE ${p + 1} start")`);
    out.push('');

    for (const step of page.steps) {
      const gi = offset + step.i;
      out.push(`\t\t-- [${gi}/${grandTotal}] ${comment(step.kind)} ${comment(step.id)}`.trimEnd());
      out.push(`\t\tmy emit("@@STEP ${gi} start")`);
      let shapeRef = null;
      for (const o of step.ops || []) {
        if (o.op === 'text') {
          // text 不新建形状，把文字写进本 step 刚建的那个形状里
          if (!shapeRef) continue;
          const group = (step.ops || []).filter((t) => t.op === 'text');
          if (o !== group[0]) continue; // 一个形状一次写完全部段落
          out.push(...textFrameLines(shapeRef, group, o.align, o.anchor, o.padX));
          continue;
        }
        const res = emitOp(o, animate);
        out.push(...res.lines);
        if (res.shapeRef) shapeRef = res.shapeRef;
      }
      out.push(`\t\tmy emit("@@STEP ${gi} done")`);
      const sec = DRAW_QUICK_KINDS.includes(step.kind) ? quickDelaySec : delaySec;
      if (sec > 0) out.push(`\t\tdelay ${sec}`);
      out.push('');
    }

    // 形状数每页各报一次，调用方累加成整份 PPT 的总数
    out.push('\t\tmy emit("@@SHAPES " & (count of shapes of pSld))');
    offset += page.steps.length;
  });

  if (opts.outPath) {
    // 坑 3：save as 之后所有引用作废，所以 save 是最后一步，后面不再碰任何形状。
    // 多页也只在这里存一次 —— 每页存一次会把前面几页的引用全废掉。
    out.push('\t\tmy emit("@@PHASE saving")');
    out.push(`\t\tsave pPres in (POSIX file ${str(opts.outPath)}) as save as Open XML presentation`);
    out.push(`\t\tmy emit("@@PHASE done " & ${str(opts.outPath)})`);
  } else {
    out.push('\t\tmy emit("@@PHASE done ")');
  }
  out.push('\tend tell');
  out.push('end run');
  out.push('');
  return out.join('\n');
}

/**
 * 单页包装。**输出与 `deckToAppleScript([{ steps, background: options.background,
 * title: options.slideTitle }], options)` 逐字节相同** —— 这里就是那么调的，
 * 别改成第二份实现。
 *
 * @param {Array} steps sceneToDrawSteps() 的产物
 * @param {object} [options] 同 deckToAppleScript，另加 slideTitle（仅用于注释）与
 *                           background（这一页的底色 `#RRGGBB`）
 */
export function stepsToAppleScript(steps, options) {
  const opts = options || {};
  return deckToAppleScript(
    [{ steps: Array.isArray(steps) ? steps : [], background: opts.background, title: opts.slideTitle }],
    opts,
  );
}

/**
 * 生成脚本 → 跑 osascript → 逐行把标记翻译成事件。**多页版**。
 *
 * @param {Array<{steps: Array, background?: string|null, title?: string|null}>} slides 每项一页
 * @param {object} options 同 deckToAppleScript（delayMs / quickDelayMs 原样透传给它），
 *                 另加 keepScript（留下临时脚本便于排错）
 * @param {(event: object) => void} [onEvent] 事件回调，形状见 shells/doubao/runner/panel/CONTRACT.md
 * @returns {Promise<{file: string|null, shapes: number|null, elapsedMs: number,
 *                    animation: boolean, script: string, slides: number}>}
 *          shapes 是各页 `@@SHAPES` 之和，slides 是页数
 */
export function runDrawDeck(slides, options, onEvent) {
  const opts = options || {};
  const pages = normalizeSlides(slides);
  const slideCount = pages.length;
  // 全局编号 → { step, slide }。编号口径与 deckToAppleScript 里那份**必须一致**：
  // 之前各页步数之和 + 本页 step.i。
  const byIndex = new Map();
  let grandTotal = 0;
  pages.forEach((page, p) => {
    for (const s of page.steps) byIndex.set(grandTotal + s.i, { step: s, slide: p + 1 });
    grandTotal += page.steps.length;
  });
  const script = deckToAppleScript(pages, opts);
  const dir = mkdtempSync(join(tmpdir(), 'doubao-draw-'));
  const scriptPath = join(dir, 'draw.applescript');
  writeFileSync(scriptPath, script, 'utf8');

  const emit = (e) => { if (typeof onEvent === 'function') onEvent(e); };
  const tail = [];
  const pushTail = (line) => { tail.push(line); if (tail.length > 200) tail.shift(); };

  return new Promise((resolve, reject) => {
    const started = Date.now();
    const startedAt = new Map();
    let animation = opts.animate !== false;
    let shapes = null;
    let file = null;
    let currentSlide = 1;
    // 「画到哪儿了」。-1712 的判词分两段全靠这两个开关（见 powerPointStalledMessage）：
    // 收到过任何一条 `@@STEP … done`，或者已经进了 `@@PHASE saving`，就不是授权问题了。
    let drewAny = false;
    let sawSaving = false;

    const child = spawn('osascript', [scriptPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LC_CTYPE: 'UTF-8' },
    });

    const handle = (line) => {
      if (!line) return;
      pushTail(line);
      let m = line.match(/@@STEP\s+(\d+)\s+(start|done)/);
      if (m) {
        const i = Number(m[1]);
        const found = byIndex.get(i) || {};
        const step = found.step || {};
        const slide = found.slide || currentSlide;
        if (m[2] === 'start') {
          startedAt.set(i, Date.now());
          emit({
            type: 'step', i, total: grandTotal, kind: step.kind, id: step.id, label: step.label,
            status: 'start', slide, slides: slideCount,
          });
        } else {
          drewAny = true;
          const t0 = startedAt.get(i);
          emit({
            type: 'step', i, total: grandTotal, kind: step.kind, id: step.id, label: step.label,
            status: 'done', ms: t0 ? Date.now() - t0 : 0, slide, slides: slideCount,
          });
        }
        return;
      }
      m = line.match(/@@SLIDE\s+(\d+)\s+start/);
      if (m) {
        currentSlide = Number(m[1]);
        // 单页时不发 phase:slide —— 只有一页的事件流跟以前一模一样，面板不必多显示一行
        if (slideCount > 1) {
          const page = pages[currentSlide - 1];
          emit({
            type: 'phase', phase: 'slide', slide: currentSlide, slides: slideCount,
            title: page ? page.title : null,
          });
        }
        return;
      }
      // 每页各报一条 @@SHAPES，累加成整份 PPT 的形状总数
      m = line.match(/@@SHAPES\s+(\d+)/);
      if (m) { shapes = (shapes || 0) + Number(m[1]); return; }
      m = line.match(/@@PHASE\s+saving/);
      if (m) { sawSaving = true; emit({ type: 'phase', phase: 'saving' }); return; }
      m = line.match(/@@PHASE\s+done\s*(.*)$/);
      if (m) { file = m[1].trim() || null; return; }
      m = line.match(/@@ANIM\s+fail\s*(.*)$/);
      if (m) {
        animation = false;
        emit({ type: 'log', level: 'warn', message: `进入动画加不上，已跳过（animation:false）：${m[1].trim()}` });
        return;
      }
      m = line.match(/@@BG\s+fail\s*(.*)$/);
      if (m) { emit({ type: 'log', level: 'warn', message: `幻灯片底色设不了：${m[1].trim()}` }); return; }
      // 摆窗口是锦上添花：摆不动只报一声，图照画、退出码照旧
      m = line.match(/@@WINDOW\s+fail\s*(.*)$/);
      if (m) { emit({ type: 'log', level: 'warn', message: `PowerPoint 窗口没摆到位：${m[1].trim()}` }); return; }
      if (line.indexOf('@@PHASE ready') >= 0) {
        emit({ type: 'log', level: 'info', message: 'PowerPoint 已就绪，空白版式第 1 页建好' });
      }
    };

    const reader = () => {
      let buf = '';
      return (chunk) => {
        buf += chunk;
        const parts = buf.split('\n');
        buf = parts.pop();
        for (const p of parts) handle(p.replace(/\r$/, ''));
      };
    };
    child.stderr.setEncoding('utf8');
    child.stdout.setEncoding('utf8');
    child.stderr.on('data', reader());
    child.stdout.on('data', reader());

    child.on('error', (err) => {
      if (!opts.keepScript) rmSync(dir, { recursive: true, force: true });
      reject(new Error(`osascript 起不来：${err.message}`));
    });
    child.on('close', (code) => {
      const kept = opts.keepScript ? scriptPath : null;
      if (!opts.keepScript) rmSync(dir, { recursive: true, force: true });
      if (code !== 0) {
        const last = tail.slice(-20).join('\n');
        const raw = `osascript 退出码 ${code}\n最后 20 行输出：\n${last}`;
        // 坑 6：-1712 / -1743 换成人话判词，原始堆栈挪进 detail —— 这两个码只可能是
        // 授权没处理掉，贴 AppleScript 堆栈给用户看没有任何用。
        const authCode = noResponseCode(last);
        if (authCode && (drewAny || sawSaving) && POWERPOINT_STALLED_CODES.includes(authCode)) {
          // 坑 7：图已经画进去了，-1712 只可能是 PowerPoint 前台压着一个对话框
          // （最常见的是保存时的「授予文件访问权限」）。跟授权那条分开，退出码 5。
          const stalledPhase = sawSaving ? 'saving' : 'drawing';
          const error = new Error(powerPointStalledMessage(authCode, stalledPhase));
          error.stalledCode = authCode;
          error.stalledPhase = stalledPhase;
          error.detail = raw;
          reject(error);
          return;
        }
        if (authCode) {
          const error = new Error(powerPointAuthMessage(authCode));
          error.authCode = authCode;
          error.detail = raw;
          reject(error);
          return;
        }
        reject(new Error(raw));
        return;
      }
      resolve({
        file: file || opts.outPath || null,
        shapes,
        elapsedMs: Date.now() - started,
        animation,
        script: kept || script,
        slides: slideCount,
      });
    });
  });
}

/**
 * 单页包装。跟 stepsToAppleScript 一样，只是把参数摊成一页交给 runDrawDeck，
 * 不是第二份实现。
 *
 * @param {Array} steps
 * @param {object} options 同 runDrawDeck，另加 slideTitle 与 background（这一页的）
 * @param {(event: object) => void} [onEvent]
 */
export function runDraw(steps, options, onEvent) {
  const opts = options || {};
  return runDrawDeck(
    [{ steps: Array.isArray(steps) ? steps : [], background: opts.background, title: opts.slideTitle }],
    opts,
    onEvent,
  );
}
