/**
 * 联系人自动挖掘消费（批次2 / 联系人自动挖掘 T5）。
 *
 * 职责：自动消费 primaryStage==='contact_mining_queue' 的项，全流程自动循环，不依赖人工触发：
 *   1. 对尚未挖过联系人的域名先用 Serper 查公开联系人/同域邮箱，无可开发结果再走 Snovio/Hunter，写回 item.contacts[]（≤4 个/家）。
 *   2. 挖到个人联系人 → 提升为 selectedEmail（替换非个人邮箱）→ 重算阶段（getLeadStageEligibility）
 *      → 流入 email_validation_queue。
 *   3. 挖不到 / 无域名 → 盖 autoProcessedAt + stepperVersion，同版本不重复处理（限流保护）。
 *   4. 已挖过联系人但仍滞留 contact_mining_queue 的项（历史遗留 selectedEmail 未提升）→ 直接提升 + 重算放行。
 *
 * 限流/预算：Serper 每家公司固定 2 次查询且保存完成戳；同版本不会重复消费。
 *   - 每 tick ≤ 1 域名（Snovio 按域名计费，domain-search 为异步任务，start 即占一次配额）。
 *   - Snovio 配额耗尽（402/429 或响应含 credit/quota/billing 字样）→ 立即停批，返回 quotaExhausted=true，
 *     该条不盖戳（配额恢复后同版本可重试）。
 *   - 已存在 in_progress 任务 → 轮询（poll 不占配额）；in_progress 轮询不盖戳，下 tick 继续轮询直到完成。
 *   - 任务超过 2h 仍 in_progress → 判定卡死，标记 failed 并盖戳，让出队列。
 *
 * 写库采用 items-store-atomic.ts 的 updateOneItemAtomic（不重算阶段），放行项在进程内已调
 * applyEligibilityStage 算好阶段，再原子写回（与 backcheck-auto-consumer.ts 同款模式）。
 *
 * 不挂载到 backgroundTick / pipeline-stepper；仅提供可调用导出函数（挂载留批次末统一接入）。
 */

import { readItemsAtomic, updateOneItemAtomic, ITEMS_STORE_FILE } from './items-store-atomic'
import { applyEligibilityStage } from '../src/services/leadStageEligibility'
import { createSnovioTask, mergeSnovioCandidates, normalizeSnovioProviderData, scoreContactCandidate } from './snovio-domain-search'
import { getSnovioToken } from './snovio-scheduler'
import { hunterDomainSearch, prospeoDomainSearch, serperDomainContactSearch } from './contact-provider-search'
import { classifyEmailQuality, normalizeDomain } from '../src/services/emailQualityPolicy'
import { isPlaceholderEmail, roleEmailClass } from '../src/services/emailClassification'
import { getFormalSentEmailsCached } from './formal-sent-email-set'
import { getTestMailVerdictsCached } from './test-mail-verdicts'
import { isDevelopmentPriorityEligible } from '../src/services/businessPriority'
import { SerperHttpError, normalizeSerperKeys, runWithSerperKeyPool } from '../src/services/justSerpKeyPool'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getActiveProfile } from '../src/services/profiles'
import { deriveAddressVerificationState } from '../src/services/emailCandidateView'

const CONFIG_FILE = join(__dirname, '..', 'user_config.json')

export interface ContactMiningAutoStats {
  processed: number
  found: number
  quotaExhausted: boolean
}

export interface SnovioStartResult {
  ok: boolean
  taskId?: string
  resultUrl?: string
  statusUrl?: string
  quotaExhausted?: boolean
  error?: string
}

export interface SnovioPollResult {
  status: 'completed' | 'processing' | 'failed'
  data?: unknown
  quotaExhausted?: boolean
  error?: string
}

export interface SnovioClient {
  getToken(): Promise<string | null>
  startDomainSearch(domain: string, token: string): Promise<SnovioStartResult>
  pollResult(resultUrl: string, token: string): Promise<SnovioPollResult>
}

export interface ContactMiningAutoDeps {
  /** 覆盖 items_store.json 路径（测试/独立库用） */
  itemsStorePath?: string
  /** 覆盖当前时间 */
  now?: Date
  /** 每 tick 最多处理条数（默认 1 = 1域名/tick，Snovio 限流） */
  maxPerTick?: number
  /** 当前产品项目；默认取活动画像。显式不同项目的数据不会被本轮消费。 */
  projectId?: string
  /** 仅处理本搜索批次。 */
  runBatchId?: string
  /** 仅处理这些客户 ID；试运行必须传入，防止扫到全局旧池。 */
  customerIds?: Iterable<string>
  /** stepper 版本戳（防同版本重复处理；换版本号即重新消费） */
  version?: string
  /** Snovio 凭据覆盖（默认读 user_config.json 的 snovioUserId/snovioSecret） */
  snovioUserId?: string
  snovioSecret?: string
  /** Hunter 凭据覆盖（默认读 user_config.json 的 hunterApiKey） */
  hunterApiKey?: string
  /** Serper 凭据覆盖（默认读 user_config.json 的 serperApiKey） */
  serperApiKey?: string
  serperApiKey2?: string
  serperApiKeys?: string[]
  /** Prospeo 凭据覆盖（默认读 user_config.json 的 prospeoApiKey） */
  prospeoApiKey?: string
  /** Snovio 客户端注入（测试可传 mock，避免真实 HTTP/配额） */
  snovioClient?: SnovioClient
  /** Serper 联系人搜索注入（测试可传 mock，避免真实 HTTP/配额） */
  serperSearchFn?: typeof serperDomainContactSearch
  /** 阶段重算注入（默认 applyEligibilityStage + formalSent/testMailVerdicts 缓存） */
  applyStageFn?: (item: any, now: Date) => { item: any; changed: boolean }
  /** 上层巡检可读的错误槽（本函数只写，不抛） */
  lastError?: Record<string, unknown>
}

