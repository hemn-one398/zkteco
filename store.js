const KEY = 'zkteco:adms:v1'

function redisCreds() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN
  if (!url || !token) return null
  return { url: url.replace(/\/$/, ''), token }
}

function persistBackend() {
  if (redisCreds()) return 'redis'
  if (process.env.VERCEL) return 'memory'
  return 'local'
}

async function loadState() {
  const creds = redisCreds()
  if (!creds) return globalThis.__zktecoAdms || null
  try {
    const res = await fetch(`${creds.url}/get/${encodeURIComponent(KEY)}`, {
      headers: { Authorization: `Bearer ${creds.token}` },
      signal: AbortSignal.timeout(4000),
    })
    const data = await res.json()
    if (!data.result) return globalThis.__zktecoAdms || null
    const parsed = typeof data.result === 'string' ? JSON.parse(data.result) : data.result
    globalThis.__zktecoAdms = parsed
    return parsed
  } catch (err) {
    console.error('adms store load failed:', err.message || err)
    return globalThis.__zktecoAdms || null
  }
}

async function saveState(value) {
  globalThis.__zktecoAdms = value
  const creds = redisCreds()
  if (!creds) return persistBackend()
  try {
    const res = await fetch(creds.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${creds.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(['SET', KEY, JSON.stringify(value)]),
      signal: AbortSignal.timeout(4000),
    })
    if (!res.ok) throw new Error(`redis HTTP ${res.status}`)
  } catch (err) {
    console.error('adms store save failed:', err.message || err)
  }
  return persistBackend()
}

module.exports = { loadState, saveState, persistBackend }
