/**
 * 开发信内容监督门禁（draft-quality-gate）
 *
 * 主公指令（2026-08-19）："你每个都研究一下再发送,看看是否匹配针对性一对一的规则,不然这样下去开发信白发了"。
 * 本模块在正式发送前逐封审查草稿是否满足"针对性一对一"标准：
 *   - LLM 主通道（本地 WebModel 网关 127.0.0.1:3456 → DeepSeek 官方兜底）逐维打分；
 *   - 无 LLM / LLM 失败时降级启发式；
 *   - 任一硬性失败（正文声称制造客户产品、公司名重复、占位/半截姓名、无公司引用）→ FAIL，绝不发送。
 *
 * 硬性失败（hardBlock）优先级高于 LLM 打分：即使 LLM 给高分，命中 hardBlock 也判 FAIL。
 * LLM 打分主要用于识别"模板感强但无硬伤"的草稿（去模板化 / 定制深度 / 细分匹配）。
 */

import { llmChatWithFallback } from './llm-client'

export interface DraftQualityCheck {
  id: string
  label: string
  pass: boolean
  detail: string
}

export interface DraftQualityResult {
  pass: boolean
  score: number
  reason: string
  checks: DraftQualityCheck[]
  source: 'llm' | 'heuristic'
  llmFallback: boolean
  hardBlocked: boolean
}

export interface LlmVerdict {
  score: number
  pass: boolean
  reason: string
  issues: string[]
  dimensions?: Record<string, number>
}

export interface QualityGateDeps {
  /** 是否启用 LLM 主通道（默认 true；测试可关） */
  llmEnabled?: boolean
  /** LLM 调用函数注入（测试用 mock；默认走内置 llmChat + 双通道兜底）。返回 null 表示 LLM 不可用，降级启发式。 */
  llmFn?: (input: { item: any; draft: any }) => Promise<LlmVerdict | null>
  /** 评分及格线（默认 70） */
  passThreshold?: number
}

// ---------------------------------------------------------------------------
// 文本工具
// ---------------------------------------------------------------------------

function text(v: unknown): string {
  return String(v || '').trim().replace(/\s+/g, ' ')
}

