// src/services/testMailGate.ts
// 测试信 verdict 单一事实来源（流程固化：进入开发池之前，测试邮件必须无退信才能进）。
// 合并规则：bounced(3) > replied(2) > no_bounce_observed(1) > watching(0)。
// detail（tools/recovery_detail_0806.jsonl 的 after 字段）为权威源，先处理使同 rank 时 detail 优先。
// 逻辑迁移自 tools/formal_candidate_queue_v3_0806.mts 的 buildVerdictByEmail / buildMailByCustomer / customerState，
// 迁移后该三处逻辑不再重复，统一走本文件。

export type TestMailVerdictState = 'bounced' | 'replied' | 'no_bounce_observed' | 'watching'

export interface TestMailVerdict {
  customerId: string
  emails: string[]
  state: TestMailVerdictState
  detail: string
  providerEvents: string[]
  /** 发送与阶段门禁只读取当前 selectedEmail；客户级 state 仅供汇总展示。 */
  emailVerdicts?: Record<string, TestMailEmailVerdict>
}

/** 单条邮箱级 verdict（供测试/内部使用）。 */
export interface TestMailEmailVerdict { state: TestMailVerdictState; providerEvent?: string }

const RANK: Record<TestMailVerdictState, number> = { bounced: 3, replied: 2, no_bounce_observed: 1, watching: 0 }
const list = (v: unknown): any[] => (Array.isArray(v) ? v : [])
const lower = (v: unknown): string => String(v ?? '').trim().toLowerCase()

function recordVerdict(map: Map<string, TestMailEmailVerdict>, emailRaw: unknown, state: TestMailVerdictState, providerEvent?: unknown): void {
  const key = lower(emailRaw)
  if (!key) return
  const cur = map.get(key)
  if (!cur || RANK[state] > RANK[cur.state]) map.set(key, { state, providerEvent: providerEvent ? String(providerEvent) : undefined })
}

/** 每邮箱 verdict（迁移自 buildVerdictByEmail，detail 的 after 为权威源）。 */
export function buildVerdictByEmail(records: any[], detail: any[]): Map<string, TestMailEmailVerdict> {
  const verdictByEmail = new Map<string, TestMailEmailVerdict>()
  for (const d of detail) {
    const state: TestMailVerdictState = d?.after === 'bounced' ? 'bounced' : d?.after === 'reply_observed' ? 'replied' : d?.after === 'no_bounce_observed' ? 'no_bounce_observed' : 'watching'
    recordVerdict(verdictByEmail, d?.email, state, d?.providerEvent)
  }
  for (const r of records) {
    // skipped_duplicate 也是真实测试信的重复记录（原发送可能已删），其 recoveryStatus/testMailStatus 的
    // no_bounce/bounced/replied 是有效信号，不能因 status 被排除——否则 176 条带 no_bounce 的记录被丢弃，
    // 客户 verdict 落回 watching，永远卡在 observation。
    if (r?.status !== 'sent' && r?.status !== 'verified' && r?.status !== 'bounced' && r?.status !== 'replied' && r?.status !== 'delivered' && r?.status !== 'skipped_duplicate') continue
    const rs = String(r.recoveryStatus || '')
    const ts = String(r.testMailStatus || '')
    const prov = String(r.providerStatus || '')
    if (rs === 'bounced' || ts === 'bounced_test' || prov === 'bounced') recordVerdict(verdictByEmail, r.recipientEmail, 'bounced', prov)
    else if (rs === 'replied' || ts === 'reply_observed') recordVerdict(verdictByEmail, r.recipientEmail, 'replied', prov)
    else if (rs === 'verified' || ts === 'smtp_handshake_pass' || rs === 'no_bounce_observed' || ts === 'no_bounce_observed') recordVerdict(verdictByEmail, r.recipientEmail, 'no_bounce_observed', prov)
  }
  return verdictByEmail
}

