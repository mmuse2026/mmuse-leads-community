import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { addIsolationBatch, type IsolationEntry } from './isolation-store'

export interface WorkerWebhookEvent {
  event_seq: number
  svix_id: string
  event_type: string
  event_created_at?: string | null
  received_at?: string | null
  email_id?: string | null
  message_id?: string | null
  correlation_id?: string | null
  customer_id?: string | null
  recipient_hash?: string | null
  recipient_masked?: string | null
  mail_role?: 'test' | 'formal' | 'unknown' | string
  payload_minimal?: string | null
}

export interface WebhookSyncState {
  cursor: number
  processedEventIds: string[]
  lastSyncAt?: string
  lastSuccessAt?: string
  lastError?: string
  workerStatus?: {
    backlog: number
    errors: number
    latestEventAt?: string | null
  }
  lastStats?: WebhookApplyStats
}

export interface WebhookApplyStats {
  pulled: number
  processed: number
  duplicates: number
  delivered: number
  bounced: number
  failed: number
  replied: number
  delayed: number
  suppressed: number
  unmatched: number
}

export interface WebhookApplyResult {
  items: any[]
  unmatched: WorkerWebhookEvent[]
  acknowledgedIds: string[]
  processedEventIds: string[]
  stats: WebhookApplyStats
  isolation: IsolationEntry[]
}

export interface WebhookSyncPaths {
  stateFile: string
  unmatchedFile: string
  reportFile: string
}

const DEFAULT_WORKER_URL = 'https://mmuseops-resend-webhook.kenkowang6.workers.dev'
const MAX_PROCESSED_EVENT_IDS = 5000

const normalize = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : ''

const list = <T = any>(value: unknown): T[] => Array.isArray(value) ? value : []

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function itemEmails(item: any): string[] {
  const candidates = [
    item.email,
    ...list(item.contacts).map((contact: any) => contact?.email),
    ...list(item.backCheck?.decisionMakers).map((contact: any) => contact?.email),
    ...list(item.emailVerificationEvidence).map((entry: any) => entry?.email),
  ]
  return [...new Set(candidates.map(normalize).filter((value) => value.includes('@')))]
}

function eventIdentifiers(event: WorkerWebhookEvent): string[] {
  return [event.email_id, event.message_id, event.correlation_id]
    .map(normalize)
    .filter(Boolean)
}

function itemIdentifiers(item: any): string[] {
  const evidenceIds = list(item.emailVerificationEvidence).flatMap((entry: any) => [
    entry?.testMessageId,
    entry?.messageId,
    entry?.correlationId,
    entry?.recoveryCorrelationId,
  ])
  const logIds = list(item.emailLogs).flatMap((entry: any) => [
    entry?.messageId,
    entry?.correlationId,
  ])
  return [...new Set([...evidenceIds, ...logIds].map(normalize).filter(Boolean))]
}

function findMatchingItem(items: any[], event: WorkerWebhookEvent): any | undefined {
  const customerId = normalize(event.customer_id)
  if (customerId) {
    const direct = items.find((item) => normalize(item.id) === customerId)
    if (direct) return direct
  }

  const identifiers = new Set(eventIdentifiers(event))
  if (identifiers.size > 0) {
    const byIdentifier = items.find((item) =>
      itemIdentifiers(item).some((identifier) => identifiers.has(identifier)))
    if (byIdentifier) return byIdentifier
  }

  const recipientHash = normalize(event.recipient_hash)
  if (recipientHash) {
    return items.find((item) =>
      itemEmails(item).some((email) => sha256(email) === recipientHash))
  }
  return undefined
}

function matchedEmail(item: any, event: WorkerWebhookEvent): string {
  const identifiers = new Set(eventIdentifiers(event))
  const matchingEvidence = [...list(item.emailVerificationEvidence)].reverse().find((entry: any) =>
    [entry?.testMessageId, entry?.messageId, entry?.correlationId, entry?.recoveryCorrelationId]
      .map(normalize)
      .some((identifier) => identifiers.has(identifier)))
  if (matchingEvidence?.email) return normalize(matchingEvidence.email)

  const recipientHash = normalize(event.recipient_hash)
  if (recipientHash) {
    const byHash = itemEmails(item).find((email) => sha256(email) === recipientHash)
    if (byHash) return byHash
  }
  return normalize(item.email)
}

function upsertRouting(item: any, email: string, queue: string, reason: string, now: string): void {
  const routing = list(item.emailVerificationRouting)
  item.emailVerificationRouting = [
    ...routing.filter((entry: any) => normalize(entry?.email) !== email),
    { email, queue, reason, updatedAt: now },
  ]
}

