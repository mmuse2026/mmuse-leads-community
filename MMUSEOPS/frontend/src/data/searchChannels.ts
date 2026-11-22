/** 搜索渠道定义 — 以"搜什么"为中心，而非"用什么API搜" */

export type SearchChannelType = 'web' | 'linkedin' | 'maps' | 'news' | 'gleif' | 'wikidata'

/** 渠道提供方（API） */
export interface ChannelProvider {
  apiId: string
  label: string
}

/** 渠道定义 */
export interface SearchChannelDef {
  id: SearchChannelType
  label: string
  description: string
  /** 结果类型 — 不同渠道返回的数据结构不同 */
  resultType: 'company' | 'person+company' | 'local_business'
  /** 优先使用的 API 列表（按优先级排序） */
  providers: ChannelProvider[]
  /** 是否需要额外参数 */
  needsExtraParam?: boolean
  extraParamLabel?: string
  /** 该渠道在搜索时是否需要特殊 endpoint */
  serperEndpoint?: string // 'search' | 'news' | 'maps'
}

/** 用户对渠道的配置（是否启用 + 额外参数） */
export interface SearchChannelState {
  id: SearchChannelType
  enabled: boolean
  extraParam?: string
}

export const SEARCH_CHANNELS: SearchChannelDef[] = [
  {
    id: 'web',
    label: '网页搜公司',
    description: '搜索目标公司官网、B2B 信息、供应商/经销商列表',
    resultType: 'company',
    providers: [
      { apiId: 'serper', label: 'Serper API' },
      { apiId: 'justserp', label: 'JustSerpAPI' },
    ],
    serperEndpoint: 'search',
  },
  {
    id: 'linkedin',
    label: 'LinkedIn 找人',
    description: '直接在 LinkedIn 搜索联系人，结果包含人名 + 公司 + 职位',
    resultType: 'person+company',
    providers: [
      { apiId: 'serper', label: 'Serper API (site:linkedin.com/in)' },
      { apiId: 'apify', label: 'Apify LinkedIn Actor' },
    ],
    serperEndpoint: 'search',
  },
  {
    id: 'maps',
    label: '地图搜商家',
    description: '搜索指定城市的本地商家、经销商、服务商',
    resultType: 'local_business',
    providers: [
      { apiId: 'serper', label: 'Serper Maps' },
    ],
    needsExtraParam: true,
    extraParamLabel: '目标城市',
    serperEndpoint: 'places',
  },
  {
    id: 'news',
    label: '新闻动态',
    description: '搜索公司最新新闻、融资动态、新品发布',
    resultType: 'company',
    providers: [
      { apiId: 'serper', label: 'Serper News' },
    ],
    serperEndpoint: 'news',
  },
  {
    id: 'gleif',
    label: 'GLEIF 法人查询',
    description: '全球法人机构识别码(LEI)数据库，免费查询公司注册信息',
    resultType: 'company',
    providers: [{ apiId: 'gleif', label: 'GLEIF API (免费)' }],
    serperEndpoint: undefined,
  },
  {
    id: 'wikidata',
    label: 'Wikidata 查询',
    description: '维基数据开放知识库，查询公司实体信息',
    resultType: 'company',
    providers: [{ apiId: 'wikidata', label: 'Wikidata API (免费)' }],
    serperEndpoint: undefined,
  },
]

/** API 额度信息 */
export interface ApiQuota {
  apiId: string
  name: string
  monthlyLimit: number
  usedThisMonth: number
  dailyLimit?: number
}

export const API_QUOTAS: ApiQuota[] = [
  { apiId: 'serper', name: 'Serper API', monthlyLimit: 2500, usedThisMonth: 0 },
  { apiId: 'justserp', name: 'JustSerpAPI', monthlyLimit: 1000, usedThisMonth: 0 },
  { apiId: 'apify', name: 'Apify', monthlyLimit: 99999, usedThisMonth: 0 },
  { apiId: 'hunter', name: 'Hunter.io', monthlyLimit: 100, usedThisMonth: 0 },
  { apiId: 'gleif', name: 'GLEIF API', monthlyLimit: 99999, usedThisMonth: 0 },
  { apiId: 'wikidata', name: 'Wikidata API', monthlyLimit: 99999, usedThisMonth: 0 },
]

/** 生成默认渠道状态（默认只开网页和LinkedIn） */
export function defaultChannelStates(): SearchChannelState[] {
  return SEARCH_CHANNELS.map(ch => ({
    id: ch.id,
    enabled: ch.id === 'web' || ch.id === 'linkedin',
    extraParam: ch.id === 'maps' ? '' : undefined,
  }))
}

/** 根据渠道类型生成搜索查询 */
export function generateSearchQueries(
  channelId: SearchChannelType,
  keywords: string[],
  country: string,
  extraParam?: string,
): string[] {
  switch (channelId) {
    case 'web':
      return keywords.flatMap(kw => [
        `${kw} distributor OR wholesale ${country}`,
        `${kw} supplier OR dealer ${country}`,
        `${kw} importer OR import ${country}`,
        `${kw} quote OR pricing ${country}`,
        `${kw} buy OR purchase ${country}`,
      ])
    case 'linkedin':
      return keywords.flatMap(kw => [
        `${kw} purchasing manager linkedin ${country}`,
        `${kw} supply chain procurement linkedin ${country}`,
        `${kw} distributor wholesale linkedin ${country}`,
        `${kw} CEO founder linkedin ${country}`,
        `${kw} import export linkedin ${country}`,
      ])
    case 'maps':
      return keywords.flatMap(kw => {
        const loc = extraParam || country || 'US'
        return [
          `site:google.com/maps ${kw} ${loc}`,
          `site:google.com/maps ${kw} supplier ${loc}`,
          `site:google.com/maps ${kw} furniture ${loc}`,
        ]
      })
    case 'news':
      return keywords.flatMap(kw => [
        `${kw} new store OR expansion OR opening`,
        `${kw} contract OR partnership`,
        `${kw} investment OR funding`,
      ])
    case 'gleif':
      return keywords.flatMap(kw => [
        `${kw} company`,
      ])
    case 'wikidata':
      return keywords.flatMap(kw => [
        `${kw} company OR organization`,
      ])
    default:
      return []
  }
}
