/** 鎼滅储缂栨帓 鈥?鍚勬笭閬撳苟琛屾悳绱?鈫?鍏ㄩ儴瀹屾垚鍚庡幓閲嶅叆搴?*/
import type { GeneratedQuery } from '../data/searchQueryGenerator'
import { SEARCH_CHANNELS } from '../data/searchChannels'
import { getAllItems, saveItem, refreshFromServer } from '../store/db'
import type { PipelineItem } from '../types/item'
import { classifyByBackcheck, classifyBusinessLine } from './classifyClient'
import { API_BASE } from './config'
import { buildSearchAdmissionMetadata, canonicalDomainFrom, isSaveableSearchTag } from './searchResultPolicy'
import { SEARCH_BATCH_TIMEOUT_MS, toSearchFailureMessage } from './searchRequestPolicy'

export interface SearchCompany {
  title: string
  url: string
  snippet: string
  tag: string
  score: number
  reason: string
  companyInfo?: {
    employeeCount?: string
    revenue?: string
    yearFounded?: string
    products?: string[]
    markets?: string[]
    linkedinUrl?: string
    summary?: string
    decisionMakers?: { name: string; title: string }[]
  }
}

export interface ChannelProgress {
  channelId: string
  channelLabel: string
  total: number
  completed: number
  matched: number
  failed: number
  status: 'pending' | 'running' | 'done'
}

export interface SearchProgress {
  channels: ChannelProgress[]
  total: number
  completed: number
  matched: number
  failed: number
  companies: SearchCompany[]
  errors: string[]
  saveFailures?: number
  allDone: boolean
}

function extractCompany(title: string, url: string): string {
  try {
    const hostname = new URL(url).hostname.replace('www.', '')
    return hostname.split('.')[0] || title.split('|')[0]?.trim() || title.substring(0, 40)
  } catch {
    return title.split('|')[0]?.trim() || title.substring(0, 40)
  }
}

/**
 * 娓呯悊鏂囨湰涓殑缂栫爜闂瀛楃
 * 淇濈暀姝ｅ父鐨刄nicode瀛楃锛屽彧娓呯悊鏄庢樉鐨勭紪鐮佹崯鍧?
 */
