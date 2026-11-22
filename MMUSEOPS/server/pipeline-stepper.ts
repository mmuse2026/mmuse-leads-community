// 批次5：统一挂载调度器 —— 把已实现的 7 个自动消费器接入 backgroundTick，实现全流程自动循环。
//
// 挂载点：server/search-api.ts 的 backgroundTick（runHousekeepingStepper 之后）在
// PIPELINE_AUTO_ENABLED（默认 true）时调用本函数；正式发送子开关沿用
// 正式发送逐条由队列资格、客户本地时段、抑制名单及额度控制，不设置全局发送开关。
//
// 执行顺序（优先级由高到低，每步 try/catch 不中断）：
//   1. backcheck     —— 背调自动消费（基础，先做）
//   2. contactMining —— 挖联系人
//   3. draft         —— 草稿自动生成
//   4. followup      —— 跟进草稿生成
//   5. testmailEnqueue —— DNS 通过项自动入测试信队列（正式发送前先保证测试信入队）
//   6. formal        —— 正式发送（逐条资格检查及发送额度）
//   7. refill        —— 数据不足自动补搜索（放最后，可能触发新搜索入池）
//
// 写库走真实 store：各消费器默认用 ITEMS_STORE_FILE / FORMAL_SEND_QUEUE_FILE；
// 测试可通过 deps.itemsStorePath / deps.queuePath 指向独立库；refill 走
// runRefillCheckBootstrap（updateOneItemAtomic allowCreate 入库新客）。
// 各消费器自身已对单条失败容错（只记 lastError 不中断整批），本层 try/catch 兜底意外异常
// （如读库/写库整体失败），单步抛错不影响后续步骤。

import { runBackcheckAutoStep } from './backcheck-auto-consumer'
import { runContactMiningAutoStep } from './contact-mining-consumer'
import { runDraftAutoStep } from './draft-auto-consumer'
import { runDnsVerifyAutoStep } from './testmail-dns-verify'
import { runFollowupAutoStep } from './followup-auto-consumer'
import { runFormalAutoStep } from './formal-auto-runner'
import { runRefillCheckBootstrap } from './refill-trigger-bootstrap'
import { runTestmailEnqueueAutoStep } from './testmail-enqueue-consumer'
import { runTestMailRecoveryAutoStep } from './testmail-recovery-consumer'
import { runMediumPriorityActivationStep } from './medium-priority-consumer'
import type { LeaseHandle, RuntimeLedger } from './runtime-ledger'
import { pipelineBusinessId, pipelineLeaseKey } from './business-pipelines'

export type PipelineStepName =
  | 'backcheck'
  | 'mediumPriority'
  | 'contactMining'
  | 'draft'
  | 'followup'
  | 'dnsVerify'
  | 'testmailEnqueue'
  | 'testmailRecovery'
  | 'formal'
  | 'refill'

export type PipelineStepFn = (now: Date, deps: any) => Promise<unknown>

export interface PipelineStepperDeps {
  /** 覆盖 items_store.json 路径（测试/独立库用） */
  itemsStorePath?: string
  /** 覆盖 formal_send_queue.json 路径（测试/独立库用） */
  queuePath?: string
  /** 覆盖当前时间 */
  now?: Date
  /** stepper 版本戳（防同版本重复处理；换版本号即重新消费） */
  version?: string
  /** 正式发送开关（显式 boolean 优先于 user_config.json，默认 false） */
  /** 联系人挖掘开关；false 时保留数据但不调用任何挖掘供应商。 */
  contactMiningEnabled?: boolean
  /** 单步运行上限；超时只停止等待，不终止仍在执行的 worker */
  timeoutMs?: number
  /** 跨进程 worker 租约时长 */
  leaseMs?: number
  /** 失败后的账本重试等待 */
  retryDelayMs?: number
  /** 可选 SQLite/WAL 运行账本 */
  ledger?: RuntimeLedger
  /** Snovio 凭据覆盖（contact-mining 用） */
  snovioUserId?: string
  snovioSecret?: string
  /** 单步函数覆盖（测试注入 mock 消费器；生产缺省用真实实现） */
  steps?: Partial<Record<PipelineStepName, PipelineStepFn>>
  /** 上层巡检可读的错误槽（本函数只写，不抛） */
  lastError?: Record<string, unknown>
  /** 其余字段透传给各消费器 deps（如 backfillFn / snovioClient / minPoolSize 等测试注入） */
  [key: string]: unknown
}

