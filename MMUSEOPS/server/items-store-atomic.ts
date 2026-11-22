import { closeSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join,resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { applyEligibilityStage } from '../src/services/leadStageEligibility'
import { buildChineseTags } from '../src/services/chineseBusinessTags'
import { stampCrmIdentity } from '../src/services/crmIdentity'
import { isActiveCrmMaster } from '../src/services/crmIdentity'
import { mergeCrmCompanies } from '../src/services/crmMerge'
import { SERVER_OWNED_HISTORY_FIELDS } from '../src/services/itemSaveCommand'
import type { TestMailVerdict } from '../src/services/testMailGate'
import { getFormalSentEmailsCached } from './formal-sent-email-set'
import { getTestMailVerdictsCached } from './test-mail-verdicts'
import { businessSplitActive } from './business-split-mode'
import { classifyCustomer } from './business-customer-partition'

export const ITEMS_STORE_FILE = join(__dirname, '..', 'items_store.json')

// 持锁进程被 kill/崩溃时，锁文件会永久残留并阻塞所有人（openSync 'wx' 对已存在文件永远失败）。
// 超过此年龄的锁视为 stale，回收后重试。阈值为 10 分钟，远高于正常持锁时长（约 2 分钟）。
const STALE_LOCK_MS = 10 * 60 * 1000
const PROCESS_STARTED_AT = new Date(Date.now() - process.uptime() * 1000).toISOString()

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error: any) {
    return error?.code === 'EPERM'
  }
}

const processStartCache = new Map<number, { value: string | null; checkedAt: number }>()
function observedProcessStartedAt(pid: number): string | null {
  if (pid === process.pid) return PROCESS_STARTED_AT
  const cached = processStartCache.get(pid)
  if (cached && Date.now() - cached.checkedAt < 5_000) return cached.value
  let startedAt: string | null = null
  if (process.platform === 'win32') {
    try {
      const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      const output = execFileSync(powershell, [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `((Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o'))`,
      ], { encoding: 'utf8', timeout: 2_000, windowsHide: true }).trim()
      if (Number.isFinite(Date.parse(output))) startedAt = output
    } catch {}
  }
  processStartCache.set(pid, { value: startedAt, checkedAt: Date.now() })
  return startedAt
}

function isSameProcessInstance(owner: any): boolean {
  const pid = Number(owner?.ownerPid)
  if (!isProcessAlive(pid)) return false
  const claimedStartedAt = Date.parse(String(owner?.ownerStartedAt || ''))
  if (!Number.isFinite(claimedStartedAt)) return true
  const observedStartedAt = observedProcessStartedAt(pid)
  if (!observedStartedAt) return true
  return Math.abs(Date.parse(observedStartedAt) - claimedStartedAt) < 5_000
}

function releaseOwnedLock(lock: string, token: string): void {
  try {
    const owner = JSON.parse(readFileSync(lock, 'utf8'))
    if (owner?.token === token) unlinkSync(lock)
  } catch {}
}

function quarantineObservedLock(lock: string, observed: string): boolean {
  const quarantine = `${lock}.recovered-${process.pid}-${randomUUID()}`
  try { renameSync(lock, quarantine) } catch { return false }
  try {
    if (readFileSync(quarantine, 'utf8') !== observed) {
      try { renameSync(quarantine, lock) } catch {}
      return false
    }
    unlinkSync(quarantine)
    return true
  } catch {
    try { renameSync(quarantine, lock) } catch {}
    return false
  }
}

export function withItemsLock<T>(path: string, operation: () => T): T {
  const lock = `${path}.lock`
  let fd: number | undefined
  let token = ''
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      token = randomUUID()
      fd = openSync(lock, 'wx')
      writeFileSync(fd, JSON.stringify({ ownerPid: process.pid, ownerStartedAt: PROCESS_STARTED_AT, token }), 'utf8')
      break
    } catch {
      if (fd !== undefined) {
        try { closeSync(fd) } catch {}
        fd = undefined
        releaseOwnedLock(lock, token)
      }
      try {
        const observed = readFileSync(lock, 'utf8')
        const owner = JSON.parse(observed)
        if (Number.isSafeInteger(owner?.ownerPid) && !isSameProcessInstance(owner)) {
          quarantineObservedLock(lock, observed)
          continue
        }
        // 有合法且仍存活的 owner 时绝不按年龄拆锁。
      } catch {
        try {
          if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) {
            const observed = readFileSync(lock, 'utf8')
            quarantineObservedLock(lock, observed)
          }
        } catch {}
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
  }
  if (fd === undefined) throw new Error('ITEMS_STORE_BUSY')
  try {
    return operation()
  } finally {
    closeSync(fd)
    releaseOwnedLock(lock, token)
  }
}

