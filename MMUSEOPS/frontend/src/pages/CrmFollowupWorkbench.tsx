import PageHead from '../components/PageHead'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { getAllItems, loadFromDisk } from '../store/db'
import type { PipelineItem } from '../types/item'
import { buildCrmTaskBoard, type CrmTaskBoard } from '../services/crmTaskBoard'
import { SALES_STAGE_LABELS } from '../types/crm'

const PRIMARY_GROUPS: Array<{ key: keyof CrmTaskBoard; label: string }> = [
  { key: 'blankOriginalReview', label: '原文缺失复核' },
  { key: 'neverDevelopedReview', label: '高/中匹配未开发' },
  { key: 'newReplies', label: '新回信待处理' },
  { key: 'today', label: '今天应跟进' },
  { key: 'overdue', label: '已逾期' },
]

const MORE_GROUPS: Array<{ key: keyof CrmTaskBoard; label: string }> = [
  { key: 'nextSevenDays', label: '未来七天' },
  { key: 'quotedAwaitingFeedback', label: '已报价待反馈' },
  { key: 'waitingForUs', label: '等待我方' },
  { key: 'waitingForCustomer', label: '等待客户' },
  { key: 'longUncontacted', label: '长期未联系' },
  { key: 'missingNextStep', label: '没有下一步' },
]

const GROUPS = [...PRIMARY_GROUPS, ...MORE_GROUPS]

export default function CrmFollowupWorkbench() {
  const [items, setItems] = useState<PipelineItem[]>([])
  const [active, setActive] = useState<keyof CrmTaskBoard>('blankOriginalReview')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let mounted = true
    const load = async () => {
      await loadFromDisk().catch(() => 0)
      const next = await getAllItems()
      if (mounted) { setItems(next); setLoading(false) }
    }
    const handler = () => { void getAllItems().then(next => { if (mounted) setItems(next) }) }
    window.addEventListener('mmuse:sync-done', handler)
    void load()
    return () => { mounted = false; window.removeEventListener('mmuse:sync-done', handler) }
  }, [])

  const board = useMemo(() => buildCrmTaskBoard(items), [items])
  const rows = board[active]
  const activeLabel = GROUPS.find(group => group.key === active)?.label

  return <div className="h-full overflow-y-auto bg-[#f5f5f7] p-5 lg:p-8">
    <div className="mx-auto max-w-6xl">
      <PageHead eyebrow="客户跟进" title="客户跟进" subtitle="按紧急程度处理，需要完整背景时再打开客户档案。" />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {PRIMARY_GROUPS.map(group => <button key={group.key} type="button" onClick={() => setActive(group.key)} className={`directory-segment ${active === group.key ? 'directory-segment-active' : ''}`}><span>{group.label}</span><strong>{board[group.key].length}</strong></button>)}
        <details className="relative">
          <summary className="directory-segment cursor-pointer list-none">更多</summary>
          <div className="absolute left-0 z-20 mt-2 w-52 rounded-xl border border-surface-200 bg-white p-2 shadow-lg">
            {MORE_GROUPS.map(group => <button key={group.key} type="button" onClick={() => setActive(group.key)} className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm ${active === group.key ? 'bg-surface-100 font-medium text-surface-900' : 'text-surface-600 hover:bg-surface-50'}`}><span>{group.label}</span><span className="text-xs tabular-nums text-surface-400">{board[group.key].length}</span></button>)}
          </div>
        </details>
      </div>

      {active === 'blankOriginalReview' && <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
        这组客户曾有正式外发事件，但 Zoho 原始邮件正文无法取回。这里仅用于核对发送历史和当前客户状态；不把 CRM 草稿当作已发送内容，也不会自动建立跟进任务、排期或发送。
      </div>}
      {active === 'neverDevelopedReview' && <div className="mb-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-900">
        仅列高/中业务匹配、且客户时间线没有正式开发信发送记录的活动客户。隔离、退信、拒联、邮箱验证、阶段和已有任务仍需逐条复核；进入此列表不代表获准发送。
      </div>}

      <section className="overflow-hidden rounded-xl border border-surface-200 bg-white">
        <div className="flex items-center justify-between border-b border-surface-100 px-4 py-3"><h2 className="text-sm font-semibold text-surface-900">{activeLabel}</h2><span className="text-xs tabular-nums text-surface-400">{rows.length} 项</span></div>
        {loading ? <p className="py-14 text-center text-sm text-surface-400">正在读取跟进任务…</p> : rows.length ? <div className="divide-y divide-surface-100">{rows.map(({ customer, task }) => {
          const unavailable = (customer as any).contentUnavailableHistory as Array<{ sentAt?: string; recipientEmail?: string; reason?: string }> | undefined
          const latestUnavailable = unavailable?.slice().sort((a, b) => Date.parse(String(b.sentAt || '')) - Date.parse(String(a.sentAt || '')))[0]
          return <Link key={`${customer.id}:${task?.id || active}`} to={`/item/${encodeURIComponent(customer.id)}`} className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-3 hover:bg-surface-50 sm:grid-cols-[minmax(0,1fr)_minmax(160px,.7fr)_auto]">
          <span className="min-w-0"><strong className="block truncate text-sm text-surface-900">{customer.company || customer.title}</strong><span className="mt-0.5 block truncate text-xs text-surface-500">{active === 'blankOriginalReview' ? `${customer.email || '当前邮箱未登记'} · ${unavailable?.length || 0} 封原文缺失外发 · ${(customer as any).businessMatch || '匹配待核'}` : active === 'neverDevelopedReview' ? `${customer.email || '当前邮箱未登记'} · ${(customer as any).businessMatch || '匹配待核'} · ${(customer as any).primaryStage || '阶段待核'}` : task?.content || customer.nextAction || '下一步待补充'}</span></span>
          <span className="hidden sm:block"><span className="block text-xs font-medium text-surface-600">{SALES_STAGE_LABELS[customer.salesStage || 'new_customer']}</span><span className={`mt-0.5 block text-[11px] ${task && Date.parse(task.dueAt) < Date.now() ? 'text-red-600' : 'text-surface-400'}`}>{task?.dueAt ? new Date(task.dueAt).toLocaleDateString('zh-CN') : active === 'blankOriginalReview' ? latestUnavailable?.sentAt ? `最近空原文：${new Date(latestUnavailable.sentAt).toLocaleDateString('zh-CN')}` : '原文缺失' : active === 'neverDevelopedReview' ? '无正式外发记录' : customer.country || '未排期'}</span></span>
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4 text-surface-300 group-hover:text-surface-600"><path d="m9 18 6-6-6-6"/></svg>
        </Link>})}</div> : <div className="py-14 text-center"><p className="text-sm font-medium text-surface-700">当前没有需要处理的客户</p><p className="mt-1 text-xs text-surface-400">新任务出现后会自动进入这里。</p></div>}
      </section>
    </div>
  </div>
}
