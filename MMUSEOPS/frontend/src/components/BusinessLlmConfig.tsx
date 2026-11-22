import { useEffect, useRef, useState } from 'react'
import { API_BASE } from '../services/config'

type Line = 'furniture' | 'carseat' | 'knitwear'
type Config = { mode: 'disabled' | 'own' | 'shared'; base_url: string; model: string; shared_ref: string; configured: boolean }
type Snapshot = { revision: number; businesses: Record<Line, Config>; active: boolean }
const labels: Record<Line, string> = { furniture: '家具', carseat: '汽车座椅套', knitwear: '羊毛衫' }

export default function BusinessLlmConfig({ line }: { line: Line }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [form, setForm] = useState<Config | null>(null)
  const [secret, setSecret] = useState('')
  const [clear, setClear] = useState(false)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [reloadVersion, setReloadVersion] = useState(0)
  const previousLine = useRef(line)
  useEffect(() => {
    let cancelled = false
    setSnapshot(null); setForm(null); setNotice('')
    if (previousLine.current !== line) { setSecret(''); setClear(false); previousLine.current = line }
    fetch(`${API_BASE}/api/business-llm-config`).then(async response => {
      if (!response.ok) throw new Error('unavailable')
      const data = await response.json() as Snapshot
      if (!data.businesses?.[line]) throw new Error('invalid')
      if (!cancelled) { setSnapshot(data); setForm(data.businesses[line]) }
    }).catch(() => { if (!cancelled) setNotice('业务配置暂不可用') })
    return () => { cancelled = true }
  }, [line, reloadVersion])
  async function save() {
    if (!snapshot || !form) return
    setBusy(true); setNotice('')
    try {
      const authResponse = await fetch(`${API_BASE}/api/formal-send-queue/operator-session`)
      if (!authResponse.ok) throw new Error('auth')
      const auth = await authResponse.json()
      const secret_action = form.mode === 'own' ? (clear ? 'clear' : secret ? 'replace' : 'keep') : 'keep'
      const response = await fetch(`${API_BASE}/api/business-llm-config`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MMUSE-Operator': auth.operatorToken, 'X-MMUSE-CSRF': auth.csrfToken },
        body: JSON.stringify({ revision: snapshot.revision, business_id: line, mode: form.mode, base_url: form.base_url, model: form.model, shared_ref: form.shared_ref, secret_action, ...(secret_action === 'replace' ? { secret } : {}) }),
      })
      if (!response.ok) {
        const result = await response.json().catch(() => ({}))
        if (response.status === 409 || result.code === 'CONFIG_CONFLICT') throw new Error('conflict')
        throw new Error('save')
      }
      const data = await response.json() as Snapshot
      setSnapshot(data); setForm(data.businesses[line]); setSecret(''); setClear(false); setNotice('已保存配置。执行器尚未接入。')
    } catch (error) { setNotice(error instanceof Error && error.message === 'conflict' ? '配置已被更新，请刷新配置后重新检查并保存。' : '保存失败，请刷新配置后重试。') }
    finally { setBusy(false) }
  }
  return <section className="mb-5 rounded-2xl border border-black/[0.06] bg-white p-5" aria-label="业务执行API配置">
    <div className="flex items-center justify-between gap-3"><h2 className="text-base font-semibold">{labels[line]} · 执行 API 配置</h2><button type="button" disabled={busy} onClick={() => setReloadVersion(value => value + 1)} className="directory-control-button">刷新配置</button></div>
    <p className="mt-1 text-xs text-surface-500">仅配置当前业务。已保存不代表执行器已接入，也不会自动测试或启动任务。</p>
    {snapshot && <p className="mt-1 text-xs text-surface-500">依赖此业务配置的其他业务：{(Object.keys(labels) as Line[]).filter(key => key !== line && snapshot.businesses[key]?.mode === 'shared' && snapshot.businesses[key]?.shared_ref === line).map(key => labels[key]).join('、') || '无'}</p>}
    {form && <div className="mt-4 grid gap-3 md:grid-cols-2">
      <label>使用方式<select className="mt-1 block w-full rounded border p-2" value={form.mode} onChange={event => { setSecret(''); setClear(false); setForm({ ...form, mode: event.target.value as Config['mode'] }) }}><option value="disabled">停用</option><option value="own">独立配置</option><option value="shared">明确共用其他业务</option></select></label>
      {form.mode === 'shared' && <label>共用来源<select className="mt-1 block w-full rounded border p-2" value={form.shared_ref || ''} onChange={event => setForm({ ...form, shared_ref: event.target.value })}><option value="">请选择</option>{(Object.keys(labels) as Line[]).filter(key => key !== line).map(key => <option key={key} value={key}>{labels[key]}</option>)}</select></label>}
      {form.mode === 'own' && <><label>接口地址<input className="mt-1 block w-full rounded border p-2" value={form.base_url || ''} onChange={event => setForm({ ...form, base_url: event.target.value })} /></label><label>模型<input className="mt-1 block w-full rounded border p-2" value={form.model || ''} onChange={event => setForm({ ...form, model: event.target.value })} /></label><label>密钥<input type="password" autoComplete="new-password" className="mt-1 block w-full rounded border p-2" placeholder={form.configured ? '已配置，留空保持' : '输入密钥'} value={secret} disabled={clear} onChange={event => setSecret(event.target.value)} /></label><label className="flex items-center gap-2"><input type="checkbox" checked={clear} onChange={event => { setClear(event.target.checked); setSecret('') }} />清除当前业务密钥</label></>}
      <button type="button" disabled={busy} onClick={() => void save()} className="directory-control-button w-fit">{busy ? '保存中…' : '保存当前业务配置'}</button>
    </div>}
    {notice && <p role="status" className="mt-3 text-sm">{notice}</p>}
  </section>
}
