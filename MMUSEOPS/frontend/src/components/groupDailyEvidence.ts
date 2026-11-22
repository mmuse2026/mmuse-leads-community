/** Presentation only. Group by stable customer ID; never merge by company/email.
 * Every input occurrence is retained, including repeated evidence objects.
 */
export function groupDailyEvidence<T extends { id?: string }>(rows: readonly T[]) {
  const groups = new Map<string, T[]>()
  rows.forEach((row, index) => {
    const key = row.id ? `customer:${row.id}` : `unidentified:${index}`
    const group = groups.get(key)
    if (group) group.push(row)
    else groups.set(key, [row])
  })
  return [...groups].map(([key, evidence]) => ({ key, evidence }))
}
