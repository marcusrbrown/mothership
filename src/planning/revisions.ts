/**
 * Content-addressed revisions and separate progress/feedback metadata
 * (U2). A revision id is the SHA-256 (WebCrypto, no added library) of
 * the entire canonical source, so ANY byte change — including a
 * checkbox toggle or a comment edit — produces a new id. Feedback and
 * progress are plain, separately keyed data: they carry no approval or
 * execution authority and never affect content identity. This module
 * owns no global store; callers decide how to persist what it returns.
 */
import type { PlanDocument } from "./document";

export type RevisionId = string;

export interface Revision {
  readonly id: RevisionId;
  readonly document: PlanDocument;
}

/** Deterministic lowercase-hex SHA-256 of the given UTF-8 source. */
export async function hashSource(source: string): Promise<RevisionId> {
  const bytes = new TextEncoder().encode(source);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Build a revision from a parsed document. The full source remains
 * available via `revision.document`; nothing here is hash-only. */
export async function createRevision(
  document: PlanDocument,
): Promise<Revision> {
  const id = await hashSource(document.source);
  return Object.freeze({ id, document });
}

export interface FeedbackEntry {
  readonly revisionId: RevisionId;
  readonly unitKey?: string;
  readonly body: string;
  readonly recordedAt: string;
}

export interface UnitProgressNote {
  readonly revisionId: RevisionId;
  readonly unitKey: string;
  readonly status?: string;
  readonly note?: string;
  readonly recordedAt: string;
}

/** Observation/user data keyed to a revision. Carries no approval or
 * execution authority and does not participate in content identity. */
export interface RevisionMetadata {
  readonly revisionId: RevisionId;
  readonly feedback: readonly FeedbackEntry[];
  readonly progress: readonly UnitProgressNote[];
}

export function createMetadata(revisionId: RevisionId): RevisionMetadata {
  return Object.freeze({
    revisionId,
    feedback: Object.freeze([]),
    progress: Object.freeze([]),
  });
}

/** Returns a NEW metadata object with `entry` appended; prior entries
 * and the input `metadata` object are left untouched. */
export function withFeedback(
  metadata: RevisionMetadata,
  entry: Omit<FeedbackEntry, "revisionId">,
): RevisionMetadata {
  return Object.freeze({
    ...metadata,
    feedback: Object.freeze([
      ...metadata.feedback,
      Object.freeze({ ...entry, revisionId: metadata.revisionId }),
    ]),
  });
}

/** Returns a NEW metadata object with `note` appended; prior entries
 * and the input `metadata` object are left untouched. */
export function withProgress(
  metadata: RevisionMetadata,
  note: Omit<UnitProgressNote, "revisionId">,
): RevisionMetadata {
  return Object.freeze({
    ...metadata,
    progress: Object.freeze([
      ...metadata.progress,
      Object.freeze({ ...note, revisionId: metadata.revisionId }),
    ]),
  });
}
