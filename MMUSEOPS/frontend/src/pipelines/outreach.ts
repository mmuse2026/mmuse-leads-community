import type { PipelineDef } from '../types/pipeline'

export const outreachPipeline: PipelineDef = {
  id: 'outreach',
  name: '客户开发',
  key: 'outreach',
  description: '发现 → 背调 → 联系方式 → 验证邮箱 → 开发信 → 跟进',
  icon: '',
  businessLine: 'both',
  stages: [
    { id: 'otr-found',      name: '新发现',    description: '搜索发现的新线索',                        order: 1, standardHours: 24, templates: ['outreach-form'] },
    { id: 'otr-backcheck',  name: '客户背调',  description: '筛选目标客户/同行/不保留，人工分类',       order: 2, standardHours: 48, templates: ['backcheck-form'] },
    { id: 'otr-contact',    name: '联系方式',  description: '补充邮箱/电话/决策人等信息',              order: 3, standardHours: 12, templates: [] },
    { id: 'otr-verify',     name: '验证邮箱',  description: '验证邮箱有效性',                          order: 4, standardHours: 6,  templates: [] },
    { id: 'otr-first',      name: '首封触达',  description: '发送第一封开发信',                        order: 5, standardHours: 48, templates: ['cold-email', 'cold-wa'] },
    { id: 'otr-follow',     name: '跟进培育',  description: '跟进中，按节奏发送后续内容',               order: 6, standardHours: 168, templates: ['follow-email'] },
    { id: 'otr-replied',    name: '已回复',    description: '客户回复，转入询盘管道',                  order: 7, standardHours: 0,  templates: ['transfer-inquiry'] },
    { id: 'otr-silent',     name: '已沉默',    description: '45天无回复，转入冷库',                    order: 8, standardHours: 0,  templates: [] },
  ],
}
