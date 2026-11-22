import { useState, useEffect, useRef } from 'react'
import type { SearchTarget } from '../../store/searchTarget'
import type { ChannelProgress } from '../../services/searchService'
import { translateToEnglish } from '../../services/translateService'
import { loadProfile } from '../../store/userProfile'
import {
  SEARCH_CHANNELS,
  API_QUOTAS,
  generateSearchQueries,
  type SearchChannelType,
  type SearchChannelState,
  type SearchChannelDef,
} from '../../data/searchChannels'

const STORAGE_KEY = 'mmuse_channel_states'
const USAGE_KEY = 'mmuse_api_usage'

function loadChannelStates(): SearchChannelState[] {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      const parsed = JSON.parse(saved) as SearchChannelState[]
      // 确保所有渠道都有（兼容新增渠道）
      for (const def of SEARCH_CHANNELS) {
        if (!parsed.find(s => s.id === def.id)) {
          parsed.push({ id: def.id, enabled: def.id === 'web' || def.id === 'linkedin', extraParam: def.id === 'maps' ? '' : undefined })
        }
      }
      // 确保至少一个渠道启用
      if (!parsed.some(s => s.enabled)) {
        parsed.find(s => s.id === 'web')!.enabled = true
      }
      return parsed
    }
  } catch {}
  return SEARCH_CHANNELS.map(ch => ({
    id: ch.id,
    enabled: ch.id === 'web' || ch.id === 'linkedin',
    extraParam: ch.id === 'maps' ? '' : undefined,
  }))
}

function saveChannelStates(states: SearchChannelState[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(states))
}

interface UsageData {
  month: string
  usage: Record<string, number>
}

function loadUsage(): UsageData {
  try {
    const saved = localStorage.getItem(USAGE_KEY)
    if (saved) {
      const parsed = JSON.parse(saved) as UsageData
      const today = new Date()
      if (parsed.month !== `${today.getFullYear()}-${today.getMonth()}`) {
        return { month: `${today.getFullYear()}-${today.getMonth()}`, usage: {} }
      }
      return parsed
    }
  } catch {}
  const today = new Date()
  return { month: `${today.getFullYear()}-${today.getMonth()}`, usage: {} }
}

function saveUsage(apiId: string) {
  const data = loadUsage()
  data.usage[apiId] = (data.usage[apiId] || 0) + 1
  localStorage.setItem(USAGE_KEY, JSON.stringify(data))
  return data
}

/** 获取渠道的主 API 及其剩余额度 */
function getPrimaryApiInfo(ch: SearchChannelDef) {
  const primary = ch.providers[0]
  const quota = API_QUOTAS.find(q => q.apiId === primary?.apiId)
  const usage = loadUsage()
  const used = usage.usage[primary?.apiId || ''] || 0
  const remaining = quota ? Math.max(0, quota.monthlyLimit - used) : 999
  return { primary, quota, used, remaining }
}

/** 获取备用 API 名称 */
function getFallbackLabel(ch: SearchChannelDef): string {
  if (ch.providers.length <= 1) return ''
  return ch.providers.slice(1).map(p => p.label).join(' / ')
}

const RESULT_TYPE_LABELS: Record<string, string> = {
  'company': '公司信息',
  'person+company': '联系人 + 公司',
  'local_business': '本地商家',
}

