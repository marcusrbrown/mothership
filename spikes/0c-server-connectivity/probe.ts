#!/usr/bin/env bun
/**
 * Spike 0c: live server connectivity + SSE contract probe.
 *
 * Run with: bun spikes/0c-server-connectivity/probe.ts
 *
 * Probes a running `opencode serve` instance (no LLM; no mutation beyond a
 * throwaway probe session unless an explicitly disposable blocked-session
 * fixture is supplied) and prints a structured report used to maintain the
 * server-contract solution note.
 */

const BASE_URL = process.env.OPENCODE_BASE_URL ?? 'http://127.0.0.1:4096'
const TAURI_ORIGIN = 'tauri://localhost'
const PHASE_TIMEOUT_MS = 90_000
const SSE_OBSERVE_MS = 25_000
// Basic-auth password for a running managed server, e.g. from
// `~/.local/state/space-bus/<id>/discovery.json` — required on password-protected
// deployments (the tracer's "unauthenticated loopback" assumption does not hold
// for every managed-server instance observed in this environment).
const AUTH_PASSWORD = process.env.OPENCODE_SERVER_PASSWORD
const AUTH_USERNAME = process.env.OPENCODE_SERVER_USERNAME ?? 'opencode'
const PROBE_DIRECTORY = process.env.OPENCODE_PROBE_DIRECTORY

function authHeaders(): Record<string, string> {
  if (!AUTH_PASSWORD) return {}
  const token = Buffer.from(`${AUTH_USERNAME}:${AUTH_PASSWORD}`).toString('base64')
  return {Authorization: `Basic ${token}`}
}

function withDirectory(path: string): string {
  if (!PROBE_DIRECTORY) return path
  const sep = path.includes('?') ? '&' : '?'
  return `${path}${sep}directory=${encodeURIComponent(PROBE_DIRECTORY)}`
}

// Endpoints the plan claims exist per "Verified Server Facts" + earlier HANDOFF assumptions.
const EXPECTED_ENDPOINTS: {method: string; path: string}[] = [
  {method: 'post', path: '/session'},
  {method: 'post', path: '/session/{id}/prompt_async'},
  {method: 'get', path: '/session/{id}/message'},
  {method: 'get', path: '/session/status'},
  {method: 'get', path: '/session/{id}/todo'},
  {method: 'get', path: '/session/{id}/diff'},
  {method: 'get', path: '/question'},
  {method: 'post', path: '/question/{id}/reply'},
  {method: 'get', path: '/vcs'},
  {method: 'get', path: '/event'},
]

type Section = string

function section(title: Section) {
  console.log(`\n${'='.repeat(80)}\n${title}\n${'='.repeat(80)}`)
}

