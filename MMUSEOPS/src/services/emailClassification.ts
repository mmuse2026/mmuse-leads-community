/**
 * 统一邮箱 local-part 分类（主公标准，2026-08-09 收敛）。
 *
 * 单一事实来源：前端（emailQualityPolicy / testMailCandidatePolicy / poolEligibility）
 * 与后端门禁（queue-runtime.enqueueDnsOutcome / queue-executors.executeDueTestMailRecords）
 * 共用本模块的 PUBLIC/DEPARTMENT/LOCATION/NONBUSINESS/PLACEHOLDER 判定，避免两套标准导致数据分桶不一致。
 *
 * 处理口径：
 *   个人邮箱（真实人名 local part）→ 直接验证；
 *   公众/地名/非业务邮箱（public/location/nonbusiness，如 info@/sales@/sydney@/hr@）→
 *     发测试信没效果，不进测试信/待验证，回联系人挖掘去挖个人邮箱；
 *   部门邮箱（department，如 purchasing@/buyer@/export@）→ 放行验证，验证通过可发开发信（主公 2026-08-09）；
 *   占位符邮箱（test@/example@/noreply@/纯数字等假邮箱）→ 一律拦截。
 *
 * 2026-08-09 门禁补漏：扩充常见角色词库（press/webmaster/marketing/pr/media/mailbox/
 * postmaster/desk/switchboard/customer/contract 单数/darlingharbour 等地名），并对带 . - _
 * 的复合 local（info-apac@/customer.services@）按"拆段精确命中角色词库"判定为角色，
 * 首段是常见人名时跳过，避免误伤个人邮箱。
 */

export const PUBLIC_LOCALS =
  /^(info|contact|hello|office|service|sales|customer|admin|support|enquiry|enquiries|questions|team|customerservice|accounts|bookings?|reception|reservations?|helpdesk|general|press|pr|media|mailbox|postmaster|desk|switchboard)$/
export const DEPARTMENT_LOCALS =
  /^(procurement|purchasing|buyer|buyers|projects?|operations|sourcing|ffe|ffande|contracts|contract|wholesale|bids?|orders?|accounting|finance|export|import|shipping|logistics|marketing|webmaster)$/
export const LOCATION_LOCALS =
  /^(sydney|melbourne|brisbane|perth|adelaide|canberra|darwin|hobart|newcastle|goldcoast|london|manchester|dubai|riyadh|jeddah|doha|kuwait|paris|berlin|munich|madrid|barcelona|milan|rome|toronto|vancouver|montreal|calgary|newyork|losangeles|chicago|houston|dallas|miami|seattle|denver|boston|sanfrancisco|darlingharbour|branch|store|hq|head|regional|retail|online|warehouse|factory|showroom|headoffice)$/
export const NONBUSINESS_LOCALS =
  /^(legal|jobs|careers|hr|hrm|returns|noreply|no-reply|privacy|abuse)$/

// These inboxes handle service, reception or bookings, not furniture purchasing.
// Keep broad business inboxes such as info@ and sales@ outside this rule.
const SERVICE_ONLY_LOCAL = /^(?:customer[._-]?services?|customer[._-]?support|customer[._-]?care|customer[._-]?relations?|front[._-]?desk|front[._-]?office|reception|receptionist|reservations?|bookings?|rsvn|foh|host|guest[._-]?services?|guest[._-]?relations?|concierge)(?:[._+-].+|\d+)?$/

export const FREE_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
  'yahoo.com', 'icloud.com', 'sohu.com', 'qq.com', '163.com',
])

/** 占位符 local-part 词库（@ 前去除 ._-数字 后比对，口径同 poolEligibility）。
 *  = emailQualityPolicy ∪ testMailCandidatePolicy ∪ poolEligibility + user/mail 补强。 */
export const PLACEHOLDER_LOCAL_PARTS: ReadonlySet<string> = new Set([
  'xxxx', 'test', 'example', 'demo', 'sample', 'unknown', 'noemail', 'email',
  'yourname', 'name', 'noreply', 'no-reply', 'dummy', 'placeholder', 'someone',
  'tbd', 'real', 'your_email', 'fullname', 'full_name', 'user_name', 'username',
  'whoever', 'recipient', 'user', 'mail',
])

export const PLACEHOLDER_DOMAINS = new Set(['example.com', 'test.com', 'mailinator.com', 'placeholder.com'])
export const PLACEHOLDER_FULL_EMAILS = new Set(['john@doe.com', 'jane@doe.com'])

export type RoleLocalClass = 'public' | 'department' | 'location' | 'nonbusiness'

const EMAIL_FORMAT = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export function normalizeEmail(value: unknown): string {
  return String(value || '').trim().toLowerCase()
}

/** 复合 local 分隔符（点、下划线、连字符）。 */
const COMPOUND_SEPARATOR = /[._-]+/