function appendEvidence(
  item: any,
  event: WorkerWebhookEvent,
  email: string,
  result: string,
  recoveryStatus: string,
  now: string,
): void {
  const evidence = list(item.emailVerificationEvidence)
  if (evidence.some((entry: any) => entry?.webhookEventId === event.svix_id)) return
  item.emailVerificationEvidence = [...evidence, {
    email,
    result,
    scope: 'delivery',
    source: 'isolated_test_mail',
    method: 'resend_webhook_worker',
    checkedAt: event.event_created_at || event.received_at || now,
    correlationId: event.correlation_id || undefined,
    recoveryCorrelationId: event.correlation_id || undefined,
    testMessageId: event.email_id || event.message_id || undefined,
    recoveryStatus,
    webhookEventId: event.svix_id,
    webhookEventType: event.event_type,
    note: 'Webhook event synchronized from Cloudflare D1.',
  }]
}

function applyMatchedEvent(
  item: any,
  event: WorkerWebhookEvent,
  now: string,
  stats: WebhookApplyStats,
  isolation: IsolationEntry[],
): void {
  const email = matchedEmail(item, event)
  const isTestMail = event.mail_role === 'test'
  const eventAt = event.event_created_at || event.received_at || now

  switch (event.event_type) {
    case 'email.delivered':
      appendEvidence(item, event, email, isTestMail ? 'test_sent' : 'delivered', isTestMail ? 'watching' : 'unknown', now)
      if (isTestMail) upsertRouting(item, email, 'observation_queue', 'Delivered; observation window remains active.', now)
      stats.delivered += 1
      break
    case 'email.bounced':
      appendEvidence(item, event, email, isTestMail ? 'bounced_test' : 'bounced', 'bounced', now)
      upsertRouting(item, email, isTestMail ? 'unreachable' : 'bounced_queue', 'Webhook reported a bounce.', now)
      if (isTestMail) item.emailBounced = true
      isolation.push({
        objectType: 'email',
        objectValue: email,
        reason: 'hard_bounce',
        sourceStage: isTestMail ? 'replace_contact_queue' : 'bounced_queue',
        isolatedAt: eventAt,
        originalCustomerId: String(item.id || ''),
        permanent: true,
        note: 'Webhook reported a bounce.',
      })
      stats.bounced += 1
      break
    case 'email.failed':
      appendEvidence(item, event, email, 'failed', 'unknown', now)
      upsertRouting(item, email, isTestMail ? 'unreachable' : 'send_failed_queue', 'Webhook reported delivery failure.', now)
      stats.failed += 1
      break
    case 'email.delivery_delayed':
      appendEvidence(item, event, email, 'unknown', 'watching', now)
      upsertRouting(item, email, 'retry_queue', 'Delivery delayed; keep observing.', now)
      stats.delayed += 1
      break
    case 'email.complained':
    case 'email.suppressed':
      appendEvidence(item, event, email, 'do_not_contact', 'unknown', now)
      upsertRouting(item, email, 'do_not_contact', 'Complaint or suppression event received.', now)
      item.doNotContact = true
      item.doNotContactAt = eventAt
      isolation.push({
        objectType: 'email',
        objectValue: email,
        reason: event.event_type === 'email.complained' ? 'complaint' : 'suppressed',
        sourceStage: 'do_not_contact',
        isolatedAt: eventAt,
        originalCustomerId: String(item.id || ''),
        permanent: true,
        note: 'Webhook reported complaint or suppression.',
      })
      stats.suppressed += 1
      break
    case 'email.received':
      appendEvidence(item, event, email, 'reply_observed', 'replied', now)
      upsertRouting(item, email, 'replied_queue', 'Inbound reply received.', now)
      item.followupQueue = list(item.followupQueue).map((task: any) =>
        task?.status === 'pending' ? { ...task, status: 'cancelled', cancelledAt: now, cancelReason: 'reply_observed' } : task)
      stats.replied += 1
      break
  }
}

