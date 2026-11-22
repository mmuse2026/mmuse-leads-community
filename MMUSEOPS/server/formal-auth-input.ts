import type http from 'node:http'
import { FORMAL_CSRF_HEADER, FORMAL_OPERATOR_HEADER } from '../src/services/formalQueueAuth'

export function readFormalHeader(req: http.IncomingMessage, name: string): string {
  return String(req.headers[name.toLowerCase()] || '')
}

export function formalAuthInput(req: http.IncomingMessage) {
  return {
    origin: String(req.headers.origin || ''),
    remoteAddress: String(req.socket.remoteAddress || ''),
    operatorToken: readFormalHeader(req, FORMAL_OPERATOR_HEADER),
    csrfToken: readFormalHeader(req, FORMAL_CSRF_HEADER),
  }
}
