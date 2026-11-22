import PageHead from '../components/PageHead'
import BusinessLlmConfig from '../components/BusinessLlmConfig'
import BusinessCustomerList from '../components/BusinessCustomerList'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getAllItems, loadFromDisk, refreshFromServer } from '../store/db'
import type { PipelineItem } from '../types/item'
import { cardForItem, type CrmCardId } from '../services/crmCardRouting'
import { SALES_STAGE_LABELS } from '../types/crm'
import { API_BASE } from '../services/config'
import { crmBusinessScope } from '../services/crmBusinessScope'

type PipelineControl = { running: boolean; updatedAt: string }
type BusinessPipeline = { business_id: string; display_name: string; execution_status: string; execution_note: string; controls_available: boolean }
type DirectoryStatus = 'all' | 'action' | 'development' | 'replied' | 'nurture' | 'excluded'
type BusinessGroup = 'all' | 'furniture' | 'car-seat' | 'knitwear' | 'other'

const PAGE_SIZE = 50
const PIPELINE_FALLBACK: BusinessPipeline[] = [
  { business_id: 'furniture', display_name: '家具', execution_status: 'unknown', execution_note: '状态未连接', controls_available: false },
  { business_id: 'carseat', display_name: '汽车座椅套', execution_status: 'unknown', execution_note: '状态未连接', controls_available: false },
  { business_id: 'knitwear', display_name: '羊毛衫', execution_status: 'unknown', execution_note: '状态未连接', controls_available: false },
]

const CARD_META: Array<{ key: CrmCardId; title: string; path: string }> = [
  { key: 'backcheck_queue', title: '待背调', path: '/crm-card/backcheck_queue' },
  { key: 'contact_mining', title: '待找联系人', path: '/crm-card/contact_mining' },
  { key: 'development_ready', title: '可开发', path: '/crm-card/development_ready' },
  { key: 'send_ready', title: '待发送', path: '/crm-card/send_ready' },
  { key: 'followup_sent', title: '跟进中', path: '/crm-card/followup_sent' },
  { key: 'replied', title: '已回复', path: '/crm-card/replied' },
  { key: 'bounced', title: '需换联系人', path: '/crm-card/bounced' },
  { key: 'nurture', title: '培育中', path: '/crm-card/nurture' },
  { key: 'excluded', title: '排除与归档', path: '/crm-card/excluded' },
]

const STATUS_META: Array<{ key: DirectoryStatus; label: string }> = [
  { key: 'all', label: '全部客户' },
  { key: 'action', label: '待处理' },
  { key: 'development', label: '开发中' },
  { key: 'replied', label: '已回复' },
  { key: 'nurture', label: '培育中' },
  { key: 'excluded', label: '排除与归档' },
]

const BUSINESS_META: Array<{ key: BusinessGroup; label: string }> = [
  { key: 'all', label: '家具兼容入口' },
  { key: 'furniture', label: '家具相关' },
  { key: 'car-seat', label: '汽车座椅套' },
  { key: 'knitwear', label: '羊毛衫' },
  { key: 'other', label: '待归类 / 其他' },
]

function directoryStatus(item: PipelineItem): DirectoryStatus {
  const card = cardForItem(item)
  if (card === 'replied') return 'replied'
  if (card === 'nurture') return 'nurture'
  if (card === 'excluded' || !card) return 'excluded'
  if (['development_ready', 'send_ready', 'followup_sent'].includes(card)) return 'development'
  return 'action'
}

function businessGroup(item: PipelineItem): Exclude<BusinessGroup, 'all'> {
  const value = crmBusinessScope(item.businessLine)
  if (value === 'wool') return 'knitwear'
  if (value === 'carseat') return 'car-seat'
  if (value === 'furniture') return 'furniture'
  return 'other'
}

