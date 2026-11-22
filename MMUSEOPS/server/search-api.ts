import { configureOutreachIdentity, normalizeEmailSignature } from '../src/services/emailSignature'
import { productionProfileId } from '../src/services/crmBusinessScope'
/**
 * 闂佺懓鍚嬬划搴ㄥ磼?API 闂?闂備焦褰冪粔鎾疮閹剧粯鍋?(2026-07-07)
 *
 * 闂佸憡鐟﹁摫婵炴彃娼￠弫? *  - 闂佸湱顣介崑鎾绘煛?HTTP 闁荤姴顑呴崯浼村极閵堝缁╅柛锔诲幗閺?Node.js 闂佸憡顭囬崰鎾诲极?fetch
 *  - 缂備礁顦…宄扳枍?execSync / curl.exe / 婵炴垶鎸搁悺銊ヮ渻閸岀偛妫橀柛銉檮椤愪粙鏌熼崹顔拘＄紓?
 *  - 缂備礁顦…宄扳枍鎼达絾鍏滄い鎺戝€诲浠嬫煟?LLM API Key
 *  - 濠电儑缍€椤曆勬叏閻愮儤鐓ユ繛鍡樺俯閸ゆ牠姊洪幓鎺斝ラ柣?+ 闂佸湱顭堝ú锕傚汲閻斿吋鐒婚柍褜鍓熼弻? *  - 濠电儑缍€椤曆勬叏?rate limiting (5 req/s per IP)
 *  - 闂佸搫鍊瑰姗€路?/api/llm-backcheck 缂備焦妫忛崹鎶藉磻閿濆鏅柛锔筋渽recrawl 婵炴垶鎸哥粔褰掑焵椤掍胶顣叉俊鐐插€块幆鍐礋椤旂厧澹掗柣?fallback闂? *  - 闂佸搫鍊瑰姗€路?Brave Search 闂備緡鍋呭畝鍛婄妤ｅ啫缁╂い鏍ㄧ☉閻? *  - 闂佸搫鍊瑰姗€路?channel 闂佸憡鐟ラ崐褰掑汲閻旂儤宕夋い鏍ㄧ矋閺? */
import { getSearchResultScore, summarizeSearchTags } from '../src/services/searchResultPolicy'
import { FORMAL_CSRF_HEADER, FORMAL_OPERATOR_HEADER, FORMAL_SEND_GRANT_HEADER } from '../src/services/formalQueueAuth'
import { formalAuthInput, readFormalHeader } from './formal-auth-input'
import { getLeadStageEligibility, applyEligibilityStage } from '../src/services/leadStageEligibility'
import { applyEmailDispositionCommandToItem, EmailDispositionCommandError, isApplicationJsonContentType, validateEmailDispositionCommandBody } from '../src/services/emailDispositionCommand'
import { validateItemSaveCommandBody } from '../src/services/itemSaveCommand'
import { applyCrmCommand, validateCrmCommandBody } from './crm-command'
import { findPersistedDraft, updatePersistedDraft } from '../src/services/draftLookup'
import { rejectDraftForRework } from '../src/services/draftReview'
import { generateDraft } from '../src/data/emailGenerator'
import { canSendFormalOutreach } from '../src/services/formalSendGate'
import { cardForItem, countItemsByCrmCard } from '../src/services/crmCardRouting'
import { LOCAL_WEBMODEL_API_KEY, LOCAL_WEBMODEL_BASE_URL, LOCAL_WEBMODEL_MODEL, normalizeLlmBaseUrl } from '../src/services/llm-client'
import { JustSerpHttpError, SerperHttpError, normalizeJustSerpKeys, normalizeSerperKeys, resetJustSerpKeyPool, resetSerperKeyPool, runWithJustSerpKeyPool, runWithSerperKeyPool } from '../src/services/justSerpKeyPool'

import http from 'http'
import { automaticContentMatches, automaticDemandTopics, automaticContentProduction } from './automatic-content-matching'
import { readMarketingBridge, readMarketingCustomers, marketingOutcomes, marketingCustomerRef } from './marketing-bridge'
import { gzipSync, createGzip } from 'zlib'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, appendFileSync, statSync, openSync, closeSync, unlinkSync, readdirSync, mkdirSync } from 'fs'
import { join, extname } from 'path'
import { setGlobalDispatcher, ProxyAgent, Agent } from 'undici'
import nodemailer from 'nodemailer'
import { FORMAL_SEND_QUEUE_FILE, mutateFormalSendQueue, planCurrentFormalQueueRecords, readFormalSendQueue, queueDashboard } from './formal-send-queue-store'
import { publicFormalQueueDashboardResponse, publicFormalQueueResponse } from './formal-queue-public-response'
import { pauseFormalSendQueue } from './formal-send-linearizer'
import { getFormalSentEmailsCached } from './formal-sent-email-set'
import { getTestMailVerdictsCached } from './test-mail-verdicts'
import { readTestMailQueue } from './test-mail-queue-store'
import { runDueFormalOnce } from './queue-runtime'
import { testMailQueueDashboard } from '../src/services/testMailQueue'
import { addIsolation, addIsolationBatch, isolationTotal, listIsolation, readIsolationStore, setInitialExcludedRegisteredAt, todayIsolationCount } from './isolation-store'
import { classifyTestMailCandidate } from '../src/services/testMailCandidatePolicy'
import { ITEMS_STORE_FILE, readItemsAtomic, readItemsDirect, updateItemsAtomic, updateOneItemAtomic } from './items-store-atomic'
import { classifyCustomer } from './business-customer-partition'
import { approveFormalDraftTransaction, recoverFormalApprovalIntents } from './formal-approval-transaction'
import { manualFormalSendOne } from './manual-formal-send-one'
import { createReviewDraft, validateCreateReviewDraft } from './draft-review-create'
import { sendCrmReplyOne } from './manual-crm-reply-send'
import { validateCrmReplyRequest } from './crm-reply-request'
import { reviewCrmReply } from './crm-reply-review'
import { importMailboxMessage } from './mailbox-message-import'
import { analyzePersistedMailboxMessage } from './mailbox-message-analysis'
import { generateCrmReplyDraft, translateCrmReplyContent } from './crm-reply-drafter'
import { applyLocalCors } from './local-cors'
import { inferCustomerTimezone, reconcileConfirmedNotSent, validateFormalRecipientConsistency, type FormalSendQueueRecord } from '../src/services/formalSendQueue'
import { checkExternalAction, SAFE_MODE } from './safety-gate'
import { runPipelineStepper } from './pipeline-stepper'
import { businessPipelines } from './business-pipelines'
import { businessPipelineCustomers } from './business-pipeline-customers'
import { openActiveCustomerRegistry } from './business-customer-registry'
import { customerDetail, updateCustomerDetail } from './business-customer-detail'
import { businessSplitActive } from './business-split-mode'
import { readBusinessLlm, updateBusinessLlm } from './business-llm-config'
import { RuntimeLedger } from './runtime-ledger'
import { publicRuntimeWorkers } from './runtime-status'
import { updateTrialMonitor } from './trial-monitor'
import { readPipelineControl, setPipelineRunning } from './pipeline-control-store'
import { autorouteMechanicallyBlockedDrafts } from './draft-review-autoroute'
import { FormalQueueSecurity, publicCustomerRouteRef, validateExactFormalMutationBody, validateFormalMutationBody } from './formal-queue-security'
import { claimFormalSendGrantTargets, issueLockedFormalSendGrant } from './formal-send-claim'
import { getMailIsolationStatus, type MailIsolationConfig } from './mail-isolation-config'
import { runBackcheckPreflight, type BackcheckPreflightPlan } from './backcheck-preflight'
import { registerBounceIsolation } from './bounce-isolation'
import { readWebhookSyncStatus, synchronizeWorkerEvents } from './webhook-event-sync'
import { OFFICIAL_OUTREACH_EMAIL } from '../src/services/outreachIdentity'
import { sendFormalEmail } from './formal-smtp-transport'
import { applyZohoMessages, fetchZohoMessagesReadOnly, parseManualZohoMessage, type ZohoSyncState } from './zoho-imap-sync'
import { runFormalAutoSchedulerTick } from './formal-auto-scheduler'
import {
  createSnovioTask,
  getResumableTask,
  mergeSnovioCandidates,
  normalizeSnovioProviderData,
} from './snovio-domain-search'
import {
  getSchedulerState,
  startScheduler,
  pauseScheduler,
  resumeScheduler,
  resetDailyCount,
  updateSchedulerConfig,
} from './snovio-scheduler'

import * as cheerio from 'cheerio'

function runBundledCrawl(request: { url?: string; company?: string; country?: string; business?: string }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (!process.send || !process.connected) {
      reject(new Error('CRAWL_RUNTIME_UNAVAILABLE'))
      return
    }
    const id = randomUUID()
    const finish = (error?: Error, result?: { stdout: string; stderr: string }) => {
      clearTimeout(timer)
      process.removeListener('message', onMessage)
      if (error) reject(error)
      else if (result) resolve(result)
    }
    const onMessage = (message: any) => {
      if (message?.type !== 'mmuse:crawl-result' || message.id !== id) return
      if (message.error) finish(new Error(String(message.error)))
      else finish(undefined, { stdout: String(message.stdout || ''), stderr: String(message.stderr || '') })
    }
    const timer = setTimeout(() => finish(new Error('CRAWL_RUNTIME_TIMEOUT')), 38_000)
    process.on('message', onMessage)
    process.send({ type: 'mmuse:crawl-request', id, request }, (error: Error | null) => {
      if (error) finish(new Error('CRAWL_RUNTIME_UNAVAILABLE'))
    })
  })
}


const PORT = parseInt(process.env.PORT || '3001')
const DIST_DIR = join(__dirname, '..', 'dist')
const RUNTIME_DIR = join(__dirname, '..', 'logs', 'runtime')
function activeCustomerRegistry() {
  return openActiveCustomerRegistry()
}
mkdirSync(RUNTIME_DIR, { recursive: true })
const runtimeLedger = new RuntimeLedger(join(RUNTIME_DIR, 'workers.sqlite'))
process.once('exit', () => runtimeLedger.close())
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}
const PROXY_URL = process.env.HTTP_PROXY || process.env.https_proxy || ''
const SERPER_URLS: Record<string, string> = {
  web: 'https://google.serper.dev/search',
  news: 'https://google.serper.dev/news',
  places: 'https://google.serper.dev/places',
}
const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search'
const GLEIF_API_URL = 'https://api.gleif.org/api/v1/lei-records'
const WIKIDATA_API_URL = 'https://www.wikidata.org/w/api.php'

// ---- 闂佺绻堥崝宀勬儑椤掍胶顩烽柨婵嗘处閸婄偤鎮规担绋库挃闁?----
if (PROXY_URL) {
  try {
    setGlobalDispatcher(new ProxyAgent(PROXY_URL))
    console.log('[proxy] configured')
  } catch {
    console.warn('[proxy] configuration failed')
  }
}

// Direct dispatcher: bypasses the global proxy for loopback LLM endpoints
// (e.g. local WebModel AI Gateway). undici ProxyAgent tunnels loopback too,
// which the local proxy (v2rayN) closes, so loopback must go straight.
const directDispatcher = new Agent()

// Search provider key locations
const CONFIG_FILE = join(__dirname, '..', 'user_config.json')

interface UserConfig extends Partial<MailIsolationConfig> {
  serperApiKey?: string
  serperApiKey2?: string
  serperApiKeys?: string[]
  llmApiKey?: string
  llmBaseUrl?: string
  llmModel?: string
  llmBackupApiKey?: string
  llmBackupBaseUrl?: string
  llmBackupModel?: string
  llmCredentialSource?: string
  llmBackupEnabled?: boolean
  contactMiningEnabled?: boolean
  formalSupervisedOnly?: boolean
  formalQualityGateEnabled?: boolean
  formalDailyLimit?: number
  braveApiKey?: string
  justserpApiKey?: string
  justserpApiKey2?: string
  justserpApiKeys?: string[]
  apifyApiKey?: string
  hunterApiKey?: string
  prospeoApiKey?: string
  resendApiKey?: string
  snovioUserId?: string
  snovioSecret?: string
  zohoEmail?: string
  zohoPassword?: string
  businessEmails?: Record<string, string>
}

function maskEmailAddress(value: unknown): string {
  if (typeof value !== 'string') return ''
  const normalized = value.trim()
  const at = normalized.lastIndexOf('@')
  if (at <= 0 || at === normalized.length - 1) return ''
  const local = normalized.slice(0, at)
  const domain = normalized.slice(at + 1)
  return `${local.slice(0, 1)}***@${domain}`
}

let userConfig: UserConfig & { companyName?: string } = {}
async function sendFormalViaZoho(input: { to: string; subject: string; body: string; inReplyTo?: string; references?: string[]; outboundKey?: string }) {
  return sendFormalEmail({ ...input, content: input.body })
}

try {
  if (existsSync(CONFIG_FILE)) {
    userConfig = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'))
  }
} catch (_e) {}

configureOutreachIdentity(userConfig)

function loadSerperApiKeys(): string[] {
  const values: unknown[] = [process.env.SERPER_API_KEY, process.env.SERPER_API_KEY_2, userConfig.serperApiKey, userConfig.serperApiKey2]
  if (Array.isArray(userConfig.serperApiKeys)) values.push(...userConfig.serperApiKeys)
  return normalizeSerperKeys(values)
}

function loadBraveApiKey(): string {
  if (process.env.BRAVE_API_KEY) return process.env.BRAVE_API_KEY
  return userConfig.braveApiKey || ''
}

function getLlmApiKey(): string {
  return String((userConfig as any).llmApiKey || LOCAL_WEBMODEL_API_KEY)
}

function getLlmBaseUrl(): string {
  return String((userConfig as any).llmBaseUrl || LOCAL_WEBMODEL_BASE_URL)
}

function getLlmModel(): string {
  return String((userConfig as any).llmModel || LOCAL_WEBMODEL_MODEL)
}

function getLlmBackupApiKey(): string {
  return (userConfig as any).llmBackupEnabled === false ? '' : String((userConfig as any).llmBackupApiKey || LOCAL_WEBMODEL_API_KEY)
}

function getLlmBackupBaseUrl(): string {
  return String((userConfig as any).llmBackupBaseUrl || LOCAL_WEBMODEL_BASE_URL)
}

function getLlmBackupModel(): string {
  return String((userConfig as any).llmBackupModel || LOCAL_WEBMODEL_MODEL)
}

// ---- Rate Limiting闂佹寧绋戝鐒?memory, per IP闂?----
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT = 30

// Clean expired rate-limit entries.
setInterval(() => {
  const now = Date.now()
  for (const [ip, entry] of Array.from(rateLimitMap.entries())) {
    if (now > entry.resetAt) rateLimitMap.delete(ip)
  }
}, 60_000)

function checkRateLimit(ip: string): boolean {
  const now = Date.now()
  const entry = rateLimitMap.get(ip)
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + 1000 })
    return true
  }
  if (entry.count >= RATE_LIMIT) return false
  entry.count++
  return true
}

// ---- 闁汇埄鍨界粻鎾诲闯閸濄儲瀚氶柡鍥╁У閻?fetch闂佹寧绋戦悧濠勨偓鍨哺瀵偅瀵肩划鐟颁壕闁逞屽墴閺屽棝宕犻敍鍕槷闂佸搫鐗冮崑鎾愁熆?3 濠电偛妫屽Σ鍕?----
async function fetchWithRetry(
  url: string,
  options: RequestInit & { timeout?: number } = {},
  retries = 3,
): Promise<Response> {
  const timeout = options.timeout || 30000
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeout)
      const response = await fetch(url, { ...options, signal: controller.signal })
      clearTimeout(timer)
      if ((response.status === 429 || response.status >= 500) && attempt < retries - 1) {
        const delay = Math.pow(2, attempt) * 1000
        await new Promise((r) => setTimeout(r, delay))
        continue
      }
      return response
    } catch (err: unknown) {
      if (attempt === retries - 1) throw err
      const delay = Math.pow(2, attempt) * 1000
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw new Error('Max retries exceeded')
}

// ---- Serper 闂佺懓鍚嬬划搴ㄥ磼?----
function quickTag(
  product: string,
  title: string,
  snippet: string,
): { tag: string; reason: string } {
  const text = (title + ' ' + snippet).toLowerCase()
  const words = product.toLowerCase().split(/\s+/).filter(Boolean)
  const hasProduct = words.length === 0 || words.some((w) => text.includes(w))
  const hasBuyer = ['distributor', 'wholesale', 'dealer', 'supplier', 'supply', 'importer', 'restaurant', 'hotel', 'hospitality'].some((w) => text.includes(w))
  const hasSeller = ['manufacturer', 'factory', 'oem', 'made in china', 'producer', 'we produce'].some((w) => text.includes(w))
  const isChinese = /\.(cn|com\.cn)$/i.test(title) || /[\u4e00-\u9fa5]/.test(text)

  if (isChinese) return { tag: 'irrelevant', reason: 'Chinese company/domain' }
  if (!hasProduct) return { tag: 'pending', reason: 'Product keyword not detected' }
  if (hasBuyer) return { tag: 'channel', reason: 'Potential buyer/channel keywords detected' }
  if (hasSeller) return { tag: 'peer', reason: 'Manufacturer/supplier keywords detected' }
  return { tag: 'relevant', reason: 'Product keyword matched' }
}

interface SearchItem {
  title: string
  link: string
  snippet: string
}

function searchCountryCode(value: string): string {
  const normalized = value.trim().toLowerCase()
  const names: Record<string, string> = {
    'united states': 'US', usa: 'US', america: 'US',
    canada: 'CA', 'united kingdom': 'GB', uk: 'GB',
    australia: 'AU', germany: 'DE', france: 'FR',
    'united arab emirates': 'AE', uae: 'AE', singapore: 'SG', japan: 'JP',
    brazil: 'BR', india: 'IN', mexico: 'MX', italy: 'IT', spain: 'ES',
  }
  if (/^[a-z]{2}$/i.test(value)) return value.toUpperCase()
  return names[normalized] || 'US'
}
async function searchSerper(query: string, apiKey: string, searchType = 'web', country = 'US'): Promise<SearchItem[]> {
  const url = SERPER_URLS[searchType] || SERPER_URLS.web
  const resp = await fetchWithRetry(
    url,
    {
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q: query, gl: searchCountryCode(country), num: 20 }),
    },
    1,
  )

  if (!resp.ok) {
    throw new SerperHttpError(resp.status)
  }

  const data = (await resp.json()) as {
    organic?: { title: string; link: string; snippet: string }[]
    news?: { title: string; link: string; snippet: string }[]
    places?: { title: string; address: string; latitude?: number; longitude?: number }[]
  }
  if (searchType === 'news' && data.news?.length) {
    return data.news.map((r) => ({ title: r.title, link: r.link, snippet: r.snippet }))
  }
  if (searchType === 'places' && data.places?.length) {
    return data.places.map((r) => ({ title: r.title, link: '', snippet: r.address || '' }))
  }
  return (
    data.organic?.map((r) => ({
      title: r.title,
      link: r.link,
      snippet: r.snippet,
    })) || []
  )
}

async function searchBrave(query: string, apiKey: string, country = 'US'): Promise<SearchItem[]> {
  const url = `${BRAVE_SEARCH_URL}?q=${encodeURIComponent(query)}&count=20&country=${encodeURIComponent(searchCountryCode(country))}`
  const resp = await fetchWithRetry(
    url,
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey,
      },
    },
    3,
  )

  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`Brave Search API 闁哄鏅滈弻銊ッ?${resp.status}: ${text}`)
  }

  const data = (await resp.json()) as {
    web?: { results?: { title: string; url: string; description: string }[] }
  }
  return (
    data.web?.results?.map((r) => ({
      title: r.title,
      link: r.url,
      snippet: r.description || '',
    })) || []
  )
}

async function searchGleif(query: string): Promise<SearchItem[]> {
  const url = `${GLEIF_API_URL}?page[number]=1&page[size]=10&filter[entity.legalName]=${encodeURIComponent(query)}`
  const resp = await fetchWithRetry(url, { method: 'GET', timeout: 15000 }, 2)
  if (!resp.ok) throw new Error(`REGISTRY_HTTP_${resp.status}`)
  const data = await resp.json() as any
  const results = data?.data || []
  return results.map((item: any) => {
    const attrs = item.attributes || {}
    const entity = attrs.entity || {}
    return {
      title: entity?.legalName?.name || entity?.legalName || '',
      link: `https://search.gleif.org/#/record/${item.id}`,
      snippet: `Status: ${attrs.registration?.status || 'N/A'} | Jurisdiction: ${entity?.jurisdiction || ''} | Address: ${entity?.legalAddress?.city || ''}, ${entity?.legalAddress?.country || ''}`,
    }
  })
}

async function searchWikidata(query: string): Promise<SearchItem[]> {
  const url = `${WIKIDATA_API_URL}?action=wbsearchentities&search=${encodeURIComponent(query)}&language=en&format=json&origin=*`
  const resp = await fetchWithRetry(url, { method: 'GET', timeout: 15000 }, 2)
  if (!resp.ok) throw new Error(`REGISTRY_HTTP_${resp.status}`)
  const data = await resp.json() as any
  const results = data?.search || []
  return results.map((item: any) => ({
    title: item.label || '',
    link: `https://www.wikidata.org/wiki/${item.id}`,
    snippet: item.description || `Wikidata entity: ${item.id}`,
  }))
}

// ---- JustSerp 闂佺懓鍚嬬划搴ㄥ磼?----
async function searchJustSerp(query: string, apiKey: string, country = 'US'): Promise<SearchItem[]> {
  const url = 'https://api.justserp.com/v1/search'
  const resp = await fetchWithRetry(
    url,
    {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q: query, gl: searchCountryCode(country).toLowerCase(), hl: 'en', num: 20 }),
    },
    1,
  )

  if (!resp.ok) {
    throw new JustSerpHttpError(resp.status)
  }

  const data = await resp.json() as {
    organic_results?: { title: string; link: string; description: string }[]
  }
  return (
    data.organic_results?.map((r) => ({
      title: r.title,
      link: r.link,
      snippet: r.description || '',
    })) || []
  )
}

// ---- 闂佺懓鍚嬬划搴ㄥ磼閵娾晜鈷旂€广儱娲悰鎾绘煕閿濆海鍘滅紒杈╂ustSerp 闂?Serper 闂?Brave ----
async function searchWithFallback(
  query: string,
  searchType: string,
  country: string,
): Promise<{ items: SearchItem[]; channel: string; errors?: string[] }> {
  const errors: string[] = []
  const justserpKeys = normalizeJustSerpKeys(userConfig)
  const serperKeys = loadSerperApiKeys()
  const braveKey = loadBraveApiKey()

  // 婵炴潙鍚嬮敋闁告ɑ绋撻惀?: JustSerp
  if (justserpKeys.length > 0) {
    const attempt = await runWithJustSerpKeyPool(justserpKeys, key => searchJustSerp(query, key, country))
    if (attempt.ok) {
      if (attempt.value.length > 0) return { items: attempt.value, channel: 'justserp' }
    } else if (attempt.statuses.length > 0) {
      const statusText = attempt.statuses.map(status => status || 'network').join(',')
      errors.push(`JustSerp HTTP ${statusText}`)
      try {
        appendFileSync('api_log.txt', `[${new Date().toISOString()}] JustSerp搜索查询失败 q="${query}" status=${statusText}\n`)
      } catch (_e) {}
    }
  }

  // 婵炴潙鍚嬮敋闁告ɑ绋撻惀?: Serper
  if (serperKeys.length > 0) {
    const attempt = await runWithSerperKeyPool(serperKeys, key => searchSerper(query, key, searchType, country))
    if (attempt.ok) {
      if (attempt.value.length > 0) return { items: attempt.value, channel: 'serper' }
    } else if (attempt.statuses.length > 0) {
      const statusText = attempt.statuses.map(status => status || 'network').join(',')
      errors.push(`Serper HTTP ${statusText}`)
      try {
        appendFileSync('api_log.txt', `[${new Date().toISOString()}] Serper搜索查询失败 q="${query}" status=${statusText}\n`)
      } catch (_e) {}
    }
  }

  // 婵炴潙鍚嬮敋闁告ɑ绋撻惀?: Brave
  if (braveKey) {
    try {
      const items = await searchBrave(query, braveKey, country)
      if (items.length > 0) return { items, channel: 'brave' }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(msg)
      try {
        appendFileSync('api_log.txt', `[${new Date().toISOString()}] Brave搜索查询失败 q="${query}" error=${msg}\n`)
      } catch (_e) {}
    }
  }

  return { items: [], channel: 'none', errors }
}

