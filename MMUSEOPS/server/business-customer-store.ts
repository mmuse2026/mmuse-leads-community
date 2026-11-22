import { existsSync, realpathSync, statSync } from 'node:fs'
import { readItemsDirect, updateScopedItemAtomic } from './items-store-atomic'
import { assertCustomerUpdateScope, classifyCustomer } from './business-customer-partition'

type Business = 'furniture'|'carseat'
type Paths = Record<Business,string>

// This adapter is deliberately not connected to the running legacy pipeline.
export function createBusinessCustomerStore(paths: Paths) {
  if(!paths.furniture || !paths.carseat || !existsSync(paths.furniture) || !existsSync(paths.carseat)) throw new Error('BUSINESS_STORE_UNAVAILABLE')
  const fixed={furniture:realpathSync(paths.furniture),carseat:realpathSync(paths.carseat)}
  const fstat=statSync(fixed.furniture,{bigint:true}), cstat=statSync(fixed.carseat,{bigint:true})
  if(fixed.furniture.toLowerCase()===fixed.carseat.toLowerCase() || (fstat.ino!==0n && fstat.dev===cstat.dev && fstat.ino===cstat.ino)) throw new Error('BUSINESS_STORE_PATH_COLLISION')
  function pathFor(business: Business) {
    if(!['furniture','carseat'].includes(business)) throw new Error('INVALID_BUSINESS')
    return fixed[business]
  }
  function read(business: Business) {
    const records=readItemsDirect(pathFor(business))
    validateRecords(business,records)
    return records
  }
  function validateRecords(business: Business,records:any[]) {
    const ids=new Set<string>()
    for(const record of records) {
      if(classifyCustomer(record)!==business) throw new Error('BUSINESS_STORE_CONTAMINATED')
      const id=String(record?.id ?? '')
      if(!id.trim()||ids.has(id)) throw new Error('BUSINESS_STORE_INVALID_IDS')
      ids.add(id)
    }
  }
  function readAggregate() {
    return [...read('furniture'),...read('carseat')]
  }
  function update(business: Business,id: string,expectedRevision:number,mutator:(item:any)=>any) {
    return updateScopedItemAtomic(pathFor(business),id,expectedRevision,records=>validateRecords(business,records),before=>{
      const after=mutator(structuredClone(before))
      assertCustomerUpdateScope(business,before,after)
      return after
    })
  }
  return {read,readAggregate,update}
}
