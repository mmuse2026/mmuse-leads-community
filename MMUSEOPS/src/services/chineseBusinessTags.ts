const text = (value: unknown) => String(value ?? '').trim().toLowerCase()
const list = (value: unknown): string[] => Array.isArray(value) ? value.map(text).filter(Boolean) : text(value) ? [text(value)] : []
const firstKnown = (...values: unknown[]) => values.map(text).find(value => value && !/^(unknown|待定|未明确)$/.test(value)) || ''

function customerType(item: any): string {
  const value = firstKnown(item?.customerType, item?.customerTypeAssessment, item?.clientType)
  if (/hotel|resort|酒店|宾馆/.test(value)) return '酒店'
  if (/restaurant|cafe|bar|餐厅|餐馆|咖啡/.test(value)) return '餐厅'
  if (/design|architect|设计|建筑/.test(value)) return '设计公司'
  if (/distributor|dealer|wholesale|trader|retail|经销|批发|贸易|零售/.test(value)) return '经销商'
  if (/buyer|procurement|purchas|采购/.test(value)) return '采购商'
  if (/project|contractor|developer|项目|工程/.test(value)) return '项目商'
  return '其他'
}

function productType(value: string): string | undefined {
  if (/outdoor|patio|garden|户外|庭院/.test(value)) return '户外家具'
  if (/chair|seat|seating|banquette|booth|stool|椅|座椅|卡座/.test(value)) return '座椅'
  if (/sofa|couch|lounge|沙发/.test(value)) return '沙发'
  if (/table|desk|console|桌/.test(value)) return '桌类'
  if (/bed|mattress|床/.test(value)) return '床类'
  if (/cabinet|wardrobe|storage|shelf|柜|收纳/.test(value)) return '柜类'
  if (/furniture|full.?range|家具|家居/.test(value)) return '综合家具'
}

function productTypes(item: any): string[] {
  const values = [
    ...list(item?.mainProducts),
    ...list(item?.products),
    ...list(item?.product),
    ...list(item?.category),
    ...list(item?.backCheck?.mainProducts),
    ...list(item?.backCheck?.products),
    ...list(item?.backcheck?.mainProducts),
    ...list(item?.backcheck?.products),
    ...list(item?.furnitureData?.category),
  ]
  const mapped = values.map(productType).filter((value): value is string => Boolean(value))
  return [...new Set(mapped)].slice(0, 2)
}

function valueLevel(item: any): string | undefined {
  const value = firstKnown(item?.businessMatch, item?.importCommercialValue)
  if (/^high$|高价值|高$/.test(value)) return '高价值'
  if (/^medium$|^mid$|中价值|中$/.test(value)) return '中价值'
  if (/^low$|^none$|低价值|低$/.test(value)) return '低价值'
}

export function buildChineseTags(item: unknown): string[] {
  const current = item as any
  const products = productTypes(current)
  const tags = [`客户类型：${customerType(current)}`]
  for (const product of products.length ? products : ['未明确']) tags.push(`需求品类：${product}`)
  const value = valueLevel(current)
  if (value) tags.push(`价值等级：${value}`)
  return tags
}
