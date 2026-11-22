// 批次1：环节标准定义 —— 纯数据，零副作用，不改变任何现有运行行为。
// 描述全流程 9 个自动环节的标准；批次2-4 的调度器与消费函数以此为准接入。
import type { PrimaryStage } from './leadStageEligibility'

export type { PrimaryStage }

export interface StageStandard {
  stageId: string
  work: string // 工作要求：这个环节要做什么
  purpose: string // 目的
  inputSource: string // 数据从哪来（上游 stage 或队列文件）
  doneWhen: string // 完成判定：getLeadStageEligibility 输出该 stage = 未完成、需要处理
  producedFields: string[] // 处理完成后写什么字段
  passTo: string // 放行条件满足后进入下一环
  passCondition: string // 放行条件
  consumer: string // 消费函数名（批次2-4会实现，现在写规划名）
  perTick: number // 每 tick 处理上限
  budgetKey: string // 日预算键（防超限）
  replenish: string // 数据不足时上游补充动作
  failSafe: string // 失败时怎么处理
}

const STANDARDS: readonly StageStandard[] = [
  {
    stageId: 'backcheck_queue',
    work: '补全背调信息（国家/产品/行业/所在地/语言/官网），写入 evidenceGaps',
    purpose: '背调完整度',
    inputSource: '搜索入池的新客',
    doneWhen: "backcheckDecision==='auto_qualified_pending_human' 或 !hasDetailedBackcheck",
    producedFields: ['evidenceGaps', 'recommendedAction', 'detailedBackcheckAt', 'backCheck'],
    passTo: 'contact_mining_queue',
    passCondition: '背调完整 + businessMatch high/medium',
    consumer: 'backcheck-auto-consumer',
    perTick: 6,
    budgetKey: 'backcheck_daily',
    replenish: '新客入池自动触发',
    failSafe: 'evidenceGaps 缺失不推进',
  },
  {
    stageId: 'contact_mining_queue',
    work: '公众/部门邮箱先挖联系人（2-4/家）；已验证无退信的直接放行不再要求个人联系人',
    purpose: '得到关键联系人（主公：已验证无退信即放行，不因缺个人联系人硬拦）',
    inputSource: 'backcheck 放行的项',
    doneWhen: 'non_personal_email_requires_contact_mining（仅未验证时）',
    producedFields: ['contacts[].name/title/source', 'contactName'],
    passTo: 'email_validation_queue',
    passCondition: '挖到个人联系人；或已验证无退信直接放行',
    consumer: 'contact-mining-consumer',
    perTick: 1, // Snovio 限流
    budgetKey: 'snovio_daily',
    replenish: '无',
    failSafe: '配额耗尽暂停该域名',
  },
  {
    stageId: 'email_validation_queue',
    work: '内部 DNS/MX 校验，入 test_mail_queue 发真实测试信',
    purpose: '验证邮箱可达',
    inputSource: 'contact_mining 放行 / backcheck 放行',
    doneWhen: 'specific_email_evidence_missing / selected_email_required',
    producedFields: ['emailVerificationEvidence', 'test_mail_queue 记录'],
    passTo: 'observation_queue',
    passCondition: 'testMailVerdict no_bounce + 观察期完整',
    consumer: 'runHousekeepingStepper(DNS/MX) + runDueTestMailOnce',
    perTick: 6,
    budgetKey: 'testmail_daily',
    replenish: '无',
    failSafe: '退信 → replace_contact',
  },
  {
    stageId: 'observation_queue',
    work: '观察期回收测试信结果，无退信才放行',
    purpose: '确认无退信',
    inputSource: '测试信已发的项',
    doneWhen: 'observation_in_progress',
    producedFields: ['观察期字段', 'webhook 回收'],
    passTo: 'developable_email_pool',
    passCondition: 'no_bounce_observed 观察期到',
    consumer: '内务自动推进',
    perTick: 20,
    budgetKey: '无',
    replenish: '无',
    failSafe: '观察期未满不推进',
  },
  {
    stageId: 'developable_email_pool',
    work: '唯一合格池，自动生成草稿',
    purpose: '进入发送链路',
    inputSource: 'observation 放行 / 已验证无退信直接放行',
    doneWhen: '前流程走完 + verifiedPass（回收无退信）→ 本 stage（主公：无硬拦，已验证即放行）',
    producedFields: ['manualEmailDrafts[]'],
    passTo: 'pending_draft_review',
    passCondition: '生成草稿 → approved',
    consumer: 'draft-auto-consumer',
    perTick: 1,
    budgetKey: 'draft_daily',
    replenish: '搜索补充触发条件之一',
    failSafe: '草稿生成失败重试',
  },
  {
    stageId: 'pending_draft_review',
    work: '草稿生成/自检（收件人一致性）',
    purpose: '草稿就绪',
    inputSource: 'developable 生成草稿',
    doneWhen: "draft.status==='pending_human_review'",
    producedFields: ["draft.status='approved'"],
    passTo: 'scheduled_send_queue',
    passCondition: 'approved',
    consumer: 'draft-auto-consumer',
    perTick: 1,
    budgetKey: 'draft_daily',
    replenish: '无',
    failSafe: '收件人不一致标记回退',
  },
  {
    stageId: 'scheduled_send_queue',
    work: '执行正式发送（门禁 preflight）',
    purpose: '正式触达',
    inputSource: 'approved 草稿',
    doneWhen: 'draft approved 且未 sent',
    producedFields: ['formal_send_queue 记录'],
    passTo: 'followup_queue',
    passCondition: "sendQueueStatus='sent'",
    consumer: 'formal-auto-runner',
    perTick: 1, // 节流
    budgetKey: 'formal_daily',
    replenish: '无',
    failSafe: '发送失败重试 ≤3 次后暂停',
  },
  {
    stageId: 'followup_queue',
    work: '按 followupDueAt 3d/7d 自动跟进',
    purpose: '持续触达',
    inputSource: '已发送项',
    doneWhen: 'formalSent',
    producedFields: ['followup 草稿', '发送记录'],
    passTo: '持续回收',
    passCondition: '跟进发出',
    consumer: 'followup-auto-consumer',
    perTick: 1,
    budgetKey: 'followup_daily',
    replenish: '无',
    failSafe: '回复后停跟进',
  },
  {
    stageId: 'replace_contact_queue',
    work: '退信/不可达 → 换联系人重入验证',
    purpose: '挽回邮箱',
    inputSource: '退信/测试退信项',
    doneWhen: 'email_unreachable / test_mail_bounced',
    producedFields: ['新联系人'],
    passTo: 'email_validation_queue',
    passCondition: '换新',
    consumer: '内务/人工',
    perTick: 5,
    budgetKey: '无',
    replenish: '无',
    failSafe: '无',
  },
]

export const STAGE_STANDARDS: Record<string, StageStandard> = Object.fromEntries(
  STANDARDS.map((s) => [s.stageId, s]),
)

export function getStageStandard(stageId: string): StageStandard | undefined {
  return STAGE_STANDARDS[stageId]
}
