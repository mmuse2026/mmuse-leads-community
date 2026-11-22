/**
 * 数据不足自动补搜索触发（批次2 / 数据不足自动补搜索 T5）。
 *
 * 职责：全流程自动循环 —— 哪个环节数据不足，前面自动补充，不断流。本模块只做"触发判定 + 补搜索真正执行"，
 * 挖联系人 / 背调由各自消费函数处理，这里只返回已触发标记（不重复执行）：
 *   1. 搜索补充：每天最多补搜一轮（主公 2026-08-11 层水位差额补搜口径）——
 *      待发池 测试(A待发测试信+B可入队候选) 或 开发信(C=developable_email_pool+pending_draft_review+
 *      scheduled_send_queue) 任一 < minPoolSize（默认 100）才触发补搜；
 *      待发池均 ≥100 跳过本次补搜，不调 searchFn、不耗 API 额度。
 *      补搜量 = 缺口驱动 limit = min( max(0,100-测试池) + max(0,100-开发池), maxSearchPerTick )；
 *      当天已补搜（budget.lastCompletedAt 存在且 date=today）→ 当天不再补（completedToday 防重入），
 *      date 变化（次日）才重新扫描。
 *      A = test_mail_queue.json 中 status ∈ pending/scheduled/deferred/needs_reschedule 的记录数；
 *      B = email_validation_queue 中未入队(autoTestEnqueuedAt 空)、非隔离、有邮箱且 7 天内
 *          domain_mx_pass/dns_mx_ok 证据的可入队候选数。
 *      Serper 兜底另设每日限额（SERP_DAILY_LIMIT，默认 100），超限当天跳过、次日重置。
 *      保留 inProgress 防并发重复搜（STALE_SEARCH_MS 判卡死）+ 单 tick 入库上限（maxSearchPerTick，默认 20）防 API 爆量
 *      + 按域名去重防重复刷库。→ 用行业关键词按平台格式补精准行业公司入 items_store，
 *      新客靠 leadStageEligibility 自动路由到 backcheck_queue。
 *   2. 挖联系人：contact_mining_queue > 0 → 返回 'contact_mining'（已由 contact-mining-consumer 处理）。
 *   3. 背调补充：backcheck_queue > 0 → 返回 'backcheck'（已由 backcheck-auto-consumer 处理）。
 *
 * 存储解耦：本模块是纯触发/搜索逻辑，不直接 import server/items-store-atomic（避免把 server 的存量类型
 * 错误带进 src 的 tsc 检查图）。读库/入库通过 deps.readItems / deps.insertItem 注入：
 *   - server/refill-trigger-bootstrap.ts 提供真实 store 的默认接线（调度器批次末接入用）；
 *   - 冒烟测试注入 mock（隔离、不碰真实库）。
 *
 * 搜索封装说明：现有 server/search-api.ts 的 searchWithFallback / executeSearch 均为内联未导出且依赖 UI/服务端上下文，
 * 本模块提供最小可用封装（默认 searchFn）：复用 leadQueryPlanner 的关键词规划，直调 JustSerp（与 search-api.ts 同端点/同解析），
 * 不重写搜索逻辑。测试/独立运行时可通过 deps.searchFn 注入 mock。
 *
 * 预算持久化：data/refill_budget.json（可注入 budgetIO）。每个动作盖 stepperVersion + autoProcessedAt。
 */

import { applyEligibilityStage } from './leadStageEligibility'
import { planLeadQueries, recommendLeadQueries, filterRepeatedQueries, type PlannedLeadQuery } from './leadQueryPlanner'
import { getActiveProfile, resolveSearchTerms } from './profiles'
import { isAggregatorDomain } from './aggregatorDomains'
import { normalizeDomain } from './emailQualityPolicy'
import { classifySearchSource } from './searchResultPolicy'
import { isIsolatedItem } from './itemIsolation'
import { JustSerpHttpError, SerperHttpError, normalizeJustSerpKeys, normalizeSerperKeys, runWithJustSerpKeyPool, runWithSerperKeyPool } from './justSerpKeyPool'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const CONFIG_FILE = join(__dirname, '..', '..', 'user_config.json')
const ENV_FILE = join(__dirname, '..', '..', '.env.json')
const DEFAULT_BUDGET_FILE = join(__dirname, '..', '..', 'data', 'refill_budget.json')
const TEST_MAIL_QUEUE_FILE = join(__dirname, '..', '..', 'data', 'test_mail_queue.json')

export interface RefillCompany {
  company: string
  website: string
  domain?: string
  title?: string
  snippet?: string
  country?: string
}

export interface RefillBudgetState {
  key: string
  date: string
  used: number
  dailyBudget: number
  inProgress: boolean
  startedAt?: string
  lastCompletedAt?: string
  lastSearchAt?: string
  searchMetrics?: {
    raw: number
    duplicate: number
    filtered: number
    inserted: number
    lastRunAt: string
    nextRunAt: string
  }
  /** 2026-08-14 轮换：当前轮换到的市场下标（下次补搜用下一个市场，默认 0） */
  marketIndex?: number
  /** 2026-08-14 轮换：已用查询指纹（防重复，超过上限裁剪），持久化到预算文件 */
  usedQueryFingerprints?: string[]
}

export interface RefillBudgetIO {
  read(): RefillBudgetState
  write(state: RefillBudgetState): void
}

export interface RefillSearchInput {
  industry: string
  country: string
  terms?: string[]
  limit: number
  /** 2026-08-14 轮换：已用查询指纹，跳过重复查询（defaultSearchFn 消费） */
  skipQueryFingerprints?: string[]
  /** 本次实际执行的查询指纹（defaultSearchFn 填充，runRefillCheck 持久化） */
  usedQueryFingerprints?: string[]
}

export interface RefillSearchFn {
  (input: RefillSearchInput): Promise<RefillCompany[]>
}

export interface RefillInsertResult {
  ok: boolean
  error?: string
}

