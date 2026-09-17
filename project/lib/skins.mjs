// 14 套皮肤 token —— 由 Claude Design「Dash-arch-ppt 皮肤设计」项目导出生成
// 数据源: Arch PPT Skins.dc.html (2026-08-04) —— 后 10 套（midnight … riso）
//        Arch Skin Stratum.dc.html (2026-08-06) —— 前 4 套主打皮肤
// 字段语义见 docs/skins-notes.md
import { splitColorAlpha } from './edge-weight.mjs';

export const DEFAULT_SKIN = 'stratum';

// 主打皮肤排在最前: 下拉列表按这个顺序直出, 其余 10 套折叠在「更多皮肤」后面。
// 分组名单见文件末尾的 FEATURED_SKIN_IDS / LEGACY_SKIN_IDS。
export const SKINS = {
  stratum: {
    nameZh: '分层', nameEn: 'Stratum', tone: 'light', usage: '技术博客 · 文档插图',
    gridOpacity: 0, decisionFill: '#FFFFFF', accentLabel: '#16389B', hairline: '#D8E1F0',
    // 四级明度台阶（页面底 → 一层容器 → 二层容器 → 节点卡）承担层次
    metrics: {
      iconSize: 40, iconSizeTop: 44, iconGapX: 16, iconGapTop: 8, labelSubGap: 6,
      cardPadX: 32, cardMinH: 68, typeNode: 25, typeSmall: 18,
      panelPadX: 26, panelPadTop: 64, gutterScale: 1.15,
      // 角落药丸: 14 上间距 + 32 带高 + 18 下间距 = 64
      panelLabelMode: 'chip', panelLabelH: 32, panelLabelPadX: 16,
      cardDepthShrink: 8,
    },
    extraCss: `
/* 1 · 图标位的变体着色（底色 / 圆角 / 字形占比走 tokens, 进导出） */
.node.v-accent .node-icon { background:#DCE7FC; color:#16389B; }
.node.v-store  .node-icon { background:#DDF1EC; color:#0E9F8A; }
.node.v-muted  .node-icon { background:#E7EBF2; color:#93A2BE; }

/* 2 · 连线标签：不透明白 chip 压在线上，解决重叠 */
.edge-label {
  background:#FFFFFF; border-color:#D8E1F0; border-radius:6px;
  box-shadow:0 1px 3px rgba(15,31,61,.08); color:#59698A;
}

/* 3 · 悬停：投影加深一档 */
.node { transition:box-shadow .16s ease, border-color .16s ease; }
.node:hover {
  border-color:#BFD0EC;
  box-shadow:0 1px 2px rgba(15,31,61,.06),0 12px 30px rgba(15,31,61,.12);
}

/* 4 · 虚线连线降透明 */
.edge.dashed { opacity:.7; }
`,
    tokens: {
      bg: '#F2F6FC',
      ink: '#0F1F3D',
      ink2: '#59698A',
      ink3: '#93A2BE',
      accent: '#2C5BE8',
      store: '#0E9F8A',
      nbg: '#FFFFFF',
      nbd: '1px solid #D8E1F0',
      nsh: '0 1px 2px rgba(15,31,61,.05),0 6px 18px rgba(15,31,61,.06)',
      nr: '12px',
      nw: '600',
      abg: '#EEF3FE',
      abd: '1.5px solid #2C5BE8',
      sbg: '#EAF7F4',
      sbd: '1.5px solid #0E9F8A',
      mbg: '#F1F4F9',
      mbd: '1px dashed #C3CEE0',
      pbg: '#E4ECF8',
      pbd: '1px solid #D3DFF2',
      pr: '18px',
      p2bg: '#F4F8FE',
      p2bd: '1px solid #CFDCF1',
      edge: '#9FB2D2',
      ew: '1.6',
      lbg: '#FFFFFF',
      lbd: '1px solid #D8E1F0',
      lr: '6px',
      iconChipBg: '#EDF2FB',
      iconChipR: '10px',
      iconGlyphRatio: 0.6,
      p2r: '16px',
      pLabelR: '8px',
      p2LabelR: '8px',
      pLabelBg: '#2C5BE8',
      pLabelInk: '#FFFFFF',
      pLabelBd: 'none',
      p2LabelBg: '#FFFFFF',
      p2LabelInk: '#16389B',
      p2LabelBd: '1px solid #B9CBF3',
      ff: '\'PingFang SC\',\'Microsoft YaHei\',system-ui,-apple-system,sans-serif',
      ftitle: 'inherit',
      ts: '54px',
      twt: '700',
      tls: '-.02em',
      rw: '0',
      kf: '600 16px/1 \'PingFang SC\',system-ui,sans-serif',
      kls: '.04em',
    },
  },
  handbook: {
    nameZh: '手账', nameEn: 'Handbook', tone: 'light', usage: '课程笔记 · 课设答辩',
    gridOpacity: 0, decisionFill: '#FFFFFF', accentLabel: '#B8401F', hairline: '#E4DCCE',
    // 暖米白 + 砖橙, 圆角 16–20, 投影更软; 组间距最松（chip 最大）
    metrics: {
      iconSize: 40, iconSizeTop: 44, iconGapX: 16, iconGapTop: 10, labelSubGap: 6,
      cardPadX: 30, cardMinH: 72, typeNode: 26, typeSmall: 18,
      panelPadX: 24, panelPadTop: 68, gutterScale: 1.2,
      // 通栏实色带, 居中: 44 带高 + 24 下间距 = 68
      panelLabelMode: 'bar-top', panelLabelH: 44, panelLabelPadX: 24, panelLabelAlign: 'center',
      cardDepthShrink: 8,
    },
    extraCss: `
/* 1 · 图标位的变体着色（底色 / 圆角 / 字形占比走 tokens, 进导出） */
.node.v-accent .node-icon { background:#F9D9CE; color:#B8401F; }
.node.v-store  .node-icon { background:#DCEBE6; color:#3F8F7A; }
.node.v-muted  .node-icon { background:#E8E2D6; color:#A79C8E; }

/* 2 · 连线标签：不透明暖白 chip */
.edge-label {
  background:#FFFFFF; border-color:#E0D6C6; border-radius:8px;
  box-shadow:0 1px 3px rgba(42,38,34,.07); color:#6B6156;
}

/* 3 · 纸纹：极淡斜向条纹，只加在容器上 */
.panel::after {
  content:''; position:absolute; inset:0; pointer-events:none;
  border-radius:20px; opacity:.5;
  background:repeating-linear-gradient(135deg,
    rgba(255,255,255,.55) 0 2px, transparent 2px 7px);
}

/* 4 · accent 卡右上角折角 */
.node.v-accent::after {
  content:''; position:absolute; right:-1px; top:-1px;
  width:22px; height:22px; border-radius:0 16px 0 0;
  background:linear-gradient(225deg,#E8613C 50%, transparent 50%);
}

/* 5 · 悬停：投影加深，像纸被抬起来 */
.node { transition:box-shadow .18s ease, border-color .18s ease; }
.node:hover {
  border-color:#D8C9B2;
  box-shadow:0 2px 4px rgba(42,38,34,.06),
             0 14px 32px rgba(42,38,34,.12);
}

/* 6 · 虚线连线降透明 */
.edge.dashed { opacity:.7; }
`,
    tokens: {
      bg: '#F7F4EE',
      ink: '#2A2622',
      ink2: '#6B6156',
      ink3: '#A79C8E',
      accent: '#E8613C',
      store: '#3F8F7A',
      nbg: '#FFFFFF',
      nbd: '1px solid #E4DCCE',
      nsh: '0 1px 2px rgba(42,38,34,.04),0 8px 20px rgba(42,38,34,.06)',
      nr: '16px',
      nw: '700',
      abg: '#FDEEE9',
      abd: '1.5px solid #E8613C',
      sbg: '#E9F3F0',
      sbd: '1.5px solid #3F8F7A',
      mbg: '#F1EDE5',
      mbd: '1px dashed #CFC4B2',
      pbg: '#EFE9DE',
      pbd: '1px solid #E0D6C6',
      pr: '20px',
      p2bg: '#FBF8F3',
      p2bd: '1px solid #E4DCCE',
      edge: '#B6A995',
      ew: '1.8',
      lbg: '#FFFFFF',
      lbd: '1px solid #E0D6C6',
      lr: '8px',
      iconChipBg: '#F5EEE2',
      iconChipR: '14px',
      iconGlyphRatio: 0.6,
      p2r: '16px',
      pLabelR: '9px',
      p2LabelR: '9px',
      pLabelBg: '#E8613C',
      pLabelInk: '#FFFFFF',
      pLabelBd: 'none',
      p2LabelBg: '#FBF0EB',
      p2LabelInk: '#B8401F',
      p2LabelBd: 'none',
      ff: '\'PingFang SC\',\'Microsoft YaHei\',system-ui,sans-serif',
      ftitle: 'inherit',
      ts: '52px',
      twt: '800',
      tls: '-.01em',
      rw: '0',
      kf: '600 16px/1 \'PingFang SC\',system-ui,sans-serif',
      kls: '.08em',
    },
  },
  journal: {
    nameZh: '学报', nameEn: 'Journal', tone: 'light', usage: '论文配图 · 技术白皮书',
    gridOpacity: 0, decisionFill: '#FFFFFF', accentLabel: '#1B3A6B', hairline: '#DDE1E7',
    // 近白底、单一靛蓝、发丝描边、零投影; 唯一 gutterScale < 1 的一套
    metrics: {
      iconSize: 32, iconSizeTop: 36, iconGapX: 12, iconGapTop: 8, labelSubGap: 4,
      cardPadX: 24, cardMinH: 62, typeNode: 23, typeSmall: 17,
      panelPadX: 24, panelPadTop: 24, gutterScale: 0.95,
      // 竖排标题贴在容器左侧: 列宽 40（5 个汉字竖排占 40px 而非 110px）,
      // 左内边距 60 给它腾位置, 顶部内边距因此回落到下限档 24
      panelLabelMode: 'side', panelLabelW: 40, panelPadLeft: 60, panelLabelPadX: 14,
      panelLabelInset: 10,
      cardDepthShrink: 6,
    },
    extraCss: `
/* 1 · 图标位的变体着色（底色 / 圆角 / 字形占比走 tokens, 进导出） */
.node.v-store .node-icon { background:#E4EDEA; color:#46605C; }
.node.v-muted .node-icon { background:#EBEDF1; color:#8B929C; }

/* 2 · 连线标签：白底发丝描边，近直角 */
.edge-label {
  background:#FFFFFF; border-color:#D7DBE1; border-radius:2px;
  box-shadow:none; color:#4C525C;
}

/* 3 · 零投影是这套的立场，悬停也只改描边色 */
.node { box-shadow:none; transition:border-color .14s ease; }
.node:hover { border-color:#9FB0CC; }

/* 4 · 容器左上角一个 10px 实心方块，模拟图版编号位 */
.panel::before {
  content:''; position:absolute; left:-1px; top:-1px;
  width:10px; height:10px; background:#1B3A6B;
}
.panel.depth-1::before { background:#B9C6DC; }

/* 5 · 虚线连线在学术图里代表「非主链路」，压到 .6 */
.edge.dashed { opacity:.6; }
`,
    tokens: {
      bg: '#FCFCFA',
      ink: '#14161A',
      ink2: '#4C525C',
      ink3: '#8B929C',
      accent: '#1B3A6B',
      store: '#46605C',
      nbg: '#FFFFFF',
      nbd: '1px solid #D7DBE1',
      nsh: 'none',
      nr: '3px',
      nw: '600',
      abg: '#EEF1F6',
      abd: '1.5px solid #1B3A6B',
      sbg: '#EDF2F0',
      sbd: '1.5px solid #46605C',
      mbg: '#F5F6F8',
      mbd: '1px dashed #C6CBD3',
      pbg: '#F4F6F8',
      pbd: '1px solid #DDE1E7',
      pr: '4px',
      p2bg: '#FFFFFF',
      p2bd: '1px solid #D7DBE1',
      edge: '#9AA1AC',
      ew: '1.4',
      lbg: '#FFFFFF',
      lbd: '1px solid #D7DBE1',
      lr: '2px',
      iconChipBg: '#EEF1F6',
      iconChipR: '3px',
      iconGlyphRatio: 0.62,
      p2r: '3px',
      pLabelR: '2px',
      p2LabelR: '2px',
      pLabelBg: '#1B3A6B',
      pLabelInk: '#FFFFFF',
      pLabelBd: 'none',
      p2LabelBg: '#EEF1F6',
      p2LabelInk: '#1B3A6B',
      p2LabelBd: '1px solid #B9C6DC',
      ff: '\'PingFang SC\',\'Source Han Sans SC\',\'Microsoft YaHei\',system-ui,sans-serif',
      ftitle: '\'Songti SC\',\'Source Han Serif SC\',\'SimSun\',Georgia,serif',
      ts: '46px',
      twt: '600',
      tls: '0',
      rw: '0',
      kf: '600 16px/1 \'PingFang SC\',system-ui,sans-serif',
      kls: '.18em',
    },
  },
  source: {
    nameZh: '源码', nameEn: 'Source', tone: 'light', usage: 'README 配图 · 设计评审',
    gridOpacity: 0, decisionFill: '#FFFFFF', accentLabel: '#1B4EA8', hairline: '#D0D7DE',
    // 浅色 IDE 主题: 冷灰底、等宽字、6–8px 圆角、只有 1px 实边
    metrics: {
      iconSize: 30, iconSizeTop: 32, iconGapX: 12, iconGapTop: 8, labelSubGap: 5,
      cardPadX: 22, cardMinH: 60, typeNode: 23, typeSmall: 16,
      panelPadX: 20, panelPadTop: 62, gutterScale: 1.05,
      // 通栏浅底带, 左对齐: 40 带高 + 22 下间距 = 62
      panelLabelMode: 'bar-top', panelLabelH: 40, panelLabelPadX: 22, panelLabelAlign: 'left',
      cardDepthShrink: 6,
    },
    extraCss: `
/* 1 · 图标位的变体着色（底色 / 圆角 / 字形占比走 tokens, 进导出） */
.node.v-accent .node-icon { background:#D6E5FC; color:#1B4EA8; }
.node.v-store  .node-icon { background:#DCEFE5; color:#1F8A5F; }
.node.v-muted  .node-icon { background:#E7EAEE; color:#8C959F; }

/* 2 · 分组带左端的色块锚点，像文件树的分组头 */
.panel-label::before {
  content:''; position:absolute; left:8px; top:50%; margin-top:-4px;
  width:8px; height:8px; border-radius:2px; background:#2F6FE4;
}
.panel.depth-1 .panel-label::before { background:#8C959F; }

/* 3 · 连线标签：等宽小字 chip，4px 圆角 */
.edge-label {
  background:#FFFFFF; border-color:#D0D7DE; border-radius:4px;
  box-shadow:none; color:#57606A;
}

/* 4 · 悬停：蓝色 focus ring，不用软投影 */
.node { transition:border-color .12s ease, box-shadow .12s ease; }
.node:hover {
  border-color:#2F6FE4;
  box-shadow:0 0 0 3px rgba(47,111,228,.12);
}

/* 5 · store 变体左侧 3px 色条，像 diff 的增行标记 */
.node.v-store::before {
  content:''; position:absolute; left:0; top:8px; bottom:8px;
  width:3px; background:#1F8A5F; border-radius:0 3px 3px 0;
}

/* 6 · 虚线连线降透明 */
.edge.dashed { opacity:.7; }
`,
    tokens: {
      bg: '#F6F7F9',
      ink: '#1B1F24',
      ink2: '#57606A',
      ink3: '#8C959F',
      accent: '#2F6FE4',
      store: '#1F8A5F',
      nbg: '#FFFFFF',
      nbd: '1px solid #D0D7DE',
      nsh: '0 1px 0 rgba(27,31,36,.04)',
      nr: '6px',
      nw: '600',
      abg: '#EAF2FE',
      abd: '1.5px solid #2F6FE4',
      sbg: '#E7F5EE',
      sbd: '1.5px solid #1F8A5F',
      mbg: '#F0F2F5',
      mbd: '1px dashed #C4CCD5',
      pbg: '#ECEFF3',
      pbd: '1px solid #D8DEE5',
      pr: '8px',
      p2bg: '#FFFFFF',
      p2bd: '1px solid #D0D7DE',
      edge: '#A8B1BC',
      ew: '1.4',
      lbg: '#FFFFFF',
      lbd: '1px solid #D0D7DE',
      lr: '4px',
      iconChipBg: '#EDF1F6',
      iconChipR: '5px',
      iconGlyphRatio: 0.62,
      p2r: '6px',
      pLabelR: '2px',
      p2LabelR: '2px',
      pLabelBg: '#E3E8EF',
      pLabelInk: '#1B1F24',
      pLabelBd: 'none',
      p2LabelBg: '#F3F5F8',
      p2LabelInk: '#1B1F24',
      p2LabelBd: 'none',
      ff: 'ui-monospace,\'SF Mono\',Menlo,Consolas,\'PingFang SC\',\'Microsoft YaHei\',monospace',
      ftitle: 'inherit',
      ts: '44px',
      twt: '700',
      tls: '-.01em',
      rw: '4px',
      kf: '600 15px/1 ui-monospace,Menlo,monospace',
      kls: '.04em',
    },
  },
  midnight: {
    nameZh: '深空', nameEn: 'Midnight', tone: 'dark', usage: '投屏演示 · 技术博客',
    gridOpacity: 0.22, decisionFill: '#1c2230', accentLabel: '#d9f1ff', hairline: 'rgba(255,255,255,.15)',
    metrics: {},   // 结构 token 覆盖, 留空取 METRICS_DEFAULTS; 可用键见 METRICS_SPEC
    extraCss: '',   // 第二层自由 CSS: 只影响观感, 自动限定在 #stage 内并拦截几何属性
    tokens: {
      bg: '#080b12',
      ink: '#f2f6fc',
      ink2: '#a3adc0',
      ink3: '#69748a',
      accent: '#56c8fa',
      store: '#7ee0b8',
      nbg: 'linear-gradient(180deg,rgba(255,255,255,.075),rgba(255,255,255,.025))',
      nbd: '1px solid rgba(255,255,255,.15)',
      nsh: '0 10px 28px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.07)',
      nr: '14px',
      nw: '650',
      abg: 'linear-gradient(180deg,rgba(86,200,250,.16),rgba(86,200,250,.05))',
      abd: '1px solid rgba(86,200,250,.5)',
      sbg: 'linear-gradient(180deg,rgba(126,224,184,.12),rgba(126,224,184,.04))',
      sbd: '1px solid rgba(126,224,184,.38)',
      mbg: 'rgba(255,255,255,.03)',
      mbd: '1px solid rgba(255,255,255,.09)',
      pbg: 'rgba(255,255,255,.028)',
      pbd: '1px solid rgba(255,255,255,.085)',
      pr: '18px',
      p2bg: 'rgba(255,255,255,.022)',
      p2bd: '1px solid rgba(255,255,255,.06)',
      edge: 'rgba(190,205,225,.72)',
      ew: '2',
      lbg: '#101521',
      lbd: '1px solid rgba(255,255,255,.1)',
      lr: '99px',
      ff: '-apple-system,\'SF Pro Text\',\'PingFang SC\',\'Noto Sans SC\',sans-serif',
      ftitle: 'inherit',
      ts: '56px',
      twt: '680',
      tls: '-.01em',
      rw: '4px',
      kf: '600 20px/1 \'SF Mono\',Menlo,Consolas,monospace',
      kls: '.28em',
    },
  },
  terminal: {
    nameZh: '终端', nameEn: 'Terminal', tone: 'dark', usage: '工程内审 · 极客风',
    gridOpacity: 0.15, decisionFill: '#0f1512', accentLabel: '#b8ffd2', hairline: 'rgba(255,255,255,.15)',
    metrics: {},   // 结构 token 覆盖, 留空取 METRICS_DEFAULTS; 可用键见 METRICS_SPEC
    extraCss: '',   // 第二层自由 CSS: 只影响观感, 自动限定在 #stage 内并拦截几何属性
    tokens: {
      bg: '#0a0e0c',
      ink: '#d9ffe6',
      ink2: '#7cae8e',
      ink3: '#4c6a57',
      accent: '#4ef08a',
      store: '#ffd166',
      nbg: 'rgba(78,240,138,.045)',
      nbd: '1px solid rgba(120,200,150,.34)',
      nsh: 'none',
      nr: '2px',
      nw: '500',
      abg: 'rgba(78,240,138,.12)',
      abd: '1px solid #4ef08a',
      sbg: 'rgba(255,209,102,.09)',
      sbd: '1px solid rgba(255,209,102,.45)',
      mbg: 'transparent',
      mbd: '1px dashed rgba(120,200,150,.28)',
      pbg: 'transparent',
      pbd: '1px dashed rgba(120,200,150,.3)',
      pr: '2px',
      p2bg: 'rgba(120,200,150,.035)',
      p2bd: '1px dashed rgba(120,200,150,.22)',
      edge: 'rgba(120,200,150,.6)',
      ew: '1.5',
      lbg: '#0a0e0c',
      lbd: '1px solid rgba(120,200,150,.34)',
      lr: '2px',
      ff: '\'SF Mono\',Menlo,Consolas,\'Noto Sans Mono CJK SC\',monospace',
      ftitle: 'inherit',
      ts: '56px',
      twt: '600',
      tls: '-.005em',
      rw: '2px',
      kf: '500 20px/1 \'SF Mono\',Menlo,Consolas,monospace',
      kls: '.34em',
    },
  },
  consulting: {
    nameZh: '商务', nameEn: 'Consulting', tone: 'light', usage: '客户提案 · 咨询报告',
    gridOpacity: 0, decisionFill: '#ffffff', accentLabel: '#101828', hairline: 'rgba(0,0,0,.14)',
    metrics: {},   // 结构 token 覆盖, 留空取 METRICS_DEFAULTS; 可用键见 METRICS_SPEC
    extraCss: '',   // 第二层自由 CSS: 只影响观感, 自动限定在 #stage 内并拦截几何属性
    tokens: {
      bg: '#ffffff',
      ink: '#101828',
      ink2: '#475467',
      ink3: '#98a2b3',
      accent: '#00539f',
      store: '#0e7a6b',
      nbg: '#ffffff',
      nbd: '1px solid #d0d5dd',
      nsh: '0 1px 2px rgba(16,24,40,.06)',
      nr: '2px',
      nw: '620',
      abg: '#eef5fc',
      abd: '1.5px solid #00539f',
      sbg: '#eff8f5',
      sbd: '1px solid #0e7a6b',
      mbg: '#f2f4f7',
      mbd: '1px solid #e4e9f0',
      pbg: '#f8fafc',
      pbd: '1px solid #e4e9f0',
      pr: '4px',
      p2bg: '#ffffff',
      p2bd: '1px solid #e9edf2',
      edge: '#667085',
      ew: '1.5',
      lbg: '#ffffff',
      lbd: '1px solid #d0d5dd',
      lr: '3px',
      ff: '-apple-system,\'SF Pro Text\',\'PingFang SC\',\'Noto Sans SC\',sans-serif',
      ftitle: 'inherit',
      ts: '56px',
      twt: '600',
      tls: '-.015em',
      rw: '4px',
      kf: '600 19px/1 -apple-system,\'PingFang SC\',sans-serif',
      kls: '.22em',
    },
  },
  academic: {
    nameZh: '论文', nameEn: 'Academic', tone: 'light', usage: '学术报告 · 白皮书',
    gridOpacity: 0, decisionFill: '#ffffff', accentLabel: '#111111', hairline: 'rgba(0,0,0,.14)',
    metrics: {},   // 结构 token 覆盖, 留空取 METRICS_DEFAULTS; 可用键见 METRICS_SPEC
    extraCss: '',   // 第二层自由 CSS: 只影响观感, 自动限定在 #stage 内并拦截几何属性
    tokens: {
      bg: '#ffffff',
      ink: '#111111',
      ink2: '#4a4a4a',
      ink3: '#7d7d7d',
      accent: '#111111',
      store: '#111111',
      nbg: '#ffffff',
      nbd: '1px solid #111111',
      nsh: 'none',
      nr: '0px',
      nw: '600',
      abg: '#ececec',
      abd: '2px solid #111111',
      sbg: '#ffffff',
      sbd: '1px dashed #111111',
      mbg: '#f5f5f5',
      mbd: '1px solid #b9b9b9',
      pbg: '#ffffff',
      pbd: '1px solid #8f8f8f',
      pr: '0px',
      p2bg: '#fafafa',
      p2bd: '1px solid #b9b9b9',
      edge: '#222222',
      ew: '1.4',
      lbg: '#ffffff',
      lbd: '1px solid #c9c9c9',
      lr: '0px',
      ff: '\'Songti SC\',Georgia,\'Times New Roman\',serif',
      ftitle: 'Georgia,\'Songti SC\',serif',
      ts: '56px',
      twt: '600',
      tls: '0',
      rw: '2px',
      kf: '600 19px/1 Georgia,\'Songti SC\',serif',
      kls: '.2em',
    },
  },
  paper: {
    nameZh: '宣纸', nameEn: 'Paper', tone: 'light', usage: '培训讲义 · 温和场合',
    gridOpacity: 0, decisionFill: '#fffdf8', accentLabel: '#241f1a', hairline: 'rgba(0,0,0,.14)',
    metrics: {},   // 结构 token 覆盖, 留空取 METRICS_DEFAULTS; 可用键见 METRICS_SPEC
    extraCss: '',   // 第二层自由 CSS: 只影响观感, 自动限定在 #stage 内并拦截几何属性
    tokens: {
      bg: '#f6f1e7',
      ink: '#241f1a',
      ink2: '#6b6055',
      ink3: '#9b8f80',
      accent: '#b23a2c',
      store: '#7a6a3f',
      nbg: '#fffdf8',
      nbd: '1px solid #d8cdb8',
      nsh: '0 1.5px 0 #e6dcc9',
      nr: '8px',
      nw: '650',
      abg: '#fdf1ee',
      abd: '1.5px solid #b23a2c',
      sbg: '#faf6ea',
      sbd: '1px solid #b9a97e',
      mbg: '#f0ebdf',
      mbd: '1px solid #ddd2bd',
      pbg: 'rgba(255,253,248,.55)',
      pbd: '1px solid #ddd2bd',
      pr: '12px',
      p2bg: 'rgba(255,253,248,.75)',
      p2bd: '1px solid #e4dbc9',
      edge: '#8a7d6b',
      ew: '1.6',
      lbg: '#f6f1e7',
      lbd: '1px solid #ddd2bd',
      lr: '99px',
      ff: '-apple-system,\'PingFang SC\',\'Noto Sans SC\',sans-serif',
      ftitle: '\'Songti SC\',Georgia,serif',
      ts: '58px',
      twt: '600',
      tls: '.01em',
      rw: '3px',
      kf: '600 19px/1 \'Songti SC\',Georgia,serif',
      kls: '.26em',
    },
  },
  editorial: {
    nameZh: '杂志', nameEn: 'Editorial', tone: 'light', usage: '发布会 · 品牌宣传',
    gridOpacity: 0, decisionFill: '#ffffff', accentLabel: '#0a0a0a', hairline: 'rgba(0,0,0,.14)',
    metrics: {},   // 结构 token 覆盖, 留空取 METRICS_DEFAULTS; 可用键见 METRICS_SPEC
    extraCss: '',   // 第二层自由 CSS: 只影响观感, 自动限定在 #stage 内并拦截几何属性
    tokens: {
      bg: '#f2f0eb',
      ink: '#0a0a0a',
      ink2: '#55524c',
      ink3: '#8d8983',
      accent: '#e2482d',
      store: '#1f3fbf',
      nbg: '#ffffff',
      nbd: '1.5px solid #0a0a0a',
      nsh: 'none',
      nr: '0px',
      nw: '700',
      abg: '#ffffff',
      abd: '1.5px solid #e2482d',
      sbg: '#ffffff',
      sbd: '1.5px solid #1f3fbf',
      mbg: '#e6e4de',
      mbd: '1.5px solid rgba(10,10,10,.3)',
      pbg: 'transparent',
      pbd: '1.5px solid rgba(10,10,10,.26)',
      pr: '0px',
      p2bg: 'rgba(10,10,10,.035)',
      p2bd: '1.5px solid rgba(10,10,10,.16)',
      edge: '#0a0a0a',
      ew: '2',
      lbg: '#f2f0eb',
      lbd: '1.5px solid #0a0a0a',
      lr: '0px',
      ff: '-apple-system,\'PingFang SC\',\'Noto Sans SC\',sans-serif',
      ftitle: '\'Times New Roman\',\'Songti SC\',serif',
      ts: '64px',
      twt: '700',
      tls: '-.03em',
      rw: '6px',
      kf: '700 19px/1 -apple-system,\'PingFang SC\',sans-serif',
      kls: '.3em',
    },
  },
  blueprint: {
    nameZh: '蓝图', nameEn: 'Blueprint', tone: 'light', usage: '方案评审 · 工程图纸感',
    gridOpacity: 0, decisionFill: '#ffffff', accentLabel: '#103a5c', hairline: 'rgba(0,0,0,.14)',
    metrics: {},   // 结构 token 覆盖, 留空取 METRICS_DEFAULTS; 可用键见 METRICS_SPEC
    extraCss: '',   // 第二层自由 CSS: 只影响观感, 自动限定在 #stage 内并拦截几何属性
    tokens: {
      bg: '#eaf1f8',
      ink: '#103a5c',
      ink2: '#3d6b8f',
      ink3: '#7fa0bb',
      accent: '#1f6feb',
      store: '#0d7f8f',
      nbg: 'rgba(255,255,255,.74)',
      nbd: '1px solid #9dbcd6',
      nsh: 'none',
      nr: '3px',
      nw: '620',
      abg: 'rgba(31,111,235,.1)',
      abd: '1.5px solid #1f6feb',
      sbg: 'rgba(13,127,143,.08)',
      sbd: '1px solid #0d7f8f',
      mbg: 'rgba(16,58,92,.05)',
      mbd: '1px dashed #9dbcd6',
      pbg: 'rgba(31,111,235,.045)',
      pbd: '1px dashed #8fb3d0',
      pr: '3px',
      p2bg: 'rgba(255,255,255,.4)',
      p2bd: '1px dashed #a8c4da',
      edge: '#4a7fa8',
      ew: '1.5',
      lbg: '#eaf1f8',
      lbd: '1px solid #9dbcd6',
      lr: '3px',
      ff: '-apple-system,\'PingFang SC\',\'Noto Sans SC\',sans-serif',
      ftitle: 'inherit',
      ts: '56px',
      twt: '640',
      tls: '-.01em',
      rw: '3px',
      kf: '600 19px/1 \'SF Mono\',Menlo,monospace',
      kls: '.3em',
    },
  },
  soft: {
    nameZh: '柔雾', nameEn: 'Soft', tone: 'light', usage: '产品介绍 · 轻松风格',
    gridOpacity: 0, decisionFill: '#ffffff', accentLabel: '#22252b', hairline: 'rgba(0,0,0,.14)',
    metrics: {},   // 结构 token 覆盖, 留空取 METRICS_DEFAULTS; 可用键见 METRICS_SPEC
    extraCss: '',   // 第二层自由 CSS: 只影响观感, 自动限定在 #stage 内并拦截几何属性
    tokens: {
      bg: '#fbfbfc',
      ink: '#22252b',
      ink2: '#62687a',
      ink3: '#9aa0b0',
      accent: '#6b6bf5',
      store: '#12a594',
      nbg: '#ffffff',
      nbd: '1px solid #ebecf2',
      nsh: '0 2px 8px rgba(20,24,40,.06)',
      nr: '16px',
      nw: '620',
      abg: '#f1f1ff',
      abd: '1px solid #cfcffb',
      sbg: '#eefaf7',
      sbd: '1px solid #bfe8e1',
      mbg: '#f5f6f9',
      mbd: '1px solid #ebecf2',
      pbg: '#f5f6f9',
      pbd: '1px solid #edeef3',
      pr: '22px',
      p2bg: '#ffffff',
      p2bd: '1px solid #edeef3',
      edge: '#b3b8c6',
      ew: '2',
      lbg: '#ffffff',
      lbd: '1px solid #ebecf2',
      lr: '99px',
      ff: '-apple-system,\'SF Pro Text\',\'PingFang SC\',\'Noto Sans SC\',sans-serif',
      ftitle: 'inherit',
      ts: '56px',
      twt: '640',
      tls: '-.02em',
      rw: '4px',
      kf: '600 19px/1 -apple-system,\'PingFang SC\',sans-serif',
      kls: '.2em',
    },
  },
  brutal: {
    nameZh: '粗野', nameEn: 'Brutalist', tone: 'light', usage: '实验方向 · 视觉冲击',
    gridOpacity: 0, decisionFill: '#ffffff', accentLabel: '#000000', hairline: 'rgba(0,0,0,.14)',
    metrics: {},   // 结构 token 覆盖, 留空取 METRICS_DEFAULTS; 可用键见 METRICS_SPEC
    extraCss: '',   // 第二层自由 CSS: 只影响观感, 自动限定在 #stage 内并拦截几何属性
    tokens: {
      bg: '#f3f1e7',
      ink: '#000000',
      ink2: '#3a3a36',
      ink3: '#767470',
      accent: '#ff4d1f',
      store: '#1552f0',
      nbg: '#ffffff',
      nbd: '3px solid #000000',
      nsh: '5px 5px 0 #000000',
      nr: '0px',
      nw: '800',
      abg: '#ff4d1f',
      abd: '3px solid #000000',
      sbg: '#c9dcff',
      sbd: '3px solid #000000',
      mbg: '#dcdad0',
      mbd: '3px solid #000000',
      pbg: '#ffe94a',
      pbd: '3px solid #000000',
      pr: '0px',
      p2bg: '#fff6c2',
      p2bd: '3px solid #000000',
      edge: '#000000',
      ew: '3',
      lbg: '#ffffff',
      lbd: '2.5px solid #000000',
      lr: '0px',
      ff: '\'Helvetica Neue\',Helvetica,Arial,\'PingFang SC\',sans-serif',
      ftitle: '\'Arial Black\',\'Helvetica Neue\',\'PingFang SC\',sans-serif',
      ts: '64px',
      twt: '900',
      tls: '-.035em',
      rw: '10px',
      kf: '800 19px/1 \'Helvetica Neue\',Arial,sans-serif',
      kls: '.24em',
    },
  },
  riso: {
    nameZh: '双色印刷', nameEn: 'Riso', tone: 'light', usage: '实验方向 · 印刷质感',
    gridOpacity: 0, decisionFill: '#fffdf6', accentLabel: '#1b2a6b', hairline: 'rgba(0,0,0,.14)',
    metrics: {},   // 结构 token 覆盖, 留空取 METRICS_DEFAULTS; 可用键见 METRICS_SPEC
    extraCss: '',   // 第二层自由 CSS: 只影响观感, 自动限定在 #stage 内并拦截几何属性
    tokens: {
      bg: '#f4f1ea',
      ink: '#1b2a6b',
      ink2: '#4a5aa0',
      ink3: '#8f97c0',
      accent: '#ff5c39',
      store: '#1b2a6b',
      nbg: '#fffdf6',
      nbd: '1.5px solid #1b2a6b',
      nsh: '3px 3px 0 rgba(255,92,57,.6)',
      nr: '4px',
      nw: '680',
      abg: '#ffe9e2',
      abd: '1.5px solid #ff5c39',
      sbg: '#e7eaf6',
      sbd: '1.5px solid #1b2a6b',
      mbg: '#eceadf',
      mbd: '1.5px dashed rgba(27,42,107,.45)',
      pbg: 'rgba(27,42,107,.05)',
      pbd: '1.5px solid rgba(27,42,107,.35)',
      pr: '4px',
      p2bg: 'rgba(255,92,57,.06)',
      p2bd: '1.5px solid rgba(255,92,57,.4)',
      edge: '#1b2a6b',
      ew: '2',
      lbg: '#fffdf6',
      lbd: '1.5px solid rgba(27,42,107,.4)',
      lr: '4px',
      ff: '-apple-system,\'PingFang SC\',\'Noto Sans SC\',sans-serif',
      ftitle: 'inherit',
      ts: '58px',
      twt: '700',
      tls: '-.02em',
      rw: '6px',
      kf: '600 19px/1 \'SF Mono\',Menlo,monospace',
      kls: '.3em',
    },
  },
};

