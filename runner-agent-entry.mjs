#!/usr/bin/env node
/**
 * R3.1 — thin runner-agent entry for managed VMs.
 * Expects ORCHESTRATOR_API_URL, ORCHESTRATOR_RUNNER_TOKEN, ORCHESTRATOR_WORKSPACE_ID.
 *
 * Loop: heartbeat → poll pending → (OpenCode) drive local harness → CP ingest.
 * Served to VMs via GET /api/runner/bootstrap (start.sh curls this when token set).
 * R3.1b: authenticated shell PTY WebSocket on 127.0.0.1:ORCHESTRATOR_PTY_PORT.
 */
import {
  createHash,
  randomBytes,
  timingSafeEqual as cryptoTimingSafeEqual,
} from 'node:crypto'
import { createServer } from 'node:http'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const SCRIPT_STOP_GRACE_MS = Number(
  process.env.ORCHESTRATOR_SCRIPT_STOP_GRACE_MS || 200
)

const apiUrl = (process.env.ORCHESTRATOR_API_URL || '').replace(/\/$/, '')
const token = process.env.ORCHESTRATOR_RUNNER_TOKEN || ''
const workspaceId = process.env.ORCHESTRATOR_WORKSPACE_ID || ''
const agent = process.env.ORCHESTRATOR_AGENT || 'opencode'
const pollMs = Number(process.env.ORCHESTRATOR_AGENT_POLL_MS || 2000)
const heartbeatMs = Number(process.env.ORCHESTRATOR_AGENT_HEARTBEAT_MS || 15000)
const driveEnabled = process.env.ORCHESTRATOR_AGENT_DRIVE !== '0'

if (!apiUrl || !token || !workspaceId) {
  console.error(
    'runner-agent: missing ORCHESTRATOR_API_URL / ORCHESTRATOR_RUNNER_TOKEN / ORCHESTRATOR_WORKSPACE_ID'
  )
  process.exit(1)
}

const headers = {
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
}

/** @type {Set<string>} */
const inFlight = new Set()
/** @type {Map<string, AbortController>} */
const turnAborts = new Map()
/** @type {string | null} */
let cachedSessionId = process.env.ORCHESTRATOR_OPENCODE_SESSION_ID || null
/** @type {boolean} */
let restartInFlight = false

function internalPort() {
  return Number(
    process.env.INTERNAL_PORT || process.env.OPENCODE_INTERNAL_PORT || 18080
  )
}

function runtimeBase() {
  const explicit = (process.env.RUNTIME_URL || '').replace(/\/$/, '')
  if (explicit) return explicit
  // opencode-railway-template: public PORT is the wrapper; OpenCode is on INTERNAL_PORT.
  return `http://127.0.0.1:${internalPort()}`
}

function parseListeningPids(output) {
  const pids = new Set()
  for (const match of String(output || '').matchAll(/pid=(\d+)/gi)) {
    const n = Number(match[1])
    if (Number.isInteger(n) && n > 0) pids.add(n)
  }
  for (const match of String(output || '').matchAll(/(?:^|\s)(\d+)\/\S+/g)) {
    const n = Number(match[1])
    if (Number.isInteger(n) && n > 0) pids.add(n)
  }
  return [...pids]
}

/** Linux /proc fallback when ss/lsof/fuser are missing. Hard-capped (can be slow). */
async function findListeningPidsViaProc(port, budgetMs = 1500) {
  const portNum = Number(port)
  if (!Number.isInteger(portNum) || portNum <= 0) return []
  const started = Date.now()
  try {
    const fs = await import('node:fs/promises')
    const hexPort = portNum.toString(16).toUpperCase().padStart(4, '0')
    const tcp = await fs.readFile('/proc/net/tcp', 'utf8').catch(() => '')
    const tcp6 = await fs.readFile('/proc/net/tcp6', 'utf8').catch(() => '')
    const inodes = new Set()
    for (const line of `${tcp}\n${tcp6}`.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/)
      if (cols.length < 10) continue
      const local = cols[1] || ''
      const state = cols[3]
      const inode = cols[9]
      // 0A = LISTEN
      if (state !== '0A') continue
      if (!local.toUpperCase().endsWith(`:${hexPort}`)) continue
      if (inode && inode !== '0') inodes.add(inode)
    }
    if (!inodes.size) return []
    const pids = new Set()
    const procDirs = await fs.readdir('/proc')
    for (const ent of procDirs) {
      if (Date.now() - started > budgetMs) break
      if (!/^\d+$/.test(ent)) continue
      let fds
      try {
        fds = await fs.readdir(`/proc/${ent}/fd`)
      } catch {
        continue
      }
      for (const fd of fds) {
        try {
          const link = await fs.readlink(`/proc/${ent}/fd/${fd}`)
          const m = /^socket:\[(\d+)\]$/.exec(link)
          if (m && inodes.has(m[1])) pids.add(Number(ent))
        } catch {
          /* ignore */
        }
      }
      if (pids.size) return [...pids]
    }
    return [...pids]
  } catch {
    return []
  }
}

