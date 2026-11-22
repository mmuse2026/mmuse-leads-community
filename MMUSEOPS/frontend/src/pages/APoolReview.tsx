import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getAllItems, loadFromDisk, saveItem } from '../store/db'
import { API_BASE } from '../services/config'
import { presentStatus } from '../services/presentation'
import { getLatestPendingDraft } from '../services/persistedDraft'
import { appendDraftVersion } from '../services/persistedDraft'
import { updatePersistedDraft } from '../services/draftLookup'
import { canSendFormalOutreach } from '../services/formalSendGate'
import { generateDraft } from '../data/emailGenerator'
import { suggestedSubject } from '../services/aPoolSubject'
import { buildEmailCandidateRows } from '../services/emailCandidateView'
import type { PipelineItem } from '../types/item'

type FilterKey = 'all' | 'has_draft' | 'no_draft' | 'confirmed' | 'paused' | 'excluded' | 'replaced' | 'bounced'

const FILTER_LABELS: Array<[FilterKey, string]> = [
  ['all', '全部'],
  ['has_draft', '已生成草稿'],
  ['no_draft', '未生成草稿'],
  ['confirmed', '已人工确认'],
  ['paused', '已暂缓'],
  ['excluded', '已标记不开发'],
  ['replaced', '已标记换联系人'],
  ['bounced', '已退信'],
]

interface Notice { tone: 'ok' | 'err' | 'warn'; text: string }

/** 实时派生展示字段（替代 08-01 A_POOL_META 快照；全部从当前 item 取，不写数据） */
function metaFromItem(item: PipelineItem) {
  const any = item as PipelineItem & Record<string, unknown>
  const selectedEmail = String(any?.selectedEmail || any?.email || '').trim().toLowerCase()
  const candidate = buildEmailCandidateRows(item).find(r => r.normalizedEmail === selectedEmail)
  return {
    company: item.company || item.title || '未命名客户',
    country: item.country || '',
    email: selectedEmail,
    emailType: candidate?.emailType || 'unknown',
    bm: String(any?.businessMatch || 'unknown'),
    cv: String(any?.importCommercialValue || 'unknown'),
    recommendedAction: String(any?.nextRequiredAction || any?.stageEvidenceSummary || 'manual_confirmation_required'),
    testStatus: '',
    observationEndsAt: '',
    top30Rank: null as number | null,
  }
}

/** 把 pool 邮箱补齐到客户记录（selectedEmail + contacts），返回新对象；不 mutate 原 item */
function ensureSelectedContact(item: PipelineItem): PipelineItem {
  const email = String((item as any).selectedEmail || item.email || '').trim().toLowerCase()
  if (!email) return item
  const contacts = Array.isArray((item as any).contacts) ? [...(item as any).contacts] : []
  if (!contacts.some((c: any) => String(c?.email || '').toLowerCase() === email)) {
    contacts.push({ email, source: 'current', sourceUrl: item.website || undefined })
  }
  return { ...item, selectedEmail: item.selectedEmail || email, email: item.email || email, contacts } as PipelineItem
}

/** 计算该客户针对已选邮箱的展示用 gate（不写入数据） */
function gateFor(item: PipelineItem) {
  try {
    const prepared = ensureSelectedContact(item)
    const draft = getLatestPendingDraft(prepared)
    return canSendFormalOutreach({ item: prepared, draft, now: new Date() })
  } catch {
    return { canSend: false, blockers: [], warnings: [], recommendedAction: 'manual_confirmation_required' }
  }
}

function isBounced(item: PipelineItem): boolean {
  return (item as any).emailBounced === true
}

function emailTypeTone(emailType: string): string {
  const t = String(emailType || '').toLowerCase()
  if (t === 'public') return 'bg-red-50 text-red-700 border-red-200'
  if (t === 'guessed') return 'bg-amber-50 text-amber-700 border-amber-200'
  return 'bg-blue-50 text-blue-700 border-blue-200'
}

function testStatusTone(testStatus: string): string {
  const t = String(testStatus || '').toLowerCase()
  if (/bounce/.test(t)) return 'bg-red-50 text-red-700 border-red-200'
  if (/watching|test_sent|sent/.test(t)) return 'bg-amber-50 text-amber-700 border-amber-200'
  if (/delivered|dns_mx_ok/.test(t)) return 'bg-emerald-50 text-emerald-700 border-emerald-200'
  return 'bg-surface-100 text-surface-600 border-surface-200'
}

