import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { createBusinessCustomerStore } from './business-customer-store'
import { classifyCustomer } from './business-customer-partition'
import { createHash } from 'node:crypto'
import { appendScopedRecoveryAtomic } from './items-store-atomic'
import { ITEMS_STORE_FILE } from './items-store-atomic'
import { join } from 'node:path'
import { businessSplitActive } from './business-split-mode'

type Business = 'furniture'|'carseat'|'knitwear'|'unclassified'
type Paths = {furniture:string;carseat:string;knitwear:string;unclassified:string}
export function woolRevision(row:any) {return createHash('sha256').update(JSON.stringify([row.stable_id,row.company,row.country,row.website])).digest('hex')}
export function openActiveCustomerRegistry() {
  if(!businessSplitActive())throw new Error('BUSINESS_SPLIT_INACTIVE')
  const base=join(__dirname,'..','data','business-lines')
  const manifest=JSON.parse(readFileSync(join(base,'migration.json'),'utf8'))
  if(manifest.state!=='committed')throw new Error('BUSINESS_SPLIT_INACTIVE')
  return createCustomerRegistry({furniture:ITEMS_STORE_FILE,carseat:join(base,'carseat.json'),unclassified:join(base,'holding.json'),knitwear:String(process.env.MMUSEOPS_TEST_WOOL_PATH)})
}

// Paths are supplied by trusted server configuration, never by an HTTP request.
export function createCustomerRegistry(paths: Paths) {
  if(!existsSync(paths.unclassified)||!existsSync(paths.knitwear)) throw new Error('BUSINESS_STORE_UNAVAILABLE')
  const all=Object.values(paths).map(path=>realpathSync(path))
  for(let i=0;i<all.length;i++) for(let j=i+1;j<all.length;j++) {
    const a=statSync(all[i],{bigint:true}),b=statSync(all[j],{bigint:true})
    if(all[i].toLowerCase()===all[j].toLowerCase()||(a.ino!==0n&&a.dev===b.dev&&a.ino===b.ino)) throw new Error('BUSINESS_STORE_PATH_COLLISION')
  }
  const store=createBusinessCustomerStore(paths)
  function locate(business: Business,id:string) {
    if(!id || !['furniture','carseat','knitwear','unclassified'].includes(business)) throw new Error('INVALID_CUSTOMER_SCOPE')
    if(business==='furniture'||business==='carseat') return store.read(business).find((x:any)=>String(x.id)===id) || null
    if(business==='unclassified') {
      const rows=JSON.parse(readFileSync(paths.unclassified,'utf8'))
      if(!Array.isArray(rows)) throw new Error('BUSINESS_STORE_INVALID')
      if(rows.some((row:any)=>classifyCustomer(row)!=='unclassified')) throw new Error('BUSINESS_STORE_CONTAMINATED')
      return rows.find((x:any)=>String(x.id)===id) || null
    }
    const db=new DatabaseSync(paths.knitwear,{readOnly:true})
    try {const rows=db.prepare('SELECT stable_id, company, country, website FROM customers WHERE stable_id = ?').all(id);if(rows.length>1)throw new Error('AMBIGUOUS_CUSTOMER');return rows[0] || null}
    finally {db.close()}
  }
  function research(business:Business,id:string) {
    if(business!=='knitwear')return null
    if(!locate(business,id))throw new Error('CUSTOMER_NOT_FOUND')
    const db=new DatabaseSync(paths.knitwear,{readOnly:true})
    try {
      const rows=(table:string,columns:string)=>db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)
        ?db.prepare(`SELECT ${columns} FROM ${table} WHERE stable_id = ?`).all(id):[]
      return {contacts:rows('official_contact_findings','email,source_url,observed_at,classification'),
        observations:rows('public_contact_research','contact_type,value,source_url,observed_at,evidence_note,confidence,mx_status'),
        coverage:rows('contact_research_coverage','observed_at,result'),
        evidence:rows('development_screening_evidence','source_url,observed_at,finding')}
    } finally {db.close()}
  }
  function historicalLookup(id:string) {
    const found=(['furniture','carseat','unclassified'] as const).flatMap(business=>{
      const record=locate(business,id);return record?[{business_id:business,record}]:[]
    })
    if(found.length>1) throw new Error('AMBIGUOUS_HISTORICAL_CUSTOMER')
    return found[0] || null
  }
  function update(business:Business,id:string,revision:number,fn:(item:any)=>any) {
    if(business!=='furniture'&&business!=='carseat') throw new Error('BUSINESS_WRITE_NOT_CONNECTED')
    return store.update(business,id,revision,fn)
  }
  function updateWool(id:string, revision:string, changes:Record<string,string>) {
    if(!/^[a-f0-9]{64}$/.test(revision))throw new Error('INVALID_REVISION')
    if(!existsSync(paths.knitwear))throw new Error('BUSINESS_STORE_UNAVAILABLE')
    const db=new DatabaseSync(paths.knitwear)
    try {
      db.exec('BEGIN IMMEDIATE')
      const matches=db.prepare('SELECT stable_id, company, country, website FROM customers WHERE stable_id = ?').all(id) as any[]
      if(matches.length>1)throw new Error('AMBIGUOUS_CUSTOMER')
      const row=matches[0]
      if(!row)throw new Error('ITEM_NOT_FOUND')
      if(woolRevision(row)!==revision)throw new Error('ITEM_REVISION_CONFLICT')
      if((changes.company??row.company)===row.company&&(changes.country??row.country)===row.country&&(changes.website??row.website)===row.website){db.exec('COMMIT');return row}
      db.prepare('UPDATE customers SET company=?,country=?,website=? WHERE stable_id=?').run(changes.company ?? row.company,changes.country ?? row.country,changes.website ?? row.website,id)
      const updated=db.prepare('SELECT stable_id, company, country, website FROM customers WHERE stable_id = ?').get(id)
      db.exec('COMMIT');return updated
    } catch(error) {try{db.exec('ROLLBACK')}catch{};throw error} finally {db.close()}
  }
  function planHistoricalTargets(ids:string[]) {
    const groups: Record<'furniture'|'carseat'|'unclassified',string[]> = {furniture:[],carseat:[],unclassified:[]}
    for(const id of new Set(ids)) {
      const found=historicalLookup(id)
      if(!found) throw new Error('HISTORICAL_CUSTOMER_NOT_FOUND')
      groups[found.business_id].push(id)
    }
    return groups
  }
  function appendHistoricalEvidence(business:'furniture'|'carseat'|'unclassified',id:string,evidence:Record<string,unknown>,routing?:Record<string,unknown>,refresh?:(item:any)=>any) {
    if(!['furniture','carseat','unclassified'].includes(business)) throw new Error('INVALID_BUSINESS')
    return appendScopedRecoveryAtomic(paths[business],id,items=>{
      const seen=new Set<string>()
      for(const row of items){const key=String(row?.id||'');if(!key||seen.has(key)||classifyCustomer(row)!==business)throw new Error('BUSINESS_STORE_CONTAMINATED');seen.add(key)}
    },evidence,business==='unclassified'?undefined:routing,business==='furniture'?refresh:undefined)
  }
  return {locate,research,historicalLookup,planHistoricalTargets,appendHistoricalEvidence,update,updateWool}
}
