// win-powerpoint.mjs
// 绘制指令流（project/lib/exporters/draw-steps.mjs）→ PowerShell 文本 → 通过 COM 自动化
// 驱动 **Windows 桌面版 Microsoft PowerPoint** 逐个把图元画出来，边画边把事件回调出去。
//
// 这是 project/drivers/mac-powerpoint.mjs 的 Windows 等价物：同一份 steps 进去，
// 同一套事件出来（见 shells/doubao/runner/panel/CONTRACT.md），面板一个字都不用改。
// 区别只在「怎么下命令」：mac 是 AppleScript + osascript，Windows 是 PowerShell + COM。
//
// ── 与 mac 驱动器的差异清单（每一条都是**故意**不一样，别照抄回去）─────────────
//
//   1. **Windows 上没有 macOS 那种自动化授权框。** 一个进程用 COM 驱动另一个进程不需要
//      任何人点「允许」，系统设置里也没有对应的开关。所以本文件的任何判词里都**不许**
//      出现「授权」「允许」「系统设置」——把人引去点一个根本不存在的框，他只会一直回
//      「重试」。「PowerPoint 不应答」在 Windows 上只有一种真原因：**它前台压着一个对话框**
//      （首次启动的登录/激活、恢复文档、另存冲突），COM 的消息过滤器于是一直拒收调用。
//   2. **没有沙盒落点护栏。** PowerPoint for Mac 是沙盒 App，往 /tmp、/var/folders 保存会
//      挂死在「授予文件访问权限」对话框上；Windows 版不是沙盒 App，能写的地方就直接写。
//      落点检查（shells/doubao/runner/draw.mjs 的 checkOutPath）在 win32 上不该硬拒绝。
//   3. **线不需要 min 修正。** mac 的坑 2（`make new line shape` 把包围盒左上角钉在起点，
//      往左/往上的线整体偏一个宽或高）是 AppleScript 字典的毛病；COM 的 `Shapes.AddLine`
//      四个坐标就是四个坐标，补 min 修正反而会把线挪歪。**别照抄那两句。**
//   4. **段落分隔符是 CR（`[char]13`），不是 LF。** PowerPoint 的 TextRange.Text 里一个
//      回车（\r）分一段；写 \n 进去段落数不对，逐段样式会全体错位。
//   5. **脚本文件必须 UTF-8 带 BOM。** Windows PowerShell 5.1 读无 BOM 的 UTF-8 会按
//      系统 ANSI 代码页解，中文标签全变乱码 —— 而且不报错。PowerShell 7 不挑，但 5.1 是
//      Windows 10/11 自带的那个，默认就跑它。
//   6. **字体名要再过一层替身（WIN_FONT_SUB）。** draw-steps 挂在 op 上的族名是按 macOS
//      算的（Helvetica Neue / 苹方 / Menlo），Windows 上一个都没装；点名一个装不了的族，
//      PowerPoint 不报错、静默回退到主题字体（等线 / Calibri）。mac 驱动器直接写原名，
//      这里必须先查表。**这张表没在真 Windows 上验证过**，见 WIN_FONT_SUB 的注释。
//
// ── 其余照抄 mac 的设计 ──────────────────────────────────────────────────────
//
//   * 坐标数值全部在 Node 侧算成字面量内联，生成的脚本里不做算术；
//   * 变量名一律 `$p` 前缀（COM 枚举名与常见自动变量都躲开，也便于测试一眼扫）；
//   * 进 `#` 注释的 id / kind / 标题先把换行压成空格 —— PowerShell 的 `#` 同样只到行尾，
//     不压就是一次静默的任意命令执行；
//   * 保存是最后一步；画完**不 Quit**，PowerPoint 留着给人看。
//
// ── 机器可读标记（全部走 stdout，`[Console]::Out.WriteLine` + `Flush`）───────
//
//   @@PHASE ready / @@SLIDE <n> start / @@STEP <i> start|done / @@SHAPES <n>（每页一次）
//   @@PHASE saving / @@PHASE done <绝对路径> / @@ANIM fail … / @@BG fail …
//   @@ERROR 0x<HRESULT 八位十六进制> <message>（随后 exit 1）
//
// 导出名：deckToPowerShell / stepsToPowerShell / runDrawDeck / runDraw / probePowerPoint
//         classifyFailure / powerPointMissingMessage / powerPointBusyMessage
//         powerPointStalledMessage / powerPointGoneMessage / powerShellMissingMessage
//         WIN_POWERPOINT_MISSING_CODES / WIN_POWERPOINT_BUSY_CODES / WIN_POWERPOINT_GONE_CODES
//         WIN_NO_POWERSHELL_CODE / WIN_FONT_SUB / winFontSub

