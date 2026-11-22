export function createLatestRequestGate() {
  let sequence = 0
  return {
    issue: () => ++sequence,
    isLatest: (request: number) => request === sequence,
  }
}

export function makeReviewNotice(customerId: string, draftId: string, message: string) {
  return { customerId, draftId, message }
}

/**
 * 单发按钮资格判断，与后端唯一门禁 canSendFormalOutreach 对齐：
 * - 后端 blockers 只包含 6 类硬阻止 + recipient/sender 机械完整性 2 项；
 *   warnings（15 项）绝不会进入 blockers，因此这里不需要区分，直接按
 *   blockedReasons 判定即可。
 * - manual_confirmation_required 允许被“点击发送”本身满足（confirmSend=true，
 *   后端最终把关），因此从禁用判定中剔除；其余任一 blocker 都禁止单发。
 * - 本函数只做展示层判断，绝不新写任何发送资格逻辑。
 */
export function manualSendOneEligibility(assessment: { blockedReasons?: string[] } | undefined) {
  const remainingBlockedReasons = (assessment?.blockedReasons || [])
    .filter(reason => reason !== 'manual_confirmation_required')
  return { allowed: remainingBlockedReasons.length === 0, remainingBlockedReasons }
}

export async function submitApprovalThenRefresh(
  approve: () => Promise<{ ok: boolean }>,
  refresh: () => Promise<void>,
) {
  const result = await approve()
  if (!result.ok) return { approved: false, refreshFailed: false }
  try {
    await refresh()
    return { approved: true, refreshFailed: false }
  } catch {
    return { approved: true, refreshFailed: true }
  }
}
