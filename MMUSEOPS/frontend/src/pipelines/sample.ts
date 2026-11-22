import type { PipelineDef } from '../types/pipeline'

export const samplePipeline: PipelineDef = {
  id: 'sample',
  name: '样品管理',
  key: 'sample',
  description: '客户申请样品 → 准备 → 寄送 → 签收 → 反馈跟进',
  icon: '',
  businessLine: 'both',
  stages: [
    { id: 'smp-request',    name: '客户申请',  description: '客户提出样品需求，记录规格',        order: 1, standardHours: 4,  templates: ['sample-form'] },
    { id: 'smp-prepare',    name: '准备样品',  description: '调样/生产样品，拍照存档',            order: 2, standardHours: 24, templates: [] },
    { id: 'smp-shipped',    name: '已寄送',    description: '样品已寄出，录入物流单号',           order: 3, standardHours: 120, templates: ['tracking-info'] },
    { id: 'smp-signed',     name: '已签收',    description: '客户已签收，等待反馈',              order: 4, standardHours: 72, templates: ['feedback-reminder'] },
    { id: 'smp-converted',  name: '已转化',    description: '客户满意→转订单，或不满意→归档',    order: 5, standardHours: 0,  templates: [] },
  ],
}
