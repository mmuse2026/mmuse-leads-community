import { resolveMx } from 'node:dns/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type MxSourceMethod =
  | 'node_dns'
  | 'system_dns'
  | 'doh_cloudflare'
  | 'doh_google'

export type MxSourceOutcome =
  | 'mx_present'
  | 'no_mx'
  | 'nxdomain'
  | 'timeout'
  | 'unknown'

export interface MxSourceEvidence {
  method: MxSourceMethod
  outcome: MxSourceOutcome
  mxCount: number
  mxHosts?: string[]
  summary: string
}

export interface ReliableMxResult {
  result: 'dns_mx_ok' | 'dns_failed' | 'unknown'
  scope: 'domain_only'
  source: 'dns_mx'
  checkedAt: string
  sources: MxSourceEvidence[]
  mxHosts: string[]
  evidenceSummary: string
}

export interface MxResolverDependencies {
  nodeDns: (domain: string) => Promise<MxSourceEvidence>
  systemDns: (domain: string) => Promise<MxSourceEvidence>
  cloudflareDoh: (domain: string) => Promise<MxSourceEvidence>
  googleDoh: (domain: string) => Promise<MxSourceEvidence>
}

function evidence(
  method: MxSourceMethod,
  outcome: MxSourceOutcome,
  mxCount: number,
  summary: string,
  mxHosts?: string[],
): MxSourceEvidence {
  return { method, outcome, mxCount, mxHosts, summary }
}

function normalizeMxHost(value: string): string {
  return String(value || '').trim().toLowerCase().replace(/\.+$/, '')
}

function uniqueMxHosts(hosts: string[]): string[] {
  return [...new Set(hosts.map(normalizeMxHost).filter(Boolean))]
}

export function parseSystemMxHosts(output: string): string[] {
  return uniqueMxHosts(
    [...String(output || '').matchAll(/mail exchanger\s*=\s*([^\s,]+)/gi)]
      .map(match => match[1]),
  )
}

export function parseDohMxAnswers(
  answers: Array<{ type?: number; data?: string }> | undefined,
): string[] {
  if (!Array.isArray(answers)) return []
  return uniqueMxHosts(answers
    .filter(answer => answer?.type === 15)
    .map(answer => {
      const match = String(answer?.data || '').trim().match(/^(\d+)\s+(.+)$/)
      return match ? { priority: Number(match[1]), host: match[2] } : undefined
    })
    .filter((record): record is { priority: number; host: string } => Boolean(record))
    .sort((a, b) => a.priority - b.priority)
    .map(record => record.host)
    .filter(host => host !== '.'))
}

export function mergeMxEvidence(sources: MxSourceEvidence[]): ReliableMxResult {
  const checkedAt = new Date().toISOString()
  const mxHosts = uniqueMxHosts(sources.flatMap(entry => entry.mxHosts || []))
  const hasMx = sources.some(entry => entry.outcome === 'mx_present' && entry.mxCount > 0)
  const explicitNegative = sources.filter(entry =>
    entry.outcome === 'no_mx' || entry.outcome === 'nxdomain').length
  const uncertain = sources.some(entry =>
    entry.outcome === 'timeout' || entry.outcome === 'unknown')
  const result: ReliableMxResult['result'] = hasMx
    ? 'dns_mx_ok'
    : explicitNegative >= 2 && !uncertain
      ? 'dns_failed'
      : 'unknown'
  return {
    result,
    scope: 'domain_only',
    source: 'dns_mx',
    checkedAt,
    sources,
    mxHosts,
    evidenceSummary: sources
      .map(entry => `${entry.method}:${entry.outcome}:${entry.mxCount}`)
      .join('; '),
  }
}

async function nodeDns(domain: string): Promise<MxSourceEvidence> {
  try {
    const records = await resolveMx(domain)
    const mxHosts = records
      .sort((a, b) => a.priority - b.priority)
      .map(record => record.exchange)
    return records.length
      ? evidence('node_dns', 'mx_present', records.length, 'Node DNS returned MX records', uniqueMxHosts(mxHosts))
      : evidence('node_dns', 'no_mx', 0, 'Node DNS returned an empty MX response')
  } catch (error: any) {
    const code = String(error?.code || '')
    if (code === 'ENOTFOUND' || code === 'ENONAME') {
      return evidence('node_dns', 'nxdomain', 0, `Node DNS ${code}`)
    }
    if (code === 'ETIMEOUT' || code === 'EAI_AGAIN') {
      return evidence('node_dns', 'timeout', 0, `Node DNS ${code}`)
    }
    // ENODATA alone is not proof that the domain has no MX.
    return evidence('node_dns', 'unknown', 0, `Node DNS ${code || 'error'}`)
  }
}

