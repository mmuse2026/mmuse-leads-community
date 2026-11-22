import { groupDailyEvidence } from '../components/groupDailyEvidence'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getAllItems, getRecentSearchSessions, loadFromDisk } from '../store/db'
import { buildDailyWorkbench, type DailyWorkbenchSummary, type WorkbenchLead } from '../services/dailyWorkbench'
import { API_BASE } from '../services/config'
import type { PipelineItem } from '../types/item'
import { presentSource, presentStatus } from '../services/presentation'
import { cnAction, cnStatus } from '../services/chineseStatus'
import { zh } from '../services/zhText'
import BackButton from '../components/BackButton'
import PageHead from '../components/PageHead'
import SectionHead from '../components/SectionHead'
import ContentProductionBoard from '../components/ContentProductionBoard'
import { normalizeEmailText } from '../services/emailText'

type TaskState = 'pending' | 'done' | 'later' | 'deep_review' | 'paused' | 'abandoned'

interface BackgroundStatus {
  testMail: {
    todaySent: number
    quota: number
    remaining: number
    activeQueueLength: number
    watching: number
    historyTotal: number
    paused: boolean
    lastRunAt?: string
    lastError?: string | null
  }
  zoho: {
    configured: boolean
    running: boolean
    lastSyncAt?: string | null
    lastSyncedCount: number
    lastError?: string | null
  }
  isolation: {
    todayAdded: number
    total: number
  }
}
interface WebhookSyncView {
  status: 'normal' | 'error' | 'idle'
  backlog: number
  lastSyncAt?: string
  bounced: number
  replied: number
  unmatched: number
}

const WEBHOOK_SYNC_KEY = 'mmuse:test-mail-recovery:last-sync'
const WEBHOOK_SYNC_COOLDOWN_MS = 10 * 60 * 1000
const EMPTY_WEBHOOK_SYNC: WebhookSyncView = { status: 'idle', backlog: 0, bounced: 0, replied: 0, unmatched: 0 }

function legacyTaskStateValues(states: Record<string, TaskState>, section: string, id: string, email: string): TaskState[] {
  const prefix = `${section}:${id}:`
  const normalizedEmail = email.trim().toLowerCase()
  return Object.entries(states).flatMap(([key, state]) => {
    if (!key.startsWith(prefix) || !Object.prototype.hasOwnProperty.call(stateLabels, state)) return []
    const legacyIdentity = key.slice(prefix.length)
    const indexSeparator = legacyIdentity.lastIndexOf(':')
    if (indexSeparator < 0 || !/^\d+$/.test(legacyIdentity.slice(indexSeparator + 1))) return []
    const legacyEmail = legacyIdentity.slice(0, indexSeparator)
    return legacyEmail.trim().toLowerCase() === normalizedEmail ? [state] : []
  })
}
const stateLabels: Record<TaskState, string> = {
  pending: '待处理',
  done: '已处理',
  later: '稍后',
  deep_review: '需要深度背调',
  paused: '暂缓',
  abandoned: '放弃',
}

const tone: Record<string, string> = {
  high: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  medium: 'bg-amber-50 text-amber-700 border-amber-200',
  low: 'bg-surface-100 text-surface-600 border-surface-200',
  none: 'bg-red-50 text-red-700 border-red-200',
  unknown: 'bg-surface-100 text-surface-500 border-surface-200',
}

/** 从原始 item 读取的补充事实徽章（只做展示，不参与任何门禁判断） */
function factBadgesFor(item: any): Array<{ tone: string; text: string; title?: string }> {
  const badges: Array<{ tone: string; text: string; title?: string }> = []
  if (item?.website) badges.push({ tone: 'bg-cyan-50 text-cyan-700 border-cyan-200', text: '官网', title: String(item.website) })
  if (item?.emailBounced === true) badges.push({ tone: 'bg-red-50 text-red-700 border-red-200', text: '已退信', title: '该客户存在退信记录。' })
  const disposition = String(item?.reviewDisposition || '')
  if (disposition && disposition !== 'active') {
    const disTone = disposition === 'do_not_develop' ? 'bg-red-50 text-red-700 border-red-200' : 'bg-amber-50 text-amber-700 border-amber-200'
    badges.push({ tone: disTone, text: `处置 ${presentStatus(disposition).label}`, title: presentStatus(disposition).tooltip })
  }
  return badges
}

/** 从原始 item 读取的风险提示（仅展示，不阻止任何人工操作） */
function riskHintsFor(item: any): string[] {
  const hints: string[] = []
  const gaps = [...(Array.isArray(item?.evidenceGaps) ? item.evidenceGaps : []), ...(Array.isArray(item?.evidenceGap) ? item.evidenceGap : [])].map(String).filter(Boolean)
  if (gaps.length) hints.push(`证据缺口：${gaps.slice(0, 3).join('、')}`)
  if (item?.doNotDevelop === true || item?.doNotContactEmail === true) hints.push('禁止联系/不开发标记')
  if (item?.currentEmailUseBlocked === true) hints.push('当前邮箱使用已受限')
  if (item?.reviewReason) hints.push(zh(String(item.reviewReason)))
  return hints
}

/** 已观察时长（仅展示） */
function observedDurationFor(row: WorkbenchLead): string | undefined {
  const start = Date.parse(row.observationStartedAt || '')
  if (!Number.isFinite(start)) return undefined
  const end = Date.parse(row.observationEndsAt || '')
  const endMs = Number.isFinite(end) ? end : Date.now()
  const elapsedHours = Math.max(0, Math.round((endMs - start) / 3_600_000))
  return Number.isFinite(end)
    ? `观察窗口：${elapsedHours}/${Math.max(0, Math.round((end - start) / 3_600_000))} 小时`
    : `已观察 ${elapsedHours} 小时`
}

