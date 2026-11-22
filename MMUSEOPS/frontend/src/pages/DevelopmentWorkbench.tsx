import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { getAllItems, loadFromDisk, saveItem } from '../store/db'
import { PaginationBar, usePagination } from '../components/Pagination'
import CustomerJudgmentCard from '../components/CustomerJudgmentCard'
import {
  getItemEmails,
  getPrimaryEmail,
  hasPersonalEmail,
  isPublicEmail,
} from '../services/workflowStage'
import { sortByLeadGrade } from '../services/leadScoring'
import { getLeadStageEligibility } from '../services/leadStageEligibility'
import { presentBoolean, presentStatus } from '../services/presentation'
import { applyHumanBackcheckApproval } from '../services/backcheckAutoRouting'
import { restoreIsolatedWorkflowItem } from '../services/resendHistoryBackfill'
import type { PipelineItem } from '../types/item'
import { batchBackcheckItems } from '../services/firecrawlService'
import PageHead from '../components/PageHead'
import SectionHead from '../components/SectionHead'
import EmptyState from '../components/EmptyState'
import { cardForItem } from '../services/crmCardRouting'
import { isSearchPoolItem } from '../services/searchPool'

type WorkTab = 'backcheck_queue' | 'contact_mining' | 'inactive_excluded'
type FilterKey = 'all' | 's' | 'personal' | 'public' | 'risk' | 'missing_contact'

const BUSINESS_LABELS: Record<string, string> = {
  furniture: '商用家具',
  'car-seat': '汽车座椅套',
  lighting: '照明',
  packaging: '包装',
  home: '家居日用',
  both: '综合',
}

const INACTIVE_LABELS: Record<string, string> = {
  permanent_do_not_develop: '永久不开发',
  irrelevant: '无关数据',
  duplicate: '重复数据',
  unreachable: '不可达数据',
  low_value_hold: '低价值暂存',
  insufficient: '信息不足',
}

const TAB_HINTS: Record<WorkTab, string> = {
  backcheck_queue: '待背调（含无网站，由公司名+国家兜底）',
  contact_mining: '已背调，缺少可用邮箱',
  inactive_excluded: '隔离/排除/低价值数据，仅用于去重和人工恢复',
}

const STAGE_LABELS: Record<WorkTab, string> = {
  backcheck_queue: '背调队列',
  contact_mining: '联系人挖掘',
  inactive_excluded: '隔离/排除数据',
}

const STAGE_RAIL: Record<string, string> = {
  backcheck_queue: 'bg-blue-500',
  data_enrichment_needed: 'bg-blue-400',
  manual_review: 'bg-amber-500',
  contact_mining_queue: 'bg-amber-400',
  email_validation_queue: 'bg-cyan-500',
  observation_queue: 'bg-cyan-400',
  developable_email_pool: 'bg-emerald-500',
  followup_queue: 'bg-emerald-400',
  replied_queue: 'bg-accent-500',
  replace_contact_queue: 'bg-red-500',
  true_excluded: 'bg-surface-300',
}

/** 区块标题用的小图标（24 视口描边线条，SectionHead 图标章内使用） */
function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

function displayName(item: PipelineItem): string {
  return item.company || item.title || item.website || item.id
}

function hasDecisionSignal(item: PipelineItem): boolean {
  if (item.contactName?.trim()) return true
  const contacts = Array.isArray((item as any).contacts) ? (item as any).contacts : []
  if (contacts.some((contact: any) => contact?.name || contact?.title || contact?.email)) return true
  return Boolean(item.backCheck?.decisionMakers?.some(person => person.name || person.title || person.email))
}

function riskNotes(item: PipelineItem): string[] {
  const text = `${item.country || ''} ${item.backCheck?.summary || ''} ${item.snippet || ''}`.toLowerCase()
  const notes: string[] = []
  if (/india|印度/.test(text)) notes.push('印度：收款与尾款节点需人工确认')
  if (/brazil|巴西/.test(text)) notes.push('巴西：清关、税费与进口资质需确认')
  if (/iran|iraq|syria|yemen|israel|palestine|lebanon|ukraine|russia|中东|战争/.test(text)) notes.push('区域风险：物流、保险、收款和交期需确认')
  if (/united states|usa|america|美国/.test(text)) notes.push('美国：关注关税与本地供应商压力')
  if (/australia|澳洲|澳大利亚/.test(text)) notes.push('澳洲：适合中小进口商，注意认证要求')
  return notes
}

