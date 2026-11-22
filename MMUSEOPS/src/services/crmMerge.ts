import { isActiveCrmMaster } from './crmIdentity'
import { crmBusinessScope } from './crmBusinessScope'

const text = (value: unknown) => String(value ?? '').trim()

function arrayKey(value: any): string {
  if (!value || typeof value !== 'object') return JSON.stringify(value)
  const explicit = value.id || value.messageId || value.commandId || value.correlationId || value.draftId
  if (explicit) return `id:${text(explicit).toLowerCase()}`
  const email = text(value.email || value.normalizedEmail || value.to || value.from).toLowerCase()
  if (email) return `email:${email}|${text(value.name || value.contactName || value.title || value.jobTitle).toLowerCase()}`
  const time = value.at || value.sentAt || value.createdAt || value.enteredAt || value.date
  return `json:${JSON.stringify({ ...value, updatedAt: undefined, syncedAt: undefined, time })}`
}

function mergeArrays(groups: any[][]): any[] {
  const result: any[] = []
  const seen = new Set<string>()
  for (const values of groups) for (const value of values) {
    const key = arrayKey(value)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(value)
  }
  return result
}

function meaningful(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0
  if (value && typeof value === 'object') return Object.keys(value as object).length > 0
  return value !== undefined && value !== null && value !== ''
}

function score(item: any): number {
  const logs = Array.isArray(item?.emailLogs) ? item.emailLogs : []
  const replied = item?.replyObservedAt || item?.primaryStage === 'replied_queue' || logs.some((value: any) => ['replied', 'received', 'reply_observed'].includes(value?.status))
  const sent = logs.some((value: any) => value?.status === 'sent' || value?.messageId || value?.actualSentAt)
  const backcheck = item?.backCheck || item?.backcheck || item?.detailedBackcheckAt
  const contacts = Array.isArray(item?.contacts) ? item.contacts.length : 0
  return (replied ? 1_000_000 : 0) + (sent ? 100_000 : 0) + (backcheck ? 10_000 : 0) + contacts * 100 + (text(item?.selectedEmail) ? 20 : 0)
}

function chooseMaster(group: any[]): any {
  return [...group].sort((a, b) => {
    const byScore = score(b) - score(a)
    if (byScore) return byScore
    const at = Date.parse(text(a?.createdAt))
    const bt = Date.parse(text(b?.createdAt))
    if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at - bt
    return text(a?.id).localeCompare(text(b?.id))
  })[0]
}

const ARRAY_FIELDS = [
  'contacts', 'emailVerificationEvidence', 'emailDispositionLog', 'emailDispositionAudit', 'emailVerificationRouting',
  'emailLogs', 'manualEmailDrafts', 'zohoReplyEvidence', 'notes', 'attachments', 'timeline', 'serverCommandLog',
  'contactReplacementLog', 'snovioDomainSearchTasks', 'draftReviewAudit',
]

function mergedMaster(master: any, group: any[], duplicateIds: string[]): any {
  const result = { ...master }
  for (const item of group) for (const [field, value] of Object.entries(item)) {
    if (field === 'id' || field === 'serverRevision' || ARRAY_FIELDS.includes(field)) continue
    if (!meaningful(result[field]) && meaningful(value)) result[field] = value
  }
  for (const field of ARRAY_FIELDS) {
    const merged = mergeArrays(group.map(item => Array.isArray(item?.[field]) ? item[field] : []))
    if (merged.length) result[field] = merged
  }
  result.crmMasterId = master.id
  result.crmMergedIds = [...new Set([...(Array.isArray(master.crmMergedIds) ? master.crmMergedIds : []), ...duplicateIds])].sort()
  delete result.crmMergedInto
  delete result.crmMergeReason
  delete result.crmMergedAt
  if (result.inactiveCategory === 'duplicate') delete result.inactiveCategory
  if (result.inactiveReason === 'CRM公司主体合并，只读保留') delete result.inactiveReason
  return result
}

export function mergeCrmCompanies(input: any[], now = new Date(), options: { preferredMasterId?: string } = {}): { items: any[]; mergedGroups: number; mergedRecords: number } {
  const groups = new Map<string, any[]>()
  for (const item of input) {
    const scope = crmBusinessScope(item?.businessLine)
    const key = scope && text(item?.crmCompanyKey) ? `${scope}|${text(item.crmCompanyKey)}` : ''
    if (!key || !isActiveCrmMaster(item)) continue
    groups.set(key, [...(groups.get(key) || []), item])
  }
  const replacements = new Map<string, any>()
  let mergedGroups = 0
  let mergedRecords = 0
  for (const group of groups.values()) {
    if (group.length < 2) continue
    mergedGroups++
    mergedRecords += group.length - 1
    const master = group.find(item => options.preferredMasterId && item.id === options.preferredMasterId) || chooseMaster(group)
    const duplicates = group.filter(item => item.id !== master.id)
    replacements.set(master.id, mergedMaster(master, group, duplicates.map(item => text(item.id))))
    for (const item of duplicates) replacements.set(item.id, {
      ...item,
      crmMasterId: master.id,
      crmMergedInto: master.id,
      crmMergeReason: '公司身份相同',
      crmMergedAt: now.toISOString(),
      activeWorkflow: false,
      inactiveWorkflow: true,
      inactiveCategory: 'duplicate',
      inactiveReason: 'CRM公司主体合并，只读保留',
      status: 'archived',
      primaryStage: 'true_excluded',
      normalizedStage: 'true_excluded',
      currentAllowedStage: 'true_excluded',
    })
  }
  return { items: input.map(item => replacements.get(item.id) || item), mergedGroups, mergedRecords }
}
