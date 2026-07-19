/**
 * Allowlist-only structural view builders for the session-tool domain.
 * Mirrors `sidecar/ide-server/redact.ts`'s posture: every view here names
 * exactly the fields it admits and constructs a fresh object from them —
 * it never spreads or forwards a raw upstream/space-bus object, so an
 * unexpected field (path, directory, credentials, authorization) added
 * upstream cannot silently leak through. `path`/`directory` fields are
 * dropped entirely; a project's `exists` flag comes from the raw
 * object's `pathExists`, never the path itself.
 */

/** Raw shape this view accepts — a structural subset of space-bus's
 * `RosterProject`/`SnapshotProject`, read defensively (all fields
 * optional) so a malformed/poisoned upstream object degrades to omitted
 * fields rather than throwing. */
interface RawProject {
  name?: unknown;
  pathExists?: unknown;
  exists?: unknown;
  busyCount?: unknown;
  sessionCount?: unknown;
  sessionCountCapped?: unknown;
  statusError?: unknown;
  /** Deliberately typed as an open index signature: callers (and tests)
   * may pass a raw upstream object carrying `path`/`expandedPath`/
   * `directory`/`credentials` fields this view must never read — the
   * point of an allowlist view is that only the named fields above are
   * ever consulted, regardless of what else is present on the input. */
  [key: string]: unknown;
}

