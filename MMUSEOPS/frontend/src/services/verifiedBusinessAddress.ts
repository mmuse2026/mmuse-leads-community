import { inferBusinessContextTimezone } from './formalSendQueue'

const ALLOWED_VERIFIED_BUSINESS_TYPES = new Set([
  'personal_company',
  'free_business',
  'department',
  'public',
  'location',
])

/**
 * A verified company business inbox is eligible regardless of whether it is
 * person-named, departmental, public-facing, or location-specific. Delivery
 * verification and explicit non-business-role suppression remain separate gates.
 */
export function isVerifiedBusinessAddress(row: {
  emailType?: string
  verificationState?: string
  tier?: string
}): boolean {
  return row.verificationState === 'accepted'
    && ALLOWED_VERIFIED_BUSINESS_TYPES.has(String(row.emailType || ''))
    && row.tier !== 'E'
}

export function resolveOutreachCompanyName(item: any): string {
  const backcheck = item?.backCheck || item?.backcheck || {}
  const explicitName = String(backcheck.companyName || '').trim()
  if (explicitName) return explicitName

  const summary = String(backcheck.summary || item?.evidenceSummary || '').trim()
  const summaryName = summary.match(/^(.{2,80}?)\s+(?:is|are)\s+(?:a|an|the)\b/i)?.[1]?.trim()
  if (summaryName) {
    const domain = String(backcheck.companyWebsite || item?.website || item?.canonicalDomain || '')
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .split(/[/?#:]/)[0]
      .toLowerCase()
    const nameTokens = normalizeIdentityTokens(summaryName)
    const domainTokens = normalizeIdentityTokens(domain.split('.')[0])
    if (nameTokens.some(nameToken => domainTokens.some(domainToken =>
      nameToken === domainToken || nameToken.length >= 4 && domainToken.length >= 4
        && (nameToken.includes(domainToken) || domainToken.includes(nameToken)),
    ))) return summaryName
  }
  return String(item?.company || item?.title || '').trim()
}

function normalizeIdentityTokens(value: string): string[] {
  return value.toLowerCase()
    .normalize('NFKD')
    .replace(/\.[a-z]{2,}$/i, '')
    .split(/[^a-z0-9]+/)
    .filter(token => token.length >= 3)
}

/**
 * Confirms that the selected business inbox's domain has a meaningful identity
 * overlap with the backchecked company name. A search-result title is never
 * used when a backchecked company name exists.
 */
export function hasCompanyDomainIdentity(item: any, email: string): boolean {
  const companyName = resolveOutreachCompanyName(item)
  const emailDomain = String(email || '').split('@')[1]?.toLowerCase().replace(/^www\./, '') || ''
  const websiteValue = String(item?.canonicalDomain || item?.domain || item?.website || '').trim()
  const websiteDomain = websiteValue
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split(/[/?#:]/)[0]
    .toLowerCase()
  const domain = websiteDomain || emailDomain
  if (!companyName || !emailDomain) return false

  const isSameCompanyDomain = (value: unknown) => {
    const host = String(value || '').trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').split(/[/?#:]/)[0].toLowerCase()
    return host === emailDomain || host.endsWith(`.${emailDomain}`) || emailDomain.endsWith(`.${host}`)
  }
  const backcheck = item?.backCheck || item?.backcheck || {}
  const identityIsVerified = String(item?.entityResolutionStatus || '').toLowerCase() === 'resolved'
    && String(item?.identityEvidenceConfidence || '').toLowerCase() === 'verified'
    && [item?.website, item?.canonicalDomain, backcheck?.companyWebsite, item?.sourceUrl]
      .some(isSameCompanyDomain)
  if (domain !== emailDomain) return false

  const genericTokens = new Set(['the', 'and', 'for', 'company', 'co', 'corp', 'corporation', 'limited', 'ltd', 'llc', 'inc', 'group', 'holdings', 'international', 'furniture', 'trading'])
  const companyTokens = normalizeIdentityTokens(companyName).filter(token => !genericTokens.has(token))
  const domainTokens = normalizeIdentityTokens(emailDomain.split('.')[0]).filter(token => !genericTokens.has(token))
  const nameMatchesDomain = companyTokens.some(companyToken => domainTokens.some(domainToken =>
    companyToken === domainToken
      || companyToken.length >= 4 && domainToken.length >= 4
        && (companyToken.includes(domainToken) || domainToken.includes(companyToken))
      || identityIsVerified && companyToken.length === 3 && domainToken.startsWith(companyToken),
  ))
  if (nameMatchesDomain) return true

  const summaryTokens = normalizeIdentityTokens(String(backcheck.summary || item?.evidenceSummary || ''))
    .filter(token => !genericTokens.has(token))
  const nameMatchesBackcheckDescription = identityIsVerified
    && companyTokens.length > 0
    && companyTokens.some(token => summaryTokens.includes(token))
  return nameMatchesBackcheckDescription
}

export function isUsableFurnitureProspect(item: any): boolean {
  const match = String(item?.businessMatch || item?.backCheck?.businessMatch || '').trim().toLowerCase()
  if (!['high', 'medium'].includes(match)) return false
  const backcheck = item?.backCheck || item?.backcheck || {}
  if (String(backcheck.failureReason || '').trim()) return false
  const hasBackcheckEvidence = Boolean(
    String(backcheck.companyName || '').trim()
    || String(backcheck.summary || '').trim()
    || (Array.isArray(backcheck.products) && backcheck.products.length),
  )
  if (!hasBackcheckEvidence) return false
  const assessment = String(item?.customerTypeAssessment || item?.clientTypeAssessment || '').trim().toLowerCase()
  if (/supplier[_ -]or[_ -]competitor|competitor/.test(assessment)) return false
  return true
}

/**
 * A high/medium CRM match is only a label. Require the stored company evidence
 * to describe furniture-related activity or a plausible furniture-buying
 * operator, and reject obvious unrelated entities / failed-page summaries.
 */
export function isFurnitureCustomerRelevant(item: any): boolean {
  const backcheck = item?.backCheck || item?.backcheck || {}
  const rawProducts = backcheck.products || backcheck.mainProducts
  const products = Array.isArray(rawProducts) ? rawProducts.join(' ') : String(rawProducts || '')
  const evidence = [products, backcheck.summary, backcheck.industry, backcheck.customerTypeAssessment,
    item?.customerTypeAssessment, item?.clientTypeAssessment, item?.businessSummary, item?.evidenceSummary]
    .filter(Boolean).join(' ').toLowerCase()
  if (!evidence.trim()) return false
  if (/modeling agency|talent representation|model management|recruitment agency|job listings|social content|automotive seat covers|access denied|captcha|industry-signals:0|no information available/.test(evidence)) return false
  const role = String(item?.customerTypeAssessment || item?.clientTypeAssessment || '').toLowerCase()
  if (/supplier[_ -]or[_ -]competitor|manufacturer_partner|competitor/.test(role)) return false
  const furnitureSignals = /furniture|furnishings|seating|banquette|booth seating|office fit.?out|interior fit.?out|ff.?e|commercial interiors|interior design|procurement|sourcing|contract furniture/.test(evidence)
  const operatorSignals = /hotel|hospitality|resort|restaurant|cafe|café|bar |clubhouse|recreation club|venue|catering|food.?service|senior living|student housing/.test(evidence)
  if (!furnitureSignals && !operatorSignals) return false
  const manufacturerSignals = /manufacturer|manufacturing|manufactures|manufactured/.test(evidence)
  const independentResaleSignals = /\b(?:imports?|distributors?|retailers?|resellers?|dealers?)\b/.test(evidence)
  if (manufacturerSignals && furnitureSignals && !independentResaleSignals) return false
  return true
}

/** Resolve only locations supported by explicit city/region text; do not use a
 * generic North-American fallback when the company is multi-state or unknown. */
export function resolveVerifiedCompanyTimezone(item: any): { timezone?: string; source: string; needsReview: boolean } {
  const backcheck = item?.backCheck || item?.backcheck || {}
  const location = [item?.address, item?.location, backcheck?.address, backcheck?.location,
    backcheck?.summary, item?.businessSummary, item?.evidenceSummary].filter(Boolean).join(' ')
  const direct: Array<[RegExp, string]> = [
    [/\bLos Angeles\b|\bCalifornia\b/i, 'America/Los_Angeles'],
    [/\bNew Haven\b|\bMiami\b|\bFlorida\b/i, 'America/New_York'],
    [/\bAustin\b|\bTexas\b|\bChicago\b/i, 'America/Chicago'],
    [/\bMelbourne\b|\bVictoria\b/i, 'Australia/Melbourne'],
    [/\bSydney\b|\bNew South Wales\b/i, 'Australia/Sydney'],
    [/\bDubai\b|\bUnited Arab Emirates\b|\bUAE\b/i, 'Asia/Dubai'],
    [/\bKuwait\b/i, 'Asia/Kuwait'],
    [/\bRiyadh\b|\bSaudi Arabia\b/i, 'Asia/Riyadh'],
    [/\bSingapore\b/i, 'Asia/Singapore'],
    [/\bCopenhagen\b|\bDenmark\b/i, 'Europe/Copenhagen'],
    [/\bGermany\b|\bBerlin\b/i, 'Europe/Berlin'],
    [/\bBelgium\b|\bBrussels\b|\bMerksem\b/i, 'Europe/Brussels'],
    [/\bUnited Kingdom\b|\bUK\b|\bGloucester\b|\bSomerset\b/i, 'Europe/London'],
    [/\bIreland\b|\bCounty Clare\b/i, 'Europe/Dublin'],
    [/\bPoland\b|\bWarsaw\b|\bGdansk\b|\bKrakow\b|\bCracow\b/i, 'Europe/Warsaw'],
    [/\bJapan\b/i, 'Asia/Tokyo'],
  ]
  const match = direct.find(([pattern]) => pattern.test(location))
  if (match) return { timezone: match[1], source: 'verified_location_text', needsReview: false }
  if (/multi.?state.*headquarters location not specified|global.{0,30}multiple properties|multiple locations.{0,50}headquarters.{0,20}not specified/i.test(location)) {
    return { source: 'location_is_multi_region_without_hq', needsReview: true }
  }
  const inferred = inferBusinessContextTimezone(item)
  if (inferred.source === 'north_america_multi_zone_overlap' || inferred.source === 'utc_safe_window_fallback') {
    return { source: inferred.source, needsReview: true }
  }
  return inferred
}

export function hasOpenCrmTask(item: any): boolean {
  const openStatuses = new Set(['pending', 'open', 'in_progress', 'todo', 'due', 'overdue'])
  return (Array.isArray(item?.crmTasks) ? item.crmTasks : []).some((task: any) => {
    if (task?.completedAt || task?.closedAt || task?.cancelledAt) return false
    return openStatuses.has(String(task?.status || '').trim().toLowerCase())
  })
}

export function hasPriorFormalOutreach(item: any): boolean {
  return (Array.isArray(item?.emailLogs) ? item.emailLogs : []).some((log: any) =>
    String(log?.status || '').trim().toLowerCase() === 'sent'
    && ['formal_outreach', 'formal'].includes(String(log?.type || '').trim().toLowerCase()),
  )
}
