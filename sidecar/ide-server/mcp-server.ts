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
  type BridgeError,
  type BridgeResponse,
  bridgeDispatchAttemptMetaSchema,
} from "../../src/layout/bridge-protocol";
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

/** Program-owned, stable message for every closed bridge error code this
 * boundary can see — transport codes (`unavailable`/`send_failed`/
 * `replaced`/`disconnected`/`timeout`/`unknown_tool`/`internal_error`/
 * `invalid_request`), layout codes (`LayoutErrorCode`), and session codes
 * (`SessionToolErrorCode`). A code's own upstream/handler-constructed
 * `message` — which may itself echo caller-supplied or upstream text — is
 * NEVER forwarded past this boundary; only this table's value is. */
const BRIDGE_ERROR_CODE_MESSAGES: Record<string, string> = {
  // transport (sidecar/ide-server/ws-bridge.ts, src/layout/bridge.ts)
  unavailable: "No webview client is connected.",
  send_failed: "The request could not be sent to the webview.",
  replaced: "The webview connection was replaced before a reply arrived.",
  disconnected: "The webview disconnected before a reply arrived.",
  timeout: "The request timed out waiting for a reply.",
  unknown_tool: "No tool matches the given name.",
  internal_error: "An internal error occurred.",
  invalid_request: "The given request is invalid.",
  // layout (src/layout/commands.ts LayoutErrorCode)
  panel_not_found: "No panel matches the given id.",
  unknown_panel_type: "No panel type is registered for the given value.",
  invalid_layout: "The given layout command is invalid.",
  reference_panel_not_found: "No reference panel matches the given id.",
  panel_not_mcp_openable: "The given panel type cannot be opened via MCP.",
  // session (src/ide/commands.ts SessionToolErrorCode)
  invalid_arguments: "The given arguments are invalid.",
  invalid_target: "The given target is invalid.",
  unknown_project: "No roster project matches the given name.",
  ambiguous_project:
    "The given project name matches more than one roster project.",
  unknown_session: "No session matches the given id.",
  session_project_mismatch:
    "The given session belongs to a different project than the one specified.",
  upstream_error: "The upstream operation failed.",
};

/** The closed set of codes this boundary actually recognizes — derived
 * from the message table above so the two can never drift apart. */
const KNOWN_BRIDGE_ERROR_CODES = new Set(
  Object.keys(BRIDGE_ERROR_CODE_MESSAGES),
);

/** The closed delivery enum (mirrors `bridgeErrorDeliverySchema` in
 * `src/layout/bridge-protocol.ts`, duplicated here rather than imported
 * so this boundary validates the value against a real closed set instead
 * of trusting whatever string arrived on the wire). */
const KNOWN_DELIVERY_VALUES = new Set(["not_sent", "indeterminate"]);

/** Normalizes ANY `!res.ok` bridge error at the sidecar MCP boundary
 * into an ALLOWLISTED, closed result: an unrecognized/malformed `code`
 * (including a path/token/header-shaped string that isn't a real code at
 * all) never passes through — it maps to the stable `internal_error`
 * code and its generic message, exactly as if the code had never been
 * recognized. A recognized code gets this table's stable message for
 * that code. `delivery` is preserved only when it is one of the two real
 * closed enum values; anything else is dropped. The bridge/webview's own
 * `message`, whatever it contains, is NEVER forwarded in either case. */
function normalizedError(error: BridgeError) {
  const code = KNOWN_BRIDGE_ERROR_CODES.has(error.code)
    ? error.code
    : "internal_error";
  const attemptParsed = bridgeDispatchAttemptMetaSchema.safeParse(
    error.attempt,
  );
  return {
    code,
    message: BRIDGE_ERROR_CODE_MESSAGES[code],
    ...(error.delivery !== undefined &&
      KNOWN_DELIVERY_VALUES.has(error.delivery) && {
        delivery: error.delivery,
      }),
    ...(attemptParsed.success && { attempt: attemptParsed.data }),
  };
}

/** A stable, sanitized MCP error for a bridge response that reached a
 * domain-specific relay but is not actually an `expectedDomain` success —
 * e.g. a session-domain response routed to a layout relay, or vice versa.
 * Never includes the mismatched response's raw payload/message, only a
 * stable code naming the mismatch. */
