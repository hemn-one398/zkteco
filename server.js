const path = require('path')
const express = require('express')
const { Hub } = require('./hub')
const { persistBackend } = require('./store')

const PORT = Number(process.env.PORT || 3005)

const hub = new Hub({
  mode: process.env.ZK_MODE || (process.env.VERCEL ? 'adms' : 'sdk'),
  httpPort: PORT,
  admsHost: process.env.ZK_ADMS_HOST || '',
  ip: process.env.ZK_IP || '192.168.1.76',
  port: Number(process.env.ZK_PORT || 6),
  timeoutMs: Number(process.env.ZK_TIMEOUT || 10000),
  udpInPort: Number(process.env.ZK_UDP_INPORT || 4000),
})

const clients = new Set()

function broadcast(event, payload) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
  for (const res of clients) {
    res.write(frame)
  }
}

hub.on('punch', (punch) => broadcast('punch', punch))
hub.on('status', (state) => broadcast('status', state))

function fail(res, err, status = 503) {
  res.status(status).json({
    ...hub.getState(res.req),
    error: err?.err?.message || err.message || String(err),
  })
}

const app = express()
app.disable('x-powered-by')
app.use(async (_req, _res, next) => {
  try {
    await ready
  } catch (err) {
    console.error('hub start failed:', err.message || err)
  }
  next()
})
app.use((req, res, next) => {
  if (req.path.startsWith('/iclock')) {
    next()
    return
  }
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') {
    res.sendStatus(204)
    return
  }
  next()
})

app.use(async (req, res, next) => {
  try {
    await hub.hydrate()
  } catch (err) {
    console.error('hydrate failed:', err.message || err)
  }
  const mutating =
    (req.path.startsWith('/iclock') && !req.path.startsWith('/iclock/inspect')) ||
    (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS')
  if (!mutating) {
    next()
    return
  }
  const end = res.end.bind(res)
  let flushed = false
  res.end = (...args) => {
    if (flushed) {
      end(...args)
      return
    }
    flushed = true
    Promise.resolve(hub.persist())
      .catch((err) => console.error('persist failed:', err.message || err))
      .finally(() => end(...args))
  }
  next()
})

app.use('/iclock', hub.adms.router)
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

app.get('/api/status', (req, res) => {
  const state = hub.getState(req)
  if (process.env.VERCEL && persistBackend() === 'memory') {
    state.error =
      state.error ||
      'Add Upstash Redis on Vercel (UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN) so the device and dashboard share ADMS state.'
  }
  res.json(state)
})

app.post('/api/mode', async (req, res) => {
  try {
    const mode = req.body?.mode === 'adms' ? 'adms' : 'sdk'
    res.json(await hub.setMode(mode, req))
  } catch (err) {
    fail(res, err, 400)
  }
})

app.post('/api/refresh', async (req, res) => {
  try {
    res.json(await hub.refresh(req))
  } catch (err) {
    fail(res, err)
  }
})

app.post('/api/users', async (req, res) => {
  try {
    res.json(await hub.setUser(req.body || {}, req))
  } catch (err) {
    fail(res, err, 400)
  }
})

app.post('/api/users/delete', async (req, res) => {
  try {
    const id = req.body?.userId || req.body?.uid
    res.json(await hub.deleteUser(id, req))
  } catch (err) {
    fail(res, err, 400)
  }
})

app.delete('/api/users/:uid', async (req, res) => {
  try {
    res.json(await hub.deleteUser(req.params.uid, req))
  } catch (err) {
    fail(res, err, 400)
  }
})

app.post('/api/logs/clear', async (req, res) => {
  try {
    res.json(await hub.clearLogs(req))
  } catch (err) {
    fail(res, err)
  }
})

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()
  res.write(`event: status\ndata: ${JSON.stringify(hub.getState(req))}\n\n`)
  clients.add(res)
  req.on('close', () => clients.delete(res))
})

process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection:', err?.message || err)
})

process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err?.message || err)
})

const ready = hub.start().catch((err) => {
  console.error('Could not start device mode:', err?.err?.message || err.message || err)
})

async function main() {
  await ready
  const host = process.env.HOST || '0.0.0.0'
  const server = app.listen(PORT, host, () => {
    console.log(`Dashboard: http://localhost:${PORT}`)
    console.log(`ADMS push URL: ${hub.admsUrl()}`)
  })
  server.on('error', (err) => {
    console.error('Could not start web server:', err.message)
    process.exit(1)
  })
}

if (!process.env.VERCEL) {
  main()
}

module.exports = app
