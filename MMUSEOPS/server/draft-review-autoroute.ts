/**
 * 人工池自动分流：机械阻断的待审草稿由系统自动退回对应队列，不再要求人工点"驳回"。
 *
 * 背景（主公 2026-08-21）：审批页出现"收件人不一致/邮箱未验证"等机械阻断草稿，
 * 系统已判定不能发送，却还留在人工审核池等人工驳回，等于把系统该干的活推给人。
 * 本模块：每个 tick 扫描 pending_human_review 草稿，canSendFormalOutreach 有机械 blocker 的
 * 自动按阻断项映射退回目标队列（rejectDraftForRework，actor=system_autoroute）；
 * 机械门禁通过的（仅质量待审）保留给人工。
 */
import { readItemsAtomic, updateItemsAtomic, ITEMS_STORE_FILE } from './items-store-atomic'
import { allPersistedDrafts } from '../src/services/draftLookup'
import { canSendFormalOutreach } from '../src/services/formalSendGate'
import { rejectDraftForRework, DRAFT_RETURN_REASONS_BY_TARGET, type DraftReturnTarget } from '../src/services/draftReview'
import { contactMiningRoleClass } from '../src/services/emailClassification'

// 邮箱角色统一用 contactMiningRoleClass，不自写启发式。已验证的 public/location/department 地址允许开发；
// 仅明确 nonbusiness（noreply/hr/careers 等）继续回联系人挖掘。退信/封禁 → 隔离；未验证/不一致 → 回验证。
const TARGET_BY_BLOCKER: Array<[RegExp, DraftReturnTarget]> = [
  [/non_personal_role_email_requires_contact_mining/i, 'contact_mining_queue'],
  [/invalid_email_format/i, 'email_validation_queue'],
  [/email_not_verified/i, 'email_validation_queue'],
  [/recipient_identity_mismatch/i, 'email_validation_queue'],
  [/latest_bounce_or_suppression_or_complaint_or_dnc/i, 'true_excluded'],
  [/duplicate_email_in_batch/i, 'replace_contact_queue'],
  [/already_formally_sent|business_line_mismatch/i, 'paused_review'],
]

function returnTargetForBlockers(blockers: string[]): DraftReturnTarget {
  for (const blocker of blockers) {
    for (const [re, target] of TARGET_BY_BLOCKER) {
      if (re.test(blocker)) return target
    }
  }
  return 'replace_contact_queue'
}

export function shouldRouteRoleEmailToContactMining(email: string): boolean {
  return contactMiningRoleClass(email) === 'nonbusiness'
}

export interface DraftAutorouteStats {
  scanned: number
  autorouted: number
  kept: number
  items: { id: string; draftId: string; target: DraftReturnTarget; blockers: string }[]
}

export async function autorouteMechanicallyBlockedDrafts(now: Date): Promise<DraftAutorouteStats> {
  const items = readItemsAtomic()
  const toRoute: { itemId: string; draftId: string; target: DraftReturnTarget; reasonCode: string; blockers: string[] }[] = []
  let scanned = 0
  let kept = 0

  for (const item of items) {
    const pendingDrafts = (allPersistedDrafts(item) || []).filter((draft) => draft?.status === 'pending_human_review')
    for (const draft of pendingDrafts) {
      scanned++
      const gate = canSendFormalOutreach({ item, draft, now })
      if (!gate.blockers.length) {
        // 机械门禁通过后，仅明确非业务地址退回联系人挖掘；已验证公众/地名/部门邮箱按用户要求进入开发。
        const email = String(item?.selectedEmail || draft?.to || '')
        if (shouldRouteRoleEmailToContactMining(email)) {
          toRoute.push({
            itemId: String(item?.id),
            draftId: String(draft.id || draft.campaignKey || ''),
            target: 'contact_mining_queue',
            reasonCode: DRAFT_RETURN_REASONS_BY_TARGET['contact_mining_queue'][0],
            blockers: ['non_personal_email_requires_contact_mining'],
          })
          continue
        }
        kept++
        continue
      }
      const target = returnTargetForBlockers(gate.blockers)
      toRoute.push({
        itemId: String(item?.id),
        draftId: String(draft.id || draft.campaignKey || ''),
        target,
        reasonCode: DRAFT_RETURN_REASONS_BY_TARGET[target][0],
        blockers: gate.blockers,
      })
    }
  }

  if (!toRoute.length) return { scanned, autorouted: 0, kept, items: [] }

  const routed: DraftAutorouteStats['items'] = []
  await updateItemsAtomic(
    (list) =>
      list.map((it) => {
        const hit = toRoute.find((r) => r.itemId === String(it?.id))
        if (!hit) return it
        const updated = rejectDraftForRework(
          it,
          { draftId: hit.draftId, returnTarget: hit.target, reasonCode: hit.reasonCode, rejectedBy: 'system_autoroute' },
          now,
        )
        routed.push({ id: String(it?.id), draftId: hit.draftId, target: hit.target, blockers: hit.blockers.join(',') })
        return updated
      }),
    ITEMS_STORE_FILE,
    now,
    { refreshOnlyMutated: true },
  )

  return { scanned, autorouted: routed.length, kept, items: routed }
}
