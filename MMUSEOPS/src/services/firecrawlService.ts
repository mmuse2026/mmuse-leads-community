/** Firecrawl AI 背调服务 — 通过本地搜索 API 代理调用 Firecrawl v2 提取 */
import type { BackCheckData, DecisionMaker, PipelineItem } from '../types/item'
import { saveItem } from '../store/db'
import { API_BASE } from './config'
import { applyAutomaticBackcheckResult, protectBackcheckDowngrade } from './backcheckAutoRouting'

export interface FirecrawlExtractResult {
  success: boolean
  preflight?: BackCheckData['preflight']
  data?: {
    json?: {
      companyName?: string
      mainProducts?: string[]
      targetCustomers?: string
      employeeCount?: string
      revenue?: string
      yearFounded?: string
      linkedinUrl?: string
      summary?: string
      decisionMakers?: { name: string; title: string }[]
      markets?: string[]
      language?: string
      location?: string
      industry?: string
    }
    markdown?: string
  }
  error?: string
  crawl?: { wordCount?: number; [key: string]: unknown }
}

/** 对公司网站进行 AI 背调，返回结构化数据
 *  支持任意输入: website / company+country / snippet / 任何可用信息
 *  核心通道: Crawl4AI (本地爬虫，无外部 API 依赖)
 *    有 website → Crawl4AI 直接抓 → LLM 提取
 *    无 website → Crawl4AI 搜引擎找官网 → 抓取 → LLM 提取
 *    搜不到   → LLM 用已有信息直接分析 */
export async function backcheckCompany(
  websiteUrl: string | undefined,
  prompt?: string,
  snippet?: string,
  title?: string,
  fallback?: { companyName?: string; country?: string; businessLine?: string },
): Promise<FirecrawlExtractResult & { sources?: Array<{ title: string; link: string; snippet: string }> }> {
  const companyName = fallback?.companyName || title
  const country = fallback?.country
  const businessLine = fallback?.businessLine

  // ---- 无 website 模式: Crawl4AI 公司名搜 → LLM 兜底 ----
  if (!websiteUrl) {
    if (!companyName) return { success: false, error: '缺少公司名(无 website 走兜底必须提供公司名)' }

    // 通道A: Crawl4AI 多引擎搜索(DDG→Bing→Google)
    try {
      const resp = await fetch(`${API_BASE}/api/crawl4ai-backcheck`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyName, country, snippet, businessLine }),
        signal: AbortSignal.timeout(180000), // 多引擎搜索需要更长时间
      })
      const result = await resp.json()
      if (result.success && result.data?.json) {
        return { ...result, companySearch: result.companySearch, resolvedUrl: result.companySearch?.resolvedUrl }
      }
      // Crawl4AI 搜到了 markdown 但 LLM 提取失败，尝试直接返回 markdown
      if (result.crawl?.wordCount > 0) {
        return { success: false, error: result.error || 'LLM 提取失败', crawl: result.crawl }
      }
    } catch { /* fallback */ }

    // 通道B: LLM 直接分析(用已有信息: company/country/snippet)
    try {
      const resp = await fetch(`${API_BASE}/api/llm-backcheck`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: undefined, snippet, title: companyName, company: companyName, country, businessLine }),
        signal: AbortSignal.timeout(60000),
      })
      return await resp.json()
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }

  // ---- 有 website 模式: Crawl4AI 直接抓 → LLM 兜底 ----
  const url = websiteUrl.startsWith('http') ? websiteUrl : 'https://' + websiteUrl

  // 通道1: Crawl4AI 直接抓取 (lightweight: fetch+cheerio 轻量抓取)
  try {
    const resp = await fetch(`${API_BASE}/api/crawl4ai-backcheck`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(90000),
    })
    const result = await resp.json()
    if (result.success && result.data?.json) return result
  } catch { /* fallback */ }

  // 通道1b: 轻量抓取失败（JS 渲染官网无正文）→ Playwright(crawl4ai engine) 重试
  try {
    const resp = await fetch(`${API_BASE}/api/crawl4ai-backcheck`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, engine: 'crawl4ai' }),
      signal: AbortSignal.timeout(30000),
    })
    const result = await resp.json()
    if (result.success && result.data?.json) return result
  } catch { /* fallback */ }

  // 通道2: LLM 直接分析(兜底)
  try {
    const resp = await fetch(`${API_BASE}/api/llm-backcheck`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, snippet, title, company: companyName, country, businessLine }),
    })
    return await resp.json()
  } catch (err: any) {
    return { success: false, error: err.message }
  }
}

