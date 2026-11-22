import { normalizeEmailSignature } from '../src/services/emailSignature'
/**
 * formal 自动发送执行器（批次3 / 全自动 + 内容监督门禁）。
 *
 * 主公指令（2026-08-19）：开发信"有一条发一条，不需要开关"，但每封必须"针对性一对一"——
 * 不能是模板替换乱写。本执行器不受全局自动发送开关控制，
 * 并在发送前逐封过"内容监督门禁"（draftQualityGate）：不达标的草稿自动重写并重新审核，
 * 模型暂不可用时延时重试，绝不把可修复内容留给人工，也绝不放行泛稿。
 *
 * 职责：
 *   1. 读 formal_send_queue 中 status='approved_for_sending'（或已到期 scheduled / 可重试 send_failed）记录。
 *   2. 先走 claim：acquireFormalQueueLock 拿到 runner 锁 + mutateFormalSendQueue 原子把
 *      approved/scheduled/send_failed → sending（盖 outboundKey + sendClaimId + sendClaimedAt，
 *      sendAttemptCount+1），与 claimFormalSendGrantTargets 同款 lock+claim 语义，防止多实例重复发送。
 *   3. 发送前 preflight 用 canSendFormalOutreach（formalSendGate，唯一机械门禁）——机械 blocker 命中则跳过该条
 *      （skipped++，sendQueueStatus='blocked' 记原因），不发送。
 *   4. 内容监督门禁（draftQualityGate，主公 2026-08-19）：LLM 主通道 + 启发式兜底，审查草稿是否
 *      "针对性一对一"。FAIL → 不再直接 blocked，而是自动用 LLM 定向重写草稿（rewriteDraft，
 *      带失败原因）→ 更新草稿（subject/body/rewriteCount）+ 队列（回 approved_for_sending，
 *      contentRetryCount+1）→ 下 tick 重试发送。LLM 暂不可用时保留原任务并冷却 30 分钟后重试。
 *      机械门禁（canSendFormalOutreach）
 *      blocker 仍直接 blocked（那是数据问题不是草稿问题，不重写）。
 *   5. 调发送函数（sendFormalEmail，Zoho SMTP，昨天 30 封用的通道），maxSendCount:1 +
 *      3-5 分钟（180-300s）随机节流（reputation 保护；节流状态持久化 data/formal_auto_state.json）。
 *   6. 发送成功 → sendQueueStatus='sent'，写 emailLogs 回 items_store，重算阶段自然流入
 *      followup_queue（下批次接）；失败 → send_failed，重试 ≤3 次后暂停
 *      （needs_manual_reconciliation + sendFailures++）。
 *
 * 整个自动发送与手动发送（runDueFormalOnce）走同一出口：canSendFormalOutreach 门禁 + sendFormalEmail 发送函数。
 *
 * 不挂载到 backgroundTick / pipeline-stepper；仅提供可调用导出函数（挂载留批次末统一接入）。
 */

import { randomInt, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readFormalSendQueue, mutateFormalSendQueue, FORMAL_SEND_QUEUE_FILE, partitionFormalQueueRecords } from './formal-send-queue-store'
import { acquireFormalQueueLock, releaseFormalQueueLock } from './formal-queue-lock'
import { readItemsAtomic, updateItemsAtomic, updateOneItemAtomic, ITEMS_STORE_FILE } from './items-store-atomic'
import { findPersistedDraft, updatePersistedDraft } from '../src/services/draftLookup'
import { canSendFormalOutreach } from '../src/services/formalSendGate'
import { applyEligibilityStage } from '../src/services/leadStageEligibility'
import { formalOutboundKey } from './formal-runner-safety'
import { sendFormalEmail } from './formal-smtp-transport'
import { getFormalSentEmailsCached } from './formal-sent-email-set'
import { getTestMailVerdictsCached } from './test-mail-verdicts'
import { assessDraftQuality, type QualityGateDeps } from '../src/services/draftQualityGate'
import { rewriteDraft } from './llm-draft-generator'
import { hasFormalOutreachReply } from '../src/services/formalOutreachLifecycle'
import { clearFormalSendClaim, countFormalFollowupSlotsToday, DAILY_FOLLOWUP_SEND_LIMIT, type FormalSendQueueRecord } from '../src/services/formalSendQueue'
import { ISOLATION_STORE_FILE, readIsolationStore } from './isolation-store'
import {
  executeAuthorizedFormalProviderSend,
  pauseFormalSendQueue,
  recoverExpiredFormalProviderAuthorizations,
} from './formal-send-linearizer'
import { buildFormalSentContentSnapshot } from './formal-sent-content'

const CONFIG_FILE = join(__dirname, '..', 'user_config.json')
const DEFAULT_STATE_FILE = join(__dirname, '..', 'data', 'formal_auto_state.json')
// 发送节流：主公 2026-08-07 授权的一对一时间间隔标准（与正式发送脚本 formal-dispatch-0807.mts 的 randomInt(180, 301) 一致）
// 当前标准：3-5 分钟随机间隔。
export const DEFAULT_MIN_INTERVAL_MS = 180_000 // 3-5 分钟随机节流下界
export const DEFAULT_MAX_INTERVAL_MS = 300_000 // 3-5 分钟随机节流上界
const DEFAULT_MAX_SEND_COUNT = 1
const DEFAULT_MAX_DAILY_SEND = 100
const MAX_AUTO_RETRY = 3
// 内容模型暂不可用时的自动重试冷却。
const CONTENT_REWRITE_RETRY_MS = 30 * 60_000
const STALE_SEND_CLAIM_MS = 15 * 60_000
const STATE_PERSISTENCE_FAILURE = 'FORMAL_AUTO_STATE_PERSIST_FAILED'
const statePersistenceBlocks = new Set<string>()

