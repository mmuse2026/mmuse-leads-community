import { createHash, randomBytes } from 'node:crypto'

type AuthInput = { origin: string; remoteAddress: string; operatorToken: string; csrfToken: string }
type AuthResult = { ok: true; approvedBy: string } | { ok: false; code: string }
export type FormalSendGrantBinding = { queueRevision: number; targetCount: number; taskDigest: string }

const trustedOrigins = new Set([`http://127.0.0.1:${process.env.PORT}`])
const loopback = (address: string) => address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
const validBinding = (value: FormalSendGrantBinding) =>
  Number.isSafeInteger(value?.queueRevision) && value.queueRevision >= 0 &&
  Number.isSafeInteger(value?.targetCount) && value.targetCount >= 0 &&
  /^[a-f0-9]{64}$/.test(value?.taskDigest || '')

export type FormalSendGrantTaskTuple = {
  id: string
  customerId: string
  draftId: string
  draftVersion: number | null
  draftRevision: string | null
  recipientEmail: string
  scheduledSendAt: string
}

export function formalSendGrantTaskTuples(store: any, now = new Date()): FormalSendGrantTaskTuple[] {
  const records = store?.paused || store?.pausePending ? [] : (Array.isArray(store?.records) ? store.records : [])
  return records
    .filter((record: any) => record?.sendQueueStatus === 'scheduled' && record?.scheduledSendAt && Date.parse(record.scheduledSendAt) <= now.getTime())
    .map((record: any) => ({
      id: String(record.id ?? ''),
      customerId: String(record.customerId ?? ''),
      draftId: String(record.draftId ?? ''),
      draftVersion: Number.isSafeInteger(record.draftVersion) ? Number(record.draftVersion) : null,
      draftRevision: record.draftRevision == null ? null : String(record.draftRevision),
      recipientEmail: String(record.recipientEmail ?? '').trim().toLowerCase(),
      scheduledSendAt: String(record.scheduledSendAt ?? ''),
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
}

export function createFormalSendGrantBinding(store: any, now = new Date()): FormalSendGrantBinding {
  const tasks = formalSendGrantTaskTuples(store, now)
  return {
    queueRevision: Number.isSafeInteger(store?.revision) ? store.revision : 0,
    targetCount: tasks.length,
    taskDigest: createHash('sha256').update(JSON.stringify(tasks)).digest('hex'),
  }
}

export class FormalQueueSecurity {
  private readonly now: () => number
  private readonly randomToken: () => string
  private readonly grantTtlMs: number
  private readonly sessionTtlMs: number
  private sessions = new Map<string, { csrfToken: string; expiresAt: number; approvedBy: string }>()
  private grants = new Map<string, { operatorToken: string; expiresAt: number; binding: FormalSendGrantBinding }>()

  constructor(options: { now?: () => number; randomToken?: () => string; grantTtlMs?: number; sessionTtlMs?: number } = {}) {
    this.now = options.now ?? Date.now
    this.randomToken = options.randomToken ?? (() => randomBytes(32).toString('base64url'))
    this.grantTtlMs = options.grantTtlMs ?? 60_000
    this.sessionTtlMs = options.sessionTtlMs ?? 15 * 60_000
  }

  issueOperatorSession(origin: string, remoteAddress: string) {
    if (!trustedOrigins.has(origin) || !loopback(remoteAddress)) throw new Error('LOCAL_OPERATOR_ORIGIN_REJECTED')
    const operatorToken = this.randomToken()
    const csrfToken = this.randomToken()
    const approvedBy = `local_operator:${createHash('sha256').update(operatorToken).digest('hex').slice(0, 16)}`
    const expiresAt = this.now() + this.sessionTtlMs
    this.sessions.set(operatorToken, { csrfToken, expiresAt, approvedBy })
    return { operatorToken, csrfToken, approvedBy, expiresAt }
  }

  authorizeMutation(input: AuthInput): AuthResult {
    if (!trustedOrigins.has(input.origin) || !loopback(input.remoteAddress)) return { ok: false, code: 'LOCAL_OPERATOR_ORIGIN_REJECTED' }
    const session = this.sessions.get(input.operatorToken)
    if (!session || session.expiresAt < this.now()) return { ok: false, code: 'LOCAL_OPERATOR_AUTH_REQUIRED' }
    if (session.csrfToken !== input.csrfToken) return { ok: false, code: 'CSRF_TOKEN_INVALID' }
    return { ok: true, approvedBy: session.approvedBy }
  }

  issueSendGrant(auth: AuthInput, binding: FormalSendGrantBinding) {
    const result = this.authorizeMutation(auth)
    if (!result.ok) throw new Error(result.code)
    if (!validBinding(binding) || binding.targetCount < 1) throw new Error('FORMAL_SEND_GRANT_TARGETS_REQUIRED')
    const token = this.randomToken()
    const expiresAt = this.now() + this.grantTtlMs
    this.grants.set(token, { operatorToken: auth.operatorToken, expiresAt, binding: { ...binding } })
    return { token, expiresAt, ...binding }
  }

  consumeSendGrant(token: string, auth: AuthInput, safeMode: boolean, binding: FormalSendGrantBinding): { ok: boolean; code: string } {
    if (safeMode) return { ok: false, code: 'SAFE_MODE_BLOCKED' }
    const authorized = this.authorizeMutation(auth)
    if (!authorized.ok) return authorized
    const grant = this.grants.get(token)
    if (!grant || grant.operatorToken !== auth.operatorToken) return { ok: false, code: 'FORMAL_SEND_GRANT_INVALID' }
    this.grants.delete(token)
    if (grant.expiresAt < this.now()) return { ok: false, code: 'FORMAL_SEND_GRANT_EXPIRED' }
    if (!validBinding(binding) ||
      grant.binding.queueRevision !== binding.queueRevision ||
      grant.binding.targetCount !== binding.targetCount ||
      grant.binding.taskDigest !== binding.taskDigest) return { ok: false, code: 'FORMAL_SEND_GRANT_MISMATCH' }
    return { ok: true, code: 'FORMAL_SEND_GRANT_CONSUMED' }
  }
}

const safeValue = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/
export function validateFormalMutationBody(body: Record<string, unknown>, required: string[]) {
  if ('approvedBy' in body) return { ok: false, code: 'CLIENT_APPROVER_FORBIDDEN' }
  for (const field of required) {
    const value = body[field]
    if (typeof value !== 'string' || !safeValue.test(value)) return { ok: false, code: 'FORMAL_FIELD_INVALID', field }
  }
  for (const [field, value] of Object.entries(body)) {
    if (typeof value === 'string' && !safeValue.test(value)) return { ok: false, code: 'FORMAL_FIELD_INVALID', field }
  }
  return { ok: true as const }
}

export function validateExactFormalMutationBody(body: Record<string, unknown>, required: string[]) {
  const allowed = new Set(required)
  for (const field of Object.keys(body)) if (!allowed.has(field)) return { ok: false, code: 'FORMAL_FIELD_UNEXPECTED', field }
  return validateFormalMutationBody(body, required)
}

const publicSendErrors = new Set(['SMTP_RESULT_AMBIGUOUS', 'SEND_CLAIM_STALE'])
const publicSendError = (value: unknown) => publicSendErrors.has(String(value || '')) ? String(value) : value ? 'INTERNAL_SEND_ERROR' : undefined
const publicQueueStatuses = new Set(['pending_human_review', 'approved_for_sending', 'scheduled', 'sending', 'sent', 'send_failed', 'needs_reschedule', 'needs_manual_reconciliation', 'needs_timezone_review', 'skipped', 'paused', 'blocked'])
const publicDeliveryStatuses = new Set(['sent_observation', 'formal_bounced', 'replied', 'followup_due'])
const publicRecordScopes = new Set(['active', 'history'])
const publicEnum = (value: unknown, allowed: Set<string>) => allowed.has(String(value || '')) ? String(value) : undefined
const publicTime = (value: unknown) => {
  if (typeof value !== 'string') return undefined
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value ? value : undefined
}
const publicCount = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0
const publicRef = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{24}$/.test(value) ? value : undefined
const publicCampaignLabels = new Set(['开发信任务', '跟进任务', '人工发送任务'])
export const publicCustomerRouteRef = (customerId: unknown) => createHash('sha256').update(`formal-customer:${String(customerId || '')}`).digest('hex').slice(0, 24)
export const publicQueueRecordRef = (record: any, index: number) => createHash('sha256').update(`formal-record:${index}:${String(record?.id || '')}:${String(record?.customerId || '')}:${String(record?.draftId || '')}`).digest('hex').slice(0, 24)
export const publicCampaignLabel = (record: any) => record?.campaignId === 'followup-auto-consumer' ? '跟进任务' : record?.campaignId === 'manual' ? '人工发送任务' : '开发信任务'
export function sanitizeFormalQueueStore(store: any) {
  const records = Array.isArray(store?.records) ? store.records : []
  return {
    version: publicCount(store?.version), revision: publicCount(store?.revision), updatedAt: publicTime(store?.updatedAt), paused: store?.paused === true, dashboardOnly: true,
    records: records.map((record: any) => ({
      sendQueueStatus: publicEnum(record?.sendQueueStatus, publicQueueStatuses),
      recordScope: publicEnum(record?.recordScope, publicRecordScopes),
      publicRecordId: publicRef(record?.publicRecordId),
      customerRouteRef: publicRef(record?.customerRouteRef),
      campaignLabel: publicEnum(record?.campaignLabel, publicCampaignLabels),
      deliveryStatus: publicEnum(record?.deliveryStatus, publicDeliveryStatuses),
      scheduledSendAt: publicTime(record?.scheduledSendAt),
      actualSentAt: publicTime(record?.actualSentAt),
      sendAttemptCount: publicCount(record?.sendAttemptCount),
      sendErrorCode: publicSendError(record?.sendError),
      updatedAt: publicTime(record?.updatedAt),
    })),
  }
}
