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
  if (!host) return ''
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    return end > 0 ? host.slice(1, end) : ''
  }
  return host.replace(/^https?:\/\//, '').split('/')[0].split(':')[0].trim()
}

function envPublicHost() {
  for (const value of [
    process.env.ZK_ADMS_HOST,
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
    process.env.VERCEL_URL,
  ]) {
    const host = hostnameFromHostHeader(value)
    if (host && !isUnreachableHost(host)) return host
  }
  return ''
}

function requestHost(req) {
  if (!req?.headers) return ''
  return hostnameFromHostHeader(
    req.headers['x-forwarded-host'] || req.headers['x-vercel-forwarded-host'] || req.headers.host,
  )
}

function requestProto(req, host) {
  const forwarded = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim()
  if (forwarded === 'https' || forwarded === 'http') return forwarded
  if (process.env.VERCEL || /\.vercel\.app$/i.test(host)) return 'https'
  return 'http'
}

class Hub extends EventEmitter {
  constructor(config) {
    super()
    this.config = config
    this.mode = config.mode === 'adms' ? 'adms' : 'sdk'
    this.port = config.httpPort
    this.sdk = new Device(config)
    this.adms = new AdmsDevice()
    this.lastAdmsHost = ''
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

  resolveAdms(req) {
    if (process.env.VERCEL) {
      const host =
        hostnameFromHostHeader(this.config.admsHost) ||
        hostnameFromHostHeader(process.env.VERCEL_PROJECT_PRODUCTION_URL) ||
        hostnameFromHostHeader(process.env.VERCEL_URL) ||
        'zhemmo.vercel.app'
      return {
        host,
        port: 443,
        https: true,
        domainName: true,
        url: `https://${host}/iclock/`,
      }
    }

    const configured = hostnameFromHostHeader(this.config.admsHost)
    const fromReq = requestHost(req)
    if (fromReq && !isUnreachableHost(fromReq)) this.lastAdmsHost = fromReq

    const host =
      (configured && !isUnreachableHost(configured) && configured) ||
      lanIPv4() ||
      this.lastAdmsHost ||
      (fromReq && !isUnreachableHost(fromReq) && fromReq) ||
      envPublicHost() ||
      '127.0.0.1'

    const https = requestProto(req, host) === 'https'
    const domainName = !isIPv4(host)
    const port = Number(process.env.ZK_ADMS_PORT) || (https ? 443 : domainName ? 80 : this.port)
    const origin = https
      ? `https://${host}${port === 443 ? '' : `:${port}`}`
      : `http://${host}${port === 80 ? '' : `:${port}`}`

    return {
      host,
      port,
      https,
      domainName,
      url: `${origin}/iclock/`,
    }
  }

  resolveAdmsHost(req) {
    return this.resolveAdms(req).host
  }

  admsUrl(req) {
    return this.resolveAdms(req).url
  }

  getState(req) {
    const adms = this.resolveAdms(req)
    return {
      mode: this.mode,
      admsHost: adms.host,
      admsPort: adms.port,
      admsHttps: adms.https,
      admsDomainName: adms.domainName,
      admsUrl: adms.url,
      ...this.active.getState(),
    }
  }

  async hydrate() {
    await this.adms.hydrate()
  }

  async persist() {
    await this.adms.persist()
  }

  async start() {
    if (process.env.VERCEL) this.mode = 'adms'
    await this.hydrate()
    if (this.mode === 'sdk') {
      await this.sdk.start()
    } else {
      await this.adms.start()
    }
  }

  async setMode(mode, req) {
    if (process.env.VERCEL) {
      this.mode = 'adms'
      return this.getState(req)
    }
    const next = mode === 'adms' ? 'adms' : 'sdk'
    if (next === this.mode) return this.getState(req)
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
    const state = this.getState(req)
    this.emit('status', state)
    return state
  }

  async refresh(req) {
    await this.active.refresh()
    return this.getState(req)
  }

  async setUser(input, req) {
    await this.active.setUser(input)
    return this.getState(req)
  }

  async deleteUser(uid, req) {
    await this.active.deleteUser(uid)
    return this.getState(req)
  }

  async clearLogs(req) {
    await this.active.clearLogs()
    return this.getState(req)
  }
}

module.exports = { Hub, lanIPv4 }