async function findListeningPids(port) {
  const attempts = [
    { cmd: 'ss', args: ['-lptn', `sport = :${port}`] },
    { cmd: 'lsof', args: ['-ti', `TCP:${port}`, '-sTCP:LISTEN'] },
    { cmd: 'fuser', args: [`${port}/tcp`] },
  ]
  for (const attempt of attempts) {
    try {
      const { stdout, stderr } = await execFileAsync(attempt.cmd, attempt.args, {
        timeout: 5000,
      })
      const text = `${stdout || ''}\n${stderr || ''}`
      if (attempt.cmd === 'lsof') {
        const bare = text
          .split(/\s+/)
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isInteger(n) && n > 0)
        if (bare.length) return [...new Set(bare)]
      }
      const parsed = parseListeningPids(text)
      if (parsed.length) return parsed
    } catch {
      /* try next */
    }
  }
  return findListeningPidsViaProc(port)
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function stopPid(pid, graceMs = SCRIPT_STOP_GRACE_MS) {
  if (!pidAlive(pid)) return false
  try {
    process.kill(pid, 'SIGHUP')
  } catch {
    /* ignore */
  }
  await new Promise((r) => setTimeout(r, graceMs))
  if (!pidAlive(pid)) return true
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    /* ignore */
  }
  await new Promise((r) => setTimeout(r, 50))
  return !pidAlive(pid)
}

