---
title: "fix: Reliability track for the daily-driver bar"
type: fix
status: active
date: 2026-07-05
---

# fix: Reliability track for the daily-driver bar

## Overview

Close the release-blocking reliability gaps that stand between the merged tracer and the daily-driver bar: live transcript streaming without manual re-clicks, session identity that never drifts, a session store that survives transient failures, race-free process supervision, tolerant workspace-config parsing, and a sessions list without subagent noise. Ends with a live window run verifying the fixed paths against the real workspace.

## Problem Frame

The v0.1 release bar is "Marcus runs his real workspace through Mothership daily, sustained, without babysitting" (see `docs/brainstorms/2026-07-05-product-identity-release-preparedness-requirements.md` — this track gates its R16 checklist). Live window sessions and the branch review surfaced specific reliability defects that break that bar today: assistant replies that don't stream until a re-click, dispatches that target stale sessions, a store that a single failed REST call wipes clean, supervisor races that can orphan or double-spawn `opencode serve`, a workspace schema that breaks on any future upstream field, and a sessions list drowned in subagent noise (OpenCode hides subagent sessions in its own UIs; Mothership currently shows them all).

## Requirements Trace

- R1. After a dispatch, assistant deltas live-append into the shown transcript without any manual re-click (note #209).
- R2. The sessions-list highlight always matches the transcript's shown session; dispatch continues the selected or most-recent live session and never targets a deleted one (note #210, verified live).
- R3. A transient `listSessions` failure never wipes the session store for a directory (ce:review P1).
- R4. Rapid session switches never render a stale transcript over a newer one (backfill ordering race).
- R5. `ensure_server` cannot double-spawn under concurrency, and app shutdown cannot race the monitor into spawning an extra child (supervisor races).
- R6. An unknown top-level field in `spacebus.json` does not break workspace load (schema tolerance).
- R7. Status-only SSE events never create directory-less zombie sessions in the store.
- R8. Subagent sessions are excluded from the sessions panel by default, with an "Include subagents" toggle (default off) (note #205).
- R9. The fixed paths are verified in a live window against the real workspace with evidence captured.

## Scope Boundaries

- The *sustained* daily-driver demonstration (days of real use) is owned by the epic's release checklist, not this plan — this plan delivers the fixes plus one verified live window.
- Connect-path robustness beyond Unit 4 is already landed or upstream: the dead-daemon actionable error and discovery resolution shipped with the space-bus `/attach` decouple; the daemon's own lifetime (overnight death) is a space-bus supervisor gap tracked upstream — Unit 6 verifies the recovery UX only.
- No layout/DockviewShell refactor (god-component and `liveParamsForPanel` coupling stay as-is; tracked maintainability follow-up).

### Deferred to Separate Tasks

- Sidecar hardening trio (WS-replace stranding, restart-cap bypass, orphaned-sidecar-on-crash): note #203 — outside the single-operator threat model, revisit if the sidecar becomes a multi-client boundary.
- Adversarial out-of-model P0s (WS hijack, :4096 pre-bind adoption, `sidecar_dir` RCE): deferred hardening per review artifact.

## Context & Research

### Relevant Code and Patterns

- `src/layout/DockviewShell.tsx` — `reconcileProject` (store-wipe site), active-session clearing subscription, `connectActiveDirectorySse`, `handleDispatched` re-backfill wiring.
- `src/server/session-store.ts` — `reconcile` (prunes correctly), `applyEvent` `session.status`/`session.idle` arms (zombie-creation site), `removeSession`.
- `src/panels/transcript/TranscriptPanel.tsx` — async `backfill` (no generation guard), demux subscription lifecycle.
- `src/panels/sessions/sessions-view.ts` + `SessionsPanel.tsx` — DOM-free derivation + panel; newest-first sort landed in `235d072`.
- `src-tauri/src/server_supervisor.rs` — `ensure_server` (mutex released between probe and spawn), `spawn_monitor` (shutdown race); pure helpers live in `supervisor_common.rs`.
- `src/workspace/config.ts` — `manifestSchema` `.strict()`.
- Prompt-bar dispatch validation and stale-active-session clearing landed in `7b9b704`; reconnect re-backfill landed in `235d072` — R1/R2 build on and verify these.

### Institutional Learnings

- `docs/solutions/documentation-gaps/opencode-server-sse-contract-facts-2026-07-04.md` — no wire-level SSE `id:`; reconcile-on-reconnect is the safety net. Message parts have no reconcile net; R1's fix extends the same philosophy to the transcript.

## Key Technical Decisions

- Fix at the resolution/guard layer, not by restructuring the live-data model — the hybrid poll + single-SSE architecture is settled; these are correctness holes in it.
- Generation counters over locks for async UI races (backfill) — matches the existing submitRef/ref-reading patterns in the codebase.
- Subagent detection uses `parentID` as the primary signal, with the title suffix pattern `(@<name> subagent)` as a fallback for payloads without it (single seam in sessions-view).
- Supervisor fix re-validates state after reacquiring the lock (kill the losing child) rather than holding the lock across a blocking spawn or adding a second synchronization primitive — minimal lock hold beats serialized spawns.

## Open Questions

### Deferred to Implementation

- Whether R1 needs a message-level reconcile on SSE (re)connect beyond the existing dispatch-time re-backfill — decided by what the live window shows after the generation guard lands.
- Exact toggle placement/styling in the sessions panel (tokens-only; follow existing panel header patterns).

## Implementation Units

- [x] **Unit 1: Store integrity — wipe guard and zombie guard**

**Goal:** A directory's sessions survive transient REST failures, and status-only events can't fabricate sessions.

**Requirements:** R3, R7

**Dependencies:** None

**Files:**
- Modify: `src/layout/DockviewShell.tsx` (reconcileProject), `src/server/session-store.ts` (status/idle arms)
- Test: `src/layout/DockviewShell.test.ts`, `src/server/session-store.test.ts`

**Approach:** `reconcileProject` skips `store.reconcile` entirely when `listSessions` fails (no empty-array authoritative replace). `session.status`/`session.idle` handlers no-op for unknown session ids instead of upserting directory-less entries.

**Execution note:** Test-first — both are pure state-machine behaviors.

**Test scenarios:**
- Error path: listSessions rejects → store keeps prior sessions for that directory; a later success reconciles normally.
- Error path: status event for unknown session id → store unchanged; same event after the session exists → status applied.
- Edge case: question/idle events for a just-deleted session → no resurrection.

**Verification:** Both regression tests fail on current code, pass after; full suite green.

- [x] **Unit 2: Transcript ordering — generation guard + live-append proof**

**Goal:** The transcript never shows stale data after fast session switches, and dispatch → deltas stream without re-click.

**Requirements:** R1, R4

**Dependencies:** Unit 1 (store behavior stable)

**Files:**
- Modify: `src/panels/transcript/TranscriptPanel.tsx`
- Test: `src/panels/transcript/transcript-view.test.ts` (extract any new pure logic there)

**Approach:** Generation ref incremented per backfill; after each await, stale generations discard their result. Subscribe-before-unsubscribe on session switch to close the missed-event window. Keep the reconnect re-backfill. If live verification (Unit 6) still shows missed first deltas, capture the raw SSE stream during a dispatch (probe pattern from `spikes/0c-server-connectivity/`) to distinguish server-side delta loss during stream-switch from client-side ordering — diagnose before adding further client fixes; a one-shot delayed re-backfill after `setActiveDirectory` is the fallback only if the trace shows a client-side gap.

**Execution note:** Test-first for the generation logic (extract as pure helper if needed to make it testable).

**Test scenarios:**
- Happy path: dispatch → message.part deltas append in order.
- Edge case: switch A→B with A's backfill resolving last → B's transcript shown, A's result discarded.
- Integration: SSE reconnect re-fires backfill for the shown session only.

**Verification:** Race test fails on current code, passes after; live-append confirmed in Unit 6.

- [x] **Unit 3: Subagent session filtering**

**Goal:** Sessions panel shows top-level sessions only by default; subagents behind a toggle.

**Requirements:** R8

**Dependencies:** None (parallel-safe with Units 1–2)

**Files:**
- Modify: `src/panels/sessions/sessions-view.ts`, `src/panels/sessions/SessionsPanel.tsx`
- Test: `src/panels/sessions/sessions-view.test.ts`

**Approach:** Pure predicate `isSubagentSession(title)` matching the `(@<name> subagent)` suffix (pattern observed in live windows; no structured field exists yet — re-verify against real workspace data in Unit 6). The sessions-view derivation (`toSessionRows`/`toSessionsViewState`) gains an `includeSubagents` flag (default false) — which layer carries it is the implementer's call. Toggle is panel-local React state, default off, NOT persisted — no state weight beyond the bar's need. Checkbox in the panel header, tokens-only styling.

**Test scenarios:**
- Happy path: mixed list → only top-level sessions by default; toggle on → all, original order.
- Edge case: titles containing "@" or "subagent" mid-string (not the suffix pattern) are NOT filtered; needs-attention counts derive from the filtered set.

**Verification:** Tests green; toggle behavior confirmed in Unit 6.

- [x] **Unit 4: Supervisor races**

**Goal:** No double-spawn, no orphaned children, no shutdown-time respawn.

**Requirements:** R5

**Dependencies:** None (Rust-only, parallel-safe)

**Files:**
- Modify: `src-tauri/src/server_supervisor.rs` (mirror-check `src-tauri/src/ide_sidecar.rs` for the same patterns)
- Test: inline `#[cfg(test)]` for the extracted pure decision logic

**Approach:** Lead with re-validate-after-reacquire: probe/spawn outside the lock (as today), then retake the lock and — if another child arrived first — kill the loser and keep the winner. Minimal lock hold, no monitor-tick starvation; widen to hold-across-spawn only if re-validation proves insufficient, and document the bounded lock duration if so. `spawn_monitor` checks a shutdown flag under the same lock before any respawn; `shutdown()` sets it first. Extract testable decision fns into `supervisor_common.rs` where reasonable.

**Test scenarios:**
- Concurrency: two ensure_server callers → exactly one spawn, both get the same outcome.
- Shutdown: monitor tick racing shutdown → no new child after shutdown flag set.

**Verification:** `cargo test` green; no regression in adopt-vs-owned behavior (existing tests).

- [x] **Unit 5: Workspace schema tolerance**

**Goal:** Unknown `spacebus.json` fields never break workspace load.

**Requirements:** R6

**Dependencies:** None

**Files:**
- Modify: `src/workspace/config.ts`
- Test: `src/workspace/config.test.ts`

**Approach:** Drop `.strict()` in favor of zod's default strip behavior (match space-bus's own `$strip` posture); keep the `server` variant refinement exact. Log-warn on unknown keys only if trivial to surface.

**Test scenarios:**
- Happy path: manifest with an extra unknown top-level key parses; known fields intact.
- Error path: still rejects a manifest violating the server one-of refinement.

**Verification:** New test fails on `.strict()`, passes after; suite green.

- [x] **Unit 6: Live window verification**

**Goal:** Prove the fixed paths against the real workspace; capture evidence.

**Requirements:** R9 (verifies R1, R2, R8 live)

**Dependencies:** Units 1–5 landed

**Files:** none (runbook + evidence)

**Approach:** Launch against the real workspace (daemon up). Runbook: dispatch `@dashboard` → deltas stream with no re-click (R1); second prompt continues the same session, highlight matches transcript (R2); dispatch, delete the session server-side, dispatch again → clean re-resolution (R2); kill the daemon → actionable error, restart → Retry recovers (recovery UX only); toggle subagent filter (R8). Race-sensitive items (rapid session switches, back-to-back dispatches) run ≥5 iterations — the deterministic race proof lives in the unit tests; the window is behavioral smoke and UX evidence, not the race proof. Screenshot or short capture per item.

**Test scenarios:** Test expectation: none — live verification unit; the scenarios ARE the runbook above.

**Verification:** Live window passed for deleted-session recovery, active-project highlight, session-row highlight, transcript routing, live transcript update, and parentID-based subagent hiding. Auto-scroll remains a non-blocking residual by operator decision.

## System-Wide Impact

- **Interaction graph:** store guards change what reconcile/apply write — sessions panel, roster needs-attention, and dispatch resolution all read the store; regression coverage exists in each surface's tests.
- **Error propagation:** listSessions failures now degrade to stale-but-present data instead of empty panels — matches the reconcile-on-next-tick recovery model.
- **State lifecycle risks:** generation guard must not discard the *current* generation's result after unmount/remount (StrictMode) — cover with the existing symmetric-lifecycle test patterns.
- **API surface parity:** none — no exported contract changes; schema loosening only widens accepted input.
- **Unchanged invariants:** hybrid poll + ≤1-SSE model, persistence denylist, `ide_*` boundary, localhost-only posture all untouched.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| R1's root cause is deeper than the guard (first deltas genuinely lost during stream switch) | Unit 2 keeps the delayed re-backfill fallback decision open; Unit 6 is the arbiter |
| Supervisor lock-across-spawn introduces a deadlock under the monitor thread | Keep lock scope minimal; re-validate-after-reacquire is the fallback shape |
| Subagent title pattern drifts upstream | Single predicate seam; swap when a structured field exists |

## Sources & References

- Epic (gates via its R16): `docs/brainstorms/2026-07-05-product-identity-release-preparedness-requirements.md`
- Session notes #209, #210, #205, #213; review artifact `.context/systematic/ce-review/20260705-094439-889d69f3/` (gitignored)
- Prior fixes this plan builds on: `235d072`, `7b9b704`, `9d3e58a`
