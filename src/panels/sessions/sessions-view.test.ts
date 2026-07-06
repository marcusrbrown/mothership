import { describe, expect, test } from "bun:test";
import type { StoredSession } from "../../server/session-store";
import {
  isSubagentSession,
  toSessionRows,
  toSessionsViewState,
} from "./sessions-view";

function session(overrides: Partial<StoredSession> = {}): StoredSession {
  return { id: "s1", status: "idle", ...overrides };
}

describe("toSessionRows", () => {
  test("maps store sessions to rows, using id as title fallback", () => {
    const rows = toSessionRows([session({ id: "s1" })], new Set());
    expect(rows).toEqual([
      { id: "s1", title: "s1", busy: false, needsAttention: false },
    ]);
  });

  test("orders rows MOST-RECENT-FIRST by real updatedAt timestamp, NOT insertion order", () => {
    // Inserted A, B, C but timestamps make the true recency order C, A, B —
    // proving the sort follows the server timestamp, not array position.
    const rows = toSessionRows(
      [
        session({ id: "s-a", title: "A", updatedAt: 200 }),
        session({ id: "s-b", title: "B", updatedAt: 100 }),
        session({ id: "s-c", title: "C", updatedAt: 300 }),
      ],
      new Set(),
    );
    expect(rows.map((r) => r.id)).toEqual(["s-c", "s-a", "s-b"]);
  });

  test("timestamp-less rows sink below timestamped rows", () => {
    const rows = toSessionRows(
      [session({ id: "s-no-ts" }), session({ id: "s-ts", updatedAt: 100 })],
      new Set(),
    );
    expect(rows.map((r) => r.id)).toEqual(["s-ts", "s-no-ts"]);
  });

  test("equal or absent updatedAt falls back to stable insertion order", () => {
    const rows = toSessionRows(
      [
        session({ id: "s1", updatedAt: 100 }),
        session({ id: "s2", updatedAt: 100 }),
        session({ id: "s3" }),
        session({ id: "s4" }),
      ],
      new Set(),
    );
    expect(rows.map((r) => r.id)).toEqual(["s1", "s2", "s3", "s4"]);
  });

  test("busy derived from status === 'busy'", () => {
    const rows = toSessionRows([session({ status: "busy" })], new Set());
    expect(rows[0]?.busy).toBe(true);
  });

  test("needsAttention true when sessionId is in the pending set", () => {
    const rows = toSessionRows([session({ id: "s1" })], new Set(["s1"]));
    expect(rows[0]?.needsAttention).toBe(true);
  });

  test("no sessions -> empty rows", () => {
    expect(toSessionRows([], new Set())).toEqual([]);
  });
});

describe("isSubagentSession", () => {
  test("parentID present -> true regardless of title", () => {
    expect(
      isSubagentSession({ parentID: "parent-1", title: "Top level" }),
    ).toBe(true);
  });

  test("parentID present and no title -> true", () => {
    expect(isSubagentSession({ parentID: "parent-1" })).toBe(true);
  });

  test("no parentID, suffix match -> true (fallback)", () => {
    expect(
      isSubagentSession({ title: "Fix the tests (@fixer subagent)" }),
    ).toBe(true);
  });

  test("no parentID, email-like text -> false", () => {
    expect(isSubagentSession({ title: "email@example.com session" })).toBe(
      false,
    );
  });

  test("no parentID, mentions 'subagents' mid-string -> false", () => {
    expect(isSubagentSession({ title: "discussing subagents" })).toBe(false);
  });

  test("no parentID, pattern present but not at suffix -> false", () => {
    expect(isSubagentSession({ title: "(@a subagent) extra" })).toBe(false);
  });

  test("no parentID, no title -> false", () => {
    expect(isSubagentSession({})).toBe(false);
  });
});

describe("toSessionRows includeSubagents", () => {
  test("default (false) filters out subagent sessions, preserving order", () => {
    const rows = toSessionRows(
      [
        session({ id: "s1", title: "Top level" }),
        session({ id: "s2", title: "Fix (@fixer subagent)" }),
        session({ id: "s3", title: "Another top level" }),
      ],
      new Set(),
    );
    expect(rows.map((r) => r.id)).toEqual(["s1", "s3"]);
  });

  test("includeSubagents: true keeps all sessions", () => {
    const rows = toSessionRows(
      [
        session({ id: "s1", title: "Top level" }),
        session({ id: "s2", title: "Fix (@fixer subagent)" }),
      ],
      new Set(),
      { includeSubagents: true },
    );
    expect(rows.map((r) => r.id)).toEqual(["s1", "s2"]);
  });

  test("default (false) filters out sessions with parentID regardless of title", () => {
    const rows = toSessionRows(
      [
        session({ id: "s1", title: "Top level" }),
        session({ id: "s2", title: "No subagent marker", parentID: "s1" }),
      ],
      new Set(),
    );
    expect(rows.map((r) => r.id)).toEqual(["s1"]);
  });

  test("needsAttention on a hidden subagent session does not leak once filtered", () => {
    const rows = toSessionRows(
      [session({ id: "s2", title: "Fix (@fixer subagent)" })],
      new Set(["s2"]),
    );
    expect(rows).toEqual([]);
  });
});

describe("toSessionsViewState", () => {
  test("error result -> error state", () => {
    expect(toSessionsViewState({ ok: false, error: "boom" })).toEqual({
      status: "error",
      message: "boom",
    });
  });

  test("no sessions -> empty state", () => {
    expect(
      toSessionsViewState({
        ok: true,
        sessions: [],
        pendingSessionIds: new Set(),
      }),
    ).toEqual({ status: "empty" });
  });

  test("sessions present -> ready state with rows", () => {
    const state = toSessionsViewState({
      ok: true,
      sessions: [session({ id: "s1" })],
      pendingSessionIds: new Set(),
    });
    expect(state.status).toBe("ready");
  });
});
