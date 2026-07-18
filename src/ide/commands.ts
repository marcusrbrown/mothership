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

const MAX_PROJECT_NAME_LENGTH = 200;
const MAX_SESSION_ID_LENGTH = 128;

/** Any C0/C1 control character, including NUL, BEL, and newline/CR/tab. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — detecting control characters IS the point of this validator.
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;

/** A Windows drive letter prefix (`C:`, `d:`), independent of what
 * follows — real roster names never need a bare `X:` prefix, and this is
 * also what a Windows drive-qualified path looks like. */
const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:/;

/** Credential/header-shaped values a project name must never be
 * mistakable for: an HTTP-header-style `Name: ...`/`Name=...` prefix for
 * a known credential field name (Authorization, Cookie, password, token,
 * secret, api-key — with `-`/`_` variants), OR a standalone `Bearer
 * <token>` value. Matched anywhere in the string, case-insensitively —
 * a real roster project name has no legitimate reason to contain any of
 * these shapes, so this is a narrow, deliberate carve-out rather than a
 * broad denylist that could reject ordinary names. */
const CREDENTIAL_SHAPE_PATTERN =
  /\b(authorization|cookie|password|passwd|token|secret|api[-_]?key)\s*[:=]|\bbearer\s+\S/i;

/**
 * Validates a logical roster project name against the workspace roster's
 * real naming contract: a bounded, non-empty string that MAY contain
 * spaces, punctuation, Unicode characters, and an internal `/`
 * (org/repo-style, e.g. `fro-bot/dashboard`, or a human title like `My
 * Project`) — roster names are not filesystem-path-shaped or
 * ASCII-charset-restricted by convention, so this validator is a
 * DENYLIST of specific unsafe shapes, not a closed positive charset:
 *
 * - Non-empty, at most `MAX_PROJECT_NAME_LENGTH` characters.
 * - No control characters (NUL, BEL, newline/CR/tab, etc).
 * - Never starts with `/` (absolute path) or `~` (home-dir shorthand).
 * - Never contains a backslash (Windows path separator) or starts with a
 *   Windows drive letter (`C:`).
 * - No leading/trailing/doubled `/` (rules out `/foo`, `foo/`, `foo//bar`).
 * - No segment (split on `/`) is exactly `.` or `..` (rules out `.`,
 *   `..`, `./x`, `../x`, `foo/../bar`, `foo/.`).
 * - Never matches `CREDENTIAL_SHAPE_PATTERN` (rules out
 *   `Authorization: ...`, `Bearer abc123`, `Cookie=...`,
 *   `password=hunter2`, `token: value`, `api-key=...`, etc).
 */
export function isValidProjectName(value: string): boolean {
  if (value.length === 0 || value.length > MAX_PROJECT_NAME_LENGTH) {
    return false;
  }
  if (CONTROL_CHAR_PATTERN.test(value)) return false;
  if (value.startsWith("/")) return false;
  if (value.startsWith("~")) return false;
  if (value.includes("\\")) return false;
  if (WINDOWS_DRIVE_PATTERN.test(value)) return false;
  if (value.endsWith("/")) return false;
  if (value.includes("//")) return false;
  if (CREDENTIAL_SHAPE_PATTERN.test(value)) return false;

  const segments = value.split("/");
  return segments.every((seg) => seg.length > 0 && seg !== "." && seg !== "..");
}

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

export interface SessionToolError {
  code: SessionToolErrorCode;
  message: string;
  delivery?: SessionToolErrorDelivery;
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
      message:
        issues.map((i) => i.message).join("; ") || "Invalid command payload",
      delivery: "not_sent",
    },
  };
}
