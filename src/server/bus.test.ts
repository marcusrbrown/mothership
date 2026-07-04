import { afterEach, describe, expect, test } from "bun:test";
import { dispatch, result, roster, snapshot, status } from "./bus";
import type { BusContext } from "./types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init)) as typeof fetch;
}

const CONTEXT: BusContext = {
  roster: {
    server: { baseUrl: "http://127.0.0.1:4096" },
    projects: [
      {
        name: "proj-a",
        path: "/a",
        description: "d",
        expandedPath: "/a",
        exists: true,
      },
    ],
  },
};

describe("bus facade (space-bus /core smoke)", () => {
  test("roster() calls /core with our context and produces an Ok result", async () => {
    stubFetch((url) => {
      if (url.includes("/session/status")) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      if (url.includes("/session")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    const res = await roster({ context: CONTEXT });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.projects[0]).toMatchObject({ name: "proj-a", pathExists: true });
  });

  test("status() calls /core with our context and produces an Ok result", async () => {
    stubFetch((url) => {
      if (url.includes("/session/ses_1/todo")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes("/session/ses_1")) {
        return new Response(
          JSON.stringify({ id: "ses_1", directory: "/a", title: "t" }),
          { status: 200 },
        );
      }
      if (url.includes("/session/status")) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      if (url.includes("/question")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes("/diff")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    const res = await status("ses_1", { context: CONTEXT });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.sessionId).toBe("ses_1");
    expect(res.project).toBe("proj-a");
  });

  test("result() calls /core with our context and produces an Ok result", async () => {
    stubFetch((url) => {
      if (url.includes("/message")) {
        return new Response(
          JSON.stringify([
            {
              info: { role: "assistant" },
              parts: [{ type: "text", text: "done" }],
            },
          ]),
          { status: 200 },
        );
      }
      if (url.includes("/session/status")) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      if (url.includes("/diff")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes("/session/ses_1")) {
        return new Response(JSON.stringify({ id: "ses_1", directory: "/a" }), {
          status: 200,
        });
      }
      return new Response("not found", { status: 404 });
    });
    const res = await result("ses_1", { context: CONTEXT });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.text).toBe("done");
  });

  test("dispatch() calls /core with our context and produces an Ok result", async () => {
    stubFetch((url, init) => {
      if (url.includes("/prompt_async")) {
        return new Response(null, { status: 204 });
      }
      if (url.endsWith("/session") && init?.method === "POST") {
        return new Response(JSON.stringify({ id: "ses_new" }), {
          status: 200,
        });
      }
      return new Response("not found", { status: 404 });
    });
    const res = await dispatch(
      { prompt: "hi", project: "proj-a" },
      { context: CONTEXT },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.sessionId).toBe("ses_new");
    expect(res.project).toBe("proj-a");
  });

  test("snapshot() calls /core with our context and produces an Ok result", async () => {
    stubFetch((url) => {
      if (url.includes("/session/status")) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      if (url.includes("/question")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes("/session")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    const res = await snapshot({ context: CONTEXT });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.projects[0]).toMatchObject({ name: "proj-a", exists: true });
  });
});