function classifySystemOutput(output: string): MxSourceEvidence {
  const text = output.toLowerCase()
  if (/timed out|timeout/.test(text)) {
    return evidence('system_dns', 'timeout', 0, 'System DNS timed out')
  }
  const mxHosts = parseSystemMxHosts(output)
  if (mxHosts.length) {
    return evidence('system_dns', 'mx_present', mxHosts.length, 'System DNS returned MX records', mxHosts)
  }
  if (/nxdomain|non-existent domain|can't find.*non-existent/.test(text)) {
    return evidence('system_dns', 'nxdomain', 0, 'System DNS returned NXDOMAIN')
  }
  if (/no mail exchange|no mx record/.test(text)) {
    return evidence('system_dns', 'no_mx', 0, 'System DNS explicitly returned no MX')
  }
  return evidence('system_dns', 'unknown', 0, 'System DNS response was inconclusive')
}

async function systemDns(domain: string): Promise<MxSourceEvidence> {
  try {
    const result = await execFileAsync('nslookup', ['-type=mx', domain], {
      timeout: 8000,
      windowsHide: true,
      maxBuffer: 256 * 1024,
    })
    return classifySystemOutput(`${result.stdout || ''}\n${result.stderr || ''}`)
  } catch (error: any) {
    const output = `${error?.stdout || ''}\n${error?.stderr || ''}\n${error?.message || ''}`
    return classifySystemOutput(output)
  }
}

async function doh(
  method: 'doh_cloudflare' | 'doh_google',
  url: string,
): Promise<MxSourceEvidence> {
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/dns-json' },
      signal: AbortSignal.timeout(8000),
    })
    if (!response.ok) {
      return evidence(method, 'unknown', 0, `DoH HTTP ${response.status}`)
    }
    const data = await response.json() as {
      Status?: number
      Answer?: Array<{ type?: number; data?: string }>
    }
    const mxHosts = parseDohMxAnswers(data.Answer)
    if (mxHosts.length > 0) return evidence(method, 'mx_present', mxHosts.length, 'DoH returned MX records', mxHosts)
    if (data.Status === 3) return evidence(method, 'nxdomain', 0, 'DoH returned NXDOMAIN')
    if (data.Status === 0) return evidence(method, 'no_mx', 0, 'DoH explicitly returned no MX')
    return evidence(method, 'unknown', 0, `DoH status ${String(data.Status ?? 'missing')}`)
  } catch (error: any) {
    const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError'
    return evidence(method, timeout ? 'timeout' : 'unknown', 0, timeout ? 'DoH timed out' : 'DoH request failed')
  }
}

const defaultDependencies: MxResolverDependencies = {
  nodeDns,
  systemDns,
  cloudflareDoh: domain => doh(
    'doh_cloudflare',
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`,
  ),
  googleDoh: domain => doh(
    'doh_google',
    `https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=MX`,
  ),
}

// 本机系统 DNS 栈不稳定（node 的 resolveMx 曾出现 20s+ 挂起/ENODATA），
// 若串行等它，后续 DoH 来源永远轮不到。改为 4 源并行 + 每源独立限时，
// 总耗时 ≈ 最慢来源（≤6s），低于 search-api 的 8s 竞速窗口，DoH 正常时秒回兜底。
async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: () => T): Promise<T> {
  return Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('dns_source_timeout')), ms))])
    .catch(() => Promise.resolve(fallback()))
}

export async function resolveMxReliably(
  domain: string,
  dependencies: MxResolverDependencies = defaultDependencies,
): Promise<ReliableMxResult> {
  const sources = await Promise.all([
    withTimeout(dependencies.nodeDns(domain), 4000, () => evidence('node_dns', 'timeout', 0, 'Node DNS timed out (>4s)')),
    withTimeout(dependencies.systemDns(domain), 6000, () => evidence('system_dns', 'timeout', 0, 'System DNS timed out (>6s)')),
    withTimeout(dependencies.cloudflareDoh(domain), 6000, () => evidence('doh_cloudflare', 'timeout', 0, 'Cloudflare DoH timed out (>6s)')),
    withTimeout(dependencies.googleDoh(domain), 6000, () => evidence('doh_google', 'timeout', 0, 'Google DoH timed out (>6s)')),
  ])
  return mergeMxEvidence(sources)
}
