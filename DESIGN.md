# Design

Mothership's visual system, derived from the Systematic theme. Sources of truth: `design/systematic.theme.json` (palette, from the OpenCode TUI theme) and `design/systematic-banner.svg` (gradient + identity reference). Executable tokens: `design/tokens.css` — imported into the app as `src/styles/tokens.css` during Phase 1 and wired into whatever styling layer the app uses. Components style exclusively from tokens: **no ad-hoc hex, no inline color literals.**

## Aesthetic

Afrofuturism × cyberpunk at mission-control density. Dark-default — the brand lives in the dark. Void-navy layered surfaces, structured geometry, deliberate glow on the focal interactive element only. Light theme exists and preserves contrast pairings; it is an override, not the identity.

## Tokens

- **Surfaces (dark):** `--color-bg` #0b0b1a (void) · `--color-bg-mid` #121b33 · `--color-surface` #16162D (panels) · `--color-surface-raised` #1a1a2e · `--color-element` #2d2d52.
- **Text:** `--color-text` #FFFFFF · `--color-text-secondary` #81E6D9 · `--color-text-muted` #8AA0C2 · `--color-text-dim` #55637C.
- **Accents:** `--color-accent` #4FD1C5 (cyan = action) · `--color-cta` #E91E8C (magenta = emphasis) · `--color-highlight` #F5A623 (orange = highlight/warning).
- **Status:** `--color-success` #63E2A0 · `--color-error` #FF9595 · `--color-warning` #F5A623 · `--color-info` = accent.
- **Borders:** `--color-border` #2d2d52 · `--color-border-active` #4FD1C5 · `--color-border-subtle` #1a1a2e.
- **Diff set** (session diffs and CM6 merge views must use these, both themes): added #63E2A0 on #1B3923 · removed #FF9595 on #3D1B1B · context/muted #8AA0C2 · hunk header/line numbers #55637C. Light: #38A169 on #C6F6D5 · #E53E3E on #FED7D7.
- **Syntax (CM6 theme):** map from `design/systematic.theme.json` `syntax*` keys — keyword magenta, function/type cyan, string/number–constant orange/magenta, variable cyan-light, comment muted.
- **Scale:** 4px spacing base; radius and type scale defined in `design/tokens.css`; motion durations ≤250ms default.

## Color intent (don't blur these)

- **Cyan = action.** Interactive affordances, links, active borders, busy indicators.
- **Magenta = emphasis.** Needs-attention (blocked delegates), CTAs — sparingly.
- **Orange = highlight.** Warnings, badges, working-tree caveats.
- At most two accent colors in a single component. The tri-color banner gradient appears only in identity moments.

## Glow

Reserved for the focal interactive element — the blocked session demanding an answer, the active drop target mid-drag. A glow on every panel is slop; a glow on the one thing that matters is brand. The Impeccable detector's dark-glow and gradient rules stay fully active; intentional exceptions get scoped `impeccable ignores add-value` entries in `.impeccable/config.json`, never rule-wide disables.

## Motion

Purposeful and fast (≤250ms), `prefers-reduced-motion` honored. `--ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1)` is the one sanctioned playful easing (allowlisted in `.impeccable/config.json`); bounce detection stays active for everything else. Layout mutations from `ide_*` tools animate briefly so agent-driven changes are legible to the operator, never teleporting panels.

## Quality gate

`npx impeccable detect` runs over `src/` in CI (`.github/workflows/ci.yaml`, design-check job) and fails on any finding. Use `/impeccable shape` before building a new panel type, `/impeccable critique` / `audit` during a phase, `/impeccable polish` at phase gates. PRODUCT.md and this file are the context those commands read — keep them current instead of re-running `/impeccable init`.
