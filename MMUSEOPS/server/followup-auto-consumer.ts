import { EMAIL_CONTACT } from '../src/services/emailSignature'
/**
 * followup 自动跟进消费（批次4 / 持续跟进 + 回收闭环）。
 *
 * 职责：自动消费 primaryStage==='followup_queue' 的项（每 tick 默认 ≤ 10 条），全流程自动循环，不依赖人工触发：
 *   1. 到期判定：正式发送时批次3 formal-auto-runner 已写入 followupDueAt3d（跟进1）与 followupDueAt7d（跟进2），
 *      任一轮次到期（<= now）且该轮尚未生成跟进草稿 → 自动跟进。
 *   2. 客户已回复（replied_queue 状态 / emailLogs 有 reply_observed / recovery 标记回复）→ 跳过
 *      （skipped++，不跟进，避免打扰已回复客户；回复项在此顺手重算阶段 → 回收进 replied_queue）。
 *   3. 已跟进过（followupSentAt 存在 / manualEmailDrafts 已存在该轮 followup 草稿）→ 跳过（防重复生成）。
 *   4. 到期未回复：调 generateFollowUpDraft（emailGenerator 同源）生成跟进开发信 → 写 manualEmailDrafts[]
 *      status='approved'（round 标注 1/2）→ 入队 formal_send_queue（复用 approveFormalDraftTransaction，
 *      幂等按 customerId+draftId，入队收件人与草稿一致、发件人为正式邮箱、approved 标记）。
 *   5. 跟进发送由批次3 runFormalAutoStep 统一执行（本批次只负责"到期→生成跟进草稿→入队"，不直接发送）；
 *      符合资格的跟进草稿进入正式排期队列，由正式发送器按排期、抑制名单和额度逐封处理。
 *   6. 每条盖 stepperVersion + autoFollowupAt 戳；失败记 lastError 不中断；drafted 项写库后进程内
 *      applyEligibilityStage 重算阶段（formalSent 命中 → 仍停留 followup_queue，放一个过一个）。
 *
 * 轮次/去重说明：跟进两轮（3d→round 1，7d→round 2）。候选筛选只按 stage，不做 stepperVersion 排他
 * （followup 项 formalSent 命中会长期停留 followup_queue，用"该轮草稿已存在"做轮次去重，避免同轮重复生成；
 * 也未到期的轮次不写库，下 tick 到期后仍可被消费）。回复后任一阶段均跳过，后续不再跟进。
 *
 * 写库采用 items-store-atomic.ts 的 updateOneItemAtomic（进程内已算好阶段再原子写回）+
 * formal-approval-transaction.ts 的 approveFormalDraftTransaction，与 draft-auto-consumer 同款模式。
 *
 * 不挂载到 backgroundTick / pipeline-stepper；仅提供可调用导出函数（挂载留批次末统一接入）。
 */

import { randomUUID } from 'node:crypto'
import { readItemsAtomic, updateOneItemAtomic, ITEMS_STORE_FILE } from './items-store-atomic'
import { ACTIVE_FORMAL_QUEUE_STATUSES, FORMAL_SEND_QUEUE_FILE, readFormalSendQueue } from './formal-send-queue-store'
import { approveFormalDraftTransaction } from './formal-approval-transaction'
import { generateFollowUpDraft } from '../src/data/emailGenerator'
import { applyEligibilityStage } from '../src/services/leadStageEligibility'
import { hasFormalOutreachReply } from '../src/services/formalOutreachLifecycle'
import { OFFICIAL_OUTREACH_EMAIL } from '../src/services/outreachIdentity'
import { getFormalSentEmailsCached } from './formal-sent-email-set'
import { getTestMailVerdictsCached } from './test-mail-verdicts'
import type { FormalSendQueueRecord } from '../src/services/formalSendQueue'

export interface FollowupAutoStats {
  /** 本轮到期、待跟进（未回复且未生成该轮草稿）的 followup_queue 项数 */
  due: number
  /** 已生成跟进草稿的项数 */
  drafted: number
  /** 已入队 formal_send_queue 的跟进记录数 */
  enqueued: number
  /** 跳过的项数（客户已回复 / 已跟进过 / 未到期） */
  skipped: number
  /** 本轮失败并已安排重试的项数 */
  failed: number
  /** 本轮达到失败上限并进入隔离的项数 */
  quarantined: number
}

