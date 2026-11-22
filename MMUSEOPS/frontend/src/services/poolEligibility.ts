import { isAggregatorDomain } from './aggregatorDomains'
import { isPlaceholderEmail } from './emailClassification'
import type { TestMailVerdict } from './testMailGate'
import { getActiveProfile } from './profiles'

/**
 * 统一"开发池资格排除规则"。
 * 纯函数、无文件 IO。按优先级顺序判定，返回首个命中；全部未命中返回 null。
 */
export type PoolExclusionReason =
  | 'aggregator_or_platform_domain' | 'placeholder_email' | 'already_formally_sent'
  | 'test_mail_bounced' | 'formal_bounced' | 'suppressed_or_complained' | 'non_buyer_entity'
  | 'low_value' | 'no_emailable_email'

export interface PoolEligibilityCtx { formalSentEmails?: ReadonlySet<string>; testMailVerdicts?: ReadonlyMap<string, TestMailVerdict> }

const list = (v: unknown): any[] => (Array.isArray(v) ? v : [])
const clean = (v: unknown): string => String(v ?? '').trim()
const lower = (v: unknown): string => String(v ?? '').trim().toLowerCase()

/** 收集 item 的候选邮箱集合（归一化小写、去空）。 */
export function candidateEmails(item: any): string[] {
  const set = new Set<string>()
  const push = (v: unknown) => { const e = lower(v); if (e) set.add(e) }
  push(item?.email)
  push(item?.selectedEmail)
  for (const c of list(item?.contacts)) push(c?.email)
  for (const log of list(item?.emailLogs)) push(log?.email || log?.recipientEmail || log?.to || log?.address)
  return [...set]
}

/** 从 formal_send_queue 记录构建"已 sent/scheduled"邮箱集合（迁移自 tools/formal_candidate_queue_v3_0806.mts）。 */
export function buildFormalSentEmailSet(formalSendRecords: any[]): Set<string> {
  const set = new Set<string>()
  for (const r of list(formalSendRecords)) {
    // 只统计 sent：scheduled=计划未发，不能当作已发送，否则 applyEligibilityStage 会把已排期客户误判 already_formally_sent → true_excluded。
    // 队列防重复由 preflight 的 RESEND_STATUSES（含 scheduled）负责，不受此集合影响。
    if (String(r?.sendQueueStatus) === 'sent') {
      const e = lower(r?.recipientEmail)
      if (e) set.add(e)
    }
  }
  return set
}

export function poolExclusionReason(item: any, ctx?: PoolEligibilityCtx): { reason: PoolExclusionReason; detail?: string } | null {
  if (!item || typeof item !== 'object') return null
  const any = item

  // 1. 聚合站/平台域名
  const website = clean(any.website) || clean(any.sourceUrl)
  if (isAggregatorDomain(website)) return { reason: 'aggregator_or_platform_domain', detail: website }

  const emails = candidateEmails(any)
  const selectedEmail = lower(any.selectedEmail || any.preferredEmail || any.email)

  // 2. 占位符邮箱
  const placeholderHit = emails.find(isPlaceholderEmail)
  if (placeholderHit) return { reason: 'placeholder_email', detail: placeholderHit }

  // 3. 已正式发信（自身历史只认 formal_outreach，或 ctx 命中"分身"邮箱）
  //    修复：7-11~7-20 测试信阶段 emailLogs.type 是 outreach/空/undefined，旧判定 `type!=='test_handshake'` 误把它们当正式发信；
  //    developmentStatus='sent' 在测试信流程也会被设置（350 条中仅 17 条有正式发信证据），不再单独成立。
  const formallySentSelf = list(any.emailLogs).some((x: any) => {
    if (x?.status !== 'sent' || x?.type !== 'formal_outreach') return false
    const recipient = lower(x?.email || x?.recipientEmail || x?.to || x?.address)
    return Boolean(selectedEmail && recipient && recipient === selectedEmail)
  })
  const formallySentDupEmail = selectedEmail
    ? (ctx?.formalSentEmails?.has(selectedEmail) ? selectedEmail : undefined)
    : emails.find(candidate => ctx?.formalSentEmails?.has(candidate))
  if (formallySentSelf) return { reason: 'already_formally_sent' }
  if (formallySentDupEmail) return { reason: 'already_formally_sent', detail: formallySentDupEmail }

  // 3.5 测试信明确退信（单一来源 testMailGate；只抑制退信的精确地址）
  const testVerdict = ctx?.testMailVerdicts?.get(String(any.id ?? ''))
  if (testVerdict?.state === 'bounced') {
    const addressVerdict = selectedEmail ? testVerdict.emailVerdicts?.[selectedEmail] : undefined
    const bouncedEmails = list(testVerdict.emails).map(lower)
    const legacyExactBounce = !testVerdict.emailVerdicts && selectedEmail && bouncedEmails.includes(selectedEmail)
    const legacyUnscopedBounce = !testVerdict.emailVerdicts && bouncedEmails.length === 0
    const allCandidatesBounced = !selectedEmail && emails.length > 0 && emails.every(address => bouncedEmails.includes(address))
    if (addressVerdict?.state === 'bounced' || legacyExactBounce || legacyUnscopedBounce || allCandidatesBounced) {
      return { reason: 'test_mail_bounced', detail: bouncedEmails.join(', ') || testVerdict.detail }
    }
  }

  // 4. 正式发信退信
  if (any.formalBounce === true && (!lower(any.bouncedEmail) || lower(any.bouncedEmail) === selectedEmail)) return { reason: 'formal_bounced' }

  // 5. 抑制/投诉/不开发
  if (any.doNotContactEmail === true || list(any.doNotContactEmails).length > 0 || any.reviewDisposition === 'do_not_develop') {
    return { reason: 'suppressed_or_complained' }
  }

  // 6. 非买家实体（排除类型来自当前 profile 的 nonBuyerCustomerTypes，default 与原 NON_BUYER_CUSTOMER_TYPES 一致）
  if (getActiveProfile().nonBuyerCustomerTypes.includes(lower(any.customerType)) || any.recommendedAction === 'true_excluded') {
    return { reason: 'non_buyer_entity', detail: String(any.customerType || any.recommendedAction) }
  }

  // 7. 双低价值
  if (lower(any.businessMatch) === 'low' && lower(any.importCommercialValue) === 'low') {
    return { reason: 'low_value' }
  }

  // 8. 无任何可触达邮箱
  if (emails.length === 0) return { reason: 'no_emailable_email' }

  return null
}
