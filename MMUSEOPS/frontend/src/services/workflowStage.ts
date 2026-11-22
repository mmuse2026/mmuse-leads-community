/**
 * @deprecated 旧工作台 stage 体系（search_new/backcheck_queue/contact_mining/...），已被
 * leadStageEligibility（primaryStage）取代。仍被 emailCandidateView.test.ts /
 * persistedDraftEligibility.test.ts 引用（工作台展示与测试辅助），为不破坏编译暂保留。
 * 新逻辑一律走 leadStageEligibility；清理时先解除这两处引用再删除本文件。
 */
import type {
  PipelineItem,
  EmailVerification,
  EmailVerificationEvidence,
  EmailVerificationQueue,
} from '../types/item'
import { buildEmailCandidateRows, collectEmailCandidates, deriveAddressVerificationState, selectPreferredEmail } from './emailCandidateView'
import { classifyEmailQuality } from './emailQualityPolicy'

export type WorkflowStageKey =
  | 'search_new'
  | 'backcheck_queue'
  | 'contact_mining'
  | 'email_verification'
  | 'development_ready'
  | 'followup_sent'
  | 'replied'
  | 'bounced'
  | 'invalid'
  | 'archived'
  | 'data_issue'

export const WORKFLOW_STAGE_LABELS: Record<WorkflowStageKey, string> = {
  search_new: '搜索池',
  backcheck_queue: '背调池',
  contact_mining: '联系人挖掘',
  email_verification: '邮箱验证',
  development_ready: '待开发',
  followup_sent: '跟进中',
  replied: '已回复',
  bounced: '退信',
  invalid: '无效',
  archived: '归档',
  data_issue: '数据异常',
}

export function getItemEmails(item: PipelineItem): string[] {
  return collectEmailCandidates(item)
    .filter(candidate => candidate.normalizedEmail && classifyEmailQuality(candidate).tier !== 'E')
    .map(candidate => candidate.normalizedEmail)
}

export function getPrimaryEmail(item: PipelineItem, now = new Date()): string {
  const rows = buildEmailCandidateRows(item, now)
  const explicit = item.selectedEmail ? selectPreferredEmail(rows, item.selectedEmail) : undefined
  if (explicit) return explicit.normalizedEmail
  const usableRows = rows.filter(row => row.tier !== 'E')
  return selectPreferredEmail(usableRows, item.email)?.normalizedEmail || ''
}

export function hasUsableEmail(item: PipelineItem): boolean {
  return getItemEmails(item).length > 0
}

export function isPublicEmail(email: string): boolean {
  const normalized = String(email || '').trim().toLowerCase()
  const domain = normalized.split('@')[1] || ''
  const type = classifyEmailQuality({ email: normalized, canonicalDomain: domain }).emailType
  return type === 'public' || type === 'department'
}

export function hasPersonalEmail(item: PipelineItem): boolean {
  return buildEmailCandidateRows(item).some(row => row.tier !== 'E' && row.emailType === 'personal_company')
}
export function hasBackcheck(item: PipelineItem): boolean {
  return item.backcheckStatus === 'done' || Boolean(item.backCheck)
}

export function hasContactLead(item: PipelineItem): boolean {
  if ((item.contactName || '').trim()) return true
  const contacts = Array.isArray((item as any).contacts) ? (item as any).contacts : []
  if (contacts.some((c: any) => c?.name || c?.email || c?.title)) return true
  return Boolean(item.backCheck?.decisionMakers?.some(dm => dm.name || dm.email || dm.title))
}

function latestEmailStatus(item: PipelineItem): EmailVerification {
  return item.emailVerification || 'unknown'
}

export function hasSentEmail(item: PipelineItem): boolean {
  return item.developmentStatus === 'sent' || Boolean(item.emailLogs?.length)
}

export function hasReply(item: PipelineItem): boolean {
  return item.developmentStatus === 'replied' || Boolean(item.emailLogs?.some(log => log.status === 'replied'))
}

