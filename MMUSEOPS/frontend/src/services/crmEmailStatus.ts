import type { PipelineItem } from '../types/item'
import { deriveAddressVerificationState } from './emailCandidateView'
/** Presentation only: never grants send eligibility or changes manual fields. */
export function crmEmailStatus(item: PipelineItem, now = new Date()) {
 const email = (item.selectedEmail || item.email || '').trim().toLowerCase()
 const state = deriveAddressVerificationState(item, email, now)
 const labels = { accepted: '该邮箱已有验证/回复或观察期证据（不保证送达）', watching: '该邮箱仍在观察期', unverified: '该邮箱未验证或结果未知', bounced: '该邮箱退信/失败', invalid: '该邮箱格式或域名无效' }
 return { email, state, label: email ? labels[state] : '未选择邮箱（未验证）' }
}
