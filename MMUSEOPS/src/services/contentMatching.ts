import { activeMarketingCustomer, marketingBusinessLine, type MarketingCustomer } from './marketingBridge'

const TOPICS: Record<string,string[]> = {
  '羊毛衫 / Knitwear':['羊毛衫','针织','knitwear','sweater','wool'],
  '羊绒 / Cashmere':['羊绒','cashmere'],
  '打样 / Sampling':['打样','sample','sampling'],
  '卡座 / Banquette':['卡座','booth','banquette'],
  '椅子 / Chair':['椅','chair','seating'],
  '桌子 / Table':['桌','table'],
  '户外家具':['户外','outdoor','patio','garden'],
  '酒店项目':['酒店','hotel','hospitality'],
  '餐饮空间':['餐厅','餐饮','restaurant','dining','foodservice'],
  '咖啡店':['咖啡','cafe','coffee'],
  '座椅套':['座椅套','seat cover','seat covers'],
  '定制 / OEM':['定制','custom','oem','bespoke'],
  '材质 / 面料':['材质','面料','material','fabric','leather','upholstery'],
  '维护 / 清洁':['维护','清洁','maintenance','cleaning','washable'],
  '交付 / 交期':['交付','交期','delivery','lead time'],
}
export interface ContentDocument { id:string; title:string; text:string; kind:string; status:string; url:string; business_line:string }
export interface CustomerResearch extends MarketingCustomer { backCheck?: {products?:unknown;summary?:string;industry?:string}; opportunities?: Array<{status:string;products?:string[];specifications?:string;concerns?:string[]}> }
function topicHits(text:string):string[]{const value=text.toLowerCase();return Object.entries(TOPICS).filter(([,terms])=>terms.some(t=>/[\u4e00-\u9fff]/.test(t)?value.includes(t):new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}s?\\b`).test(value))).map(([name])=>name)}
export function customerTopics(customer:CustomerResearch) {
  const needs=(customer.opportunities||[]).filter(o=>!['lost','paused'].includes(o.status)).flatMap(o=>[...(o.products||[]),o.specifications||'',...(o.concerns||[])]).join(' ')
  const research=[JSON.stringify(customer.backCheck?.products||[]),customer.backCheck?.industry||'',customer.backCheck?.summary||''].join(' ')
  const explicit=topicHits(needs), inferred=topicHits(research)
  return [...new Set([...explicit,...inferred])].map(topic=>({topic,kind:explicit.includes(topic)?'recorded_need':'research_fit'}))
}
export function matchCustomerContent(customer:CustomerResearch, documents:ContentDocument[]) {
  const topics=customerTopics(customer), line=marketingBusinessLine(customer.businessLine)
  const matches=documents.filter(d=>d.business_line===line).map(document=>{
    const hits=topicHits(document.title+' '+document.text)
    const reasons=topics.filter(t=>hits.includes(t.topic))
    return {...document,score:reasons.reduce((sum,r)=>sum+(r.kind==='recorded_need'?5:2),0),reasons}
  }).filter(d=>d.score>0).sort((a,b)=>b.score-a.score||a.title.localeCompare(b.title)).slice(0,8)
  return {topics,matches,gaps:topics.filter(t=>!documents.some(d=>d.business_line===line&&topicHits(d.title+' '+d.text).includes(t.topic))),basis:'根据已记录需求和背调主题推荐；不表示客户看过或认可这些内容。'}
}
export function demandTopics(customers:CustomerResearch[],line:string) {
  const grouped=new Map<string,{topic:string;customers:number;recordedNeeds:number}>()
  for(const customer of customers.filter(c=>activeMarketingCustomer(c)&&marketingBusinessLine(c.businessLine)===line))for(const hit of customerTopics(customer)){
    const row=grouped.get(hit.topic)||{topic:hit.topic,customers:0,recordedNeeds:0};row.customers++;if(hit.kind==='recorded_need')row.recordedNeeds++;grouped.set(hit.topic,row)
  }
  return [...grouped.values()].sort((a,b)=>b.recordedNeeds-a.recordedNeeds||b.customers-a.customers).map(row=>({...row,terms:TOPICS[row.topic]}))
}
