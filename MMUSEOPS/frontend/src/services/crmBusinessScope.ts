/** Explicit sales scope. Industry resemblance never selects a sender/profile. */
export function crmBusinessScope(value: unknown): 'furniture' | 'carseat' | 'wool' | null {
  const line = String(value ?? '').trim().toLowerCase()
  if (line === 'furniture' || line === 'furniture supplier') return 'furniture'
  if (line === 'car-seat' || line === 'carseat') return 'carseat'
  if (line === 'wool' || line === 'knitwear') return 'wool'
  return null
}

export function productionProfileId(value: unknown): 'furniture' | 'auto' | null {
  const line = crmBusinessScope(value)
  return line === 'carseat' ? 'auto' : line === 'furniture' ? 'furniture' : null
}
