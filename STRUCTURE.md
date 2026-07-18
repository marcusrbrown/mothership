# mothership — Structure

A navigation map: where to find things and where to add new code. For how the system works and why, see `ARCHITECTURE.md`. For the rules that govern all of this, see `AGENTS.md`.

## Top level

```
src/            React front end (TypeScript, Vite)
src-tauri/      Rust core: Tauri v2 app, process supervision, fs seams
sidecar/        Bun MCP server exposing the app's layout as ide_* tools
design/         Design sources of truth (tokens, theme, banner)
docs/           brainstorms/ (requirements), plans/, release/, solutions/
scripts/        Release tooling, ide_* MCP config/bridge helpers
.github/        CI, brand-voice check, release workflow
AGENTS.md       Invariants — read first, authoritative over everything else
ARCHITECTURE.md How the system works and why
STRUCTURE.md    This file
PRODUCT.md / DESIGN.md   Design context the Impeccable skill reads
HANDOFF.md      Build sequencing, phase by phase
README.md       Project overview, run instructions
```

## `src/`

| Path | Purpose |
| --- | --- |
| `src/layout/` | Typed command layer. `commands.ts` (schema), `executor.ts` (the one function — `executeCommand` — that mutates dockview), `adapter.ts` (dockview seam interface), `dockview-adapter.ts` (real implementation), `registry.ts` (panel type registration + `mcpOpenable`), `persistence.ts` (layout save/restore), `bridge.ts` + `bridge-protocol.ts` (WS bridge to the `ide_*` sidecar), `bootstrap.ts` (panel type registration list), `DockviewShell.tsx` (the shell component, active-directory SSE). |
| `src/panels/` | One directory per panel type: `roster/`, `sessions/`, `transcript/`, `terminal/`, `audit-log/`, `placeholder/`. Each splits a DOM-free view module (e.g. `roster-view.ts`) from its rendering wrapper, so logic is unit-testable without a DOM. Each panel type is removable in one commit. |
| `src/server/` | `client.ts` (opencode HTTP client), `sse.ts` (SSE stream wrapper), `demux.ts` (event demux), `session-store.ts` (reconcilable cache — rebuilt from server responses, not a store of record), `reconcile-poller.ts` (periodic all-projects REST reconcile), `bus.ts` (space-bus contract/core reads), `types.ts`, `base64.ts`. |
| `src/workspace/` | `config.ts` (`spacebus.json` parsing, localhost-guarded), `context.ts` (`BusContext` construction), `tauri-fs.ts` (Tauri fs invoke seams + `resolveManagedServer` from `@fro.bot/space-bus/attach`). |
| `src/promptbar/` | Tiptap-based prompt bar: `PromptBar.tsx`-adjacent modules `mention-items.ts`, `mention-extension.ts`, `mention-route.ts` (`@`-mentions), `dispatch.ts` (sends to target agent), `serialize.ts`, `controller.ts`, `keymap.ts`. |
| `src/app/` | `StartupHandshake.tsx` + `handshake-machine.ts` (connecting → connected → failed state machine), `ErrorBoundary.tsx`. |
| `src/detect/` | `detectors.ts` + `manifest.ts` — mechanical project detection → typed interface manifest. No LLM, no network calls (enforced invariant). |
| `src/styles/` | `tokens.css` (seeded from `design/tokens.css` — the only source of color/spacing values components may use), `global.css`. |

## `src-tauri/src/`

| Path | Purpose |
| --- | --- |
| `lib.rs` | Tauri app builder, invoke handler registration. |
| `main.rs` | Entry point. |
| `server_supervisor.rs` | Supervises `opencode serve` (spawn or adopt, health probe, bounded restarts). |
| `ide_sidecar.rs` | Supervises the `sidecar/ide-server` Bun process: spawn/monitor/restart, token rendezvous, dev-vs-bundled binary resolution. |
| `supervisor_common.rs` | Pure decision functions shared by both supervisors (restart-window math, spawn-race resolution) — factored out so they're unit-testable without spawning real processes. |
| `pty.rs` | Portable-pty terminal session lifecycle for the terminal panel. |
| `workspace_fs.rs` | Generic read-only fs seams exposed to the webview: `read_text_file`, `path_exists`, `home_dir`, `realpath`, `env_var`. |

Config: `tauri.conf.json` (base), `tauri.dev.conf.json`, `tauri.release.conf.json` (strict CSP, updater pubkey, externalBin sidecar). `Entitlements.plist` (main app) is separate from `sidecar-Entitlements.plist` (sidecar-only JIT/DYLD exceptions) — never merge them.

