import type { PipelineItem } from '../types/item'
import { presentSource } from '../services/presentation'
import { zh } from '../services/zhText'

export type CustomerKind = '批发商' | '经销商' | '酒店用品商' | '餐饮家具相关' | '黄页目录' | '新闻文章' | '榜单页面' | '无关' | '不确定'
export type TargetLevel = '高' | '中' | '低' | '不确定'

export interface CustomerJudgment {
  customerType: CustomerKind
  targetLevel: TargetLevel
  reason: string
  chineseSummary: string
  originalSummary: string
  dataSource: string
  sourceType: string
  hasWebsite: boolean
  backcheckQuality: '充分' | '一般' | '不足' | '未背调'
  needsRecheck: boolean
  lastBackcheck: string
  reviewReason: string
  funnelAdvice: string
  shouldMineContacts: string
  contactTarget: string
  contactCount: number
  contactCountMet: boolean
  indirectSource: boolean
}

const MISSING = '未查询 / 需人工核查'
const INDIRECT_RE = /top\s*\d+|directory|yellow\s*pages?|news|blog|supplier\s*list|best\s+\w+\s+(companies|suppliers)/i

function itemText(item: PipelineItem): string {
  return [item.title, item.company, item.snippet, item.website, item.backCheck?.summary, ...(item.backCheck?.products || [])].filter(Boolean).join(' ')
}

function inferCustomerType(item: PipelineItem): CustomerKind {
  const text = itemText(item)
  if (/yellow\s*pages?|business\s*directory|company\s*directory/i.test(text)) return '黄页目录'
  if (/top\s*\d+|best\s+\w+\s+(companies|suppliers)|supplier\s*list/i.test(text)) return '榜单页面'
  if (/\bnews\b|press release|\bblog\b|article/i.test(text)) return '新闻文章'
  if (/hotel supplies|hospitality supplies|hotel furniture/i.test(text)) return '酒店用品商'
  if (/restaurant furniture|restaurant supplier|dining furniture|booth|banquette/i.test(text)) return '餐饮家具相关'
  if (item.clientType === 'wholesaler' || /wholesale|wholesaler/i.test(text)) return '批发商'
  if (item.clientType === 'distributor' || /distributor|dealer/i.test(text)) return '经销商'
  if (/job listing|wikipedia|government notice|university/i.test(text)) return '无关'
  return '不确定'
}

function dataSourceLabel(item: PipelineItem): string {
  return presentSource(item.source).label
}

function sourceLabel(item: PipelineItem, kind: CustomerKind): string {
  if (kind === '黄页目录') return '黄页 / 目录'
  if (kind === '榜单页面') return '榜单'
  if (kind === '新闻文章') return '新闻 / 文章'
  const presented = presentSource(item.source)
  if (presented.label !== '未知来源') return presented.label
  if (item.website) return '官网（需人工确认归属）'
  return presented.label
}

function backcheckQuality(item: PipelineItem): CustomerJudgment['backcheckQuality'] {
  if (!item.backCheck && item.backcheckStatus !== 'done') return '未背调'
  const summary = Boolean(item.backCheck?.summary?.trim())
  const products = Boolean(item.backCheck?.products?.length)
  const clearType = item.clientType && item.clientType !== 'unknown'
  if (item.website && summary && products && clearType) return '充分'
  if (summary && (item.website || products || clearType)) return '一般'
  return '不足'
}
function contactCount(item: PipelineItem): number {
  const contacts = Array.isArray((item as PipelineItem & { contacts?: unknown[] }).contacts)
    ? (item as PipelineItem & { contacts?: unknown[] }).contacts || []
    : []
  const decisionMakers = item.backCheck?.decisionMakers || []
  const keys = new Set<string>()
  for (const contact of [...contacts, ...decisionMakers] as Array<Record<string, unknown>>) {
    const key = String(contact.email || contact.name || contact.title || '').trim().toLowerCase()
    if (key) keys.add(key)
  }
  if (item.contactName?.trim()) keys.add(item.contactName.trim().toLowerCase())
  return keys.size
}

