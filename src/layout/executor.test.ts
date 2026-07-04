import { beforeEach, describe, expect, test } from "bun:test";
import type { LayoutCommand } from "./commands";
import {
  type CommandExecutedEvent,
  executeCommand,
  onCommandExecuted,
} from "./executor";
import { __resetRegistryForTests, registerPanelType } from "./registry";
import { StubDockviewAdapter } from "./test-stub-adapter";

// biome-ignore lint/suspicious/noExplicitAny: dummy component for registry-only tests
const DummyComponent = (() => null) as any;

beforeEach(() => {
  __resetRegistryForTests();
  registerPanelType("roster", { component: DummyComponent, title: "Roster" });
  registerPanelType("terminal", {
    component: DummyComponent,
    title: "Terminal",
  });
});

describe("executeCommand — happy paths", () => {
  test("open_panel adds a panel via the adapter and returns serialized layout", () => {
    const adapter = new StubDockviewAdapter();
    const cmd: LayoutCommand = {
      type: "open_panel",
      panelId: "p1",
      panelType: "roster",
    };

    const result = executeCommand(cmd, adapter);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(adapter.calls[0]).toEqual({
        method: "addPanel",
        args: [
          {
            id: "p1",
            panelType: "roster",
            title: undefined,
            params: undefined,
            position: undefined,
          },
        ],
      });
      expect(
        (result.layout as { panels: Record<string, unknown> }).panels,
      ).toHaveProperty("p1");
    }
  });

  test("close_panel removes a panel via the adapter", () => {
    const adapter = new StubDockviewAdapter();
    executeCommand(
      { type: "open_panel", panelId: "p1", panelType: "roster" },
      adapter,
    );

    const result = executeCommand(
      { type: "close_panel", panelId: "p1" },
      adapter,
    );

    expect(result.ok).toBe(true);
    expect(adapter.hasPanel("p1")).toBe(false);
  });

  test("split adds a panel positioned relative to a reference panel", () => {
    const adapter = new StubDockviewAdapter();
    executeCommand(
      { type: "open_panel", panelId: "p1", panelType: "roster" },
      adapter,
    );

    const result = executeCommand(
      {
        type: "split",
        panelId: "p2",
        panelType: "terminal",
        referencePanelId: "p1",
        direction: "down",
      },
      adapter,
    );

    expect(result.ok).toBe(true);
    const call = adapter.calls.find(
      (c) =>
        c.method === "addPanel" && (c.args[0] as { id: string }).id === "p2",
    );
    expect(call?.args[0]).toEqual({
      id: "p2",
      panelType: "terminal",
      title: undefined,
      params: undefined,
      position: { referencePanelId: "p1", direction: "down" },
    });
  });

  test("focus activates a panel via the adapter", () => {
    const adapter = new StubDockviewAdapter();
    executeCommand(
      { type: "open_panel", panelId: "p1", panelType: "roster" },
      adapter,
    );
    executeCommand(
      { type: "open_panel", panelId: "p2", panelType: "terminal" },
      adapter,
    );

    const result = executeCommand({ type: "focus", panelId: "p1" }, adapter);

    expect(result.ok).toBe(true);
    expect(adapter.activePanel?.id).toBe("p1");
  });

  test("move_panel relocates a panel via the adapter", () => {
    const adapter = new StubDockviewAdapter();
    executeCommand(
      { type: "open_panel", panelId: "p1", panelType: "roster" },
      adapter,
    );
    executeCommand(
      { type: "open_panel", panelId: "p2", panelType: "terminal" },
      adapter,
    );

    const result = executeCommand(
      {
        type: "move_panel",
        panelId: "p2",
        referencePanelId: "p1",
        direction: "right",
      },
      adapter,
    );

    expect(result.ok).toBe(true);
    expect(adapter.calls.some((c) => c.method === "movePanel")).toBe(true);
  });

  test("set_layout replaces the layout via fromJSON", () => {
    const adapter = new StubDockviewAdapter();
    executeCommand(
      { type: "open_panel", panelId: "p1", panelType: "roster" },
      adapter,
    );
    const snapshot = adapter.toJSON();

    const fresh = new StubDockviewAdapter();
    const result = executeCommand(
      { type: "set_layout", layout: snapshot },
      fresh,
    );

    expect(result.ok).toBe(true);
    expect(fresh.hasPanel("p1")).toBe(true);
  });
});

