import type { PipelineItem } from '../types/item'
import { summarizeManualReplyWork } from './manualReplyMode'
import { classifyEmailQuality } from './emailQualityPolicy'
import { isEmailBounced } from './emailBounce'

interface WorkbenchSearchSession { searchedAt: string }

type WorkbenchItem = PipelineItem & {
  customerType?: string
  customerTypeAssessment?: string
  businessMatch?: string
  importCommercialValue?: string
  recommendedAction?: string
  backcheckReason?: string
  backcheckRecommendationReason?: string
}

export interface WorkbenchLead {
  id: string
  company: string
  country: string
  customerType: string
  businessMatch: string
  importCommercialValue: string
  reason: string
  action: string
  path: string
  email?: string
  emailType?: string
  priority?: string
  dnsStatus?: string
  providerStatus?: string
  observationStartedAt?: string
  observationEndsAt?: string
  source?: string
}

export interface DailyWorkbenchSummary {
  generatedAt: string
  reviewQueue: WorkbenchLead[]
  validationQueue: WorkbenchLead[]
  contactMiningQueue: WorkbenchLead[]
  snovioPriorityQueue: WorkbenchLead[]
  watchingQueue: WorkbenchLead[]
  bouncedQueue: WorkbenchLead[]
  counts: {
    pendingDrafts: number
    sendReady: number
    formalSentToday: number
    followup3Day: number
    followup7Day: number
    repliesPending: number
    bouncesPending: number
    manualZohoReplyChecks: number
    followupsDueToday: number
    high: number
    medium: number
    low: number
    none: number
    unknown: number
    deferredOrExcluded: number
  }
  apiLedger: {
    resendTestMailUsed: number
    resendRemaining: number
    resendReadQueries: number
    snovioCalls: number
    snovioCredits: 'unknown'
    searchCalls: number
    dnsQueries: number
    alerts: string[]
  }
  backcheckGaps: {
    totalIncomplete: number
    canAutoBackcheck: number
    needsSourceEnrichment: number
    needsHumanReview: number
    completeCanProceed: number
    completeMissingContacts: number
  }
  incompleteTasks: Array<{ label: string; count: number; path: string }>
  tomorrowTasks: string[]
}

const valueRank: Record<string, number> = { high: 5, medium: 4, low: 3, unknown: 2, none: 1 }
const normalize = (value: unknown) => typeof value === 'string' ? value.trim() : ''
const list = <T>(value: unknown): T[] => Array.isArray(value) ? value : []
const dayKey = (value: unknown) => {
  const date = new Date(String(value || 0))
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }) : ''
}
const isFormalOutreachLog = (log: any) => log?.type === 'formal_outreach' || (log?.provider === 'zoho_smtp' && log?.source !== 'isolated_test_mail_queue')

function emails(item: PipelineItem): string[] {
  const values = [
    item.email,
    ...list<any>((item as any).contacts).map(entry => entry?.email),
    ...list<any>(item.backCheck?.decisionMakers).map(entry => entry?.email),
  ]
  return [...new Set(values.map(value => normalize(value).toLowerCase()).filter(value => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)))]
}

function domain(item: PipelineItem): string {
  try { return new URL(normalize(item.website)).hostname.toLowerCase().replace(/^www\./, '') } catch { return '' }
}

function emailType(email: string): string {
  return classifyEmailQuality({ email }).emailType
}

function latestEvidenceByMessage(item: PipelineItem): any[] {
  const seen = new Set<string>()
  const latest: any[] = []
  for (const evidence of [...list<any>(item.emailVerificationEvidence)].reverse()) {
    const key = normalize(evidence?.testMessageId) || `${normalize(evidence?.email)}:${normalize(evidence?.result)}`
    if (!key || seen.has(key)) continue
    seen.add(key)
    latest.push(evidence)
  }
  return latest
}

function lead(item: WorkbenchItem, extra: Partial<WorkbenchLead> = {}): WorkbenchLead {
  return {
    id: item.id,
    company: item.company || item.title || '未命名客户',
    country: item.country || '未标注',
    customerType: item.customerType || item.customerTypeAssessment || item.clientType || 'unknown',
    businessMatch: item.businessMatch || item.importCommercialValue || 'unknown',
    importCommercialValue: item.importCommercialValue || 'unknown',
    reason: item.backcheckReason || item.backcheckRecommendationReason || item.reviewReason || '需人工核查',
    action: item.recommendedAction || 'manual_review',
    path: `/item/${encodeURIComponent(item.id)}`,
    source: normalize((item as any).sourceType || item.source) || 'unknown',
    ...extra,
  }
}

