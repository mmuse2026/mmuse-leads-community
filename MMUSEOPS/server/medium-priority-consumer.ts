import { applyEligibilityStage } from '../src/services/leadStageEligibility'
import { readItemsAtomic, updateItemsAtomic, ITEMS_STORE_FILE } from './items-store-atomic'

const HIGH_WORK_STAGES = new Set([
  'backcheck_queue',
  'data_enrichment_needed',
  'contact_mining_queue',
  'email_validation_queue',
  'observation_queue',
  'developable_email_pool',
  'pending_draft_review',
  'scheduled_send_queue',
])

export interface MediumPriorityActivationDeps {
  itemsStorePath?: string
  latestSearchInsertedHigh?: boolean
  maxPerTick?: number
}

export async function runMediumPriorityActivationStep(now: Date, deps: MediumPriorityActivationDeps = {}) {
  const path = deps.itemsStorePath || ITEMS_STORE_FILE
  const items = readItemsAtomic(path)
  const highWorkExists = items.some((item: any) =>
    String(item.businessMatch || '').toLowerCase() === 'high'
    && HIGH_WORK_STAGES.has(String(item.primaryStage || item.normalizedStage || '')),
  )
  if (highWorkExists || deps.latestSearchInsertedHigh) {
    return { activated: 0, skipped: highWorkExists ? 'high_priority_pending' : 'latest_search_added_high' }
  }

  const max = Math.max(0, deps.maxPerTick ?? 10)
  const ids = new Set(items
    .filter((item: any) => String(item.businessMatch || '').toLowerCase() === 'medium' && !item.mediumPriorityActivatedAt)
    .sort((a: any, b: any) => Date.parse(a.createdAt || '') - Date.parse(b.createdAt || ''))
    .slice(0, max)
    .map((item: any) => String(item.id)))
  if (!ids.size) return { activated: 0, skipped: 'no_medium_pending' }

  updateItemsAtomic(current => current.map((item: any) => {
    if (!ids.has(String(item.id))) return item
    return applyEligibilityStage({ ...item, mediumPriorityActivatedAt: now.toISOString() }, now).item
  }), path, now, { refreshOnlyMutated: true })
  return { activated: ids.size }
}
