import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { countFormalFollowupSlotsToday, DAILY_FOLLOWUP_SEND_LIMIT, DEFAULT_SEND_CONFIG, planQueue, shanghaiDayKey, type FormalSendQueueRecord, type SendCampaign, type SendPlannerConfig } from '../src/services/formalSendQueue'
import { acquireFormalQueueLock, releaseFormalQueueLock } from './formal-queue-lock'

export interface FormalSendQueueStore {
  version: 1
  revision: number
  updatedAt: string
  config: SendPlannerConfig
  records: FormalSendQueueRecord[]
  campaigns: SendCampaign[]
  paused: boolean
  pauseReason?: string
  pausePending?: boolean
  pausePendingReason?: string
}

export const FORMAL_SEND_QUEUE_FILE = join(__dirname, '..', 'data', 'formal_send_queue.json')

export function emptyFormalSendQueue(): FormalSendQueueStore {
  return { version: 1, revision: 0, updatedAt: new Date(0).toISOString(), config: { ...DEFAULT_SEND_CONFIG }, records: [], campaigns: [], paused: false }
}

export function readFormalSendQueue(path = FORMAL_SEND_QUEUE_FILE): FormalSendQueueStore {
  if (!existsSync(path)) return emptyFormalSendQueue()
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  return {
    ...emptyFormalSendQueue(),
    ...parsed,
    revision: Number.isSafeInteger(parsed.revision) ? parsed.revision : 0,
    config: { ...DEFAULT_SEND_CONFIG, ...parsed.config },
    records: Array.isArray(parsed.records) ? parsed.records : [],
    campaigns: Array.isArray(parsed.campaigns) ? parsed.campaigns : [],
  }
}

export function writeFormalSendQueue(store: FormalSendQueueStore, path = FORMAL_SEND_QUEUE_FILE, expectedRevision?: number): FormalSendQueueStore {
  mkdirSync(dirname(path), { recursive: true })
  const currentRevision = existsSync(path) ? readFormalSendQueue(path).revision : 0
  if (expectedRevision !== undefined && currentRevision !== expectedRevision) throw new Error('FORMAL_QUEUE_REVISION_CONFLICT')
  const next = {
    ...store,
    revision: currentRevision + 1,
    config: { ...DEFAULT_SEND_CONFIG, ...store.config },
    updatedAt: new Date().toISOString(),
  }
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temp, JSON.stringify(next, null, 2), 'utf8')
  renameSync(temp, path)
  return next
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
export async function withFormalSendQueueLock<T>(
  operation: () => Promise<T> | T,
  options: { path?: string; lockPath?: string; timeoutMs?: number } = {},
): Promise<T> {
  const path = options.path ?? FORMAL_SEND_QUEUE_FILE
  const lockPath = options.lockPath ?? `${path}.mutation.lock`
  const deadline = Date.now() + (options.timeoutMs ?? 2_000)
  let lock
  while (!lock && Date.now() <= deadline) {
    lock = acquireFormalQueueLock(lockPath)
    if (!lock) await wait(10)
  }
  if (!lock) throw new Error('FORMAL_QUEUE_BUSY')
  try { return await operation() } finally { releaseFormalQueueLock(lock) }
}
export async function mutateFormalSendQueue(
  mutation: (store: FormalSendQueueStore) => Promise<FormalSendQueueStore> | FormalSendQueueStore,
  options: { path?: string; lockPath?: string; timeoutMs?: number } = {},
) {
  const path = options.path ?? FORMAL_SEND_QUEUE_FILE
  const lockPath = options.lockPath ?? `${path}.mutation.lock`
  const deadline = Date.now() + (options.timeoutMs ?? 2_000)
  let lock
  while (!lock && Date.now() <= deadline) {
    lock = acquireFormalQueueLock(lockPath)
    if (!lock) await wait(10)
  }
  if (!lock) throw new Error('FORMAL_QUEUE_BUSY')
  try {
    const current = readFormalSendQueue(path)
    const changed = await mutation(structuredClone(current))
    return writeFormalSendQueue(changed, path, current.revision)
  } finally {
    releaseFormalQueueLock(lock)
  }
}

export function mergeFormalQueueRecords(latest: FormalSendQueueStore, changed: FormalSendQueueRecord[]) {
  const byId = new Map(changed.map(record => [record.id, record]))
  return { ...latest, records: latest.records.map(record => byId.get(record.id) || record) }
}

