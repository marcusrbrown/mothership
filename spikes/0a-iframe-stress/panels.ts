// Spike 0a (U0.2): panel content-renderer factories for the vanilla
// `createDockview` (dockview-core) API.
//
// NOTE (dockview 7.0.2 API deviation): this repo's installed `dockview`
// package (^7.0.2) is core-only — `export * from 'dockview-core'` with no
// React bindings bundled (no `DockviewReact` component, no `dockview-react`
// package present in node_modules/package.json). There is no `dockview-react`
// dependency installed. Rather than add one (out of scope: don't touch
// package.json), this harness drives the vanilla `createDockview(element,
// options)` entry point directly via `createComponent`, which is the
// framework-agnostic equivalent of a React panel component: a factory
// returning an `IContentRenderer` (`{ element, init, dispose? }`). Behavior
// under test (renderer policy, src=/srcdoc reload characterization, popout,
// split, serialize) is identical either way — this is a rendering-glue
// difference only.
import type {IContentRenderer} from 'dockview-core'

function styledDiv(styles: Partial<CSSStyleDeclaration>): HTMLDivElement {
  const el = document.createElement('div')
  Object.assign(el.style, styles)
  return el
}

/** Panel 1 — `src=` iframe pointed at a Storybook-style dev server placeholder. */
export function createStorybookIframePanel(): IContentRenderer {
  const element = styledDiv({width: '100%', height: '100%', display: 'flex', flexDirection: 'column'})
  const label = styledDiv({
    padding: '4px 8px',
    fontSize: '11px',
    fontFamily: 'monospace',
    color: 'var(--color-text-muted)',
    background: 'var(--color-surface)',
    borderBottom: '1px solid var(--color-border)',
  })
  label.textContent = 'src= iframe: http://localhost:6006 (Storybook placeholder — any localhost dev server)'
  const iframe = document.createElement('iframe')
  iframe.src = 'http://localhost:6006'
  iframe.style.flex = '1'
  iframe.style.border = 'none'
  iframe.setAttribute('title', 'storybook-placeholder')
  element.append(label, iframe)
  return {element, init() {}}
}

/** Panel 2 — `src=` iframe pointed at the opencode server's own doc page. */
export function createOpencodeDocIframePanel(): IContentRenderer {
  const element = styledDiv({width: '100%', height: '100%', display: 'flex', flexDirection: 'column'})
  const label = styledDiv({
    padding: '4px 8px',
    fontSize: '11px',
    fontFamily: 'monospace',
    color: 'var(--color-text-muted)',
    background: 'var(--color-surface)',
    borderBottom: '1px solid var(--color-border)',
  })
  label.textContent = 'src= iframe: http://localhost:4096/doc (opencode server)'
  const iframe = document.createElement('iframe')
  iframe.src = 'http://localhost:4096/doc'
  iframe.style.flex = '1'
  iframe.style.border = 'none'
  iframe.setAttribute('title', 'opencode-doc')
  element.append(label, iframe)
  return {element, init() {}}
}

/**
 * Panel 3 — sandboxed `srcdoc` iframe (sandbox="allow-scripts") running an
 * animated canvas + counter so a frozen frame is visually obvious to a human
 * tester (canvas stops rotating, counter stops incrementing).
 */
export function createSandboxedSrcdocPanel(): IContentRenderer {
  const element = styledDiv({width: '100%', height: '100%', display: 'flex', flexDirection: 'column'})
  const label = styledDiv({
    padding: '4px 8px',
    fontSize: '11px',
    fontFamily: 'monospace',
    color: 'var(--color-text-muted)',
    background: 'var(--color-surface)',
    borderBottom: '1px solid var(--color-border)',
  })
  label.textContent = 'srcdoc iframe (sandbox="allow-scripts") — should NOT reload on reparent'
  const iframe = document.createElement('iframe')
  iframe.setAttribute('sandbox', 'allow-scripts')
  iframe.style.flex = '1'
  iframe.style.border = 'none'
  iframe.setAttribute('title', 'sandboxed-srcdoc')
  iframe.srcdoc = `<!doctype html>
<html><head><style>
  html,body{margin:0;background:#16162d;color:#fff;font-family:monospace;height:100%;overflow:hidden}
  #wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:8px}
  canvas{background:#0b0b1a;border-radius:8px}
</style></head>
<body>
<div id="wrap">
  <canvas id="c" width="120" height="120"></canvas>
  <div id="counter">tick: 0</div>
</div>
<script>
  let n = 0;
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  const counterEl = document.getElementById('counter');
  function frame() {
    n++;
    counterEl.textContent = 'tick: ' + n;
    ctx.clearRect(0, 0, 120, 120);
    ctx.save();
    ctx.translate(60, 60);
    ctx.rotate((n % 360) * Math.PI / 180);
    ctx.fillStyle = '#4fd1c5';
    ctx.fillRect(-20, -20, 40, 40);
    ctx.restore();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
</script>
</body></html>`
  element.append(label, iframe)
  return {element, init() {}}
}

