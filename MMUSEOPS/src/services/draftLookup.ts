import { currentUnsentDraft as currentDraft } from './emailSignature'
export type PersistedDraftCollection = 'outreachDrafts' | 'manualEmailDrafts'

const list = (value: unknown): any[] => Array.isArray(value) ? value : []
const matches = (draft: any, draftId: string) =>
  String(draft?.id || '') === draftId || String(draft?.campaignKey || '') === draftId

export function findPersistedDraft(item: any, draftId: string):
  { draft: any; collection: PersistedDraftCollection } | undefined {
  for (const collection of ['outreachDrafts', 'manualEmailDrafts'] as const) {
    const draft = list(item?.[collection]).find(value => matches(value, draftId))
    if (draft) return { draft: currentDraft(draft), collection }
  }
  return undefined
}

export function updatePersistedDraft(
  item: any,
  draftId: string,
  update: (draft: any) => any,
): any {
  const found = findPersistedDraft(item, draftId)
  if (!found) return item
  return {
    ...item,
    [found.collection]: list(item[found.collection]).map(draft =>
      matches(draft, draftId) ? update(draft) : draft),
  }
}

export function allPersistedDrafts(item: any): any[] {
  const seen = new Set<string>()
  return [...list(item?.outreachDrafts), ...list(item?.manualEmailDrafts)].filter(draft => {
    const key = String(draft?.id || draft?.campaignKey || '')
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  }).map(currentDraft)
}

export function serializeManualEmailDraft(draft:any):string{return JSON.stringify(draft)}
export function deserializeManualEmailDraft(value:string):any{const draft=JSON.parse(value);if(!['pending_human_review','approved','superseded','sent'].includes(draft?.status))throw new Error('MANUAL_DRAFT_STATUS_INVALID');return draft}
