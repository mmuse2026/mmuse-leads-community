import { useState } from 'react'
import type { PipelineItem } from '../../types/item'
import { runCrmCommand } from '../../services/crmApi'

export default function OpportunityPanel({item,onUpdated}:{item:PipelineItem;onUpdated:(item:PipelineItem)=>void}){
  const [name,setName]=useState('');const [products,setProducts]=useState('');const [specifications,setSpecifications]=useState('');const [quantity,setQuantity]=useState('')
  const create=async()=>{if(!name.trim())return;const now=new Date().toISOString();const opportunity={id:crypto.randomUUID(),name:name.trim(),status:'collecting',products:products.split(/[,，]/).map(v=>v.trim()).filter(Boolean),specifications,quantity:quantity?Number(quantity):undefined,concerns:[],confirmedItems:[],openQuestions:[],createdAt:now,updatedAt:now};try{onUpdated(await runCrmCommand(item.id,'opportunity.create',{opportunity}));setName('');setProducts('');setSpecifications('');setQuantity('')}catch(e){alert(e instanceof Error?e.message:'创建失败')}}
  return <section className="stat-card space-y-4"><h2 className="text-sm font-semibold text-surface-800">客户需求 / 商机</h2>
    <div className="space-y-2">{(item.opportunities||[]).map(o=><div key={o.id} className="rounded-xl border border-surface-200 p-3"><div className="flex justify-between"><strong>{o.name}</strong><span className="badge bg-amber-50 text-amber-700">{o.status}</span></div><p className="text-xs text-surface-600 mt-2">产品：{o.products?.join('、')||'待确认'}　数量：{o.quantity||'待确认'}</p><p className="text-xs text-surface-500 mt-1">规格：{o.specifications||'待确认'}</p></div>)}{!item.opportunities?.length&&<p className="text-xs text-surface-400">还没有商机，请把本次客户需求作为独立商机记录。</p>}</div>
    <div className="grid md:grid-cols-2 gap-2 pt-3 border-t border-surface-100"><input className="input" value={name} onChange={e=>setName(e.target.value)} placeholder="商机名称*"/><input className="input" value={products} onChange={e=>setProducts(e.target.value)} placeholder="产品，多个用逗号分隔"/><input className="input" value={specifications} onChange={e=>setSpecifications(e.target.value)} placeholder="规格/定制要求"/><input className="input" type="number" value={quantity} onChange={e=>setQuantity(e.target.value)} placeholder="数量"/><button className="btn-primary md:col-span-2" onClick={create}>新增商机</button></div>
  </section>
}
