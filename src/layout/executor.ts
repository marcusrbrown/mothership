/**
 * The sole owner of dockview's imperative API (via the DockviewAdapter seam).
 * Every UI handler and every `ide_*` MCP tool calls `executeCommand` — this is
 * the parity choke point for R10. Command semantics are pure logic, testable
 * against a stubbed adapter with no DOM.
 */
import type { DockviewAdapter } from "./adapter";
import {
  type CommandResult,
  type CommandSource,
  type LayoutCommand,
  type LayoutErrorCode,
  layoutCommandSchema,
} from "./commands";
import { hasPanelType, isMcpOpenable } from "./registry";

export interface CommandExecutedEvent {
  source: CommandSource;
  command: LayoutCommand;
  result: CommandResult;
}

type Listener = (event: CommandExecutedEvent) => void;

const listeners = new Set<Listener>();

/** Subscribe to every executed command (source-tagged). Feeds U1.7's audit log. */
export function onCommandExecuted(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let commandDepth = 0;

/**
 * True while `executeCommand` is synchronously running an adapter mutation
 * (dockview-core's `onDidLayoutChange` fires synchronously within that same
 * call). Lets a native-layout-change listener (DockviewShell) distinguish
 * "this layout change came from a command we already audited" from "this
 * layout change came from a native dockview gesture (drag/close) that
 * bypassed the command layer" — avoiding double-counting the same mutation
 * as both a command entry and a native entry (U1.7 audit-completeness fix).
 */
export function isCommandExecuting(): boolean {
  return commandDepth > 0;
}

function err(code: LayoutErrorCode, message: string): CommandResult {
  return { ok: false, error: { code, message } };
}

/** Extracts every `contentComponent` (panel type) referenced by a
 * serialized layout's `panels` map. Best-effort/defensive — an
 * unrecognized shape yields no panel types, which fails the mcp-openable
 * check closed for `set_layout` (nothing to allow through). */
function panelTypesInLayout(layout: Record<string, unknown>): string[] {
  const panels = layout.panels;
  if (!panels || typeof panels !== "object") return [];
  const types: string[] = [];
  for (const raw of Object.values(panels as Record<string, unknown>)) {
    // Real dockview-core serializes panel type as `contentComponent`; the
    // executor's own test stub (test-stub-adapter.ts) uses `panelType` for
    // the same concept — accept either so this check works against both.
    const entry = raw as {
      contentComponent?: unknown;
      panelType?: unknown;
    } | null;
    const type = entry?.contentComponent ?? entry?.panelType;
    if (typeof type === "string") types.push(type);
  }
  return types;
}

function mcpOpenCapabilityError(panelType: string): CommandResult {
  return err(
    "panel_not_mcp_openable",
    `Panel type "${panelType}" cannot be opened by an mcp_tool-origin command`,
  );
}

function runCommand(
  cmd: LayoutCommand,
  adapter: DockviewAdapter,
  source: CommandSource,
): CommandResult {
  switch (cmd.type) {
    case "open_panel": {
      if (!hasPanelType(cmd.panelType)) {
        return err(
          "unknown_panel_type",
          `No panel type registered for "${cmd.panelType}"`,
        );
      }
      if (source === "mcp_tool" && !isMcpOpenable(cmd.panelType)) {
        return mcpOpenCapabilityError(cmd.panelType);
      }
      adapter.addPanel({
        id: cmd.panelId,
        panelType: cmd.panelType,
        title: cmd.title,
        params: cmd.params,
        position: undefined,
      });
      return { ok: true, layout: adapter.toJSON() };
    }

    case "close_panel": {
      if (!adapter.hasPanel(cmd.panelId)) {
        return err("panel_not_found", `No panel with id "${cmd.panelId}"`);
      }
      adapter.removePanel(cmd.panelId);
      return { ok: true, layout: adapter.toJSON() };
    }

    case "split": {
      if (!hasPanelType(cmd.panelType)) {
        return err(
          "unknown_panel_type",
          `No panel type registered for "${cmd.panelType}"`,
        );
      }
      if (!adapter.hasPanel(cmd.referencePanelId)) {
        return err(
          "reference_panel_not_found",
          `No panel with id "${cmd.referencePanelId}"`,
        );
      }
      if (source === "mcp_tool" && !isMcpOpenable(cmd.panelType)) {
        return mcpOpenCapabilityError(cmd.panelType);
      }
      adapter.addPanel({
        id: cmd.panelId,
        panelType: cmd.panelType,
        title: cmd.title,
        params: cmd.params,
        position: {
          referencePanelId: cmd.referencePanelId,
          direction: cmd.direction,
        },
      });
      return { ok: true, layout: adapter.toJSON() };
    }

    case "focus": {
      if (!adapter.hasPanel(cmd.panelId)) {
        return err("panel_not_found", `No panel with id "${cmd.panelId}"`);
      }
      adapter.focus(cmd.panelId);
      return { ok: true, layout: adapter.toJSON() };
    }

    case "move_panel": {
      if (!adapter.hasPanel(cmd.panelId)) {
        return err("panel_not_found", `No panel with id "${cmd.panelId}"`);
      }
      if (!adapter.hasPanel(cmd.referencePanelId)) {
        return err(
          "reference_panel_not_found",
          `No panel with id "${cmd.referencePanelId}"`,
        );
      }
      adapter.movePanel({
        id: cmd.panelId,
        referencePanelId: cmd.referencePanelId,
        direction: cmd.direction,
      });
      return { ok: true, layout: adapter.toJSON() };
    }

    case "set_layout": {
      if (
        typeof cmd.layout !== "object" ||
        cmd.layout === null ||
        Array.isArray(cmd.layout)
      ) {
        return err("invalid_layout", "Layout payload must be a JSON object");
      }
      if (source === "mcp_tool") {
        const offender = panelTypesInLayout(cmd.layout).find(
          (t) => !isMcpOpenable(t),
        );
        if (offender) {
          return mcpOpenCapabilityError(offender);
        }
      }
      try {
        adapter.fromJSON(cmd.layout);
      } catch (cause) {
        return err(
          "invalid_layout",
          cause instanceof Error ? cause.message : "Failed to load layout",
        );
      }
      return { ok: true, layout: adapter.toJSON() };
    }

    default: {
      const _exhaustive: never = cmd;
      return _exhaustive;
    }
  }
}

/**
 * Validate + execute a layout command against the given adapter. Never
 * throws for well-formed-but-invalid commands (nonexistent ids, malformed
 * `set_layout` payloads) — those return typed error results.
 */
export function executeCommand(
  cmd: LayoutCommand,
  adapter: DockviewAdapter,
  options?: { source?: CommandSource },
): CommandResult {
  const source = options?.source ?? "ui";
  const parsed = layoutCommandSchema.safeParse(cmd);

  // An adapter call throwing (e.g. a dockview-core internal error) must
  // still leave an audit trail rather than vanishing — wrap runCommand so
  // a throw becomes a typed error result before the listener emit, not an
  // uncaught exception that skips it (U1.7 audit-completeness fix).
  let result: CommandResult;
  if (!parsed.success) {
    result = err(
      "invalid_layout",
      parsed.error?.message ?? "Invalid command payload",
    );
  } else {
    commandDepth++;
    try {
      result = runCommand(parsed.data, adapter, source);
    } catch (cause) {
      result = err(
        "invalid_layout",
        cause instanceof Error ? cause.message : "Command execution failed",
      );
    } finally {
      commandDepth--;
    }
  }

  for (const listener of listeners) {
    listener({ source, command: cmd, result });
  }

  return result;
}
