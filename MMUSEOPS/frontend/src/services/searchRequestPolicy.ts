export const SEARCH_BATCH_TIMEOUT_MS = 300_000

export function toSearchFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '')
  const normalized = message.toLowerCase()

  if (normalized.includes('safe_mode_blocked') || normalized.includes('safe mode') || normalized.includes('"blocked":true')) {
    return '安全模式下未执行真实搜索'
  }
  if (normalized.includes('search_not_configured') || normalized.includes('not configured')) {
    return '搜索服务未配置'
  }
  if (normalized.includes('429') || normalized.includes('rate limit') || normalized.includes('quota')) {
    return 'JustSerp 请求过于频繁或额度暂不可用'
  }
  if (normalized.includes('401') || normalized.includes('403') || normalized.includes('api key') || normalized.includes('unauthorized')) {
    return 'JustSerp 凭据无效或没有访问权限'
  }
  if (normalized.includes('abort') || normalized.includes('timeout') || normalized.includes('timed out')) {
    return '等待搜索 provider 响应超时，请检查网络或代理'
  }
  if (normalized.includes('fetch failed') || normalized.includes('network') || normalized.includes('enotfound') || normalized.includes('econn')) {
    return 'API连接失败'
  }
  if (normalized.includes('provider_failed') || normalized.includes('provider failed')) {
    const provider = normalized.includes('justserp') ? 'JustSerp' : normalized.includes('serper') ? 'Serper' : '搜索 provider'
    return `${provider} 服务异常，请检查 provider 状态`
  }
  return '搜索服务异常，服务端未返回明确原因'
}