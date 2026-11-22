/** 搜索目标参数持久化 */
export interface SearchTarget {
  country: string
  customCountry?: string
  industry: string
  customIndustry?: string
  city?: string
  channels?: string[]
  keywords: string
}

const STORAGE_KEY = 'mmuse_search_target'

const defaultTarget: SearchTarget = {
  country: 'US',
  industry: 'furniture',
  keywords: '',
}

const countryOptions = [
  { value: 'US', label: '美国' },
  { value: 'CA', label: '加拿大' },
  { value: 'UK', label: '英国' },
  { value: 'AU', label: '澳大利亚' },
  { value: 'DE', label: '德国' },
  { value: 'FR', label: '法国' },
  { value: 'AE', label: '阿联酋' },
  { value: 'SG', label: '新加坡' },
  { value: 'JP', label: '日本' },
  { value: 'custom', label: '自定义' },
]

const industryOptions = [
  { value: 'furniture', label: '家具' },
  { value: 'car-seat', label: '汽车座椅套' },
  { value: 'lighting', label: '照明' },
  { value: 'home', label: '家居日用' },
  { value: 'packaging', label: '包装材料' },
  { value: 'custom', label: '自定义' },
]

export { countryOptions, industryOptions }

export function loadSearchTarget(): SearchTarget {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    return saved ? { ...defaultTarget, ...JSON.parse(saved) } : defaultTarget
  } catch {
    return { ...defaultTarget }
  }
}

export function saveSearchTarget(target: SearchTarget): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(target))
}