/** Plain content panel with a ticking clock — used to spot freezes on the app-shell side. */
export function createClockPanel(id: string): IContentRenderer {
  const element = styledDiv({
    width: '100%',
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'column',
    gap: '8px',
    fontFamily: 'monospace',
    color: 'var(--color-text)',
    background: 'var(--color-bg-mid)',
  })
  const heading = document.createElement('div')
  heading.style.color = 'var(--color-text-secondary)'
  heading.textContent = `Plain panel: ${id}`
  const clock = document.createElement('div')
  clock.style.fontSize = '20px'
  element.append(heading, clock)

  let intervalId: ReturnType<typeof setInterval> | undefined
  return {
    element,
    init() {
      clock.textContent = new Date().toLocaleTimeString()
      intervalId = setInterval(() => {
        clock.textContent = new Date().toLocaleTimeString()
      }, 250)
    },
    dispose() {
      if (intervalId) clearInterval(intervalId)
    },
  }
}

/** Plain content panel — inert filler (panels 5). */
export function createPlainPanel(id: string): IContentRenderer {
  const element = styledDiv({
    width: '100%',
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: 'monospace',
    color: 'var(--color-text)',
    background: 'var(--color-bg-mid)',
  })
  element.textContent = `Plain panel: ${id}`
  return {element, init() {}}
}

const INSTRUCTIONS = `Manual test script (from the plan, U0.2)

Exercise drag/split/tab/close/popout repeatedly across all 6 panels:

1. Drag each panel to a new group (split the layout further).
2. Split panels horizontally and vertically ("Split active right/down"
   buttons, or drag a panel's tab to a group edge).
3. Tab two panels together (drag one panel's tab onto another panel's
   tab strip) — confirm switching tabs doesn't freeze/reload unexpectedly.
4. Close panels, then "Restore last" to bring back the last-serialized
   layout.
5. Popout a group into its own window ("Popout active group") — this
   exercises window.open() under Tauri/WKWebView. If popout windows are
   broken, popout support is cut from the tracer bullet (Marcus's call).
6. Re-dock a popped-out group back into the main window.
7. Run "Run auto-stress" for a scripted 20-iteration stress pass
   (add/move/split/close every ~250ms) and watch memory (Activity Monitor)
   before/during/after, plus the stats bar's op counter and heap reading.

WHAT TO WATCH FOR:

- src= iframes (panels 1 and 2) are EXPECTED to reload on reparent —
  this is the known dockview #162 issue (iframe content is torn down and
  recreated when the DOM node is moved across groups/tabs/popouts). Confirm
  this actually happens; note if it does NOT (would be a pleasant surprise).
- The srcdoc iframe (panel 3) is NOT expected to reload — the rotating
  square + tick counter should keep animating continuously through every
  drag/split/tab/popout operation. If it resets to tick 0, that's a
  regression from the sandbox posture, not from src= semantics.
- Frozen frames: after any re-dock, does the iframe/canvas content resume
  immediately, or does it stay frozen (visually check the srcdoc canvas
  and the clock panel's ticking).
- Memory: does closing panels return the JS heap to something close to
  its pre-open baseline (Chrome/WKWebView heap counter in the stats bar,
  or Activity Monitor's real memory for the whole process if heap
  isn't exposed).

Exit criteria (plan): no crashes, no frozen frames after re-dock, memory
returns to a sane baseline after closing panels. If it fails: STOP —
single-webview-iframe vs Electron fallback is Marcus's call.`

/** Panel 6 — the manual test instructions, rendered as plain text. */
export function createInstructionsPanel(): IContentRenderer {
  const element = styledDiv({
    width: '100%',
    height: '100%',
    overflowY: 'auto',
    padding: '12px',
    fontFamily: 'monospace',
    fontSize: '12px',
    whiteSpace: 'pre-wrap',
    color: 'var(--color-text)',
    background: 'var(--color-surface)',
    boxSizing: 'border-box',
  })
  element.textContent = INSTRUCTIONS
  return {element, init() {}}
}
