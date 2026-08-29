const fs = require('fs')
const path = require('path')
const { Redis } = require('@upstash/redis')

const KEY = 'zkteco:adms:v1'
const CMD_SEQ = 'zkteco:adms:seq'

function cmdKey(sn) {
  return `zkteco:adms:q:${String(sn || '').trim()}`
}

function parseQueued(raw) {
  if (raw == null || raw === '') return null
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw
  const command = String(value?.command || '').trim()
  const id = Number(value?.id)
  if (!command || !Number.isFinite(id)) return null
  return { id, command }
}

function loadEnvFile(file) {
  const full = path.join(__dirname, file)
  if (!fs.existsSync(full)) return
  for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
    const text = line.trim()
    if (!text || text.startsWith('#')) continue
    const eq = text.indexOf('=')
    if (eq < 0) continue
    const key = text.slice(0, eq).trim()
    let value = text.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] == null) process.env[key] = value
  }
}

loadEnvFile('.env.development.local')
loadEnvFile('.env')

function getRedis() {
  try {
    if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
      return Redis.fromEnv()
    }
    if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
      return new Redis({
        url: process.env.KV_REST_API_URL,
        token: process.env.KV_REST_API_TOKEN,
      })
    }
  } catch (err) {
    console.error('redis init failed:', err.message || err)
  }
  return null
}

function persistBackend() {
  if (getRedis()) return 'redis'
  if (process.env.VERCEL) return 'memory'
  return 'local'
}

async function loadState() {
  const redis = getRedis()
  if (!redis) return globalThis.__zktecoAdms || null
  try {
    const parsed = await redis.get(KEY)
    if (!parsed) return globalThis.__zktecoAdms || null
    globalThis.__zktecoAdms = parsed
    return parsed
  } catch (err) {
    console.error('adms store load failed:', err.message || err)
    return globalThis.__zktecoAdms || null
  }
}

async function saveState(value) {
  globalThis.__zktecoAdms = value
  const redis = getRedis()
  if (!redis) return persistBackend()
  try {
    await redis.set(KEY, value)
  } catch (err) {
    console.error('adms store save failed:', err.message || err)
  }
  return persistBackend()
}

async function enqueueCommand(sn, command) {
  const redis = getRedis()
  if (!redis || !sn) return null
  try {
    const id = Number(await redis.incr(CMD_SEQ))
    await redis.rpush(cmdKey(sn), JSON.stringify({ id, command }))
    return id
  } catch (err) {
    console.error('adms enqueue failed:', err.message || err)
    return null
  }
}

async function drainCommandQueue(sn) {
  const redis = getRedis()
  if (!redis || !sn) return null
  const key = cmdKey(sn)
  try {
    const items = []
    for (;;) {
      const raw = await redis.lpop(key)
      if (raw == null) break
      try {
        const item = parseQueued(raw)
        if (item) items.push(item)
      } catch (err) {
        console.error('adms command parse failed:', err.message || err)
      }
    }
    return items
  } catch (err) {
    console.error('adms drain failed:', err.message || err)
    return []
  }
}

async function commandQueueLength(sn) {
  const redis = getRedis()
  if (!redis || !sn) return null
  try {
    return Number(await redis.llen(cmdKey(sn))) || 0
  } catch (err) {
    console.error('adms queue length failed:', err.message || err)
    return 0
  }
}

module.exports = {
  loadState,
  saveState,
  persistBackend,
  enqueueCommand,
  drainCommandQueue,
  commandQueueLength,
}
