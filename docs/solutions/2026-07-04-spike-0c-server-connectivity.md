---
module: spikes
tags: [opencode, sse, cors, server-api]
problem_type: contract-verification
---

# Spike 0c: server connectivity + SSE contract probe

De-risks R7, R8, R9 for the tracer-bullet plan (U0.4). Live-verifies the server
contract documented in "Verified Server Facts" against a real, already-running
`opencode serve` at `127.0.0.1:4096` (version `1.17.13+harness.ee55e157`,
serving the space-bus fixture workspace `~/src/github.com/fro-bot/space-bus`).

**Server state for this run: found already running (not started by this spike,
never killed).** Restart-resilience phase was therefore skipped by design —
see "Deviations" below.

Run with: `bun spikes/0c-server-connectivity/probe.ts`

## Endpoint inventory vs plan

`GET /doc` returned an OpenAPI 3.1 spec with 162 paths. Every endpoint the plan
depends on exists, with the session/question ID path params named more
specifically than the plan's shorthand:

| Plan shorthand | Actual path | Verdict |
|---|---|---|
| `POST /session` | `POST /session` | OK |
| `POST /session/:id/prompt_async` | `POST /session/{sessionID}/prompt_async` | OK |
| `GET /session/:id/message` | `GET /session/{sessionID}/message` | OK |
| `GET /session/status` | `GET /session/status` | OK |
| `GET /session/:id/todo` | `GET /session/{sessionID}/todo` | OK |
| `GET /session/:id/diff` | `GET /session/{sessionID}/diff` | OK |
| `GET /question` | `GET /question` | OK |
| `POST /question/:id/reply` | `POST /question/{requestID}/reply` | OK |
| `GET /vcs` | `GET /vcs` | OK |
| `GET /event` | `GET /event` | OK |

No missing or renamed endpoints. **Deviation from "Verified Server Facts":**
the plan's note that `GET /vcs/status` does not exist is itself now stale —
the live spec includes `/vcs/status`, `/vcs/diff`, `/vcs/diff/raw`, and
`/vcs/apply` in addition to `/vcs` and `/file/status`. Treat this as evidence
the server API is still moving; don't assume `/vcs/status`'s absence without
re-checking `/doc` at implementation time.

## CORS

Confirmed **free, no proxy needed**, matching the plan:

```
OPTIONS /session/status  (Origin: tauri://localhost)
  -> 204
  Access-Control-Allow-Origin: tauri://localhost
  Access-Control-Allow-Methods: GET, HEAD, PUT, PATCH, POST, DELETE
  Access-Control-Allow-Headers: (none returned)

GET /session/status  (Origin: tauri://localhost)
  -> 200
  Access-Control-Allow-Origin: tauri://localhost
  Access-Control-Allow-Credentials: (none returned)
```

The origin is echoed back exactly (not `*`), confirming the described
allowlist behavior rather than a wildcard. `Access-Control-Allow-Headers`
being empty on the OPTIONS response is worth re-checking if a future request
needs a custom header beyond `Content-Type` (e.g. `x-opencode-directory` on
non-GET/HEAD methods) — this probe only exercised default headers.

## SSE lifecycle (`GET /event`, 25s window, no directory filter)

```
[+0.4s]  id=(none) type=server.connected
[+10.4s] id=(none) type=server.heartbeat
[+20.4s] id=(none) type=server.heartbeat
```

