const { EventEmitter } = require('events')
const { AdmsServer } = require('./adms')

function punchKey(userId, time) {
  return `${userId}|${time}`
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
      onFirstSeen: (sn) => {
        this.serial = sn
        this.server.sendQueryUsers(sn)
        this.server.sendInfo(sn)
        for (const key of ['DeviceName', 'IPAddress', 'UserCount', 'AttLogCount', 'MaxAttLogCount']) {
          this.server.sendGetOption(sn, key)
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

  nameFor(userId) {
    const user = this.users.find((item) => item.userId === String(userId))
    return user?.name || `User ${userId}`
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
    this.users = users.map((user) => ({
      uid: Number(user.pin) || user.pin,
      userId: String(user.pin),
      name: (user.name || '').trim() || `User ${user.pin}`,
      role: Number(user.privilege) === 14 ? 14 : 0,
      card: user.card || '',
    }))
    this.info.userCounts = this.users.length
    this.lastSync = new Date().toISOString()
    this.error = null
    this.emit('status', this.getState())
  }

  ingestAttendance(records) {
    for (const record of records) {
      const key = punchKey(record.userId, record.time)
      if (this.seen.has(key)) continue
      this.seen.add(key)
      const punch = {
        userId: String(record.userId),
        name: this.nameFor(record.userId),
        time: record.time,
        live: true,
      }
      this.logs.unshift(punch)
      this.info.logCounts = Math.max(this.info.logCounts, this.logs.length)
      this.emit('punch', punch)
    }
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
      logs: this.logs,
      admsDevices: listed,
      pendingCommands: sn ? this.server.pendingCount(sn) : 0,
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
    this.server.sendQueryUsers(sn)
    this.server.sendInfo(sn)
    this.server.sendCheck(sn)
    for (const key of ['DeviceName', 'IPAddress', 'UserCount', 'AttLogCount', 'MaxAttLogCount']) {
      this.server.sendGetOption(sn, key)
    }
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
    this.server.sendUserAdd(sn, {
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
    this.server.sendUserDelete(sn, pin)
    this.users = this.users.filter((user) => user.userId !== pin && String(user.uid) !== raw)
    this.info.userCounts = this.users.length
    this.emit('status', this.getState())
    return this.getState()
  }

  async clearLogs() {
    const sn = this.requireSn()
    this.server.sendClearData(sn)
    this.logs = []
    this.seen = new Set()
    this.info.logCounts = 0
    this.emit('status', this.getState())
    return this.getState()
  }
}

module.exports = { AdmsDevice }
