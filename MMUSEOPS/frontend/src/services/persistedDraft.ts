import { normalizeEmailSignature, currentUnsentDraft } from './emailSignature'
import type { ManualEmailDraft, PipelineItem } from '../types/item'

const normalizeRecipient = (value: unknown) => String(value || '').trim().toLowerCase()

export function hasPendingHumanReviewDraft(item: Pick<PipelineItem, 'manualEmailDrafts'>): boolean {
  return Boolean(getLatestPendingDraft(item))
}

export function getLatestPendingDraft(item: Pick<PipelineItem, 'manualEmailDrafts'>): ManualEmailDraft | undefined {
  return (item.manualEmailDrafts || [])
    .filter(draft => draft.status === 'pending_human_review' && draft.sent === false)
    .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || '') - Date.parse(a.updatedAt || a.createdAt || ''))
    .map(currentUnsentDraft)[0]
}

export function appendDraftVersion(
  item: Pick<PipelineItem, 'manualEmailDrafts' | 'selectedEmail'>,
  content: Pick<ManualEmailDraft, 'subject' | 'body' | 'to'>,
  previous: ManualEmailDraft | undefined,
  now: string,
  id: string = crypto.randomUUID(),
): ManualEmailDraft[] {
  const selectedEmail = normalizeRecipient(item.selectedEmail)
  const draftRecipient = normalizeRecipient(content.to)
  if (!selectedEmail) throw new Error('SELECTED_EMAIL_REQUIRED')
  if (!draftRecipient || draftRecipient !== selectedEmail) throw new Error('DRAFT_RECIPIENT_MISMATCH')
  const existing = item.manualEmailDrafts || []
  const version = Math.max(0, ...existing.map(draft => draft.version || 0)) + 1
  return [
    ...existing,
    {
      ...previous,
      id,
      to: selectedEmail,
      subject: content.subject,
      body: normalizeEmailSignature(content.body),
      version,
      status: 'pending_human_review',
      sent: false,
      createdAt: now,
      updatedAt: now,
    },
  ]
}
