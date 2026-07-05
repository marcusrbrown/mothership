/**
 * McpServer (SDK v1.29) exposing the eight `ide_*` tools over the WS bridge.
 * Tool input schemas mirror `layoutCommandSchema`'s members 1:1 (the single
 * parity choke point shared by UI and MCP callers) — each mutation tool
 * relays a `LayoutCommand`-shaped payload through `WsBridge.dispatch` and
 * returns the resulting serialized layout in the tool result (never bare
 * success). Reads
 * (`ide_list_panels`, `ide_get_layout`) relay a synthetic read request and
 * redact the reply via `redactForRead` before returning it.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  closePanelCommandSchema,
  focusCommandSchema,
  movePanelCommandSchema,
  openPanelCommandSchema,
  setLayoutCommandSchema,
  splitCommandSchema,
} from "../../src/layout/commands";
import { layoutStructureView, listPanelsView } from "./redact";
import type { WsBridge } from "./ws-bridge";

function toolTextResult(payload: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    isError,
  };
}

/** Relays a mutation command and shapes the MCP tool result: success →
 * `{layout}`; failure (including `unavailable`/`disconnected`/`timeout`
 * bridge errors and typed executor errors) → an `isError` result carrying
 * the typed error code/message, never a bare success. */
async function relayMutation(bridge: WsBridge, tool: string, params: unknown) {
  const res = await bridge.dispatch(tool, params);
  if (res.ok) {
    return toolTextResult({ layout: res.layout });
  }
  return toolTextResult({ error: res.error }, true);
}

/** Relays `ide_list_panels`: returns ONLY [{id, panelType, title}] — no
 * params, no paths, no layout geometry (disclosure boundary). */
async function relayListPanels(bridge: WsBridge, tool: string) {
  const res = await bridge.dispatch(tool, {});
  if (!res.ok) {
    return toolTextResult({ error: res.error }, true);
  }
  return toolTextResult({ panels: listPanelsView(res.layout) });
}

/** Relays `ide_get_layout`: returns the grid/group/panel structure agents
 * need (ordering/positioning + per-panel id/panelType/title) with ALL panel
 * `params` dropped — the allowlist gate for the disclosure boundary. */
async function relayGetLayout(bridge: WsBridge, tool: string) {
  const res = await bridge.dispatch(tool, {});
  if (!res.ok) {
    return toolTextResult({ error: res.error }, true);
  }
  return toolTextResult({ layout: layoutStructureView(res.layout) });
}

export function createIdeMcpServer(bridge: WsBridge): McpServer {
  const server = new McpServer({ name: "mothership-ide", version: "0.1.0" });

  server.registerTool(
    "ide_open_panel",
    {
      description: "Open a new panel in the workspace layout.",
      inputSchema: openPanelCommandSchema.shape,
    },
    (args) => relayMutation(bridge, "ide_open_panel", args),
  );

  server.registerTool(
    "ide_close_panel",
    {
      description: "Close an existing panel by id.",
      inputSchema: closePanelCommandSchema.shape,
    },
    (args) => relayMutation(bridge, "ide_close_panel", args),
  );

  server.registerTool(
    "ide_split",
    {
      description: "Open a new panel split relative to an existing panel.",
      inputSchema: splitCommandSchema.shape,
    },
    (args) => relayMutation(bridge, "ide_split", args),
  );

  server.registerTool(
    "ide_focus",
    {
      description: "Focus (activate) an existing panel by id.",
      inputSchema: focusCommandSchema.shape,
    },
    (args) => relayMutation(bridge, "ide_focus", args),
  );

  server.registerTool(
    "ide_move_panel",
    {
      description: "Move an existing panel relative to another panel.",
      inputSchema: movePanelCommandSchema.shape,
    },
    (args) => relayMutation(bridge, "ide_move_panel", args),
  );

  server.registerTool(
    "ide_set_layout",
    {
      description: "Replace the entire workspace layout.",
      inputSchema: setLayoutCommandSchema.shape,
    },
    (args) => relayMutation(bridge, "ide_set_layout", args),
  );

  server.registerTool(
    "ide_list_panels",
    {
      description:
        "List panels currently open in the workspace (panel types/titles only).",
      inputSchema: z.object({}).shape,
    },
    () => relayListPanels(bridge, "ide_list_panels"),
  );

  server.registerTool(
    "ide_get_layout",
    {
      description:
        "Get the current serialized workspace layout (paths redacted to names).",
      inputSchema: z.object({}).shape,
    },
    () => relayGetLayout(bridge, "ide_get_layout"),
  );

  return server;
}
