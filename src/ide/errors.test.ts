import { describe, expect, test } from "bun:test";
import {
  DISPATCH_INDETERMINATE,
  INTERNAL_ERROR,
  UPSTREAM_ERROR,
  normalizeHandlerError,
  toolError,
} from "./errors";

describe("toolError", () => {
  test("happy path: builds a stable typed error with the given code/message", () => {
    const err = toolError("unknown_project", "No roster project named X");
    expect(err.code).toBe("unknown_project");
    expect(err.message).toBe("No roster project named X");
    expect(err.delivery).toBeUndefined();
  });

  test("happy path: delivery classification is preserved when provided", () => {
    const notSent = toolError("upstream_error", "failed", "not_sent");
    expect(notSent.delivery).toBe("not_sent");
    const indeterminate = toolError(
      "upstream_error",
      "failed",
      "indeterminate",
    );
    expect(indeterminate.delivery).toBe("indeterminate");
  });
});

describe("UPSTREAM_ERROR / INTERNAL_ERROR generic constants", () => {
  test("happy path: both are program-owned constant messages, not derived from any input", () => {
    const a = UPSTREAM_ERROR("not_sent");
    const b = UPSTREAM_ERROR("not_sent");
    expect(a.message).toBe(b.message);
    expect(a.code).toBe("upstream_error");

    const c = INTERNAL_ERROR("not_sent");
    expect(c.code).toBe("internal_error");
  });

  test("happy path: delivery classification is preserved", () => {
    expect(UPSTREAM_ERROR("indeterminate").delivery).toBe("indeterminate");
    expect(INTERNAL_ERROR("indeterminate").delivery).toBe("indeterminate");
  });

  test("security: UPSTREAM_ERROR/INTERNAL_ERROR take no raw text parameter at all — there is no call shape that could leak upstream/exception content", () => {
    // Structural proof: both are single-argument (delivery only) functions.
    expect(UPSTREAM_ERROR.length).toBe(1);
    expect(INTERNAL_ERROR.length).toBe(1);
  });

  test("security: neither constant's message ever contains a Bearer/Cookie/API-key/password/token/secret/Authorization-shaped substring", () => {
    for (const err of [
      UPSTREAM_ERROR("not_sent"),
      INTERNAL_ERROR("not_sent"),
    ]) {
      expect(err.message).not.toMatch(/bearer/i);
      expect(err.message).not.toMatch(/cookie/i);
      expect(err.message).not.toMatch(/api[-_]?key/i);
      expect(err.message).not.toMatch(/password/i);
      expect(err.message).not.toMatch(/token/i);
      expect(err.message).not.toMatch(/secret/i);
      expect(err.message).not.toMatch(/authorization/i);
    }
  });

  test("security: neither constant's message ever contains question/prompt/transcript-shaped substrings", () => {
    for (const err of [
      UPSTREAM_ERROR("not_sent"),
      INTERNAL_ERROR("not_sent"),
    ]) {
      expect(err.message).not.toMatch(/question/i);
      expect(err.message).not.toMatch(/prompt/i);
      expect(err.message).not.toMatch(/transcript/i);
      expect(err.message).not.toMatch(/answer/i);
    }
  });

  test("security: neither constant's message ever contains a plausible plain-text leak (path, header line)", () => {
    for (const err of [
      UPSTREAM_ERROR("not_sent"),
      INTERNAL_ERROR("not_sent"),
    ]) {
      expect(err.message).not.toContain("/");
      expect(err.message).not.toContain(":");
    }
  });
});

