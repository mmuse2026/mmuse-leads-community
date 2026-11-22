import { useState, useEffect } from 'react'

interface PlanTask {
  id: string
  title: string
  phase: string         // 阶段，如 "计划任务"、"执行中"、"复盘"
  category: string      // 分类，如 "客户开发"、"产品优化"、"内容运营"
  priority: 'high' | 'medium' | 'normal'
  status: 'planned' | 'active' | 'done'
  dueAt: string         // ISO date string
  target: string        // 目标描述
  description: string
  createdAt: string
  updatedAt: string
}

const STORAGE_KEY = 'mmuse_plan_tasks'

const PRIORITY_LABEL: Record<string, string> = { high: '高', medium: '中', normal: '低' }
const PRIORITY_COLOR: Record<string, string> = { high: '#e74c3c', medium: '#f39c12', normal: '#95a5a6' }
const STATUS_LABEL: Record<string, string> = { planned: '计划中', active: '进行中', done: '已完成' }

const PHASES = ['计划任务', '执行中', '复盘']
const CATEGORIES = ['客户开发', '产品优化', '内容运营', '市场调研', '其他']

const PRIORITY_FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'high', label: '高' },
  { key: 'medium', label: '中' },
  { key: 'normal', label: '低' },
] as const

const STATUS_COLUMNS: Array<{ key: 'planned' | 'active' | 'done'; label: string }> = [
  { key: 'planned', label: '计划中' },
  { key: 'active', label: '进行中' },
  { key: 'done', label: '已完成' },
]

