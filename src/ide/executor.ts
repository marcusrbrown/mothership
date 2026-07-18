/**
 * The typed session-tool executor: one domain boundary through which both
 * UI handlers and MCP requests execute session/project operations.
 * Mirrors `src/layout/executor.ts`'s "validate once, execute once"
 * parity choke point for the non-layout domain.
 *
 * This module owns:
 * - `SessionToolDeps` — the typed dependency bag (live `BusContext`,
 *   `SessionStore`, the `src/server/bus.ts` facade, and focus callbacks)
 *   injected into every operation. No direct OpenCode HTTP, no raw
 *   `fetch`, no Node-only import — dependencies are supplied by the
 *   caller, never constructed here.
 * - `resolveProject`/`resolveSession` — logical-target resolution against
 *   the live roster/store, run before any injected operation, so unknown
 *   projects, unknown/deleted sessions, ambiguous project-name matches,
 *   and session/project ownership mismatches fail closed before any I/O.
 * - A minimal tool registry/dispatch seam (`registerSessionTool`/
 *   `runSessionTool`) that real operations populate. Target resolution
 *   is STRUCTURAL, not an opt-in convention: every registered tool
 *   declares a `target` kind
 *   (`"none" | "project" | "session" | "project_or_session"`), and
 *   `runSessionTool` resolves/validates ownership against that
 *   declaration BEFORE invoking the handler — a handler physically
 *   cannot run for an unresolved target because it receives the resolved
 *   `SessionToolTarget`, not raw args, as its second parameter.
 *
 * Routing a validated WS request into `runSessionTool` (socket-generation
 * binding) lives in `src/layout/bridge.ts`, not here.
 */
import { z } from "zod";
import {
  type SessionResultSchema,
  type SessionToolAuditPayload,
  type SessionToolAuditRecorder,
  type SessionToolResult,
  type SessionToolSource,
  isBrandedResultSchema,
  parseSessionToolArgs,
} from "./commands";
import { INTERNAL_ERROR, normalizeHandlerError, toolError } from "./errors";

/** Every registered session tool name must match this shape: `ide_`
 * prefix, lowercase ASCII letters/digits/underscore only. Enforced at
 * REGISTRATION time (`registerSessionTool` throws for a non-conforming
 * name) — not just at the audit-log boundary — so a malformed tool name
 * can never even enter the registry. Mirrors
 * `src/panels/audit-log/audit-store.ts`'s `TOOL_NAME_PATTERN`. */
const TOOL_NAME_PATTERN = /^ide_[a-z0-9_]+$/;

/** The stable, audit-safe placeholder for any tool name that is not a
 * REGISTERED session tool at the moment `runSessionTool` is called — a
 * caller-supplied string is NEVER forwarded to the audit sink, since a
 * malicious/malformed caller-controlled string could itself be the
 * exfiltration vector this whole audit boundary exists to prevent. */
const UNKNOWN_TOOL_AUDIT_NAME = "ide_unknown_tool";

// --- injected dependencies ------------------------------------------------

/** Structural subset of `@fro.bot/space-bus/contract`'s `BusContext` —
 * kept structural (not imported from `../server/types`) so this module
 * has no compile-time dependency on the space-bus package shape beyond
 * what target resolution actually reads. */
export interface SessionToolBusContext {
  roster: {
    server: { baseUrl: string };
    projects: readonly { name: string; expandedPath: string }[];
  };
}

/** Structural subset of `SessionStore` (see `src/server/session-store.ts`)
 * — every session-tool operation needs at most these four read methods
 * plus the two mutators for completeness; kept structural so test fixtures
 * don't need to construct a full store. */
export interface SessionToolStore {
  getSessions(directory?: string): readonly {
    id: string;
    directory?: string;
    title?: string;
    status?: string;
  }[];
  getSession(
    id: string,
  ):
    | { id: string; directory?: string; title?: string; status?: string }
    | undefined;
  getPendingQuestions(sessionID?: string): readonly unknown[];
  subscribe(listener: (snapshot: unknown) => void): () => void;
  applyEvent(event: unknown): void;
  reconcile(input: unknown): void;
}

