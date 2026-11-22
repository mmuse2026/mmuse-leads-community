import type { EmailVerificationEvidence, PipelineItem } from '../types/item'
import { applyEligibilityStage, getCandidateEmails } from './leadStageEligibility'

export interface ResendHistoryCandidate {
  resendEmailId: string
  recipientEmail: string[]
  status: string
  sentAt: string
  matchedCustomerId: string | string[]
  matchMethod: string
  risk: string
  fromDomain?: string
  subject?: string
}

export type IsolationCategory =
  | 'permanent_do_not_develop'
  | 'irrelevant'
  | 'duplicate'
  | 'unreachable'
  | 'low_value_hold'
  | 'insufficient'

export interface ResendBackfillReport {
  backfilledEvidence: number
  affectedCustomers: number
  deliveredEvidence: number
  bouncedEvidence: number
  suppressedEvidence: number
  delayedEvidence: number
  receivedEvidence: number
  inferredNoBounceObserved: number
  conflictStatuses: number
  unprocessed: number
  unprocessedReasons: Record<string, number>
  duplicateEvidenceSkipped: number
  duplicateCustomerMatchesResolved: number
}

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const BAD_SOURCE = /directory|yellow\s*pages?|news|blog|ranking|top\s*\d+|marketplace|facebook|instagram|linkedin|pinterest|youtube|privacy\s*policy|market\s*report/i
const GENERIC_COMPANY = /^(privacy policy|photos?|contact|about us|home|top\s*\d+|market report|unknown|n\/a)$/i
const STATUS_PRIORITY: Record<string, number> = {
  complained: 700,
  suppressed: 690,
  bounced: 600,
  bounced_test: 600,
  failed: 590,
  received: 500,
  reply_observed: 500,
  no_bounce_observed: 400,
  delivered: 300,
  delivery_delayed: 200,
  delayed: 200,
  test_sent: 100,
  unknown: 0,
}
const HARD_FAILURES = new Set(['complained', 'suppressed', 'bounced', 'bounced_test', 'failed'])
const OBSERVATION_WINDOW_MS = 24 * 60 * 60 * 1000

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeEmail(value: unknown): string {
  const email = text(value).toLowerCase()
  return EMAIL_PATTERN.test(email) ? email : ''
}

function normalizeStatus(value: unknown): string {
  const status = text(value).toLowerCase().replace(/^email\./, '')
  return status === 'delayed' ? 'delivery_delayed' : status || 'unknown'
}

function candidateEmail(candidate: ResendHistoryCandidate): string {
  return normalizeEmail(Array.isArray(candidate.recipientEmail) ? candidate.recipientEmail[0] : candidate.recipientEmail)
}

function existingBackfillIds(item: PipelineItem): Set<string> {
  return new Set((item.emailVerificationEvidence || [])
    .flatMap(entry => [entry.resendEmailId, entry.testMessageId, entry.messageId])
    .map(text)
    .filter(Boolean))
}

function masterScore(item: PipelineItem): number {
  const current = item as any
  let score = 0
  if (current.activeWorkflow === true && current.inactiveWorkflow !== true) score += 100
  if (item.reviewDisposition === 'active') score += 40
  if (text(item.company || item.title)) score += 20
  if (text(item.website)) score += 15
  if (getCandidateEmails(item).length > 0) score += 10
  if (current.duplicateOf || current.duplicateIndex === true) score -= 100
  if (item.doNotDevelop || current.doNotContactEmail) score -= 80
  return score
}

function resolveCustomerId(
  candidate: ResendHistoryCandidate,
  itemById: Map<string, PipelineItem>,
): { customerId: string; duplicateIds: string[] } | null {
  const email = candidateEmail(candidate)
  const ids = (Array.isArray(candidate.matchedCustomerId)
    ? candidate.matchedCustomerId
    : [candidate.matchedCustomerId])
    .map(text)
    .filter(id => {
      const item = itemById.get(id)
      return item && getCandidateEmails(item).includes(email)
    })
  if (candidate.matchMethod !== 'recipientEmail' || ids.length === 0) return null
  const ranked = [...new Set(ids)]
    .map(id => itemById.get(id)!)
    .sort((a, b) => masterScore(b) - masterScore(a) || a.id.localeCompare(b.id))
  if (ranked.length !== 1) return null
  return { customerId: ranked[0].id, duplicateIds: [] }
}

