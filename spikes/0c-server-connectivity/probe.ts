#!/usr/bin/env bun
/**
 * Spike 0c: live server connectivity + SSE contract probe.
 *
 * Run with: bun spikes/0c-server-connectivity/probe.ts
 *
 * Probes the running `opencode serve` instance at 127.0.0.1:4096 (no LLM,
 * no mutation beyond a throwaway probe session) and prints a structured
 * report used to write docs/solutions/2026-07-04-spike-0c-server-connectivity.md.
 */

const BASE_URL = process.env.OPENCODE_BASE_URL ?? 'http://127.0.0.1:4096'
const TAURI_ORIGIN = 'tauri://localhost'
const PHASE_TIMEOUT_MS = 90_000
const SSE_OBSERVE_MS = 25_000

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
    const res = await fetch(`${BASE_URL}/doc`)
    if (!res.ok) {
      console.log(`BLOCKED: /doc returned ${res.status} ${res.statusText}`)
      return
    }
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
      headers: {Origin: TAURI_ORIGIN},
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
  const res = await fetch(url, {signal: opts.signal, headers: {Accept: 'text/event-stream'}})
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
    const createRes = await fetch(`${BASE_URL}/session`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
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
    const promptRes = await fetch(`${BASE_URL}/session/${sessionId}/prompt_async`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
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
      const qRes = await fetch(`${BASE_URL}/question`)
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
      const replyRes = await fetch(`${BASE_URL}/question/${questionId}/reply`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
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
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`Spike 0c probe starting against ${BASE_URL} at ${new Date().toISOString()}`)
  await probeOpenApi()
  await probeCors()
  await probeSse()
  await probeQuestionEvents()

  section('RESTART RESILIENCE')
  console.log(
    'SKIPPED: this probe did not start the server itself (connecting to an already-running instance). ' +
      'Marcus explicitly asked not to kill a server we did not start. If a self-started server is available ' +
      'in a future run, extend this phase to kill+restart and observe Last-Event-ID reconnect on a second SSE connection.',
  )

  section('PROBE COMPLETE')
}

await main()