/** 将 Firecrawl 提取结果转换为 PipelineItem 的 BackCheckData */
export function toBackCheckData(result: FirecrawlExtractResult): BackCheckData | null {
  if (!result.success || !result.data?.json) return null
  const j = result.data.json as any

  /** 清理编码问题字符（对任意入值安全：非字符串先转字符串，避免 .replace is not a function） */
  const clean = (s: unknown): string => {
    const str = typeof s === 'string' ? s : String(s ?? '')
    if (!str) return str
    return str.replace(/\?{2,}/g, '').replace(/\s+\?\s+/g, ' ').replace(/\s{2,}/g, ' ').trim()
  }

  /** 将任意值安全转为字符串数组：数组→逐项转字符串；单值(非空)→包装为单元素数组；否则→[] */
  const asStringArray = (v: unknown): string[] => {
    if (Array.isArray(v)) return v.map((x) => clean(x))
    if (v !== null && v !== undefined && String(v).trim() !== '') return [clean(v)]
    return []
  }

  const companyName = clean(j.companyName || j.company_name || j['Company Name'] || '')
  const mainProducts = asStringArray(j.mainProducts || j.main_products || j['Main Products'] || j.products)
  const targetCustomers = clean(j.targetCustomers || j.target_customers || j['Target Customers'] || j.targetCustomer || '')
  const employeeCount = clean(j.employeeCount || j.employee_count || j['Employee Count'] || j.employeeSize || j.teamSize || '')
  const revenue = clean(j.revenue || j['Revenue'] || j.annualRevenue || j.annual_revenue || '')
  const yearFounded = clean(j.yearFounded || j.year_founded || j['Year Founded'] || j.foundedYear || j.founded || '')
  const linkedinUrl = clean(j.linkedinUrl || j.linkedin_url || j['LinkedIn URL'] || j.linkedin || '')
  const summary = clean(j.summary || j['Summary'] || j.companySummary || j.company_summary || j.description || '')
  const decisionMakers = j.decisionMakers || j.decision_makers || j['Decision Makers'] || j.management || j.team || []
  const markets = asStringArray(j.markets || j['Markets'] || j.targetMarkets || j.target_markets)
  // 背调补强 T1：language=公司所用语言/官网语言，location=所在地（尽量城市/州），industry=明确行业
  const language = clean(j.language || j.languages || j.websiteLanguage || j.website_language || j['Language'] || '')
  const location = clean(j.location || j.locations || j.address || j.headquarters || j.headquarter || j['Location'] || '')
  const industry = clean(j.industry || j.sector || j.businessSector || j['Industry'] || '')
  return {
    checkedAt: new Date().toISOString(),
    preflight: result.preflight,
    employeeCount: employeeCount || undefined,
    revenue: revenue || undefined,
    yearFounded: yearFounded || undefined,
    linkedinUrl: linkedinUrl || undefined,
    products: Array.isArray(mainProducts) && mainProducts.length > 0 ? mainProducts : undefined,
    markets: Array.isArray(markets) && markets.length > 0 ? markets : undefined,
    summary: summary || undefined,
    language: language || undefined,
    location: location || undefined,
    industry: industry || undefined,
    decisionMakers: Array.isArray(decisionMakers) && decisionMakers.length > 0
      ? decisionMakers.map((d: any) => {
          const isObj = typeof d === 'object' && d !== null
          return {
            name: isObj ? String(d.name || '') : String(d ?? ''),
            title: isObj ? (d.title || d.position || d.role || undefined) : undefined,
            source: 'AI背调' as const,
          }
        })
      : undefined,
  }
}