export interface RefillCheckDeps {
  /** 读全量 items（primaryStage 已标好）。生产接线见 server/refill-trigger-bootstrap.ts */
  readItems: () => any[]
  /** 新客入库（调用方负责原子写 + revision，推荐 updateOneItemAtomic allowCreate） */
  insertItem: (item: any) => Promise<RefillInsertResult>
  /** 覆盖当前时间 */
  now?: Date
  /** stepper 版本戳（盖到新入池的项上） */
  version?: string
  /** 触发阈值：待发池 A(待发测试信)+B(可入队候选) < minPoolSize 才补搜（默认 100） */
  minPoolSize?: number
  /** 覆盖 data/test_mail_queue.json 路径（测试/独立库用） */
  testMailQueuePath?: string
  /** 每批最多补入的新客条数（默认 10，全市场合计） */
  maxSearchPerTick?: number
  /** 每日补搜索次数上限（已停用：主公 2026-08-09 拍板不限，保留仅作统计写入） */
  dailySearchBudget?: number
  /** 补搜索冷却时长（已停用：主公 2026-08-09 拍板不限） */
  cooldownMs?: number
  /** 搜索日预算键（记录到预算文件，默认 'refill_search_daily'） */
  searchBudgetKey?: string
  /** 预算持久化文件路径（默认 data/refill_budget.json） */
  budgetStorePath?: string
  /** 目标行业（默认 'furniture'，car-seat 自动切换） */
  industry?: string
  /** 当前产品项目标识；写入新客户，供后续消费者隔离项目范围。 */
  projectId?: string
  /** 本轮搜索批次标识；试运行/定向批次用，防止消费者扫到全局旧池。 */
  runBatchId?: string
  /** 目标国家（默认 'US'） */
  country?: string
  /** 2026-08-14 轮换：目标市场轮换列表（默认 SEARCH_MARKETS，测试可覆盖） */
  markets?: string[]
  /** 行业关键词覆盖（默认按行业取词表） */
  terms?: string[]
  /** 搜索函数注入（测试可传 mock，避免真实 API/预算） */
  searchFn?: RefillSearchFn
  /** 预算读写注入（测试可传内存 mock） */
  budgetIO?: RefillBudgetIO
  /** 阶段重算注入（默认 applyEligibilityStage，无 ctx 即可路由新客到 backcheck_queue） */
  applyStageFn?: (item: any, now: Date) => { item: any; changed: boolean }
  /** 上层巡检可读的错误槽（本函数只写，不抛） */
  lastError?: Record<string, unknown>
}

const DEFAULT_VERSION = 'refill-trigger-v1'
/** 待发池目标水位：待发测试信(A) + 可入队候选(B) < 100 才补搜（主公 2026-08-11 口径） */
const DEFAULT_TEST_POOL_TARGET = 100
/** 待发测试信状态（test_mail_queue 记录 status 属于这些即算在池内） */
const TEST_POOL_QUEUE_STATUSES = new Set(['pending', 'scheduled', 'deferred', 'needs_reschedule'])
/** 开发信待发池状态（items 的 primaryStage 属于这些即算在池内，主公 2026-08-11 层水位口径） */
const DEV_POOL_STAGES = new Set(['developable_email_pool', 'pending_draft_review', 'scheduled_send_queue'])
/** B 判定窗口：7 天内的 domain_mx_pass/dns_mx_ok 证据（与 testmail-enqueue-consumer 一致） */
const RECENT_DNS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
/** 每 tick 入库新客上限（防单次 JustSerp 爆量；主公"不限制数量"=不设总量/每日次数/冷却限制） */
const DEFAULT_MAX_SEARCH_PER_TICK = 10
const DEFAULT_DAILY_SEARCH_BUDGET = 999999
const DEFAULT_COOLDOWN_MS = 0
const DEFAULT_SEARCH_BUDGET_KEY = 'refill_search_daily'
/** 预算文件里 inProgress 超过该时长判为上次搜索卡死，允许重新触发 */
const STALE_SEARCH_MS = 30 * 60 * 1000
const SEARCH_INTERVAL_MS = 30 * 60 * 1000
/** Serper 每日调用上限（主公 2026-08-11：Serper 相对精准但额度也要保护，超限当天跳过、次日重置） */
const SERP_DAILY_LIMIT = 100
/** Serper 预算键（写入独立文件 refill_budget_serper.json，避免与 refill_search_daily 共享单对象文件互相覆盖） */
const SERP_BUDGET_KEY = 'refill_serper_daily'
const SERP_BUDGET_FILE = join(__dirname, '..', '..', 'data', 'refill_budget_serper.json')
/** 补搜目标市场轮换列表（2026-08-16 主公策略：避开欧美——美国关税高、资质要求多，欧盟包装要求高；
 *  重点开发南美/拉美 + 澳新加 + 墨西哥，东南亚（新加坡/马来西亚等）确认可开发（给钱就做），海湾/亚太其余保留；
 *  市场按优先级排列，marketIndex 从列表头开始轮换，重点市场先被搜） */
export const SEARCH_MARKETS = [
  // 重点开发：南美/拉美
  'MX', 'BR', 'CL', 'PE', 'CO', 'AR',
  // 重点开发：澳新加
  'AU', 'NZ', 'CA',
  // 东南亚（主公确认可开发，给钱就做）
  'SG', 'MY', 'TH', 'ID', 'VN', 'PH',
  // 亚太其他（保留）
  'JP', 'KR',
  // 海湾（保留）
  'AE', 'SA', 'QA', 'KW',
  // 非洲（主公确认可开发）
  'ZA', 'NG', 'KE', 'EG', 'GH', 'MA', 'TZ',
]

function stageOf(item: any): string {
  return String(item?.primaryStage || item?.normalizedStage || '')
}

