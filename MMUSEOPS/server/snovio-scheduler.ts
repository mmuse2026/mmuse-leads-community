/**
 * Snovio 自动化调度器
 * - 每日限额控制（默认100个）
 * - 循环执行（5-10分钟随机间隔）
 * - 状态管理（运行/暂停/等待）
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs'
import { join } from 'path'

const DATA_DIR = join(__dirname, '..', 'data')
const SCHEDULER_STATE_FILE = join(DATA_DIR, 'snovio_scheduler_state.json')
const LEADS_FILE = join(DATA_DIR, 'leads.json')

interface SchedulerState {
  status: 'running' | 'paused' | 'idle'
  dailyLimit: number
  todayProcessed: number
  todayDate: string
  totalProcessed: number
  lastRunAt: string | null
  intervalMinutes: number
  startedAt: string | null
}

interface LeadItem {
  id: string
  company: string
  website?: string
  email?: string
  contacts?: any[]
  backCheck?: any
  status?: string
  [key: string]: any
}

const DEFAULT_STATE: SchedulerState = {
  status: 'idle',
  dailyLimit: 100,
  todayProcessed: 0,
  todayDate: new Date().toISOString().slice(0, 10),
  totalProcessed: 0,
  lastRunAt: null,
  intervalMinutes: 7,
  startedAt: null,
}

let currentState: SchedulerState = loadState()
let schedulerTimer: ReturnType<typeof setTimeout> | null = null
let snovioToken: string | null = null
let tokenExpiresAt: number = 0

function loadState(): SchedulerState {
  try {
    if (existsSync(SCHEDULER_STATE_FILE)) {
      const raw = readFileSync(SCHEDULER_STATE_FILE, 'utf-8')
      const state = JSON.parse(raw) as SchedulerState
      // 日期变了，重置今日计数
      const today = new Date().toISOString().slice(0, 10)
      if (state.todayDate !== today) {
        state.todayProcessed = 0
        state.todayDate = today
      }
      return state
    }
  } catch {}
  return { ...DEFAULT_STATE }
}

function saveState(): void {
  try {
    writeFileSync(SCHEDULER_STATE_FILE, JSON.stringify(currentState, null, 2), 'utf-8')
  } catch {}
}

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] [SnovioScheduler] ${msg}`
  console.log(line)
  try { appendFileSync(join(DATA_DIR, 'scheduler.log'), line + '\n') } catch {}
}

// ---- Snovio Token 管理 ----
export async function getSnovioToken(userId: string, secret: string): Promise<string | null> {
  if (snovioToken && Date.now() < tokenExpiresAt) return snovioToken

  try {
    const params = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: userId,
      client_secret: secret,
    })
    const resp = await fetch('https://api.snov.io/v1/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(15000),
    })
    if (!resp.ok) return null
    const data = await resp.json() as { access_token?: string; expires_in?: number }
    if (!data.access_token) return null

    snovioToken = data.access_token
    tokenExpiresAt = Date.now() + ((data.expires_in || 3600) - 300) * 1000
    return snovioToken
  } catch {
    return null
  }
}

// ---- Snovio 域名搜索 ----
async function snovioDomainSearch(domain: string, token: string): Promise<any[]> {
  try {
    // 步骤1: 启动搜索
    const startResp = await fetch('https://api.snov.io/v2/domain-search/domain-emails/start', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `domain=${encodeURIComponent(domain)}`,
      signal: AbortSignal.timeout(30000),
    })
    if (!startResp.ok) return []
    const startData = await startResp.json() as { links?: { result?: string }; meta?: { task_hash?: string } }
    const resultUrl = startData.links?.result
    if (!resultUrl) return []

    // 步骤2: 等待并获取结果
    await new Promise(r => setTimeout(r, 2000))
    const resultResp = await fetch(resultUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30000),
    })
    if (!resultResp.ok) return []
    const resultData = await resultResp.json() as { data?: any[]; status?: string }

    // 如果还在处理中，再等一次
    if (resultData.status === 'processing') {
      await new Promise(r => setTimeout(r, 3000))
      const retryResp = await fetch(resultUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30000),
      })
      if (!retryResp.ok) return []
      const retryData = await retryResp.json() as { data?: any[] }
      return (retryData.data || []).map((e: any) => ({
        email: e.email || '',
        firstName: '',
        lastName: '',
        position: '',
        emailStatus: 'unknown',
      }))
    }

    return (resultData.data || []).map((e: any) => ({
      email: e.email || '',
      firstName: '',
      lastName: '',
      position: '',
      emailStatus: 'unknown',
    }))
  } catch {
    return []
  }
}

// ---- 获取待处理客户 ----
function getPendingLeads(): LeadItem[] {
  try {
    if (!existsSync(LEADS_FILE)) return []
    const raw = readFileSync(LEADS_FILE, 'utf-8')
    const leads = JSON.parse(raw) as LeadItem[]
    // 筛选：高匹配度 + 无邮箱 + 有网站
    return leads.filter(l =>
      l.website &&
      (!l.email || !l.email.includes('@')) &&
      (!l.contacts || l.contacts.length === 0) &&
      (l.status === 'verified' || l.status === 'found')
    )
  } catch {
    return []
  }
}

// ---- 处理单个客户 ----
async function processOneLead(lead: LeadItem, token: string): Promise<boolean> {
  if (!lead.website) return false

  try {
    const domain = new URL(lead.website.startsWith('http') ? lead.website : 'https://' + lead.website)
      .hostname.replace(/^www\./, '')

    const emails = await snovioDomainSearch(domain, token)
    if (emails.length === 0) {
      log(`[SKIP] ${lead.company} - 未找到邮箱`)
      return false
    }

    // 取前4个有效邮箱
    const validEmails = emails
      .filter((e: any) => e.email && e.email.includes('@'))
      .slice(0, 4)

    if (validEmails.length === 0) {
      log(`[SKIP] ${lead.company} - 邮箱格式无效`)
      return false
    }

    // 更新leads.json
    const allLeads = JSON.parse(readFileSync(LEADS_FILE, 'utf-8')) as LeadItem[]
    const idx = allLeads.findIndex(l => l.id === lead.id)
    if (idx === -1) return false

    // 设置主邮箱（第一个）
    allLeads[idx].email = validEmails.map((e: any) => e.email).join('; ')
    allLeads[idx].contacts = validEmails.map((e: any) => ({
      name: [e.firstName, e.lastName].filter(Boolean).join(' '),
      title: e.position || e.title || '',
      email: e.email,
      emailStatus: e.emailStatus || e.status || 'unknown',
      source: 'Snov.io',
    }))
    allLeads[idx].updatedAt = new Date().toISOString()

    writeFileSync(LEADS_FILE, JSON.stringify(allLeads, null, 2), 'utf-8')
    log(`[OK] ${lead.company} - 获取 ${validEmails.length} 个邮箱`)
    return true
  } catch (err: any) {
    log(`[ERROR] ${lead.company} - ${err.message}`)
    return false
  }
}

// ---- 调度器主循环 ----
async function runSchedulerLoop(): Promise<void> {
  if (currentState.status !== 'running') return

  // 检查今日额度
  if (currentState.todayProcessed >= currentState.dailyLimit) {
    log(`今日已达限额 ${currentState.dailyLimit}，暂停等待明天`)
    currentState.status = 'idle'
    saveState()
    return
  }

  // 获取Snovio token
  const userId = process.env.SNOVIO_USER_ID || ''
  const secret = process.env.SNOVIO_SECRET || ''
  if (!userId || !secret) {
    log('Snovio未配置，暂停')
    currentState.status = 'idle'
    saveState()
    return
  }

  const token = await getSnovioToken(userId, secret)
  if (!token) {
    log('Snovio认证失败，10分钟后重试')
    schedulerTimer = setTimeout(runSchedulerLoop, 10 * 60 * 1000)
    return
  }

  // 获取待处理客户
  const pending = getPendingLeads()
  if (pending.length === 0) {
    log('队列已空，暂停')
    currentState.status = 'idle'
    saveState()
    return
  }

  // 处理1个客户
  const lead = pending[0]
  const ok = await processOneLead(lead, token)
  if (ok) {
    currentState.todayProcessed++
    currentState.totalProcessed++
  }
  currentState.lastRunAt = new Date().toISOString()
  saveState()

  // 随机间隔5-10分钟
  const interval = (currentState.intervalMinutes + Math.random() * 5) * 60 * 1000
  log(`下次运行: ${Math.round(interval / 60000)}分钟后 | 今日: ${currentState.todayProcessed}/${currentState.dailyLimit}`)
  schedulerTimer = setTimeout(runSchedulerLoop, interval)
}

// ---- 公开API ----
export function getSchedulerState(): SchedulerState {
  return { ...currentState }
}

export function startScheduler(dailyLimit?: number): { ok: boolean; message: string } {
  if (currentState.status === 'running') {
    return { ok: false, message: '调度器已在运行中' }
  }
  if (dailyLimit) currentState.dailyLimit = dailyLimit
  currentState.status = 'running'
  currentState.startedAt = new Date().toISOString()
  saveState()
  log(`启动调度器，每日限额: ${currentState.dailyLimit}`)
  runSchedulerLoop()
  return { ok: true, message: '调度器已启动' }
}

export function pauseScheduler(): { ok: boolean; message: string } {
  if (currentState.status !== 'running') {
    return { ok: false, message: '调度器未在运行' }
  }
  currentState.status = 'paused'
  if (schedulerTimer) clearTimeout(schedulerTimer)
  schedulerTimer = null
  saveState()
  log('调度器已暂停')
  return { ok: true, message: '调度器已暂停' }
}

export function resumeScheduler(): { ok: boolean; message: string } {
  if (currentState.status !== 'paused') {
    return { ok: false, message: '调度器未处于暂停状态' }
  }
  currentState.status = 'running'
  saveState()
  log('调度器已恢复')
  runSchedulerLoop()
  return { ok: true, message: '调度器已恢复' }
}

export function resetDailyCount(): { ok: boolean; message: string } {
  currentState.todayProcessed = 0
  currentState.todayDate = new Date().toISOString().slice(0, 10)
  saveState()
  log('今日计数已重置')
  return { ok: true, message: '今日计数已重置' }
}

export function updateSchedulerConfig(config: { dailyLimit?: number; intervalMinutes?: number }): void {
  if (config.dailyLimit) currentState.dailyLimit = config.dailyLimit
  if (config.intervalMinutes) currentState.intervalMinutes = config.intervalMinutes
  saveState()
}
