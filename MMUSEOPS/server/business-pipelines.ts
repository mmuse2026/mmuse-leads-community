import {readFileSync,existsSync} from 'node:fs'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
export type PipelineBusiness = 'furniture' | 'carseat' | 'knitwear'

export function pipelineBusinessId(value: unknown): PipelineBusiness | null {
  const id = String(value ?? '').trim().toLowerCase()
  if (id === 'furniture') return 'furniture'
  if (id === 'carseat' || id === 'car-seat') return 'carseat'
  if (id === 'knitwear' || id === 'wool') return 'knitwear'
  return null
}

export function pipelineLeaseKey(businessId: unknown, stage: string): string {
  const id = pipelineBusinessId(businessId)
  if (!id || !/^[A-Za-z][A-Za-z0-9]*$/.test(stage)) throw new Error('PIPELINE_SCOPE_INVALID')
  return id === 'furniture' ? stage : `${id}:${stage}`
}

export function carseatPreparedBatch(batchId?:string) {
  const path=join(__dirname,'..','data','business-lines','carseat-test-mail-queue.json')
  if(!existsSync(path))return {status:'unavailable',readonly:true,records:[],total:0}
  const store=JSON.parse(readFileSync(path,'utf8'))
  if(!Array.isArray(store.records)||store.records.some((r:any)=>r.business_id!=='carseat'))throw Error('CARSEAT_QUEUE_SCOPE_INVALID')
  const records=store.records.filter((r:any)=>!batchId||r.validationBatchId===batchId)
  return {status:'prepared',readonly:true,dryRun:true,total:store.records.length,paused:store.paused,updatedAt:store.updatedAt,sendReady:false,bindingStatus:'unverified',batches:[...new Set(store.records.map((r:any)=>r.validationBatchId))],records:records.slice(0,100).map((r:any)=>({recordId:r.id,customerId:r.customerId,to:r.recipientEmail,batchId:r.validationBatchId,status:r.status,sourceUrl:r.sourceUrl,attemptCount:r.attemptCount}))}
}
export function woolPreparedBatch(batchId?:string) {
  const path=String(process.env.MMUSEOPS_TEST_WOOL_PATH)
  if(!existsSync(path))return {status:'unavailable',readonly:true,total:0,companies:0,records:[]}
  const db=new DatabaseSync(path,{readOnly:true})
  try {
    const all=db.prepare("select c.stable_id,c.company,c.development_state,c.test_mail_state,e.email,e.state,e.mx_status from customers c join development_screening d using(stable_id) join customer_emails e using(stable_id) where d.screen_result='developable_candidate' and e.state='ready_shared_channel_waiting_quota' order by c.stable_id,e.email").all() as any[]
    const seen=new Set(),first=all.filter(r=>{if(seen.has(r.stable_id))return false;seen.add(r.stable_id);return true})
    const records=first.map((r,i)=>({customerId:r.stable_id,company:r.company,to:r.email,status:r.state,recipientVerified:false,batchId:'wool-round1-'+String(Math.floor(i/10)+1).padStart(2,'0')}))
    return {status:'prepared',readonly:true,dryRun:true,total:all.length,companies:first.length,sendReady:false,adapterStatus:'wool_specialist_contract_pending',batches:[...new Set(records.map(r=>r.batchId))],records:records.filter(r=>!batchId||r.batchId===batchId).slice(0,100)}
  } finally {db.close()}
}
export function businessPipelines(batchId?:string,businessId='carseat') {
  const prepared=carseatPreparedBatch(batchId)
  const wool=woolPreparedBatch(batchId)
  return {
    schema: 'business-pipelines.v1',
    lock_scope: 'business_and_stage',
    lock_note: '家具沿用旧键；Carseat已有独立准备队列与定向执行函数，发送绑定待核',
    prepared_batch: businessId==='knitwear'||businessId==='wool'?wool:prepared,
    pipelines: [
      { business_id: 'furniture', display_name: '家具', execution_status: 'legacy_entry_only', execution_note: '现有家具入口，独立运行状态尚未核实', controls_available: false },
      { business_id: 'carseat', display_name: '汽车座椅套', execution_status: prepared.status==='prepared'?'prepared_sender_binding_pending':'not_connected', execution_note: "已准备"+prepared.total+"家客户，每公司首轮一地址；批次可读取，发送与回收绑定待核", controls_available: false, prepared_count:prepared.total, prepared_batch_endpoint:'/api/business-pipelines?business_id=carseat&batch_id=carseat-round1-01', send_ready:false },
      { business_id: 'knitwear', display_name: '羊毛衫', execution_status:wool.status==='prepared'?'prepared_specialist_adapter_pending':'not_connected', execution_note:'已准备'+wool.companies+'家客户/'+wool.total+'地址；首轮每公司一地址，专属客户邮件执行合同待核', controls_available: false, prepared_count:wool.companies,send_ready:false },
    ],
  }
}
