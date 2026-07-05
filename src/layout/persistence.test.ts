import { beforeEach, describe, expect, test } from "bun:test";
import {
  __setStorageItemForTests,
  clearLayout,
  loadLayout,
  saveLayout,
} from "./persistence";
import { __resetRegistryForTests, registerPanelType } from "./registry";

// biome-ignore lint/suspicious/noExplicitAny: dummy component for registry-only tests
const DummyComponent = (() => null) as any;

beforeEach(() => {
  __resetRegistryForTests();
  registerPanelType("roster", { component: DummyComponent, title: "Roster" });
  registerPanelType("placeholder", {
    component: DummyComponent,
    title: "Placeholder",
  });
  clearLayout("/workspace/a");
  clearLayout("/workspace/b");
  clearLayout("/workspace/never-saved");
});

describe("saveLayout / loadLayout", () => {
  test("round-trips a layout for a given workspace path", () => {
    const layout = {
      panels: { p1: { id: "p1", panelType: "roster" } },
      groups: {},
    };

    saveLayout("/workspace/a", layout);
    const loaded = loadLayout("/workspace/a");

    expect(loaded).toEqual(layout);
  });

  test("keys layouts independently per workspace path", () => {
    saveLayout("/workspace/a", {
      panels: { p1: { id: "p1", panelType: "roster" } },
    });
    saveLayout("/workspace/b", {
      panels: { p2: { id: "p2", panelType: "roster" } },
    });

    expect(loadLayout("/workspace/a")).toEqual({
      panels: { p1: { id: "p1", panelType: "roster" } },
    });
    expect(loadLayout("/workspace/b")).toEqual({
      panels: { p2: { id: "p2", panelType: "roster" } },
    });
  });

  test("returns undefined when nothing is saved", () => {
    expect(loadLayout("/workspace/never-saved")).toBeUndefined();
  });

  test("clearLayout removes the saved entry", () => {
    saveLayout("/workspace/a", { panels: {} });
    clearLayout("/workspace/a");
    expect(loadLayout("/workspace/a")).toBeUndefined();
  });
});

describe("saveLayout — strips live/sensitive params", () => {
  test("persists plain-data params but not live service objects or callbacks", () => {
    const onSelectProject = () => {};
    const layout = {
      panels: {
        transcript: {
          id: "transcript",
          panelType: "transcript",
          params: {
            directory: "/repo",
            sessionID: "sess-1",
            client: { listMessages: () => {} },
            demux: { subscribe: () => {} },
            store: { getSessions: () => [] },
            context: { credentials: { password: "secret" } },
            onSelectProject,
          },
        },
      },
      groups: {},
    };

    saveLayout("/workspace/a", layout);
    const loaded = loadLayout("/workspace/a") as {
      panels: Record<string, { params?: Record<string, unknown> }>;
    };

    const params = loaded.panels.transcript?.params;
    expect(params?.directory).toBe("/repo");
    expect(params?.sessionID).toBe("sess-1");
    expect(params).not.toHaveProperty("client");
    expect(params).not.toHaveProperty("demux");
    expect(params).not.toHaveProperty("store");
    expect(params).not.toHaveProperty("context");
    expect(params).not.toHaveProperty("onSelectProject");
  });

  test("round-trip yields no live keys, and a panel with only a live demux loads with the key absent (not {})", () => {
    const layout = {
      panels: {
        transcript: {
          id: "transcript",
          panelType: "transcript",
          params: { demux: { subscribe: () => {} } },
        },
      },
      groups: {},
    };

    saveLayout("/workspace/a", layout);
    const loaded = loadLayout("/workspace/a") as {
      panels: Record<string, { params?: Record<string, unknown> }>;
    };

    expect(loaded.panels.transcript?.params).not.toHaveProperty("demux");
  });

  test("does not mutate the in-memory layout passed to saveLayout", () => {
    const demux = { subscribe: () => {} };
    const layout = {
      panels: {
        transcript: {
          id: "transcript",
          panelType: "transcript",
          params: { demux },
        },
      },
      groups: {},
    };

    saveLayout("/workspace/a", layout);

    expect(layout.panels.transcript.params.demux).toBe(demux);
  });
});

describe("loadLayout — unregistered panel type substitution", () => {
  test("rewrites an unregistered panel type to 'placeholder', hydration continues", () => {
    const layout = {
      panels: {
        p1: { id: "p1", panelType: "roster" },
        p2: {
          id: "p2",
          panelType: "storybook-preview",
          params: { foo: "bar" },
        },
      },
      groups: {},
    };
    saveLayout("/workspace/a", layout);

    const loaded = loadLayout("/workspace/a");

    expect(loaded).toBeDefined();
    const panels = (
      loaded as {
        panels: Record<
          string,
          { panelType: string; params?: Record<string, unknown> }
        >;
      }
    ).panels;
    expect(panels.p1?.panelType).toBe("roster");
    expect(panels.p2?.panelType).toBe("placeholder");
    expect(panels.p2?.params).toEqual({
      foo: "bar",
      panelType: "storybook-preview",
    });
  });
});

describe("loadLayout — malformed persisted data", () => {
  test("returns undefined for unparseable JSON instead of throwing", () => {
    __setStorageItemForTests("/workspace/a", "{not json");

    expect(() => loadLayout("/workspace/a")).not.toThrow();
    expect(loadLayout("/workspace/a")).toBeUndefined();
  });

  test("returns undefined for a non-object JSON value", () => {
    __setStorageItemForTests("/workspace/a", JSON.stringify("just a string"));

    expect(loadLayout("/workspace/a")).toBeUndefined();
  });
});
