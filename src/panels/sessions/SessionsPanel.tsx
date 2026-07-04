/**
 * Registered `sessions` panel type: full per-project session list, sourced
 * from the shared `SessionStore` (see `src/server/session-store.ts`) rather
 * than `snapshot()`'s partial pendingQuestions-only view. `refresh()` pulls
 * a fresh snapshot from the store; `store.subscribe` keeps it live as
 * events/reconciles land. Selecting a session drives U1.3's transcript
 * panel via `onSelectSession`.
 */
import type { IDockviewPanelProps } from "dockview-react";
import { useCallback, useEffect, useState } from "react";
import type { SessionStore } from "../../server/session-store";
import { type SessionsViewState, toSessionsViewState } from "./sessions-view";

export interface SessionsPanelParams {
  /** Shared session store for the workspace (one per BusContext). Absent → panel shows a config-missing error. */
  store?: SessionStore;
  /** Directory of the project whose sessions this panel lists. */
  directory?: string;
  /** Fired when the operator selects a session row. Drives the transcript panel. */
  onSelectSession?: (sessionId: string) => void;
  /** Bug 5: the sessionID currently driving the transcript panel — kept in
   * sync by DockviewShell from BOTH onSelectSession and handleDispatched,
   * so it reflects the active session regardless of how it was selected.
   * Renders that row with a selected (cyan) treatment, distinct from the
   * needs-attention (magenta) marker. */
  activeSessionId?: string;
}

export function SessionsPanel(props: IDockviewPanelProps<SessionsPanelParams>) {
  const { store, directory, onSelectSession, activeSessionId } = props.params;
  const [state, setState] = useState<SessionsViewState>({
    status: "loading",
  });

  const refresh = useCallback(() => {
    // `typeof store.getSessions !== "function"` guards against a
    // dead-but-truthy store restored from stale pre-fix localStorage
    // (JSON.stringify reduces a live SessionStore instance to `{}`).
    if (!store || !directory || typeof store.getSessions !== "function") {
      setState({
        status: "error",
        message: "No workspace context or project selected.",
      });
      return;
    }
    const sessions = store.getSessions(directory);
    const pendingSessionIds = new Set(
      store.getPendingQuestions().map((q) => q.sessionID),
    );
    setState(toSessionsViewState({ ok: true, sessions, pendingSessionIds }));
  }, [store, directory]);

  useEffect(() => {
    refresh();
    if (!store || typeof store.subscribe !== "function") return;
    return store.subscribe(refresh);
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
      {renderBody(state, onSelectSession, activeSessionId)}
    </div>
  );
}

function renderBody(
  state: SessionsViewState,
  onSelectSession?: (sessionId: string) => void,
  activeSessionId?: string,
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
      {state.rows.map((row) => {
        const selected = row.id === activeSessionId;
        return (
          <li
            key={row.id}
            role={onSelectSession ? "button" : undefined}
            tabIndex={onSelectSession ? 0 : undefined}
            aria-current={selected ? "true" : undefined}
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
              border: selected
                ? "1px solid var(--color-accent)"
                : row.needsAttention
                  ? "1px solid var(--color-cta)"
                  : "1px solid var(--color-border)",
              background: "var(--color-surface-raised)",
              boxShadow: selected ? "0 0 6px var(--color-accent)" : "none",
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
              style={{
                fontSize: "var(--text-sm)",
                color: "var(--color-text)",
              }}
            >
              {row.title || row.id}
            </span>
            {row.needsAttention && (
              <span
                aria-label="needs attention"
                style={{
                  marginLeft: "auto",
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: "var(--color-cta)",
                  boxShadow: "0 0 6px var(--color-cta)",
                }}
              />
            )}
          </li>
        );
      })}
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
