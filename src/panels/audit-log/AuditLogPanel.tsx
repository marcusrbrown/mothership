/**
 * Audit-log surface. Renders the shared `auditStore` ring buffer live;
 * tokens-only styling per repo convention.
 */
import type { IDockviewPanelProps } from "dockview-react";
import { useEffect, useState } from "react";
import { type AuditLogEntry, auditStore } from "./audit-store";

export function AuditLogPanel(_props: IDockviewPanelProps) {
  const [entries, setEntries] = useState<readonly AuditLogEntry[]>(() =>
    auditStore.getEntries(),
  );

  useEffect(() => auditStore.subscribe(setEntries), []);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        width: "100%",
        background: "var(--color-surface)",
        color: "var(--color-text)",
        fontSize: "var(--text-sm)",
        overflow: "auto",
        padding: "var(--space-2)",
        gap: "var(--space-1)",
      }}
    >
      {entries.length === 0 ? (
        <span style={{ color: "var(--color-text-muted)" }}>
          No commands executed yet.
        </span>
      ) : (
        [...entries].reverse().map((entry) => (
          <div
            key={`${entry.timestamp}-${entry.command}-${entry.source}`}
            style={{ display: "flex", gap: "var(--space-2)" }}
          >
            <span style={{ color: "var(--color-text-muted)" }}>
              {new Date(entry.timestamp).toLocaleTimeString()}
            </span>
            <span
              style={{
                color:
                  entry.source === "mcp_tool"
                    ? "var(--color-accent)"
                    : "var(--color-text-muted)",
              }}
            >
              [{entry.source}]
            </span>
            <span>{entry.command}</span>
            <span style={{ color: "var(--color-text-muted)" }}>
              {entry.paramSummary}
            </span>
            <span
              style={{
                color:
                  entry.result === "ok"
                    ? "var(--color-success)"
                    : "var(--color-error)",
              }}
            >
              {entry.result}
            </span>
          </div>
        ))
      )}
    </div>
  );
}
