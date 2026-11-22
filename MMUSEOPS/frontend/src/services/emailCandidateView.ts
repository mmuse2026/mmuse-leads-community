import type { EmailDisposition, PipelineItem } from '../types/item'
import { classifyEmailQuality, normalizeDomain, normalizeEmail, type EmailQualityDecision, type EmailQualityInput, type EmailQualityTier } from './emailQualityPolicy'

export type AddressVerificationState = EmailDisposition

export interface CollectedEmailCandidate extends EmailQualityInput {
  normalizedEmail: string
}

export interface EmailCandidateRow extends CollectedEmailCandidate {
  quality: EmailQualityDecision
  tier: EmailQualityTier
  emailType: EmailQualityDecision['emailType']
  verificationState: AddressVerificationState
}

const asArray = (value: unknown): any[] => Array.isArray(value) ? value : []
const exactEmail = (entry: any): string => normalizeEmail(entry?.email || entry?.recipientEmail || entry?.to || entry?.address)
const stamp = (entry: any): number => Date.parse(entry?.recordedAt || entry?.checkedAt || entry?.sentAt || entry?.importedAt || '') || 0

function splitCandidateValues(value: unknown): string[] {
  const candidates: string[] = []
  for (const segment of String(value || '').split(/[;,]/)) {
    const normalizedSegment = normalizeEmail(segment)
    if (!normalizedSegment) continue
    const parts = /https?:\/\/|[/?#=]/i.test(normalizedSegment)
      ? [normalizedSegment]
      : normalizedSegment.split(/\s+/)
    candidates.push(...parts.map(part => normalizeEmail(part)).filter(Boolean))
  }
  return candidates
}
function canonicalDomain(item: PipelineItem): string {
  const any = item as any
  return normalizeDomain(any.canonicalDomain || any.domain || item.website)
}

function priorResults(item: PipelineItem, email: string): string[] {
  const evidence = asArray(item.emailVerificationEvidence)
    .filter(entry => exactEmail(entry) === email)
    .map(entry => `${entry.result || ''} ${entry.status || ''} ${entry.recoveryStatus || ''} ${entry.webhookEventType || ''}`.trim())
  const logs = asArray(item.emailLogs)
    .filter(entry => exactEmail(entry) === email)
    .map(entry => `${entry.status || ''} ${entry.bounceReason || ''}`.trim())
  const dispositions = asArray(item.emailDispositionLog)
    .filter(entry => normalizeEmail(entry?.email) === email)
    .map(entry => `${entry.disposition || ''} ${entry.reason || ''}`.trim())
  const routing = asArray(item.emailVerificationRouting)
    .filter(entry => normalizeEmail(entry?.email) === email)
    .map(entry => `${entry.queue || ''} ${entry.reason || ''}`.trim())
  const explicitDnc = asArray(item.doNotContactEmails).some(value => normalizeEmail(value) === email) ? ['do_not_contact'] : []
  return [...evidence, ...logs, ...dispositions, ...routing, ...explicitDnc].filter(Boolean)
}

export function collectEmailCandidates(item: PipelineItem): CollectedEmailCandidate[] {
  const rows = new Map<string, CollectedEmailCandidate>()
  const domain = canonicalDomain(item)
  const add = (value: unknown, metadata: Partial<EmailQualityInput> = {}) => {
    for (const normalizedEmail of splitCandidateValues(value)) {
      const existing = rows.get(normalizedEmail)
      // priorResults(item, email) 对同一邮箱是确定性的；重复 add（evidence/logs 里同一邮箱出现多次）时
      // 直接复用已算结果，避免每次重扫整份 evidence 数组（N 个证据 × N 次重扫 = O(N²)，单条 44s）。
      rows.set(normalizedEmail, {
        email: normalizedEmail,
        normalizedEmail,
        canonicalDomain: domain,
        contactName: metadata.contactName || existing?.contactName,
        title: metadata.title || existing?.title,
        source: metadata.source || existing?.source,
        evidenceUrl: metadata.evidenceUrl || existing?.evidenceUrl,
        priorResults: existing ? existing.priorResults : priorResults(item, normalizedEmail),
      })
    }
  }
  add(item.email, { contactName: item.contactName })
  add(item.selectedEmail)
  add(item.preferredEmail)
  for (const contact of asArray((item as any).contacts)) add(contact?.email, { contactName: contact?.name, title: contact?.title, source: contact?.source, evidenceUrl: contact?.sourceUrl || contact?.evidenceUrl })
  for (const contact of asArray(item.backCheck?.decisionMakers)) add(contact?.email, { contactName: contact?.name, title: contact?.title, source: contact?.source, evidenceUrl: contact?.sourceUrl })
  for (const entry of asArray(item.emailVerificationEvidence)) add(entry?.email || entry?.recipientEmail || entry?.address)
  for (const entry of asArray(item.emailLogs)) add(entry?.recipientEmail || entry?.to)
  for (const entry of asArray(item.emailDispositionLog)) add(entry?.email)
  return [...rows.values()]
}

export function classifyEmailCandidate(input: EmailQualityInput): EmailQualityDecision {
  return classifyEmailQuality(input)
}

export function isPersonalCompanyEmailType(emailType: string): boolean {
  return emailType === 'personal_company'
}

export function deriveAddressVerificationState(item: PipelineItem, address: string, now = new Date()): AddressVerificationState {
  const email = normalizeEmail(address)
  if (!email) return 'unverified'
  const events: Array<{ state: AddressVerificationState; at: number }> = []
  const observationWindow = asArray(item.emailVerificationEvidence)
    .filter(entry => exactEmail(entry) === email)
    .map(entry => ({
      start: Date.parse(entry?.observationWindowStartedAt || entry?.observationStartedAt || ''),
      end: Date.parse(entry?.observationWindowEndsAt || entry?.observationEndedAt || ''),
    }))
    .filter(window => Number.isFinite(window.start) && Number.isFinite(window.end) && window.end > window.start)
    .sort((a, b) => b.end - a.end)[0]
  for (const entry of asArray(item.emailDispositionLog)) {
    if (normalizeEmail(entry?.email) === email && ['accepted', 'bounced', 'invalid', 'watching', 'unverified'].includes(entry?.disposition)) events.push({ state: entry.disposition, at: stamp(entry) })
  }
  for (const entry of asArray(item.emailVerificationEvidence)) {
    if (exactEmail(entry) !== email) continue
    const value = `${entry?.result || ''} ${entry?.status || ''} ${entry?.recoveryStatus || ''} ${entry?.webhookEventType || ''}`.toLowerCase()
    let state: AddressVerificationState | undefined
    if (/format_invalid|dns_failed|no_mx/.test(value)) state = 'invalid'
    else if (/bounced|failed|smtp_handshake_fail/.test(value)) state = 'bounced'
    else if (/specific_email_verified|reply_observed/.test(value)) state = 'accepted'
    else if (/no_bounce_observed/.test(value)) {
      const start = Date.parse(entry?.observationWindowStartedAt || entry?.observationStartedAt || '')
      const end = Date.parse(entry?.observationWindowEndsAt || entry?.observationEndedAt || '')
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) state = end <= now.getTime() ? 'accepted' : 'watching'
    } else if (/\bunknown\b/.test(value) && !/^(test_sent|delivered|delivery_delayed)$/.test(String(entry?.result || '').toLowerCase())) {
      // A newer unresolved recovery must not inherit acceptance from an expired
      // test_sent observation. Time elapsed is not a successful provider check.
      state = 'unverified'
    } else if (/test_sent|delivered|watching|delivery_delayed/.test(value)) {
      const ownStart = Date.parse(entry?.observationWindowStartedAt || entry?.observationStartedAt || '')
      const ownEnd = Date.parse(entry?.observationWindowEndsAt || entry?.observationEndedAt || '')
      const start = Number.isFinite(ownStart) ? ownStart : observationWindow?.start
      const end = Number.isFinite(ownEnd) ? ownEnd : observationWindow?.end
      state = Number.isFinite(start) && Number.isFinite(end) && end > start && end <= now.getTime() ? 'accepted' : 'watching'
    }
    if (state) events.push({ state, at: stamp(entry) })
  }
  for (const entry of asArray(item.emailLogs)) {
    if (exactEmail(entry) !== email) continue
    if (entry?.status === 'bounced' || entry?.status === 'failed') events.push({ state: 'bounced', at: stamp(entry) })
    else if (entry?.status === 'replied') events.push({ state: 'accepted', at: stamp(entry) })
  }
  if (item.specificEmailVerified === true && normalizeEmail(item.specificEmailVerifiedFor) === email) events.push({ state: 'accepted', at: Date.parse(item.verificationCheckedAt || '') || 0 })
  const conservativeRank: Record<AddressVerificationState, number> = { invalid: 5, bounced: 4, unverified: 3, watching: 2, accepted: 1 }
  return events.sort((a, b) => b.at - a.at || conservativeRank[b.state] - conservativeRank[a.state])[0]?.state || 'unverified'
}

export function buildEmailCandidateRows(item: PipelineItem, now = new Date()): EmailCandidateRow[] {
  return collectEmailCandidates(item).map(candidate => {
    const quality = classifyEmailCandidate(candidate)
    return { ...candidate, quality, tier: quality.tier, emailType: quality.emailType, verificationState: deriveAddressVerificationState(item, candidate.normalizedEmail, now) }
  })
}

const stateRank: Record<AddressVerificationState, number> = { accepted: 0, watching: 1, unverified: 2, bounced: 3, invalid: 4 }
const tierRank: Record<EmailQualityTier, number> = { A: 0, B: 1, C: 2, D: 3, E: 4 }

export function selectPreferredEmail(rows: EmailCandidateRow[], selectedEmail?: string): EmailCandidateRow | undefined {
  const explicit = normalizeEmail(selectedEmail)
  if (explicit) {
    const selected = rows.find(row => row.normalizedEmail === explicit)
    if (selected) return selected
  }
  return [...rows].sort((a, b) => stateRank[a.verificationState] - stateRank[b.verificationState] || tierRank[a.tier] - tierRank[b.tier])[0]
}
