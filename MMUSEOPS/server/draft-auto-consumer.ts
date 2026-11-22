import { EMAIL_CONTACT } from '../src/services/emailSignature'
/**
 * 草稿自动生成消费（批次3 / 草稿自动生成 T3）。
 *
 * 职责：自动消费 primaryStage==='developable_email_pool' 的项（每 tick ≤ 1 条），全流程自动循环，不依赖人工触发：
 *   1. 无未发送草稿（manualEmailDrafts 里 sent!==true）→ 调草稿生成函数生成开发信草稿，
 *      写 manualEmailDrafts[]，置 status='approved'（主公标准 2026-08-07：前期流程走完即合格，
 *      不再人工审草稿；发送门禁 manual_confirmation_required 仅 warning）。
 *   2. 生成后调用 formal 入队/审批事务（approveFormalDraftTransaction）把该草稿入 formal_send_queue
 *      （sendQueueStatus='approved_for_sending'），并写入 selectedEmail（与草稿收件人一致，
 *      避免 recipient_identity_mismatch）。
 *   3. 每条盖 stepperVersion + autoDraftAt；单条失败只记 lastError 不中断；草稿写入后进程内调
 *      applyEligibilityStage 重算阶段 → 自然流入 scheduled_send_queue（放一个过一个）。
 *
 * 写库采用 items-store-atomic.ts 的 updateOneItemAtomic（进程内已算好阶段再原子写回）+
 * formal-approval-transaction.ts 的 approveFormalDraftTransaction（事务内 refreshOnlyMutated 重算阶段、
 * 幂等按 customerId+draftId 去重），与 backcheck/contact-mining 同款模式。
 *
 * 不挂载到 backgroundTick / pipeline-stepper；仅提供可调用导出函数（挂载留批次末统一接入）。
 */

import { randomUUID } from 'node:crypto'
import { readItemsAtomic, updateOneItemAtomic, ITEMS_STORE_FILE } from './items-store-atomic'
import { FORMAL_SEND_QUEUE_FILE, partitionFormalQueueRecords, readFormalSendQueue } from './formal-send-queue-store'
import { approveFormalDraftTransaction } from './formal-approval-transaction'
import { generateLlmDraft } from './llm-draft-generator'
import { furnitureChannelAllows } from '../src/services/businessLinePolicy'
import { applyEligibilityStage } from '../src/services/leadStageEligibility'
import { OFFICIAL_OUTREACH_EMAIL } from '../src/services/outreachIdentity'
import { getFormalSentEmailsCached } from './formal-sent-email-set'
import { getTestMailVerdictsCached } from './test-mail-verdicts'
import { deriveAddressVerificationState } from '../src/services/emailCandidateView'
import type { FormalSendQueueRecord } from '../src/services/formalSendQueue'

export interface DraftAutoStats {
  generated: number
  enqueued: number
  failed: number
}

export interface DraftAutoDeps {
  /** Trusted in-process scope, never supplied as an untrusted HTTP path. */
  targetIds?: ReadonlySet<string>
  /** 覆盖 items_store.json 路径（测试/独立库用） */
  itemsStorePath?: string
  /** 覆盖 formal_send_queue.json 路径（测试/独立库用） */
  queuePath?: string
  /** 覆盖当前时间 */
  now?: Date
  /** 每 tick 最多处理条数（默认 1） */
  maxPerTick?: number
  /** stepper 版本戳（防同版本重复处理；换版本号即重新消费） */
  version?: string
  /** 草稿生成函数注入（默认 llmDraftAdapter；测试可传 mock 避免依赖 LLM/具体模板） */
  generateDraftFn?: (item: any, variant?: number) => { to: string; subject: string; body: string } | Promise<{ to: string; subject: string; body: string }>
  /** formal 入队/审批事务注入（默认 approveFormalDraftTransaction；测试可传 mock） */
  enqueueFormalFn?: (record: FormalSendQueueRecord, opts: { queuePath: string; itemsPath: string }) => Promise<any>
  /** LLM 停机（LLM_UNAVAILABLE）/重写耗尽（REWRITE_EXHAUSTED）后的重试间隔（默认 15 分钟） */
  autoDraftRetryAfterMs?: number
  /** 上层巡检可读的错误槽（整体步骤异常同时向stepper抛出） */
  lastError?: Record<string, unknown>
  /** 仅补建已批准草稿的丢失队列任务，不生成新草稿。 */
  reconcileOnly?: boolean
}

const DEFAULT_VERSION = 'draft-auto-consumer-v1'
const DEFAULT_MAX_PER_TICK = 1
const DEFAULT_AUTO_DRAFT_RETRY_AFTER_MS = 15 * 60 * 1000

