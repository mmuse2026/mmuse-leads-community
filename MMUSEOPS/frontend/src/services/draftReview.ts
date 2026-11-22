import { allPersistedDrafts, findPersistedDraft, updatePersistedDraft } from './draftLookup'
import { assessOutboundRisk, hasTrustedSpecificEmailEvidence } from './outreachRisk'
import { buildEmailCandidateRows } from './emailCandidateView'
import { canSendFormalOutreach } from './formalSendGate'
import { isEmailBounced } from './emailBounce'
export type DraftReviewTab='pending_human_review'|'approved'|'sent'|'bounced'
export type DraftReturnTarget='backcheck_queue'|'contact_mining_queue'|'email_validation_queue'|'replace_contact_queue'|'paused_review'|'true_excluded'
export const DRAFT_RETURN_TARGETS:DraftReturnTarget[]=['backcheck_queue','contact_mining_queue','email_validation_queue','replace_contact_queue','paused_review','true_excluded']
export const DRAFT_REJECTION_REASONS=['needs_recheck','contact_missing','specific_email_evidence_missing','replace_unreachable_contact','commercial_timing_hold','evidence_gap'] as const
export const DRAFT_RETURN_REASONS_BY_TARGET:Record<DraftReturnTarget,readonly string[]>={
 backcheck_queue:['needs_recheck','evidence_gap'],
 contact_mining_queue:['contact_missing'],
 email_validation_queue:['specific_email_evidence_missing'],
 replace_contact_queue:['replace_unreachable_contact'],
 paused_review:['commercial_timing_hold'],
 true_excluded:['address_isolated'],
}
const list=(value:unknown):any[]=>Array.isArray(value)?value:[]
const text=(value:unknown)=>String(value??'').trim()
const email=(value:unknown)=>text(value).toLowerCase()
const draftId=(draft:any)=>text(draft?.id||draft?.campaignKey)
const contactSignature=(item:any)=>list(item?.contacts).map(c=>[text(c?.name),email(c?.email)].join('|')).sort().join(';;')
const selectedEmail=(item:any)=>email(item?.selectedEmail)
export function resolveDraftReviewTab(value:string|null|undefined):{tab:DraftReviewTab;invalid:boolean}{const allowed:DraftReviewTab[]=['pending_human_review','approved','sent','bounced'];return allowed.includes(value as DraftReviewTab)?{tab:value as DraftReviewTab,invalid:false}:{tab:'pending_human_review',invalid:Boolean(value)}}
function bouncedItem(item:any){return assessOutboundRisk(item,selectedEmail(item)).blockedEmail}
export function filterDraftReviewRows(items:any[],tab:DraftReviewTab){return items.flatMap(item=>{const drafts=allPersistedDrafts(item);if(tab==='bounced'){if(!drafts.length)return[];const draft=drafts.sort((a,b)=>Date.parse(b.updatedAt||b.createdAt||'')-Date.parse(a.updatedAt||a.createdAt||''))[0];return (isEmailBounced(item)||bouncedItem(item))?[{item,draft}]:[]}if(isEmailBounced(item))return[];return drafts.filter(draft=>draft.status===tab).map(draft=>({item,draft}))})}
export function reviewRowsForRequestedTab(items:any[],requested:string|null|undefined){const resolved=resolveDraftReviewTab(requested);return{...resolved,rows:resolved.invalid?[]:filterDraftReviewRows(items,resolved.tab)}}
export function safeHttpUrl(value:unknown){const raw=text(value);if(!raw)return'';try{const url=new URL(/^https?:\/\//i.test(raw)?raw:`https://${raw}`);return ['http:','https:'].includes(url.protocol)?url.toString():''}catch{return''}}
export function assessDraftReview(item:any,draft:any){
 // Match the send gate: review the actual draft recipient, not a stale CRM selection.
 const draftRecipient=email(draft?.to),chosen=draftRecipient||selectedEmail(item),candidate=buildEmailCandidateRows(item).find(row=>row.normalizedEmail===chosen),allEvidence=list(item?.emailVerificationEvidence),relevant=allEvidence.filter(e=>{const address=email(e?.email||e?.recipientEmail);return Boolean(chosen&&address&&address===chosen)}).sort((a,b)=>Date.parse(b.checkedAt||b.sentAt||'')-Date.parse(a.checkedAt||a.sentAt||'')),latest=relevant[0]
 const specificVerified=hasTrustedSpecificEmailEvidence(item,chosen)
 const manualConfirmed=draft?.manualRiskConfirmed===true
 const gapTasks=list(item?.evidenceGapTasks).flatMap(task=>[...list(task?.missingEvidence),...list(task?.whyMissing),...(typeof task?.missingEvidence==='string'?[task.missingEvidence]:[]),...(typeof task?.whyMissing==='string'?[task.whyMissing]:[])])
 const gaps=[...list(item?.evidenceGaps),...list(item?.evidenceGap),...list(item?.missingEvidence),...gapTasks,...list(item?.eligibilityBlockedReasons).filter((v:any)=>/insufficient|missing|gap/i.test(text(v)))].map(text).filter(Boolean)
 const risk=assessOutboundRisk(item,chosen),priorFormal=risk.priorFormalSend,replacementComplete=isDraftReviewReplacementComplete(item),replaceRequired=['replace_contact_queue','bounced_queue'].includes(text(item?.primaryStage||item?.normalizedStage||item?.currentAllowedStage||item?.replyQueue))||(item?.currentEmailUseBlocked===true&&!replacementComplete)
 const gateResult=canSendFormalOutreach({item,draft,now:new Date()})
 const blocked:string[]=[...gateResult.blockers]
 const exactContact=list(item?.contacts).find(c=>email(c?.email)===chosen)
 const contact=exactContact||{name:candidate?.contactName,title:candidate?.title,source:candidate?.source,sourceUrl:candidate?.evidenceUrl,email:chosen}
 const warnings:string[]=[...gateResult.warnings]
 if(item?.duplicateIndex===true)warnings.push('duplicate_customer_record')
 if(latest&&latest.scope!=='specific_email')warnings.push('latest_evidence_not_specific_email')
 if(/delivered|domain_mx_pass/i.test(text(latest?.result||latest?.status)))warnings.push('delivery_or_domain_evidence_is_not_verification')
 return{
  approvalAllowed:blocked.length===0,
  gate:blocked.length?'red':warnings.length?'yellow':'green',
  blockedReasons:[...new Set(blocked)],warnings:[...new Set(warnings)],evidenceGaps:gaps,
  selectedEmail:selectedEmail(item),draftRecipient,specificEmailVerified:specificVerified,manualRiskConfirmed:manualConfirmed,bTierDeliveryObserved:false,
  recipientSource:contact?.source||candidate?.source,
  recipientSourceUrl:safeHttpUrl(contact?.sourceUrl||contact?.evidenceUrl||candidate?.evidenceUrl),
  recipientVerificationState:candidate?.verificationState||'unverified',
  websiteUrl:safeHttpUrl(item?.website),sourceUrl:safeHttpUrl(item?.sourceUrl||item?.evidenceUrl),
  company:item?.company||item?.title,industry:item?.industry||item?.businessLine||item?.category,
  customerType:item?.customerType||item?.clientType,country:item?.country||item?.region,
  sourceType:item?.sourceType||item?.source,businessMatch:item?.businessMatch,
  commercialValue:item?.importCommercialValue,score:item?.leadScore||item?.commercialScore,
  backcheckStatus:item?.backcheckStatus||item?.backCheck?.status,
  backcheckDepth:item?.backcheckDepth||item?.backCheck?.depth,
  backcheckConfidence:item?.backcheckConfidence||item?.evidenceStrength,
  backcheckConclusion:item?.backcheckConclusion||item?.backCheck?.summary||item?.reviewReason,
  evidenceSummary:item?.evidenceSummary||item?.stageEvidenceSummary||item?.backCheck?.summary,
  contact:{name:contact?.name,title:contact?.title,source:contact?.source||candidate?.source,sourceUrl:contact?.sourceUrl||contact?.evidenceUrl||candidate?.evidenceUrl},
  emailVerification:latest?.result||latest?.status||candidate?.verificationState,
  verificationMethod:latest?.method,
  latestEvidence:latest?{result:latest.result||latest.status,scope:latest.scope,source:latest.source,method:latest.method,checkedAt:latest.checkedAt||latest.sentAt,recoveryStatus:latest.recoveryStatus,note:text(latest.note).slice(0,240)}:undefined,
  testStatus:latest?.result||latest?.status,
  observationStatus:latest?.recoveryStatus,
  currentPool:item?.primaryStage||item?.normalizedStage,nextAction:item?.nextRequiredAction,
  priorFormalSend:priorFormal,bounced:risk.blockedEmail,doNotContact:risk.doNotContact,replaceRequired,
 }
}
export function rejectDraftForRework(item:any,input:{draftId:string;returnTarget:DraftReturnTarget;reasonCode:string;rejectedBy:string},now=new Date()){
 if(!DRAFT_RETURN_TARGETS.includes(input.returnTarget))throw new Error('DRAFT_RETURN_TARGET_INVALID');if(!/^[A-Za-z0-9][A-Za-z0-9._:@-]{1,127}$/.test(text(input.reasonCode)))throw new Error('DRAFT_REJECTION_REASON_REQUIRED');if(!DRAFT_RETURN_REASONS_BY_TARGET[input.returnTarget].includes(input.reasonCode))throw new Error('DRAFT_RETURN_REASON_INVALID')
 const found=findPersistedDraft(item,input.draftId);if(!found)throw new Error('DRAFT_NOT_FOUND');const prior=found.draft
 if(prior.status==='superseded'&&prior.returnTarget===input.returnTarget&&prior.rejectionReason===input.reasonCode)return item
 if(prior.status!=='pending_human_review'||prior.sent===true)throw new Error('DRAFT_NOT_REJECTABLE')
 const at=now.toISOString(),marker={draftId:input.draftId,returnTarget:input.returnTarget,reasonCode:input.reasonCode,returnedAt:at,returnedBy:input.rejectedBy,baselineContactSignature:contactSignature(item),baselineEvidenceCount:list(item?.emailVerificationEvidence).length,selectedEmail:selectedEmail(item)}
 let next=updatePersistedDraft(item,input.draftId,draft=>({...draft,status:'superseded',rejectedAt:at,rejectedBy:input.rejectedBy,rejectionReason:input.reasonCode,returnTarget:input.returnTarget,updatedAt:at}))
 next={...next,draftReviewReturn:marker,draftReviewAudit:[...list(next.draftReviewAudit),{event:'draft_rejected_for_rework',draftId:input.draftId,returnTarget:input.returnTarget,reasonCode:input.reasonCode,actor:input.rejectedBy,at}],timeline:[...list(next.timeline),{stageId:input.returnTarget,enteredAt:at,note:`draft_return:${input.reasonCode}`,actor:input.rejectedBy}],updatedAt:at,activeWorkflow:input.returnTarget!=='paused_review',inactiveWorkflow:input.returnTarget==='paused_review'}
 if(input.returnTarget==='backcheck_queue')Object.assign(next,{reviewDisposition:'needs_recheck',reviewUpdatedAt:at})
 if(input.returnTarget==='contact_mining_queue')Object.assign(next,{contactMiningRequired:true,reviewDisposition:'active'})
 if(input.returnTarget==='email_validation_queue')Object.assign(next,{specificEmailVerified:false})
 if(input.returnTarget==='replace_contact_queue')Object.assign(next,{currentEmailUseBlocked:true})
 if(input.returnTarget==='paused_review')Object.assign(next,{reviewDisposition:'paused',reviewUpdatedAt:at,reviewReason:input.reasonCode})
 // 主公 2026-08-21：退信/封禁 → 直接隔离（true_excluded），不进 replace_contact / manual_review。
 if(input.returnTarget==='true_excluded')Object.assign(next,{operationalTier:'true_excluded',reviewDisposition:'do_not_develop',currentEmailUseBlocked:true})
 return next
}
export function isDraftReviewReplacementComplete(item:any){const marker=item?.draftReviewReturn;if(marker?.returnTarget!=='replace_contact_queue')return false;const current=email(item?.selectedEmail),previous=email(marker?.selectedEmail);return Boolean(current&&previous&&current!==previous&&hasTrustedSpecificEmailEvidence(item,current))}
export function activeDraftReviewReturnStage(item:any):'backcheck_queue'|'contact_mining_queue'|'email_validation_queue'|'replace_contact_queue'|'true_excluded'|'manual_review'|undefined{const marker=item?.draftReviewReturn;if(!marker?.returnedAt)return;const target=marker.returnTarget as DraftReturnTarget;if(!DRAFT_RETURN_TARGETS.includes(target))return;const returned=Date.parse(marker.returnedAt)
 if(target==='backcheck_queue'&&item?.reviewDisposition==='active'&&Date.parse(item?.reviewUpdatedAt||'')>returned)return
 if(target==='contact_mining_queue'&&contactSignature(item)!==text(marker.baselineContactSignature))return
 if(target==='email_validation_queue'&&(list(item?.emailVerificationEvidence).length>Number(marker.baselineEvidenceCount||0)||Date.parse(item?.verificationCheckedAt||'')>returned))return
 if(target==='replace_contact_queue'){
  if(isDraftReviewReplacementComplete(item))return
  const current=selectedEmail(item),previous=email(marker?.selectedEmail)
  if(current&&current!==previous&&item?.currentEmailUseBlocked!==true)return'email_validation_queue'
 }
 if(target==='paused_review'&&item?.reviewDisposition!=='paused')return
 return target==='paused_review'?'manual_review':target}