function latestEvidenceOf(item: any): any {
  const list = Array.isArray(item?.emailVerificationEvidence) ? item.emailVerificationEvidence : []
  return list[list.length - 1] || null
}

function testMailStatusFor(item: any): string {
  if (item?.testMailStatus) return cnStatus(item.testMailStatus)
  const evidence = latestEvidenceOf(item)
  if (evidence?.result) return cnStatus(evidence.result)
  return '—'
}

function formalStatusFor(item: any): string {
  if (item?.developmentStatus) return cnStatus(item.developmentStatus)
  const logs = Array.isArray(item?.emailLogs) ? item.emailLogs : []
  const lastLog = logs[logs.length - 1]
  if (lastLog?.status) return cnStatus(lastLog.status)
  const drafts = Array.isArray(item?.manualEmailDrafts) ? item.manualEmailDrafts : []
  const lastDraft = drafts[drafts.length - 1]
  if (lastDraft?.status) return cnStatus(lastDraft.status)
  return '—'
}

function lastSyncAtFor(item: any): string {
  const evidence = latestEvidenceOf(item)
  const raw = evidence?.checkedAt || evidence?.lastRecoveryCheckedAt || item?.updatedAt || item?.emailVerificationCheckedAt
  if (!raw) return '—'
  const t = Date.parse(String(raw))
  return Number.isFinite(t) ? new Date(t).toLocaleString('zh-CN') : '—'
}

function replySummaryFor(item: any): string {
  const replies = (Array.isArray(item?.zohoReplyEvidence) ? item.zohoReplyEvidence : [])
    .filter((entry: any) => entry?.classification === 'reply')
  if (replies.length) {
    const last = replies[replies.length - 1]
    return normalizeEmailText(last?.textSummary || last?.subject) || '有客户回复'
  }
  const logs = Array.isArray(item?.emailLogs) ? item.emailLogs : []
  const repliedLog = [...logs].reverse().find(log => log?.status === 'replied')
  if (repliedLog) return normalizeEmailText(repliedLog?.subject) || '客户已回复'
  return '—'
}

function bounceReasonFor(item: any): string {
  const logs = Array.isArray(item?.emailLogs) ? item.emailLogs : []
  const bounced = [...logs].reverse().find(log => log?.status === 'bounced')
  if (bounced?.bounceReason) return zh(String(bounced.bounceReason))
  const evidence = latestEvidenceOf(item)
  if (evidence?.note) return zh(String(evidence.note))
  if (item?.emailBounced) return '已记录退信'
  return '—'
}

interface CustomerFields {
  company: string
  country: string
  businessMatch: string
  email: string
  emailType: string
  testMailStatus: string
  formalStatus: string
  observed: string
  lastSync: string
  nextAction: string
  replySummary: string
  bounceReason: string
  suggestedAction: string
}

/** 客户卡片 13 字段（全部中文，缺失用「—」占位，不强制造数） */
function customerFieldsFor(row: WorkbenchLead, item: any): CustomerFields {
  const email = row.email || item?.email || '—'
  const emailType = row.emailType ? cnStatus(row.emailType) : item?.emailVerification ? cnStatus(item.emailVerification) : '—'
  return {
    company: row.company || '未命名客户',
    country: row.country || '未标注',
    businessMatch: cnStatus(row.businessMatch),
    email,
    emailType,
    testMailStatus: testMailStatusFor(item),
    formalStatus: formalStatusFor(item),
    observed: observedDurationFor(row) || '—',
    lastSync: lastSyncAtFor(item),
    nextAction: cnStatus(row.action),
    replySummary: replySummaryFor(item),
    bounceReason: bounceReasonFor(item),
    suggestedAction: cnAction(row.action),
  }
}

/** 区块标题用的小图标（24 视口描边线条，SectionHead 图标章内使用） */
function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

function Metric({ label, value, hint, color = 'text-surface-900', onClick }: { label: string; value: number | string; hint?: string; color?: string; onClick?: () => void }) {
  const content = <><div className="text-[11px] font-medium text-surface-500">{label}</div><div className={`mt-1 text-2xl font-bold tabular-nums ${color}`}>{value}</div>{hint && <div className="mt-1 text-[10px] text-surface-400">{hint}</div>}</>
  return onClick
    ? <button type="button" onClick={onClick} className="w-full rounded-xl border border-surface-200 bg-white p-4 text-left shadow-panel hover:border-accent-300">{content}</button>
    : <div className="w-full rounded-xl border border-surface-200 bg-white p-4 shadow-panel">{content}</div>
}

/** 今日焦点大卡：大数字 + 标题 + 行动话术 + 右下角跳转按钮（整卡可点击） */
function FocusCard({ number, color, title, hint, to, cta }: { number: number | string; color: string; title: string; hint: string; to: string; cta: string }) {
  const navigate = useNavigate()
  return (
    <button type="button" onClick={() => navigate(to)} className="flex w-full flex-col rounded-xl border border-surface-200 bg-white p-4 text-left shadow-panel hover:border-accent-300">
      <div className={`text-4xl font-semibold tabular-nums ${color}`}>{number}</div>
      <div className="mt-2 text-sm font-semibold text-surface-900">{title}</div>
      <p className="mt-1 text-xs text-surface-500">{hint}</p>
      <div className="mt-3 flex items-center justify-end text-xs font-semibold text-accent-600">{cta} →</div>
    </button>
  )
}

