# HANDOFF — Build Mothership

You are in `marcusrbrown/mothership`, a scaffolded-but-unimplemented Tauri v2 desktop app: mission control for a workspace of OpenCode agents. Read first, in order: `docs/brainstorms/2026-07-03-workspace-mission-control-requirements.md` (authoritative — R1–R15, flows F1–F3, acceptance examples, scope boundaries), `AGENTS.md` (invariants), `PRODUCT.md` + `DESIGN.md` (design context), this file. The requirements doc's Scope Boundaries are hard: no writable editor, no bespoke panel format, no embedded model, localhost only, no telemetry.

## Context you'd otherwise have to rediscover

- **space-bus** (`fro-bot/space-bus`, likely checked out at `~/src/github.com/fro-bot/space-bus`) is the shipped control plane: an OpenCode plugin exposing `bus_roster`/`bus_task`/`bus_status`/`bus_result` (+ steering via `sessionId` on `bus_task`), reading a `spacebus.json` roster. Mothership reads the same `spacebus.json` and calls the opencode server API directly for reads/SSE; the bus tools remain the *agent-facing* surface. Do not grow the bus.
- **OpenCode server API** (verify against live `GET /doc`, default `127.0.0.1:4096`): per-request directory routing via `x-opencode-directory` header; `POST /session`, `POST /session/:id/prompt_async`, `GET /session/:id/message`, `/session/status`, SSE at `GET /event`. Basic auth via `OPENCODE_SERVER_PASSWORD`. Known sharp edges are documented in space-bus's README "Notes from implementation" — READ IT; the diff-sourcing workaround (per-turn aggregation vs `summary.diffs` on harness builds) directly affects the diff panel.
- **Stack (locked by requirements/decisions):** Tauri v2 · React + TypeScript (strict) · Bun · dockview · CodeMirror 6 + `@codemirror/merge` (read-only/diff) · `@xterm/xterm` · Tiptap MIT tier only · `@modelcontextprotocol/sdk` (the `ide_*` server) · `@mcp-ui/client` (MCP Apps host, Phase 2). Ask before adding anything else.
- **MCP Apps:** SEP-1865, spec version `2026-01-26`, in `modelcontextprotocol/ext-apps`. Read the actual spec before Phase 2 — the exact `_meta` UI key naming was unverified during research.
- **Design system (Impeccable):** the skill is installed at `.agents/skills/impeccable/` (universal build copied from `fro-bot/dashboard`; refresh anytime with `npx impeccable skills install`). `PRODUCT.md` and `DESIGN.md` are already authored from the Systematic theme — **do not run `/impeccable init`; it would overwrite settled context.** Styling comes exclusively from tokens (`design/tokens.css` → `src/styles/tokens.css`): no ad-hoc hex, cyan = action, magenta = emphasis, orange = highlight, glow focal-only. CI runs `npx impeccable detect --json src` as a hard gate (`.github/workflows/ci.yaml`); intentional brand exceptions go through `impeccable ignores add-value` into `.impeccable/config.json`, never rule-wide disables. Workflow: `/impeccable shape` before building each new panel type, `/impeccable critique` or `audit` mid-phase, `/impeccable polish` at phase gates.

## Phase 0 — De-risk spikes (before app code; each is a STOP gate)

Scaffold via `bun create tauri-app` (React-TS template) first so spikes run in the real shell. Keep spikes under `spikes/` as runnable artifacts; record findings in `docs/solutions/`.

- **0a. Webview/iframe stress (the Tauri bet).** In dockview on macOS WKWebView: ≥6 panels including 3 live iframes (a real Storybook dev server, a localhost page, a sandboxed `srcdoc` frame). Exercise drag/split/tab/close/popout. Exit: no crashes, no frozen frames after re-dock, memory sane after closing panels. **If this fails, STOP** — the fallback fork (single-webview iframe strategy vs Electron) is Marcus's call, not yours.
- **0b. PTY.** Try `tauri-plugin-pty` + `@xterm/xterm` first. If it's flaky, the fallback is PTYs in a supervised sidecar (Bun + node-pty or Rust `portable-pty`) over websocket. Pick one, document why, wrap it behind one `Terminal` interface so the choice is reversible.
- **0c. Server connectivity.** From the webview, `fetch` + `EventSource` against `127.0.0.1:4096`. The webview origin is not http — expect CORS. Options: `opencode serve --cors <origin>` or proxy through the Rust core. Verify: SSE stream received, survives server restart (reconnect + resubscribe). Exit: a live event tail from a real delegated session.