import { spawn } from 'node:child_process';
import { accessSync, constants, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* ══ 1. 错误码与判词 ══════════════════════════════════════════════════════ */

/**
 * REGDB_E_CLASSNOTREG —— `New-Object -ComObject PowerPoint.Application` 在注册表里
 * 找不到 PowerPoint.Application 这个 ProgID。意思只有一个：**本机没装桌面版 PowerPoint**
 * （或者只装了 Microsoft 365 网页版 / WPS —— 它们都不注册这个 ProgID）。
 */
export const WIN_POWERPOINT_MISSING_CODES = Object.freeze(['0x80040154']);

/**
 * RPC_E_CALL_REJECTED / RPC_E_SERVERCALL_RETRYLATER —— PowerPoint 的 OLE 消息过滤器
 * 在「它自己忙着」时拒收外部调用。**在 Windows 上这不是授权问题**（没有那种东西），
 * 真凶几乎总是 PowerPoint 前台压着一个模态对话框：首次启动的登录/激活、恢复文档、
 * 另存冲突。所以判词是「去看看 PowerPoint 窗口」，不是「去点允许」。
 */
export const WIN_POWERPOINT_BUSY_CODES = Object.freeze(['0x80010001', '0x8001010A']);

/**
 * RPC_E_DISCONNECTED / RPC 服务器不可用 / 远程过程调用失败 —— 我们握着的 COM 引用
 * 对面那个 PowerPoint 进程没了：被人关掉，或者它自己崩了。跟「忙」完全两码事，
 * 重试没用，得先把 PowerPoint 重新打开。
 */
export const WIN_POWERPOINT_GONE_CODES = Object.freeze(['0x80010108', '0x800706BA', '0x800706BE']);

/** `0x80040154` → `-2147221164`（同一个 HRESULT 的十进制写法，.NET 报错里常见）。 */
const decimalOf = (hex) => String(BigInt.asIntN(32, BigInt(hex)));

/** 一个码的三种写法：`0x80040154` / `80040154` / `-2147221164`，大小写不敏感。 */
const codeSeen = (text, code) => {
  const bare = code.slice(2);
  const hex = new RegExp(`(?<![0-9A-Fa-f])(?:0x)?${bare}(?![0-9A-Fa-f])`, 'i');
  if (hex.test(text)) return true;
  const dec = decimalOf(code);
  return new RegExp(`(?<![0-9])${dec}(?![0-9])`).test(text);
};

const KIND_CODES = [
  ['missing', WIN_POWERPOINT_MISSING_CODES],
  ['busy', WIN_POWERPOINT_BUSY_CODES],
  ['gone', WIN_POWERPOINT_GONE_CODES],
];

/**
 * 从脚本输出里认 HRESULT。认不出来返回 `{ kind: null, code: null }`。
 *
 * @param {string} text 脚本的 stdout/stderr（`@@ERROR 0x… …` 那一行通常就在里面）
 * @returns {{ kind: 'missing'|'busy'|'gone'|null, code: string|null }}
 */
export function classifyFailure(text) {
  const s = String(text == null ? '' : text);
  for (const [kind, codes] of KIND_CODES) {
    for (const code of codes) {
      if (codeSeen(s, code)) return { kind, code };
    }
  }
  return { kind: null, code: null };
}

/**
 * 「本机没装桌面版 PowerPoint」。跟「装了但不应答」解法完全相反，所以判词分开。
 * **不许提授权** —— Windows 上没有那个框，提了就是把人送进死循环。
 */
export function powerPointMissingMessage(code) {
  return `本机没找到 Microsoft PowerPoint 桌面版（${code || '找不到应用'}）。`
    + '这个技能只能驱动桌面版 PowerPoint，Microsoft 365 网页版、WPS 都不行。'
    + '装好桌面版 Office 并打开过一次 PowerPoint，再回复「重试」。';
}

/**
 * 「一步都没画，PowerPoint 就不应答」。对应 mac 的 powerPointAuthMessage 那个位置
 * （调用方也照样从 `error.authCode` 走退出码 3），但**措辞完全不同**：
 * Windows 上没有授权框，唯一该让人做的事是去看 PowerPoint 窗口上压着什么。
 */
export function powerPointBusyMessage(code) {
  return `PowerPoint 没有响应（${code || '无响应'}）。`
    + '请切到 PowerPoint 窗口看看是不是有对话框挡着'
    + '（首次启动的登录/激活、恢复文档、另存冲突），处理掉再回复「重试」。';
}

/**
 * 「画起来之后才不应答」。跟上一条分开，因为能画出形状就说明 COM 通道本来是好的，
 * 中途被挡住只可能是 PowerPoint 自己弹了框。
 * @param {string} [code]
 * @param {'drawing'|'saving'} [phase]
 */
export function powerPointStalledMessage(code, phase) {
  return `PowerPoint 在${phase === 'saving' ? '保存' : '绘制'}时没有响应（${code || '无响应'}）。`
    + '请看 PowerPoint 窗口是不是弹了对话框（例如「另存为」对话框或文件被占用提示），'
    + '关掉它后回复「重试」。已画好的内容还在 PowerPoint 里，不会丢。';
}

/**
 * 「PowerPoint 进程中途退出了」。退出码仍旧是 1（跟别的绘制失败一样要改 spec 或查日志之外
 * 没有第二条路），但 run.mjs 给它单独一条结论行 —— 套通用的「画的时候出错了：」前缀，
 * 用户看到的第一句会变成一层没用的转述，真正该做的事（先把 PowerPoint 重新打开）被埋在后面。
 */
export function powerPointGoneMessage(code) {
  return `PowerPoint 进程中途退出了（${code || '连接断开'}）。`
    + '它在画图过程中被关掉或者崩溃了，已经画好的内容可能没有保存下来。'
    + '请重新打开 PowerPoint 之后回复「重试」，会从头重画。';
}

/**
 * 「本机连 PowerShell 都没有」。这一条跟 PowerPoint 一点关系都没有 —— 是壳自己起不来，
 * 所以判词里**不提 PowerPoint**，也不叫人去看 PowerPoint 窗口。
 *
 * 以前这一支返回的 code 是 `'无响应'`，run.mjs 认不出来，于是套了 busy 那句
 * 「PowerPoint 没有响应……请切到 PowerPoint 窗口看看是不是有对话框挡着」——
 * 用户会去 PowerPoint 里找一个根本不存在的对话框，真原因只在事件流的 detail 里躺着。
 */
export function powerShellMissingMessage() {
  return '本机找不到 PowerShell（powershell.exe / pwsh 都不在 PATH 里）。'
    + 'Windows 10/11 自带 Windows PowerShell 5.1，'
    + '请检查系统的 PATH 环境变量里有 `%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\`，'
    + '或者安装 PowerShell 7，然后回复「重试」。';
}

/**
 * `probePowerPoint()` 在「两个 shell 都起不来」时返回的 code。**不是 HRESULT** ——
 * 压根没跑起来任何东西，哪来的 HRESULT。run.mjs 靠它认出这一支，走退出码 6。
 */
export const WIN_NO_POWERSHELL_CODE = '无 PowerShell';

/* ══ 2. PowerShell 字面量 ═════════════════════════════════════════════════ */

const num = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0';
  return String(Math.round(n * 100) / 100);
};

