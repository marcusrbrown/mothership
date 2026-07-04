/**
 * Registered `roster` panel type: workspace projects from a `snapshot()`
 * call, one row per project. Per-project errors (missing path,
 * `statusError`) isolate to that row — never fail the whole panel. No
 * polling: one snapshot on mount, plus a `refresh()` seam the SSE layer
 * (U1.3) will call to re-fetch after reconnect/status events.
 */
import type { IDockviewPanelProps } from "dockview-react";
import { useCallback, useEffect, useState } from "react";
import { snapshot } from "../../server/bus";
import type { BusContext } from "../../server/types";
import {
  type RosterRowState,
  type RosterViewState,
  toRosterViewState,
} from "./roster-view";

export interface RosterPanelParams {
  /** BusContext to snapshot against. Absent → panel shows a config-missing error. */
  context?: BusContext;
  /** Fired when the operator selects a project row. No-op wiring point for later units. */
  onSelectProject?: (name: string) => void;
}

export function RosterPanel(props: IDockviewPanelProps<RosterPanelParams>) {
  const context = props.params.context;
  const [state, setState] = useState<RosterViewState>({ status: "loading" });

  const refresh = useCallback(async () => {
    if (!context) {
      setState({
        status: "error",
        message: "No workspace context — roster cannot load.",
      });
      return;
    }
    setState({ status: "loading" });
    try {
      const result = await snapshot({ context });
      setState(
        toRosterViewState(
          result.ok
            ? { ok: true, projects: result.projects }
            : { ok: false, error: result.error },
        ),
      );
    } catch (err) {
      setState({
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [context]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
  const borderColor =
    row.kind === "missing-path"
      ? "var(--color-highlight)"
      : row.kind === "status-error"
        ? "var(--color-error)"
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