export interface FollowupAutoDeps {
  /** 覆盖 items_store.json 路径（测试/独立库用） */
  itemsStorePath?: string
  /** 覆盖 formal_send_queue.json 路径（测试/独立库用） */
  queuePath?: string
  /** 覆盖当前时间 */
  now?: Date
  /** 每 tick 最多处理条数（默认 10） */
  maxPerTick?: number
  /** stepper 版本戳（审计标记，不用于排他筛选） */
  version?: string
  /** 跟进草稿生成函数注入（默认 generateFollowUpDraft；测试可传 mock） */
  generateFollowUpFn?: (item: any, lastLog?: any) => { to: string; subject: string; body: string } | Promise<{ to: string; subject: string; body: string }>
  /** formal 入队/审批事务注入（默认 approveFormalDraftTransaction；测试可传 mock） */
  enqueueFormalFn?: (record: FormalSendQueueRecord, opts: { queuePath: string; itemsPath: string }) => Promise<any>
  /** 上层巡检可读的错误槽（本函数只写，不抛） */
  lastError?: Record<string, unknown>
}

const DEFAULT_VERSION = 'followup-auto-consumer-v1'
const DEFAULT_MAX_PER_TICK = 10
const FOLLOWUP_CAMPAIGN = 'followup-auto-consumer'
const MAX_FAILURES = 8
const FAILURE_BACKOFF_MS = [15 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000] as const
const QUEUE_CLAIM_TTL_MS = 15 * 60_000
const QUEUE_RECOVERY_GRACE_MS = 15 * 60_000
/** 跟进去重窗口：该收件邮箱 21 天内已正式发送过 → 排期层跳过，不重复入队（与门禁层 too_frequent_followup 对齐）。 */
const FOLLOWUP_DEDUP_WINDOW_MS = 21 * 24 * 60 * 60 * 1000

/** 跟进计划：round 1 → followupDueAt3d，round 2 → followupDueAt7d（正式发送时由 formal-auto-runner 写入）。 */
const FOLLOWUP_PLAN = [
  { round: 1, field: 'followupDueAt3d' },
  { round: 2, field: 'followupDueAt7d' },
] as const

/** 单轮草稿已终结（被拒/失败/被替换）时只跳过该轮，不能阻断后续到期轮次。 */
const TERMINAL_FOLLOWUP_DRAFT_STATUSES = new Set(['rejected', 'failed', 'send_failed', 'superseded'])

function text(v: unknown): string { return String(v || '').trim() }

/** manualEmailDrafts 中属于本跟进模块的草稿（campaignKey 命中 / followup 标记 / type='followup'）。 */
function followupDrafts(item: any): any[] {
  return (Array.isArray(item?.manualEmailDrafts) ? item.manualEmailDrafts : []).filter((d: any) =>
    !d?.followupSupersededAt && (
      text(d?.campaignKey) === FOLLOWUP_CAMPAIGN
      || d?.followup === true
      || text(d?.type).toLowerCase() === 'followup'
    ),
  )
}

/** 隔离只对失败时的输入快照生效；关键输入变化后自动允许重新评估。 */
function followupInputFingerprint(item: any): string {
  return JSON.stringify({
    recipientEmail: text(item?.selectedEmail || item?.preferredEmail || item?.email).toLowerCase(),
    company: text(item?.company || item?.title),
    website: text(item?.website || item?.sourceUrl),
    contacts: Array.isArray(item?.contacts) ? item.contacts : [],
    emailLogs: Array.isArray(item?.emailLogs) ? item.emailLogs : [],
    followupDueAt3d: text(item?.followupDueAt3d),
    followupDueAt7d: text(item?.followupDueAt7d),
  })
}

function quarantineNeedsRecheck(item: any): boolean {
  if (item?.followupQuarantined !== true) return true
  const prior = text(item?.followupQuarantineFingerprint)
  return Boolean(prior) && prior !== followupInputFingerprint(item)
}

