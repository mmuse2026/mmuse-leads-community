import { OFFICIAL_OUTREACH_EMAIL } from './outreachIdentity'
import { SIGNATURE_EN } from './emailSignature'
export interface ManualReplyTrackingInput {
  sentAt: string
  recipientEmail: string
  customerId: string
  subject: string
}

export interface ManualFollowupTask {
  sequence: 1 | 2
  dueAt: string
  status: 'pending' | 'completed' | 'cancelled'
}

export function buildManualReplyTracking(input: ManualReplyTrackingInput) {
  const sentAt = new Date(input.sentAt)
  if (!Number.isFinite(sentAt.getTime())) throw new Error('Invalid sentAt')
  const dueAt = (days: number) => new Date(sentAt.getTime() + days * 86_400_000).toISOString()
  const followupDueAt = [dueAt(3), dueAt(7)]
  return {
    sentAt: sentAt.toISOString(),
    recipientEmail: input.recipientEmail,
    customerId: input.customerId,
    subject: input.subject,
    replyCheckMode: 'manual_zoho_login' as const,
    followupDueAt,
    followupTasks: [
      { sequence: 1 as const, dueAt: followupDueAt[0], status: 'pending' as const },
      { sequence: 2 as const, dueAt: followupDueAt[1], status: 'pending' as const },
    ],
  }
}

export function summarizeManualReplyWork(items: any[], now = new Date()) {
  let manualReplyCheckCustomers = 0
  let followupsDueToday = 0
  for (const item of items) {
    const logs = Array.isArray(item?.emailLogs) ? item.emailLogs : []
    const latest = [...logs].reverse().find((log: any) => ['sent', 'replied', 'bounced'].includes(log?.status))
    if (!latest || ['replied', 'bounced'].includes(latest.status)) continue
    manualReplyCheckCustomers++
    const tasks = Array.isArray(latest.followupTasks) ? latest.followupTasks : []
    const hasDueTask = tasks.some((task: any) => task?.status === 'pending' && new Date(task.dueAt).getTime() <= now.getTime())
    const legacyDue = tasks.length === 0 && Number.isFinite(new Date(latest.sentAt).getTime())
      && now.getTime() >= new Date(latest.sentAt).getTime() + 3 * 86_400_000
    if (hasDueTask || legacyDue) followupsDueToday++
  }
  return { manualReplyCheckCustomers, followupsDueToday }
}
export type ManualReplyResult = 'replied' | 'no_reply' | 'bounced' | 'auto_reply' | 'ignored' | 'continue_followup' | 'paused' | 'do_not_develop'

export function markManualReplyResult(item: any, result: ManualReplyResult, note = '', now = new Date()): any {
  const emailLogs = Array.isArray(item?.emailLogs) ? item.emailLogs.map((log: any) => ({ ...log })) : []
  const latestIndex = [...emailLogs].map((log: any, index: number) => ({ log, index })).reverse().find(entry => entry.log?.status === 'sent')?.index
  const cancelFollowups = result === 'replied' || result === 'bounced' || result === 'paused' || result === 'do_not_develop'
  if (latestIndex !== undefined) {
    const latest = emailLogs[latestIndex]
    emailLogs[latestIndex] = {
      ...latest,
      status: result === 'replied' ? 'replied' : result === 'bounced' ? 'bounced' : latest.status,
      repliedAt: result === 'replied' ? now.toISOString() : latest.repliedAt,
      bounceReason: result === 'bounced' ? (note || '人工标记退信') : latest.bounceReason,
      followupTasks: Array.isArray(latest.followupTasks) && cancelFollowups
        ? latest.followupTasks.map((task: any) => task.status === 'pending' ? { ...task, status: 'cancelled' } : task)
        : latest.followupTasks,
    }
  }
  const patch: any = {
    ...item,
    emailLogs,
    replyStatus: result,
    replyStatusNote: note,
    replyStatusUpdatedAt: now.toISOString(),
    replyCheckMode: 'manual_zoho_login',
    updatedAt: now.toISOString(),
  }
  if (result === 'replied') Object.assign(patch, { replyQueue: 'replied_queue', primaryStage: 'replied_queue', normalizedStage: 'replied_queue', currentAllowedStage: 'replied_queue', developmentStatus: 'replied', replyObservedAt: now.toISOString() })
  if (result === 'bounced') Object.assign(patch, { replyQueue: 'bounced_queue', primaryStage: 'replace_contact_queue', normalizedStage: 'replace_contact_queue', currentAllowedStage: 'replace_contact_queue', emailBounced: true })
  if (result === 'auto_reply') Object.assign(patch, { replyQueue: 'auto_reply_queue' })
  if (result === 'paused') Object.assign(patch, { reviewDisposition: 'paused', primaryStage: 'true_excluded', normalizedStage: 'true_excluded', currentAllowedStage: 'true_excluded', activeWorkflow: false })
  if (result === 'do_not_develop') Object.assign(patch, { reviewDisposition: 'do_not_develop', doNotDevelop: true, excludedAt: now.toISOString(), primaryStage: 'true_excluded', normalizedStage: 'true_excluded', currentAllowedStage: 'true_excluded', activeWorkflow: false })
  return patch
}

export function buildReplyDraft(item: any, customerReplyText: string, originalSubject: string, now = new Date()) {
  const company = item?.company || item?.title || 'your team'
  const subject = /^re:/i.test(originalSubject.trim()) ? originalSubject.trim() : `Re: ${originalSubject.trim()}`
  const context = customerReplyText.trim() ? `\n\nYour message noted:\n${customerReplyText.trim().slice(0, 600)}` : ''
  return {
    id: `reply-${item?.id || 'customer'}-${now.getTime()}`,
    companyName: company,
    to: item?.email || '',
    subject,
    body: `Hello,\n\nThank you for your reply. We appreciate the context and would be glad to continue the conversation. Please let us know which product details, dimensions or project requirements would be most useful for your review.${context}\n\n${SIGNATURE_EN}`,
    senderEmail: OFFICIAL_OUTREACH_EMAIL,
    status: 'pending_human_review' as const,
    sent: false,
    rationale: '人工录入真实回复后生成，发送前必须人工确认',
    manualChecks: ['核对客户原回复内容', '核对产品与项目上下文', '确认收件人和发送时机'],
    version: 1,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }
}
