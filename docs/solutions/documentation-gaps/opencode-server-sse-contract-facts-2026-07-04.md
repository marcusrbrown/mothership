---
title: opencode server contract facts verified live (SSE, CORS, question events)
date: 2026-07-04
category: documentation-gaps
module: spikes
problem_type: documentation_gap
component: tooling
severity: medium
root_cause: inadequate_documentation
resolution_type: documentation_update
applies_when:
  - "Implementing the SSE demux / live session surfaces (U1.3)"
  - "Implementing any opencode server API client code"
  - "Designing the Phase 2 diff panel (diff-source fallback chain)"
related_components: [opencode-server, sse, cors, space-bus]
tags: [opencode, sse, cors, server-api, question-events, spike-0c]
---

# opencode server contract facts verified live (SSE, CORS, question events)

## Context

The tracer plan's "Verified Server Facts" came from a July 2026 research
snapshot of the opencode repo. Spike 0c probed the live server
(v1.17.13+harness.ee55e157 on `127.0.0.1:4096`, space-bus fixture workspace)
from both Bun and the real Tauri webview origin, resolving the plan's one
unverified contract item and surfacing two deviations. The server API is
still moving — re-verify against `GET /doc` at implementation time rather
than trusting any snapshot, including this one.

## Guidance

**Verified facts to build against:**

- All 10 endpoints the tracer depends on exist as planned (`POST /session`,
  `prompt_async`, `message`, `session/status`, `todo`, `diff`, `question`,
  `question/{requestID}/reply`, `vcs`, `event`). 162 paths total in `/doc`.
- **CORS is free for the Tauri webview** — `tauri://localhost` is echoed back
  in `Access-Control-Allow-Origin` (allowlist echo, not `*`). From the real
  webview a baseline GET succeeded with *no* ACAO header present — do not
  rely on ACAO-echo behavior as a signal; if a future build enforces CORS
  strictly, `opencode serve --cors <origin>` remains the fallback.
- **SSE lifecycle**: first event `server.connected`, heartbeat
  `server.heartbeat` every 10.0s, JSON payload `{id, type, properties}`.
- **Question events ARE on `/event`** (resolves the plan's UNVERIFIED item):
  `question.asked` and `question.replied` observed with full shapes (below);
  `question.rejected` assumed present but unverified.
- **Reply keys off the question's `properties.id`** (server path param
  `requestID`, `que_...`), **not** the SSE envelope `id` (`evt_...`) — an
  easy foot-gun.
- Event types observed in one probe window: `server.connected`,
  `session.created`, `session.updated`, `message.updated`,
  `message.part.updated`, `message.part.delta`, `session.status`,
  `tui.toast.show`, `session.diff`, `plugin.added`, `catalog.updated`,
  `reference.updated`, `integration.updated`, `question.asked`,
  `question.replied`, `server.heartbeat`, `session.idle` — treat the union
  as open; switch on known strings, log unknowns.

**Deviations from the research snapshot:**

- **The SSE protocol-level `id:` field is ABSENT on the wire** (0/3 events).
  Payloads carry an internal `id`, but that is not the `Last-Event-ID`
  contract — literal resume is unconfirmed. U1.3 must reconcile full state
  (`GET /session/status` + `GET /question` + refetch open transcripts) on
  every (re)connect; never trust deltas across a gap.
- **`GET /vcs/status` exists** (plan said it didn't), alongside `/vcs`,
  `/vcs/diff`, `/vcs/diff/raw`, `/vcs/apply`, `/file/status` — Phase 2 diff
  panel should re-check `/doc` before choosing its working-tree fallback hop.

## Why This Matters

U1.3's needs-attention flow (AE2) can react to `question.asked` directly for
the common case — reconciliation on reconnect remains the safety net, not the
primary mechanism. The `id:` absence means the reconnect gap is real: without
reconciliation, a question raised during a gap would be silently missed.

## When to Apply

- Writing or reviewing `src/server/` (client wrapper, SSE demux).
- Any reconnect/resume logic — assume no server-side replay.
- Phase 2 diff-source fallback chain.

## Examples

`question.asked` (verbatim):

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

Reply: `POST /question/que_f2ca755e20012SELXYb5mGclIc/reply` with
`{"answers":[["Yes"]]}` → `200` body `true`, followed on `/event` by:

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

Webview-origin verification (real `tauri://localhost`): baseline fetch OK,
native EventSource connect + reconnect (fresh `server.connected` +
heartbeats each press), full create-session → question prompt → list →
reply-Yes round-trip — all working. Gate **CLEARED**.

Unverified/skipped: restart resilience (server was pre-running and not ours
to kill — re-run with a disposable instance, higher priority given the `id:`
finding); whether `?directory=` filters `/event` output (no A/B collected).

## Related

- Probes: `spikes/0c-server-connectivity/` (`probe.ts` Bun runner,
  `index.tsx` webview page)
- Plan: `docs/plans/2026-07-04-001-feat-mothership-tracer-bullet-plan.md`
  (U0.4, U1.3, Verified Server Facts)
- space-bus reference client: `~/src/github.com/fro-bot/space-bus`
