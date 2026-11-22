import { closeSync, existsSync, linkSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

export interface FormalQueueLockMetadata { pid: number; instanceNonce: string; createdAt: string }
export interface FormalQueueLockHandle extends FormalQueueLockMetadata { path: string }
interface AcquireOptions {
  pid?: number; instanceNonce?: string; now?: Date; isProcessAlive?: (pid: number) => boolean
  invalidMetadataStaleAfterMs?: number; onAudit?: (event: 'CORRUPT_LOCK_RECLAIMED') => void
}
export function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true
  try { process.kill(pid, 0); return true } catch (error: any) { return error?.code === 'EPERM' }
}
function readMetadata(path: string): FormalQueueLockMetadata | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    if (!Number.isSafeInteger(value?.pid) || value.pid <= 0) return undefined
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(String(value?.instanceNonce || ''))) return undefined
    if (!Number.isFinite(Date.parse(String(value?.createdAt || '')))) return undefined
    return { pid: value.pid, instanceNonce: value.instanceNonce, createdAt: value.createdAt }
  } catch { return undefined }
}
export function acquireFormalQueueLock(path: string, options: AcquireOptions = {}): FormalQueueLockHandle | undefined {
  const now = options.now ?? new Date()
  const metadata: FormalQueueLockMetadata = { pid: options.pid ?? process.pid, instanceNonce: options.instanceNonce ?? randomUUID(), createdAt: now.toISOString() }
  const tryCreate = () => {
    const temp = `${path}.${metadata.pid}.${metadata.instanceNonce}.tmp`
    try {
      const fd = openSync(temp, 'wx')
      try { writeFileSync(fd, JSON.stringify(metadata), 'utf8') } finally { closeSync(fd) }
      try { linkSync(temp, path) } catch (error: any) { if (error?.code !== 'EEXIST') throw error; return undefined }
      return { path, ...metadata }
    } finally { try { unlinkSync(temp) } catch {} }
  }
  const created = tryCreate(); if (created) return created
  const owner = readMetadata(path)
  if (!owner) {
    const staleAfter = options.invalidMetadataStaleAfterMs
    let stale = false
    try { stale = Number.isFinite(staleAfter) && staleAfter! >= 0 && now.getTime() - statSync(path).mtimeMs >= staleAfter! } catch {}
    if (!stale || !options.onAudit) return undefined
    options.onAudit('CORRUPT_LOCK_RECLAIMED')
  } else if ((options.isProcessAlive ?? processIsAlive)(owner.pid)) return undefined
  try { unlinkSync(path) } catch { return undefined }
  return tryCreate()
}
export function releaseFormalQueueLock(handle: FormalQueueLockHandle): boolean {
  const owner = readMetadata(handle.path)
  if (!owner || owner.instanceNonce !== handle.instanceNonce || owner.pid !== handle.pid) return false
  try { unlinkSync(handle.path); return true } catch { return !existsSync(handle.path) }
}