function text(v: unknown): string { return String(v || '').trim() }
function stamp(item: any, version: string, now: Date): any {
  return { ...item, stepperVersion: version, autoDraftAt: now.toISOString(), updatedAt: now.toISOString() }
}

/** 主公 2026-08-21：没验证过不能进入排期发送。验证过 = deriveAddressVerificationState === 'accepted'。 */
function emailVerified(item: any, now: Date): boolean {
  const sel = String(item?.selectedEmail || '').trim().toLowerCase()
  if (!sel) return false
  return deriveAddressVerificationState(item, sel, now) === 'accepted'
}

/** 是否有"未发送且未作废"的手工草稿。superseded = 已被 LLM 定向草稿取代（08-25 收敛标记），不再拦截自动生成。 */
export function hasPendingManualDraft(item: any): boolean {
  return Array.isArray(item?.manualEmailDrafts) && item.manualEmailDrafts.some((d: any) => d?.sent !== true && d?.status !== 'superseded')
}

function hasCurrentPendingManualDraft(item: any): boolean {
  const selected = text(item?.selectedEmail).toLowerCase()
  return Boolean(selected) && Array.isArray(item?.manualEmailDrafts) && item.manualEmailDrafts.some((draft: any) => (
    draft?.sent !== true && draft?.status !== 'superseded' && text(draft?.to).toLowerCase() === selected
  ))
}

/** 生成一条 manualEmailDrafts 草稿（status='approved'，主公标准：前期流程走完即合格，不再人工审）。 */
function buildDraftEntry(item: any, gen: { to: string; subject: string; body: string }, version: string, now: Date): any {
  const at = now.toISOString()
  const to = text(gen.to)
  return {
    id: `auto-draft-${String(item.id || '')}-${randomUUID().slice(0, 8)}`,
    campaignKey: 'draft-auto-consumer',
    companyName: text(item.company || item.title),
    to,
    recipientType: 'personal',
    subject: text(gen.subject),
    body: text(gen.body),
    senderEmail: OFFICIAL_OUTREACH_EMAIL,
    replyToEmail: OFFICIAL_OUTREACH_EMAIL,
    brand: EMAIL_CONTACT.company || 'Your company',
    language: 'en',
    status: 'approved',
    sent: false,
    riskTier: 'A',
    riskReason: '自动生成：前期流程走完即合格（draft-auto-consumer）',
    rationale: '自动生成并批准（主公标准 2026-08-07：不再人工审草稿）。',
    manualChecks: ['Auto generated and approved by draft-auto-consumer'],
    version: 1,
    createdAt: at,
    updatedAt: at,
    manualRiskConfirmed: true,
    manualRiskConfirmedAt: at,
    manualRiskConfirmedBy: 'draft-auto-consumer',
    autoDraftAt: at,
    stepperVersion: version,
  }
}

/** 生成一条 formal_send_queue 记录（status='approved_for_sending'，收件人与草稿/selectedEmail 一致）。 */
function buildQueueRecord(item: any, draft: any, now: Date): FormalSendQueueRecord {
  const at = now.toISOString()
  return {
    id: `queue-draft-auto-${String(item.id || '')}-${String(draft.id || '')}`,
    campaignId: 'draft-auto-consumer',
    campaignName: '自动生成草稿（draft-auto-consumer）',
    channel: 'formal_outreach',
    draftId: text(draft.id),
    customerId: String(item.id || ''),
    recipientEmail: text(draft.to),
    senderEmail: OFFICIAL_OUTREACH_EMAIL,
    replyToEmail: OFFICIAL_OUTREACH_EMAIL,
    approvedAt: at,
    approvedBy: 'draft-auto-consumer',
    draftVersion: Number(draft.version) || 1,
    draftRevision: text(draft.updatedAt),
    isOneTimeSchedule: true,
    sendWindowLocal: 'auto 60-240s interval (draft-auto-consumer)',
    sendQueueStatus: 'approved_for_sending',
    sendAttemptCount: 0,
    provider: 'zoho_smtp',
    createdAt: at,
    updatedAt: at,
  }
}

async function defaultEnqueueFormal(record: FormalSendQueueRecord, opts: { queuePath: string; itemsPath: string }) {
  return approveFormalDraftTransaction(record, { queuePath: opts.queuePath, itemsPath: opts.itemsPath })
}

/**
 * 默认草稿生成函数：LLM 一对一定向生成（替代 @deprecated generateDraft 静态模板）。
 * 缺 selectedEmail 是结构性失败（不会自愈），与 generateDraft 同口径抛 SELECTED_EMAIL_REQUIRED
 * （消费端按现状永久跳过）；LLM 停机/重写耗尽抛对应错误，由 runDraftAutoStep 写 autoDraftRetryAt 退避。
 */
