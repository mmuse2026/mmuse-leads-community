export const SAFE_MODE = !['0', 'false', 'off'].includes(
  String(process.env.MMUSEOPS_SAFE_MODE || '').trim().toLowerCase(),
)

const EXTERNAL_SIDE_EFFECT_PATHS = new Set([
  '/api/search',
  '/api/send-email',
  '/api/verify-email-dns',
  '/api/batch-dns-check',
  '/api/batch-test-send',
  '/api/check-email-status',
  '/api/check-replies',
  '/api/firecrawl-extract',
  '/api/llm-backcheck',
  '/api/crawl4ai-backcheck',
  '/api/llm-classify',
  '/api/translate',
  '/api/scheduler/start',
  '/api/scheduler/resume',
  '/api/smtp-handshake',
  '/api/formal-send-queue/execute-due',
  '/api/formal-send-queue/send-one',
  '/api/formal-send-queue/send-crm-reply',
])

const EXTERNAL_SIDE_EFFECT_NAMESPACES = ['/api/snovio/'] as const

const LIVE_SEND_PATHS = new Set([
  '/api/send-email',
  '/api/batch-test-send',
  '/api/verify-email-dns',
])

function requestPath(url: string): string {
  return url.split('?')[0]
}

export function isExternalSideEffectPath(url: string): boolean {
  const path = requestPath(url)
  return EXTERNAL_SIDE_EFFECT_PATHS.has(path)
    || EXTERNAL_SIDE_EFFECT_NAMESPACES.some(prefix => path.startsWith(prefix))
}

function isLiveSendPath(url: string): boolean {
  return LIVE_SEND_PATHS.has(requestPath(url))
}

export interface SafetyGateResult {
  allowed: boolean
  safeMode: boolean
  httpStatus?: number
  code?:
    | 'SAFE_MODE_BLOCKED'
    | 'SEND_CONFIRMATION_REQUIRED'
    | 'SMTP_HANDSHAKE_DISABLED'
    | 'SMTP_HANDSHAKE_NOT_AUTHORIZED'
    | 'SMTP_CONFIG_INCOMPLETE'
    | 'SMTP_CONFIRMATION_REQUIRED'
}

export interface ExternalActionContext {
  allowTestMailSend?: boolean
  allowReadonlyDns?: boolean
  allowSmtpHandshake?: boolean
  smtpHandshakeConfigured?: boolean
}

export function checkExternalAction(
  url: string,
  body: Record<string, unknown>,
  safeMode = SAFE_MODE,
  allowLiveSend = process.env.ALLOW_LIVE_SEND === 'true',
  context: ExternalActionContext = {},
): SafetyGateResult {
  if (!isExternalSideEffectPath(url)) return { allowed: true, safeMode }

  // DNS-only permission is independent and defaults off; it never authorizes SMTP or mail.
  if (requestPath(url) === '/api/verify-email-dns' && (
    context.allowReadonlyDns === true
    || process.env.ALLOW_READONLY_DNS === 'true'
    || context.allowTestMailSend === true
    || process.env.ALLOW_TEST_MAIL_SEND === 'true'
  )) {
    return { allowed: true, safeMode }
  }

  if (requestPath(url) === '/api/smtp-handshake') {
    const mockMode = body.mockMode === true || body.testMode === true
    if (!mockMode) {
      return { allowed: false, safeMode, httpStatus: 423, code: 'SMTP_HANDSHAKE_DISABLED' }
    }
    if (context.allowSmtpHandshake !== true) {
      return { allowed: false, safeMode, httpStatus: 423, code: 'SMTP_HANDSHAKE_NOT_AUTHORIZED' }
    }
    if (context.smtpHandshakeConfigured !== true) {
      return { allowed: false, safeMode, httpStatus: 423, code: 'SMTP_CONFIG_INCOMPLETE' }
    }
    if (body.userConfirmation !== true) {
      return { allowed: false, safeMode, httpStatus: 423, code: 'SMTP_CONFIRMATION_REQUIRED' }
    }
    return { allowed: true, safeMode }
  }

  if (safeMode) {
    return { allowed: false, safeMode: true, code: 'SAFE_MODE_BLOCKED' }
  }

  if (
    isLiveSendPath(url)
    && (body.dryRun !== false || body.confirmSend !== true || allowLiveSend !== true)
  ) {
    return { allowed: false, safeMode: false, code: 'SEND_CONFIRMATION_REQUIRED' }
  }

  return { allowed: true, safeMode: false }
}


