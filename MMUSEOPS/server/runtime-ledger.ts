import { randomUUID } from 'node:crypto'
import { DatabaseSync, type StatementResultingChanges } from 'node:sqlite'

const MAX_STORED_BYTES = 8 * 1024
const BUSY_TIMEOUT_MS = 5_000
const STATUS_RUNNING = '运行中' as const
const STATUS_IDLE = '空闲' as const
const STATUS_RETRY_WAIT = '重试等待' as const
const STATUS_PARTIAL_FAILURE = '部分失败' as const

type WorkerStatus = typeof STATUS_RUNNING | typeof STATUS_IDLE | typeof STATUS_RETRY_WAIT | typeof STATUS_PARTIAL_FAILURE

export interface LeaseHandle {
  name: string
  token: string
}

export interface WorkerSnapshot {
  name: string
  status: WorkerStatus
  leaseUntil: string | null
  lastStartedAt: string | null
  lastSuccessAt: string | null
  lastFailureAt: string | null
  lastError: string | null
  nextRetryAt: string | null
  consecutiveFailures: number
  lastResult: unknown
}

interface WorkerRow {
  name: string
  status: WorkerStatus
  lease_until: string | null
  last_started_at: string | null
  last_success_at: string | null
  last_failure_at: string | null
  last_error: string | null
  next_retry_at: string | null
  consecutive_failures: number
  last_result_json: string | null
}

function truncateUtf8(value: string): string {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= MAX_STORED_BYTES) return value

  let end = MAX_STORED_BYTES
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1
  return bytes.subarray(0, end).toString('utf8')
}

function serializeResult(result: unknown): string | null {
  if (result === undefined) return null
  try {
    return truncateUtf8(JSON.stringify(result))
  } catch {
    return truncateUtf8(String(result))
  }
}

function serializeError(error: unknown): string {
  if (error instanceof Error) return truncateUtf8(error.message)
  if (typeof error === 'string') return truncateUtf8(error)
  try {
    return truncateUtf8(JSON.stringify(error))
  } catch {
    return truncateUtf8(String(error))
  }
}

function parseResult(value: string | null): unknown {
  if (value === null) return null
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function normalizeTimestamp(value: string | Date, label: string): string {
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime()
  if (!Number.isFinite(timestamp)) {
    throw new TypeError(`${label} must be a valid timestamp`)
  }
  return new Date(timestamp).toISOString()
}

function calculateLeaseUntil(now: string, leaseMs: number): string {
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
    throw new TypeError('leaseMs must be finite and greater than zero')
  }

  const leaseUntil = new Date(new Date(now).getTime() + leaseMs)
  if (!Number.isFinite(leaseUntil.getTime())) {
    throw new TypeError('leaseMs produces an invalid lease timestamp')
  }
  return leaseUntil.toISOString()
}

function assertActiveLeaseUpdated(result: StatementResultingChanges, name: string): void {
  if (Number(result.changes) !== 1) {
    throw new Error(`LEASE_NOT_OWNED: No active lease owned by this handle for worker: ${name}`)
  }
}

export class RuntimeLedger {
  private readonly database: DatabaseSync
  private closed = false

