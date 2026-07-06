import { describe, expect, test } from "bun:test";
import { createSessionStore } from "./session-store";
import type { SseEvent } from "./types";

function evt(type: string, properties?: unknown): SseEvent {
  return { type, properties } as SseEvent;
}

describe("createSessionStore applyEvent", () => {
  test("session.created adds a session", () => {
    const store = createSessionStore();
    store.applyEvent(
      evt("session.created", { id: "ses_1", directory: "/proj", title: "t" }),
    );
    expect(store.getSession("ses_1")).toEqual({
      id: "ses_1",
      directory: "/proj",
      title: "t",
      status: "unknown",
    });
  });

  test("session.status mutates busy state", () => {
    const store = createSessionStore();
    store.applyEvent(evt("session.created", { id: "ses_1" }));
    store.applyEvent(
      evt("session.status", { sessionID: "ses_1", type: "busy" }),
    );
    expect(store.getSession("ses_1")?.status).toBe("busy");
  });

  test("session.idle sets idle status", () => {
    const store = createSessionStore();
    store.applyEvent(evt("session.created", { id: "ses_1" }));
    store.applyEvent(
      evt("session.status", { sessionID: "ses_1", type: "busy" }),
    );
    store.applyEvent(evt("session.idle", { sessionID: "ses_1" }));
    expect(store.getSession("ses_1")?.status).toBe("idle");
  });

  test("session.deleted removes the session", () => {
    const store = createSessionStore();
    store.applyEvent(evt("session.created", { id: "ses_1" }));
    store.applyEvent(evt("session.deleted", { id: "ses_1" }));
    expect(store.getSession("ses_1")).toBeUndefined();
  });

  test("pendingQuestions derived from question.asked, cleared on question.replied", () => {
    const store = createSessionStore();
    store.applyEvent(
      evt("question.asked", {
        id: "que_1",
        sessionID: "ses_1",
        questions: [{ question: "Proceed?", options: [{ label: "Yes" }] }],
      }),
    );
    expect(store.getPendingQuestions()).toHaveLength(1);
    expect(store.getPendingQuestions("ses_1")[0]?.requestID).toBe("que_1");

    store.applyEvent(
      evt("question.replied", {
        sessionID: "ses_1",
        requestID: "que_1",
        answers: [["Yes"]],
      }),
    );
    expect(store.getPendingQuestions()).toHaveLength(0);
  });

  test("question.rejected also clears the pending question", () => {
    const store = createSessionStore();
    store.applyEvent(
      evt("question.asked", { id: "que_1", sessionID: "ses_1" }),
    );
    store.applyEvent(evt("question.rejected", { requestID: "que_1" }));
    expect(store.getPendingQuestions()).toHaveLength(0);
  });

  test("session.deleted also clears that session's pending questions", () => {
    const store = createSessionStore();
    store.applyEvent(
      evt("question.asked", { id: "que_1", sessionID: "ses_1" }),
    );
    store.applyEvent(evt("session.deleted", { id: "ses_1" }));
    expect(store.getPendingQuestions()).toHaveLength(0);
  });

  test("unknown event type does not throw and is ignored", () => {
    const store = createSessionStore();
    expect(() => store.applyEvent(evt("some.future.type", {}))).not.toThrow();
  });

  test("subscribe fires on mutation with a fresh snapshot", () => {
    const store = createSessionStore();
    const snapshots: number[] = [];
    store.subscribe((snap) => snapshots.push(snap.sessions.length));
    store.applyEvent(evt("session.created", { id: "ses_1" }));
    expect(snapshots).toEqual([1]);
  });
});

describe("createSessionStore — real timestamp capture (updatedAt)", () => {
  test("session.created event with a time payload populates updatedAt", () => {
    const store = createSessionStore();
    store.applyEvent(
      evt("session.created", {
        id: "ses_1",
        time: { created: 1000, updated: 1000 },
      }),
    );
    expect(store.getSession("ses_1")?.updatedAt).toBe(1000);
  });

  test("session.updated event with a fresher time payload bumps updatedAt", () => {
    const store = createSessionStore();
    store.applyEvent(
      evt("session.created", {
        id: "ses_1",
        time: { created: 1000, updated: 1000 },
      }),
    );
    store.applyEvent(
      evt("session.updated", {
        id: "ses_1",
        time: { created: 1000, updated: 2000 },
      }),
    );
    expect(store.getSession("ses_1")?.updatedAt).toBe(2000);
  });

  test("missing time field -> updatedAt undefined, no crash", () => {
    const store = createSessionStore();
    expect(() =>
      store.applyEvent(evt("session.created", { id: "ses_1" })),
    ).not.toThrow();
    expect(store.getSession("ses_1")?.updatedAt).toBeUndefined();
  });
});

