import { useRef, useState } from 'react'
import EmailBodyPreview from './EmailBodyPreview'
import { API_BASE } from '../services/config'

type Evidence = {
  messageId: string
  fromEmail?: string
  fromMasked?: string
  subject?: string
  fullBody?: string
  textSummary?: string
  classification?: string
  references?: string[]
}
type OperatorSession = { operatorToken: string; csrfToken: string; expiresAt: number }

export default function CrmReplyComposer({ customerId, company, evidence, priorAttempts, onSent }: {
  customerId: string
  company: string
  evidence: Evidence
  priorAttempts: any[]
  onSent: () => Promise<void> | void
}) {
  const session = useRef<OperatorSession>()
  const [subject, setSubject] = useState(/^re:/i.test(String(evidence.subject || '').trim()) ? String(evidence.subject || '').trim() : `Re: ${String(evidence.subject || '').trim()}`)
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [drafting, setDrafting] = useState(false)
  const [translating, setTranslating] = useState(false)
  const [notice, setNotice] = useState('')
  const [translation, setTranslation] = useState<{ subjectCn: string; bodyCn: string } | null>(null)
  const attempt = priorAttempts.find(value => value?.sourceMessageId === evidence.messageId)
  const contextAvailable = Boolean(String(evidence.fullBody || evidence.textSummary || '').trim())

  async function getSession() {
    if (session.current && session.current.expiresAt > Date.now() + 5000) return session.current
    const response = await fetch(`${API_BASE}/api/formal-send-queue/operator-session`)
    const value = await response.json()
    if (!response.ok) throw new Error(String(value.code || 'LOCAL_OPERATOR_AUTH_REQUIRED'))
    session.current = value
    return value as OperatorSession
  }

  async function send() {
    if (!evidence.fromEmail || !subject.trim() || !body.trim() || busy || attempt) return
    setBusy(true)
    setNotice('')
    try {
      const auth = await getSession()
      const response = await fetch(`${API_BASE}/api/formal-send-queue/send-crm-reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-MMUSE-Operator': auth.operatorToken, 'X-MMUSE-CSRF': auth.csrfToken },
        body: JSON.stringify({ customerId, replyMessageId: evidence.messageId, to: evidence.fromEmail, subject: subject.trim(), body: body.trim(), confirmSend: true }),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(String(result.code || response.statusText))
      setNotice(`已发送并写入客户时间线 · Zoho Message-ID: ${String(result.messageId || '未返回')}`)
      await Promise.resolve(onSent()).catch(() => undefined)
    } catch (error) {
      const message = String(error)
      setNotice(message.includes('CRM_REPLY_STALE_SOURCE') ? '检测到这封之后有更新的客户回信；请先检查最新来信，再决定回复。' : message.includes('CRM_REPLY_SOURCE_BODY_MISSING') ? '尚无可核对的客户原文，未发送。' : message.includes('CRM_REPLY_RECIPIENT_MISMATCH') ? '收件地址与原始来信发件地址不一致，未发送。' : message.includes('CRM_REPLY_ALREADY_SENT') ? '这封来信已有已发送回复记录，已阻止重复发送。' : message.includes('CRM_REPLY_RECONCILIATION_REQUIRED') || message.includes('CRM_REPLY_SEND_UNCERTAIN') ? '发送结果不确定，已锁定避免重复发送；请先核对邮箱和服务商记录。' : `发送未完成：${message}`)
    } finally { setBusy(false) }
  }

  async function draftWithAi() {
    if (drafting || busy || attempt || !contextAvailable) return
    setDrafting(true)
    setNotice('')
    try {
      const auth = await getSession()
      const response = await fetch(`${API_BASE}/api/formal-send-queue/reply-draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-MMUSE-Operator': auth.operatorToken, 'X-MMUSE-CSRF': auth.csrfToken },
        body: JSON.stringify({ customerId, replyMessageId: evidence.messageId }),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(String(result.code || response.statusText))
      if (String(result.to || '').toLowerCase() !== String(evidence.fromEmail || '').toLowerCase()) throw new Error('CRM_REPLY_RECIPIENT_MISMATCH')
      setSubject(String(result.subject || ''))
      setBody(String(result.body || ''))
      setNotice('已根据客户档案和这封来信生成草稿；尚未发送。请检查并可直接修改。')
    } catch (error) {
      const message = String(error)
      setNotice(message.includes('CRM_REPLY_STALE_SOURCE') ? '已有更新的客户回信，请改为处理最新来信。' : message.includes('CRM_REPLY_SOURCE_BODY_MISSING') ? '没有可供起草的来信正文，未生成。' : message.includes('CRM_REPLY_RECIPIENT_UNVERIFIED') ? '原信发件地址未核实，无法生成可发送回复。' : 'AI 起草暂不可用；没有发送邮件，也没有替换成通用模板。')
    } finally { setDrafting(false) }
  }

  async function translateOriginal() {
    if (translating || !contextAvailable) return
    setTranslating(true)
    setNotice('')
    try {
      const auth = await getSession()
      const response = await fetch(`${API_BASE}/api/formal-send-queue/reply-translation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-MMUSE-Operator': auth.operatorToken, 'X-MMUSE-CSRF': auth.csrfToken },
        body: JSON.stringify({ customerId, replyMessageId: evidence.messageId }),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(String(result.code || response.statusText))
      setTranslation({ subjectCn: String(result.subjectCn || ''), bodyCn: String(result.bodyCn || '') })
    } catch {
      setNotice('翻译暂时不可用；原文和发送内容均未改变。')
    } finally { setTranslating(false) }
  }

  return <section className="mt-3 rounded-lg border border-surface-200 bg-white p-4" data-reply-message-id={evidence.messageId}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><h3 className="text-sm font-semibold text-surface-800">客户来信 · {evidence.fromEmail || evidence.fromMasked || '发件人未核实'}</h3><p className="mt-0.5 text-xs text-surface-500">{evidence.subject || '无主题'}</p></div>
      <div className="flex items-center gap-2">{contextAvailable && <button type="button" onClick={translateOriginal} disabled={translating} className="rounded border border-emerald-300 px-3 py-1.5 text-xs font-semibold text-emerald-800 disabled:opacity-40">{translating ? '翻译中…' : translation ? '重新翻译' : '翻译成中文'}</button>}{attempt && <span className={`rounded px-2 py-1 text-xs ${attempt.status === 'sent' ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-800'}`}>{attempt.status === 'sent' ? `已发送 ${attempt.messageId || ''}` : '发送状态待核实，已防止重发'}</span>}</div>
    </div>
    <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-surface-50 p-3 font-sans text-sm leading-6 text-surface-700">{evidence.fullBody || evidence.textSummary || '此旧记录未保存来信正文，请在邮箱中核实完整内容。'}</pre>
    {translation && <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3"><p className="text-xs font-semibold text-emerald-800">客户来信中文翻译 · 仅供理解，不会作为发送正文</p><p className="mt-2 text-sm font-semibold text-emerald-950">{translation.subjectCn}</p><pre className="mt-2 whitespace-pre-wrap font-sans text-sm leading-6 text-emerald-950">{translation.bodyCn}</pre></div>}
    {evidence.fromEmail && contextAvailable ? <div className="mt-4 space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <label className="block min-w-[240px] flex-1 text-xs font-medium text-surface-600">回复主题<input value={subject} onChange={event => setSubject(event.target.value)} maxLength={500} disabled={busy || drafting || Boolean(attempt)} className="mt-1 w-full rounded border border-surface-300 p-2 text-sm" /></label>
        <button type="button" onClick={draftWithAi} disabled={busy || drafting || Boolean(attempt) || !contextAvailable} className="rounded-lg border border-blue-300 px-4 py-2 text-sm font-semibold text-blue-800 disabled:opacity-40">{drafting ? '正在结合客户上下文起草…' : 'AI 帮我起草回复'}</button>
      </div>
      <label className="block text-xs font-medium text-surface-600">回复正文<textarea value={body} onChange={event => setBody(event.target.value)} rows={7} maxLength={20000} disabled={busy || drafting || Boolean(attempt)} placeholder="可由 AI 按客户档案和来信起草，也可自行编辑；发送前检查下方预览。" className="mt-1 w-full rounded border border-surface-300 p-2 text-sm leading-6" /></label>
      {body.trim() && <div className="rounded border border-surface-100 bg-surface-50 p-3"><p className="text-xs font-semibold text-surface-500">发送预览（含官方签名）</p><EmailBodyPreview body={body} /></div>}
      <button type="button" onClick={send} disabled={busy || Boolean(attempt) || !subject.trim() || !body.trim()} className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40">{busy ? '正在通过 Zoho 发送…' : '审核无误，发送回复'}</button>
    </div> : <p className="mt-3 rounded bg-amber-50 p-3 text-xs text-amber-900">{!evidence.fromEmail ? '这封历史来信没有保存精确发件地址。为避免回复错人，当前不能一键发送；后续同步会自动保存该字段。' : '尚未取回这封邮件的实际正文；为确保回复结合客户原话，当前不能发送。'}</p>}
    {notice && <p role="status" className="mt-3 break-words rounded bg-surface-50 p-3 text-xs text-surface-700">{notice}</p>}
  </section>
}