describe("executeCommand — serialize/restore round-trip", () => {
  test("preserves panels, groups, and active panel", () => {
    const adapter = new StubDockviewAdapter();
    executeCommand(
      { type: "open_panel", panelId: "p1", panelType: "roster" },
      adapter,
    );
    executeCommand(
      { type: "open_panel", panelId: "p2", panelType: "terminal" },
      adapter,
    );
    executeCommand({ type: "focus", panelId: "p1" }, adapter);
    const snapshot = adapter.toJSON();

    const restored = new StubDockviewAdapter();
    executeCommand({ type: "set_layout", layout: snapshot }, restored);

    expect(restored.hasPanel("p1")).toBe(true);
    expect(restored.hasPanel("p2")).toBe(true);
    expect(restored.toJSON()).toEqual(snapshot);
  });
});

describe("executeCommand — edge cases", () => {
  test("focus on nonexistent id returns panel_not_found without throwing", () => {
    const adapter = new StubDockviewAdapter();
    const before = adapter.toJSON();

    const result = executeCommand(
      { type: "focus", panelId: "missing" },
      adapter,
    );

    expect(result).toEqual({
      ok: false,
      error: { code: "panel_not_found", message: expect.any(String) },
    });
    expect(adapter.toJSON()).toEqual(before);
  });

  test("close_panel on nonexistent id returns panel_not_found without throwing", () => {
    const adapter = new StubDockviewAdapter();
    const before = adapter.toJSON();

    const result = executeCommand(
      { type: "close_panel", panelId: "missing" },
      adapter,
    );

    expect(result).toEqual({
      ok: false,
      error: { code: "panel_not_found", message: expect.any(String) },
    });
    expect(adapter.toJSON()).toEqual(before);
  });

  test("open_panel with unknown type returns unknown_panel_type", () => {
    const adapter = new StubDockviewAdapter();

    const result = executeCommand(
      { type: "open_panel", panelId: "p1", panelType: "does-not-exist" },
      adapter,
    );

    expect(result).toEqual({
      ok: false,
      error: { code: "unknown_panel_type", message: expect.any(String) },
    });
    expect(adapter.hasPanel("p1")).toBe(false);
  });

  test("split referencing a nonexistent panel returns reference_panel_not_found", () => {
    const adapter = new StubDockviewAdapter();

    const result = executeCommand(
      {
        type: "split",
        panelId: "p2",
        panelType: "roster",
        referencePanelId: "missing",
        direction: "left",
      },
      adapter,
    );

    expect(result).toEqual({
      ok: false,
      error: { code: "reference_panel_not_found", message: expect.any(String) },
    });
  });

  test("move_panel with nonexistent panel id returns panel_not_found", () => {
    const adapter = new StubDockviewAdapter();
    executeCommand(
      { type: "open_panel", panelId: "p1", panelType: "roster" },
      adapter,
    );

    const result = executeCommand(
      {
        type: "move_panel",
        panelId: "missing",
        referencePanelId: "p1",
        direction: "left",
      },
      adapter,
    );

    expect(result).toEqual({
      ok: false,
      error: { code: "panel_not_found", message: expect.any(String) },
    });
  });
});

describe("executeCommand — error path", () => {
  test("set_layout with malformed JSON returns invalid_layout, layout untouched", () => {
    const adapter = new StubDockviewAdapter();
    executeCommand(
      { type: "open_panel", panelId: "p1", panelType: "roster" },
      adapter,
    );
    const before = adapter.toJSON();

    const result = executeCommand(
      // biome-ignore lint/suspicious/noExplicitAny: intentionally malformed input
      { type: "set_layout", layout: "not-an-object" as any },
      adapter,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_layout");
    expect(adapter.toJSON()).toEqual(before);
  });
});

describe("onCommandExecuted subscription", () => {
  test("fires with source attribution on every executed command", () => {
    const adapter = new StubDockviewAdapter();
    const events: CommandExecutedEvent[] = [];
    const unsubscribe = onCommandExecuted((event: CommandExecutedEvent) => {
      events.push(event);
    });

    executeCommand(
      { type: "open_panel", panelId: "p1", panelType: "roster" },
      adapter,
      { source: "ui" },
    );
    executeCommand({ type: "focus", panelId: "missing" }, adapter, {
      source: "mcp_tool",
    });

    unsubscribe();
    executeCommand({ type: "focus", panelId: "p1" }, adapter, { source: "ui" });

    expect(events).toHaveLength(2);
    expect(events[0]?.source).toBe("ui");
    expect(events[0]?.command.type).toBe("open_panel");
    expect(events[1]?.source).toBe("mcp_tool");
  });

  test("defaults source to 'ui' when unspecified", () => {
    const adapter = new StubDockviewAdapter();
    let captured: string | undefined;
    const unsubscribe = onCommandExecuted((event: CommandExecutedEvent) => {
      captured = event.source;
    });

    executeCommand(
      { type: "open_panel", panelId: "p1", panelType: "roster" },
      adapter,
    );

    unsubscribe();
    expect(captured).toBe("ui");
  });
});
