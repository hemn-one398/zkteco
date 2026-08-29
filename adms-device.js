const { EventEmitter } = require('events')
const { AdmsServer, sameId } = require('./adms')
const { loadState, saveState, persistBackend } = require('./store')

function punchKey(userId, time) {
  return `${userId}|${time}`
}

function newerIclock(a, b) {
  const left = Date.parse(a?.at || 0) || 0
  const right = Date.parse(b?.at || 0) || 0
  if (right > left) return b || null
  return a || b || null
}

function mergeUsers(base, incoming) {
  const map = new Map()
  for (const list of [base, incoming]) {
    for (const user of list || []) {
      const id = String(user?.userId || user?.uid || '').trim()
      if (!id) continue
      const prev = map.get(id)
      if (!prev) {
        map.set(id, { ...user, userId: id })
        continue
      }
      const nextName = String(user.name || '').trim()
      const prevName = String(prev.name || '').trim()
      const placeholder = /^user\s+/i.test(nextName)
      map.set(id, {
        ...prev,
        ...user,
        userId: id,
        name: placeholder && prevName && !/^user\s+/i.test(prevName) ? prevName : nextName || prevName,
      })
    }
  }
  return [...map.values()]
}

class AdmsDevice extends EventEmitter {
  constructor() {
    super()
    this.users = []
    this.logs = []
    this.seen = new Set()
    this.info = { userCounts: 0, logCounts: 0, logCapacity: 0 }
    this.lastSync = null
    this.error = null
    this.serial = null
    this.options = {}
    this.server = new AdmsServer({
      onAttendance: (records) => this.ingestAttendance(records),
      onUsers: (_sn, users) => this.ingestUsers(users),
      onDeviceInfo: (sn, info) => this.ingestInfo(sn, info),
      onRegistry: (sn, info) => this.ingestInfo(sn, info),
      onTouch: (sn) => {
        this.serial = sn
        this.emit('status', this.getState())
      },
      onFirstSeen: async (sn) => {
        this.serial = sn
        await this.server.sendQueryUsers(sn)
        await this.server.sendInfo(sn)
        for (const key of ['DeviceName', 'IPAddress', 'UserCount', 'AttLogCount', 'MaxAttLogCount']) {
          await this.server.sendGetOption(sn, key)
        }
      },
      onCommandResult: (result) => {
        if (result.returnCode && result.returnCode !== 0) {
          this.error = `ADMS command failed (${result.returnCode}) ${result.command || ''}`
          this.emit('status', this.getState())
        }
      },
    })
  }

  get router() {
    return this.server.router
  }

  async hydrate() {
    const data = await loadState()
    if (!data) return
    this.server.restore(data.server || {})
    this.server.lastIclock = newerIclock(this.server.lastIclock, data.lastIclock)
    this.users = data.users || []
    this.logs = data.logs || []
    this.seen = new Set(data.seen || [])
    this.info = data.info || this.info
    this.serial = data.serial || this.serial
    this.options = data.options || {}
    this.lastSync = data.lastSync || null
    this.error = data.error || null
    this.logs = this.withNames(this.logs)
    const sn = this.serial || this.server.primarySn()
    if (sn) await this.server.refreshCommandCount(sn)
  }

  async persist() {
    const current = (await loadState()) || {}
    const users = mergeUsers(current.users, this.users)
    const logs = this.withNames(this.logs.length ? this.logs : current.logs || [])
    const lastIclock = newerIclock(this.server.lastIclock, current.server?.lastIclock || current.lastIclock)
    await saveState({
      server: { ...this.server.snapshot(), lastIclock },
      users,
      logs,
      seen: [...this.seen],
      info: {
        userCounts: users.length || this.info.userCounts || current.info?.userCounts || 0,
        logCounts: Math.max(this.info.logCounts || 0, current.info?.logCounts || 0, logs.length),
        logCapacity: this.info.logCapacity || current.info?.logCapacity || 0,
      },
      serial: this.serial || current.serial,
      options: { ...(current.options || {}), ...this.options },
      lastSync: this.lastSync || current.lastSync,
      error: this.error,
      lastIclock,
    })
  }

  findUser(userId) {
    const id = String(userId ?? '').trim()
    if (!id) return null
    return this.users.find(
      (item) => sameId(item.userId, id) || sameId(item.uid, id),
    )
  }

  isPlaceholderName(name, userId) {
    const text = String(name || '').trim()
    if (!text) return true
    const id = String(userId ?? '').trim()
    return /^user\s+/i.test(text) && (!id || text.replace(/^user\s+/i, '') === id)
  }

  nameFor(userId) {
    const id = String(userId ?? '').trim()
    if (!id) return ''
    const user = this.findUser(id)
    const name = String(user?.name || '').trim()
    if (name && !this.isPlaceholderName(name, user?.userId || id)) return name
    return `User ${id}`
  }

  withNames(logs) {
    return (logs || []).map((log) => ({
      ...log,
      name: this.nameFor(log.userId) || log.name || '',
    }))
  }

  ingestInfo(sn, info) {
    this.serial = sn
    this.options = { ...this.options, ...info }
    const userCounts = Number(info.UserCount || info.userCounts)
    const logCounts = Number(info.AttLogCount || info.TransactionCount)
    const logCapacity = Number(info.MaxAttLogCount)
    if (Number.isFinite(userCounts)) this.info.userCounts = userCounts
    if (Number.isFinite(logCounts)) this.info.logCounts = logCounts
    if (Number.isFinite(logCapacity)) this.info.logCapacity = logCapacity
    this.lastSync = new Date().toISOString()
    this.error = null
    this.emit('status', this.getState())
  }

