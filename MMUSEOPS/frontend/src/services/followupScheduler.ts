export function startFollowupScheduler(): { ok: boolean; message: string } {
  return { ok: false, message: 'DEPRECATED_ENTRY: use the persisted followup_queue; no interval is started.' }
}
export function stopFollowupScheduler(): void {}
export function getSchedulerStatus() { return { running: false, deprecated: true, intervalDays: 7, maxFollowups: 2 } }
export async function triggerFollowupNow() { return { checked: 0, sent: 0, errors: 0, deprecated: true } }