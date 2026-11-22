import { OUTREACH_SENDER } from './emailSignature'
export { OUTREACH_SENDER as OFFICIAL_OUTREACH_EMAIL } from './emailSignature'
export const MANAGEMENT_BACKUP_EMAILS = [] as const

export function getDraftSenderReviewReason(draft: { senderEmail?: string; body?: string } | undefined): string {
  if (!draft) return ''
  const sender = String(draft.senderEmail || '').trim().toLowerCase()
  if (!OUTREACH_SENDER) return '请先在设置中填写发件邮箱'
  return sender && sender !== OUTREACH_SENDER ? '发件邮箱已更改，请重新生成草稿并审核' : ''
}
