/**
 * Universal fallback panel — renders when a real panel type isn't registered
 * yet or when a persisted layout references a type that no longer exists.
 * Styled exclusively from tokens.
 */
import type { IDockviewPanelProps } from "dockview-react";

export interface PlaceholderPanelParams {
  /** The panel-type key this placeholder stands in for. */
  panelType?: string;
}

export function PlaceholderPanel(
  props: IDockviewPanelProps<PlaceholderPanelParams>,
) {
  const panelType = props.params.panelType ?? "unknown";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        width: "100%",
        background: "var(--color-surface)",
        color: "var(--color-text-muted)",
        fontFamily: "system-ui, sans-serif",
        padding: "var(--space-4)",
        textAlign: "center",
      }}
    >
      <strong
        style={{ color: "var(--color-text)", fontSize: "var(--text-lg)" }}
      >
        {panelType}
      </strong>
      <span style={{ fontSize: "var(--text-sm)" }}>
        detected interface (placeholder; the real panel is a follow-up)
      </span>
    </div>
  );
}
