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
 *
 * Domain envelope: a `BridgeResponse` is discriminated by
 * `domain: "layout" | "session"` so a layout-shaped reply (`layout`) and
 * a session-tool-shaped reply (`data`) can never be confused with one
 * another — `.superRefine` below refuses a response that carries the
 * field belonging to the other domain, even if the literal `domain` tag
 * matches. `domain` DEFAULTS to `"layout"` when absent so every relayed
 * layout response predating this field continues to parse unchanged.
 */
import { z } from "zod";
import { layoutCommandSchema } from "./commands";

export const bridgeAuthFrameSchema = z.object({
  kind: z.literal("auth"),
  token: z.string().min(1),
});
export type BridgeAuthFrame = z.infer<typeof bridgeAuthFrameSchema>;

/** A relayed layout mutation/read OR session-tool call the sidecar
 * dispatches to the webview. `tool` names the MCP tool; routing to the
 * layout or session domain is decided by `src/layout/bridge.ts` from the
 * validated `tool` string, never from wire-supplied domain metadata (a
 * request never declares its own domain — only the response does). */
export const bridgeRequestSchema = z.object({
  kind: z.literal("request"),
  seq: z.number().int().nonnegative(),
  tool: z.string().min(1),
  params: z.unknown(),
});
export type BridgeRequest = z.infer<typeof bridgeRequestSchema>;

/** Stable delivery classification mirrored from
 * `src/ide/commands.ts`'s `SessionToolErrorDelivery` — duplicated here
 * (not imported) so this wire-protocol module has no compile-time
 * dependency on the `src/ide/*` domain; only `src/layout/bridge.ts` (the
 * bridge) is allowed to import both. */
export const bridgeErrorDeliverySchema = z.enum(["not_sent", "indeterminate"]);
export type BridgeErrorDelivery = z.infer<typeof bridgeErrorDeliverySchema>;

/** A typed failure, shared verbatim by both domains. `code` is left as a
 * bare string (not a literal enum) at the wire-protocol layer — layout
 * and session error codes are two different closed sets owned by their
 * respective domains (`LayoutErrorCode`, `SessionToolErrorCode`); this
 * module only needs to move the value across the wire, never branch on
 * it. `message` is always a stable, sanitized, program-owned string on
 * both sides (see `src/ide/errors.ts`, `src/layout/executor.ts`) — never
 * raw path/payload/exception text. */
export const bridgeErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  delivery: bridgeErrorDeliverySchema.optional(),
});
export type BridgeError = z.infer<typeof bridgeErrorSchema>;

/**
 * Builds the ONE representable `domain: "transport"` error response —
 * a failure not attributable to layout or session logic at all: a
 * malformed/unparseable incoming frame, an unexpected exception raised
 * by routing itself (after `handleBridgeRequest` already decided a
 * domain), or a send-path failure. Always `ok:false`, `delivery` always
 * `"not_sent"` unless the caller explicitly overrides it (an
 * already-routed request that fails AFTER invoking a domain handler is
 * `"indeterminate"`, never `"not_sent"`, mirroring
 * `src/ide/executor.ts`'s pre-handler-vs-post-handler split).
 */
export function transportError(
  seq: number,
  code: string,
  message: string,
  delivery: BridgeErrorDelivery = "not_sent",
): BridgeResponse {
  return {
    kind: "response",
    domain: "transport",
    seq,
    ok: false,
    error: { code, message, delivery },
  };
}

/** Every terminal shape a `BridgeResponse` may take, discriminated by the
 * `(domain, ok)` pair — NOT just `domain` — so `ok`/`error`/`data`/
 * `layout` presence is enforced exactly per shape, not merely "the
 * field belonging to the other domain is absent":
 *
 * - `layout` + `ok:true`  → `layout` REQUIRED, `error`/`data` absent.
 * - `layout` + `ok:false` → `error` REQUIRED, `layout`/`data` absent.
 * - `session` + `ok:true`  → `data` REQUIRED, `error`/`layout` absent.
 * - `session` + `ok:false` → `error` REQUIRED, `data`/`layout` absent.
 * - `transport` — error-only (a domain unattributable to layout/session:
 *   an unknown/malformed request, or an internal transport failure) —
 *   `ok:true` is not a representable transport shape at all; `error`
 *   REQUIRED, `data`/`layout` absent.
 *
 * A raw `.optional()` field on a single flat object schema (the
 * previous shape) can only ever prove "field X is present/absent" —
 * it cannot prove "field X is present WHEN it must be", which is what
 * lets a `ok:true` response with no `layout`/`data` at all silently
 * pass. A discriminated union of exact shapes proves both directions. */
