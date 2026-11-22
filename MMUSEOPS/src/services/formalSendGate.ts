import { createHash } from 'node:crypto'
import {
  classifyEmailQuality,
  normalizeDomain,
  normalizeEmail,
  shouldBlockEmailBeforeDns,
} from './emailQualityPolicy'
import { assessOutboundRisk, hasTrustedSpecificEmailEvidence } from './outreachRisk'
import { OFFICIAL_OUTREACH_EMAIL } from './outreachIdentity'
import { furnitureChannelAllows } from './businessLinePolicy'
import {
  classifyContactRole,
  getCommunicationStrategy,
  type ContactRoleCategory,
  type CommunicationStrategy,
} from './contactRoleClassification'
import { contactMiningRoleClass } from './emailClassification'
import { deriveAddressVerificationState } from './emailCandidateView'

/**
 * 唯一正式发信门禁。所有正式发送入口（preflight / 审批 / 单发 / 批执行 / TOCTOU 复验）
 * 必须只读本函数，禁止各文件再自写一套门禁。
 *
 * 主公标准（2026-08-07）：没有硬拦规则。前期流程（搜索→背调→验证→开发池）筛完即合格，
 * 门禁只做机械防错。
 * 主公原则（2026-10-14）：扩大开发覆盖，任何客户名下已验证的业务邮箱（个人、部门、公众或分支邮箱）均可开发；
 * 明确非业务邮箱（noreply@/careers@ 等）仍硬拦。不进 blockers 的安全类保持 warnings。
 * 主公铁律（2026-08-21）：没验证过不能放行。email_not_verified 作为硬拦回补（仅首次正式发送，
 * 跟进豁免）——前端验证闸（leadStageEligibility）已收紧 approved 草稿 + 非 accepted 路由，
 * 本门禁兜底发送时刻最后一道验证。
 * 硬阻止 = 6 类机械/数据质量项 + 明确非业务邮箱 + email_not_verified：
 *   invalid_email_format / duplicate_email_in_batch / already_formally_sent
 *   / latest_bounce_or_suppression_or_complaint_or_dnc / recipient_identity_mismatch / sender_identity_mismatch
 *   / non_personal_role_email_requires_contact_mining / email_not_verified
 * public_email / non_personal_email / personal_contact_required
 * / contact_role_or_source_required / non_business_contact / manual_confirmation_required
 * 等安全类保持 warnings（manual_confirmation_required 改为可选人工确认：approvedAt 缺失仅提示）。
 * 纯函数：不写数据、不产生副作用、不 mutate 传入的 batchEmails/claimedKeys。
 */
export interface FormalSendGateInput {
  /** 客户记录 */
  item: any
  /** 待审草稿（manualEmailDrafts 中未发送的最新一条） */
  draft?: any
  /** formal_send_queue 记录（可选） */
  record?: any
  /** 本批已占用 normalizedEmail（去重；只读，调用方在放行后自行 add） */
  batchEmails?: Set<string>
  /** 本批已 claim 的 outboundKey（去重；只读） */
  claimedKeys?: Set<string>
  /** 评估时间（默认 now） */
  now?: Date
}

export interface FormalSendGateResult {
  canSend: boolean
  /** 硬阻止：机械/数据质量项 + 明确非业务邮箱 + email_not_verified */
  blockers: string[]
  /** 提示项（含已移除的安全类：email_not_verified / public_email / personal_contact_required 等），绝不进入 blockers */
  warnings: string[]
  /** 有 blocker → 指向下一步；无 blocker → 'ready_for_human_send_confirm' */
  recommendedAction: string
  /** 联系人职位角色分类（可选，向后兼容） */
  contactRoleCategory?: ContactRoleCategory
  /** 由此角色推导的正式开发沟通策略（可选，向后兼容） */
  communicationStrategy?: CommunicationStrategy
}

const list = (value: unknown): any[] => (Array.isArray(value) ? value : [])
const text = (value: unknown): string => String(value ?? '').trim()
const lower = (value: unknown): string => text(value).toLowerCase()