/** The `src/server/bus.ts` facade surface an operation may call. Each
 * operation narrows this to the exact facade functions it calls, injected
 * by the caller — this executor never imports `../server/bus` directly. */
export type SessionToolBusFacade = Record<string, unknown>;

/** UI focus/session-switch callbacks an operation may invoke to keep the
 * human-visible UI synchronized. */
export type SessionToolFocusCallbacks = Record<string, unknown>;

export interface SessionToolDeps {
  context: SessionToolBusContext;
  store: SessionToolStore;
  bus: SessionToolBusFacade;
  focus: SessionToolFocusCallbacks;
  /** Optional audit sink — see `SessionToolAuditRecorder` in
   * `./commands.ts`. `runSessionTool` treats a missing recorder as a
   * no-op, never an error. Typically wired to
   * `auditStore.recordSessionToolEvent`. */
  audit?: SessionToolAuditRecorder;
}

// --- target resolution ----------------------------------------------------

export interface ResolvedProject {
  name: string;
  expandedPath: string;
}

/** Resolves a logical project name against the live roster. Fails closed
 * with `unknown_project` for zero matches. Multiple matches — which
 * should not occur once the roster enforces unique project names at
 * workspace-config parsing time — fail closed here too, as
 * `ambiguous_project`, rather than silently selecting the first match. */
export function resolveProject(
  deps: SessionToolDeps,
  project: string,
): SessionToolResult<ResolvedProject> {
  const matches = deps.context.roster.projects.filter(
    (p) => p.name === project,
  );
  if (matches.length === 0) {
    return {
      ok: false,
      error: toolError(
        "unknown_project",
        "No roster project matches the given name.",
        "not_sent",
      ),
    };
  }
  if (matches.length !== 1) {
    return {
      ok: false,
      error: toolError(
        "ambiguous_project",
        "The given project name matches more than one roster project.",
        "not_sent",
      ),
    };
  }
  const found = matches[0];
  if (!found) {
    return {
      ok: false,
      error: toolError(
        "unknown_project",
        "No roster project matches the given name.",
        "not_sent",
      ),
    };
  }
  return {
    ok: true,
    data: { name: found.name, expandedPath: found.expandedPath },
  };
}

export interface ResolvedSession {
  id: string;
  project: string;
  title?: string;
  status?: string;
}

/**
 * Resolves a session id against the live reconciled store, then proves
 * the session's directory belongs to a current roster project — a
 * session present in the store but whose directory matches no roster
 * project resolves as `unknown_session` (fails closed) rather than
 * exposing an unowned directory. When `expectedProject` is supplied, a
 * session that resolves to a *different* project fails as
 * `session_project_mismatch` instead of silently succeeding.
 */
export function resolveSession(
  deps: SessionToolDeps,
  sessionId: string,
  expectedProject?: string,
): SessionToolResult<ResolvedSession> {
  const stored = deps.store.getSession(sessionId);
  if (!stored) {
    return {
      ok: false,
      error: toolError(
        "unknown_session",
        "No session matches the given id.",
        "not_sent",
      ),
    };
  }

  const owner = stored.directory
    ? deps.context.roster.projects.find(
        (p) => p.expandedPath === stored.directory,
      )
    : undefined;
  if (!owner) {
    return {
      ok: false,
      error: toolError(
        "unknown_session",
        "The given session is not owned by any current roster project.",
        "not_sent",
      ),
    };
  }

  if (expectedProject !== undefined && expectedProject !== owner.name) {
    return {
      ok: false,
      error: toolError(
        "session_project_mismatch",
        "The given session belongs to a different project than the one specified.",
        "not_sent",
      ),
    };
  }

  return {
    ok: true,
    data: {
      id: stored.id,
      project: owner.name,
      title: stored.title,
      status: stored.status,
    },
  };
}

// --- structural target kinds -----------------------------------------------