function jlog(label: string, value: unknown) {
  console.log(`${label}:`, typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

// ---------------------------------------------------------------------------
// Phase 1: GET /doc (OpenAPI) endpoint inventory
// ---------------------------------------------------------------------------
async function probeOpenApi() {
  section('PHASE 1: GET /doc — OpenAPI endpoint inventory')
  try {
    const res = await fetch(`${BASE_URL}/doc`, {headers: authHeaders()})
    if (!res.ok) {
      console.log(`BLOCKED: /doc returned ${res.status} ${res.statusText}`)
      if (res.status === 401) {
        console.log(
          '  Server requires Basic auth. Set OPENCODE_SERVER_PASSWORD (and optionally ' +
            'OPENCODE_SERVER_USERNAME, default "opencode") from the managed-server discovery file, e.g.:\n' +
            '  ~/.local/state/space-bus/<id>/discovery.json -> {"password": "..."}',
        )
      }
      return
    }
    const info = (await res.clone().json()) as {info?: {title?: string; version?: string}}
    console.log('OpenAPI info:', JSON.stringify(info.info))
    const doc = (await res.json()) as {paths?: Record<string, Record<string, unknown>>}
    const paths = doc.paths ?? {}
    const normalizedPaths = Object.keys(paths).map(p => p.replace(/\{[^}]+\}/g, '{id}'))

    console.log(`Total paths in spec: ${Object.keys(paths).length}`)
    console.log('\nEndpoint check vs plan expectations:')
    for (const {method, path} of EXPECTED_ENDPOINTS) {
      const normalizedExpected = path.replace(/\{[^}]+\}/g, '{id}')
      const matchPath = Object.keys(paths).find(p => p.replace(/\{[^}]+\}/g, '{id}') === normalizedExpected)
      if (!matchPath) {
        console.log(`  MISSING: ${method.toUpperCase()} ${path}`)
        continue
      }
      const methods = Object.keys(paths[matchPath] ?? {})
      const has = methods.includes(method)
      console.log(`  ${has ? 'OK' : 'MISSING METHOD'}: ${method.toUpperCase()} ${path} (actual path: ${matchPath}, methods: ${methods.join(',')})`)
    }

    // Also flag things in spec that look adjacent/renamed vs plan (vcs/status etc.)
    const vcsRelated = Object.keys(paths).filter(p => p.toLowerCase().includes('vcs') || p.toLowerCase().includes('file/status'))
    console.log('\nVCS-related paths actually in spec:', vcsRelated)
  } catch (err) {
    console.log('BLOCKED:', err instanceof Error ? err.message : String(err))
  }
}

// ---------------------------------------------------------------------------
// Phase 2: CORS preflight simulation
// ---------------------------------------------------------------------------
async function probeCors() {
  section('PHASE 2: CORS preflight simulation (Origin: tauri://localhost)')
  try {
    const preflight = await fetch(`${BASE_URL}/session/status`, {
      method: 'OPTIONS',
      headers: {
        Origin: TAURI_ORIGIN,
        'Access-Control-Request-Method': 'GET',
      },
    })
    console.log(`OPTIONS /session/status -> ${preflight.status}`)
    jlog('  Access-Control-Allow-Origin', preflight.headers.get('access-control-allow-origin'))
    jlog('  Access-Control-Allow-Methods', preflight.headers.get('access-control-allow-methods'))
    jlog('  Access-Control-Allow-Headers', preflight.headers.get('access-control-allow-headers'))

    const getReq = await fetch(`${BASE_URL}/session/status`, {
      method: 'GET',
      headers: {Origin: TAURI_ORIGIN, ...authHeaders()},
    })
    console.log(`\nGET /session/status (with Origin header) -> ${getReq.status}`)
    jlog('  Access-Control-Allow-Origin', getReq.headers.get('access-control-allow-origin'))
    jlog('  Access-Control-Allow-Credentials', getReq.headers.get('access-control-allow-credentials'))
  } catch (err) {
    console.log('BLOCKED:', err instanceof Error ? err.message : String(err))
  }
}

// ---------------------------------------------------------------------------
// SSE parsing helper — Bun has no EventSource, so parse the stream manually.
// ---------------------------------------------------------------------------
interface SseEvent {
  id?: string
  event?: string
  data: string
  receivedAt: number
}

async function readSse(
  url: string,
  opts: {
    onEvent: (evt: SseEvent) => void
    signal: AbortSignal
  },
): Promise<void> {
  const res = await fetch(url, {signal: opts.signal, headers: {Accept: 'text/event-stream', ...authHeaders()}})
  if (!res.ok || !res.body) {
    throw new Error(`SSE connect failed: ${res.status} ${res.statusText}`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const {done, value} = await reader.read()
      if (done) break
      buffer += decoder.decode(value, {stream: true})
      const chunks = buffer.split('\n\n')
      buffer = chunks.pop() ?? ''
      for (const chunk of chunks) {
        if (!chunk.trim()) continue
        const lines = chunk.split('\n')
        let id: string | undefined
        let event: string | undefined
        const dataLines: string[] = []
        for (const line of lines) {
          if (line.startsWith('id:')) id = line.slice(3).trim()
          else if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
        }
        opts.onEvent({id, event, data: dataLines.join('\n'), receivedAt: Date.now()})
      }
    }
  } catch (err) {
    if ((err as Error).name !== 'AbortError') throw err
  } finally {
    reader.releaseLock()
  }
}

