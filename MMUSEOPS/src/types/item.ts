/** 工件/流程项类型定义 */
import type { BusinessLine, PipelineKey } from './pipeline'
import type { CommunicationEvent, CrmCommandAuditEntry, CrmTask, Opportunity, SalesStage, SalesStageHistoryEntry, WaitingFor } from './crm'
export type { BusinessLine } from './pipeline'

/** 工位流转记录 */
export interface StageTransition {
  stageId: string
  enteredAt: string   // ISO string
  exitedAt?: string
}

/** 备注 */
export interface Note {
  id: string
  content: string
  createdAt: string
}

/** 附件 */
export interface Attachment {
  id: string
  name: string
  url?: string
  type: 'image' | 'pdf' | 'other'
}

/** 报价版本 */
export interface QuoteVersion {
  id?: string
  version: number
  opportunityId?: string
  amount: number
  currency: string
  tradeTerm: string  // FOB / CIF / EXW
  status?: 'draft' | 'sent' | 'viewed' | 'accepted' | 'rejected' | 'expired'
  createdAt?: string
  updatedAt?: string
  validUntil?: string
  sentAt?: string
  readAt?: string
  notes: string
}

/** 产品行（用于报价和订单） */
export interface OrderLine {
  sku: string
  productName: string
  quantity: number
  unitPrice: number
  total: number
  spec: string       // 颜色/尺寸/面料等
}

/** 业务数据——按业务线区分 */
export interface CarSeatData {
  series?: string       // leather / ice-silk / sport / classic / cartoon / universal
  version?: 'standard' | 'luxury'
  vehicleModel?: string // 车型
  oemBrand?: string     // 贴牌品牌
}

export interface FurnitureData {
  category?: string     // Booth Seating / Dining Table / Chair / ...
  material?: string     // 面料/颜色
  dimensions?: string   // 尺寸
  customization?: string // 定制项
}

/** 管道级别（优先级） */
export type Priority = 'high' | 'medium' | 'low'

/** 状态 */
export type ItemStatus = 'active' | 'completed' | 'archived'

/** 客户等级（按公司规模） */
export type ClientLevel = 'S' | 'M' | 'L' | 'XL' | 'unknown'

/** Lead grade for outreach readiness. S = ready for manual email approval. */
export type LeadGrade = 'S' | 'A' | 'B' | 'C' | 'D'

/** 客户类型 */
export type ClientType = 'distributor' | 'trader' | 'ecommerce' | 'wholesaler' | 'retailer' | 'manufacturer' | 'unknown'

/** 邮箱验证状态 */
export type EmailVerification = 'verified' | 'catchall' | 'risky' | 'invalid' | 'unknown'

/** 业务线标签映射 */
export const BUSINESS_LINE_LABELS: Record<string, string> = {
  'furniture': '家具',
  'car-seat': '汽车座椅套',
  'lighting': '照明',
  'home': '家居日用',
  'packaging': '包装材料',
  'both': '综合',
}


/** 客户来源（用于Outreach — 含搜索渠道ID） */
export type OutreachSource =
  | 'google_dork'
  | 'linkedin'
  | 'apify'
  | 'serper'
  | 'justserp'
  | 'anysearch'
  | 'importyeti'
  | 'google'
  | 'maps'
  | 'manual'
  | 'referral'
  | 'social'
  | 'website'
  | 'whatsapp'
  | 'email'
  | 'exhibition'

/** 关键词搜索结果 */
export interface KeywordResult {
  keyword: string
  searchedAt: string
  totalResults: number
  newLeads: number
  hitRate: number       // 新线索/搜索结果数
}

/** 决策人信息 */
export interface DecisionMaker {
  name: string
  title?: string
  source?: string    // 信息来源（BBB / About页 / ZoomInfo等）
  sourceUrl?: string // 来源链接
  email?: string
}

