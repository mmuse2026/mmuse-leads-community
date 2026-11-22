import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { getAllItems, loadFromDisk } from '../store/db'
import BackButton from '../components/BackButton'
import PageHead from '../components/PageHead'
import SectionHead from '../components/SectionHead'
import { normalizeEmailText } from '../services/emailText'

type ReplyStage = 'replied_queue' | 'bounced_queue' | 'auto_reply_queue'

/** 各回收分栏对应的处理页跳转目标（EmailBatch 有效 tab：pending_human_review / approved / sent / bounced） */
const STAGE_TARGET: Record<ReplyStage, string> = {
  replied_queue: '/email-batch?tab=sent',
  bounced_queue: '/email-batch?tab=bounced',
  auto_reply_queue: '/email-batch?tab=sent',
}

interface ReplyRecord {
  id: string
  company: string
  email: string
  stage: ReplyStage
  badgeClass: string
  badgeLabel: string
  time: string
  summary: string
}

const STAGES: { stage: ReplyStage; title: string; badgeClass: string; badgeLabel: string; desc: string; icon: ReactNode; bar: string }[] = [
  {
    stage: 'replied_queue',
    title: '已回复',
    badgeClass: 'bg-green-50 text-green-700',
    badgeLabel: '已回复',
    desc: '客户已回信的开发信，可跟进推进',
    icon: (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M7.25 7.5 3.5 11.25m0 0 3.75 3.75M3.5 11.25h9a4.5 4.5 0 0 0 4.5-4.5v-2" />
      </svg>
    ),
    bar: 'bg-emerald-500',
  },
  {
    stage: 'bounced_queue',
    title: '已退信',
    badgeClass: 'bg-red-50 text-red-700',
    badgeLabel: '已退信',
    desc: '投递失败退回的邮件，需更换邮箱重发',
    icon: (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m0 3.75h.008v.008H12v-.008ZM9.75 3.25 4.03 15.05a1.5 1.5 0 0 0 1.35 2.2h13.24a1.5 1.5 0 0 0 1.35-2.2L12.75 3.25a1.5 1.5 0 0 0-2.7 0Z" />
      </svg>
    ),
    bar: 'bg-red-500',
  },
  {
    stage: 'auto_reply_queue',
    title: '自动回复 / OOO',
    badgeClass: 'bg-surface-100 text-surface-600',
    badgeLabel: '自动回复',
    desc: '自动回复或休假自动应答，可稍后再跟进',
    icon: (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
      </svg>
    ),
    bar: 'bg-surface-300',
  },
]

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function formatTime(raw?: unknown): string {
  if (!raw) return ''
  const t = Date.parse(String(raw))
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function lastEvidence(item: any): any {
  const arr = Array.isArray(item?.zohoReplyEvidence) ? item.zohoReplyEvidence : []
  return arr.length ? arr[arr.length - 1] : undefined
}

function stageOf(item: any): ReplyStage | null {
  const stage = String(item?.replyQueue || item?.normalizedStage || '')
  if (stage === 'replied_queue' || stage === 'bounced_queue' || stage === 'auto_reply_queue') return stage
  return null
}

function targetFor(record: ReplyRecord): string {
  return record.stage === 'replied_queue' ? '/item/' + encodeURIComponent(record.id) + '?section=communication' : STAGE_TARGET[record.stage]
}

function summaryFor(ev: any): string {
  const raw = normalizeEmailText(ev?.textSummary || ev?.fullBody || '').trim()
  if (!raw) return '无内容摘要'
  return raw.length > 120 ? `${raw.slice(0, 120)}…` : raw
}

function buildRecord(item: any, meta: (typeof STAGES)[number]): ReplyRecord {
  const ev = lastEvidence(item)
  const rawTime = ev?.date || item?.replyObservedAt || item?.receivedAt
  return {
    id: String(item?.id || `${item?.company}-${item?.selectedEmail || ''}`),
    company: String(item?.company || item?.title || '未命名客户'),
    email: String(item?.selectedEmail || ev?.fromMasked || '邮箱未知'),
    stage: meta.stage,
    badgeClass: meta.badgeClass,
    badgeLabel: meta.badgeLabel,
    time: formatTime(rawTime) || '时间未知',
    summary: summaryFor(ev),
  }
}

export default function Replies() {
  const navigate = useNavigate()
  const [records, setRecords] = useState<ReplyRecord[]>([])
  const [loading, setLoading] = useState(true)

  async function reload() {
    setLoading(true)
    try {
      await loadFromDisk().catch(() => 0)
      const items = await getAllItems()
      const next: ReplyRecord[] = []
      for (const raw of items) {
        const item = raw as any
        const stage = stageOf(item)
        if (!stage) continue
        const meta = STAGES.find(s => s.stage === stage)!
        next.push(buildRecord(item, meta))
      }
      next.sort((a, b) => {
        if (a.time === '时间未知') return 1
        if (b.time === '时间未知') return -1
        return a.time < b.time ? 1 : -1
      })
      setRecords(next)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void reload() }, [])

  if (loading) return <div className="flex h-full items-center justify-center text-sm text-surface-400">加载回信记录...</div>

  return (
    <div className="h-full overflow-y-auto bg-surface-50">
      <div className="mx-auto max-w-[1200px] p-5 lg:p-7">
        <div className="mb-3"><BackButton /></div>
        <PageHead
          eyebrow="正式开发信回收"
          title="回信 / 退信 / 自动回复 回收区"
          subtitle="查看正式开发信回复、退信与自动回复记录。"
          actions={
            <button onClick={reload} className="rounded-lg border border-surface-200 bg-white px-3 py-2 text-xs font-semibold text-surface-700 transition-colors hover:bg-surface-50">刷新</button>
          }
        />

        <div className="mt-5 space-y-4">
          {STAGES.map(meta => {
            const rows = records.filter(r => r.stage === meta.stage)
            return (
              <section key={meta.stage} className="rounded-xl border border-surface-200 bg-white p-4 shadow-panel">
                <SectionHead
                  icon={meta.icon}
                  title={meta.title}
                  subtitle={meta.desc}
                  right={
                    <span className="inline-flex h-6 items-center rounded-full bg-accent-50 px-2.5 text-xs font-medium tabular-nums text-accent-700">{rows.length} 条</span>
                  }
                />
                {rows.length ? (
                  <ul className="grid gap-2">
                    {rows.map((r, i) => (
                      <li
                        key={`${r.stage}-${r.id}-${i}`}
                        role="button"
                        tabIndex={0}
                        onClick={() => navigate(targetFor(r))}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(targetFor(r)) }
                        }}
                        title={r.stage === 'replied_queue' ? '打开客户 360 并处理回复任务' : '去对应处理页操作'}
                        className="group flex cursor-pointer items-stretch gap-2.5 rounded-lg border border-surface-200 bg-white p-3.5 shadow-panel hover:border-accent-300"
                      >
                        <span className={`w-[5px] shrink-0 rounded-full ${meta.bar}`} />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <h3 className="truncate text-sm font-semibold text-surface-900">{r.company}</h3>
                            <span className={`inline-flex h-6 shrink-0 items-center rounded-full px-2.5 text-xs font-medium ${r.badgeClass}`}>{r.badgeLabel}</span>
                            <span className="ml-auto shrink-0 whitespace-nowrap text-xs text-surface-400">{r.time}</span>
                            <span className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full border border-accent-200 bg-accent-50 px-2.5 text-xs font-medium text-accent-700">去处理 →</span>
                          </div>
                          <p className="mt-0.5 truncate text-xs text-surface-500">{r.email}</p>
                          <p className="mt-2 break-words text-sm leading-5 text-surface-600">{r.summary}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="rounded-lg bg-surface-50 px-4 py-5 text-sm text-surface-500">暂无{meta.title} · {meta.desc}</p>
                )}
              </section>
            )
          })}
        </div>
      </div>
    </div>
  )
}