// ============ 皮肤分组: 主打 / 折叠 ============
// 下拉列表默认只列主打这几套, 其余的收在「更多皮肤」按钮后面, 需要再点一次才展开。
// 两处 UI（generate.mjs 的产物工具条、editor/editor.js 的工作台）都读这一份, 不许各排各的。
export const FEATURED_SKIN_IDS = Object.freeze(['stratum', 'handbook', 'journal', 'source']);

export const LEGACY_SKIN_IDS = Object.freeze(Object.keys(SKINS).filter(function(id) {
  return FEATURED_SKIN_IDS.indexOf(id) < 0;
}));

// ============ 第一层: 结构 token（进入布局计算） ============
// 与上面 35 项装饰 token 的分界: 这里每一项都会被布局引擎读走, 改动直接影响卡片宽高、
// 容器包围盒、连线和质检口径; 装饰 token 只影响观感, 不参与任何几何计算。
// 皮肤在 metrics 字段里按需覆盖（留空即取 def）, 越界值会被钳制到 [min, max]。
export const METRICS_SPEC = Object.freeze({
  iconSize:    { def: 26, min: 14, max: 48,  css: '--icon-size',     desc: '左置图标位边长（有底色时即底板边长, 字形另由 iconGlyphRatio 决定）' },
  iconSizeTop: { def: 28, min: 14, max: 64,  css: '--icon-size-top', desc: '顶置图标位边长' },
  iconGapX:    { def: 10, min: 2,  max: 28,  css: '--icon-gap-x',    desc: '左置图标与文字的水平间距' },
  iconGapTop:  { def: 6,  min: 0,  max: 24,  css: '--icon-gap-top',  desc: '顶置图标与文字的垂直间距' },
  labelSubGap: { def: 5,  min: 0,  max: 20,  css: '--label-sub-gap', desc: '节点大标题与解释文字的间距' },
  cardPadX:    { def: 28, min: 10, max: 56,  css: '--card-pad-x',    desc: '节点卡片单侧水平内边距' },
  cardMinH:    { def: 60, min: 40, max: 140, css: null,              desc: '节点卡片最小高度（无副标题时即为实际高度）' },
  typeNode:    { def: 24, min: 14, max: 36,  css: '--type-node',     desc: '节点大标题字号' },
  typeSmall:   { def: 20, min: 12, max: 30,  css: '--type-small',    desc: '节点解释文字字号' },
  panelPadX:   { def: 20, min: 6,  max: 56,  css: '--panel-pad-x',   desc: '容器左右内边距' },
  panelPadTop: { def: 42, min: 18, max: 84,  css: '--panel-pad-top', desc: '容器顶部内边距（容纳容器标签）' },
  gutterScale: { def: 1,  min: 0.6, max: 1.8, css: null,             desc: '节点间距整体缩放系数', ratio: true },
  // ---- 编组标题构件（X1–X5 / E4）。mode 是总开关, 决定标题吃哪一侧的内边距、
  //      宽度取内容区还是外框、走线通道留在哪边。三种形态的几何都在 skinLayout 里推导。
  panelLabelMode: { def: 'chip', enum: ['chip', 'bar-top', 'side'], css: null,
    desc: '编组标题形态: chip 角落药丸 / bar-top 贯穿容器的通栏带 / side 竖排在容器左侧' },
  panelLabelH:    { def: 18, min: 12, max: 56, css: '--panel-label-h',     desc: '编组标题的带高（side 模式下为无关项）' },
  panelLabelPadX: { def: 0,  min: 0,  max: 40, css: '--panel-label-pad-x', desc: '编组标题内部左右内边距' },
  panelLabelW:    { def: 40, min: 20, max: 120, css: '--panel-label-w',    desc: 'side 模式下竖排标题的列宽' },
  panelLabelAlign: { def: 'left', enum: ['left', 'center'], css: null,
    desc: 'bar-top 模式下标题在带子里的对齐方式' },
  // side 模式下竖条与容器边的间距。设计稿里竖条是"内嵌在容器里的一枚圆角矩形"，
  // 高度等于容器高减去上下各这么多 —— 不是贴着容器边的一条通栏。
  panelLabelInset: { def: 0, min: 0, max: 24, css: '--panel-label-inset',
    desc: 'side 模式下竖排标题与容器边的间距' },
  panelPadLeft:   { def: 0,  min: 0,  max: 120, css: '--panel-pad-left',
    desc: '容器左内边距; 0 表示跟随 panelPadX。side 模式必须 ≥ panelLabelW + 20' },
  // 嵌套越深的卡片越矮: 顶层卡片取 cardMinH, 每深一层减这么多像素（0 表示各层等高）。
  // 深层容器本来就被外层的内边距挤薄, 各层强行等高会把内层挤得很拥挤。
  cardDepthShrink: { def: 0, min: 0, max: 24, css: null, desc: '每嵌套一层, 卡片高度递减的像素数' },
});

