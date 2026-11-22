import type { PipelineItem } from '../types/item'

export type CustomerEntityRole =
  | 'channel_buyer'
  | 'operator_buyer'
  | 'project_specifier'
  | 'manufacturer_partner'
  | 'non_buyer'
  | 'unknown'

export type RelationshipPotential =
  | 'channel_partner'
  | 'direct_buyer'
  | 'project_partner'
  | 'complementary_oem'
  | 'not_target'
  | 'needs_research'

export type ContactSuitability =
  | 'decision_maker'
  | 'relevant_department'
  | 'relevant_nondecision'
  | 'wrong_role'
  | 'public_or_location'
  | 'unknown'

export type CustomerIdentityAction =
  | 'follow_up_or_outreach'
  | 'contact_mining'
  | 'research_partner_fit'
  | 'backcheck'
  | 'exclude'

export interface CustomerIdentityDecision {
  entityRole: CustomerEntityRole
  relationshipPotential: RelationshipPotential
  contactSuitability: ContactSuitability
  evidenceConfidence: 'verified' | 'probable' | 'weak'
  action: CustomerIdentityAction
  reasons: string[]
}

const text = (value: unknown): string => String(value ?? '').trim()
const lower = (value: unknown): string => text(value).toLowerCase()
const list = (value: unknown): any[] => Array.isArray(value) ? value : []

const NON_BUYER = /directory|news|publisher|media company|market.?research|data.?platform|job board|forum|stock photo|trade association|industry association|automotive parts|unrelated|government notice|wikipedia/
const PROJECT = /fit.?out|ff&e|project procurement|procurement consultant|interior design|architect|specifier|contractor|design procurement/
const CHANNEL = /distribut|wholesal|importer|dealer|retailer|ecommerce|restaurant supplier|hospitality supplier|equipment distributor|trade supplier|procurement\/gpo/
const OPERATOR = /hotel|resort|restaurant|cafe|coffee|bar|casino|banquet|event venue|food.?service operator|senior living|hospitality group|operator/
const MANUFACTURER = /manufacturer|factory|furniture brand|export supplier|production|fabricator/
const WRONG_ROLE = /human resources|\bhr\b|social media|marketing|public relations|\bpr\b|media|journalist|recruit|career|reservation|hostess?|customer service|webmaster|it support/
const DECISION_ROLE = /procure|purchas|sourc|category|buyer|product manager|owner|founder|chief executive|\bceo\b|managing director|general manager|commercial director|supply chain|ff&e|project director|project manager|development director|facilities director|operations director/
const RELEVANT_ROLE = /design|architect|project|operations|facilit|engineering|construction|property|asset|food.?and.?beverage|f&b|commercial|sales director/
const PUBLIC_LOCAL = /^(info|contact|hello|office|admin|support|service|customerservice|enquir(?:y|ies)|reservations?|events?|host|reception|careers?|marketing|media|pr|social|webmaster|sales)\b/
const DEPARTMENT_LOCAL = /^(buying|buyer|purchasing|procurement|sourcing|projects?|commercial|trade|contract|wholesale|vendor|suppliers?|category|ff?e)\b/

function evidenceText(item: any): string {
  return lower([
    item.customerType,
    item.customerTypeAssessment,
    item.clientType,
    item.company,
    item.title,
    item.industry,
    item.evidenceSummary,
    item.researchSummary,
    item.backgroundSummary,
    item.backCheck?.summary,
    item.backcheck?.summary,
    ...list(item.mainProducts),
    ...list(item.backCheck?.products),
    ...list(item.backcheck?.mainProducts),
  ].filter(Boolean).join(' '))
}

function explicitType(item: any): string {
  return lower(item.customerType || item.customerTypeAssessment || item.clientType)
}

function classifyEntity(item: any, evidence: string): CustomerEntityRole {
  const type = explicitType(item)
  if (NON_BUYER.test(type) || (NON_BUYER.test(evidence) && !CHANNEL.test(type) && !OPERATOR.test(type) && !PROJECT.test(type))) return 'non_buyer'
  if (PROJECT.test(type) || PROJECT.test(evidence)) return 'project_specifier'
  if (CHANNEL.test(type)) return 'channel_buyer'
  if (OPERATOR.test(type)) return 'operator_buyer'
  if (MANUFACTURER.test(type)) return 'manufacturer_partner'
  if (CHANNEL.test(evidence)) return 'channel_buyer'
  if (OPERATOR.test(evidence)) return 'operator_buyer'
  if (MANUFACTURER.test(evidence)) return 'manufacturer_partner'
  return 'unknown'
}

