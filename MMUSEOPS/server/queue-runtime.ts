import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { businessSplitActive } from './business-split-mode'
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync, fsyncSync, mkdirSync } from 'node:fs'
import { enqueueTestMail, planTestMailQueue, testMailQueueDashboard } from '../src/services/testMailQueue'
import { classifyTestMailCandidateWithFallback, hasSourceVerifiedBusinessEmail, normalizeEmail, normalizeDomain } from '../src/services/testMailCandidatePolicy'
import { contactMiningRoleClass, isPlaceholderEmail, roleEmailClass } from '../src/services/emailClassification'
import { applyEligibilityStage, hasDetailedBackcheckEvidence } from '../src/services/leadStageEligibility'
import { FORMAL_SEND_QUEUE_FILE, formalDailyUsage, mutateFormalSendQueue, queueDashboard, readFormalSendQueue } from './formal-send-queue-store'
import { acquireFormalQueueLock, releaseFormalQueueLock } from './formal-queue-lock'
import { recoverStaleFormalSending } from './formal-runner-safety'
import { findPersistedDraft, updatePersistedDraft } from '../src/services/draftLookup'
import { clearFormalSendClaim, preflightQueueSend, validateFormalRecipientConsistency } from '../src/services/formalSendQueue'
import { ITEMS_STORE_FILE, readItemsAtomic, updateItemsAtomic } from './items-store-atomic'
import { executeDueFormalRecords } from './queue-executors'
import { readIsolationStore } from './isolation-store'
import { executeAuthorizedFormalProviderSend, pauseFormalSendQueue, recoverExpiredFormalProviderAuthorizations } from './formal-send-linearizer'
import { hasFormalOutreachReply } from '../src/services/formalOutreachLifecycle'
const list=(v:any):any[]=>Array.isArray(v)?v:[]
const readItems=(path=ITEMS_STORE_FILE)=>JSON.parse(readFileSync(path,'utf8'))
const terminalRank=(value:any)=>{const text=String(value||'').toLowerCase();if(/repl|complain|suppress|do_not_contact/.test(text))return 5;if(/bounce|failed|invalid|unreachable/.test(text))return 4;if(/deliver|observed|watching/.test(text))return 3;if(/sent|submitted|queued/.test(text))return 2;if(/pending|unknown/.test(text))return 1;return 0}
const eventKey=(entry:any)=>String(entry.webhookEventId||entry.eventId||entry.svixId||'')
const messageKey=(entry:any)=>String(entry.messageId||entry.testMessageId||entry.resendMessageId||entry.outboundMessageKey||entry.correlationId||'')
const contentKey=(entry:any)=>`${String(entry.email||'')}|${String(entry.result||'')}|${String(entry.checkedAt||'')}`
function mergeTerminalFields(existing:any,incoming:any){
 const merged={...existing,...incoming}
 for(const field of ['status','deliverStatus','result','recoveryStatus','providerLastEvent']){
  if(terminalRank(existing?.[field])>terminalRank(incoming?.[field]))merged[field]=existing[field]
 }
 for(const [key,value] of Object.entries(existing||{}))if(merged[key]===undefined||merged[key]===null||merged[key]==='')merged[key]=value
 return merged
}
function mergeEventHistory(a:any[],b:any[]){
 const out=[...a.map(entry=>({...entry}))]
 for(const incoming of b){
  const incomingEvent=eventKey(incoming),incomingMessage=messageKey(incoming)
  let index=incomingEvent?out.findIndex(entry=>eventKey(entry)===incomingEvent):-1
  if(index<0&&!incomingEvent&&incomingMessage)index=out.findIndex(entry=>messageKey(entry)===incomingMessage)
  if(index<0&&incomingEvent&&incomingMessage)index=out.findIndex(entry=>!eventKey(entry)&&messageKey(entry)===incomingMessage)
  if(index<0&&!incomingEvent&&!incomingMessage)index=out.findIndex(entry=>!eventKey(entry)&&!messageKey(entry)&&contentKey(entry)===contentKey(incoming))
  if(index<0)out.push({...incoming});else out[index]=mergeTerminalFields(out[index],incoming)
 }
 return out
}
export const mergeLogs=(a:any[],b:any[])=>mergeEventHistory(a,b)
export const mergeEvidence=(a:any[],b:any[])=>mergeEventHistory(a,b)
function mergeExecuted(latest:any,changed:any,draftId?:string){
 let merged={...latest,developmentStatus:changed.developmentStatus??latest.developmentStatus,followupDueAt3d:changed.followupDueAt3d??latest.followupDueAt3d,followupDueAt7d:changed.followupDueAt7d??latest.followupDueAt7d,replyCheckMode:changed.replyCheckMode??latest.replyCheckMode,specificEmailVerified:latest.specificEmailVerified===true?true:(changed.specificEmailVerified??latest.specificEmailVerified),emailLogs:mergeLogs(list(latest.emailLogs),list(changed.emailLogs)),emailVerificationEvidence:mergeEvidence(list(latest.emailVerificationEvidence),list(changed.emailVerificationEvidence))}
 if(draftId){const changedDraft=findPersistedDraft(changed,draftId)?.draft;if(changedDraft)merged=updatePersistedDraft(merged,draftId,()=>changedDraft)}
 return merged
}

