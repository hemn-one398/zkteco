const $ = (id) => document.getElementById(id)

function formatTime(iso) {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(date)
}

function roleLabel(role) {
  return Number(role) === 14 ? 'Admin' : 'User'
}

let lastUsers = []

function showBanner(text, ok = false) {
  const banner = $('banner')
  if (!text) {
    banner.classList.add('hidden')
    return
  }
  banner.textContent = text
  banner.classList.toggle('ok', ok)
  banner.classList.remove('hidden')
}

function render(state) {
  const connected = Boolean(state.connected)
  const pill = $('status-pill')
  pill.textContent = state.connecting ? 'Connecting' : connected ? 'Online' : 'Offline'
  pill.className = `pill ${connected ? 'on' : 'off'}`

  const device = state.device || {}
  const mode = state.mode === 'adms' ? 'adms' : 'sdk'
  $('mode-sdk').classList.toggle('active', mode === 'sdk')
  $('mode-adms').classList.toggle('active', mode === 'adms')
  const hint = $('adms-hint')
  if (mode === 'adms') {
    hint.classList.remove('hidden')
    const host = state.admsHost || ''
    const port = state.admsPort || 3005
    hint.textContent = `On the device: Comm → Cloud Server Setting. Server Address = ${host}  ·  Server Port = ${port}  ·  Domain Name OFF, HTTPS OFF. Do not use 169.254.x.x. Add/delete/clear wait for the next device poll.`
    $('device-addr').textContent = device.serial
      ? `${device.serial}${device.ip ? ' · ' + device.ip : ''}`
      : 'Waiting for device…'
  } else {
    hint.classList.add('hidden')
    $('device-addr').textContent = device.ip ? `${device.ip}:${device.port}` : '—'
  }

  $('stat-users').textContent = state.info?.userCounts ?? state.users?.length ?? '—'
  $('stat-logs').textContent = state.info?.logCounts ?? state.logs?.length ?? '—'
  $('stat-capacity').textContent = state.info?.logCapacity ?? '—'

  const last = (state.logs || [])[0]
  $('stat-last').textContent = last ? last.name : 'No punches yet'
  $('stat-last-sub').textContent = last ? formatTime(last.time) : ''

  if (state.error) showBanner(state.error)
  else if (!$('banner').classList.contains('ok')) showBanner('')

  const usersBody = $('users-body')
  const users = state.users || []
  lastUsers = users
  usersBody.innerHTML = users.length
    ? users
        .map(
          (user) => `
        <tr>
          <td>${escapeHtml(user.userId)}</td>
          <td>${escapeHtml(user.name)}</td>
          <td>${roleLabel(user.role)}</td>
          <td>
            <div class="row-actions">
              <button type="button" class="link" data-edit-uid="${escapeHtml(user.uid)}">Edit</button>
              <button type="button" class="link danger" data-del="${escapeHtml(user.uid)}" data-name="${escapeHtml(user.name)}">Delete</button>
            </div>
          </td>
        </tr>`,
        )
        .join('')
    : `<tr><td colspan="4" class="empty">No people on the device</td></tr>`

  const logsBody = $('logs-body')
  const logs = state.logs || []
  logsBody.innerHTML = logs.length
    ? logs
        .map(
          (log) => `
        <tr class="${log.live ? 'live' : ''}">
          <td>${escapeHtml(formatTime(log.time))}</td>
          <td>${escapeHtml(log.name)}</td>
          <td>${escapeHtml(log.userId)}</td>
        </tr>`,
        )
        .join('')
    : `<tr><td colspan="3" class="empty">No punches yet</td></tr>`

  $('sync').textContent = state.lastSync
    ? `Last sync ${formatTime(state.lastSync)}`
    : 'Not synced yet'
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

async function api(url, options) {
  const res = await fetch(url, options)
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || res.statusText)
  render(data)
  return data
}

function resetForm() {
  $('user-form').reset()
  $('user-uid').value = ''
  $('user-save').textContent = 'Add person'
  $('user-cancel').classList.add('hidden')
}

function fillForm(user) {
  $('user-uid').value = user.uid
  $('user-userid').value = user.userId
  $('user-name').value = user.name
  $('user-password').value = ''
  $('user-role').value = Number(user.role) === 14 ? '14' : '0'
  $('user-card').value = user.card || ''
  $('user-save').textContent = 'Save person'
  $('user-cancel').classList.remove('hidden')
  $('user-name').focus()
}

$('mode-switch').addEventListener('click', (event) => {
  const button = event.target.closest('[data-mode]')
  if (!button) return
  api('/api/mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: button.getAttribute('data-mode') }),
  }).catch((err) => showBanner(err.message))
})

$('refresh').addEventListener('click', () => {
  $('refresh').disabled = true
  api('/api/refresh', { method: 'POST' })
    .catch((err) => showBanner(err.message))
    .finally(() => {
      $('refresh').disabled = false
    })
})

$('user-cancel').addEventListener('click', resetForm)

$('user-form').addEventListener('submit', (event) => {
  event.preventDefault()
  const button = $('user-save')
  button.disabled = true
  const uid = $('user-uid').value
  api('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      uid: uid ? Number(uid) : undefined,
      userId: $('user-userid').value.trim(),
      name: $('user-name').value.trim(),
      password: $('user-password').value,
      role: Number($('user-role').value),
      card: $('user-card').value.trim(),
    }),
  })
    .then((state) => {
      const queued = state.mode === 'adms'
      showBanner(
        queued
          ? uid
            ? 'Person queued — waiting for the device to poll'
            : 'Person add queued — waiting for the device to poll'
          : uid
            ? 'Person saved on the device'
            : 'Person added on the device',
        true,
      )
      resetForm()
    })
    .catch((err) => showBanner(err.message))
    .finally(() => {
      button.disabled = false
    })
})

$('users-body').addEventListener('click', (event) => {
  const edit = event.target.closest('[data-edit-uid]')
  if (edit) {
    const user = lastUsers.find((item) => String(item.uid) === edit.getAttribute('data-edit-uid'))
    if (user) fillForm(user)
    return
  }
  const del = event.target.closest('[data-del]')
  if (!del) return
  const name = del.getAttribute('data-name')
  if (!confirm(`Delete ${name} from the device? Face / fingerprint data for this person is also removed.`)) return
  del.disabled = true
  api(`/api/users/${del.getAttribute('data-del')}`, { method: 'DELETE' })
    .then((state) =>
      showBanner(
        state.mode === 'adms' ? `${name} delete queued — waiting for the device to poll` : `${name} deleted`,
        true,
      ),
    )
    .catch((err) => showBanner(err.message))
    .finally(() => {
      del.disabled = false
    })
})

$('clear-logs').addEventListener('click', () => {
  if (!confirm('Delete ALL attendance logs on the device? This cannot be undone.')) return
  const button = $('clear-logs')
  button.disabled = true
  api('/api/logs/clear', { method: 'POST' })
    .then((state) =>
      showBanner(
        state.mode === 'adms'
          ? 'Clear queued — waiting for the device to poll'
          : 'Attendance logs cleared',
        true,
      ),
    )
    .catch((err) => showBanner(err.message))
    .finally(() => {
      button.disabled = false
    })
})

api('/api/status').catch((err) => showBanner(err.message))

const events = new EventSource('/api/events')
events.addEventListener('status', (event) => {
  render(JSON.parse(event.data))
})
events.addEventListener('punch', (event) => {
  const punch = JSON.parse(event.data)
  showBanner(`Live punch: ${punch.name} at ${formatTime(punch.time)}`)
})
