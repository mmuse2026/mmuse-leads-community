import { randomUUID } from 'node:crypto'
import { formalOutboundKey } from './formal-runner-safety'
import {
  createFormalSendGrantBinding,
  formalSendGrantTaskTuples,
  type FormalQueueSecurity,
} from './formal-queue-security'
import {
  FORMAL_SEND_QUEUE_FILE,
  formalDailyUsage,
  readFormalSendQueue,
  withFormalSendQueueLock,
  writeFormalSendQueue,
} from './formal-send-queue-store'

type AuthInput = { origin: string; remoteAddress: string; operatorToken: string; csrfToken: string }

export async function issueLockedFormalSendGrant(options: {
  security: FormalQueueSecurity
  auth: AuthInput
  queuePath?: string
  now?: Date
}) {
  const queuePath = options.queuePath ?? FORMAL_SEND_QUEUE_FILE
  const now = options.now ?? new Date()
  return withFormalSendQueueLock(() => {
    const binding = createFormalSendGrantBinding(readFormalSendQueue(queuePath), now)
    return options.security.issueSendGrant(options.auth, binding)
  }, { path: queuePath })
}

export async function claimFormalSendGrantTargets(options: {
  security: FormalQueueSecurity
  auth: AuthInput
  token: string
  safeMode: boolean
  queuePath?: string
  now?: Date
  maxTargets?: number
}): Promise<
  | { ok: true; code: string; claimId: string; claimedRecordIds: string[]; queueRevision: number }
  | { ok: false; code: string; claimedRecordIds: [] }
> {
  const queuePath = options.queuePath ?? FORMAL_SEND_QUEUE_FILE
  const now = options.now ?? new Date()
  return withFormalSendQueueLock(() => {
    const current = readFormalSendQueue(queuePath)
    if (current.pausePending) return { ok: false as const, code: 'FORMAL_QUEUE_PAUSED', claimedRecordIds: [] as [] }
    const binding = createFormalSendGrantBinding(current, now)
    const consumed = options.security.consumeSendGrant(options.token, options.auth, options.safeMode, binding)
    if (!consumed.ok) return { ok: false as const, code: consumed.code, claimedRecordIds: [] as [] }
    if (current.paused) return { ok: false as const, code: 'FORMAL_QUEUE_PAUSED', claimedRecordIds: [] as [] }
    const maxDaily = Math.min(100, Math.max(0, Number(current.config.dailyMaxSendCount) || 0), Math.max(0, Number(current.config.autoSendDailyLimit) || 0))
    const reserved = current.records.filter(record => record.sendQueueStatus === 'sending').length
    const remaining = Math.max(0, maxDaily - formalDailyUsage(current.records, now) - reserved)
    if (!remaining) return { ok: false as const, code: 'FORMAL_DAILY_LIMIT', claimedRecordIds: [] as [] }
    const allTargets = formalSendGrantTaskTuples(current, now)
    if (allTargets.length !== binding.targetCount) return { ok: false as const, code: 'FORMAL_SEND_GRANT_MISMATCH', claimedRecordIds: [] as [] }
    const limit = Number.isSafeInteger(options.maxTargets) && Number(options.maxTargets) > 0 ? Number(options.maxTargets) : allTargets.length
    const targetIds = [...allTargets]
      .sort((left, right) => Date.parse(left.scheduledSendAt) - Date.parse(right.scheduledSendAt) || left.id.localeCompare(right.id))
      .slice(0, Math.min(limit, remaining))
      .map(tuple => tuple.id)
    const targetSet = new Set(targetIds)
    const claimId = randomUUID()
    const claimedAt = now.toISOString()
    const next = {
      ...current,
      records: current.records.map(record => targetSet.has(record.id) ? {
        ...record,
        sendQueueStatus: 'sending' as const,
        sendClaimId: claimId,
        sendClaimedAt: claimedAt,
        sendClaimQueueRevision: current.revision,
        sendClaimDigest: binding.taskDigest,
        sendClaimPreviousStatus: record.sendQueueStatus,
        sendClaimPreviousAttemptCount: record.sendAttemptCount || 0,
        sendClaimPreviousLastSendAttemptAt: record.lastSendAttemptAt,
        sendClaimPreviousOutboundKey: record.outboundKey,
        outboundKey: formalOutboundKey(record),
        lastSendAttemptAt: claimedAt,
        sendAttemptCount: (record.sendAttemptCount || 0) + 1,
        updatedAt: claimedAt,
      } : record),
    }
    const saved = writeFormalSendQueue(next, queuePath, current.revision)
    return {
      ok: true as const,
      code: 'FORMAL_SEND_GRANT_CLAIMED',
      claimId,
      claimedRecordIds: targetIds,
      queueRevision: saved.revision,
    }
  }, { path: queuePath })
}