/** 待发池 A：test_mail_queue.json 中 status 属于待发集合的记录数。读失败/解析异常记 0，不中断补搜。 */
function countTestQueuePending(queuePath: string): number {
  try {
    if (!existsSync(queuePath)) return 0
    const store = JSON.parse(readFileSync(queuePath, 'utf-8')) as { records?: Array<{ status?: string }> }
    const records = Array.isArray(store?.records) ? store.records : []
    return records.filter(r => r && TEST_POOL_QUEUE_STATUSES.has(String(r.status || ''))).length
  } catch {
    return 0
  }
}

/** 7 天内、且 result 为 domain_mx_pass/dns_mx_ok 的 evidence 判定（内联复现 server/testmail-enqueue-consumer 的
 *  recentDnsPassEvidence，src 纯模块不 import server）。 */
function hasRecentDnsPassEvidence(item: any, email: string, now: Date, windowMs: number): boolean {
  const evidence = Array.isArray(item?.emailVerificationEvidence) ? item.emailVerificationEvidence : []
  return evidence.some((e: any) => {
    if (!e) return false
    if (String(e.email || e.recipientEmail || '').trim().toLowerCase() !== email) return false
    const result = String(e.result || '')
    if (result !== 'domain_mx_pass' && String(e.rawResult || '') !== 'dns_mx_ok' && !/domain_mx_pass|dns_mx_ok/i.test(result)) return false
    const t = Date.parse(String(e.checkedAt || ''))
    if (!Number.isFinite(t)) return false
    return now.getTime() - t < windowMs
  })
}

/** 待发池 B：email_validation_queue 中未入队、非隔离、有邮箱且 7 天内 domain_mx_pass 证据的可入队候选数。 */
function countEnqueueableCandidates(items: any[], now: Date): number {
  let count = 0
  for (const it of items) {
    if (stageOf(it) !== 'email_validation_queue') continue
    if (it?.autoTestEnqueuedAt) continue
    if (isIsolatedItem(it)) continue
    const email = String(it?.selectedEmail || it?.email || '').trim().toLowerCase()
    if (!email) continue
    if (hasRecentDnsPassEvidence(it, email, now, RECENT_DNS_WINDOW_MS)) count++
  }
  return count
}

/** 待发池 C：开发信待发池 = developable_email_pool + pending_draft_review + scheduled_send_queue 的数量 */
function countDevPool(items: any[]): number {
  let count = 0
  for (const it of items) if (DEV_POOL_STAGES.has(stageOf(it))) count++
  return count
}

function defaultBudgetState(): RefillBudgetState {
  return { key: '', date: '', used: 0, dailyBudget: DEFAULT_DAILY_SEARCH_BUDGET, inProgress: false, marketIndex: 0, usedQueryFingerprints: [] }
}

function createDefaultBudgetIO(path: string): RefillBudgetIO {
  return {
    read() {
      try {
        if (!existsSync(path)) return defaultBudgetState()
        const raw = readFileSync(path, 'utf-8')
        return { ...defaultBudgetState(), ...(JSON.parse(raw) as Partial<RefillBudgetState>) }
      } catch {
        return defaultBudgetState()
      }
    },
    write(state) {
      try {
        const dir = dirname(path)
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        writeFileSync(path, JSON.stringify(state, null, 2), 'utf-8')
      } catch { /* 预算写失败不中断 */ }
    },
  }
}

function loadJustserpKeys(): string[] {
  const values: unknown[] = [process.env.JUSTSERP_API_KEY, process.env.JUSTSERP_API_KEY_2]
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as Record<string, unknown>
    values.push(cfg.justserpApiKey, cfg.justserpApiKey2)
    if (Array.isArray(cfg.justserpApiKeys)) values.push(...cfg.justserpApiKeys)
  } catch { /* ignore */ }
  try {
    const env = JSON.parse(readFileSync(ENV_FILE, 'utf-8')) as Record<string, unknown>
    values.push(env.justserp_api_key, env.justserp_api_key_2)
  } catch { /* ignore */ }
  return normalizeJustSerpKeys(values)
}

function loadTavilyApiKey(): string {
  if (process.env.TAVILY_API_KEY) return process.env.TAVILY_API_KEY
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as Record<string, unknown>
    if (cfg.tavilyApiKey) return String(cfg.tavilyApiKey)
  } catch { /* ignore */ }
  try {
    const env = JSON.parse(readFileSync(ENV_FILE, 'utf-8')) as Record<string, unknown>
    if (env.tavily_api_key) return String(env.tavily_api_key)
  } catch { /* ignore */ }
  return ''
}

function loadSerperApiKeys(): string[] {
  const values: unknown[] = [process.env.SERPER_API_KEY, process.env.SERPER_API_KEY_2]
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as Record<string, unknown>
    values.push(cfg.serperApiKey, cfg.serperApiKey2)
    if (Array.isArray(cfg.serperApiKeys)) values.push(...cfg.serperApiKeys)
  } catch { /* ignore */ }
  try {
    const env = JSON.parse(readFileSync(ENV_FILE, 'utf-8')) as Record<string, unknown>
    values.push(env.serper_api_key, env.serper_api_key_2)
  } catch { /* ignore */ }
  return normalizeSerperKeys(values)
}

function defaultTermsFor(industry: string): string[] {
  // 主攻搜索词来自当前 profile 的 searchTerms（default 与历史词库完全一致）
  return resolveSearchTerms(getActiveProfile(), industry)
}

async function searchJustSerpLocal(
  query: string,
  apiKey: string,
  country: string,
): Promise<Array<{ title: string; link: string; snippet: string }>> {
  const resp = await fetch('https://api.justserp.com/v1/search', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, gl: String(country || 'US').toLowerCase(), hl: 'en', num: 20 }),
    signal: AbortSignal.timeout(30000),
  })
  if (!resp.ok) throw new JustSerpHttpError(resp.status)
  const data = (await resp.json().catch(() => ({}))) as {
    organic_results?: Array<{ title: string; link: string; description: string }>
  }
  return (data.organic_results || []).map(r => ({ title: r.title || '', link: r.link || '', snippet: r.description || '' }))
}

