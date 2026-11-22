export type FormalOutreachStatus =
  | 'not_sent'
  | 'sent_observation'
  | 'formal_bounced'
  | 'replied'
  | 'followup_due'

const list = (value: unknown): any[] => Array.isArray(value) ? value : []
const text = (value: unknown) => String(value || '').trim().toLowerCase()

function formalSentLogs(item: any) {
  return list(item?.emailLogs).filter(log =>
    log?.status === 'sent' && /formal(?:_outreach)?/.test(text(log?.type)),
  )
}

export function hasFormalOutreachReply(item: any) {
  const sends = formalSentLogs(item)
  if (!sends.length) return false
  const messageIds = new Set(sends.map(log => text(log?.messageId)).filter(Boolean))
  return list(item?.emailLogs).some(log => {
    if (!['received', 'replied', 'reply_observed'].includes(text(log?.status))) return false
    const linked = [log?.inReplyTo, log?.formalMessageId, log?.parentMessageId]
      .map(text)
      .some(value => value && messageIds.has(value))
    return linked || /formal.*reply|reply.*formal/.test(text(log?.type))
  }) || list(item?.emailVerificationEvidence).some(evidence => {
    if (text(evidence?.result) !== 'reply_observed') return false
    // 排除测试信证据：method=isolated_test_mail 或 scope=test_handshake 的证据不应视为正式回复
    if (text(evidence?.method) === 'isolated_test_mail' || text(evidence?.scope) === 'test_handshake') return false
    const linkedId = text(evidence?.formalMessageId || evidence?.inReplyTo)
    return text(evidence?.scope) === 'formal_outreach'
      && Boolean(linkedId && messageIds.has(linkedId))
  })
}

export function deriveFormalOutreachStatus(item: any, now = new Date()): FormalOutreachStatus {
  if (item?.formalBounce === true || text(item?.formalDeliveryStatus) === 'formal_bounced') return 'formal_bounced'
  if (hasFormalOutreachReply(item)) return 'replied'
  if (!formalSentLogs(item).length && item?.developmentStatus !== 'sent') return 'not_sent'
  const due = Date.parse(item?.followupDueAt3d || '')
  return Number.isFinite(due) && due <= now.getTime() ? 'followup_due' : 'sent_observation'
}

const labels: Record<FormalOutreachStatus, string> = {
  not_sent: '未发送',
  sent_observation: '已发送观察中',
  formal_bounced: '正式退信，需换联系人',
  replied: '已回复待处理',
  followup_due: '已发送待跟进',
}

export function formalOutreachStatusLabel(status: FormalOutreachStatus) {
  return labels[status]
}
