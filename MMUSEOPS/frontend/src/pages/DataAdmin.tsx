import { useState, useEffect, useMemo, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { getAllItems, deleteItem, getDbStats, exportAllData, importAllData, clearAllData, deduplicateItems, saveItem, migrateBackcheckField, loadFromDisk } from '../store/db'
import { pipelines } from '../data/pipelines'
import { batchClassifyUnknown, classifyExistingItems } from '../services/classifyClient'
import { BUSINESS_LINE_LABELS } from '../types/item'
import type { PipelineItem, ClientLevel, ClientType, ItemStatus } from '../types/item'
import type { PipelineKey } from '../types/pipeline'
import type { DbDump } from '../store/db'
import { API_BASE } from '../services/config'
import { cnBoolean, cnObjectType, cnStatus } from '../services/chineseStatus'
import { zh } from '../services/zhText'
import { CRM_STAGE_OPTIONS, crmStageLabel, getLastCustomerContactAt, getNextCustomerFollowupAt } from '../services/crmManagementPresentation'

type SortField = 'title' | 'company' | 'level' | 'clientType' | 'pipelineId' | 'updatedAt' | 'createdAt'
type SortDir = 'asc' | 'desc'

const PAGE_SIZES = [20, 50, 100]

const levelOrder: Record<string, number> = { S: 0, M: 1, L: 2, XL: 3, unknown: 4 }
const levelLabels: Record<string, string> = {
  S: 'S (1-10)', M: 'M (10-50)', L: 'L (50-100)', XL: 'XL (100+)', unknown: '未分级',
}
const typeLabels: Record<string, string> = {
  distributor: '经销商', trader: '贸易商', ecommerce: '电商', wholesaler: '批发商',
  retailer: '零售商', manufacturer: '厂家', unknown: '待定',
}
const statusLabels: Record<string, string> = {
  active: '活跃', completed: '已完成', archived: '已归档',
}
const pipelineNames: Record<string, string> = {}
for (const p of pipelines) pipelineNames[p.key] = p.name
const crmDate = (value: string) => value ? new Date(value).toLocaleDateString('zh-CN') : '—'

interface DbStats {
  items: number; keywords: number; templates: number; activeItems: number
  pipelines: Record<string, number>; levels: Record<string, number>; estimatedSize: string
}

interface IsolationEntry {
  objectType: 'company' | 'domain' | 'email' | 'contact'
  objectValue: string
  reason: string
  sourceStage: string
  isolatedAt: string
  originalCustomerId: string
  permanent: boolean
  note?: string
}

const ISOLATION_TYPES = [
  { value: '', label: '全部类型' },
  { value: 'company', label: '公司' },
  { value: 'domain', label: '域名' },
  { value: 'email', label: '邮箱' },
  { value: 'contact', label: '联系人' },
]

export default function DataAdmin() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [tab, setTab] = useState<'data' | 'backup' | 'isolation'>(() => searchParams.get('tab') === 'isolation' ? 'isolation' : 'data')
  const [items, setItems] = useState<PipelineItem[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filterPipeline, setFilterPipeline] = useState<string>('all')
  const [filterLevel, setFilterLevel] = useState<string>('all')
  const [filterType, setFilterType] = useState<string>('all')
  const [filterStatus, setFilterStatus] = useState<string>('all')
  const [filterBiz, setFilterBiz] = useState<string>('all')
  const [filterCrmStage, setFilterCrmStage] = useState<string>('all')
  const [sortField, setSortField] = useState<SortField>('updatedAt')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [selectAll, setSelectAll] = useState(false)

  // 备份 tab 状态
  const [stats, setStats] = useState<DbStats | null>(null)
  const [statusMsg, setStatusMsg] = useState<{ type: 'ok' | 'error'; msg: string } | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [confirmDedup, setConfirmDedup] = useState(false)
  const [dedupResult, setDedupResult] = useState<string | null>(null)
  const [llmClassifying, setLlmClassifying] = useState(false)
  const [llmProgress, setLlmProgress] = useState({ done: 0, total: 0 })
  const [llmResult, setLlmResult] = useState<string | null>(null)

  // 隔离库 tab 状态
  const [isolationRows, setIsolationRows] = useState<IsolationEntry[]>([])
  const [isolationTotal, setIsolationTotal] = useState(0)
  const [isolationLoading, setIsolationLoading] = useState(false)
  const [isolationError, setIsolationError] = useState('')
  const [isoSearch, setIsoSearch] = useState('')
  const [isoType, setIsoType] = useState('')
  const [isoPage, setIsoPage] = useState(1)
  const [isoPageSize, setIsoPageSize] = useState(20)

  const loadIsolation = useCallback(async () => {
    setIsolationLoading(true)
    setIsolationError('')
    try {
      const qs = new URLSearchParams()
      if (isoSearch.trim()) qs.set('q', isoSearch.trim())
      if (isoType) qs.set('type', isoType)
      qs.set('page', String(isoPage))
      qs.set('pageSize', String(isoPageSize))
      const response = await fetch(`${API_BASE}/api/isolation?${qs.toString()}`, { signal: AbortSignal.timeout(15000) })
      if (!response.ok) throw new Error(`隔离库请求失败 (${response.status})`)
      const payload = await response.json()
      setIsolationRows(payload?.items || [])
      setIsolationTotal(payload?.total ?? 0)
    } catch (error: unknown) {
      setIsolationError(error instanceof Error ? error.message : String(error))
      setIsolationRows([])
      setIsolationTotal(0)
    } finally {
      setIsolationLoading(false)
    }
  }, [isoSearch, isoType, isoPage, isoPageSize])

  useEffect(() => { if (tab === 'isolation') void loadIsolation() }, [tab, loadIsolation])
  useEffect(() => { setIsoPage(1) }, [isoSearch, isoType, isoPageSize])

  const loadData = useCallback(async () => {
    const all = await getAllItems()
    setItems(all)
    setLoading(false)
  }, [])

  const loadStats = useCallback(async () => {
    setStats(await getDbStats())
  }, [])

  useEffect(() => { loadData(); loadStats() }, [loadData, loadStats])

  // 数据同步后自动刷新+去重
  useEffect(() => {
    const handler = async () => {
      loadData(); loadStats()
    }
    window.addEventListener('mmuse:sync-done', handler)
    return () => window.removeEventListener('mmuse:sync-done', handler)
  }, [loadData, loadStats])
const showStatus = (type: 'ok' | 'error', msg: string) => {
    setStatusMsg({ type, msg })
    setTimeout(() => setStatusMsg(null), 4000)
  }

  // 按业务线分组
  const bizGroups = useMemo(() => {
    const map = new Map<string, PipelineItem[]>()
    for (const item of items) {
      const bl = item.businessLine || 'unknown'
      if (!map.has(bl)) map.set(bl, [])
      map.get(bl)!.push(item)
    }
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length)
  }, [items])

  const activeCount = (list: PipelineItem[]) => list.filter(i => i.status === 'active').length
  const verifiedCount = (list: PipelineItem[]) => list.filter(i => i.emailVerification === 'verified').length

  // 搜索+筛选
  const filtered = useMemo(() => {
    let result = [...items]

    if (search.trim()) {
      const q = search.toLowerCase()
      result = result.filter(i =>
        i.title.toLowerCase().includes(q) ||
        i.company.toLowerCase().includes(q) ||
        i.contactName.toLowerCase().includes(q) ||
        i.email.toLowerCase().includes(q)
      )
    }
    if (filterPipeline !== 'all') result = result.filter(i => i.pipelineId === filterPipeline)
    if (filterLevel !== 'all') result = result.filter(i => i.level === filterLevel)
    if (filterType !== 'all') result = result.filter(i => i.clientType === filterType)
    if (filterStatus !== 'all') result = result.filter(i => i.status === filterStatus)
    if (filterBiz !== 'all') result = result.filter(i => (i.businessLine || 'unknown') === filterBiz)
    if (filterCrmStage !== 'all') result = result.filter(i => i.primaryStage === filterCrmStage)
    return result
  }, [items, search, filterPipeline, filterLevel, filterType, filterStatus, filterBiz, filterCrmStage])

  // 排序
  const sorted = useMemo(() => {
    const result = [...filtered]
    result.sort((a, b) => {
      let cmp = 0
      switch (sortField) {
        case 'level':
          cmp = (levelOrder[a.level] ?? 99) - (levelOrder[b.level] ?? 99); break
        case 'updatedAt':
          cmp = new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime(); break
        case 'createdAt':
          cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(); break
        case 'title':
          cmp = a.title.localeCompare(b.title); break
        case 'company':
          cmp = a.company.localeCompare(b.company); break
        case 'clientType':
          cmp = a.clientType.localeCompare(b.clientType); break
        case 'pipelineId':
          cmp = a.pipelineId.localeCompare(b.pipelineId); break
      }
      return sortDir === 'asc' ? cmp : -cmp
    })
    return result
  }, [filtered, sortField, sortDir])

  // 分页
  const totalPages = Math.ceil(sorted.length / pageSize) || 1
  const paged = useMemo(() => {
    const start = (page - 1) * pageSize
    return sorted.slice(start, start + pageSize)
  }, [sorted, page, pageSize])

  useEffect(() => { setPage(1) }, [search, filterPipeline, filterLevel, filterType, filterStatus, filterBiz, filterCrmStage, pageSize])

  useEffect(() => {
    if (selectAll) {
      setSelected(new Set(paged.map(i => i.id)))
    } else if (selected.size > 0 && paged.every(i => selected.has(i.id))) {
      setSelected(new Set())
    }
  }, [selectAll, paged])

  const handleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleSort = (field: SortField) => {
    if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortField(field); setSortDir('asc') }
  }

  const levelBadge = (lvl: ClientLevel) => {
    const colors: Record<string, string> = {
      S: 'bg-emerald-50 text-emerald-700', M: 'bg-blue-50 text-blue-700',
      L: 'bg-amber-50 text-amber-700', XL: 'bg-red-50 text-red-700', unknown: 'bg-surface-100 text-surface-500',
    }
    return colors[lvl] || colors.unknown
  }

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <span className="text-surface-300 ml-1">↕</span>
    return <span className="text-accent-500 ml-1">{sortDir === 'asc' ? '↑' : '↓'}</span>
  }

  // ---- 备份操作 ----
  const handleDedup = async () => {
    try {
      const removed = await deduplicateItems()
      setDedupResult(`已安全归档 ${removed} 条重复数据，未删除原始记录`)
      setConfirmDedup(false)
      await loadStats(); await loadData()
    } catch (e) { showStatus('error', `去重失败: ${(e as Error).message}`) }
  }

  const handleRestoreFromBackend = async () => {
    try {
      const count = await loadFromDisk()
      showStatus('ok', `从后端恢复 ${count} 条数据`)
      await loadData(); await loadStats()
    } catch (e: any) { showStatus('error', `恢复失败: ${e.message}`) }
  }

  const handleMigrateBackcheck = async () => {
    try {
      const fixed = await migrateBackcheckField()
      showStatus('ok', `修复 ${fixed} 条背调数据字段`)
      await loadData(); await loadStats()
    } catch (e: any) { showStatus('error', `修复失败: ${e.message}`) }
  }

  const handleLlmClassify = async () => {
    setLlmClassifying(true)
    setLlmResult(null)
    setLlmProgress({ done: 0, total: 0 })
    try {
      const count = await batchClassifyUnknown((done, total) => {
        setLlmProgress({ done, total })
      })
      setLlmResult(`已分类 ${count} 条`)
      showStatus('ok', `LLM批量分类完成，已分类 ${count} 条`)
      await loadData(); await loadStats()
    } catch (e: any) {
      showStatus('error', `LLM分类失败: ${e.message}`)
    } finally {
      setLlmClassifying(false)
    }
  }

  const handleExport = async () => {
    try {
      const dump = await exportAllData()
      const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const date = new Date().toISOString().slice(0, 10)
      a.download = `mmuse-backup-${date}.json`
      a.click()
      URL.revokeObjectURL(url)
      showStatus('ok', `已导出 ${dump.items.length} 条客户数据`)
    } catch (e) { showStatus('error', `导出失败: ${(e as Error).message}`) }
  }

  const handleImport = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      try {
        const text = await file.text()
        const dump: DbDump = JSON.parse(text)
        if (!dump.items || !Array.isArray(dump.items)) { showStatus('error', '无效的备份文件'); return }
        const count = await importAllData(dump)
        showStatus('ok', `已恢复 ${count} 条客户数据`)
        await loadStats(); await loadData()
      } catch (e) { showStatus('error', `导入失败: ${(e as Error).message}`) }
    }
    input.click()
  }

  const handleClear = async () => {
    try {
      await clearAllData()
      setConfirmClear(false)
      showStatus('ok', '所有数据已清空')
      await loadStats(); await loadData()
    } catch (e) { showStatus('error', `清空失败: ${(e as Error).message}`) }
  }

  if (loading) {
    return <div className="flex-1 flex items-center justify-center text-surface-400 text-sm">加载中...</div>
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* 顶部栏 */}
      <div className="glass-darker px-6 lg:px-8 py-4 border-b border-surface-200">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h1 className="text-lg font-bold text-surface-900">数据管理</h1>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 mb-3">
          <button onClick={() => setTab('data')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border-none cursor-pointer font-inherit ${
              tab === 'data' ? 'bg-accent-500 text-white' : 'bg-surface-100 text-surface-500 hover:bg-surface-200'
            }`}>
            客户数据 · {items.length}
          </button>
          <button onClick={() => setTab('backup')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border-none cursor-pointer font-inherit ${
              tab === 'backup' ? 'bg-accent-500 text-white' : 'bg-surface-100 text-surface-500 hover:bg-surface-200'
            }`}>
            数据安全
          </button>
          <button onClick={() => setTab('isolation')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border-none cursor-pointer font-inherit ${
              tab === 'isolation' ? 'bg-accent-500 text-white' : 'bg-surface-100 text-surface-500 hover:bg-surface-200'
            }`}>
            隔离库
          </button>
        </div>
      </div>

      {tab === 'data' && (
        <>
          {/* 操作栏 */}
          <div className="glass-darker px-6 lg:px-8 py-3 border-b border-surface-200">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2 flex-wrap">
                <input type="text" value={search} onChange={e => setSearch(e.target.value)}
                  placeholder="搜索公司/联系人/邮箱..."
                  className="input w-56 text-xs" />
                <select value={filterBiz} onChange={e => { setFilterBiz(e.target.value); setPage(1) }} className="input w-44 text-xs">
                  <option value="all">全部业务 · {items.length}</option>
                  {bizGroups.map(([bl, list]) => <option key={bl} value={bl}>{BUSINESS_LINE_LABELS[bl] || bl} · {list.length}</option>)}
                </select>
                <details className="relative">
                  <summary className="cursor-pointer list-none rounded-lg border border-surface-200 bg-white px-3 py-2 text-xs text-surface-600">更多筛选</summary>
                  <div className="absolute left-0 z-20 mt-2 grid w-64 gap-2 rounded-xl border border-surface-200 bg-white p-3 shadow-lg">
                    <select value={filterPipeline} onChange={e => setFilterPipeline(e.target.value)} className="input text-xs"><option value="all">全部管道</option>{pipelines.map(p => <option key={p.key} value={p.key}>{p.name}</option>)}</select>
                    <select value={filterCrmStage} onChange={e => setFilterCrmStage(e.target.value)} className="input text-xs"><option value="all">全部客户阶段</option>{CRM_STAGE_OPTIONS.map(stage => <option key={stage.value} value={stage.value}>{stage.label}</option>)}</select>
                    <select value={filterLevel} onChange={e => setFilterLevel(e.target.value)} className="input text-xs"><option value="all">全部等级</option>{(['S', 'M', 'L', 'XL', 'unknown'] as const).map(l => <option key={l} value={l}>{levelLabels[l]}</option>)}</select>
                    <select value={filterType} onChange={e => setFilterType(e.target.value)} className="input text-xs"><option value="all">全部类型</option>{Object.entries(typeLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                    <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="input text-xs"><option value="all">全部状态</option>{Object.entries(statusLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                  </div>
                </details>
              </div>
              <div className="flex items-center gap-2 h-8">
                <span className={`text-xs text-surface-500 transition-opacity ${selected.size > 0 ? 'opacity-100' : 'opacity-0'}`}>
                  {selected.size > 0 ? `${selected.size} 条已选` : '占位'}
                </span>
                <button onClick={async () => {
                  if (selected.size === 0) return
                  if (!confirm(`确认删除选中的 ${selected.size} 条记录？不可恢复。`)) return
                  for (const id of selected) await deleteItem(id)
                  setSelected(new Set()); setSelectAll(false)
                  const all = await getAllItems(); setItems(all); await loadStats()
                }} className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-all border-none cursor-pointer font-inherit ${
                  selected.size > 0 ? 'text-red-600 hover:bg-red-50' : 'text-transparent pointer-events-none'
                }`}>
                  删除所选
                </button>
              </div>
            </div>
          </div>

          {/* 表格 */}
          <div className="flex-1 overflow-auto min-h-[300px]">
            <table className="w-full text-sm">
              <thead className="bg-surface-50 text-xs text-surface-500 sticky top-0 z-10">
                <tr>
                  <th className="w-10 px-4 py-3 text-left">
                    <input type="checkbox" checked={selectAll}
                      onChange={e => setSelectAll(e.target.checked)} className="rounded border-surface-300" />
                  </th>
                  <th className="px-3 py-3 text-left cursor-pointer select-none hover:text-surface-700 transition-colors" onClick={() => handleSort('company')}>
                    公司 <SortIcon field="company" />
                  </th>
                  <th className="px-3 py-3 text-left">联系人</th>
                  <th className="px-3 py-3 text-left hidden lg:table-cell">邮箱</th>
                  <th className="px-3 py-3 text-left">客户阶段</th>
                  <th className="px-3 py-3 text-left hidden xl:table-cell">上次联系</th>
                  <th className="px-3 py-3 text-left hidden xl:table-cell">下次跟进</th>
                  <th className="px-3 py-3 text-left cursor-pointer select-none w-20 hover:text-surface-700 transition-colors" onClick={() => handleSort('level')}>
                    等级 <SortIcon field="level" />
                  </th>
                  <th className="px-3 py-3 text-left cursor-pointer select-none hidden md:table-cell hover:text-surface-700 transition-colors" onClick={() => handleSort('clientType')}>
                    类型 <SortIcon field="clientType" />
                  </th>
                  <th className="px-3 py-3 text-left cursor-pointer select-none hidden lg:table-cell hover:text-surface-700 transition-colors" onClick={() => handleSort('updatedAt')}>
                    更新 <SortIcon field="updatedAt" />
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-100">
                {paged.length === 0 ? (
                  <tr><td colSpan={10} className="text-center py-16 text-surface-400 text-sm">暂无数据</td></tr>
                ) : paged.map(item => (
                  <tr key={item.id}
                    className={`hover:bg-surface-50 cursor-pointer transition-colors ${selected.has(item.id) ? 'bg-accent-50' : ''}`}
                    onClick={() => navigate(`/item/${item.id}`)}>
                    <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                      <input type="checkbox" checked={selected.has(item.id)}
                        onChange={() => handleSelect(item.id)} className="rounded border-surface-300" />
                    </td>
                    <td className="px-3 py-3">
                      <p className="text-surface-800 font-medium truncate max-w-[200px]">{item.company || item.title}</p>
                    </td>
                    <td className="px-3 py-3 text-surface-600">{item.contactName || '—'}</td>
                    <td className="px-3 py-3 text-surface-600 hidden lg:table-cell">
                      <span className="truncate max-w-[180px] block">{item.email || '—'}</span>
                    </td>
                    <td className="px-3 py-3">
                      <span className="badge bg-blue-50 text-blue-700 text-[10px]">{crmStageLabel(item.primaryStage)}</span>
                    </td>
                    <td className="px-3 py-3 text-xs text-surface-500 hidden xl:table-cell whitespace-nowrap">
                      {crmDate(getLastCustomerContactAt(item))}
                    </td>
                    <td className="px-3 py-3 text-xs text-surface-500 hidden xl:table-cell whitespace-nowrap">
                      {crmDate(getNextCustomerFollowupAt(item))}
                    </td>
                    <td className="px-3 py-3">
                      <span className={`badge text-[10px] ${levelBadge(item.level)}`}>
                        {item.level === 'unknown' ? '—' : item.level}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-xs text-surface-600 hidden md:table-cell">
                      {typeLabels[item.clientType] || '—'}
                    </td>
                    <td className="px-3 py-3 text-xs text-surface-400 hidden lg:table-cell whitespace-nowrap">
                      {new Date(item.updatedAt).toLocaleDateString('zh-CN')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 分页 */}
          <div className="glass-darker border-t border-surface-200 px-6 lg:px-8 py-3 flex items-center justify-between min-h-[52px]">
            <div className="flex items-center gap-2">
              <span className="text-xs text-surface-400">每页</span>
              <select value={pageSize} onChange={e => setPageSize(Number(e.target.value))}
                className="text-xs border border-surface-200 rounded px-1.5 py-1 bg-white">
                {PAGE_SIZES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <span className="text-xs text-surface-400">条</span>
              <span className="text-xs text-surface-300 ml-1">共 {sorted.length} 条</span>
            </div>
            <div className="flex items-center gap-1.5">
              <button onClick={() => setPage(1)} disabled={page <= 1}
                className="btn-ghost text-xs px-2 py-1 disabled:opacity-30">«</button>
              <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}
                className="btn-ghost text-xs px-2 py-1 disabled:opacity-30">‹</button>
              {getPageNumbers(page, totalPages).map((n, i) =>
                n === 0 ? <span key={`e-${i}`} className="text-xs text-surface-400 px-1">...</span> : (
                  <button key={n} onClick={() => setPage(n)}
                    className={`text-xs px-2.5 py-1 rounded ${n === page ? 'bg-accent-600 text-white' : 'text-surface-600 hover:bg-surface-100'}`}>{n}</button>
                )
              )}
              <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages}
                className="btn-ghost text-xs px-2 py-1 disabled:opacity-30">›</button>
              <button onClick={() => setPage(totalPages)} disabled={page >= totalPages}
                className="btn-ghost text-xs px-2 py-1 disabled:opacity-30">»</button>
            </div>
          </div>
        </>
      )}

      {tab === 'isolation' && (
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* 工具栏 */}
          <div className="glass-darker px-6 lg:px-8 py-3 border-b border-surface-200">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 flex-wrap">
                <input type="text" value={isoSearch} onChange={e => setIsoSearch(e.target.value)}
                  placeholder="搜索对象值/原因/备注..."
                  className="input w-56 text-xs" />
                <select value={isoType} onChange={e => setIsoType(e.target.value)}
                  className="input w-28 text-xs">
                  {ISOLATION_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-surface-500">共 {isolationTotal} 条</span>
                <button onClick={() => void loadIsolation()}
                  className="rounded bg-surface-900 px-3 py-1.5 text-xs font-semibold text-white">刷新</button>
              </div>
            </div>
          </div>

          {/* 表格 */}
          <div className="flex-1 overflow-auto min-h-[300px]">
            {isolationError ? (
              <div className="flex h-48 flex-col items-center justify-center gap-2">
                <p className="text-sm text-red-600">隔离库加载失败：{isolationError}</p>
                <button onClick={() => void loadIsolation()} className="text-xs text-blue-600 underline">重试</button>
              </div>
            ) : isolationLoading ? (
              <div className="flex h-48 items-center justify-center text-sm text-surface-400">加载中...</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-surface-50 text-xs text-surface-500 sticky top-0 z-10">
                  <tr>
                    <th className="px-3 py-3 text-left w-20">对象类型</th>
                    <th className="px-3 py-3 text-left">对象值</th>
                    <th className="px-3 py-3 text-left">隔离原因</th>
                    <th className="px-3 py-3 text-left hidden lg:table-cell">来源环节</th>
                    <th className="px-3 py-3 text-left">隔离时间</th>
                    <th className="px-3 py-3 text-left w-20">永久</th>
                    <th className="px-3 py-3 text-left hidden md:table-cell">备注</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-surface-100">
                  {isolationRows.length === 0 ? (
                    <tr><td colSpan={7} className="text-center py-16 text-surface-400 text-sm">暂无隔离记录</td></tr>
                  ) : isolationRows.map((entry, index) => (
                    <tr key={`${entry.objectType}:${entry.objectValue}:${index}`} className="hover:bg-surface-50 transition-colors">
                      <td className="px-3 py-3">
                        <span className={`badge text-[10px] ${entry.objectType === 'company' ? 'bg-blue-50 text-blue-700' : entry.objectType === 'domain' ? 'bg-violet-50 text-violet-700' : entry.objectType === 'email' ? 'bg-amber-50 text-amber-700' : 'bg-surface-100 text-surface-600'}`}>
                          {cnObjectType(entry.objectType)}
                        </span>
                      </td>
                      <td className="px-3 py-3 font-medium text-surface-800 break-all max-w-[280px]">{entry.objectValue}</td>
                      <td className="px-3 py-3 text-surface-600 max-w-[220px] break-words">{zh(entry.reason) || '—'}</td>
                      <td className="px-3 py-3 text-surface-600 hidden lg:table-cell">{cnStatus(entry.sourceStage)}</td>
                      <td className="px-3 py-3 text-surface-500 whitespace-nowrap">{new Date(entry.isolatedAt).toLocaleString('zh-CN')}</td>
                      <td className="px-3 py-3">
                        <span className={`badge text-[10px] ${entry.permanent ? 'bg-red-50 text-red-700' : 'bg-surface-100 text-surface-600'}`}>{cnBoolean(entry.permanent)}</span>
                      </td>
                      <td className="px-3 py-3 text-surface-500 hidden md:table-cell max-w-[200px] break-words">{zh(entry.note) || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* 分页 */}
          <div className="glass-darker border-t border-surface-200 px-6 lg:px-8 py-3 flex items-center justify-between min-h-[52px]">
            <div className="flex items-center gap-2">
              <span className="text-xs text-surface-400">每页</span>
              <select value={isoPageSize} onChange={e => setIsoPageSize(Number(e.target.value))}
                className="text-xs border border-surface-200 rounded px-1.5 py-1 bg-white">
                {[20, 50, 100].map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <span className="text-xs text-surface-400">条</span>
            </div>
            <div className="flex items-center gap-1.5">
              <button onClick={() => setIsoPage(1)} disabled={isoPage <= 1}
                className="btn-ghost text-xs px-2 py-1 disabled:opacity-30">«</button>
              <button onClick={() => setIsoPage(p => Math.max(1, p - 1))} disabled={isoPage <= 1}
                className="btn-ghost text-xs px-2 py-1 disabled:opacity-30">‹</button>
              <span className="text-xs text-surface-500 px-1">第 {isolationTotal === 0 ? 0 : Math.min(isoPage, Math.ceil(isolationTotal / isoPageSize))} / {Math.max(1, Math.ceil(isolationTotal / isoPageSize))} 页</span>
              <button onClick={() => setIsoPage(p => Math.min(Math.ceil(isolationTotal / isoPageSize), p + 1))} disabled={isoPage >= Math.ceil(isolationTotal / isoPageSize)}
                className="btn-ghost text-xs px-2 py-1 disabled:opacity-30">›</button>
              <button onClick={() => setIsoPage(Math.ceil(isolationTotal / isoPageSize))} disabled={isoPage >= Math.ceil(isolationTotal / isoPageSize)}
                className="btn-ghost text-xs px-2 py-1 disabled:opacity-30">»</button>
            </div>
          </div>
        </div>
      )}

      {tab === 'backup' && (
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto p-6 lg:p-8 space-y-6">
            {/* 状态提示 */}
            {statusMsg && (
              <div className={`px-4 py-3 rounded-xl text-sm ${
                statusMsg.type === 'ok'
                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                  : 'bg-red-50 text-red-700 border border-red-200'
              }`}>
                {statusMsg.msg}
              </div>
            )}

            {/* 数据库状态 */}
            <div className="stat-card">
              <h2 className="text-sm font-semibold text-surface-800 mb-4">数据库状态</h2>
              {stats ? (
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  <StatBox label="客户记录" value={stats.items} />
                  <StatBox label="关键词" value={stats.keywords} />
                  <StatBox label="邮件模板" value={stats.templates} />
                  <StatBox label="估算存储" value={stats.estimatedSize} />
                </div>
              ) : <p className="text-sm text-surface-400">加载中...</p>}

              {stats && Object.keys(stats.pipelines).length > 0 && (
                <div className="mt-4 pt-4 border-t border-surface-100">
                  <span className="section-title block mb-2">各管道分布</span>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(stats.pipelines).map(([k, v]) => (
                      <span key={k} className="badge bg-surface-100 text-surface-600">
                        {pipelineNames[k] || k}: {v}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {stats && Object.keys(stats.levels).length > 0 && (
                <div className="mt-3 pt-3 border-t border-surface-100">
                  <span className="section-title block mb-2">等级分布</span>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(stats.levels).map(([k, v]) => (
                      <span key={k} className="badge bg-surface-50 text-surface-600">
                        {levelLabels[k] || k}: {v}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {stats && stats.items > 0 && (
                <p className="text-[10px] text-surface-400 mt-3 pt-3 border-t border-surface-100">
                  活跃工单: {stats.activeItems} · 数据存储在本地 IndexedDB · 每15次操作自动备份
                </p>
              )}
            </div>

            {/* 备份操作 */}
            <div className="stat-card">
              <h2 className="text-sm font-semibold text-surface-800 mb-4">备份与恢复</h2>
              <div className="space-y-3">
                <div className="flex items-center justify-between p-3 bg-surface-50 rounded-xl">
                  <div>
                    <p className="text-sm font-medium text-surface-700">导出备份</p>
                    <p className="text-xs text-surface-400 mt-0.5">将所有数据导出为 JSON 文件</p>
                  </div>
                  <button onClick={handleExport} disabled={!stats || stats.items === 0}
                    className="btn-primary text-xs disabled:opacity-40">导出</button>
                </div>
                <div className="flex items-center justify-between p-3 bg-surface-50 rounded-xl">
                  <div>
                    <p className="text-sm font-medium text-surface-700">手动备份</p>
                    <p className="text-xs text-surface-400 mt-0.5">立即同步数据到后端备份文件</p>
                  </div>
                  <button onClick={async () => { await loadFromDisk(); showStatus('ok', '数据已同步') }}
                    disabled={!stats || stats.items === 0}
                    className="btn-primary text-xs disabled:opacity-40">同步</button>
                </div>
                <div className="flex items-center justify-between p-3 bg-surface-50 rounded-xl">
                  <div>
                    <p className="text-sm font-medium text-surface-700">导入恢复</p>
                    <p className="text-xs text-surface-400 mt-0.5">从备份文件恢复数据（会覆盖当前数据）</p>
                  </div>
                  <button onClick={handleImport} className="btn-primary text-xs">导入</button>
                </div>
                <div className="flex items-center justify-between p-3 bg-amber-50 rounded-xl border border-amber-200">
                  <div>
                    <p className="text-sm font-medium text-amber-700">去重（按公司名）</p>
                    <p className="text-xs text-amber-400 mt-0.5">同名公司保留最新一条，合并发信记录</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {dedupResult && <span className="text-xs text-green-600">{dedupResult}</span>}
                    <button onClick={() => { if (confirmDedup) handleDedup(); else setConfirmDedup(true) }}
                      className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-all border-none cursor-pointer font-inherit ${
                        confirmDedup ? 'bg-amber-600 text-white' : 'bg-amber-100 text-amber-700 hover:bg-amber-200'
                      }`}>
                      {confirmDedup ? '点击确认' : '去重'}
                    </button>
                  </div>
                </div>

                <div className="flex items-center justify-between p-3 bg-surface-50 rounded-xl border border-surface-200">
                  <div>
                    <p className="text-sm font-medium text-surface-700">从后端恢复</p>
                    <p className="text-xs text-surface-400 mt-0.5">从后端备份恢复丢失的客户数据</p>
                  </div>
                  <button onClick={handleRestoreFromBackend} className="btn-primary text-xs">恢复</button>
                </div>
                <div className="flex items-center justify-between p-3 bg-surface-50 rounded-xl border border-surface-200">
                  <div>
                    <p className="text-sm font-medium text-surface-700">修复背调字段</p>
                    <p className="text-xs text-surface-400 mt-0.5">将旧格式 backcheck → backCheck，恢复背调数据显示</p>
                  </div>
                  <button onClick={handleMigrateBackcheck} className="btn-primary text-xs">修复</button>
                </div>
                <div className="flex items-center justify-between p-3 bg-purple-50 rounded-xl border border-purple-200">
                  <div>
                    <p className="text-sm font-medium text-purple-700">LLM批量分类</p>
                    <p className="text-xs text-purple-400 mt-0.5">使用LLM对未分类客户进行智能分类（仅处理有摘要或公司名称的unknown项）</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {llmClassifying && (
                      <span className="text-xs text-purple-600 font-medium">{llmProgress.done}/{llmProgress.total}</span>
                    )}
                    {llmResult && <span className="text-xs text-green-600 font-medium">{llmResult}</span>}
                    <button onClick={handleLlmClassify} disabled={llmClassifying}
                      className="text-xs px-3 py-1.5 rounded-lg font-medium transition-all border-none cursor-pointer font-inherit disabled:opacity-40 bg-purple-600 text-white hover:bg-purple-700">
                      {llmClassifying ? '分类中...' : '🧠 LLM批量分类'}
                    </button>
                  </div>
                </div>
                <div className="flex items-center justify-between p-3 bg-red-50 rounded-xl border border-red-200">
                  <div>
                    <p className="text-sm font-medium text-red-700">清空所有数据</p>
                    <p className="text-xs text-red-400 mt-0.5">不可恢复，请先导出备份</p>
                  </div>
                  <button onClick={() => setConfirmClear(true)}
                    className="text-xs px-3 py-1.5 rounded-lg font-medium bg-red-100 text-red-700 hover:bg-red-200 transition-all">
                    清空
                  </button>
                </div>

                {/* 清空确认弹窗 */}
                {confirmClear && (
                  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setConfirmClear(false)}>
                    <div className="bg-white rounded-xl shadow-xl p-6 max-w-sm mx-4" onClick={e => e.stopPropagation()}>
                      <p className="text-sm font-semibold text-surface-900 mb-2">确认清空所有数据？</p>
                      <p className="text-xs text-surface-500 mb-5">此操作不可恢复，建议先导出备份。</p>
                      <div className="flex items-center gap-3 justify-end">
                        <button onClick={() => setConfirmClear(false)}
                          className="px-4 py-2 rounded-lg text-xs font-medium text-surface-600 bg-surface-100 hover:bg-surface-200 border-none cursor-pointer font-inherit transition-colors">
                          取消
                        </button>
                        <button onClick={handleClear}
                          className="px-4 py-2 rounded-lg text-xs font-bold text-white bg-red-600 hover:bg-red-700 border-none cursor-pointer font-inherit transition-colors">
                          确认清空
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="stat-card bg-surface-50 border-surface-100">
              <h2 className="text-sm font-semibold text-surface-800 mb-2">数据存储说明</h2>
              <ul className="text-xs text-surface-500 space-y-1.5 leading-relaxed">
                <li>• 所有数据存储在本地 IndexedDB，不依赖网络或服务器</li>
                <li>• EXE 模式数据保存在 %APPDATA%，不受浏览器清理影响</li>
                <li>• 建议定期导出备份，尤其是修改客户等级/背调/发信后</li>
                <li>• 导入备份会覆盖当前所有数据，操作前确认已导出</li>
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function StatBox({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="p-3 bg-surface-50 rounded-xl text-center">
      <p className="text-2xl font-semibold text-surface-900">{value}</p>
      <p className="text-xs text-surface-400 mt-0.5">{label}</p>
    </div>
  )
}

function getPageNumbers(current: number, total: number): number[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  const pages: number[] = [1]
  if (current > 3) pages.push(0)
  const start = Math.max(2, current - 1)
  const end = Math.min(total - 1, current + 1)
  for (let i = start; i <= end; i++) pages.push(i)
  if (current < total - 2) pages.push(0)
  pages.push(total)
  return pages
}
