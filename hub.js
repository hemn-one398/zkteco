const { EventEmitter } = require('events')
const os = require('os')
const { Device } = require('./device')
const { AdmsDevice } = require('./adms-device')

function lanIPv4() {
  const nets = os.networkInterfaces()
  for (const addrs of Object.values(nets)) {
    for (const item of addrs || []) {
      const family = item.family === 4 || item.family === 'IPv4'
      if (family && !item.internal) return item.address
    }
  }
  return '127.0.0.1'
}

class Hub extends EventEmitter {
  constructor(config) {
    super()
    this.config = config
    this.mode = config.mode === 'adms' ? 'adms' : 'sdk'
    this.port = config.httpPort
    this.sdk = new Device(config)
    this.adms = new AdmsDevice()
    this.bind(this.sdk)
    this.bind(this.adms)
  }

  bind(source) {
    source.on('punch', (punch) => {
      if (this.active === source) this.emit('punch', punch)
    })
    source.on('status', () => {
      if (this.active === source) this.emit('status', this.getState())
    })
  }

  get active() {
    return this.mode === 'adms' ? this.adms : this.sdk
  }

  admsUrl() {
    return `http://${lanIPv4()}:${this.port}/iclock/`
  }

  getState() {
    return {
      mode: this.mode,
      admsUrl: this.admsUrl(),
      ...this.active.getState(),
    }
  }

  async start() {
    if (this.mode === 'sdk') {
      await this.sdk.start()
    } else {
      await this.adms.start()
    }
  }

  async setMode(mode) {
    const next = mode === 'adms' ? 'adms' : 'sdk'
    if (next === this.mode) return this.getState()
    if (this.mode === 'sdk') {
      try {
        await this.sdk.disconnect()
      } catch {
        // already closed
      }
    }
    this.mode = next
    if (next === 'sdk') {
      await this.sdk.start()
    } else {
      await this.adms.start()
    }
    this.emit('status', this.getState())
    return this.getState()
  }

  refresh() {
    return this.active.refresh()
  }

  setUser(input) {
    return this.active.setUser(input)
  }

  deleteUser(uid) {
    return this.active.deleteUser(uid)
  }

  clearLogs() {
    return this.active.clearLogs()
  }
}

module.exports = { Hub, lanIPv4 }
