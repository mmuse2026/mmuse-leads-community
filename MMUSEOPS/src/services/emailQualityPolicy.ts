// 复用 poolEligibility 的占位符判定（PLACEHOLDER 词库 / 占位域名 / 占位全邮箱）。
// 只 import 不修改：poolEligibility.ts 归其他子代理维护。
import { poolExclusionReason } from './poolEligibility'
import {
  FREE_DOMAINS, PLACEHOLDER_LOCAL_PARTS, classifyRoleLocalPart, contactMiningRoleClass, isPlaceholderEmail,
} from './emailClassification'

export type EmailQualityTier = 'A' | 'B' | 'C' | 'D' | 'E'
export type EmailType =
  | 'personal_company'
  | 'department'
  | 'public'
  | 'location'
  | 'free_business'
  | 'free_unconfirmed'
  | 'guessed'
  | 'placeholder'
  | 'invalid'

export interface EmailQualityInput {
  email: string
  canonicalDomain?: string
  contactName?: string
  title?: string
  source?: string
  evidenceUrl?: string
  dnsResult?: string
  priorResults?: string[]
  domainMatchesCompany?: boolean
}

export interface EmailBlockDecision {
  blocked: boolean
  reason?: string
}

export interface EmailQualityDecision {
  normalizedEmail: string
  emailType: EmailType
  tier: EmailQualityTier
  domainMatchesCompany: boolean
  riskLevel: 'low' | 'medium' | 'high' | 'blocked'
  blockedReasons: string[]
  riskReasons: string[]
}

const format = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const freeDomains = FREE_DOMAINS
const placeholderLocals = PLACEHOLDER_LOCAL_PARTS
// 邮箱类型只用于风险提示与分类；官网公开的公司业务邮箱同样可以承接合作转交请求。
const bouncedOrFailedHistory = /bounced|failed/
const suppressedOrDncHistory = /suppressed|complained|do_not_contact/
const trustedCompanySources = new Set(['website', 'official_website', 'company_website', 'official_contact_page'])

export function normalizeEmail(value: unknown): string {
  return String(value || '').trim().toLowerCase()
}

export function normalizeDomain(value: unknown): string {
  const raw = String(value || '').trim().toLowerCase()
  if (!raw) return ''
  try {
    const host = new URL(raw.includes('://') ? raw : `https://${raw}`).hostname
    return host.replace(/^www\./, '').replace(/\.$/, '')
  } catch {
    return raw.replace(/^www\./, '').replace(/\.$/, '')
  }
}

function domainMatches(emailDomain: string, canonicalDomain: string): boolean {
  if (!emailDomain || !canonicalDomain) return false
  return emailDomain === canonicalDomain
    || emailDomain.endsWith(`.${canonicalDomain}`)
    || canonicalDomain.endsWith(`.${emailDomain}`)
}

