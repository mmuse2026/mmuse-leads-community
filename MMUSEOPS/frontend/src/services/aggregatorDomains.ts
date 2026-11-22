/**
 * 聚合站/平台/名录/中介/社媒域名库
 *
 * 这些域名本身不是家具/座椅采购方，而是 B2B 采购平台、SEO 聚合目录、贸易名录、
 * 社媒/社区或行业媒体/慈善机构。命中此库的客户永远不应进入联系人挖掘 / 邮箱验证 / 开发池。
 *
 * 宁缺毋滥：只收录确定是聚合站/平台/中介/非客户官网的域名，不要收录真实采购方官网。
 */
export const AGGREGATOR_DOMAINS: ReadonlySet<string> = new Set([
  // SEO 家具聚合目录站（其子页被误当独立客户）
  'furnitureroots.com',
  // B2B 采购平台 / 名录
  'tradewheel.com',
  'tradeimex.in',
  'tradekey.com',
  'tradeindia.com',
  'ec21.com',
  'globalspec.com',
  'globalsources.com',
  'alibaba.com',
  'made-in-china.com',
  'dhgate.com',
  'indiamart.com',
  // 商业情报 / 企业数据库（非采购方官网）
  'zoominfo.com',
  'crunchbase.com',
  // 电商/交易平台
  'amazon.com',
  'ebay.com',
  // 社媒 / 社区
  'facebook.com',
  'instagram.com',
  'linkedin.com',
  'twitter.com',
  'x.com',
  'youtube.com',
  'pinterest.com',
  'reddit.com',
  'tiktok.com',
  // 搜索引擎与地图（其子页/词条不是公司官网）
  'google.com',
  'googleusercontent.com',
  'maps.google.com',
  // 点评 / 黄页 / 目录聚合
  'yelp.com',
  'yellowpages.com',
  'tripadvisor.com',
  'yellowpages-uae.com',
  'd7leadfinder.com',
  // 在线词典（词条页冒充公司官网）
  'iciba.com',
  // 非客户官网（研究/慈善/媒体）
  'globalcanopy.org',
  // 政府名录 / 采购框架 / 移民文档（非采购方）
  'ised-isde.canada.ca',
  'gca.gov.uk',
  'homeaffairs.gov.au',
  // 汽车用品目录（非家具采购方）
  'kafaratplus.com',
])

/**
 * 判断给定 hostname 或 URL 是否命中聚合站/平台域名库。
 * - 自动去除 www. 前缀
 * - 自动从 URL 中提取 hostname
 */
export function isAggregatorDomain(hostnameOrUrl: string): boolean {
  const raw = String(hostnameOrUrl || '').trim().toLowerCase()
  if (!raw) return false
  let hostname: string
  try {
    hostname = new URL(raw.includes('://') ? raw : `https://${raw}`).hostname
  } catch {
    return false
  }
  hostname = hostname.replace(/^www\./, '').replace(/\.$/, '')
  // 精确命中或子域名后缀命中（如 xxx.en.made-in-china.com → made-in-china.com），
  // 平台卖家页/子目录被误当独立客户时入口即可拦截。
  return AGGREGATOR_DOMAINS.has(hostname) || [...AGGREGATOR_DOMAINS].some((d) => hostname.endsWith('.' + d))
}