/**
 * `#RRGGBB` → OLE 颜色整数 **R + G*256 + B*65536**。
 *
 * COM 的 `ForeColor.RGB` 吃的是 COLORREF：低字节是红、高字节是蓝，跟 HTML 的
 * `#RRGGBB` 正好反着。写反了不报错，整张图的配色变成互补色。
 */
const rgbInt = (hex) => {
  const h = String(hex || '').replace('#', '');
  if (h.length !== 6) return null;
  const v = parseInt(h, 16);
  if (!Number.isFinite(v)) return null;
  const r = (v >> 16) & 255;
  const g = (v >> 8) & 255;
  const b = v & 255;
  return String(r + g * 256 + b * 65536);
};

/**
 * PowerShell 字符串字面量：一律单引号（里面 `$` 和反引号都不转义），`'` 翻倍。
 * 带换行的文本拼成 `('段1' + [char]13 + '段2')` —— PowerPoint 的 TextRange 里
 * 分段靠 CR，写 LF 段数就不对。
 */
const psStr = (text) => {
  const parts = String(text == null ? '' : text)
    .split(/\r\n|\r|\n/)
    .map((line) => `'${line.replace(/'/g, "''")}'`);
  return parts.length === 1 ? parts[0] : `(${parts.join(' + [char]13 + ')})`;
};

/**
 * 进 `#` 注释行的文本。PowerShell 的 `#` 注释只到行尾，任何带换行的值进了注释，
 * 换行之后那段就变成一条真语句 —— 拿 step.id 当载体就是一次静默的任意命令执行。
 * 所以在这里统一把换行（含 CR / U+2028 / U+2029）压成空格。
 * 谁往生成的脚本里加新的注释行，都得过这一道。
 */
const comment = (text) => String(text == null ? '' : text).replace(/[\r\n\u2028\u2029]+/g, ' ');

/* ══ 3. COM 常量（脚本里写字面量，旁边注名字）══════════════════════════════ */

const MSO_SHAPE = {
  rect: '1',        // msoShapeRectangle
  roundRect: '5',   // msoShapeRoundedRectangle
  diamond: '4',     // msoShapeDiamond
  oval: '9',        // msoShapeOval
  can: '13',        // msoShapeCan
};
const MSO_SHAPE_NAME = {
  1: 'msoShapeRectangle',
  5: 'msoShapeRoundedRectangle',
  4: 'msoShapeDiamond',
  9: 'msoShapeOval',
  13: 'msoShapeCan',
};

const PP_ALIGN = { left: '1', center: '2', right: '3' };          // ppAlignLeft/Center/Right
const PP_ALIGN_NAME = { 1: 'ppAlignLeft', 2: 'ppAlignCenter', 3: 'ppAlignRight' };
const MSO_ANCHOR = { top: '1', middle: '3', bottom: '4' };        // msoAnchorTop/Middle/Bottom
const MSO_ANCHOR_NAME = { 1: 'msoAnchorTop', 3: 'msoAnchorMiddle', 4: 'msoAnchorBottom' };

/* ══ 4. 脚本片段 ═══════════════════════════════════════════════════════════ */

// 圆角：Adjustments 1 是「半径 / 短边的一半」的比例，0 = 直角，0.5 = 半圆（药丸）
const roundAdj = (radius, w, h) => {
  const half = Math.max(1, Math.min(Number(w) || 0, Number(h) || 0) / 2);
  return Math.max(0, Math.min(0.5, (Number(radius) || 0) / half));
};

/**
 * 形状 / 文本框里的文字排版。语义逐条对齐 mac 驱动器的 textFrameLines：
 * AutoSize 关掉（几何冻死）、不换行、只留左边距、竖直锚点、整段文本一次写完、
 * 再逐段设字号/字色/粗细。
 *
 * **段号按每个 op 实际占几段累加**，不能拿 op 的序号当段号：Text 是把所有 op 的文字
 * 用 CR 拼起来的，op 自己的文字里带换行时段数就多于 op 数。按 op 序号写的话，
 * label="订单服务\n(Order)" + sublabel="MySQL 主库" 会把 sublabel 的小字样式套到
 * label 的第二行上，真正的 sublabel（第 3 段）一条样式都没有。
 */
/**
 * 苹方族 / macOS 族 → **Windows 上真的装了的替身**。
 *
 * draw-steps 挂在 op 上的 `fontLatin` / `fontEa` 是按 macOS 的字体环境算出来的
 * （`pptxFonts()`，规则见 docs/pptx-font-substitution.md）：西文是 Helvetica Neue、
 * 中日韩是苹方，等宽皮肤是 Menlo。**这三个 Windows 一个都没有**。点名一个装不了的族，
 * PowerPoint 不报错，静默回退到主题字体（等线 / Calibri），中文西文都跟页面对不上 ——
 * 跟一句字体都不设的结果一样。所以在 Windows 这一侧再过一层替身。
 *
 * 选谁的依据（都只是**推断**，见下面的免责）：
 *   * Helvetica Neue → Arial —— docs/pptx-font-substitution.md 在真 PowerPoint 上扫过
 *     一轮西文候选，Arial 是第二名（文字 ink 95.95%，第一名 Helvetica Neue 96.09%），
 *     差 0.14 个点；而 Arial 是 Windows 必装的。
 *   * 苹方简 → 微软雅黑、苹方繁/港 → 微软正黑 —— 同为无衬线黑体、同为系统默认中文族。
 *   * Songti SC → 宋体（SimSun）—— academic 皮肤走这条，两边都是中文衬线。
 *   * Menlo / SF Mono / Monaco → Consolas —— 三者都是等宽，Consolas 是 Windows 自带的那个。
 *   * 表里没有的**原样透传**：Arial / Georgia / Times New Roman / 微软雅黑 / 宋体 /
 *     Consolas 这些 Windows 自带的族，以及用户自定义皮肤写的任何族名，都不该被改。
 *
 * ⚠️ **这张表没有在 Windows 上验证过。** 本仓的保真台（scripts/pptx-fidelity.mjs）只跑
 * macOS + PowerPoint for Mac，Arial 那 95.95% 也是在 macOS 上量的。真机验收清单见
 * docs/doubao-windows.md 第 4 节；在一台真 Windows 上量过之前，这里的每一条都只是推断。
 */
