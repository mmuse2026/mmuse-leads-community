import { partitionFormalQueueRecords, queueDashboard, type FormalSendQueueStore } from './formal-send-queue-store'
import { publicCampaignLabel, publicCustomerRouteRef, publicQueueRecordRef, sanitizeFormalQueueStore } from './formal-queue-security'

export function publicFormalQueueResponse(store: FormalSendQueueStore, items?: readonly any[]) {
  const partition = partitionFormalQueueRecords(store.records, items)
  const activeRecords = new Set(partition.active)
  const projected = { ...store, records: store.records.map((record, index) => ({
    ...record,
    recordScope: activeRecords.has(record) ? 'active' : 'history',
    publicRecordId: publicQueueRecordRef(record, index),
    customerRouteRef: publicCustomerRouteRef(record.customerId),
    campaignLabel: publicCampaignLabel(record),
  })) }
  return { ok: true, ...sanitizeFormalQueueStore(projected), dashboard: queueDashboard(store, new Date(), items) }
}

export function publicFormalQueueDashboardResponse(store: FormalSendQueueStore, items?: readonly any[]) {
  return { ok: true, ...queueDashboard(store, new Date(), items) }
}
