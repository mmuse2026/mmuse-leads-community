const { execFile } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const active = new WeakMap()
const maxConcurrent = 2

function asArgument(value, limit) {
  return typeof value === 'string' && value.length > 0 && value.length <= limit &&
    !value.startsWith('-') && !/[\x00-\x1f\x7f]/.test(value)
}

function argumentsFor(request) {
  if (!request || typeof request !== 'object') return null
  if (request.url !== undefined) {
    if (!asArgument(request.url, 2048)) return null
    try {
      if (request.url.includes('://') && !/^https?:\/\//i.test(request.url)) return null
      const text = /^https?:\/\//i.test(request.url) ? request.url : `https://${request.url}`
      const url = new URL(text)
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null
      return [url.href, '--json']
    } catch {
      return null
    }
  }
  if (!asArgument(request.company, 250)) return null
  const args = ['--company', request.company]
  for (const [field, flag, limit] of [['country', '--country', 80], ['business', '--business', 240]]) {
    if (request[field] !== undefined && request[field] !== '') {
      if (!asArgument(request[field], limit)) return null
      args.push(flag, request[field])
    }
  }
  return [...args, '--json']
}

function handleCrawlMessage(child, directory, message, environment) {
  if (message?.type !== 'mmuse:crawl-request') return false
  if (typeof message.id !== 'string' || !/^[0-9a-f-]{36}$/.test(message.id)) return true
  const reply = fields => {
    if (child.connected) child.send({ type: 'mmuse:crawl-result', id: message.id, ...fields }, () => {})
  }
  const args = argumentsFor(message.request)
  if (!args) {
    reply({ error: 'CRAWL_REQUEST_INVALID' })
    return true
  }
  const jobs = active.get(child) || new Set()
  active.set(child, jobs)
  if (jobs.has(message.id) || jobs.size >= maxConcurrent) {
    reply({ error: 'CRAWL_BUSY_RETRY' })
    return true
  }
  const runtime = path.join(directory, 'runtime', 'crawl')
  const python = path.join(runtime, 'python.exe')
  const script = path.join(directory, 'MMUSEOPS', 'scripts', 'crawl4ai_backcheck.py')
  const browsers = path.join(runtime, 'browser')
  if (![python, script, browsers].every(file => fs.existsSync(file))) {
    reply({ error: 'CRAWL_RUNTIME_UNAVAILABLE' })
    return true
  }
  const env = { ...environment, PLAYWRIGHT_BROWSERS_PATH: browsers, LITELLM_LOCAL_MODEL_COST_MAP: 'True' }
  const cancel = new AbortController()
  const onDisconnect = () => cancel.abort()
  jobs.add(message.id)
  child.once('disconnect', onDisconnect)
  execFile(python, ['-I', '-B', '-u', '-X', 'utf8', script, ...args], {
    cwd: environment.TEMP || directory,
    env,
    timeout: 35_000,
    maxBuffer: 2 * 1024 * 1024,
    signal: cancel.signal,
    windowsHide: true,
  }, (error, stdout, stderr) => {
    child.removeListener('disconnect', onDisconnect)
    jobs.delete(message.id)
    if (error) {
      reply({ error: error.killed ? 'CRAWL_RUNTIME_TIMEOUT' : 'CRAWL_RUNTIME_FAILED' })
    } else {
      reply({ stdout, stderr })
    }
  })
  return true
}

module.exports = { handleCrawlMessage }
