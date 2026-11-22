import { buildOutboundEmail } from '../src/services/emailSignature'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import nodemailer from 'nodemailer'
import { OFFICIAL_OUTREACH_EMAIL } from '../src/services/outreachIdentity'

export interface FormalEmailArgs {
  to: string
  subject: string
  content: string
  inReplyTo?: string
  references?: string[]
  outboundKey?: string
}

function loadFormalConfig() {
  const value = JSON.parse(readFileSync(join(__dirname, '..', 'user_config.json'), 'utf8'))
  if (!OFFICIAL_OUTREACH_EMAIL || String(value?.zohoEmail || '').trim().toLowerCase() !== OFFICIAL_OUTREACH_EMAIL.toLowerCase() || !value?.zohoPassword) {
    throw new Error('FORMAL_ACCOUNT_CONFIG_MISSING')
  }
  const host = String(value.smtpHost || 'smtp.zoho.com').trim()
  const port = Number(value.smtpPort || 587)
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('FORMAL_SMTP_CONFIG_INVALID')
  }
  return { host, port, secure: value.smtpSecure === true || port === 465, user: OFFICIAL_OUTREACH_EMAIL, pass: String(value.zohoPassword) }
}

function createFormalTransport() {
  const { host, port, secure, user, pass } = loadFormalConfig()
  return nodemailer.createTransport({
    host,
    port,
    secure,
    requireTLS: !secure,
    auth: { user, pass },
  })
}

export async function verifyFormalTransport(): Promise<boolean> {
  const transport = createFormalTransport()
  try {
    return await transport.verify()
  } finally {
    transport.close()
  }
}

export async function sendFormalEmail({ to, subject, content, inReplyTo, references, outboundKey }: FormalEmailArgs): Promise<{ messageId: string }> {
  const transport = createFormalTransport()
  try {
    const sent = await transport.sendMail({
      from: OFFICIAL_OUTREACH_EMAIL,
      replyTo: OFFICIAL_OUTREACH_EMAIL,
      to,
      subject,
      ...(inReplyTo ? { inReplyTo } : {}),
      ...(references?.length ? { references } : {}),
      ...(outboundKey ? {
        messageId: `<${outboundKey.replace(/[^a-z0-9.-]/gi, '.')}@${OFFICIAL_OUTREACH_EMAIL.split('@')[1]}>`,
        headers: { 'X-MMUSE-Outbound-Key': outboundKey },
      } : {}),
      ...buildOutboundEmail(content),
    })
    const messageId = String(sent?.messageId || '')
    if (!messageId) throw new Error('FORMAL_SEND_NO_MESSAGE_ID')
    return { messageId }
  } finally {
    transport.close()
  }
}

if (process.argv[1] && /formal-smtp-transport\.(ts|mts)$/i.test(process.argv[1])) {
  verifyFormalTransport()
    .then(ok => {
      console.log(`FORMAL_SMTP_TRANSPORT_VERIFY=${ok ? 'OK' : 'FAIL'}`)
      process.exitCode = ok ? 0 : 1
    })
    .catch(error => {
      console.error(`FORMAL_SMTP_TRANSPORT_VERIFY=FAIL ${String((error as Error)?.message || error)}`)
      process.exitCode = 1
    })
}
