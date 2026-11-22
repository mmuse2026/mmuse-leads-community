import type { PipelineItem } from '../types/item'
import { normalizeDomain } from './emailQualityPolicy'
import { applyEligibilityStage } from './leadStageEligibility'
import { isAggregatorDomain } from './aggregatorDomains'
import { assessDetailedBackcheck } from './detailedBackcheck'
import { getActiveProfile } from './profiles'

export type AutoBackcheckRoute = 'auto_approved' | 'manual_review' | 'inactive_excluded' | 'low_priority_pool' | 'supplier_pool' | 'preserve_manual'
export type BatchBackcheckAction = 'approve' | 'pause' | 'deep_backcheck' | 'do_not_develop'
/** 允许自动通过背调的客户类型 → 来自当前 profile 的 customerTypesAllowed（default = 原 ALLOWED_TYPES） */
const BAD_PAGE = /directory|yellow\s*pages?|news|blog|ranking|top\s*\d+|marketplace|facebook|instagram|linkedin|pinterest|youtube|privacy\s*policy|terms\s*(of|&)\s*(use|conditions)|market\s*report|photos?$/i
const GENERIC_COMPANY = /^(privacy policy|photos?|contact|about us|home|top\s*\d+|market report|unknown|n\/a)$/i
/** 平台/社媒/社区类域名 — 不得作为客户官网，不得参与重复域名归并 */
const PLATFORM_DOMAINS = new Set([
  'instagram.com', 'facebook.com', 'linkedin.com', 'pinterest.com', 'youtube.com',
  'reddit.com', 'twitter.com', 'x.com', 'tiktok.com', 'snapchat.com',
  'whatsapp.com', 'telegram.org', 'discord.com', 'medium.com', 'tumblr.com',
])

function text(value: unknown): string { return typeof value === 'string' ? value.trim() : '' }
function hasReliableDomain(item: any): boolean {
  const raw = text(item.website)
  if (!raw || BAD_PAGE.test(raw)) return false
  try { const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); return Boolean(url.hostname.includes('.') && !BAD_PAGE.test(url.pathname)) } catch { return false }
}
function hasCompanyIdentity(item: any): boolean {
  let name = text(item.company || item.title)
  // company 被误写入 2 字母国家码（'au'/'uk'/'ca' 等）→ 降级用 title 兜底
  if (/^[a-z]{2}$/i.test(text(item.company))) name = text(item.title)
  return name.length >= 3 && !GENERIC_COMPANY.test(name)
}
function hasIndustryEvidence(item: any): boolean {
  const evidence=`${text(item.backcheckReason)} ${text(item.backcheckRecommendationReason)} ${text(item.backCheck?.summary)} ${text(item.snippet)} ${text(item.company)} ${text(item.title)}`
  return /furniture|seating|restaurant|hospitality|hotel|commercial|procurement|distributor|wholesale|dealer|ff&e|ffe/i.test(evidence)
}
function isExcludedSignal(item: any): boolean {
  // 平台/社媒词（facebook/instagram/linkedin 等）不得进入排除判定：获客渠道 source 与
  // 领英抓取的 title 后缀（"… | LinkedIn"）都会误伤官网真实的公司；平台来源已由
  // isPlatformSocialSource（website hostname）单独处理。
  // 只保留"目录/博客/榜单/新闻/市场报告"等公司本体即非实体的词。
  const profile=getActiveProfile()
  const combined=`${text(item.company)} ${text(item.title)} ${text(item.website)} ${text(item.backcheckReason)}`
  const COMPANY_BAD_PAGE=/directory|yellow\s*pages?|news|blog|ranking|top\s*\d+|marketplace|privacy\s*policy|terms\s*(of|&)\s*(use|conditions)|market\s*report|photos?$/i
  return item.doNotDevelop===true || item.reviewDisposition==='do_not_develop' || item.duplicateIndex===true || COMPANY_BAD_PAGE.test(combined)
    || profile.signals.exclusionPatterns.test(combined) || profile.signals.certificationSignals.test(combined)
    || item.businessMatch==='none' || item.importCommercialValue==='none'
    || item.emailVerificationRouting?.some((r:any)=>r?.queue==='do_not_contact')
    || item.emailVerificationEvidence?.some((e:any)=>/complained|suppressed/i.test(`${e?.result||''} ${e?.webhookEventType||''}`))
}
export function hasExplicitManualConclusion(item: any): boolean {
  if (item.backcheckDecision === 'auto_qualified_pending_human') return false
  return Boolean(item.reviewDisposition && ['active','paused','insufficient','needs_recheck','do_not_develop','contact_mining'].includes(item.reviewDisposition))
}
/** 供应商/制造商/工厂类主体 — 单列供应商池，只读展示不开发（含 restaurant_supplier / restaurant_equipment_supplier） */
function isSupplierType(item: any): boolean {
  const type = text(item.customerType || item.customerTypeAssessment || item.clientType).toLowerCase()
  return /manufacturer|supplier|factory|oem|fabricator|production/i.test(type)
}