interface SearchResult {
  total: number
  matched: number
  pending: number
  failed: number
  errors: string[]
  channel: string
  results: Array<SearchItem & { tag: string; reason: string; score: number }>
  product: string
}

async function handleSearch(
  product: string,
  customQueries?: string[],
  excludeUrls?: string[],
  channel: string = 'serper',
  searchType: string = 'web',
  country: string = 'US',
): Promise<SearchResult> {
  // GLEIF and Wikidata special handling (no API key needed, direct fetch)
  if (channel === 'gleif') {
    const query = customQueries?.[0] || product
    const items = await searchGleif(query)
    const results = items.map(item => ({
      ...item,
      url: item.link,
      tag: 'relevant',
      reason: 'GLEIF legal entity',
      score: 15,
    }))
    return {
      total: results.length,
      matched: results.length,
      pending: 0,
      failed: 0,
      errors: [],
      channel: 'gleif',
      results,
      product,
    }
  }

  if (channel === 'wikidata') {
    const query = customQueries?.[0] || product
    const items = await searchWikidata(query)
    const results = items.map(item => ({
      ...item,
      url: item.link,
      tag: 'relevant',
      reason: 'Wikidata entity',
      score: 15,
    }))
    return {
      total: results.length,
      matched: results.length,
      pending: 0,
      failed: 0,
      errors: [],
      channel: 'wikidata',
      results,
      product,
    }
  }

  try {
    appendFileSync(
      join(__dirname, '..', 'api_log.txt'),
      `[${new Date().toISOString()}] START product="${product}" channel=${channel} queries=${JSON.stringify(customQueries)}\n`,
    )
  } catch { /* 日志失败不阻碍搜索 */ }

  const queries = customQueries?.length
    ? customQueries.map((q) => ({ q }))
    : [{ q: product }]

  const seen = new Set<string>()
  const excludeHosts = new Set(
    (excludeUrls || [])
      .map((u) => {
        try {
          return new URL(u).hostname.replace(/^www\./, '')
        } catch {
          return ''
        }
      })
      .filter(Boolean),
  )

  const allResults: SearchResult['results'] = []
  const errors: string[] = []
  let failed = 0
  let usedChannel = channel

  for (const { q } of queries) {
    try {
      // 婵炶揪缍€濞夋洟寮妶澶嬧挃鐎广儱娲悰鎾绘⒑椤愶絾顫楃紒棰濆亰閺佸秴鈻庣徊鐟倀Serp 闂?Serper 闂?Brave
      const { items, channel: foundChannel, errors: providerErrors } = await searchWithFallback(q, searchType, country)
      if (foundChannel !== 'none') usedChannel = foundChannel
      if (providerErrors?.length) {
        failed++
        errors.push(...providerErrors)
      }

      for (const item of items) {
        const url = item.link.replace(/\/$/, '')
        if (seen.has(url)) continue
        seen.add(url)
        try {
          if (excludeHosts.has(new URL(item.link).hostname.replace(/^www\./, ''))) continue
        } catch (_e) {}
        const { tag, reason } = quickTag(product, item.title, item.snippet)
        allResults.push({
          ...item,
          url: item.link,
          tag,
          reason,
          score: getSearchResultScore(tag),
        })
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      try {
        appendFileSync(
          'api_log.txt',
          `[${new Date().toISOString()}] log_search_fail q="${q}" channel=${channel} error=${msg}\n`,
        )
      } catch (_e) { /* ignore */ }
    }
  }

  const { matched, pending } = summarizeSearchTags(allResults.map((result) => result.tag))

  try {
    appendFileSync(
      'api_log.txt',
      `[${new Date().toISOString()}] RECEIVED product="${product}" queries=${JSON.stringify(customQueries)} channel=${usedChannel}\n`,
    )
  } catch (_e) {}

  return {
    total: allResults.length,
    matched,
    pending,
    failed,
    errors: Array.from(new Set(errors)).slice(0, 5),
    results: allResults,
    product,
    channel: usedChannel,
  }
}

// ---- LLM 闂佺厧鍟块惌渚€鎯冮悢鍏兼櫖闁革附娼塭pSeek 闂佺绻掗崢褔顢?API闂?----
const BACKCHECK_PROMPT = `Extract company facts from the supplied website content. Use only facts present in the content; do not invent missing facts.

Return these exact JSON fields:
1. companyName
2. mainProducts -- specific products explicitly shown. Do not infer products; return [] when unknown.
3. targetCustomers -- the customers served by this company, not the identity of this company.
4. employeeCount -- evidence text or unknown; do not estimate.
5. revenue -- evidence text or unknown; do not estimate.
6. yearFounded -- explicit year or unknown.
7. linkedinUrl
8. summary -- factual company description.
9. decisionMakers -- only people and titles explicitly shown.
10. markets
11. country
12. industry
13. location
14. language -- language used by the website.
15. importCommercialValue -- exactly high/medium/low/none, based on likely purchase scale and practical cooperation value.
16. importCommercialValueReason
17. businessMatch -- exactly high/medium/low/none. High/medium includes direct operators, furniture channels and project/specification companies. A manufacturer may still be a complementary OEM or channel partner; do not reject it solely for being a manufacturer. None is reserved for verified unrelated entities, directories, publishers, job pages or other non-customer records.
18. entityRole -- exactly one of channel_buyer/operator_buyer/project_specifier/manufacturer_partner/non_buyer/unknown.
19. relationshipPotential -- exactly one of channel_partner/direct_buyer/project_partner/complementary_oem/not_target/needs_research.
20. customerType -- a concise controlled subtype such as distributor, wholesaler, retailer, hotel_group, restaurant_group, hospitality_fitout_contractor, interior_design_firm, furniture_manufacturer, market_research_publisher, or unknown.
21. evidenceConfidence -- exactly verified/probable/weak.
22. evidenceUrls -- source URLs present in the supplied content.
23. evidenceGaps -- facts still missing or ambiguous.

Identity rules:
- Classify what the company itself does separately from who its customers are.
- Do not confuse a webpage title, article, directory or target-customer list with the company identity.
- Do not treat certification terms such as FSC, BIFMA, ISO or LEED as exclusion signals.
- Do not treat manufacturer/supplier as automatically non-buyer; assess OEM, private-label, overflow-production and complementary-category potential.
- If evidence is insufficient, use unknown/needs_research/weak instead of guessing.

Return only valid JSON with the exact field names above.`

async function llmChat(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: { role: string; content: string }[],
  timeout: number,
): Promise<Record<string, unknown>> {
  const payload = {
    model,
    messages,
    temperature: 0,
    response_format: { type: 'json_object' as const },
  }

  const isLoopback = /^(127\.0\.0\.1|localhost|::1)$/i.test(new URL(baseUrl).hostname)
  const resp = await fetchWithRetry(
    `${baseUrl}/chat/completions`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      timeout,
      ...(isLoopback ? { dispatcher: directDispatcher } : {}),
    },
    3,
  )

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`LLM API error: ${resp.status}: ${errText}`)
  }

  const data = (await resp.json()) as {
    choices?: { message?: { content?: string } }[]
  }
  let content = data.choices?.[0]?.message?.content || '{}'

  if (content.startsWith('```')) {
    content = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  }

  return JSON.parse(content) as Record<string, unknown>
}

async function llmExtract(text: string, prompt: string, timeout = 120000): Promise<Record<string, unknown>> {
  const messages = [
    {
      role: 'system' as const,
      content:
        'You are a data extraction assistant. Extract the requested information from the provided web content and return ONLY valid JSON, no markdown, no explanation.',
    },
    {
      role: 'user' as const,
      content: `${prompt}\n\nContent:\n${text.slice(0, 80000)}`,
    },
  ]

  try {
    if (!getLlmBaseUrl() || !getLlmApiKey() || !getLlmModel()) throw new Error('LLM_NOT_CONFIGURED')
    return await llmChat(getLlmBaseUrl(), getLlmApiKey(), getLlmModel(), messages, timeout)
  } catch (primaryErr: unknown) {
    const primaryMsg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr)
    const backupKey = getLlmBackupApiKey()
    if (!backupKey) throw primaryErr
    console.log(`[llm] primary failed -> backup (primary reason: ${primaryMsg})`)
    return llmChat(getLlmBackupBaseUrl(), backupKey, getLlmBackupModel(), messages, timeout)
  }
}

/** 开发信草稿英译中（人工审核用）。复用 llmChat 双通道，密钥只在服务端。 */
async function llmTranslateDraft(subject: string, body: string): Promise<{ subjectCn: string; bodyCn: string }> {
  const messages = [
    {
      role: 'system' as const,
      content:
        'You are a professional business email translator for a furniture export company. Translate English cold emails into natural, fluent Simplified Chinese. Preserve company names, personal names, email addresses, product terms, and URLs exactly as-is. Return ONLY valid JSON, no markdown.',
    },
    {
      role: 'user' as const,
      content: `Translate the following cold email into Simplified Chinese. Return ONLY valid JSON: {"subjectCn":"...", "bodyCn":"..."}.\n\nSubject:\n${subject.slice(0, 500)}\n\nBody:\n${body.slice(0, 20000)}`,
    },
  ]
  let result: Record<string, unknown>
  try {
    result = await llmChat(getLlmBaseUrl(), getLlmApiKey(), getLlmModel(), messages, 60000)
  } catch (primaryErr: unknown) {
    const primaryMsg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr)
    const backupKey = getLlmBackupApiKey()
    if (!backupKey) throw primaryErr
    console.log(`[llm] translate primary failed -> backup (reason: ${primaryMsg})`)
    result = await llmChat(getLlmBackupBaseUrl(), backupKey, getLlmBackupModel(), messages, 60000)
  }
  const subjectCn = String(result.subjectCn || '').trim()
  const bodyCn = String(result.bodyCn || '').trim()
  if (!subjectCn || !bodyCn) throw new Error('LLM_TRANSLATION_EMPTY')
  return { subjectCn, bodyCn: normalizeEmailSignature(bodyCn, 'cn') }
}

async function handleLlamaBackcheck(
  url: string,
  snippet?: string,
  title?: string,
  company?: string,
  country?: string,
  businessLine?: string,
): Promise<{ success: boolean; data?: { json: Record<string, unknown> }; error?: string }> {
  try {
    const inputText = [
      title ? `Title: ${title}` : '',
      snippet ? `Snippet: ${snippet}` : '',
      `URL: ${url}`,
    ]
      .filter(Boolean)
      .join('\n')

    if (!inputText.trim()) {
      return { success: false, error: 'No content available for analysis' }
    }
    const extracted = await llmExtract(inputText, BACKCHECK_PROMPT)
    return { success: true, data: { json: extracted } }
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ---- Firecrawl ----
const FIRECRAWL_SCRAPE_URL = 'http://localhost:3002/v2/scrape'

async function scrapePage(url: string): Promise<string> {
  const resp = await fetchWithRetry(
    FIRECRAWL_SCRAPE_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, formats: ['markdown'] }),
    },
    2,
  )

  if (!resp.ok) {
    const errText = await resp.text().catch(() => 'scrape failed')
    throw new Error(`Firecrawl scrape failed: ${errText}`)
  }

  const data = await resp.json() as { data?: { markdown?: string } }
  return data.data?.markdown || ''
}