export const MAX_BACKCHECK_ATTEMPTS = 4

function s(v: unknown): string { return String(v || '').trim() }
function arrOf(v: unknown): any[] { return Array.isArray(v) ? v : [] }

/** 计算背调证据缺口（国家/官网/来源/客户/业务/价值/摘要/动作 + 产品/行业/所在地/语言） */
export function computeBackcheckGaps(item: any): string[] {
  const country = s(item.country)
  const website = s(item.website || item.backCheck?.companyWebsite || item.sourceUrl)
  const sourceType = s(item.sourceType || item.source)
  const customerType = s(item.customerType || item.customerTypeAssessment || item.clientType)
  const businessMatch = s(item.businessMatch)
  const commercialValue = s(item.importCommercialValue)
  const summary = s(item.evidenceSummary || item.backCheck?.summary || item.researchSummary || item.backcheckReason)
  const products = arrOf(item.backCheck?.products).concat(arrOf(item.mainProducts))
  const industry = s(item.industry || item.backCheck?.industry)
  const location = s(item.location || item.backCheck?.location || item.city || item.state || item.region)
  const language = s(item.language || item.backCheck?.language || item.languages || arrOf(item.backCheck?.languages).join(' '))
  const recommendedAction = s(item.recommendedAction)
  const gaps: string[] = []
  if (!country || country === 'unknown') gaps.push('国家未知')
  if (!website) gaps.push('缺少官网')
  if (!sourceType) gaps.push('来源类型未知')
  if (!customerType) gaps.push('客户类型未知')
  if (!['high', 'medium', 'low', 'none'].includes(businessMatch)) gaps.push('业务匹配未知')
  if (!['high', 'medium', 'low', 'none'].includes(commercialValue)) gaps.push('商业价值未知')
  if (!summary || summary.length < 20) gaps.push('背调摘要不足')
  if (!recommendedAction) gaps.push('推荐动作未知')
  if (products.length === 0) gaps.push('产品未知')
  if (!industry) gaps.push('行业未知')
  if (!location) gaps.push('所在地未知')
  if (!language) gaps.push('语言未知')
  return gaps
}

/** 缺失字段集合（供二次补抓定位缺口类型） */
export function missingBackcheckFields(item: any): Set<string> {
  const set = new Set<string>()
  if (!s(item.website || item.backCheck?.companyWebsite)) set.add('website')
  if (arrOf(item.backCheck?.products).concat(arrOf(item.mainProducts)).length === 0) set.add('products')
  if (!s(item.language || item.backCheck?.language)) set.add('language')
  if (!s(item.location || item.backCheck?.location)) set.add('location')
  if (!s(item.industry || item.backCheck?.industry)) set.add('industry')
  if (!s(item.country) || s(item.country) === 'unknown') set.add('country')
  return set
}

/** 抓取官网 HTML 的 <html lang> 属性（轻量 fetch + 正则，无额外依赖） */
export async function extractHtmlLang(url: string): Promise<string> {
  try {
    const resp = await fetch(url.startsWith('http') ? url : `https://${url}`, { signal: AbortSignal.timeout(15000) })
    if (!resp.ok) return ''
    const html = await resp.text()
    const m = html.match(/<html[^>]*\blang=["']([a-zA-Z-]{1,10})["']/i)
    return m ? m[1] : ''
  } catch { return '' }
}

/** 无官网时按公司名找官网：优先本地 crawl4ai_backcheck.py（engine=crawl4ai 公司名搜索） */
async function findCompanyWebsite(companyName: string, country?: string, businessLine?: string): Promise<string> {
  try {
    const resp = await fetch(`${API_BASE}/api/crawl4ai-backcheck`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyName, country, businessLine, engine: 'crawl4ai' }),
      signal: AbortSignal.timeout(120000),
    })
    const result = await resp.json()
    if (result?.success && result?.companySearch?.resolvedUrl) return String(result.companySearch.resolvedUrl)
    return ''
  } catch { return '' }
}

