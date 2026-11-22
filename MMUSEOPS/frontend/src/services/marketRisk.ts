import type { PipelineItem } from '../types/item'

export type MarketRiskLevel = 'high' | 'medium' | 'opportunity'

export interface MarketRisk {
  level: MarketRiskLevel
  title: string
  detail: string
}

const RULES: { keys: string[]; risks: MarketRisk[] }[] = [
  {
    keys: ['india', '印度'],
    risks: [{ level: 'high', title: '收款/尾款风险', detail: '建议开发前确认付款方式，优先定金+发货前付清，谨慎账期。' }],
  },
  {
    keys: ['brazil', '巴西'],
    risks: [{ level: 'high', title: '清关复杂', detail: '巴西清关和税费不确定性高，报价前确认进口资质、税号和目的港费用。' }],
  },
  {
    keys: ['iran', 'iraq', 'syria', 'yemen', 'israel', 'palestine', 'lebanon', '伊朗', '伊拉克', '叙利亚', '也门', '以色列', '巴勒斯坦', '黎巴嫩'],
    risks: [{ level: 'high', title: '战争/物流风险', detail: '可能影响船期、保险、收款和尾款安全，开发前必须人工确认。' }],
  },
  {
    keys: ['russia', 'ukraine', '俄罗斯', '乌克兰'],
    risks: [{ level: 'high', title: '制裁/物流风险', detail: '可能存在付款通道、运输路线和制裁合规风险，暂不建议自动开发。' }],
  },
  {
    keys: ['united states', 'usa', 'us', 'america', '美国'],
    risks: [{ level: 'medium', title: '关税敏感', detail: '美国客户报价前需关注关税、反倾销和本地替代供应商压力。' }],
  },
  {
    keys: ['australia', '澳大利亚', '澳洲'],
    risks: [{ level: 'opportunity', title: '政策/市场机会', detail: '可重点开发中小经销商、餐饮家具供应商和汽车用品渠道，注意本地认证要求。' }],
  },
  {
    keys: ['south africa', 'kenya', 'nigeria', 'ghana', 'africa', '南非', '肯尼亚', '尼日利亚', '加纳', '非洲'],
    risks: [{ level: 'medium', title: '付款和清关需确认', detail: '可开发进口商/批发商，但需提前确认付款节点、目的港清关和运输周期。' }],
  },
  {
    keys: ['saudi', 'uae', 'qatar', 'kuwait', 'oman', 'bahrain', '沙特', '阿联酋', '卡塔尔', '科威特', '阿曼', '巴林'],
    risks: [{ level: 'medium', title: '中东物流波动', detail: '开发可做，但报价和交期需预留运费、船期和区域局势波动。' }],
  },
]

function textOf(item: PipelineItem): string {
  return [
    item.country,
    item.backCheck?.markets?.join(' '),
    item.backCheck?.summary,
    item.snippet,
  ].filter(Boolean).join(' ').toLowerCase()
}

export function getMarketRisks(item: PipelineItem): MarketRisk[] {
  const text = textOf(item)
  const found: MarketRisk[] = []
  for (const rule of RULES) {
    if (rule.keys.some(key => text.includes(key.toLowerCase()))) found.push(...rule.risks)
  }
  return found
}

export function hasBlockingMarketRisk(item: PipelineItem): boolean {
  return getMarketRisks(item).some(r => r.level === 'high')
}
