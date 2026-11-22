import { randomUUID } from 'node:crypto'

export type SnovioTaskStatus = 'in_progress' | 'completed' | 'failed'

export interface SnovioDomainTask {
  provider: 'snovio'
  customerId: string
  domain: string
  taskId?: string
  statusUrl?: string
  resultUrl?: string
  requestedAt: string
  status: SnovioTaskStatus
  lastPolledAt?: string
  rawResultStored: boolean
  creditsUnknown: boolean
  correlationId: string
}

export interface SnovioCandidate {
  id?: string
  name?: string
  title?: string
  email: string
  source: 'snovio_found'
  sourceUrl?: string
}

export interface ContactCandidate {
  id?: string
  name?: string
  title?: string
  email?: string
  source?: string
  sourceUrl?: string
  confidence?: string
  [key: string]: unknown
}

export interface ContactReplacement {
  replacedContactId: string
  replacementEmail: string
  reason: string
  source: 'serper_found' | 'snovio_found' | 'hunter_found' | 'prospeo_found'
  replacedAt: string
}

const ROLE_PATTERN = /\b(procurement|sourcing|purchas|buyer|supply chain|operations?|project|ff&e|furniture|category|owner|founder|director|manager|president|chief|development)\b/i
const UNRELATED_PATTERN = /\b(hr|human resources|recruit|accounting|legal|software|developer|seo|content|social media)\b/i
const GENERIC_PREFIXES = new Set(['info', 'sales', 'contact', 'support', 'hello', 'office', 'admin'])
const DEPARTMENT_PREFIXES = new Set(['procurement', 'purchasing', 'projects', 'project', 'operations', 'supplychain', 'contracts', 'trade'])

function normalizeEmail(value?: string): string {
  return String(value || '').trim().toLowerCase()
}

function emailKind(email?: string): 'personal' | 'department' | 'generic' | 'none' {
  const normalized = normalizeEmail(email)
  if (!normalized.includes('@')) return 'none'
  const prefix = normalized.split('@')[0].replace(/[._-]/g, '')
  if (GENERIC_PREFIXES.has(prefix)) return 'generic'
  if (DEPARTMENT_PREFIXES.has(prefix)) return 'department'
  return 'personal'
}

export function scoreContactCandidate(contact: ContactCandidate): number {
  const kind = emailKind(contact.email)
  const title = String(contact.title || '')
  const named = Boolean(String(contact.name || '').trim())
  const relevantRole = ROLE_PATTERN.test(title)
  const unrelatedRole = UNRELATED_PATTERN.test(title) && !relevantRole
  let score = 0
  if (kind === 'personal') score += 55
  else if (kind === 'department') score += 35
  else if (kind === 'generic') score += 10
  if (named) score += 15
  if (title) score += 8
  if (relevantRole) score += 25
  if (unrelatedRole) score -= 60
  if (!contact.source) score -= 10
  return score
}

export function createSnovioTask(input: {
  customerId: string
  domain: string
  taskId?: string
  statusUrl?: string
  resultUrl?: string
  requestedAt?: string
  correlationId?: string
}): SnovioDomainTask {
  return {
    provider: 'snovio',
    customerId: input.customerId,
    domain: input.domain.toLowerCase(),
    taskId: input.taskId,
    statusUrl: input.statusUrl,
    resultUrl: input.resultUrl,
    requestedAt: input.requestedAt || new Date().toISOString(),
    status: 'in_progress',
    rawResultStored: false,
    creditsUnknown: true,
    correlationId: input.correlationId || randomUUID(),
  }
}

export function getResumableTask(tasks: SnovioDomainTask[]): {
  ok: boolean
  task?: SnovioDomainTask
  error?: string
} {
  const task = [...tasks].reverse().find(entry =>
    entry.provider === 'snovio'
    && entry.status === 'in_progress'
    && Boolean(entry.resultUrl || entry.statusUrl))
  return task ? { ok: true, task } : { ok: false, error: 'NO_SAVED_SNOVIO_TASK_URL' }
}

