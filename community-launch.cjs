const fs = require('node:fs')
const path = require('node:path')
const { spawn, execFile } = require('node:child_process')
const { handleCrawlMessage } = require('./crawl-worker.cjs')

const directory = fs.realpathSync(__dirname)
const flags = process.argv.slice(2)
const portArgument = flags.find(value => value.startsWith('--port='))
const port = portArgument ? Number(portArgument.slice(7)) : 48396
if (!Number.isInteger(port) || port < 1024 || port > 65535 ||
    flags.some(value => value !== portArgument && value !== '--no-browser')) {
  console.error('启动参数无效。')
  process.exit(2)
}
const local = path.join(directory, 'MMUSEOPS', 'local-profile')
fs.mkdirSync(local, { recursive: true })
const environment = {}
for (const key of ['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT']) {
  if (process.env[key]) environment[key] = process.env[key]
}
for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']) environment[key] = local
Object.assign(environment, {
  PORT: String(port),
  MMUSEOPS_TEST_WOOL_PATH: path.join(directory, 'MMUSEOPS', 'data', 'business-lines', 'wool.sqlite3'),
  PIPELINE_AUTO_ENABLED: 'true',
  MMUSEOPS_BACKGROUND_DISABLED: 'false',
  MMUSEOPS_SAFE_MODE: 'false',
  ALLOW_TEST_MAIL_SEND: 'false',
  SMTP_REAL_HANDSHAKE: '0',
  CRAWL4_AI_BASE_DIRECTORY: local,
})
const child = spawn(process.execPath, [
  '--permission', `--allow-fs-read=${directory}`, `--allow-fs-write=${directory}`,
  '--require', path.join(directory, 'community-runtime.cjs'),
  path.join(directory, 'MMUSEOPS', 'server', 'search-api.js'),
], { cwd: directory, env: environment, stdio: ['ignore', 'pipe', 'inherit', 'ipc'], windowsHide: true })
child.on('message', message => handleCrawlMessage(child, directory, message, environment))

console.log('正在启动缪斯获客管理社区版…')
let pending = ''
child.stdout.on('data', chunk => {
  process.stdout.write(chunk)
  pending += chunk.toString()
  const lines = pending.split('\n')
  pending = lines.pop()
  if (lines.some(line => line.trim() === `MMUSE_COMMUNITY_PORT=${port}`) && !flags.includes('--no-browser')) {
    const opener = path.join(environment.SYSTEMROOT || 'C:\\Windows', 'System32', 'rundll32.exe')
    execFile(opener, ['url.dll,FileProtocolHandler', `http://127.0.0.1:${port}/`], { windowsHide: true }, () => {})
  }
})
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
process.on('SIGINT', () => child.kill())
process.on('SIGTERM', () => child.kill())
