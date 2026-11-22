import { ImapFlow } from 'imapflow'
import { applyEligibilityStage } from '../src/services/leadStageEligibility'
import { normalizeEmailText } from '../src/services/emailText'

export type ZohoMessageClass = 'reply' | 'bounce' | 'auto_reply' | 'ignored'

export interface ZohoReplyMessage {
  uid: number
  from: string
  to: string[]
  subject: string
  date: string
  messageId: string
  inReplyTo?: string
  references: string[]
  textSummary: string
  autoSubmitted?: string
  bouncedEmail?: string
  bounceCode?: string
  bounceReason?: string
  bounceType?: 'hard_bounce' | 'temporary_failure'
}

export interface ZohoSyncConfig {
  host: string
  port: number
  secure: boolean
  user: string
  pass: string
}

export interface ZohoSyncState {
  lastZohoSyncAt?: string
  processedMessageIds: string[]
}

const BOUNCE_RE = /(undeliver|delivery status notification|mail delivery subsystem|returned mail|recipient rejected|mailbox unavailable|failure notice)/i
const AUTO_REPLY_RE = /(automatic reply|auto reply|out of office|away from (the )?office|vacation reply)/i
const IGNORED_RE = /(security notification|newsletter|password reset|login detected|verification code|one[- ]time password)/i

function cleanAddress(value: unknown): string {
  if (!value) return ''
  if (typeof value === 'string') {
    const match = value.match(/<([^>]+)>/)
    return (match?.[1] || value).trim().toLowerCase()
  }
  return ''
}

function messageIdKey(value: unknown): string {
  return String(value || '').trim().replace(/^<|>$/g, '').toLowerCase()
}

function domainOf(value: string): string {
  const email = cleanAddress(value)
  return email.includes('@') ? email.split('@').pop() || '' : ''
}

function websiteDomain(value: unknown): string {
  try {
    const raw = String(value || '').trim()
    if (!raw) return ''
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return ''
  }
}

export function parseManualZohoMessage(raw: string, now = new Date().toISOString()): ZohoReplyMessage {
  const value = String(raw || '').replace(/\u0000/g, '')
  const header = (name: string) => {
    const match = value.match(new RegExp(`^${name}:\\s*(.+(?:\\r?\\n[ \\t].+)*)`, 'im'))
    return (match?.[1] || '').replace(/\r?\n[ \t]+/g, ' ').trim()
  }
  const recipientMatch = value.match(/(?:Final|Original)-Recipient:\s*(?:rfc822;\s*)?([^\s<>;,]+@[^\s<>;,]+)/i)
    || value.match(/(?:recipient|address|mailbox)[^\r\n]{0,80}?([^\s<>;,]+@[^\s<>;,]+)/i)
  const bouncedEmail = cleanAddress(recipientMatch?.[1])
  const codeMatch = value.match(/\b([45]\d\d(?:[ \t]+[245]\.\d\.\d{1,3})?)\b/)
  const bounceCode = (codeMatch?.[1] || '').replace(/\s+/g, ' ').trim()
  const diagnostic = value.match(/^Diagnostic-Code:\s*(.+)$/im)?.[1]?.trim()
    || value.match(/^(?:Status|Action|Reason):\s*(.+)$/im)?.[1]?.trim()
    || ''
  const hard = /^5/.test(bounceCode) || /user unknown|mailbox unavailable|no such user|account.*(?:not found|does not exist)|recipient.*(?:not found|rejected)/i.test(value)
  const temporary = /^4/.test(bounceCode)
  const from = header('From')
  const subject = normalizeEmailText(header('Subject')) || 'Manual Zoho recovery'
  const messageId = header('Message-ID') || `manual-zoho:${Date.parse(now) || Date.now()}`
  const inReplyTo = header('In-Reply-To') || undefined
  const references = header('References').split(/\s+/).filter(Boolean)
  return {
    uid: Date.parse(now) || Date.now(),
    from,
    to: header('To').split(',').map(cleanAddress).filter(Boolean),
    subject,
    date: now,
    messageId,
    inReplyTo,
    references,
    textSummary: normalizeEmailText(value.slice(0, 4000)),
    bouncedEmail,
    bounceCode,
    bounceReason: diagnostic || value.replace(/\s+/g, ' ').slice(0, 500),
    bounceType: hard ? 'hard_bounce' : temporary ? 'temporary_failure' : undefined,
  }
}

