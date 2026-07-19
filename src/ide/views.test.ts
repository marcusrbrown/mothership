import { describe, expect, test } from "bun:test";
import {
  activeContextView,
  boundText,
  projectView,
  sessionView,
  toSessionRowViews,
} from "./views";

describe("projectView", () => {
  test("happy path: allowlists name/status fields only, no path", () => {
    const view = projectView({
      name: "dashboard",
      path: "/Users/marcus/src/fro-bot/dashboard",
      description: "Operator dashboard",
      pathExists: true,
      busyCount: 1,
      sessionCount: 3,
    });
    expect(view).toEqual({
      name: "dashboard",
      exists: true,
      busyCount: 1,
      sessionCount: 3,
      sessionCountCapped: undefined,
      hasStatusError: false,
      snapshotUnknown: true,
      hasSnapshotError: false,
    });
  });

  test("security: never includes a description field even though the raw upstream object carries one", () => {
    const view = projectView({
      name: "dashboard",
      description: "Operator dashboard for the whole org — internal use only",
      pathExists: true,
    }) as unknown as Record<string, unknown>;
    expect(view.description).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain("Operator dashboard");
  });

  test("happy path: a matched snapshot entry's exists/busyCount/sessionCount take priority over the roster read", () => {
    const view = projectView(
      { name: "dashboard", pathExists: true, busyCount: 1, sessionCount: 3 },
      {
        exists: false,
        busyCount: 5,
        sessionCount: 9,
        sessionCountCapped: true,
      },
    );
    expect(view.exists).toBe(false);
    expect(view.busyCount).toBe(5);
    expect(view.sessionCount).toBe(9);
    expect(view.sessionCountCapped).toBe(true);
    expect(view.snapshotUnknown).toBe(false);
  });

  test("happy path: no matching snapshot entry -> snapshotUnknown:true, falls back to roster fields", () => {
    const view = projectView({
      name: "dashboard",
      pathExists: true,
      busyCount: 1,
    });
    expect(view.snapshotUnknown).toBe(true);
    expect(view.exists).toBe(true);
    expect(view.busyCount).toBe(1);
  });

  test("security: a snapshot entry's error surfaces only as hasSnapshotError:true, never the raw string", () => {
    const view = projectView(
      { name: "dashboard", pathExists: true },
      { error: "ECONNREFUSED 10.0.0.5:4096 (Bearer abc123)" },
    );
    expect(view.hasSnapshotError).toBe(true);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("ECONNREFUSED");
    expect(serialized).not.toContain("Bearer abc123");
    expect(serialized).not.toContain("10.0.0.5");
  });

  test("security: never includes a path/expandedPath/directory field from the snapshot entry either", () => {
    const view = projectView(
      { name: "dashboard", pathExists: true },
      {
        path: "/Users/marcus/src/fro-bot/dashboard",
        expandedPath: "/Users/marcus/src/fro-bot/dashboard",
        directory: "/Users/marcus/src/fro-bot/dashboard",
      },
    ) as unknown as Record<string, unknown>;
    expect(view.path).toBeUndefined();
    expect(view.expandedPath).toBeUndefined();
    expect(view.directory).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain("/Users/marcus");
  });

  test("happy path: a present statusError surfaces only as hasStatusError:true, never the raw string", () => {
    const view = projectView({
      name: "dashboard",
      pathExists: true,
      statusError: "connection refused to 10.0.0.5:4096 (password: hunter2)",
    });
    expect(view.hasStatusError).toBe(true);
    expect(JSON.stringify(view)).not.toContain("connection refused");
    expect(JSON.stringify(view)).not.toContain("hunter2");
    expect(JSON.stringify(view)).not.toContain("10.0.0.5");
  });

  test("security: a poisoned statusError (path/credential-shaped) never serializes in any form — not even truncated", () => {
    const poisonedValues = [
      "/Users/marcus/.ssh/id_rsa",
      "Authorization: Basic aGFja2Vy",
      "password=hunter2",
      "",
    ];
    for (const statusError of poisonedValues) {
      const view = projectView({ name: "dashboard", statusError });
      const serialized = JSON.stringify(view);
      expect(serialized).not.toContain("/Users/marcus");
      expect(serialized).not.toContain("Basic aGFja2Vy");
      expect(serialized).not.toContain("hunter2");
      // The raw value itself must never appear as a substring anywhere
      // in the serialized view, even the empty-string edge case (which
      // must still resolve to a boolean, not an empty string field).
      expect(typeof view.hasStatusError).toBe("boolean");
    }
  });

  test("security: never includes a path/expandedPath/directory field even if present on the raw upstream object", () => {
    const raw = {
      name: "dashboard",
      path: "/Users/marcus/src/fro-bot/dashboard",
      expandedPath: "/Users/marcus/src/fro-bot/dashboard",
      directory: "/Users/marcus/src/fro-bot/dashboard",
      description: "d",
      pathExists: true,
    };
    const view = projectView(raw) as unknown as Record<string, unknown>;
    expect(view.path).toBeUndefined();
    expect(view.expandedPath).toBeUndefined();
    expect(view.directory).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain("/Users/marcus");
  });

  test("security: never includes a credential/authorization field even if the raw object was poisoned with one", () => {
    const raw = {
      name: "dashboard",
      path: "/x",
      description: "d",
      pathExists: true,
      // biome-ignore lint/suspicious/noExplicitAny: intentionally malformed/poisoned fixture
      credentials: { password: "hunter2" } as any,
      // biome-ignore lint/suspicious/noExplicitAny: intentionally malformed/poisoned fixture
      authorization: "Basic xyz" as any,
    };
    const view = JSON.stringify(projectView(raw));
    expect(view).not.toContain("hunter2");
    expect(view).not.toContain("Basic xyz");
  });
});