// 跟进信队列记录识别（followup-auto-consumer 入队）：campaignId 恒定 + id/draftId 前缀 + draft 标记三路印证。
// 跟进信豁免 already_formally_sent（跟进对象必然已发过主信，该 gate 只对"首发去重"有意义），其它 gate 一律保留。
const FOLLOWUP_CAMPAIGN = 'followup-auto-consumer'
function isFollowupContext(record: any, draft: any): boolean {
  if (record?.campaignId === FOLLOWUP_CAMPAIGN) return true
  if (/^queue-followup-/.test(text(record?.id))) return true
  if (/^auto-followup-/.test(text(record?.draftId))) return true
  if (draft?.followup === true || text(draft?.campaignKey) === FOLLOWUP_CAMPAIGN || lower(draft?.type) === 'followup') return true
  return false
}

function hasExactFormalSend(item: any, selectedEmail: string): boolean {
  const selected = lower(selectedEmail)
  return Boolean(selected) && list(item?.emailLogs).some(log => {
    if (log?.status !== 'sent' || !['formal_outreach', 'formal'].includes(lower(log?.type))) return false
    const recipient = lower(log?.recipientEmail || log?.to || log?.email || log?.address)
    return Boolean(recipient) && recipient === selected
  })
}

// 企业级去重补充：该收件邮箱最近一次正式发送（含开发/跟进）距今是否 <= withinMs。
// 跟进信此前完全豁免 already_formally_sent，导致同一客户/邮箱在短期内被反复排期跟进。
// 这里对跟进信也施加一个“近期已发则拦截”的时间窗，避免频繁重复打扰；超过窗口视为新一轮可跟进。
const RECENT_FOLLOWUP_GAP_MS = 21 * 24 * 60 * 60 * 1000
function hasRecentFormalSend(item: any, selectedEmail: string, withinMs = RECENT_FOLLOWUP_GAP_MS, now?: Date): boolean {
  const selected = lower(selectedEmail)
  if (!selected) return false
  let latest = 0
  for (const log of list(item?.emailLogs)) {
    if (log?.status !== 'sent' || !['formal_outreach', 'formal'].includes(lower(log?.type))) continue
    const recipient = lower(log?.recipientEmail || log?.to || log?.email || log?.address)
    if (recipient !== selected) continue
    const ts = Date.parse(String(log?.sentAt || log?.date || log?.createdAt || ''))
    if (Number.isFinite(ts) && ts > latest) latest = ts
  }
  return latest > 0 && ((now ? now.getTime() : Date.now()) - latest) <= withinMs
}

// 主公标准 v2：邮箱类型 / 个人身份不再是硬拦，仅用于 warning 提示（部门/公众邮箱可达公司内部即可发，前期流程已过滤）。
const GENERIC_NAME = /^(team|customer\s*service|sales\s*team|support\s*team|info|sales|admin|office|contact|hello|general|enquir(y|ies)|management|manager|none|n\/a|unknown|someone|buyer|purchasing|procurement|ffe)$/i
function personalIdentity(item: any, contacts: any[]) {
  const names: string[] = []
  const roles: string[] = []
  const sources: string[] = []
  const push = (name: string, role: string, source: string) => {
    if (name && !GENERIC_NAME.test(name)) names.push(name)
    if (role) roles.push(role)
    if (source) sources.push(source)
  }
  push(
    text(item?.contactName),
    text(item?.contactTitle || item?.jobTitle || item?.contactRole),
    text(item?.contactSource || item?.contactSourceUrl || item?.evidenceUrl),
  )
  for (const c of contacts) push(text(c?.name), text(c?.title), text(c?.source || c?.sourceUrl || c?.evidenceUrl))
  return { name: names[0] || '', role: roles[0] || '', source: sources[0] || '' }
}

function selectedEmailOf(item: any, draft: any, record: any): string {
  return (
    normalizeEmail(record?.recipientEmail)
    || normalizeEmail(draft?.to)
    || normalizeEmail(item?.selectedEmail)
    || normalizeEmail(item?.email)
  )
}

