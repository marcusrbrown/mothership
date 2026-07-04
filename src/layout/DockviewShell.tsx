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
import { useCallback, useEffect, useMemo, useRef } from "react";
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

/** Constructs the pure, connection-less client/demux/store set for the
 * workspace: `createOpencodeClient` + `createDemux` + `createSessionStore`
 * + the `demux.subscribeFirehose(store.applyEvent)` wiring. None of this
 * opens a network connection, so it's safe to build synchronously (in a
 * `useMemo`) — panels seed from it at `onReady` time, before any effect
 * would have run. Exported for tests. */
export function createLiveWorkspace(context: BusContext): LiveWorkspace {
  const client = createOpencodeClient({
    baseUrl: context.roster.server.baseUrl,
    credentials: context.credentials,
  });
  const demux = createDemux();
  const store = createSessionStore();

  demux.subscribeFirehose((event) => store.applyEvent(event));

  return { client, demux, store };
}

/** Opens the ONE workspace-wide `/event` SSE connection and wires it into
 * an already-constructed `LiveWorkspace`. This is the side-effecting half
 * of workspace setup — the caller (DockviewShell) owns it inside a
 * `useEffect` so React.StrictMode's mount→cleanup→mount correctly closes
 * AND reopens the connection (see the effect's comment for the full
 * reasoning). Every (re)connect triggers `reconcileAll`. */
