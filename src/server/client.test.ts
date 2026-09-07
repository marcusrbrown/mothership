import { describe, expect, test } from "bun:test";
import { createOpencodeClient } from "./client";

type CapturedRequest = { url: string; init: RequestInit };

function stubFetch(
  responses: (req: CapturedRequest) => Response | Promise<Response>,
) {
  const calls: CapturedRequest[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req: CapturedRequest = { url: String(input), init: init ?? {} };
    calls.push(req);
    return responses(req);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const BASE_URL = "http://127.0.0.1:4096";

describe("createOpencodeClient", () => {
  test("GET requests inject ?directory= query param, not header", async () => {
    const { fetchImpl, calls } = stubFetch(
      () => new Response("{}", { status: 200 }),
    );
    const client = createOpencodeClient({ baseUrl: BASE_URL, fetchImpl });
    await client.getSessionStatus("/workspace/proj-a");
    expect(calls).toHaveLength(1);
    const call = calls[0] as CapturedRequest;
    expect(call.url).toContain("directory=%2Fworkspace%2Fproj-a");
    const headers = call.init.headers as Record<string, string>;
    expect(headers["x-opencode-directory"]).toBeUndefined();
  });

  test("POST requests inject x-opencode-directory header, not query param", async () => {
    const { fetchImpl, calls } = stubFetch(
      () => new Response(null, { status: 200 }),
    );
    const client = createOpencodeClient({ baseUrl: BASE_URL, fetchImpl });
    await client.replyQuestion("/workspace/proj-a", "que_1", [["Yes"]]);
    const call = calls[0] as CapturedRequest;
    expect(call.url).not.toContain("directory=");
    const headers = call.init.headers as Record<string, string>;
    expect(headers["x-opencode-directory"]).toBe("/workspace/proj-a");
    expect(headers["content-type"]).toBe("application/json");
  });

  test("zod boundary rejects malformed status payload with typed error", async () => {
    const { fetchImpl } = stubFetch(
      () =>
        new Response(JSON.stringify({ ses_1: { notType: true } }), {
          status: 200,
        }),
    );
    const client = createOpencodeClient({ baseUrl: BASE_URL, fetchImpl });
    const result = await client.getSessionStatus("/dir");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.message).toContain("unexpected response shape");
  });

  test("valid status payload parses through the zod boundary", async () => {
    const { fetchImpl } = stubFetch(
      () =>
        new Response(
          JSON.stringify({ ses_1: { type: "busy", extra: "field" } }),
          { status: 200 },
        ),
    );
    const client = createOpencodeClient({ baseUrl: BASE_URL, fetchImpl });
    const result = await client.getSessionStatus("/dir");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.ses_1?.type).toBe("busy");
  });

  test("reply payload shape is exactly {answers: [[label]]}", async () => {
    const { fetchImpl, calls } = stubFetch(
      () => new Response("true", { status: 200 }),
    );
    const client = createOpencodeClient({ baseUrl: BASE_URL, fetchImpl });
    await client.replyQuestion("/dir", "que_1", [["Yes"]]);
    const call = calls[0] as CapturedRequest;
    expect(call.url).toContain("/question/que_1/reply");
    expect(JSON.parse(call.init.body as string)).toEqual({
      answers: [["Yes"]],
    });
  });

  test("rejectQuestion posts to /question/:id/reject", async () => {
    const { fetchImpl, calls } = stubFetch(
      () => new Response(null, { status: 200 }),
    );
    const client = createOpencodeClient({ baseUrl: BASE_URL, fetchImpl });
    const result = await client.rejectQuestion("/dir", "que_1");
    expect(result.ok).toBe(true);
    expect((calls[0] as CapturedRequest).url).toContain(
      "/question/que_1/reject",
    );
  });

  test("listQuestions parses pending-question list shape", async () => {
    const payload = [
      {
        id: "que_1",
        sessionID: "ses_1",
        questions: [
          {
            question: "Proceed?",
            options: [{ label: "Yes" }],
          },
        ],
      },
    ];
    const { fetchImpl } = stubFetch(
      () => new Response(JSON.stringify(payload), { status: 200 }),
    );
    const client = createOpencodeClient({ baseUrl: BASE_URL, fetchImpl });
    const result = await client.listQuestions("/dir");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value[0]?.id).toBe("que_1");
  });

  test("auth header sent when credentials provided", async () => {
    const { fetchImpl, calls } = stubFetch(
      () => new Response("{}", { status: 200 }),
    );
    const client = createOpencodeClient({
      baseUrl: BASE_URL,
      fetchImpl,
      credentials: { username: "opencode", password: "secret" },
    });
    await client.getSessionStatus("/dir");
    const headers = (calls[0] as CapturedRequest).init.headers as Record<
      string,
      string
    >;
    expect(headers.Authorization).toStartWith("Basic ");
  });

  test("no auth header when no credentials provided", async () => {
    const { fetchImpl, calls } = stubFetch(
      () => new Response("{}", { status: 200 }),
    );
    const client = createOpencodeClient({ baseUrl: BASE_URL, fetchImpl });
    await client.getSessionStatus("/dir");
    const headers = (calls[0] as CapturedRequest).init.headers as Record<
      string,
      string
    >;
    expect(headers.Authorization).toBeUndefined();
  });

  test("redirect is set to error on every request", async () => {
    const { fetchImpl, calls } = stubFetch(
      () => new Response("{}", { status: 200 }),
    );
    const client = createOpencodeClient({ baseUrl: BASE_URL, fetchImpl });
    await client.getSessionStatus("/dir");
    expect((calls[0] as CapturedRequest).init.redirect).toBe("error");
  });

  test("AbortSignal is attached for the timeout", async () => {
    const { fetchImpl, calls } = stubFetch(
      () => new Response("{}", { status: 200 }),
    );
    const client = createOpencodeClient({
      baseUrl: BASE_URL,
      fetchImpl,
      timeoutMs: 5_000,
    });
    await client.getSessionStatus("/dir");
    expect((calls[0] as CapturedRequest).init.signal).toBeInstanceOf(
      AbortSignal,
    );
  });

  test("network failure surfaces as a typed error, not a throw", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const client = createOpencodeClient({ baseUrl: BASE_URL, fetchImpl });
    const result = await client.getSessionStatus("/dir");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.message).toContain("request failed");
  });

  test("listMessages passes limit as query param and parses items", async () => {
    const payload = [
      {
        info: { role: "assistant" },
        parts: [{ type: "text", text: "hi" }],
      },
    ];
    const { fetchImpl, calls } = stubFetch(
      () => new Response(JSON.stringify(payload), { status: 200 }),
    );
    const client = createOpencodeClient({ baseUrl: BASE_URL, fetchImpl });
    const result = await client.listMessages("/dir", "ses_1", { limit: 50 });
    expect((calls[0] as CapturedRequest).url).toContain("limit=50");
    expect(result.ok).toBe(true);
  });

  // --- characterization fixtures ------------------------------------------
  // Verified live 2026-07-18 against v1.17.13+harness.ee55e157 and
  // v1.17.18+harness.4ec05a47 (`GET /doc`, `?limit=N` message reads,
  // `GET/POST /question` round trip). See
  // docs/solutions/documentation-gaps/opencode-server-sse-contract-facts-2026-07-04.md
  // and spikes/0c-server-connectivity/probe.ts Phase 5/6 for the full
  // evidence trail; do not hand-edit these fixtures without re-verifying
  // against a live server.

  test("listMessages(limit=N) fixture: returned order is chronological ascending (oldest-first), matching the tail of the unlimited list, not the head", async () => {
    // Captured shape from GET /session/:id/message?limit=3 against a
    // 100-message live session: three ascending-`time.created` messages
    // that are the newest three overall, still in oldest-first order among
    // themselves. `limit` truncates from the newest end; it does not
    // reverse ordering.
    const limitedFixture = [
      {
        info: {
          id: "msg_f52f2971a001IrokWVfIN8X6dV",
          role: "assistant",
          time: { created: 1783803057946 },
        },
        parts: [{ type: "text", text: "..." }],
      },
      {
        info: {
          id: "msg_f52f2ca23001ok2HWyBxJWXd46",
          role: "assistant",
          time: { created: 1783803071011 },
        },
        parts: [{ type: "text", text: "..." }],
      },
      {
        info: {
          id: "msg_f5313f7dd001Ud2mtZ6px5XFI7",
          role: "assistant",
          time: { created: 1783805245405 },
        },
        parts: [{ type: "text", text: "..." }],
      },
    ];
    const { fetchImpl } = stubFetch(
      () => new Response(JSON.stringify(limitedFixture), { status: 200 }),
    );
    const client = createOpencodeClient({ baseUrl: BASE_URL, fetchImpl });
    const result = await client.listMessages("/dir", "ses_1", { limit: 3 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const ids = result.value.map((m) => m.info.id);
    expect(ids).toEqual([
      "msg_f52f2971a001IrokWVfIN8X6dV",
      "msg_f52f2ca23001ok2HWyBxJWXd46",
      "msg_f5313f7dd001Ud2mtZ6px5XFI7",
    ]);
    const created = result.value.map(
      (m) => (m.info as { time?: { created?: number } }).time?.created,
    );
    for (let i = 1; i < created.length; i++) {
      expect((created[i] as number) >= (created[i - 1] as number)).toBe(true);
    }
  });

  test("listMessages does not accept a `before`/cursor param — the deployed v1 route documents `before` in GET /doc but rejects every value with 400 BadRequest (verified live 2026-07-18); the client boundary intentionally has no such option", async () => {
    // Compile-time characterization: `listMessages`'s params type only
    // exposes `{ limit?: number }`. If a future edit adds an unverified
    // `before`/cursor param to this client without re-verifying the live
    // route, this call becomes a type error and this test's intent
    // documentation goes stale loudly rather than silently.
    const { fetchImpl, calls } = stubFetch(
      () => new Response("[]", { status: 200 }),
    );
    const client = createOpencodeClient({ baseUrl: BASE_URL, fetchImpl });
    const params: { limit?: number } = { limit: 2 };
    await client.listMessages("/dir", "ses_1", params);
    const url = (calls[0] as CapturedRequest).url;
    expect(url).toContain("limit=2");
    expect(url).not.toContain("before=");
  });

  test("listQuestions fixture: full pending-question shape (header/question/options) round-trips through the zod boundary, keyed by the que_ requestID — not an SSE envelope id", async () => {
    // Captured shape from GET /question?directory=... against a live
    // question.asked event's `properties`. The reply path param is this
    // `id` (`que_...`), never the SSE envelope's own `id` (`evt_...`) — see
    // docs/solutions/documentation-gaps/opencode-server-sse-contract-facts-2026-07-04.md.
    const questionFixture = [
      {
        id: "que_f2ca755e20012SELXYb5mGclIc",
        sessionID: "ses_0d358c5f7ffesGixsdNsji7Fun",
        questions: [
          {
            question: "Should I proceed?",
            header: "Proceed?",
            options: [
              { label: "Yes", description: "Proceed" },
              { label: "No", description: "Do not proceed" },
            ],
          },
        ],
        tool: {
          messageID: "msg_f2ca73bf90011INau2Pz4UHiK4",
          callID: "toolu_01XZ5DBoV4fG7jeN5DBJWnmM",
        },
      },
    ];
    const { fetchImpl } = stubFetch(
      () => new Response(JSON.stringify(questionFixture), { status: 200 }),
    );
    const client = createOpencodeClient({ baseUrl: BASE_URL, fetchImpl });
    const result = await client.listQuestions("/dir");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const entry = result.value[0];
    expect(entry?.id).toBe("que_f2ca755e20012SELXYb5mGclIc");
    expect(entry?.id.startsWith("que_")).toBe(true);
    expect(entry?.id.startsWith("evt_")).toBe(false);
    expect(entry?.sessionID).toBe("ses_0d358c5f7ffesGixsdNsji7Fun");
  });

  test("replyQuestion is keyed by the requestID path param, never an SSE envelope id — an evt_ id passed here is sent verbatim and would 400/404 against the live route rather than matching any question", async () => {
    const { fetchImpl, calls } = stubFetch(
      () => new Response("true", { status: 200 }),
    );
    const client = createOpencodeClient({ baseUrl: BASE_URL, fetchImpl });
    // The client itself does not validate the `que_` prefix (that
    // enforcement lives server-side per GET /doc's `^que` path pattern);
    // this pins that the client passes whatever requestID it is given
    // through unchanged, so an SSE envelope id substituted by a caller
    // reaches the server as-is and is not silently corrected.
    await client.replyQuestion("/dir", "evt_wrongIdKind", [["Yes"]]);
    const call = calls[0] as CapturedRequest;
    expect(call.url).toContain("/question/evt_wrongIdKind/reply");
  });
});
