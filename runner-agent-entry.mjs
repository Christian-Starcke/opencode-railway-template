#!/usr/bin/env node
/**
 * R3.1 â€” thin runner-agent entry for managed VMs.
 * Expects ORCHESTRATOR_API_URL, ORCHESTRATOR_RUNNER_TOKEN, ORCHESTRATOR_WORKSPACE_ID.
 *
 * Loop: heartbeat â†’ poll pending â†’ (OpenCode) drive local harness â†’ CP ingest.
 * Served to VMs via GET /api/runner/bootstrap (start.sh curls this when token set).
 */
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
/** @type {string | null} */
let cachedSessionId = process.env.ORCHESTRATOR_OPENCODE_SESSION_ID || null

function runtimeBase() {
  const explicit = (process.env.RUNTIME_URL || '').replace(/\/$/, '')
  if (explicit) return explicit
  // opencode-railway-template: public PORT is the wrapper; OpenCode is on INTERNAL_PORT.
  const port = process.env.INTERNAL_PORT || process.env.OPENCODE_INTERNAL_PORT || '18080'
  return `http://127.0.0.1:${port}`
}

function openCodeAuthHeader() {
  const user = process.env.OPENCODE_SERVER_USERNAME || 'opencode'
  const pass = process.env.OPENCODE_SERVER_PASSWORD || ''
  if (!pass) return null
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')
}

function extractOpenCodeText(data) {
  if (!data || typeof data !== 'object') return ''
  const parts = data.parts
  if (!Array.isArray(parts)) return ''
  return parts
    .filter(
      (p) =>
        p &&
        typeof p === 'object' &&
        p.type === 'text' &&
        typeof p.text === 'string'
    )
    .map((p) => p.text)
    .join('')
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
  const res = await fetch(`${apiUrl}/api/runner/control`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      workspaceId,
      action: 'heartbeat',
      harnessAlive: Boolean(
        process.env.RUNTIME_URL || process.env.OPENCODE_SERVER_PASSWORD
      ),
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
        }),
        signal: AbortSignal.timeout(
          Number(process.env.ORCHESTRATOR_AGENT_TURN_TIMEOUT_MS || 240000)
        ),
      }
    )
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error(
        typeof data.error === 'string'
          ? data.error
          : `OpenCode message HTTP ${res.status}`
      )
    }
    const content = extractOpenCodeText(data) || '(empty assistant response)'
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
    const msg = err instanceof Error ? err.message : String(err)
    console.error('runner-agent: turn failed', attemptId, msg)
    try {
      await pushIngest({
        agent: 'opencode',
        messageId,
        attemptId,
        content: msg,
        status: 'error',
        writeSeq: ++writeSeq,
        durationMs: Math.max(0, Date.now() - started),
      })
    } catch (ingestErr) {
      console.error('runner-agent: error ingest failed', ingestErr)
    }
  } finally {
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

console.log('runner-agent: started', {
  workspaceId,
  apiUrl,
  agent,
  driveEnabled,
  runtime: runtimeBase(),
})
await heartbeat()
setInterval(() => {
  void heartbeat()
}, heartbeatMs)
setInterval(() => {
  void pollPending()
}, pollMs)
