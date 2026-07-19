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
import type { roster, snapshot } from "../server/bus";
import type { BusContext } from "../server/types";
import {
  type ListSessionsArgs,
  type SelectSessionArgs,
  type SessionResultSchema,
  type SessionToolAuditPayload,
  type SessionToolAuditRecorder,
  type SessionToolResult,
  type SessionToolSource,
  isBrandedResultSchema,
  isValidProjectName,
  isValidSessionId,
  listSessionsArgsSchema,
  noArgsSchema,
  parseSessionToolArgs,
  projectTargetSchema,
  selectSessionArgsSchema,
  sessionResultSchema,
} from "./commands";
import {
  INTERNAL_ERROR,
  UPSTREAM_ERROR,
  normalizeHandlerError,
  toolError,
} from "./errors";
import { activeContextView, projectView, toSessionRowViews } from "./views";

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

/** Structural subset of the REAL `@fro.bot/space-bus/contract`
 * `BusContext` (imported `type`-only below through the browser-safe
 * `src/server/types.ts` re-export, never `@fro.bot/space-bus` directly)
 * — kept structural, not a literal type alias, so lightweight test
 * fixtures don't need to carry every real `RosterProject` field
 * (`path`/`description`/`exists`) irrelevant to target resolution.
 * `_assertBusContextAssignable` below is a COMPILE-TIME (never executed)
 * proof that a real `BusContext` is assignable to this interface without
 * a cast — if a future space-bus upgrade narrows/renames `roster.server`
 * or `roster.projects[].name`/`.expandedPath` in a way this interface no
 * longer structurally accepts, that assignment fails to compile. */
export interface SessionToolBusContext {
  roster: {
    server: { baseUrl: string };
    projects: {
      name: string;
      path: string;
      description: string;
      expandedPath: string;
      exists: boolean;
    }[];
  };
}

/** Compile-time-only (never called) proof that the real `BusContext`
 * from `@fro.bot/space-bus/contract` is structurally assignable to
 * `SessionToolBusContext` with no cast. `expandedPath` is real
 * `BusContext`'s `RosterProject`'s `path`-through-tilde-expansion field. */
function _assertBusContextAssignable(real: BusContext): void {
  const _typed: SessionToolBusContext = real;
  void _typed;
}
void _assertBusContextAssignable;

/** A raw project entry as returned by the browser-safe `roster()`/
 * `snapshot()` `/core` reads — deliberately typed as a fully open
 * `Record<string, unknown>` (not the real `RosterProject`/
 * `SnapshotProject` shapes) so `./views.ts`'s `projectView` can read it
 * defensively field-by-field regardless of which of the two aggregate
 * shapes it actually is. */
export type SessionToolRawProject = Record<string, unknown>;

/** Mirrors `@fro.bot/space-bus/core`'s own `Result<T>` shape structurally
 * (never imported) — `({ok:true} & T) | {ok:false, error:string}`. */
export type SessionToolBusResult<T> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

/** Structural subset of a stored session (`StoredSession` in
 * `src/server/session-store.ts`) — the fields `ide_list_sessions`'s
 * visible-row semantics need: `updatedAt` for recency ordering,
 * `parentID` for the primary subagent-detection signal (title-suffix is
 * the fallback, applied by the caller). */
export interface SessionToolStoredSession {
  id: string;
  directory?: string;
  title?: string;
  status?: string;
  updatedAt?: number;
  parentID?: string;
}

/** Structural subset of `SessionStore` (see `src/server/session-store.ts`)
 * — every session-tool operation needs at most these four read methods
 * plus the two mutators for completeness; kept structural so test fixtures
 * don't need to construct a full store. */
export interface SessionToolStore {
  getSessions(directory?: string): readonly SessionToolStoredSession[];
  getSession(id: string): SessionToolStoredSession | undefined;
  getPendingQuestions(sessionID?: string): readonly unknown[];
  subscribe(listener: (snapshot: unknown) => void): () => void;
  applyEvent(event: unknown): void;
  reconcile(input: unknown): void;
}

/** The `src/server/bus.ts` facade surface an operation may call —
 * structural, not `typeof roster`/`typeof snapshot` directly, so
 * lightweight test fixtures can return a minimal `{projects: [...]}}`
 * shape without every real `RosterProject`/`SnapshotProject` field.
 * `roster?`/`snapshot?` are OPTIONAL so existing fixtures/callers that
 * predate this field compile unchanged. `_assertBusFacadeAssignable`
 * below is a COMPILE-TIME-ONLY proof that the real, imported
 * `roster`/`snapshot` functions (type-only import — no runtime
 * dependency, no `fetch`, no Node-only import) are assignable to this
 * interface's fields without a cast. */
