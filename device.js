const ZKLib = require('node-zklib')
const { COMMANDS } = require('node-zklib/constants')
const { EventEmitter } = require('events')

function toIso(value) {
  if (value instanceof Date) return value.toISOString()
  if (value) return new Date(value).toISOString()
  return null
}

function punchKey(userId, time) {
  return `${userId}|${time}`
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function errMessage(err) {
  return err?.err?.message || err?.message || String(err)
}

function isTimeout(err) {
  const msg = errMessage(err).toUpperCase()
  return msg.includes('TIMEOUT') || msg.includes('TIME OUT')
}

function padAscii(value, length) {
  return Buffer.from(String(value || '').slice(0, length), 'ascii')
}

function encodeUser72({ uid, userId, name, password, role, card }) {
  const buf = Buffer.alloc(72)
  buf.writeUInt16LE(uid, 0)
  buf.writeUInt8(Number(role) || 0, 2)
  padAscii(password, 8).copy(buf, 3)
  padAscii(name, 24).copy(buf, 11)
  buf.writeUInt32LE(Number(card) || 0, 35)
  buf.writeUInt8(1, 39)
  padAscii(userId || String(uid), 9).copy(buf, 48)
  return buf
}

class Device extends EventEmitter {
  constructor(config) {
    super()
    this.config = config
    this.zk = null
    this.queue = Promise.resolve()
    this.connected = false
    this.connecting = false
    this.error = null
    this.lastSync = null
    this.info = { userCounts: 0, logCounts: 0, logCapacity: 0 }
    this.users = []
    this.logs = []
    this.seen = new Set()
    this.realtimeStarted = false
  }

  getState() {
    return {
      connected: this.connected,
      connecting: this.connecting,
      error: this.error,
      lastSync: this.lastSync,
      device: {
        model: 'iFace 990 Plus',
        ip: this.config.ip,
        port: this.config.port,
      },
      info: this.info,
      users: this.users,
      logs: this.logs,
    }
  }

  enqueue(fn) {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => {})
    return run
  }

  async start() {
    await this.refresh()
    this.startRealtime().catch((err) => {
      console.warn('realtime listen failed:', errMessage(err))
    })
  }

  async connect() {
    if (this.connected && this.zk) return
    this.connecting = true
    this.error = null
    this.emit('status', this.getState())

    try {
      this.zk = new ZKLib(
        this.config.ip,
        this.config.port,
        this.config.timeoutMs,
        this.config.udpInPort,
      )
      await this.zk.createSocket(
        (err) => {
          this.connected = false
          this.realtimeStarted = false
          this.error = err?.message || String(err)
          this.emit('status', this.getState())
        },
        () => {
          this.connected = false
          this.realtimeStarted = false
          this.emit('status', this.getState())
        },
      )
      try {
        await this.zk.enableDevice()
      } catch {
        // some firmware rejects this; data commands still work
      }
      this.connected = true
      this.error = null
    } catch (err) {
      this.connected = false
      this.zk = null
      this.error = errMessage(err)
      throw err
    } finally {
      this.connecting = false
      this.emit('status', this.getState())
    }
  }

  async disconnect() {
    const zk = this.zk
    this.zk = null
    this.connected = false
    this.realtimeStarted = false
    if (!zk) return
    try {
      await Promise.race([zk.disconnect(), delay(1500)])
    } catch {
      // node-zklib throws if the socket is already gone
    }
    try {
      zk.zklibTcp?.socket?.destroy?.()
    } catch {
      // ignore
    }
  }

  async loadSnapshot({ skipLogs = false } = {}) {
    const info = await this.zk.getInfo()
    this.info = {
      userCounts: info?.userCounts ?? 0,
      logCounts: info?.logCounts ?? 0,
      logCapacity: info?.logCapacity ?? 0,
    }

    const usersRes = await this.zk.getUsers()
    this.users = (usersRes?.data || []).map((user) => ({
      uid: user.uid,
      userId: String(user.userId ?? user.uid ?? ''),
      name: (user.name || '').trim() || `User ${user.userId}`,
      role: user.role,
      card: user.cardno ? String(user.cardno) : '',
    }))

    // node-zklib times out on getAttendances() when the device has 0 logs.
    if (skipLogs || this.info.logCounts === 0) {
      this.logs = []
      this.seen = new Set()
      this.info.logCounts = 0
      this.lastSync = new Date().toISOString()
      this.error = null
      return
    }

    try {
      const logsRes = await this.zk.getAttendances()
      const mapped = (logsRes?.data || []).map((log) => {
        const userId = String(log.deviceUserId ?? log.userSn ?? '')
        return {
          userId,
          name: this.nameFor(userId),
          time: toIso(log.recordTime),
        }
      })

      mapped.sort((a, b) => String(b.time).localeCompare(String(a.time)))
      this.logs = mapped
      this.seen = new Set(mapped.map((log) => punchKey(log.userId, log.time)))
    } catch (err) {
      if (!isTimeout(err)) throw err
      this.logs = []
      this.seen = new Set()
    }

    this.lastSync = new Date().toISOString()
    this.error = null
  }

  async reconnect() {
    await this.disconnect()
    await this.connect()
  }

  async refresh() {
    return this.enqueue(async () => {
      if (this.realtimeStarted) await this.disconnect()
      await this.connect()
      this.realtimeStarted = false
      await this.loadSnapshot()
      this.emit('status', this.getState())
      return this.getState()
    })
      .then((state) => {
        this.startRealtime().catch(() => {})
        return state
      })
      .catch((err) => {
        this.error = errMessage(err)
        this.emit('status', this.getState())
        throw err
      })
  }

  nameFor(userId) {
    const user = this.users.find((item) => item.userId === String(userId))
    return user?.name || `User ${userId}`
  }

  nextUid() {
    const used = new Set(this.users.map((user) => Number(user.uid)))
    let uid = 1
    while (used.has(uid)) uid += 1
    return uid
  }

  async withWrite(fn, { skipLogs = false } = {}) {
    return this.enqueue(async () => {
      await this.reconnect()
      try {
        await this.zk.disableDevice()
      } catch {
        // continue even if the keypad lock is rejected
      }
      try {
        await fn()
        try {
          await this.zk.executeCmd(COMMANDS.CMD_REFRESHDATA, '')
        } catch {
          // not all firmware supports this opcode
        }
      } finally {
        try {
          await this.zk.enableDevice()
        } catch {
          // ignore
        }
      }
      this.realtimeStarted = false
      await this.reconnect()
      await delay(400)
      await this.loadSnapshot({ skipLogs })
      this.emit('status', this.getState())
      return this.getState()
    })
      .then((state) => {
        this.startRealtime().catch(() => {})
        return state
      })
      .catch((err) => {
        this.error = errMessage(err)
        this.emit('status', this.getState())
        throw err
      })
  }

  async setUser(input = {}) {
    const name = String(input.name || '').trim()
    if (!name) throw new Error('Name is required')
    if (name.length > 24) throw new Error('Name must be 24 characters or less')

    const userId = String(input.userId || '').trim()
    if (userId.length > 9) throw new Error('User ID must be 9 characters or less')

    const password = String(input.password || '')
    if (password.length > 8) throw new Error('Password must be 8 characters or less')

    const uid = Number(input.uid) || this.nextUid()
    if (uid < 1 || uid > 65535) throw new Error('uid must be between 1 and 65535')

    const role = Number(input.role) === 14 ? 14 : 0
    const card = Number(input.card) || 0

    return this.withWrite(async () => {
      await this.zk.executeCmd(
        COMMANDS.CMD_USER_WRQ,
        encodeUser72({
          uid,
          userId: userId || String(uid),
          name,
          password,
          role,
          card,
        }),
      )
    })
  }

  async deleteUser(uid) {
    const raw = String(uid || '').trim()
    const match = this.users.find(
      (user) => String(user.uid) === raw || user.userId === raw,
    )
    const id = Number(match?.uid || raw)
    if (!id) throw new Error('uid is required')
    return this.withWrite(async () => {
      const buf = Buffer.alloc(2)
      buf.writeUInt16LE(id, 0)
      await this.zk.executeCmd(COMMANDS.CMD_DELETE_USER, buf)
    })
  }

  async clearLogs() {
    return this.withWrite(
      async () => {
        await this.zk.clearAttendanceLog()
      },
      { skipLogs: true },
    )
  }

  async startRealtime() {
    return this.enqueue(async () => {
      if (!this.connected) await this.connect()
      if (this.realtimeStarted) return
      await this.zk.getRealTimeLogs((event) => {
        const userId = String(event?.userId ?? event?.uid ?? '')
        const time = toIso(event?.attTime || event?.recordTime || new Date())
        const key = punchKey(userId, time)
        if (this.seen.has(key)) return
        this.seen.add(key)
        const punch = {
          userId,
          name: this.nameFor(userId),
          time,
          live: true,
        }
        this.logs.unshift(punch)
        this.info.logCounts = Math.max(this.info.logCounts, this.logs.length)
        this.emit('punch', punch)
        this.emit('status', this.getState())
      })
      this.realtimeStarted = true
    })
  }
}

module.exports = { Device }