export default function APoolReview() {
  const navigate = useNavigate()
  const [items, setItems] = useState<PipelineItem[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<FilterKey>('all')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busyId, setBusyId] = useState('')
  const [editingId, setEditingId] = useState('')
  const [editSubject, setEditSubject] = useState('')
  const [editBody, setEditBody] = useState('')

  async function reload() {
    setLoading(true)
    await loadFromDisk().catch(() => 0)
    setItems(await getAllItems())
    setLoading(false)
  }

  useEffect(() => { void reload() }, [])

  // 后台同步完成后自动刷新：避免冷启动从 IndexedDB 读到未写全的部分数据后停在旧值
  useEffect(() => {
    const handler = () => {
      void (async () => {
        await loadFromDisk().catch(() => 0)
        setItems(await getAllItems())
      })()
    }
    window.addEventListener('mmuse:sync-done', handler)
    return () => window.removeEventListener('mmuse:sync-done', handler)
  }, [])

  const rows = useMemo(() => items
    .filter(item => {
      const stage = String((item as any)?.primaryStage || (item as any)?.normalizedStage || (item as any)?.operationalTier || '')
      return stage === 'pending_draft_review' && (item as any)?.emailBounced !== true
    })
    .map(item => {
      const draft = getLatestPendingDraft(item)
      const gate = gateFor(item)
      return {
        id: item.id,
        item,
        meta: metaFromItem(item),
        draft,
        gate,
        confirmed: Boolean(draft?.manualRiskConfirmed),
        paused: item.reviewDisposition === 'paused',
        excluded: Boolean(item.doNotDevelop || item.reviewDisposition === 'do_not_develop'),
        replaced: (item as any)?.currentEmailUseBlocked === true,
        bounced: (item as any)?.emailBounced === true,
      }
    }), [items])

  const filtered = useMemo(() => rows.filter(row => {
    if (filter === 'bounced') return row.bounced
    // 铁律：非退信维度一律隐藏已退信客户，退信客户只在「已退信」筛选中可见
    if (row.bounced) return false
    switch (filter) {
      case 'has_draft': return Boolean(row.draft)
      case 'no_draft': return !row.draft
      case 'confirmed': return row.confirmed
      case 'paused': return row.paused
      case 'excluded': return row.excluded
      case 'replaced': return row.replaced
      default: return true
    }
  }), [rows, filter])

  function noticeOf(tone: Notice['tone'], text: string) {
    setNotice({ tone, text })
  }

  async function runBusy(id: string, action: () => Promise<void>) {
    if (busyId) return
    setBusyId(id)
    try {
      await action()
      await reload()
    } catch (error) {
      noticeOf('err', `操作失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusyId('')
    }
  }

  async function generateDraftFor(id: string) {
    const row = rows.find(r => r.id === id)
    if (!row || !row.item) return
    await runBusy(id, async () => {
      const prepared = ensureSelectedContact(row.item!)
      const generated = generateDraft(prepared)
      const now = new Date().toISOString()
      const drafts = appendDraftVersion(prepared, { subject: generated.subject, body: generated.body, to: generated.to }, undefined, now)
      const updated = { ...prepared, manualEmailDrafts: drafts, selectedEmail: prepared.selectedEmail, updatedAt: now }
      await saveItem(updated)
      const fresh = getLatestPendingDraft({ ...updated, manualEmailDrafts: drafts } as any)
      if (fresh) {
        setEditingId(id)
        setEditSubject(fresh.subject)
        setEditBody(fresh.body)
      }
      noticeOf('ok', '草稿已生成，可在下方修改主题与正文后保存。')
    })
  }

  async function saveEditedDraft(id: string) {
    const row = rows.find(r => r.id === id)
    if (!row || !row.item || !row.draft) return
    await runBusy(id, async () => {
      const now = new Date().toISOString()
      const updated = updatePersistedDraft(row.item!, row.draft!.id, draft => ({
        ...draft,
        subject: editSubject,
        body: editBody,
        updatedAt: now,
      }))
      await saveItem(updated)
      setEditingId('')
      noticeOf('ok', '草稿已保存修改。')
    })
  }

  async function confirmManually(id: string) {
    const row = rows.find(r => r.id === id)
    if (!row || !row.item || !row.draft) { noticeOf('warn', '请先生成开发信草稿，再执行人工确认。'); return }
    await runBusy(id, async () => {
      const now = new Date().toISOString()
      const updated = updatePersistedDraft(row.item!, row.draft!.id, draft => ({
        ...draft,
        manualRiskConfirmed: true,
        manualRiskConfirmedAt: now,
        riskTier: draft.riskTier || 'A',
        updatedAt: now,
      }))
      await saveItem(updated)
      noticeOf('ok', '已人工确认。确认后才允许加入正式发送队列。')
    })
  }

  async function operatorSession(): Promise<{ operatorToken: string; csrfToken: string }> {
    const response = await fetch(`${API_BASE}/api/formal-send-queue/operator-session`, { signal: AbortSignal.timeout(15000) })
    const payload = await response.json()
    if (!response.ok) throw new Error(String(payload.code || 'LOCAL_OPERATOR_AUTH_REQUIRED'))
    return payload
  }

  async function addToFormalQueue(id: string) {
    const row = rows.find(r => r.id === id)
    if (!row || !row.item || !row.draft) { noticeOf('warn', '请先生成开发信草稿。'); return }
    if (!row.draft.manualRiskConfirmed) { noticeOf('warn', '必须先执行「人工确认」，绝不自动入队。'); return }
    if (!row.gate?.canSend) {
      const blocked = (row.gate?.blockers || []).map(v => presentStatus(v).label).join('、')
      noticeOf('warn', `门禁未放行，不能加入正式发送队列：${blocked || '未知阻断'}`)
      return
    }
    if (!window.confirm('确认将该客户加入正式发送队列？加入后仅排程，绝不自动发送。')) return
    await runBusy(id, async () => {
      const session = await operatorSession()
      const response = await fetch(`${API_BASE}/api/formal-send-queue/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-MMUSE-Operator': session.operatorToken, 'X-MMUSE-CSRF': session.csrfToken },
        body: JSON.stringify({ customerId: id, draftId: row.draft!.id }),
        signal: AbortSignal.timeout(20000),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(String(payload.code || 'APPROVE_FAILED'))
      noticeOf('ok', `已加入正式发送队列（${payload.record?.sendQueueStatus || 'approved_for_sending'}）。autoSend=false，不会自动发送。`)
    })
  }

  async function snooze(id: string) {
    const row = rows.find(r => r.id === id)
    if (!row || !row.item) return
    await runBusy(id, async () => {
      const now = new Date().toISOString()
      const updated = {
        ...row.item!,
        reviewDisposition: 'paused' as const,
        reviewReason: 'A池人工暂缓',
        reviewUpdatedAt: now,
        timeline: [...(Array.isArray(row.item!.timeline) ? row.item!.timeline : []), { stageId: 'paused_review_queue', enteredAt: now, note: 'a_pool_manual_snooze' }],
        updatedAt: now,
      } as PipelineItem
      await saveItem(updated)
      noticeOf('ok', '已标记暂缓。可稍后在 A 池内继续处理。')
    })
  }

  async function replaceContact(id: string) {
    const row = rows.find(r => r.id === id)
    if (!row || !row.item) return
    await runBusy(id, async () => {
      const now = new Date().toISOString()
      const log = Array.isArray((row.item as any).contactReplacementLog) ? [...(row.item as any).contactReplacementLog] : []
      log.push({ at: now, reason: 'A池人工标记换联系人', email: (row.item as any)?.selectedEmail || (row.item as any)?.email })
      const updated = {
        ...row.item!,
        currentEmailUseBlocked: true,
        reviewReason: 'A池人工标记换联系人',
        reviewUpdatedAt: now,
        contactReplacementLog: log,
        updatedAt: now,
      } as PipelineItem
      await saveItem(updated)
      noticeOf('ok', '已标记换联系人；该邮箱后续不作为正式发送目标。')
    })
  }

  async function markExcluded(id: string) {
    const row = rows.find(r => r.id === id)
    if (!row || !row.item) return
    if (!window.confirm(`确认将 ${row.item.company} 标记为「不开发」？原记录保留，不再进入自动流程。`)) return
    await runBusy(id, async () => {
      const now = new Date().toISOString()
      const updated = {
        ...row.item!,
        reviewDisposition: 'do_not_develop' as const,
        reviewReason: 'A池人工标记不开发',
        reviewUpdatedAt: now,
        doNotDevelop: true,
        excludedAt: now,
        status: 'archived' as const,
        developmentStatus: 'shelved' as const,
        updatedAt: now,
      } as PipelineItem
      await saveItem(updated)
      noticeOf('ok', '已标记不开发，原记录已保留。')
    })
  }

  const confirmedCount = rows.filter(r => r.confirmed).length
  const draftedCount = rows.filter(r => r.draft).length

  return (
    <div className="h-full min-h-0 overflow-hidden bg-surface-50">
      <div className="mx-auto flex h-full max-w-[1500px] min-h-0 flex-col px-4 py-4 md:px-6">
        <div className="mb-4 flex shrink-0 flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-surface-900">开发信审核</h1>
            <p className="mt-1 text-xs text-surface-500">{loading ? '正在读取' : `${rows.length} 位客户`} · {confirmedCount} 位已确认 · {draftedCount} 份草稿</p>
          </div>
          <button onClick={() => void reload()} className="shrink-0 rounded-lg border border-surface-200 bg-white px-3 py-2 text-xs font-semibold text-surface-700 hover:bg-surface-50">刷新数据</button>
        </div>

        <div className="mb-3 flex shrink-0 flex-wrap items-center gap-2 border-y border-surface-200 bg-white px-3 py-2">
          <select value={filter} onChange={event => setFilter(event.target.value as typeof filter)} className="rounded-lg border border-surface-200 bg-white px-3 py-2 text-xs text-surface-700">{FILTER_LABELS.map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select>
          <span className="ml-auto text-xs text-surface-500">当前 {filtered.length} / {rows.length} 条</span>
        </div>

        {notice && (
          <div className={`mb-3 shrink-0 rounded-lg border px-3 py-2 text-xs ${notice.tone === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : notice.tone === 'err' ? 'border-red-200 bg-red-50 text-red-700' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
            {notice.text}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto space-y-3">
          {loading ? <div className="p-10 text-center text-sm text-surface-400">加载中...</div> : filtered.length === 0 ? <div className="p-10 text-center text-sm text-surface-400">当前筛选下没有 A 池客户</div> : filtered.map(row => {
            const { item, meta, draft, gate } = row
            const editing = editingId === row.id
            return (
              <details key={row.id} className="rounded-xl border border-surface-200 bg-white p-4">
                <summary className="flex cursor-pointer list-none flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-base font-semibold text-surface-900">{meta.company}</h2>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-surface-500">
                      <span>{meta.country || item?.country || '-'}</span>
                      <span>·</span>
                      <span>客户类型 {presentStatus(item?.clientType || (item as any)?.customerType || (item as any)?.category || 'unknown').label}</span>
                      <span>·</span>
                      <span>匹配 {presentStatus((item as any)?.businessMatch || meta.bm || 'unknown').label}</span>
                      <span>·</span>
                      <span>价值 {presentStatus((item as any)?.importCommercialValue || meta.cv || 'unknown').label}</span>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    {row.confirmed && <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">已人工确认</span>}
                    {row.paused && <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">已暂缓</span>}
                    {row.excluded && <span className="rounded bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold text-red-700">已标记不开发</span>}
                    {row.replaced && <span className="rounded bg-orange-50 px-1.5 py-0.5 text-[10px] font-semibold text-orange-700">已标记换联系人</span>}
                    {row.bounced && <span className="rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">已退信</span>}
                  </div>
                </summary>

                <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
                  <div className="rounded border border-surface-200 bg-surface-50 p-2">
                    <p className="text-surface-400">官网</p>
                    {item?.website ? <a href={item.website.startsWith('http') ? item.website : `https://${item.website}`} target="_blank" rel="noreferrer" className="mt-0.5 block truncate text-blue-700 underline">{item.website}</a> : <p className="mt-0.5 text-surface-500">-</p>}
                  </div>
                  <div className="rounded border border-surface-200 bg-surface-50 p-2">
                    <p className="text-surface-400">联系人 / 邮箱</p>
                    <p className="mt-0.5 break-all font-semibold text-surface-800">{meta.email || item?.email || '-'}</p>
                    <p className="mt-0.5 text-surface-500">{item?.contactName || '-'}</p>
                  </div>
                  <div className="rounded border border-surface-200 bg-surface-50 p-2">
                    <p className="text-surface-400">邮箱类型</p>
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      <span className={`rounded border px-1.5 py-0.5 text-[10px] ${emailTypeTone(meta.emailType)}`}>{presentStatus(meta.emailType).label}</span>
                    </div>
                  </div>
                </div>

                <div className="mt-2 grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
                  <div className="rounded border border-surface-200 bg-surface-50 p-2">
                    <p className="text-surface-400">推荐开发角度</p>
                    <p className="mt-0.5 text-surface-800">{meta.recommendedAction || presentStatus(gate?.recommendedAction || 'manual_review').label}</p>
                  </div>
                  <div className="rounded border border-surface-200 bg-surface-50 p-2">
                    <p className="text-surface-400">建议主题（参考）</p>
                    <button type="button" title="点击复制" onClick={() => navigator.clipboard?.writeText(suggestedSubject(meta.company, meta.country))} className="mt-0.5 block w-full truncate text-left text-blue-700 underline">{suggestedSubject(meta.company, meta.country)}</button>
                  </div>
                  <div className="rounded border border-amber-200 bg-amber-50 p-2">
                    <p className="text-amber-700">门禁 warning（不阻断）</p>
                    <p className="mt-0.5 text-amber-800">{(gate?.warnings || []).slice(0, 4).map(v => presentStatus(v).label).join('；') || '无'}</p>
                  </div>
                  <div className="rounded border border-surface-200 bg-surface-50 p-2">
                    <p className="text-surface-400">草稿</p>
                    <p className="mt-0.5 text-surface-800">{draft ? `${draft.subject}` : '未生成'}</p>
                  </div>
                </div>

                {gate && gate.blockers.length > 0 && (
                  <div className="mt-2 rounded border border-red-200 bg-red-50 px-2 py-1 text-[11px] text-red-700">
                    硬阻断：{gate.blockers.map(v => presentStatus(v).label).join('、')}
                  </div>
                )}

                {editing && draft && (
                  <div className="mt-3 space-y-2 rounded-lg border border-blue-200 bg-blue-50 p-3">
                    <label className="block text-[11px] font-semibold text-blue-900">主题（可编辑）</label>
                    <input value={editSubject} onChange={e => setEditSubject(e.target.value)} className="w-full rounded border border-blue-200 bg-white px-3 py-2 text-xs" />
                    <label className="block text-[11px] font-semibold text-blue-900">正文（可编辑）</label>
                    <textarea value={editBody} onChange={e => setEditBody(e.target.value)} rows={8} className="w-full rounded border border-blue-200 bg-white px-3 py-2 text-xs resize-y" />
                    <div className="flex gap-2">
                      <button type="button" onClick={() => void saveEditedDraft(row.id)} disabled={busyId === row.id} className="rounded bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40">保存修改</button>
                      <button type="button" onClick={() => setEditingId('')} className="rounded border border-blue-300 bg-white px-3 py-1.5 text-xs text-blue-700">取消</button>
                    </div>
                  </div>
                )}

                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" onClick={() => navigate(`/item/${row.id}`)} className="rounded border border-surface-300 bg-white px-2.5 py-1.5 text-xs text-surface-700 hover:bg-surface-50">查看详情</button>
                  <button type="button" onClick={() => void generateDraftFor(row.id)} disabled={busyId === row.id || Boolean(draft)} className="rounded bg-indigo-600 px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-40">{draft ? '已生成草稿' : '生成开发信草稿'}</button>
                  {draft && <button type="button" onClick={() => { setEditingId(editing ? '' : row.id); setEditSubject(draft.subject); setEditBody(draft.body) }} className="rounded border border-indigo-300 bg-white px-2.5 py-1.5 text-xs text-indigo-700">修改草稿</button>}
                  <button type="button" onClick={() => void confirmManually(row.id)} disabled={busyId === row.id || row.confirmed || !draft} className={`rounded px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-40 ${row.confirmed ? 'bg-emerald-600' : 'bg-emerald-600'}`}>{row.confirmed ? '已人工确认' : '人工确认'}</button>
                  <button type="button" onClick={() => void addToFormalQueue(row.id)} disabled={busyId === row.id || !row.confirmed || !gate?.canSend} title={row.confirmed && gate?.canSend ? '确认后加入正式发送队列（仅排程，不自动发送）' : '需先人工确认且门禁放行'} className="rounded bg-blue-700 px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-40">加入正式发送队列</button>
                  <button type="button" onClick={() => void snooze(row.id)} disabled={busyId === row.id || row.paused} className="rounded border border-amber-300 bg-white px-2.5 py-1.5 text-xs text-amber-700">{row.paused ? '已暂缓' : '暂缓'}</button>
                  <button type="button" onClick={() => void replaceContact(row.id)} disabled={busyId === row.id || row.replaced} className="rounded border border-orange-300 bg-white px-2.5 py-1.5 text-xs text-orange-700">{row.replaced ? '已标记换联系人' : '换联系人'}</button>
                  <button type="button" onClick={() => void markExcluded(row.id)} disabled={busyId === row.id || row.excluded} className="rounded bg-red-600 px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-40">{row.excluded ? '已标记不开发' : '标记不开发'}</button>
                </div>
              </details>
            )
          })}
        </div>
      </div>
    </div>
  )
}