function loadTasks(): PlanTask[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export default function PlanTasks() {
  const [tasks, setTasks] = useState<PlanTask[]>(loadTasks)
  const [priorityFilter, setPriorityFilter] = useState('all')
  const [showModal, setShowModal] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  // form state
  const [formTitle, setFormTitle] = useState('')
  const [formPhase, setFormPhase] = useState('计划任务')
  const [formCategory, setFormCategory] = useState('客户开发')
  const [formPriority, setFormPriority] = useState<'high' | 'medium' | 'normal'>('medium')
  const [formStatus, setFormStatus] = useState<'planned' | 'active' | 'done'>('planned')
  const [formDueAt, setFormDueAt] = useState('')
  const [formTarget, setFormTarget] = useState('')
  const [formDescription, setFormDescription] = useState('')

  // persist to localStorage on every change
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks))
  }, [tasks])

  // ---- form helpers ----
  function resetForm() {
    setFormTitle('')
    setFormPhase('计划任务')
    setFormCategory('客户开发')
    setFormPriority('medium')
    setFormStatus('planned')
    setFormDueAt('')
    setFormTarget('')
    setFormDescription('')
  }

  function openNew() {
    setEditingId(null)
    resetForm()
    setShowModal(true)
  }

  function openEdit(task: PlanTask) {
    setEditingId(task.id)
    setFormTitle(task.title)
    setFormPhase(task.phase)
    setFormCategory(task.category)
    setFormPriority(task.priority)
    setFormStatus(task.status)
    setFormDueAt(task.dueAt ? task.dueAt.slice(0, 10) : '')
    setFormTarget(task.target)
    setFormDescription(task.description)
    setShowModal(true)
  }

  function handleSave() {
    if (!formTitle.trim()) return
    const now = new Date().toISOString()
    if (editingId) {
      setTasks(prev =>
        prev.map(t =>
          t.id === editingId
            ? {
                ...t,
                title: formTitle.trim(),
                phase: formPhase,
                category: formCategory,
                priority: formPriority,
                status: formStatus,
                dueAt: formDueAt,
                target: formTarget,
                description: formDescription,
                updatedAt: now,
              }
            : t,
        ),
      )
    } else {
      const newTask: PlanTask = {
        id: crypto.randomUUID(),
        title: formTitle.trim(),
        phase: formPhase,
        category: formCategory,
        priority: formPriority,
        status: formStatus,
        dueAt: formDueAt,
        target: formTarget,
        description: formDescription,
        createdAt: now,
        updatedAt: now,
      }
      setTasks(prev => [...prev, newTask])
    }
    setShowModal(false)
  }

  function handleDelete(id: string) {
    setTasks(prev => prev.filter(t => t.id !== id))
  }

  function toggleStatus(task: PlanTask) {
    const next: Record<string, 'planned' | 'active' | 'done'> = {
      planned: 'active',
      active: 'done',
      done: 'planned',
    }
    setTasks(prev =>
      prev.map(t =>
        t.id === task.id
          ? { ...t, status: next[t.status], updatedAt: new Date().toISOString() }
          : t,
      ),
    )
  }

  // compute filtered + grouped data
  const filtered =
    priorityFilter === 'all'
      ? tasks
      : tasks.filter(t => t.priority === priorityFilter)

  const grouped = {
    planned: filtered.filter(t => t.status === 'planned'),
    active: filtered.filter(t => t.status === 'active'),
    done: filtered.filter(t => t.status === 'done'),
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* 标题栏 */}
      <div className="px-6 lg:px-8 py-3 flex items-center justify-between border-b border-surface-100">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-bold text-surface-900">计划任务</h1>
          <span className="badge bg-surface-100 text-surface-500 text-[11px]">
            {tasks.length} 个任务
          </span>
        </div>
        <button onClick={openNew} className="btn-primary text-xs px-3 py-1.5">
          + 新建任务
        </button>
      </div>

      <div className="px-6 lg:px-8 py-3 border-b border-surface-100 bg-surface-50">
        <select value={priorityFilter} onChange={event => setPriorityFilter(event.target.value as typeof priorityFilter)} className="input w-40 text-xs">
          {PRIORITY_FILTERS.map(filter => <option key={filter.key} value={filter.key}>{filter.label}优先级</option>)}
        </select>
      </div>

      {/* 三栏看板 */}
      <div className="flex-1 overflow-x-auto">
        <div className="flex h-full gap-4 p-5 min-w-[900px]">
          {STATUS_COLUMNS.map(({ key, label }) => (
            <div key={key} className="flex-1 flex flex-col min-h-0">
              {/* 栏目标题 */}
              <div className="flex items-center justify-between mb-3 px-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold text-surface-800">{label}</span>
                  <span className="text-[10px] font-medium text-surface-400 bg-surface-100 px-1.5 py-0.5 rounded">
                    {grouped[key].length}
                  </span>
                </div>
              </div>

              {/* 卡片列表 */}
              <div className="flex-1 overflow-y-auto space-y-3">
                {grouped[key].length === 0 ? (
                  <div className="text-center py-10 text-surface-300 text-xs">
                    暂无任务
                  </div>
                ) : (
                  grouped[key].map(task => (
                    <div
                      key={task.id}
                      className="bg-surface-0 border border-surface-200 rounded-xl p-4 hover:border-surface-300 hover:shadow-sm transition-all"
                    >
                      {/* 标题 + 优先级标签 */}
                      <div className="flex items-start justify-between mb-2">
                        <p className="text-sm font-semibold text-surface-900 flex-1 min-w-0 truncate">
                          {task.title}
                        </p>
                        <span
                          className="text-[10px] font-semibold text-white px-1.5 py-0.5 rounded ml-2 shrink-0"
                          style={{ backgroundColor: PRIORITY_COLOR[task.priority] }}
                        >
                          {PRIORITY_LABEL[task.priority]}
                        </span>
                      </div>

                      {/* 阶段 + 分类 */}
                      <div className="flex items-center gap-1.5 mb-2 flex-wrap">
                        <span className="text-[10px] text-surface-500 bg-surface-50 border border-surface-200 px-1.5 py-0.5 rounded">
                          {task.phase}
                        </span>
                        <span className="text-[10px] text-surface-500 bg-surface-50 border border-surface-200 px-1.5 py-0.5 rounded">
                          {task.category}
                        </span>
                      </div>

                      {/* 到期日 */}
                      {task.dueAt && (
                        <p className="text-[11px] text-surface-400 mb-2">
                          截止: {new Date(task.dueAt).toLocaleDateString('zh-CN')}
                        </p>
                      )}

                      {/* 操作按钮 */}
                      <div className="flex items-center gap-1 pt-2 border-t border-surface-100">
                        <button
                          onClick={() => toggleStatus(task)}
                          className="text-[10px] font-medium px-2 py-1 rounded border border-surface-200 text-surface-500 hover:text-surface-700 hover:border-surface-400 bg-transparent cursor-pointer font-inherit"
                        >
                          {key === 'planned'
                            ? '开始'
                            : key === 'active'
                              ? '完成'
                              : '重开'}
                        </button>
                        <button
                          onClick={() => openEdit(task)}
                          className="text-[10px] font-medium px-2 py-1 rounded border border-surface-200 text-surface-500 hover:text-surface-700 hover:border-surface-400 bg-transparent cursor-pointer font-inherit"
                        >
                          编辑
                        </button>
                        <button
                          onClick={() => handleDelete(task.id)}
                          className="text-[10px] font-medium px-2 py-1 rounded border border-red-200 text-red-500 hover:bg-red-50 bg-transparent cursor-pointer font-inherit ml-auto"
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 新建/编辑弹窗 */}
      {showModal && (
        <div
          className="fixed inset-0 z-50 bg-black/30 backdrop-blur-sm flex items-center justify-center"
          onClick={() => setShowModal(false)}
        >
          <div
            className="bg-surface-0 rounded-xl shadow-float p-6 w-full max-w-lg mx-4 border border-surface-200 max-h-[90vh] overflow-y-auto"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-surface-900 mb-4">
              {editingId ? '编辑任务' : '新建任务'}
            </h3>

            <div className="space-y-3">
              {/* 标题 */}
              <div>
                <label className="text-xs font-medium text-surface-600 mb-1 block">
                  标题 <span className="text-red-400">*</span>
                </label>
                <input
                  value={formTitle}
                  onChange={e => setFormTitle(e.target.value)}
                  placeholder="任务标题"
                  className="input w-full text-sm"
                  autoFocus
                />
              </div>

              {/* 阶段 */}
              <div>
                <label className="text-xs font-medium text-surface-600 mb-1 block">
                  阶段
                </label>
                <select
                  value={formPhase}
                  onChange={e => setFormPhase(e.target.value)}
                  className="w-full text-sm bg-surface-50 border border-surface-200 rounded-lg px-3 py-[6px] outline-none focus:border-surface-400 font-inherit"
                >
                  {PHASES.map(p => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>

              {/* 分类 */}
              <div>
                <label className="text-xs font-medium text-surface-600 mb-1 block">
                  分类
                </label>
                <select
                  value={formCategory}
                  onChange={e => setFormCategory(e.target.value)}
                  className="w-full text-sm bg-surface-50 border border-surface-200 rounded-lg px-3 py-[6px] outline-none focus:border-surface-400 font-inherit"
                >
                  {CATEGORIES.map(c => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>

              {/* 优先级 */}
              <div>
                <label className="text-xs font-medium text-surface-600 mb-1 block">
                  优先级
                </label>
                <select
                  value={formPriority}
                  onChange={e =>
                    setFormPriority(e.target.value as 'high' | 'medium' | 'normal')
                  }
                  className="w-full text-sm bg-surface-50 border border-surface-200 rounded-lg px-3 py-[6px] outline-none focus:border-surface-400 font-inherit"
                >
                  <option value="high">高</option>
                  <option value="medium">中</option>
                  <option value="normal">低</option>
                </select>
              </div>

              {/* 状态 */}
              <div>
                <label className="text-xs font-medium text-surface-600 mb-1 block">
                  状态
                </label>
                <select
                  value={formStatus}
                  onChange={e =>
                    setFormStatus(e.target.value as 'planned' | 'active' | 'done')
                  }
                  className="w-full text-sm bg-surface-50 border border-surface-200 rounded-lg px-3 py-[6px] outline-none focus:border-surface-400 font-inherit"
                >
                  <option value="planned">计划中</option>
                  <option value="active">进行中</option>
                  <option value="done">已完成</option>
                </select>
              </div>

              {/* 到期日 */}
              <div>
                <label className="text-xs font-medium text-surface-600 mb-1 block">
                  到期日
                </label>
                <input
                  type="date"
                  value={formDueAt}
                  onChange={e => setFormDueAt(e.target.value)}
                  className="w-full text-sm bg-surface-50 border border-surface-200 rounded-lg px-3 py-[6px] outline-none focus:border-surface-400 font-inherit"
                />
              </div>

              {/* 目标描述 */}
              <div>
                <label className="text-xs font-medium text-surface-600 mb-1 block">
                  目标描述
                </label>
                <textarea
                  value={formTarget}
                  onChange={e => setFormTarget(e.target.value)}
                  rows={3}
                  placeholder="目标描述..."
                  className="w-full text-sm bg-surface-50 border border-surface-200 rounded-lg px-3 py-2 outline-none focus:border-surface-400 font-inherit resize-none"
                />
              </div>

              {/* 详细描述 */}
              <div>
                <label className="text-xs font-medium text-surface-600 mb-1 block">
                  详细描述
                </label>
                <textarea
                  value={formDescription}
                  onChange={e => setFormDescription(e.target.value)}
                  rows={4}
                  placeholder="详细描述..."
                  className="w-full text-sm bg-surface-50 border border-surface-200 rounded-lg px-3 py-2 outline-none focus:border-surface-400 font-inherit resize-none"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-5">
              <button
                onClick={() => setShowModal(false)}
                className="btn-ghost text-xs"
              >
                取消
              </button>
              <button
                onClick={handleSave}
                disabled={!formTitle.trim()}
                className="btn-primary text-xs"
              >
                {editingId ? '保存修改' : '创建任务'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