- First event: `server.connected`, matches plan.
- Heartbeat cadence: 10.01s between heartbeats — matches plan's "every 10s".
- **Deviation from plan: `id:` field was NOT present on any event in this
  run** (`id: field present on events: 0 / 3`). The plan states "`id:` set so
  `Last-Event-ID` resume works." Every event body does carry an internal
  `id` field inside its JSON payload (e.g. `"id":"evt_f2ca6d87c001EsNA01x7Ad1NXU"`)
  but the SSE-protocol `id:` line itself was absent from the wire format in
  this run. **This means `Last-Event-ID`-based resume, as literally described,
  is not currently available from the transport layer** — if reconnect needs
  a resume point, the payload's own `id` field would need to be tracked
  client-side and correlated manually (there is no server-side "give me
  everything since id X" endpoint verified here). This is a real risk to
  U1.3's reconciliation design and should be flagged, not silently
  reinterpreted as "works as documented."
- Directory query param (`?directory=`) was not exercised in the 25s baseline
  window (default probe ran without it to match a clean first look); it *was*
  exercised implicitly during the question-event probe's session creation
  (server correctly bound the new session to the same directory as the
  already-running instance's workspace root). No direct A/B evidence was
  collected on whether `?directory=` actually *filters* what's delivered on
  `/event`; treat as PENDING (see below).

Raw JSON body of the first event, verbatim:

```json
{"id":"evt_f2ca6d87c001EsNA01x7Ad1NXU","type":"server.connected","properties":{}}
```

## Question-event probe (the unverified contract item)

**RESOLVED: question events ARE present on `/event`, with types
`question.asked` and `question.replied`.** This confirms the union should be
treated as open (per the plan's stance) but the specific unverified claim —
"Question.Asked/Replied/Rejected publish to the bus but weren't in the
SDK-generated event union" — is now falsified for `question.asked` /
`question.replied` (both appeared on the wire in this run; `question.rejected`
was not exercised).

Full sequence observed:

1. `POST /session {"title":"spike-0c-question-probe"}` → 201-equivalent JSON body:
   ```json
   {"id":"ses_0d358c5f7ffesGixsdNsji7Fun","slug":"mighty-mountain","projectID":"6c26b88374f9a1b7f2b95a0d3335e9b0b548593a","directory":"/Users/mrbrown/src/github.com/fro-bot/space-bus","path":"","cost":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}},"title":"spike-0c-question-probe","version":"1.17.13+harness.ee55e157","time":{"created":1783160584714,"updated":1783160584714}}
   ```
2. `POST /session/{id}/prompt_async` with a single text part asking the agent
   to call its question/ask-user tool → **204**, matching plan.
3. `question.asked` appeared on `/event` (well within the 90s phase timeout —
   no TIMEOUT needed this run):
   ```json
   {
     "id": "evt_f2ca755e40015lIj0h33SHzCr1",
     "type": "question.asked",
     "properties": {
       "id": "que_f2ca755e20012SELXYb5mGclIc",
       "sessionID": "ses_0d358c5f7ffesGixsdNsji7Fun",
       "questions": [
         {
           "question": "Should I proceed?",
           "header": "Proceed?",
           "options": [
             {"label": "Yes", "description": "Proceed"},
             {"label": "No", "description": "Do not proceed"}
           ]
         }
       ],
       "tool": {
         "messageID": "msg_f2ca73bf90011INau2Pz4UHiK4",
         "callID": "toolu_01XZ5DBoV4fG7jeN5DBJWnmM"
       }
     }
   }
   ```
4. `GET /question` independently confirmed the same payload shape (the
   question's own `id` is `properties.id` from the event, i.e.
   `que_f2ca755e20012SELXYb5mGclIc` — NOT the outer `evt_...` event id). This
   distinction matters: **the reply endpoint takes the question's `properties.id`
   (server calls this `requestID` in its path template), not the SSE
   envelope's `id`.**
5. `POST /question/{requestID}/reply {"answers":[["Yes"]]}` → **200**, body `true`.
6. `question.replied` followed on `/event`:
   ```json
   {
     "id": "evt_f2ca75b6f001UB7t7B3ti37VmL",
     "type": "question.replied",
     "properties": {
       "sessionID": "ses_0d358c5f7ffesGixsdNsji7Fun",
       "requestID": "que_f2ca755e20012SELXYb5mGclIc",
       "answers": [["Yes"]]
     }
   }
   ```

All distinct event `type` strings observed during the full question-event
probe window (session create through reply + 5s settle):

```
server.connected, session.created, session.updated, message.updated,
message.part.updated, session.status, tui.toast.show, session.diff,
plugin.added, catalog.updated, reference.updated, integration.updated,
message.part.delta, question.asked, question.replied, server.heartbeat,
session.idle
```

**Implication for U1.3 reconciliation design**: since question events do
appear on `/event`, the tracer does NOT need to fall back to
reconciliation-only polling of `GET /question` for the common case — it can
react to `question.asked` directly and still reconcile via `GET /question` on
reconnect as a safety net (per the plan's existing "never trust deltas across
a gap" posture). `question.rejected` was not observed in this run and should
be assumed present-but-unverified; do not special-case its absence.

## Restart resilience

**SKIPPED.** This probe connected to an opencode server that was already
running before the spike started; per instructions it was never killed. No
reconnect / `Last-Event-ID` resume behavior was exercised in this run. Given
the `id:` protocol-field absence noted above, this phase is now higher
priority to re-run with a self-started, disposable server instance — the
resume story may be weaker than the plan assumed.

## Webview-origin verification

Environment: macOS WKWebView, Tauri v2.x window (1440x900), opencode server
v1.17.13+harness.ee55e157 on `127.0.0.1:4096`, real `tauri://localhost` origin.

- **Baseline `fetch` from the webview**: `OK — status 200,
  Access-Control-Allow-Origin: (none)` — the request succeeded even though no
  ACAO header was present in the response. Nuance worth flagging: either the
  WKWebView custom-scheme page doesn't send/enforce `Origin` on this GET, or
  Tauri's scheme handler bypasses CORS entirely for it — either way, direct
  webview→server `fetch` works, which is the actual exit criterion. Do not
  rely on ACAO-echo behavior as a signal; if a future opencode build starts
  enforcing CORS strictly, the `--cors` flag remains the fallback.
- **SSE reconnect**: works — a fresh `server.connected` followed by
  `server.heartbeat` appeared in the event tail after every "Reconnect"
  press.
- **Question round-trip from the webview**: create session → question
  prompt → list questions → reply "Yes" all succeeded at every step, matching
  the sequence observed in the Bun probe.

**Verdict**: gate **CLEARED** — live event tail and steering verified from
the actual webview origin, not just from Bun's `fetch`.

The Bun script above verifies the contract from Node/Bun's `fetch` +
hand-rolled SSE parser. It does **not** exercise:

- Whether a real Tauri webview (`tauri://localhost` origin, actual browser
  CORS enforcement, not just header inspection) can complete these requests —
  browsers enforce CORS client-side in ways Bun's `fetch` does not.
- Native `EventSource` behavior against `/event` (Bun has no `EventSource`;
  the Bun probe reimplements SSE parsing over `ReadableStream`, which is not
  guaranteed to match browser reconnect/backoff semantics).
- Whether `?directory=` actually filters `/event` output (not exercised as an
  A/B in either probe run).

`spikes/0c-server-connectivity/index.tsx` implements this webview-side check
(baseline `fetch` CORS check + native `EventSource` + manual
create-session/send-question/list-questions/reply-yes buttons + live event
tail). It is intentionally **not wired into `src/main.tsx` / `src/App.tsx`**
(out of scope for this dispatch — owns `spikes/` and `docs/solutions/` only).

### Manual run instructions

1. Temporarily add to `src/main.tsx` (revert after testing):
   ```tsx
   import Spike0c from '../spikes/0c-server-connectivity'
   const params = new URLSearchParams(window.location.search)
   // render Spike0c when params.get('spike') === '0c', else the normal App
   ```
2. `bun --bun run tauri dev`, navigate to the app with `?spike=0c` in the URL
   (or open the dev server URL directly with the query param if testing in a
   plain browser window first, before validating in the actual Tauri
   webview).
3. Record: CORS OK/FAIL banner, whether `EventSource` connects and shows
   `server.connected` at the top of the event tail, reconnect counter after
   toggling network/killing the server, and whether the manual
   create-session → send-question-prompt → list-questions → reply-yes flow
   reproduces the same `question.asked` / `question.replied` sequence seen in
   the Bun probe.
4. Revert the temporary `src/main.tsx` wiring before committing anything
   beyond this spike's own files.

## Deviations from plan summary

- `id:` SSE protocol field is absent on the wire (payload has its own `id`
  field, but that's not the same contract as `Last-Event-ID` resume). Flag for
  U1.3.
- `/vcs/status` exists in the live spec despite the plan's "Verified Server
  Facts" claiming it doesn't — the server API is evidently still moving;
  re-verify against `/doc` at implementation time rather than trusting this
  doc or the plan verbatim.
- Question events (`question.asked`, `question.replied`) DO appear on
  `/event` — the plan's "UNVERIFIED" flag is now resolved for these two types.
  `question.rejected` remains unverified.
- Restart resilience unverified this run (server not self-started, correctly
  left running).