type FormalAutoProviderInput = { to: string; subject: string; body: string; customerId: string; outboundKey?: string }

export function mapFormalAutoProviderInput(input: FormalAutoProviderInput) {
  if (!String(input.body || '').trim()) throw new Error('FORMAL_AUTO_BODY_REQUIRED')
  return {
    to: input.to,
    subject: input.subject,
    content: input.body,
    customerId: input.customerId,
    outboundKey: input.outboundKey,
  }
}

/** Both persisted Codex review formats must remain eligible in the auto-send queue. */
function isCodexReviewedDraft(draft: any): boolean {
  return Boolean(
    (draft?.supervisedBy === 'Codex' && Date.parse(String(draft?.supervisedAt || ''))) ||
    (draft?.manualRiskConfirmed === true
      && /^codex:/i.test(String(draft?.manualRiskConfirmedBy || draft?.approvedBy || ''))
      && Date.parse(String(draft?.manualRiskConfirmedAt || draft?.approvedAt || ''))
      && Array.isArray(draft?.manualChecks)
      && draft.manualChecks.some((check: unknown) => /targeted|company_identity_confirmed|recipient_company_domain_matched/i.test(String(check))))
  )
}

/**
 * followup-auto-consumer 草稿由已正式发送记录自动派生，并带完整审批标记；
 * 它不属于 Codex 审核来源，因此仍需走内容质量门禁，但可作为受监督来源进入候选。
 */
function isFollowupAutoConsumerDraft(draft: any): boolean {
  const source = String(draft?.manualRiskConfirmedBy || draft?.approvedBy || '').trim().toLowerCase()
  const followupIdentity = draft?.followup === true
    || String(draft?.type || '').toLowerCase() === 'followup'
    || String(draft?.campaignKey || '').trim().toLowerCase() === 'followup-auto-consumer'
  return draft?.manualRiskConfirmed === true
    && source === 'followup-auto-consumer'
    && String(draft?.status || '').toLowerCase() === 'approved'
    && Boolean(Date.parse(String(draft?.manualRiskConfirmedAt || draft?.approvedAt || '')))
    && Array.isArray(draft?.manualChecks)
    && draft.manualChecks.length > 0
    && followupIdentity
}

/** 监督模式只放行明确审核来源（Codex）或带审批标记的 followup 自动草稿，未标记草稿继续拦截。 */
function isSupervisedDraftSource(draft: any): boolean {
  return isCodexReviewedDraft(draft) || isFollowupAutoConsumerDraft(draft)
}