describe("normalizeHandlerError", () => {
  test("happy path: a known code maps to the program-owned constant message, never the handler's own message text", () => {
    const result = normalizeHandlerError({
      code: "unknown_project",
      message: "raw upstream text: /Users/marcus/.ssh/id_rsa Bearer abc123",
      delivery: "not_sent",
    });
    expect(result.code).toBe("unknown_project");
    expect(result.message).not.toContain("/Users/marcus");
    expect(result.message).not.toContain("Bearer abc123");
    expect(result.delivery).toBe("not_sent");
  });

  test("happy path: every known code produces a stable, deterministic message regardless of what the handler supplied", () => {
    const a = normalizeHandlerError({ code: "upstream_error", message: "x" });
    const b = normalizeHandlerError({ code: "upstream_error", message: "y" });
    expect(a.message).toBe(b.message);
  });

  test("happy path: delivery is preserved when present and well-typed", () => {
    expect(
      normalizeHandlerError({
        code: "internal_error",
        delivery: "indeterminate",
      }).delivery,
    ).toBe("indeterminate");
    expect(
      normalizeHandlerError({ code: "internal_error", delivery: "not_sent" })
        .delivery,
    ).toBe("not_sent");
  });

  test("happy path: delivery is omitted (not just undefined) when the handler didn't supply one", () => {
    const result = normalizeHandlerError({ code: "unknown_session" });
    expect(result.delivery).toBeUndefined();
    expect("delivery" in result).toBe(false);
  });

  test("error path: an unknown code falls back to INTERNAL_ERROR('indeterminate')", () => {
    const result = normalizeHandlerError({
      code: "totally_made_up_code",
      message: "whatever",
    });
    expect(result.code).toBe("internal_error");
    expect(result.delivery).toBe("indeterminate");
  });

  test("error path: a malformed delivery value falls back to INTERNAL_ERROR('indeterminate')", () => {
    const result = normalizeHandlerError({
      code: "unknown_project",
      delivery: "definitely_sent_i_promise",
    });
    expect(result.code).toBe("internal_error");
    expect(result.delivery).toBe("indeterminate");
  });

  test("error path: a missing code falls back to INTERNAL_ERROR('indeterminate')", () => {
    const result = normalizeHandlerError({ message: "no code at all" });
    expect(result.code).toBe("internal_error");
    expect(result.delivery).toBe("indeterminate");
  });

  test("error path: a non-object error value (string/number/null/undefined/array) falls back to INTERNAL_ERROR('indeterminate') without throwing", () => {
    for (const bad of [
      "raw string error",
      42,
      null,
      undefined,
      ["array", "error"],
      true,
    ]) {
      expect(() => normalizeHandlerError(bad)).not.toThrow();
      const result = normalizeHandlerError(bad);
      expect(result.code).toBe("internal_error");
      expect(result.delivery).toBe("indeterminate");
    }
  });

  test("security: a forged {code:'unknown_project', message:<credential text>} object never leaks its message field even though the code is valid", () => {
    const result = normalizeHandlerError({
      code: "unknown_project",
      message: "Authorization: Bearer secret-token-xyz",
    });
    expect(result.message).not.toContain("secret-token-xyz");
    expect(result.message).not.toContain("Bearer");
  });

  test("security: extra/unknown fields on the error object are ignored, not reflected into the result", () => {
    const result = normalizeHandlerError({
      code: "unknown_session",
      path: "/Users/marcus/secret",
      transcript: "leaked transcript text",
    } as unknown);
    expect(JSON.stringify(result)).not.toContain("/Users/marcus");
    expect(JSON.stringify(result)).not.toContain("leaked transcript");
  });

  test("happy path: a valid dispatch attempt envelope preserves its attempt metadata", () => {
    const result = normalizeHandlerError({
      code: "upstream_error",
      delivery: "indeterminate",
      attempt: {
        operation: "dispatch",
        target: "session",
        project: "dashboard",
        sessionId: "ses_1",
        messageId: "msg_000000000000aaaaaaaaaaaaaa",
        reconciliation: "unconfirmed",
      },
    });
    expect(result.attempt).toEqual({
      operation: "dispatch",
      target: "session",
      project: "dashboard",
      sessionId: "ses_1",
      messageId: "msg_000000000000aaaaaaaaaaaaaa",
      reconciliation: "unconfirmed",
    });
  });

  test("security: an attempt envelope with a target/sessionId mismatch is rejected -> falls back to internal_error/indeterminate", () => {
    const result = normalizeHandlerError({
      code: "upstream_error",
      delivery: "indeterminate",
      attempt: {
        operation: "dispatch",
        target: "project",
        project: "dashboard",
        sessionId: "ses_1",
        messageId: "msg_000000000000aaaaaaaaaaaaaa",
        reconciliation: "unconfirmed",
      },
    });
    expect(result.code).toBe("internal_error");
  });

  test("security: an attempt envelope carrying a stray field (timestamp/prompt/path) is rejected wholesale", () => {
    for (const stray of [
      { timestamp: Date.now() },
      { prompt: "secret prompt" },
      { path: "/Users/marcus/secret" },
      { candidateIds: ["ses_1", "ses_2"] },
    ]) {
      const result = normalizeHandlerError({
        code: "upstream_error",
        delivery: "indeterminate",
        attempt: {
          operation: "dispatch",
          target: "project",
          project: "dashboard",
          messageId: "msg_000000000000aaaaaaaaaaaaaa",
          reconciliation: "unconfirmed",
          ...stray,
        },
      });
      expect(result.code).toBe("internal_error");
    }
  });

  test("happy path: a non-dispatch error omits attempt entirely — no shape change for existing errors", () => {
    const result = normalizeHandlerError({ code: "unknown_project" });
    expect(result.attempt).toBeUndefined();
    expect(Object.keys(result)).not.toContain("attempt");
  });
});

describe("DISPATCH_INDETERMINATE", () => {
  test("happy path: builds a stable upstream_error/indeterminate with the given attempt metadata", () => {
    const err = DISPATCH_INDETERMINATE({
      operation: "dispatch",
      target: "project",
      project: "dashboard",
      messageId: "msg_000000000000aaaaaaaaaaaaaa",
      reconciliation: "unavailable",
    });
    expect(err.code).toBe("upstream_error");
    expect(err.delivery).toBe("indeterminate");
    expect(err.attempt?.reconciliation).toBe("unavailable");
    expect(err.message).toBe("The upstream operation failed.");
  });
});
