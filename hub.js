const { EventEmitter } = require('events')
const os = require('os')
const { Device } = require('./device')
const { AdmsDevice } = require('./adms-device')

const SKIP_IFACE = /^(lo|awdl|llw|bridge|utun|tun|tap|veth|docker|br-|cni|flannel|virbr|vboxnet|vmnet|vnic)/i

function isIPv4(address) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)
}

function isUsableIPv4(address) {
  if (!isIPv4(address)) return false
  if (address === '0.0.0.0') return false
  if (address.startsWith('127.')) return false
  if (address.startsWith('169.254.')) return false
  return true
}

function isUnreachableHost(host) {
  const value = String(host || '').toLowerCase()
  return !value || value === 'localhost' || value === '::1' || value.startsWith('127.') || value.startsWith('169.254.')
}

function scoreAddress(name, address) {
  let score = 0
  if (/^(en|eth|wlan|wl|wifi)/i.test(name)) score += 40
  if (address.startsWith('192.168.')) score += 30
  if (address.startsWith('10.')) score += 20
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(address)) score += 20
  return score
}

function lanIPv4() {
  const nets = os.networkInterfaces()
  const candidates = []
  for (const [name, addrs] of Object.entries(nets)) {
    if (SKIP_IFACE.test(name)) continue
    for (const item of addrs || []) {
      const family = item.family === 4 || item.family === 'IPv4'
      if (!family || item.internal || !isUsableIPv4(item.address)) continue
      candidates.push({ name, address: item.address, score: scoreAddress(name, item.address) })
    }
  }
  candidates.sort((a, b) => b.score - a.score)
  return candidates[0]?.address || ''
}

function hostnameFromHostHeader(value) {
  const host = String(value || '')
    .split(',')[0]
    .trim()
    .replace(/^\[|\]$/g, '')
  if (!host) return ''
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    return end > 0 ? host.slice(1, end) : ''
  }
  return host.split(':')[0].trim()
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

  resolveAdmsHost(req) {
    const fromEnv = String(this.config.admsHost || process.env.ZK_ADMS_HOST || '').trim()
    if (fromEnv) return fromEnv

    const header = req && (req.headers['x-forwarded-host'] || req.headers.host)
    const fromReq = hostnameFromHostHeader(header)
    if (fromReq && !isUnreachableHost(fromReq)) return fromReq

    return lanIPv4() || '127.0.0.1'
  }

  admsUrl(req) {
    return `http://${this.resolveAdmsHost(req)}:${this.port}/iclock/`
  }

  getState(req) {
    const admsHost = this.resolveAdmsHost(req)
    return {
      mode: this.mode,
      admsHost,
      admsPort: this.port,
      admsUrl: `http://${admsHost}:${this.port}/iclock/`,
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