export const WIN_FONT_SUB = Object.freeze({
  'helvetica neue': 'Arial',
  'pingfang sc': 'Microsoft YaHei',
  'pingfang tc': 'Microsoft JhengHei',
  'pingfang hk': 'Microsoft JhengHei',
  'hiragino sans gb': 'Microsoft YaHei',
  'songti sc': 'SimSun',
  'heiti sc': 'Microsoft YaHei',
  stheiti: 'Microsoft YaHei',
  menlo: 'Consolas',
  'sf mono': 'Consolas',
  monaco: 'Consolas',
});

/**
 * 查 WIN_FONT_SUB。键大小写不敏感；查不到的原样透传；空值返回 null（调用方据此不写这句）。
 * @param {string|null|undefined} family
 * @returns {string|null}
 */
export function winFontSub(family) {
  const name = String(family == null ? '' : family).trim();
  if (name === '') return null;
  const key = name.toLowerCase();
  return Object.prototype.hasOwnProperty.call(WIN_FONT_SUB, key) ? WIN_FONT_SUB[key] : name;
}

const textFrameLines = (ref, ops, align, anchor, padX) => {
  const anchorV = MSO_ANCHOR[anchor] || MSO_ANCHOR.middle;
  const alignV = PP_ALIGN[align] || PP_ALIGN.center;
  const out = [
    `  $pTf = ${ref}.TextFrame`,
    '  try { $pTf.AutoSize = 0 } catch { }   # ppAutoSizeNone',
    '  Invoke-PCom { $pTf.WordWrap = 0 }     # msoFalse',
    `  Invoke-PCom { $pTf.MarginLeft = ${num(padX || 0)} }`,
    '  Invoke-PCom { $pTf.MarginRight = 0 }',
    '  Invoke-PCom { $pTf.MarginTop = 0 }',
    '  Invoke-PCom { $pTf.MarginBottom = 0 }',
    `  Invoke-PCom { $pTf.VerticalAnchor = ${anchorV} }   # ${MSO_ANCHOR_NAME[anchorV]}`,
    '  $pTr = $pTf.TextRange',
    `  Invoke-PCom { $pTr.Text = ${psStr(ops.map((o) => o.text).join('\n'))} }`,
    `  Invoke-PCom { $pTr.ParagraphFormat.Alignment = ${alignV} }   # ${PP_ALIGN_NAME[alignV]}`,
  ];
  // 字体：**整个 TextRange 各设一次**，不逐段 —— 一个形状里两段字用的是同一套族名。
  // NameAscii 管 0–127 的西文，NameFarEast 管中日韩（与 mac 驱动器的 `ASCII name` /
  // `east asian name` 是同一对属性）。族名先过 winFontSub()：draw-steps 给的是 macOS 的
  // 族名，Windows 上一个都没有。两句各包 try —— 属性名在旧版 COM 类型库里未必有，
  // 不包会让整次绘制挂掉。op 上没挂字体字段时一句都不写（向后兼容）。
  const fontOf = (key) => {
    for (const o of ops) {
      const v = o && o[key];
      if (typeof v === 'string' && v !== '') return v;
    }
    return null;
  };
  const latin = winFontSub(fontOf('fontLatin'));
  const ea = winFontSub(fontOf('fontEa'));
  if (latin) out.push(`  try { $pTr.Font.NameAscii = ${psStr(latin)} } catch { }`);
  if (ea) out.push(`  try { $pTr.Font.NameFarEast = ${psStr(ea)} } catch { }`);
  let para = 1;
  ops.forEach((o) => {
    const span = String(o.text == null ? '' : o.text).split(/\r\n|\r|\n/).length;
    // 只有一个 op 且不含换行时，直接对整个 TextRange 设，省几次 COM 往返
    const targets = ops.length === 1 && span === 1
      ? ['$pTr']
      : Array.from({ length: span }, (_, k) => `$pTr.Paragraphs(${para + k})`);
    para += span;
    for (const target of targets) {
      out.push(`  Invoke-PCom { ${target}.Font.Size = ${num(o.fontSize)} }`);
      const color = rgbInt(o.color);
      if (color) out.push(`  Invoke-PCom { ${target}.Font.Color.RGB = ${color} }`);
      if (o.bold) out.push(`  Invoke-PCom { ${target}.Font.Bold = -1 }   # msoTrue`);
    }
  });
  return out;
};

