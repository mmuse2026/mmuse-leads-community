import { isAggregatorDomain } from './aggregatorDomains'
import { classifySearchSource } from './searchResultPolicy'

export type CustomerEntityNoiseCategory = '聚合平台或目录' | '内容页面' | '产品页面' | '主体不明确'

export interface CustomerEntityQualityVerdict {
  isStrongNoise: boolean
  category?: CustomerEntityNoiseCategory
  reason?: string
}

const CONTENT_PATH = /(?:\.pdf(?:[?#]|$)|\/(?:careers?|jobs?|vacancies|recruitment|press|news|blog|articles?|research|papers?|publications?|downloads?|resources?|gallery|images?|media)(?:[/?#]|$))/i
const CONTENT_TEXT = /\b(?:job|jobs|career|careers|hiring|vacancy|vacancies|apply now|research paper|journal|thesis|dissertation|conference paper|press release|news article|stock photo|royalty.free|download pdf|catalogue pdf)\b/i
const PRODUCT_TEXT = /\b(?:chair|chairs|table|tables|sofa|sofas|bed|beds|cabinet|cabinets|stool|stools|bench|benches|desk|desks|furniture set|seat cover|seat covers)\b/i
const GENERIC_ENTITY = /^(?:untitled|unknown|n\/a|null|undefined|home|homepage|contact|about|product|products|search result|website|待定|未知|未明确)$/i
const MOJIBAKE = /\uFFFD|(?:Ã.|Â.|â€|â€™|â€œ|â€\u009d|ðŸ|ï¿½)/

function clean(value: unknown): string {
  return String(value ?? '').trim()
}

function normalized(value: unknown): string {
  return clean(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

function hostLabel(value: unknown): string {
  const raw = clean(value)
  if (!raw) return ''
  try {
    const host = new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.replace(/^www\d*\./, '')
    const parts = host.split('.').filter(Boolean)
    if (parts.length < 2) return ''
    const candidate = parts[parts.length - 2] || ''
    return normalized(candidate.length <= 3 && parts.length >= 3 ? parts[parts.length - 3] : candidate)
  } catch { return '' }
}

function hasClearWebsite(value: unknown): boolean {
  return Boolean(hostLabel(value))
}

function productTitleWasUsedAsCompany(company: string, title: string, website: string): boolean {
  if (!company || normalized(company) !== normalized(title || company) || !PRODUCT_TEXT.test(company)) return false
  const label = hostLabel(website)
  const entity = normalized(company).replace(/\s+/g, '')
  return !label || (!entity.includes(label) && !label.includes(entity))
}

export function assessCustomerEntityQuality(item: any): CustomerEntityQualityVerdict {
  const company = clean(item?.company)
  const title = clean(item?.title)
  const website = clean(item?.website || item?.sourceUrl || item?.canonicalDomain || item?.domain)
  const snippet = clean(item?.snippet)
  const sourceType = classifySearchSource({ url: website, title, snippet })
  if (isAggregatorDomain(website) || ['directory', 'yellow_page', 'listicle/top', 'marketplace/platform', 'social_page'].includes(sourceType)) {
    return { isStrongNoise: true, category: '聚合平台或目录', reason: '聚合平台或目录，不是客户公司官网' }
  }
  if (sourceType === 'news/blog/article' || CONTENT_PATH.test(website) || CONTENT_TEXT.test(`${company} ${title} ${snippet}`)) {
    return { isStrongNoise: true, category: '内容页面', reason: '招聘、论文、素材或资讯页面，不是客户公司主体' }
  }
  if (sourceType === 'product_page' && productTitleWasUsedAsCompany(company, title, website)) {
    return { isStrongNoise: true, category: '产品页面', reason: '产品页面标题被误当作客户公司' }
  }
  const entity = company || title
  if (!entity || (GENERIC_ENTITY.test(entity) && !hasClearWebsite(website)) || (MOJIBAKE.test(entity) && !hasClearWebsite(website))) {
    return { isStrongNoise: true, category: '主体不明确', reason: '无法识别明确的客户公司主体' }
  }
  return { isStrongNoise: false }
}

export function isolateCustomerEntityNoise(item: any, now = new Date()): { item: any; changed: boolean; verdict: CustomerEntityQualityVerdict } {
  const verdict = assessCustomerEntityQuality(item)
  if (!verdict.isStrongNoise) return { item, changed: false, verdict }
  const audit = Array.isArray(item?.qualityIsolationAudit) ? item.qualityIsolationAudit : []
  const fingerprint = `客户实体质量:${verdict.category}`
  const nextAudit = audit.some((entry: any) => entry?.fingerprint === fingerprint)
    ? audit
    : [...audit, { fingerprint, reason: verdict.reason, at: now.toISOString() }].slice(-20)
  const next = {
    ...item,
    qualityStatus: '已隔离',
    qualityIsolationCategory: verdict.category,
    qualityIsolationReason: verdict.reason,
    qualityIsolationAudit: nextAudit,
    recommendedAction: 'true_excluded',
    operationalTier: 'true_excluded',
    reviewDisposition: 'do_not_develop',
    doNotDevelop: true,
    primaryStage: 'true_excluded',
    normalizedStage: 'true_excluded',
    currentAllowedStage: 'true_excluded',
    activeWorkflow: false,
    inactiveWorkflow: true,
    inactiveCategory: 'quality_noise',
    inactiveReason: verdict.reason,
    excludedAt: item?.excludedAt || now.toISOString(),
  }
  const isolationFields = [
    'qualityStatus', 'qualityIsolationCategory', 'qualityIsolationReason', 'qualityIsolationAudit',
    'recommendedAction', 'operationalTier', 'reviewDisposition', 'doNotDevelop', 'primaryStage',
    'normalizedStage', 'currentAllowedStage', 'activeWorkflow', 'inactiveWorkflow', 'inactiveCategory',
    'inactiveReason', 'excludedAt',
  ]
  const changed = isolationFields.some(key => JSON.stringify(item?.[key]) !== JSON.stringify(next[key]))
  return { item: changed ? next : item, changed, verdict }
}