/** 平台/社媒/社区来源检测 */
function isPlatformSocialSource(item: any): boolean {
  const raw = text(item.website || item.sourceUrl)
  if (!raw) return false
  try {
    const hostname = new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.replace(/^www\./, '')
    return PLATFORM_DOMAINS.has(hostname)
  } catch { return false }
}

/**
 * 背调完整性检查：backcheckStatus=done 且无证据缺口
 */
function isBackcheckComplete(item: any): boolean {
  if (item.backcheckStatus !== 'done') return false
  const gaps = item.evidenceGaps
  if (!gaps) return true
  if (Array.isArray(gaps) && gaps.length === 0) return true
  return false
}

/**
 * 写回质量不降级保护：
 * - 旧状态是 done，新状态不是 done → 不允许覆盖旧 done
 * - 记录 latestBackcheckAttempt 但不修改 backcheckStatus
 * - 新数据中有价值的字段补充进 backCheck，不清空旧字段
 */
export function protectBackcheckDowngrade(existingItem: PipelineItem, newItem: any): any {
  const existing = existingItem as any
  if (existing.backcheckStatus !== 'done') return newItem

  const newStatus = newItem.backcheckStatus
  // 新结果不是 done → 保护旧 done，只记录尝试
  if (newStatus !== 'done') {
    return {
      ...existing,
      latestBackcheckAttempt: {
        checkedAt: newItem.backCheck?.checkedAt || new Date().toISOString(),
        status: newStatus,
        evidenceGaps: newItem.evidenceGaps,
        summary: newItem.backCheck?.summary,
      },
      // 新数据中有价值的字段补充进 backCheck 但不覆盖旧字段
      backCheck: existing.backCheck
        ? { ...newItem.backCheck, ...existing.backCheck, summary: existing.backCheck.summary || newItem.backCheck?.summary }
        : newItem.backCheck,
      evidenceGaps: existing.evidenceGaps,
      updatedAt: new Date().toISOString(),
    }
  }

  // 新结果也是 done → 合并（新数据补充但不覆盖旧字段）
  return {
    ...newItem,
    backCheck: {
      ...(existing.backCheck || {}),
      ...(newItem.backCheck || {}),
    },
  }
}

/**
 * 重复域名标记
 * 对同一 normalizedDomain 的多条记录，不删除，只标记重复组和 canonical 主记录
 */
export interface DomainDuplicateGroup {
  domain: string
  itemIds: string[]
  canonicalLeadId: string
  duplicateIds: string[]
}

