import { createHash } from 'node:crypto'
import type { FormalSentContentSnapshot } from '../src/services/formalSendQueue'

export type FormalProviderSendInput = {
  to: string
  subject: string
  body: string
  customerId: string
  outboundKey?: string
}

export function buildFormalSentContentSnapshot(
  input: FormalProviderSendInput,
  meta: {
    draftId: string
    capturedAt: string
    status?: FormalSentContentSnapshot['status']
    messageId?: string
    sentAt?: string
  },
): FormalSentContentSnapshot {
  const body = String(input.body ?? '')
  const recipientEmail = String(input.to ?? '').trim()
  return {
    version: 1,
    status: meta.status || 'prepared',
    customerId: String(input.customerId || ''),
    draftId: String(meta.draftId || ''),
    recipientEmail,
    normalizedRecipientEmail: recipientEmail.toLowerCase(),
    subject: String(input.subject ?? ''),
    body,
    bodySha256: createHash('sha256').update(body, 'utf8').digest('hex'),
    ...(input.outboundKey ? { outboundKey: String(input.outboundKey) } : {}),
    ...(meta.messageId ? { messageId: String(meta.messageId) } : {}),
    provider: 'zoho_smtp',
    capturedAt: meta.capturedAt,
    ...(meta.sentAt ? { sentAt: meta.sentAt } : {}),
  }
}
