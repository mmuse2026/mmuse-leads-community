import { randomUUID } from 'node:crypto'
import { clearFormalSendClaim, type FormalSendQueueRecord } from '../src/services/formalSendQueue'
import { buildFormalSentContentSnapshot } from './formal-sent-content'
import {
  FORMAL_SEND_QUEUE_FILE,
  mutateFormalSendQueue,
  readFormalSendQueue,
  type FormalSendQueueStore,
} from './formal-send-queue-store'

const DEFAULT_AUTHORIZATION_TTL_MS = 60_000
const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000
const IN_FLIGHT_PAUSE_REASON = 'PROVIDER_SEND_IN_FLIGHT'

type SendInput = import('./formal-sent-content').FormalProviderSendInput

const authorizationActive = (record: FormalSendQueueRecord, now: Date) =>
  record.sendQueueStatus === 'sending' &&
  Boolean(record.providerAuthorizationId) &&
  Date.parse(String(record.providerAuthorizationExpiresAt || '')) > now.getTime()

function clearAuthorization(record: FormalSendQueueRecord): FormalSendQueueRecord {
  return {
    ...record,
    providerAuthorizationId: undefined,
    providerAuthorizedAt: undefined,
    providerAuthorizationExpiresAt: undefined,
  }
}

function completePendingPause(store: FormalSendQueueStore, now: Date): FormalSendQueueStore {
  if (!store.pausePending || store.records.some(record => authorizationActive(record, now))) return store
  return {
    ...store,
    paused: true,
    pausePending: false,
    pauseReason: store.pausePendingReason || 'provider_send_settled_after_pause',
    pausePendingReason: undefined,
  }
}

export function recoverExpiredFormalProviderAuthorizations(store: FormalSendQueueStore, now = new Date()): FormalSendQueueStore {
  const records = store.records.map(record => {
    if (!record.providerAuthorizationId) return record
    const expiresAt = Date.parse(String(record.providerAuthorizationExpiresAt || ''))
    if (Number.isFinite(expiresAt) && expiresAt > now.getTime()) return record
    const released = clearFormalSendClaim(clearAuthorization(record))
    if (record.sendQueueStatus === 'sent' || record.messageId || record.actualSentAt) return released
    return {
      ...released,
      ...(record.sentContentSnapshot?.status === 'prepared'
        ? { sentContentSnapshot: { ...record.sentContentSnapshot, status: 'delivery_unknown' as const } }
        : {}),
      sendQueueStatus: 'needs_manual_reconciliation' as const,
      sendError: 'PROVIDER_AUTHORIZATION_EXPIRED',
      providerAttemptedAt: record.providerAuthorizedAt || now.toISOString(),
      updatedAt: now.toISOString(),
    }
  })
  return completePendingPause({ ...store, records }, now)
}

export async function pauseFormalSendQueue(
  reason = 'manual_pause',
  options: { queuePath?: string; now?: Date } = {},
) {
  const queuePath = options.queuePath || FORMAL_SEND_QUEUE_FILE
  const now = options.now || new Date()
  return mutateFormalSendQueue(current => {
    const recovered = recoverExpiredFormalProviderAuthorizations(current, now)
    if (recovered.records.some(record => authorizationActive(record, now))) {
      return {
        ...recovered,
        paused: false,
        pausePending: true,
        pauseReason: IN_FLIGHT_PAUSE_REASON,
        pausePendingReason: reason,
      }
    }
    return {
      ...recovered,
      paused: true,
      pausePending: false,
      pauseReason: reason,
      pausePendingReason: undefined,
    }
  }, { path: queuePath })
}

export async function authorizeFormalProviderSend(options: {
  queuePath?: string
  recordId: string
  claimId: string
  now?: Date
  authorizationTtlMs?: number
  runWhilePausedCampaignIds?: readonly string[]
}) {
  const queuePath = options.queuePath || FORMAL_SEND_QUEUE_FILE
  const now = options.now || new Date()
  const ttlMs = Math.max(1, options.authorizationTtlMs ?? DEFAULT_AUTHORIZATION_TTL_MS)
  const authorizationId = randomUUID()
  let authorized = false
  const saved = await mutateFormalSendQueue(current => {
    const recovered = recoverExpiredFormalProviderAuthorizations(current, now)
    if (recovered.pausePending) return recovered
    return {
      ...recovered,
      records: recovered.records.map(record => {
        if (record.id !== options.recordId) return record
        if (recovered.paused && !options.runWhilePausedCampaignIds?.includes(String(record.campaignId || ''))) return record
        if (record.sendQueueStatus !== 'sending' || record.sendClaimId !== options.claimId || record.providerAuthorizationId) return record
        authorized = true
        return {
          ...record,
          providerAuthorizationId: authorizationId,
          providerAuthorizedAt: now.toISOString(),
          providerAuthorizationExpiresAt: new Date(now.getTime() + ttlMs).toISOString(),
          updatedAt: now.toISOString(),
        }
      }),
    }
  }, { path: queuePath })
  const record = saved.records.find(value => value.id === options.recordId)
  return authorized && record?.providerAuthorizationId === authorizationId
    ? { authorizationId, authorizedAt: now.toISOString(), expiresAt: record.providerAuthorizationExpiresAt as string }
    : null
}

