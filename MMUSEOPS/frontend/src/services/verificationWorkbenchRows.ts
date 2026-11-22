import type { PipelineItem } from '../types/item'
import { buildEmailCandidateRows, type EmailCandidateRow } from './emailCandidateView'
import { getLeadStageEligibility } from './leadStageEligibility'
import { presentSource, type PresentationText } from './presentation'
import { isEmailBounced } from './emailBounce'

export type VerificationWorkbenchFilter =
  | 'priority_pending'
  | 'watching'
  | 'public'
  | 'quarantined'
  | 'replace_contact'
  | 'email_validation_queue'

export interface VerificationWorkbenchRow {
  key: string
  itemId: string
  candidate: EmailCandidateRow
  company: {
    name: string
    website: string
    industry: string
    summary: string
  }
  buckets: VerificationWorkbenchFilter[]
  eligibleForValidation: boolean
  quarantined: boolean
  riskReasonLabels: string[]
  nextActionLabel: string
}

export const VERIFICATION_FILTER_META: Record<VerificationWorkbenchFilter, { label: string; tooltip: string }> = {
  priority_pending: { label: '优先待验证', tooltip: '质量 A-C、无终态风险，并已进入邮箱验证阶段的地址。' },
  watching: { label: '观察中', tooltip: '地址仍处在退信或回复观察窗口，不能提前视为有效。' },
  public: { label: '公众邮箱', tooltip: '公司部门、通用公开邮箱或官网公开的免费业务邮箱。' },
  quarantined: { label: '异常隔离', tooltip: '结构污染、来源不足或需人工复核的地址；记录全部保留，只有结构垃圾可执行隔离。' },
  replace_contact: { label: '需要换联系人', tooltip: '该精确地址已有退信或失败证据，需要寻找其他联系人。' },
  email_validation_queue: { label: '待发测试信', tooltip: 'primaryStage=email_validation_queue 的客户，每客户一行；处理（验证/发测试信）后客户离开该阶段。' },
}

export type VerificationSourceMeta = PresentationText

export function getVerificationSourceMeta(source?: string, evidenceUrl?: string): VerificationSourceMeta {
  return presentSource(source, evidenceUrl)
}

const riskReasonLabels: Record<string, string> = {
  address_suppressed_or_complained: '该地址有投诉、退订或禁止联系风险',
  address_bounced_or_failed: '该地址有退信或发送失败记录',
  suspicious_address_requires_review: '地址结构可疑，需要人工确认',
  free_mailbox_requires_review: '免费邮箱缺少公司归属证据',
  company_domain_mismatch: '邮箱域名与公司官网不一致',
  insufficient_contact_evidence: '联系人来源证据不足',
  candidate_missing_public_contact_evidence: '缺少公开联系人证据',
  non_business_role_address: '非业务角色邮箱（如 noreply/jobs/hr/legal/returns），不适合作为开发联络地址',
}

function exactLatestDisposition(item: PipelineItem, email: string) {
  return (item.emailDispositionLog || [])
    .filter(entry => entry.email.trim().toLowerCase() === email)
    .sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt))[0]
}

function isManualStructuralQuarantine(item: PipelineItem, row: EmailCandidateRow): boolean {
  const latest = exactLatestDisposition(item, row.normalizedEmail)
  if (latest?.disposition === 'unverified' && latest.reason?.startsWith('manual_quarantine_restored')) return false
  return row.tier === 'E'
    || Boolean(latest?.disposition === 'invalid' && latest.reason?.startsWith('manual_structural_quarantine'))
}

function nextAction(row: EmailCandidateRow, quarantined: boolean): string {
  if (quarantined) return '核对原始来源；确认修复后再恢复'
  if (row.verificationState === 'watching') return '等待观察窗口完成'
  if (row.verificationState === 'bounced' || row.quality.riskReasons.includes('address_bounced_or_failed')) return '寻找并验证替代联系人'
  if (row.quality.riskReasons.includes('address_suppressed_or_complained')) return '保留风险记录并人工决定'
  if (row.tier === 'D') return '人工核对来源与公司归属'
  if (row.verificationState === 'accepted') return '复核地址级证据'
  if (row.verificationState === 'invalid') return '修正地址或更换联系人'
  return '执行格式与 DNS/MX 验证'
}

export function buildVerificationWorkbenchRows(items: PipelineItem[], now = new Date()): VerificationWorkbenchRow[] {
  return items.flatMap(item => {
    return buildEmailCandidateRows(item, now).map(candidate => {
      const candidateEligibility = getLeadStageEligibility({ ...item, selectedEmail: candidate.normalizedEmail }, now)
      const quarantined = isManualStructuralQuarantine(item, candidate)
      const buckets = new Set<VerificationWorkbenchFilter>()
      // 铁律：明确退信的客户/邮箱只落在「需要换联系人」桶，绝不出现在优先待验证/观察/公众邮箱桶
      const itemBounced = isEmailBounced(item)
      const replace = itemBounced
        || candidate.verificationState === 'bounced'
        || candidate.quality.riskReasons.includes('address_bounced_or_failed')
      const manual = candidate.tier === 'D'
        || candidate.quality.riskReasons.includes('address_suppressed_or_complained')
        || candidate.quality.riskReasons.includes('suspicious_address_requires_review')
      if (candidate.verificationState === 'watching') buckets.add('watching')
      if (['public', 'department', 'free_business'].includes(candidate.emailType)) buckets.add('public')
      if (quarantined) buckets.add('quarantined')
      if (replace) buckets.add('replace_contact')
      if (manual && !quarantined) buckets.add('quarantined')
      if (
        candidate.verificationState === 'unverified'
        && ['A', 'B', 'C'].includes(candidate.tier)
        && candidate.quality.riskReasons.length === 0
        && candidateEligibility.canEnterEmailValidation
      ) buckets.add('priority_pending')
      // 退信地址只保留「需要换联系人」桶，绝不进入优先待验证/观察/公众邮箱等非退信视图
      if (replace) {
        buckets.delete('watching')
        buckets.delete('public')
        buckets.delete('quarantined')
        buckets.delete('priority_pending')
      }
      const reasons = [...candidate.quality.blockedReasons, ...candidate.quality.riskReasons]
      return {
        key: `${item.id}:${candidate.normalizedEmail}`,
        itemId: item.id,
        candidate,
        company: {
          name: item.company || item.title || '未命名公司',
          website: item.website || '',
          industry: String(item.businessLine || item.clientType || ''),
          summary: item.backCheck?.summary || item.snippet || (item as any).evidenceSummary || '',
        },
        buckets: [...buckets],
        eligibleForValidation: !itemBounced && candidateEligibility.canEnterEmailValidation && !quarantined && ['A', 'B', 'C'].includes(candidate.tier),
        quarantined,
        riskReasonLabels: reasons.map(reason => riskReasonLabels[reason] || reason),
        nextActionLabel: nextAction(candidate, quarantined),
      }
    })
  }).sort((a, b) => {
    const priority = (row: VerificationWorkbenchRow) =>
      row.buckets.includes('priority_pending') ? 0
        : row.buckets.includes('watching') ? 1
          : row.buckets.includes('public') ? 2
            : row.buckets.includes('replace_contact') ? 3
              : row.buckets.includes('quarantined') ? 4 : 5
    return priority(a) - priority(b) || a.candidate.normalizedEmail.localeCompare(b.candidate.normalizedEmail)
  })
}
