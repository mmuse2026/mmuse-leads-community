/**
 * 联系人职位角色分类。
 *
 * 用于决定正式开发邮件的沟通策略：
 * - decision_maker（决策者）——直接商务合作沟通（合作可能/业务匹配/规格供应支持）
 * - business_contact（业务入口）——业务入口 + 转交逻辑
 * - non_business（非业务：前台/行政/人事/法务/财务/客服等）——不进入正式开发
 * - unclear（无法判断）——先确认角色再定策略
 *
 * 纯函数，无副作用，无 console.log。
 *
 * 匹配优先级（从高到低，命中即返回）：
 *   1. decision_maker（决策身份）：C-level/创始人/所有者/总裁/总经理 等终极身份，即使 title 同时含 HR/行政等词也优先
 *   2. non_business：接待/行政/人事/法务/财务/客服/呼叫中心 等（排除决策身份后）
 *   3. decision_maker（采购职能）：procurement/purchasing/sourcing/buyer（采购明确是决策者）
 *   4. business_contact：销售/业务开发/客户/项目/运营/设计/市场 等业务入口
 *   5. 决策层头衔（职能不清）：director/vp/head/lead/principal/officer 等高位头衔
 *   6. 其余 → unclear
 *
 * 优先级陷阱（关键业务逻辑）：
 *   - 决策身份词（Owner/CEO/Founder/President/Managing Director）必须排在最前，
 *     防止 "Marketing & HR Director / 共同Owner" 这类同时含 HR 词的真实老板被误归 non_business。
 *   - "Director of Sales" / "Sales Director" 必须先命中 business_contact（sales 职能词），
 *     不能因含 director 被归为 decision_maker。故 sales 职能判断排在 "director 高位头衔" 之前。
 *   - "Procurement Manager" / "Purchasing Manager" / "Sourcing Manager" 是 decision_maker。
 *   - 空字符串/未知 → unclear。
 */

export type ContactRoleCategory = 'decision_maker' | 'business_contact' | 'non_business' | 'unclear'

export type CommunicationStrategy =
  | 'direct_business_partnership' // decision_maker：直接商务合作沟通
  | 'business_entrypoint_with_referral' // business_contact：业务入口 + 转交逻辑
  | 'do_not_outreach' // non_business：不进入正式开发
  | 'assess_role_first' // unclear：先确认角色再定策略

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 英文整词匹配：词边界锚定，避免 "sales" 误匹配 "salesperson" 之类 */
const en = (term: string): RegExp =>
  new RegExp(`\\b${term.trim().split(/\s+/).map(escapeRegExp).join('\\s+')}\\b`, 'i')

/** 英文前缀匹配：`\breception` 命中 reception/receptionist，`\badmin` 命中 admin/administrator */
const enPrefix = (term: string): RegExp => new RegExp(`\\b${escapeRegExp(term)}`, 'i')

/** 中文包含匹配 */
const cn = (term: string): RegExp => new RegExp(escapeRegExp(term), 'i')

// 优先级 1：decision_maker（决策身份，终极身份，优先于 non_business）
const DECISION_IDENTITY: RegExp[] = [
  en('ceo'),
  en('cfo'),
  en('coo'),
  en('cto'),
  en('cmo'),
  en('founder'),
  en('co-founder'),
  en('cofounder'),
  en('owner'),
  en('president'),
  en('managing director'),
  en('md'),
  en('general manager'),
  en('gm'),
  en('chief'),
  cn('创始人'),
  cn('老板'),
  cn('总裁'),
  cn('董事长'),
  cn('总经理'),
  cn('首席执行官'),
  cn('共同所有者'),
]

// 优先级 2：non_business
const NON_BUSINESS: RegExp[] = [
  enPrefix('reception'), // reception / receptionist
  en('office admin'),
  enPrefix('admin'), // admin / administrator / administration / administrative
  en('hr'),
  en('human resource'),
  en('human resources'),
  en('legal'),
  en('accounting'),
  en('accountant'),
  en('bookkeeping'),
  en('customer service'),
  enPrefix('support'), // support / support specialist
  en('call center'),
  cn('前台'),
  cn('行政'),
  cn('客服'),
  cn('客户服务'),
  cn('接待'),
  cn('文员'),
]

// 优先级 3：decision_maker（采购职能，明确决策者）
const PROCUREMENT_ROLE: RegExp[] = [
  en('procurement'),
  en('purchasing'),
  en('sourcing'),
  en('supply chain buyer'),
  en('buyer'),
  cn('采购'),
]

// 优先级 3：business_contact
const BUSINESS_CONTACT: RegExp[] = [
  en('sales'),
  en('business development'),
  en('bd'),
  en('account manager'),
  en('key account'),
  en('project manager'),
  en('operations manager'),
  en('design manager'),
  en('marketing'),
  en('client manager'),
  en('inside sales'),
  cn('销售'),
  cn('业务开发'),
  cn('客户经理'),
  cn('项目经理'),
  cn('运营经理'),
  cn('市场'),
  cn('营销'),
]

// 优先级 4：决策层头衔（职能不清）
const EXECUTIVE_TITLE: RegExp[] = [
  en('director'),
  en('vp'),
  en('vice president'),
  en('head'),
  en('lead'),
  en('principal'),
  en('officer'),
  cn('总监'),
  cn('副总'),
  cn('负责人'),
]

/**
 * 按优先级从高到低逐条匹配职位字符串，命中即返回分类。
 * 职位可能为空、中英文混杂、含标点，均按正则宽容处理。
 */
export function classifyContactRole(title: string): ContactRoleCategory {
  const t = String(title ?? '').trim()
  if (!t) return 'unclear'
  if (DECISION_IDENTITY.some((p) => p.test(t))) return 'decision_maker'
  if (NON_BUSINESS.some((p) => p.test(t))) return 'non_business'
  if (PROCUREMENT_ROLE.some((p) => p.test(t))) return 'decision_maker'
  if (BUSINESS_CONTACT.some((p) => p.test(t))) return 'business_contact'
  if (EXECUTIVE_TITLE.some((p) => p.test(t))) return 'decision_maker'
  return 'unclear'
}

/** 由角色分类推导正式开发邮件的沟通策略。 */
export function getCommunicationStrategy(category: ContactRoleCategory): CommunicationStrategy {
  switch (category) {
    case 'decision_maker':
      return 'direct_business_partnership'
    case 'business_contact':
      return 'business_entrypoint_with_referral'
    case 'non_business':
      return 'do_not_outreach'
    default:
      return 'assess_role_first'
  }
}
