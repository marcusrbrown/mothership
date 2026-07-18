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
  description?: unknown;
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
  description?: string;
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
 * either into a single `exists` field. */
export function projectView(raw: RawProject): ProjectView {
  const exists = bool(raw.exists) ?? bool(raw.pathExists);
  return {
    name: str(raw.name) ?? "",
    description: str(raw.description),
    exists,
    busyCount: num(raw.busyCount),
    sessionCount: num(raw.sessionCount),
    sessionCountCapped: bool(raw.sessionCountCapped),
    hasStatusError: raw.statusError !== undefined && raw.statusError !== null,
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
