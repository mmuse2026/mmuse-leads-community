import { existsSync, readFileSync, statSync } from 'node:fs'
import { activeMarketingCustomer, campaignOutcomes, marketingBusinessLine, type MarketingState, type MarketingCustomer } from '../src/services/marketingBridge'

export function readMarketingBridge(): MarketingState {
  return {schema_version:1,revision:0,workspaces:{}}
}

export function marketingOutcomes(state: MarketingState, workspaceId: string, customers: MarketingCustomer[]) {
  const workspace = state.workspaces[workspaceId]
  if (workspace?.business_line === 'knitwear' && !customers.some(customer => marketingBusinessLine(customer.businessLine) === 'knitwear')) {
    return {workspace_id:workspaceId,business_line:'knitwear',status:'unavailable',reason:'WOOL_CUSTOMER_SOURCE_NOT_CONNECTED',campaigns:[]}
  }
  return {workspace_id:workspaceId, business_line:workspace?.business_line || 'unsupported',
          campaigns:workspace ? campaignOutcomes(workspace, customers) : []}
}

export function marketingCustomerRef(customers: MarketingCustomer[], id: string) {
  const item = customers.find(c => c.id === id && activeMarketingCustomer(c))
  return item ? {id:item.id,business_line:marketingBusinessLine(item.businessLine)} : null
}

export function sharedMarketingForCustomer(state: MarketingState, customer: MarketingCustomer) {
  const candidates = Object.values(state.workspaces).filter(w => w.business_line === marketingBusinessLine(customer.businessLine))
  const linked = candidates.filter(w => w.touches.some(t => t.customer_id === customer.id))
  const selected = linked.length === 1 ? linked[0] : candidates.length === 1 ? candidates[0] : undefined
  if (!selected?.context.approved) return null
  return {
    confirmed_supplier_context: selected.context,
    customer_source_evidence: selected.touches.filter(t => t.customer_id === customer.id && t.confidence !== 'unverified').map(t => ({source:t.source, confidence:t.confidence, intent:t.intent, evidence:t.evidence, ai_tool:t.ai_tool || ''})),
    approved_sales_assets: selected.assets.filter(a => a.approved).map(a => ({kind:a.kind,title:a.title,text:a.text})),
  }
}

let customerSnapshot: {path:string; stamp:string; rows:MarketingCustomer[]} | undefined
export function readMarketingCustomers(path: string): MarketingCustomer[] {
  const info=statSync(path), stamp=`${info.mtimeMs}:${info.size}`
  if(customerSnapshot?.path===path && customerSnapshot.stamp===stamp) return customerSnapshot.rows
  const parsed=JSON.parse(readFileSync(path,'utf8'))
  if(!Array.isArray(parsed)) throw new Error('CUSTOMER_STORE_INVALID')
  const rows=parsed.map(c=>({id:c.id,businessLine:c.businessLine,status:c.status,crmMergedInto:c.crmMergedInto,inactiveCategory:c.inactiveCategory,activeWorkflow:c.activeWorkflow,inactiveWorkflow:c.inactiveWorkflow,salesStage:c.salesStage,backCheck:{products:c.backCheck?.products,industry:c.backCheck?.industry,summary:c.backCheck?.summary},crmTasks:c.crmTasks?.map((t:any)=>({status:t.status,dueAt:t.dueAt})),quoteVersions:c.quoteVersions?.map((q:any)=>({status:q.status})),opportunities:c.opportunities?.map((o:any)=>({status:o.status,products:o.products,specifications:o.specifications,concerns:o.concerns}))}))
  customerSnapshot={path,stamp,rows}
  return rows
}
