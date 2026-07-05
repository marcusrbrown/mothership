/**
 * WS envelope shared between the webview bridge (src/layout/bridge.ts) and
 * the Bun ide-server sidecar (sidecar/ide-server/ws-bridge.ts). This module
 * is webview-owned; the sidecar imports it directly (same repo, no publish
 * step) so both sides share one source of truth for wire shapes.
 *
 * Auth: the first frame a connecting WS client must send is
 * `BridgeAuthFrame`, carrying the bearer token issued by the Rust
 * supervisor (browser WebSocket can't set headers, so this is the only
 * auth surface). Anything else as the first frame, or a wrong token,
 * closes the socket before any command flows.
 */
import { z } from "zod";
import { layoutCommandSchema } from "./commands";

export const bridgeAuthFrameSchema = z.object({
  kind: z.literal("auth"),
  token: z.string().min(1),
});
export type BridgeAuthFrame = z.infer<typeof bridgeAuthFrameSchema>;

/** A relayed layout mutation/read the sidecar dispatches to the webview. */
export const bridgeRequestSchema = z.object({
  kind: z.literal("request"),
  seq: z.number().int().nonnegative(),
  tool: z.string().min(1),
  params: z.unknown(),
});
export type BridgeRequest = z.infer<typeof bridgeRequestSchema>;

/** The webview's reply to a `BridgeRequest`. */
export const bridgeResponseSchema = z.object({
  kind: z.literal("response"),
  seq: z.number().int().nonnegative(),
  ok: z.boolean(),
  layout: z.record(z.string(), z.unknown()).optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});
export type BridgeResponse = z.infer<typeof bridgeResponseSchema>;

export const bridgeMessageSchema = z.discriminatedUnion("kind", [
  bridgeAuthFrameSchema,
  bridgeRequestSchema,
  bridgeResponseSchema,
]);
export type BridgeMessage = z.infer<typeof bridgeMessageSchema>;

/** Tool-name → command-shape mapping. Mutation tools mirror `layoutCommandSchema`
 * members 1:1 (the `type` discriminant is renamed to the MCP tool name at
 * this layer only — the payload validated on the wire is the command itself). */
export const MUTATION_TOOL_NAMES = [
  "ide_open_panel",
  "ide_close_panel",
  "ide_split",
  "ide_focus",
  "ide_move_panel",
  "ide_set_layout",
] as const;
export type MutationToolName = (typeof MUTATION_TOOL_NAMES)[number];

export const READ_TOOL_NAMES = ["ide_list_panels", "ide_get_layout"] as const;
export type ReadToolName = (typeof READ_TOOL_NAMES)[number];

/** Re-exported so the sidecar can validate relayed request params against
 * the exact same schema the executor uses (the single parity choke point
 * shared by UI and MCP callers). */
export { layoutCommandSchema };
