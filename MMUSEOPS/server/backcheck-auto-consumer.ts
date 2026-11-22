/**
 * 背调自动消费（批次2 / 背调补强 T3）。
 *
 * 职责：自动消费 primaryStage==='backcheck_queue' 的项，全流程自动循环，不依赖人工触发：
 *   1. 背调完整（国家/官网/产品/行业/所在地/语言/业务字段齐全）且 businessMatch∈{high,medium} 且无排除信号
 *      → 自动放行（backcheckDecision='auto_approved'，approvedBy='pipeline-stepper'），重算阶段流入
 *        contact_mining_queue / email_validation_queue（跳过卡人工的 auto_qualified_pending_human）。
 *   2. evidenceGaps 非空 → 调二次补抓（复用 firecrawlService.backfillBackcheckGaps）。
 *   3. 供应商 → 单列 tools/suppliers_pool.json（appendSupplierToPool），标 inactive。
 *   4. 聚合站/黄页/排除 → inactive_excluded（现有路由）。
 *
 * 写库采用 items-store-atomic.ts 的 updateOneItemAtomic：它不重算阶段，能精确保留
 * supplier_pool / inactive_excluded 的 stage 章（updateItemsAtomic 的 refreshOnlyMutated
 * 会重跑 applyEligibilityStage，把供应商误路由到 contact_mining）。自动放行项在进程内已调
 * applyEligibilityStage 算好阶段，再原子写回。
 *
 * 不挂载到 backgroundTick / pipeline-stepper；仅提供可调用导出函数（挂载留批次末统一接入）。
 */

import { readItemsAtomic, updateOneItemAtomic, ITEMS_STORE_FILE } from './items-store-atomic'
import { getAutoBackcheckRoute, applyAutoBackcheckRouting, applyAutomaticBackcheckResult, hasExplicitManualConclusion } from '../src/services/backcheckAutoRouting'
import { assessDetailedBackcheck } from '../src/services/detailedBackcheck'
import { applyEligibilityStage } from '../src/services/leadStageEligibility'
import { isAggregatorDomain } from '../src/services/aggregatorDomains'
import { backfillBackcheckGaps, MAX_BACKCHECK_ATTEMPTS } from '../src/services/firecrawlService'
import { getFormalSentEmailsCached } from './formal-sent-email-set'
import { getTestMailVerdictsCached } from './test-mail-verdicts'
import { appendSupplierToPool } from './suppliers-pool'
import { isActiveCrmMaster } from '../src/services/crmIdentity'

export interface BackcheckAutoStats {
  processed: number
  autoApproved: number
  suppliersRouted: number
  inactiveExcluded: number
  incomplete: number
  /** 存量 manual_review 自动审批放行条数（本 tick 新放行） */
  manualAutoApproved: number
}

export interface BackcheckAutoDeps {
  /** 覆盖 items_store.json 路径（测试/独立库用） */
  itemsStorePath?: string
  /** 覆盖当前时间 */
  now?: Date
  /** 每 tick 最多处理条数（默认 6） */
  maxPerTick?: number
  /** stepper 版本戳（防同版本重复处理；换版本号即重新消费） */
  version?: string
  /** 二次补抓函数注入（默认 backfillBackcheckGaps；测试可传 mock 避免真实抓取） */
  backfillFn?: (item: any, now: Date) => Promise<{ item: any; changed: boolean; resolvedUrl?: string; error?: string }>
  /** 单条二次补抓硬超时；超时后记录错误并继续下一条，默认 75 秒。 */
  backfillTimeoutMs?: number
  /** 上层巡检可读的错误槽（本函数只写，不抛） */
  lastError?: Record<string, unknown>
}