export interface SessionToolBusFacade {
  roster?: (opts: {
    context: SessionToolBusContext;
  }) => Promise<
    SessionToolBusResult<{ projects: readonly SessionToolRawProject[] }>
  >;
  snapshot?: (opts: {
    context: SessionToolBusContext;
  }) => Promise<
    SessionToolBusResult<{ projects: readonly SessionToolRawProject[] }>
  >;
  [key: string]: unknown;
}

/** Compile-time-only (never called) proof that the real, imported
 * `roster`/`snapshot` facade functions are assignable to
 * `SessionToolBusFacade`'s fields with no cast. */
function _assertBusFacadeAssignable(
  realRoster: typeof roster,
  realSnapshot: typeof snapshot,
): void {
  const _typed: SessionToolBusFacade = {
    roster: realRoster,
    snapshot: realSnapshot,
  };
  void _typed;
}
void _assertBusFacadeAssignable;

/** UI focus/session-switch callbacks an operation may invoke to keep the
 * human-visible UI synchronized. `getActiveContext`/`selectProject`/
 * `selectSession` are the three real callbacks the discovery/context/
 * focus session tools call; each is OPTIONAL so every existing
 * fixture/caller that predates this
 * field still compiles. `selectProject`/`selectSession` may return a
 * `Promise` (a real UI focus change may be asynchronous) or `void`
 * (synchronous) — the executor `await`s either uniformly. */
export interface SessionToolFocusCallbacks {
  /** Returns the currently-focused logical project name and/or session
   * id — either may be absent (nothing focused yet). Never a directory.
   * Synchronous: reading "what's currently focused" from in-memory UI
   * state performs no I/O. */
  getActiveContext?: () => {
    project?: string;
    sessionId?: string;
  };
  /** Focuses the given resolved project in the UI (roster selection,
   * panel scoping). May reject/throw — the executor never lets that
   * escape uncaught (see `runSessionTool`'s handler try/catch). */
  selectProject?: (project: ResolvedProject) => void | Promise<void>;
  /** Focuses the given resolved session in the UI (active-session state,
   * transcript/sessions panel scoping). Same throw/reject handling as
   * `selectProject`. */
  selectSession?: (session: ResolvedSession) => void | Promise<void>;
  [key: string]: unknown;
}

/** Refreshes ONE resolved project's session state from the live server
 * before a session-listing read — the authoritative full-state
 * reconciliation (`listSessions` + `getSessionStatus` + `listQuestions`
 * → `store.reconcile`) `src/layout/DockviewShell.tsx`'s
 * `reconcileProject` already performs, injected here so this executor
 * never imports the opencode HTTP client directly. Optional so every
 * pre-existing fixture/caller compiles unchanged; a tool that needs
 * fresh session data (`ide_list_sessions`) treats a missing
 * `refreshProject` as an `internal_error`, never silently reading a
 * possibly-stale store. */
export type SessionToolRefreshProject = (
  project: ResolvedProject,
) => Promise<void>;

export interface SessionToolDeps {
  context: SessionToolBusContext;
  store: SessionToolStore;
  bus: SessionToolBusFacade;
  focus: SessionToolFocusCallbacks;
  /** Optional — see `SessionToolRefreshProject` above. */
  refreshProject?: SessionToolRefreshProject;
  /** Optional audit sink — see `SessionToolAuditRecorder` in
   * `./commands.ts`. `runSessionTool` treats a missing recorder as a
   * no-op, never an error. Typically wired to
   * `auditStore.recordSessionToolEvent`. */
  audit?: SessionToolAuditRecorder;
  /** Test-only override for `listProjectsHandler`'s bounded `snapshot()`
   * timeout (see `DEFAULT_SNAPSHOT_TIMEOUT_MS`/`withSnapshotTimeout`) —
   * never set by production wiring; lets tests exercise the timeout
   * path deterministically and quickly instead of waiting out the real
   * default. */
  __snapshotTimeoutMsForTests?: number;
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
    // A `target: "session"` tool's argsSchema MAY also carry an optional
    // `project` field (see `selectSessionArgsSchema`) naming the
    // CALLER'S expected owning project — when present, resolution fails
    // closed as `session_project_mismatch` if the session actually
    // belongs to a different project, rather than silently succeeding
    // against whichever project the session happens to resolve to.
    const { sessionId, project } = args as {
      sessionId: string;
      project?: string;
    };
    const resolved = resolveSession(deps, sessionId, project);
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

// --- discovery/context/focus tools ------------------------------------

/** Strict, closed nested schema for one `projectView` entry in
 * `ide_list_projects`'s result array — this factory only closes the
 * TOP-LEVEL `sessionResultSchema` object, so a nested array element
 * needs its own `.strict()` to get the same undeclared-field rejection
 * one level down (see `sessionResultSchema`'s own doc comment in
 * `./commands.ts`). */
const projectViewResultSchema = z
  .object({
    name: z.string(),
    exists: z.boolean().optional(),
    busyCount: z.number().optional(),
    sessionCount: z.number().optional(),
    sessionCountCapped: z.boolean().optional(),
    hasStatusError: z.boolean(),
    snapshotUnknown: z.boolean(),
    hasSnapshotError: z.boolean(),
  })
  .strict();

const sessionRowResultSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    busy: z.boolean(),
    needsAttention: z.boolean(),
  })
  .strict();

