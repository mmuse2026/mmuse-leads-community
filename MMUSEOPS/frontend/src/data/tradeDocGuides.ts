import type { DocumentType } from '../types/item'

export interface TradeDocGuide {
  purpose: string
  checks: string[]
  risks: string[]
}

const COMMON_RISKS = [
  'Buyer, seller, product name, quantity, amount and currency must match across documents.',
  'Custom furniture descriptions should include material, size, color, structure and intended use.',
  'For high-risk customs or payment markets, confirm HS code, consignee and payment timing before shipment.',
]

export const TRADE_DOC_GUIDES: Record<DocumentType, TradeDocGuide> = {
  quotation: {
    purpose: 'First offer used to confirm price, scope and trade basis.',
    checks: ['Validity period', 'Incoterm and loading port', 'MOQ/sample fee', 'Production lead time', 'Customization scope', 'HS code candidate requires final confirmation'],
    risks: ['Do not quote DDP/CIF without checking freight, duty and delivery risk.', 'Separate tooling, sample and packaging costs when needed.'],
  },
  contract: {
    purpose: 'Main agreement for buyer, seller, specs, payment and delivery responsibility.',
    checks: ['Full legal names', 'Product specs and drawings', 'Payment terms', 'Delivery date', 'Dispute clause'],
    risks: ['Avoid vague wording such as same as sample without photos/spec attachments.', 'For custom furniture, confirm final drawings before production.'],
  },
  proforma_invoice: {
    purpose: 'Payment request and order confirmation before production.',
    checks: ['Bank details', 'Deposit/final payment split', 'HS code candidate and product match', 'Currency', 'Beneficiary name'],
    risks: ['Bank beneficiary must match seller entity.', 'Prefer balance before shipment or before B/L release for new buyers.'],
  },
  commercial_invoice: {
    purpose: 'Customs and payment document issued for shipment.',
    checks: ['Invoice value', 'Product description', 'Currency', 'Origin', 'Buyer/seller info', 'HS code candidate requires final confirmation'],
    risks: ['Invoice value should not conflict with contract, packing list or payment records.', 'Unclear descriptions can delay customs clearance.'],
  },
  packing_list: {
    purpose: 'Packing details for customs, freight forwarder and buyer receiving.',
    checks: ['Carton count', 'Gross/net weight', 'CBM', 'Marks', 'Package dimensions'],
    risks: ['Furniture volume/weight errors can cause freight disputes.', 'Packing list must match actual loading photos and invoice items.'],
  },
  bill_of_lading: {
    purpose: 'Transport title/receipt used for cargo release.',
    checks: ['Shipper/consignee/notify', 'POL/POD', 'Freight prepaid/collect', 'Original or telex release', 'Final destination'],
    risks: ['Do not release original B/L or telex release before safe payment unless approved.', 'Consignee mistakes can block cargo release.'],
  },
  customs_declaration: {
    purpose: 'Export customs declaration basis.',
    checks: ['HS code', 'Declared value', 'Material', 'Usage', 'Brand/model'],
    risks: ['Wrong HS code or material can trigger inspection, fines or clearance delay.', 'Keep declaration consistent with CI and PL.'],
  },
  certificate_of_origin: {
    purpose: 'Proof of origin used for buyer customs and tariff preference.',
    checks: ['Origin country', 'Exporter/consignee', 'Invoice number', 'Product description', 'Issuing body'],
    risks: ['Origin and exporter information must match invoice and shipment documents.', 'Check whether buyer needs Form E, FTA or ordinary C/O.'],
  },
  insurance: {
    purpose: 'Cargo insurance proof for CIF or buyer-required shipment.',
    checks: ['Insured amount', 'Cargo description', 'Route', 'Coverage type', 'Beneficiary'],
    risks: ['CIF usually requires insurance; FOB/EXW may be buyer responsibility.', 'Insurance amount often needs invoice value plus markup.'],
  },
  export_license: {
    purpose: 'Export control or regulated-goods permit when required.',
    checks: ['Product category', 'HS code', 'Regulatory requirement', 'Exporter qualification', 'Validity date'],
    risks: ['Do not promise shipment date until license requirement is confirmed.', 'Most furniture is normal cargo, but special materials may need extra checks.'],
  },
  other: {
    purpose: 'Extra document for buyer, bank, customs or logistics request.',
    checks: ['Who requested it', 'Required fields', 'Deadline', 'Relation to main documents', 'Approval owner'],
    risks: COMMON_RISKS,
  },
}

export function getTradeDocGuide(type: string): TradeDocGuide {
  if (type.startsWith('custom:')) {
    return {
      purpose: 'Custom document requested by buyer, bank, customs or logistics partner.',
      checks: ['Requester', 'Required fields', 'Deadline', 'Data source', 'Approval owner'],
      risks: COMMON_RISKS,
    }
  }
  return TRADE_DOC_GUIDES[type as DocumentType] || TRADE_DOC_GUIDES.other
}

