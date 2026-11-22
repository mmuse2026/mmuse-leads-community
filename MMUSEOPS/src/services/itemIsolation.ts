import { isActiveCrmMaster } from './crmIdentity'

/**
 * 全局隔离权威判定（状态守恒，2026-08-09 收敛）。
 *
 * 单一事实来源：任何发送/入队/全量重算入口都必须通过 isIsolatedItem 判断一条客户数据
 * 是否已被前期拦截（隔离）。任一隔离标记为真即视为已隔离，绝不能再进入后面的阶段
 * （测试信发送、正式开发信发送、重新入队）。
 *
 * 覆盖的隔离标记：
 *   operationalTier === 'true_excluded'     运营层隔离
 *   doNotDevelop === true                    不开发（人工判定）
 *   doNotContactEmail === true               邮箱层面禁止联系
 *   reviewDisposition === 'do_not_develop'   人工复核不开发
 *   primaryStage === 'true_excluded'         主阶段隔离（primaryStage 单独即隔离，
 *                                            修复全量重算复活漏洞）
 *   normalizedStage === 'inactive_excluded'  归一化阶段停用排除
 *
 * 公司级隔离权威同时并入 CRM 主体状态：isActiveCrmMaster(item) === false（合并从属 /
 * inactiveCategory='duplicate' / activeWorkflow===false / inactiveWorkflow===true /
 * status==='archived'）本身即公司级隔离，见 isCompanyLevelIsolatedItem。
 */
export function isIsolatedItem(item: any): boolean {
  if (!item) return false
  return item.operationalTier === 'true_excluded'
    || item.doNotDevelop === true
    || item.doNotContactEmail === true
    || item.reviewDisposition === 'do_not_develop'
    || item.primaryStage === 'true_excluded'
    || item.normalizedStage === 'inactive_excluded'
}

const EMAIL_ONLY_EXCLUSION_REASONS = new Set([
  'email_unreachable',
  'test_mail_bounced',
  'address_bounced_or_failed',
])

/** 精确邮箱不可达不等于整家公司不可开发。 */
export function isEmailOnlyIsolation(item: any): boolean {
  if (!item || item.primaryStage !== 'true_excluded') return false
  const reasons = Array.isArray(item.eligibilityBlockedReasons)
    ? item.eligibilityBlockedReasons.map((value: unknown) => String(value || '').trim()).filter(Boolean)
    : []
  return reasons.length > 0 && reasons.every((reason: string) => EMAIL_ONLY_EXCLUSION_REASONS.has(reason))
}

/** 公司级隔离才允许把客户留在 true_excluded；邮箱级退信由换联系人流程承接。 */
export function isCompanyLevelIsolatedItem(item: any): boolean {
  if (!item) return false
  if (item.doNotDevelop === true || item.doNotContactEmail === true || item.reviewDisposition === 'do_not_develop') return true
  if (item.operationalTier === 'true_excluded' || item.normalizedStage === 'inactive_excluded') return true
  // CRM 主体状态（合并从属 / inactiveCategory=duplicate / activeWorkflow=false / inactiveWorkflow=true / status=archived）
  // 本身即公司级隔离：这些记录绝不能再被路由成活跃线索。与 items-store-atomic.normalizeForStorage 原口径对齐。
  if (!isActiveCrmMaster(item)) return true
  return item.primaryStage === 'true_excluded' && !isEmailOnlyIsolation(item)
}
