/**
 * The one typed command layer both the UI and the `ide_*` MCP tools call.
 * Discriminated union of layout mutations, plus the typed result envelope
 * every command returns. Zod schemas here become the `ide_*` tool schemas
 * — this module is the single parity choke point shared by UI and MCP callers.
 */
import { z } from "zod";

/** Serialized layout shape returned after every mutation (mirrors dockview's SerializedDockview, kept opaque/JSON-safe at this layer). */
export type SerializedLayout = Record<string, unknown>;

export const splitDirectionSchema = z.enum(["left", "right", "up", "down"]);
export type SplitDirection = z.infer<typeof splitDirectionSchema>;

export const openPanelCommandSchema = z.object({
  type: z.literal("open_panel"),
  panelId: z.string().min(1),
  panelType: z.string().min(1),
  title: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});
export type OpenPanelCommand = z.infer<typeof openPanelCommandSchema>;

export const closePanelCommandSchema = z.object({
  type: z.literal("close_panel"),
  panelId: z.string().min(1),
});
export type ClosePanelCommand = z.infer<typeof closePanelCommandSchema>;

export const splitCommandSchema = z.object({
  type: z.literal("split"),
  panelId: z.string().min(1),
  panelType: z.string().min(1),
  referencePanelId: z.string().min(1),
  direction: splitDirectionSchema,
  title: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});
export type SplitCommand = z.infer<typeof splitCommandSchema>;

export const focusCommandSchema = z.object({
  type: z.literal("focus"),
  panelId: z.string().min(1),
});
export type FocusCommand = z.infer<typeof focusCommandSchema>;

export const movePanelCommandSchema = z.object({
  type: z.literal("move_panel"),
  panelId: z.string().min(1),
  referencePanelId: z.string().min(1),
  direction: splitDirectionSchema,
});
export type MovePanelCommand = z.infer<typeof movePanelCommandSchema>;

export const setLayoutCommandSchema = z.object({
  type: z.literal("set_layout"),
  layout: z.record(z.string(), z.unknown()),
});
export type SetLayoutCommand = z.infer<typeof setLayoutCommandSchema>;

export const layoutCommandSchema = z.discriminatedUnion("type", [
  openPanelCommandSchema,
  closePanelCommandSchema,
  splitCommandSchema,
  focusCommandSchema,
  movePanelCommandSchema,
  setLayoutCommandSchema,
]);
export type LayoutCommand = z.infer<typeof layoutCommandSchema>;

export type LayoutErrorCode =
  | "panel_not_found"
  | "unknown_panel_type"
  | "invalid_layout"
  | "reference_panel_not_found"
  | "panel_not_mcp_openable";

export interface LayoutError {
  code: LayoutErrorCode;
  message: string;
}

export type CommandSource = "ui" | "mcp_tool";

export type CommandResult =
  | { ok: true; layout: SerializedLayout }
  | { ok: false; error: LayoutError };
