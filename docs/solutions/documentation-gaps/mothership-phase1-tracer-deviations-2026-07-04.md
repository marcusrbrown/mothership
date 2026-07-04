---
title: Mothership Phase 1 tracer — deviations from R1–R15
date: 2026-07-04
category: documentation-gaps
module: mothership
problem_type: documentation_gap
component: documentation
severity: medium
applies_when:
  - "Reviewing what the Phase 1 tracer does and does not deliver against the requirements contract"
  - "Starting Phase 2 (Storybook panel, MCP Apps host, diff panel)"
  - "Auditing R1–R15 coverage before sign-off"
tags: [mothership, tracer, requirements, deviations, phase-1]
---

# Mothership Phase 1 tracer — deviations from R1–R15

## Context

The definition of done for the v1 tracer requires deviations from the R1–R15
contract (`docs/brainstorms/2026-07-03-workspace-mission-control-requirements.md`)
listed explicitly. This is that list, current as of the end of Phase 1
(branch `feat/phase-0-1-tracer`, 216 tests green). Requirements met in full are
omitted; only deviations, partials, and deferrals are recorded.

## Fully met (no deviation)

R1 (Tauri v2 shell + core owns process lifecycle — PTYs + `opencode serve`
supervision, adopt-don't-spawn), R2 (dockview chassis + per-workspace layout
persistence), R4 (mechanical pluggable detection → typed manifest, zero
network/LLM), R6 (undetected project → universal panels), R7 (`spacebus.json`
roster + live per-project status), R8 (SSE streaming, no polling), R9
(needs-attention + inline answer — pending live AE2 confirmation), R10/R11
(`ide_*` typed layout tools, UI/tool parity through one executor, no embedded
model — pending live AE3 confirmation), R15 (localhost-only, env creds,
no telemetry).

## Deviations and partials

### R3 — Read-only diff-centric code view: PARTIAL
Terminals (`@xterm/xterm` 6) are delivered (U1.4). The **read-only diff view**
(CodeMirror 6 + `@codemirror/merge`) is **Phase 2** — the plan scoped the diff
panel out of the tracer. No writable editor exists (scope-boundary compliant).

### R5 — Detector match → panel offered: PLACEHOLDER-GRADE
A detected Storybook interface surfaces as a **placeholder tab** labeled
`Storybook · <project>`, not a live Storybook panel. The real iframe panel with
dev-server lifecycle is Phase 2 (AE1 is its gate). This is the planned tracer
depth, not a regression.

### R12 — MCP Apps host (SEP-1865): DEFERRED to Phase 2
Not started. `@mcp-ui/client` host, sandbox proxy, and per-call tool approval
(AE4) are Phase 2. The spec was verified during planning (SEP-1865 Final,
version `2026-01-26`, `_meta.ui.resourceUri`, sandboxed iframe mandatory).

### R13 — Tiptap prompt bar: mentions yes, slash commands NO
`@`-mentions for projects and sessions are delivered (U1.6, MIT-tier Tiptap v3).
**Slash commands** named in R13 are **not** implemented — deferred. Enter
submits / Shift+Enter newlines.

### R14 — Rich-text doc surfaces round-tripping markdown: NOT STARTED
Out of Phase 0–2 scope entirely. No plan unit; future iteration.

### R15 — sandboxed skill iframes: NOT EXERCISED (no regression)
Localhost-only, env-only creds, and no-telemetry all hold. The **sandboxed-iframe**
clause of R15 applies to MCP Apps skill panels, which don't exist until Phase 2;
the sandbox posture was characterized in spike 0a but no skill panel renders yet.

## Cross-cutting deviations (not R-specific)

### opencode server API drift
The plan's "Verified Server Facts" said `GET /vcs/status` does not exist; the
live server (v1.17.13+harness) **has** it. Re-verify against `GET /doc` at
Phase 2 diff-panel time. (See
`documentation-gaps/opencode-server-sse-contract-facts-2026-07-04.md`.)

### SSE `id:` absent → no Last-Event-ID resume
The wire has no protocol-level `id:` field, so literal resume is unavailable.
Mitigated by full reconciliation on every reconnect (`listSessions` +
`getSessionStatus` + `listQuestions`) — correctness holds, but the resume
optimization the plan assumed does not exist.

### Authenticated SSE unsupported
The tracer targets an unauthenticated loopback server. If `OPENCODE_SERVER_PASSWORD`
is set, the native `EventSource` cannot send it (no header support); the handshake
fails loud rather than silently degrading. A fetch-based SSE parser is the
documented upgrade path, not built.

### dockview popout cut
`window.open`-based popout is blocked under Tauri WKWebView (spike 0a). Popout is
cut from the tracer; no acceptance example depends on it.

### Claude Desktop connection dropped
Connecting Claude Desktop needs the bearer token embedded in
`claude_desktop_config.json` (user-readable, iCloud-backed), conflicting with the
creds-from-env invariant. Dropped from the tracer; AE3 uses an opencode agent
reading the rendezvous file. (See `scripts/ide-mcp-config.ts`.)

### Deferred `ide_*` sidecar hardening (3 items)
Independent security review (Oracle) surfaced 8 findings; 5 fixed in-phase
(allowlist read serializer, `mcpOpenable` gate, atomic 0600 rendezvous, 401
uniformity, audit completeness). 3 deferred as tracked follow-ups: second-WS
silently replaces first (strands pending), restart-cap bypassable via the
webview reconnect loop, app-crash orphans the loopback sidecar. Proportional
for a localhost single-operator tracer; none block AE3.

### Workspace directory hardcoded
The opened workspace is hardcoded to the space-bus fixture path with a `TODO` —
real workspace selection (directory picker) is a follow-up, not a tracer gate.

## Live-verification still owed at the window gate (U1.8)

These pass at unit/contract level but need the real Tauri window:
- **AE2** — a real blocked delegate: needs-attention within one SSE cycle,
  inline answer unblocks (the `question.replied`-confirms-unblock wiring).
- **AE3** — an opencode agent drives layout via `ide_*` tool calls only,
  captured in the audit log.
- **Dogfood floor** — delegate a real task to `fro-bot/dashboard` from the
  prompt bar and watch it stream.
- `listSessions` response shape against a live server (stub-tested only).
- Tiptap editor mount: `@`-popup positioning, Enter/Shift+Enter in a real editor.

## Related

- Plan: `docs/plans/2026-07-04-001-feat-mothership-tracer-bullet-plan.md`
- Requirements: `docs/brainstorms/2026-07-03-workspace-mission-control-requirements.md`
- Server contract facts: `documentation-gaps/opencode-server-sse-contract-facts-2026-07-04.md`
