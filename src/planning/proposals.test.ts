/**
 * Behavioral tests for base-revision-bound proposal application (U2).
 * Minimal full-replacement-source proposals only — no diff engine.
 */
import { describe, expect, test } from "bun:test";
import { parseDocument } from "./document";
import { applyProposal, rejectProposal } from "./proposals";
import { createRevision, hashSource } from "./revisions";

async function revisionOf(source: string) {
  const doc = parseDocument(source);
  if (!doc.ok) throw new Error("fixture source must parse");
  return createRevision(doc.value);
}

describe("applyProposal: happy path", () => {
  test("a proposal against the current base produces a new canonical revision", async () => {
    const base = await revisionOf("# Plan\nOld body.\n");
    const candidateSource = "# Plan\nNew body.\n";
    const result = await applyProposal(
      { baseRevisionId: base.id, candidateSource },
      base,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.revision.document.source).toBe(candidateSource);
    expect(result.revision.id).toBe(await hashSource(candidateSource));
    expect(result.revision.id).not.toBe(base.id);
  });
});

describe("applyProposal: stale base", () => {
  test("error: a proposal targeting an older base cannot overwrite newer edits", async () => {
    const original = await revisionOf("# Plan\nOriginal.\n");
    const newer = await revisionOf("# Plan\nSomeone else's edit.\n");
    const proposal = {
      baseRevisionId: original.id,
      candidateSource: "# Plan\nProposed from stale base.\n",
    };
    const result = await applyProposal(proposal, newer);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("stale-base");
    expect(result.error.currentRevisionId).toBe(newer.id);
  });

  test("edge: the current draft is unchanged after a stale-base rejection", async () => {
    const newer = await revisionOf("# Plan\ncurrent.\n");
    const proposal = {
      baseRevisionId: "0".repeat(64),
      candidateSource: "# Plan\nattempted overwrite.\n",
    };
    const result = await applyProposal(proposal, newer);
    expect(result.ok).toBe(false);
    expect(newer.document.source).toBe("# Plan\ncurrent.\n");
  });
});

describe("applyProposal: invalid candidate source", () => {
  test("error: a candidate source with an unpaired surrogate is rejected", async () => {
    const base = await revisionOf("start\n");
    const proposal = {
      baseRevisionId: base.id,
      candidateSource: `broken${String.fromCharCode(0xd800)}text`,
    };
    const result = await applyProposal(proposal, base);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("invalid-source");
  });
});

describe("rejectProposal", () => {
  test("happy path: rejecting leaves the baseline revision completely unchanged", async () => {
    const base = await revisionOf("# Plan\nbaseline.\n");
    const proposal = {
      baseRevisionId: base.id,
      candidateSource: "# Plan\nrejected change.\n",
    };
    const result = rejectProposal(proposal, base);
    expect(result).toBe(base);
    expect(result.document.source).toBe("# Plan\nbaseline.\n");
  });

  test("edge: rejecting a proposal with a stale base still leaves baseline unchanged", async () => {
    const base = await revisionOf("# Plan\nbaseline.\n");
    const staleProposal = {
      baseRevisionId: "f".repeat(64),
      candidateSource: "irrelevant",
    };
    const result = rejectProposal(staleProposal, base);
    expect(result).toBe(base);
  });
});

describe("integration: prior revisions and proposals survive further mutation", () => {
  test("applying a second proposal against the new base does not alter the first revision object", async () => {
    const base = await revisionOf("v1\n");
    const first = await applyProposal(
      { baseRevisionId: base.id, candidateSource: "v2\n" },
      base,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await applyProposal(
      { baseRevisionId: first.revision.id, candidateSource: "v3\n" },
      first.revision,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(base.document.source).toBe("v1\n");
    expect(first.revision.document.source).toBe("v2\n");
    expect(second.revision.document.source).toBe("v3\n");
  });
});