export function normalizeReplySubject(subject: string): string {
  let result = normalizeEmailText(subject).trim()
  while (/^(re|fw|fwd)\s*:/i.test(result)) result = result.replace(/^(re|fw|fwd)\s*:\s*/i, '')
  return result.trim().toLowerCase()
}

export function classifyZohoMessage(message: ZohoReplyMessage): ZohoMessageClass {
  const text = `${message.from} ${message.subject} ${message.textSummary}`
  // A delivery delay is a temporary notification, not a final failed delivery.
  if (/mail delivery status notification\s*\(delay\)/i.test(message.subject)
    || (/\bAction:\s*delayed\b/i.test(message.textSummary) && message.bounceType !== 'hard_bounce')) return 'ignored'
  if (BOUNCE_RE.test(text) || /mailer-daemon|postmaster/i.test(message.from)) return 'bounce'
  if (String(message.autoSubmitted || '').toLowerCase().includes('auto-replied') || AUTO_REPLY_RE.test(text)) return 'auto_reply'
  if (IGNORED_RE.test(text) || /no-?reply|notifications?@/i.test(message.from)) return 'ignored'
  return 'reply'
}

function sentLogs(item: any): any[] {
  const logs = Array.isArray(item?.emailLogs) ? item.emailLogs : []
  return logs.filter((log: any) => log?.status === 'sent' && /formal(?:_outreach)?/.test(String(log?.type || '').toLowerCase()))
}

function contactEmails(item: any): string[] {
  const values = [
    item?.email,
    item?.selectedEmail,
    ...(Array.isArray(item?.emails) ? item.emails : []),
    ...(Array.isArray(item?.contacts) ? item.contacts.map((contact: any) => contact?.email) : []),
  ]
  return values.map(cleanAddress).filter(Boolean)
}

function matchItem(items: any[], message: ZohoReplyMessage): any | undefined {
  const replyIds = [message.inReplyTo, ...message.references].map(messageIdKey).filter(Boolean)
  const sender = cleanAddress(message.from)
  const bouncedEmail = cleanAddress(message.bouncedEmail)
  const senderDomain = domainOf(sender)
  const subject = normalizeReplySubject(message.subject)

  return items.find(item => sentLogs(item).some(log => replyIds.includes(messageIdKey(log?.messageId))))
    || items.find(item => sentLogs(item).length > 0 && bouncedEmail && contactEmails(item).includes(bouncedEmail))
    || items.find(item => sentLogs(item).length > 0 && contactEmails(item).includes(sender))
    || items.find(item => sentLogs(item).length > 0 && senderDomain && websiteDomain(item?.website) === senderDomain)
    || items.find(item => sentLogs(item).some(log => normalizeReplySubject(log?.subject || '') === subject))
}

/**
 * 客户主邮箱和发件记录中的收件人不一致时，按发件记录做回退匹配。
 * 按 queue record 的 messageId（References/In-Reply-To）或 recipientEmail（退信目标/发件人）命中
 * → 再经 record.customerId 定位 item。避免退信/回复被误判 unmatched 而漏回收。
 */
function matchItemByQueue(items: any[], queueRecords: any[] | undefined, message: ZohoReplyMessage): any | undefined {
  if (!Array.isArray(queueRecords) || queueRecords.length === 0) return undefined
  const replyIds = [message.inReplyTo, ...message.references].map(messageIdKey).filter(Boolean)
  const sender = cleanAddress(message.from)
  const bouncedEmail = cleanAddress(message.bouncedEmail)
  const record = queueRecords.find((r: any) => {
    if (!r) return false
    if (replyIds.length && replyIds.includes(messageIdKey(r?.messageId))) return true
    const recipient = cleanAddress(r?.recipientEmail)
    if (bouncedEmail && recipient && recipient === bouncedEmail) return true
    if (sender && recipient && recipient === sender) return true
    return false
  })
  if (!record) return undefined
  return items.find(item => item && String(item?.id) === String(record?.customerId))
}

const CRM_STAGES_AFTER_REPLY = new Set(['requirements_discovery','quotation_preparation','quoted','negotiation','sample','decision_pending','won','nurture','lost'])

