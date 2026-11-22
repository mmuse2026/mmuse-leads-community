import type { PipelineItem } from '../types/item'
import { isEmailBounced } from './emailBounce'
export { STAGE_TO_CARD } from './crmCardRouting'
import { cardForItem } from './crmCardRouting'

// 搜索池只容纳尚未进入 CRM 阶段路由的新结果；入库后统一由 primaryStage 决定功能卡片。
export function isSearchPoolItem(item: PipelineItem): boolean {
  if (isEmailBounced(item)) return false
  const any = item as PipelineItem & Record<string, unknown>
  if (any?.activeWorkflow === false || any?.inactiveWorkflow === true) return false
  if (any?.crmMergedInto) return false
  return !cardForItem(item)
}
