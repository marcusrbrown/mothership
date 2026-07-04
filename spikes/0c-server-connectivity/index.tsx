/**
 * Spike 0c webview-side probe page.
 *
 * Verifies, from the ACTUAL webview origin (not a Bun script), the claims
 * that `spikes/0c-server-connectivity/probe.ts` already checked from Node/Bun:
 *   - CORS: does a browser `fetch` against 127.0.0.1:4096 actually succeed
 *     from this origin, or does the browser block it client-side?
 *   - SSE: does native `EventSource` (unlike Bun's stream-based parser) behave
 *     the same way against `/event`?
 *
 * NOT WIRED INTO THE APP SHELL: this dispatch owns `spikes/` and
 * `docs/solutions/` only — `src/main.tsx` / `src/App.tsx` are out of scope.
 * To run this manually, temporarily mount it, e.g. in `src/main.tsx`:
 *
 *   import Spike0c from '../spikes/0c-server-connectivity'
 *   const params = new URLSearchParams(window.location.search)
 *   const root = createRoot(document.getElementById('root')!)
 *   root.render(params.get('spike') === '0c' ? <Spike0c /> : <App />)
 *
 * then visit the dev server with `?spike=0c`. Revert the wiring afterward.
 */

import {useEffect, useRef, useState} from 'react'

const BASE_URL = 'http://127.0.0.1:4096'
// Space-bus fixture workspace used by the Bun probe; adjust if it differs locally.
const FIXTURE_DIRECTORY = '/Users/mrbrown/src/github.com/fro-bot/space-bus'

interface EventLogEntry {
  at: string
  type: string
  raw: string
}

interface CorsResult {
  ok: boolean
  status?: number
  allowOrigin?: string | null
  error?: string
}

export default function Spike0cServerConnectivity() {
  const [corsResult, setCorsResult] = useState<CorsResult | null>(null)
  const [events, setEvents] = useState<EventLogEntry[]>([])
  const [reconnectCount, setReconnectCount] = useState(0)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [questionId, setQuestionId] = useState<string | null>(null)
  const [statusLine, setStatusLine] = useState('idle')
  const esRef = useRef<EventSource | null>(null)

  function pushEvent(type: string, raw: string) {
    setEvents(prev => [...prev.slice(-19), {at: new Date().toISOString(), type, raw}])
  }

  function connectSse() {
    esRef.current?.close()
    const url = `${BASE_URL}/event?directory=${encodeURIComponent(FIXTURE_DIRECTORY)}`
    const es = new EventSource(url)
    es.onopen = () => setStatusLine(`SSE open: ${url}`)
    es.onmessage = evt => {
      try {
        const parsed = JSON.parse(evt.data) as {type?: string}
        pushEvent(parsed.type ?? '(unparseable)', evt.data)
      } catch {
        pushEvent('(unparseable)', evt.data)
      }
    }
    es.onerror = () => {
      setStatusLine('SSE error/reconnecting')
      setReconnectCount(c => c + 1)
    }
    esRef.current = es
  }

  useEffect(() => {
    // CORS + baseline connectivity check via plain fetch from this origin.
    fetch(`${BASE_URL}/session/status`, {method: 'GET'})
      .then(res => {
        setCorsResult({ok: res.ok, status: res.status, allowOrigin: res.headers.get('access-control-allow-origin')})
      })
      .catch(err => {
        setCorsResult({ok: false, error: err instanceof Error ? err.message : String(err)})
      })

    connectSse()
    return () => esRef.current?.close()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function createProbeSession() {
    setStatusLine('creating session...')
    const res = await fetch(`${BASE_URL}/session`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({title: 'spike-0c-webview-probe'}),
    })
    const body = (await res.json()) as {id?: string; sessionID?: string}
    const id = body.id ?? body.sessionID ?? null
    setSessionId(id)
    setStatusLine(id ? `session created: ${id}` : `session create failed: ${JSON.stringify(body)}`)
  }

  async function sendQuestionPrompt() {
    if (!sessionId) {
      setStatusLine('no session — create one first')
      return
    }
    setStatusLine('sending prompt_async...')
    const res = await fetch(`${BASE_URL}/session/${sessionId}/prompt_async`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        parts: [
          {type: 'text', text: 'Call your question/ask-user tool to ask me one yes/no question and wait for my answer. Do nothing else.'},
        ],
      }),
    })
    setStatusLine(`prompt_async -> ${res.status}`)
  }

  async function listQuestions() {
    setStatusLine('listing questions...')
    const res = await fetch(`${BASE_URL}/question`)
    const body = (await res.json()) as {id?: string}[]
    const first = body[0]?.id ?? null
    setQuestionId(first)
    setStatusLine(first ? `question found: ${first}` : `no pending questions (${JSON.stringify(body)})`)
  }

  async function replyYes() {
    if (!questionId) {
      setStatusLine('no question id — list questions first')
      return
    }
    setStatusLine('replying Yes...')
    const res = await fetch(`${BASE_URL}/question/${questionId}/reply`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({answers: [['Yes']]}),
    })
    setStatusLine(`reply -> ${res.status}`)
  }

  return (
    <main
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '1rem',
        padding: '1rem',
        height: '100vh',
        background: 'var(--color-bg)',
        color: 'var(--color-text)',
        fontFamily: 'ui-monospace, monospace',
        boxSizing: 'border-box',
      }}
    >
      <h1 style={{color: 'var(--color-text-secondary)', margin: 0}}>Spike 0c — server connectivity (webview origin)</h1>

      <section>
        <h2 style={{color: 'var(--color-accent)'}}>CORS / baseline fetch</h2>
        {corsResult == null ? (
          <p>probing...</p>
        ) : corsResult.ok ? (
          <p style={{color: 'var(--color-success)'}}>
            OK — status {corsResult.status}, Access-Control-Allow-Origin: {corsResult.allowOrigin ?? '(none)'}
          </p>
        ) : (
          <p style={{color: 'var(--color-error)'}}>
            FAIL — {corsResult.error ?? `status ${corsResult.status}`}
          </p>
        )}
      </section>

      <section>
        <h2 style={{color: 'var(--color-accent)'}}>SSE (native EventSource)</h2>
        <p>
          status: {statusLine} · reconnects: {reconnectCount}
        </p>
        <div
          style={{
            border: '1px solid var(--color-border)',
            padding: '0.5rem',
            maxHeight: '240px',
            overflowY: 'auto',
            background: 'var(--color-surface)',
          }}
        >
          {events.length === 0 && <p style={{color: 'var(--color-text-muted)'}}>no events yet</p>}
          {events.map((e, i) => (
            <div key={i} style={{fontSize: '0.85em'}}>
              <span style={{color: 'var(--color-text-dim)'}}>{e.at}</span>{' '}
              <span style={{color: 'var(--color-text-secondary)'}}>{e.type}</span>
            </div>
          ))}
        </div>
      </section>

      <section style={{display: 'flex', gap: '0.5rem', flexWrap: 'wrap'}}>
        <button type="button" onClick={connectSse}>
          Reconnect SSE
        </button>
        <button type="button" onClick={createProbeSession}>
          Create probe session
        </button>
        <button type="button" onClick={sendQuestionPrompt}>
          Send question prompt
        </button>
        <button type="button" onClick={listQuestions}>
          List questions
        </button>
        <button type="button" onClick={replyYes}>
          Reply Yes
        </button>
      </section>

      <p style={{color: 'var(--color-text-muted)', fontSize: '0.85em'}}>
        session: {sessionId ?? '(none)'} · question: {questionId ?? '(none)'}
      </p>
    </main>
  )
}
