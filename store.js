const fs = require('fs')
const path = require('path')
const { Redis } = require('@upstash/redis')

const KEY = 'zkteco:adms:v1'

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

module.exports = { loadState, saveState, persistBackend }
