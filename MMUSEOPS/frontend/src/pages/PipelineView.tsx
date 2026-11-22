import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { pipelines, getPipeline } from '../data/pipelines'
import { getAllItems, saveItem } from '../store/db'
import KanbanBoard from '../components/KanbanBoard'
import BackButton from '../components/BackButton'
import type { PipelineItem } from '../types/item'
import { countItemsByCrmCard } from '../services/crmCardRouting'
import type { PipelineKey } from '../types/pipeline'
import type { PipelineDef } from '../types/pipeline'

export default function PipelineView() {
  const { key } = useParams<{ key: string }>()
  const navigate = useNavigate()
  const [pipeline, setPipeline] = useState<PipelineDef | null>(null)
  const [items, setItems] = useState<PipelineItem[]>([])
  const [loading, setLoading] = useState(true)
  const [showNew, setShowNew] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newCompany, setNewCompany] = useState('')
  const [newContact, setNewContact] = useState('')

  useEffect(() => {
    if (!key || !['inquiry', 'order', 'sample', 'outreach'].includes(key)) {
      navigate('/', { replace: true })
      return
    }
    setPipeline(getPipeline(key as PipelineKey))
  }, [key, navigate])

  const loadItems = useCallback(async () => {
    if (!key) return
    const all = await getAllItems(key as PipelineKey)
    setItems(all.filter(i => i.status === 'active'))
    setLoading(false)
  }, [key])

  useEffect(() => { loadItems() }, [loadItems])

  if (!pipeline) return null
  if (loading) return <div className="flex-1 flex items-center justify-center text-surface-400 text-sm">加载中...</div>

  // 开发阶段统计（仅 outreach 管道）：统一使用阶段闸门，和各工作台保持一致。
  const outreachStats = key === 'outreach' ? (() => {
    const counts = countItemsByCrmCard(items)
    return {
      total: Object.values(counts).reduce((sum, value) => sum + value, 0),
      backcheck: counts.backcheck_queue,
      contact: counts.contact_mining,
      pendingVerify: counts.email_verification + counts.observation,
      readyToSend: counts.development_ready + counts.send_ready,
      sent: counts.followup_sent + counts.replied,
      bounced: counts.bounced + counts.excluded,
    }
  })() : null

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* 标题栏 */}
      <div className="px-6 lg:px-8 py-3 flex items-center justify-between border-b border-surface-100">
        <div className="flex items-center gap-3">
          <BackButton />
          <div>
            <h1 className="text-lg font-bold text-surface-900">{pipeline.name}</h1>
          </div>
          <span className="badge bg-surface-100 text-surface-500 text-[11px] ml-2">{items.length} 个工单</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowNew(true)}
            className="btn-primary text-xs px-3 py-1.5">
            + 新建
          </button>
        </div>
      </div>

      {/* 新建弹窗 */}
      {showNew && (
        <div className="fixed inset-0 z-50 bg-black/30 backdrop-blur-sm flex items-center justify-center" onClick={() => setShowNew(false)}>
          <div className="bg-surface-0 rounded-xl shadow-float p-6 w-full max-w-md mx-4 border border-surface-200" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-surface-900 mb-4">新建工单</h3>
            <div className="space-y-3">
              <input value={newTitle} onChange={e => setNewTitle(e.target.value)}
                placeholder="标题（必填）" className="input w-full text-sm" autoFocus />
              <input value={newCompany} onChange={e => setNewCompany(e.target.value)}
                placeholder="公司名称" className="input w-full text-sm" />
              <input value={newContact} onChange={e => setNewContact(e.target.value)}
                placeholder="联系人" className="input w-full text-sm" />
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => { setShowNew(false); setNewTitle(''); setNewCompany(''); setNewContact('') }}
                className="btn-ghost text-xs">取消</button>
              <button onClick={async () => {
                if (!newTitle.trim()) return alert('请输入标题')
                const item: PipelineItem = {
                  id: crypto.randomUUID(),
                  pipelineId: key as PipelineKey,
                  title: newTitle.trim(),
                  currentStageId: pipeline.stages[0].id,
                  status: 'active',
                  priority: 'medium',
                  source: 'manual',
                  contactName: newContact.trim(),
                  company: newCompany.trim(),
                  email: '', phone: '',
                  clientType: 'unknown', level: 'unknown',
                  emailVerification: 'unknown', emailBounced: false,
                  currency: 'USD',
                  businessLine: 'both',
                  timeline: [{ stageId: pipeline.stages[0].id, enteredAt: new Date().toISOString() }],
                  notes: [], attachments: [],
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                }
                await saveItem(item)
                setShowNew(false)
                setNewTitle(''); setNewCompany(''); setNewContact('')
                loadItems()
              }} disabled={!newTitle.trim()}
                className="btn-primary text-xs">创建</button>
            </div>
          </div>
        </div>
      )}

      {/* 开发阶段统计（仅 outreach） */}
      {outreachStats && (
        <div className="flex gap-3 px-6 lg:px-8 py-3 bg-surface-50 border-b border-surface-100">
          {[
            { label: '待背调', count: outreachStats.backcheck, color: 'text-purple-600 bg-purple-50' },
            { label: '联系人挖掘', count: outreachStats.contact, color: 'text-amber-600 bg-amber-50' },
            { label: '待验证', count: outreachStats.pendingVerify, color: 'text-blue-600 bg-blue-50' },
            { label: '待发信', count: outreachStats.readyToSend, color: 'text-purple-600 bg-purple-50' },
            { label: '已发信', count: outreachStats.sent, color: 'text-green-600 bg-green-50' },
            { label: '已退信', count: outreachStats.bounced, color: 'text-red-600 bg-red-50' },
          ].map(s => (
            <div key={s.label} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg ${s.color}`}>
              <span className="text-xs font-semibold">{s.count || 0}</span>
              <span className="text-[10px] opacity-80">{s.label}</span>
            </div>
          ))}
        </div>
      )}

      <KanbanBoard pipeline={pipeline} items={items} onRefresh={loadItems} />
    </div>
  )
}
