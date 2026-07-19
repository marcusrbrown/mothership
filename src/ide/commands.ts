/**
 * Session-tool request/result/error envelopes and the common logical
 * target schemas shared by the `ide_*` session tools. Extends the layout
 * command-layer pattern (`src/layout/commands.ts`) to the non-layout
 * domain: validate once, one parity choke point for UI and MCP callers,
 * never accept filesystem paths as targets.
 *
 * This module defines shapes only — no I/O, no bus/session-store access.
 * See `./executor.ts` for target resolution and the tool registry/dispatch
 * seam; see `./views.ts` for allowlisted result serializers; see
 * `./errors.ts` for sanitized error construction.
 */
import { z } from "zod";
import { isValidProjectName } from "../workspace/project-name";

const MAX_SESSION_ID_LENGTH = 128;

/** Any C0/C1 control character, including NUL, BEL, and newline/CR/tab. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — detecting control characters IS the point of this validator.
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;

/** Re-exported from the neutral `workspace/project-name.ts` module — this
 * is the SAME invariant `workspace/config.ts` enforces at the manifest
 * parse boundary, kept as a single shared policy (not two independently
 * maintained copies) so the spacebus.json read path and the ide session-
 * tool target schemas can never drift apart on what counts as a safe
 * roster project name. */
export { isValidProjectName };

/**
 * Validates an opaque session identifier. Session ids are never
 * human-authored roster names — they are server-issued opaque tokens
 * (`ses_...` in the deployed OpenCode contract) — so this is
 * deliberately tighter than `isValidProjectName`: no path separators, no
 * dots, no whitespace, and no colon (rules out `Bearer <token>`-shaped
 * and `key: value`-shaped values a caller might mistakenly pass here).
 */
export function isValidSessionId(value: string): boolean {
  if (value.length === 0 || value.length > MAX_SESSION_ID_LENGTH) {
    return false;
  }
  if (CONTROL_CHAR_PATTERN.test(value)) return false;
  return /^[A-Za-z0-9_-]+$/.test(value);
}

/** Validates an OpenCode v1 user-message id (`msg_` + a 12-char
 * lowercase-hex timestamp/counter prefix + 14 random base62 chars) —
 * the exact shape `@fro.bot/space-bus/core`'s `createDispatchMessageId()`
 * produces. A caller never supplies this value; it is only ever a value
 * this codebase generated itself or read back from a trusted upstream
 * result, so this validator exists to catch corruption/tampering, not to
 * accept caller input. */
export function isValidMessageId(value: string): boolean {
  return /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(value);
}

/** Validates an OpenCode v1 pending-question request id (`que_` +
 * opaque alphanumeric suffix). Used only to validate a `mode:"blocked"`
 * dispatch result's `requestId` before it is ever surfaced or focused
 * on. */
export function isValidRequestId(value: string): boolean {
  if (value.length === 0 || value.length > MAX_SESSION_ID_LENGTH) {
    return false;
  }
  if (CONTROL_CHAR_PATTERN.test(value)) return false;
  return /^que_[A-Za-z0-9]+$/.test(value);
}

function projectNameSchema() {
  return z
    .string()
    .min(1, "project must be a non-empty string")
    .refine(isValidProjectName, {
      message:
        "project must be a valid logical roster name — each /-separated segment must match [-A-Za-z0-9_.]+, with no absolute/home/relative-dot segments",
    });
}

function sessionIdSchema() {
  return z
    .string()
    .min(1, "sessionId must be a non-empty string")
    .refine(isValidSessionId, {
      message:
        "sessionId must be a valid opaque identifier (letters, digits, underscore, hyphen only)",
    });
}

/** Distinctive substring stamped on the two refine() messages above so
 * `parseSessionToolArgs` can classify either kind of rejection as
 * `invalid_target` rather than a generic `invalid_arguments`. */
const INVALID_TARGET_MARKERS = [
  "must be a valid logical roster name",
  "must be a valid opaque identifier",
];

/** A target naming a unique roster project — never a directory. */
export const projectTargetSchema = z.object({
  project: projectNameSchema(),
});
export type ProjectTarget = z.infer<typeof projectTargetSchema>;

/** A target naming an opaque, roster-owned session id — never a directory. */
export const sessionTargetSchema = z.object({
  sessionId: sessionIdSchema(),
});
export type SessionTarget = z.infer<typeof sessionTargetSchema>;

/** Strict, closed empty-args schema for tools declared `target: "none"`
 * that also take no other arguments at all (`ide_list_projects`,
 * `ide_get_active_context`). `.strict()` rejects ANY key at all — not
 * just `project`/`sessionId` — with `invalid_arguments`, one layer
 * beyond the target-bearing-field guard `runSessionTool` already runs on
 * raw args before parsing. */
