/**
 * Behavioral tests for content-addressed revisions and separate,
 * content-identity-preserving progress/feedback metadata (U2). Real
 * WebCrypto SHA-256, no mocks.
 */
import { describe, expect, test } from "bun:test";
import { parseDocument } from "./document";
import {
  type FeedbackEntry,
  type UnitProgressNote,
  createMetadata,
  createRevision,
  hashSource,
  withFeedback,
  withProgress,
} from "./revisions";

async function revisionOf(source: string) {
  const doc = parseDocument(source);
  if (!doc.ok) throw new Error("fixture source must parse");
  return createRevision(doc.value);
}

describe("hashSource / createRevision: identity", () => {
  test("happy path: identical source produces the identical revision id", async () => {
    const a = await hashSource("# Plan\n\nSome text.\n");
    const b = await hashSource("# Plan\n\nSome text.\n");
    expect(a).toBe(b);
  });

  test("id is deterministic, lowercase, 64-char hex (SHA-256)", async () => {
    const id = await hashSource("hello world");
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  test("known SHA-256 vector: empty string hashes to the well-known digest", async () => {
    const id = await hashSource("");
    expect(id).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  test("edge: a checkbox-only content change produces a different id", async () => {
    const unchecked = await hashSource("- [ ] **U1. Title**\n");
    const checked = await hashSource("- [x] **U1. Title**\n");
    expect(unchecked).not.toBe(checked);
  });

  test("edge: a comment-only content change produces a different id", async () => {
    const a = await hashSource("text <!-- note one --> more\n");
    const b = await hashSource("text <!-- note two --> more\n");
    expect(a).not.toBe(b);
  });

  test("edge: a trailing-newline-only change produces a different id", async () => {
    const a = await hashSource("content");
    const b = await hashSource("content\n");
    expect(a).not.toBe(b);
  });

  test("createRevision exposes the full immutable source, not hash-only", async () => {
    const source = "# Plan\n\nFull body text.\n";
    const revision = await revisionOf(source);
    expect(revision.document.source).toBe(source);
    expect(revision.id).toBe(await hashSource(source));
  });
});

describe("revision metadata: separation from content identity", () => {
  test("happy path: appending feedback does not change the revision id or document", async () => {
    const revision = await revisionOf("# Plan\nBody.\n");
    const metadata = createMetadata(revision.id);
    const updated = withFeedback(metadata, {
      body: "looks good",
      recordedAt: "2026-09-07T00:00:00.000Z",
    });
    expect(updated.revisionId).toBe(revision.id);
    expect(revision.id).toBe(await hashSource("# Plan\nBody.\n"));
  });

  test("happy path: appending progress preserves prior entries and old values", async () => {
    const revision = await revisionOf("# Plan\nBody.\n");
    const initial = createMetadata(revision.id);
    const afterFirst = withProgress(initial, {
      unitKey: "U1",
      status: "started",
      recordedAt: "2026-09-07T00:00:00.000Z",
    });
    const afterSecond = withProgress(afterFirst, {
      unitKey: "U1",
      status: "blocked",
      recordedAt: "2026-09-07T01:00:00.000Z",
    });
    expect(afterSecond.progress).toHaveLength(2);
    expect(afterSecond.progress[0]?.status).toBe("started");
    expect(afterSecond.progress[1]?.status).toBe("blocked");
    // old snapshot is untouched (immutable update)
    expect(afterFirst.progress).toHaveLength(1);
  });

  test("edge: feedback update returns a new object, not a mutated alias", async () => {
    const metadata = createMetadata("deadbeef".repeat(8));
    const updated = withFeedback(metadata, {
      body: "note",
      recordedAt: "2026-09-07T00:00:00.000Z",
    });
    expect(updated).not.toBe(metadata);
    expect(metadata.feedback).toHaveLength(0);
    expect(updated.feedback).toHaveLength(1);
  });

  test("edge: createMetadata's initial feedback array is frozen, not just the metadata object", () => {
    const metadata = createMetadata("a".repeat(64));
    expect(() => {
      (metadata.feedback as FeedbackEntry[]).push({
        revisionId: metadata.revisionId,
        body: "mutated",
        recordedAt: "2026-09-07T00:00:00.000Z",
      });
    }).toThrow();
    expect(metadata.feedback).toHaveLength(0);
  });

  test("edge: createMetadata's initial progress array is frozen, not just the metadata object", () => {
    const metadata = createMetadata("a".repeat(64));
    expect(() => {
      (metadata.progress as UnitProgressNote[]).push({
        revisionId: metadata.revisionId,
        unitKey: "U1",
        recordedAt: "2026-09-07T00:00:00.000Z",
      });
    }).toThrow();
    expect(metadata.progress).toHaveLength(0);
  });

  test("integration: two different revisions keep independently keyed metadata", async () => {
    const revisionA = await revisionOf("A\n");
    const revisionB = await revisionOf("B\n");
    const metaA = withFeedback(createMetadata(revisionA.id), {
      body: "for A",
      recordedAt: "2026-09-07T00:00:00.000Z",
    });
    const metaB = withFeedback(createMetadata(revisionB.id), {
      body: "for B",
      recordedAt: "2026-09-07T00:00:00.000Z",
    });
    expect(metaA.revisionId).not.toBe(metaB.revisionId);
    expect(metaA.feedback[0]?.body).toBe("for A");
    expect(metaB.feedback[0]?.body).toBe("for B");
  });
});
