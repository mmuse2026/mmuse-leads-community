/** 客户端类型自动分类工具 — 纯关键词匹配，无需 LLM */
import { getAllItems, saveItem } from '../store/db'
import { API_BASE } from './config'
import type { ClientType, PipelineItem, BusinessLine } from '../types/item'

// ========= 业务线分类（businessLine） =========

/** 家具业务关键词 */
const FURNITURE_KW = /\b(furniture|chair|table|sofa|couch|cabinet|desk|bedroom|dining|living\s+room|office\s+furniture|home\s+furniture|seating|booth|stool|bench|shelf|bookcase|wardrobe|drawer|ottoman|footstool)/i

/** 汽车座椅套关键词 */
const CAR_SEAT_KW = /\b(car\s*seat|seat\s*cover|auto\s*seat|vehicle\s*seat|automotive\s*seat|car\s*interior|seat\s*protector|car\s*accessories|floor\s*mat|steering\s*wheel\s*cover|car\s*mat)/i

/** 照明关键词 */
const LIGHTING_KW = /\b(lighting|light|lamp|led|luminaire|chandelier|sconce|pendant|fixture|illumination|bulb|strip\s*light)/i

/** 家居日用关键词 */
const HOME_KW = /\b(home\s*decor|household|kitchen|bathroom|bedding|pillow|blanket|rug|carpet|curtain|towel|storage|organizer)/i

/** 包装材料关键词 */
const PACKAGING_KW = /\b(packaging|package|box|carton|wrapper|bubble\s*wrap|tape|label|container|corrugated|cardboard)/i

/**
 * 根据背调数据判断业务线（products > summary > snippet > company名）
 */
export function classifyBusinessLine(item: {
  backCheck?: { summary?: string; products?: string[]; markets?: string[] }
  company?: string
  website?: string
  snippet?: string
}): BusinessLine {
  const products = (item.backCheck?.products || []).join(' ').toLowerCase()
  const summary = (item.backCheck?.summary || '').toLowerCase()
  const snippet = (item.snippet || '').toLowerCase()
  const company = (item.company || '').toLowerCase()
  const allText = [products, summary, snippet, company].join(' ')

  // 按优先级匹配：products 最可靠，其次 summary，最后 snippet/company
  // 汽车座椅套（高优先级，因为关键词更明确）
  if (CAR_SEAT_KW.test(products) || CAR_SEAT_KW.test(summary)) return 'car-seat'
  // 家具
  if (FURNITURE_KW.test(products) || FURNITURE_KW.test(summary)) return 'furniture'
  // 照明
  if (LIGHTING_KW.test(products) || LIGHTING_KW.test(summary)) return 'lighting'
  // 包装
  if (PACKAGING_KW.test(products) || PACKAGING_KW.test(summary)) return 'packaging'
  // 家居日用
  if (HOME_KW.test(products) || HOME_KW.test(summary)) return 'home'

  // 用 snippet 和 company 名再试一次
  if (CAR_SEAT_KW.test(allText)) return 'car-seat'
  if (FURNITURE_KW.test(allText)) return 'furniture'
  if (LIGHTING_KW.test(allText)) return 'lighting'
  if (PACKAGING_KW.test(allText)) return 'packaging'
  if (HOME_KW.test(allText)) return 'home'

  return 'furniture' // 默认家具（主要业务线）
}

/** 客户类型关键词映射（注意：只用 \b 在词首，不用尾巴，以匹配 retailer/distributor 等派生词） */
const MANUFACTURER_KW = /\b(manufactur|factory|produces|oem|made\s+in|production\s+facility|producer)/i
const DISTRIBUTOR_KW = /\b(distribut|stocking|supply\s+chain|logistics|dealership|dealer)/i
const WHOLESALER_KW = /\b(wholesale|bulk|volume\s+pricing)/i
const RETAILER_KW = /\b(retail|boutique)/i
const ECOMMERCE_KW = /\b(ecommerce|e-commerce|online\s+shop|etsy|amazon\s+seller|shopify|dropship|online\s+retail)/i
const TRADER_KW = /\b(trading|trader|import|export|import\s+export|international\s+trade)/i
/** supplier → 上下文决定：有 manufacture 则 manufacturer，否则 distributor */
const SUPPLIER_KW = /\bsupplier\b|\bsupplies\b/i

/**
 * 基于背调数据，用纯关键词匹配自动判断客户类型
 */
