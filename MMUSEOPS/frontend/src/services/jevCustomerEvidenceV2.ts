import type { PipelineItem } from '../types/item'
import type { CustomerEntityRole, CustomerIdentityAction } from './customerIdentity'
import { inferRoleFromJevEvidence, relationshipForRole, type JevVisibleEvidence } from './jevCustomerEvidence'

const text = (value: unknown): string => String(value ?? '').trim().toLowerCase()
const list = (value: unknown): any[] => Array.isArray(value) ? value : []

function exactPriorFormalSend(item: any): boolean {
  const email = text(item.selectedEmail || item.preferredEmail || item.email)
  return Boolean(email) && list(item.emailLogs).some(log =>
    text(log?.status) === 'sent'
    && text(log?.type) === 'formal_outreach'
    && text(log?.email || log?.recipientEmail || log?.to || log?.address) === email)
}

export function actionForJevRoleV2(role: CustomerEntityRole, item: PipelineItem): CustomerIdentityAction {
  if (role === 'non_buyer') return 'exclude'
  if (role === 'unknown') return 'backcheck'
  if (role === 'manufacturer_partner') return 'research_partner_fit'
  const contact = String((item as any).contactSuitability || '')
  if (contact === 'wrong_role') return 'contact_mining'
  if (exactPriorFormalSend(item)) return 'follow_up_or_outreach'
  if (contact === 'public_or_location' || contact === 'unknown') return 'contact_mining'
  return 'follow_up_or_outreach'
}

export function applyJevEvidenceV2(item: PipelineItem, evidence: JevVisibleEvidence, collectedAt: string, reportPath: string): PipelineItem {
  const inferred = inferRoleFromJevEvidence(evidence)
  const role = inferred === 'unknown' ? ((item as any).entityRole || 'unknown') as CustomerEntityRole : inferred
  const confidence = evidence.evidenceQuality === 'strong' ? 'verified' : evidence.evidenceQuality === 'partial' ? 'probable' : 'weak'
  return {
    ...item,
    entityRole: role,
    relationshipPotential: relationshipForRole(role),
    identityEvidenceConfidence: confidence,
    identityRecommendedAction: actionForJevRoleV2(role, item),
    identityReasons: [
      `record_nature:${String((item as any).recordNature || 'unknown')}`,
      `jev_entity_role:${role}`,
      `jev_evidence:${confidence}`,
      `jev_source:${String(evidence.finalUrl || evidence.sourceUrl || '')}`,
    ],
    identityClassifierVersion: 'customer-identity-jev-v2.1',
    identityClassifiedAt: collectedAt,
    jevResearchSourceUrl: String(evidence.finalUrl || evidence.sourceUrl || ''),
    jevResearchAt: collectedAt,
    jevEvidenceQuality: evidence.evidenceQuality,
    jevEvidenceReportPath: reportPath,
  } as PipelineItem
}
