import { afterEach, describe, expect, test } from "bun:test";
import {
  answerQuestion,
  dispatch,
  messages,
  questions,
  result,
  roster,
  snapshot,
  status,
  toDispatchArgs,
} from "./bus";
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

  // --- Unit 9: adopt released @fro.bot/space-bus@0.14.0 session API ------

  test("messages() calls /core with our context and returns bounded session messages", async () => {
    stubFetch((url) => {
      if (url.includes("/message")) {
        return new Response(
          JSON.stringify([
            {
              info: { id: "msg_1", role: "user", time: { created: 1 } },
              parts: [{ type: "text", text: "hi" }],
            },
          ]),
          { status: 200 },
        );
      }
      if (url.includes("/session/ses_1")) {
        return new Response(JSON.stringify({ id: "ses_1", directory: "/a" }), {
          status: 200,
        });
      }
      return new Response("not found", { status: 404 });
    });
    const res = await messages("ses_1", { context: CONTEXT, limit: 10 });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.sessionId).toBe("ses_1");
    expect(res.project).toBe("proj-a");
    expect(res.messages[0]).toMatchObject({ id: "msg_1", role: "user" });
  });

  test("questions() calls /core with our context and returns full structured pending-question metadata", async () => {
    stubFetch((url) => {
      if (url.includes("/question")) {
        return new Response(
          JSON.stringify([
            {
              id: "que_1",
              sessionID: "ses_1",
              questions: [
                {
                  header: "Proceed?",
                  question: "Should I proceed?",
                  options: [{ label: "Yes" }, { label: "No" }],
                },
              ],
            },
          ]),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });
    const res = await questions({ project: "proj-a" }, { context: CONTEXT });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.questions[0]).toMatchObject({
      requestId: "que_1",
      sessionId: "ses_1",
    });
    expect(res.questions[0]?.questions[0]?.header).toBe("Proceed?");
  });

  test("answerQuestion() calls /core with our context and answers a pending question by requestId", async () => {
    stubFetch((url, init) => {
      if (url.includes("/question/que_1/reply") && init?.method === "POST") {
        return new Response("true", { status: 200 });
      }
      if (url.includes("/question")) {
        return new Response(
          JSON.stringify([
            { id: "que_1", sessionID: "ses_1", questions: [{ question: "?" }] },
          ]),
          { status: 200 },
        );
      }
      if (url.includes("/session/ses_1")) {
        return new Response(JSON.stringify({ id: "ses_1", directory: "/a" }), {
          status: 200,
        });
      }
      return new Response("not found", { status: 404 });
    });
    const res = await answerQuestion(
      { sessionId: "ses_1", requestId: "que_1", answers: [["Yes"]] },
      { context: CONTEXT },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.sessionId).toBe("ses_1");
    expect(res.requestId).toBe("que_1");
  });

  test("dispatch() honors onPendingQuestion: 'blocked' via the facade, returning a blocked result with no mutation", async () => {
    stubFetch((url) => {
      if (url.includes("/question")) {
        return new Response(
          JSON.stringify([
            { id: "que_1", sessionID: "ses_1", questions: [{ question: "?" }] },
          ]),
          { status: 200 },
        );
      }
      if (url.includes("/session/ses_1")) {
        return new Response(JSON.stringify({ id: "ses_1", directory: "/a" }), {
          status: 200,
        });
      }
      throw new Error(`unexpected mutating call: ${url}`);
    });
    const res = await dispatch(
      { sessionId: "ses_1", prompt: "steer", onPendingQuestion: "blocked" },
      { context: CONTEXT },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.mode).toBe("blocked");
    if (res.mode === "blocked") {
      expect(res.requestId).toBe("que_1");
    }
  });

  test("toDispatchArgs() is re-exported from the facade and validates onPendingQuestion", () => {
    const ok = toDispatchArgs({
      prompt: "hi",
      sessionId: "ses_1",
      onPendingQuestion: "blocked",
    });
    expect(ok.ok).toBe(true);

    const bad = toDispatchArgs({
      prompt: "hi",
      sessionId: "ses_1",
      onPendingQuestion: "not-a-real-policy" as unknown as "blocked",
    });
    expect(bad.ok).toBe(false);
  });

  test("installed @fro.bot/space-bus package is pinned to exactly 0.14.0", async () => {
    // package.json isn't in the package's `exports` map, so resolve it via
    // the filesystem (through the resolvable `./core` entrypoint) rather
    // than an import assertion, which `tsc`/bundler moduleResolution can't
    // statically verify against an unexported subpath.
    const corePath = Bun.resolveSync(
      "@fro.bot/space-bus/core",
      import.meta.dir,
    );
    const pkgPath = `${corePath.replace(/dist\/core\.js$/, "")}package.json`;
    const pkg = JSON.parse(await Bun.file(pkgPath).text()) as {
      version: string;
    };
    expect(pkg.version).toBe("0.14.0");
  });

  test("all required runtime facade exports are functions", async () => {
    const bus = (await import("./bus")) as Record<string, unknown>;
    for (const name of [
      "roster",
      "status",
      "snapshot",
      "dispatch",
      "toDispatchArgs",
      "result",
      "messages",
      "questions",
      "answerQuestion",
    ]) {
      expect(typeof bus[name]).toBe("function");
    }
  });

  test("existing prompt-bar dispatch continues importing dispatch/DispatchArgs/DispatchResult through the ../server/bus facade, not the package directly", async () => {
    const source = await Bun.file(
      new URL("../promptbar/dispatch.ts", import.meta.url),
    ).text();
    expect(source).toContain('from "../server/bus"');
    expect(source).not.toMatch(/from ["']@fro\.bot\/space-bus/);
  });
});

describe("bus facade browser-safety (Unit 9)", () => {
  // Bundles ../server/bus.ts (this repo's single space-bus audit point) for
  // a browser target and asserts the new 0.14.0 re-exports don't pull in
  // any Node builtin or Node-only space-bus subpath. Mirrors space-bus's
  // own src/browser-safety.test.ts pattern: Bun's browser target silently
  // stubs `node:*` imports instead of failing, so a plugin intercept is
  // required to make a Node import a hard build failure rather than a
  // silent no-op.
  test("Bun.build of src/server/bus.ts succeeds with target browser, Node builtins forbidden", async () => {
    const forbidNodeBuiltins: import("bun").BunPlugin = {
      name: "forbid-node-builtins",
      setup(build) {
        build.onResolve({ filter: /^node:/ }, (args) => {
          throw new Error(
            `browser-safety violation: "${args.path}" imported from ${args.importer}`,
          );
        });
      },
    };

    const result = await Bun.build({
      entrypoints: [new URL("./bus.ts", import.meta.url).pathname],
      target: "browser",
      format: "esm",
      external: ["zod"],
      plugins: [forbidNodeBuiltins],
    });

    if (!result.success) {
      const messages = result.logs
        .map((l) => l.message ?? String(l))
        .join("\n");
      throw new Error(
        `browser build of src/server/bus.ts failed:\n${messages}`,
      );
    }
    expect(result.success).toBe(true);
    expect(result.outputs.length).toBeGreaterThan(0);

    for (const output of result.outputs) {
      const text = await output.text();
      expect(text).not.toContain("node:");
      // Node-only space-bus subpaths (managed-server lifecycle, registry,
      // config) must never be reachable from this bundle graph.
      expect(text).not.toMatch(
        /@fro\.bot\/space-bus\/(managed-server|registry|config)/,
      );
      expect(text).not.toMatch(/\bBuffer\.from\(/);
      expect(text).not.toMatch(/\bprocess\.env\b/);
      expect(text).not.toMatch(/\brequire\(/);
    }
  }, 30_000);
});
