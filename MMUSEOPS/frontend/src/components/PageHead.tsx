import type { ReactNode } from 'react'

interface PageHeadProps {
  /** 可选小眉题：12px accent 色大写 */
  eyebrow?: ReactNode
  /** 页面主标题（h1，24px/600） */
  title: ReactNode
  /** 灰色副标题说明（13px muted） */
  subtitle?: ReactNode
  /** 右侧操作区（按钮等），flex-end 底部对齐 */
  actions?: ReactNode
  className?: string
}

/**
 * 页面标题三件套：eyebrow(可选小眉题) + h1 标题 + 灰副标题 + 右侧操作区。
 * 模板出自 GoodJob page-head（goodjob_card_patterns.md 1.2 节），品牌色改用 accent。
 */
export default function PageHead({ eyebrow, title, subtitle, actions, className = '' }: PageHeadProps) {
  return (
    <div className={`page-head mb-5 flex flex-wrap items-start justify-between gap-x-6 gap-y-3 ${className}`}>
      <div className="min-w-0">
        {eyebrow && (
          <p className="mb-1.5 text-[11px] font-medium tracking-wide text-surface-500">{eyebrow}</p>
        )}
        <h1 className="text-2xl font-semibold leading-tight tracking-tight text-surface-900">{title}</h1>
        {subtitle && <p className="mt-2 max-w-4xl text-sm leading-6 text-surface-600">{subtitle}</p>}
      </div>
      {actions && (
        <div className="flex max-w-full flex-wrap items-center gap-2 sm:justify-end">{actions}</div>
      )}
    </div>
  )
}