function unexpectedDomainResult(
  res: BridgeResponse,
  expectedDomain: BridgeResponse["domain"] = "layout",
) {
  return toolTextResult(
    {
      error: {
        code: "unexpected_domain",
        message: `expected a ${expectedDomain}-domain response, got domain:"${res.domain}"`,
      },
    },
    true,
  );
}

/** Relays a session-tool call (project/session discovery, context, focus)
 * and shapes the MCP tool result: success → the webview's already
 * allowlisted `data` payload verbatim, as-is (the webview's own view
 * serializers are the disclosure boundary; this relay adds no second,
 * divergent serialization step); failure → an `isError` result carrying
 * the typed error code/message, never a bare success. A response that is
 * `ok:true` but NOT `domain:"session"` is also a typed error, never read
 * as if it carried session data. */
async function relaySession(bridge: WsBridge, tool: string, params: unknown) {
  const res = await bridge.dispatch(tool, params);
  if (res.ok && res.domain === "session") {
    return toolTextResult(res.data);
  }
  if (!res.ok) {
    return toolTextResult({ error: normalizedError(res.error) }, true);
  }
  return unexpectedDomainResult(res, "session");
}

const NO_ARGS_ERROR_RESULT = toolTextResult(
  {
    error: {
      code: "invalid_arguments",
      message: "This tool takes no arguments.",
      delivery: "not_sent",
    },
  },
  true,
);

/** Relays a no-argument session tool WITHOUT relying on the SDK's own
 * schema-rejection path — the SDK's `InvalidParams` error text echoes the
 * caller's own unrecognized key names verbatim (`Unrecognized key:
 * "<key>"`), which is a disclosure leak for a caller-controlled string.
 * `inputSchema` is intentionally permissive (`.passthrough()`) so every
 * key reaches this function unfiltered; own-key-count validation happens
 * HERE, before the bridge is ever dispatched, and the rejection carries
 * only a fixed stable message — no caller-supplied key or value name is
 * ever echoed, in either direction. */
async function relayNoArgSession(
  bridge: WsBridge,
  tool: string,
  args: Record<string, unknown>,
) {
  if (Object.keys(args).length > 0) {
    return NO_ARGS_ERROR_RESULT;
  }
  return relaySession(bridge, tool, {});
}

/** Relays a mutation command and shapes the MCP tool result: success →
 * `{layout}` with the layout passed through `layoutStructureView` (the same
 * allowlist gate the read path uses — params, including any `context`
 * credentials, are dropped); failure (including `unavailable`/`disconnected`/
 * `timeout` bridge errors and typed executor errors) → an `isError` result
 * carrying the typed error code/message, never a bare success. A response
 * that is `ok:true` but NOT `domain:"layout"` (e.g. a session-tool result
 * misrouted to a layout relay) is also a typed error, never read as if it
 * carried a layout — `res.layout` only exists on the `domain:"layout"`
 * branch of `BridgeResponse`. */
async function relayMutation(bridge: WsBridge, tool: string, params: unknown) {
  const res = await bridge.dispatch(tool, params);
  if (res.ok && res.domain === "layout") {
    return toolTextResult({ layout: layoutStructureView(res.layout) });
  }
  if (!res.ok) {
    return toolTextResult({ error: normalizedError(res.error) }, true);
  }
  return unexpectedDomainResult(res);
}

/** Relays `ide_list_panels`: returns ONLY [{id, panelType, title}] — no
 * params, no paths, no layout geometry (disclosure boundary). A response
 * that is `ok:true` but not `domain:"layout"` is a typed error, never an
 * empty-panels fallback. */
async function relayListPanels(bridge: WsBridge, tool: string) {
  const res = await bridge.dispatch(tool, {});
  if (!res.ok) {
    return toolTextResult({ error: normalizedError(res.error) }, true);
  }
  if (res.domain !== "layout") {
    return unexpectedDomainResult(res);
  }
  return toolTextResult({ panels: listPanelsView(res.layout) });
}

