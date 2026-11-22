import type { EmailDisposition, PipelineItem } from '../types/item'
import { buildEmailCandidateRows } from './emailCandidateView'
import { normalizeEmail } from './emailQualityPolicy'

export type EmailDispositionCommandAction = 'quarantine' | 'restore'

export interface EmailDispositionCommand {
  itemId: string
  email: string
  action: EmailDispositionCommandAction
  reason: string
  actor: string
  commandId: string
}

export interface EmailDispositionCommandBody {
  itemId: string
  email: string
  action: EmailDispositionCommandAction
  reason: string
  commandId: string
}

export class EmailDispositionCommandError extends Error {
  constructor(public code: string, message: string) {
    super(message)
  }
}

const safeId = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/
const control = /[\u0000-\u001f\u007f]/

export function isApplicationJsonContentType(value: unknown): boolean {
  return String(value || '').split(';', 1)[0].trim().toLowerCase() === 'application/json'
}

export function validateEmailDispositionCommandBody(body: Record<string, unknown>):
  | { ok: true; value: EmailDispositionCommandBody }
  | { ok: false; code: string; field?: string } {
  const allowed = new Set(['itemId', 'email', 'action', 'reason', 'commandId'])
  for (const field of Object.keys(body)) {
    if (!allowed.has(field)) return { ok: false, code: 'DISPOSITION_FIELD_UNEXPECTED', field }
  }
  const itemId = typeof body.itemId === 'string' ? body.itemId.trim() : ''
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  const action = body.action
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  const commandId = typeof body.commandId === 'string' ? body.commandId.trim() : ''
  if (!safeId.test(itemId)) return { ok: false, code: 'DISPOSITION_FIELD_INVALID', field: 'itemId' }
  if (!email || email.length > 320 || control.test(email) || /\s/.test(email)) return { ok: false, code: 'DISPOSITION_FIELD_INVALID', field: 'email' }
  if (action !== 'quarantine' && action !== 'restore') return { ok: false, code: 'DISPOSITION_FIELD_INVALID', field: 'action' }
  if (!reason || reason.length > 300 || control.test(reason)) return { ok: false, code: 'DISPOSITION_FIELD_INVALID', field: 'reason' }
  if (!safeId.test(commandId)) return { ok: false, code: 'DISPOSITION_FIELD_INVALID', field: 'commandId' }
  return { ok: true, value: { itemId, email, action, reason, commandId } }
}

export function applyEmailDispositionCommandToItem(
  item: PipelineItem,
  command: EmailDispositionCommand,
  now = new Date(),
): { item: PipelineItem; idempotent: boolean } {
  const email = normalizeEmail(command.email)
  if (item.id !== command.itemId) throw new EmailDispositionCommandError('ITEM_NOT_FOUND', '客户不存在')
  if (!command.actor.trim()) throw new EmailDispositionCommandError('SERVER_ACTOR_REQUIRED', '服务端操作人缺失')
  const priorCommand = (item.emailDispositionAudit || []).find(entry => entry.commandId === command.commandId)
  if (priorCommand) {
    const same = normalizeEmail(priorCommand.email) === email
      && priorCommand.action === command.action
      && priorCommand.reason === command.reason.trim()
    if (!same) throw new EmailDispositionCommandError('COMMAND_ID_CONFLICT', '幂等键已用于不同命令')
    return { item, idempotent: true }
  }
  const candidate = buildEmailCandidateRows(item, now).find(row => row.normalizedEmail === email)
  if (!candidate) throw new EmailDispositionCommandError('EMAIL_NOT_FOUND', '该客户不存在这个精确邮箱地址')
  if (command.action === 'quarantine' && candidate.tier !== 'E') {
    throw new EmailDispositionCommandError('REAL_ADDRESS_REQUIRES_ROUTING', '真实邮箱风险应保留并路由，不能按结构垃圾隔离')
  }
  const priorEntries = (item.emailDispositionLog || [])
    .filter(entry => normalizeEmail(entry.email) === email)
    .sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt))
  const previous = priorEntries[0]?.disposition || 'unverified'
  if (
    command.action === 'restore'
    && !(previous === 'invalid' && priorEntries[0]?.reason?.startsWith('manual_structural_quarantine'))
  ) {
    throw new EmailDispositionCommandError('NOT_QUARANTINED', '该精确地址当前没有可恢复的人工隔离记录')
  }
  const recordedAt = now.toISOString()
  const disposition: EmailDisposition = command.action === 'quarantine' ? 'invalid' : 'unverified'
  const reasonPrefix = command.action === 'quarantine'
    ? 'manual_structural_quarantine'
    : 'manual_quarantine_restored'
  return {
    idempotent: false,
    item: {
      ...item,
      emailDispositionLog: [
        ...(item.emailDispositionLog || []),
        { email, disposition, reason: `${reasonPrefix}:${command.reason.trim()}`, source: 'verification_workbench', recordedAt },
      ],
      emailDispositionAudit: [
        ...(item.emailDispositionAudit || []),
        {
          email,
          action: command.action,
          reason: command.reason.trim(),
          actor: command.actor.trim(),
          commandId: command.commandId,
          previousDisposition: previous,
          nextDisposition: disposition,
          recordedAt,
        },
      ],
    },
  }
}

export function applyEmailDispositionCommand(
  items: PipelineItem[],
  command: EmailDispositionCommand,
  now = new Date(),
): PipelineItem[] {
  let found = false
  const changed = items.map(item => {
    if (item.id !== command.itemId) return item
    found = true
    return applyEmailDispositionCommandToItem(item, command, now).item
  })
  if (!found) throw new EmailDispositionCommandError('ITEM_NOT_FOUND', '客户不存在')
  return changed
}