function filterItems(items: PipelineItem[], filter: FilterKey): PipelineItem[] {
  if (filter === 's') return items.filter(item => item.leadGrade === 'S')
  if (filter === 'personal') return items.filter(hasPersonalEmail)
  if (filter === 'public') return items.filter(item => {
    const emails = getItemEmails(item)
    return emails.length > 0 && emails.every(isPublicEmail)
  })
  if (filter === 'risk') return items.filter(item => riskNotes(item).length > 0)
  if (filter === 'missing_contact') return items.filter(item => !hasDecisionSignal(item))
  return items
}

function StageCard({ label, count, hint, active, onClick, tone = 'slate' }: {
  label: string
  count: number
  hint: string
  active?: boolean
  onClick: () => void
  tone?: 'slate' | 'blue' | 'amber' | 'emerald' | 'red'
}) {
  const tones = {
    slate: 'border-surface-200 hover:border-surface-300',
    blue: 'border-blue-200 hover:border-blue-300',
    amber: 'border-amber-200 hover:border-amber-300',
    emerald: 'border-emerald-200 hover:border-emerald-300',
    red: 'border-red-200 hover:border-red-300',
  }
  return (
    <button onClick={onClick} className={`min-h-[96px] rounded-lg border bg-white p-3 text-left shadow-panel hover:border-accent-300 ${active ? 'ring-2 ring-accent-100 border-accent-500' : tones[tone]}`}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-semibold text-surface-800">{label}</span>
        <span className="text-xl font-bold tabular-nums text-surface-900">{count}</span>
      </div>
      <p className="mt-2 text-xs leading-4 text-surface-500">{hint}</p>
    </button>
  )
}

export type ManualReviewAction = 'needs_recheck' | 'insufficient' | 'paused' | 'do_not_develop' | 'completed' | 'contact_mining'

export function buildManualSearchSuggestions(item: Pick<PipelineItem, 'company' | 'title' | 'country'>): string[] {
  const company = (item.company || item.title || '').trim() || '公司名'
  const country = (item.country || '').trim()
  return [
    `${company}${country ? ` ${country}` : ''}`,
    `${company} furniture`,
    `${company} restaurant furniture`,
    `${company} hotel furniture`,
    `${company} contact`,
    `${company} LinkedIn`,
    `${company} Facebook`,
    `${company} import`,
    `${company} ImportYeti`,
  ]
}

export function buildManualReviewUpdate(item: PipelineItem, action: ManualReviewAction, reason: string, website: string, summary: string): PipelineItem {
  const now = new Date()
  const at = now.toISOString()
  const permanent = action === 'do_not_develop'
  const paused = action === 'paused'
  const completed = action === 'completed' || action === 'contact_mining'
  const requiresReview = action === 'needs_recheck' || action === 'insufficient'
  const prepared: PipelineItem = {
    ...item,
    website: website.trim() || item.website,
    backCheck: completed ? { ...(item.backCheck || { checkedAt: at }), checkedAt: at, summary: summary.trim() || item.backCheck?.summary || '' } : item.backCheck,
    backcheckStatus: completed ? 'done' : requiresReview ? 'pending' : item.backcheckStatus,
    currentStageId: requiresReview ? 'otr-backcheck' : completed ? 'otr-contact' : item.currentStageId,
    reviewDisposition: permanent ? 'do_not_develop' : paused ? 'paused' : requiresReview ? action : item.reviewDisposition,
    reviewReason: reason,
    reviewUpdatedAt: at,
    doNotDevelop: permanent,
    excludedAt: permanent ? at : item.excludedAt,
    status: permanent || paused ? 'archived' : 'active',
    developmentStatus: permanent || paused ? 'shelved' : completed ? 'backcheck_done' : 'pending',
    updatedAt: at,
    timeline: requiresReview || completed ? [...(item.timeline || []), { stageId: requiresReview ? 'otr-backcheck' : 'otr-contact', enteredAt: at }] : item.timeline,
  }
  return completed ? applyHumanBackcheckApproval(prepared, reason, now) : prepared
}