async function handleFirecrawlExtract(
  url: string,
  prompt: string,
): Promise<{ success: boolean; data?: { json: Record<string, unknown> }; error?: string }> {
  try {
    const markdown = await scrapePage(url)
    if (!markdown) return { success: false, error: 'firecrawl scrape returned empty markdown' }
    const extracted = await llmExtract(markdown, prompt)
    return { success: true, data: { json: extracted } }
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ---- 轻量爬虫 (fetch + cheerio) ----
async function handleLightweightCrawl(
  url: string,
  timeout = 30000,
): Promise<{
  success: boolean
  markdown?: string
  title?: string
  wordCount?: number
  error?: string
}> {
  try {
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url
    }

    const resp = await fetchWithRetry(url, { timeout }, 2)
    if (resp.status >= 400) {
      return { success: false, error: `HTTP ${resp.status}` }
    }

    const html = await resp.text()
    const $ = cheerio.load(html)

    // 去掉干扰标签
    $('script, style, nav, footer, header, noscript, iframe, svg, form, button').remove()

    const title = $('title').first().text().trim()
    const metaDesc = $('meta[name="description"]').attr('content') || ''

    const texts: string[] = []
    $('h1, h2, h3, h4, h5, h6, p, li').each((_, el) => {
      const text = $(el).text().trim()
      if (text && text.length > 5) {
        const tag = el.tagName
        const prefix = tag.startsWith('h') ? '#'.repeat(parseInt(tag[1])) + ' ' : ''
        texts.push(prefix + text)
      }
    })

    let pageText = texts.slice(0, 300).join('\n\n')
    if (!pageText) {
      pageText = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 5000)
    }

    let markdown = ''
    if (title) markdown += `# ${title}\n\n`
    if (metaDesc) markdown += `${metaDesc}\n\n`
    markdown += pageText

    if (markdown.length < 50) {
      return { success: false, error: `内容过短(${markdown.length} chars)` }
    }

    return {
      success: true,
      markdown: markdown.slice(0, 50000),
      title,
      wordCount: markdown.length,
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message.slice(0, 200) : String(err)
    return { success: false, error: msg }
  }
}

// ---- LLM ----
async function handleLlmClassify(params: {
  company?: string
  website?: string
  snippet?: string
  summary?: string
  products?: string[]
  markets?: string[]
}): Promise<{ clientType: string; reason: string }> {
  const { company, website, snippet, summary, products, markets } = params

  const content = [
    company ? `Website: ${website}` : '',
    snippet ? `Snippet: ${snippet}` : '',
    summary ? `Summary: ${summary}` : '',
    products?.length ? `Products: ${products.join(', ')}` : '',
    markets?.length ? `Markets: ${markets.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n')

  if (!content.trim()) {
    return { clientType: 'unknown', reason: 'No data provided' }
  }

  const prompt = `Classify this company into one of these types: distributor, wholesaler, retailer, manufacturer, ecommerce, trader, restaurant, hotel, importer, supplier, unknown.

Company: ${company || 'N/A'}
Website: ${website || 'N/A'}
Summary: ${summary || 'N/A'}
Products: ${products?.join(', ') || 'N/A'}
Markets: ${markets?.join(', ') || 'N/A'}

Return JSON: {"clientType": "...", "reason": "..."}`

  const result = await llmExtract(content, prompt, 30000)

  return {
    clientType: (result.clientType as string) || 'unknown',
    reason: (result.reason as string) || '',
  }
}

async function handleTranslate(text: string, targetLang: string): Promise<string> {
  const sourceLang = targetLang === 'zh-CN' ? 'en' : 'zh-CN'
  if (targetLang === sourceLang) return text
  const TRANSLATE_API = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl='

  try {
    const resp = await fetch(TRANSLATE_API + targetLang + '&dt=t&q=' + encodeURIComponent(text.slice(0, 5000)))
    const data = await resp.json()
    return (data[0] || []).map((seg: any[]) => seg[0]).filter(Boolean).join('')
  } catch { return text }
}

interface BusinessProfile {
  id: string
  name: string
  keywords: string[]
  buyerTypes: string[]
  excludeTypes: string[]
  emailBlacklist: string[]
  minScore: number
}

const DEFAULT_PROFILES: BusinessProfile[] = [
  {
    id: 'furniture', name: 'Commercial furniture',
    keywords: ['commercial furniture', 'restaurant furniture', 'hotel furniture', 'office furniture', 'furniture wholesaler', 'furniture distributor', 'restaurant booth seating', 'restaurant furniture importer', 'hospitality furniture supplier', 'commercial furniture distributor'],
    buyerTypes: ['distributor', 'wholesaler', 'retailer', 'restaurant', 'hotel', 'contractor'],
    excludeTypes: ['manufacturer', 'factory', 'oem'],
    emailBlacklist: ['info', 'sales', 'contact', 'admin', 'support', 'mail', 'hello', 'team', 'office', 'enquiry', 'order'],
    minScore: 55,
  },
  {
    id: 'clothing', name: 'Clothing',
    keywords: ['clothing wholesaler', 'apparel distributor', 'fashion retailer', 'garment importer', 'textile buyer'],
    buyerTypes: ['distributor', 'wholesaler', 'retailer', 'boutique', 'chain'],
    excludeTypes: ['manufacturer', 'factory', 'oem'],
    emailBlacklist: ['info', 'sales', 'contact', 'admin', 'support', 'mail', 'hello', 'team'],
    minScore: 55,
  },
  {
    id: 'toys', name: 'Toys',
    keywords: ['toy wholesaler', 'toy distributor', 'toy retailer', 'children products importer', 'game store'],
    buyerTypes: ['distributor', 'wholesaler', 'retailer', 'chain'],
    excludeTypes: ['manufacturer', 'factory'],
    emailBlacklist: ['info', 'sales', 'contact', 'admin', 'support', 'mail', 'hello', 'team'],
    minScore: 55,
  },
  {
    id: 'electronics', name: 'Electronics',
    keywords: ['electronics wholesaler', 'consumer electronics distributor', 'gadget retailer', 'tech importer'],
    buyerTypes: ['distributor', 'wholesaler', 'retailer', 'chain'],
    excludeTypes: ['manufacturer', 'factory', 'oem'],
    emailBlacklist: ['info', 'sales', 'contact', 'admin', 'support', 'mail', 'hello', 'team'],
    minScore: 55,
  },
  {
    id: 'homegoods', name: 'Home goods',
    keywords: ['home goods wholesaler', 'kitchenware distributor', 'bathroom supplier', 'home decor retailer'],
    buyerTypes: ['distributor', 'wholesaler', 'retailer', 'chain'],
    excludeTypes: ['manufacturer', 'factory'],
    emailBlacklist: ['info', 'sales', 'contact', 'admin', 'support', 'mail', 'hello', 'team'],
    minScore: 55,
  },
  {
    id: 'food', name: 'Food and beverage',
    keywords: ['food distributor', 'beverage wholesaler', 'restaurant supplier', 'catering company', 'hotel supplier'],
    buyerTypes: ['distributor', 'wholesaler', 'restaurant', 'hotel', 'catering', 'chain'],
    excludeTypes: ['manufacturer', 'farm'],
    emailBlacklist: ['info', 'sales', 'contact', 'admin', 'support', 'mail', 'hello', 'team'],
    minScore: 55,
  },
  {
    id: 'auto', name: 'Automotive',
    keywords: ['auto parts wholesaler', 'automotive distributor', 'car parts retailer', 'vehicle闂備焦婢樼粔鍐测枎?importer'],
    buyerTypes: ['distributor', 'wholesaler', 'retailer', 'workshop'],
    excludeTypes: ['manufacturer', 'factory', 'oem'],
    emailBlacklist: ['info', 'sales', 'contact', 'admin', 'support', 'mail', 'hello', 'team'],
    minScore: 55,
  },
  {
    id: 'general', name: 'General B2B',
    keywords: ['wholesaler', 'distributor', 'importer', 'retailer'],
    buyerTypes: ['distributor', 'wholesaler', 'retailer', 'importer'],
    excludeTypes: ['manufacturer', 'factory'],
    emailBlacklist: ['info', 'sales', 'contact', 'admin', 'support', 'mail', 'hello', 'team'],
    minScore: 50,
  },
]

const PROFILES_FILE = join(__dirname, '..', 'business_profiles.json')

let profilesCache: BusinessProfile[] | null = null
let profilesCacheMtime = 0
function loadProfiles(): BusinessProfile[] {
  // normalizeItem×2453 每次都调 loadProfiles（disk read）；配置文件几乎不变，按 mtime 缓存避免冷读重复读盘。
  try {
    if (existsSync(PROFILES_FILE)) {
      const mtime = statSync(PROFILES_FILE).mtimeMs
      if (profilesCache && profilesCacheMtime === mtime) return profilesCache
      const custom = JSON.parse(readFileSync(PROFILES_FILE, 'utf-8'))
      if (Array.isArray(custom) && custom.length > 0) {
        profilesCache = [...DEFAULT_PROFILES, ...custom]
        profilesCacheMtime = mtime
        return profilesCache
      }
    }
  } catch (_e) {}
  return [...DEFAULT_PROFILES]
}

function saveProfiles(profiles: BusinessProfile[]): void {
  const custom = profiles.filter(p => !DEFAULT_PROFILES.find(d => d.id === p.id))
  writeFileSync(PROFILES_FILE, JSON.stringify(custom, null, 2), 'utf-8')
}

function scoreLead(item: any, profile: BusinessProfile, tag: string, backSummary: string): number {
  let score = 0
  const website = (item.website || '').toLowerCase()
  const email = (item.email || '')
  const legacyTagText = Array.isArray(item.legacyTags) ? item.legacyTags.join(' ') : ''
  const text = ((item.company || '') + ' ' + (item.title || '') + ' ' + (item.industry || '') + ' ' + (item.tag || legacyTagText) + ' ' + backSummary).toLowerCase()
  const industryKW = ['furniture', 'commercial furniture', 'restaurant furniture', 'chair', 'table', 'booth', 'sofa', 'auto', 'car seat', 'seat cover', 'restaurant seating', 'hospitality furniture', 'contract furniture', 'commercial dining furniture']
  const matchedIndustry = profile.keywords.some(kw => text.includes(kw.toLowerCase())) || industryKW.some(kw => text.includes(kw))
  const generalMatch = ['wholesal', 'distributor', 'retail', 'import', 'dealer', 'supplier', 'buyer'].some(kw => text.includes(kw))
  const buyerTag = profile.buyerTypes.some(bt => tag.includes(bt) || text.includes(bt))
  const excludeTag = profile.excludeTypes.some(et => tag.includes(et) || text.includes(et))
  if (excludeTag) score -= 15
  if (buyerTag) score += 25
  else if (tag === 'buyer') score += 20
  else if (tag === 'supplier') score += 0
  const mainEmail = item.email || ''
  if (mainEmail && mainEmail.includes('@')) {
    const prefix = mainEmail.split('@')[0].toLowerCase()
    const isGenericEmail = profile.emailBlacklist.some(bl => prefix === bl || prefix.startsWith(bl + '.'))
    if (!isGenericEmail) score += 10
    else score += 3
  }

  // 4. Title/role quality (0-15)
  const title = (item.title || '').toLowerCase()
  const decisionMakerKW = ['owner', 'founder', 'ceo', 'director', 'manager', 'purchasing', 'procurement']
  if (decisionMakerKW.some(kw => title.includes(kw))) score += 15

  // 5. Data completeness (0-10)
  if (item.website) score += 3
  if (backSummary) score += 3
  if (item.phone) score += 2
  if (item.country) score += 2

  return Math.max(0, Math.min(100, score))
}

// ---- HTTP Router ----
const ITEMS_FILE = join(__dirname, '..', 'items_store.json')
const BACKUP_FILE = join(__dirname, '..', 'items_store_backup.json')
const LEGACY_LEADS_FILE = join(__dirname, '..', 'data', 'leads.json')
const SNAPSHOT_DIR = join(__dirname, '..', 'data', 'snapshots')
const WEBHOOK_SYNC_PATHS = {
  stateFile: join(__dirname, '..', 'data', 'webhook-sync-state.json'),
  unmatchedFile: join(__dirname, '..', 'data', 'unmatched_webhook_events.json'),
  reportFile: join(__dirname, '..', 'data', 'webhook-sync-report.json'),
}
const ZOHO_SYNC_PATHS = {
  stateFile: join(__dirname, '..', 'data', 'zoho-imap-sync-state.json'),
  unmatchedFile: join(__dirname, '..', 'data', 'unmatched_replies.json'),
  reportFile: join(__dirname, '..', 'data', 'zoho-imap-sync-report.json'),
}
const imapConfigured = () => Boolean(userConfig.zohoEmail && userConfig.zohoPassword && typeof userConfig.imapHost === 'string' && userConfig.imapHost.trim() && userConfig.imapSecure !== false)

function readJsonObject<T>(filePath: string, fallback: T): T {
  try {
    if (!existsSync(filePath)) return fallback
    const value = JSON.parse(readFileSync(filePath, 'utf-8'))
    return value && typeof value === 'object' ? value as T : fallback
  } catch {
    return fallback
  }
}

function writeJsonObject(filePath: string, value: unknown): void {
  writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8')
}

function zohoSyncStatus() {
  if (!imapConfigured() || userConfig.allowImapRecovery !== true) {
    return {
      configured: imapConfigured(),
      status: 'not_configured',
      reason: 'Configure a TLS IMAP server and enable inbox recovery.',
      replyCheckMode: 'manual_zoho_login',
      lastZohoSyncAt: null,
      lastStats: {},
      lastError: null,
      unmatchedCount: readJsonArray(ZOHO_SYNC_PATHS.unmatchedFile).length,
    }
  }
  const state = readJsonObject<any>(ZOHO_SYNC_PATHS.stateFile, { processedMessageIds: [], status: 'idle' })
  const unmatched = readJsonArray(ZOHO_SYNC_PATHS.unmatchedFile)
  return {
    configured: Boolean(userConfig.zohoEmail && userConfig.zohoPassword),
    status: state.status || 'idle',
    lastZohoSyncAt: state.lastZohoSyncAt,
    lastStats: state.lastStats || {},
    lastError: state.lastError || null,
    unmatchedCount: unmatched.length,
  }
}

function readJsonArray(filePath: string): any[] {
  try {
    if (!existsSync(filePath)) return []
    const data = JSON.parse(readFileSync(filePath, 'utf-8'))
    return Array.isArray(data) ? data : []
  } catch { return [] }
}

// ---- Zoho inbox sync (shared by manual /api/zoho-replies/sync and background scheduler; inbox/bounce/reply only, no SMTP send) ----
async function syncZohoInboxOnce(limit = 50): Promise<{ state: any; stats: any; unmatchedCount: number }> {
  if (!imapConfigured() || userConfig.allowImapRecovery !== true) throw new Error('IMAP_NOT_CONFIGURED')
  const port = Number(userConfig.imapPort || 993)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('IMAP_PORT_INVALID')
  const priorState = readJsonObject<ZohoSyncState>(ZOHO_SYNC_PATHS.stateFile, { processedMessageIds: [] })
  const requestedLimit = Number(limit || 50)
  const lmt = Math.min(50, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 50))
  const defaultSince = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  const incrementalSince = priorState.lastZohoSyncAt ? new Date(priorState.lastZohoSyncAt) : defaultSince
  const since = Number.isFinite(incrementalSince.getTime()) && incrementalSince > defaultSince ? incrementalSince : defaultSince
  const startedAt = new Date().toISOString()
  const messages = await fetchZohoMessagesReadOnly({
    host: userConfig.imapHost!.trim(),
    port,
    secure: true,
    user: userConfig.zohoEmail,
    pass: userConfig.zohoPassword,
  }, { since, limit: lmt })
  const queueSnapshot = readFormalSendQueue()
  let result: ReturnType<typeof applyZohoMessages>
  updateItemsAtomic(latest => {
    result = applyZohoMessages(latest, messages, {
      processedMessageIds: priorState.processedMessageIds || [],
      now: new Date().toISOString(),
      formalQueueRecords: structuredClone(queueSnapshot.records),
      source: 'zoho_imap_readonly',
    })
    return result.items
  }, ITEMS_STORE_FILE, new Date(), { refreshOnlyMutated: true })
  const changedRecords = new Map((result!.formalQueueRecords || []).map((record: any) => [record.id, record]))
  await mutateFormalSendQueue(current => {
    current.records = current.records.map((record: any) => changedRecords.get(record.id) || record)
    return current
  })
  const previousUnmatched = readJsonArray(ZOHO_SYNC_PATHS.unmatchedFile)
  const unmatchedById = new Map(previousUnmatched.map((entry: any) => [entry.messageId || `uid:${entry.uid}`, entry]))
  result.unmatched.forEach((entry: any) => unmatchedById.set(entry.messageId || `uid:${entry.uid}`, entry))
  writeJsonObject(ZOHO_SYNC_PATHS.unmatchedFile, Array.from(unmatchedById.values()).slice(-1000))
  const state = {
    lastZohoSyncAt: new Date().toISOString(),
    processedMessageIds: result.processedMessageIds,
    status: 'normal',
    lastStats: result.stats,
    lastError: null,
  }
  writeJsonObject(ZOHO_SYNC_PATHS.stateFile, state)
  writeJsonObject(ZOHO_SYNC_PATHS.reportFile, { startedAt, completedAt: state.lastZohoSyncAt, stats: result.stats })
  return { state, stats: result.stats, unmatchedCount: unmatchedById.size }
}

// ---- One-time initial isolation registration: current primaryStage=true_excluded -> company/domain, permanent ----
function registerExcludedInitial() {
  try {
    const isoStore = readIsolationStore()
    if (isoStore.initialExcludedRegisteredAt) return { registered: 0, alreadyRegistered: true }
    const items = loadMainItems()
    const now = new Date().toISOString()
    const entries: any[] = []
    for (const item of items) {
      if (String(item.primaryStage || '') !== 'true_excluded') continue
      const company = String(item.company || item.title || '').trim()
      if (company) entries.push({ objectType: 'company', objectValue: company, reason: '已排除', sourceStage: 'true_excluded', isolatedAt: now, originalCustomerId: String(item.id || ''), permanent: true })
      const domain = String(item.canonicalDomain || item.website || item.domain || '').trim()
        .replace(/^https?:\/\//i, '').split('/')[0].split('?')[0].replace(/^www\./i, '').toLowerCase()
      if (domain) entries.push({ objectType: 'domain', objectValue: domain, reason: '已排除', sourceStage: 'true_excluded', isolatedAt: now, originalCustomerId: String(item.id || ''), permanent: true })
    }
    const registered = addIsolationBatch(entries)
    setInitialExcludedRegisteredAt(now)
    return { registered, alreadyRegistered: false }
  } catch (error: any) {
    return { registered: 0, error: String(error?.message || error) }
  }
}

// ---- Unified background scheduler (test mail auto-send + Zoho inbox auto-sync) ----
const BACKGROUND_TICK_MS = 60_000
const ZOHO_SYNC_INTERVAL_MS = 600_000
// 正式开发信回信/退信回收（sales@ Zoho Mail REST API）间隔：15 分钟一轮，避免高频打 Zoho API（consumer 内置 120ms/封限速）。
const FORMAL_REPLY_SYNC_INTERVAL_MS = 900_000
const FORMAL_REPLY_MAX_PER_TICK = 10
let backgroundInFlight = false
let backgroundStartedAt: string | null = null
let lastTickAt: string | null = null
let lastTickStats: any = null
let lastTickFatalError: string | null = null
let testMailLastRunAt: string | null = null
let testMailLastRunStats: any = null
let testMailLastError: string | null = null
let testMailNextSendAt = 0
let zohoSyncRunning = false
let zohoSyncLastAt: string | null = null
let zohoSyncedCount = 0
let zohoLastError: string | null = null
// 正式开发信回收（REST）状态
let formalReplyRunning = false
let formalReplyLastAt: string | null = null
let formalReplyLastStats: any = null
let formalReplyLastError: string | null = null
let dashboardCacheAt = 0
let dashboardCacheBody: any = null
let dashboardRefreshPromise: Promise<void> | null = null
// P1-5 纯内务步进器状态
let housekeepingLastAt: string | null = null
let housekeepingLastStats: any = null
// 批次5 全流程自动循环调度状态
// PIPELINE_AUTO_ENABLED：读 env 或 user_config.json.pipelineAutoEnabled，默认 true（除正式发送外都应默认开启）。
// 正式发送由逐条资格、抑制名单、客户本地时段与发送额度控制，无全局发送开关。
const pipelineAutoEnabled = process.env.PIPELINE_AUTO_ENABLED !== 'false' && (userConfig as any).pipelineAutoEnabled !== false
const backgroundEnabled = process.env.MMUSEOPS_BACKGROUND_DISABLED !== 'true'
let pipelineLastAt: string | null = null
let pipelineLastStats: any = null

function generateBackcheckEvidenceGaps(item: any): { evidenceGaps: string[]; recommendedAction: string } {
  const businessMatch = String(item.businessMatch || '').trim().toLowerCase()
  const commercialValue = String(item.importCommercialValue || '').trim().toLowerCase()
  const country = String(item.country || '').trim()
  const website = String(item.website || '').trim()
  const summary = String(item.evidenceSummary || item.researchSummary || item.backcheckReason || '').trim()
  const mainProducts = Array.isArray(item.mainProducts) ? item.mainProducts : []
  const customerType = String(item.customerType || item.customerTypeAssessment || item.clientType || '').trim()
  const gaps: string[] = []
  if (!businessMatch || !['high', 'medium', 'low', 'none'].includes(businessMatch)) gaps.push('业务匹配未知')
  if (!commercialValue || !['high', 'medium', 'low', 'none'].includes(commercialValue)) gaps.push('商业价值未知')
  if (!country || country === 'unknown') gaps.push('国家未知')
  if (!website) gaps.push('缺少官网')
  if (summary.length < 20) gaps.push('背调摘要不足')
  if (mainProducts.length === 0) gaps.push('产品未知')
  if (!customerType || customerType === 'unknown') gaps.push('客户类型未知')
  if (gaps.length === 0) gaps.push('待人工确认')
  const recommendedAction = ['high', 'medium'].includes(businessMatch) ? 'contact_mining' : 'manual_review'
  return { evidenceGaps: gaps, recommendedAction }
}

async function runHousekeepingStepper(now = new Date()): Promise<any> {
  const stats: any = { observationAdvanced: 0, dnsMxChecked: 0, backcheckGapsGenerated: 0, errors: 0 }
  // ---- 单次 updateItemsAtomic 合并三项内务（幂等，刷新只针对变化项）----
  try {
    updateItemsAtomic(items => items.map(item => {
      const stage = String(item.primaryStage || item.normalizedStage || '')

      // 1. observation 完成项刷阶段（T3 修复路径：updateItemsAtomic → applyEligibilityStage）
      if (stage === 'observation_queue') {
        const res = applyEligibilityStage(item, now, { formalSentEmails: getFormalSentEmailsCached(), testMailVerdicts: getTestMailVerdictsCached() })
        if (res.changed && String(res.item.primaryStage || '') !== 'observation_queue') stats.observationAdvanced++
        return res.changed ? res.item : item
      }

      // 3. backcheck 缺失 evidenceGaps/recommendedAction 生成（仍留人工审批，不改阶段章）
      if (stage === 'backcheck_queue') {
        const hasGaps = Array.isArray(item.evidenceGaps) && item.evidenceGaps.length > 0
        const hasAction = String(item.recommendedAction || '').trim().length > 0
        if (hasGaps && hasAction) return item
        const generated = generateBackcheckEvidenceGaps(item)
        item.evidenceGaps = hasGaps ? item.evidenceGaps : generated.evidenceGaps
        item.recommendedAction = hasAction ? item.recommendedAction : generated.recommendedAction
        stats.backcheckGapsGenerated++
        return item
      }

      return item
    }), ITEMS_STORE_FILE, now, { refreshOnlyMutated: true })
  } catch (error: any) {
    stats.errors++
    console.error(`[housekeeping] stepper update: ${String(error?.message || error)}`)
  }

  housekeepingLastAt = now.toISOString()
  housekeepingLastStats = stats
  return stats
}

async function backgroundTick() {
  if (backgroundInFlight) return
  backgroundInFlight = true
  const tickStats: any = { testMail: { attempted: false }, zoho: { attempted: false } }
  lastTickFatalError = null
  const tickStart = Date.now()
  console.error(`[tick] ${new Date().toISOString()} START`)
  try {
    let pipelineControl = readPipelineControl()
    const zohoImapBlocked = !imapConfigured() || userConfig.allowImapRecovery !== true
    if (zohoImapBlocked) {
      tickStats.zoho = { attempted: false, reason: 'blocked_by_plan_or_imap_recovery_disabled' }
    } else if (userConfig.zohoEmail && userConfig.zohoPassword) {
      const due = !zohoSyncLastAt || Date.now() - Date.parse(zohoSyncLastAt) >= ZOHO_SYNC_INTERVAL_MS
      if (due && !zohoSyncRunning) {
        zohoSyncRunning = true
        try {
          const out = await syncZohoInboxOnce(50)
          zohoSyncLastAt = new Date().toISOString()
          zohoSyncedCount = out.stats?.scanned ?? 0
          zohoLastError = null
          tickStats.zoho = { attempted: true, scanned: out.stats?.scanned ?? 0, replied: out.stats?.replied ?? 0, bounced: out.stats?.bounced ?? 0, unmatched: out.stats?.unmatched ?? 0 }
        } catch (error: any) {
          zohoLastError = String(error?.message || error).slice(0, 240)
          tickStats.zoho = { attempted: true, error: zohoLastError }
        } finally {
          zohoSyncRunning = false
        }
      } else {
        tickStats.zoho = { attempted: false, reason: due ? 'already_running' : 'not_due_yet' }
      }
    }
    // c. P1-5 纯内务步进器：不发邮件、不碰发送锁；观察期推进 / 内部 DNS-MX / backcheck evidenceGaps
    try {
      tickStats.housekeeping = await runHousekeepingStepper()
    } catch (error: any) {
      console.error(`[housekeeping] stepper error: ${String(error?.message || error)}`)
      tickStats.housekeeping = { error: String(error?.message || error) }
    }
    // c.5 人工池自动分流：机械阻断的待审草稿自动退回对应队列，不要求人工点"驳回"（主公 2026-08-21）。
    try {
      tickStats.draftAutoroute = await autorouteMechanicallyBlockedDrafts(new Date())
    } catch (error: any) {
      console.error(`[draft-autoroute] error: ${String(error?.message || error)}`)
      tickStats.draftAutoroute = { error: String(error?.message || error) }
    }
    // d. 批次5 全流程自动循环（统一挂载）：背调→挖联系人→草稿→跟进→正式发送→数据不足补搜索。
    //    PIPELINE_AUTO_ENABLED 控制后台流水线启停；正式发送本身按逐条规则处理。
    if (pipelineAutoEnabled && pipelineControl.running) {
      const pipeStart = Date.now()
      try {
        const pipelineNow = new Date()
        const pipelineOut = await runPipelineStepper(pipelineNow, {
          projectId: pipelineControl.projectId,
          runBatchId: pipelineControl.runBatchId,
          requireSupervisedDraft: userConfig.formalSupervisedOnly === true,
          qualityGateEnabled: userConfig.formalQualityGateEnabled !== false,
          contactMiningEnabled: userConfig.contactMiningEnabled !== false,
          maxDailySend: Math.min(100, Math.max(0, Number(userConfig.formalDailyLimit ?? 100) || 0)),
            respectCustomerLocalWindow: false,
          ledger: runtimeLedger,
        })
        pipelineLastAt = pipelineNow.toISOString()
        pipelineLastStats = pipelineOut
        tickStats.pipeline = pipelineOut
      } catch (error: any) {
        console.error(`[pipeline] stepper error: ${String(error?.message || error)}`)
        tickStats.pipeline = { error: String(error?.message || error) }
      }
      console.error(`[tick-pipeline] ${new Date().toISOString()} ${Date.now() - pipeStart}ms`)
    } else {
      tickStats.pipeline = { disabled: true, reason: pipelineControl.running ? 'config_disabled' : 'pipeline_stopped' }
      // Formal sends are their own queue and must not depend on lead-pipeline running.
      // Legacy global toggles do not gate this independently reviewed queue.
      try {
        const formalNow = new Date()
        const formalStats = await runFormalAutoSchedulerTick(formalNow, {
          formalQualityGateEnabled: userConfig.formalQualityGateEnabled !== false,
          formalDailyLimit: userConfig.formalDailyLimit,
        })
        tickStats.formalAuto = { attempted: true, ...formalStats }
      } catch (error: any) {
        const message = String(error?.message || error).slice(0, 240)
        tickStats.formalAuto = { attempted: true, error: message }
        console.error(`[formal-auto] scheduler error: ${message}`)
      }
    }
  } catch (error: any) {
    lastTickFatalError = '后台整轮异常'
    console.error(`[background] tick error: ${String(error?.message || error)}`)
  } finally {
    lastTickAt = new Date().toISOString()
    lastTickStats = tickStats
    try {
      updateTrialMonitor({
        now: new Date(),
        config: userConfig,
        pipelineControl: readPipelineControl(),
        tickStats,
        workers: publicRuntimeWorkers(runtimeLedger.snapshot()),
        schedulerHealthy: !lastTickFatalError && !testMailLastError && !zohoLastError && !formalReplyLastError && !tickStats?.pipeline?.error,
        formalReplyStats: formalReplyLastStats,
        errors: {
          后台: lastTickFatalError,
          测试信: testMailLastError,
          回信回收: formalReplyLastError,
          流水线: tickStats?.pipeline?.lastError,
        },
      })
    } catch (error: any) {
      console.error(`[trial-monitor] ${String(error?.message || error).slice(0, 160)}`)
    }
    backgroundInFlight = false
    console.error(`[tick] ${new Date().toISOString()} END ${Date.now() - tickStart}ms housekeeping=${tickStats.housekeeping ? JSON.stringify(tickStats.housekeeping).slice(0, 200) : 'n/a'}`)
  }
}

function getBackgroundStatus() {
  const store = readTestMailQueue()
  const dashboard = testMailQueueDashboard(store)
  const pipelineControl = readPipelineControl()
  const errorState = (value: unknown) => value ? '异常，查看本地日志' : null
  return {
    pipelineControl,
    testMail: {
      todaySent: dashboard.sentToday,
      quota: store.config.dailyLimit,
      remaining: dashboard.remainingQuota,
      activeQueueLength: dashboard.activeQueueLength,
      watching: dashboard.watching,
      historyTotal: dashboard.historyTotal,
      paused: store.paused,
      lastRunAt: testMailLastRunAt,
      lastError: errorState(testMailLastError),
    },
    zoho: {
      configured: Boolean(userConfig.zohoEmail && userConfig.zohoPassword),
      blocked: !imapConfigured() || userConfig.allowImapRecovery !== true,
      running: zohoSyncRunning,
      lastSyncAt: zohoSyncLastAt,
      lastSyncedCount: zohoSyncedCount,
      lastError: errorState(zohoLastError),
    },
    formalReply: {
      running: formalReplyRunning,
      lastRunAt: formalReplyLastAt,
      lastStats: formalReplyLastStats ? {
        scanned: Number(formalReplyLastStats.scanned || 0),
        replied: Number(formalReplyLastStats.replied || 0),
        bounced: Number(formalReplyLastStats.bounced || 0),
        unmatched: Number(formalReplyLastStats.unmatched || 0),
      } : null,
      lastError: errorState(formalReplyLastError),
      intervalMs: FORMAL_REPLY_SYNC_INTERVAL_MS,
    },
    isolation: {
      todayAdded: todayIsolationCount(),
      total: isolationTotal(),
    },
    housekeeping: {
      lastRunAt: housekeepingLastAt,
      lastStats: housekeepingLastStats,
    },
    scheduler: {
      startedAt: backgroundStartedAt,
      lastTickAt: lastTickAt,
      backgroundEnabled,
      pipelineEnabled: pipelineAutoEnabled && pipelineControl.running,
      healthy: Boolean(lastTickAt && !lastTickFatalError && !testMailLastError && !zohoLastError && !formalReplyLastError && !(lastTickStats as any)?.pipeline?.error),
    },
    workers: publicRuntimeWorkers(runtimeLedger.snapshot()),
  }
}

function emailLogsOf(item: any): any[] {
  const logs = Array.isArray(item.emailLogs) ? item.emailLogs : Array.isArray(item.emailLog) ? item.emailLog : []
  return logs.map((log: any, index: number) => ({
    id: log.id || String(item.id || 'lead') + '-' + index + '-' + (log.sentAt || log.date || Date.now()),
    itemId: log.itemId || item.id || '',
    sentAt: log.sentAt || log.date || log.createdAt || new Date().toISOString(),
    subject: log.subject || '',
    body: log.body || log.content || '',
    status: log.status || log.result || 'sent',
    ...log,
  }))
}

function gradeFromScore(score: number): string {
  if (score >= 85) return 'S'
  if (score >= 70) return 'A'
  if (score >= 55) return 'B'
  if (score >= 35) return 'C'
  return 'D'
}

function scoreItem(item: any, profile: BusinessProfile): number {
  const title = (item.title || '').toLowerCase()
  const website = (item.website || '').toLowerCase()
  const email = (item.email || '').toLowerCase()
  const nonBuyerKw = /top \d|best \d|how to|what is|guide|article|blog|review|ranking|list of|q:|question|answer|forum|reddit|quora|linkedin\.com|facebook\.com|instagram\.com|twitter\.com|youtube\.com|pinterest|tiktok|ziprecruiter|indeed\.com|glassdoor|wikipedia|medium\.com|yellowpages|yellow pages|go4worldbusiness|alibaba\.com|made-in-china|globalsources|thomasnet|kompass|ezinearticles|hubpages/
  if (nonBuyerKw.test(title)) return 0
  if (/linkedin\.com\/(company|in)\//.test(website)) return 0
  if (/beispiel\.de|example\.com|test\.com|localhost/i.test(website)) return 0
  if (email.startsWith('u003e') || email.startsWith('%20') || email.includes('undefined')) return 0
  let score = 0

  // 1. Industry match (0-30)
  const backCheck = item.backCheck || item.backcheck || {}
  const backSummary = typeof backCheck === 'object' && backCheck !== null ? (backCheck.summary || '') : ''
  const legacyTags = Array.isArray(item.legacyTags) ? item.legacyTags.map((value: unknown) => String(value)) : []
  const legacyTag = legacyTags.find(value => /^(buyer|supplier)$/i.test(value)) || legacyTags.join(' ')
  const text = ((item.company || '') + ' ' + (item.title || '') + ' ' + (item.industry || '') + ' ' + (item.tag || legacyTag) + ' ' + backSummary).toLowerCase()
  const industryKW = ['furniture', 'commercial furniture', 'restaurant furniture', 'chair', 'table', 'booth', 'sofa', 'auto', 'car seat', 'seat cover', 'restaurant seating', 'hospitality furniture', 'contract furniture', 'commercial dining furniture']
  const matchedIndustry = profile.keywords.some(kw => text.includes(kw.toLowerCase())) || industryKW.some(kw => text.includes(kw))
  const generalMatch = ['wholesal', 'distributor', 'retail', 'import', 'dealer', 'supplier', 'buyer'].some(kw => text.includes(kw))
  if (matchedIndustry) score += 30
  else if (generalMatch) score += 15
  else if (text.includes(profile.id)) score += 20

  // 2. Buyer tag match (0-25)
  const tag = (item.tag || legacyTag).toLowerCase()
  const buyerTag = profile.buyerTypes.some(bt => tag.includes(bt) || text.includes(bt))
  const excludeTag = profile.excludeTypes.some(et => tag.includes(et) || text.includes(et))
  if (excludeTag) score -= 15
  if (buyerTag) score += 25
  else if (tag === 'buyer') score += 20
  else if (tag === 'supplier') score += 10

  // 3. Email quality (0-20)
  const contacts = Array.isArray(item.contacts) ? item.contacts : []
  const emails = contacts.map((c: any) => c.email || '').filter(Boolean)
  const mainEmail = item.email || emails[0] || ''
  if (mainEmail && mainEmail.includes('@')) {
    const prefix = mainEmail.split('@')[0].toLowerCase()
    const isBlacklist = profile.emailBlacklist.some(bl => prefix === bl || prefix.startsWith(bl + '.'))
    if (!isBlacklist && prefix.length > 2) score += 20
    else if (!isBlacklist) score += 12
    else score += 5
  }

  // 4. Decision maker signal (0-15)
  const hasDecisionMaker = contacts.some((c: any) => {
    const cTitle = (c.title || '').toLowerCase()
    return ['owner', 'founder', 'ceo', 'director', 'manager', 'purchasing', 'procurement'].some(kw => cTitle.includes(kw))
  })
  const hasContactName = contacts.some((c: any) => c.name && c.name.trim())
  if (hasDecisionMaker) score += 15
  else if (hasContactName) score += 10

  // 5. Data completeness (0-10)
  if (item.website) score += 3
  if (backSummary) score += 3
  if (item.phone) score += 2
  if (item.country) score += 2

  return Math.max(0, Math.min(100, score))
}

function productionScore(item: any): { grade: string; score: number; reasons: string[] } | null {
  const profileId = productionProfileId(item.businessLine)
  if (!profileId) return null
  const profile = loadProfiles().find(p => p.id === profileId)
  if (!profile) return null
  const score = scoreItem(item, profile)
  const logs = emailLogsOf(item)
  const hasEmail = String(item.email || item.contacts?.[0]?.email || '').includes('@')
  const hasBackcheck = Boolean(item.backCheck || item.backcheck || item.backcheckStatus === 'done')
  const verified = item.emailVerification === 'verified'
  const replied = logs.some((log: any) => log.status === 'replied' || log.result === 'replied')
  const bounced = item.emailBounced || logs.some((log: any) => log.status === 'bounced' || log.result === 'bounced')
  let grade = gradeFromScore(score)
  if (bounced || item.emailVerification === 'invalid' || item.status === 'archived') grade = 'D'
  if (grade === 'S' && !(hasEmail && verified && hasBackcheck)) grade = 'A'
  return { grade, score, reasons: [hasBackcheck ? 'Backcheck ready' : 'Backcheck needed', hasEmail ? 'Email exists' : 'Contact email needed', verified ? 'Email verified' : 'Verify before outreach', replied ? 'Customer replied' : 'No reply yet'] }
}

function normalizeItem(item: any): any {
  const now = new Date().toISOString()
  const backCheck = item.backCheck || item.backcheck
  const emailLogs = emailLogsOf(item)
  let developmentStatus = item.developmentStatus || (item.status === 'contacted' ? 'sent' : 'pending')
  let currentStageId = item.currentStageId || 'otr-found'
  let emailVerification = item.emailVerification || 'unknown'
  let emailBounced = Boolean(item.emailBounced)
  if (emailLogs.some((log: any) => log.status === 'replied' || log.result === 'replied')) { developmentStatus = 'replied'; currentStageId = 'otr-replied' }
  else if (emailLogs.some((log: any) => ['sent', 'opened', 'bounced'].includes(log.status || log.result))) { developmentStatus = 'sent'; if (['otr-found', 'otr-backcheck', 'otr-contact', 'otr-verify'].includes(currentStageId)) currentStageId = 'otr-first' }
  if (emailLogs.some((log: any) => log.status === 'bounced' || log.result === 'bounced')) { emailBounced = true; if (emailVerification === 'unknown') emailVerification = 'invalid' }
  const { backcheck: _backcheck, emailLog: _emailLog, ...cleanItem } = item
  const normalized = {
    ...cleanItem,
    title: item.title || item.company || item.website || item.email || 'Unnamed lead',
    company: item.company || item.title || '',
    contactName: item.contactName || item.contacts?.[0]?.name || '',
    email: item.email || item.contacts?.find((c: any) => c.email)?.email || '',
    phone: item.phone || item.contacts?.find((c: any) => c.phone)?.phone || '',
    pipelineId: item.pipelineId || 'outreach',
    currentStageId,
    status: item.status === 'archived' || item.status === 'completed' ? item.status : 'active',
    priority: item.priority || 'medium',
    source: item.source || 'manual',
    level: item.level || 'unknown',
    clientType: item.clientType || 'unknown',
    emailVerification,
    emailBounced,
    backCheck,
    backcheckStatus: backCheck ? 'done' : (item.backcheckStatus || 'pending'),
    developmentStatus,
    emailLogs,
    currency: item.currency || 'USD',
    businessLine: item.businessLine || '',
    timeline: Array.isArray(item.timeline) && item.timeline.length ? item.timeline : [{ stageId: currentStageId, enteredAt: item.createdAt || now }],
    notes: Array.isArray(item.notes) ? item.notes : [],
    attachments: Array.isArray(item.attachments) ? item.attachments : [],
    createdAt: item.createdAt || now,
    updatedAt: item.updatedAt || now,
  }
  const result = productionScore(normalized)
  if (!result) return { ...normalized, scoringStatus: 'unsupported_business_profile' }
  return { ...normalized, leadGrade: item.leadGrade || result.grade, leadScore: typeof item.leadScore === 'number' ? item.leadScore : result.score, leadScoreReasons: Array.isArray(item.leadScoreReasons) ? item.leadScoreReasons : result.reasons, leadScoreUpdatedAt: item.leadScoreUpdatedAt || now }
}

// mtime 失效内存缓存（复用 items-store-atomic readItems 的失效模式）：三个源文件 mtime 都没变
// 就返回上次解析+normalize 的结果，避免每次 /api/items、/api/stats、housekeeping 同步读盘 323MB +
// JSON.parse + normalizeItem×2453 + JSON.stringify 阻塞事件循环（实测单次 16.4s 首字节前）。
// 写盘路径（updateItemsAtomic/updateOneItemAtomic/auto_loop temp+rename）都会更新文件 mtime。
// 所有调用点均为只读（find/filter/iterate），不会原地污染缓存。
//
// 按需加载：文件变更后**绝不在请求路径里同步重读**（324MB 解析+normalize 阻塞事件循环秒级，
// 会卡住 summary/byId/所有请求）。改为 stale-while-revalidate：
//   1) loadMainItems() 命中上次已加载数组立即返回（毫秒级）；
//   2) 检测到 mtime 变化 → scheduleMainReload() 后台分片重建（normalize 每 50ms 让出事件循环），
//      完成后原子换入 loadMainCache.items/signature；
//   3) 换入后再触发 scheduleSummaryBuild() 后台流式重建摘要（逐条 stringify + 流式 gzip，不阻塞）。
// 重建期间请求继续吃上一次快照（SWR 语义），窗口内事件循环只在 readJsonArray 的 JSON.parse
// 阶段被占用（~1.3s/次，且被 4s 最小间隔节流合并，避免连续写盘造成背靠背重载）。
const loadMainCache: { signature: string; items: any[]; serialized: Buffer; serializedSignature: string } = { signature: '', items: [], serialized: Buffer.alloc(0), serializedSignature: '' }
function mtimeMsOf(filePath: string): number {
  try { return statSync(filePath).mtimeMs } catch { return 0 }
}
function storeSignature(): string {
  return `${ITEMS_FILE}:${mtimeMsOf(ITEMS_FILE)}|${BACKUP_FILE}:${mtimeMsOf(BACKUP_FILE)}|${LEGACY_LEADS_FILE}:${mtimeMsOf(LEGACY_LEADS_FILE)}`
}
/** 归一化单个原始 record（与历史实现完全一致，不改任何判断逻辑）。 */
function normalizeRawItem(item: any, legacyMap: Map<string, any>): any {
  const old = legacyMap.get(item.id) || {}
  return normalizeItem({ ...old, ...item, leadGrade: item.leadGrade || old.leadGrade, leadScore: item.leadScore ?? old.leadScore, leadScoreReasons: item.leadScoreReasons || old.leadScoreReasons })
}
/** 冷启动基线加载（一次性同步；由 700ms 预热触发，避免首个请求拿到空数组）。 */
function reloadMainItemsSync(): any[] {
  const signature = storeSignature()
  if (loadMainCache.signature === signature && loadMainCache.items.length > 0) return loadMainCache.items
  loadMainCache.serialized = Buffer.alloc(0)
  loadMainCache.serializedSignature = ''
  loadMainCache.items = []
  const main = readJsonArray(ITEMS_FILE)
  const backup = readJsonArray(BACKUP_FILE)
  const legacy = readJsonArray(LEGACY_LEADS_FILE)
  const base = main.length ? main : backup.length ? backup : legacy
  const legacyMap = new Map(legacy.filter((i: any) => i.id).map((i: any) => [i.id, i]))
  const items = base.map((item: any) => normalizeRawItem(item, legacyMap))
  loadMainCache.signature = signature
  loadMainCache.items = items
  return items
}
let mainReloading = false
let mainReloadQueued = false
let nextMainReloadAllowedAt = 0
/** 后台分片重建 loadMainCache。绝不阻塞当前请求；正在重建则记一次排队。 */
function scheduleMainReload(): void {
  if (mainReloading) { mainReloadQueued = true; return }
  const now = Date.now()
  if (now < nextMainReloadAllowedAt) {
    setTimeout(() => scheduleMainReload(), nextMainReloadAllowedAt - now)
    return
  }
  nextMainReloadAllowedAt = now + 20000 // 节流：连续写盘最多 20s 一次重载。后台 auto-loop（pipeline stepper）每次 tick 会连续多次写盘，
  // 若 4s 就重载一次会在其 30s 写盘突发里额外叠加多次 324MB 解析阻塞；20s 节流让写盘突发合并成 ~1 次重载，
  // 摘要以 SWR 语义最多滞后 ~20s 后收敛到最新真相源（写操作方的自身改动由命令响应即时回显，不受影响）。
  mainReloading = true
  mainReloadQueued = false
  setImmediate(() => {
    const tStart = Date.now()
    // 先释放全量序列化 Buffer（~244MB），降低重载解析时的内存压力，避免 GC 抖动拖慢 JSON.parse
    loadMainCache.serialized = Buffer.alloc(0)
    loadMainCache.serializedSignature = ''
    let main: any[], backup: any[], legacy: any[]
    try {
      main = readJsonArray(ITEMS_FILE)
      backup = readJsonArray(BACKUP_FILE)
      legacy = readJsonArray(LEGACY_LEADS_FILE)
    } catch (_e) {
      mainReloading = false
      if (mainReloadQueued) scheduleMainReload()
      return
    }
    const tParse = Date.now()
    const signature = storeSignature()
    const base = main.length ? main : backup.length ? backup : legacy
    const legacyMap = new Map(legacy.filter((i: any) => i.id).map((i: any) => [i.id, i]))
    const nextItems: any[] = new Array(base.length)
    let i = 0
    const step = () => {
      const until = Date.now() + 50
      while (i < base.length && Date.now() < until) {
        nextItems[i] = normalizeRawItem(base[i], legacyMap)
        base[i] = undefined // 释放原始对象引用，控制峰值内存
        i++
      }
      if (i < base.length) { setImmediate(step); return }
      const tNorm = Date.now()
      // 完成：原子换入（读盘失败/文件为空时保留旧快照，不把缓存清空）
      if (nextItems.length > 0 || loadMainCache.items.length === 0) {
        loadMainCache.serialized = Buffer.alloc(0)
        loadMainCache.serializedSignature = ''
        loadMainCache.items = nextItems
        loadMainCache.signature = signature
      }
      mainReloading = false
      if (loadMainCache.items.length > 0) scheduleSummaryBuild(loadMainCache.signature)
      console.error(`[reload] ${new Date().toISOString()} parse=${tParse - tStart}ms normalize=${tNorm - tParse}ms items=${nextItems.length}`)
      // 重建期间又发生了写入，或排队过 → 续建一次
      if (mainReloadQueued || storeSignature() !== loadMainCache.signature) scheduleMainReload()
    }
    step()
  })
}
function loadMainItems(): any[] {
  if(businessSplitActive()) {
    const items=readItemsDirect(ITEMS_FILE)
    if(items.some((item:any)=>classifyCustomer(item)!=='furniture'))throw new Error('BUSINESS_STORE_CONTAMINATED')
    return items.map((item:any)=>normalizeRawItem(item,new Map()))
  }
  const signature = storeSignature()
  if (loadMainCache.signature === signature) return loadMainCache.items
  if (loadMainCache.signature === '' || loadMainCache.items.length === 0) {
    return reloadMainItemsSync() // 冷启动：一次性同步建基线
  }
  scheduleMainReload() // 数据变了：先回上次快照（毫秒），后台分片重建
  return loadMainCache.items
}
// 全量序列化缓存：/api/items 每次 sendJson 仍会 JSON.stringify 244MB（实测 ~1.2s 首字节前）。
// 与 loadMainCache 共用同一 signature，文件 mtime 未变就直接复用上次序列化 Buffer（一次性 UTF-8 编码），
// res.end 直接写 Buffer，温请求首字节 ms 级。
function serializeMainItems(): Buffer {
  const items = loadMainItems()
  if(businessSplitActive())return Buffer.from(JSON.stringify(items),'utf8')
  if (loadMainCache.serializedSignature !== loadMainCache.signature) {
    loadMainCache.serialized = Buffer.from(JSON.stringify(items), 'utf8')
    loadMainCache.serializedSignature = loadMainCache.signature
  }
  return loadMainCache.serialized
}

// ========= 列表摘要（/api/items/summary）=========
// 按需加载：列表/卡片/工作台只读精简字段，超大详情字段（emailLogs 正文 body、emailVerificationEvidence
// 的 note/rawResult/semanticResult）不进摘要；详情页按 id 走 /api/items/:id 拿完整数据。
// 其余显示+判断所需字段全保留（宁可多带不漏带），且不改任何存储数据。
// gzip buffer 与明文都按 store 文件 mtime 签名缓存，文件没变就复用，避免每请求重复压缩。
// stale-while-revalidate：后台进程（auto_loop 等）持续写 items_store.json，mtime 每几秒就变，
// 若每次变更都同步重建 324MB 解析+序列化，请求会阻塞 5-7s。因此数据变更时先返回上次构建的缓存
// （毫秒级），同时后台单飞重建，收敛到最新真相源——避免"打开慢/卡死"。
const summaryCache: { signature: string; plain: Buffer; gzip: Buffer } = { signature: '', plain: Buffer.alloc(0), gzip: Buffer.alloc(0) }
function buildSummaryItem(item: any): any {
  const out: any = {}
  for (const [key, value] of Object.entries(item)) {
    if (key === 'communicationEvents' || key === 'crmCommandLog' || key === 'salesStageHistory') {
      continue
    } else if (key === 'crmTasks' && Array.isArray(value)) {
      out[key] = value.filter((task: any) => task?.status === 'pending').map((task: any) => ({ id: task.id, type: task.type, content: task.content, opportunityId: task.opportunityId, dueAt: task.dueAt, priority: task.priority, status: task.status, source: task.source }))
    } else if (key === 'opportunities' && Array.isArray(value)) {
      out[key] = value.map((entry: any) => ({ id: entry.id, name: entry.name, status: entry.status, products: entry.products, quantity: entry.quantity, estimatedAmount: entry.estimatedAmount, currency: entry.currency, updatedAt: entry.updatedAt }))
    } else if (key === 'quoteVersions' && Array.isArray(value)) {
      out[key] = value.map((entry: any) => ({ id: entry.id, version: entry.version, opportunityId: entry.opportunityId, amount: entry.amount, currency: entry.currency, tradeTerm: entry.tradeTerm, status: entry.status, sentAt: entry.sentAt }))
    } else if (key === 'emailLogs' && Array.isArray(value)) {
      out[key] = value.map((log: any) => {
        const copy: any = { ...log }
        delete copy.body
        return copy
      })
    } else if (key === 'emailVerificationEvidence' && Array.isArray(value)) {
      out[key] = value.map((entry: any) => {
        const copy: any = { ...entry }
        delete copy.rawResult
        delete copy.semanticResult
        // draftReview 只读 note 前 240 字符（text(note).slice(0,240)），截断保留行为且省 ~40MB
        if (typeof copy.note === 'string' && copy.note.length > 240) copy.note = copy.note.slice(0, 240)
        return copy
      })
    } else {
      out[key] = value
    }
  }
  return out
}
/** 冷启动一次性同步建摘要缓存（由 2500ms 预热触发；首次请求兜底也会同步建，仅一次）。 */
function buildMainSummarySync(): void {
  const items = loadMainItems() // 冷启动时 loadMainCache 已由 700ms 预热建好基线
  const plain = Buffer.from(JSON.stringify(items.map(buildSummaryItem)), 'utf8')
  summaryCache.plain = plain
  summaryCache.gzip = gzipSync(plain)
  summaryCache.signature = loadMainCache.signature
}
let summaryBuilding = false
let summaryBuildQueued = false
/** 后台流式重建摘要：逐条 stringify + 流式 gzip，每 50ms 让出事件循环，绝不阻塞请求。
 *  targetSignature = 本次构建所对应的 loadMainCache.signature；构建期间若换入新数据，
 *  summaryCache.signature 仍写本次 target，下次 getMainSummary 发现不匹配会再触发重建（SWR 收敛）。 */
function scheduleSummaryBuild(targetSignature: string): void {
  if (summaryCache.signature === targetSignature) return
  if (summaryBuilding) { summaryBuildQueued = true; return }
  if (loadMainCache.items.length === 0) return
  summaryBuilding = true
  summaryBuildQueued = false
  const items = loadMainCache.items // 快照：不可变换入，构建期间数组不会变
  let failed = false
  try {
    const gz = createGzip()
    const gzipChunks: Buffer[] = []
    const plainChunks: Buffer[] = []
    let i = 0
    let first = true
    const step = () => {
      if (failed) return
      const until = Date.now() + 50
      let parts: string[] = []
      while (i < items.length && Date.now() < until) {
        const json = JSON.stringify(buildSummaryItem(items[i]))
        parts.push(first ? '[' + json : ',' + json) // 首条前置 '['，保证数组结构合法
        first = false
        i++
      }
      if (parts.length) {
        const chunk = Buffer.from(parts.join(''), 'utf8')
        plainChunks.push(chunk)
        gz.write(chunk)
      }
      if (i < items.length) { setImmediate(step); return }
      const tail = Buffer.from(']', 'utf8')
      plainChunks.push(tail)
      gz.end(tail)
    }
    gz.on('data', (c: Buffer) => gzipChunks.push(c))
    gz.on('end', () => {
      if (failed) return
      summaryCache.plain = Buffer.concat(plainChunks)
      summaryCache.gzip = Buffer.concat(gzipChunks)
      summaryCache.signature = targetSignature
      summaryBuilding = false
      console.error(`[summary] ${new Date().toISOString()} built items=${items.length} plain=${(summaryCache.plain.length / 1024 / 1024).toFixed(1)}MB gzip=${(summaryCache.gzip.length / 1024 / 1024).toFixed(1)}MB`)
      if (summaryBuildQueued) scheduleSummaryBuild(loadMainCache.signature)
    })
    gz.on('error', () => { failed = true; summaryBuilding = false })
    step()
  } catch (_e) {
    summaryBuilding = false
  }
}
function getMainSummary(): { plain: Buffer; gzip: Buffer } {
  if(businessSplitActive()){const plain=Buffer.from(JSON.stringify(loadMainItems().map(buildSummaryItem)),'utf8');return {plain,gzip:gzipSync(plain)}}
  if (summaryCache.signature === storeSignature()) return summaryCache // 新鲜：毫秒返回
  if (summaryCache.plain.length === 0) { buildMainSummarySync(); return summaryCache } // 首次：同步建缓存（仅一次）
  // 数据变了：先回上次缓存（毫秒），后台收敛到最新真相源，不阻塞当前请求
  if (loadMainCache.signature !== storeSignature()) scheduleMainReload() // 主快照也旧了：先重载主快照，完成后链式触发摘要重建
  else scheduleSummaryBuild(loadMainCache.signature)
  return summaryCache
}
function findMainItemById(id: string): any {
  if(businessSplitActive())return loadMainItems().find((item:any)=>item?.id===id)
  // 详情页按需：优先用当前已加载数组快速命中（摘要里的卡片必然存在于该数组），不触发任何重载
  const hit = loadMainCache.items.find((item: any) => item?.id === id)
  if (hit) return hit
  // 未命中（如新客户尚未被快照收录）：loadMainItems 现在也是 SWR（秒回上次快照 + 后台重载），不会阻塞
  return loadMainItems().find((item: any) => item?.id === id)
}

function writeItemsSnapshot(items: any[]): void {
  try {
    if (!existsSync(SNAPSHOT_DIR)) require('fs').mkdirSync(SNAPSHOT_DIR, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    writeFileSync(join(SNAPSHOT_DIR, 'items_store_' + stamp + '.json'), JSON.stringify(items, null, 2), 'utf-8')
  } catch (_e) {}
}

function saveMainItems(_items: any[]): any[] {
  throw new Error('ADMIN_FULL_STORE_WRITE_DISABLED')
}

function loadBackup(): any[] {
  try {
    if (existsSync(BACKUP_FILE)) return JSON.parse(readFileSync(BACKUP_FILE, 'utf-8'))
  } catch (_e) {}
  return []
}

function saveBackup(_items: any[]): void {
  throw new Error('ADMIN_BACKUP_WRITE_DISABLED')
}

const MAX_ITEM_COMMAND_BODY = 2 * 1024 * 1024
const MAX_DEFAULT_BODY = 20 * 1024 * 1024

function parseBody(req: http.IncomingMessage, maxSize = MAX_DEFAULT_BODY): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = ''
    let size = 0
    let settled = false
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxSize) {
        if (!settled) {
          settled = true
          reject(new Error('REQUEST_BODY_TOO_LARGE'))
        }
        return
      }
      if (!settled) body += chunk
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      try {
        resolve(body.trim() ? JSON.parse(body) : {})
      } catch {
        reject(new Error('MALFORMED_JSON'))
      }
    })
  })
}
function getClientIp(req: http.IncomingMessage): string {
  return req.socket.remoteAddress || '127.0.0.1'
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

function publicItemCommandError(error: unknown): { status: number; code: string } {
  const code = String((error as Error)?.message || '')
  if (code === 'ITEM_NOT_FOUND') return { status: 404, code }
  if (code === 'ITEM_REVISION_CONFLICT' || code === 'COMMAND_ID_CONFLICT' || code === 'ITEM_HISTORY_FIELD_PROTECTED' || code === 'ITEM_TIMELINE_PROTECTED') return { status: 409, code }
  if (code === 'ITEM_ID_CHANGED' || code === 'ITEM_MUTATION_INVALID' || code === 'ITEM_TIMELINE_INVALID') return { status: 422, code }
  if (code === 'ITEMS_STORE_BUSY') return { status: 503, code }
  return { status: 500, code: 'INTERNAL_ERROR' }
}

const formalQueueSecurity = new FormalQueueSecurity()
function authorizeFormalMutation(req:http.IncomingMessage,res:http.ServerResponse):{approvedBy:string}|null{
  const input=formalAuthInput(req)
  if(!input.operatorToken||!input.csrfToken){sendJson(res,403,{ok:false,code:"FORMAL_AUTH_REQUIRED"});return null}
  const result=formalQueueSecurity.authorizeMutation(input)
  if(!result.ok){sendJson(res,403,{ok:false,code:result.code});return null}
  return{approvedBy:result.approvedBy||input.operatorToken}
}
// ---- Dashboard aggregate (computed once per refresh, cached ~30s) ----
// 运营看板只读取已持久化 primaryStage，与 CRM 卡片保持同一事实源。
async function computeDashboardBody(): Promise<any> {
  const items=loadMainItems()
  const stage=(x:any)=>String(x?.primaryStage||''), arr=(v:any)=>Array.isArray(v)?v:[], text=(v:any)=>typeof v==='string'?v.trim():''
  const detailed=(x:any)=>Boolean(x.detailedBackcheckAt||x.detailedBackcheckVersion)
  const emails=(x:any)=>[x.email,...arr(x.contacts).map((c:any)=>c?.email)].filter((e:any)=>/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text(e))), generic=(e:string)=>/^(info|sales|contact|hello|office|admin|support)@/i.test(e)
  const snovioTasks=items.flatMap((x:any)=>arr(x.snovioDomainSearchTasks)), contacts=items.flatMap((x:any)=>arr(x.contacts).filter((c:any)=>c?.source==='snovio_found'))
  const pool=items.filter((x:any)=>stage(x)==='email_validation_queue'), tiers=['backcheck_queue','contact_mining_queue','email_validation_queue','observation_queue','developable_email_pool','pending_draft_review','scheduled_send_queue','followup_queue','replied_queue','replace_contact_queue','low_priority_nurture','data_enrichment_needed','manual_review','true_excluded']
  const testLedger=testMailQueueDashboard(readTestMailQueue()),formalLedger=queueDashboard(readFormalSendQueue(),new Date(),items)
  return{ok:true,lastUpdatedAt:new Date().toISOString(),primaryStageTotal:items.length,backcheck:{target:items.filter((x:any)=>stage(x)==='backcheck_queue').length,pending:items.filter((x:any)=>stage(x)==='backcheck_queue').length,completed:items.filter(detailed).length,failed:items.filter((x:any)=>(x.backCheck||x.backcheck)?.error).length,humanReview:items.filter((x:any)=>stage(x)==='manual_review').length,lowPriority:items.filter((x:any)=>stage(x)==='low_priority_nurture').length,trueExcluded:items.filter((x:any)=>stage(x)==='true_excluded').length},contacts:{needed:items.filter((x:any)=>stage(x)==='contact_mining_queue').length,snovioCompanies:new Set(snovioTasks.map((t:any)=>t.customerId)).size,creditsUnknown:true,returned:contacts.length,personal:contacts.filter((c:any)=>c.email&&!generic(c.email)).length,generic:contacts.filter((c:any)=>c.email&&generic(c.email)).length,failed:snovioTasks.filter((t:any)=>t.status==='failed').length,pending:snovioTasks.filter((t:any)=>t.status==='in_progress').length},validation:{tomorrow:pool.length,highValue:pool.filter((x:any)=>x.importCommercialValue==='high').length,public:pool.filter((x:any)=>emails(x).some(generic)).length,freeBusiness:pool.filter((x:any)=>emails(x).some((e:string)=>/@(gmail|outlook|hotmail|yahoo)\./i.test(e))).length,watching:items.filter((x:any)=>stage(x)==='observation_queue').length,unreachable:items.filter((x:any)=>stage(x)==='replace_contact_queue').length},quota:{testMail:{...testLedger,platformQuota:'unknown'},formal:{dailyLimit:formalLedger.dailyMax,sentToday:formalLedger.sentToday,remainingQuota:formalLedger.remainingQuota,platformQuota:'unknown'},snovio:{creditsUnknown:true,companiesCalled:new Set(snovioTasks.map((t:any)=>t.customerId)).size}},tiers:Object.fromEntries(tiers.map(t=>[t,items.filter((x:any)=>stage(x)===t).length]))}
}
async function refreshDashboardCache(): Promise<void> {
  if(dashboardRefreshPromise)return dashboardRefreshPromise
  dashboardRefreshPromise=(async()=>{try{const body=await computeDashboardBody();dashboardCacheAt=Date.now();dashboardCacheBody=body}catch(e){console.error('[dashboard] refresh failed',e)}finally{dashboardRefreshPromise=null}})()
  return dashboardRefreshPromise
}
// ---- /api/dashboard-stats stage counts ----
// getWorkflowStage 在 evidence 超重的记录上单条约 50-250ms（emailVerificationEvidence 最多 8200+ 条），
// 2453 条全量同步算 ≈ 数分钟，绝不能同步跑在请求里阻塞事件循环。这里改为时间预算分片后台计算，
// 结果按 loadMainCache.signature 缓存（stale-while-revalidate）：请求永远即时返回，数据变更后下一次
// 请求触发后台重算，期间继续提供上一次的计数，不会回落到 0。
let dashboardStageCounts: { signature: string; counts: Record<string, number> } = { signature: '', counts: {} }
let dashboardStageCountsInflight: Promise<void> | null = null

async function computeStageCountsBudgeted(items: any[]): Promise<Record<string, number>> {
  const counts = countItemsByCrmCard([])
  const BUDGET_MS = 60
  let i = 0
  while (i < items.length) {
    const until = Date.now() + BUDGET_MS
    while (i < items.length && Date.now() < until) {
      const card = cardForItem(items[i])
      if (card) counts[card] += 1
      i++
    }
    if (i < items.length) await new Promise(resolve => setImmediate(resolve))
  }
  return counts
}

function scheduleDashboardStageCounts(): void {
  const signature = loadMainCache.signature
  if (!signature || dashboardStageCounts.signature === signature || dashboardStageCountsInflight) return
  const items = loadMainCache.items
  dashboardStageCountsInflight = (async () => {
    try {
      const counts = await computeStageCountsBudgeted(items)
      dashboardStageCounts = { signature, counts }
    } catch (error) {
      console.error('[dashboard-stats] stage counts compute failed', String(error instanceof Error ? error.message : error))
    } finally {
      dashboardStageCountsInflight = null
    }
  })()
}
function serveCommunityFrontend(req: http.IncomingMessage, res: http.ServerResponse, pathname: string) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end()
    return
  }
  const asset = /^\/(assets|bbox-ui)\/[a-zA-Z0-9._-]+$/.test(pathname)
  const knownPage = /^\/(?:daily-workbench|search-workbench|smart-add|develop|crm-followups|admin|import|settings|email-batch|send-queue|replies|a-review|trade-documents|plan-tasks|(?:pipeline|item|crm-card)\/[a-zA-Z0-9_-]+)?\/?$/.test(pathname)
  if (!asset && !knownPage) {
    res.writeHead(404).end()
    return
  }
  const file = join(DIST_DIR, asset ? pathname.slice(1) : 'index.html')
  if (!existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end()
    return
  }
  const extension = extname(file)
  const contentType = extension === '.js' ? 'application/javascript' : MIME_TYPES[extension] || 'application/octet-stream'
  res.writeHead(200, { 'Content-Type': contentType, 'X-Content-Type-Options': 'nosniff' })
  res.end(req.method === 'HEAD' ? undefined : readFileSync(file))
}

const server = http.createServer(async (req, res) => {
  const authority = `127.0.0.1:${PORT}`
  const localOrigin = `http://${authority}`
  if (req.headers.host !== authority) {
    sendJson(res, 403, { error: 'LOCAL_HOST_REQUIRED' })
    return
  }
  let target: URL
  try {
    target = new URL(req.url || '/', localOrigin)
  } catch {
    sendJson(res, 400, { error: 'INVALID_REQUEST_TARGET' })
    return
  }
  if (target.origin !== localOrigin) {
    sendJson(res, 403, { error: 'LOCAL_HOST_REQUIRED' })
    return
  }
  req.url = target.pathname + target.search
  if (!target.pathname.startsWith('/api/')) {
    serveCommunityFrontend(req, res, target.pathname)
    return
  }
  const origin = req.headers.origin
  const sameOriginBrowser = req.headers['sec-fetch-site'] === 'same-origin' &&
    String(req.headers.referer || '').startsWith(localOrigin + '/')
  if (origin ? origin !== localOrigin : !sameOriginBrowser) {
    sendJson(res, 403, { error: 'LOCAL_ORIGIN_REQUIRED' })
    return
  }
  req.headers.origin = localOrigin
  if (target.pathname.startsWith('/api/marketing/') ||
      target.pathname.startsWith('/api/webhook-sync')) {
    sendJson(res, 503, { error: 'SERVICE_UNAVAILABLE_IN_LOCAL_REVIEW' })
    return
  }

  const requestPathname = (req.url || '').split('?')[0]
  if (applyLocalCors(req, res)) return
  if (["/api/smtp-handshake","/api/snovio/verify-email","/api/verify-email-dns","/api/batch-dns-check","/api/batch-test-send","/api/test-mail-recovery/sync","/api/check-email-status","/api/test-mail-queue","/api/test-mail-queue/dashboard","/api/test-mail-queue/plan","/api/test-mail-queue/pause","/api/test-mail-queue/resume","/api/test-mail-queue/execute-due"].includes(requestPathname)) {
    sendJson(res, 404, { error: 'not found' })
    return
  }
  if (req.method === 'GET' && (requestPathname.startsWith('/api/marketing/') || requestPathname === '/api/business-pipelines' || requestPathname === '/api/business-llm-config' || requestPathname === '/api/business-pipeline-customers' || requestPathname === '/api/business-customer-detail')) {
    if (!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '')) {
      sendJson(res,403,{ok:false,code:'LOCAL_ONLY'}); return
    }
    try {
      const url = new URL(req.url || '', 'http://localhost')
      if (requestPathname === '/api/marketing/bridge') sendJson(res,200,readMarketingBridge())
      else if (requestPathname === '/api/marketing/content-matches') sendJson(res,200,await automaticContentMatches(ITEMS_FILE,url.searchParams.get('customer_id')||''))
      else if (requestPathname === '/api/marketing/capabilities') sendJson(res,200,{schema:'marketing-capabilities.v1',business_lines:['furniture','carseat','knitwear']})
      else if (requestPathname === '/api/business-pipelines') sendJson(res,200,businessPipelines(url.searchParams.get('batch_id')||undefined,url.searchParams.get('business_id')||'carseat'))
      else if (requestPathname === '/api/business-customer-detail') {
        try {sendJson(res,200,customerDetail(activeCustomerRegistry(),url.searchParams.get('business_id'),url.searchParams.get('customer_id')))}
        catch(error) {const code=(error as Error).message;sendJson(res,code==='CUSTOMER_NOT_FOUND'?404:code.startsWith('INVALID_')?400:503,{ok:false,code:code.startsWith('INVALID_')?code:code==='CUSTOMER_NOT_FOUND'?code:'BUSINESS_SPLIT_UNAVAILABLE'})}
      }
      else if (requestPathname === '/api/business-pipeline-customers') {
        try {
          const business=url.searchParams.get('business_id')||'',active=businessSplitActive(),base=join(__dirname,'..','data','business-lines')
          if(active) activeCustomerRegistry()
          if(business==='unclassified'&&!active){sendJson(res,200,{business_id:business,status:'unavailable',readonly:true,page:1,page_size:20,total:null,items:[]});return}
          const sources=active?{itemsPath:business==='carseat'?join(base,'carseat.json'):business==='unclassified'?join(base,'holding.json'):ITEMS_STORE_FILE,woolPath:String(process.env.MMUSEOPS_TEST_WOOL_PATH)}:undefined
          sendJson(res,200,businessPipelineCustomers(business,Number(url.searchParams.get('page')||1),Number(url.searchParams.get('page_size')||20),sources,active?undefined:loadMainItems))
        }
        catch(error) {const code=(error as Error).message;sendJson(res,code==='UNKNOWN_BUSINESS'||code==='INVALID_PAGINATION'?400:503,{ok:false,code:code==='UNKNOWN_BUSINESS'||code==='INVALID_PAGINATION'?'INVALID_BUSINESS_OR_PAGINATION':'BUSINESS_SPLIT_UNAVAILABLE'})}
      }
      else if (requestPathname === '/api/business-llm-config') sendJson(res,200,readBusinessLlm())
      else if (requestPathname === '/api/marketing/demand-topics') sendJson(res,200,automaticDemandTopics(ITEMS_FILE,url.searchParams.get('business_line')||''))
      else if (requestPathname === '/api/marketing/production-tasks') sendJson(res,200,await automaticContentProduction(ITEMS_FILE,url.searchParams.get('business_line')||''))
      else if (requestPathname === '/api/marketing/outcomes') sendJson(res,200,marketingOutcomes(readMarketingBridge(),url.searchParams.get('workspace_id')||'',readMarketingCustomers(ITEMS_FILE)))
      else if (requestPathname === '/api/marketing/customer-ref') {
        const ref = marketingCustomerRef(readMarketingCustomers(ITEMS_FILE),url.searchParams.get('id')||'')
        sendJson(res,ref?200:404,ref||{ok:false,code:'CUSTOMER_NOT_FOUND'})
      } else sendJson(res,404,{ok:false,code:'NOT_FOUND'})
    } catch { sendJson(res,503,{ok:false,code:'MARKETING_BRIDGE_UNAVAILABLE'}) }
    return
  }
  const clientIp = getClientIp(req)
  const skipRateLimit = requestPathname.startsWith('/api/items/sync') || requestPathname.startsWith('/api/items/dedup') || requestPathname.startsWith('/api/config')
  if (!skipRateLimit && !checkRateLimit(clientIp)) {
    sendJson(res, 429, { ok: false, code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests; retry shortly.' })
    return
  }

  const legacyPath = (req.url || '').split('?')[0]
  const deprecatedEntries: Record<string, string> = {
    '/api/send-email': '/api/formal-send-queue/approve -> /api/formal-send-queue/plan -> /api/formal-send-queue/execute-due',
    '/api/batch-test-send': '/api/test-mail-queue/plan -> /api/test-mail-queue/execute-due',
    '/api/batch-dns-check': '/api/verify-email-dns', '/api/check-email-status': '/api/webhook-sync and /api/test-mail-recovery/sync',
    '/api/check-replies': '/api/zoho-replies/sync', '/api/snovio/batch': '/api/snovio/domain-search', '/api/snovio/get-token': '/api/snovio/domain-search',
    '/api/snovio/email-finder': '/api/snovio/domain-search', '/api/snovio/verify-email': 'DNS/MX -> test_mail_queue -> Worker/D1 + Resend recovery',
    '/api/scheduler/start': '/api/test-mail-queue/execute-due or /api/formal-send-queue/execute-due', '/api/scheduler/pause': '/api/test-mail-queue/pause or /api/formal-send-queue/pause',
    '/api/scheduler/resume': '/api/test-mail-queue/resume or /api/formal-send-queue/resume', '/api/scheduler/reset': 'queue-specific dashboard and quota ledger', '/api/scheduler/config': 'queue-specific configuration',
  }
  const replacementEntry = deprecatedEntries[legacyPath]
  if (replacementEntry) { sendJson(res,410,{ok:false,code: 'DEPRECATED_ENTRY',deprecatedReason:'This endpoint bypasses the unified MMUSEOPS workflow, eligibility gates, or atomic write layer.',replacementEntry});return }

  let body: Record<string, unknown> = {}
  try {
    const requestPath = req.url?.split('?')[0] || ''

    if (req.method === 'POST' && requestPath === '/api/items/admin-import') {
      sendJson(res, 403, { ok: false, code: 'ADMIN_IMPORT_DISABLED' })
      return
    }
    if (req.method === 'POST' && requestPath === '/api/items/restore-backup') {
      sendJson(res, 403, { ok: false, code: 'RESTORE_BACKUP_DISABLED' })
      return
    }
    const itemCommandRequest = req.method === 'POST' && requestPath === '/api/items/command'
    const crmCommandRequest = req.method === 'POST' && requestPath === '/api/crm/command'
    const boundedCommandRequest = itemCommandRequest || crmCommandRequest || (req.method === 'POST' && ['/api/business-llm-config','/api/business-customer-update'].includes(requestPath))
    if (boundedCommandRequest) {
      if (!isApplicationJsonContentType(req.headers['content-type'])) {
        sendJson(res, 415, { ok: false, code: 'CONTENT_TYPE_JSON_REQUIRED' })
        return
      }
      const declaredLength = Number(req.headers['content-length'] || 0)
      if (Number.isFinite(declaredLength) && declaredLength > MAX_ITEM_COMMAND_BODY) {
        sendJson(res, 413, { ok: false, code: 'CONTENT_LENGTH_EXCEEDED' })
        return
      }
    }
    if (req.method === 'POST' && boundedCommandRequest) body = await parseBody(req, MAX_ITEM_COMMAND_BODY)
    else if (req.method === 'POST') body = await parseBody(req)
    if(req.method==='POST'&&requestPath==='/api/business-customer-update') {
      if(!authorizeFormalMutation(req,res))return
      try {sendJson(res,200,updateCustomerDetail(activeCustomerRegistry(),body))}
      catch(error) {const code=(error as Error).message;sendJson(res,code==='ITEM_REVISION_CONFLICT'?409:code==='ITEM_NOT_FOUND'?404:code.startsWith('INVALID_')?400:503,{ok:false,code:['ITEM_REVISION_CONFLICT','ITEM_NOT_FOUND'].includes(code)||code.startsWith('INVALID_')?code:'BUSINESS_SPLIT_UNAVAILABLE'})}
      return
    }
    if (req.method === 'POST' && requestPath === '/api/business-llm-config') {
      if (!authorizeFormalMutation(req,res)) return
      try { sendJson(res,200,await updateBusinessLlm(body)) }
      catch (error) {
        const code = (error as Error).message
        sendJson(res,code==='CONFIG_CONFLICT'?409:code==='INVALID_CONFIG'||code==='SHARED_SOURCE_UNAVAILABLE'?400:503,{ok:false,code:['CONFIG_CONFLICT','INVALID_CONFIG','SHARED_SOURCE_UNAVAILABLE'].includes(code)?code:'CONFIG_UPDATE_FAILED'})
      }
      return
    }
    if (userConfig.contactMiningEnabled === false && requestPath.startsWith('/api/snovio/')) {
      sendJson(res, 423, { ok: false, code: 'CONTACT_MINING_DISABLED', message: '联系人挖掘已关闭' })
      return
    }
    if (req.method === 'GET' && requestPath === '/api/pipeline-control') {
      sendJson(res, 200, { ok: true, ...readPipelineControl() })
      return
    }
    if (req.method === 'POST' && (requestPath === '/api/pipeline-control/start' || requestPath === '/api/pipeline-control/stop')) {
      const auth = authorizeFormalMutation(req, res)
      if (!auth) return
      const running = requestPath.endsWith('/start')
      if (running && !backgroundEnabled) {
        sendJson(res, 409, { ok: false, code: 'PIPELINE_WORKER_NOT_RUNNING' })
        return
      }
      sendJson(res, 200, { ok: true, ...setPipelineRunning(running, auth.approvedBy, undefined, new Date(), running ? { projectId: body.projectId ?? readPipelineControl().projectId, runBatchId: body.runBatchId ?? readPipelineControl().runBatchId } : {}) })
      if (running) void backgroundTick().catch(error => console.error('[pipeline] start failed', error))
      return
    }
    const mailIsolationStatus = getMailIsolationStatus(userConfig)
    const baselineSafetyGate = req.url?.split('?')[0] === '/api/smtp-handshake'
      ? null
      : checkExternalAction(req.url || '', body)
    const safetyGate = baselineSafetyGate || checkExternalAction(
      req.url || '', body, undefined, undefined,
      {
        allowSmtpHandshake: userConfig.allowSmtpHandshake === true,
        smtpHandshakeConfigured: mailIsolationStatus.capabilities.smtpHandshakeReady,
      },
    )
    if (!safetyGate.allowed) {
      const path = (req.url || '').split('?')[0]
      if (path === '/api/search') {
        sendJson(res, 423, {
          ok: false,
          errorCode: 'SAFE_MODE_BLOCKED',
          message: '瀹夊叏妯″紡宸查樆姝㈠閮ㄦ悳绱€?',
          provider: 'none',
          safeMode: true,
          blocked: true,
          details: { reason: 'External search requires separate user confirmation.' },
        })
        return
      }
      sendJson(res, safetyGate.httpStatus || 423, {
        ok: false,
        safeMode: safetyGate.safeMode,
        code: safetyGate.code,
        error: safetyGate.code === 'SEND_CONFIRMATION_REQUIRED'
          ? 'Live send requires a valid one-time server authorization.'
          : 'External action blocked: MMUSEOPS safe mode is enabled.',
      })
      return
    }

    if (req.method === 'POST' && req.url?.split('?')[0] === '/api/crm/command') {
      if (!isApplicationJsonContentType(req.headers['content-type'])) {
        sendJson(res, 415, { ok: false, code: 'CONTENT_TYPE_JSON_REQUIRED' })
        return
      }
      const auth = authorizeFormalMutation(req, res)
      if (!auth) return
      const validation = validateCrmCommandBody(body)
      if (!validation.ok) {
        sendJson(res, 400, { ok: false, code: validation.code, field: validation.field })
        return
      }
      try {
        let idempotent = false
        const updated = updateOneItemAtomic(validation.value.itemId, latest => {
          const outcome = applyCrmCommand(latest, validation.value, auth.approvedBy, new Date())
          idempotent = outcome.idempotent
          return outcome.item
        })
        sendJson(res, 200, { ok: true, item: updated.item, commandId: validation.value.commandId, idempotent })
      } catch (error) {
        const code = error instanceof Error ? error.message : 'CRM_COMMAND_FAILED'
        const status = code === 'CRM_COMMAND_CONFLICT' ? 409 : code.includes('NOT_FOUND') ? 404 : 400
        sendJson(res, status, { ok: false, code })
      }
      return
    }

    if (req.method === 'POST' && req.url?.split('?')[0] === '/api/items/command') {
      if (!isApplicationJsonContentType(req.headers['content-type'])) {
        sendJson(res, 415, { ok: false, code: 'CONTENT_TYPE_JSON_REQUIRED' })
        return
      }
      const auth = authorizeFormalMutation(req, res)
      if (!auth) return
      const validation = validateItemSaveCommandBody(body)
      if (!validation.ok) {
        sendJson(res, 400, { ok: false, code: validation.code, field: validation.field })
        return
      }
      const command = { ...validation.value, actor: auth.approvedBy }
      const commandFingerprint = createHash('sha256')
        .update(JSON.stringify({ itemId: command.itemId, expectedRevision: command.expectedRevision, item: command.item, ...(command.duplicatePolicy ? { duplicatePolicy: command.duplicatePolicy } : {}) }))
        .digest('hex')
      try {
        const updated = updateOneItemAtomic(command.itemId, () => command.item, ITEMS_STORE_FILE, {
          expectedRevision: command.expectedRevision,
          commandId: command.commandId,
          commandFingerprint,
          actor: command.actor,
          allowCreate: true,
          duplicatePolicy: command.duplicatePolicy,
        })
        sendJson(res, 200, { ok: true, item: updated.item, revision: updated.revision, commandId: command.commandId, idempotent: updated.idempotent === true, reusedExisting: updated.reusedExisting === true })
      } catch (error) {
        const publicError = publicItemCommandError(error)
        sendJson(res, publicError.status, { ok: false, code: publicError.code })
      }
      return
    }

    if (req.method === 'POST' && req.url?.split('?')[0] === '/api/items') {
      sendJson(res, 410, { ok: false, code: 'FULL_STORE_ENDPOINT_ADMIN_ONLY', replacementEntry: '/api/items/admin-import' })
      return
    }
    if (req.method === 'POST' && req.url?.split('?')[0] === '/api/email-disposition-command') {
      if (!isApplicationJsonContentType(req.headers['content-type'])) {
        sendJson(res, 415, { ok: false, code: 'CONTENT_TYPE_JSON_REQUIRED' })
        return
      }
      const auth = authorizeFormalMutation(req, res)
      if (!auth) return
      const validation = validateEmailDispositionCommandBody(body)
      if (!validation.ok) {
        sendJson(res, 400, { ok: false, code: validation.code, field: validation.field })
        return
      }
      const command = { ...validation.value, actor: auth.approvedBy }
      let idempotent = false
      try {
        const updated = updateOneItemAtomic(command.itemId, item => {
          const outcome = applyEmailDispositionCommandToItem(item, command)
          idempotent = outcome.idempotent
          return outcome.item
        })
        const item = updated.item
        sendJson(res, 200, {
          ok: true,
          itemId: command.itemId,
          email: maskEmailAddress(command.email),
          action: command.action,
          commandId: command.commandId,
          idempotent,
          dispositionLogCount: Array.isArray(item.emailDispositionLog) ? item.emailDispositionLog.length : 0,
          auditCount: Array.isArray(item.emailDispositionAudit) ? item.emailDispositionAudit.length : 0,
          deleted: false,
        })
      } catch (error) {
        const code = error instanceof EmailDispositionCommandError ? error.code : String((error as Error)?.message || 'DISPOSITION_COMMAND_FAILED')
        const status = code === 'ITEM_NOT_FOUND' || code === 'EMAIL_NOT_FOUND' ? 404 : code === 'COMMAND_ID_CONFLICT' ? 409 : 422
        sendJson(res, status, { ok: false, code, message: error instanceof Error ? error.message : code })
      }
      return
    }
    if (req.method === 'GET' && req.url?.split('?')[0] === '/api/stock-operations/dashboard') {
      const nowMs = Date.now()
      if (dashboardCacheBody) {
        if (nowMs - dashboardCacheAt >= 30_000) void refreshDashboardCache()
        sendJson(res, 200, dashboardCacheBody)
        return
      }
      await refreshDashboardCache()
      if (dashboardCacheBody) { sendJson(res, 200, dashboardCacheBody); return }
      sendJson(res, 503, { ok: false, code: 'DASHBOARD_COMPUTE_FAILED' })
      return
    }

    const formalQueuePath = req.url?.split('?')[0] || ''

    // ---- Persistent isolated test-mail queue (manual short-lived execution only) ----
    
    
    
    
    
    

    // ---- Isolation store ----
    if (req.method === 'POST' && req.url?.split('?')[0] === '/api/isolation/add') {
      const entry = body && typeof body === 'object' ? body : {}
      const objectType = String(entry.objectType || '').trim()
      const objectValue = String(entry.objectValue || '').trim()
      const reason = String(entry.reason || '').trim()
      if (!['company', 'domain', 'email', 'contact'].includes(objectType)) { sendJson(res, 400, { ok: false, code: 'ISOLATION_TYPE_INVALID', message: 'objectType must be company|domain|email|contact' }); return }
      if (!objectValue) { sendJson(res, 400, { ok: false, code: 'ISOLATION_VALUE_REQUIRED', message: 'objectValue is required' }); return }
      if (!reason) { sendJson(res, 400, { ok: false, code: 'ISOLATION_REASON_REQUIRED', message: 'reason is required' }); return }
      const result = addIsolation({
        objectType: objectType as any,
        objectValue,
        reason,
        sourceStage: String(entry.sourceStage || ''),
        isolatedAt: String(entry.isolatedAt || '') || new Date().toISOString(),
        originalCustomerId: String(entry.originalCustomerId || ''),
        permanent: entry.permanent !== false,
        ...(entry.note ? { note: String(entry.note) } : {}),
      })
      sendJson(res, 200, { ok: true, added: result.added, entry: result.entry })
      return
    }
    if (req.method === 'GET' && req.url?.split('?')[0] === '/api/isolation') {
      const url = new URL(req.url || '', 'http://localhost')
      const q = url.searchParams.get('q') || ''
      const type = url.searchParams.get('type') || ''
      const page = Number(url.searchParams.get('page')) || 1
      const pageSize = Number(url.searchParams.get('pageSize')) || 20
      sendJson(res, 200, { ok: true, ...listIsolation({ q, type, page, pageSize }) })
      return
    }

    // ---- Unified background scheduler status (for the Chinese workbench) ----
    if (req.method === 'GET' && req.url?.split('?')[0] === '/api/background-status') {
      sendJson(res, 200, { ok: true, ...getBackgroundStatus() })
      return
    }

    if (req.method === 'POST' && formalQueuePath === '/api/draft-review/reject') {
      const auth=authorizeFormalMutation(req,res);if(!auth)return
      const valid=validateExactFormalMutationBody(body,['customerId','draftId','returnTarget','reasonCode']);if(!valid.ok){sendJson(res,400,{ok:false,code:valid.code,field:valid.field});return}
      const customerId=String(body.customerId),draftId=String(body.draftId);let updated:any,found=false
      try{updateItemsAtomic(items=>items.map((item:any)=>{if(item.id!==customerId)return item;found=true;updated=rejectDraftForRework(item,{draftId,returnTarget:String(body.returnTarget) as any,reasonCode:String(body.reasonCode),rejectedBy:auth.approvedBy},new Date());return updated}),ITEMS_STORE_FILE,new Date(),{refreshOnlyMutated:true})}
      catch(error:any){const code=String(error?.message||'DRAFT_REJECTION_FAILED');sendJson(res,code.includes('INVALID')||code.includes('REQUIRED')?400:409,{ok:false,code});return}
      if(!found){sendJson(res,404,{ok:false,code:'CUSTOMER_NOT_FOUND'});return}
      sendJson(res,200,{ok:true,customerId,draftId,primaryStage:updated.primaryStage,nextRequiredAction:updated.nextRequiredAction});return
    }

    if (req.method === 'POST' && formalQueuePath === '/api/draft-review/create-draft') {
      const auth=authorizeFormalMutation(req,res);if(!auth)return
      let input
      try { input=validateCreateReviewDraft(body) }
      catch(error:any){sendJson(res,400,{ok:false,code:String(error?.message||'DRAFT_CREATE_BODY_INVALID')});return}
      try { sendJson(res,200,{ok:true,...createReviewDraft(input,auth.approvedBy,ITEMS_STORE_FILE)}) }
      catch(error:any){const code=String(error?.message||'DRAFT_CREATE_FAILED');const conflict=['DRAFT_RECIPIENT_MISMATCH','DRAFT_ID_CONFLICT','DRAFT_CONTENT_CONFLICT','DRAFT_ALREADY_PENDING','OUTBOUND_SIGNATURE_REQUIRES_REVIEW','OUTBOUND_CONTACT_TYPO_REQUIRES_REVIEW','DRAFT_SUBJECT_INVALID','DRAFT_BODY_INVALID'].includes(code);sendJson(res,code==='CUSTOMER_NOT_FOUND'?404:conflict?409:500,{ok:false,code:code==='CUSTOMER_NOT_FOUND'||conflict?code:'DRAFT_CREATE_FAILED'});return}
      return
    }

    if (req.method === 'POST' && formalQueuePath === '/api/draft-review/update-draft') {
      const auth=authorizeFormalMutation(req,res);if(!auth)return
      const customerId=String(body.customerId||''),draftId=String(body.draftId||'')
      const idSafe=/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;if(!idSafe.test(customerId)||!idSafe.test(draftId)){sendJson(res,400,{ok:false,code:'FORMAL_FIELD_INVALID'});return}
      const subject=typeof body.subject==='string'?body.subject.trim():''
      const bodyText=typeof body.body==='string'?body.body.trim():''
      if(!subject||subject.length>500){sendJson(res,400,{ok:false,code:'DRAFT_SUBJECT_INVALID'});return}
      if(!bodyText||bodyText.length>20000){sendJson(res,400,{ok:false,code:'DRAFT_BODY_INVALID'});return}
      let updated:any,found=false
      try{updateItemsAtomic(items=>items.map((item:any)=>{if(item.id!==customerId)return item;found=true;const draft=findPersistedDraft(item,draftId)?.draft;if(!draft)throw new Error('DRAFT_NOT_FOUND');if(draft.status!=='pending_human_review'||draft.sent===true)throw new Error('DRAFT_NOT_EDITABLE');updated=updatePersistedDraft(item,draftId,d=>({...d,subject,body:bodyText,updatedAt:new Date().toISOString()}));return updated}),ITEMS_STORE_FILE,new Date(),{refreshOnlyMutated:true,preserveUnmutated:true})}
      catch(error:any){const code=String(error?.message||'DRAFT_UPDATE_FAILED');const status=code==='DRAFT_NOT_FOUND'?404:code==='DRAFT_NOT_EDITABLE'?409:500;sendJson(res,status,{ok:false,code});return}
      if(!found){sendJson(res,404,{ok:false,code:'CUSTOMER_NOT_FOUND'});return}
      sendJson(res,200,{ok:true,customerId,draftId});return
    }
    if (req.method === 'POST' && formalQueuePath === '/api/draft-review/regenerate-draft') {
      const auth=authorizeFormalMutation(req,res);if(!auth)return
      const customerId=String(body.customerId||''),draftId=String(body.draftId||'')
      const idSafe=/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;if(!idSafe.test(customerId)||!idSafe.test(draftId)){sendJson(res,400,{ok:false,code:'FORMAL_FIELD_INVALID'});return}
      let updated:any,found=false
      try{updateItemsAtomic(items=>items.map((item:any)=>{if(item.id!==customerId)return item;found=true;const draft=findPersistedDraft(item,draftId)?.draft;if(!draft)throw new Error('DRAFT_NOT_FOUND');if(draft.status!=='pending_human_review'||draft.sent===true)throw new Error('DRAFT_NOT_REGENERABLE');const variant=Number(draft.regenerateCount||0)+1;const generated=generateDraft(item,variant);updated=updatePersistedDraft(item,draftId,d=>({...d,subject:generated.subject,body:generated.body,subjectCn:generated.subjectCn,bodyCn:generated.bodyCn,to:generated.to,targetLang:generated.targetLang,targetLangLabel:generated.targetLangLabel,regenerateCount:variant,updatedAt:new Date().toISOString()}));return updated}),ITEMS_STORE_FILE,new Date(),{refreshOnlyMutated:true})}
      catch(error:any){const code=String(error?.message||'DRAFT_REGENERATE_FAILED');const status=code==='DRAFT_NOT_FOUND'?404:code==='DRAFT_NOT_REGENERABLE'||code==='SELECTED_EMAIL_REQUIRED'?409:500;sendJson(res,status,{ok:false,code});return}
      if(!found){sendJson(res,404,{ok:false,code:'CUSTOMER_NOT_FOUND'});return}
      sendJson(res,200,{ok:true,customerId,draftId,subject:updated?.subject});return
    }
    if (req.method === 'POST' && formalQueuePath === '/api/draft-review/translate') {
      const auth=authorizeFormalMutation(req,res);if(!auth)return
      const subject=typeof body.subject==='string'?body.subject.trim():''
      const bodyText=typeof body.body==='string'?body.body.trim():''
      if(!subject||subject.length>500){sendJson(res,400,{ok:false,code:'DRAFT_SUBJECT_INVALID'});return}
      if(!bodyText||bodyText.length>20000){sendJson(res,400,{ok:false,code:'DRAFT_BODY_INVALID'});return}
      try{const translated=await llmTranslateDraft(subject,bodyText);sendJson(res,200,{ok:true,subjectCn:translated.subjectCn,bodyCn:translated.bodyCn});return}
      catch(error:any){const code=String(error?.message||'LLM_TRANSLATION_FAILED');console.log(`[draft-review/translate] failed: ${code}`);sendJson(res,code==='LLM_TRANSLATION_EMPTY'?422:502,{ok:false,code:code==='LLM_TRANSLATION_EMPTY'?'LLM_TRANSLATION_EMPTY':'LLM_UNAVAILABLE'});return}
    }
    // ---- Formal outreach queue: authenticated local operator, shared mutation lock, no automatic send ----
    if (req.method === 'GET' && formalQueuePath === '/api/formal-send-queue/operator-session') { try { const session=formalQueueSecurity.issueOperatorSession(String(req.headers.origin||''),String(req.socket.remoteAddress||''));sendJson(res,200,{ok:true,...session}); } catch(error:any){sendJson(res,403,{ok:false,code:String(error?.message||'LOCAL_OPERATOR_ORIGIN_REJECTED')})} return }
    if (req.method === 'GET' && formalQueuePath.startsWith('/api/formal-send-queue/customer-route/')) { const auth=authorizeFormalMutation(req,res);if(!auth)return;const ref=formalQueuePath.slice('/api/formal-send-queue/customer-route/'.length);if(!/^[a-f0-9]{24}$/.test(ref)){sendJson(res,400,{ok:false,code:'FORMAL_CUSTOMER_ROUTE_INVALID'});return}const item=loadMainItems().find((value:any)=>publicCustomerRouteRef(value?.id)===ref);if(!item){sendJson(res,404,{ok:false,code:'ITEM_NOT_FOUND'});return}sendJson(res,200,{ok:true,customerId:String(item.id)});return }
    if (req.method === 'GET' && formalQueuePath === '/api/formal-send-queue') { const auth=authorizeFormalMutation(req,res);if(!auth)return;await recoverFormalApprovalIntents({itemsPath:ITEMS_STORE_FILE});const items=loadMainItems();sendJson(res,200,publicFormalQueueResponse(readFormalSendQueue(),items)); return }
    if (req.method === 'GET' && formalQueuePath === '/api/formal-send-queue/dashboard') { const auth=authorizeFormalMutation(req,res);if(!auth)return;await recoverFormalApprovalIntents({itemsPath:ITEMS_STORE_FILE});const items=loadMainItems();sendJson(res,200,publicFormalQueueDashboardResponse(readFormalSendQueue(),items)); return }
    if (req.method === 'POST' && formalQueuePath.startsWith('/api/formal-send-queue/')) {
      const auth=authorizeFormalMutation(req,res);if(!auth)return
      await recoverFormalApprovalIntents({itemsPath:ITEMS_STORE_FILE})
      const required=formalQueuePath.endsWith('/approve')?['customerId','draftId']:formalQueuePath.endsWith('/reconcile-not-sent')?['recordId','auditCode']:[]
      const replyContentRoute=['/api/formal-send-queue/reply-draft','/api/formal-send-queue/reply-translation','/api/formal-send-queue/send-crm-reply','/api/formal-send-queue/review-crm-reply'].includes(formalQueuePath)
      const valid=replyContentRoute?validateCrmReplyRequest(body,/\/(?:send|review)-crm-reply$/.test(formalQueuePath)):validateFormalMutationBody(body,required);if(!valid.ok){sendJson(res,400,{ok:false,code:valid.code,field:valid.field});return}
      if(formalQueuePath==='/api/formal-send-queue/import-mailbox-message'){
        const allowed=new Set(['snapshotId','customerId']);if(Object.keys(body).some(field=>!allowed.has(field))){sendJson(res,400,{ok:false,code:'FORMAL_FIELD_UNEXPECTED'});return}
        try{const result=importMailboxMessage({snapshotId:String(body.snapshotId||''),customerId:body.customerId?String(body.customerId):undefined,itemsPath:ITEMS_STORE_FILE,runtimeDirectory:join(__dirname,'..','data','workbench-runtime')});sendJson(res,200,result)}catch(error:any){sendJson(res,409,{ok:false,code:String(error?.message||'MAILBOX_IMPORT_FAILED')})}return
      }
      if(formalQueuePath==='/api/formal-send-queue/analyze-mailbox-message'){
        const allowed=new Set(['customerId','replyMessageId']);if(Object.keys(body).some(field=>!allowed.has(field))){sendJson(res,400,{ok:false,code:'FORMAL_FIELD_UNEXPECTED'});return}
        try{const result=await analyzePersistedMailboxMessage({customerId:String(body.customerId||''),messageId:String(body.replyMessageId||''),itemsPath:ITEMS_STORE_FILE,runtimeDirectory:join(__dirname,'..','data','workbench-runtime')});sendJson(res,200,result)}catch(error:any){sendJson(res,409,{ok:false,code:String(error?.message||'MAILBOX_ANALYSIS_FAILED')})}return
      }
      if(formalQueuePath==='/api/formal-send-queue/review-crm-reply'){
        try{const item=loadMainItems().find((value:any)=>String(value.id)===String(body.customerId));const evidence=(item?.zohoReplyEvidence||[]).find((entry:any)=>String(entry.messageId)===String(body.replyMessageId));const result=await reviewCrmReply({item,evidence,to:String(body.to),subject:String(body.subject),body:String(body.body)});sendJson(res,200,result)}catch(error:any){sendJson(res,409,{ok:false,code:String(error?.message||'CRM_REPLY_REVIEW_FAILED')})}return
      }
      if(formalQueuePath==='/api/formal-send-queue/reply-draft'){
        const allowed=new Set(['customerId','replyMessageId']);for(const field of Object.keys(body))if(!allowed.has(field)){sendJson(res,400,{ok:false,code:'FORMAL_FIELD_UNEXPECTED',field});return}
        const fields=validateCrmReplyRequest(body);if(!fields.ok){sendJson(res,400,{ok:false,code:fields.code,field:fields.field});return}
        try{
          const item=loadMainItems().find((value:any)=>String(value?.id)===String(body.customerId));if(!item){sendJson(res,404,{ok:false,code:'ITEM_NOT_FOUND'});return}
          const evidence=(Array.isArray(item.zohoReplyEvidence)?item.zohoReplyEvidence:[]).find((entry:any)=>String(entry?.messageId||'').trim()===String(body.replyMessageId).trim())
          if(!evidence||evidence.classification!=='reply'){sendJson(res,404,{ok:false,code:'CRM_REPLY_SOURCE_NOT_FOUND'});return}
          const latest=(Array.isArray(item.zohoReplyEvidence)?item.zohoReplyEvidence:[]).filter((entry:any)=>entry?.classification==='reply').sort((a:any,b:any)=>Date.parse(String(b?.date||''))-Date.parse(String(a?.date||'')))[0]
          if(latest?.messageId!==evidence.messageId){sendJson(res,409,{ok:false,code:'CRM_REPLY_STALE_SOURCE'});return}
          if(!String(evidence.fromEmail||'').trim()){sendJson(res,409,{ok:false,code:'CRM_REPLY_RECIPIENT_UNVERIFIED'});return}
          const originalBody=String(evidence.fullBody||evidence.textSummary||'').trim();if(!originalBody){sendJson(res,409,{ok:false,code:'CRM_REPLY_SOURCE_BODY_MISSING'});return}
          const result=await generateCrmReplyDraft({company:String(item.company||item.title||''),country:String(item.country||''),businessSummary:[String(item.backCheck?.summary||''),...(Array.isArray(item.backCheck?.products)?item.backCheck.products.map(String):[])].filter(Boolean).join('\n'),relationshipSummary:String(item.relationshipSummary||''),contactName:String(item.contactName||''),originalSubject:String(evidence.subject||''),originalBody})
          sendJson(res,200,{ok:true,to:String(evidence.fromEmail).trim(),...result})
        }catch(error:any){const code=String(error?.message||'CRM_REPLY_DRAFT_UNAVAILABLE');sendJson(res,/SOURCE_CONTEXT_REQUIRED/.test(code)?409:502,{ok:false,code:/SOURCE_CONTEXT_REQUIRED|^MAIL_MODEL_/.test(code)?code:'CRM_REPLY_DRAFT_UNAVAILABLE'})}
        return
      }
      if(formalQueuePath==='/api/formal-send-queue/reply-translation'){
        const allowed=new Set(['customerId','replyMessageId']);for(const field of Object.keys(body))if(!allowed.has(field)){sendJson(res,400,{ok:false,code:'FORMAL_FIELD_UNEXPECTED',field});return}
        const fields=validateCrmReplyRequest(body);if(!fields.ok){sendJson(res,400,{ok:false,code:fields.code,field:fields.field});return}
        try{
          const item=loadMainItems().find((value:any)=>String(value?.id)===String(body.customerId));if(!item){sendJson(res,404,{ok:false,code:'ITEM_NOT_FOUND'});return}
          const evidence=(Array.isArray(item.zohoReplyEvidence)?item.zohoReplyEvidence:[]).find((entry:any)=>String(entry?.messageId||'').trim()===String(body.replyMessageId).trim())
          if(!evidence||evidence.classification!=='reply'){sendJson(res,404,{ok:false,code:'CRM_REPLY_SOURCE_NOT_FOUND'});return}
          if(evidence.translationCn?.bodyCn&&evidence.analysisBodySha256===evidence.bodySha256){sendJson(res,200,{ok:true,cached:true,...evidence.translationCn});return}
          const originalBody=String(evidence.fullBody||evidence.textSummary||'').trim();if(!originalBody){sendJson(res,409,{ok:false,code:'CRM_REPLY_SOURCE_BODY_MISSING'});return}
          const result=await translateCrmReplyContent({subject:String(evidence.subject||''),body:originalBody})
          sendJson(res,200,{ok:true,...result})
        }catch(error:any){const code=String(error?.message||'CRM_REPLY_TRANSLATION_UNAVAILABLE');sendJson(res,/SOURCE_CONTEXT_REQUIRED/.test(code)?409:502,{ok:false,code:/SOURCE_CONTEXT_REQUIRED|^MAIL_MODEL_/.test(code)?code:'CRM_REPLY_TRANSLATION_UNAVAILABLE'})}
        return
      }
      if(formalQueuePath==='/api/formal-send-queue/send-crm-reply'){
        const allowed=new Set(['customerId','replyMessageId','to','subject','body','confirmSend']);for(const field of Object.keys(body))if(!allowed.has(field)){sendJson(res,400,{ok:false,code:'FORMAL_FIELD_UNEXPECTED',field});return}
        const fields=validateCrmReplyRequest(body,true);if(!fields.ok){sendJson(res,400,{ok:false,code:fields.code,field:fields.field});return}
        if(body.confirmSend!==true){sendJson(res,400,{ok:false,code:'CRM_REPLY_CONFIRMATION_REQUIRED'});return}
        if(!userConfig.zohoPassword){sendJson(res,503,{ok:false,code:'FORMAL_ACCOUNT_CONFIG_MISSING'});return}
        try{
          const result=await sendCrmReplyOne({customerId:String(body.customerId),replyMessageId:String(body.replyMessageId),to:String(body.to),subject:String(body.subject),body:String(body.body),confirmed:true,approvedBy:auth.approvedBy,itemsPath:ITEMS_STORE_FILE,queuePath:FORMAL_SEND_QUEUE_FILE,send:async input=>sendFormalViaZoho({to:input.to,subject:input.subject,body:input.content,inReplyTo:input.inReplyTo,references:input.references,outboundKey:input.outboundKey})})
          sendJson(res,200,{ok:true,...result});
        }catch(error:any){const code=String(error?.message||'CRM_REPLY_SEND_FAILED'),status=/INVALID|NOT_FOUND|MISMATCH|CONFIRMATION_REQUIRED|BODY_MISSING|STALE_SOURCE/.test(code)?400:/ALREADY_SENT|RECONCILIATION_REQUIRED/.test(code)?409:code==='FORMAL_ACCOUNT_CONFIG_MISSING'?503:500;sendJson(res,status,{ok:false,code})}
        return
      }
      if(formalQueuePath==='/api/formal-send-queue/send-one'){
        const allowed=new Set(['customerId','draftId','confirmSend']);for(const field of Object.keys(body))if(!allowed.has(field)){sendJson(res,400,{ok:false,code:'FORMAL_FIELD_UNEXPECTED',field});return}
        const fields=validateFormalMutationBody(body,['customerId','draftId']);if(!fields.ok){sendJson(res,400,{ok:false,code:fields.code,field:fields.field});return}
        if(body.confirmSend!==true){sendJson(res,400,{ok:false,code:'FORMAL_SINGLE_SEND_CONFIRMATION_REQUIRED'});return}
        try{const result=await manualFormalSendOne({customerId:String(body.customerId),draftId:String(body.draftId),confirmed:true,approvedBy:auth.approvedBy,itemsPath:ITEMS_STORE_FILE,send:sendFormalViaZoho});sendJson(res,200,{ok:true,recordId:result.id,sendQueueStatus:result.sendQueueStatus,messageId:result.messageId,sentAt:result.actualSentAt,provider:result.provider,followupDueAt3d:result.followupDueAt3d,followupDueAt7d:result.followupDueAt7d});}catch(error:any){const code=String(error?.message||'FORMAL_SINGLE_SEND_FAILED'),status=code==='SAFE_MODE_BLOCKED'?423:code==='FORMAL_ACCOUNT_CONFIG_MISSING'?503:/DRAFT_|BLOCKED|CONFIRMATION|NOT_READY|FOLLOWUP_DAILY_LIMIT/.test(code)?409:500;sendJson(res,status,{ok:false,code});}return
      }
      if(formalQueuePath==='/api/formal-send-queue/send-grant'){try{const grant=await issueLockedFormalSendGrant({security:formalQueueSecurity,auth:formalAuthInput(req),now:new Date()});sendJson(res,200,{ok:true,...grant})}catch(error:any){sendJson(res,403,{ok:false,code:String(error?.message||'FORMAL_SEND_GRANT_INVALID')})}return}
      if(formalQueuePath==='/api/formal-send-queue/approve'){
        const customerId=String(body.customerId),draftId=String(body.draftId),item=readItemsAtomic(ITEMS_STORE_FILE).find((value:any)=>value.id===customerId),draft=findPersistedDraft(item,draftId)?.draft
        if(!item||!draft||draft.sent===true||!['pending_human_review','approved'].includes(draft.status)){sendJson(res,409,{ok:false,code:'DRAFT_NOT_REVIEWABLE'});return}
        const assessment=canSendFormalOutreach({item,draft,now:new Date()});if(draft.status==='pending_human_review'&&!assessment.canSend){sendJson(res,409,{ok:false,code:'DRAFT_APPROVAL_BLOCKED',blockedReasons:assessment.blockers});return}
        const recipientEmail=String(draft.to||''),recipientConsistency=validateFormalRecipientConsistency(item,draft,recipientEmail);if(recipientConsistency.length){sendJson(res,409,{ok:false,code:'RECIPIENT_IDENTITY_MISMATCH',blockedReasons:recipientConsistency});return}
        const tz=inferCustomerTimezone(item),now=new Date().toISOString()
        const requested:FormalSendQueueRecord={id:`queue-${Date.now()}-${customerId}`,campaignId:'manual',campaignName:'Manual approved outreach',channel:'formal_outreach',draftId,customerId,recipientEmail,senderEmail:OFFICIAL_OUTREACH_EMAIL,replyToEmail:OFFICIAL_OUTREACH_EMAIL,approvedAt:now,approvedBy:auth.approvedBy,draftVersion:Number(draft.version||0),draftRevision:String(draft.updatedAt||draft.createdAt||now),timezone:tz.timezone,timezoneSource:tz.source,isOneTimeSchedule:true,sendWindowLocal:'08:30-11:30 / 14:00-16:30',sendQueueStatus:'approved_for_sending',sendAttemptCount:0,createdAt:now,updatedAt:now}
        try { const created=await approveFormalDraftTransaction(requested,{itemsPath:ITEMS_STORE_FILE})
          sendJson(res,200,{ok:true,record:{id:created.id,sendQueueStatus:created.sendQueueStatus},warnings:assessment.warnings})
        } catch(error:any) { const code=String(error?.message||''); if(/^(DRAFT_RECIPIENT_MISMATCH|DRAFT_SUBJECT_INVALID|DRAFT_BODY_INVALID|DRAFT_NOT_FOUND|OUTBOUND_SIGNATURE_REQUIRES_REVIEW|OUTBOUND_CONTACT_TYPO_REQUIRES_REVIEW)$/.test(code)) sendJson(res,409,{ok:false,code}); else throw error } return
      }      if(formalQueuePath==='/api/formal-send-queue/plan'){const items=readItemsAtomic(ITEMS_STORE_FILE);const store=await mutateFormalSendQueue(current=>{current.records=planCurrentFormalQueueRecords(current.records,items,current.config);return current});sendJson(res,200,{ok:true,dashboard:queueDashboard(store,new Date(),items)});return}
      if(formalQueuePath==='/api/formal-send-queue/pause'){const store=await pauseFormalSendQueue(String(body.reason||'manual_pause'));sendJson(res,200,{ok:true,paused:store.paused,pausePending:store.pausePending===true});return}
      if(formalQueuePath==='/api/formal-send-queue/resume'){const store=await mutateFormalSendQueue(current=>({...current,paused:false,pausePending:false,pauseReason:undefined,pausePendingReason:undefined}));sendJson(res,200,{ok:true,paused:store.paused,autoSendEnabled:store.config.autoSendEnabled});return}
      if(formalQueuePath==='/api/formal-send-queue/reconcile-not-sent'){const recordId=String(body.recordId),auditCode=String(body.auditCode);let found=false;const store=await mutateFormalSendQueue(current=>{current.records=current.records.map(record=>{if(record.id!==recordId)return record;found=true;return reconcileConfirmedNotSent(record,{confirmedNotSent:true,reviewedBy:auth.approvedBy,auditCode},new Date())});return current});if(!found){sendJson(res,404,{ok:false,code:'QUEUE_RECORD_NOT_FOUND'});return}const items=loadMainItems();sendJson(res,200,{ok:true,dashboard:queueDashboard(store,new Date(),items)});return}
      if(formalQueuePath==='/api/formal-send-queue/execute-due'){
        // 正式发送由本机操作员会话直接触发；不再要求用户额外获取“一次性发送授权”。
        // 仍在服务端内部签发短时 claim，保留并发、队列变更和重复发送保护。
        const internalGrant=await issueLockedFormalSendGrant({security:formalQueueSecurity,auth:formalAuthInput(req),now:new Date()})
        const claim=await claimFormalSendGrantTargets({security:formalQueueSecurity,auth:formalAuthInput(req),token:internalGrant.token,safeMode:SAFE_MODE,now:new Date(),maxTargets:1});if(!claim.ok){sendJson(res,423,{ok:false,code:claim.code});return}
        const result=await runDueFormalOnce({claimedRecordIds:claim.claimedRecordIds,claimId:claim.claimId,send:sendFormalViaZoho});sendJson(res,200,{ok:true,stats:result.stats,dashboard:result.dashboard});return
      }
    }
    // ---- GET /api/mail-isolation/status (non-sensitive, read-only) ----
    if (req.method === 'GET' && req.url?.split('?')[0] === '/api/mail-isolation/status') {
      sendJson(res, 200, getMailIsolationStatus(userConfig))
      return
    }
    // ---- Worker/D1 webhook recovery (read-only external pull; local state update) ----
    if (req.method === 'GET' && req.url?.split('?')[0] === '/api/webhook-sync/status') {
      sendJson(res, 200, { ok: true, ...readWebhookSyncStatus(WEBHOOK_SYNC_PATHS) })
      return
    }
    if (req.method === 'POST' && req.url?.split('?')[0] === '/api/webhook-sync') {
      const result = await synchronizeWorkerEvents({
        mutateItems: (mutator) => updateItemsAtomic(mutator),
        paths: WEBHOOK_SYNC_PATHS,
      })
      sendJson(res, result.ok ? 200 : 502, result)
      return
    }
    // ---- Zoho IMAP reply recovery (read-only; no flags, attachments, sends, or background loop) ----
    if (req.method === 'GET' && req.url?.split('?')[0] === '/api/zoho-replies/status') {
      sendJson(res, 200, { ok: true, ...zohoSyncStatus() })
      return
    }
    if (req.method === 'POST' && req.url?.split('?')[0] === '/api/zoho-replies/manual') {
      const auth = authorizeFormalMutation(req, res)
      if (!auth) return
      const rawContent = String(body.rawContent || '').trim()
      if (rawContent.length < 20 || rawContent.length > 100_000) {
        sendJson(res, 400, { ok: false, code: 'FORMAL_RECOVERY_CONTENT_INVALID', message: 'Content too short or too long' })
        return
      }
      const message = parseManualZohoMessage(rawContent)
      const queueSnapshot = readFormalSendQueue()
      let result: ReturnType<typeof applyZohoMessages>
      updateItemsAtomic(latest => {
        result = applyZohoMessages(latest, [message], {
          processedMessageIds: [],
          now: new Date().toISOString(),
          formalQueueRecords: structuredClone(queueSnapshot.records),
          source: 'zoho_imap_manual',
        })
        return result.items
      }, ITEMS_STORE_FILE, new Date(), { refreshOnlyMutated: true })
      if (message.bouncedEmail) {
        registerBounceIsolation({
          email: message.bouncedEmail,
          reason: 'hard_bounce',
          customerId: '',
          sourceStage: 'formal_recovery',
          note: 'Zoho manual recovery reported a bounce.',
        })
      }
      if (result!.stats.unmatched > 0) {
        sendJson(res, 422, {
          ok: false,
          code: 'FORMAL_RECOVERY_UNMATCHED',
          message: 'Could not match by messageId, customer email, or formal send record.',
          parsed: { bouncedEmail: message.bouncedEmail, bounceCode: message.bounceCode, bounceType: message.bounceType },
        })
        return
      }
      const changedRecords = new Map((result!.formalQueueRecords || []).map(record => [record.id, record]))
      await mutateFormalSendQueue(current => {
        current.records = current.records.map(record => changedRecords.get(record.id) || record)
        return current
      })
      sendJson(res, 200, {
        ok: true,
        stats: result!.stats,
        parsed: {
          classification: message.bouncedEmail ? 'bounce' : 'reply',
          bouncedEmail: message.bouncedEmail,
          bounceCode: message.bounceCode,
          bounceType: message.bounceType,
          bounceReason: message.bounceReason,
        },
      })
      return
    }

    if (req.method === 'POST' && req.url?.split('?')[0] === '/api/zoho-replies/sync') {
      if (!imapConfigured() || userConfig.allowImapRecovery !== true) {
        sendJson(res, 409, { ok: false, code: 'IMAP_NOT_CONFIGURED' })
        return
      }
      if (zohoSyncRunning) {
        sendJson(res, 409, { ok: false, code: 'IMAP_SYNC_IN_PROGRESS' })
        return
      }
      zohoSyncRunning = true
      try {
        const result = await syncZohoInboxOnce(Number(body.limit || 50))
        sendJson(res, 200, { ok: true, ...result })
      } catch {
        sendJson(res, 502, { ok: false, code: 'IMAP_SYNC_FAILED' })
      } finally {
        zohoSyncRunning = false
      }
      return
    }

    // ---- POST /api/smtp-handshake (mock only; real connection disabled) ----
    

    // ---- POST /api/smtp-handshake/end ----
    // ---- GET /api/config (safe summary; never returns secrets) ----
    if (req.method === 'GET' && req.url?.split('?')[0] === '/api/config') {
      const providers = [
        { provider: 'serper', configured: loadSerperApiKeys().length > 0, enabled: loadSerperApiKeys().length > 0 },
        { provider: 'justserp', configured: normalizeJustSerpKeys(userConfig).length > 0, enabled: normalizeJustSerpKeys(userConfig).length > 0 },
        { provider: 'brave', configured: Boolean(userConfig.braveApiKey), enabled: Boolean(userConfig.braveApiKey) },
        { provider: 'apify', configured: Boolean(userConfig.apifyApiKey), enabled: Boolean(userConfig.apifyApiKey) },
        { provider: 'hunter', configured: Boolean(userConfig.hunterApiKey), enabled: Boolean(userConfig.hunterApiKey) },
        { provider: 'prospeo', configured: Boolean(userConfig.prospeoApiKey), enabled: Boolean(userConfig.prospeoApiKey) },
        { provider: 'resend', configured: Boolean(userConfig.resendApiKey), enabled: false },
        { provider: 'snovio', configured: Boolean(userConfig.snovioUserId && userConfig.snovioSecret), enabled: false },
        { provider: 'llm', configured: Boolean(userConfig.llmApiKey), enabled: Boolean(userConfig.llmApiKey) },
      ]
      sendJson(res, 200, {
        providers,
        mail: {
          provider: 'zoho',
        },
      })
      return
    }

    if (req.method === 'GET' && req.url?.split('?')[0] === '/api/business-profiles') {
      sendJson(res, 200, { profiles: loadProfiles(), active: userConfig.activeProfile || 'furniture' })
      return
    }
    if (req.method === 'POST' && req.url?.split('?')[0] === '/api/business-profiles') {
      const { profiles, active } = body as { profiles?: BusinessProfile[], active?: string }
      if (profiles) saveProfiles(profiles)
      if (active) {
        userConfig.activeProfile = active
        writeFileSync(CONFIG_FILE, JSON.stringify(userConfig, null, 2), 'utf-8')
      }
      sendJson(res, 200, { ok: true })
      return
    }

    // ---- GET /api/items/summary (精简列表；gzip 缓存；只读) ----
    if (req.method === 'GET' && req.url?.split('?')[0] === '/api/items/summary') {
      const tReq = Date.now()
      try {
        const { plain, gzip } = getMainSummary()
        const acceptsGzip = /gzip/.test(String(req.headers['accept-encoding'] || ''))
        if (acceptsGzip) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding' })
          res.end(gzip)
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(plain)
        }
        if (Date.now() - tReq > 1000) console.error(`[summary-req] ${new Date().toISOString()} SLOW ${Date.now() - tReq}ms`)
      } catch {
        sendJson(res, 200, [])
      }
      return
    }

    // ---- GET /api/items/scored ----
    if (req.method === 'GET' && req.url?.startsWith('/api/items/scored')) {
      const items = loadMainItems()
      sendJson(res, 200, items.filter((i: any) => i.leadGrade && i.leadGrade !== 'D'))
      return
    }

    // ---- GET /api/items/:id (单条完整数据；详情页按需；只读) ----
    if (req.method === 'GET' && /^\/api\/items\/[^/]+$/.test(req.url?.split('?')[0] || '')) {
      const id = decodeURIComponent((req.url?.split('?')[0] || '').split('/').pop() || '')
      try {
        const item = findMainItemById(id)
        if (!item) {
          sendJson(res, 404, { ok: false, code: 'ITEM_NOT_FOUND' })
          return
        }
        sendJson(res, 200, item)
      } catch {
        sendJson(res, 404, { ok: false, code: 'ITEM_NOT_FOUND' })
      }
      return
    }

    // ---- GET /api/items (full item list; read-only) ----
    if (req.method === 'GET' && req.url?.split('?')[0] === '/api/items') {
      try {
        const payload = serializeMainItems()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(payload)
      } catch {
        sendJson(res, 200, [])
      }
      return
    }

    // ---- GET /api/dashboard-stats (total instant from cached array; stageCounts served from background cache) ----
    if (req.method === 'GET' && req.url?.split('?')[0] === '/api/dashboard-stats') {
      try {
        const items = loadMainItems()
        scheduleDashboardStageCounts()
        sendJson(res, 200, { total: items.length, stageCounts: dashboardStageCounts.counts })
      } catch (dashboardStatsError: any) {
        sendJson(res, 500, { ok: false, code: 'DASHBOARD_STATS_FAILED', error: String(dashboardStatsError?.message || 'dashboard_stats_failed') })
      }
      return
    }

    // ---- GET /api/stats ----
    if (req.method === 'GET' && req.url?.startsWith('/api/stats')) {
      try {
        const items = loadMainItems()
        const hasEmail = items.filter((i: any) => i.email || i.contacts?.some((c: any) => c.email)).length
        const hasContact = items.filter((i: any) => i.contactName || i.contacts?.length || i.email).length
        const sent = items.filter((i: any) => i.developmentStatus === 'sent' || emailLogsOf(i).some((log: any) => ['sent', 'opened', 'bounced'].includes(log.status || log.result))).length
        const replied = items.filter((i: any) => i.developmentStatus === 'replied' || emailLogsOf(i).some((log: any) => (log.status || log.result) === 'replied')).length
        sendJson(res, 200, { total: items.length, hasEmail, hasContact, sent, replied })
      } catch (statsError: any) {
        sendJson(res, 200, { total: 0, hasEmail: 0, hasContact: 0, sent: 0, replied: 0, error: String(statsError?.message || 'stats_failed') })
      }
      return
    }

    // ---- GET /api/pipeline-stats ----
    if (req.method === 'GET' && req.url?.startsWith('/api/pipeline-stats')) {
      try {
        const items = loadMainItems()
        const byStage: Record<string, number> = {}
        const byGrade: Record<string, number> = { S: 0, A: 0, B: 0, C: 0, D: 0 }
        for (const item of items) {
          byStage[item.currentStageId || 'unknown'] = (byStage[item.currentStageId || 'unknown'] || 0) + 1
          byGrade[item.leadGrade || 'D'] = (byGrade[item.leadGrade || 'D'] || 0) + 1
        }
        sendJson(res, 200, { total: items.length, byStage, byGrade })
      } catch (pipelineError: any) {
        sendJson(res, 200, { total: 0, byStage: {}, byGrade: { S: 0, A: 0, B: 0, C: 0, D: 0 }, error: String(pipelineError?.message || 'pipeline_stats_failed') })
      }
      return
    }

    // ---- GET /api/email-stats ----
    if (req.method === 'GET' && req.url?.startsWith('/api/email-stats')) {
      try {
        const items = loadMainItems()
        const withEmail = items.filter((i: any) => i.email && i.status === 'active')
        const sent = withEmail.filter((i: any) => i.developmentStatus === 'sent')
        const replied = withEmail.filter((i: any) => i.developmentStatus === 'replied')
        const bounced = withEmail.filter((i: any) => i.emailBounced)
        sendJson(res, 200, {
          total: withEmail.length,
          sent: sent.length,
          replied: replied.length,
          bounced: bounced.length,
          replyRate: sent.length > 0 ? `${Math.round((replied.length / sent.length) * 100)}%` : '0%',
        })
      } catch {
        sendJson(res, 200, { total: 0, sent: 0, replied: 0, bounced: 0, replyRate: '0%' })
      }
      return
    }

    // ---- GET /api/items ----
    if (req.method === 'GET' && req.url?.split('?')[0] === '/api/scheduler/state') {
      const state = getSchedulerState()
      const pendingLeads = (() => {
        try {
          const fp = join(__dirname, '..', 'data', 'leads.json')
          if (!existsSync(fp)) return 0
          const leads = JSON.parse(readFileSync(fp, 'utf-8'))
                return leads.filter((l: any) =>
          l.website && (!l.email || !l.email.includes('@')))
        } catch { return 0 }
      })()
      if (pendingLeads > 0) {
        state.pendingLeads = pendingLeads
      }
      sendJson(res, 200, state)
      return
    }

    const lateGetPath = (req.method === 'GET') && (req.url?.startsWith('/api/followup/check') || req.url?.startsWith('/api/email-stats'))
    if (req.method !== 'POST' && !lateGetPath) {
      sendJson(res, 404, { error: 'not found' })
      return
    }
    if (req.method === 'POST' && req.url?.split('?')[0] === '/api/search') {
      const { product, queries, excludeUrls, channel, searchType, country } = body as {
        product?: string
        queries?: string[]
        excludeUrls?: string[]
        channel?: string
        searchType?: string
        country?: string
      }
      if (!product) {
        sendJson(res, 400, {
          ok: false,
          errorCode: 'INVALID_SEARCH_REQUEST',
          message: 'Missing search product or industry parameter',
          provider: 'none',
          safeMode: false,
          blocked: false,
          details: {},
        })
        return
      }
      const configuredProviders = [
        normalizeJustSerpKeys(userConfig).length > 0 && 'JustSerp',
        loadSerperApiKeys().length > 0 && 'Serper',
        loadBraveApiKey() && 'Brave',
      ].filter(Boolean) as string[]
      if (!['gleif', 'wikidata'].includes(channel || '') && configuredProviders.length === 0) {
        sendJson(res, 503, {
          ok: false,
          errorCode: 'SEARCH_NOT_CONFIGURED',
          message: 'Search service is not configured',
          provider: 'none',
          safeMode: false,
          blocked: false,
          details: { configuredProviders: [] },
        })
        return
      }
      const result = await handleSearch(product, queries, excludeUrls, channel || 'serper', searchType || 'web', country || 'US')
      if (result.channel === 'none' && result.errors.length > 0) {
        sendJson(res, 502, {
          ok: false,
          errorCode: 'SEARCH_PROVIDER_FAILED',
          message: 'garbled text',
          provider: configuredProviders.join(' -> '),
          safeMode: false,
          blocked: false,
          details: { attemptedProviders: configuredProviders, failureCount: result.errors.length },
        })
        return
      }
      sendJson(res, 200, {
        ok: true,
        errorCode: null,
        message: result.results.length > 0 ? 'Search completed' : 'Search completed, but no results found',
        provider: result.channel,
        safeMode: false,
        blocked: false,
        details: { failedQueries: result.failed },
        ...result,
      })
      return
    }

    // ---- POST /api/snovio/batch闂佹寧绋戦悧濠冪珶閹烘鐓?Snovio 闂佺硶鏅濋崰搴ㄥ箖閺囥垹绠规繝濠傛噹閸嬪秹鏌?----
    if (req.url?.startsWith('/api/snovio/batch')) {
      const { limit = 10 } = body as { limit?: number }
      const fp = join(__dirname, '..', 'items_store.json')
      let items: any[] = []
      try {
        if (existsSync(fp)) {
          const data = JSON.parse(readFileSync(fp, 'utf-8'))
          if (Array.isArray(data)) items = data
        }
      } catch (_e) {}
      // 闂佹悶鍎抽崑銈夊焵椤戣棄浜鹃梺?backup
      if (items.length === 0) {
        const backupFp = join(__dirname, '..', 'items_store_backup.json')
        try {
          if (existsSync(backupFp)) {
            const data = JSON.parse(readFileSync(backupFp, 'utf-8'))
            if (Array.isArray(data)) items = data
          }
        } catch (_e) {}
      }
      const targets = items.filter((i: any) => i.website && (!i.email || !i.email.includes('@')) && (!i.contacts || i.contacts.length === 0)).slice(0, limit)
      sendJson(res, 200, { processed: targets.length, results: targets.map((t: any) => ({ id: t.id, company: t.company || t.title, status: 'pending', contacts: 0 })) })
      return
    }

    // ---- GET /api/followup/check闂佹寧绋戦悧鎰玻閳╁啯浜ゆ繛鎴炵懐濮婇箖鏌＄仦璇插姷缂?----
    if (req.method === 'GET' && req.url?.startsWith('/api/followup/check')) {
      const items = loadMainItems()
      const now = Date.now()
      const needsFollowup = items.filter((i: any) => {
        if (i.status !== 'contacted' && i.developmentStatus !== 'sent') return false
        const logs = i.emailLogs || i.emailLog || []
        if (logs.length === 0) return false
        const last = logs[logs.length - 1]
        if (last.status === 'replied' || last.result === 'replied') return false
        const lastTime = new Date(last.date || last.sentAt || 0).getTime()
        const days = Math.floor((now - lastTime) / (24 * 60 * 60 * 1000))
        return days >= 3 && logs.length < 4
      }).map((i: any) => ({
        id: i.id,
        company: i.company || i.title,
        email: i.email || i.contacts?.[0]?.email || '',
        daysSince: 3,
        followupCount: (i.emailLogs || i.emailLog || []).length,
        nextAction: 'Day 3 follow-up review',
      }))
      sendJson(res, 200, { count: needsFollowup.length, leads: needsFollowup })
      return
    }

    // ---- POST /api/firecrawl-extract ----
    if (req.url?.startsWith('/api/firecrawl-extract')) {
      const { url, prompt } = body as { url?: string; prompt?: string }
      if (!url && !snippet && !company) {
        sendJson(res, 400, { error: 'missing url, snippet, or company' })
        return
      }
      const result = await handleFirecrawlExtract(url, prompt || BACKCHECK_PROMPT)
      sendJson(res, 200, result)
      return
    }

    // ---- POST /api/llm-backcheck闂佹寧绋戝﹢姊歳ecrawl 婵炴垶鎸哥粔褰掑焵椤掍胶顣叉俊鐐插€块幆鍐礋椤旂厧澹掗柣?fallback闂?----
    if (req.url?.startsWith('/api/llm-backcheck')) {
      const { url, snippet, title, company, country, businessLine } = body as {
        url?: string; snippet?: string; title?: string
        company?: string; country?: string; businessLine?: string
      }
      if (!url && !snippet && !company) {
        sendJson(res, 400, { error: 'missing url, snippet, or company' })
        return
      }
      const result = await handleLlamaBackcheck(url, snippet, title, company, country, businessLine)
      sendJson(res, 200, result)
      return
    }

        // ---- POST /api/crawl4ai-backcheck (default: fetch+cheerio, fallback: engine=crawl4ai) ----
    if (req.url?.startsWith('/api/crawl4ai-backcheck')) {
      const { url: crawlUrl, companyName, country, snippet, businessLine, engine } = body as {
        url?: string
        companyName?: string
        country?: string
        snippet?: string
        businessLine?: string
        engine?: string
      }
      if (!crawlUrl && !companyName) {
        sendJson(res, 400, { error: 'missing url or companyName' })
        return
      }

      // 背调前侦查：先判断普通 HTTP 是否足够，动态页面自动切换浏览器；
      // 验证码/登录墙只停在 HUMAN_REQUIRED，不通过重试或并发硬撞。
      const preflight: BackcheckPreflightPlan | undefined = crawlUrl
        ? await runBackcheckPreflight(crawlUrl)
        : undefined
      if (preflight && ['HUMAN_REQUIRED', 'LOW_VALUE', 'BLOCKED'].includes(preflight.accessStatus)) {
        sendJson(res, 200, {
          success: false,
          provider: 'preflight',
          fetchedUrl: preflight.finalUrl,
          preflight,
          error: preflight.accessStatus === 'HUMAN_REQUIRED'
            ? '网站需要登录/验证码/本人确认，已停止自动化'
            : '网站当前不可稳定采集，已跳过深度背调',
          failureReason: preflight.evidence.join('; ') || preflight.accessStatus,
        })
        return
      }

      const selectedEngine = engine || (preflight?.renderMode === 'browser' ? 'crawl4ai' : undefined)

      // ---- 旧引擎(crawl4ai_backcheck.py Playwright) 仅在 engine=crawl4ai 时启用 ----
      if (selectedEngine === 'crawl4ai' || process.env.FORCE_CRAWL4AI === '1') {
        try {
          let actualUrl = crawlUrl
          const request = crawlUrl ? { url: crawlUrl } : { company: companyName, country, business: businessLine }
          const { stdout, stderr } = await runBundledCrawl(request)
          if (stderr && !stdout) {
            sendJson(res, 500, { error: `crawl4ai error: ${stderr.slice(0, 500)}` })
            return
          }
          const parsed = JSON.parse(stdout.trim())

          if (!crawlUrl && parsed.success === false) {
            sendJson(res, 200, {
              success: false,
              stage: parsed.stage || 'company-search',
              error: parsed.error || 'unknown error',
              candidates: parsed.candidates || [],
            })
            return
          }

          if (parsed.success && parsed.markdown) {
            if (!actualUrl && parsed.companySearch?.resolvedUrl) {
              actualUrl = parsed.companySearch.resolvedUrl
            }
            const llmResult = await handleLlamaBackcheck(
              actualUrl || '(unknown)',
              parsed.markdown.slice(0, 5000),
              parsed.title || '',
            )
            sendJson(res, 200, {
              success: true,
              provider: 'crawl4ai',
              fetchedUrl: actualUrl,
              textLength: parsed.wordCount || 0,
              crawl: { title: parsed.title, wordCount: parsed.wordCount },
              data: llmResult.data || null,
              error: llmResult.error || null,
              source: parsed.source || 'website',
              companySearch: parsed.companySearch || null,
              preflight: preflight || null,
              failureReason: llmResult.success ? null : (llmResult.error || 'LLM extract failed'),
            })
          } else {
            sendJson(res, 200, { success: false, provider: 'crawl4ai', preflight: preflight || null, error: parsed.error || 'empty crawl result', failureReason: parsed.error || 'empty crawl result' })
          }
        } catch (err: any) {
          sendJson(res, 500, { error: 'crawl4ai exception: ' + err.message, failureReason: err.message })
        }
        return
      }

      // ---- default: lightweight crawl (fetch + cheerio, 30s timeout) ----
      try {
        if (!crawlUrl) {
          sendJson(res, 200, { success: false, error: 'lightweight crawl needs a URL', provider: 'raw_fetch', stage: 'url-required' })
          return
        }

        // Keep the lightweight phase within the backcheck consumer's 75s total budget.
        // Two fetch attempts can consume roughly twice this timeout; the remaining time
        // is needed for the anti-bot fallback, LLM extraction, and language detection.
        const crawlResult = await handleLightweightCrawl(crawlUrl, 8000)
        if (!crawlResult.success) {
          sendJson(res, 200, {
            success: false,
            provider: 'raw_fetch',
            fetchedUrl: crawlUrl,
            preflight: preflight || null,
            error: crawlResult.error || 'crawl failed',
            failureReason: crawlResult.error || 'crawl failed',
          })
          return
        }

        const llmResult = await handleLlamaBackcheck(
          crawlUrl,
          crawlResult.markdown || '',
          crawlResult.title || '',
        )

        sendJson(res, 200, {
          success: llmResult.success,
          provider: 'raw_fetch',
          fetchedUrl: crawlUrl,
          preflight: preflight || null,
          textLength: crawlResult.wordCount || 0,
          visitedUrls: [crawlUrl],
          crawl: { title: crawlResult.title || '', wordCount: crawlResult.wordCount || 0 },
          data: llmResult.data || null,
          error: llmResult.error || null,
          source: 'website',
          failureReason: llmResult.success ? null : (llmResult.error || 'LLM extract failed'),
        })
      } catch (err: any) {
        sendJson(res, 500, {
          success: false,
          error: 'backcheck failed: ' + err.message,
          failureReason: err.message,
        })
      }
      return
    }

    // ---- POST /api/llm-classify ----
    if (req.url?.startsWith('/api/llm-classify')) {
      const { company, website, snippet, summary, products, markets } = body as {
        company?: string
        website?: string
        snippet?: string
        summary?: string
        products?: string[]
        markets?: string[]
      }
      const result = await handleLlmClassify({ company, website, snippet, summary, products, markets })
      sendJson(res, 200, result)
      return
    }

    // ---- POST /api/translate ----
    if (req.url?.startsWith('/api/translate')) {
      let text = '', target = 'zh'
      try {
        if (typeof body === 'object' && body !== null) {
          text = (body as any).text || ''
          target = (body as any).target || 'zh'
        } else if (typeof body === 'string') {
          const parsed = JSON.parse(body)
          text = parsed.text || ''
          target = parsed.target || 'zh'
        }
      } catch { text = ''; target = 'zh' }
      if (!text) { sendJson(res, 200, { original: '', translated: '' }); return }
      const translated = await handleTranslate(text, target)
      sendJson(res, 200, { original: text, translated })
      return
    }

    // ---- POST /api/snovio/get-token闂佹寧绋戦悧鎰扮嵁韫囨稑鐭?OAuth2 access_token闂?----
    if (req.url?.startsWith('/api/snovio/get-token')) {
      const userId = userConfig.snovioUserId || ''
      const secret = userConfig.snovioSecret || ''
      if (!userId || !secret) {
        sendJson(res, 400, { error: 'Snov.io userId/secret not configured' })
        return
      }
      try {
        const params = new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: userId,
          client_secret: secret,
        })
        const resp = await fetchWithRetry(
          'https://api.snov.io/v1/oauth/access_token',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString(),
            timeout: 15000,
          },
          2,
        )
        if (!resp.ok) {
          const errText = await resp.text().catch(() => '')
          sendJson(res, 500, { error: `Snov.io 闁荤姳闄嶉崐娑㈡儊婢跺绶為弶鍫亯琚? ${resp.status} ${errText}` })
          return
        }
        const data = await resp.json() as { access_token?: string }
        if (!data.access_token) {
          sendJson(res, 500, { error: 'Snov.io access token missing from response' })
          return
        }
        sendJson(res, 200, { access_token: data.access_token })
      } catch (err: any) {
        sendJson(res, 500, { error: `Snov.io request failed: ${err.message}` })
      }
      return
    }

    // ---- POST /api/snovio/domain-search/resume (poll saved task only) ----
    if (req.method === 'POST' && req.url?.split('?')[0] === '/api/snovio/domain-search/resume') {
      const { customerId } = body as { customerId?: string }
      if (!customerId) { sendJson(res, 400, { ok: false, code: 'CUSTOMER_ID_REQUIRED' }); return }
      const items = readJsonArray(ITEMS_FILE)
      const item = items.find((entry: any) => entry.id === customerId)
      if (!item) { sendJson(res, 404, { ok: false, code: 'CUSTOMER_NOT_FOUND' }); return }
      const resumable = getResumableTask(Array.isArray(item.snovioDomainSearchTasks) ? item.snovioDomainSearchTasks : [])
      if (!resumable.ok || !resumable.task) {
        sendJson(res, 409, {
          ok: false,
          code: 'NO_SAVED_SNOVIO_TASK_URL',
          message: 'No saved task URL is available; a new domain query was not started.',
        })
        return
      }

      const userId = userConfig.snovioUserId || ''
      const secret = userConfig.snovioSecret || ''
      if (!userId || !secret) { sendJson(res, 400, { ok: false, code: 'SNOVIO_NOT_CONFIGURED' }); return }
      const task = resumable.task
      try {
        const tokenParams = new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: userId,
          client_secret: secret,
        })
        const tokenResp = await fetchWithRetry('https://api.snov.io/v1/oauth/access_token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: tokenParams.toString(),
          timeout: 15000,
        }, 2)
        if (!tokenResp.ok) { sendJson(res, 502, { ok: false, code: 'SNOVIO_AUTH_FAILED' }); return }
        const tokenData = await tokenResp.json() as { access_token?: string }
        if (!tokenData.access_token) { sendJson(res, 502, { ok: false, code: 'SNOVIO_AUTH_FAILED' }); return }

        const resultResp = await fetchWithRetry(task.resultUrl || task.statusUrl || '', {
          method: 'GET',
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
          timeout: 30000,
        }, 1)
        task.lastPolledAt = new Date().toISOString()
        if (!resultResp.ok) {
          task.status = 'failed'
          updateOneItemAtomic(item.id, current => ({ ...current, snovioDomainSearchTasks: [...(Array.isArray(current.snovioDomainSearchTasks) ? current.snovioDomainSearchTasks : []).filter((entry: any) => entry.correlationId !== task.correlationId), task] }), ITEMS_STORE_FILE)
          sendJson(res, 502, { ok: false, code: 'SNOVIO_RESULT_FAILED', correlationId: task.correlationId })
          return
        }
        const resultData = await resultResp.json() as { data?: unknown; status?: string; meta?: Record<string, unknown> }
        if (resultData.status === 'processing' || resultData.status === 'in_progress') {
          updateOneItemAtomic(item.id, current => ({ ...current, snovioDomainSearchTasks: [...(Array.isArray(current.snovioDomainSearchTasks) ? current.snovioDomainSearchTasks : []).filter((entry: any) => entry.correlationId !== task.correlationId), task] }), ITEMS_STORE_FILE)
          sendJson(res, 202, {
            ok: true,
            status: 'in_progress',
            correlationId: task.correlationId,
            newDomainQueryStarted: false,
          })
          return
        }

        const rawDir = join(__dirname, '..', 'data', 'snovio_results')
        if (!existsSync(rawDir)) require('fs').mkdirSync(rawDir, { recursive: true })
        writeFileSync(
          join(rawDir, `${task.correlationId}.json`),
          JSON.stringify({ data: resultData.data || [], status: resultData.status || 'completed' }, null, 2),
          'utf-8',
        )
        task.status = 'completed'
        task.rawResultStored = true
        task.creditsUnknown = resultData.meta?.credits_spent === undefined

        const candidates = normalizeSnovioProviderData(resultData.data, task.domain)
        let merged = mergeSnovioCandidates(
          Array.isArray(item.contacts) ? item.contacts : [],
          candidates,
          item.id,
        )
        item.contacts = merged.contacts
        item.contactReplacementLog = [
          ...(Array.isArray(item.contactReplacementLog) ? item.contactReplacementLog : []),
          ...merged.replacements,
        ]
        item.emailVerificationEvidence = Array.isArray(item.emailVerificationEvidence)
          ? item.emailVerificationEvidence
          : []
        for (const contact of merged.contacts.filter((entry: any) => entry.source === 'snovio_found' && entry.email)) {
          const exists = item.emailVerificationEvidence.some((evidence: any) =>
            String(evidence.email || '').toLowerCase() === String(contact.email).toLowerCase()
            && evidence.result === 'snovio_found')
          if (!exists) {
            item.emailVerificationEvidence.push({
              email: contact.email,
              result: 'snovio_found',
              scope: 'specific_email',
              source: 'snovio',
              method: 'domain_search',
              checkedAt: task.lastPolledAt,
              correlationId: task.correlationId,
              note: 'garbled text',
            })
          }
        }
        updateOneItemAtomic(item.id, current => {
          merged = mergeSnovioCandidates(Array.isArray(current.contacts) ? current.contacts : [], candidates, current.id)
          const replacements = [...(Array.isArray(current.contactReplacementLog) ? current.contactReplacementLog : []), ...merged.replacements]
          const evidence = [...(Array.isArray(current.emailVerificationEvidence) ? current.emailVerificationEvidence : [])]
          for (const contact of merged.contacts.filter((entry: any) => entry.source === 'snovio_found' && entry.email)) {
            if (!evidence.some((entry: any) => String(entry.email || '').toLowerCase() === String(contact.email).toLowerCase() && entry.result === 'snovio_found')) evidence.push({ email: contact.email, result: 'snovio_found', scope: 'specific_email', source: 'snovio', method: 'domain_search', checkedAt: task.lastPolledAt, correlationId: task.correlationId, note: 'Snovio candidate; address not yet verified.' })
          }
          return { ...current, snovioDomainSearchTasks: [...(Array.isArray(current.snovioDomainSearchTasks) ? current.snovioDomainSearchTasks : []).filter((entry: any) => entry.correlationId !== task.correlationId), task], contacts: merged.contacts, contactReplacementLog: replacements, emailVerificationEvidence: evidence }
        }, ITEMS_STORE_FILE)
        sendJson(res, 200, {
          ok: true,
          status: 'completed',
          correlationId: task.correlationId,
          newDomainQueryStarted: false,
          returnedCandidates: candidates.length,
          added: merged.added,
          completed: merged.completed,
          replaced: merged.replacements.length,
          retained: merged.contacts.length,
          discarded: merged.discarded.map(entry => ({ reason: entry.reason })),
          dnsCandidates: merged.contacts
            .filter((entry: any) => entry.email)
            .map((entry: any) => maskEmailAddress(entry.email)),
          customerStageModified: false,
        })
      } catch (error: any) {
        sendJson(res, 500, {
          ok: false,
          code: 'SNOVIO_RESUME_FAILED',
          message: String(error?.message || error),
          correlationId: task.correlationId,
        })
      }
      return
    }

    // ---- POST /api/snovio/domain-search (start and persist asynchronous task) ----
    if (req.method === 'POST' && req.url?.split('?')[0] === '/api/snovio/domain-search') {
      const { domain, customerId } = body as { domain?: string; customerId?: string }
      if (!domain || !customerId) {
        sendJson(res, 400, { ok: false, code: 'DOMAIN_AND_CUSTOMER_REQUIRED' })
        return
      }
      const items = readJsonArray(ITEMS_FILE)
      const item = items.find((entry: any) => entry.id === customerId)
      if (!item) { sendJson(res, 404, { ok: false, code: 'CUSTOMER_NOT_FOUND' }); return }
      if (item.reviewDisposition !== 'active' || !item.reviewUpdatedAt || item.doNotDevelop) {
        sendJson(res, 423, { ok: false, code: 'BACKCHECK_NOT_APPROVED' })
        return
      }
      const userId = userConfig.snovioUserId || ''
      const secret = userConfig.snovioSecret || ''
      if (!userId || !secret) { sendJson(res, 400, { ok: false, code: 'SNOVIO_NOT_CONFIGURED' }); return }
      try {
        const tokenParams = new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: userId,
          client_secret: secret,
        })
        const tokenResp = await fetchWithRetry('https://api.snov.io/v1/oauth/access_token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: tokenParams.toString(),
          timeout: 15000,
        }, 2)
        if (!tokenResp.ok) { sendJson(res, 502, { ok: false, code: 'SNOVIO_AUTH_FAILED' }); return }
        const tokenData = await tokenResp.json() as { access_token?: string }
        if (!tokenData.access_token) { sendJson(res, 502, { ok: false, code: 'SNOVIO_AUTH_FAILED' }); return }

        const startResp = await fetchWithRetry('https://api.snov.io/v2/domain-search/domain-emails/start', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: `domain=${encodeURIComponent(domain)}`,
          timeout: 30000,
        }, 1)
        if (!startResp.ok) { sendJson(res, 502, { ok: false, code: 'SNOVIO_QUERY_FAILED' }); return }
        const startData = await startResp.json() as {
          links?: { result?: string; status?: string }
          meta?: { task_hash?: string }
          taskId?: string
        }
        const resultUrl = startData.links?.result
        const statusUrl = startData.links?.status
        if (!resultUrl && !statusUrl) {
          sendJson(res, 502, { ok: false, code: 'SNOVIO_TASK_URL_MISSING' })
          return
        }
        const task = createSnovioTask({
          customerId,
          domain,
          taskId: startData.taskId || startData.meta?.task_hash,
          statusUrl,
          resultUrl,
        })
        updateOneItemAtomic(customerId, current => {
          const existingTasks = Array.isArray(current.snovioDomainSearchTasks) ? current.snovioDomainSearchTasks : []
          return existingTasks.some((entry: any) => entry.correlationId === task.correlationId)
            ? current
            : { ...current, snovioDomainSearchTasks: [...existingTasks, task] }
        }, ITEMS_STORE_FILE)
        sendJson(res, 202, {
          ok: true,
          status: task.status,
          taskId: task.taskId,
          correlationId: task.correlationId,
          rawResultStored: false,
          creditsUnknown: true,
        })
      } catch (error: any) {
        sendJson(res, 500, { ok: false, code: 'SNOVIO_QUERY_FAILED', message: String(error?.message || error) })
      }
      return
    }

    // ---- POST /api/snovio/email-finder闂佹寧绋戦悧濠勨偓鍨矋閹便劑骞橀搹顐⑩偓?闂佺硶鏅濋崰搴ㄥ箖閺囥垹绠ュΔ锝呭暙娴犲繒绱掗悩鍐叉暰缂?----
    if (req.url?.startsWith('/api/snovio/email-finder')) {
      const { domain: d2, firstName, lastName, name } = body as { domain?: string; firstName?: string; lastName?: string; name?: string }
      if (!d2) { sendJson(res, 400, { error: 'Missing domain parameter' }); return }
      const userId = userConfig.snovioUserId || ''
      const secret = userConfig.snovioSecret || ''
      if (!userId || !secret) { sendJson(res, 400, { error: 'Snov.io not configured' }); return }
      try {
        const tokenParams = new URLSearchParams({ grant_type: 'client_credentials', client_id: userId, client_secret: secret })
        const tokenResp = await fetchWithRetry('https://api.snov.io/v1/oauth/access_token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: tokenParams.toString(),
          timeout: 15000,
        }, 2)
        if (!tokenResp.ok) { sendJson(res, 500, { error: 'Snov.io auth failed' }); return }
        const tokenData = await tokenResp.json() as { access_token?: string }
        const token = tokenData.access_token
        if (!token) { sendJson(res, 500, { error: '闂?access_token' }); return }
        // 闁荤喐鐟辩徊楣冩倵閼恒儲鍙忛柟鎹愭珪閸?        let fn = firstName || ''
        let ln = lastName || ''
        if (!fn && name) {
          const parts = name.trim().split(/\s+/)
          fn = parts[0] || ''
          ln = parts.slice(1).join(' ') || ''
        }
        const params = new URLSearchParams({ domain: d2, first_name: fn, last_name: ln, type: 'personal' })
        const findResp = await fetchWithRetry(
          `https://api.snov.io/v2/emails/find?${params.toString()}`,
          {
            method: 'GET',
            headers: { Authorization: `Bearer ${token}` },
            timeout: 30000,
          },
          2,
        )
        if (!findResp.ok) {
          const errText = await findResp.text().catch(() => '')
          sendJson(res, 500, { error: `Snov.io 闂佸搫琚崕鍙夌珶濡绶為弶鍫亯琚? ${findResp.status} ${errText}` })
          return
        }
        const findData = await findResp.json() as { data?: any }
        sendJson(res, 200, { email: findData.data?.email || '', sources: findData.data?.sources || [] })
      } catch (err: any) {
        sendJson(res, 500, { error: `Snov.io request failed: ${err.message}` })
      }
      return
    }

    // ---- POST /api/snovio/verify-email闂佹寧绋戦悧鎾绘偘濞嗘垶瀚氬〒姘ｅ亾闁稿鐗滅划缁樻綇閵婏妇鐣抽梺杞扮閻楀﹪鍩€椤戭剙绉剁粈?----
    

    // ---- POST /api/verify-email-dns (multi-source DNS-only; never sends mail) ----
    

    // ---- POST /api/batch-dns-check ----
    

    // ---- POST /api/batch-test-send (disabled until separately authorized) ----
    


    // ---- POST /api/test-mail-recovery/sync (manual trigger; no scheduler) ----
    

    // ---- POST /api/check-email-status闂佹寧绋戦悧濠囁夐崨鏉戣摕闁靛绠戠紞鎴︽煙闂堟侗鍎庡ǎ鍥э躬楠炲酣寮撮埗鈺佷壕闁圭儤鏌ㄧ瑧闂佽鍏涚欢銈囨?----
    

    if (req.method === 'POST' && req.url?.split('?')[0] === '/api/scheduler/config') {
      const { dailyLimit, intervalMinutes } = body as { dailyLimit?: number; intervalMinutes?: number }
      updateSchedulerConfig({ dailyLimit, intervalMinutes })
      sendJson(res, 200, { ok: true })
      return
    }

    // ---- POST /api/config ----
    if (req.url?.startsWith('/api/config')) {
      const { serperApiKey, serperApiKey2, braveApiKey, justserpApiKey, justserpApiKey2, apifyApiKey, hunterApiKey, prospeoApiKey, resendApiKey, snovioUserId, snovioSecret, businessEmails } = body as Record<string, any>
      const modelFields = ['llmApiKey', 'llmBaseUrl', 'llmModel',
        'llmBackupBaseUrl', 'llmBackupApiKey', 'llmBackupModel'] as const
      for (const field of modelFields) {
        if (body[field] !== undefined && typeof body[field] !== 'string') {
          sendJson(res, 400, { error: 'MODEL_SETTING_INVALID', field })
          return
        }
      }
      try {
        for (const field of ['llmBaseUrl', 'llmBackupBaseUrl'] as const) {
          if (typeof body[field] === 'string') body[field] = normalizeLlmBaseUrl(body[field].trim())
        }
      } catch {
        sendJson(res, 400, { error: 'LLM_BASE_URL_INVALID' })
        return
      }
      userConfig = { ...userConfig }
      for (const field of modelFields) {
        if (typeof body[field] === 'string') (userConfig as Record<string, unknown>)[field] = body[field].trim()
      }
      if (typeof body.llmBackupEnabled === 'boolean') {
        (userConfig as Record<string, unknown>).llmBackupEnabled = body.llmBackupEnabled
      }
      if (serperApiKey !== undefined) userConfig.serperApiKey = serperApiKey
      if (serperApiKey2 !== undefined) userConfig.serperApiKey2 = serperApiKey2
      if (serperApiKey !== undefined || serperApiKey2 !== undefined) resetSerperKeyPool()
      if (braveApiKey !== undefined && braveApiKey !== '') userConfig.braveApiKey = braveApiKey
      if (justserpApiKey !== undefined) userConfig.justserpApiKey = justserpApiKey
      if (justserpApiKey2 !== undefined) userConfig.justserpApiKey2 = justserpApiKey2
      if (justserpApiKey !== undefined || justserpApiKey2 !== undefined) resetJustSerpKeyPool()
      if (apifyApiKey !== undefined) userConfig.apifyApiKey = apifyApiKey
      if (hunterApiKey !== undefined) userConfig.hunterApiKey = hunterApiKey
      if (prospeoApiKey !== undefined && prospeoApiKey !== '') userConfig.prospeoApiKey = prospeoApiKey
      if (resendApiKey !== undefined) userConfig.resendApiKey = resendApiKey
      if (snovioUserId !== undefined) userConfig.snovioUserId = snovioUserId
      if (snovioSecret !== undefined) userConfig.snovioSecret = snovioSecret
      if (typeof body.companyName === 'string') userConfig.companyName = body.companyName.trim()
      if (typeof body.zohoEmail === 'string') {
        const next = body.zohoEmail.trim().toLowerCase()
        if (next !== userConfig.zohoEmail) userConfig.zohoPassword = ''
        userConfig.zohoEmail = next
      }
      if (body.zohoPassword !== undefined && body.zohoPassword !== '') userConfig.zohoPassword = body.zohoPassword as string
      if (businessEmails && typeof businessEmails === 'object') {
        userConfig.businessEmails = { ...userConfig.businessEmails, ...businessEmails }
      }
      const mailIsolationFields = [
        'primaryBusinessEmail', 'isolatedTestEmail',
        'smtpHost', 'smtpPort', 'smtpSecure',
        'imapHost', 'imapPort', 'imapSecure',
        'returnPathEmail', 'replyToEmail', 'forwardToEmail',
        'allowIsolatedTestMail', 'allowSmtpHandshake', 'allowImapRecovery',
      ] as const
      for (const field of mailIsolationFields) {
        if (body[field] !== undefined) (userConfig as unknown as Record<string, unknown>)[field] = body[field]
      }
      writeFileSync(CONFIG_FILE, JSON.stringify(userConfig, null, 2), 'utf-8')
      configureOutreachIdentity(userConfig)
      sendJson(res, 200, { ok: true })
      return
    }

    // Legacy endpoint is disabled because it accepted IMAP credentials in the request body.
    if (req.url?.split('?')[0] === '/api/check-replies') {
      sendJson(res, 410, { ok: false, code: 'LEGACY_IMAP_ENDPOINT_DISABLED', message: 'Use /api/zoho-replies/sync.' })
      return
    }

    sendJson(res, 404, { error: 'not found' })
  } catch (err: unknown) {
    const code = err instanceof Error ? err.message : 'INTERNAL_SERVER_ERROR'
    if (code === 'REQUEST_BODY_TOO_LARGE') sendJson(res, 413, { ok: false, code })
    else if (code === 'MALFORMED_JSON') sendJson(res, 400, { ok: false, code })
    else {
      console.error(`[ERROR] ${new Date().toISOString()} ${req.method} ${req.url}: internal failure`)
      sendJson(res, 500, { ok: false, code: 'INTERNAL_SERVER_ERROR' })
    }
  }
})