/** What kind of logical target a registered tool requires. `runSessionTool`
 * resolves/validates ownership for the declared kind BEFORE the handler
 * runs — this is what makes target resolution structural rather than an
 * opt-in convention a handler could forget to call. */
export type SessionToolTargetKind =
  | "none"
  | "project"
  | "session"
  | "project_or_session";

/** The resolved target a handler receives as its second parameter,
 * discriminated by `kind`. A handler declared with `target: "project"`
 * always receives `{kind: "project", project: ResolvedProject}` — never
 * raw unresolved args — so it is structurally impossible for a handler
 * to reach an operation without first passing target resolution.
 * `matchedVia` is stamped only when resolution went through the
 * `"project_or_session"` branch, so a handler can tell which side of an
 * either-target declaration was actually supplied without re-deriving it
 * from raw args. */
export type SessionToolTarget =
  | { kind: "none" }
  | {
      kind: "project";
      project: ResolvedProject;
      matchedVia?: "project_or_session";
    }
  | {
      kind: "session";
      session: ResolvedSession;
      matchedVia?: "project_or_session";
    };

interface RawProjectOrSessionArgs {
  project?: string;
  sessionId?: string;
}

function hasProjectOrSessionShape(
  value: unknown,
): value is RawProjectOrSessionArgs {
  return typeof value === "object" && value !== null;
}

/** Field names that name a logical target anywhere in the session-tool
 * argument shapes this executor resolves. A `target: "none"` tool (list-projects,
 * get-active-context — no target at all) must never proceed to its
 * handler when parsed args carry one of these keys, even if the tool's
 * own `argsSchema` (buggily) permits them — this is what makes the
 * `"none"` declaration a runtime guarantee rather than a promise the
 * tool author has to keep by hand. */
const TARGET_BEARING_FIELD_NAMES = ["project", "sessionId"] as const;

/** True if `args` (as an own-property object) carries any target-bearing
 * key at all — including a key explicitly set to `undefined` — since the
 * mere PRESENCE of the key signals a caller/schema that thinks this tool
 * has a target, which contradicts a `target: "none"` declaration. */
function hasAnyTargetBearingField(args: unknown): boolean {
  if (typeof args !== "object" || args === null) return false;
  return TARGET_BEARING_FIELD_NAMES.some((key) =>
    Object.prototype.hasOwnProperty.call(args, key),
  );
}

/**
 * Resolves `args` against `kind`. Returns a `SessionToolResult` so
 * `runSessionTool` can propagate a resolution failure using the exact
 * same error shape as a handler-returned failure — resolution failures
 * and handler failures are indistinguishable to a caller, both are just
 * "the tool call failed with this typed error."
 */
function resolveTarget(
  deps: SessionToolDeps,
  kind: SessionToolTargetKind,
  args: unknown,
): SessionToolResult<SessionToolTarget> {
  if (kind === "none") {
    if (hasAnyTargetBearingField(args)) {
      return {
        ok: false,
        error: toolError(
          "invalid_arguments",
          "This tool takes no project/session target",
          "not_sent",
        ),
      };
    }
    return { ok: true, data: { kind: "none" } };
  }

  if (kind === "project") {
    const { project } = args as { project: string };
    const resolved = resolveProject(deps, project);
    if (!resolved.ok) return resolved;
    return { ok: true, data: { kind: "project", project: resolved.data } };
  }

  if (kind === "session") {
    const { sessionId } = args as { sessionId: string };
    const resolved = resolveSession(deps, sessionId);
    if (!resolved.ok) return resolved;
    return { ok: true, data: { kind: "session", session: resolved.data } };
  }

  // "project_or_session" — argsSchema (projectOrSessionTargetSchema)
  // already guarantees exactly one of project/sessionId is present.
  if (!hasProjectOrSessionShape(args)) {
    return {
      ok: false,
      error: toolError(
        "invalid_arguments",
        "Expected a project or sessionId target",
        "not_sent",
      ),
    };
  }
  if (args.sessionId !== undefined) {
    const resolved = resolveSession(deps, args.sessionId);
    if (!resolved.ok) return resolved;
    return {
      ok: true,
      data: {
        kind: "session",
        session: resolved.data,
        matchedVia: "project_or_session",
      },
    };
  }
  if (args.project !== undefined) {
    const resolved = resolveProject(deps, args.project);
    if (!resolved.ok) return resolved;
    return {
      ok: true,
      data: {
        kind: "project",
        project: resolved.data,
        matchedVia: "project_or_session",
      },
    };
  }
  return {
    ok: false,
    error: toolError(
      "invalid_arguments",
      "Expected a project or sessionId target",
      "not_sent",
    ),
  };
}

