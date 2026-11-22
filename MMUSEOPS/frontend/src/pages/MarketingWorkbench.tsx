import PageHead from '../components/PageHead'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import AutomaticContentSuggestions from '../components/AutomaticContentSuggestions'
import ContentProductionBoard from '../components/ContentProductionBoard'
import { API_BASE } from '../services/config'
import { getAllItems, loadFromDisk } from '../store/db'
import type { PipelineItem } from '../types/item'
import { activeMarketingCustomer, campaignOutcomes, marketingBusinessLine, outreachBrief, type MarketingState } from '../services/marketingBridge'

export default function MarketingWorkbench() {
  const [state,setState]=useState<MarketingState|null>(null)
  const [items,setItems]=useState<PipelineItem[]>([])
  const [workspaceId,setWorkspaceId]=useState('')
  const [customerId,setCustomerId]=useState('')
  const [campaignId,setCampaignId]=useState('')
  const [error,setError]=useState('')
  const [copied,setCopied]=useState(false)
  const [loading,setLoading]=useState(true)
  useEffect(()=>{void (async()=>{try {
    const response=await fetch(`${API_BASE}/api/marketing/bridge`,{signal:AbortSignal.timeout(15000)})
    if(!response.ok) throw new Error('营销资料暂不可用，请检查数据桥。')
    const value:MarketingState=await response.json();setState(value);setWorkspaceId(Object.keys(value.workspaces)[0]||'')
    await loadFromDisk();const all=await getAllItems();setItems(all)
    const requested=new URLSearchParams(window.location.search).get('customer_id')||''
    const target=all.find(i=>i.id===requested)
    if(target){const w=Object.entries(value.workspaces).find(([,w])=>w.business_line===marketingBusinessLine(target.businessLine));if(w){setWorkspaceId(w[0]);setCustomerId(target.id)}}
  }catch(e){setError(e instanceof Error?e.message:'加载失败')}finally{setLoading(false)}})()},[])
  const workspace=state?.workspaces[workspaceId]
  const customers=useMemo(()=>items.filter(i=>activeMarketingCustomer(i) && marketingBusinessLine(i.businessLine)===workspace?.business_line),[items,workspace])
  const customer=customers.find(c=>c.id===customerId)
  const brief=workspace&&customer?outreachBrief(workspace,customer.id,campaignId):null
  const outcomes=workspace?campaignOutcomes(workspace,items):[]
  function chooseWorkspace(value:string){setWorkspaceId(value);setCustomerId('');setCampaignId('');setCopied(false)}
  return <div className="h-full overflow-y-auto bg-[#f5f5f7] p-5 lg:p-8"><div className="mx-auto max-w-6xl space-y-5">
    <PageHead eyebrow="营销" title="营销与客户开发" subtitle="先处理缺少的内容，再按客户查看开发建议。" actions={<button className="directory-control-button" onClick={()=>window.location.reload()}>刷新</button>} />
    <ContentProductionBoard />
    {error&&<p role="alert" className="text-red-600">{error}</p>}
    {loading&&<p role="status" className="text-sm text-surface-500">正在读取客户数据，效果统计待加载完成。</p>}
    <div className="flex flex-wrap items-center gap-2"><select className="rounded-lg border border-surface-200 bg-white px-3 py-2 text-sm" value={workspaceId} onChange={e=>chooseWorkspace(e.target.value)}><option value="">选择营销工作区</option>{Object.entries(state?.workspaces||{}).map(([id,w])=><option key={id} value={id}>{w.business_line==='furniture'?'家具':'汽车座椅套'}</option>)}</select>{workspace&&<a href={`http://127.0.0.1:8000/workspace/${workspaceId}/marketing/`} className="directory-control-button">打开数字营销管理</a>}</div>
    {!workspace&&<div className="stat-card"><p>先在 BAKA 社媒工作台「营销与客户开发」保存共享营销资料或创建活动，之后刷新此页。</p><a href="http://127.0.0.1:8000/" className="text-accent-600">打开 BAKA 工作台</a></div>}
    {workspace&&<>
      <details className="rounded-xl border border-surface-200 bg-white p-4"><summary className="cursor-pointer list-none text-sm font-semibold text-surface-700">活动结果</summary><p className="mt-2 text-xs text-surface-500">客户数按活动去重，同一客户可参与不同活动。</p>
      {!loading&&!error&&<table className="w-full text-sm mt-3"><thead><tr>{['活动','关联客户','采购信号','报价','机会','成交'].map(t=><th key={t} className="text-left p-2">{t}</th>)}</tr></thead><tbody>{outcomes.map(o=><tr key={o.id}>{[o.name,o.customers,o.inquiries,o.quoted,o.opportunities,o.won].map((v,i)=><td key={i} className="p-2">{v}</td>)}</tr>)}</tbody></table>}</details>
      <div className="rounded-xl border border-surface-200 bg-white p-4 space-y-3"><h2 className="text-sm font-semibold text-surface-900">客户开发建议</h2>
      <select className="border rounded p-2 w-full" value={customerId} onChange={e=>{setCustomerId(e.target.value);setCopied(false)}}><option value="">选择当前业务线客户</option>{customers.map(c=><option key={c.id} value={c.id}>{c.company||c.title} · {c.country}</option>)}</select>
      {customer&&<div className="flex gap-4 text-sm"><Link to={`/item/${customer.id}`} className="text-accent-600">查看 CRM / 下一步</Link></div>}
      {brief&&<><p className="text-sm">{brief.priority}</p><p className="text-xs text-surface-500">首触：{brief.firstTouch?.source||'未知'}；末触：{brief.lastTouch?.source||'未知'}。营销线索不改变客户阶段或邮箱门禁。</p><pre className="whitespace-pre-wrap text-sm bg-surface-50 p-4 rounded">{brief.text}</pre><button className="border rounded p-2 text-sm" onClick={()=>{void navigator.clipboard.writeText(brief.text).then(()=>setCopied(true)).catch(()=>setError('复制失败，请手动选择建议文本。'))}}>{copied?'已复制':'复制开发建议'}</button></>}
      </div>
      {customer&&<details className="rounded-xl border border-surface-200 bg-white p-4"><summary className="cursor-pointer list-none text-sm font-semibold text-surface-700">相关内容建议</summary><div className="mt-4"><AutomaticContentSuggestions customerId={customer.id}/></div></details>}
      <details className="rounded-xl border border-surface-200 bg-white p-4"><summary className="cursor-pointer list-none text-sm font-semibold text-surface-700">SEO / GEO 参考</summary><p className="mt-3 whitespace-pre-wrap text-sm text-surface-600">{String(workspace.context.seo_questions||'尚未设置长期采购问题。')}</p></details>
    </>}
  </div></div>
}
