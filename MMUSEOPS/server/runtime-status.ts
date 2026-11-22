import type { WorkerSnapshot } from './runtime-ledger'

const workerNames: Record<string, string> = {
  backcheck: '客户背调',
  mediumPriority: '中匹配补位',
  contactMining: '联系人挖掘',
  draft: '草稿生成',
  followup: '客户跟进',
  dnsVerify: '邮箱校验',
  testmailEnqueue: '测试信入队',
  testmailRecovery: '邮箱验证回收',
  formal: '正式发送',
  refill: '客户补充',
}

function publicError(value: string | null): string | null {
  if (!value) return null
  return value
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[邮箱已隐藏]')
    .replace(/\bbearer\s+\S+/gi, 'Bearer [凭据已隐藏]')
    .replace(/(authorization|api[_ -]?key|token)(\s*[:=]\s*)\S+/gi, '$1$2[凭据已隐藏]')
    .slice(0, 200)
}

export function publicRuntimeWorkers(snapshots: WorkerSnapshot[]) {
  return snapshots.map(worker => ({
    name: workerNames[worker.name] || '未知任务',
    status: worker.status,
    lastSuccessAt: worker.lastSuccessAt,
    failureCount: worker.consecutiveFailures,
    consecutiveFailures: worker.consecutiveFailures,
    lastFailureAt: worker.lastFailureAt,
    nextRetryAt: worker.nextRetryAt,
    error: publicError(worker.lastError),
  }))
}
