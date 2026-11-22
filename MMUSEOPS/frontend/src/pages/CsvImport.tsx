import { useState, useRef, useMemo, useEffect } from 'react'
import Papa from 'papaparse'
import { saveItem, getAllItems } from '../store/db'
import type { PipelineItem, ClientLevel, ClientType, OutreachSource, EmailVerification } from '../types/item'
import type { PipelineKey } from '../types/pipeline'

interface ImportRow {
  company: string
  website: string
  contactName: string
  email: string
  level: ClientLevel
  clientType: ClientType
  source: OutreachSource
  companySize: string
  emailVerification: EmailVerification
  emailBounced: boolean
  developmentStatus: 'pending' | 'new' | 'backcheck_done' | 'sent' | 'skipped' | 'shelved'
  notes: string
  bizInfo: string
}

/** 中文列名 → 字段映射 */
const COLUMN_MAP: Record<string, (val: string) => Partial<ImportRow>> = {
  '公司': v => ({ company: v.trim() }),
  '企业': v => ({ company: v.trim() }),
  'business': v => ({ company: v.trim() }),
  '网站': v => ({ website: v.trim() }),
  'website': v => ({ website: v.trim() }),
  '决策人': v => ({ contactName: v.trim() }),
  '联系人': v => ({ contactName: v.trim() }),
  '联系方式': v => ({ email: v.trim() }),
  '邮箱': v => ({ email: v.trim() }),
  'email': v => ({ email: v.trim() }),
  '等级': v => ({ level: mapLevel(v.trim()) }),
  '业务类型': v => ({ clientType: mapClientType(v.trim()), bizInfo: v.trim() }),
  '类型': v => ({ clientType: mapClientType(v.trim()), bizInfo: v.trim() }),
  'grade': v => ({ level: mapLevel(v.trim()) }),
  '渠道': v => ({ source: mapSource(v.trim()) }),
  'source': v => ({ source: mapSource(v.trim()) }),
  '进口/规模数据': v => ({ companySize: v.trim() }),
  '规模': v => ({ companySize: v.trim() }),
  '员工': v => ({ companySize: v.trim() }),
  '产品匹配': v => ({ notes: v.trim() }),
  '背调结论': v => ({ notes: v.trim() }),
  '下一步': v => ({ notes: v.trim() }),
  '状态': v => ({ developmentStatus: mapDevStatus(v.trim()) }),
  '邮箱验证状态': v => ({ emailVerification: mapVerification(v.trim()) }),
  '退信': v => ({ emailBounced: v.trim().toUpperCase() === 'BOUNCED' || v.trim().toUpperCase() === 'TRUE' }),
  '职位': v => ({ bizInfo: v.trim() }),
  'titles': v => ({ bizInfo: v.trim() }),
  '业务线': v => ({ bizInfo: v.trim() }),
}

function mapLevel(v: string): ClientLevel {
  if (v === 'P0') return 'XL'
  if (v === 'P1') return 'L'
  if (v === 'P2') return 'M'
  if (v === 'P3') return 'unknown'
  if (v === 'XL' || v === 'L' || v === 'M' || v === 'S') return v as ClientLevel
  return 'unknown'
}

function mapClientType(v: string): ClientType {
  const lower = v.toLowerCase()
  if (lower.includes('经销') || lower.includes('distribut')) return 'distributor'
  if (lower.includes('贸易') || lower.includes('trad')) return 'trader'
  if (lower.includes('电商') || lower.includes('ecom')) return 'ecommerce'
  if (lower.includes('批发') || lower.includes('wholesale')) return 'wholesaler'
  if (lower.includes('零售') || lower.includes('retail')) return 'retailer'
  if (lower.includes('厂') || lower.includes('manufactur') || lower.includes('品牌')) return 'manufacturer'
  return 'unknown'
}

