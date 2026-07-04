import { describe, expect, test } from "bun:test";
import { layoutStructureView, listPanelsView } from "./redact";

const layoutWithSecrets = {
  grid: { root: { type: "leaf", data: { id: "p1" } } },
  activeGroup: "g1",
  panels: {
    p1: {
      id: "p1",
      contentComponent: "roster",
      title: "Roster",
      params: {
        directory: "/Users/marcus/src/project-alpha",
        context: {
          credentials: { password: "hunter2" },
          token: "abc123",
        },
      },
    },
    p2: {
      id: "p2",
      contentComponent: "sessions",
      title: "Sessions",
      params: { authorization: "Bearer xyz", nested: { secret: "s" } },
    },
  },
};

describe("listPanelsView", () => {
  test("returns only id/panelType/title for every panel", () => {
    expect(listPanelsView(layoutWithSecrets)).toEqual([
      { id: "p1", panelType: "roster", title: "Roster" },
      { id: "p2", panelType: "sessions", title: "Sessions" },
    ]);
  });

  test("never surfaces params, directory, context, or credentials", () => {
    const json = JSON.stringify(listPanelsView(layoutWithSecrets));
    expect(json).not.toContain("directory");
    expect(json).not.toContain("context");
    expect(json).not.toContain("credentials");
    expect(json).not.toContain("password");
    expect(json).not.toContain("token");
    expect(json).not.toContain("hunter2");
    expect(json).not.toContain("project-alpha");
  });

  test("handles a layout with no panels", () => {
    expect(listPanelsView({})).toEqual([]);
  });
});

describe("layoutStructureView", () => {
  test("keeps grid structure and per-panel id/panelType/title", () => {
    const view = layoutStructureView(layoutWithSecrets);
    expect(view.grid).toEqual(layoutWithSecrets.grid);
    expect(view.activeGroup).toBe("g1");
    expect(view.panels).toEqual({
      p1: { id: "p1", panelType: "roster", title: "Roster" },
      p2: { id: "p2", panelType: "sessions", title: "Sessions" },
    });
  });

  test("drops ALL panel params — credentials/password/token/directory/context never appear", () => {
    const json = JSON.stringify(layoutStructureView(layoutWithSecrets));
    expect(json).not.toContain("credentials");
    expect(json).not.toContain("password");
    expect(json).not.toContain("token");
    expect(json).not.toContain("directory");
    expect(json).not.toContain("context");
    expect(json).not.toContain("hunter2");
    expect(json).not.toContain("abc123");
    expect(json).not.toContain("project-alpha");
  });

  test("drops a nested secret key even inside pass-through grid data (denylist backstop)", () => {
    // `grid` is copied through as-is (it's layout geometry, not params),
    // so this exercises the recursive denylist backstop rather than the
    // panel-entry allowlist.
    const sneaky = {
      panels: {},
      grid: { root: { authorization: "Bearer leak", nested: { token: "t" } } },
    };
    const json = JSON.stringify(layoutStructureView(sneaky));
    expect(json).not.toContain("leak");
    expect(json).not.toContain('"token"');
  });

  test("handles a layout with no panels", () => {
    expect(layoutStructureView({})).toEqual({ panels: {} });
  });
});
