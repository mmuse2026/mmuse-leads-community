import type { ReactNode } from 'react'

interface SectionHeadProps {
  /** 32px 圆角图标章（常用 accent-50 底 + accent 色 inline SVG） */
  icon?: ReactNode
  /** 功能块标题（h2，16px/600） */
  title: ReactNode
  /** 标题右侧内联小字（如计数 / scope 标签） */
  titleTag?: ReactNode
  /** 标题下方灰副说明（12px muted） */
  subtitle?: ReactNode
  /** 右侧徽章 / 计数 / 按钮区 */
  right?: ReactNode
  className?: string
}

/**
 * 功能块标题条：图标章 + h2 + 灰副说明 + 右侧徽章/计数/按钮。
 * 模板出自 GoodJob section-head（goodjob_card_patterns.md 2.1 节），全站复用。
 * mb-3.5 与内容拉开 14px 垂直节奏。
 */
export default function SectionHead({ icon, title, titleTag, subtitle, right, className = '' }: SectionHeadProps) {
  return (
    <div className={`section-head mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-2 ${className}`}>
      <div className="flex min-w-0 items-center gap-2.5">
        {icon && (
          <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-accent-50 text-accent-600">
            {icon}
          </span>
        )}
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h2 className="text-base font-semibold text-surface-900">{title}</h2>
            {titleTag && <span className="text-xs text-surface-500">{titleTag}</span>}
          </div>
          {subtitle && <p className="mt-1 text-xs leading-5 text-surface-600">{subtitle}</p>}
        </div>
      </div>
      {right && <div className="flex max-w-full flex-wrap items-center gap-2">{right}</div>}
    </div>
  )
}
