import { useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { refreshFromServer } from '../store/db'

const primaryNav = [
  { path: '/daily-workbench', label: '今日工作' },
  { path: '/', label: '客户' },
  { path: '/crm-followups', label: '客户跟进' },
  { path: '/develop', label: '开发' },
]

const secondaryNav = [
  { path: '/marketing', label: '营销' },
  { path: '/email-batch', label: '邮件开发' },
  { path: '/send-queue', label: '发送队列' },
  { path: '/replies', label: '回信与退信' },
  { path: '/search-workbench', label: '搜索公司' },
  { path: '/admin', label: '数据维护' },
  { path: '/settings', label: '设置' },
]

export default function Layout() {
  const navigate = useNavigate()
  const location = useLocation()
  const [syncing, setSyncing] = useState(false)
  const [syncMessage, setSyncMessage] = useState('')

  async function syncNow() {
    if (syncing) return
    setSyncing(true)
    setSyncMessage('')
    try {
      const count = await refreshFromServer(true)
      setSyncMessage(`已同步 ${count} 条`)
    } catch {
      setSyncMessage('同步失败')
    } finally {
      setSyncing(false)
    }
  }

  function active(path: string) {
    return path === '/' ? location.pathname === '/' : location.pathname.startsWith(path)
  }

  return <div data-v29-ui className="flex min-h-[100dvh] flex-col overflow-hidden bg-[#f5f5f7]">
    <header className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-2 py-2 border-b border-black/[0.06] bg-white px-4 lg:px-6">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 sm:gap-5 lg:gap-8">
        <button type="button" onClick={() => navigate('/')} className="flex shrink-0 items-center gap-2 text-sm font-semibold text-surface-900"><img src="/bbox-ui/mmuse-icon.png" width={24} height={24} alt="" />缪斯获客管理社区版</button>
        <nav aria-label="主导航" className="flex min-w-0 items-center gap-1 overflow-x-auto">
          {primaryNav.map(item => <NavLink key={item.path} to={item.path} className={`rounded-lg px-3 py-1.5 text-sm whitespace-nowrap ${active(item.path) ? 'bg-accent-50 font-semibold text-accent-700' : 'text-surface-500 hover:text-surface-900'}`}>{item.label}</NavLink>)}
        </nav>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span aria-live="polite" className="hidden text-[11px] text-surface-400 sm:inline">{syncMessage}</span>
        <button type="button" onClick={syncNow} disabled={syncing} className="directory-icon-button" title="同步客户数据" aria-label="同步客户数据">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`}><path d="M20 7v5h-5"/><path d="M4 17v-5h5"/><path d="M6.1 8.5A7 7 0 0 1 18.5 6L20 7M4 17l1.5 1A7 7 0 0 0 18 15.5"/></svg>
        </button>
        <details className="relative">
          <summary className="directory-icon-button cursor-pointer list-none" title="更多功能" aria-label="更多功能">
            <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>
          </summary>
          <div className="absolute right-0 z-40 mt-2 w-44 rounded-xl border border-surface-200 bg-white p-2 shadow-lg">
            {secondaryNav.map(item => <NavLink key={item.path} to={item.path} className={`block rounded-lg px-3 py-2 text-sm ${active(item.path) ? 'bg-surface-100 font-medium text-surface-900' : 'text-surface-600 hover:bg-surface-50 hover:text-surface-900'}`}>{item.label}</NavLink>)}
          </div>
        </details>
      </div>
    </header>
    <main className="min-h-0 flex-1 overflow-hidden"><Outlet /></main>
  </div>
}
