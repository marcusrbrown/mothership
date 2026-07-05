import { describe, expect, test } from "bun:test";
import type { StoredSession } from "../../server/session-store";
import { toSessionRows, toSessionsViewState } from "./sessions-view";

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