function mapSource(v: string): OutreachSource {
  const m: Record<string, OutreachSource> = {
    '进口经销商': 'google', '展会': 'exhibition', 'B2B平台': 'google',
    '海关数据': 'google', '品牌商': 'google', '同行推荐': 'referral',
    '官网自荐': 'website', '社媒': 'social', '手动录入': 'manual',
    '区域经销商': 'google', '连锁餐厅': 'google', 'maps': 'maps',
    'serper': 'serper', 'importyeti': 'importyeti', 'google': 'google',
  }
  return m[v] || 'google'
}

function mapDevStatus(v: string): 'pending' | 'new' | 'backcheck_done' | 'sent' | 'skipped' | 'shelved' {
  const lower = v.toLowerCase()
  if (lower.includes('已发') || lower.includes('sent')) return 'sent'
  if (lower.includes('停止') || lower.includes('搁置') || lower.includes('skip') || lower.includes('退信')) return 'skipped'
  if (lower.includes('待') || lower.includes('pending')) return 'pending'
  return 'pending'
}

function mapVerification(v: string): EmailVerification {
  const upper = v.toUpperCase()
  if (upper.includes('VALID') || upper.includes('VERIFIED') || upper.includes('SENT_OK')) return 'verified'
  if (upper.includes('CATCHALL')) return 'catchall'
  if (upper.includes('RISKY')) return 'risky'
  if (upper.includes('INVALID') || upper.includes('BOUNCED')) return 'invalid'
  return 'unknown'
}

function generateId(): string {
  return crypto.randomUUID()
}

function now(): string {
  return new Date().toISOString()
}