async function searchTavilyLocal(
  query: string,
  apiKey: string,
  country: string,
): Promise<Array<{ title: string; link: string; snippet: string }>> {
  const resp = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query, max_results: 20, search_depth: 'basic', exclude_domains: TAVILY_EXCLUDE_DOMAINS }),
    signal: AbortSignal.timeout(30000),
  })
  if (!resp.ok) throw new SerperHttpError(resp.status)
  const data = (await resp.json().catch(() => ({}))) as {
    results?: Array<{ url: string; title: string; content: string }>
  }
  return (data.results || []).map(r => ({ title: r.title || '', link: r.url || '', snippet: r.content || '' }))
}

async function searchSerperLocal(
  query: string,
  apiKey: string,
  country: string,
): Promise<Array<{ title: string; link: string; snippet: string }>> {
  const resp = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, num: 20, gl: String(country || 'US').toLowerCase() }),
    signal: AbortSignal.timeout(30000),
  })
  if (!resp.ok) return []
  const data = (await resp.json().catch(() => ({}))) as {
    organic?: Array<{ title: string; link: string; snippet: string }>
  }
  return (data.organic || []).map(r => ({ title: r.title || '', link: r.link || '', snippet: r.snippet || '' }))
}

function extractCompanyName(title: string, host: string): string {
  const clean = String(title || '').split('|')[0]?.trim()
  if (clean) return clean.slice(0, 120)
  const parts = String(host || '').split('.')
  return parts[0] || host
}

export async function collectSearchResults(
  planned: Array<{ query: string }>,
  searchFn: (q: string) => Promise<Array<{ title: string; link: string; snippet: string }>>,
  input: RefillSearchInput,
  control: { beforeSearch?: () => boolean; onSearchAttempt?: () => void } = {},
): Promise<RefillCompany[]> {
  const found: RefillCompany[] = []
  const seen = new Set<string>()
  for (const query of planned) {
    if (control.beforeSearch && !control.beforeSearch()) break
    const items = await searchFn(query.query).catch(() => [])
    control.onSearchAttempt?.()
    for (const item of items) {
      const url = String(item.link || '').replace(/\/$/, '')
      if (!url) continue
      let host = ''
      try { host = new URL(url).hostname.replace(/^www\./, '') } catch { continue }
      if (seen.has(host)) continue
      seen.add(host)
      found.push({
        company: extractCompanyName(item.title, host),
        website: url,
        domain: host,
        title: item.title,
        snippet: item.snippet,
        country: input.country,
      })
    }
  }
  return found
}

/**
 * 补搜噪音过滤（2026-08-10 主公拍板：Tavily 降级后噪音多，query 加限定词 + 入库前过滤）。
 * FURNITURE_TERMS：行业词白名单，title/website/snippet 含任一即视为家具相关保留。
 * NOISE_DOMAIN_PATTERNS：高置信噪音域名/URL 特征，命中即噪音（小写匹配）。
 */
const FURNITURE_TERMS = [
  'furniture', 'chair', 'table', 'seating', 'banquet', 'dining', 'desk', 'stool',
  'lounge', 'cabinet', 'sofa', 'upholst', 'bistro', 'office', 'commercial', 'contract',
  'patio', 'outdoor', 'bench', 'trestle', 'furnishing', 'cafe', 'counter', 'barstool',
  'kitchen', 'catering', 'banquet',
  // 2026-08-14 追加：运营商买家行业词（酒店/餐厅/连锁），否则真实买家在末尾"保守判噪音"被误滤
  'hotel', 'restaurant', 'resort', 'hospitality', 'motel', 'food service', 'franchise', 'chain',
]

/** Tavily exclude_domains：B2B 平台/电商/名录域名（Tavily 是语义搜索，query 里 -site: 无效，必须靠该参数排除） */
const TAVILY_EXCLUDE_DOMAINS = [
  'alibaba.com', 'made-in-china.com', 'globalsources.com', 'dhgate.com',
  'tradewheel.com', 'tradeindia.com', 'indiamart.com', 'tradeimex.in',
  'amazon.com', 'ebay.com',
]

const NOISE_DOMAIN_PATTERNS = [
  'wikipedia', 'wiki', 'dictionary', 'merriam', 'webster', 'cambridge', 'thefreedictionary',
  'encyclopedia', 'wikihow', 'reddit', 'quora', 'huaren', 'expedia', 'tripadvisor', 'vrbo',
  'airbnb', 'bestwestern', 'cruise', 'summitclimb', '10times', 'eventbrite', 'spie', 'linkedin',
  'houzz', 'alibaba', 'made-in-china', 'globalsources', 'autods', 'shopperoo', 'the-sun',
  'businessinsider', 'tastingtable', 'consumeredge', 'disney', 'msccruises', 'celebritycruises',
  'oralgos',
]

/**
 * 2026-08-14 新增：内容型站点域名（招聘/新闻/媒体/点评/博客/指南）——命中即噪音。
 * 必须在家具词判定之前，否则 FURNITURE_TERMS 里的 banquet/catering/dining 会先放行招聘与新闻标题。
 */
const CONTENT_NOISE_DOMAIN_PATTERNS = [
  'bebee', 'indeed', 'glassdoor', 'ziprecruiter', 'monster', 'careerbuilder', 'simplyhired', 'workable', 'recruiter',
  'eater', 'restaurantnews', 'foodservicenews', 'foodandwine', 'seriouseats', 'foodnetwork', 'allrecipes', 'bonappetit', 'thespruce', 'tasteofhome', 'nrn', 'reuters', 'apnews', 'cnn', 'nytimes', 'wsj', 'theguardian', 'huffpost', 'usatoday', 'cnbc', 'bloomberg', 'latimes', 'forbes',
  'yelp', 'zomato', 'opentable', 'grubhub', 'doordash', 'restaurantguru',
  'medium', 'substack', 'wordpress', 'blogspot', 'tumblr', 'buzzfeed', 'howstuffworks', 'totalfood', 'chowhound',
  // 2026-08-14 GB 轮补充：社媒平台主题页/聚合页（snapchat 主题页等非公司实体）
  'snapchat', 'tiktok', 'instagram', 'facebook', 'youtube', 'pinterest',
]