export function normalizeSnovioProviderData(data: unknown, domain: string): SnovioCandidate[] {
  const normalizedDomain = domain.trim().toLowerCase()
  const candidates: SnovioCandidate[] = []
  for (const entry of Array.isArray(data) ? data : []) {
    const row = entry as Record<string, any>
    const firstName = row.firstName || row.first_name || ''
    const lastName = row.lastName || row.last_name || ''
    const shared = {
      name: String(row.name || `${firstName} ${lastName}`).trim() || undefined,
      title: String(row.position || row.title || row.jobTitle || row.job_title || '').trim() || undefined,
      source: 'snovio_found' as const,
      sourceUrl: String(row.sourceUrl || row.source_url || row.sourcePage || row.source_page || '').trim() || undefined,
    }
    const emails = [
      row.email,
      ...(Array.isArray(row.emails)
        ? row.emails.map((email: any) => typeof email === 'string' ? email : email?.email)
        : []),
    ]
    for (const value of emails) {
      const email = normalizeEmail(value)
      if (email.endsWith(`@${normalizedDomain}`)) candidates.push({ ...shared, email })
    }
  }
  return [...new Map(candidates.map(candidate => [candidate.email, candidate])).values()]
}
export function mergeSnovioCandidates(
  existingContacts: ContactCandidate[],
  candidates: ContactCandidate[],
  customerId: string,
  candidateSource: 'serper_found' | 'snovio_found' | 'hunter_found' | 'prospeo_found' = 'snovio_found',
): {
  contacts: ContactCandidate[]
  added: number
  completed: number
  replacements: ContactReplacement[]
  discarded: Array<{ email: string; reason: string }>
} {
  const contacts = existingContacts.map(contact => ({ ...contact }))
  const replacements: ContactReplacement[] = []
  const discarded: Array<{ email: string; reason: string }> = []
  let added = 0
  let completed = 0
  const uniqueCandidates = [...new Map(candidates
    .filter(candidate => normalizeEmail(candidate.email))
    .map(candidate => [normalizeEmail(candidate.email), {
      ...candidate,
      email: normalizeEmail(candidate.email),
    }])).values()]
    .sort((a, b) => scoreContactCandidate(b) - scoreContactCandidate(a))

  for (const candidate of uniqueCandidates) {
    const byEmail = contacts.find(contact => normalizeEmail(contact.email) === candidate.email)
    const byName = candidate.name
      ? contacts.find(contact => String(contact.name || '').trim().toLowerCase() === candidate.name?.trim().toLowerCase())
      : undefined
    const match = byEmail || byName
    if (match) {
      let changed = false
      for (const field of ['name', 'title', 'email', 'sourceUrl'] as const) {
        if (!match[field] && candidate[field]) {
          match[field] = candidate[field]
          changed = true
        }
      }
      if (!match.source || match.source === 'unknown') {
        match.source = candidateSource
        changed = true
      }
      if (changed) completed++
      continue
    }

    const candidateScore = scoreContactCandidate(candidate)
    if (contacts.length < 4) {
      contacts.push({ ...candidate, id: candidate.id || randomUUID() })
      added++
      continue
    }
    const weakest = contacts
      .map((contact, index) => ({ contact, index, score: scoreContactCandidate(contact) }))
      .sort((a, b) => a.score - b.score)[0]
    if (candidateScore <= weakest.score) {
      discarded.push({ email: candidate.email, reason: 'candidate_quality_not_higher' })
      continue
    }
    const replacedId = weakest.contact.id || `contact-${customerId}-${weakest.index}`
    contacts[weakest.index] = { ...candidate, id: candidate.id || randomUUID() }
    replacements.push({
      replacedContactId: replacedId,
      replacementEmail: candidate.email,
      reason: `higher_quality_candidate:${candidateScore}>${weakest.score}`,
      source: candidateSource,
      replacedAt: new Date().toISOString(),
    })
  }

  const ranked = contacts.sort((a, b) => scoreContactCandidate(b) - scoreContactCandidate(a)).slice(0, 4)
  for (const candidate of uniqueCandidates) {
    if (!ranked.some(contact => normalizeEmail(contact.email) === candidate.email)
      && !discarded.some(entry => entry.email === candidate.email)) {
      discarded.push({ email: candidate.email, reason: 'outside_top_four' })
    }
  }
  return { contacts: ranked, added, completed, replacements, discarded }
}
