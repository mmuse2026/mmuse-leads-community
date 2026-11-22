import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { DOCUMENT_LABELS } from '../types/item'
import type { DocumentType } from '../types/item'
import { loadProfile } from '../store/userProfile'
import { DOC_TEMPLATES, ALL_SECTIONS, getDocTemplate, loadCustomDocTypes, saveCustomDocTypes, suggestNextStep } from '../data/docTemplates'
import type { CustomDocType } from '../data/docTemplates'
import { getTradeDocGuide } from '../data/tradeDocGuides'
import { HS_CODE_CANDIDATES, HS_CODE_DISCLAIMER, auditTradeDocument, parseSellerText } from '../data/hsCodeCandidates'
import { smartFill, type SmartFillResult } from '../services/smartFill'
import { t, type DocLanguage, LANG_OPTIONS, suggestLanguage } from '../i18n/tradeDocTranslations'

// ======================== Types ========================

export interface DocumentItem {
  id: string
  product: string
  model: string
  hsCode: string
  quantity: number
  unit: string
  unitPrice: number
  originCountry: string
  imageUrl?: string
}

export interface TradeDocument {
  id: string
  type: string   // DocumentType | "custom:xxx"
  title: string
  number: string
  issueDate: string
  buyer: string
  buyerAddress: string
  buyerContact: string
  buyerEmail: string
  seller: string
  sellerAddress: string
  sellerContact: string
  sellerEmail: string
  currency: string
  incoterm: string
  paymentTerm: string
  shippingMethod: string
  portLoading: string
  portDischarge: string
  items: DocumentItem[]
  notes: string
  status: 'draft' | 'ready'
  createdAt: string
  updatedAt: string
  /** 语言 */
  lang: DocLanguage
  /** 各单证类型的专属字段（如包装信息、运输工具、保险等） */
  docMeta: Record<string, string>
}

// ======================== Constants ========================

const STORAGE_KEY = 'mmuse_trade_documents'
const SELLER_PROFILE_KEY = 'mmuse_trade_seller_profile'

const DEFAULTS = {
  seller: 'MMUSEOPS Trading Co., Ltd.',
  sellerAddress: 'Tianjin, China',
  currency: 'USD',
  incoterm: 'FOB',
  paymentTerm: '30% T/T deposit, 70% before shipment',
  shipping: 'Sea freight',
  portLoading: 'Tianjin, China',
  portDischarge: '',
  unit: 'PCS',
  origin: 'China',
}

const COMMON_INCOTERMS = ['FOB', 'CIF', 'EXW', 'DDP', 'FCA', 'CPT', 'CIP', 'DAP', 'FAS', 'CFR']

/** 旧数据兼容：PI → proforma_invoice 等映射 */
const LEGACY_TYPE_MAP: Record<string, DocumentType> = {
  PI: 'proforma_invoice',
  CI: 'commercial_invoice',
  PL: 'packing_list',
}

/** 默认编号前缀 */
const DEFAULT_PREFIXES: Record<string, string> = {
  quotation: 'QTN',
  contract: 'SC',
  proforma_invoice: 'PI',
  commercial_invoice: 'CI',
  packing_list: 'PL',
  bill_of_lading: 'BL',
  customs_declaration: 'CD',
  certificate_of_origin: 'CO',
  insurance: 'INS',
  export_license: 'EL',
  other: 'DOC',
}

interface NumberingRule {
  prefix: string
  nextSeq: number
}

const NUMBERING_KEY = 'mmuse_doc_numbering'

function loadNumberingRules(): Record<string, NumberingRule> {
  try {
    const raw = localStorage.getItem(NUMBERING_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}

function saveNumberingRules(rules: Record<string, NumberingRule>) {
  localStorage.setItem(NUMBERING_KEY, JSON.stringify(rules))
}

function getNextNumber(type: string): string {
  const rules = loadNumberingRules()
  const prefix = rules[type]?.prefix || DEFAULT_PREFIXES[type] || 'DOC'
  const seq = rules[type]?.nextSeq || 1
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  // 更新序号
  rules[type] = { prefix, nextSeq: seq + 1 }
  saveNumberingRules(rules)
  return `${prefix}-${date}-${String(seq).padStart(3, '0')}`
}

/** 所有支持的单证类型（按业务顺序） */
const ALL_DOC_TYPES: DocumentType[] = [
  'quotation', 'proforma_invoice', 'contract', 'commercial_invoice',
  'packing_list', 'bill_of_lading', 'customs_declaration',
  'certificate_of_origin', 'insurance', 'other',
]

const TAB_COLORS: Record<string, string> = {
  quotation: 'bg-emerald-600',
  contract: 'bg-blue-600',
  proforma_invoice: 'bg-indigo-600',
  commercial_invoice: 'bg-purple-600',
  packing_list: 'bg-amber-600',
  bill_of_lading: 'bg-cyan-600',
  customs_declaration: 'bg-red-600',
  certificate_of_origin: 'bg-orange-600',
  insurance: 'bg-pink-600',
  export_license: 'bg-teal-600',
  other: 'bg-surface-500',
}

// ======================== Helpers ========================

function loadAll(): TradeDocument[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const docs: TradeDocument[] = JSON.parse(raw)
    // 旧数据迁移：PI/CI/PL → 完整类型名
    return docs.map(d => ({
      ...d,
      type: LEGACY_TYPE_MAP[d.type] || d.type,
    }))
  } catch {
    return []
  }
}

function saveAll(docs: TradeDocument[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(docs))
}
interface SavedSellerProfile {
  company: string; address: string; contact: string; phone: string; email: string; bankInfo: string; taxId: string; notes: string
}

function loadSellerProfile(): SavedSellerProfile | null {
  try {
    const raw = localStorage.getItem(SELLER_PROFILE_KEY)
    return raw ? JSON.parse(raw) as SavedSellerProfile : null
  } catch { return null }
}

function sellerProfileFromDoc(doc: TradeDocument): SavedSellerProfile {
  return { company: doc.seller, address: doc.sellerAddress, contact: doc.sellerContact, phone: doc.docMeta.sellerPhone || '', email: doc.sellerEmail, bankInfo: doc.docMeta.bankInfo || [doc.docMeta.bankName, doc.docMeta.bankAccount, doc.docMeta.swiftCode, doc.docMeta.bankAddress].filter(Boolean).join(' | '), taxId: doc.docMeta.taxId || '', notes: doc.docMeta.sellerNotes || '' }
}

function fmtCurrency(amount: number, currency: string = 'USD'): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
    }).format(amount)
  } catch {
    return `${currency} ${amount.toFixed(2)}`
  }
}

function fmtDate(dateStr: string): string {
  if (!dateStr) return '-'
  try {
    return new Date(dateStr).toLocaleDateString('zh-CN')
  } catch {
    return dateStr
  }
}

function calcTotal(items: DocumentItem[]): number {
  return items.reduce((s, i) => s + (i.quantity || 0) * (i.unitPrice || 0), 0)
}

function emptyItem(): DocumentItem {
  return {
    id: crypto.randomUUID(),
    product: '',
    model: '',
    hsCode: '',
    quantity: 1,
    unit: DEFAULTS.unit,
    unitPrice: 0,
    originCountry: DEFAULTS.origin,
  }
}

function createDefaultDoc(type: string): TradeDocument {
  const now = new Date().toISOString()
  const profile = loadProfile()
  const savedSeller = loadSellerProfile()
  return {
    id: crypto.randomUUID(),
    type,
    title: '',
    number: '',
    issueDate: now.slice(0, 10),
    buyer: '',
    buyerAddress: '',
    buyerContact: '',
    buyerEmail: '',
    seller: savedSeller?.company || DEFAULTS.seller,
    sellerAddress: savedSeller?.address || DEFAULTS.sellerAddress,
    sellerContact: savedSeller?.contact || '',
    sellerEmail: savedSeller?.email || '',
    currency: DEFAULTS.currency,
    incoterm: DEFAULTS.incoterm,
    paymentTerm: DEFAULTS.paymentTerm,
    shippingMethod: DEFAULTS.shipping,
    portLoading: DEFAULTS.portLoading,
    portDischarge: DEFAULTS.portDischarge,
    items: [emptyItem()],
    notes: '',
    lang: 'zh',
    status: 'draft',
    createdAt: now,
    updatedAt: now,
    docMeta: {
      ...(savedSeller?.phone && { sellerPhone: savedSeller.phone }),
      ...(savedSeller?.bankInfo && { bankInfo: savedSeller.bankInfo }),
      ...(savedSeller?.taxId && { taxId: savedSeller.taxId }),
      ...(savedSeller?.notes && { sellerNotes: savedSeller.notes }),
      ...(profile.bankName && { bankName: profile.bankName }),
      ...(profile.bankAccount && { bankAccount: profile.bankAccount }),
      ...(profile.swiftCode && { swiftCode: profile.swiftCode }),
      ...(profile.bankAddress && { bankAddress: profile.bankAddress }),
    },
  }
}

/** 根据类型获取显示名称（支持内置和自定义类型） */
function getDocLabel(type: string): string {
  if (type.startsWith('custom:')) return type.replace('custom:', '')
  return DOCUMENT_LABELS[type as DocumentType] || type
}

// ======================== Sub Components ========================

