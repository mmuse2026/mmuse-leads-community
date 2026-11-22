export function appliedSearchUsage(requested: number, failed: number): number {
  return Math.max(0, Math.max(0, requested) - Math.max(0, failed))
}
