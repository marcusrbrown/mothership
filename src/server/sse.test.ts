import { describe, expect, test } from "bun:test";
import { connectSse } from "./sse";

/** Builds a fetch stub that returns a streaming `Response` whose body is
 * fed one chunk at a time from `frames`. Each call to fetch produces a
 * fresh stream instance (so reconnects get a new one) and appends its
 * created stream controller to `controllers` for the test to push more
 * chunks into after the initial connect if needed. */
function stubFetch(responses: Array<{ status?: number; frames?: string[] }>) {
  let callIndex = 0;
  const urls: string[] = [];
  const headersSeen: Headers[] = [];

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input));
    headersSeen.push(new Headers(init?.headers));
    const usedIndex = Math.min(callIndex, responses.length - 1);
    // The final configured response's stream stays open indefinitely (never
    // closes on its own) so tests don't spin into infinite reconnects once
    // they've observed what they need; every earlier response closes
    // immediately to simulate the server ending that connection.
    const isFinalResponse = usedIndex === responses.length - 1;
    callIndex++;
    const spec = responses[usedIndex];
    const status = spec?.status ?? 200;
    const frames = spec?.frames ?? [];

    if (status !== 200) {
      return new Response("error", { status });
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(encoder.encode(frame));
        }
        if (!isFinalResponse) controller.close();
      },
    });

    return new Response(stream, { status: 200 });
  }) as typeof fetch;

  return { fetchImpl, urls, headersSeen };
}

function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("connectSse", () => {
  test("connect fires onReconcile once the stream opens", async () => {
    const { fetchImpl } = stubFetch([{ frames: [] }]);
    let reconciled = 0;
    connectSse({
      baseUrl: "http://127.0.0.1:4096",
      directory: "/proj",
      onEvent: () => {},
      onReconcile: () => reconciled++,
      fetchImpl,
    });
    await flush();
    expect(reconciled).toBe(1);
  });

  test("directory is passed as a query param on the /event URL", async () => {
    const { fetchImpl, urls } = stubFetch([{ frames: [] }]);
    connectSse({
      baseUrl: "http://127.0.0.1:4096",
      directory: "/workspace/proj a",
      onEvent: () => {},
      onReconcile: () => {},
      fetchImpl,
    });
    await flush();
    expect(urls[0]).toContain("/event?directory=");
    expect(urls[0]).toContain(encodeURIComponent("/workspace/proj a"));
  });

  test("parse failure skips the frame, stream survives, other frames still delivered", async () => {
    const { fetchImpl } = stubFetch([
      {
        frames: [
          sseFrame("not-an-object-but-valid-json"),
          sseFrame({ type: "server.heartbeat" }),
        ],
      },
    ]);
    const events: unknown[] = [];
    connectSse({
      baseUrl: "http://127.0.0.1:4096",
      directory: "/proj",
      onEvent: (e) => events.push(e),
      onReconcile: () => {},
      fetchImpl,
    });
    await flush();
    // "not-an-object-but-valid-json" parses as a JSON string, which fails
    // sseEventSchema (object required) — skipped; the heartbeat still
    // delivers.
    expect(events).toHaveLength(1);
  });

  test("malformed (non-JSON) frame is skipped without killing the stream", async () => {
    const { fetchImpl } = stubFetch([
      {
        frames: [
          "data: not json{{{\n\n",
          sseFrame({ type: "server.heartbeat" }),
        ],
      },
    ]);
    const events: unknown[] = [];
    connectSse({
      baseUrl: "http://127.0.0.1:4096",
      directory: "/proj",
      onEvent: (e) => events.push(e),
      onReconcile: () => {},
      fetchImpl,
    });
    await flush();
    expect(events).toHaveLength(1);
  });

  test("reconnect after stream end re-fires onReconcile (full reconcile is the safety net, not resume)", async () => {
    const { fetchImpl } = stubFetch([{ frames: [] }, { frames: [] }]);
    let reconciled = 0;
    connectSse({
      baseUrl: "http://127.0.0.1:4096",
      directory: "/proj",
      onEvent: () => {},
      onReconcile: () => reconciled++,
      fetchImpl,
      initialBackoffMs: 50,
      maxBackoffMs: 100,
    });
    await flush();
    expect(reconciled).toBe(1);

    // First stream closed immediately (empty frames + controller.close()),
    // triggering scheduleReconnect -> a second fetch call after backoff.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(reconciled).toBe(2);
  });

  test("close() prevents further reconnect attempts", async () => {
    const { fetchImpl } = stubFetch([{ frames: [] }, { frames: [] }]);
    let fetchCalls = 0;
    const countingFetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      fetchCalls++;
      return fetchImpl(input, init);
    }) as typeof fetch;

    const client = connectSse({
      baseUrl: "http://127.0.0.1:4096",
      directory: "/proj",
      onEvent: () => {},
      onReconcile: () => {},
      fetchImpl: countingFetch,
      initialBackoffMs: 50,
    });
    await flush();
    expect(fetchCalls).toBe(1);

    client.close();
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(fetchCalls).toBe(1);
    expect(client.state).toBe("closed");
  });

  test("Authorization header present when credentials given, absent when not", async () => {
    const withAuth = stubFetch([{ frames: [] }]);
    connectSse({
      baseUrl: "http://127.0.0.1:4096",
      directory: "/proj",
      onEvent: () => {},
      onReconcile: () => {},
      fetchImpl: withAuth.fetchImpl,
      credentials: { username: "opencode", password: "secret" },
    });
    await flush();
    expect(withAuth.headersSeen[0]?.get("Authorization")).toBe(
      `Basic ${btoa("opencode:secret")}`,
    );

    const noAuth = stubFetch([{ frames: [] }]);
    connectSse({
      baseUrl: "http://127.0.0.1:4096",
      directory: "/proj",
      onEvent: () => {},
      onReconcile: () => {},
      fetchImpl: noAuth.fetchImpl,
    });
    await flush();
    expect(noAuth.headersSeen[0]?.get("Authorization")).toBeNull();
  });
});
