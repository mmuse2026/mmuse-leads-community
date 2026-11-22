export const SERVER_OWNED_HISTORY_FIELDS = [
  'manualEmailDrafts', 'outreachDrafts', 'emailLogs', 'emailVerificationEvidence',
  'emailDispositionLog', 'emailDispositionAudit', 'emailVerificationRouting', 'zohoReplyEvidence',
  'draftReviewReturn', 'draftReviewAudit', 'contactReplacementLog', 'snovioDomainSearchTasks', 'formalSendHistory',
  'communicationEvents', 'opportunities', 'crmTasks', 'salesStageHistory', 'quoteVersions', 'crmCommandLog',
] as const
export interface ItemSaveCommandBody {
  duplicatePolicy?: 'reuse_search_identity'
  itemId: string
  expectedRevision: number
  commandId: string
  item: Record<string, unknown>
}

type Validation = { ok: true; value: ItemSaveCommandBody } | { ok: false; code: string; field?: string }

const safeId = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor'])

function safeJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 24) return false
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'string') return value.length <= 1_000_000
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.length <= 20_000 && value.every(entry => safeJsonValue(entry, depth + 1))
  if (typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const entries = Object.entries(value as Record<string, unknown>)
  return entries.length <= 2_000 && entries.every(([key, entry]) => !forbiddenKeys.has(key) && key.length <= 128 && safeJsonValue(entry, depth + 1))
}

export function validateItemSaveCommandBody(body: unknown): Validation {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, code: 'ITEM_COMMAND_BODY_INVALID' }
  const source = body as Record<string, unknown>
  const allowed = new Set(['itemId', 'expectedRevision', 'commandId', 'item', 'duplicatePolicy'])
  const unexpected = Object.keys(source).find(field => !allowed.has(field))
  if (unexpected) return { ok: false, code: unexpected === 'actor' || unexpected === 'approvedBy' ? 'CLIENT_ACTOR_FORBIDDEN' : 'ITEM_COMMAND_FIELD_UNEXPECTED', field: unexpected }
  if (source.duplicatePolicy !== undefined && source.duplicatePolicy !== 'reuse_search_identity') return { ok: false, code: 'ITEM_DUPLICATE_POLICY_INVALID', field: 'duplicatePolicy' }
  const itemId = typeof source.itemId === 'string' ? source.itemId.trim() : ''
  const commandId = typeof source.commandId === 'string' ? source.commandId.trim() : ''
  if (!safeId.test(itemId)) return { ok: false, code: 'ITEM_ID_INVALID', field: 'itemId' }
  if (!safeId.test(commandId)) return { ok: false, code: 'COMMAND_ID_INVALID', field: 'commandId' }
  if (!Number.isSafeInteger(source.expectedRevision) || Number(source.expectedRevision) < 0) return { ok: false, code: 'EXPECTED_REVISION_INVALID', field: 'expectedRevision' }
  if (!safeJsonValue(source.item)) return { ok: false, code: 'ITEM_PAYLOAD_INVALID', field: 'item' }
  const item = source.item as Record<string, unknown>
  if (item.id !== itemId) return { ok: false, code: 'ITEM_ID_MISMATCH', field: 'item.id' }
  const itemRevision = item.serverRevision === undefined ? 0 : item.serverRevision
  if (!Number.isSafeInteger(itemRevision) || itemRevision !== source.expectedRevision) return { ok: false, code: 'ITEM_REVISION_MISMATCH', field: 'item.serverRevision' }
  if (JSON.stringify(item).length > 2 * 1024 * 1024) return { ok: false, code: 'ITEM_PAYLOAD_TOO_LARGE', field: 'item' }
  return { ok: true, value: { itemId, expectedRevision: Number(source.expectedRevision), commandId, item, ...(source.duplicatePolicy ? { duplicatePolicy: source.duplicatePolicy as 'reuse_search_identity' } : {}) } }
}
