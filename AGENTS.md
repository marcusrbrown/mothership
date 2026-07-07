# mothership — Development

Multimodal agentic IDE: Tauri v2 desktop app rendering a workspace of OpenCode agents coordinated by space-bus. Requirements: `docs/brainstorms/2026-07-03-workspace-mission-control-requirements.md` (R1–R15 are the contract). Build plan: `HANDOFF.md`.

## Invariants

- **Renderer for the bus:** `opencode serve` owns all agent state. Mothership holds UI state only (layout, panel prefs). If you're persisting sessions, transcripts, or agent memory in the app, stop — that state belongs to the server.
- **Layout parity:** every layout mutation available in the UI is available as an `ide_*` MCP tool, and vice versa. One command layer; UI handlers and MCP handlers call the same typed functions.
- **No embedded model:** the app never calls an LLM. Natural language becomes typed commands in whatever agent received it.
- **Mechanical detection:** the detector → interface-manifest path contains no LLM and no network calls.
- **Localhost only:** all server/bus traffic to `127.0.0.1`/`::1`; credentials from env only; no telemetry, no off-machine calls at runtime.
- **Skill panels are sandboxed:** MCP Apps content renders only in sandboxed iframes over postMessage JSON-RPC; no skill-provided code in the main webview context.
- **Design for deletion:** panels are self-contained; a panel type should be removable in one commit.
- **Tokens-only styling:** components style exclusively from `src/styles/tokens.css` (seeded from `design/tokens.css`) — no ad-hoc hex, no inline color literals. `PRODUCT.md` and `DESIGN.md` are the design context; the Impeccable skill (`.agents/skills/impeccable/`, `/impeccable <command>`) enforces it and CI's design-check gate (`npx impeccable@3.2.0 detect src`) must stay green. Intentional brand exceptions get scoped entries in `.impeccable/config.json`, never rule-wide disables.
- **Release secrets never reach PR/agent-triggered workflows:** Apple signing/notarization credentials and the Tauri updater private key live only in the GitHub Actions `release` environment (required reviewers, no `pull_request`/`pull_request_target`/`workflow_run`/`workflow_call` triggers). Runbook, key custody, rollback, and checklist docs live under `docs/release/`; see `docs/release/v0-1-release-runbook.md` and `docs/release/signing-key-custody.md`.

## Layout (target)

- `src/` — React front end: `panels/` (one dir per panel type), `layout/` (dockview wrapper + typed command layer), `detect/` (detectors + manifest types), `server/` (opencode API client, SSE demux), `promptbar/` (Tiptap), `styles/tokens.css`
- `src-tauri/` — Rust core: process supervision (`opencode serve`, sidecar), window/webview management, MCP `ide_*` server transport
- `design/` — design sources of truth: `systematic-banner.svg`, `systematic.theme.json`, `tokens.css` (seed)
- `PRODUCT.md` / `DESIGN.md` — Impeccable design context (audience, brand, tokens, color intent, quality gate)
- `.agents/skills/impeccable/` — installed Impeccable skill (refresh via `npx impeccable skills install`)
- `.impeccable/config.json` — detector allowlist for documented brand exceptions
- `docs/brainstorms/` — requirements (systematic ce-brainstorm format)
- `docs/solutions/` — documented solutions to past problems, YAML frontmatter (`module`, `tags`, `problem_type`)

## Verification

`bun run typecheck`, `bun run test`, `bun run lint` must pass; `npx impeccable@3.2.0 detect --json src` must return `[]` (CI design-check gate; pin the version — a floating `npx impeccable` can resolve to an older major in CI that predates `.impeccable/config.json`'s `ignoreValues` schema and false-positives documented brand exceptions); UI changes need a screenshot or a short doc note; Phase gates in `HANDOFF.md` define done. The standing dogfood check: an agent can rearrange the layout via `ide_*` tools while a delegated task runs.
