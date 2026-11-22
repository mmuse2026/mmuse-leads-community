import * as cheerio from 'cheerio'

export type BackcheckAccessStatus = 'READY_HTTP' | 'READY_BROWSER' | 'HUMAN_REQUIRED' | 'LOW_VALUE' | 'BLOCKED'
export type BackcheckRenderMode = 'http' | 'browser' | 'manual' | 'skip'

export interface BackcheckPreflightPlan {
  checkedAt: string
  url: string
  finalUrl: string
  httpStatus: number | null
  accessStatus: BackcheckAccessStatus
  renderMode: BackcheckRenderMode
  antibotType?: string
  captchaPresent: boolean
  loginRequired: boolean
  publicContactSignal: boolean
  responseMs: number
  pageTargets: string[]
  actionPlan: string[]
  stopConditions: string[]
  fallbackPlan: string[]
  evidence: string[]
}

export interface PreflightResponse {
  status: number
  url: string
  text(): Promise<string>
}

const CONTACT_PATHS = /(?:about|company|contact|team|leadership|management|product|service|catalog|solution|supplier|factory|capabilit)/i
const ANTIBOT_PATTERNS: Array<[RegExp, string]> = [
  [/cloudflare|cf-chl-|challenge-platform|turnstile/i, 'cloudflare'],
  [/datadome|captcha__|ddjskey/i, 'datadome'],
  [/akamai|_abck|bm_sz/i, 'akamai'],
  [/imperva|incap_ses|visid_incap/i, 'imperva'],
]

function unique(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}

function absoluteUrl(value: string, base: string): string | undefined {
  try {
    const url = new URL(value, base)
    if (!/^https?:$/.test(url.protocol)) return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

function timeoutSignal(ms: number): AbortSignal {
  return AbortSignal.timeout(ms)
}

function basePlan(url: string): BackcheckPreflightPlan {
  return {
    checkedAt: new Date().toISOString(),
    url,
    finalUrl: url,
    httpStatus: null,
    accessStatus: 'BLOCKED',
    renderMode: 'skip',
    captchaPresent: false,
    loginRequired: false,
    publicContactSignal: false,
    responseMs: 0,
    pageTargets: [url],
    actionPlan: [],
    stopConditions: ['验证码或明确的人机验证', '登录墙或要求本人确认', '连续浏览器请求失败'],
    fallbackPlan: ['HTTP 失败时切换自动浏览器', '浏览器仍被拦截时保存证据并停止该网站'],
    evidence: [],
  }
}

export function classifyBackcheckHtml(url: string, finalUrl: string, status: number, html: string, responseMs = 0): BackcheckPreflightPlan {
  const plan = basePlan(url)
  plan.finalUrl = finalUrl
  plan.httpStatus = status
  plan.responseMs = responseMs
  const lower = html.toLowerCase()
  const $ = cheerio.load(html)
  const title = $('title').first().text().trim()
  const visibleText = $('body').text().replace(/\s+/g, ' ').trim()
  const scriptCount = $('script').length
  const visibleWordCount = visibleText.split(/\s+/).filter(Boolean).length
  const captcha = /captcha|verify you are human|人机验证|请完成验证|challenge/i.test(lower)
  const login = /sign in|log in|login required|登录后|请登录/i.test(`${title} ${visibleText}`)
  const antibot = ANTIBOT_PATTERNS.find(([pattern]) => pattern.test(lower))?.[1]
  const targetLinks = $('a[href]')
    .map((_index, element) => {
      const href = $(element).attr('href') || ''
      const text = $(element).text().trim()
      return CONTACT_PATHS.test(`${href} ${text}`) ? absoluteUrl(href, finalUrl) : undefined
    })
    .get()
    .filter((value): value is string => Boolean(value))
  plan.pageTargets = unique([finalUrl, ...targetLinks]).slice(0, 8)
  plan.captchaPresent = captcha
  plan.loginRequired = login
  plan.antibotType = antibot
  plan.publicContactSignal = /@|\bemail\b|\bphone\b|\btel\b|contact|地址|电话|邮箱/i.test(`${lower} ${visibleText}`)

  if (status === 401 || status === 407 || login || captcha) {
    plan.accessStatus = 'HUMAN_REQUIRED'
    plan.renderMode = 'manual'
    plan.evidence.push(login ? '页面出现登录要求' : '页面出现验证码/人机验证')
    if (antibot) plan.evidence.push(`检测到 ${antibot} 相关信号`)
    plan.actionPlan = ['保存当前页面证据', '不继续自动重试', '需要授权时再由用户登录或确认']
    return plan
  }

  if (status === 404 || status === 410 || status >= 500) {
    plan.accessStatus = status >= 500 ? 'BLOCKED' : 'LOW_VALUE'
    plan.renderMode = 'skip'
    plan.evidence.push(`HTTP ${status}`)
    plan.actionPlan = ['记录状态码', '跳过本轮深度背调']
    return plan
  }

  if (status >= 400) {
    plan.accessStatus = 'BLOCKED'
    plan.renderMode = 'skip'
    plan.evidence.push(`HTTP ${status}`)
    plan.actionPlan = ['记录访问失败', '冷却后再评估，不提高并发']
    return plan
  }

  const browserLikely = visibleWordCount < 40 && scriptCount >= 3
  if (browserLikely) {
    plan.accessStatus = 'READY_BROWSER'
    plan.renderMode = 'browser'
    plan.evidence.push(`可见文本较少(${visibleWordCount}词)，脚本较多(${scriptCount})，疑似动态渲染`)
    plan.actionPlan = [
      '启动自动浏览器上下文',
      '等待 DOM 和网络空闲',
      '滚动页面触发延迟加载',
      '访问 pageTargets 中的公开页面并提取证据',
      '遇到验证码/登录墙立即转 HUMAN_REQUIRED',
    ]
    return plan
  }

  if (visibleWordCount < 8) {
    plan.accessStatus = 'LOW_VALUE'
    plan.renderMode = 'skip'
    plan.evidence.push('页面几乎没有可见业务文本')
    plan.actionPlan = ['记录空页面证据', '不进入深度联系人抓取']
    return plan
  }

  plan.accessStatus = 'READY_HTTP'
  plan.renderMode = 'http'
  plan.evidence.push(`静态页面可读取(${visibleWordCount}词)`)
  plan.actionPlan = [
    '使用 HTTP/cheerio 抓取首页',
    '按 pageTargets 选择公开的 About、Contact、Team、Products 页面',
    '保存页面 URL 和提取证据',
  ]
  return plan
}

export async function runBackcheckPreflight(url: string, fetchFn: typeof fetch = fetch): Promise<BackcheckPreflightPlan> {
  const normalized = url.startsWith('http://') || url.startsWith('https://') ? url : `https://${url}`
  const started = Date.now()
  try {
    const response = await fetchFn(normalized, {
      redirect: 'follow',
      headers: { Accept: 'text/html,application/xhtml+xml' },
      signal: timeoutSignal(8000),
    })
    const html = await response.text()
    return classifyBackcheckHtml(normalized, response.url || normalized, response.status, html, Date.now() - started)
  } catch (error) {
    const plan = basePlan(normalized)
    plan.responseMs = Date.now() - started
    plan.evidence.push(error instanceof Error ? error.message.slice(0, 180) : String(error).slice(0, 180))
    plan.actionPlan = ['记录 DNS/连接/超时错误', '不重复高并发请求', '必要时切换浏览器进行一次低频验证']
    return plan
  }
}