export function classifyByBackcheck(item: {
  backCheck?: { summary?: string; products?: string[]; markets?: string[] }
  company?: string
  website?: string
  snippet?: string
}): ClientType {
  const summary = (item.backCheck?.summary || '').toLowerCase()
  const products = (item.backCheck?.products || []).join(' ').toLowerCase()
  const markets = (item.backCheck?.markets || []).join(' ').toLowerCase()
  const company = (item.company || '').toLowerCase()
  const website = (item.website || '').toLowerCase()
  const snippet = (item.snippet || '').toLowerCase()

  const allText = [summary, products, markets, snippet].join(' ')
  const domain = website.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '')

  // Manufacturer
  if (
    MANUFACTURER_KW.test(allText) ||
    /\bmanufactur/i.test(company) ||
    /\b(factory|oem)\b/i.test(domain)
  ) return 'manufacturer'

  // Distributor
  if (
    DISTRIBUTOR_KW.test(allText) ||
    /\bdistribut/i.test(company) ||
    /\b(distributor|dealership)\b/i.test(domain)
  ) return 'distributor'

  // Wholesaler
  if (
    WHOLESALER_KW.test(allText) ||
    /\bwholesale/i.test(company) ||
    /\bwholesale\b/i.test(domain)
  ) return 'wholesaler'

  // Supplier (context-dependent: prefer distributor unless text smells like manufacturer)
  if (SUPPLIER_KW.test(allText)) {
    if (MANUFACTURER_KW.test(allText)) return 'manufacturer'
    return 'distributor'
  }

  // Retailer
  if (
    RETAILER_KW.test(allText) ||
    /\b(retail|store|shop)\b/i.test(company) ||
    /\b(shop|store)\b/i.test(domain)
  ) return 'retailer'

  // Ecommerce
  if (
    ECOMMERCE_KW.test(allText) ||
    /\b(ecom|shopify|etsy)\b/i.test(company) ||
    /\b(shopify|etsy)\b/i.test(domain)
  ) return 'ecommerce'

  // Trader
  if (
    TRADER_KW.test(allText) ||
    /\b(trading|trader|import|export)\b/i.test(company) ||
    /\b(trading|trader)\b/i.test(domain)
  ) return 'trader'

  return 'unknown'
}

// ========= 全量扫描分类 =========

/**
 * 全量扫描数据库，自动分类所有 clientType === 'unknown' 且有背调数据的项
 * @returns 更新的条目数
 */
export async function classifyExistingItems(): Promise<number> {
  const all = await getAllItems()
  let count = 0
  for (const item of all) {
    let changed = false

    // 分类 clientType
    if (item.clientType === 'unknown' && (item.backCheck?.summary || item.backCheck?.products?.length || item.backCheck?.markets?.length)) {
      const classified = classifyByBackcheck(item)
      if (classified !== 'unknown') {
        ;(item as any).clientType = classified
        changed = true
      }
    }

    // 分类 businessLine（如果还没有正确的分类）
    if (item.backCheck?.products?.length || item.backCheck?.summary) {
      const bl = classifyBusinessLine(item)
      if (bl !== item.businessLine) {
        ;(item as any).businessLine = bl
        changed = true
      }
    }

    if (changed) {
      item.updatedAt = new Date().toISOString()
      await saveItem(item)
      count++
    }
  }
  return count
}

/**
 * 使用 LLM API 对单个条目进行分类
 */
export async function classifyWithLlm(item: PipelineItem): Promise<string> {
  const payload = {
    company: item.company || '',
    website: item.website || '',
    snippet: item.snippet || '',
    summary: item.backCheck?.summary || '',
    products: item.backCheck?.products || [],
    markets: item.backCheck?.markets || [],
  }

  const resp = await fetch(`${API_BASE}/api/llm-classify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  })

  if (!resp.ok) throw new Error(`LLM classify failed: ${resp.status}`)

  const data = await resp.json()
  return data.clientType || 'unknown'
}

/**
 * 批量将 clientType === 'unknown' 且有背调摘要或公司名的条目提交 LLM 分类
 * @param onProgress 进度回调 (done, total)
 * @returns 成功分类的条目数
 */
export async function batchClassifyUnknown(
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  const all = await getAllItems()
  const unknown = all.filter(
    (i) => i.clientType === 'unknown' && (i.backCheck?.summary || i.company),
  )

  let classified = 0
  for (let i = 0; i < unknown.length; i++) {
    const item = unknown[i]
    try {
      const clientType = await classifyWithLlm(item)
      if (clientType !== 'unknown') {
        const updated: PipelineItem = {
          ...item,
          clientType: clientType as ClientType,
          updatedAt: new Date().toISOString(),
        }
        await saveItem(updated)
        classified++
      }
    } catch (err) {
      console.warn(`[batchClassify] ${item.company} failed:`, err)
    }
    onProgress?.(i + 1, unknown.length)
    await new Promise((r) => setTimeout(r, 500))
  }

  return classified
}

/**
 * 迁移：邮箱已验证但 developmentStatus 仍为 'pending' 或 undefined → 设为 'new'
 * 使这些项能进入开发工作流
 * @returns 更新的条目数
 */
export async function migrateDevStatus(): Promise<number> {
  const all = await getAllItems()
  let count = 0
  for (const item of all) {
    if (item.emailVerification !== 'verified') continue
    if (item.developmentStatus !== 'pending' && item.developmentStatus !== undefined) continue
    const updated: PipelineItem = {
      ...item,
      developmentStatus: 'new',
      updatedAt: new Date().toISOString(),
    }
    await saveItem(updated)
    count++
  }
  return count
}
