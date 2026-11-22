import { updateItemsAtomic } from './items-store-atomic'
import { OFFICIAL_OUTREACH_EMAIL } from '../src/services/outreachIdentity'
import { normalizeEmailSignature } from '../src/services/emailSignature'

export function validateOutboundDraft(draft: { to?: unknown; subject?: unknown; body?: unknown }, recipient: string) {
  if (typeof draft.to !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(draft.to.trim()) || draft.to.trim().toLowerCase() !== recipient.trim().toLowerCase()) throw new Error('DRAFT_RECIPIENT_MISMATCH')
  if (typeof draft.subject !== 'string' || !draft.subject.trim()) throw new Error('DRAFT_SUBJECT_INVALID')
  if (typeof draft.body !== 'string' || !draft.body.trim()) throw new Error('DRAFT_BODY_INVALID')
  normalizeEmailSignature(draft.body)
}

export interface CreateReviewDraftInput {
  customerId: string
  draftId: string
  to: string
  subject: string
  body: string
}

export function validateCreateReviewDraft(body: unknown): CreateReviewDraftInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('DRAFT_CREATE_BODY_INVALID')
  const source = body as Record<string, unknown>
  const allowed = ['customerId', 'draftId', 'to', 'subject', 'body']
  if (Object.keys(source).some(key => !allowed.includes(key))) throw new Error('DRAFT_CREATE_FIELD_UNEXPECTED')
  const idSafe = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/
  if (typeof source.customerId !== 'string' || !idSafe.test(source.customerId)) throw new Error('DRAFT_CUSTOMER_ID_INVALID')
  if (typeof source.draftId !== 'string' || !idSafe.test(source.draftId)) throw new Error('DRAFT_ID_INVALID')
  if (typeof source.to !== 'string' || source.to.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(source.to.trim())) throw new Error('DRAFT_RECIPIENT_INVALID')
  if (typeof source.subject !== 'string' || !source.subject.trim() || source.subject.trim().length > 500) throw new Error('DRAFT_SUBJECT_INVALID')
  if (typeof source.body !== 'string' || !source.body.trim() || source.body.trim().length > 20000) throw new Error('DRAFT_BODY_INVALID')
  return { customerId: source.customerId, draftId: source.draftId, to: source.to.trim().toLowerCase(), subject: source.subject.trim(), body: source.body.trim() }
}

export function createReviewDraft(input: CreateReviewDraftInput, actor: string, itemsPath: string, now = new Date()) {
  validateOutboundDraft(input, input.to)
  let reused = false
  let found = false
  const at = now.toISOString()
  updateItemsAtomic(items => {
    const target = items.find(item => item.id === input.customerId)
    if (!target) throw new Error('CUSTOMER_NOT_FOUND')
    found = true
    if (String(target.selectedEmail || '').trim().toLowerCase() !== input.to) throw new Error('DRAFT_RECIPIENT_MISMATCH')
    const draftsOf = (item: any): any[] => [...(Array.isArray(item.manualEmailDrafts) ? item.manualEmailDrafts : []), ...(Array.isArray(item.outreachDrafts) ? item.outreachDrafts : [])]
    const collisions = items.flatMap(item => draftsOf(item).filter(draft => draft.id === input.draftId || draft.campaignKey === input.draftId).map(draft => ({ item, draft })))
    if (collisions.length) {
      const existing = collisions[0]
      const draft = existing.draft
      if (collisions.length !== 1 || existing.item.id !== input.customerId || draft.id !== input.draftId || draft.status !== 'pending_human_review' || draft.sent === true || draft.sentAt || draft.messageId) throw new Error('DRAFT_ID_CONFLICT')
      if (draft.to !== input.to || draft.subject !== input.subject || draft.body !== input.body) throw new Error('DRAFT_CONTENT_CONFLICT')
      reused = true
      return items
    }
    if (draftsOf(target).some(draft => draft.sent !== true && draft.status !== 'superseded' && draft.status !== 'sent')) throw new Error('DRAFT_ALREADY_PENDING')
    const draft = {
      id: input.draftId, to: input.to, subject: input.subject, body: input.body,
      companyName: String(target.company || target.title || ''), senderEmail: OFFICIAL_OUTREACH_EMAIL,
      replyToEmail: OFFICIAL_OUTREACH_EMAIL, status: 'pending_human_review', sent: false,
      createdAt: at, updatedAt: at, createdBy: actor, version: 1,
    }
    return items.map(item => item.id !== input.customerId ? item : { ...item, manualEmailDrafts: [...(Array.isArray(item.manualEmailDrafts) ? item.manualEmailDrafts : []), draft] })
  }, itemsPath, now, { refreshOnlyMutated: true, preserveUnmutated: true })
  if (!found) throw new Error('CUSTOMER_NOT_FOUND')
  return { customerId: input.customerId, draftId: input.draftId, status: 'pending_human_review', reused }
}
