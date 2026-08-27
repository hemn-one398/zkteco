/**
 * ZKTeco ADMS (iclock) HTTP protocol.
 * Ported from https://github.com/s0x90/zkteco-adms
 */

const express = require('express')

const SN_RE = /^[A-Za-z0-9_-]{1,64}$/

function parseDeviceTime(value) {
  const text = String(value || '').trim()
  const stamp = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/)
  if (stamp) {
    return new Date(
      Number(stamp[1]),
      Number(stamp[2]) - 1,
      Number(stamp[3]),
      Number(stamp[4]),
      Number(stamp[5]),
      Number(stamp[6]),
    )
  }
  const epoch = Number(text)
  if (Number.isFinite(epoch) && epoch > 1e9) return new Date(epoch * 1000)
  return null
}

function parseKv(data, sep, transformKey) {
  const info = {}
  for (const part of String(data || '').split(sep)) {
    const trimmed = part.trim()
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    let key = trimmed.slice(0, eq).trim()
    if (transformKey) key = transformKey(key)
    info[key] = trimmed.slice(eq + 1).trim()
  }
  return info
}

function parseAttendance(body, serial) {
  const records = []
  for (const raw of String(body || '').split('\n')) {
    const line = raw.replace(/\r$/, '').trim()
    if (!line) continue
    let parts = line.split('\t')
    if (parts.length < 2) {
      const match = line.match(/^(\S+)\s+(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})(?:\s+(\S+))?(?:\s+(\S+))?(?:\s+(\S+))?/)
      if (!match) continue
      parts = [match[1], match[2], match[3], match[4], match[5]]
    }
    const userId = String(parts[0] || '').trim()
    const time = parseDeviceTime(parts[1])
    if (!userId || !time || Number.isNaN(time.getTime())) continue
    records.push({
      userId,
      time: time.toISOString(),
      status: Number(parts[2] || 0) || 0,
      verifyMode: Number(parts[3] || 0) || 0,
      workCode: parts[4] || '',
      serialNumber: serial,
    })
  }
  return records
}

function parseUsers(body) {
  const users = []
  for (const raw of String(body || '').split('\n')) {
    const line = raw.replace(/\r$/, '').trim()
    if (!line) continue
    const fields = parseKv(line.replace(/\t/g, '\n'), '\n')
    const pin = fields.PIN || fields.pin
    if (!pin) continue
    users.push({
      pin,
      name: fields.Name || fields.name || `User ${pin}`,
      privilege: Number(fields.Privilege || fields.privilege || 0) || 0,
      card: fields.Card || fields.card || '',
      password: fields.Password || fields.password || '',
    })
  }
  return users
}

function parseCommandResults(body, serial) {
  const results = []
  let current = { serialNumber: serial }
  let hasId = false
  const normalized = String(body || '').replace(/\n/g, '&')
  for (const part of normalized.split('&')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim().toUpperCase()
    const value = trimmed.slice(eq + 1).trim()
    if (key === 'ID') {
      const id = Number(value)
      if (!Number.isFinite(id)) continue
      if (hasId) results.push(current)
      current = { serialNumber: serial, id }
      hasId = true
    } else if (key === 'RETURN') {
      current.returnCode = Number(value)
    } else if (key === 'CMD') {
      current.command = value
    }
  }
  if (hasId) results.push(current)
  return results
}

class AdmsServer {
  constructor(hooks = {}) {
    this.hooks = hooks
    this.devices = new Map()
    this.queues = new Map()
    this.pending = new Map()
    this.nextId = 1
    this.onlineMs = 2 * 60 * 1000
    this.router = this.createRouter()
  }

  createRouter() {
    const router = express.Router()
    router.use((req, _res, next) => {
      const [path, qs] = String(req.url || '/').split('?')
      const trimmed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
      req.url = qs ? `${trimmed}?${qs}` : trimmed
      next()
    })
    router.use(express.text({ type: () => true, limit: '10mb' }))
    router.use((req, _res, next) => {
      const sn = req.query.SN || req.query.sn || ''
      const table = req.query.table || ''
      console.log(`[ADMS] ${req.method} ${req.path}${sn ? ` SN=${sn}` : ''}${table ? ` table=${table}` : ''}`)
      next()
    })
    router.all('/', (_req, res) => this.sendPlain(res, 'OK'))
    router.all('/cdata', (req, res) => this.handleCData(req, res))
    router.all('/getrequest', (req, res) => this.handleGetRequest(req, res))
    router.all('/devicecmd', (req, res) => this.handleDeviceCmd(req, res))
    router.all('/registry', (req, res) => this.handleRegistry(req, res))
    router.get('/inspect', (req, res) => this.handleInspect(req, res))
    router.use((_req, res) => res.status(404).send('Not found'))
    return router
  }

  sendPlain(res, body) {
    const text = String(body)
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/plain')
    res.setHeader('Content-Length', Buffer.byteLength(text))
    res.end(text)
  }

  requireSn(req, res) {
    const sn = String(req.query.SN || req.query.sn || '').trim()
    if (!sn || !SN_RE.test(sn)) {
      res.status(400).send(sn ? 'Invalid SN parameter' : 'Missing SN parameter')
      return null
    }
    this.touch(sn)
    return sn
  }

  touch(sn) {
    const isNew = !this.devices.has(sn)
    const prev = this.devices.get(sn) || { serialNumber: sn, options: {}, lastActivity: null }
    prev.lastActivity = new Date()
    this.devices.set(sn, prev)
    this.hooks.onTouch?.(sn, prev)
    if (isNew) this.hooks.onFirstSeen?.(sn)
  }