/** 内容型标题/URL 特征（招聘/指南/文章）——命中即噪音。不包含 best/top 等宽泛词（会误伤 Best Western 等真实品牌）。 */
const CONTENT_TITLE_PATTERN = /\b(server|driver|waiter|bartender|hiring|job|jobs|career|apply now|salary|how to|guide|recipe|review of|best of)\b|\/(blog|article|news|recipe|how-to|guide)\//i

/**
 * 噪音判定：cand 形如 { title, link, snippet }。
 * link 域名命中 aggregatorDomains 全库（30+ 域名 + 子域名后缀匹配）→ 噪音（最确定，放最前）；
 * 否则 link 或 title 小写命中任一 NOISE_DOMAIN_PATTERNS → 噪音；
 * 否则 title+link+snippet 小写命中任一 FURNITURE_TERMS → 保留；
 * 都不中 → 保守判噪音（宁可隔离，不错放噪音）。
 */
function isNoiseCandidate(cand: { title?: string; link?: string; snippet?: string }): boolean {
  if (cand.link && isAggregatorDomain(cand.link)) return true
  const title = String(cand.title || '').toLowerCase()
  const link = String(cand.link || '').toLowerCase()
  if (NOISE_DOMAIN_PATTERNS.some(p => link.includes(p) || title.includes(p))) return true
  // 内容型站点/招聘/新闻/指南 → 噪音（须在 FURNITURE_TERMS 之前判定，否则 banquet 等词先放行）
  if (CONTENT_NOISE_DOMAIN_PATTERNS.some(p => link.includes(p) || title.includes(p))) return true
  if (CONTENT_TITLE_PATTERN.test(title) || CONTENT_TITLE_PATTERN.test(link)) return true
  const snippet = String(cand.snippet || '').toLowerCase()
  const haystack = `${title}\n${link}\n${snippet}`
  if (FURNITURE_TERMS.some(t => haystack.includes(t))) return false
  return true
}

/** 过滤掉 isNoiseCandidate 判为噪音的候选，返回干净数组。兼容 RefillCompany[]（website/domain）与原始 {link} 两种形状。 */
function filterSearchResults<T extends { title?: string; link?: string; website?: string; domain?: string; sourceUrl?: string; snippet?: string }>(results: T[]): T[] {
  return results.filter(r => {
    const cand = {
      title: r.title || '',
      link: r.link || r.website || r.sourceUrl || r.domain || '',
      snippet: r.snippet || '',
    }
    return !isNoiseCandidate(cand)
  })
}

export async function defaultSearchFn(input: RefillSearchInput): Promise<RefillCompany[]> {
  const justserpKeys = loadJustserpKeys()
  const terms = input.terms?.length ? input.terms : defaultTermsFor(input.industry)
  // 2026-08-14 换词修复：先从全查询池过滤已用指纹（跨市场），再 recommend 前 limit。
  // 原来先 recommend 截断到 3 再过滤 → 第二次搜同市场时这 3 个全被 skip 后回退到同样的 3 个，
  // 换不了词、反复搜同一批人。改为过滤后再推荐，每次都能选出未用过的新查询。
  const allPlanned = planLeadQueries({ terms, industry: input.industry, country: input.country, channels: ['web'] })
  const fresh = input.skipQueryFingerprints?.length ? filterRepeatedQueries(allPlanned, input.skipQueryFingerprints) : allPlanned
  const pool = fresh.length ? fresh : allPlanned // 全被跳过则回退全量（历史重置，开始新一轮）
  const planned: PlannedLeadQuery[] = recommendLeadQueries(
    pool,
    input.industry,
    { limit: Math.max(1, Math.min(3, input.limit)) },
  )
  // 记录本次实际执行的查询指纹（供 runRefillCheck 持久化到 budget，下次补搜跳过）
  if (Array.isArray(input.usedQueryFingerprints)) {
    for (const q of planned) input.usedQueryFingerprints.push(q.fingerprint)
  }
  // JustSerp 优先：完整跑一遍（保持原有逻辑不动）。结果为空说明通道挂了（如额度耗尽 429），整体降级到 Tavily。
  const justserpResults = justserpKeys.length > 0
    ? await collectSearchResults(
        planned,
        async (q) => {
          const attempt = await runWithJustSerpKeyPool(justserpKeys, key => searchJustSerpLocal(q, key, input.country))
          return attempt.ok ? attempt.value : []
        },
        input,
      )
    : []
  // 2026-08-10 主公拍板：JustSerp/Tavily 聚合去重后统一过噪音过滤（JustSerp 恢复后也过滤）。
  // JustSerp 全被滤空（无有效结果）时同样降级到 Tavily，避免只返回噪音。
  const justserpClean = filterSearchResults(justserpResults)
  if (justserpClean.length > 0) return justserpClean
  const tavilyKey = loadTavilyApiKey()
  if (tavilyKey) {
    // Tavily 降级：query 追加 ' wholesale supplier' 聚焦采购意图（仅 Tavily 分支，不影响 JustSerp）。
    const tavilyResults = await collectSearchResults(
      planned,
      (q) => searchTavilyLocal(`${String(q)} wholesale supplier`, tavilyKey, input.country),
      input,
    )
    const tavilyClean = filterSearchResults(tavilyResults)
    if (tavilyClean.length > 0) return tavilyClean
  }
  // Serper 兜底：JustSerp/Tavily 均无有效结果时最后尝试 Serper（2026-08-10 主公新增备用通道）。
  // Serper 每日限额（2026-08-11 主公：Serper 相对精准但额度也要保护）——当日调用 >= SERP_DAILY_LIMIT 直接跳过，
  // 不调 API；按日期切换次日重置。仅限制 Serper，不影响 JustSerp/Tavily 降级链。
  const serperKeys = loadSerperApiKeys()
  if (serperKeys.length === 0) return []
  const serperBudgetIO = createDefaultBudgetIO(SERP_BUDGET_FILE)
  const serperBudget = serperBudgetIO.read()
  const today = new Date().toISOString().slice(0, 10)
  const serperUsedToday = serperBudget.key === SERP_BUDGET_KEY && serperBudget.date === today ? serperBudget.used : 0
  if (serperUsedToday >= SERP_DAILY_LIMIT) return []
  let serperRequestCount = 0
  const serperResults = await collectSearchResults(
    planned,
    async (q) => {
      const attempt = await runWithSerperKeyPool(serperKeys, key => searchSerperLocal(q, key, input.country))
      return attempt.ok ? attempt.value : []
    },
    input,
    {
      beforeSearch: () => serperUsedToday + serperRequestCount < SERP_DAILY_LIMIT,
      onSearchAttempt: () => { serperRequestCount++ },
    },
  )
  if (serperRequestCount > 0) {
    serperBudgetIO.write({
      ...serperBudget,
      key: SERP_BUDGET_KEY,
      date: today,
      dailyBudget: SERP_DAILY_LIMIT,
      used: serperUsedToday + serperRequestCount,
    })
  }
  return filterSearchResults(serperResults)
}