/** 合并一次抓取结果到 item：只填空、只补缺失字段，不覆盖已有值 */
function mergeBackcheckIntoItem(item: any, data: any, rawJson: Record<string, unknown>, resolvedUrl?: string): { item: any; changed: boolean } {
  let changed = false
  const next = { ...item }
  const backCheck = { ...(next.backCheck || {}), ...(data || {}) }
  const pick = (...keys: string[]): string => { for (const k of keys) { const v = s(rawJson[k]); if (v) return v } return '' }
  if (resolvedUrl && !s(next.website)) { next.website = resolvedUrl; changed = true }
  const country = pick('country', 'country_region', 'region')
  if (country && (!s(next.country) || s(next.country) === 'unknown')) { next.country = country; changed = true }
  const language = pick('language', 'languages', 'websiteLanguage', 'website_language')
  if (language && !s(backCheck.language)) { backCheck.language = language; changed = true }
  if (language && !s(next.language)) { next.language = language; changed = true }
  const location = pick('location', 'address', 'headquarters', 'headquarter')
  if (location && !s(backCheck.location)) { backCheck.location = location; changed = true }
  if (location && !s(next.location)) { next.location = location; changed = true }
  const industry = pick('industry', 'sector', 'businessSector')
  if (industry && !s(backCheck.industry)) { backCheck.industry = industry; changed = true }
  if (industry && !s(next.industry)) { next.industry = industry; changed = true }
  const products = arrOf(data?.products)
  if (products.length > 0) {
    const existing = new Set(arrOf(backCheck.products).map((p: unknown) => s(p).toLowerCase()))
    const added = products.filter((p: unknown) => !existing.has(s(p).toLowerCase()))
    if (added.length > 0) { backCheck.products = [...arrOf(backCheck.products), ...added]; changed = true }
  }
  if (s(data?.summary) && !s(backCheck.summary)) { backCheck.summary = data.summary; changed = true }
  if (data?.companyWebsite && !s(backCheck.companyWebsite)) { backCheck.companyWebsite = data.companyWebsite; changed = true }
  // 'unknown' 占位值（老口径写入的非空占位）也视为可覆盖，否则真实值永远补不进来
  const unknownish = (v: unknown): boolean => { const t = s(v); return !t || t === 'unknown' || t === 'Unknown' }
  const customerType = pick('targetCustomers', 'target_customer', 'customerType')
  if (customerType && unknownish(next.customerType) && unknownish(next.customerTypeAssessment)) { next.customerTypeAssessment = customerType; changed = true }
  const recommendedAction = pick('recommendedAction', 'recommended_action')
  if (recommendedAction && unknownish(next.recommendedAction)) { next.recommendedAction = recommendedAction; changed = true }
  const businessMatch = pick('businessMatch', 'business_match')
  if (businessMatch && unknownish(next.businessMatch)) { next.businessMatch = businessMatch; changed = true }
  const importCommercialValue = pick('importCommercialValue', 'import_commercial_value', 'commercialValue')
  if (importCommercialValue && unknownish(next.importCommercialValue)) { next.importCommercialValue = importCommercialValue; changed = true }
  next.backCheck = backCheck
  return { item: next, changed }
}

/** 官网基准 URL（去尾部斜杠） */
function pickTargetUrl(website: string): string {
  const base = website.startsWith('http') ? website : `https://${website}`
  return base.replace(/\/+$/, '')
}

/**
 * 二次补抓引擎（供 backcheckAndSaveOne 与 backcheck-auto-consumer 复用）。
 * 一轮内最多做：一次完整首轮背调（无 backCheck 数据时）+ 针对性二次补抓：
 *   - 缺官网 → 按公司名找官网（crawl4ai_backcheck.py find_company_url 逻辑）
 *   - 缺产品/行业/所在地/语言/国家 → 抓官网（产品页/首页）→ LLM 提取
 *   - 缺语言 → 解析 <html lang> 属性 + LLM
 * attempts 达到上限（MAX_BACKCHECK_ATTEMPTS）不再抓，返回剩余 evidenceGaps，不抛错中断。
 */