export interface PipelineStepperResult {
  /** 每步结果（如 processed / autoApproved / sent 等），步名见 PipelineStepName */
  results: Record<string, unknown>
  /** 任一步出错时汇总（k1:msg1 | k2:msg2），无错误为 undefined */
  lastError?: string
}

const DEFAULT_VERSION = 'pipeline-stepper-v1'
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_LEASE_MS = 60_000
const DEFAULT_RETRY_DELAY_MS = 60_000

const activeWorkers = new Map<PipelineStepName, Promise<unknown>>()

function messageOf(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
}

function completedResult(value: unknown): Record<string, unknown> {
  if (partialFailureCount(value) > 0) return { ...(value as Record<string, unknown>), 状态: '部分失败' }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>), 状态: '已完成' }
  }
  return { 状态: '已完成', 结果: value }
}

function partialFailureCount(value: unknown): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 0
  return ['failed', 'errors', 'apiErrors'].reduce((total, key) => {
    const count = Number((value as Record<string, unknown>)[key] || 0)
    return total + (Number.isFinite(count) && count > 0 ? count : 0)
  }, 0)
}

async function observeWorker(worker: Promise<unknown>, timeoutMs: number): Promise<
  | { kind: 'success'; value: unknown }
  | { kind: 'failure'; error: unknown }
  | { kind: 'timeout' }
> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<{ kind: 'timeout' }>(resolve => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs)
  })
  try {
    return await Promise.race([
      worker.then(
        value => ({ kind: 'success' as const, value }),
        error => ({ kind: 'failure' as const, error }),
      ),
      timeout,
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 全流程自动循环调度器。
 * 按优先级顺序执行自动消费器；正式发送由逐条资格、抑制名单、排期和额度决定。
 * 返回 { results, lastError } 供日志/展示；本函数不抛错（单步异常只记 lastError）。
 */
export async function runPipelineStepper(
  now: Date,
  deps: PipelineStepperDeps = {},
): Promise<PipelineStepperResult> {
  const business = deps.businessId === undefined ? 'furniture' : pipelineBusinessId(deps.businessId)
  if (!business) throw new Error('PIPELINE_BUSINESS_UNKNOWN')
  if (business !== 'furniture') throw new Error('PIPELINE_BUSINESS_NOT_CONNECTED')
  const workerKey = (name: string) => pipelineLeaseKey(business, name)
  const results: Record<string, unknown> = {}
  const lastError: Record<string, unknown> = {}
  const effectiveNow = deps.now || now
  const timeoutMs = Number(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const leaseMs = Number(deps.leaseMs ?? DEFAULT_LEASE_MS)
  const retryDelayMs = Number(deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS)

  // 各消费器共用的 deps：注入真实 store / 时间 / 错误槽，测试注入项（backfillFn / snovioClient / minPoolSize 等）原样透传。
  // 注意：不注入统一 version——各消费者用自身 DEFAULT_VERSION 盖戳/过滤（pipeline-stepper-v1 会把 pipeline 盖过戳的项
  // 误判为已处理而全部跳过，导致 backcheck/contactMining/draft/followup 全链路停滞）。
  const common: any = { ...deps, now: effectiveNow, lastError }

  // 优先级顺序注册（正式发送先查开关，false 则整个步骤跳过 → 零操作，不触碰队列/发送通道）。
  const steps: Array<{ name: PipelineStepName; run: () => Promise<unknown> }> = []
  const register = (name: PipelineStepName, fn: PipelineStepFn): void => {
    steps.push({ name, run: () => fn(effectiveNow, common) })
  }

  // 1. 背调自动消费（基础，先做）
  register('backcheck', deps.steps?.backcheck || runBackcheckAutoStep)
  // 2. 高匹配为空时启用最早 10 条中匹配
  register('mediumPriority', deps.steps?.mediumPriority || runMediumPriorityActivationStep)
  // 3. 挖联系人（额度不足时可独立关闭，不阻塞其他步骤）
  if (deps.contactMiningEnabled !== false) {
    register('contactMining', deps.steps?.contactMining || runContactMiningAutoStep)
  } else {
    results.contactMining = { 状态: '已跳过，联系人挖掘关闭' }
  }
  // 3. 草稿自动生成
  register('draft', deps.steps?.draft || runDraftAutoStep)
  // 4. 跟进草稿生成
  register('followup', deps.steps?.followup || runFollowupAutoStep)
  // 8. 正式发送：逐条检查队列资格，不受全局开关影响。
  register('formal', deps.steps?.formal || runFormalAutoStep)
  // 9. 数据不足自动补搜索（放最后，可能触发新搜索入池）
  register('refill', deps.steps?.refill || runRefillCheckBootstrap)

  // 先启动所有空闲步骤，再并发观察；一个步骤超时或失败不阻塞其他步骤。
  const observations: Array<Promise<void>> = []
  for (const step of steps) {
    const key = workerKey(step.name)
    if (activeWorkers.has(key)) {
      results[step.name] = { 状态: '运行中' }
      continue
    }

    let handle: LeaseHandle | null = null
    if (deps.ledger) {
      handle = deps.ledger.claim(key, effectiveNow, leaseMs)
      if (!handle) {
        results[step.name] = { 状态: '等待其他进程' }
        continue
      }
    }

    const worker = Promise.resolve().then(step.run)
    activeWorkers.set(key, worker)

    let heartbeat: ReturnType<typeof setInterval> | undefined
    if (handle && deps.ledger) {
      const heartbeatIntervalMs = Math.min(Math.max(leaseMs / 3, 100), 30_000)
      heartbeat = setInterval(() => {
        try {
          if (!deps.ledger?.renew(handle, new Date(), leaseMs) && heartbeat) {
            clearInterval(heartbeat)
            heartbeat = undefined
          }
        } catch {
          if (heartbeat) clearInterval(heartbeat)
          heartbeat = undefined
        }
      }, heartbeatIntervalMs)
      heartbeat.unref()
    }

    // 即使本 tick 已超时，实际 worker 完成后仍负责结清账本和 active 标记。
    void worker.then(
      value => {
        const settleNow = new Date()
        if (handle && deps.ledger) {
          if (partialFailureCount(value) > 0) deps.ledger.partialFail(handle, settleNow, value, new Date(settleNow.getTime() + retryDelayMs))
          else deps.ledger.succeed(handle, settleNow, value)
        }
      },
      error => {
        const settleNow = new Date()
        if (handle && deps.ledger) {
          deps.ledger.fail(handle, settleNow, error, new Date(settleNow.getTime() + retryDelayMs))
        }
      },
    ).catch(() => undefined).finally(() => {
      if (heartbeat) clearInterval(heartbeat)
      if (activeWorkers.get(key) === worker) activeWorkers.delete(key)
    })

    observations.push((async () => {
      const observed = await observeWorker(worker, timeoutMs)
      if (observed.kind === 'success') {
        results[step.name] = completedResult(observed.value)
      } else if (observed.kind === 'failure') {
        const msg = messageOf(observed.error)
        lastError[step.name] = msg
        results[step.name] = { 状态: '失败，等待重试', 错误: msg }
      } else {
        results[step.name] = { 状态: '超时，仍在运行' }
      }
    })())
  }

  await Promise.all(observations)

  const keys = Object.keys(lastError)
  return {
    results,
    lastError: keys.length > 0 ? keys.map((k) => `${k}:${lastError[k]}`).join(' | ') : undefined,
  }
}