/** 客户已回复（replied_queue 状态 / emailLogs 有 reply_observed / recovery 标记回复 / zoho 回复证据）。 */
function hasReplied(item: any): boolean {
  if (hasFormalOutreachReply(item)) return true
  if (String(item?.primaryStage || item?.normalizedStage || '') === 'replied_queue') return true
  if (String(item?.replyQueue || '') === 'replied_queue') return true
  if (String(item?.formalDeliveryStatus || '') === 'replied') return true
  if (String(item?.developmentStatus || '') === 'replied') return true
  if (item?.replyObservedAt) return true
  const logs = Array.isArray(item?.emailLogs) ? item.emailLogs : []
  if (logs.some((l: any) =>
    ['received', 'replied', 'reply_observed'].includes(text(l?.status).toLowerCase())
    && /formal.*reply|reply.*formal/.test(text(l?.type).toLowerCase()),
  )) return true
  const evidence = Array.isArray(item?.emailVerificationEvidence) ? item.emailVerificationEvidence : []
  if (evidence.some((e: any) =>
    text(e?.recoveryStatus).toLowerCase() === 'replied'
    && text(e?.method).toLowerCase() !== 'isolated_test_mail',
  )) return true
  return false
}

/** 当前应跟进的轮次：尚未生成草稿且到期（dueAt <= now）的轮次；全部跟完或无轮次到期返回 undefined。 */
function queueBlocksFollowupRecovery(item: any, draft: any, queuePath: string): boolean {
  const customerId = text(item?.id)
  const draftId = text(draft?.id)
  const recipient = text(draft?.to).toLowerCase()
  const round = Number(draft?.round) || 1
  const records = readFormalSendQueue(queuePath).records.filter(record =>
    text(record?.customerId) === customerId
    && text(record?.campaignId) === FOLLOWUP_CAMPAIGN
    && (text(record?.draftId) === draftId
      || (Number(record?.followupRound) === round && text(record?.recipientEmail).toLowerCase() === recipient)),
  )
  return records.some(record =>
    ACTIVE_FORMAL_QUEUE_STATUSES.has(String(record?.sendQueueStatus))
    || record?.sendQueueStatus === 'sent'
    || Boolean(record?.messageId || record?.actualSentAt || record?.providerAttemptedAt),
  )
}

function nextDueRound(item: any, now: Date, queuePath = FORMAL_SEND_QUEUE_FILE): { round: number; field: string; draft?: any; regenerateDraft?: boolean } | undefined {
  // 跟进去重（排期层）：该收件邮箱 21 天内已正式发送过 → 不再排期新的跟进，减少无效入队。
  if (recentFormalSentToRecipient(item, now)) return undefined
  const drafts = followupDrafts(item)
  for (const plan of FOLLOWUP_PLAN) {
    const configured = Date.parse(String(item?.[plan.field] || ''))
    const priorRound = plan.round === 2 ? drafts.find((value: any) => Number(value?.round) === 1 && value?.sent === true) : undefined
    const priorSentAt = Date.parse(String(priorRound?.sentAt || item?.followupSentAt || ''))
    // round 2 至少在 round 1 成功发送 4 天后执行，避免沿用首封旧 T0+7d 日期而立即连发。
    const sequentialFloor = plan.round === 2 && Number.isFinite(priorSentAt) ? priorSentAt + 4 * 86400_000 : NaN
    const t = Number.isFinite(sequentialFloor) ? Math.max(configured || 0, sequentialFloor) : configured
    if (!Number.isFinite(t) || t > now.getTime()) return undefined
    const draft = drafts.find((value: any) => Number(value?.round) === plan.round)
    if (!draft) return { round: plan.round, field: plan.field }
    if (draft?.sent === true) continue
    const draftStatus = text(draft?.status).toLowerCase()
    if (TERMINAL_FOLLOWUP_DRAFT_STATUSES.has(draftStatus)) continue
    if (draftStatus !== 'approved') return undefined
    const staleInput = Boolean(text(draft?.followupInputFingerprint)
      && text(draft.followupInputFingerprint) !== followupInputFingerprint(item))
    const staleRecipient = text(draft?.to).toLowerCase() !== text(item?.selectedEmail).toLowerCase()
    if (staleInput || staleRecipient) {
      // Only recover a stale approved draft when there is proof no send was attempted.
      // A provider attempt (including an ambiguous result) is never regenerated/retried.
      if (queueBlocksFollowupRecovery(item, draft, queuePath)) return undefined
      if (draft?.followupQueueEnqueuedAt) {
        const enqueuedAt = Date.parse(String(draft.followupQueueEnqueuedAt))
        if (Number.isFinite(enqueuedAt) && enqueuedAt > now.getTime() - QUEUE_RECOVERY_GRACE_MS) return undefined
      }
      return { round: plan.round, field: plan.field, draft, regenerateDraft: true }
    }
    if (draft?.followupQueueEnqueuedAt) {
      const enqueuedAt = Date.parse(String(draft.followupQueueEnqueuedAt))
      if ((Number.isFinite(enqueuedAt) && enqueuedAt > now.getTime() - QUEUE_RECOVERY_GRACE_MS)
        || queueBlocksFollowupRecovery(item, draft, queuePath)) return undefined
    }
    return { round: plan.round, field: plan.field, draft }
  }
  return undefined
}

