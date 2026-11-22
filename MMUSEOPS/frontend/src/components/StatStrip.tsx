import type { ReactNode } from 'react'

export interface StatItem {
  label: ReactNode
  value: ReactNode
  footnote?: ReactNode
  /** 提供则整格渲染为可点击按钮 */
  onClick?: () => void
}

interface StatStripProps {
  items: StatItem[]
  className?: string
}

/**
 * 等宽统计条：label(11px 灰) + 大数字(21px tabular-nums) + 脚注(11px 更灰) 三段式纵列。
 * 模板出自 GoodJob lead-command-item / dense-grid（goodjob_card_patterns.md 2.3 节）。
 * 默认等宽 4 列（小屏降 2 列），gap-2.5。
 */
export default function StatStrip({ items, className = '' }: StatStripProps) {
  return (
    <div className={`grid grid-cols-2 gap-2.5 lg:grid-cols-4 ${className}`}>
      {items.map((item, i) => {
        const inner = (
          <>
            <p className="text-[11px] font-medium text-surface-500">{item.label}</p>
            <p className="mt-1 text-[21px] font-semibold leading-none tabular-nums text-surface-900">{item.value}</p>
            {item.footnote && <p className="mt-1.5 text-[11px] text-surface-400">{item.footnote}</p>}
          </>
        )
        const base = 'rounded-lg border border-surface-200 bg-white px-3.5 py-3 shadow-panel transition-all duration-200'
        return item.onClick ? (
          <button key={i} type="button" onClick={item.onClick} className={`${base} text-left hover:-translate-y-0.5 hover:border-accent-300 hover:shadow-card-hover`}>
            {inner}
          </button>
        ) : (
          <div key={i} className={base}>{inner}</div>
        )
      })}
    </div>
  )
}