/** 背调查数据 */
export interface BackCheckData {
  checkedAt: string
  /** 抓取前侦查与后续 AI 操作依据 */
  preflight?: {
    accessStatus?: 'READY_HTTP' | 'READY_BROWSER' | 'HUMAN_REQUIRED' | 'LOW_VALUE' | 'BLOCKED'
    renderMode?: 'http' | 'browser' | 'manual' | 'skip'
    finalUrl?: string
    httpStatus?: number | null
    antibotType?: string
    captchaPresent?: boolean
    loginRequired?: boolean
    publicContactSignal?: boolean
    pageTargets?: string[]
    actionPlan?: string[]
    stopConditions?: string[]
    fallbackPlan?: string[]
    evidence?: string[]
    checkedAt?: string
  }
  companyWebsite?: string
  employeeCount?: string
  revenue?: string
  yearFounded?: string
  linkedinUrl?: string
  tradeData?: string[]    // 海关/交易数据摘要
  products?: string[]     // 主营产品
  markets?: string[]      // 主要市场
  summary?: string        // 综合分析
  references?: string[]   // 参考来源
  verifiedContact?: string // 验证过的联系人
  decisionMakers?: DecisionMaker[]  // 自动找到的决策人
  language?: string       // 公司所用语言/官网语言（非国家语言），如 English / Spanish / zh-CN
  location?: string       // 公司所在地，尽可能具体（城市/州/地区）
  industry?: string       // 明确行业，如 hospitality furniture / restaurant supply / construction
}

/** 订单单证类型 */
export type DocumentType =
  | 'quotation' | 'contract' | 'proforma_invoice' | 'commercial_invoice'
  | 'packing_list' | 'bill_of_lading' | 'customs_declaration'
  | 'certificate_of_origin' | 'insurance' | 'export_license' | 'other'

export const DOCUMENT_LABELS: Record<DocumentType, string> = {
  quotation: '报价单 (Quotation)',
  contract: '销售合同 (S/C)',
  proforma_invoice: '形式发票 (P/I)',
  commercial_invoice: '商业发票 (C/I)',
  packing_list: '装箱单 (P/L)',
  bill_of_lading: '提单/运单 (B/L)',
  customs_declaration: '报关单 (C/D)',
  certificate_of_origin: '原产地证 (C/O)',
  insurance: '保险单',
  export_license: '出口许可证',
  other: '其他文件',
}

export const CUSTOMS_REQUIRED: DocumentType[] = [
  'contract', 'commercial_invoice', 'packing_list', 'bill_of_lading', 'customs_declaration',
]

/** 单证文件 */
export interface FulfillmentDocument {
  type: DocumentType
  status: 'ready' | 'pending' | 'missing'
  fileName?: string
  uploadedAt?: string
  notes?: string
}

/** 订单履约 */
export interface OrderFulfillment {
  orderType: 'regular' | 'sample'
  orderNumber: string
  orderDate: string
  estimatedDelivery?: string
  totalAmount: number
  currency: string
  tradeTerm: 'FOB' | 'CIF' | 'EXW' | 'DDP'
  shippingStatus: 'pending' | 'processing' | 'shipped' | 'delivered'
  documents: FulfillmentDocument[]
  notes?: string
}

/** 发信记录 */
export interface EmailLog {
  id: string
  itemId: string
  sentAt: string
  subject: string
  body: string
  status: 'sent' | 'bounced' | 'replied' | 'opened'
  repliedAt?: string
  bounceReason?: string
  recipientEmail?: string
  to?: string
  type?: string
  messageId?: string
  outboundMessageKey?: string
  customerId?: string
  replyCheckMode?: 'manual_zoho_login' | 'zoho_imap'
  followupDueAt?: string[]
  followupTasks?: Array<{ sequence: 1 | 2; dueAt: string; status: 'pending' | 'completed' | 'cancelled' }>
  historyEventKey?: string
  sourceCustomerId?: string
  sourceEvidence?: string
  contentAvailability?: 'available' | 'unavailable'
  contentUnavailableReason?: string
  bodySha256?: string
  originalRfcId?: string
  sourceQueueRecordId?: string
  zohoMessageId?: string
  receivedAt?: string
  inReplyTo?: string
  references?: string[]
  fromMasked?: string
  bouncedEmail?: string
  bounceType?: string
  bounceCode?: string
}