export function deriveCustomerJudgment(item: PipelineItem): CustomerJudgment {
  const customerType = inferCustomerType(item)
  const indirectSource = INDIRECT_RE.test(itemText(item)) || ['黄页目录', '新闻文章', '榜单页面'].includes(customerType)
  const positiveType = ['批发商', '经销商', '酒店用品商', '餐饮家具相关'].includes(customerType)
  const hasEvidence = Boolean(item.backCheck?.summary || item.backCheck?.products?.length || item.website)
  const targetLevel: TargetLevel = indirectSource || customerType === '无关'
    ? '低'
    : positiveType && hasEvidence
      ? '高'
      : positiveType || (item.businessLine === 'furniture' && hasEvidence)
        ? '中'
        : '不确定'
  const count = contactCount(item)
  const quality = backcheckQuality(item)
  const needsRecheck = item.reviewDisposition === 'needs_recheck' || item.reviewDisposition === 'insufficient' || quality === '不足' || quality === '未背调'
  const missingSignals = [!item.website && '官网', customerType === '不确定' && '客户类型', !item.backCheck?.summary && '中文背调摘要', !item.source && '数据来源', count === 0 && '联系人/邮箱归属'].filter(Boolean)
  const funnelAdvice = missingSignals.length ? `建议退回背调或暂不开发：缺少${missingSignals.join('、')}` : '信息基本齐全，仍需人工确认后再进入发信。'
  const continueMining = targetLevel === '低'
    ? '暂不建议；先确认是否为直接客户'
    : count >= 4
      ? '联系人数量已达建议上限，优先核查质量'
      : '建议继续；优先采购、老板、运营或项目负责人'
  const reason = indirectSource
    ? '来源疑似目录、榜单、新闻或供应商列表，可能不是直接客户。'
    : hasEvidence
      ? `基于现有网站/背调线索判断为${customerType}；仍需人工复核。`
      : '现有证据不足，不能确认是否为目标客户。'

  const backcheckSummary = item.backCheck?.summary?.trim() || ''
  const chineseCharacterCount = (backcheckSummary.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length
  const latinCharacterCount = (backcheckSummary.match(/[A-Za-z]/g) || []).length
  const hasChineseSummary = chineseCharacterCount >= 4 && chineseCharacterCount * 2 >= latinCharacterCount
  const chineseSummary = hasChineseSummary ? backcheckSummary : backcheckSummary ? '未生成 / 需人工翻译' : MISSING
  const originalSummary = (hasChineseSummary ? item.snippet?.trim() : backcheckSummary) || item.snippet?.trim() || MISSING

  return {
    customerType,
    targetLevel,
    reason,
    chineseSummary,
    originalSummary,
    dataSource: dataSourceLabel(item),
    sourceType: sourceLabel(item, customerType),
    hasWebsite: Boolean(item.website),
    backcheckQuality: quality,
    needsRecheck,
    lastBackcheck: item.backCheck?.checkedAt || '未背调',
    reviewReason: item.reviewReason || '无',
    funnelAdvice,
    shouldMineContacts: continueMining,
    contactTarget: '每家公司 2–4 个联系人，优先关键联系人和工作邮箱',
    contactCount: count,
    contactCountMet: count >= 2,
    indirectSource,
  }
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div><p className="text-[10px] text-surface-400">{label}</p><p className="mt-0.5 text-xs leading-5 text-surface-700">{value}</p></div>
}

export default function CustomerJudgmentCard({ item, compact = false }: { item: PipelineItem; compact?: boolean }) {
  const judgment = deriveCustomerJudgment(item)
  const levelTone = judgment.targetLevel === '高' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : judgment.targetLevel === '中' ? 'bg-amber-50 text-amber-700 border-amber-200' : judgment.targetLevel === '低' ? 'bg-red-50 text-red-700 border-red-200' : 'bg-surface-100 text-surface-600 border-surface-200'
  if (compact) {
    return (
      <section className="rounded-xl border border-surface-200 bg-white p-4" aria-label="客户判断卡片">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-xs font-semibold text-surface-700">客户判断</h3>
          <span className={`rounded border px-2 py-0.5 text-[10px] font-semibold ${levelTone}`}>目标客户：{judgment.targetLevel}</span>
        </div>
        <p className="mt-3 text-sm leading-6 text-surface-800">{judgment.reason}</p>
        <p className="mt-2 text-xs leading-5 text-surface-500">{judgment.customerType} · {judgment.backcheckQuality} · {judgment.hasWebsite ? '有官网待核对' : '官网待补充'}</p>
        {judgment.indirectSource && <p className="mt-3 text-xs text-red-700">来源可能是目录、榜单或资讯页，请先确认是否为真实客户。</p>}
      </section>
    )
  }
  return (
    <section className="rounded-xl border border-surface-200 bg-white p-4 space-y-3" aria-label="客户判断卡片">
      <div className="flex items-center justify-between gap-2"><h3 className="text-xs font-bold text-surface-900">客户判断与人工核查</h3><span className={`rounded border px-2 py-0.5 text-[10px] font-semibold ${levelTone}`}>目标客户：{judgment.targetLevel}</span></div>
      {judgment.indirectSource && <p className="rounded border border-red-200 bg-red-50 px-2 py-1.5 text-[11px] text-red-700">疑似非直接客户：目录、榜单、新闻、博客或供应商列表来源。</p>}
      <div className="grid grid-cols-2 gap-3"><Fact label="客户类型" value={judgment.customerType} /><Fact label="数据来源" value={judgment.dataSource} /><Fact label="来源类型" value={judgment.sourceType} /><Fact label="是否有官网" value={judgment.hasWebsite ? '有（需人工确认归属）' : '无'} /><Fact label="背调质量" value={judgment.backcheckQuality} /><Fact label="是否需要重新背调" value={judgment.needsRecheck ? '是' : '否'} /><Fact label="上次背调时间" value={judgment.lastBackcheck} /><Fact label="退回/放弃原因" value={zh(judgment.reviewReason)} /><Fact label="判断理由" value={judgment.reason} /><Fact label="是否建议继续挖联系人" value={judgment.shouldMineContacts} /></div>
      <p className="rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">{judgment.funnelAdvice}</p>
      <Fact label="中文背调摘要" value={judgment.chineseSummary} />
      <Fact label="原始摘要" value={judgment.originalSummary} />
      <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-[11px] leading-5 text-blue-800">
        <p className="font-semibold">联系人目标</p><p>{judgment.contactTarget}</p><p>当前 {judgment.contactCount} 个：{judgment.contactCountMet ? '数量达标，继续核查职位和邮箱归属' : '未达标 / 需人工核查'}</p>
      </div>
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-[11px] leading-5 text-amber-900">
        <p className="font-semibold">人工核查建议（未查询项不得视为已确认）</p>
        <p>进口记录：ImportYeti、Panjiva、Volza、Trademo — {item.backCheck?.tradeData?.length ? '已有线索，仍需人工复核' : MISSING}</p>
        <p>公司真实性：Google、Google Maps、LinkedIn、Facebook、官网、当地注册查询 — {item.backCheck?.checkedAt ? '已有背调记录，仍需人工复核' : MISSING}</p>
        <p>邮箱归属：官网 Contact 页、LinkedIn 员工、Hunter/Apollo/Snovio — {item.backCheck?.verifiedContact ? '已有联系人线索，仍需人工复核' : MISSING}</p>
      </div>
    </section>
  )
}