export function markDuplicateDomains(items: PipelineItem[]): { marked: PipelineItem[]; groups: DomainDuplicateGroup[] } {
  const groups: DomainDuplicateGroup[] = []
  const updated: PipelineItem[] = []

  // 按域名分组
  const domainMap = new Map<string, Array<{ item: PipelineItem; idx: number }>>()
  items.forEach((item, idx) => {
    const raw = item.website || (item as any).sourceUrl || ''
    if (!raw) return
    const domain = normalizeDomain(raw)
    if (!domain) return
    const entry = domainMap.get(domain) || []
    entry.push({ item, idx })
    domainMap.set(domain, entry)
  })

  // 处理重复域名（跳过平台/社媒/社区域名）
  for (const [domain, entries] of domainMap) {
    if (entries.length < 2) continue
    // 平台/社媒域名不参与重复域名归并（单独做来源标记）
    if (PLATFORM_DOMAINS.has(domain)) continue

    // canonical 选择：有邮箱的优先，否则按创建时间最早的
    const sorted = [...entries].sort((a, b) => {
      const aHasEmail = !!(a.item.email || (a.item as any).selectedEmail)
      const bHasEmail = !!(b.item.email || (b.item as any).selectedEmail)
      if (aHasEmail && !bHasEmail) return -1
      if (!aHasEmail && bHasEmail) return 1
      return new Date(a.item.createdAt).getTime() - new Date(b.item.createdAt).getTime()
    })

    const canonical = sorted[0]
    const groupId = `dup:${domain}`

    const group: DomainDuplicateGroup = {
      domain,
      itemIds: entries.map(e => e.item.id),
      canonicalLeadId: canonical.item.id,
      duplicateIds: sorted.slice(1).map(e => e.item.id),
    }
    groups.push(group)

    // 标记所有非 canonical 的项
    sorted.slice(1).forEach(entry => {
      updated.push({
        ...entry.item,
        domainDuplicateGroup: groupId,
        canonicalLeadId: canonical.item.id,
        duplicateIndex: true,
        duplicateOf: canonical.item.id,
      } as any)
    })
  }

  return { marked: updated, groups }
}

