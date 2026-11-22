import type { PipelineItem } from '../types/item'
import type { CustomerEntityRole, CustomerIdentityAction, RelationshipPotential } from './customerIdentity'

export interface JevVisibleEvidence {
  finalUrl?: string
  sourceUrl?: string
  visibleText?: string
  evidenceQuality?: 'strong' | 'partial' | 'insufficient'
}

const PROJECT = /\b(ff&e|fit[- ]?out|interior design|architect(?:ure|ural)?|project procurement|procurement consultant|design and build|project management|specifier)\b/i
const CHANNEL = /\b(distribut(?:or|ion)|wholesal(?:e|er)|dealer|retail(?:er)?|hospitality supplier|restaurant supplier|foodservice supplier|procurement distributor|supply chain partner|source and supply|vendors?)\b/i
const MANUFACTURER = /\b(manufactur(?:e|er|ing)|factory|fabricat(?:e|or|ion)|made in our|production facilit|handcrafted|custom furniture maker)\b/i
const OPERATOR = /\b(hotel group|hotel operator|hospitality group|we operate|we manage hotels|our hotels|our restaurants|restaurant group|resort group|portfolio of hotels|hotel brands)\b/i
const NONBUYER = /\b(directory|market intelligence|news publisher|job board|public document|government form|social media platform)\b/i

export function inferRoleFromJevEvidence(evidence: JevVisibleEvidence): CustomerEntityRole {
  const value = String(evidence.visibleText || '')
  if (!value.trim() || evidence.evidenceQuality === 'insufficient') return 'unknown'
  if (NONBUYER.test(value)) return 'non_buyer'
  if (PROJECT.test(value)) return 'project_specifier'
  if (CHANNEL.test(value)) return 'channel_buyer'
  if (MANUFACTURER.test(value)) return 'manufacturer_partner'
  if (OPERATOR.test(value)) return 'operator_buyer'
  return 'unknown'
}

export function relationshipForRole(role: CustomerEntityRole): RelationshipPotential {
  return role === 'channel_buyer' ? 'channel_partner'
    : role === 'operator_buyer' ? 'direct_buyer'
      : role === 'project_specifier' ? 'project_partner'
        : role === 'manufacturer_partner' ? 'complementary_oem'
          : role === 'non_buyer' ? 'not_target' : 'needs_research'
}

export function actionForJevRole(role: CustomerEntityRole, item: PipelineItem): CustomerIdentityAction {
  if (role === 'non_buyer') return 'exclude'
  if (role === 'unknown') return 'backcheck'
  if (role === 'manufacturer_partner') return 'research_partner_fit'
  const contact = String((item as any).contactSuitability || '')
  if (contact === 'wrong_role' || contact === 'public_or_location' || contact === 'unknown') return 'contact_mining'
  return 'follow_up_or_outreach'
}

export function applyJevEvidence(item: PipelineItem, evidence: JevVisibleEvidence, collectedAt: string, reportPath: string): PipelineItem {
  const inferred = inferRoleFromJevEvidence(evidence)
  const role = inferred === 'unknown' ? ((item as any).entityRole || 'unknown') as CustomerEntityRole : inferred
  const confidence = evidence.evidenceQuality === 'strong' ? 'verified' : evidence.evidenceQuality === 'partial' ? 'probable' : 'weak'
  return {
    ...item,
    entityRole: role,
    relationshipPotential: relationshipForRole(role),
    identityEvidenceConfidence: confidence,
    identityRecommendedAction: actionForJevRole(role, item),
    identityReasons: [
      `record_nature:${String((item as any).recordNature || 'unknown')}`,
      `jev_entity_role:${role}`,
      `jev_evidence:${confidence}`,
      `jev_source:${String(evidence.finalUrl || evidence.sourceUrl || '')}`,
    ],
    identityClassifierVersion: 'customer-identity-jev-v2',
    identityClassifiedAt: collectedAt,
    jevResearchSourceUrl: String(evidence.finalUrl || evidence.sourceUrl || ''),
    jevResearchAt: collectedAt,
    jevEvidenceQuality: evidence.evidenceQuality,
    jevEvidenceReportPath: reportPath,
  } as PipelineItem
}
