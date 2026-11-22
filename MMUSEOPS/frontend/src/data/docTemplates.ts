import type { DocumentType } from '../types/item'
import { DOCUMENT_LABELS } from '../types/item'

/** 表单区块定义 */
export interface DocSection {
  id: string
  title: string
}

/** 单证模板 */
export interface DocTemplate {
  label: string
  /** 当前步骤（用于工作流序号） */
  step: number
  /** 建议下一步创建的单证 */
  nextSteps: DocumentType[]
  /** 需要显示的区块 ID 列表 */
  sections: string[]
}

/** 所有可用的区块 */
export const ALL_SECTIONS: DocSection[] = [
  { id: 'basic', title: '基本信息' },
  { id: 'products', title: '产品明细' },
  { id: 'payment', title: '收付款信息' },
  { id: 'shipping', title: '运输条款' },
  { id: 'package', title: '包装信息' },
  { id: 'transport', title: '运输工具' },
  { id: 'legal', title: '合同条款' },
  { id: 'insurance', title: '保险信息' },
  { id: 'certification', title: '原产地/认证' },
  { id: 'customs', title: '报关信息' },
]

/** 各单证类型的步骤序号及区块配置 */
export const DOC_TEMPLATES: Record<string, DocTemplate> = {
  quotation: {
    label: '报价单 (Quotation)',
    step: 1,
    nextSteps: ['proforma_invoice', 'contract'],
    sections: ['basic', 'products', 'payment', 'shipping'],
  },
  contract: {
    label: '销售合同 (S/C)',
    step: 2,
    nextSteps: ['proforma_invoice'],
    sections: ['basic', 'products', 'payment', 'shipping', 'legal'],
  },
  proforma_invoice: {
    label: '形式发票 (P/I)',
    step: 3,
    nextSteps: ['commercial_invoice', 'packing_list'],
    sections: ['basic', 'products', 'payment', 'shipping'],
  },
  commercial_invoice: {
    label: '商业发票 (C/I)',
    step: 4,
    nextSteps: ['packing_list', 'bill_of_lading'],
    sections: ['basic', 'products', 'payment', 'shipping', 'transport'],
  },
  packing_list: {
    label: '装箱单 (P/L)',
    step: 4,
    nextSteps: ['bill_of_lading'],
    sections: ['basic', 'products', 'package', 'shipping'],
  },
  bill_of_lading: {
    label: '提单/运单 (B/L)',
    step: 5,
    nextSteps: ['customs_declaration'],
    sections: ['basic', 'transport', 'shipping'],
  },
  customs_declaration: {
    label: '报关单 (C/D)',
    step: 6,
    nextSteps: ['certificate_of_origin'],
    sections: ['basic', 'products', 'customs', 'transport'],
  },
  certificate_of_origin: {
    label: '原产地证 (C/O)',
    step: 7,
    nextSteps: ['insurance'],
    sections: ['basic', 'products', 'certification'],
  },
  insurance: {
    label: '保险单',
    step: 8,
    nextSteps: [],
    sections: ['basic', 'products', 'insurance', 'shipping'],
  },
  export_license: {
    label: '出口许可证',
    step: 3,
    nextSteps: ['commercial_invoice'],
    sections: ['basic', 'products', 'certification'],
  },
  other: {
    label: '其他文件',
    step: 99,
    nextSteps: [],
    sections: ['basic'],
  },
}

/** 自定义单证（用户添加的） */
export interface CustomDocType {
  name: string
  sections: string[]
  nextTypes: string[]
  createdAt: string
}

const CUSTOM_TYPES_KEY = 'mmuse_custom_doc_types'

export function loadCustomDocTypes(): CustomDocType[] {
  try {
    const raw = localStorage.getItem(CUSTOM_TYPES_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

export function saveCustomDocTypes(types: CustomDocType[]) {
  localStorage.setItem(CUSTOM_TYPES_KEY, JSON.stringify(types))
}

/** 获取所有单证类型（内置+自定义） */
export function getAllDocTypes(): string[] {
  const builtin = Object.keys(DOC_TEMPLATES)
  const custom = loadCustomDocTypes().map(c => `custom:${c.name}`)
  return [...builtin, ...custom]
}

/** 获取模板（内置或自定义） */
export function getDocTemplate(type: string): DocTemplate | null {
  if (!type.startsWith('custom:')) return DOC_TEMPLATES[type] || null
  const customName = type.replace('custom:', '')
  const custom = loadCustomDocTypes().find(c => c.name === customName)
  if (!custom) return null
  return {
    label: custom.name,
    step: 99,
    nextSteps: [],
    sections: custom.sections,
  }
}

/** 获取步骤名称列表（用于进度展示） */
export const STEP_LABELS: Record<number, string> = {
  1: '报价',
  2: '合同',
  3: '形式发票',
  4: '出货单据',
  5: '运输单据',
  6: '报关',
  7: '原产地',
  8: '保险',
}

/** 根据已创建的单证类型，返回建议下一步操作 */
export function suggestNextStep(existingTypes: string[]): string[] {
  // 找到现有单证的最高步骤
  let maxStep = 0
  const suggestions: string[] = []

  for (const t of existingTypes) {
    const tmpl = DOC_TEMPLATES[t]
    if (tmpl && tmpl.step > maxStep) maxStep = tmpl.step
  }

  // 查看现有单证的 nextSteps
  for (const t of existingTypes) {
    const tmpl = DOC_TEMPLATES[t]
    if (tmpl) {
      for (const next of tmpl.nextSteps) {
        if (!existingTypes.includes(next)) {
          suggestions.push(next)
        }
      }
    }
  }

  return [...new Set(suggestions)]
}
