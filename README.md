# mothership

> The craft the fleet reports back to.

Mothership is a multimodal agentic IDE — mission control for a workspace of AI coding agents. It is a **renderer for the bus**: `opencode serve` owns all agent state, [space-bus](https://github.com/fro-bot/space-bus) is the control plane, and Mothership is a thin multiplexing client that turns a workspace into an adaptive panel layout.

**Status:** pre-implementation. Requirements are settled (`docs/brainstorms/2026-07-03-workspace-mission-control-requirements.md`); building starts from `HANDOFF.md`.

## Shape

```
                        ┌───────────────── Mothership (Tauri v2) ─────────────────┐
 any agent ──MCP──▶ ide_* tools │ dockview: roster · sessions · diff · terminal · │
                                │ Tiptap prompt bar · Storybook · MCP Apps panels │
                        └───────────────┬─────────────────────────────────────────┘
                                        │ HTTP + SSE (127.0.0.1 only)
                                        ▼
                              opencode serve :4096  ◀── space-bus control agent
                                        │ x-opencode-directory
                                        ▼
                        agent · dashboard · control-plane · infra · …
```

Three ideas carry the design: project detection is mechanical (detectors → typed interface manifest → hydrated panels, no LLM); the app exposes its own layout as MCP tools so any agent can drive the UI (dogfooding is structural); skill-provided panels ride the MCP Apps standard (SEP-1865) rather than a bespoke plugin format.

v1 is mission control — delegate, watch, steer, review diffs, preview — with a read-only, diff-centric code view. Writable editing stays in VS Code until mission control earns it.

## Design

Systematic / Fro Bot lineage — afrofuturism × cyberpunk, dark-default, cyan/magenta/orange with strict intent. Design context lives in `PRODUCT.md` + `DESIGN.md`; tokens in `design/tokens.css`; sources in `design/`. The [Impeccable](https://github.com/pbakaus/impeccable) skill is installed (`.agents/skills/impeccable/`) and CI runs `impeccable detect` as a hard design gate.

## Reading order

1. `docs/brainstorms/2026-07-03-workspace-mission-control-requirements.md` — what and why (R1–R15, flows, decisions)
2. `HANDOFF.md` — how to build it, phase by phase
3. `AGENTS.md` — invariants for anyone (human or agent) working in this repo
4. `PRODUCT.md` + `DESIGN.md` — design context every `/impeccable` command reads
