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

  test('default reader throws "not wired" when none injected', async () => {
    // No file at this path with the default reader, so loadWorkspace treats the throw
    // as "missing file" and falls back to a virtual workspace — verifying the default
    // reader itself throws 'not wired' rather than something else.
    const { defaultReadTextFile } = await import("./config");
    await expect(defaultReadTextFile("/anything")).rejects.toThrow("not wired");
  });
});
