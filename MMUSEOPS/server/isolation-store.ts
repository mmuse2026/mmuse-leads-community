import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type IsolationObjectType = 'company' | 'domain' | 'email' | 'contact'

export interface IsolationEntry {
  objectType: IsolationObjectType
  objectValue: string
  reason: string
  sourceStage: string
  isolatedAt: string
  originalCustomerId: string
  permanent: boolean
  note?: string
}

interface IsolationStoreFile {
  version: 1
  updatedAt: string
  initialExcludedRegisteredAt: string | null
  entries: IsolationEntry[]
}

export const ISOLATION_STORE_FILE = join(__dirname, '..', 'data', 'isolation-store.json')

function emptyStore(): IsolationStoreFile {
  return { version: 1, updatedAt: new Date(0).toISOString(), initialExcludedRegisteredAt: null, entries: [] }
}

export function readIsolationStore(path = ISOLATION_STORE_FILE): IsolationStoreFile {
  if (!existsSync(path)) return emptyStore()
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return { ...emptyStore(), ...parsed, entries: Array.isArray(parsed?.entries) ? parsed.entries : [] }
  } catch {
    return emptyStore()
  }
}

export function writeIsolationStore(store: IsolationStoreFile, path = ISOLATION_STORE_FILE): void {
  mkdirSync(dirname(path), { recursive: true })
  const next = { ...store, updatedAt: new Date().toISOString() }
  const temp = `${path}.tmp-${process.pid}`
  writeFileSync(temp, JSON.stringify(next, null, 2), 'utf8')
  const sleep = (ms: number) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch { /* fall through */ } }
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      renameSync(temp, path)
      return
    } catch (error: any) {
      if (attempt === 4) throw error
      sleep(80 * (attempt + 1))
    }
  }
}

export function normalizeObjectValue(type: IsolationObjectType, value: string): string {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (type === 'email') return raw.toLowerCase()
  if (type === 'domain') return raw.replace(/^https?:\/\//i, '').split('/')[0].split('?')[0].replace(/^www\./i, '').toLowerCase()
  return raw.toLowerCase()
}

export function addIsolation(entry: IsolationEntry, path = ISOLATION_STORE_FILE): { added: boolean; entry?: IsolationEntry } {
  const value = normalizeObjectValue(entry.objectType, entry.objectValue)
  if (!value) throw new Error('ISOLATION_VALUE_EMPTY')
  const store = readIsolationStore(path)
  const exists = store.entries.some(e => e.objectType === entry.objectType && normalizeObjectValue(e.objectType, e.objectValue) === value)
  if (exists) return { added: false }
  const nextEntry: IsolationEntry = {
    objectType: entry.objectType,
    objectValue: value,
    reason: String(entry.reason || ''),
    sourceStage: String(entry.sourceStage || ''),
    isolatedAt: entry.isolatedAt || new Date().toISOString(),
    originalCustomerId: String(entry.originalCustomerId || ''),
    permanent: entry.permanent !== false,
    ...(entry.note ? { note: String(entry.note) } : {}),
  }
  store.entries.push(nextEntry)
  writeIsolationStore(store, path)
  return { added: true, entry: nextEntry }
}

export function addIsolationBatch(entries: IsolationEntry[], path = ISOLATION_STORE_FILE): number {
  const store = readIsolationStore(path)
  let added = 0
  const seen = new Set(store.entries.map(e => `${e.objectType}:${normalizeObjectValue(e.objectType, e.objectValue)}`))
  for (const entry of entries) {
    const value = normalizeObjectValue(entry.objectType, entry.objectValue)
    if (!value) continue
    const key = `${entry.objectType}:${value}`
    if (seen.has(key)) continue
    seen.add(key)
    store.entries.push({
      objectType: entry.objectType,
      objectValue: value,
      reason: String(entry.reason || ''),
      sourceStage: String(entry.sourceStage || ''),
      isolatedAt: entry.isolatedAt || new Date().toISOString(),
      originalCustomerId: String(entry.originalCustomerId || ''),
      permanent: entry.permanent !== false,
      ...(entry.note ? { note: String(entry.note) } : {}),
    })
    added++
  }
  if (added > 0) writeIsolationStore(store, path)
  return added
}

export function listIsolation(
  options: { q?: string; type?: string; page?: number; pageSize?: number } = {},
  path = ISOLATION_STORE_FILE,
): { total: number; items: IsolationEntry[]; page: number; pageSize: number } {
  const store = readIsolationStore(path)
  const q = String(options.q || '').trim().toLowerCase()
  const type = String(options.type || '').trim()
  let items = store.entries
  if (type) items = items.filter(e => e.objectType === type)
  if (q) items = items.filter(e => e.objectValue.toLowerCase().includes(q) || String(e.reason || '').toLowerCase().includes(q) || String(e.note || '').toLowerCase().includes(q))
  const total = items.length
  const pageSize = Math.min(200, Math.max(1, Number(options.pageSize) || 20))
  const page = Math.max(1, Number(options.page) || 1)
  const start = (page - 1) * pageSize
  const paged = items.slice(start, start + pageSize)
  return { total, items: paged, page, pageSize }
}

function dayKey(date: Date): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(date)
  } catch {
    return ''
  }
}

export function todayIsolationCount(now = new Date(), path = ISOLATION_STORE_FILE): number {
  const day = dayKey(now)
  if (!day) return 0
  return readIsolationStore(path).entries.filter(e => dayKey(new Date(e.isolatedAt)) === day).length
}

export function isolationTotal(path = ISOLATION_STORE_FILE): number {
  return readIsolationStore(path).entries.length
}

export function setInitialExcludedRegisteredAt(value: string, path = ISOLATION_STORE_FILE): void {
  const store = readIsolationStore(path)
  store.initialExcludedRegisteredAt = value
  writeIsolationStore(store, path)
}
