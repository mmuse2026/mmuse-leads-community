import { buildOutboundEmail, isSentDraft } from '../services/emailSignature'

export default function EmailBodyPreview({ body, draft, language = 'en' }: { body: string; draft?: any; language?: 'en' | 'cn' }) {
  if (isSentDraft(draft)) return <pre className="mt-3 whitespace-pre-wrap font-sans text-sm leading-6">{body}</pre>
  try {
    return <div className="mt-3" dangerouslySetInnerHTML={{ __html: buildOutboundEmail(body, language).html }} />
  } catch {
    return <div><p className="mt-3 text-sm text-red-700">签名或联系方式需要审核，请检查正文后再发送。</p><pre className="mt-3 whitespace-pre-wrap font-sans text-sm leading-6">{body}</pre></div>
  }
}