function projectReplyIntoCrm(item: any, message: ZohoReplyMessage, now: string): void {
  const occurredAt = message.date || now
  const sourceKey = messageIdKey(message.messageId) || String(message.uid)
  const taskId = 'reply:' + sourceKey.replace(/[^a-z0-9._:@-]+/gi, '-').slice(0, 110)
  const tasks = Array.isArray(item.crmTasks) ? item.crmTasks : []
  if (!tasks.some((task: any) => task?.id === taskId || task?.source === 'zoho_reply:' + sourceKey)) {
    item.crmTasks = [...tasks, { id: taskId, type: 'reply_customer', content: '回复客户：' + String(message.subject || '客户来信').slice(0, 240), dueAt: now, priority: 'high', status: 'pending', source: 'zoho_reply:' + sourceKey, createdBy: 'system:zoho-reply', createdAt: now }]
  }
  const currentStage = String(item.salesStage || '')
  if (!CRM_STAGES_AFTER_REPLY.has(currentStage) && currentStage !== 'replied') {
    item.salesStageHistory = [...(Array.isArray(item.salesStageHistory) ? item.salesStageHistory : []), { id: 'stage-reply-' + sourceKey, from: currentStage || undefined, to: 'replied', reason: '检测到客户真实回信', changedAt: now, actor: 'system:zoho-reply' }]
    item.salesStage = 'replied'
  }
  item.lastInboundAt = occurredAt
  item.lastContactAt = occurredAt
  item.nextAction = '回复客户：' + String(message.subject || '客户来信').slice(0, 240)
  item.nextFollowupAt = now
  item.waitingFor = 'us'
  item.crmUpdatedAt = now
}

