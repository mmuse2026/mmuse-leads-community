const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { createRequire } = require('node:module')
const { DatabaseSync } = require('node:sqlite')

const project = path.join(__dirname, 'MMUSEOPS')
const load = createRequire(path.join(project, 'package.json'))
const originalVersion = 'v22.22.3'
const excluded = /(?:^|\/)(?:formal-reply-consumer|smtp-handshake|testmail-dns-verify|testmail-enqueue-consumer|testmail-recovery-consumer)\.ts$/

function execute(executable, args, cwd) {
  const result = spawnSync(executable, args, { cwd, stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Command exited with status ${result.status}`)
}

function putNewJson(file, value) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(value) + '\n', { flag: 'wx' })
}

async function build(runtimeRoot) {
  if (process.platform !== 'win32' || process.arch !== 'x64' || process.version !== originalVersion) {
    throw new Error(`A Windows x64 Node.js ${originalVersion} installation is required for this build.`)
  }
  if (!runtimeRoot) throw new Error('Supply the extracted Windows release directory as the first argument.')
  const runtime = fs.realpathSync(runtimeRoot)
  if (runtime.toLowerCase() === fs.realpathSync(__dirname).toLowerCase()) {
    throw new Error('Keep the source and extracted Windows release in separate directories.')
  }
  const browser = path.join(runtime, 'runtime', 'crawl', 'browser')
  for (const file of ['node.exe', 'runtime/crawl/python.exe', 'runtime/crawl/browser']) {
    if (!fs.existsSync(path.join(runtime, file))) throw new Error(`Windows release runtime is missing ${file}`)
  }
  if (!fs.statSync(browser).isDirectory()) throw new Error('Expected a bundled browser directory.')
  const version = spawnSync(path.join(runtime, 'node.exe'), ['--version'], { encoding: 'utf8', windowsHide: true })
  if (version.status !== 0 || version.stdout.trim() !== originalVersion) {
    throw new Error(`The supplied Windows release does not contain Node.js ${originalVersion}.`)
  }

  const sourceFiles = JSON.parse(fs.readFileSync(path.join(project, 'backend-sources.json'), 'utf8'))
  if (!Array.isArray(sourceFiles) || !sourceFiles.includes('server/search-api.ts') ||
      new Set(sourceFiles).size !== sourceFiles.length || sourceFiles.some(file => (
        typeof file !== 'string' || !/^(?:server|src)\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.tsx?$/.test(file) ||
        excluded.test(file) || !fs.statSync(path.join(project, file), { throwIfNoEntry: false })?.isFile()
      ))) throw new Error('Backend source manifest is incomplete or invalid.')

  const vite = path.join(path.dirname(load.resolve('vite/package.json')), 'bin', 'vite.js')
  const dist = path.join(project, 'dist')
  if (fs.existsSync(dist) && fs.realpathSync(dist).toLowerCase() !== path.join(fs.realpathSync(project), 'dist').toLowerCase()) {
    throw new Error('The frontend output directory points outside the expected build location.')
  }
  execute(process.execPath, [vite, 'build', '--outDir', dist, '--emptyOutDir'], path.join(project, 'frontend'))
  await load('esbuild').build({
    absWorkingDir: project,
    entryPoints: sourceFiles,
    platform: 'node',
    format: 'cjs',
    outbase: '.',
    outdir: '.',
    logLevel: 'error',
    supported: { 'import-meta': false },
    define: { 'import.meta.url': '__probeModuleUrl' },
    banner: { js: 'const __probeModuleUrl = require("node:url").pathToFileURL(__filename).href;' },
  })

  const databaseDirectory = path.join(project, 'data', 'business-lines')
  fs.mkdirSync(databaseDirectory, { recursive: true })
  putNewJson(path.join(project, 'items_store.json'), [])
  putNewJson(path.join(project, 'user_config.json'), {})
  putNewJson(path.join(databaseDirectory, 'carseat.json'), [])
  putNewJson(path.join(databaseDirectory, 'holding.json'), [])
  putNewJson(path.join(databaseDirectory, 'migration.json'), { state: 'committed', active: true })
  const db = new DatabaseSync(path.join(databaseDirectory, 'wool.sqlite3'))
  try {
    db.exec('CREATE TABLE IF NOT EXISTS customers(stable_id TEXT PRIMARY KEY, company TEXT, country TEXT, website TEXT)')
  } finally {
    db.close()
  }

  const bundledNode = path.join(__dirname, 'node.exe')
  if (!fs.existsSync(bundledNode)) fs.copyFileSync(path.join(runtime, 'node.exe'), bundledNode, fs.constants.COPYFILE_EXCL)
  const crawlRuntime = path.join(__dirname, 'runtime', 'crawl')
  if (!fs.existsSync(crawlRuntime)) fs.cpSync(path.join(runtime, 'runtime', 'crawl'), crawlRuntime, { recursive: true, errorOnExist: true, force: false })
  if (!fs.existsSync(path.join(crawlRuntime, 'python.exe')) || !fs.existsSync(path.join(crawlRuntime, 'browser'))) {
    throw new Error('This source directory contains an incomplete crawler runtime. Build in a fresh source directory.')
  }
  console.log('缪斯获客管理社区版构建完成。请双击 Start-MMUSE.cmd 启动。')
}

build(process.argv[2]).catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