// --- tool registry / dispatch seam ----------------------------------------

export interface SessionToolDefinition<TArgs, TData> {
  argsSchema: z.ZodType<TArgs>;
  /**
   * REQUIRED, BRANDED runtime schema for the handler's success `data` —
   * the allowlist output boundary. Must be built by
   * `sessionResultSchema` (`./commands.ts`) — a plain `z.ZodType<TData>`
   * (`z.unknown()`, `z.any()`, an unbounded `z.record(...)`, or a
   * hand-built `.passthrough()`/`.catchall()` schema) is rejected both
   * at the TYPE level (`SessionResultSchema<TData>` carries a
   * compile-time-only brand no other construction can satisfy) and at
   * the RUNTIME level (`registerSessionTool` re-checks
   * `isBrandedResultSchema` on every call, so a `TypeScript` cast or a
   * raw-JS caller bypassing the type system entirely still cannot
   * smuggle an unbranded schema through).
   *
   * `runSessionTool` safe-parses every successful handler result's
   * `data` against this schema and returns ONLY the freshly-parsed
   * value, never the handler's original object reference — an
   * undeclared field (a stray `path`, `Authorization` header, raw
   * `prompt`/`transcript`/`question`/`answer` text a buggy or
   * compromised handler tried to return) can never reach the bridge/UI
   * caller; the strict top-level schema rejects the whole result rather
   * than silently stripping it.
   */
  resultSchema: SessionResultSchema<TData>;
  /** The logical target kind this tool requires. `runSessionTool`
   * resolves this against the live roster/store before the handler runs
   * — see `SessionToolTarget`. */
  target: SessionToolTargetKind;
  handler: (
    args: TArgs,
    target: SessionToolTarget,
    deps: SessionToolDeps,
    source: SessionToolSource,
  ) => Promise<SessionToolResult<TData>>;
}

// biome-ignore lint/suspicious/noExplicitAny: registry is intentionally heterogeneous across tool names; runSessionTool re-validates args per-entry via each definition's own argsSchema before a handler ever runs.
type AnySessionToolDefinition = SessionToolDefinition<any, any>;

const registry = new Map<string, AnySessionToolDefinition>();

/** The closed shape a handler's RETURN VALUE must match, independent of
 * `resultSchema`/error-code validation (which run AFTER this envelope
 * check succeeds). Deliberately permissive on `data`/`meta`/`error`
 * (`z.unknown()`) — those are validated by `resultSchema` /
 * `normalizeHandlerError` respectively, one level down — this schema
 * only proves the handler returned something SHAPED like a
 * `SessionToolResult` at all (a real boolean `ok`, not a truthy stand-in;
 * the right field present for each branch). Both branches are
 * `.strict()`: an `ok:true` result carrying an `error` field (or any
 * other field outside `data`/`meta`), or an `ok:false` result carrying a
 * `data`/`meta` field (or any other field outside `error`), fails the
 * WHOLE envelope — not just the extra field — exactly as if the handler
 * had thrown. A mixed/malformed envelope like this can only come from a
 * buggy or compromised handler; there is no legitimate reason for a
 * result to carry fields from both branches. */
const handlerResultEnvelopeSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      data: z.unknown(),
      meta: z
        .object({
          bytes: z
            .object({
              returned: z.number().finite().int().nonnegative(),
              original: z.number().finite().int().nonnegative(),
            })
            .strict()
            .optional(),
          truncated: z.boolean().optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.unknown(),
    })
    .strict(),
]);

