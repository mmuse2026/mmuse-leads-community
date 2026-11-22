export type SalesStage = 'new_customer' | 'contact_established' | 'replied' |
  'requirements_discovery' | 'quotation_preparation' | 'quoted' | 'negotiation' |
  'sample' | 'decision_pending' | 'won' | 'nurture' | 'lost'
export type WaitingFor = 'us' | 'customer' | 'none'
export type CrmTaskStatus = 'pending' | 'completed' | 'rescheduled' | 'cancelled'
export type CommunicationChannel = 'email' | 'whatsapp' | 'phone' | 'wechat' | 'video_meeting' | 'in_person' | 'system' | 'note'
export const SALES_STAGE_LABELS: Record<SalesStage, string> = {
  new_customer:'新客户', contact_established:'已建立联系', replied:'客户已回复',
  requirements_discovery:'需求确认中', quotation_preparation:'准备报价', quoted:'已报价',
  negotiation:'谈判中', sample:'样品阶段', decision_pending:'等待决定',
  won:'已成交', nurture:'暂缓培育', lost:'已流失'
}
export const WAITING_FOR_LABELS: Record<WaitingFor, string> = { us:'等待我方', customer:'等待客户', none:'无需等待' }
export interface SalesStageHistoryEntry { id:string; from?:SalesStage; to:SalesStage; reason:string; changedAt:string; actor:string }
export interface Opportunity { id:string; name:string; status:'collecting'|'confirmed'|'quoting'|'negotiating'|'sampling'|'won'|'paused'|'lost'; products:string[]; specifications:string; quantity?:number; budget?:number; currency?:string; tradeTerm?:string; destinationPort?:string; deliveryRequirement?:string; customization?:string; packaging?:string; certifications?:string[]; sampleRequirement?:string; concerns:string[]; confirmedItems:string[]; openQuestions:string[]; estimatedAmount?:number; winProbability?:number; createdAt:string; updatedAt:string; closedReason?:string }
export interface CommunicationEvent { id:string; occurredAt:string; channel:CommunicationChannel; direction:'outbound'|'inbound'|'internal'; eventType:string; contactName?:string; subject?:string; content:string; outcome?:string; opportunityId?:string; quoteId?:string; attachmentIds?:string[]; nextAction?:string; suggestedFollowupAt?:string; source:'email_log'|'zoho_reply'|'legacy_note'|'manual'|'crm_command'; createdBy:string; createdAt:string; externalMessageId?:string; dedupeKey:string; dateIncomplete?:boolean }
export interface CrmTask { id:string; type:'reply_customer'|'confirm_requirements'|'prepare_quote'|'follow_quote'|'follow_sample'|'confirm_order'|'supply_information'|'general_followup'; content:string; opportunityId?:string; dueAt:string; priority:'high'|'medium'|'low'; status:CrmTaskStatus; source:string; createdBy:string; createdAt:string; completedAt?:string; completionResult?:string; cancelledAt?:string; cancellationReason?:string; previousDueAt?:string; rescheduleReason?:string }
export interface CrmCommandAuditEntry { commandId:string; fingerprint:string; type:string; actor:string; appliedAt:string }

