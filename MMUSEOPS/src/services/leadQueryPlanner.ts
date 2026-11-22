import { getActiveProfile } from './profiles'

export type LeadQueryChannel = 'web' | 'linkedin' | 'maps' | 'news' | 'gleif' | 'wikidata' | 'apify'
export type QueryProvider = 'justserp' | 'apify' | 'serper' | 'brave' | 'free'

export interface BuyerRole {
  id: string
  label: string
  query: string
  linkedinTitle: string
  reason: string
}

export interface PlannedLeadQuery {
  channelId: LeadQueryChannel
  provider: QueryProvider
  query: string
  role: BuyerRole
  fingerprint: string
}

export interface LeadQueryPlanInput {
  terms: string[]
  industry: string
  country: string
  city?: string
  channels: LeadQueryChannel[]
}

export interface ProviderBudgetInput {
  monthlyLimit: number
  used: number
  today?: Date
}

export interface QueryBudgetResult {
  executable: PlannedLeadQuery[]
  deferred: PlannedLeadQuery[]
  disabledProviders: QueryProvider[]
  dailyAllowance: Partial<Record<QueryProvider, number>>
}

export interface ExpandedProductTerm {
  term: string
  reason: string
}

const industryTermHints: Record<string, Array<{ match: RegExp; terms: string[]; reason: string }>> = {
  furniture: [
    { match: /booth|banquette|sofa/, terms: ['restaurant booth seating', 'banquette seating', 'commercial booth sofa'], reason: '商用家具的餐饮卡座与酒店软体家具常用叫法' },
    { match: /chair|table|dining/, terms: ['restaurant furniture', 'hospitality furniture', 'commercial dining furniture'], reason: '餐饮、酒店和商业空间采购常用行业词' },
    { match: /restaurant|hotel|cafe|hospitality|booth|chair|table|dining|furniture/, terms: ['restaurant furniture procurement', 'hotel renovation furniture', 'restaurant opening supplies', 'hospitality FF&E procurement', 'restaurant expansion furniture', 'cafe seating order'], reason: '买家采购意图/场景词：运营方开店、翻新、扩张与FF&E采购（term不含supplier词，避免被peerExclusions排除）' },
  ],
  'car-seat': [
    { match: /seat cover|car seat|auto seat/, terms: ['car seat covers', 'automotive seat covers', 'custom car seat covers'], reason: '汽车后市场和汽配渠道常用产品词' },
  ],
}

/** 纯泛词：无产品上下文，搜索会带回大量无关结果污染库 —— 命中后需行业+产品上下文限定 */
const GENERIC_TERM_PATTERN=/^(furniture|products?|supplier|manufacturer|factory|importer|import|export|distributor|wholesale|wholesaler|dealer|buyer|buyers|company|business|list|directory|retail|sales|goods|items?)$/i

export function expandProductTerms(terms: string[], industry: string): ExpandedProductTerm[] {
  const result: ExpandedProductTerm[] = []
  const add = (term: string, reason: string) => {
    const normalizedTerm = compact(term)
    if (!normalizedTerm || result.some(item => normalize(item.term) === normalize(normalizedTerm))) return
    result.push({ term: normalizedTerm, reason })
  }
  for (const term of terms) add(term, GENERIC_TERM_PATTERN.test(compact(term)) ? '泛词，需行业+产品上下文限定' : '中文关键词的英文直译结果')
  // 行业词提示：优先当前 profile 的 termHints，缺省回退 default 提示（default 行为不变）
  const hints = (getActiveProfile().termHints || {})[normalize(industry)] || industryTermHints[normalize(industry)] || []
  const hitAny = hints.some(hint => terms.some(term => hint.match.test(term.toLowerCase())))
  if (hints.length && !hitAny) {
    // 输入词未命中任何行业提示（如只有泛词）→ 注入该行业基础"行业+产品"组合，避免纯泛词查询
    for (const hint of hints) hint.terms.forEach(term => add(term, hint.reason))
  } else {
    for (const hint of hints) {
      if (terms.some(term => hint.match.test(term.toLowerCase()))) {
        hint.terms.forEach(term => add(term, hint.reason))
      }
    }
  }
  return result.slice(0, 12)
}
const giantExclusions = '-IKEA -Walmart -Amazon -Costco -Target -HomeDepot -Wayfair'
// 不在搜索入口排除 manufacturer/factory/supplier：部分真实终端客户同时生产并外采，交给背调做业务判定。
const peerExclusions = ''
/** B2B 平台/电商/名录域名 —— Google -site: 排除（仅 web 分支生效；不加社媒，优先最值钱的平台站） */
const platformSiteExclusions = [
  'alibaba.com', 'made-in-china.com', 'globalsources.com', 'dhgate.com',
  'tradewheel.com', 'tradeindia.com', 'indiamart.com', 'tradeimex.in',
  'amazon.com', 'ebay.com',
].map(d => `-${d}`).join(' ')