export interface EmailVerificationEvidence {
  email: string
  address?: string
  recipientEmail?: string
  result: string
  status?: string
  scope: 'format' | 'domain' | 'specific_email' | 'delivery'
  source: 'local' | 'dns_mx' | 'smtp' | 'isolated_test_mail' | 'imap' | 'snovio' | 'resend_history_backfill' | 'resend_history_backfill_inferred'
  method: string
  checkedAt: string
  sentAt?: string
  importedAt?: string
  resendEmailId?: string
  messageId?: string
  matchMethod?: 'recipientEmail'
  correlationId?: string
  note?: string
  observationStartedAt?: string
  observationEndedAt?: string
  testMessageId?: string
  testMailFromRole?: 'isolated_test_email' | 'primary_business_email' | 'unknown'
  returnPathEmailMasked?: string
  replyToEmailMasked?: string
  observationWindowStartedAt?: string
  observationWindowEndsAt?: string
  recoveryStatus?: 'not_started' | 'watching' | 'bounced' | 'replied' | 'no_bounce_observed' | 'unknown'
  recoveryCorrelationId?: string
  webhookEventId?: string
  webhookEventType?: string
}

export type EmailDisposition = 'accepted' | 'bounced' | 'invalid' | 'watching' | 'unverified'

export interface EmailDispositionLogEntry {
  email: string
  disposition: EmailDisposition
  reason?: string
  source?: string
  recordedAt: string
}

export type EmailVerificationQueue =
  | 'observation_queue'
  | 'retry_queue'
  | 'isolated_test_queue'
  | 'manual_confirmation'
  | 'unreachable'
  | 'draft_ready'
  | 'deferred'
  | 'replied_queue'
  | 'bounced_queue'
  | 'send_failed_queue'
  | 'do_not_contact'
  | 'auto_reply_queue'
  | 'unmatched_replies'

export interface EmailDispositionAuditEntry {
  email: string
  action: 'quarantine' | 'restore'
  reason: string
  actor: string
  commandId?: string
  previousDisposition: EmailDisposition
  nextDisposition: EmailDisposition
  recordedAt: string
}

export interface EmailVerificationRouting {
  email: string
  queue: EmailVerificationQueue
  reason: string
  updatedAt: string
  /** domain_mx_unknown 重试次数（applyDnsVerificationOutcome 打点；达到上限后写终态 unreachable） */
  dnsRetryCount?: number
}

export interface SnovioDomainSearchTask {
  provider: 'snovio'
  customerId: string
  domain: string
  taskId?: string
  statusUrl?: string
  resultUrl?: string
  requestedAt: string
  status: 'in_progress' | 'completed' | 'failed'
  lastPolledAt?: string
  rawResultStored: boolean
  creditsUnknown: boolean
  correlationId: string
}

export interface ContactReplacementRecord {
  replacedContactId: string
  replacementEmail: string
  reason: string
  source: 'snovio_found'
  replacedAt: string
}
export interface ManualEmailDraft {
  id: string
  campaignKey?: string
  companyName?: string
  to?: string
  recipientType?: string
  namedContact?: string
  forwardTo?: string
  subject: string
  body: string
  senderEmail?: string
  brand?: string
  language?: string
  status: 'pending_human_review' | 'approved' | 'superseded' | 'sent'
  sent: boolean
  rejectedAt?: string
  rejectedBy?: string
  rejectionReason?: string
  returnTarget?: 'backcheck_queue' | 'contact_mining_queue' | 'email_validation_queue' | 'replace_contact_queue' | 'paused_review' | 'true_excluded'
  rationale?: string
  manualChecks?: string[]
  version?: number
  createdAt?: string
  updatedAt?: string
  /** 人工确认（发送门禁 manual_confirmation_required 依赖该标记） */
  manualRiskConfirmed?: boolean
  manualRiskConfirmedAt?: string
  riskTier?: string
}

/** 主数据类型 */
export interface PipelineItem {
  id: string
  pipelineId: PipelineKey
  title: string
  currentStageId: string

