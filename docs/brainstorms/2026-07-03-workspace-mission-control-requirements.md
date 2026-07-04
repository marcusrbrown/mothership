---
date: 2026-07-03
topic: workspace-mission-control
---

# Mothership — Multimodal Agentic IDE

## Summary

A Tauri v2 desktop app that is a renderer for the bus: `opencode serve` owns all agent state, space-bus is the control plane, and the app is a thin multiplexing client. Opening a workspace mechanically detects project types and hydrates a dockview layout of native panels (session list, live transcripts, diff review, terminal, Tiptap prompt bar) and web panels (Storybook, localhost previews, MCP Apps). Skill-provided interfaces ride the MCP Apps standard; the app is itself an MCP server so any agent — prompt bar, control agent, Claude Desktop — can drive its layout. Mission control ships first; writable editing stays in VS Code until earned.

---

## Problem Frame

Agentic development today means Visual Studio Code, Claude Desktop, and an OpenCode TUI open simultaneously, with attention bouncing between them — even after space-bus collapsed N TUIs into one control agent. The 2026-07-03 landscape survey found the same shape everywhere (FleetCode, Conductor, Crystal, Vibe Kanban, CodeLayer, Warp, Antigravity): the human is always mission control, no product adapts its UI to the project types in a workspace, and none exposes its own layout to agent control. Orchestration state lives in kanban columns or the operator's head.

---

## Actors

- A1. Marcus (operator): opens workspaces, reviews diffs, steers via prompt bar and panels.
- A2. Control agent: workspace-level OpenCode agent holding the space-bus tools; routes work to delegates.
- A3. Delegate agents: per-project OpenCode sessions created via `bus_task`.
- A4. Skill panels: MCP Apps servers shipping `ui://` interfaces the app hosts.
- A5. External agents (e.g., Claude Desktop): reach the same workspace through the space-bus MCP facade and the app's own MCP server.

---

## Key Flows

- F1. Open workspace
  - **Trigger:** A1 opens a directory containing `spacebus.json` (or a single project).
  - **Actors:** A1
  - **Steps:** mechanical detectors scan each roster project (package.json deps, storybook config, compose files, `.opencode/`) → typed interface manifest → dockview layout hydrates: roster + session panels always; Storybook/preview/MCP Apps tabs per manifest.
  - **Outcome:** a workspace-shaped UI with zero LLM involvement in detection.
  - **Covered by:** R4, R5, R6

- F2. Delegate and watch
  - **Trigger:** A1 submits a prompt in the floating prompt bar (@-mentions resolve to projects/sessions).
  - **Actors:** A1, A2, A3
  - **Steps:** prompt goes to the control agent session → `bus_task` dispatch → session panel opens, streaming via SSE → blocked-on-question state surfaces as a needs-attention item → A1 answers inline (steering via `bus_task` sessionId).
  - **Outcome:** delegation, progress, and steering without leaving the app.
  - **Covered by:** R7, R8, R9, R13

- F3. Agent reshapes the UI
  - **Trigger:** natural-language UI request ("split code and storybook, terminal at the bottom") from prompt bar or any connected agent.
  - **Actors:** A1 or A5, A2
  - **Steps:** an agent translates intent → typed `ide_*` tool calls (the app's MCP server) → dockview imperative API mutates layout.
  - **Outcome:** the LLM's only UI role is emitting typed commands; the same path serves dogfooding.
  - **Covered by:** R10, R11

---

## Requirements

**Shell and chassis**

- R1. Tauri v2 desktop app; the Rust core (or a supervised sidecar) owns `opencode serve`/PTY process lifecycle.
- R2. dockview panel chassis with layout serialization; layout state persists per workspace.
- R3. Code view is read-only and diff-centric (CodeMirror 6 + `@codemirror/merge`); terminal panels use `@xterm/xterm`.

**Detection and hydration**

- R4. Project detection is mechanical and pluggable: detectors emit a typed interface manifest per project; no LLM in the detection path.
- R5. When a detector matches (e.g., Storybook config present), the corresponding panel is offered in that project's tab set without manual configuration.
- R6. Detection failures degrade gracefully: an undetected project still gets the universal panels (sessions, terminal, files).

**Bus and session surfaces**

- R7. The app reads workspace rosters from `spacebus.json` and renders live per-project session status (reusing space-bus core semantics; the app may call the server API directly for reads).
- R8. Session transcripts stream live via the server's SSE event feed; no polling loops in the UI.
- R9. When a delegate session blocks on an interactive question, the app surfaces it as a needs-attention item and supports answering inline.

**IDE as agent surface**

- R10. The app exposes an MCP server with typed layout/navigation tools (`ide_layout`, `ide_open_panel`, `ide_focus`, ...); every layout mutation available in the UI is available as a tool.
- R11. Natural-language UI commands are translated by whatever agent receives them into `ide_*` calls; the app itself embeds no model.
- R12. The app is an MCP Apps host (SEP-1865, `@mcp-ui/client`): skill-provided `ui://` panels render in sandboxed iframes with per-call tool approval.

**Prompt and text surfaces**

- R13. A floating Tiptap prompt bar (MIT-tier extensions) with @-mentions for projects/sessions and slash commands; submitting starts or steers control-agent sessions.
- R14. Rich-text surfaces (plans, requirements docs) use the same MIT Tiptap stack, round-tripping markdown to disk.

**Security**

- R15. Server/bus traffic stays on localhost; credentials only from env; skill panels run only in sandboxed iframes with JSON-RPC postMessage; no telemetry.

---

## Acceptance Examples

- AE1. **Covers R5, R6.** Given a workspace containing `fro-bot/dashboard` (Storybook configured) and `fro-bot/.github` (no UI tooling), when the workspace opens, dashboard's tab set offers a Storybook panel and control-plane's tab set shows universal panels only.
- AE2. **Covers R9.** Given a delegate session that asks an interactive question, when it blocks, the app shows a needs-attention indicator within one SSE event cycle, and answering from the panel unblocks the session.
- AE3. **Covers R10, R11.** Given "put the terminal at the bottom and open dashboard's Storybook beside the diff view" in the prompt bar, when the agent responds, the layout mutates via `ide_*` tool calls only — verifiable in the tool-call log.
- AE4. **Covers R12.** Given a project skill shipping a `ui://` panel, when its tool runs, the panel renders in a sandboxed iframe and its tool calls back to the host require approval per configured policy.

---

## Success Criteria

- One-app days: a representative Fro Bot working session (delegate, watch, steer, review diffs, check Storybook) happens without opening Claude Desktop or an OpenCode TUI — VS Code opens only for writable editing.
- Dogfood loop closes: Mothership's own development can be driven from inside it (prompt bar → control agent → space-bus → this repo's delegate), including at least one layout change performed by the agent mid-task.
- Opening the five-project Fro Bot workspace hydrates correct per-project tab sets with zero manual layout setup.
- A downstream planner can start from this doc without inventing product behavior: flows F1–F3 and R1–R15 cover the v1 surface.

