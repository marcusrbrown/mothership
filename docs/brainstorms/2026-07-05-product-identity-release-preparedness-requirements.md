---
date: 2026-07-05
topic: product-identity-release-preparedness
---

# Product Identity & Release Preparedness

## Summary

Establish Mothership's public identity — an agent-native shell for designing, ideating, experimenting, and building with agents, with OpenCode as the first backend rather than the headline — and bring the repository to release grade: product-voice docs for humans and agents, org-standard automation and security posture, a Changesets-driven signed-macOS release pipeline, and an objective v0.1 launch checklist. This is an epic; it decomposes into multiple plans.

---

## Problem Frame

The tracer merged (PR #1): the architecture is proven live, all three acceptance flows work against a real workspace. But the repository still reads as an internal experiment — an operational README, no architecture or structure documentation, no security or automation workflows beyond CI, no release pipeline, no packaged artifact, and no stated positioning.

The window is real. Between October 2025 and May 2026 every major vendor shipped an agent "manager surface" (Cursor 3 Agents Window, Claude Code agent view, the Codex app, Zed Parallel Agents), validating the category — but each is a walled garden for its own harness. The open-harness side has no serious multi-project workspace: OpenCode's official web UI is explicitly immature and the community substitutes are thin chat UIs that keep churning. Meanwhile the field's naming is saturating into parody ("fleet"-everything), and indie *cloud* orchestration already lost to first-party clouds (Terragon shut down Feb 2026; local-first tools thrive).

Mothership's identity has also been undersold internally. Managing OpenCode sessions is the vehicle, not the purpose; positioning it as "an OpenCode UI" caps the product at someone else's ecosystem.

---

## Actors

- A1. Marcus — owner, operator, sole maintainer; runs the real workspace that defines the daily-driver bar.
- A2. Workspace agents — Fro Bot and delegated agents acting in CI (PR review, @mention responses, dispatched cloud tasks) and inside the app via `ide_*` tools.
- A3. Early adopters — OpenCode power users and the agentic-CLI crowd; first external audience for the signed v0.1.
- A4. Downstream doc consumers — planning agents and Magic Context sessions that onboard from ARCHITECTURE.md / STRUCTURE.md / AGENTS.md, and humans reading the same files.

*Key Flows omitted: this epic produces artifacts, policy, and pipelines rather than user-facing interaction flows; Requirements, Acceptance Examples, and Scope Boundaries below bound the work without inventing paths.*

---

## Requirements

**Positioning & brand**

- R1. Refresh `PRODUCT.md` into the positioning source of truth, two-layer: public copy leads with what the current release verifiably is (mission control for your agents — local-first, prompt-anywhere) and names the agent-native shell (design, ideate, experiment, and build with agents) as the explicit trajectory. Unshipped capabilities are framed as roadmap, never present tense. OpenCode conventions (sessions, projects) stay primary in the app, but OpenCode appears in architecture docs only — the app is the sell; the backend is the vehicle.
- R2. Codify brand voice alongside the retained Systematic lineage skin: confident and technical, falsifiable claims over slogans (e.g. "no telemetry, all traffic to 127.0.0.1 — check the source" instead of bare "local-first"). "Mission control" is approved vocabulary; "fleet" is banned in public copy. Public posture claims are backed by a machine-checkable guard (CI check or test) so they cannot silently rot.
- R3. Declare open-core intent publicly: the app and everything currently shipped is free and open; the commercial line is deliberately undesignated pending market research. Panel types and `ide_*` tools are never paywalled.
- R4. Naming due diligence for "Mothership": trademark class search, domain and handle audit, collision assessment — run first in the epic, before further brand hardening (site, announcements), producing a go/adjust decision well ahead of v0.1.
- R5. Capture the signature demo as a first-class asset: an agent rearranging the layout via `ide_*` tools mid-task while another agent's session streams beside it — used in the README and landing page.

**Docs for humans and agents**

- R6. Rewrite `README.md` in product voice: positioning line up top, demo/screenshot, install, quickstart; operational depth moves to the docs set.
- R7. Author `ARCHITECTURE.md`: the invariant-bearing design — renderer-over-a-bus (no owned agent state), no embedded LLM, localhost boundary and credential posture, the `ide_*` sidecar security model, and the hybrid live-data model — with the *why* for each.
- R8. Author `STRUCTURE.md`: directory map, module responsibilities, and the panel design-for-deletion contract, written to be consumed by agents (Magic Context) and humans onboarding cold.
- R9. Refresh `AGENTS.md` to stay the ops contract: verification gates and invariants by reference to ARCHITECTURE.md/STRUCTURE.md instead of duplication.
- R10. Add community files: LICENSE (permissive, per open-core ruling), CONTRIBUTING.md, SECURITY.md, and minimal issue/PR templates.

**Repo automation & security posture**

- R11. Wire Fro Bot per the space-bus model: PR review, @fro-bot mention handling in comments, and scheduled/dispatched cloud tasks — with default-ref checkout (never PR-head in secret-bearing runs), mention gating, tight concurrency, and a pinned agent version. Comment- and PR-triggered runs execute only for trusted authors; fork PRs never reach secrets — untrusted input is handled in a no-secrets job.
- R12. Wire Renovate to the shared org preset with post-upgrade install/build tasks and no broad automerge for GitHub Actions.
- R13. Add the security posture set: OpenSSF Scorecard, CodeQL, dependency-review, and settings-as-code (branch protection, strict checks, linear history) managed by workflow.

**Release infrastructure**

- R14. Adopt Changesets for versioning and changelog on a ship-when-ready 0.x cadence.
- R15. Build the macOS release pipeline: signed and notarized DMG (Developer ID), Tauri updater feed, GitHub Releases — release workflow gated on green CI plus explicit human approval (protected tag or manual dispatch). Signing identities (Developer ID, notarization, updater key) live in environment-scoped CI secrets with documented custody and rotation, unreachable from agent-driven automation; releases attach build provenance and checksums, and the updater accepts only signed update metadata.
- R16. Produce the v0.1 release checklist as an artifact: reliability track green (the daily-driver bar), docs set complete, release pipeline proven end-to-end, naming diligence resolved, landing page live. The checklist is a living artifact on a standing burn-down rhythm — working sessions end by updating it, and an empty checklist is the release trigger.

**Public face**

- R17. Ship a single-page product site (domain from R4): positioning line, demo clip, download, docs link — plus GitHub polish (social preview image, topics, repo description).

**Roadmap capture**

- R18. Record a roadmap doc listing candidate next epics without prioritizing them: the field's table-stakes gaps (diff review UI, attention routing and notifications, per-session branch/worktree surfacing, cost/usage passthrough, remote access story) and the vision surfaces (Notion-like plan editor with immediate AI feedback, in-app code editing, automation-flow connectors such as n8n, MCP servers providing UIs, Mothership's own MCP connector).

