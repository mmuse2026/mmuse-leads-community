import { customerTopics, demandTopics, matchCustomerContent, type ContentDocument, type CustomerResearch } from './contentMatching'
import { activeMarketingCustomer, marketingBusinessLine } from './marketingBridge'

export interface ProductionCustomer extends CustomerResearch { crmTasks?: Array<{status:string;dueAt:string}> }
export interface ProductionDocument extends ContentDocument { media_type?:string; available?:boolean }
export function buildContentProduction(customers:ProductionCustomer[],documents:ProductionDocument[],line:string,now=new Date().toISOString()) {
  line=marketingBusinessLine(line)
  const names:Record<string,string>={furniture:'家具',carseat:'汽车座椅套',knitwear:'羊毛衫/针织服装'}
  if(!names[line])throw new Error('BUSINESS_LINE_REQUIRED')
  const active=customers.filter(c=>activeMarketingCustomer(c)&&marketingBusinessLine(c.businessLine)===line)
  const scoped=documents.filter(d=>d.business_line===line)
  const tasks=demandTopics(active,line).map(row=>{
    const related=active.filter(c=>customerTopics(c).some(t=>t.topic===row.topic))
    const synthetic:CustomerResearch={id:'aggregate',businessLine:line==='carseat'?'car-seat':line,status:'active',opportunities:[{status:'confirmed',products:row.terms}]}
    const matching=scoped.filter(d=>matchCustomerContent(synthetic,[d]).matches.some(m=>m.reasons.some(r=>r.topic===row.topic)))
    const content=matching.filter(d=>d.kind!=='素材')
    const ready=content.filter(d=>['approved','published','scheduled'].includes(d.status))
    const visuals=matching.filter(d=>d.kind==='素材'&&['image','video','gif'].includes(d.media_type||'')&&d.status==='completed'&&d.available===true)
    const missing:string[]=[]
    if(!content.length)missing.push('主题内容')
    else if(!ready.length)missing.push('内容审核')
    if(!visuals.length)missing.push('图片或视频')
    const dates=related.flatMap(c=>(c.crmTasks||[]).filter(t=>['pending','in_progress'].includes(t.status)&&Number.isFinite(Date.parse(t.dueAt))).map(t=>t.dueAt)).sort((a,b)=>Date.parse(a)-Date.parse(b))
    const neededBy=dates[0]||null
    const urgent=neededBy!==null&&Date.parse(neededBy)<=Date.parse(now)+7*86400000
    const priority:'high'|'medium'|'low'=row.recordedNeeds>0&&urgent?'high':row.recordedNeeds>0?'medium':'low'
    const timing=neededBy?`建议在关联客户最近待办 ${neededBy} 前准备；不是自动发布日`:'没有已记录期限：按内容计划准备，不虚构发布时间'
    const reason=row.recordedNeeds?`${row.recordedNeeds} 位客户有已记录需求；另有 ${row.customers-row.recordedNeeds} 位背调主题相关`:`${row.customers} 位客户背调业务相关，尚非明确询问`
    const references=matching.slice(0,6).map(d=>({id:d.id,title:d.title,kind:d.kind,status:d.status,url:d.url}))
    const prompt=[`业务线：${names[line]}；内容任务：${row.topic}`,`需求依据：${reason}`,`准备时间：${timing}`,`缺口：${missing.join('、')||'已有参考，核对适配性后复用'}`,`先复用现有内容：${references.map(d=>`${d.title} (${d.status}) ${d.url}`).join('；')||'目录中未找到对应主题'}`,'请基于本机已确认产品资料补充买家问题解答、英文社媒文案、网站SEO/GEO问答摘要及所缺图片/短视频素材。不得编造认证、性能、价格、交期或客户案例；AI示意图不得作为真实产品/项目证据。',`使用可检索主题名称/标签：${row.terms.join('、')}。文字保存到对应BAKA业务工作区文章/社媒草稿，素材保存到该工作区素材库并填写标题/标签，保留真实事实来源。`,'优先编辑已有草稿，完成后重新读取任务目录核对缺口；进入现有排版/审核/排期流程，不改已有发布计划，不得自动发布或对客户发送。'].join('\n')
    return {id:`${line}:${row.topic}`,topic:row.topic,customers:row.customers,recordedNeeds:row.recordedNeeds,state:missing.length?'needs_work':'reusable',priority,neededBy,timing,reason,missing,references,prompt}
  }).sort((a,b)=>({high:0,medium:1,low:2}[a.priority]-{high:0,medium:1,low:2}[b.priority])||b.recordedNeeds-a.recordedNeeds||b.customers-a.customers)
  return {business_line:line,generated_at:now,total_customers:active.length,unclassified_customers:active.filter(c=>!customerTopics(c).length).length,tasks,pending:tasks.filter(t=>t.state==='needs_work').length,reusable:tasks.filter(t=>t.state==='reusable').length,basis:'规则主题匹配，仅为候选覆盖；素材质量、产品真实性和发布适配性仍需审核。日期来自关联客户待办，不代表客户要求的交期。'}
}