const emitOp = (o, animate) => {
  const lines = [];
  const paint = (ref) => {
    const fill = rgbInt(o.fill);
    if (fill) lines.push(`  Invoke-PCom { ${ref}.Fill.ForeColor.RGB = ${fill} }`);
    const stroke = rgbInt(o.stroke);
    if (stroke) {
      lines.push(`  Invoke-PCom { ${ref}.Line.ForeColor.RGB = ${stroke} }`);
      lines.push(`  Invoke-PCom { ${ref}.Line.Weight = ${num(o.strokeWidth || 0.75)} }`);
      if (o.dash) lines.push(`  Invoke-PCom { ${ref}.Line.DashStyle = 4 }   # msoLineDash`);
    } else {
      lines.push(`  Invoke-PCom { ${ref}.Line.Visible = 0 }   # msoFalse：没描边`);
    }
  };
  const animateShape = (ref) => {
    if (!animate) return;
    lines.push('  if ($pAnimOK) {');
    // msoAnimEffectAppear=1 / msoAnimateLevelNone=0 / msoAnimTriggerAfterPrevious=3
    lines.push(`    try { $null = Invoke-PCom { $pSld.TimeLine.MainSequence.AddEffect(${ref}, 1, 0, 3) } }`);
    lines.push('    catch { $script:pAnimOK = $false; Write-PMark (\'@@ANIM fail \' + (Get-PHResult $_) + \' \' + (Get-PWhy $_)) }');
    lines.push('  }');
  };

  if (o.op === 'rect' || o.op === 'roundRect') {
    const kind = MSO_SHAPE[o.shape] || MSO_SHAPE[o.op] || MSO_SHAPE.rect;
    lines.push(`  $pSh = Invoke-PCom { $pSld.Shapes.AddShape(${kind}, ${num(o.x)}, ${num(o.y)}, ${num(o.w)}, ${num(o.h)}) }   # ${MSO_SHAPE_NAME[kind]}`);
    if (o.radius != null) {
      // 直角矩形 / 菱形 / 椭圆没有 Adjustments 1，取不到就算了
      lines.push(`  try { $pSh.Adjustments.Item(1) = ${num(roundAdj(o.radius, o.w, o.h))} } catch { }`);
    }
    paint('$pSh');
    animateShape('$pSh');
    return { lines, shapeRef: '$pSh' };
  }

  if (o.op === 'label') {
    if (rgbInt(o.fill)) {
      // 有底色 → 圆角矩形（边标签的白底药丸、容器的标题药丸都走这条）
      lines.push(`  $pSh = Invoke-PCom { $pSld.Shapes.AddShape(${MSO_SHAPE.roundRect}, ${num(o.x)}, ${num(o.y)}, ${num(o.w)}, ${num(o.h)}) }   # msoShapeRoundedRectangle`);
      lines.push(`  try { $pSh.Adjustments.Item(1) = ${num(roundAdj(o.radius != null ? o.radius : 0, o.w, o.h))} } catch { }`);
      paint('$pSh');
    } else {
      // 无底色 → 纯文本框（默认无填充无描边，不用另外藏）
      lines.push(`  $pSh = Invoke-PCom { $pSld.Shapes.AddTextbox(1, ${num(o.x)}, ${num(o.y)}, ${num(o.w)}, ${num(o.h)}) }   # msoTextOrientationHorizontal`);
    }
    lines.push(...textFrameLines('$pSh', [o], o.align, o.anchor, o.padX));
    animateShape('$pSh');
    return { lines, shapeRef: '$pSh' };
  }

  if (o.op === 'line') {
    // 差异 3：COM 的 AddLine 四个坐标就是四个坐标，**不要**补 mac 那两句 min 修正
    lines.push(`  $pLn = Invoke-PCom { $pSld.Shapes.AddLine(${num(o.x1)}, ${num(o.y1)}, ${num(o.x2)}, ${num(o.y2)}) }`);
    const color = rgbInt(o.color);
    if (color) lines.push(`  Invoke-PCom { $pLn.Line.ForeColor.RGB = ${color} }`);
    lines.push(`  Invoke-PCom { $pLn.Line.Weight = ${num(o.width || 1)} }`);
    if (o.dash) lines.push('  Invoke-PCom { $pLn.Line.DashStyle = 4 }   # msoLineDash');
    if (o.arrowEnd) {
      lines.push('  Invoke-PCom { $pLn.Line.EndArrowheadStyle = 2 }    # msoArrowheadTriangle');
      lines.push('  Invoke-PCom { $pLn.Line.EndArrowheadWidth = 2 }    # msoArrowheadWidthMedium');
      lines.push('  Invoke-PCom { $pLn.Line.EndArrowheadLength = 2 }   # msoArrowheadLengthMedium');
    }
    if (o.arrowStart) {
      lines.push('  Invoke-PCom { $pLn.Line.BeginArrowheadStyle = 2 }    # msoArrowheadTriangle');
      lines.push('  Invoke-PCom { $pLn.Line.BeginArrowheadWidth = 2 }    # msoArrowheadWidthMedium');
      lines.push('  Invoke-PCom { $pLn.Line.BeginArrowheadLength = 2 }   # msoArrowheadLengthMedium');
    }
    animateShape('$pLn');
    return { lines, shapeRef: '$pLn' };
  }

  return { lines, shapeRef: null };
};

/** 一页 = `{ steps, background, title }`。归一化 + 缺省回落到 options。 */
const normalizeSlides = (slides, opts) => (Array.isArray(slides) ? slides : []).map((s) => ({
  steps: Array.isArray(s && s.steps) ? s.steps : [],
  background: s && s.background != null ? s.background : opts.background,
  title: s && s.title != null ? s.title : opts.slideTitle,
}));

/**
 * 全局重编号：每页的 step.i 各自从 1 起，事件与 `@@STEP` 里的 i 是「之前各页步数之和 + step.i」。
 * @returns {{ total: number, offsets: number[], byGlobal: Map<number, {step: object, slide: number}> }}
 */
const deckIndex = (pages) => {
  const offsets = [];
  const byGlobal = new Map();
  let offset = 0;
  pages.forEach((page, k) => {
    offsets.push(offset);
    for (const step of page.steps) {
      byGlobal.set(offset + Number(step.i), { step, slide: k + 1 });
    }
    offset += page.steps.length;
  });
  return { total: offset, offsets, byGlobal };
};

/* ══ 5. 脚本生成 ═══════════════════════════════════════════════════════════ */

/**
 * 多页绘制指令流 → 可直接交给 powershell.exe 的脚本文本。
 *
 * @param {Array<{steps: Array, background?: string, title?: string}>} slides
 * @param {object} [options] delayMs 每步之后停多久；outPath 另存路径；slideTitle 缺省页标题；
 *                           activate 是否把 PowerPoint 拉到前台；background 缺省底色；
 *                           animate 是否加进入动画
 * @returns {string}
 */
