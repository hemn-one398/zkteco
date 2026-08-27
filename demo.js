/**
 * ZKTeco iFace 990 Plus — connection demo
 *
 * Usage:
 *   node demo.js          # connect, print info / users / last logs, then disconnect
 *   node demo.js --watch  # same, then listen for live check-ins (Ctrl+C to stop)
 */

const ZKLib = require('node-zklib')

const DEVICE = {
  ip: process.env.ZK_IP || '192.168.1.76',
  port: Number(process.env.ZK_PORT || 6),
  timeoutMs: Number(process.env.ZK_TIMEOUT || 10000),
  udpInPort: Number(process.env.ZK_UDP_INPORT || 4000),
  // Comm Key from the device menu. 0 = no password.
  commKey: Number(process.env.ZK_COMM_KEY || 0),
  protocol: process.env.ZK_PROTOCOL || 'tcp',
}

const watch = process.argv.includes('--watch')

function line(title) {
  console.log('\n' + '='.repeat(60))
  console.log(title)
  console.log('='.repeat(60))
}

async function main() {
  line('Connecting to iFace 990 Plus')
  console.log(DEVICE)

  const zk = new ZKLib(
    DEVICE.ip,
    DEVICE.port,
    DEVICE.timeoutMs,
    DEVICE.udpInPort,
    DEVICE.commKey,
    DEVICE.protocol,
  )

  try {
    await zk.createSocket()
    console.log('Socket connected.')

    try {
      await zk.enableDevice()
    } catch (err) {
      console.warn('enableDevice skipped:', err?.err?.message || err.message || err)
    }

    line('Device info')
    const info = await zk.getInfo()
    console.log(info)

    line('Users')
    const users = await zk.getUsers()
    const userList = users?.data || []
    console.log(`Count: ${userList.length}`)
    userList.slice(0, 20).forEach((u, i) => {
      console.log(
        `${String(i + 1).padStart(3, ' ')}. uid=${u.uid} userId=${u.userId} name=${u.name} role=${u.role} card=${u.cardno ?? ''}`,
      )
    })
    if (userList.length > 20) {
      console.log(`... ${userList.length - 20} more`)
    }

    line('Attendance logs (last 15)')
    const logs = await zk.getAttendances()
    const logList = logs?.data || []
    console.log(`Total logs: ${logList.length}`)
    logList
      .slice(-15)
      .reverse()
      .forEach((log, i) => {
        const t = log.recordTime instanceof Date ? log.recordTime.toISOString() : log.recordTime
        console.log(
          `${String(i + 1).padStart(3, ' ')}. user=${log.deviceUserId ?? log.userSn} time=${t}`,
        )
      })

    if (watch) {
      line('Live check-ins (Ctrl+C to stop)')
      console.log('Scan a face / fingerprint / card on the device...')
      zk.getRealTimeLogs((event) => {
        console.log('CHECK-IN', event)
      })

      await new Promise((resolve) => {
        process.on('SIGINT', resolve)
        process.on('SIGTERM', resolve)
      })
    }

    line('OK — device is reachable from Node.js')
  } catch (err) {
    console.error('\nFAILED to talk to the device.')
    if (err && typeof err.toast === 'function') {
      console.error(err.toast())
      console.error(err.getError())
    } else {
      console.error(err)
    }
    console.error(`
Tips:
  - PC and device must be on the same LAN (this PC can ping ${DEVICE.ip}).
  - TCP COMM. Port on the device must match ZK_PORT (now ${DEVICE.port}).
    Default on most ZKTeco units is 4370. Yours is set to ${DEVICE.port}.
  - If the device has a Comm Key, set ZK_COMM_KEY to that number.
  - Close ZKAccess / BioTime / the device web UI if they hold the connection.
`)
    process.exitCode = 1
  } finally {
    try {
      await zk.disconnect()
      console.log('Disconnected.')
    } catch {
      // already closed
    }
  }
}

main()
