/**
 * MMUSEOPS 数据层 v2 — 简化版
 *
 * 架构：服务端单记录命令是写入权威；IndexedDB 仅在服务端确认后更新
 * 数据流：
 *   启动 → loadFromDisk() 从后端加载一次 → 合并到 IndexedDB
 *   保存 → saveItem() 先提交服务端 CAS 命令 → 成功后更新 IndexedDB
 *   读取 → getAllItems() 只读 IndexedDB
 *   普通浏览器禁止全量覆盖与物理删除
 */
import Dexie, { type Table } from 'dexie'
import type { PipelineItem } from '../types/item'
import { API_BASE } from '../services/config'
import { withLeadScore } from '../services/leadScoring'
import { SERVER_OWNED_HISTORY_FIELDS } from '../services/itemSaveCommand'
import { stampCrmIdentity } from '../services/crmIdentity'
import { mergeCrmCompanies } from '../services/crmMerge'
import { shouldUseRemoteSummary } from './dbSyncPolicy'

// ========= IndexedDB =========

export class MMUSEOPSDB extends Dexie {
  items!: Table<PipelineItem, string>
  searchSessions!: Table<SearchSession, string>

  constructor() {
    super('Mmuse_v2')
    this.version(7).stores({
      items: 'id, pipelineId, currentStageId, status, priority, level, clientType, emailVerification, leadGrade, updatedAt, createdAt',
      searchSessions: 'id, searchedAt, product, channel, industry',
    })
  }
}

export const db = new MMUSEOPSDB()

// ========= 服务端权威写入 =========

type OperatorSession = { operatorToken: string; csrfToken: string; expiresAt: number }
let operatorSessionCache: OperatorSession | null = null
let loadFromDiskPromise: Promise<number> | null = null

// 会话内内存真相源：一次同步后 getAllItems 直接读内存，不再往返 IndexedDB（2453 条 × ~128KB 的
// bulkPut/读回是 EmailBatch 首次加载 40s 量级的卡点）。IndexedDB 仅作跨会话暖缓存，冷同步时后台写回。
let cachedItems: PipelineItem[] | null = null

function emitPersistState(state: 'syncing' | 'synced' | 'pending'): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('mmuse:persist-status', { detail: state }))
}

function emitPersistError(code: string, itemId?: string): void {
  emitPersistState('pending')
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('mmuse:persist-error', { detail: { code, itemId } }))
}

async function getOperatorSession(): Promise<OperatorSession> {
  if (operatorSessionCache && operatorSessionCache.expiresAt > Date.now() + 5_000) return operatorSessionCache
  const response = await fetch(`${API_BASE}/api/formal-send-queue/operator-session`, { signal: AbortSignal.timeout(20_000) })
  const result = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) throw new Error(String(result.code || 'LOCAL_OPERATOR_AUTH_REQUIRED'))
  operatorSessionCache = result as unknown as OperatorSession
  return operatorSessionCache
}

export async function authorizedJsonPost(path: string, body: Record<string, unknown>): Promise<Record<string, any>> {
  const session = await getOperatorSession()
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-MMUSE-Operator': session.operatorToken,
      'X-MMUSE-CSRF': session.csrfToken,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  const result = await response.json().catch(() => ({})) as Record<string, any>
  if (!response.ok) {
    if (response.status === 403) operatorSessionCache = null
    throw new Error(String(result.code || result.error || 'ITEM_SERVER_WRITE_FAILED'))
  }
  return result
}

// ========= 启动加载 =========

let lastServerSyncAt = 0

/** 分片后台写回 IndexedDB（跨会话暖缓存）。整库 bulkPut 的结构化克隆会阻塞主线程秒级，
 *  分片 + 让出主线程 + 延迟到首屏之后，避免阻塞加载。 */
function writeBackIdbChunked(items: PipelineItem[]): void {
  if (typeof window === 'undefined' || items.length === 0) return
  const CHUNK = 150
  let i = 0
  const step = () => {
    if (i >= items.length) return
    const slice = items.slice(i, i + CHUNK)
    i += CHUNK
    db.items.bulkPut(slice).catch((error) => console.error('[sync] IndexedDB write-back failed', error))
    const idle = (window as any).requestIdleCallback || ((cb: () => void) => setTimeout(cb, 16))
    idle(step)
  }
  setTimeout(step, 900) // 延迟到初始渲染完成之后，避免与首屏竞争
}

