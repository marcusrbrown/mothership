import { describe, expect, test } from "bun:test";
import type { SnapshotProject } from "../../server/bus";
import { toSessionRows, toSessionsViewState } from "./sessions-view";

function project(overrides: Partial<SnapshotProject> = {}): SnapshotProject {
  return { name: "proj-a", path: "/proj-a", exists: true, ...overrides };
}

describe("toSessionRows", () => {
  test("maps pendingQuestions to busy session rows", () => {
    const rows = toSessionRows(
      project({
        pendingQuestions: [
          { sessionId: "s1", preview: "Deploy now?", options: ["Yes", "No"] },
        ],
      }),
    );
    expect(rows).toEqual([{ id: "s1", title: "Deploy now?", busy: true }]);
  });

  test("no project -> empty rows", () => {
    expect(toSessionRows(undefined)).toEqual([]);
  });

  test("project with no pending questions -> empty rows", () => {
    expect(toSessionRows(project())).toEqual([]);
  });
});

describe("toSessionsViewState", () => {
  test("error result -> error state", () => {
    expect(toSessionsViewState({ ok: false, error: "boom" })).toEqual({
      status: "error",
      message: "boom",
    });
  });

  test("no rows -> empty state", () => {
    expect(toSessionsViewState({ ok: true, project: project() })).toEqual({
      status: "empty",
    });
  });

  test("rows present -> ready state", () => {
    const state = toSessionsViewState({
      ok: true,
      project: project({
        pendingQuestions: [{ sessionId: "s1", preview: "p", options: [] }],
      }),
    });
    expect(state.status).toBe("ready");
  });
});
