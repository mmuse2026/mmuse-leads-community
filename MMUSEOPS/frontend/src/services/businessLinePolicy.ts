



const CARSEAT_BL = /car[\s_-]?seat/i
// 汽车/汽车座椅套行业强词（2026-08-11 主公指正：部分汽车公司 businessLine 被误标为
// 'Furniture Supplier'，仅看 businessLine 匹配不到；company/title/website 命中即视为汽车行业）。
const AUTO_INDICATOR = /(carseat|car[\s_-]?seat|car[\s_-]?covers?|seat[\s_-]?covers?|vehicle[\s_-]?seat|automotive|auto[\s_-]?(leder|zubeh|part|accessor|motive)|car[\s_-]?(accessor|part|mart|care|fit|cover)|fit[\s_-]?my[\s_-]?car|motor[\s_-]?(world|mart)|auto[\s_-]?choice)/i
/** 是否属于汽车/汽车座椅套业务线（businessLine 命中 car-seat，或 company/title/website 命中汽车行业强词）。 */
export function isCarseatBusinessLine(item: any): boolean {
  if (!item) return false
  if (CARSEAT_BL.test(String(item.businessLine || ''))) return true
  const hay = [item.company, item.title, item.website, item.normalizedDomain].filter(Boolean).join(' | ')
  return AUTO_INDICATOR.test(hay)
}
/** 家具发信身份（OFFICIAL_OUTREACH_EMAIL）是否允许向该客户发送：car-seat 客户一律禁止。 */
export function furnitureChannelAllows(item: any): boolean {
  // An exclusion list is not an identity: wool and missing/unknown labels
  // must never inherit the furniture sender just because they are not cars.
  const line = String(item?.businessLine || '').trim().toLowerCase()
  return ['furniture', 'furniture supplier'].includes(line) && !isCarseatBusinessLine(item)
}
