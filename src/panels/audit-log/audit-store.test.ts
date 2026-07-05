import { describe, expect, test } from "bun:test";
import { executeCommand } from "../../layout/executor";
import { StubDockviewAdapter } from "../../layout/test-stub-adapter";
import { createAuditStore } from "./audit-store";

function makeAdapter(): StubDockviewAdapter {
  return new StubDockviewAdapter();
}

describe("audit-store", () => {
  test("subscribes and records executed commands with source attribution", () => {
    const store = createAuditStore();
    const adapter = makeAdapter();
    try {
      executeCommand({ type: "focus", panelId: "nonexistent" }, adapter, {
        source: "mcp_tool",
      });
      const entries = store.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.source).toBe("mcp_tool");
      expect(entries[0]?.command).toBe("focus");
      expect(entries[0]?.result).toBe("error:panel_not_found");
    } finally {
      store.__dispose();
    }
  });

  test("caps ring buffer at 500 entries, dropping oldest first", () => {
    const store = createAuditStore();
    const adapter = makeAdapter();
    try {
      for (let i = 0; i < 510; i++) {
        executeCommand({ type: "focus", panelId: `p${i}` }, adapter);
      }
      const entries = store.getEntries();
      expect(entries).toHaveLength(500);
      // Oldest 10 dropped: first surviving entry references p10.
      expect(entries[0]?.paramSummary).toContain("p10");
      expect(entries[entries.length - 1]?.paramSummary).toContain("p509");
    } finally {
      store.__dispose();
    }
  });

  test("summarizes params without leaking full nested objects", () => {
    const store = createAuditStore();
    const adapter = makeAdapter();
    try {
      executeCommand(
        {
          type: "open_panel",
          panelId: "x",
          panelType: "terminal",
          params: { secret: "shh" },
        },
        adapter,
      );
      const [entry] = store.getEntries();
      expect(entry?.paramSummary).toContain("panelId=");
      expect(entry?.paramSummary).toContain("params=");
      expect(entry?.paramSummary).not.toContain("shh");
    } finally {
      store.__dispose();
    }
  });

  test("recordNativeLayoutChange appends a source:'ui' entry outside the command flow", () => {
    const store = createAuditStore();
    try {
      store.recordNativeLayoutChange("panels=3");
      const entries = store.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        source: "ui",
        command: "layout_changed_native",
        paramSummary: "panels=3",
        result: "ok",
      });
    } finally {
      store.__dispose();
    }
  });

  test("notifies subscribers on push", () => {
    const store = createAuditStore();
    const adapter = makeAdapter();
    let seen: number | undefined;
    const unsubscribe = store.subscribe((entries) => {
      seen = entries.length;
    });
    try {
      executeCommand({ type: "focus", panelId: "z" }, adapter);
      expect(seen).toBe(1);
    } finally {
      unsubscribe();
      store.__dispose();
    }
  });
});