export function applyZohoMessages(
  inputItems: any[],
  messages: ZohoReplyMessage[],
  options: { processedMessageIds?: string[]; now?: string; formalQueueRecords?: any[]; source?: 'zoho_imap_readonly' | 'zoho_inbox_manual' } = {},
) {
  const items = inputItems
  const processed = new Set((options.processedMessageIds || []).map(messageIdKey))
  const unmatched: ZohoReplyMessage[] = []
  const now = options.now || new Date().toISOString()
  const formalQueueRecords = options.formalQueueRecords
  const source = options.source || 'zoho_imap_readonly'
  const stats = { scanned: 0, replied: 0, bounced: 0, autoReplies: 0, ignored: 0, unmatched: 0, duplicates: 0 }

  for (const incomingMessage of messages) {
    const message = {
      ...incomingMessage,
      subject: normalizeEmailText(incomingMessage.subject),
      textSummary: normalizeEmailText(incomingMessage.textSummary),
    }
    const key = messageIdKey(message.messageId) || `uid:${message.uid}`
    if (processed.has(key)) {
      stats.duplicates++
      continue
    }
    processed.add(key)
    stats.scanned++
    const classification = classifyZohoMessage(message)
    if (classification === 'ignored') {
      stats.ignored++
      continue
    }
    let item = matchItem(items, message)
    if (!item) item = matchItemByQueue(items, formalQueueRecords, message)
    if (!item) {
      stats.unmatched++
      unmatched.push(message)
      continue
    }

    const entry = {
      messageId: message.messageId,
      inReplyTo: message.inReplyTo,
      references: message.references,
      fromEmail: cleanAddress(message.from),
      fromMasked: maskEmail(message.from),
      subject: message.subject.slice(0, 300),
      date: message.date,
      textSummary: message.textSummary.slice(0, 500),
      classification,
      syncedAt: now,
    }
    item.zohoReplyEvidence = [...(Array.isArray(item.zohoReplyEvidence) ? item.zohoReplyEvidence : []), entry]

    if (classification === 'reply') {
      projectReplyIntoCrm(item, message, now)
      item.replyQueue = 'replied_queue'
      item.replyObservedAt = message.date || now
      item.developmentStatus = 'replied'
      item.formalDeliveryStatus = 'replied'
      item.followupDueAt3d = undefined
      item.followupDueAt7d = undefined
      item.emailLogs = [...(Array.isArray(item.emailLogs) ? item.emailLogs : []), { type: 'formal_outreach_reply', status: 'received', messageId: message.messageId, inReplyTo: message.inReplyTo, references: message.references, receivedAt: message.date || now, source }]
      if (Array.isArray(item.followupTasks)) {
        item.followupTasks = item.followupTasks.map((task: any) =>
          ['pending', 'scheduled'].includes(task?.status) ? { ...task, status: 'cancelled_reply_received', cancelledAt: now } : task)
      }
      if (Array.isArray(item.manualEmailDrafts)) {
        item.manualEmailDrafts = item.manualEmailDrafts.map((draft: any) => {
          const isFollowup = draft?.followup === true || draft?.type === 'followup' || draft?.campaignKey === 'followup-auto-consumer'
          return isFollowup && draft?.sent !== true && ['approved', 'pending_human_review'].includes(draft?.status)
            ? { ...draft, status: 'superseded', cancelledAt: now, cancelReason: 'reply_received' }
            : draft
        })
      }
      stats.replied++
    } else if (classification === 'bounce') {
      const parsed = message.bouncedEmail ? message : parseManualZohoMessage(message.textSummary, now)
      const bouncedEmail = cleanAddress(parsed.bouncedEmail)
      item.replyQueue = 'bounced_queue'
      item.formalBounce = true
      item.formalDeliveryStatus = 'formal_bounced'
      item.bounceType = parsed.bounceType || 'hard_bounce'
      item.bounceCode = parsed.bounceCode || ''
      item.bounceSource = source
      item.bouncedAt = now
      item.bouncedEmail = bouncedEmail
      item.bounceReason = parsed.bounceReason || message.textSummary.slice(0, 500)
      item.currentEmailUseBlocked = true
      item.emailReachability = 'unreachable'
      item.followupDueAt3d = undefined
      item.followupDueAt7d = undefined
      item.emailVerificationRouting = [...(Array.isArray(item.emailVerificationRouting) ? item.emailVerificationRouting : []), {
        email: bouncedEmail,
        queue: 'unreachable',
        reason: 'formal_bounce_observed',
        updatedAt: now,
      }]
      item.emailVerificationEvidence = [...(Array.isArray(item.emailVerificationEvidence) ? item.emailVerificationEvidence : []), {
        email: bouncedEmail,
        scope: 'formal_outreach',
        result: 'formal_bounced',
        source,
        method: source === 'zoho_inbox_manual' ? 'manual_paste' : 'imap',
        checkedAt: now,
        formalMessageId: message.inReplyTo || message.references?.[0],
        bounceType: item.bounceType,
        bounceCode: item.bounceCode,
      }]
      item.emailLogs = [...(Array.isArray(item.emailLogs) ? item.emailLogs : []), {
        type: 'formal_outreach_bounce',
        status: 'bounced',
        messageId: message.messageId,
        inReplyTo: message.inReplyTo,
        bouncedEmail,
        bounceType: item.bounceType,
        bounceCode: item.bounceCode,
        bounceReason: item.bounceReason,
        bouncedAt: now,
        source,
      }]
      if (Array.isArray(item.followupTasks)) {
        item.followupTasks = item.followupTasks.map((task: any) =>
          ['pending', 'scheduled'].includes(task?.status) ? { ...task, status: 'cancelled_formal_bounce', cancelledAt: now } : task)
      }
      item.contactMiningRequired = true
      stats.bounced++
    } else {
      item.replyQueue = 'auto_reply_queue'
      stats.autoReplies++
    }
    if (Array.isArray(formalQueueRecords) && (classification === 'reply' || classification === 'bounce')) {
      const bouncedEmail = cleanAddress(message.bouncedEmail || parseManualZohoMessage(message.textSummary, now).bouncedEmail)
      for (const record of formalQueueRecords) {
        if (record?.customerId !== item.id && (!bouncedEmail || cleanAddress(record?.recipientEmail) !== bouncedEmail)) continue
        if (classification === 'reply') {
          record.deliveryStatus = 'replied'
          record.followupDueAt3d = undefined
          record.followupDueAt7d = undefined
          const isFollowup = String(record?.draftId || '').startsWith('auto-followup-') || String(record?.id || '').startsWith('queue-followup-') || record?.followup === true
          if (isFollowup && ['approved_for_sending', 'scheduled', 'send_failed', 'pending_human_review'].includes(record?.sendQueueStatus)) {
            record.sendQueueStatus = 'skipped'
            record.skipReason = 'reply_received'
          }
        } else {
          record.deliveryStatus = 'formal_bounced'
          record.formalBounce = true
          record.bounceType = message.bounceType || 'hard_bounce'
          record.bounceCode = message.bounceCode || ''
          record.bounceSource = source
          record.bouncedAt = now
          record.bouncedEmail = bouncedEmail
          record.followupDueAt3d = undefined
          record.followupDueAt7d = undefined
        }
        record.updatedAt = now
      }
    }
    const index = items.indexOf(item)
    if (index >= 0) items[index] = applyEligibilityStage(item, new Date(now)).item
  }

  return { items, formalQueueRecords, unmatched, processedMessageIds: Array.from(processed).slice(-5000), stats }
}