export const METRICS_KEYS = Object.freeze(Object.keys(METRICS_SPEC));

export const METRICS_DEFAULTS = Object.freeze(METRICS_KEYS.reduce(function(acc, k) {
  acc[k] = METRICS_SPEC[k].def;
  return acc;
}, {}));

// 皮肤 → 归一化后的结构 token。未声明取默认值, 非数值取默认值, 越界钳制; 三种情况都回调 onWarn。
// 带 enum 的项走枚举校验（不是数值, 不参与缩放, 不下发 CSS 变量）。
export function skinMetrics(skin, onWarn) {
  const raw = (skin && skin.metrics) || {};
  const warn = typeof onWarn === 'function' ? onWarn : function() {};
  const out = {};
  for (let i = 0; i < METRICS_KEYS.length; i++) {
    const k = METRICS_KEYS[i];
    const spec = METRICS_SPEC[k];
    const v = raw[k];
    if (v === undefined || v === null) { out[k] = spec.def; continue; }
    if (spec.enum) {
      if (spec.enum.indexOf(v) < 0) {
        warn('结构 token "' + k + '"=' + JSON.stringify(v) + ' 不是可选值之一（'
          + spec.enum.join('/') + '), 已回退默认值 ' + spec.def);
        out[k] = spec.def;
      } else {
        out[k] = v;
      }
      continue;
    }
    const n = Number(v);
    if (!isFinite(n)) {
      warn('结构 token "' + k + '" 不是数值(' + String(v) + '), 已回退默认值 ' + spec.def);
      out[k] = spec.def;
      continue;
    }
    if (n < spec.min || n > spec.max) {
      warn('结构 token "' + k + '"=' + n + ' 超出允许范围 [' + spec.min + ', ' + spec.max + '], 已钳制');
    }
    out[k] = Math.min(spec.max, Math.max(spec.min, n));
  }
  const extra = Object.keys(raw);
  for (let i = 0; i < extra.length; i++) {
    if (!METRICS_SPEC[extra[i]]) warn('未知结构 token "' + extra[i] + '", 已忽略（可用: ' + METRICS_KEYS.join('/') + '）');
  }
  // side 模式的左内边距必须容得下竖排标题, 否则标题会压住第一张卡（设计交接 X2 的校验式）
  if (out.panelLabelMode === 'side') {
    // 左内边距要装下: 竖条的左内缩 + 竖条宽 + 竖条到第一张卡的净空
    const need = out.panelLabelInset + out.panelLabelW + 10;
    const left = out.panelPadLeft || out.panelPadX;
    if (left < need) {
      warn('side 模式下 panelPadLeft(' + left + ') 必须 ≥ panelLabelInset + panelLabelW + 10 = ' + need + ', 已抬到下限');
      out.panelPadLeft = Math.min(METRICS_SPEC.panelPadLeft.max, need);
    }
  }
  return out;
}