/** 常见人名（作为复合 local 首段时不判角色，避免误伤 john.smith / m.hamed 等个人邮箱）。 */
export const COMMON_FIRST_NAMES: ReadonlySet<string> = new Set([
  'john','jane','peter','paul','mary','mike','michael','david','james','robert','mark',
  'lisa','sarah','karen','emma','ann','anne','susan','tom','thomas','dan','daniel',
  'chris','christopher','alex','alan','adam','andrew','ben','brian','kevin','george',
  'charles','william','richard','joseph','joshua','steve','steven','phil','philip','bob',
  'bill','jack','sam','nick','nicholas','matt','matthew','ryan','jason','eric','justin',
  'scott','brandon','kyle','ethan','taylor','ashley','jessica','amanda','melissa','laura',
  'amy','angela','rebecca','michelle','kimberly','heather','rachel','hannah','olivia',
  'sophia','liam','noah','logan','lucas','jackson','aiden','caleb','sean','shane','patrick',
  'timothy','todd','gary','larry','carl','dennis','frank','jose','henry','aaron','adrian',
  'victor','tony','rob','rod','roy','randy','terry','wayne','douglas','bruce','keith','craig',
])

function classifyExactRoleLocalPart(local: string): RoleLocalClass | null {
  if (PUBLIC_LOCALS.test(local)) return 'public'
  if (DEPARTMENT_LOCALS.test(local)) return 'department'
  if (LOCATION_LOCALS.test(local)) return 'location'
  if (NONBUSINESS_LOCALS.test(local)) return 'nonbusiness'
  return null
}

export function classifyRoleLocalPart(local: string): RoleLocalClass | null {
  const l = String(local || '').trim().toLowerCase()
  if (!l) return null
  if (SERVICE_ONLY_LOCAL.test(l)) return 'nonbusiness'
  // 单段 local 精确匹配优先，语义与原实现完全一致（不破坏现有精确匹配）。
  const exact = classifyExactRoleLocalPart(l)
  if (exact) return exact
  // 复合 local（info-apac / customer.services / sydney.info）：拆段后任一段精确命中角色词库
  // 即判角色；但首段是常见人名时跳过，避免误判个人邮箱。
  if (!COMPOUND_SEPARATOR.test(l)) return null
  const segments = l.split(COMPOUND_SEPARATOR).filter(Boolean)
  if (segments.length < 2) return null
  if (COMMON_FIRST_NAMES.has(segments[0])) return null
  for (const segment of segments) {
    const cls = classifyExactRoleLocalPart(segment)
    if (cls) return cls
  }
  return null
}

export function isRoleEmailLocalPart(local: string): boolean {
  return classifyRoleLocalPart(local) !== null
}

/** local 去除 ._-数字 后比对占位符词库，或 /^x{2,}$/（与 poolEligibility 同口径）。 */
export function isPlaceholderLocalPart(local: string): boolean {
  const cleaned = String(local || '').toLowerCase().replace(/[._\-0-9]+/g, '')
  return PLACEHOLDER_LOCAL_PARTS.has(cleaned) || /^x{2,}$/i.test(local)
}

export function isPlaceholderEmail(email: string): boolean {
  const e = normalizeEmail(email)
  if (!e) return false
  if (PLACEHOLDER_FULL_EMAILS.has(e)) return true
  const at = e.indexOf('@')
  if (at <= 0) return false
  const local = e.slice(0, at)
  const domain = e.slice(at + 1)
  if (!domain || PLACEHOLDER_DOMAINS.has(domain)) return true
  return isPlaceholderLocalPart(local)
}

/** 角色邮箱 = 角色 local-part 且非免费域名（免费域名按 free 逻辑单独处理，避免误伤 projects@yahoo.com 之类）。 */
export function isRoleEmail(email: string): boolean {
  const e = normalizeEmail(email)
  if (!e || !EMAIL_FORMAT.test(e)) return false
  const at = e.indexOf('@')
  const local = e.slice(0, at)
  const domain = e.slice(at + 1)
  if (FREE_DOMAINS.has(domain)) return false
  return isRoleEmailLocalPart(local)
}

/** 角色邮箱的分类名（public/department/location/nonbusiness），非角色返回 null。 */
export function roleEmailClass(email: string): RoleLocalClass | null {
  const e = normalizeEmail(email)
  if (!e || !EMAIL_FORMAT.test(e)) return null
  const at = e.indexOf('@')
  const local = e.slice(0, at)
  const domain = e.slice(at + 1)
  if (FREE_DOMAINS.has(domain)) return null
  return classifyRoleLocalPart(local)
}

/** Only clearly non-business role addresses require a different contact; public,
 * department, and location business inboxes may be used once the exact address
 * is verified and the company is business-matched. */
export function contactMiningRoleClass(email: string): RoleLocalClass | null {
  const cls = roleEmailClass(email)
  return cls === 'nonbusiness' ? cls : null
}