export function connectWorkspaceSse(
  live: LiveWorkspace,
  context: BusContext,
): SseClient {
  // One connection for the whole workspace: directory-scoped filtering
  // happens per-project during reconcile, not at the SSE connection level.
  const primaryDirectory = context.roster.projects[0]?.expandedPath ?? "";
  return connectSse({
    baseUrl: context.roster.server.baseUrl,
    directory: primaryDirectory,
    credentials: context.credentials,
    onEvent: (event) => live.demux.dispatch(event),
    onReconcile: () => {
      void reconcileAll(live.client, live.store, context);
    },
  });
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

/** Live-service inputs shared by seedDefaultLayout and the restore path —
 * kept as one bag so `liveParamsForPanel` has a single source of truth for
 * "which live objects/callbacks does panel type X need". */
interface LiveParamContext {
  context?: BusContext;
  live?: LiveWorkspace;
  directory?: string;
  callbacks: {
    onSelectProject: (name: string) => void;
    onSelectSession: (sessionId: string) => void;
  };
}

/** Maps a panel type to the live params it needs, given the current
 * workspace's live services. This is the ONE place that knows which panel
 * type needs which live object — seeding a fresh layout and re-injecting
 * live services into a restored (persisted) layout both call this, so they
 * can never drift apart. Unknown/no-live-service panel types (terminal's
 * `cwd` is plain data; audit-log/placeholder need nothing) return `{}`. */
function liveParamsForPanel(
  panelType: string,
  ctx: LiveParamContext,
): Record<string, unknown> {
  switch (panelType) {
    case "roster":
      return {
        context: ctx.context,
        store: ctx.live?.store,
        onSelectProject: ctx.callbacks.onSelectProject,
      };
    case "sessions":
      return {
        store: ctx.live?.store,
        directory: ctx.directory,
        onSelectSession: ctx.callbacks.onSelectSession,
      };
    case "transcript":
      // sessionID comes from selection/dispatch, not the seed/restore path.
      return {
        client: ctx.live?.client,
        demux: ctx.live?.demux,
        directory: ctx.directory,
      };
    case "terminal":
      // cwd is plain data — already persisted, may be empty here.
      return {};
    default:
      return {};
  }
}

function seedDefaultLayout(
  adapter: DockviewAdapter,
  context: BusContext | undefined,
  live: LiveWorkspace | undefined,
  manifest: WorkspaceManifest | undefined,
  onSelectProject: (name: string) => void,
  onSelectSession: (sessionId: string) => void,
): void {
  const firstProject = context?.roster.projects[0];
  const liveCtx: LiveParamContext = {
    context,
    live,
    directory: firstProject?.expandedPath,
    callbacks: { onSelectProject, onSelectSession },
  };

  executeCommand(
    {
      type: "open_panel",
      panelId: "roster",
      panelType: "roster",
      params: liveParamsForPanel("roster", liveCtx),
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
      params: liveParamsForPanel("sessions", liveCtx),
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
      params: liveParamsForPanel("transcript", liveCtx),
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
      // The workspace dir the app resolved at startup (see
      // resolveWorkspaceDir) isn't threaded down to seedDefaultLayout — the
      // first roster project's directory is a reasonable stand-in so the
      // terminal opens alongside the workspace instead of in $HOME.
      params: { cwd: firstProject?.expandedPath },
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

/** Re-injects live services into panels restored from a persisted layout.
 * `saveLayout` strips live/sensitive params (see persistence.ts), so a
 * `set_layout`-restored panel mounts with no client/demux/store/context —
 * dockview mounts panels SYNCHRONOUSLY during `set_layout`, before this can
 * run, so there's a brief window where e.g. TranscriptPanel sees no `demux`
 * (or, for pre-fix stale localStorage, a dead `{}`). TranscriptPanel's
 * `typeof demux.subscribe === "function"` guard covers that window; this
 * then triggers a re-render via `updateParameters`, merging live services
 * in WITHOUT clobbering the persisted plain-data params (directory,
 * sessionID, cwd) already present on the panel. */
function reinjectLiveParams(api: DockviewApi, liveCtx: LiveParamContext): void {
  for (const panel of api.panels) {
    // seedDefaultLayout keys the well-known live-service panels by a fixed
    // id (roster/sessions/transcript/terminal) — that id doubles as the
    // panel-type signal here, matching liveParamsForPanel's switch. Any
    // other panel (placeholders, detected-interface tabs) has no live
    // services to re-inject.
    const liveParams = liveParamsForPanel(panel.id, liveCtx);
    if (Object.keys(liveParams).length === 0) continue;
    panel.api.updateParameters({ ...panel.params, ...liveParams });
  }
}

export function DockviewShell({
  workspacePath,
  context,
  manifest,
}: DockviewShellProps) {
  const adapterRef = useRef<DockviewAdapter | undefined>(undefined);
  const bridgeRef = useRef<LayoutBridge | undefined>(undefined);
  const apiRef = useRef<DockviewApi | undefined>(undefined);

  // Synchronous (not effect-populated) live workspace: seedDefaultLayout
  // runs inside onReady, which can fire before a `useEffect` creating this
  // would have run — that raced the roster/sessions/transcript/promptbar
  // panels ahead of their store/client/demux, seeding them with undefined
  // (the "No workspace context" bug). useMemo makes `live` available at
  // first render, keyed on workspacePath (not context identity) to keep
  // the one-connection-per-workspace invariant.
  //
  // `live` here is the PURE half only (client/demux/store, no network
  // connection) — see `createLiveWorkspace`. The SSE connection itself is
  // opened/closed in the effect below, which is the fix for the bug where
  // the connection was created here (useMemo, keyed on workspacePath) but
  // torn down in a *separate* effect keyed on `[live]`: under
  // React.StrictMode, effects run mount→cleanup→mount, so the old
  // `useEffect(() => () => live?.sse.close(), [live])` closed the
  // connection on the synthetic first cleanup, but nothing ever reopened
  // it (useMemo doesn't re-run — `[workspacePath]` hadn't changed). The
  // SSE connection was permanently dead after StrictMode's double-invoke,
  // so `onReconcile` never fired again and the session store stayed empty.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on workspacePath (one connection per workspace), not context identity
  const live = useMemo<LiveWorkspace | undefined>(() => {
    if (!context) return undefined;
    return createLiveWorkspace(context);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspacePath]);

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

  // The SSE connection: creation AND teardown live in this ONE effect, so
  // React.StrictMode's mount→cleanup→mount is symmetric and self-healing.
  // Reasoning through the sequence: mount → connectWorkspaceSse opens
  // connection A; StrictMode's synthetic cleanup runs → A.close(); the
  // guaranteed StrictMode remount re-runs this effect body → opens
  // connection B, which stays open (no third invocation follows). Every
  // (re)open — A and B alike — fires `onReconcile` (see connectSse), so B
  // fully reconciles the store even though A's reconcile was thrown away
  // with A itself. Keyed on `[live, context]` — `live`'s identity already
  // changes with `workspacePath` (see the useMemo above), so this effect
  // reconnects whenever the workspace (or context) changes too.
  useEffect(() => {
    if (!live || !context) return;
    const sse = connectWorkspaceSse(live, context);
    return () => {
      sse.close();
    };
  }, [live, context]);

  // Bug 3 wiring: roster row click re-scopes the sessions panel to that
  // project's directory via dockview-core's updateParameters — the same
  // primitive handleDispatched already uses for the transcript panel.
  // No-op if the project name isn't found in the roster (stale click).
  const handleSelectProject = useCallback(
    (name: string) => {
      const project = context?.roster.projects.find((p) => p.name === name);
      if (!project) return;
      apiRef.current
        ?.getPanel("sessions")
        ?.api.updateParameters({ directory: project.expandedPath });
    },
    [context],
  );

  // Bug 3 wiring: sessions row click points the transcript panel at that
  // session, mirroring handleDispatched's pattern exactly.
  // Bug 5 wiring: mark the selected session active on the sessions panel
  // (drives the selected-row highlight) alongside pointing the transcript
  // panel at it — one place updates both so they can never drift.
  const handleSelectSession = useCallback((sessionId: string) => {
    apiRef.current
      ?.getPanel("transcript")
      ?.api.updateParameters({ sessionID: sessionId });
    apiRef.current
      ?.getPanel("sessions")
      ?.api.updateParameters({ activeSessionId: sessionId });
  }, []);

  const handleReady = useCallback(
    (event: DockviewReadyEvent) => {
      const adapter = createDockviewAdapter(event.api);
      adapterRef.current = adapter;

      const saved = loadLayout(workspacePath);
      if (saved) {
        executeCommand({ type: "set_layout", layout: saved }, adapter);
        // Restored panels have no live services (stripped on save, see
        // persistence.ts) — re-inject them now. dockview already mounted
        // the panels synchronously above; TranscriptPanel's demux guard
        // covers the gap between mount and this re-injection.
        reinjectLiveParams(event.api, {
          context,
          live,
          directory: context?.roster.projects[0]?.expandedPath,
          callbacks: {
            onSelectProject: handleSelectProject,
            onSelectSession: handleSelectSession,
          },
        });
      } else {
        seedDefaultLayout(
          adapter,
          context,
          live,
          manifest,
          handleSelectProject,
          handleSelectSession,
        );
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
    [
      workspacePath,
      context,
      manifest,
      live,
      handleSelectProject,
      handleSelectSession,
    ],
  );

  // U1.6: transcript auto-select on dispatch (the U1.5 deferred item).
  // Minimal wiring — no new panel-id plumbing beyond the well-known
  // "transcript" panel id already seeded by seedDefaultLayout: push the
  // dispatched sessionId into that panel's params via updateParameters, the
  // same primitive dockview-core already exposes on IDockviewPanel.api.
  // Bug 4 fix: dispatchPrompt resolves the target PROJECT (the @-mention or
  // the default), and PromptBar's onDispatched now threads that project's
  // DIRECTORY through here alongside the sessionId. Updating ONLY
  // sessionID (the pre-fix behavior) left the transcript panel's
  // `directory` param pointed at whatever project was previously selected
  // (or the workspace default), so `listMessages(directory, sessionID)`
  // backfilled against the WRONG directory whenever the dispatch target
  // differed — the transcript silently failed to switch until the operator
  // clicked the target project in the roster (which updates `directory`
  // via handleSelectProject). Updating both params together closes that
  // gap. Also re-scopes the sessions panel to the same directory (matches
  // handleSelectProject) so the new session is visible in that list too,
  // and marks it as the active session (bug 5) for the selected-row
  // highlight.
  const handleDispatched = useCallback(
    (sessionId: string, directory: string) => {
      apiRef.current
        ?.getPanel("transcript")
        ?.api.updateParameters({ directory, sessionID: sessionId });
      apiRef.current
        ?.getPanel("sessions")
        ?.api.updateParameters({ directory, activeSessionId: sessionId });
    },
    [],
  );

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
        store={live?.store}
        directory={context?.roster.projects[0]?.expandedPath}
        onDispatched={handleDispatched}
      />
    </>
  );
}