export async function backfillBackcheckGaps(
  item: PipelineItem,
  now = new Date(),
): Promise<{ item: any; changed: boolean; resolvedUrl?: string; error?: string }> {
  const raw = item as any
  const attempts = Number(raw.backcheckAttempts || 0)
  if (attempts >= MAX_BACKCHECK_ATTEMPTS) return { item, changed: false, error: `backcheck attempts exhausted (${attempts}/${MAX_BACKCHECK_ATTEMPTS})` }
  if (!s(raw.website) && !s(raw.company)) return { item, changed: false, error: '无网站且无公司名，无法背调' }

  let current: any = { ...raw }
  let changed = false

  // Pass A: 完整首轮背调（无 backCheck 数据时）
  if (!current.backCheck || Object.keys(current.backCheck).length === 0) {
    const initial = await backcheckCompany(
      current.website,
      undefined,
      current.snippet,
      current.company,
      { companyName: current.company, country: current.country, businessLine: current.businessLine },
    )
    const data = toBackCheckData(initial)
    if (data) {
      const m = mergeBackcheckIntoItem(current, data, ((initial.data?.json) as Record<string, unknown>) || {}, (initial as any).resolvedUrl)
      current = m.item
      changed = m.changed || changed
    }
  }

  // Pass B: 针对性二次补抓
  const missing = missingBackcheckFields(current)
  if (missing.size > 0) {
    // 1. 缺官网 → 按公司名找官网
    if (missing.has('website') && s(current.company)) {
      const found = await findCompanyWebsite(current.company, current.country, current.businessLine)
      if (found) {
        current.website = found
        current.backCheck = { ...(current.backCheck || {}), companyWebsite: found }
        changed = true
      }
    }
    // 2. 缺产品/所在地/行业/语言/国家 → 抓官网再 LLM 提取
    if (s(current.website) && (missing.has('products') || missing.has('location') || missing.has('industry') || missing.has('language') || missing.has('country'))) {
      const r = await backcheckCompany(pickTargetUrl(current.website), undefined, undefined, current.company, {
        companyName: current.company, country: current.country, businessLine: current.businessLine,
      })
      const data = toBackCheckData(r)
      if (data) {
        const m = mergeBackcheckIntoItem(current, data, ((r.data?.json) as Record<string, unknown>) || {}, (r as any).resolvedUrl)
        current = m.item
        changed = m.changed || changed
      }
    }
    // 3. 缺语言 → 解析 <html lang> 属性
    if (missing.has('language') && s(current.website) && !s(current.language || current.backCheck?.language)) {
      const lang = await extractHtmlLang(current.website)
      if (lang && !s(current.language || current.backCheck?.language)) {
        current.language = lang
        current.backCheck = { ...(current.backCheck || {}), language: lang }
        changed = true
      }
    }
  }

  // Pass C: LLM 元信息兜底 —— 官网内容不足（404/无地址信息）或业务字段（匹配/价值）缺失时，基于公司名/域名/已有摘要推断仍缺的字段（businessMatch/importCommercialValue 不依赖网页内容，按公司名/域名即可推断）
  const gapsNow = computeBackcheckGaps(current)
  const llmFillable = gapsNow.filter((g) => g !== '缺少官网' && g !== '来源类型未知')
  if (llmFillable.length > 0 && s(current.company)) {
    try {
      const metaUrl = s(current.website) || s(current.backCheck?.companyWebsite) || undefined
      const resp = await fetch(`${API_BASE}/api/llm-backcheck`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: metaUrl,
          snippet: current.snippet,
          title: current.company,
          company: current.company,
          country: current.country,
          businessLine: current.businessLine,
          existingSummary: current.summary || current.evidenceSummary || current.backCheck?.summary || '',
          mainProducts: current.mainProducts || current.backCheck?.products || [],
        }),
        signal: AbortSignal.timeout(60000),
      })
      const result = await resp.json()
      if (result?.success && result.data?.json) {
        const m = mergeBackcheckIntoItem(current, toBackCheckData(result), result.data.json, undefined)
        current = m.item
        changed = m.changed || changed
      }
    } catch { /* 兜底失败不致命 */ }
  }

  // 收尾：重算 gaps / status / attempts
  const gaps = computeBackcheckGaps(current)
  current.backcheckAttempts = Math.min(MAX_BACKCHECK_ATTEMPTS, attempts + 1)
  current.evidenceGaps = gaps.length > 0 ? gaps : undefined
  current.backcheckStatus = gaps.length > 0 ? ('incomplete' as const) : ('done' as const)
  current.updatedAt = now.toISOString()
  return {
    item: current,
    changed,
    resolvedUrl: s(current.website) || s(current.backCheck?.companyWebsite) || undefined,
    error: gaps.length > 0 ? `剩余缺口: ${gaps.join('; ')}` : undefined,
  }
}