const itemsCacheByPath = new Map<string, any[]>()
// Tracks the on-disk mtime at the time each cache entry was loaded, so an external
// writer (nightly cron, batch scripts) that rewrites items_store.json is picked up
// instead of serving a stale in-memory snapshot.
const itemsMtimeByPath = new Map<string, number>()

function readItems(path: string): any[] {
  let fileMtime = 0
  try { fileMtime = statSync(path).mtimeMs } catch { fileMtime = 0 }
  let items = itemsCacheByPath.get(path)
  if (items === undefined || itemsMtimeByPath.get(path) !== fileMtime) {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (!Array.isArray(parsed)) throw new Error('ITEMS_STORE_NOT_ARRAY')
    items = parsed
    itemsCacheByPath.set(path, items)
    itemsMtimeByPath.set(path, fileMtime)
  }
  const ids = new Set(items.map(item => item?.id))
  if (ids.size !== items.length) throw new Error('DUPLICATE_CUSTOMER_ID')
  return items
}

export function replaceFileWithRetry(
  temp: string,
  path: string,
  rename: (from: string, to: string) => void = renameSync,
  wait: (ms: number) => void = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
): void {
  for (let attempt = 0; ; attempt++) {
    try { rename(temp, path); return } catch (error: any) {
      if (attempt >= 19 || !['EPERM', 'EBUSY', 'EACCES'].includes(String(error?.code || ''))) throw error
      wait(100)
    }
  }
}
export function readItemsAtomic(path = ITEMS_STORE_FILE): any[] {
  return withItemsLock(path, () => structuredClone(readItems(path)))
}

// Internal isolated-store primitive: the caller supplies scope checks and must
// not expose this primitive directly as a customer-facing mutation API.
export function updateScopedItemAtomic(path: string, id: string, expectedRevision: number, validateStore: (items:any[])=>void, mutate:(item:any)=>any) {
  if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0) throw new Error('INVALID_REVISION')
  return withItemsLock(path,()=>{
    const items=readItems(path)
    validateStore(items)
    const index=items.findIndex(item=>item?.id===id)
    if(index<0) throw new Error('ITEM_NOT_FOUND')
    const before=items[index], revision=Number.isSafeInteger(before.serverRevision)?before.serverRevision:0
    if(revision!==expectedRevision) throw new Error('ITEM_REVISION_CONFLICT')
    const after=mutate(structuredClone(before))
    if(!after||after.id!==id) throw new Error('ITEM_ID_CHANGED')
    assertProtectedHistoryUnchanged(before,after,false)
    if(JSON.stringify(before)===JSON.stringify(after))return {item:before,revision,changed:false}
    const next=[...items];next[index]={...after,serverRevision:revision+1}
    validateStore(next)
    writeItems(path,next)
    return {item:next[index],revision:revision+1,changed:true}
  })
}

// Trusted recovery-only primitive. Evidence is append-only and keyed by the
// provider message, recipient and outcome; it does not run eligibility logic.
export function appendScopedRecoveryAtomic(path:string,id:string,validateStore:(items:any[])=>void,evidence:Record<string,unknown>,routing?:Record<string,unknown>,refresh?:(item:any)=>any) {
  const message=String(evidence.testMessageId||''),email=String(evidence.email||'').trim().toLowerCase(),result=String(evidence.result||'')
  if(!message||!email||!result||evidence.source!=='isolated_test_mail_queue')throw new Error('INVALID_RECOVERY_EVIDENCE')
  return withItemsLock(path,()=>{
    const items=readItems(path);validateStore(items)
    const index=items.findIndex(item=>item?.id===id);if(index<0)throw new Error('ITEM_NOT_FOUND')
    const before=items[index],list=Array.isArray(before.emailVerificationEvidence)?before.emailVerificationEvidence:[]
    const exists=list.some((x:any)=>String(x?.testMessageId||'')===message && String(x?.email||'').trim().toLowerCase()===email && String(x?.result||'')===result)
    const previousRouting=Array.isArray(before.emailVerificationRouting)?before.emailVerificationRouting:[]
    if(routing&&String(routing.email||'').trim().toLowerCase()!==email)throw new Error('RECOVERY_ROUTING_MISMATCH')
    const routed=routing?[...previousRouting.filter((x:any)=>String(x?.email||'').trim().toLowerCase()!==email),structuredClone(routing)]:previousRouting
    if(exists&&JSON.stringify(routed)===JSON.stringify(previousRouting)&&(!routing||before.specificEmailVerified===false))return {changed:false}
    const updated={...before,emailVerificationEvidence:exists?list:[...list,structuredClone(evidence)],...(routing?{emailVerificationRouting:routed,specificEmailVerified:false}:{})}
    const refreshed=refresh?refresh(updated):updated
    const next=[...items];next[index]={...refreshed,serverRevision:(Number.isSafeInteger(before.serverRevision)?before.serverRevision:0)+1}
    validateStore(next);writeItems(path,next);return {changed:true}
  })
}

