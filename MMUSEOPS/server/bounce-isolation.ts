import { addIsolationBatch, type IsolationEntry } from './isolation-store'

export type BounceIsolationReason = 'hard_bounce' | 'suppressed' | 'complaint' | 'send_failed'

/**
 * Builds isolation entries for a confirmed delivery failure of an email address.
 *
 * Deliberately registers the bounced EMAIL only, not the domain: a single bad
 * mailbox does not prove the whole domain is bad (e.g. placeholder local parts),
 * and domain-level exclusion remains a manual decision.
 */
export function buildBounceIsolationEntries(input: {
  email: string
  reason: BounceIsolationReason
  customerId: string
  sourceStage: string
  note?: string
  now?: string
}): IsolationEntry[] {
  const isolatedAt = input.now || new Date().toISOString()
  const email = String(input.email || '').trim().toLowerCase()
  if (!email || !email.includes('@')) return []
  return [{
    objectType: 'email',
    objectValue: email,
    reason: input.reason,
    sourceStage: String(input.sourceStage || ''),
    isolatedAt,
    originalCustomerId: String(input.customerId || ''),
    permanent: true,
    ...(input.note ? { note: String(input.note) } : {}),
  }]
}

/**
 * Registers a bounced email into the isolation store (idempotent; atomic write).
 * Returns the number of new entries actually added.
 */
export function registerBounceIsolation(
  input: {
    email: string
    reason: BounceIsolationReason
    customerId: string
    sourceStage: string
    note?: string
    now?: string
  },
  path?: string,
): number {
  const entries = buildBounceIsolationEntries(input)
  if (entries.length === 0) return 0
  return addIsolationBatch(entries, path)
}