export const noArgsSchema = z.object({}).strict();
export type NoArgs = z.infer<typeof noArgsSchema>;

/** `ide_list_sessions`'s args: the project to list sessions for, plus an
 * optional subagent-visibility toggle defaulting to `false` (matching
 * the sessions panel's own default — see the visible-row semantics this
 * tool reuses). */
export const listSessionsArgsSchema = z.object({
  project: projectNameSchema(),
  includeSubagents: z.boolean().default(false),
});
export type ListSessionsArgs = z.infer<typeof listSessionsArgsSchema>;

/** `ide_select_session`'s args: the session to focus, plus an OPTIONAL
 * expected owning project — when supplied, `runSessionTool`'s target
 * resolution (not this schema) verifies the session actually belongs to
 * that project before the handler ever runs, failing closed as
 * `session_project_mismatch` otherwise (see `./executor.ts`'s
 * `resolveTarget`). */
export const selectSessionArgsSchema = z.object({
  sessionId: sessionIdSchema(),
  project: projectNameSchema().optional(),
});
export type SelectSessionArgs = z.infer<typeof selectSessionArgsSchema>;

/** Default/hard bounds for `ide_get_transcript`'s `limit` argument — frozen
 * per the plan's deferred-implementation decision (default 20, hard max
 * 50). Shared between this schema and the sidecar-facing MCP input schema
 * so the two can never drift apart. */
export const TRANSCRIPT_DEFAULT_LIMIT = 20;
export const TRANSCRIPT_MAX_LIMIT = 50;

/** `ide_get_transcript`'s args: the session to read, plus an optional
 * bounded message-count `limit`. Zero, negative, fractional, and
 * over-maximum values are all rejected here — before any I/O — never
 * silently clamped. Omitted `limit` defaults to `TRANSCRIPT_DEFAULT_LIMIT`
 * in the executor, not here (the schema only bounds an EXPLICIT value). */
export const getTranscriptArgsSchema = z
  .object({
    sessionId: sessionIdSchema(),
    limit: z
      .number()
      .int("limit must be an integer")
      .positive("limit must be a positive integer")
      .max(
        TRANSCRIPT_MAX_LIMIT,
        `limit must not exceed ${TRANSCRIPT_MAX_LIMIT}`,
      )
      .optional(),
  })
  .strict();
export type GetTranscriptArgs = z.infer<typeof getTranscriptArgsSchema>;

/** A target naming exactly one of a unique roster project or a
 * roster-owned session id — never both, never neither. */
export const projectOrSessionTargetSchema = z
  .object({
    project: projectNameSchema().optional(),
    sessionId: sessionIdSchema().optional(),
  })
  .refine((v) => (v.project === undefined) !== (v.sessionId === undefined), {
    message: "exactly one of project or sessionId is required",
  });
export type ProjectOrSessionTarget = z.infer<
  typeof projectOrSessionTargetSchema
>;

/** `ide_dispatch_prompt`'s args: exactly one of a validated logical
 * `project`/`sessionId` target, a non-empty `prompt`, and an optional
 * `title`. `.strict()` closes the object — a caller CANNOT set a
 * pending-question policy or any other field; the executor hardcodes
 * `onPendingQuestion: "blocked"` unconditionally, so there is no schema
 * field through which a caller could even attempt to request the
 * legacy implicit-reply behavior. */
export const dispatchPromptArgsSchema = z
  .object({
    project: projectNameSchema().optional(),
    sessionId: sessionIdSchema().optional(),
    prompt: z.string().min(1, "prompt must be a non-empty string"),
    title: z.string().min(1).optional(),
  })
  .strict()
  .refine((v) => (v.project === undefined) !== (v.sessionId === undefined), {
    message: "exactly one of project or sessionId is required",
  });
/** `.strict()` above rejects a caller-supplied `onPendingQuestion` OR
 * `messageId` field outright — the executor hardcodes
 * `onPendingQuestion: "blocked"` and generates `messageId` itself via
 * `createDispatchMessageId()`, unconditionally, on every call; there is
 * no schema field through which a caller could set or override either. */
export type DispatchPromptArgs = z.infer<typeof dispatchPromptArgsSchema>;

/** Mirrors `src/layout/commands.ts`'s `CommandSource` — kept as a distinct
 * type (not re-exported) so the session-tool domain never structurally
 * couples to the layout command layer. */
export type SessionToolSource = "ui" | "mcp_tool";

export type SessionToolErrorCode =
  | "invalid_arguments"
  | "invalid_target"
  | "unknown_tool"
  | "unknown_project"
  | "ambiguous_project"
  | "unknown_session"
  | "session_project_mismatch"
  | "upstream_error"
  | "internal_error";