export function maskEmail(value: string): string {
  const email = cleanAddress(value)
  const [local, domain] = email.split('@')
  if (!local || !domain) return ''
  return `${local.slice(0, 1)}***@${domain}`
}

function headerValue(headers: Buffer | string | undefined, name: string): string {
  const text = Buffer.isBuffer(headers) ? headers.toString('utf8') : String(headers || '')
  const match = text.match(new RegExp(`^${name}:\\s*(.+(?:\\r?\\n[ \\t].+)*)`, 'im'))
  return (match?.[1] || '').replace(/\r?\n[ \t]+/g, ' ').trim()
}

function textPartId(node: any): string | undefined {
  if (!node) return undefined
  const type = String(node.type || '').toLowerCase()
  const disposition = String(node.disposition || '').toLowerCase()
  if (type === 'text/plain' && disposition !== 'attachment') return node.part
  for (const child of node.childNodes || []) {
    const found = textPartId(child)
    if (found) return found
  }
  return undefined
}

async function streamToText(stream: NodeJS.ReadableStream, maxBytes = 65536): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stream as any) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (size + buffer.length > maxBytes) {
      chunks.push(buffer.subarray(0, Math.max(0, maxBytes - size)))
      break
    }
    chunks.push(buffer)
    size += buffer.length
  }
  return Buffer.concat(chunks).toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 500)
}

export async function fetchZohoMessagesReadOnly(
  config: ZohoSyncConfig,
  options: { since: Date; limit: number },
): Promise<ZohoReplyMessage[]> {
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
    logger: false,
  })
  // ImapFlow emits async 'error' events (auth failure / server logout) that
  // would otherwise crash the whole Node process as uncaught exceptions.
  client.on('error', () => undefined)
  const result: ZohoReplyMessage[] = []
  try {
    await client.connect()
    const lock = await client.getMailboxLock('INBOX', { readOnly: true })
    try {
      const uids = await client.search({ since: options.since }, { uid: true })
      const selected = uids.slice(-Math.min(50, Math.max(1, options.limit))).reverse()
      for (const uid of selected) {
        for await (const msg of client.fetch(String(uid), {
          uid: true,
          envelope: true,
          headers: ['message-id', 'in-reply-to', 'references', 'auto-submitted'],
          bodyStructure: true,
        }, { uid: true })) {
          const part = textPartId(msg.bodyStructure)
          let textSummary = ''
          if (part) {
            const downloaded = await client.download(uid, part, { uid: true, maxBytes: 65536 })
            textSummary = await streamToText(downloaded.content)
          }
          const from = msg.envelope?.from?.[0]
          const fromEmail = from?.address || ''
          result.push({
            uid: msg.uid,
            from: fromEmail,
            to: (msg.envelope?.to || []).map(address => address.address || '').filter(Boolean),
            subject: normalizeEmailText(msg.envelope?.subject || ''),
            date: (msg.envelope?.date || new Date()).toISOString(),
            messageId: headerValue(msg.headers, 'message-id') || msg.envelope?.messageId || `uid:${msg.uid}`,
            inReplyTo: headerValue(msg.headers, 'in-reply-to') || undefined,
            references: headerValue(msg.headers, 'references').split(/\s+/).filter(Boolean),
            textSummary: normalizeEmailText(textSummary),
            autoSubmitted: headerValue(msg.headers, 'auto-submitted') || undefined,
          })
        }
      }
    } finally {
      lock.release()
    }
  } finally {
    await client.logout().catch(() => undefined)
  }
  return result
}
