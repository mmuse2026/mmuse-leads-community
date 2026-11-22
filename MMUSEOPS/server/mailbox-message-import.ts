import { createHash } from 'node:crypto'
import { OFFICIAL_OUTREACH_EMAIL } from '../src/services/outreachIdentity'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readItemsAtomic, updateItemsAtomic } from './items-store-atomic'

const { parseMailboxMessage } = require('../../Unified-Workbench/src/mailbox-message-evidence.cjs')
const list = (value: any): any[] => Array.isArray(value) ? value : []
const norm = (value: any) => String(value || '').trim().toLowerCase()
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

export function matchMailboxCustomer(items: any[], message: any, requestedId?: string) {
  const counterparties = message.direction === 'inbound' ? [message.fromEmail] : message.toEmails
  const matches = items.filter(item => {
    const addresses = [item.email, item.selectedEmail, ...list(item.contacts).map(contact => contact.email), ...list(item.emailLogs).map(log => log.recipientEmail || log.to), ...list(item.zohoReplyEvidence).map(reply => reply.fromEmail)].map(norm)
    return counterparties.some((email: string) => addresses.includes(norm(email))) || list(item.communicationEvents).some(event => String(event.externalMessageId) === message.mailboxMessageId)
  })
  if (requestedId) {
    const exact = matches.find(item => item.id === requestedId)
    if (!exact) throw Error('MAILBOX_CUSTOMER_ADDRESS_MISMATCH')
    return exact
  }
  if (!matches.length) throw Error('MAILBOX_CUSTOMER_UNASSIGNED')
  if (matches.length !== 1) throw Error('MAILBOX_CUSTOMER_AMBIGUOUS')
  return matches[0]
}

export function applyMailboxMessage(item: any, message: any, snapshotId: string, evidencePath: string, now = new Date()) {
  const at = now.toISOString(), id = message.mailboxMessageId
  const existing = list(item.zohoReplyEvidence).find(entry => String(entry.messageId) === id)
  if (existing?.bodySha256 && existing.bodySha256 !== message.bodySha256) throw Error('MAILBOX_MESSAGE_REVISION_REVIEW_REQUIRED')
  const existingEvent = list(item.communicationEvents).find(event => String(event.externalMessageId) === id || event.id === `bbox-${id}`)
  const repliedBy = list(item.communicationEvents).find(event => event.direction === 'outbound' && event.externalMessageId && (
    event.inReplyTo === id || event.replyToMailboxMessageId === id ||
    (String(event.createdBy || '').startsWith('codex:') && String(event.content || '').includes(`对应原始来信会话编号：${id}`))
  ))
  const normalized = {
    ...existing, messageId: id, fromEmail: message.fromEmail, fromMasked: message.fromEmail,
    toEmails: message.toEmails, subject: message.subject, fullBody: message.body, textSummary: message.body.slice(0, 1200),
    date: message.date, displayedDate: message.displayedDate, dateBasis: message.dateBasis, observedAt: message.observedAt,
    classification: existing?.classification || 'unclassified', bboxVerified: true, sourceSnapshotId: snapshotId,
    sourceEvidencePath: evidencePath, bodySha256: message.bodySha256, mailboxAccount: message.account,
    ...(repliedBy ? { repliedByMessageId: repliedBy.externalMessageId } : {}),
  }
  const event = {
    ...existingEvent, id: existingEvent?.id || `bbox-${id}`, occurredAt: existingEvent?.occurredAt || message.date,
    channel: 'email', direction: message.direction, eventType: existingEvent?.eventType || 'mailbox_message_received',
    content: existingEvent?.content || message.body, rawBody: message.body, subject: message.subject,
    externalMessageId: id, fromEmail: message.fromEmail, toEmails: message.toEmails, bodySha256: message.bodySha256,
    sourceSnapshotId: snapshotId, sourceEvidencePath: evidencePath, bboxVerified: true,
    createdBy: existingEvent?.createdBy || 'bbox:official-mail-intake', createdAt: existingEvent?.createdAt || at,
    source: existingEvent?.source || 'bbox_official_mail_ui', dedupeKey: existingEvent?.dedupeKey || `bbox:${id}`,
  }
  const events = existingEvent ? list(item.communicationEvents).map(entry => entry.id === existingEvent.id ? event : entry) : [...list(item.communicationEvents), event]
  const replies = message.direction !== 'inbound' ? list(item.zohoReplyEvidence) : existing
    ? list(item.zohoReplyEvidence).map(entry => String(entry.messageId) === id ? normalized : entry)
    : [...list(item.zohoReplyEvidence), normalized]
  return { ...item, zohoReplyEvidence: replies, communicationEvents: events, updatedAt: at }
}

export function importMailboxMessage(options: { snapshotId: string; customerId?: string; itemsPath: string; runtimeDirectory: string; now?: Date }) {
  if (!/^[a-f0-9-]{36}$/.test(options.snapshotId)) throw Error('MAILBOX_SNAPSHOT_ID_INVALID')
  const evidencePath = join(options.runtimeDirectory, 'mailbox-ui', 'results', options.snapshotId + '.json')
  const message = parseMailboxMessage(JSON.parse(readFileSync(evidencePath, 'utf8')), OFFICIAL_OUTREACH_EMAIL)
  const items = readItemsAtomic(options.itemsPath), customer = matchMailboxCustomer(items, message, options.customerId)
  const prior = list(customer.communicationEvents).find(event => String(event.externalMessageId) === message.mailboxMessageId && event.bodySha256 === message.bodySha256 && event.bboxVerified === true)
  if (prior) return { ok: true, idempotent: true, customerId: customer.id, messageId: message.mailboxMessageId, direction: message.direction }
  const now = options.now || new Date()
  const preview = { customerId: customer.id, messageId: message.mailboxMessageId, direction: message.direction, fromEmail: message.fromEmail, toEmails: message.toEmails, subject: message.subject, bodySha256: message.bodySha256, sourceSnapshotId: options.snapshotId, at: now.toISOString() }
  const auditDir = join(options.runtimeDirectory, 'mailbox-import-audit'); mkdirSync(auditDir, { recursive: true })
  const key = `${message.mailboxMessageId}-${message.bodySha256.slice(0, 12)}`
  writeFileSync(join(auditDir, key + '.preview.json'), JSON.stringify(preview, null, 2))
  const backup = join(auditDir, key + '.items-backup.json'); if (!existsSync(backup)) copyFileSync(options.itemsPath, backup)
  updateItemsAtomic(current => current.map(item => item.id !== customer.id ? item : applyMailboxMessage(item, message, options.snapshotId, evidencePath, now)), options.itemsPath, now, { refreshOnlyMutated: true, skipEligibilityRefresh: true })
  const persisted = readItemsAtomic(options.itemsPath).find(item => item.id === customer.id)
  if (!list(persisted?.communicationEvents).some(event => event.externalMessageId === message.mailboxMessageId && event.bodySha256 === digest(message.body))) throw Error('MAILBOX_IMPORT_NOT_CONFIRMED')
  return { ok: true, idempotent: false, customerId: customer.id, messageId: message.mailboxMessageId, direction: message.direction }
}