function isCodexOfficialForwardingRequest(item: any, draft: any, record: any, selected: string, evidence: any[]): boolean {
  const selectedLower = lower(selected)
  const localPart = selectedLower.split('@')[0] || ''
  const emailDomain = selectedLower.split('@')[1] || ''
  const companyDomain = normalizeDomain(item?.canonicalDomain || item?.domain || item?.website)
  const supervised = record?.formalSupervisedOnly === true
    && record?.supervisedBy === 'Codex'
    && Boolean(Date.parse(text(record?.supervisedAt)))
    && draft?.officialForwardingRequest === true
    && record?.officialForwardingRequest === true
    && draft?.supervisedBy === 'Codex'
    && Boolean(Date.parse(text(draft?.supervisedAt)))
  const forwardingCopy = /\b(forward|direct|route|pass)\b/i.test(`${text(draft?.subject)} ${text(draft?.body)}`)
  const approvedPublicInbox = /^(info|contact|hello|office)$/.test(localPart)
  const officialEvidence = evidence.some((entry: any) =>
    lower(entry?.email || entry?.recipientEmail) === selectedLower
    && lower(entry?.source) === 'official_website'
    && lower(entry?.result) === 'official_public_email_confirmed'
    && normalizeDomain(entry?.evidenceUrl) === companyDomain)
  const deliveredEvidence = evidence.some((entry: any) =>
    lower(entry?.email || entry?.recipientEmail) === selectedLower
    && /delivered|no_bounce_observed|reply_observed|smtp_handshake_pass|specific_email_verified/.test(lower(entry?.result || entry?.status)))
  return Boolean(
    supervised
    && forwardingCopy
    && approvedPublicInbox
    && companyDomain
    && emailDomain === companyDomain
    && officialEvidence
    && deliveredEvidence
    && !hasExactFormalSend(item, selected),
  )
}

function formalOutboundKey(record: any): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(['formal-outbound-v1', record?.campaignId, record?.customerId, record?.draftId]))
    .digest('hex')
  return `formal:v1:${digest}`
}

function timezoneUnknown(item: any): boolean {
  if (text(item?.timezone)) return false
  const country = lower(item?.country)
  if (/united kingdom|\buk\b|england|china|中国/.test(country)) return false
  if (/united states|\busa\b|australia/.test(country)) return true
  return !country || /unknown/.test(country)
}

function recommendedActionFor(blocker: string): string {
  switch (blocker) {
    case 'duplicate_email_in_batch':
      return 'remove_duplicate'
    case 'invalid_email_format':
      return 'fix_email_format'
    case 'already_formally_sent':
    case 'latest_bounce_or_suppression_or_complaint_or_dnc':
      return 'replace_contact'
    case 'recipient_identity_mismatch':
    case 'sender_identity_mismatch':
      return 'reapprove'
    case 'non_personal_role_email_requires_contact_mining':
      return 'contact_mining'
    case 'email_not_verified':
      return 'verify_email'
    case 'business_line_mismatch':
      return 'reapprove'
    default:
      return 'reapprove'
  }
}