async function llmDraftAdapter(item: any): Promise<{ to: string; subject: string; body: string }> {
  const to = String(item.selectedEmail || '').trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new Error('SELECTED_EMAIL_REQUIRED')
  const result = await generateLlmDraft(item)
  if (result.ok === false) {
    if (result.reason === 'rewrite_exhausted') throw new Error('REWRITE_EXHAUSTED')
    throw new Error('LLM_UNAVAILABLE')
  }
  return { to, subject: result.draft.subject, body: result.draft.body }
}

/**
 * 单条处理：生成草稿 → 写库（盖戳 + 重算阶段）→ formal 入队。
 * 返回 { item, generated, enqueued }；抛错由外层记 lastError + failed。
 */
async function processOne(
  raw: any,
  now: Date,
  ctx: {
    version: string
    itemsStorePath: string
    queuePath: string
    generateDraftFn: (item: any, variant?: number) => { to: string; subject: string; body: string } | Promise<{ to: string; subject: string; body: string }>
    enqueueFormalFn: (record: FormalSendQueueRecord, opts: { queuePath: string; itemsPath: string }) => Promise<any>
  },
): Promise<{ item: any; generated: boolean; enqueued: boolean }> {
  if (!furnitureChannelAllows(raw)) throw new Error('BUSINESS_LINE_MISMATCH')
  // 已有批准草稿但 formal 事务曾中断：幂等补建队列任务，不重新生成正文。
  if (hasCurrentPendingManualDraft(raw)) {
    const draft = [...(Array.isArray(raw.manualEmailDrafts) ? raw.manualEmailDrafts : [])]
      .filter((value: any) => value?.sent !== true && value?.status === 'approved')
      .sort((a: any, b: any) => Date.parse(b?.updatedAt || b?.createdAt || '') - Date.parse(a?.updatedAt || a?.createdAt || ''))[0]
    if (!draft) return { item: stamp(raw, ctx.version, now), generated: false, enqueued: false }
    await ctx.enqueueFormalFn(buildQueueRecord(raw, draft, now), { queuePath: ctx.queuePath, itemsPath: ctx.itemsStorePath })
    return { item: stamp(raw, ctx.version, now), generated: false, enqueued: true }
  }

  // 主公 2026-08-21：没验证过不能进入排期发送。生成草稿前校验选中邮箱验证态，
  // 非 accepted → 抛 EMAIL_NOT_VERIFIED（retryable，写 autoDraftRetryAt 退避，防每 tick 饿死）。
  if (!emailVerified(raw, now)) throw new Error('EMAIL_NOT_VERIFIED')

  const gen = await ctx.generateDraftFn(raw, 0)
  const draft = buildDraftEntry(raw, gen, ctx.version, now)
  const selected = text(raw.selectedEmail).toLowerCase() === text(draft.to).toLowerCase() ? raw.selectedEmail : draft.to

  // 写草稿 + 盖戳 + 进程内重算阶段（approved 草稿 → scheduled_send_queue），原子写回
  const staged = updateOneItemAtomic(raw.id, (cur) => {
    if (!furnitureChannelAllows(cur)) throw new Error('BUSINESS_LINE_MISMATCH')
    const base = { ...cur, updatedAt: now.toISOString() }
    const withDraft = {
      ...base,
      manualEmailDrafts: [
        ...(Array.isArray(base.manualEmailDrafts) ? base.manualEmailDrafts : []).map((existing: any) => (
          existing?.sent !== true && existing?.status !== 'superseded' && text(existing?.to).toLowerCase() !== text(draft.to).toLowerCase()
            ? { ...existing, status: 'superseded', supersededAt: now.toISOString(), supersededBy: ctx.version, updatedAt: now.toISOString() }
            : existing
        )),
        draft,
      ],
      selectedEmail: selected,
      preferredEmail: text(base.preferredEmail) && text(base.preferredEmail).toLowerCase() === text(base.selectedEmail).toLowerCase()
        ? base.preferredEmail
        : selected,
      stepperVersion: ctx.version,
      autoDraftAt: now.toISOString(),
    }
    return applyEligibilityStage(withDraft, now, {
      formalSentEmails: getFormalSentEmailsCached(),
      testMailVerdicts: getTestMailVerdictsCached(),
    }).item
  }, ctx.itemsStorePath)

  // formal 入队/审批事务（幂等按 customerId+draftId；事务内 refreshOnlyMutated 重算阶段）
  const record = buildQueueRecord({ ...raw, selectedEmail: selected, manualEmailDrafts: [...(Array.isArray(raw.manualEmailDrafts) ? raw.manualEmailDrafts : []), draft] }, draft, now)
  await ctx.enqueueFormalFn(record, { queuePath: ctx.queuePath, itemsPath: ctx.itemsStorePath })

  return { item: staged.item, generated: true, enqueued: true }
}