/** 最近一次正式发送的 emailLogs（作为跟进邮件 "Re:" 引用来源）。 */
function lastFormalLog(item: any): any | undefined {
  const logs = Array.isArray(item?.emailLogs) ? item.emailLogs : []
  const formal = logs.filter((l: any) => l?.status === 'sent' && /formal(?:_outreach)?/.test(text(l?.type).toLowerCase()))
  return formal[formal.length - 1]
}

/**
 * 跟进去重（排期层）：该收件邮箱 21 天内是否已正式发送过。
 * 命中 → 排期器跳过，不重复生成/入队跟进（门禁层 formalSendGate 发送时仍会拦 too_frequent_followup）。
 */
function recentFormalSentToRecipient(item: any, now: Date, windowMs = FOLLOWUP_DEDUP_WINDOW_MS): boolean {
  const recipient = text(item?.selectedEmail || item?.preferredEmail || item?.email).toLowerCase()
  if (!recipient) return false
  const logs = Array.isArray(item?.emailLogs) ? item.emailLogs : []
  return logs.some((l: any) =>
    text(l?.status).toLowerCase() === 'sent'
    && /formal(?:_outreach)?/.test(text(l?.type).toLowerCase())
    && text(l?.to).toLowerCase() === recipient
    && Number.isFinite(Date.parse(String(l?.sentAt || '')))
    && now.getTime() - Date.parse(String(l.sentAt)) <= windowMs,
  )
}

function stamp(item: any, version: string, now: Date, extra: Record<string, unknown> = {}): any {
  return { ...item, stepperVersion: version, autoFollowupAt: now.toISOString(), updatedAt: now.toISOString(), ...extra }
}

/** 生成一条跟进 manualEmailDrafts 草稿（status='approved'，round 标注，主公标准：前期流程走完即合格，不再人工审）。 */
function buildFollowupDraftEntry(
  item: any,
  gen: { to: string; subject: string; body: string },
  version: string,
  now: Date,
  round: number,
  id = `auto-followup-${String(item.id || '')}-round-${round}`,
): any {
  const at = now.toISOString()
  const to = text(gen.to)
  return {
    id,
    campaignKey: FOLLOWUP_CAMPAIGN,
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
    followup: true,
    type: 'followup',
    round,
    riskTier: 'A',
    riskReason: `自动跟进 round ${round}：已正式发送未回复，到期自动跟进（${FOLLOWUP_CAMPAIGN}）`,
    rationale: '自动生成并批准（主公标准 2026-08-07：前期流程走完即合格，不再人工审草稿）。',
    manualChecks: [`Auto followup round ${round} generated and approved by ${FOLLOWUP_CAMPAIGN}`],
    version: 1,
    createdAt: at,
    updatedAt: at,
    manualRiskConfirmed: true,
    manualRiskConfirmedAt: at,
    manualRiskConfirmedBy: FOLLOWUP_CAMPAIGN,
    autoFollowupAt: at,
    stepperVersion: version,
    followupInputFingerprint: followupInputFingerprint(item),
  }
}