export function shouldBlockEmailBeforeDns(input: EmailQualityInput): EmailBlockDecision {
  const raw = String(input.email || '')
  const email = normalizeEmail(raw)
  if (/[\u0000-\u001f\u007f]/.test(raw)) return { blocked: true, reason: 'control_character_contamination' }
  if (/%[0-9a-f]{2}/i.test(email)) return { blocked: true, reason: 'percent_encoded_contamination' }
  if (/https?:\/\/|[\\/?#=]/i.test(email)) return { blocked: true, reason: 'url_fragment_contamination' }
  if (!format.test(email)) return { blocked: true, reason: 'invalid_format' }
  const [local, domain] = email.split('@')
  if (email === 'john@doe.com') return { blocked: true, reason: 'known_example_address' }
  if (placeholderLocals.has(local) || /^x{2,}$/i.test(local) || /^(?:first|last|name)(?:[\s_\-.]*(?:first|last|name))+$/i.test(local)) {
    return { blocked: true, reason: 'placeholder_local_part' }
  }
  if (/^\d+$/.test(local)) return { blocked: true, reason: 'numeric_local_part' }
  if (/^\d{2,}(sales|info|contact|support|admin|office)$/i.test(local)) {
    return { blocked: true, reason: 'numeric_department_pollution' }
  }

  if (!domain || domain === 'example.com' || domain === 'doe.com') {
    return { blocked: true, reason: 'example_or_missing_domain' }
  }
  return { blocked: false }
}

export function classifyEmailQuality(input: EmailQualityInput): EmailQualityDecision {
  const normalizedEmail = normalizeEmail(input.email)
  const history = (input.priorResults || []).join(' ').toLowerCase()
  const riskReasons = [
    ...(suppressedOrDncHistory.test(history) ? ['address_suppressed_or_complained'] : []),
    ...(bouncedOrFailedHistory.test(history) ? ['address_bounced_or_failed'] : []),
  ]
  const blocked = shouldBlockEmailBeforeDns({ ...input, priorResults: [] })
  if (blocked.blocked) {
    return {
      normalizedEmail,
      emailType: format.test(normalizedEmail) ? 'placeholder' : 'invalid',
      tier: 'E',
      domainMatchesCompany: false,
      riskLevel: 'blocked',
      blockedReasons: [blocked.reason || 'blocked'],
      riskReasons,
    }
  }
  const [local, emailDomain] = normalizedEmail.split('@')
  const canonicalDomain = normalizeDomain(input.canonicalDomain)
  const matches = input.domainMatchesCompany ?? domainMatches(emailDomain, canonicalDomain)
  const source = String(input.source || '').toLowerCase()
  const isFree = freeDomains.has(emailDomain)
  const roleClass = classifyRoleLocalPart(local)
  const isDepartment = roleClass === 'department'
  const isPublic = roleClass === 'public'
  const isLocation = roleClass === 'location'
  const sourceIsCompanyControlled = trustedCompanySources.has(source.trim())
  const evidenceDomain = normalizeDomain(input.evidenceUrl)
  const evidenceMatchesCompany = Boolean(canonicalDomain && evidenceDomain && domainMatches(evidenceDomain, canonicalDomain))
  const isSourcedFreeBusiness = isFree && sourceIsCompanyControlled && evidenceMatchesCompany
  const suspiciousAddress = /\.(?:png|jpe?g|gif|webp|svg|ico)(?:$|@)/i.test(normalizedEmail)
    || /(?:^|[-_.])(?:cropped|logo|image|thumbnail)(?:[-_.]|$)/i.test(local)
    || local.length > 64
    || /^[a-z0-9]{40,}$/i.test(local)
  if (suspiciousAddress) {
    return {
      normalizedEmail,
      emailType: isFree ? 'free_unconfirmed' : 'personal_company',
      tier: 'C',
      domainMatchesCompany: matches,
      riskLevel: riskReasons.length ? 'blocked' : 'medium',
      blockedReasons: [],
      riskReasons: [...riskReasons, 'address_shape_unusual_check_exact_verification'],
    }
  }
  const isNonBusiness = roleClass === 'nonbusiness'
  if (isNonBusiness) {
    return {
      normalizedEmail,
      emailType: matches ? 'public' : 'guessed',
      tier: 'D',
      domainMatchesCompany: matches,
      riskLevel: 'high',
      blockedReasons: ['non_business_role_address'],
      riskReasons: [],
    }
  }
  if (isSourcedFreeBusiness) {
    return {
      normalizedEmail,
      emailType: 'free_business',
      tier: 'C',
      domainMatchesCompany: false,
      riskLevel: riskReasons.length ? 'blocked' : 'medium',
      blockedReasons: [],
      riskReasons: [...riskReasons, ...(!matches ? ['email_domain_differs_from_company_website'] : [])],
    }
  }
  if (isFree) {
    return {
      normalizedEmail,
      emailType: 'free_unconfirmed',
      tier: 'C',
      domainMatchesCompany: matches,
      riskLevel: riskReasons.length ? 'blocked' : 'medium',
      blockedReasons: [],
      riskReasons: [...riskReasons, 'free_mailbox', ...(!matches ? ['email_domain_differs_from_company_website'] : [])],
    }
  }
  // 非个人邮箱（public/department/location）即使域名不匹配也不降级为 guessed，
  // 保持 non-personal 类型供下游拦截，避免绕过 contact_mining 门禁。
  if (isDepartment || isPublic || isLocation) {
    return {
      normalizedEmail,
      emailType: isLocation ? 'location' : (isDepartment ? 'department' : 'public'),
      tier: 'B',
      domainMatchesCompany: matches,
      riskLevel: matches ? (riskReasons.length ? 'blocked' : 'low') : 'medium',
      blockedReasons: [],
      riskReasons,
    }
  }
  if (canonicalDomain && !matches) {
    return {
      normalizedEmail,
      emailType: isFree ? 'free_unconfirmed' : 'personal_company',
      tier: 'C',
      domainMatchesCompany: false,
      riskLevel: riskReasons.length ? 'blocked' : 'medium',
      blockedReasons: [],
      riskReasons: [...riskReasons, 'email_domain_differs_from_company_website'],
    }
  }
  if (source.includes('snovio') && matches) {
    return {
      normalizedEmail,
      emailType: 'personal_company',
      tier: 'C',
      domainMatchesCompany: true,
      riskLevel: riskReasons.length ? 'blocked' : 'medium',
      blockedReasons: ['candidate_missing_public_contact_evidence'],
      riskReasons,
    }
  }
  if (matches && input.contactName && input.title && input.evidenceUrl) {
    return {
      normalizedEmail,
      emailType: 'personal_company',
      tier: 'A',
      domainMatchesCompany: true,
      riskLevel: riskReasons.length ? 'blocked' : 'low',
      blockedReasons: [],
      riskReasons,
    }
  }
  return {
    normalizedEmail,
    emailType: isFree ? 'free_unconfirmed' : 'personal_company',
    tier: 'C',
    domainMatchesCompany: matches,
    riskLevel: riskReasons.length ? 'blocked' : 'medium',
    blockedReasons: [],
    riskReasons: [...riskReasons, 'optional_contact_profile_incomplete'],
  }
}

export function shouldEnterDnsQueue(input: EmailQualityInput) {
  const quality = classifyEmailQuality(input)
  return {
    allowed: ['A', 'B', 'C'].includes(quality.tier) && quality.riskLevel !== 'blocked',
    quality,
    blockedReasons: [...quality.blockedReasons, ...quality.riskReasons],
  }
}

export function shouldEnterTestMailQueue(input: EmailQualityInput) {
  const dns = shouldEnterDnsQueue(input)
  const mxPass = input.dnsResult === 'domain_mx_pass' || input.dnsResult === 'dns_mx_ok'
  const duplicateOrFinal = (input.priorResults || []).some(result =>
    /watching|test_sent|no_bounce_observed|reply_observed|bounced|failed|suppressed|complained/i.test(result),
  )
  // 已验证的公司公共/部门/地点邮箱均可进入测试；仅明确非业务地址（如 noreply/hr/careers）阻断。
  const isRole = contactMiningRoleClass(input.email) === 'nonbusiness'
  const blockedReasons = [
    ...dns.blockedReasons,
    ...(!mxPass ? ['domain_mx_not_passed'] : []),
    ...(duplicateOrFinal ? ['prior_test_or_terminal_result'] : []),
    ...(isRole ? ['non_personal_role_email_requires_contact_mining'] : []),
  ]
  return {
    allowed: dns.allowed && mxPass && !duplicateOrFinal && !isRole,
    quality: dns.quality,
    blockedReasons,
  }
}

// ---------------------------------------------------------------------------
// 三级处理（主公标准 2026-08-09 收敛，与 emailClassification 统一）：
// 个人邮箱（真实人名 local）→ 直接验证；
// 角色邮箱（public/department/location/nonbusiness 共享邮箱）→ 发信没效果，挖联系人；
// 占位符邮箱 → 一律拦截。
// ---------------------------------------------------------------------------
export type EmailHandlingTier = 'personal' | 'department' | 'public' | 'needs_review'

export function emailHandlingTier(input: EmailQualityInput): EmailHandlingTier {
  const type = classifyEmailQuality(input).emailType
  switch (type) {
    case 'personal_company': return 'personal'
    case 'department': return 'department'
    case 'public': return 'public'
    case 'location': return 'public'
    default: return 'needs_review'
  }
}

/** Public/department mailbox classification is informational; it must not by itself block a verified business inquiry. */
export function needsContactMining(input: EmailQualityInput): boolean {
  return contactMiningRoleClass(input.email) !== null
}

export interface VerificationEntryDecision {
  allowed: boolean
  action: 'verify' | 'mine_contacts' | 'route_backcheck' | 'isolate_placeholder' | 'blocked'
  reasons: string[]
}

/**
 * 验证入口：占位符隔离 → 已有官网和业务匹配进入验证。
 * 不把国家、摘要字数、进口价值标签或公共邮箱角色当成额外准入门槛。
 * itemOrEmail 可传完整 item（推荐）或 { email } 最小结构。
 */
export function verificationEntryCheck(itemOrEmail: unknown): VerificationEntryDecision {
  const item = (itemOrEmail && typeof itemOrEmail === 'object' ? itemOrEmail : { email: String(itemOrEmail || '') }) as Record<string, any>
  const exclusion = poolExclusionReason(item as any)
  if (exclusion?.reason === 'placeholder_email') {
    return { allowed: false, action: 'isolate_placeholder', reasons: [`placeholder_email${exclusion.detail ? `: ${exclusion.detail}` : ''}`] }
  }

  // 已有官网 + 明确业务匹配即满足进入邮箱验证的业务条件；其他字段仅作补充信息。
  const website = String(item.website || item.sourceUrl || item.canonicalDomain || '').trim()
  const business = String(item.businessMatch || '').trim().toLowerCase()
  const backcheckOk = Boolean(website && ['high', 'medium'].includes(business))
  if (!backcheckOk) return { allowed: false, action: 'route_backcheck', reasons: ['website_or_business_fit_missing'] }

  // info@/sales@/contact@ 等真实公司邮箱可用于业务合作请求；无需先挖到个人联系人。
  return { allowed: true, action: 'verify', reasons: [] }
}