/** 按 customerId 归集邮箱 + 邮箱级 verdict 列表（迁移自 buildMailByCustomer）。 */
function buildMailByCustomer(records: any[], detail: any[], verdictByEmail: Map<string, TestMailEmailVerdict>): Map<string, { emails: string[]; verdicts: TestMailEmailVerdict[] }> {
  const mailByCustomer = new Map<string, { emails: string[]; verdicts: TestMailEmailVerdict[] }>()
  function addMail(cidRaw: unknown, emailRaw: unknown, verdict?: TestMailEmailVerdict): void {
    const id = String(cidRaw || '')
    const key = lower(emailRaw)
    if (!id || !key) return
    const e = mailByCustomer.get(id) || { emails: [], verdicts: [] }
    if (!e.emails.includes(key)) e.emails.push(key)
    if (verdict) e.verdicts.push(verdict)
    mailByCustomer.set(id, e)
  }
  for (const r of records) {
    const email = String(r?.recipientEmail || '')
    const verdict = verdictByEmail.get(lower(email))
    addMail(r?.customerId, email, verdict)
    for (const cid of list(r?.linkedCustomerIds)) addMail(cid, email, verdict)
  }
  for (const d of detail) addMail(d?.customerId, d?.email, verdictByEmail.get(lower(d?.email)))
  return mailByCustomer
}

/** 客户级状态：bounced > replied > no_bounce_observed > watching（迁移自 customerState）。 */
function customerState(verdicts: TestMailEmailVerdict[]): { state: TestMailVerdictState; detail: string; events: string[] } {
  const events = [...new Set(verdicts.map(v => v.providerEvent).filter(Boolean))] as string[]
  const has = (s: TestMailVerdictState) => verdicts.some(v => v.state === s)
  if (has('bounced')) return { state: 'bounced', detail: '明确退信', events }
  if (has('replied')) return { state: 'replied', detail: '已回复线索', events }
  if (has('no_bounce_observed')) return { state: 'no_bounce_observed', detail: '无退信（邮箱有效）', events }
  return { state: 'watching', detail: '观察中/未定论', events }
}

/** 单一来源：由 test_mail_queue records + recovery detail 构建"每客户 verdict"表。 */
export function buildTestMailVerdicts(records: any[], detail: any[]): Map<string, TestMailVerdict> {
  const verdictByEmail = buildVerdictByEmail(records, detail)
  const mailByCustomer = buildMailByCustomer(records, detail, verdictByEmail)
  const out = new Map<string, TestMailVerdict>()
  for (const [id, me] of mailByCustomer) {
    const st = customerState(me.verdicts)
    const emailVerdicts = Object.fromEntries(me.emails.flatMap(address => {
      const verdict = verdictByEmail.get(address)
      return verdict ? [[address, verdict]] : []
    }))
    out.set(id, { customerId: id, emails: me.emails, state: st.state, detail: st.detail, providerEvents: st.events, emailVerdicts })
  }
  return out
}

/** 查某客户（item）的测试信 verdict；无 verdict 或未提供表时返回 null。 */
export function testMailVerdictReason(item: any, verdicts?: ReadonlyMap<string, TestMailVerdict>, selectedEmail?: string): { state: TestMailVerdictState; detail: string } | null {
  const id = String(item?.id ?? '')
  if (!id || !verdicts) return null
  const v = verdicts.get(id)
  if (!v) return null
  const selected = lower(selectedEmail)
  if (selected) {
    const scoped = v.emailVerdicts?.[selected]
    const legacySingleAddressMatch = !v.emailVerdicts && v.emails.length === 1 && lower(v.emails[0]) === selected
    if (!scoped && !legacySingleAddressMatch) return null
    if (!scoped) return { state: v.state, detail: v.detail }
    return { state: scoped.state, detail: scoped.state === 'bounced' ? '明确退信' : scoped.state === 'replied' ? '已回复线索' : scoped.state === 'no_bounce_observed' ? '无退信（邮箱有效）' : '观察中/未定论' }
  }
  return { state: v.state, detail: v.detail }
}
