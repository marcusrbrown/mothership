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
});
