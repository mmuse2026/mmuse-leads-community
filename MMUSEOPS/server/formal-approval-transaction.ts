import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { FormalSendQueueRecord } from '../src/services/formalSendQueue'
import { updatePersistedDraft } from '../src/services/draftLookup'
import { updateItemsAtomic } from './items-store-atomic'
import { FORMAL_SEND_QUEUE_FILE, mutateFormalSendQueue } from './formal-send-queue-store'
import { validateOutboundDraft } from './draft-review-create'

interface ApprovalIntent { version: 1; record: FormalSendQueueRecord }
interface ApprovalOptions { queuePath?: string; itemsPath: string; beforeQueueCommit?: () => void; updateItems?: typeof updateItemsAtomic }
const intentDir = (queuePath: string) => `${queuePath}.approval-intents`
const intentPath = (queuePath: string, id: string) => join(intentDir(queuePath), `${id}.json`)
function writeIntent(queuePath: string, record: FormalSendQueueRecord) {
  const dir = intentDir(queuePath); mkdirSync(dir, { recursive: true })
  const target = intentPath(queuePath, record.id), temp = `${target}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify({ version: 1, record } satisfies ApprovalIntent), 'utf8'); renameSync(temp, target)
}
function clearIntent(queuePath: string, id: string) { try { unlinkSync(intentPath(queuePath, id)) } catch {} }
const RECOVERABLE_QUEUE_STATUSES = new Set(['blocked', 'skipped'])
function sameApprovalKey(value: FormalSendQueueRecord, record: FormalSendQueueRecord): boolean {
  return value.customerId === record.customerId && value.draftId === record.draftId
}
function hasSendEvidence(record: FormalSendQueueRecord): boolean {
  return record.sendQueueStatus === 'sent' || Boolean(record.messageId || record.actualSentAt || (record as any).providerAttemptedAt)
}
function recoverApprovalRecord(existing: FormalSendQueueRecord, requested: FormalSendQueueRecord): FormalSendQueueRecord {
  return {
    ...existing,
    campaignId: requested.campaignId,
    campaignName: requested.campaignName,
    channel: requested.channel,
    recipientEmail: requested.recipientEmail,
    senderEmail: requested.senderEmail,
    replyToEmail: requested.replyToEmail,
    approvedAt: requested.approvedAt,
    approvedBy: requested.approvedBy,
    draftVersion: requested.draftVersion,
    draftRevision: requested.draftRevision,
    timezone: requested.timezone,
    isOneTimeSchedule: requested.isOneTimeSchedule,
    sendWindowLocal: requested.sendWindowLocal,
    sendQueueStatus: 'approved_for_sending',
    sendError: undefined,
    sendClaimId: undefined,
    sendClaimedAt: undefined,
    sendClaimQueueRevision: undefined,
    sendClaimDigest: undefined,
    pendingHumanReview: undefined,
    updatedAt: requested.updatedAt,
  }
}
function approveItem(items: any[], record: FormalSendQueueRecord) {
  let found = false
  const changed = items.map(item => {
    if (item.id !== record.customerId) return item
    found = true
    let draftFound = false
    const updated = updatePersistedDraft(item, record.draftId, draft => {
      draftFound = true
      validateOutboundDraft(draft, record.recipientEmail)
      if (String(item.selectedEmail || '').trim().toLowerCase() !== record.recipientEmail.trim().toLowerCase()) throw new Error('DRAFT_RECIPIENT_MISMATCH')
      return { ...draft, status: 'approved', approvedAt: record.approvedAt, approvedBy: record.approvedBy }
    })
    if (!draftFound) throw new Error('DRAFT_NOT_FOUND')
    return updated
  })
  if (!found) throw new Error('APPROVAL_CUSTOMER_NOT_FOUND')
  return changed
}
export async function approveFormalDraftTransaction(record: FormalSendQueueRecord, options: ApprovalOptions) {
  const queuePath = options.queuePath ?? FORMAL_SEND_QUEUE_FILE, updateItems = options.updateItems ?? updateItemsAtomic
  writeIntent(queuePath, record)
  let itemUpdated = false, queueExisted = false, sendEvidenceExists = false
  try {
    const store = await mutateFormalSendQueue(current => {
      const matches = current.records.filter(value => sameApprovalKey(value, record))
      const evidence = matches.filter(hasSendEvidence)
      if (evidence.length) {
        queueExisted = true
        sendEvidenceExists = true
        current.records = current.records.filter(value => !sameApprovalKey(value, record) || hasSendEvidence(value))
        return current
      }
      const existing = matches.find(hasSendEvidence)
        || matches.find(value => !RECOVERABLE_QUEUE_STATUSES.has(value.sendQueueStatus))
        || matches[0]
      queueExisted = Boolean(existing)
      const approved = existing && !hasSendEvidence(existing) && RECOVERABLE_QUEUE_STATUSES.has(existing.sendQueueStatus)
        ? recoverApprovalRecord(existing, record)
        : existing || record
      if (!existing || !hasSendEvidence(existing)) {
        updateItems(items => approveItem(items, approved), options.itemsPath, new Date(), { refreshOnlyMutated: true }); itemUpdated = true
      }
      options.beforeQueueCommit?.()
      if (!existing) current.records.push(record)
      else current.records = current.records.flatMap(value =>
        sameApprovalKey(value, record) ? (value === existing ? [approved] : []) : [value],
      )
      return current
    }, { path: queuePath })
    clearIntent(queuePath, record.id)
    if (sendEvidenceExists) throw new Error('FORMAL_APPROVAL_SEND_EVIDENCE_EXISTS')
    return store.records.find(value => value.customerId === record.customerId && value.draftId === record.draftId)!
  } catch (error) {
    const invalidDraft = /^(DRAFT_RECIPIENT_MISMATCH|DRAFT_SUBJECT_INVALID|DRAFT_BODY_INVALID|DRAFT_NOT_FOUND|OUTBOUND_SIGNATURE_REQUIRES_REVIEW|OUTBOUND_CONTACT_TYPO_REQUIRES_REVIEW)$/.test(String((error as Error)?.message || ''))
    if (!itemUpdated && (!queueExisted || invalidDraft)) clearIntent(queuePath, record.id)
    throw error
  }
}
export async function recoverFormalApprovalIntents(options: { queuePath?: string; itemsPath: string; updateItems?: typeof updateItemsAtomic }) {
  const queuePath = options.queuePath ?? FORMAL_SEND_QUEUE_FILE, dir = intentDir(queuePath)
  if (!existsSync(dir)) return 0
  let recovered = 0
  for (const name of readdirSync(dir).filter(name => name.endsWith('.json'))) {
    let intent: ApprovalIntent
    try { intent = JSON.parse(readFileSync(join(dir, name), 'utf8')) } catch { continue }
    if (intent?.version !== 1 || !intent.record?.id) continue
    const updateItems = options.updateItems ?? updateItemsAtomic
    await mutateFormalSendQueue(current => {
      const matches = current.records.filter(value => sameApprovalKey(value, intent.record))
      const evidence = matches.filter(hasSendEvidence)
      if (evidence.length) {
        current.records = current.records.filter(value => !sameApprovalKey(value, intent.record) || hasSendEvidence(value))
        return current
      }
      const existing = matches.find(hasSendEvidence)
        || matches.find(value => !RECOVERABLE_QUEUE_STATUSES.has(value.sendQueueStatus))
        || matches[0]
      const approved = existing && !hasSendEvidence(existing) && RECOVERABLE_QUEUE_STATUSES.has(existing.sendQueueStatus)
        ? recoverApprovalRecord(existing, intent.record)
        : existing || intent.record
      if (!existing || !hasSendEvidence(existing)) {
        updateItems(items => approveItem(items, approved), options.itemsPath, new Date(), { refreshOnlyMutated: true })
      }
      if (!existing) current.records.push(intent.record)
      else current.records = current.records.flatMap(value =>
        sameApprovalKey(value, intent.record) ? (value === existing ? [approved] : []) : [value],
      )
      return current
    }, { path: queuePath })
    clearIntent(queuePath, intent.record.id); recovered++
  }
  return recovered
}
