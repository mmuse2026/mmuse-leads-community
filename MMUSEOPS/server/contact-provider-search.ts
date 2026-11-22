/**
 * 联系人补充通道：Serper公开搜索 + Hunter.io（同步 domain-search） + Prospeo（占位）。
 *
 * 仅在 Snovio 主通道认证失败 / 配额耗尽时由 contact-mining-consumer 自动降级调用
 * （Snovio → Hunter → Prospeo）。结构沿用 snovio-domain-search 的 ContactCandidate，
 * 新通道 candidate.source 分别标记为 'hunter_found' / 'prospeo_found'。
 *
 * 免费额度（按月重置）：
 *   - Hunter.io：按 account 实际显示 searches 限额（本机 50/月，reset_date 2026-08-31）
 *   - Prospeo：75 次/月（占位，未实现）
 */

import type { ContactCandidate } from './snovio-domain-search'

export type FallbackProvider = 'serper' | 'hunter' | 'prospeo'

export interface PublicContactClue {
  name: string
  title?: string
  sourceUrl: string
  source: 'serper_linkedin'
}

export interface ProviderSearchResult {
  status: 'completed' | 'quota' | 'auth' | 'error' | 'not_implemented'
  provider: FallbackProvider
  candidates?: ContactCandidate[]
  clues?: PublicContactClue[]
  error?: string
}

function normalizeEmail(value?: string): string {
  return String(value || '').trim().toLowerCase()
}

function responseStatus(status: number, body: string): ProviderSearchResult['status'] {
  if (status === 401 || status === 403) return 'auth'
  if (status === 402 || status === 429 || /credit|quota|limit|billing/i.test(body)) return 'quota'
  return 'error'
}

function companyMatchesLinkedIn(text: string, company: string, domain: string): boolean {
  const normalized = text.toLowerCase()
  const root = domain.toLowerCase().split('.')[0].replace(/[^a-z0-9]/g, '')
  const companyWords = company.toLowerCase().match(/[a-z0-9]{3,}/g) || []
  if (companyWords.length === 1) return companyWords[0] === root && normalized.includes(root)
  const phrase = companyWords.join(' ')
  return phrase.length >= 6 && normalized.replace(/[^a-z0-9]+/g, ' ').includes(phrase)
}

