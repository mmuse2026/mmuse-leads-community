import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { getAllItems, loadFromDisk } from '../store/db'
import { filterItemsForCard, isCrmCardId, type CrmCardId } from '../services/crmCardRouting'
import type { PipelineItem } from '../types/item'
import { SALES_STAGE_LABELS } from '../types/crm'

const META: Record<CrmCardId, { title: string; note: string }> = {
  backcheck_queue: { title: '待背调', note: '补齐公司资料和业务匹配证据' },
  contact_mining: { title: '待找联系人', note: '补齐真实联系人和可用邮箱' },
  email_verification: { title: '待验证邮箱', note: '确认具体邮箱是否可用' },
  observation: { title: '观察中', note: '等待测试邮件的最终结果' },
  development_ready: { title: '可开发', note: '等待准备开发内容' },
  send_ready: { title: '待发送', note: '内容已准备，等待发送' },
  followup_sent: { title: '跟进中', note: '已发送并进入后续跟进' },
  replied: { title: '已回复', note: '客户已经回复，等待下一步处理' },
  bounced: { title: '需换联系人', note: '当前邮箱不可达，等待补充联系人' },
  nurture: { title: '培育中', note: '暂不优先开发，保留客户资料' },
  excluded: { title: '排除与归档', note: '当前不进入开发流程的客户' },
}

function displayHost(value?: string) {
  if (!value) return '官网待补充'
  try { return new URL(value.startsWith('http') ? value : `https://${value}`).hostname.replace(/^www\./, '') }
  catch { return value.replace(/^https?:\/\//, '').split('/')[0] }
}

function displayDate(value?: string) {
  if (!value) return '未记录'
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleDateString('zh-CN') : '未记录'
}

export default function CrmCardList() {
  const { card = '' } = useParams()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const projectKey = searchParams.get('project') || undefined
  const [items, setItems] = useState<PipelineItem[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const valid = isCrmCardId(card) && !['email_verification', 'observation'].includes(card)

  useEffect(() => {
    let active = true
    const refreshView = () => getAllItems().then(next => { if (active) setItems(next) })
    const handler = () => { void refreshView() }
    window.addEventListener('mmuse:sync-done', handler)
    void loadFromDisk().catch(() => 0).then(refreshView).finally(() => { if (active) setLoading(false) })
    return () => {
      active = false
      window.removeEventListener('mmuse:sync-done', handler)
    }
  }, [card])

  const rows = useMemo(() => valid ? filterItemsForCard(items, card, projectKey) : [], [items, card, projectKey, valid])
  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return normalized ? rows.filter(item => [item.company, item.title, item.country, item.website, item.nextAction].some(value => String(value || '').toLowerCase().includes(normalized))) : rows
  }, [rows, query])
  const meta = valid ? META[card] : undefined

  return <div className="h-full overflow-y-auto bg-[#f5f5f7] p-5 lg:p-8">
    <div className="mx-auto max-w-6xl">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <button type="button" onClick={() => navigate('/')} className="mb-2 text-xs font-medium text-surface-500 hover:text-surface-900">客户目录</button>
          <h1 className="text-2xl font-semibold tracking-tight text-surface-900">{meta?.title || '客户队列'}</h1>
          <p className="mt-1 text-sm text-surface-500">{meta?.note || '没有找到这个队列。'}</p>
        </div>
        <span className="text-sm tabular-nums text-surface-500">{visible.length} 位客户</span>
      </div>

      <label className="relative mb-3 block">
        <span className="sr-only">搜索当前客户</span>
        <input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索当前队列" className="h-10 w-full rounded-xl border border-surface-200 bg-white px-3 text-sm placeholder:text-surface-400 focus:border-surface-400" />
      </label>

      <div className="overflow-hidden rounded-xl border border-surface-200 bg-white">
        {loading ? <p className="py-14 text-center text-sm text-surface-400">正在读取客户…</p> : visible.length === 0
          ? <div className="py-14 text-center"><p className="text-sm font-medium text-surface-700">当前没有客户</p><p className="mt-1 text-xs text-surface-400">其他客户与流程不受影响。</p></div>
          : <div className="divide-y divide-surface-100">{visible.map(item => <button data-customer-row key={item.id} type="button" onClick={() => navigate(`/item/${encodeURIComponent(item.id)}`)} className="group grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-3 text-left hover:bg-surface-50 sm:grid-cols-[minmax(0,1.2fr)_minmax(120px,.6fr)_minmax(180px,1fr)_auto]">
              <span className="min-w-0"><strong className="block truncate text-sm text-surface-900">{item.company || item.title || '未命名客户'}</strong><span className="mt-0.5 block truncate text-xs text-surface-500">{item.country || '国家待补充'} · {displayHost(item.website)}</span></span>
              <span className="hidden text-xs font-medium text-surface-600 sm:block">{SALES_STAGE_LABELS[item.salesStage || 'new_customer']}</span>
              <span className="hidden min-w-0 sm:block"><span className="block truncate text-xs text-surface-600">{item.nextAction || '下一步待补充'}</span><span className="mt-0.5 block truncate text-[11px] text-surface-400">上次 {displayDate(item.lastContactAt)} · 下次 {displayDate(item.nextFollowupAt)}</span></span>
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4 text-surface-300 group-hover:text-surface-600"><path d="m9 18 6-6-6-6"/></svg>
            </button>)}</div>}
      </div>
    </div>
  </div>
}