export function hasBounce(item: PipelineItem, now = new Date()): boolean {
  const selected = getPrimaryEmail(item, now)
  return Boolean(selected && deriveAddressVerificationState(item, selected, now) === 'bounced')
}

export function isReadyEmailStatus(status: EmailVerification): boolean {
  return status === 'verified' || status === 'catchall'
}

const BLOCKING_RESULTS = new Set(['format_invalid', 'smtp_handshake_fail', 'bounced_test'])

export function isReachabilityEvidenceAccepted(evidence: EmailVerificationEvidence, now = new Date()): boolean {
  if (evidence.result === 'smtp_handshake_pass' || evidence.result === 'reply_observed' || evidence.result === 'specific_email_verified') return true
  if (evidence.result !== 'no_bounce_observed') return false
  const start = Date.parse(evidence.observationWindowStartedAt || evidence.observationStartedAt || '')
  const end = Date.parse(evidence.observationWindowEndsAt || evidence.observationEndedAt || '')
  return Number.isFinite(start) && Number.isFinite(end) && end > start && end <= now.getTime()
}

function emailEvidence(item: PipelineItem, email: string): EmailVerificationEvidence[] {
  const normalized = email.trim().toLowerCase()
  return (item.emailVerificationEvidence || [])
    .filter(evidence => String(evidence.email || evidence.recipientEmail || evidence.address || '').trim().toLowerCase() === normalized)
    .sort((a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt))
}

export interface EmailVerificationRoute {
  queue: EmailVerificationQueue
  reason: string
}

export function getEmailVerificationRoute(
  item: PipelineItem,
  email: string = getPrimaryEmail(item),
  now = new Date(),
): EmailVerificationRoute {
  const evidence = emailEvidence(item, email)
  const latest = evidence[0]
  if (!latest) return { queue: 'retry_queue', reason: '?????????' }

  if (latest.result === 'format_invalid' || latest.result === 'dns_failed' || latest.result === 'no_mx') {
    return { queue: 'unreachable', reason: '???????????' }
  }
  if (latest.result === 'smtp_handshake_fail' || latest.result === 'bounced_test') {
    return { queue: 'unreachable', reason: '???????????' }
  }
  if (latest.result === 'test_sent' || latest.recoveryStatus === 'watching') {
    return { queue: 'observation_queue', reason: '???????????????' }
  }
  if (latest.result === 'reply_observed' || latest.result === 'no_bounce_observed') {
    return isReachabilityEvidenceAccepted(latest, now)
      ? { queue: 'draft_ready', reason: '????????????' }
      : { queue: 'observation_queue', reason: '????????' }
  }
  if (latest.result === 'smtp_handshake_pass' || latest.result === 'specific_email_verified') {
    return { queue: 'manual_confirmation', reason: '?????????????????' }
  }

  const temporaryUnknown = /452|greylist|timeout|no.?220|banner|catch.?all|temporary/i.test(
    `${latest.result} ${latest.note || ''}`,
  )
  if (temporaryUnknown) {
    return { queue: 'retry_queue', reason: '????????????????' }
  }

  const highValue = item.reviewDisposition === 'active'
    && (item.priority === 'high' || item.priority === 'medium')
  return highValue
    ? { queue: 'isolated_test_queue', reason: '????????????????????' }
    : { queue: 'deferred', reason: '???????????????' }
}

export function hasSpecificEmailEvidence(item: PipelineItem, email: string = getPrimaryEmail(item), now = new Date()): boolean {
  if (!email) return false
  const evidence = emailEvidence(item, email)
  if (evidence.some(entry => BLOCKING_RESULTS.has(entry.result))) return false
  if (evidence.some(entry => isReachabilityEvidenceAccepted(entry, now))) return true

  return deriveAddressVerificationState(item, email, now) === 'accepted'
}

function emailBlockingReason(item: PipelineItem, email: string): string | undefined {
  const latestBlocking = emailEvidence(item, email).find(entry => BLOCKING_RESULTS.has(entry.result))
  if (latestBlocking?.result === 'format_invalid') return '邮箱格式无效'
  if (latestBlocking?.result === 'smtp_handshake_fail') return 'SMTP握手失败'
  if (latestBlocking?.result === 'bounced_test') return '隔离测试信已退信'
  return undefined
}

