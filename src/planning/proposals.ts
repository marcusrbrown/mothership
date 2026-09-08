/**
 * Pure, base-revision-bound proposal application (U2). A proposal is a
 * minimal full-replacement candidate source bound to the exact base
 * revision it was drafted against. Applying it only succeeds against
 * that exact current base; otherwise it fails explicitly without
 * touching the current draft. No diff/LCS engine and no merge/rebase —
 * that belongs to a later reviewing unit, not this pure model.
 */
import { parseDocument } from "./document";
import { type Revision, type RevisionId, createRevision } from "./revisions";

/** A full-replacement candidate source bound to its drafting base. */
export interface Proposal {
  readonly baseRevisionId: RevisionId;
  readonly candidateSource: string;
}

export type ProposalErrorKind = "stale-base" | "invalid-source";

export interface ProposalError {
  readonly kind: ProposalErrorKind;
  readonly message: string;
  /** Present for `stale-base`: the actual current revision id, so a
   * caller can re-resolve without guessing. */
  readonly currentRevisionId?: RevisionId;
}

export type ApplyProposalResult =
  | { readonly ok: true; readonly revision: Revision }
  | { readonly ok: false; readonly error: ProposalError };

/**
 * Apply `proposal` against `currentRevision`. Succeeds only when
 * `proposal.baseRevisionId` exactly matches `currentRevision.id`,
 * producing a new canonical revision from `candidateSource`. A stale
 * base or invalid candidate source fails without altering
 * `currentRevision` — this function is pure and never mutates it.
 */
export async function applyProposal(
  proposal: Proposal,
  currentRevision: Revision,
): Promise<ApplyProposalResult> {
  if (proposal.baseRevisionId !== currentRevision.id) {
    return {
      ok: false,
      error: {
        kind: "stale-base",
        message: "proposal base revision does not match the current draft",
        currentRevisionId: currentRevision.id,
      },
    };
  }

  const parsed = parseDocument(proposal.candidateSource);
  if (!parsed.ok) {
    return {
      ok: false,
      error: {
        kind: "invalid-source",
        message: `candidate source is invalid: ${parsed.error.message}`,
      },
    };
  }

  return { ok: true, revision: await createRevision(parsed.value) };
}

/** Explicit reject outcome: the baseline is unconditionally returned
 * unchanged, regardless of whether `proposal`'s base was current. */
export function rejectProposal(
  _proposal: Proposal,
  currentRevision: Revision,
): Revision {
  return currentRevision;
}
