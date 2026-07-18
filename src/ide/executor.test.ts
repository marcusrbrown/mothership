import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  projectOrSessionTargetSchema,
  projectTargetSchema,
  sessionResultSchema,
  sessionTargetSchema,
} from "./commands";
import {
  type SessionToolDeps,
  __resetSessionToolsForTests,
  isRegisteredSessionTool,
  registerSessionTool,
  resolveProject,
  resolveSession,
  runSessionTool,
} from "./executor";

function makeDeps(overrides: Partial<SessionToolDeps> = {}): SessionToolDeps {
  return {
    context: {
      roster: {
        server: { baseUrl: "http://127.0.0.1:4096" },
        projects: [
          {
            name: "dashboard",
            expandedPath: "/Users/marcus/src/fro-bot/dashboard",
          },
        ],
      },
    },
    store: {
      getSessions: () => [],
      getSession: (id: string) =>
        id === "ses_live"
          ? {
              id: "ses_live",
              directory: "/Users/marcus/src/fro-bot/dashboard",
              title: "Fix the thing",
              status: "idle" as const,
            }
          : id === "ses_orphan"
            ? { id: "ses_orphan", status: "idle" as const }
            : undefined,
      getPendingQuestions: () => [],
      subscribe: () => () => {},
      applyEvent: () => {},
      reconcile: () => {},
    },
    bus: {},
    focus: {},
    ...overrides,
  };
}

/** deps fixture that counts every bus/focus method invocation — used to
 * prove a handler that would call a bus/focus operation is never invoked
 * at all when target resolution fails. */
function makeCountingDeps(): {
  deps: SessionToolDeps;
  counters: { bus: number; focus: number };
} {
  const counters = { bus: 0, focus: 0 };
  const deps = makeDeps({
    bus: {
      dispatch: () => {
        counters.bus++;
      },
    },
    focus: {
      selectSession: () => {
        counters.focus++;
      },
    },
  });
  return { deps, counters };
}

describe("resolveProject", () => {
  test("happy path: resolves a known roster project", () => {
    const result = resolveProject(makeDeps(), "dashboard");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.name).toBe("dashboard");
  });

  test("error path: unknown project fails before any I/O", () => {
    const result = resolveProject(makeDeps(), "does-not-exist");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("unknown_project");
  });

  test("security: an unknown-project error never echoes the raw caller-supplied project string, even a malicious/oversized one", () => {
    const maliciousInputs = [
      "password=hunter2",
      "Bearer abc123xyz",
      "x".repeat(500),
    ];
    for (const input of maliciousInputs) {
      const result = resolveProject(makeDeps(), input);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected error");
      expect(result.error.message).not.toContain(input);
    }
  });

  test("error path: duplicate project-name matches fail closed as ambiguous_project", () => {
    const deps = makeDeps({
      context: {
        roster: {
          server: { baseUrl: "http://127.0.0.1:4096" },
          projects: [
            { name: "dashboard", expandedPath: "/a" },
            { name: "dashboard", expandedPath: "/b" },
          ],
        },
      },
    });
    const result = resolveProject(deps, "dashboard");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("ambiguous_project");
  });
});

describe("resolveSession", () => {
  test("happy path: resolves a live session owned by a roster project", () => {
    const result = resolveSession(makeDeps(), "ses_live");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.id).toBe("ses_live");
    expect(result.data.project).toBe("dashboard");
  });

  test("error path: unknown/deleted session fails before any I/O", () => {
    const result = resolveSession(makeDeps(), "ses_gone");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("unknown_session");
  });

  test("error path: a session whose directory doesn't match any roster project fails as unknown_session, not a silent pass-through", () => {
    const result = resolveSession(makeDeps(), "ses_orphan");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("unknown_session");
  });

  test("error path: mismatched session/project (explicit expectedProject) fails closed", () => {
    const result = resolveSession(makeDeps(), "ses_live", "other-project");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("session_project_mismatch");
  });
});

