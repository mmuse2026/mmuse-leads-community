export type MarketingContext = Record<string, string | number | boolean>
export interface MarketingCampaign { id: string; name: string; product: string; audience: string; objective: string; kpi: string; content_id?: string }
export interface MarketingTouch { id: string; customer_id: string; campaign_id: string; source: string; confidence: string; intent: string; evidence: string; country?: string; ai_tool?: string; created_at: string; occurred_at?: string }
export interface MarketingWorkspace { business_line: string; context: MarketingContext; campaigns: MarketingCampaign[]; touches: MarketingTouch[]; assets: Array<{kind:string; title:string; text:string; approved:boolean}>; experiments: Array<{hypothesis:string; metric:string; window:string; conclusion?:string}> }
export interface MarketingState { schema_version: number; revision: number; workspaces: Record<string, MarketingWorkspace> }
export interface MarketingCustomer { id: string; businessLine?: string; salesStage?: string; quoteVersions?: Array<{status?:string}>; opportunities?: Array<{status:string}>; status?: string; crmMergedInto?: string; inactiveCategory?: string; activeWorkflow?: boolean; inactiveWorkflow?: boolean }

export function activeMarketingCustomer(c: MarketingCustomer): boolean {
  return c.status !== 'archived' && !c.crmMergedInto && c.inactiveCategory !== 'duplicate' && c.activeWorkflow !== false && c.inactiveWorkflow !== true
}

export function marketingBusinessLine(value: string | undefined): string {
  if (value === 'furniture' || value === 'Furniture Supplier') return 'furniture'
  if (value === 'carseat' || value === 'car-seat') return 'carseat'
  if (value === 'wool' || value === 'knitwear') return 'knitwear'
  return 'unsupported'
}

export function campaignOutcomes(workspace: MarketingWorkspace, customers: MarketingCustomer[]) {
  const byId = new Map(customers.filter(c => activeMarketingCustomer(c) && marketingBusinessLine(c.businessLine) === workspace.business_line).map(c => [c.id, c]))
  return workspace.campaigns.map(campaign => {
    const touches = workspace.touches.filter(t => t.campaign_id === campaign.id && byId.has(t.customer_id))
    const ids = [...new Set(touches.map(t => t.customer_id))]
    const rows = ids.map(id => byId.get(id)!)
    return {
      id: campaign.id, name: campaign.name, customers: rows.length,
      inquiries: ids.filter(id => touches.some(t => t.customer_id === id && t.confidence !== 'unverified' && ['inquiry','project'].includes(t.intent))).length,
      quoted: rows.filter(c => ['quoted','negotiation','sample','decision_pending','won'].includes(c.salesStage || '') || c.quoteVersions?.some(q => ['sent','viewed','accepted'].includes(q.status || ''))).length,
      opportunities: rows.filter(c => c.opportunities?.some(o => !['lost','paused'].includes(o.status))).length,
      won: rows.filter(c => c.salesStage === 'won' || c.opportunities?.some(o => o.status === 'won')).length,
    }
  })
}

export function outreachBrief(workspace: MarketingWorkspace, customerId: string, campaignId: string) {
  const campaign = workspace.campaigns.find(c => c.id === campaignId)
  const context = workspace.context.approved ? workspace.context : {}
  const touches = workspace.touches.filter(t => t.customer_id === customerId).sort((a,b) => Date.parse(a.occurred_at||a.created_at)-Date.parse(b.occurred_at||b.created_at))
  const evidenced = touches.filter(t => t.confidence !== 'unverified')
  const strong = evidenced.some(t => ['inquiry','project'].includes(t.intent))
  return {
    firstTouch: touches[0], lastTouch: touches[touches.length-1],
    priority: strong ? '有采购信号，优先人工确认需求' : '按现有背调/邮箱门禁开发，来源本身不证明采购意向',
    text: [
      campaign ? `开发主题：${campaign.product}；目标受众：${campaign.audience}。需先核对客户与主题匹配。` : '系统根据客户已有需求和背调推荐相关资料，无需选择活动。',
      context.products ? `已确认产品事实：${context.products}` : '尚无已确认共享资料，先补充事实和证据。',
      context.pain_points ? `可讨论的采购问题：${context.pain_points}` : '',
      context.differentiation ? `有依据的卖点：${context.differentiation}` : '',
      context.evidence ? `可引用证据：${context.evidence}` : '',
      context.forbidden_claims ? `禁止使用：${context.forbidden_claims}` : '',
      evidenced.length ? `来源证据（客户自报/已核实，非浏览追踪）：${evidenced.map(t => `${t.source}${t.ai_tool ? '/'+t.ai_tool : ''}：${t.evidence}`).join('；')}` : '没有可信来源证据，邮件中不得声称客户看过某篇内容。',
      ...workspace.assets.filter(a => a.approved).slice(-5).map(a => `销售参考 · ${a.title}：${a.text}`),
      strong ? '下一步：确认用途、数量、规格、采购时间和项目阶段，再选案例/资料；保持原发送审批流程。' : '下一步：围绕客户业务提出一个具体采购问题，提供一份相关资料，避免重复催问。',
    ].filter(Boolean).join('\n\n'),
  }
}
