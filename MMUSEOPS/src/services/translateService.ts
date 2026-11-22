import { API_BASE } from './config'
/**
 * 国家→语言映射 + 多语言翻译服务
 * 根据客户所在国家自动选择开发信语言
 */

/** 国家→语言映射 */
const COUNTRY_LANGUAGE: Record<string, { lang: string; label: string }> = {
  // 英语国家
  'US': { lang: 'en', label: '英语' },
  'USA': { lang: 'en', label: '英语' },
  'United States': { lang: 'en', label: '英语' },
  'UK': { lang: 'en', label: '英语' },
  'United Kingdom': { lang: 'en', label: '英语' },
  'GB': { lang: 'en', label: '英语' },
  'CA': { lang: 'en', label: '英语' },
  'Canada': { lang: 'en', label: '英语' },
  'AU': { lang: 'en', label: '英语' },
  'Australia': { lang: 'en', label: '英语' },
  'NZ': { lang: 'en', label: '英语' },
  'New Zealand': { lang: 'en', label: '英语' },
  'IE': { lang: 'en', label: '英语' },
  'Ireland': { lang: 'en', label: '英语' },
  'ZA': { lang: 'en', label: '英语' },
  'South Africa': { lang: 'en', label: '英语' },
  'SG': { lang: 'en', label: '英语' },
  'Singapore': { lang: 'en', label: '英语' },
  'IN': { lang: 'en', label: '英语' },
  'India': { lang: 'en', label: '英语' },
  'PH': { lang: 'en', label: '英语' },
  'Philippines': { lang: 'en', label: '英语' },

  // 欧洲语言
  'DE': { lang: 'de', label: '德语' },
  'Germany': { lang: 'de', label: '德语' },
  'AT': { lang: 'de', label: '德语' },
  'Austria': { lang: 'de', label: '德语' },
  'CH': { lang: 'de', label: '德语' },
  'Switzerland': { lang: 'de', label: '德语' },
  'FR': { lang: 'fr', label: '法语' },
  'France': { lang: 'fr', label: '法语' },
  'BE': { lang: 'fr', label: '法语' },
  'Belgium': { lang: 'fr', label: '法语' },
  'ES': { lang: 'es', label: '西班牙语' },
  'Spain': { lang: 'es', label: '西班牙语' },
  'MX': { lang: 'es', label: '西班牙语' },
  'Mexico': { lang: 'es', label: '西班牙语' },
  'IT': { lang: 'it', label: '意大利语' },
  'Italy': { lang: 'it', label: '意大利语' },
  'PT': { lang: 'pt', label: '葡萄牙语' },
  'Portugal': { lang: 'pt', label: '葡萄牙语' },
  'BR': { lang: 'pt', label: '葡萄牙语' },
  'Brazil': { lang: 'pt', label: '葡萄牙语' },
  'NL': { lang: 'nl', label: '荷兰语' },
  'Netherlands': { lang: 'nl', label: '荷兰语' },
  'PL': { lang: 'pl', label: '波兰语' },
  'Poland': { lang: 'pl', label: '波兰语' },
  'SE': { lang: 'sv', label: '瑞典语' },
  'Sweden': { lang: 'sv', label: '瑞典语' },
  'NO': { lang: 'no', label: '挪威语' },
  'Norway': { lang: 'no', label: '挪威语' },
  'DK': { lang: 'da', label: '丹麦语' },
  'Denmark': { lang: 'da', label: '丹麦语' },
  'FI': { lang: 'fi', label: '芬兰语' },
  'Finland': { lang: 'fi', label: '芬兰语' },
  'RU': { lang: 'ru', label: '俄语' },
  'Russia': { lang: 'ru', label: '俄语' },
  'CZ': { lang: 'cs', label: '捷克语' },
  'Czech Republic': { lang: 'cs', label: '捷克语' },
  'RO': { lang: 'ro', label: '罗马尼亚语' },
  'Romania': { lang: 'ro', label: '罗马尼亚语' },
  'HU': { lang: 'hu', label: '匈牙利语' },
  'Hungary': { lang: 'hu', label: '匈牙利语' },
  'GR': { lang: 'el', label: '希腊语' },
  'Greece': { lang: 'el', label: '希腊语' },
  'TR': { lang: 'tr', label: '土耳其语' },
  'Turkey': { lang: 'tr', label: '土耳其语' },

  // 亚洲语言
  'JP': { lang: 'ja', label: '日语' },
  'Japan': { lang: 'ja', label: '日语' },
  'KR': { lang: 'ko', label: '韩语' },
  'South Korea': { lang: 'ko', label: '韩语' },
  'TH': { lang: 'th', label: '泰语' },
  'Thailand': { lang: 'th', label: '泰语' },
  'VN': { lang: 'vi', label: '越南语' },
  'Vietnam': { lang: 'vi', label: '越南语' },
  'ID': { lang: 'id', label: '印尼语' },
  'Indonesia': { lang: 'id', label: '印尼语' },
  'MY': { lang: 'ms', label: '马来语' },
  'Malaysia': { lang: 'ms', label: '马来语' },
  'TW': { lang: 'zh-TW', label: '繁体中文' },
  'Taiwan': { lang: 'zh-TW', label: '繁体中文' },
  'HK': { lang: 'zh-TW', label: '繁体中文' },
  'Hong Kong': { lang: 'zh-TW', label: '繁体中文' },

  // 中东
  'AE': { lang: 'ar', label: '阿拉伯语' },
  'UAE': { lang: 'ar', label: '阿拉伯语' },
  'United Arab Emirates': { lang: 'ar', label: '阿拉伯语' },
  'SA': { lang: 'ar', label: '阿拉伯语' },
  'Saudi Arabia': { lang: 'ar', label: '阿拉伯语' },
  'IL': { lang: 'he', label: '希伯来语' },
  'Israel': { lang: 'he', label: '希伯来语' },

  // 南美
  'AR': { lang: 'es', label: '西班牙语' },
  'Argentina': { lang: 'es', label: '西班牙语' },
  'CL': { lang: 'es', label: '西班牙语' },
  'Chile': { lang: 'es', label: '西班牙语' },
  'CO': { lang: 'es', label: '西班牙语' },
  'Colombia': { lang: 'es', label: '西班牙语' },
  'PE': { lang: 'es', label: '西班牙语' },
  'Peru': { lang: 'es', label: '西班牙语' },
}