describe("session-tool registry + runSessionTool: structural target resolution", () => {
  test("happy path: target:'project' resolves and passes the resolved project to the handler, not just raw args", async () => {
    __resetSessionToolsForTests();
    registerSessionTool("ide_test_project_tool", {
      argsSchema: projectTargetSchema,
      resultSchema: sessionResultSchema({ name: z.string() }),
      target: "project",
      handler: async (_args, target) => {
        if (target.kind !== "project") throw new Error("wrong target kind");
        return { ok: true, data: { name: target.project.name } };
      },
    });

    const result = await runSessionTool(
      "ide_test_project_tool",
      { project: "dashboard" },
      makeDeps(),
      "mcp_tool",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data).toEqual({ name: "dashboard" });
  });

  test("happy path: target:'session' resolves and passes the resolved session to the handler", async () => {
    __resetSessionToolsForTests();
    registerSessionTool("ide_test_session_tool", {
      argsSchema: sessionTargetSchema,
      resultSchema: sessionResultSchema({ id: z.string() }),
      target: "session",
      handler: async (_args, target) => {
        if (target.kind !== "session") throw new Error("wrong target kind");
        return { ok: true, data: { id: target.session.id } };
      },
    });

    const result = await runSessionTool(
      "ide_test_session_tool",
      { sessionId: "ses_live" },
      makeDeps(),
      "ui",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data).toEqual({ id: "ses_live" });
  });

  test("happy path: target:'project_or_session' resolves whichever branch the args name", async () => {
    __resetSessionToolsForTests();
    type EitherResult = { kind: string; name?: string; id?: string };
    registerSessionTool<{ project?: string; sessionId?: string }, EitherResult>(
      "ide_test_either_tool",
      {
        argsSchema: projectOrSessionTargetSchema,
        resultSchema: sessionResultSchema({
          kind: z.string(),
          name: z.string().optional(),
          id: z.string().optional(),
        }),
        target: "project_or_session",
        handler: async (_args, target) => {
          if (target.kind === "project") {
            return {
              ok: true,
              data: { kind: "project", name: target.project.name },
            };
          }
          if (target.kind === "session") {
            return {
              ok: true,
              data: { kind: "session", id: target.session.id },
            };
          }
          throw new Error("wrong target kind");
        },
      },
    );

    const bySession = await runSessionTool(
      "ide_test_either_tool",
      { sessionId: "ses_live" },
      makeDeps(),
      "mcp_tool",
    );
    expect(bySession.ok).toBe(true);
    if (!bySession.ok) throw new Error("expected ok");
    expect(bySession.data).toEqual({ kind: "session", id: "ses_live" });

    const byProject = await runSessionTool(
      "ide_test_either_tool",
      { project: "dashboard" },
      makeDeps(),
      "mcp_tool",
    );
    expect(byProject.ok).toBe(true);
    if (!byProject.ok) throw new Error("expected ok");
    expect(byProject.data).toEqual({ kind: "project", name: "dashboard" });
  });

  test("happy path: target:'project_or_session' resolves a real org/repo-shaped project name containing a slash", async () => {
    __resetSessionToolsForTests();
    const deps = makeDeps({
      context: {
        roster: {
          server: { baseUrl: "http://127.0.0.1:4096" },
          projects: [{ name: "fro-bot/dashboard", expandedPath: "/a" }],
        },
      },
    });
    type EitherResult = { kind: string; name?: string; id?: string };
    registerSessionTool<{ project?: string; sessionId?: string }, EitherResult>(
      "ide_test_either_slash_project",
      {
        argsSchema: projectOrSessionTargetSchema,
        resultSchema: sessionResultSchema({
          kind: z.string(),
          name: z.string().optional(),
          id: z.string().optional(),
        }),
        target: "project_or_session",
        handler: async (_args, target) => {
          if (target.kind === "project") {
            return {
              ok: true,
              data: { kind: "project", name: target.project.name },
            };
          }
          throw new Error("wrong target kind");
        },
      },
    );

    const result = await runSessionTool(
      "ide_test_either_slash_project",
      { project: "fro-bot/dashboard" },
      deps,
      "mcp_tool",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data).toEqual({
      kind: "project",
      name: "fro-bot/dashboard",
    });
  });

  test("happy path: target:'none' passes {kind:'none'} without attempting resolution", async () => {
    __resetSessionToolsForTests();
    registerSessionTool("ide_test_none_tool", {
      argsSchema: z.object({}),
      resultSchema: sessionResultSchema({ pinged: z.boolean() }),
      target: "none",
      handler: async (_args, target) => {
        if (target.kind !== "none") throw new Error("wrong target kind");
        return { ok: true, data: { pinged: true } };
      },
    });

    const result = await runSessionTool(
      "ide_test_none_tool",
      {},
      makeDeps(),
      "mcp_tool",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data).toEqual({ pinged: true });
  });

  test("misuse: target:'none' rejects parsed args carrying a 'project' field before the handler runs, even if the tool's own argsSchema (buggily) permits it", async () => {
    __resetSessionToolsForTests();
    let handlerCalled = false;
    // A buggy/malicious registration: declares target:'none' (implying
    // list-projects/get-active-context-style no-target semantics) but its
    // argsSchema still accepts a 'project' field — the runtime guard must
    // catch this regardless of what the schema itself permits.
    registerSessionTool("ide_test_none_with_project_field", {
      argsSchema: z.object({ project: z.string().optional() }),
      resultSchema: sessionResultSchema({}),
      target: "none",
      handler: async () => {
        handlerCalled = true;
        return { ok: true, data: {} };
      },
    });

    const result = await runSessionTool(
      "ide_test_none_with_project_field",
      { project: "dashboard" },
      makeDeps(),
      "mcp_tool",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("invalid_arguments");
    expect(result.error.delivery).toBe("not_sent");
    expect(handlerCalled).toBe(false);
  });

  test("misuse: target:'none' rejects parsed args carrying a 'sessionId' field before the handler runs", async () => {
    __resetSessionToolsForTests();
    let handlerCalled = false;
    registerSessionTool("ide_test_none_with_session_field", {
      argsSchema: z.object({ sessionId: z.string().optional() }),
      resultSchema: sessionResultSchema({}),
      target: "none",
      handler: async () => {
        handlerCalled = true;
        return { ok: true, data: {} };
      },
    });

    const result = await runSessionTool(
      "ide_test_none_with_session_field",
      { sessionId: "ses_live" },
      makeDeps(),
      "mcp_tool",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("invalid_arguments");
    expect(handlerCalled).toBe(false);
  });

  test("misuse: target:'none' rejects an explicit undefined project/sessionId field too — the mere presence of the key is disallowed, not just a truthy value", async () => {
    __resetSessionToolsForTests();
    registerSessionTool("ide_test_none_explicit_undefined", {
      argsSchema: z.object({ project: z.string().optional() }),
      resultSchema: sessionResultSchema({}),
      target: "none",
      handler: async () => ({ ok: true, data: {} }),
    });

    const result = await runSessionTool(
      "ide_test_none_explicit_undefined",
      { project: undefined },
      makeDeps(),
      "mcp_tool",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("invalid_arguments");
  });

  test("happy path: target:'none' with a schema that has no target-bearing fields at all (the real shape for ide_list_projects/ide_get_active_context) still works", async () => {
    __resetSessionToolsForTests();
    registerSessionTool("ide_test_none_clean_schema", {
      argsSchema: z.object({}),
      resultSchema: sessionResultSchema({ ok: z.boolean() }),
      target: "none",
      handler: async () => ({ ok: true, data: { ok: true } }),
    });

    const result = await runSessionTool(
      "ide_test_none_clean_schema",
      {},
      makeDeps(),
      "mcp_tool",
    );
    expect(result.ok).toBe(true);
  });

  // --- the REAL no-arg tool shape is a plain, non-strict
  // `z.object({})` — zod's default (non-strict) object parsing silently
  // STRIPS unknown keys during safeParse, so a raw `{project:"escape"}`
  // payload against `z.object({})` parses successfully to `{}`. Any guard
  // that only inspects the PARSED result (post-zod) can never see the
  // caller's original `project`/`sessionId` key — it's already gone. The
  // guard must inspect the RAW args object, before parsing.
  describe("P2: target:'none' raw-args guard against zod's silent unknown-key stripping", () => {
    test("misuse: raw {project:...} against the real z.object({}) shape is rejected before parsing can strip it away", async () => {
      __resetSessionToolsForTests();
      let handlerCalled = false;
      registerSessionTool("ide_test_none_real_shape_project", {
        argsSchema: z.object({}),
        resultSchema: sessionResultSchema({}),
        target: "none",
        handler: async () => {
          handlerCalled = true;
          return { ok: true, data: {} };
        },
      });

      const result = await runSessionTool(
        "ide_test_none_real_shape_project",
        { project: "escape-attempt" },
        makeDeps(),
        "mcp_tool",
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected error");
      expect(result.error.code).toBe("invalid_arguments");
      expect(result.error.delivery).toBe("not_sent");
      expect(handlerCalled).toBe(false);
    });

    test("misuse: raw {sessionId:...} against the real z.object({}) shape is rejected before parsing can strip it away", async () => {
      __resetSessionToolsForTests();
      let handlerCalled = false;
      registerSessionTool("ide_test_none_real_shape_session", {
        argsSchema: z.object({}),
        resultSchema: sessionResultSchema({}),
        target: "none",
        handler: async () => {
          handlerCalled = true;
          return { ok: true, data: {} };
        },
      });

      const result = await runSessionTool(
        "ide_test_none_real_shape_session",
        { sessionId: "ses_live" },
        makeDeps(),
        "mcp_tool",
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected error");
      expect(result.error.code).toBe("invalid_arguments");
      expect(handlerCalled).toBe(false);
    });

    test("misuse: a raw key explicitly set to undefined is still rejected — key PRESENCE is the signal, not a truthy value", async () => {
      __resetSessionToolsForTests();
      registerSessionTool("ide_test_none_real_shape_undefined", {
        argsSchema: z.object({}),
        resultSchema: sessionResultSchema({}),
        target: "none",
        handler: async () => ({ ok: true, data: {} }),
      });

      const result = await runSessionTool(
        "ide_test_none_real_shape_undefined",
        { project: undefined },
        makeDeps(),
        "mcp_tool",
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected error");
      expect(result.error.code).toBe("invalid_arguments");
    });

    test("misuse: an INHERITED (prototype-chain) project key is not treated as present — the guard is own-property-only, consistent with the audit-store's own-property policy", async () => {
      __resetSessionToolsForTests();
      let handlerCalled = false;
      registerSessionTool("ide_test_none_inherited_key", {
        argsSchema: z.object({}),
        resultSchema: sessionResultSchema({ pinged: z.boolean() }),
        target: "none",
        handler: async () => {
          handlerCalled = true;
          return { ok: true, data: { pinged: true } };
        },
      });

      const proto = { project: "inherited-should-not-count" };
      const rawArgs = Object.create(proto);

      const result = await runSessionTool(
        "ide_test_none_inherited_key",
        rawArgs,
        makeDeps(),
        "mcp_tool",
      );
      expect(result.ok).toBe(true);
      expect(handlerCalled).toBe(true);
    });

    test("happy path: raw {} (clean, no target-bearing keys at all) against the real z.object({}) shape succeeds", async () => {
      __resetSessionToolsForTests();
      registerSessionTool("ide_test_none_real_shape_clean", {
        argsSchema: z.object({}),
        resultSchema: sessionResultSchema({ ok: z.boolean() }),
        target: "none",
        handler: async () => ({ ok: true, data: { ok: true } }),
      });

      const result = await runSessionTool(
        "ide_test_none_real_shape_clean",
        {},
        makeDeps(),
        "mcp_tool",
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.data).toEqual({ ok: true });
    });

    test("safety: non-object/null/array raw args never crash the guard — normal schema parsing still handles the malformed shape", async () => {
      __resetSessionToolsForTests();
      registerSessionTool("ide_test_none_malformed_raw", {
        argsSchema: z.object({}),
        resultSchema: sessionResultSchema({}),
        target: "none",
        handler: async () => ({ ok: true, data: {} }),
      });

      for (const malformed of [
        "not-an-object",
        42,
        null,
        undefined,
        ["a", "b"],
        true,
      ]) {
        const result = await runSessionTool(
          "ide_test_none_malformed_raw",
          malformed,
          makeDeps(),
          "mcp_tool",
        );
        // Every one of these fails zod's z.object({}) parse (not an
        // object, or an array where an object was expected) — normal
        // schema validation handles it; the raw-args guard must not
        // throw trying to inspect a non-object/null/array value.
        expect(result.ok).toBe(false);
      }
    });

    test("security: an unknown/rejected target-bearing-field error never echoes the raw caller-supplied value", async () => {
      __resetSessionToolsForTests();
      registerSessionTool("ide_test_none_no_echo", {
        argsSchema: z.object({}),
        resultSchema: sessionResultSchema({}),
        target: "none",
        handler: async () => ({ ok: true, data: {} }),
      });

      const maliciousValue = "password=hunter2; Bearer abc123xyz";
      const result = await runSessionTool(
        "ide_test_none_no_echo",
        { project: maliciousValue },
        makeDeps(),
        "mcp_tool",
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected error");
      expect(result.error.message).not.toContain(maliciousValue);
    });
  });

  test("error path: unknown tool name fails before any handler runs", async () => {
    __resetSessionToolsForTests();
    const result = await runSessionTool(
      "does_not_exist",
      {},
      makeDeps(),
      "mcp_tool",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("unknown_tool");
    expect(result.error.delivery).toBe("not_sent");
  });

  test("security: an unknown-tool error never echoes the raw caller-supplied tool-name string", async () => {
    __resetSessionToolsForTests();
    const maliciousName = "password=hunter2; DROP TABLE sessions";
    const result = await runSessionTool(
      maliciousName,
      {},
      makeDeps(),
      "mcp_tool",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("unknown_tool");
    expect(result.error.message).not.toContain(maliciousName);
  });

  test("error path: malformed args return a typed invalid_arguments result before the handler runs", async () => {
    __resetSessionToolsForTests();
    let handlerCalled = false;
    registerSessionTool("ide_test_strict", {
      argsSchema: projectTargetSchema,
      resultSchema: sessionResultSchema({}),
      target: "project",
      handler: async () => {
        handlerCalled = true;
        return { ok: true, data: {} };
      },
    });

    const result = await runSessionTool(
      "ide_test_strict",
      { project: 123 },
      makeDeps(),
      "mcp_tool",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("invalid_arguments");
    expect(result.error.delivery).toBe("not_sent");
    expect(handlerCalled).toBe(false);
  });

  test("error path: directory-shaped target string fails before any injected operation runs", async () => {
    __resetSessionToolsForTests();
    let handlerCalled = false;
    registerSessionTool("ide_test_no_paths", {
      argsSchema: projectTargetSchema,
      resultSchema: sessionResultSchema({}),
      target: "project",
      handler: async () => {
        handlerCalled = true;
        return { ok: true, data: {} };
      },
    });

    const result = await runSessionTool(
      "ide_test_no_paths",
      { project: "/Users/marcus/src/fro-bot/dashboard" },
      makeDeps(),
      "mcp_tool",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("invalid_target");
    expect(result.error.delivery).toBe("not_sent");
    expect(handlerCalled).toBe(false);
  });

  test("error path: an unknown project target fails closed and the handler never runs — no bus/focus call happens", async () => {
    __resetSessionToolsForTests();
    const { deps, counters } = makeCountingDeps();
    let handlerCalled = false;
    registerSessionTool("ide_test_malicious_unknown_project", {
      argsSchema: projectTargetSchema,
      resultSchema: sessionResultSchema({}),
      target: "project",
      handler: async (_args, _target, injectedDeps) => {
        handlerCalled = true;
        (injectedDeps.bus.dispatch as () => void)();
        (injectedDeps.focus.selectSession as () => void)();
        return { ok: true, data: {} };
      },
    });

    const result = await runSessionTool(
      "ide_test_malicious_unknown_project",
      { project: "does-not-exist" },
      deps,
      "mcp_tool",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("unknown_project");
    expect(result.error.delivery).toBe("not_sent");
    expect(handlerCalled).toBe(false);
    expect(counters.bus).toBe(0);
    expect(counters.focus).toBe(0);
  });

  test("error path: an unknown/deleted session target fails closed and the handler never runs — no bus/focus call happens", async () => {
    __resetSessionToolsForTests();
    const { deps, counters } = makeCountingDeps();
    let handlerCalled = false;
    registerSessionTool("ide_test_malicious_unknown_session", {
      argsSchema: sessionTargetSchema,
      resultSchema: sessionResultSchema({}),
      target: "session",
      handler: async (_args, _target, injectedDeps) => {
        handlerCalled = true;
        (injectedDeps.bus.dispatch as () => void)();
        (injectedDeps.focus.selectSession as () => void)();
        return { ok: true, data: {} };
      },
    });

    const result = await runSessionTool(
      "ide_test_malicious_unknown_session",
      { sessionId: "ses_gone" },
      deps,
      "mcp_tool",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("unknown_session");
    expect(handlerCalled).toBe(false);
    expect(counters.bus).toBe(0);
    expect(counters.focus).toBe(0);
  });

  test("error path: an ambiguous project target fails closed and the handler never runs", async () => {
    __resetSessionToolsForTests();
    const { counters } = makeCountingDeps();
    const deps = makeDeps({
      context: {
        roster: {
          server: { baseUrl: "http://127.0.0.1:4096" },
          projects: [
            { name: "dup", expandedPath: "/a" },
            { name: "dup", expandedPath: "/b" },
          ],
        },
      },
      bus: {
        dispatch: () => {
          counters.bus++;
        },
      },
      focus: {
        selectSession: () => {
          counters.focus++;
        },
      },
    });
    let handlerCalled = false;
    registerSessionTool("ide_test_malicious_ambiguous", {
      argsSchema: projectTargetSchema,
      resultSchema: sessionResultSchema({}),
      target: "project",
      handler: async () => {
        handlerCalled = true;
        return { ok: true, data: {} };
      },
    });

    const result = await runSessionTool(
      "ide_test_malicious_ambiguous",
      { project: "dup" },
      deps,
      "mcp_tool",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("ambiguous_project");
    expect(handlerCalled).toBe(false);
    expect(counters.bus).toBe(0);
    expect(counters.focus).toBe(0);
  });

  test("security: a handler throwing an exception never leaks raw exception text — it is mapped to a generic stable internal_error with no input-derived message", async () => {
    __resetSessionToolsForTests();
    registerSessionTool("ide_test_throws", {
      argsSchema: z.object({}),
      resultSchema: sessionResultSchema({}),
      target: "none",
      handler: async () => {
        throw new Error(
          "ENOENT /Users/marcus/.ssh/id_rsa Authorization: Basic c2VjcmV0",
        );
      },
    });

    const result = await runSessionTool(
      "ide_test_throws",
      {},
      makeDeps(),
      "mcp_tool",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("internal_error");
    expect(result.error.message).not.toContain("/Users/marcus");
    expect(result.error.message).not.toContain("Basic c2VjcmV0");
    expect(result.error.message).not.toContain("ENOENT");
    // The handler ran (and could have performed I/O before throwing) —
    // the executor cannot prove nothing was sent, so delivery must be
    // "indeterminate", not "not_sent".
    expect(result.error.delivery).toBe("indeterminate");
  });

  test("security: a handler that calls bus.dispatch (simulating a non-idempotent mutation already sent) and THEN throws maps to internal_error with delivery:'indeterminate' — never not_sent, since the mutation may have already reached the server", async () => {
    __resetSessionToolsForTests();
    const dispatchCalls: number[] = [];
    const deps = makeDeps({
      bus: {
        dispatch: () => {
          dispatchCalls.push(Date.now());
        },
      },
    });
    registerSessionTool("ide_test_dispatch_then_throws", {
      argsSchema: z.object({}),
      resultSchema: sessionResultSchema({}),
      target: "none",
      handler: async (_args, _target, injectedDeps) => {
        (injectedDeps.bus.dispatch as () => void)();
        throw new Error(
          "upstream 500 after dispatch: /Users/marcus/secret leaked in a forged trace",
        );
      },
    });

    const result = await runSessionTool(
      "ide_test_dispatch_then_throws",
      {},
      deps,
      "mcp_tool",
    );
    expect(dispatchCalls).toHaveLength(1);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("internal_error");
    expect(result.error.delivery).toBe("indeterminate");
    expect(result.error.message).not.toContain("/Users/marcus");
    expect(result.error.message).not.toContain("forged trace");
  });

  test("regression: a handler that explicitly RETURNS a not_sent error before doing any I/O is honored as not_sent, not overridden to indeterminate", async () => {
    __resetSessionToolsForTests();
    registerSessionTool("ide_test_explicit_not_sent", {
      argsSchema: z.object({}),
      resultSchema: sessionResultSchema({}),
      target: "none",
      handler: async () => ({
        ok: false,
        error: {
          code: "upstream_error" as const,
          message: "known-safe reason, no I/O attempted",
          delivery: "not_sent" as const,
        },
      }),
    });

    const result = await runSessionTool(
      "ide_test_explicit_not_sent",
      {},
      makeDeps(),
      "mcp_tool",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.delivery).toBe("not_sent");
  });

  test("security: a handler throwing an arbitrary {code,message}-shaped object is NOT trusted as a SessionToolError — it is still mapped to the generic internal_error", async () => {
    __resetSessionToolsForTests();
    registerSessionTool("ide_test_throws_fake_error", {
      argsSchema: z.object({}),
      resultSchema: sessionResultSchema({}),
      target: "none",
      handler: async () => {
        // A malicious/buggy handler forging a fake "typed" error to try to
        // smuggle an arbitrary code/message through the boundary.
        throw {
          code: "unknown_project",
          message: "/Users/marcus/.ssh/id_rsa leaked via forged error",
        };
      },
    });

    const result = await runSessionTool(
      "ide_test_throws_fake_error",
      {},
      makeDeps(),
      "mcp_tool",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("internal_error");
    expect(result.error.message).not.toContain("/Users/marcus");
    expect(result.error.message).not.toContain("leaked");
  });

  test("security: a handler throwing a non-Error primitive (string/number/undefined) is still mapped to the generic internal_error", async () => {
    __resetSessionToolsForTests();
    registerSessionTool("ide_test_throws_string", {
      argsSchema: z.object({}),
      resultSchema: sessionResultSchema({}),
      target: "none",
      handler: async () => {
        throw "/Users/marcus/secret raw string throw";
      },
    });

    const result = await runSessionTool(
      "ide_test_throws_string",
      {},
      makeDeps(),
      "mcp_tool",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("internal_error");
    expect(result.error.message).not.toContain("/Users/marcus");
  });
});

// --- closed audit-event wiring at the executor boundary --------------------

describe("runSessionTool: deps.audit wiring", () => {
  function makeAuditDeps(overrides: Partial<SessionToolDeps> = {}): {
    deps: SessionToolDeps;
    events: unknown[];
  } {
    const events: unknown[] = [];
    const deps = makeDeps({
      audit: (payload) => {
        events.push(payload);
      },
      ...overrides,
    });
    return { deps, events };
  }

  test("backward compat: a deps object with no 'audit' field at all still works — audit is a pure no-op, never an error", async () => {
    __resetSessionToolsForTests();
    registerSessionTool("ide_test_audit_no_recorder", {
      argsSchema: z.object({}),
      resultSchema: sessionResultSchema({ pinged: z.boolean() }),
      target: "none",
      handler: async () => ({ ok: true, data: { pinged: true } }),
    });

    const result = await runSessionTool(
      "ide_test_audit_no_recorder",
      {},
      makeDeps(), // no `audit` override — matches every pre-existing fixture
      "mcp_tool",
    );
    expect(result.ok).toBe(true);
  });

  test("happy path: a successful target:'none' call emits exactly one ok event with no project/sessionId", async () => {
    __resetSessionToolsForTests();
    registerSessionTool("ide_test_audit_none_ok", {
      argsSchema: z.object({}),
      resultSchema: sessionResultSchema({ pinged: z.boolean() }),
      target: "none",
      handler: async () => ({ ok: true, data: { pinged: true } }),
    });

    const { deps, events } = makeAuditDeps();
    await runSessionTool("ide_test_audit_none_ok", {}, deps, "mcp_tool");

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      tool: "ide_test_audit_none_ok",
      source: "mcp_tool",
      outcome: "ok",
      bytes: undefined,
      truncated: undefined,
    });
  });

  test("happy path: a successful target:'project' call emits the RESOLVED project name, not the raw caller-supplied string", async () => {
    __resetSessionToolsForTests();
    registerSessionTool("ide_test_audit_project_ok", {
      argsSchema: projectTargetSchema,
      resultSchema: sessionResultSchema({}),
      target: "project",
      handler: async () => ({ ok: true, data: {} }),
    });

    const { deps, events } = makeAuditDeps();
    await runSessionTool(
      "ide_test_audit_project_ok",
      { project: "dashboard" },
      deps,
      "mcp_tool",
    );

    expect(events).toHaveLength(1);
    const event = events[0] as { project?: string; sessionId?: string };
    expect(event.project).toBe("dashboard");
    expect(event.sessionId).toBeUndefined();
  });

  test("happy path: a successful target:'session' call emits both the resolved sessionId AND its owning resolved project", async () => {
    __resetSessionToolsForTests();
    registerSessionTool("ide_test_audit_session_ok", {
      argsSchema: sessionTargetSchema,
      resultSchema: sessionResultSchema({}),
      target: "session",
      handler: async () => ({ ok: true, data: {} }),
    });

    const { deps, events } = makeAuditDeps();
    await runSessionTool(
      "ide_test_audit_session_ok",
      { sessionId: "ses_live" },
      deps,
      "mcp_tool",
    );

    expect(events).toHaveLength(1);
    const event = events[0] as { project?: string; sessionId?: string };
    expect(event.sessionId).toBe("ses_live");
    expect(event.project).toBe("dashboard");
  });

  test("happy path: safe bytes/truncated metadata from a successful result's `meta` is forwarded verbatim", async () => {
    __resetSessionToolsForTests();
    registerSessionTool("ide_test_audit_meta", {
      argsSchema: z.object({}),
      resultSchema: sessionResultSchema({}),
      target: "none",
      handler: async () => ({
        ok: true,
        data: {},
        meta: { bytes: { returned: 40, original: 100 }, truncated: true },
      }),
    });

    const { deps, events } = makeAuditDeps();
    await runSessionTool("ide_test_audit_meta", {}, deps, "mcp_tool");

    expect(events).toHaveLength(1);
    const event = events[0] as {
      bytes?: { returned: number; original: number };
      truncated?: boolean;
    };
    expect(event.bytes).toEqual({ returned: 40, original: 100 });
    expect(event.truncated).toBe(true);
  });

  test("error path: unknown_tool fails BEFORE any handler/deps I/O and still emits a closed audit event pre-operation", async () => {
    __resetSessionToolsForTests();
    const { deps, events } = makeAuditDeps();

    const result = await runSessionTool(
      "does_not_exist_audit",
      {},
      deps,
      "mcp_tool",
    );

    expect(result.ok).toBe(false);
    expect(events).toHaveLength(1);
    // The raw caller-supplied tool name is NEVER forwarded to the audit
    // sink — an unknown tool name is exactly the kind of attacker/
    // malformed-controlled string this boundary must not echo.
    expect(events[0]).toEqual({
      tool: "ide_unknown_tool",
      source: "mcp_tool",
      outcome: "error",
      errorCode: "unknown_tool",
    });
  });

  test("security: a malicious/credential-shaped unknown tool name never reaches the audit callback verbatim", async () => {
    __resetSessionToolsForTests();
    const { deps, events } = makeAuditDeps();
    const maliciousName = "Authorization: Bearer secret-token-xyz";

    await runSessionTool(maliciousName, {}, deps, "mcp_tool");

    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(maliciousName);
    expect(JSON.stringify(events)).not.toContain("secret-token-xyz");
    expect((events[0] as { tool: string }).tool).toBe("ide_unknown_tool");
  });

  test("error path: invalid_arguments (malformed args) emits a closed audit event with no project/sessionId (target never resolved)", async () => {
    __resetSessionToolsForTests();
    registerSessionTool("ide_test_audit_malformed", {
      argsSchema: projectTargetSchema,
      resultSchema: sessionResultSchema({}),
      target: "project",
      handler: async () => ({ ok: true, data: {} }),
    });

    const { deps, events } = makeAuditDeps();
    await runSessionTool(
      "ide_test_audit_malformed",
      { project: 123 },
      deps,
      "mcp_tool",
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      tool: "ide_test_audit_malformed",
      source: "mcp_tool",
      outcome: "error",
      errorCode: "invalid_arguments",
    });
  });

  test("error path: unresolved target (unknown_project) emits a closed audit event before the handler runs, with no project field (nothing resolved)", async () => {
    __resetSessionToolsForTests();
    registerSessionTool("ide_test_audit_unknown_project", {
      argsSchema: projectTargetSchema,
      resultSchema: sessionResultSchema({}),
      target: "project",
      handler: async () => ({ ok: true, data: {} }),
    });

    const { deps, events } = makeAuditDeps();
    await runSessionTool(
      "ide_test_audit_unknown_project",
      { project: "does-not-exist" },
      deps,
      "mcp_tool",
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      tool: "ide_test_audit_unknown_project",
      source: "mcp_tool",
      outcome: "error",
      errorCode: "unknown_project",
    });
  });

  test("error path: a handler-returned typed failure emits a closed error event with the RESOLVED target identifiers still present", async () => {
    __resetSessionToolsForTests();
    registerSessionTool("ide_test_audit_handler_error", {
      argsSchema: projectTargetSchema,
      resultSchema: sessionResultSchema({}),
      target: "project",
      handler: async () => ({
        ok: false,
        error: {
          code: "upstream_error" as const,
          message: "The upstream operation failed.",
          delivery: "indeterminate" as const,
        },
      }),
    });

    const { deps, events } = makeAuditDeps();
    await runSessionTool(
      "ide_test_audit_handler_error",
      { project: "dashboard" },
      deps,
      "mcp_tool",
    );

    expect(events).toHaveLength(1);
    const event = events[0] as { project?: string; errorCode?: string };
    expect(event.project).toBe("dashboard");
    expect(event.errorCode).toBe("upstream_error");
  });

  test("error path: a handler THROW emits internal_error in the audit event too, with resolved identifiers still present", async () => {
    __resetSessionToolsForTests();
    registerSessionTool("ide_test_audit_handler_throw", {
      argsSchema: projectTargetSchema,
      resultSchema: sessionResultSchema({}),
      target: "project",
      handler: async () => {
        throw new Error("/Users/marcus/secret upstream text");
      },
    });

    const { deps, events } = makeAuditDeps();
    const result = await runSessionTool(
      "ide_test_audit_handler_throw",
      { project: "dashboard" },
      deps,
      "mcp_tool",
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.delivery).toBe("indeterminate");
    expect(events).toHaveLength(1);
    const event = events[0] as {
      project?: string;
      errorCode?: string;
      outcome: string;
    };
    expect(event.project).toBe("dashboard");
    expect(event.errorCode).toBe("internal_error");
    expect(event.outcome).toBe("error");
    // No raw exception text anywhere in the audit payload.
    expect(JSON.stringify(events)).not.toContain("/Users/marcus");
    expect(JSON.stringify(events)).not.toContain("secret upstream text");
  });

  test("resilience: a THROWING audit recorder never changes the returned SessionToolResult — the real operation's own success is untouched", async () => {
    __resetSessionToolsForTests();
    registerSessionTool("ide_test_audit_recorder_throws_ok", {
      argsSchema: z.object({}),
      resultSchema: sessionResultSchema({ pinged: z.boolean() }),
      target: "none",
      handler: async () => ({ ok: true, data: { pinged: true } }),
    });

    const deps = makeDeps({
      audit: () => {
        throw new Error("audit sink is on fire");
      },
    });

    const result = await runSessionTool(
      "ide_test_audit_recorder_throws_ok",
      {},
      deps,
      "mcp_tool",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data).toEqual({ pinged: true });
  });

  test("resilience: a THROWING audit recorder never changes a real error result either — no misreporting the operation as not_sent because the audit sink failed post-operation", async () => {
    __resetSessionToolsForTests();
    registerSessionTool("ide_test_audit_recorder_throws_error", {
      argsSchema: z.object({}),
      resultSchema: sessionResultSchema({}),
      target: "none",
      handler: async () => {
        throw new Error("real upstream failure, unrelated to audit");
      },
    });

    const deps = makeDeps({
      audit: () => {
        throw new Error("audit sink is on fire");
      },
    });

    const result = await runSessionTool(
      "ide_test_audit_recorder_throws_error",
      {},
      deps,
      "mcp_tool",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    // The handler threw AFTER potentially performing I/O — delivery must
    // still be "indeterminate", exactly as it would be with no audit
    // recorder at all. A throwing audit sink must never downgrade this
    // to "not_sent" (which would misreport a possibly-already-sent
    // operation as definitely-not-sent) nor upgrade/mask it any other way.
    expect(result.error.delivery).toBe("indeterminate");
    expect(result.error.code).toBe("internal_error");
  });
});

// --- A: allowlist output boundary — resultSchema enforcement ---------------

describe("runSessionTool: output allowlist boundary (resultSchema)", () => {
  test("happy path: declared fields pass through, matching the schema exactly", async () => {
    __resetSessionToolsForTests();
    registerSessionTool("ide_test_output_clean", {
      argsSchema: z.object({}),
      resultSchema: sessionResultSchema({ title: z.string() }),
      target: "none",
      handler: async () => ({ ok: true, data: { title: "Fix the thing" } }),
    });

    const result = await runSessionTool(
      "ide_test_output_clean",
      {},
      makeDeps(),
      "mcp_tool",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data).toEqual({ title: "Fix the thing" });
  });

  test("security: a malicious handler returning an undeclared 'path' field never leaks it — every sessionResultSchema is strict, so the whole result is rejected closed", async () => {
    __resetSessionToolsForTests();
    registerSessionTool("ide_test_output_leaks_path", {
      argsSchema: z.object({}),
      resultSchema: sessionResultSchema({ title: z.string() }),
      target: "none",
      handler: async () =>
        ({
          ok: true,
          data: { title: "ok", path: "/Users/marcus/.ssh/id_rsa" },
        }) as unknown as { ok: true; data: { title: string } },
    });

    const result = await runSessionTool(
      "ide_test_output_leaks_path",
      {},
      makeDeps(),
      "mcp_tool",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("internal_error");
    expect(result.error.delivery).toBe("indeterminate");
    expect(JSON.stringify(result)).not.toContain("/Users/marcus");
  });

  test("security: a malicious handler returning an undeclared Authorization/Bearer field is rejected closed — sessionResultSchema is always strict, never a silent-strip shape", async () => {
    __resetSessionToolsForTests();
    registerSessionTool("ide_test_output_leaks_auth", {
      argsSchema: z.object({}),
      resultSchema: sessionResultSchema({ title: z.string() }),
      target: "none",
      handler: async () =>
        ({
          ok: true,
          data: {
            title: "ok",
            Authorization: "Bearer secret-token-xyz",
          },
        }) as unknown as { ok: true; data: { title: string } },
    });

    const result = await runSessionTool(
      "ide_test_output_leaks_auth",
      {},
      makeDeps(),
      "mcp_tool",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("internal_error");
    expect(JSON.stringify(result)).not.toContain("Bearer");
    expect(JSON.stringify(result)).not.toContain("secret-token-xyz");
  });

  test("security: a malicious handler returning undeclared prompt/transcript/question/answer fields never crosses the boundary", async () => {
    __resetSessionToolsForTests();
    registerSessionTool("ide_test_output_leaks_content", {
      argsSchema: z.object({}),
      resultSchema: sessionResultSchema({ id: z.string() }),
      target: "none",
      handler: async () =>
        ({
          ok: true,
          data: {
            id: "ses_1",
            prompt: "the user's raw prompt text",
            transcript: "full conversation transcript",
            question: "pending question text",
            answer: "the answer given",
          },
        }) as unknown as { ok: true; data: { id: string } },
    });

    const result = await runSessionTool(
      "ide_test_output_leaks_content",
      {},
      makeDeps(),
      "mcp_tool",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("raw prompt text");
    expect(serialized).not.toContain("conversation transcript");
    expect(serialized).not.toContain("pending question text");
    expect(serialized).not.toContain("the answer given");
  });

  test("error path: a wrong-TYPE success data (e.g. a string where an object is declared) is rejected as internal_error/indeterminate", async () => {
    __resetSessionToolsForTests();
    registerSessionTool("ide_test_output_wrong_type", {
      argsSchema: z.object({}),
      resultSchema: sessionResultSchema({ id: z.string() }),
      target: "none",
      handler: async () =>
        ({ ok: true, data: "not-an-object" }) as unknown as {
          ok: true;
          data: { id: string };
        },
    });

    const result = await runSessionTool(
      "ide_test_output_wrong_type",
      {},
      makeDeps(),
      "mcp_tool",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("internal_error");
    expect(result.error.delivery).toBe("indeterminate");
  });

  test("error path: an ok:true result with a malformed envelope (ok is truthy but not literal true) is rejected, not coerced", async () => {
    __resetSessionToolsForTests();
    registerSessionTool("ide_test_output_truthy_ok", {
      argsSchema: z.object({}),
      resultSchema: sessionResultSchema({}),
      target: "none",
      handler: async () =>
        ({ ok: 1, data: {} }) as unknown as { ok: true; data: object },
    });

    const result = await runSessionTool(
      "ide_test_output_truthy_ok",
      {},
      makeDeps(),
      "mcp_tool",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("internal_error");
    expect(result.error.delivery).toBe("indeterminate");
  });

  test("audit: bytes/truncation metadata is only ever derived from the VALIDATED output's meta, never fabricated when absent", async () => {
    __resetSessionToolsForTests();
    registerSessionTool("ide_test_output_no_meta", {
      argsSchema: z.object({}),
      resultSchema: sessionResultSchema({}),
      target: "none",
      handler: async () => ({ ok: true, data: {} }),
    });

    const events: unknown[] = [];
    const deps = makeDeps({ audit: (p) => events.push(p) });
    await runSessionTool("ide_test_output_no_meta", {}, deps, "mcp_tool");

    expect(events).toHaveLength(1);
    const event = events[0] as { bytes?: unknown; truncated?: unknown };
    expect(event.bytes).toBeUndefined();
    expect(event.truncated).toBeUndefined();
  });

  test("error path: a mixed ok:true result that ALSO carries an 'error' field is rejected as a malformed envelope — internal_error/indeterminate, exactly one audit event", async () => {
    __resetSessionToolsForTests();
    registerSessionTool("ide_test_envelope_mixed_ok_error", {
      argsSchema: z.object({}),
      resultSchema: sessionResultSchema({}),
      target: "none",
      handler: async () =>
        ({
          ok: true,
          data: {},
          error: { code: "internal_error", message: "should never coexist" },
        }) as unknown as { ok: true; data: object },
    });

    const events: unknown[] = [];
    const deps = makeDeps({ audit: (p) => events.push(p) });
    const result = await runSessionTool(
      "ide_test_envelope_mixed_ok_error",
      {},
      deps,
      "mcp_tool",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("internal_error");
    expect(result.error.delivery).toBe("indeterminate");
    expect(events).toHaveLength(1);
  });

  test("error path: a mixed ok:false result that ALSO carries a 'data' field is rejected as a malformed envelope — internal_error/indeterminate, exactly one audit event", async () => {
    __resetSessionToolsForTests();
    registerSessionTool("ide_test_envelope_mixed_error_data", {
      argsSchema: z.object({}),
      resultSchema: sessionResultSchema({}),
      target: "none",
      handler: async () =>
        ({
          ok: false,
          error: { code: "upstream_error", message: "x" },
          data: { shouldNeverCoexist: true },
        }) as unknown as {
          ok: false;
          error: { code: "upstream_error"; message: string };
        },
    });

    const events: unknown[] = [];
    const deps = makeDeps({ audit: (p) => events.push(p) });
    const result = await runSessionTool(
      "ide_test_envelope_mixed_error_data",
      {},
      deps,
      "mcp_tool",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("internal_error");
    expect(result.error.delivery).toBe("indeterminate");
    expect(events).toHaveLength(1);
  });

  test("error path: a mixed ok:false result that ALSO carries a 'meta' field is rejected as a malformed envelope", async () => {
    __resetSessionToolsForTests();
    registerSessionTool("ide_test_envelope_mixed_error_meta", {
      argsSchema: z.object({}),
      resultSchema: sessionResultSchema({}),
      target: "none",
      handler: async () =>
        ({
          ok: false,
          error: { code: "upstream_error", message: "x" },
          meta: { truncated: true },
        }) as unknown as {
          ok: false;
          error: { code: "upstream_error"; message: string };
        },
    });

    const result = await runSessionTool(
      "ide_test_envelope_mixed_error_meta",
      {},
      makeDeps(),
      "mcp_tool",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("internal_error");
    expect(result.error.delivery).toBe("indeterminate");
  });

  test("error path: an ok:true result with an unrelated undeclared TOP-LEVEL envelope field (outside data/meta) is rejected as a malformed envelope", async () => {
    __resetSessionToolsForTests();
    registerSessionTool("ide_test_envelope_extra_top_level", {
      argsSchema: z.object({}),
      resultSchema: sessionResultSchema({}),
      target: "none",
      handler: async () =>
        ({
          ok: true,
          data: {},
          unexpectedTopLevelField: "path-or-header-shaped-value",
        }) as unknown as { ok: true; data: object },
    });

    const result = await runSessionTool(
      "ide_test_envelope_extra_top_level",
      {},
      makeDeps(),
      "mcp_tool",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("internal_error");
    expect(result.error.delivery).toBe("indeterminate");
  });

  test("error path: an ok:true result whose 'meta.bytes' carries an undeclared field is rejected as a malformed envelope", async () => {
    __resetSessionToolsForTests();
    registerSessionTool("ide_test_envelope_meta_bytes_extra", {
      argsSchema: z.object({}),
      resultSchema: sessionResultSchema({}),
      target: "none",
      handler: async () =>
        ({
          ok: true,
          data: {},
          meta: {
            bytes: { returned: 1, original: 1, extraField: "leaked" },
          },
        }) as unknown as { ok: true; data: object },
    });

    const result = await runSessionTool(
      "ide_test_envelope_meta_bytes_extra",
      {},
      makeDeps(),
      "mcp_tool",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("internal_error");
  });
});

// --- B: handler-returned error normalization --------------------------------

describe("runSessionTool: handler-returned error normalization", () => {
  test("security: a handler cannot choose its own error message even for upstream_error/internal_error — the program-owned constant always wins", async () => {
    __resetSessionToolsForTests();
    registerSessionTool("ide_test_error_no_custom_message", {
      argsSchema: z.object({}),
      resultSchema: sessionResultSchema({}),
      target: "none",
      handler: async () => ({
        ok: false,
        error: {
          code: "upstream_error" as const,
          message: "raw upstream body: /Users/marcus/.ssh/id_rsa",
          delivery: "indeterminate" as const,
        },
      }),
    });

    const result = await runSessionTool(
      "ide_test_error_no_custom_message",
      {},
      makeDeps(),
      "mcp_tool",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("upstream_error");
    expect(result.error.message).not.toContain("/Users/marcus");
    expect(result.error.delivery).toBe("indeterminate");
  });

  test("security: a handler-returned error with an unknown/malformed code is normalized to internal_error/indeterminate, pre-handler-failure not_sent semantics never apply here", async () => {
    __resetSessionToolsForTests();
    registerSessionTool("ide_test_error_bad_code", {
      argsSchema: z.object({}),
      resultSchema: sessionResultSchema({}),
      target: "none",
      handler: async () =>
        ({
          ok: false,
          error: { code: "made_up_code", message: "whatever" },
        }) as unknown as {
          ok: false;
          error: { code: "internal_error"; message: string };
        },
    });

    const result = await runSessionTool(
      "ide_test_error_bad_code",
      {},
      makeDeps(),
      "mcp_tool",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("internal_error");
    expect(result.error.delivery).toBe("indeterminate");
  });

  test("regression: pre-handler failures (unknown tool, malformed args, unresolved target) remain not_sent — only POST-handler failures are indeterminate", async () => {
    __resetSessionToolsForTests();
    registerSessionTool("ide_test_error_prehandler", {
      argsSchema: projectTargetSchema,
      resultSchema: sessionResultSchema({}),
      target: "project",
      handler: async () => ({ ok: true, data: {} }),
    });

    const unknownToolResult = await runSessionTool(
      "ide_test_totally_missing",
      {},
      makeDeps(),
      "mcp_tool",
    );
    expect(unknownToolResult.ok).toBe(false);
    if (unknownToolResult.ok) throw new Error("expected error");
    expect(unknownToolResult.error.delivery).toBe("not_sent");

    const malformedResult = await runSessionTool(
      "ide_test_error_prehandler",
      { project: 123 },
      makeDeps(),
      "mcp_tool",
    );
    expect(malformedResult.ok).toBe(false);
    if (malformedResult.ok) throw new Error("expected error");
    expect(malformedResult.error.delivery).toBe("not_sent");

    const unresolvedResult = await runSessionTool(
      "ide_test_error_prehandler",
      { project: "does-not-exist" },
      makeDeps(),
      "mcp_tool",
    );
    expect(unresolvedResult.ok).toBe(false);
    if (unresolvedResult.ok) throw new Error("expected error");
    expect(unresolvedResult.error.delivery).toBe("not_sent");
  });

  test("security: raw upstream response text returned via a handler error's message field never crosses the boundary", async () => {
    __resetSessionToolsForTests();
    registerSessionTool("ide_test_error_raw_upstream_text", {
      argsSchema: z.object({}),
      resultSchema: sessionResultSchema({}),
      target: "none",
      handler: async () => ({
        ok: false,
        error: {
          code: "upstream_error" as const,
          message:
            'HTTP 500: {"error":"internal","trace":"at handler (/srv/opencode/index.js:42)"} Authorization: Bearer abc123',
          delivery: "indeterminate" as const,
        },
      }),
    });

    const result = await runSessionTool(
      "ide_test_error_raw_upstream_text",
      {},
      makeDeps(),
      "mcp_tool",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    const msg = result.error.message;
    expect(msg).not.toContain("srv/opencode");
    expect(msg).not.toContain("Bearer abc123");
    expect(msg).not.toContain("HTTP 500");
  });
});

// --- C: audit hardening — registration validation, exactly-one-event -------

describe("registerSessionTool: tool-name registration validation", () => {
  test("happy path: an ide_-prefixed, lowercase, underscore-only name registers successfully", () => {
    __resetSessionToolsForTests();
    expect(() =>
      registerSessionTool("ide_valid_tool_name", {
        argsSchema: z.object({}),
        resultSchema: sessionResultSchema({}),
        target: "none",
        handler: async () => ({ ok: true, data: {} }),
      }),
    ).not.toThrow();
  });

  test("error path: registering a non-ide_-prefixed name throws synchronously, refusing registration", () => {
    __resetSessionToolsForTests();
    expect(() =>
      registerSessionTool("not_ide_prefixed", {
        argsSchema: z.object({}),
        resultSchema: sessionResultSchema({}),
        target: "none",
        handler: async () => ({ ok: true, data: {} }),
      }),
    ).toThrow();
    expect(isRegisteredSessionTool("not_ide_prefixed")).toBe(false);
  });

  test("error path: registering an uppercase, space-containing, or punctuation-containing name throws", () => {
    __resetSessionToolsForTests();
    for (const bad of [
      "ide_HasUpperCase",
      "ide_has space",
      "ide_has/slash",
      "ide_has-hyphen",
      "ide_",
      "IDE_LIST_SESSIONS",
    ]) {
      expect(() =>
        registerSessionTool(bad, {
          argsSchema: z.object({}),
          resultSchema: sessionResultSchema({}),
          target: "none",
          handler: async () => ({ ok: true, data: {} }),
        }),
      ).toThrow();
    }
  });

  test("security: registering with an UNBRANDED resultSchema (z.unknown()) throws, even bypassing the type system via a cast", () => {
    __resetSessionToolsForTests();
    expect(() =>
      registerSessionTool("ide_test_unbranded_unknown", {
        argsSchema: z.object({}),
        // biome-ignore lint/suspicious/noExplicitAny: deliberately bypassing the type-level brand to prove the RUNTIME check catches it too.
        resultSchema: z.unknown() as any,
        target: "none",
        handler: async () => ({ ok: true, data: {} }),
      }),
    ).toThrow();
    expect(isRegisteredSessionTool("ide_test_unbranded_unknown")).toBe(false);
  });

  test("security: registering with an UNBRANDED resultSchema (z.any()) throws", () => {
    __resetSessionToolsForTests();
    expect(() =>
      registerSessionTool("ide_test_unbranded_any", {
        argsSchema: z.object({}),
        // biome-ignore lint/suspicious/noExplicitAny: deliberately bypassing the type-level brand.
        resultSchema: z.any() as any,
        target: "none",
        handler: async () => ({ ok: true, data: {} }),
      }),
    ).toThrow();
  });

  test("security: registering with a hand-built z.object({}).passthrough() resultSchema throws, even though it is a valid ZodType<T>", () => {
    __resetSessionToolsForTests();
    expect(() =>
      registerSessionTool("ide_test_unbranded_passthrough", {
        argsSchema: z.object({}),
        // biome-ignore lint/suspicious/noExplicitAny: deliberately bypassing the type-level brand.
        resultSchema: z.object({}).passthrough() as any,
        target: "none",
        handler: async () => ({ ok: true, data: {} }),
      }),
    ).toThrow();
  });

  test("security: registering with an unbounded z.record(...) resultSchema throws", () => {
    __resetSessionToolsForTests();
    expect(() =>
      registerSessionTool("ide_test_unbranded_record", {
        argsSchema: z.object({}),
        // biome-ignore lint/suspicious/noExplicitAny: deliberately bypassing the type-level brand.
        resultSchema: z.record(z.string(), z.unknown()) as any,
        target: "none",
        handler: async () => ({ ok: true, data: {} }),
      }),
    ).toThrow();
  });

  test("security: registering with a lookalike z.object({...}).strict() built by hand (NOT via sessionResultSchema) still throws — the brand is checked by identity, not by re-inspecting the schema's own strictness", () => {
    __resetSessionToolsForTests();
    expect(() =>
      registerSessionTool("ide_test_unbranded_lookalike_strict", {
        argsSchema: z.object({}),
        // biome-ignore lint/suspicious/noExplicitAny: deliberately bypassing the type-level brand.
        resultSchema: z.object({ id: z.string() }).strict() as any,
        target: "none",
        handler: async () => ({ ok: true, data: { id: "x" } }),
      }),
    ).toThrow();
  });

  test("happy path: registering with a real sessionResultSchema-built resultSchema succeeds", () => {
    __resetSessionToolsForTests();
    expect(() =>
      registerSessionTool("ide_test_branded_accepted", {
        argsSchema: z.object({}),
        resultSchema: sessionResultSchema({ id: z.string() }),
        target: "none",
        handler: async () => ({ ok: true, data: { id: "x" } }),
      }),
    ).not.toThrow();
    expect(isRegisteredSessionTool("ide_test_branded_accepted")).toBe(true);
  });
});

describe("runSessionTool: exactly-one-terminal-audit-event guarantee", () => {
  test("every terminal path (unknown tool, malformed args, unresolved target, handler ok, handler error, handler throw, output-schema rejection) emits EXACTLY one event", async () => {
    __resetSessionToolsForTests();
    registerSessionTool("ide_test_exactly_one_ok", {
      argsSchema: z.object({}),
      resultSchema: sessionResultSchema({}),
      target: "none",
      handler: async () => ({ ok: true, data: {} }),
    });
    registerSessionTool("ide_test_exactly_one_error", {
      argsSchema: z.object({}),
      resultSchema: sessionResultSchema({}),
      target: "none",
      handler: async () => ({
        ok: false,
        error: { code: "upstream_error" as const, message: "x" },
      }),
    });
    registerSessionTool("ide_test_exactly_one_throw", {
      argsSchema: z.object({}),
      resultSchema: sessionResultSchema({}),
      target: "none",
      handler: async () => {
        throw new Error("boom");
      },
    });
    registerSessionTool("ide_test_exactly_one_bad_output", {
      argsSchema: z.object({}),
      resultSchema: sessionResultSchema({ id: z.string() }),
      target: "none",
      handler: async () =>
        ({ ok: true, data: {} }) as unknown as {
          ok: true;
          data: { id: string };
        },
    });

    const events: unknown[] = [];
    const deps = makeDeps({ audit: (p) => events.push(p) });

    await runSessionTool("ide_test_totally_unknown", {}, deps, "mcp_tool");
    await runSessionTool(
      "ide_test_exactly_one_ok",
      { project: "extra-unexpected-field" },
      deps,
      "mcp_tool",
    );
    await runSessionTool("ide_test_exactly_one_ok", {}, deps, "mcp_tool");
    await runSessionTool("ide_test_exactly_one_error", {}, deps, "mcp_tool");
    await runSessionTool("ide_test_exactly_one_throw", {}, deps, "mcp_tool");
    await runSessionTool(
      "ide_test_exactly_one_bad_output",
      {},
      deps,
      "mcp_tool",
    );

    expect(events).toHaveLength(6);
  });

  test("resilience: an audit callback that throws AFTER a real successful operation never causes retry-unsafe misreporting — the returned result is untouched and exactly one attempt was made", async () => {
    __resetSessionToolsForTests();
    let handlerCallCount = 0;
    registerSessionTool("ide_test_audit_throw_after_success", {
      argsSchema: z.object({}),
      resultSchema: sessionResultSchema({}),
      target: "none",
      handler: async () => {
        handlerCallCount++;
        return { ok: true, data: {} };
      },
    });

    const deps = makeDeps({
      audit: () => {
        throw new Error("audit sink exploded after operation completed");
      },
    });

    const result = await runSessionTool(
      "ide_test_audit_throw_after_success",
      {},
      deps,
      "mcp_tool",
    );
    expect(result.ok).toBe(true);
    expect(handlerCallCount).toBe(1);
  });
});
