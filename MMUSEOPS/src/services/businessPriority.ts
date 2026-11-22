export function isDevelopmentPriorityEligible(item: any): boolean {
  const match = String(item?.businessMatch || '').trim().toLowerCase()
  return match === 'high' || match === 'medium'
}
