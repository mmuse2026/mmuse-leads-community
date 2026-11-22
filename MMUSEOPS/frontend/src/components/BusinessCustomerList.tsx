import { useEffect, useState } from 'react'
import { API_BASE } from '../services/config'
import BusinessCustomerDetail from './BusinessCustomerDetail'

type Line = 'furniture' | 'carseat' | 'knitwear' | 'unclassified'
type Customer = { id: string; company: string; country: string; website: string; source: string }
type Result = { business_id: Line; status: 'available' | 'unavailable'; readonly: boolean; total: number | null; items: Customer[] }
export default function BusinessCustomerList({ line }: { line: Line }) {
  const [page, setPage] = useState(1)
  const [data, setData] = useState<Result | null>(null)
  const [error, setError] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    setData(null); setError(false); setSelectedId(null)
    fetch(`${API_BASE}/api/business-pipeline-customers?business_id=${encodeURIComponent(line)}&page=${page}&page_size=20`, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('unavailable')
      const result = await response.json() as Result
      if (result.business_id !== line || !Array.isArray(result.items) || !['available', 'unavailable'].includes(result.status)) throw new Error('scope')
      if (!controller.signal.aborted) setData(result)
    }).catch(() => { if (!controller.signal.aborted) setError(true) })
    return () => controller.abort()
  }, [line, page])
  const title = line === 'unclassified' ? '待归类客户 · 只读' : line === 'knitwear' ? '羊毛衫独立客户库' : line === 'carseat' ? '汽车业务客户' : '家具业务客户'
  return <main className="min-w-0 p-4 lg:p-5" aria-label={title}>
    <h2 className="font-semibold">{title}</h2>
    {line === 'carseat' && <p className="mt-2 text-sm text-amber-800">客户已接入列表，独立执行器尚未接入。</p>}
    <p className="mt-2 text-sm text-surface-500">{line === 'unclassified' ? '来源：独立待归类记录，不提供旧客户编辑入口。' : '客户详情按业务读取；编辑是否可用以详情状态为准。'}</p>
    {line === 'knitwear' && <p className="mt-2 text-sm text-surface-500">来源：羊毛衫独立客户库。</p>}
    {error ? <p role="status" className="mt-4">客户来源暂不可用，数量未知。</p> : !data ? <p role="status" className="mt-4">正在读取客户…</p> : data.status === 'unavailable' ? <p role="status" className="mt-4">客户来源未接通，数量未知。</p> : <>
      <p className="mt-3 text-sm text-surface-500">{data.total === null ? '客户记录数量未知' : `${data.total} 条客户记录`}</p>
      <div className="mt-3 divide-y rounded-xl border bg-white">{data.items.map(item => <button key={item.id} disabled={line === 'unclassified' || !item.id.startsWith(`${line}:`) || item.id.length <= line.length + 1} type="button" data-customer-row className="block w-full p-4 text-left" onClick={() => setSelectedId(item.id.slice(line.length + 1))}><strong>{item.company || '未命名客户'}</strong><p className="text-sm text-surface-500">{item.country || '国家待补充'} · {item.website || '官网待补充'}</p></button>)}</div>
      {selectedId && line !== 'unclassified' && <BusinessCustomerDetail key={`${line}:${selectedId}`} line={line} id={selectedId} close={() => setSelectedId(null)} />}
      {data.items.length === 0 && <p className="mt-3 text-sm text-surface-500">当前没有客户记录。</p>}
      <div className="mt-4 flex items-center gap-3"><button className="directory-control-button" disabled={page === 1} onClick={() => setPage(value => value - 1)}>上一页</button><span>第 {page} 页</span><button className="directory-control-button" disabled={data.total === null || page * 20 >= data.total} onClick={() => setPage(value => value + 1)}>下一页</button></div>
    </>}
  </main>
}