## Phase 1 — Tracer bullet (thin slice of F1 + F2)

Order of work; each item lands with tests where testable:

1. **Typed command layer + dockview shell.** `src/layout/`: layout commands as a discriminated union (`open_panel`, `close_panel`, `split`, `focus`, `move`, `set_layout`), one executor over dockview's imperative API. UI handlers and (later) MCP handlers both call it. Layout serialization persists per workspace path. Import `design/tokens.css` as `src/styles/tokens.css` here and theme dockview chrome from it — the design gate arms itself the moment `src/` exists.
2. **Workspace open (F1, minimal).** Parse `spacebus.json` (zod, fail fast, `~` expansion — mirror space-bus `src/config.ts` semantics). Universal panels only: roster + per-project session list. Detection manifest types defined (`src/detect/`) but only two detectors implemented: `.opencode/` presence, Storybook config presence (panel itself is Phase 2 — the manifest drives a placeholder tab).
3. **Live session surfaces (F2).** SSE demux (`src/server/`): one `/event` connection, fan out by session. Roster shows busy/idle live; transcript panel streams message parts; blocked-on-question renders as a needs-attention badge (AE2) with an inline answer box (steering via the server API, same semantics as `bus_task` sessionId).
4. **Prompt bar, plain first.** A textarea that dispatches to the workspace control-agent session. Tiptap (MIT: starter-kit + mention + suggestion + floating element) with @-project/@-session mentions replaces it once dispatch works.
5. **`ide_*` MCP server.** Expose the command layer + a `ide_screenshot`-free read surface (`ide_list_panels`, `ide_get_layout`) plus mutations (`ide_open_panel`, `ide_split`, `ide_focus`, `ide_set_layout`). Transport: streamable HTTP on `127.0.0.1` with a random bearer token written to an env-readable location (Claude Desktop connects via a stdio bridge; opencode MCP config connects directly). Every mutation logs the tool call visibly in-app (AE3's audit trail).

**Phase 1 verification (all must hold):** `bun run typecheck` + `bun run test` + `bun run lint` clean, and `npx impeccable detect --json src` returns `[]`. Run `/impeccable audit` on the tracer UI and address or consciously defer its findings before closing the phase. AE2 demonstrated against a real blocked delegate. AE3 demonstrated end-to-end: an OpenCode agent (with the ide MCP server configured) executes "put the terminal at the bottom and open the roster beside the diff view" via tool calls only — capture the tool-call log. The dogfood floor: delegate a real task to `fro-bot/dashboard` from the prompt bar and watch it stream.

## Phase 2 — Hydration + MCP Apps

1. Storybook detector → real Storybook panel (iframe, dev-server lifecycle owned by the Rust core/sidecar). AE1 is the gate.
2. MCP Apps host via `@mcp-ui/client`: render a sample `ui://` panel from a demo skill server; per-call tool approval UI. AE4 is the gate.
3. Diff panel using the space-bus diff-sourcing rules (per-turn aggregation fallback); colors strictly from the `--color-diff-*` tokens.
4. `/impeccable polish` across the app; design gate green; capture before/after screenshots in `docs/solutions/`.

## Working rules

- macOS-first; don't burn time on Windows/Linux webview quirks in v1.
- Commit at each numbered item with what-was-verified in the message. Small diffs; a panel type must be deletable in one commit (see `AGENTS.md`).
- Parse, don't validate: server responses and `spacebus.json` cross zod boundaries once, typed thereafter. Discriminated unions over optionals throughout the command layer.
- Tokens-only styling per `DESIGN.md`. If the detector flags something you believe is intentional brand (deliberate glow, identity gradient), stop and check it against DESIGN.md's glow/gradient policy before adding a scoped ignore — the default assumption is the detector is right.
- If a requirement and reality conflict (API shape changed, spec renamed keys), stop and report with the live evidence — don't silently reinterpret R-IDs.
- Anything you cannot verify in your environment (e.g., Claude Desktop connection), say so and hand Marcus the exact manual step.

## Definition of done (v1 tracer)

Phases 0–1 verification gates all pass reproducibly; findings from every spike documented in `docs/solutions/`; README updated with real build/run instructions replacing this aspirational scaffold; deviations from R1–R15 listed explicitly at the top of your final report.
