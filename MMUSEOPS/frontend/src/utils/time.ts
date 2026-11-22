/** 管道时间计算工具 */
import { getPipeline } from '../data/pipelines'
import type { PipelineKey } from '../types/pipeline'
import type { StageTransition } from '../types/item'

/** 计算某个工位的超时状态 */
export function getStageStatus(
  pipelineKey: PipelineKey,
  stageId: string,
  timeline: StageTransition[] | undefined | null,
): 'normal' | 'warning' | 'overdue' {
  const p = getPipeline(pipelineKey)
  const stageDef = p.stages.find(s => s.id === stageId)
  if (!stageDef || stageDef.standardHours <= 0) return 'normal'
  if (!timeline || !Array.isArray(timeline)) return 'normal'

  const transition = timeline.find(t => t.stageId === stageId)
  if (!transition) return 'normal'

  const entered = new Date(transition.enteredAt).getTime()
  const exited = transition.exitedAt ? new Date(transition.exitedAt).getTime() : Date.now()
  const elapsedHours = (exited - entered) / 3600_000

  if (elapsedHours > stageDef.standardHours * 1.5) return 'overdue'
  if (elapsedHours > stageDef.standardHours) return 'warning'
  return 'normal'
}

/** 格式化持续时间 */
export function formatDuration(enteredAt: string, exitedAt?: string): string {
  const start = new Date(enteredAt).getTime()
  const end = exitedAt ? new Date(exitedAt).getTime() : Date.now()
  const hours = (end - start) / 3600_000

  if (hours < 1) return `${Math.round(hours * 60)}分钟`
  if (hours < 24) return `${hours.toFixed(1)}小时`
  return `${(hours / 24).toFixed(1)}天`
}

/** 优先级颜色 */
export function priorityColor(p: string): string {
  switch (p) {
    case 'high': return 'text-red-600 bg-red-50 border-red-200'
    case 'medium': return 'text-amber-600 bg-amber-50 border-amber-200'
    case 'low': return 'text-gray-500 bg-gray-50 border-gray-200'
    default: return 'text-gray-500 bg-gray-50 border-gray-200'
  }
}

/** 获取当前活跃工位的索引 */
export function getStageIndex(pipelineKey: PipelineKey, stageId: string): number {
  const p = getPipeline(pipelineKey)
  return p.stages.findIndex(s => s.id === stageId)
}
