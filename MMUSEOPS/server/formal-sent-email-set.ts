import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { buildFormalSentEmailSet } from '../src/services/poolEligibility'

export const FORMAL_SEND_QUEUE_FILE = join(__dirname, '..', 'data', 'formal_send_queue.json')

// mtime 变化才重读；且重读间隔至少 1 分钟，避免每次写库都读盘。
const MIN_CACHE_MS = 60_000
let cachedSet: ReadonlySet<string> | undefined
let cachedMtime = -1
let lastLoadedAt = 0

export function getFormalSentEmailsCached(): ReadonlySet<string> {
  const now = Date.now()
  let fileMtime = -1
  try { fileMtime = statSync(FORMAL_SEND_QUEUE_FILE).mtimeMs } catch { fileMtime = -1 }
  if (cachedSet !== undefined && cachedMtime === fileMtime) return cachedSet
  if (cachedSet !== undefined && now - lastLoadedAt < MIN_CACHE_MS) return cachedSet
  let records: any[] = []
  try {
    const parsed = JSON.parse(readFileSync(FORMAL_SEND_QUEUE_FILE, 'utf8'))
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as any).records)) records = (parsed as any).records
  } catch { records = [] }
  cachedSet = buildFormalSentEmailSet(records)
  cachedMtime = fileMtime
  lastLoadedAt = now
  return cachedSet
}
