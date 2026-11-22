import type { StageDef, PipelineKey } from '../types/pipeline'
import type { PipelineItem } from '../types/item'
import { getStageStatus } from '../utils/time'
import PipelineCard from './PipelineCard'

export default function StageColumn({
  stageDef, items, onRefresh,
}: {
  stageDef: StageDef
  items: PipelineItem[]
  onRefresh: () => void
}) {
  const overdueCount = items.filter(item =>
    getStageStatus(item.pipelineId as PipelineKey || 'inquiry', stageDef.id, item.timeline) === 'overdue'
  ).length

  return (
    <div className="kanban-column">
      {/* 列头 */}
      <div className="flex items-center justify-between mb-3 px-1">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm text-surface-800">{stageDef.name}</span>
          <span className="text-[11px] font-medium text-surface-400 bg-surface-200 px-1.5 py-0.5 rounded-md">
            {items.length}
          </span>
        </div>
        {overdueCount > 0 && (
          <span className="text-[10px] font-medium text-red-500 bg-red-50 px-1.5 py-0.5 rounded-md">
            {overdueCount} 超时
          </span>
        )}
      </div>

      {/* 标准时间 */}
      {stageDef.standardHours > 0 && (
        <p className="text-[10px] text-surface-400 mb-2.5 px-1">
          标准 ≤ {stageDef.standardHours}h
        </p>
      )}

      {/* 卡片列表 */}
      <div className="space-y-2 overflow-y-auto flex-1 min-h-0">
        {items.map(item => (
          <PipelineCard key={item.id} item={item} onRefresh={onRefresh} />
        ))}
        {items.length === 0 && (
          <div className="text-center py-10 text-xs text-surface-400">
            暂无工单
          </div>
        )}
      </div>
    </div>
  )
}
