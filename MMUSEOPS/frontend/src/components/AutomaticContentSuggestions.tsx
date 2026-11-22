import {useEffect,useState} from 'react'
import {API_BASE} from '../services/config'
import type {ContentDocument} from '../services/contentMatching'

interface MatchResult {matches:Array<ContentDocument&{reasons:Array<{topic:string;kind:string}>}>;topics:Array<{topic:string;kind:string}>;gaps:Array<{topic:string;kind:string}>;basis:string;catalog_count:number}
export default function AutomaticContentSuggestions({customerId}:{customerId:string}) {
  const [result,setResult]=useState<MatchResult|null>(null),[error,setError]=useState('')
  useEffect(()=>{const controller=new AbortController();setResult(null);setError('');void fetch(`${API_BASE}/api/marketing/content-matches?customer_id=${encodeURIComponent(customerId)}`,{signal:controller.signal}).then(async response=>{if(!response.ok)throw new Error('暂时未取得内容目录，请检查社媒工作台是否在线。');setResult(await response.json())}).catch(e=>{if(e.name!=='AbortError')setError(e.message)});return()=>controller.abort()},[customerId])
  return <section className="stat-card space-y-3"><h2 className="font-semibold">自动找到相关内容</h2><p className="text-xs text-surface-500">读取此客户已有需求和背调，推荐同业务线的文章、社媒内容和销售资料。</p>{error?<p role="alert">{error}</p>:!result?<p>正在查找…</p>:<><p className="text-xs text-surface-500">{result.basis} · 已检索 {result.catalog_count} 条内容。</p>{result.matches.map(row=><div key={row.id} className="border rounded p-3"><a href={`http://127.0.0.1:8000${row.url}`} target="_blank" rel="noreferrer" className="text-accent-600 font-medium">{row.title}</a><p className="text-xs mt-1">{row.kind} · {row.status==='published'?'已发布':'内部参考，使用前核对'} · {row.reasons.map(r=>`${r.topic}（${r.kind==='recorded_need'?'已记录需求':'背调相关'}）`).join('、')}</p><p className="text-sm mt-2">{row.text.slice(0,240)}</p></div>)}{!result.matches.length&&<p>暂无可靠匹配。系统不会用不相关内容凑数。</p>}{!!result.gaps.length&&<p className="text-sm">可补充的内容主题：{result.gaps.map(g=>g.topic).join('、')}</p>}</>}</section>
}