/** Only meaningful for mutation tools: whether the underlying
 * OpenCode/space-bus call is provably not sent, or its outcome is
 * unknown after being sent. Target-resolution and validation failures
 * are always effectively "not_sent". */
export type SessionToolErrorDelivery = "not_sent" | "indeterminate";

/** Safe, closed metadata describing an INDETERMINATE dispatch attempt —
 * attached only to a dispatch error whose delivery is `"indeterminate"`
 * (the mutation may or may not have gone through and could not be
 * confirmed by the bounded post-failure reconciliation pass). Preserved
 * internally (never echoed back to a caller as free text) so a future
 * sidecar-side follow-up can decide whether to re-probe. Deliberately
 * excludes any timestamp, the prompt/title text, candidate session ids,
 * candidate counts, filesystem paths, or raw upstream error text —
 * `project`/`sessionId` here are always the RESOLVED logical identifiers
 * from target resolution, never a raw caller-supplied string. */
export interface SessionToolDispatchAttemptMeta {
  operation: "dispatch";
  target: "project" | "session";
  project: string;
  sessionId?: string;
  messageId: string;
  reconciliation: "unconfirmed" | "ambiguous" | "unavailable";
}

export interface SessionToolError {
  code: SessionToolErrorCode;
  message: string;
  delivery?: SessionToolErrorDelivery;
  /** Only ever present on a dispatch error; see
   * `SessionToolDispatchAttemptMeta`. */
  attempt?: SessionToolDispatchAttemptMeta;
}

/**
 * A successful result optionally carries bounded byte/truncation metadata
 * (from `./views.ts`'s truncation helpers) so the executor can forward it,
 * pre-minimized, into the audit trail without ever forwarding `data`
 * itself (see `src/ide/executor.ts` and `src/panels/audit-log/audit-store.ts`).
 */
export interface SessionToolResultMeta {
  bytes?: { returned: number; original: number };
  truncated?: boolean;
}

export type SessionToolResult<T> =
  | { ok: true; data: T; meta?: SessionToolResultMeta }
  | { ok: false; error: SessionToolError };

/**
 * The closed, pre-minimized shape `runSessionTool` (see `./executor.ts`)
 * passes to an injected `SessionToolAuditRecorder` after every call —
 * never `data`/`params`/raw args, and never prompt/transcript/question/
 * answer/header/upstream/path text. `project`/`sessionId` are always the
 * RESOLVED logical identifiers from target resolution (never the raw,
 * unvalidated caller-supplied string) — this is what makes the payload
 * safe to hand to `src/panels/audit-log/audit-store.ts`'s strict schema
 * unmodified. Intentionally structurally identical to (but a distinct
 * type from) that module's `SessionToolAuditEvent` — this module owns no
 * dependency on the audit-log panel, only the shape a recorder callback
 * must accept.
 */
export interface SessionToolAuditPayload {
  tool: string;
  source: SessionToolSource;
  project?: string;
  sessionId?: string;
  requestId?: string;
  outcome: "ok" | "error";
  errorCode?: SessionToolErrorCode;
  bytes?: { returned: number; original: number };
  truncated?: boolean;
}

/** Injected by the caller (typically `src/layout/bridge.ts`) — wraps
 * `auditStore.recordSessionToolEvent`. Optional on `SessionToolDeps` so
 * every existing test fixture and future caller that doesn't supply one
 * compiles and runs unchanged; `runSessionTool` treats a missing
 * recorder as a no-op, never as an error. May throw — `runSessionTool`
 * treats any recorder exception as best-effort-failed and never lets it
 * change the returned `SessionToolResult` (see `./executor.ts`'s
 * `runSessionTool` for the exact fail-closed-before-operation /
 * never-misreport-after-operation split). */
export type SessionToolAuditRecorder = (
  payload: SessionToolAuditPayload,
) => void;

/** Module-private brand registry: only a schema built by
 * `sessionResultSchema` below is ever added here. `registerSessionTool`
 * (`./executor.ts`) checks membership at registration time — a schema
 * that merely LOOKS strict/closed (built by hand with `z.object(...).strict()`,
 * or any other zod construction) is rejected even though it would
 * behave identically at parse time, because the brand proves it, rather
 * than a runtime shape inspection a caller could still construct a
 * bypass for (e.g. a `z.object({}).strict()` that later gets a
 * `.catchall()`/`.passthrough()` call chained onto it — the brand is
 * checked by object identity, never re-derived from the schema's own
 * declared shape). */
const brandedResultSchemas = new WeakSet<z.ZodType>();

