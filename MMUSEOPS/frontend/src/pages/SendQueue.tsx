import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { API_BASE } from '../services/config'
import { FORMAL_CSRF_HEADER, FORMAL_OPERATOR_HEADER } from '../services/formalQueueAuth'
import { presentStatus } from '../services/presentation'
import { formalOutreachStatusLabel } from '../services/formalOutreachLifecycle'
import type { FormalOutreachStatus } from '../services/formalOutreachLifecycle'
import PageHead from '../components/PageHead'
import SectionHead from '../components/SectionHead'
import EmptyState from '../components/EmptyState'

type OperatorSession = { operatorToken: string; csrfToken: string; expiresAt: number }
type QueueRecord = { publicRecordId?: string; customerRouteRef?: string; campaignLabel?: string; recordScope?: 'active' | 'history'; sendQueueStatus: string; deliveryStatus?: string; scheduledSendAt?: string; actualSentAt?: string; sendAttemptCount?: number; sendErrorCode?: string; pendingHumanReview?: boolean }
const ERROR_ZH: Record<string, string> = {
  LOCAL_OPERATOR_AUTH_REQUIRED: '需要本机操作员会话，请刷新后重试',
  CSRF_TOKEN_INVALID: '本机安全会话已失效，请刷新后重试',
  SAFE_MODE_BLOCKED: '安全模式已阻止正式发送',
}

/** 队列行左侧 5px 状态色条（语义色：待办琥珀 / 批准排程蓝 / 已发送绿 / 失败红） */
const LEFT_BAR: Record<string, string> = {
  pending_human_review: 'bg-amber-400',
  approved_for_sending: 'bg-accent-500',
  scheduled: 'bg-accent-400',
  sending: 'bg-accent-400',
  sent: 'bg-emerald-500',
  send_failed: 'bg-red-500',
  blocked: 'bg-red-500',
  needs_reschedule: 'bg-amber-400',
  needs_manual_reconciliation: 'bg-amber-400',
  needs_timezone_review: 'bg-amber-400',
  paused: 'bg-surface-400',
}

/** 面向业务的分组；技术状态保留在记录和详情中。 */
const QUEUE_GROUPS: { key: string; title: string; desc: string }[] = [
  { key: 'pending', title: '待处理', desc: '草稿或候选还未排入发送计划。' },
  { key: 'scheduled', title: '已排期', desc: '已有计划时间；排期不代表已经发送。' },
  { key: 'sent', title: '已发送', desc: '有服务商发送记录。' },
  { key: 'problem', title: '需处理', desc: '只处理这条异常，其他任务继续。' },
]

function businessQueueGroup(record: QueueRecord): string {
  if (record.deliveryStatus === 'formal_bounced') return 'problem'
  if (record.sendQueueStatus === 'pending_human_review' && record.pendingHumanReview) return 'problem'
  if (['blocked', 'send_failed', 'needs_manual_reconciliation', 'needs_timezone_review', 'needs_reschedule', 'paused'].includes(record.sendQueueStatus)) return 'problem'
  if (['pending_human_review', 'approved_for_sending'].includes(record.sendQueueStatus)) return 'pending'
  if (['scheduled', 'sending'].includes(record.sendQueueStatus)) return 'scheduled'
  if (record.sendQueueStatus === 'sent') return 'sent'
  return 'problem'
}

const GROUP_ICONS: Record<string, ReactNode> = {
  pending: (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.75a1.5 1.5 0 1 0 3 0 1.5 1.5 0 0 0-3 0Zm-7.5 0a1.5 1.5 0 1 0 3 0 1.5 1.5 0 0 0-3 0Zm7.5 3.75a1.5 1.5 0 1 0 3 0 1.5 1.5 0 0 0-3 0Zm-7.5 0a1.5 1.5 0 1 0 3 0 1.5 1.5 0 0 0-3 0Zm7.5 3.75a1.5 1.5 0 1 0 3 0 1.5 1.5 0 0 0-3 0Zm-7.5 0a1.5 1.5 0 1 0 3 0 1.5 1.5 0 0 0-3 0Z" />
    </svg>
  ),
  scheduled: (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5M4.5 4.5h11a1.5 1.5 0 0 1 1.5 1.5v8.25a1.5 1.5 0 0 1-1.5 1.5h-11a1.5 1.5 0 0 1-1.5-1.5V6a1.5 1.5 0 0 1 1.5-1.5Z" />
    </svg>
  ),
  sent: (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 12 3.269 3.125A59.769 59.769 0 0 1 21.485 12 59.768 59.768 0 0 1 3.27 20.875L5.999 12Zm0 0h7.5" />
    </svg>
  ),
  problem: (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m0 3.75h.008v.008H12v-.008ZM3.75 17.25h12.5a.75.75 0 0 0 .75-.75V6a.75.75 0 0 0-.75-.75h-2.25A2.25 2.25 0 0 1 12 4.5v-2.25a.75.75 0 0 0-.75-.75H7.5a.75.75 0 0 0-.75.75V4.5a2.25 2.25 0 0 1-2.25 2.25H3a.75.75 0 0 0-.75.75v9.75a.75.75 0 0 0 .75.75Z" />
    </svg>
  ),
}

