import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { withFormalSendQueueLock } from './formal-send-queue-store'

const ids = ['furniture', 'carseat', 'knitwear'] as const
type Id = typeof ids[number]
type Entry = { mode: 'disabled'|'own'|'shared'; base_url: string; model: string; shared_ref: string; ciphertext: string }
type Store = { revision: number; businesses: Record<Id, Entry> }
const emptyEntry = (): Entry => ({mode:'disabled',base_url:'',model:'',shared_ref:'',ciphertext:''})
export const BUSINESS_LLM_PATH = join(__dirname,'..','data','business_execution_api.json')
function empty(): Store { return {revision:0,businesses:{furniture:emptyEntry(),carseat:emptyEntry(),knitwear:emptyEntry()}} }
function read(path: string): Store { return existsSync(path) ? JSON.parse(readFileSync(path,'utf8')) : empty() }
async function codec(input: string, decrypt = false): Promise<string> {
  const action = decrypt ? '$b=[Convert]::FromBase64String($s);$r=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Text.Encoding]::UTF8.GetString($r))' : '$b=[Text.Encoding]::UTF8.GetBytes($s);$r=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($r))'
  const command = "Add-Type -AssemblyName System.Security;$s=[Console]::In.ReadToEnd();" + action
  return new Promise((resolve,reject)=>{
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,stdio:['pipe','pipe','ignore']})
    let output='', failed=false
    const timer=setTimeout(()=>{failed=true;child.kill();reject(new Error('SECRET_CODEC_FAILED'))},15000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data',(chunk:string)=>{output+=chunk;if(output.length>16384){failed=true;child.kill()}})
    child.on('error',()=>{clearTimeout(timer);reject(new Error('SECRET_CODEC_FAILED'))})
    child.on('close',code=>{clearTimeout(timer);if(failed||code!==0||!output)reject(new Error('SECRET_CODEC_FAILED'));else resolve(output)})
    child.stdin.on('error',()=>{})
    child.stdin.end(input)
  })
}
export function summary(store: Store) {
  return {revision:store.revision,active:false,businesses:Object.fromEntries(ids.map(id=>{const e=store.businesses[id], src=store.businesses[e.shared_ref as Id];return [id,{mode:e.mode,base_url:e.base_url,model:e.model,shared_ref:e.shared_ref,configured:e.mode==='own'?Boolean(e.ciphertext):e.mode==='shared'?Boolean(src?.mode==='own'&&src.ciphertext):false}]}))}
}
export function readBusinessLlm(path = BUSINESS_LLM_PATH) { return summary(read(path)) }
export async function updateBusinessLlm(input: any, path = BUSINESS_LLM_PATH) {
  const allowed = ['revision','business_id','mode','base_url','model','shared_ref','secret_action','secret']
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k=>!allowed.includes(k))) throw new Error('INVALID_CONFIG')
  const {revision,business_id:id,mode,base_url,model,shared_ref,secret_action,secret}=input
  if (!Number.isSafeInteger(revision) || !ids.includes(id) || !['disabled','own','shared'].includes(mode) || !['keep','replace','clear'].includes(secret_action) || typeof base_url !== 'string' || typeof model !== 'string' || typeof shared_ref !== 'string' || model.length>150 || base_url.length>1000) throw new Error('INVALID_CONFIG')
  if (secret_action==='replace' ? typeof secret!=='string'||!secret.trim()||secret.length>4096||/[\x00-\x1f\x7f]/.test(secret) : secret!==undefined) throw new Error('INVALID_CONFIG')
  if (mode!=='own' && secret_action==='replace') throw new Error('INVALID_CONFIG')
  if (mode==='own') { try { const u=new URL(base_url);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash||!model.trim()) throw 0 } catch { throw new Error('INVALID_CONFIG') } }
  if (mode==='shared' && (!ids.includes(shared_ref as Id)||shared_ref===id||secret_action!=='keep')) throw new Error('INVALID_CONFIG')
  const encrypted=secret_action==='replace'?await codec(secret):''
  mkdirSync(dirname(path),{recursive:true})
  return withFormalSendQueueLock(()=>{
    const store=read(path); if(store.revision!==revision) throw new Error('CONFIG_CONFLICT')
    const target=store.businesses[id as Id]
    const ciphertext=secret_action==='replace'?encrypted:secret_action==='clear'?'':target.ciphertext
    if(mode==='shared' && (store.businesses[shared_ref as Id].mode!=='own'||!store.businesses[shared_ref as Id].ciphertext)) throw new Error('SHARED_SOURCE_UNAVAILABLE')
    store.businesses[id as Id]={mode,base_url:mode==='own'?base_url:'',model:mode==='own'?model:'',shared_ref:mode==='shared'?shared_ref:'',ciphertext}
    store.revision++; const tmp=`${path}.${randomUUID()}.tmp`
    try {writeFileSync(tmp,JSON.stringify(store),'utf8');renameSync(tmp,path)} finally {if(existsSync(tmp)) unlinkSync(tmp)}
    return summary(store)
  },{path})
}
export async function resolveBusinessLlm(id: Id,path = BUSINESS_LLM_PATH) {
  if(!ids.includes(id)) throw new Error('INVALID_CONFIG')
  const s=read(path), e=s.businesses[id], selected=e.mode==='shared'?s.businesses[e.shared_ref as Id]:e
  if(e.mode==='disabled'||!selected||selected.mode!=='own'||!selected.ciphertext) throw new Error('LLM_NOT_CONFIGURED')
  return {base_url:selected.base_url,model:selected.model,secret:await codec(selected.ciphertext,true)}
}