  constructor(dbPath: string) {
    const database = new DatabaseSync(dbPath)
    this.database = database
    try {
      database.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`)
      database.exec('PRAGMA journal_mode=WAL')
      database.exec(`
        CREATE TABLE IF NOT EXISTS worker_state (
          name TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          lease_until TEXT,
          lease_owner TEXT,
          last_started_at TEXT,
          last_success_at TEXT,
          last_failure_at TEXT,
          last_error TEXT,
          next_retry_at TEXT,
          consecutive_failures INTEGER NOT NULL,
          last_result_json TEXT
        )
      `)

      let migrationOpen = false
      try {
        database.exec('BEGIN IMMEDIATE')
        migrationOpen = true
        const columns = database.prepare('PRAGMA table_info(worker_state)').all() as Array<{ name: string }>
        if (!columns.some(column => column.name === 'lease_owner')) {
          database.exec('ALTER TABLE worker_state ADD COLUMN lease_owner TEXT')
        }
        database.exec('COMMIT')
        migrationOpen = false
      } catch (error) {
        if (migrationOpen) {
          try {
            database.exec('ROLLBACK')
          } catch {
            // The constructor's outer failure path still closes the connection.
          }
        }
        throw error
      }
    } catch (error) {
      database.close()
      throw error
    }
  }

  claim(name: string, now: string | Date, leaseMs: number): LeaseHandle | null {
    const normalizedNow = normalizeTimestamp(now, 'now')
    const leaseUntil = calculateLeaseUntil(normalizedNow, leaseMs)
    const token = randomUUID()
    const result = this.database.prepare(`
      INSERT INTO worker_state (
        name, status, lease_until, lease_owner, last_started_at, consecutive_failures
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        status = excluded.status,
        lease_until = excluded.lease_until,
        lease_owner = excluded.lease_owner,
        last_started_at = excluded.last_started_at
      WHERE (worker_state.lease_until IS NULL OR worker_state.lease_until <= ?)
        AND (worker_state.next_retry_at IS NULL OR worker_state.next_retry_at <= ?)
    `).run(name, STATUS_RUNNING, leaseUntil, token, normalizedNow, 0, normalizedNow, normalizedNow)
    return Number(result.changes) === 1 ? { name, token } : null
  }

  renew(handle: LeaseHandle, now: string | Date, leaseMs: number): boolean {
    const normalizedNow = normalizeTimestamp(now, 'now')
    const leaseUntil = calculateLeaseUntil(normalizedNow, leaseMs)
    const update = this.database.prepare(`
      UPDATE worker_state SET lease_until = ?
      WHERE name = ? AND status = ? AND lease_owner = ?
    `).run(leaseUntil, handle.name, STATUS_RUNNING, handle.token)
    return Number(update.changes) === 1
  }

  succeed(handle: LeaseHandle, now: string | Date, result: unknown): void {
    const normalizedNow = normalizeTimestamp(now, 'now')
    const update = this.database.prepare(`
      UPDATE worker_state SET
        status = ?,
        lease_until = NULL,
        lease_owner = NULL,
        last_success_at = ?,
        last_error = NULL,
        next_retry_at = NULL,
        consecutive_failures = ?,
        last_result_json = ?
      WHERE name = ? AND status = ? AND lease_owner = ?
    `).run(STATUS_IDLE, normalizedNow, 0, serializeResult(result), handle.name, STATUS_RUNNING, handle.token)
    assertActiveLeaseUpdated(update, handle.name)
  }

  partialFail(handle: LeaseHandle, now: string | Date, result: unknown, retryAt: string | Date): void {
    const normalizedNow = normalizeTimestamp(now, 'now')
    const normalizedRetryAt = normalizeTimestamp(retryAt, 'retryAt')
    const detail = result && typeof result === 'object' && Array.isArray((result as Record<string, unknown>).apiErrorDetails)
      ? (result as Record<string, unknown>).apiErrorDetails!.filter(value => typeof value === 'string').slice(0, 5).join(' | ').slice(0, 7_800)
      : ''
    const error = detail ? `部分任务失败: ${detail}` : '部分任务失败'
    const update = this.database.prepare(`
      UPDATE worker_state SET
        status = ?, lease_until = NULL, lease_owner = NULL,
        last_failure_at = ?, last_error = ?, next_retry_at = ?,
        consecutive_failures = consecutive_failures + 1, last_result_json = ?
      WHERE name = ? AND status = ? AND lease_owner = ?
    `).run(STATUS_PARTIAL_FAILURE, normalizedNow, error, normalizedRetryAt, serializeResult(result), handle.name, STATUS_RUNNING, handle.token)
    assertActiveLeaseUpdated(update, handle.name)
  }

  fail(handle: LeaseHandle, now: string | Date, error: unknown, retryAt: string | Date): void {
    const normalizedNow = normalizeTimestamp(now, 'now')
    const normalizedRetryAt = normalizeTimestamp(retryAt, 'retryAt')
    const update = this.database.prepare(`
      UPDATE worker_state SET
        status = ?,
        lease_until = NULL,
        lease_owner = NULL,
        last_failure_at = ?,
        last_error = ?,
        next_retry_at = ?,
        consecutive_failures = consecutive_failures + ?
      WHERE name = ? AND status = ? AND lease_owner = ?
    `).run(
      STATUS_RETRY_WAIT,
      normalizedNow,
      serializeError(error),
      normalizedRetryAt,
      1,
      handle.name,
      STATUS_RUNNING,
      handle.token,
    )
    assertActiveLeaseUpdated(update, handle.name)
  }

  release(handle: LeaseHandle, now: string | Date): void {
    const normalizedNow = normalizeTimestamp(now, 'now')
    const update = this.database.prepare(`
      UPDATE worker_state SET
        status = ?,
        lease_until = NULL,
        lease_owner = NULL,
        next_retry_at = NULL
      WHERE name = ?
        AND status = ?
        AND lease_owner = ?
        AND (last_started_at IS NULL OR last_started_at <= ?)
    `).run(STATUS_IDLE, handle.name, STATUS_RUNNING, handle.token, normalizedNow)
    assertActiveLeaseUpdated(update, handle.name)
  }

  snapshot(): WorkerSnapshot[] {
    const rows = this.database.prepare(`
      SELECT
        name,
        status,
        lease_until,
        last_started_at,
        last_success_at,
        last_failure_at,
        last_error,
        next_retry_at,
        consecutive_failures,
        last_result_json
      FROM worker_state
      ORDER BY name
    `).all() as unknown as WorkerRow[]

    return rows.map(row => ({
      name: row.name,
      status: row.status,
      leaseUntil: row.lease_until,
      lastStartedAt: row.last_started_at,
      lastSuccessAt: row.last_success_at,
      lastFailureAt: row.last_failure_at,
      lastError: row.last_error,
      nextRetryAt: row.next_retry_at,
      consecutiveFailures: Number(row.consecutive_failures),
      lastResult: parseResult(row.last_result_json),
    }))
  }

  close(): void {
    if (this.closed) return
    this.database.close()
    this.closed = true
  }
}
