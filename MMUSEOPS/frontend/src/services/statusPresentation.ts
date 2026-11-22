import type { AddressVerificationState } from './emailCandidateView'
import type { EmailType } from './emailQualityPolicy'

export interface StatusPresentationContext {
  source?: string
  result?: string
  emailType?: EmailType
}

export interface StatusPresentation {
  label: string
  tone: 'success' | 'danger' | 'warning' | 'neutral'
  blocking: boolean
  description: string
  scope: 'address'
  nextAction: 'review_evidence' | 'replace_contact' | 'correct_or_replace_address' | 'wait_for_observation' | 'verify_selected_address' | 'manual_review_source'
}

const presentations: Record<AddressVerificationState, StatusPresentation> = {
  accepted: { label: '已有可达证据', tone: 'success', blocking: false, description: '已有可达证据，强度取决于来源', scope: 'address', nextAction: 'review_evidence' },
  bounced: { label: '已退信', tone: 'danger', blocking: true, description: '该地址已有退信或失败证据', scope: 'address', nextAction: 'replace_contact' },
  invalid: { label: '无效地址', tone: 'danger', blocking: true, description: '该地址格式或域名证据无效', scope: 'address', nextAction: 'correct_or_replace_address' },
  watching: { label: '观察中', tone: 'warning', blocking: false, description: '该地址仍在观察窗口内', scope: 'address', nextAction: 'wait_for_observation' },
  unverified: { label: '未验证', tone: 'neutral', blocking: false, description: '该地址尚无足够可达证据', scope: 'address', nextAction: 'verify_selected_address' },
}

function acceptedDescription(context: StatusPresentationContext): string {
  const source = String(context.source || '').toLowerCase()
  const result = String(context.result || '').toLowerCase()
  if (result.includes('reply_observed')) return '已有回复可达证据，来源为已关联的收件记录'
  if (result.includes('smtp_handshake')) return '已有 SMTP 可达证据，强度取决于握手结果和服务端策略'
  if (result.includes('no_bounce_observed')) return '已有观察期可达证据，强度取决于观察窗口和回执来源'
  if (source.includes('imap')) return '已有回复可达证据，来源为已关联的收件记录'
  if (source.includes('smtp')) return '已有 SMTP 可达证据，强度取决于握手结果和服务端策略'
  if (source.includes('isolated_test')) return '已有观察期可达证据，强度取决于观察窗口和回执来源'
  return presentations.accepted.description
}

export function getStatusPresentation(state: AddressVerificationState, context: StatusPresentationContext = {}): StatusPresentation {
  const base = presentations[state]
  if (state === 'unverified' && context.emailType === 'free_business') return { ...base, description: '官网公开免费业务邮箱，已建立公司业务归属；需按免费邮箱验证路径核验' }
  if (state === 'unverified' && context.emailType === 'free_unconfirmed') return { ...base, description: '免费邮箱来源归属不足，地址仍保留但需人工复核', nextAction: 'manual_review_source' }
  return state === 'accepted' ? { ...base, description: acceptedDescription(context) } : { ...base }
}