describe("sessionView", () => {
  test("happy path: allowlists id/title/status fields, no directory", () => {
    const view = sessionView({
      id: "ses_1",
      directory: "/Users/marcus/src/fro-bot/dashboard",
      title: "Fix the thing",
      status: "busy",
      updatedAt: 100,
    });
    expect(view).toEqual({
      id: "ses_1",
      title: "Fix the thing",
      status: "busy",
      updatedAt: 100,
    });
  });

  test("security: never includes a directory field", () => {
    const view = sessionView({
      id: "ses_1",
      directory: "/Users/marcus/src/fro-bot/dashboard",
      status: "idle",
    }) as unknown as Record<string, unknown>;
    expect(view.directory).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain("/Users/marcus");
  });
});

describe("toSessionRowViews", () => {
  function session(
    overrides: Partial<{
      id: string;
      title: string;
      status: string;
      updatedAt: number;
      parentID: string;
    }> = {},
  ) {
    return { id: "ses_x", ...overrides };
  }

  test("happy path: default excludes subagent sessions (parentID present), preserving order", () => {
    const rows = toSessionRowViews(
      [
        session({ id: "s1", title: "Top level" }),
        session({ id: "s2", title: "Fix (@fixer subagent)" }),
        session({ id: "s3", title: "Another top", parentID: "s1" }),
      ],
      new Set(),
    );
    expect(rows.map((r) => r.id)).toEqual(["s1"]);
  });

  test("happy path: includeSubagents:true keeps all sessions", () => {
    const rows = toSessionRowViews(
      [
        session({ id: "s1", title: "Top level" }),
        session({ id: "s2", title: "Fix (@fixer subagent)" }),
      ],
      new Set(),
      { includeSubagents: true },
    );
    expect(rows.map((r) => r.id)).toEqual(["s1", "s2"]);
  });

  test("happy path: title-suffix fallback filters a subagent session lacking parentID", () => {
    const rows = toSessionRowViews(
      [session({ id: "s1", title: "Fix the tests (@fixer subagent)" })],
      new Set(),
    );
    expect(rows).toHaveLength(0);
  });

  test("happy path: parentID takes priority as the subagent signal regardless of title text", () => {
    const rows = toSessionRowViews(
      [session({ id: "s1", title: "No subagent marker", parentID: "parent" })],
      new Set(),
    );
    expect(rows).toHaveLength(0);
  });

  test("happy path: updatedAt-descending ordering, most recent first", () => {
    const rows = toSessionRowViews(
      [
        session({ id: "old", updatedAt: 100 }),
        session({ id: "new", updatedAt: 300 }),
        session({ id: "mid", updatedAt: 200 }),
      ],
      new Set(),
    );
    expect(rows.map((r) => r.id)).toEqual(["new", "mid", "old"]);
  });

  test("edge case: equal timestamps preserve stable (insertion) order", () => {
    const rows = toSessionRowViews(
      [
        session({ id: "a", updatedAt: 100 }),
        session({ id: "b", updatedAt: 100 }),
      ],
      new Set(),
    );
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
  });

  test("edge case: sessions with no updatedAt sink below timestamped sessions, stable among themselves", () => {
    const rows = toSessionRowViews(
      [
        session({ id: "no-ts-1" }),
        session({ id: "timestamped", updatedAt: 50 }),
        session({ id: "no-ts-2" }),
      ],
      new Set(),
    );
    expect(rows.map((r) => r.id)).toEqual([
      "timestamped",
      "no-ts-1",
      "no-ts-2",
    ]);
  });

  test("happy path: title falls back to id when absent", () => {
    const rows = toSessionRowViews([session({ id: "ses_notitle" })], new Set());
    expect(rows[0]?.title).toBe("ses_notitle");
  });

  test("happy path: busy is true only when status === 'busy'", () => {
    const rows = toSessionRowViews(
      [
        session({ id: "s1", status: "busy" }),
        session({ id: "s2", status: "idle" }),
        session({ id: "s3" }),
      ],
      new Set(),
    );
    expect(rows.find((r) => r.id === "s1")?.busy).toBe(true);
    expect(rows.find((r) => r.id === "s2")?.busy).toBe(false);
    expect(rows.find((r) => r.id === "s3")?.busy).toBe(false);
  });

  test("happy path: needsAttention reflects pendingSessionIds membership", () => {
    const rows = toSessionRowViews(
      [session({ id: "s1" }), session({ id: "s2" })],
      new Set(["s1"]),
    );
    expect(rows.find((r) => r.id === "s1")?.needsAttention).toBe(true);
    expect(rows.find((r) => r.id === "s2")?.needsAttention).toBe(false);
  });

  test("security: needsAttention on a hidden subagent session never leaks once filtered", () => {
    const rows = toSessionRowViews(
      [session({ id: "s2", title: "Fix (@fixer subagent)" })],
      new Set(["s2"]),
    );
    expect(rows).toHaveLength(0);
  });

  test("security: rows never carry directory, parentID, or updatedAt fields", () => {
    const rows = toSessionRowViews(
      [
        {
          id: "s1",
          title: "t",
          status: "idle",
          updatedAt: 1,
          parentID: undefined,
          directory: "/Users/marcus/src/dashboard",
        } as unknown as { id: string },
      ],
      new Set(),
    );
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain("/Users/marcus");
    expect(serialized).not.toContain("parentID");
    expect(serialized).not.toContain("updatedAt");
    expect(serialized).not.toContain("directory");
  });
});