describe("createSessionStore reconcile", () => {
  test("reconcile replaces the authoritative set — a session present before but absent is removed", () => {
    const store = createSessionStore();
    store.applyEvent(
      evt("session.created", { id: "ses_1", directory: "/proj" }),
    );
    store.applyEvent(
      evt("session.created", { id: "ses_2", directory: "/proj" }),
    );
    expect(store.getSessions("/proj")).toHaveLength(2);

    store.reconcile({
      directory: "/proj",
      sessions: [{ id: "ses_1" }],
    });

    expect(store.getSessions("/proj").map((s) => s.id)).toEqual(["ses_1"]);
  });

  test("reconcile only removes sessions scoped to the reconciled directory", () => {
    const store = createSessionStore();
    store.applyEvent(evt("session.created", { id: "ses_a", directory: "/a" }));
    store.applyEvent(evt("session.created", { id: "ses_b", directory: "/b" }));

    store.reconcile({ directory: "/a", sessions: [] });

    expect(store.getSession("ses_a")).toBeUndefined();
    expect(store.getSession("ses_b")).toBeDefined();
  });

  test("reconcile with sessions carrying time.updated populates updatedAt", () => {
    const store = createSessionStore();
    store.reconcile({
      directory: "/proj",
      sessions: [{ id: "ses_1", time: { created: 500, updated: 1500 } }],
    });
    expect(store.getSession("ses_1")?.updatedAt).toBe(1500);
  });

  test("reconcile session missing time -> updatedAt stays undefined", () => {
    const store = createSessionStore();
    store.reconcile({
      directory: "/proj",
      sessions: [{ id: "ses_1" }],
    });
    expect(store.getSession("ses_1")?.updatedAt).toBeUndefined();
  });

  test("reconcile applies statuses to matching sessions", () => {
    const store = createSessionStore();
    store.reconcile({
      directory: "/proj",
      sessions: [{ id: "ses_1" }],
      statuses: { ses_1: { type: "busy" } },
    });
    expect(store.getSession("ses_1")?.status).toBe("busy");
  });

  test("reconcile replaces pendingQuestions for the reconciled directory's sessions", () => {
    const store = createSessionStore();
    store.applyEvent(
      evt("question.asked", { id: "que_stale", sessionID: "ses_1" }),
    );
    store.reconcile({
      directory: "/proj",
      sessions: [{ id: "ses_1" }],
      questions: [{ id: "que_fresh", sessionID: "ses_1" }],
    });
    const pending = store.getPendingQuestions("ses_1");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.requestID).toBe("que_fresh");
  });
});

describe("createSessionStore — zombie guard for status-only events", () => {
  test("session.status for an unknown session id is a no-op", () => {
    const store = createSessionStore();
    store.applyEvent(
      evt("session.status", { sessionID: "ses_ghost", type: "busy" }),
    );
    expect(store.getSession("ses_ghost")).toBeUndefined();
  });

  test("session.idle for an unknown session id is a no-op", () => {
    const store = createSessionStore();
    store.applyEvent(evt("session.idle", { sessionID: "ses_ghost" }));
    expect(store.getSession("ses_ghost")).toBeUndefined();
  });

  test("session.status applies once the session exists via reconcile", () => {
    const store = createSessionStore();
    store.applyEvent(
      evt("session.status", { sessionID: "ses_1", type: "busy" }),
    );
    expect(store.getSession("ses_1")).toBeUndefined();

    store.reconcile({ directory: "/proj", sessions: [{ id: "ses_1" }] });
    store.applyEvent(
      evt("session.status", { sessionID: "ses_1", type: "busy" }),
    );
    expect(store.getSession("ses_1")?.status).toBe("busy");
  });

  test("session.idle/status for a just-deleted session does not resurrect it", () => {
    const store = createSessionStore();
    store.applyEvent(evt("session.created", { id: "ses_1" }));
    store.applyEvent(evt("session.deleted", { id: "ses_1" }));

    store.applyEvent(
      evt("session.status", { sessionID: "ses_1", type: "busy" }),
    );
    expect(store.getSession("ses_1")).toBeUndefined();

    store.applyEvent(evt("session.idle", { sessionID: "ses_1" }));
    expect(store.getSession("ses_1")).toBeUndefined();
  });
});