/** 从服务端拉取全量并合并进内存真相源（fetch+parse 是唯一不可避免的 ~3s+ 网络成本）。
 *  - 冷同步：以 IndexedDB 为 local 侧合并；未变化条目复用（跳过 prepareItem）。
 *  - 热同步：以当前内存副本为 local 侧，仅重算变化条目。
 *  成功后 dispatch 'mmuse:sync-done'。 */
async function doServerSync(): Promise<number> {
  // 按需加载：列表数据源为精简摘要（gzip），超大详情字段不进摘要；详情页按 id 走 /api/items/:id
  const resp = await fetch(`${API_BASE}/api/items/summary`, { signal: AbortSignal.timeout(120000) })
  if (!resp.ok) throw new Error(`items_sync_http_${resp.status}`)

  const remoteItems: PipelineItem[] = await resp.json()
  if (!remoteItems.length) return 0

  const cold = cachedItems === null
  const localItems = cold ? await db.items.toArray() : []
  const source = cold ? localItems : (cachedItems || [])
  const localMap = new Map(source.map(i => [i.id, i]))
  let added = 0, updated = 0, reused = 0
  const prepared: PipelineItem[] = []
  for (const remote of remoteItems) {
    if (!remote.id) continue
    const local = localMap.get(remote.id)
    if (!local) {
      prepared.push(prepareItem(remote))
      added++
      continue
    }
    if (shouldUseRemoteSummary(local, remote)) {
      prepared.push(prepareItem({
        ...remote,
        emailLogs: mergeEmailLogs(local.emailLogs, remote.emailLogs),
        notes: local.notes?.length ? local.notes : remote.notes,
      }))
      updated++
    } else {
      prepared.push(local) // 未变化：复用已归一化对象，跳过 prepareItem
      reused++
    }
  }
  cachedItems = prepared
  lastServerSyncAt = Date.now()
  if (cold) writeBackIdbChunked(prepared)
  console.log(`[sync] +${added}, ~${updated}, reuse ${reused}, total ${prepared.length}`)
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('mmuse:sync-done'))
  return (cold ? localItems.length : 0) + added + updated
}

/** 确保有可渲染的数据：内存 → IndexedDB 暖缓存 → 服务端。
 *  force=false：会话内已有内存副本或 IndexedDB 有上次会话数据时立即返回（旧数据先渲染，后台刷新生效），
 *  避免每次加载都下载 244MB / 等待服务端冷序列化。
 *  force=true：跳过缓存直连服务端（DataAdmin 手动"数据已同步"等场景）。 */
export function loadFromDisk(force = false): Promise<number> {
  if (loadFromDiskPromise) return loadFromDiskPromise
  if (!force && cachedItems !== null) return Promise.resolve(cachedItems.length)

  loadFromDiskPromise = (async () => {
    try {
      if (!force && cachedItems === null) {
        // IndexedDB 暖缓存优先渲染，后台再刷新生效
        try {
          const idbItems = await db.items.toArray()
          if (idbItems.length > 0) {
            cachedItems = idbItems.map(prepareItem)
            // force：IndexedDB 可能因上次会话 writeBackIdbChunked 未完成而只有部分数据，
            // 必须以服务器真相源强制覆盖，避免页面停在部分数据
            setTimeout(() => {
              void refreshFromServer(true).catch(() => {})
            }, 0)
            return cachedItems.length
          }
        } catch {
          // 忽略 IDB 读取失败，走服务端
        }
      }
      return await doServerSync()
    } catch (error) {
      throw error instanceof Error ? error : new Error('items_sync_failed')
    } finally {
      loadFromDiskPromise = null
    }
  })()

  return loadFromDiskPromise
}

/** 从服务端拉取最新数据更新内存（操作后/需要服务端最新数据时）。
 *  force=false：若刚同步过（<2s）则跳过，避免重复下载 244MB。 */
export function refreshFromServer(force = false): Promise<number> {
  if (loadFromDiskPromise) return loadFromDiskPromise
  if (!force && cachedItems !== null && Date.now() - lastServerSyncAt < 2000) return Promise.resolve(cachedItems.length)
  loadFromDiskPromise = doServerSync()
    .catch((error) => { throw error instanceof Error ? error : new Error('items_sync_failed') })
    .finally(() => { loadFromDiskPromise = null })
  return loadFromDiskPromise
}