// 由结构 token 推导的布局量 —— 构建期几何、运行时重排、质检、SVG 导出共用这一份口径。
// 任何一处再出现写死的 26/10/38/56/84 都视为回归。
export const LINE_H = 1.15;
// 解释文字的行高与大标题不同 —— 设计稿里主标题 1.15、解释文字 1.4。
// 两者用同一个值时, 有解释文字的卡片会比设计稿矮一档, 标题与正文也贴得过近。
export const LINE_H_SUB = 1.4;

export function skinLayout(metrics) {
  const m = metrics;
  const labelH = m.typeNode * LINE_H;
  const subH = m.typeSmall * LINE_H_SUB;
  // 卡片上下内边距由 cardMinH 反推: 无副标题时高度恰好等于 cardMinH
  const padY = Math.max(4, (m.cardMinH - labelH) / 2);
  // 左内边距: 0 表示跟随 panelPadX。side 模式靠它给竖排标题腾位置。
  const padLeft = m.panelPadLeft || m.panelPadX;
  return {
    labelH: labelH,
    subH: subH,
    padY: padY,
    iconLeftW: m.iconSize + m.iconGapX,          // 左置图标额外占用的水平空间
    iconTopH: m.iconSizeTop + m.iconGapTop,      // 顶置图标额外占用的垂直空间
    cardPadW: m.cardPadX * 2,                    // 卡片左右内边距合计
    panelPad: { x: m.panelPadX, left: padLeft, top: m.panelPadTop, bottom: Math.round(m.panelPadX * 0.8) },
    // 编组标题构件: 三种形态的几何都从这里读, 生成器 / 工作台 / SVG 导出同一份口径
    panelLabel: {
      mode: m.panelLabelMode,
      h: m.panelLabelH,
      padX: m.panelLabelPadX,
      w: m.panelLabelW,
      align: m.panelLabelAlign,
      inset: m.panelLabelInset,
    },
  };
}