// 无锁直读：写路径是 temp+rename 原子替换，读方拿到的一定是完整文件（旧版或新版）。
// 供常驻消费者（testmail-dns-verify/testmail-enqueue-consumer）扫描用，避免与
// search-api 旧 housekeeping 的 2-6 分钟 full-refresh 长持锁互相死锁。
export function readItemsDirect(path = ITEMS_STORE_FILE): any[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(parsed)) throw new Error('ITEMS_STORE_NOT_ARRAY')
  return parsed
}

function writeItems(path: string, items: any[]): void {
  if(resolve(path).toLowerCase()===resolve(ITEMS_STORE_FILE).toLowerCase() && businessSplitActive() && items.some(item=>classifyCustomer(item)!=='furniture')) throw new Error('BUSINESS_STORE_CONTAMINATED')
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(temp, `${JSON.stringify(items, null, 2)}\n`, 'utf8')
  // Windows: renameSync 在目标文件被其它进程瞬间打开读时会抛 EPERM（search-api 旧内存
  // 的 loadMainItems/readFileSync 每 tick 读 items_store.json）。短暂重试而非直接失败，
  // 保证锁内短写的原子替换可靠落地。
  replaceFileWithRetry(temp, path)
  itemsCacheByPath.set(path, items)
  try { itemsMtimeByPath.set(path, statSync(path).mtimeMs) } catch {}
}

function normalizeForStorage(item: any, now: Date): any {
  const identified = stampCrmIdentity(item)
  const routed = applyEligibilityStage(identified, now, {
    formalSentEmails: getFormalSentEmailsCached(),
    testMailVerdicts: getTestMailVerdictsCached(),
  }).item
  const active = isActiveCrmMaster(identified)
  // 阶段唯一来自 applyEligibilityStage（其隔离权威已含 CRM 主体状态，见 itemIsolation.ts）。
  // 此处不再用 isActiveCrmMaster 反向覆盖 primaryStage：那会与 updateItemsAtomic 形成两套口径。
  const primaryStage = String(routed?.primaryStage || 'data_enrichment_needed')
  return {
    ...routed,
    ...(!active ? { activeWorkflow: false, inactiveWorkflow: true } : {}),
    primaryStage,
    normalizedStage: primaryStage,
    currentAllowedStage: primaryStage,
    displayTags: buildChineseTags(routed),
  }
}

