import { describe, expect, test } from "bun:test";
import { executeCommand } from "../../layout/executor";
import { StubDockviewAdapter } from "../../layout/test-stub-adapter";
import { type SessionToolAuditEvent, createAuditStore } from "./audit-store";

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

describe("audit-store: session-tool events", () => {
  test("happy path: recordSessionToolEvent appends a bounded, allowlisted entry", () => {
    const store = createAuditStore();
    try {
      store.recordSessionToolEvent({
        tool: "ide_get_transcript",
        source: "mcp_tool",
        project: "dashboard",
        sessionId: "ses_1",
        outcome: "ok",
        bytes: { returned: 128, original: 512 },
        truncated: true,
      });
      const entries = store.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        source: "mcp_tool",
        command: "ide_get_transcript",
        result: "ok",
      });
    } finally {
      store.__dispose();
    }
  });

  test("happy path: an errored session-tool event records the error code, not a free-form message", () => {
    const store = createAuditStore();
    try {
      store.recordSessionToolEvent({
        tool: "ide_dispatch_prompt",
        source: "mcp_tool",
        project: "dashboard",
        outcome: "error",
        errorCode: "unknown_project",
      });
      const [entry] = store.getEntries();
      expect(entry?.result).toBe("error:unknown_project");
    } finally {
      store.__dispose();
    }
  });

  test("regression: session-tool events share the same ring buffer and cap as layout events", () => {
    const store = createAuditStore();
    const adapter = makeAdapter();
    try {
      for (let i = 0; i < 250; i++) {
        executeCommand({ type: "focus", panelId: `p${i}` }, adapter);
      }
      for (let i = 0; i < 300; i++) {
        store.recordSessionToolEvent({
          tool: "ide_list_projects",
          source: "mcp_tool",
          outcome: "ok",
        });
      }
      const entries = store.getEntries();
      expect(entries).toHaveLength(500);
      // Oldest 50 layout entries dropped first; ring buffer is shared, not
      // partitioned per event kind.
      expect(entries[0]?.command).toBe("focus");
    } finally {
      store.__dispose();
    }
  });

  test("security: session-tool event fields are closed — no free-form content field exists on the type to even accidentally populate", () => {
    const store = createAuditStore();
    try {
      // TypeScript already refuses an extra field at the call site; this
      // test's real assertion is the negative-construction tests below,
      // which prove a *runtime* refusal backstop exists in addition to
      // the type-level one.
      store.recordSessionToolEvent({
        tool: "ide_get_transcript",
        source: "mcp_tool",
        sessionId: "ses_1",
        outcome: "ok",
      });
      expect(store.getEntries()).toHaveLength(1);
    } finally {
      store.__dispose();
    }
  });

  test("security: construction refuses a fixture carrying a sensitive key anywhere in the event, even nested/renamed past the closed type", () => {
    const store = createAuditStore();
    try {
      const poisoned = {
        tool: "ide_dispatch_prompt",
        source: "mcp_tool",
        outcome: "ok",
        // Not representable in SessionToolAuditEvent's declared type —
        // simulates a caller bypassing TS (e.g. via `as any`, a JS
        // caller, or a future field added without updating this guard).
        prompt: "please rm -rf my drive",
      } as unknown as SessionToolAuditEvent;
      expect(() => store.recordSessionToolEvent(poisoned)).toThrow();
      expect(store.getEntries()).toHaveLength(0);
    } finally {
      store.__dispose();
    }
  });

  test("security: construction refuses transcript/question/answer/header/path/credential-shaped keys at any nesting depth", () => {
    const store = createAuditStore();
    const sensitiveFixtures: Record<string, unknown>[] = [
      { transcript: "the whole conversation" },
      { question: "should I proceed?" },
      { answer: "yes" },
      { header: "Proceed?" },
      { path: "/Users/marcus/secret" },
      { directory: "/Users/marcus/secret" },
      { credentials: { password: "hunter2" } },
      { authorization: "Basic xyz" },
      { nested: { deeply: { answer: "yes" } } },
    ];
    try {
      for (const fixture of sensitiveFixtures) {
        const poisoned = {
          tool: "ide_answer_question",
          source: "mcp_tool",
          outcome: "ok",
          ...fixture,
        } as unknown as SessionToolAuditEvent;
        expect(() => store.recordSessionToolEvent(poisoned)).toThrow();
      }
      expect(store.getEntries()).toHaveLength(0);
    } finally {
      store.__dispose();
    }
  });

  test("edge case: truncation metadata records the original/returned size without embedding truncated content", () => {
    const store = createAuditStore();
    try {
      store.recordSessionToolEvent({
        tool: "ide_get_transcript",
        source: "mcp_tool",
        sessionId: "ses_1",
        outcome: "ok",
        bytes: { returned: 1024, original: 8192 },
        truncated: true,
      });
      const [entry] = store.getEntries();
      expect(entry?.paramSummary).toContain("1024");
      expect(entry?.paramSummary).toContain("8192");
      expect(entry?.paramSummary).toContain("truncated");
    } finally {
      store.__dispose();
    }
  });

  test("notifies subscribers on a session-tool event push, same as layout events", () => {
    const store = createAuditStore();
    let seen: number | undefined;
    const unsubscribe = store.subscribe((entries) => {
      seen = entries.length;
    });
    try {
      store.recordSessionToolEvent({
        tool: "ide_list_sessions",
        source: "ui",
        outcome: "ok",
      });
      expect(seen).toBe(1);
    } finally {
      unsubscribe();
      store.__dispose();
    }
  });

  test("happy path: a real fro-bot/dashboard-style project name (containing a slash) is accepted", () => {
    const store = createAuditStore();
    try {
      store.recordSessionToolEvent({
        tool: "ide_list_sessions",
        source: "ui",
        project: "fro-bot/dashboard",
        outcome: "ok",
      });
      expect(store.getEntries()).toHaveLength(1);
    } finally {
      store.__dispose();
    }
  });

  test("security: unknown top-level keys are refused, not silently dropped-and-recorded", () => {
    const store = createAuditStore();
    try {
      const poisoned = {
        tool: "ide_list_sessions",
        source: "ui",
        outcome: "ok",
        someFutureField: "not in the allowlist",
      } as unknown as SessionToolAuditEvent;
      expect(() => store.recordSessionToolEvent(poisoned)).toThrow();
      expect(store.getEntries()).toHaveLength(0);
    } finally {
      store.__dispose();
    }
  });

  test("security: an event whose prototype carries a poisoned inherited property is refused, even though the property is not its own", () => {
    const store = createAuditStore();
    try {
      const proto = { transcript: "inherited secret" };
      const poisoned = Object.assign(Object.create(proto), {
        tool: "ide_list_sessions",
        source: "ui",
        outcome: "ok",
      }) as SessionToolAuditEvent;
      expect(() => store.recordSessionToolEvent(poisoned)).toThrow();
      expect(store.getEntries()).toHaveLength(0);
    } finally {
      store.__dispose();
    }
  });

  test("security: a non-plain-object event (class instance, Map, function) is refused", () => {
    const store = createAuditStore();
    class Evil {
      tool = "ide_list_sessions";
      source = "ui";
      outcome = "ok";
    }
    const fixtures: unknown[] = [
      new Evil(),
      new Map([["tool", "ide_list_sessions"]]),
      Object.assign(() => {}, { tool: "x", source: "ui", outcome: "ok" }),
    ];
    try {
      for (const fixture of fixtures) {
        expect(() =>
          store.recordSessionToolEvent(fixture as SessionToolAuditEvent),
        ).toThrow();
      }
      expect(store.getEntries()).toHaveLength(0);
    } finally {
      store.__dispose();
    }
  });

  test("security: an accessor (getter) property is refused even if it would resolve to a safe-looking value", () => {
    const store = createAuditStore();
    try {
      const poisoned: Record<string, unknown> = {
        tool: "ide_list_sessions",
        source: "ui",
        outcome: "ok",
      };
      Object.defineProperty(poisoned, "sessionId", {
        enumerable: true,
        get() {
          return "ses_1";
        },
      });
      expect(() =>
        store.recordSessionToolEvent(poisoned as SessionToolAuditEvent),
      ).toThrow();
      expect(store.getEntries()).toHaveLength(0);
    } finally {
      store.__dispose();
    }
  });

  test("security: a cyclic event structure is refused rather than infinitely recursing or crashing uncontrolled", () => {
    const store = createAuditStore();
    try {
      const poisoned: Record<string, unknown> = {
        tool: "ide_list_sessions",
        source: "ui",
        outcome: "ok",
        bytes: { returned: 1, original: 2 },
      };
      (poisoned.bytes as Record<string, unknown>).self = poisoned.bytes;
      expect(() =>
        store.recordSessionToolEvent(poisoned as SessionToolAuditEvent),
      ).toThrow();
      expect(store.getEntries()).toHaveLength(0);
    } finally {
      store.__dispose();
    }
  });

  test("correctness: outcome:'error' requires an errorCode; a missing errorCode on an error outcome is refused", () => {
    const store = createAuditStore();
    try {
      const poisoned = {
        tool: "ide_dispatch_prompt",
        source: "mcp_tool",
        outcome: "error",
      } as SessionToolAuditEvent;
      expect(() => store.recordSessionToolEvent(poisoned)).toThrow();
      expect(store.getEntries()).toHaveLength(0);
    } finally {
      store.__dispose();
    }
  });

  test("correctness: outcome:'ok' must not carry an errorCode — that combination is refused rather than silently recorded", () => {
    const store = createAuditStore();
    try {
      const poisoned = {
        tool: "ide_dispatch_prompt",
        source: "mcp_tool",
        outcome: "ok",
        errorCode: "unknown_project",
      } as SessionToolAuditEvent;
      expect(() => store.recordSessionToolEvent(poisoned)).toThrow();
      expect(store.getEntries()).toHaveLength(0);
    } finally {
      store.__dispose();
    }
  });

  test("correctness: errorCode must be one of the known stable SessionToolErrorCode values, not an arbitrary string", () => {
    const store = createAuditStore();
    try {
      const poisoned = {
        tool: "ide_dispatch_prompt",
        source: "mcp_tool",
        outcome: "error",
        errorCode: "totally_made_up_code",
      } as unknown as SessionToolAuditEvent;
      expect(() => store.recordSessionToolEvent(poisoned)).toThrow();
      expect(store.getEntries()).toHaveLength(0);
    } finally {
      store.__dispose();
    }
  });

  test("correctness: source must be exactly 'ui' or 'mcp_tool'", () => {
    const store = createAuditStore();
    try {
      const poisoned = {
        tool: "ide_list_sessions",
        source: "evil_source",
        outcome: "ok",
      } as unknown as SessionToolAuditEvent;
      expect(() => store.recordSessionToolEvent(poisoned)).toThrow();
      expect(store.getEntries()).toHaveLength(0);
    } finally {
      store.__dispose();
    }
  });

  test("correctness: project/sessionId/requestId must be bounded safe logical identifiers — directory/home/relative-path-shaped values are refused", () => {
    const store = createAuditStore();
    const badIdentifiers = [
      "/Users/marcus/secret",
      "~/secret",
      "../escape",
      "C:\\Users\\marcus",
    ];
    try {
      for (const bad of badIdentifiers) {
        expect(() =>
          store.recordSessionToolEvent({
            tool: "ide_list_sessions",
            source: "ui",
            project: bad,
            outcome: "ok",
          }),
        ).toThrow();
      }
      expect(store.getEntries()).toHaveLength(0);
    } finally {
      store.__dispose();
    }
  });

  test("correctness: bytes fields must be finite nonnegative integers — negative, fractional, NaN, Infinity are refused", () => {
    const store = createAuditStore();
    const badBytes = [
      { returned: -1, original: 10 },
      { returned: 1.5, original: 10 },
      { returned: Number.NaN, original: 10 },
      { returned: Number.POSITIVE_INFINITY, original: 10 },
      { returned: 5, original: -1 },
    ];
    try {
      for (const bytes of badBytes) {
        expect(() =>
          store.recordSessionToolEvent({
            tool: "ide_get_transcript",
            source: "mcp_tool",
            outcome: "ok",
            bytes,
          }),
        ).toThrow();
      }
      expect(store.getEntries()).toHaveLength(0);
    } finally {
      store.__dispose();
    }
  });

  test("correctness: truncated must be a real boolean, not a truthy/falsy stand-in", () => {
    const store = createAuditStore();
    try {
      const poisoned = {
        tool: "ide_get_transcript",
        source: "mcp_tool",
        outcome: "ok",
        truncated: "yes",
      } as unknown as SessionToolAuditEvent;
      expect(() => store.recordSessionToolEvent(poisoned)).toThrow();
      expect(store.getEntries()).toHaveLength(0);
    } finally {
      store.__dispose();
    }
  });

  test("correctness: bytes.returned must never exceed bytes.original — reporting more bytes returned than existed is refused", () => {
    const store = createAuditStore();
    try {
      const poisoned = {
        tool: "ide_get_transcript",
        source: "mcp_tool",
        outcome: "ok",
        bytes: { returned: 100, original: 50 },
      } as SessionToolAuditEvent;
      expect(() => store.recordSessionToolEvent(poisoned)).toThrow();
      expect(store.getEntries()).toHaveLength(0);
    } finally {
      store.__dispose();
    }
  });

  test("correctness: bytes.returned equal to bytes.original (no truncation) is accepted", () => {
    const store = createAuditStore();
    try {
      store.recordSessionToolEvent({
        tool: "ide_get_transcript",
        source: "mcp_tool",
        outcome: "ok",
        bytes: { returned: 50, original: 50 },
        truncated: false,
      });
      expect(store.getEntries()).toHaveLength(1);
    } finally {
      store.__dispose();
    }
  });

  test("correctness: tool must match ^ide_[a-z0-9_]+$ — a non-ide_-prefixed, path/space/control/password-shaped, or empty tool name is refused", () => {
    const store = createAuditStore();
    const badToolNames = [
      "not_ide_prefixed",
      "ide_",
      "ide_HasUpperCase",
      "ide_has space",
      "ide_has/slash",
      "ide_has\ncontrol",
      "ide_password=hunter2",
      "",
      "IDE_LIST_SESSIONS",
    ];
    try {
      for (const tool of badToolNames) {
        expect(() =>
          store.recordSessionToolEvent({
            tool,
            source: "ui",
            outcome: "ok",
          }),
        ).toThrow();
      }
      expect(store.getEntries()).toHaveLength(0);
    } finally {
      store.__dispose();
    }
  });

  test("happy path: real ide_* tool names are accepted", () => {
    const store = createAuditStore();
    try {
      for (const tool of [
        "ide_list_projects",
        "ide_list_sessions",
        "ide_get_active_context",
        "ide_select_project",
        "ide_select_session",
        "ide_dispatch_prompt",
        "ide_get_transcript",
        "ide_list_pending_questions",
        "ide_answer_question",
      ]) {
        store.recordSessionToolEvent({ tool, source: "ui", outcome: "ok" });
      }
      expect(store.getEntries()).toHaveLength(9);
    } finally {
      store.__dispose();
    }
  });

  test("security: the recorded entry is built from an own-property-only fresh copy — mutating the caller's original object after the call does not retroactively change the stored entry", () => {
    const store = createAuditStore();
    try {
      const event = {
        tool: "ide_list_sessions",
        source: "ui" as const,
        project: "dashboard",
        outcome: "ok" as const,
      };
      store.recordSessionToolEvent(event);
      // biome-ignore lint/suspicious/noExplicitAny: mutating after the call to prove no live reference is retained
      (event as any).project = "mutated-after-the-fact";
      const [entry] = store.getEntries();
      expect(entry?.paramSummary).toContain("dashboard");
      expect(entry?.paramSummary).not.toContain("mutated-after-the-fact");
    } finally {
      store.__dispose();
    }
  });
});