/** 对一个 PipelineItem 执行 AI 背调并保存结果到数据库
 *  无 website 时走"公司名搜官网"背调通道(复用 crawl4ai,后端 `/api/crawl4ai-backcheck --company`)
 *  有缺口 → 自动二次补抓(复用 backfillBackcheckGaps)，补完仍缺口 → 路由到 backcheck_queue 等待自动消费 */
export async function backcheckAndSaveOne(item: PipelineItem): Promise<{ ok: boolean; error?: string; resolvedUrl?: string }> {
  // 没 website 也允许跑：走公司名搜索兜底通道
  // 但至少有 company 才能背调
  if (!item.website && !item.company) return { ok: false, error: '无网站且无公司名,无法背调' }
  try {
    const now = new Date()
    const backfilled = await backfillBackcheckGaps(item, now)
    const enrichedItem: any = backfilled.item
    const resolvedUrl = backfilled.resolvedUrl
    const data = enrichedItem.backCheck || null

    const gaps = computeBackcheckGaps(enrichedItem)
    const evidenceGaps = gaps.length > 0 ? gaps : undefined

    // P0: 写回质量不降级保护 — 旧done不允许被incomplete/fail覆盖
    const protectedItem = protectBackcheckDowngrade(item, enrichedItem)
    const routed = applyAutomaticBackcheckResult(protectedItem, data, resolvedUrl, now)
    const savedStatus = protectedItem.backcheckStatus || (evidenceGaps ? ('incomplete' as const) : ('done' as const))
    const savedGaps = evidenceGaps
    const savedItem: any = { ...routed, backcheckStatus: savedStatus, evidenceGaps: savedGaps }

    // 补完仍缺口 → 路由到 backcheck_queue 等待自动消费（不硬拦，标注缺口）
    if (savedStatus === 'incomplete') {
      savedItem.primaryStage = 'backcheck_queue'
      savedItem.normalizedStage = 'backcheck_queue'
      savedItem.currentAllowedStage = 'backcheck_queue'
      savedItem.nextRequiredAction = '待背调自动补抓'
      savedItem.activeWorkflow = true
      savedItem.inactiveWorkflow = false
    }
    await saveItem(savedItem)
    return { ok: true, resolvedUrl }
  } catch (err: any) {
    return { ok: false, error: err.message }
  }
}

export interface BatchBackcheckProgress {
  total: number; done: number; success: number; failed: number; current: string
}

/** 对一批 PipelineItem 执行自动 AI 背调（并发限制 3 个） */
export async function batchBackcheckItems(
  items: PipelineItem[],
  onProgress?: (p: BatchBackcheckProgress) => void,
): Promise<BatchBackcheckProgress> {
  const progress: BatchBackcheckProgress = { total: items.length, done: 0, success: 0, failed: 0, current: '' }
  if (items.length === 0) return progress
  const CONCURRENCY = 3
  const queue = [...items]
  const workers: Promise<void>[] = []
  for (let w = 0; w < CONCURRENCY; w++) {
    workers.push((async () => {
      while (queue.length > 0) {
        const item = queue.shift()!
        progress.current = item.company
        onProgress?.({ ...progress })
        const { ok } = await backcheckAndSaveOne(item)
        if (ok) progress.success++; else progress.failed++
        progress.done++
        onProgress?.({ ...progress })
      }
    })())
  }
  await Promise.all(workers)
  progress.current = ''
  onProgress?.({ ...progress })
  return progress
}
