import { createCustomerRegistry, woolRevision } from './business-customer-registry'

type Business='furniture'|'carseat'|'knitwear'
type Registry=ReturnType<typeof createCustomerRegistry>
function scope(value:unknown):Business {
  if(value==='furniture'||value==='carseat'||value==='knitwear')return value
  throw new Error('INVALID_BUSINESS')
}
function customerId(value:unknown):string {
  if(typeof value!=='string'||!value||value.length>200||/[\x00-\x1f]/.test(value))throw new Error('INVALID_CUSTOMER')
  return value
}
function clean(business:Business,id:string,row:any) {
  return {business_id:business,customer_id:id,company:String(row.company||''),country:String(row.country||''),website:String(row.website||''),revision:business==='knitwear'?woolRevision(row):Number.isSafeInteger(row.serverRevision)?row.serverRevision:0,editable:true}
}
export function customerDetail(registry:Registry,b:unknown,idValue:unknown) {
  const business=scope(b),id=customerId(idValue),row=registry.locate(business,id)
  if(!row)throw new Error('CUSTOMER_NOT_FOUND')
  return {...clean(business,id,row),...(business==='knitwear'?{research:registry.research(business,id)}:{})}
}
export function updateCustomerDetail(registry:Registry,input:any) {
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['business_id','customer_id','revision','changes'].includes(k)))throw new Error('INVALID_CUSTOMER')
  const business=scope(input.business_id),id=customerId(input.customer_id),changes=input.changes
  const validRevision=business==='knitwear'?typeof input.revision==='string'&&/^[a-f0-9]{64}$/.test(input.revision):Number.isSafeInteger(input.revision)&&input.revision>=0
  if(!validRevision||!changes||typeof changes!=='object'||Array.isArray(changes)||!Object.keys(changes).length||Object.keys(changes).some(k=>!['company','country','website'].includes(k)))throw new Error('INVALID_CUSTOMER')
  for(const v of Object.values(changes))if(typeof v!=='string'||v.length>500||/[\x00-\x1f\x7f]/.test(v))throw new Error('INVALID_CUSTOMER')
  if(changes.company!==undefined&&!changes.company.trim())throw new Error('INVALID_CUSTOMER')
  if(changes.website) {try{const u=new URL(changes.website);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw 0}catch{throw new Error('INVALID_CUSTOMER')}}
  if(business==='knitwear')return {...clean(business,id,registry.updateWool(id,input.revision,changes)),research:registry.research(business,id)}
  const result=registry.update(business,id,input.revision,(row:any)=>({...row,...changes}))
  return clean(business,id,result.item)
}
