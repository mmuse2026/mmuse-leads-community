import type { PipelineItem } from '../types/item'
import { normalizeEmail } from './emailQualityPolicy'

export interface DnsVerificationOutcome {
  email: string
  dnsResult: string
  checkedAt: string
  evidenceSummary?: string
}

const list = (value: unknown): any[] => Array.isArray(value) ? value : []

/** Stop automatic retries after inconclusive observations, without inventing a negative MX result. */
const MAX_UNKNOWN_RETRIES = 3

/** 该 email 已观察到的 unknown 次数 = 历史 domain_mx_unknown 证据数（旧代码污染也计入）
 *  与 routing.dnsRetryCount（新逻辑累计）取大者。 */
function unknownRetryCount(item: PipelineItem, email: string): number {
  const unknownEvidence = list(item.emailVerificationEvidence).filter(entry =>
    normalizeEmail(entry?.email) === email && entry?.result === 'domain_mx_unknown').length
  const routingEntry = list(item.emailVerificationRouting).find(entry => normalizeEmail(entry?.email) === email)
  const routingCount = Number(routingEntry?.dnsRetryCount) || 0
  return Math.max(unknownEvidence, routingCount)
}

function withUnknownBase(item: PipelineItem, email: string, checkedAt: string): PipelineItem {
  return {
    ...item,
    emailVerification: 'unknown',
    verificationScope: 'domain_only',
    verificationSource: 'dns_mx',
    verificationMethod: 'multi_source_dns',
    verificationCheckedAt: checkedAt,
    emailVerificationCheckedAt: checkedAt,
    specificEmailVerified: false,
    specificEmailVerifiedFor: undefined,
  }
}

export function applyDnsVerificationOutcome(
  item: PipelineItem,
  input: DnsVerificationOutcome,
): PipelineItem {
  const email = normalizeEmail(input.email)
  // Domain-only checks must not overwrite trusted evidence for this or another mailbox.
  if (item.specificEmailVerified === true && normalizeEmail(item.specificEmailVerifiedFor)) return item
  const semanticResult = input.dnsResult === 'dns_mx_ok' || input.dnsResult === 'domain_mx_pass'
    ? 'domain_mx_pass'
    : input.dnsResult === 'dns_failed' || input.dnsResult === 'domain_mx_fail'
      ? 'domain_mx_fail'
      : 'domain_mx_unknown'

  if (semanticResult === 'domain_mx_unknown') {
    const retryCount = unknownRetryCount(item, email) + 1
    const priorRouting = list(item.emailVerificationRouting).find(entry => normalizeEmail(entry?.email) === email)
    // 已是终态（routing=unreachable）的邮箱不因后续 unknown 回退/重计，避免 7 天后重查又写回 retry。
    if (priorRouting?.queue === 'unreachable') return item

    const exhausted = retryCount >= MAX_UNKNOWN_RETRIES
    // Timeouts/unknown remain unknown. Exhaustion requests review; it is not evidence of invalidity.
    return {
      ...withUnknownBase(item, email, input.checkedAt),
      emailVerificationEvidence: item.emailVerificationEvidence,
      emailVerificationRouting: [
        ...list(item.emailVerificationRouting).filter(entry => normalizeEmail(entry?.email) !== email),
        {
          email,
          queue: exhausted ? 'manual_confirmation' : 'retry_queue',
          reason: exhausted
            ? `DNS/MX result: ${semanticResult}; ${retryCount} inconclusive attempts; manual review required, not invalid`
            : `DNS/MX result: ${semanticResult}; attempt ${retryCount}/${MAX_UNKNOWN_RETRIES}; retrying`,
          updatedAt: input.checkedAt,
          dnsRetryCount: retryCount,
        },
      ],
    }
  }

  const evidence = {
    email,
    result: semanticResult,
    rawResult: input.dnsResult,
    scope: 'domain' as const,
    source: 'dns_mx',
    method: 'multi_source_dns',
    checkedAt: input.checkedAt,
    note: `${input.evidenceSummary || input.dnsResult}; domain-level only; not verified.`,
  }
  const exists = list(item.emailVerificationEvidence).some(entry =>
    normalizeEmail(entry?.email) === email
    && entry?.result === semanticResult
    && entry?.checkedAt === input.checkedAt)
  const queue = semanticResult === 'domain_mx_pass'
    ? 'manual_confirmation'
    : 'unreachable'
  return {
    ...withUnknownBase(item, email, input.checkedAt),
    emailVerificationEvidence: exists
      ? item.emailVerificationEvidence
      : [...list(item.emailVerificationEvidence), evidence],
    emailVerificationRouting: [
      ...list(item.emailVerificationRouting).filter(entry => normalizeEmail(entry?.email) !== email),
      {
        email,
        queue,
        reason: `DNS/MX result: ${semanticResult}; domain-only; no test-mail queue created`,
        updatedAt: input.checkedAt,
      },
    ],
  }
}