export function buildBatchHumanBackcheckApproval(item: PipelineItem, reason: string, now = new Date()): PipelineItem {
  return applyHumanBackcheckApproval(item, reason, now)
}
export default function DevelopmentWorkbench() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [items, setItems] = useState<PipelineItem[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<WorkTab>(() => searchParams.get('tab') === 'contact_mining' ? 'contact_mining' : searchParams.get('tab') === 'inactive_excluded' ? 'inactive_excluded' : 'backcheck_queue')
  const [filter, setFilter] = useState<FilterKey>('all')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [activeId, setActiveId] = useState('')
  const [manualEmail, setManualEmail] = useState('')
  const [manualWebsite, setManualWebsite] = useState('')
  const [manualSummary, setManualSummary] = useState('')
  const [manualReason, setManualReason] = useState('需要人工核查')
  const [manualNotice, setManualNotice] = useState('')
  const [batchAutoProgress, setBatchAutoProgress] = useState<{ running: boolean; current: string; done: number; total: number; success: number; failed: number } | null>(null)
  const hasPickedInitialTab = useRef(false)

  async function reload() {
    setLoading(true)
    await loadFromDisk().catch(() => 0)
    const loadedItems = await getAllItems()
    setItems(loadedItems)
    if (!hasPickedInitialTab.current) {
      hasPickedInitialTab.current = true
      const hasBackcheckQueue = loadedItems.some(item => ['backcheck_queue', 'data_enrichment_needed', 'manual_review'].includes(String((item as any)?.primaryStage || (item as any)?.normalizedStage || (item as any)?.operationalTier || '')))
      const hasContactMining = loadedItems.some(item => String((item as any)?.primaryStage || (item as any)?.normalizedStage || (item as any)?.operationalTier || '') === 'contact_mining_queue')
      if (!hasBackcheckQueue && hasContactMining) setTab('contact_mining')
    }
    setLoading(false)
  }

  useEffect(() => { void reload() }, [])
  useEffect(() => {
    setFilter('all')
    setSelectedIds(new Set())
    setActiveId('')
  }, [tab])

  const counts = useMemo(() => {
    const result: Record<string, number> = {
      search_new: 0, backcheck_queue: 0, contact_mining: 0, email_verification: 0, observation: 0,
      development_ready: 0, send_ready: 0, followup_sent: 0, replied: 0, bounced: 0, nurture: 0, invalid: 0,
      archived: 0, data_issue: 0, a_pool: 35,
    }
    for (const item of items) {
      const card = cardForItem(item)
      if (card) { result[card === 'excluded' ? 'invalid' : card]++; continue }
      if (isSearchPoolItem(item)) result.search_new++
    }
    return result
  }, [items])

  const stageItems = useMemo(() => sortByLeadGrade(items.filter(item => {
    const card = cardForItem(item)
    if (tab === 'inactive_excluded') return card === 'excluded'
    if (tab === 'contact_mining') return card === 'contact_mining'
    const requestedStage = searchParams.get('stage')
    if (requestedStage && ['backcheck_queue', 'data_enrichment_needed', 'manual_review'].includes(requestedStage)) {
      return String((item as any)?.primaryStage || '') === requestedStage
    }
    return card === 'backcheck_queue'
  })), [items, tab, searchParams])
  const filtered = useMemo(() => filterItems(stageItems, filter), [stageItems, filter])
  const { page, setPage, pageCount, pageItems, pageSize } = usePagination(filtered, 30)
  const active = items.find(item => item.id === activeId) || pageItems[0]
  const allPageSelected = pageItems.length > 0 && pageItems.every(item => selectedIds.has(item.id))

  useEffect(() => {
    if (pageItems.length && !pageItems.some(item => item.id === activeId)) setActiveId(pageItems[0].id)
  }, [pageItems, activeId])
  useEffect(() => {
    setManualWebsite(active?.website || '')
    setManualSummary(active?.backCheck?.summary || '')
    setManualReason(active?.reviewReason || '需要人工核查')
    setManualNotice('')
  }, [active?.id])

  function toggleItem(id: string) {
    setSelectedIds(previous => {
      const next = new Set(previous)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function togglePage() {
    setSelectedIds(previous => {
      const next = new Set(previous)
      pageItems.forEach(item => allPageSelected ? next.delete(item.id) : next.add(item.id))
      return next
    })
  }

  async function applyManualAction(action: ManualReviewAction) {
    if (!active) return
    const updated = buildManualReviewUpdate(active, action, manualReason, manualWebsite, manualSummary)
    await saveItem(updated)
    setManualNotice(action === 'do_not_develop' ? '已永久排除，原记录已保留。' : action === 'paused' ? '已标记暂不开发。' : action === 'completed' || action === 'contact_mining' ? '人工背调结果已保存，不会调用外部服务。' : '已保存人工核查状态。')
    await reload()
  }

  async function saveManualWebsite() {
    if (!active || !manualWebsite.trim()) return
    await saveItem({ ...active, website: manualWebsite.trim(), reviewReason: manualReason, reviewUpdatedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
    setManualNotice('官网已手动保存，归属仍需人工确认。')
    await reload()
  }

  async function applyBatchManualAction(action: 'completed' | 'needs_recheck' | 'paused' | 'do_not_develop') {
    const targets = pageItems.filter(item => selectedIds.has(item.id))
    const destinations = { completed: 'contact_mining_queue', needs_recheck: 'deep_backcheck_queue', paused: 'paused_review_queue', do_not_develop: 'do_not_develop' }
    if (!window.confirm(`本次将处理 ${targets.length} 个客户并进入“${presentStatus(destinations[action]).label}”。是否继续？`)) return
    const eligibleTargets = action === 'completed'
      ? targets
          .map(item => buildBatchHumanBackcheckApproval(item, manualReason))
          .filter(approved => getLeadStageEligibility(approved).canEnterContactMining)
      : targets
    for (const item of eligibleTargets) {
      const updated = action === 'completed'
        ? item
        : buildManualReviewUpdate(item, action, manualReason, item.website || '', item.backCheck?.summary || '') as any
      if (action === 'needs_recheck') { updated.normalizedStage = 'deep_backcheck_queue'; updated.currentAllowedStage = 'deep_backcheck_queue'; updated.inactiveWorkflow = true; updated.activeWorkflow = false }
      await saveItem(updated)
    }
    setSelectedIds(new Set())
    setManualNotice(`已处理 ${eligibleTargets.length} 个客户；另有 ${targets.length - eligibleTargets.length} 个未满足准入条件，未做变更。`)
    await reload()
  }

  async function executeBatchBackcheck() {
    const targets = stageItems.filter(item => selectedIds.size > 0 ? selectedIds.has(item.id) : true)
    if (!window.confirm(`自动背调将使用 AI 抓取官网并提取结构化数据（${targets.length} 条）。不发送邮件，不调用外部搜索。是否继续？`)) return
    setBatchAutoProgress({ running: true, current: '', done: 0, total: targets.length, success: 0, failed: 0 })
    const { success, failed } = await batchBackcheckItems(targets, progress => {
      setBatchAutoProgress({ running: true, current: progress.current, done: progress.done, total: progress.total, success: progress.success, failed: progress.failed })
    })
    setBatchAutoProgress(null)
    setManualNotice(`自动背调完成：成功 ${success} 条，失败 ${failed} 条。不完整数据会自动退回。`)
    await reload()
  }

  async function restoreIsolated(target: 'backcheck_queue' | 'contact_mining_queue' | 'email_validation_queue') {
    if (!active || tab !== 'inactive_excluded') return
    const reason = window.prompt('请输入恢复原因（必填）')?.trim() || ''
    if (!reason) return
    try {
      await saveItem(restoreIsolatedWorkflowItem(active, target, reason))
      await reload()
    } catch (error) {
      window.alert(error instanceof Error ? error.message : '恢复失败')
    }
  }

  async function saveManualEmail() {
    if (!active) return
    const email = manualEmail.trim()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return
    const contacts = Array.isArray((active as any).contacts) ? [...(active as any).contacts] : []
    if (!contacts.some((contact: any) => contact?.email?.toLowerCase() === email.toLowerCase())) contacts.push({ email, source: 'manual' })
    await saveItem({ ...active, email: active.email || email, contacts, updatedAt: new Date().toISOString() } as PipelineItem)
    setManualEmail('')
    await reload()
  }

  const stageActions = [
    { key: 'a_pool', label: 'A 可人工审核', hint: '35家已背调，人工确认后发送', tone: 'emerald' as const, onClick: () => navigate('/a-review') },
    { key: 'search_new', label: '新客户', hint: '新客户保留在搜索池', tone: 'slate' as const, onClick: () => navigate('/search-workbench#pool') },
    { key: 'backcheck_queue', label: '背调队列', hint: TAB_HINTS.backcheck_queue, tone: 'blue' as const, onClick: () => navigate('/crm-card/backcheck_queue') },
    { key: 'contact_mining', label: '联系人挖掘', hint: TAB_HINTS.contact_mining, tone: 'amber' as const, onClick: () => navigate('/crm-card/contact_mining') },
    { key: 'development_ready', label: '可开发池', hint: '查看可进入开发的客户', tone: 'emerald' as const, onClick: () => navigate('/crm-card/development_ready') },
    { key: 'send_ready', label: '待发送', hint: '草稿已审查，等待发送', tone: 'emerald' as const, onClick: () => navigate('/crm-card/send_ready') },
    { key: 'followup_sent', label: '已发送待跟进', hint: '第3天和第7天自动跟进', tone: 'blue' as const, onClick: () => navigate('/crm-card/followup_sent') },
    { key: 'replied', label: '已回复待处理', hint: '真实回信已写入 CRM', tone: 'blue' as const, onClick: () => navigate('/crm-card/replied') },
    { key: 'bounced', label: '需换联系人', hint: '退信或不可达，回到联系人挖掘', tone: 'red' as const, onClick: () => navigate('/crm-card/bounced') },
    { key: 'nurture', label: '培育池', hint: '中匹配保留等待', tone: 'slate' as const, onClick: () => navigate('/crm-card/nurture') },
  ] as const

  return (
    <div className="h-full min-h-0 overflow-hidden bg-surface-50">
      <div className="mx-auto flex h-full max-w-[1440px] min-h-0 flex-col px-4 py-4 md:px-6">
        <PageHead
          eyebrow="客户推进"
          title="客户推进工作台"
          subtitle="选择一个处理队列，查看客户并完成当前动作。"
          actions={<button onClick={reload} className="shrink-0 rounded-lg border border-surface-200 bg-white px-3 py-2 text-xs font-semibold text-surface-700 shadow-panel hover:bg-surface-50">刷新数据</button>}
        />

        <div className="mb-3 flex shrink-0 flex-wrap items-center gap-3 rounded-xl border border-surface-200 bg-white p-3">
          <label className="text-xs font-medium text-surface-500" htmlFor="development-queue">快速打开队列</label>
          <select id="development-queue" defaultValue="" onChange={event => { const target = stageActions.find(card => card.key === event.target.value); target?.onClick(); if (event.target.value === 'inactive_excluded') navigate('/crm-card/excluded') }} className="min-w-[220px] rounded-lg border border-surface-200 bg-white px-3 py-2 text-sm text-surface-800">
            <option value="" disabled>{STAGE_LABELS[tab]} · {filtered.length} 条</option>
            {stageActions.map(card => <option key={card.key} value={card.key}>{card.label} · {counts[card.key]}</option>)}
            <option value="inactive_excluded">隔离/排除数据 · {counts.invalid}</option>
          </select>
          <span className="text-xs text-surface-500">当前：{STAGE_LABELS[tab]} · {filtered.length} 条；选择其他项会打开该队列完整列表</span>
        </div>

        <div className="mb-3 flex shrink-0 flex-wrap items-center gap-2 border-y border-surface-200 bg-white px-3 py-2">
          <select value={filter} onChange={event => setFilter(event.target.value as FilterKey)} className="rounded-lg border border-surface-200 bg-white px-3 py-1.5 text-xs text-surface-700">
            {([['all', '全部客户'], ['s', 'S 级客户'], ['personal', '个人邮箱'], ['public', '公共邮箱'], ['risk', '地区预警'], ['missing_contact', '缺联系人']] as [FilterKey, string][]).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
          <span className="ml-auto text-xs text-surface-500">{tab === 'inactive_excluded' ? '隔离/排除数据' : tab === 'contact_mining' ? '联系人挖掘' : '背调队列'} {filtered.length} 条，已选 {selectedIds.size} 条</span>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1.25fr)_340px]">
          <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-surface-200 bg-white shadow-panel">
            <SectionHead
              icon={<Icon d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />}
              title={STAGE_LABELS[tab]}
              titleTag=""
              right={<span className="rounded-full bg-accent-50 px-2.5 py-1 text-xs font-semibold tabular-nums text-accent-700">{filtered.length} 条</span>}
              className="px-3.5 pt-3"
            />
            <div className="flex shrink-0 items-center justify-between border-y border-surface-200 px-3.5 py-2">
              <label className="flex items-center gap-2 text-xs text-surface-600"><input type="checkbox" checked={allPageSelected} onChange={togglePage} />选择本页</label>
              <div className="flex items-center gap-2">
                {tab === 'backcheck_queue' && <div className="flex items-center gap-2"><button type="button" onClick={executeBatchBackcheck} disabled={Boolean(batchAutoProgress?.running)} className="rounded bg-accent-600 px-2 py-1 text-[10px] font-semibold text-white disabled:opacity-40">批量自动背调</button>{batchAutoProgress?.running && <span className="text-[10px] text-indigo-700">{batchAutoProgress.current} ({batchAutoProgress.done}/{batchAutoProgress.total})</span>}</div>}
                {tab === 'backcheck_queue' && selectedIds.size > 0 && <div className="max-w-3xl rounded border border-amber-200 bg-amber-50 p-2"><p className="text-[11px] font-semibold text-amber-800">批量人工处理建议：安全模式下不执行真实背调</p><div className="mt-1 flex flex-wrap gap-1"><button type="button" onClick={() => applyBatchManualAction('completed')} className="rounded bg-emerald-600 px-2 py-1 text-[10px] font-semibold text-white">批量通过进入联系人挖掘</button><button type="button" onClick={() => applyBatchManualAction('needs_recheck')} className="rounded bg-blue-600 px-2 py-1 text-[10px] font-semibold text-white">标记需人工核查</button><button type="button" onClick={() => applyBatchManualAction('paused')} className="rounded border border-surface-300 bg-white px-2 py-1 text-[10px] text-surface-700">标记暂不开发</button><button type="button" onClick={() => applyBatchManualAction('do_not_develop')} className="rounded bg-red-600 px-2 py-1 text-[10px] font-semibold text-white">标记永久不开发</button></div></div>}
                <span className="text-xs text-surface-500">第 {page}/{pageCount} 页</span>
              </div>
            </div>
            <div className="shrink-0 border-b border-surface-100 px-3"><PaginationBar page={page} pageCount={pageCount} total={filtered.length} pageSize={pageSize} onPageChange={setPage} /></div>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
              {loading ? (
                <div className="p-10 text-center text-sm text-surface-400">加载中…</div>
              ) : pageItems.length === 0 ? (
                <EmptyState
                  icon={<Icon d="M20 12v10H4V12M2 7h20v5H2zM12 22v-7M12 12v-3M12 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" />}
                  title={tab === 'contact_mining' ? '暂无待挖掘联系人' : tab === 'inactive_excluded' ? '暂无隔离/排除数据' : '本阶段暂无客户'}
                  description={tab === 'contact_mining' ? '已背调但缺少可用邮箱的客户会进入此队列，请填写合适的联系邮箱。' : TAB_HINTS[tab]}
                />
              ) : pageItems.map(item => {
                const emails = getItemEmails(item)
                const risks = riskNotes(item)
                const stage = String((item as any)?.primaryStage || (item as any)?.normalizedStage || (item as any)?.operationalTier || '')
                const rail = STAGE_RAIL[stage] || 'bg-accent-500'
                return (
                  <div key={item.id} className="group flex items-start gap-3 rounded-lg border border-surface-200 bg-white p-3 shadow-panel hover:border-accent-300">
                    <div className={`mt-1.5 w-1 flex-shrink-0 self-stretch rounded-full ${rail}`} />
                    <button type="button" onClick={() => setActiveId(item.id)} className="min-w-0 flex-1 text-left">
                      <h3 className="truncate text-sm font-semibold text-surface-900">{displayName(item)}</h3>
                      <p className="mt-1 text-xs text-surface-500">{item.country || '未知国家'} · {BUSINESS_LABELS[item.businessLine] || presentStatus(item.businessLine).label}</p>
                      <p className="mt-0.5 truncate text-xs text-surface-400">{emails.length ? emails.join(' / ') : tab === 'contact_mining' ? '暂无邮箱，需要补充联系人' : item.website || '暂无网站'}</p>
                      {risks.length > 0 && <p className="mt-1 truncate text-[11px] text-red-600">{risks[0]}</p>}
                    </button>
                    <div className="flex flex-shrink-0 flex-col items-end gap-2">
                      <input type="checkbox" checked={selectedIds.has(item.id)} onClick={event => event.stopPropagation()} onChange={() => toggleItem(item.id)} className="mt-1 accent-accent-500" />
                    </div>
                  </div>
                )
              })}
            </div>
            <div className="shrink-0 border-t border-surface-100 px-3"><PaginationBar page={page} pageCount={pageCount} total={filtered.length} pageSize={pageSize} onPageChange={setPage} /></div>
          </section>

          <aside className="min-h-0 overflow-y-auto rounded-xl border border-surface-200 bg-white p-3.5 shadow-panel">
            {!active ? <p className="p-6 text-center text-sm text-surface-400">选择左侧客户查看详情</p> : (
              <div className="space-y-4">
                <div>
                  <h2 className="text-lg font-bold text-surface-900">{displayName(active)}</h2>
                  <p className="mt-1 text-xs text-surface-500">{presentStatus(String((active as any)?.primaryStage || (active as any)?.normalizedStage || (active as any)?.operationalTier || '')).label} · {BUSINESS_LABELS[active.businessLine] || presentStatus(active.businessLine).label}</p>
                </div>
                {tab === 'inactive_excluded' && (
                  <div className="space-y-2 rounded-lg border border-red-200 bg-red-50 p-3">
                    <p className="text-xs font-semibold text-red-800">排除类型：{INACTIVE_LABELS[active.inactiveCategory || ''] || (active.inactiveCategory ? presentStatus(active.inactiveCategory).label : '隔离数据')} · {active.inactiveReason || '待人工复核'}</p>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" onClick={() => restoreIsolated('backcheck_queue')} className="rounded bg-blue-600 px-3 py-2 text-xs font-semibold text-white">恢复到背调池</button>
                      <button type="button" onClick={() => restoreIsolated('contact_mining_queue')} className="rounded bg-amber-600 px-3 py-2 text-xs font-semibold text-white">恢复到联系人挖掘</button>
                    </div>
                  </div>
                )}
                <CustomerJudgmentCard item={active} compact />
                <div className="rounded-lg border border-accent-200 bg-accent-50/50 p-3">
                  <p className="text-[11px] font-medium text-accent-700">下一步</p>
                  <p className="mt-1 text-sm font-semibold text-surface-900">{presentStatus((active as any).recommendedAction || active.nextRequiredAction || 'manual_review').label}</p>
                  <p className="mt-1 text-xs leading-5 text-surface-600">{tab === 'contact_mining' ? '补充联系人邮箱并保存。' : tab === 'inactive_excluded' ? '确认是否恢复到业务队列。' : '核对公司真实性、业务匹配和联系方式，再记录处理结论。'}</p>
                </div>
                {active.website && <button onClick={() => window.open(active.website!.startsWith('http') ? active.website : `https://${active.website}`, '_blank')} className="w-full rounded-lg border border-surface-200 bg-white px-3 py-2 text-sm font-semibold text-surface-700">打开网站</button>}
                <details className="rounded-lg border border-surface-200 bg-white p-3">
                  <summary className="cursor-pointer list-none text-sm font-medium text-surface-700">查看完整资料并处理</summary>
                  <div className="mt-4 space-y-4">
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="border border-surface-200 p-2"><p className="text-surface-400">国家</p><p className="mt-1 font-semibold text-surface-800">{active.country || '-'}</p></div>
                  <div className="border border-surface-200 p-2"><p className="text-surface-400">客户评分</p><p className="mt-1 font-semibold text-surface-800">{active.leadGrade || 'D'} / {active.leadScore || 0}</p></div>
                  <div className="border border-surface-200 p-2"><p className="text-surface-400">联系人</p><p className="mt-1 font-semibold text-surface-800">{hasDecisionSignal(active) ? '已有线索' : '待挖掘'}</p></div>
                  <div className="border border-surface-200 p-2"><p className="text-surface-400">邮箱</p><p className="mt-1 font-semibold text-surface-800">{getItemEmails(active).length || '无'}</p></div>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="border border-surface-200 p-2"><p className="text-surface-400">业务匹配</p><p className="mt-1 font-semibold text-surface-800">{presentStatus((active as any).businessMatch || 'unknown').label}</p></div>
                  <div className="border border-surface-200 p-2"><p className="text-surface-400">商业价值</p><p className="mt-1 font-semibold text-surface-800">{presentStatus((active as any).importCommercialValue || 'unknown').label}</p></div>
                  <div className="border border-surface-200 p-2"><p className="text-surface-400">是否退信</p><p className="mt-1 font-semibold text-surface-800">{presentBoolean(active.emailBounced)}</p></div>
                  <div className="border border-surface-200 p-2"><p className="text-surface-400">处置状态</p><p className="mt-1 font-semibold text-surface-800">{presentStatus(active.reviewDisposition || 'active').label}</p></div>
                  <div className="border border-surface-200 p-2"><p className="text-surface-400">推荐动作</p><p className="mt-1 font-semibold text-surface-800">{presentStatus((active as any).recommendedAction || active.nextRequiredAction || 'manual_review').label}</p></div>
                </div>

                {tab === 'backcheck_queue' && (
                  <div className="space-y-3">
                    <section className="rounded-lg border border-blue-200 bg-blue-50 p-3">
                      <h3 className="text-xs font-bold text-blue-900">人工背调步骤</h3>
                      <ol className="mt-2 space-y-1 text-[11px] leading-5 text-blue-800"><li>1. 确认公司是否真实存在</li><li>2. 查找并核对官网归属</li><li>3. 判断是否为家具、餐饮、酒店或商业家具相关客户</li><li>4. 查找联系人和工作邮箱</li><li>5. 补充中文背调摘要</li><li>6. 决定继续开发、退回、暂不开发或永久不开发</li></ol>
                    </section>
                    <section className="rounded-lg border border-surface-200 bg-surface-50 p-3">
                      <h3 className="text-xs font-bold text-surface-800">建议搜索关键词（仅供复制后人工查询）</h3>
                      <div className="mt-2 space-y-1">{buildManualSearchSuggestions(active).map(query => <button key={query} type="button" onClick={() => navigator.clipboard?.writeText(query)} className="block w-full rounded border border-surface-200 bg-white px-2 py-1 text-left text-[10px] text-surface-600 hover:border-blue-300">{query}</button>)}</div>
                    </section>
                    <section className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
                      <h3 className="text-xs font-bold text-amber-900">人工背调记录</h3>
                      <input value={manualWebsite} onChange={event => setManualWebsite(event.target.value)} placeholder="手动补充官网" className="w-full rounded border border-amber-200 bg-white px-3 py-2 text-xs" />
                      <button type="button" onClick={saveManualWebsite} disabled={!manualWebsite.trim()} className="rounded border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold text-amber-700 disabled:opacity-50">保存官网</button>
                      <textarea value={manualSummary} onChange={event => setManualSummary(event.target.value)} rows={5} placeholder="补充中文背调摘要" className="w-full rounded border border-amber-200 bg-white px-3 py-2 text-xs resize-y" />
                      <select value={manualReason} onChange={event => setManualReason(event.target.value)} className="w-full rounded border border-amber-200 bg-white px-3 py-2 text-xs">{['无官网', '来源不明', '疑似黄页/目录/榜单/新闻页', '背调摘要不足', '邮箱归属不明', '客户类型不明确', '需要人工核查', '与目标家具业务无关', '重复垃圾数据'].map(reason => <option key={reason}>{reason}</option>)}</select>
                      <div className="flex flex-wrap gap-2"><button type="button" onClick={() => applyManualAction('needs_recheck')} className="rounded bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white">标记需人工核查</button><button type="button" onClick={() => applyManualAction('insufficient')} className="rounded border border-amber-300 bg-white px-3 py-1.5 text-xs text-amber-700">标记信息不足</button><button type="button" onClick={() => applyManualAction('paused')} className="rounded border border-surface-300 bg-white px-3 py-1.5 text-xs text-surface-700">暂不开发</button><button type="button" onClick={() => applyManualAction('do_not_develop')} className="rounded bg-red-600 px-3 py-1.5 text-xs font-semibold text-white">永久不开发</button><button type="button" onClick={() => applyManualAction('completed')} className="rounded bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white">已人工背调完成</button><button type="button" onClick={() => applyManualAction('contact_mining')} className="rounded bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white">进入联系人挖掘</button></div>
                      {manualNotice && <p className="text-[11px] text-emerald-700">{manualNotice}</p>}
                    </section>
                    <section className="rounded-lg border border-red-200 bg-red-50 p-3 text-[11px] leading-5 text-red-800"><p className="font-bold">受控自动背调：当前安全模式下已禁用</p><p>自动背调会调用外部搜索/背调服务并可能消耗额度，必须由用户单独确认；启用后建议每次仅处理 3–5 条。</p></section>
                  </div>
                )}                {tab === 'contact_mining' && (
                  <div className="space-y-2 border border-amber-200 bg-amber-50 p-3">
                    <p className="text-xs font-semibold text-amber-800">补充联系人邮箱后，在客户记录中继续处理。</p>
                    <input value={manualEmail} onChange={event => setManualEmail(event.target.value)} placeholder="联系人邮箱" className="w-full rounded-md border border-amber-200 bg-white px-3 py-2 text-sm" />
                    <button onClick={saveManualEmail} className="w-full rounded-md bg-amber-600 px-3 py-2 text-sm font-semibold text-white">保存联系人邮箱</button>
                  </div>
                )}

                <div>
                  <p className="mb-2 text-xs font-semibold text-surface-700">邮箱与联系人</p>
                  <div className="space-y-1">
                    {getItemEmails(active).length ? getItemEmails(active).map(email => <div key={email} className="break-all border border-surface-200 bg-surface-50 px-2 py-1.5 text-xs text-surface-700">{email}</div>) : <p className="text-xs text-surface-400">暂无有效邮箱</p>}
                  </div>
                </div>

                {riskNotes(active).length > 0 && <div className="space-y-2 border border-red-200 bg-red-50 p-3">{riskNotes(active).map(note => <p key={note} className="text-xs leading-5 text-red-700">{note}</p>)}</div>}
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <p className="text-xs font-semibold text-surface-700">背调摘要</p>
                    {active.backCheck && (
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${active.website ? 'bg-blue-50 text-blue-700 border border-blue-200' : 'bg-amber-50 text-amber-700 border border-amber-200'}`}>
                        {active.website ? '来源：网站抓取' : '来源：公司名搜索（精度较低）'}
                      </span>
                    )}
                  </div>
                  <p className="whitespace-pre-wrap text-xs leading-5 text-surface-600">{active.backCheck?.summary || active.snippet || '暂无背调摘要'}</p>
                </div>
                  </div>
                </details>
              </div>
            )}
          </aside>
        </div>
      </div>
    </div>
  )
}





