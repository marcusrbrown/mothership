import { describe, expect, test } from "bun:test";
import type { SessionStore } from "../server/session-store";
import type { BusContext } from "../server/types";
import { buildMentionItems, filterMentionItems } from "./mention-items";

const context: BusContext = {
  roster: {
    server: { baseUrl: "http://127.0.0.1:4096" },
    projects: [
      {
        name: "fro-bot/dashboard",
        path: "~/a",
        expandedPath: "/a",
        description: "",
        exists: true,
      },
      {
        name: "fro-bot/space-bus",
        path: "~/b",
        expandedPath: "/b",
        description: "",
        exists: true,
      },
    ],
  },
} as unknown as BusContext;

function fakeStore(sessions: { id: string; title?: string }[]): SessionStore {
  return {
    getSessions: () => sessions.map((s) => ({ ...s, status: "idle" as const })),
    getSession: () => undefined,
    getPendingQuestions: () => [],
    subscribe: () => () => {},
    applyEvent: () => {},
    reconcile: () => {},
  };
}

describe("buildMentionItems", () => {
  test("sources projects from the roster", () => {
    const items = buildMentionItems(context);
    expect(items).toEqual([
      { id: "fro-bot/dashboard", label: "fro-bot/dashboard", kind: "project" },
      { id: "fro-bot/space-bus", label: "fro-bot/space-bus", kind: "project" },
    ]);
  });

  test("no context -> empty list, no throw", () => {
    expect(buildMentionItems(undefined)).toEqual([]);
  });

  test("with a store, sessions are appended after projects", () => {
    const store = fakeStore([{ id: "sess-1", title: "control" }]);
    const items = buildMentionItems(context, store, "/a");
    expect(items).toEqual([
      { id: "fro-bot/dashboard", label: "fro-bot/dashboard", kind: "project" },
      { id: "fro-bot/space-bus", label: "fro-bot/space-bus", kind: "project" },
      { id: "sess-1", label: "control", kind: "session" },
    ]);
  });

  test("session without a title falls back to its id as the label", () => {
    const store = fakeStore([{ id: "sess-2" }]);
    const items = buildMentionItems(undefined, store);
    expect(items).toEqual([{ id: "sess-2", label: "sess-2", kind: "session" }]);
  });
});

describe("filterMentionItems", () => {
  const items = buildMentionItems(context);

  test("empty query returns everything", () => {
    expect(filterMentionItems(items, "")).toEqual(items);
  });

  test("case-insensitive substring match", () => {
    const result = filterMentionItems(items, "DASH");
    expect(result).toEqual([
      { id: "fro-bot/dashboard", label: "fro-bot/dashboard", kind: "project" },
    ]);
  });

  test("no match -> empty array", () => {
    expect(filterMentionItems(items, "zzz")).toEqual([]);
  });
});
