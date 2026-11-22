import type { PipelineItem } from '../types/item'
import { getLanguageByCountry } from '../services/translateService'
import { getPrimaryEmail, isPublicEmail } from '../services/workflowStage'
import { deriveCustomerJudgment } from './CustomerJudgmentCard'
import { OFFICIAL_OUTREACH_EMAIL } from '../services/outreachIdentity'

const MISSING = '未查询 / 需人工核查'
const FREE_MAIL_RE = /@(gmail|yahoo|hotmail|outlook|icloud|aol|protonmail)\./i

const TIMEZONE_HINTS: Record<string, string> = {
  US: '美国跨多个时区，需按客户城市确认', 'United States': '美国跨多个时区，需按客户城市确认',
  CA: '加拿大跨多个时区，需按客户城市确认', Canada: '加拿大跨多个时区，需按客户城市确认',
  GB: 'Europe/London', UK: 'Europe/London', 'United Kingdom': 'Europe/London',
  DE: 'Europe/Berlin', Germany: 'Europe/Berlin', FR: 'Europe/Paris', France: 'Europe/Paris',
  AE: 'Asia/Dubai', UAE: 'Asia/Dubai', 'United Arab Emirates': 'Asia/Dubai',
  SA: 'Asia/Riyadh', 'Saudi Arabia': 'Asia/Riyadh', AU: '澳大利亚跨多个时区，需按客户城市确认', Australia: '澳大利亚跨多个时区，需按客户城市确认',
}

export interface PreSendDecision {
  recommendation: '建议' | '暂缓' | '不建议' | '需人工确认'
  reason: string
  customerType: string
  indirectSource: boolean
  email: string
  emailSuitability: string
  workEmail: boolean
  country: string
  languageAdvice: string
  timezone: string
  suggestedSendTime: string
  holidayRisk: string
  tradeRisk: string
  chinaImportRecord: '有' | '无' | '未查询'
  needsManualConfirmation: boolean
}

export function derivePreSendDecision(item: PipelineItem): PreSendDecision {
  const judgment = deriveCustomerJudgment(item)
  const email = getPrimaryEmail(item)
  const validEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)
  const publicEmail = validEmail && isPublicEmail(email)
  const freeEmail = validEmail && FREE_MAIL_RE.test(email)
  const workEmail = validEmail && !publicEmail && !freeEmail
  const verified = item.emailVerification === 'verified' || item.emailVerification === 'catchall'
  const hasBackground = Boolean(item.backCheck?.summary || item.backCheck?.products?.length)
  const country = item.country || item.backCheck?.markets?.[0] || '未查询 / 需人工核查'
  const { lang, label } = getLanguageByCountry(country)
  const languageAdvice = lang === 'en' ? '建议使用英文' : `建议使用英文，${label}需人工确认`
  const timezone = TIMEZONE_HINTS[country] || MISSING
  const chinaImportRecord: '有' | '无' | '未查询' = item.backCheck?.tradeData?.length
    ? '有'
    : item.backCheck?.checkedAt
      ? '无'
      : '未查询'

  let recommendation: PreSendDecision['recommendation'] = '需人工确认'
  let reason = '客户背景或发送证据不足，必须人工确认。'
  if (judgment.indirectSource) {
    recommendation = '不建议'
    reason = '来源疑似目录、榜单、新闻、博客或供应商列表，可能不是直接客户。'
  } else if (!validEmail || !workEmail) {
    recommendation = '暂缓'
    reason = !validEmail ? '没有可用邮箱，不建议直接发送。' : '当前为公共、个人免费或可疑邮箱，需先确认归属。'
  } else if (!verified || !hasBackground || judgment.targetLevel === '不确定') {
    recommendation = '需人工确认'
    reason = '工作邮箱、验证状态或客户背景尚未充分确认。'
  } else if (judgment.targetLevel === '高' || judgment.targetLevel === '中') {
    recommendation = '建议'
    reason = '现有客户背景与工作邮箱线索支持发送，仍需人工复核正文和收件人。'
  }

  return {
    recommendation,
    reason,
    customerType: judgment.customerType,
    indirectSource: judgment.indirectSource,
    email,
    emailSuitability: !validEmail ? '无可用邮箱' : workEmail ? (verified ? '工作邮箱，已有验证线索' : '工作邮箱，验证状态未确认') : publicEmail ? '公共邮箱，需确认负责人' : freeEmail ? '个人免费邮箱，需确认归属' : '可疑邮箱，需人工核查',
    workEmail,
    country,
    languageAdvice,
    timezone,
    suggestedSendTime: timezone === MISSING ? MISSING : '建议客户当地周二至周四 09:00–11:00；具体时间需人工确认',
    holidayRisk: MISSING,
    tradeRisk: MISSING,
    chinaImportRecord,
    needsManualConfirmation: true,
  }
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="grid grid-cols-[120px_1fr] gap-2 border-b border-surface-100 py-1.5 last:border-0"><span className="text-[11px] text-surface-400">{label}</span><span className="text-[11px] leading-5 text-surface-700">{value}</span></div>
}

export default function PreSendDecisionCard({ item }: { item: PipelineItem }) {
  const decision = derivePreSendDecision(item)
  const tone = decision.recommendation === '建议' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : decision.recommendation === '不建议' ? 'border-red-200 bg-red-50 text-red-700' : 'border-amber-200 bg-amber-50 text-amber-700'
  return (
    <section className="rounded-xl border border-surface-200 bg-white p-4" aria-label="发信前判断卡片">
      <div className="mb-3 flex items-center justify-between gap-2"><h3 className="text-xs font-bold text-surface-900">发信前判断</h3><span className={`rounded border px-2 py-0.5 text-[10px] font-semibold ${tone}`}>{decision.recommendation}</span></div>
      {decision.indirectSource && <p className="mb-3 rounded border border-red-200 bg-red-50 p-2 text-[11px] text-red-700">不建议直接发给此对象：疑似目录、榜单、新闻页或黄页。</p>}
      <Row label="正式发件邮箱" value={OFFICIAL_OUTREACH_EMAIL} /><Row label="Reply-To" value={OFFICIAL_OUTREACH_EMAIL} /><Row label="判断理由" value={decision.reason} /><Row label="客户类型" value={decision.customerType} /><Row label="邮箱适合发送" value={decision.emailSuitability} /><Row label="是否工作邮箱" value={decision.workEmail ? '是（仍需人工复核）' : '否 / 未确认'} /><Row label="国家/地区" value={decision.country} /><Row label="建议语言" value={decision.languageAdvice} /><Row label="当地时区" value={decision.timezone} /><Row label="建议发信时间" value={decision.suggestedSendTime} /><Row label="节假日/宗教休息" value={decision.holidayRisk} /><Row label="物流/海运/战争/制裁/付款风险" value={decision.tradeRisk} /><Row label="中国进口记录" value={decision.chinaImportRecord} /><Row label="发送确认" value="必须人工确认后再发；当前发送仍受 safe mode 拦截" />
      <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50 p-3 text-[11px] leading-5 text-blue-800"><p className="font-semibold">人工核查建议</p><p>进口记录：ImportYeti / Panjiva / Volza / Trademo</p><p>客户真实性：Google / Google Maps / LinkedIn / Facebook / 官网</p><p>当地节假日、宗教假期，以及物流、海运和目的国风险：{MISSING}</p></div>
    </section>
  )
}