  status: ItemStatus
  priority: Priority

  // 来源
  source: OutreachSource

  // 客户信息
  contactName: string
  company: string
  email: string
  selectedEmail?: string
  preferredEmail?: string
  phone: string
  country?: string
  website?: string
  snippet?: string

  // B2B 客户分级
  level: ClientLevel
  levelSource?: 'linkedin' | 'google' | 'manual'
  clientType: ClientType
  companySize?: string     // 直接员工数（如 "10-50"）
  leadGrade?: LeadGrade
  leadScore?: number
  leadScoreReasons?: string[]
  leadScoreUpdatedAt?: string
  displayTags?: string[]
  legacyTags?: string[]
  crmCompanyKey?: string
  crmMasterId?: string
  crmMergedInto?: string
  crmMergedIds?: string[]
  crmMergeReason?: string
  crmMergedAt?: string
  crmIdentityMethod?: 'domain' | 'company_country'
  crmIdentityStatus?: '已确认' | '待补充'
  crmIdentityReason?: string
  primaryStage?: string
  salesStage?: SalesStage
  salesStageHistory?: SalesStageHistoryEntry[]
  relationshipSummary?: string
  lastContactAt?: string
  lastInboundAt?: string
  lastOutboundAt?: string
  nextFollowupAt?: string
  nextAction?: string
  waitingFor?: WaitingFor
  owner?: string
  activeOpportunityId?: string
  communicationEvents?: CommunicationEvent[]
  opportunities?: Opportunity[]
  crmTasks?: CrmTask[]
  crmCommandLog?: CrmCommandAuditEntry[]
  crmUpdatedAt?: string

  // 邮箱验证
  emailVerification: EmailVerification
  emailVerificationEvidence?: EmailVerificationEvidence[]
  emailDispositionLog?: EmailDispositionLogEntry[]
  emailDispositionAudit?: EmailDispositionAuditEntry[]
  emailVerificationRouting?: EmailVerificationRouting[]
  replyQueue?: 'replied_queue' | 'bounced_queue' | 'auto_reply_queue' | 'unmatched_replies'
  replyObservedAt?: string
  zohoReplyEvidence?: Array<{
    messageId: string
    inReplyTo?: string
    references?: string[]
    fromEmail?: string
    fromMasked: string
    subject: string
    date: string
    textSummary: string
    classification: 'reply' | 'bounce' | 'auto_reply' | 'ignored'
    syncedAt: string
    fullBody?: string
  }>
  contactMiningRequired?: boolean
  contactMiningRequiredForEmail?: string
  currentEmailUseBlockedForEmail?: string
  emailVerificationCheckedAt?: string
  verificationScope?: 'domain_only' | 'specific_email'
  verificationSource?: string
  verificationMethod?: string
  verificationCheckedAt?: string
  specificEmailVerified?: boolean
  specificEmailVerifiedFor?: string
  emailReachability?: 'reachable' | 'unreachable' | 'unknown'
  doNotContactEmail?: boolean
  doNotContactEmails?: string[]
  smtpHandshakeStatus?: 'smtp_handshake_pass' | 'smtp_handshake_fail' | 'unknown'
  testMailStatus?: 'test_sent' | 'bounced_test' | 'no_bounce_observed' | 'reply_observed' | 'unknown'
  allowUnverifiedOutreach?: boolean
  unverifiedOutreachConfirmedAt?: string
  emailBounced: boolean

  // 背调数据
  backCheck?: BackCheckData
  backcheckStatus?: 'done' | 'pending' | 'incomplete'
  entityRole?: 'channel_buyer' | 'operator_buyer' | 'project_specifier' | 'manufacturer_partner' | 'non_buyer' | 'unknown'
  relationshipPotential?: 'channel_partner' | 'direct_buyer' | 'project_partner' | 'complementary_oem' | 'not_target' | 'needs_research'
  contactSuitability?: 'decision_maker' | 'relevant_department' | 'relevant_nondecision' | 'wrong_role' | 'public_or_location' | 'unknown'
  identityEvidenceConfidence?: 'verified' | 'probable' | 'weak'
  identityRecommendedAction?: 'follow_up_or_outreach' | 'contact_mining' | 'research_partner_fit' | 'backcheck' | 'exclude'
  identityReasons?: string[]
  identityClassifierVersion?: string
  identityClassifiedAt?: string