export interface DevelopmentEligibility {
  allowed: boolean
  reasons: string[]
}

export function getDevelopmentEligibility(item: PipelineItem, now = new Date()): DevelopmentEligibility {
  const reasons: string[] = []
  const manuallyApprovedBackcheck = item.reviewDisposition === 'active' && Boolean(item.reviewUpdatedAt)
  if (!manuallyApprovedBackcheck) reasons.push('背调尚未人工通过')
  if (!hasContactLead(item) || !hasUsableEmail(item)) reasons.push('缺少已确认的联系人入口')
  const primaryEmail = getPrimaryEmail(item, now)
  const blockingReason = primaryEmail ? emailBlockingReason(item, primaryEmail) : undefined
  if (blockingReason) reasons.push(blockingReason)
  else if (!hasSpecificEmailEvidence(item, primaryEmail, now) && item.allowUnverifiedOutreach !== true) {
    reasons.push('具体邮箱尚未验证；domain_only、test_sent、Snovio结果、来源不明或导入 verified 均不能自动放行')
  }
  return { allowed: reasons.length === 0, reasons }
}

export function isPermanentlyExcluded(item: PipelineItem): boolean {
  return item.doNotDevelop === true || item.reviewDisposition === 'do_not_develop'
}

export function needsBackcheckReview(item: PipelineItem): boolean {
  return item.reviewDisposition === 'needs_recheck' || item.reviewDisposition === 'insufficient'
}

export function getWorkflowStage(item: PipelineItem, now = new Date()): WorkflowStageKey {
  if (isPermanentlyExcluded(item)) return 'archived'
  if (needsBackcheckReview(item)) return 'backcheck_queue'
  if (item.status === 'archived' || item.developmentStatus === 'skipped' || item.developmentStatus === 'shelved') return 'archived'
  const selectedCandidate = item.selectedEmail ? selectPreferredEmail(buildEmailCandidateRows(item, now), item.selectedEmail) : undefined
  const addressDispositionReasons = new Set(['address_bounced_or_failed', 'address_suppressed_or_complained'])
  if (selectedCandidate?.tier === 'E' && selectedCandidate.quality.blockedReasons.some(reason => !addressDispositionReasons.has(reason))) return 'data_issue'
  if (hasBounce(item, now)) return 'bounced'
  if (hasReply(item)) return 'replied'
  if (hasSentEmail(item)) return 'followup_sent'

  const hasEmail = hasUsableEmail(item)
  const backchecked = hasBackcheck(item)

  if (!backchecked) return item.currentStageId === 'otr-backcheck' || item.website ? 'backcheck_queue' : 'search_new'
  if (item.reviewDisposition !== 'active' || !item.reviewUpdatedAt) return 'backcheck_queue'
  if (!hasEmail) return 'contact_mining'
  if (deriveAddressVerificationState(item, getPrimaryEmail(item, now), now) === 'invalid') return 'invalid'
  if (hasSpecificEmailEvidence(item, getPrimaryEmail(item, now), now) || item.allowUnverifiedOutreach === true) return 'development_ready'
  return 'email_verification'
}

export function filterByWorkflowStage(items: PipelineItem[], stage: WorkflowStageKey): PipelineItem[] {
  return items.filter(item => getWorkflowStage(item) === stage)
}

export function getWorkflowStageCounts(items: PipelineItem[]): Record<WorkflowStageKey, number> {
  const counts: Record<WorkflowStageKey, number> = {
    search_new: 0,
    backcheck_queue: 0,
    contact_mining: 0,
    email_verification: 0,
    development_ready: 0,
    followup_sent: 0,
    replied: 0,
    bounced: 0,
    invalid: 0,
    archived: 0,
    data_issue: 0,
  }
  for (const item of items) counts[getWorkflowStage(item)]++
  return counts
}