/** Relays `ide_get_layout`: returns the grid/group/panel structure agents
 * need (ordering/positioning + per-panel id/panelType/title) with ALL panel
 * `params` dropped — the allowlist gate for the disclosure boundary. A
 * response that is `ok:true` but not `domain:"layout"` is a typed error,
 * never an empty-layout fallback. */
async function relayGetLayout(bridge: WsBridge, tool: string) {
  const res = await bridge.dispatch(tool, {});
  if (!res.ok) {
    return toolTextResult({ error: normalizedError(res.error) }, true);
  }
  if (res.domain !== "layout") {
    return unexpectedDomainResult(res);
  }
  return toolTextResult({ layout: layoutStructureView(res.layout) });
}

/** Applied to `ide_list_projects`/`ide_list_sessions`/`ide_get_active_context`
 * — pure discovery reads: never mutate state, safe to retry, never
 * destructive, and scoped entirely to this codebase's own roster/session
 * state (never an open-world/external-effect call). */
const READ_ONLY_SESSION_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  destructiveHint: false,
  openWorldHint: false,
};

/** Applied to `ide_select_project`/`ide_select_session` — these DO mutate
 * UI focus state, so `readOnlyHint` is false, but selecting the same
 * target twice leaves the same end state (idempotent), never destroys
 * anything, and stays scoped to this codebase's own roster/session state
 * (never open-world). */
const FOCUS_SESSION_ANNOTATIONS = {
  readOnlyHint: false,
  idempotentHint: true,
  destructiveHint: false,
  openWorldHint: false,
};

/** Applied to `ide_dispatch_prompt` — mutates OpenCode state (creates a
 * session or sends a prompt/message), so `readOnlyHint` is false;
 * repeating the SAME call sends a SECOND prompt/creates a SECOND
 * session, so `idempotentHint` is false (never safe to blindly retry);
 * never deletes/destroys existing state, so `destructiveHint` is false;
 * scoped entirely to this codebase's own roster/session state (never an
 * external open-world effect), so `openWorldHint` is false. */
const DISPATCH_PROMPT_ANNOTATIONS = {
  readOnlyHint: false,
  idempotentHint: false,
  destructiveHint: false,
  openWorldHint: false,
};

/** Base (unrefined) input schema for `ide_dispatch_prompt` — deliberately
 * `.passthrough()`, mirroring `relayNoArgSession`'s own pattern, so ANY
 * key the caller supplies (including `onPendingQuestion`, `messageId`,
 * or an unrelated credential-shaped key) reaches `isValidDispatchPromptArgs`
 * unfiltered instead of being silently stripped by the SDK's own
 * (non-strict-by-default) zod parsing — a silently-stripped override
 * attempt is a policy bypass a caller could never observe; an explicit
 * rejection is not. The actual exactly-one-of-project-or-sessionId /
 * no-undeclared-field / non-empty-prompt enforcement happens in
 * `isValidDispatchPromptArgs` below, which also guarantees a rejection
 * never echoes the caller's raw key names or values (the SDK's own
 * schema-rejection path does). */
const dispatchPromptInputSchema = z
  .object({
    project: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    prompt: z.string().min(1),
    title: z.string().min(1).optional(),
  })
  .passthrough();

const DISPATCH_PROMPT_KNOWN_KEYS = new Set([
  "project",
  "sessionId",
  "prompt",
  "title",
]);

/** True only for a raw args object carrying only `DISPATCH_PROMPT_KNOWN_KEYS`
 * with exactly one of `project`/`sessionId` set — no undeclared key
 * (`onPendingQuestion`, `messageId`, or anything else), never both/neither
 * target field, and a non-empty `prompt`. Never throws. */
function isValidDispatchPromptArgs(args: Record<string, unknown>): args is {
  project?: string;
  sessionId?: string;
  prompt: string;
  title?: string;
} {
  for (const key of Object.keys(args)) {
    if (!DISPATCH_PROMPT_KNOWN_KEYS.has(key)) return false;
  }
  const hasProject = typeof args.project === "string" && args.project !== "";
  const hasSessionId =
    typeof args.sessionId === "string" && args.sessionId !== "";
  if (hasProject === hasSessionId) return false;
  if (typeof args.prompt !== "string" || args.prompt === "") return false;
  if (args.title !== undefined && typeof args.title !== "string") {
    return false;
  }
  return true;
}