  pendingCount(sn) {
    const queued = (this.queues.get(sn) || []).length
    let pending = 0
    for (const command of this.pending.values()) {
      if (command) pending += 1
    }
    return queued + pending
  }

  isOnline(sn) {
    const device = this.devices.get(sn)
    if (!device?.lastActivity) return false
    return Date.now() - device.lastActivity.getTime() < this.onlineMs
  }

  listDevices() {
    return [...this.devices.values()].map((device) => ({
      serialNumber: device.serialNumber,
      lastActivity: device.lastActivity?.toISOString() || null,
      online: this.isOnline(device.serialNumber),
      options: device.options || {},
    }))
  }

  primarySn() {
    const online = this.listDevices().find((device) => device.online)
    if (online) return online.serialNumber
    const last = [...this.devices.values()].sort((a, b) => {
      return (b.lastActivity?.getTime() || 0) - (a.lastActivity?.getTime() || 0)
    })[0]
    return last?.serialNumber || null
  }

  queueCommand(sn, command) {
    if (!sn) throw new Error('No ADMS device has connected yet')
    if (!this.devices.has(sn)) this.touch(sn)
    if (/\r|\n/.test(command)) throw new Error('Invalid command')
    const id = this.nextId++
    const list = this.queues.get(sn) || []
    list.push({ id, command })
    this.queues.set(sn, list)
    return id
  }

  drainCommands(sn) {
    const list = this.queues.get(sn) || []
    this.queues.delete(sn)
    for (const item of list) this.pending.set(item.id, item.command)
    return list
  }

  writeCommandsOrOk(res, sn) {
    const commands = this.drainCommands(sn)
    if (!commands.length) {
      this.sendPlain(res, 'OK')
      return
    }
    this.sendPlain(res, commands.map((item) => `C:${item.id}:${item.command}\n`).join(''))
  }

  body(req) {
    if (typeof req.body === 'string') return req.body
    if (Buffer.isBuffer(req.body)) return req.body.toString('utf8')
    return ''
  }

  handleCData(req, res) {
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.status(405).send('Method not allowed')
      return
    }
    const sn = this.requireSn(req, res)
    if (!sn) return
    const table = String(req.query.table || '')
    const body = this.body(req)

    if (table === 'ATTLOG') {
      const records = parseAttendance(body, sn)
      this.hooks.onAttendance?.(records)
      this.sendPlain(res, `OK: ${records.length}`)
      return
    }

    if (table === 'OPERLOG' || table === 'BIODATA') {
      this.sendPlain(res, 'OK')
      return
    }

    if (table === 'USERINFO') {
      const users = parseUsers(body)
      this.hooks.onUsers?.(sn, users)
      this.sendPlain(res, 'OK')
      return
    }

    if (req.method === 'POST' && body) {
      const info = parseKv(body, '\n')
      const device = this.devices.get(sn)
      if (device) device.options = { ...device.options, ...info }
      this.hooks.onDeviceInfo?.(sn, info)
    }

    this.writeCommandsOrOk(res, sn)
  }

  handleGetRequest(req, res) {
    if (req.method !== 'GET') {
      res.status(405).send('Method not allowed')
      return
    }
    const sn = this.requireSn(req, res)
    if (!sn) return
    this.writeCommandsOrOk(res, sn)
  }

  handleDeviceCmd(req, res) {
    if (req.method !== 'POST') {
      res.status(405).send('Method not allowed')
      return
    }
    const sn = this.requireSn(req, res)
    if (!sn) return
    const results = parseCommandResults(this.body(req), sn)
    for (const result of results) {
      result.queuedCommand = this.pending.get(result.id) || ''
      this.pending.delete(result.id)
      this.hooks.onCommandResult?.(result)
    }
    this.sendPlain(res, 'OK')
  }

  handleRegistry(req, res) {
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.status(405).send('Method not allowed')
      return
    }
    const sn = this.requireSn(req, res)
    if (!sn) return
    const body = this.body(req)
    if (body) {
      const info = parseKv(body, ',', (key) => key.replace(/^~/, ''))
      const device = this.devices.get(sn)
      if (device) device.options = { ...device.options, ...info }
      this.hooks.onRegistry?.(sn, info)
    }
    this.sendPlain(res, 'OK')
  }

  handleInspect(req, res) {
    res.json({
      devices: this.listDevices(),
      count: this.devices.size,
      time: new Date().toISOString(),
    })
  }

  sendInfo(sn) {
    return this.queueCommand(sn, 'INFO')
  }

  sendQueryUsers(sn) {
    return this.queueCommand(sn, 'DATA QUERY USERINFO')
  }

  sendUserAdd(sn, { pin, name, privilege = 0, card = '', password = '' }) {
    const clean = (value) => String(value || '').replace(/[\r\n\t]/g, ' ').trim()
    let command = `DATA UPDATE USERINFO PIN=${clean(pin)}\tName=${clean(name)}\tPrivilege=${Number(privilege) || 0}\tCard=${clean(card)}`
    if (password) command += `\tPassword=${clean(password)}`
    return this.queueCommand(sn, command)
  }

  sendUserDelete(sn, pin) {
    return this.queueCommand(sn, `DATA DELETE USERINFO PIN=${String(pin || '').replace(/[\r\n\t]/g, '').trim()}`)
  }

  sendClearData(sn) {
    return this.queueCommand(sn, 'CLEAR DATA')
  }

  sendCheck(sn) {
    return this.queueCommand(sn, 'CHECK')
  }

  sendGetOption(sn, key) {
    return this.queueCommand(sn, `GET OPTION FROM ${key}`)
  }
}

module.exports = { AdmsServer }