function stamp(item: any, version: string, now: Date): any {
  return { ...item, stepperVersion: version, autoProcessedAt: now.toISOString(), updatedAt: now.toISOString() }
}

export function buildNewItem(c: RefillCompany, industry: string, now: Date, scope: { projectId?: string; runBatchId?: string } = {}): any {
  const domain = normalizeDomain(c.website || c.domain || '')
  const id = randomUUID()
  // 入口防污染：聚合/平台/社媒域名（含子域名如 xxx.en.made-in-china.com）直接标记非买家实体，
  // applyEligibilityStage 会把它路由到 true_excluded，不占用背调/挖联系人资源。
  const platformDomain = isAggregatorDomain(c.website || c.domain || '')
  return {
    id,
    pipelineId: 'outreach',
    currentStageId: 'otr-found',
    status: 'active',
    priority: 'medium',
    source: 'refill',
    customerType: platformDomain ? 'non_buyer_entity' : undefined,
    recommendedAction: platformDomain ? 'true_excluded' : undefined,
    businessMatch: platformDomain ? 'none' : undefined,
    title: String(c.title || c.company || '').slice(0, 200),
    company: String(c.company || '').slice(0, 120),
    website: domain ? String(c.website || c.domain || '') : '',
    canonicalDomain: domain,
    normalizedDomain: domain,
    country: String(c.country || ''),
    snippet: String(c.snippet || '').slice(0, 500),
    industry,
    businessLine: String(industry || '').toLowerCase().includes('car') ? 'auto' : 'furniture',
    projectId: String(scope.projectId || industry || 'furniture'),
    acquisitionBatchId: String(scope.runBatchId || ''),
    email: '',
    phone: '',
    level: 'unknown',
    emailVerification: 'unknown',
    emailBounced: false,
    currency: 'USD',
    backcheckStatus: 'pending',
    developmentStatus: 'pending',
    sourceType: 'web',
    sourceUrl: String(c.website || c.domain || ''),
    notes: [],
    attachments: [],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }
}

/**
 * 产品页判定（2026-08-14 refill 补搜产品页污染修复）：
 * 复用 searchResultPolicy.classifySearchSource 的 product_page 口径（URL 含 /product /collections /category 等路径），
 * 产品页/产品目录页不是"公司"实体，isNoiseCandidate 只按行业词放行会误入库。
 */
export function isProductPageCandidate(c: RefillCompany): boolean {
  const source = String(c.website || c.domain || '')
  if (!source) return false
  return classifySearchSource({ url: source, title: c.title, snippet: c.snippet }) === 'product_page'
}

/**
 * 产品页候选归一化为域名公司：产品页 URL 深路径 + 标题（产品名）会被当"公司"入库。
 * 命中产品页时把 website 归一到域名根、company 取域名主标签，保留真实经销/零售公司实体
 * （如 bizchair.com / restaurantfurniture4less.com 的产品目录页 → 域名公司），不误伤真实客户。
 */
export function toDomainCompany(c: RefillCompany): RefillCompany {
  let host = String(c.domain || '')
  if (!host) {
    try {
      host = new URL(String(c.website || '')).hostname.replace(/^www\./, '')
    } catch {
      return c
    }
  }
  if (!host) return c
  const parts = host.split('.').filter(Boolean)
  // 取域名主标签：跳过常见二级后缀（.co.uk/.com.au 等）退化到更前一段，其余取倒数第二段
  let label = parts.length >= 2 ? parts[parts.length - 2] : parts[0]
  if ((label || '').length <= 3 && parts.length >= 3) label = parts[parts.length - 3]
  return {
    ...c,
    company: (label || host).slice(0, 120),
    website: `https://${host}/`,
    domain: host,
  }
}

/**
 * 2026-08-16 结果级欧美过滤（主公策略：补搜避开欧美，主攻海湾/亚太/拉美/非洲/澳加）。
 * search API 的 gl 市场参数不严格过滤结果，仍会返回欧美公司（如美国餐厅、法国 .fr、波兰 .pl 供应商），
 * 故在补搜入库前对每个结果做"欧美来源"判定。命中任一规则即返回 true（调用方跳过不入库）：
 *   1. 域名/网站 TLD 为欧洲国家或美国（从 website/domain/sourceUrl 提取主机名，不含路径，去掉端口和 www.）；
 *   2. title/website/domain/sourceUrl 拼起来命中美国州名 / 美国大城市 / 欧美国家名或国籍词（词边界，大小写不敏感）。
 */