/**
 * Registers a session tool by name. Throws synchronously — refusing to
 * register anything — if `name` does not match `TOOL_NAME_PATTERN`
 * (`ide_` prefix, lowercase ASCII/digits/underscore only): a malformed
 * tool name can never enter the registry, so it can never be routed to,
 * looked up, or dispatched later. This is a program-integrity check on
 * this codebase's own registration calls (every call site is
 * first-party code), not a caller-input validation boundary — it is
 * deliberately loud (throw, not a typed `SessionToolResult`) because a
 * non-conforming name is a bug in the calling code, not a runtime
 * condition a caller can trigger.
 */
export function registerSessionTool<TArgs, TData>(
  name: string,
  definition: SessionToolDefinition<TArgs, TData>,
): void {
  if (!TOOL_NAME_PATTERN.test(name)) {
    throw new Error(
      `registerSessionTool: "${name}" does not match ${TOOL_NAME_PATTERN} — tool names must be ide_-prefixed, lowercase ASCII/digits/underscore only`,
    );
  }
  // Runtime re-check of the resultSchema brand — the TYPE-level brand on
  // `SessionResultSchema<TData>` can be forged with a TypeScript `as`
  // cast, and a raw JS caller bypasses TypeScript entirely; this
  // `WeakSet` membership check (see `isBrandedResultSchema` in
  // `./commands.ts`) is the real, unforgeable gate — it can only ever be
  // true for a schema this codebase's own `sessionResultSchema` factory
  // actually constructed.
  if (!isBrandedResultSchema(definition.resultSchema)) {
    throw new Error(
      `registerSessionTool: "${name}" was registered with a resultSchema not built by sessionResultSchema() — the output allowlist boundary requires a branded, strict, top-level object schema`,
    );
  }
  registry.set(name, definition as AnySessionToolDefinition);
}

/** Test/dev helper — the registry is a process-wide singleton otherwise
 * (mirrors `src/layout/registry.ts`'s `__resetRegistryForTests`). */
export function __resetSessionToolsForTests(): void {
  registry.clear();
}

/** True if `name` names a currently-registered session tool. The
 * `src/layout/bridge.ts` uses this to route a
 * validated WS request's tool name to `runSessionTool` only for tools
 * this executor actually owns — never a heuristic on the name's shape —
 * so an unregistered/unknown tool name can never silently reach
 * `runSessionTool` only to fail there; the routing decision itself is
 * already correct. */
export function isRegisteredSessionTool(name: string): boolean {
  return registry.has(name);
}

/** Extracts the resolved (never raw) project/session identifiers from a
 * `SessionToolTarget` for the audit payload — `undefined`/`undefined`
 * for `kind: "none"` (nothing to report), the resolved project name for
 * `kind: "project"`, and both the resolved session's id AND its owning
 * project for `kind: "session"` (a session always belongs to exactly one
 * resolved project by the time target resolution succeeds). */
function auditIdentifiersFromTarget(target: SessionToolTarget): {
  project?: string;
  sessionId?: string;
} {
  if (target.kind === "project") return { project: target.project.name };
  if (target.kind === "session") {
    return { project: target.session.project, sessionId: target.session.id };
  }
  return {};
}

/**
 * Best-effort audit emission — NEVER throws, NEVER touches or changes
 * the `SessionToolResult` `runSessionTool` is about to return. This is
 * the single point where "post-operation audit failure must not
 * misreport the operation as not_sent" is enforced structurally: the
 * caller always computes and returns its own real `SessionToolResult`
 * independently of whatever happens inside this function, so a thrown
 * (or silently swallowed) recorder failure can never retroactively
 * change delivery/outcome on the value already being returned to the
 * bridge/UI caller.
 */
function emitAudit(
  deps: SessionToolDeps,
  payload: SessionToolAuditPayload,
): void {
  if (!deps.audit) return;
  try {
    deps.audit(payload);
  } catch {
    // Deliberately swallowed: the audit sink is a side channel, not part
    // of the operation's own success/failure contract. A broken/throwing
    // recorder must never surface as (or be conflated with) a
    // session-tool error, and must never cause this function's caller to
    // report a different `SessionToolResult` than the one already
    // computed for the real operation.
  }
}