// ---------------------------------------------------------------------------
// Phase 3: SSE lifecycle observation (25s window)
// ---------------------------------------------------------------------------
async function probeSse(fixtureDir?: string) {
  section('PHASE 3: SSE /event lifecycle (25s observation window)')
  const events: SseEvent[] = []
  const controller = new AbortController()
  const url = fixtureDir ? `${BASE_URL}/event?directory=${encodeURIComponent(fixtureDir)}` : `${BASE_URL}/event`
  console.log(`Connecting: ${url}`)

  const timer = setTimeout(() => controller.abort(), SSE_OBSERVE_MS)
  try {
    await readSse(url, {
      signal: controller.signal,
      onEvent: evt => {
        events.push(evt)
        let parsed: unknown = evt.data
        try {
          parsed = JSON.parse(evt.data)
        } catch {
          // leave as raw string
        }
        const typeStr = (parsed as {type?: string})?.type ?? '(unparseable)'
        console.log(`  [+${((evt.receivedAt - startedAt) / 1000).toFixed(1)}s] id=${evt.id ?? '(none)'} sse-event=${evt.event ?? '(default/message)'} type=${typeStr}`)
      },
    })
  } catch (err) {
    console.log('BLOCKED:', err instanceof Error ? err.message : String(err))
  } finally {
    clearTimeout(timer)
  }

  console.log(`\nTotal events received in ${SSE_OBSERVE_MS / 1000}s: ${events.length}`)
  if (events.length > 0) {
    console.log('First event:', events[0]?.data.slice(0, 300))
    console.log('id: field present on events:', events.filter(e => e.id).length, '/', events.length)
    const heartbeats = events.filter(e => {
      try {
        return (JSON.parse(e.data) as {type?: string}).type === 'server.heartbeat'
      } catch {
        return false
      }
    })
    if (heartbeats.length >= 2) {
      const gaps: number[] = []
      for (let i = 1; i < heartbeats.length; i++) {
        gaps.push(((heartbeats[i]?.receivedAt ?? 0) - (heartbeats[i - 1]?.receivedAt ?? 0)) / 1000)
      }
      console.log('Heartbeat cadence (s):', gaps)
    } else {
      console.log('Heartbeats observed:', heartbeats.length, '(need >=2 for cadence)')
    }
  }
  return events
}

const startedAt = Date.now()

