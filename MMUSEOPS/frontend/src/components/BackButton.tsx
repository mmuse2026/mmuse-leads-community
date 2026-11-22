import { useNavigate } from 'react-router-dom'

interface BackButtonProps {
  /** 按钮文案，默认「返回」 */
  label?: string
  /** 无浏览器历史时的兜底跳转地址；不传则在无历史时不渲染，避免点了没反应 */
  fallbackTo?: string
  className?: string
}

/**
 * 共享「返回上一步」按钮：点击执行 window.history.back()，替代浏览器返回。
 * - 无可用历史（history.length <= 1）且未提供 fallbackTo 时不渲染；
 * - 无可用历史但提供了 fallbackTo 时点击跳转到该地址。
 * 样式对齐 PageHead/SectionHead 的 ghost 按钮（rounded-lg / border-surface-200 / bg-white / shadow-panel），
 * 与各页「刷新」按钮一致，hover 加深。
 */
export default function BackButton({ label = '返回', fallbackTo, className = '' }: BackButtonProps) {
  const navigate = useNavigate()
  const canGoBack = typeof window !== 'undefined' && window.history.length > 1

  if (!canGoBack && !fallbackTo) return null

  const handleClick = () => {
    if (canGoBack) {
      window.history.back()
    } else if (fallbackTo) {
      navigate(fallbackTo)
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      title={label}
      aria-label={label}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border border-black/[0.06] bg-white/75 text-surface-500 backdrop-blur-xl transition-colors hover:bg-white hover:text-surface-900 ${className}`}
    >
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
        <path d="M7.5 4.5 3 9l4.5 4.5" />
        <path d="M3 9h11a2.5 2.5 0 0 1 2.5 2.5V13" />
      </svg>
    </button>
  )
}
