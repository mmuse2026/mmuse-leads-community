import { isIsolatedItem } from './itemIsolation'

const list=(value:unknown):any[]=>Array.isArray(value)?value:[]
const text=(value:unknown)=>String(value??'').trim().toLowerCase()
const address=(value:unknown)=>text(value)
const entryAddress=(entry:any)=>address(entry?.email||entry?.recipientEmail||entry?.to||entry?.bouncedEmail)
const SPECIFIC_OK=new Set(['specific_email_verified','smtp_handshake_pass','reply_observed'])

export interface OutboundRiskAssessment {
  doNotContact:boolean
  blockedEmail:boolean
  priorFormalSend:boolean
  replied:boolean
}

export function hasTrustedSpecificEmailEvidence(item:any,selectedEmail:unknown){
  const selected=address(selectedEmail)
  if(!selected)return false
  if(item?.specificEmailVerified===true&&address(item?.specificEmailVerifiedFor)===selected)return true
  return list(item?.emailVerificationEvidence).some(entry=>entryAddress(entry)===selected&&entry?.scope==='specific_email'&&SPECIFIC_OK.has(text(entry?.result||entry?.status)))
}

export function assessOutboundRisk(item:any,selectedEmail?:unknown):OutboundRiskAssessment {
  const evidence=list(item?.emailVerificationEvidence)
  const logs=list(item?.emailLogs)
  const selected=address(selectedEmail)
  const belongsToSelected=(entry:any)=>{const linked=entryAddress(entry);return !selected||!linked||linked===selected}
  const globalText=[...evidence.flatMap(entry=>[entry?.result,entry?.status,entry?.providerLastEvent,entry?.webhookEventType,entry?.recoveryStatus]),...logs.flatMap(log=>[log?.status,log?.providerLastEvent])].map(text).join(' ')
  const globalSuppression=/suppressed|complained|do_not_contact/.test(globalText)
  // Reuse the exact-address refusal sources already enforced by leadStageEligibility.
  // An address hold must also survive the final send-time gate; unrelated addresses
  // do not turn an address-level hold into a company-wide prohibition.
  const addressHold=list(item?.doNotContactEmails).some(value=>Boolean(address(value))&&(!selected||address(value)===selected))
    ||list(item?.emailVerificationRouting).some(entry=>Boolean(address(entry?.email))&&(!selected||address(entry.email)===selected)&&entry?.queue==='do_not_contact')
    ||list(item?.emailDispositionLog).some(entry=>Boolean(address(entry?.email))&&(!selected||address(entry.email)===selected)&&/suppressed|complained|do_not_contact/.test(text([entry?.disposition,entry?.reason].join(' '))))
  // 2026-08-21：inactiveWorkflow 是工作流状态（商业暂缓/供应商池/低优先级/无关），不是联系禁令，
  // 真正筛选由阶段路由（searchPool/backcheck/验证闸）负责，doNotContact 只保留硬性排除。
  // permanent_do_not_develop 由 doNotDevelop/reviewDisposition='do_not_develop' 派生，已被 isIsolatedItem 覆盖。
  const doNotContact=item?.doNotDevelop===true
    ||item?.doNotContactEmail===true
    ||item?.operationalTier==='true_excluded'
    ||globalSuppression
    ||addressHold
    ||isIsolatedItem(item)
  const itemEmail=address(item?.email)
  const explicitRiskEmail=address(item?.bouncedEmail||item?.currentEmailUseBlockedForEmail)
  const topLevelApplies=!selected
    ||(explicitRiskEmail?selected===explicitRiskEmail:(!itemEmail||selected===itemEmail))
  const addressRiskText=evidence.filter(belongsToSelected).flatMap(entry=>[entry?.result,entry?.status,entry?.providerLastEvent,entry?.webhookEventType,entry?.recoveryStatus]).map(text).join(' ')
  const blockedEmail=globalSuppression
    ||(topLevelApplies&&(item?.emailBounced===true||item?.replyQueue==='bounced_queue'||text(item?.emailReachability)==='unreachable'))
    ||logs.filter(belongsToSelected).some(log=>['bounced','failed'].includes(text(log?.status)))
    ||/bounced|failed|smtp_handshake_fail|format_invalid|dns_failed|no_mx|domain_unreachable|unreachable/.test(addressRiskText)
  const priorFormalSend=logs.some(log=>text(log?.status)==='sent'&&text(log?.type)!=='test_handshake')
  const replied=item?.developmentStatus==='replied'
    ||item?.replyQueue==='replied_queue'
    ||logs.some(log=>['replied','received'].includes(text(log?.status)))
    ||evidence.some(entry=>['reply_observed','received'].includes(text(entry?.result||entry?.status)))
  return{doNotContact,blockedEmail,priorFormalSend,replied}
}
