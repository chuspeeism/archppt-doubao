// 图标匹配逻辑 [INLINE]（契约 §5，PRD §3.3.1）。
// 匹配顺序：显式 hint → 精确匹配 → 关键词包含 → null。
// 纯函数，不依赖 DOM；图标数据由调用方以参数传入（TECH_ICONS / GENERIC_ICONS）。

// 关键词映射表 { pattern(小写): slug }。按插入顺序匹配，具体词必须排在宽泛词之前
// （如「消息队列」在「消息」前、「对象存储」在「存储」前、「微信支付」在「微信」前）。
// 注：simple-icons 因商标政策不含 AWS/Azure/GCP/OpenAI，gcp 映射到 googlecloud；
// 大模型/llm 等通用词映射到通用图标 cpu，不替补任何厂商品牌。
// 图标库只收录 CC0-1.0 与 ISC 的图标：凡对商业使用附带条件的（禁商用、需署名、
// 需相同方式共享）一律不收，因此 kafka/spark/flink/vue/java 等品牌图标不在库内，
// 相关关键词映射到通用图标。
// 原则（2026-08-04 测试反馈 P1#5 修订）：**只有品牌词才映射品牌图标**。
// 通用概念词（网关/数据库/缓存/日志/大模型…）一律映射 lucide 通用图标——
// 品牌 logo 是技术选型断言，源里没提的品牌不能替用户宣称。
export const ICON_KEYWORDS = {
  // —— 品牌词 → 品牌图标（保留） ——
  'redis缓存': 'redis',
  'k8s': 'kubernetes',
  'postgres': 'postgresql',
  'pgsql': 'postgresql',
  'mongo': 'mongodb',
  'rabbitmq': 'rabbitmq',
  'gemini': 'googlegemini',
  '通义千问': 'qwen',
  '千问': 'qwen',
  '深度求索': 'deepseek',
  '阿里云': 'alibabacloud',
  '谷歌云': 'googlecloud',
  'gcp': 'googlecloud',
  'golang': 'go',
  'nodejs': 'nodejs',
  'node服务': 'nodejs',
  'java服务': 'server',   // java 图标为 BSD-3-Clause, 已移除
  'springboot': 'springboot',
  'next.js': 'nextjs',
  'nextjs': 'nextjs',
  '微信小程序': 'wechat',
  '小程序': 'smartphone',   // 通用词: 各家都有小程序, 不贴微信商标
  // —— 因许可证被移除的品牌: 关键词保留, 映射到通用图标, 使节点仍有图标 ——
  'kafka': 'send',
  'rocketmq': 'send',
  'pulsar': 'send',
  'cassandra': 'database',
  'clickhouse': 'database',
  'spark': 'zap',
  'flink': 'zap',
  'jenkins': 'workflow',
  'jvm': 'server',
  // —— 通用概念词 → 通用图标（降级修订） ——
  '容器编排': 'package',
  '云原生': 'cloud',
  '容器': 'package',
  '关系型数据库': 'database',
  '文档数据库': 'database',
  '图数据库': 'database',
  '向量数据库': 'database',
  '时序数据库': 'database',
  '数据仓库': 'database',
  '数据库': 'database',
  '缓存': 'zap',
  '全文检索': 'search',
  '搜索引擎': 'search',
  '日志': 'file-text',
  '对象存储': 'folder',
  '消息队列': 'send',
  '任务队列': 'workflow',
  '定时任务': 'clock',
  '大模型': 'cpu',
  '大语言模型': 'cpu',
  'llm': 'cpu',
  'ai助手': 'cpu',
  '模型推理': 'cpu',
  'embedding': 'cpu',
  '深度学习': 'cpu',
  '反向代理': 'server',
  '负载均衡': 'server',
  'api网关': 'globe',
  '网关': 'globe',
  '服务网格': 'workflow',
  '监控': 'monitor',
  '告警': 'bell',
  '仪表盘': 'bar-chart-3',
  '可视化大屏': 'bar-chart-3',
  '大数据': 'database',
  '流计算': 'zap',
  '实时计算': 'zap',
  '代码仓库': 'git-branch',
  'git仓库': 'git-branch',
  '流水线': 'workflow',
  'ci/cd': 'workflow',
  'cicd': 'workflow',
  '爬虫': 'globe',
  '前端': 'monitor',
  // —— 支付 / 电商（品牌优先于通用） ——
  '微信支付': 'wechat',
  '微信': 'wechat',
  '支付宝': 'alipay',
  '支付': 'credit-card',
  '购物车': 'shopping-cart',
  '订单': 'shopping-cart',
  '商品': 'package',
  '库存': 'package',
  '物流': 'truck',
  '快递': 'truck',
  // —— 通用装饰（lucide） ——
  '邮件': 'mail',
  '邮箱': 'mail',
  '通知': 'bell',
  '推送': 'bell',
  '短信': 'message-square',
  '消息': 'message-square',
  '聊天': 'message-square',
  '电话': 'phone',
  '用户': 'user',
  '客户': 'user',
  '会员': 'users',
  '团队': 'users',
  '审核': 'user-check',
  '鉴权': 'lock',
  '权限': 'lock',
  '加密': 'lock',
  '认证': 'shield',
  '安全': 'shield',
  '风控': 'shield',
  '文档': 'file-text',
  '文件': 'file',
  '目录': 'folder',
  '报表': 'bar-chart-3',
  '统计': 'bar-chart-3',
  '搜索': 'search',
  '定时': 'clock',
  '日历': 'calendar',
  '配置': 'settings',
  '设置': 'settings',
  '服务器': 'server',
  '存储': 'database',
  '工作流': 'workflow',
  '流程': 'workflow',
};

