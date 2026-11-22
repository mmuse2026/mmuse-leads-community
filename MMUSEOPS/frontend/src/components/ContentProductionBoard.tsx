import { useCallback, useEffect, useState } from 'react'
import { API_BASE } from '../services/config'
import type { buildContentProduction } from '../services/contentProduction'
type Report=ReturnType<typeof buildContentProduction>&{workspace_id:string;links:{media:string;compose:string;articles:string}}
export default function ContentProductionBoard({businessLine}:{businessLine?:string}) {
  const [reports,setReports]=useState<Report[]>([]),[errors,setErrors]=useState<string[]>([]),[loading,setLoading]=useState(true),[notice,setNotice]=useState('')
  const load=useCallback(async(signal?:AbortSignal)=>{
    const lines=businessLine?[businessLine]:['furniture','carseat']
    const results=await Promise.all(lines.map(async line=>{try{
      const r=await fetch(`${API_BASE}/api/marketing/production-tasks?business_line=${line}`,{signal:signal||AbortSignal.timeout(20000)})
      if(!r.ok)throw new Error('目录未连接')
      return {report:await r.json() as Report}
    }catch{return {error:`${line==='furniture'?'家具':'汽车座椅套'}：内容目录暂不可用，不将连接失败当成缺素材。`}}}))
    if(signal?.aborted)return
    setReports(results.flatMap(r=>r.report?[r.report]:[]));setErrors(results.flatMap(r=>r.error?[r.error]:[]));setLoading(false)
  },[businessLine])
  useEffect(()=>{const controller=new AbortController();void load(controller.signal);const timer=setInterval(()=>{void load(controller.signal)},60000);return()=>{controller.abort();clearInterval(timer)}},[load])
  const tasks=reports.flatMap(r=>r.tasks.filter(t=>t.state==='needs_work').map(t=>({...t,report:r})))
  const prompt=tasks.map(t=>t.prompt).join('\n\n---\n\n')
  async function copy(text:string){try{await navigator.clipboard.writeText(text);setNotice('已复制，交给 Codex 补充即可。')}catch{setNotice('复制失败，请展开要求手动复制。')}}
  function download(){const blob=new Blob([`# 待补内容任务\n\n${prompt}`],{type:'text/markdown;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='待补内容任务.md';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
  return <section className="overflow-hidden rounded-xl border border-surface-200 bg-white" aria-label="集中内容生产任务">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-surface-100 px-4 py-3"><div><h2 className="text-sm font-semibold text-surface-900">待补内容</h2><p className="mt-0.5 text-xs text-surface-500">{tasks.length} 个主题待处理，{reports.reduce((n,r)=>n+r.reusable,0)} 个可复用</p></div><button type="button" className="directory-control-button" onClick={()=>{void load()}}>刷新</button></div>
    {loading&&<p role="status">正在汇总两端资料…</p>}{errors.map(e=><p key={e} role="alert" className="text-amber-700">{e}</p>)}
    {!!tasks.length&&<div className="flex gap-2 border-b border-surface-100 px-4 py-3"><button type="button" className="directory-control-button" onClick={()=>{void copy(prompt)}}>复制全部要求</button><button type="button" className="directory-control-button" onClick={download}>下载清单</button></div>}
    {notice&&<p role="status" className="px-4 py-2 text-xs text-surface-600">{notice}</p>}
    <div className="divide-y divide-surface-100">{tasks.map(task=><details key={task.id} className="group px-4 py-3"><summary className="flex cursor-pointer list-none items-center justify-between gap-4"><span className="min-w-0"><strong className="block truncate text-sm text-surface-900">{task.topic}</strong><span className="mt-0.5 block truncate text-xs text-surface-500">缺少：{task.missing.join('、')}</span></span><span className="text-xs text-surface-400">{task.report.business_line==='furniture'?'家具':'座椅套'}</span></summary><div className="mt-3 space-y-2 border-t border-surface-100 pt-3"><p className="text-xs text-surface-600">{task.reason}</p><div className="flex flex-wrap gap-3 text-xs"><button type="button" className="text-accent-600" onClick={()=>{void copy(task.prompt)}}>复制处理要求</button><a href={`http://127.0.0.1:8000${task.report.links.media}`} target="_blank" rel="noreferrer">打开素材库</a><a href={`http://127.0.0.1:8000${task.report.links.compose}`} target="_blank" rel="noreferrer">打开社媒排版</a><a href={`http://127.0.0.1:8000${task.report.links.articles}`} target="_blank" rel="noreferrer">打开网站内容</a></div></div></details>)}</div>
    {!loading&&!errors.length&&!tasks.length&&<p className="px-4 py-8 text-center text-sm text-surface-500">当前没有待补内容</p>}
    {!!reports.length&&<details className="border-t border-surface-100 px-4 py-3"><summary className="cursor-pointer list-none text-xs text-surface-500">查看统计依据</summary>{reports.map(r=><div key={r.business_line} className="mt-2 space-y-1 text-xs text-surface-500"><p>{r.business_line==='furniture'?'家具':'汽车座椅套'}：读取 {r.total_customers} 位活动客户；{r.unclassified_customers} 位暂无可识别主题。</p><p>{r.basis}</p></div>)}</details>}
  </section>
}