export function canSendFormalOutreach(input: FormalSendGateInput): FormalSendGateResult {
  const { item, draft, record } = input
  const now = input.now || new Date()
  const blockers: string[] = []
  const warnings: string[] = []
  const selected = selectedEmailOf(item, draft, record)
  const selectedLower = lower(selected)
  const followupContext = isFollowupContext(record, draft)
  const evidence = list(item?.emailVerificationEvidence)
  const officialForwardingRequest = isCodexOfficialForwardingRequest(item, draft, record, selected, evidence)
  const contacts = list(item?.contacts)
  const contact = contacts.find((c: any) => lower(c?.email) === selectedLower) || {}

  // #1 manual_confirmation_required —— 可选人工确认：approvedAt 缺失仅 warning，不阻塞（主公授权"不用审核"即跳过）
  if (record) {
    if (!record.approvedAt) warnings.push('manual_confirmation_required')
    else if (draft && draft.sent !== true && draft.status !== 'approved') warnings.push('manual_confirmation_required')
  } else if (draft && draft.manualRiskConfirmed !== true) {
    warnings.push('manual_confirmation_required')
  }

  // #2 already_formally_sent —— 企业级去重（按同一收件邮箱 + 近期发送时间）。
  //     首发（非跟进）：该邮箱已发过正式邮件即拦截，防止重复开发。
  //     跟进：此前完全豁免导致同一客户/邮箱短期内反复跟进。现改为：若该邮箱最近 21 天内已发过
  //     正式邮件（含跟进），也拦截，避免频繁重复打扰；超过 21 天视为新一轮跟进可发。
  //     官方转交请求（officialForwardingRequest）不受此限（属单次求助转交）。
  const recentSent = hasRecentFormalSend(item, selected, RECENT_FOLLOWUP_GAP_MS, now)
  if (!officialForwardingRequest
    && (isFollowupContext(record, draft)
      ? recentSent
      : (draft?.sent === true || hasExactFormalSend(item, selected)))) {
    blockers.push(isFollowupContext(record, draft) && recentSent ? 'too_frequent_followup' : 'already_formally_sent')
  }

  // #3 latest_bounce_or_suppression_or_complaint_or_dnc —— 唯一数据源 assessOutboundRisk
  const risk = assessOutboundRisk(item, selected)
  if (risk.blockedEmail || risk.doNotContact) {
    blockers.push('latest_bounce_or_suppression_or_complaint_or_dnc')
  }

  // #4 duplicate_email_in_batch —— 本批内 normalizedEmail / outboundKey 重复
  const normalized = normalizeEmail(selected)
  const key = record ? formalOutboundKey(record) : ''
  const emailClaimed = Boolean(normalized && input.batchEmails?.has(normalized))
  const keyClaimed = Boolean(record && key && input.claimedKeys?.has(key))
  if (emailClaimed || keyClaimed) {
    blockers.push('duplicate_email_in_batch')
  }

  // #5 invalid_email_format —— 唯一 format 判定 shouldBlockEmailBeforeDns
  const format = shouldBlockEmailBeforeDns({ email: selected })
  if (format.blocked) {
    blockers.push('invalid_email_format')
  }

  // #6 邮箱类型 —— 个人/免费/部门/公众/分支角色地址均按 warning 提示；明确非业务邮箱仍硬拦。
  const quality = classifyEmailQuality({
    email: selected,
    canonicalDomain: normalizeDomain(item?.canonicalDomain || item?.domain || item?.website),
    contactName: contact?.name,
    title: contact?.title,
    source: contact?.source,
    evidenceUrl: contact?.sourceUrl || contact?.evidenceUrl,
    priorResults: evidence
      .filter((e: any) => lower(e?.email || e?.recipientEmail) === selectedLower)
      .flatMap((e: any) => [e?.result, e?.status, e?.recoveryStatus, e?.webhookEventType])
      .filter(Boolean)
      .map(String),
  })
  // #7 个人身份提取（仅用于 warning 提示）：姓名 + 角色或来源
  const identity = personalIdentity(item, contacts)
  const hasPersonalIdentity = Boolean(identity.name)

  if (quality.emailType === 'public') warnings.push('public_email')
  else if (quality.emailType === 'department' || quality.emailType === 'location') warnings.push('non_personal_email')
  else if ((quality.emailType === 'guessed' || quality.emailType === 'free_unconfirmed') && !hasPersonalIdentity) {
    warnings.push('non_personal_email')
  } else if (quality.emailType === 'guessed' || quality.emailType === 'free_unconfirmed') {
    warnings.push('candidate_email_not_personal_type')
  }

  // #6b 仅明确非业务邮箱（noreply/hr/careers/abuse 等）硬拦；已验证的 info@/sales@/分支邮箱不阻断开发。
  const roleClass = contactMiningRoleClass(selected)
  if (roleClass === 'nonbusiness') {
    blockers.push('non_personal_role_email_requires_contact_mining')
  }
  if (officialForwardingRequest) warnings.push('codex_supervised_official_forwarding_request')

  // #6c 业务线不匹配（2026-08-11 主公指正）：家具发信身份不得向 car-seat 客户发送
  if (!furnitureChannelAllows(item)) blockers.push('business_line_mismatch')

  // #7 personal_contact_required —— 部门邮箱不要求个人姓名，仅 warning 提示
  if (!identity.name) warnings.push('personal_contact_required')
  else if (!identity.role && !identity.source) warnings.push('contact_role_or_source_required')

  // 联系人角色分类：non_business 仅提示（前期已筛），unclear 仅提示
  const roleCategory = classifyContactRole(identity.role || text(contact?.title))
  if (roleCategory === 'non_business') warnings.push('non_business_contact')
  else if (roleCategory === 'unclear') warnings.push('contact_role_unclear')
  const communicationStrategy = getCommunicationStrategy(roleCategory)

  if (followupContext && !hasExactFormalSend(item, selected)) blockers.push('followup_without_exact_formal_send')
  if (!OFFICIAL_OUTREACH_EMAIL) blockers.push('sender_not_configured')
  if (draft?.senderEmail && lower(draft.senderEmail) !== lower(OFFICIAL_OUTREACH_EMAIL)) blockers.push('sender_identity_mismatch')
  if (draft?.replyToEmail && lower(draft.replyToEmail) !== lower(OFFICIAL_OUTREACH_EMAIL)) blockers.push('sender_identity_mismatch')

  // 机械完整性 1 —— queue recipient 与草稿收件人必须一致；selectedEmail 可能是陈旧 CRM 字段，
  // 不作为当前地址的身份凭据。当前地址的公司归属/验证由上面的 exact-address evidence gate 判定。
  const recordRecipient = lower(record?.recipientEmail)
  const draftRecipient = lower(draft?.to)
  const recipientConsistent = record
    ? Boolean(recordRecipient && draftRecipient && recordRecipient === draftRecipient)
    : Boolean(draftRecipient)
  if (!recipientConsistent || lower(item?.selectedEmail) !== draftRecipient) blockers.push('recipient_identity_mismatch')

  // 机械完整性 2 —— sender_identity_mismatch（防发错账号；用常量统一）
  if (
    record
    && (lower(record.senderEmail) !== lower(OFFICIAL_OUTREACH_EMAIL)
      || lower(record.replyToEmail) !== lower(OFFICIAL_OUTREACH_EMAIL))
  ) {
    blockers.push('sender_identity_mismatch')
  }

  // ---------- warnings（15 项，输出但绝不进入 blockers） ----------
  const specificVerified = hasTrustedSpecificEmailEvidence(item, selected)
  const testEvidence = evidence
    .filter((e: any) => lower(e?.email || e?.recipientEmail) === selectedLower
      && /test_sent|watching|delivered/.test(lower(e?.result || e?.status || '')))
    .sort((a: any, b: any) => Date.parse(b?.checkedAt || b?.sentAt || '') - Date.parse(a?.checkedAt || a?.sentAt || ''))
  const latestTest = testEvidence[0]
  if (latestTest) {
    const ends = Date.parse(latestTest.observationWindowEndsAt || latestTest.observationEndedAt || '')
    if (!Number.isFinite(ends) || ends > now.getTime()) warnings.push('test_observation_not_72h')
    if (/watching|delivered/.test(lower(latestTest.recoveryStatus || latestTest.result || latestTest.status || ''))) {
      warnings.push('test_status_watching_or_delivered')
    }
  }
  const gaps = [...list(item?.evidenceGaps), ...list(item?.evidenceGap), ...list(item?.missingEvidence)].map(text).filter(Boolean)
  const summary = text(item?.evidenceSummary || item?.stageEvidenceSummary || item?.backCheck?.summary)
  if (gaps.length || summary.length < 40) warnings.push('evidence_gap')
  if (!specificVerified) warnings.push('specific_email_not_verified')
  if (!text(contact?.title || item?.contactTitle || item?.jobTitle)) warnings.push('contact_title_unknown')
  if (lower(item?.businessMatch) === 'medium') warnings.push('business_match_medium')
  if (lower(item?.importCommercialValue) === 'medium') warnings.push('commercial_value_medium')
  if (timezoneUnknown(item)) warnings.push('timezone_unknown')
  const dnsPassed = evidence.some((e: any) =>
    lower(e?.email || e?.recipientEmail) === selectedLower
    && /specific_email_verified|smtp_handshake_pass|domain_mx_pass|dns_mx_ok/.test(lower(e?.result || e?.status || '')))
  if (!dnsPassed) warnings.push('spf_dkim_dmarc_not_checked')
  if (contacts.filter((c: any) => lower(c?.email)).length >= 2) warnings.push('same_company_multiple_contacts')
  if (/snovio/.test(lower(contact?.source || item?.sourceType || item?.source || ''))) warnings.push('snovio_source')
  if (quality.emailType === 'department') warnings.push('department_email')
  if (!quality.domainMatchesCompany && (text(contact?.sourceUrl || contact?.evidenceUrl) || text(contact?.source))) {
    warnings.push('email_domain_partial_mismatch_with_evidence')
  }
  if (evidence.some((e: any) => lower(e?.email || e?.recipientEmail) === selectedLower
    && lower(e?.result || e?.status) === 'reply_observed'
    && (/isolated_test_mail/.test(lower(e?.method || e?.source || '')) || lower(e?.scope) === 'delivery'))) {
    warnings.push('test_mail_replied')
  }
  if (list(item?.leadScoreReasons).length === 0 && !item?.leadScore && list(item?.timeline).length === 0) {
    warnings.push('historical_tags_incomplete')
  }

  const recommendedAction = blockers.length ? recommendedActionFor(blockers[0]) : 'ready_for_human_send_confirm'
  return {
    canSend: blockers.length === 0,
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)],
    recommendedAction,
    contactRoleCategory: roleCategory,
    communicationStrategy,
  }
}