---

## Scope Boundaries

- No writable code editor in v1 — read/diff-centric only; editing stays in VS Code until mission control earns it.
- No bespoke panel plugin format — skill panels are MCP Apps or nothing.
- No embedded model in the app; no "UI model" architecture slot — model choice is routing, outside the app.
- No ACP embedding in v1 (candidate for the later editor phase); no voice (Tiptap Voice is a proof-of-concept).
- No cloud/remote workspaces, no multi-machine transport, no collaboration.
- Tool surface of space-bus stays frozen; the app reads the server API directly rather than growing the bus.

---

## Key Decisions

- Named Mothership, home repo `marcusrbrown/mothership` (Marcus, 2026-07-03): the craft the fleet reports back to.
- Mission control first (Marcus, 2026-07-03): the pain is app-juggling for agent work, not editing.
- MCP Apps as the skill-panel mechanism (Marcus, 2026-07-03): multi-vendor Final spec over an owned format; panels reusable in Claude Desktop/ChatGPT/VS Code.
- Tauri v2 over Electron (Marcus, 2026-07-03, contra the research recommendation): footprint, security model, Rust sidecar for process supervision; accepted risks — per-platform webview quirks in an iframe-heavy app, single-maintainer PTY plugin. Mitigations: macOS-first, PTY strategy resolved in planning. CodeLayer (Tauri + daemon) is shipping precedent.
- Renderer-for-the-bus principle: `opencode serve` owns state; the app holds no agent state of its own.
- IDE-as-MCP-server: fills the gap the landscape survey found (no product exposes layout as agent tools) and makes dogfooding structural rather than aspirational.
- Tiptap scoped to text surfaces (prompt bar, docs), MIT tier; it is not the app chassis.

---

## Dependencies / Assumptions

- space-bus v0.1.0 semantics (roster, dispatch, steering via `bus_task` sessionId, blocked-question surfacing) — shipped and dogfooded; repo: `fro-bot/space-bus`.
- OpenCode server API: SSE `/event` feed, directory routing, session/diff endpoints (see space-bus README "Notes from implementation" for known API sharp edges, e.g. diff sourcing).
- MCP Apps spec `2026-01-26` (ext-apps repo) — read the spec text before implementing; exact `_meta` key naming was UNVERIFIED in research.
- dockview (MIT, active), CodeMirror 6, `@xterm/xterm` — verified maintained as of 2026-07.
- Tiptap AI-style accept/reject streaming UX is the paid AI Toolkit; MIT tier covers prompt bar and doc surfaces (sur9e as existence proof).

---

## Outstanding Questions

### Deferred to Planning

- [Affects R1][Technical] PTY strategy on Tauri: `tauri-plugin-pty` (single-maintainer risk) vs PTYs in a supervised Bun/Rust sidecar over websocket.
- [Affects R2, R12][Needs research] Tauri multi-webview reality for many concurrent iframes (Storybook + previews + MCP Apps panels) on macOS WKWebView; fallback if quirks bite.
- [Affects R8][Technical] SSE fan-in shape: one `/event` connection per server with client-side demux, and reconnect/backfill behavior. Note the webview's non-http origin: browser `fetch`/`EventSource` from `tauri://` to `127.0.0.1:4096` needs the server's `--cors` flag or proxying through the Rust core.
- [Affects R13][Technical] DIY accept/reject streaming UX on MIT Tiptap vs purchasing AI Toolkit.
- [Affects R4][Technical] Detector packaging: in-app registry vs per-project skill extensions contributing manifest entries.

---

## Sources / Research

- Landscape survey (2026-07-03): FleetCode, Conductor, Crystal/Nimbalyst, Vibe Kanban (sunsetting; steal embedded preview browser), HumanLayer/CodeLayer (Tauri + daemon precedent), opencode web, Zed ACP, Warp, Google Antigravity, Sculptor.
- MCP Apps: SEP-1865 (Final), spec `2026-01-26`, `modelcontextprotocol/ext-apps`, `@mcp-ui/client` host SDK.
- Tiptap: MIT/paid split; experiments Voice + Flex (prototypes); AI Toolkit is the paid add-on matching the screenshot UX; sur9e (arspesk/sur9e) as MIT-tier existence proof and files-on-disk cockpit pattern.
- Stack: dockview vs FlexLayout/react-mosaic/golden-layout; Monaco vs CodeMirror 6; `@xterm/xterm`; Tauri v2 vs Electron trade study.
