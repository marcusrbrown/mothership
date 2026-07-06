import { describe, expect, test } from "bun:test";
import type { SnapshotProject } from "../../server/bus";
import { toRosterRow, toRosterViewState } from "./roster-view";

function project(overrides: Partial<SnapshotProject> = {}): SnapshotProject {
  return {
    name: "proj-a",
    path: "~/src/proj-a",
    exists: true,
    ...overrides,
  };
}

describe("toRosterRow", () => {
  test("busy when busyCount > 0", () => {
    const row = toRosterRow(project({ busyCount: 2, sessionCount: 3 }));
    expect(row).toEqual({
      kind: "ok",
      project: expect.objectContaining({ busyCount: 2 }),
      busy: true,
      needsAttention: false,
      active: false,
    });
  });

  test("needsAttention true when project name is in the attention set", () => {
    const row = toRosterRow(project({ name: "a" }), true);
    expect(row.kind).toBe("ok");
    if (row.kind === "ok") expect(row.needsAttention).toBe(true);
  });

  test("idle when busyCount is 0 or absent", () => {
    const row = toRosterRow(project({ busyCount: 0 }));
    expect(row.kind).toBe("ok");
    if (row.kind === "ok") expect(row.busy).toBe(false);
  });

  test("exists:false -> missing-path row", () => {
    const row = toRosterRow(project({ exists: false }));
    expect(row.kind).toBe("missing-path");
  });

  test("per-project error -> status-error row, isolated from others", () => {
    const row = toRosterRow(project({ error: "server unreachable" }));
    expect(row).toEqual({
      kind: "status-error",
      project: expect.objectContaining({ error: "server unreachable" }),
      error: "server unreachable",
      active: false,
    });
  });
});

describe("toRosterRow active highlight (issue 3)", () => {
  test("active defaults to false when omitted", () => {
    const row = toRosterRow(project());
    expect(row.active).toBe(false);
  });

  test("active true is threaded through for an ok row", () => {
    const row = toRosterRow(project(), false, true);
    expect(row).toEqual({
      kind: "ok",
      project: expect.objectContaining({ name: "proj-a" }),
      busy: false,
      needsAttention: false,
      active: true,
    });
  });

  test("active true is threaded through for a missing-path row", () => {
    const row = toRosterRow(project({ exists: false }), false, true);
    expect(row).toEqual({
      kind: "missing-path",
      project: expect.objectContaining({ exists: false }),
      active: true,
    });
  });

  test("active true is threaded through for a status-error row", () => {
    const row = toRosterRow(project({ error: "boom" }), false, true);
    expect(row).toEqual({
      kind: "status-error",
      project: expect.objectContaining({ error: "boom" }),
      error: "boom",
      active: true,
    });
  });
});

describe("toRosterViewState", () => {
  test("empty projects -> empty state", () => {
    expect(toRosterViewState({ ok: true, projects: [] })).toEqual({
      status: "empty",
    });
  });

  test("fetch-level failure -> error state", () => {
    expect(toRosterViewState({ ok: false, error: "network down" })).toEqual({
      status: "error",
      message: "network down",
    });
  });

  test("mixed projects -> ready with per-row states, one bad project doesn't fail the rest", () => {
    const state = toRosterViewState({
      ok: true,
      projects: [
        project({ name: "a", busyCount: 1 }),
        project({ name: "b", exists: false }),
        project({ name: "c", error: "boom" }),
      ],
    });
    expect(state.status).toBe("ready");
    if (state.status !== "ready") throw new Error("expected ready");
    expect(state.rows).toHaveLength(3);
    expect(state.rows[0]?.kind).toBe("ok");
    expect(state.rows[1]?.kind).toBe("missing-path");
    expect(state.rows[2]?.kind).toBe("status-error");
  });

  test("issue 3 regression: activeDirectory highlights only the matching project's row (path === expanded directory)", () => {
    const state = toRosterViewState(
      {
        ok: true,
        projects: [
          project({ name: "dashboard", path: "/Users/marcus/src/dashboard" }),
          project({ name: "agent", path: "/Users/marcus/src/agent" }),
        ],
      },
      undefined,
      "/Users/marcus/src/agent",
    );
    expect(state.status).toBe("ready");
    if (state.status !== "ready") throw new Error("expected ready");
    expect(state.rows[0]?.active).toBe(false);
    expect(state.rows[1]?.active).toBe(true);
  });

  test("no activeDirectory -> no row highlighted (documented degradation, not an error)", () => {
    const state = toRosterViewState({
      ok: true,
      projects: [project({ name: "a" })],
    });
    expect(state.status).toBe("ready");
    if (state.status !== "ready") throw new Error("expected ready");
    expect(state.rows[0]?.active).toBe(false);
  });
});
