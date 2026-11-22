export type TestMailQueueStatus='pending'|'scheduled'|'sending'|'sent'|'verified'|'delivered'|'bounced'|'replied'|'deferred'|'needs_reschedule'|'blocked'|'invalid_email_blocked'|'skipped_duplicate'|'send_failed'|'paused'|'closed'
export interface TestMailQueueRecord{id:string;validationBatchId:string;channel?:'formal_outreach'|'test';customerId:string;recipientEmail:string;normalizedEmail?:string;linkedCustomerIds?:string[];status:TestMailQueueStatus;createdAt:string;updatedAt:string;attemptCount:number;testMailScheduledAt?:string;testMailSendStartedAt?:string;testMailSendAttempts?:string[];testMailSentAt?:string;resendMessageId?:string;correlationId?:string;observationStartedAt?:string;observationEndsAt?:string;lastRecoverySyncedAt?:string;recoverySource?:string;recoveryStatus?:string;testMailStatus?:string;deferredUntil?:string;blockedReason?:string;lastError?:string;smtpAttemptCount?:number;smtpLastCheckedAt?:string;smtpLastResult?:string;smtpNextRetryAt?:string;smtpCatchAllSuspected?:boolean;smtpVerificationState?:'idle'|'checking'|'outcome_recorded'|'applied'|'ambiguous';smtpClaimId?:string;smtpClaimedAt?:string;smtpClaimExpiresAt?:string;smtpDurableOutcome?:Record<string,unknown>}
export interface TestMailQueueConfig{dailyLimit:number;minIntervalSeconds:number;maxIntervalSeconds:number;maxPendingAgeHours:number}
export interface TestMailQueueStore{version:1;updatedAt:string;paused:boolean;pauseReason?:string;config:TestMailQueueConfig;records:TestMailQueueRecord[]}
export const DEFAULT_TEST_MAIL_CONFIG:TestMailQueueConfig={dailyLimit:100,minIntervalSeconds:60,maxIntervalSeconds:180,maxPendingAgeHours:24}
const dayKey=(date:Date)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(date)
function nextDayStart(now:Date){const p=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);const get=(t:string)=>Number(p.find(x=>x.type===t)?.value||0);return new Date(Date.UTC(get('year'),get('month')-1,get('day')+1)-8*3600_000)}
export function enqueueTestMail(records:TestMailQueueRecord[],record:TestMailQueueRecord){const normalizedEmail=record.recipientEmail.trim().toLowerCase();const duplicateIndex=records.findIndex(x=>x.recipientEmail.trim().toLowerCase()===normalizedEmail);if(duplicateIndex>=0){const existing=records[duplicateIndex],linkedCustomerIds=Array.from(new Set([...(existing.linkedCustomerIds||[]),existing.customerId,record.customerId]));const next=[...records];next[duplicateIndex]={...existing,normalizedEmail,linkedCustomerIds,updatedAt:record.updatedAt||existing.updatedAt};return{records:next,added:false}}return{records:[...records,{...record,normalizedEmail,linkedCustomerIds:Array.from(new Set([...(record.linkedCustomerIds||[]),record.customerId]))}],added:true}}
export function planTestMailQueue(records:TestMailQueueRecord[],config=DEFAULT_TEST_MAIL_CONFIG,now=new Date(),random=Math.random,sentToday=0){
 const hardDailyLimit=Math.min(100,Math.max(0,Number(config.dailyLimit)||0))
 let available=Math.max(0,hardDailyLimit-sentToday),previous=now.getTime()
 const claimed=new Set(records.filter(record=>['sent','sending'].includes(record.status)).map(record=>record.recipientEmail.trim().toLowerCase()).filter(Boolean))
 return records.map(record=>{
  if(['sent','sending','verified','delivered','bounced','replied','blocked','invalid_email_blocked','skipped_duplicate','paused','closed'].includes(record.status))return record
  const normalizedEmail=record.recipientEmail.trim().toLowerCase()
  if(!normalizedEmail||claimed.has(normalizedEmail))return{...record,normalizedEmail,status:'skipped_duplicate' as const,blockedReason:'duplicate_normalized_email_planning_lock',updatedAt:now.toISOString()}
  claimed.add(normalizedEmail)
  if(record.status==='scheduled'&&record.testMailScheduledAt)return{...record,normalizedEmail}
  if(['pending','deferred'].includes(record.status)&&now.getTime()-Date.parse(record.createdAt)>config.maxPendingAgeHours*3600_000)return{...record,normalizedEmail,status:'needs_reschedule' as const,createdAt:now.toISOString(),updatedAt:now.toISOString()}
  if(available<=0)return{...record,normalizedEmail,status:'deferred' as const,deferredUntil:nextDayStart(now).toISOString(),updatedAt:now.toISOString()}
  const span=Math.max(0,config.maxIntervalSeconds-config.minIntervalSeconds),gap=config.minIntervalSeconds+Math.floor(random()*(span+1));previous+=gap*1000;available--
  return{...record,normalizedEmail,status:'scheduled' as const,testMailScheduledAt:new Date(previous).toISOString(),updatedAt:now.toISOString()}
 })
}

