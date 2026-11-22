import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { llmChatWithFallback } from '../src/services/llm-client'
export async function mailWorkspaceLlm(messages: { role: string; content: string }[], timeout: number) {
  const primary = await llmChatWithFallback(messages, Math.min(timeout, 15000))
  if(primary) return primary
  const instruction=messages.filter(m=>m.role==='system').map(m=>m.content).join(' ')
  const task=instruction.includes('Classify only')?'mailbox_analysis':instruction.includes('Translate faithfully')?'translation':instruction.includes('Independently review')?'reply_review':instruction.includes('Draft a concise')?'reply_draft':null
  if(!task)throw Error('MAIL_MODEL_TASK_NOT_SUPPORTED')
  const root=join(process.env.WB_USER_DATA_DIR||join(process.env.APPDATA||'','UnifiedWorkbench'),'workbench-runtime','mail-model'),id=randomUUID()
  mkdirSync(join(root,'requests'),{recursive:true});mkdirSync(join(root,'results'),{recursive:true})
  const file=join(root,'requests',id+'.json'),temp=file+'.tmp';writeFileSync(temp,JSON.stringify({id,task,messages,at:new Date().toISOString()}));renameSync(temp,file)
  const resultFile=join(root,'results',id+'.json'),deadline=Date.now()+timeout
  while(Date.now()<deadline){if(existsSync(resultFile)){const result=JSON.parse(readFileSync(resultFile,'utf8'));if(!result.ok)throw Error(result.error||'MAIL_MODEL_UNAVAILABLE');return result.result}await new Promise(resolve=>setTimeout(resolve,150))}
  throw Error('MAIL_MODEL_TIMEOUT')
}