---

## Acceptance Examples

- AE1. **Covers R11.** Given a PR is opened by a trusted author, when CI runs, Fro Bot reviews it; given a comment mentions @fro-bot, when the author association is trusted, the agent responds in-thread — and comment-driven runs never check out PR-head code with secrets present.
- AE2. **Covers R14, R15.** Given merged changesets exist on main, when a release is cut, the pipeline produces a version bump, changelog, signed+notarized DMG, GitHub Release, and an updater feed the installed app accepts.
- AE3. **Covers R16.** Given any checklist item is unmet (e.g. the reliability track is red), when a v0.1 release is proposed, the checklist blocks it — the release bar is objective, not vibes.
- AE4. **Covers R1, R6.** Given a stranger lands on the README or product page, when they read for sixty seconds, they can say what Mothership is today (mission control for their agents), where it is going (an agent-native shell for building with agents), what it is not (not an editor, not a cloud service), and how to install it — without encountering "OpenCode UI" as the identity.

---

## Success Criteria

- The repo reads as a product: positioning, docs, security posture, and releases indistinguishable in rigor from the org's mature repos (space-bus as the reference).
- A signed DMG installs and updates cleanly on a Mac that has never seen the dev environment.
- An agent session (Magic Context) can onboard from ARCHITECTURE.md + STRUCTURE.md + AGENTS.md without spelunking source to learn the invariants.
- The v0.1 gate is objective: every item on the release checklist is checkable, and the daily-driver bar is demonstrated by sustained real-workspace use, not a demo run.
- Positioning survives contact: early adopters describe Mothership in its own terms ("agent-native shell", "mission control") rather than "an OpenCode frontend".

---

## Scope Boundaries

### Deferred for later