const layoutOkResponseSchema = z
  .object({
    kind: z.literal("response"),
    domain: z.literal("layout"),
    seq: z.number().int().nonnegative(),
    ok: z.literal(true),
    layout: z.record(z.string(), z.unknown()),
  })
  .strict();
const layoutErrorResponseSchema = z
  .object({
    kind: z.literal("response"),
    domain: z.literal("layout"),
    seq: z.number().int().nonnegative(),
    ok: z.literal(false),
    error: bridgeErrorSchema,
  })
  .strict();
const sessionOkResponseSchema = z
  .object({
    kind: z.literal("response"),
    domain: z.literal("session"),
    seq: z.number().int().nonnegative(),
    ok: z.literal(true),
    /** The session tool's allowlisted result payload (never raw
     * upstream/transcript text at this layer; the session tool's own
     * result schema / view serializers are responsible for that
     * boundary). */
    data: z.unknown(),
  })
  .strict();
const sessionErrorResponseSchema = z
  .object({
    kind: z.literal("response"),
    domain: z.literal("session"),
    seq: z.number().int().nonnegative(),
    ok: z.literal(false),
    error: bridgeErrorSchema,
  })
  .strict();
/** A domain not attributable to layout or session at all — an unknown/
 * malformed incoming request, or an internal transport failure (send
 * throw, stale-generation response, unexpected post-routing rejection).
 * Error-only: there is no representable `ok:true` transport shape. */
const transportErrorResponseSchema = z
  .object({
    kind: z.literal("response"),
    domain: z.literal("transport"),
    seq: z.number().int().nonnegative(),
    ok: z.literal(false),
    error: bridgeErrorSchema,
  })
  .strict();

/** Legacy (pre-`domain`-field) layout responses: every response on the
 * wire before this field existed was implicitly `domain: "layout"` —
 * this branch accepts EXACTLY those two shapes with `domain` omitted
 * and injects the literal default, so old traffic keeps parsing. A
 * missing-domain response that does NOT match one of these two valid
 * legacy layout shapes (e.g. carries `data` — never a valid pre-`domain`
 * wire shape) is rejected outright, not silently coerced into some
 * domain by a bare default. */
const legacyLayoutOkResponseSchema = z
  .object({
    kind: z.literal("response"),
    seq: z.number().int().nonnegative(),
    ok: z.literal(true),
    layout: z.record(z.string(), z.unknown()),
  })
  .strict()
  .transform((v) => ({ ...v, domain: "layout" as const }));
const legacyLayoutErrorResponseSchema = z
  .object({
    kind: z.literal("response"),
    seq: z.number().int().nonnegative(),
    ok: z.literal(false),
    error: bridgeErrorSchema,
  })
  .strict()
  .transform((v) => ({ ...v, domain: "layout" as const }));

export const bridgeResponseSchema = z.union([
  layoutOkResponseSchema,
  layoutErrorResponseSchema,
  sessionOkResponseSchema,
  sessionErrorResponseSchema,
  transportErrorResponseSchema,
  legacyLayoutOkResponseSchema,
  legacyLayoutErrorResponseSchema,
]);
export type BridgeResponse = z.infer<typeof bridgeResponseSchema>;

/**
 * A structurally loose view of `BridgeResponse` with every field
 * optional — exists ONLY so test code can access `res.layout`/`res.data`/
 * `res.error` without manually narrowing the exact discriminated shape
 * first. Never used by production code (`bridge.ts` always constructs
 * one of the exact literal shapes above, and `bridgeResponseSchema`
 * remains the real runtime gate) — this type performs no validation of
 * its own.
 */
export type LooseBridgeResponse = {
  kind: "response";
  domain: "layout" | "session" | "transport";
  seq: number;
  ok: boolean;
  layout?: Record<string, unknown>;
  data?: unknown;
  error?: BridgeError;
};

/** A plain `z.union` (not `z.discriminatedUnion`) — `bridgeResponseSchema`
 * is itself a plain union of 7 branches (zod v4 does not support nesting
 * a discriminated union inside another discriminated union's branch
 * list), so the outer envelope union must be plain too. */
export const bridgeMessageSchema = z.union([
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