export function deckToPowerShell(slides, options) {
  const opts = options || {};
  const pages = normalizeSlides(slides, opts);
  const { total, offsets } = deckIndex(pages);
  const delayMs = Number.isFinite(opts.delayMs) ? Math.max(0, Math.round(opts.delayMs)) : 0;
  const animate = opts.animate !== false;
  const out = [];

  out.push('# 由 project/drivers/win-powerpoint.mjs 生成，不要手改');
  if (opts.slideTitle) out.push(`# 幻灯片：${comment(opts.slideTitle)}`);
  out.push(`# 共 ${pages.length} 页 / ${total} 步`);
  out.push('');
  // 差异 5：文件本身还要带 UTF-8 BOM（写盘那一步加），这一句管的是**输出**编码
  out.push('[Console]::OutputEncoding = [System.Text.Encoding]::UTF8');
  out.push("$ErrorActionPreference = 'Stop'");
  out.push('$pAnimOK = $true');
  out.push('$pRetryLeft = 3');
  out.push('');
  out.push('function Write-PMark {');
  out.push('  param([string]$pMsg)');
  out.push('  [Console]::Out.WriteLine($pMsg)');
  out.push('  [Console]::Out.Flush()');
  out.push('}');
  out.push('');
  out.push('# HRESULT 取内层 COMException 的，没有再退回最外层；一个都取不到写 0x00000000');
  out.push('function Get-PHResult {');
  out.push('  param($pRecord)');
  out.push('  $pHr = 0');
  out.push('  try {');
  out.push('    $pEx = $pRecord.Exception');
  out.push('    while ($null -ne $pEx) {');
  out.push('      if ($pEx -is [System.Runtime.InteropServices.COMException]) { $pHr = $pEx.HResult; break }');
  out.push('      $pEx = $pEx.InnerException');
  out.push('    }');
  out.push('    if ($pHr -eq 0 -and $null -ne $pRecord.Exception) { $pHr = $pRecord.Exception.HResult }');
  out.push('  } catch { $pHr = 0 }');
  out.push("  return ('0x{0:X8}' -f [int]$pHr)");
  out.push('}');
  out.push('');
  out.push('function Get-PWhy {');
  out.push('  param($pRecord)');
  out.push("  try { return (([string]$pRecord.Exception.Message) -replace '[\\r\\n]+', ' ') } catch { return '未知错误' }");
  out.push('}');
  out.push('');
  out.push('# PowerPoint 忙的时候 OLE 消息过滤器会抛 RPC_E_CALL_REJECTED（0x80010001）/');
  out.push('# RPC_E_SERVERCALL_RETRYLATER（0x8001010A）。这两个码同一步最多重试 3 次、每次隔 500ms，');
  out.push('# 预算 $pRetryLeft 在每一步开头重置。别的码一律直接抛出去。');
  out.push('function Invoke-PCom {');
  out.push('  param([scriptblock]$pAction)');
  out.push('  while ($true) {');
  out.push('    try { return (& $pAction) }');
  out.push('    catch {');
  out.push('      $pHr = Get-PHResult $_');
  out.push("      if (($pHr -eq '0x80010001' -or $pHr -eq '0x8001010A') -and $script:pRetryLeft -gt 0) {");
  out.push('        $script:pRetryLeft = $script:pRetryLeft - 1');
  out.push('        Start-Sleep -Milliseconds 500');
  out.push('        continue');
  out.push('      }');
  out.push('      throw');
  out.push('    }');
  out.push('  }');
  out.push('}');
  out.push('');
  out.push('try {');
  out.push('  $pApp = New-Object -ComObject PowerPoint.Application');
  if (opts.activate !== false) {
    out.push('  try {');
    out.push('    $pApp.Visible = -1   # msoTrue');
    out.push('    $pApp.Activate()');
    out.push('  } catch { }');
  }
  out.push('  $pPres = $pApp.Presentations.Add(-1)   # msoTrue：带窗口');
  // Scene 的 0.5 scale 出来就是 960×540 pt，跟 mac 上的默认页面尺寸对齐
  out.push('  Invoke-PCom { $pPres.PageSetup.SlideWidth = 960 }');
  out.push('  Invoke-PCom { $pPres.PageSetup.SlideHeight = 540 }');
  out.push("  Write-PMark '@@PHASE ready'");
  out.push('');

  pages.forEach((page, k) => {
    const n = k + 1;
    const offset = offsets[k];
    out.push(`  # ===== 第 ${n} 页${page.title ? `：${comment(page.title)}` : ''} =====`);
    out.push(`  Write-PMark '@@SLIDE ${n} start'`);
    out.push(`  $pSld = $pPres.Slides.Add(${n}, 12)   # ppLayoutBlank`);
    const bg = rgbInt(page.background);
    if (bg) {
      // 底色能设就设，设不了只记一笔，不让整次绘制失败
      out.push('  try {');
      out.push('    $pSld.FollowMasterBackground = 0   # msoFalse');
      out.push(`    $pSld.Background.Fill.ForeColor.RGB = ${bg}`);
      out.push("  } catch { Write-PMark ('@@BG fail ' + (Get-PHResult $_) + ' ' + (Get-PWhy $_)) }");
    }
    out.push('');

    for (const step of page.steps) {
      const gi = offset + Number(step.i);
      out.push(`  # [${gi}/${total}] ${comment(step.kind)} ${comment(step.id)}`.trimEnd());
      out.push('  $pRetryLeft = 3');
      out.push(`  Write-PMark '@@STEP ${gi} start'`);
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
      out.push(`  Write-PMark '@@STEP ${gi} done'`);
      if (delayMs > 0) out.push(`  Start-Sleep -Milliseconds ${delayMs}`);
      out.push('');
    }

    out.push("  Write-PMark ('@@SHAPES ' + $pSld.Shapes.Count)");
    out.push('');
  });

  if (opts.outPath) {
    out.push("  Write-PMark '@@PHASE saving'");
    out.push(`  $pOutDir = Split-Path -Parent ${psStr(opts.outPath)}`);
    out.push('  if ($pOutDir) { $null = New-Item -ItemType Directory -Force -Path $pOutDir }');
    out.push(`  Invoke-PCom { $pPres.SaveAs(${psStr(opts.outPath)}, 24) }   # ppSaveAsOpenXMLPresentation`);
    // 画完不 Quit：PowerPoint 留着给人看（与 mac 一致）
    out.push(`  Write-PMark ('@@PHASE done ' + ${psStr(opts.outPath)})`);
  } else {
    out.push("  Write-PMark '@@PHASE done '");
  }
  out.push('} catch {');
  out.push("  Write-PMark ('@@ERROR ' + (Get-PHResult $_) + ' ' + (Get-PWhy $_))");
  out.push('  exit 1');
  out.push('}');
  out.push('');
  return out.join('\n');
}