// Explicit recovery only: ordinary planning preserves existing schedules on restart.
export function replanUnattemptedTestsByInterval(records:TestMailQueueRecord[],config=DEFAULT_TEST_MAIL_CONFIG,now=new Date(),random=Math.random,sentToday=0){
 const candidates=records.filter(r=>r.channel!=='formal_outreach'&&r.status==='scheduled'&&!r.attemptCount&&!r.resendMessageId&&!r.testMailSentAt&&!r.testMailSendStartedAt&&!r.testMailSendAttempts?.length)
 const planned=planTestMailQueue(candidates.map(r=>({...r,status:'needs_reschedule' as const,testMailScheduledAt:undefined})),config,now,random,sentToday)
 const byId=new Map(planned.map(r=>[r.id,r]));return records.map(r=>byId.get(r.id)||r)
}

const ACTIVE_TEST_MAIL_STATUSES = new Set<TestMailQueueStatus>(['pending','scheduled','sending','deferred','needs_reschedule'])

export function effectiveTestMailStatus(record: TestMailQueueRecord): TestMailQueueStatus {
 const recovery = String(record.recoveryStatus || '')
 if (recovery === 'no_bounce_observed') return 'delivered'
 if (recovery === 'bounced') return 'bounced'
 if (recovery === 'replied') return 'replied'
 return record.status
}

export function isActiveTestMailRecord(record: TestMailQueueRecord): boolean {
 return ACTIVE_TEST_MAIL_STATUSES.has(effectiveTestMailStatus(record))
}

export function isWatchingTestMailRecord(record: TestMailQueueRecord): boolean {
 return effectiveTestMailStatus(record) === 'sent' && String(record.recoveryStatus || '') === 'watching'
}

export function testMailQueueDashboard(store:TestMailQueueStore,now=new Date()){
 const today=dayKey(now)
 const sentToday=store.records.filter(x=>Boolean(x.testMailSentAt)&&dayKey(new Date(x.testMailSentAt!))===today).length
 const sentAttemptsToday=store.records.reduce((total,x)=>{
  const attempts=Array.isArray(x.testMailSendAttempts)?x.testMailSendAttempts:[]
  if(attempts.length)return total+attempts.filter(at=>dayKey(new Date(at))===today).length
  const at=x.testMailSendStartedAt||x.testMailSentAt
  return total+(Boolean(at)&&dayKey(new Date(at!))===today?1:0)
 },0)
 const hardDailyLimit=Math.min(100,Math.max(0,Number(store.config.dailyLimit)||0))
 const count=(s:TestMailQueueStatus)=>store.records.filter(x=>effectiveTestMailStatus(x)===s).length
 const next=store.records.filter(x=>effectiveTestMailStatus(x)==='scheduled'&&x.testMailScheduledAt).sort((a,b)=>String(a.testMailScheduledAt).localeCompare(String(b.testMailScheduledAt)))[0]
 const uniqueRecipientEmails=new Set(store.records.map(x=>x.recipientEmail.trim().toLowerCase()).filter(Boolean)).size
 const uniqueSentToday=new Set(store.records.filter(x=>x.testMailSentAt&&dayKey(new Date(x.testMailSentAt))===today).map(x=>x.recipientEmail.trim().toLowerCase())).size
 const activeQueueLength=store.records.filter(isActiveTestMailRecord).length
 const watching=store.records.filter(isWatchingTestMailRecord).length
 const historyTotal=Math.max(0,store.records.length-activeQueueLength-watching)
 const statuses:TestMailQueueStatus[]=['pending','scheduled','sending','sent','verified','delivered','bounced','replied','deferred','needs_reschedule','blocked','invalid_email_blocked','skipped_duplicate','send_failed','paused','closed']
 return{lastUpdatedAt:store.updatedAt,paused:store.paused,dailyLimit:hardDailyLimit,sentToday,sentAttemptsToday,uniqueSentToday,uniqueRecipientEmails,duplicateRecordCount:Math.max(0,store.records.length-uniqueRecipientEmails),remainingQuota:Math.max(0,hardDailyLimit-sentAttemptsToday),activeQueueLength,watching,historyTotal,deferred:count('deferred'),needsReschedule:count('needs_reschedule'),scheduled:count('scheduled'),pending:count('pending'),failed:count('send_failed'),blocked:count('blocked')+count('invalid_email_blocked'),skippedDuplicate:count('skipped_duplicate'),invalidEmailBlocked:count('invalid_email_blocked'),nextScheduledAt:next?.testMailScheduledAt,counts:Object.fromEntries(statuses.map(s=>[s,count(s)]))}
}