const DEFAULT_VERSION = 'contact-mining-consumer-v2-serper-first'
const DEFAULT_MAX_PER_TICK = 3
/** in_progress 任务超过该时长判为卡死，标记 failed 让出队列 */
const TASK_STALE_MS = 2 * 60 * 60 * 1000

function text(v: unknown): string { return String(v || '').trim() }
function stamp(item: any, version: string, now: Date): any {
  return { ...item, stepperVersion: version, autoProcessedAt: now.toISOString(), updatedAt: now.toISOString() }
}

/** 匹配度权重：高=3 中=2 低=1 无=0。主公标准——挖联系人优先挖高匹配公司。 */
const MATCH_RANK: Record<string, number> = { high: 3, medium: 2, low: 1, none: 0 }
function rankOf(v: unknown): number { return MATCH_RANK[String(v || '').trim().toLowerCase()] ?? 0 }
/**
 * 挖联系人优先级：业务匹配度(100) > 商业价值(10) > 已有 no_bounce(5) > 已启动任务(0.1 防流失)。
 * no_bounce 记录挖到个人联系人即直通开发池（不需等测试信），同匹配度下优先挖，尽快出开发池结果。
 */
function hasNoBounce(item: any): boolean {
  const ev = Array.isArray(item?.emailVerificationEvidence) ? item.emailVerificationEvidence : []
  if (ev.some((e: any) => String(e?.result || e?.status || '').trim().toLowerCase() === 'no_bounce_observed')) return true
  return item?.testVerdict?.state === 'no_bounce_observed'
}
function miningPriority(item: any): number {
  const hasTask = (Array.isArray(item?.snovioDomainSearchTasks) ? item.snovioDomainSearchTasks : [])
    .some((t: any) => t?.provider === 'snovio' && t?.status === 'in_progress') ? 0.1 : 0
  return rankOf(item?.businessMatch) * 100 + rankOf(item?.importCommercialValue) * 10 + (hasNoBounce(item) ? 5 : 0) + hasTask
}

function isQuotaError(status: number, body: string): boolean {
  if (status === 402 || status === 429) return true
  return /credit|quota|billing|purchase|insufficient/i.test(body)
}

/** 临时性错误（5xx/超时/网络层 fetch failed/连接异常）→ 不应盖戳，下 tick 重试；永久性错误（422 等）→ 盖章让出队列。 */
const isTransientError = (err: string): boolean =>
  /5\d\d|timeout|timed out|aborted due to|fetch failed|ECONN|EAI_AGAIN|ENOTFOUND|socket|network/i.test(err)

