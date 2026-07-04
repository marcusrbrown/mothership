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
import { type OpencodeClient, createOpencodeClient } from "../server/client";
import { type Demux, createDemux } from "../server/demux";
import { type SessionStore, createSessionStore } from "../server/session-store";
import { type SseClient, connectSse } from "../server/sse";
import type { BusContext } from "../server/types";
import type { DockviewAdapter } from "./adapter";
import { createDockviewAdapter } from "./dockview-adapter";
import { executeCommand } from "./executor";
import { loadLayout, saveLayout } from "./persistence";
import { panelComponents } from "./registry";

export interface DockviewShellProps {
  /** Absolute workspace path — the persistence key. */
  workspacePath: string;
  /** Live BusContext for the roster/sessions panels; absent → those panels
   * render their own config-missing error state (no crash). */
  context?: BusContext;
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

function seedDefaultLayout(
  adapter: DockviewAdapter,
  context: BusContext | undefined,
  live: LiveWorkspace | undefined,
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
      panelType: "placeholder",
      referencePanelId: "transcript",
      direction: "down",
      params: { panelType: "audit-log" },
    },
    adapter,
  );
}

export function DockviewShell({ workspacePath, context }: DockviewShellProps) {
  const adapterRef = useRef<DockviewAdapter | undefined>(undefined);
  const liveRef = useRef<LiveWorkspace | undefined>(undefined);

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
        seedDefaultLayout(adapter, context, liveRef.current);
      }

      event.api.onDidLayoutChange(() => {
        saveLayout(workspacePath, adapter.toJSON());
      });
    },
    [workspacePath, context],
  );

  return (
    <DockviewReact
      className="mothership-dockview"
      components={panelComponents()}
      onReady={handleReady}
    />
  );
}
