export interface MailIsolationConfig {
  primaryBusinessEmail?: string
  isolatedTestEmail?: string
  smtpHost?: string
  smtpPort?: number
  smtpSecure?: boolean
  imapHost?: string
  imapPort?: number
  imapSecure?: boolean
  returnPathEmail?: string
  replyToEmail?: string
  forwardToEmail?: string
  allowIsolatedTestMail?: boolean
  allowSmtpHandshake?: boolean
  allowImapRecovery?: boolean
}

export interface MailIsolationStatus {
  configured: boolean
  missingFields: string[]
  warnings: string[]
  capabilities: {
    smtpHandshakeReady: boolean
    isolatedTestMailReady: boolean
    imapRecoveryReady: boolean
  }
}

const EMAIL_FIELDS = [
  'primaryBusinessEmail',
  'isolatedTestEmail',
  'returnPathEmail',
  'replyToEmail',
  'forwardToEmail',
] as const

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function positivePort(value: unknown): boolean {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port <= 65535
}

function email(value: unknown): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text(value))
}

/**
 * Produces a non-sensitive projection only. Email addresses, hosts and secrets
 * are never copied into the returned object.
 */
export function getMailIsolationStatus(input: Partial<MailIsolationConfig> | Record<string, unknown>): MailIsolationStatus {
  const missingFields: string[] = []
  for (const field of EMAIL_FIELDS) {
    if (!email(input[field])) missingFields.push(field)
  }
  if (!text(input.smtpHost)) missingFields.push('smtpHost')
  if (!positivePort(input.smtpPort)) missingFields.push('smtpPort')
  if (!text(input.imapHost)) missingFields.push('imapHost')
  if (!positivePort(input.imapPort)) missingFields.push('imapPort')

  const primary = text(input.primaryBusinessEmail).toLowerCase()
  const isolated = text(input.isolatedTestEmail).toLowerCase()
  const sameIdentity = Boolean(primary && isolated && primary === isolated)
  const warnings: string[] = []
  if (sameIdentity) warnings.push('主开发邮箱和隔离测试邮箱不能相同')
  if (input.allowSmtpHandshake !== true) warnings.push('SMTP握手未授权')
  if (input.allowIsolatedTestMail !== true) warnings.push('隔离测试信未授权')
  if (input.allowImapRecovery !== true) warnings.push('IMAP回收未授权')

  const smtpConfigured = email(input.primaryBusinessEmail)
    && email(input.isolatedTestEmail)
    && email(input.returnPathEmail)
    && !sameIdentity
    && text(input.smtpHost) !== ''
    && positivePort(input.smtpPort)
  const recoveryConfigured = smtpConfigured
    && text(input.imapHost) !== ''
    && positivePort(input.imapPort)
    && email(input.returnPathEmail)
    && email(input.replyToEmail)
    && email(input.forwardToEmail)

  return {
    configured: missingFields.length === 0 && !sameIdentity,
    missingFields: [...new Set(missingFields)],
    warnings,
    capabilities: {
      smtpHandshakeReady: smtpConfigured && input.allowSmtpHandshake === true,
      isolatedTestMailReady: smtpConfigured && input.allowIsolatedTestMail === true,
      imapRecoveryReady: recoveryConfigured && input.allowImapRecovery === true,
    },
  }
}