const genericRoles: BuyerRole[] = [
  { id: 'importer', label: '进口商', query: 'importer', linkedinTitle: 'import manager', reason: '直接进口和供应链采购需求较强' },
  { id: 'distributor', label: '分销商', query: 'distributor', linkedinTitle: 'distribution manager', reason: '有本地销售网络，适合长期供货' },
  { id: 'wholesaler', label: '批发商', query: 'wholesaler', linkedinTitle: 'purchasing manager', reason: '有稳定补货和批量采购需求' },
  { id: 'buyer', label: '采购商', query: 'procurement OR purchasing', linkedinTitle: 'procurement manager', reason: '直接对应采购决策岗位' },
]

const industryRoles: Record<string, BuyerRole[]> = {
  furniture: [
    { id: 'hotel-group', label: '酒店集团', query: 'hotel group renovation OR opening', linkedinTitle: 'hotel purchasing manager', reason: '酒店集团开店和翻新集中采购商用家具' },
    { id: 'restaurant-chain', label: '餐饮连锁', query: 'restaurant chain opening OR expansion', linkedinTitle: 'restaurant purchasing manager', reason: '连锁餐饮开店扩张有批量家具采购' },
    { id: 'cafe-franchise', label: '咖啡快消连锁', query: 'cafe franchise new store opening', linkedinTitle: 'cafe franchise operations manager', reason: '咖啡连锁新店开业采购座椅与餐桌' },
    { id: 'qsr', label: '快餐连锁', query: 'fast food chain renovation OR expansion', linkedinTitle: 'quick service restaurant purchasing', reason: '快餐连锁翻新和扩张持续采购耐用家具' },
    { id: 'hospitality', label: '酒店餐饮采购', query: 'hospitality procurement', linkedinTitle: 'hospitality procurement manager', reason: '商用家具常由酒店和餐饮项目集中采购' },
    { id: 'restaurant-group', label: '餐饮连锁', query: 'restaurant group purchasing', linkedinTitle: 'restaurant purchasing manager', reason: '连锁餐饮有开店和翻新采购周期' },
    { id: 'interior-contractor', label: '空间工程商', query: 'interior contractor', linkedinTitle: 'interior project manager', reason: '工程商会为餐饮和酒店项目配套采购' },
  ],
  'car-seat': [
    { id: 'auto-parts', label: '汽配分销商', query: 'automotive accessories distributor', linkedinTitle: 'automotive purchasing manager', reason: '汽车座椅套通常由汽配分销网络销售' },
    { id: 'aftermarket', label: '改装渠道', query: 'car accessories wholesaler', linkedinTitle: 'aftermarket buyer', reason: '改装和售后市场适合标准款与定制款' },
  ],
}

