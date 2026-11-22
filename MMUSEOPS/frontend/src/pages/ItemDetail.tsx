import { crmEmailStatus } from '../services/crmEmailStatus'
import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import BackButton from '../components/BackButton'
import { fetchFullItem, saveItem } from '../store/db'
import { getPipeline } from '../data/pipelines'
import { getStageStatus, formatDuration } from '../utils/time'
import type { PipelineItem, ClientLevel, ClientType, EmailVerification } from '../types/item'
import type { PipelineKey } from '../types/pipeline'
import { emailLogStatusLabel, emailLogTypeLabel } from '../services/crmManagementPresentation'
import { normalizeEmailText } from '../services/emailText'
import CustomerOverview from '../components/crm/CustomerOverview'
import OpportunityPanel from '../components/crm/OpportunityPanel'
import CommunicationTimeline from '../components/crm/CommunicationTimeline'
import QuotePanel from '../components/crm/QuotePanel'
import CrmTaskPanel from '../components/crm/CrmTaskPanel'
import AutomaticContentSuggestions from '../components/AutomaticContentSuggestions'
import CrmReplyComposer from '../components/CrmReplyComposer'

export default function ItemDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [item, setItem] = useState<PipelineItem | null>(null)
  const [noteText, setNoteText] = useState('')
  const [saving, setSaving] = useState(false)
  const [section, setSection] = useState<'overview' | 'communication' | 'business' | 'tasks' | 'research'>(() => searchParams.get('section') === 'communication' ? 'communication' : 'overview')

  const load = useCallback(async () => {
    if (!id) return
    // 按需加载：打开详情时按 id 拉该卡完整数据（emailLogs 全文/notes/timeline/backCheck），不依赖全量内存
    setItem(await fetchFullItem(id) || null)
  }, [id])

  useEffect(() => { load() }, [load])

  const update = async (patch: Partial<PipelineItem>) => {
    if (!item) return
    Object.assign(item, patch, { updatedAt: new Date().toISOString() })
    try {
      await saveItem(item)
      setItem({ ...item })
    } catch (e: any) {
      alert('保存失败: ' + (e.message || e))
    }
  }

  const handleAdvance = async () => {
    if (!item) return
    const pipeDef = getPipeline(item.pipelineId as PipelineKey)
    const idx = pipeDef.stages.findIndex(s => s.id === item.currentStageId)
    if (idx < 0 || idx >= pipeDef.stages.length - 1) return
    const nextStage = pipeDef.stages[idx + 1]
    const timeline = [...item.timeline]
    const current = timeline.find(t => t.stageId === item.currentStageId && !t.exitedAt)
    if (current) current.exitedAt = new Date().toISOString()
    if (timeline.length === 0 || timeline[timeline.length - 1].stageId !== nextStage.id) {
      timeline.push({ stageId: nextStage.id, enteredAt: new Date().toISOString() })
    }
    await update({ timeline, currentStageId: nextStage.id })
  }

  const handleRegress = async () => {
    if (!item) return
    const pipeDef = getPipeline(item.pipelineId as PipelineKey)
    const idx = pipeDef.stages.findIndex(s => s.id === item.currentStageId)
    if (idx <= 0) return
    const prevStage = pipeDef.stages[idx - 1]
    const timeline = [...item.timeline]
    const currentIdx = timeline.findIndex(t => t.stageId === item.currentStageId && !t.exitedAt)
    if (currentIdx >= 0) {
      timeline.splice(currentIdx, 1)
      const prev = timeline.find(t => t.stageId === prevStage.id)
      if (prev) delete prev.exitedAt
    }
    await update({ timeline, currentStageId: prevStage.id })
  }

  const addNote = async () => {
    if (!noteText.trim() || !item) return
    setSaving(true)
    const notes = [...item.notes, {
      id: Math.random().toString(36).substring(2, 10),
      content: noteText.trim(),
      createdAt: new Date().toISOString(),
    }]
    await update({ notes })
    setNoteText('')
    setSaving(false)
  }

  if (!item) {
    return <div className="flex-1 flex items-center justify-center text-surface-400 text-sm">工单不存在</div>
  }

  const emailStatus = crmEmailStatus(item)
  const pipeDef = getPipeline(item.pipelineId as PipelineKey)
  const stageDef = pipeDef.stages.find(s => s.id === item.currentStageId)
  const stageIndex = pipeDef.stages.findIndex(s => s.id === item.currentStageId)
  const pendingTasks = (item.crmTasks || []).filter(task => task.status === 'pending')
    .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))

  const levelBadge = (lvl: ClientLevel) => {
    const colors: Record<string, string> = {
      S: 'bg-emerald-50 text-emerald-700 border-emerald-200',
      M: 'bg-blue-50 text-blue-700 border-blue-200',
      L: 'bg-amber-50 text-amber-700 border-amber-200',
      XL: 'bg-red-50 text-red-700 border-red-200',
      unknown: 'bg-surface-100 text-surface-500 border-surface-200',
    }
    return colors[lvl] || colors.unknown
  }

  const verifyBadge = (v: EmailVerification) => {
    const colors: Record<string, string> = {
      verified: 'badge-success',
      catchall: 'badge-warning',
      risky: 'bg-orange-50 text-orange-700',
      invalid: 'badge-danger',
      unknown: 'bg-surface-100 text-surface-500',
    }
    return colors[v] || colors.unknown
  }

  const verifyLabels: Record<EmailVerification, string> = {
    verified: '已验证', catchall: '全部接收', risky: '高风险', invalid: '无效', unknown: '未验证',
  }

  const typeLabels: Record<ClientType, string> = {
    distributor: '经销商', trader: '贸易商', ecommerce: '电商', wholesaler: '批发商', retailer: '零售商', manufacturer: '厂家', unknown: '待定',
  }

  const sourceLabels: Record<string, string> = {
    google_dork: 'Google Dorking', linkedin: 'LinkedIn', apify: 'Apify', serper: 'Serper API',
    website: '网站询盘', whatsapp: 'WhatsApp', email: '邮件', social: '社媒',
    exhibition: '展会', referral: '客户推荐', manual: '手动录入',
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-black/[0.06] bg-white/85 px-5 py-2.5 backdrop-blur-xl lg:px-8">
        <div className="flex min-w-0 items-center gap-3"><BackButton className="shrink-0" /><strong className="truncate text-sm text-surface-900">{item.company || item.title}</strong></div>
        <span className="text-xs text-surface-500">{stageDef?.name || '客户档案'}</span>
      </div>

      <div className="max-w-4xl mx-auto p-6 lg:p-8 space-y-6">
        {/* 基本信息 */}
        <div className="stat-card">
          <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
            <div><h1 className="text-xl font-semibold tracking-tight text-surface-900">{item.company || item.title}</h1><p className="mt-1 text-sm text-surface-500">{item.country || '国家待补充'} · {item.clientType === 'unknown' ? '客户类型待确认' : typeLabels[item.clientType]}</p></div>
            <span className="text-xs font-medium text-surface-500">{emailStatus.label}</span>
          </div>

          {/* 信息网格 */}
          <div className="mb-5 grid gap-x-6 gap-y-3 rounded-xl bg-surface-50 p-4 sm:grid-cols-2 lg:grid-cols-3">
            <InfoRow label="联系人" value={item.contactName} />
            <InfoRow label="公司" value={item.company} />
            <InfoRow label="来源" value={sourceLabels[item.source] || item.source} />
            <div>
              <span className="text-[10px] text-surface-400">邮箱</span>
              <p className="text-sm flex items-center gap-2">
                {item.email || '—'}
                <span className="text-[10px] text-surface-400">人工判断</span>
                <select aria-label="人工邮箱判断（历史字段，不作为精确验证证据）" title="人工邮箱判断（历史字段，不作为精确验证证据）" value={item.emailVerification} onChange={e => update({ emailVerification: e.target.value as EmailVerification })}
                  className={`text-[10px] px-1 py-0.5 rounded border ${verifyBadge(item.emailVerification)}`}>
                  {(['unknown', 'verified', 'catchall', 'risky', 'invalid'] as EmailVerification[]).map(v =>
                    <option key={v} value={v}>{verifyLabels[v]}</option>
                  )}
                </select>
              </p>
            </div>
            <InfoRow label="电话" value={item.phone} />
            <InfoRow label="国家" value={item.country} />
            <InfoRow label="网站" value={item.website ? <span className="break-all block text-accent-600 underline underline-offset-2 decoration-accent-300/50"><a href={item.website.startsWith('http') ? item.website : 'https://' + item.website} target="_blank" rel="noreferrer" className="hover:text-accent-700">{item.website}</a></span> : '—'} />
            <InfoRow label="公司规模" value={item.companySize} />
            <div>
              <span className="text-[10px] text-surface-400">客户类型</span>
              <select value={item.clientType} onChange={e => update({ clientType: e.target.value as ClientType })}
                className="text-xs px-1 py-0.5 rounded border border-surface-200 text-surface-700 bg-white ml-1">
                {(Object.keys(typeLabels) as ClientType[]).map(t =>
                  <option key={t} value={t}>{typeLabels[t]}</option>
                )}
              </select>
            </div>
          </div>

          <div className="mb-5 grid gap-3 rounded-xl bg-surface-50 p-4 sm:grid-cols-2">
            <InfoRow label="精确邮箱状态" value={`${emailStatus.email || '未选择'} · ${emailStatus.label}`} />
            <InfoRow label="当前选中邮箱" value={item.selectedEmail || '未选择（不代表已验证）'} />
            <InfoRow label="最近沟通" value={item.lastContactAt ? new Date(item.lastContactAt).toLocaleString('zh-CN') : '未记录'} />
            <InfoRow label="下一步" value={item.nextAction || '未设置'} />
            <InfoRow label="下次跟进" value={item.nextFollowupAt ? new Date(item.nextFollowupAt).toLocaleString('zh-CN') : '未设置'} />
            <InfoRow label={`待办任务 · ${pendingTasks.length}`} value={pendingTasks[0] ? `${normalizeEmailText(pendingTasks[0].content)} · ${new Date(pendingTasks[0].dueAt).toLocaleString('zh-CN')}` : '暂无待办任务'} />
            <InfoRow label="背调摘要" value={item.backCheck?.summary || '未记录'} />
          </div>

          <details className="mb-5 rounded-lg border border-surface-200 bg-white px-3 py-2">
            <summary className="cursor-pointer list-none text-xs font-medium text-surface-600">编辑客户分类</summary>
            <div className="mt-3 flex gap-1.5">
              {(['S', 'M', 'L', 'XL'] as ClientLevel[]).map(l => (
                <button key={l} onClick={() => update({ level: l, levelSource: 'manual' })}
                  className={`px-3 py-1.5 text-xs rounded-lg border transition-all ${
                    item.level === l
                      ? levelBadge(l) + ' border-current shadow-sm'
                      : 'border-surface-200 text-surface-500 hover:border-surface-300 hover:bg-surface-50'
                  }`}>
                  {l} {l === 'S' ? '(1-10)' : l === 'M' ? '(10-50)' : l === 'L' ? '(50-100)' : '(100+)'}
                </button>
              ))}
            </div>
          </details>

          {/* 金额 */}
          {item.estimatedAmount && item.estimatedAmount > 0 && (
            <div className="mb-5">
              <span className="text-[10px] text-surface-400">预估金额</span>
              <p className="text-lg font-semibold text-surface-900">
                {item.currency} {item.estimatedAmount.toLocaleString()}
              </p>
            </div>
          )}

          {/* 操作 */}
          <div className="flex items-center gap-2 pt-4 border-t border-surface-100">
            <button onClick={handleAdvance}
              disabled={stageIndex >= pipeDef.stages.length - 1}
              className="btn-primary text-xs">
              推进 → {pipeDef.stages[stageIndex + 1]?.name || '终点'}
            </button>
            <button onClick={handleRegress}
              disabled={stageIndex <= 0}
              className="btn-ghost text-xs">
              ← 退回 {pipeDef.stages[stageIndex - 1]?.name}
            </button>
            <button onClick={() => update({ status: 'completed' }).then(() => navigate('/'))}
              className="btn-outline text-xs text-emerald-600 border-emerald-200 hover:bg-emerald-50">
              ✓ 完成
            </button>
            <button onClick={() => update({ status: 'archived' }).then(() => navigate('/'))}
              className="btn-ghost text-xs text-surface-400">
              归档
            </button>
          </div>
        </div>

        <nav className="sticky top-[53px] z-[9] flex gap-1 overflow-x-auto rounded-xl border border-black/[0.06] bg-white/90 p-1 backdrop-blur-xl">
          {([['overview','概览'],['communication','沟通'],['business','商机与报价'],['tasks','任务'],['research','资料']] as const).map(([key,label]) => <button key={key} type="button" onClick={() => setSection(key)} className={`shrink-0 rounded-lg px-3 py-2 text-sm ${section === key ? 'bg-surface-900 font-medium text-white' : 'text-surface-500 hover:bg-surface-100 hover:text-surface-900'}`}>{label}</button>)}
        </nav>

        {section === 'overview' && <CustomerOverview item={item} onUpdated={setItem} />}
        {section === 'business' && <><OpportunityPanel item={item} onUpdated={setItem} /><QuotePanel item={item} onUpdated={setItem} /></>}
        {section === 'communication' && <CommunicationTimeline item={item} onUpdated={setItem} />}
        {section === 'tasks' && <CrmTaskPanel item={item} onUpdated={setItem} />}
        {section === 'research' && ['furniture','car-seat'].includes(item.businessLine) && <details className="rounded-xl border border-surface-200 bg-white p-4"><summary className="cursor-pointer list-none text-sm font-semibold text-surface-800">相关营销内容</summary><div className="mt-4"><AutomaticContentSuggestions customerId={item.id}/></div></details>}

        {/* 流程进度条 */}
        {section === 'tasks' && <div className="stat-card">
          <h2 className="text-sm font-semibold text-surface-800 mb-4">流程进度</h2>
          <div className="flex items-center gap-1 mb-4">
            {pipeDef.stages.map((s, i) => {
              const isActive = i === stageIndex
              const isDone = i < stageIndex
              const st = getStageStatus(item.pipelineId as PipelineKey, s.id, item.timeline)
              return (
                <div key={s.id} className="flex-1 flex flex-col items-center">
                  <div className={`w-full h-2 rounded-full transition-colors ${
                    isDone ? 'bg-accent-500' :
                    isActive ? (st === 'overdue' ? 'bg-red-400' : st === 'warning' ? 'bg-amber-400' : 'bg-accent-300') :
                    'bg-surface-200'
                  }`} />
                  <span className={`text-[10px] mt-1.5 text-center leading-tight ${
                    isActive ? 'font-medium text-surface-800' : 'text-surface-400'
                  }`}>
                    {s.name}
                  </span>
                </div>
              )
            })}
          </div>
        </div>}

        {/* 时间轴 */}
        {section === 'tasks' && <div className="stat-card">
          <h2 className="text-sm font-semibold text-surface-800 mb-4">时间轴</h2>
          <div className="space-y-3">
            {item.timeline.map((t, i) => {
              const sDef = pipeDef.stages.find(s => s.id === t.stageId)
              return (
                <div key={i} className="flex items-start gap-3">
                  <div className="flex flex-col items-center">
                    <div className={`w-2.5 h-2.5 rounded-full border-2 ${
                      t.exitedAt ? 'border-accent-500 bg-accent-500' : 'border-accent-400 bg-white'
                    }`} />
                    {i < item.timeline.length - 1 && <div className="w-px h-5 bg-surface-200" />}
                  </div>
                  <div className="pb-3">
                    <p className="text-sm font-medium text-surface-800">{sDef?.name || t.stageId}</p>
                    <p className="text-xs text-surface-400">
                      {new Date(t.enteredAt).toLocaleString('zh-CN')}
                      {t.exitedAt && ` → ${new Date(t.exitedAt).toLocaleString('zh-CN')}`}
                      <span className="ml-1">({formatDuration(t.enteredAt, t.exitedAt)})</span>
                    </p>
                  </div>
                </div>
              )
            })}
          </div>
        </div>}

        {/* 背调查 */}
        {section === 'research' && item.backCheck && (
          <div className="stat-card">
            <h2 className="text-sm font-semibold text-surface-800 mb-4">客户背调</h2>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                {item.backCheck.companyWebsite && <InfoRow label="官网" value={<a href={item.backCheck.companyWebsite.startsWith('http') ? item.backCheck.companyWebsite : 'https://' + item.backCheck.companyWebsite} target="_blank" rel="noreferrer" className="text-accent-600 hover:underline">{item.backCheck.companyWebsite}</a>} />}
                {item.backCheck.employeeCount && <InfoRow label="员工数" value={item.backCheck.employeeCount} />}
                {item.backCheck.revenue && <InfoRow label="营收" value={item.backCheck.revenue} />}
                {item.backCheck.yearFounded && <InfoRow label="成立" value={item.backCheck.yearFounded} />}
                {item.backCheck.linkedinUrl && <InfoRow label="LinkedIn" value={<a href={item.backCheck.linkedinUrl.startsWith('http') ? item.backCheck.linkedinUrl : 'https://' + item.backCheck.linkedinUrl} target="_blank" rel="noreferrer" className="text-accent-600 hover:underline truncate block">{item.backCheck.linkedinUrl}</a>} />}
              </div>
              {item.backCheck.products?.length ? <InfoRow label="主营产品" value={item.backCheck.products.join('、')} /> : null}
              {item.backCheck.markets?.length ? <InfoRow label="主要市场" value={item.backCheck.markets.join('、')} /> : null}
              {item.backCheck.summary && (
                <div>
                  <span className="text-[10px] text-surface-400 block mb-1.5">综合分析</span>
                  <p className="text-sm text-surface-700 bg-surface-50 rounded-lg p-3 leading-relaxed">{item.backCheck.summary}</p>
                </div>
              )}
              <p className="text-[10px] text-surface-400">背调时间：{new Date(item.backCheck.checkedAt).toLocaleString('zh-CN')}</p>
            </div>
          </div>
        )}

        {/* 邮件与回复记录 */}
        {(section === 'overview' || section === 'communication') && (item.emailLogs?.length || (item as any).zohoReplyEvidence?.length) ? (
          <div className="stat-card">
            <h2 className="text-sm font-semibold text-surface-800 mb-4">邮件与回复记录</h2>
            <div className="space-y-2">
              {(item.emailLogs || []).map((log, i) => (
                <div key={i} className="p-3 bg-surface-50 rounded-lg flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="badge bg-surface-100 text-surface-700 text-[10px]">{emailLogTypeLabel(log)}</span>
                      <p className="text-sm font-medium text-surface-800">{normalizeEmailText(log.subject) || '无主题'}</p>
                    </div>
                    <p className="text-xs text-surface-400 mt-0.5">
                      {new Date((log as any).receivedAt || log.repliedAt || log.sentAt).toLocaleString('zh-CN')}
                      {log.repliedAt && ` · 回复 ${new Date(log.repliedAt).toLocaleString('zh-CN')}`}
                      {log.bounceReason && ` · ${normalizeEmailText(log.bounceReason)}`}
                    </p>
                  </div>
                  <span className={`badge text-[10px] ${
                    ['sent', 'delivered'].includes(log.status) ? 'bg-blue-50 text-blue-700' :
                    log.status === 'bounced' ? 'badge-danger' :
                    ['replied', 'received'].includes(log.status) ? 'badge-success' :
                    'badge-warning'
                  }`}>
                    {emailLogStatusLabel(log)}
                  </span>
                </div>
              ))}
            </div>
            {section === 'communication' && <div className="mt-5 space-y-3">
              {([...((item as any).zohoReplyEvidence || [])] as any[]).filter(evidence => evidence.classification === 'reply').map(evidence => (
                <CrmReplyComposer key={evidence.messageId} customerId={String(item.id)} company={String(item.company || item.title || '客户')} evidence={evidence} priorAttempts={(item as any).crmReplySendAttempts || []} onSent={load} />
              ))}
            </div>}
          </div>
        ) : null}

        {/* 报价历史 */}
        {section === 'business' && item.quoteVersions?.length ? (
          <div className="stat-card">
            <h2 className="text-sm font-semibold text-surface-800 mb-4">报价历史</h2>
            <div className="space-y-2">
              {item.quoteVersions.map((qv, i) => (
                <div key={i} className="flex items-center justify-between p-3 bg-surface-50 rounded-lg">
                  <div className="flex items-center gap-3">
                    <span className="text-xs font-semibold text-surface-400">V{qv.version}</span>
                    <span className="text-sm font-medium text-surface-800">{qv.currency} {qv.amount.toLocaleString()}</span>
                    <span className="text-xs text-surface-400">{qv.tradeTerm}</span>
                  </div>
                  <span className="text-xs text-surface-400">
                    {qv.sentAt && `${new Date(qv.sentAt).toLocaleDateString('zh-CN')}`}
                    {qv.readAt && ' · 已读'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* 备注 */}
        {section === 'research' && <div className="stat-card">
          <h2 className="text-sm font-semibold text-surface-800 mb-4">备注</h2>
          <div className="space-y-2 mb-4">
            {item.notes.length === 0 ? (
              <p className="text-xs text-surface-400 text-center py-4">暂无备注</p>
            ) : item.notes.map(n => (
              <div key={n.id} className="p-3 bg-surface-50 rounded-lg">
                <p className="text-sm text-surface-700">{n.content}</p>
                <p className="text-[10px] text-surface-400 mt-1">{new Date(n.createdAt).toLocaleString('zh-CN')}</p>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <input type="text" value={noteText} onChange={e => setNoteText(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addNote()}
              placeholder="添加备注..." className="input flex-1" />
            <button onClick={addNote} disabled={!noteText.trim() || saving}
              className="btn-primary text-xs">添加</button>
          </div>
        </div>}
      </div>
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <span className="text-[10px] text-surface-400">{label}</span>
      <p className="text-sm text-surface-700">{value || '—'}</p>
    </div>
  )
}
