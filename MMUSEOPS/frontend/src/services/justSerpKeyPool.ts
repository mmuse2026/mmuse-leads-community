export interface JustSerpKeyConfig {
  justserpApiKey?: unknown
  justserpApiKey2?: unknown
  justserpApiKeys?: unknown
}

export interface SerperKeyConfig {
  serperApiKey?: unknown
  serperApiKey2?: unknown
  serperApiKeys?: unknown
}

export class JustSerpHttpError extends Error {
  constructor(readonly status: number) {
    super(`JUSTSERP_HTTP_${status}`)
    this.name = 'JustSerpHttpError'
  }
}

export class SerperHttpError extends Error {
  constructor(readonly status: number) {
    super(`SERPER_HTTP_${status}`)
    this.name = 'SerperHttpError'
  }
}

export type JustSerpRunResult<T> =
  | { ok: true; value: T }
  | { ok: false; statuses: number[] }

interface KeyPoolState {
  nextIndex: number
  unavailableKeys: Set<string>
}

const justSerpState: KeyPoolState = { nextIndex: 0, unavailableKeys: new Set<string>() }
const serperState: KeyPoolState = { nextIndex: 0, unavailableKeys: new Set<string>() }

export function normalizeJustSerpKeys(input: JustSerpKeyConfig | unknown[]): string[] {
  const raw = Array.isArray(input)
    ? input
    : [
        input.justserpApiKey,
        input.justserpApiKey2,
        ...(Array.isArray(input.justserpApiKeys) ? input.justserpApiKeys : []),
      ]
  const keys = raw.map(value => String(value || '').trim()).filter(Boolean)
  return [...new Set(keys)]
}

export function normalizeSerperKeys(input: SerperKeyConfig | unknown[]): string[] {
  const raw = Array.isArray(input)
    ? input
    : [
        input.serperApiKey,
        input.serperApiKey2,
        ...(Array.isArray(input.serperApiKeys) ? input.serperApiKeys : []),
      ]
  const keys = raw.map(value => String(value || '').trim()).filter(Boolean)
  return [...new Set(keys)]
}

function statusFrom(error: unknown): number {
  if (error instanceof JustSerpHttpError) return error.status
  if (error instanceof SerperHttpError) return error.status
  if (typeof error === 'object' && error && 'status' in error) {
    const status = Number((error as { status?: unknown }).status)
    if (Number.isFinite(status)) return status
  }
  return 0
}

function shouldDisable(status: number): boolean {
  return status === 401 || status === 402 || status === 403 || status === 429
}

async function runWithKeyPool<T>(
  state: KeyPoolState,
  keys: string[],
  request: (apiKey: string) => Promise<T>,
): Promise<JustSerpRunResult<T>> {
  if (keys.length === 0) return { ok: false, statuses: [] }

  for (const key of [...state.unavailableKeys]) {
    if (!keys.includes(key)) state.unavailableKeys.delete(key)
  }

  const statuses: number[] = []
  const start = state.nextIndex % keys.length
  for (let offset = 0; offset < keys.length; offset += 1) {
    const index = (start + offset) % keys.length
    const key = keys[index]
    if (state.unavailableKeys.has(key)) continue
    state.nextIndex = (index + 1) % keys.length
    try {
      const value = await request(key)
      return { ok: true, value }
    } catch (error: unknown) {
      const status = statusFrom(error)
      statuses.push(status)
      if (shouldDisable(status)) state.unavailableKeys.add(key)
    }
  }
  return { ok: false, statuses }
}

export function runWithJustSerpKeyPool<T>(
  input: JustSerpKeyConfig | unknown[],
  request: (apiKey: string) => Promise<T>,
): Promise<JustSerpRunResult<T>> {
  return runWithKeyPool(justSerpState, normalizeJustSerpKeys(input), request)
}

export function runWithSerperKeyPool<T>(
  input: SerperKeyConfig | unknown[],
  request: (apiKey: string) => Promise<T>,
): Promise<JustSerpRunResult<T>> {
  return runWithKeyPool(serperState, normalizeSerperKeys(input), request)
}

export function resetJustSerpKeyPool(): void {
  justSerpState.nextIndex = 0
  justSerpState.unavailableKeys.clear()
}

export function resetSerperKeyPool(): void {
  serperState.nextIndex = 0
  serperState.unavailableKeys.clear()
}