/** 生成一条跟进 formal_send_queue 记录（status='approved_for_sending'，收件人与草稿一致，发件人为正式邮箱）。 */
function buildQueueRecord(item: any, draft: any, now: Date): FormalSendQueueRecord {
  const at = now.toISOString()
  return {
    id: `queue-followup-${String(item.id || '')}-${String(draft.id || '')}`,
    campaignId: FOLLOWUP_CAMPAIGN,
    campaignName: `自动跟进草稿 round ${Number(draft?.round) || 1}（${FOLLOWUP_CAMPAIGN}）`,
    channel: 'formal_outreach',
    draftId: text(draft.id),
    customerId: String(item.id || ''),
    recipientEmail: text(draft.to),
    senderEmail: OFFICIAL_OUTREACH_EMAIL,
    replyToEmail: OFFICIAL_OUTREACH_EMAIL,
    approvedAt: at,
    approvedBy: FOLLOWUP_CAMPAIGN,
    draftVersion: Number(draft.version) || 1,
    draftRevision: text(draft.updatedAt),
    followupRound: Number(draft?.round) === 2 ? 2 : 1,
    isOneTimeSchedule: true,
    sendWindowLocal: 'auto 60-240s interval (followup-auto-consumer)',
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
 * 单条处理。
 * processed 时分别返回本轮是否新建草稿、是否完成入队；已有未入队草稿会直接补队列。
 * 抛错由外层记 lastError（不盖戳，下 tick 重试）。
 */
async function processOne(
  raw: any,
  now: Date,
  ctx: {
    version: string
    itemsStorePath: string
    queuePath: string
    generateFollowUpFn: (item: any, lastLog?: any) => { to: string; subject: string; body: string } | Promise<{ to: string; subject: string; body: string }>
    enqueueFormalFn: (record: FormalSendQueueRecord, opts: { queuePath: string; itemsPath: string }) => Promise<any>
  },
): Promise<{ handled: 'processed' | 'skipped' | 'not_due'; drafted?: boolean; enqueued?: boolean }> {
  const at = now.toISOString()

  // 客户已回复 → 跳过（不跟进，避免打扰已回复客户）；顺手重算阶段回收进 replied_queue
  if (hasReplied(raw)) {
    updateOneItemAtomic(raw.id, cur => {
      if (!hasReplied(cur)) return cur
      return applyEligibilityStage(stamp(cur, ctx.version, now, { lastFollowupSkip: 'replied' }), now, {
        formalSentEmails: getFormalSentEmailsCached(),
        testMailVerdicts: getTestMailVerdictsCached(),
      }).item
    }, ctx.itemsStorePath)
    return { handled: 'skipped' }
  }

  // 未到期（该轮 followupDueAt 在未来或缺失）→ 跳过，不写库（下 tick 到期后仍可被消费）
  const due = nextDueRound(raw, now, ctx.queuePath)
  if (!due) {
    // 跟进去重（排期层）：收件邮箱 21 天内已正式发送 → 标跳过原因，不重复入队。
    if (recentFormalSentToRecipient(raw, now)) {
      updateOneItemAtomic(raw.id, cur => recentFormalSentToRecipient(cur, now)
        ? { ...cur, lastFollowupSkip: 'recent_formal_sent', followupDedupSkippedAt: at, updatedAt: at }
        : cur, ctx.itemsStorePath)
    }
    return { handled: 'not_due' }
  }

  const regenerateDraft = due.regenerateDraft === true
  const generatedDraft = due.draft && !regenerateDraft
    ? undefined
    : buildFollowupDraftEntry(
      raw,
      await ctx.generateFollowUpFn(raw, lastFormalLog(raw)),
      ctx.version,
      now,
      due.round,
      regenerateDraft ? `auto-followup-${String(raw.id || '')}-round-${due.round}-${randomUUID()}` : undefined,
    )
  const generatedFromFingerprint = followupInputFingerprint(raw)
  const claimToken = randomUUID()
  let claimedDraft: any
  let drafted = false

  // 原子复查同客户同轮，只允许一个 tick 领取稳定 draftId；过期领取可自动恢复。
  const claimed = updateOneItemAtomic(raw.id, (cur) => {
    if (String(cur?.primaryStage || cur?.normalizedStage || '') !== 'followup_queue') return cur
    if (hasReplied(cur)) return cur
    const currentFingerprint = followupInputFingerprint(cur)
    if (generatedDraft && currentFingerprint !== generatedFromFingerprint) return cur
    const currentDue = nextDueRound(cur, now, ctx.queuePath)
    if (!currentDue || currentDue.round !== due.round) return cur
    const drafts = Array.isArray(cur.manualEmailDrafts) ? cur.manualEmailDrafts : []
    const existing = currentDue.draft
    const replacingStale = currentDue.regenerateDraft === true
    if (existing && !replacingStale) {
      if (text(existing.followupInputFingerprint) && text(existing.followupInputFingerprint) !== currentFingerprint) return cur
      const claimedAt = Date.parse(String(existing.followupQueueClaimedAt || ''))
      if (existing.followupQueueClaimToken && Number.isFinite(claimedAt) && claimedAt > now.getTime() - QUEUE_CLAIM_TTL_MS) return cur
      claimedDraft = { ...existing, followupQueueClaimToken: claimToken, followupQueueClaimedAt: at }
    } else {
      if (!generatedDraft) return cur
      drafted = true
      claimedDraft = { ...generatedDraft, followupQueueClaimToken: claimToken, followupQueueClaimedAt: at }
    }
    const selected = text(cur.selectedEmail).toLowerCase() === text(claimedDraft.to).toLowerCase()
      ? cur.selectedEmail
      : claimedDraft.to
    const withDraft = {
      ...cur,
      manualEmailDrafts: existing && !replacingStale
        ? drafts.map((draft: any) => draft?.id === existing.id ? claimedDraft : draft)
        : [
          ...drafts.map((draft: any) => draft?.id === existing?.id
            ? { ...draft, followupSupersededAt: at, followupSupersededReason: 'input_fingerprint_changed', followupSupersededBy: claimedDraft.id }
            : draft),
          claimedDraft,
        ],
      selectedEmail: selected,
      preferredEmail: text(cur.preferredEmail) && text(cur.preferredEmail).toLowerCase() === text(cur.selectedEmail).toLowerCase()
        ? cur.preferredEmail
        : selected,
      stepperVersion: ctx.version,
      autoFollowupAt: at,
      followupDraftedAt: drafted ? at : cur.followupDraftedAt,
      updatedAt: at,
    }
    return applyEligibilityStage(withDraft, now, {
      formalSentEmails: getFormalSentEmailsCached(),
      testMailVerdicts: getTestMailVerdictsCached(),
    }).item
  }, ctx.itemsStorePath)

  if (!claimedDraft) return { handled: 'skipped' }

  const record = buildQueueRecord(claimed.item, claimedDraft, now)
  try {
    await ctx.enqueueFormalFn(record, { queuePath: ctx.queuePath, itemsPath: ctx.itemsStorePath })
  } catch (error) {
    // 入队失败立即释放领取；外层写 followupRetryAt，退避到期后复用同一 draftId 补队列。
    updateOneItemAtomic(raw.id, (cur) => ({
      ...cur,
      manualEmailDrafts: (Array.isArray(cur.manualEmailDrafts) ? cur.manualEmailDrafts : []).map((draft: any) => {
        if (draft?.id !== claimedDraft.id || draft?.followupQueueClaimToken !== claimToken) return draft
        const { followupQueueClaimToken: _token, followupQueueClaimedAt: _claimedAt, ...released } = draft
        return released
      }),
      updatedAt: at,
    }), ctx.itemsStorePath)
    throw error
  }

  // 只有入队完成才清失败/隔离状态，并给该轮草稿盖入队完成标记。
  updateOneItemAtomic(raw.id, (cur) => {
    const {
      followupFailureCount: _failureCount,
      followupRetryAt: _retryAt,
      followupQuarantined: _quarantined,
      followupQuarantineFingerprint: _quarantineFingerprint,
      followupQuarantinedAt: _quarantinedAt,
      lastError,
      ...clean
    } = cur
    const completed = {
      ...clean,
      ...(text(lastError).startsWith('followup_auto:') ? {} : { lastError }),
      manualEmailDrafts: (Array.isArray(clean.manualEmailDrafts) ? clean.manualEmailDrafts : []).map((draft: any) => {
        if (draft?.id !== claimedDraft.id) return draft
        const { followupQueueClaimToken: _token, followupQueueClaimedAt: _claimedAt, ...released } = draft
        return { ...released, followupQueueEnqueuedAt: at }
      }),
      updatedAt: at,
    }
    return applyEligibilityStage(completed, now, {
      formalSentEmails: getFormalSentEmailsCached(),
      testMailVerdicts: getTestMailVerdictsCached(),
    }).item
  }, ctx.itemsStorePath)

  return { handled: 'processed', drafted, enqueued: true }
}

/**
 * 后台自动消费跟进队列（每 tick 默认 ≤ 10 条）。
 * 到期未回复 → 生成跟进草稿（approved）+ 入队 formal_send_queue；发送由批次3 runFormalAutoStep 统一执行。
 * 单条失败只记 lastError，不中断整批；未到期轮次不写库，到期后仍可被消费。
 */
export async function runFollowupAutoStep(
  now: Date,
  deps: FollowupAutoDeps = {},
): Promise<FollowupAutoStats> {
  const stats: FollowupAutoStats = { due: 0, drafted: 0, enqueued: 0, skipped: 0, failed: 0, quarantined: 0 }
  if (deps.lastError && typeof deps.lastError === 'object') delete deps.lastError.followupAuto
  const itemsStorePath = deps.itemsStorePath || ITEMS_STORE_FILE
  const queuePath = deps.queuePath || FORMAL_SEND_QUEUE_FILE
  const version = deps.version || DEFAULT_VERSION
  const maxPerTick = deps.maxPerTick ?? DEFAULT_MAX_PER_TICK
  const effectiveNow = deps.now || now
  const generateFollowUpFn = deps.generateFollowUpFn || generateFollowUpDraft
  const enqueueFormalFn = deps.enqueueFormalFn || defaultEnqueueFormal

  try {
    const items = readItemsAtomic(itemsStorePath)
    const candidates = items.filter((it: any) =>
      String(it?.primaryStage || it?.normalizedStage || '') === 'followup_queue'
      && quarantineNeedsRecheck(it)
      && !(Number.isFinite(Date.parse(String(it?.followupRetryAt || '')))
        && Date.parse(String(it.followupRetryAt)) > effectiveNow.getTime()),
    )
      // 已到期且未回复客户优先；历史已回复记录最后处理，避免占满批次使真实跟进长期饥饿。
      .sort((a: any, b: any) => {
        const rank = (item: any) => hasReplied(item) ? 2 : nextDueRound(item, effectiveNow, queuePath) ? 0 : 1
        const da = rank(a)
        const db = rank(b)
        if (da !== db) return da - db
        const ta = earliestDueAt(a) ?? Infinity
        const tb = earliestDueAt(b) ?? Infinity
        return ta - tb
      })
      .slice(0, maxPerTick)
    if (candidates.length === 0) return stats

    for (const item of candidates) {
      const hasDue = Boolean(nextDueRound(item, effectiveNow, queuePath))
      try {
        const res = await processOne(item, effectiveNow, { version, itemsStorePath, queuePath, generateFollowUpFn, enqueueFormalFn })
        if (res.handled === 'processed') {
          if (hasDue) stats.due++
          if (res.drafted) stats.drafted++
          if (res.enqueued) stats.enqueued++
        } else {
          // skipped（已回复 / 已跟进过）与 not_due（未到期，不写库）都计入 skipped
          if (hasDue) stats.due++
          stats.skipped++
        }
      } catch (err) {
        if (hasDue) stats.due++
        stats.failed++
        try {
          let quarantined = false
          updateOneItemAtomic(item.id, (cur) => {
            const failureCount = Math.max(0, Number(cur?.followupFailureCount) || 0) + 1
            quarantined = failureCount >= MAX_FAILURES
            return {
              ...cur,
              followupFailureCount: failureCount,
              followupRetryAt: quarantined
                ? undefined
                : new Date(effectiveNow.getTime() + FAILURE_BACKOFF_MS[Math.min(failureCount - 1, FAILURE_BACKOFF_MS.length - 1)]).toISOString(),
              followupQuarantined: quarantined || undefined,
              followupQuarantineFingerprint: quarantined ? followupInputFingerprint(cur) : undefined,
              followupQuarantinedAt: quarantined ? effectiveNow.toISOString() : undefined,
              lastError: `followup_auto:${err instanceof Error ? err.message : String(err)}`,
              updatedAt: effectiveNow.toISOString(),
            }
          }, itemsStorePath)
          if (quarantined) stats.quarantined++
        } catch { /* swallow */ }
      }
    }
  } catch (err) {
    if (deps.lastError && typeof deps.lastError === 'object') {
      deps.lastError.followupAuto = err instanceof Error ? err.message : String(err)
    }
  }
  return stats
}

/** 该轮最早的到期时间（仅统计已到期的轮次字段中最早者），供排序使用。 */
function earliestDueAt(item: any): number | undefined {
  let best: number | undefined
  for (const plan of FOLLOWUP_PLAN) {
    const t = Date.parse(String(item?.[plan.field] || ''))
    if (Number.isFinite(t) && (best === undefined || t < best)) best = t
  }
  return best
}
