/** One foreground search owner across SPA routes; durable checkpoint, not a second queue. */
export interface SearchCheckpoint { status: 'running' | 'saved' | 'failed' | 'interrupted'; input: any; progress: any; error?: string; updatedAt: string }
export function createSearchRuntime(storage: Pick<Storage, 'getItem' | 'setItem'>) {
 const key = 'mmuse_search_checkpoint'
 let active = false
 let current: SearchCheckpoint | null = null
 const listeners = new Set<() => void>()
 try { current = JSON.parse(storage.getItem(key) || 'null'); if (current?.status === 'running') current.status = 'interrupted' } catch {}
 function publish() { storage.setItem(key, JSON.stringify(current)); for (const listener of listeners) listener() }
 return {
  read: () => current,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
  async run(input: any, work: (update: (progress: any) => void) => Promise<void>) {
   if (active) throw new Error('Search already running')
   current = { status: 'running', input, progress: null, updatedAt: new Date().toISOString() }
   try { publish() } catch (error) {
    current = { ...current, status: 'failed', error: String(error) }
    for (const listener of listeners) listener()
    throw error // Preserve the original storage error; provider has not been called.
   }
   active = true
   try {
    await work(progress => { current = { ...current!, progress, updatedAt: new Date().toISOString() }; publish() })
    current = { ...current!, status: 'saved', updatedAt: new Date().toISOString() }; publish()
   } catch (error) {
    current = { ...current!, status: 'failed', error: String(error), updatedAt: new Date().toISOString() }; try { publish() } catch { for (const listener of listeners) listener() }; throw error
   } finally { active = false }
  },
 }
}
let runtime: ReturnType<typeof createSearchRuntime> | undefined
export function getSearchRuntime() { return runtime ||= createSearchRuntime(localStorage) }