/** 合并 emailLogs，按 id 去重 */
function mergeEmailLogs(local: any[] = [], remote: any[] = []): any[] {
  if (!local.length) return remote
  if (!remote.length) return local
  const map = new Map(local.map((l: any) => [l.id, l]))
  for (const r of remote) {
    if (!map.has(r.id)) map.set(r.id, r)
  }
  return [...map.values()]
}

function prepareItem(input: PipelineItem): PipelineItem {
  const raw = input as PipelineItem & { backcheck?: PipelineItem['backCheck'] }
  const now = new Date().toISOString()
  const createdAt = raw.createdAt || now
  const backCheck = raw.backCheck || raw.backcheck
  const emailLogs = Array.isArray(raw.emailLogs) ? raw.emailLogs : []

  let currentStageId = raw.currentStageId || 'otr-found'
  let developmentStatus = raw.developmentStatus || 'pending'
  let emailVerification = raw.emailVerification || 'unknown'
  let emailBounced = Boolean(raw.emailBounced)

  if (emailLogs.length > 0) {
    if (emailLogs.some(log => log.status === 'replied')) {
      developmentStatus = 'replied'
      currentStageId = 'otr-replied'
    } else if (emailLogs.some(log => log.status === 'sent' || log.status === 'opened' || log.status === 'bounced')) {
      developmentStatus = 'sent'
      if (currentStageId === 'otr-found' || currentStageId === 'otr-backcheck' || currentStageId === 'otr-contact' || currentStageId === 'otr-verify') {
        currentStageId = 'otr-first'
      }
    }

    if (emailLogs.some(log => log.status === 'bounced')) {
      emailBounced = true
      if (emailVerification === 'unknown' && emailLogs.every(log => log.status === 'bounced')) {
        emailVerification = 'invalid'
      }
    }
  }

  if (raw.status === 'archived') {
    developmentStatus = 'skipped'
  }

  const hasServerRevision = Number.isSafeInteger((raw as any).serverRevision)
  const timeline = hasServerRevision
    ? (Array.isArray(raw.timeline) ? raw.timeline : [])
    : Array.isArray(raw.timeline) && raw.timeline.length > 0
      ? raw.timeline
      : [{ stageId: currentStageId, enteredAt: createdAt }]

  const { backcheck: _legacyBackcheck, ...item } = raw as any

  return withLeadScore({
    ...item,
    title: raw.title || raw.company || raw.website || raw.email || '未命名客户',
    currentStageId,
    status: raw.status || 'active',
    priority: raw.priority || 'medium',
    source: raw.source || 'manual',
    contactName: raw.contactName || '',
    company: raw.company || '',
    email: raw.email || '',
    phone: raw.phone || '',
    level: raw.level || 'unknown',
    clientType: raw.clientType || 'unknown',
    emailVerification,
    emailBounced,
    backCheck,
    backcheckStatus: backCheck ? 'done' : (raw.backcheckStatus || 'pending'),
    developmentStatus,
    emailLogs,
    currency: raw.currency || 'USD',
    timeline,
    createdAt,
    updatedAt: raw.updatedAt || now,
    businessLine: raw.businessLine || 'furniture',
    notes: Array.isArray(raw.notes) ? raw.notes : [],
    attachments: Array.isArray(raw.attachments) ? raw.attachments : [],
  } as PipelineItem)
}

// ========= 基础 CRUD =========

/** 读取所有数据（会话内优先内存真相源；未同步时回退 IndexedDB 并预热内存缓存） */
export async function getAllItems(pipelineId?: string): Promise<PipelineItem[]> {
  if (cachedItems !== null) {
    const all = pipelineId ? cachedItems.filter(i => i.pipelineId === pipelineId) : cachedItems
    return all.slice()
  }
  if (pipelineId) {
    const scoped = await db.items.where('pipelineId').equals(pipelineId).toArray()
    const prepared = scoped.map(prepareItem)
    return prepared
  }
  const all = await db.items.toArray()
  const prepared = all.map(prepareItem)
  cachedItems = prepared // 预热内存缓存，后续读取不再往返 IndexedDB
  return prepared
}

/** 读取单条 */
export async function getItem(id: string): Promise<PipelineItem | undefined> {
  if (cachedItems !== null) {
    const hit = cachedItems.find(i => i.id === id)
    if (hit) return hit
  }
  const item = await db.items.get(id)
  return item ? prepareItem(item) : undefined
}