// ---- Initial isolation registration (one-time) + unified background scheduler startup ----
if (backgroundEnabled) {
  const initialIsolationResult = registerExcludedInitial()
  if (initialIsolationResult.registered > 0) console.log(`[isolation] initial true_excluded registration: +${initialIsolationResult.registered} entries`)
  else if (initialIsolationResult.alreadyRegistered) console.log('[isolation] initial true_excluded registration already done, skipped')
  else if (initialIsolationResult.error) console.warn(`[isolation] initial registration failed: ${initialIsolationResult.error}`)
}
backgroundStartedAt = new Date().toISOString()
if (backgroundEnabled) {
  setInterval(() => { backgroundTick().catch(error => console.error(`[background] tick uncaught: ${String(error?.message || error)}`)) }, BACKGROUND_TICK_MS)
  console.log(`[background] unified scheduler started (tick=${BACKGROUND_TICK_MS}ms, zoho sync interval=${ZOHO_SYNC_INTERVAL_MS}ms, formal reply interval=${FORMAL_REPLY_SYNC_INTERVAL_MS}ms)`)
  backgroundTick().catch(error => console.error(`[background] initial tick uncaught: ${String(error?.message || error)}`))
} else {
  lastTickAt = backgroundStartedAt
  lastTickStats = { disabled: true }
  console.log('[background] disabled for offline verification')
}
console.log(`[pipeline] auto-loop enabled: ${pipelineAutoEnabled} | formal-send: per-message eligibility and quota`)