export default function ChannelSelector({
  target,
  onQueriesChange,
  onStartSearch,
  onPause,
  onReturn,
  searching,
  channelProgress,
  searchTargetMode,
}: {
  target: SearchTarget
  onQueriesChange?: (queries: { channelId: string; channelLabel: string; query: string }[]) => void
  onStartSearch?: () => void
  onPause?: () => void
  onReturn?: () => void
  searching?: boolean
  channelProgress?: ChannelProgress[]
  searchTargetMode?: 'all' | 'buyer'
}) {
  const [channelStates, setChannelStates] = useState<SearchChannelState[]>(loadChannelStates)
  const [expandedId, setExpandedId] = useState<SearchChannelType | null>(null)
  const [translating, setTranslating] = useState(false)
  const [mode, setMode] = useState<'all' | 'buyer'>(searchTargetMode || 'all')
  const lastTargetRef = useRef('')

  useEffect(() => { setChannelStates(loadChannelStates()) }, [])

  // 生成搜索词
  useEffect(() => {
    const run = async () => {
      const kw = target?.keywords || ''
      if (kw === lastTargetRef.current) return
      lastTargetRef.current = kw

      let enKw = kw
      if (/[一-鿿]/.test(kw)) {
        setTranslating(true)
        enKw = await translateToEnglish(kw)
        lastTargetRef.current = enKw
        setTranslating(false)
      }

      const keywords = enKw.split(/[,，、\n]/).map(k => k.trim()).filter(Boolean)
      const country = target.country === 'custom' ? '' : target.country
      const enabledChs = channelStates.filter(s => s.enabled)

      const allQueries: { channelId: string; channelLabel: string; query: string }[] = []
      for (const state of enabledChs) {
        const def = SEARCH_CHANNELS.find(d => d.id === state.id)
        if (!def) continue
        const qs = generateSearchQueries(state.id, keywords, country, state.extraParam)
        for (const q of qs) {
          const finalQuery = mode === 'buyer' ? `${q} importer OR distributor OR wholesaler OR retailer OR dealer` : q
          allQueries.push({ channelId: state.id, channelLabel: def.label, query: finalQuery })
        }
      }
      onQueriesChange?.(allQueries)
    }
    run()
    // channelStates / mode 变化时也要重新生成（开关渠道/切换搜索目标时）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, channelStates, mode])

  // 首次自动展开
  useEffect(() => {
    if (!expandedId || !channelStates.find(s => s.id === expandedId)?.enabled) {
      const first = channelStates.find(s => s.enabled)
      if (first) setExpandedId(first.id)
    }
  }, [channelStates, expandedId])

  const toggleChannel = (id: SearchChannelType) => {
    setChannelStates(prev => {
      const next = prev.map(s => s.id === id ? { ...s, enabled: !s.enabled } : s)
      saveChannelStates(next)
      return next
    })
  }

  const updateExtraParam = (id: SearchChannelType, val: string) => {
    setChannelStates(prev => {
      const next = prev.map(s => s.id === id ? { ...s, extraParam: val } : s)
      saveChannelStates(next)
      return next
    })
  }

  const handleStartSearch = () => {
    console.log('[MMUSE] startSearch clicked, enabledCount:', channelStates.filter(c => c.enabled).length)
    // 记录用量（粗略：启用1个渠道=消耗1次查询，实际按查询数）
    for (const s of channelStates.filter(c => c.enabled)) {
      const def = SEARCH_CHANNELS.find(d => d.id === s.id)
      if (def?.providers[0]) saveUsage(def.providers[0].apiId)
    }
    onStartSearch?.()
  }

  const enabledCount = channelStates.filter(s => s.enabled).length

  return (
    <div>
      {/* 顶栏 */}
      <div className="mb-3">
        <div className="flex items-center gap-2 mb-1">
          <h2 className="text-xs font-bold text-surface-900 uppercase tracking-wider">搜索管道</h2>
          <span className="text-[10px] font-semibold text-surface-400 bg-surface-100 px-1.5 py-0.5 rounded">
            {enabledCount}/{SEARCH_CHANNELS.length}
          </span>
          <select value={mode} onChange={e => setMode(e.target.value as 'all' | 'buyer')}
            className="text-[11px] bg-surface-50 border border-surface-200 rounded px-2 py-0.5 text-surface-700 outline-none cursor-pointer focus:border-surface-400">
            <option value="all">不限</option>
            <option value="buyer">采购商</option>
          </select>
          {translating && <span className="text-[10px] font-semibold text-amber-600">翻译中...</span>}
          {/* API 用量总览 */}
          <span className="ml-auto text-[10px] text-surface-400">
            Serper: {getPrimaryApiInfo(SEARCH_CHANNELS[0]).remaining}/{API_QUOTAS[0].monthlyLimit}
          </span>
        </div>
      </div>

      {/* 渠道卡片列表 */}
      <div className="space-y-1.5">
        {SEARCH_CHANNELS.map(ch => {
          const state = channelStates.find(s => s.id === ch.id)
          const enabled = state?.enabled ?? false
          const isExpanded = ch.id === expandedId && enabled
          const { remaining } = getPrimaryApiInfo(ch)
          const fallbackLabel = getFallbackLabel(ch)
          const prog = channelProgress?.find(p => p.channelId === ch.id)

          return (
            <div key={ch.id} className={`border rounded-lg overflow-hidden transition-all ${
              enabled
                ? (isExpanded ? 'border-surface-300 bg-surface-0' : 'border-surface-200 bg-surface-0 hover:border-surface-300')
                : 'border-surface-200 opacity-45'
            }`}>
              {/* 卡片头部 */}
              <div
                onClick={() => enabled && setExpandedId(isExpanded ? null : ch.id)}
                className={`px-3 py-2.5 select-none ${enabled ? 'cursor-pointer' : ''}`}
              >
                {/* 第一行：checkbox + 名称 + 进度/状态 */}
                <div className="flex items-center gap-3">
                  <input type="checkbox" checked={enabled}
                    onClick={e => { e.stopPropagation(); toggleChannel(ch.id) }}
                    onChange={() => {}}
                    className="w-3.5 h-3.5 cursor-pointer accent-surface-700 flex-shrink-0" />
                  <span className="text-[13px] font-bold text-surface-800 flex-1">{ch.label}</span>

                  {prog?.status === 'running' && (
                    <span className="flex items-center gap-1 text-[10px] font-semibold text-amber-600">
                      <span className="w-1.5 h-1.5 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
                      {prog.completed}/{prog.total}
                    </span>
                  )}
                  {prog?.status === 'done' && (
                    <span className="text-[10px] font-bold text-green-600">{prog.matched}</span>
                  )}

                  {/* API 额度指示 */}
                  <span className={`text-[10px] font-semibold ${
                    remaining < 100 ? 'text-red-500' : remaining < 500 ? 'text-amber-600' : 'text-surface-400'
                  }`}>
                    {remaining}
                  </span>

                  {enabled && (
                    <span className={`text-[10px] text-surface-300 transition-transform ${isExpanded ? 'rotate-180' : ''}`}>▼</span>
                  )}
                </div>

                {/* 第二行：描述 */}
                <div className="text-[10px] text-surface-400 mt-0.5 ml-6">{ch.description}</div>

                {/* 第三行：结果类型 + 备用API */}
                <div className="flex items-center gap-2 mt-0.5 ml-6">
                  <span className="text-[9px] font-medium text-surface-400 bg-surface-100 px-1.5 py-0.5 rounded">
                    {RESULT_TYPE_LABELS[ch.resultType]}
                  </span>
                  {fallbackLabel && (
                    <span className="text-[9px] text-surface-300">备用: {fallbackLabel}</span>
                  )}
                </div>
              </div>

              {/* 展开内容：搜索词 */}
              {isExpanded && (
                <div className="px-3 pb-3 pt-1 border-t border-surface-200">
                  {/* 搜索词 */}
                  {(() => {
                    const kw = (lastTargetRef.current || target?.keywords || '').split(/[,，、\n]/).map(k => k.trim()).filter(Boolean)
                    const country = target?.country === 'custom' ? '' : (target?.country || '')
                    const qs = generateSearchQueries(ch.id, kw.length ? kw : ['commercial furniture'], country, state?.extraParam)
                    return qs.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5 mb-2 mt-2">
                        {qs.map((q, i) => (
                          <span key={i}
                            className="text-[11px] font-medium bg-surface-100 text-surface-600 px-2 py-0.5 rounded-full border border-surface-200">
                            {q}
                          </span>
                        ))}
                      </div>
                    ) : null
                  })()}

                  {/* Maps 城市参数 */}
                  {ch.needsExtraParam && (
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-semibold text-surface-400">{ch.extraParamLabel}:</span>
                      <input type="text" value={state?.extraParam || ''}
                        onChange={e => updateExtraParam(ch.id, e.target.value)}
                        placeholder="输入城市名..."
                        className="text-[11px] bg-surface-50 border border-surface-200 rounded px-2 py-1 flex-1 outline-none focus:border-surface-400 font-inherit" />
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* 状态提示 */}
      {!searching && enabledCount === 0 && (
        <div className="mt-3 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700">
          请至少勾选一个搜索渠道
        </div>
      )}

      {/* 操作按钮 */}
      <div className="flex items-center gap-2 mt-3">
        <button onClick={handleStartSearch} disabled={searching || enabledCount === 0}
          className={`text-xs font-bold px-5 py-2 rounded-lg transition-all border-none cursor-pointer font-inherit ${
            searching
              ? 'bg-amber-50 text-amber-600 cursor-not-allowed'
              : enabledCount > 0
                ? 'bg-surface-900 text-white hover:bg-surface-800'
                : 'bg-surface-100 text-surface-300 cursor-not-allowed'
          }`}>
          {searching ? '搜索中...' : '开始搜索'}
        </button>
        <button onClick={onPause} disabled={!searching}
          className={`text-xs font-semibold px-4 py-2 rounded-lg border transition-colors cursor-pointer font-inherit ${
            searching
              ? 'border-surface-200 text-surface-500 hover:bg-surface-50 bg-transparent'
              : 'border-transparent text-surface-300 bg-transparent cursor-default'
          }`}>
          暂停
        </button>
      </div>
    </div>
  )
}