function evidenceResult(status: string): string {
  if (status === 'received') return 'reply_observed'
  if (status === 'delayed') return 'delivery_delayed'
  return status
}

function buildHistoryEvidence(
  candidate: ResendHistoryCandidate,
  importedAt: string,
): EmailVerificationEvidence {
  const status = normalizeStatus(candidate.status)
  return {
    email: candidateEmail(candidate),
    recipientEmail: candidateEmail(candidate),
    result: evidenceResult(status),
    status,
    scope: 'delivery',
    source: 'resend_history_backfill',
    method: 'resend_history_backfill',
    checkedAt: candidate.sentAt,
    sentAt: candidate.sentAt,
    importedAt,
    resendEmailId: candidate.resendEmailId,
    messageId: candidate.resendEmailId,
    testMessageId: candidate.resendEmailId,
    matchMethod: 'recipientEmail',
    recoveryStatus: HARD_FAILURES.has(status)
      ? 'bounced'
      : status === 'received' ? 'replied'
        : status === 'delivery_delayed' || status === 'delivered' ? 'watching' : 'unknown',
    note: `Imported from Resend history as ${status}; not verified.`,
  }
}

function hasAlternativeEmail(item: PipelineItem, blockedEmail: string, evidence: EmailVerificationEvidence[]): boolean {
  const blocked = new Set(evidence
    .filter(entry => HARD_FAILURES.has(normalizeStatus(entry.result)))
    .map(entry => normalizeEmail(entry.email))
    .filter(Boolean))
  blocked.add(blockedEmail)
  return getCandidateEmails(item).some(email => !blocked.has(email))
}

function applyEmailOutcome(item: PipelineItem, email: string, now: Date): PipelineItem {
  const current = item as any
  const evidence = current.emailVerificationEvidence || []
  const relevantStatuses = evidence
    .filter((entry: EmailVerificationEvidence) => normalizeEmail(entry.email) === email)
    .map((entry: EmailVerificationEvidence) => normalizeStatus(entry.result))
  const outcome = chooseEvidenceOutcome(relevantStatuses)
  const existingRoutes = (current.emailVerificationRouting || [])
    .filter((route: any) => normalizeEmail(route.email) !== email)
  const updatedAt = now.toISOString()

  if (outcome === 'suppressed' || outcome === 'complained') {
    return {
      ...current,
      emailReachability: 'unreachable',
      doNotContactEmail: true,
      doNotContactEmails: [...new Set([...(current.doNotContactEmails || []), email])],
      emailVerificationRouting: [...existingRoutes, {
        email,
        queue: 'do_not_contact',
        reason: `Resend reported ${outcome}`,
        updatedAt,
      }],
      activeWorkflow: false,
      inactiveWorkflow: true,
      normalizedStage: 'inactive_excluded',
      currentAllowedStage: 'inactive_excluded',
      inactiveCategory: 'unreachable',
      inactiveReason: `Resend ${outcome}; email must not be contacted`,
      inactiveAt: current.inactiveAt || updatedAt,
      nextRequiredAction: '更换联系人后人工恢复',
      eligibilityBlockedReasons: [`Resend ${outcome}`],
      updatedAt,
    }
  }

  if (outcome === 'bounced' || outcome === 'bounced_test' || outcome === 'failed') {
    const alternative = hasAlternativeEmail(current, email, evidence)
    return {
      ...current,
      emailReachability: 'unreachable',
      doNotContactEmail: alternative ? current.doNotContactEmail : true,
      doNotContactEmails: [...new Set([...(current.doNotContactEmails || []), email])],
      emailVerificationRouting: [...existingRoutes, {
        email,
        queue: 'unreachable',
        reason: `Resend reported ${outcome}`,
        updatedAt,
      }],
      activeWorkflow: alternative,
      inactiveWorkflow: !alternative,
      normalizedStage: alternative ? 'replace_contact_queue' : 'inactive_excluded',
      currentAllowedStage: alternative ? 'replace_contact_queue' : 'inactive_excluded',
      inactiveCategory: alternative ? current.inactiveCategory : 'unreachable',
      inactiveReason: alternative ? current.inactiveReason : `No alternative contact after ${outcome}`,
      inactiveAt: alternative ? current.inactiveAt : (current.inactiveAt || updatedAt),
      nextRequiredAction: alternative ? '更换联系人或候选邮箱' : '更换联系人后人工恢复',
      updatedAt,
    }
  }

  if (outcome === 'reply_observed' || outcome === 'received') {
    return {
      ...current,
      emailVerificationRouting: [...existingRoutes, {
        email,
        queue: 'manual_confirmation',
        reason: 'Reply observed in Resend history; requires normal eligibility checks',
        updatedAt,
      }],
      updatedAt,
    }
  }

  if (outcome === 'no_bounce_observed') {
    return {
      ...current,
      emailVerificationRouting: [...existingRoutes, {
        email,
        queue: 'manual_confirmation',
        reason: 'Observation completed without bounce; apply normal eligibility checks',
        updatedAt,
      }],
      updatedAt,
    }
  }

  return {
    ...current,
    emailVerificationRouting: [...existingRoutes, {
      email,
      queue: 'observation_queue',
      reason: outcome === 'delivery_delayed' ? 'Delivery delayed; observation continues' : 'Delivered evidence only; observation continues',
      updatedAt,
    }],
    updatedAt,
  }
}

