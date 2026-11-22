/** 外贸单证多语言翻译 */

export type DocLanguage = 'zh' | 'en'

export const LANG_OPTIONS: { value: DocLanguage; label: string }[] = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
]

const ZH: Record<string, string> = {
  buyer: '买方',
  seller: '卖方',
  attn: '收件人',
  email: '邮箱',
  date: '日期',
  documentNo: '编号',
  product: '产品',
  model: '型号',
  quantity: '数量',
  unit: '单位',
  unitPrice: '单价',
  subtotal: '小计',
  total: '总计',
  tradeTerms: '贸易条款',
  shipping: '运输',
  notes: '备注',
  status: '状态',
  draft: '草稿',
  ready: '已就绪',
  basicInfo: '基本信息',
  products: '产品明细',
  payment: '收付款信息',
  shippingSection: '运输条款',
  package: '包装信息',
  transport: '运输工具',
  legal: '合同条款',
  insurance: '保险信息',
  certification: '原产地/认证',
  customs: '报关信息',
  incoterm: 'Incoterm',
  paymentTerm: '付款条件',
  portLoading: '起运港',
  portDischarge: '目的港',
  shippingMethod: '运输方式',
  hsCode: 'HS编码',
  originCountry: '原产地',
  bankInfo: '银行信息',
  bankName: '收款银行',
  bankAccount: '银行账号',
  swiftCode: 'Swift Code',
  bankAddress: '银行地址',
}

const EN: Record<string, string> = {
  buyer: 'Buyer',
  seller: 'Seller',
  attn: 'Attn',
  email: 'Email',
  date: 'Date',
  documentNo: 'No.',
  product: 'Product',
  model: 'Model',
  quantity: 'Qty',
  unit: 'Unit',
  unitPrice: 'Unit Price',
  subtotal: 'Subtotal',
  total: 'Total',
  tradeTerms: 'Trade Terms',
  shipping: 'Shipping',
  notes: 'Notes',
  status: 'Status',
  draft: 'Draft',
  ready: 'Ready',
  basicInfo: 'Basic Information',
  products: 'Products',
  payment: 'Payment',
  shippingSection: 'Shipping',
  package: 'Package',
  transport: 'Transport',
  legal: 'Terms & Conditions',
  insurance: 'Insurance',
  certification: 'Certification',
  customs: 'Customs',
  incoterm: 'Incoterm',
  paymentTerm: 'Payment Terms',
  portLoading: 'Port of Loading',
  portDischarge: 'Port of Discharge',
  shippingMethod: 'Shipping Method',
  hsCode: 'HS Code',
  originCountry: 'Origin',
  bankInfo: 'Bank Information',
  bankName: 'Bank Name',
  bankAccount: 'Account No.',
  swiftCode: 'Swift Code',
  bankAddress: 'Bank Address',
}

const LANG_MAP: Record<DocLanguage, Record<string, string>> = { zh: ZH, en: EN }

export function t(key: string, lang: DocLanguage = 'zh'): string {
  return LANG_MAP[lang]?.[key] || LANG_MAP.zh[key] || key
}

/** 英语国家列表用于自动建议语言 */
const ENGLISH_COUNTRIES = [
  'us', 'usa', 'united states', 'uk', 'united kingdom', 'britain', 'england',
  'canada', 'australia', 'new zealand', 'ireland', 'singapore',
  'south africa', 'india', 'philippines', 'nigeria', 'ghana',
  'malta', 'jamaica', 'trinidad', 'bahamas', 'barbados',
]

/** 根据买方国家建议语言 */
export function suggestLanguage(buyerCountry?: string): DocLanguage {
  if (!buyerCountry) return 'zh'
  const c = buyerCountry.toLowerCase().trim()
  if (ENGLISH_COUNTRIES.some(ec => c.includes(ec))) return 'en'
  return 'zh'
}
