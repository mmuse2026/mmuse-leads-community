import { runFormalAutoStep, type FormalAutoDeps, type FormalAutoStats } from './formal-auto-runner'

export interface FormalAutoSchedulerConfig {
  formalSupervisedOnly?: boolean
  formalQualityGateEnabled?: boolean
  formalDailyLimit?: number
}

export type FormalAutoSchedulerRunner = (
  now: Date,
  deps: FormalAutoDeps,
) => Promise<FormalAutoStats>

const EMPTY_STATS: FormalAutoStats = { sent: 0, skipped: 0, failed: 0, rewritten: 0 }

/** Run the formal queue independently of lead-generation pipeline state. */
export async function runFormalAutoSchedulerTick(
  now: Date,
  config: FormalAutoSchedulerConfig,
  runner: FormalAutoSchedulerRunner = runFormalAutoStep,
): Promise<FormalAutoStats> {
  const configuredDailyLimit = Number(config.formalDailyLimit ?? 100)
  const maxDailySend = Number.isFinite(configuredDailyLimit)
    ? Math.max(0, Math.min(100, Math.floor(configuredDailyLimit)))
    : 100
  if (maxDailySend === 0) return { ...EMPTY_STATS }

  return runner(now, {
    // Eligibility is determined per queued draft by the runner, not legacy
    // global toggles. Keep a one-message tick and existing safety checks.
    maxSendCount: 1,
    maxDailySend,
    requireSupervisedDraft: true,
    qualityGateEnabled: true,
    respectCustomerLocalWindow: true,
  })
}
