/** 智能识别客户：粘贴文本/上传截图 → LLM 提取 → 创建客户 */
import { loadProfile } from '../store/userProfile'

export interface ExtractedCustomer {
  company: string
  contactName: string
  email: string
  phone: string
  website: string
  country: string
  businessLine: string
  clientType: string
  companySize: string
  products: string[]
  decisionMakers: { name: string; title?: string }[]
  summary: string
  source: string
}

const EXTRACT_PROMPT = `你是一位外贸客户信息提取助手。从用户提供的客户信息（文本或图片文字）中提取结构化数据。

只输出纯 JSON，不要包含 markdown 代码块标记，不要添加额外说明。

提取以下字段（只提取信息中明确提到的，不要编造）：
- company: 公司名称
- contactName: 联系人姓名
- email: 邮箱地址
- phone: 电话号码
- website: 公司网站
- country: 所在国家
- businessLine: 业务类型（furniture/car-seat/lighting/home/packaging，根据主营产品推断）
- clientType: 客户类型（distributor/trader/ecommerce/wholesaler/retailer/manufacturer）
- companySize: 公司规模描述
- products: 主营产品列表（数组）
- decisionMakers: 决策人列表，每项包含 name（姓名）和 title（职位）
- summary: 公司简介摘要
- source: 信息来源（如 LinkedIn/官网/展会等，根据文本推断）

注意：
- businessLine 只能从 furniture/car-seat/lighting/home/packaging 中选择
- 不确定的字段设为空字符串或空数组
- JSON key 必须使用英文驼峰命名`

async function callLLM(messages: any[]): Promise<string> {
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
      messages,
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
  return content
}

function parseJSON(content: string): ExtractedCustomer {
  let jsonStr = content.trim()
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (jsonMatch) jsonStr = jsonMatch[1].trim()
  const parsed = JSON.parse(jsonStr)

  return {
    company: parsed.company || '',
    contactName: parsed.contactName || '',
    email: parsed.email || '',
    phone: parsed.phone || '',
    website: parsed.website || '',
    country: parsed.country || '',
    businessLine: parsed.businessLine || '',
    clientType: parsed.clientType || '',
    companySize: parsed.companySize || '',
    products: Array.isArray(parsed.products) ? parsed.products : [],
    decisionMakers: Array.isArray(parsed.decisionMakers) ? parsed.decisionMakers : [],
    summary: parsed.summary || '',
    source: parsed.source || 'manual',
  }
}

/** 从文本提取客户信息 */
export async function extractFromText(text: string): Promise<ExtractedCustomer> {
  if (!text.trim()) throw new Error('文本不能为空')
  const content = await callLLM([
    { role: 'system', content: EXTRACT_PROMPT },
    { role: 'user', content: text },
  ])
  return parseJSON(content)
}

/** 从图片(base64)提取客户信息 */
export async function extractFromImage(base64Image: string): Promise<ExtractedCustomer> {
  if (!base64Image) throw new Error('图片不能为空')
  const content = await callLLM([
    { role: 'system', content: EXTRACT_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'text', text: '请从这张图片中提取客户信息。' },
        { type: 'image_url', image_url: { url: base64Image } },
      ],
    },
  ])
  return parseJSON(content)
}