// ---------------------------------------------------------------------------
// Phase 4: question-event probe (THE unverified contract item)
// ---------------------------------------------------------------------------
async function probeQuestionEvents() {
  section('PHASE 4: question-event probe (unverified contract item)')

  const distinctEventTypes = new Set<string>()
  const questionEvents: unknown[] = []
  const controller = new AbortController()
  const tailPromise = readSse(`${BASE_URL}/event`, {
    signal: controller.signal,
    onEvent: evt => {
      try {
        const parsed = JSON.parse(evt.data) as {type?: string}
        if (parsed.type) {
          distinctEventTypes.add(parsed.type)
          if (parsed.type.toLowerCase().includes('question')) {
            questionEvents.push(parsed)
            console.log('  QUESTION EVENT:', JSON.stringify(parsed, null, 2))
          }
        }
      } catch {
        // ignore unparseable
      }
    },
  }).catch(err => {
    if ((err as Error).name !== 'AbortError') console.log('SSE tail error:', err)
  })

  let sessionId: string | undefined
  try {
    console.log('Creating probe session...')
    const createRes = await fetch(withDirectory(`${BASE_URL}/session`), {
      method: 'POST',
      headers: {'Content-Type': 'application/json', ...authHeaders()},
      body: JSON.stringify({title: 'spike-0c-question-probe'}),
    })
    if (!createRes.ok) {
      console.log(`BLOCKED: POST /session -> ${createRes.status} ${await createRes.text()}`)
      controller.abort()
      return {distinctEventTypes, questionEvents}
    }
    const session = (await createRes.json()) as {id?: string; sessionID?: string}
    sessionId = session.id ?? session.sessionID
    console.log('Session created:', JSON.stringify(session))
    if (!sessionId) {
      console.log('BLOCKED: could not extract session id from response')
      controller.abort()
      return {distinctEventTypes, questionEvents}
    }

    console.log(`\nSending prompt_async to session ${sessionId}...`)
    const promptRes = await fetch(withDirectory(`${BASE_URL}/session/${sessionId}/prompt_async`), {
      method: 'POST',
      headers: {'Content-Type': 'application/json', ...authHeaders()},
      body: JSON.stringify({
        parts: [
          {
            type: 'text',
            text: 'Call your question/ask-user tool to ask me one yes/no question and wait for my answer. Do nothing else.',
          },
        ],
      }),
    })
    console.log(`POST prompt_async -> ${promptRes.status}`)
    if (promptRes.status !== 204) {
      console.log('Response body (unexpected non-204):', await promptRes.text().catch(() => '(unreadable)'))
    }
  } catch (err) {
    console.log('BLOCKED during session/prompt setup:', err instanceof Error ? err.message : String(err))
    controller.abort()
    return {distinctEventTypes, questionEvents}
  }

  // Wait up to PHASE_TIMEOUT_MS for a question to appear on GET /question.
  console.log(`\nPolling GET /question for up to ${PHASE_TIMEOUT_MS / 1000}s...`)
  const deadline = Date.now() + PHASE_TIMEOUT_MS
  let questionId: string | undefined
  let questionPayload: unknown
  while (Date.now() < deadline) {
    try {
      const qRes = await fetch(withDirectory(`${BASE_URL}/question`), {headers: authHeaders()})
      if (qRes.ok) {
        const questions = (await qRes.json()) as unknown[]
        if (Array.isArray(questions) && questions.length > 0) {
          questionPayload = questions[0]
          questionId = (questionPayload as {id?: string})?.id
          console.log('Question appeared:', JSON.stringify(questionPayload, null, 2))
          break
        }
      }
    } catch {
      // keep polling
    }
    await new Promise(r => setTimeout(r, 2000))
  }

  if (!questionId) {
    console.log(`TIMEOUT: no question appeared on GET /question within ${PHASE_TIMEOUT_MS / 1000}s.`)
    console.log('Distinct event types seen on /event during this phase so far:', [...distinctEventTypes])
  } else {
    console.log(`\nReplying to question ${questionId} with {answers: [["Yes"]]}...`)
    try {
      const replyRes = await fetch(withDirectory(`${BASE_URL}/question/${questionId}/reply`), {
        method: 'POST',
        headers: {'Content-Type': 'application/json', ...authHeaders()},
        body: JSON.stringify({answers: [['Yes']]}),
      })
      console.log(`POST /question/${questionId}/reply -> ${replyRes.status}`)
      console.log('Reply response body:', await replyRes.text().catch(() => '(unreadable)'))
    } catch (err) {
      console.log('BLOCKED during reply:', err instanceof Error ? err.message : String(err))
    }
    // Give a few seconds to observe follow-up events after reply.
    await new Promise(r => setTimeout(r, 5000))
  }

  controller.abort()
  await tailPromise
  console.log('\nAll distinct event types observed during question-event probe:', [...distinctEventTypes])
  console.log('Question-related events captured:', questionEvents.length)
  return {distinctEventTypes, questionEvents, sessionId, questionId}
}