async function waitHealth(base, auth, expectAlive, maxMs) {
  const started = Date.now()
  while (Date.now() - started < maxMs) {
    let alive = false
    try {
      const res = await fetch(`${base}/global/health`, {
        headers: auth ? { Authorization: auth } : {},
        signal: AbortSignal.timeout(4000),
      })
      alive = res.ok
    } catch {
      alive = false
    }
    if (alive === expectAlive) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

async function probeHarnessAlive() {
  const base = runtimeBase()
  const auth = openCodeAuthHeader()
  try {
    const res = await fetch(`${base}/global/health`, {
      headers: auth ? { Authorization: auth } : {},
      signal: AbortSignal.timeout(4000),
    })
    return res.ok
  } catch {
    return false
  }
}

/** Prefer wrapper loopback restart (tracks the child); fall back to PID kill. */
async function requestWrapperRestart() {
  const port = Number(process.env.PORT || 8080)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/orch/restart-harness`, {
      method: 'POST',
      signal: AbortSignal.timeout(8000),
    })
    const text = await res.text().catch(() => '')
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    return {
      ok: res.ok && json?.ok !== false,
      status: res.status,
      detail: json,
    }
  } catch (err) {
    return {
      ok: false,
      status: 0,
      detail: {
        error: err instanceof Error ? err.message : String(err),
      },
    }
  }
}

/** R3.4 — kill harness process; wrapper must respawn OpenCode (not service exit). */
async function restartHarnessProcess() {
  const port = internalPort()
  const base = runtimeBase()
  const auth = openCodeAuthHeader()
  // Wrapper first — owns the child PID; avoid slow /proc scans on the hot path.
  const wrapper = await requestWrapperRestart()
  console.log('runner-agent: restart_harness wrapper', {
    port,
    wrapperOk: wrapper.ok,
    wrapperStatus: wrapper.status,
    wrapperDetail: wrapper.detail,
  })
  let pidBefore = []
  if (!wrapper.ok) {
    pidBefore = await findListeningPids(port)
    console.log('runner-agent: restart_harness pid fallback', { pidBefore })
    for (const pid of pidBefore) {
      await stopPid(pid)
    }
  }
  // Clear cached session — OpenCode process restart drops in-memory state.
  cachedSessionId = null
  const down = await waitHealth(base, auth, false, 20000)
  const up = await waitHealth(base, auth, true, 90000)
  // Evidence: health flap, or wrapper accepted the signal.
  const ok = up && (down || wrapper.ok)
  return {
    ok,
    pidBefore,
    downObserved: down,
    wrapper,
    error: ok
      ? undefined
      : !up
        ? 'harness health did not recover after kill'
        : 'kill did not displace harness listeners',
  }
}

async function ackRestartHarness(result, detail) {
  const res = await fetch(`${apiUrl}/api/runner/control`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      workspaceId,
      action: 'restart_harness',
      result,
      harnessAlive: result === 'done',
      detail,
    }),
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) {
    console.warn('runner-agent: restart ack', res.status, await res.text())
  }
}

function openCodeAuthHeader() {
  const user = process.env.OPENCODE_SERVER_USERNAME || 'opencode'
  const pass = process.env.OPENCODE_SERVER_PASSWORD || ''
  if (!pass) return null
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')
}

/** Keep in sync with src/lib/harness-stream.ts OpenCode extract helpers. */
function asRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value
}

function pickOpenCodeAssistantMessage(data) {
  if (data == null) return null
  if (Array.isArray(data)) {
    for (let i = data.length - 1; i >= 0; i--) {
      const row = asRecord(data[i])
      if (!row) continue
      const info = asRecord(row.info)
      if (info && info.role === 'assistant') return row
    }
    for (let i = data.length - 1; i >= 0; i--) {
      const row = asRecord(data[i])
      if (!row || !Array.isArray(row.parts)) continue
      const info = asRecord(row.info)
      if (info && info.role === 'user') continue
      return row
    }
    return null
  }
  const root = asRecord(data)
  if (!root) return null
  if ('data' in root && root.data !== undefined) {
    const nested = pickOpenCodeAssistantMessage(root.data)
    if (nested) return nested
  }
  if (Array.isArray(root.messages)) {
    const nested = pickOpenCodeAssistantMessage(root.messages)
    if (nested) return nested
  }
  if (Array.isArray(root.parts) || root.info) {
    const info = asRecord(root.info)
    if (info && info.role === 'user') return null
    return root
  }
  return null
}

function extractOpenCodeText(data) {
  const message = pickOpenCodeAssistantMessage(data)
  if (!message || !Array.isArray(message.parts)) return ''
  return message.parts
    .map((p) => {
      const part = asRecord(p)
      if (!part || part.type !== 'text') return ''
      if (typeof part.text === 'string') return part.text
      if (typeof part.content === 'string') return part.content
      return ''
    })
    .filter(Boolean)
    .join('')
}

function extractOpenCodeError(data) {
  const message = pickOpenCodeAssistantMessage(data)
  const info = asRecord(message && message.info)
  if (!info) return ''
  const err = info.error
  if (typeof err === 'string' && err.trim()) return err.trim()
  const obj = asRecord(err)
  if (!obj) return ''
  const nested = asRecord(obj.data)
  const detail =
    (typeof obj.message === 'string' && obj.message.trim()) ||
    (nested && typeof nested.message === 'string' && nested.message.trim()) ||
    (typeof obj.data === 'string' && obj.data.trim()) ||
    ''
  const name =
    typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : ''
  if (name && detail) return `${name}: ${detail}`
  if (detail) return detail
  if (name) {
    try {
      const rest = JSON.stringify(obj)
      if (rest && rest !== '{}' && rest !== `{"name":"${name}"}`) {
        return `${name} ${rest}`.slice(0, 400)
      }
    } catch {
      /* ignore */
    }
    return name
  }
  try {
    return JSON.stringify(obj)
  } catch {
    return ''
  }
}

async function fetchOpenCodeMessageList(base, auth, sessionId) {
  const res = await fetch(
    `${base}/session/${encodeURIComponent(sessionId)}/message`,
    {
      headers: auth ? { Authorization: auth } : {},
      signal: AbortSignal.timeout(60000),
    }
  )
  if (!res.ok) return null
  return res.json().catch(() => null)
}

function extractSessionId(data) {
  if (!data || typeof data !== 'object') return null
  if (typeof data.id === 'string' && data.id.trim()) return data.id.trim()
  if (data.info && typeof data.info.id === 'string') return data.info.id.trim()
  return null
}

function mintMessageId() {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

async function heartbeat() {
  const harnessAlive = await probeHarnessAlive()
  const res = await fetch(`${apiUrl}/api/runner/control`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      workspaceId,
      action: 'heartbeat',
      harnessAlive,
    }),
  })
  if (!res.ok) {
    console.warn('runner-agent: heartbeat', res.status, await res.text())
  }
}

async function pushIngest(payload) {
  const res = await fetch(`${apiUrl}/api/runner/ingest`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ workspaceId, ...payload }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(json.error || `ingest HTTP ${res.status}`)
  }
  return json
}

async function waitForOpenCode(base, auth, maxMs = 180000) {
  const started = Date.now()
  while (Date.now() - started < maxMs) {
    try {
      const res = await fetch(`${base}/global/health`, {
        headers: auth ? { Authorization: auth } : {},
        signal: AbortSignal.timeout(5000),
      })
      if (res.ok) return true
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  return false
}

async function ensureOpenCodeSession(base, auth) {
  if (cachedSessionId) return cachedSessionId
  const res = await fetch(`${base}/session`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: auth } : {}),
    },
    body: JSON.stringify({ title: workspaceId }),
    signal: AbortSignal.timeout(60000),
  })
  if (!res.ok) {
    throw new Error(`session create ${res.status}`)
  }
  const data = await res.json().catch(() => ({}))
  const id = extractSessionId(data)
  if (!id) throw new Error('session create returned no id')
  cachedSessionId = id
  return id
}

async function driveOpenCodeTurn(pending) {
  const attemptId = pending.attemptId
  if (!attemptId || inFlight.has(attemptId)) return
  if (
    pending.assistantStatus === 'complete' ||
    pending.assistantStatus === 'error' ||
    pending.assistantStatus === 'cancelled'
  ) {
    return
  }

  const userContent =
    typeof pending.userContent === 'string' ? pending.userContent : ''
  if (!userContent.trim()) {
    console.warn('runner-agent: pending without userContent', attemptId)
    return
  }

  inFlight.add(attemptId)
  const abort = new AbortController()
  turnAborts.set(attemptId, abort)
  const turnTimeoutMs = Number(
    process.env.ORCHESTRATOR_AGENT_TURN_TIMEOUT_MS || 240000
  )
  const timeout = setTimeout(() => abort.abort(), turnTimeoutMs)
  const messageId =
    (typeof pending.messageId === 'string' && pending.messageId.trim()) ||
    mintMessageId()
  const base = runtimeBase()
  const auth = openCodeAuthHeader()
  const started = Date.now()
  let writeSeq = 0

  try {
    console.log('runner-agent: driving OpenCode turn', attemptId)
    const healthy = await waitForOpenCode(base, auth, 120000)
    if (!healthy) throw new Error(`OpenCode health timeout at ${base}`)

    if (typeof pending.opencodeSessionId === 'string' && pending.opencodeSessionId) {
      cachedSessionId = pending.opencodeSessionId
    }
    const sessionId = await ensureOpenCodeSession(base, auth)

    await pushIngest({
      agent: 'opencode',
      messageId,
      attemptId,
      content: '',
      status: 'streaming',
      writeSeq: ++writeSeq,
    })

    const res = await fetch(
      `${base}/session/${encodeURIComponent(sessionId)}/message`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(auth ? { Authorization: auth } : {}),
        },
        body: JSON.stringify({
          parts: [{ type: 'text', text: userContent }],
          agent: process.env.OPENCODE_MODE || 'build',
          // Managed OpenCode often runs DeepSeek via OpenRouter, which rejects
          // tool-use ("No endpoints found that support tool use"). Deny the
          // build-agent tool surface so text turns still complete. Set
          // ORCHESTRATOR_AGENT_ALLOW_TOOLS=1 to keep tools enabled.
          ...(process.env.ORCHESTRATOR_AGENT_ALLOW_TOOLS === '1'
            ? {}
            : {
                tools: {
                  bash: false,
                  edit: false,
                  write: false,
                  read: false,
                  glob: false,
                  grep: false,
                  list: false,
                  task: false,
                  webfetch: false,
                  websearch: false,
                  lsp: false,
                  skill: false,
                  question: false,
                  todowrite: false,
                  apply_patch: false,
                },
              }),
        }),
        signal: abort.signal,
      }
    )
    // OpenCode can return HTTP 200 with an empty body when `agent` resolution
    // fails silently — parse text first, then fall back to GET message list.
    const raw = await res.text().catch(() => '')
    let data = {}
    if (raw.trim()) {
      try {
        data = JSON.parse(raw)
      } catch {
        data = {}
      }
    }
    if (!res.ok) {
      throw new Error(
        (data && typeof data.error === 'string' && data.error) ||
          raw.slice(0, 240) ||
          `OpenCode message HTTP ${res.status}`
      )
    }

    let content = extractOpenCodeText(data)
    let errMsg = extractOpenCodeError(data)
    if (!content.trim()) {
      const listed = await fetchOpenCodeMessageList(base, auth, sessionId)
      if (listed) {
        content = extractOpenCodeText(listed)
        if (!errMsg) errMsg = extractOpenCodeError(listed)
        if (content.trim()) {
          console.log(
            'runner-agent: recovered assistant text from message list',
            attemptId,
            `${content.length} chars`
          )
        }
      }
    }

    if (!content.trim() && errMsg) {
      throw new Error(errMsg)
    }
    if (!content.trim()) {
      const preview = raw.trim().slice(0, 240)
      throw new Error(
        preview
          ? `OpenCode returned no assistant text parts body=${preview}`
          : 'OpenCode returned empty message body (no assistant text)'
      )
    }

    await pushIngest({
      agent: 'opencode',
      messageId,
      attemptId,
      content,
      status: 'complete',
      writeSeq: ++writeSeq,
      durationMs: Math.max(0, Date.now() - started),
    })
    console.log(
      'runner-agent: turn complete',
      attemptId,
      `${content.length} chars`
    )
  } catch (err) {
    const aborted =
      (err && typeof err === 'object' && err.name === 'AbortError') ||
      (err instanceof Error && /abort/i.test(err.message))
    const msg = aborted
      ? 'cancelled'
      : err instanceof Error
        ? err.message
        : String(err)
    console.error('runner-agent: turn failed', attemptId, msg)
    try {
      await pushIngest({
        agent: 'opencode',
        messageId,
        attemptId,
        content: aborted ? 'Turn cancelled' : msg,
        status: aborted ? 'cancelled' : 'error',
        writeSeq: ++writeSeq,
        durationMs: Math.max(0, Date.now() - started),
      })
    } catch (ingestErr) {
      console.error('runner-agent: error ingest failed', ingestErr)
    }
  } finally {
    clearTimeout(timeout)
    turnAborts.delete(attemptId)
    inFlight.delete(attemptId)
  }
}

async function pollPending() {
  const res = await fetch(
    `${apiUrl}/api/runner/pending?agent=${encodeURIComponent(agent)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  if (!res.ok) {
    console.warn('runner-agent: pending', res.status)
    return
  }
  const json = await res.json()

  // R3.4 — cancel reaches the process: abort in-flight when attempt cleared / cancelled
  if (json.pending?.attemptId && json.pending.assistantStatus === 'cancelled') {
    const ac = turnAborts.get(json.pending.attemptId)
    if (ac) ac.abort()
  }
  for (const [attemptId, ac] of turnAborts) {
    if (!json.pending || json.pending.attemptId !== attemptId) {
      // Attempt cleared from thread (CP cancel) while we were driving it.
      if (inFlight.has(attemptId)) ac.abort()
    }
  }

  // R3.4 — restart-harness queue (kill/respawn harness process, not Railway redeploy)
  if (json.control?.restartHarness && !restartInFlight) {
    restartInFlight = true
    try {
      // Abort any in-flight turn before killing the harness.
      for (const ac of turnAborts.values()) ac.abort()
      const detail = await restartHarnessProcess()
      await ackRestartHarness(detail.ok ? 'done' : 'error', detail)
      console.log(
        'runner-agent: restart_harness',
        detail.ok ? 'done' : 'error',
        detail
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await ackRestartHarness('error', { error: msg })
      console.error('runner-agent: restart_harness failed', msg)
    } finally {
      restartInFlight = false
    }
  }

  if (!json.pending) return

  if (agent === 'opencode' && driveEnabled) {
    await driveOpenCodeTurn(json.pending)
    return
  }

  console.log(
    'runner-agent: pending turn',
    json.pending.attemptId,
    agent === 'hermes'
      ? '(Hermes drive: not yet in this entry)'
      : '(drive disabled)'
  )
}

// --- R3.1b: authenticated interactive shell PTY over WebSocket -------------
// Listens on 127.0.0.1:ORCHESTRATOR_PTY_PORT (default 19090). The Railway
// wrapper proxies public `/orch/pty` upgrades here. Auth = Bearer runner token.
const ptyPort = Number(process.env.ORCHESTRATOR_PTY_PORT || 19090)
const ptyEnabled = process.env.ORCHESTRATOR_AGENT_PTY !== '0'

function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a || ''), 'utf8')
  const bb = Buffer.from(String(b || ''), 'utf8')
  if (ab.length !== bb.length) return false
  return cryptoTimingSafeEqual(ab, bb)
}

function authorizePtyRequest(req) {
  // Wrapper already requires Basic; this second factor is the runner token or
  // the OpenCode server password (smoke has the latter via runtime_auth decrypt
  // without rotating the in-VM runner token).
  const openCodePass = process.env.OPENCODE_SERVER_PASSWORD || ''
  const candidates = [token, openCodePass].filter((v) => v && String(v).length > 0)
  const auth = String(req.headers.authorization || '')
  if (auth.startsWith('Bearer ')) {
    const presented = auth.slice(7).trim()
    return candidates.some((c) => timingSafeEqualStr(presented, c))
  }
  try {
    const u = new URL(req.url || '/', 'http://127.0.0.1')
    const q = u.searchParams.get('token') || ''
    return candidates.some((c) => timingSafeEqualStr(q, c))
  } catch {
    return false
  }
}

function wsAcceptKey(secKey) {
  return createHash('sha1')
    .update(secKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11', 'binary')
    .digest('base64')
}

function wsSendText(socket, text) {
  const payload = Buffer.from(text, 'utf8')
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.alloc(2)
    header[0] = 0x81
    header[1] = len
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeUInt32BE(0, 2)
    header.writeUInt32BE(len, 6)
  }
  socket.write(Buffer.concat([header, payload]))
}

function attachWsReader(socket, onText) {
  let buf = Buffer.alloc(0)
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk])
    while (buf.length >= 2) {
      const finOpcode = buf[0]
      const opcode = finOpcode & 0x0f
      const masked = (buf[1] & 0x80) !== 0
      let payloadLen = buf[1] & 0x7f
      let offset = 2
      if (payloadLen === 126) {
        if (buf.length < 4) return
        payloadLen = buf.readUInt16BE(2)
        offset = 4
      } else if (payloadLen === 127) {
        if (buf.length < 10) return
        payloadLen = Number(buf.readBigUInt64BE(2))
        offset = 10
      }
      const maskLen = masked ? 4 : 0
      const total = offset + maskLen + payloadLen
      if (buf.length < total) return
      let payload = buf.subarray(offset + maskLen, total)
      if (masked) {
        const mask = buf.subarray(offset, offset + 4)
        payload = Buffer.from(payload)
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
      }
      buf = buf.subarray(total)
      if (opcode === 0x8) {
        socket.end()
        return
      }
      if (opcode === 0x9) {
        // ping → pong
        const pong = Buffer.alloc(2 + payload.length)
        pong[0] = 0x8a
        pong[1] = payload.length
        payload.copy(pong, 2)
        socket.write(pong)
        continue
      }
      if (opcode === 0x1) onText(payload.toString('utf8'))
    }
  })
}

