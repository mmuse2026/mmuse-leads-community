import { createHash } from 'node:crypto'
import { buildCustomerTimeline } from '../src/services/crmTimeline'
import type { CrmCommandAuditEntry, CrmTask, Opportunity, SalesStage } from '../src/types/crm'

export type CrmCommandType = 'communication.append'|'opportunity.create'|'opportunity.update'|'quote.createVersion'|'quote.updateStatus'|'task.create'|'task.complete'|'task.reschedule'|'task.cancel'|'salesStage.change'|'summary.update'
export interface CrmCommand { commandId:string; itemId:string; type:CrmCommandType; payload:Record<string,unknown> }
type Validation={ok:true;value:CrmCommand}|{ok:false;code:string;field?:string}
const safeId=/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/
const commandTypes=new Set<CrmCommandType>(['communication.append','opportunity.create','opportunity.update','quote.createVersion','quote.updateStatus','task.create','task.complete','task.reschedule','task.cancel','salesStage.change','summary.update'])
const salesStages=new Set<SalesStage>(['new_customer','contact_established','replied','requirements_discovery','quotation_preparation','quoted','negotiation','sample','decision_pending','won','nurture','lost'])
const list=<T>(value:unknown):T[]=>Array.isArray(value)?value:[]
const text=(value:unknown)=>String(value||'').trim()
const validDate=(value:unknown)=>Number.isFinite(Date.parse(text(value)))
const fingerprint=(command:CrmCommand)=>createHash('sha256').update(JSON.stringify({itemId:command.itemId,type:command.type,payload:command.payload})).digest('hex')
function requireText(value:unknown,code:string,max=100000){const result=text(value);if(!result||result.length>max)throw new Error(code);return result}
function requireId(value:unknown,code:string){const result=text(value);if(!safeId.test(result))throw new Error(code);return result}

export function validateCrmCommandBody(body:unknown):Validation{
  if(!body||typeof body!=='object'||Array.isArray(body))return{ok:false,code:'CRM_COMMAND_BODY_INVALID'}
  const source=body as Record<string,unknown>
  if('actor'in source)return{ok:false,code:'CLIENT_ACTOR_FORBIDDEN',field:'actor'}
  const allowed=new Set(['commandId','itemId','type','payload']);const unexpected=Object.keys(source).find(key=>!allowed.has(key));if(unexpected)return{ok:false,code:'CRM_COMMAND_FIELD_UNEXPECTED',field:unexpected}
  const commandId=text(source.commandId),itemId=text(source.itemId),type=text(source.type) as CrmCommandType
  if(!safeId.test(commandId))return{ok:false,code:'COMMAND_ID_INVALID',field:'commandId'}
  if(!safeId.test(itemId))return{ok:false,code:'ITEM_ID_INVALID',field:'itemId'}
  if(!commandTypes.has(type))return{ok:false,code:'CRM_COMMAND_TYPE_INVALID',field:'type'}
  if(!source.payload||typeof source.payload!=='object'||Array.isArray(source.payload)||JSON.stringify(source.payload).length>1_000_000)return{ok:false,code:'CRM_COMMAND_PAYLOAD_INVALID',field:'payload'}
  return{ok:true,value:{commandId,itemId,type,payload:source.payload as Record<string,unknown>}}
}

function replaceById<T extends {id:string}>(rows:T[],id:string,update:(row:T)=>T,missingCode:string){let found=false;const next=rows.map(row=>{if(row.id!==id)return row;found=true;return update(row)});if(!found)throw new Error(missingCode);return next}
function appendAudit(item:any,command:CrmCommand,actor:string,appliedAt:string,hash:string){const audit:CrmCommandAuditEntry={commandId:command.commandId,fingerprint:hash,type:command.type,actor,appliedAt};return[...list<CrmCommandAuditEntry>(item.crmCommandLog),audit].slice(-500)}
function derive(item:any,now:string){const timeline=buildCustomerTimeline(item);const inbound=timeline.find(event=>event.direction==='inbound'&&validDate(event.occurredAt));const outbound=timeline.find(event=>event.direction==='outbound'&&validDate(event.occurredAt));const last=timeline.find(event=>validDate(event.occurredAt));const next=list<CrmTask>(item.crmTasks).filter(task=>task.status==='pending'&&validDate(task.dueAt)).sort((a,b)=>Date.parse(a.dueAt)-Date.parse(b.dueAt))[0];return{...item,lastContactAt:last?.occurredAt||item.lastContactAt,lastInboundAt:inbound?.occurredAt||item.lastInboundAt,lastOutboundAt:outbound?.occurredAt||item.lastOutboundAt,nextFollowupAt:next?.dueAt||'',nextAction:next?.content||'',crmUpdatedAt:now}}

