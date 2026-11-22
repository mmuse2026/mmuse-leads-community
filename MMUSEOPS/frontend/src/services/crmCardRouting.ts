import { isActiveCrmMaster } from './crmIdentity'

export const CRM_CARD_IDS = [
  'backcheck_queue', 'contact_mining', 'email_verification', 'observation',
  'development_ready', 'send_ready', 'followup_sent', 'replied', 'bounced',
  'nurture', 'excluded',
] as const

export type CrmCardId = typeof CRM_CARD_IDS[number]

export const STAGE_TO_CARD: Readonly<Record<string, CrmCardId>> = {
  backcheck_queue: 'backcheck_queue',
  data_enrichment_needed: 'backcheck_queue',
  manual_review: 'backcheck_queue',
  contact_mining_queue: 'contact_mining',
  email_validation_queue: 'email_verification',
  observation_queue: 'observation',
  developable_email_pool: 'development_ready',
  pending_draft_review: 'development_ready',
  scheduled_send_queue: 'send_ready',
  followup_queue: 'followup_sent',
  replied_queue: 'replied',
  replace_contact_queue: 'bounced',
  true_excluded: 'excluded',
  low_priority_nurture: 'nurture',
}

export function cardForItem(item: any): CrmCardId | undefined {
  if (item?.crmMergedInto || item?.inactiveCategory === 'duplicate') return undefined
  if (!isActiveCrmMaster(item)) return 'excluded'
  return STAGE_TO_CARD[String(item?.primaryStage || '')] || 'backcheck_queue'
}

export function isCrmCardId(value: unknown): value is CrmCardId {
  return CRM_CARD_IDS.includes(value as CrmCardId)
}

export function countItemsByCrmCard(items: readonly unknown[]): Record<CrmCardId, number> {
  const counts = Object.fromEntries(CRM_CARD_IDS.map(card => [card, 0])) as Record<CrmCardId, number>
  for (const item of items) {
    const card = cardForItem(item)
    if (card) counts[card] += 1
  }
  return counts
}

export function filterItemsForCard<T>(items: T[], card: unknown, projectKey?: string): T[] {
  if (!isCrmCardId(card)) return []
  return items.filter(item => {
    const record = item as any
    const itemProject = String(record?.projectId || record?.projectKey || record?.businessLine || '')
    return cardForItem(item) === card && (!projectKey || itemProject === projectKey)
  })
}