const DEFAULT_VERSION = 'backcheck-auto-consumer-v1'
const DEFAULT_MAX_PER_TICK = 6
const DEFAULT_BACKFILL_TIMEOUT_MS = 75_000
const BACKCHECK_RETRY_COOLDOWN_MS = 6 * 60 * 60 * 1000

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`backfill timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function text(v: unknown): string { return String(v || '').trim() }
function hasWebsite(item: any): boolean {
  return Boolean(text(item?.website || item?.backCheck?.companyWebsite))
}
function hasBackcheckData(item: any): boolean {
  return Boolean(item?.backCheck) && Object.keys(item?.backCheck || {}).length > 0
}
function hasBackfillBudget(item: any): boolean {
  return Number(item?.backcheckAttempts || 0) < MAX_BACKCHECK_ATTEMPTS
}
function exhaustedRetryDue(item: any, now: Date): boolean {
  if (Number(item?.backcheckAttempts || 0) < MAX_BACKCHECK_ATTEMPTS) return false
  const next = Date.parse(String(item?.backcheckNextRetryAt || ''))
  return !Number.isFinite(next) || next <= now.getTime()
}
function hasExcludedSignal(item: any): boolean {
  const business = text(item?.businessMatch).toLowerCase()
  const value = text(item?.importCommercialValue).toLowerCase()
  return item?.doNotDevelop === true
    || item?.reviewDisposition === 'do_not_develop'
    || item?.duplicateIndex === true
    || business === 'none'
    || value === 'none'
}
function stamp(item: any, version: string, now: Date): any {
  return { ...item, stepperVersion: version, autoBackcheckAt: now.toISOString(), updatedAt: now.toISOString() }
}

function rebaseBackcheckChanges(before: any, processed: any, latest: any): any {
  const next = { ...latest }
  for (const key of new Set([...Object.keys(before || {}), ...Object.keys(processed || {})])) {
    if (JSON.stringify(before?.[key]) === JSON.stringify(processed?.[key])) continue
    if (JSON.stringify(before?.[key]) !== JSON.stringify(latest?.[key])) continue
    if (Object.prototype.hasOwnProperty.call(processed, key)) next[key] = processed[key]
    else delete next[key]
  }
  return next
}

/** 供应商/制造商/工厂类主体（与 backcheckAutoRouting.isSupplierType 同规则）— 不自动放行进开发漏斗 */
function isSupplierType(item: any): boolean {
  const type = text(item?.customerType || item?.customerTypeAssessment || item?.clientType).toLowerCase()
  return /manufacturer|supplier|factory|oem|fabricator|production/i.test(type)
}

/**
 * 存量 manual_review 自动审批放行——候选判定（全部条件满足才放行）。
 * 针对被旧系统 reviewDisposition 未置 active 而钉死在 manual_review 的
 * "背调完整 + 业务高匹配"存量：无硬拦规则，背调完整即放行进入下一阶段。
 */
export function isManualReviewReleaseCandidate(item: any, version: string): boolean {
  if (String(item?.primaryStage || item?.normalizedStage || '') !== 'manual_review') return false
  // 已被本消费器处理过（同版本）或已自动放行 → 跳过
  if (item?.stepperVersion === version) return false
  if (item?.autoApprovedAt) return false
  const business = text(item?.businessMatch).toLowerCase()
  const value = text(item?.importCommercialValue).toLowerCase()
  if (!['high', 'medium'].includes(business)) return false
  if (!['high', 'medium'].includes(value)) return false
  // 背调信息完整：有官网 + 有国家（非空非 unknown）+ 有 businessMatch（hasDetailedBackcheck 大致满足）
  const country = text(item?.country).toLowerCase()
  if (!country || country === 'unknown') return false
  const website = text(item?.website || item?.backCheck?.companyWebsite)
  if (!website) return false
  // 聚合站不自动放行
  if (isAggregatorDomain(website)) return false
  // 排除信号不自动放行
  if (item?.doNotDevelop === true) return false
  if (item?.doNotContactEmail === true) return false
  if (item?.reviewDisposition === 'do_not_develop') return false
  if (item?.operationalTier === 'true_excluded') return false
  if (String(item?.primaryStage || '') === 'true_excluded') return false
  // 供应商不自动放行进开发漏斗（保持现有 suppliers_pool 单列逻辑）
  if (isSupplierType(item)) return false
  return true
}

/**
 * 存量 manual_review 自动审批放行——置 reviewDisposition=active 并重算阶段。
 * 同时清除卡 manual_review 的陈旧分级标记（normalizedStage / currentAllowedStage /
 * operationalTier=manual_review），否则 leadStageEligibility 的 human_review_required 规则
 * 会让其回流 manual_review；backcheckDecision 置 auto_approved 避免 auto_qualified_pending_human
 * 规则（leadStageEligibility 的 backcheck_queue 分支）再把它打回背调队列。
 */
export function approveManualReview(item: any, now: Date, version: string): any {
  // hasDetailedBackcheck 要求 evidenceSummary/backCheck.summary 长度 ≥20；不足则补说明性摘要兜底。
  const existingSummary = text(item.evidenceSummary || item.backCheck?.summary)
  const summary = existingSummary.length >= 20
    ? existingSummary
    : `背调放行：业务匹配 ${item.businessMatch || 'unknown'}，商业价值 ${item.importCommercialValue || 'unknown'}（pipeline-stepper 自动审批放行）`
  const next: any = {
    ...item,
    reviewDisposition: 'active',
    reviewUpdatedAt: now.toISOString(),
    approvedBy: 'pipeline-stepper',
    reviewedBy: 'pipeline-stepper',
    reviewReason: '存量放行：背调完整且高/中业务匹配（pipeline-stepper）',
    backcheckDecision: 'auto_approved',
    autoApprovedAt: now.toISOString(),
    stepperVersion: version,
    updatedAt: now.toISOString(),
    // hasDetailedBackcheck 条件1：detailedBackcheckAt 必须有值才判定背调完整（与 processOne 放行分支一致）
    detailedBackcheckAt: now.toISOString(),
    backcheckStatus: 'done',
    // hasDetailedBackcheck 要求 evidenceGaps!==undefined 才放行；完整项须为 []（与 processOne 放行分支一致）
    evidenceGaps: [],
    // hasDetailedBackcheck 条件2：backcheckConfidence∈{high,medium,low} 且 summary≥80；无值默认 high
    backcheckConfidence: text(item.backcheckConfidence) ? item.backcheckConfidence : 'high',
    // hasDetailedBackcheck 要求 summary≥20（fieldsComplete）；这里落 evidenceSummary 供判定读取
    evidenceSummary: summary,
    // hasDetailedBackcheck 条件3：backCheck.mainProducts/products 有值。toBackCheckData 把 LLM 提取产品
    // 写入 backCheck.products（从不写 mainProducts），这里对齐（与 processOne 放行分支完全一致）；
    // 基于原始 item.backCheck 展开，不丢已有字段，mainProducts 已有则保留。
    backCheck: (() => {
      const b = item.backCheck || {}
      const products = Array.isArray(b.products) ? b.products : []
      const mainProducts = Array.isArray(b.mainProducts) ? b.mainProducts : []
      return products.length > 0 && mainProducts.length === 0 ? { ...b, mainProducts: products } : b
    })(),
    normalizedStage: undefined,
    currentAllowedStage: undefined,
    eligibilityBlockedReasons: undefined,
    nextRequiredAction: undefined,
  }
  if (next.operationalTier === 'manual_review') next.operationalTier = undefined
  return applyEligibilityStage(next, now, {
    formalSentEmails: getFormalSentEmailsCached(),
    testMailVerdicts: getTestMailVerdictsCached(),
  }).item
}

/**
 * 单条处理（同步部分；异步二次补抓在外层进行）。
 * 返回处理后的 item（不含写库，写库由调用方原子完成）。
 */
async function processOne(
  raw: any,
  now: Date,
  ctx: {
    stats: BackcheckAutoStats
    version: string
    backfillTimeoutMs: number
    backfillFn: (item: any, now: Date) => Promise<{ item: any; changed: boolean; resolvedUrl?: string; error?: string }>
  },
): Promise<any> {
  let current = { ...raw }

  // 1. 已有人工结论 → 不覆盖
  if (getAutoBackcheckRoute(current, now).route === 'preserve_manual') return stamp(current, ctx.version, now)

  // 2. 数据不足 → 二次补抓（缺官网/产品/行业/所在地/语言/国家，或从未背调 / 存在缺口）
  const needsBackfill =
    !hasWebsite(current) || !hasBackcheckData(current)
    || (Array.isArray(current.evidenceGaps) && current.evidenceGaps.length > 0)
    || current.backcheckStatus === 'incomplete'
  if (needsBackfill && exhaustedRetryDue(current, now)) {
    current.backcheckAttempts = 0
    current.backcheckRetryCycle = Number(current.backcheckRetryCycle || 0) + 1
    current.backcheckRetryStartedAt = now.toISOString()
    delete current.backcheckNextRetryAt
  }
  if (needsBackfill && hasBackfillBudget(current)) {
    try {
      const bf = await withTimeout(ctx.backfillFn(current, now), ctx.backfillTimeoutMs)
      // 无论 changed 与否都采用返回的 item：backfillBackcheckGaps 无条件递增
      // backcheckAttempts（firecrawlService.ts:398），若只在 changed 时采用，
      // 提取失败项（changed=false）attempts 永不递增 → 永远满足候选条件被反复选中，
      // slice(0,maxPerTick) 饿死其余 backcheck_queue 项（bq 长期卡住不动）。
      if (bf?.item) {
        current = bf.item
        current.updatedAt = now.toISOString()
        if (bf?.error) current.lastError = `backfill:${bf.error}`
      } else if (bf?.error) {
        current.lastError = `backfill:${bf.error}`
      }
    } catch (err) {
      current.lastError = `backfill:${err instanceof Error ? err.message : String(err)}`
    }
  }

  // 3. 路由判定（供应商 / 聚合站·排除 / 保留人工）
  const route = getAutoBackcheckRoute(current, now).route
  if (route === 'preserve_manual') return stamp(current, ctx.version, now)
  if (route === 'supplier_pool') {
    ctx.stats.suppliersRouted++
    const poolItem = applyAutoBackcheckRouting(current, now).item
    try { appendSupplierToPool(poolItem) } catch (err) { poolItem.lastError = `supplierPool:${err instanceof Error ? err.message : String(err)}` }
    return stamp(poolItem, ctx.version, now)
  }
  if (route === 'inactive_excluded') {
    ctx.stats.inactiveExcluded++
    const routed = applyAutoBackcheckRouting(current, now).item
    // applyAutoBackcheckRouting 只改 normalizedStage；须经 applyEligibilityStage 落到
    // 真正的 primaryStage（true_excluded），否则 primaryStage 仍为 backcheck_queue，
    // attempts 耗尽后永久滞留（历史 11 条卡死根因）。
    return stamp(applyEligibilityStage(routed, now, {
      formalSentEmails: getFormalSentEmailsCached(),
      testMailVerdicts: getTestMailVerdictsCached(),
    }).item, ctx.version, now)
  }

  // 4. 完整性判定（国家/官网/产品/行业/所在地/语言/业务字段齐全）
  const assessment = assessDetailedBackcheck(current)
  const gaps = Array.isArray(assessment.evidenceGaps) ? assessment.evidenceGaps : []
  const business = text(current.businessMatch || assessment.businessMatch).toLowerCase()
  const value = text(current.importCommercialValue || assessment.importCommercialValue).toLowerCase()

  // 明确不匹配/非买家不再等待“补全所有字段”：这类记录已经有足够的排除结论，
  // 直接进入隔离池，避免把无效数据长期留在背调队列占用名额。
  if (business === 'none' || value === 'none' || ['directory_news_platform', 'non_buyer_entity'].includes(String(assessment.customerType || ''))) {
    ctx.stats.inactiveExcluded++
    const classified = { ...current, businessMatch: business, importCommercialValue: value, customerType: assessment.customerType }
    const routed = applyAutoBackcheckRouting(classified, now).item
    return stamp(applyEligibilityStage(routed, now, {
      formalSentEmails: getFormalSentEmailsCached(),
      testMailVerdicts: getTestMailVerdictsCached(),
    }).item, ctx.version, now)
  }

  // 5. 完整 + 高/中业务匹配 + 无排除信号 → 自动放行（跳过人工审批 auto_qualified_pending_human）
  if (gaps.length === 0 && ['high', 'medium'].includes(business) && ['high', 'medium'].includes(value) && !hasExcludedSignal(current)) {
    ctx.stats.autoApproved++
    const assessed = applyAutomaticBackcheckResult(
      current,
      current.backCheck || {},
      text(current.website) || text(current.backCheck?.companyWebsite) || undefined,
      now,
    )
    const auto = stamp({
      ...assessed,
      backcheckDecision: 'auto_approved',
      approvedBy: 'pipeline-stepper',
      reviewedBy: 'pipeline-stepper',
      reviewDisposition: 'active',
      reviewReason: '自动放行：背调完整且高/中业务匹配（pipeline-stepper）',
      reviewUpdatedAt: now.toISOString(),
      backcheckStatus: 'done',
      // 完整项须为 []（hasDetailedBackcheck 要求 evidenceGaps!==undefined 才放行）
      evidenceGaps: [],
      // hasDetailedBackcheck 条件1：detailedBackcheckAt 必须有值才判定背调完整
      detailedBackcheckAt: now.toISOString(),
      // hasDetailedBackcheck 条件2：backcheckConfidence∈{high,medium,low} 且 summary≥80；无值默认 high
      backcheckConfidence: text(current.backcheckConfidence) ? current.backcheckConfidence : 'high',
      // hasDetailedBackcheck 条件3：backCheck.mainProducts/products 有值且 summary≥160。
      // toBackCheckData 把 LLM 提取产品写入 backCheck.products（从不写 mainProducts），这里对齐；
      // 基于 assessed.backCheck（含 companyWebsite 合并）展开，不丢已有字段，mainProducts 已有则保留。
      backCheck: (() => {
        const b = assessed.backCheck || {}
        const products = Array.isArray(b.products) ? b.products : []
        const mainProducts = Array.isArray(b.mainProducts) ? b.mainProducts : []
        return products.length > 0 && mainProducts.length === 0 ? { ...b, mainProducts: products } : b
      })(),
      nextRequiredAction: undefined,
      eligibilityBlockedReasons: undefined,
    }, ctx.version, now)
    // 重算阶段 → 流入 contact_mining_queue / email_validation_queue
    return applyEligibilityStage(auto, now, {
      formalSentEmails: getFormalSentEmailsCached(),
      testMailVerdicts: getTestMailVerdictsCached(),
    }).item
  }

  // 6. 仍未完整 → 留在 backcheck_queue（标注缺口，不硬拦）
  ctx.stats.incomplete++
  const attempts = Number(current.backcheckAttempts || 0)
  const incompleteStage = hasWebsite(current) ? 'backcheck_queue' : 'data_enrichment_needed'
  return stamp({
    ...current,
    backcheckStatus: 'incomplete',
    evidenceGaps: gaps.length > 0 ? gaps : (Array.isArray(current.evidenceGaps) && current.evidenceGaps.length > 0 ? current.evidenceGaps : ['背调不完整']),
    recommendedAction: text(current.recommendedAction) ? current.recommendedAction : 'manual_review',
    primaryStage: incompleteStage,
    normalizedStage: incompleteStage,
    currentAllowedStage: incompleteStage,
    nextRequiredAction: incompleteStage === 'backcheck_queue' ? '待背调自动补抓' : '待补充公司数据',
    ...(attempts >= MAX_BACKCHECK_ATTEMPTS ? { backcheckNextRetryAt: new Date(now.getTime() + BACKCHECK_RETRY_COOLDOWN_MS).toISOString() } : {}),
    activeWorkflow: true,
    inactiveWorkflow: false,
  }, ctx.version, now)
}

/**
 * 后台自动消费背调队列（每 tick ≤ maxPerTick 条）。
 * 单条失败只记 lastError，不中断整批；二次补抓在原子写库前完成。
 */
export async function runBackcheckAutoStep(
  now: Date,
  deps: BackcheckAutoDeps = {},
): Promise<BackcheckAutoStats> {
  const stats: BackcheckAutoStats = { processed: 0, autoApproved: 0, suppliersRouted: 0, inactiveExcluded: 0, incomplete: 0, manualAutoApproved: 0 }
  const itemsStorePath = deps.itemsStorePath || ITEMS_STORE_FILE
  const version = deps.version || DEFAULT_VERSION
  const maxPerTick = deps.maxPerTick ?? DEFAULT_MAX_PER_TICK
  const backfillTimeoutMs = Math.max(1, Number(deps.backfillTimeoutMs || DEFAULT_BACKFILL_TIMEOUT_MS))
  const backfillFn = deps.backfillFn || backfillBackcheckGaps
  const effectiveNow = deps.now || now

  try {
    const items = readItemsAtomic(itemsStorePath)

    // ── 阶段1（原有）：backcheck_queue 自动消费 ──
    const candidates = items.filter((it: any) =>
      isActiveCrmMaster(it)
      && ['backcheck_queue', 'data_enrichment_needed'].includes(String(it?.primaryStage || it?.normalizedStage || ''))
      // 有人工结论的项 preserve_manual 早返回只 stamp 不清 gaps，排除避免每 tick 空转
      && !hasExplicitManualConclusion(it)
      // 同一版本已处理过的项必须让出本轮名额；否则一个无法补全的首条记录会反复占据
      // slice(0, maxPerTick)，让后续背调数据长期饥饿。下一轮使用新版本号再重试。
      && it?.stepperVersion !== version,
    ).slice(0, maxPerTick)

    if (candidates.length > 0) {
      // 每条完成后立即原子写回，避免后续慢记录让整批结果无法落盘。
      const processCandidate = async (item: any) => {
        stats.processed++
        let processed: any
        try {
          processed = await processOne(item, effectiveNow, { stats, version, backfillTimeoutMs, backfillFn })
        } catch (err) {
          processed = stamp({
            ...item,
            lastError: `process:${err instanceof Error ? err.message : String(err)}`,
            updatedAt: effectiveNow.toISOString(),
          }, version, effectiveNow)
        }
        try {
          updateOneItemAtomic(item.id, cur => isActiveCrmMaster(cur) ? rebaseBackcheckChanges(item, processed, cur) : cur, itemsStorePath)
        } catch (err) {
          try {
            updateOneItemAtomic(item.id, (cur) => ({
              ...cur,
              lastError: `write:${err instanceof Error ? err.message : String(err)}`,
              updatedAt: effectiveNow.toISOString(),
            }), itemsStorePath)
          } catch { /* swallow */ }
        }
      }
      await processCandidate(candidates[0])
      await Promise.all(candidates.slice(1).map(processCandidate))
    }

    // ── 阶段2（新增）：存量 manual_review 自动审批放行 ──
    // 同步、无网络；每 tick 单独 ≤ maxPerTick 条（与阶段1共享预算的上限口径一致）。
    const manualCandidates = items
      .filter((it: any) => isActiveCrmMaster(it) && isManualReviewReleaseCandidate(it, version))
      .slice(0, maxPerTick)
    for (const item of manualCandidates) {
      try {
        const result = updateOneItemAtomic(item.id, cur =>
          isActiveCrmMaster(cur) && isManualReviewReleaseCandidate(cur, version)
            ? approveManualReview(cur, effectiveNow, version)
            : cur,
        itemsStorePath)
        if (result.changed) stats.manualAutoApproved++
      } catch (err) {
        // 单条失败只记 lastError，不中断整批
        try {
          updateOneItemAtomic(item.id, (cur) => ({
            ...cur,
            lastError: `manualRelease:${err instanceof Error ? err.message : String(err)}`,
            updatedAt: effectiveNow.toISOString(),
          }), itemsStorePath)
        } catch { /* swallow */ }
      }
    }
  } catch (err) {
    if (deps.lastError && typeof deps.lastError === 'object') {
      deps.lastError.backcheck = err instanceof Error ? err.message : String(err)
    }
  }
  return stats
}
