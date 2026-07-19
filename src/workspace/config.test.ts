import { describe, expect, test } from "bun:test";
import { loadWorkspace } from "./config";

function stubReader(files: Record<string, string>) {
  return async (path: string) => {
    if (path in files) return files[path] as string;
    throw new Error(`ENOENT: ${path}`);
  };
}

describe("loadWorkspace", () => {
  test("valid manifest -> typed projects with expandedPath", async () => {
    const manifest = {
      server: { baseUrl: "http://127.0.0.1:4096" },
      projects: [
        { name: "proj-a", path: "~/src/proj-a", description: "A project" },
      ],
    };
    const result = await loadWorkspace("/workspace", {
      readTextFile: stubReader({
        "/workspace/spacebus.json": JSON.stringify(manifest),
      }),
      homeDir: "/Users/marcus",
    });
    expect(result.kind).toBe("workspace");
    if (result.kind !== "workspace") throw new Error("expected workspace");
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0]).toMatchObject({
      name: "proj-a",
      path: "~/src/proj-a",
      expandedPath: "/Users/marcus/src/proj-a",
    });
  });

  test("missing spacebus.json -> virtual single-project workspace", async () => {
    const result = await loadWorkspace("/opened/dir", {
      readTextFile: stubReader({}),
    });
    expect(result.kind).toBe("virtual");
    if (result.kind !== "virtual") throw new Error("expected virtual");
    expect(result.project.name).toBe("dir");
    expect(result.project.path).toBe("/opened/dir");
  });

  test("projects: [] -> workspace kind with empty array", async () => {
    const manifest = {
      server: { baseUrl: "http://localhost:4096" },
      projects: [],
    };
    const result = await loadWorkspace("/workspace", {
      readTextFile: stubReader({
        "/workspace/spacebus.json": JSON.stringify(manifest),
      }),
    });
    expect(result.kind).toBe("workspace");
    if (result.kind !== "workspace") throw new Error("expected workspace");
    expect(result.projects).toHaveLength(0);
  });

  test("malformed manifest -> error kind with zod message", async () => {
    const badManifest = {
      server: { baseUrl: "http://127.0.0.1:4096" },
      projects: [{ name: "x" }],
    };
    const result = await loadWorkspace("/workspace", {
      readTextFile: stubReader({
        "/workspace/spacebus.json": JSON.stringify(badManifest),
      }),
    });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected error");
    expect(result.message.length).toBeGreaterThan(0);
  });

  test("malformed JSON -> error kind, never partial", async () => {
    const result = await loadWorkspace("/workspace", {
      readTextFile: stubReader({ "/workspace/spacebus.json": "{not json" }),
    });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected error");
    expect(result.message).toContain("not valid JSON");
  });

  test("extra unknown top-level fields are stripped, not rejected", async () => {
    const manifest = {
      server: { baseUrl: "http://127.0.0.1:4096" },
      projects: [],
      futureField: { some: "thing" },
    };
    const result = await loadWorkspace("/workspace", {
      readTextFile: stubReader({
        "/workspace/spacebus.json": JSON.stringify(manifest),
      }),
    });
    expect(result.kind).toBe("workspace");
    if (result.kind !== "workspace") throw new Error("expected workspace");
    expect(result.config.server.baseUrl).toBe("http://127.0.0.1:4096");
    expect(result.config).not.toHaveProperty("futureField");
  });

  test("unknown fields nested in server/managed are stripped, not rejected", async () => {
    const manifest = {
      server: {
        baseUrl: "http://127.0.0.1:4096",
        futureServerField: true,
      },
      projects: [],
    };
    const result = await loadWorkspace("/workspace", {
      readTextFile: stubReader({
        "/workspace/spacebus.json": JSON.stringify(manifest),
      }),
    });
    expect(result.kind).toBe("workspace");
    if (result.kind !== "workspace") throw new Error("expected workspace");
    expect(result.config.server).not.toHaveProperty("futureServerField");

    const manifest2 = {
      server: {
        managed: { command: ["harness", "serve"], futureManagedField: 1 },
      },
      projects: [],
    };
    const result2 = await loadWorkspace("/workspace", {
      readTextFile: stubReader({
        "/workspace/spacebus.json": JSON.stringify(manifest2),
      }),
    });
    expect(result2.kind).toBe("workspace");
    if (result2.kind !== "workspace") throw new Error("expected workspace");
    expect(result2.config.server.managed).not.toHaveProperty(
      "futureManagedField",
    );
  });

  test("non-localhost baseUrl -> refusal", async () => {
    const manifest = {
      server: { baseUrl: "https://evil.example.com" },
      projects: [],
    };
    const result = await loadWorkspace("/workspace", {
      readTextFile: stubReader({
        "/workspace/spacebus.json": JSON.stringify(manifest),
      }),
    });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected error");
    expect(result.message).toContain(
      "refusing to send credentials off-machine",
    );
  });

  test("::1 and [::1] baseUrl hostnames are accepted as localhost", async () => {
    for (const baseUrl of ["http://[::1]:4096", "http://localhost:4096"]) {
      const manifest = { server: { baseUrl }, projects: [] };
      const result = await loadWorkspace("/workspace", {
        readTextFile: stubReader({
          "/workspace/spacebus.json": JSON.stringify(manifest),
        }),
      });
      expect(result.kind).toBe("workspace");
    }
  });

  test("managed-only server (no baseUrl) -> valid workspace", async () => {
    const manifest = {
      server: { managed: { command: ["harness", "serve"] } },
      projects: [],
    };
    const result = await loadWorkspace("/workspace", {
      readTextFile: stubReader({
        "/workspace/spacebus.json": JSON.stringify(manifest),
      }),
    });
    expect(result.kind).toBe("workspace");
    if (result.kind !== "workspace") throw new Error("expected workspace");
    expect(result.config.server.managed).toEqual({
      command: ["harness", "serve"],
    });
  });

  test("both baseUrl and managed present -> error kind", async () => {
    const manifest = {
      server: {
        baseUrl: "http://127.0.0.1:4096",
        managed: { command: ["harness", "serve"] },
      },
      projects: [],
    };
    const result = await loadWorkspace("/workspace", {
      readTextFile: stubReader({
        "/workspace/spacebus.json": JSON.stringify(manifest),
      }),
    });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected error");
    expect(result.message).toContain("exactly one of baseUrl or managed");
  });

  test("neither baseUrl nor managed present -> error kind", async () => {
    const manifest = { server: {}, projects: [] };
    const result = await loadWorkspace("/workspace", {
      readTextFile: stubReader({
        "/workspace/spacebus.json": JSON.stringify(manifest),
      }),
    });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected error");
    expect(result.message).toContain("exactly one of baseUrl or managed");
  });

  test("two projects with the same name -> error kind, fails closed", async () => {
    const manifest = {
      server: { baseUrl: "http://127.0.0.1:4096" },
      projects: [
        { name: "dup", path: "~/src/a", description: "A" },
        { name: "dup", path: "~/src/b", description: "B" },
      ],
    };
    const result = await loadWorkspace("/workspace", {
      readTextFile: stubReader({
        "/workspace/spacebus.json": JSON.stringify(manifest),
      }),
    });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected error");
    expect(result.message).toBe("spacebus.json project names must be unique");
    expect(result.message).not.toContain("~/src/a");
    expect(result.message).not.toContain("~/src/b");
  });

  test("three projects, two sharing a name -> error kind", async () => {
    const manifest = {
      server: { baseUrl: "http://127.0.0.1:4096" },
      projects: [
        { name: "proj-a", path: "~/src/a", description: "A" },
        { name: "proj-b", path: "~/src/b", description: "B" },
        { name: "proj-a", path: "~/src/c", description: "C" },
      ],
    };
    const result = await loadWorkspace("/workspace", {
      readTextFile: stubReader({
        "/workspace/spacebus.json": JSON.stringify(manifest),
      }),
    });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected error");
    expect(result.message).toBe("spacebus.json project names must be unique");
  });

  test("non-adjacent duplicate names -> error kind", async () => {
    const manifest = {
      server: { baseUrl: "http://127.0.0.1:4096" },
      projects: [
        { name: "alpha", path: "~/src/1", description: "1" },
        { name: "beta", path: "~/src/2", description: "2" },
        { name: "gamma", path: "~/src/3", description: "3" },
        { name: "alpha", path: "~/src/4", description: "4" },
      ],
    };
    const result = await loadWorkspace("/workspace", {
      readTextFile: stubReader({
        "/workspace/spacebus.json": JSON.stringify(manifest),
      }),
    });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected error");
    expect(result.message).toBe("spacebus.json project names must be unique");
  });

  test("duplicate path-shaped project names -> generic error, raw name not echoed", async () => {
    const manifest = {
      server: { baseUrl: "http://127.0.0.1:4096" },
      projects: [
        {
          name: "/Users/marcus/src/secret-project",
          path: "~/src/a",
          description: "A",
        },
        {
          name: "/Users/marcus/src/secret-project",
          path: "~/src/b",
          description: "B",
        },
      ],
    };
    const result = await loadWorkspace("/workspace", {
      readTextFile: stubReader({
        "/workspace/spacebus.json": JSON.stringify(manifest),
      }),
    });
    // A path-shaped project name now fails the manifest's own name
    // validator (schema-level, before duplicate detection even runs) —
    // still a stable, non-echoing error either way.
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected error");
    expect(result.message).not.toContain("/Users/marcus/src/secret-project");
  });

  test("duplicate credential-shaped project names -> generic error, raw name not echoed", async () => {
    const manifest = {
      server: { baseUrl: "http://127.0.0.1:4096" },
      projects: [
        {
          name: "token=sk-live-abc123XYZ",
          path: "~/src/a",
          description: "A",
        },
        {
          name: "token=sk-live-abc123XYZ",
          path: "~/src/b",
          description: "B",
        },
      ],
    };
    const result = await loadWorkspace("/workspace", {
      readTextFile: stubReader({
        "/workspace/spacebus.json": JSON.stringify(manifest),
      }),
    });
    // Same as above: this name is also credential-shaped and now fails
    // the manifest's own name validator before duplicate detection runs.
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected error");
    expect(result.message).not.toContain("token=sk-live-abc123XYZ");
    expect(result.message).not.toContain("sk-live-abc123XYZ");
  });

  test("case-distinct names are not treated as duplicates", async () => {
    const manifest = {
      server: { baseUrl: "http://127.0.0.1:4096" },
      projects: [
        { name: "Proj", path: "~/src/a", description: "A" },
        { name: "proj", path: "~/src/b", description: "B" },
      ],
    };
    const result = await loadWorkspace("/workspace", {
      readTextFile: stubReader({
        "/workspace/spacebus.json": JSON.stringify(manifest),
      }),
    });
    expect(result.kind).toBe("workspace");
    if (result.kind !== "workspace") throw new Error("expected workspace");
    expect(result.projects).toHaveLength(2);
  });

  test("valid unique roster with spaces, punctuation, unicode, and slash names -> unchanged", async () => {
    const manifest = {
      server: { baseUrl: "http://127.0.0.1:4096" },
      projects: [
        { name: "my project", path: "~/src/1", description: "1" },
        { name: "proj-a/b", path: "~/src/2", description: "2" },
        { name: "café ☕", path: "~/src/3", description: "3" },
        { name: "proj.a+b", path: "~/src/4", description: "4" },
      ],
    };
    const result = await loadWorkspace("/workspace", {
      readTextFile: stubReader({
        "/workspace/spacebus.json": JSON.stringify(manifest),
      }),
    });
    expect(result.kind).toBe("workspace");
    if (result.kind !== "workspace") throw new Error("expected workspace");
    expect(result.projects).toHaveLength(4);
  });

  test("error path: a path/credential-shaped project name in the manifest fails safely, no raw echo", async () => {
    const manifest = {
      server: { baseUrl: "http://127.0.0.1:4096" },
      projects: [
        {
          name: "/Users/marcus/.ssh/id_rsa",
          path: "~/src/a",
          description: "A",
        },
      ],
    };
    const result = await loadWorkspace("/workspace", {
      readTextFile: stubReader({
        "/workspace/spacebus.json": JSON.stringify(manifest),
      }),
    });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected error");
    expect(result.message).not.toContain("/Users/marcus/.ssh/id_rsa");
  });

  test("error path: a Bearer-token-shaped project name in the manifest fails safely, no raw echo", async () => {
    const manifest = {
      server: { baseUrl: "http://127.0.0.1:4096" },
      projects: [
        { name: "Bearer sk-live-abc123XYZ", path: "~/src/a", description: "A" },
      ],
    };
    const result = await loadWorkspace("/workspace", {
      readTextFile: stubReader({
        "/workspace/spacebus.json": JSON.stringify(manifest),
      }),
    });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected error");
    expect(result.message).not.toContain("sk-live-abc123XYZ");
  });

  test("happy path: virtual workspace derives a valid name from the directory basename", async () => {
    const result = await loadWorkspace("/opened/my-project", {
      readTextFile: stubReader({}),
    });
    expect(result.kind).toBe("virtual");
    if (result.kind !== "virtual") throw new Error("expected virtual");
    expect(result.project.name).toBe("my-project");
  });

  test("security: virtual workspace's derived name falls back safely when the basename is itself invalid, never leaking the directory", async () => {
    const result = await loadWorkspace("/opened/..", {
      readTextFile: stubReader({}),
    });
    expect(result.kind).toBe("virtual");
    if (result.kind !== "virtual") throw new Error("expected virtual");
    expect(result.project.name).toBe("workspace");
  });

  test("read-error classification: pathExists confirms missing -> virtual, never error", async () => {
    const result = await loadWorkspace("/opened/dir", {
      readTextFile: stubReader({}),
      pathExists: async () => false,
    });
    expect(result.kind).toBe("virtual");
  });

  test("read-error classification: pathExists confirms present but read fails -> stable error kind, no raw path/error text", async () => {
    const result = await loadWorkspace("/opened/dir", {
      readTextFile: async () => {
        throw new Error(
          "EACCES: permission denied, open '/opened/dir/spacebus.json'",
        );
      },
      pathExists: async () => true,
    });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected error");
    expect(result.message).not.toContain("/opened/dir");
    expect(result.message).not.toContain("EACCES");
  });

  test("read-error classification: pathExists itself throws -> fails closed as error, never virtual", async () => {
    const result = await loadWorkspace("/opened/dir", {
      readTextFile: stubReader({}),
      pathExists: async () => {
        throw new Error("stat failed");
      },
    });
    expect(result.kind).toBe("error");
  });

  test("read-error classification: no pathExists injected (not wired) preserves the pre-existing any-throw-means-missing behavior", async () => {
    const result = await loadWorkspace("/opened/dir", {
      readTextFile: stubReader({}),
    });
    expect(result.kind).toBe("virtual");
  });

  test("read-error classification: pathExists confirms present and read succeeds -> normal successful workspace read, unaffected", async () => {
    const manifest = {
      server: { baseUrl: "http://127.0.0.1:4096" },
      projects: [],
    };
    const result = await loadWorkspace("/workspace", {
      readTextFile: stubReader({
        "/workspace/spacebus.json": JSON.stringify(manifest),
      }),
      pathExists: async () => true,
    });
    expect(result.kind).toBe("workspace");
  });

  test('default reader throws "not wired" when none injected', async () => {
    // No file at this path with the default reader, so loadWorkspace treats the throw
    // as "missing file" and falls back to a virtual workspace — verifying the default
    // reader itself throws 'not wired' rather than something else.
    const { defaultReadTextFile } = await import("./config");
    await expect(defaultReadTextFile("/anything")).rejects.toThrow("not wired");
  });
});
