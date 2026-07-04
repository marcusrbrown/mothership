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
});
