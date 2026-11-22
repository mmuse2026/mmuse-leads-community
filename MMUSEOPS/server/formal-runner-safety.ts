import { createHash } from 'node:crypto'
import { clearFormalSendClaim, type FormalSendQueueRecord } from '../src/services/formalSendQueue'

export function formalOutboundKey(record: Pick<FormalSendQueueRecord, 'campaignId' | 'draftId' | 'customerId'>): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(['formal-outbound-v1', record.campaignId, record.customerId, record.draftId]))
    .digest('hex')
  return `formal:v1:${digest}`
}


export function recoverStaleFormalSending(
  records: FormalSendQueueRecord[],
  now = new Date(),
  staleAfterMs = 30 * 60_000,
): FormalSendQueueRecord[] {
  return records.map(record => {
    if (record.sendQueueStatus !== 'sending') return record
    const claimedAt = Date.parse(record.lastSendAttemptAt || record.updatedAt)
    if (Number.isFinite(claimedAt) && now.getTime() - claimedAt <= staleAfterMs) return record
    return {
      ...clearFormalSendClaim(record),
      sendQueueStatus: 'needs_manual_reconciliation',
      sendError: 'SEND_CLAIM_STALE',
      updatedAt: now.toISOString(),
    }
  })
}
