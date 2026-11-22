/** 管道注册表——4条管道的统一导出 */
import { inquiryPipeline } from '../pipelines/inquiry'
import { orderPipeline } from '../pipelines/order'
import { samplePipeline } from '../pipelines/sample'
import { outreachPipeline } from '../pipelines/outreach'
import type { PipelineDef, PipelineKey } from '../types/pipeline'

const pipelineMap: Record<PipelineKey, PipelineDef> = {
  inquiry: inquiryPipeline,
  order: orderPipeline,
  sample: samplePipeline,
  outreach: outreachPipeline,
}

export const pipelines = Object.values(pipelineMap)

export function getPipeline(key: PipelineKey): PipelineDef {
  const p = pipelineMap[key]
  if (!p) throw new Error(`Unknown pipeline: ${key}`)
  return p
}

export function getStage(pipelineKey: PipelineKey, stageId: string) {
  const p = getPipeline(pipelineKey)
  return p.stages.find(s => s.id === stageId)
}

export function getNextStage(pipelineKey: PipelineKey, currentStageId: string): string | null {
  const p = getPipeline(pipelineKey)
  const idx = p.stages.findIndex(s => s.id === currentStageId)
  if (idx < 0 || idx >= p.stages.length - 1) return null
  return p.stages[idx + 1].id
}

export function getPrevStage(pipelineKey: PipelineKey, currentStageId: string): string | null {
  const p = getPipeline(pipelineKey)
  const idx = p.stages.findIndex(s => s.id === currentStageId)
  if (idx <= 0) return null
  return p.stages[idx - 1].id
}
