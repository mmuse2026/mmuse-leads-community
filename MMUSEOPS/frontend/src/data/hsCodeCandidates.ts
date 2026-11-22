export interface HsCodeCandidate {
  category: '座椅类' | '木制家具' | '金属家具' | '办公家具' | '厨房家具' | '卧室家具' | '其他家具' | '家具零件'
  code: string
  nameCn: string
  nameEn: string
  suitableFor: string
  caution: string
  requiresFinalConfirmation: true
}

export const HS_CODE_DISCLAIMER = 'HS Code 需根据具体材质、用途、结构和目的国海关要求确认，系统仅提供候选，不作为最终报关依据。'

export const HS_CODE_CANDIDATES: HsCodeCandidate[] = [
  { category: '座椅类', code: '9401.61 / 9401.71', nameCn: '带软垫木框/金属框座椅', nameEn: 'Upholstered seats with wooden/metal frames', suitableFor: '餐椅、休闲椅、卡座等座椅产品', caution: '需区分框架材质、是否软垫、是否可转动及具体用途。', requiresFinalConfirmation: true },
  { category: '木制家具', code: '9403.60', nameCn: '其他木制家具', nameEn: 'Other wooden furniture', suitableFor: '木制桌、柜及未单列木家具', caution: '办公、厨房、卧室木家具可能有更具体子目。', requiresFinalConfirmation: true },
  { category: '金属家具', code: '9403.20', nameCn: '其他金属家具', nameEn: 'Other metal furniture', suitableFor: '金属桌、柜、架及复合金属家具', caution: '应按主要材质、结构和用途确认，不适用于座椅类。', requiresFinalConfirmation: true },
  { category: '办公家具', code: '9403.30', nameCn: '办公室用木家具', nameEn: 'Wooden furniture of a kind used in offices', suitableFor: '木制办公桌、文件柜等', caution: '非木制办公家具及座椅需选择其他候选。', requiresFinalConfirmation: true },
  { category: '厨房家具', code: '9403.40', nameCn: '厨房用木家具', nameEn: 'Wooden furniture of a kind used in kitchens', suitableFor: '木制橱柜及厨房家具', caution: '需确认材质、成套状态及是否含设备。', requiresFinalConfirmation: true },
  { category: '卧室家具', code: '9403.50', nameCn: '卧室用木家具', nameEn: 'Wooden furniture of a kind used in bedrooms', suitableFor: '木床、床头柜、衣柜等卧室家具', caution: '床垫、金属家具及零件另行归类。', requiresFinalConfirmation: true },
  { category: '其他家具', code: '9403.89', nameCn: '其他材料制家具', nameEn: 'Furniture of other materials', suitableFor: '藤、竹、塑料或复合材料等其他家具候选', caution: '不同税则版本的子目可能不同，需按材质核对。', requiresFinalConfirmation: true },
  { category: '家具零件', code: '9403.91 / 9403.99', nameCn: '家具零件', nameEn: 'Parts of furniture', suitableFor: '木制或其他家具专用零部件', caution: '完整或未组装家具不一定按零件申报；需确认材质与完整性。', requiresFinalConfirmation: true },
]

export interface SellerFields { company: string; address: string; contact: string; phone: string; email: string; taxId: string; bankInfo: string; notes: string }

function matchLine(text: string, labels: string[]): string {
  const escaped = labels.map(label => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  return text.match(new RegExp(`(?:^|\\n)\\s*(?:${escaped})\\s*[:：]\\s*([^\\n]+)`, 'i'))?.[1]?.trim() || ''
}

export function parseSellerText(text: string): SellerFields {
  return {
    company: matchLine(text, ['Company', '公司名', '公司名称', 'Seller']),
    address: matchLine(text, ['Address', '地址']),
    contact: matchLine(text, ['Contact', '联系人', 'Attn']),
    phone: matchLine(text, ['Tel', 'Phone', '电话', '手机']),
    email: matchLine(text, ['Email', 'E-mail', '邮箱']),
    taxId: matchLine(text, ['Tax ID', 'Tax No', '税号', '统一社会信用代码']),
    bankInfo: matchLine(text, ['Bank', 'Bank Info', '银行信息', '收款信息']),
    notes: matchLine(text, ['Notes', '备注']),
  }
}

interface AuditItem { product?: string; hsCode?: string; quantity?: number; unit?: string; unitPrice?: number }
interface AuditableDocument {
  buyer?: string; buyerAddress?: string; seller?: string; sellerAddress?: string; currency?: string; incoterm?: string; paymentTerm?: string
  portLoading?: string; portDischarge?: string; items?: AuditItem[]; docMeta?: Record<string, string>; type?: string
}

export function auditTradeDocument(doc: AuditableDocument): string[] {
  const issues: string[] = []
  if (!doc.buyer?.trim() || !doc.buyerAddress?.trim()) issues.push('买方信息缺失或不完整')
  if (!doc.seller?.trim() || !doc.sellerAddress?.trim()) issues.push('卖方信息缺失或不完整')
  if (!doc.items?.length) issues.push('产品明细缺失')
  for (const [index, item] of (doc.items || []).entries()) {
    const line = `第 ${index + 1} 行`
    if (!item.product?.trim()) issues.push(`${line}产品描述缺失`)
    if (!item.quantity || !item.unit?.trim()) issues.push(`${line}数量或单位缺失`)
    if (!item.unitPrice || item.unitPrice < 0) issues.push(`${line}单价或金额缺失/异常`)
    if (!item.hsCode?.trim()) issues.push(`${line} HS Code 缺失`)
    const text = item.product?.toLowerCase() || ''
    const code = item.hsCode?.replace(/\s/g, '') || ''
    if (/chair|seat|椅|座椅/.test(text) && code.startsWith('9403')) issues.push(`${line}产品疑似座椅，但 HS Code 为 9403 类，请人工核查`)
    if (/metal|steel|iron|金属|钢|铁/.test(text) && /^9403\.(3|4|5|6)/.test(code)) issues.push(`${line}描述含金属，但候选可能属于木家具子目，请人工核查`)
  }
  if (!doc.currency?.trim()) issues.push('币种缺失')
  if (!doc.incoterm?.trim()) issues.push('贸易条款缺失')
  if (!doc.paymentTerm?.trim()) issues.push('付款条款缺失')
  if (!doc.portLoading?.trim() || !doc.portDischarge?.trim()) issues.push('装运港或目的港缺失')
  if (!doc.docMeta?.deliveryDate && !doc.docMeta?.leadTime && !doc.docMeta?.validUntil) issues.push('交期/有效期缺失')
  return issues
}
