import { describe, expect, test } from "bun:test";
import type { WorkspaceResult } from "./config";
import { buildBusContext } from "./context";

describe("buildBusContext", () => {
  test("workspace kind -> BusContext with exists-flagged roster projects", async () => {
    const workspace: WorkspaceResult = {
      kind: "workspace",
      config: {
        server: { baseUrl: "http://127.0.0.1:4096" },
        projects: [
          { name: "proj-a", path: "~/src/proj-a", description: "A project" },
        ],
      },
      projects: [
        {
          name: "proj-a",
          path: "~/src/proj-a",
          description: "A project",
          expandedPath: "/Users/marcus/src/proj-a",
        },
      ],
    };
    const pathExists = async (path: string) =>
      path === "/Users/marcus/src/proj-a";
    const ctx = await buildBusContext(workspace, undefined, { pathExists });
    expect(ctx.roster.server.baseUrl).toBe("http://127.0.0.1:4096");
    expect(ctx.roster.projects).toHaveLength(1);
    expect(ctx.roster.projects[0]).toMatchObject({
      name: "proj-a",
      expandedPath: "/Users/marcus/src/proj-a",
      exists: true,
    });
  });

  test("virtual workspace synthesizes a single-project roster", async () => {
    const workspace: WorkspaceResult = {
      kind: "virtual",
      project: {
        name: "opened-dir",
        path: "/opened/dir",
        description: "",
        expandedPath: "/opened/dir",
      },
    };
    const ctx = await buildBusContext(workspace, undefined, {
      pathExists: async () => true,
    });
    expect(ctx.roster.projects).toHaveLength(1);
    expect(ctx.roster.projects[0]).toMatchObject({
      name: "opened-dir",
      exists: true,
    });
  });

  test("exists flag is injected per project via pathExists", async () => {
    const workspace: WorkspaceResult = {
      kind: "workspace",
      config: {
        server: { baseUrl: "http://127.0.0.1:4096" },
        projects: [
          { name: "exists-proj", path: "/a", description: "" },
          { name: "missing-proj", path: "/b", description: "" },
        ],
      },
      projects: [
        {
          name: "exists-proj",
          path: "/a",
          description: "",
          expandedPath: "/a",
        },
        {
          name: "missing-proj",
          path: "/b",
          description: "",
          expandedPath: "/b",
        },
      ],
    };
    const ctx = await buildBusContext(workspace, undefined, {
      pathExists: async (p) => p === "/a",
    });
    const byName = Object.fromEntries(
      ctx.roster.projects.map((p) => [p.name, p.exists]),
    );
    expect(byName["exists-proj"]).toBe(true);
    expect(byName["missing-proj"]).toBe(false);
  });

  test("schema-invalid roster is rejected", async () => {
    const workspace: WorkspaceResult = {
      kind: "workspace",
      config: {
        // Not a valid URL -> busContextSchema (via projectSchema/rosterSchema)
        // rejects at the boundary.
        server: { baseUrl: "not-a-url" as unknown as string },
        projects: [],
      },
      projects: [],
    };
    await expect(
      buildBusContext(workspace, undefined, { pathExists: async () => true }),
    ).rejects.toThrow();
  });

  test("error-kind workspace throws instead of building a bus context", async () => {
    const workspace: WorkspaceResult = {
      kind: "error",
      message: "spacebus.json is not valid JSON",
    };
    await expect(buildBusContext(workspace)).rejects.toThrow(
      /cannot build bus context/,
    );
  });
});
