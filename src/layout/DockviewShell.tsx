import type { DockviewApi } from "dockview-core";
import { DockviewReact, type DockviewReadyEvent } from "dockview-react";
/**
 * DockviewReact wrapper: components sourced from the panel registry,
 * onReady constructs the real adapter + wires the executor, themed via
 * mothership-dockview (dockview-theme.css, tokens only). Seeds the default
 * first-open layout (roster left / sessions+transcript tabbed center /
 * terminal bottom / audit-log drawer) with placeholders — saved layout wins.
 *
 * U1.3: constructs the ONE workspace-wide `/event` SSE connection here (via
 * BusContext) and fans it out through a shared demux + session-store,
 * passed down to roster/sessions/transcript panels via command params.
 * Every (re)connect reconciles per-project state (`listSessions` +
 * `getSessionStatus` + `listQuestions`) — deltas are never trusted across a
 * gap (see docs/solutions/documentation-gaps/opencode-server-sse-contract-facts-2026-07-04.md).
 */
import { useCallback, useEffect, useRef } from "react";
import "./dockview-theme.css";
import type { WorkspaceManifest } from "../detect/manifest";
import { auditStore } from "../panels/audit-log";
import { PromptBar } from "../promptbar";
import { type OpencodeClient, createOpencodeClient } from "../server/client";
import { type Demux, createDemux } from "../server/demux";
import { type SessionStore, createSessionStore } from "../server/session-store";
import { type SseClient, connectSse } from "../server/sse";
import type { BusContext } from "../server/types";
import type { DockviewAdapter } from "./adapter";
import { type LayoutBridge, connectLayoutBridge } from "./bridge";
import { createDockviewAdapter } from "./dockview-adapter";
import { executeCommand, isCommandExecuting } from "./executor";
import { loadLayout, saveLayout } from "./persistence";
import { panelComponents } from "./registry";

export interface DockviewShellProps {
  /** Absolute workspace path — the persistence key. */
  workspacePath: string;
  /** Live BusContext for the roster/sessions panels; absent → those panels
   * render their own config-missing error state (no crash). */
  context?: BusContext;
  /** Per-project detected interfaces (R4/R5/R6) — drives the placeholder
   * tabs seeded per project with a detected interface. Absent/empty →
   * universal panels only (R6). */
  manifest?: WorkspaceManifest;
}

interface LiveWorkspace {
  client: OpencodeClient;
  demux: Demux;
  store: SessionStore;
  sse: SseClient;
}

/** Runs full-state reconciliation for every project in the roster —
 * `listSessions` + `getSessionStatus` + `listQuestions` per directory, fed
 * into `store.reconcile`. Called on every SSE (re)connect. Never trusts
 * deltas across a gap (the `id:`-absent SSE contract fact). */
async function reconcileAll(
  client: OpencodeClient,
  store: SessionStore,
  context: BusContext,
): Promise<void> {
  await Promise.all(
    context.roster.projects.map(async (project) => {
      const directory = project.expandedPath;
      const [sessionsRes, statusRes, questionsRes] = await Promise.all([
        client.listSessions(directory),
        client.getSessionStatus(directory),
        client.listQuestions(directory),
      ]);
      store.reconcile({
        directory,
        sessions: sessionsRes.ok ? sessionsRes.value : [],
        statuses: statusRes.ok ? statusRes.value : undefined,
        questions: questionsRes.ok ? questionsRes.value : undefined,
      });
    }),
  );
}

/** Constructs the one shared client/demux/store/SSE-connection set for the
 * workspace. Exported for tests; DockviewShell wires it via a ref so it
 * survives re-renders and is torn down on unmount. */
export function createLiveWorkspace(context: BusContext): LiveWorkspace {
  const client = createOpencodeClient({
    baseUrl: context.roster.server.baseUrl,
  });
  const demux = createDemux();
  const store = createSessionStore();

  demux.subscribeFirehose((event) => store.applyEvent(event));

  // One connection for the whole workspace: directory-scoped filtering
  // happens per-project during reconcile, not at the SSE connection level.
  const primaryDirectory = context.roster.projects[0]?.expandedPath ?? "";
  const sse = connectSse({
    baseUrl: context.roster.server.baseUrl,
    directory: primaryDirectory,
    onEvent: (event) => demux.dispatch(event),
    onReconcile: () => {
      void reconcileAll(client, store, context);
    },
  });

  return { client, demux, store, sse };
}

/** Seeds a placeholder tab (R5, placeholder-grade — the real Storybook
 * panel lands in Phase 2/AE1) for every project with a detected `storybook`
 * interface. Projects with no detected interfaces add nothing (R6). */
function seedDetectedPanels(
  adapter: DockviewAdapter,
  manifest: WorkspaceManifest | undefined,
): void {
  if (!manifest) return;
  for (const project of manifest.projects) {
    const storybook = project.interfaces.find((i) => i.kind === "storybook");
    if (!storybook) continue;
    executeCommand(
      {
        type: "split",
        panelId: `storybook-${project.projectName}`,
        panelType: "placeholder",
        referencePanelId: "transcript",
        direction: "right",
        title: `Storybook · ${project.projectName}`,
        params: {
          panelType: "storybook",
          label: `Storybook · ${project.projectName}`,
        },
      },
      adapter,
    );
  }
}