export function applyWebhookEvents(
  rawItems: any[],
  events: WorkerWebhookEvent[],
  options: { processedEventIds?: string[]; now?: string } = {},
): WebhookApplyResult {
  const items = structuredClone(rawItems)
  const processed = new Set(options.processedEventIds || [])
  const unmatched: WorkerWebhookEvent[] = []
  const acknowledgedIds: string[] = []
  const now = options.now || new Date().toISOString()
  const isolation: IsolationEntry[] = []
  const stats: WebhookApplyStats = {
    pulled: events.length,
    processed: 0,
    duplicates: 0,
    delivered: 0,
    bounced: 0,
    failed: 0,
    replied: 0,
    delayed: 0,
    suppressed: 0,
    unmatched: 0,
  }

  for (const event of events) {
    if (!event?.svix_id || !event?.event_type?.startsWith('email.')) continue
    if (processed.has(event.svix_id)) {
      stats.duplicates += 1
      acknowledgedIds.push(event.svix_id)
      continue
    }
    const item = findMatchingItem(items, event)
    if (!item) {
      unmatched.push(event)
      stats.unmatched += 1
    } else {
      applyMatchedEvent(item, event, now, stats, isolation)
      stats.processed += 1
    }
    processed.add(event.svix_id)
    acknowledgedIds.push(event.svix_id)
  }

  return {
    items,
    unmatched,
    acknowledgedIds,
    processedEventIds: [...processed].slice(-MAX_PROCESSED_EVENT_IDS),
    stats,
    isolation,
  }
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    if (!existsSync(filePath)) return fallback
    return JSON.parse(readFileSync(filePath, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8')
}

function loadSyncToken(): string {
  const fromEnvironment = process.env.MMUSEOPS_SYNC_TOKEN?.trim()
  if (fromEnvironment) return fromEnvironment
  const profile = process.env.LOCALAPPDATA || ''
  const secretPath = join(profile, 'MMUSEOPS', 'secrets', 'webhook-sync-token.dpapi')
  if (!profile || !existsSync(secretPath)) throw new Error('WEBHOOK_SYNC_TOKEN_NOT_CONFIGURED')
  const command = [
    "$hex=(Get-Content -LiteralPath $env:MMUSEOPS_DPAPI_PATH -Raw).Trim()",
    "$bytes=New-Object byte[] ($hex.Length/2)",
    "for($i=0;$i -lt $bytes.Length;$i++){$bytes[$i]=[Convert]::ToByte($hex.Substring($i*2,2),16)}",
    "Add-Type -AssemblyName System.Security",
    "$plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Text.Encoding]::Unicode.GetString($plain)",
  ].join(';')
  const token = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', command],
    {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, MMUSEOPS_DPAPI_PATH: secretPath },
    },
  ).trim()
  if (!token) throw new Error('WEBHOOK_SYNC_TOKEN_NOT_CONFIGURED')
  return token
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/powershell|ProtectedData|DPAPI/i.test(message)) return 'WEBHOOK_SYNC_TOKEN_DECRYPTION_FAILED'
  return message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 300)
}

async function windowsWorkerFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  const authorization = headers.get('authorization') || ''
  const token = authorization.replace(/^Bearer\s+/i, '')
  const body = typeof init.body === 'string' ? init.body : ''
  const command = [
    "$headers=@{Authorization='Bearer '+$env:MMUSEOPS_WORKER_TOKEN}",
    "$params=@{Uri=$env:MMUSEOPS_WORKER_URL;Method=$env:MMUSEOPS_WORKER_METHOD;Headers=$headers;UseBasicParsing=$true;TimeoutSec=25}",
    "if($env:MMUSEOPS_WORKER_BODY){$params.ContentType='application/json';$params.Body=$env:MMUSEOPS_WORKER_BODY}",
    "try{$r=Invoke-WebRequest @params;@{status=[int]$r.StatusCode;body=$r.Content}|ConvertTo-Json -Compress}catch{if($_.Exception.Response){$resp=$_.Exception.Response;$reader=New-Object IO.StreamReader($resp.GetResponseStream());$content=$reader.ReadToEnd();$reader.Close();@{status=[int]$resp.StatusCode;body=$content}|ConvertTo-Json -Compress}else{throw}}",
  ].join(';')
  const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: {
      ...process.env,
      MMUSEOPS_WORKER_TOKEN: token,
      MMUSEOPS_WORKER_URL: String(input),
      MMUSEOPS_WORKER_METHOD: String(init.method || 'GET'),
      MMUSEOPS_WORKER_BODY: body,
    },
  })
  const result = JSON.parse(raw) as { status: number; body: string }
  return new Response(result.body || '', { status: result.status })
}

