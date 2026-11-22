import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readFormalSendQueue } from './formal-send-queue-store'
import { readTestMailQueue } from './test-mail-queue-store'

export const TRIAL_MONITOR_FILE = join(__dirname, '..', '.agent-harness', 'Hermes持续监控.json')

const TASK_NAMES: Record<string, string> = {
  backcheck: '客户背调', mediumPriority: '中匹配补位', contactMining: '联系人挖掘',
  draft: '草稿生成', followup: '客户跟进', dnsVerify: '邮箱校验',
  testmailEnqueue: '测试信入队', testmailRecovery: '邮箱验证回收', formal: '正式发送', refill: '搜索补池',
}

const COUNT_KEYS = ['processed', 'sent', 'failed', 'errors', 'drafted', 'rewritten', 'inserted', 'matched', 'created', 'updated', 'skipped', 'autoApproved', 'activated']

function safeText(value: unknown): string | null {
  if (!value) return null
  return String(value)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱已隐藏]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [已隐藏]')
    .replace(/(?:key|token|secret|password)\s*[:=]\s*\S+/gi, '$1=[已隐藏]')
    .slice(0, 240)
}

function timeOf(record: any): number {
  return Date.parse(String(record?.actualSentAt || record?.providerAttemptedAt || record?.testMailSentAt || record?.updatedAt || ''))
}

function isFollowup(record: any): boolean {
  return record?.campaignId === 'followup-auto-consumer'
    || record?.followup === true
    || String(record?.type || '').toLowerCase() === 'followup'
}

function statusCounts(records: any[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const record of records) {
    const status = String(record?.status || record?.sendQueueStatus || '未知')
    counts[status] = (counts[status] || 0) + 1
  }
  return counts
}

function taskSummary(tickStats: any): Record<string, unknown> {
  const source = tickStats?.pipeline?.results || {}
  return Object.fromEntries(Object.entries(source).map(([name, value]: [string, any]) => {
    const summary: Record<string, unknown> = { 状态: safeText(value?.状态 || '未知') }
    for (const key of COUNT_KEYS) {
      const count = Number(value?.[key])
      if (Number.isFinite(count)) summary[key] = count
    }
    return [TASK_NAMES[name] || name, summary]
  }))
}

export interface TrialMonitorInput {
  now: Date
  config: Record<string, any>
  pipelineControl: { running: boolean; updatedAt?: string }
  formalRecords: any[]
  testMailRecords: any[]
  testMailPaused: boolean
  tickStats: any
  workers: any[]
  schedulerHealthy: boolean
  formalReplyStats?: any
  errors?: Record<string, unknown>
}

export function buildTrialMonitorSnapshot(input: TrialMonitorInput) {
  const trialStart = Date.parse(String(input.config.trialStartedAt || ''))
  const inTrial = (record: any) => Number.isFinite(trialStart) && timeOf(record) >= trialStart
  const formalTrial = input.formalRecords.filter(inTrial)
  const formalSent = formalTrial.filter(record => record.sendQueueStatus === 'sent')
  const uncertain = formalTrial.filter(record => record.sendQueueStatus === 'needs_manual_reconciliation')
  const eligible = input.formalRecords.filter(record => ['approved_for_sending', 'scheduled', 'send_failed'].includes(record.sendQueueStatus))
  const testSentInTrial = input.testMailRecords.filter(record => {
    const sentAt = Date.parse(String(record?.testMailSentAt || record?.providerAttemptedAt || ''))
    return Number.isFinite(trialStart) && sentAt >= trialStart
  })
  const workerErrors = input.workers.filter(worker => Number(worker?.failureCount || 0) > 0).map(worker => ({
    任务: safeText(worker?.name), 状态: safeText(worker?.status), 连续失败: Number(worker?.failureCount || 0),
    最近失败: safeText(worker?.lastError || worker?.lastFailureAt),
  }))

  return {
    更新时间: input.now.toISOString(),
    试运行: {
      开始时间: input.config.trialStartedAt,
      停止时间: input.config.pipelineStopAt,
      系统运行中: input.pipelineControl.running === true,
      Hermes模型: String(input.config.llmModel || ''),
      付费备用已关闭: input.config.llmBackupEnabled === false,
      付费备用调用数: 0,
      联系人挖掘已关闭: input.config.contactMiningEnabled === false,
      联系人挖掘调用数: 0,
    },
    健康: {
      调度正常: input.schedulerHealthy,
      登记任务数: input.workers.length,
      异常任务: workerErrors,
    },
    正式邮件: {
      本次首发已发送: formalSent.filter(record => !isFollowup(record)).length,
      本次跟进已发送: formalSent.filter(isFollowup).length,
      本次结果待核对: uncertain.length,
      当前合格首发待发: eligible.filter(record => !isFollowup(record)).length,
      当前合格跟进待发: eligible.filter(isFollowup).length,
      每日总上限: Number(input.config.formalDailyLimit || 100),
    },
    测试信: {
      队列文件总记录: input.testMailRecords.length,
      当前暂停: input.testMailPaused,
      本次已发送: testSentInTrial.length,
      本次退信: testSentInTrial.filter(record => record.status === 'bounced').length,
      本次回复: testSentInTrial.filter(record => record.status === 'replied').length,
      当前待发送: input.testMailRecords.filter(record => ['scheduled', 'paused'].includes(record.status)).length,
      状态分布: statusCounts(input.testMailRecords),
    },
    回信回收: {
      最近扫描: Number(input.formalReplyStats?.scanned || 0),
      最近回复: Number(input.formalReplyStats?.replied || 0),
      最近退信: Number(input.formalReplyStats?.bounced || 0),
      最近未匹配: Number(input.formalReplyStats?.unmatched || 0),
    },
    本轮任务: taskSummary(input.tickStats),
    本轮异常: Object.fromEntries(Object.entries(input.errors || {}).map(([key, value]) => [key, safeText(value)])),
  }
}

export function updateTrialMonitor(input: Omit<TrialMonitorInput, 'formalRecords' | 'testMailRecords' | 'testMailPaused'>, path = TRIAL_MONITOR_FILE) {
  const formalStore = readFormalSendQueue()
  const testMailStore = readTestMailQueue()
  const snapshot = buildTrialMonitorSnapshot({
    ...input,
    formalRecords: formalStore.records,
    testMailRecords: testMailStore.records,
    testMailPaused: testMailStore.paused,
  })
  let history: any[] = []
  try {
    if (existsSync(path)) {
      const prior = JSON.parse(readFileSync(path, 'utf8'))
      if (Array.isArray(prior?.历史)) history = prior.历史
    }
  } catch {}
  history.push({
    时间: snapshot.更新时间,
    运行中: snapshot.试运行.系统运行中,
    首发: snapshot.正式邮件.本次首发已发送,
    跟进: snapshot.正式邮件.本次跟进已发送,
    测试信: snapshot.测试信.本次已发送,
    回信: snapshot.回信回收.最近回复,
    退信: snapshot.回信回收.最近退信,
    异常任务数: snapshot.健康.异常任务.length,
    任务: snapshot.本轮任务,
  })
  const document = {
    说明: '由 MMUSEOPS/Hermes 每轮自动更新。只含脱敏聚合数据，不含客户邮箱、邮件正文或凭据。',
    最新: snapshot,
    历史: history.slice(-1500),
  }
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.tmp-${process.pid}`
  writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  renameSync(temp, path)
  return document
}