function selectedContact(item: any): { title: string; email: string } {
  const selectedEmail = lower(item.selectedEmail || item.preferredEmail || item.email)
  const contacts = list(item.contacts)
  const selected = contacts.find(contact => lower(contact?.email) === selectedEmail) || {}
  return {
    title: lower(selected.title || selected.jobTitle || item.contactTitle || item.jobTitle),
    email: selectedEmail,
  }
}

function classifyContact(item: any): ContactSuitability {
  const contact = selectedContact(item)
  if (WRONG_ROLE.test(contact.title)) return 'wrong_role'
  if (DECISION_ROLE.test(contact.title)) return 'decision_maker'
  if (RELEVANT_ROLE.test(contact.title)) return 'relevant_nondecision'
  if (!contact.email) return 'unknown'
  const local = contact.email.split('@')[0]
  if (DEPARTMENT_LOCAL.test(local)) return 'relevant_department'
  if (PUBLIC_LOCAL.test(local)) return 'public_or_location'
  return contact.title ? 'relevant_nondecision' : 'unknown'
}

function hasExactPriorFormalSend(item: any): boolean {
  const selectedEmail = lower(item.selectedEmail || item.preferredEmail || item.email)
  if (!selectedEmail) return false
  return list(item.emailLogs).some(log =>
    lower(log?.status) === 'sent'
    && lower(log?.type) === 'formal_outreach'
    && lower(log?.email || log?.recipientEmail || log?.to || log?.address) === selectedEmail)
}

function confidence(item: any): CustomerIdentityDecision['evidenceConfidence'] {
  const sources = list(item.backcheckSources)
  const hasWebsite = Boolean(text(item.website))
  const hasFreshReview = Boolean(text(item.backcheckFreshVerifiedAt || item.detailedBackcheckAt))
  const summary = text(item.evidenceSummary || item.backCheck?.summary || item.backcheck?.summary)
  if (hasWebsite && hasFreshReview && (sources.length > 0 || summary.length >= 80)) return 'verified'
  if (hasWebsite && summary.length >= 40) return 'probable'
  return 'weak'
}

export function classifyCustomerIdentity(item: PipelineItem): CustomerIdentityDecision {
  const any = item as any
  const evidence = evidenceText(any)
  const entityRole = classifyEntity(any, evidence)
  const contactSuitability = classifyContact(any)
  const evidenceConfidence = confidence(any)
  const relationshipPotential: RelationshipPotential = entityRole === 'channel_buyer'
    ? 'channel_partner'
    : entityRole === 'operator_buyer'
      ? 'direct_buyer'
      : entityRole === 'project_specifier'
        ? 'project_partner'
        : entityRole === 'manufacturer_partner'
          ? 'complementary_oem'
          : entityRole === 'non_buyer'
            ? 'not_target'
            : 'needs_research'

  let action: CustomerIdentityAction
  if (entityRole === 'non_buyer') action = 'exclude'
  else if (entityRole === 'unknown' || evidenceConfidence === 'weak') action = 'backcheck'
  else if (entityRole === 'manufacturer_partner') action = 'research_partner_fit'
  else if (contactSuitability !== 'wrong_role' && hasExactPriorFormalSend(any)) action = 'follow_up_or_outreach'
  else if (contactSuitability === 'wrong_role' || contactSuitability === 'public_or_location' || contactSuitability === 'unknown') action = 'contact_mining'
  else action = 'follow_up_or_outreach'

  const reasons = [
    `entity_role:${entityRole}`,
    `relationship:${relationshipPotential}`,
    `contact:${contactSuitability}`,
    `evidence:${evidenceConfidence}`,
  ]
  return { entityRole, relationshipPotential, contactSuitability, evidenceConfidence, action, reasons }
}

export function stampCustomerIdentity(item: PipelineItem, now = new Date()): PipelineItem {
  const decision = classifyCustomerIdentity(item)
  return {
    ...item,
    entityRole: decision.entityRole,
    relationshipPotential: decision.relationshipPotential,
    contactSuitability: decision.contactSuitability,
    identityEvidenceConfidence: decision.evidenceConfidence,
    identityRecommendedAction: decision.action,
    identityReasons: decision.reasons,
    identityClassifierVersion: 'customer-identity-v1',
    identityClassifiedAt: now.toISOString(),
  }
}