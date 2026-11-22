import { getDomain } from 'tldts'
import { isAggregatorDomain } from './aggregatorDomains'

// 聚合站清单以 aggregatorDomains.ts 为唯一来源，此处保留同名再导出以兼容既有引用路径。
export { isAggregatorDomain }

export interface CrmIdentity {
  key: string
  method: 'domain' | 'company_country' | 'unresolved'
  domain?: string
  reason?: string
}

const clean = (value: unknown) => String(value ?? '').trim().toLowerCase()

/**
 * 带点缩写的公司后缀（在标点归一之前剥离，否则 S.A. 会被拆成 s / a 两个 token）。
 * 西语/葡语 S.A.  S.L.  S.C.；阿语 ش.م.م / ذ.م.م。
 */
const DOTTED_COMPANY_SUFFIX = /(?<![\p{L}\p{N}])(?:s\.\s*l\.?|s\.\s*c\.?|s\.\s*a\.?|ش\.?\s?م\.?\s?م|ذ\.?\s?م\.?\s?م)(?![\p{L}\p{N}])/gu

/**
 * 西里尔 / 中文 / 阿语后缀。这些文字没有词边界概念，用 Unicode 环视代替 \b。
 * 中文后缀直接子串匹配（中文不自带空格分隔）。
 */
const NON_LATIN_COMPANY_SUFFIX = /(?<![\p{L}\p{N}])(?:ооо|оао|зао|пао|مؤسسة)(?![\p{L}\p{N}])|(?:有限公司|集团|股份|有限|公司)/gu

/** 任意位置均可剥离的公司后缀（语义明确，不可能是公司名主体）。 */
const COMPANY_SUFFIX_ANYWHERE: ReadonlySet<string> = new Set([
  'incorporated', 'corporation', 'company', 'limited', 'inc', 'corp', 'ltd', 'llc', 'llp',
  'gmbh', 'sarl', 'sas', 'srl', 'spa', 'bv', 'nv', 'plc', 'pty',
  'lda', 'eireli',
  'aps', 'oy',
  'wll', 'fze', 'fzco',
])

/** 仅在名称末尾才剥离的歧义短后缀（避免 "Co Living" 被削成 "Living"）。 */
const COMPANY_SUFFIX_TRAILING: ReadonlySet<string> = new Set(['sa', 'sl', 'sc', 'ab', 'as', 'co'])

/**
 * 行业泛词词表：这些 token 单独或组合都**不可能**是某家具体公司的可区分名称。
 * 判定规则 = 归一后**全部** token 都命中词表才算泛词（"Hospitality Management Group"
 * 因为 group 不在表内，仍然保留）。宁缺毋滥：只收语义上无区分度的词。
 */
const GENERIC_COMPANY_TOKENS: ReadonlySet<string> = new Set([
  // 场所 / 业态
  'restaurants', 'restaurant', 'hotels', 'hotel', 'hospitality', 'resorts', 'resort',
  'cafes', 'cafe', 'bars', 'club', 'clubs', 'catering', 'banquet', 'banqueting',
  'events', 'event', 'venue', 'venues', 'wellness', 'gym', 'fitness', 'salon',
  'schools', 'school', 'university', 'college', 'hospitals', 'hospital', 'clinics', 'clinic',
  'airport', 'airports', 'marina', 'cruise', 'malls', 'mall',
  'showroom', 'showrooms', 'stores', 'store',
  // 产品 / 品类
  'furniture', 'furnishings', 'furnishing', 'upholstery', 'interiors', 'interior',
  'chairs', 'chair', 'seating', 'seats', 'seat', 'sofas', 'sofa', 'tables', 'table',
  'banquet', 'booth', 'booths', 'dining', 'lounge', 'patio', 'outdoor', 'office',
  'kitchen', 'bedroom', 'bathroom', 'mattress', 'flooring', 'carpets', 'carpet',
  'lighting', 'textiles', 'fabrics', 'curtains', 'blinds', 'bedding',
  // 商业角色
  'supplier', 'suppliers', 'manufacturer', 'manufacturers', 'factory', 'factories',
  'producer', 'producers', 'maker', 'makers', 'vendor', 'vendors',
  'distributor', 'distributors', 'dealer', 'dealers', 'buyer', 'buyers',
  'importer', 'importers', 'exporter', 'exporters', 'contractor', 'contractors',
  'consultant', 'consultants', 'agency', 'agencies', 'services', 'service',
  'solutions', 'solution', 'sourcing', 'procurement', 'purchasing', 'purchase',
  'trading', 'trade', 'exports', 'export', 'imports', 'import', 'supplies', 'supply',
  'industries', 'industry', 'enterprises', 'enterprise',
  'construction', 'contracting', 'installation', 'installations', 'fitout', 'fitouts',
  'turnkey', 'projects', 'project', 'engineering', 'consulting', 'management',
  'sales', 'marketing', 'wholesale', 'retail', 'design', 'designer', 'designers',
  // 泛用修饰词
  'commercial', 'residential', 'contract', 'contracts', 'custom', 'luxury',
  'premium', 'quality', 'professional', 'international', 'global', 'national', 'general',
  // 无信息占位（含历史硬编码黑名单，归一后形态）
  'unknown', 'none', 'null', 'undefined', 'tbd', 'test', 'sample',
  'leads', 'lead', 'customer', 'client', 'prospect', 'contact',
  'n', 'a', 'na', 'e', 'ff',
  '待定', '未知', '未明确',
])

