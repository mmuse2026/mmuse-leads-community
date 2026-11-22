/**
 * 邮件追踪服务 — 记录所有发送/回复/打开状态
 * 存储在 IndexedDB 中，支持后台查询
 */
import { db } from '../store/db'
import type { PipelineItem, EmailLog } from '../types/item'

export interface EmailTracking {
  id: string
  itemId: string
  type: 'sent' | 'replied' | 'opened' | 'bounced' | 'followup'
  subject: string
  to: string
  from: string
  sentAt: string
  repliedAt?: string
  openedAt?: string
  followupCount: number  // 第几次跟进 (0=首次开发信)
  status: 'sent' | 'delivered' | 'replied' | 'bounced' | 'failed'
}

// ========= 发送记录 =========

/** 记录邮件发送 */
export async function trackEmailSent(
  itemId: string,
  subject: string,
  to: string,
  from: string,
  followupCount: number = 0,
): Promise<string> {
  const trackingId = crypto.randomUUID()
  const tracking: EmailTracking = {
    id: trackingId,
    itemId,
    type: followupCount > 0 ? 'followup' : 'sent',
    subject,
    to,
    from,
    sentAt: new Date().toISOString(),
    followupCount,
    status: 'sent',
  }

  // 保存到 items 的 emailLogs
  const item = await db.items.get(itemId)
  if (item) {
    const log: EmailLog = {
      id: trackingId,
      itemId,
      sentAt: tracking.sentAt,
      subject,
      body: '',
      status: 'sent',
    }
    await db.items.put({
      ...item,
      emailLogs: [...(item.emailLogs || []), log],
      developmentStatus: 'sent',
      currentStageId: followupCount > 0 ? 'otr-followup' : 'otr-first',
      updatedAt: new Date().toISOString(),
    })
  }

  return trackingId
}

/** 记录收到回复 */
export async function trackEmailReplied(
  itemId: string,
  replySubject: string,
  replyFrom: string,
  repliedAt: string,
): Promise<void> {
  const item = await db.items.get(itemId)
  if (!item) return

  // 更新最新的 emailLog 状态
  const logs = [...(item.emailLogs || [])]
  const lastLog = logs[logs.length - 1]
  if (lastLog && lastLog.status === 'sent') {
    lastLog.status = 'replied'
    lastLog.repliedAt = repliedAt
  }

  await db.items.put({
    ...item,
    emailLogs: logs,
    developmentStatus: 'replied',
    currentStageId: 'otr-replied',
    updatedAt: repliedAt,
  })
}

// ========= 回复监控 =========

/** 检查是否有未处理的回复 */
export async function getUnrepliedItems(): Promise<PipelineItem[]> {
  const all = await db.items.toArray()
  return all.filter(item => {
    if (item.status !== 'active') return false
    if (item.developmentStatus !== 'sent') return false
    const logs = item.emailLogs || []
    if (logs.length === 0) return false
    const lastLog = logs[logs.length - 1]
    return lastLog.status === 'sent' && !lastLog.repliedAt
  })
}

/** 获取需要跟进的客户（7天未回复） */
export async function getNeedFollowup(): Promise<{ item: PipelineItem; daysSinceLastEmail: number }[]> {
  const all = await db.items.toArray()
  const now = Date.now()
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000
  const MAX_FOLLOWUPS = 3 // 最多跟进3次

  const needFollowup: { item: PipelineItem; daysSinceLastEmail: number }[] = []

  for (const item of all) {
    if (item.status !== 'active') continue
    if (item.developmentStatus !== 'sent') continue
    if (!item.email || item.emailVerification === 'invalid') continue

    const logs = item.emailLogs || []
    if (logs.length === 0) continue

    const lastLog = logs[logs.length - 1]
    if (lastLog.status === 'replied') continue // 已回复，不需要跟进

    const lastSentTime = new Date(lastLog.sentAt).getTime()
    const daysSince = Math.floor((now - lastSentTime) / (24 * 60 * 60 * 1000))

    if (daysSince >= 7 && logs.length < MAX_FOLLOWUPS + 1) {
      needFollowup.push({ item, daysSinceLastEmail: daysSince })
    }
  }

  return needFollowup
}

// ========= 状态查询 =========

/** 获取邮件统计 */
export async function getEmailStats() {
  const all = await db.items.toArray()
  const withEmail = all.filter(i => i.email && i.status === 'active')
  const sent = withEmail.filter(i => i.developmentStatus === 'sent')
  const replied = withEmail.filter(i => i.developmentStatus === 'replied')
  const bounced = withEmail.filter(i => i.emailBounced)

  return {
    total: withEmail.length,
    sent: sent.length,
    replied: replied.length,
    bounced: bounced.length,
    replyRate: sent.length > 0 ? `${Math.round((replied.length / sent.length) * 100)}%` : '0%',
    needFollowup: (await getNeedFollowup()).length,
  }
}