const PUBLIC_DASHBOARD_MAX_COUNT = 1_000_000
const dashboardStatuses = ['pending_human_review', 'approved_for_sending', 'scheduled', 'sending', 'sent', 'send_failed', 'needs_reschedule', 'needs_manual_reconciliation', 'needs_timezone_review', 'paused', 'blocked', 'skipped'] as const
export const ACTIVE_FORMAL_QUEUE_STATUSES = new Set(['pending_human_review', 'approved_for_sending', 'scheduled', 'sending', 'send_failed', 'needs_reschedule', 'needs_manual_reconciliation', 'needs_timezone_review', 'paused'])
export const FORMAL_QUEUE_HISTORY_STATUSES = new Set(['sent', 'blocked', 'skipped'])

export function isCurrentFormalQueueRecord(record: FormalSendQueueRecord, item?: any): boolean {
  if (!ACTIVE_FORMAL_QUEUE_STATUSES.has(String(record?.sendQueueStatus))) return false
  if (!item) return false
  const stage = String(item?.primaryStage || '')
  const drafts = [...(Array.isArray(item?.manualEmailDrafts) ? item.manualEmailDrafts : []), ...(Array.isArray(item?.outreachDrafts) ? item.outreachDrafts : [])]
  const draft = drafts.find((value: any) => String(value?.id || '') === String(record?.draftId || ''))
  const linkedFollowupStage = stage === 'followup_queue'
    && record?.campaignId !== 'followup-auto-consumer'
    && Number(record?.followupRound) > 0
    && draft?.followup === true
    && String(item?.formalCampaignId || '') === String(record?.campaignId || '')
    && String(item?.formalCampaignDraftId || '') === String(record?.draftId || '')
  const stageCurrent = record?.campaignId === 'followup-auto-consumer'
    ? stage === 'followup_queue'
    : stage === 'scheduled_send_queue' || stage === 'pending_draft_review' || linkedFollowupStage
  if (!stageCurrent) return false
  if (record.sendQueueStatus === 'needs_manual_reconciliation') return true
  if (!String(record?.draftId || '').trim() || !String(record?.recipientEmail || '').trim()) return true
  if (!draft) return false
  const recipient = String(record?.recipientEmail || '').trim().toLowerCase()
  return Boolean(recipient)
    && recipient === String(item?.selectedEmail || '').trim().toLowerCase()
    && recipient === String(draft?.to || '').trim().toLowerCase()
}

export function partitionFormalQueueRecords(records: readonly FormalSendQueueRecord[], items?: readonly any[]) {
  const active: FormalSendQueueRecord[] = []
  const history: FormalSendQueueRecord[] = []
  const itemById = items ? new Map(items.map(item => [String(item?.id || ''), item])) : undefined
  const preliminary = new Set<FormalSendQueueRecord>()
  for (const record of records) {
    const current = itemById
      ? isCurrentFormalQueueRecord(record, itemById.get(String(record?.customerId || '')))
      : ACTIVE_FORMAL_QUEUE_STATUSES.has(String(record?.sendQueueStatus))
    if (current) preliminary.add(record)
  }
  if (itemById) {
    const grouped = new Map<string, FormalSendQueueRecord[]>()
    for (const record of preliminary) {
      const key = String(record?.customerId || '')
      grouped.set(key, [...(grouped.get(key) || []), record])
    }
    const priority: Record<string, number> = {
      needs_manual_reconciliation: 100, sending: 90, scheduled: 80,
      send_failed: 70, needs_reschedule: 70, needs_timezone_review: 65,
      approved_for_sending: 60, pending_human_review: 50, paused: 40,
    }
    for (const [customerId, group] of grouped) {
      const item = itemById.get(customerId)
      const followups = group.filter(record => record.campaignId === 'followup-auto-consumer')
      const initial = group.filter(record => record.campaignId !== 'followup-auto-consumer')
      const choose = (values: FormalSendQueueRecord[]) => values
        .map((record, index) => ({ record, index }))
        .sort((left, right) => (priority[String(right.record.sendQueueStatus)] || 0) - (priority[String(left.record.sendQueueStatus)] || 0) || left.index - right.index)[0]?.record
      const initialCurrent = choose(initial)
      if (initialCurrent) active.push(initialCurrent)
      if (followups.length) {
        const drafts = Array.isArray(item?.manualEmailDrafts) ? item.manualEmailDrafts : []
        const roundOf = (record: FormalSendQueueRecord) => {
          const persisted = Number(record?.followupRound) || 0
          if (persisted === 1 || persisted === 2) return persisted
          return Number(drafts.find((draft: any) => String(draft?.id || '') === String(record?.draftId || ''))?.round) || 0
        }
        const sentRecords = records
          .filter(record => String(record?.customerId || '') === customerId && record.campaignId === 'followup-auto-consumer')
          .filter(record => record.sendQueueStatus === 'sent' || Boolean(record.messageId || record.actualSentAt))
        const sentRounds = new Set(sentRecords.map(roundOf).filter(round => round === 1 || round === 2))
        for (const draft of drafts) {
          const round = Number(draft?.round) || 0
          if ((round === 1 || round === 2) && (draft?.sent === true || draft?.status === 'sent') && Boolean(draft?.sentAt || draft?.messageId)) {
            sentRounds.add(round)
          }
        }
        const unknownSentRound = sentRecords.some(record => roundOf(record) === 0)
        const expectedRound = sentRounds.has(2) ? 0 : sentRounds.has(1) ? 2 : 1
        const manual = followups.filter(record => record.sendQueueStatus === 'needs_manual_reconciliation')
        const matching = followups.filter(record => roundOf(record) === expectedRound)
        const fallback = followups.filter(record => roundOf(record) === 0)
        const current = choose(manual.length ? manual : unknownSentRound ? [] : matching.length ? matching : fallback)
        if ((expectedRound || manual.length) && current) active.push(current)
      }
    }
  } else {
    active.push(...preliminary)
  }
  const activeSet = new Set(active)
  for (const record of records) {
    if (!activeSet.has(record)) history.push(record)
  }
  return { active, history }
}

