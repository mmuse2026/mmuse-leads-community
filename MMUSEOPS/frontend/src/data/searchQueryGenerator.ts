/** 根据关键词 + 通道 + 国家，自动生成搜索词组 */
import type { ChannelConfig } from '../store/searchConfig'
import type { SearchTarget } from '../store/searchTarget'
import { loadProfile } from '../store/userProfile'

export interface GeneratedQuery {
  channelId: string
  channelLabel: string
  query: string
}

/** 从产品信息自动拆分出关键词 */
function splitKeywords(keywords: string): string[] {
  // 如果关键词为空，从公司信息中的产品信息自动生成
  if (!keywords.trim()) {
    const profile = loadProfile()
    const productRaw = profile.productInfo || ''
    const fromProduct = productRaw
      .split(/[,，、&\n]/)
      .map(k => k.trim())
      .filter(Boolean)
    if (fromProduct.length > 0) return fromProduct
    // 仍然为空时，用行业名兜底
    return ['commercial furniture']
  }
  return keywords
    .split(/[,，、\n]/)
    .map(k => k.trim())
    .filter(Boolean)
}

const generators: Record<string, (keyword: string, country: string, extra?: string) => string[]> = {
  serper(keyword, country) {
    return [
      `${keyword} distributor OR wholesale ${country}`,
      `${keyword} supplier OR dealer ${country}`,
      `${keyword} importer OR import ${country}`,
      `${keyword} quote OR pricing ${country}`,
      `${keyword} buy OR purchase ${country}`,
    ]
  },
  justserp(keyword, country) {
    return [
      `${keyword} distributor OR wholesale ${country}`,
      `${keyword} supplier OR dealer ${country}`,
      `${keyword} importer OR import ${country}`,
    ]
  },
  anysearch(keyword, country) {
    return [
      `${keyword} wholesale OR distributor ${country}`,
      `${keyword} supplier ${country}`,
      `${keyword} importer ${country}`,
    ]
  },
  apify(keyword, country) {
    return [
      `${keyword} contact us OR request quote ${country}`,
      `${keyword} about us supplier ${country}`,
    ]
  },
  importyeti(keyword, _country) {
    return [
      `${keyword} container OR shipment`,
      `${keyword} bill of lading OR bill`,
    ]
  },
  google(keyword, country) {
    return [
      `intitle:${keyword} supplier OR distributor ${country}`,
      `inurl:${keyword} wholesale ${country}`,
      `${keyword} site:thomasnet.com OR site:kompass.com`,
      `${keyword} site:linkedin.com supply chain ${country}`,
      `${keyword} request quote OR get a quote ${country}`,
    ]
  },
  maps(keyword, _country, extra) {
    const location = extra || 'US'
    return [
      `site:google.com/maps ${keyword} ${location}`,
      `site:google.com/maps ${keyword} restaurant OR hotel ${location}`,
      `site:google.com/maps ${keyword} supply ${location}`,
    ]
  },
  gleif(keyword, country) {
    return [`${keyword} company ${country}`]
  },
  wikidata(keyword, country) {
    return [`${keyword} company OR organization ${country}`]
  },
}

export function generateQueries(
  target: SearchTarget,
  channels: ChannelConfig[],
): GeneratedQuery[] {
  const keywords = splitKeywords(target.keywords)
  if (keywords.length === 0) return []

  const country = target.country === 'custom' ? '' : target.country
  const result: GeneratedQuery[] = []

  for (const ch of channels) {
    if (!ch.enabled) continue
    const gen = generators[ch.id]
    if (!gen) continue

    for (const kw of keywords) {
      const queries = gen(kw, country, ch.extraParam)
      for (const q of queries) {
        result.push({
          channelId: ch.id,
          channelLabel: ch.label,
          query: q,
        })
      }
    }
  }

  return result
}

/** 统计各通道生成的搜索词数量 */
export function countByChannel(queries: GeneratedQuery[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const q of queries) {
    counts[q.channelLabel] = (counts[q.channelLabel] || 0) + 1
  }
  return counts
}
