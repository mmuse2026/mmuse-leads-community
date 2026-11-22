/** 管道核心类型定义 */

/** 业务线 */
export type BusinessLine = 'car-seat' | 'furniture' | 'both' | 'lighting' | 'home' | 'packaging'

/** 工位定义 */
export interface StageDef {
  id: string
  name: string
  description: string
  /** 排序号，从 1 开始 */
  order: number
  /** 此工位标准停留小时数，超时预警用 */
  standardHours: number
  /** 此工位可用的模板 key（可选） */
  templates?: string[]
}

/** 管道定义（配置，运行时不变） */
export interface PipelineDef {
  id: string
  name: string
  /** 路由 key */
  key: string
  description: string
  icon: string
  stages: StageDef[]
  /** 适用业务线 */
  businessLine: BusinessLine
}

/** 管道列表（供看板聚合） */
export type PipelineKey = 'inquiry' | 'order' | 'sample' | 'outreach'