class FormalAutoStatePersistenceError extends Error {
  constructor(cause: unknown) {
    super(`${STATE_PERSISTENCE_FAILURE}:${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'FormalAutoStatePersistenceError'
  }
}

export interface FormalAutoStats {
  sent: number
  skipped: number
  failed: number
  /** 内容门禁 FAIL 后成功用 LLM 定向重写的草稿数（下 tick 会重试发送） */
  rewritten: number
}

export interface FormalAutoState {
  lastSentAt: string
  nextAllowedAt: string
}

export interface FormalAutoStateIO {
  read(): Partial<FormalAutoState>
  write(state: FormalAutoState): void
}

export interface FormalAutoDeps {
  /** 覆盖 formal_send_queue.json 路径（测试/独立库用） */
  queuePath?: string
  /** 覆盖 items_store.json 路径（测试/独立库用） */
  itemsStorePath?: string
  /** 覆盖全局隔离表路径（测试/独立库用）；永久隔离邮箱在 provider 调用前硬拦截。 */
  isolationStorePath?: string
  /** 覆盖当前时间 */
  now?: Date
  /** 内容监督门禁开关（默认 true；测试/回放可关。主公 2026-08-19：逐封审查"针对性一对一"） */
  qualityGateEnabled?: boolean
  /** 只处理已由 Codex 逐封审核并写入 supervisedBy/supervisedAt 的草稿。 */
  requireSupervisedDraft?: boolean
  /** 可选 campaign allowlist，供用户授权的单批次任务隔离，禁止顺带执行其他队列。 */
  allowedCampaignIds?: readonly string[]
  /** 全局暂停时可继续运行的 campaign；必须同时命中 allowedCampaignIds 才生效。 */
  runWhilePausedCampaignIds?: readonly string[]
  /** 若开启，实际发送瞬间必须处于收件人本地工作日 08:30-11:30 或 14:00-16:30。 */
  respectCustomerLocalWindow?: boolean
  /** 内容监督门禁注入（默认走真实 LLM 双通道；测试用 llmFn mock 控制 PASS/FAIL） */
  qualityGateDeps?: QualityGateDeps
  /** 为 true 时，本地 LLM 必须明确通过；超时、空响应或启发式降级都不得发送。 */
  requireLlmQualityReview?: boolean
  /** 门禁 FAIL 后的定向重写函数注入。返回 null = LLM 暂不可用，任务保留并延时自动重试。 */
  rewriteDraftFn?: (item: any, draft: any, failReasons: string[]) => Promise<{ subject: string; body: string } | null>
  /** 兼容旧调用参数；可修复的内容质量问题不再转人工。 */
  maxDraftRewrite?: number
  /** 兼容旧调用参数；可修复的内容质量问题不再转人工。 */
  maxContentRetryQueue?: number
  /** user_config.json 路径（默认项目根 user_config.json） */
  userConfigPath?: string
  /** 每 tick 最多发送条数（默认 1，reputation 保护） */
  maxSendCount?: number
  /** 每日最多发送条数（默认 100，Asia/Shanghai 当天计数，达到后当天停止，次日重置） */
  maxDailySend?: number
  /** 随机节流区间（毫秒，默认 180_000–300_000，即 3-5 分钟） */
  minIntervalMs?: number
  maxIntervalMs?: number
  /** 节流状态文件路径（默认 data/formal_auto_state.json） */
  statePath?: string
  /** 节流状态读写注入（测试用内存 mock，避免写文件） */
  stateIO?: FormalAutoStateIO
  /** 发送函数注入（默认 sendFormalEmail；测试必须传 mock，不真发信） */
  sendFn?: (input: { to: string; subject: string; body: string; customerId: string; outboundKey?: string }) => Promise<{ messageId?: string }>
  /** Provider 调用硬超时；超时结果一律转人工核对，不自动重试。 */
  providerTimeoutMs?: number
  /** 持久化发送授权有效期；主要供崩溃恢复测试覆盖。 */
  authorizationTtlMs?: number
  /** 发送前钩子（测试断言 claim 已生效：记录 sendQueueStatus==='sending'） */
  beforeSend?: (record: any) => Promise<void> | void
  /** 读取候选后、原子 claim 前钩子（竞态测试注入） */
  beforeClaim?: () => Promise<void> | void
  /** 上层巡检可读的错误槽（本函数只写，不抛） */
  lastError?: Record<string, unknown>
}

export function isPausedCampaignOverrideAllowed(
  queuePaused: boolean,
  campaignId: string,
  allowedCampaignIds?: readonly string[],
  runWhilePausedCampaignIds?: readonly string[],
): boolean {
  if (!queuePaused) return true
  return Boolean(
    allowedCampaignIds?.includes(campaignId)
    && runWhilePausedCampaignIds?.includes(campaignId),
  )
}

/** Lets a dedicated worker remain alive during a global pause only for its dual-allowlisted campaign. */
export function canWorkerContinueCampaign(
  queuePaused: boolean,
  campaignId: string,
  allowedCampaignIds?: readonly string[],
  runWhilePausedCampaignIds?: readonly string[],
): boolean {
  return isPausedCampaignOverrideAllowed(queuePaused, campaignId, allowedCampaignIds, runWhilePausedCampaignIds)
}

/** 是否可被自动 runner 处理：approved_for_sending / 已到期 scheduled / 可重试 send_failed，且不在节流冷却中。 */
function isAutoCandidate(record: any, now: Date): boolean {
  if (!record?.sendQueueStatus) return false
  if (record.autoThrottleUntilAt && Date.parse(record.autoThrottleUntilAt) > now.getTime()) return false
  if (record.sendQueueStatus === 'approved_for_sending') return true
  if (record.sendQueueStatus === 'scheduled') {
    return Boolean(record.scheduledSendAt && Date.parse(record.scheduledSendAt) <= now.getTime())
  }
  if (record.sendQueueStatus === 'send_failed') {
    return Number(record.sendAttemptCount || 0) < MAX_AUTO_RETRY
  }
  return false
}

function readState(deps: FormalAutoDeps): FormalAutoState {
  const base: FormalAutoState = { lastSentAt: '', nextAllowedAt: '' }
  try {
    if (deps?.stateIO) return { ...base, ...deps.stateIO.read() }
    const raw = readFileSync(deps.statePath || DEFAULT_STATE_FILE, 'utf8')
    return { ...base, ...(JSON.parse(raw) as Partial<FormalAutoState>) }
  } catch (error: any) {
    if (!deps?.stateIO && error?.code === 'ENOENT') return base
    throw new FormalAutoStatePersistenceError(error)
  }
}

function writeState(deps: FormalAutoDeps, state: FormalAutoState): void {
  let temp = ''
  try {
    if (deps?.stateIO) { deps.stateIO.write(state); return }
    const path = deps.statePath || DEFAULT_STATE_FILE
    mkdirSync(dirname(path), { recursive: true })
    temp = `${path}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(temp, JSON.stringify(state, null, 2), 'utf8')
    renameSync(temp, path)
  } catch (error) {
    if (temp) try { unlinkSync(temp) } catch {}
    throw new FormalAutoStatePersistenceError(error)
  }
}

function reportFormalAutoError(deps: FormalAutoDeps, error: unknown) {
  if (deps.lastError && typeof deps.lastError === 'object') {
    deps.lastError.formalAuto = String(error instanceof Error ? error.message : error).slice(0, 500)
  }
}

async function failClosedOnStatePersistence(deps: FormalAutoDeps, queuePath: string): Promise<void> {
  statePersistenceBlocks.add(queuePath)
  reportFormalAutoError(deps, STATE_PERSISTENCE_FAILURE)
  try {
    await pauseFormalSendQueue(STATE_PERSISTENCE_FAILURE, { queuePath })
  } catch (error) {
    reportFormalAutoError(deps, `${STATE_PERSISTENCE_FAILURE}:QUEUE_PAUSE_FAILED:${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 从门禁结果提取可读失败原因文本（供定向重写作为 GATE FAILURE REASONS 喂给 LLM）。 */
function extractContentFailReasons(qualityReason: string, quality: any): string[] {
  const reasons: string[] = []
  if (quality && Array.isArray(quality.checks)) {
    for (const c of quality.checks) {
      if (c && c.pass === false) {
        const label = String(c.label || c.detail || c.id || '').trim()
        if (label) reasons.push(label)
      }
    }
  }
  // 去掉门禁前缀（content_not_targeted:/hard_block:/gate_error:/heuristic:/llm: 等），保留可读原因文本
  const clean = String(qualityReason || '')
    .replace(/^(content_not_targeted|hard_block|gate_error|heuristic|llm)[:：]?\s*/i, '')
    .trim()
  if (clean && !reasons.includes(clean)) reasons.push(clean)
  return reasons
}

export function isFollowupSend(record: any, draft: any): boolean {
  return record?.campaignId === 'followup-auto-consumer'
    || draft?.followup === true
    || String(draft?.type || '').toLowerCase() === 'followup'
}

function customerHasReplied(item: any): boolean {
  return hasFormalOutreachReply(item)
    || String(item?.primaryStage || item?.normalizedStage || '') === 'replied_queue'
    || String(item?.replyQueue || '') === 'replied_queue'
    || String(item?.formalDeliveryStatus || '') === 'replied'
    || String(item?.developmentStatus || '') === 'replied'
    || Boolean(item?.replyObservedAt)
}

async function skipRepliedRecord(queuePath: string, recordId: string, now: Date): Promise<void> {
  await mutateFormalSendQueue(latest => ({
    ...latest,
    records: latest.records.map(record => record.id === recordId ? {
      ...clearFormalSendClaim(record),
      sendQueueStatus: 'skipped' as const,
      sendError: 'auto_preflight:customer_replied',
      updatedAt: now.toISOString(),
    } : record),
  }), { path: queuePath })
}

export function recoverSentQueueItems(items:any[],records:FormalSendQueueRecord[],now:Date){
  const byCustomer=new Map<string,FormalSendQueueRecord[]>()
  for(const record of records){
    if(record.sendQueueStatus!=='sent'||record.itemStateRecoveryRequired!==true||(!record.messageId&&!record.actualSentAt&&!record.outboundKey))continue
    const key=String(record.customerId||'')
    byCustomer.set(key,[...(byCustomer.get(key)||[]),record])
  }
  if(!byCustomer.size)return items
  const nowIso=now.toISOString()
  return items.map(item=>{
    const sent=byCustomer.get(String(item?.id||''))
    if(!sent?.length)return item
    let current=item
    let changed=false
    for(const record of sent){
      const sentAt=record.actualSentAt||record.updatedAt||nowIso
      const recipient=String(record.recipientEmail||'').trim().toLowerCase()
      const logs=Array.isArray(current?.emailLogs)?current.emailLogs:[]
      const logged=logs.some((log:any)=>
        (record.messageId&&String(log?.messageId||'')===String(record.messageId))
        ||(record.outboundKey&&String(log?.outboundMessageKey||'')===String(record.outboundKey)),
      )
      if(!logged){
        current={...current,emailLogs:[...logs,{
          status:'sent',type:'formal_outreach',sentAt,messageId:record.messageId,to:record.recipientEmail,
          outboundMessageKey:record.outboundKey,provider:'zoho_smtp',deliveryStatus:'sent_observation',
          formalQueueRecoveredAt:nowIso,
        }]}
        changed=true
      }
      const beforeDraft=findPersistedDraft(current,record.draftId)
      if(beforeDraft&&beforeDraft.sent!==true){
        current=updatePersistedDraft(current,record.draftId,draft=>({...draft,status:'sent',sent:true,sentAt,updatedAt:sentAt,formalQueueRecoveredAt:nowIso}))
        changed=true
      }
      if(recipient&&recipient===String(current?.selectedEmail||'').trim().toLowerCase()){
        const followup=record.campaignId==='followup-auto-consumer'
        const next={
          ...current,
          developmentStatus:'sent',formalDeliveryStatus:'sent_observation',replyCheckMode:'manual_zoho_login',
          followupDueAt3d:record.followupDueAt3d||current.followupDueAt3d,
          followupDueAt7d:record.followupDueAt7d||current.followupDueAt7d,
          followupSentAt:followup?sentAt:current.followupSentAt,
        }
        if(JSON.stringify(next)!==JSON.stringify(current)){current=next;changed=true}
      }
    }
    if(!changed)return item
    return applyEligibilityStage(current,now,{
      formalSentEmails:getFormalSentEmailsCached(),testMailVerdicts:getTestMailVerdictsCached(),
    }).item
  })
}

function sentItemStateCommitted(item:any,record:FormalSendQueueRecord){
  const logs=Array.isArray(item?.emailLogs)?item.emailLogs:[]
  const logged=logs.some((log:any)=>(record.messageId&&String(log?.messageId||'')===String(record.messageId))||(record.outboundKey&&String(log?.outboundMessageKey||'')===String(record.outboundKey)))
  const draft=findPersistedDraft(item,record.draftId)
  return Boolean(logged&&(!draft||draft.sent===true))
}

/**
 * 自动发送（是否发送由逐条资格、排期、抑制名单与额度决定）：
 * claim（→sending）→ preflight（canSendFormalOutreach）→ 发送（sendFormalEmail，maxSendCount:1 + 3-5 分钟随机节流）。
 */
export async function runFormalAutoStep(
  now: Date,
  deps: FormalAutoDeps = {},
): Promise<FormalAutoStats> {
  const stats: FormalAutoStats = { sent: 0, skipped: 0, failed: 0, rewritten: 0 }
  if (deps.lastError && typeof deps.lastError === 'object') delete deps.lastError.formalAuto
  const queuePath = deps.queuePath || FORMAL_SEND_QUEUE_FILE
  const itemsPath = deps.itemsStorePath || ITEMS_STORE_FILE
  const effectiveNow = deps.now || now
  if (statePersistenceBlocks.has(queuePath)) {
    reportFormalAutoError(deps, STATE_PERSISTENCE_FAILURE)
    return stats
  }
  const configuredMaxSendCount = deps.maxSendCount ?? DEFAULT_MAX_SEND_COUNT
  const maxSendCount = Number.isSafeInteger(configuredMaxSendCount) && configuredMaxSendCount > 0 ? 1 : 0
  const maxDailySend = deps.maxDailySend ?? DEFAULT_MAX_DAILY_SEND
  const minIntervalMs = deps.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
  const maxIntervalMs = deps.maxIntervalMs ?? DEFAULT_MAX_INTERVAL_MS
  const sendFn = deps.sendFn || ((input: FormalAutoProviderInput) => sendFormalEmail(mapFormalAutoProviderInput(input)))
  const beforeSend = deps.beforeSend

  // 3-5 分钟随机节流：状态文件存在但不可读时必须在 claim 前停发。
  let throttle: FormalAutoState
  try {
    throttle = readState(deps)
  } catch {
    await failClosedOnStatePersistence(deps, queuePath)
    return stats
  }

  const runnerLock = acquireFormalQueueLock(`${queuePath}.auto-runner.lock`)
  if (!runnerLock) return stats // 另一实例在跑，防多实例重复发送

  try {
    // 每轮先在唯一队列 mutation 锁内回收超时 sending。发送结果未知，必须转人工核对，绝不自动重发。
    await mutateFormalSendQueue(latest => {
      const recovered = recoverExpiredFormalProviderAuthorizations(latest, effectiveNow)
      return {
      ...recovered,
      records: recovered.records.map(record => {
        if (record.sendQueueStatus !== 'sending') return record
        const claimedAt = Date.parse(String(record.sendClaimedAt || ''))
        if (Number.isFinite(claimedAt) && claimedAt > effectiveNow.getTime() - STALE_SEND_CLAIM_MS) return record
        return {
          ...clearFormalSendClaim(record),
          sendQueueStatus: 'needs_manual_reconciliation' as const,
          sendError: 'stale_sending_claim:provider_delivery_unknown',
          staleSendClaimRecoveredAt: effectiveNow.toISOString(),
          updatedAt: effectiveNow.toISOString(),
        }
      }),
    }}, { path: queuePath })
    const recoveryStore=readFormalSendQueue(queuePath)
    if(recoveryStore.records.some(record=>record.itemStateRecoveryRequired===true)){
      updateItemsAtomic(items=>recoverSentQueueItems(items,recoveryStore.records,effectiveNow),itemsPath,effectiveNow,{
        refreshOnlyMutated:true,formalSentEmails:getFormalSentEmailsCached(),testMailVerdicts:getTestMailVerdictsCached(),
      })
      const recoveredById=new Map(readItemsAtomic(itemsPath).map(item=>[String(item?.id||''),item]))
      await mutateFormalSendQueue(latest=>({...latest,records:latest.records.map(record=>
        record.itemStateRecoveryRequired===true&&sentItemStateCommitted(recoveredById.get(String(record.customerId||'')),record)
          ?{...record,itemStateRecoveryRequired:undefined,itemStateCommittedAt:effectiveNow.toISOString(),updatedAt:effectiveNow.toISOString()}
          :record,
      )}),{path:queuePath})
    }
    if (throttle.nextAllowedAt && Date.parse(throttle.nextAllowedAt) > effectiveNow.getTime()) return stats

    const store = readFormalSendQueue(queuePath)
    const pausedCampaignOverride = new Set(deps.runWhilePausedCampaignIds || [])
    const allowedCampaignIds = deps.allowedCampaignIds ? new Set(deps.allowedCampaignIds) : undefined
    if (store.paused && ![...pausedCampaignOverride].some(id => allowedCampaignIds?.has(id))) return stats

    // 每日上限：今天（Asia/Shanghai）已发 sendQueueStatus='sent' 的记录数达到 maxDailySend 则当天停止（次日自动重置）
    const dayOf = (d: string | Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(d))
    const today = dayOf(effectiveNow)
    const sentTodayRecords = store.records.filter(r => {
      if (r.sendQueueStatus === 'sent' && r.actualSentAt) return dayOf(r.actualSentAt) === today
      const providerAttemptedAt = String((r as any).providerAttemptedAt || '')
      return r.sendQueueStatus === 'needs_manual_reconciliation'
        && String(r.sendError || '').startsWith('ambiguous_after_provider:')
        && Boolean(providerAttemptedAt)
        && dayOf(providerAttemptedAt) === today
    })
    if (sentTodayRecords.length >= maxDailySend) return stats
    const currentItems = readItemsAtomic(itemsPath)
    const itemsById = new Map(currentItems.map(item => [String(item?.id || ''), item]))
    const followupSlotsToday = countFormalFollowupSlotsToday(store.records, effectiveNow)
    const activeCandidates = partitionFormalQueueRecords(store.records, currentItems).active
      .filter(r => !allowedCampaignIds || allowedCampaignIds.has(String(r.campaignId || '')))
      .filter(r => isPausedCampaignOverrideAllowed(store.paused, String(r.campaignId || ''), deps.allowedCampaignIds, deps.runWhilePausedCampaignIds))
      .filter(r => isAutoCandidate(r, effectiveNow))
      .filter(r => {
        if (followupSlotsToday >= DAILY_FOLLOWUP_SEND_LIMIT) {
          const item = itemsById.get(String(r.customerId || ''))
          const draft = item ? findPersistedDraft(item, r.draftId)?.draft : undefined
          if (isFollowupSend(r, draft)) return false
        }
        return true
      })
      .filter(r => {
        if (deps.requireSupervisedDraft !== true) return true
        const item = itemsById.get(String(r.customerId || ''))
        const draft = item ? findPersistedDraft(item, r.draftId)?.draft : undefined
        return isSupervisedDraftSource(draft)
      })
      // 重写会刷新 updatedAt：按最久未处理优先可把失败项移到队尾，同时不会被持续新增任务饿死。
      .sort((left, right) => {
        const leftAt = Date.parse(String(left.updatedAt || left.createdAt || '')) || 0
        const rightAt = Date.parse(String(right.updatedAt || right.createdAt || '')) || 0
        return leftAt - rightAt || (Number(left.contentRetryCount) || 0) - (Number(right.contentRetryCount) || 0)
      })
    const candidates = activeCandidates.slice(0, maxSendCount)
    if (candidates.length === 0) return stats
    const candidateSnapshots = new Map(candidates.map(record => [record.id, record]))
    if (deps.beforeClaim) await deps.beforeClaim()

    // claim：approved/scheduled/send_failed → sending（runner 锁 + 队列原子写 + outboundKey/claimId）
    const claimId = randomUUID()
    const claimedAt = effectiveNow.toISOString()
    const targetIds = new Set(candidates.map(r => r.id))
    const pausedClaimOverrideAllowed = candidates.every(record => isPausedCampaignOverrideAllowed(true, String(record.campaignId || ''), deps.allowedCampaignIds, deps.runWhilePausedCampaignIds))
    await mutateFormalSendQueue(latest => {
      if (latest.paused && !pausedClaimOverrideAllowed) return latest
      let followupSlots = countFormalFollowupSlotsToday(latest.records, effectiveNow)
      return {
      ...latest,
      records: latest.records.map(r => {
        if (!targetIds.has(r.id) || !isAutoCandidate(r, effectiveNow)) return r
        const item = itemsById.get(String(r.customerId || ''))
        const draft = item ? findPersistedDraft(item, r.draftId)?.draft : undefined
        if (isFollowupSend(r, draft)) {
          if (followupSlots >= DAILY_FOLLOWUP_SEND_LIMIT) return r
          followupSlots++
        }
        return {
          ...r,
          sendQueueStatus: 'sending' as const,
          sendClaimId: claimId,
          sendClaimedAt: claimedAt,
          outboundKey: formalOutboundKey(r),
          lastSendAttemptAt: claimedAt,
          sendAttemptCount: (r.sendAttemptCount || 0) + 1,
          updatedAt: claimedAt,
        }
      }),
    }}, { path: queuePath })
    // 只有本次 claim 成功（sendClaimedAt === 本次 claimId）的记录才继续
    const claimed = readFormalSendQueue(queuePath).records.filter(r => r.sendClaimId === claimId)
    if (claimed.length === 0) return stats

    const claimedEmails = new Set<string>()
    const claimedKeys = new Set<string>()

    for (let claimedIndex = 0; claimedIndex < claimed.length; claimedIndex++) {
      const record = claimed[claimedIndex]
      const original = candidateSnapshots.get(record.id)
      let providerStarted = false
      try {
        // claim 后逐条重新读取主数据，避免使用 claim 前的客户状态快照。
        const item = readItemsAtomic(itemsPath).find(x => x?.id === record.customerId)
        const found = item ? findPersistedDraft(item, record.draftId) : undefined
        const draft = found?.draft
        const recipient = String(record.recipientEmail || '').trim().toLowerCase()
        const isolationPath = deps.isolationStorePath || (deps.queuePath ? join(dirname(queuePath), 'isolation-store.json') : ISOLATION_STORE_FILE)
        const isolated = readIsolationStore(isolationPath).entries.some(entry =>
          entry.objectType === 'email'
          && entry.permanent !== false
          && String(entry.objectValue || '').trim().toLowerCase() === recipient)
        if (isolated) {
          stats.skipped++
          await mutateFormalSendQueue(latest => ({
            ...latest,
            records: latest.records.map(r => r.id === record.id ? {
              ...clearFormalSendClaim(r),
              sendQueueStatus: 'blocked' as const,
              sendError: 'auto_preflight:isolated_email',
              updatedAt: effectiveNow.toISOString(),
            } : r),
          }), { path: queuePath })
          continue
        }
        if (customerHasReplied(item)) {
          stats.skipped++
          await skipRepliedRecord(queuePath, record.id, effectiveNow)
          continue
        }
        // 唯一门禁：canSendFormalOutreach（机械 blocker 命中 → 跳过，不发送）
        const gate = canSendFormalOutreach({ item, draft, record, now: effectiveNow, batchEmails: claimedEmails, claimedKeys })
        if (gate.blockers.length) {
          stats.skipped++
          await mutateFormalSendQueue(latest => ({
            ...latest,
            records: latest.records.map(r => r.id === record.id ? {
              ...clearFormalSendClaim(r),
              sendQueueStatus: 'blocked' as const,
              sendError: `auto_preflight:${gate.blockers.join(',')}`,
              updatedAt: effectiveNow.toISOString(),
            } : r),
          }), { path: queuePath })
          continue
        }
        // 内容监督门禁（主公 2026-08-19）：逐封审查草稿是否"针对性一对一"。
        // FAIL → 自动用 LLM 定向重写草稿 → 更新草稿+队列 → 回 approved_for_sending 下 tick 重试发送；
        // 内容失败始终进入自动重写闭环；模型暂不可用时延时重试。
        // Codex 已完成一对一审查的草稿可能来自两条历史写入路径：
        // 旧路径写 supervisedBy/supervisedAt，新路径写 manualRiskConfirmedBy=codex:*。
        // 后者若不被识别，会在每个发送 tick 重复调用内容模型；本地模型不可用时
        // 就不断落回 rewrite_failed，反过来阻塞后面的正常队列。仅接受带有明确
        // Codex 标记、确认时间且保留针对性检查记录的草稿，未审查草稿仍走完整门禁。
        const codexReviewed = isCodexReviewedDraft(draft)
        if (deps.qualityGateEnabled !== false && !codexReviewed) {
          let qualityPass: boolean
          let qualityReason: string
          let quality: any
          try {
            quality = await assessDraftQuality(item, draft, deps.qualityGateDeps)
            const llmReviewMissing = deps.requireLlmQualityReview === true
              && (quality.source !== 'llm' || quality.llmFallback === true)
            qualityPass = quality.pass && !llmReviewMissing
            qualityReason = llmReviewMissing
              ? `llm_review_required:${quality.reason}`
              : quality.reason
          } catch (gateErr) {
            // 门禁自身异常 = 无法验证 → 拦下（fail-safe），不发送
            qualityPass = false
            qualityReason = `gate_error:${gateErr instanceof Error ? gateErr.message : String(gateErr)}`
          }
          if (!qualityPass) {
            // 内容不达标必须在自动链内修复：成功重写后仍是同一队列记录，不重复入队。
            const failReasons = extractContentFailReasons(qualityReason, quality)
            const rewritten = await (deps.rewriteDraftFn || rewriteDraft)(item, draft, failReasons)
            if (!rewritten) {
              // LLM 暂不可用 / 重写失败：保留在自动重写队列，冷却后重试，绝不放行泛稿发送。
              stats.skipped++
              await mutateFormalSendQueue(latest => ({
                 ...latest,
                records: latest.records.map(r => r.id === record.id ? {
                  ...clearFormalSendClaim(r),
                  sendQueueStatus: 'approved_for_sending' as const,
                  pendingHumanReview: undefined,
                  sendError: 'content_not_targeted:rewrite_failed',
                  sendAttemptCount: original?.sendAttemptCount || 0,
                  lastSendAttemptAt: original?.lastSendAttemptAt,
                  outboundKey: original?.outboundKey,
                  contentRetryCount: (Number(r.contentRetryCount) || 0) + 1,
                  autoThrottleUntilAt: new Date(effectiveNow.getTime() + CONTENT_REWRITE_RETRY_MS).toISOString(),
                  updatedAt: effectiveNow.toISOString(),
                } : r),
              }), { path: queuePath })
              continue
            }
            // 顺序必须是"先队列后草稿"：即使草稿更新失败，队列已回 approved_for_sending，下轮重写仍有机会，不会永久 blocked。
            const updatedAt = effectiveNow.toISOString()
            await mutateFormalSendQueue(latest => ({
              ...latest,
              records: latest.records.map(r => r.id === record.id ? {
                ...clearFormalSendClaim(r),
                sendQueueStatus: 'approved_for_sending' as const,
                contentRetryCount: (Number(r.contentRetryCount) || 0) + 1,
                lastContentFailReasons: [...(Array.isArray(r.lastContentFailReasons) ? r.lastContentFailReasons : []), failReasons.join(' | ')],
                draftRevision: updatedAt,
                sendError: undefined,
                sendAttemptCount: original?.sendAttemptCount || 0,
                lastSendAttemptAt: original?.lastSendAttemptAt,
                outboundKey: original?.outboundKey,
                pendingHumanReview: undefined,
                autoThrottleUntilAt: undefined,
                updatedAt,
              } : r),
            }), { path: queuePath })
            updateOneItemAtomic(record.customerId, current =>
              updatePersistedDraft(current, record.draftId, draftCurrent => ({
                ...draftCurrent,
                subject: rewritten.subject,
                body: rewritten.body,
                updatedAt,
                rewriteCount: (Number(draftCurrent.rewriteCount) || 0) + 1,
              })),
              itemsPath,
            )
            stats.rewritten++
            continue
          }
        }

        if (beforeSend) await beforeSend(structuredClone(record))
        // provider 调用前再读一次，覆盖内容门禁执行期间刚到达的客户回复。
        const latestItem = readItemsAtomic(itemsPath).find(x => x?.id === record.customerId)
        if (customerHasReplied(latestItem)) {
          stats.skipped++
          await skipRepliedRecord(queuePath, record.id, effectiveNow)
          continue
        }
        const sentAt = effectiveNow.toISOString()
        const followup = isFollowupSend(record, draft)
        const due3 = followup && item?.followupDueAt3d
          ? item.followupDueAt3d
          : new Date(effectiveNow.getTime() + 3 * 86400_000).toISOString()
        const round = Number(record.followupRound || draft?.round || 0)
        const due7 = followup && round === 1
          ? new Date(effectiveNow.getTime() + 4 * 86400_000).toISOString()
          : followup && item?.followupDueAt7d
            ? item.followupDueAt7d
            : new Date(effectiveNow.getTime() + 7 * 86400_000).toISOString()
        const providerInput = {
          to: record.recipientEmail,
          subject: draft?.subject || '',
          body: normalizeEmailSignature(draft?.body || ''),
          customerId: record.customerId,
          outboundKey: record.outboundKey,
        }
        const outcome = await executeAuthorizedFormalProviderSend({
          queuePath,
          recordId: record.id,
          claimId,
          now: effectiveNow,
          providerTimeoutMs: deps.providerTimeoutMs,
          authorizationTtlMs: deps.authorizationTtlMs,
          runWhilePausedCampaignIds: deps.runWhilePausedCampaignIds,
          input: providerInput,
          send: sendFn,
          sentPatch: { followupDueAt3d: due3, followupDueAt7d: due7, itemStateRecoveryRequired: true },
          ambiguousErrorPrefix: 'ambiguous_after_provider',
          onProviderStart: () => { providerStarted = true },
        })
        if (outcome.status === 'not_authorized') {
          await mutateFormalSendQueue(latest => ({
            ...latest,
            records: latest.records.map(current => {
              if (current.id !== record.id || current.sendClaimId !== claimId || !original) return current
              return {
                ...clearFormalSendClaim(current),
                sendQueueStatus: original.sendQueueStatus,
                sendAttemptCount: original.sendAttemptCount,
                lastSendAttemptAt: original.lastSendAttemptAt,
                outboundKey: original.outboundKey,
                updatedAt: original.updatedAt,
              }
            }),
          }), { path: queuePath })
          stats.skipped++
          continue
        }
        claimedEmails.add(String(record.recipientEmail || '').toLowerCase())
        claimedKeys.add(String(record.outboundKey || ''))
        if (outcome.status === 'ambiguous') {
          stats.failed++
          writeState(deps, {
            lastSentAt: sentAt,
            nextAllowedAt: new Date(effectiveNow.getTime() + randomInt(minIntervalMs, maxIntervalMs + 1)).toISOString(),
          })
          break
        }
        const result = { messageId: outcome.messageId }
        const sentContentSnapshot = buildFormalSentContentSnapshot(providerInput, {
          draftId: record.draftId,
          capturedAt: sentAt,
          status: 'sent',
          messageId: result.messageId,
          sentAt,
        })
        // 写 emailLogs 回 items_store + 重算阶段（sent → followup_queue，下批次接）
        updateItemsAtomic(items => items.map(current => {
          if (current.id !== record.customerId) return current
          const updated = updatePersistedDraft({
            ...current,
            emailLogs: [...(Array.isArray(current.emailLogs) ? current.emailLogs : []), {
              status: 'sent',
              type: 'formal_outreach',
              sentAt,
              messageId: result.messageId,
              to: record.recipientEmail,
              recipientEmail: record.recipientEmail,
              subject: providerInput.subject,
              body: providerInput.body,
              contentSnapshotVersion: sentContentSnapshot.version,
              contentSnapshotSha256: sentContentSnapshot.bodySha256,
              outboundMessageKey: record.outboundKey,
              provider: 'zoho_smtp',
              deliveryStatus: 'sent_observation',
            }],
            developmentStatus: 'sent',
            formalDeliveryStatus: 'sent_observation',
            followupDueAt3d: due3,
            followupDueAt7d: due7,
            followupSentAt: followup ? sentAt : current.followupSentAt,
            replyCheckMode: 'manual_zoho_login',
          }, record.draftId, draftCurrent => ({
            ...draftCurrent,
            status: 'sent',
            sent: true,
            sentAt,
            updatedAt: sentAt,
          }))
          return applyEligibilityStage(updated, effectiveNow, {
            formalSentEmails: getFormalSentEmailsCached(),
            testMailVerdicts: getTestMailVerdictsCached(),
          }).item
        }), itemsPath, effectiveNow, {
          refreshOnlyMutated: true,
          formalSentEmails: getFormalSentEmailsCached(),
          testMailVerdicts: getTestMailVerdictsCached(),
        })
        await mutateFormalSendQueue(latest=>({...latest,records:latest.records.map(current=>current.id===record.id?{
          ...current,itemStateRecoveryRequired:undefined,itemStateCommittedAt:sentAt,updatedAt:sentAt,
        }:current)}),{path:queuePath})
        stats.sent++
        // 3-5 分钟随机节流：下次发送需等待冷却
        writeState(deps, {
          lastSentAt: sentAt,
          nextAllowedAt: new Date(effectiveNow.getTime() + randomInt(minIntervalMs, maxIntervalMs + 1)).toISOString(),
        })
      } catch (err) {
        const statePersistenceFailed = err instanceof FormalAutoStatePersistenceError
        if (!statePersistenceFailed) stats.failed++
        const errMsg = String(err instanceof Error ? err.message : err).slice(0, 400)
        if (providerStarted) {
          const providerAttemptedAt = effectiveNow.toISOString()
          const remainingClaimedIds = new Set(claimed.slice(claimedIndex + 1).map(value => value.id))
          await mutateFormalSendQueue(latest => ({
            ...latest,
            records: latest.records.map(r => {
              if (r.id === record.id) {
                const released = clearFormalSendClaim(r)
                const audit = [
                  ...(Array.isArray((r as any).postProviderFailureAudit) ? (r as any).postProviderFailureAudit : []),
                  { at: effectiveNow.toISOString(), error: errMsg, phase: 'after_provider_started' },
                ]
                const hasSentEvidence = r.sendQueueStatus === 'sent' || Boolean(r.messageId || r.actualSentAt)
                return hasSentEvidence ? {
                  ...released,
                  sendQueueStatus: 'sent' as const,
                  postProviderFailureAudit: audit,
                  updatedAt: effectiveNow.toISOString(),
                } : {
                  ...released,
                  sendQueueStatus: 'needs_manual_reconciliation' as const,
                  sendError: `ambiguous_after_provider:${errMsg}`,
                  providerAttemptedAt,
                  postProviderFailureAudit: audit,
                  updatedAt: effectiveNow.toISOString(),
                }
              }
              if (!remainingClaimedIds.has(r.id) || r.sendClaimId !== claimId) return r
              const original = candidateSnapshots.get(r.id)
              if (!original) return r
              return {
                ...clearFormalSendClaim(r),
                sendQueueStatus: original.sendQueueStatus,
                sendAttemptCount: original.sendAttemptCount,
                lastSendAttemptAt: original.lastSendAttemptAt,
                outboundKey: original.outboundKey,
                updatedAt: original.updatedAt,
              }
            }),
          }), { path: queuePath })
          if (statePersistenceFailed) {
            await failClosedOnStatePersistence(deps, queuePath)
            break
          }
          try {
            writeState(deps, {
              lastSentAt: providerAttemptedAt,
              nextAllowedAt: new Date(effectiveNow.getTime() + randomInt(minIntervalMs, maxIntervalMs + 1)).toISOString(),
            })
          } catch {
            await failClosedOnStatePersistence(deps, queuePath)
          }
          break
        }
        const attempts = Number(record.sendAttemptCount || 0)
        const exhausted = attempts >= MAX_AUTO_RETRY
        await mutateFormalSendQueue(latest => ({
          ...latest,
          records: latest.records.map(r => r.id === record.id ? {
            ...clearFormalSendClaim(r),
            sendQueueStatus: exhausted ? ('needs_manual_reconciliation' as const) : ('send_failed' as const),
            sendError: errMsg,
            autoThrottleUntilAt: exhausted ? undefined : new Date(effectiveNow.getTime() + randomInt(minIntervalMs, maxIntervalMs + 1)).toISOString(),
            sendFailures: (r.sendFailures || 0) + (exhausted ? 1 : 0),
            updatedAt: effectiveNow.toISOString(),
          } : r),
        }), { path: queuePath })
      }
    }
  } catch (err) {
    reportFormalAutoError(deps, err)
  } finally {
    releaseFormalQueueLock(runnerLock)
  }
  return stats
}
