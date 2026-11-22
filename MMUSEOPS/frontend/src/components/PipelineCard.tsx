import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { PipelineItem } from '../types/item'
import type { PipelineKey } from '../types/pipeline'
import { getStageStatus, priorityColor } from '../utils/time'
import { getPipeline } from '../data/pipelines'
import { saveItem } from '../store/db'
import { formatDuration } from '../utils/time'

export default function PipelineCard({ item, onRefresh }: { item: PipelineItem; onRefresh: () => void }) {
  const navigate = useNavigate()
  const [showMove, setShowMove] = useState(false)
  const pipeDef = getPipeline(item.pipelineId as PipelineKey)
  const stageDef = pipeDef.stages.find(s => s.id === item.currentStageId)
  const status = getStageStatus(item.pipelineId as PipelineKey, item.currentStageId, item.timeline)

  const statusDot =
    status === 'overdue' ? 'bg-red-500' :
    status === 'warning' ? 'bg-amber-400' :
    'bg-emerald-400'

  const handleAdvance = async (e: React.MouseEvent) => {
    e.stopPropagation()
    const idx = pipeDef.stages.findIndex(s => s.id === item.currentStageId)
    if (idx < 0 || idx >= pipeDef.stages.length - 1) return
    const nextStage = pipeDef.stages[idx + 1]
    const timeline = Array.isArray(item.timeline) ? [...item.timeline] : []
    const current = timeline.find(t => t.stageId === item.currentStageId && !t.exitedAt)
    if (current) current.exitedAt = new Date().toISOString()
    if (timeline.length === 0 || timeline[timeline.length - 1].stageId !== nextStage.id) {
      timeline.push({ stageId: nextStage.id, enteredAt: new Date().toISOString() })
    }
    item.timeline = timeline
    item.currentStageId = nextStage.id
    item.updatedAt = new Date().toISOString()
    await saveItem(item)
    onRefresh()
  }

  const handleRegress = async (e: React.MouseEvent) => {
    e.stopPropagation()
    const idx = pipeDef.stages.findIndex(s => s.id === item.currentStageId)
    if (idx <= 0) return
    const prevStage = pipeDef.stages[idx - 1]
    const timeline = Array.isArray(item.timeline) ? [...item.timeline] : []
    const currentIdx = timeline.findIndex(t => t.stageId === item.currentStageId && !t.exitedAt)
    if (currentIdx >= 0) {
      timeline.splice(currentIdx, 1)
      const prev = timeline.find(t => t.stageId === prevStage.id)
      if (prev) delete prev.exitedAt
    }
    item.timeline = timeline
    item.currentStageId = prevStage.id
    item.updatedAt = new Date().toISOString()
    await saveItem(item)
    onRefresh()
  }

  const canAdvance = pipeDef.stages.findIndex(s => s.id === item.currentStageId) < pipeDef.stages.length - 1
  const canRegress = pipeDef.stages.findIndex(s => s.id === item.currentStageId) > 0

  const handleJump = async (stageId: string) => {
    const timeline = Array.isArray(item.timeline) ? [...item.timeline] : []
    const current = timeline.find(t => t.stageId === item.currentStageId && !t.exitedAt)
    if (current) current.exitedAt = new Date().toISOString()
    if (timeline.length === 0 || timeline[timeline.length - 1].stageId !== stageId) {
      timeline.push({ stageId, enteredAt: new Date().toISOString() })
    }
    item.timeline = timeline
    item.currentStageId = stageId
    item.updatedAt = new Date().toISOString()
    await saveItem(item)
    setShowMove(false)
    onRefresh()
  }

  const levelBadge = (level: string) => {
    if (level === 'unknown') return null
    const colors: Record<string, string> = {
      S: 'bg-emerald-50 text-emerald-700',
      M: 'bg-blue-50 text-blue-700',
      L: 'bg-amber-50 text-amber-700',
      XL: 'bg-red-50 text-red-700',
    }
    return <span className={`badge text-[10px] ${colors[level] || 'bg-surface-100 text-surface-600'}`}>{level}</span>
  }

  return (
    <div className="pipeline-card group" onClick={() => navigate(`/item/${item.id}`)}>
      {/* 顶部 */}
      <div className="flex items-start justify-between mb-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`w-2 h-2 rounded-full ${statusDot} flex-shrink-0`} />
          <span className="text-xs font-medium text-surface-800 truncate">{item.title}</span>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0 ml-2">
          <span className="text-[9px] text-surface-400 bg-surface-100 px-1.5 py-0.5 rounded font-medium">
            {stageDef?.name || ''}
          </span>
          {levelBadge(item.level)}
          <span className={`badge border text-[10px] ${priorityColor(item.priority)}`}>
            {item.priority === 'high' ? '高' : item.priority === 'medium' ? '中' : '低'}
          </span>
        </div>
      </div>

      {/* 客户信息 */}
      <div className="text-xs text-surface-500 mb-2.5 space-y-0.5">
        <p className="break-words">{item.company} · {item.contactName}
          {item.clientType !== 'unknown' && (
            <span className="text-[10px] text-surface-400 ml-1">
              · {item.clientType === 'distributor' ? '经销' : item.clientType === 'trader' ? '贸易' : item.clientType === 'ecommerce' ? '电商' : item.clientType === 'wholesaler' ? '批发' : item.clientType === 'retailer' ? '零售' : item.clientType === 'manufacturer' ? '厂家' : ''}
            </span>
          )}
        </p>
        {item.website && (
          <p className="text-[10px] text-accent-500 break-all">{item.website}</p>
        )}
      </div>

      {/* 发信状态 */}
      {(item.developmentStatus === 'sent' || (item.emailLogs && item.emailLogs.length > 0)) && (
        <div className="flex items-center gap-1.5 mb-2">
          <span className="badge text-[10px] bg-accent-50 text-accent-700">已发信</span>
          {item.emailBounced && (
            <span className="badge text-[10px] bg-red-50 text-red-700">退信</span>
          )}
          {item.emailLogs && item.emailLogs.length > 1 && (
            <span className="text-[9px] text-surface-400">×{item.emailLogs.length}</span>
          )}
        </div>
      )}

      {/* 金额 */}
      {item.estimatedAmount && item.estimatedAmount > 0 && (
        <p className="text-xs font-medium text-surface-700 mb-2.5">
          {item.currency} {item.estimatedAmount.toLocaleString()}
        </p>
      )}

      {/* 底部 */}
      <div className="flex items-center justify-between pt-2.5 border-t border-surface-100">
        <span className="text-[10px] text-surface-400">
          {formatDuration((Array.isArray(item.timeline) && item.timeline.length > 0 ? item.timeline[item.timeline.length - 1].enteredAt : undefined) || item.createdAt)}
        </span>
        <div className="flex gap-1">
          {canRegress && (
            <button onClick={handleRegress}
              className="text-[10px] px-1.5 py-0.5 rounded bg-surface-100 text-surface-500 hover:bg-surface-200 transition-colors"
              title="退回上一工位">◀</button>
          )}
          <div className="relative">
            <button onClick={e => { e.stopPropagation(); setShowMove(!showMove) }}
              className="text-[10px] px-1.5 py-0.5 rounded bg-surface-100 text-surface-500 hover:bg-surface-200 transition-colors"
              title="移动到其他工位">↕</button>
            {showMove && (
              <div className="absolute bottom-full left-0 mb-1 bg-surface-0 border border-surface-200 rounded-lg shadow-float z-20 py-1 min-w-[100px]" onClick={e => e.stopPropagation()}>
                {pipeDef.stages.filter(s => s.id !== item.currentStageId).map(s => (
                  <button key={s.id} onClick={() => handleJump(s.id)}
                    className="block w-full text-left text-xs px-3 py-1.5 text-surface-700 hover:bg-accent-50 hover:text-accent-700 whitespace-nowrap transition-colors">
                    {s.name}
                  </button>
                ))}
              </div>
            )}
          </div>
          {canAdvance && (
            <button onClick={handleAdvance}
              className="text-[10px] px-1.5 py-0.5 rounded bg-accent-50 text-accent-600 hover:bg-accent-100 transition-colors"
              title="推进到下一工位">▶</button>
          )}
        </div>
      </div>
    </div>
  )
}
