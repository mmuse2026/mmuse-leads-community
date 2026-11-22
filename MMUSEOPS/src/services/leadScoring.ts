import type { LeadGrade, PipelineItem } from '../types/item'
import { getActiveProfile } from './profiles'

export interface LeadScoreResult {
  grade: LeadGrade
  score: number
  reasons: string[]
}

const GRADE_ORDER: Record<LeadGrade, number> = { S: 0, A: 1, B: 2, C: 3, D: 4 }
const PUBLIC_EMAIL_PREFIXES = new Set([
  'info', 'sales', 'support', 'contact', 'admin', 'office', 'mail', 'hello', 'service',
  'enquiry', 'inquiry', 'orders', 'shipping', 'billing', 'accounts', 'hr', 'marketing',
  'media', 'press', 'partners', 'team', 'help', 'feedback', 'webmaster', 'postmaster',
  'no-reply', 'noreply',
])

const BUYER_TYPE_BONUS = new Set(['distributor', 'wholesaler', 'retailer', 'trader', 'ecommerce'])
const HIGH_RISK_COUNTRIES = ['india', 'brazil', 'russia', 'ukraine', 'iran', 'iraq', 'syria', 'yemen', 'israel', 'palestine', 'lebanon']
const STRONG_FURNITURE_TERMS = ['restaurant', 'hotel', 'cafe', 'bar', 'booth', 'banquette', 'dining', 'chair', 'table', 'sofa', 'commercial furniture', 'hospitality']
const STRONG_CARSEAT_TERMS = ['seat cover', 'car seat', 'auto seat', 'automotive', 'vehicle', 'car accessories', 'upholstery']

