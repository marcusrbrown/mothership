/**
 * Audit-log surface. Renders the shared `auditStore` ring buffer live;
 * tokens-only styling per repo convention.
 */
import type { IDockviewPanelProps } from "dockview-react";
import { useEffect, useState } from "react";
import { type AuditLogEntry, auditStore } from "./audit-store";
import {
  type ParsedMetadata,
  formatResult,
  getActionName,
  getCategory,
  parseParamSummary,
} from "./audit-view";

function renderMetadata(parsed: ParsedMetadata[]) {
  if (parsed.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
      {parsed.map(({ key, value }) => {
        const isBytes = key === "bytes";
        const isTruncated = key === "truncated" && value === "true";
        return (
          <span key={key} style={{ whiteSpace: "nowrap" }}>
            <span style={{ color: "var(--color-text-dim)" }}>{key}:</span>
            <span
              style={{
                color: isTruncated
                  ? "var(--color-warning)"
                  : isBytes
                    ? "var(--color-accent-light)"
                    : "var(--color-text-muted)",
                marginLeft: "2px",
              }}
            >
              {value}
            </span>
          </span>
        );
      })}
    </div>
  );
}

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
        fontSize: "var(--text-xs)",
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        overflow: "auto",
        padding: "var(--space-2)",
      }}
    >
      {entries.length === 0 ? (
        <span
          style={{ color: "var(--color-text-dim)", padding: "var(--space-2)" }}
        >
          No operations or session activity recorded.
        </span>
      ) : (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-1)",
            width: "100%",
            minWidth: "640px",
          }}
        >
          {/* STICKY COLUMN HEADER */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "75px 50px 75px 140px 1fr 120px",
              gap: "var(--space-2)",
              alignItems: "center",
              padding: "var(--space-1) var(--space-2)",
              borderBottom: "1px solid var(--color-border)",
              color: "var(--color-text-dim)",
              fontWeight: "600",
              position: "sticky",
              top: 0,
              background: "var(--color-surface)",
              zIndex: 1,
            }}
          >
            <span>TIME</span>
            <span>SOURCE</span>
            <span>CATEGORY</span>
            <span>ACTION</span>
            <span>METADATA</span>
            <span style={{ textAlign: "right" }}>RESULT</span>
          </div>

          {/* EVENTS FEED */}
          {[...entries].reverse().map((entry, index) => {
            const category = getCategory(entry.command);
            const actionName = getActionName(entry.command);
            const parsedMetadata = parseParamSummary(entry.paramSummary);
            const { display: resultDisplay, isError: resultIsError } =
              formatResult(entry.result);

            return (
              <div
                key={`${entry.timestamp}-${entry.command}-${entry.source}-${index}`}
                style={{
                  display: "grid",
                  gridTemplateColumns: "75px 50px 75px 140px 1fr 120px",
                  gap: "var(--space-2)",
                  alignItems: "center",
                  padding: "var(--space-1) var(--space-2)",
                  borderBottom: "1px solid var(--color-border-subtle)",
                }}
              >
                {/* TIME */}
                <span style={{ color: "var(--color-text-dim)" }}>
                  {new Date(entry.timestamp).toLocaleTimeString()}
                </span>

                {/* SOURCE */}
                <span
                  style={{
                    color:
                      entry.source === "mcp_tool"
                        ? "var(--color-accent)"
                        : "var(--color-text-muted)",
                  }}
                >
                  {entry.source === "mcp_tool" ? "MCP" : "UI"}
                </span>

                {/* CATEGORY */}
                <span
                  style={{
                    color:
                      category === "LAYOUT"
                        ? "var(--color-text-secondary)"
                        : category === "SESSION"
                          ? "var(--color-accent-light)"
                          : "var(--color-text-muted)",
                    fontSize: "10px",
                    fontWeight: "bold",
                  }}
                >
                  {category}
                </span>

                {/* ACTION */}
                <span
                  style={{
                    color: "var(--color-text)",
                    fontWeight: "500",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={actionName}
                >
                  {actionName}
                </span>

                {/* METADATA */}
                <div style={{ overflow: "hidden" }}>
                  {renderMetadata(parsedMetadata)}
                </div>

                {/* RESULT */}
                <span
                  style={{
                    textAlign: "right",
                    color: resultIsError
                      ? "var(--color-error)"
                      : "var(--color-success)",
                    fontWeight: "bold",
                    fontSize: "10px",
                  }}
                >
                  {resultDisplay}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
