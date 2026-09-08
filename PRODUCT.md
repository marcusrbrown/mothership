# Product

**Mothership** is mission control for a workspace of AI coding agents: a local-first app that renders a live workspace — roster, sessions, transcripts, terminal, prompt bar — and exposes its own layout and session control as 17 `ide_*` MCP tools (8 layout + 9 session). Any agent can drive the same visible, typed controls the operator uses for the UI and session workflows those tools cover; agents cannot open a terminal panel (no subprocess reach through `ide_*`).

**Northstar:** the agent-native shell that mission control is building toward — a local-first app for designing, ideating, experimenting, and building with agents. Planning/docs surfaces, in-app editing, automation connectors, and sandboxed MCP Apps panels are roadmap extensions of today's 17-tool surface, not shipped — see `docs/plans/` for implementation status and open verification gates.

## Lane

Product (an operator tool / IDE surface), not a marketing surface. There is no funnel and no pitch; the user launched the app on purpose.

## Audience

A single technical operator first (Marcus), with open-source developers running their own agent workspaces as the second-order audience. Optimize for at-a-glance status comprehension across many concurrent sessions, fast triage of blocked agents, and information density that rewards a keyboard-first power user. No onboarding funnel; empty states teach by pointing at `spacebus.json`.

## Voice

Terse, operational, precise. Status over prose. Honest about reality: stale data says stale, a blocked session says blocked and why, a working-tree diff is labeled working-tree. Never imply an agent is working when it's waiting. Describe what the app does today in present tense; describe what it will do in roadmap terms — never present tense for unshipped capability.

## Backend posture

OpenCode is the current backend, not the product's identity — it's the vehicle, not the sell. The app never calls an LLM itself; agent state and intelligence live entirely with the backend it renders. Mothership stays a local-first renderer and attacher: it owns UI state only, and it never becomes an "OpenCode UI" in how it's described.

## Licensing

The current codebase is MIT-licensed and fully open. Open-core intent is declared but the commercial line is deliberately undesignated pending market research — nothing shipped today (panels, `ide_*` tools) is paywalled, and that stays true regardless of how a future commercial line gets drawn.

## Brand

Systematic / Fro Bot lineage — afrofuturism × cyberpunk, organic soul meets machine precision. The app lives in the dark: void-navy deep backgrounds, structured geometry, high-contrast accents with strict intent — cyan is action, magenta is emphasis, orange is highlight. The banner's cyan→magenta→orange gradient is reserved for identity moments (about, launch, empty-state art), never spread across chrome. Glow marks the focal interactive element, nothing else. Sources of truth: `design/systematic-banner.svg`, `design/systematic.theme.json`, `DESIGN.md`.

## Anti-references

- Generic SaaS-dashboard blandness: gray-on-gray, undifferentiated cards, cards nested in cards.
- AI-slop tells used *without* brand intent: gratuitous purple gradients, indiscriminate glows, bounce easing everywhere. Mothership's glow and gradient are deliberate and scarce — that scarcity is the line between brand and slop.
- VS Code cosplay. Mothership is not an editor for v0.1 and must not imitate one; its identity is the mission-control board, not the file tree. In-app editing is a roadmap item, not a permanent ban — if it ships, it earns its place deliberately rather than by drift.
- Generic multi-agent "orchestration hub" naming, saturated to parody in this field — "mission control" is the retained, specific term.
- Marketing gloss anywhere in the product.