// 编组标题在容器里占住的那块矩形。三种形态各占一处：
//   chip    左内边距起、顶部内边距带里的一枚药丸
//   bar-top 贯穿整宽、压住上边框的一条带子
//   side    贴左侧、吃掉整个左内边距的一列
// 排版侧靠它把连线标签让开标题（连线标签压在标题上是图面上最刺眼的一种重叠）。
export function skinPanelLabelRect(metrics, rect, textW) {
  const L = skinLayout(metrics);
  const lab = L.panelLabel;
  if (lab.mode === 'bar-top') {
    return { x: rect.x, y: rect.y, w: rect.w, h: lab.h };
  }
  if (lab.mode === 'side') {
    return {
      x: rect.x + lab.inset, y: rect.y + lab.inset,
      w: lab.w, h: Math.max(0, rect.h - lab.inset * 2),
    };
  }
  const w = Math.min(rect.w, (textW > 0 ? textW : rect.w * 0.4) + lab.padX * 2);
  return {
    x: rect.x + L.panelPad.left,
    y: rect.y + Math.max(0, (metrics.panelPadTop - lab.h) / 2),
    w: w,
    h: lab.h,
  };
}

// 卡片需要的最小宽度（textW 为标签像素宽, 由调用方按 typeNode/typeSmall 估算）
export function skinCardWidth(metrics, textW, opts) {
  const L = skinLayout(metrics);
  const o = opts || {};
  if (o.variant === 'decision') return Math.round((textW + metrics.cardPadX) / 0.6);
  return Math.round(textW + L.cardPadW + (o.hasLeftIcon ? L.iconLeftW : 0));
}