const WESTERN_TLD_RE =
  /\.(us|eu|uk|gb|fr|de|it|es|nl|ie|be|ch|at|pt|gr|dk|se|no|fi|pl|cz|ru|ro|hu|bg|hr|si|sk|lv|lt|ee|cy|mt|lu|is|li|ua|by)\b/i

const WESTERN_PLACE_RE =
  /\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|maui|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new\s+hampshire|new\s+jersey|new\s+mexico|new\s+york|north\s+carolina|north\s+dakota|ohio|oklahoma|oregon|pennsylvania|rhode\s+island|south\s+carolina|south\s+dakota|tennessee|texas|utah|vermont|virginia|washington|west\s+virginia|wisconsin|wyoming|district\s+of\s+columbia|united\s+states|usa|america|american|atlanta|austin|baltimore|boston|chicago|cincinnati|cleveland|dallas|denver|detroit|fort\s+worth|honolulu|houston|kansas\s+city|las\s+vegas|los\s+angeles|memphis|miami|milwaukee|minneapolis|nashville|new\s+orleans|omaha|orlando|philadelphia|phoenix|pittsburgh|portland|san\s+antonio|san\s+diego|san\s+francisco|san\s+jose|seattle|tampa|tulsa|wichita|paris|berlin|munich|rome|milan|madrid|barcelona|lisbon|amsterdam|brussels|geneva|zurich|vienna|dublin|edinburgh|glasgow|london|manchester|copenhagen|stockholm|oslo|helsinki|warsaw|prague|athens|france|french|germany|german|italy|italian|spain|spanish|portugal|netherlands|belgium|switzerland|austria|ireland|scotland|england|wales|denmark|sweden|norway|finland|poland|czech|greece|britain|british|uk)\b/i

