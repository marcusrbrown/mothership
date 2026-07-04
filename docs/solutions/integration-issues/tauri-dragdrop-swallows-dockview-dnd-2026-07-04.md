---
title: Tauri native drag-drop swallows dockview HTML5 DnD
date: 2026-07-04
category: integration-issues
module: spikes
problem_type: integration_issue
component: tooling
symptoms:
  - "Dragged dockview tabs attach to cursor with a + indicator but never dock"
  - "No drop-target overlays appear during drag despite drag initiating"
  - "dockview addPopoutGroup resolves false; popout windows never open"
root_cause: config_error
resolution_type: config_change
severity: high
related_components: [dockview, wkwebview, tauri-window-config]
tags: [tauri, wkwebview, dockview, drag-drop, iframe, spike-0a]
---

# Tauri native drag-drop swallows dockview HTML5 DnD

## Problem

Spike 0a (webview/iframe stress — the Tauri single-webview bet for Mothership's
dockview panel chassis) found drag/dock completely non-functional in the real
Tauri window: panels could be grabbed but never docked anywhere. Popout windows
also failed universally.

## Symptoms

- A dragged tab follows the cursor with a `+` indicator, but no dock zones
  render and dropping does nothing.
- `addPopoutGroup()` resolves `false` on every attempt (dockview 7 reports
  popout failure as a resolved boolean, not a thrown error).
- No crashes, no frozen frames — drag alone is dead.

## What Didn't Work

- Suspecting the harness (wrong window styles / missing dockview core CSS):
  the harness imports `dockview/dist/styles/dockview.css` and a `--dv-*` theme
  class correctly — CSS was not the cause.
- Suspecting a WKWebView platform limitation: WKWebView supports HTML5 DnD;
  this is not a platform gap.

## Solution

Tauri v2 enables a **native drag-drop handler on the webview by default**,
which intercepts and swallows the HTML5 `dragover`/`drop` events dockview's
DnD depends on. Disable it in the window config:

```json
// src-tauri/tauri.conf.json → app.windows[0]
{
  "title": "Mothership",
  "width": 1440,
  "height": 900,
  "dragDropEnabled": false
}
```

Native file-drop is unused in the tracer, so nothing is lost. Fix committed as
`b94d238`.

**Popout is a separate limitation and is cut from the tracer**: dockview popout
uses `window.open`, which Tauri WKWebView blocks by default. No acceptance
example depends on popout; revisiting would mean Tauri's native window-creation
API, not `window.open`.

## Why This Works

Tauri's native DnD handler sits between the OS and the webview DOM. With it
enabled, drag events are consumed for the native file-drop pipeline
(`onDragDropEvent`) and never reach the page as HTML5 drag events — dockview
sees `dragstart` (drag initiates, cursor badge appears) but never receives the
`dragover`/`drop` stream needed to render dock targets and complete the
gesture. `dragDropEnabled: false` hands the whole event stream back to the DOM.

## Prevention

- Keep `dragDropEnabled: false` as long as any panel chassis relies on HTML5
  DnD; if native file-drop is ever needed, it must be scoped to a separate
  webview/window, not the dockview shell.
- Re-check on Tauri major upgrades — the default and the interception scope
  have changed between versions.
- Popout support requires Tauri window APIs; treat any `window.open`-based
  library feature as unavailable under Tauri by default.

## Spike verification record

Interactive run (macOS WKWebView, Tauri v2, 1440×900, opencode
v1.17.13+harness.ee55e157 on `127.0.0.1:4096`):

- Memory: ~42MB WebContent baseline → ~420MB settled after scenarios (380–450MB
  hover), no unbounded growth.
- No crashes, no frozen frames across either run.
- Re-run after the `dragDropEnabled` fix: **drag/dock works**. Caveat worth
  keeping: edge drag-splits are finicky — occasionally a tab group had to be
  split before a drag-split would register; dragging tabs onto/around the tab
  strip is reliable and positions on any side. Treat tab-strip drops as the
  dependable gesture; edge-split hit zones as best-effort (dockview hit-zone
  sizing, not a platform issue).
- STOP-gate status: **CLEARED** — the single-webview dockview bet holds on
  WKWebView. Popout remains cut (window.open blocked).

dockview 7.0.2 API notes (vs 6.x expectations): `dockview` npm package is now
core-only (`export * from 'dockview-core'`); React bindings live in the
separate `dockview-react` package — U1.1 must add it explicitly. `moveTo`
takes `Position` (`'center'` etc.), not `Direction` (`'within'` etc.) used by
`addPanel`. Theming is `className` + `--dv-*` CSS vars. `renderer:
'onlyWhenVisible'` is a top-level `AddPanelOptions` field.

DX note: Tauri ships no reload accelerator — dev-only Cmd+R (reload) and
Cmd+Shift+H (launcher) handlers were added to `src/main.tsx`.

## Related Issues

- dockview #162 (`src=` iframes reload on DOM reparent — expected behavior to
  characterize on re-run)
- Harness: `spikes/0a-iframe-stress/`
- Plan: `docs/plans/2026-07-04-001-feat-mothership-tracer-bullet-plan.md` (U0.2)