function displayHost(value?: string) {
  if (!value) return '官网待补充'
  try { return new URL(value.startsWith('http') ? value : `https://${value}`).hostname.replace(/^www\./, '') }
  catch { return value.replace(/^https?:\/\//, '').split('/')[0] }
}

function displayDate(value?: string) {
  if (!value) return ''
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleDateString('zh-CN') : ''
}

export default function Dashboard() {
  const navigate = useNavigate()
  const [items, setItems] = useState<PipelineItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<DirectoryStatus>('all')
  const [business, setBusiness] = useState<BusinessGroup>('furniture')
  const [page, setPage] = useState(1)
  const [pipelineControl, setPipelineControl] = useState<PipelineControl | null>(null)
  const [businessPipelines, setBusinessPipelines] = useState<BusinessPipeline[] | null>(null)

  async function refreshBusinessPipelines() {
    try {
      const response = await fetch(`${API_BASE}/api/business-pipelines`)
      if (!response.ok) throw new Error('unavailable')
      const result = await response.json()
      if (result.schema !== 'business-pipelines.v1' || !Array.isArray(result.pipelines)) throw new Error('invalid')
      setBusinessPipelines(result.pipelines)
    } catch { setBusinessPipelines(null) }
  }

  async function refreshPipelineControl() {
    const response = await fetch(`${API_BASE}/api/pipeline-control`)
    if (response.ok) setPipelineControl(await response.json())
  }

  async function refreshView() {
    setItems(await getAllItems())
  }

  async function reload(force = false) {
    setLoadError(false)
    try {
      await (force ? refreshFromServer(true) : loadFromDisk()).catch(() => 0)
      await refreshView()
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const handler = () => { void refreshView() }
    window.addEventListener('mmuse:sync-done', handler)
    void reload()
    void refreshPipelineControl()
    void refreshBusinessPipelines()
    return () => window.removeEventListener('mmuse:sync-done', handler)
  }, [])

  useEffect(() => { setPage(1) }, [query, status, business])

  const customers = useMemo(() => items.filter(item => !item.crmMergedInto && item.inactiveCategory !== 'duplicate'), [items])

  const counts = useMemo(() => {
    const statusCounts = Object.fromEntries(STATUS_META.map(item => [item.key, 0])) as Record<DirectoryStatus, number>
    const businessCounts = Object.fromEntries(BUSINESS_META.map(item => [item.key, 0])) as Record<BusinessGroup, number>
    for (const item of customers) {
      if (business !== 'knitwear' && (business === 'all' || businessGroup(item) === business)) {
        statusCounts.all += 1
        statusCounts[directoryStatus(item)] += 1
      }
      businessCounts.all += 1
      businessCounts[businessGroup(item)] += 1
    }
    return { statusCounts, businessCounts }
  }, [customers, business])

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return customers.filter(item => {
      if (business === 'knitwear') return false
      if (status !== 'all' && directoryStatus(item) !== status) return false
      if (business !== 'all' && businessGroup(item) !== business) return false
      if (!normalized) return true
      return [item.company, item.title, item.country, item.website, item.selectedEmail, item.relationshipSummary, item.nextAction]
        .some(value => String(value || '').toLowerCase().includes(normalized))
    })
  }, [customers, query, status, business])

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const visible = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)


  if (loading) return <div className="flex h-full items-center justify-center text-sm text-surface-400">正在读取客户数据…</div>

  if (loadError && !items.length && business === 'all') return <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-surface-500">
    <span>客户数据暂时无法读取</span>
    <button onClick={() => void reload(true)} className="btn-outline">重新读取</button>
  </div>

  return <div className="h-full overflow-y-auto bg-[#f5f5f7]">
    <div className="mx-auto max-w-[1440px] px-5 py-6 lg:px-8">
      <PageHead eyebrow="客户管理" title="客户数据管理" subtitle="选择客户查看完整档案、沟通记录和下一步。" actions={
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${pipelineControl?.running ? 'bg-emerald-500' : 'bg-surface-300'}`} />
          <span className="text-xs text-surface-500">{pipelineControl ? (pipelineControl.running ? '现有全局流程运行中' : '现有全局流程已暂停') : '全局流程状态未知'}</span>
          <button disabled className="directory-control-button" title="各业务独立控制尚未接通">
            独立控制未接通
          </button>
        </div>
      } />

      <section aria-label="业务流水线" className="mb-5 rounded-2xl border border-black/[0.06] bg-white p-5">
        <div className="flex items-center justify-between gap-3"><h2 className="text-base font-semibold">业务流水线</h2><button type="button" onClick={() => void refreshBusinessPipelines()} className="directory-control-button">刷新状态</button></div>
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          {(businessPipelines ?? PIPELINE_FALLBACK).map(line => <div key={line.business_id} className="rounded-xl border border-surface-200 p-4"><h3 className="font-semibold">{line.display_name}</h3><p className="mt-2 text-sm text-surface-600">{line.execution_note}</p><p className="mt-2 text-xs text-surface-400">{line.controls_available ? '管理控制已接入' : '独立启动和暂停尚未接入'}</p></div>)}
        </div>
      </section>

      {business !== 'all' && business !== 'other' && <BusinessLlmConfig key={business} line={business === 'car-seat' ? 'carseat' : business} />}

      <div className="grid min-h-[680px] grid-cols-1 overflow-hidden rounded-2xl border border-black/[0.06] bg-white/80 backdrop-blur-xl lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="border-b border-surface-200 bg-surface-50/65 p-3 lg:border-b-0 lg:border-r">
          {business === 'all' && <><p className="px-3 pb-2 pt-2 text-[11px] font-semibold tracking-wide text-surface-400">客户状态</p>
          <div className="space-y-0.5">
            {STATUS_META.map(item => <button key={item.key} type="button" onClick={() => setStatus(item.key)} className={`directory-filter ${status === item.key ? 'directory-filter-active' : ''}`}>
              <span>{item.label}</span><span>{counts.statusCounts[item.key]}</span>
            </button>)}
          </div></>}
          <p className="px-3 pb-2 pt-6 text-[11px] font-semibold tracking-wide text-surface-400">业务分类</p>
          <div className="space-y-0.5">
            {BUSINESS_META.map(item => <button key={item.key} type="button" onClick={() => setBusiness(item.key)} className={`directory-filter ${business === item.key ? 'directory-filter-active' : ''}`}>
              <span>{item.label}</span><span>{item.key === 'knitwear' || item.key === 'other' ? '' : counts.businessCounts[item.key]}</span>
            </button>)}
          </div>
        </aside>

        {business !== 'all' ? <BusinessCustomerList key={business} line={business === 'car-seat' ? 'carseat' : business === 'other' ? 'unclassified' : business} /> : <main className="min-w-0 p-4 lg:p-5">
          <p role="status" className="mb-3 text-sm text-surface-500">此兼容入口显示旧客户存储，不代表全部业务数据。</p>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <label className="relative min-w-0 flex-1">
              <span className="sr-only">搜索客户</span>
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-surface-400"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>
              <input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索公司、国家、网站或下一步" className="h-10 w-full rounded-xl border border-surface-200 bg-white pl-9 pr-3 text-sm text-surface-900 placeholder:text-surface-400 focus:border-surface-400" />
            </label>
            <button type="button" onClick={() => void reload(true)} className="directory-control-button">刷新数据</button>
          </div>



          <div className="flex items-center justify-between py-3">
            <p className="text-xs text-surface-500">{filtered.length.toLocaleString('zh-CN')} 条客户记录</p>
            {(status !== 'all' || query) && <button type="button" onClick={() => { setStatus('all'); setQuery('') }} className="text-xs font-medium text-accent-700">清除筛选</button>}
          </div>

          <div className="overflow-hidden rounded-xl border border-surface-200 bg-white" data-customer-directory>
            {visible.length ? <div className="divide-y divide-surface-100">
              {visible.map(item => {
                const nextDate = displayDate(item.nextFollowupAt)
                return <button data-customer-row key={item.id} type="button" onClick={() => navigate(`/item/${encodeURIComponent(item.id)}`)} className="group grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 text-left hover:bg-surface-50 sm:grid-cols-[minmax(0,1.4fr)_minmax(120px,.7fr)_minmax(160px,1fr)_auto]">
                  <span className="min-w-0">
                    <strong className="block truncate text-sm font-semibold text-surface-900">{item.company || item.title || '未命名客户'}</strong>
                    <span className="mt-0.5 block truncate text-xs text-surface-500">{item.country || '国家待补充'} · {displayHost(item.website)}</span>
                  </span>
                  <span className="hidden text-xs font-medium text-surface-600 sm:block">{SALES_STAGE_LABELS[item.salesStage || 'new_customer']}</span>
                  <span className="hidden min-w-0 sm:block">
                    <span className="block truncate text-xs text-surface-600">{item.nextAction || '下一步待补充'}</span>
                    {nextDate && <span className="mt-0.5 block text-[11px] text-surface-400">{nextDate}</span>}
                  </span>
                  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4 text-surface-300 group-hover:text-surface-600"><path d="m9 18 6-6-6-6"/></svg>
                </button>
              })}
            </div> : <div className="px-6 py-16 text-center"><p className="text-sm font-medium text-surface-700">没有符合条件的客户</p><p className="mt-1 text-xs text-surface-400">调整状态、分类或搜索词。</p></div>}
          </div>

          {pageCount > 1 && <div className="mt-4 flex items-center justify-end gap-2">
            <button disabled={page === 1} onClick={() => setPage(value => Math.max(1, value - 1))} className="directory-control-button disabled:opacity-35">上一页</button>
            <span className="px-2 text-xs tabular-nums text-surface-500">{page} / {pageCount}</span>
            <button disabled={page === pageCount} onClick={() => setPage(value => Math.min(pageCount, value + 1))} className="directory-control-button disabled:opacity-35">下一页</button>
          </div>}
        </main>}
      </div>
    </div>
  </div>
}