/**
 * Validates `rawArgs` against the named tool's schema, resolves its
 * declared target kind against the live roster/store, then invokes its
 * handler with the resolved target. Never throws: an unknown tool name is
 * `unknown_tool`; malformed args and unresolvable targets (unknown
 * project/session, ambiguous project, session/project mismatch,
 * directory-shaped values) all fail BEFORE the handler runs — the
 * handler is passed the already-resolved `SessionToolTarget`, so it is
 * structurally incapable of running for an unresolved target.
 *
 * A handler that throws — for ANY reason, including a forged
 * `{code,message}`-shaped throw attempting to impersonate a
 * `SessionToolError` — is always mapped to the generic, program-owned
 * `internal_error` constant. Raw exception text and arbitrary
 * caller-controlled throw values are never trusted or forwarded; a
 * handler's only sanctioned way to report a typed failure is to
 * *return* a `SessionToolResult` with `ok: false`, never to throw one.
 *
 * Every terminal outcome — including every pre-handler failure — emits
 * exactly one best-effort audit event via `deps.audit` (see
 * `emitAudit`/`SessionToolAuditPayload` in `./commands.ts`), carrying
 * only `tool`/`source`/RESOLVED `project`/`sessionId` (never raw args)/
 * `outcome`/`errorCode`/safe `bytes`/`truncated` metadata — never
 * `data`, never raw args, never prompt/transcript/question/answer/
 * header/upstream/path text.
 */
