/**
 * Registered `roster` panel type: workspace projects from a `snapshot()`
 * call, one row per project. Per-project errors (missing path,
 * `statusError`) isolate to that row — never fail the whole panel. No
 * polling: one snapshot on mount, plus a `refresh()` seam the SSE layer
 * calls to re-fetch after reconnect/status events.
 */
import type { IDockviewPanelProps } from "dockview-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { snapshot } from "../../server/bus";
import type { SessionStore } from "../../server/session-store";
import type { BusContext } from "../../server/types";
import {
  type RosterRowState,
  type RosterViewState,
  toRosterViewState,
} from "./roster-view";

export interface RosterPanelParams {
  /** BusContext to snapshot against. Absent → panel shows a config-missing error. */
  context?: BusContext;
  /** Shared session store — drives the needs-attention badge. Absent → badge never shown. */
  store?: SessionStore;
  /** Fired when the operator selects a project row. No-op wiring point for later units. */
  onSelectProject?: (name: string) => void;
  /** Issue 3 fix: expanded-path directory of the project currently
   * active (viewed via a session selection, or just dispatched to) —
   * DockviewShell's single `activeSession` source of truth. Drives the
   * cyan `--color-accent` active-row highlight, matching the
   * sessions-view active-row treatment (`SessionsPanel.tsx`'s
   * `activeSessionId`). Absent → no row highlighted. */
  activeDirectory?: string;
}

/** Maps pending-question sessionIDs to project names via the sessions'
 * `directory` field. Directories are matched against the roster's project
 * `path`/`expandedPath` in RosterPanel's render, so this just needs the
 * directory string per pending session. */
function projectsNeedingAttention(
  store: SessionStore | undefined,
  projects: { name: string; path: string }[],
): ReadonlySet<string> {
  // `typeof store.getPendingQuestions !== "function"` guards against a
  // dead-but-truthy store restored from stale pre-fix localStorage
  // (JSON.stringify reduces a live SessionStore instance to `{}`).
  if (!store || typeof store.getPendingQuestions !== "function") {
    return new Set();
  }
  const pendingSessionIds = new Set(
    store.getPendingQuestions().map((q) => q.sessionID),
  );
  if (pendingSessionIds.size === 0) return new Set();

  const dirsWithPending = new Set(
    store
      .getSessions()
      .filter((s) => pendingSessionIds.has(s.id) && s.directory)
      .map((s) => s.directory as string),
  );

  const names = new Set<string>();
  for (const p of projects) {
    if (dirsWithPending.has(p.path)) names.add(p.name);
  }
  return names;
}

export function RosterPanel(props: IDockviewPanelProps<RosterPanelParams>) {
  const { context, store, activeDirectory } = props.params;
  const [state, setState] = useState<RosterViewState>({ status: "loading" });
  // `store.subscribe` fires on every SSE event on a busy
  // workspace, so `refresh` runs far more often than "the operator did
  // something roster-relevant". Resetting to `{status: "loading"}` at the
  // start of every one of those refreshes flickered the whole panel back
  // to the loading placeholder and hid the rows, even though the previous
  // snapshot was still perfectly valid. Only the FIRST load should show
  // the loading state — every refresh after that keeps showing the last
  // good rows until the new snapshot resolves, then swaps in place.
  const hasLoadedRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!context) {
      setState({
        status: "error",
        message: "No workspace context — roster cannot load.",
      });
      return;
    }
    if (!hasLoadedRef.current) {
      setState({ status: "loading" });
    }
    try {
      const result = await snapshot({ context });
      hasLoadedRef.current = true;
      setState(
        toRosterViewState(
          result.ok
            ? { ok: true, projects: result.projects }
            : { ok: false, error: result.error },
          result.ok
            ? projectsNeedingAttention(store, result.projects)
            : undefined,
          activeDirectory,
        ),
      );
    } catch (err) {
      // A transient fetch error on a background refresh shouldn't blow away
      // rows the operator was already looking at — only surface the error
      // state on the first load. After that, log-and-keep-showing-stale is
      // the friendlier failure mode (the next successful refresh recovers).
      if (!hasLoadedRef.current) {
        setState({
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // `activeDirectory` in deps (issue 3 fix): a highlight change alone
    // (no new snapshot data) still needs `refresh` to re-run
    // `toRosterViewState` with the new active directory — DockviewShell
    // updates this param via `updateParameters` on select/dispatch, which
    // doesn't itself trigger a store notify.
  }, [context, store, activeDirectory]);

  useEffect(() => {
    void refresh();
    if (!store || typeof store.subscribe !== "function") return;
    return store.subscribe(() => void refresh());
  }, [refresh, store]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        width: "100%",
        background: "var(--color-surface)",
        color: "var(--color-text)",
        fontFamily: "system-ui, sans-serif",
        overflow: "auto",
      }}
    >
      {renderBody(state, props.params.onSelectProject)}
    </div>
  );
}