// 卡片高度: 主标题 + 可选副标题 + 可选顶置图标, 不低于 cardMinH。
// 左置图标整块居中, 图标本身可能比文字块还高（iconSize 提到 40 之后就是这样),
// 所以要单独兜一次 iconSize + 2×padY, 否则无解释文字的图标卡会被图标撑破（交接单 E1）。
export function skinCardHeight(metrics, opts) {
  const L = skinLayout(metrics);
  const o = opts || {};
  let h = L.labelH + L.padY * 2;
  if (o.hasSub) h += metrics.labelSubGap + L.subH;
  if (o.hasTopIcon) h += L.iconTopH;
  if (o.hasLeftIcon) h = Math.max(h, metrics.iconSize + L.padY * 2);
  h = Math.max(metrics.cardMinH, h);
  // 嵌套层级: 顶层(depth 0)不减, 每深一层减 cardDepthShrink, 但不低于内容真正需要的高度
  const depth = Math.max(0, Number(o.depth) || 0);
  if (depth > 0 && metrics.cardDepthShrink > 0) {
    const content = L.labelH + L.padY
      + (o.hasSub ? metrics.labelSubGap + L.subH : 0)
      + (o.hasTopIcon ? L.iconTopH : 0);
    h = Math.max(content, h - depth * metrics.cardDepthShrink);
  }
  return Math.round(h);
}