function asArray(value: unknown): any[] {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

function noteTexts(notes: unknown): string[] {
  return asArray(notes).map((note: any) => typeof note === 'string' ? note : note?.content).filter(Boolean)
}

function backCheckOf(item: PipelineItem): any {
  return item.backCheck || (item as any).backcheck || {}
}

function textOf(item: PipelineItem): string {
  const backCheck = backCheckOf(item)
  const products = asArray(backCheck.products || backCheck.mainProducts)
  const markets = asArray(backCheck.markets || backCheck.targetMarkets)
  const targetCustomers = asArray(backCheck.targetCustomers)
  return [
    item.company, item.title, item.website, item.snippet, item.contactName, item.country,
    backCheck.summary, backCheck.companyName, backCheck.tradeData,
    ...products, ...markets, ...targetCustomers, ...noteTexts((item as any).notes),
  ].filter(Boolean).join(' ').toLowerCase()
}

function splitEmails(email?: string): string[] {
  return (email || '').split(/[;,\s]+/).map(e => e.trim()).filter(e => e.includes('@'))
}

function isPublicEmail(email: string): boolean {
  const prefix = email.split('@')[0]?.toLowerCase().trim()
  if (!prefix) return false
  return PUBLIC_EMAIL_PREFIXES.has(prefix) || [...PUBLIC_EMAIL_PREFIXES].some(p => prefix.startsWith(`${p}.`) || prefix.startsWith(`${p}-`) || prefix.startsWith(`${p}_`))
}

function hasDecisionMaker(item: PipelineItem): boolean {
  const backCheck = backCheckOf(item)
  const makers = asArray(backCheck.decisionMakers)
  if (makers.some((m: any) => typeof m === 'string' ? m.trim() : (m?.email || m?.name))) return true
  const title = `${item.contactName || ''} ${(backCheck.summary || '')} ${(backCheck.verifiedContact || '')}`.toLowerCase()
  return /owner|founder|ceo|director|manager|buyer|purchase|purchasing|procurement|sourcing|import/.test(title)
}

function normalizedBusinessLine(item: PipelineItem): string {
  return String(item.businessLine || '').toLowerCase()
}

function hasStrongProductMatch(item: PipelineItem, allText: string): boolean {
  const line = normalizedBusinessLine(item)
  const terms = line.includes('car') || line.includes('seat') ? STRONG_CARSEAT_TERMS : STRONG_FURNITURE_TERMS
  return terms.some(t => allText.includes(t))
}

function isGiantOrClosedTarget(item: PipelineItem, allText: string): boolean {
  if (item.level === 'XL') return true
  if (/\b(1000\+|5000\+|10000\+|fortune 500|global leader)\b/.test(allText)) return true
  return getActiveProfile().signals.giantCompanyKeywords.some(k => allText.includes(k))
}

function countryText(item: PipelineItem): string {
  return (item.country || (item as any).region || '').toLowerCase()
}

// brazil/russia 归 tier3 市场（可开发但提示风险），不计入 -12 高风险扣分
function hasHighRegionRisk(item: PipelineItem): boolean {
  const country = countryText(item)
  return HIGH_RISK_COUNTRIES.filter(c => c !== 'brazil' && c !== 'russia').some(c => country.includes(c))
}

function gradeFromScore(score: number): LeadGrade {
  if (score >= 85) return 'S'
  if (score >= 70) return 'A'
  if (score >= 55) return 'B'
  if (score >= 35) return 'C'
  return 'D'
}

interface ModuleScores {
  authenticity: number
  businessMatch: number
  enterpriseValue: number
  risk: number
  reasons: string[]
}

// 四模块计分：真实性20 + 商业匹配40 + 企业价值30，缺失给0不扣分；仅风险模块扣分
function computeModuleScores(item: PipelineItem, allText: string): ModuleScores {
  const profile = getActiveProfile()
  const reasons: string[] = []
  const emails = splitEmails(item.email)
  const backCheck = backCheckOf(item)

  let authenticity = 0
  if (item.website) { authenticity += 5; reasons.push('Official website exists') }
  if (item.backCheck || (item as any).backcheck || item.backcheckStatus === 'done') { authenticity += 5; reasons.push('Backcheck data exists') }
  if (emails.length > 0) { authenticity += 5; reasons.push('Corporate email exists') }
  if (emails.some(e => !isPublicEmail(e))) { authenticity += 5; reasons.push('Has personal or non-generic email') }
  else if (emails.length > 0) reasons.push('Only generic email; find decision maker')

  let businessMatch = 0
  if (hasStrongProductMatch(item, allText)) { businessMatch += 10; reasons.push('Strong product match') }
  else if (normalizedBusinessLine(item)) { businessMatch += 5; reasons.push('Business line match needs more evidence') }
  if (/restaurant|hospitality|commercial dining|dining|booth|banquette/.test(allText)) { businessMatch += 10; reasons.push('Restaurant/hospitality furniture related') }
  if (profile.signals.importer.test(allText)) { businessMatch += 10; reasons.push('Importer signal (import capability)') }
  if (BUYER_TYPE_BONUS.has(item.clientType)) { businessMatch += 10; reasons.push('Buyer type fits outreach') }

  let enterpriseValue = 0
  if (hasDecisionMaker(item)) { enterpriseValue += 10; reasons.push('Decision maker signal') }
  if (item.level === 'S' || item.level === 'M') { enterpriseValue += 8; reasons.push('Company size is reachable') }
  if (item.level === 'L') { enterpriseValue += 3; reasons.push('Medium-large customer; longer cycle') }
  if (asArray(backCheck.products || backCheck.mainProducts).length > 0) { enterpriseValue += 5; reasons.push('Product catalog available') }
  if (countryText(item) || backCheck.location) { enterpriseValue += 4; reasons.push('Company location known') }

  let risk = 0
  if (isGiantOrClosedTarget(item, allText)) { risk += profile.scoringWeights.riskDeductions.giantCompany; reasons.push('Large group HQ / closed supply chain target') }
  if (profile.signals.exclusionPatterns.test(allText)) { risk += profile.scoringWeights.riskDeductions.governmentOrTender; reasons.push('Government/tender/public project exclusion') }
  if (profile.signals.certificationSignals.test(allText)) { risk += profile.scoringWeights.riskDeductions.mandatoryCertification; reasons.push('Mandatory certification project (FSC/BIFMA/ESG)') }
  if (item.clientType === 'manufacturer') { risk += profile.scoringWeights.riskDeductions.manufacturerPeer; reasons.push('Possible factory or peer supplier') }
  if (/lowest price|best price|cheapest|price only|quote.*best/i.test(allText)) { risk += profile.scoringWeights.riskDeductions.lowestPriceOnly; reasons.push('Only asks lowest price') }
  if (!item.website) { risk += profile.scoringWeights.riskDeductions.noWebsite; reasons.push('No website') }
  if (/personal use|individual buyer|single piece|one piece|homeowner/i.test(allText)) { risk += profile.scoringWeights.riskDeductions.personalBuyer; reasons.push('Personal buyer signal') }
  if (emails.length === 0) { risk += profile.scoringWeights.riskDeductions.noEmail; reasons.push('No email yet') }
  if (item.emailVerification === 'invalid') { risk += profile.scoringWeights.riskDeductions.invalidEmail; reasons.push('Invalid email') }
  if (hasHighRegionRisk(item)) { risk += profile.scoringWeights.riskDeductions.highRiskCountry; reasons.push('Region risk needs warning before outreach') }

  return { authenticity, businessMatch, enterpriseValue, risk, reasons }
}

export function scoreLead(item: PipelineItem): LeadScoreResult {
  const profile = getActiveProfile()
  const reasons: string[] = []
  const allText = textOf(item)
  const emails = splitEmails(item.email)

  if (item.status === 'archived' || item.developmentStatus === 'skipped') {
    return { grade: 'D', score: 0, reasons: ['Archived or skipped'] }
  }

  const modules = computeModuleScores(item, allText)
  reasons.push(...modules.reasons)
  let score = modules.authenticity + modules.businessMatch + modules.enterpriseValue + modules.risk

  // 市场优先级：tier1 加分 / tier2 次优先 / tier3 仅风险提示不扣分（unshift 保证不被 reasons 截断吞掉）
  const country = countryText(item)
  const marketTiers = profile.signals.marketTiers
  if (marketTiers.tier1.keywords.some(k => country.includes(k))) { score += marketTiers.tier1.bonus; reasons.unshift('Tier1 market (US/CA/AU)') }
  else if (marketTiers.tier2.keywords.some(k => country.includes(k))) { score += marketTiers.tier2.bonus; reasons.unshift('Tier2 secondary market') }
  else if (marketTiers.tier3.keywords.some(k => country.includes(k))) reasons.unshift(`Tier3 market: ${marketTiers.tier3.riskNote}`)

  // 客户类型优先级加分（profile 可开关）：default 不激活（applyCustomerTypeBonus=false），保证 default 评分零回归
  if (profile.applyCustomerTypeBonus) {
    const ct = String(item.clientType || (item as any).customerType || '').trim()
    const targetBonus = profile.targetTypePriority[ct]
    if (typeof targetBonus === 'number') {
      score += targetBonus
      reasons.unshift(`Target-type priority (${ct || 'unknown'})`)
    }
  }

  score = Math.max(0, Math.min(100, score))
  let grade = gradeFromScore(score)
  const directReady = emails.length > 0 && item.emailVerification === 'verified' && (item.backCheck || (item as any).backcheck || item.backcheckStatus === 'done') && hasDecisionMaker(item) && !isGiantOrClosedTarget(item, allText) && !hasHighRegionRisk(item)
  if (grade === 'S' && !directReady) grade = 'A'
  if (item.emailVerification === 'invalid') grade = 'D'
  if (GRADE_ORDER[grade] > GRADE_ORDER.B && !emails.length) grade = 'C'

  if (grade === 'S') reasons.unshift('S grade: ready for manual outreach approval')
  return { grade, score, reasons: reasons.slice(0, 6) }
}

export function withLeadScore(item: PipelineItem): PipelineItem {
  const result = scoreLead(item)
  const normalizedBackCheck = item.backCheck || (item as any).backcheck
  return {
    ...item,
    backCheck: normalizedBackCheck,
    backcheckStatus: normalizedBackCheck ? 'done' : item.backcheckStatus,
    leadGrade: result.grade,
    leadScore: result.score,
    leadScoreReasons: result.reasons,
    leadScoreUpdatedAt: new Date().toISOString(),
  }
}

export function sortByLeadGrade<T extends Pick<PipelineItem, 'leadGrade' | 'leadScore' | 'updatedAt'>>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const ga = GRADE_ORDER[a.leadGrade || 'D']
    const gb = GRADE_ORDER[b.leadGrade || 'D']
    if (ga !== gb) return ga - gb
    if ((b.leadScore || 0) !== (a.leadScore || 0)) return (b.leadScore || 0) - (a.leadScore || 0)
    return new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime()
  })
}