/** Compile-time brand — a type-level tag with no runtime representation,
 * carried only in TypeScript's structural type checking. Combined with
 * the `brandedResultSchemas` WeakSet membership check, a schema must
 * satisfy BOTH the type-level brand (only `sessionResultSchema`'s return
 * type carries it) and the runtime brand (only `sessionResultSchema`'s
 * actual output object is ever added to the WeakSet) — a `z.ZodType<T>`
 * annotation or an `as` cast can forge the type-level brand but can
 * never forge WeakSet membership, and a raw JS caller bypassing
 * TypeScript entirely can never forge the type-level brand either. */
declare const SESSION_RESULT_SCHEMA_BRAND: unique symbol;
export type SessionResultSchema<T> = z.ZodType<T> & {
  readonly [SESSION_RESULT_SCHEMA_BRAND]: true;
};

/**
 * The ONLY sanctioned way to build a `SessionToolDefinition.resultSchema`.
 * Wraps `shape` in a `.strict()` top-level `z.object`, which:
 *
 * - Rejects any key not named in `shape` (undeclared fields — a stray
 *   `path`, an `Authorization` header, raw `prompt`/`transcript`/
 *   `question`/`answer` text a buggy or compromised handler tried to
 *   return — can never merely be dropped through; the WHOLE result is
 *   rejected, forcing the caller to notice).
 * - Carries `SessionResultSchema<T>`'s type-level brand AND is recorded
 *   in `brandedResultSchemas`, so `registerSessionTool` can verify — at
 *   registration time, both by type and by runtime identity — that a
 *   definition's `resultSchema` was actually built by this factory and
 *   not smuggled in some other way (a raw `z.unknown()`, `z.any()`, an
 *   unbounded `z.record(...)`, or a hand-built `.passthrough()`/
 *   `.catchall()` schema that defeats the allowlist).
 *
 * Nested/child schemas inside `shape`'s values are NOT recursively
 * forced to be `.strict()` — this factory only closes the TOP-LEVEL
 * object. A tool returning a nested object needs its own nested
 * `z.object({...}).strict()` if it wants the same closure one level
 * down; that is a concrete-tool authoring concern, not something this
 * shared factory tries to enforce generically.
 */
export function sessionResultSchema<TShape extends z.ZodRawShape>(
  shape: TShape,
): SessionResultSchema<z.infer<z.ZodObject<TShape, z.core.$strict>>> {
  const schema = z.object(shape).strict();
  brandedResultSchemas.add(schema);
  return schema as unknown as SessionResultSchema<
    z.infer<z.ZodObject<TShape, z.core.$strict>>
  >;
}

/** True only for a schema built by `sessionResultSchema` above — checked
 * by object identity via `WeakSet`, so no amount of structural mimicry
 * (a hand-built `.strict()` object schema, a cast, an `Object.create`
 * trick) can satisfy this check; only the exact schema instance this
 * module itself constructed and branded can. Deliberately does NOT
 * trust the type-level `SessionResultSchema<T>` brand alone — that
 * brand is erased at runtime and a raw JS caller (or a TypeScript `as`
 * cast) can forge it trivially; this WeakSet membership check is the
 * real, unforgeable gate. */
export function isBrandedResultSchema(schema: unknown): boolean {
  return schema instanceof z.ZodType && brandedResultSchemas.has(schema);
}

/**
 * Validates raw args against `schema`, translating a zod failure into a
 * typed `SessionToolError` before any injected operation runs.
 * Directory-shaped targets get the dedicated `invalid_target` code; any
 * other schema violation is a generic `invalid_arguments`. Never throws.
 *
 * The returned message is ALWAYS one of two stable, program-owned
 * strings — never a joined zod issue message. A raw zod issue can embed
 * caller-controlled content (an `unrecognized_keys` issue lists the
 * actual unknown key names verbatim; a `refine` issue on a big union can
 * echo back parts of the input) — none of that is safe to forward as-is.
 * `INVALID_TARGET_MARKERS` is still used internally to CLASSIFY which
 * stable code applies, but the marker text itself is never included in
 * the returned message.
 */
export function parseSessionToolArgs<T>(
  schema: z.ZodType<T>,
  raw: unknown,
): SessionToolResult<T> {
  const parsed = schema.safeParse(raw);
  if (parsed.success) {
    return { ok: true, data: parsed.data };
  }
  const issues = parsed.error.issues;
  const invalidTarget = issues.some((i) =>
    INVALID_TARGET_MARKERS.some((marker) => i.message.includes(marker)),
  );
  return {
    ok: false,
    error: {
      code: invalidTarget ? "invalid_target" : "invalid_arguments",
      message: invalidTarget
        ? "The given target is invalid."
        : "The given arguments are invalid.",
      delivery: "not_sent",
    },
  };
}