/** 从原始字符串提取主机名（去协议/路径/查询/哈希，去掉 www. 和端口）；提取失败跳过该来源 */
function extractHostName(...sources: Array<string | undefined>): string {
  for (const s of sources) {
    const raw = String(s || '').trim()
    if (!raw) continue
    try {
      return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.replace(/^www\./, '')
    } catch {
      const host = raw
        .replace(/^[a-z]+:\/\//i, '')
        .split('/')[0]
        .split('?')[0]
        .split('#')[0]
        .replace(/^www\./, '')
        .replace(/:\d+$/, '')
      if (host) return host
    }
  }
  return ''
}

export function isWesternCompanyCandidate(c: {
  title?: string
  website?: string
  domain?: string
  sourceUrl?: string
  snippet?: string
}): boolean {
  const host = extractHostName(c.website, c.domain, c.sourceUrl)
  if (host && WESTERN_TLD_RE.test(host)) return true
  const haystack = [c.title, c.website, c.domain, c.sourceUrl].filter(Boolean).join(' ')
  return WESTERN_PLACE_RE.test(haystack)
}

/**
 * 数据不足自动补搜索检查（每 tick 调用一次）。
 * 返回本次实际触发的动作名数组（'search' / 'contact_mining' / 'backcheck'）。
 */
export async function runRefillCheck(now: Date, deps: RefillCheckDeps): Promise<{ triggered: string[] }> {
  const triggered: string[] = []
  const effectiveNow = deps.now || now
  const version = deps.version || DEFAULT_VERSION
  const key = deps.searchBudgetKey || DEFAULT_SEARCH_BUDGET_KEY
  const maxSearchPerTick = deps.maxSearchPerTick ?? DEFAULT_MAX_SEARCH_PER_TICK
  const dailySearchBudget = deps.dailySearchBudget ?? DEFAULT_DAILY_SEARCH_BUDGET
  const minPoolSize = deps.minPoolSize ?? DEFAULT_TEST_POOL_TARGET
  const industry = deps.industry || 'furniture'
  const budgetIO = deps.budgetIO || createDefaultBudgetIO(deps.budgetStorePath || DEFAULT_BUDGET_FILE)
  const searchFn = deps.searchFn || defaultSearchFn
  const applyStageFn = deps.applyStageFn || ((item: any) => applyEligibilityStage(item, effectiveNow))
  const insertItem = deps.insertItem

  let items: any[] = []
  try {
    items = deps.readItems()
  } catch (err) {
    if (deps.lastError && typeof deps.lastError === 'object') {
      deps.lastError.refillRead = err instanceof Error ? err.message : String(err)
    }
    return { triggered }
  }

  // 触发 2：挖联系人（由 contact-mining-consumer 处理，此处只标记）
  if (items.some(it => stageOf(it) === 'contact_mining_queue')) triggered.push('contact_mining')

  // 触发 3：背调补充（由 backcheck-auto-consumer 处理，此处只标记）
  if (items.some(it => stageOf(it) === 'backcheck_queue')) triggered.push('backcheck')

  // 触发 1：搜索补充（真正执行）
  // 主公 2026-08-11 口径（取代 08-09 无条件补搜）：待发池 = A(待发测试信) + B(可入队候选) < minPoolSize（默认 100）
  // 才补搜；合计 ≥ 100 跳过本次，不调 searchFn、不耗 API 额度，消耗到 <100 才触发，"凑够 100 就停"由门槛自然实现。
  // A = test_mail_queue.json 中 status ∈ pending/scheduled/deferred/needs_reschedule 的记录数；
  // B = email_validation_queue 中未入队(autoTestEnqueuedAt 空)、非隔离、有邮箱且 7 天内 domain_mx_pass/dns_mx_ok
  // 证据的可入队候选数。降级链（JustSerp→Tavily→Serper）与搜索词库保持不动。
  const pendingPool = countTestQueuePending(deps.testMailQueuePath || TEST_MAIL_QUEUE_FILE)
    + countEnqueueableCandidates(items, effectiveNow)
  const devPool = countDevPool(items)

  const budget = budgetIO.read()
  // 2026-08-14 轮换：按 budget.marketIndex 轮换目标市场（搜过的国家不再搜，每次补搜都是新市场新内容）。
  // deps.markets 可选覆盖（测试用），不传则用 SEARCH_MARKETS；deps.country 显式指定时优先（不轮换）。
  const markets = deps.markets?.length ? deps.markets : SEARCH_MARKETS
  const marketIndex = Number.isInteger(budget.marketIndex) ? (budget.marketIndex as number) : 0
  const nowMs = effectiveNow.getTime()
  const today = effectiveNow.toISOString().slice(0, 10)
  const searchActive = budget.key === key
    && budget.inProgress === true
    && Boolean(budget.startedAt)
    && nowMs - Date.parse(budget.startedAt || '') < STALE_SEARCH_MS

  const lastSearchAt = budget.key === key ? budget.lastSearchAt || budget.lastCompletedAt : undefined
  const lastSearchMs = Date.parse(lastSearchAt || '')
  const searchDue = !Number.isFinite(lastSearchMs) || nowMs - lastSearchMs >= SEARCH_INTERVAL_MS
  if (!searchActive && searchDue && (pendingPool < minPoolSize || devPool < minPoolSize)) {
    const existingDomains = new Set<string>()
    for (const it of items) {
      const d = normalizeDomain(String(it?.website || it?.sourceUrl || ''))
      if (d) existingDomains.add(d)
    }
    const usedToday = budget.key === key && budget.date === today ? budget.used : 0
    budgetIO.write({
      ...budget,
      key,
      date: today,
      dailyBudget: dailySearchBudget,
      used: usedToday,
      inProgress: true,
      startedAt: effectiveNow.toISOString(),
      lastCompletedAt: undefined,
    })
    try {
      const deficit = Math.max(0, minPoolSize - pendingPool) + Math.max(0, minPoolSize - devPool)
      const limit = Math.max(1, Math.min(deficit, maxSearchPerTick))
      // 2026-08-14 轮换：把已用查询指纹传给 defaultSearchFn 去重（搜过的查询组合不再用），并回填本次实际执行指纹
      const usedQueries = Array.isArray(budget.usedQueryFingerprints) ? [...budget.usedQueryFingerprints] : []
      // 2026-08-14 全市场一轮：一次补搜从 marketIndex 起把市场列表循环一周各搜一遍（deps.country 显式指定时仅搜该市场）
      const countries = deps.country
        ? [deps.country]
        : Array.from({ length: markets.length }, (_, i) => markets[(marketIndex + i) % markets.length])
      let searchCount = 0
      let remainingAccepted = limit
      const metrics = { raw: 0, duplicate: 0, filtered: 0, inserted: 0 }
      for (const country of countries) {
        if (remainingAccepted <= 0) break
        const searchInput: RefillSearchInput = {
          industry,
          country,
          terms: deps.terms,
          limit: remainingAccepted,
          skipQueryFingerprints: usedQueries,
          usedQueryFingerprints: [],
        }
        const found = await searchFn(searchInput)
        searchCount++
        metrics.raw += found.length
        for (const raw of found) {
          if (remainingAccepted <= 0) break
          // 产品页（/products/ /collections/ /category/）归一化为域名公司再入库，避免产品名当公司名（2026-08-14 修复）
          const c = isProductPageCandidate(raw) ? toDomainCompany(raw) : raw
          // 地区只控制搜索方向，不是业务有效性门禁。跨地区结果继续入库，由背调和业务匹配筛选。
          const d = normalizeDomain(String(c.website || c.domain || ''))
          if (d && existingDomains.has(d)) { metrics.duplicate++; continue }
          const staged = applyStageFn(stamp(buildNewItem(c, industry, effectiveNow, {
            projectId: deps.projectId,
            runBatchId: deps.runBatchId,
          }), version, effectiveNow), effectiveNow).item
          const result = await insertItem(staged)
          if (result.ok) {
            if (d) existingDomains.add(d)
            metrics.inserted++
            remainingAccepted--
          } else if (deps.lastError && typeof deps.lastError === 'object') {
            deps.lastError[`refillInsert_${c.domain || c.website}`] = result.error || 'unknown'
          }
        }
        // 跨市场累计本次实际执行指纹（供下轮去重；指纹含 country，不同市场不互相误判）
        if (Array.isArray(searchInput.usedQueryFingerprints)) {
          for (const fp of searchInput.usedQueryFingerprints) {
            if (!usedQueries.includes(fp)) usedQueries.push(fp)
          }
        }
      }
      // 完成时推进 marketIndex（循环回绕到下一轮起点）+ 合并指纹（保留最近 200 防无限增长）
      budgetIO.write({
        ...budget,
        key,
        date: today,
        dailyBudget: dailySearchBudget,
        used: usedToday + searchCount,
        inProgress: false,
        startedAt: budget.startedAt,
        lastCompletedAt: effectiveNow.toISOString(),
        lastSearchAt: effectiveNow.toISOString(),
        marketIndex: deps.country ? marketIndex + 1 : (marketIndex + searchCount) % markets.length,
        usedQueryFingerprints: usedQueries.slice(-200),
        searchMetrics: {
          ...metrics,
          lastRunAt: effectiveNow.toISOString(),
          nextRunAt: new Date(nowMs + SEARCH_INTERVAL_MS).toISOString(),
        },
      })
      triggered.push('search')
    } catch (err) {
      budgetIO.write({
        ...budget,
        key,
        date: today,
        dailyBudget: dailySearchBudget,
        used: usedToday,
        inProgress: false,
        startedAt: budget.startedAt,
        lastCompletedAt: undefined,
        lastSearchAt: effectiveNow.toISOString(),
      })
      if (deps.lastError && typeof deps.lastError === 'object') {
        deps.lastError.refillSearch = err instanceof Error ? err.message : String(err)
      }
    }
  }

  return { triggered }
}