- Designating the open-core commercial line (needs dedicated market research; research signal so far: hosted/remote convenience sells, capability gating breeds forks).
- The rebrand decision — gated before any paid tier exists, not before v0.1.
- Linux and Windows distribution.
- A full documentation site (guides beyond the in-repo docs set).
- The table-stakes feature epics (diff review UI, attention routing, worktree surfacing, cost passthrough, remote access) and the vision surfaces (plan editor, code editing, automation connectors, MCP-App UIs, own MCP connector) — R18 records them; they are the next epics.
- The reliability track (notes #209/#210/#213) — release-blocking via R16, but planned and executed as its own stream.

### Outside this product's identity

- Cloud-hosted orchestration as the product — the local app is the product; any future cloud is an optional accessory (the Terragon lesson).
- An embedded LLM in the app — Mothership never calls a model; intelligence lives in the agents it renders.
- Owning agent/session state — the server/bus owns state; Mothership stays a renderer.
- Enterprise governance/compliance tooling (audit-as-product, policy engines) — the field's crowded, venture-shaped corner.

---

## Key Decisions

- Product identity drives preparedness (B drives A): infra, docs, and release choices derive from what Mothership is becoming — nothing gets built twice.
- Standalone product with commercial intent: OpenCode is the first backend, the vehicle — not the identity.
- Open-core from day one, line undesignated: declare intent, defer designation until research shows where value concentrates.
- Lineage brand now, rebrand gate later: ship v0.1 in the Systematic skin; explicit brand decision before any paid tier.
- macOS-only signed releases: one platform done properly (signing, notarization, updater); breadth follows demand.
- Daily-driver release bar: reliability is the release criterion; feature scope stays tracer-sized.
- Ship-when-ready 0.x on Changesets: cadence emerges from progress, not calendar.
- Name committed pending diligence: "Mothership" stands unless R4 surfaces disqualifying exposure.
- "Fleet" banned from public copy: saturated to parody in this field; "mission control" retained.
- Compete on architecture, not features: renderer-over-a-bus + no-embedded-LLM + agent-drivable layout is the defensible stance; feature races against first-party vendors are unwinnable solo.
- Preparedness before table-stakes features: this epic exists to make the v0.1 release credible and legible, not to defer product work — the field's table-stakes gaps (R18) are the immediate next epics after it.
- Two-layer positioning: copy leads with the shipped mission-control reality; the agent-native shell is the named trajectory — unshipped capabilities never read present tense.
- OpenCode is the vehicle, not the sell: it appears in architecture docs only; traction in that community comes from being built on it, not from marketing it.
- Checklist burn-down over deadlines: convergence pressure comes from a standing rhythm on the release checklist — empty checklist is the release trigger.

---

## Dependencies / Assumptions

- The reliability track (#209/#210/#213 and ce:review residuals) is planned separately and gates R16.
- Apple Developer ID membership, signing certificates, and notarization credentials must be provisioned for R15.
- Fro Bot wiring (R11) needs repo secrets (PAT, opencode auth/config) and the pinned agent version per org convention.
- space-bus remains the bus layer; its release flow (Changesets, trusted publishing) is the working reference for R14/R15.
- Landing page (R17) assumes the domain outcome of R4.
- The signature demo (R5) depends on live-workspace reliability from the reliability track — it is captured after that track is green.

---

## Outstanding Questions

### Resolve Before Planning

- [Affects R10][User decision] Which permissive license for the open core — MIT or Apache-2.0? (Apache's patent grant is the usual open-core choice; org precedent is MIT.)
- [Affects R10][User decision] Contributor-rights posture before external contributions accumulate — DCO, CLA, or neither. External contributions under a permissive license with no rights agreement make any later open-core line materially harder to draw.

### Deferred to Planning

- [Affects R4][Needs research] Trademark/domain/handle findings for "Mothership" and the go/adjust call.
- [Affects R15][Technical] Updater feed shape and hosting (GitHub Releases asset vs static endpoint), and CI secrets handling for signing identities.
- [Affects R17][Technical] Landing page stack and hosting.
- [Affects R11][Technical] Which Fro Bot triggers to enable at v0.1 (review + mentions certain; schedule/dispatch scope to confirm), the workflow topology (which workflows exist; what runs on PRs vs comments vs schedule), and the secrets provisioning model (PAT, opencode auth/config).
- [Affects R13][Technical] Settings-as-code ownership: which repo-admin surfaces (branch protection, required checks, merge strategy) are automatable from this repo, and what the update workflow needs.
- [Affects R14][Technical] Changesets adaptation for a non-published desktop app: how version bumps map to Tauri bundle versioning and GitHub Releases with no npm publish step.

---

## Sources / Research

- Org-convention survey (this session): canonical reference files — `fro-bot/space-bus/.github/workflows/{ci,fro-bot,release,update-repo-settings}.yaml`, `.github/renovate.json5`, `.github/settings.yml`; `bfra-me/works` and `marcusrbrown/infra` equivalents for reusable Renovate/release patterns.
- Market landscape (July 2026, this session): category validated by first-party manager surfaces (Cursor 3, Claude Code agent view, Codex app, Zed Parallel Agents); open-harness niche unheld (OpenCode web UI immature, community UIs churning); Terragon's shutdown as the indie-cloud cautionary tale; differentiation = agent-drivable layout via MCP, renderer-over-a-bus, multi-project workspace, no-embedded-LLM, auditable localhost posture; table-stakes gaps = diff review, worktree surfacing, attention routing, cost passthrough, remote access. Key refs: openai.com/index/introducing-the-codex-app, zed.dev/blog/parallel-agents, code.claude.com/docs/en/agent-view, opencode.ai/docs/web, conductor.build, orbitdock.dev, addyo.substack.com/p/death-of-the-ide.
- Requirements contract for the tracer: `docs/brainstorms/2026-07-03-workspace-mission-control-requirements.md` (R1–R15 remain the app-behavior contract; this epic does not amend them).
