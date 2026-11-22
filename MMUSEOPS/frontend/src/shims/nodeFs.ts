/**
 * 浏览器端 node:fs 兼容垫片（仅用于让 vite build/dev 通过）。
 *
 * 后端服务（search-api / pipeline）始终用真实 node:fs；本垫片只被 vite 浏览器构建
 * 引用（resolve.alias 'node:fs'）。真正需要读 user_config.json 的 getActiveProfile
 * 内部有 try/catch 兜底（找不到/异常回退 default），浏览器侧抛错即回退，页面不崩。
 */
export function readFileSync(): never {
  throw new Error('node:fs not available in browser')
}

export function statSync(): never {
  throw new Error('node:fs not available in browser')
}
