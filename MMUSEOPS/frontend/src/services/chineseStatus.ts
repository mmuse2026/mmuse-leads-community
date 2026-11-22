/**
 * 全中文状态映射（前端展示用）
 *
 * 铁律：客户处理工作台任何展示位禁止直接渲染英文技术 token（sent/bounced/
 * followup_queue/observation_queue 等），一律经本模块转成中文。
 * 未收录的值返回「未知」，避免把原始英文漏到界面上。
 */

const STATUS_MAP: Record<string, string> = {
  // 发送 / 投递
  sent: '已发送',
  delivered: '已送达',
  delivery: '已送达',
  opened: '已读',
  read: '已读',
  open: '已读',
  sending: '发送中',
  queued: '提供方已接收',
  submitted: '已提交',
  scheduled: '已排程',
  scheduled_send_queue: '已排程待发送',
  approved_for_sending: '已批准待排程',
  send_failed: '发送失败',
  failed: '发送失败',
  needs_reschedule: '需重排',
  needs_timezone_review: '需确认时区',
  needs_manual_reconciliation: '需人工对账',
  pending: '待处理',
  blocked: '已阻止',

  // 退信 / 屏蔽 / 投诉
  bounced: '已退信',
  bounce: '已退信',
  hard_bounce: '已退信',
  hardbounce: '已退信',
  'hard bounce': '已退信',
  bounced_test: '测试信退信',
  email_bounced: '已退信',
  suppressed: '已屏蔽',
  suppression: '已屏蔽',
  complained: '已投诉',
  complaint: '已投诉',
  spam: '垃圾举报',

  // 回复
  replied: '已回复',
  reply: '已回复',
  reply_observed: '已回复',
  replied_queue: '已回复待处理',
  auto_reply: '自动回复',

  // 阶段 / 队列
  followup_queue: '待跟进',
  followup: '待跟进',
  observation_queue: '观察中',
  observing: '观察中',
  watching: '观察中',
  replace_contact_queue: '需换联系人',
  replace_contact: '需换联系人',
  replace_contact_required: '需换联系人',
  unreachable: '不可达',
  contact_mining_queue: '需挖联系人',
  contact_mining: '需挖联系人',
  backcheck_queue: '需补背调',
  backcheck: '需补背调',
  data_enrichment_needed: '需补数据',
  deep_backcheck_queue: '深度背调',
  manual_review: '待人工审核',
  manual_confirmation: '待人工确认',
  manual_confirmation_required: '待人工确认',
  pending_draft_review: '草稿待审',
  pending_human_review: '草稿待审',
  true_excluded: '已隔离',
  excluded: '已隔离',
  inactive_excluded: '已隔离',
  email_validation_queue: '邮箱待验证',
  low_priority_nurture: '低优先培育',
  developable_email_pool: '可开发邮箱池',
  do_not_develop: '永久不开发',
  do_not_contact: '禁止联系',
  paused_review_queue: '暂停复核',
  paused: '已暂停',
  active: '进行中',
  completed: '已完成',
  done: '已完成',
  archived: '已归档',

  // 邮箱验证结果
  verified: '已验证',
  smtp_handshake_pass: 'SMTP 验证通过',
  smtp_handshake_fail: 'SMTP 验证失败',
  valid: '有效',
  invalid: '无效',
  risky: '有风险',
  catchall: '捕集邮箱',
  unverified: '未验证',
  accepted: '已接受',
  domain_only: '仅域名证据',
  dns_mx_ok: 'DNS 正常',
  dns_failed: 'DNS 无记录',
  dns_unknown: 'DNS 未知',

  // 价值 / 匹配
  high: '高',
  medium: '中',
  low: '低',
  none: '无',

  // 邮箱类型
  personal_company: '公司个人邮箱',
  department: '部门邮箱',
  department_email: '部门邮箱',
  public: '公众邮箱',
  public_email: '公众邮箱',
  free_business: '官网免费业务邮箱',
  free_unconfirmed: '待确认免费邮箱',
  guessed: '推测来源',
  placeholder: '占位地址',
  specific_email: '具体邮箱',
  company_domain: '公司域名',

  // 测试信 / 观察
  test_sent: '测试信已发送',
  test_mail_replied: '测试信已回复',
  no_bounce_observed: '观察期无退信',
  returned_for_contact_replacement: '已退回换联系人',
  test_status_watching_or_delivered: '测试信观察/已投递',

  // 隔离库对象类型
  company: '公司',
  domain: '域名',
  email: '邮箱',
  contact: '联系人',
}

/** 把任意英文状态/阶段 token 转成中文；未收录返回「未知」。 */
export function cnStatus(value: unknown): string {
  const key = String(value ?? '').trim().toLowerCase()
  return STATUS_MAP[key] || '未知'
}

/** 隔离库对象类型：company/domain/email/contact → 中文 */
export function cnObjectType(value: unknown): string {
  const key = String(value ?? '').trim().toLowerCase()
  return { company: '公司', domain: '域名', email: '邮箱', contact: '联系人' }[key] || '未知'
}

/** 布尔显示：true → 是 / false → 否 / 其他 → — */
export function cnBoolean(value: unknown): string {
  if (value === true) return '是'
  if (value === false) return '否'
  return '—'
}

/** 建议动作：按状态给出中文的人工动作指引 */
export function cnAction(value: unknown): string {
  const key = String(value ?? '').trim().toLowerCase()
  const map: Record<string, string> = {
    manual_reply: '打开邮件并人工回复',
    replied: '打开邮件并人工回复',
    reply: '打开邮件并人工回复',
    followup_send: '今天发送第一次跟进',
    followup: '今天发送第一次跟进',
    followup_queue: '今天发送第一次跟进',
    wait_observation: '继续观察',
    observing: '继续观察',
    observation_queue: '继续观察',
    watching: '继续观察',
    replace_contact: '换联系人',
    replace_contact_required: '换联系人',
    contact_mining: '换联系人',
    manual_review: '人工审核开发信',
    review: '人工审核开发信',
    backcheck: '人工审核开发信',
    backcheck_queue: '人工审核开发信',
    dns_then_resend: '先 DNS 再测试信',
    none: '暂不处理',
    skip: '暂不处理',
  }
  return map[key] || cnStatus(value)
}