// ---------------------------------------------------------------------------
// Phase 5: message ordering/pagination, session lookup scoping, and
// space-bus v0.13.1 blocked-session dispatch behavior.
//
// Requires OPENCODE_PROBE_DIRECTORY pointing at a project directory with at
// least one existing session (an unauthenticated/no-directory server has no
// meaningful roster to characterize this against). Requires
// OPENCODE_PROBE_SESSION_ID naming a known-existing session in that
// directory to avoid mutating/creating fixtures during the probe.
// ---------------------------------------------------------------------------
async function probeContractCharacterization() {
  section('PHASE 5: message ordering, pagination, session-lookup scoping')

  if (!PROBE_DIRECTORY) {
    console.log(
      'BLOCKED: OPENCODE_PROBE_DIRECTORY not set. Cannot characterize per-directory ' +
        'message/session routes without a known roster project directory.',
    )
    return
  }
  const sessionId = process.env.OPENCODE_PROBE_SESSION_ID
  if (!sessionId) {
    console.log(
      'BLOCKED: OPENCODE_PROBE_SESSION_ID not set. Cannot characterize message ordering/' +
        'pagination or single-session lookup without an existing session id to read ' +
        '(read-only; this probe never creates one to avoid session-list pollution).',
    )
    return
  }

  console.log(`Using directory=${PROBE_DIRECTORY}, sessionID=${sessionId}`)

  // --- limited-message ordering ---
  try {
    const limitedRes = await fetch(withDirectory(`${BASE_URL}/session/${sessionId}/message?limit=3`), {
      headers: authHeaders(),
    })
    console.log(`\nGET /session/${sessionId}/message?limit=3 -> ${limitedRes.status}`)
    if (limitedRes.ok) {
      const limited = (await limitedRes.json()) as {info?: {id?: string; time?: {created?: number}}}[]
      console.log(
        '  Returned message ids (in response order):',
        limited.map(m => m.info?.id),
      )
      const fullRes = await fetch(withDirectory(`${BASE_URL}/session/${sessionId}/message`), {
        headers: authHeaders(),
      })
      if (fullRes.ok) {
        const full = (await fullRes.json()) as {info?: {id?: string}}[]
        console.log(`  Unlimited response count: ${full.length}`)
        const tail = full.slice(-limited.length).map(m => m.info?.id)
        const head = full.slice(0, limited.length).map(m => m.info?.id)
        const limitedIds = limited.map(m => m.info?.id)
        console.log('  limit=N result matches tail (newest-last) of unlimited:', JSON.stringify(limitedIds) === JSON.stringify(tail))
        console.log('  limit=N result matches head (oldest-first) of unlimited:', JSON.stringify(limitedIds) === JSON.stringify(head))
      }
    } else {
      console.log('  BLOCKED:', await limitedRes.text().catch(() => '(unreadable)'))
    }
  } catch (err) {
    console.log('BLOCKED (message ordering):', err instanceof Error ? err.message : String(err))
  }

  // --- pagination fields: `before` is advertised in GET /doc but observed
  // to reject every value (message id, garbage, with/without limit) with a
  // generic 400 {"_tag":"BadRequest"} on this deployed version. Characterize
  // rather than assume; do not build MCP schemas around it until this
  // passes on a verified build. ---
  try {
    const beforeRes = await fetch(
      withDirectory(`${BASE_URL}/session/${sessionId}/message?limit=2&before=msg_doesnotexist00000000000000`),
      {headers: authHeaders()},
    )
    console.log(`\nGET .../message?limit=2&before=<id> -> ${beforeRes.status}`)
    console.log('  Body:', await beforeRes.text().catch(() => '(unreadable)'))
    console.log(
      '  NOTE: `before` is present in the OpenAPI spec for this route but was observed to',
      'return 400 BadRequest for every value tried during characterization (valid message',
      'id, garbage string, with and without `limit`). Treat cursor pagination as',
      'UNSUPPORTED on this deployed version; do not expose `before`/cursor params in the',
      'planned ide_get_transcript MCP schema.',
    )
  } catch (err) {
    console.log('BLOCKED (pagination probe):', err instanceof Error ? err.message : String(err))
  }

  // --- single-session lookup scoping: does GET /session/:id require/scope
  // by ?directory=, or is it a global lookup across all managed directories? ---
  try {
    const noDirRes = await fetch(`${BASE_URL}/session/${sessionId}`, {headers: authHeaders()})
    console.log(`\nGET /session/${sessionId} (no directory param) -> ${noDirRes.status}`)
    const wrongDirRes = await fetch(`${BASE_URL}/session/${sessionId}?directory=%2Ftmp%2Fprobe-nonexistent-dir`, {
      headers: authHeaders(),
    })
    console.log(`GET /session/${sessionId}?directory=/tmp/probe-nonexistent-dir -> ${wrongDirRes.status}`)
    if (noDirRes.ok && wrongDirRes.ok) {
      const a = (await noDirRes.json()) as {directory?: string}
      const b = (await wrongDirRes.json()) as {directory?: string}
      console.log('  Same session returned regardless of directory query value:', a.directory === b.directory)
      console.log(
        '  NOTE: GET /session/:id appears to resolve globally by session id, not scoped by',
        'the `directory` query param — the param may only steer where a POST/mutation',
        'lands. Session ownership for ide_* tools must still be proven against',
        'roster/reconciled state before use, not inferred from this response',
        'alone.',
      )
    }
  } catch (err) {
    console.log('BLOCKED (session lookup scoping):', err instanceof Error ? err.message : String(err))
  }

  // --- question list/reply requestID shape sanity re-check (no live
  // question expected outside probeQuestionEvents(); this only confirms the
  // route accepts directory-scoped listing) ---
  try {
    const qRes = await fetch(withDirectory(`${BASE_URL}/question`), {headers: authHeaders()})
    console.log(`\nGET /question?directory=... -> ${qRes.status}`)
    if (qRes.ok) {
      const questions = (await qRes.json()) as {id?: string; sessionID?: string}[]
      console.log(`  Pending questions currently returned: ${questions.length}`)
    }
  } catch (err) {
    console.log('BLOCKED (question list re-check):', err instanceof Error ? err.message : String(err))
  }

  console.log(
    '\nNOTE: an SSE envelope id (evt_...) cannot be substituted for a question requestID',
    '(que_...) on POST /question/{requestID}/reply — the path param has an explicit',
    '`^que` pattern in GET /doc\'s OpenAPI schema, and the request would 400/404 before',
    'reaching question-matching logic. This is a static schema fact, not something this',
    'probe re-verifies live to avoid crafting a real (rejected) mutation against a live',
    'question.',
  )
}

