import { describe, expect, test } from "bun:test";
import { bridgeMessageSchema, bridgeResponseSchema } from "./bridge-protocol";

describe("bridgeResponseSchema: terminal shape enforcement", () => {
  test("happy path: ok:true domain:'layout' with layout present, no error/data — valid", () => {
    const result = bridgeResponseSchema.safeParse({
      kind: "response",
      domain: "layout",
      seq: 1,
      ok: true,
      layout: { panels: {} },
    });
    expect(result.success).toBe(true);
  });

  test("happy path: ok:true domain:'session' with data present, no error/layout — valid", () => {
    const result = bridgeResponseSchema.safeParse({
      kind: "response",
      domain: "session",
      seq: 1,
      ok: true,
      data: { id: "ses_1" },
    });
    expect(result.success).toBe(true);
  });

  test("happy path: ok:false domain:'layout' with error present, no data/layout — valid", () => {
    const result = bridgeResponseSchema.safeParse({
      kind: "response",
      domain: "layout",
      seq: 1,
      ok: false,
      error: { code: "panel_not_found", message: "x" },
    });
    expect(result.success).toBe(true);
  });

  test("happy path: ok:false domain:'session' with error present, no data/layout — valid", () => {
    const result = bridgeResponseSchema.safeParse({
      kind: "response",
      domain: "session",
      seq: 1,
      ok: false,
      error: { code: "unknown_tool", message: "x", delivery: "not_sent" },
    });
    expect(result.success).toBe(true);
  });

  test("happy path: ok:false domain:'transport' with error present, no data/layout — valid", () => {
    const result = bridgeResponseSchema.safeParse({
      kind: "response",
      domain: "transport",
      seq: 1,
      ok: false,
      error: { code: "invalid_request", message: "x", delivery: "not_sent" },
    });
    expect(result.success).toBe(true);
  });

  test("happy path: legacy missing-domain response with a valid layout success shape defaults to domain:'layout'", () => {
    const result = bridgeResponseSchema.safeParse({
      kind: "response",
      seq: 1,
      ok: true,
      layout: {},
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.domain).toBe("layout");
  });

  test("happy path: legacy missing-domain response with a valid layout error shape defaults to domain:'layout'", () => {
    const result = bridgeResponseSchema.safeParse({
      kind: "response",
      seq: 1,
      ok: false,
      error: { code: "panel_not_found", message: "x" },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.domain).toBe("layout");
  });

  test("error path: ok:false MUST carry error — a missing error is rejected regardless of domain", () => {
    for (const domain of ["layout", "session", "transport"] as const) {
      const result = bridgeResponseSchema.safeParse({
        kind: "response",
        domain,
        seq: 1,
        ok: false,
      });
      expect(result.success).toBe(false);
    }
  });

  test("error path: ok:false MUST NOT carry data or layout, regardless of domain", () => {
    const withData = bridgeResponseSchema.safeParse({
      kind: "response",
      domain: "session",
      seq: 1,
      ok: false,
      error: { code: "x", message: "y" },
      data: { leaked: true },
    });
    expect(withData.success).toBe(false);

    const withLayout = bridgeResponseSchema.safeParse({
      kind: "response",
      domain: "layout",
      seq: 1,
      ok: false,
      error: { code: "x", message: "y" },
      layout: {},
    });
    expect(withLayout.success).toBe(false);
  });

  test("error path: ok:true domain:'layout' MUST carry layout — missing layout is rejected", () => {
    const result = bridgeResponseSchema.safeParse({
      kind: "response",
      domain: "layout",
      seq: 1,
      ok: true,
    });
    expect(result.success).toBe(false);
  });

  test("error path: ok:true domain:'layout' MUST NOT carry error or data", () => {
    const withError = bridgeResponseSchema.safeParse({
      kind: "response",
      domain: "layout",
      seq: 1,
      ok: true,
      layout: {},
      error: { code: "x", message: "y" },
    });
    expect(withError.success).toBe(false);

    const withData = bridgeResponseSchema.safeParse({
      kind: "response",
      domain: "layout",
      seq: 1,
      ok: true,
      layout: {},
      data: { x: 1 },
    });
    expect(withData.success).toBe(false);
  });

  test("error path: ok:true domain:'session' MUST carry data — missing data is rejected", () => {
    const result = bridgeResponseSchema.safeParse({
      kind: "response",
      domain: "session",
      seq: 1,
      ok: true,
    });
    expect(result.success).toBe(false);
  });

  test("error path: ok:true domain:'session' MUST NOT carry error or layout", () => {
    const withError = bridgeResponseSchema.safeParse({
      kind: "response",
      domain: "session",
      seq: 1,
      ok: true,
      data: {},
      error: { code: "x", message: "y" },
    });
    expect(withError.success).toBe(false);

    const withLayout = bridgeResponseSchema.safeParse({
      kind: "response",
      domain: "session",
      seq: 1,
      ok: true,
      data: {},
      layout: {},
    });
    expect(withLayout.success).toBe(false);
  });

  test("error path: domain:'transport' is error-only — ok:true is rejected outright, regardless of what else is present", () => {
    const result = bridgeResponseSchema.safeParse({
      kind: "response",
      domain: "transport",
      seq: 1,
      ok: true,
      data: {},
    });
    expect(result.success).toBe(false);
  });

  test("error path: domain:'transport' MUST NOT carry data or layout even when ok:false", () => {
    const withData = bridgeResponseSchema.safeParse({
      kind: "response",
      domain: "transport",
      seq: 1,
      ok: false,
      error: { code: "x", message: "y" },
      data: {},
    });
    expect(withData.success).toBe(false);

    const withLayout = bridgeResponseSchema.safeParse({
      kind: "response",
      domain: "transport",
      seq: 1,
      ok: false,
      error: { code: "x", message: "y" },
      layout: {},
    });
    expect(withLayout.success).toBe(false);
  });

  test("error path: an unknown/bogus domain value is rejected", () => {
    const result = bridgeResponseSchema.safeParse({
      kind: "response",
      domain: "bogus",
      seq: 1,
      ok: true,
      layout: {},
    });
    expect(result.success).toBe(false);
  });

  test("error path: legacy missing-domain response is ONLY compatible when it has a valid layout success/error shape — a missing-domain response with 'data' (never a valid legacy layout wire shape) is rejected, not silently defaulted", () => {
    const result = bridgeResponseSchema.safeParse({
      kind: "response",
      seq: 1,
      ok: true,
      data: { x: 1 },
    });
    expect(result.success).toBe(false);
  });

  test("full bridgeMessageSchema union still accepts auth/request frames unchanged", () => {
    expect(
      bridgeMessageSchema.safeParse({ kind: "auth", token: "t" }).success,
    ).toBe(true);
    expect(
      bridgeMessageSchema.safeParse({
        kind: "request",
        seq: 1,
        tool: "ide_focus",
        params: {},
      }).success,
    ).toBe(true);
  });
});
