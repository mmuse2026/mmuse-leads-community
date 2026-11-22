import type { PipelineDef } from '../types/pipeline'

export const inquiryPipeline: PipelineDef = {
  id: 'inquiry',
  name: '询盘报价',
  key: 'inquiry',
  description: '客户询盘 → 报价 → 跟进 → 成交或归档',
  icon: '',
  businessLine: 'both',
  stages: [
    { id: 'inq-new',        name: '新询盘',    description: '收到客户询盘，待处理',           order: 1, standardHours: 4,  templates: ['product-identify'] },
    { id: 'inq-identify',   name: '产品识别',  description: '确定客户需求对应哪款产品',         order: 2, standardHours: 2,  templates: [] },
    { id: 'inq-quote',      name: '报价制作',  description: '制作报价单，含价格/交期/条款',     order: 3, standardHours: 8,  templates: ['quote-template'] },
    { id: 'inq-sent',       name: '已发送',    description: '报价已发给客户，等待回复',         order: 4, standardHours: 48, templates: ['follow-up'] },
    { id: 'inq-follow',     name: '跟进中',    description: '客户在谈价格/条款，多轮沟通',      order: 5, standardHours: 72, templates: [] },
    { id: 'inq-won',        name: '已成交',    description: '客户确认下单，转入订单管道',      order: 6, standardHours: 0,  templates: ['transfer-order'] },
    { id: 'inq-lost',       name: '已归档',    description: '未成交或客户流失，归档备查',       order: 7, standardHours: 0,  templates: [] },
  ],
}