const DISPATCH_PROMPT_INVALID_ARGS_RESULT = toolTextResult(
  {
    error: {
      code: "invalid_arguments",
      message: "The given arguments are invalid.",
      delivery: "not_sent",
    },
  },
  true,
);

/** Relays `ide_dispatch_prompt` — the one non-idempotent, mutating
 * session tool. Own-schema validation happens BEFORE the bridge is ever
 * dispatched (see `isValidDispatchPromptArgs`), for the same
 * caller-echo-avoidance reason `relayNoArgSession` validates its own
 * shape instead of relying on the SDK's own `InvalidParams` rejection. A
 * successful relay's payload is forwarded verbatim — the webview
 * executor's own strict result schema is the disclosure boundary; this
 * relay adds no second, divergent serialization step. */
async function relayDispatchPrompt(
  bridge: WsBridge,
  args: Record<string, unknown>,
) {
  if (!isValidDispatchPromptArgs(args)) {
    return DISPATCH_PROMPT_INVALID_ARGS_RESULT;
  }
  return relaySession(bridge, "ide_dispatch_prompt", args);
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

  server.registerTool(
    "ide_list_projects",
    {
      description:
        "List known projects by name and status. Takes no arguments.",
      inputSchema: z.object({}).passthrough(),
      annotations: READ_ONLY_SESSION_ANNOTATIONS,
    },
    (args) => relayNoArgSession(bridge, "ide_list_projects", args),
  );

  server.registerTool(
    "ide_list_sessions",
    {
      description:
        "List sessions for one project, identified by its logical project name (never a filesystem path).",
      inputSchema: z.object({
        project: z.string(),
        includeSubagents: z.boolean().default(false),
      }).shape,
      annotations: READ_ONLY_SESSION_ANNOTATIONS,
    },
    (args) => relaySession(bridge, "ide_list_sessions", args),
  );

  server.registerTool(
    "ide_get_active_context",
    {
      description:
        "Get the current project and visible session id. Takes no arguments.",
      inputSchema: z.object({}).passthrough(),
      annotations: READ_ONLY_SESSION_ANNOTATIONS,
    },
    (args) => relayNoArgSession(bridge, "ide_get_active_context", args),
  );

  server.registerTool(
    "ide_select_project",
    {
      description:
        "Set the active project, identified by its logical project name (never a filesystem path).",
      inputSchema: z.object({ project: z.string() }).shape,
      annotations: FOCUS_SESSION_ANNOTATIONS,
    },
    (args) => relaySession(bridge, "ide_select_project", args),
  );

  server.registerTool(
    "ide_select_session",
    {
      description:
        "Set the active session, identified by its session id and optionally scoped to a logical project name (never filesystem paths).",
      inputSchema: z.object({
        sessionId: z.string(),
        project: z.string().optional(),
      }).shape,
      annotations: FOCUS_SESSION_ANNOTATIONS,
    },
    (args) => relaySession(bridge, "ide_select_session", args),
  );

  server.registerTool(
    "ide_dispatch_prompt",
    {
      description:
        "Create a new session in a project or continue an exact existing session by sending it a prompt, identified only by a logical project name or session id (never a filesystem path). This mutates OpenCode state and is NOT idempotent — sending the same call twice creates two sessions or sends two prompts. Never blindly retry after a timeout or disconnect; on an indeterminate result, list recent sessions and inspect bounded transcripts to confirm what happened before retrying by hand. A follow-up against a session with a pending question is refused (a typed blocked result), never silently sent as that question's answer.",
      inputSchema: dispatchPromptInputSchema,
      annotations: DISPATCH_PROMPT_ANNOTATIONS,
    },
    (args) => relayDispatchPrompt(bridge, args),
  );

  return server;
}

/** The six session-tool names registered above — kept alongside the
 * registrations as the sidecar-side name parity constant. */
export const SESSION_TOOL_NAMES = [
  "ide_list_projects",
  "ide_list_sessions",
  "ide_get_active_context",
  "ide_select_project",
  "ide_select_session",
  "ide_dispatch_prompt",
] as const;