export function updateItemsAtomic(
  mutator: (items: any[]) => any[],
  path = ITEMS_STORE_FILE,
  now = new Date(),
  options: { refreshOnlyMutated?: boolean; skipEligibilityRefresh?: boolean; preserveCommandLogFromMutator?: boolean; formalSentEmails?: ReadonlySet<string>; testMailVerdicts?: ReadonlyMap<string, TestMailVerdict>; preserveUnmutated?: boolean } = {},
) {
  return withItemsLock(path, () => {
    const current = readItems(path)
    const before = current.length
    const source = structuredClone(current)
    const changed = mutator(source)
    if (!Array.isArray(changed) || changed.length !== before) throw new Error('CUSTOMER_COUNT_CHANGED')
    const currentById = new Map(current.map(item => [item.id, item]))
    const ids = new Set(changed.map(item => item.id))
    if (ids.size !== changed.length || changed.some(item => !currentById.has(item.id))) throw new Error('DUPLICATE_OR_CHANGED_CUSTOMER_ID')
    const formalSentEmails = options.formalSentEmails ?? getFormalSentEmailsCached()
    const testMailVerdicts = options.testMailVerdicts ?? getTestMailVerdictsCached()
    const eligibilityCtx = { formalSentEmails, testMailVerdicts }
    // refreshOnlyMutated: only re-run the (expensive, ~150ms/item) eligibility stamp for items the
    // mutator actually replaced (reference inequality vs the cloned source). Untouched items keep
    // their existing stamps. Opt-in so all pre-existing callers keep the full-refresh behavior.
    const routed = options.skipEligibilityRefresh
      ? changed
      : options.refreshOnlyMutated
        ? changed.map((item, index) => (item === source[index] ? item : applyEligibilityStage(item, now, eligibilityCtx).item))
        : changed.map(item => applyEligibilityStage(item, now, eligibilityCtx).item)
    const saved = routed.map((item, index) => {
      if (options.preserveUnmutated && item === source[index] && JSON.stringify(item) === JSON.stringify(current[index])) return current[index]
      const prior = currentById.get(item.id)
      const priorRevision = Number.isSafeInteger(prior?.serverRevision) ? Number(prior.serverRevision) : 0
      const commandLog = Array.isArray(prior?.serverCommandLog) ? prior.serverCommandLog : []
      const candidateCommandLog = options.preserveCommandLogFromMutator && Array.isArray(item?.serverCommandLog) ? item.serverCommandLog : commandLog
      const candidate = { ...item, serverRevision: priorRevision, serverCommandLog: candidateCommandLog }
      const comparablePrior = { ...prior, serverCommandLog: Array.isArray(prior?.serverCommandLog) ? prior.serverCommandLog : [] }
      if (JSON.stringify(comparablePrior) === JSON.stringify(candidate)) return prior
      return { ...candidate, serverRevision: priorRevision + 1 }
    })
    // 内容未变（每个 item 都还是原引用）时跳过整文件重写：避免无意义写盘改变 mtime，
    // 让 search-api 的 loadMainCache / 序列化缓存 / dashboard 阶段计数保持命中，减少事件循环争抢。
    if (saved.length === current.length && saved.every((item, index) => item === current[index])) return saved
    writeItems(path, saved)
    return saved
  })
}

export interface ExactItemCommandOptions {
  expectedRevision: number
  commandId: string
  commandFingerprint: string
  actor: string
  now?: Date
  allowCreate?: boolean
  duplicatePolicy?: 'reuse_search_identity'
}

type ExactItemCommandLog = {
  commandId: string
  fingerprint: string
  actor: string
  expectedRevision: number
  revision: number
  recordedAt: string
}

function substantiveHistory(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0
  if (value && typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0
  return value !== undefined && value !== null && value !== ''
}

function normalizedHistory(value: unknown): unknown {
  return substantiveHistory(value) ? value : undefined
}

function normalizeTimeline(before: any, changedItem: any, creating: boolean, actor: string, now: Date): any[] {
  const prior = Array.isArray(before?.timeline) ? before.timeline : []
  const incoming = Array.isArray(changedItem?.timeline) ? changedItem.timeline : []
  if (creating && incoming.length > 0) throw new Error('ITEM_TIMELINE_PROTECTED')
  if (incoming.length < prior.length || incoming.length - prior.length > 10) throw new Error('ITEM_TIMELINE_PROTECTED')
  if (JSON.stringify(incoming.slice(0, prior.length)) !== JSON.stringify(prior)) throw new Error('ITEM_TIMELINE_PROTECTED')
  const additions = incoming.slice(prior.length).map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('ITEM_TIMELINE_INVALID')
    const stageId = typeof entry.stageId === 'string' ? entry.stageId.trim() : ''
    const entered = typeof entry.enteredAt === 'string' ? new Date(entry.enteredAt) : new Date(NaN)
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(stageId) || !Number.isFinite(entered.getTime())) throw new Error('ITEM_TIMELINE_INVALID')
    const normalized: Record<string, string> = { stageId, enteredAt: now.toISOString(), actor }
    if (typeof entry.note === 'string' && entry.note.trim()) normalized.note = entry.note.trim().slice(0, 500)
    return normalized
  })
  return [...prior, ...additions]
}
function assertProtectedHistoryUnchanged(before: any, changedItem: any, creating: boolean): void {
  for (const field of SERVER_OWNED_HISTORY_FIELDS) {
    const nextValue = changedItem?.[field]
    if (creating ? substantiveHistory(nextValue) : JSON.stringify(normalizedHistory(before?.[field])) !== JSON.stringify(normalizedHistory(nextValue))) {
      throw new Error('ITEM_HISTORY_FIELD_PROTECTED')
    }
  }
}

