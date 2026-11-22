/** 用户公司信息 + API 配置持久化 */
import { configureOutreachIdentity } from '../services/emailSignature'

export interface UserProfile {
  companyName: string
  productInfo: string
  hasFactory: boolean
  industryAdvantage: string
  yearsInBusiness: string
  email: string
  website: string
  // 收款信息
  bankName: string
  bankAccount: string
  swiftCode: string
  bankAddress: string
  // API 密钥
  serperApiKey: string
  serperApiKey2: string
  llmApiKey: string
  llmBaseUrl: string
  llmModel: string
  justserpApiKey: string
  justserpApiKey2: string
  apifyApiKey: string
  hunterApiKey: string
  braveApiKey: string
  resendApiKey: string
  snovioUserId: string
  snovioSecret: string
  zohoEmail: string
  zohoPassword: string
}

const STORAGE_KEY = 'mmuse_user_profile'

const defaultProfile: UserProfile = {
  companyName: '',
  productInfo: '',
  hasFactory: false,
  industryAdvantage: '',
  yearsInBusiness: '',
  email: '',
  website: '',
  bankName: '',
  bankAccount: '',
  swiftCode: '',
  bankAddress: '',
  serperApiKey: '',
  serperApiKey2: '',
  llmApiKey: '',
  llmBaseUrl: '',
  llmModel: '',
  justserpApiKey: '',
  justserpApiKey2: '',
  apifyApiKey: '',
  hunterApiKey: '',
  braveApiKey: '',
  resendApiKey: '',
  snovioUserId: '',
  snovioSecret: '',
  zohoEmail: '',
  zohoPassword: '',
}

export function loadProfile(): UserProfile {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    const merged = saved ? { ...defaultProfile, ...JSON.parse(saved) } : defaultProfile
    configureOutreachIdentity(merged)
    return merged
  } catch {
    return defaultProfile
  }
}

export function saveProfile(profile: UserProfile): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...profile, zohoPassword: '' }))
  configureOutreachIdentity(profile)
}

loadProfile()