// 小写 + 去掉所有非字母数字字符（CJK 也会被去掉——仅用于英文 slug 归一）
export function normalizeIconKey(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// 在两个图标字典里查 key：先按原样、再按 normalize 后的 key、最后与字典 key 的
// normalize 形式逐一比对（如 "shopping-cart" 归一为 "shoppingcart" 也能命中）。
function lookupIconSlug(key, techIcons, genericIcons) {
  const raw = String(key == null ? '' : key);
  if (raw && Object.prototype.hasOwnProperty.call(techIcons, raw)) return { slug: raw, type: 'tech' };
  if (raw && Object.prototype.hasOwnProperty.call(genericIcons, raw)) return { slug: raw, type: 'generic' };
  const norm = normalizeIconKey(raw);
  if (!norm) return null;
  if (Object.prototype.hasOwnProperty.call(techIcons, norm)) return { slug: norm, type: 'tech' };
  if (Object.prototype.hasOwnProperty.call(genericIcons, norm)) return { slug: norm, type: 'generic' };
  for (const slug of Object.keys(techIcons)) {
    if (normalizeIconKey(slug) === norm) return { slug, type: 'tech' };
  }
  for (const slug of Object.keys(genericIcons)) {
    if (normalizeIconKey(slug) === norm) return { slug, type: 'generic' };
  }
  return null;
}

// matchIcon(label, iconHint, techIcons, genericIcons) -> { slug, type } | null
// 1) iconHint === false 表示节点显式禁用图标；
// 2) 显式 hint 命中（tech 优先于 generic）；
// 3) label 归一后精确命中；
// 4) label 按英文分词逐词精确命中（"MySQL Cluster"→mysql、"Flink CDC"→flink）；
// 5) label 小写去空白后按 ICON_KEYWORDS 顺序做包含匹配（"API 网关"与"API网关"同命中）；
// 6) 全部未命中返回 null（调用方回退默认形状）。
export function matchIcon(label, iconHint, techIcons, genericIcons) {
  const tech = techIcons || {};
  const generic = genericIcons || {};
  if (iconHint === false) return null;
  if (iconHint != null && iconHint !== '') {
    const hinted = lookupIconSlug(iconHint, tech, generic);
    if (hinted) return hinted;
  }
  const raw = String(label == null ? '' : label);
  if (!raw) return null;
  const exact = lookupIconSlug(raw, tech, generic);
  if (exact) return exact;
  const tokens = raw.split(/[^A-Za-z0-9.+#-]+/);
  for (const token of tokens) {
    if (token.length < 3) continue; // 过短 token 噪声大（Go/DB 等不做分词命中）
    const hit = lookupIconSlug(token, tech, generic);
    if (hit) return hit;
  }
  const lower = raw.toLowerCase().replace(/\s+/g, '');
  for (const pattern of Object.keys(ICON_KEYWORDS)) {
    const normPattern = pattern.replace(/\s+/g, '');
    if (normPattern && lower.indexOf(normPattern) !== -1) {
      const slug = ICON_KEYWORDS[pattern];
      if (Object.prototype.hasOwnProperty.call(tech, slug)) return { slug, type: 'tech' };
      if (Object.prototype.hasOwnProperty.call(generic, slug)) return { slug, type: 'generic' };
    }
  }
  return null;
}

// 显式 hint 是否存在于图标库（供调用方在回退前告警，修 P1#7）
export function iconSlugExists(slug, techIcons, genericIcons) {
  return lookupIconSlug(slug, techIcons || {}, genericIcons || {}) != null;
}