function seedDefaultLayout(
  adapter: DockviewAdapter,
  context: BusContext | undefined,
  live: LiveWorkspace | undefined,
  manifest: WorkspaceManifest | undefined,
): void {
  const firstProject = context?.roster.projects[0];

  executeCommand(
    {
      type: "open_panel",
      panelId: "roster",
      panelType: "roster",
      params: { context, store: live?.store, onSelectProject: undefined },
    },
    adapter,
  );
  executeCommand(
    {
      type: "split",
      panelId: "sessions",
      panelType: "sessions",
      referencePanelId: "roster",
      direction: "right",
      params: {
        store: live?.store,
        directory: firstProject?.expandedPath,
      },
    },
    adapter,
  );
  executeCommand(
    {
      type: "split",
      panelId: "transcript",
      panelType: "transcript",
      referencePanelId: "sessions",
      direction: "right",
      params: {
        client: live?.client,
        demux: live?.demux,
        directory: firstProject?.expandedPath,
      },
    },
    adapter,
  );
  executeCommand(
    {
      type: "split",
      panelId: "terminal",
      panelType: "terminal",
      referencePanelId: "sessions",
      direction: "down",
      params: {},
    },
    adapter,
  );
  executeCommand(
    {
      type: "split",
      panelId: "audit-log",
      panelType: "audit-log",
      referencePanelId: "transcript",
      direction: "down",
      params: {},
    },
    adapter,
  );

  seedDetectedPanels(adapter, manifest);
}

export function DockviewShell({
  workspacePath,
  context,
  manifest,
}: DockviewShellProps) {
  const adapterRef = useRef<DockviewAdapter | undefined>(undefined);
  const liveRef = useRef<LiveWorkspace | undefined>(undefined);
  const bridgeRef = useRef<LayoutBridge | undefined>(undefined);
  const apiRef = useRef<DockviewApi | undefined>(undefined);

  // U1.7 (AE3): mount the ide_* MCP bridge once, torn down on unmount. Any
  // relayed request runs `executeCommand` against whatever adapter is
  // current at call time (adapterRef survives across onReady re-invocation).
  useEffect(() => {
    const bridge = connectLayoutBridge({
      get panels() {
        return adapterRef.current?.panels ?? [];
      },
      get activePanel() {
        return adapterRef.current?.activePanel;
      },
      addPanel: (spec) => adapterRef.current?.addPanel(spec),
      removePanel: (id) => adapterRef.current?.removePanel(id),
      movePanel: (spec) => adapterRef.current?.movePanel(spec),
      focus: (id) => adapterRef.current?.focus(id),
      toJSON: () => adapterRef.current?.toJSON() ?? {},
      fromJSON: (layout) => adapterRef.current?.fromJSON(layout),
      hasPanel: (id) => adapterRef.current?.hasPanel(id) ?? false,
    });
    bridgeRef.current = bridge;
    return () => {
      bridge.close();
      bridgeRef.current = undefined;
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on workspacePath (one connection per workspace), not context identity
  useEffect(() => {
    if (!context) return;
    const live = createLiveWorkspace(context);
    liveRef.current = live;
    return () => {
      live.sse.close();
      liveRef.current = undefined;
    };
  }, [workspacePath]);

  const handleReady = useCallback(
    (event: DockviewReadyEvent) => {
      const adapter = createDockviewAdapter(event.api);
      adapterRef.current = adapter;

      const saved = loadLayout(workspacePath);
      if (saved) {
        executeCommand({ type: "set_layout", layout: saved }, adapter);
      } else {
        seedDefaultLayout(adapter, context, liveRef.current, manifest);
      }

      // Coarse panel-set signature (sorted ids), used to de-dupe/throttle
      // native-layout-change audit entries — dockview's onDidLayoutChange
      // fires on every drag frame, not just on committed changes.
      let lastPanelSignature = [...event.api.panels]
        .map((p) => p.id)
        .sort()
        .join(",");

      event.api.onDidLayoutChange(() => {
        saveLayout(workspacePath, adapter.toJSON());

        // Command-origin mutations (UI or mcp_tool) already emit an
        // executor audit entry — don't double-count the layout-change
        // event dockview-core fires synchronously as a side effect of
        // that same command (U1.7 audit-completeness fix).
        if (isCommandExecuting()) return;

        const panelIds = [...event.api.panels].map((p) => p.id).sort();
        const signature = panelIds.join(",");
        if (signature === lastPanelSignature) return;
        lastPanelSignature = signature;

        auditStore.recordNativeLayoutChange(`panels=${panelIds.length}`);
      });
    },
    [workspacePath, context, manifest],
  );

  // U1.6: transcript auto-select on dispatch (the U1.5 deferred item).
  // Minimal wiring — no new panel-id plumbing beyond the well-known
  // "transcript" panel id already seeded by seedDefaultLayout: push the
  // dispatched sessionId into that panel's params via updateParameters, the
  // same primitive dockview-core already exposes on IDockviewPanel.api.
  const handleDispatched = useCallback((sessionId: string) => {
    const panel = adapterRef.current?.panels.find((p) => p.id === "transcript");
    if (!panel) return;
    // adapterRef targets our narrow DockviewAdapter seam, which doesn't
    // expose per-panel param updates (out of scope to add there for one
    // caller) — reach the dockview-core panel directly via the event.api
    // captured in handleReady instead.
    apiRef.current
      ?.getPanel("transcript")
      ?.api.updateParameters({ sessionID: sessionId });
  }, []);

  return (
    <>
      <DockviewReact
        className="mothership-dockview"
        components={panelComponents()}
        onReady={(event) => {
          apiRef.current = event.api;
          handleReady(event);
        }}
      />
      {/* U1.6: floating prompt bar, not a dockview panel. */}
      <PromptBar
        context={context}
        store={liveRef.current?.store}
        directory={context?.roster.projects[0]?.expandedPath}
        onDispatched={handleDispatched}
      />
    </>
  );
}