function candidateScore(item: WorkbenchItem): number {
  let score = item.importCommercialValue === 'high' ? 100 : item.importCommercialValue === 'medium' ? 75 : 0
  if (emails(item).length > 0) score += 25
  if (normalize(item.country)) score += 5
  if (normalize(item.backCheck?.summary)) score += 5
  return score
}

function sortValue(a: WorkbenchItem, b: WorkbenchItem): number {
  return candidateScore(b) - candidateScore(a)
}

export function buildDailyWorkbench(
  rawItems: PipelineItem[],
  searchSessions: WorkbenchSearchSession[] = [],
  now = new Date(),
): DailyWorkbenchSummary {
  const items = rawItems as WorkbenchItem[]
  const today = dayKey(now)
  // 直接用服务器已算好的 stage 印章（applyEligibilityStage 写入 primaryStage），
  // 避免在浏览器对 2448 条重算 getLeadStageEligibility（~90ms/条 → 分钟级卡死）
  const stageOf = (item: PipelineItem) => String((item as any)?.primaryStage || (item as any)?.normalizedStage || (item as any)?.operationalTier || '')
  // 已正式发信客户（含 stage 印章滞后的"分身"记录）不再进开发池候选（联系人挖掘/邮箱验证）
  const notFormalSent = (item: PipelineItem) => (item as any)?.developmentStatus !== 'sent' && (item as any)?.formalBounce !== true
  // 铁律：明确退信客户不出现在跟进/待开发/候选列表；只进入「退信/换联系人」视图
  const nonBounced = (item: PipelineItem) => !isEmailBounced(item)
  const activeItems = items.filter(item => item.activeWorkflow !== false
    && item.normalizedStage !== 'inactive_excluded'
    && item.normalizedStage !== 'low_priority_nurture'
    && item.operationalTier !== 'low_priority_nurture'
    && !['low_priority_nurture', 'true_excluded'].includes(stageOf(item)))
  const reviewQueue = activeItems
    .filter(item => nonBounced(item) && ['backcheck_queue', 'data_enrichment_needed', 'manual_review'].includes(stageOf(item)))
    .sort(sortValue)
    .slice(0, 50)
    .map(item => lead(item))
  const usedDomains = new Set<string>()
  const validationQueue: WorkbenchLead[] = []
  const contactMiningQueue: WorkbenchLead[] = []
  for (const item of activeItems.filter(item => nonBounced(item) && stageOf(item) === 'email_validation_queue' && notFormalSent(item)).sort(sortValue)) {
    const itemDomain = domain(item)
    const itemEmails = emails(item)
    const domainAlreadySeen = !itemDomain || usedDomains.has(itemDomain)
    if (itemDomain && !usedDomains.has(itemDomain)) usedDomains.add(itemDomain)
    if (itemEmails.length === 0) {
      contactMiningQueue.push(lead(item, { action: 'contact_mining' }))
      continue
    }
    if (domainAlreadySeen || validationQueue.length >= 95) continue
    const address = itemEmails[0]
    const dns = [...list<any>(item.emailVerificationEvidence)].reverse().find(entry =>
      normalize(entry?.email).toLowerCase() === address && entry?.source === 'dns_mx'
    )
    validationQueue.push(lead(item, {
      email: address,
      emailType: emailType(address),
      dnsStatus: dns?.result || '未检查',
      priority: item.importCommercialValue === 'high' ? '高' : '中',
      action: 'dns_then_resend',
    }))
  }

  for (const item of activeItems.filter(item => nonBounced(item) && stageOf(item) === 'contact_mining_queue' && notFormalSent(item)).sort(sortValue)) {
    contactMiningQueue.push(lead(item, { action: 'contact_mining' }))
  }

  const contactUniqueDomains = new Set<string>()
  const snovioPriorityQueue = contactMiningQueue.filter(entry => {
    const item = items.find(candidate => candidate.id === entry.id)
    const itemDomain = item ? domain(item) : ''
    if (!itemDomain || contactUniqueDomains.has(itemDomain)) return false
    contactUniqueDomains.add(itemDomain)
    return true
  }).slice(0, 20)

  const watchingQueue: WorkbenchLead[] = []
  const bouncedQueue: WorkbenchLead[] = []
  // 退信客户（emailBounced 实时标记）即使 stage 印章滞后也要进「退信/换联系人」视图，
  // 且绝不出现在「观察」等非退信视图。
  for (const item of activeItems.filter(item => isEmailBounced(item) || ['observation_queue', 'replace_contact_queue'].includes(stageOf(item)))) {
    const isBounced = isEmailBounced(item)
    const evidenceRows = latestEvidenceByMessage(item)
    if (isBounced && evidenceRows.length === 0) {
      const fallbackEmail = normalize(item.email)
      bouncedQueue.push(lead(item, {
        email: fallbackEmail,
        emailType: emailType(fallbackEmail),
        providerStatus: 'returned_for_contact_replacement',
        action: 'replace_contact',
      }))
    }
    for (const evidence of evidenceRows) {
      if (isBounced) {
        bouncedQueue.push(lead(item, {
          email: normalize(evidence.email),
          emailType: emailType(normalize(evidence.email)),
          providerStatus: normalize(evidence.providerLastEvent) || 'bounced',
          action: 'replace_contact',
        }))
      }
      if (isBounced || stageOf(item) !== 'observation_queue') continue
      watchingQueue.push(lead(item, {
        email: normalize(evidence.email),
        emailType: emailType(normalize(evidence.email)),
        providerStatus: normalize(evidence.providerLastEvent) || 'watching',
        observationStartedAt: evidence.observationWindowStartedAt,
        observationEndsAt: evidence.observationWindowEndsAt,
        action: 'wait_observation',
      }))
    }
  }

  const allEvidence = items.flatMap(item => list<any>(item.emailVerificationEvidence))
  const resendTestMailUsed = allEvidence.filter(entry => entry?.result === 'test_sent' && dayKey(entry.checkedAt) === today).length
  const recoveryChecks = allEvidence.filter(entry => dayKey(entry?.lastRecoveryCheckedAt) === today).length
  const snovioTasks = items.flatMap(item => list<any>(item.snovioDomainSearchTasks))
  const snovioCalls = snovioTasks.filter(task => dayKey(task?.requestedAt) === today).length
  const dnsQueries = allEvidence.filter(entry => entry?.source === 'dns_mx' && dayKey(entry.checkedAt) === today).length
  const searchCalls = searchSessions.filter(session => dayKey(session.searchedAt) === today).length
  const pendingDrafts = activeItems.filter(nonBounced).reduce((count, item) =>
    count + Number(list<any>(item.manualEmailDrafts).some(draft => draft?.status === 'pending_human_review' && draft?.sent === false)), 0)
  const formalLogs = activeItems.filter(nonBounced).flatMap(item => list<any>(item.emailLogs)).filter(isFormalOutreachLog)
  const sendReady = activeItems.filter(nonBounced).filter(item => stageOf(item) === 'scheduled_send_queue').length
  const formalSentToday = formalLogs.filter(log => log?.status === 'sent' && dayKey(log?.sentAt) === today).length
  const repliesPending = activeItems.filter(nonBounced).filter(item =>
    item.developmentStatus === 'replied' || list<any>(item.emailLogs).some(log => log?.status === 'replied')).length
  const bouncesPending = activeItems.filter(item =>
    item.emailBounced || latestEvidenceByMessage(item).some(entry => entry?.result === 'bounced_test')).length
  const manualReplyWork = summarizeManualReplyWork(activeItems.filter(nonBounced), now)

  const sentDates = formalLogs.filter(log => log?.status === 'sent').map(log => new Date(log.sentAt))
  const ageDays = (date: Date) => Math.floor((now.getTime() - date.getTime()) / 86_400_000)
  const followup3Day = sentDates.filter(date => ageDays(date) >= 3 && ageDays(date) < 7).length
  const followup7Day = sentDates.filter(date => ageDays(date) >= 7).length
  const valueCount = (value: string) => activeItems.filter(nonBounced).filter(item => item.importCommercialValue === value).length
  const alerts = [
    ...(100 - resendTestMailUsed <= 10 ? [`Resend剩余额度仅${Math.max(0, 100 - resendTestMailUsed)}封`] : []),
    ...(snovioCalls > 0 ? ['Snovio产出需结合联系人质量人工复核'] : ['Snovio今日未调用']),
    ...(watchingQueue.length > 0 ? [`${watchingQueue.length}条测试信仍在观察期`] : []),
  ]
  // 背调缺口统计
  let gapsCanAutoBackcheck=0,gapsNeedsSource=0,gapsNeedsReview=0,completeCanProceed=0,completeMissingContacts=0
  for(const item of activeItems.filter(nonBounced)){const stage=stageOf(item)
    if(stage==='backcheck_queue'){if(normalize(item.website))gapsCanAutoBackcheck++;else gapsNeedsSource++;continue}
    if(stage==='data_enrichment_needed'){gapsNeedsSource++;continue}
    if(stage==='manual_review'){gapsNeedsReview++;continue}
    if(stage==='contact_mining_queue'){completeMissingContacts++;continue}
    if(['email_validation_queue','observation_queue','developable_email_pool','pending_draft_review','scheduled_send_queue','followup_queue','replied_queue'].includes(stage)){completeCanProceed++;continue}
  }
  const backcheckGaps={totalIncomplete:gapsCanAutoBackcheck+gapsNeedsSource+gapsNeedsReview,canAutoBackcheck:gapsCanAutoBackcheck,needsSourceEnrichment:gapsNeedsSource,needsHumanReview:gapsNeedsReview,completeCanProceed,completeMissingContacts}
  const incompleteTasks = [
    { label: '重点背调待确认', count: reviewQueue.length, path: '/daily-workbench#review' },
    { label: '可直接验证但未验证', count: validationQueue.length, path: '/daily-workbench#validation' },
    { label: '需要补联系人', count: contactMiningQueue.length, path: '/daily-workbench#contacts' },
    { label: '邮箱观察未到期', count: watchingQueue.length, path: '/daily-workbench#watching' },
    { label: '草稿待人工审核', count: pendingDrafts, path: '/email-batch' },
    { label: '需人工登录Zoho检查回复', count: manualReplyWork.manualReplyCheckCustomers, path: '/daily-workbench#manual-zoho' },
    { label: '今天应跟进客户', count: manualReplyWork.followupsDueToday, path: '/email-batch' },
  ]
  const tomorrowTasks = [
    `人工审核${reviewQueue.length}条重点客户`,
    `从${contactUniqueDomains.size}家独立域名中优先选择${snovioPriorityQueue.length}家补联系人`,
    `对${validationQueue.length}条现成邮箱执行DNS/MX与隔离测试`,
    `继续同步${watchingQueue.length}条观察记录`,
    '出现观察期内未观察到退信或已观察到回复证据后，再生成草稿候选',
    '现有数据库产出不足前不继续搜索新客户',
  ]

  return {
    generatedAt: now.toISOString(),
    reviewQueue,
    validationQueue,
    contactMiningQueue,
    snovioPriorityQueue,
    watchingQueue,
    bouncedQueue,
    counts: {
      pendingDrafts,
      sendReady,
      formalSentToday,
      followup3Day,
      followup7Day,
      repliesPending,
      bouncesPending,
      manualZohoReplyChecks: manualReplyWork.manualReplyCheckCustomers,
      followupsDueToday: manualReplyWork.followupsDueToday,
      high: valueCount('high'),
      medium: valueCount('medium'),
      low: valueCount('low'),
      none: valueCount('none'),
      unknown: valueCount('unknown'),
      deferredOrExcluded: valueCount('low') + valueCount('none'),
    },
    apiLedger: {
      resendTestMailUsed,
      resendRemaining: Math.max(0, 100 - resendTestMailUsed),
      resendReadQueries: recoveryChecks + (recoveryChecks > 0 ? 1 : 0),
      snovioCalls,
      snovioCredits: 'unknown',
      searchCalls,
      dnsQueries,
      alerts,
    },
    backcheckGaps,
    incompleteTasks,
    tomorrowTasks,
  }
}

