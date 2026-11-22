import { useState } from 'react'
import type { SearchCompany, SearchProgress } from '../../services/searchService'
import type { BackcheckStatus } from '../../pages/SearchWorkbench'

function tagStyle(tag: string): string {
  switch (tag) {
    case '渠道': return 'bg-green-50 text-green-700 border-green-200'
    case '相关': return 'bg-blue-50 text-blue-700 border-blue-200'
    case '待定': return 'bg-amber-50 text-amber-700 border-amber-200'
    case '同行': return 'bg-orange-50 text-orange-700 border-orange-200'
    default: return 'bg-surface-50 text-surface-500 border-surface-200'
  }
}

function bcStatusBadge(status: BackcheckStatus | undefined): { label: string; style: string } {
  switch (status) {
    case 'running': return { label: '背调中', style: 'bg-purple-100 text-purple-700 border-purple-200' }
    case 'done': return { label: '已背调', style: 'bg-emerald-100 text-emerald-700 border-emerald-200' }
    case 'failed': return { label: '失败', style: 'bg-red-100 text-red-600 border-red-200' }
    default: return { label: '排队', style: 'bg-surface-100 text-surface-400 border-surface-200' }
  }
}

export default function SearchResultsPanel({
  progress,
  searching,
  backcheckStatusMap,
}: {
  progress: SearchProgress | null
  searching: boolean
  backcheckStatusMap?: Map<string, BackcheckStatus>
}) {
  const [showSecondary, setShowSecondary] = useState(false)

  if (!progress && !searching) return null

  const primary = progress?.companies.filter(c => ['渠道', '相关'].includes(c.tag)) || []
  const secondary = progress?.companies.filter(c => ['待定', '同行'].includes(c.tag)) || []
  const noise = progress?.companies.filter(c => ['无关', '失败'].includes(c.tag)) || []
  const rawTotal = progress?.companies.length || 0

  return (
    <div>
      {/* 搜索进度总览 */}
      {progress && (
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2 text-xs">
              {searching && <span className="text-amber-600 font-bold">搜索中...</span>}
              {!searching && progress.allDone && (
                <span className="font-bold text-surface-900">
                  {rawTotal} 条结果
                  <span className="font-normal text-surface-500 ml-1">· 新入库 {progress.matched} 家</span>
                  {progress.failed > 0 && <span className="text-red-500 ml-1">· {progress.failed} 条失败</span>}
                </span>
              )}
            </div>
            <span className="text-[11px] font-medium text-surface-400">{progress.completed}/{progress.total} 查询</span>
          </div>

          {/* 渠道进度条 */}
          {progress.errors.length > 0 && (
            <div className="mb-3 border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              <p className="font-semibold">搜索失败原因</p>
              {progress.errors.slice(0, 3).map((error, index) => <p key={`${error}-${index}`} className="mt-1">{error}</p>)}
            </div>
          )}

          {searching && progress.channels.length > 0 && (
            <div className="space-y-1.5 mb-3">
              {progress.channels.map(ch => (
                <div key={ch.channelId} className="flex items-center gap-2 text-xs">
                  <span className="font-medium text-surface-600 w-14 truncate">{ch.channelLabel}</span>
                  <div className="flex-1 h-1.5 bg-surface-100 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full transition-all ${ch.status === 'done' ? 'bg-surface-400' : 'bg-amber-400'}`}
                      style={{ width: `${ch.total > 0 ? (ch.completed / ch.total) * 100 : 0}%` }} />
                  </div>
                  <span className="text-surface-400 tabular-nums w-12 text-right">{ch.completed}/{ch.total}</span>
                  <span className="w-8 text-right text-[11px] font-bold text-green-600">{ch.status === 'done' ? ch.matched : ''}</span>
                </div>
              ))}
            </div>
          )}

          {/* 快捷操作 */}
          {primary.length > 0 && !searching && progress.allDone && (
            <button onClick={() => window.location.href = '/develop'}
              className="w-full text-xs font-bold bg-surface-900 text-white px-3 py-2 rounded-lg hover:bg-surface-800 border-none cursor-pointer font-inherit transition-colors mb-3">
              去开发客户 ({primary.length} 家)
            </button>
          )}
        </div>
      )}

      {/* 结果卡片 */}
      {primary.length > 0 && (
        <div className="space-y-3">
          {primary.map((c, i) => {
            const bcKey = (c.url || '').replace(/\/$/, '').toLowerCase()
            const bcStatus = backcheckStatusMap?.get(bcKey)
            const badge = bcStatusBadge(bcStatus)
            const info = c.companyInfo
            return (
              <div key={i} className="border border-surface-200 rounded-xl p-4 bg-surface-0 hover:border-surface-300 hover:shadow-sm transition-all">
                {/* 顶部：标签 + 背调状态 + 评分 */}
                <div className="flex items-center gap-2 mb-2">
                  <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${tagStyle(c.tag)}`}>{c.tag}</span>
                  <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${badge.style}`}>{badge.label}</span>
                  {c.score > 0 && <span className="text-[10px] font-medium text-surface-400 ml-auto">{c.score} 分</span>}
                </div>

                {/* 标题 + 网址 */}
                <p className="text-sm font-bold text-surface-900">{c.title}</p>
                {c.url && (
                  <button onClick={() => window.open(c.url.startsWith('http') ? c.url : 'https://' + c.url, '_blank')}
                    className="text-[11px] font-medium text-blue-600 hover:text-blue-700 underline underline-offset-2 break-all block mt-0.5 bg-transparent border-none cursor-pointer font-inherit p-0 text-left">
                    {c.url}
                  </button>
                )}

                {/* 结构化信息 */}
                {info && (
                  <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-surface-500">
                    {info.employeeCount && <span className="flex items-center gap-1"><span className="text-surface-300 text-[10px]">员工</span> {info.employeeCount}</span>}
                    {info.revenue && <span className="flex items-center gap-1"><span className="text-surface-300 text-[10px]">营收</span> {info.revenue}</span>}
                    {info.yearFounded && <span className="flex items-center gap-1"><span className="text-surface-300 text-[10px]">成立</span> {info.yearFounded}</span>}
                    {info.markets && info.markets.length > 0 && <span className="flex items-center gap-1"><span className="text-surface-300 text-[10px]">市场</span> {info.markets.slice(0, 3).join(', ')}</span>}
                  </div>
                )}

                {/* 产品标签 */}
                {info?.products && info.products.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {info.products.map((p, j) => (
                      <span key={j} className="text-[10px] bg-surface-50 border border-surface-200 text-surface-600 px-1.5 py-0.5 rounded">{p}</span>
                    ))}
                  </div>
                )}

                {/* 摘要 */}
                {info?.summary && (
                  <p className="text-xs text-surface-600 mt-2 leading-relaxed">{info.summary}</p>
                )}
                {!info?.summary && c.snippet && (
                  <p className="text-xs text-surface-500 mt-2 leading-relaxed line-clamp-2">{c.snippet}</p>
                )}

                {/* 决策人 */}
                {info?.decisionMakers && info.decisionMakers.length > 0 && (
                  <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 text-xs text-surface-500">
                    {info.decisionMakers.map((d, j) => (
                      <span key={j} className="font-medium text-surface-700">{d.name}{d.title ? ` — ${d.title}` : ''}</span>
                    ))}
                  </div>
                )}

                {/* 底部：理由 + 操作 */}
                <div className="flex items-center justify-between mt-3 pt-2 border-t border-surface-100">
                  <p className="text-[10px] text-surface-400 flex-1 min-w-0 truncate">{c.reason}</p>
                  {c.url && (
                    <button onClick={() => window.open(c.url.startsWith('http') ? c.url : 'https://' + c.url, '_blank')}
                      className="text-[10px] font-semibold text-surface-500 hover:text-surface-700 border border-surface-200 px-2.5 py-1 rounded-lg bg-transparent cursor-pointer font-inherit hover:bg-surface-50 transition-colors shrink-0 ml-2">
                      打开网站
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* 次要结果 */}
      {secondary.length > 0 && (
        <div className="mt-4">
          <button onClick={() => setShowSecondary(!showSecondary)}
            className="flex items-center gap-1 text-xs font-semibold text-surface-400 hover:text-surface-600 bg-transparent border-none cursor-pointer font-inherit">
            {showSecondary ? '收起' : '展开'}其他 · {secondary.length}
          </button>
          {showSecondary && (
            <div className="space-y-1.5 mt-2">
              {secondary.map((c, i) => {
                const bcKey = (c.url || '').replace(/\/$/, '').toLowerCase()
                const bcStatus = backcheckStatusMap?.get(bcKey)
                const badge = bcStatusBadge(bcStatus)
                return (
                  <div key={i} className="border border-surface-200 rounded-lg p-3 bg-surface-0 opacity-70">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${tagStyle(c.tag)}`}>{c.tag}</span>
                      {bcStatus && <span className={`text-[10px] px-1.5 py-0.5 rounded border ${badge.style}`}>{badge.label}</span>}
                    </div>
                    <p className="text-xs font-bold text-surface-700 truncate">{c.title}</p>
                    {c.url && (
                      <button onClick={() => window.open(c.url.startsWith('http') ? c.url : 'https://' + c.url, '_blank')}
                        className="text-[10px] text-surface-500 underline underline-offset-2 block mt-0.5 bg-transparent border-none cursor-pointer font-inherit p-0 text-left">{c.url}</button>
                    )}
                    <p className="text-[10px] text-surface-400 mt-0.5">{c.reason}</p>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {noise.length > 0 && !searching && (
        <p className="text-[10px] text-surface-300 text-center mt-3">{noise.length} 条已过滤</p>
      )}
    </div>
  )
}
