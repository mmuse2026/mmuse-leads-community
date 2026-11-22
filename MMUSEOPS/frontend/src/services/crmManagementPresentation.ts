const list = (value: unknown): any[] => Array.isArray(value) ? value : []
const text = (value: unknown) => String(value || '').trim().toLowerCase()

const STAGE_LABELS: Record<string, string> = {
  backcheck_queue: '待补背调',
  data_enrichment_needed: '待补数据',
  manual_review: '待人工审核',
  contact_mining_queue: '待挖联系人',
  email_validation_queue: '邮箱待验证',
  observation_queue: '测试信观察中',
  developable_email_pool: '可开发',
  pending_draft_review: '草稿待审',
  scheduled_send_queue: '待发送',
  followup_queue: '已发信待回复',
  replied_queue: '已回复',
  replace_contact_queue: '需换联系人',
  low_priority_nurture: '培育中',
  true_excluded: '已隔离',
}

export const CRM_STAGE_OPTIONS = Object.entries(STAGE_LABELS).map(([value, label]) => ({ value, label }))

export function crmStageLabel(value: unknown): string {
  return STAGE_LABELS[text(value)] || '待补背调'
}

export function emailLogTypeLabel(log: any): string {
  const type = text(log?.type)
  if (type === 'crm_reply' || /formal.*reply|reply.*formal/.test(type) || ['received', 'replied', 'reply_observed'].includes(text(log?.status))) return '客户回复'
  if (type === 'formal_outreach_bounce') return '正式退信'
  if (type === 'formal_followup' || type === 'followup' || log?.followup === true) return '跟进信'
  if (type === 'formal_outreach') return '正式开发信'
  if (type === 'test_handshake' || type === 'outreach' || type.includes('test_mail') || type.includes('isolated_test')) return '测试信'
  return '其他记录'
}

export function emailLogStatusLabel(log: any): string {
  const status = text(log?.status)
  if (['received', 'replied', 'reply_observed'].includes(status)) return '已回复'
  if (status === 'bounced' || status === 'failed') return '退信'
  if (status === 'sent' || status === 'delivered') return status === 'sent' ? '已发送' : '已送达'
  if (status === 'opened' || status === 'read') return '已读'
  return '待确认'
}

function eventAt(log: any): string {
  return String(log?.receivedAt || log?.repliedAt || log?.sentAt || log?.checkedAt || '')
}

export function getLastCustomerContactAt(item: any): string {
  const dates = list(item?.emailLogs)
    .filter(log => ['正式开发信', '跟进信', '客户回复'].includes(emailLogTypeLabel(log)))
    .map(eventAt)
    .filter(value => Number.isFinite(Date.parse(value)))
    .sort((a, b) => Date.parse(b) - Date.parse(a))
  return dates[0] || ''
}

export function getNextCustomerFollowupAt(item: any): string {
  if (text(item?.primaryStage) !== 'followup_queue' && !item?.followupDueAt3d && !item?.followupDueAt7d) return ''
  const drafts = list(item?.manualEmailDrafts).filter(draft => draft?.followup === true || text(draft?.type) === 'followup')
  const roundSent = (round: number) => drafts.some(draft => Number(draft?.round) === round && draft?.sent === true)
  const candidates = [
    !roundSent(1) ? String(item?.followupDueAt3d || '') : '',
    !roundSent(2) ? String(item?.followupDueAt7d || '') : '',
  ].filter(value => Number.isFinite(Date.parse(value)))
  return candidates.sort((a, b) => Date.parse(a) - Date.parse(b))[0] || ''
}