/** 按 id 从服务端拉取单条完整数据（详情页按需加载，含 emailLogs 全文/notes/timeline/backCheck）。 */
export async function fetchFullItem(id: string): Promise<PipelineItem | undefined> {
  try {
    const resp = await fetch(`${API_BASE}/api/items/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(30_000) })
    if (!resp.ok) return undefined
    const remote = await resp.json() as PipelineItem | undefined
    return remote ? prepareItem(remote) : undefined
  } catch {
    return undefined
  }
}

/** 拉取服务端单条真相源；失败/不存在返回 undefined。 */
async function fetchServerItem(id: string): Promise<PipelineItem | undefined> {
  try {
    const resp = await fetch(`${API_BASE}/api/items/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(20_000) })
    if (!resp.ok) return undefined
    return await resp.json() as PipelineItem | undefined
  } catch {
    return undefined
  }
}

/** 保存前合并服务端真相源：列表数据是精简摘要，服务端拥有字段（emailLogs/emailVerificationEvidence 等）必须
 *  以服务端为准整体回写，避免全量替换命令把摘要数据写回服务端造成丢数据/受保护字段冲突。 */
function mergeWithServerTruth(full: PipelineItem | undefined, item: PipelineItem): PipelineItem {
  if (!full) return item
  const base: Record<string, any> = { ...(full as Record<string, any>), ...(item as Record<string, any>) }
  for (const field of SERVER_OWNED_HISTORY_FIELDS) {
    const value = (full as Record<string, any>)[field]
    if (value !== undefined) base[field] = value
    else delete base[field]
  }
  // 用服务端最新 revision，降低并发冲突概率
  base.serverRevision = (full as any).serverRevision
  return base as PipelineItem
}

/** 更新内存真相源中的单条（不可变替换），保证保存后会话内读取即时一致。 */
function upsertCachedItem(item: PipelineItem): void {
  if (cachedItems === null) return
  const prepared = prepareItem(item)
  const idx = cachedItems.findIndex(i => i.id === prepared.id)
  cachedItems = idx >= 0
    ? [...cachedItems.slice(0, idx), prepared, ...cachedItems.slice(idx + 1)]
    : [...cachedItems, prepared]
}
/** Accept one full server-authoritative item after a dedicated command succeeds. */
export async function acceptAuthoritativeItem(item: PipelineItem): Promise<PipelineItem> {
  const prepared = prepareItem(item)
  await db.items.put(prepared)
  upsertCachedItem(prepared)
  emitPersistState('synced')
  return prepared
}

/** 保存单条：服务端精确命令确认后才更新 IndexedDB 与内存副本。 */
export async function saveItem(item: PipelineItem, options?: { reuseSearchIdentity?: boolean; onExisting?: (item: PipelineItem) => void }): Promise<void> {
  // 列表数据是精简摘要，先以服务端完整真相源合并，防止全量替换命令回写摘要丢数据
  const full = await fetchServerItem(item.id)
  const prepared = prepareItem(mergeWithServerTruth(full, item)) as PipelineItem & { serverRevision?: number }
  const expectedRevision = Number.isSafeInteger(prepared.serverRevision) ? Number(prepared.serverRevision) : 0
  const commandId = crypto.randomUUID()
  const itemPayload = { ...prepared } as Record<string, unknown>
  if (expectedRevision === 0) {
    for (const field of SERVER_OWNED_HISTORY_FIELDS) delete itemPayload[field]
    // Creation history belongs to the server. Search/import may carry a local
    // initial timeline, but the authoritative create command rejects that history.
    delete itemPayload.timeline
  }
  emitPersistState('syncing')
  try {
    const result = await authorizedJsonPost('/api/items/command', {
      itemId: prepared.id,
      expectedRevision,
      commandId,
      item: itemPayload,
      ...(options?.reuseSearchIdentity ? { duplicatePolicy: 'reuse_search_identity' } : {}),
    })
    const reusedExisting = options?.reuseSearchIdentity === true && result.reusedExisting === true
    if (!result.item || (!reusedExisting && result.item.id !== prepared.id) || result.revision !== (reusedExisting ? (result.item.serverRevision ?? 0) : result.item.serverRevision)) throw new Error('ITEM_SERVER_RESPONSE_INVALID')
    const serverPrepared = prepareItem(result.item as PipelineItem)
    await db.items.put(serverPrepared)
    upsertCachedItem(serverPrepared)
    if (reusedExisting) options?.onExisting?.(serverPrepared)
    emitPersistState('synced')
  } catch (error) {
    emitPersistError(error instanceof Error ? error.message : 'ITEM_SERVER_WRITE_FAILED', prepared.id)
    throw error
  }
}

