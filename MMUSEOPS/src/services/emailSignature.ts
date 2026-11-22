// The owner's local settings supply the sender and optional signature.
export const EMAIL_CONTACT = { name: '', company: '', email: '', gmail: '', mobile: '', website: '' }
export let OUTREACH_SENDER = ''
export let SIGNATURE_EN = ''
export let SIGNATURE_CN = ''

export function configureOutreachIdentity(profile: { zohoEmail?: unknown; companyName?: unknown }) {
  const account = String(profile.zohoEmail || '').trim().toLowerCase()
  const company = String(profile.companyName || '').replace(/[\r\n]+/g, ' ').trim()
  OUTREACH_SENDER = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(account) ? account : ''
  EMAIL_CONTACT.email = OUTREACH_SENDER
  EMAIL_CONTACT.company = company
  const contact = [company, OUTREACH_SENDER && `Email: ${OUTREACH_SENDER}`].filter(Boolean).join('\n')
  SIGNATURE_EN = contact ? `Best regards,\n${contact}` : ''
  SIGNATURE_CN = contact ? `此致\n${contact}` : ''
}

export function escapeEmailHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!))
}

export function normalizeEmailSignature(body: string, language: 'en' | 'cn' = 'en'): string {
  const raw = String(body || '').replace(/\\n/g, '\n').replace(/\r\n?/g, '\n')
  const quote = raw.search(/^(?:On .+wrote:|[-]{2,}\s*Original Message|>)/m)
  const current = (quote < 0 ? raw : raw.slice(0, quote)).trimEnd()
  const signature = language === 'cn' ? SIGNATURE_CN : SIGNATURE_EN
  const withSignature = !signature || current.endsWith(signature) ? current : [current, signature].filter(Boolean).join('\n\n')
  return quote < 0 ? withSignature : [withSignature, raw.slice(quote)].filter(Boolean).join('\n\n')
}

export function signatureHtml(language: 'en' | 'cn' = 'en'): string {
  return escapeEmailHtml(language === 'cn' ? SIGNATURE_CN : SIGNATURE_EN).replace(/\n/g, '<br>')
}

export function buildOutboundEmail(body: string, language: 'en' | 'cn' = 'en'): { text: string; html: string } {
  const text = normalizeEmailSignature(body, language)
  return { text, html: escapeEmailHtml(text).replace(/\n/g, '<br>') }
}

export function isSentDraft(draft: any): boolean {
  return draft?.sent === true || draft?.status === 'sent' || Boolean(draft?.sentAt || draft?.messageId)
}

export function currentUnsentDraft(draft: any): any {
  if (isSentDraft(draft) || typeof draft?.body !== 'string') return draft
  return { ...draft, body: normalizeEmailSignature(draft.body), ...(draft.bodyCn ? { bodyCn: normalizeEmailSignature(draft.bodyCn, 'cn') } : {}) }
}