export async function runDueFormalOnce(options:{now?:Date;send:(input:any)=>Promise<{messageId?:string}>;providerTimeoutMs?:number;authorizationTtlMs?:number;queuePath?:string;itemsPath?:string;runnerLockPath?:string;claimedRecordIds:readonly string[];claimId:string;runWhilePausedCampaignIds?:readonly string[]}){
 if(!Array.isArray(options.claimedRecordIds)||options.claimedRecordIds.length===0||!options.claimId)throw new Error('FORMAL_CLAIM_REQUIRED')
 const now=options.now||new Date(),queuePath=options.queuePath||FORMAL_SEND_QUEUE_FILE,itemsPath=options.itemsPath||ITEMS_STORE_FILE,runnerLockPath=options.runnerLockPath||`${queuePath}.runner.lock`
 const claimedRecordIds=new Set(options.claimedRecordIds)
 const mayRunClaimWhilePaused=(store:any)=>!store.pausePending&&Boolean(options.runWhilePausedCampaignIds?.length)&&[...claimedRecordIds].every(id=>{const record=store.records.find((entry:any)=>entry.id===id);return record?.sendQueueStatus==='sending'&&record?.sendClaimId===options.claimId&&options.runWhilePausedCampaignIds!.includes(String(record.campaignId||''))})
 const runnerLock=acquireFormalQueueLock(runnerLockPath)
 if(!runnerLock){const store=readFormalSendQueue(queuePath),items=readItems(itemsPath);return{store,dashboard:queueDashboard(store,now,items),stats:{sent:0,failed:0,blocked:0,duplicateRunner:true}}}
 try{
  const initial=await mutateFormalSendQueue(store=>{
   const config={...store.config}
   if((store.paused&&!mayRunClaimWhilePaused(store))||store.pausePending)return{...store,config,records:store.records.map(record=>{
    if(!claimedRecordIds.has(record.id)||record.sendQueueStatus!=='sending'||record.sendClaimId!==options.claimId)return record
    const restoredStatus=record.sendClaimPreviousStatus||(record.scheduledSendAt?'scheduled':'approved_for_sending')
    const restoredAttemptCount=typeof record.sendClaimPreviousAttemptCount==='number'?record.sendClaimPreviousAttemptCount:Math.max(0,(record.sendAttemptCount||0)-1)
    return{
     ...clearFormalSendClaim(record),
     sendQueueStatus:restoredStatus,
     sendAttemptCount:restoredAttemptCount,
     lastSendAttemptAt:record.sendClaimPreviousLastSendAttemptAt,
     outboundKey:record.sendClaimPreviousOutboundKey,
     providerAuthorizationId:undefined,
     providerAuthorizedAt:undefined,
     providerAuthorizationExpiresAt:undefined,
     updatedAt:now.toISOString(),
    }
   })}
   const recovered=recoverExpiredFormalProviderAuthorizations(store,now)
   return{...recovered,config:{...recovered.config},records:recoverStaleFormalSending(recovered.records,now)}
  },{path:queuePath})
  if((initial.paused&&!mayRunClaimWhilePaused(initial))||initial.pausePending){const items=readItems(itemsPath);return{store:initial,dashboard:queueDashboard(initial,now,items),stats:{sent:0,failed:0,blocked:0,paused:Boolean(initial.paused),pausePending:Boolean(initial.pausePending)}}}
  const items=readItems(itemsPath),originalById=new Map(initial.records.map(record=>[record.id,JSON.stringify(record)]))
  const due3=new Date(now.getTime()+3*86400_000).toISOString(),due7=new Date(now.getTime()+7*86400_000).toISOString()
   const customerHasReplied=(item:any)=>hasFormalOutreachReply(item)
    || String(item?.primaryStage||item?.normalizedStage||'')==='replied_queue'
    || String(item?.replyQueue||'')==='replied_queue'
    || String(item?.formalDeliveryStatus||'')==='replied'
    || String(item?.developmentStatus||'')==='replied'
    || Boolean(item?.replyObservedAt)
   const out=await executeDueFormalRecords(initial.records,items,initial.config,now,async input=>{
    const latestItem=readItemsAtomic(itemsPath).find((item:any)=>item.id===input.customerId)
    if(customerHasReplied(latestItem))throw new Error('FORMAL_REAPPROVAL_REQUIRED:customer_replied')
    const outcome=await executeAuthorizedFormalProviderSend({queuePath,recordId:String(input.recordId||''),claimId:options.claimId,now,providerTimeoutMs:options.providerTimeoutMs,authorizationTtlMs:options.authorizationTtlMs,runWhilePausedCampaignIds:options.runWhilePausedCampaignIds,input,send:options.send,sentPatch:{followupDueAt3d:due3,followupDueAt7d:due7}})
   if(outcome.status==='not_authorized')throw new Error('FORMAL_REAPPROVAL_REQUIRED:queue_paused_before_provider')
   if(outcome.status==='ambiguous')throw new Error(outcome.error)
   return{messageId:outcome.messageId}
  },{claimedRecordIds:options.claimedRecordIds,beforeSend:async claim=>{
   let reasons:string[]=[]
   await mutateFormalSendQueue(latest=>{
    const authoritativeRecord=latest.records.find(record=>record.id===claim.id)
    const authoritativeItems=readItemsAtomic(itemsPath),authoritativeItem=authoritativeItems.find((item:any)=>item.id===claim.customerId)
    const authoritativeDraft=findPersistedDraft(authoritativeItem,claim.draftId)?.draft
     const maxDaily = Math.min(100, Math.max(0, Number(latest.config.dailyMaxSendCount) || 0), Math.max(0, Number(latest.config.autoSendDailyLimit) || 0))
     const otherReservations = latest.records.filter(record => record.sendQueueStatus === 'sending' && record.id !== claim.id).length
     reasons=authoritativeRecord?.sendQueueStatus==='sending'&&(!options.claimId||authoritativeRecord.sendClaimId===options.claimId)
      ?(formalDailyUsage(latest.records, now) + otherReservations >= maxDaily ? ['formal_daily_limit'] : customerHasReplied(authoritativeItem)?['customer_replied']:[...validateFormalRecipientConsistency(authoritativeItem,authoritativeDraft,authoritativeRecord.recipientEmail),...preflightQueueSend(authoritativeItem,authoritativeDraft,authoritativeRecord,now)])
     :['claim_snapshot_changed']
    if(reasons.length)latest.records=latest.records.map(record=>record.id===claim.id&&record.sendQueueStatus==='sending'
     ?{...clearFormalSendClaim(record),sendQueueStatus:'blocked',sendError:`needs_reapproval:${reasons.join(',')}`,updatedAt:now.toISOString()}
     :record)
    return latest
   },{path:queuePath})
   if(reasons.length)throw new Error(`FORMAL_REAPPROVAL_REQUIRED:${reasons.join(',')}`)
  }})
  const changedRecords=out.records.filter(record=>originalById.get(record.id)!==JSON.stringify(record))
  const changedById=new Map(changedRecords.map(record=>[record.id,record]))
  let store=await mutateFormalSendQueue(latest=>({...latest,records:latest.records.map(record=>{
   const changed=changedById.get(record.id)
   if(!changed)return record
   const providerSettled=!record.providerAuthorizationId&&['sent','needs_manual_reconciliation'].includes(record.sendQueueStatus)&&Boolean(record.messageId||record.providerAttemptedAt)
   return providerSettled?record:changed
  })}),{path:queuePath})
  if(out.pauseQueue)store=await pauseFormalSendQueue('configuration_or_account_error',{queuePath,now})
  const changedItems=new Map(out.items.map((item:any)=>[item.id,item])),sentDraftByCustomer=new Map(changedRecords.filter(record=>record.sendQueueStatus==='sent').map(record=>[record.customerId,record.draftId]))
  updateItemsAtomic(latest=>latest.map(item=>{const draftId=sentDraftByCustomer.get(item.id);return draftId&&changedItems.has(item.id)?mergeExecuted(item,changedItems.get(item.id),draftId):item}),itemsPath,now,{refreshOnlyMutated:true})
  return{store,dashboard:queueDashboard(store,now,out.items),stats:out.stats}
 }finally{releaseFormalQueueLock(runnerLock)}
}
