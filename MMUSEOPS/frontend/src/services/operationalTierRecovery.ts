import { roleEmailClass, FREE_DOMAINS } from './emailClassification'
import type { PipelineItem } from '../types/item'

export type OperationalTier =
  | 'priority_development'
  | 'standard_development'
  | 'public_email_outreach'
  | 'free_business_email_outreach'
  | 'low_priority_nurture'
  | 'data_enrichment_needed'
  | 'followup_queue'
  | 'replied_queue'
  | 'replace_contact_queue'
  | 'manual_review'
  | 'true_excluded'

export interface OperationalTierDecision {
  tier: OperationalTier
  reason: string
  emailType: 'personal_company_email' | 'department_business_email' | 'public_email' | 'free_business_email' | 'none'
  businessBand: 'high' | 'medium' | 'low' | 'unknown'
}

export interface OperationalTierRecoveryReport {
  sourceInactive: number
  restoredTotal: number
  keptTrueExcluded: number
  newlyExcludedOutsideSource: number
  restoredByTier: Record<string, number>
  allTiers: Record<string, number>
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const BAD_SOURCE = /directory|yellow\s*pages?|news|blog|ranking|top\s*\d+|marketplace|facebook|instagram|linkedin|pinterest|youtube|privacy\s*policy|market\s*report|tradekey|kompass|yelp/i
const GENERIC_COMPANY = /^(privacy policy|photos?|contact|about us|home|top\s*\d+|market report|unknown|n\/a|untitled)$/i
const NEGATIVE = /suppressed|complained|do_not_contact/i
const HARD_FAILURE = /bounced|failed|smtp_handshake_fail|format_invalid|dns_failed|no_mx|domain_unreachable/i

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : ''

function normalizeEmail(value: unknown): string {
  const email = text(value).toLowerCase()
  return EMAIL_RE.test(email) ? email : ''
}

function emailsFor(item: PipelineItem): string[] {
  const current = item as any
  const values: unknown[] = [item.email]
  for (const contact of Array.isArray(current.contacts) ? current.contacts : []) values.push(contact?.email)
  for (const contact of Array.isArray(item.backCheck?.decisionMakers) ? item.backCheck!.decisionMakers : []) values.push(contact?.email)
  return [...new Set(values.map(normalizeEmail).filter(Boolean))]
}

function classifyEmail(email: string): OperationalTierDecision['emailType'] {
  if (!email) return 'none'
  const domain = email.split('@')[1] || ''
  if (FREE_DOMAINS.has(domain)) return 'free_business_email'
  const cls = roleEmailClass(email)
  if (cls === 'department') return 'department_business_email'
  if (cls === 'public' || cls === 'location' || cls === 'nonbusiness') return 'public_email'
  return 'personal_company_email'
}

function hasContact(item: PipelineItem): boolean {
  const current = item as any
  if (text(item.contactName)) return true
  if ((current.contacts || []).some((contact: any) => text(contact?.name) || text(contact?.title) || normalizeEmail(contact?.email))) return true
  const decisionMakers = Array.isArray(item.backCheck?.decisionMakers) ? item.backCheck!.decisionMakers : []
  return Boolean(decisionMakers.some(contact => text(contact.name) || text(contact.title) || normalizeEmail(contact.email)))
}

function hasReliableDomain(item: PipelineItem): boolean {
  try {
    const value = text(item.website)
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`)
    return url.hostname.includes('.')
  } catch {
    return false
  }
}

function evidenceText(item: PipelineItem): string {
  return (item.emailVerificationEvidence || [])
    .map(entry => `${entry.result || ''} ${entry.status || ''} ${(entry as any).providerLastEvent || ''} ${entry.webhookEventType || ''}`)
    .join(' ')
}

function hasReply(item: PipelineItem): boolean {
  return item.replyQueue === 'replied_queue'
    || item.developmentStatus === 'replied'
    || Boolean(item.emailLogs?.some(log => log.status === 'replied'))
}

function hasFormalSend(item: PipelineItem): boolean {
  return item.developmentStatus === 'sent'
    || Boolean(item.emailLogs?.some(log => log.status === 'sent' && (log as any).type !== 'test_handshake'))
}

function hasHardFailure(item: PipelineItem): boolean {
  return item.emailBounced === true
    || item.replyQueue === 'bounced_queue'
    || HARD_FAILURE.test(evidenceText(item))
    || Boolean(item.emailLogs?.some(log => log.status === 'bounced' || (log as any).status === 'failed'))
}

function hasDoNotContact(item: PipelineItem): boolean {
  return item.doNotContactEmail === true
    || item.doNotDevelop === true
    || item.reviewDisposition === 'do_not_develop'
    || Boolean(item.emailVerificationRouting?.some(route => route.queue === 'do_not_contact'))
    || NEGATIVE.test(evidenceText(item))
}

function businessBand(item: PipelineItem): OperationalTierDecision['businessBand'] {
  const match = text((item as any).businessMatch).toLowerCase()
  const value = text((item as any).importCommercialValue).toLowerCase()
  if (match === 'high' && ['high', 'medium'].includes(value)) return 'high'
  if (['high', 'medium'].includes(match) && ['high', 'medium', 'low'].includes(value)) return 'medium'
  if (match === 'low' || (value === 'low' && !['high', 'medium'].includes(match))) return 'low'
  return 'unknown'
}

export function classifyOperationalTier(item: PipelineItem): OperationalTierDecision {
  const current = item as any
  const emails = emailsFor(item)
  const emailType = classifyEmail(emails[0] || '')
  const band = businessBand(item)
  const domain = hasReliableDomain(item)
  const company = text(item.company || item.title)
  const clearCompany = company.length >= 3 && !GENERIC_COMPANY.test(company)
  const combinedSource = [item.source, item.company, item.title, item.website, item.snippet].map(text).join(' ')
  const explicitIrrelevant = current.businessMatch === 'none' || current.importCommercialValue === 'none' || BAD_SOURCE.test(combinedSource)
  const duplicate = Boolean(current.duplicateOf || current.duplicateIndex === true)
  const garbage = !clearCompany && !domain && emails.length === 0
  const failure = hasHardFailure(item)
  const valuable = band === 'high' || band === 'medium'
  const related = valuable || band === 'low'

  if (hasDoNotContact(item) || duplicate || explicitIrrelevant || garbage || (failure && !valuable && emails.length <= 1)) {
    const reason = hasDoNotContact(item) ? 'suppressed_complained_or_do_not_contact'
      : duplicate ? 'duplicate'
        : explicitIrrelevant ? 'irrelevant_or_bad_source'
          : garbage ? 'no_subject_garbage'
            : 'unreachable_without_value'
    return { tier: 'true_excluded', reason, emailType, businessBand: band }
  }
  if (hasReply(item)) return { tier: 'replied_queue', reason: 'real_reply', emailType, businessBand: band }
  if (failure) return { tier: 'replace_contact_queue', reason: 'current_email_unreachable', emailType, businessBand: band }
  if (hasFormalSend(item)) return { tier: 'followup_queue', reason: valuable ? 'sent_no_negative_high_or_medium_value' : 'sent_no_negative', emailType, businessBand: band }
  if (valuable && emails.length === 0) {
    const reason = 'missing_email'
    return { tier: 'data_enrichment_needed', reason, emailType, businessBand: band }
  }
  if (emailType === 'public_email' && valuable) return { tier: 'public_email_outreach', reason: 'matched_public_business_mailbox_request_forwarding', emailType, businessBand: band }
  if (emailType === 'free_business_email' && valuable) return { tier: 'free_business_email_outreach', reason: 'matched_free_business_email', emailType, businessBand: band }
  if (emailType === 'personal_company_email' && band === 'high' && clearCompany && domain) {
    return { tier: 'priority_development', reason: 'high_value_personal_company_email', emailType, businessBand: band }
  }
  if (valuable && emails.length > 0 && clearCompany) {
    return { tier: 'standard_development', reason: emailType === 'department_business_email' ? 'department_outreach' : 'standard_matched_outreach', emailType, businessBand: band }
  }
  if (related) return { tier: 'low_priority_nurture', reason: 'business_related_lower_priority', emailType, businessBand: band }
  return { tier: 'manual_review', reason: 'uncertain_business_value_or_identity', emailType, businessBand: band }
}

function nextAction(tier: OperationalTier): string {
  const actions: Record<OperationalTier, string> = {
    priority_development: '人工审核一对一开发信草稿',
    standard_development: '人工审核标准开发信草稿',
    public_email_outreach: '人工审核转交采购或项目负责人的开发信草稿',
    free_business_email_outreach: '人工确认身份后审核谨慎开发信草稿',
    low_priority_nurture: '保留为低优先培育资产，不计入今日高优先任务',
    data_enrichment_needed: '补充联系人、邮箱或可靠域名',
    followup_queue: '人工登录Zoho检查回复并按节奏跟进',
    replied_queue: '人工处理真实回复',
    replace_contact_queue: '更换联系人或邮箱，禁止使用当前不可达邮箱',
    manual_review: '人工复核主体、来源和业务价值',
    true_excluded: '保留去重和历史记录，禁止恢复',
  }
  return actions[tier]
}

export function applyOperationalTierRestore(
  inputItems: PipelineItem[],
  now = new Date(),
): { items: PipelineItem[]; report: OperationalTierRecoveryReport } {
  const restoredByTier: Record<string, number> = {}
  const allTiers: Record<string, number> = {}
  let sourceInactive = 0
  let restoredTotal = 0
  let keptTrueExcluded = 0
  let newlyExcludedOutsideSource = 0
  const restoredAt = now.toISOString()

  const items = inputItems.map(item => {
    const current = item as any
    const decision = classifyOperationalTier(item)
    allTiers[decision.tier] = (allTiers[decision.tier] || 0) + 1
    const wasInactive = current.inactiveWorkflow === true || current.activeWorkflow === false
    if (wasInactive) sourceInactive += 1

    if (decision.tier === 'true_excluded') {
      if (wasInactive) keptTrueExcluded += 1
      else newlyExcludedOutsideSource += 1
      if (current.operationalTier === 'true_excluded'
        && current.normalizedStage === 'true_excluded'
        && current.activeWorkflow === false
        && current.inactiveWorkflow === true) return item
      return {
        ...current,
        operationalTier: 'true_excluded',
        operationalTierReason: decision.reason,
        normalizedStage: 'true_excluded',
        currentAllowedStage: 'true_excluded',
        nextRequiredAction: nextAction('true_excluded'),
        activeWorkflow: false,
        inactiveWorkflow: true,
      } as PipelineItem
    }

    if (!wasInactive) return item

    if (current.restoredBy === 'system_customer_tiering_restore_v1'
      && current.operationalTier === decision.tier
      && current.normalizedStage === decision.tier
      && current.activeWorkflow === true
      && current.inactiveWorkflow === false) return item

    restoredTotal += 1
    restoredByTier[decision.tier] = (restoredByTier[decision.tier] || 0) + 1
    const previousStage = text(current.normalizedStage || current.currentAllowedStage) || 'inactive_excluded'
    const result: any = {
      ...current,
      operationalTier: decision.tier,
      operationalTierReason: decision.reason,
      emailStrategy: decision.emailType,
      normalizedStage: decision.tier,
      currentAllowedStage: decision.tier,
      nextRequiredAction: nextAction(decision.tier),
      activeWorkflow: true,
      inactiveWorkflow: false,
      restoreReason: 'customer_tiering_restore_v1',
      restoredAt,
      restoredBy: 'system_customer_tiering_restore_v1',
      previousStage,
      eligibilityUpdatedAt: restoredAt,
      updatedAt: restoredAt,
    }
    if (decision.tier === 'followup_queue') result.replyCheckMode = 'manual_zoho_login'
    if (decision.tier === 'replace_contact_queue') result.currentEmailUseBlocked = true
    if (['priority_development', 'standard_development', 'public_email_outreach', 'free_business_email_outreach'].includes(decision.tier)) {
      result.requiredDraftStatus = 'pending_human_review'
    }
    if (decision.tier === 'public_email_outreach') result.outreachCopyStrategy = 'request_forward_to_procurement_project_owner'
    return result as PipelineItem
  })

  return {
    items,
    report: { sourceInactive, restoredTotal, keptTrueExcluded, newlyExcludedOutsideSource, restoredByTier, allTiers },
  }
}



