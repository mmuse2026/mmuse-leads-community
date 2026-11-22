import { crmBusinessScope } from '../src/services/crmBusinessScope'
import { furnitureChannelAllows } from '../src/services/businessLinePolicy'

export type CustomerPartition = 'furniture'|'carseat'|'unclassified'
export function classifyCustomer(item: any): CustomerPartition {
  const scope=crmBusinessScope(item?.businessLine)
  if(scope==='furniture' && furnitureChannelAllows(item)) return 'furniture'
  if(scope==='carseat') return 'carseat'
  return 'unclassified'
}

export function splitCustomers(items: unknown[]) {
  const partitions: Record<CustomerPartition,any[]> = {furniture:[],carseat:[],unclassified:[]}
  const ids=new Set<string>()
  for(const item of items) {
    const id=String((item as any)?.id ?? '').trim()
    if(!id || ids.has(id)) throw new Error('MISSING_OR_DUPLICATE_CUSTOMER_ID')
    ids.add(id); partitions[classifyCustomer(item)].push(structuredClone(item))
  }
  return partitions
}

export function assertCustomerUpdateScope(business: 'furniture'|'carseat', before: any, after: any) {
  if (!['furniture','carseat'].includes(business)) throw new Error('INVALID_BUSINESS')
  if(!before || !after || !before.id || before.id!==after.id) throw new Error('CUSTOMER_ID_MISMATCH')
  if(classifyCustomer(before)!==business || classifyCustomer(after)!==business) throw new Error('CUSTOMER_BUSINESS_MISMATCH')
}