export function planCurrentFormalQueueRecords(
  records: readonly FormalSendQueueRecord[],
  items: readonly any[],
  config: SendPlannerConfig,
  now = new Date(),
  random = Math.random,
): FormalSendQueueRecord[] {
  const candidates = partitionFormalQueueRecords(records, items).active.filter(record =>
    record.sendQueueStatus === 'approved_for_sending' || record.sendQueueStatus === 'needs_timezone_review')
  const ready: FormalSendQueueRecord[] = []
  const readyOrigins: FormalSendQueueRecord[] = []
  const replacements = new Map<FormalSendQueueRecord, FormalSendQueueRecord>()
  for (const record of candidates) {
    // 2026-10-25 主公口径：不再按客户当地时区排期，统一按北京时间工作窗口发送，避免时区证据缺失阻塞队列。
    ready.push({
      ...record,
      timezone: 'Asia/Shanghai',
      timezoneSource: 'fixed_beijing_window',
      sendQueueStatus: 'approved_for_sending' as const,
    })
    readyOrigins.push(record)
  }
  // why: 未来 scheduled 时间不参与锚点，否则一条当前不可发送的死记录会把整条队列永久推到未来。
  const cadenceAnchors = records.flatMap(record => {
    if (record.sendQueueStatus === 'sending') return [Date.parse(String(record.lastSendAttemptAt || record.updatedAt || ''))]
    if (record.sendQueueStatus === 'sent') return [Date.parse(String(record.actualSentAt || ''))]
    return []
  }).filter(Number.isFinite)
  const latestAnchor = cadenceAnchors.length ? Math.max(...cadenceAnchors) : NaN
  let planningStart = now
  if (Number.isFinite(latestAnchor)) {
    const min = Math.max(0, Math.floor(config.minIntervalMinutes))
    const max = Math.max(min, Math.floor(config.maxIntervalMinutes))
    const interval = min + Math.floor(Math.min(Math.max(random(), 0), 0.999999) * (max - min + 1))
    planningStart = new Date(Math.max(now.getTime(), latestAnchor + interval * 60_000))
  }
  const planned = planQueue(ready, config, planningStart, random, formalDailyUsage(records, now))
  readyOrigins.forEach((record, index) => replacements.set(record, planned[index]))
  return records.map(record => replacements.get(record) || record)
}