function spawnShellPty() {
  // util-linux/bsdutils `script` allocates a real PTY (not Phase 5 one-shot).
  const shell = process.env.ORCHESTRATOR_PTY_SHELL || 'bash -l'
  const child = spawn('script', ['-qfc', shell, '/dev/null'], {
    env: { ...process.env, TERM: process.env.TERM || 'xterm-256color' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  return child
}

function startPtyServer() {
  if (!ptyEnabled) {
    console.log('runner-agent: PTY server disabled')
    return
  }
  const server = createServer((req, res) => {
    const path = (req.url || '').split('?')[0]
    if (path === '/orch/pty/health' || path === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('ok')
      return
    }
    res.writeHead(404)
    res.end('not found')
  })

  server.on('upgrade', (req, socket, head) => {
    const path = (req.url || '').split('?')[0]
    if (path !== '/orch/pty' && path !== '/orch/pty/') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    if (!authorizePtyRequest(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    const secKey = req.headers['sec-websocket-key']
    if (!secKey || typeof secKey !== 'string') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${wsAcceptKey(secKey)}\r\n` +
        '\r\n'
    )
    if (head && head.length) socket.unshift(head)

    const sessionId = `pty-${Date.now()}-${randomBytes(3).toString('hex')}`
    const child = spawnShellPty()
    let closed = false
    const closeAll = () => {
      if (closed) return
      closed = true
      try {
        child.kill('SIGTERM')
      } catch {
        /* ignore */
      }
      try {
        socket.end()
      } catch {
        /* ignore */
      }
    }

    child.stdout.on('data', (d) => {
      try {
        wsSendText(
          socket,
          JSON.stringify({ type: 'output', data: d.toString('utf8'), sessionId })
        )
      } catch {
        closeAll()
      }
    })
    child.stderr.on('data', (d) => {
      try {
        wsSendText(
          socket,
          JSON.stringify({ type: 'output', data: d.toString('utf8'), sessionId })
        )
      } catch {
        closeAll()
      }
    })
    child.on('exit', (code) => {
      try {
        wsSendText(
          socket,
          JSON.stringify({ type: 'exit', code: code ?? null, sessionId })
        )
      } catch {
        /* ignore */
      }
      closeAll()
    })

    wsSendText(
      socket,
      JSON.stringify({
        type: 'ready',
        sessionId,
        workspaceId,
        interaction: 'pty',
      })
    )

    attachWsReader(socket, (raw) => {
      let msg
      try {
        msg = JSON.parse(raw)
      } catch {
        return
      }
      if (msg.type === 'input' && typeof msg.data === 'string') {
        try {
          child.stdin.write(msg.data)
        } catch {
          closeAll()
        }
        return
      }
      if (
        msg.type === 'resize' &&
        typeof msg.cols === 'number' &&
        typeof msg.rows === 'number'
      ) {
        // script(1) PTY: best-effort via stty (node-pty ioctl lands with R4 image).
        try {
          child.stdin.write(`stty cols ${msg.cols} rows ${msg.rows}\n`)
        } catch {
          /* ignore */
        }
        return
      }
      if (msg.type === 'close') closeAll()
    })

    socket.on('close', closeAll)
    socket.on('error', closeAll)
    console.log('runner-agent: PTY session open', sessionId)
  })

  server.listen(ptyPort, '127.0.0.1', () => {
    console.log('runner-agent: PTY WebSocket on 127.0.0.1:' + ptyPort + '/orch/pty')
  })
  server.on('error', (err) => {
    console.error('runner-agent: PTY server error', err.message)
  })
}

console.log('runner-agent: started', {
  workspaceId,
  apiUrl,
  agent,
  driveEnabled,
  runtime: runtimeBase(),
  ptyPort: ptyEnabled ? ptyPort : null,
})
startPtyServer()
await heartbeat()
setInterval(() => {
  void heartbeat()
}, heartbeatMs)
/** Serialize polls so restart_harness / turns do not overlap. */
let pollBusy = false
setInterval(() => {
  if (pollBusy) return
  pollBusy = true
  void pollPending().finally(() => {
    pollBusy = false
  })
}, pollMs)
