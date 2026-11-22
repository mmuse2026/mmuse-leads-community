import { useEffect, useMemo, useState } from 'react'

export function usePagination<T>(items: T[], pageSize = 50) {
  const [page, setPage] = useState(1)
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize))
  const safePage = Math.min(page, pageCount)
  useEffect(() => {
    setPage(1)
  }, [items.length, pageSize])
  const pageItems = useMemo(() => {
    const start = (safePage - 1) * pageSize
    return items.slice(start, start + pageSize)
  }, [items, safePage, pageSize])

  return { page: safePage, setPage, pageCount, pageItems, pageSize }
}

export function PaginationBar({ page, pageCount, total, pageSize, onPageChange }: {
  page: number
  pageCount: number
  total: number
  pageSize: number
  onPageChange: (page: number) => void
}) {
  if (total <= pageSize) return null
  const start = (page - 1) * pageSize + 1
  const end = Math.min(total, page * pageSize)
  return (
    <div className="flex items-center justify-between gap-3 py-3 text-xs text-surface-500">
      <span>{start}-{end} / {total}</span>
      <div className="flex items-center gap-1">
        <button onClick={() => onPageChange(1)} disabled={page <= 1} className="px-2 py-1 rounded border border-surface-200 bg-white disabled:opacity-40">首页</button>
        <button onClick={() => onPageChange(page - 1)} disabled={page <= 1} className="px-2 py-1 rounded border border-surface-200 bg-white disabled:opacity-40">上一页</button>
        <span className="px-2 py-1 text-surface-600">{page}/{pageCount}</span>
        <button onClick={() => onPageChange(page + 1)} disabled={page >= pageCount} className="px-2 py-1 rounded border border-surface-200 bg-white disabled:opacity-40">下一页</button>
        <button onClick={() => onPageChange(pageCount)} disabled={page >= pageCount} className="px-2 py-1 rounded border border-surface-200 bg-white disabled:opacity-40">末页</button>
      </div>
    </div>
  )
}