export async function synchronizeWorkerEvents(options: {
  mutateItems: (mutator: (items: any[]) => any[]) => any[]
  paths: WebhookSyncPaths
  isolationPath?: string
  workerUrl?: string
  fetchImpl?: typeof fetch
  tokenLoader?: () => string
  now?: string
}): Promise<{ ok: boolean; state: WebhookSyncState; stats: WebhookApplyStats; isolationAdded: number }> {
  const fetchImpl = options.fetchImpl || (process.platform === 'win32' ? windowsWorkerFetch as typeof fetch : fetch)
  const workerUrl = (options.workerUrl || process.env.MMUSEOPS_WEBHOOK_WORKER_URL || DEFAULT_WORKER_URL).replace(/\/+$/, '')
  const state = readJson<WebhookSyncState>(options.paths.stateFile, { cursor: 0, processedEventIds: [] })
  const now = options.now || new Date().toISOString()
  const emptyStats: WebhookApplyStats = {
    pulled: 0, processed: 0, duplicates: 0, delivered: 0, bounced: 0,
    failed: 0, replied: 0, delayed: 0, suppressed: 0, unmatched: 0,
  }
  try {
    const token = (options.tokenLoader || loadSyncToken)()
    const headers = { Authorization: `Bearer ${token}` }
    const eventsResponse = await fetchImpl(`${workerUrl}/api/events?after=${state.cursor || 0}&limit=100`, {
      headers,
      signal: AbortSignal.timeout(20000),
    })
    if (!eventsResponse.ok) throw new Error(`WORKER_EVENTS_HTTP_${eventsResponse.status}`)
    const payload = await eventsResponse.json() as { events?: WorkerWebhookEvent[]; nextCursor?: number }
    const events = list<WorkerWebhookEvent>(payload.events)
    let applied = applyWebhookEvents([], [], { processedEventIds: state.processedEventIds, now })
    if (events.length > 0) {
      options.mutateItems(latest => {
        applied = applyWebhookEvents(latest, events, { processedEventIds: state.processedEventIds, now })
        return applied.items
      })
    }

    let isolationAdded = 0
    if (applied.isolation.length > 0) {
      isolationAdded = addIsolationBatch(applied.isolation, options.isolationPath)
    }

    const existingUnmatched = readJson<WorkerWebhookEvent[]>(options.paths.unmatchedFile, [])
    const unmatchedById = new Map(existingUnmatched.map((entry) => [entry.svix_id, entry]))
    for (const entry of applied.unmatched) unmatchedById.set(entry.svix_id, entry)

    if (events.length > 0) {
      writeJson(options.paths.unmatchedFile, [...unmatchedById.values()])
      const ackResponse = await fetchImpl(`${workerUrl}/api/events/ack`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ svixIds: applied.acknowledgedIds }),
        signal: AbortSignal.timeout(15000),
      })
      if (!ackResponse.ok) throw new Error(`WORKER_ACK_HTTP_${ackResponse.status}`)
    }

    const statusResponse = await fetchImpl(`${workerUrl}/api/status`, { headers, signal: AbortSignal.timeout(15000) })
    const status = statusResponse.ok
      ? await statusResponse.json() as any
      : { backlog: Math.max(0, events.length), errors: 0, latestEventAt: null }
    const nextState: WebhookSyncState = {
      cursor: Number(payload.nextCursor ?? state.cursor ?? 0),
      processedEventIds: applied.processedEventIds,
      lastSyncAt: now,
      lastSuccessAt: now,
      workerStatus: {
        backlog: Number(status.backlog || 0),
        errors: Number(status.errors || 0),
        latestEventAt: status.latestEventAt || null,
      },
      lastStats: applied.stats,
    }
    writeJson(options.paths.stateFile, nextState)
    writeJson(options.paths.reportFile, {
      generatedAt: now,
      worker: { reachable: true, ...nextState.workerStatus },
      stats: applied.stats,
      cursor: nextState.cursor,
      unmatchedStored: unmatchedById.size,
    })
    return { ok: true, state: nextState, stats: applied.stats, isolationAdded }
  } catch (error) {
    const nextState: WebhookSyncState = {
      ...state,
      lastSyncAt: now,
      lastError: safeError(error),
      lastStats: state.lastStats || emptyStats,
    }
    writeJson(options.paths.stateFile, nextState)
    return { ok: false, state: nextState, stats: nextState.lastStats || emptyStats, isolationAdded: 0 }
  }
}

export function readWebhookSyncStatus(paths: WebhookSyncPaths): {
  state: WebhookSyncState
  unmatchedCount: number
} {
  return {
    state: readJson<WebhookSyncState>(paths.stateFile, { cursor: 0, processedEventIds: [] }),
    unmatchedCount: readJson<WorkerWebhookEvent[]>(paths.unmatchedFile, []).length,
  }
}