function compact(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 从正文首行提取称呼（Hi/Hello/Dear ...） */
function extractGreeting(body: string): { name: string; raw: string } | null {
  const m = body.match(/^\s*(?:Hi|Hello|Dear)\s+([^,\n]+)/i)
  if (!m) return null
  return { name: m[1].trim(), raw: m[0].trim() }
}

function greetingIsTeam(name: string): boolean {
  return /^team$/i.test(name)
}

function greetingIsPartialName(name: string): boolean {
  // "Larry V." / "Larry V" / "L. V." 这类半截名
  if (/^[A-Z][a-z]+\s+[A-Z]\.?$/.test(name)) return true
  if (/^[A-Z]\.?\s+[A-Z][a-z]+$/.test(name)) return true
  return false
}

/** 检测正文中"we manufacture X"是否把客户的某种产品当成我方的产品（硬性错误）。 */
function detectSemanticProductError(body: string, item: any): { found: boolean; phrase: string } {
  const bodyLower = body.toLowerCase()
  const m = bodyLower.match(/\bwe\s+manufacture\s+([^\.,\n]{2,80})/)
  if (!m) return { found: false, phrase: '' }
  const phrase = m[1].trim()
  const furnitureTerms = /furniture|seating|booth|banquette|chair|table|sofa|stool|upholster|dining|contract/i
  if (furnitureTerms.test(phrase)) return { found: false, phrase }
  // 与客户背调产品匹配：客户产品名出现在 claim 开头
  const products = Array.isArray(item?.backCheck?.products) ? item.backCheck.products.map(String) : []
  const compPhrase = compact(phrase)
  for (const p of products) {
    const cp = compact(p)
    if (cp.length >= 4 && compPhrase.startsWith(cp.slice(0, Math.max(4, Math.floor(cp.length / 2))))) {
      return { found: true, phrase }
    }
  }
  // 常见明显非家具 claim（即使不在背调产品列表，也判错——我们只造家具）
  if (/\b(luxury hotels|hotels and resorts|resorts|frozen meat|frozen food|pvc|conveyor|erp|software|trade show displays|display|modeling services|shopping centre|shopping center|real estate)\b/i.test(phrase)) {
    return { found: true, phrase }
  }
  return { found: false, phrase }
}

/** 检测公司名重复（"Al Habtoor Group Al Habtoor Group"），用 compact 归一化规避大小写/空格差异。 */
function detectCompanyDupe(body: string, company: string): boolean {
  if (!company) return false
  const bc = compact(body)
  const cc = compact(company)
  if (cc.length < 4) return false
  let count = 0
  let idx = 0
  while ((idx = bc.indexOf(cc, idx)) !== -1) {
    const before = idx === 0 ? '' : bc[idx - 1]
    const after = idx + cc.length < bc.length ? bc[idx + cc.length] : ''
    // compact 去掉了空格，"Acme Acme" 会压成 "acmeacme"，紧邻重复直接判重复
    if (bc.startsWith(cc, idx + cc.length)) return true
    // 只统计词边界命中：公司名是正文某词的子串（如联系人 "Jason Lin" 含 "JasonL"）不算重复
    if (!/\w/.test(before) && !/\w/.test(after)) {
      count++
      if (count >= 2) return true
    }
    idx += cc.length
  }
  // 处理"BSG (Bichet-Simon-Gagnon) BSG"式：公司全名后紧跟公司简称/首词
  const firstToken = compact(company.split(/\s+/)[0])
  if (firstToken.length >= 3 && cc.length > firstToken.length) {
    const afterFull = bc.indexOf(cc)
    if (afterFull !== -1) {
      const tail = bc.slice(afterFull + cc.length)
      if (tail.startsWith(firstToken) && !tail.startsWith(cc)) return true
    }
  }
  return false
}

/** 正文是否提及公司名或背调摘要具体信息（公司名/产品/市场/行业/客户类型）。 */
function detectBackgroundReference(body: string, item: any): { found: boolean; which: string[] } {
  const combined = ` ${body.toLowerCase()} `
  const hits: string[] = []
  const company = text(item?.company || item?.title)
  if (company && combined.includes(company.toLowerCase())) hits.push('company')
  // 真实公司名（背调 companyName）。部分 item.company 是损坏字符串（聚合时拼入产品线/搜索词），
  // 用背调里的干净公司名作为引用命中的备选来源，避免定向草稿被误判"纯群发"。
  const backcheckCompany = text(item?.backCheck?.companyName)
  if (backcheckCompany) {
    const bc = backcheckCompany.toLowerCase()
    const bcNoSpace = bc.replace(/[^a-z0-9]+/g, '')
    const combinedNoSpace = combined.replace(/[^a-z0-9]+/g, '')
    const exactHit = combined.includes(bc)
    // 无空格兜底：GLM 常对无空格品牌名（JasonL）补空格写成 "Jason L"
    const noSpaceHit = bcNoSpace.length >= 3 && combinedNoSpace.includes(bcNoSpace)
    // 双词块兜底：GLM 常把长名/括号名写短（"Gulf Brand Fast-Food Company (Popeyes Saudi)" → "Gulf Brand Fast-Food"）
    const words = bc.split(/[^a-z0-9]+/).filter((w: string) => w.length >= 2)
    const chunkHit = words.length >= 2 && words.slice(0, -1).some((w: string, i: number) => {
      const chunk = w + words[i + 1]
      return chunk.length >= 4 && combinedNoSpace.includes(chunk)
    })
    if (exactHit || noSpaceHit || chunkHit) hits.push('backcheck_company')
  }
  const products = Array.isArray(item?.backCheck?.products) ? item.backCheck.products.map(String) : []
  for (const p of products.slice(0, 3)) {
    const t = text(p)
    if (t.length >= 3 && combined.includes(t.toLowerCase())) { hits.push(`product:${t.slice(0, 30)}`); break }
  }
  const markets = Array.isArray(item?.backCheck?.markets) ? item.backCheck.markets.map(String) : []
  for (const mk of markets.slice(0, 3)) {
    const t = text(mk)
    if (t.length >= 3 && combined.includes(t.toLowerCase())) { hits.push(`market:${t.slice(0, 30)}`); break }
  }
  const industry = text(item?.backCheck?.industry || item?.industry)
  if (industry.length >= 3 && combined.includes(industry.toLowerCase())) hits.push(`industry:${industry.slice(0, 30)}`)
  return { found: hits.length > 0, which: hits }
}

/** 检测正文是否命中"未知细分"通用模板痕迹（We manufacture X and can share ... catalog for reference）。 */
function detectGenericTemplate(body: string): boolean {
  const b = body.toLowerCase()
  const genericUnknown = /\bwe\s+manufacture\s+.{2,80}\band\scan\sshare\s+relevant\s+product\s+information\b/.test(b)
    && /would\s+it\s+be\s+useful\s+if\s+i\s+sent\s+a\s+short\s+catalog\s+for\s+reference\?/.test(b)
  const genericChannel = /\bwe\s+are\s+a\s+factory[- ]direct\s+manufacturer\b/.test(b)
    && /would\s+a\s+catalog\s+of\s+our\s+range\s+be\s+useful\b/.test(b)
  const genericOperator = /\bwe\s+manufacture\s+contract[- ]grade\s+commercial\s+furniture\b/.test(b)
    && /would\s+it\s+be\s+helpful\s+if\s+i\s+sent\s+a\s+short\s+catalog\b/.test(b)
  return genericUnknown || genericChannel || genericOperator
}

// ---------------------------------------------------------------------------
// 启发式评估（无 LLM 时的降级路径）
// ---------------------------------------------------------------------------

export function heuristicAssess(item: any, draft: any): DraftQualityResult {
  const body = String(draft?.body || '')
  const subject = String(draft?.subject || '')
  const combined = `${subject}\n${body}`
  const company = text(item?.company || item?.title)
  const contactName = text(item?.contactName)

  const checks: DraftQualityCheck[] = []
  const addCheck = (id: string, label: string, pass: boolean, detail: string) => checks.push({ id, label, pass, detail })
  let score = 100
  let hardBlocked = false
  const reasons: string[] = []

  const failCheck = (id: string, label: string, detail: string, deduct: number, hard = false) => {
    addCheck(id, label, false, detail)
    score = Math.max(0, score - deduct)
    if (hard) hardBlocked = true
    reasons.push(label)
  }
  const passCheck = (id: string, label: string, detail: string) => addCheck(id, label, true, detail)

  // 1. 语义产品错误（硬性）
  const sem = detectSemanticProductError(body, item)
  if (sem.found) {
    failCheck('semantic_product_error', '正文声称制造客户产品（语义错误）', `"we manufacture ${sem.phrase}" 是客户产品而非家具`, 40, true)
  } else {
    passCheck('semantic_product_error', '正文未把客户产品当成本厂产品', sem.phrase ? `we manufacture ${sem.phrase}` : '未出现 we manufacture')
  }

  // 2. 公司名重复（硬性）
  if (detectCompanyDupe(body, company)) {
    failCheck('company_duplication', '公司名重复', '正文出现公司名连续重复', 30, true)
  } else {
    passCheck('company_duplication', '无公司名重复', '')
  }

  // 3. 公司/背调引用（硬性：完全没有公司/背调引用 = 纯群发）
  const ref = detectBackgroundReference(body, item)
  if (ref.found) {
    passCheck('background_reference', '引用了背调/公司信息', ref.which.join(' / '))
  } else {
    failCheck('no_background_reference', '未引用公司或背调信息', '正文未提及公司名/产品/市场/行业', 25, true)
  }

  // 4. 占位/半截姓名（有真实联系人却用 Team / 半截名 = 模板痕迹，硬性）
  const greeting = extractGreeting(body)
  if (contactName) {
    if (!greeting) {
      failCheck('no_greeting', '正文缺少称呼', '未找到 Hi/Hello/Dear 开头的称呼', 15)
    } else if (greetingIsTeam(greeting.name)) {
      failCheck('placeholder_name', '占位称呼 Team', `有真实联系人 ${contactName} 却用 Team`, 20, true)
    } else if (greetingIsPartialName(greeting.name)) {
      failCheck('partial_name', '半截姓名称呼', `称呼 "${greeting.name}" 是半截名`, 15, true)
    } else {
      passCheck('greeting_name', '称呼合理', greeting.name)
    }
  } else {
    if (!greeting) {
      failCheck('no_greeting', '正文缺少称呼', '未找到称呼', 15)
    } else if (greetingIsTeam(greeting.name)) {
      passCheck('greeting_name', '无联系人信息，Team 可接受', 'contactName 缺失，Team 兜底')
    } else if (greetingIsPartialName(greeting.name)) {
      failCheck('partial_name', '半截姓名称呼', `称呼 "${greeting.name}" 是半截名`, 15, true)
    } else {
      passCheck('greeting_name', '称呼合理', greeting.name)
    }
  }

  // 5. 模板感
  if (detectGenericTemplate(combined)) {
    failCheck('generic_template', '命中通用模板', '正文结构命中已知通用模板，缺乏一对一定制', 20)
  } else {
    passCheck('generic_template', '未命中已知通用模板', '')
  }

  const passThreshold = 70
  const pass = !hardBlocked && score >= passThreshold
  const reason = reasons.length
    ? `heuristic: ${reasons.join('; ')}`
    : 'heuristic: no obvious issues'

  return { pass, score, reason, checks, source: 'heuristic', llmFallback: false, hardBlocked }
}

// ---------------------------------------------------------------------------
// LLM 评估
// ---------------------------------------------------------------------------

const QUALITY_SYSTEM_PROMPT =
  'You are a senior B2B sales email quality reviewer. A furniture manufacturer (contract-grade commercial furniture: booths, banquettes, dining chairs/tables) sends first-touch outreach emails. ' +
  'Your job is to decide whether each email is genuinely personalized one-to-one for the specific customer, or a generic fill-in-the-blank template. ' +
  'Return ONLY valid JSON, no markdown, no explanation.'

function buildQualityMessages(item: any, draft: any): { role: string; content: string }[] {
  const products = Array.isArray(item?.backCheck?.products) ? item.backCheck.products.map(String).join(', ') : ''
  const markets = Array.isArray(item?.backCheck?.markets) ? item.backCheck.markets.map(String).join(', ') : ''
  const userContent = [
    'CUSTOMER RESEARCH:',
    `- Company name: ${text(item?.company || item?.title)}`,
    `- Contact person: ${text(item?.contactName) || '(none)'}`,
    `- Customer type / segment: ${text(item?.customerType || item?.clientType || item?.customerTypeAssessment) || '(unknown)'}`,
    `- Backcheck summary: ${text(item?.backCheck?.summary || item?.backcheckSummary)}`,
    `- Main products (customer\'s own): ${products || '(none)'}`,
    `- Markets: ${markets || '(none)'}`,
    `- Industry: ${text(item?.backCheck?.industry || item?.industry) || '(none)'}`,
    '',
    'DRAFT EMAIL:',
    `Subject: ${text(draft?.subject)}`,
    'Body:',
    String(draft?.body || ''),
    '',
    'Scoring dimensions (each 0-20, total /100):',
    '1. company_customization: does the body reference THIS company, its business, market or customer type (not generic)?',
    '2. background_reference: does the body cite concrete details from the research (products/markets/summary)?',
    '3. semantic_correctness: does the body make sense for this customer? CRITICAL: flag as FATAL if the email says "We manufacture <customer\'s product>" e.g. "We manufacture Frozen meat" when the customer makes frozen food - we are a furniture factory, we never claim to make the customer\'s product.',
    '4. segment_fit: operator/end-user (restaurant/hotel/cafe/group) should get restaurant/hotel scenario language; channel (distributor/wholesaler/importer/retailer) should get wholesale/OEM/distribution language.',
    '5. template_likeness: does the body look like a fill-in-the-blank template where only the company name was swapped and 90% is generic?',
    '',
    'Also flag these defects in issues[]: duplicated company name (e.g. "Acme Acme"), placeholder greeting "Team" when a real contact name exists, truncated/half-name greeting like "Larry V.", and any nonsense from template string concatenation.',
    '',
    'Return ONLY JSON: {"score": <0-100 int>, "pass": <true if score>=70>, "reason": "<one short sentence>", "issues": ["<issue>", ...], "dimensions": {"company_customization": <0-20>, "background_reference": <0-20>, "semantic_correctness": <0-20>, "segment_fit": <0-20>, "template_likeness": <0-20>}}',
  ].join('\n')
  return [
    { role: 'system', content: QUALITY_SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ]
}

function parseLlmVerdict(raw: Record<string, unknown>): LlmVerdict | null {
  const score = Number(raw.score)
  if (!Number.isFinite(score)) return null
  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    pass: Boolean(raw.pass) || score >= 70,
    reason: String(raw.reason || ''),
    issues: Array.isArray(raw.issues) ? raw.issues.map(String) : [],
    dimensions: raw.dimensions && typeof raw.dimensions === 'object'
      ? Object.fromEntries(Object.entries(raw.dimensions as Record<string, unknown>).map(([k, v]) => [k, Number(v) || 0]))
      : undefined,
  }
}

async function defaultLlmFn(input: { item: any; draft: any }): Promise<LlmVerdict | null> {
  const messages = buildQualityMessages(input.item, input.draft)
  const raw = await llmChatWithFallback(messages, 60000)
  if (!raw) return null
  return parseLlmVerdict(raw)
}

// ---------------------------------------------------------------------------
// 总入口
// ---------------------------------------------------------------------------

/**
 * 审查单封草稿。返回 PASS/FAIL + 分数 + 理由 + 检查明细。
 *
 * 优先级：
 *   1. 启发式硬性失败（语义产品错误 / 公司名重复）→ 直接 FAIL（即使 LLM 高分）。
 *   2. LLM 可用 → 用 LLM 打分（含去模板化/细分匹配等启发式覆盖不到的维度）。
 *   3. LLM 不可用 / 超时 → 纯启发式。
 */
export async function assessDraftQuality(item: any, draft: any, deps: QualityGateDeps = {}): Promise<DraftQualityResult> {
  const threshold = deps.passThreshold ?? 70
  const heuristic = heuristicAssess(item, draft)

  // 启发式硬性失败：不可被 LLM 覆盖
  if (heuristic.hardBlocked) {
    return {
      pass: false,
      score: heuristic.score,
      reason: `hard_block:${heuristic.reason}`,
      checks: heuristic.checks,
      source: heuristic.source,
      llmFallback: false,
      hardBlocked: true,
    }
  }

  const llmEnabled = deps.llmEnabled !== false
  if (!llmEnabled) return heuristic

  try {
    const llmFn = deps.llmFn || defaultLlmFn
    const verdict = await llmFn({ item, draft })
    if (!verdict) {
      // LLM 不可用 → 降级启发式
      return { ...heuristic, llmFallback: true }
    }
    const pass = verdict.pass && verdict.score >= threshold
    const llmChecks: DraftQualityCheck[] = [
      { id: 'llm_score', label: `LLM 评分 (${verdict.score}/100)`, pass: verdict.score >= threshold, detail: verdict.reason },
      ...(verdict.issues || []).map((issue, i) => ({
        id: `llm_issue_${i}`, label: 'LLM 指出问题', pass: false, detail: issue,
      })),
    ]
    return {
      pass,
      score: verdict.score,
      reason: `llm:${verdict.reason || 'score ' + verdict.score}`,
      checks: [...heuristic.checks, ...llmChecks],
      source: 'llm',
      llmFallback: false,
      hardBlocked: false,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[draftQualityGate] llm assess failed, fallback heuristic (${msg})`)
    return { ...heuristic, llmFallback: true, reason: `heuristic(llm_failed:${msg}): ${heuristic.reason}` }
  }
}
