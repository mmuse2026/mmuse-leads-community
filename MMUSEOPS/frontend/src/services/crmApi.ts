import type { PipelineItem } from '../types/item'
import { acceptAuthoritativeItem, authorizedJsonPost } from '../store/db'

export type CrmCommandType = 'communication.append'|'opportunity.create'|'opportunity.update'|
  'quote.createVersion'|'quote.updateStatus'|'task.create'|'task.complete'|
  'task.reschedule'|'task.cancel'|'salesStage.change'|'summary.update'

export async function runCrmCommand(itemId:string,type:CrmCommandType,payload:Record<string,unknown>,commandId=crypto.randomUUID()):Promise<PipelineItem>{
  const result=await authorizedJsonPost('/api/crm/command',{commandId,itemId,type,payload})
  if(!result.item||result.item.id!==itemId)throw new Error('CRM_SERVER_RESPONSE_INVALID')
  return acceptAuthoritativeItem(result.item as PipelineItem)
}