function TypeBadge({ type }: { type: string }) {
  const colors: Record<string, string> = {
    quotation: 'text-emerald-700 bg-emerald-50 border-emerald-200',
    contract: 'text-blue-700 bg-blue-50 border-blue-200',
    proforma_invoice: 'text-indigo-700 bg-indigo-50 border-indigo-200',
    commercial_invoice: 'text-purple-700 bg-purple-50 border-purple-200',
    packing_list: 'text-amber-700 bg-amber-50 border-amber-200',
    bill_of_lading: 'text-cyan-700 bg-cyan-50 border-cyan-200',
    customs_declaration: 'text-red-700 bg-red-50 border-red-200',
    certificate_of_origin: 'text-orange-700 bg-orange-50 border-orange-200',
    insurance: 'text-pink-700 bg-pink-50 border-pink-200',
    export_license: 'text-teal-700 bg-teal-50 border-teal-200',
    other: 'text-surface-500 bg-surface-100 border-surface-200',
  }
  return (
    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded border ${colors[type] || 'bg-surface-100 text-surface-500'}`}>
      {getDocLabel(type)}
    </span>
  )
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'ready') {
    return (
      <span className="text-[10px] font-semibold px-2 py-0.5 rounded border text-emerald-700 bg-emerald-50 border-emerald-200">
        已就绪
      </span>
    )
  }
  return (
    <span className="text-[10px] font-semibold px-2 py-0.5 rounded border text-amber-700 bg-amber-50 border-amber-200">
      草稿
    </span>
  )
}

function FilterBtn({ label, count, active, color, onClick }: {
  label: string; count: number; active: boolean; color: string; onClick: () => void
}) {
  return (
    <button onClick={onClick}
      className={`text-xs font-semibold px-3 py-1.5 rounded-lg border transition-all cursor-pointer font-inherit ${
        active
          ? `${color} text-white border-transparent`
          : 'bg-surface-100 text-surface-500 border-surface-200 hover:bg-surface-200'
      }`}>
      {label} {count}
    </button>
  )
}

function DocumentCard({ doc, onEdit, onDelete, onDuplicate, onExport }: {
  doc: TradeDocument; onEdit: () => void; onDelete: () => void; onDuplicate: () => void; onExport: () => void
}) {
  const total = calcTotal(doc.items)
  return (
    <div className="bg-surface-0 border border-surface-200 rounded-xl p-4 hover:border-surface-300 hover:shadow-sm transition-all">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {/* Top row: badges + number + date */}
          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
            <TypeBadge type={doc.type} />
            {doc.lang && doc.lang !== 'zh' && (
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded border border-blue-200 text-blue-500 bg-blue-50">EN</span>
            )}
            <span className="text-sm font-bold text-surface-900">{doc.number || '-'}</span>
            <StatusBadge status={doc.status} />
            <span className="text-[11px] text-surface-400 ml-auto">{fmtDate(doc.issueDate)}</span>
          </div>
          {/* Buyer */}
          <p className="text-sm text-surface-700 truncate">
            <span className="text-surface-400 text-xs">买方 </span>
            {doc.buyer || '-'}
          </p>
          {/* Total */}
          <p className="text-xs text-surface-500 mt-1">
            <span className="font-semibold text-surface-700">{fmtCurrency(total, doc.currency)}</span>
            {total > 0 && doc.items.length > 0 && (
              <span className="text-surface-400 ml-2">· {doc.items.length} 项产品</span>
            )}
          </p>
          {/* Title */}
          {doc.title && (
            <p className="text-[11px] text-surface-400 mt-0.5 truncate">{doc.title}</p>
          )}
        </div>
        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0">
          <button onClick={onEdit}
            className="text-xs font-medium px-2.5 py-1.5 rounded-lg border border-surface-200 text-surface-500 hover:text-surface-700 hover:border-surface-400 bg-transparent cursor-pointer font-inherit transition-colors">
            编辑
          </button>
          <button onClick={onExport}
            className="text-xs font-medium px-2.5 py-1.5 rounded-lg border border-surface-200 text-surface-500 hover:text-surface-700 hover:border-surface-400 bg-transparent cursor-pointer font-inherit transition-colors">
            导出
          </button>
          <button onClick={onDuplicate}
            className="text-xs font-medium px-2.5 py-1.5 rounded-lg border border-surface-200 text-surface-500 hover:text-surface-700 hover:border-surface-400 bg-transparent cursor-pointer font-inherit transition-colors">
            复制
          </button>
          <button onClick={onDelete}
            className="text-xs font-medium px-2.5 py-1.5 rounded-lg border border-red-200 text-red-400 hover:text-red-600 hover:border-red-400 bg-transparent cursor-pointer font-inherit transition-colors">
            删除
          </button>
        </div>
      </div>
    </div>
  )
}

function FormSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-surface-200 pb-5 mb-5">
      <h3 className="text-xs font-bold text-surface-500 uppercase tracking-wider mb-3">{title}</h3>
      {children}
    </div>
  )
}

function FormField({ label, children, required }: { label: string; children: React.ReactNode; required?: boolean }) {
  return (
    <div className="mb-3">
      <label className="block text-xs font-medium text-surface-600 mb-1">
        {label}
        {required && <span className="text-red-400 ml-0.5">*</span>}
      </label>
      {children}
    </div>
  )
}


function DocGuidePanel({ type }: { type: string }) {
  const guide = getTradeDocGuide(type)
  return (
    <div className="mb-5 grid grid-cols-1 lg:grid-cols-3 gap-3">
      <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2">
        <p className="text-[11px] font-bold text-blue-900 mb-1">用途</p>
        <p className="text-xs text-blue-800 leading-5">{guide.purpose}</p>
      </div>
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2">
        <p className="text-[11px] font-bold text-emerald-900 mb-1">核对项</p>
        <div className="flex flex-wrap gap-1.5">
          {guide.checks.map(item => (
            <span key={item} className="text-[10px] font-medium text-emerald-800 bg-white/70 border border-emerald-100 rounded px-1.5 py-0.5">
              {item}
            </span>
          ))}
        </div>
      </div>
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
        <p className="text-[11px] font-bold text-amber-900 mb-1">坑点</p>
        <ul className="space-y-1">
          {guide.risks.slice(0, 2).map(item => (
            <li key={item} className="text-xs text-amber-900 leading-5">{item}</li>
          ))}
        </ul>
      </div>
    </div>
  )
}

// ======================== Main Component ========================

export default function TradeDocuments() {
  const [documents, setDocuments] = useState<TradeDocument[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<string>('quotation')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'draft' | 'ready'>('all')
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<TradeDocument | null>(null)
  const [showCustomModal, setShowCustomModal] = useState(false)
  const [customName, setCustomName] = useState('')
  const [customSections, setCustomSections] = useState<string[]>(['basic', 'products'])
  const [showSmartFill, setShowSmartFill] = useState(false)
  const [smartFillText, setSmartFillText] = useState('')
  const [smartFilling, setSmartFilling] = useState(false)
  const [previewDoc, setPreviewDoc] = useState<TradeDocument | null>(null)
  const [exporting, setExporting] = useState(false)
  const [showNumbering, setShowNumbering] = useState(false)
  const [numberingRules, setNumberingRules] = useState<Record<string, NumberingRule>>(loadNumberingRules())
  const [savedMsg, setSavedMsg] = useState('')
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [customTypes, setCustomTypes] = useState<CustomDocType[]>(loadCustomDocTypes())
  const [showSellerImport, setShowSellerImport] = useState(false)
  const [sellerText, setSellerText] = useState('')
  const [auditIssues, setAuditIssues] = useState<string[]>([])

  const allTabs = useMemo(() => {
    const builtin = ALL_DOC_TYPES as string[]
    const custom = customTypes.map(c => `custom:${c.name}`)
    return [...builtin, ...custom]
  }, [customTypes])

  useEffect(() => {
    setDocuments(loadAll())
    setLoading(false)
  }, [])

  const tabDocs = useMemo(() => documents.filter(d => d.type === activeTab), [documents, activeTab])

  const filtered = useMemo(() => {
    let result = tabDocs
    if (statusFilter !== 'all') result = result.filter(d => d.status === statusFilter)
    if (search.trim()) {
      const q = search.toLowerCase()
      result = result.filter(d =>
        d.number.toLowerCase().includes(q) ||
        d.buyer.toLowerCase().includes(q) ||
        d.title.toLowerCase().includes(q)
      )
    }
    return [...result].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
  }, [tabDocs, statusFilter, search])

  // ---- CRUD Handlers ----

  const handleNew = () => {
    setEditingId(null)
    const doc = createDefaultDoc(activeTab)
    doc.number = getNextNumber(activeTab)
    setForm(doc)
    setShowForm(true)
  }

  const handleEdit = (doc: TradeDocument) => {
    setEditingId(doc.id)
    setForm({ ...doc, items: doc.items.map(i => ({ ...i })) })
    setShowForm(true)
  }

  const handleDelete = (id: string) => {
    const updated = documents.filter(d => d.id !== id)
    setDocuments(updated)
    saveAll(updated)
  }

  const handleDuplicate = (doc: TradeDocument) => {
    const now = new Date().toISOString()
    const dup: TradeDocument = {
      ...doc,
      id: crypto.randomUUID(),
      number: doc.number ? `${doc.number}-copy` : '',
      createdAt: now,
      updatedAt: now,
      status: 'draft',
      items: doc.items.map(i => ({ ...i, id: crypto.randomUUID() })),
    }
    const updated = [...documents, dup]
    setDocuments(updated)
    saveAll(updated)
  }

  const submitForm = () => {
    if (!form) return
    if (!form.number.trim()) { alert('请输入单据号'); return }
    if (!form.buyer.trim()) { alert('请输入买方名称'); return }

    const now = new Date().toISOString()
    const doc: TradeDocument = {
      ...form,
      items: form.items.map(i => ({
        ...i,
        quantity: Number(i.quantity) || 0,
        unitPrice: Number(i.unitPrice) || 0,
      })),
      updatedAt: now,
      createdAt: editingId
        ? (documents.find(d => d.id === editingId)?.createdAt || now)
        : now,
    }

    const updated = editingId
      ? documents.map(d => d.id === editingId ? doc : d)
      : [...documents, doc]

    setDocuments(updated)
    saveAll(updated)
    setShowForm(false)
    setForm(null)
    setEditingId(null)
    // 计算下一步建议
    const existingTypes = updated.filter(d => d.status === 'ready').map(d => d.type)
    const next = suggestNextStep(existingTypes)
    setSuggestions(next)
    if (next.length > 0) {
      setSavedMsg(`已保存！下一步建议创建：${next.map(t => getDocLabel(t)).join('、')}`)
      setTimeout(() => setSavedMsg(''), 8000)
    }
  }

  const closeForm = () => {
    setShowForm(false)
    setForm(null)
    setEditingId(null)
  }

  // ---- Form field updaters ----

  const update = <K extends keyof TradeDocument>(field: K, value: TradeDocument[K]) => {
    setForm(prev => prev ? { ...prev, [field]: value } : prev)
  }

  const updateItemField = <K extends keyof DocumentItem>(itemId: string, field: K, value: DocumentItem[K]) => {
    setForm(prev => {
      if (!prev) return prev
      return {
        ...prev,
        items: prev.items.map(item =>
          item.id === itemId ? { ...item, [field]: value } : item
        ),
      }
    })
  }

  const saveCurrentSellerProfile = () => {
    if (!form) return
    localStorage.setItem(SELLER_PROFILE_KEY, JSON.stringify(sellerProfileFromDoc(form)))
    setSavedMsg('卖方资料已保存，后续新建单据将自动预填。')
  }

  const applySellerImport = () => {
    if (!form || !sellerText.trim()) return
    const parsed = parseSellerText(sellerText)
    setForm({ ...form, seller: parsed.company || form.seller, sellerAddress: parsed.address || form.sellerAddress, sellerContact: parsed.contact || form.sellerContact, sellerEmail: parsed.email || form.sellerEmail, docMeta: { ...form.docMeta, sellerPhone: parsed.phone || form.docMeta.sellerPhone || '', bankInfo: parsed.bankInfo || form.docMeta.bankInfo || '', taxId: parsed.taxId || form.docMeta.taxId || '', sellerNotes: parsed.notes || form.docMeta.sellerNotes || '' } })
    setShowSellerImport(false)
    setSellerText('')
  }

  const runQuickAudit = () => {
    if (!form) return
    setAuditIssues(auditTradeDocument(form))
  }

  const addItem = () => {
    setForm(prev => prev ? { ...prev, items: [...prev.items, emptyItem()] } : prev)
  }

  const removeItem = (itemId: string) => {
    setForm(prev => {
      if (!prev || prev.items.length <= 1) return prev
      return { ...prev, items: prev.items.filter(i => i.id !== itemId) }
    })
  }

  // ---- 智能识别 ----

  const handleSmartFill = async () => {
    if (!form || !smartFillText.trim()) return
    setSmartFilling(true)
    try {
      const result = await smartFill(smartFillText.trim())
      applySmartFill(result)
      setShowSmartFill(false)
      setSmartFillText('')
    } catch (e: any) {
      alert(e.message || '识别失败')
    } finally {
      setSmartFilling(false)
    }
  }

  const applySmartFill = (r: SmartFillResult) => {
    setForm(prev => {
      if (!prev) return prev
      // 基础字段
      const patch: Partial<typeof prev> = {}
      if (r.buyer) patch.buyer = r.buyer
      if (r.buyerAddress) patch.buyerAddress = r.buyerAddress
      if (r.buyerContact) patch.buyerContact = r.buyerContact
      if (r.buyerEmail) patch.buyerEmail = r.buyerEmail
      if (r.seller) patch.seller = r.seller
      if (r.sellerAddress) patch.sellerAddress = r.sellerAddress
      if (r.sellerContact) patch.sellerContact = r.sellerContact
      if (r.sellerEmail) patch.sellerEmail = r.sellerEmail
      if (r.currency) patch.currency = r.currency
      if (r.incoterm) patch.incoterm = r.incoterm
      if (r.paymentTerm) patch.paymentTerm = r.paymentTerm
      if (r.shippingMethod) patch.shippingMethod = r.shippingMethod
      if (r.portLoading) patch.portLoading = r.portLoading
      if (r.portDischarge) patch.portDischarge = r.portDischarge
      if (r.notes) patch.notes = r.notes

      // docMeta
      let mergedMeta = { ...prev.docMeta }
      if (r.docMeta) {
        for (const [k, v] of Object.entries(r.docMeta)) {
          if (v) mergedMeta[k] = v
        }
      }

      // items
      let mergedItems = [...prev.items]
      if (r.items && r.items.length > 0) {
        // 如果当前只有一条空行，替换；否则追加
        const isEmpty = prev.items.length === 1 && !prev.items[0].product && !prev.items[0].model
        if (isEmpty) {
          mergedItems = r.items.map((ext, i) => ({
            id: crypto.randomUUID(),
            product: ext.product || '',
            model: ext.model || '',
            hsCode: ext.hsCode || '',
            quantity: typeof ext.quantity === 'number' ? ext.quantity : 1,
            unit: ext.unit || 'PCS',
            unitPrice: typeof ext.unitPrice === 'number' ? ext.unitPrice : 0,
            originCountry: ext.originCountry || 'China',
          }))
        } else {
          mergedItems = [
            ...prev.items,
            ...r.items.map(ext => ({
              id: crypto.randomUUID(),
              product: ext.product || '',
              model: ext.model || '',
              hsCode: ext.hsCode || '',
              quantity: typeof ext.quantity === 'number' ? ext.quantity : 1,
              unit: ext.unit || 'PCS',
              unitPrice: typeof ext.unitPrice === 'number' ? ext.unitPrice : 0,
              originCountry: ext.originCountry || 'China',
            })),
          ]
        }
      }

      return {
        ...prev,
        ...patch,
        items: mergedItems,
        docMeta: mergedMeta,
      }
    })
  }

  // ---- Render ----

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-surface-400 text-sm">
        加载中...
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* ==================== Header ==================== */}
      <div className="px-6 lg:px-8 py-3 border-b border-surface-200">
        <div className="flex items-center justify-between mb-3">
          <h1 className="text-lg font-bold text-surface-900">单据凭证</h1>
          <button onClick={handleNew}
            className="btn-primary text-xs">
            + 新建单据
          </button>
        </div>

        {/* 保存成功提示 + 下一步建议 */}
        {savedMsg && (
          <div className="mb-3 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 flex items-center justify-between">
            <p className="text-xs text-emerald-800 font-medium">{savedMsg}</p>
            <button onClick={() => { setSavedMsg(''); setSuggestions([]) }}
              className="text-xs text-emerald-500 hover:text-emerald-700 bg-transparent border-none cursor-pointer font-inherit">关闭</button>
          </div>
        )}

        {/* 单据类型与筛选 */}
        <div className="flex items-center gap-2 flex-wrap">
          <select value={activeTab} onChange={event => setActiveTab(event.target.value)} className="input w-56 text-xs">
            {allTabs.map(type => <option key={type} value={type}>{getDocLabel(type)}（{documents.filter(doc => doc.type === type).length}）</option>)}
          </select>
          <input type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="搜索单据号/客户名..."
            className="input w-56 text-xs" />
          <select value={statusFilter} onChange={event => setStatusFilter(event.target.value as typeof statusFilter)} className="input w-32 text-xs">
            <option value="all">全部状态（{tabDocs.length}）</option>
            <option value="draft">草稿（{tabDocs.filter(doc => doc.status === 'draft').length}）</option>
            <option value="ready">已就绪（{tabDocs.filter(doc => doc.status === 'ready').length}）</option>
          </select>
          <details className="relative ml-auto">
            <summary className="cursor-pointer list-none rounded-lg border border-surface-200 bg-white px-3 py-2 text-xs text-surface-600">更多</summary>
            <div className="absolute right-0 z-20 mt-2 w-40 space-y-1 rounded-xl border border-surface-200 bg-white p-2 shadow-float">
              <button onClick={() => setShowCustomModal(true)} className="w-full rounded-lg px-3 py-2 text-left text-xs text-surface-700 hover:bg-surface-50">自定义单据类型</button>
              <button onClick={() => setShowNumbering(true)} className="w-full rounded-lg px-3 py-2 text-left text-xs text-surface-700 hover:bg-surface-50">编号规则</button>
            </div>
          </details>
        </div>
      </div>

      {/* ==================== Document List ==================== */}
      <div className="flex-1 overflow-y-auto p-5 lg:p-6">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-14 text-surface-400">
            <div className="w-full max-w-xl rounded-xl border border-dashed border-blue-300 bg-blue-50 p-5 text-left"><p className="text-sm font-bold text-blue-900">{getDocLabel(activeTab)} 默认可编辑模板</p><p className="mt-1 text-xs leading-5 text-blue-700">模板已包含交易双方、产品、金额、贸易条款、付款条款、港口及 HS Code 字段。点击后直接进入草稿编辑。</p><button onClick={handleNew} className="mt-3 rounded bg-blue-600 px-4 py-2 text-xs font-semibold text-white">快速创建模板草稿</button></div>
            {tabDocs.length === 0 ? (
              <p className="mt-2 text-[10px] text-surface-400">尚未保存此类单据</p>
            ) : (
              <p className="text-xs mt-1 text-surface-300">筛选条件无匹配结果</p>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map(doc => (
              <DocumentCard
                key={doc.id}
                doc={doc}
                onEdit={() => handleEdit(doc)}
                onDelete={() => handleDelete(doc.id)}
                onDuplicate={() => handleDuplicate(doc)}
                onExport={() => setPreviewDoc(doc)}
              />
            ))}
          </div>
        )}
      </div>

      {/* ==================== Custom Doc Type Modal ==================== */}
      {showCustomModal && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/40">
          <div className="min-h-full flex items-start justify-center p-4 sm:p-6">
            <div className="w-full max-w-lg bg-surface-0 rounded-2xl shadow-float my-8 overflow-hidden">
              <div className="flex items-center justify-between px-6 py-4 border-b border-surface-200">
                <h2 className="text-sm font-bold text-surface-900">自定义单证类型</h2>
                <button onClick={() => { setShowCustomModal(false); setCustomName(''); setCustomSections(['basic', 'products']) }}
                  className="text-xs text-surface-400 hover:text-surface-600 bg-transparent border-none cursor-pointer font-inherit">
                  关闭
                </button>
              </div>
              <div className="px-6 py-5 space-y-4">
                <FormField label="类型名称" required>
                  <input type="text" value={customName} onChange={e => setCustomName(e.target.value)}
                    placeholder="如：本地运输单证、质检报告"
                    className="input text-xs" />
                </FormField>
                <div>
                  <label className="block text-xs font-medium text-surface-600 mb-2">选择包含的区块</label>
                  <div className="space-y-2">
                    {ALL_SECTIONS.map(s => (
                      <label key={s.id} className="flex items-center gap-2.5 cursor-pointer select-none py-1">
                        <input type="checkbox" checked={customSections.includes(s.id)}
                          onChange={e => {
                            if (e.target.checked) {
                              setCustomSections([...customSections, s.id])
                            } else {
                              setCustomSections(customSections.filter(id => id !== s.id))
                            }
                          }}
                          className="accent-surface-700" />
                        <span className="text-xs text-surface-700">{s.title}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-end px-6 py-4 border-t border-surface-200 gap-2">
                <button onClick={() => { setShowCustomModal(false); setCustomName(''); setCustomSections(['basic', 'products']) }}
                  className="btn-ghost text-xs">取消</button>
                <button onClick={() => {
                  const name = customName.trim()
                  if (!name) { alert('请输入类型名称'); return }
                  if (customSections.length === 0) { alert('请至少选择1个区块'); return }
                  const existing = loadCustomDocTypes()
                  if (existing.some(c => c.name === name)) { alert('该类型已存在'); return }
                  const updated: CustomDocType[] = [...existing, { name, sections: customSections, nextTypes: [], createdAt: new Date().toISOString() }]
                  saveCustomDocTypes(updated)
                  setCustomTypes(updated)
                  setActiveTab(`custom:${name}`)
                  setShowCustomModal(false)
                  setCustomName('')
                  setCustomSections(['basic', 'products'])
                }}
                  className="btn-primary text-xs">保存</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ==================== Form Modal ==================== */}
      {showForm && form && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/40">
          <div className="min-h-full flex items-start justify-center p-4 sm:p-6">
            <div className="w-full max-w-5xl bg-surface-0 rounded-2xl shadow-float my-8 overflow-hidden">
              {/* Modal Header */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-surface-200">
                <div className="flex items-center gap-3">
                  <h2 className="text-sm font-bold text-surface-900">
                    {editingId ? '编辑单据' : '新建单据'}
                  </h2>
                  <span className="text-[11px] text-surface-400 bg-surface-100 px-2 py-0.5 rounded font-medium">
                    {getDocLabel(form.type)}
                  </span>
                  <button onClick={() => setShowSmartFill(true)}
                    className="text-[10px] font-medium px-2 py-1 rounded border border-dashed border-accent-300 text-accent-600 hover:bg-accent-50 bg-transparent cursor-pointer font-inherit transition-colors">
                    + 智能识别
                  </button>
                  <button onClick={runQuickAudit} className="text-[10px] font-medium px-2 py-1 rounded border border-emerald-300 text-emerald-700 hover:bg-emerald-50 bg-transparent cursor-pointer font-inherit">快速校对</button>
                </div>
                <button onClick={closeForm}
                  className="text-xs text-surface-400 hover:text-surface-600 bg-transparent border-none cursor-pointer font-inherit">
                  关闭
                </button>
              </div>

              {/* 智能识别面板 */}
              {showSmartFill && (
                <div className="px-6 py-4 border-b border-surface-200 bg-accent-50/30">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold text-surface-700">粘贴客户信息，自动识别填入</span>
                    <button onClick={() => { setShowSmartFill(false); setSmartFillText('') }}
                      className="text-[10px] text-surface-400 hover:text-surface-600 bg-transparent border-none cursor-pointer font-inherit">
                      关闭
                    </button>
                  </div>
                  <textarea value={smartFillText} onChange={e => setSmartFillText(e.target.value)}
                    placeholder={`在此粘贴客户邮件、公司介绍、产品清单等文本信息...\n\n例如：\nDear Sirs,\nWe are interested in your restaurant furniture. Please quote us for:\n- 100 pcs Dining Table Model DT-001 at USD 150/pc\n- 200 pcs Dining Chair Model DC-002 at USD 45/pc\n\nDelivery: FOB Tianjin\nPayment: 30% deposit, 70% before shipment\n\nBest regards,\nJohn Smith\nABC Restaurant Supplies\n123 Main Street, New York, USA`}
                    rows={6}
                    className="w-full text-xs bg-white border border-surface-200 rounded-lg px-3 py-2 outline-none focus:border-accent-400 font-inherit resize-y mb-2" />
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-surface-400">支持复制邮件正文、公司简介、产品规格等任意文本</span>
                    <button onClick={handleSmartFill} disabled={smartFilling || !smartFillText.trim()}
                      className="text-xs font-semibold px-4 py-1.5 rounded-lg border-none cursor-pointer font-inherit transition-all bg-accent-600 text-white hover:bg-accent-500 disabled:bg-surface-300 disabled:text-surface-500">
                      {smartFilling ? '识别中...' : '识别并填入'}
                    </button>
                  </div>
                </div>
              )}

              {/* Modal Body */}
              <div className="px-6 py-5 overflow-y-auto max-h-[70vh]">
                <DocGuidePanel type={form.type} />
                {auditIssues.length > 0 ? <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3"><p className="mb-1 text-xs font-bold text-red-800">快速校对发现 {auditIssues.length} 项</p>{auditIssues.map(issue => <p key={issue} className="text-[11px] leading-5 text-red-700">• {issue}</p>)}</div> : <p className="mb-3 text-[10px] text-surface-400">点击“快速校对”检查交易方、产品、金额、条款、港口和 HS Code。校对结果仅供人工复核。</p>}
                {/* 基本信息 — always show */}
                <FormSection title="基本信息">
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                    <FormField label="单据类型">
                      <select value={form.type} onChange={e => update('type', e.target.value)}
                        disabled={!!editingId}
                        className="input text-xs disabled:opacity-50 disabled:cursor-not-allowed">
                        {allTabs.map(t => {
                          return <option key={t} value={t}>{getDocLabel(t)}</option>
                        })}
                      </select>
                    </FormField>
                    <FormField label="单据号" required>
                      <input type="text" value={form.number} onChange={e => update('number', e.target.value)}
                        placeholder="e.g. PI-20240710-001"
                        className="input text-xs" />
                    </FormField>
                    <FormField label="日期">
                      <input type="date" value={form.issueDate} onChange={e => update('issueDate', e.target.value)}
                        className="input text-xs" />
                    </FormField>
                    <FormField label="标题">
                      <input type="text" value={form.title} onChange={e => update('title', e.target.value)}
                        placeholder="可选标题"
                        className="input text-xs" />
                    </FormField>
                    <FormField label="单据语言">
                      <select value={form.lang} onChange={e => update('lang', e.target.value as DocLanguage)}
                        className="input text-xs">
                        {LANG_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </FormField>
                  </div>
                  {/* 交易方 */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
                    <div>
                      <FormField label="买方名称" required>
                        <input type="text" value={form.buyer} onChange={e => {
                          update('buyer', e.target.value)
                          // 根据买方名称自动建议单据语言
                          const suggested = suggestLanguage(e.target.value)
                          if (suggested !== form.lang) update('lang', suggested)
                        }}
                          placeholder="买方公司全称"
                          className="input text-xs" />
                      </FormField>
                      <FormField label="买方联系人">
                        <input type="text" value={form.buyerContact} onChange={e => update('buyerContact', e.target.value)}
                          placeholder="联系人姓名"
                          className="input text-xs" />
                      </FormField>
                      <FormField label="买方邮箱">
                        <input type="email" value={form.buyerEmail} onChange={e => update('buyerEmail', e.target.value)}
                          placeholder="联系人邮箱"
                          className="input text-xs" />
                      </FormField>
                      <FormField label="买方地址">
                        <textarea value={form.buyerAddress} onChange={e => update('buyerAddress', e.target.value)}
                          rows={2}
                          className="input text-xs resize-none" />
                      </FormField>
                    </div>
                    <div>
                      <div className="mb-2 flex flex-wrap gap-2"><button type="button" onClick={saveCurrentSellerProfile} className="text-[10px] rounded border border-blue-200 px-2 py-1 text-blue-700">保存卖方资料并预填</button><button type="button" onClick={() => setShowSellerImport(value => !value)} className="text-[10px] rounded border border-amber-200 px-2 py-1 text-amber-700">粘贴导入卖方资料</button><span className="text-[10px] text-surface-400">营业执照图片 OCR 后续支持</span></div>
                      {showSellerImport && <div className="mb-3 rounded border border-amber-200 bg-amber-50 p-2"><textarea value={sellerText} onChange={event => setSellerText(event.target.value)} rows={5} placeholder="粘贴公司名、地址、联系人、电话、邮箱、税号、银行信息、备注；不会识别密码或密钥。" className="input text-xs resize-y"/><button type="button" onClick={applySellerImport} disabled={!sellerText.trim()} className="mt-2 rounded bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">识别并填入</button></div>}
                      <FormField label="卖方名称">
                        <input type="text" value={form.seller} onChange={e => update('seller', e.target.value)}
                          className="input text-xs" />
                      </FormField>
                      <FormField label="卖方联系人">
                        <input type="text" value={form.sellerContact} onChange={e => update('sellerContact', e.target.value)}
                          placeholder="联系人姓名"
                          className="input text-xs" />
                      </FormField>
                      <FormField label="卖方邮箱">
                        <input type="email" value={form.sellerEmail} onChange={e => update('sellerEmail', e.target.value)}
                          placeholder="联系人邮箱"
                          className="input text-xs" />
                      </FormField>
                      <FormField label="卖方地址">
                        <textarea value={form.sellerAddress} onChange={e => update('sellerAddress', e.target.value)} rows={2} className="input text-xs resize-none" />
                      </FormField>
                      <div className="grid grid-cols-2 gap-2"><FormField label="卖方电话"><input value={form.docMeta.sellerPhone || ''} onChange={e => update('docMeta', { ...form.docMeta, sellerPhone: e.target.value })} className="input text-xs" /></FormField><FormField label="税号/统一社会信用代码"><input value={form.docMeta.taxId || ''} onChange={e => update('docMeta', { ...form.docMeta, taxId: e.target.value })} className="input text-xs" /></FormField></div>
                      <FormField label="银行信息（普通单证字段）"><textarea value={form.docMeta.bankInfo || ''} onChange={e => update('docMeta', { ...form.docMeta, bankInfo: e.target.value })} rows={2} className="input text-xs resize-y" /></FormField>
                      <FormField label="卖方备注"><textarea value={form.docMeta.sellerNotes || ''} onChange={e => update('docMeta', { ...form.docMeta, sellerNotes: e.target.value })} rows={2} className="input text-xs resize-y" /></FormField>
                    </div>
                  </div>
                </FormSection>

                {/* 动态区块：根据模板渲染 */}
                {form && (() => {
                  const tmpl = getDocTemplate(form.type)
                  if (!tmpl) return null
                  return tmpl.sections.map(sectionId => {
                    const section = ALL_SECTIONS.find(s => s.id === sectionId)
                    if (!section) return null

                    // -------- 产品明细 --------
                    if (sectionId === 'products') return (
                      <div key="products"><FormSection title="产品明细">
                        <div className="hidden md:grid grid-cols-[1fr,1fr,100px,70px,60px,100px,90px,100px,32px] gap-2 px-1 mb-1.5">
                          <span className="text-[10px] font-semibold text-surface-400 uppercase">产品名</span>
                          <span className="text-[10px] font-semibold text-surface-400 uppercase">型号</span>
                          <span className="text-[10px] font-semibold text-surface-400 uppercase">HS编码</span>
                          <span className="text-[10px] font-semibold text-surface-400 uppercase text-right">数量</span>
                          <span className="text-[10px] font-semibold text-surface-400 uppercase">单位</span>
                          <span className="text-[10px] font-semibold text-surface-400 uppercase text-right">单价</span>
                          <span className="text-[10px] font-semibold text-surface-400 uppercase">原产地</span>
                          <span className="text-[10px] font-semibold text-surface-400 uppercase text-right">小计</span>
                          <span />
                        </div>
                        <div className="space-y-2">
                          {form.items.map(item => {
                            const subtotal = (item.quantity || 0) * (item.unitPrice || 0)
                            return (
                              <div key={item.id}
                                className="bg-surface-50 rounded-lg p-3 md:p-2 border border-surface-100">
                                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-[1fr,1fr,100px,70px,60px,100px,90px,100px,32px] gap-2 items-center">
                                  <input type="text" value={item.product} onChange={e => updateItemField(item.id, 'product', e.target.value)}
                                    placeholder="产品名"
                                    className="w-full text-xs bg-white border border-surface-200 rounded px-2 py-1.5 outline-none focus:border-surface-400 font-inherit" />
                                  <input type="text" value={item.model} onChange={e => updateItemField(item.id, 'model', e.target.value)}
                                    placeholder="型号"
                                    className="w-full text-xs bg-white border border-surface-200 rounded px-2 py-1.5 outline-none focus:border-surface-400 font-inherit" />
                                  <input type="text" value={item.hsCode} onChange={e => updateItemField(item.id, 'hsCode', e.target.value)}
                                    placeholder="HS Code"
                                    className="w-full text-xs bg-white border border-surface-200 rounded px-2 py-1.5 outline-none focus:border-surface-400 font-inherit" />
                                  <input type="number" min={0} value={item.quantity || ''} onChange={e => updateItemField(item.id, 'quantity', Number(e.target.value))}
                                    className="w-full text-xs bg-white border border-surface-200 rounded px-2 py-1.5 outline-none focus:border-surface-400 font-inherit text-right" />
                                  <input type="text" value={item.unit} onChange={e => updateItemField(item.id, 'unit', e.target.value)}
                                    className="w-full text-xs bg-white border border-surface-200 rounded px-2 py-1.5 outline-none focus:border-surface-400 font-inherit" />
                                  <input type="number" min={0} step={0.01} value={item.unitPrice || ''} onChange={e => updateItemField(item.id, 'unitPrice', Number(e.target.value))}
                                    className="w-full text-xs bg-white border border-surface-200 rounded px-2 py-1.5 outline-none focus:border-surface-400 font-inherit text-right" />
                                  <input type="text" value={item.originCountry} onChange={e => updateItemField(item.id, 'originCountry', e.target.value)}
                                    className="w-full text-xs bg-white border border-surface-200 rounded px-2 py-1.5 outline-none focus:border-surface-400 font-inherit" />
                                  <span className="text-xs font-semibold text-surface-700 text-right hidden md:block">
                                    {fmtCurrency(subtotal, form.currency)}
                                  </span>
                                  <button onClick={() => removeItem(item.id)}
                                    disabled={form.items.length <= 1}
                                    className="w-7 h-7 flex items-center justify-center rounded border border-red-200 text-red-400 hover:text-red-600 hover:border-red-400 bg-transparent cursor-pointer font-inherit text-xs transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
                                    ×
                                  </button>
                                </div>
                                <div className="mt-2 rounded border border-blue-100 bg-blue-50 p-2">
                                  <select value={HS_CODE_CANDIDATES.some(candidate => candidate.code === item.hsCode) ? item.hsCode : ''} onChange={event => updateItemField(item.id, 'hsCode', event.target.value)} className="w-full rounded border border-blue-200 bg-white px-2 py-1.5 text-xs">
                                    <option value="">选择 HS Code 候选（不会自动确认为最终编码）</option>
                                    {HS_CODE_CANDIDATES.map(candidate => <option key={candidate.category} value={candidate.code}>{candidate.category} · {candidate.code} · {candidate.nameCn} / {candidate.nameEn}</option>)}
                                  </select>
                                  {(() => { const candidate = HS_CODE_CANDIDATES.find(entry => entry.code === item.hsCode); return candidate ? <div className="mt-1 text-[10px] leading-4 text-blue-800"><p>适用产品：{candidate.suitableFor}</p><p>注意：{candidate.caution}</p><p className="font-semibold">需要用户最终确认：是</p></div> : null })()}
                                </div>
                                {/* 产品图片 */}
                                <div className="flex items-center gap-2 mt-2">
                                  <input type="text" value={item.imageUrl || ''} onChange={e => updateItemField(item.id, 'imageUrl', e.target.value)}
                                    placeholder="图片链接或上传..."
                                    className="flex-1 text-xs bg-white border border-surface-200 rounded px-2 py-1 outline-none focus:border-surface-400 font-inherit" />
                                  <label className="shrink-0 cursor-pointer">
                                    <input type="file" accept="image/*"
                                      onChange={e => {
                                        const file = e.target.files?.[0]
                                        if (!file) return
                                        const reader = new FileReader()
                                        reader.onload = ev => {
                                          const dataUrl = ev.target?.result as string
                                          updateItemField(item.id, 'imageUrl', dataUrl)
                                        }
                                        reader.readAsDataURL(file)
                                      }}
                                      className="hidden" />
                                    <span className="text-[10px] font-medium px-2 py-1.5 rounded border border-surface-200 text-surface-500 hover:text-surface-700 hover:border-surface-400 bg-transparent cursor-pointer inline-block transition-colors">上传</span>
                                  </label>
                                  {item.imageUrl && (
                                    <div className="relative w-10 h-10 rounded border border-surface-200 overflow-hidden shrink-0 bg-white">
                                      <img src={item.imageUrl} alt={item.product || '产品图'}
                                        className="w-full h-full object-contain"
                                        onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
                                    </div>
                                  )}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                        <p className="mt-3 rounded border border-amber-200 bg-amber-50 p-2 text-[10px] leading-4 text-amber-800">{HS_CODE_DISCLAIMER}</p>
                        <div className="flex items-center justify-between mt-3">
                          <button onClick={addItem}
                            className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-dashed border-surface-300 text-surface-500 hover:text-surface-700 hover:border-surface-400 bg-transparent cursor-pointer font-inherit transition-colors">
                            + 添加产品行
                          </button>
                          <div className="flex items-center gap-4">
                            <span className="text-xs text-surface-400">{form.items.length} 项</span>
                            <span className="text-sm font-bold text-surface-900">合计: {fmtCurrency(calcTotal(form.items), form.currency)}</span>
                          </div>
                        </div>
                      </FormSection></div>
                    )

                    // -------- 收付款信息 --------
                    if (sectionId === 'payment') return (
                      <FormSection key="payment" title="收付款信息">
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                          <FormField label="币种">
                            <select value={form.currency} onChange={e => update('currency', e.target.value)}
                              className="input text-xs">
                              <option value="USD">USD</option>
                              <option value="EUR">EUR</option>
                              <option value="CNY">CNY</option>
                              <option value="GBP">GBP</option>
                              <option value="JPY">JPY</option>
                              <option value="CAD">CAD</option>
                              <option value="AUD">AUD</option>
                              <option value="HKD">HKD</option>
                            </select>
                          </FormField>
                          <FormField label="付款条件">
                            <input type="text" value={form.paymentTerm} onChange={e => update('paymentTerm', e.target.value)}
                              className="input text-xs" />
                          </FormField>
                          <FormField label="收款银行">
                            <input type="text" value={form.docMeta['bankName'] || ''} onChange={e => update('docMeta', { ...form.docMeta, bankName: e.target.value })}
                              placeholder="银行名称"
                              className="input text-xs" />
                          </FormField>
                          <FormField label="银行账号">
                            <input type="text" value={form.docMeta['bankAccount'] || ''} onChange={e => update('docMeta', { ...form.docMeta, bankAccount: e.target.value })}
                              placeholder="账号"
                              className="input text-xs" />
                          </FormField>
                          <FormField label="Swift Code">
                            <input type="text" value={form.docMeta['swiftCode'] || ''} onChange={e => update('docMeta', { ...form.docMeta, swiftCode: e.target.value })}
                              className="input text-xs" />
                          </FormField>
                          <FormField label="银行地址">
                            <input type="text" value={form.docMeta['bankAddress'] || ''} onChange={e => update('docMeta', { ...form.docMeta, bankAddress: e.target.value })}
                              className="input text-xs" />
                          </FormField>
                        </div>
                      </FormSection>
                    )

                    // -------- 运输条款 --------
                    if (sectionId === 'shipping') return (
                      <FormSection key="shipping" title="运输条款">
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                          <FormField label="Incoterm">
                            <select value={form.incoterm} onChange={e => update('incoterm', e.target.value)}
                              className="input text-xs">
                              {COMMON_INCOTERMS.map(inc => <option key={inc} value={inc}>{inc}</option>)}
                            </select>
                          </FormField>
                          <FormField label="运输方式">
                            <input type="text" value={form.shippingMethod} onChange={e => update('shippingMethod', e.target.value)}
                              className="input text-xs" />
                          </FormField>
                          <FormField label="起运港">
                            <input type="text" value={form.portLoading} onChange={e => update('portLoading', e.target.value)}
                              className="input text-xs" />
                          </FormField>
                          <FormField label="目的港">
                            <input type="text" value={form.portDischarge} onChange={e => update('portDischarge', e.target.value)}
                              placeholder="目的港口"
                              className="input text-xs" />
                          </FormField>
                        </div>
                      </FormSection>
                    )

                    // -------- 包装信息 --------
                    if (sectionId === 'package') return (
                      <FormSection key="package" title="包装信息">
                        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                          <FormField label="净重 (kg)">
                            <input type="number" min={0} step={0.1} value={form.docMeta['netWeight'] || ''}
                              onChange={e => update('docMeta', { ...form.docMeta, netWeight: e.target.value })}
                              className="input text-xs" />
                          </FormField>
                          <FormField label="毛重 (kg)">
                            <input type="number" min={0} step={0.1} value={form.docMeta['grossWeight'] || ''}
                              onChange={e => update('docMeta', { ...form.docMeta, grossWeight: e.target.value })}
                              className="input text-xs" />
                          </FormField>
                          <FormField label="包装类型">
                            <input type="text" value={form.docMeta['packageType'] || ''}
                              onChange={e => update('docMeta', { ...form.docMeta, packageType: e.target.value })}
                              placeholder="纸箱/木箱/托盘"
                              className="input text-xs" />
                          </FormField>
                          <FormField label="件数">
                            <input type="number" min={0} value={form.docMeta['packageCount'] || ''}
                              onChange={e => update('docMeta', { ...form.docMeta, packageCount: e.target.value })}
                              className="input text-xs" />
                          </FormField>
                        </div>
                      </FormSection>
                    )

                    // -------- 运输工具 --------
                    if (sectionId === 'transport') return (
                      <FormSection key="transport" title="运输工具">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          <FormField label="船名/航班号">
                            <input type="text" value={form.docMeta['vesselName'] || ''}
                              onChange={e => update('docMeta', { ...form.docMeta, vesselName: e.target.value })}
                              className="input text-xs" />
                          </FormField>
                          <FormField label="航次">
                            <input type="text" value={form.docMeta['voyageNo'] || ''}
                              onChange={e => update('docMeta', { ...form.docMeta, voyageNo: e.target.value })}
                              className="input text-xs" />
                          </FormField>
                          <FormField label="集装箱号">
                            <input type="text" value={form.docMeta['containerNo'] || ''}
                              onChange={e => update('docMeta', { ...form.docMeta, containerNo: e.target.value })}
                              className="input text-xs" />
                          </FormField>
                          <FormField label="封号">
                            <input type="text" value={form.docMeta['sealNo'] || ''}
                              onChange={e => update('docMeta', { ...form.docMeta, sealNo: e.target.value })}
                              className="input text-xs" />
                          </FormField>
                        </div>
                      </FormSection>
                    )

                    // -------- 保险信息 --------
                    if (sectionId === 'insurance') return (
                      <FormSection key="insurance" title="保险信息">
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                          <FormField label="投保金额">
                            <input type="text" value={form.docMeta['insuredAmount'] || ''}
                              onChange={e => update('docMeta', { ...form.docMeta, insuredAmount: e.target.value })}
                              className="input text-xs" />
                          </FormField>
                          <FormField label="保险公司">
                            <input type="text" value={form.docMeta['insuranceCompany'] || ''}
                              onChange={e => update('docMeta', { ...form.docMeta, insuranceCompany: e.target.value })}
                              className="input text-xs" />
                          </FormField>
                          <FormField label="险别">
                            <input type="text" value={form.docMeta['coverageType'] || ''}
                              onChange={e => update('docMeta', { ...form.docMeta, coverageType: e.target.value })}
                              placeholder="一切险/水渍险/平安险"
                              className="input text-xs" />
                          </FormField>
                        </div>
                      </FormSection>
                    )

                    // -------- 原产地/认证 --------
                    if (sectionId === 'certification') return (
                      <FormSection key="certification" title="原产地/认证">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          <FormField label="原产地标准">
                            <input type="text" value={form.docMeta['originCriteria'] || ''}
                              onChange={e => update('docMeta', { ...form.docMeta, originCriteria: e.target.value })}
                              placeholder="完全获得 / 含进口成分"
                              className="input text-xs" />
                          </FormField>
                          <FormField label="签证机构">
                            <input type="text" value={form.docMeta['certifyingAuthority'] || ''}
                              onChange={e => update('docMeta', { ...form.docMeta, certifyingAuthority: e.target.value })}
                              placeholder="贸促会/检验检疫局"
                              className="input text-xs" />
                          </FormField>
                          <FormField label="许可证号">
                            <input type="text" value={form.docMeta['licenseNo'] || ''}
                              onChange={e => update('docMeta', { ...form.docMeta, licenseNo: e.target.value })}
                              className="input text-xs" />
                          </FormField>
                          <FormField label="有效期至">
                            <input type="date" value={form.docMeta['validUntil'] || ''}
                              onChange={e => update('docMeta', { ...form.docMeta, validUntil: e.target.value })}
                              className="input text-xs" />
                          </FormField>
                        </div>
                      </FormSection>
                    )

                    // -------- 报关信息 --------
                    if (sectionId === 'customs') return (
                      <FormSection key="customs" title="报关信息">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          <FormField label="报关行">
                            <input type="text" value={form.docMeta['customsBroker'] || ''}
                              onChange={e => update('docMeta', { ...form.docMeta, customsBroker: e.target.value })}
                              className="input text-xs" />
                          </FormField>
                          <FormField label="申报要素">
                            <textarea value={form.docMeta['declarationElements'] || ''}
                              onChange={e => update('docMeta', { ...form.docMeta, declarationElements: e.target.value })}
                              rows={2}
                              className="input text-xs resize-none" />
                          </FormField>
                        </div>
                      </FormSection>
                    )

                    // -------- 合同条款 --------
                    if (sectionId === 'legal') return (
                      <FormSection key="legal" title="合同条款">
                        <div className="grid grid-cols-1 gap-4">
                          <FormField label="争议解决">
                            <input type="text" value={form.docMeta['disputeResolution'] || ''}
                              onChange={e => update('docMeta', { ...form.docMeta, disputeResolution: e.target.value })}
                              placeholder="提交中国国际经济贸易仲裁委员会"
                              className="input text-xs" />
                          </FormField>
                          <FormField label="其他条款">
                            <textarea value={form.docMeta['otherClauses'] || ''}
                              onChange={e => update('docMeta', { ...form.docMeta, otherClauses: e.target.value })}
                              rows={3}
                              className="input text-xs resize-none" />
                          </FormField>
                        </div>
                      </FormSection>
                    )

                    return null
                  })
                })()}

                {/* 备注 — always show */}
                <FormSection title="备注">
                  <textarea value={form.notes} onChange={e => update('notes', e.target.value)}
                    rows={3}
                    placeholder="附加备注、条款..."
                    className="input text-xs resize-none" />
                </FormSection>

                {/* 工作流步骤提示 */}
                {form && (() => {
                  const tmpl = getDocTemplate(form.type)
                  if (!tmpl || tmpl.nextSteps.length === 0) return null
                  return (
                    <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 mb-5">
                      <p className="text-xs text-blue-800 font-medium">
                        此单据完成后，下一步建议创建：
                        {tmpl.nextSteps.map((t, i) => (
                          <span key={t}>
                            {i > 0 && ' → '}
                            <span className="font-bold">{getDocLabel(t)}</span>
                          </span>
                        ))}
                      </p>
                    </div>
                  )
                })()}

                {/* Status — always show */}
                <div>
                  <div className="flex items-center gap-4">
                    <span className="text-xs font-medium text-surface-600">状态</span>
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <input type="radio" name="form-status" checked={form.status === 'draft'}
                        onChange={() => update('status', 'draft')}
                        className="accent-surface-700" />
                      <span className="text-xs text-surface-700">草稿</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <input type="radio" name="form-status" checked={form.status === 'ready'}
                        onChange={() => update('status', 'ready')}
                        className="accent-surface-700" />
                      <span className="text-xs text-surface-700">已就绪(Ready)</span>
                    </label>
                  </div>
                </div>
              </div>

              {/* Modal Footer */}
              <div className="flex items-center justify-between px-6 py-4 border-t border-surface-200 bg-surface-50">
                <span className="text-xs text-surface-400">
                  {form.status === 'ready' ? '文档已标记为就绪，可发送给客户' : '草稿状态，仅供内部参考'}
                </span>
                <div className="flex items-center gap-2">
                  <button onClick={closeForm}
                    className="btn-ghost text-xs">
                    取消
                  </button>
                  <button onClick={submitForm}
                    className="btn-primary text-xs">
                    {editingId ? '保存修改' : '创建单据'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ==================== Numbering Config Modal ==================== */}
      {showNumbering && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/40">
          <div className="min-h-full flex items-start justify-center p-4 sm:p-6">
            <div className="w-full max-w-lg bg-surface-0 rounded-2xl shadow-float my-8 overflow-hidden">
              <div className="flex items-center justify-between px-6 py-4 border-b border-surface-200">
                <h2 className="text-sm font-bold text-surface-900">编号规则</h2>
                <button onClick={() => setShowNumbering(false)}
                  className="text-xs text-surface-400 hover:text-surface-600 bg-transparent border-none cursor-pointer font-inherit">
                  关闭
                </button>
              </div>
              <div className="px-6 py-5 max-h-[60vh] overflow-y-auto space-y-3">
                <p className="text-[11px] text-surface-400 mb-2">格式：<span className="font-mono">前缀-YYYYMMDD-序号</span>，新建单据时自动生成</p>
                {allTabs.map(t => {
                  const isCustom = t.startsWith('custom:')
                  const rule = numberingRules[t]
                  const prefix = rule?.prefix || DEFAULT_PREFIXES[t] || 'DOC'
                  const nextSeq = rule?.nextSeq || 1
                  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
                  return (
                    <div key={t} className="flex items-center gap-3 bg-surface-50 rounded-lg p-3 border border-surface-100">
                      <span className="text-xs font-semibold text-surface-700 w-24 shrink-0">{getDocLabel(t)}</span>
                      <input type="text" value={prefix}
                        onChange={e => {
                          const updated = { ...numberingRules }
                          updated[t] = { prefix: e.target.value, nextSeq: updated[t]?.nextSeq || 1 }
                          setNumberingRules(updated)
                          saveNumberingRules(updated)
                        }}
                        className="w-20 text-xs bg-white border border-surface-200 rounded px-2 py-1.5 outline-none focus:border-surface-400 font-inherit font-mono text-center" />
                      <span className="text-[10px] text-surface-400 font-mono">-{date}-</span>
                      <input type="number" min={1} value={nextSeq}
                        onChange={e => {
                          const updated = { ...numberingRules }
                          updated[t] = { prefix: updated[t]?.prefix || DEFAULT_PREFIXES[t] || 'DOC', nextSeq: Math.max(1, parseInt(e.target.value) || 1) }
                          setNumberingRules(updated)
                          saveNumberingRules(updated)
                        }}
                        className="w-16 text-xs bg-white border border-surface-200 rounded px-2 py-1.5 outline-none focus:border-surface-400 font-inherit font-mono text-center" />
                      <span className="text-[10px] text-surface-400">预览: <span className="font-mono font-semibold text-surface-600">{prefix}-{date}-{String(nextSeq).padStart(3, '0')}</span></span>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ==================== Preview / Export Modal ==================== */}
      <style>{`@media print { body * { visibility: hidden !important; } #pdf-content, #pdf-content * { visibility: visible !important; } #pdf-content { position: absolute !important; left: 0; top: 0; width: 210mm !important; max-width: 210mm !important; box-shadow: none !important; } }`}</style>
      {previewDoc && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/40">
          <div className="min-h-full flex items-start justify-center p-4 sm:p-6">
            <div className="w-full max-w-4xl bg-surface-0 rounded-2xl shadow-float my-8 overflow-hidden">
              <div className="flex items-center justify-between px-6 py-4 border-b border-surface-200">
                <h2 className="text-sm font-bold text-surface-900">
                  {getDocLabel(previewDoc.type)} - {previewDoc.number}
                </h2>
                <div className="flex items-center gap-2">
                  <button onClick={() => setPreviewDoc(null)}
                    className="text-xs text-surface-400 hover:text-surface-600 bg-transparent border-none cursor-pointer font-inherit">
                    关闭
                  </button>
                </div>
              </div>

              {/* PDF 内容 */}
              <div className="px-6 py-5 overflow-y-auto max-h-[75vh]">
                <div id="pdf-content" className="bg-white mx-auto" style={{ maxWidth: '210mm', padding: '15mm 20mm', fontFamily: 'sans-serif' }}>
                  {/* Header */}
                  <div className="flex items-start justify-between mb-8">
                    <div>
                      <h1 style={{ fontSize: '18pt', fontWeight: 'bold', color: '#1a1a2e', margin: 0 }}>{getDocLabel(previewDoc.type)}</h1>
                      <p style={{ fontSize: '9pt', color: '#888', marginTop: 4, marginBottom: 0 }}>{t('documentNo', previewDoc.lang)} {previewDoc.number}</p>
                    </div>
                    <div style={{ textAlign: 'right', fontSize: '9pt', color: '#555' }}>
                      <p style={{ margin: '2px 0' }}>{t('date', previewDoc.lang)}: {previewDoc.issueDate}</p>
                      {previewDoc.title && <p style={{ margin: '2px 0' }}>{previewDoc.title}</p>}
                    </div>
                  </div>

                  {/* Buyer / Seller */}
                  <table style={{ width: '100%', fontSize: '10pt', marginBottom: 24, borderCollapse: 'collapse' }}>
                    <tbody>
                    <tr>
                      <td style={{ width: '50%', verticalAlign: 'top', paddingRight: 12 }}>
                        <p style={{ fontSize: '8pt', color: '#888', fontWeight: 600, margin: '0 0 4px 0' }}>{t('buyer', previewDoc.lang).toUpperCase()}</p>
                        <p style={{ margin: '2px 0', fontWeight: 600, fontSize: '10pt' }}>{previewDoc.buyer || '-'}</p>
                        {previewDoc.buyerContact && <p style={{ margin: '2px 0', fontSize: '9pt', color: '#333' }}>{t('attn', previewDoc.lang)}: {previewDoc.buyerContact}</p>}
                        {previewDoc.buyerEmail && <p style={{ margin: '2px 0', fontSize: '9pt', color: '#333' }}>{t('email', previewDoc.lang)}: {previewDoc.buyerEmail}</p>}
                        <p style={{ margin: '2px 0', fontSize: '9pt', color: '#555' }}>{previewDoc.buyerAddress}</p>
                      </td>
                      <td style={{ width: '50%', verticalAlign: 'top', paddingLeft: 12 }}>
                        <p style={{ fontSize: '8pt', color: '#888', fontWeight: 600, margin: '0 0 4px 0' }}>{t('seller', previewDoc.lang).toUpperCase()}</p>
                        <p style={{ margin: '2px 0', fontWeight: 600, fontSize: '10pt' }}>{previewDoc.seller || '-'}</p>
                        {previewDoc.sellerContact && <p style={{ margin: '2px 0', fontSize: '9pt', color: '#333' }}>{t('attn', previewDoc.lang)}: {previewDoc.sellerContact}</p>}
                        {previewDoc.sellerEmail && <p style={{ margin: '2px 0', fontSize: '9pt', color: '#333' }}>{t('email', previewDoc.lang)}: {previewDoc.sellerEmail}</p>}
                        {previewDoc.docMeta.sellerPhone && <p style={{ margin: '2px 0', fontSize: '9pt', color: '#333' }}>Tel: {previewDoc.docMeta.sellerPhone}</p>}
                        {previewDoc.docMeta.taxId && <p style={{ margin: '2px 0', fontSize: '9pt', color: '#333' }}>Tax ID: {previewDoc.docMeta.taxId}</p>}
                        <p style={{ margin: '2px 0', fontSize: '9pt', color: '#555' }}>{previewDoc.sellerAddress}</p>
                      </td>
                    </tr>
                    </tbody>
                  </table>

                  {/* Products Table */}
                  <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 20, fontSize: '9pt' }}>
                    <thead>
                      <tr style={{ backgroundColor: '#f5f5f5' }}>
                        <th style={{ border: '1px solid #ddd', padding: '6px 8px', textAlign: 'left', fontWeight: 600, fontSize: '8pt' }}>{t('product', previewDoc.lang)}</th>
                        <th style={{ border: '1px solid #ddd', padding: '6px 8px', textAlign: 'left', fontWeight: 600, fontSize: '8pt' }}>{t('model', previewDoc.lang)}</th>
                        <th style={{ border: '1px solid #ddd', padding: '6px 8px', textAlign: 'left', fontWeight: 600, fontSize: '8pt' }}>HS Code（候选）</th>
                        <th style={{ border: '1px solid #ddd', padding: '6px 8px', textAlign: 'center', fontWeight: 600, fontSize: '8pt' }}>{t('quantity', previewDoc.lang)}</th>
                        <th style={{ border: '1px solid #ddd', padding: '6px 8px', textAlign: 'center', fontWeight: 600, fontSize: '8pt' }}>{t('unit', previewDoc.lang)}</th>
                        <th style={{ border: '1px solid #ddd', padding: '6px 8px', textAlign: 'right', fontWeight: 600, fontSize: '8pt' }}>{t('unitPrice', previewDoc.lang)}</th>
                        <th style={{ border: '1px solid #ddd', padding: '6px 8px', textAlign: 'right', fontWeight: 600, fontSize: '8pt' }}>{t('subtotal', previewDoc.lang)}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {previewDoc.items.map((item) => (
                        <tr key={item.id}>
                          <td style={{ border: '1px solid #ddd', padding: '6px 8px', verticalAlign: 'middle' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              {item.imageUrl && (
                                <img src={item.imageUrl} alt=""
                                  style={{ width: 32, height: 32, objectFit: 'contain', borderRadius: 4, border: '1px solid #eee' }}
                                  onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
                              )}
                              <span>{item.product}</span>
                            </div>
                          </td>
                          <td style={{ border: '1px solid #ddd', padding: '6px 8px', verticalAlign: 'middle' }}>{item.model}</td>
                          <td style={{ border: '1px solid #ddd', padding: '6px 8px', verticalAlign: 'middle' }}>{item.hsCode || '-'}</td>
                          <td style={{ border: '1px solid #ddd', padding: '6px 8px', textAlign: 'center', verticalAlign: 'middle' }}>{item.quantity}</td>
                          <td style={{ border: '1px solid #ddd', padding: '6px 8px', textAlign: 'center', verticalAlign: 'middle' }}>{item.unit}</td>
                          <td style={{ border: '1px solid #ddd', padding: '6px 8px', textAlign: 'right', verticalAlign: 'middle', whiteSpace: 'nowrap' }}>{fmtCurrency(item.unitPrice, previewDoc.currency)}</td>
                          <td style={{ border: '1px solid #ddd', padding: '6px 8px', textAlign: 'right', verticalAlign: 'middle', whiteSpace: 'nowrap', fontWeight: 600 }}>{fmtCurrency((item.quantity || 0) * (item.unitPrice || 0), previewDoc.currency)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={6} style={{ border: '1px solid #ddd', padding: '8px', textAlign: 'right', fontWeight: 600, fontSize: '10pt' }}>{t('total', previewDoc.lang)}</td>
                        <td style={{ border: '1px solid #ddd', padding: '8px', textAlign: 'right', fontWeight: 700, fontSize: '11pt', color: '#1a1a2e' }}>{fmtCurrency(calcTotal(previewDoc.items), previewDoc.currency)}</td>
                      </tr>
                    </tfoot>
                  </table>

                  {/* Payment / Shipping / Notes */}
                  <table style={{ width: '100%', fontSize: '9pt', borderCollapse: 'collapse' }}>
                    <tbody>
                    {(previewDoc.paymentTerm || previewDoc.incoterm || previewDoc.currency) && (
                      <tr>
                        <td style={{ width: '30%', padding: '4px 0', color: '#888', fontWeight: 600, verticalAlign: 'top' }}>{t('tradeTerms', previewDoc.lang)}</td>
                        <td style={{ padding: '4px 0', verticalAlign: 'top' }}>
                          {[previewDoc.incoterm, previewDoc.paymentTerm, previewDoc.shippingMethod].filter(Boolean).join(' | ') || '-'}
                        </td>
                      </tr>
                    )}
                    {(previewDoc.portLoading || previewDoc.portDischarge) && (
                      <tr>
                        <td style={{ width: '30%', padding: '4px 0', color: '#888', fontWeight: 600, verticalAlign: 'top' }}>{t('shipping', previewDoc.lang)}</td>
                        <td style={{ padding: '4px 0', verticalAlign: 'top' }}>
                          {[previewDoc.portLoading, previewDoc.portDischarge].filter(Boolean).join(' → ') || '-'}
                        </td>
                      </tr>
                    )}
                    {previewDoc.notes && (
                      <tr>
                        <td style={{ width: '30%', padding: '4px 0', color: '#888', fontWeight: 600, verticalAlign: 'top' }}>{t('notes', previewDoc.lang)}</td>
                        <td style={{ padding: '4px 0', verticalAlign: 'top', whiteSpace: 'pre-wrap' }}>{previewDoc.notes}</td>
                      </tr>
                    )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Footer */}
              <div className="flex items-center justify-between px-6 py-4 border-t border-surface-200 bg-surface-50">
                <span className="text-xs text-surface-400">A4 预览，可浏览器打印或另存为 PDF</span>
                <div className="flex items-center gap-2"><button type="button" onClick={() => window.print()} className="btn-ghost text-xs">打印 / 另存为 PDF</button>
                <button onClick={async () => {
                  setExporting(true)
                  try {
                    const html2pdf = (await import('html2pdf.js')).default
                    const element = document.getElementById('pdf-content')
                    if (!element) return
                    await html2pdf()
                      .set({
                        margin: [0, 0, 0, 0],
                        filename: `${previewDoc.number || 'document'}.pdf`,
                        image: { type: 'jpeg', quality: 0.98 },
                        html2canvas: { scale: 2, useCORS: true },
                        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
                      })
                      .from(element)
                      .save()
                  } catch (e: any) {
                    alert('PDF 导出失败: ' + (e.message || '未知错误'))
                  } finally {
                    setExporting(false)
                  }
                }} disabled={exporting}
                  className="btn-primary text-xs">
                  {exporting ? '生成中...' : '下载 PDF'}
                </button></div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}






