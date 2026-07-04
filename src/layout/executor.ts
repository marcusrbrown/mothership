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
import { hasPanelType } from "./registry";

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

function err(code: LayoutErrorCode, message: string): CommandResult {
  return { ok: false, error: { code, message } };
}

function runCommand(
  cmd: LayoutCommand,
  adapter: DockviewAdapter,
): CommandResult {
  switch (cmd.type) {
    case "open_panel": {
      if (!hasPanelType(cmd.panelType)) {
        return err(
          "unknown_panel_type",
          `No panel type registered for "${cmd.panelType}"`,
        );
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
  const parsed = layoutCommandSchema.safeParse(cmd);
  const result: CommandResult = parsed.success
    ? runCommand(parsed.data, adapter)
    : err("invalid_layout", parsed.error?.message ?? "Invalid command payload");

  const source = options?.source ?? "ui";
  for (const listener of listeners) {
    listener({ source, command: cmd, result });
  }

  return result;
}
