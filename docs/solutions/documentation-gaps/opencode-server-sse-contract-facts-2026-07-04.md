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

## Update 2026-07-18: message limit/pagination, session lookup scoping, blocked-session dispatch (Unit 1)

Re-verified live against two running managed-server instances
(`v1.17.13+harness.ee55e157` and `v1.17.18+harness.4ec05a47`, both
password-protected — see auth note below) as part of
`docs/plans/2026-07-17-001-feat-agent-native-session-tools-plan.md` Unit 1.
`GET /doc` still reports 162 total paths and all endpoints this doc already
lists as verified. New facts:

- **Auth is not always absent.** Both instances probed here required HTTP
  Basic auth (`opencode:<password>` from the managed-server's
  `~/.local/state/space-bus/<id>/discovery.json`); `GET /doc` returns `401`
  without it. This doc's 2026-07-04 note assumed an "unauthenticated
  loopback server" as the tracer's baseline — that remains true for a
  from-scratch dev `opencode serve`, but is not a universal fact about every
  deployed instance. `spikes/0c-server-connectivity/probe.ts` now accepts
  `OPENCODE_SERVER_PASSWORD`/`OPENCODE_SERVER_USERNAME` and sends Basic auth
  when set.
- **`limit=N` on `GET /session/:id/message` returns the newest N messages,
  in ascending (oldest-first) chronological order.** Verified against a
  100-message live session: `limit=3` returned exactly the same three
  messages as the tail (last three) of the unlimited response, in the same
  relative order — not the head. `src/server/client.ts`'s `listMessages`
  already only exposes `{limit?: number}`, matching this; no code changes
  were needed, only fixture confirmation (`src/server/client.test.ts`).
- **`before` is UNVERIFIED and currently non-functional on this deployed
  version, despite being documented in `GET /doc`.** The route's OpenAPI
  spec lists a `before` query param (arbitrary string), but every value
  tried — a real message id, a garbage string, with and without `limit` —
  returned `400 {"_tag":"BadRequest"}`. Treat cursor pagination as
  unsupported; do not add `before`/cursor fields to `ide_get_transcript`'s
  MCP input schema. Re-verify against `GET /doc` again before ever
  exercising this on a newer build — the spec entry suggests it is intended
  to work, just not on this build.
- **`GET /session/:id` resolves globally by session id, not scoped by the
  `?directory=` query param.** The same session was returned for no
  `directory` param, the session's real directory, and a nonexistent
  `/tmp/...` directory — all `200`, identical body. The `directory` query
  param appears to only steer where *mutating* requests (`POST
  .../prompt_async`, session creation) land, not where lookups search.
  Session ownership for `ide_*` tools must still be proven against
  roster/reconciled state before use (KTD3/R7) — this endpoint alone cannot
  be trusted to reject a session that does not belong to the caller's
  claimed project.
- **space-bus v0.13.1's blocked-session dispatch behavior, pinned from
  source** (`node_modules/@fro.bot/space-bus/dist/core.js`,
  `steerSession()`): a follow-up `dispatch()` call first does `GET
  /question` for the target directory, finds any pending question whose
  `sessionID` matches, and if found, `POST`s
  `/question/{that question's id}/reply` with `{answers: [[<the follow-up
  prompt text>]]}` — the entire prompt string becomes the first answer
  option, verbatim, with no confirmation. It returns `{ok: true, mode:
  "question-reply"}` and never sends the text as a new prompt. If no
  pending question is found, it falls through to a normal
  `prompt_async` follow-up (`mode: "follow-up"}`). This is the exact
  default behavior Unit 8's pending-question-safe dispatch option must
  preserve for existing callers while adding an opt-out that instead
  returns a typed blocked result with **no** mutation (no reply, no
  prompt) for `ide_dispatch_prompt`.
  - **Live round trip not completed in this pass.** No fixture session with
    an actually-pending question and a disposable target was available
    within Unit 1's scope (creating one requires a real LLM turn asking a
    real question in a throwaway session, which this pass did not spend);
    the source excerpt above is read directly from the installed package,
    not fabricated, but it has not been exercised end-to-end through
    `dispatch()` itself. `spikes/0c-server-connectivity/probe.ts` Phase 6
    supports this via `OPENCODE_PROBE_BLOCKED_SESSION_ID` +
    `OPENCODE_PROBE_DIRECTORY` and will attempt the live call when set;
    re-run it once such a fixture exists, before Unit 8 ships.
- **Question `requestID` vs SSE envelope id remains the same footgun as
  2026-07-04**, now confirmed by `GET /doc`'s schema: `POST
  /question/{requestID}/reply`'s path param has an explicit `^que` regex
  pattern in its OpenAPI schema. An `evt_...` envelope id substituted here
  is a static, schema-provable mismatch, not just an observed convention.

## Related

- Probes: `spikes/0c-server-connectivity/` (`probe.ts` Bun runner,
  `index.tsx` webview page). `probe.ts` Phase 5/6 (added 2026-07-18)
  characterize message ordering/pagination, session lookup scoping, and
  pin the v0.13.1 blocked-session dispatch source.
- Plan: `docs/plans/2026-07-04-001-feat-mothership-tracer-bullet-plan.md`
  (U0.4, U1.3, Verified Server Facts)
- Plan: `docs/plans/2026-07-17-001-feat-agent-native-session-tools-plan.md`
  (Unit 1)
- Fixtures: `src/server/client.test.ts` ("Unit 1 characterization
  fixtures")
- space-bus reference client: `~/src/github.com/fro-bot/space-bus`
