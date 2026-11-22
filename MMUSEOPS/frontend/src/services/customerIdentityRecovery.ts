import type { PipelineItem } from '../types/item'

const text = (value: unknown): string => String(value ?? '').trim()
const lower = (value: unknown): string => text(value).toLowerCase()
const list = (value: unknown): any[] => Array.isArray(value) ? value : []
const HARD_REASON = /bounce|unreachable|suppress|complain|non_buyer|aggregator|placeholder|quarantin|duplicate|inactive|wrong_industry|manual_exclusion/

function hasExactPriorFormalSend(item: any): boolean {
  const selected = lower(item.selectedEmail || item.preferredEmail || item.email)
  if (!selected) return false
  return list(item.emailLogs).some(log =>
    lower(log?.type) === 'formal_outreach'
    && lower(log?.status) === 'sent'
    && lower(log?.recipientEmail || log?.to || log?.email || log?.address) === selected)
}

function hasHardBlock(item: any): boolean {
  if (item.doNotDevelop === true || item.doNotContactEmail === true || item.reviewDisposition === 'do_not_develop') return true
  if (lower(item.status) === 'archived' || text(item.duplicateOf) || text(item.canonicalLeadId) && text(item.canonicalLeadId) !== text(item.id)) return true
  if (item.formalBounce === true || list(item.doNotContactEmails).length > 0) return true
  const safetyEvidence = [...list(item.emailVerificationEvidence), ...list(item.emailLogs)].flatMap(entry => [entry?.result, entry?.status, entry?.webhookEventType, entry?.providerLastEvent, entry?.recoveryStatus]).map(lower).join(' ')
  if (/suppressed|complained|do_not_contact|bounced|smtp_handshake_fail|domain_unreachable/.test(safetyEvidence)) return true
  if (['permanent_do_not_develop', 'duplicate', 'irrelevant', 'unreachable'].includes(text(item.inactiveCategory))) return true
  const reasons = [
    ...list(item.eligibilityBlockedReasons),
    item.exclusionReason,
    item.inactiveReason,
    item.operationalTierReason,
  ].map(lower).filter(Boolean)
  return reasons.some(reason => HARD_REASON.test(reason))
}

export function recoverMisclassifiedFollowupState(item: PipelineItem, now = new Date()): { item: PipelineItem; changed: boolean; reason?: string } {
  const any = item as any
  const stage = text(any.primaryStage || any.normalizedStage || any.operationalTier)
  const poisoned = stage === 'true_excluded'
    || text(any.normalizedStage) === 'true_excluded'
    || text(any.operationalTier) === 'true_excluded'
  if (!poisoned) return { item, changed: false }
  if (text(any.identityRecommendedAction) !== 'follow_up_or_outreach') return { item, changed: false }
  if (!['channel_buyer', 'operator_buyer', 'project_specifier'].includes(text(any.entityRole))) return { item, changed: false }
  if (!hasExactPriorFormalSend(any) || hasHardBlock(any)) return { item, changed: false }

  const recovered: any = {
    ...any,
    primaryStage: 'followup_queue',
    normalizedStage: 'followup_queue',
    currentAllowedStage: 'followup_queue',
    operationalTier: 'followup_queue',
    activeWorkflow: true,
    inactiveWorkflow: false,
    eligibilityBlockedReasons: [],
    allowedNextActions: ['manual_reply_check', 'follow_up'],
    nextRequiredAction: 'manual_reply_check',
    identityRecoveryReason: 'historical_true_excluded_was_only_a_post_send_workflow_state',
    identityRecoveredAt: now.toISOString(),
    identityRecoveredBy: 'customer-identity-v1',
  }
  return { item: recovered, changed: true, reason: recovered.identityRecoveryReason }
}