/**
 * 后台自动消费草稿生成队列（每 tick ≤ 1 条）。
 * 单条失败只记 lastError，不中断整批；formal 入队失败时草稿已落库（approved 但未入队），
 * 该条计 failed，留待审批事务幂等重放或人工复核，不会重复生成。
 */
export async function runDraftAutoStep(
  now: Date,
  deps: DraftAutoDeps = {},
): Promise<DraftAutoStats> {
  const stats: DraftAutoStats = { generated: 0, enqueued: 0, failed: 0 }
  const itemsStorePath = deps.itemsStorePath || ITEMS_STORE_FILE
  const queuePath = deps.queuePath || FORMAL_SEND_QUEUE_FILE
  const version = deps.version || DEFAULT_VERSION
  const maxPerTick = deps.maxPerTick ?? DEFAULT_MAX_PER_TICK
  const effectiveNow = deps.now || now
  const retryAfterMs = deps.autoDraftRetryAfterMs ?? DEFAULT_AUTO_DRAFT_RETRY_AFTER_MS
  const generateDraftFn = deps.generateDraftFn || llmDraftAdapter
  const enqueueFormalFn = deps.enqueueFormalFn || defaultEnqueueFormal

  try {
    const items = readItemsAtomic(itemsStorePath)
    const currentFormalCustomers = new Set(partitionFormalQueueRecords(readFormalSendQueue(queuePath).records, items).active.map(record => String(record.customerId || '')))
    const candidates = items.filter((it: any) => {
      if(deps.targetIds&&!deps.targetIds.has(String(it?.id||'')))return false
      const itemStage = String(it?.primaryStage || it?.normalizedStage || '')
      const freshDraftCandidate = deps.reconcileOnly !== true && itemStage === 'developable_email_pool' && it?.stepperVersion !== version && !hasCurrentPendingManualDraft(it)
      const orphanedApprovedDraft = itemStage === 'scheduled_send_queue' && hasCurrentPendingManualDraft(it) && !currentFormalCustomers.has(String(it?.id || ''))
      if (!freshDraftCandidate && !orphanedApprovedDraft) return false
      return (
      // 缺 selectedEmail 是结构性失败（不会自愈），跳过防止每 tick 重复失败饿死后续候选
      !String(it?.lastError || '').includes('draft_auto:SELECTED_EMAIL_REQUIRED')
      // LLM 停机/重写耗尽写入的退避时间未到 → 跳过，避免每 tick 对同一候选反复失败饿死后续候选
      && !(it?.autoDraftRetryAt && Number.isFinite(Date.parse(it.autoDraftRetryAt)) && Date.parse(it.autoDraftRetryAt) > effectiveNow.getTime())
      // 业务线隔离（2026-08-11 主公指正）：car-seat 客户一律不生成家具开发信草稿
      && furnitureChannelAllows(it)
      // 主公 2026-08-21：没验证过不能进入排期发送。选中邮箱验证态非 accepted → 不生成草稿
      && (orphanedApprovedDraft || emailVerified(it, effectiveNow))
      )
    }
    ).slice(0, maxPerTick)
    if (candidates.length === 0) return stats

    for (const item of candidates) {
      try {
        const res = await processOne(item, effectiveNow, { version, itemsStorePath, queuePath, generateDraftFn, enqueueFormalFn })
        if (res.generated) stats.generated++
        if (res.enqueued) stats.enqueued++
      } catch (err) {
        stats.failed++
        const errMsg = err instanceof Error ? err.message : String(err)
        // LLM 停机/重写耗尽/邮箱未验证 → 写 autoDraftRetryAt 退避（默认 15 分钟），避免每 tick 反复失败饿死后续候选；
        // SELECTED_EMAIL_REQUIRED 等结构性错误不写退避，靠 lastError 判断永久跳过（现状保留）。
        const retryable = errMsg.includes('LLM_UNAVAILABLE') || errMsg.includes('REWRITE_EXHAUSTED') || errMsg.includes('EMAIL_NOT_VERIFIED')
        try {
          updateOneItemAtomic(item.id, (cur) => ({
            ...cur,
            lastError: `draft_auto:${errMsg}`,
            ...(retryable ? { autoDraftRetryAt: new Date(effectiveNow.getTime() + retryAfterMs).toISOString() } : {}),
            updatedAt: effectiveNow.toISOString(),
          }), itemsStorePath)
        } catch { /* swallow */ }
      }
    }
  } catch (err) {
    if (deps.lastError && typeof deps.lastError === 'object') {
      deps.lastError.draftAuto = err instanceof Error ? err.message : String(err)
    }
    // A whole-step/store failure must reach the existing stepper failure settlement.
    throw err
  }
  return stats
}