function renderBody(
  state: RosterViewState,
  onSelectProject?: (name: string) => void,
) {
  if (state.status === "loading") {
    return (
      <StatusMessage tone="muted">Loading workspace roster…</StatusMessage>
    );
  }

  if (state.status === "error") {
    return <StatusMessage tone="error">{state.message}</StatusMessage>;
  }

  if (state.status === "empty") {
    return (
      <StatusMessage tone="muted">
        No projects in this workspace's spacebus.json manifest.
      </StatusMessage>
    );
  }

  return (
    <ul style={{ listStyle: "none", margin: 0, padding: "var(--space-2)" }}>
      {state.rows.map((row) => (
        <RosterRow
          key={row.project.name}
          row={row}
          onSelect={onSelectProject}
        />
      ))}
    </ul>
  );
}

function RosterRow({
  row,
  onSelect,
}: {
  row: RosterRowState;
  onSelect?: (name: string) => void;
}) {
  const busy = row.kind === "ok" && row.busy;
  const needsAttention = row.kind === "ok" && row.needsAttention;
  // Issue 3 fix: active takes priority over missing-path/status-error/
  // needs-attention borders, matching SessionsPanel's `selected` treatment
  // (cyan accent + glow wins over the magenta needs-attention marker).
  const borderColor = row.active
    ? "var(--color-accent)"
    : row.kind === "missing-path"
      ? "var(--color-highlight)"
      : row.kind === "status-error"
        ? "var(--color-error)"
        : needsAttention
          ? "var(--color-cta)"
          : "var(--color-border)";

  return (
    <li
      role={onSelect ? "button" : undefined}
      tabIndex={onSelect ? 0 : undefined}
      onClick={() => onSelect?.(row.project.name)}
      onKeyDown={(e) => {
        if (onSelect && (e.key === "Enter" || e.key === " ")) {
          onSelect(row.project.name);
        }
      }}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "2px",
        padding: "var(--space-2)",
        marginBottom: "var(--space-1)",
        borderRadius: "var(--radius-sm)",
        border: `1px solid ${borderColor}`,
        boxShadow: row.active ? "0 0 6px var(--color-accent)" : "none",
        background: "var(--color-surface-raised)",
        cursor: onSelect ? "pointer" : "default",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
        }}
      >
        <span
          aria-label={busy ? "busy" : "idle"}
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: busy ? "var(--color-accent)" : "var(--color-text-dim)",
            flexShrink: 0,
          }}
        />
        <strong
          style={{ color: "var(--color-text)", fontSize: "var(--text-sm)" }}
        >
          {row.project.name}
        </strong>
        {row.kind === "missing-path" && (
          <span
            style={{
              color: "var(--color-highlight)",
              fontSize: "var(--text-xs)",
            }}
          >
            MISSING PATH
          </span>
        )}
        {needsAttention && (
          <span
            aria-label="needs attention"
            style={{
              marginLeft: "auto",
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "var(--color-cta)",
              boxShadow: "0 0 6px var(--color-cta)",
              flexShrink: 0,
            }}
          />
        )}
      </div>
      <span
        style={{ color: "var(--color-text-muted)", fontSize: "var(--text-xs)" }}
      >
        {row.project.path}
      </span>
      {row.project.description && (
        <span
          style={{
            color: "var(--color-text-secondary)",
            fontSize: "var(--text-xs)",
          }}
        >
          {row.project.description}
        </span>
      )}
      {row.kind === "status-error" && (
        <span
          style={{ color: "var(--color-error)", fontSize: "var(--text-xs)" }}
        >
          {row.error}
        </span>
      )}
      {row.kind === "ok" && (
        <span
          style={{
            color: "var(--color-text-dim)",
            fontSize: "var(--text-xs)",
          }}
        >
          {row.project.sessionCount ?? 0} session
          {row.project.sessionCount === 1 ? "" : "s"}
          {row.project.sessionCountCapped ? "+" : ""}
        </span>
      )}
    </li>
  );
}

function StatusMessage({
  tone,
  children,
}: {
  tone: "muted" | "error";
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "var(--space-4)",
        textAlign: "center",
        color:
          tone === "error" ? "var(--color-error)" : "var(--color-text-muted)",
        fontSize: "var(--text-sm)",
      }}
    >
      {children}
    </div>
  );
}
