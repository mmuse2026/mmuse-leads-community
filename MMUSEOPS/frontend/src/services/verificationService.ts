import { getTestMailInvalidReason } from './testMailCandidatePolicy'
import type { EmailVerification, EmailVerificationEvidence, PipelineItem } from '../types/item'

export type VerificationResultCode =
  | 'format_valid'
  | 'format_invalid'
  | 'domain_only'
  | 'dns_mx_ok'
  | 'dns_failed'
  | 'unknown'
  | 'disabled'

export interface VerificationStepResult extends EmailVerificationEvidence {
  status: EmailVerification
  ok: boolean
  disabled?: boolean
  message: string
}

function result(
  email: string,
  code: VerificationResultCode,
  scope: EmailVerificationEvidence['scope'],
  source: EmailVerificationEvidence['source'],
  method: string,
  status: EmailVerification,
  message: string,
  ok: boolean,
  disabled = false,
): VerificationStepResult {
  return { email, result: code, scope, source, method, status, message, ok, disabled, checkedAt: new Date().toISOString() }
}

export function checkEmailFormat(email: string): VerificationStepResult {
  const normalized = String(email || '').trim().toLowerCase()
  const valid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized) && !getTestMailInvalidReason(normalized)
  return valid
    ? result(normalized, 'format_valid', 'format', 'local', 'format_regex', 'unknown', '邮箱格式有效，尚未检查域名或具体邮箱', true)
    : result(normalized, 'format_invalid', 'format', 'local', 'format_regex', 'invalid', '邮箱格式无效', false)
}

export async function checkDnsMx(email: string, customerId?: string): Promise<VerificationStepResult> {
  const format = checkEmailFormat(email)
  if (!format.ok) return format
  try {
    const response = await fetch('/api/verify-email-dns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: format.email, customerId }),
    })
    const data = await response.json()
    if (data.result === 'domain_only') {
      return result(format.email, 'domain_only', 'domain', 'dns_mx', 'multi_source_dns', 'unknown', data.message || '仅域名MX正常，不代表具体邮箱有效', true)
    }
    if (data.result === 'dns_failed') {
      return result(format.email, 'dns_failed', 'domain', 'dns_mx', 'multi_source_dns', 'unknown', data.message || '多个DNS来源明确未发现MX', false)
    }
    return result(format.email, 'unknown', 'domain', 'dns_mx', 'multi_source_dns_unknown', 'unknown', data.message || 'DNS结果未知', false)
  } catch {
    return result(format.email, 'unknown', 'domain', 'dns_mx', 'multi_source_dns_error', 'unknown', 'DNS服务连接失败，结果未知', false)
  }
}

export function smtpHandshakeDisabled(email: string): VerificationStepResult {
  return result(email, 'disabled', 'specific_email', 'smtp', 'smtp_not_enabled', 'unknown', 'SMTP握手未启用，需要单独授权', false, true)
}

export function isolatedTestMailDisabled(email: string): VerificationStepResult {
  return result(email, 'disabled', 'delivery', 'isolated_test_mail', 'isolated_test_mail_not_enabled', 'unknown', '隔离测试信未启用，需要单独授权', false, true)
}

export function recoveryCheckDisabled(email: string): VerificationStepResult {
  return result(email, 'disabled', 'delivery', 'imap', 'recovery_not_enabled', 'unknown', '退信/回复回收未启用，需要单独授权', false, true)
}

/** 兼容入口：只做本地格式检查，不调用 DNS 或任何发送服务。 */
export async function verifyEmail(email: string): Promise<VerificationStepResult> {
  return checkEmailFormat(email)
}

export async function verifyDnsOnly(email: string): Promise<VerificationStepResult> {
  return checkDnsMx(email)
}

export async function batchVerifyDns(
  items: PipelineItem[],
  onItemDone?: (result: VerificationStepResult & { id: string; company: string }) => void,
): Promise<Map<string, VerificationStepResult>> {
  const results = new Map<string, VerificationStepResult>()
  for (const item of items) {
    const checked = await checkDnsMx(item.email || '', item.id)
    results.set(item.id, checked)
    onItemDone?.({ ...checked, id: item.id, company: item.company || '' })
  }
  return results
}

/** 兼容批量入口：只做本地格式检查，外部调用为零。 */
export async function batchVerify(
  items: PipelineItem[],
  onProgress?: (done: number, total: number, results: Map<string, VerificationStepResult>) => void,
): Promise<Map<string, VerificationStepResult>> {
  const results = new Map<string, VerificationStepResult>()
  items.forEach((item, index) => {
    results.set(item.id, checkEmailFormat(item.email || ''))
    onProgress?.(index + 1, items.length, new Map(results))
  })
  return results
}