// 文字可用宽/高（质检与运行时字号自适应共用; n 为已定位的节点矩形）
export function skinTextBox(metrics, n, opts) {
  const L = skinLayout(metrics);
  const o = opts || {};
  let w = n.w - L.cardPadW;
  let h = n.h - L.padY;
  // 菱形/圆: 可用宽收到 0.6w / 0.75w 时, 对应的可用高只剩 0.4h / 0.66h
  // （菱形满足 x/w + y/h ≤ 1, 圆按内接椭圆解), 否则文字会从上下尖角处漏到形状之外
  if (o.variant === 'decision') { w = n.w * 0.6 - 8; h = n.h * 0.4 - 6; }
  else if (o.variant === 'circle') { w = n.w * 0.75; h = n.h * 0.66 - 6; }
  if (o.hasLeftIcon) w -= L.iconLeftW;
  if (o.hasTopIcon) h -= L.iconTopH;
  return { w: Math.max(16, w), h: Math.max(12, h) };
}

// 布局落到 1920×1080 时整图会被等比缩放(fitRectIntoFrame)，卡片内部的尺寸必须跟着缩，
// 否则卡片变小而字号/图标不变 —— 这正是"改一个 token 却看不出效果"的来源。
// 容器内边距(panelPadX/panelPadTop)在缩放之后才施加, 因此不参与缩放; gutterScale 是比例, 同样不缩。
// 编组标题构件与容器内边距同属"缩放之后才施加"的一档, 一并不缩; 枚举项天然不缩。
const METRICS_UNSCALED = Object.freeze({
  panelPadX: 1, panelPadTop: 1, panelPadLeft: 1, gutterScale: 1,
  panelLabelMode: 1, panelLabelH: 1, panelLabelPadX: 1, panelLabelW: 1, panelLabelAlign: 1,
});

export function scaleMetrics(metrics, s) {
  if (!isFinite(s) || s <= 0 || s === 1) return metrics;
  const out = {};
  for (let i = 0; i < METRICS_KEYS.length; i++) {
    const k = METRICS_KEYS[i];
    out[k] = METRICS_UNSCALED[k] ? metrics[k] : metrics[k] * s;
  }
  return out;
}

// 结构 token → quality-checker 的 options（质检与渲染共用同一口径, 见 QC_DEFAULTS 的 ← 标记）
// 卡片单边边框宽度（px）：从皮肤 border 简写 token 的开头取数（'1.5px solid #…' → 1.5）。
// 变体各有自己的 token：accent → abd、store → sbd、muted → mbd，其余用 nbd；
// 菱形（decision）的边框画在 ::before 的 clip-path 上、不占内容盒，取 0。
// border-box 下边框吃掉的是内容宽高：node-fit 求解（arch-doc 的 buildScene）与质检
// （qualityOptionsOf 的 nodeBorderPx、场景节点的 borderPx）都从这里取，口径只有一份。
// 只读页运行时另有 getComputedStyle 读出的真值（generate.mjs 的 fitBorderPx），两者应相等。
export function skinNodeBorderPx(skin, variant) {
  if (variant === 'decision') return 0;
  const t = (skin && skin.tokens) || {};
  const key = variant === 'accent' ? 'abd' : (variant === 'store' ? 'sbd' : (variant === 'muted' ? 'mbd' : 'nbd'));
  const raw = t[key] == null ? t.nbd : t[key];
  const m = String(raw == null ? '' : raw).match(/^\s*(\d+(?:\.\d+)?)px\b/);
  return m ? Number(m[1]) : 0;
}

export function skinQualityOptions(metrics) {
  const L = skinLayout(metrics);
  return {
    nodeLabelPx: metrics.typeNode,
    nodeSubPx: metrics.typeSmall,
    nodePaddingX: metrics.cardPadX,
    nodePadY: L.padY,
    labelSubGap: metrics.labelSubGap,
    lineHeight: LINE_H,
    lineHeightSub: LINE_H_SUB,
    iconLeftWidth: L.iconLeftW,
    iconTopHeight: L.iconTopH,
  };
}

// 结构 token → CSS 自定义属性（css 为 null 的只在 JS 侧消费, 不进 CSS）
export function skinMetricsCssVarMap(metrics) {
  const map = {};
  for (let i = 0; i < METRICS_KEYS.length; i++) {
    const k = METRICS_KEYS[i];
    const spec = METRICS_SPEC[k];
    if (!spec.css || spec.enum) continue;
    map[spec.css] = spec.ratio ? String(metrics[k]) : (Math.round(metrics[k] * 10) / 10) + 'px';
  }
  // panelPadLeft 的 0 是"跟随 panelPadX"的哨兵值, 下发给 CSS 前要解开
  map['--panel-pad-left'] = (Math.round((metrics.panelPadLeft || metrics.panelPadX) * 10) / 10) + 'px';
  return map;
}