export function getAutoBackcheckRoute(item: PipelineItem, _now=new Date()): {route:AutoBackcheckRoute;reason:string} {
  const anyItem=item as any
  const profile=getActiveProfile()
  if (hasExplicitManualConclusion(anyItem)) return {route:'preserve_manual',reason:'保留已有人工结论'}

  // 平台/社媒/社区来源 — 不得作为客户官网推进
  if (isPlatformSocialSource(anyItem)) return {route:'inactive_excluded',reason:'平台/社媒/社区来源，不是客户官网，不进入主流程'}

  // 聚合站/平台/名录域名 — 不是客户官网，不进入主流程
  if (isAggregatorDomain(text(anyItem.website || anyItem.sourceUrl))) return {route:'inactive_excluded',reason:'聚合站/平台域名，不是客户官网'}

  if (isExcludedSignal(anyItem) || !hasCompanyIdentity(anyItem) || !hasReliableDomain(anyItem)) return {route:'inactive_excluded',reason:'无效来源、无主体、无可靠域名或明确排除信号'}

  // 供应商/制造商/工厂类主体 — 单列供应商池（只读展示，不开发），先于背调完整性检查
  if (isSupplierType(anyItem)) return {route:'supplier_pool',reason:'供应商/制造商/工厂类主体，单列供应商池只读展示，不进入开发流程'}

  // P0: 背调不完整(incomplete/fail/err或存在证据缺口)一律不得自动通过
  if (!isBackcheckComplete(anyItem)) {
    // 被排除或低价值的 incomplete 不进主流程
    if (anyItem.businessMatch==='low' && anyItem.importCommercialValue==='low') {
      return {route:'low_priority_pool',reason:'背调不完整且业务与商业价值均低，低优先级暂存'}
    }
    return {route:'manual_review',reason:'背调不完整(有证据缺口或backcheckStatus≠done)，需要人工确认'}
  }

  if (anyItem.businessMatch==='low' && anyItem.importCommercialValue==='low' && anyItem.recommendedAction==='low_priority') return {route:'low_priority_pool',reason:'业务与商业价值均低，移出主工作流低成本保留'}
  const type=text(anyItem.customerType||anyItem.customerTypeAssessment||anyItem.clientType).toLowerCase()
  if (anyItem.businessMatch==='high' && ['high','medium'].includes(anyItem.importCommercialValue) && new Set(profile.customerTypesAllowed).has(type) && hasIndustryEvidence(anyItem)) {
    return {route:'auto_approved',reason:'高业务匹配、具备商业价值、主体与官网明确，系统轻背调自动通过'}
  }
  return {route:'manual_review',reason:'行业或采购价值仍需人工确认'}
}
export function applyAutoBackcheckRouting(item:PipelineItem,now=new Date()):{item:any;route:AutoBackcheckRoute;changed:boolean} {
  const decision=getAutoBackcheckRoute(item,now); const current=item as any
  if(decision.route==='preserve_manual') return {item:current,route:decision.route,changed:false}
  if(decision.route==='auto_approved'){
    const reviewed={...current,reviewDisposition:undefined,reviewReason:decision.reason,reviewUpdatedAt:now.toISOString(),reviewedBy:'system_auto_routing_v1',backcheckDecision:'auto_qualified_pending_human',activeWorkflow:true,inactiveWorkflow:false}
    return {item:{...reviewed,primaryStage:'backcheck_queue',normalizedStage:'backcheck_queue',currentAllowedStage:'backcheck_queue',allowedNextActions:['run_detailed_backcheck','human_review_backcheck'],nextRequiredAction:'human_review_backcheck',eligibilityBlockedReasons:['explicit_human_backcheck_approval_required'],displayBucket:'customer_progress',dashboardBucket:'backcheck_queue',eligibilityUpdatedAt:now.toISOString()},route:decision.route,changed:true}
  }
  if(decision.route==='manual_review') {
    return {item:{...current,primaryStage:'manual_review',normalizedStage:'manual_review',currentAllowedStage:'manual_review',nextRequiredAction:'人工确认背调结论',eligibilityBlockedReasons:[decision.reason],activeWorkflow:true,inactiveWorkflow:false,eligibilityUpdatedAt:now.toISOString()},route:decision.route,changed:true}
  }
  if(decision.route==='supplier_pool') {
    const poolItem={...current,reviewDisposition:undefined,supplierPool:true,normalizedStage:'supplier_pool',currentAllowedStage:'supplier_pool',nextRequiredAction:'供应商池只读展示，不开发',eligibilityBlockedReasons:[decision.reason],activeWorkflow:false,inactiveWorkflow:true,inactiveCategory:'supplier_pool' as const,inactiveReason:decision.reason,inactiveAt:current.inactiveAt||now.toISOString(),eligibilityUpdatedAt:now.toISOString()}
    return {item:poolItem,route:decision.route,changed:true}
  }
  const stage=decision.route
  return {item:{...current,normalizedStage:stage,currentAllowedStage:stage,nextRequiredAction:decision.route==='low_priority_pool'?'低优先级暂存':'保留去重索引，不进入主流程',eligibilityBlockedReasons:[decision.reason],activeWorkflow:false,inactiveWorkflow:true,inactiveReason:decision.reason,inactiveAt:current.inactiveAt||now.toISOString(),eligibilityUpdatedAt:now.toISOString()},route:decision.route,changed:true}
}

/**
 * 应用自动背调结果
 *
 * P0 修复:
 * 1. 不再硬编码 backcheckStatus='done' — 保留传入 item 的实际状态
 * 2. 背调不完整的项目走 manual_review 而非 auto_approved
 * 3. getAutoBackcheckRoute 已检查 isBackcheckComplete
 */
