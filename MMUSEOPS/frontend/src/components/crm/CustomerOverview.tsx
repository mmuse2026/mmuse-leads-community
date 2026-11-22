import { useState } from 'react'
import type { PipelineItem } from '../../types/item'
import { SALES_STAGE_LABELS, WAITING_FOR_LABELS, type SalesStage, type WaitingFor } from '../../types/crm'
import { runCrmCommand } from '../../services/crmApi'

export default function CustomerOverview({item,onUpdated}:{item:PipelineItem;onUpdated:(item:PipelineItem)=>void}) {
  const [summary,setSummary]=useState(item.relationshipSummary||'')
  const [owner,setOwner]=useState(item.owner||'')
  const [waitingFor,setWaitingFor]=useState<WaitingFor>(item.waitingFor||'none')
  const [reason,setReason]=useState('人工确认客户销售阶段')
  const [busy,setBusy]=useState(false)
  const execute=async(type:'summary.update'|'salesStage.change',payload:Record<string,unknown>)=>{setBusy(true);try{onUpdated(await runCrmCommand(item.id,type,payload))}catch(e){alert(e instanceof Error?e.message:'保存失败')}finally{setBusy(false)}}
  return <section className="stat-card space-y-4">
    <div className="flex items-center justify-between"><h2 className="text-sm font-semibold text-surface-800">客户概览</h2><span className="badge bg-blue-50 text-blue-700">{SALES_STAGE_LABELS[item.salesStage||'new_customer']}</span></div>
    <div className="grid md:grid-cols-3 gap-3 text-xs">
      <Field label="最近沟通" value={formatDate(item.lastContactAt)}/><Field label="下一步" value={item.nextAction||'未设置'}/><Field label="下次跟进" value={formatDate(item.nextFollowupAt)}/>
    </div>
    <textarea className="input w-full min-h-20" value={summary} onChange={e=>setSummary(e.target.value)} placeholder="客户是做什么的、核心需求、当前障碍与关系判断" />
    <div className="grid md:grid-cols-3 gap-2">
      <input className="input" value={owner} onChange={e=>setOwner(e.target.value)} placeholder="负责人" />
      <select className="input" value={waitingFor} onChange={e=>setWaitingFor(e.target.value as WaitingFor)}>{Object.entries(WAITING_FOR_LABELS).map(([v,l])=><option key={v} value={v}>{l}</option>)}</select>
      <button disabled={busy} className="btn-primary" onClick={()=>execute('summary.update',{relationshipSummary:summary,owner,waitingFor})}>保存概览</button>
    </div>
    <div className="grid md:grid-cols-3 gap-2 pt-3 border-t border-surface-100">
      <select className="input" value={item.salesStage||'new_customer'} onChange={e=>execute('salesStage.change',{salesStage:e.target.value,reason})}>{Object.entries(SALES_STAGE_LABELS).map(([v,l])=><option key={v} value={v}>{l}</option>)}</select>
      <input className="input md:col-span-2" value={reason} onChange={e=>setReason(e.target.value)} placeholder="阶段变更原因（必填）" />
    </div>
  </section>
}
function Field({label,value}:{label:string;value:string}){return <div className="rounded-lg bg-surface-50 p-3"><div className="text-surface-400 mb-1">{label}</div><div className="text-surface-800">{value}</div></div>}
function formatDate(value?:string){return value?new Date(value).toLocaleString('zh-CN'):'未记录'}