function createDefaultSnovioClient(userId: string, secret: string): SnovioClient {
  return {
    async getToken() {
      if (!userId || !secret) return null
      return getSnovioToken(userId, secret)
    },
    async startDomainSearch(domain, token) {
      try {
        const resp = await fetch('https://api.snov.io/v2/domain-search/domain-emails/start', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `domain=${encodeURIComponent(domain)}`,
          signal: AbortSignal.timeout(30000),
        })
        const bodyText = await resp.text().catch(() => '')
        if (!resp.ok) {
          return { ok: false, quotaExhausted: isQuotaError(resp.status, bodyText), error: `snovio_start_${resp.status}` }
        }
        let data: any = {}
        try { data = JSON.parse(bodyText) } catch { /* ignore */ }
        const resultUrl = data?.links?.result
        const statusUrl = data?.links?.status
        if (!resultUrl && !statusUrl) return { ok: false, error: 'snovio_task_url_missing' }
        return { ok: true, taskId: data?.taskId || data?.meta?.task_hash, resultUrl, statusUrl }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
    async pollResult(resultUrl, token) {
      try {
        const resp = await fetch(resultUrl, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(30000),
        })
        const bodyText = await resp.text().catch(() => '')
        if (!resp.ok) {
          return { status: 'failed', quotaExhausted: isQuotaError(resp.status, bodyText), error: `snovio_poll_${resp.status}` }
        }
        let data: any = {}
        try { data = JSON.parse(bodyText) } catch { /* ignore */ }
        const status = String(data?.status || '').toLowerCase()
        if (status === 'processing' || status === 'in_progress') return { status: 'processing' }
        if (status === 'failed') return { status: 'failed', error: 'snovio_task_failed' }
        return { status: 'completed', data: data?.data }
      } catch (err) {
        return { status: 'failed', error: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}

function loadSnovioCredentials(deps: ContactMiningAutoDeps): { userId: string; secret: string } {
  if (deps.snovioUserId !== undefined || deps.snovioSecret !== undefined) {
    return { userId: deps.snovioUserId || '', secret: deps.snovioSecret || '' }
  }
  try {
    const raw = readFileSync(CONFIG_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return { userId: String(parsed.snovioUserId || ''), secret: String(parsed.snovioSecret || '') }
  } catch {
    return { userId: '', secret: '' }
  }
}

function loadHunterApiKey(deps: ContactMiningAutoDeps): string | null {
  if (deps.hunterApiKey !== undefined) return deps.hunterApiKey || null
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as Record<string, unknown>
    return String(parsed.hunterApiKey || '').trim() || null
  } catch {
    return null
  }
}

function loadSerperApiKeys(deps: ContactMiningAutoDeps): string[] {
  if (deps.serperApiKey !== undefined || deps.serperApiKey2 !== undefined || deps.serperApiKeys !== undefined) {
    return normalizeSerperKeys([deps.serperApiKey, deps.serperApiKey2, ...(deps.serperApiKeys || [])])
  }
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as Record<string, unknown>
    return normalizeSerperKeys({
      serperApiKey: parsed.serperApiKey,
      serperApiKey2: parsed.serperApiKey2,
      serperApiKeys: parsed.serperApiKeys,
    })
  } catch {
    return []
  }
}

function loadProspeoApiKey(deps: ContactMiningAutoDeps): string | null {
  if (deps.prospeoApiKey !== undefined) return deps.prospeoApiKey || null
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as Record<string, unknown>
    return String(parsed.prospeoApiKey || '').trim() || null
  } catch {
    return null
  }
}

function getDomain(item: any): string {
  return normalizeDomain(item?.canonicalDomain || item?.domain || item?.website)
}

function classifyContactEmail(contact: any, domain: string) {
  return classifyEmailQuality({
    email: contact?.email,
    canonicalDomain: domain,
    contactName: contact?.name,
    title: contact?.title,
    source: contact?.source,
    evidenceUrl: contact?.sourceUrl || contact?.evidenceUrl,
  })
}

function addressUnavailable(item: any, address: unknown, now: Date): boolean {
  const email = text(address).toLowerCase()
  if (!email) return true
  if (item?.currentEmailUseBlocked === true && text(item?.selectedEmail).toLowerCase() === email) return true
  if (deriveAddressVerificationState(item, email, now) === 'bounced' || deriveAddressVerificationState(item, email, now) === 'invalid') return true
  if ((Array.isArray(item?.doNotContactEmails) ? item.doNotContactEmails : []).some((value: unknown) => text(value).toLowerCase() === email)) return true
  return false
}

function hasUsablePersonalContact(item: any, domain: string, now: Date): boolean {
  return (Array.isArray(item?.contacts) ? item.contacts : []).some((contact: any) =>
    contact?.email && classifyContactEmail(contact, domain).emailType === 'personal_company' && !addressUnavailable(item, contact.email, now))
}

function bestPersonalContact(item: any, domain: string, now: Date): any | undefined {
  const scored = (Array.isArray(item?.contacts) ? item.contacts : [])
    .filter(c => c && c.email)
    .filter(c => !addressUnavailable(item, c.email, now))
    .map(c => ({ c, quality: classifyContactEmail(c, domain), score: scoreContactCandidate(c) }))
    .filter(x => x.quality.emailType === 'personal_company')
    .sort((a, b) => b.score - a.score)
  return scored[0]?.c
}

function isPersonalSelected(item: any, domain: string, now = new Date()): boolean {
  if (!item?.selectedEmail) return false
  if (item?.currentEmailUseBlocked === true || addressUnavailable(item, item.selectedEmail, now)) return false
  return classifyEmailQuality({ email: item.selectedEmail, canonicalDomain: domain }).emailType === 'personal_company'
}

/**
 * 找出可开发的部门邮箱（仅 department，主公 2026-08-19 收窄口径：只有能转发到相关负责人的
 * 部门邮箱如 purchasing@/buyer@/export@/ffe@ 才放行开发）。
 * public（info@/sales@/contact@ 等公众邮箱）与 location（sydney@/branch@/store@ 等地名邮箱）
 * 发了没人理，不提升、不放行；nonbusiness（noreply@/hr@/careers@/abuse@ 等）也不放行。
 */
function findDevelopableRoleEmail(item: any, domain: string, now = new Date()): string | undefined {
  const candidates: string[] = []
  const push = (v: unknown) => { const e = String(v || '').trim().toLowerCase(); if (e && !candidates.includes(e)) candidates.push(e) }
  for (const c of Array.isArray(item?.contacts) ? item.contacts : []) push(c?.email)
  push(item?.email)
  push(item?.selectedEmail)
  push(item?.preferredEmail)
  return candidates
    .filter(e => !isPlaceholderEmail(e) && !addressUnavailable(item, e, now))
    .map(e => ({ e, cls: roleEmailClass(e) }))
    .filter((x): x is { e: string; cls: 'department' } => x.cls === 'department')
    .sort((a, b) => scoreContactCandidate({ email: a.e }) - scoreContactCandidate({ email: b.e }))[0]?.e
}

/** 个人/采购部门邮箱均耗尽后，高/中匹配客户可用同域公开业务邮箱进入低优先验证。 */
function findPublicBusinessFallback(item: any, domain: string, now = new Date()): string | undefined {
  if (!['high', 'medium'].includes(text(item?.businessMatch).toLowerCase())) return undefined
  const candidates: string[] = []
  const push = (value: unknown) => {
    const candidate = text(value).toLowerCase()
    if (candidate && !candidates.includes(candidate)) candidates.push(candidate)
  }
  for (const contact of Array.isArray(item?.contacts) ? item.contacts : []) push(contact?.email)
  push(item?.email)
  push(item?.selectedEmail)
  push(item?.preferredEmail)
  return candidates.find(candidate => !isPlaceholderEmail(candidate) && !addressUnavailable(item, candidate, now)
    && candidate.endsWith(`@${domain}`)
    && roleEmailClass(candidate) === 'public')
}

function mergePublicContactClues(contacts: any[], clues: any[]): any[] {
  const merged = [...contacts]
  for (const clue of clues) {
    if (!text(clue?.name) || merged.length >= 4) break
    const sourceUrl = text(clue?.sourceUrl)
    const duplicate = merged.some(contact => sourceUrl
      ? text(contact?.sourceUrl || contact?.evidenceUrl) === sourceUrl
      : text(contact?.name).toLowerCase() === text(clue?.name).toLowerCase())
    if (!duplicate) merged.push({
      name: text(clue.name),
      title: text(clue.title),
      source: 'serper_linkedin',
      sourceUrl,
      confidence: 'public_search_company_match',
    })
  }
  return merged
}

function projectKey(value: unknown): string {
  const key = text(value).toLowerCase()
  if (/^(auto|automotive|car[\s_-]?seat)$/.test(key)) return 'auto'
  if (['lighting', 'home', 'packaging', 'both', 'furniture'].includes(key)) return key
  return 'furniture'
}

function inRequestedScope(item: any, projectId: string, runBatchId: string, customerIds: Set<string> | null): boolean {
  if (customerIds && !customerIds.has(text(item?.id))) return false
  if (runBatchId && text(item?.acquisitionBatchId || item?.runBatchId) !== runBatchId) return false
  const itemProject = text(item?.projectId || item?.projectKey || item?.businessLine)
  return !itemProject || projectKey(itemProject) === projectKey(projectId)
}

/** 从 contacts[] 提升最佳个人联系人：补齐 contactName/Title/Source，并把非个人 selectedEmail 替换为个人邮箱。 */
function promotePersonalContact(item: any, domain: string, now = new Date()): any {
  const current = { ...item }
  const previous = text(current.selectedEmail).toLowerCase()
  const best = bestPersonalContact(current, domain, now)
  if (!best) return current
  if (!text(current.contactName)) current.contactName = text(best.name)
  if (!text(current.contactTitle)) current.contactTitle = text(best.title)
  if (!text(current.contactSource)) current.contactSource = text(best.source || best.sourceUrl)
  if (!text(current.contactSourceUrl)) current.contactSourceUrl = text(best.sourceUrl)
  if (!text(current.contactEvidenceUrl)) current.contactEvidenceUrl = text(best.sourceUrl)
  if (!isPersonalSelected(current, domain, now)) {
    current.selectedEmail = text(best.email)
    current.preferredEmail = text(best.email)
    if (previous && previous !== text(best.email).toLowerCase()) {
      current.currentEmailUseBlocked = false
      current.contactMiningRequired = false
      current.contactMiningRequiredForEmail = undefined
      current.currentEmailUseBlockedForEmail = undefined
      current.contactReplacementResolvedAt = now.toISOString()
      current.contactReplacementPreviousEmail = previous
    }
  }
  return current
}

async function runSerperPrimary(
  current: any,
  domain: string,
  now: Date,
  ctx: {
    serperApiKeys: string[]
    serperSearchFn: typeof serperDomainContactSearch
    stats: { found: number }
    applyStageFn: (item: any, now: Date) => { item: any; changed: boolean }
  },
): Promise<{ item: any; advanced: boolean }> {
  if (ctx.serperApiKeys.length === 0) return { item: current, advanced: false }
  const priorTasks = Array.isArray(current?.serperContactSearchTasks) ? current.serperContactSearchTasks : []
  const replacementFor = String(current?.primaryStage || '') === 'replace_contact_queue' ? text(current?.selectedEmail).toLowerCase() : ''
  if (priorTasks.some((task: any) => task?.provider === 'serper' && task?.status === 'completed' && (!replacementFor || text(task?.replacementForEmail).toLowerCase() === replacementFor))) {
    return { item: current, advanced: false }
  }
  const attempt = await runWithSerperKeyPool(ctx.serperApiKeys, async key => {
    const result = await ctx.serperSearchFn(domain, text(current?.company || current?.title || domain), key)
    if (result.status === 'completed') return result
    const parsedStatus = Number(String(result.error || '').match(/serper_(\d+)/)?.[1] || 0)
    throw new SerperHttpError(parsedStatus || (result.status === 'quota' ? 429 : result.status === 'auth' ? 401 : 0))
  })
  if (!attempt.ok) {
    const statusText = attempt.statuses.map(status => status || 'network').join(',') || 'unavailable'
    return { item: { ...current, lastError: `contact_mining:serper_${statusText}` }, advanced: false }
  }
  const result = attempt.value

  const merged = mergeSnovioCandidates(
    Array.isArray(current.contacts) ? current.contacts : [],
    result.candidates || [],
    String(current.id || ''),
    'serper_found',
  )
  let item = { ...current }
  if (merged.added + merged.completed + merged.replacements.length > 0) {
    item.contacts = merged.contacts
    item.contactReplacementLog = [
      ...(Array.isArray(item.contactReplacementLog) ? item.contactReplacementLog : []),
      ...merged.replacements,
    ]
    const evidence = Array.isArray(item.emailVerificationEvidence) ? item.emailVerificationEvidence : []
    for (const contact of merged.contacts.filter((candidate: any) => candidate?.source === 'serper_found' && candidate?.email)) {
      if (!evidence.some((entry: any) => text(entry?.email).toLowerCase() === text(contact.email).toLowerCase() && entry?.result === 'serper_found')) {
        evidence.push({ email: contact.email, result: 'serper_found', scope: 'specific_email', source: 'serper', method: 'public_search_exact_domain', evidenceUrl: contact.sourceUrl, checkedAt: now.toISOString(), note: 'Serper public candidate; address not yet verified.' })
      }
    }
    item.emailVerificationEvidence = evidence
  }
  const existingClues = Array.isArray(item.serperContactClues) ? item.serperContactClues : []
  item.serperContactClues = [...new Map([...existingClues, ...(result.clues || [])].map((clue: any) => [text(clue?.sourceUrl || `${clue?.name}|${clue?.title}`), clue])).values()].slice(0, 8)
  item.contacts = mergePublicContactClues(Array.isArray(item.contacts) ? item.contacts : [], result.clues || [])
  item.serperContactSearchTasks = [...priorTasks, {
    provider: 'serper', status: 'completed', queryCount: 2,
    candidateCount: result.candidates?.length || 0, clueCount: result.clues?.length || 0,
    requestedAt: now.toISOString(), normalizedResultStored: true,
    ...(replacementFor ? { replacementForEmail: replacementFor } : {}),
  }]

  item = promotePersonalContact(item, domain, now)
  if (!hasUsablePersonalContact(item, domain, now) && !isPersonalSelected(item, domain, now)) {
    const roleEmail = findDevelopableRoleEmail(item, domain, now)
    if (roleEmail) {
      item.selectedEmail = roleEmail
      item.preferredEmail = roleEmail
    }
  }
  const developable = hasUsablePersonalContact(item, domain, now) || isPersonalSelected(item, domain, now) || Boolean(findDevelopableRoleEmail(item, domain, now))
  if (!developable) return { item, advanced: false }
  const staged = ctx.applyStageFn(item, now).item
  const advanced = !['contact_mining_queue', 'replace_contact_queue'].includes(String(staged.primaryStage || staged.normalizedStage || ''))
  if (advanced) ctx.stats.found++
  return { item: staged, advanced }
}

/**
 * Serper 未找到可开发邮箱后，Snovio 主通道失败的降级链：Snovio → Hunter → Prospeo。
 *
 * - 任一备选通道同步搜索成功 → 合并候选（source 标记 hunter_found/prospeo_found）→ 提升个人联系人 → 重算阶段 → 盖戳。
 * - 备选通道配额尽（429/402）→ 返回 quotaExhausted=true（不盖戳，配额恢复后重试）。
 * - 备选通道 auth/error/not_implemented → 记 lastError 并继续下一个备选；全部失败后盖戳让出队列。
 * - 无任何备选 key → 回退旧口径（snovio_auth_failed / snovio_quota_exhausted）。
 */
async function runFallbackChain(
  current: any,
  domain: string,
  now: Date,
  reason: 'snovio_auth' | 'snovio_quota' | 'snovio_unavailable',
  ctx: {
    version: string
    hunterApiKey: string | null
    prospeoApiKey: string | null
    stats: { found: number }
    applyStageFn: (item: any, now: Date) => { item: any; changed: boolean }
  },
): Promise<{ item: any; quotaExhausted?: boolean }> {
  const item = { ...current }
  const providers: Array<{
    name: 'hunter' | 'prospeo'
    key: string | null
    search: (d: string, k: string) => Promise<import('./contact-provider-search').ProviderSearchResult>
  }> = [
    { name: 'hunter', key: ctx.hunterApiKey, search: hunterDomainSearch },
    { name: 'prospeo', key: ctx.prospeoApiKey, search: prospeoDomainSearch },
  ]

  for (const p of providers) {
    if (!p.key) continue
    console.log(`[contact-mining] provider fallback: snovio->${p.name} (reason=${reason}, domain=${domain})`)
    const res = await p.search(domain, p.key)
    if (res.status === 'completed') {
      const source = p.name === 'hunter' ? 'hunter_found' as const : 'prospeo_found' as const
      const merged = mergeSnovioCandidates(
        Array.isArray(item.contacts) ? item.contacts : [],
        res.candidates || [],
        String(item.id || ''),
        source,
      )
      if (merged.added + merged.completed + merged.replacements.length > 0) {
        item.contacts = merged.contacts
        item.contactReplacementLog = [
          ...(Array.isArray(item.contactReplacementLog) ? item.contactReplacementLog : []),
          ...merged.replacements,
        ]
        // 未验证候选证据（与 snovio_found 同口径：进入 email_validation_queue 后由 DNS/MX 校验）
        const evidence = Array.isArray(item.emailVerificationEvidence) ? item.emailVerificationEvidence : []
        for (const contact of merged.contacts.filter((c: any) => c?.source === source && c?.email)) {
          if (!evidence.some((e: any) => String(e?.email || '').toLowerCase() === String(contact.email || '').toLowerCase() && e?.result === source)) {
            evidence.push({ email: contact.email, result: source, scope: 'specific_email', source: p.name, method: 'domain_search', checkedAt: now.toISOString(), note: `${p.name} candidate; address not yet verified.` })
          }
        }
        item.emailVerificationEvidence = evidence
      }
      const tasksKey = `${p.name}DomainSearchTasks`
      const prevTasks = Array.isArray(item[tasksKey]) ? item[tasksKey] : []
      const replacementFor = String(item?.primaryStage || '') === 'replace_contact_queue' ? text(item?.selectedEmail).toLowerCase() : ''
      item[tasksKey] = [...prevTasks, { provider: p.name, status: 'completed', rawResultStored: true, requestedAt: now.toISOString(), ...(replacementFor ? { replacementForEmail: replacementFor } : {}) }]
      // 提升个人联系人 + 重算阶段（与 Snovio 完成路径同款）
      const promoted = promotePersonalContact(item, domain, now)
      const staged = ctx.applyStageFn(promoted, now).item
      const advanced = !['contact_mining_queue', 'replace_contact_queue'].includes(String(staged.primaryStage || staged.normalizedStage || ''))
      if (advanced) ctx.stats.found++
      if (!advanced && String(promoted.lastError || '').includes('snovio_auth_failed')) {
        promoted.lastError = 'contact_mining:no_personal_contact'
      }
      return { item: stamp(staged, ctx.version, now) }
    }
    if (res.status === 'quota') {
      console.log(`[contact-mining] provider fallback: ${p.name} quota exhausted (domain=${domain})`)
      return { item, quotaExhausted: true }
    }
    // auth / error / not_implemented → 继续下一个备选
    console.log(`[contact-mining] provider fallback: ${p.name} ${res.status}${res.error ? ` ${res.error}` : ''} (domain=${domain})`)
    item.lastError = `contact_mining:${p.name}_${res.status}${res.error ? `:${res.error}` : ''}`
    // TODO: Prospeo 人员查找实现后，此循环自动走 hunter→prospeo（contact-provider-search.prospeoDomainSearch 目前占位 not_implemented）
  }

  if (reason === 'snovio_quota') {
    item.lastError = item.lastError || 'contact_mining:snovio_quota_exhausted'
    return { item, quotaExhausted: true }
  }
  item.lastError = item.lastError || 'contact_mining:snovio_auth_failed'
  return { item: stamp(item, ctx.version, now) }
}

/**
 * 单条处理。
 * 返回 { item, quotaExhausted }；quotaExhausted=true 时不盖戳，供外层立即停批且配额恢复后重试。
 */
async function processOne(
  raw: any,
  now: Date,
  ctx: {
    version: string
    domain: string
    client: SnovioClient
    token: string | null
    serperApiKeys: string[]
    serperSearchFn: typeof serperDomainContactSearch
    hunterApiKey: string | null
    prospeoApiKey: string | null
    batch: { snovioQuotaExhausted: boolean }
    stats: { found: number }
    applyStageFn: (item: any, now: Date) => { item: any; changed: boolean }
  },
): Promise<{ item: any; quotaExhausted?: boolean }> {
  let current = { ...raw }
  const { domain, client, token } = ctx

  if (!domain) {
    current.lastError = 'contact_mining:no_domain'
    return { item: stamp(current, ctx.version, now) }
  }
  const tasks = Array.isArray(current.snovioDomainSearchTasks) ? current.snovioDomainSearchTasks : []
  const replacementFor = String(current?.primaryStage || '') === 'replace_contact_queue' ? text(current?.selectedEmail).toLowerCase() : ''
  const inProgressTask = [...tasks].reverse().find(t => t?.provider === 'snovio' && t?.status === 'in_progress' && (t?.resultUrl || t?.statusUrl))
  const completedTaskExists = tasks.some(t => t?.provider === 'snovio' && t?.status === 'completed' && t?.rawResultStored && (!replacementFor || text(t?.replacementForEmail).toLowerCase() === replacementFor))
  const hunterTaskExists = Array.isArray(current.hunterDomainSearchTasks) && current.hunterDomainSearchTasks.some((t: any) => t?.status === 'completed' && (!replacementFor || text(t?.replacementForEmail).toLowerCase() === replacementFor))
  const alreadyMined = hasUsablePersonalContact(current, domain, now) || completedTaskExists || hunterTaskExists || isPersonalSelected(current, domain, now)

  if (!inProgressTask && !hasUsablePersonalContact(current, domain, now) && !isPersonalSelected(current, domain, now)) {
    const serper = await runSerperPrimary(current, domain, now, ctx)
    current = serper.item
    if (serper.advanced) return { item: stamp(current, ctx.version, now) }
  }

  if (!token && !alreadyMined) {
    // Serper 无有效邮箱且 Snovio 不可用 → 自动降级 Hunter → Prospeo
    return runFallbackChain(current, domain, now, 'snovio_unavailable', ctx)
  }

  // ── 有 in_progress 任务 → 轮询（poll 不占配额） ──
  if (inProgressTask && !alreadyMined) {
    const requestedAt = Date.parse(inProgressTask.requestedAt || inProgressTask.lastPolledAt || '') || 0
    if (requestedAt && now.getTime() - requestedAt > TASK_STALE_MS) {
      current.snovioDomainSearchTasks = [
        ...tasks.filter(t => t?.correlationId !== inProgressTask.correlationId),
        { ...inProgressTask, status: 'failed', lastPolledAt: now.toISOString() },
      ]
      current.lastError = 'contact_mining:poll:stale_task'
      return { item: stamp(current, ctx.version, now) }
    }
    const poll = await client.pollResult(inProgressTask.resultUrl || inProgressTask.statusUrl || '', token)
    if (poll.quotaExhausted) {
      // Snovio 配额尽 → 标记任务 failed + 本批跳过 Snovio start，自动降级 Hunter → Prospeo
      ctx.batch.snovioQuotaExhausted = true
      current.snovioDomainSearchTasks = [
        ...tasks.filter(t => t?.correlationId !== inProgressTask.correlationId),
        { ...inProgressTask, status: 'failed', lastPolledAt: now.toISOString() },
      ]
      return runFallbackChain(current, domain, now, 'snovio_quota', ctx)
    }
    if (poll.status === 'completed') {
      const candidates = normalizeSnovioProviderData(poll.data, domain)
      const merged = mergeSnovioCandidates(Array.isArray(current.contacts) ? current.contacts : [], candidates, String(current.id || ''))
      if (merged.added + merged.completed + merged.replacements.length > 0) {
        current.contacts = merged.contacts
        current.contactReplacementLog = [
          ...(Array.isArray(current.contactReplacementLog) ? current.contactReplacementLog : []),
          ...merged.replacements,
        ]
        // snovio_found 证据（与 search-api resume 同口径：先登记为未验证候选，进入 email_validation_queue 后由 DNS/MX 校验）
        const evidence = Array.isArray(current.emailVerificationEvidence) ? current.emailVerificationEvidence : []
        for (const contact of merged.contacts.filter((c: any) => c?.source === 'snovio_found' && c?.email)) {
          if (!evidence.some((e: any) => String(e?.email || '').toLowerCase() === String(contact.email || '').toLowerCase() && e?.result === 'snovio_found')) {
            evidence.push({ email: contact.email, result: 'snovio_found', scope: 'specific_email', source: 'snovio', method: 'domain_search', checkedAt: now.toISOString(), note: 'Snovio candidate; address not yet verified.' })
          }
        }
        current.emailVerificationEvidence = evidence
      }
      current.snovioDomainSearchTasks = [
        ...tasks.filter(t => t?.correlationId !== inProgressTask.correlationId),
        { ...inProgressTask, status: 'completed', rawResultStored: true, lastPolledAt: now.toISOString() },
      ]
      ctx.stats.found += merged.added
    } else if (poll.status === 'processing') {
      // 处理中 → 更新 lastPolledAt，不盖戳（下 tick 继续轮询直到完成）
      current.snovioDomainSearchTasks = [
        ...tasks.filter(t => t?.correlationId !== inProgressTask.correlationId),
        { ...inProgressTask, lastPolledAt: now.toISOString() },
      ]
      return { item: current }
    } else {
      current.snovioDomainSearchTasks = [
        ...tasks.filter(t => t?.correlationId !== inProgressTask.correlationId),
        { ...inProgressTask, status: 'failed', lastPolledAt: now.toISOString() },
      ]
      current.lastError = `contact_mining:poll:${poll.error || 'failed'}`
      // 临时性错误不盖戳 → 下 tick 重新 start 重试（任务已标 failed，会走无任务分支重新发起）
      if (isTransientError(poll.error || '')) return { item: current }
    }
  } else if (!alreadyMined) {
    // ── 无任务 → 开任务（start 即占一次配额） ──
    // 本批已确认 Snovio 配额尽 → 不再重复打 Snovio start，直接降级 Hunter → Prospeo
    if (ctx.batch.snovioQuotaExhausted) return runFallbackChain(current, domain, now, 'snovio_quota', ctx)
    const start = await client.startDomainSearch(domain, token)
    if (start.quotaExhausted) {
      ctx.batch.snovioQuotaExhausted = true
      return runFallbackChain(current, domain, now, 'snovio_quota', ctx)
    }
    if (start.ok) {
      const task = createSnovioTask({
        customerId: String(current.id || ''),
        domain,
        taskId: start.taskId,
        statusUrl: start.statusUrl,
        resultUrl: start.resultUrl,
        requestedAt: now.toISOString(),
      })
      if (replacementFor) (task as any).replacementForEmail = replacementFor
      // 新任务不盖戳、不 promote/restage（联系人尚无数据）：立即返回。
      // 盖戳会把该记录排除出下轮候选（stepperVersion !== version），搜索将永远不会被 poll。
      current.snovioDomainSearchTasks = [...tasks, task]
      return { item: current }
    } else {
      // Snovio start 认证失败（401/403）→ 自动降级；其余错误记 lastError（不触发降级）
      if (/401|403|auth|unauthorized|invalid|credential/i.test(start.error || '')) {
        return runFallbackChain(current, domain, now, 'snovio_auth', ctx)
      }
      current.lastError = `contact_mining:start:${start.error || 'failed'}`
      // 临时性错误（5xx/超时/fetch failed/网络）不盖戳 → 下 tick 重试，避免把可恢复错误盖成死戳
      if (isTransientError(start.error || '')) return { item: current }
    }
  }

  // ── 已挖过 / 已放行前 → 提升个人联系人 + 重算阶段（流出 contact_mining_queue） ──
  current = promotePersonalContact(current, domain, now)
  if (!hasUsablePersonalContact(current, domain, now) && !isPersonalSelected(current, domain, now)) {
    // 主公 2026-08-19 收窄：无个人邮箱时只提升 department 部门邮箱（能转发到相关负责人）。
    // public/location/nonbusiness 不提升、不放行。
    const roleEmail = findDevelopableRoleEmail(current, domain, now)
    if (roleEmail) {
      current.selectedEmail = roleEmail
      current.preferredEmail = roleEmail
    } else {
      const publicFallback = findPublicBusinessFallback(current, domain, now)
      if (publicFallback) {
        current.selectedEmail = publicFallback
        current.preferredEmail = publicFallback
        current.contactMiningStatus = 'public_business_fallback'
      } else {
        // 找不到联系人/邮箱不是公司级淘汰证据：保留在联系人补充池，等待后续渠道或额度恢复。
        current.contactMiningStatus = 'needs_contact'
        current.lastError = 'contact_mining:no_developable_email_yet'
        delete current.operationalTier
        if (current.exclusionReason === 'contact_mining:no_developable_email') delete current.exclusionReason
        delete current.contactMiningIsolationReason
      }
    }
  }
  const staged = ctx.applyStageFn(current, now).item
  const advanced = !['contact_mining_queue', 'replace_contact_queue'].includes(String(staged.primaryStage || staged.normalizedStage || ''))
  if (advanced) ctx.stats.found++
  // 已挖过但无个人邮箱结果（只挖到部门/公开邮箱）→ 清除认证失败标签，避免 authRetry 死循环
  if (!advanced && String(current.lastError || '').includes('snovio_auth_failed')) {
    current.lastError = 'contact_mining:no_personal_contact'
  }
  return { item: stamp(staged, ctx.version, now) }
}

/**
 * 后台自动消费联系人挖掘队列（默认每 tick ≤ 3 域名）。
 * 单条失败只记 lastError，不中断整批；Snovio 配额耗尽即停，返回 quotaExhausted=true。
 */
export async function runContactMiningAutoStep(
  now: Date,
  deps: ContactMiningAutoDeps = {},
): Promise<ContactMiningAutoStats> {
  const stats: ContactMiningAutoStats = { processed: 0, found: 0, quotaExhausted: false }
  const itemsStorePath = deps.itemsStorePath || ITEMS_STORE_FILE
  const version = deps.version || DEFAULT_VERSION
  const maxPerTick = deps.maxPerTick ?? DEFAULT_MAX_PER_TICK
  const effectiveNow = deps.now || now
  const creds = loadSnovioCredentials(deps)
  const client = deps.snovioClient || createDefaultSnovioClient(creds.userId, creds.secret)
  const hunterApiKey = loadHunterApiKey(deps)
  const serperApiKeys = loadSerperApiKeys(deps)
  const serperSearchFn = deps.serperSearchFn || serperDomainContactSearch
  const prospeoApiKey = loadProspeoApiKey(deps)
  const projectId = deps.projectId || getActiveProfile().primaryBusiness || 'furniture'
  const runBatchId = text(deps.runBatchId)
  const customerIds = deps.customerIds ? new Set([...deps.customerIds].map(text).filter(Boolean)) : null
  const batch = { snovioQuotaExhausted: false }
  const applyStageFn = deps.applyStageFn || ((item: any) => applyEligibilityStage(item, effectiveNow, {
    formalSentEmails: getFormalSentEmailsCached(),
    testMailVerdicts: getTestMailVerdictsCached(),
  }))

  let token: string | null = null
  try {
    token = await client.getToken()
  } catch { token = null }

  try {
    const items = readItemsAtomic(itemsStorePath)
    const candidates = items
      .filter((it: any) => {
        if (!inRequestedScope(it, projectId, runBatchId, customerIds)) return false
        const itemStage = String(it?.primaryStage || it?.normalizedStage || '')
        if (!['contact_mining_queue', 'replace_contact_queue'].includes(itemStage)) return false
        if (!isDevelopmentPriorityEligible(it)) return false
        const domain = getDomain(it)
        const usablePersonal = hasUsablePersonalContact(it, domain, effectiveNow)
        const selectedPersonal = isPersonalSelected(it, domain, effectiveNow)
        // 历史挖掘已写 contacts 但未提升 selectedEmail：直接领取并重算，不再调用外部供应商。
        if (usablePersonal && !selectedPersonal) return true
        const tasks = Array.isArray(it?.snovioDomainSearchTasks) ? it.snovioDomainSearchTasks : []
        const replacementFor = itemStage === 'replace_contact_queue' ? text(it?.selectedEmail).toLowerCase() : ''
        const serperCompleted = Array.isArray(it?.serperContactSearchTasks) && it.serperContactSearchTasks.some((task: any) => task?.provider === 'serper' && task?.status === 'completed' && (!replacementFor || text(task?.replacementForEmail).toLowerCase() === replacementFor))
        if (serperApiKeys.length > 0 && !serperCompleted && !usablePersonal && !selectedPersonal) return true
        // 已挖过（snovio completed）：不再重复挖。
        //  - 已有个人联系人 → 排除（正常流程已放行）；
        //  - 无可开发部门邮箱（完全无邮箱 / 只有 public/location/nonbusiness）→ 排除（数据修复已隔离，代码不重复挖）；
        //  - 有可开发部门邮箱（department：purchasing@/buyer@ 等）→ 放行进入 processOne，设置 selectedEmail + 重算放行
        //    （主公 2026-08-19 收窄：只有 department 放行，public/location 不提升、打回或隔离）。
        if (tasks.some((t: any) => t?.provider === 'snovio' && t?.status === 'completed')) {
          if (usablePersonal || selectedPersonal) return itemStage === 'replace_contact_queue'
          return Boolean(findDevelopableRoleEmail(it, domain, effectiveNow)) && (itemStage === 'replace_contact_queue' || it?.stepperVersion !== version)
        }
        if (usablePersonal || selectedPersonal) return itemStage === 'replace_contact_queue'
        const err = String(it?.lastError || '')
        const authRetry = err.includes('snovio_auth_failed') // 凭据缺失导致的失败，凭据恢复后允许重试
        return it?.stepperVersion !== version || authRetry
      })
      .sort((a: any, b: any) => miningPriority(b) - miningPriority(a))
      .slice(0, maxPerTick)
    if (candidates.length === 0) return stats

    const pending: Array<{ id: string; item: any }> = []
    for (const item of candidates) {
      stats.processed++
      const domain = getDomain(item)
      try {
        const result = await processOne(item, effectiveNow, { version, domain, client, token, serperApiKeys, serperSearchFn, hunterApiKey, prospeoApiKey, batch, stats, applyStageFn })
        if (result.quotaExhausted) {
          stats.quotaExhausted = true
          break // 配额耗尽：先写已处理的，再停批
        }
        pending.push({ id: item.id, item: result.item })
      } catch (err) {
        pending.push({
          id: item.id,
          item: stamp({ ...item, lastError: `contact_mining:${err instanceof Error ? err.message : String(err)}` }, version, effectiveNow),
        })
      }
    }

    for (const { id, item } of pending) {
      try {
        updateOneItemAtomic(id, () => item, itemsStorePath)
      } catch (err) {
        try {
          updateOneItemAtomic(id, (cur) => ({
            ...cur,
            lastError: `contact_mining:write:${err instanceof Error ? err.message : String(err)}`,
            updatedAt: effectiveNow.toISOString(),
          }), itemsStorePath)
        } catch { /* swallow */ }
      }
    }
  } catch (err) {
    if (deps.lastError && typeof deps.lastError === 'object') {
      deps.lastError.contactMining = err instanceof Error ? err.message : String(err)
    }
  }
  return stats
}
