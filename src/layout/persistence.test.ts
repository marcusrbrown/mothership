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
