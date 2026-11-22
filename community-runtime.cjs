const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const sqlite = require('node:sqlite')

const root = fs.realpathSync(__dirname)
const port = Number(process.env.PORT)
console.log(`MMUSE_REVIEW_PID=${process.pid}`)

sqlite.DatabaseSync = class extends sqlite.DatabaseSync {
  constructor(location, ...options) {
    if (location !== ':memory:') {
      const filename = path.resolve(location)
      const folder = fs.realpathSync(path.dirname(filename))
      const real = fs.existsSync(filename) ? fs.realpathSync(filename) : path.join(folder, path.basename(filename))
      if (!real.toLowerCase().startsWith(root.toLowerCase() + path.sep)) throw new Error('MMUSE_LOCAL_DATABASE_ONLY')
    }
    super(location, ...options)
  }
}

const listen = net.Server.prototype.listen
net.Server.prototype.listen = function (chosenPort, host, ...args) {
  if (chosenPort !== port || host !== '127.0.0.1') throw new Error('MMUSE_LOOPBACK_LISTENER_ONLY')
  this.once('listening', () => console.log(`MMUSE_COMMUNITY_PORT=${this.address().port}`))
  return listen.call(this, chosenPort, host, ...args)
}