function LeadRows({
  rows,
  section,
  taskStates,
  updateTaskState,
  limit = 50,
  itemsById,
}: {
  rows: WorkbenchLead[]
  section: string
  taskStates: Record<string, TaskState>
  updateTaskState: (key: string, state: TaskState) => void
  limit?: number
  itemsById?: Map<string, any>
}) {
  const navigate = useNavigate()
  if (rows.length === 0) return <div className="rounded-lg border border-dashed border-surface-300 p-6 text-center text-xs text-surface-400">当前没有待处理记录</div>
  return (
    <div className="space-y-2">
      {rows.slice(0, limit).map((row, rowIndex) => {
        const normalizedEmail = String(row.email || '').trim().toLowerCase()
        const key = `${section}:${row.id}:${normalizedEmail}`
        const state = taskStates[key] || 'pending'
        const item = itemsById?.get(row.id)
        const badges = item ? factBadgesFor(item) : []
        const hints = item ? riskHintsFor(item) : []
        const fields = customerFieldsFor(row, item)
        const rail = row.priority === 'high' ? 'bg-red-500' : row.priority === 'medium' ? 'bg-amber-500' : 'bg-accent-500'
        const metaRow = ([
          ['邮箱', fields.email],
          ['正式信', fields.formalStatus],
          ['下次', fields.nextAction],
          ['同步', fields.lastSync],
          ['回复', fields.replySummary],
          ['退信', fields.bounceReason],
        ] as [string, string][]).filter(([, v]) => Boolean(v) && v !== '—')
        return (
          <div key={`${key}:${rowIndex}`} className="daily-lead-row group rounded-lg border border-surface-200 bg-white p-3.5 shadow-panel hover:border-accent-300">
            <div className="flex items-start gap-3">
              <div className={`mt-1 w-1 flex-shrink-0 self-stretch rounded-full ${rail}`} />
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-3">
                  <button type="button" onClick={() => navigate(row.path)} className="min-w-0 text-left">
                    <h3 className="truncate text-sm font-semibold text-surface-900">{fields.company}</h3>
                    <p className="mt-0.5 text-[11px] text-surface-500">{fields.country} · <span title={presentStatus(row.customerType).tooltip}>{presentStatus(row.customerType).label}</span> · 来源 <span title={presentSource(row.source).tooltip}>{presentSource(row.source).label}</span></p>
                  </button>
                  <div className="flex flex-shrink-0 items-center gap-1.5">
                    <button type="button" onClick={() => navigate(row.path)} className="rounded-lg border border-surface-200 bg-white px-2 py-1 text-[11px] text-surface-600 transition hover:border-accent-300 hover:text-accent-600 ">客户详情</button>
                    <select aria-label={`${fields.company} ${fields.email}任务状态`} value={state} onChange={event => updateTaskState(key, event.target.value as TaskState)} className="rounded-lg border border-surface-200 bg-white px-2 py-1 text-[11px] text-surface-700 outline-none">
                      {(Object.keys(stateLabels) as TaskState[]).map(value => <option key={value} value={value}>{stateLabels[value]}</option>)}
                    </select>
                  </div>
                </div>

                <div className="mt-2 flex flex-wrap gap-1.5">
                  <span className={`rounded-full border px-2 py-0.5 text-[10px] ${tone[row.businessMatch] || tone.unknown}`} title={presentStatus(row.businessMatch).tooltip}>匹配 {presentStatus(row.businessMatch).label}</span>
                  <span className={`rounded-full border px-2 py-0.5 text-[10px] ${tone[row.importCommercialValue] || tone.unknown}`} title={presentStatus(row.importCommercialValue).tooltip}>价值 {presentStatus(row.importCommercialValue).label}</span>
                  {row.priority && <span className="rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[10px] text-blue-700" title={presentStatus(row.priority).tooltip}>优先级 {presentStatus(row.priority).label}</span>}
                  {row.dnsStatus && <span className="rounded-full border border-cyan-200 bg-cyan-50 px-2 py-0.5 text-[10px] text-cyan-700" title={presentStatus(row.dnsStatus).tooltip}>DNS {presentStatus(row.dnsStatus).label}</span>}
                  {row.providerStatus && <span className="rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[10px] text-violet-700" title={presentStatus(row.providerStatus).tooltip}>投递 {presentStatus(row.providerStatus).label}</span>}
                  {badges.map(badge => <span key={badge.text} className={`rounded-full border px-2 py-0.5 text-[10px] ${badge.tone}`} title={badge.title}>{badge.text}</span>)}
                </div>

                {metaRow.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-surface-500">
                    {metaRow.map(([label, value]) => <span key={label}>{label} <span className="text-surface-700">{value}</span></span>)}
                  </div>
                )}

                {row.reason && <div className="mt-2 text-[11px] text-surface-500">{zh(String(row.reason))}</div>}
                {hints.length > 0 && <div className="mt-2 rounded bg-amber-50 px-2 py-1 text-[10px] leading-4 text-amber-800">风险提示：{hints.join('；')}</div>}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** Customer-level presentation only. Original per-address controls remain in LeadRows. */
function BounceEvidence(props: Omit<Parameters<typeof LeadRows>[0], 'section' | 'limit'>) {
  const navigate = useNavigate()
  const groups = groupDailyEvidence(props.rows)
  if (!groups.length) return <p className="text-sm text-surface-500">当前没有待处理记录</p>
  return <div className="space-y-3" data-ui="bounce-groups">
    <p className="text-xs text-surface-600">{groups.length} 个客户展示组 · {props.rows.length} 条原始证据（非新增客户数）</p>
    {groups.map(({ key, evidence }) => {
      const row = evidence[0]
      const item = props.itemsById?.get(row.id)
      const warnings = [...new Set([...evidence.map(entry => entry.reason).filter(Boolean), ...riskHintsFor(item)])]
      const statuses = [...new Set(evidence.map(entry => presentStatus(entry.providerStatus || 'unknown').label))]
      return <article key={key} data-ui="bounce-customer" data-customer-id={row.id} className="rounded-xl border border-red-200 bg-white p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <button type="button" data-ui="bounce-open-customer" onClick={() => navigate(row.path)} className="min-w-0 text-left text-sm font-semibold text-surface-900 hover:text-accent-700">
            <h3>{row.company || '未命名客户'}</h3>
          </button>
          <span className="text-xs font-medium text-red-700">需换联系人 · {evidence.length} 条证据</span>
        </div>
        <p className="mt-2 break-words text-xs text-surface-600">邮箱：{[...new Set(evidence.map(entry => entry.email || '邮箱未知'))].join('、')}</p>
        <p className="mt-1 text-xs text-red-800">投递：{statuses.join('、')} · {bounceReasonFor(item)}</p>
        {warnings.length > 0 && <p className="mt-2 break-words text-xs text-amber-900">{warnings.map(warning => zh(String(warning))).join('；')}</p>}
        <details className="ui-disclosure mt-3" data-ui="bounce-evidence">
          <summary>原始证据与逐邮箱操作 · {evidence.length} 条</summary>
          <LeadRows {...props} rows={evidence} section="bounces" limit={evidence.length} />
        </details>
      </article>
    })}
  </div>
}

export default function DailyWorkbench() {
  const navigate = useNavigate()
  const [summary, setSummary] = useState<DailyWorkbenchSummary | null>(null)
  const [items, setItems] = useState<any[]>([])
  const [webhookSync, setWebhookSync] = useState<WebhookSyncView>(EMPTY_WEBHOOK_SYNC)
  const [sendDashboard, setSendDashboard] = useState<any>(null)
  const [stockDashboard, setStockDashboard] = useState<any>(null)
  const [bgStatus, setBgStatus] = useState<BackgroundStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [taskStates, setTaskStates] = useState<Record<string, TaskState>>(() => {
    try { return JSON.parse(localStorage.getItem('mmuse_daily_task_states') || '{}') } catch { return {} }
  })

  async function load() {
    setLoading(true)
    const lastSync = Number(localStorage.getItem(WEBHOOK_SYNC_KEY) || 0)
    const syncDue = !Number.isFinite(lastSync) || Date.now() - lastSync >= WEBHOOK_SYNC_COOLDOWN_MS
    try {
      let payload: any
      if (syncDue) {
        localStorage.setItem(WEBHOOK_SYNC_KEY, String(Date.now()))
        const response = await fetch(`${API_BASE}/api/webhook-sync`, { method: 'POST' })
        payload = await response.json()
        if (!response.ok) throw new Error('worker sync failed')
      } else {
        const response = await fetch(`${API_BASE}/api/webhook-sync/status`)
        payload = await response.json()
        if (!response.ok) throw new Error('worker status failed')
      }
      const state = payload.state || {}
      const stats = payload.stats || state.lastStats || {}
      setWebhookSync({
        status: state.lastError ? 'error' : state.lastSuccessAt ? 'normal' : 'idle',
        backlog: Number(state.workerStatus?.backlog || 0),
        lastSyncAt: state.lastSuccessAt || state.lastSyncAt,
        bounced: Number(stats.bounced || 0),
        replied: Number(stats.replied || 0),
        unmatched: Number(payload.unmatchedCount ?? stats.unmatched ?? 0),
      })
    } catch {
      setWebhookSync(previous => ({ ...previous, status: 'error' }))
    }
    try {
      const sessionResponse = await fetch(`${API_BASE}/api/formal-send-queue/operator-session`)
      if (sessionResponse.ok) {
        const session = await sessionResponse.json()
        const queueResponse = await fetch(`${API_BASE}/api/formal-send-queue/dashboard`, {
          headers: { 'X-MMUSE-Operator': session.operatorToken, 'X-MMUSE-CSRF': session.csrfToken },
        })
        if (queueResponse.ok) setSendDashboard(await queueResponse.json())
      }
    } catch {}
    try { const stockResponse = await fetch(`${API_BASE}/api/stock-operations/dashboard`); if (stockResponse.ok) setStockDashboard(await stockResponse.json()) } catch {}
    try {
      const bgResponse = await fetch(`${API_BASE}/api/background-status`)
      if (bgResponse.ok) {
        const payload = await bgResponse.json()
        if (payload?.testMail && payload?.zoho && payload?.isolation) setBgStatus(payload)
      }
    } catch {}
    // loadFromDisk 已把服务器全量同步进 IndexedDB（App 挂载共用同一 promise），
    // 不再重复 fetch /api/items——避免多个全量拉取在服务器排队（每次 stringify 313MB）
    await loadFromDisk().catch(() => 0)
    const [localItems, searches] = await Promise.all([getAllItems(), getRecentSearchSessions(100)])
    const items = localItems
    // 隔离客户不显示：primaryStage/normalizedStage/operationalTier 命中已隔离/低优先的整条剔除
    const EXCLUDED_STAGE = new Set(['true_excluded', 'low_priority_nurture', 'inactive_excluded'])
    const filteredItems = items.filter(item => {
      const stage = String((item as any)?.primaryStage || item?.normalizedStage || item?.operationalTier || '')
      return !EXCLUDED_STAGE.has(stage)
    })
    const next = buildDailyWorkbench(filteredItems, searches)
    setItems(filteredItems)
    setSummary(next)
    const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
    localStorage.setItem(`mmuse_daily_work_record:${day}`, JSON.stringify({
      generatedAt: next.generatedAt,
      synchronizedWatching: next.watchingQueue.length,
      backcheckReviewSuggestions: next.reviewQueue.length,
      directValidation: next.validationQueue.length,
      contactMining: next.contactMiningQueue.length,
      snovioPriority: next.snovioPriorityQueue.length,
      apiLedger: next.apiLedger,
      incompleteTasks: next.incompleteTasks,
      tomorrowTasks: next.tomorrowTasks,
    }))
    setLoading(false)
  }

  useEffect(() => { void load() }, [])

  function updateTaskState(key: string, state: TaskState) {
    setTaskStates(previous => {
      const next = { ...previous, [key]: state }
      localStorage.setItem('mmuse_daily_task_states', JSON.stringify(next))
      return next
    })
  }

  const itemsById = useMemo(() => new Map(items.map(item => [item.id, item])), [items])

  useEffect(() => {
    if (!summary) return
    const identities = [
      ...summary.reviewQueue.map(row => ['review', row] as const),
      ...summary.validationQueue.map(row => ['validation', row] as const),
      ...summary.snovioPriorityQueue.map(row => ['contacts', row] as const),
      ...summary.watchingQueue.map(row => ['watching', row] as const),
      ...summary.bouncedQueue.map(row => ['bounces', row] as const),
    ]
    setTaskStates(previous => {
      const next = { ...previous }
      let changed = false
      for (const [section, row] of identities) {
        const id = String(row.id ?? '')
        const email = String(row.email || '').trim().toLowerCase()
        const stableKey = `${section}:${id}:${email}`
        if (Object.prototype.hasOwnProperty.call(next, stableKey)) continue
        const candidates = legacyTaskStateValues(previous, section, id, email)
        const distinctStates = [...new Set(candidates)]
        if (distinctStates.length !== 1) continue
        next[stableKey] = distinctStates[0]
        changed = true
      }
      if (!changed) return previous
      localStorage.setItem('mmuse_daily_task_states', JSON.stringify(next))
      return next
    })
  }, [summary])
  // A 池待人工审核数 = 实时阶段机队列 primaryStage==='pending_draft_review'，退信铁律先行（与 A 池审核页同口径）
  const aPoolReadyCount = useMemo(() => items.filter(item => {
    const stage = String((item as any)?.primaryStage || (item as any)?.normalizedStage || (item as any)?.operationalTier || '')
    return stage === 'pending_draft_review' && (item as any)?.emailBounced !== true
  }).length, [items])
  // B/C/D 池实时数：与阶段机同源（primaryStage 计数，退信铁律先行，与 Dashboard 卡片口径一致）
  const poolCounts = useMemo(() => {
    let b = 0, c = 0, d = 0
    for (const item of items) {
      const any = item as PipelineItem & Record<string, unknown>
      if (any.emailBounced === true) continue
      const stage = String(any?.primaryStage || '')
      if (stage === 'email_validation_queue') b++
      else if (stage === 'contact_mining_queue') c++
      else if (stage === 'backcheck_queue' || stage === 'data_enrichment_needed' || stage === 'manual_review') d++
    }
    return { b, c, d }
  }, [items])

  if (loading || !summary) return <div className="h-full overflow-auto p-8 text-sm text-surface-500">正在生成今日经营工作台…</div>

  // 顶部「今日焦点/系统状态」共用的派生数字（原 IIFE 内计算上提，不新增任何 fetch）
  const repliedCount = stockDashboard?.tiers?.replied_queue ?? 0
  const replaceCount = stockDashboard?.tiers?.replace_contact_queue ?? 0
  const watchingCount = stockDashboard?.tiers?.observation_queue ?? 0
  const testMailStatus = bgStatus?.testMail
  const zohoView = bgStatus?.zoho
    ? {
        label: bgStatus.zoho.configured ? '已配置' : '未配置',
        color: bgStatus.zoho.configured ? 'text-emerald-700' : 'text-surface-500',
        hint: bgStatus.zoho.configured
          ? `最近同步 ${bgStatus.zoho.lastSyncAt ? new Date(bgStatus.zoho.lastSyncAt).toLocaleString('zh-CN') : '尚未同步'} · ${bgStatus.zoho.lastSyncedCount ?? 0} 条${bgStatus.zoho.lastError ? ` · 异常：${bgStatus.zoho.lastError}` : ''}`
          : '未配置 Zoho 邮箱账号',
      }
    : { label: '—', color: 'text-surface-400', hint: '状态获取失败，请刷新重试' }

  return (
    <div data-ui-page="daily" className="h-full overflow-y-auto bg-surface-50">
      <div className="mx-auto max-w-[1440px] space-y-5 p-5 lg:p-7">
        <div className="shrink-0"><BackButton /></div>
        <PageHead
          eyebrow="日常运营"
          title="今日经营驾驶舱"
          subtitle={<>数据更新时间：{new Date(summary.generatedAt).toLocaleString()} · 发送资格、授权与额度按现有规则逐封检查；当前状态以实际记录为准</>}
          actions={<button type="button" onClick={load} className="rounded-lg border border-surface-200 bg-white px-3.5 py-2 text-xs font-semibold text-surface-700 shadow-panel hover:bg-surface-50">刷新工作台</button>}
        />

        {/* 今日焦点：4 张行动大卡（视觉主角，只放最需要人工介入的 4 件事） */}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <FocusCard number={repliedCount} color="text-emerald-700" title="客户已回复" hint="正式客户回复，待人工处理" to="/email-batch?tab=sent" cta="去处理" />
          <FocusCard number={aPoolReadyCount} color="text-emerald-700" title="待人工开发审核" hint={`${aPoolReadyCount} 家草稿待人工审核`} to="/a-review" cta="去处理" />
          <FocusCard number={replaceCount} color="text-red-700" title="需换联系人" hint="退信/不可达，换联系人重试" to="/replies" cta="去处理" />
          <FocusCard number={summary.counts.followupsDueToday} color="text-blue-700" title="今天应跟进" hint="已发送客户按节奏跟进" to="/email-batch?tab=sent" cta="去处理" />
        </div>

        {/* 今日系统状态：机器跑得如何（次级小格，不抢视觉） */}
        <section>
          <SectionHead icon={<Icon d="M22 12h-4l-3 9L9 3l-3 9H2" />} title="今日系统状态" />
          <div className="flex flex-wrap gap-2 text-xs">
            <div className="rounded-lg border border-surface-100 bg-surface-50 px-2 py-1 text-surface-500">正式信剩余额度 {sendDashboard?.remainingQuota ?? 0}</div>
            <div className="rounded-lg border border-surface-100 bg-surface-50 px-2 py-1 text-surface-500">邮箱同步 {zohoView.label}</div>
            <div className="rounded-lg border border-surface-100 bg-surface-50 px-2 py-1 text-surface-500">隔离今日新增 {bgStatus?.isolation?.todayAdded ?? 0}</div>
          </div>
        </section>

        <section id="bounces" className="scroll-mt-4">
          <SectionHead
            icon={<Icon d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 0 8 6 8-6M18 14v4M16 16h4" />}
            title="退信待处理"
            subtitle="按客户聚合展示；展开查看全部原始证据和逐邮箱操作，不改变统计口径。"
          />
          <BounceEvidence rows={summary.bouncedQueue} taskStates={taskStates} updateTaskState={updateTaskState} itemsById={itemsById} />
        </section>


        <div data-ui="runtime-alerts" className="space-y-2" role="status">
          {webhookSync.status !== 'normal' && <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">Webhook {webhookSync.status === 'error' ? '异常' : '待首次同步'} · 积压 {webhookSync.backlog} · 详情见今日运行监控</p>}
          <p className="text-xs text-surface-600" title={zohoView.hint}>邮箱同步：{zohoView.label} · {zohoView.hint}</p>
        </div>

        {/* 工作流快捷入口：搜索 → 背调 → 联系人 → 开发信 → 跟进 */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {[
            { title: '搜索', desc: '新客户进入候选池，等待人工背调', path: '/search-workbench#pool' },
            { title: '背调', desc: `${summary.reviewQueue.length} 家重点待确认`, path: '/develop?tab=backcheck_queue' },
            { title: '开发信', desc: `${summary.counts.pendingDrafts} 封待人工审核`, path: '/email-batch?tab=pending_human_review' },
            { title: '跟进', desc: `${summary.counts.followupsDueToday} 家今天应跟进`, path: '/email-batch?tab=sent' },
          ].map((step, index) => (
            <button key={step.title} type="button" onClick={() => navigate(step.path)} aria-label={`打开${step.title}队列：${step.desc}`} className="group flex items-start gap-3 rounded-xl border border-surface-200 bg-white p-3.5 text-left shadow-panel transition hover:border-accent-300 hover:shadow-card-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500">
              <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-accent-500 text-sm font-bold text-white tabular-nums">{index + 1}</div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-surface-900">{step.title}</div>
                <p className="mt-1 text-xs leading-5 text-surface-500">{step.desc}</p>
                <span className="mt-2 inline-block text-[11px] font-semibold text-accent-600 group-hover:text-accent-700">打开队列 →</span>
              </div>
            </button>
          ))}
        </div>

        <ContentProductionBoard />

        <button type="button" onClick={() => navigate('/admin?tab=isolation')} className="flex w-full items-center justify-between rounded-lg border border-red-200 bg-red-50/60 px-3 py-1.5 text-left">
          <span className="text-xs text-red-800">今日新增隔离 <strong>{bgStatus?.isolation?.todayAdded ?? '—'}</strong> 条 · 隔离库共 {bgStatus?.isolation?.total ?? '—'} 条（已隔离客户不显示在工作台）</span>
          <span className="text-xs text-red-600">查看隔离库 →</span>
        </button>

        <details className="ui-disclosure" data-ui="candidate-pools">
          <summary>候选池明细 · A {aPoolReadyCount} / B {poolCounts.b} / C {poolCounts.c} / D {poolCounts.d}</summary>
          <SectionHead
            icon={<Icon d="M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />}
            title="候选池卡片"
            titleTag="A/B/C/D 四类互斥"
            subtitle={`池数来源：A/B/C/D 均按 primaryStage 实时阶段统计，退信铁律先行；发送资格、授权与额度按现有规则逐封检查。`}
          />
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="今日可开发审核 A" value={aPoolReadyCount} color="text-emerald-700" hint={`${aPoolReadyCount} 家草稿待人工审核`} onClick={() => navigate('/a-review')} />
            <Metric label="需挖联系人 C" value={poolCounts.c} color="text-amber-700" hint={`${poolCounts.c} 家缺联系人`} onClick={() => navigate('/develop?tab=contact_mining')} />
            <Metric label="需补背调 D" value={poolCounts.d} color="text-red-700" hint={`${poolCounts.d} 家待背调`} onClick={() => navigate('/develop?tab=backcheck_queue')} />
          </div>
        </details>

        <details className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <summary className="cursor-pointer select-none text-sm font-semibold text-surface-700">背调完整性</summary>
          <div className="mt-3">
            <SectionHead
              icon={<Icon d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01" />}
              title="背调完整性"
              subtitle="9 字段标准：国家、官网、来源类型、客户类型、业务匹配、商业价值、背调摘要、证据缺口、推荐动作"
            />
            <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
              <Metric label="待补背调" value={summary.backcheckGaps.totalIncomplete} color="text-red-700" hint={`可自动 ${summary.backcheckGaps.canAutoBackcheck} · 需补来源 ${summary.backcheckGaps.needsSourceEnrichment} · 需人工 ${summary.backcheckGaps.needsHumanReview}`} onClick={() => navigate('/develop?tab=backcheck_queue')} />
              <Metric label="可自动补背调" value={summary.backcheckGaps.canAutoBackcheck} color="text-indigo-700" hint="有官网，可批量AI背调" />
              <Metric label="无官网需补来源" value={summary.backcheckGaps.needsSourceEnrichment} color="text-amber-700" hint="需搜索或手工补充官网" />
              <Metric label="需人工复核" value={summary.backcheckGaps.needsHumanReview} color="text-orange-700" hint="需人工判断结论" />
              <Metric label="背调完成可推进" value={summary.backcheckGaps.completeCanProceed} color="text-emerald-700" hint="已进入后续开发流程" />
              <Metric label="背调完成缺联系人" value={summary.backcheckGaps.completeMissingContacts} color="text-blue-700" hint="需挖掘联系人" />
            </div>
          </div>
        </details>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="可开发邮箱池" value={stockDashboard?.tiers?.developable_email_pool || 0} onClick={() => navigate('/email-batch')} />
          <Metric label="待审核草稿层" value={stockDashboard?.tiers?.pending_draft_review || 0} onClick={() => navigate('/email-batch?tab=pending_human_review')} />
          <Metric label="跟进队列" value={stockDashboard?.tiers?.followup_queue || 0} onClick={() => navigate('/email-batch?tab=sent')} />
        </div>

        <details className="rounded-xl border border-emerald-200 bg-emerald-50/30 p-4">
          <summary className="cursor-pointer select-none text-sm font-semibold text-surface-700">存量运营总览</summary>
          <div className="mt-3">
            <SectionHead
              icon={<Icon d="M4 6c0 1.66 3.58 3 8 3s8-1.34 8-3-3.58-3-8-3-8 1.34-8 3zm0 6c0 1.66 3.58 3 8 3s8-1.34 8-3M4 12v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" />}
              title="存量运营总览"
              subtitle={<>统一读取当前 items_store.json 与 primaryStage · {stockDashboard?.lastUpdatedAt ? new Date(stockDashboard.lastUpdatedAt).toLocaleString() : '等待刷新'}</>}
            />
            <div className="grid gap-2 sm:grid-cols-4 lg:grid-cols-8">
              <Metric label="背调已完成" value={stockDashboard?.backcheck?.completed||0} onClick={()=>navigate('/develop?tab=backcheck_queue')}/><Metric label="待背调" value={stockDashboard?.backcheck?.pending||0} onClick={()=>navigate('/develop?tab=backcheck_queue')}/><Metric label="人工复核" value={stockDashboard?.backcheck?.humanReview||0} onClick={()=>navigate('/develop?tab=backcheck_queue&stage=manual_review')}/><Metric label="联系人挖掘" value={stockDashboard?.contacts?.needed||0} onClick={()=>navigate('/develop?tab=contact_mining')}/><Metric label="Snovio已调用" value={stockDashboard?.contacts?.snovioCompanies||0} onClick={()=>navigate('/develop?tab=contact_mining')}/><Metric label="新增联系人" value={stockDashboard?.contacts?.returned||0} onClick={()=>navigate('/develop?tab=contact_mining')}/>
            </div>
            <div className="mt-2 grid gap-2 sm:grid-cols-3 lg:grid-cols-7">
              <Metric label="不可达/换联系人" value={stockDashboard?.validation?.unreachable||0} onClick={()=>navigate('/replies')}/><Metric label="正式信每日上限" value={stockDashboard?.quota?.formal?.dailyLimit??100} onClick={()=>navigate('/send-queue')}/><Metric label="正式信剩余额度" value={stockDashboard?.quota?.formal?.remainingQuota??100} onClick={()=>navigate('/send-queue')}/><Metric label="Snovio额度未知" value={presentStatus(stockDashboard?.quota?.snovio?.creditsUnknown ? 'unknown' : 'known').label} onClick={()=>navigate('/develop?tab=contact_mining')}/>
            </div>
          </div>
        </details>

        <details className="rounded-xl border border-blue-200 bg-blue-50/40 p-4">
          <summary className="cursor-pointer select-none text-sm font-semibold text-surface-700">正式发送任务看板 · 今日已发 {sendDashboard?.sentToday ?? 0} · 剩余 {sendDashboard?.remainingQuota ?? 0}</summary>
          <div className="mt-3">
            <SectionHead
              icon={<Icon d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" />}
              title="正式发送任务看板"
              subtitle={<>自动发送默认关闭（不代表发送器在线） · 系统标记：{sendDashboard?.paused ? '已暂停' : '未暂停'} · 最近更新 {sendDashboard?.lastUpdatedAt ? new Date(sendDashboard.lastUpdatedAt).toLocaleString() : '尚无'}</>}
              right={<button onClick={() => navigate('/send-queue')} className="rounded-lg border border-surface-200 bg-white px-3 py-1.5 text-xs font-semibold text-surface-700 shadow-panel hover:bg-surface-50">进入发送队列</button>}
            />
            <div className="grid gap-2 sm:grid-cols-4 lg:grid-cols-8"><Metric label="今日目标" value={sendDashboard?.dailyTarget || 0}/><Metric label="今日已发送" value={sendDashboard?.sentToday || 0}/><Metric label="今日已排期" value={sendDashboard?.scheduledToday || 0}/><Metric label="发送失败" value={sendDashboard?.failedToday || 0}/><Metric label="剩余额度" value={sendDashboard?.remainingQuota || 0}/><Metric label="尚未到发送时间" value={sendDashboard?.futureDeferred || 0}/><Metric label="需处理" value={sendDashboard?.counts?.needs_reschedule || 0} onClick={() => navigate('/send-queue?status=problem')}/><Metric label="下次计划发送" value={sendDashboard?.nextScheduledSendAt ? new Date(sendDashboard.nextScheduledSendAt).toLocaleTimeString() : '-'}/></div>
          </div>
        </details>

        <details className="rounded-xl border border-surface-200 bg-white p-4">
          <summary className="cursor-pointer select-none text-sm font-semibold text-surface-700">今日运行监控 · Webhook {webhookSync.status === 'normal' ? '正常' : webhookSync.status === 'error' ? '异常' : '待首次同步'} · 积压 {webhookSync.backlog}</summary>
          <div className="mt-3">
            <SectionHead
              icon={<Icon d="M22 12h-4l-3 9L9 3l-3 9H2" />}
              title="今日运行监控"
              subtitle="查看本机处理记录。"
              right={<div className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${webhookSync.status === 'normal' ? 'bg-emerald-50 text-emerald-700' : webhookSync.status === 'error' ? 'bg-red-50 text-red-700' : 'bg-surface-100 text-surface-600'}`}>Webhook 实时回收：{webhookSync.status === 'normal' ? '正常' : webhookSync.status === 'error' ? '异常' : '待首次同步'} · 积压 {webhookSync.backlog} · 退信 {webhookSync.bounced} · 回复 {webhookSync.replied} · 未匹配 {webhookSync.unmatched}{webhookSync.lastSyncAt ? ` · ${new Date(webhookSync.lastSyncAt).toLocaleString()}` : ''}</div>}
            />
            <div id="manual-zoho" className="rounded bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
              <div className="font-semibold">正式邮件回复</div>
              <div className="mt-1">按自己的邮件服务设置检查同步状态</div>
              <div className="mt-1">也可登录自己的发件邮箱查看客户回复</div>
              <div className="mt-1 font-medium">
                需人工检查 {summary.counts.manualZohoReplyChecks} 个客户 · 今天应跟进 {summary.counts.followupsDueToday} 个客户
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
              <span className="rounded bg-emerald-50 px-2 py-1 text-emerald-700">背调清洗 已完成</span>
              <span className="rounded bg-surface-100 px-2 py-1 text-surface-700">正式开发信 {summary.counts.formalSentToday}</span>
            </div>
          </div>
        </details>

        <details id="review" className="ui-disclosure scroll-mt-4" open={summary.reviewQueue.length > 0 || undefined}>
          <summary>重点背调确认 · {summary.reviewQueue.length} 条</summary>
          <SectionHead
            icon={<Icon d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />}
            title="重点背调确认"
            subtitle="按高 → 中排序；系统只给建议，不自动通过。"
            right={<button onClick={() => navigate('/develop?tab=backcheck_queue')} className="text-xs font-semibold text-accent-600 hover:text-accent-700">进入背调池 →</button>}
          />
          <LeadRows rows={summary.reviewQueue} section="review" taskStates={taskStates} updateTaskState={updateTaskState} itemsById={itemsById} />
        </details>


        <details id="contacts" className="ui-disclosure scroll-mt-4" open={summary.snovioPriorityQueue.length > 0 || undefined}>
          <summary>联系人挖掘队列 · {summary.snovioPriorityQueue.length} 条</summary>
          <SectionHead
            icon={<Icon d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />}
            title="联系人挖掘队列"
            subtitle={`共 ${summary.contactMiningQueue.length} 条；优先展示 ${summary.snovioPriorityQueue.length} 家建议 Snovio 客户。`}
            right={<button onClick={() => navigate('/develop?tab=contact_mining')} className="text-xs font-semibold text-accent-600 hover:text-accent-700">进入联系人挖掘 →</button>}
          />
          <LeadRows rows={summary.snovioPriorityQueue} section="contacts" taskStates={taskStates} updateTaskState={updateTaskState} limit={20} itemsById={itemsById} />
        </details>



        <div className="grid gap-5 xl:grid-cols-2">
          <section className="rounded-xl border border-surface-200 bg-white p-4">
            <SectionHead
              icon={<Icon d="M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />}
              title="开发信与跟进"
              right={<button onClick={() => navigate('/email-batch')} className="text-xs font-semibold text-accent-600 hover:text-accent-700">进入邮件开发 →</button>}
            />
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Metric label="待人工审核" value={summary.counts.pendingDrafts} />
              <Metric label="待正式发送" value={summary.counts.sendReady} />
              <Metric label="3天跟进" value={summary.counts.followup3Day} />
              <Metric label="7天跟进" value={summary.counts.followup7Day} />
              <Metric label="回复待处理" value={summary.counts.repliesPending} />
              <Metric label="退信待处理" value={summary.counts.bouncesPending} />
            </div>
          </section>

          <div>
          <div className="mt-3 space-y-1">{summary.apiLedger.alerts.map(alert => <div key={alert} className="rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-700">{alert}</div>)}</div>
          <details className="ui-disclosure" data-ui="api-ledger">
            <summary>API 额度账本 · 展开明细</summary>
            <SectionHead
              icon={<Icon d="M3 15a9 9 0 1 1 18 0M12 12v4M3 15h18" />}
              title="API 额度账本"
            />
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Metric label="Resend剩余" value={summary.apiLedger.resendRemaining} />
              <Metric label="Resend只读" value={summary.apiLedger.resendReadQueries} />
              <Metric label="Snovio调用" value={summary.apiLedger.snovioCalls} hint="额度消耗未知" />
              <Metric label="搜索API" value={summary.apiLedger.searchCalls} />
              <Metric label="DNS/DoH证据" value={summary.apiLedger.dnsQueries} />
            </div>

          </details>
          </div>
        </div>


        <div className="grid gap-5 xl:grid-cols-2">
          <section className="rounded-xl border border-surface-200 bg-white p-4">
            <SectionHead
              icon={<Icon d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM8 11h8M8 15h5" />}
              title="系统未完成任务"
            />
            <div className="space-y-2">{summary.incompleteTasks.map(task => <button key={task.label} onClick={() => navigate(task.path)} className="flex w-full items-center justify-between rounded-lg border border-surface-200 px-3 py-2 text-left text-xs shadow-panel transition hover:border-accent-300 hover:bg-surface-50"><span>{task.label}</span><strong className="tabular-nums">{task.count}</strong></button>)}</div>
          </section>
          <section className="rounded-xl border border-surface-200 bg-white p-4">
            <SectionHead
              icon={<Icon d="M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM12 14v3M12 14h-2" />}
              title="明日建议任务"
            />
            <ol className="space-y-2">{summary.tomorrowTasks.map((task, index) => <li key={task} className="flex gap-2 rounded-lg bg-surface-50 px-3 py-2 text-xs text-surface-700"><span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded bg-accent-500 text-[10px] font-bold text-white tabular-nums">{index + 1}</span><span>{task}</span></li>)}</ol>
          </section>
        </div>
      </div>
    </div>
  )
}