## `sidecar/ide-server/`

Bun MCP server exposing the 8 `ide_*` tools (`open_panel`, `close_panel`, `split`, `focus`, `move_panel`, `set_layout` as mutations; `list_panels`, `get_layout` as reads) over MCP streamable-HTTP, relaying through a WS bridge into the webview's `executeCommand`.

| Path | Purpose |
| --- | --- |
| `index.ts` | Entry point: HTTP server, PID liveness check, shutdown handling. |
| `http-auth.ts` | Bearer token extraction/verification for the HTTP surface. |
| `ws-bridge.ts` | WS connection to the webview, first-frame auth, request/response correlation. |
| `mcp-server.ts` | MCP tool definitions, relays each call over the WS bridge. |
| `redact.ts` | Allowlist serializers (`listPanelsView`, `layoutStructureView`) — the only shapes read tools may return. |

## Testing convention

- TypeScript: colocated `*.test.ts` next to the source file it covers (e.g. `src/layout/executor.test.ts`, `sidecar/ide-server/redact.test.ts` — search there, not a separate `tests/` tree).
- Rust: unit tests inline at the bottom of each module (`#[cfg(test)] mod tests`), exercising the pure functions extracted into `supervisor_common.rs` rather than spawning real child processes.
- Panels and other side-effecting modules split a pure/DOM-free "view" module (e.g. `roster-view.ts`, `sessions-view.ts`, `transcript-view.ts`) from the thin `.tsx`/`index.ts` wrapper that wires it to React and dockview — the view module is what gets tested directly.

## Where things live (task → location)

- **Add a panel type** → new directory under `src/panels/<type>/`, register it in `src/layout/bootstrap.ts`. Set `mcpOpenable: false` in the registry entry if it shouldn't be externally openable (e.g. anything with subprocess reach, like the terminal).
- **Change or add a layout command** → `src/layout/commands.ts` (schema) + `src/layout/executor.ts` (`executeCommand` case). One change point serves both UI and `ide_*` callers — see `ARCHITECTURE.md`'s "typed command layer" section.
- **Add a new `ide_*` MCP tool** → `sidecar/ide-server/mcp-server.ts` (tool definition + relay) and, if it's a new command, `src/layout/executor.ts`. Read tools must go through `sidecar/ide-server/redact.ts`'s allowlist serializers, never raw panel state.
- **Filesystem access from the webview** → add a Rust command to `src-tauri/src/workspace_fs.rs`, then a matching `invoke()` wrapper in `src/workspace/tauri-fs.ts`. Do not add `@tauri-apps/plugin-fs` — it's intentionally not a dependency.
- **Styling** → `src/styles/tokens.css` only. No inline hex or ad-hoc color literals; CI's `impeccable detect` gate blocks them. Documented brand exceptions go in `.impeccable/config.json`, never a rule-wide disable.
- **opencode session/transcript state** → `src/server/` (`client.ts`, `session-store.ts`, `reconcile-poller.ts`). Never persist this state to disk — it's owned by `opencode serve`.
- **Requirements / design decisions** → `docs/brainstorms/`. Build plans → `docs/plans/`. Past problem writeups (with YAML frontmatter for lookup) → `docs/solutions/`.

## Scripts and CI

- `scripts/ide-mcp-config.ts` — one-shot inspector printing the current launch's `ide_*` MCP endpoint/token.
- `scripts/ide-mcp-bridge.ts` — persistent stdio-to-streamable-HTTP bridge for standing agent MCP config, re-reads the rendezvous file each start so it survives app restarts.
- `scripts/sync-version.ts`, `scripts/apply-release-settings.ts`, `scripts/verify-release-settings.ts`, `scripts/validate-updater-manifest.ts`, `scripts/release-policy.ts` — release pipeline tooling; see `docs/release/`.
- `.github/workflows/ci.yaml` — typecheck, test, lint, design-check gates.
- `.github/workflows/fro-bot.yaml` — brand-voice / positioning-copy checks (e.g. the "fleet" ban in public copy).
- `.github/workflows/release.yaml` — signed/notarized build pipeline, runs only in the `release` environment with required reviewers.
- `.github/workflows/version.yml` — version bump automation.

## See also

- `ARCHITECTURE.md` — how the system works and why it's shaped this way.
- `AGENTS.md` — invariants and verification commands.