describe("activeContextView", () => {
  test("happy path: both project and sessionId present", () => {
    const view = activeContextView({
      project: "dashboard",
      sessionId: "ses_1",
    });
    expect(view).toEqual({ project: "dashboard", sessionId: "ses_1" });
  });

  test("happy path: neither focused yet -> empty object, not null/undefined fields", () => {
    const view = activeContextView({});
    expect(view).toEqual({});
    expect("project" in view).toBe(false);
    expect("sessionId" in view).toBe(false);
  });

  test("happy path: only project focused", () => {
    const view = activeContextView({ project: "dashboard" });
    expect(view).toEqual({ project: "dashboard" });
  });

  test("security: never includes a directory field even if present on the raw input", () => {
    const view = activeContextView({
      project: "dashboard",
      // biome-ignore lint/suspicious/noExplicitAny: intentionally malformed/poisoned fixture
      directory: "/Users/marcus/secret" as any,
    }) as unknown as Record<string, unknown>;
    expect(view.directory).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain("/Users/marcus");
  });
});

describe("boundText", () => {
  test("happy path: text under the limit is returned unmodified, not truncated", () => {
    const result = boundText("hello world", 1000);
    expect(result.text).toBe("hello world");
    expect(result.truncated).toBe(false);
    expect(result.originalBytes).toBe(result.returnedBytes);
  });

  test("edge case: oversized text truncates deterministically at a UTF-8-safe boundary", () => {
    const text = "a".repeat(500);
    const result = boundText(text, 100);
    expect(result.truncated).toBe(true);
    expect(result.returnedBytes).toBeLessThanOrEqual(100);
    expect(result.originalBytes).toBe(500);
    // Truncated text is a valid UTF-8 string (no lone surrogate/partial
    // multi-byte sequence) — re-encoding round-trips without replacement
    // characters being introduced beyond what was already in the input.
    expect(result.text.length).toBeGreaterThan(0);
  });

  test("edge case: truncation never splits a multi-byte UTF-8 character", () => {
    // Each emoji is a 4-byte UTF-8 sequence; a naive byte-slice at an
    // arbitrary offset could split one in half.
    const text = "😀".repeat(50);
    const result = boundText(text, 101); // not a multiple of 4
    expect(result.truncated).toBe(true);
    const bytes = new TextEncoder().encode(result.text);
    expect(bytes.length).toBeLessThanOrEqual(101);
    // Re-encoding/decoding must not introduce U+FFFD replacement chars —
    // proof the cut landed on a full-character boundary.
    expect(result.text).not.toContain("\uFFFD");
  });

  test("edge case: empty text returns a valid non-truncated result", () => {
    const result = boundText("", 100);
    expect(result.text).toBe("");
    expect(result.truncated).toBe(false);
    expect(result.originalBytes).toBe(0);
    expect(result.returnedBytes).toBe(0);
  });

  test("security: original/returned byte counts are reported without the truncated tail ever being retrievable from the result", () => {
    const text = "secret-tail-content".repeat(20);
    const result = boundText(text, 10);
    expect(result.text.length).toBeLessThan(text.length);
    expect(JSON.stringify(result)).not.toContain(
      "secret-tail-content".repeat(5),
    );
  });

  test("edge case: budget smaller than the first code point returns an empty string, not a lone surrogate or partial byte sequence", () => {
    // "😀" is a 4-byte UTF-8 code point (U+1F600); budgets 1-3 cannot fit
    // even the first code point.
    for (const budget of [0, 1, 2, 3]) {
      const result = boundText("😀😀😀", budget);
      expect(result.text).toBe("");
      expect(result.truncated).toBe(true);
      expect(result.returnedBytes).toBe(0);
    }
  });

  test("edge case: never emits a lone UTF-16 surrogate — a budget landing mid-surrogate-pair drops the whole code point", () => {
    const text = "a😀b"; // 'a'=1 byte, emoji=4 bytes, 'b'=1 byte
    // Budget 2 fits 'a' (1 byte) but not the emoji (needs 4 more) — must
    // return "a", not "a" + a lone high surrogate.
    const result = boundText(text, 2);
    expect(result.text).toBe("a");
    expect(result.text).not.toContain("\uFFFD");
    // The returned string must itself be a well-formed sequence of
    // complete UTF-16 code units — no dangling surrogate half.
    const codeUnits = [...result.text];
    expect(codeUnits.every((cp) => cp.length <= 2)).toBe(true);
  });

  test("edge case: emoji/mixed-string budgets 1 through 5 all produce valid, non-corrupt output", () => {
    const text = "a😀b🎉c"; // mixed ASCII + two 4-byte emoji
    for (let budget = 1; budget <= 5; budget++) {
      const result = boundText(text, budget);
      const bytes = new TextEncoder().encode(result.text);
      expect(bytes.length).toBeLessThanOrEqual(budget);
      expect(result.text).not.toContain("\uFFFD");
      // Round-trip through the encoder/decoder must be lossless (proof
      // no code point was split): decoding the re-encoded bytes exactly
      // reproduces result.text.
      expect(new TextDecoder().decode(bytes)).toBe(result.text);
    }
  });

  test("edge case: iterating by Unicode code point (not UTF-16 code unit) — a surrogate pair is never split even when binary-search-by-index would land inside it", () => {
    // Four consecutive 4-byte emoji: byte offsets 0,4,8,12,16. A naive
    // UTF-16-code-unit binary search over budget=6 could land at index 3
    // (inside the second emoji's surrogate pair, since each emoji is 2
    // UTF-16 code units). Code-point iteration must instead land exactly
    // on a code-point boundary — after 1 whole emoji (4 bytes <= 6) but
    // not 2 whole emoji (8 bytes > 6).
    const text = "😀😀😀😀";
    const result = boundText(text, 6);
    expect(result.text).toBe("😀");
    expect(result.returnedBytes).toBe(4);
  });
});
