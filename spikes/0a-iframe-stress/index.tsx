/**
 * Spike 0a (U0.2): webview/iframe stress harness — STOP gate.
 *
 * Proves (or disproves) the Tauri single-webview bet: a dockview layout with
 * >=6 panels, three of them live iframes (two `src=`, one sandboxed
 * `srcdoc`), survives real drag/split/tab/close/popout manipulation without
 * crashing, freezing, or leaking memory.
 *
 * NOT WIRED INTO THE APP SHELL: this dispatch owns `spikes/` and
 * `docs/solutions/` only. `src/main.tsx` already has a spike loader
 * (`?spike=<id>` mounts the matching `spikes/<id>-.../index.tsx`) — run with:
 *
 *   bun run dev
 *   open http://localhost:<vite-port>/?spike=0a
 *
 * See docs/solutions/2026-07-04-spike-0a-iframe-stress.md for the harness
 * design writeup, the policy under test, and exit criteria.
 */
import 'dockview/dist/styles/dockview.css'
import './theme.css'

import {type DockviewApi, type IDockviewPanel, createDockview} from 'dockview-core'
import {useEffect, useRef, useState} from 'react'
import {
  createClockPanel,
  createInstructionsPanel,
  createOpencodeDocIframePanel,
  createPlainPanel,
  createSandboxedSrcdocPanel,
  createStorybookIframePanel,
} from './panels'

const COMPONENT_STORYBOOK = 'storybook-iframe'
const COMPONENT_OPENCODE_DOC = 'opencode-doc-iframe'
const COMPONENT_SANDBOXED = 'sandboxed-srcdoc'
const COMPONENT_CLOCK = 'clock'
const COMPONENT_PLAIN = 'plain'
const COMPONENT_INSTRUCTIONS = 'instructions'

// Iframe-hosting components (COMPONENT_STORYBOOK, COMPONENT_OPENCODE_DOC,
// COMPONENT_SANDBOXED) get `renderer: 'onlyWhenVisible'` where they're
// added via `api.addPanel` below — the policy under test.

interface LogEntry {
  at: string
  label: string
}

let plainPanelCounter = 0