/** Default bound for the optional `snapshot()` call in
 * `listProjectsHandler` — chosen to sit near the existing reconcile-poll
 * cadence (`src/server/reconcile-poller.ts`'s per-project interval) so a
 * slow/hanging snapshot read degrades within roughly one poll tick
 * rather than blocking the whole `ide_list_projects` call indefinitely.
 * Test-only override via `SessionToolDeps.__snapshotTimeoutMsForTests`
 * (never a public/production-facing option) lets tests exercise the
 * timeout path deterministically and quickly instead of waiting out the
 * real 2500ms. */
const DEFAULT_SNAPSHOT_TIMEOUT_MS = 2500;

/** Races `promise` against a timer of `timeoutMs`; resolves to the
 * settled `SessionToolBusResult` on success, or `undefined` on timeout OR
 * rejection — both are DEGRADE-not-fail outcomes for the optional
 * snapshot read (see `listProjectsHandler`'s doc comment), so this
 * helper deliberately collapses "rejected" and "timed out" into the same
 * `undefined` signal rather than distinguishing them. The timer is
 * always cleared (both on settle and on timeout) so a resolved-late
 * snapshot promise can never leak a dangling timer or fire a
 * use-after-return callback. */
function withSnapshotTimeout<T>(
  promise: Promise<SessionToolBusResult<T>> | undefined,
  timeoutMs: number,
): Promise<SessionToolBusResult<T> | undefined> {
  if (!promise) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(undefined);
    }, timeoutMs);
    promise.then(
      (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

/**
 * Calls both the browser-safe `roster()` and `snapshot()` `/core` reads
 * and merges them by EXACT project name — roster is AUTHORITATIVE for
 * project IDENTITY/ORDER (its listing order is preserved verbatim in the
 * result; a roster failure is fatal, `upstream_error`/`indeterminate`,
 * since there is no project list to return at all without it) and
 * `bus.roster` being entirely absent is `internal_error`/`indeterminate`
 * (a program-wiring gap, not an upstream failure). `snapshot()` supplies
 * the live busy/session-count/error aggregate, but a snapshot failure
 * (or `bus.snapshot` being absent) DEGRADES rather than fails the whole
 * read: every project is still returned from the roster, each with
 * `snapshotUnknown: true` (see `projectView`) rather than the call
 * failing outright — a live roster listing with stale/missing status
 * counts is still useful, unlike no listing at all. A project present
 * in the roster but absent from a SUCCESSFUL snapshot response is
 * likewise `snapshotUnknown: true`, not an error.
 */
async function listProjectsHandler(
  _args: z.infer<typeof noArgsSchema>,
  _target: SessionToolTarget,
  deps: SessionToolDeps,
): Promise<
  SessionToolResult<{ projects: z.infer<typeof projectViewResultSchema>[] }>
> {
  if (!deps.bus.roster) {
    return { ok: false, error: INTERNAL_ERROR("indeterminate") };
  }
  const timeoutMs =
    deps.__snapshotTimeoutMsForTests ?? DEFAULT_SNAPSHOT_TIMEOUT_MS;
  // Unlike `snapshot()` (optional, best-effort, isolated by
  // `withSnapshotTimeout` — a rejection there only degrades the result),
  // `roster()` is AUTHORITATIVE: this call is REQUIRED to resolve for a
  // read to exist at all, so its promise is awaited directly, not raced
  // against a timeout. A REJECTED (not just `ok:false`) roster promise —
  // e.g. a thrown network error carrying raw connection/credential
  // text — must still map to the same stable, sanitized
  // `upstream_error`/`indeterminate` outcome as an `ok:false` result, not
  // `internal_error`: the failure is upstream, not a program-wiring gap,
  // and the raw rejection reason must never cross this boundary.
  let rosterResult: Awaited<ReturnType<NonNullable<typeof deps.bus.roster>>>;
  let snapshotResult:
    | Awaited<ReturnType<NonNullable<typeof deps.bus.snapshot>>>
    | undefined;
  try {
    [rosterResult, snapshotResult] = await Promise.all([
      deps.bus.roster({ context: deps.context }),
      withSnapshotTimeout(
        deps.bus.snapshot?.({ context: deps.context }),
        timeoutMs,
      ),
    ]);
  } catch {
    return { ok: false, error: UPSTREAM_ERROR("indeterminate") };
  }
  if (!rosterResult.ok) {
    return { ok: false, error: UPSTREAM_ERROR("indeterminate") };
  }

  const snapshotByName = new Map<string, SessionToolRawProject>();
  if (snapshotResult?.ok) {
    for (const p of snapshotResult.projects) {
      const name = p.name;
      if (typeof name === "string") snapshotByName.set(name, p);
    }
  }

  const projects = rosterResult.projects.map((raw) => {
    const name = typeof raw.name === "string" ? raw.name : undefined;
    return projectView(
      raw,
      name !== undefined ? snapshotByName.get(name) : undefined,
    );
  });

  return { ok: true, data: { projects } };
}

/**
 * Refreshes the resolved project's session state (authoritative
 * full-state reconciliation — see `SessionToolRefreshProject`) before
 * reading the store, then builds visible rows via `toSessionRowViews`
 * (same subagent-filter/ordering semantics as the sessions panel).
 * `refreshProject` being absent, or rejecting, is `upstream_error`/
 * `indeterminate` — this tool never falls back to a possibly-stale
 * store read after a failed refresh.
 */
async function listSessionsHandler(
  args: ListSessionsArgs,
  target: SessionToolTarget,
  deps: SessionToolDeps,
): Promise<
  SessionToolResult<{
    project: string;
    sessions: z.infer<typeof sessionRowResultSchema>[];
  }>
> {
  if (target.kind !== "project") {
    return { ok: false, error: INTERNAL_ERROR("indeterminate") };
  }
  if (!deps.refreshProject) {
    return { ok: false, error: INTERNAL_ERROR("indeterminate") };
  }
  try {
    await deps.refreshProject(target.project);
  } catch {
    return { ok: false, error: UPSTREAM_ERROR("indeterminate") };
  }

  const stored = deps.store.getSessions(target.project.expandedPath);
  const pendingIds = new Set(
    deps.store
      .getPendingQuestions()
      .filter(
        (q): q is { sessionID: string } =>
          typeof q === "object" &&
          q !== null &&
          "sessionID" in q &&
          typeof (q as { sessionID: unknown }).sessionID === "string",
      )
      .map((q) => q.sessionID),
  );
  const sessions = toSessionRowViews(stored, pendingIds, {
    includeSubagents: args.includeSubagents,
  });

  return { ok: true, data: { project: target.project.name, sessions } };
}

const activeContextResultSchema = z
  .object({
    project: z.string().optional(),
    sessionId: z.string().optional(),
  })
  .strict();

/** Reads the currently-focused logical project/session from the UI focus
 * callback — synchronous, no I/O, never a directory. A missing
 * `focus.getActiveContext` is `internal_error`/`indeterminate` (this
 * tool has no meaningful fallback for "focus state is unavailable").
 *
 * The callback's output is itself UNTRUSTED — a buggy or compromised UI
 * layer could report a poisoned/malformed project name or session id —
 * so both are validated against the SAME shared invariants target
 * resolution already enforces (`isValidProjectName`/`isValidSessionId`)
 * BEFORE the result is constructed. A poisoned value fails closed as
 * `internal_error`/`indeterminate` (the callback already ran, so this is
 * a post-call failure, same posture as every other post-handler
 * validation failure in this module) with no raw echo of the poisoned
 * value anywhere in the error. */
async function getActiveContextHandler(
  _args: z.infer<typeof noArgsSchema>,
  _target: SessionToolTarget,
  deps: SessionToolDeps,
): Promise<SessionToolResult<z.infer<typeof activeContextResultSchema>>> {
  if (!deps.focus.getActiveContext) {
    return { ok: false, error: INTERNAL_ERROR("indeterminate") };
  }
  const raw = deps.focus.getActiveContext();
  if (raw.project !== undefined && !isValidProjectName(raw.project)) {
    return { ok: false, error: INTERNAL_ERROR("indeterminate") };
  }
  if (raw.sessionId !== undefined && !isValidSessionId(raw.sessionId)) {
    return { ok: false, error: INTERNAL_ERROR("indeterminate") };
  }
  return { ok: true, data: activeContextView(raw) };
}

const selectProjectResultSchema = z.object({ project: z.string() }).strict();

/** Focuses the already-resolved project via the injected UI callback.
 * Target resolution has already proven the project exists in the live
 * roster — an unknown/mismatched project fails BEFORE this handler ever
 * runs (see `resolveTarget`), so this handler itself never needs to
 * re-validate identity, only confirm the focus call succeeded. A
 * missing `focus.selectProject` is `internal_error`/`indeterminate`; a
 * callback that throws AFTER being invoked is also `indeterminate` (the
 * focus mutation may have partially applied). */
async function selectProjectHandler(
  _args: unknown,
  target: SessionToolTarget,
  deps: SessionToolDeps,
): Promise<SessionToolResult<z.infer<typeof selectProjectResultSchema>>> {
  if (target.kind !== "project") {
    return { ok: false, error: INTERNAL_ERROR("indeterminate") };
  }
  if (!deps.focus.selectProject) {
    return { ok: false, error: INTERNAL_ERROR("indeterminate") };
  }
  await deps.focus.selectProject(target.project);
  return { ok: true, data: { project: target.project.name } };
}

const selectSessionResultSchema = z
  .object({ sessionId: z.string(), project: z.string() })
  .strict();

/** Focuses the already-resolved session via the injected UI callback.
 * Target resolution has already proven the session exists AND (when an
 * expected project was supplied) belongs to it — an unknown session or
 * a session/project mismatch fails BEFORE this handler runs. Same
 * missing-callback/post-invocation-throw handling as
 * `selectProjectHandler`. */
async function selectSessionHandler(
  _args: SelectSessionArgs,
  target: SessionToolTarget,
  deps: SessionToolDeps,
): Promise<SessionToolResult<z.infer<typeof selectSessionResultSchema>>> {
  if (target.kind !== "session") {
    return { ok: false, error: INTERNAL_ERROR("indeterminate") };
  }
  if (!deps.focus.selectSession) {
    return { ok: false, error: INTERNAL_ERROR("indeterminate") };
  }
  await deps.focus.selectSession(target.session);
  return {
    ok: true,
    data: { sessionId: target.session.id, project: target.session.project },
  };
}

let discoveryContextToolsRegistered = false;

/**
 * Registers the five discovery/context/focus session tools
 * (`ide_list_projects`, `ide_list_sessions`, `ide_get_active_context`,
 * `ide_select_project`, `ide_select_session`) via `registerSessionTool`.
 * Idempotent and safe to call more than once — no implicit
 * module-import side effect registers these; a caller (the bridge/UI
 * integration point) must call this explicitly exactly once per process
 * (or reset via `__resetSessionToolsForTests` and call again, which
 * tests do freely).
 */
export function registerDiscoveryContextTools(): void {
  if (discoveryContextToolsRegistered) return;
  discoveryContextToolsRegistered = true;

  registerSessionTool("ide_list_projects", {
    argsSchema: noArgsSchema,
    resultSchema: sessionResultSchema({
      projects: z.array(projectViewResultSchema),
    }),
    target: "none",
    handler: listProjectsHandler,
  });

  registerSessionTool("ide_list_sessions", {
    argsSchema: listSessionsArgsSchema,
    resultSchema: sessionResultSchema({
      project: z.string(),
      sessions: z.array(sessionRowResultSchema),
    }),
    target: "project",
    handler: listSessionsHandler,
  });

  registerSessionTool("ide_get_active_context", {
    argsSchema: noArgsSchema,
    resultSchema: sessionResultSchema({
      project: z.string().optional(),
      sessionId: z.string().optional(),
    }),
    target: "none",
    handler: getActiveContextHandler,
  });

  registerSessionTool("ide_select_project", {
    argsSchema: projectTargetSchema,
    resultSchema: sessionResultSchema({ project: z.string() }),
    target: "project",
    handler: selectProjectHandler,
  });

  registerSessionTool("ide_select_session", {
    argsSchema: selectSessionArgsSchema,
    resultSchema: sessionResultSchema({
      sessionId: z.string(),
      project: z.string(),
    }),
    target: "session",
    handler: selectSessionHandler,
  });
}

/** Test/dev helper — resets the module-level idempotency latch so a test
 * that calls `__resetSessionToolsForTests()` can re-register the five
 * discovery/context/focus tools afresh. */
export function __resetDiscoveryContextRegistrationForTests(): void {
  discoveryContextToolsRegistered = false;
}
