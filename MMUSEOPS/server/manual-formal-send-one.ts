import { randomUUID } from 'node:crypto'
import { findPersistedDraft, updatePersistedDraft } from '../src/services/draftLookup'
import { canSendFormalOutreach } from '../src/services/formalSendGate'
import { countFormalFollowupSlotsToday, DAILY_FOLLOWUP_SEND_LIMIT, isFormalFollowup, preflightQueueSend, type FormalSendQueueRecord } from '../src/services/formalSendQueue'
import { OFFICIAL_OUTREACH_EMAIL } from '../src/services/outreachIdentity'
import { approveFormalDraftTransaction } from './formal-approval-transaction'
import { FORMAL_SEND_QUEUE_FILE, mutateFormalSendQueue, readFormalSendQueue } from './formal-send-queue-store'
import { formalOutboundKey } from './formal-runner-safety'
import { readItemsAtomic, updateItemsAtomic } from './items-store-atomic'
import { runDueFormalOnce } from './queue-runtime'

type Sender = (input: {
  to: string
  subject: string
  body: string
  customerId: string
  outboundKey?: string
}) => Promise<{ messageId?: string }>

export interface ManualFormalSendOneOptions {
  customerId: string
  draftId: string
  confirmed: boolean
  approvedBy: string
  send: Sender
  itemsPath: string
  queuePath?: string
  now?: Date
}

export async function manualFormalSendOne(options: ManualFormalSendOneOptions) {
  if (options.confirmed !== true) throw new Error('FORMAL_SINGLE_SEND_CONFIRMATION_REQUIRED')
  const now = options.now ?? new Date()
  const at = now.toISOString()
  const queuePath = options.queuePath ?? FORMAL_SEND_QUEUE_FILE

  updateItemsAtomic(items => items.map(item => {
    if (item.id !== options.customerId) return item
    // An already-approved unsent record may be resumed after a pause. Its
    // draft revision is immutable: touching updatedAt here invalidates the
    // durable approval and must not occur before the preflight check.
    if (findPersistedDraft(item, options.draftId)?.draft?.status !== 'pending_human_review') return item
    return updatePersistedDraft(item, options.draftId, draft => ({
      ...draft,
      manualRiskConfirmed: true,
      manualRiskConfirmedAt: at,
      manualRiskConfirmedBy: options.approvedBy,
      updatedAt: at,
    }))
  }), options.itemsPath, now, { refreshOnlyMutated: true })

  const item = readItemsAtomic(options.itemsPath).find(value => value.id === options.customerId)
  const draft = findPersistedDraft(item, options.draftId)?.draft
  if (!item || !draft || draft.sent === true || !['pending_human_review','approved'].includes(draft.status)) throw new Error('DRAFT_NOT_REVIEWABLE')
  const assessment = canSendFormalOutreach({ item, draft, now })
  if (!assessment.canSend) throw new Error(`DRAFT_APPROVAL_BLOCKED:${assessment.blockers.join(',')}`)

  const resumable = draft.status === 'approved' ? readFormalSendQueue(queuePath).records.find(value =>
    value.customerId === options.customerId && value.draftId === options.draftId && value.campaignId === 'manual-one'
    && value.sendQueueStatus === 'approved_for_sending' && (value.sendAttemptCount || 0) === 0
    && !value.providerAuthorizationId && !value.messageId) : undefined
  if (draft.status === 'approved' && !resumable) throw new Error('DRAFT_APPROVAL_ALREADY_CLAIMED')

  const record: FormalSendQueueRecord = {
    id: `queue-manual-one-${Date.now()}-${options.customerId}`,
    campaignId: 'manual-one',
    campaignName: 'Manual single outreach',
    channel: 'formal_outreach',
    draftId: options.draftId,
    customerId: options.customerId,
    recipientEmail: String(draft.to || ''),
    senderEmail: OFFICIAL_OUTREACH_EMAIL,
    replyToEmail: OFFICIAL_OUTREACH_EMAIL,
    approvedAt: at,
    approvedBy: options.approvedBy,
    draftVersion: Number(draft.version || 0),
    draftRevision: String(draft.updatedAt || draft.createdAt || at),
    isOneTimeSchedule: true,
    sendWindowLocal: 'manual single-send confirmation',
    sendQueueStatus: 'approved_for_sending',
    sendAttemptCount: 0,
    ...(isFormalFollowup(undefined, draft) ? { followupRound: (Number(draft.round) === 2 ? 2 : 1) as 1|2 } : {}),
    createdAt: at,
    updatedAt: at,
  }
  const approved = resumable ?? await approveFormalDraftTransaction(record, {
    queuePath: queuePath,
    itemsPath: options.itemsPath,
  })

  const claimId = randomUUID()
  await mutateFormalSendQueue(current => {
    const latestRecord = current.records.find(value => value.id === approved.id)
    const latestItem = readItemsAtomic(options.itemsPath).find(value => value.id === options.customerId)
    const latestDraft = findPersistedDraft(latestItem, options.draftId)?.draft
    if (!latestRecord || latestRecord.sendQueueStatus !== 'approved_for_sending') throw new Error('FORMAL_SINGLE_SEND_RECORD_NOT_READY')
    if (isFormalFollowup(latestRecord, latestDraft) && countFormalFollowupSlotsToday(current.records, now) >= DAILY_FOLLOWUP_SEND_LIMIT) {
      throw new Error('FOLLOWUP_DAILY_LIMIT_REACHED')
    }
    const reasons = preflightQueueSend(latestItem, latestDraft, latestRecord, now)
    if (reasons.length) throw new Error(`FORMAL_SINGLE_SEND_BLOCKED:${reasons.join(',')}`)
    current.records = current.records.map(value => value.id !== latestRecord.id ? value : {
      ...value,
      sendQueueStatus: 'sending',
      sendClaimId: claimId,
      sendClaimedAt: at,
      sendClaimPreviousStatus: value.sendQueueStatus,
      sendClaimPreviousAttemptCount: value.sendAttemptCount || 0,
      sendClaimPreviousLastSendAttemptAt: value.lastSendAttemptAt,
      sendClaimPreviousOutboundKey: value.outboundKey,
      outboundKey: formalOutboundKey(value),
      lastSendAttemptAt: at,
      sendAttemptCount: (value.sendAttemptCount || 0) + 1,
      updatedAt: at,
    })
    return current
  }, { path: queuePath })

  await runDueFormalOnce({
    now,
    send: options.send,
    queuePath: queuePath,
    itemsPath: options.itemsPath,
    runnerLockPath: `${queuePath}.manual-one-runner.lock`,
    claimedRecordIds: [approved.id],
    claimId,
    runWhilePausedCampaignIds: ['manual-one'],
  })
  const result = readFormalSendQueue(queuePath).records.find(value => value.id === approved.id)
  if (!result) throw new Error('FORMAL_SINGLE_SEND_RESULT_MISSING')
  return result
}

