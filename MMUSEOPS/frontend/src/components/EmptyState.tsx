import type { ReactNode } from 'react'

interface EmptyStateProps {
  /** 80px 圆图标底（常用 accent-50 底 + accent 色 icon） */
  icon?: ReactNode
  /** 空态标题（17px/600） */
  title: ReactNode
  /** 灰说明（13px muted，max-w 420px 居中） */
  description?: ReactNode
  /** CTA 按钮区 */
  children?: ReactNode
  className?: string
}

/**
 * 空态：80px 圆 icon + 17px 标题 + 13px 灰说明 + CTA。
 * 模板出自 GoodJob empty-state（goodjob_card_patterns.md 3.3 节），
 * 比裸「暂无数据」更丰富，带图标 + 说明 + 行动引导。
 */
export default function EmptyState({ icon, title, description, children, className = '' }: EmptyStateProps) {
  return (
    <div className={`flex flex-col items-center justify-center px-5 py-14 text-center ${className}`}>
      {icon && (
        <div className="flex h-20 w-20 items-center justify-center rounded-full bg-accent-50 text-accent-600">
          {icon}
        </div>
      )}
      <h3 className="mt-4 text-[17px] font-semibold text-surface-900">{title}</h3>
      {description && (
        <p className="mx-auto mt-1.5 max-w-[420px] text-[13px] leading-5 text-surface-500">{description}</p>
      )}
      {children && <div className="mt-4 flex items-center gap-2.5">{children}</div>}
    </div>
  )
}
