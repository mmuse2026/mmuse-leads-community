/** 智能识别：粘贴客户信息 → LLM 提取 → 自动填入表单 */
import { loadProfile } from '../store/userProfile'
import type { DocumentItem } from '../pages/TradeDocuments'

export interface SmartFillResult {
  buyer?: string
  buyerAddress?: string
  buyerContact?: string
  buyerEmail?: string
  seller?: string
  sellerAddress?: string
  sellerContact?: string
  sellerEmail?: string
  currency?: string
  incoterm?: string
  paymentTerm?: string
  shippingMethod?: string
  portLoading?: string
  portDischarge?: string
  items?: Partial<DocumentItem>[]
  notes?: string
  docMeta?: Record<string, string>
}

const SYSTEM_PROMPT = `你是一位外贸单证信息提取助手。从用户提供的客户信息文本中提取结构化数据。

只输出纯 JSON，不要包含 markdown 代码块标记、不要添加额外说明。

提取以下字段（只提取文本中明确提到的）：
- buyer: 买方公司名称
- buyerAddress: 买方地址
- buyerContact: 买方联系人
- buyerEmail: 买方邮箱
- seller: 卖方公司名称
- sellerAddress: 卖方地址
- sellerContact: 卖方联系人
- sellerEmail: 卖方邮箱
- contactPerson: 联系人姓名
- email: 邮箱地址
- phone: 电话号码
- currency: 币种 (USD/CNY/EUR/GBP 等)
- incoterm: 贸易术语 (FOB/CIF/EXW 等)
- paymentTerm: 付款条件
- shippingMethod: 运输方式 (海运/空运/铁路)
- portLoading: 起运港
- portDischarge: 目的港
- items: 产品列表，每个产品包含：
  - product: 产品名称
  - model: 型号/规格
  - quantity: 数量
  - unit: 单位 (PCS/SET 等)
  - unitPrice: 单价（数字，不含货币符号）
- notes: 其他备注信息
- bankName: 银行名称
- bankAccount: 银行账号
- swiftCode: Swift Code
- bankAddress: 银行地址

注意：
- 数量(quantity)和单价(unitPrice)输出纯数字
- 如果文本中没有对应信息，不要编造，省略该字段
- JSON key 必须使用英文驼峰命名`

export async function smartFill(text: string): Promise<SmartFillResult> {
  const profile = loadProfile()
  const apiKey = profile.llmApiKey
  const baseUrl = profile.llmBaseUrl.trim().replace(/\/+$/, '')

  if (!apiKey || !baseUrl || !profile.llmModel) throw new Error('请先在设置中配置模型、接口地址和 API Key')

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: profile.llmModel,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
      temperature: 0.1,
      max_tokens: 4096,
    }),
  })

  if (!res.ok) {
    const err = await res.text().catch(() => 'unknown')
    throw new Error(`LLM 调用失败: ${res.status} ${err}`)
  }

  const data = await res.json()
  const content = data.choices?.[0]?.message?.content
  if (!content) throw new Error('LLM 返回为空')

  // 尝试提取 JSON（兼容 LLM 可能带 markdown 标记）
  let jsonStr = content.trim()
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (jsonMatch) jsonStr = jsonMatch[1].trim()

  try {
    return JSON.parse(jsonStr) as SmartFillResult
  } catch {
    throw new Error('LLM 返回格式异常，无法解析')
  }
}
