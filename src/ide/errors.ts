/**
 * Stable, sanitized session-tool errors. Mirrors
 * `sidecar/ide-server/redact.ts`'s allowlist-first disclosure posture,
 * taken to its logical conclusion: raw upstream response bodies and
 * exception text NEVER cross this boundary, full stop. There is no
 * redact-then-forward path — a denylist regex over arbitrary text can
 * always miss a shape it wasn't written for (a new header name, a
 * differently-formatted token, a stray path in an unexpected spot). The
 * only representable "something went wrong upstream/internally" outcomes
 * are the two program-owned constants below; the original text is
 * discarded entirely; anyone triaging needs to reproduce against local
 * dev diagnostics, not this MCP-facing boundary.
 */
import { z } from "zod";
import type {
  SessionToolDispatchAttemptMeta,
  SessionToolError,
  SessionToolErrorCode,
  SessionToolErrorDelivery,
} from "./commands";
import { isValidMessageId } from "./commands";

/** Every closed `SessionToolErrorCode` value, kept as a literal list (not
 * a runtime-introspectable value-level import of the type) so a handler-
 * returned error's `code` can be validated against real codes, never an
 * arbitrary string. Mirrors `src/panels/audit-log/audit-store.ts`'s
 * `KNOWN_ERROR_CODES`. */
const KNOWN_ERROR_CODES = [
  "invalid_arguments",
  "invalid_target",
  "unknown_tool",
  "unknown_project",
  "ambiguous_project",
  "unknown_session",
  "session_project_mismatch",
  "upstream_error",
  "internal_error",
] as const;

/** Program-owned, stable message for every closed error code — a
 * handler's returned error can select a CODE, never a MESSAGE; the
 * message a caller sees is always this table's value, never the
 * handler's own string (see `normalizeHandlerError` below). */
const ERROR_CODE_MESSAGES: Record<SessionToolErrorCode, string> = {
  invalid_arguments: "The given arguments are invalid.",
  invalid_target: "The given target is invalid.",
  unknown_tool: "No session tool matches the given name.",
  unknown_project: "No roster project matches the given name.",
  ambiguous_project:
    "The given project name matches more than one roster project.",
  unknown_session: "No session matches the given id.",
  session_project_mismatch:
    "The given session belongs to a different project than the one specified.",
  upstream_error: "The upstream operation failed.",
  internal_error: "An internal error occurred.",
};

const bridgeErrorDeliverySchema = z.enum(["not_sent", "indeterminate"]);

/** Closed schema for a dispatch attempt's safe metadata — see
 * `SessionToolDispatchAttemptMeta` in `./commands.ts`. `.strict()`
 * rejects any field beyond the named ones (a timestamp, prompt/title
 * text, candidate ids/counts, a path, raw upstream text). The
 * `session`-target/`sessionId` consistency (a `target:"session"` attempt
 * must carry `sessionId`; a `target:"project"` attempt must not) is
 * enforced by `.refine()` rather than a discriminated union so a single
 * shape stays easy to construct while still being unrepresentable in an
 * inconsistent form. */
const dispatchAttemptMetaSchema = z
  .object({
    operation: z.literal("dispatch"),
    target: z.enum(["project", "session"]),
    project: z.string(),
    sessionId: z.string().optional(),
    messageId: z.string().refine(isValidMessageId, {
      message: "messageId must be a valid OpenCode v1 user-message id",
    }),
    reconciliation: z.enum(["unconfirmed", "ambiguous", "unavailable"]),
  })
  .strict()
  .refine((v) => (v.target === "session") === (v.sessionId !== undefined), {
    message:
      "sessionId must be present iff target is 'session', and absent iff target is 'project'",
  });

/** The closed shape a HANDLER-RETURNED error envelope must match: a
 * known code, an optional but well-typed delivery, and — for a dispatch
 * attempt only — optional safe attempt metadata. `message` is
 * deliberately NOT part of this schema — a handler cannot choose its own
 * message at all (see `normalizeHandlerError`), so there is nothing to
 * validate there. */
