import type { PipelineItem } from '../types/item'

/**
 * 是否"明确退信"的客户。
 *
 * 权威信号是服务端写盘时实时标记的 `emailBounced === true`；阶段机兜底：
 * 退信 → primaryStage / normalizedStage / operationalTier 会落到 `replace_contact_queue`。
 *
 * 业务铁律：明确退信的客户不得出现在任何"跟进/待开发/待审核/可开发/候选"类列表里，
 * 只应出现在"退信/换联系人"类视图。列表过滤统一用它，避免各页面重复/口径不一致。
 */
export function isEmailBounced(item: PipelineItem | null | undefined | { emailBounced?: boolean }): boolean {
  if (!item) return false
  if (item.emailBounced === true) return true
  const any = item as PipelineItem & Record<string, unknown>
  const stage = String(any?.primaryStage || any?.normalizedStage || any?.operationalTier || '')
  return stage === 'replace_contact_queue'
}
