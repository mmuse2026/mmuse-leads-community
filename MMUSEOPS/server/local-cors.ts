import type { IncomingMessage, ServerResponse } from 'node:http'
import { FORMAL_CSRF_HEADER, FORMAL_OPERATOR_HEADER, FORMAL_SEND_GRANT_HEADER } from '../src/services/formalQueueAuth'

export const LOCAL_UI_ORIGINS = new Set([`http://127.0.0.1:${process.env.PORT}`])
export const LOCAL_CORS_HEADERS = ['Content-Type', FORMAL_OPERATOR_HEADER, FORMAL_CSRF_HEADER, FORMAL_SEND_GRANT_HEADER].join(', ')

export function applyLocalCors(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = String(req.headers.origin || '')
  const allowed = LOCAL_UI_ORIGINS.has(origin)
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', LOCAL_CORS_HEADERS)
  res.setHeader('Access-Control-Max-Age', '86400')
  if (req.method !== 'OPTIONS') return false
  res.writeHead(allowed ? 204 : 403)
  res.end()
  return true
}