export function chooseEvidenceOutcome(statuses: string[]): string {
  return statuses
    .map(normalizeStatus)
    .sort((a, b) => (STATUS_PRIORITY[b] || 0) - (STATUS_PRIORITY[a] || 0))[0] || 'unknown'
}

export function inferNoBounceObserved(candidates: ResendHistoryCandidate[], now = new Date()): boolean {
  const statuses = candidates.map(candidate => normalizeStatus(candidate.status))
  if (!statuses.includes('delivered') || statuses.some(status => HARD_FAILURES.has(status))) return false
  const latestSentAt = Math.max(...candidates.map(candidate => Date.parse(candidate.sentAt)).filter(Number.isFinite))
  return Number.isFinite(latestSentAt) && now.getTime() - latestSentAt >= OBSERVATION_WINDOW_MS
}

export function applyResendHistoryBackfill(
  inputItems: PipelineItem[],
  candidates: ResendHistoryCandidate[],
  now = new Date(),
): { items: PipelineItem[]; report: ResendBackfillReport } {
  const itemById = new Map(inputItems.map(item => {
    const current = item as any
    if (current.inactiveCategory === 'duplicate' && /^Duplicate email evidence assigned to master record /.test(text(current.inactiveReason))) {
      const cleaned = { ...current }
      delete cleaned.duplicateOf
      delete cleaned.inactiveCategory
      delete cleaned.inactiveReason
      delete cleaned.inactiveAt
      cleaned.activeWorkflow = true
      cleaned.inactiveWorkflow = false
      return [item.id, cleaned as PipelineItem]
    }
    return [item.id, item]
  }))
  const report: ResendBackfillReport = {
    backfilledEvidence: 0,
    affectedCustomers: 0,
    deliveredEvidence: 0,
    bouncedEvidence: 0,
    suppressedEvidence: 0,
    delayedEvidence: 0,
    receivedEvidence: 0,
    inferredNoBounceObserved: 0,
    conflictStatuses: 0,
    unprocessed: 0,
    unprocessedReasons: {},
    duplicateEvidenceSkipped: 0,
    duplicateCustomerMatchesResolved: 0,
  }
  const affected = new Set<string>()
  const importedAt = now.toISOString()
  const candidatesByCustomerEmail = new Map<string, ResendHistoryCandidate[]>()
  const duplicateAssignments = new Map<string, string>()

  for (const candidate of candidates) {
    const resolution = resolveCustomerId(candidate, itemById)
    const email = candidateEmail(candidate)
    if (!resolution || !email || !text(candidate.resendEmailId)) {
      const reason = !resolution ? 'customer_not_exactly_matched' : !email ? 'recipient_email_invalid' : 'resend_id_missing'
      report.unprocessed += 1
      report.unprocessedReasons[reason] = (report.unprocessedReasons[reason] || 0) + 1
      continue
    }
    for (const duplicateId of resolution.duplicateIds) duplicateAssignments.set(duplicateId, resolution.customerId)
    if (resolution.duplicateIds.length > 0) report.duplicateCustomerMatchesResolved += 1

    const current = itemById.get(resolution.customerId)!
    if (existingBackfillIds(current).has(candidate.resendEmailId)) {
      const key = `${resolution.customerId}|${email}`
      candidatesByCustomerEmail.set(key, [...(candidatesByCustomerEmail.get(key) || []), candidate])
      report.duplicateEvidenceSkipped += 1
      continue
    }
    const historyEvidence = buildHistoryEvidence(candidate, importedAt)
    itemById.set(resolution.customerId, {
      ...current,
      emailVerificationEvidence: [...(current.emailVerificationEvidence || []), historyEvidence],
      updatedAt: importedAt,
    })
    const key = `${resolution.customerId}|${email}`
    candidatesByCustomerEmail.set(key, [...(candidatesByCustomerEmail.get(key) || []), candidate])
    affected.add(resolution.customerId)
    report.backfilledEvidence += 1
    const status = normalizeStatus(candidate.status)
    if (status === 'delivered') report.deliveredEvidence += 1
    else if (status === 'bounced' || status === 'failed') report.bouncedEvidence += 1
    else if (status === 'suppressed' || status === 'complained') report.suppressedEvidence += 1
    else if (status === 'delivery_delayed') report.delayedEvidence += 1
    else if (status === 'received') report.receivedEvidence += 1
  }

  for (const [key, groupedCandidates] of candidatesByCustomerEmail) {
    const [customerId, email] = key.split('|')
    let current = itemById.get(customerId)!
    const allEmailEvidence = (current.emailVerificationEvidence || [])
      .filter(entry => normalizeEmail(entry.email) === email)
    const statuses = [...new Set(allEmailEvidence.map(entry => normalizeStatus(entry.result)))]
    if (statuses.length > 1) report.conflictStatuses += 1
    const existingHardFailure = statuses.some(status => HARD_FAILURES.has(status))
    const allObservationCandidates = allEmailEvidence
      .filter(entry => text(entry.sentAt || entry.checkedAt))
      .map(entry => ({ status: normalizeStatus(entry.result), sentAt: text(entry.sentAt || entry.checkedAt) } as ResendHistoryCandidate))
    if (!existingHardFailure && inferNoBounceObserved(allObservationCandidates, now)) {
      const inferenceId = `resend-history-inferred:${email}`
      if (!existingBackfillIds(current).has(inferenceId)
        && !(current.emailVerificationEvidence || []).some(entry => entry.source === 'resend_history_backfill_inferred' && normalizeEmail(entry.email) === email)) {
        const latestSentAt = allObservationCandidates
          .map(candidate => candidate.sentAt)
          .sort((a, b) => Date.parse(b) - Date.parse(a))[0]
        current = {
          ...current,
          emailVerificationEvidence: [...(current.emailVerificationEvidence || []), {
            email,
            recipientEmail: email,
            result: 'no_bounce_observed',
            status: 'no_bounce_observed',
            scope: 'delivery',
            source: 'resend_history_backfill_inferred',
            method: 'resend_history_backfill_inferred',
            checkedAt: importedAt,
            sentAt: latestSentAt,
            importedAt,
            resendEmailId: inferenceId,
            messageId: inferenceId,
            matchMethod: 'recipientEmail',
            recoveryStatus: 'no_bounce_observed',
            observationWindowStartedAt: latestSentAt,
            observationWindowEndsAt: new Date(Date.parse(latestSentAt) + OBSERVATION_WINDOW_MS).toISOString(),
            note: 'Inferred after 24 hours with delivered history and no later conflicting failure; not verified.',
          }],
        }
        report.inferredNoBounceObserved += 1
      }
    }
    current = applyEmailOutcome(current, email, now)
    if (!current.inactiveWorkflow) current = applyEligibilityStage(current, now).item
    itemById.set(customerId, current)
  }

  for (const [duplicateId, masterId] of duplicateAssignments) {
    const duplicate = itemById.get(duplicateId)
    if (!duplicate) continue
    itemById.set(duplicateId, {
      ...duplicate,
      duplicateOf: masterId,
      activeWorkflow: false,
      inactiveWorkflow: true,
      inactiveCategory: 'duplicate',
      inactiveReason: `Duplicate email evidence assigned to master record ${masterId}`,
      inactiveAt: duplicate.inactiveAt || importedAt,
      normalizedStage: 'inactive_excluded',
      currentAllowedStage: 'inactive_excluded',
      eligibilityUpdatedAt: (duplicate as any).duplicateOf === masterId
        && (duplicate as any).inactiveWorkflow === true
        ? (duplicate as any).eligibilityUpdatedAt
        : importedAt,
    } as PipelineItem)
  }

  report.affectedCustomers = affected.size
  return { items: inputItems.map(item => itemById.get(item.id) || item), report }
}

