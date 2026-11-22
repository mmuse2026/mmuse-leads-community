import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'

function text(value: unknown): string { return typeof value === 'string' ? value.trim() : '' }

/** 供应商池清单条目：只读展示，仅用于了解供应商做什么，不参与主开发流程 */
export interface SupplierPoolEntry { company: string; country?: string; products?: string[]; website: string; category: 'supplier'; addedAt: string }
export function supplierPoolFilePath(custom?: string): string { return custom || path.resolve(process.cwd(), 'tools', 'suppliers_pool.json') }
/** 追加/去重供应商到 tools/suppliers_pool.json（按 website/company 去重，缺失信息补充，不覆盖既有 products） */
export function appendSupplierToPool(item: any, customPath?: string): SupplierPoolEntry {
  const file = supplierPoolFilePath(customPath)
  let pool: SupplierPoolEntry[] = []
  if (existsSync(file)) { try { const parsed = JSON.parse(readFileSync(file, 'utf8')); if (Array.isArray(parsed)) pool = parsed } catch { pool = [] } }
  const entry: SupplierPoolEntry = {
    company: text(item.company || item.title),
    country: text(item.country) || undefined,
    products: Array.isArray(item.backCheck?.products) && item.backCheck.products.length ? item.backCheck.products.map((p: unknown) => String(p)) : undefined,
    website: text(item.website),
    category: 'supplier',
    addedAt: new Date().toISOString(),
  }
  const key = (entry.website || entry.company).toLowerCase()
  const idx = pool.findIndex(e => (e.website || '').toLowerCase() === key || (key && !e.website && (e.company || '').toLowerCase() === entry.company.toLowerCase()))
  if (idx >= 0) pool[idx] = { ...pool[idx], ...entry, products: pool[idx].products || entry.products, category: 'supplier' }
  else pool.push(entry)
  const dir = path.dirname(file)
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(file, JSON.stringify(pool, null, 2), 'utf8')
  return entry
}
