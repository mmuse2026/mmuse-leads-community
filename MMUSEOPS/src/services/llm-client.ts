/**
 * 共享 LLM 客户端（双通道：主通道 WebModel 网关 → DeepSeek 兜底）
 *
 * 从 draft-quality-gate（draftQualityGate.ts）抽出的通用 LLM 调用模块，
 * 供 LLM 定向草稿生成器（生成端）与草稿重写闭环（消费端）等复用。
 *
 * 安全约定：apiKey 只读不打印，任何日志/console 输出绝不包含 apiKey 明文。
 */

import { Agent } from 'undici'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// undici 对 loopback 也会走全局 ProxyAgent 隧道（v2rayN 会关闭），必须直连。
// 参考 server/search-api.ts 的 directDispatcher 同款处理。
const directDispatcher = new Agent()

const CONFIG_URL = new URL('../../user_config.json', import.meta.url)
export const LOCAL_WEBMODEL_BASE_URL = ''
export const LOCAL_WEBMODEL_MODEL = ''
export const LOCAL_WEBMODEL_API_KEY = ''

export interface LlmConfig {
  baseUrl: string
  apiKey: string
  model: string
  backupBaseUrl: string
  backupApiKey: string
  backupModel: string
}

export function resolveHermesLocalApiKey(): string { return '' }

export function isHermesLocalBaseUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
  } catch {
    return false
  }
}

export function normalizeLlmBaseUrl(value: string): string {
  if (!value) return ''
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('LLM_BASE_URL_INVALID')
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new Error('LLM_BASE_URL_INVALID')
  }
  return value.replace(/\/+$/, '')
}

export function loadLlmConfig(): LlmConfig {
  const fallback: LlmConfig = {
    baseUrl: LOCAL_WEBMODEL_BASE_URL,
    apiKey: LOCAL_WEBMODEL_API_KEY,
    model: LOCAL_WEBMODEL_MODEL,
    backupBaseUrl: LOCAL_WEBMODEL_BASE_URL,
    backupApiKey: '',
    backupModel: LOCAL_WEBMODEL_MODEL,
  }
  try {
    const raw = readFileSync(fileURLToPath(CONFIG_URL), 'utf8')
    const cfg = JSON.parse(raw) as Record<string, unknown>
    const backupEnabled = cfg.llmBackupEnabled !== false
    return {
      baseUrl: normalizeLlmBaseUrl(String(cfg.llmBaseUrl || fallback.baseUrl)),
      apiKey: String(cfg.llmApiKey || fallback.apiKey),
      model: String(cfg.llmModel || fallback.model),
      backupBaseUrl: normalizeLlmBaseUrl(String(cfg.llmBackupBaseUrl || fallback.backupBaseUrl)),
      backupApiKey: backupEnabled ? String(cfg.llmBackupApiKey || LOCAL_WEBMODEL_API_KEY) : '',
      backupModel: String(cfg.llmBackupModel || fallback.backupModel),
    }
  } catch {
    return fallback
  }
}

async function fetchWithTimeout(url: string, options: RequestInit & { timeout?: number }): Promise<Response> {
  const timeout = options.timeout || 30000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

export async function llmChatOnce(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: { role: string; content: string }[],
  timeout: number,
): Promise<Record<string, unknown>> {
  const localBaseUrl = normalizeLlmBaseUrl(baseUrl)
  const resp = await fetchWithTimeout(`${localBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0,
      response_format: { type: 'json_object' as const },
    }),
    timeout,
    ...(isHermesLocalBaseUrl(localBaseUrl) ? { dispatcher: directDispatcher } : {}),
  })
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`LLM API error: ${resp.status}: ${errText.slice(0, 200)}`)
  }
  const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] }
  let content = data.choices?.[0]?.message?.content || '{}'
  if (content.startsWith('```')) content = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  return JSON.parse(content) as Record<string, unknown>
}

/** LLM 主通道（本地网关）失败后自动切 DeepSeek 兜底。返回 null 表示双通道都失败。 */
export async function llmChatWithFallback(messages: { role: string; content: string }[], timeout: number): Promise<Record<string, unknown> | null> {
  const cfg = loadLlmConfig()
  if (!cfg.apiKey || !cfg.baseUrl || !cfg.model) return null
  try {
    return await llmChatOnce(cfg.baseUrl, cfg.apiKey, cfg.model, messages, timeout)
  } catch (primaryErr) {
    const primaryMsg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr)
    if (!cfg.backupApiKey) {
      console.log(`[llm-client] primary failed, no backup key (${primaryMsg})`)
      return null
    }
    try {
      console.log(`[llm-client] primary failed -> backup (${primaryMsg})`)
      return await llmChatOnce(cfg.backupBaseUrl, cfg.backupApiKey, cfg.backupModel, messages, timeout)
    } catch (backupErr) {
      console.log(`[llm-client] backup failed: ${backupErr instanceof Error ? backupErr.message : String(backupErr)}`)
      return null
    }
  }
}