export function updateOneItemAtomic(
  itemId: string,
  mutator: (item: any) => any,
  path = ITEMS_STORE_FILE,
  command?: ExactItemCommandOptions,
): { item: any; items: any[]; changed: boolean; revision?: number; idempotent?: boolean; reusedExisting?: boolean } {
  return withItemsLock(path, () => {
    const current = readItems(path)
    const index = current.findIndex(item => item?.id === itemId)
    if (index < 0 && !(command?.allowCreate && command.expectedRevision === 0)) throw new Error('ITEM_NOT_FOUND')
    const creating = index < 0
    const before = creating ? { id: itemId, serverRevision: 0 } : current[index]
    const revision = Number.isSafeInteger(before.serverRevision) ? Number(before.serverRevision) : 0
    const commandLog: ExactItemCommandLog[] = Array.isArray(before.serverCommandLog) ? before.serverCommandLog : []

    if (command) {
      const prior = commandLog.find(entry => entry?.commandId === command.commandId)
      if (prior) {
        if (prior.fingerprint !== command.commandFingerprint) throw new Error('COMMAND_ID_CONFLICT')
        return { item: before, items: current, changed: false, revision, idempotent: true }
      }
      if (revision !== command.expectedRevision) throw new Error('ITEM_REVISION_CONFLICT')
      const changedItem = mutator(structuredClone(before))
      if (!changedItem || typeof changedItem !== 'object') throw new Error('ITEM_MUTATION_INVALID')
      if (changedItem.id !== itemId) throw new Error('ITEM_ID_CHANGED')
      assertProtectedHistoryUnchanged(before, changedItem, creating)
      changedItem.timeline = normalizeTimeline(before, changedItem, creating, command.actor, command.now || new Date())
      const nextRevision = revision + 1
      const entry: ExactItemCommandLog = {
        commandId: command.commandId,
        fingerprint: command.commandFingerprint,
        actor: command.actor,
        expectedRevision: command.expectedRevision,
        revision: nextRevision,
        recordedAt: (command.now || new Date()).toISOString(),
      }
      const routedItem = normalizeForStorage(changedItem, command.now || new Date())
      const savedItem = {
        ...routedItem,
        serverRevision: nextRevision,
        serverCommandLog: [...commandLog, entry].slice(-100),
      }
      const next = [...current]
      if (creating) {
        const duplicateIndex = current.findIndex(item => isActiveCrmMaster(item) && item?.crmCompanyKey && item.crmCompanyKey === savedItem.crmCompanyKey)
        if (duplicateIndex >= 0) {
          // Search rediscovery is a no-op against the existing identity, not a
          // new import/merge audit. Keep the master and its metadata untouched.
          if (command.duplicatePolicy === 'reuse_search_identity') {
            const master = current[duplicateIndex]
            return { item: master, items: current, changed: false, revision: Number.isSafeInteger(master.serverRevision) ? master.serverRevision : 0, reusedExisting: true }
          }
          const merged = mergeCrmCompanies([current[duplicateIndex], savedItem], command.now || new Date(), { preferredMasterId: current[duplicateIndex].id }).items
          const master = merged.find(item => !item.crmMergedInto)!
          const archivedIncoming = merged.find(item => item.id === itemId)!
          const priorMasterRevision = Number.isSafeInteger(current[duplicateIndex]?.serverRevision) ? Number(current[duplicateIndex].serverRevision) : 0
          next[duplicateIndex] = { ...master, serverRevision: priorMasterRevision + 1 }
          next.push(archivedIncoming)
          writeItems(path, next)
          return { item: archivedIncoming, items: next, changed: true, revision: nextRevision, idempotent: false }
        }
        next.push(savedItem)
      } else next[index] = savedItem
      writeItems(path, next)
      return { item: savedItem, items: next, changed: true, revision: nextRevision, idempotent: false }
    }

    const changedItem = mutator(structuredClone(before))
    if (!changedItem || typeof changedItem !== 'object') throw new Error('ITEM_MUTATION_INVALID')
    if (changedItem.id !== itemId) throw new Error('ITEM_ID_CHANGED')
    const routedItem = normalizeForStorage(changedItem, new Date())
    const changed = JSON.stringify(before) !== JSON.stringify(routedItem)
    if (!changed) return { item: before, items: current, changed: false, revision }
    const nextRevision = revision + 1
    const savedItem = { ...routedItem, serverRevision: nextRevision, serverCommandLog: commandLog }
    const next = [...current]
    next[index] = savedItem
    writeItems(path, next)
    return { item: savedItem, items: next, changed: true, revision: nextRevision, idempotent: false }
  })
}
