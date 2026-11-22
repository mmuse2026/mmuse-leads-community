import { useState, useEffect } from 'react'
import { loadSearchTarget, saveSearchTarget, countryOptions, industryOptions, type SearchTarget } from '../../store/searchTarget'

export default function SearchTargetPanel({
  onChange,
}: {
  onChange?: (target: SearchTarget) => void
}) {
  const [target, setTarget] = useState<SearchTarget>(loadSearchTarget)

  useEffect(() => {
    const loaded = loadSearchTarget()
    setTarget(loaded)
    onChange?.(loaded)
  }, [])

  const update = (patch: Partial<SearchTarget>) => {
    const next = { ...target, ...patch }
    setTarget(next)
    saveSearchTarget(next)
    onChange?.(next)
  }

  return (
    <div className="px-6 py-3 space-y-3">
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <label className="text-[11px] font-semibold text-surface-500 whitespace-nowrap">目标国家</label>
          <select value={target.country}
            onChange={e => update({ country: e.target.value })}
            className="text-xs font-medium text-surface-900 bg-surface-50 border border-surface-200 rounded-md px-2 py-1.5 outline-none focus:border-surface-400 cursor-pointer font-inherit">
            {countryOptions.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          {target.country === 'custom' && (
            <input type="text" value={target.country}
              onChange={e => update({ country: e.target.value })}
              placeholder="输入国家名"
              className="text-xs font-medium text-surface-900 bg-surface-50 border border-surface-200 rounded-md px-2 py-1.5 outline-none focus:border-surface-400 w-24 font-inherit" />
          )}
        </div>

        <div className="flex items-center gap-2">
          <label className="text-[11px] font-semibold text-surface-500 whitespace-nowrap">行业品类</label>
          <select value={target.industry}
            onChange={e => update({ industry: e.target.value })}
            className="text-xs font-medium text-surface-900 bg-surface-50 border border-surface-200 rounded-md px-2 py-1.5 outline-none focus:border-surface-400 cursor-pointer font-inherit">
            {industryOptions.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          {target.industry === 'custom' && (
            <input type="text" value={target.industry}
              onChange={e => update({ industry: e.target.value })}
              placeholder="输入行业"
              className="text-xs font-medium text-surface-900 bg-surface-50 border border-surface-200 rounded-md px-2 py-1.5 outline-none focus:border-surface-400 w-24 font-inherit" />
          )}
        </div>
      </div>

      <div>
        <div className="flex items-center gap-2 mb-1">
          <label className="text-[11px] font-semibold text-surface-500 whitespace-nowrap">关键词</label>
          <span className="text-[10px] text-surface-400">每行一个</span>
        </div>
        <textarea value={target.keywords}
          onChange={e => update({ keywords: e.target.value })}
          placeholder="每行输入一个关键词"
          rows={8}
          className="text-xs font-medium text-surface-900 bg-surface-50 border border-surface-200 rounded-md px-2 py-1.5 outline-none focus:border-surface-400 w-full font-inherit resize-y" />
      </div>
    </div>
  )
}