function linkedinClues(results: any[], company: string, domain: string): PublicContactClue[] {
  const clues: PublicContactClue[] = []
  for (const result of results) {
    const link = String(result?.link || '')
    const title = String(result?.title || '').trim()
    const snippet = String(result?.snippet || '').trim()
    if (!/linkedin\.com\/in\//i.test(link) || !companyMatchesLinkedIn(`${title} ${snippet}`, company, domain)) continue
    const name = title.split(/\s[-|]\s/)[0]?.replace(/\s*\|\s*LinkedIn.*$/i, '').trim()
    if (!name || name.length < 3 || /undefined|null/i.test(name)) continue
    clues.push({ name, title: title.slice(name.length).replace(/^\s*[-|]\s*/, '').replace(/\s*\|\s*LinkedIn.*$/i, '').trim() || undefined, sourceUrl: link, source: 'serper_linkedin' })
  }
  return [...new Map(clues.map(clue => [clue.sourceUrl, clue])).values()].slice(0, 4)
}

/**
 * Serper 公开联系人补充：每家公司固定两次查询（LinkedIn 人名/职位 + 官网公开邮箱）。
 * 只返回与公司域名完全一致的邮箱；结果仍是未验证候选，必须进入后续邮箱验证链。
 */
export async function serperDomainContactSearch(
  domain: string,
  company: string,
  apiKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<ProviderSearchResult> {
  const normalizedDomain = domain.trim().toLowerCase().replace(/^www\./, '')
  const safeCompany = company.trim().replace(/["\r\n]/g, ' ').slice(0, 120) || normalizedDomain.split('.')[0]
  const queries = [
    `site:linkedin.com/in "${safeCompany}" (procurement OR purchasing OR sourcing OR buyer OR founder OR owner OR director)`,
    `site:${normalizedDomain} contact email`,
  ]
  const resultSets: any[][] = []
  for (const q of queries) {
    let response: Response
    try {
      response = await fetchFn('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q, num: 10 }),
        signal: AbortSignal.timeout(30000),
      })
    } catch (error) {
      return { status: 'error', provider: 'serper', error: error instanceof Error ? error.message : String(error) }
    }
    const body = await response.text().catch(() => '')
    if (!response.ok) return { status: responseStatus(response.status, body), provider: 'serper', error: `serper_${response.status}` }
    let data: any = {}
    try { data = JSON.parse(body) } catch { return { status: 'error', provider: 'serper', error: 'serper_bad_json' } }
    resultSets.push(Array.isArray(data?.organic) ? data.organic : [])
  }

  const clues = linkedinClues(resultSets[0], safeCompany, normalizedDomain)
  const candidates = new Map<string, ContactCandidate>()
  const pattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
  for (const result of resultSets[1]) {
    const sourceUrl = String(result?.link || '').trim()
    const blob = `${String(result?.title || '')} ${String(result?.snippet || '')}`
    for (const match of blob.match(pattern) || []) {
      const email = normalizeEmail(match)
      if (!email.endsWith(`@${normalizedDomain}`)) continue
      candidates.set(email, { email, source: 'serper_found', sourceUrl, confidence: 'public_search_exact_domain' })
    }
  }
  return { status: 'completed', provider: 'serper', candidates: [...candidates.values()], clues }
}

/**
 * Hunter.io 域名搜索（同步 GET，无异步任务）。
 * GET https://api.hunter.io/v2/domain-search?api_key=KEY&domain=DOMAIN&limit=5&type=personal
 */
export async function hunterDomainSearch(domain: string, apiKey: string): Promise<ProviderSearchResult> {
  const params = new URLSearchParams({
    api_key: apiKey,
    domain: domain.trim().toLowerCase(),
    limit: '5',
    type: 'personal',
  })
  let resp: Response
  try {
    resp = await fetch(`https://api.hunter.io/v2/domain-search?${params.toString()}`, {
      signal: AbortSignal.timeout(30000),
    })
  } catch (err) {
    return { status: 'error', provider: 'hunter', error: err instanceof Error ? err.message : String(err) }
  }
  const bodyText = await resp.text().catch(() => '')
  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) return { status: 'auth', provider: 'hunter', error: `hunter_${resp.status}` }
    if (resp.status === 402 || resp.status === 429 || /credit|quota|limit|billing/i.test(bodyText)) {
      return { status: 'quota', provider: 'hunter', error: `hunter_${resp.status}` }
    }
    return { status: 'error', provider: 'hunter', error: `hunter_${resp.status}` }
  }
  let data: any = {}
  try { data = JSON.parse(bodyText) } catch { return { status: 'error', provider: 'hunter', error: 'hunter_bad_json' } }
  if (data?.errors) {
    // 业务错误：429/402 → quota，401/403 → auth，其余 → error
    const first = Array.isArray(data.errors) ? data.errors[0] : data.errors
    const code = Number(first?.code || 0)
    if (code === 429 || code === 402) return { status: 'quota', provider: 'hunter', error: `hunter_${code}` }
    if (code === 401 || code === 403) return { status: 'auth', provider: 'hunter', error: `hunter_${code}` }
    return { status: 'error', provider: 'hunter', error: `hunter_${code || 'unknown'}` }
  }
  const candidates = normalizeHunterCandidates(data?.data, domain)
  return { status: 'completed', provider: 'hunter', candidates }
}

function normalizeHunterCandidates(data: any, domain: string): ContactCandidate[] {
  const normalizedDomain = domain.trim().toLowerCase()
  const emails = Array.isArray(data?.emails) ? data.emails : []
  const candidates: ContactCandidate[] = []
  for (const e of emails) {
    const email = normalizeEmail(e?.value)
    if (!email || !email.includes('@') || !email.endsWith(`@${normalizedDomain}`)) continue
    const firstName = String(e?.first_name || '').trim()
    const lastName = String(e?.last_name || '').trim()
    const name = [firstName, lastName].filter(Boolean).join(' ') || undefined
    candidates.push({
      name,
      title: String(e?.position || '').trim() || undefined,
      email,
      source: 'hunter_found',
      sourceUrl: String(e?.linkedin || '').trim() || undefined,
      confidence: e?.confidence !== undefined && e?.confidence !== null ? String(e.confidence) : undefined,
    })
  }
  return candidates
}

/**
 * Prospeo 人员查找通道（占位）。
 * TODO: Prospeo 有人员查找 API（按 domain/company 找联系人），endpoint 未确认前不做实际调用；
 * 免费额度 75 次/月。实现后返回 status 'completed' + candidates（source 用 'prospeo_found'），
 * 并在 contact-mining-consumer 的降级链中补上 hunter→prospeo 的调用。
 */
export async function prospeoDomainSearch(_domain: string, _apiKey: string): Promise<ProviderSearchResult> {
  return { status: 'not_implemented', provider: 'prospeo', error: 'prospeo_not_implemented' }
}