// 图标位底板与编组标题带的三组装饰 token（交接单 E5 / X1 配套）。
// 都是"可选补充": 老皮肤没声明就退回无底色 / 跟随 muted 文字色, 观感与之前一字不差。
export function iconChip(skin) {
  const t = (skin && skin.tokens) || {};
  const glyph = Number(t.iconGlyphRatio);
  return {
    bg: t.iconChipBg || 'transparent',
    r: t.iconChipR || '0px',
    glyph: isFinite(glyph) && glyph > 0 && glyph <= 1 ? glyph : 1,
  };
}

// depth 为 1 时取第二层容器的标题配色, 缺省回落到第一层那一组
export function panelLabelPaint(skin, depth) {
  const t = (skin && skin.tokens) || {};
  const nested = depth === 1;
  const bg = nested ? (t.p2LabelBg || t.pLabelBg) : t.pLabelBg;
  const ink = nested ? (t.p2LabelInk || t.pLabelInk) : t.pLabelInk;
  const bd = nested ? (t.p2LabelBd || t.pLabelBd) : t.pLabelBd;
  const r = nested ? (t.p2LabelR || t.pLabelR) : t.pLabelR;
  return {
    bg: bg || 'transparent',
    ink: ink || t.ink3 || 'currentColor',
    bd: bd || 'none',
    // 没声明就退回"容器圆角的一半", 与改这一版之前的行为一致
    r: r || 'calc(' + (t.pr || '0px') + ' * .5)',
  };
}

// token → 生成器 CSS 自定义属性 的映射（:root 与运行时切换共用同一份口径）
export function skinCssVarMap(skin, metricsOverride) {
  const t = skin.tokens;
  const metricVars = skinMetricsCssVarMap(metricsOverride || skinMetrics(skin));
  const base = {
    '--slide-bg': t.bg,
    '--text-primary': t.ink,
    '--text-secondary': t.ink2,
    '--text-muted': t.ink3,
    '--accent': t.accent,
    '--store': t.store,
    '--type-title': t.ts,
    '--title-font': t.ftitle === 'inherit' ? t.ff : t.ftitle,
    '--title-weight': String(t.twt),
    '--title-ls': t.tls,
    '--rule-w': t.rw,
    '--body-font': t.ff,
    '--kicker-font': t.kf,
    '--kicker-ls': t.kls,
    '--node-bg': t.nbg,
    '--node-bd': t.nbd,
    '--node-shadow': t.nsh,
    '--node-r': t.nr,
    '--node-weight': String(t.nw),
    '--accent-bg': t.abg,
    '--accent-bd': t.abd,
    '--accent-label': skin.accentLabel,
    '--store-bg': t.sbg,
    '--store-bd': t.sbd,
    '--muted-bg': t.mbg,
    '--muted-bd': t.mbd,
    '--panel-bg': t.pbg,
    '--panel-bd': t.pbd,
    '--panel-r': t.pr,
    '--panel2-bg': t.p2bg,
    '--panel2-bd': t.p2bd,
    '--edge-color': t.edge,
    // 边色拆成「不透明色 + alpha」: 线与箭头端点都用不透明色描边, alpha 由元素级 opacity 承担,
    // 端点压在线上的那一段才不会二次合成而变深(见 lib/edge-weight.mjs 的 splitColorAlpha)。
    '--edge-solid': splitColorAlpha(t.edge).solid,
    '--edge-alpha': String(splitColorAlpha(t.edge).alpha),
    // 皮肤基准线宽(S=1 时的线宽)。实际落笔线宽由 --edge-stroke 下发, 见 lib/edge-weight.mjs
    '--edge-w': t.ew + 'px',
    '--elabel-bg': t.lbg,
    '--elabel-bd': t.lbd,
    '--elabel-r': t.lr,
    '--grid-opacity': String(skin.gridOpacity),
    '--decision-fill': skin.decisionFill,
    '--hairline': skin.hairline,
    // 图标位底板（交接单 E5）: 底色/圆角/字形占比。写在 tokens 里才能经 skinExportTheme
    // 进 sceneToSvg —— 只写 extraCss 的话 PPTX 与页面会对不上。
    '--icon-chip-bg': iconChip(skin).bg,
    '--icon-chip-r': iconChip(skin).r,
    '--icon-glyph-ratio': String(iconChip(skin).glyph),
    // 编组标题带的配色: 同样要进导出, 不能只写 extraCss
    '--panel2-r': skin.tokens.p2r || 'calc(' + t.pr + ' - 4px)',
    '--panel-label-r': panelLabelPaint(skin).r,
    '--panel2-label-r': panelLabelPaint(skin, 1).r,
    '--panel-label-bg': panelLabelPaint(skin).bg,
    '--panel-label-ink': panelLabelPaint(skin).ink,
    '--panel-label-bd': panelLabelPaint(skin).bd,
    '--panel2-label-bg': panelLabelPaint(skin, 1).bg,
    '--panel2-label-ink': panelLabelPaint(skin, 1).ink,
    '--panel2-label-bd': panelLabelPaint(skin, 1).bd,
  };
  const keys = Object.keys(metricVars);
  for (let i = 0; i < keys.length; i++) base[keys[i]] = metricVars[keys[i]];
  return base;
}

export function skinCssText(skin, metricsOverride) {
  const map = skinCssVarMap(skin, metricsOverride);
  return Object.keys(map).map(function(k) { return '    ' + k + ':' + map[k] + ';'; }).join('\n');
}

export function skinExportTheme(skin) {
  const t = skin.tokens;
  const solid = function(v, fallback) {
    return v && v.indexOf('gradient') < 0 ? v : fallback;
  };
  const borderColor = function(shorthand, fallback) {
    const m = String(shorthand == null ? '' : shorthand).match(/(rgba?\([^)]*\)|#[0-9a-fA-F]{3,8})/);
    return m ? m[1] : fallback;
  };
  const nodeFill = solid(t.nbg, skin.tone === 'dark' ? '#151e2b' : '#ffffff');
  return {
    // scene-svg 实际消费的键名（SCENE_THEME_DEFAULTS 同名覆盖）
    background: t.bg,
    panel: nodeFill,
    text: t.ink,
    textSecondary: t.ink2,
    textMuted: t.ink3,
    accent: t.accent,
    store: t.store,
    border: borderColor(t.nbd, skin.hairline),
    containerBorder: borderColor(t.pbd, skin.hairline),
    containerFill: solid(t.pbg, 'rgba(127,127,127,.04)'),
    edge: t.edge,
    // 连线权重: 基准线宽交给 scene-svg 侧的 edgeWeight() 按 geoScale 求解;
    // 颜色拆成不透明色 + alpha, 避免导出件里箭头端点与线段叠加变深
    edgeWidthBase: Number(t.ew) || 2,
    edgeSolid: splitColorAlpha(t.edge).solid,
    edgeAlpha: splitColorAlpha(t.edge).alpha,
    edgeLabelBg: solid(t.lbg, '#ffffff'),
    edgeLabelText: t.ink2,
    fontFamily: t.ff,
    // 结构 token: SVG/PPTX 导出与 HTML 用同一组尺寸, 避免导出件与页面对不上
    metrics: skinMetrics(skin),
    // 变体着色扩展
    tone: skin.tone,
    accentLabel: skin.accentLabel,
    decisionFill: skin.decisionFill,
    // 图标位底板与编组标题带: 页面靠 CSS 变量, 导出靠这两组, 同一份取值
    iconChip: iconChip(skin),
    panelLabel: panelLabelPaint(skin),
    panel2Label: panelLabelPaint(skin, 1),
    // 兼容别名（contract §7 早期命名）
    bg: t.bg,
    surface: nodeFill,
    panelBorder: skin.hairline,
    font: t.ff,
  };
}

