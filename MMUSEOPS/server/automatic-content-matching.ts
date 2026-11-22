import http from 'node:http'
import { buildContentProduction, type ProductionCustomer, type ProductionDocument } from '../src/services/contentProduction'
import { demandTopics, matchCustomerContent, type CustomerResearch, type ContentDocument } from '../src/services/contentMatching'
import { activeMarketingCustomer, marketingBusinessLine } from '../src/services/marketingBridge'
import { readMarketingBridge, readMarketingCustomers } from './marketing-bridge'

let catalogQueue:Promise<unknown>=Promise.resolve()
function customerSource(itemsFile:string,line:string) {
  const customers=readMarketingCustomers(itemsFile) as CustomerResearch[]
  // Wool's current customers live in a separate authoritative SQLite source.
  // An empty unrelated MMUSE namespace must not be reported as zero wool demand.
  if(line==='knitwear'&&!customers.some(customer=>marketingBusinessLine(customer.businessLine)==='knitwear'))throw new Error('WOOL_CUSTOMER_SOURCE_NOT_CONNECTED')
  return customers
}
const catalogInflight=new Map<string,Promise<{business_line:string;documents:ContentDocument[]}>>()
function localCatalog(workspaceId:string):Promise<{business_line:string;documents:ContentDocument[]}> {
  const existing=catalogInflight.get(workspaceId)
  if(existing)return existing
  // Local auto-login can write SQLite sessions. Serialize directory calls to avoid locks.
  const next=catalogQueue.then(()=>fetchLocalCatalog(workspaceId))
  catalogQueue=next.catch(()=>undefined)
  catalogInflight.set(workspaceId,next)
  void next.finally(()=>catalogInflight.delete(workspaceId)).catch(()=>undefined)
  return next
}
function fetchLocalCatalog(workspaceId:string):Promise<{business_line:string;documents:ContentDocument[]}> {
  return new Promise((resolve,reject)=>{
    const request=http.get(`http://127.0.0.1:8000/workspace/${encodeURIComponent(workspaceId)}/marketing/content/`,response=>{
      if(response.statusCode!==200){response.resume();reject(new Error('CONTENT_CATALOG_AUTH_OR_SERVICE_UNAVAILABLE'));return}
      const chunks:Buffer[]=[];let size=0
      response.on('data',chunk=>{size+=chunk.length;if(size>25_000_000){response.destroy();reject(new Error('CONTENT_CATALOG_TOO_LARGE'))}else chunks.push(chunk)})
      response.on('error',reject)
      response.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))}catch(error){reject(error)}})
    })
    request.setTimeout(10000,()=>request.destroy(new Error('CONTENT_CATALOG_TIMEOUT')));request.on('error',reject)
  })
}

export async function automaticContentMatches(itemsFile:string,customerId:string) {
  const customer=(readMarketingCustomers(itemsFile) as CustomerResearch[]).find(c=>c.id===customerId&&activeMarketingCustomer(c))
  if(!customer)throw new Error('CUSTOMER_NOT_FOUND')
  const line=marketingBusinessLine(customer.businessLine)
  const entries=Object.entries(readMarketingBridge().workspaces).filter(([,w])=>w.business_line===line)
  if(entries.length>1)throw new Error('MARKETING_WORKSPACE_AMBIGUOUS')
  const workspaceEntry=entries[0]
  if(!workspaceEntry)throw new Error('MARKETING_WORKSPACE_NOT_FOUND')
  const [workspaceId,workspace]=workspaceEntry
  const catalog=await localCatalog(workspaceId)
  if(catalog.business_line!==line)throw new Error('BUSINESS_LINE_MISMATCH')
  const assets:ContentDocument[]=workspace.assets.filter(a=>a.approved).map((a,i)=>({id:`asset-${i}`,title:a.title,text:a.text,kind:'已确认销售资料',status:'approved',business_line:line,url:`/workspace/${workspaceId}/marketing/`}))
  return {...matchCustomerContent(customer,[...catalog.documents,...assets]),workspace_id:workspaceId,catalog_count:catalog.documents.length}
}

export function automaticDemandTopics(itemsFile:string,line:string) {
  const canonical=marketingBusinessLine(line)
  if(!['furniture','carseat','knitwear'].includes(canonical))throw new Error('BUSINESS_LINE_REQUIRED')
  return {business_line:canonical,scope:'business_line_aggregate',topics:demandTopics(customerSource(itemsFile,canonical),canonical)}
}

export async function automaticContentProduction(itemsFile:string,line:string) {
  line=marketingBusinessLine(line)
  if(!['furniture','carseat','knitwear'].includes(line))throw new Error('BUSINESS_LINE_REQUIRED')
  const customers=customerSource(itemsFile,line)
  const entries=Object.entries(readMarketingBridge().workspaces).filter(([,w])=>w.business_line===line)
  if(entries.length>1)throw new Error('MARKETING_WORKSPACE_AMBIGUOUS')
  const entry=entries[0]
  if(!entry)throw new Error('MARKETING_WORKSPACE_NOT_FOUND')
  const [workspaceId,workspace]=entry
  const catalog=await localCatalog(workspaceId)
  if(catalog.business_line!==line)throw new Error('BUSINESS_LINE_MISMATCH')
  const assets:ProductionDocument[]=workspace.assets.filter(a=>a.approved).map((a,i)=>({id:`asset-${i}`,title:a.title,text:a.text,kind:'已确认销售资料',status:'approved',business_line:line,url:`/workspace/${workspaceId}/marketing/`}))
  return {...buildContentProduction(customers as ProductionCustomer[],[...catalog.documents,...assets],line),workspace_id:workspaceId,links:{media:`/workspace/${workspaceId}/media/`,compose:`/workspace/${workspaceId}/compose/`,articles:`/workspace/${workspaceId}/website-content/`}}
}
