import { normalizeEmailSignature } from '../src/services/emailSignature'
import { randomUUID } from 'node:crypto'
import { applyEligibilityStage } from '../src/services/leadStageEligibility'
import { clearFormalSendClaim, preflightQueueSend, type FormalSendQueueRecord, type SendPlannerConfig } from '../src/services/formalSendQueue'
import { findPersistedDraft, updatePersistedDraft } from '../src/services/draftLookup'
import { formalOutboundKey } from './formal-runner-safety'
import type { TestMailQueueConfig, TestMailQueueRecord } from '../src/services/testMailQueue'
import { classifyTestMailCandidateWithFallback, hasSourceVerifiedBusinessEmail, normalizeEmail } from '../src/services/testMailCandidatePolicy'
import { isIsolatedItem } from '../src/services/itemIsolation'
import { buildFormalSentContentSnapshot } from './formal-sent-content'

type SendResult={messageId?:string}
type Sender=(input:{to:string;subject:string;body:string;customerId:string;recordId?:string;correlationId?:string;outboundKey?:string})=>Promise<SendResult>
const list=(v:any):any[]=>Array.isArray(v)?v:[]
const returnToContactMining=(item:any,now:Date,reason:string,draftId?:string)=>{
 if(!item)return item
 const at=now.toISOString(),from=String(item.primaryStage||item.normalizedStage||'unknown')
 const withDraft=draftId?updatePersistedDraft(item,draftId,draft=>({...draft,status:'superseded',sent:false,supersededAt:at,supersededReason:reason})):item
 const supersede=(draft:any)=>draftId&&draft?.id===draftId?{...draft,status:'superseded',sent:false,supersededAt:at,supersededReason:reason}:draft
 return{...withDraft,...(Array.isArray(withDraft.manualEmailDrafts)?{manualEmailDrafts:withDraft.manualEmailDrafts.map(supersede)}:{}),...(Array.isArray(withDraft.outreachDrafts)?{outreachDrafts:withDraft.outreachDrafts.map(supersede)}:{}),primaryStage:'contact_mining_queue',normalizedStage:'contact_mining_queue',currentAllowedStage:'contact_mining_queue',dashboardBucket:'contact_mining_queue',displayBucket:'customer_progress',allowedNextActions:['mine_contacts'],nextRequiredAction:'mine_contacts',eligibilityBlockedReasons:[reason],contactMiningRequired:true,stepperVersion:undefined,autoProcessedAt:undefined,contactMiningCompletedAt:undefined,stageTransitions:[...list(withDraft.stageTransitions),{from,to:'contact_mining_queue',reason,at}],timeline:[...list(withDraft.timeline),{type:'stage_transition',from,to:'contact_mining_queue',reason,at}],updatedAt:at}
}
export async function executeDueFormalRecords(
 records:FormalSendQueueRecord[],items:any[],_config:SendPlannerConfig,now:Date,send:Sender,
 options:{beforeSend?:(record:FormalSendQueueRecord)=>Promise<void>|void;claimedRecordIds?:readonly string[]}={}
){
 const nextRecords=structuredClone(records),nextItems=structuredClone(items)
 let sent=0,failed=0,blocked=0,pauseQueue=false
 const fixedIds=options.claimedRecordIds?new Set(options.claimedRecordIds):undefined
 const claimedKeys=new Set(nextRecords.filter(record=>['sent','sending'].includes(record.sendQueueStatus)&&!fixedIds?.has(record.id)).map(formalOutboundKey))
 const claimedEmails=new Set(nextRecords.filter(record=>record.sendQueueStatus==='sending'&&!fixedIds?.has(record.id)).map(record=>normalizeEmail(record.recipientEmail)).filter(Boolean))
 for(const record of nextRecords){
  if(fixedIds?(!fixedIds.has(record.id)||record.sendQueueStatus!=='sending'):(record.sendQueueStatus!=='scheduled'||!record.scheduledSendAt||Date.parse(record.scheduledSendAt)>now.getTime()))continue
   if(record.channel!=='formal_outreach'){Object.assign(record,clearFormalSendClaim(record),{sendQueueStatus:'blocked',sendError:'channel_mismatch:expected_formal_outreach',updatedAt:now.toISOString()});blocked++;continue}
  const outboundKey=formalOutboundKey(record),normalizedRecipient=normalizeEmail(record.recipientEmail)
   if(!normalizedRecipient||claimedEmails.has(normalizedRecipient)){Object.assign(record,clearFormalSendClaim(record),{sendQueueStatus:'blocked',sendError:'duplicate_normalized_email_final_lock',updatedAt:now.toISOString()});blocked++;continue}
   if(claimedKeys.has(outboundKey)){Object.assign(record,clearFormalSendClaim(record),{sendQueueStatus:'blocked',sendError:'duplicate_outbound_claim',updatedAt:now.toISOString()});blocked++;continue}
  const index=nextItems.findIndex(x=>x.id===record.customerId),item=nextItems[index],found=findPersistedDraft(item,record.draftId),draft=found?.draft
  const reasons=fixedIds?[]:preflightQueueSend(item,draft,record,now,claimedEmails,claimedKeys)
   if(reasons.length){const reason=reasons.join(',');Object.assign(record,clearFormalSendClaim(record),{sendQueueStatus:'blocked',sendError:reason,updatedAt:now.toISOString()});if(item&&reason.includes('non_personal_role_email_requires_contact_mining'))nextItems[index]=returnToContactMining(item,now,'non_personal_role_email_requires_contact_mining',record.draftId);blocked++;continue}
  claimedKeys.add(outboundKey);claimedEmails.add(normalizedRecipient);if(!fixedIds){record.sendQueueStatus='sending';record.outboundKey=outboundKey;record.lastSendAttemptAt=now.toISOString();record.sendAttemptCount=(record.sendAttemptCount||0)+1;record.updatedAt=now.toISOString()}
  try{
   const providerInput={to:record.recipientEmail,subject:draft.subject,body:normalizeEmailSignature(draft.body),customerId:record.customerId,recordId:record.id,outboundKey}
   const sentAt=now.toISOString()
   const preparedSnapshot=buildFormalSentContentSnapshot(providerInput,{draftId:record.draftId,capturedAt:sentAt,status:'prepared'})
   record.sentContentSnapshot=preparedSnapshot
   if(options.beforeSend)await options.beforeSend(structuredClone(record))
   const result=await send(providerInput)
   if(!result.messageId)throw new Error('message_id_missing')
   const due3=new Date(now.getTime()+3*86400_000).toISOString(),due7=new Date(now.getTime()+7*86400_000).toISOString()
    const sentContentSnapshot=buildFormalSentContentSnapshot(providerInput,{draftId:record.draftId,capturedAt:sentAt,status:'sent',messageId:result.messageId,sentAt})
    Object.assign(record,clearFormalSendClaim(record),{sendQueueStatus:'sent',actualSentAt:sentAt,messageId:result.messageId,sentContentSnapshot,provider:'zoho_smtp',deliveryStatus:'sent_observation',followupDueAt3d:due3,followupDueAt7d:due7,updatedAt:sentAt})
   let updated=updatePersistedDraft(item,record.draftId,value=>({...value,sent:true,status:'sent',sentAt,messageId:result.messageId,provider:'zoho_smtp',formalDeliveryStatus:'sent_observation'}))
   updated={...updated,emailLogs:[...list(updated.emailLogs),{status:'sent',type:'formal_outreach',sentAt,messageId:result.messageId,to:record.recipientEmail,recipientEmail:record.recipientEmail,subject:providerInput.subject,body:providerInput.body,contentSnapshotVersion:sentContentSnapshot.version,contentSnapshotSha256:sentContentSnapshot.bodySha256,outboundMessageKey:outboundKey,provider:'zoho_smtp',deliveryStatus:'sent_observation'}],developmentStatus:'sent',formalDeliveryStatus:'sent_observation',followupDueAt3d:due3,followupDueAt7d:due7,replyCheckMode:'manual_zoho_login'}
   nextItems[index]=applyEligibilityStage(updated,now).item;sent++
    }catch(error:any){if(String(error?.message||'').startsWith('FORMAL_REAPPROVAL_REQUIRED:')){const reason=String(error.message).split(':').slice(1).join(':');Object.assign(record,clearFormalSendClaim(record),{sentContentSnapshot:undefined,sendQueueStatus:'blocked',sendError:`needs_reapproval:${reason}`,updatedAt:now.toISOString()});blocked++;if(item){const routed=reason.includes('non_personal_role_email_requires_contact_mining')?returnToContactMining(item,now,reason,record.draftId):item;nextItems[index]={...routed,emailLogs:[...list(routed.emailLogs),{status:'blocked',type:'formal_outreach',sentAt:now.toISOString(),to:record.recipientEmail,outboundMessageKey:outboundKey,provider:'zoho_smtp',errorKind:'needs_reapproval',error:record.sendError}]}}}else{const detail=String(error?.message||error||'').slice(0,600);Object.assign(record,clearFormalSendClaim(record),{sentContentSnapshot:record.sentContentSnapshot?{...record.sentContentSnapshot,status:'delivery_unknown'}:undefined,sendQueueStatus:'needs_manual_reconciliation',sendError:'SMTP_RESULT_AMBIGUOUS',smtpErrorDetail:detail,smtpErrorAt:now.toISOString(),updatedAt:now.toISOString()});failed++;if(item)nextItems[index]={...item,emailLogs:[...list(item.emailLogs),{status:'failed',type:'formal_outreach',sentAt:now.toISOString(),to:record.recipientEmail,outboundMessageKey:outboundKey,provider:'zoho_smtp',error:detail,errorKind:'SMTP_RESULT_AMBIGUOUS'}]}}}
 }
 return{records:nextRecords,items:nextItems,stats:{sent,failed,blocked},pauseQueue}
}