/** 单页包装。与 mac 的 stepsToAppleScript 同位。 */
export function stepsToPowerShell(steps, options) {
  const opts = options || {};
  return deckToPowerShell(
    [{ steps, background: opts.background, title: opts.slideTitle }],
    opts,
  );
}

/* ══ 6. 起 PowerShell ══════════════════════════════════════════════════════ */

/** Windows PowerShell 5.1 优先（Windows 自带），没有再退回 PowerShell 7 的 pwsh。 */
const PS_CANDIDATES = Object.freeze(['powershell.exe', 'pwsh']);

const PS_ARGS = (scriptPath) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath];

/**
 * 在 PATH 里找可执行文件。**不执行它** —— 拿 `spawnSync <cmd> -Command 'exit 0'` 探
 * 会真的起一次 PowerShell（慢，而且测试里塞的假 powershell.exe 会被白跑一遍）。
 */
function findExecutable(name) {
  const sep = process.platform === 'win32' ? ';' : ':';
  const dirs = String(process.env.PATH || '').split(sep);
  const exts = process.platform === 'win32'
    ? String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')
    : [''];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const hasExt = ext && name.toLowerCase().endsWith(ext.toLowerCase());
      const candidate = join(dir, hasExt ? name : name + ext);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch { /* 下一个 */ }
    }
  }
  return null;
}

/** @returns {{ name: string, path: string }|null} */
function resolvePowerShell() {
  for (const name of PS_CANDIDATES) {
    const found = findExecutable(name);
    if (found) return { name, path: found };
  }
  return null;
}

const PS_MISSING_DETAIL = `PATH 里既没有 powershell.exe 也没有 pwsh。`
  + '这个驱动器要靠 Windows PowerShell 5.1（系统自带）或 PowerShell 7 才能驱动 PowerPoint COM。';

/** 把脚本写成 UTF-8 **带 BOM** 的临时 .ps1（差异 5：5.1 不带 BOM 会把中文读坏）。 */
function writeScript(prefix, text) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const path = join(dir, 'draw.ps1');
  writeFileSync(path, `﻿${text}`, 'utf8');
  return { dir, path };
}

/* ══ 7. 预检 ═══════════════════════════════════════════════════════════════ */

const PROBE_TIMEOUT_MS = 25000;

const PROBE_SCRIPT = [
  '# 由 project/drivers/win-powerpoint.mjs 生成的预检脚本，不要手改',
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  "$ErrorActionPreference = 'Stop'",
  'try {',
  '  $pApp = New-Object -ComObject PowerPoint.Application',
  '  [Console]::Out.WriteLine($pApp.Version)',
  '  [Console]::Out.Flush()',
  '} catch {',
  '  $pHr = 0',
  '  try {',
  '    $pEx = $_.Exception',
  '    while ($null -ne $pEx) {',
  '      if ($pEx -is [System.Runtime.InteropServices.COMException]) { $pHr = $pEx.HResult; break }',
  '      $pEx = $pEx.InnerException',
  '    }',
  '    if ($pHr -eq 0) { $pHr = $_.Exception.HResult }',
  '  } catch { $pHr = 0 }',
  "  [Console]::Out.WriteLine(('@@ERROR 0x{0:X8} ' -f [int]$pHr) + (([string]$_.Exception.Message) -replace '[\\r\\n]+', ' '))",
  '  [Console]::Out.Flush()',
  '  exit 1',
  '}',
  '',
].join('\n');

/**
 * 真画之前先探一下 PowerPoint COM 通得通不通。**不抛异常**，结果自带判定。
 *
 * 跟 mac 的预检同位（run.mjs 的 phase:auth 那一步），但语义不同：mac 那一步是
 * 「触发并等待授权框」，Windows 上没有授权框，这一步纯粹是「PowerPoint 起得来吗、
 * 它现在应答吗」—— 顺带把 PowerPoint 冷启动那十几秒挪到面板有话说的阶段。
 *
 * @param {{ probeCmd?: string }} [options] probeCmd 仅测试用：给了就改跑 `/bin/sh -c <它>`
 * @returns {Promise<{ ok: boolean, code?: string, detail: string }>}
 */