export function applyCrmCommand(source:any,command:CrmCommand,actor:string,now=new Date()):{item:any;idempotent:boolean}{
  if(!source||text(source.id)!==command.itemId)throw new Error('CRM_ITEM_ID_MISMATCH')
  const nowIso=now.toISOString(),hash=fingerprint(command),prior=list<CrmCommandAuditEntry>(source.crmCommandLog).find(entry=>entry.commandId===command.commandId)
  if(prior){if(prior.fingerprint!==hash)throw new Error('CRM_COMMAND_CONFLICT');return{item:source,idempotent:true}}
  let item={...source}
  switch(command.type){
    case'communication.append':{const event={...(command.payload.event as any)};event.id=requireId(event.id,'CRM_EVENT_ID_INVALID');event.content=requireText(event.content,'CRM_EVENT_CONTENT_INVALID');event.occurredAt=requireText(event.occurredAt,'CRM_EVENT_DATE_INVALID');if(!validDate(event.occurredAt))throw new Error('CRM_EVENT_DATE_INVALID');event.createdBy=actor;event.createdAt=nowIso;event.source=event.source==='manual'?'manual':'crm_command';event.dedupeKey=text(event.dedupeKey)||`manual:${event.id}`;if(!list<any>(item.communicationEvents).some(row=>row.id===event.id||row.dedupeKey===event.dedupeKey))item.communicationEvents=[...list(item.communicationEvents),event];break}
    case'opportunity.create':{const opportunity={...(command.payload.opportunity as any)} as Opportunity;opportunity.id=requireId(opportunity.id,'CRM_OPPORTUNITY_ID_INVALID');opportunity.name=requireText(opportunity.name,'CRM_OPPORTUNITY_NAME_INVALID',300);if(list<Opportunity>(item.opportunities).some(row=>row.id===opportunity.id))throw new Error('CRM_OPPORTUNITY_EXISTS');item.opportunities=[...list(item.opportunities),{...opportunity,createdAt:opportunity.createdAt||nowIso,updatedAt:nowIso}];item.activeOpportunityId=item.activeOpportunityId||opportunity.id;break}
    case'opportunity.update':{const id=requireId(command.payload.opportunityId,'CRM_OPPORTUNITY_ID_INVALID'),patch={...(command.payload.patch as any)};delete patch.id;delete patch.createdAt;item.opportunities=replaceById(list<Opportunity>(item.opportunities),id,row=>({...row,...patch,id:row.id,createdAt:row.createdAt,updatedAt:nowIso}),'CRM_OPPORTUNITY_NOT_FOUND');break}
    case'task.create':{const task={...(command.payload.task as any)} as CrmTask;task.id=requireId(task.id,'CRM_TASK_ID_INVALID');task.content=requireText(task.content,'CRM_TASK_CONTENT_INVALID',5000);if(!validDate(task.dueAt))throw new Error('CRM_TASK_DATE_INVALID');if(list<CrmTask>(item.crmTasks).some(row=>row.id===task.id))throw new Error('CRM_TASK_EXISTS');item.crmTasks=[...list(item.crmTasks),{...task,status:'pending',createdBy:actor,createdAt:task.createdAt||nowIso}];break}
    case'task.complete':{const id=requireId(command.payload.taskId,'CRM_TASK_ID_INVALID'),result=requireText(command.payload.result,'CRM_TASK_RESULT_REQUIRED',5000);item.crmTasks=replaceById(list<CrmTask>(item.crmTasks),id,row=>({...row,status:'completed',completedAt:nowIso,completionResult:result}),'CRM_TASK_NOT_FOUND');break}
    case'task.reschedule':{const id=requireId(command.payload.taskId,'CRM_TASK_ID_INVALID'),dueAt=requireText(command.payload.dueAt,'CRM_TASK_DATE_INVALID'),reason=requireText(command.payload.reason,'CRM_TASK_REASON_REQUIRED',2000);if(!validDate(dueAt))throw new Error('CRM_TASK_DATE_INVALID');item.crmTasks=replaceById(list<CrmTask>(item.crmTasks),id,row=>({...row,status:'pending',previousDueAt:row.dueAt,dueAt,rescheduleReason:reason}),'CRM_TASK_NOT_FOUND');break}
    case'task.cancel':{const id=requireId(command.payload.taskId,'CRM_TASK_ID_INVALID'),reason=requireText(command.payload.reason,'CRM_TASK_REASON_REQUIRED',2000);item.crmTasks=replaceById(list<CrmTask>(item.crmTasks),id,row=>({...row,status:'cancelled',cancelledAt:nowIso,cancellationReason:reason}),'CRM_TASK_NOT_FOUND');break}
    case'salesStage.change':{const to=text(command.payload.salesStage)as SalesStage,reason=requireText(command.payload.reason,'CRM_STAGE_REASON_REQUIRED',2000);if(!salesStages.has(to))throw new Error('CRM_SALES_STAGE_INVALID');const from=item.salesStage as SalesStage|undefined;item.salesStage=to;item.salesStageHistory=[...list(item.salesStageHistory),{id:`stage-${command.commandId}`,from,to,reason,changedAt:nowIso,actor}];break}
    case'summary.update':{item.relationshipSummary=requireText(command.payload.relationshipSummary,'CRM_SUMMARY_INVALID',5000);if('waitingFor'in command.payload)item.waitingFor=command.payload.waitingFor;if('owner'in command.payload)item.owner=text(command.payload.owner);break}
    case'quote.createVersion':{const quote={...(command.payload.quote as any)};quote.id=requireId(quote.id,'CRM_QUOTE_ID_INVALID');if(list<any>(item.quoteVersions).some(row=>row.id===quote.id))throw new Error('CRM_QUOTE_EXISTS');item.quoteVersions=[...list(item.quoteVersions),{...quote,createdAt:quote.createdAt||nowIso}];break}
    case'quote.updateStatus':{const id=requireId(command.payload.quoteId,'CRM_QUOTE_ID_INVALID'),status=requireText(command.payload.status,'CRM_QUOTE_STATUS_INVALID',40);item.quoteVersions=replaceById(list<any>(item.quoteVersions),id,row=>({...row,status,updatedAt:nowIso,...(status==='sent'?{sentAt:row.sentAt||nowIso}:{})}),'CRM_QUOTE_NOT_FOUND');if(status==='sent')item.salesStage='quoted';break}
  }
  item.crmCommandLog=appendAudit(item,command,actor,nowIso,hash)
  return{item:derive(item,nowIso),idempotent:false}
}
