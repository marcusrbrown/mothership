import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Top-level error boundary: without it, any throw in the panel tree
 * unmounts the whole React root and the window goes dark with no signal.
 * Renders the error + component stack (tokens-only) so failures are
 * diagnosable in the Tauri window, which has no address bar or visible
 * console by default.
 */
interface Props {
  children: ReactNode;
}

interface State {
  error?: Error;
  stack?: string;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = {};

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[mothership] render error:", error, info.componentStack);
    this.setState({ stack: info.componentStack ?? undefined });
  }

  render(): ReactNode {
    const { error, stack } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-3)",
          height: "100%",
          width: "100%",
          padding: "var(--space-6)",
          overflow: "auto",
          background: "var(--color-bg)",
          color: "var(--color-text)",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <strong
          style={{ color: "var(--color-error)", fontSize: "var(--text-lg)" }}
        >
          Something threw while rendering
        </strong>
        <pre
          style={{
            margin: 0,
            padding: "var(--space-3)",
            borderRadius: "var(--radius-sm)",
            background: "var(--color-surface-raised)",
            border: "1px solid var(--color-error)",
            color: "var(--color-error)",
            fontSize: "var(--text-xs)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {error.message}
        </pre>
        {stack && (
          <pre
            style={{
              margin: 0,
              padding: "var(--space-3)",
              borderRadius: "var(--radius-sm)",
              background: "var(--color-surface)",
              color: "var(--color-text-muted)",
              fontSize: "var(--text-xs)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {stack}
          </pre>
        )}
        <button
          type="button"
          onClick={() => this.setState({ error: undefined, stack: undefined })}
          style={{
            alignSelf: "flex-start",
            color: "var(--color-bg)",
            background: "var(--color-accent)",
            border: "none",
            borderRadius: "var(--radius-sm)",
            padding: "var(--space-2) var(--space-4)",
            fontSize: "var(--text-sm)",
            cursor: "pointer",
          }}
        >
          Dismiss
        </button>
      </div>
    );
  }
}
