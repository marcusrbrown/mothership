/**
 * In-memory ring buffer feeding the audit-log panel. Subscribes to the
 * executor's `onCommandExecuted` hook (already source-tagged 'ui'|'mcp_tool')
 * so UI-initiated and tool-initiated mutations interleave in one visible feed
 * No durable storage — state lives only in memory, per the localhost-only,
 * no-persistence invariant.
 */
import type { CommandExecutedEvent } from "../../layout/executor";
import { onCommandExecuted } from "../../layout/executor";

export const AUDIT_LOG_CAP = 500;

export interface AuditLogEntry {
  timestamp: number;
  source: CommandExecutedEvent["source"];
  command: string;
  paramSummary: string;
  result: "ok" | string;
}

type Listener = (entries: readonly AuditLogEntry[]) => void;

function summarizeParams(command: CommandExecutedEvent["command"]): string {
  const { type, ...rest } = command as Record<string, unknown>;
  const parts = Object.entries(rest)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => {
      if (k === "params" || k === "layout") return `${k}=…`;
      return `${k}=${JSON.stringify(v)}`;
    });
  return parts.join(" ");
}

function summarizeResult(event: CommandExecutedEvent): string {
  return event.result.ok ? "ok" : `error:${event.result.error.code}`;
}

function toEntry(event: CommandExecutedEvent): AuditLogEntry {
  return {
    timestamp: Date.now(),
    source: event.source,
    command: event.command.type,
    paramSummary: summarizeParams(event.command),
    result: summarizeResult(event),
  };
}

export function createAuditStore() {
  let entries: AuditLogEntry[] = [];
  const listeners = new Set<Listener>();

  function push(entry: AuditLogEntry): void {
    entries = [...entries, entry];
    if (entries.length > AUDIT_LOG_CAP) {
      entries = entries.slice(entries.length - AUDIT_LOG_CAP);
    }
    for (const listener of listeners) listener(entries);
  }

  const unsubscribe = onCommandExecuted((event) => {
    push(toEntry(event));
  });

  return {
    getEntries(): readonly AuditLogEntry[] {
      return entries;
    },
    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /**
     * Records a native (non-command) UI layout mutation — e.g. a dockview
     * drag-move/close that bypasses `executeCommand` entirely. Always
     * source:'ui' (native dockview gestures are UI-only) and always
     * result:'ok' (dockview doesn't report a native-gesture failure through
     * this path). Callers are responsible for de-duping/throttling before
     * calling this (see `DockviewShell`'s panel-set-signature comparison) —
     * this method unconditionally appends.
     */
    recordNativeLayoutChange(paramSummary: string): void {
      push({
        timestamp: Date.now(),
        source: "ui",
        command: "layout_changed_native",
        paramSummary,
        result: "ok",
      });
    },
    /** Test/dev-only teardown — mirrors registry's __reset convention. */
    __dispose(): void {
      unsubscribe();
      listeners.clear();
      entries = [];
    },
  };
}

export type AuditStore = ReturnType<typeof createAuditStore>;

/** Process-wide singleton the panel subscribes to (one audit feed per app,
 * same convention as the panel registry). */
export const auditStore = createAuditStore();
