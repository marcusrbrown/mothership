---
title: PTY layer uses portable-pty directly behind a Terminal interface seam
date: 2026-07-04
category: best-practices
module: spikes
problem_type: tooling_decision
component: tooling
severity: medium
applies_when:
  - "Implementing or modifying the terminal panel (U1.4) or PTY lifecycle"
  - "Considering tauri-plugin-pty or a sidecar PTY backend swap"
  - "Debugging terminal rendering or throughput under WKWebView"
related_components: [xterm, portable-pty, tauri-events]
tags: [pty, portable-pty, xterm, tauri, webgl, spike-0b]
---

# PTY layer uses portable-pty directly behind a Terminal interface seam

## Context

Mothership needs terminals (R3) with the Rust core owning process lifecycle
(R1). HANDOFF suggested trying `tauri-plugin-pty` first; research showed it is
a thin, early-stage wrapper over `portable-pty` (wezterm's PTY crate). Spike 0b
validated going straight to the underlying crate (Marcus-confirmed decision).

## Guidance

Use `portable-pty` directly in `src-tauri/` — not `tauri-plugin-pty` — and keep
the frontend ignorant of the transport behind one TypeScript seam:

- `src-tauri/src/pty.rs`: `pty_spawn(cols, rows) -> pty_id` (spawns `$SHELL -l`,
  `/bin/zsh` fallback), `pty_write`, `pty_resize`, `pty_kill`; state in
  `Mutex<HashMap<String, PtySession>>`; one reader thread per PTY emitting
  `pty://output/{id}` (utf8-lossy chunks) and `pty://exit/{id}` on EOF.
- `Terminal` interface (`spawn/write/resize/kill/onData/onExit`) — the
  frontend consumes only this; swapping to a plugin, sidecar, or test mock is
  a backend change behind one seam.
- xterm 6: WebGL addon with try/catch fallback to the DOM renderer. There is
  no canvas tier anymore.
- Requires `core:event:default` in `src-tauri/capabilities/default.json` for
  the frontend to `listen()` on `pty://` events — silently denied otherwise.

Why direct over the plugin: PTY output is the highest-throughput data path in
the app — own the chunking/backpressure/encoding decisions rather than inherit
a young plugin's defaults; one fewer unproven dependency on the R1/R3 path;
reversibility preserved by the seam regardless.

## Why This Matters

- **xterm 6.0.0 removed the canvas renderer** (`@xterm/addon-canvas` no longer
  exists). The fallback chain is webgl-or-DOM only, so DOM renderer perf is
  the floor if WebGL2 is unavailable. Verified: **WebGL is active under
  WKWebView** — no fallback needed on macOS.
- Spike-verified throughput: `seq 1 200000 > /dev/null` → 0.034s total, UI
  smooth, no event-channel backlog. The Tauri event channel handles bursts
  fine at spike scale.
- Kill/respawn verified clean — zero orphaned shells in `ps`.

## When to Apply

- U1.4 terminal panel promotion (owns real cleanup + resize verification —
  panel resize was not exercisable in the spike's fixed container).
- Any future PTY backend swap (plugin/sidecar): implement `Terminal`, leave
  the panel untouched.
- Terminal font work: Nerd Font glyphs render as boxes without a Nerd Font
  stack — the panel should use a configurable `fontFamily` (e.g.
  `'MesloLGS NF', Menlo, monospace`).

## Examples

Known spike-grade gaps carried to U1.4 (documented, not hidden):

- Reader threads are detached (no tracked `JoinHandle`) — needs lifecycle
  tracking for graceful shutdown ordering (ties into U1.7's shutdown work).
- No window-destroy/app-quit cleanup hook — only explicit `pty_kill` reaps
  children; force-quit orphan behavior unverified.
- No backpressure/coalescing beyond the OS pipe buffer and Tauri's event
  queue — fine for one session, revisit for many concurrent terminals.

## Related

- Harness: `spikes/0b-pty/` (`terminal-interface.ts` is the seam)
- Plan: `docs/plans/2026-07-04-001-feat-mothership-tracer-bullet-plan.md`
  (U0.3, U1.4, Key Technical Decisions)
- STOP-gate status: **CLEARED** (WebGL renderer, clean kill/respawn, smooth
  throughput; resize deferred to U1.4 where a resizable container exists)