function sanitizeText(text: string): string {
  if (!text) return text
  return text
    // 娓呯悊杩炵画鐨勯棶鍙凤紙缂栫爜鎹熷潖鏍囧織锛?
    .replace(/\?{2,}/g, '')
    // 娓呯悊鍗曠嫭鐨勯棶鍙峰墠鍚庣┖鏍?
    .replace(/\s+\?\s+/g, ' ')
    .replace(/^\?\s+/, '')
    .replace(/\s+\?$/, '')
    // 娓呯悊澶氫綑绌烘牸
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** 瑙ｆ瀽 LinkedIn 鎼滅储缁撴灉鏍囬 */
function parseLinkedInTitle(title: string): { name: string; jobTitle: string; company: string } | null {
  // "John Doe - Job Title at Company | LinkedIn"
  // "John Doe - CEO at Company Name | LinkedIn"
  // "John Doe - LinkedIn"
  const cleaned = title.replace(/\s*\|\s*LinkedIn.*$/, '').trim()
  if (!cleaned) return null

  const dashIdx = cleaned.indexOf(' - ')
  if (dashIdx === -1) return { name: cleaned, jobTitle: '', company: '' }

  const name = cleaned.substring(0, dashIdx).trim()
  const rest = cleaned.substring(dashIdx + 3).trim()

  const atIdx = rest.lastIndexOf(' at ')
  if (atIdx === -1) return { name, jobTitle: rest, company: '' }

  const jobTitle = rest.substring(0, atIdx).trim()
  const company = rest.substring(atIdx + 4).trim()
  return { name, jobTitle, company }
}

/** LinkedIn URL 鏀寔澶氱鏍煎紡 */
function isLinkedInUrl(url: string): boolean {
  return /linkedin\.com\/in\//i.test(url)
}

export interface SearchExecutionContext {
  country?: string
}
export async function executeSearch(
  queries: GeneratedQuery[],
  industry: string,
  onProgress?: (progress: SearchProgress) => void,
  onItemSaved?: (item: PipelineItem) => void,
  context: SearchExecutionContext = {},
): Promise<SearchProgress> {
  // 1. 鎸夋笭閬撳垎缁?
  const byChannel = new Map<string, GeneratedQuery[]>()
  for (const q of queries) {
    if (!byChannel.has(q.channelId)) byChannel.set(q.channelId, [])
    byChannel.get(q.channelId)!.push(q)
  }

  // 2. 鍒濆鍖栬繘搴?
  const channels: ChannelProgress[] = []
  for (const [chId] of byChannel) {
    const sample = queries.find(q => q.channelId === chId)!
    const chQueries = byChannel.get(chId)!
    channels.push({
      channelId: chId,
      channelLabel: sample.channelLabel,
      total: chQueries.length,
      completed: 0,
      matched: 0,
      failed: 0,
      status: 'pending',
    })
  }

  const progress: SearchProgress = {
    channels,
    total: queries.length,
    completed: 0,
    matched: 0,
    failed: 0,
    companies: [],
    errors: [],
    allDone: false,
  }

  // Await a server refresh before taking the dedupe snapshot. The atomic create
  // policy below also covers stale summary responses and interrupted requests.
  await refreshFromServer(true)
  const existing = await getAllItems('outreach')
  const existingWebsites = new Set(existing.map(i => i.website).filter(Boolean))
  const existingDomains = new Set(existing.map(i => canonicalDomainFrom((i as any).canonicalDomain || i.website)).filter(Boolean))
  // 鎸夊叕鍙?鑱旂郴浜哄幓閲嶏細鍚屽叕鍙镐笉鍚岃仈绯讳汉淇濈暀鍚勮嚜鏉＄洰
  const existingCompanies = new Set(existing.map(i => (i.company || '').trim().toLowerCase() + '|' + (i.contactName || '').trim().toLowerCase()).filter(k => k && k !== '|'))
  // 璺ㄦ笭閬撳叡浜殑宸插彂鐜癠RL闆嗗悎锛屽疄鏃舵洿鏂帮紝閬垮厤閲嶅鍙戦€佸埌鍚庣
  const seenSessionUrls = new Set<string>()
  const seenSessionDomains = new Set<string>()

  // 3. 鍚勬笭閬撻『搴忔墽琛岋紙閬垮厤骞惰瀵艰嚧鐨勫幓閲嶇珵鎬佹潯浠讹級
  for (const ch of channels) {
    ch.status = 'running'
    onProgress?.({ ...progress })

    const chQueries = byChannel.get(ch.channelId)!
    const isLinkedInChannel = ch.channelId === 'linkedin'
    const batchSize = 5

    for (let i = 0; i < chQueries.length; i += batchSize) {
      const batch = chQueries.slice(i, i + batchSize)
      const batchQueries = batch.map(q => q.query)

      // 鏀堕泦鎵€鏈夊凡鍙戠幇鐨刄RL浼犵粰鍚庣璺宠繃
      const excludeUrls = [...existingWebsites].concat([...seenSessionUrls]).filter(Boolean)

      // 姣忎釜璇锋眰60绉掕秴鏃讹紝闃叉鍗℃
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), SEARCH_BATCH_TIMEOUT_MS)

      try {
        const resp = await fetch(`${API_BASE}/api/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            product: industry,
            queries: batchQueries,
            excludeUrls,
            channel: ch.channelId,
            country: context.country || 'US',
            searchType: SEARCH_CHANNELS.find(d => d.id === ch.channelId)?.serperEndpoint || 'search',
          }),
          signal: controller.signal,
        })
        clearTimeout(timeout)

        if (!resp.ok) {
          const detail = await resp.text().catch(() => '')
          const failure = toSearchFailureMessage(`HTTP ${resp.status} ${detail}`)
          if (!progress.errors.includes(failure)) progress.errors.push(failure)
          ch.failed += batch.length
          ch.completed += batch.length
          progress.failed += batch.length
          progress.completed += batch.length
          onProgress?.({ ...progress })
          continue
        }

        const data = await resp.json()
        const apiErrors = Array.isArray(data.errors) ? data.errors : []
        for (const error of apiErrors) {
          const failure = toSearchFailureMessage(error)
          if (!progress.errors.includes(failure)) progress.errors.push(failure)
        }
        const apiFailed = Math.min(batch.length, Math.max(0, Number(data.failed) || 0))
        if (apiFailed > 0) {
          progress.failed += apiFailed
          ch.failed += apiFailed
        }
        const channelResults = data.results || []

        for (const r of channelResults) {
          if (r.url && !isLinkedInUrl(r.url)) seenSessionUrls.add(r.url)

          const saveable = isSaveableSearchTag(r.tag)
          if (saveable && r.url && !existingWebsites.has(r.url)) {
            seenSessionUrls.add(r.url)

            let contactName = ''
            let contactTitle = ''
            let companyName = ''
            let personEmail = ''

            // LinkedIn 缁撴灉鐗规畩澶勭悊锛氫粠鏍囬瑙ｆ瀽鑱旂郴浜轰俊鎭?
            if (isLinkedInChannel || isLinkedInUrl(r.url)) {
              const parsed = parseLinkedInTitle(r.title)
              if (parsed) {
                contactName = parsed.name
                contactTitle = parsed.jobTitle
                companyName = parsed.company || extractCompany(r.title, r.url)
                // LinkedIn URL 浣滀负缃戠珯
              }
            }

            // 鑷姩鍒嗙被 clientType锛堝熀浜庤儗璋冩暟鎹叧閿瘝鍖归厤锛?
            const computedClientType = classifyByBackcheck({
              backCheck: r.companyInfo ? {
                summary: r.companyInfo.summary,
                products: r.companyInfo.products,
                markets: r.companyInfo.markets,
              } : undefined,
              company: companyName || extractCompany(r.title, r.url),
              website: r.url,
              snippet: r.snippet,
            })

            // 鑷姩鍒嗙被涓氬姟绾匡紙鍩轰簬鑳岃皟鏁版嵁涓殑浜у搧淇℃伅锛?
            const computedBusinessLine = classifyBusinessLine({
              backCheck: r.companyInfo ? {
                summary: r.companyInfo.summary,
                products: r.companyInfo.products,
                markets: r.companyInfo.markets,
              } : undefined,
              company: companyName || extractCompany(r.title, r.url),
              website: r.url,
              snippet: r.snippet,
            })

            const resolvedCompanyName = sanitizeText(companyName || extractCompany(r.title, r.url))
            const searchMetadata = buildSearchAdmissionMetadata({ url: r.url, title: r.title, snippet: r.snippet, companyName: resolvedCompanyName, tag: r.tag })
            const item: PipelineItem = {
              id: crypto.randomUUID(),
              pipelineId: 'outreach',
              currentStageId: 'otr-found',
              status: 'active',
              priority: 'medium',
              source: ch.channelId as any,
              title: sanitizeText(r.title.substring(0, 200)),
              company: resolvedCompanyName,
              ...searchMetadata,
              website: isLinkedInChannel || isLinkedInUrl(r.url) ? '' : r.url,
              contactName: sanitizeText(contactName || r.companyInfo?.decisionMakers?.[0]?.name || ''),
              email: personEmail || '', phone: '',
              level: 'unknown', clientType: computedClientType,
              emailVerification: 'unknown', emailBounced: false,
              currency: 'USD',
              country: context.country || 'US',
              businessLine: computedBusinessLine,
              backcheckStatus: 'pending',
              developmentStatus: 'pending',
              timeline: [{ stageId: 'otr-found', enteredAt: new Date().toISOString() }],
              notes: [], attachments: [],
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              backCheck: r.companyInfo || contactName ? {
                checkedAt: new Date().toISOString(),
                employeeCount: r.companyInfo?.employeeCount || undefined,
                revenue: r.companyInfo?.revenue || undefined,
                yearFounded: r.companyInfo?.yearFounded || undefined,
                linkedinUrl: isLinkedInUrl(r.url) ? r.url : (r.companyInfo?.linkedinUrl || undefined),
                products: r.companyInfo?.products?.length ? r.companyInfo.products : undefined,
                markets: r.companyInfo?.markets?.length ? r.companyInfo.markets : undefined,
                summary: r.companyInfo?.summary || undefined,
                decisionMakers: contactName
                  ? [{ name: contactName, title: contactTitle || undefined, source: 'LinkedIn' }]
                  : r.companyInfo?.decisionMakers?.map((d: { name: string; title: string }) => ({ name: d.name, title: d.title, source: '缃戠珯鍒嗘瀽' })),
              } : undefined,
            }
            // 鍏徃鍚嶅幓閲嶏細宸插瓨鍦ㄧ殑鍏徃涓嶉噸澶嶅垱寤猴紙LinkedIn姣忎汉鐙珛锛屼笉鎷︼級
            const companyKey = (item.company || '').trim().toLowerCase() + '|' + (item.contactName || '').trim().toLowerCase()
            const canonicalDomain = searchMetadata.canonicalDomain
            if (!isLinkedInUrl(r.url) && ((canonicalDomain && (existingDomains.has(canonicalDomain) || seenSessionDomains.has(canonicalDomain))) || (companyKey && existingCompanies.has(companyKey)))) {
              existingWebsites.add(r.url)
              continue
            }

            let reusedExisting = false
            try {
              await saveItem(item, !isLinkedInChannel && !isLinkedInUrl(r.url)
                ? { reuseSearchIdentity: true, onExisting: () => { reusedExisting = true } }
                : undefined)
            } catch (error) {
              // A failed persistence is not a matched customer and must remain retryable.
              // Other companies in the same provider batch can still progress.
              progress.saveFailures = (progress.saveFailures || 0) + 1
              progress.errors.push(`CRM保存失败：${item.company || item.id}`)
              seenSessionUrls.delete(r.url)
              continue
            }
            if (companyKey) existingCompanies.add(companyKey)
            if (canonicalDomain) { existingDomains.add(canonicalDomain); seenSessionDomains.add(canonicalDomain) }
            if (reusedExisting) { existingWebsites.add(r.url); continue }
            onItemSaved?.(item)
            if (!isLinkedInUrl(r.url)) existingWebsites.add(r.url)
            progress.matched++
            ch.matched++
          }

          progress.companies.push({
            title: r.title,
            url: r.url,
            snippet: r.snippet,
            tag: r.tag,
            score: r.score,
            reason: r.reason,
            companyInfo: r.companyInfo,
          })
        }

        progress.completed += batch.length
        ch.completed += batch.length
      } catch (e) {
        clearTimeout(timeout)
        const failure = toSearchFailureMessage(e)
        if (!progress.errors.includes(failure)) progress.errors.push(failure)
        console.error(`[search] Batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(chQueries.length / batchSize)} failed:`, e)
        progress.failed += batch.length
        ch.failed += batch.length
        progress.completed += batch.length
        ch.completed += batch.length
      }

      onProgress?.({ ...progress })
    }

    ch.status = 'done'
    onProgress?.({ ...progress })
  }

  // 4. 鍏ㄦ笭閬撳畬鎴愬悗缁熶竴鍘婚噸
  const seenUrls = new Set<string>()
  progress.companies = progress.companies.filter(c => {
    if (!c.url) return true
    const key = c.url.replace(/\/$/, '').toLowerCase()
    if (seenUrls.has(key)) return false
    seenUrls.add(key)
    return true
  })

  progress.allDone = true
  onProgress?.({ ...progress })
  return progress
}

/** 浠庢暟鎹簱鍔犺浇鏈€杩戜竴娆℃悳绱㈢殑鍏ュ簱缁撴灉锛屾仮澶嶆悳绱㈢粨鏋滆鍥?*/
export async function loadLatestSearchProgress(): Promise<SearchProgress | null> {
  const items = await getAllItems('outreach')
  if (!items.length) return null
  const recent = items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50)
  const companies: SearchCompany[] = recent.map(i => ({
    title: i.title,
    url: i.website || '',
    snippet: i.notes?.[0]?.content || '',
    tag: '娓犻亾',
    score: 15,
    reason: '鍘嗗彶鍏ュ簱鏁版嵁',
    companyInfo: i.backCheck ? {
      employeeCount: i.backCheck.employeeCount,
      revenue: i.backCheck.revenue,
      yearFounded: i.backCheck.yearFounded,
      products: i.backCheck.products,
      markets: i.backCheck.markets,
      linkedinUrl: i.backCheck.linkedinUrl,
      summary: i.backCheck.summary,
      decisionMakers: i.backCheck.decisionMakers?.map(d => ({ name: d.name || '', title: d.title || '' })),
    } : undefined,
  }))
  const chLabel = recent[0]?.source || 'serper'
  return {
    channels: [{
      channelId: chLabel,
      channelLabel: chLabel === 'serper' ? 'Serper API' : chLabel,
      total: companies.length,
      completed: companies.length,
      matched: companies.length,
      failed: 0,
      status: 'done',
    }],
    total: companies.length,
    completed: companies.length,
    matched: companies.length,
    failed: 0,
    companies,
    errors: [],
    allDone: true,
  }
}