function isolationDecision(item: PipelineItem): { category: IsolationCategory; reason: string } | null {
  const current = item as any
  const combined = `${text(item.company)} ${text(item.title)} ${text(item.website)} ${text(item.source)} ${text(item.snippet)}`
  const company = text(item.company || item.title)
  const emails = getCandidateEmails(item)
  let hasDomain = false
  try {
    const url = new URL(/^https?:\/\//i.test(text(item.website)) ? text(item.website) : `https://${text(item.website)}`)
    hasDomain = url.hostname.includes('.')
  } catch {}
  if (item.doNotDevelop || item.reviewDisposition === 'do_not_develop') return { category: 'permanent_do_not_develop', reason: '永久不开发' }
  if (current.doNotContactEmail || (item.emailVerificationEvidence || []).some(entry => /complained|suppressed/i.test(`${entry.result} ${entry.status || ''} ${(entry as any).providerLastEvent || ''} ${entry.webhookEventType || ''}`))) {
    return { category: 'unreachable', reason: '投诉或suppressed，禁止继续联系' }
  }
  if (current.duplicateOf || current.duplicateIndex === true) return { category: 'duplicate', reason: '重复记录，保留主记录去重索引' }
  if (current.businessMatch === 'none' || current.importCommercialValue === 'none' || BAD_SOURCE.test(combined)) {
    return { category: 'irrelevant', reason: '业务不匹配或来源为目录/资讯/社交页面' }
  }
  if (!company || company.length < 3 || GENERIC_COMPANY.test(company)) return { category: 'irrelevant', reason: '无明确公司主体' }
  if (!hasDomain && emails.length === 0) return { category: 'insufficient', reason: '无有效域名且无有效邮箱' }
  if (item.reviewDisposition === 'insufficient') return { category: 'insufficient', reason: '多轮处理后信息仍不足' }
  if (current.emailReachability === 'unreachable' && !hasAlternativeEmail(item, '', item.emailVerificationEvidence || [])) {
    return { category: 'unreachable', reason: '邮箱不可达且无替代联系人' }
  }
  if (current.businessMatch === 'low' && current.importCommercialValue === 'low') return { category: 'low_value_hold', reason: '业务和商业价值均低，暂存' }
  if (/competitor|manufacturer_peer|同行供应商/i.test(`${current.customerType || ''} ${current.customerTypeAssessment || ''}`)) {
    return { category: 'irrelevant', reason: '明显同行且无合作价值' }
  }
  return null
}

export function applyWorkflowIsolation(
  inputItems: PipelineItem[],
  now = new Date(),
): { items: PipelineItem[]; isolated: number; byReason: Record<string, number>; recoverable: number } {
  const byReason: Record<string, number> = {}
  let isolated = 0
  let recoverable = 0
  const items = inputItems.map(item => {
    const decision = isolationDecision(item)
    if (!decision) {
      if ((item as any).inactiveWorkflow === true) return item
      return { ...item, activeWorkflow: true, inactiveWorkflow: false } as PipelineItem
    }
    byReason[decision.category] = (byReason[decision.category] || 0) + 1
    if ((item as any).inactiveWorkflow !== true || (item as any).inactiveCategory !== decision.category) isolated += 1
    if (decision.category !== 'permanent_do_not_develop') recoverable += 1
    const suppressedEmails = (item.emailVerificationEvidence || [])
      .filter(entry => /complained|suppressed/i.test(`${entry.result} ${entry.status || ''} ${(entry as any).providerLastEvent || ''} ${entry.webhookEventType || ''}`))
      .map(entry => normalizeEmail(entry.email))
      .filter(Boolean)
    const existingRoutes = (item.emailVerificationRouting || [])
      .filter(route => !suppressedEmails.includes(normalizeEmail(route.email)))
    const suppressedRoutes = suppressedEmails.map(email =>
      (item.emailVerificationRouting || []).find(route => normalizeEmail(route.email) === email && route.queue === 'do_not_contact') || {
        email,
        queue: 'do_not_contact' as const,
        reason: 'Resend reported suppressed or complained',
        updatedAt: now.toISOString(),
      })
    return {
      ...item,
      emailReachability: suppressedEmails.length > 0 ? 'unreachable' : item.emailReachability,
      doNotContactEmail: suppressedEmails.length > 0 ? true : item.doNotContactEmail,
      doNotContactEmails: suppressedEmails.length > 0
        ? [...new Set([...(item.doNotContactEmails || []), ...suppressedEmails])]
        : item.doNotContactEmails,
      emailVerificationRouting: suppressedEmails.length > 0
        ? [...existingRoutes, ...suppressedRoutes]
        : item.emailVerificationRouting,
      activeWorkflow: false,
      inactiveWorkflow: true,
      inactiveCategory: decision.category,
      inactiveReason: decision.reason,
      inactiveAt: (item as any).inactiveAt || now.toISOString(),
      normalizedStage: decision.category === 'low_value_hold' ? 'low_priority_pool' : 'inactive_excluded',
      currentAllowedStage: decision.category === 'low_value_hold' ? 'low_priority_pool' : 'inactive_excluded',
      nextRequiredAction: decision.category === 'permanent_do_not_develop' ? '永久保留排除索引' : '人工复核后可恢复',
      eligibilityBlockedReasons: [decision.reason],
      eligibilityUpdatedAt: (item as any).inactiveWorkflow === true
        && (item as any).inactiveCategory === decision.category
        && (item as any).inactiveReason === decision.reason
        ? (item as any).eligibilityUpdatedAt
        : now.toISOString(),
    } as PipelineItem
  })
  return { items, isolated, byReason, recoverable }
}

export function restoreIsolatedWorkflowItem(
  item: PipelineItem,
  target: 'backcheck_queue' | 'contact_mining_queue' | 'email_validation_queue',
  reason: string,
  now = new Date(),
): PipelineItem {
  if (!text(reason)) throw new Error('恢复原因不能为空')
  const evidenceText = (item.emailVerificationEvidence || []).map(entry => `${entry.result} ${entry.status || ''} ${(entry as any).providerLastEvent || ''} ${entry.webhookEventType || ''}`).join(' ')
  if (item.doNotDevelop || item.reviewDisposition === 'do_not_develop' || (item as any).inactiveCategory === 'permanent_do_not_develop' || /suppressed|complained/i.test(evidenceText)) {
    throw new Error('永久不开发、suppressed 或 complained 客户不能恢复到主流程')
  }
  if ((item as any).doNotContactEmail && target !== 'contact_mining_queue') {
    throw new Error('禁止联系邮箱必须先更换联系人，不能直接恢复到邮箱验证')
  }
  return {
    ...item,
    normalizedStage: target,
    currentAllowedStage: target,
    nextRequiredAction: target === 'backcheck_queue' ? '重新人工背调' : target === 'contact_mining_queue' ? '补充替代联系人' : '继续邮箱验证',
    activeWorkflow: true,
    inactiveWorkflow: false,
    inactiveReason: undefined,
    inactiveCategory: undefined,
    restoredReason: reason,
    restoredAt: now.toISOString(),
    reviewDisposition: target === 'backcheck_queue' ? 'needs_recheck' : 'active',
    reviewUpdatedAt: now.toISOString(),
    reviewedBy: 'human_restore',
    updatedAt: now.toISOString(),
  } as PipelineItem
}