  // 开发状态
  developmentStatus?: 'pending' | 'new' | 'backcheck_done' | 'sent' | 'replied' | 'skipped' | 'shelved'
  formalDeliveryStatus?: string
  formalBounce?: boolean
  bouncedEmail?: string
  followupDueAt3d?: string
  followupDueAt7d?: string

  // 人工筛选漏斗：只标记，不删除原客户记录
  reviewDisposition?: 'active' | 'needs_recheck' | 'insufficient' | 'paused' | 'do_not_develop'
  reviewReason?: string
  reviewUpdatedAt?: string
  doNotDevelop?: boolean
  excludedAt?: string
  activeWorkflow?: boolean
  inactiveWorkflow?: boolean
  inactiveCategory?: 'permanent_do_not_develop' | 'irrelevant' | 'duplicate' | 'unreachable' | 'low_value_hold' | 'insufficient'
  inactiveReason?: string
  inactiveAt?: string
  duplicateOf?: string
  duplicateIndex?: boolean
  duplicateGroupId?: string
  canonicalLeadId?: string
  dataQualityIssues?: string[]
  normalizedStage?: string
  currentAllowedStage?: string
  nextRequiredAction?: string
  eligibilityBlockedReasons?: string[]
  eligibilityUpdatedAt?: string
  restoredReason?: string
  restoreReason?: string
  restoredAt?: string
  restoredBy?: string
  previousStage?: string
  operationalTier?:
    | 'priority_development'
    | 'standard_development'
    | 'public_email_outreach'
    | 'free_business_email_outreach'
    | 'low_priority_nurture'
    | 'data_enrichment_needed'
    | 'followup_queue'
    | 'replied_queue'
    | 'replace_contact_queue'
    | 'manual_review'
    | 'true_excluded'
  operationalTierReason?: string
  emailStrategy?: 'personal_company_email' | 'department_business_email' | 'public_email' | 'free_business_email' | 'none'
  currentEmailUseBlocked?: boolean
  requiredDraftStatus?: 'pending_human_review'
  outreachCopyStrategy?: 'request_forward_to_procurement_project_owner'
  reviewedBy?: string

  // 发信日志
  emailLogs?: EmailLog[]
  contentUnavailableHistory?: Array<{
    eventKey: string
    sentAt: string
    subject: string
    recipientEmail: string
    sourceCustomerId: string
    sourceQueueRecordId?: string
    reason?: string
  }>
  manualEmailDrafts?: ManualEmailDraft[]
  draftReviewReturn?: { draftId: string; returnTarget: 'backcheck_queue' | 'contact_mining_queue' | 'email_validation_queue' | 'replace_contact_queue' | 'paused_review' | 'true_excluded'; reasonCode: string; returnedAt: string; returnedBy: string; baselineContactSignature: string; baselineEvidenceCount: number; selectedEmail: string }
  draftReviewAudit?: Array<{ event: 'draft_rejected_for_rework'; draftId: string; returnTarget: string; reasonCode: string; actor: string; at: string }>
  snovioDomainSearchTasks?: SnovioDomainSearchTask[]
  contactReplacementLog?: ContactReplacementRecord[]

  // 报价信息
  quoteVersions?: QuoteVersion[]

  // 订单行
  orderLines?: OrderLine[]

  // 订单履约（报关/运输单证）
  orderFulfillment?: OrderFulfillment[]

  // 金额
  estimatedAmount?: number
  currency: string

  // 时间轴
  timeline: StageTransition[]
  createdAt: string
  updatedAt: string
  dueAt?: string

  // 业务线专属数据
  businessLine: BusinessLine
  carSeatData?: CarSeatData
  furnitureData?: FurnitureData

  // 备注和附件
  notes: Note[]
  attachments: Attachment[]
}