/**
 * 每条队列记录的阻断/提示事实（只展示，绝不参与“执行”按钮判定）。
 * 后端 sanitize 只返回这些字段；硬阻断红标、需人工关注黄标均为展示层表达。
 */
function recordFacts(record: QueueRecord): Array<{ tone: 'blocker' | 'warning'; text: string; title: string }> {
  const facts: Array<{ tone: 'blocker' | 'warning'; text: string; title: string }> = []
  if (record.sendQueueStatus === 'blocked') facts.push({ tone: 'blocker', text: '已阻止', title: '该任务被门禁阻止，需人工处理。' })
  if (record.sendQueueStatus === 'send_failed') facts.push({ tone: 'blocker', text: '发送失败', title: '正式发送失败，需人工检查原因。' })
  if (record.deliveryStatus === 'formal_bounced') facts.push({ tone: 'blocker', text: '正式退信', title: '已确认正式退信，需更换联系人。' })
  if (record.sendQueueStatus === 'needs_manual_reconciliation') facts.push({ tone: 'warning', text: '需人工对账', title: '发送结果未知，需人工核对是否已发出。' })
  if (record.sendQueueStatus === 'needs_timezone_review') facts.push({ tone: 'warning', text: '时区待确认', title: '客户时区证据不足，需人工确认发送窗口。' })
  if (record.sendQueueStatus === 'needs_reschedule') facts.push({ tone: 'warning', text: '待重排', title: '当前计划时间不可执行，需重新排程。' })
  if (record.sendQueueStatus === 'pending_human_review' && record.pendingHumanReview) facts.push({ tone: 'warning', text: '内容重写失败·需人工', title: '草稿未通过内容质量门禁且自动重写未解决，需人工决定重写、退回或批准。' })
  if (record.sendErrorCode) facts.push({ tone: 'warning', text: `错误码 ${record.sendErrorCode}`, title: '发送错误码，供人工排查。' })
  return facts
}