server.listen(PORT, '127.0.0.1', () => {
  console.log(`
  MMUSEOPS API started: http://localhost:${PORT}`)
  console.log(`  API: http://localhost:${PORT}/api`)
  console.log(`  Frontend: ${DIST_DIR}`)
  console.log(`  Dist exists: ${existsSync(DIST_DIR)}`)
  console.log(`  Index exists: ${existsSync(join(DIST_DIR, 'index.html'))}`)
  // Pre-warm dashboard cache in background so first workbench load is instant
  setTimeout(() => { refreshDashboardCache().catch(error => console.error('[dashboard] warm-up failed', error)) }, 500)
  // Pre-warm dashboard-stats stage counts (warms loadMainItems cache + kicks off background stage compute)
  setTimeout(() => { try { loadMainItems(); scheduleDashboardStageCounts() } catch (error) { console.error('[dashboard-stats] warm-up failed', String(error instanceof Error ? error.message : error)) } }, 700)
  // Pre-warm /api/items/summary 缓存：首次前端打开不再现场构建 223MB 摘要（gzipSync 数百 ms + 一次 loadMainItems）
  setTimeout(() => { try { getMainSummary() } catch (error) { console.error('[summary] warm-up failed', String(error instanceof Error ? error.message : error)) } }, 2500)
})






