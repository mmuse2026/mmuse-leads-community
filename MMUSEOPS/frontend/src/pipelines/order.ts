import type { PipelineDef } from '../types/pipeline'

export const orderPipeline: PipelineDef = {
  id: 'order',
  name: '订单履约',
  key: 'order',
  description: '客户确认下单 → 生产制造 → QC → 发货 → 归档',
  icon: '',
  businessLine: 'both',
  stages: [
    { id: 'ord-confirm',    name: '待确认',    description: '客户PO收到，确认订单细节',         order: 1, standardHours: 8,  templates: ['po-confirm'] },
    { id: 'ord-prep',       name: '备料排产',  description: '采购原材料/备料，排入生产计划',     order: 2, standardHours: 48, templates: ['material-list'] },
    { id: 'ord-manufacture',name: '生产中',    description: '车间生产制造中',                   order: 3, standardHours: 120, templates: ['progress-report'] },
    { id: 'ord-qc',         name: 'QC质检',    description: '质检员验货，通过后进入包装',         order: 4, standardHours: 12, templates: ['qc-check'] },
    { id: 'ord-pack',       name: '包装出货',  description: '打包、贴唛、安排物流',              order: 5, standardHours: 24, templates: ['packing-list'] },
    { id: 'ord-shipped',    name: '已出运',    description: '货已发出，更新物流单号',            order: 6, standardHours: 0,  templates: ['tracking-info'] },
    { id: 'ord-done',       name: '已完成',    description: '客户签收完成，启动售后计时',         order: 7, standardHours: 0,  templates: [] },
  ],
}