/** 从国家名或代码获取语言 */
export function getLanguageByCountry(country: unknown): { lang: string; label: string } {
  const value = typeof country === 'string'
    ? country
    : Array.isArray(country)
      ? country.find((entry): entry is string => typeof entry === 'string') || ''
      : country && typeof country === 'object'
        ? (() => {
            const record = country as Record<string, unknown>
            return [record.country, record.name, record.label, record.code]
              .find((entry): entry is string => typeof entry === 'string') || ''
          })()
        : ''
  const fallback = { lang: 'en', label: 'English' }
  if (!value.trim()) return fallback
  const normalized = value.trim()
  if (COUNTRY_LANGUAGE[normalized]) return COUNTRY_LANGUAGE[normalized]
  const lower = normalized.toLowerCase()
  for (const [key, val] of Object.entries(COUNTRY_LANGUAGE)) {
    if (key.toLowerCase() === lower) return val
  }
  for (const [key, val] of Object.entries(COUNTRY_LANGUAGE)) {
    if (lower.includes(key.toLowerCase()) || key.toLowerCase().includes(lower)) return val
  }
  return fallback
}

/** 检测文本是否包含中文 */
function hasChinese(text: string): boolean {
  return /[一-鿿]/.test(text)
}

/**
 * 翻译文本到目标语言
 * @param text 原文（中文或英文）
 * @param targetLang 目标语言代码（en/de/fr/es 等）
 * @returns 翻译后的文本
 */
export async function translateTo(text: string, targetLang: string): Promise<string> {
  if (!text.trim()) return text
  if (targetLang === 'en' && !hasChinese(text)) return text // 英文原文不需要翻译
  if (targetLang === 'zh-TW') return text // 繁体暂时不翻译

  try {
    const resp = await fetch(`${API_BASE}/api/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, target: targetLang }),
    })
    if (!resp.ok) return text
    const data = (await resp.json()) as { translated?: string }
    return data.translated || text
  } catch {
    return text
  }
}

/**
 * 批量翻译邮件草稿
 * 将中文草稿翻译为目标语言
 */
export async function translateDraft(
  subjectCn: string,
  bodyCn: string,
  targetLang: string,
): Promise<{ subject: string; body: string }> {
  if (targetLang === 'zh-TW' || targetLang === 'zh') {
    return { subject: subjectCn, body: bodyCn }
  }
  const [subject, body] = await Promise.all([
    translateTo(subjectCn, targetLang),
    translateTo(bodyCn, targetLang),
  ])
  return { subject, body }
}

export { COUNTRY_LANGUAGE }

/** 将中文关键词翻译为英文（兼容旧接口） */
export async function translateToEnglish(text: string): Promise<string> {
  return translateTo(text, 'en')
}