/** 物理删除默认禁用；需要未来独立管理员工具。 */
export async function deleteItem(_id: string): Promise<void> {
  throw new Error('PHYSICAL_DELETE_REQUIRES_ADMIN')
}

function exclusionKeys(item: PipelineItem): string[] {
  const keys: string[] = []
  const company = (item.company || '').trim().toLowerCase().replace(/\s+/g, ' ')
  if (company) keys.push(`company:${company}`)
  if (item.website) {
    try { keys.push(`site:${new URL(item.website.includes('://') ? item.website : `https://${item.website}`).hostname.toLowerCase().replace(/^www\./, '')}`) } catch {}
  }
  const emailDomain = (item.email || '').split('@')[1]?.toLowerCase().trim()
  if (emailDomain) keys.push(`mail:${emailDomain}`)
  return keys
}

/** 批量保存（搜索/导入等场景）：逐条走服务端精确命令，永久排除记录不可被新结果重新激活。 */
export async function saveItems(items: PipelineItem[]): Promise<void> {
  const excluded = (await db.items.toArray()).filter(item => item.doNotDevelop || item.reviewDisposition === 'do_not_develop')
  const excludedKeys = new Set(excluded.flatMap(exclusionKeys))
  const safeItems = items
    .filter(item => item.doNotDevelop || item.reviewDisposition === 'do_not_develop' || !exclusionKeys(item).some(key => excludedKeys.has(key)))
    .map(item => stampCrmIdentity(item) as PipelineItem)
  const known = new Map<string, PipelineItem>()
  for (const item of await db.items.toArray()) {
    const stamped = stampCrmIdentity(item) as PipelineItem
    if (stamped.crmCompanyKey && !stamped.crmMergedInto && stamped.inactiveCategory !== 'duplicate') known.set(stamped.crmCompanyKey, stamped)
  }
  for (const incoming of safeItems) {
    const key = incoming.crmCompanyKey
    const existing = key ? known.get(key) : undefined
    if (!existing || existing.id === incoming.id) {
      await saveItem(incoming)
      if (key) known.set(key, incoming)
      continue
    }
    const merged = mergeCrmCompanies([existing, incoming]).items.find(item => !item.crmMergedInto) as PipelineItem
    // 搜索/导入命中同一公司时更新已有 CRM 主记录，不新增第二个活动公司。
    const target = merged.id === existing.id ? merged : { ...merged, id: existing.id, crmMasterId: existing.id }
    await saveItem(target)
    known.set(key!, target)
  }
}

// ========= 统计 =========

/** 各管道数量（会话内优先内存副本，避免读空/过期的 IndexedDB） */
export async function getPipelineCounts(): Promise<Record<string, number>> {
  const all = cachedItems !== null ? cachedItems.filter(i => i.status === 'active') : await db.items.where('status').equals('active').toArray()
  const counts: Record<string, number> = {}
  for (const item of all) {
    counts[item.pipelineId] = (counts[item.pipelineId] || 0) + 1
  }
  return counts
}

/** 按等级统计（会话内优先内存副本） */
export async function getLevelCounts(): Promise<Record<string, number>> {
  const all = cachedItems !== null ? cachedItems.filter(i => i.status === 'active') : await db.items.where('status').equals('active').toArray()
  const counts: Record<string, number> = { S: 0, M: 0, L: 0, XL: 0, unknown: 0 }
  for (const item of all) {
    counts[item.level] = (counts[item.level] || 0) + 1
  }
  return counts
}

// ========= 快照备份 =========

/** 生成全量快照并存入 backupSnapshots 表（保留最近3份） */
export async function takeSnapshot(): Promise<void> {
  const snapshot = await exportAllData()
  const allSnapshots = await (db as any).backupSnapshots?.toArray() || []
  if (allSnapshots.length >= 3) {
    const toDelete = allSnapshots.slice(0, allSnapshots.length - 2)
    await (db as any).backupSnapshots?.bulkDelete(toDelete.map((s: any) => s.id))
  }
  await (db as any).backupSnapshots?.add(snapshot)
}

// ========= 去重 =========

/** 按公司+联系人名去重，保留最新一条 */
export async function deduplicateItems(): Promise<number> {
  throw new Error('DEDUPLICATION_REQUIRES_SERVER_COMMAND')
}
export interface SearchSession {
  id: string
  product: string
  industry: string
  channel: string
  country?: string
  queries: string[]
  queryFingerprints?: string[]
  deferredQueries?: number
  total: number
  matched: number
  pending: number
  failed: number
  results: {
    title: string
    url: string
    snippet: string
    tag: string
    score: number
    reason: string
    companyInfo?: any
  }[]
  searchedAt: string
}

export async function saveSearchSession(session: SearchSession): Promise<void> {
  await db.searchSessions.put(session)
}

export async function getRecentSearchSessions(limit = 20): Promise<SearchSession[]> {
  try {
    return await (db as any).searchSessions
      ?.orderBy('searchedAt')
      .reverse()
      .limit(limit)
      .toArray() || []
  } catch {
    return []
  }
}

// ========= 数据迁移 =========

/** 迁移：backcheck → backCheck（旧数据的小写字段名） */
export async function migrateBackcheckField(): Promise<number> {
  const all = await db.items.toArray()
  let fixed = 0
  for (const item of all) {
    const raw = item as any
    if (raw.backcheck && !item.backCheck) {
      await saveItem(prepareItem({ ...item, backCheck: raw.backcheck, backcheckStatus: 'done' }))
      fixed++
    }
  }
  return fixed
}
export async function normalizeExistingItems(): Promise<number> {
  const all = await db.items.toArray()
  for (const item of all) await saveItem(prepareItem(item))
  return all.length
}
// ========= 数据导出/导入 =========

export interface DbDump {
  version: number
  exportedAt: string
  items: PipelineItem[]
}

export async function exportAllData(): Promise<DbDump> {
  // 列表内存是精简摘要；导出走服务端全量接口保证数据完整（emailLogs 全文/evidence note 等不缺失）
  try {
    const resp = await fetch(`${API_BASE}/api/items`, { signal: AbortSignal.timeout(120_000) })
    if (resp.ok) {
      const full = await resp.json() as PipelineItem[]
      if (Array.isArray(full) && full.length) {
        return { version: 4, exportedAt: new Date().toISOString(), items: full.map(prepareItem) }
      }
    }
  } catch {
    // 服务端不可用则回退内存副本
  }
  const items = cachedItems !== null ? cachedItems : await db.items.toArray()
  return {
    version: 4,
    exportedAt: new Date().toISOString(),
    items,
  }
}

export async function importAllData(_dump: DbDump): Promise<number> {
  throw new Error('ADMIN_IMPORT_REQUIRES_SERVER_TOOL')
}
export async function clearAllData(): Promise<void> {
  await db.items.clear()
  cachedItems = null
  // Local cache only. Do not push an empty database to the backend master file.
}

export async function getDbStats() {
  const active = cachedItems !== null ? cachedItems.filter(i => i.status === 'active') : null
  const itemCount = active !== null ? active.length : await db.items.count()
  const all = active !== null ? active : await db.items.where('status').equals('active').toArray()

  const pipelineCounts: Record<string, number> = {}
  const levelCounts: Record<string, number> = { S: 0, M: 0, L: 0, XL: 0, unknown: 0 }
  const leadGradeCounts: Record<string, number> = { S: 0, A: 0, B: 0, C: 0, D: 0 }

  for (const i of all) {
    pipelineCounts[i.pipelineId] = (pipelineCounts[i.pipelineId] || 0) + 1
    levelCounts[i.level] = (levelCounts[i.level] || 0) + 1
    leadGradeCounts[i.leadGrade || 'D'] = (leadGradeCounts[i.leadGrade || 'D'] || 0) + 1
  }

  const rawSize = new TextEncoder().encode(JSON.stringify(all)).length
  const estimatedSize = rawSize < 1024 * 1024
    ? `${(rawSize / 1024).toFixed(1)} KB`
    : `${(rawSize / 1024 / 1024).toFixed(1)} MB`

  return {
    items: itemCount,
    activeItems: all.length,
    pipelines: pipelineCounts,
    levels: levelCounts,
    leadGrades: leadGradeCounts,
    keywords: 0,
    templates: 0,
    estimatedSize,
  }
}