export function probePowerPoint(options) {
  const opts = options || {};
  return new Promise((done) => {
    let child;
    let tmp = null;
    const cleanup = () => {
      if (!tmp) return;
      try { rmSync(tmp.dir, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
      tmp = null;
    };
    try {
      if (opts.probeCmd) {
        child = spawn('/bin/sh', ['-c', opts.probeCmd], { stdio: ['ignore', 'pipe', 'pipe'] });
      } else {
        const shell = resolvePowerShell();
        // 「找不到 PowerShell」跟「PowerPoint 不应答」是两件事，code 必须分得开：
        // 认不出来的话调用方只能套 busy 判词，把人送去 PowerPoint 里找一个不存在的对话框
        if (!shell) { done({ ok: false, code: WIN_NO_POWERSHELL_CODE, detail: PS_MISSING_DETAIL }); return; }
        tmp = writeScript('doubao-probe-win-', PROBE_SCRIPT);
        child = spawn(shell.path, PS_ARGS(tmp.path), {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
      }
    } catch (error) {
      cleanup();
      done({ ok: false, code: '无响应', detail: `探针起不来：${error.message}` });
      return;
    }

    let out = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* 已经走了 */ }
    }, PROBE_TIMEOUT_MS);
    const grab = (chunk) => { if (out.length < 4000) out += chunk; };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', grab);
    child.stderr.on('data', grab);
    child.on('error', (error) => {
      clearTimeout(timer);
      cleanup();
      done({ ok: false, code: '无响应', detail: `探针起不来：${error.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      cleanup();
      const detail = out.trim();
      if (!timedOut && code === 0) { done({ ok: true, detail }); return; }
      done({
        ok: false,
        code: classifyFailure(detail).code || (timedOut ? '超时' : '无响应'),
        detail: timedOut
          ? `探针等了 ${PROBE_TIMEOUT_MS / 1000} 秒还没回来，已强制结束${detail ? `：${detail}` : ''}`
          : `探针退出码 ${code}${detail ? `：${detail}` : ''}`,
      });
    });
  });
}

/* ══ 8. 跑 ════════════════════════════════════════════════════════════════ */

/**
 * 生成脚本 → 跑 powershell.exe → 逐行把标记翻译成事件。
 *
 * 事件形状见 shells/doubao/runner/panel/CONTRACT.md。多页时额外多一个
 * `{ type:'phase', phase:'slide', slide, slides, title }`，`step` 事件上多 `slide` / `slides`。
 *
 * @param {Array<{steps: Array, background?: string, title?: string}>} slides
 * @param {object} options 同 deckToPowerShell，另加 keepScript（留下临时脚本便于排错）
 * @param {(event: object) => void} [onEvent]
 * @returns {Promise<{file: string|null, shapes: number|null, elapsedMs: number,
 *                    animation: boolean, script: string, slides: number}>}
 */
export function runDrawDeck(slides, options, onEvent) {
  const opts = options || {};
  const pages = normalizeSlides(slides, opts);
  const { total, byGlobal } = deckIndex(pages);
  const slideCount = pages.length;
  const script = deckToPowerShell(pages, opts);

  const emit = (e) => { if (typeof onEvent === 'function') onEvent(e); };
  const tail = [];
  const pushTail = (line) => { tail.push(line); if (tail.length > 200) tail.shift(); };

  return new Promise((resolve, reject) => {
    const shell = resolvePowerShell();
    if (!shell) {
      // 与预检那一支同一件事（本机连壳都没有），所以给同一句判词 + 一个认得出来的标记 ——
      // run.mjs 靠 powerShellMissing 走退出码 6，不然它只会套「画的时候出错了：」的通用前缀
      const error = new Error(powerShellMissingMessage());
      error.powerShellMissing = true;
      error.detail = PS_MISSING_DETAIL;
      reject(error);
      return;
    }
    const tmp = writeScript('doubao-draw-win-', script);
    const started = Date.now();
    const startedAt = new Map();
    let animation = opts.animate !== false;
    let shapes = null;
    let file = null;
    let currentSlide = 1;
    // 「画到哪儿了」。busy 码的判词分两段全靠这两个开关。
    let drewAny = false;
    let sawSaving = false;

    let child;
    try {
      child = spawn(shell.path, PS_ARGS(tmp.path), {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      rmSync(tmp.dir, { recursive: true, force: true });
      const err = new Error(`起不来 PowerShell（${shell.name}）：${error.message}`);
      err.detail = PS_MISSING_DETAIL;
      reject(err);
      return;
    }

    const handle = (line) => {
      if (!line) return;
      pushTail(line);
      let m = line.match(/@@SLIDE\s+(\d+)\s+start/);
      if (m) {
        currentSlide = Number(m[1]);
        // 单页时不发 —— 面板上多一条「第 1 / 1 页」纯属噪音
        if (slideCount >= 2) {
          emit({
            type: 'phase',
            phase: 'slide',
            slide: currentSlide,
            slides: slideCount,
            title: (pages[currentSlide - 1] && pages[currentSlide - 1].title) || null,
          });
        }
        return;
      }
      m = line.match(/@@STEP\s+(\d+)\s+(start|done)/);
      if (m) {
        const i = Number(m[1]);
        const found = byGlobal.get(i) || {};
        const step = found.step || {};
        const slide = found.slide || currentSlide;
        const base = {
          type: 'step',
          i,
          total,
          kind: step.kind,
          id: step.id,
          label: step.label,
          slide,
          slides: slideCount,
        };
        if (m[2] === 'start') {
          startedAt.set(i, Date.now());
          emit({ ...base, status: 'start' });
        } else {
          drewAny = true;
          const t0 = startedAt.get(i);
          emit({ ...base, status: 'done', ms: t0 ? Date.now() - t0 : 0 });
        }
        return;
      }
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
      if (line.indexOf('@@PHASE ready') >= 0) {
        emit({ type: 'log', level: 'info', message: 'PowerPoint 已就绪，演示文稿已新建（960×540pt）' });
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
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', reader());
    child.stderr.on('data', reader());

    let settled = false;
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (!opts.keepScript) rmSync(tmp.dir, { recursive: true, force: true });
      const error = new Error(`${shell.name} 起不来：${err.message}`);
      error.detail = PS_MISSING_DETAIL;
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      const kept = opts.keepScript ? tmp.path : null;
      if (!opts.keepScript) rmSync(tmp.dir, { recursive: true, force: true });
      if (code !== 0) {
        const last = tail.slice(-20).join('\n');
        const raw = `${shell.name} 退出码 ${code}\n最后 20 行输出：\n${last}`;
        const { kind, code: hres } = classifyFailure(last);
        if (kind === 'missing') {
          const error = new Error(powerPointMissingMessage(hres));
          error.missingCode = hres;
          error.detail = raw;
          reject(error);
          return;
        }
        if (kind === 'busy') {
          if (drewAny || sawSaving) {
            const stalledPhase = sawSaving ? 'saving' : 'drawing';
            const error = new Error(powerPointStalledMessage(hres, stalledPhase));
            error.stalledCode = hres;
            error.stalledPhase = stalledPhase;
            error.detail = raw;
            reject(error);
            return;
          }
          // 一步都没画 —— 字段名沿用 mac 的 authCode（run.mjs 靠它走退出码 3），
          // 但判词是 Windows 版：这儿没有授权框可点。
          const error = new Error(powerPointBusyMessage(hres));
          error.authCode = hres;
          error.detail = raw;
          reject(error);
          return;
        }
        if (kind === 'gone') {
          const error = new Error(powerPointGoneMessage(hres));
          error.goneCode = hres;
          error.detail = raw;
          reject(error);
          return;
        }
        const error = new Error(raw);
        error.detail = raw;
        reject(error);
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

/** 单页包装。与 mac 的 runDraw 同位、返回同一组字段（多一个 slides，恒为 1）。 */
export function runDraw(steps, options, onEvent) {
  const opts = options || {};
  return runDrawDeck(
    [{ steps, background: opts.background, title: opts.slideTitle }],
    opts,
    onEvent,
  );
}
