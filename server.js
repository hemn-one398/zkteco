const path = require('path')
const express = require('express')
const { Hub } = require('./hub')

const PORT = Number(process.env.PORT || 3005)

const hub = new Hub({
  mode: process.env.ZK_MODE || 'sdk',
  httpPort: PORT,
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
    ...hub.getState(),
    error: err?.err?.message || err.message || String(err),
  })
}

const app = express()
app.disable('x-powered-by')
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

app.use('/iclock', hub.adms.router)
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

app.get('/api/status', (_req, res) => {
  res.json(hub.getState())
})

app.post('/api/mode', async (req, res) => {
  try {
    const mode = req.body?.mode === 'adms' ? 'adms' : 'sdk'
    res.json(await hub.setMode(mode))
  } catch (err) {
    fail(res, err, 400)
  }
})

app.post('/api/refresh', async (_req, res) => {
  try {
    res.json(await hub.refresh())
  } catch (err) {
    fail(res, err)
  }
})

app.post('/api/users', async (req, res) => {
  try {
    res.json(await hub.setUser(req.body || {}))
  } catch (err) {
    fail(res, err, 400)
  }
})

app.delete('/api/users/:uid', async (req, res) => {
  try {
    res.json(await hub.deleteUser(req.params.uid))
  } catch (err) {
    fail(res, err, 400)
  }
})

app.post('/api/logs/clear', async (_req, res) => {
  try {
    res.json(await hub.clearLogs())
  } catch (err) {
    fail(res, err)
  }
})

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()
  res.write(`event: status\ndata: ${JSON.stringify(hub.getState())}\n\n`)
  clients.add(res)
  req.on('close', () => clients.delete(res))
})

process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection:', err?.message || err)
})

process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err?.message || err)
})

async function main() {
  const host = process.env.HOST || '0.0.0.0'
  const server = app.listen(PORT, host, () => {
    console.log(`Dashboard: http://localhost:${PORT}`)
    console.log(`ADMS push URL: ${hub.admsUrl()}`)
  })
  server.on('error', (err) => {
    console.error('Could not start web server:', err.message)
    process.exit(1)
  })

  try {
    await hub.start()
    const state = hub.getState()
    console.log(
      `Mode ${state.mode}: ${state.users.length} users, ${state.logs.length} logs`,
    )
  } catch (err) {
    console.error('Could not start device mode:', err?.err?.message || err.message || err)
  }
}

main()