/** 背调结论覆盖业务字段：仅向更严格方向覆盖（none/low 剔除/降级信号）或填空，不误伤已人工确认的高价值客户 */
function applyBackcheckField(current:unknown,assessed:string):string{
  const cur=String(current||'').trim().toLowerCase()
  if(assessed==='none'||assessed==='low')return assessed
  if(cur===''||cur==='unknown'||cur==='missing')return assessed
  return cur
}
export function applyAutomaticBackcheckResult(item:PipelineItem,backCheckData:any,resolvedUrl:string|undefined,now=new Date()):any{
  const current=item as any
  const website=current.website||resolvedUrl
  // 保留传入的 backcheckStatus（firecrawlService 已根据 evidenceGaps 正确设置）
  const enriched={
    ...current,
    website,
    backCheck:{...backCheckData,companyWebsite:website||backCheckData?.companyWebsite},
    backcheckStatus: current.backcheckStatus || 'done',
    detailedBackcheckAt: backCheckData?.checkedAt||now.toISOString(),
    evidenceSummary: backCheckData?.summary||current.evidenceSummary,
    updatedAt:now.toISOString()
  }
  // 背调确已跑完（该函数仅在真实背调后调用）→ 用 assessDetailedBackcheck 结论覆盖业务字段（重算后覆盖，修复导入残留污染）
  const assessment=assessDetailedBackcheck(enriched)
  const platformType=assessment.customerType==='directory_news_platform'||assessment.customerType==='non_buyer_entity'
  const withAssessment={
    ...enriched,
    businessMatch:applyBackcheckField(current.businessMatch,assessment.businessMatch),
    importCommercialValue:applyBackcheckField(current.importCommercialValue,assessment.importCommercialValue),
    customerType:platformType?assessment.customerType:(current.customerType||assessment.customerType),
  }
  return applyAutoBackcheckRouting(withAssessment,now).item
}
export function applyHumanBackcheckApproval(item:PipelineItem,reason:string,now=new Date()):any{
  const current=item as any
  const reviewed={...current,reviewDisposition:'active',reviewReason:reason,reviewUpdatedAt:now.toISOString(),reviewedBy:'human_backcheck_review',backcheckDecision:'approved',activeWorkflow:true,inactiveWorkflow:false}
  return applyEligibilityStage(reviewed,now).item
}
export function applyBatchBackcheckAction(items:PipelineItem[],ids:string[],action:BatchBackcheckAction,reason:string,now=new Date()){
  const wanted=new Set(ids);const updated:any[]=[];const rejected:Array<{id:string;reason:string}>=[]
  for(const item of items){if(!wanted.has(item.id))continue;const current=item as any
    if(action==='approve'&&current.backcheckDecision!=='auto_qualified_pending_human'&&getAutoBackcheckRoute(item,now).route!=='auto_approved'){rejected.push({id:item.id,reason:'不满足批量通过的严格条件'});continue}
    if(action==='approve'){updated.push(applyHumanBackcheckApproval(item,reason,now));continue}
    const stage=action==='pause'?'paused_review_queue':action==='deep_backcheck'?'deep_backcheck_queue':'do_not_develop'
    updated.push({...current,reviewDisposition:action==='pause'?'paused':action==='deep_backcheck'?'needs_recheck':'do_not_develop',reviewReason:reason,reviewUpdatedAt:now.toISOString(),reviewedBy:'human_batch_review',normalizedStage:stage,currentAllowedStage:stage,activeWorkflow:false,inactiveWorkflow:true,inactiveReason:reason,inactiveAt:now.toISOString(),doNotDevelop:action==='do_not_develop'?true:current.doNotDevelop,excludedAt:action==='do_not_develop'?now.toISOString():current.excludedAt})
  }
  return {updated,rejected}
}
export function restoreIsolatedLead(item:PipelineItem,target:'backcheck_queue'|'contact_mining_queue'|'email_validation_queue',reason:string,now=new Date()):any{
  const current=item as any
  return {...current,normalizedStage:target,currentAllowedStage:target,nextRequiredAction:target==='backcheck_queue'?'重新人工背调':target==='contact_mining_queue'?'补充联系人':'继续邮箱验证',activeWorkflow:true,inactiveWorkflow:false,inactiveReason:undefined,restoredReason:reason,restoredAt:now.toISOString(),reviewDisposition:target==='backcheck_queue'?'needs_recheck':'active',reviewUpdatedAt:now.toISOString(),reviewedBy:'human_restore'}
}
