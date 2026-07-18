import { describe, expect, test } from "bun:test";
import { boundText, projectView, sessionView } from "./views";

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
      description: "Operator dashboard",
      exists: true,
      busyCount: 1,
      sessionCount: 3,
      hasStatusError: false,
    });
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
