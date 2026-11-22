import { deriveFormalOutreachStatus } from './formalOutreachLifecycle'

export function computeOutreachCounts(items: readonly any[]) {
  const counts = { pending: 0, sent: 0, replied: 0, bounced: 0, failed: 0 }
  for (const item of items) {
    if (item?.sendQueueStatus === 'send_failed' || item?.formalDeliveryStatus === 'send_failed') { counts.failed += 1; continue }
    const status = deriveFormalOutreachStatus(item)
    if (status === 'replied') counts.replied += 1
    else if (status === 'formal_bounced') counts.bounced += 1
    else if (status !== 'not_sent') counts.sent += 1
    else if (['pending_draft_review', 'scheduled_send_queue'].includes(String(item?.primaryStage)) && hasCurrentUnsentDraft(item)) counts.pending += 1
  }
  return counts
}

function hasCurrentUnsentDraft(item: any): boolean {
  return [...list(item?.manualEmailDrafts), ...list(item?.outreachDrafts)].some(draft =>
    draft?.sent !== true && ['pending_human_review', 'approved_for_sending', 'scheduled'].includes(String(draft?.status)))
}

const list = (value: unknown): any[] => Array.isArray(value) ? value : []
