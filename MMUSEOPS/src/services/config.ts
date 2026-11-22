/** Test-copy API endpoint. A build-time override keeps ports explicit. */
const buildEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
const runtimeEnv = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env

export function resolveApiBase(
  browserEnv?: Record<string, string | undefined>,
  nodeEnv?: Record<string, string | undefined>,
): string {
  return browserEnv?.VITE_MMUSE_API_BASE || nodeEnv?.MMUSE_API_BASE || 'http://127.0.0.1:3181'
}

export const API_BASE = resolveApiBase(buildEnv, runtimeEnv)