function compact(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function normalize(value: string): string {
  return compact(value).toLowerCase()
}

function providerFor(channel: LeadQueryChannel): QueryProvider {
  if (channel === 'apify') return 'apify'
  if (channel === 'gleif' || channel === 'wikidata') return 'free'
  return 'justserp'
}

function rolesFor(industry: string): BuyerRole[] {
  // 角色来源当前 profile（default 与 industryRoles/genericRoles 一致）
  const profile = getActiveProfile()
  const enhanced = profile.roles.industryRoles[normalize(industry)] || []
  const core = profile.roles.genericRoles.filter(r => r.id === 'importer' || r.id === 'distributor')
  return [...new Map([...enhanced, ...core].map(role => [role.id, role])).values()]
}

function makeQuery(channel: LeadQueryChannel, term: string, role: BuyerRole, country: string, city: string): string {
  const place = compact(city || country)
  if (channel === 'linkedin') return `"${term}" "${role.linkedinTitle}" ${country} site:linkedin.com/in`
  if (channel === 'maps') return `"${term}" ${role.query} ${place}`
  if (channel === 'news') return `"${term}" ${role.query} ${country} expansion OR opening OR project`
  if (channel === 'gleif' || channel === 'wikidata') return `"${term}" ${country}`
  if (channel === 'apify') return `"${term}" ${role.linkedinTitle} ${country}`
  // web 分支：在现有 giant/peer/platform 排除基础上追加当前 profile 的 excludeTerms（default 无追加，字符串不变）
  const extra = (getActiveProfile().excludeTerms || []).map(t => `-${t}`).join(' ')
  return extra
    ? `${term} ${role.query} ${country} ${giantExclusions} ${peerExclusions} ${platformSiteExclusions} ${extra}`
    : `${term} ${role.query} ${country} ${giantExclusions} ${peerExclusions} ${platformSiteExclusions}`
}

export function queryFingerprint(channelId: LeadQueryChannel, country: string, query: string): string {
  return `${channelId}|${normalize(country)}|${normalize(query)}`
}

export function planLeadQueries(input: LeadQueryPlanInput): PlannedLeadQuery[] {
  const terms = [...new Set(input.terms.map(compact).filter(Boolean))]
  const country = compact(input.country)
  const roles = rolesFor(input.industry)
  const result: PlannedLeadQuery[] = []

  for (const channelId of input.channels) {
    for (const term of terms) {
      for (const role of roles) {
        const query = makeQuery(channelId, term, role, country, input.city || '')
        result.push({ channelId, provider: providerFor(channelId), query, role, fingerprint: queryFingerprint(channelId, country, query) })
      }
    }
  }
  return result
}

function daysRemaining(today: Date): number {
  const end = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate()
  return Math.max(1, end - today.getDate() + 1)
}

export function applyQueryBudget(queries: PlannedLeadQuery[], budgets: Partial<Record<QueryProvider, ProviderBudgetInput>>): QueryBudgetResult {
  const dailyAllowance: Partial<Record<QueryProvider, number>> = {}
  const disabledProviders: QueryProvider[] = []

  for (const provider of Object.keys(budgets) as QueryProvider[]) {
    const budget = budgets[provider]
    if (!budget) continue
    const remaining = Math.max(0, budget.monthlyLimit - budget.used)
    dailyAllowance[provider] = Math.ceil(remaining / daysRemaining(budget.today || new Date()))
    if (dailyAllowance[provider] === 0) disabledProviders.push(provider)
  }

  const usedToday: Partial<Record<QueryProvider, number>> = {}
  const executable: PlannedLeadQuery[] = []
  const deferred: PlannedLeadQuery[] = []
  for (const query of queries) {
    const allowance = dailyAllowance[query.provider]
    const used = usedToday[query.provider] || 0
    if (allowance === undefined || used < allowance) {
      executable.push(query)
      usedToday[query.provider] = used + 1
    } else {
      deferred.push(query)
    }
  }
  return { executable, deferred, disabledProviders, dailyAllowance }
}

export function filterRepeatedQueries(queries: PlannedLeadQuery[], historyFingerprints: Iterable<string>): PlannedLeadQuery[] {
  const seen = new Set(historyFingerprints)
  return queries.filter(query => {
    if (seen.has(query.fingerprint)) return false
    seen.add(query.fingerprint)
    return true
  })
}

export function getBuyerRoles(industry: string): BuyerRole[] {
  return rolesFor(industry)
}
export interface RecommendedLeadQuery extends PlannedLeadQuery {
  score: number
}

export interface RecommendationOptions {
  offset?: number
  limit?: number
}

function roleMatchScore(industry: string, roleId: string): number {
  // 角色优先级分来自当前 profile（default 与原 priorities 一致）
  const priorities = getActiveProfile().rolePriority
  return priorities[normalize(industry)]?.[roleId] || 70
}

function channelRecommendationOrder(channelId: LeadQueryChannel): number {
  // 渠道推荐顺序来自当前 profile（default 与原 order 一致）
  const order = getActiveProfile().channelsOrder
  return order[channelId] ?? 99
}

export function recommendLeadQueries(
  queries: PlannedLeadQuery[],
  industry: string,
  options: RecommendationOptions = {},
): RecommendedLeadQuery[] {
  const limit = Math.max(1, options.limit || 5)
  const ranked = [...queries]
    .map((query, sourceIndex) => ({ ...query, score: roleMatchScore(industry, query.role.id), sourceIndex }))
    .sort((left, right) => {
      const channelDifference = channelRecommendationOrder(left.channelId) - channelRecommendationOrder(right.channelId)
      if (channelDifference !== 0) return channelDifference
      if (right.score !== left.score) return right.score - left.score
      return left.sourceIndex - right.sourceIndex
    })
    .map(({ sourceIndex: _sourceIndex, ...query }) => query)

  if (!ranked.length) return []

  // The first batch should cover distinct buyer roles before offering variants.
  const primary: RecommendedLeadQuery[] = []
  const seenRoles = new Set<string>()
  for (const query of ranked) {
    if (seenRoles.has(query.role.id)) continue
    seenRoles.add(query.role.id)
    primary.push(query)
  }
  const primaryFingerprints = new Set(primary.map(query => query.fingerprint))
  const recommendationPool = [...primary, ...ranked.filter(query => !primaryFingerprints.has(query.fingerprint))]
  const offset = Math.max(0, options.offset || 0) % recommendationPool.length
  const count = Math.min(limit, recommendationPool.length)
  return Array.from({ length: count }, (_, index) => recommendationPool[(offset + index) % recommendationPool.length])
}
