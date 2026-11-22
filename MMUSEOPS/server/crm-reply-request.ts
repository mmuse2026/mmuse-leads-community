/** Email content is not an identifier. Validate it separately from queue record IDs. */
export function validateCrmReplyRequest(body: Record<string, unknown>, sending = false) {
  const allowed = new Set(sending ? ['customerId', 'replyMessageId', 'to', 'subject', 'body', 'confirmSend'] : ['customerId', 'replyMessageId'])
  for (const field of Object.keys(body)) if (!allowed.has(field)) return { ok: false as const, code: 'FORMAL_FIELD_UNEXPECTED', field }
  if (typeof body.customerId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(body.customerId)) return { ok: false as const, code: 'FORMAL_FIELD_INVALID', field: 'customerId' }
  if (typeof body.replyMessageId !== 'string' || body.replyMessageId.length > 998 || !/^(?:[A-Za-z0-9._:@+\-]+|<[^<>\s]+@[^<>\s]+>)$/.test(body.replyMessageId)) return { ok: false as const, code: 'FORMAL_FIELD_INVALID', field: 'replyMessageId' }
  if (sending) {
    if (typeof body.to !== 'string' || body.to.length > 320 || !/^[^\s<>]+@[^\s<>]+\.[^\s<>]+$/.test(body.to)) return { ok: false as const, code: 'CRM_REPLY_RECIPIENT_INVALID', field: 'to' }
    if (typeof body.subject !== 'string' || !body.subject.trim() || body.subject.length > 500 || /[\r\n\x00]/.test(body.subject)) return { ok: false as const, code: 'CRM_REPLY_SUBJECT_INVALID', field: 'subject' }
    if (typeof body.body !== 'string' || !body.body.trim() || body.body.length > 20000 || /\x00/.test(body.body)) return { ok: false as const, code: 'CRM_REPLY_BODY_INVALID', field: 'body' }
  }
  return { ok: true as const }
}
