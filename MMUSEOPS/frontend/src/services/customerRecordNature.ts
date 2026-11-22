import type { PipelineItem } from '../types/item'

export type CustomerRecordNature =
  | 'customer_company'
  | 'company_page_candidate'
  | 'content_source'
  | 'directory_or_platform'
  | 'public_document'
  | 'unknown'

export interface CustomerRecordNatureDecision {
  recordNature: CustomerRecordNature
  resolutionStatus: 'resolved' | 'needs_resolution' | 'not_a_company_record'
  reasons: string[]
}

const text = (value: unknown): string => String(value ?? '').trim()
const lower = (value: unknown): string => text(value).toLowerCase()
const list = (value: unknown): any[] => Array.isArray(value) ? value : []
const CONTENT_HOST = /linkedin|facebook|instagram|youtube|pinterest|wikipedia|medium\.com|substack|news|blog/
const DIRECTORY_HOST = /yelp|yellowpages|tripadvisor|zoominfo|crunchbase|glassdoor|indeed|made-in-china|alibaba|hoteltechreport|onetonline/
const DOCUMENT_HOST = /\.gov(?:\.|$)|\.edu(?:\.|$)|documents\.|edocs\.|controller\.|courts\./
const CONTENT_TITLE = /\[pdf\]|opening reception|market intelligence|best .* stores|how to | on instagram|youtube|cruise:|application form|cheat sheet|agreement between|rfp\b|rfq\b/
const PRODUCT_TITLE = /\b\d+(?:-pack)?\b.*\b(chair|table|furniture|stool)|\b(chair|table|furniture|stool)\b.*\b(price|pack|steel|wood|blue|black|white)\b/

function urlHost(item: any): string {
  const raw = text(item.website || item.companyWebsite || item.officialWebsite || item.sourceUrl)
  if (!raw) return ''
  try { return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase() } catch { return '' }
}

function hasContactableIdentity(item: any): boolean {
  if (text(item.selectedEmail || item.preferredEmail || item.email)) return true
  return list(item.contacts).some(contact => text(contact?.email))
}

function hasFormalRelationship(item: any): boolean {
  return list(item.emailLogs).some(log => lower(log?.type) === 'formal_outreach' && lower(log?.status) === 'sent')
    || Boolean(text(item.formalReplyReceivedAt || item.lastReplyAt))
}

export function classifyCustomerRecordNature(item: PipelineItem): CustomerRecordNatureDecision {
  const any = item as any
  const company = lower(any.company || any.title)
  const website = lower(any.website || any.companyWebsite || any.officialWebsite || any.sourceUrl)
  const host = urlHost(any)
  const contactable = hasContactableIdentity(any)
  const relationship = hasFormalRelationship(any)
  const reasons: string[] = []

  if (relationship || contactable) {
    reasons.push(relationship ? 'formal_relationship_evidence' : 'contactable_company_identity')
    return { recordNature: 'customer_company', resolutionStatus: 'resolved', reasons }
  }
  if (/\.pdf(?:$|[?#])/.test(website) || company.startsWith('[pdf]') || (DOCUMENT_HOST.test(host) && CONTENT_TITLE.test(company))) {
    return { recordNature: 'public_document', resolutionStatus: 'not_a_company_record', reasons: ['document_or_public_file_result'] }
  }
  if (DIRECTORY_HOST.test(host)) {
    return { recordNature: 'directory_or_platform', resolutionStatus: 'not_a_company_record', reasons: ['directory_or_platform_host'] }
  }
  if (CONTENT_HOST.test(host) || CONTENT_TITLE.test(company)) {
    return { recordNature: 'content_source', resolutionStatus: 'not_a_company_record', reasons: ['content_page_or_title'] }
  }
  if (PRODUCT_TITLE.test(company)) {
    return { recordNature: 'content_source', resolutionStatus: 'not_a_company_record', reasons: ['product_page_title_without_company_identity'] }
  }
  if (host) {
    return { recordNature: 'company_page_candidate', resolutionStatus: 'needs_resolution', reasons: ['business_domain_without_contact_identity'] }
  }
  return { recordNature: 'unknown', resolutionStatus: 'needs_resolution', reasons: ['insufficient_entity_evidence'] }
}

export function stampCustomerRecordNature(item: PipelineItem, now = new Date()): PipelineItem {
  const decision = classifyCustomerRecordNature(item)
  return {
    ...item,
    recordNature: decision.recordNature,
    entityResolutionStatus: decision.resolutionStatus,
    recordNatureReasons: decision.reasons,
    recordNatureClassifierVersion: 'customer-record-nature-v1',
    recordNatureClassifiedAt: now.toISOString(),
  } as PipelineItem
}
