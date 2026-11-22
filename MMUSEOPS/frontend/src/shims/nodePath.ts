/**
 * 浏览器端 node:path 兼容垫片（仅用于让 vite build/dev 通过）。
 *
 * 后端服务始终用真实 node:path；本垫片只被 vite 浏览器构建引用
 * （resolve.alias 'node:path'），只补 join 足够让模块可加载（值在浏览器侧无实际用途）。
 */
export function join(...parts: (string | null | undefined)[]): string {
  return parts.filter((p) => typeof p === 'string' && p !== '').join('/').replace(/\/+/g, '/')
}
