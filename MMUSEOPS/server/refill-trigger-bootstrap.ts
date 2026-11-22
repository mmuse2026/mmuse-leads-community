/**
 * refillTrigger 的 server 侧接线（批次2 / 数据不足自动补搜索）。
 *
 * refillTrigger.ts（src/services，纯触发/搜索逻辑）不直接 import server/items-store-atomic，
 * 由本薄封装把真实 store（读全量 + updateOneItemAtomic allowCreate 入库）注入 deps.readItems / deps.insertItem。
 * 调度器批次末统一接入时，调用 runRefillCheckBootstrap 即可（或直接组装 RefillCheckDeps）。
 *
 * 不挂载到 backgroundTick / pipeline-stepper；仅提供可调用导出函数。
 */

import { readItemsAtomic, updateOneItemAtomic, ITEMS_STORE_FILE } from './items-store-atomic'
import { runRefillCheck, type RefillCheckDeps, type RefillInsertResult } from '../src/services/refillTrigger'

export interface RefillBootstrapDeps extends Omit<RefillCheckDeps, 'readItems' | 'insertItem'> {
  /** 覆盖 items_store.json 路径（测试/独立库用） */
  itemsStorePath?: string
  /** 覆盖当前时间 */
  now?: Date
}

export async function runRefillCheckBootstrap(
  now: Date,
  deps: RefillBootstrapDeps = {},
): Promise<{ triggered: string[] }> {
  const itemsStorePath = deps.itemsStorePath || ITEMS_STORE_FILE
  const effectiveNow = deps.now || now
  return runRefillCheck(effectiveNow, {
    ...deps,
    readItems: () => readItemsAtomic(itemsStorePath),
    insertItem: async (item): Promise<RefillInsertResult> => {
      try {
        updateOneItemAtomic(item.id, () => item, itemsStorePath, {
          allowCreate: true,
          expectedRevision: 0,
          commandId: `refill-${item.id}`,
          commandFingerprint: 'refill-search-v1',
          actor: 'pipeline-stepper-refill',
          now: effectiveNow,
        })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  })
}