// ---------------------------------------------------------------------------
// Phase 6: space-bus v0.13.1 blocked-session dispatch characterization.
//
// Pins the CURRENT implicit question-reply branch in `steerSession()`
// (node_modules/@fro.bot/space-bus/dist/core.js): a follow-up `dispatch()`
// call against a session with a pending question silently replies to that
// question with the follow-up prompt text as a single-string answer
// (`{answers: [[message]]}`), returning `{mode: "question-reply"}"` instead
// of sending a new prompt. This is the exact behavior a
// pending-question-safe dispatch option must be able to opt OUT of for
// `ide_dispatch_prompt`, while preserving it as the v0.13.1-compatible
// default for existing callers.
//
// This phase requires a session with an ACTUALLY pending question — set
// OPENCODE_PROBE_BLOCKED_SESSION_ID to exercise it against a live one, or
// rely on Phase 4's probeQuestionEvents() session/questionId if it produced
// one in this same run. Otherwise this phase documents the source-verified
// behavior without a fresh live call (never fabricated: the code excerpt is
// read directly from the installed package below).
// ---------------------------------------------------------------------------
async function probeDispatchBlockedSession() {
  section('PHASE 6: space-bus v0.13.1 dispatch() vs a session with a pending question')

  try {
    // The package's `exports` map exposes `./core` (compiled JS via the
    // `import` condition) but not a raw `./dist/core.js` subpath, so resolve
    // through the public entry point rather than reaching into `dist/`.
    const corePublicPath = Bun.resolveSync('@fro.bot/space-bus/core', process.cwd())
    const coreSrc = await Bun.file(corePublicPath).text()
    const start = coreSrc.indexOf('function steerSession(')
    if (start === -1) {
      console.log('BLOCKED: steerSession() not found in installed @fro.bot/space-bus — package shape changed.')
    } else {
      const end = coreSrc.indexOf('\n}\n', start) + 3
      console.log(`Installed package: ${corePublicPath}`)
      console.log('Verbatim steerSession() from the installed 0.13.1 build:\n')
      console.log(coreSrc.slice(start, end))
      console.log(
        '\nPINNED BEHAVIOR: when a follow-up dispatch() targets a session with a pending',
        'question (GET /question filtered by sessionID), steerSession() replies to that',
        'question with `{answers: [[message]]}` — the follow-up prompt text becomes the',
        'ENTIRE first-option answer string, silently. It returns `{ok: true, mode:',
        '"question-reply"}`, never sending the text as a new prompt. A backward-compatible',
        'opt-out is needed so `ide_dispatch_prompt` can request a typed blocked',
        'result with NO mutation (no reply sent, no prompt sent) instead of this implicit',
        'reinterpretation, while existing v0.13.1 callers keep today\'s default.',
      )
    }
  } catch (err) {
    console.log('BLOCKED (dispatch source characterization):', err instanceof Error ? err.message : String(err))
  }

  const blockedSessionId = process.env.OPENCODE_PROBE_BLOCKED_SESSION_ID
  if (!blockedSessionId || !PROBE_DIRECTORY) {
    console.log(
      '\nLIVE ROUND TRIP SKIPPED: set OPENCODE_PROBE_BLOCKED_SESSION_ID (and',
      'OPENCODE_PROBE_DIRECTORY) to a session that currently has a pending question to',
      'observe a real dispatch()-against-blocked-session call end to end. No such fixture',
      'was available in this probe run — do not treat the source excerpt above as a',
      'substitute for a live round trip; re-run this phase once a',
      'blocked-session fixture is available.',
    )
    return
  }

  try {
    const {dispatch} = (await import('@fro.bot/space-bus/core')) as {
      dispatch: (
        args: {sessionId: string; prompt: string},
        opts: {context: unknown},
      ) => Promise<unknown>
    }
    const context = {
      roster: {
        server: {baseUrl: BASE_URL},
        projects: [{name: 'probe', path: PROBE_DIRECTORY, description: '', expandedPath: PROBE_DIRECTORY, exists: true}],
      },
      credentials: AUTH_PASSWORD ? {username: AUTH_USERNAME, password: AUTH_PASSWORD} : undefined,
    }
    const result = await dispatch(
      {sessionId: blockedSessionId, prompt: 'characterization probe follow-up (should reply to pending question, not steer)'},
      {context},
    )
    console.log('Live dispatch() result against blocked session:', JSON.stringify(result))
  } catch (err) {
    console.log('BLOCKED (live dispatch round trip):', err instanceof Error ? err.message : String(err))
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`Spike 0c probe starting against ${BASE_URL} at ${new Date().toISOString()}`)
  await probeOpenApi()
  await probeCors()
  await probeSse()
  await probeQuestionEvents()
  await probeContractCharacterization()
  await probeDispatchBlockedSession()

  section('RESTART RESILIENCE')
  console.log(
    'SKIPPED: this probe did not start the server itself (connecting to an already-running instance). ' +
      'Marcus explicitly asked not to kill a server we did not start. If a self-started server is available ' +
      'in a future run, extend this phase to kill+restart and observe Last-Event-ID reconnect on a second SSE connection.',
  )

  section('PROBE COMPLETE')
}

await main()