export default function SendQueue() {
  const [data, setData] = useState<any>({ records: [], dashboard: { counts: {} } })
  const [filter, setFilter] = useState(() => {
    const requested = new URLSearchParams(window.location.search).get('status') || ''
    if (['active', 'pending', 'scheduled', 'sent', 'problem', 'history'].includes(requested)) return requested
    if (['needs_reschedule', 'send_failed', 'blocked', 'needs_manual_reconciliation', 'needs_timezone_review', 'paused', 'formal_bounced'].includes(requested)) return 'problem'
    return 'active'
  })
  const [error, setError] = useState('')
  const [session, setSession] = useState<OperatorSession | null>(null)
  const [manualRecovery, setManualRecovery] = useState('')
  const [manualRecoveryResult, setManualRecoveryResult] = useState('')
  const navigate = useNavigate()

  async function getOperatorSession(force = false) {
    if (!force && session && session.expiresAt > Date.now() + 5000) return session
    const response = await fetch(`${API_BASE}/api/formal-send-queue/operator-session`)
    const payload = await response.json()
    if (!response.ok) throw new Error(ERROR_ZH[payload.code] || '无法建立本机操作员会话')
    const next = payload as OperatorSession
    setSession(next)
    return next
  }

  async function authorizedFetch(path: string, init: RequestInit = {}) {
    const active = await getOperatorSession()
    const response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        ...init.headers,
        [FORMAL_OPERATOR_HEADER]: active.operatorToken,
        [FORMAL_CSRF_HEADER]: active.csrfToken,
      },
    })
    const payload = await response.json()
    if (!response.ok) throw new Error(ERROR_ZH[payload.code] || payload.code || '本机操作失败，请稍后重试')
    return payload
  }

  async function post(path: string, body: Record<string, unknown> = {}) {
    const payload = await authorizedFetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    await load()
    return payload
  }

  async function load() {
    try {
      const payload = await authorizedFetch('/api/formal-send-queue')
      setData(payload)
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '正式发送队列加载失败')
    }
  }

  async function openCustomer(record: QueueRecord) {
    if (!record.customerRouteRef) return
    try {
      const payload = await authorizedFetch(`/api/formal-send-queue/customer-route/${record.customerRouteRef}`)
      navigate(`/item/${encodeURIComponent(payload.customerId)}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法打开客户详情')
    }
  }

  async function executeDue() {
    try {
      await post('/api/formal-send-queue/execute-due')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '执行到期队列失败')
    }
  }

  async function submitManualRecovery() {
    try {
      const payload = await authorizedFetch('/api/zoho-replies/manual', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rawContent: manualRecovery }),
      })
      const parsed = payload.parsed || {}
      setManualRecoveryResult(parsed.bouncedEmail
        ? `已回写正式退信：${parsed.bouncedEmail} · ${parsed.bounceCode || '未提取错误码'} · ${parsed.bounceType === 'hard_bounce' ? '硬退信/需换联系人' : '临时失败/需复核'}`
        : '已回写正式客户回复并取消待跟进。')
      setManualRecovery('')
      await load()
    } catch (cause) {
      setManualRecoveryResult(cause instanceof Error ? cause.message : '人工回收失败')
    }
  }

  useEffect(() => { void load() }, [])
  const deliveryLabel = (value?: string) => formalOutreachStatusLabel(value as FormalOutreachStatus) || '未形成最终结果'
  const rows = useMemo(() => data.records.filter((record: QueueRecord) =>
    filter === 'history' ? record.recordScope === 'history'
      : record.recordScope === 'active' && (filter === 'active' || businessQueueGroup(record) === filter)), [data, filter])
  const records = data.records || []
  const statItems = [
    { label: '当前队列任务', value: data.dashboard?.activeQueueLength ?? 0 },
    { label: '已有发送记录', value: data.dashboard?.sentHistory ?? 0 },
    { label: '客户回信', value: records.filter((r: QueueRecord) => r.deliveryStatus === 'replied').length },
    { label: '退信需处理', value: records.filter((r: QueueRecord) => r.deliveryStatus === 'formal_bounced').length },
  ]

  return <div className="h-full overflow-y-auto bg-surface-50 p-6">
    <div className="mx-auto max-w-[1500px] space-y-5">
      <PageHead
        eyebrow="发送队列"
        title="正式发送队列"
        subtitle="人工批准后直接排程；到期任务进入正式发送队列。"
        actions={
          <div className="flex items-center gap-2"><button onClick={() => void post('/api/formal-send-queue/plan')} className="rounded-lg bg-accent-600 px-3 py-2 text-xs font-semibold text-white hover:bg-accent-700">对已批准草稿排程</button><details className="relative"><summary className="directory-control-button cursor-pointer list-none">更多操作</summary><div className="absolute right-0 z-20 mt-2 grid w-44 gap-1 rounded-xl border border-surface-200 bg-white p-2 shadow-lg"><button onClick={() => void executeDue()} className="rounded-lg px-3 py-2 text-left text-xs text-surface-700 hover:bg-surface-50">执行到期队列</button><button onClick={() => void load()} className="rounded-lg px-3 py-2 text-left text-xs text-surface-700 hover:bg-surface-50">刷新数据</button></div></details></div>
        }
      />
      {error && <div className="rounded bg-red-50 p-3 text-xs text-red-700">{error}</div>}
      <div className="flex flex-wrap gap-x-6 gap-y-2 rounded-xl border border-surface-200 bg-white px-4 py-3">{statItems.map(item => <div key={item.label} className="flex items-baseline gap-2"><span className="text-xs text-surface-500">{item.label}</span><strong className="text-base tabular-nums text-surface-900">{item.value}</strong></div>)}</div>
      <div className="flex items-center gap-2"><span className="text-xs text-surface-500">查看</span><select value={filter} onChange={event => setFilter(event.target.value)} className="rounded-lg border border-surface-200 bg-white px-3 py-2 text-xs text-surface-700"><option value="active">全部当前任务 · {data.dashboard?.activeQueueLength || 0}</option>{QUEUE_GROUPS.map(group => <option key={group.key} value={group.key}>{group.title}</option>)}<option value="history">历史台账 · {data.dashboard?.historyTotal || 0}</option></select></div>
      <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-white p-4 text-xs text-surface-600"><span>今日目标 {data.dashboard?.dailyTarget || 0}</span><span>已发送 {data.dashboard?.sentToday || 0}</span><span>已排期 {data.dashboard?.scheduledToday || 0}</span><span>剩余额度 {data.dashboard?.remainingQuota || 0}</span><span>系统标记：{data.dashboard?.paused ? '已暂停' : '未暂停'}（不代表发送器在线）</span></div>
      <details className="rounded-xl border border-surface-200 bg-white p-4">
        <summary className="cursor-pointer list-none text-sm font-semibold text-surface-700">人工回收退信或回复</summary>
        <p className="mt-1 text-xs text-amber-800">IMAP 不可用时，粘贴 Zoho 邮件原文。系统只匹配正式发送记录，并解析退信邮箱、错误码、软硬退信及后续动作。</p>
        <textarea value={manualRecovery} onChange={event => setManualRecovery(event.target.value)} rows={7} placeholder="粘贴完整邮件头和正文（建议包含 Message-ID、In-Reply-To、Final-Recipient、Diagnostic-Code）" className="mt-3 w-full rounded border border-amber-300 bg-white p-3 text-xs" />
        <div className="mt-2 flex items-center gap-3">
          <button type="button" disabled={manualRecovery.trim().length < 20} onClick={() => void submitManualRecovery()} className="rounded bg-amber-700 px-3 py-2 text-xs text-white disabled:opacity-40">解析并回写正式结果</button>
          {manualRecoveryResult && <span className="text-xs text-amber-900">{manualRecoveryResult}</span>}
        </div>
      </details>
      {rows.length === 0 ? (
        <EmptyState icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-9 w-9"><path strokeLinecap="round" strokeLinejoin="round" d="M6 12 3.269 3.125A59.769 59.769 0 0 1 21.485 12 59.768 59.768 0 0 1 3.27 20.875L5.999 12Zm0 0h7.5" /></svg>} title="暂无发送任务" description="当前筛选下没有发送任务；可批准草稿后在此排程执行。" />
      ) : (
        <div className="space-y-4">
          {(filter === 'history' ? [{ key: 'history', title: '历史台账', desc: '已完成或已停止的记录，仅供查证。' }] : QUEUE_GROUPS.filter(group => filter === 'active' || filter === group.key)).map(group => {
            const groupRows = rows.filter((record: QueueRecord) =>
              group.key === 'history'
                ? true
                : businessQueueGroup(record) === group.key)
            if (!groupRows.length) return null
            return (
              <section key={group.key} className="rounded-xl border border-surface-200 bg-white p-4 shadow-panel">
                <SectionHead icon={GROUP_ICONS[group.key] || GROUP_ICONS.sent} title={group.title} subtitle={group.desc} right={<span className="inline-flex h-6 items-center rounded-full bg-accent-50 px-2.5 text-xs font-medium tabular-nums text-accent-700">{groupRows.length} 条</span>} />
                <div className="grid gap-2">{groupRows.map((record: QueueRecord) => { const status = presentStatus(record.sendQueueStatus); const tone = group.key === 'sent' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : group.key === 'problem' ? 'bg-amber-50 text-amber-800 border-amber-200' : group.key === 'scheduled' ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-surface-100 text-surface-700 border-surface-200'; const facts = recordFacts(record); const bar = LEFT_BAR[record.sendQueueStatus] || 'bg-surface-300'; return <div key={record.publicRecordId} onClick={record.customerRouteRef ? () => void openCustomer(record) : undefined} className={`flex items-stretch gap-2.5 rounded-lg border border-surface-200 bg-white p-3.5 shadow-panel transition-all duration-200 hover:-translate-y-0.5 hover:border-accent-300 hover:shadow-card-hover${record.customerRouteRef ? ' cursor-pointer' : ''}`}><span className={`w-[5px] shrink-0 rounded-full ${bar}`} /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-x-2 gap-y-1"><h3 className="truncate text-sm font-semibold text-surface-900">{record.campaignLabel || '发送任务'}</h3><span className={`inline-flex h-6 shrink-0 items-center rounded-full px-2.5 text-xs font-medium ${tone}`} title={`${status.label}：${status.tooltip}`}>{group.title}</span><span className="inline-flex h-6 shrink-0 items-center rounded-full bg-surface-100 px-2.5 text-xs font-medium text-surface-600">{deliveryLabel(record.deliveryStatus)}</span></div><div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-surface-500">{record.scheduledSendAt ? <span>计划：{record.scheduledSendAt}</span> : null}{record.actualSentAt ? <span>已发送：{record.actualSentAt}</span> : null}</div><details className="mt-2 text-xs text-surface-500"><summary className="cursor-pointer list-none font-medium text-surface-600">查看处理详情</summary><div className="mt-2 flex flex-wrap gap-1.5"><span className="rounded bg-surface-100 px-2.5 py-1">系统状态：{status.label}</span>{facts.map(fact => <span key={fact.text} title={fact.title} className={`inline-flex min-h-6 items-center rounded-full px-2.5 text-xs font-medium ${fact.tone === 'blocker' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-700'}`}>{fact.text}</span>)}{record.sendAttemptCount ? <span className="rounded bg-surface-100 px-2.5 py-1">尝试 {record.sendAttemptCount} 次</span> : null}{record.sendErrorCode ? <span className="rounded bg-surface-100 px-2.5 py-1">错误码 {record.sendErrorCode}</span> : null}</div></details></div></div> })}
                </div>
              </section>
            )
          })}
        </div>
      )}
    </div>
  </div>
}
