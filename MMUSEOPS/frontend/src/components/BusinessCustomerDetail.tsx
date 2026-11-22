import { useEffect, useState } from 'react'
import { API_BASE } from '../services/config'

type Line = 'furniture' | 'carseat' | 'knitwear'
type Research = {contacts:{email:string;source_url:string;observed_at:string}[];observations:{value:string;source_url:string;evidence_note:string;mx_status:string}[];coverage:{observed_at:string;result:string}[];evidence:{source_url:string;observed_at:string;finding:string}[]}
type Detail = { business_id: Line; customer_id: string; company: string; country: string; website: string; revision: number | string; editable: boolean; research?:Research }
function Source({url}:{url:string}) {
  try {const u=new URL(url);if(['http:','https:'].includes(u.protocol))return <a className="text-teal-700 underline break-all" href={url} target="_blank" rel="noopener noreferrer">{url}</a>}catch{}
  return <span className="break-all">{url}</span>
}
function observationText(value:string) {
  try {const lines=value.split('\n'),finding=JSON.parse(lines[0]);return [finding.review?.reason||finding.reason,...(Array.isArray(finding.excerpts)?finding.excerpts:[]),...lines.slice(1)].filter(Boolean).join('\n')||value}catch{return value}
}
function ResearchNotes({research}:{research:Research}) {
  const count=research.contacts.length+research.observations.length+research.evidence.length
  return <section aria-label="客户研究记录" className="mt-4 border-t pt-4 text-sm"><h4 className="font-semibold">研究资料与来源</h4><p className="my-2 text-surface-500">公开邮箱不等于采购联系人；MX不等于邮箱验证或送达。研究记录不改变开发资格。</p>
    {research.coverage.map((r,i)=><p key={i}>观察时间：{r.observed_at} · 仍需核实采购角色与联系资格</p>)}
    {!count&&<p className="my-2">暂无研究资料。</p>}
    {research.contacts.length>0&&<details open className="my-3"><summary>公开联系线索（{research.contacts.length}）</summary>{research.contacts.map((r,i)=><div className="my-2" key={i}><p>{r.email} · 角色待核</p><Source url={r.source_url}/></div>)}</details>}
    {research.observations.length>0&&<details className="my-3"><summary>联系观察与验证层级（{research.observations.length}）</summary>{research.observations.map((r,i)=><div className="my-2" key={i}><p>{r.value} · {r.mx_status==='mx_present'?'域名有MX，收件人未验证':r.mx_status==='null_mx'?'域名明确不接收邮件':'验证情况待核'}</p><p>{r.evidence_note}</p><Source url={r.source_url}/></div>)}</details>}
    {research.evidence.length>0&&<details open className="my-3"><summary>业务观察与待核事项（{research.evidence.length}）</summary>{research.evidence.map((r,i)=><div className="my-3 rounded border p-2" key={i}><p className="text-surface-500">官网观察（原文） · {r.observed_at}</p><p className="whitespace-pre-wrap break-words">{observationText(r.finding)}</p><Source url={r.source_url}/></div>)}</details>}
  </section>
}
const validRevision = (value: unknown) => Number.isSafeInteger(value) || (typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value))
export default function BusinessCustomerDetail({ line, id, close }: { line: Line; id: string; close: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [generation, setGeneration] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setDetail(null); setNotice('')
    fetch(`${API_BASE}/api/business-customer-detail?business_id=${encodeURIComponent(line)}&customer_id=${encodeURIComponent(id)}`, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('unavailable')
      const result = await response.json() as Detail
      if (result.business_id !== line || result.customer_id !== id || typeof result.editable !== 'boolean' || !validRevision(result.revision)) throw new Error('scope')
      if (!controller.signal.aborted) setDetail(result)
    }).catch(() => { if (!controller.signal.aborted) setNotice('业务客户详情暂未接通。') })
    return () => controller.abort()
  }, [line, id, generation])
  async function save() {
    if (!detail?.editable || detail.business_id !== line || detail.customer_id !== id || busy) return
    setBusy(true); setNotice('')
    try {
      const authResponse = await fetch(`${API_BASE}/api/formal-send-queue/operator-session`)
      if (!authResponse.ok) throw new Error('auth')
      const auth = await authResponse.json()
      const response = await fetch(`${API_BASE}/api/business-customer-update`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MMUSE-Operator': auth.operatorToken, 'X-MMUSE-CSRF': auth.csrfToken }, body: JSON.stringify({ business_id: line, customer_id: id, revision: detail.revision, changes: { company: detail.company, country: detail.country, website: detail.website } }) })
      if (response.status === 409) throw new Error('conflict')
      if (!response.ok) throw new Error('save')
      const result = await response.json() as Detail
      if (result.business_id !== line || result.customer_id !== id || !validRevision(result.revision)) throw new Error('scope')
      setDetail(result); setNotice('客户资料已保存。')
    } catch (error) { setNotice(error instanceof Error && error.message === 'conflict' ? '资料已被其他操作更新，请重新读取后检查。' : '保存失败，请检查后重试。') }
    finally { setBusy(false) }
  }
  return <section className="mt-4 rounded-xl border p-4" aria-label="业务客户详情"><div className="flex justify-between"><h3 className="font-semibold">客户资料</h3><button type="button" onClick={close}>关闭</button></div>
    {detail && <div className="mt-3 grid gap-3">{(['company', 'country', 'website'] as const).map(field => <label key={field}>{({ company: '公司', country: '国家', website: '网站' })[field]}<input className="mt-1 block w-full rounded border p-2" disabled={!detail.editable || busy} value={detail[field] || ''} onChange={event => setDetail({ ...detail, [field]: event.target.value })} /></label>)}
      {detail.editable ? <button className="directory-control-button w-fit" type="button" disabled={busy} onClick={() => void save()}>保存资料</button> : <p className="text-sm text-surface-500">此业务的独立编辑尚未启用。</p>}
    </div>}
    {detail?.research&&<ResearchNotes research={detail.research}/>}
    {notice && <p role="status" className="mt-3 text-sm">{notice}</p>}
    {notice.includes('重新读取') && <button type="button" disabled={busy} onClick={() => setGeneration(value => value + 1)}>重新读取</button>}
  </section>
}
