---
module: spikes
tags: [tauri, wkwebview, dockview, iframe]
problem_type: platform-derisk
---

# Spike 0a: webview/iframe stress (STOP gate)

## What's being proven

The Tauri single-webview bet for the whole app: can a `dockview` layout host
live iframes as first-class panels — dragged, split, tabbed, closed, popped
out, re-docked — without crashing the webview, freezing frames, or leaking
memory? If this fails, single-webview-iframe is cut in favor of an Electron
(or multi-webview) fallback — **Marcus's call**, not an automatic pivot.

## Harness design

`spikes/0a-iframe-stress/`:

- `panels.ts` — content-renderer factories (one per panel type):
  1. `createStorybookIframePanel` — `src=` iframe at `http://localhost:6006`
     (Storybook placeholder; label makes clear it's "any localhost dev
     server", not a real Storybook instance in this spike).
  2. `createOpencodeDocIframePanel` — `src=` iframe at
     `http://localhost:4096/doc` (opencode server's own doc page).
  3. `createSandboxedSrcdocPanel` — `srcdoc` iframe with
     `sandbox="allow-scripts"`: a rotating-square `<canvas>` + tick counter
     driven by `requestAnimationFrame`, so a frozen frame or a reset-to-0
     counter is immediately visible to a human tester without instrumentation.
  4. `createClockPanel` — plain panel with a `setInterval` clock (250ms) to
     spot app-shell-side freezes independent of any iframe.
  5. `createPlainPanel` — inert filler panel.
  6. `createInstructionsPanel` — renders the manual test script (below) as
     on-screen text.
- `theme.css` — minimal `--dv-*` variable remap onto `tokens.css`
  (background/surface/text only, per the spike-not-product-UI instruction).
- `index.tsx` — wires `createDockview` (see API deviation note below), seeds
  all 6 panels, control strip, stats bar, and a 30-entry event log.

### Policy under test: `renderer: 'onlyWhenVisible'`

All three iframe-hosting panels (`panel-storybook`, `panel-opencode-doc`,
`panel-sandboxed`) are added with `renderer: 'onlyWhenVisible'` — dockview's
policy for what happens to a panel's DOM when it's hidden (e.g. an inactive
tab). This is the setting we're characterizing, not just enabling: does an
iframe under this policy get detached/reattached across tab switches (extra
reloads on top of the reparent-reload issue below), or does it stay resident
and only toggle visibility? The event log + manual instructions panel call
out what to watch for.

### `src=` vs `srcdoc` reload-on-reparent

Per the plan and known dockview issue **#162**: moving a panel's DOM node
across groups/tabs/windows (drag, split, popout) can force browsers to tear
down and recreate `src=` iframe content (a fresh navigation), because the
iframe's browsing context isn't preserved across a DOM reparent in most
engines. The two `src=` panels are **expected** to reload on reparent — the
manual script asks the tester to confirm this actually happens (and flag it
as a pleasant surprise if it doesn't). The `srcdoc` panel is **not** expected
to reload, because `srcdoc` content is set once as an attribute rather than
fetched via navigation; the rotating canvas + tick counter should keep
animating uninterrupted through every drag/split/tab/popout. If the srcdoc
counter resets to 0, that's a regression worth flagging distinctly from the
expected `src=` behavior.

### Control strip / stats / event log

Buttons: Add panel, Close panel, Split active right, Split active down,
Popout active group, Serialize→console, Restore last, Run auto-stress.
`Run auto-stress` drives 20 scripted iterations (add / move / split / close,
cycling through those four ops) with a 250ms gap between each, logging every
op — this is the repeatable stress pass to run while watching Activity
Monitor for memory growth, independent of manual dragging.

Stats bar: live panel count (from `api.panels.length`), JS heap via
`performance.memory` (Chrome-only — shows `n/a` under WKWebView, which has no
such API), a running op counter, and the label of the last op. The event log
keeps the last 30 ops with timestamps so a screenshot is enough evidence for
a human reviewer.

## dockview 7.0.2 API deviations from the plan/6.x expectations

- **No `dockview-react` package is installed.** The repo's `dockview@7.0.2`
  dependency (`node_modules/dockview`) is core-only: its entire `index.d.ts`
  is `export * from 'dockview-core'` — no `DockviewReact` component, no
  `IDockviewReactProps`, nothing React-specific. Historically (6.x)
  `dockview-react` was a separate package with those bindings; that package
  is **not** a dependency here (confirmed via `package.json` / `bun.lock` —
  only `dockview` and its `dockview-core` transitive dep are present). Adding
  `dockview-react` was out of scope for this dispatch (package.json is
  off-limits). The harness instead drives the framework-agnostic
  `createDockview(element, options)` entry point from `dockview-core`
  directly, with panel content provided via the `createComponent` factory
  option (returns an `IContentRenderer`: `{ element, init, dispose? }`).
  This is a rendering-glue difference only — the policy under test
  (`renderer: 'onlyWhenVisible'`), the `src=`/`srcdoc` reload
  characterization, and the popout/split/serialize APIs are identical
  regardless of the React wrapper. **If the tracer bullet build (U1.1) wants
  React-idiomatic dockview panels, it needs to either add `dockview-react`
  as a dependency or keep using this vanilla-JS pattern** — worth an
  explicit decision before U1.1, not an assumption.
- **`renderer` is a top-level `AddPanelOptions` field**, not nested — matches
  the plan's expectation (`renderer: 'onlyWhenVisible'` passed directly to
  `api.addPanel({...})`).
- **`moveTo` position values are `Position` (`'top' | 'bottom' | 'left' |
  'right' | 'center'`)**, not `Direction` (`'left' | 'right' | 'above' |
  'below' | 'within'`) which is used for `addPanel`'s `position.direction`.
  These are two distinct types in different option shapes — `'within'` (used
  for split/add placement) is not valid for `moveTo` (use `'center'`
  instead). Easy to conflate; the auto-stress "move" op hit this during
  implementation.
- **`addPopoutGroup(item, options?)` returns `Promise<boolean>`** — success
  is a resolved boolean, not a thrown error on failure. The harness awaits it
  and logs `opened` / `failed (window.open blocked?)` accordingly, since a
  `window.open()` popup blocked by WKWebView would surface as `false` here,
  not an exception.
- **Theming is `className` + CSS variables**, not a JS theme object override
  — `theme.css` sets a `.dockview-theme-mothership-spike` class (passed via
  `createDockview(..., {className: ...})`) that redefines a handful of
  `--dv-*` vars against `tokens.css`. `DockviewTheme` objects
  (`themeDark`/`themeAbyss`/etc.) exist but are opt-in presets, not the
  extension point used here.

## Exit criteria (from plan)

- [ ] No crashes
- [ ] No frozen frames after re-dock
- [ ] Memory returns to a sane baseline after closing panels

All three require the interactive run below — this spike is verified
headlessly (`tsc` clean; no dedicated test framework applies to a throwaway
visual harness) but not yet exercised inside the real Tauri window.

## Findings (interactive run)

Environment: macOS WKWebView, Tauri v2.x window (1440x900), opencode server
v1.17.13+harness.ee55e157 on `127.0.0.1:4096`.

- **Memory**: ~42MB WebContent baseline at launch, settling to ~420MB after
  running through the stress scenarios (hover spikes 380–450MB peak). Caveat:
  drag/dock was broken during this run (see below), so stress coverage was
  partial — these numbers should be refreshed on the re-run after the
  drag-drop fix.
- **Drag/dock**: FAILED on first run — a dragged tab attached to the cursor
  with a `+` indicator but never docked anywhere. Root cause, diagnosed after
  the run: this is **not** a harness bug and **not** a WKWebView limitation.
  Tauri v2's native drag-drop handler is enabled by default on the webview
  and swallows the HTML5 `dragover`/`drop` events that dockview's DnD depends
  on. Fix applied: `"dragDropEnabled": false` in `tauri.conf.json`'s window
  config (native file-drop is unused in the tracer). Status: fix committed
  (b94d238); drag re-verification is PENDING a second interactive window run.
- **Popout**: all attempts failed — `window.open` is blocked under Tauri
  WKWebView by default, and dockview's `addPopoutGroup` resolved `false`
  every time. Decision per the plan's risk table: popout is **cut** from the
  tracer — no acceptance example depends on it. Revisit only if a real need
  appears later; it would require Tauri's native window-creation API instead
  of `window.open`.
- No crashes, no frozen frames observed at any point in this run.
- `srcdoc`/`src=` iframe reload behavior on reparent: **not yet observed** —
  drag was broken, so no reparent ever occurred. Pending re-run.
- DX note: Cmd+R does not reload a Tauri window by default (no reload
  accelerator wired up). Added dev-only Cmd+R / Cmd+Shift+H handlers to
  `src/main.tsx` so spike-hopping doesn't require quitting/relaunching the
  app.

**Verdict**: STOP gate **NOT YET CLEARED** — pending drag re-verification
after the `dragDropEnabled` fix. No evidence so far of the platform-level
instability the gate guards against (no crashes, no frozen frames, no
unbounded memory growth).