export function replanCurrentScheduledFormalQueueRecords(
  records: readonly FormalSendQueueRecord[],
  items: readonly any[],
  config: SendPlannerConfig,
  now = new Date(),
  random = Math.random,
): FormalSendQueueRecord[] {
  const candidates = partitionFormalQueueRecords(records, items).active.filter(record => record.sendQueueStatus === 'scheduled')
  const planned = planQueue(candidates.map(record => ({ ...record, sendQueueStatus: 'approved_for_sending' as const })), config, now, random, formalDailyUsage(records, now))
  const replacements = new Map(candidates.map((record, index) => [record, planned[index]]))
  return records.map(record => replacements.get(record) || record)
}
export function formalDailyUsage(records: readonly FormalSendQueueRecord[], now: Date) {
  const day = (date: string | Date) => { const parsed = new Date(date); return Number.isFinite(parsed.getTime()) ? shanghaiDayKey(parsed) : '' }
  const today = day(now)
  return records.filter(record => {
    if (record.sendQueueStatus === 'sent' && record.actualSentAt) return day(record.actualSentAt) === today
    return record.sendQueueStatus === 'needs_manual_reconciliation'
      && Boolean(record.providerAttemptedAt)
      && day(record.providerAttemptedAt) === today
  }).length
}
const publicDashboardCount = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 ? Math.min(Number(value), PUBLIC_DASHBOARD_MAX_COUNT) : 0
const publicDashboardTime = (value: unknown) => {
  if (typeof value !== 'string') return undefined
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value ? value : undefined
}
const publicBeijingTime = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) && Number.isFinite(Date.parse(value.replace(' ', 'T') + '+08:00')) ? value : undefined

export function queueDashboard(store: FormalSendQueueStore, now = new Date(), items?: readonly any[]) {
  const safeNow = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date(0)
  const records = Array.isArray(store?.records) ? store.records : []
  const partition = partitionFormalQueueRecords(records, items)
  const day = shanghaiDayKey(safeNow)
  const today = records.filter(record => (publicBeijingTime(record?.beijingSendAt) || publicDashboardTime(record?.scheduledSendAt) || '').startsWith(day))
  const count = (status: string) => publicDashboardCount(records.filter(record => record?.sendQueueStatus === status).length)
  const sentToday = publicDashboardCount(records.filter(record => record?.sendQueueStatus === 'sent' && publicDashboardTime(record.actualSentAt) && shanghaiDayKey(new Date(record.actualSentAt!)) === day).length)
  const usedToday = publicDashboardCount(formalDailyUsage(records, safeNow))
  const followupSentToday = publicDashboardCount(countFormalFollowupSlotsToday(records, safeNow))
  const scheduledTimes = records
    .filter(record => record?.sendQueueStatus === 'scheduled')
    .map(record => publicDashboardTime(record?.scheduledSendAt))
    .filter((value): value is string => Boolean(value))
    .sort()
  const dailyMax = publicDashboardCount(store?.config?.dailyMaxSendCount)
  return {
    lastUpdatedAt: publicDashboardTime(store?.updatedAt), paused: store?.paused === true,
    dailyTarget: publicDashboardCount(store?.config?.dailyTargetSendCount), dailyMax,
    sentToday, scheduledToday: publicDashboardCount(today.filter(record => record?.sendQueueStatus === 'scheduled').length),
    followupDailyLimit: DAILY_FOLLOWUP_SEND_LIMIT, followupSentToday,
    followupRemainingQuota: publicDashboardCount(Math.max(0, DAILY_FOLLOWUP_SEND_LIMIT - followupSentToday)),
    failedToday: publicDashboardCount(today.filter(record => record?.sendQueueStatus === 'send_failed').length),
    remainingQuota: publicDashboardCount(Math.max(0, dailyMax - usedToday)),
    futureDeferred: count('needs_reschedule'), nextScheduledSendAt: scheduledTimes[0],
    activeQueueLength: publicDashboardCount(partition.active.length),
    currentFailureCount: publicDashboardCount(partition.active.filter(record => record.sendQueueStatus === 'send_failed' || record.sendQueueStatus === 'needs_manual_reconciliation').length),
    historyTotal: publicDashboardCount(partition.history.length),
    sentHistory: publicDashboardCount(partition.history.filter(record => record.sendQueueStatus === 'sent').length),
    blockedHistory: count('blocked'),
    counts: Object.fromEntries(dashboardStatuses.map(status => [status, publicDashboardCount(partition.active.filter(record => record.sendQueueStatus === status).length)])),
  }
}