export default function Spike0aIframeStress() {
  const containerRef = useRef<HTMLDivElement>(null)
  const apiRef = useRef<DockviewApi | null>(null)
  const lastLayoutRef = useRef<unknown>(null)

  const [panelCount, setPanelCount] = useState(0)
  const [opCount, setOpCount] = useState(0)
  const [lastOp, setLastOp] = useState('(none)')
  const [heapLabel, setHeapLabel] = useState('n/a')
  const [log, setLog] = useState<LogEntry[]>([])
  const [autoStressRunning, setAutoStressRunning] = useState(false)

  function recordOp(label: string) {
    setOpCount(c => c + 1)
    setLastOp(label)
    setLog(prev => [...prev.slice(-29), {at: new Date().toLocaleTimeString(), label}])
    console.log(`[spike-0a] ${label}`)
  }

  function refreshPanelCount() {
    const api = apiRef.current
    if (api) setPanelCount(api.panels.length)
  }

  useEffect(() => {
    if (!containerRef.current) return

    const api = createDockview(containerRef.current, {
      className: 'dockview-theme-mothership-spike',
      createComponent: options => {
        switch (options.name) {
          case COMPONENT_STORYBOOK:
            return createStorybookIframePanel()
          case COMPONENT_OPENCODE_DOC:
            return createOpencodeDocIframePanel()
          case COMPONENT_SANDBOXED:
            return createSandboxedSrcdocPanel()
          case COMPONENT_CLOCK:
            return createClockPanel(options.id)
          case COMPONENT_INSTRUCTIONS:
            return createInstructionsPanel()
          default:
            return createPlainPanel(options.id)
        }
      },
    })
    apiRef.current = api

    const disposables = [
      api.onDidAddPanel(panel => recordOp(`add panel: ${panel.id}`)),
      api.onDidRemovePanel(panel => recordOp(`remove panel: ${panel.id}`)),
      api.onDidMovePanel(evt => recordOp(`move panel: ${evt.panel.id}`)),
      api.onDidActivePanelChange(evt => {
        if (evt.panel) recordOp(`activate panel: ${evt.panel.id}`)
      }),
      api.onDidLayoutChange(() => refreshPanelCount()),
    ]

    // Seed the 6 required panels. Iframe-hosting panels get
    // renderer: 'onlyWhenVisible' — the policy under test.
    api.addPanel({
      id: 'panel-storybook',
      component: COMPONENT_STORYBOOK,
      title: '1. Storybook (src=)',
      renderer: 'onlyWhenVisible',
    })
    api.addPanel({
      id: 'panel-opencode-doc',
      component: COMPONENT_OPENCODE_DOC,
      title: '2. opencode /doc (src=)',
      renderer: 'onlyWhenVisible',
      position: {direction: 'right', referencePanel: 'panel-storybook'},
    })
    api.addPanel({
      id: 'panel-sandboxed',
      component: COMPONENT_SANDBOXED,
      title: '3. sandboxed srcdoc',
      renderer: 'onlyWhenVisible',
      position: {direction: 'below', referencePanel: 'panel-storybook'},
    })
    api.addPanel({
      id: 'panel-clock',
      component: COMPONENT_CLOCK,
      title: '4. clock',
      position: {direction: 'below', referencePanel: 'panel-opencode-doc'},
    })
    api.addPanel({
      id: 'panel-plain-5',
      component: COMPONENT_PLAIN,
      title: '5. plain',
      position: {direction: 'within', referencePanel: 'panel-clock'},
    })
    api.addPanel({
      id: 'panel-instructions',
      component: COMPONENT_INSTRUCTIONS,
      title: '6. instructions',
      position: {direction: 'right', referencePanel: 'panel-clock'},
    })

    refreshPanelCount()
    recordOp('harness initialized: 6 panels seeded')

    // Chrome-only heap sampling (performance.memory). WKWebView has no such
    // API — show 'n/a' there, per the harness spec.
    const perfWithMemory = performance as Performance & {
      memory?: {usedJSHeapSize: number; totalJSHeapSize: number}
    }
    const heapInterval = setInterval(() => {
      const mem = perfWithMemory.memory
      if (mem) {
        setHeapLabel(`${(mem.usedJSHeapSize / 1048576).toFixed(1)} MB / ${(mem.totalJSHeapSize / 1048576).toFixed(1)} MB`)
      } else {
        setHeapLabel('n/a')
      }
    }, 1000)

    return () => {
      clearInterval(heapInterval)
      for (const d of disposables) d.dispose()
      api.dispose()
      apiRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function addPanel() {
    const api = apiRef.current
    if (!api) return
    plainPanelCounter += 1
    const id = `panel-plain-extra-${plainPanelCounter}`
    api.addPanel({id, component: COMPONENT_PLAIN, title: `extra-${plainPanelCounter}`})
  }

  function closeActivePanel() {
    const api = apiRef.current
    const panel = api?.activePanel
    if (panel) panel.api.close()
  }

  function splitActive(direction: 'right' | 'below') {
    const api = apiRef.current
    const active = api?.activePanel
    if (!api || !active) return
    plainPanelCounter += 1
    const id = `panel-split-${plainPanelCounter}`
    api.addPanel({
      id,
      component: COMPONENT_PLAIN,
      title: `split-${plainPanelCounter}`,
      position: {direction, referencePanel: active.id},
    })
  }

  async function popoutActiveGroup() {
    const api = apiRef.current
    const group = api?.activeGroup
    if (!api || !group) {
      recordOp('popout active group: no active group')
      return
    }
    const ok = await api.addPopoutGroup(group)
    recordOp(`popout active group: ${ok ? 'opened' : 'failed (window.open blocked?)'}`)
  }

  function serializeToConsole() {
    const api = apiRef.current
    if (!api) return
    const json = api.toJSON()
    lastLayoutRef.current = json
    console.log('[spike-0a] serialized layout:', json)
    recordOp('serialize -> console')
  }

  function restoreLast() {
    const api = apiRef.current
    if (!api || !lastLayoutRef.current) {
      recordOp('restore last: nothing serialized yet')
      return
    }
    api.fromJSON(lastLayoutRef.current as Parameters<DockviewApi['fromJSON']>[0])
    recordOp('restore last -> applied')
  }

  async function runAutoStress() {
    const api = apiRef.current
    if (!api || autoStressRunning) return
    setAutoStressRunning(true)
    recordOp('auto-stress: starting 20 iterations')

    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

    for (let i = 0; i < 20; i++) {
      const op = i % 4
      try {
        if (op === 0) {
          plainPanelCounter += 1
          const id = `panel-stress-${plainPanelCounter}`
          api.addPanel({id, component: COMPONENT_PLAIN, title: `stress-${plainPanelCounter}`})
          recordOp(`auto-stress[${i}]: added ${id}`)
        } else if (op === 1) {
          const active = api.activePanel
          if (active) {
            const targetId = active.id === 'panel-clock' ? 'panel-instructions' : 'panel-clock'
            active.api.moveTo({group: api.getPanel(targetId)?.group ?? active.group, position: 'center'})
            recordOp(`auto-stress[${i}]: moved ${active.id} -> ${targetId}`)
          }
        } else if (op === 2) {
          const active = api.activePanel
          if (active) {
            plainPanelCounter += 1
            const id = `panel-stress-split-${plainPanelCounter}`
            api.addPanel({
              id,
              component: COMPONENT_PLAIN,
              title: `stress-split-${plainPanelCounter}`,
              position: {direction: i % 2 === 0 ? 'right' : 'below', referencePanel: active.id},
            })
            recordOp(`auto-stress[${i}]: split -> ${id}`)
          }
        } else {
          const stressPanels: IDockviewPanel[] = api.panels.filter(p => p.id.startsWith('panel-stress'))
          const toClose = stressPanels[stressPanels.length - 1]
          if (toClose) {
            toClose.api.close()
            recordOp(`auto-stress[${i}]: closed ${toClose.id}`)
          } else {
            recordOp(`auto-stress[${i}]: nothing stress-created left to close`)
          }
        }
      } catch (err) {
        recordOp(`auto-stress[${i}]: ERROR ${err instanceof Error ? err.message : String(err)}`)
      }
      await sleep(250)
    }

    recordOp('auto-stress: complete')
    setAutoStressRunning(false)
  }

  const buttonStyle: React.CSSProperties = {
    background: 'var(--color-surface)',
    color: 'var(--color-text)',
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-sm)',
    padding: '4px 10px',
    fontSize: 'var(--text-sm)',
    fontFamily: 'monospace',
    cursor: 'pointer',
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        background: 'var(--color-bg)',
        color: 'var(--color-text)',
        boxSizing: 'border-box',
      }}
    >
      <div style={{display: 'flex', flexDirection: 'column', gap: '4px', padding: '8px', borderBottom: '1px solid var(--color-border)'}}>
        <div style={{display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap'}}>
          <strong style={{color: 'var(--color-text-secondary)', fontFamily: 'monospace'}}>Spike 0a: iframe/webview stress</strong>
          <button type="button" style={buttonStyle} onClick={addPanel}>
            Add panel
          </button>
          <button type="button" style={buttonStyle} onClick={closeActivePanel}>
            Close panel
          </button>
          <button type="button" style={buttonStyle} onClick={() => splitActive('right')}>
            Split active right
          </button>
          <button type="button" style={buttonStyle} onClick={() => splitActive('below')}>
            Split active down
          </button>
          <button type="button" style={buttonStyle} onClick={() => void popoutActiveGroup()}>
            Popout active group
          </button>
          <button type="button" style={buttonStyle} onClick={serializeToConsole}>
            Serialize&rarr;console
          </button>
          <button type="button" style={buttonStyle} onClick={restoreLast}>
            Restore last
          </button>
          <button type="button" style={buttonStyle} onClick={() => void runAutoStress()} disabled={autoStressRunning}>
            {autoStressRunning ? 'Auto-stress running…' : 'Run auto-stress'}
          </button>
        </div>
        <div style={{fontFamily: 'monospace', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)'}}>
          panels: {panelCount} · heap: {heapLabel} · ops: {opCount} · last op: {lastOp}
        </div>
      </div>

      <div style={{flex: 1, minHeight: 0, display: 'flex'}}>
        <div ref={containerRef} style={{flex: 1, minHeight: 0}} />
        <div
          style={{
            width: '280px',
            borderLeft: '1px solid var(--color-border)',
            padding: '8px',
            overflowY: 'auto',
            fontFamily: 'monospace',
            fontSize: 'var(--text-xs)',
            background: 'var(--color-surface)',
          }}
        >
          <div style={{color: 'var(--color-text-secondary)', marginBottom: '4px'}}>Event log (last 30)</div>
          {log.length === 0 && <div style={{color: 'var(--color-text-dim)'}}>no ops yet</div>}
          {log
            .slice()
            .reverse()
            .map((entry, idx) => (
              <div key={`${entry.at}-${idx}`} style={{color: 'var(--color-text-muted)'}}>
                <span style={{color: 'var(--color-text-dim)'}}>{entry.at}</span> {entry.label}
              </div>
            ))}
        </div>
      </div>
    </div>
  )
}