  ingestUsers(users) {
    for (const user of users || []) {
      const pin = String(user.pin || '').trim()
      if (!pin) continue
      const incomingName = String(user.name || '').trim()
      const row = {
        uid: Number(pin) || pin,
        userId: pin,
        name: incomingName || `User ${pin}`,
        role: Number(user.privilege) === 14 ? 14 : 0,
        card: user.card || '',
      }
      const existing = this.findUser(pin)
      if (existing) {
        if (this.isPlaceholderName(row.name, pin) && !this.isPlaceholderName(existing.name, existing.userId)) {
          row.name = existing.name
        }
        Object.assign(existing, row)
      } else {
        this.users.push(row)
      }
    }
    this.info.userCounts = this.users.length
    this.lastSync = new Date().toISOString()
    this.error = null
    this.logs = this.withNames(this.logs)
    this.emit('status', this.getState())
  }

  async ingestAttendance(records) {
    let needUsers = false
    for (const record of records) {
      const key = punchKey(record.userId, record.time)
      if (this.seen.has(key)) continue
      this.seen.add(key)
      const name = this.nameFor(record.userId)
      if (this.isPlaceholderName(name, record.userId)) needUsers = true
      const punch = {
        userId: String(record.userId),
        name,
        time: record.time,
        live: true,
      }
      this.logs.unshift(punch)
      this.info.logCounts = Math.max(this.info.logCounts, this.logs.length)
      this.emit('punch', punch)
    }
    if (needUsers && this.serial) await this.server.sendQueryUsers(this.serial)
    this.lastSync = new Date().toISOString()
    this.error = null
    this.emit('status', this.getState())
  }

  getState() {
    const sn = this.serial || this.server.primarySn()
    const listed = this.server.listDevices()
    const current = listed.find((item) => item.serialNumber === sn) || listed[0]
    return {
      connected: Boolean(sn && this.server.isOnline(sn)),
      connecting: false,
      error: this.error,
      lastSync: this.lastSync,
      device: {
        model: this.options.DeviceName || 'iFace 990 Plus',
        ip: this.options.IPAddress || '',
        port: null,
        serial: sn,
      },
      info: {
        userCounts: this.info.userCounts || this.users.length,
        logCounts: this.info.logCounts || this.logs.length,
        logCapacity: this.info.logCapacity || 0,
      },
      users: this.users,
      logs: this.withNames(this.logs),
      admsDevices: listed,
      lastIclock: this.server.lastIclock || null,
      pendingCommands: sn ? this.server.pendingCount(sn) : 0,
      persist: persistBackend(),
    }
  }

  requireSn() {
    const sn = this.serial || this.server.primarySn()
    if (!sn) throw new Error('No ADMS device has connected yet. Set Cloud Server to this PC, then wait for a heartbeat.')
    return sn
  }

  async start() {
    this.error = null
    this.emit('status', this.getState())
  }

  async disconnect() {
    // ADMS stays listening; devices reconnect on their poll interval.
  }

  async refresh() {
    const sn = this.requireSn()
    await this.server.sendQueryUsers(sn)
    await this.server.sendInfo(sn)
    await this.server.sendCheck(sn)
    for (const key of ['DeviceName', 'IPAddress', 'UserCount', 'AttLogCount', 'MaxAttLogCount']) {
      await this.server.sendGetOption(sn, key)
    }
    await this.server.refreshCommandCount(sn)
    this.lastSync = new Date().toISOString()
    this.error = null
    this.emit('status', this.getState())
    return this.getState()
  }

  async fetchUsers() {
    const sn = this.requireSn()
    await this.server.sendQueryUsers(sn)
    await this.server.refreshCommandCount(sn)
    this.lastSync = new Date().toISOString()
    this.error = null
    this.emit('status', this.getState())
    return this.getState()
  }

  async setUser(input = {}) {
    const sn = this.requireSn()
    const name = String(input.name || '').trim()
    if (!name) throw new Error('Name is required')
    const pin = String(input.userId || input.uid || '').trim()
    if (!pin) throw new Error('User ID is required')
    await this.server.sendUserAdd(sn, {
      pin,
      name,
      privilege: Number(input.role) === 14 ? 14 : 0,
      card: String(input.card || ''),
      password: String(input.password || ''),
    })
    const existing = this.users.find((user) => user.userId === pin)
    const row = {
      uid: Number(pin) || pin,
      userId: pin,
      name,
      role: Number(input.role) === 14 ? 14 : 0,
      card: String(input.card || ''),
    }
    if (existing) Object.assign(existing, row)
    else this.users.push(row)
    this.info.userCounts = this.users.length
    this.emit('status', this.getState())
    return this.getState()
  }

  async deleteUser(uid) {
    const sn = this.requireSn()
    const raw = String(uid || '').trim()
    const match = this.users.find(
      (user) => String(user.uid) === raw || user.userId === raw,
    )
    const pin = match?.userId || raw
    if (!pin) throw new Error('uid is required')
    await this.server.sendUserDelete(sn, pin)
    this.users = this.users.filter((user) => user.userId !== pin && String(user.uid) !== raw)
    this.info.userCounts = this.users.length
    this.emit('status', this.getState())
    return this.getState()
  }

  async clearLogs() {
    const sn = this.requireSn()
    await this.server.sendClearData(sn)
    this.logs = []
    this.seen = new Set()
    this.info.logCounts = 0
    this.emit('status', this.getState())
    return this.getState()
  }
}

module.exports = { AdmsDevice }
