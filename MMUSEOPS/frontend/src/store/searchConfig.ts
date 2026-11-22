/** 搜索通道配置持久化 */
export interface ChannelConfig {
  id: string
  label: string
  enabled: boolean
  needsKey: boolean
  apiKey: string
  keyUrl: string
  extraParam?: string   // 如 Maps 的目标城市
  extraParamLabel?: string
}

export interface SearchConfig {
  channels: ChannelConfig[]
}

const STORAGE_KEY = 'mmuse_search_config'

const defaultChannels: ChannelConfig[] = [
  { id: 'serper',      label: 'Serper API',     enabled: true,  needsKey: true,  apiKey: '', keyUrl: 'https://serper.dev' },
  { id: 'justserp',    label: 'JustSerpAPI',    enabled: false, needsKey: true,  apiKey: '', keyUrl: 'https://justserpapi.com' },
  { id: 'anysearch',   label: 'Anysearch',      enabled: false, needsKey: true,  apiKey: '', keyUrl: '' },
  { id: 'apify',       label: 'Apify',          enabled: false, needsKey: true,  apiKey: '', keyUrl: 'https://console.apify.com/settings/integrations' },
  { id: 'importyeti',  label: 'ImportYeti',     enabled: false, needsKey: true,  apiKey: '', keyUrl: '' },
  { id: 'google',      label: '谷歌搜索',        enabled: false, needsKey: false, apiKey: '', keyUrl: '' },
  { id: 'maps',        label: 'Google Maps',    enabled: false, needsKey: false, apiKey: '', keyUrl: '', extraParam: '', extraParamLabel: '目标城市' },
  { id: 'gleif',       label: 'GLEIF 法人查询',  enabled: false, needsKey: false, apiKey: '', keyUrl: '' },
  { id: 'wikidata',    label: 'Wikidata 查询',   enabled: false, needsKey: false, apiKey: '', keyUrl: '' },
]

function defaultConfig(): SearchConfig {
  return { channels: defaultChannels.map(c => ({ ...c })) }
}

export function loadSearchConfig(): SearchConfig {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    const config: SearchConfig = saved ? JSON.parse(saved) : defaultConfig()

    // 从用户配置中预填通道 API Key
    let profileKeys: Record<string, string> = {}
    try {
      const p = JSON.parse(localStorage.getItem('mmuse_user_profile') || '{}')
      profileKeys = {
        serper: p.serperApiKey || '',
        justserp: p.justserpApiKey || '',
        apify: p.apifyApiKey || '',
      }
    } catch {}

    // 补充新通道 + 更新元数据，但不覆盖用户手动设置的 enabled 状态
    for (const def of defaultChannels) {
      const existing = config.channels.find(c => c.id === def.id)
      if (existing) {
        // 不覆盖 enabled — 保留用户手动切换的状态
        existing.needsKey = def.needsKey
        // 预填API Key（优先保留用户手动输入的，其次从配置读取）
        if (!existing.apiKey && profileKeys[existing.id]) {
          existing.apiKey = profileKeys[existing.id]
        }
      } else {
        const newCh = { ...def }
        if (profileKeys[def.id]) newCh.apiKey = profileKeys[def.id]
        config.channels.push(newCh)
      }
    }
    return config
  } catch {
    return defaultConfig()
  }
}

export function saveSearchConfig(config: SearchConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
}