export interface ProjectView {
  name: string;
  exists?: boolean;
  busyCount?: number;
  sessionCount?: number;
  sessionCountCapped?: boolean;
  /** Whether the upstream aggregate reported a `statusError` for this
   * project. Deliberately a boolean, not the raw error string — space-bus's
   * `statusError` is free-form upstream text (a failed status fetch's
   * message) and must never cross this allowlist view verbatim; it could
   * carry a path, host, or other operational detail an agent shouldn't
   * see through `ide_list_projects`. */
  hasStatusError: boolean;
  /** True when no matching entry for this project's name was found in the
   * live `snapshot()` read (the roster listing is authoritative for
   * project identity/order; the snapshot read supplies the busy/session
   * counts and error status merged in below — its absence for a given
   * roster project is a real, representable outcome, not an error). */
  snapshotUnknown: boolean;
  /** Whether the matching `snapshot()` entry (if any) reported its own
   * `error` field — same boolean-not-raw-text posture as `hasStatusError`,
   * for the same reason: the snapshot fetch's error text could carry a
   * path, host, or credential-adjacent detail. */
  hasSnapshotError: boolean;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function bool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/** `ide_list_projects` view element: name/status metadata only. Space-bus
 * exposes both `RosterProject.pathExists` and `SnapshotProject.exists` for
 * the same concept across its two aggregate reads — this view normalizes
 * either into a single `exists` field.
 *
 * `snapshotRaw`, when supplied, is the `snapshot()` entry already matched
 * to this project by EXACT name (matching is the caller's job — see
 * `src/ide/executor.ts`'s `ide_list_projects` handler); its
 * `busyCount`/`sessionCount`/`sessionCountCapped`/`exists` take priority
 * over the roster read's own fields when present, since `snapshot()` is
 * the live aggregate. `snapshotUnknown`/`hasSnapshotError` are always
 * derived from `snapshotRaw`'s presence/`error` field, never from `raw`. */
export function projectView(
  raw: RawProject,
  snapshotRaw?: RawProject,
): ProjectView {
  const exists =
    bool(snapshotRaw?.exists) ?? bool(raw.exists) ?? bool(raw.pathExists);
  return {
    name: str(raw.name) ?? "",
    exists,
    busyCount: num(snapshotRaw?.busyCount) ?? num(raw.busyCount),
    sessionCount: num(snapshotRaw?.sessionCount) ?? num(raw.sessionCount),
    sessionCountCapped:
      bool(snapshotRaw?.sessionCountCapped) ?? bool(raw.sessionCountCapped),
    hasStatusError: raw.statusError !== undefined && raw.statusError !== null,
    snapshotUnknown: snapshotRaw === undefined,
    hasSnapshotError:
      snapshotRaw !== undefined &&
      snapshotRaw.error !== undefined &&
      snapshotRaw.error !== null,
  };
}

interface RawSession {
  id?: unknown;
  title?: unknown;
  status?: unknown;
  updatedAt?: unknown;
  createdAt?: unknown;
  parentID?: unknown;
  /** See `RawProject`'s index signature note — `directory` is deliberately
   * absent from this interface but must still be accepted as input (and
   * never read) so callers can pass a raw stored-session object as-is. */
  [key: string]: unknown;
}

export interface SessionView {
  id: string;
  title?: string;
  status?: string;
  updatedAt?: number;
  createdAt?: number;
  parentId?: string;
}

/** `ide_list_sessions`/`ide_get_active_context` view element: id/title/
 * status/timestamps only — never `directory`. */
export function sessionView(raw: RawSession): SessionView {
  return {
    id: str(raw.id) ?? "",
    title: str(raw.title),
    status: str(raw.status),
    updatedAt: num(raw.updatedAt),
    createdAt: num(raw.createdAt),
    parentId: str(raw.parentID),
  };
}

// --- session rows (ide_list_sessions visible-row semantics) ---------------

/** Suffix pattern OpenCode uses for subagent session titles, e.g. "Fix the
 * tests (@fixer subagent)". Mirrors `src/panels/sessions/sessions-view.ts`'s
 * `SUBAGENT_SUFFIX` — kept as a separate, self-contained copy rather than
 * an import: importing from `src/panels/*` would couple this MCP-facing
 * domain to UI panel code (an unrelated module boundary neither side
 * should depend on), and the pattern itself is tiny and effectively
 * frozen (it encodes an OpenCode server title-formatting convention, not
 * app-specific UI logic). Suffix-anchored so titles that merely contain
 * "@" or "subagent" mid-string are NOT treated as subagent sessions. */
const SUBAGENT_SUFFIX = /\(@[^()]+ subagent\)$/;

/** True when `session` is a subagent/child session. PRIMARY signal is
 * `parentID` (a reliable structural marker); falls back to the
 * `(@<name> subagent)` title-suffix marker when `parentID` is absent —
 * see `SUBAGENT_SUFFIX`. Mirrors
 * `src/panels/sessions/sessions-view.ts`'s `isSubagentSession` exactly. */
function isSubagentSession(session: {
  parentID?: string;
  title?: string;
}): boolean {
  if (session.parentID != null) return true;
  if (!session.title) return false;
  return SUBAGENT_SUFFIX.test(session.title);
}

export interface SessionRowView {
  id: string;
  title: string;
  busy: boolean;
  needsAttention: boolean;
}

interface RawStoredSession {
  id: string;
  title?: string;
  status?: string;
  updatedAt?: number;
  parentID?: string;
}

/**
 * `ide_list_sessions` view: id/title/busy/needsAttention only — no
 * `directory`, no `parentID`, no `updatedAt` (recency is consumed here
 * to ORDER the rows, never exposed in the output; the sessions panel's
 * own `SessionRow` shape likewise omits it). Mirrors
 * `src/panels/sessions/sessions-view.ts`'s `toSessionRows` visible-row
 * semantics exactly (same subagent filter, same most-recent-first
 * ordering with the same stable-tiebreak/unknown-timestamp-sinks-last
 * rules) as a self-contained re-implementation — see `isSubagentSession`
 * above for why this isn't a cross-module import.
 *
 * `includeSubagents` defaults to `false` (top-level sessions only),
 * matching the sessions panel's own default.
 */
export function toSessionRowViews(
  sessions: readonly RawStoredSession[],
  pendingSessionIds: ReadonlySet<string>,
  options: { includeSubagents?: boolean } = {},
): SessionRowView[] {
  const { includeSubagents = false } = options;
  return sessions
    .filter((s) => includeSubagents || !isSubagentSession(s))
    .map((s, index) => ({ s, index }))
    .sort((a, b) => {
      const at = a.s.updatedAt;
      const bt = b.s.updatedAt;
      if (at !== undefined && bt !== undefined) {
        if (at !== bt) return bt - at;
        return a.index - b.index; // stable
      }
      if (at !== undefined) return -1; // timestamped sinks above unknown
      if (bt !== undefined) return 1;
      return a.index - b.index; // both unknown -> stable insertion order
    })
    .map(({ s }) => ({
      id: s.id,
      title: s.title ?? s.id,
      busy: s.status === "busy",
      needsAttention: pendingSessionIds.has(s.id),
    }));
}

// --- active context (ide_get_active_context) -------------------------------

export interface ActiveContextView {
  project?: string;
  sessionId?: string;
}

interface RawActiveContext {
  project?: unknown;
  sessionId?: unknown;
  /** See `RawProject`'s index signature note — a caller-supplied
   * `directory` (or any other field) must still be accepted as input
   * (and never read). */
  [key: string]: unknown;
}

/** `ide_get_active_context` view: the currently-focused logical project
 * name and/or session id, both explicitly optional (nothing focused yet
 * is a real, representable state) — never a directory. Reads `raw`
 * defensively field-by-field, same posture as every other view in this
 * module. */
export function activeContextView(raw: RawActiveContext): ActiveContextView {
  const project = str(raw.project);
  const sessionId = str(raw.sessionId);
  return {
    ...(project !== undefined && { project }),
    ...(sessionId !== undefined && { sessionId }),
  };
}

// --- confirmation views (ide_select_project / ide_select_session) ---------

export interface SelectProjectConfirmation {
  project: string;
}

export interface SelectSessionConfirmation {
  sessionId: string;
  project: string;
}

// --- bounded text -------------------------------------------------------

export interface BoundedText {
  text: string;
  truncated: boolean;
  /** UTF-8 byte length of the original input. */
  originalBytes: number;
  /** UTF-8 byte length of the returned (possibly truncated) text. */
  returnedBytes: number;
}

/**
 * Truncates `text` to at most `maxBytes` UTF-8 bytes, never splitting a
 * Unicode code point (and therefore never emitting a lone UTF-16
 * surrogate half). Used by transcript/question views to enforce
 * per-part/total-result byte budgets with deterministic, UTF-8-safe
 * truncation and explicit metadata — never silent.
 *
 * Iterates by Unicode CODE POINT (`for...of` over a string walks
 * complete code points — a surrogate pair counts as one iteration
 * step), not by UTF-16 code unit or byte offset. A code-unit-indexed
 * binary search can land between a high and low surrogate (each emoji
 * is 2 UTF-16 code units but 1 code point); this walk can only ever
 * stop on a whole-code-point boundary, so a budget too small for even
 * the first code point yields an empty string rather than a
 * partial/corrupt one.
 */
export function boundText(text: string, maxBytes: number): BoundedText {
  const encoder = new TextEncoder();
  const originalBytes = encoder.encode(text).length;

  if (originalBytes <= maxBytes) {
    return {
      text,
      truncated: false,
      originalBytes,
      returnedBytes: originalBytes,
    };
  }

  let returnedText = "";
  let returnedBytes = 0;
  for (const codePoint of text) {
    const codePointBytes = encoder.encode(codePoint).length;
    if (returnedBytes + codePointBytes > maxBytes) break;
    returnedText += codePoint;
    returnedBytes += codePointBytes;
  }

  return {
    text: returnedText,
    truncated: true,
    originalBytes,
    returnedBytes,
  };
}