const handlerErrorEnvelopeSchema = z.object({
  code: z.enum(KNOWN_ERROR_CODES),
  delivery: bridgeErrorDeliverySchema.optional(),
  attempt: dispatchAttemptMetaSchema.optional(),
});

/** Builds a typed error from an already-known-safe code/message. Prefer
 * this over the generic constants below whenever the message was
 * constructed by this codebase from typed, non-secret values (e.g. "No
 * roster project named X") rather than copied from an upstream response
 * or an exception. */
export function toolError(
  code: SessionToolErrorCode,
  message: string,
  delivery?: SessionToolErrorDelivery,
): SessionToolError {
  return delivery === undefined
    ? { code, message }
    : { code, message, delivery };
}

/**
 * The one representable "an OpenCode/space-bus call failed" outcome.
 * Takes no text parameter — there is no call shape that could leak
 * upstream response content, by construction. Use when a handler knows
 * *that* an upstream call failed but must not surface *why* in any
 * caller-controlled form.
 */
export function UPSTREAM_ERROR(
  delivery: SessionToolErrorDelivery,
): SessionToolError {
  return {
    code: "upstream_error",
    message: "The upstream operation failed.",
    delivery,
  };
}

/**
 * The one representable "something failed inside this executor, not
 * upstream" outcome (e.g. a handler threw before/without making any
 * network call). Same no-text-parameter shape as `UPSTREAM_ERROR` and
 * for the same reason.
 */
export function INTERNAL_ERROR(
  delivery: SessionToolErrorDelivery,
): SessionToolError {
  return {
    code: "internal_error",
    message: "An internal error occurred.",
    delivery,
  };
}

/**
 * Normalizes a HANDLER-RETURNED `{ok:false, error}` value: validates
 * `error` against `handlerErrorEnvelopeSchema` (a known code, an
 * optional well-typed delivery) and, if valid, rebuilds it from
 * `ERROR_CODE_MESSAGES` — the handler's own `message` string, whatever
 * it was, is NEVER used. A handler cannot choose an arbitrary message
 * for ANY code, not just `upstream_error`/`internal_error`; every code
 * maps to exactly one program-owned, stable string.
 *
 * If `error` does NOT match the closed envelope shape (unknown/missing
 * code, a `code` that isn't a real `SessionToolErrorCode`, a malformed
 * `delivery`, or `error` not even being an object) this returns
 * `INTERNAL_ERROR("indeterminate")` — the handler already ran by the
 * time its result is inspected, so the executor cannot prove no I/O
 * occurred; see `src/ide/executor.ts`'s `runSessionTool` doc comment for
 * why every post-handler failure is `"indeterminate"`, never `"not_sent"`.
 */
export function normalizeHandlerError(error: unknown): SessionToolError {
  const parsed = handlerErrorEnvelopeSchema.safeParse(error);
  if (!parsed.success) {
    return INTERNAL_ERROR("indeterminate");
  }
  return {
    code: parsed.data.code,
    message: ERROR_CODE_MESSAGES[parsed.data.code],
    ...(parsed.data.delivery !== undefined && {
      delivery: parsed.data.delivery,
    }),
    ...(parsed.data.attempt !== undefined && {
      attempt: parsed.data.attempt,
    }),
  };
}

/** Builds an `upstream_error`/`indeterminate` result carrying safe
 * dispatch-attempt metadata — the one representable "a dispatch mutation
 * could not be confirmed" outcome. Same no-raw-text posture as
 * `UPSTREAM_ERROR`: takes only closed, already-safe fields, never a
 * message or upstream text parameter. */
export function DISPATCH_INDETERMINATE(
  attempt: SessionToolDispatchAttemptMeta,
): SessionToolError {
  return {
    code: "upstream_error",
    message: "The upstream operation failed.",
    delivery: "indeterminate",
    attempt,
  };
}