const isCompanySuffixToken = (token: string, isLast: boolean): boolean =>
  COMPANY_SUFFIX_ANYWHERE.has(token) || (isLast && COMPANY_SUFFIX_TRAILING.has(token))

export function normalizeCompanyName(value: unknown): string {
  const base = clean(value)
    .replace(DOTTED_COMPANY_SUFFIX, ' ')
    .replace(NON_LATIN_COMPANY_SUFFIX, ' ')
    .replace(/[“”"'`´’.,，。()（）\[\]{}&+/_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!base) return ''
  const tokens = base.split(' ').filter(Boolean)
  return tokens.filter((token, index) => !isCompanySuffixToken(token, index === tokens.length - 1)).join(' ')
}

/** 归一后的公司名若全部由行业泛词组成，则该名称对公司唯一性没有区分度。 */
export function isGenericCompanyName(normalized: string): boolean {
  const tokens = normalized.split(' ').filter(Boolean)
  if (!tokens.length) return true
  return tokens.every(token => GENERIC_COMPANY_TOKENS.has(token))
}

function hostFrom(value: unknown): string {
  const raw = clean(value)
  if (!raw) return ''
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`)
    return url.hostname.replace(/^www\d*\./, '').replace(/\.$/, '')
  } catch { return '' }
}

/**
 * 取 eTLD+1（公共后缀列表 PSL，ICANN 段）。
 * tldts 默认不启用 private 段，因此 github.io 之类的私有后缀仍按 ICANN 规则处理。
 */
export function registrableDomain(value: unknown): string {
  const host = hostFrom(value)
  if (!host || host === 'localhost' || /^\d+(?:\.\d+){3}$/.test(host) || isAggregatorDomain(host)) return ''
  // Hosted company sites belong to distinct tenants, not to the hosting provider.
  if (host.endsWith('.squarespace.com')) return host.split('.').slice(-3).join('.')
  const domain = getDomain(host, { allowPrivateDomains: false, validateHostname: false })
  // 单标签主机名（localhost / 内网名）与纯 IP 在 PSL 下取不到 eTLD+1
  if (!domain || !domain.includes('.')) return ''
  return domain
}

/**
 * 按优先级依次尝试候选值，返回第一个能解析出 registrable domain 的结果。
 * 不能像 `||` 那样只看"第一个非空字符串"：canonicalDomain 可能是历史硬编码
 * 后缀表截断出的垃圾值（如 "net.au"），此时必须继续尝试 website 等后续候选。
 */
function firstRegistrableDomain(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    const domain = registrableDomain(candidate)
    if (domain) return domain
  }
  return ''
}

export function resolveCrmIdentity(item: any): CrmIdentity {
  const domain = firstRegistrableDomain(
    item?.canonicalDomain,
    item?.website,
    item?.officialWebsite,
    item?.domain,
  )
  if (domain) return { key: `domain:${domain}`, method: 'domain', domain }
  const company = normalizeCompanyName(item?.company || item?.title)
  const country = clean(item?.country || item?.countryCode).replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim()
  if (company && country && !isGenericCompanyName(company)) {
    return { key: `company:${company}|${country}`, method: 'company_country' }
  }
  return { key: '', method: 'unresolved', reason: '公司官网或公司名与国家不足' }
}

export function stampCrmIdentity(item: any): any {
  const identity = resolveCrmIdentity(item)
  if (!identity.key) {
    const provisional = clean(item?.id) ? `pending:${clean(item.id)}` : ''
    const { crmCompanyKey: _oldKey, ...rest } = item
    return { ...rest, ...(provisional ? { crmCompanyKey: provisional } : {}), crmIdentityStatus: '待补充', crmIdentityReason: identity.reason }
  }
  const { crmIdentityReason: _oldReason, ...rest } = item
  return {
    ...rest,
    crmCompanyKey: identity.key,
    crmIdentityMethod: identity.method,
    crmIdentityStatus: '已确认',
    ...(identity.domain ? { canonicalDomain: identity.domain } : {}),
  }
}

export function isActiveCrmMaster(item: any): boolean {
  return !item?.crmMergedInto && item?.inactiveCategory !== 'duplicate' && item?.activeWorkflow !== false && item?.inactiveWorkflow !== true && item?.status !== 'archived'
}