export async function runSessionTool<TData = unknown>(
  name: string,
  rawArgs: unknown,
  deps: SessionToolDeps,
  source: SessionToolSource,
): Promise<SessionToolResult<TData>> {
  const definition = registry.get(name);
  if (!definition) {
    // The caller-supplied `name` is NEVER forwarded to the audit sink —
    // an unknown tool name is exactly the kind of attacker/malformed-
    // controlled string this boundary must not echo (see
    // `UNKNOWN_TOOL_AUDIT_NAME`).
    emitAudit(deps, {
      tool: UNKNOWN_TOOL_AUDIT_NAME,
      source,
      outcome: "error",
      errorCode: "unknown_tool",
    });
    return {
      ok: false,
      error: toolError(
        "unknown_tool",
        "No session tool matches the given name.",
        "not_sent",
      ),
    };
  }

  // Checked on the RAW args, before zod parsing: a non-strict
  // `z.object({})` schema (the real shape a `target:"none"` tool like
  // `ide_list_projects`/`ide_get_active_context` uses) silently STRIPS
  // unknown keys during `safeParse` — by the time `parsed.data` exists,
  // a caller-supplied `project`/`sessionId` key is already gone and
  // structurally invisible to any post-parse check. Inspecting rawArgs
  // here is the only point in the pipeline where that key is still
  // observable.
  if (definition.target === "none" && hasAnyTargetBearingField(rawArgs)) {
    emitAudit(deps, {
      tool: name,
      source,
      outcome: "error",
      errorCode: "invalid_arguments",
    });
    return {
      ok: false,
      error: toolError(
        "invalid_arguments",
        "This tool takes no project/session target",
        "not_sent",
      ),
    };
  }

  const parsed = parseSessionToolArgs(definition.argsSchema, rawArgs);
  if (!parsed.ok) {
    emitAudit(deps, {
      tool: name,
      source,
      outcome: "error",
      errorCode: parsed.error.code,
    });
    return parsed as SessionToolResult<TData>;
  }

  const targetResult = resolveTarget(deps, definition.target, parsed.data);
  if (!targetResult.ok) {
    emitAudit(deps, {
      tool: name,
      source,
      outcome: "error",
      errorCode: targetResult.error.code,
    });
    return targetResult as SessionToolResult<TData>;
  }

  const identifiers = auditIdentifiersFromTarget(targetResult.data);

  try {
    const rawResult = await definition.handler(
      parsed.data,
      targetResult.data,
      deps,
      source,
    );

    // Validate the handler's RETURN ENVELOPE shape itself before trusting
    // `ok`/`data`/`error` at all — a handler that returns something that
    // merely LOOKS like a `SessionToolResult` (wrong types, extra fields,
    // `ok` missing) is treated identically to a throw: this failure
    // happens strictly AFTER the handler ran, so it can never be
    // `not_sent`.
    const envelope = handlerResultEnvelopeSchema.safeParse(rawResult);
    if (!envelope.success) {
      emitAudit(deps, {
        tool: name,
        source,
        ...identifiers,
        outcome: "error",
        errorCode: "internal_error",
      });
      return { ok: false, error: INTERNAL_ERROR("indeterminate") };
    }

    if (envelope.data.ok) {
      // The allowlist output boundary: the handler's success `data` is
      // safe-parsed against the tool's OWN declared `resultSchema` and
      // ONLY the freshly-parsed value is ever returned or audited — the
      // handler's original object reference (and any undeclared field on
      // it: a stray path, an Authorization header, raw prompt/transcript/
      // question/answer text) never crosses this boundary. A schema
      // mismatch here is ALSO strictly post-handler, so it is
      // `internal_error`/`indeterminate`, never `not_sent`.
      const parsedData = definition.resultSchema.safeParse(
        (envelope.data as { data: unknown }).data,
      );
      if (!parsedData.success) {
        emitAudit(deps, {
          tool: name,
          source,
          ...identifiers,
          outcome: "error",
          errorCode: "internal_error",
        });
        return { ok: false, error: INTERNAL_ERROR("indeterminate") };
      }

      const meta = (envelope.data as { meta?: unknown }).meta as
        | {
            bytes?: { returned: number; original: number };
            truncated?: boolean;
          }
        | undefined;

      emitAudit(deps, {
        tool: name,
        source,
        ...identifiers,
        outcome: "ok",
        bytes: meta?.bytes,
        truncated: meta?.truncated,
      });
      const okResult: SessionToolResult<TData> = {
        ok: true,
        data: parsedData.data as TData,
        ...(meta !== undefined && { meta }),
      };
      return okResult;
    }

    // Error normalization: the handler chose a CODE (and optionally a
    // delivery), never a message — the message returned to the caller
    // always comes from `ERROR_CODE_MESSAGES` via `normalizeHandlerError`,
    // regardless of whatever string the handler put in its own `error`
    // object. An unknown/malformed code or delivery normalizes to the
    // generic internal/indeterminate outcome.
    const normalizedError = normalizeHandlerError(
      (envelope.data as { error: unknown }).error,
    );
    emitAudit(deps, {
      tool: name,
      source,
      ...identifiers,
      outcome: "error",
      errorCode: normalizedError.code,
    });
    return { ok: false, error: normalizedError };
  } catch {
    // Never inspect or trust the thrown value's shape — an attacker- or
    // bug-controlled handler could throw an object that structurally
    // resembles SessionToolError to smuggle an arbitrary code/message
    // through this boundary.
    //
    // Delivery is "indeterminate", not "not_sent": once the handler has
    // been invoked, this executor has no way to prove whether a
    // non-idempotent upstream call (dispatch, answerQuestion, etc.) was
    // already sent before the throw — the throw could happen anywhere in
    // the handler's body, including after `await bus.dispatch(...)`
    // resolved but before the handler returned its result. Every failure
    // path BEFORE this point (unknown tool, malformed args, unresolved
    // target) is provably "not_sent" because no handler — and therefore
    // no I/O — ever ran; a handler is free to `return` (never throw) an
    // explicit `not_sent` result itself when it knows a failure occurred
    // strictly before any I/O of its own.
    emitAudit(deps, {
      tool: name,
      source,
      ...identifiers,
      outcome: "error",
      errorCode: "internal_error",
    });
    return { ok: false, error: INTERNAL_ERROR("indeterminate") };
  }
}
