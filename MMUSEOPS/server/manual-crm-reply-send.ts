import { createHash, randomUUID } from 'node:crypto'
import { buildOutboundEmail } from '../src/services/emailSignature'
import { OFFICIAL_OUTREACH_EMAIL } from '../src/services/outreachIdentity'
import { updateItemsAtomic, readItemsAtomic } from './items-store-atomic'
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { mutateFormalSendQueue } from './formal-send-queue-store'
import { shanghaiDayKey, type FormalSendQueueRecord } from '../src/services/formalSendQueue'

type SendReply = (input: { to: string; subject: string; content: string; inReplyTo?: string; references: string[]; outboundKey: string }) => Promise<{ messageId?: string }>

export interface ManualCrmReplySendOptions {
  customerId: string
  replyMessageId: string
  to: string
  subject: string
  body: string
  confirmed: boolean
  approvedBy: string
  itemsPath: string
  queuePath?: string
  send: SendReply
  now?: Date
}

const norm = (value: unknown) => String(value || '').trim().toLowerCase()
const cleanMessageId = (value: unknown) => String(value || '').trim()

export async function sendCrmReplyOne(options: ManualCrmReplySendOptions) {
  if (options.confirmed !== true) throw new Error('CRM_REPLY_CONFIRMATION_REQUIRED')
  const to = norm(options.to)
  const subject = String(options.subject || '').trim()
  const body = String(options.body || '').trim()
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error('CRM_REPLY_RECIPIENT_INVALID')
  if (!subject || subject.length > 500) throw new Error('CRM_REPLY_SUBJECT_INVALID')
  if (!body || body.length > 20000) throw new Error('CRM_REPLY_BODY_INVALID')
  const now = options.now ?? new Date()
  const at = now.toISOString()
  const outboundKey = `crm-reply-${createHash('sha256').update(`${options.customerId}|${options.replyMessageId}|${subject}|${body}`).digest('hex').slice(0, 40)}`
  const attemptId = randomUUID()
  let source: any
  const audit = (phase: string) => {
    const folder=join(dirname(options.itemsPath),'backups','crm-reply',attemptId);mkdirSync(folder,{recursive:true})
    writeFileSync(join(folder,phase+'.preview.json'),JSON.stringify({customerId:options.customerId,replyMessageId:options.replyMessageId,to,subject,body,outboundKey,phase,at:new Date().toISOString()},null,2))
    copyFileSync(options.itemsPath,join(folder,phase+'.items.json'))
    if(options.queuePath&&existsSync(options.queuePath))copyFileSync(options.queuePath,join(folder,phase+'.queue.json'))
  }

  const claimSource = () => updateItemsAtomic(items => {
    if (!items.some(item => String(item?.id) === options.customerId)) throw new Error('CRM_REPLY_SOURCE_NOT_FOUND')
    return items.map(item => {
    if (String(item?.id) !== options.customerId) return item
    if (item.doNotContactEmail === true || item.emailOptOut === true) throw Error('CRM_REPLY_CONTACT_SUPPRESSED')
    const evidence = (Array.isArray(item.zohoReplyEvidence) ? item.zohoReplyEvidence : [])
      .find((entry: any) => cleanMessageId(entry?.messageId) === cleanMessageId(options.replyMessageId))
    if (!evidence || evidence.classification !== 'reply') throw new Error('CRM_REPLY_SOURCE_NOT_FOUND')
    if (evidence.repliedByMessageId) throw new Error('CRM_REPLY_ALREADY_SENT')
    if ((Array.isArray(item.zohoReplyEvidence) ? item.zohoReplyEvidence : []).some((entry:any)=>entry.bboxVerified&&entry.classification==='unclassified'&&Date.parse(entry.date)>Date.parse(evidence.date))) throw Error('CRM_REPLY_STALE_SOURCE')
    const replies = (Array.isArray(item.zohoReplyEvidence) ? item.zohoReplyEvidence : []).filter((entry: any) => entry?.classification === 'reply')
    const latestReply = replies.sort((left: any, right: any) => Date.parse(String(right?.date || '')) - Date.parse(String(left?.date || '')))[0]
    if (latestReply?.messageId !== evidence.messageId) throw new Error('CRM_REPLY_STALE_SOURCE')
    if (!evidence.fromEmail || norm(evidence.fromEmail) !== to) throw new Error('CRM_REPLY_RECIPIENT_MISMATCH')
    if (!String(evidence.fullBody || evidence.textSummary || '').trim()) throw new Error('CRM_REPLY_SOURCE_BODY_MISSING')
    const attempts = Array.isArray(item.crmReplySendAttempts) ? item.crmReplySendAttempts : []
    if (attempts.some((entry: any) => cleanMessageId(entry?.sourceMessageId) === cleanMessageId(options.replyMessageId))) {
      const prior = attempts.find((entry: any) => cleanMessageId(entry?.sourceMessageId) === cleanMessageId(options.replyMessageId))
      throw new Error(prior?.status === 'sent' ? 'CRM_REPLY_ALREADY_SENT' : 'CRM_REPLY_RECONCILIATION_REQUIRED')
    }
    source = structuredClone(evidence)
    audit('claim')
    return {
      ...item,
      crmReplySendAttempts: [...attempts, {
        id: attemptId, outboundKey, sourceMessageId: options.replyMessageId,
        status: 'sending', to, subject, body, startedAt: at, approvedBy: options.approvedBy,
      }],
      updatedAt: at,
    }
  })}, options.itemsPath, now, { refreshOnlyMutated: true, skipEligibilityRefresh: true })

  if (options.queuePath) {
    await mutateFormalSendQueue(store => {
      const today = shanghaiDayKey(now)
      const used = store.records.filter(record => {
        const stamp = record.actualSentAt || record.providerAttemptedAt || record.lastSendAttemptAt
        return stamp && shanghaiDayKey(stamp) === today
      }).length
      if (used >= Math.min(100, store.config.dailyMaxSendCount, store.config.autoSendDailyLimit)) throw Error('CRM_REPLY_DAILY_LIMIT')
      if (store.records.some(record => record.id === outboundKey)) throw Error('CRM_REPLY_RECONCILIATION_REQUIRED')
      if (existsSync(options.queuePath!)) copyFileSync(options.queuePath!, options.queuePath + '.crm-reply.backup')
      claimSource()
      const reservation: FormalSendQueueRecord = {
        id: outboundKey, campaignId: 'crm-reply', campaignName: '逐封审核客户回复', draftId: outboundKey,
        customerId: options.customerId, recipientEmail: to, senderEmail: OFFICIAL_OUTREACH_EMAIL, replyToEmail: OFFICIAL_OUTREACH_EMAIL,
        isOneTimeSchedule: true, sendWindowLocal: 'any', sendQueueStatus: 'sending', sendAttemptCount: 1,
        lastSendAttemptAt: at, outboundKey, approvedAt: at, approvedBy: options.approvedBy, createdAt: at, updatedAt: at,
      }
      store.records.push(reservation)
      return store
    }, { path: options.queuePath })
  } else claimSource()
  if (!source) throw Error('CRM_REPLY_SOURCE_NOT_FOUND')

  const sourceMessageId = cleanMessageId(source?.messageId)
  const rfcId = (value:unknown) => /^<[^<>\s]+@[^<>\s]+>$/.test(cleanMessageId(value)) ? cleanMessageId(value) : undefined
  const references = [...new Set([
    ...(Array.isArray(source?.references) ? source.references.map(cleanMessageId) : []),
    cleanMessageId(source?.inReplyTo), sourceMessageId,
  ].filter(value=>Boolean(rfcId(value))))]
  try {
    const rendered = buildOutboundEmail(body)
    const sent = await options.send({ to, subject, content: rendered.text, inReplyTo: rfcId(source?.rfcMessageId)||rfcId(sourceMessageId), references, outboundKey })
    if (!sent?.messageId) throw new Error('CRM_REPLY_PROVIDER_MESSAGE_ID_MISSING')
    const sentAt = (options.now ?? new Date()).toISOString()
    audit('provider-result')
    updateItemsAtomic(items => items.map(item => {
      if (String(item?.id) !== options.customerId) return item
      const attempts = Array.isArray(item.crmReplySendAttempts) ? item.crmReplySendAttempts : []
      const updatedAttempts = attempts.map((entry: any) => entry.id === attemptId
        ? { ...entry, status: 'sent', messageId: sent.messageId, sentAt }
        : entry)
      const emailLogs = Array.isArray(item.emailLogs) ? item.emailLogs : []
      const duplicateLog = emailLogs.some((entry: any) => entry?.messageId === sent.messageId)
      const log = { type: 'crm_reply', status: 'sent', messageId: sent.messageId, inReplyTo: sourceMessageId, references, recipientEmail: to, subject, body: rendered.text, sentAt, senderEmail: OFFICIAL_OUTREACH_EMAIL, approvedBy: options.approvedBy }
      const tasks = Array.isArray(item.crmTasks) ? item.crmTasks : []
      const taskSource = `zoho_reply:${sourceMessageId.replace(/^<|>$/g, '').toLowerCase()}`
      return {
        ...item,
        crmReplySendAttempts: updatedAttempts,
        emailLogs: duplicateLog ? emailLogs : [...emailLogs, log],
        communicationEvents: [...(Array.isArray(item.communicationEvents) ? item.communicationEvents : []), {
          id: `crm-reply:${sent.messageId}`, occurredAt: sentAt, channel: 'email', direction: 'outbound', eventType: 'customer_reply',
          subject, content: rendered.text, inReplyTo: sourceMessageId, outcome: 'sent', source: 'manual', createdBy: options.approvedBy,
          createdAt: sentAt, externalMessageId: sent.messageId, dedupeKey: `message:${sent.messageId}`,
        }],
        crmTasks: tasks.map((task: any) => task?.type === 'reply_customer' && task?.status === 'pending' && task?.source === taskSource
          ? { ...task, status: 'completed', completedAt: sentAt, completionResult: `Replied via Zoho SMTP; messageId=${sent.messageId}` }
          : task),
        zohoReplyEvidence: (Array.isArray(item.zohoReplyEvidence) ? item.zohoReplyEvidence : []).map((entry: any) => cleanMessageId(entry.messageId) === sourceMessageId ? { ...entry, repliedByMessageId: sent.messageId } : entry),
        lastOutboundAt: sentAt,
        lastContactAt: sentAt,
        waitingFor: 'customer',
        nextAction: '等待客户回复；按来信内容继续处理',
        updatedAt: sentAt,
      }
    }), options.itemsPath, now, { refreshOnlyMutated: true, skipEligibilityRefresh: true })
    if (options.queuePath) await mutateFormalSendQueue(store => ({ ...store, records: store.records.map(record => record.id !== outboundKey ? record : {
      ...record, sendQueueStatus: 'sent', actualSentAt: sentAt, messageId: sent.messageId, updatedAt: sentAt,
      sentContentSnapshot: { version: 1, status: 'sent', customerId: options.customerId, draftId: outboundKey, recipientEmail: to, normalizedRecipientEmail: to, subject, body: rendered.text, bodySha256: createHash('sha256').update(rendered.text).digest('hex'), outboundKey, messageId: sent.messageId, provider: 'zoho_smtp', capturedAt: at, sentAt },
    }) }), { path: options.queuePath })
    return { messageId: sent.messageId, sentAt, recipientEmail: to, subject, provider: 'zoho_smtp' as const }
  } catch (error) {
    audit('reconcile')
    if (options.queuePath) await mutateFormalSendQueue(store => ({ ...store, records: store.records.map(record => record.id !== outboundKey || record.sendQueueStatus === 'sent' ? record : { ...record, sendQueueStatus: 'needs_manual_reconciliation', sendError: 'CRM_REPLY_SEND_UNCERTAIN', updatedAt: new Date().toISOString() }) }), { path: options.queuePath })
    const latest = readItemsAtomic(options.itemsPath).find(item => String(item?.id) === options.customerId)
    const attempt = (Array.isArray(latest?.crmReplySendAttempts) ? latest.crmReplySendAttempts : []).find((entry: any) => entry?.id === attemptId)
    if (attempt?.status === 'sending') {
      updateItemsAtomic(items => items.map(item => String(item?.id) !== options.customerId ? item : {
        ...item,
        crmReplySendAttempts: (Array.isArray(item.crmReplySendAttempts) ? item.crmReplySendAttempts : []).map((entry: any) => entry.id === attemptId
          ? { ...entry, status: 'needs_reconciliation', error: String((error as Error)?.message || error).slice(0, 240), updatedAt: new Date().toISOString() }
          : entry),
      }), options.itemsPath, new Date(), { refreshOnlyMutated: true, skipEligibilityRefresh: true })
    }
    throw error instanceof Error && error.message === 'CRM_REPLY_PROVIDER_MESSAGE_ID_MISSING'
      ? new Error('CRM_REPLY_SEND_UNCERTAIN')
      : new Error('CRM_REPLY_SEND_UNCERTAIN')
  }
}