export default function CsvImport() {
  const fileRef = useRef<HTMLInputElement>(null)
  const [parsed, setParsed] = useState<ImportRow[] | null>(null)
  const [rawHeaders, setRawHeaders] = useState<string[]>([])
  const [rawRows, setRawRows] = useState<Record<string, string>[]>([])
  const [duplicateCount, setDuplicateCount] = useState(0)
  const [status, setStatus] = useState<{ type: 'ok' | 'error' | 'info'; msg: string } | null>(null)
  const [importing, setImporting] = useState(false)
  const [dragOver, setDragOver] = useState(false)

  const showStatus = (type: 'ok' | 'error' | 'info', msg: string) => {
    setStatus({ type, msg })
    setTimeout(() => setStatus(null), 6000)
  }

  const parseFile = (file: File) => {
    if (!file.name.endsWith('.csv')) {
      showStatus('error', '请选择 CSV 文件')
      return
    }

    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      encoding: 'UTF-8',
      complete: (result: Papa.ParseResult<Record<string, string>>) => {
        if (result.errors.length > 0) {
          console.warn('CSV 解析警告:', result.errors)
        }
        const headers = result.meta.fields || []
        const rows = result.data.filter((r: Record<string, string>) => Object.values(r).some(v => v?.trim()))
        if (rows.length === 0) {
          showStatus('error', 'CSV 文件为空或格式不对')
          return
        }
        setRawHeaders(headers)
        setRawRows(rows)
        // 映射
        const mapped = rows.map((r: Record<string, string>) => {
          const row: Partial<ImportRow> = {}
          let hasContact = false
          for (const [key, val] of Object.entries(r)) {
            const trimmed = key.trim()
            const mapper = COLUMN_MAP[trimmed] || findFuzzyMatch(trimmed)
            if (mapper) {
              const result = mapper(val || '')
              Object.assign(row, result)
              if (result.contactName || result.email) hasContact = true
            }
          }
          // 如果公司名空着但有网站，用网站替代
          if (!row.company && row.website) {
            row.company = row.website.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '')
          }
          // 清理编码问题字符
          const clean = (s: string) => (s || '').replace(/\?{2,}/g, '').replace(/\s+\?\s+/g, ' ').replace(/\s{2,}/g, ' ').trim()
          row.company = clean(row.company || '')
          row.contactName = clean(row.contactName || '')
          row.notes = clean(row.notes || '')
          return {
            company: row.company || '(未命名)',
            website: row.website || '',
            contactName: row.contactName || '',
            email: row.email || '',
            level: row.level || 'unknown' as ClientLevel,
            clientType: row.clientType || 'unknown' as ClientType,
            source: row.source || 'manual' as OutreachSource,
            companySize: row.companySize || '',
            emailVerification: row.emailVerification || 'unknown' as EmailVerification,
            emailBounced: row.emailBounced || false,
            developmentStatus: row.developmentStatus || 'pending' as const,
            notes: row.notes || '',
            bizInfo: row.bizInfo || '',
          } as ImportRow
        })
        setParsed(mapped)
        showStatus('info', `解析完成：${mapped.length} 条记录，${headers.length} 列`)
      },
      error: () => {
        showStatus('error', 'CSV 解析失败，请检查文件格式')
      },
    })
  }

  useEffect(() => {
    if (!parsed) return
    getAllItems('outreach').then(all => {
      const names = new Set(all.map(i => i.company.toLowerCase().trim()))
      const dupes = parsed.filter(r => names.has(r.company.toLowerCase().trim()))
      setDuplicateCount(dupes.length)
    })
  }, [parsed])

  const handleFile = (file: File | null) => {
    if (!file) return
    setParsed(null)
    setDuplicateCount(0)
    setStatus(null)
    parseFile(file)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    handleFile(file)
  }

  const handleImport = async () => {
    if (!parsed || parsed.length === 0) return
    setImporting(true)
    let imported = 0
    let skipped = 0
    let errors = 0

    const existing = await getAllItems('outreach')
    const existingNames = new Set(existing.map(i => i.company.toLowerCase().trim()))
    const existingWebsites = new Set(existing.map(i => i.website?.toLowerCase().trim()).filter(Boolean))

    for (const row of parsed) {
      try {
        const nameLower = row.company.toLowerCase().trim()
        const siteLower = row.website?.toLowerCase().trim() || ''

        // 去重：公司名或网站已存在则跳过
        if (existingNames.has(nameLower) || (siteLower && existingWebsites.has(siteLower))) {
          skipped++
          continue
        }

        const noteParts = [row.bizInfo, row.notes].filter(Boolean)

        const item: PipelineItem = {
          id: generateId(),
          pipelineId: 'outreach' as PipelineKey,
          currentStageId: 'otr-found',
          status: 'active' as const,
          priority: 'medium' as const,
          source: row.source,
          title: row.company,
          company: row.company,
          website: row.website,
          contactName: row.contactName,
          email: row.email,
          phone: '',
          level: row.level,
          clientType: row.clientType,
          emailVerification: row.emailVerification,
          emailBounced: row.emailBounced,
          companySize: row.companySize,
          currency: 'USD' as const,
          businessLine: 'furniture' as const,
          backcheckStatus: 'pending' as const,
          developmentStatus: row.developmentStatus,
          timeline: [{ stageId: 'otr-found', enteredAt: now() }],
          notes: noteParts.length > 0
            ? [{ id: generateId(), content: noteParts.join('\n'), createdAt: now() }]
            : [],
          attachments: [],
          createdAt: now(),
          updatedAt: now(),
        }
        await saveItem(item)
        imported++
      } catch (e) {
        errors++
        console.error('导入失败:', e)
      }
    }
    setImporting(false)
    showStatus('ok', `导入完成：成功 ${imported} 条，跳过重复 ${skipped} 条，失败 ${errors} 条`)
    setParsed(null)
  }

  const headersDetected = useMemo(() => {
    if (!rawHeaders.length) return []
    return rawHeaders.map(h => {
      const matched = !!COLUMN_MAP[h.trim()]
      const fuzzy = !matched ? !!findFuzzyMatch(h.trim()) : false
      return { name: h, matched: matched || fuzzy }
    })
  }, [rawHeaders])

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* 顶部栏 */}
      <div className="glass-darker px-6 lg:px-8 py-4 border-b border-surface-200">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold text-surface-900">数据导入</h1>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto p-6 lg:p-8 space-y-6">
          {/* 状态提示 */}
          {status && (
            <div className={`px-4 py-3 rounded-xl text-sm border ${
              status.type === 'ok'
                ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                : status.type === 'error'
                ? 'bg-red-50 text-red-700 border-red-200'
                : 'bg-blue-50 text-blue-700 border-blue-200'
            }`}>
              {status.msg}
            </div>
          )}

          {/* 上传区域 */}
          {!parsed && (
            <div
              onDrop={handleDrop}
              onDragOver={e => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onClick={() => fileRef.current?.click()}
              className={`border-2 border-dashed rounded-2xl p-12 text-center cursor-pointer transition-all ${
                dragOver
                  ? 'border-accent-400 bg-accent-50'
                  : 'border-surface-300 hover:border-surface-400 hover:bg-surface-50'
              }`}>
              <input ref={fileRef} type="file" accept=".csv"
                onChange={e => handleFile(e.target.files?.[0] || null)}
                className="hidden" />
              <div className="text-4xl mb-3 text-surface-300">-</div>
              <p className="text-sm font-medium text-surface-600 mb-1">
                {dragOver ? '松开导入' : '点击选择 CSV 文件，或拖拽到此处'}
              </p>
              <p className="text-xs text-surface-400">
                支持 客户资料、Google Maps 等标准 CSV 格式
              </p>
            </div>
          )}

          {/* 列映射情况 */}
          {headersDetected.length > 0 && parsed && (
            <div className="stat-card">
              <h2 className="text-sm font-semibold text-surface-800 mb-3">列映射</h2>
              <div className="flex flex-wrap gap-2">
                {headersDetected.map(h => (
                  <span key={h.name}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium ${
                      h.matched
                        ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                        : 'bg-amber-50 text-amber-700 border border-amber-200'
                    }`}>
                    {h.name}
                    {h.matched ? ' [ok]' : ' [!]'}
                  </span>
                ))}
              </div>
              <p className="text-xs text-surface-400 mt-2">
                {headersDetected.filter(h => h.matched).length}/{headersDetected.length} 列已自动匹配
                {headersDetected.some(h => !h.matched) && '，未匹配的列将被忽略'}
              </p>
            </div>
          )}

          {/* 预览 */}
          {parsed && (
            <>
              <div className="stat-card">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-sm font-semibold text-surface-800">
                    预览 · 共 {parsed.length} 条
                    {duplicateCount > 0 && (
                      <span className="text-amber-600 font-normal ml-2">
                        （{duplicateCount} 条在公司数据库中已存在，将跳过）
                      </span>
                    )}
                  </h2>
                </div>
                <div className="overflow-auto max-h-96 border border-surface-200 rounded-xl">
                  <table className="w-full text-xs">
                    <thead className="bg-surface-50 sticky top-0">
                      <tr>
                        <th className="px-3 py-2 text-left text-surface-500">公司</th>
                        <th className="px-3 py-2 text-left text-surface-500">联系人</th>
                        <th className="px-3 py-2 text-left text-surface-500">邮箱</th>
                        <th className="px-3 py-2 text-left text-surface-500">等级</th>
                        <th className="px-3 py-2 text-left text-surface-500">类型</th>
                        <th className="px-3 py-2 text-left text-surface-500">来源</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-surface-100">
                      {parsed.slice(0, 20).map((row, i) => (
                        <tr key={i} className="hover:bg-surface-50">
                          <td className="px-3 py-2 text-surface-800">{row.company}</td>
                          <td className="px-3 py-2 text-surface-600">{row.contactName || '—'}</td>
                          <td className="px-3 py-2 text-surface-600">{row.email || '—'}</td>
                          <td className="px-3 py-2">
                            <span className={`badge ${
                              row.level === 'XL' ? 'bg-red-50 text-red-700' :
                              row.level === 'L' ? 'bg-amber-50 text-amber-700' :
                              row.level === 'M' ? 'bg-blue-50 text-blue-700' :
                              row.level === 'S' ? 'bg-emerald-50 text-emerald-700' :
                              'bg-surface-100 text-surface-500'
                            }`}>{row.level}</span>
                          </td>
                          <td className="px-3 py-2 text-surface-600">{row.clientType}</td>
                          <td className="px-3 py-2 text-surface-600">{row.source}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {parsed.length > 20 && (
                    <p className="text-center py-2 text-surface-400 text-xs border-t border-surface-100">
                      仅显示前 20 条，共 {parsed.length} 条
                    </p>
                  )}
                </div>
              </div>

              {/* 操作按钮 */}
              <div className="flex items-center gap-3">
                <button onClick={handleImport} disabled={importing}
                  className="btn-primary text-sm disabled:opacity-50">
                  {importing ? '导入中...' : `确认导入 ${parsed.length - duplicateCount} 条`}
                </button>
                <button onClick={() => { setParsed(null); setRawHeaders([]) }}
                  className="btn-ghost text-sm text-surface-500">
                  重新选择文件
                </button>
              </div>
            </>
          )}

          {/* 使用说明 */}
          <details className="stat-card bg-surface-50 border-surface-100">
            <summary className="cursor-pointer list-none text-sm font-semibold text-surface-700">导入说明</summary>
            <ul className="text-xs text-surface-500 space-y-1.5 leading-relaxed">
              <li>• 支持标准 CSV 文件，编码 UTF-8</li>
              <li>• 中文列名自动识别：公司、网站、决策人、联系方式、等级、业务类型等</li>
              <li>• 按公司名和网站去重，已存在的客户不会重复导入</li>
              <li>• 等级映射：P0→XL、P1→L、P2→M、P3→未分级</li>
              <li>• 导入后自动归入 outreach 管道，可在开发客户页面查看</li>
            </ul>
          </details>
        </div>
      </div>
    </div>
  )
}

/** 模糊匹配列名 */
function findFuzzyMatch(header: string): ((val: string) => Partial<ImportRow>) | undefined {
  const lower = header.toLowerCase().trim()
  if (lower.includes('公司') || lower.includes('企业') || lower.includes('name') || lower.includes('公司名')) return v => ({ company: v.trim() })
  if (lower.includes('网站') || lower.includes('url') || lower.includes('link') || lower.includes('web')) return v => ({ website: v.trim() })
  if (lower.includes('决策') || lower.includes('联系') || lower.includes('contact') || lower.includes('姓名') || lower.includes('名字')) return v => ({ contactName: v.trim() })
  if (lower.includes('邮箱') || lower.includes('邮件') || lower.includes('email') || lower.includes('mail') || lower.includes('联系方式')) return v => ({ email: v.trim() })
  if (lower.includes('等级') || lower.includes('级别') || lower.includes('级') || lower.includes('level') || lower.includes('priority')) return v => ({ level: mapLevel(v.trim()) })
  if (lower.includes('类型') || lower.includes('类别') || lower.includes('type') || lower.includes('行业')) return v => ({ clientType: mapClientType(v.trim()), bizInfo: v.trim() })
  if (lower.includes('来源') || lower.includes('渠道') || lower.includes('source') || lower.includes('channel')) return v => ({ source: mapSource(v.trim()) })
  if (lower.includes('规模') || lower.includes('员工') || lower.includes('scale') || lower.includes('size') || lower.includes('进口')) return v => ({ companySize: v.trim() })
  if (lower.includes('状态') || lower.includes('status')) return v => ({ developmentStatus: mapDevStatus(v.trim()) })
  if (lower.includes('验证') || lower.includes('verify') || lower.includes('verification')) return v => ({ emailVerification: mapVerification(v.trim()) })
  if (lower.includes('退信') || lower.includes('bounce')) return v => ({ emailBounced: v.trim().toUpperCase() === 'BOUNCED' || v.trim().toUpperCase() === 'TRUE' })
  if (lower.includes('产品') || lower.includes('匹配') || lower.includes('背调') || lower.includes('结论') || lower.includes('备注') || lower.includes('notes')) return v => ({ notes: v.trim() })
  if (lower.includes('职位') || lower.includes('titles') || lower.includes('title') || lower.includes('业务线')) return v => ({ bizInfo: v.trim() })
  if (lower.includes('下一步') || lower.includes('next')) return v => ({ notes: v.trim() })
  return undefined
}
