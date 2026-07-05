# mothership

> The craft the fleet reports back to.

Mothership is a multimodal agentic IDE — mission control for a workspace of AI coding agents. It is a **renderer for the bus**: `opencode serve` owns all agent state, [space-bus](https://github.com/fro-bot/space-bus) is the control plane, and Mothership is a thin multiplexing client that turns a workspace into an adaptive panel layout.

**Status:** early tracer. The shell runs: it opens a `spacebus.json` workspace, streams live session state, dispatches prompts to a control agent, and exposes its own layout as `ide_*` MCP tools so any agent can rearrange the UI. Read-only/diff-centric code view, Storybook panels, and MCP Apps skill panels are planned but not yet built.

## Shape

```
                        ┌───────────────── Mothership (Tauri v2) ─────────────────┐
 any agent ──MCP──▶ ide_* tools │ dockview: roster · sessions · transcript ·      │
                                │ terminal · Tiptap prompt bar · audit log        │
                        └───────────────┬─────────────────────────────────────────┘
                                        │ HTTP + SSE (127.0.0.1 only)
                                        ▼
                              opencode serve :4096  ◀── space-bus control agent
                                        │ x-opencode-directory
                                        ▼
                        agent · dashboard · control-plane · infra · …
```

Three ideas carry the design: project detection is mechanical (detectors → typed interface manifest → hydrated panels, no LLM); the app exposes its own layout as MCP tools so any agent can drive the UI (dogfooding is structural); skill-provided panels ride the MCP Apps standard (SEP-1865) rather than a bespoke plugin format.

## Requirements

- **[Bun](https://bun.sh)** — package manager and runtime (also runs the `ide_*` sidecar).
- **Rust** + the [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/) for macOS (Xcode command-line tools).
- **[opencode](https://opencode.ai)** on `PATH` — the app supervises `opencode serve`, or adopts one already running on `127.0.0.1:4096`.
- macOS (Apple Silicon). Windows/Linux webview parity is out of scope for v1.

## Run

```sh
bun install
bun run dev          # opens the Tauri window; spawns or adopts opencode serve
```

The app opens the [space-bus fixture workspace](https://github.com/fro-bot/space-bus) by default (see the `TODO` in `src/app/` — workspace selection is a follow-up). Point it at your own workspace by editing that default to any directory containing a `spacebus.json`.

Other scripts:

```sh
bun run typecheck    # tsc --noEmit
bun run test         # bun test
bun run lint         # biome check .
bun run build        # bun --bun run tauri build
bun run ui:dev       # vite dev server only (no Tauri shell)
```

Dev-only: the window has no address bar, so `Cmd+R` reloads and `Cmd+Shift+H` returns to the launcher; a `?spike=<id>` launcher exposes the spike harnesses.

## Letting an agent drive the layout

Mothership exposes its layout as `ide_*` MCP tools (`ide_open_panel`, `ide_split`, `ide_focus`, `ide_move_panel`, `ide_set_layout`, `ide_close_panel`, plus read-only `ide_list_panels` / `ide_get_layout`). Every mutation appears in the in-app audit log with its source.

The server binds a random loopback port with a per-launch bearer token, written to a `0600` rendezvous file at `~/Library/Application Support/com.marcusrbrown.mothership/ide-bridge.json`. To connect an opencode agent:

```sh
bun run scripts/ide-mcp-config.ts   # prints the ready-to-paste MCP config
```

For persistent wiring — so an agent's config doesn't need updating every time Mothership restarts and issues a new port/token — add a `type: local` MCP server entry that runs `scripts/ide-mcp-bridge.ts`. The bridge re-reads the rendezvous file each time it starts, opens the current streamable-HTTP connection, and proxies the `ide_*` tools over stdio:

```json
{
  "mcp": {
    "mothership-ide": {
      "type": "local",
      "command": ["bun", "run", "/path/to/mothership/scripts/ide-mcp-bridge.ts"],
      "enabled": true
    }
  }
}
```

`scripts/ide-mcp-config.ts` remains the one-shot inspector for the current launch's endpoint; the bridge is for standing configuration that survives restarts.

Read tools return only panel structure and display names — never filesystem paths or credentials — and agents cannot open a terminal panel (no subprocess reach through `ide_*`).

## Architecture

- `src/layout/` — typed command layer (one executor owns dockview's imperative API; UI and MCP both call it), panel registry, layout persistence, the WS bridge to the sidecar.
- `src/panels/` — one directory per panel type (roster, sessions, transcript, terminal, audit-log, placeholder); each is removable in one commit.
- `src/server/` — opencode client, SSE demux, reconcilable session store. Schemas and reads come from space-bus's `/contract` and `/core` library surface.
- `src/workspace/` — `spacebus.json` parsing (localhost-guarded) and `BusContext` construction.
- `src/promptbar/` — Tiptap prompt bar with `@`-mentions.
- `src-tauri/` — process supervision (`opencode serve`, PTYs, the `ide_*` sidecar), filesystem commands, window management.
- `sidecar/ide-server/` — the Bun MCP server + WS bridge.

## Design

Systematic / Fro Bot lineage — afrofuturism × cyberpunk, dark-default, cyan/magenta/orange with strict intent. Design context lives in `PRODUCT.md` + `DESIGN.md`; tokens in `design/tokens.css`. The [Impeccable](https://github.com/pbakaus/impeccable) skill is installed (`.agents/skills/impeccable/`) and CI runs `impeccable detect` as a hard design gate.

## Reading order

1. `docs/brainstorms/2026-07-03-workspace-mission-control-requirements.md` — what and why (R1–R15, flows, decisions)
2. `HANDOFF.md` — build sequencing, phase by phase
3. `AGENTS.md` — invariants for anyone (human or agent) working in this repo
4. `PRODUCT.md` + `DESIGN.md` — design context every `/impeccable` command reads
5. `docs/solutions/` — documented solutions to past problems (platform de-risk findings, server contract facts), organized by category with YAML frontmatter
