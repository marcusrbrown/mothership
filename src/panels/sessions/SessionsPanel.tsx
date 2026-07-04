/**
 * Registered `sessions` panel type: per-project session rows. See
 * `sessions-view.ts` for the GAP note — `src/server/bus` (space-bus /core)
 * exposes no session-listing call, so this renders the partial view
 * `snapshot()` can give today (sessions with a pending question). Selecting
 * a session is a no-op seam for U1.3's transcript wiring.
 */
import type { IDockviewPanelProps } from "dockview-react";
import { useCallback, useEffect, useState } from "react";
import { snapshot } from "../../server/bus";
import type { BusContext } from "../../server/types";
import { type SessionsViewState, toSessionsViewState } from "./sessions-view";

export interface SessionsPanelParams {
  /** BusContext to snapshot against. Absent → panel shows a config-missing error. */
  context?: BusContext;
  /** Name of the project whose sessions this panel lists. */
  projectName?: string;
  /** Fired when the operator selects a session row. No-op wiring point for U1.3. */
  onSelectSession?: (sessionId: string) => void;
}

export function SessionsPanel(props: IDockviewPanelProps<SessionsPanelParams>) {
  const { context, projectName, onSelectSession } = props.params;
  const [state, setState] = useState<SessionsViewState>({
    status: "loading",
  });

  const refresh = useCallback(async () => {
    if (!context || !projectName) {
      setState({
        status: "error",
        message: "No workspace context or project selected.",
      });
      return;
    }
    setState({ status: "loading" });
    try {
      const result = await snapshot({ context });
      if (!result.ok) {
        setState({ status: "error", message: result.error });
        return;
      }
      const project = result.projects.find((p) => p.name === projectName);
      setState(toSessionsViewState({ ok: true, project }));
    } catch (err) {
      setState({
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [context, projectName]);

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
      {renderBody(state, onSelectSession)}
    </div>
  );
}

function renderBody(
  state: SessionsViewState,
  onSelectSession?: (sessionId: string) => void,
) {
  if (state.status === "loading") {
    return <StatusMessage tone="muted">Loading sessions…</StatusMessage>;
  }
  if (state.status === "error") {
    return <StatusMessage tone="error">{state.message}</StatusMessage>;
  }
  if (state.status === "empty") {
    return (
      <StatusMessage tone="muted">
        No active sessions for this project.
      </StatusMessage>
    );
  }

  return (
    <ul style={{ listStyle: "none", margin: 0, padding: "var(--space-2)" }}>
      {state.rows.map((row) => (
        <li
          key={row.id}
          role={onSelectSession ? "button" : undefined}
          tabIndex={onSelectSession ? 0 : undefined}
          onClick={() => onSelectSession?.(row.id)}
          onKeyDown={(e) => {
            if (onSelectSession && (e.key === "Enter" || e.key === " ")) {
              onSelectSession(row.id);
            }
          }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            padding: "var(--space-2)",
            marginBottom: "var(--space-1)",
            borderRadius: "var(--radius-sm)",
            border: "1px solid var(--color-border)",
            background: "var(--color-surface-raised)",
            cursor: onSelectSession ? "pointer" : "default",
          }}
        >
          <span
            aria-label={row.busy ? "busy" : "idle"}
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: row.busy
                ? "var(--color-accent)"
                : "var(--color-text-dim)",
              flexShrink: 0,
            }}
          />
          <span
            style={{ fontSize: "var(--text-sm)", color: "var(--color-text)" }}
          >
            {row.title || row.id}
          </span>
        </li>
      ))}
    </ul>
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
