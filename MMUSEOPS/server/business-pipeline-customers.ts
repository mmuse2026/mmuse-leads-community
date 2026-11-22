import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { readItemsDirect, ITEMS_STORE_FILE } from './items-store-atomic'
import { crmBusinessScope } from '../src/services/crmBusinessScope'
import { furnitureChannelAllows } from '../src/services/businessLinePolicy'

const WOOL_DB = String(process.env.MMUSEOPS_TEST_WOOL_PATH)
type Business = 'furniture'|'carseat'|'knitwear'|'unclassified'
type Sources = {itemsPath:string; woolPath:string}
const defaults: Sources = {itemsPath:ITEMS_STORE_FILE,woolPath:WOOL_DB}
export function businessPipelineCustomers(business: string, page: number, pageSize: number, sources: Sources = defaults, itemsReader = readItemsDirect) {
  if (!['furniture','carseat','knitwear','unclassified'].includes(business)) throw new Error('UNKNOWN_BUSINESS')
  if (!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>50||page>1000000) throw new Error('INVALID_PAGINATION')
  const base={business_id:business as Business,readonly:true,page,page_size:pageSize}
  const unavailable=()=>({...base,status:'unavailable',total:null,items:[]})
  try {
    if (business==='knitwear') {
      if (!existsSync(sources.woolPath)) return unavailable()
      const db=new DatabaseSync(sources.woolPath,{readOnly:true})
      try {
        const total=Number((db.prepare('SELECT count(*) AS n FROM customers').get() as any).n)
        const rows=db.prepare('SELECT stable_id, company, country, website FROM customers ORDER BY stable_id LIMIT ? OFFSET ?').all(pageSize,(page-1)*pageSize) as any[]
        return {...base,status:'available',total,items:rows.map(r=>({id:`knitwear:${String(r.stable_id)}`,company:String(r.company||''),country:String(r.country||''),website:String(r.website||''),source:'knitwear'}))}
      } finally {db.close()}
    }
    if(!existsSync(sources.itemsPath)) return unavailable()
    const rows=itemsReader(sources.itemsPath).filter((r:any)=>business==='unclassified'?(crmBusinessScope(r.businessLine)!=='furniture'&&crmBusinessScope(r.businessLine)!=='carseat')||(crmBusinessScope(r.businessLine)==='furniture'&&!furnitureChannelAllows(r)):crmBusinessScope(r.businessLine)===business && (business!=='furniture'||furnitureChannelAllows(r)))
    return {...base,status:'available',total:rows.length,items:rows.slice((page-1)*pageSize,page*pageSize).map((r:any)=>({id:`${business}:${String(r.id||'')}`,company:String(r.company||''),country:String(r.country||''),website:String(r.website||''),source:business}))}
  } catch {return unavailable()}
}