export async function settleFormalProviderSend(options: {
  queuePath?: string
  recordId: string
  authorizationId: string
  now?: Date
  outcome: 'sent' | 'ambiguous'
  messageId?: string
  error?: unknown
  ambiguousErrorPrefix?: string
  sentPatch?: Partial<FormalSendQueueRecord>
}) {
  const queuePath = options.queuePath || FORMAL_SEND_QUEUE_FILE
  const now = options.now || new Date()
  let matched = false
  const saved = await mutateFormalSendQueue(current => {
    const records = current.records.map(record => {
      if (record.id !== options.recordId || record.providerAuthorizationId !== options.authorizationId) return record
      matched = true
      const released = clearFormalSendClaim(clearAuthorization(record))
      if (options.outcome === 'sent' && options.messageId) {
        return {
          ...released,
          ...options.sentPatch,
          ...(record.sentContentSnapshot ? {
            sentContentSnapshot: {
              ...record.sentContentSnapshot,
              status: 'sent' as const,
              messageId: options.messageId,
              sentAt: options.sentPatch?.actualSentAt || now.toISOString(),
            },
          } : {}),
          sendQueueStatus: 'sent' as const,
          actualSentAt: options.sentPatch?.actualSentAt || now.toISOString(),
          messageId: options.messageId,
          provider: 'zoho_smtp' as const,
          deliveryStatus: 'sent_observation' as const,
          updatedAt: now.toISOString(),
        }
      }
      const detail = String(options.error instanceof Error ? options.error.message : options.error || 'provider_result_ambiguous').slice(0, 600)
      const postProviderFailureAudit = [
        ...(Array.isArray((record as any).postProviderFailureAudit) ? (record as any).postProviderFailureAudit : []),
        { at: now.toISOString(), error: detail, phase: 'after_provider_started' },
      ]
      return {
        ...released,
        ...(record.sentContentSnapshot ? {
          sentContentSnapshot: { ...record.sentContentSnapshot, status: 'delivery_unknown' as const },
        } : {}),
        sendQueueStatus: 'needs_manual_reconciliation' as const,
        sendError: options.ambiguousErrorPrefix ? `${options.ambiguousErrorPrefix}:${detail}` : 'SMTP_RESULT_AMBIGUOUS',
        smtpErrorDetail: detail,
        smtpErrorAt: now.toISOString(),
        providerAttemptedAt: now.toISOString(),
        postProviderFailureAudit,
        updatedAt: now.toISOString(),
      }
    })
    return completePendingPause({ ...current, records }, now)
  }, { path: queuePath })
  if (!matched) throw new Error('FORMAL_PROVIDER_AUTHORIZATION_MISMATCH')
  return saved
}

function withTimeout<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('FORMAL_PROVIDER_TIMEOUT')), timeoutMs)
    Promise.resolve()
      .then(operation)
      .then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}

export async function executeAuthorizedFormalProviderSend(options: {
  queuePath?: string
  recordId: string
  claimId: string
  now?: Date
  authorizationTtlMs?: number
  runWhilePausedCampaignIds?: readonly string[]
  providerTimeoutMs?: number
  input: SendInput
  send: (input: SendInput) => Promise<{ messageId?: string }>
  sentPatch?: Partial<FormalSendQueueRecord>
  ambiguousErrorPrefix?: string
  onProviderStart?: () => void
}): Promise<
  | { status: 'not_authorized' }
  | { status: 'sent'; messageId: string }
  | { status: 'ambiguous'; error: string }
> {
  const queuePath = options.queuePath || FORMAL_SEND_QUEUE_FILE
  const now = options.now || new Date()
  const authorization = await authorizeFormalProviderSend({
    queuePath,
    recordId: options.recordId,
    claimId: options.claimId,
    now,
    authorizationTtlMs: options.authorizationTtlMs,
    runWhilePausedCampaignIds: options.runWhilePausedCampaignIds,
  })
  if (!authorization) return { status: 'not_authorized' }
  const durable = readFormalSendQueue(queuePath).records.find(record => record.id === options.recordId)
  if (durable?.providerAuthorizationId !== authorization.authorizationId || durable.sendClaimId !== options.claimId) {
    return { status: 'not_authorized' }
  }
  try {
    const snapshot = buildFormalSentContentSnapshot(options.input, {
      draftId: String(durable.draftId || ''),
      capturedAt: now.toISOString(),
      status: 'prepared',
    })
    let snapshotPersisted = false
    await mutateFormalSendQueue(current => ({
      ...current,
      records: current.records.map(record => {
        if (record.id !== options.recordId || record.providerAuthorizationId !== authorization.authorizationId || record.sendClaimId !== options.claimId || record.sendQueueStatus !== 'sending') return record
        snapshotPersisted = true
        return { ...record, sentContentSnapshot: snapshot, updatedAt: now.toISOString() }
      }),
    }), { path: queuePath })
    if (!snapshotPersisted) throw new Error('FORMAL_CONTENT_SNAPSHOT_CLAIM_MISMATCH')
    options.onProviderStart?.()
    const result = await withTimeout(
      () => options.send(options.input),
      Math.max(1, options.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS),
    )
    if (!result.messageId) throw new Error('message_id_missing')
    await settleFormalProviderSend({
      queuePath,
      recordId: options.recordId,
      authorizationId: authorization.authorizationId,
      now,
      outcome: 'sent',
      messageId: result.messageId,
      sentPatch: options.sentPatch,
    })
    return { status: 'sent', messageId: result.messageId }
  } catch (error) {
    await settleFormalProviderSend({
      queuePath,
      recordId: options.recordId,
      authorizationId: authorization.authorizationId,
      now,
      outcome: 'ambiguous',
      error,
      ambiguousErrorPrefix: options.ambiguousErrorPrefix,
    })
    return { status: 'ambiguous', error: String(error instanceof Error ? error.message : error) }
  }
}
